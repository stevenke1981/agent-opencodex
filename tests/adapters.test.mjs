import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIChatBody, parseOpenAIChatStream } from "../src/adapters/openai-chat.mjs";
import { buildAnthropicBody } from "../src/adapters/anthropic.mjs";
import { buildGeminiBody } from "../src/adapters/gemini.mjs";
import { toResponsesInput } from "../src/adapters/openai-responses.mjs";

const request = {
  stream: true,
  messages: [
    { role: "system", content: [{ type: "text", text: "system" }] },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ],
  tools: [{ name: "weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
  toolChoice: { type: "function", name: "weather" },
  maxOutputTokens: 100,
  reasoningEffort: "medium",
};

test("OpenAI chat request mapping", () => {
  const body = buildOpenAIChatBody({ upstreamModel: "chat-model", provider: {} }, request);
  assert.equal(body.model, "chat-model");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.tools[0].function.name, "weather");
  assert.equal(body.tool_choice.function.name, "weather");
  assert.equal(body.reasoning_effort, "medium");
});

test("Anthropic request mapping", () => {
  const body = buildAnthropicBody({ upstreamModel: "claude-model", provider: {} }, request);
  assert.equal(body.model, "claude-model");
  assert.equal(body.system, "system");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.tools[0].name, "weather");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "weather" });
  assert.equal(body.thinking.type, "enabled");
});

test("Gemini request mapping", () => {
  const body = buildGeminiBody({ upstreamModel: "gemini-model", provider: {} }, request);
  assert.equal(body.systemInstruction.parts[0].text, "system");
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.tools[0].functionDeclarations[0].name, "weather");
  assert.equal(body.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(body.generationConfig.thinkingConfig.includeThoughts, true);
});

test("Anthropic and Gemini omit tool selection when no tools remain", () => {
  const noTools = {
    ...request,
    tools: [],
    toolChoice: "none",
  };
  const anthropic = buildAnthropicBody({ upstreamModel: "claude-model", provider: {} }, noTools);
  const gemini = buildGeminiBody({ upstreamModel: "gemini-model", provider: {} }, noTools);

  assert.equal("tools" in anthropic, false);
  assert.equal("tool_choice" in anthropic, false);
  assert.equal("tools" in gemini, false);
  assert.equal("toolConfig" in gemini, false);
});

test("Gemini allowed-tools uses flattened wire names", () => {
  const body = buildGeminiBody({ upstreamModel: "gemini-model", provider: {} }, {
    ...request,
    tools: [{
      name: "mcp__climate__weather",
      originalName: "weather",
      description: "Weather",
      parameters: { type: "object", properties: {} },
    }],
    toolChoice: { type: "allowed_tools", mode: "required", names: ["weather"] },
  });

  assert.deepEqual(
    body.toolConfig.functionCallingConfig.allowedFunctionNames,
    ["mcp__climate__weather"],
  );
});

test("OpenAI chat stream buffers fragmented function names", async () => {
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "wea" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ther" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"Taipei\"}" } }] }, finish_reason: "tool_calls" }] },
  ];
  const sse = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  const response = new Response(sse, { headers: { "content-type": "text/event-stream" } });
  const events = [];
  for await (const event of parseOpenAIChatStream(response)) events.push(event);

  assert.deepEqual(events.filter((event) => event.type === "tool_start"), [{
    type: "tool_start",
    index: 0,
    id: "call_1",
    name: "weather",
  }]);
  assert.equal(
    events.filter((event) => event.type === "tool_delta").map((event) => event.arguments).join(""),
    '{"city":"Taipei"}',
  );
});


test("native Responses replay restores namespaced names and tool_search protocol items", () => {
  const input = toResponsesInput([
    {
      role: "assistant",
      content: [],
      toolCalls: [
        {
          id: "call_weather",
          name: "mcp__climate__weather",
          originalName: "weather",
          namespace: "mcp__climate",
          kind: "function",
          arguments: '{"city":"Taipei"}',
        },
        {
          id: "search_1",
          name: "tool_search",
          originalName: "tool_search",
          kind: "tool_search",
          execution: "client",
          arguments: '{"query":"weather"}',
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_weather",
      toolName: "mcp__climate__weather",
      toolKind: "function",
      content: [{ type: "text", text: "sunny" }],
    },
    {
      role: "tool",
      toolCallId: "search_1",
      toolName: "tool_search",
      toolKind: "tool_search",
      execution: "client",
      toolSearchTools: [{ type: "function", name: "weather", parameters: { type: "object", properties: {} } }],
      content: [],
    },
  ]);

  assert.deepEqual(input[0], {
    type: "function_call",
    call_id: "call_weather",
    name: "weather",
    arguments: '{"city":"Taipei"}',
    namespace: "mcp__climate",
  });
  assert.deepEqual(input[1], {
    type: "tool_search_call",
    call_id: "search_1",
    status: "completed",
    execution: "client",
    arguments: { query: "weather" },
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call_weather",
    output: "sunny",
  });
  assert.deepEqual(input[3], {
    type: "tool_search_output",
    call_id: "search_1",
    status: "completed",
    execution: "client",
    tools: [{ type: "function", name: "weather", parameters: { type: "object", properties: {} } }],
  });
});

test("generic provider replay keeps namespaced wire names", () => {
  const replayRequest = {
    ...request,
    messages: [
      {
        role: "assistant",
        content: [],
        toolCalls: [{
          id: "call_weather",
          name: "mcp__climate__weather",
          originalName: "weather",
          namespace: "mcp__climate",
          kind: "function",
          arguments: '{"city":"Taipei"}',
        }],
      },
      {
        role: "tool",
        toolCallId: "call_weather",
        toolName: "mcp__climate__weather",
        content: [{ type: "text", text: "sunny" }],
      },
    ],
  };
  const openai = buildOpenAIChatBody({ upstreamModel: "chat-model", provider: {} }, replayRequest);
  const anthropic = buildAnthropicBody({ upstreamModel: "claude-model", provider: {} }, replayRequest);
  const gemini = buildGeminiBody({ upstreamModel: "gemini-model", provider: {} }, replayRequest);

  assert.equal(openai.messages[0].tool_calls[0].function.name, "mcp__climate__weather");
  assert.equal(anthropic.messages[0].content[0].name, "mcp__climate__weather");
  assert.equal(gemini.contents[0].parts[0].functionCall.name, "mcp__climate__weather");
  assert.equal(gemini.contents[1].parts[0].functionResponse.name, "mcp__climate__weather");
});
