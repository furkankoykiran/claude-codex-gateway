# Repository instructions

Read CONTRIBUTING.md and docs/contract.md before changing the adapter. Claude Code owns MCP, hooks, permissions and all client tool execution. Keep current user text authoritative and reject stale, duplicate or uncorrelated tool results. Preserve provider-specific transports and supported authentication boundaries.

Use Bun and the committed lockfile. Run `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, and `bun run test`. Use isolated loopback ports and fixture credentials for tests. Record live evidence separately; health and fixtures do not prove provider access or broad parity.

Use scoped Conventional Commits and branch/PR delivery with normal checks. Never print or commit credentials, copy consumer OAuth, bypass merge gates, or push directly to main. Keep npm and update-distribution work outside gateway contract changes.
