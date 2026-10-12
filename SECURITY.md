# Security policy

The latest main branch is supported. Report vulnerabilities privately at [GitHub Security Advisories](https://github.com/furkankoykiran/claude-codex-gateway/security/advisories/new) or furkankoykiran@gmail.com. Include sanitized reproduction steps and affected commits. Do not publish credentials or exploitable private details in an issue.

## Trust boundary

The gateway is a local inference adapter. Claude Code owns MCP, hooks, permissions and tool execution. Bind it to loopback; do not expose its endpoints publicly. A caller with access to the loopback port can consume the configured provider account. Health reports adapter readiness, not inference entitlement.

Use official provider authentication only. No copying consumer OAuth, silent fallback, request-body logging by default, or synthetic successful tool results. Correlation state is ephemeral and bounded; a restart invalidates pending tool cycles. Unknown results, invalid arguments, cancellations and provider failures fail closed.

Use fixture credentials in tests. Opt-in diagnostics may contain private tool schemas or prompt text; inspect and redact them before sharing. See docs/contract.md for unsupported and unproven boundaries.
