import { expect, test } from "bun:test";
import { CodexJsonRpcClient, nonStreamingAnthropicResponseFromEvents, type AnthropicMessagesRequest } from "../src/index.ts";

function fixture(count = 1, deferCompletion = false, timeoutMs = 300_000, mcp = false) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const writes: Record<string, any>[] = [];
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const tools = Array.from({ length: count }, () => ({ id: crypto.randomUUID(), rpcId: crypto.randomUUID(), name: `${mcp ? "mcp__fixture__" : "client_"}${crypto.randomUUID().replaceAll("-", "")}` }));
  const emit = (value: unknown) => controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
  let buffer = "";
  let completed = false;
  const client = new CodexJsonRpcClient({
    stdin: { write(chunk) {
      buffer += new TextDecoder().decode(chunk);
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        const row = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); writes.push(row);
        if (row.method === "initialize") emit({ id: row.id, result: {} });
        if (row.method === "thread/start") emit({ id: row.id, result: { thread: { id: threadId } } });
        if (row.method === "turn/start") {
          if (row.params.toolOutput) throw new Error("Dynamic tool responses must answer the original server request, not start another turn");
          queueMicrotask(() => {
            emit({ id: row.id, result: { turn: { id: turnId, status: "inProgress" } } });
            emit({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
            for (const tool of tools) emit({ id: tool.rpcId, method: "item/tool/call", params: { threadId, turnId, callId: tool.id, tool: mcp ? `claude_tool_${tools.indexOf(tool)}_${tool.name.slice(0, 64)}` : tool.name, arguments: { value: tool.id } } });
          });
        }
        if (!row.method && tools.some((tool) => tool.rpcId === row.id) && tools.every((tool) => writes.some((r) => !r.method && r.id === tool.rpcId)) && !completed) {
          completed = true;
          if (deferCompletion) continue;
          queueMicrotask(() => {
            emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: crypto.randomUUID(), delta: "CURRENT_RESULT" } });
            emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
          });
        }
      }
    } },
    stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), stderr: null, kill() {},
  }, timeoutMs);
  const request: AnthropicMessagesRequest = { model: "runtime-selected-model", max_tokens: 100, messages: [{ role: "user", content: "Use the offered client tools." }], tools: tools.map((tool) => ({ name: tool.name, input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } })) };
  const continuation = (failed = false): AnthropicMessagesRequest => ({ ...request, messages: [...request.messages,
    { role: "assistant", content: tools.map((tool) => ({ type: "tool_use" as const, id: tool.id, name: tool.name, input: { value: tool.id } })) },
    { role: "user", content: tools.map((tool) => ({ type: "tool_result" as const, tool_use_id: tool.id, content: failed ? "tool timed out" : tool.id, is_error: failed })) },
  ] });
  return { client, writes, tools, emit, request, continuation, threadId, turnId };
}

