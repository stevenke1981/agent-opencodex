import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createGateway } from "./server.mjs";
import { createMockProvider } from "./mock-provider.mjs";
import {
  createPresetConfig,
  isLoopbackHost,
  loadConfig,
  resolveConfigPath,
  sanitizeConfig,
  validateConfig,
  writeConfig,
} from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { runDoctor } from "./doctor.mjs";
import { describeRoute } from "./router.mjs";
import { renderCodexConfig } from "./codex-config.mjs";
import { runAcceptance } from "./acceptance/runner.mjs";
import { runMcpServer } from "./mcp/server.mjs";
import { VERSION } from "./version.mjs";
import { AocxError, ConfigError } from "./errors.mjs";

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const parsed = parseArgs(argv);
  const requestedCommand = parsed.positionals.shift();
  const command = parsed.flags.get("help") ? "help" : parsed.flags.get("version") ? "version" : requestedCommand ?? "help";
  let exitCode = 0;

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(helpText());
        break;
      case "version":
      case "--version":
      case "-v":
        stdout.write(`${VERSION}\n`);
        break;
      case "init":
        await commandInit(parsed, { stdout, env });
        break;
      case "serve":
      case "start":
        await commandServe(parsed, { stdout, stderr, env });
        break;
      case "mock":
        await commandMock(parsed, { stdout });
        break;
      case "validate":
        exitCode = await commandValidate(parsed, { stdout, env }) ?? 0;
        break;
      case "doctor":
        exitCode = await commandDoctor(parsed, { stdout, env });
        break;
      case "health":
      case "status":
        exitCode = await commandHealth(parsed, { stdout, env });
        break;
      case "routes":
      case "route":
        await commandRoutes(parsed, { stdout, env });
        break;
      case "codex-config":
        await commandCodexConfig(parsed, { stdout, env });
        break;
      case "verify":
      case "accept":
        exitCode = await commandVerify(parsed, { stdout, env });
        break;
      case "mcp":
        await runMcpServer({ env, input: io.stdin ?? process.stdin, output: stdout });
        break;
      default:
        throw new CliUsageError(`Unknown command '${command}'`);
    }
  } catch (error) {
    const json = parsed.flags.get("json") === true;
    const payload = { ok: false, error: { name: error.name, code: error.code ?? "cli_error", message: error.message, details: error.details } };
    stderr.write(json ? `${JSON.stringify(payload)}\n` : `Error: ${error.message}\n`);
    if (error instanceof CliUsageError || error instanceof ConfigError) exitCode = 2;
    else if (error instanceof AocxError) exitCode = error.status >= 500 ? 3 : 2;
    else exitCode = 3;
  }
  return exitCode;
}

async function commandInit(args, { stdout, env }) {
  const preset = stringFlag(args, "preset", "openrouter");
  const path = stringFlag(args, "config", resolveConfigPath(undefined));
  const config = createPresetConfig(preset, {
    model: optionalStringFlag(args, "model"),
    providerId: optionalStringFlag(args, "provider-id"),
    baseUrl: optionalStringFlag(args, "base-url"),
    apiKeyEnv: optionalStringFlag(args, "api-key-env"),
    wireApi: optionalStringFlag(args, "wire-api"),
    host: optionalStringFlag(args, "host"),
    port: optionalNumberFlag(args, "port"),
  });
  const host = config.server.host;
  const requestedAuth = optionalStringFlag(args, "client-auth");
  if (requestedAuth) config.server.clientAuth.mode = requestedAuth;
  else if (!isLoopbackHost(host)) config.server.clientAuth.mode = "bearer";
  if (optionalStringFlag(args, "client-token-env")) config.server.clientAuth.tokenEnv = stringFlag(args, "client-token-env");
  const validation = validateConfig(config, { env });
  if (!validation.valid) throw new ConfigError("Generated configuration is invalid", validation.errors);
  const written = await writeConfig(path, config, { force: booleanFlag(args, "force") });
  const toml = renderCodexConfig(config);
  print(args, stdout, {
    ok: true,
    configPath: written,
    warnings: validation.warnings,
    provider: config.defaults.provider,
    model: config.defaults.model,
    codexConfig: toml,
    next: [
      `Set ${config.providers[config.defaults.provider].apiKeyEnv ?? "the provider credential if required"}`,
      `aocx doctor --config ${written} --json`,
      `aocx serve --config ${written}`,
    ],
  }, `Created ${written}\n\nCodex config.toml fragment:\n\n${toml}`);
}

