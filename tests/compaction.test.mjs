import test from "node:test";
import assert from "node:assert/strict";
import { createMockProvider } from "../src/mock-provider.mjs";
import { createGateway } from "../src/server.mjs";
import { createDefaultConfig, normalizeConfig } from "../src/config.mjs";
import { parseResponsesRequest } from "../src/responses/parse.mjs";
import { ResponsesBridge } from "../src/responses/bridge.mjs";
import {
  AOCX_COMPACTION_PREFIX,
  SUMMARY_PREFIX,
  buildCompactV1Output,
  decodeCompactionSummary,
  encodeCompactionSummary,
} from "../src/responses/compaction.mjs";
import { parseSse } from "../src/utils/sse.mjs";

async function setup() {
  const mock = createMockProvider();
  await mock.start();
  const raw = createDefaultConfig();
  raw.server.port = 0;
  raw.server.heartbeatMs = 20;
  raw.logging = { level: "silent", json: true, prompts: false, file: null };
  raw.providers = {
    chat: { type: "openai-chat", baseUrl: `http://127.0.0.1:${mock.address.port}/v1`, models: ["mock-model"], maxRetries: 0 },
    native: { type: "openai-responses", baseUrl: `http://127.0.0.1:${mock.address.port}/v1`, models: ["mock-model"], maxRetries: 0 },
  };
  raw.defaults = { provider: "chat", model: "mock-model" };
  raw.routes = { native: [{ provider: "native", model: "mock-model" }] };
  const config = normalizeConfig(raw, "/tmp/compaction-e2e.json");
  const gateway = createGateway({ config });
  await gateway.start();
  return {
    mock,
    gateway,
    base: `http://127.0.0.1:${gateway.address.port}`,
    async close() { await gateway.stop(); await mock.stop(); },
  };
}

function messageText(item) {
  return (item.content ?? []).map((part) => part.text ?? "").join("");
}

test("compaction envelope round-trips and accepts upstream ocx1 migration envelopes", () => {
  const encoded = encodeCompactionSummary("progress complete; next run tests");
  assert.ok(encoded.startsWith(AOCX_COMPACTION_PREFIX));
  assert.equal(decodeCompactionSummary(encoded), "progress complete; next run tests");
  const legacy = `ocx1:${Buffer.from("legacy summary", "utf8").toString("base64")}`;
  assert.equal(decodeCompactionSummary(legacy), "legacy summary");
  assert.equal(decodeCompactionSummary("opaque-provider-data"), null);
});

test("parser recognizes compaction triggers and decodes replayed summaries", () => {
  const triggered = parseResponsesRequest({
    model: "mock-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "checkpoint this task" }] },
      { type: "compaction_trigger" },
    ],
  });
  assert.equal(triggered.compactionRequest, true);
  assert.equal(triggered.messages[0].role, "system");
  assert.match(triggered.messages[0].content[0].text, /CONTEXT CHECKPOINT COMPACTION/);
  assert.equal(triggered.messages.some((message) => message.content?.some((part) => part.text === "checkpoint this task")), true);

  const replayed = parseResponsesRequest({
    model: "mock-model",
    input: [
      { type: "compaction", encrypted_content: encodeCompactionSummary("fixed routing; next verify packaging") },
      { type: "message", role: "user", content: "continue" },
    ],
  });
  assert.match(replayed.messages[0].content[0].text, /fixed routing; next verify packaging/);
});

test("compaction bridge emits exactly one compaction item and no assistant message", () => {
  const bridge = new ResponsesBridge({ model: "mock-model", compaction: true });
  bridge.accept({ type: "reasoning_delta", text: "private scratch" });
  bridge.accept({ type: "text_delta", text: "handoff summary" });
  const terminal = bridge.accept({ type: "done" });
  const json = bridge.toResponseJson();
  assert.equal(json.status, "completed");
  assert.equal(json.output.length, 1);
  assert.equal(json.output[0].type, "compaction");
  assert.equal(decodeCompactionSummary(json.output[0].encrypted_content), "handoff summary");
  assert.equal(json.output.some((item) => item.type === "message"), false);
  assert.equal(terminal.filter((event) => event.name === "response.output_item.done").length, 1);
});

test("v1 compaction output retains recent user messages and appends a summary", () => {
  const output = buildCompactV1Output(["first", "second"], "summary body");
  assert.equal(output.length, 3);
  assert.equal(messageText(output[0]), "first");
  assert.equal(messageText(output[1]), "second");
  assert.match(messageText(output[2]), new RegExp(`^${SUMMARY_PREFIX.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  assert.match(messageText(output[2]), /summary body/);
});

test("gateway supports v2 compaction, v1 compact endpoint, and summary replay", async (t) => {
  const runtime = await setup();
  t.after(() => runtime.close());

  const v2 = await fetch(`${runtime.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "native",
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "checkpoint marker alpha" }] },
        { type: "compaction_trigger" },
      ],
    }),
  });
  assert.equal(v2.status, 200);
  const v2Items = [];
  let completed = false;
  for await (const frame of parseSse(v2.body)) {
    const event = JSON.parse(frame.data);
    if (event.type === "response.output_item.done") v2Items.push(event.item);
    if (event.type === "response.completed") completed = true;
  }
  assert.equal(completed, true);
  assert.equal(v2Items.length, 1);
  assert.equal(v2Items[0].type, "compaction");
  const summary = decodeCompactionSummary(v2Items[0].encrypted_content);
  assert.match(summary, /checkpoint marker alpha/);

  const v1 = await fetch(`${runtime.base}/v1/responses/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact marker beta" }] }],
    }),
  });
  assert.equal(v1.status, 200);
  const compacted = await v1.json();
  assert.equal(compacted.output.length, 2);
  assert.equal(messageText(compacted.output[0]), "compact marker beta");
  assert.match(messageText(compacted.output[1]), /compact marker beta/);
  assert.match(messageText(compacted.output[1]), new RegExp(`^${SUMMARY_PREFIX.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));

  const replay = await fetch(`${runtime.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-model",
      stream: false,
      input: [
        { type: "compaction", encrypted_content: v2Items[0].encrypted_content },
        { type: "message", role: "user", content: "continue marker gamma" },
      ],
    }),
  });
  assert.equal(replay.status, 200);
  const replayJson = await replay.json();
  const replayText = replayJson.output.flatMap((item) => item.type === "message" ? item.content ?? [] : []).map((part) => part.text ?? "").join("");
  assert.match(replayText, /checkpoint marker alpha/);
  assert.match(replayText, /continue marker gamma/);
});
