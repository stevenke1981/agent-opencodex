import { UpstreamError } from "../errors.mjs";
import { parseSse } from "../utils/sse.mjs";
import { fetchWithRetry, joinUrl, parseJsonSafe, providerHeaders } from "./common.mjs";

export async function prepareOpenAIResponses(candidate, request, context) {
  const { headers, apiKey } = providerHeaders(candidate, context.env, { accept: request.stream ? "text/event-stream" : "application/json" });
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = structuredClone(request.raw);
  body.model = candidate.upstreamModel;
  body.stream = request.stream;
  if (request.previousResponseId || request.compactionRequest) {
    body.input = toResponsesInput(request.messages);
    delete body.instructions;
  }
  if (request.compactionRequest) {
    body.tools = [];
    body.tool_choice = "none";
  }
  delete body.previous_response_id;
  const url = joinUrl(candidate.provider.baseUrl, candidate.provider.responsesPath ?? "responses");
  const response = await fetchWithRetry(candidate, url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { signal: context.signal, timeoutMs: context.timeoutMs });
  return { events: request.stream ? parseResponsesStream(response) : parseResponsesJson(response) };
}

async function* parseResponsesJson(response) {
  const text = await response.text();
  const json = parseJsonSafe(text);
  if (!json) throw new UpstreamError("Responses provider returned invalid JSON", { status: 502 });
  yield* eventsFromResponseObject(json);
}

async function* parseResponsesStream(response) {
  const openTools = new Map();
  let usage;
  for await (const frame of parseSse(response.body)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    const event = parseJsonSafe(frame.data);
    if (!event) continue;
    const type = event.type ?? frame.event;
    if (type === "response.output_text.delta") yield { type: "text_delta", text: event.delta ?? "" };
    else if (type === "response.reasoning_summary_text.delta") yield { type: "reasoning_delta", text: event.delta ?? "" };
    else if (type === "response.output_item.added" && ["function_call", "custom_tool_call"].includes(event.item?.type)) {
      const index = event.output_index ?? openTools.size;
      openTools.set(event.item.id, { index, argumentsSeen: false });
      yield { type: "tool_start", index, id: event.item.call_id, name: event.item.name, kind: event.item.type === "custom_tool_call" ? "custom" : "function" };
    } else if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
      const state = openTools.get(event.item_id);
      const index = event.output_index ?? state?.index ?? 0;
      if (state) state.argumentsSeen = true;
      yield { type: "tool_delta", index, arguments: event.delta ?? "" };
    } else if (type === "response.output_item.done" && ["function_call", "custom_tool_call"].includes(event.item?.type)) {
      const state = openTools.get(event.item.id);
      const index = event.output_index ?? state?.index ?? 0;
      if (!state) {
        yield { type: "tool_start", index, id: event.item.call_id, name: event.item.name, kind: event.item.type === "custom_tool_call" ? "custom" : "function" };
      }
      if (!state?.argumentsSeen) {
        const args = event.item.type === "custom_tool_call"
          ? JSON.stringify({ input: event.item.input ?? "" })
          : event.item.arguments ?? "{}";
        yield { type: "tool_delta", index, arguments: typeof args === "string" ? args : JSON.stringify(args) };
      }
      yield { type: "tool_end", index };
    } else if (type === "response.output_item.done" && event.item?.type === "tool_search_call") {
      const index = event.output_index ?? openTools.size;
      yield {
        type: "tool_start",
        index,
        id: event.item.call_id,
        name: "tool_search",
        kind: "tool_search",
        execution: event.item.execution ?? "client",
      };
      yield { type: "tool_delta", index, arguments: JSON.stringify(argumentsObject(event.item.arguments)) };
      yield { type: "tool_end", index };
    } else if (type === "response.completed") {
      usage = event.response?.usage;
    } else if (type === "error") {
      yield { type: "error", message: event.error?.message ?? event.message ?? "Responses upstream error", code: event.error?.code ?? event.code };
      return;
    } else if (type === "response.failed") {
      yield { type: "error", message: event.response?.error?.message ?? "Responses upstream failed", code: event.response?.error?.code };
      return;
    } else if (type === "response.incomplete") {
      yield { type: "incomplete", reason: event.response?.incomplete_details?.reason ?? "upstream_incomplete", usage: event.response?.usage };
      return;
    }
  }
  yield { type: "done", usage };
}

