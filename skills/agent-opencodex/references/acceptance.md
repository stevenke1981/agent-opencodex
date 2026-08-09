# Acceptance reference

Spec version is `1`. A spec may define managed `services` and `checks`.

Supported checks:

- `file`: existence, size, text inclusion, regular expression
- `json`: JSON Pointer existence/equality/match
- `command`: direct executable/argument array, exit/stdout/stderr assertions
- `http`: status, body, and JSON assertions
- `llm`: Responses JSON/SSE text, terminal status, tool-call name, output item type, and forbidden output type assertions

Useful LLM expectations include:

```json
{
  "status": 200,
  "statusValue": "completed",
  "textIncludes": "expected text",
  "toolName": "expected_tool",
  "outputType": "compaction",
  "outputNotType": "message"
}
```

Service and check strings support templates such as `{{root}}` and `{{services.gateway.ports.HTTP}}`. Ports with value `0` are allocated before startup.

Every run creates `report.json`, `summary.md`, `junit.xml`, `manifest.json`, and service logs. A successful process without content assertions is not sufficient evidence. The shipped smoke suite covers all four provider protocols, ordered failover, function tools, Codex-native client-executed `tool_search`, and both Codex compaction contracts.
