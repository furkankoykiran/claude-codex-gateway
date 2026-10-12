# Verification

The initial Penpot baseline commit was 548fa01, with 64 passing tests and 176 assertions. This change removes built-in schema overrides, splits protocol/transport/HTTP responsibilities, and adds deadlines and undeclared-tool rejection.

Frozen Bun installation, shell syntax lint, typecheck, and 71 tests (199 assertions) passed locally. Fixtures cover successful/failed callbacks, partial and duplicate batches, session/origin matching, classifier interleaving, expiry, cancellation and late events. The standalone Gateway CI repeats these documented checks for pull requests.

Fresh [live Penpot acceptance](penpot-acceptance.json) passed on 2026-10-12 with GPT-6.1 Sol/Medium: real Claude-owned execute_code results answered their original RPC IDs on the same thread/turn, followed by MCP_NEXT_TURN_91E4 on a fresh thread/turn without tools. The model requested two distinct calls during the first prompt; each callback was answered once. No exactly-one-call model-compliance claim is made. Claude Code 2.1.296 was used. Existing settings and gateway processes were preserved; only the isolated acceptance process group was stopped. Context-dependent resume, broad MCP/subagent parity and live concurrency stress remain unproven.

ShellCheck passed for both family lifecycle scripts. Disposable state tests rejected an unrelated PID on start, status and stop without terminating it. No npm or update-distribution behavior was changed.
