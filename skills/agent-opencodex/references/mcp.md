# MCP reference

Run `aocx mcp` over stdio. Messages are newline-delimited JSON-RPC 2.0.

## Protocol eras

The server supports both:

- MCP `2026-07-28`: stateless requests with `params._meta`, `server/discover`, required `resultType`, response server identity, and `ttlMs`/`cacheScope` on cacheable results.
- Legacy 2025-era MCP: `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. Unsupported initialize versions negotiate down to `2025-11-25`.

For a modern request, include:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { "name": "my-agent", "version": "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  }
}
```

Use `server/discover` before listing tools when the client supports the modern protocol. The server also accepts direct modern `tools/list` and `tools/call` requests because every request is self-describing.

## Tools

- `aocx_validate_config`
- `aocx_doctor`
- `aocx_route`
- `aocx_render_codex_config`
- `aocx_verify`
- `aocx_health`

`aocx_render_codex_config` returns TOML and never edits user files. `aocx_verify` may run commands from a trusted spec and writes evidence to the requested report directory. Unknown tool names are protocol-level `-32602` errors; execution failures are returned to the model with `isError: true`.
