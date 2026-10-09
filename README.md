# claude-codex-gateway

An experimental, standalone gateway that allows native Claude Code to use a local Anthropic-compatible Codex app-server for inference and tool execution.

## Experimental Status

**⚠️ EXPERIMENTAL:** This is a narrow, fail-closed protocol subset meant for testing and local usage. It intentionally limits some features.

## Architecture

- **Claude Code**: Native CLI execution, hooks, local tools, MCPs, and permission boundaries.
- **Local Gateway** (`claude-codex-gateway`): Translates inference traffic.
- **Official Codex App Server**: Local execution backend for code intelligence and reasoning.

## Tool Ownership & Permissions

- **Execution**: Claude Code owns local tool execution (such as `Bash`, `Edit`, `Read`, `Write`), file permissions, and MCP functionality.
- **Translation**: The gateway acts simply as a translation boundary mapping Claude Code inference requests into Codex thread turns.

## Installation

You must have [Bun](https://bun.sh/) and the official `codex` CLI installed.

```bash
# NPM is not yet published.
# Install from the verified GitHub Release artifact:
npm install -g https://github.com/furkankoykiran/claude-codex-gateway/releases/download/v0.1.2/claude-codex-gateway-0.1.2.tgz
```

## Setup & Configuration

1. **Codex Authentication**:
   The gateway uses the existing authenticated Codex CLI. Run `codex login` if needed.
2. **Start the Gateway**:
   ```bash
   claude-codex-gateway start
   ```
3. **Check Gateway Health**:
   ```bash
   claude-codex-gateway doctor
   ```
4. **Configure Claude Code**:
   Instruct Claude Code to use the local loopback gateway and a specific Codex model.
   ```bash
   export CODEX_GATEWAY_MODEL="gpt-6-astra"  # Choose a Codex model ID
   export ANTHROPIC_BASE_URL="http://127.0.0.1:4545"
   claude -p "Hello!"
   ```
   *Note: Model availability shown in `/v1/models` does not guarantee execution access; successful inference is your entitlement proof.*

## Management CLI

- `claude-codex-gateway start`: Start the gateway daemon.
- `claude-codex-gateway status`: Check running status.
- `claude-codex-gateway doctor`: Check system dependencies and configured model.
- `claude-codex-gateway stop`: Stop the gateway daemon gracefully.
- `claude-codex-gateway version`: Print version info.

## Updates & Rollbacks

- **Update**: `npm install -g https://github.com/furkankoykiran/claude-codex-gateway/releases/download/v0.1.2/claude-codex-gateway-0.1.2.tgz`
- **Rollback**: To rollback to a specific version, explicitly specify it: `npm install -g https://github.com/furkankoykiran/claude-codex-gateway/releases/download/v0.1.0/claude-codex-gateway-0.1.0.tgz`
- **Uninstall**: `claude-codex-gateway stop; npm uninstall -g claude-codex-gateway`
