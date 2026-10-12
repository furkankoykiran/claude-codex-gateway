# claude-codex-gateway

Anthropic Messages-compatible Codex inference adapter for Claude Code. Part of the gateway family with [claude-gemini-gateway](https://github.com/furkankoykiran/claude-gemini-gateway).

## Status and ownership

Experimental protocol subset. Claude Code owns MCP, hooks, permissions and tool execution; the provider supplies inference. Health, catalogs and fixture tests do not prove live access or broad parity. See [the contract](docs/contract.md) and [verification](docs/verification.md) for tested behavior and limitations.

## Architecture

Claude Code -> local Anthropic Messages adapter -> official Codex app-server JSON-RPC. Tool results return through Claude Code and are correlated to the exact pending origin. See [architecture decisions](docs/architecture.md).

## Development and setup

Requires Bun 1.3.8 or newer. Install the official `codex` CLI and authenticate with `codex login`. The gateway uses its existing authentication without copying tokens.

```bash
bun install --frozen-lockfile
# Set CODEX_GATEWAY_MODEL to your available provider model.
bun run src/index.ts serve
```

Point Claude Code at `http://127.0.0.1:4545` using an explicit local settings override. Configure its model for your provider. Do not copy OAuth tokens or change Claude Code's tool permission boundaries.

## Configuration

| Variable | Meaning |
| --- | --- |
| CODEX_GATEWAY_MODEL / CODEX_MODEL | Runtime model for Claude aliases; explicit request IDs are honored |
| CODEX_GATEWAY_REASONING_EFFORT | Optional provider reasoning effort |
| CODEX_GATEWAY_CWD | Working directory; defaults to process cwd |
| CODEX_GATEWAY_PORT | Loopback port, default 4545 |
| CODEX_GATEWAY_TIMEOUT_MS | RPC/turn/tool cycle deadline, default 300000 ms |
| CODEX_GATEWAY_STATE_DIR | Lifecycle state directory; defaults under HOME |

## Diagnostics and lifecycle

`bin/gateway.sh start`, `status`, `doctor`, and `stop` manage a local daemon. `GET /health` and `/healthz` report gateway/version/configuration; `GET /v1/models` reports provider catalog information; `POST /v1/messages` translates inference. A healthy process is not inference entitlement. Restarting invalidates pending tool cycles.

## Verification

```bash
bun run lint
bun run typecheck
bun run test
```

The canonical test command is `bun run test` (`bun test tests`). Gateway CI runs these checks after frozen installation. Use disposable state directories for lifecycle tests and port zero for HTTP fixtures. Record live provider and Claude-owned tool acceptance separately.

## Community and security

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md). Licensed under [MIT](LICENSE).

## Installation

You must have [Bun](https://bun.sh/) and the official `codex` CLI installed.

```bash
# NPM is not yet published.
# Install from the verified GitHub Release artifact:
npm install -g https://github.com/furkankoykiran/claude-codex-gateway/releases/download/v0.1.3/claude-codex-gateway-0.1.3.tgz
```


## Updates & Rollbacks

- **Update**: `npm install -g https://github.com/furkankoykiran/claude-codex-gateway/releases/download/v0.1.3/claude-codex-gateway-0.1.3.tgz`
- **Rollback**: To rollback to a specific version, explicitly specify it: `npm install -g https://github.com/furkankoykiran/claude-codex-gateway/releases/download/v0.1.0/claude-codex-gateway-0.1.0.tgz`
- **Uninstall**: `claude-codex-gateway stop; npm uninstall -g claude-codex-gateway`
