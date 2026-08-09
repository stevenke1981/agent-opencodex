import { createId } from "../utils/crypto.mjs";
import { encodeSse } from "../utils/sse.mjs";
import { encodeCompactionSummary } from "./compaction.mjs";

export class ResponsesBridge {
  constructor(options = {}) {
    this.id = options.responseId ?? createId("resp");
    this.model = options.model ?? "unknown";
    this.createdAt = Math.floor(Date.now() / 1000);
    this.toolMetadata = options.toolMetadata ?? new Map();
    this.compaction = Boolean(options.compaction);
    this.compactionText = "";
    this.sequence = 0;
    this.output = [];
    this.textState = null;
    this.reasoningState = null;
    this.toolStates = new Map();
    this.usage = undefined;
    this.status = "in_progress";
    this.error = undefined;
    this.incompleteDetails = undefined;
  }

  baseResponse() {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status: this.status,
      model: this.model,
      output: structuredClone(this.output),
      parallel_tool_calls: true,
      tool_choice: "auto",
      ...(this.usage ? { usage: normalizeUsage(this.usage) } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.incompleteDetails ? { incomplete_details: this.incompleteDetails } : {}),
    };
  }

  createdEvent() {
    return this.wrap("response.created", { response: this.baseResponse() });
  }

  accept(event) {
    if (this.status !== "in_progress" && event.type !== "heartbeat") return [];
    switch (event.type) {
      case "heartbeat":
        return [this.wrap("response.heartbeat", { response_id: this.id })];
      case "text_delta":
        return this.acceptText(event.text ?? "");
      case "reasoning_delta":
      case "thinking_delta":
        return this.acceptReasoning(event.text ?? event.thinking ?? "");
      case "tool_start":
      case "tool_call_start":
        return this.startTool(event);
      case "tool_delta":
      case "tool_call_delta":
        return this.deltaTool(event);
      case "tool_end":
      case "tool_call_end":
        return this.endTool(event);
      case "done":
        return this.complete(event);
      case "incomplete":
        return this.incomplete(event);
      case "error":
        return this.fail(event);
      default:
        return [];
    }
  }

  acceptText(text) {
    if (!text) return [];
    if (this.compaction) {
      this.compactionText += text;
      return [];
    }
    const events = [];
    if (!this.textState) {
      const item = {
        id: createId("msg"),
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      const outputIndex = this.output.length;
      this.output.push(item);
      this.textState = { item, outputIndex, text: "", contentIndex: 0, closed: false };
      events.push(this.wrap("response.output_item.added", {
        output_index: outputIndex,
        item: structuredClone(item),
      }));
      const part = { type: "output_text", text: "", annotations: [] };
      item.content.push(part);
      events.push(this.wrap("response.content_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: structuredClone(part),
      }));
    }
    this.textState.text += text;
    this.textState.item.content[0].text = this.textState.text;
    events.push(this.wrap("response.output_text.delta", {
      item_id: this.textState.item.id,
      output_index: this.textState.outputIndex,
      content_index: 0,
      delta: text,
      logprobs: [],
    }));
    return events;
  }

  acceptReasoning(text) {
    if (!text || this.compaction) return [];
    const events = [];
    if (!this.reasoningState) {
      const item = {
        id: createId("rs"),
        type: "reasoning",
        status: "in_progress",
        summary: [{ type: "summary_text", text: "" }],
      };
      const outputIndex = this.output.length;
      this.output.push(item);
      this.reasoningState = { item, outputIndex, text: "", closed: false };
      events.push(this.wrap("response.output_item.added", {
        output_index: outputIndex,
        item: structuredClone(item),
      }));
      events.push(this.wrap("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }));
    }
    this.reasoningState.text += text;
    this.reasoningState.item.summary[0].text = this.reasoningState.text;
    events.push(this.wrap("response.reasoning_summary_text.delta", {
      item_id: this.reasoningState.item.id,
      output_index: this.reasoningState.outputIndex,
      summary_index: 0,
      delta: text,
    }));
    return events;
  }

  startTool(event) {
    if (this.compaction) return this.fail({ message: "Compaction model attempted a tool call", code: "compaction_tool_call" });
    const index = Number.isInteger(event.index) ? event.index : this.toolStates.size;
    if (this.toolStates.has(index)) return [];
    const wireName = event.name ?? "tool";
    const metadata = this.toolMetadata.get?.(wireName) ?? {};
    const kind = event.kind ?? metadata.kind ?? "function";
    const itemId = createId(kind === "custom" ? "ct" : kind === "tool_search" ? "tsc" : "fc");
    const callId = event.id ?? createId("call");
    const outputIndex = this.output.length;
    const item = kind === "custom"
      ? {
          id: itemId,
          type: "custom_tool_call",
          status: "in_progress",
          call_id: callId,
          name: metadata.originalName ?? wireName,
          input: "",
          ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
        }
      : kind === "tool_search"
        ? {
            id: itemId,
            type: "tool_search_call",
            status: "in_progress",
            call_id: callId,
            execution: event.execution ?? metadata.execution ?? "client",
            arguments: {},
          }
        : {
            id: itemId,
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: metadata.originalName ?? wireName,
            arguments: "",
            ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
          };
    this.output.push(item);
    this.toolStates.set(index, {
      index,
      item,
      outputIndex,
      arguments: "",
      wireName,
      kind,
      closed: false,
    });
    return [this.wrap("response.output_item.added", {
      output_index: outputIndex,
      item: structuredClone(item),
    })];
  }

  deltaTool(event) {
    if (this.compaction) return [];
    const index = Number.isInteger(event.index) ? event.index : Math.max(0, this.toolStates.size - 1);
    const events = [];
    if (!this.toolStates.has(index)) {
      events.push(...this.startTool({
        index,
        id: event.id,
        name: event.name ?? "tool",
        kind: event.kind,
        execution: event.execution,
      }));
    }
    const state = this.toolStates.get(index);
    if (!state) return events;
    const delta = String(event.arguments ?? event.delta ?? "");
    if (!delta) return events;
    state.arguments += delta;
    if (state.kind === "tool_search") return events;
    if (state.kind === "custom") state.item.input = customInputFromArguments(state.arguments, false);
    else state.item.arguments = state.arguments;
    const eventName = state.kind === "custom"
      ? "response.custom_tool_call_input.delta"
      : "response.function_call_arguments.delta";
    events.push(this.wrap(eventName, {
      item_id: state.item.id,
      output_index: state.outputIndex,
      delta,
    }));
    return events;
  }

  endTool(event) {
    if (this.compaction) return [];
    const index = Number.isInteger(event.index) ? event.index : Math.max(0, this.toolStates.size - 1);
    const state = this.toolStates.get(index);
    if (!state || state.closed) return [];
    state.closed = true;
    state.item.status = "completed";
    if (state.kind === "tool_search") {
      state.item.arguments = argumentsObject(state.arguments);
      return [this.wrap("response.output_item.done", {
        output_index: state.outputIndex,
        item: structuredClone(state.item),
      })];
    }
    if (state.kind === "custom") state.item.input = customInputFromArguments(state.arguments, true);
    else state.item.arguments = state.arguments || "{}";
    const eventName = state.kind === "custom"
      ? "response.custom_tool_call_input.done"
      : "response.function_call_arguments.done";
    return [
      this.wrap(eventName, {
        item_id: state.item.id,
        output_index: state.outputIndex,
        ...(state.kind === "custom" ? { input: state.item.input } : { arguments: state.item.arguments }),
      }),
      this.wrap("response.output_item.done", {
        output_index: state.outputIndex,
        item: structuredClone(state.item),
      }),
    ];
  }

  closeText() {
    const state = this.textState;
    if (!state || state.closed) return [];
    state.closed = true;
    state.item.status = "completed";
    const part = structuredClone(state.item.content[0]);
    return [
      this.wrap("response.output_text.done", {
        item_id: state.item.id,
        output_index: state.outputIndex,
        content_index: 0,
        text: state.text,
        logprobs: [],
      }),
      this.wrap("response.content_part.done", {
        item_id: state.item.id,
        output_index: state.outputIndex,
        content_index: 0,
        part,
      }),
      this.wrap("response.output_item.done", {
        output_index: state.outputIndex,
        item: structuredClone(state.item),
      }),
    ];
  }

  closeReasoning() {
    const state = this.reasoningState;
    if (!state || state.closed) return [];
    state.closed = true;
    state.item.status = "completed";
    return [
      this.wrap("response.reasoning_summary_text.done", {
        item_id: state.item.id,
        output_index: state.outputIndex,
        summary_index: 0,
        text: state.text,
      }),
      this.wrap("response.reasoning_summary_part.done", {
        item_id: state.item.id,
        output_index: state.outputIndex,
        summary_index: 0,
        part: structuredClone(state.item.summary[0]),
      }),
      this.wrap("response.output_item.done", {
        output_index: state.outputIndex,
        item: structuredClone(state.item),
      }),
    ];
  }

  closeAllOutput() {
    const events = [...this.closeReasoning(), ...this.closeText()];
    for (const [index] of this.toolStates) events.push(...this.endTool({ index }));
    return events;
  }

  complete(event = {}) {
    const events = this.closeAllOutput();
    this.status = "completed";
    this.usage = event.usage;
    if (this.compaction) {
      const item = {
        id: createId("cmp"),
        type: "compaction",
        encrypted_content: encodeCompactionSummary(this.compactionText.trim() || "(no summary available)"),
      };
      const outputIndex = this.output.length;
      this.output.push(item);
      events.push(this.wrap("response.output_item.added", { output_index: outputIndex, item: structuredClone(item) }));
      events.push(this.wrap("response.output_item.done", { output_index: outputIndex, item: structuredClone(item) }));
    }
    events.push(this.wrap("response.completed", { response: this.baseResponse() }));
    return events;
  }

  incomplete(event = {}) {
    const events = this.closeAllOutput();
    this.status = "incomplete";
    this.usage = event.usage;
    this.incompleteDetails = { reason: event.reason ?? "upstream_incomplete" };
    events.push(this.wrap("response.incomplete", { response: this.baseResponse() }));
    return events;
  }

  fail(event = {}) {
    const events = this.closeAllOutput();
    this.status = "failed";
    this.usage = event.usage;
    this.error = {
      code: event.code ?? "upstream_error",
      message: event.message ?? "Upstream provider failed",
      type: event.errorType ?? "upstream_error",
    };
    events.push(this.wrap("response.failed", { response: this.baseResponse() }));
    return events;
  }

  wrap(type, fields) {
    return {
      name: type,
      payload: {
        type,
        sequence_number: this.sequence++,
        ...fields,
      },
    };
  }

  toResponseJson() {
    return this.baseResponse();
  }

  summary() {
    return {
      id: this.id,
      status: this.status,
      outputText: this.compaction ? this.compactionText : this.textState?.text ?? "",
      reasoningText: this.reasoningState?.text ?? "",
      toolCalls: [...this.toolStates.values()].map((state) => ({
        id: state.item.id,
        call_id: state.item.call_id,
        name: state.kind === "tool_search" ? "tool_search" : state.item.name,
        wire_name: state.wireName,
        namespace: state.item.namespace,
        kind: state.kind,
        execution: state.item.execution,
        arguments: state.kind === "custom"
          ? state.item.input
          : state.kind === "tool_search"
            ? JSON.stringify(state.item.arguments ?? {})
            : state.item.arguments,
      })),
      usage: this.usage ? normalizeUsage(this.usage) : undefined,
    };
  }
}

export function sseEventToString(event) {
  return encodeSse(event.name, event.payload);
}

export async function consumeEventsToResponse(events, options = {}) {
  const bridge = new ResponsesBridge(options);
  for await (const event of events) bridge.accept(event);
  if (bridge.status === "in_progress") bridge.complete();
  return { response: bridge.toResponseJson(), summary: bridge.summary(), bridge };
}


function argumentsObject(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { query: String(value ?? "") };
  }
}

function customInputFromArguments(value, final) {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.input === "string") return parsed.input;
    return final ? JSON.stringify(parsed) : value;
  } catch {
    return value;
  }
}

export function normalizeUsage(usage) {
  if (!usage) return undefined;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens);
  const cachedTokens = Number(
    usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cached_input_tokens
      ?? usage.cachedInputTokens
      ?? 0,
  );
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number(usage.reasoning_tokens ?? usage.reasoningTokens ?? 0) },
    total_tokens: totalTokens,
  };
}
