import { UpstreamError } from "../errors.mjs";
import { parseSse } from "../utils/sse.mjs";
import { fetchWithRetry, joinUrl, parseJsonSafe, providerHeaders, stringifyToolResult } from "./common.mjs";

export async function prepareAnthropic(candidate, request, context) {
  const { headers, apiKey } = providerHeaders(candidate, context.env, {
    accept: request.stream ? "text/event-stream" : "application/json",
    "anthropic-version": candidate.provider.anthropicVersion ?? "2023-06-01",
  });
  if (apiKey) headers["x-api-key"] = apiKey;
  if (candidate.provider.anthropicBeta) headers["anthropic-beta"] = candidate.provider.anthropicBeta;
  const body = buildAnthropicBody(candidate, request);
  const url = joinUrl(candidate.provider.baseUrl, candidate.provider.messagesPath ?? "messages");
  const response = await fetchWithRetry(candidate, url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { signal: context.signal, timeoutMs: context.timeoutMs });
  return { events: request.stream ? parseAnthropicStream(response) : parseAnthropicJson(response) };
}

export function buildAnthropicBody(candidate, request) {
  const { system, messages } = toAnthropicMessages(request.messages, candidate.provider);
  const body = {
    model: candidate.upstreamModel,
    max_tokens: request.maxOutputTokens ?? candidate.provider.defaultMaxTokens ?? 4_096,
    messages,
    stream: Boolean(request.stream),
  };
  if (system) body.system = system;
  const effectiveTools = filterAllowedTools(request.tools, request.toolChoice);
  if (effectiveTools.length) body.tools = effectiveTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  const toolChoice = effectiveTools.length ? toAnthropicToolChoice(request.toolChoice) : undefined;
  if (toolChoice) body.tool_choice = toolChoice;
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.topP != null) body.top_p = request.topP;
  if (request.reasoningEffort && candidate.provider.enableThinking !== false) {
    const budget = candidate.provider.thinkingBudgets?.[request.reasoningEffort]
      ?? { minimal: 512, low: 1_024, medium: 4_096, high: 8_192, xhigh: 16_384, max: 24_576 }[request.reasoningEffort];
    if (budget) {
      const budgetTokens = Math.max(1_024, budget);
      body.thinking = { type: "enabled", budget_tokens: budgetTokens };
      body.max_tokens = Math.max(body.max_tokens, budgetTokens + 1_024);
    }
  }
  return body;
}

function toAnthropicMessages(messages, provider) {
  const system = [];
  const output = [];
  const push = (role, content) => {
    const previous = output.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else output.push({ role, content });
  };

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = stringifyToolResult(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: stringifyToolResult(message.content),
        ...(message.isError ? { is_error: true } : {}),
      }]);
      continue;
    }
    if (message.role === "user") {
      push("user", toAnthropicContent(message.content, provider));
      continue;
    }
    if (message.role === "assistant") {
      const content = toAnthropicContent(message.content, provider);
      for (const tool of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: parseToolArguments(tool.arguments),
        });
      }
      push("assistant", content.length ? content : [{ type: "text", text: "" }]);
    }
  }

  if (output.length === 0) output.push({ role: "user", content: [{ type: "text", text: "" }] });
  return { system: system.join("\n\n"), messages: output };
}

function toAnthropicContent(parts = [], provider) {
  return parts.flatMap((part) => {
    if (part.type === "text") return [{ type: "text", text: part.text ?? "" }];
    if (part.type !== "image") return [];
    const data = parseDataUrl(part.url);
    if (data) {
      return [{ type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } }];
    }
    if (/^https:\/\//i.test(part.url) && provider.remoteImageSource !== false) {
      return [{ type: "image", source: { type: "url", url: part.url } }];
    }
    return [{ type: "text", text: `[image omitted: ${part.url}]` }];
  });
}

function toAnthropicToolChoice(choice) {
  if (choice == null || choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice.type === "function") return { type: "tool", name: choice.name };
  if (choice.type === "allowed_tools") return choice.mode === "required" ? { type: "any" } : { type: "auto" };
  return undefined;
}

