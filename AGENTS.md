# AGENTS.md — Agent OpenCodex operating contract

This repository is designed to be installed, configured, started, tested, and diagnosed by software agents. Treat this file as the authoritative operating contract.

## Mission

Expose an OpenAI Responses-compatible endpoint for coding agents while routing requests to explicitly configured providers. Keep the runtime small, observable, reversible, secure by default, and independently verifiable.

## Non-negotiable safety boundaries

1. Never place API keys in JSON, source files, logs, reports, command arguments, or chat replies. Use the provider's `apiKeyEnv` environment variable.
2. Never edit `~/.codex/config.toml` automatically. Run `aocx codex-config` and present or write the generated fragment for review.
3. Never bind beyond loopback unless `server.clientAuth.mode` is `bearer`, the token environment variable is set, and the token is at least 16 characters.
4. Never send credentials over non-loopback plain HTTP unless the user explicitly approved the private-network risk through `allowInsecureHttp: true`.
5. Never log prompt bodies. The shipped logger records routing and status metadata, not request content.
6. Never star repositories, authorize OAuth, spend account credits, or change user identity settings.
7. Acceptance specifications are trusted local code. Commands execute directly with `shell:false`; inspect a spec before running it.

## Preferred workflow

```bash
node --version
npm install
node ./bin/aocx.mjs init --preset openrouter --model deepseek/deepseek-v4-flash-latest --config ~/.agent-opencodex/config.json --json
node ./bin/aocx.mjs doctor --config ~/.agent-opencodex/config.json --json
node ./bin/aocx.mjs codex-config --config ~/.agent-opencodex/config.json
node ./bin/aocx.mjs serve --config ~/.agent-opencodex/config.json
```

`init` is non-interactive. It creates only the requested Agent OpenCodex configuration and refuses to overwrite an existing file unless `--force` is explicit.

## Machine-readable commands

Use `--json` for automation. Exit codes are stable:

- `0`: command or Acceptance suite passed
- `1`: health or Acceptance checks completed but failed
- `2`: invalid arguments or configuration
- `3`: runtime or infrastructure failure

```bash
aocx validate --config <path> --json
aocx doctor --config <path> --json
aocx routes --config <path> --model <selector> --json
aocx health --url http://127.0.0.1:10101/readyz --json
aocx verify --spec ./examples/acceptance.smoke.json --report-dir ./artifacts/acceptance --json
aocx mcp
```

## Data-plane contracts

The supported public routes are:

```text
GET  /healthz
GET  /readyz
GET  /v1/models
POST /v1/responses
POST /v1/responses/compact
```

For remote compaction v2, a request ending in `compaction_trigger` must produce exactly one `compaction` output item and no ordinary assistant message. For v1, `/v1/responses/compact` must return replacement history in `output`. Do not persist transparent compaction summaries outside the request/response flow.

## Tool protocol invariants

- Preserve the flattened provider wire name for namespaced tools across assistant-call and tool-result history; restore the original `name` plus `namespace` only at the Responses boundary.
- Reject ambiguous unqualified tool choices when multiple namespaces expose the same original name.
- A client-executed tool search must be emitted as `tool_search_call`, with object-valued `arguments`, `execution: "client"`, and no fake function name.
- Accept the paired `tool_search_output` with the same `call_id`, execution mode, status, and discovered `tools` array.
- Validate both generic-provider translation and native Responses pass-through with JSON and SSE tests.
- The stdio control server must support MCP `2026-07-28` `server/discover` and self-describing per-request `_meta`, while preserving legacy `initialize` for 2025-era hosts.
- Every modern successful MCP result must include `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`; cacheable discovery/list results must also include `ttlMs` and `cacheScope`.

## Acceptance definition of done

A change is complete only when all of the following pass:

```bash
npm test
npm run accept
npm run pack:check
```

The Acceptance runner must produce:

- `report.json` — complete machine-readable result
- `summary.md` — human review summary
- `junit.xml` — CI-compatible test report
- `manifest.json` — SHA-256 and byte size for every evidence file
- `logs/*.log` — stdout/stderr from managed services

Do not claim success from process exit alone. Verify response content, tool-call names and arguments, route failover, streaming terminal status, both compaction contracts, modern/legacy MCP over a real stdio process, and evidence files.

## Repository boundaries

Core runtime code lives under `src/`. Public command entrypoints live under `bin/`. Configuration examples are under `config/` and `examples/`. The reusable agent skill is under `skills/agent-opencodex/`. Generated evidence belongs under `artifacts/` and should not be committed except intentional release evidence.

Do not add a dashboard, OAuth/account pooling, service-manager integration, telemetry, auto-update, hosted web/vision sidecars, or automatic Codex mutation without separately approved scope. These are intentionally excluded to keep the agent runtime deterministic.
