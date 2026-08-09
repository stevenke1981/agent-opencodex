# Changelog

## Unreleased

- Added an explicit `doctor --inference` end-to-end generation diagnostic so catalog access is not mistaken for usable model inference.
- Documented a process-scoped Windows PowerShell installation path for systems that enforce signed scripts.

## 0.1.0 — 2026-08-08

- Initial independently implemented, agent-first implementation.
- Added OpenAI Responses JSON/SSE gateway.
- Added OpenAI Chat, native Responses, Anthropic, and Gemini adapters.
- Added named routing, retry, ordered failover, bounded local continuation, tool namespace restoration, and Codex-native client-executed `tool_search` round trips.
- Added remote compaction v1 and v2, transparent summary replay, and migration support for `ocx1:` envelopes.
- Added safe CLI, dual-era stdio MCP (2026-07-28 stateless discovery plus legacy initialize), offline mock provider, and evidence-based acceptance runner.
- Added Traditional Chinese and English documentation, agent contract, security policy, Docker assets, and CI.
