import { parseSse } from "../utils/sse.mjs";
import { fetchWithRetry, joinUrl, parseJsonSafe, providerHeaders, stringifyToolResult, usageFromOpenAI } from "./common.mjs";
import { UpstreamError } from "../errors.mjs";

export async function prepareOpenAIChat(candidate, request, context) {
  const { headers, apiKey } = providerHeaders(candidate, context.env, { accept: request.stream ? "text/event-stream" : "application/json" });
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = buildOpenAIChatBody(candidate, request);
  const url = joinUrl(candidate.provider.baseUrl, candidate.provider.chatPath ?? "chat/completions");
  const response = await fetchWithRetry(candidate, url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { signal: context.signal, timeoutMs: context.timeoutMs });
  return { events: request.stream ? parseOpenAIChatStream(response) : parseOpenAIChatJson(response) };
}

export function buildOpenAIChatBody(candidate, request) {
  const provider = candidate.provider;
  const body = {
    model: candidate.upstreamModel,
    messages: toOpenAIMessages(request.messages, provider),
    stream: Boolean(request.stream),
  };
  if (request.stream) body.stream_options = { include_usage: true };
  const effectiveTools = filterAllowedTools(request.tools, request.toolChoice);
  if (effectiveTools.length) body.tools = effectiveTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.strict == null ? {} : { strict: tool.strict }),
    },
  }));
  const toolChoice = toOpenAIToolChoice(request.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (request.parallelToolCalls != null) body.parallel_tool_calls = Boolean(request.parallelToolCalls);
  if (request.maxOutputTokens) body[provider.maxTokensField ?? "max_tokens"] = request.maxOutputTokens;
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.topP != null) body.top_p = request.topP;
  if (request.reasoningEffort && provider.reasoningField !== "none") {
    if (provider.reasoningField === "reasoning.effort") body.reasoning = { effort: request.reasoningEffort };
    else body[provider.reasoningField ?? "reasoning_effort"] = request.reasoningEffort;
  }
  if (request.serviceTier) body.service_tier = request.serviceTier;
  if (request.textFormat) body.response_format = toChatResponseFormat(request.textFormat);
  return body;
}

function toOpenAIMessages(messages, provider) {
  const output = [];
  for (const message of messages) {
    if (message.role === "tool") {
      output.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: stringifyToolResult(message.content),
      });
      continue;
    }
    const role = message.role === "developer" && provider.supportsDeveloperRole === false ? "system" : message.role;
    const item = { role };
    if (message.content?.length) item.content = toOpenAIContent(message.content);
    else item.content = "";
    if (message.role === "assistant" && message.toolCalls?.length) {
      item.tool_calls = message.toolCalls.map((tool) => ({
        id: tool.id,
        type: "function",
        function: { name: tool.name, arguments: tool.arguments || "{}" },
      }));
    }
    output.push(item);
  }
  return output;
}

function toOpenAIContent(parts) {
  const hasImage = parts.some((part) => part.type === "image");
  if (!hasImage) return parts.map((part) => part.text ?? "").join("");
  return parts.map((part) => part.type === "image"
    ? { type: "image_url", image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } }
    : { type: "text", text: part.text ?? "" });
}

function toOpenAIToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "function") return { type: "function", function: { name: choice.name } };
  if (choice.type === "allowed_tools") return choice.mode;
  return undefined;
}

function toChatResponseFormat(format) {
  if (format.type === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: format.name ?? "response",
      description: format.description,
      schema: format.schema ?? {},
      strict: format.strict ?? true,
    },
  };
}

async function* parseOpenAIChatJson(response) {
  const text = await response.text();
  const json = parseJsonSafe(text);
  if (!json) throw new UpstreamError("OpenAI-compatible provider returned invalid JSON", { status: 502 });
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const reasoning = extractReasoning(message);
  if (reasoning) yield { type: "reasoning_delta", text: reasoning };
  const content = extractText(message.content);
  if (content) yield { type: "text_delta", text: content };
  let index = 0;
  for (const tool of message.tool_calls ?? []) {
    yield { type: "tool_start", index, id: tool.id, name: tool.function?.name ?? tool.name ?? "tool" };
    const args = tool.function?.arguments ?? tool.arguments ?? "{}";
    if (args) yield { type: "tool_delta", index, arguments: typeof args === "string" ? args : JSON.stringify(args) };
    yield { type: "tool_end", index };
    index += 1;
  }
  yield { type: "done", usage: usageFromOpenAI(json.usage), stopReason: choice.finish_reason };
}

export async function* parseOpenAIChatStream(response) {
  const tools = new Map();
  let usage;
  let finishReason;
  for await (const frame of parseSse(response.body)) {
    if (!frame.data) continue;
    if (frame.data === "[DONE]") break;
    const json = parseJsonSafe(frame.data);
    if (!json) continue;
    if (json.error) throw new UpstreamError(json.error.message ?? "Upstream stream error", { status: 502 });
    if (json.usage) usage = usageFromOpenAI(json.usage);
    const choice = json.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const reasoning = extractReasoning(delta);
    if (reasoning) yield { type: "reasoning_delta", text: reasoning };
    const content = extractText(delta.content);
    if (content) yield { type: "text_delta", text: content };

    for (const rawTool of delta.tool_calls ?? []) {
      const index = rawTool.index ?? 0;
      let state = tools.get(index);
      if (!state) {
        state = { id: rawTool.id, name: "", started: false };
        tools.set(index, state);
      }
      if (rawTool.id) state.id = rawTool.id;
      if (rawTool.function?.name) state.name += rawTool.function.name;
      const args = rawTool.function?.arguments ?? "";
      // Some OpenAI-compatible providers split a function name across several
      // SSE frames. Wait until arguments start (or the stream ends) before
      // emitting tool_start so the bridge never locks in a partial name.
      if (!state.started && args) {
        state.started = true;
        yield { type: "tool_start", index, id: state.id, name: state.name || "tool" };
      }
      if (args) yield { type: "tool_delta", index, arguments: args };
    }
  }
  for (const [index, state] of tools) {
    if (!state.started) yield { type: "tool_start", index, id: state.id, name: state.name || "tool" };
    yield { type: "tool_end", index };
  }
  yield { type: "done", usage, stopReason: finishReason };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
}

function extractReasoning(message) {
  const value = message?.reasoning_content ?? message?.reasoning ?? message?.thinking;
  return typeof value === "string" ? value : "";
}

function filterAllowedTools(tools = [], choice) {
  if (choice?.type !== "allowed_tools") return tools;
  const allowed = new Set(choice.names);
  return tools.filter((tool) => allowed.has(tool.name) || allowed.has(tool.originalName));
}
