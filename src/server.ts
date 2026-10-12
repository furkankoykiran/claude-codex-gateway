import { version } from "../package.json";
import { CodexJsonRpcClient, gatewayTimeout, type CodexProcess } from "./client.ts";
import { type AnthropicMessagesRequest, type AnthropicSseEvent, type ClaudeGatewayHeaderHints, toAnthropicModelsList, codexAppServerCommand, shouldStreamAnthropicResponse, nonStreamingAnthropicResponseFromEvents, errorMessageFromEvent } from "./protocol.ts";
function spawnCodexAppServer(): CodexProcess {
  const cmd = codexAppServerCommand();
  const proc = Bun.spawn([cmd.command, ...cmd.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...cmd.env },
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: () => proc.kill(),
  };
}

function sseEncode(event: AnthropicSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function claudeGatewayHeaderHints(headers: Headers): ClaudeGatewayHeaderHints {
  return {
    sessionId: headers.get("x-claude-code-session-id"),
    requestClass: headers.get("x-claude-code-request-class"),
    promptId: headers.get("x-claude-code-prompt-id"),
    prevToolDurations: headers.get("x-claude-code-prev-tool-durations"),
  };
}

export async function serve(): Promise<void> {
  const port = Number(process.env.CODEX_GATEWAY_PORT || "4545");
  const cwd = process.env.CODEX_GATEWAY_CWD || process.cwd();
  const client = new CodexJsonRpcClient(spawnCodexAppServer());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" || url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          status: "ok",
          version,
          execution_owner: "claude-code",
          timeout_ms: gatewayTimeout(process.env.CODEX_GATEWAY_TIMEOUT_MS),
          provider: "codex-app-server",
          model: process.env.CODEX_GATEWAY_MODEL || process.env.CODEX_MODEL || null,
          reasoning_effort: process.env.CODEX_GATEWAY_REASONING_EFFORT || null,
        });
      }
      if (url.pathname === "/v1/models") {
        try {
          return Response.json(toAnthropicModelsList(await client.models()));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ type: "error", error: { type: "api_error", message } }, { status: 502 });
        }
      }
      if (url.pathname === "/codex/account") {
        try {
          return Response.json(await client.account());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ type: "error", error: { type: "api_error", message } }, { status: 502 });
        }
      }
      if (url.pathname === "/codex/rate-limits") {
        try {
          return Response.json(await client.accountRateLimits());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ type: "error", error: { type: "api_error", message } }, { status: 502 });
        }
      }
      if (url.pathname === "/codex/usage") {
        try {
          return Response.json(await client.accountUsage(url.searchParams.get("threadId")));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ type: "error", error: { type: "api_error", message } }, { status: 502 });
        }
      }
      if (url.pathname !== "/v1/messages" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      let body: AnthropicMessagesRequest;
      try {
        body = (await req.json()) as AnthropicMessagesRequest;
      } catch {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "invalid JSON" } }, { status: 400 });
      }
      try {
        const events = await client.turn(body, cwd, claudeGatewayHeaderHints(req.headers), req.signal);
        const eventError = events.find((event) => event.event === "error");
        if (eventError) {
          return Response.json({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: errorMessageFromEvent(eventError),
            },
          }, { status: 400 });
        }
        if (shouldStreamAnthropicResponse(body)) {
          return new Response(events.map(sseEncode).join(""), {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        return Response.json(nonStreamingAnthropicResponseFromEvents(
          body,
          events,
          process.env.CODEX_GATEWAY_MODEL || process.env.CODEX_MODEL,
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ type: "error", error: { type: "api_error", message } }, { status: 502 });
      }
    },
  });
  const stop = async () => {
    await client.close().catch(() => undefined);
    server.stop(true);
  };
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
  console.error(`codex-anthropic-gateway listening on http://127.0.0.1:${port}`);
}

export function doctor(): void {
  const hasCodex = Bun.which("codex") !== null;
  console.log(`codex cli: ${hasCodex ? "ok" : "missing"}`);
  console.log(`model: ${process.env.CODEX_GATEWAY_MODEL || process.env.CODEX_MODEL || "not configured"}`);
  console.log(`reasoning effort: ${process.env.CODEX_GATEWAY_REASONING_EFFORT || "default"}`);
  gatewayTimeout(process.env.CODEX_GATEWAY_TIMEOUT_MS);
  if (!hasCodex) process.exitCode = 1;
}
