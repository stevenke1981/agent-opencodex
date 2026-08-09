# Configuration reference

Required top-level fields: `version`, `server`, `defaults`, and `providers`.

Provider types: `openai-chat`, `openai-responses`, `anthropic`, and `gemini`.

A provider credential is referenced by `apiKeyEnv`; inline `apiKey` is rejected. Environment interpolation supports `${NAME}` and `${NAME:-fallback}`.

Remote binding requires:

```json
{
  "server": {
    "host": "0.0.0.0",
    "clientAuth": {
      "mode": "bearer",
      "tokenEnv": "AGENT_OPENCODEX_CLIENT_KEY"
    }
  }
}
```

The token variable must be set and remote values must contain at least 16 characters. A provider with credentials may not use non-loopback `http://` unless `allowInsecureHttp: true` is explicitly set.

Selectors:

- `model`: uses the default provider
- `provider/model`: selects a provider explicitly
- named route: uses ordered candidates from `routes`

Use `aocx routes --config <path> --model <selector> --json` to inspect the exact route before sending traffic. Continuation settings control only bounded in-memory `previous_response_id` replay; remote compaction v1/v2 uses the same routed provider and requires no additional configuration.
