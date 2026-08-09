import { RequestError } from "../errors.mjs";
import { COMPACT_PROMPT, compactionItemToText } from "./compaction.mjs";

const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);

function wireToolName(name, namespace) {
  return namespace ? `${namespace}__${name}` : name;
}

export function parseResponsesRequest(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("Request body must be a JSON object");
  }

  const warnings = [];
  const model = typeof body.model === "string" && body.model ? body.model : options.defaultModel;
  if (!model) throw new RequestError("model is required");

  const parsedInput = parseInput(body.input, warnings);
  let messages = parsedInput.messages;
  const previousResponseId = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  if (previousResponseId && options.continuationStore) {
    const prior = options.continuationStore.get(previousResponseId);
    if (prior?.messages) messages = [...prior.messages, ...messages];
    else warnings.push(`previous_response_id '${previousResponseId}' was not found in local memory`);
  }

  const instructions = normalizeInstructions(body.instructions);
  if (parsedInput.compactionRequest) instructions.unshift(COMPACT_PROMPT);
  if (instructions.length) {
    messages = [
      ...instructions.map((text) => ({ role: "system", content: [{ type: "text", text }] })),
      ...messages,
    ];
  }

  messages = resolveToolResultNames(messages);

  const toolsResult = parseTools(body.tools, warnings);
  const toolChoice = parseToolChoice(body.tool_choice, toolsResult.tools);
  const textFormat = parseTextFormat(body.text?.format);

  return {
    model,
    stream: body.stream !== false,
    previousResponseId,
    messages,
    tools: toolsResult.tools,
    toolMetadata: toolsResult.metadata,
    toolChoice,
    parallelToolCalls: body.parallel_tool_calls,
    maxOutputTokens: positiveInteger(body.max_output_tokens),
    temperature: finiteNumber(body.temperature),
    topP: finiteNumber(body.top_p),
    reasoningEffort: typeof body.reasoning?.effort === "string" ? body.reasoning.effort : undefined,
    serviceTier: typeof body.service_tier === "string" ? body.service_tier : undefined,
    textFormat,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
    store: body.store !== false,
    compactionRequest: parsedInput.compactionRequest,
    raw: body,
    warnings,
  };
}


function resolveToolResultNames(messages) {
  const calls = new Map();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const tool of message.toolCalls ?? []) {
        calls.set(tool.id, {
          name: tool.name,
          kind: tool.kind ?? "function",
          execution: tool.execution,
        });
      }
    } else if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (!message.toolName) message.toolName = call?.name;
      if (!message.toolKind) message.toolKind = call?.kind;
      if (!message.execution) message.execution = call?.execution;
    }
  }
  return messages;
}

function normalizeInstructions(value) {
  if (typeof value === "string" && value.trim()) return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === "string") return part.trim() ? [part] : [];
    if (part?.type === "input_text" && typeof part.text === "string") return [part.text];
    return [];
  });
}

