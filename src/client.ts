import { version } from "../package.json";
import { type AnthropicToolResultBlock, type AnthropicMessagesRequest, type JsonRpcNotification, type AnthropicSseEvent, type GatewayState, type PendingToolRoute, type ClaudeGatewayHeaderHints, type CodexModelListResult, createGatewayState, toCodexRequests, codexThreadStartParams, latestUserMessage, latestUserContentBlockTypes, turnTextForRequest, traceClaudeGatewayRequest, resolveCodexModel, toAnthropicStreamEvents, cancellationRequest, validateAnthropicRequest, flattenContent, readString, readTurnId, missingRequiredToolUseArguments, dynamicToolUseFromToolCallParams } from "./protocol.ts";
export type CodexProcess = {
  stdin: { write(chunk: Uint8Array): unknown | Promise<unknown> };
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill: () => void;
};

type PendingTurn = {
  resolve: (events: AnthropicSseEvent[]) => void;
  reject: (error: Error) => void;
};

type OriginTurn = {
  threadId: string;
  turnId: string | null;
  sessionId: string | null;
  state: GatewayState;
  notifications: JsonRpcNotification[];
  waiter?: PendingTurn;
  dispatchScheduled: boolean;
  requestId: string | number;
  seenToolCalls: Map<string, string | number>;
  deadline?: ReturnType<typeof setTimeout>;
};

const encoder = new TextEncoder();

export function failClosedClientRequestResult(method: string): Record<string, unknown> | null {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "execCommandApproval") {
    return { decision: { denied: { rejection: "Codex gateway keeps Claude Code as the tool-permission owner." } } };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  if (method === "item/tool/call") {
    return {
      success: false,
      contentItems: [],
    };
  }
  return null;
}

export function gatewayTimeout(value: string | undefined, fallback = 300_000): number {
  const timeout = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Gateway timeout must be a positive integer in milliseconds.");
  return timeout;
}

export class CodexJsonRpcClient {
  private initialization?: Promise<void>;
  private closedError?: Error;
  private readonly rpcPending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly starting = new Map<string | number, OriginTurn>();
  private readonly origins = new Map<string, OriginTurn>();
  private readonly activeByTurn = new Map<string, OriginTurn>();
  private readonly pendingToolRoutes = new Map<string, PendingToolRoute>();

  constructor(private readonly proc: CodexProcess, private readonly timeoutMs = gatewayTimeout(process.env.CODEX_GATEWAY_TIMEOUT_MS)) {
    gatewayTimeout(String(timeoutMs));
    this.readLoop().catch((error) => this.rejectAll(error));
    this.stderrLoop().catch(() => undefined);
  }

