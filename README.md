# Claude Codex Gateway

A standalone gateway translating Claude Code's Anthropic API requests into Codex app-server protocol without behavioral changes.

## Setup

```bash
bun install
```

## Running the Gateway

Start the gateway:
```bash
bun run start
```

Stop the gateway:
```bash
bun run stop
```

Check status:
```bash
bun run status
```

## Claude Code Configuration

To use this gateway with Claude Code, set the `ANTHROPIC_BASE_URL` environment variable:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4545
```
