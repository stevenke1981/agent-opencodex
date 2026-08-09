import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseSse } from "../utils/sse.mjs";
import { getJsonPointer, readJson } from "../utils/json.mjs";
import { runProcess } from "../utils/process.mjs";
import { buildRedactor, collectSecretsFromEnv, redactObject } from "../utils/redact.mjs";
import { sleep } from "../utils/async.mjs";
import { validateAcceptanceSpec } from "./schema.mjs";
import { writeAcceptanceReports } from "./reporters.mjs";

export async function runAcceptance(options) {
  const specPath = resolve(options.specPath);
  const spec = validateAcceptanceSpec(await readJson(specPath));
  const specDir = dirname(specPath);
  const root = resolve(specDir, spec.root ?? ".");
  const reportDir = resolve(options.reportDir ?? join(root, "artifacts", "acceptance"));
  await mkdir(reportDir, { recursive: true });
  const started = Date.now();
  const redactor = buildRedactor(collectSecretsFromEnv(options.env ?? process.env));
  const runtime = {
    root,
    specPath,
    reportDir,
    services: {},
    env: options.env ?? process.env,
  };
  const serviceRecords = [];
  const running = [];
  let setupError;

  try {
    await allocateServicePorts(spec.services ?? [], runtime);
    for (const service of spec.services ?? []) {
      try {
        const runningService = await startService(service, runtime, reportDir, redactor);
        running.push(runningService);
        serviceRecords.push(runningService.record);
      } catch (error) {
        serviceRecords.push({ id: service.id, status: "failed", message: error.message });
        throw error;
      }
    }
  } catch (error) {
    setupError = error;
  }

  const results = [];
  if (setupError) {
    results.push({
      id: "service-setup",
      type: "service",
      status: "failed",
      durationMs: 0,
      message: setupError.message,
      evidence: redactObject({ stack: setupError.stack }, redactor),
    });
    for (const check of spec.checks) {
      results.push({ id: check.id, type: check.type, status: "skipped", durationMs: 0, message: "Service setup failed" });
    }
  } else {
    for (const check of spec.checks) {
      const result = await runCheck(check, runtime, redactor);
      results.push(result);
      if (result.status === "failed" && (options.failFast ?? spec.failFast)) {
        for (const remaining of spec.checks.slice(results.length)) {
          results.push({ id: remaining.id, type: remaining.type, status: "skipped", durationMs: 0, message: "Fail-fast enabled" });
        }
        break;
      }
    }
  }

  for (const service of [...running].reverse()) {
    try { await stopService(service); }
    catch (error) {
      service.record.status = "failed";
      service.record.stopError = error.message;
    }
  }

  const summary = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, { passed: 0, failed: 0, skipped: 0 });
  const report = {
    schemaVersion: 1,
    name: spec.name,
    ok: summary.failed === 0,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    root,
    specPath,
    reportDir,
    summary,
    services: serviceRecords.map((record) => redactObject(record, redactor)),
    results,
    reproduceCommand: `node ./bin/aocx.mjs verify --spec ${quoteRelative(root, specPath)} --report-dir ${quoteRelative(root, reportDir)}`,
  };
  const paths = await writeAcceptanceReports(report, reportDir);
  return { report, paths };
}

async function allocateServicePorts(services, runtime) {
  for (const service of services) {
    const ports = {};
    for (const [name, requested] of Object.entries(service.ports ?? {})) {
      ports[name] = Number(requested) > 0 ? Number(requested) : await reservePort();
    }
    runtime.services[service.id] = { ports };
  }
}

