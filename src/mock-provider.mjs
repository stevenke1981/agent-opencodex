import http from "node:http";
import { createId } from "./utils/crypto.mjs";

export function createMockProvider(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? 0);
  const name = options.name ?? "agent-opencodex-mock";
  const shutdownGraceMs = Number.isFinite(options.shutdownGraceMs)
    ? Math.max(0, Number(options.shutdownGraceMs))
    : 1_000;
  let server;
  let address;

  async function handler(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { status: "ok", service: name });
    }
    if (req.method === "GET" && /\/models$/.test(url.pathname)) {
      return json(res, 200, { object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] });
    }
    if (req.method !== "POST") return json(res, 404, { error: { message: "not found" } });

    let body;
    try { body = await readJson(req); }
    catch (error) { return json(res, 400, { error: { message: error.message } }); }

    const prompt = extractPrompt(body);
    const delayMs = extractDelay(prompt, req.headers["x-mock-delay-ms"]);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (prompt.includes("MOCK_FAIL") || req.headers["x-mock-fail"] === "1") {
      return json(res, 503, { error: { message: "mock provider requested failure", type: "mock_failure" } }, { "retry-after": "0" });
    }

    if (/\/chat\/completions$/.test(url.pathname)) return handleOpenAIChat(res, body, prompt);
    if (/\/responses$/.test(url.pathname)) return handleResponses(res, body, prompt);
    if (/\/messages$/.test(url.pathname)) return handleAnthropic(res, body, prompt);
    if (/:(?:streamGenerateContent|generateContent)$/.test(url.pathname)) return handleGemini(res, body, prompt, url);
    return json(res, 404, { error: { message: `mock route not found: ${url.pathname}` } });
  }

  return {
    get address() { return address; },
    async start() {
      if (server) return address;
      const current = http.createServer((req, res) => handler(req, res).catch((error) => json(res, 500, { error: { message: error.message } })));
      server = current;
      try {
        await listen(current, port, host);
      } catch (error) {
        server = undefined;
        throw error;
      }
      const raw = current.address();
      address = { host, port: typeof raw === "object" && raw ? raw.port : port };
      return address;
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = undefined;
      const closed = new Promise((resolve) => current.close(resolve));
      current.closeIdleConnections?.();
      const forceTimer = setTimeout(() => current.closeAllConnections?.(), shutdownGraceMs);
      try { await closed; }
      finally {
        clearTimeout(forceTimer);
        address = undefined;
      }
    },
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen(port, host); }
    catch (error) { onError(error); }
  });
}

function handleOpenAIChat(res, body, prompt) {
  const tool = chooseTool(body.tools, extractLatestPrompt(body));
  const text = mockText(prompt);
  if (!body.stream) {
    return json(res, 200, {
      id: createId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "mock-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: tool ? null : text,
          ...(tool ? { tool_calls: [{ id: createId("call"), type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : {}),
        },
        finish_reason: tool ? "tool_calls" : "stop",
      }],
      usage: usage(prompt, tool ? JSON.stringify(tool.arguments) : text),
    });
  }

  sseHeaders(res);
  const id = createId("chatcmpl");
  writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  if (tool) {
    const callId = createId("call");
    writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: tool.name, arguments: "" } }] }, finish_reason: null }] });
    const args = JSON.stringify(tool.arguments);
    for (const part of chunkText(args, 8)) {
      writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null }] });
    }
    writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    for (const part of chunkText(text, 7)) {
      writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
    }
    writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  writeSseData(res, { id, object: "chat.completion.chunk", model: body.model, choices: [], usage: usage(prompt, tool ? JSON.stringify(tool.arguments) : text) });
  res.write("data: [DONE]\n\n");
  res.end();
}

