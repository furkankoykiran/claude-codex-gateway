# Gateway contract

## Shared authority

The latest non-system message must be a user turn. Actionable current text takes priority over historical tool results, including merged result/text blocks. Reminder-only input cannot infer. A result-only request must match a complete, outstanding cycle in the same Claude session; duplicate, stale, cross-session and incomplete results fail closed.

Only runtime-declared tools and schemas are authoritative. Claude Code executes the tool, applies hooks and permissions, owns MCP, and supplies the actual result or failure. The gateway never acknowledges a successful tool call before receiving that result. Model catalogs and health are not proof of execution access.

## Cleanup

`PROVIDER_GATEWAY_TIMEOUT_MS` (replace PROVIDER with CODEX or GEMINI) is a positive integer in milliseconds, default 300000. It bounds transport waits and outstanding Claude tool cycles. Timeout, cancellation, shutdown or terminal provider failure invalidates the origin. Late results cannot restart it. Restarting loses ephemeral correlation state and rejects subsequent results.

SSE tool inputs start with `{}` and are delivered as `input_json_delta`. Both gateways buffer a provider response before returning Anthropic SSE; they do not promise token-by-token latency. Errors are structured and cannot produce a successful terminal message. Default diagnostics do not log request bodies. Loopback callers are trusted local clients; the HTTP service is not a public authenticated API.

## Codex adapter

`src/protocol.ts` owns translation, `src/client.ts` owns app-server transport/correlation, `src/server.ts` owns HTTP and diagnostics, and `src/index.ts` preserves the public entrypoint. The official Codex CLI owns authentication. The selected model comes from the actual request or CODEX_GATEWAY_MODEL/CODEX_MODEL when translating Claude aliases; no default model ID is invented.

Every fresh actionable request starts an ephemeral app-server thread and turn. A dynamic `item/tool/call` is held under its original RPC ID and exact thread/turn/session. Only the actual Claude result answers that RPC with `success` and `contentItems`. No extra turn/start or empty success acknowledges it. Completion, interruption, failure and serverRequest/resolved are processed even between HTTP responses. Independent classifier requests do not consume unrelated tools.

Codex-side approval callbacks are declined and its sandbox is read-only. Native Codex MCP/execution is not claimed as Claude-owned tool parity. The gateway does not replay completed conversations into fresh threads; context-dependent resume is unproven. Trace flags are opt-in and may expose prompt/tool context: redact before sharing.

## Acceptance baseline

The sanitized [Penpot baseline](penpot-baseline.json) and [baseline narrative](codex-wave1-evidence.md) preserve the prior real Claude-owned MCP result followed by a fresh prompt/thread/turn. This baseline is historical; see verification.md for this change's checks. Fixtures cover overlapping origins, classifiers, duplicates, failures and late events. They are not a live concurrency stress test.