async function commandServe(args, { stdout, env }) {
  const { config, path, warnings } = await loadConfig(stringFlag(args, "config", resolveConfigPath(undefined)), { env });
  if (args.flags.has("host")) config.server.host = stringFlag(args, "host");
  if (args.flags.has("port")) config.server.port = numberFlag(args, "port");
  if (booleanFlag(args, "json-log")) config.logging.json = true;
  const validation = validateConfig(config, { env });
  if (!validation.valid) throw new ConfigError("Configuration validation failed", validation.errors);
  const logger = createLogger({
    level: config.logging.level,
    json: config.logging.json,
    logFile: config.logging.file,
    env,
  });
  const gateway = createGateway({ config, env, logger });
  const address = await gateway.start();
  print(args, stdout, { ok: true, configPath: path, warnings, address, pid: process.pid }, `Agent OpenCodex ${VERSION} listening on http://${displayHost(address.host)}:${address.port}\n`);
  await waitForSignals(async () => gateway.stop());
}

async function commandMock(args, { stdout }) {
  const mock = createMockProvider({
    host: stringFlag(args, "host", "127.0.0.1"),
    port: numberFlag(args, "port", 0),
    name: optionalStringFlag(args, "name"),
  });
  const address = await mock.start();
  print(args, stdout, { ok: true, address, pid: process.pid }, `Mock provider listening on http://${displayHost(address.host)}:${address.port}\n`);
  await waitForSignals(async () => mock.stop());
}

async function commandValidate(args, { stdout, env }) {
  const { config, path, warnings } = await loadConfig(stringFlag(args, "config", resolveConfigPath(undefined)), { env });
  const result = validateConfig(config, { env });
  print(args, stdout, { ok: result.valid, path, warnings: [...warnings, ...result.warnings], errors: result.errors, config: sanitizeConfig(config) }, result.valid ? `Valid: ${path}\n` : `Invalid: ${path}\n${result.errors.join("\n")}\n`);
  if (!result.valid) return 2;
}

async function commandDoctor(args, { stdout, env }) {
  const { config, path } = await loadConfig(stringFlag(args, "config", resolveConfigPath(undefined)), { env });
  const result = await runDoctor(config, {
    env,
    probe: booleanFlag(args, "probe"),
    inference: booleanFlag(args, "inference"),
    timeoutMs: optionalNumberFlag(args, "timeout"),
  });
  print(args, stdout, { configPath: path, ...result }, formatDoctor(result, path));
  return result.ok ? 0 : 1;
}

async function commandHealth(args, { stdout, env }) {
  const url = stringFlag(args, "url", "http://127.0.0.1:10101/readyz");
  if (args.flags.has("token")) throw new CliUsageError("Do not pass bearer tokens on the command line; use --token-env");
  const token = optionalStringFlag(args, "token-env") ? env[stringFlag(args, "token-env")] : undefined;
  let response;
  try {
    response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : undefined });
  } catch (error) {
    print(args, stdout, { ok: false, status: null, url, error: error.message }, `NOT READY ${url}\n${error.message}\n`);
    return 1;
  }
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  print(args, stdout, { ok: response.ok, status: response.status, url, body }, `${response.ok ? "READY" : "NOT READY"} HTTP ${response.status} ${url}\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n`);
  return response.ok ? 0 : 1;
}

async function commandRoutes(args, { stdout, env }) {
  const { config, path } = await loadConfig(stringFlag(args, "config", resolveConfigPath(undefined)), { env });
  const model = optionalStringFlag(args, "model") ?? args.positionals[0] ?? config.defaults.model;
  const candidates = describeRoute(model, config);
  print(args, stdout, { ok: true, configPath: path, model, candidates }, candidates.map((candidate, index) => `${index + 1}. ${candidate.provider}/${candidate.upstreamModel} (${candidate.providerType})`).join("\n") + "\n");
}

async function commandCodexConfig(args, { stdout, env }) {
  const { config } = await loadConfig(stringFlag(args, "config", resolveConfigPath(undefined)), { env });
  const toml = renderCodexConfig(config, {
    model: optionalStringFlag(args, "model"),
    providerId: optionalStringFlag(args, "provider-id"),
    baseUrl: optionalStringFlag(args, "base-url"),
    host: optionalStringFlag(args, "host"),
    port: optionalNumberFlag(args, "port"),
  });
  const output = optionalStringFlag(args, "output");
  if (output) await writeFile(resolve(output), toml, "utf8");
  print(args, stdout, { ok: true, output: output ? resolve(output) : null, toml }, output ? `Wrote ${resolve(output)}\n` : toml);
}

