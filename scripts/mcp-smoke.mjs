#!/usr/bin/env node
import readline from "node:readline";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_MCP_PROTOCOL_VERSIONS,
  MODERN_MCP_PROTOCOL_VERSION,
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SERVER_INFO_META_KEY,
} from "../src/mcp/server.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [join(projectRoot, "bin/aocx.mjs"), "mcp"], {
  cwd: projectRoot,
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;
let stderr = "";
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    rejectAll(new Error(`MCP emitted invalid JSON: ${error.message}: ${line}`));
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
  else waiter.resolve(message.result);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", rejectAll);
child.on("exit", (code, signal) => {
  if (pending.size > 0) rejectAll(new Error(`MCP exited before replies (code=${code}, signal=${signal}, stderr=${stderr.trim()})`));
});

const modernMeta = {
  [MCP_PROTOCOL_VERSION_META_KEY]: MODERN_MCP_PROTOCOL_VERSION,
  [MCP_CLIENT_INFO_META_KEY]: { name: "agent-opencodex-mcp-smoke", version: "1.0.0" },
  [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
};

try {
  const discover = await request("server/discover", { _meta: modernMeta });
  assert(discover.resultType === "complete", "discover missing complete resultType");
  assert(discover.supportedVersions.includes(MODERN_MCP_PROTOCOL_VERSION), "discover missing modern protocol version");
  assert(discover.capabilities?.tools, "discover missing tools capability");
  assert(discover._meta?.[MCP_SERVER_INFO_META_KEY]?.name === "agent-opencodex", "discover missing server identity");
  console.log("mcp-modern-discover:ok");

  const list = await request("tools/list", { _meta: modernMeta });
  assert(list.resultType === "complete", "modern tools/list missing complete resultType");
  assert(list.cacheScope === "public" && Number.isInteger(list.ttlMs), "modern tools/list missing cache hints");
  assert(list.tools.some((tool) => tool.name === "aocx_verify"), "tools/list missing aocx_verify");
  console.log("mcp-modern-tools-list:ok");

  const tempRoot = await mkdtemp(join(tmpdir(), "aocx-mcp-stdio-"));
  const specPath = join(tempRoot, "spec.json");
  const reportDir = join(tempRoot, "evidence");
  await writeFile(join(tempRoot, "marker.txt"), "stdio mcp acceptance marker\n", "utf8");
  await writeFile(specPath, JSON.stringify({
    version: 1,
    name: "mcp-stdio-verification",
    root: ".",
    checks: [
      { id: "marker", type: "file", path: "marker.txt", contains: "stdio mcp acceptance" },
    ],
  }, null, 2), "utf8");

  const verify = await request("tools/call", {
    name: "aocx_verify",
    arguments: { specPath, reportDir },
    _meta: modernMeta,
  }, 15_000);
  assert(verify.resultType === "complete", "modern tools/call missing complete resultType");
  assert(verify.isError === false, "aocx_verify returned an MCP tool error");
  assert(verify.structuredContent?.ok === true, "aocx_verify acceptance failed");
  assert(verify.structuredContent?.summary?.passed === 1, "aocx_verify did not report one passed check");
  console.log("mcp-modern-verify:ok");

  const initialize = await request("initialize", {
    protocolVersion: LEGACY_MCP_PROTOCOL_VERSIONS[0],
    capabilities: {},
    clientInfo: { name: "legacy-smoke", version: "1.0.0" },
  });
  assert(initialize.protocolVersion === LEGACY_MCP_PROTOCOL_VERSIONS[0], "legacy initialize negotiation failed");
  assert(initialize.serverInfo?.name === "agent-opencodex", "legacy initialize missing server info");
  console.log("mcp-legacy-initialize:ok");

  child.stdin.end();
  const exit = await waitForExit(child, 5_000);
  assert(exit.code === 0, `MCP process exited with ${exit.code}; stderr=${stderr.trim()}`);
} catch (error) {
  child.kill("SIGTERM");
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}

function request(method, params, timeoutMs = 5_000) {
  const id = nextId++;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Timed out waiting for MCP response to ${method}`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return Promise.resolve({ code: processHandle.exitCode, signal: processHandle.signalCode });
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Timed out waiting for MCP process exit")), timeoutMs);
    timer.unref?.();
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function rejectAll(error) {
  for (const [id, waiter] of pending) {
    pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