async function startService(service, runtime, reportDir, redactor) {
  const command = template(service.command, runtime);
  const cwd = resolveRuntimePath(template(service.cwd ?? runtime.root, runtime), runtime.root);
  const env = { ...runtime.env, ...template(service.env ?? {}, runtime) };
  const logPath = join(reportDir, "logs", `${safeName(service.id)}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "", "utf8");
  const [executable, ...args] = command;
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const logWrites = [];
  const writeLog = (stream, chunk) => {
    const pending = appendFile(logPath, `[${new Date().toISOString()}] ${stream} ${redactor(String(chunk))}`, "utf8").catch(() => {});
    logWrites.push(pending);
  };
  child.stdout.on("data", (chunk) => writeLog("stdout", chunk));
  child.stderr.on("data", (chunk) => writeLog("stderr", chunk));
  const spawnFailure = new Promise((_, reject) => child.once("error", reject));
  const earlyExit = new Promise((_, reject) => child.once("exit", (code, signal) => reject(new Error(`Service '${service.id}' exited before ready (code=${code}, signal=${signal})`))));
  const ready = waitForReady(template(service.ready, runtime), runtime);
  await Promise.race([ready, spawnFailure, earlyExit]);
  const record = {
    id: service.id,
    status: "passed",
    pid: child.pid,
    command,
    cwd,
    ports: runtime.services[service.id].ports,
    log: logPath,
  };
  const runningService = { id: service.id, child, record, stop: service.stop, stopping: false, logWrites };
  child.once("exit", (code, signal) => {
    if (!runningService.stopping) {
      record.status = "failed";
      record.message = `Service exited unexpectedly (code=${code}, signal=${signal})`;
    }
  });
  return runningService;
}

async function stopService(service) {
  service.stopping = true;
  if (service.child && service.child.exitCode == null) {
    service.child.kill("SIGTERM");
    const exited = new Promise((resolve) => service.child.once("exit", resolve));
    await Promise.race([exited, sleep(3_000).then(() => {
      if (service.child.exitCode == null) service.child.kill("SIGKILL");
    })]);
  }
  await Promise.allSettled(service.logWrites ?? []);
}

async function waitForReady(ready, runtime) {
  const timeoutMs = Number(ready.timeoutMs ?? 20_000);
  const intervalMs = Number(ready.intervalMs ?? 150);
  const deadline = Date.now() + timeoutMs;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ready.url, { method: ready.method ?? "GET", headers: ready.headers });
      const text = await response.text();
      const statuses = ready.statuses ?? [ready.status ?? 200];
      if (statuses.includes(response.status) && (!ready.bodyIncludes || text.includes(ready.bodyIncludes))) return;
      last = `HTTP ${response.status}: ${text.slice(0, 300)}`;
    } catch (error) { last = error.message; }
    await sleep(intervalMs);
  }
  throw new Error(`Readiness probe timed out for ${ready.url}: ${last}`);
}

async function runCheck(rawCheck, runtime, redactor) {
  const check = template(rawCheck, runtime);
  const started = Date.now();
  try {
    const output = await CHECK_HANDLERS[check.type](check, runtime);
    return {
      id: check.id,
      type: check.type,
      status: "passed",
      durationMs: Date.now() - started,
      message: output.message ?? "Passed",
      evidence: redactObject(output.evidence ?? {}, redactor),
    };
  } catch (error) {
    return {
      id: check.id,
      type: check.type,
      status: "failed",
      durationMs: Date.now() - started,
      message: error.message,
      evidence: redactObject(error.evidence ?? { stack: error.stack }, redactor),
    };
  }
}

const CHECK_HANDLERS = {
  async file(check, runtime) {
    const path = resolveRuntimePath(check.path, runtime.root);
    const expectedExists = check.exists !== false;
    let exists = true;
    try { await access(path, constants.F_OK); } catch { exists = false; }
    assert(exists === expectedExists, `Expected file ${path} to ${expectedExists ? "exist" : "not exist"}`, { path, exists });
    if (!exists) return { message: "File absence confirmed", evidence: { path } };
    const metadata = await stat(path);
    assert(check.kind !== "file" || metadata.isFile(), `${path} is not a file`);
    assert(check.kind !== "directory" || metadata.isDirectory(), `${path} is not a directory`);
    if (check.minBytes != null) assert(metadata.size >= check.minBytes, `${path} is smaller than ${check.minBytes} bytes`, { size: metadata.size });
    let text;
    if (check.contains != null || check.notContains != null || check.matches != null) text = await readFile(path, "utf8");
    if (check.contains != null) assert(text.includes(check.contains), `${path} does not contain expected text`, { expected: check.contains, preview: text.slice(0, 1_000) });
    if (check.notContains != null) assert(!text.includes(check.notContains), `${path} contains forbidden text`, { forbidden: check.notContains });
    if (check.matches != null) assert(new RegExp(check.matches, check.flags).test(text), `${path} does not match ${check.matches}`);
    return { message: "File check passed", evidence: { path, bytes: metadata.size } };
  },

  async json(check, runtime) {
    const path = resolveRuntimePath(check.path, runtime.root);
    const value = await readJson(path);
    const actual = getJsonPointer(value, check.pointer ?? "");
    if ("exists" in check) assert((actual !== undefined) === Boolean(check.exists), `JSON pointer existence mismatch: ${check.pointer}`, { actual });
    if ("equals" in check) assert(deepEqual(actual, check.equals), `JSON value mismatch at ${check.pointer ?? "/"}`, { actual, expected: check.equals });
    if (check.includes != null) assert(String(actual).includes(String(check.includes)), `JSON value does not include '${check.includes}'`, { actual });
    if (check.matches != null) assert(new RegExp(check.matches, check.flags).test(String(actual)), `JSON value does not match ${check.matches}`, { actual });
    return { message: "JSON check passed", evidence: { path, pointer: check.pointer ?? "", actual } };
  },

  async command(check, runtime) {
    const result = await runProcess(check.command, {
      cwd: resolveRuntimePath(check.cwd ?? runtime.root, runtime.root),
      env: check.env,
      timeoutMs: check.timeoutMs,
      stdin: check.stdin,
    });
    const expectedCode = check.expect?.exitCode ?? 0;
    assert(result.code === expectedCode, `Command exited ${result.code}; expected ${expectedCode}`, result);
    for (const value of asArray(check.expect?.stdoutIncludes)) assert(result.stdout.includes(value), `stdout missing '${value}'`, result);
    for (const value of asArray(check.expect?.stderrIncludes)) assert(result.stderr.includes(value), `stderr missing '${value}'`, result);
    for (const value of asArray(check.expect?.stdoutNotIncludes)) assert(!result.stdout.includes(value), `stdout contains forbidden '${value}'`, result);
    for (const value of asArray(check.expect?.stderrNotIncludes)) assert(!result.stderr.includes(value), `stderr contains forbidden '${value}'`, result);
    if (check.expect?.stdoutMatches) assert(new RegExp(check.expect.stdoutMatches, check.expect.flags).test(result.stdout), "stdout regex did not match", result);
    return { message: "Command passed", evidence: limitProcessEvidence(result) };
  },

  async http(check) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), check.timeoutMs ?? 15_000);
    try {
      const body = check.json !== undefined ? JSON.stringify(check.json) : check.body;
      const headers = { ...(check.headers ?? {}) };
      if (check.json !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
      const response = await fetch(check.url, { method: check.method ?? (body == null ? "GET" : "POST"), headers, body, signal: controller.signal });
      const text = await response.text();
      const expectedStatus = check.expect?.status ?? 200;
      assert(response.status === expectedStatus, `HTTP ${response.status}; expected ${expectedStatus}`, { status: response.status, body: text.slice(0, 4_000) });
      for (const value of asArray(check.expect?.bodyIncludes)) assert(text.includes(value), `HTTP body missing '${value}'`, { body: text.slice(0, 4_000) });
      for (const value of asArray(check.expect?.bodyNotIncludes)) assert(!text.includes(value), `HTTP body contains forbidden '${value}'`, { body: text.slice(0, 4_000) });
      let parsed;
      if (check.expect?.jsonPointer != null || "equals" in (check.expect ?? {})) {
        try { parsed = JSON.parse(text); } catch { throw evidenceError("HTTP response is not JSON", { body: text.slice(0, 4_000) }); }
        const actual = getJsonPointer(parsed, check.expect.jsonPointer ?? "");
        if ("equals" in check.expect) assert(deepEqual(actual, check.expect.equals), "HTTP JSON value mismatch", { actual, expected: check.expect.equals });
      }
      return { message: `HTTP ${response.status}`, evidence: { status: response.status, headers: Object.fromEntries(response.headers), body: text.slice(0, 4_000) } };
    } finally { clearTimeout(timer); }
  },

  async llm(check) {
    const body = {
      model: check.model,
      input: check.input,
      stream: Boolean(check.stream),
      ...(check.instructions ? { instructions: check.instructions } : {}),
      ...(check.tools ? { tools: check.tools } : {}),
      ...(check.toolChoice ? { tool_choice: check.toolChoice } : {}),
    };
    const headers = { "content-type": "application/json", ...(check.headers ?? {}) };
    const response = await fetch(check.endpoint ?? check.url, { method: "POST", headers, body: JSON.stringify(body) });
    const expectedStatus = check.expect?.status ?? 200;
    if (response.status !== expectedStatus) {
      const text = await response.text();
      throw evidenceError(`LLM HTTP ${response.status}; expected ${expectedStatus}`, { body: text.slice(0, 4_000) });
    }
    const evidence = check.stream ? await parseResponsesSseEvidence(response) : parseResponsesJsonEvidence(await response.json());
    for (const value of asArray(check.expect?.textIncludes)) assert(evidence.outputText.includes(value), `LLM output missing '${value}'`, evidence);
    if (check.expect?.toolName) assert(evidence.toolCalls.some((tool) => tool.name === check.expect.toolName), `LLM did not call tool '${check.expect.toolName}'`, evidence);
    for (const outputType of asArray(check.expect?.outputType)) {
      assert(evidence.outputTypes.includes(outputType), `LLM output did not include item type '${outputType}'`, evidence);
    }
    for (const outputType of asArray(check.expect?.outputNotType)) {
      assert(!evidence.outputTypes.includes(outputType), `LLM output unexpectedly included item type '${outputType}'`, evidence);
    }
    if (check.expect?.statusValue) assert(evidence.status === check.expect.statusValue, `LLM status '${evidence.status}' does not equal '${check.expect.statusValue}'`, evidence);
    return { message: "LLM contract passed", evidence };
  },
};

async function parseResponsesSseEvidence(response) {
  let outputText = "";
  let status = "in_progress";
  const tools = new Map();
  const outputItems = new Map();
  for await (const frame of parseSse(response.body)) {
    if (!frame.data) continue;
    const event = JSON.parse(frame.data);
    if (event.type === "response.output_text.delta") outputText += event.delta ?? "";
    else if (event.type === "response.output_item.added") {
      if (event.item?.type) outputItems.set(event.output_index, event.item);
      if (["function_call", "custom_tool_call", "tool_search_call"].includes(event.item?.type)) {
        tools.set(event.output_index, {
          name: event.item.type === "tool_search_call" ? "tool_search" : event.item.name,
          arguments: event.item.type === "tool_search_call" ? JSON.stringify(event.item.arguments ?? {}) : "",
          namespace: event.item.namespace,
          execution: event.item.execution,
          kind: event.item.type === "tool_search_call" ? "tool_search" : event.item.type === "custom_tool_call" ? "custom" : "function",
        });
      }
    } else if (event.type === "response.output_item.done") {
      if (event.item?.type) outputItems.set(event.output_index, event.item);
      if (event.item?.type === "tool_search_call") {
        tools.set(event.output_index, {
          name: "tool_search",
          arguments: JSON.stringify(event.item.arguments ?? {}),
          execution: event.item.execution,
          kind: "tool_search",
        });
      }
    } else if (["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(event.type)) {
      const tool = tools.get(event.output_index);
      if (tool) tool.arguments += event.delta ?? "";
    } else if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) status = event.response?.status ?? event.type.split(".")[1];
  }
  const items = [...outputItems.values()];
  return {
    status,
    outputText,
    outputTypes: items.map((item) => item.type).filter(Boolean),
    compactionItems: items.filter((item) => item.type === "compaction"),
    toolCalls: [...tools.values()],
  };
}

function parseResponsesJsonEvidence(response) {
  const items = response.output ?? [];
  const outputText = items.flatMap((item) => item.type === "message" ? item.content ?? [] : []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
  const toolCalls = items
    .filter((item) => ["function_call", "custom_tool_call", "tool_search_call"].includes(item.type))
    .map((item) => ({
      name: item.type === "tool_search_call" ? "tool_search" : item.name,
      arguments: item.type === "tool_search_call" ? JSON.stringify(item.arguments ?? {}) : item.arguments ?? item.input,
      namespace: item.namespace,
      execution: item.execution,
      kind: item.type === "tool_search_call" ? "tool_search" : item.type === "custom_tool_call" ? "custom" : "function",
    }));
  return {
    status: response.status,
    outputText,
    outputTypes: items.map((item) => item.type).filter(Boolean),
    compactionItems: items.filter((item) => item.type === "compaction"),
    toolCalls,
    responseId: response.id,
    usage: response.usage,
  };
}

function template(value, runtime) {
  if (Array.isArray(value)) return value.map((entry) => template(entry, runtime));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, template(entry, runtime)]));
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const resolved = path.trim().split(".").reduce((current, key) => current?.[key], runtime);
    if (resolved === undefined) throw new Error(`Unknown acceptance template '${path.trim()}'`);
    return String(resolved);
  });
}

function resolveRuntimePath(path, root) { return isAbsolute(path) ? path : resolve(root, path); }
function asArray(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function safeName(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, "_"); }
function quoteRelative(root, path) { const rel = path.startsWith(root) ? `./${path.slice(root.length).replace(/^[/\\]/, "")}` : path; return JSON.stringify(rel); }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function limitProcessEvidence(result) { return { ...result, stdout: result.stdout.slice(0, 8_000), stderr: result.stderr.slice(0, 8_000) }; }
function assert(condition, message, evidence) { if (!condition) throw evidenceError(message, evidence); }
function evidenceError(message, evidence) { const error = new Error(message); error.evidence = evidence; return error; }

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
