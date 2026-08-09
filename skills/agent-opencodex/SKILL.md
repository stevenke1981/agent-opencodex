---
name: agent-opencodex
description: Install, configure, run, route, diagnose, and acceptance-test the lean Agent OpenCodex Responses gateway. Use when an agent needs to route Codex/Responses traffic through OpenRouter, DeepSeek, Ollama, Anthropic, Gemini, or another configured provider without a dashboard or automatic user-state changes.
---

# Agent OpenCodex

## Guardrails

- Read the repository `AGENTS.md` first.
- Never put keys in config files or command arguments; use `apiKeyEnv`.
- Never edit `~/.codex/config.toml` automatically. Render a fragment with `aocx codex-config`.
- Keep loopback binding unless remote access and bearer authentication are explicitly required.
- Treat Acceptance specs as trusted code; inspect commands before running them.
- Treat transparent compaction envelopes as prompt-derived data, not encrypted secrets.

## Workflow

1. Locate `aocx` or use `node ./bin/aocx.mjs`.
2. Create or inspect configuration.
3. Run `validate` and `doctor --json`.
4. Render the Codex fragment and present it for review.
5. Start `serve` in the foreground under the caller's process supervision.
6. Verify `/readyz`, non-stream output, stream output, a function/namespace tool call, a complete `tool_search_call` → `tool_search_output` continuation, remote compaction v1, and remote compaction v2.
7. Run `aocx verify` and report the generated evidence paths.

## Commands

```bash
aocx init --preset openrouter --model deepseek/deepseek-v4-flash-latest --config ~/.agent-opencodex/config.json --json
aocx validate --config ~/.agent-opencodex/config.json --json
aocx doctor --config ~/.agent-opencodex/config.json --json
aocx codex-config --config ~/.agent-opencodex/config.json
aocx serve --config ~/.agent-opencodex/config.json
aocx verify --spec ./examples/acceptance.smoke.json --report-dir ./artifacts/acceptance --json
```

Read `references/configuration.md`, `references/acceptance.md`, and `references/mcp.md` for schemas and expected outputs.
