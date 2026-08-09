import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleMcpMessage,
  LEGACY_MCP_PROTOCOL_VERSIONS,
  MODERN_MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SERVER_INFO_META_KEY,
} from "../src/mcp/server.mjs";
import { createPresetConfig } from "../src/config.mjs";

function modernMeta(overrides = {}) {
  return {
    [MCP_PROTOCOL_VERSION_META_KEY]: MODERN_MCP_PROTOCOL_VERSION,
    [MCP_CLIENT_INFO_META_KEY]: { name: "agent-opencodex-test", version: "1.0.0" },
    [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

test("legacy MCP initialize negotiates supported versions and tools/list stays backward compatible", async () => {
  const requested = LEGACY_MCP_PROTOCOL_VERSIONS[1];
  const init = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(init.result.protocolVersion, requested);
  assert.equal(init.result.resultType, undefined);

  const fallback = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "unsupported-test-version" },
  });
  assert.equal(fallback.result.protocolVersion, LEGACY_MCP_PROTOCOL_VERSIONS[0]);

  const list = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(list.result.resultType, undefined);
  assert.ok(list.result.tools.some((tool) => tool.name === "aocx_verify"));
});

test("modern MCP server/discover advertises stateless capabilities and server identity", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "server/discover",
    params: { _meta: modernMeta() },
  });

  assert.equal(response.result.resultType, "complete");
  assert.deepEqual(response.result.supportedVersions, SUPPORTED_MCP_PROTOCOL_VERSIONS);
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result.ttlMs, 300_000);
  assert.equal(response.result.cacheScope, "public");
  assert.equal(response.result._meta[MCP_SERVER_INFO_META_KEY].name, "agent-opencodex");
});

test("modern MCP tools/list emits resultType, cache hints, and deterministic tools", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/list",
    params: { _meta: modernMeta() },
  });

  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.ttlMs, 300_000);
  assert.equal(response.result.cacheScope, "public");
  assert.equal(response.result._meta[MCP_SERVER_INFO_META_KEY].version, "0.1.0");
  assert.ok(response.result.tools.some((tool) => tool.name === "aocx_verify"));
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
    [...response.result.tools].map((tool) => tool.name),
  );
});

test("modern MCP validates per-request metadata and rejects unsupported protocol versions", async () => {
  const missingCapabilities = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/list",
    params: {
      _meta: {
        [MCP_PROTOCOL_VERSION_META_KEY]: MODERN_MCP_PROTOCOL_VERSION,
        [MCP_CLIENT_INFO_META_KEY]: { name: "test", version: "1" },
      },
    },
  });
  assert.equal(missingCapabilities.error.code, -32602);

  const requested = "2099-01-01";
  const unsupported = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/list",
    params: {
      _meta: modernMeta({ [MCP_PROTOCOL_VERSION_META_KEY]: requested }),
    },
  });
  assert.equal(unsupported.error.code, -32022);
  assert.equal(unsupported.error.data.requested, requested);
  assert.deepEqual(unsupported.error.data.supported, SUPPORTED_MCP_PROTOCOL_VERSIONS);
});

test("MCP rejects unknown tool names as protocol invalid-params errors", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "does_not_exist", arguments: {} },
  });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /Unknown tool/);
});

test("MCP route tool returns structured content", async () => {
  const root = await mkdtemp(join(tmpdir(), "aocx-mcp-"));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(createPresetConfig("ollama", { model: "qwen3-coder" }), null, 2));
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "aocx_route",
      arguments: { configPath, model: "ollama/qwen3-coder" },
      _meta: modernMeta(),
    },
  });
  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.candidates[0].provider, "ollama");
  assert.equal(response.result._meta[MCP_SERVER_INFO_META_KEY].name, "agent-opencodex");
});

test("MCP verify tool runs a trusted spec and returns evidence paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "aocx-mcp-verify-"));
  const specPath = join(root, "spec.json");
  const reportDir = join(root, "report");
  await writeFile(join(root, "marker.txt"), "agent acceptance marker\n", "utf8");
  await writeFile(specPath, JSON.stringify({
    version: 1,
    name: "mcp-verification",
    root: ".",
    checks: [
      { id: "marker", type: "file", path: "marker.txt", contains: "acceptance" },
      { id: "node", type: "command", command: [process.execPath, "--version"], expect: { exitCode: 0, stdoutIncludes: "v" } },
    ],
  }, null, 2), "utf8");

  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "aocx_verify",
      arguments: { specPath, reportDir },
      _meta: modernMeta(),
    },
  });

  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.ok, true);
  assert.deepEqual(response.result.structuredContent.summary, { passed: 2, failed: 0, skipped: 0 });
  const report = JSON.parse(await readFile(response.result.structuredContent.paths.jsonPath, "utf8"));
  assert.equal(report.name, "mcp-verification");
  assert.equal(report.ok, true);
});
