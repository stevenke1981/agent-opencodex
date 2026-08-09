# Security policy

## Supported release

Security fixes are applied to the latest `0.x` release.

## Secure defaults

- The gateway binds to `127.0.0.1` by default.
- A non-loopback bind is rejected unless bearer client authentication is configured.
- The bearer token environment variable must be populated; for remote binds the value must be at least 16 characters.
- Provider credentials are referenced through `apiKeyEnv`; inline `apiKey` values are rejected.
- A credentialed provider on non-loopback plain HTTP is rejected unless `allowInsecureHttp: true` is explicit.
- Prompt bodies are not written to logs.
- Known environment secrets and credential-shaped fields are redacted from reports.
- Acceptance commands use `shell:false` and must be arrays of arguments.
- No OAuth, account pooling, social action, updater, or automatic Codex configuration write is implemented.

## Trust boundaries

An acceptance specification can start programs and execute commands. It is equivalent to trusted local build configuration. Review specifications before running `aocx verify` or the `aocx_verify` MCP tool.

A loopback service can still be reached by other local processes. Use bearer mode on shared or untrusted hosts. For remote access, place the gateway behind TLS, a VPN, or an authenticated tunnel; bearer authentication alone does not encrypt traffic.

Compaction envelopes contain model-generated conversation summaries. They are not encrypted secrets. Do not store or transmit them outside the same trust boundary as the original prompt.

## Reporting

Do not include API keys, bearer tokens, prompts, compaction summaries, or customer data in a report. Provide a minimal reproduction and the affected version through the repository's private security-reporting channel.