async function* parseAnthropicJson(response) {
  const text = await response.text();
  const json = parseJsonSafe(text);
  if (!json) throw new UpstreamError("Anthropic returned invalid JSON", { status: 502 });
  if (json.type === "error") throw new UpstreamError(json.error?.message ?? "Anthropic error", { status: 502 });
  let toolIndex = 0;
  for (const block of json.content ?? []) {
    if (block.type === "text" && block.text) yield { type: "text_delta", text: block.text };
    else if (block.type === "thinking" && block.thinking) yield { type: "reasoning_delta", text: block.thinking };
    else if (block.type === "tool_use") {
      yield { type: "tool_start", index: toolIndex, id: block.id, name: block.name };
      yield { type: "tool_delta", index: toolIndex, arguments: JSON.stringify(block.input ?? {}) };
      yield { type: "tool_end", index: toolIndex };
      toolIndex += 1;
    }
  }
  yield { type: "done", usage: anthropicUsage(json.usage), stopReason: json.stop_reason };
}

async function* parseAnthropicStream(response) {
  const blocks = new Map();
  let nextToolIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason;
  let emittedDone = false;

  for await (const frame of parseSse(response.body)) {
    if (!frame.data) continue;
    const event = parseJsonSafe(frame.data);
    if (!event) continue;
    const type = event.type ?? frame.event;
    if (type === "error") {
      yield { type: "error", message: event.error?.message ?? "Anthropic stream error", code: event.error?.type };
      return;
    }
    if (type === "message_start") {
      inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
      outputTokens = event.message?.usage?.output_tokens ?? outputTokens;
      continue;
    }
    if (type === "content_block_start") {
      const blockIndex = event.index ?? blocks.size;
      const block = event.content_block ?? {};
      if (block.type === "tool_use") {
        const toolIndex = nextToolIndex++;
        blocks.set(blockIndex, { type: "tool", toolIndex });
        yield { type: "tool_start", index: toolIndex, id: block.id, name: block.name };
        if (block.input && Object.keys(block.input).length) {
          yield { type: "tool_delta", index: toolIndex, arguments: JSON.stringify(block.input) };
        }
      } else {
        blocks.set(blockIndex, { type: block.type });
        if (block.type === "text" && block.text) yield { type: "text_delta", text: block.text };
        if (block.type === "thinking" && block.thinking) yield { type: "reasoning_delta", text: block.thinking };
      }
      continue;
    }
    if (type === "content_block_delta") {
      const state = blocks.get(event.index);
      const delta = event.delta ?? {};
      if (delta.type === "text_delta" && delta.text) yield { type: "text_delta", text: delta.text };
      else if (delta.type === "thinking_delta" && delta.thinking) yield { type: "reasoning_delta", text: delta.thinking };
      else if (delta.type === "input_json_delta" && state?.type === "tool") {
        yield { type: "tool_delta", index: state.toolIndex, arguments: delta.partial_json ?? "" };
      }
      continue;
    }
    if (type === "content_block_stop") {
      const state = blocks.get(event.index);
      if (state?.type === "tool") yield { type: "tool_end", index: state.toolIndex };
      continue;
    }
    if (type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      outputTokens = event.usage?.output_tokens ?? outputTokens;
      continue;
    }
    if (type === "message_stop") {
      emittedDone = true;
      yield { type: "done", usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stopReason };
      return;
    }
  }
  if (!emittedDone) yield { type: "done", usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stopReason };
}

function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url));
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    return { input: String(value ?? "") };
  }
}

function anthropicUsage(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cached_input_tokens: usage.cache_read_input_tokens ?? 0,
    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}

function filterAllowedTools(tools = [], choice) {
  if (choice?.type !== "allowed_tools") return tools;
  const allowed = new Set(choice.names);
  return tools.filter((tool) => allowed.has(tool.name) || allowed.has(tool.originalName));
}