function handleResponses(res, body, prompt) {
  const tool = chooseResponsesTool(body.tools, extractLatestPrompt(body));
  const text = mockText(prompt);
  const responseId = createId("resp");
  const output = tool
    ? [tool.kind === "tool_search"
        ? {
            id: createId("tsc"),
            type: "tool_search_call",
            status: "completed",
            call_id: createId("call"),
            execution: tool.execution ?? "client",
            arguments: tool.arguments,
          }
        : {
            id: createId("fc"),
            type: "function_call",
            status: "completed",
            call_id: createId("call"),
            name: tool.name,
            arguments: JSON.stringify(tool.arguments),
          }]
    : [{ id: createId("msg"), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }];
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model ?? "mock-model",
    output,
    usage: openAIResponsesUsage(prompt, tool ? JSON.stringify(tool.arguments) : text),
  };
  if (!body.stream) return json(res, 200, response);

  sseHeaders(res);
  writeSseEvent(res, "response.created", { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } });
  let seq = 1;
  if (tool) {
    const item = output[0];
    if (item.type === "tool_search_call") {
      // Codex dispatches client-executed tool search from the completed output
      // item. Keep the mock on that exact wire shape instead of disguising it
      // as a generic function call.
      writeSseEvent(res, "response.output_item.done", { type: "response.output_item.done", sequence_number: seq++, output_index: 0, item });
    } else {
      writeSseEvent(res, "response.output_item.added", { type: "response.output_item.added", sequence_number: seq++, output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      for (const part of chunkText(item.arguments, 8)) {
        writeSseEvent(res, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", sequence_number: seq++, item_id: item.id, output_index: 0, delta: part });
      }
      writeSseEvent(res, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", sequence_number: seq++, item_id: item.id, output_index: 0, arguments: item.arguments });
      writeSseEvent(res, "response.output_item.done", { type: "response.output_item.done", sequence_number: seq++, output_index: 0, item });
    }
  } else {
    const item = output[0];
    writeSseEvent(res, "response.output_item.added", { type: "response.output_item.added", sequence_number: seq++, output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    writeSseEvent(res, "response.content_part.added", { type: "response.content_part.added", sequence_number: seq++, item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    for (const part of chunkText(text, 7)) {
      writeSseEvent(res, "response.output_text.delta", { type: "response.output_text.delta", sequence_number: seq++, item_id: item.id, output_index: 0, content_index: 0, delta: part });
    }
    writeSseEvent(res, "response.output_text.done", { type: "response.output_text.done", sequence_number: seq++, item_id: item.id, output_index: 0, content_index: 0, text });
    writeSseEvent(res, "response.output_item.done", { type: "response.output_item.done", sequence_number: seq++, output_index: 0, item });
  }
  writeSseEvent(res, "response.completed", { type: "response.completed", sequence_number: seq++, response });
  res.end();
}

function handleAnthropic(res, body, prompt) {
  const tool = chooseAnthropicTool(body.tools, extractLatestPrompt(body));
  const text = mockText(prompt);
  const messageId = createId("msg");
  const content = tool
    ? [{ type: "tool_use", id: createId("toolu"), name: tool.name, input: tool.arguments }]
    : [{ type: "text", text }];
  if (!body.stream) {
    return json(res, 200, {
      id: messageId,
      type: "message",
      role: "assistant",
      model: body.model ?? "mock-model",
      content,
      stop_reason: tool ? "tool_use" : "end_turn",
      usage: { input_tokens: tokenEstimate(prompt), output_tokens: tokenEstimate(tool ? JSON.stringify(tool.arguments) : text) },
    });
  }
  sseHeaders(res);
  writeSseEvent(res, "message_start", { type: "message_start", message: { id: messageId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: tokenEstimate(prompt), output_tokens: 0 } } });
  if (tool) {
    const id = createId("toolu");
    writeSseEvent(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: tool.name, input: {} } });
    for (const part of chunkText(JSON.stringify(tool.arguments), 8)) writeSseEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: part } });
    writeSseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  } else {
    writeSseEvent(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const part of chunkText(text, 7)) writeSseEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
    writeSseEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  }
  writeSseEvent(res, "message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: tokenEstimate(tool ? JSON.stringify(tool.arguments) : text) } });
  writeSseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function handleGemini(res, body, prompt, url) {
  const tools = body.tools?.flatMap((entry) => entry.functionDeclarations ?? []) ?? [];
  const tool = chooseTool(tools, extractLatestPrompt(body));
  const text = mockText(prompt);
  const payload = {
    candidates: [{
      content: { role: "model", parts: tool ? [{ functionCall: { name: tool.name, args: tool.arguments } }] : [{ text }] },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: { promptTokenCount: tokenEstimate(prompt), candidatesTokenCount: tokenEstimate(tool ? JSON.stringify(tool.arguments) : text), totalTokenCount: tokenEstimate(prompt) + tokenEstimate(tool ? JSON.stringify(tool.arguments) : text) },
  };
  if (!url.pathname.includes("streamGenerateContent")) return json(res, 200, payload);
  sseHeaders(res);
  if (tool) writeSseData(res, payload);
  else {
    const chunks = chunkText(text, 7);
    for (const [index, part] of chunks.entries()) {
      writeSseData(res, {
        candidates: [{ content: { role: "model", parts: [{ text: part }] }, finishReason: index === chunks.length - 1 ? "STOP" : undefined, index: 0 }],
        ...(index === chunks.length - 1 ? { usageMetadata: payload.usageMetadata } : {}),
      });
    }
  }
  res.end();
}

function chooseResponsesTool(tools = [], prompt) {
  const normalized = tools.flatMap((tool) => {
    if (tool.type === "namespace") {
      return (tool.tools ?? []).map((nested) => ({
        ...nested,
        name: `${tool.name ?? tool.namespace}__${nested.name}`,
        kind: nested.type === "custom" ? "custom" : "function",
      }));
    }
    if (tool.type === "tool_search") {
      return [{
        ...tool,
        name: tool.name ?? "tool_search",
        kind: "tool_search",
        execution: tool.execution ?? "client",
      }];
    }
    if (tool.type === "function" || tool.type === "custom") {
      return [{ ...tool, kind: tool.type === "custom" ? "custom" : "function" }];
    }
    return [];
  });
  return chooseTool(normalized, prompt);
}

function chooseAnthropicTool(tools = [], prompt) {
  return chooseTool(tools.map((tool) => ({ name: tool.name, parameters: tool.input_schema })), prompt);
}

function chooseTool(tools = [], prompt = "") {
  if (!tools.length || !/(call_tool|use_tool|weather|tool:)/i.test(prompt)) return undefined;
  const requested = /tool:([A-Za-z0-9_.-]+)/i.exec(prompt)?.[1];
  const selected = tools.find((tool) => tool.name === requested) ?? tools[0];
  const properties = selected.function?.parameters?.properties ?? selected.parameters?.properties ?? selected.input_schema?.properties ?? {};
  const argumentsObject = {};
  for (const [name, schema] of Object.entries(properties)) {
    if (/city|location/i.test(name)) argumentsObject[name] = "Taipei";
    else if (schema.type === "number" || schema.type === "integer") argumentsObject[name] = 1;
    else if (schema.type === "boolean") argumentsObject[name] = true;
    else argumentsObject[name] = `mock-${name}`;
  }
  if (!Object.keys(argumentsObject).length) argumentsObject.input = "mock-input";
  return {
    name: selected.function?.name ?? selected.name,
    arguments: argumentsObject,
    kind: selected.kind,
    execution: selected.execution,
  };
}

function extractLatestPrompt(body) {
  if (Array.isArray(body.messages)) {
    for (let index = body.messages.length - 1; index >= 0; index -= 1) {
      const message = body.messages[index];
      if (message?.role === "user") {
        const text = extractContent(message.content);
        if (text) return text;
      }
    }
  }
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) {
    for (let index = body.input.length - 1; index >= 0; index -= 1) {
      const item = body.input[index];
      if (item?.type === "message" && item.role === "user") {
        const text = extractContent(item.content);
        if (text) return text;
      }
      if (item?.type === "input_text" && typeof item.text === "string") return item.text;
    }
  }
  if (Array.isArray(body.contents)) {
    for (let index = body.contents.length - 1; index >= 0; index -= 1) {
      const item = body.contents[index];
      if (item?.role !== "user") continue;
      const text = (item.parts ?? []).map((part) => part?.text ?? "").filter(Boolean).join("\n");
      if (text) return text;
    }
  }
  return extractPrompt(body);
}

function extractPrompt(body) {
  if (Array.isArray(body.messages)) return body.messages.map((message) => extractContent(message.content)).join("\n");
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) return body.input.map((item) => extractContent(item.content ?? item.output ?? item.text)).join("\n");
  if (Array.isArray(body.contents)) return body.contents.flatMap((item) => item.parts ?? []).map((part) => part.text ?? "").join("\n");
  return "";
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content?.text ?? "";
  return content.map((part) => typeof part === "string" ? part : part?.text ?? part?.input_text ?? part?.output ?? "").join("\n");
}

function mockText(prompt) {
  const clean = String(prompt).trim().replace(/\s+/g, " ").slice(-500);
  return `mock:${clean || "ok"}`;
}

function usage(input, output) {
  const promptTokens = tokenEstimate(input);
  const completionTokens = tokenEstimate(output);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function openAIResponsesUsage(input, output) {
  const inputTokens = tokenEstimate(input);
  const outputTokens = tokenEstimate(output);
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function tokenEstimate(value) { return Math.max(1, Math.ceil(String(value ?? "").length / 4)); }
function chunkText(value, size) { return String(value).match(new RegExp(`.{1,${size}}`, "gs")) ?? []; }
function extractDelay(prompt, header) {
  const value = Number(header ?? /MOCK_DELAY=(\d+)/.exec(prompt)?.[1]);
  return Number.isFinite(value) ? Math.min(30_000, Math.max(0, value)) : 0;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sseHeaders(res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
}
function writeSseData(res, value) { res.write(`data: ${JSON.stringify(value)}\n\n`); }
function writeSseEvent(res, event, value) { res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
