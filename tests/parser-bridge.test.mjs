import test from "node:test";
import assert from "node:assert/strict";
import { parseResponsesRequest, canonicalMessagesForContinuation } from "../src/responses/parse.mjs";
import { ResponsesBridge } from "../src/responses/bridge.mjs";
import { ContinuationStore } from "../src/continuation-store.mjs";

test("namespace tools flatten for providers and restore for Responses output", () => {
  const request = parseResponsesRequest({
    model: "route",
    input: "call tool",
    stream: false,
    tools: [{
      type: "namespace",
      name: "mcp__weather",
      tools: [{ type: "function", name: "forecast", description: "Forecast", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    }],
  });
  assert.equal(request.tools[0].name, "mcp__weather__forecast");
  const bridge = new ResponsesBridge({ model: request.model, toolMetadata: request.toolMetadata });
  bridge.accept({ type: "tool_start", index: 0, id: "call_1", name: "mcp__weather__forecast" });
  bridge.accept({ type: "tool_delta", index: 0, arguments: '{"city":"Taipei"}' });
  bridge.accept({ type: "tool_end", index: 0 });
  bridge.accept({ type: "done" });
  const item = bridge.toResponseJson().output[0];
  assert.equal(item.type, "function_call");
  assert.equal(item.name, "forecast");
  assert.equal(item.namespace, "mcp__weather");
  assert.equal(item.arguments, '{"city":"Taipei"}');
});

test("bridge creates terminal text and usage response", () => {
  const bridge = new ResponsesBridge({ model: "test-model" });
  assert.equal(bridge.createdEvent().name, "response.created");
  bridge.accept({ type: "reasoning_delta", text: "think" });
  bridge.accept({ type: "text_delta", text: "hello" });
  const terminal = bridge.accept({ type: "done", usage: { input_tokens: 2, output_tokens: 3 } });
  assert.equal(terminal.at(-1).name, "response.completed");
  const response = bridge.toResponseJson();
  assert.equal(response.status, "completed");
  assert.equal(response.usage.total_tokens, 5);
  assert.equal(bridge.summary().outputText, "hello");
});

test("continuation store replays bounded prior messages", () => {
  const store = new ContinuationStore({ maxEntries: 2, ttlMs: 10000 });
  const first = parseResponsesRequest({ model: "m", input: "first", stream: false });
  const messages = canonicalMessagesForContinuation(first, { outputText: "answer", toolCalls: [] });
  store.set("resp_1", { messages });
  const second = parseResponsesRequest({ model: "m", previous_response_id: "resp_1", input: "second", stream: false }, { continuationStore: store });
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[0].content[0].text, "first");
  assert.equal(second.messages[2].content[0].text, "second");
});

test("namespaced tool history keeps the provider wire name across turns", () => {
  const request = parseResponsesRequest({
    model: "route",
    stream: false,
    tools: [{
      type: "namespace",
      name: "mcp__climate",
      tools: [{ type: "function", name: "weather", parameters: { type: "object", properties: {} } }],
    }],
    input: [
      {
        type: "function_call",
        call_id: "call_weather",
        namespace: "mcp__climate",
        name: "weather",
        arguments: '{"city":"Taipei"}',
      },
      {
        type: "function_call_output",
        call_id: "call_weather",
        output: "sunny",
      },
    ],
  });

  assert.equal(request.messages[0].toolCalls[0].name, "mcp__climate__weather");
  assert.equal(request.messages[0].toolCalls[0].originalName, "weather");
  assert.equal(request.messages[1].toolName, "mcp__climate__weather");
});

test("tool choice resolves namespaces and rejects ambiguous original names", () => {
  const selected = parseResponsesRequest({
    model: "route",
    input: "use tool",
    tools: [{
      type: "namespace",
      name: "mcp__one",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    }],
    tool_choice: { type: "function", namespace: "mcp__one", name: "lookup" },
  });
  assert.deepEqual(selected.toolChoice, { type: "function", name: "mcp__one__lookup" });

  assert.throws(() => parseResponsesRequest({
    model: "route",
    input: "use tool",
    tools: [
      { type: "namespace", name: "mcp__one", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] },
      { type: "namespace", name: "mcp__two", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] },
    ],
    tool_choice: { type: "function", name: "lookup" },
  }), /ambiguous/i);
});

test("parser rejects duplicate provider wire names", () => {
  assert.throws(() => parseResponsesRequest({
    model: "route",
    input: "use tool",
    tools: [
      { type: "function", name: "same", parameters: { type: "object", properties: {} } },
      { type: "function", name: "same", parameters: { type: "object", properties: {} } },
    ],
  }), /Duplicate tool wire name/);
});

test("bridge preserves output_item.added when a provider sends arguments before tool_start", () => {
  const bridge = new ResponsesBridge({ model: "test-model" });
  const events = bridge.accept({ type: "tool_delta", index: 0, id: "call_late", name: "late", arguments: '{"x":1}' });
  assert.equal(events[0].name, "response.output_item.added");
  assert.equal(events[1].name, "response.function_call_arguments.delta");
  bridge.accept({ type: "tool_end", index: 0 });
  bridge.accept({ type: "done" });
  assert.equal(bridge.toResponseJson().output[0].arguments, '{"x":1}');
});

test("tool_search emits the Codex-native call shape", () => {
  const request = parseResponsesRequest({
    model: "route",
    input: "find a tool",
    stream: false,
    tools: [{
      type: "tool_search",
      execution: "client",
      description: "Search available tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
  });
  assert.equal(request.tools[0].name, "tool_search");
  assert.equal(request.tools[0].kind, "tool_search");

  const bridge = new ResponsesBridge({ model: request.model, toolMetadata: request.toolMetadata });
  bridge.accept({ type: "tool_start", index: 0, id: "search_1", name: "tool_search" });
  const deltaEvents = bridge.accept({ type: "tool_delta", index: 0, arguments: '{"query":"weather"}' });
  assert.equal(deltaEvents.length, 0);
  const doneEvents = bridge.accept({ type: "tool_end", index: 0 });
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].name, "response.output_item.done");
  bridge.accept({ type: "done" });

  const item = bridge.toResponseJson().output[0];
  assert.deepEqual(item, {
    id: item.id,
    type: "tool_search_call",
    status: "completed",
    call_id: "search_1",
    execution: "client",
    arguments: { query: "weather" },
  });
});

test("tool_search call and output parse as matched canonical history", () => {
  const loadedTool = {
    type: "function",
    name: "weather",
    description: "Weather",
    parameters: { type: "object", properties: {} },
  };
  const request = parseResponsesRequest({
    model: "route",
    input: [
      { type: "tool_search_call", call_id: "search_1", execution: "client", arguments: { query: "weather" } },
      { type: "tool_search_output", call_id: "search_1", execution: "client", status: "completed", tools: [loadedTool] },
    ],
  });
  assert.equal(request.messages[0].toolCalls[0].kind, "tool_search");
  assert.equal(request.messages[0].toolCalls[0].name, "tool_search");
  assert.equal(request.messages[1].toolKind, "tool_search");
  assert.deepEqual(request.messages[1].toolSearchTools, [loadedTool]);
});
