import { UpstreamError } from "../errors.mjs";
import { createId } from "../utils/crypto.mjs";
import { parseSse } from "../utils/sse.mjs";
import { fetchWithRetry, joinUrl, parseJsonSafe, providerHeaders, stringifyToolResult } from "./common.mjs";

export async function prepareGemini(candidate, request, context) {
  const { headers, apiKey } = providerHeaders(candidate, context.env, {
    accept: request.stream ? "text/event-stream" : "application/json",
  });
  if (apiKey) headers["x-goog-api-key"] = apiKey;
  const body = buildGeminiBody(candidate, request);
  const action = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const path = candidate.provider.generatePath
    ? candidate.provider.generatePath.replace("{model}", encodeURIComponent(candidate.upstreamModel)).replace("{action}", action)
    : `models/${encodeURIComponent(candidate.upstreamModel)}:${action}`;
  const url = joinUrl(candidate.provider.baseUrl, path);
  const response = await fetchWithRetry(candidate, url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { signal: context.signal, timeoutMs: context.timeoutMs });
  return { events: request.stream ? parseGeminiStream(response) : parseGeminiJson(response) };
}

export function buildGeminiBody(candidate, request) {
  const { systemInstruction, contents } = toGeminiContents(request.messages, candidate.provider);
  const body = { contents };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  const effectiveTools = filterAllowedTools(request.tools, request.toolChoice);
  if (effectiveTools.length) {
    body.tools = [{
      functionDeclarations: effectiveTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }];
  }
  const toolConfig = effectiveTools.length ? toGeminiToolConfig(request.toolChoice, effectiveTools) : undefined;
  if (toolConfig) body.toolConfig = { functionCallingConfig: toolConfig };
  const generationConfig = {};
  if (request.maxOutputTokens) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature != null) generationConfig.temperature = request.temperature;
  if (request.topP != null) generationConfig.topP = request.topP;
  if (request.textFormat?.type === "json_object") generationConfig.responseMimeType = "application/json";
  if (request.textFormat?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = request.textFormat.schema;
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (request.reasoningEffort && candidate.provider.enableThinking !== false) {
    const budget = candidate.provider.thinkingBudgets?.[request.reasoningEffort]
      ?? { minimal: 256, low: 1_024, medium: 4_096, high: 8_192, xhigh: 16_384, max: 24_576 }[request.reasoningEffort];
    if (budget != null) {
      body.generationConfig ??= {};
      body.generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
    }
  }
  return body;
}

function toGeminiContents(messages, provider) {
  const system = [];
  const contents = [];
  const push = (role, parts) => {
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = stringifyToolResult(message.content);
      if (text) system.push(text);
      continue;
    }
    if (message.role === "tool") {
      push("user", [{
        functionResponse: {
          name: message.toolName ?? "tool",
          response: { output: stringifyToolResult(message.content), is_error: Boolean(message.isError) },
        },
      }]);
      continue;
    }
    if (message.role === "user") {
      push("user", toGeminiParts(message.content, provider));
      continue;
    }
    if (message.role === "assistant") {
      const parts = toGeminiParts(message.content, provider);
      for (const tool of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: tool.name, args: parseArguments(tool.arguments) } });
      }
      push("model", parts.length ? parts : [{ text: "" }]);
    }
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "" }] });
  return { systemInstruction: system.join("\n\n"), contents };
}

function toGeminiParts(parts = [], provider) {
  return parts.flatMap((part) => {
    if (part.type === "text") return [{ text: part.text ?? "" }];
    if (part.type !== "image") return [];
    const data = parseDataUrl(part.url);
    if (data) return [{ inlineData: { mimeType: data.mediaType, data: data.data } }];
    if (/^https:\/\//i.test(part.url) && provider.remoteImageSource === true) {
      return [{ fileData: { mimeType: "application/octet-stream", fileUri: part.url } }];
    }
    return [{ text: `[image omitted: ${part.url}]` }];
  });
}

function toGeminiToolConfig(choice, effectiveTools = []) {
  if (choice == null || choice === "auto") return { mode: "AUTO" };
  if (choice === "none") return { mode: "NONE" };
  if (choice === "required") return { mode: "ANY" };
  if (choice.type === "function") return { mode: "ANY", allowedFunctionNames: [choice.name] };
  if (choice.type === "allowed_tools") return {
    mode: choice.mode === "required" ? "ANY" : "AUTO",
    allowedFunctionNames: effectiveTools.map((tool) => tool.name),
  };
  return undefined;
}

async function* parseGeminiJson(response) {
  const text = await response.text();
  const json = parseJsonSafe(text);
  if (!json) throw new UpstreamError("Gemini returned invalid JSON", { status: 502 });
  yield* geminiObjectEvents(json);
}

async function* parseGeminiStream(response) {
  let usage;
  let finishReason;
  let toolIndex = 0;
  for await (const frame of parseSse(response.body)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    const json = parseJsonSafe(frame.data);
    if (!json) continue;
    if (json.error) {
      yield { type: "error", message: json.error.message ?? "Gemini stream error", code: json.error.status };
      return;
    }
    const result = eventsForGeminiChunk(json, toolIndex);
    toolIndex = result.nextToolIndex;
    usage = geminiUsage(json.usageMetadata) ?? usage;
    finishReason = json.candidates?.[0]?.finishReason ?? finishReason;
    for (const event of result.events) yield event;
  }
  yield { type: "done", usage, stopReason: finishReason };
}

function* geminiObjectEvents(json) {
  if (json.error) {
    yield { type: "error", message: json.error.message ?? "Gemini error", code: json.error.status };
    return;
  }
  if (json.promptFeedback?.blockReason) {
    yield { type: "error", message: `Gemini blocked prompt: ${json.promptFeedback.blockReason}`, code: "prompt_blocked" };
    return;
  }
  const result = eventsForGeminiChunk(json, 0);
  for (const event of result.events) yield event;
  yield { type: "done", usage: geminiUsage(json.usageMetadata), stopReason: json.candidates?.[0]?.finishReason };
}

function eventsForGeminiChunk(json, initialToolIndex) {
  const events = [];
  let toolIndex = initialToolIndex;
  for (const candidate of json.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        events.push(part.thought ? { type: "reasoning_delta", text: part.text } : { type: "text_delta", text: part.text });
      }
      if (part.functionCall) {
        const index = toolIndex++;
        events.push({ type: "tool_start", index, id: part.functionCall.id ?? createId("call"), name: part.functionCall.name ?? "tool" });
        events.push({ type: "tool_delta", index, arguments: JSON.stringify(part.functionCall.args ?? {}) });
        events.push({ type: "tool_end", index });
      }
    }
  }
  return { events, nextToolIndex: toolIndex };
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    return { input: String(value ?? "") };
  }
}

function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url));
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function geminiUsage(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokenCount ?? 0,
    output_tokens: usage.candidatesTokenCount ?? 0,
    total_tokens: usage.totalTokenCount,
    cached_input_tokens: usage.cachedContentTokenCount ?? 0,
    reasoning_tokens: usage.thoughtsTokenCount ?? 0,
  };
}

function filterAllowedTools(tools = [], choice) {
  if (choice?.type !== "allowed_tools") return tools;
  const allowed = new Set(choice.names);
  return tools.filter((tool) => allowed.has(tool.name) || allowed.has(tool.originalName));
}
