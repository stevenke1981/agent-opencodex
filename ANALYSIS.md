# Upstream analysis and lean agent-first redesign

## Source reviewed

- Repository: `lidge-jun/opencodex`
- Default branch: `main`
- Inspected tree: `57140d6f06218d604ee139e5909a1b868bf7a84b`
- Inspection date: 2026-08-08
- Upstream license: MIT

The upstream project is a broad local gateway for Codex, Claude Code, Claude Desktop, and Grok Build. Its scope includes a Responses parser and bridge, many provider transports, model catalog injection, ChatGPT account pools, OAuth/keyring storage, a browser dashboard, quota and usage views, web/vision/image sidecars, background services, client shims, update flows, and compatibility code for multiple desktop products.

That breadth is useful for a human-operated universal gateway, but it also creates a large install surface and many user-state or identity-sensitive actions. A coding agent usually needs a smaller contract: accept Responses requests, route them, preserve tools and streaming, survive provider failures, support long-task compaction, and produce evidence that the system works.

## Architecture retained

The redesign retains the strongest protocol boundary from upstream:

```text
OpenAI Responses request
        ↓
canonical agent request
        ↓
ordered model route
        ↓
provider wire adapter
        ↓
canonical event stream
        ↓
OpenAI Responses JSON / SSE
```

The canonical request contains user/developer/assistant/tool-result messages, image references, tools, namespace metadata, tool choices, reasoning settings, structured-output hints, and continuation state. Provider adapters never write directly to the client response. They emit normalized text, reasoning, tool, usage, completion, incomplete, or error events; one Responses bridge owns output item IDs, ordering, terminal states, and SSE event shapes.

This separation is the key feature worth retaining because it keeps routing, protocol translation, and client output independently testable.

## Scope decision matrix

### Removed

| Removed surface | Agent-first reason |
|---|---|
| Web dashboard and GUI build | Agents need deterministic CLI/MCP output rather than browser state |
| ChatGPT account pools and quota routing | High credential, identity, affinity, and recovery complexity |
| OAuth and OS keyring flows | Environment-referenced API keys are easier to inspect and revoke |
| Automatic Codex config/catalog mutation | Changes user state and complicates review and rollback |
| Background service installers and launch shims | Foreground process ownership is clearer for agents and CI |
| Self-update and repository-star prompts | Outside the requested routing task and user-consent boundary |
| Usage dashboard and telemetry | Not required for protocol correctness; prompts remain unlogged |
| Hosted web-search, vision, image, and video sidecars | Hidden secondary calls, extra credentials, and account coupling |
| Cursor protobuf and broad desktop-client compatibility | Not required for the Responses-first agent endpoint |
| Weighted account/model pools | Ordered candidates are simpler to explain, reproduce, and test |
| WebSocket and Realtime/voice transports | HTTP/SSE covers the intended coding-agent workflow |

### Retained or rebuilt

| Capability | Lean implementation |
|---|---|
| Responses data plane | `POST /v1/responses`, JSON and SSE |
| Remote compaction v1 | `POST /v1/responses/compact`, replacement-history output |
| Remote compaction v2 | `compaction_trigger` produces exactly one transparent `compaction` item |
| Model discovery | `GET /v1/models` |
| Liveness/readiness | `GET /healthz`, `GET /readyz` |
| Routing | Bare model, `provider/model`, and named ordered routes |
| Failure recovery | Per-provider retry plus route failover before output begins |
| OpenAI-compatible chat | `openai-chat` adapter |
| Native Responses | `openai-responses` adapter |
| Anthropic Messages | `anthropic` adapter |
| Gemini generateContent | `gemini` adapter |
| Tool calls | Function/custom tools, native client-executed `tool_search`, and namespace flatten/restore |
| Reasoning | Normalized provider reasoning/thinking summary events |
| Continuation | Bounded in-memory `previous_response_id`; no disk persistence |
| Agent control | Non-interactive CLI and dual-era stdio MCP: stateless 2026-07-28 plus legacy initialize |
| Acceptance | Managed services plus file/JSON/command/HTTP/LLM checks |
| Evidence | JSON, Markdown, JUnit, logs, and SHA-256 manifest |
| Offline verification | Multi-protocol mock provider |

## Long-task compatibility

Long coding sessions can require more than local `previous_response_id` replay. Two Codex compaction paths are therefore part of the minimal core rather than optional dashboard functionality:

1. **Remote compaction v2** arrives as a normal Responses request ending in `compaction_trigger`. The routed model is instructed to summarize, tools are disabled, and the bridge emits exactly one `compaction` output item. The transparent `aocx1:` envelope can be replayed by this gateway. `ocx1:` envelopes from the reviewed upstream are also decoded for migration.
2. **Remote compaction v1** uses `/v1/responses/compact`. The gateway summarizes the input, retains recent real user messages within a bounded character budget, and returns replacement history in `output`.

Opaque provider-encrypted compaction values are not decrypted. They are converted to an explicit context note rather than silently discarded.

## Dependency reduction

The runtime uses only Node.js built-in modules and has zero production dependencies. This removes Bun, GUI packages, keyring/native bindings, protobuf SDKs, and schema libraries from the installation path. Validation is intentionally hand-scoped to the supported configuration and wire shapes.

The tradeoff is explicit: this package has fewer provider-specific edge cases than the universal upstream project, but its runtime is much easier for an agent to install, inspect, package, and reproduce.

## Security posture

- Loopback is the default listener.
- Non-loopback binding requires bearer authentication and a populated token environment variable.
- Remote bearer tokens must be at least 16 characters.
- Provider secrets are environment references; inline `apiKey` values are rejected.
- Credentialed non-loopback HTTP providers are rejected unless `allowInsecureHttp` is explicit.
- Prompt bodies are not written to logs.
- Known environment secrets and credential-shaped fields are redacted from evidence.
- Acceptance commands use argument arrays with `shell:false`.
- No OAuth, account, social, updater, or automatic configuration action exists.

## Acceptance strategy

A process starting successfully is not sufficient. The shipped offline suite launches isolated mock and gateway services and verifies:

- health, readiness, and model catalog contracts;
- non-stream and stream Responses output;
- function tools, namespace restoration, and the client-executed `tool_search_call`/`tool_search_output` loop;
- ordered route failover;
- OpenAI Chat, native Responses, Anthropic, and Gemini paths;
- compaction v1 and v2 output contracts;
- modern `server/discover`, cacheable `tools/list`, a real stdio `aocx_verify` call, legacy initialize, source syntax, and the presence of the agent operating contract.

Reports are emitted as machine-readable JSON, CI-compatible JUnit, a reviewable Markdown summary, process logs, and a manifest containing file sizes and SHA-256 hashes.

## Compatibility boundaries

This is not a drop-in replacement for every upstream client or management feature. It is a Responses-first gateway for coding agents. Dashboard management, account pooling, OAuth, automatic catalog injection, WebSocket, Realtime/voice, image generation, hosted web/vision sidecars, and desktop-specific transports are deliberately absent.

Unsupported surfaces are documented rather than silently emulated. The CLI also renders—but never automatically applies—the Codex provider fragment, preserving review and rollback.
