import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, createPresetConfig, interpolateEnv, normalizeConfig, sanitizeConfig, validateConfig } from "../src/config.mjs";
import { describeRoute } from "../src/router.mjs";
import { renderCodexConfig } from "../src/codex-config.mjs";
import { createMockProvider } from "../src/mock-provider.mjs";
import { runDoctor } from "../src/doctor.mjs";

test("environment interpolation supports values and fallbacks", () => {
  const value = interpolateEnv({ a: "${A}", b: "${B:-fallback}", c: ["x-${A}"] }, { A: "one" });
  assert.deepEqual(value, { a: "one", b: "fallback", c: ["x-one"] });
});

test("remote binding requires bearer authentication", () => {
  const raw = createDefaultConfig();
  raw.server.host = "0.0.0.0";
  const config = normalizeConfig(raw, "/tmp/config.json");
  const invalid = validateConfig(config, { env: {} });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /Remote binding requires/);
  config.server.clientAuth.mode = "bearer";
  const valid = validateConfig(config, { env: { AGENT_OPENCODEX_CLIENT_KEY: "test-client-secret" } });
  assert.equal(valid.valid, true);
});

test("preset, route explanation, and Codex TOML are deterministic", () => {
  const raw = createPresetConfig("ollama", { model: "qwen3-coder", port: 12345 });
  const config = normalizeConfig(raw, "/tmp/config.json");
  assert.deepEqual(describeRoute("ollama/qwen3-coder", config)[0], {
    selector: "ollama/qwen3-coder",
    provider: "ollama",
    providerType: "openai-chat",
    requestedModel: "qwen3-coder",
    upstreamModel: "qwen3-coder",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  const toml = renderCodexConfig(config);
  assert.match(toml, /model = "qwen3-coder"/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:12345\/v1"/);
  assert.match(toml, /wire_api = "responses"/);
});

test("sanitized config preserves env variable names but removes inline secrets", () => {
  const raw = createDefaultConfig();
  raw.providers.openrouter.apiKey = "inline-secret-value";
  const config = normalizeConfig(raw, "/tmp/config.json");
  const safe = sanitizeConfig(config);
  assert.equal(safe.providers.openrouter.apiKey, "[REDACTED]");
  assert.equal(safe.providers.openrouter.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(safe.server.clientAuth.tokenEnv, "AGENT_OPENCODEX_CLIENT_KEY");
});


test("default provider model IDs containing slashes take precedence over provider prefixes", () => {
  const raw = createDefaultConfig();
  raw.providers.deepseek = {
    type: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat"],
  };
  const config = normalizeConfig(raw, "/tmp/config.json");

  const bare = describeRoute("deepseek/deepseek-v4-flash-latest", config)[0];
  assert.equal(bare.provider, "openrouter");
  assert.equal(bare.upstreamModel, "deepseek/deepseek-v4-flash-latest");

  const explicit = describeRoute("deepseek/deepseek-chat", config)[0];
  assert.equal(explicit.provider, "deepseek");
  assert.equal(explicit.upstreamModel, "deepseek-chat");
});

test("doctor inference probe verifies a real end-to-end generation", async () => {
  const mock = createMockProvider({ host: "127.0.0.1", port: 0 });
  const address = await mock.start();
  try {
    const raw = createPresetConfig("openrouter", {
      model: "mock-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    delete raw.providers.openrouter.apiKeyEnv;
    const config = normalizeConfig(raw, "/tmp/config.json");
    const result = await runDoctor(config, { env: {}, inference: true, timeoutMs: 5_000 });
    const inference = result.checks.find((check) => check.id === "default-route:inference");
    assert.equal(result.ok, true);
    assert.equal(inference.status, "pass");
    assert.equal(inference.details.model, "mock-model");
  } finally {
    await mock.stop();
  }
});

test("doctor inference probe reports upstream generation failures", async () => {
  const mock = createMockProvider({ host: "127.0.0.1", port: 0 });
  const address = await mock.start();
  try {
    const raw = createPresetConfig("openrouter", {
      model: "mock-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    delete raw.providers.openrouter.apiKeyEnv;
    raw.providers.openrouter.headers["x-mock-fail"] = "1";
    raw.providers.openrouter.maxRetries = 0;
    const config = normalizeConfig(raw, "/tmp/config.json");
    const result = await runDoctor(config, { env: {}, inference: true, timeoutMs: 5_000 });
    const inference = result.checks.find((check) => check.id === "default-route:inference");
    assert.equal(result.ok, false);
    assert.equal(inference.status, "fail");
    assert.equal(inference.details.status, 503);
    assert.match(inference.details.error, /All route candidates failed/);
  } finally {
    await mock.stop();
  }
});
