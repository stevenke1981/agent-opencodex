import { ConfigError } from "./errors.mjs";

export function renderCodexConfig(config, options = {}) {
  const providerId = sanitizeTomlIdentifier(options.providerId ?? "agent_opencodex");
  const name = options.name ?? "Agent OpenCodex";
  const model = options.model ?? config.defaults?.model;
  if (!model) throw new ConfigError("A default model is required to render Codex configuration");
  const host = normalizeClientHost(options.host ?? config.server?.host ?? "127.0.0.1");
  const port = Number(options.port ?? config.server?.port ?? 10101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid Codex gateway port: ${port}`);
  }
  const baseUrl = options.baseUrl ?? `http://${host}:${port}/v1`;
  const authMode = config.server?.clientAuth?.mode ?? "none";
  const tokenEnv = config.server?.clientAuth?.tokenEnv ?? "AGENT_OPENCODEX_CLIENT_KEY";
  const lines = [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(providerId)}`,
    "",
    `[model_providers.${providerId}]`,
    `name = ${tomlString(name)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = "responses"`,
    `supports_websockets = false`,
  ];
  if (authMode === "bearer") lines.push(`env_key = ${tomlString(tokenEnv)}`);
  lines.push("");
  return lines.join("\n");
}

export function sanitizeTomlIdentifier(value) {
  const normalized = String(value ?? "agent_opencodex")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[-]+/, "") || "agent_opencodex";
  if (!/^[A-Za-z_]/.test(normalized)) return `provider_${normalized}`;
  return normalized;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function normalizeClientHost(host) {
  if (["0.0.0.0", "::", "[::]"].includes(String(host))) return "127.0.0.1";
  return String(host).replace(/^\[(.*)\]$/, "$1");
}
