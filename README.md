# Agent OpenCodex

Agent OpenCodex is a lean, agent-first OpenAI Responses API gateway. It keeps the protocol translation and model-routing core that coding agents need, while deliberately omitting dashboards, account pooling, OAuth, service installers, and automatic user-state changes.

## Included

- Node.js 20.11+ with zero production dependencies
- OpenAI Chat, native Responses, Anthropic Messages, and Gemini adapters
- OpenAI Responses JSON and SSE output
- Function/custom tools, Codex client-executed `tool_search`, and MCP namespace flattening/restoration
- Bare models, `provider/model`, named routes, retries, and ordered pre-stream failover
- Bounded in-memory `previous_response_id` continuation
- Codex remote compaction v1 and v2 compatibility
- Loopback-first networking and bearer protection for remote binds
- Non-interactive CLI, dual-era stdio MCP (2026-07-28 stateless discovery plus legacy initialize), and deterministic exit codes
- Offline multi-protocol mock provider
- JSON, JUnit, Markdown, logs, and SHA-256 acceptance evidence

See [README.zh-TW.md](./README.zh-TW.md) for the full Traditional Chinese guide and [ANALYSIS.md](./ANALYSIS.md) for the upstream review and scope decisions.

## Quick start

```bash
npm install -g .
aocx init \
  --preset openrouter \
  --model deepseek/deepseek-v4-flash-latest \
  --config ~/.agent-opencodex/config.json \
  --json
export OPENROUTER_API_KEY="..."
aocx doctor --config ~/.agent-opencodex/config.json --json
aocx serve --config ~/.agent-opencodex/config.json
```

On Windows systems that enforce signed PowerShell scripts, run the installer in a one-process bypass without changing the machine policy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Install or update the bundled Codex skill with a timestamped rollback backup and full SHA-256 verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1 -Json
```

The default destination is `%USERPROFILE%\.codex\skills\agent-opencodex`. When replacing an existing installation, the JSON result contains the `backup` path under `%USERPROFILE%\.codex\skill-backups`; keeping backups outside the discovery root prevents duplicate skills. The previous directory is never deleted in place.

`doctor --probe` checks provider catalog access. Add `--inference` only when a minimal live generation is intended; it may consume provider usage:

```bash
aocx doctor --config ~/.agent-opencodex/config.json --probe --inference --json
```

Render a Codex configuration fragment without modifying the user's file:

```bash
aocx codex-config --config ~/.agent-opencodex/config.json
```

## HTTP surface

```text
GET  /healthz
GET  /readyz
GET  /v1/models
POST /v1/responses
POST /v1/responses/compact
```

A normal `/v1/responses` request whose input ends with `{"type":"compaction_trigger"}` is handled as remote compaction v2 and returns exactly one `compaction` output item. `/v1/responses/compact` implements the unary v1 replacement-history contract.

## Tool protocol

Function and custom tools are translated to each upstream provider. MCP namespace tools use a stable flattened wire name upstream and are restored to `{name, namespace}` in Responses output, including multi-turn tool-result replay.

Codex client-executed tool discovery is supported as a real `tool_search` tool. The gateway emits a native `tool_search_call` with object-valued `arguments`, accepts the paired `tool_search_output` containing discovered tools, and continues the conversation on both generic and native Responses routes. It does not disguise tool search as a generic function call.

## Agent interface

```bash
aocx validate --config <path> --json
aocx doctor --config <path> --json
aocx routes --config <path> --model <selector> --json
aocx health --url http://127.0.0.1:10101/readyz --json
aocx verify --spec ./examples/acceptance.smoke.json --report-dir ./artifacts/acceptance --json
aocx mcp
```

The stdio server supports the current stateless MCP `2026-07-28` request model (`server/discover`, per-request `_meta`, `resultType`, and cache hints) while retaining legacy `initialize` compatibility for 2025-era clients. Both eras expose the same deterministic tool catalog.

## Verification

```bash
npm test
npm run accept
npm run pack:check
```

The offline suite starts isolated mock and gateway processes and validates health, catalog output, JSON/SSE responses, function/namespace tools, the complete `tool_search_call` → `tool_search_output` loop, failover, all four provider protocols, both compaction contracts, modern and legacy stdio MCP including a real `aocx_verify` invocation, source syntax, and the agent operating contract.

Read [AGENTS.md](./AGENTS.md) before automating installation or acceptance. Removed surfaces and compatibility limits are documented in [ANALYSIS.md](./ANALYSIS.md).
