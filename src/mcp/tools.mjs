import { loadConfig, sanitizeConfig, validateConfig } from "../config.mjs";
import { runDoctor } from "../doctor.mjs";
import { describeRoute } from "../router.mjs";
import { renderCodexConfig } from "../codex-config.mjs";
import { runAcceptance } from "../acceptance/runner.mjs";

export const MCP_TOOLS = [
  {
    name: "aocx_validate_config",
    title: "Validate Agent OpenCodex configuration",
    description: "Validate an Agent OpenCodex JSON configuration without changing the machine.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { configPath: { type: "string", description: "Path to config.json" } },
      required: ["configPath"],
      additionalProperties: false,
    },
  },
  {
    name: "aocx_doctor",
    title: "Diagnose Agent OpenCodex",
    description: "Run deterministic environment, security, provider, and route diagnostics.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        configPath: { type: "string" },
        probe: { type: "boolean", description: "Also perform network probes to configured providers" },
      },
      required: ["configPath"],
      additionalProperties: false,
    },
  },
  {
    name: "aocx_route",
    title: "Explain model routing",
    description: "Show the ordered provider/model candidates for a model selector or named route.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { configPath: { type: "string" }, model: { type: "string" } },
      required: ["configPath", "model"],
      additionalProperties: false,
    },
  },
  {
    name: "aocx_render_codex_config",
    title: "Render Codex configuration",
    description: "Render a Codex config.toml fragment. This never edits Codex configuration automatically.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        configPath: { type: "string" },
        model: { type: "string" },
        providerId: { type: "string" },
        baseUrl: { type: "string" },
      },
      required: ["configPath"],
      additionalProperties: false,
    },
  },
  {
    name: "aocx_verify",
    title: "Run trusted acceptance specification",
    description: "Run a trusted local acceptance specification and generate JSON, JUnit, Markdown, logs, and a SHA-256 manifest.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        specPath: { type: "string" },
        reportDir: { type: "string" },
        failFast: { type: "boolean" },
      },
      required: ["specPath"],
      additionalProperties: false,
    },
  },
  {
    name: "aocx_health",
    title: "Check Agent OpenCodex health",
    description: "Read an Agent OpenCodex health or readiness endpoint.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Defaults to http://127.0.0.1:10101/readyz" },
        tokenEnv: { type: "string", description: "Environment variable containing the optional gateway bearer token" },
      },
      additionalProperties: false,
    },
  },
];

export async function callMcpTool(name, args = {}, options = {}) {
  switch (name) {
    case "aocx_validate_config": {
      const { config, path, warnings } = await loadConfig(requireString(args.configPath, "configPath"), { env: options.env });
      return { valid: validateConfig(config, { env: options.env }).valid, path, warnings, config: sanitizeConfig(config) };
    }
    case "aocx_doctor": {
      const { config, path } = await loadConfig(requireString(args.configPath, "configPath"), { env: options.env });
      return { configPath: path, ...await runDoctor(config, { env: options.env, probe: Boolean(args.probe) }) };
    }
    case "aocx_route": {
      const { config } = await loadConfig(requireString(args.configPath, "configPath"), { env: options.env });
      return { model: requireString(args.model, "model"), candidates: describeRoute(args.model, config) };
    }
    case "aocx_render_codex_config": {
      const { config } = await loadConfig(requireString(args.configPath, "configPath"), { env: options.env });
      return { toml: renderCodexConfig(config, { model: args.model, providerId: args.providerId, baseUrl: args.baseUrl }) };
    }
    case "aocx_verify": {
      const result = await runAcceptance({
        specPath: requireString(args.specPath, "specPath"),
        reportDir: args.reportDir,
        failFast: Boolean(args.failFast),
        env: options.env,
      });
      return { ok: result.report.ok, summary: result.report.summary, reportDir: result.report.reportDir, paths: result.paths };
    }
    case "aocx_health": {
      const url = args.url ?? "http://127.0.0.1:10101/readyz";
      const token = args.tokenEnv ? (options.env ?? process.env)[args.tokenEnv] : undefined;
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      const response = await fetch(url, { headers });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { ok: response.ok, status: response.status, body };
    }
    default:
      throw new Error(`Unknown MCP tool '${name}'`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
  return value;
}
