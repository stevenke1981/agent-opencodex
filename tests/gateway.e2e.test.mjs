import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { createMockProvider } from "../src/mock-provider.mjs";
import { createGateway } from "../src/server.mjs";
import { createDefaultConfig, normalizeConfig } from "../src/config.mjs";
import { parseSse } from "../src/utils/sse.mjs";

async function setup(options = {}) {
  const mock = createMockProvider();
  await mock.start();
  const raw = createDefaultConfig();
  raw.server.port = 0;
  raw.server.heartbeatMs = 20;
  raw.logging = { level: "silent", json: true, prompts: false, file: null };
  raw.providers = {
    chat: { type: "openai-chat", baseUrl: `http://127.0.0.1:${mock.address.port}/v1`, models: ["mock-model"], maxRetries: 0, retryStatuses: [503] },
    fail: { type: "openai-chat", baseUrl: `http://127.0.0.1:${mock.address.port}/v1`, models: ["mock-model"], headers: { "x-mock-fail": "1" }, maxRetries: 0, retryStatuses: [503] },
    native: { type: "openai-responses", baseUrl: `http://127.0.0.1:${mock.address.port}/v1`, models: ["mock-model"], maxRetries: 0 },
    anthropic: { type: "anthropic", baseUrl: `http://127.0.0.1:${mock.address.port}/v1`, models: ["mock-model"], maxRetries: 0 },
    gemini: { type: "gemini", baseUrl: `http://127.0.0.1:${mock.address.port}/v1beta`, models: ["mock-model"], maxRetries: 0 },
  };
  raw.defaults = { provider: "chat", model: "mock-model" };
  raw.routes = {
    fallback: [{ provider: "fail", model: "mock-model" }, { provider: "chat", model: "mock-model" }],
    native: [{ provider: "native", model: "mock-model" }],
    anthropic: [{ provider: "anthropic", model: "mock-model" }],
    gemini: [{ provider: "gemini", model: "mock-model" }],
  };
  if (options.auth) {
    raw.server.clientAuth = { mode: "bearer", tokenEnv: "TEST_AOCX_TOKEN" };
  }
  const config = normalizeConfig(raw, "/tmp/e2e.json");
  const gateway = createGateway({ config, env: { ...process.env, TEST_AOCX_TOKEN: "gateway-secret" } });
  await gateway.start();
  const base = `http://127.0.0.1:${gateway.address.port}`;
  return { mock, gateway, base, async close() { await gateway.stop(); await mock.stop(); } };
}

async function post(base, body, headers = {}) {
  return fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function outputText(response) {
  return response.output.flatMap((item) => item.type === "message" ? item.content : []).map((part) => part.text ?? "").join("");
}

test("JSON, continuation, failover, and four provider protocols", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());

  const firstResponse = await post(runtime.base, { model: "mock-model", input: "first", stream: false });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.status, "completed");
  assert.equal(outputText(first), "mock:first");

  const continuationResponse = await post(runtime.base, { model: "mock-model", previous_response_id: first.id, input: "second", stream: false });
  const continuation = await continuationResponse.json();
  assert.match(outputText(continuation), /first/);
  assert.match(outputText(continuation), /second/);

  for (const [model, marker] of [["fallback", "fallback"], ["native", "native"], ["anthropic", "anthropic"], ["gemini", "gemini"]]) {
    const response = await post(runtime.base, { model, input: marker, stream: false });
    assert.equal(response.status, 200, model);
    const json = await response.json();
    assert.equal(json.status, "completed", model);
    assert.match(outputText(json), new RegExp(marker), model);
  }
});