function parseInput(input, warnings) {
  if (typeof input === "string") {
    return { messages: [{ role: "user", content: [{ type: "text", text: input }] }], compactionRequest: false };
  }
  if (input == null) return { messages: [], compactionRequest: false };
  if (!Array.isArray(input)) throw new RequestError("input must be a string or array");

  const messages = [];
  let compactionRequest = false;
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: [{ type: "text", text: item }] });
      continue;
    }
    if (!item || typeof item !== "object") throw new RequestError("input items must be objects or strings");

    const type = item.type;
    if (type === "message" || (MESSAGE_ROLES.has(item.role) && item.content !== undefined)) {
      const role = MESSAGE_ROLES.has(item.role) ? item.role : "user";
      messages.push({ role, content: parseContent(item.content, role, warnings) });
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const originalName = item.name;
      if (typeof originalName !== "string" || !originalName) throw new RequestError(`${type}.name is required`);
      const namespace = typeof item.namespace === "string" && item.namespace ? item.namespace : undefined;
      const rawArguments = item.arguments ?? item.input ?? "{}";
      messages.push({
        role: "assistant",
        content: [],
        toolCalls: [{
          id: item.call_id ?? item.id ?? `call_${messages.length}`,
          name: wireToolName(originalName, namespace),
          originalName,
          arguments: normalizeArgumentsString(rawArguments),
          kind: type === "custom_tool_call" ? "custom" : "function",
          namespace,
        }],
      });
      continue;
    }
    if (type === "tool_search_call") {
      const originalName = typeof item.name === "string" && item.name ? item.name : "tool_search";
      messages.push({
        role: "assistant",
        content: [],
        toolCalls: [{
          id: item.call_id ?? item.id ?? `call_${messages.length}`,
          name: originalName,
          originalName,
          arguments: normalizeArgumentsString(item.arguments ?? {}),
          kind: "tool_search",
          execution: typeof item.execution === "string" ? item.execution : "client",
        }],
      });
      continue;
    }
    if (type === "tool_search_output" || type === "tool_search_call_output") {
      const tools = Array.isArray(item.tools) ? item.tools : [];
      messages.push({
        role: "tool",
        toolCallId: item.call_id ?? item.id,
        toolName: "tool_search",
        toolKind: "tool_search",
        execution: typeof item.execution === "string" ? item.execution : "client",
        toolSearchTools: structuredClone(tools),
        content: [{ type: "text", text: JSON.stringify(tools) }],
        isError: item.status === "failed" || Boolean(item.is_error),
      });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        toolCallId: item.call_id ?? item.id,
        toolName: item.name,
        toolKind: type === "custom_tool_call_output" ? "custom" : "function",
        content: parseContent(item.output ?? item.content ?? "", "tool", warnings),
        isError: Boolean(item.is_error),
      });
      continue;
    }
    if (type === "compaction_trigger") {
      compactionRequest = true;
      continue;
    }
    if (["compaction", "context_compaction", "compaction_summary"].includes(type)) {
      messages.push({ role: "user", content: [{ type: "text", text: compactionItemToText(item.encrypted_content) }] });
      continue;
    }
    if (type === "reasoning") {
      warnings.push(`Ignored replay-only input item type '${type}'`);
      continue;
    }
    if (type === "input_text") {
      messages.push({ role: "user", content: [{ type: "text", text: String(item.text ?? "") }] });
      continue;
    }
    warnings.push(`Ignored unsupported input item type '${type ?? "unknown"}'`);
  }
  return { messages, compactionRequest };
}

function parseContent(content, role, warnings) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content == null) return [];
  if (!Array.isArray(content)) {
    if (typeof content === "object" && typeof content.text === "string") return [{ type: "text", text: content.text }];
    return [{ type: "text", text: JSON.stringify(content) }];
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type) || typeof part.text === "string") {
      parts.push({ type: "text", text: String(part.text ?? "") });
      continue;
    }
    if (["input_image", "image_url", "image"].includes(part.type)) {
      const imageUrl = part.image_url?.url ?? part.image_url ?? part.url ?? part.source?.url;
      if (typeof imageUrl === "string" && imageUrl) {
        parts.push({ type: "image", url: imageUrl, detail: part.detail ?? part.image_url?.detail });
      } else {
        warnings.push(`Ignored image content without URL in ${role} message`);
      }
      continue;
    }
    if (part.type === "refusal") {
      parts.push({ type: "text", text: String(part.refusal ?? "") });
      continue;
    }
    warnings.push(`Ignored unsupported content part '${part.type ?? "unknown"}'`);
  }
  return parts;
}

