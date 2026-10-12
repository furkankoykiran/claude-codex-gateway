# Contributing

Report reproducible bugs with the gateway version, provider transport, Claude Code version, and a sanitized request/event sequence. Keep credentials, private prompts and MCP payloads out of issues and fixtures.

## Development

Install Bun 1.3.8 or newer and the provider requirements in README.md. From the repository root:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

Tests belong in `tests/`: translation and configuration in `index.test.ts`, correlation and cleanup in `routing.test.ts`. Bind test HTTP servers to port zero. Run lifecycle tests with a disposable HOME or provider state directory. Do not change your real authentication for tests.

## Changes and review

Make scoped Conventional Commits (`fix(gateway): ...`, `test(routing): ...`, `docs(gateway): ...`). Open a feature branch and a pull request; wait for Gateway CI and existing required checks. Never bypass protection or push directly to main. Protocol changes need a regression that fails before the fix. Live checks must distinguish a provider reply, Claude-owned execution, a real result continuation, and a new user turn.

Contributions use the repository MIT license. Keep third-party notices when copying licensed code. Report vulnerabilities privately using SECURITY.md.