function* eventsFromResponseObject(response) {
  let toolIndex = 0;
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) if (part.type === "output_text" && part.text) yield { type: "text_delta", text: part.text };
    } else if (item.type === "reasoning") {
      for (const part of item.summary ?? []) if (part.text) yield { type: "reasoning_delta", text: part.text };
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const index = toolIndex++;
      yield { type: "tool_start", index, id: item.call_id, name: item.name, kind: item.type === "custom_tool_call" ? "custom" : "function" };
      const args = item.type === "custom_tool_call" ? JSON.stringify({ input: item.input ?? "" }) : item.arguments ?? "{}";
      yield { type: "tool_delta", index, arguments: typeof args === "string" ? args : JSON.stringify(args) };
      yield { type: "tool_end", index };
    } else if (item.type === "tool_search_call") {
      const index = toolIndex++;
      yield { type: "tool_start", index, id: item.call_id, name: "tool_search", kind: "tool_search", execution: item.execution ?? "client" };
      yield { type: "tool_delta", index, arguments: JSON.stringify(argumentsObject(item.arguments)) };
      yield { type: "tool_end", index };
    }
  }
  if (response.status === "failed") yield { type: "error", message: response.error?.message ?? "Responses upstream failed", code: response.error?.code };
  else if (response.status === "incomplete") yield { type: "incomplete", reason: response.incomplete_details?.reason ?? "upstream_incomplete", usage: response.usage };
  else yield { type: "done", usage: response.usage };
}


export function toResponsesInput(messages) {
  const output = [];
  const callKinds = new Map();
  for (const message of messages) {
    if (message.role === "tool") {
      const call = callKinds.get(message.toolCallId) ?? {
        kind: message.toolKind ?? "function",
        execution: message.execution,
      };
      if (call.kind === "tool_search") {
        output.push({
          type: "tool_search_output",
          call_id: message.toolCallId,
          status: message.isError ? "failed" : "completed",
          execution: message.execution ?? call.execution ?? "client",
          tools: toolSearchTools(message),
        });
      } else {
        output.push({
          type: call.kind === "custom" ? "custom_tool_call_output" : "function_call_output",
          call_id: message.toolCallId,
          output: stringifyContent(message.content),
        });
      }
      continue;
    }
    const content = (message.content ?? []).flatMap((part) => {
      if (part.type === "image") return [{ type: "input_image", image_url: part.url, ...(part.detail ? { detail: part.detail } : {}) }];
      return [{ type: message.role === "assistant" ? "output_text" : "input_text", text: part.text ?? "" }];
    });
    if (content.length) output.push({ type: "message", role: message.role, content });
    for (const tool of message.toolCalls ?? []) {
      const kind = tool.kind ?? "function";
      callKinds.set(tool.id, { kind, execution: tool.execution });
      if (kind === "custom") {
        output.push({
          type: "custom_tool_call",
          call_id: tool.id,
          name: tool.originalName ?? tool.name,
          input: customInput(tool.arguments),
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
        });
      } else if (kind === "tool_search") {
        output.push({
          type: "tool_search_call",
          call_id: tool.id,
          status: "completed",
          execution: tool.execution ?? "client",
          arguments: argumentsObject(tool.arguments),
        });
      } else {
        output.push({
          type: "function_call",
          call_id: tool.id,
          name: tool.originalName ?? tool.name,
          arguments: tool.arguments ?? "{}",
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
        });
      }
    }
  }
  return output;
}

function argumentsObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { query: String(value ?? "") };
  }
}

function toolSearchTools(message) {
  if (Array.isArray(message.toolSearchTools)) return structuredClone(message.toolSearchTools);
  const text = stringifyContent(message.content);
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringifyContent(parts) {
  if (!Array.isArray(parts)) return String(parts ?? "");
  return parts.map((part) => part.type === "text" ? part.text ?? "" : `[image: ${part.url}]`).join("\n");
}

function customInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText ?? "{}");
    return typeof parsed?.input === "string" ? parsed.input : JSON.stringify(parsed);
  } catch {
    return String(argumentsText ?? "");
  }
}