test("SSE and namespaced tool calls round-trip", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());
  const response = await post(runtime.base, {
    model: "mock-model",
    input: "call_tool weather",
    stream: true,
    tools: [{
      type: "namespace",
      name: "mcp__climate",
      tools: [{ type: "function", name: "weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    }],
  });
  assert.equal(response.status, 200);
  let completed = false;
  let added;
  let argumentsText = "";
  for await (const frame of parseSse(response.body)) {
    const event = JSON.parse(frame.data);
    if (event.type === "response.output_item.added" && event.item.type === "function_call") added = event.item;
    if (event.type === "response.function_call_arguments.delta") argumentsText += event.delta;
    if (event.type === "response.completed") completed = true;
  }
  assert.equal(completed, true);
  assert.equal(added.name, "weather");
  assert.equal(added.namespace, "mcp__climate");
  assert.deepEqual(JSON.parse(argumentsText), { city: "Taipei" });
});

test("bearer mode protects models and responses", async (t) => {
  const runtime = await setup({ auth: true });
  t.after(() => runtime.close());
  const unauthorized = await fetch(`${runtime.base}/v1/models`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${runtime.base}/v1/models`, { headers: { authorization: "Bearer gateway-secret" } });
  assert.equal(authorized.status, 200);
});

test("gateway stop force-closes a stalled active connection after the grace period", async () => {
  const raw = createDefaultConfig();
  raw.server.port = 0;
  raw.logging = { level: "silent", json: true, prompts: false, file: null };
  const config = normalizeConfig(raw, "/tmp/shutdown.json");
  const gateway = createGateway({ config, shutdownGraceMs: 25 });
  await gateway.start();

  const socket = connect({ host: "127.0.0.1", port: gateway.address.port });
  await once(socket, "connect");
  socket.write("POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n");

  const startedAt = Date.now();
  await gateway.stop();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(gateway.state, "stopped");
  socket.destroy();
});

test("gateway can recover after a failed bind", async (t) => {
  const raw = createDefaultConfig();
  raw.server.port = 0;
  raw.logging = { level: "silent", json: true, prompts: false, file: null };
  const config = normalizeConfig(raw, "/tmp/bind-recovery.json");
  const first = createGateway({ config });
  const second = createGateway({ config });
  t.after(async () => {
    await second.stop();
    await first.stop();
  });

  await first.start();
  await assert.rejects(() => second.start({ port: first.address.port }), /EADDRINUSE|address already in use/i);
  assert.equal(second.state, "stopped");
  assert.equal(second.server, undefined);

  await second.start({ port: 0 });
  assert.equal(second.state, "ready");
  assert.notEqual(second.address.port, first.address.port);
});

test("tool_search round-trips as a Codex-native client execution item", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());
  const response = await post(runtime.base, {
    model: "mock-model",
    input: "call_tool tool:tool_search",
    stream: true,
    tools: [{
      type: "tool_search",
      execution: "client",
      description: "Search available tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    }],
  });
  assert.equal(response.status, 200);
  let added;
  let done;
  let completed = false;
  for await (const frame of parseSse(response.body)) {
    const event = JSON.parse(frame.data);
    if (event.type === "response.output_item.added" && event.item.type === "tool_search_call") added = event.item;
    if (event.type === "response.output_item.done" && event.item.type === "tool_search_call") done = event.item;
    if (event.type === "response.completed") completed = true;
  }
  assert.equal(completed, true);
  assert.equal(added.type, "tool_search_call");
  assert.equal(added.execution, "client");
  assert.equal("name" in added, false);
  assert.deepEqual(done.arguments, { query: "mock-query" });
});

test("namespaced function calls survive a client result and local continuation", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());
  const tools = [{
    type: "namespace",
    name: "mcp__climate",
    tools: [{
      type: "function",
      name: "weather",
      description: "Weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }],
  }];
  const firstResponse = await post(runtime.base, {
    model: "mock-model",
    input: "call_tool weather",
    stream: false,
    tools,
  });
  const first = await firstResponse.json();
  const call = first.output.find((item) => item.type === "function_call");
  assert.equal(call.namespace, "mcp__climate");

  const secondResponse = await post(runtime.base, {
    model: "mock-model",
    previous_response_id: first.id,
    stream: false,
    tools,
    input: [
      { type: "function_call_output", call_id: call.call_id, output: "sunny" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue after tool" }] },
    ],
  });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(second.status, "completed");
});

test("native Responses upstream tool_search is translated without a generic function shim", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());
  for (const stream of [false, true]) {
    const response = await post(runtime.base, {
      model: "native",
      input: "call_tool tool:tool_search",
      stream,
      tools: [{
        type: "tool_search",
        execution: "client",
        description: "Search available tools",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }],
    });
    assert.equal(response.status, 200);
    if (!stream) {
      const json = await response.json();
      const item = json.output.find((entry) => entry.type === "tool_search_call");
      assert.equal(item.execution, "client");
      assert.deepEqual(item.arguments, { query: "mock-query" });
    } else {
      let item;
      for await (const frame of parseSse(response.body)) {
        const event = JSON.parse(frame.data);
        if (event.type === "response.output_item.done" && event.item.type === "tool_search_call") item = event.item;
      }
      assert.equal(item.execution, "client");
      assert.deepEqual(item.arguments, { query: "mock-query" });
    }
  }
});

test("tool_search output closes the client-executed loop on generic and native routes", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());
  const tools = [{
    type: "tool_search",
    execution: "client",
    description: "Search available tools",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  }];
  const discovered = [{
    type: "function",
    name: "weather",
    description: "Weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  }];

  for (const model of ["mock-model", "native"]) {
    const firstResponse = await post(runtime.base, {
      model,
      input: "call_tool tool:tool_search",
      stream: false,
      tools,
    });
    const first = await firstResponse.json();
    const call = first.output.find((item) => item.type === "tool_search_call");
    assert.ok(call, model);

    const secondResponse = await post(runtime.base, {
      model,
      previous_response_id: first.id,
      stream: false,
      tools,
      input: [
        {
          type: "tool_search_output",
          call_id: call.call_id,
          execution: "client",
          status: "completed",
          tools: discovered,
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "continue after discovery" }],
        },
      ],
    });
    assert.equal(secondResponse.status, 200, model);
    const second = await secondResponse.json();
    assert.equal(second.status, "completed", model);
    assert.match(outputText(second), /continue after discovery/, model);
  }
});
