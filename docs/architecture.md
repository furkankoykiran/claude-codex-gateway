# Architecture

The family shares an Anthropic Messages boundary, not a second execution harness. `src/index.ts` is the public entrypoint; provider translation, transport, and HTTP service remain separate responsibilities. Tests live in `tests/`, and sanitized live acceptance belongs in `docs/`.

Codex uses official app-server JSON-RPC with runtime thread/turn IDs and server-request callbacks. Gemini uses stateless Google HTTP requests with local issued-tool cycles tied to session/model and provider-native function-call parts. A Google request is not a Codex thread; no artificial shared thread API is introduced.

Cancellation signals the provider before accepting later events as completion. Pending cycles and network/RPC waits have configured deadlines. Each HTTP response publishes tools only after validating their names and arguments against the runtime request.

## Read-only architectural research

Installed JCode v0.95.0 (6487bbd7e), including its version metadata and CLI surface, was inspected without changing its configuration or authentication. Upstream [1jehuang/jcode](https://github.com/1jehuang/jcode/tree/b3d4e2143670dd5aeafc81649d85eabdf1bc9d18) was inspected at b3d4e2143670dd5aeafc81649d85eabdf1bc9d18. Its `crates/jcode-provider-core/src/lib.rs` provider trait separates inference from harness concerns; `crates/jcode-app-core/src/server/client_lifecycle.rs` dispatches cancellation before outbound acknowledgements.

These are architectural references only. No JCode code was copied. Its MIT license requires retaining its copyright/permission notice when copying substantial code. This family retains Claude Code as the execution authority and does not adopt JCode's credential or execution ownership.