function parseTools(tools, warnings) {
  if (tools == null) return { tools: [], metadata: new Map() };
  if (!Array.isArray(tools)) throw new RequestError("tools must be an array");
  const output = [];
  const metadata = new Map();

  const addTool = (tool, namespace) => {
    const kind = tool.type === "custom" ? "custom" : tool.type === "tool_search" ? "tool_search" : "function";
    const name = tool.name ?? tool.function?.name ?? (kind === "tool_search" ? "tool_search" : undefined);
    if (typeof name !== "string" || !name) throw new RequestError("Tool name is required");
    const wireName = wireToolName(name, namespace);
    if (metadata.has(wireName)) throw new RequestError(`Duplicate tool wire name '${wireName}'`);
    let parameters = tool.parameters ?? tool.function?.parameters ?? { type: "object", properties: {} };
    if (kind === "custom") {
      parameters = {
        type: "object",
        properties: { input: { type: "string", description: tool.description ?? "Freeform tool input" } },
        required: ["input"],
        additionalProperties: false,
      };
    }
    const normalized = {
      name: wireName,
      originalName: name,
      namespace,
      description: tool.description ?? tool.function?.description ?? "",
      parameters,
      strict: tool.strict ?? tool.function?.strict,
      kind,
      ...(kind === "tool_search" ? { execution: typeof tool.execution === "string" ? tool.execution : "client" } : {}),
    };
    output.push(normalized);
    metadata.set(wireName, normalized);
  };

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") throw new RequestError("Tool definitions must be objects");
    if (tool.type === "function" || tool.type === "custom" || tool.type === "tool_search" || tool.function) {
      addTool(tool);
      continue;
    }
    if (tool.type === "namespace") {
      const namespace = tool.name ?? tool.namespace;
      if (typeof namespace !== "string" || !namespace) throw new RequestError("Namespace tool requires name");
      if (!Array.isArray(tool.tools)) throw new RequestError(`Namespace '${namespace}' requires tools array`);
      for (const nested of tool.tools) addTool(nested, namespace);
      continue;
    }
    warnings.push(`Dropped hosted or unsupported tool '${tool.type ?? "unknown"}'`);
  }
  return { tools: output, metadata };
}

function parseToolChoice(choice, tools) {
  if (choice == null) return undefined;
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (typeof choice !== "object") throw new RequestError("tool_choice is invalid");
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    return {
      type: "allowed_tools",
      mode: choice.mode === "required" ? "required" : "auto",
      names: choice.tools.map((tool) => {
        if (typeof tool === "string") return resolveToolReference(tool, undefined, tools);
        if (!tool || typeof tool !== "object") return undefined;
        const name = tool.name ?? tool.function?.name;
        return name ? resolveToolReference(name, tool.namespace, tools) : undefined;
      }).filter(Boolean),
    };
  }
  const name = choice.name ?? choice.function?.name;
  if (name) {
    return { type: "function", name: resolveToolReference(name, choice.namespace, tools) };
  }
  throw new RequestError("Unsupported tool_choice shape");
}

function resolveToolReference(name, namespace, tools) {
  if (typeof name !== "string" || !name) throw new RequestError("Tool choice name is required");
  if (typeof namespace === "string" && namespace) {
    const match = tools.find((tool) => tool.namespace === namespace && (tool.originalName === name || tool.name === name));
    return match?.name ?? wireToolName(name, namespace);
  }
  const exact = tools.find((tool) => tool.name === name);
  if (exact) return exact.name;
  const matches = tools.filter((tool) => tool.originalName === name);
  if (matches.length > 1) {
    throw new RequestError(`Tool choice '${name}' is ambiguous; use the namespace or flattened wire name`);
  }
  return matches[0]?.name ?? name;
}

function parseTextFormat(format) {
  if (!format || typeof format !== "object") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      name: format.name ?? "response",
      description: format.description,
      schema: format.schema ?? {},
      strict: format.strict ?? true,
    };
  }
  return undefined;
}

function normalizeArgumentsString(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

export function canonicalMessagesForContinuation(request, response) {
  const messages = structuredClone(request.messages);
  if (response.outputText || response.toolCalls?.length) {
    messages.push({
      role: "assistant",
      content: response.outputText ? [{ type: "text", text: response.outputText }] : [],
      toolCalls: (response.toolCalls ?? []).map((tool) => ({
        id: tool.call_id,
        name: tool.wire_name ?? tool.name,
        originalName: tool.name,
        arguments: tool.arguments,
        kind: tool.kind ?? "function",
        namespace: tool.namespace,
        execution: tool.execution,
      })),
    });
  }
  return messages;
}