for (const failed of [false, true]) {
  test(`answers a dynamic server request only with Claude's actual ${failed ? "timeout" : "result"}`, async () => {
    const f = fixture();
    await f.client.turn(f.request, process.cwd());
    expect(f.writes.filter((r) => !r.method && r.id === f.tools[0]!.rpcId)).toEqual([]);
    const request = f.continuation(failed);
    const events = await f.client.turn(request, process.cwd());
    const response = f.writes.find((r) => !r.method && r.id === f.tools[0]!.rpcId);
    expect(response?.result).toEqual({ success: !failed, contentItems: [{ type: "inputText", text: failed ? "tool timed out" : f.tools[0]!.id }] });
    expect(f.writes.filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(nonStreamingAnthropicResponseFromEvents(request, events).content[0]?.text).toBe("CURRENT_RESULT");
  });
}

test("emits and resumes multiple pending tool uses without dropping or replaying any callback", async () => {
  const f = fixture(2);
  const events = await f.client.turn(f.request, process.cwd());
  const ids = events.filter((e) => e.event === "content_block_start").map((e) => (e.data.content_block as any)?.id).filter(Boolean);
  expect(ids.sort()).toEqual(f.tools.map((t) => t.id).sort());
  expect(f.writes.filter((r) => !r.method && f.tools.some((t) => t.rpcId === r.id))).toHaveLength(0);
  const request = f.continuation();
  const continued = await f.client.turn(request, process.cwd());
  expect(nonStreamingAnthropicResponseFromEvents(request, continued).content[0]?.text).toBe("CURRENT_RESULT");
  for (const tool of f.tools) expect(f.writes.filter((r) => !r.method && r.id === tool.rpcId)).toHaveLength(1);
});

for (const status of ["completed", "interrupted", "failed"]) {
  test(`invalidates tools when the originating turn is ${status}, even between HTTP requests`, async () => {
    const f = fixture();
    await f.client.turn(f.request, process.cwd());
    f.emit({ method: "turn/completed", params: { threadId: f.threadId, turn: { id: f.turnId, status, error: status === "failed" ? { message: "timeout" } : null } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = f.continuation();
    const events = await f.client.turn(request, process.cwd());
    expect(events.filter((e) => e.event === "error")).toHaveLength(1);
    expect(f.writes.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });
}

test("duplicate tool requests do not re-execute a Claude tool or acknowledge it early", async () => {
  const f = fixture();
  const first = await f.client.turn(f.request, process.cwd());
  const tool = f.tools[0]!;
  f.emit({ id: tool.rpcId, method: "item/tool/call", params: { threadId: f.threadId, turnId: f.turnId, callId: tool.id, tool: tool.name, arguments: { value: tool.id } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.filter((e) => e.event === "content_block_start" && (e.data.content_block as any)?.type === "tool_use")).toHaveLength(1);
  expect(f.writes.filter((r) => !r.method && r.id === tool.rpcId)).toHaveLength(0);
});

test("reminder-only requests do not initialize or replay a pending tool", async () => {
  const f = fixture();
  const events = await f.client.turn({ ...f.request, messages: [{ role: "user", content: "<system-reminder>prior context</system-reminder>" }] }, process.cwd());
  expect(events.filter((e) => e.event === "error")).toHaveLength(1);
  expect(f.writes).toEqual([]);
});

test("a duplicate callback after its real response is not acknowledged or executed twice", async () => {
  const f = fixture(1, true);
  await f.client.turn(f.request, process.cwd());
  let settled = false;
  const completion = f.client.turn(f.continuation(), process.cwd()).then((events) => { settled = true; return events; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tool = f.tools[0]!;
  f.emit({ id: tool.rpcId, method: "item/tool/call", params: { threadId: f.threadId, turnId: f.turnId, callId: tool.id, tool: tool.name, arguments: { value: tool.id } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.writes.filter((r) => !r.method && r.id === tool.rpcId)).toHaveLength(1);
  expect(settled).toBe(false);
  f.emit({ method: "turn/completed", params: { threadId: f.threadId, turn: { id: f.turnId, status: "completed" } } });
  await completion;
});

test("incomplete multi-tool results fail closed before consuming any pending callback", async () => {
  const f = fixture(2);
  await f.client.turn(f.request, process.cwd());
  const partial = f.continuation();
  (partial.messages.at(-1)!.content as any[]).pop();
  const events = await f.client.turn(partial, process.cwd());
  expect(events.filter((event) => event.event === "error")).toHaveLength(1);
  expect(f.writes.filter((r) => !r.method && f.tools.some((t) => t.rpcId === r.id))).toHaveLength(0);
  const full = f.continuation();
  const completed = await f.client.turn(full, process.cwd());
  expect(nonStreamingAnthropicResponseFromEvents(full, completed).content[0]?.text).toBe("CURRENT_RESULT");
});

test("aborting a continuation interrupts only its origin and rejects later stale results", async () => {
  const f = fixture(1, true);
  await f.client.turn(f.request, process.cwd());
  const controller = new AbortController();
  const completion = f.client.turn(f.continuation(), process.cwd(), undefined, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const cancelled = await completion;
  expect(cancelled.filter((event) => event.event === "error")).toHaveLength(1);
  expect(f.writes.filter((r) => r.method === "turn/interrupt").map((r) => r.params)).toEqual([{ threadId: f.threadId, turnId: f.turnId }]);
  f.emit({ method: "item/agentMessage/delta", params: { threadId: f.threadId, turnId: f.turnId, delta: "STALE" } });
  f.emit({ method: "turn/completed", params: { threadId: f.threadId, turn: { id: f.turnId, status: "interrupted" } } });
  const replay = await f.client.turn(f.continuation(), process.cwd());
  expect(replay.filter((event) => event.event === "error")).toHaveLength(1);
});

test("a pre-cancelled request cannot initialize Codex", async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  const events = await f.client.turn(f.request, process.cwd(), undefined, controller.signal);
  expect(events.filter((event) => event.event === "error")).toHaveLength(1);
  expect(f.writes).toEqual([]);
});

test("serverRequest/resolved clears the exact outstanding callback without poisoning another tool", async () => {
  const f = fixture(2, true);
  await f.client.turn(f.request, process.cwd());
  f.emit({ method: "serverRequest/resolved", params: { threadId: f.threadId, requestId: f.tools[0]!.rpcId } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stale = f.continuation();
  (stale.messages.at(-1)!.content as any[]).pop();
  const rejected = await f.client.turn(stale, process.cwd());
  expect(rejected.filter((event) => event.event === "error")).toHaveLength(1);
  const current = f.continuation();
  (current.messages.at(-1)!.content as any[]).shift();
  const pending = f.client.turn(current, process.cwd());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.writes.filter((r) => !r.method && r.id === f.tools[1]!.rpcId)).toHaveLength(1);
  expect(f.writes.filter((r) => !r.method && r.id === f.tools[0]!.rpcId)).toHaveLength(0);
  f.emit({ method: "turn/completed", params: { threadId: f.threadId, turn: { id: f.turnId, status: "completed" } } });
  await pending;
});


test("an outstanding Claude tool expires and rejects late callbacks/results", async () => {
  const f = fixture(1, true, 30);
  await f.client.turn(f.request, process.cwd());
  await Bun.sleep(50);
  expect(f.writes.filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
  expect(f.writes.filter((r) => !r.method && r.id === f.tools[0]!.rpcId)).toHaveLength(1);
  const late = await f.client.turn(f.continuation(), process.cwd());
  expect(late.filter((e) => e.event === "error")).toHaveLength(1);
  expect(f.writes.filter((r) => r.method === "turn/start")).toHaveLength(1);
});

test("an active inference deadline resolves exactly one error and ignores late text", async () => {
  const f = fixture(0, true, 20);
  const result = await f.client.turn(f.request, process.cwd());
  expect(result.filter((e) => e.event === "error")).toHaveLength(1);
  f.emit({ method: "item/agentMessage/delta", params: { threadId: f.threadId, turnId: f.turnId, delta: "LATE" } });
  f.emit({ method: "turn/completed", params: { threadId: f.threadId, turn: { id: f.turnId } } });
  expect(f.writes.filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("LATE");
});

test("unresponsive initialization is bounded and late replies cannot resurrect it", async () => {
  const writes: any[] = [];
  const client = new CodexJsonRpcClient({ stdin: { write(chunk) { writes.push(JSON.parse(new TextDecoder().decode(chunk))); } }, stdout: new ReadableStream({ start() {} }), stderr: null, kill() {} }, 10);
  await expect(client.models()).rejects.toThrow("initialize timed out");
  expect(writes.map((row) => row.method)).toEqual(["initialize"]);
});

test("undeclared dynamic tools fail closed without exposing Claude execution", async () => {
  const f = fixture(0, true);
  const completion = f.client.turn(f.request, process.cwd());
  await Bun.sleep(1);
  f.emit({ id: "unoffered-rpc", method: "item/tool/call", params: { threadId: f.threadId, turnId: f.turnId, callId: "unoffered-call", tool: "unoffered", arguments: {} } });
  const result = await completion;
  expect(result.filter((event) => event.event === "error")).toHaveLength(1);
  expect(result.some((event) => (event.data.content_block as any)?.type === "tool_use")).toBe(false);
});


test("MCP aliases validate runtime arguments under the original Claude tool name", async () => {
  const f = fixture(1, false, 300_000, true);
  const events = await f.client.turn(f.request, process.cwd());
  const blocks = events.filter((e) => e.event === "content_block_start").map((e) => e.data.content_block as any);
  expect(blocks.some((block) => block.type === "tool_use" && block.name === f.tools[0]!.name)).toBe(true);
  const completed = await f.client.turn(f.continuation(), process.cwd());
  expect(completed.filter((e) => e.event === "error")).toHaveLength(0);
});


test("shutdown invalidates pending cycles and closes only its provider process", async () => {
  const f = fixture(1, true);
  await f.client.turn(f.request, process.cwd());
  await f.client.close();
  const late = await f.client.turn(f.continuation(), process.cwd());
  expect(late.filter((e) => e.event === "error")).toHaveLength(1);
  await expect(f.client.models()).rejects.toThrow("stopped");
  expect(f.writes.filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
});


test("reusing one server RPC id for another tool call invalidates its origin", async () => {
  const f = fixture(1, true);
  await f.client.turn(f.request, process.cwd());
  const first = f.tools[0]!;
  f.emit({ id: first.rpcId, method: "item/tool/call", params: { threadId: f.threadId, turnId: f.turnId, callId: "different-call", tool: first.name, arguments: { value: "different" } } });
  await Bun.sleep(1);
  const stale = await f.client.turn(f.continuation(), process.cwd());
  expect(stale.filter((e) => e.event === "error")).toHaveLength(1);
  expect(f.writes.filter((r) => !r.method && r.id === first.rpcId)).toHaveLength(1);
  expect(f.writes.filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
});