async function commandVerify(args, { stdout, env }) {
  const specPath = stringFlag(args, "spec");
  const result = await runAcceptance({
    specPath,
    reportDir: optionalStringFlag(args, "report-dir"),
    failFast: booleanFlag(args, "fail-fast"),
    env,
  });
  print(args, stdout, {
    ok: result.report.ok,
    summary: result.report.summary,
    reportDir: result.report.reportDir,
    paths: result.paths,
  }, `${result.report.ok ? "PASS" : "FAIL"}: ${result.report.name}\nReport: ${result.paths.markdownPath}\n`);
  return result.report.ok ? 0 : 1;
}

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") { positionals.push(...argv.slice(index + 1)); break; }
    if (value === "-h") { flags.set("help", true); continue; }
    if (value === "-v") { flags.set("version", true); continue; }
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const equal = value.indexOf("=");
    let key = value.slice(2, equal >= 0 ? equal : undefined);
    if (key.startsWith("no-")) { flags.set(key.slice(3), false); continue; }
    if (equal >= 0) { flags.set(key, value.slice(equal + 1)); continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); index += 1; }
    else flags.set(key, true);
  }
  return { flags, positionals };
}

function booleanFlag(args, name) { return args.flags.get(name) === true || args.flags.get(name) === "true"; }
function optionalStringFlag(args, name) {
  const value = args.flags.get(name);
  if (value === undefined || value === false) return undefined;
  if (value === true) throw new CliUsageError(`--${name} requires a value`);
  return String(value);
}
function stringFlag(args, name, fallback) {
  const value = optionalStringFlag(args, name);
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new CliUsageError(`--${name} is required`);
}
function optionalNumberFlag(args, name) {
  const value = optionalStringFlag(args, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliUsageError(`--${name} must be numeric`);
  return number;
}
function numberFlag(args, name, fallback) {
  const value = optionalNumberFlag(args, name);
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new CliUsageError(`--${name} is required`);
}

function print(args, stdout, jsonValue, textValue) {
  stdout.write(booleanFlag(args, "json") ? `${JSON.stringify(jsonValue)}\n` : textValue);
}

function formatDoctor(result, path) {
  const lines = [`Doctor: ${result.status.toUpperCase()} (${path})`];
  for (const check of result.checks) lines.push(`${symbol(check.status)} ${check.id}: ${check.message}`);
  lines.push(`Summary: ${result.counts.pass} pass, ${result.counts.warn} warn, ${result.counts.fail} fail`, "");
  return lines.join("\n");
}
function symbol(status) { return status === "pass" ? "PASS" : status === "warn" ? "WARN" : "FAIL"; }
function displayHost(host) { return String(host).includes(":") && !String(host).startsWith("[") ? `[${host}]` : host; }

function waitForSignals(stop) {
  return new Promise((resolvePromise, reject) => {
    let stopping = false;
    const handler = async () => {
      if (stopping) return;
      stopping = true;
      try { await stop(); resolvePromise(); }
      catch (error) { reject(error); }
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  });
}

function helpText() {
  return `Agent OpenCodex ${VERSION}\n\nUsage:\n  aocx <command> [options]\n\nAgent-safe commands:\n  init          Create a config; never edits Codex automatically\n  serve         Run the Responses API gateway in the foreground\n  mock          Run the offline multi-protocol mock provider\n  validate      Validate and sanitize a config\n  doctor        Check runtime, binding, credentials, routes, and optional probes\n  health        Check /healthz or /readyz\n  routes        Explain ordered provider/model routing\n  codex-config  Render a config.toml fragment without writing it unless --output is given\n  verify        Run evidence-based acceptance tests\n  mcp           Start the stdio MCP control server\n  version       Print the version\n\nCommon options:\n  --config <path>      Configuration path\n  --json               Emit one machine-readable JSON object\n\nDoctor options:\n  --probe              Probe provider model catalogs\n  --inference          Run a minimal end-to-end model inference (may consume provider usage)\n  --timeout <ms>       Set probe timeout\n\nExamples:\n  aocx init --preset openrouter --model deepseek/deepseek-v4-flash-latest --json\n  aocx serve --config ~/.agent-opencodex/config.json\n  aocx verify --spec ./examples/acceptance.smoke.json --report-dir ./artifacts/acceptance\n  aocx mcp\n`;
}

class CliUsageError extends Error { constructor(message) { super(message); this.name = "CliUsageError"; } }