  private turnKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  async turn(
    request: AnthropicMessagesRequest,
    cwd: string,
    headerHints: ClaudeGatewayHeaderHints = { sessionId: null, promptId: null, requestClass: null, prevToolDurations: null },
    signal?: AbortSignal,
  ): Promise<AnthropicSseEvent[]> {
    validateAnthropicRequest(request);
    const state = createGatewayState();
    state.turnText = turnTextForRequest(request);
    const current = latestUserMessage(request.messages);
    const results = !state.turnText.trim() && current && Array.isArray(current.content)
      ? current.content.filter((block): block is AnthropicToolResultBlock => block.type === "tool_result")
      : [];
    const routes = results.map((result) => this.pendingToolRoutes.get(result.tool_use_id));
    const route = routes[0];
    let origin = route ? this.activeByTurn.get(this.turnKey(route.threadId, route.turnId)) : undefined;
    let error = signal?.aborted ? "Claude Code request cancelled before inference." : null;
    if (!error && results.length) {
      if (!origin || new Set(results.map((result) => result.tool_use_id)).size !== results.length
        || routes.some((candidate) => !candidate || !candidate.delivered || candidate.sessionId !== headerHints.sessionId
          || candidate.threadId !== origin!.threadId || candidate.turnId !== origin!.turnId)) {
        error = "Claude Code tool result has no matching pending tool use/turn in this session; refusing stale continuation.";
      } else if (Array.from(this.pendingToolRoutes.entries()).some(([id, pending]) => pending.delivered
        && pending.threadId === origin!.threadId && pending.turnId === origin!.turnId
        && !results.some((result) => result.tool_use_id === id))) {
        error = "Claude Code did not provide all delivered tool results for the pending turn.";
      } else if (origin.waiter) {
        error = "Claude Code tool continuation already has a pending response.";
      }
    } else if (!error && !state.turnText.trim()) {
      error = "Claude Code did not forward an actionable user prompt to the Codex gateway; refusing to run Codex on system reminders only.";
    }
    let events: AnthropicSseEvent[];
    if (error) {
      events = toAnthropicStreamEvents([{ method: "error", params: { message: error } }], state);
    } else if (results.length && origin) {
      // Dynamic tools resume by answering the outstanding server request.
      // No new turn/start and no empty acknowledgement is sent here.
      const continuing = origin;
      events = await this.waitForResponse(continuing, signal, async () => {
        for (const [index, result] of results.entries()) {
          const pendingRoute = routes[index]!;
          this.pendingToolRoutes.delete(result.tool_use_id);
          const output = typeof result.content === "string" ? result.content : flattenContent(result.content);
          await this.writeJson({ jsonrpc: "2.0", id: pendingRoute.rpcId,
            result: { success: result.is_error !== true, contentItems: [{ type: "inputText", text: output }] } });
          this.traceRoute("tool_result", continuing, { toolUseId: result.tool_use_id, rpcId: pendingRoute.rpcId, success: result.is_error !== true });
        }
        this.dispatchTools(continuing);
      });
    } else {
      // Structured prior tool items identify superseded cycles. Independent
      // classifier requests have their own turn and must not consume them.
      const superseded = new Set<OriginTurn>();
      for (const message of request.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          const id = block.type === "tool_result" ? block.tool_use_id : block.type === "tool_use" ? block.id : null;
          const candidate = id ? this.pendingToolRoutes.get(id) : undefined;
          if (candidate?.sessionId === headerHints.sessionId) {
            const previous = this.activeByTurn.get(this.turnKey(candidate.threadId, candidate.turnId));
            if (previous) superseded.add(previous);
          }
        }
      }
      for (const previous of superseded) await this.cancelOrigin(previous, "Superseded by current Claude Code user text.");
      await this.initialize();
      const selectedModel = process.env.CODEX_GATEWAY_MODEL || process.env.CODEX_MODEL;
      state.model = resolveCodexModel(request.model, selectedModel);
      const response = await this.request(crypto.randomUUID(), "thread/start", codexThreadStartParams(
        cwd, selectedModel, request.model, request.tools ?? [], request.messages,
        state.toolNameAliases, new Map(), state.toolRequiredArguments, state.turnText,
      ));
      const threadId = (response as { thread?: { id?: string } }).thread?.id;
      if (!threadId) throw new Error("Codex thread/start returned no thread id");
      if (signal?.aborted) throw new Error("Claude Code request cancelled before turn/start.");
      const requestId = crypto.randomUUID();
      origin = { threadId, turnId: null, sessionId: headerHints.sessionId, state, notifications: [], dispatchScheduled: false, requestId, seenToolCalls: new Map() };
      this.origins.set(threadId, origin);
      this.starting.set(requestId, origin);
      const boundedOrigin = origin;
      origin.deadline = setTimeout(() => { void this.cancelOrigin(boundedOrigin, "Codex turn timed out."); }, this.timeoutMs);
      origin.deadline.unref();
      const batch = toCodexRequests(request, { cwd, model: selectedModel, threadId, requestId,
        reasoningEffort: process.env.CODEX_GATEWAY_REASONING_EFFORT });
      events = await this.waitForResponse(origin, signal, () => this.writeJson(batch.requests[0]));
    }
    const finalState = origin?.state ?? state;
    traceClaudeGatewayRequest({ event: "codex-gateway.claudeRequest", ...headerHints,
      latestUserContentBlockTypes: latestUserContentBlockTypes(request.messages),
      actionableUserText: results.length ? "" : state.turnText, hasToolResult: results.length > 0,
      appServerThreadId: finalState.appServerThreadId, appServerTurnId: finalState.appServerTurnId,
      terminalTurnState: finalState.terminalTurnState });
    return events;
  }

  private async waitForResponse(origin: OriginTurn, signal: AbortSignal | undefined, send: () => Promise<unknown>): Promise<AnthropicSseEvent[]> {
    const abort = () => { void this.cancelOrigin(origin, "Claude Code request cancelled."); };
    try {
      return await new Promise<AnthropicSseEvent[]>((resolve, reject) => {
        origin.waiter = { resolve, reject };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        send().catch((error) => { void this.cancelOrigin(origin, error instanceof Error ? error.message : String(error)); });
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private flush(origin: OriginTurn): void {
    const waiter = origin.waiter;
    if (!waiter) return;
    origin.waiter = undefined;
    try {
      // Each HTTP response consumes only the events accumulated for it.
      const events = toAnthropicStreamEvents(origin.notifications.splice(0), origin.state);
      origin.state.emittedText = "";
      waiter.resolve(events);
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private dispatchTools(origin: OriginTurn): void {
    if (!origin.waiter || origin.dispatchScheduled) return;
    const ready = Array.from(this.pendingToolRoutes.values()).filter((route) => route.threadId === origin.threadId
      && route.turnId === origin.turnId && !route.delivered);
    if (!ready.length) return;
    origin.dispatchScheduled = true;
    // Coalesce callbacks already queued in this event-loop tick. Later calls
    // stay queued on the same origin and are exposed on the next response.
    setTimeout(() => {
      origin.dispatchScheduled = false;
      if (!origin.waiter || this.origins.get(origin.threadId) !== origin) return;
      let delivered = false;
      for (const route of this.pendingToolRoutes.values()) {
        if (route.threadId === origin.threadId && route.turnId === origin.turnId && !route.delivered) {
          route.delivered = true;
          origin.notifications.push(route.notification);
          delivered = true;
        }
      }
      if (delivered) this.flush(origin);
    }, 0);
  }

  private forget(origin: OriginTurn): void {
    clearTimeout(origin.deadline);
    this.origins.delete(origin.threadId);
    this.starting.delete(origin.requestId);
    if (origin.turnId) this.activeByTurn.delete(this.turnKey(origin.threadId, origin.turnId));
    for (const [id, route] of this.pendingToolRoutes) {
      if (route.threadId === origin.threadId && route.turnId === origin.turnId) this.pendingToolRoutes.delete(id);
    }
  }

  private async cancelOrigin(origin: OriginTurn, message: string): Promise<void> {
    if (this.origins.get(origin.threadId) !== origin) return;
    const callbacks = Array.from(this.pendingToolRoutes.values()).filter((route) => route.threadId === origin.threadId && route.turnId === origin.turnId);
    this.forget(origin);
    origin.notifications = [{ method: "error", params: { message } }];
    this.flush(origin);
    if (origin.turnId) await this.writeJson(cancellationRequest(origin.threadId, origin.turnId, crypto.randomUUID())).catch(() => undefined);
    for (const route of callbacks) await this.writeJson({ jsonrpc: "2.0", id: route.rpcId,
      result: { success: false, contentItems: [{ type: "inputText", text: message }] } }).catch(() => undefined);
    this.traceRoute("cancelled", origin);
  }

  private traceRoute(event: string, origin: OriginTurn, extra: Record<string, unknown> = {}): void {
    if (process.env.CODEX_GATEWAY_TRACE_REQUESTS !== "1") return;
    console.error(JSON.stringify({ event: `codex-gateway.${event}`, sessionId: origin.sessionId,
      threadId: origin.threadId, turnId: origin.turnId, requestId: origin.requestId, ...extra }));
  }

  async models(): Promise<CodexModelListResult> { await this.initialize(); return await this.request(crypto.randomUUID(), "model/list", {}) as CodexModelListResult; }
  async account(): Promise<unknown> { await this.initialize(); return await this.request(crypto.randomUUID(), "account/read", { refreshToken: false }); }
  async accountRateLimits(): Promise<unknown> { await this.initialize(); return await this.request(crypto.randomUUID(), "account/rateLimits/read", { excludeResetCreditDetails: false }); }
  async accountUsage(threadId?: string | null): Promise<unknown> { await this.initialize(); return await this.request(crypto.randomUUID(), "account/usage/read", threadId ? { threadId } : {}); }
  async interruptAll(): Promise<void> { for (const origin of Array.from(this.origins.values())) await this.cancelOrigin(origin, "Codex gateway stopped."); }
  async close(): Promise<void> {
    try { await this.interruptAll(); }
    finally { this.rejectAll(new Error("Codex gateway stopped.")); this.proc.kill(); }
  }

  private async initialize(): Promise<void> {
    if (this.closedError) throw this.closedError;
    this.initialization ??= (async () => {
      await this.request(crypto.randomUUID(), "initialize", { capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "claude-codex-gateway", title: "Claude Codex Gateway", version } });
      await this.writeJson({ jsonrpc: "2.0", method: "initialized" });
    })();
    await this.initialization;
  }

  private async request(id: string | number, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.rpcPending.set(id, { resolve, reject });
        deadline = setTimeout(() => {
          this.rpcPending.delete(id);
          reject(new Error(`Codex ${method} timed out.`));
        }, this.timeoutMs);
        deadline.unref();
        this.writeJson({ jsonrpc: "2.0", id, method, params }).catch((error) => { this.rpcPending.delete(id); reject(error); });
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  private rejectAll(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.closedError = err;
    for (const rpc of this.rpcPending.values()) rpc.reject(err);
    this.rpcPending.clear();
    for (const origin of Array.from(this.origins.values())) {
      origin.waiter?.reject(err);
      this.forget(origin);
    }
  }

  private async writeJson(value: unknown): Promise<void> { await this.proc.stdin.write(encoder.encode(`${JSON.stringify(value)}\n`)); }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    if (!this.proc.stdout) throw new Error("Codex app-server stdout is unavailable");
    const reader = this.proc.stdout.getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Codex app-server closed its output.");
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (line) this.handleMessage(JSON.parse(line));
        nl = buffer.indexOf("\n");
      }
    }
  }

  private async stderrLoop(): Promise<void> {
    const decoder = new TextDecoder();
    if (!this.proc.stderr) return;
    const reader = this.proc.stderr.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; const text = decoder.decode(value); if (text.trim()) console.error(text.trimEnd()); }
  }

  private bindTurn(origin: OriginTurn, turnId: string): boolean {
    if (origin.turnId && origin.turnId !== turnId) return false;
    origin.turnId = turnId;
    origin.state.appServerThreadId = origin.threadId;
    origin.state.appServerTurnId = turnId;
    this.activeByTurn.set(this.turnKey(origin.threadId, turnId), origin);
    return true;
  }

  private handleMessage(record: Record<string, any>): void {
    if ("id" in record && !record.method) {
      const rpc = this.rpcPending.get(record.id);
      if (rpc) { this.rpcPending.delete(record.id); if (record.error) rpc.reject(new Error(JSON.stringify(record.error))); else rpc.resolve(record.result); return; }
      const origin = this.starting.get(record.id);
      if (origin) {
        this.starting.delete(record.id);
        if (record.error) { void this.cancelOrigin(origin, JSON.stringify(record.error)); return; }
        if (record.result?.turn?.id && !this.bindTurn(origin, record.result.turn.id)) void this.cancelOrigin(origin, "Codex turn/start returned an inconsistent turn id.");
      }
      return;
    }
    if (record.method === "serverRequest/resolved") {
      for (const [id, route] of this.pendingToolRoutes) {
        if (route.threadId === record.params?.threadId && route.rpcId === record.params?.requestId) {
          this.pendingToolRoutes.delete(id);
        }
      }
      return;
    }
    if (record.method === "item/tool/call") {
      const params = record.params ?? {};
      const origin = this.activeByTurn.get(this.turnKey(params.threadId, params.turnId));
      const previous = origin?.seenToolCalls.get(params.callId);
      if (previous !== undefined && previous === record.id) return;
      if (origin && Array.from(origin.seenToolCalls.values()).includes(record.id)) {
        void this.cancelOrigin(origin, "Codex reused a dynamic tool RPC id for another call.");
        return;
      }
      if (!origin || previous !== undefined || !params.callId || this.pendingToolRoutes.has(params.callId) || !("id" in record)) {
        if ("id" in record) void this.writeJson({ jsonrpc: "2.0", id: record.id, result: failClosedClientRequestResult(record.method) });
        return;
      }
      const translated = dynamicToolUseFromToolCallParams(params, origin.state.toolNameAliases);
      const invalid = !translated || !origin.state.toolRequiredArguments.has(translated.name) || missingRequiredToolUseArguments(translated, origin.state.toolRequiredArguments);
      if (invalid) { void this.writeJson({ jsonrpc: "2.0", id: record.id, result: failClosedClientRequestResult(record.method) }); void this.cancelOrigin(origin, typeof invalid === "string" ? invalid : "Malformed dynamic tool request."); return; }
      origin.seenToolCalls.set(params.callId, record.id);
      this.pendingToolRoutes.set(params.callId, { threadId: params.threadId, turnId: params.turnId,
        sessionId: origin.sessionId, rpcId: record.id, delivered: false, notification: { method: record.method, params } });
      this.traceRoute("tool_call", origin, { toolUseId: params.callId, rpcId: record.id, toolName: translated.name });
      this.dispatchTools(origin);
      return;
    }
    if ("id" in record && record.method) {
      const result = failClosedClientRequestResult(record.method);
      if (result) { void this.writeJson({ jsonrpc: "2.0", id: record.id, result }); return; }
    }
    const params = record.params ?? {};
    const threadId = readString(params, "threadId");
    const turnId = readTurnId(params);
    const starting = threadId ? this.origins.get(threadId) : undefined;
    if (record.method === "turn/started" && starting && turnId && !starting.turnId) this.bindTurn(starting, turnId);
    const origin = threadId && turnId ? this.activeByTurn.get(this.turnKey(threadId, turnId)) : undefined;
    if (!origin) return;
    const terminal = ["turn/completed", "turn/failed", "turn/interrupted", "error"].includes(record.method);
    // Completed dynamic-tool items confirm execution; they must not become a
    // second Claude tool_use after the outstanding callback was answered.
    if (record.method === "item/completed" && params.item?.type === "dynamicToolCall") return;
    origin.notifications.push({ method: record.method, params });
    if (terminal) {
      this.traceRoute("terminal", origin, { status: params.turn?.status ?? record.method });
      this.forget(origin);
      this.flush(origin);
    }
  }
}

