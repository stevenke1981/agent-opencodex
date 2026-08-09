import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "./errors.mjs";
import { redactObject } from "./utils/redact.mjs";

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_PATH = join(homedir(), ".agent-opencodex", "config.json");
const PROVIDER_TYPES = new Set(["openai-chat", "openai-responses", "anthropic", "gemini"]);

export function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    server: {
      host: "127.0.0.1",
      port: 10101,
      requestTimeoutMs: 300_000,
      heartbeatMs: 2_000,
      maxBodyBytes: 20_000_000,
      clientAuth: {
        mode: "none",
        tokenEnv: "AGENT_OPENCODEX_CLIENT_KEY",
      },
    },
    logging: {
      level: "info",
      json: false,
      prompts: false,
      file: "~/.agent-opencodex/logs/gateway.jsonl",
    },
    continuation: {
      enabled: true,
      maxEntries: 256,
      ttlMs: 21_600_000,
    },
    defaults: {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash-latest",
    },
    routes: {
      "coding-fast": [
        { provider: "openrouter", model: "deepseek/deepseek-v4-flash-latest" },
      ],
    },
    providers: {
      openrouter: {
        type: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        models: ["deepseek/deepseek-v4-flash-latest"],
        headers: {
          "HTTP-Referer": "${OPENROUTER_SITE_URL:-http://localhost}",
          "X-Title": "${OPENROUTER_APP_NAME:-Agent OpenCodex}",
        },
        maxRetries: 2,
        retryStatuses: [408, 409, 429, 500, 502, 503, 504],
      },
    },
  };
}

export function expandHome(path) {
  if (typeof path !== "string") return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveConfigPath(path = process.env.AGENT_OPENCODEX_CONFIG || DEFAULT_CONFIG_PATH, cwd = process.cwd()) {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function interpolateEnv(value, env = process.env) {
  if (Array.isArray(value)) return value.map((entry) => interpolateEnv(entry, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolateEnv(entry, env)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g, (_, name, fallback) => {
    const resolved = env[name];
    if (resolved !== undefined && resolved !== "") return resolved;
    return fallback ?? "";
  });
}

export async function configExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(path, options = {}) {
  const configPath = resolveConfigPath(path, options.cwd);
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new ConfigError(`Configuration file not found: ${configPath}`, { configPath });
    throw new ConfigError(`Unable to read configuration: ${configPath}`, { cause: error.message });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in configuration: ${error.message}`, { configPath });
  }
  const config = normalizeConfig(interpolateEnv(raw, options.env ?? process.env), configPath);
  const validation = validateConfig(config, { env: options.env ?? process.env });
  if (!validation.valid) throw new ConfigError("Configuration validation failed", validation.errors);
  return { config, path: configPath, warnings: validation.warnings };
}

export function normalizeConfig(raw, configPath) {
  const defaults = createDefaultConfig();
  const config = {
    ...defaults,
    ...raw,
    server: { ...defaults.server, ...(raw.server ?? {}), clientAuth: { ...defaults.server.clientAuth, ...(raw.server?.clientAuth ?? {}) } },
    logging: { ...defaults.logging, ...(raw.logging ?? {}) },
    continuation: { ...defaults.continuation, ...(raw.continuation ?? {}) },
    defaults: { ...defaults.defaults, ...(raw.defaults ?? {}) },
    providers: raw.providers ?? defaults.providers,
    routes: raw.routes ?? {},
    _meta: {
      configPath,
      configDir: configPath ? dirname(configPath) : process.cwd(),
    },
  };
  if (config.logging.file) config.logging.file = expandHome(config.logging.file);
  return config;
}

export function validateConfig(config, options = {}) {
  const errors = [];
  const warnings = [];
  const env = options.env ?? process.env;
  if (!config || typeof config !== "object") return { valid: false, errors: ["Config must be an object"], warnings };
  if (config.version !== CONFIG_VERSION) errors.push(`Unsupported config version: ${config.version}; expected ${CONFIG_VERSION}`);

  const host = config.server?.host;
  const port = config.server?.port;
  if (typeof host !== "string" || !host) errors.push("server.host must be a non-empty string");
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push("server.port must be an integer from 0 to 65535");
  if (!Number.isInteger(config.server?.maxBodyBytes) || config.server.maxBodyBytes < 1_024) {
    errors.push("server.maxBodyBytes must be an integer >= 1024");
  }
  if (!Number.isInteger(config.server?.requestTimeoutMs) || config.server.requestTimeoutMs < 1_000) {
    errors.push("server.requestTimeoutMs must be an integer >= 1000");
  }

  const remote = host && !isLoopbackHost(host);
  const authMode = config.server?.clientAuth?.mode ?? "none";
  const tokenEnv = config.server?.clientAuth?.tokenEnv;
  if (!["none", "bearer"].includes(authMode)) errors.push("server.clientAuth.mode must be 'none' or 'bearer'");
  if (remote && authMode !== "bearer") {
    errors.push("Remote binding requires server.clientAuth.mode='bearer'");
  }
  if (authMode === "bearer") {
    if (typeof tokenEnv !== "string" || !tokenEnv) errors.push("Bearer auth requires server.clientAuth.tokenEnv");
    else if (!env[tokenEnv]) {
      const message = `Client token environment variable is not set: ${tokenEnv}`;
      if (remote) errors.push(message);
      else warnings.push(message);
    } else if (remote && String(env[tokenEnv]).length < 16) {
      errors.push(`Remote client token in ${tokenEnv} must be at least 16 characters`);
    }
  }

  if (!config.providers || typeof config.providers !== "object" || Object.keys(config.providers).length === 0) {
    errors.push("At least one provider is required");
  } else {
    for (const [id, provider] of Object.entries(config.providers)) {
      validateProvider(id, provider, errors, warnings, env);
    }
  }

  if (!config.defaults?.provider || !config.providers?.[config.defaults.provider]) {
    errors.push(`defaults.provider does not exist: ${config.defaults?.provider ?? "<missing>"}`);
  }
  if (typeof config.defaults?.model !== "string" || !config.defaults.model) errors.push("defaults.model must be a non-empty string");

  if (config.routes && typeof config.routes !== "object") errors.push("routes must be an object");
  for (const [routeName, candidates] of Object.entries(config.routes ?? {})) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      errors.push(`Route '${routeName}' must have at least one candidate`);
      continue;
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") {
        errors.push(`Route '${routeName}' has an invalid candidate`);
        continue;
      }
      if (!config.providers?.[candidate.provider]) errors.push(`Route '${routeName}' references missing provider '${candidate.provider}'`);
      if (typeof candidate.model !== "string" || !candidate.model) errors.push(`Route '${routeName}' candidate model is required`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateProvider(id, provider, errors, warnings, env) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) errors.push(`Invalid provider id '${id}'`);
  if (!provider || typeof provider !== "object") {
    errors.push(`Provider '${id}' must be an object`);
    return;
  }
  if (!PROVIDER_TYPES.has(provider.type)) errors.push(`Provider '${id}' has unsupported type '${provider.type}'`);
  if (typeof provider.baseUrl !== "string" || !/^https?:\/\//.test(provider.baseUrl)) {
    errors.push(`Provider '${id}' baseUrl must use http:// or https://`);
  }
  if (provider.apiKey !== undefined) errors.push(`Provider '${id}' may not contain inline apiKey; use apiKeyEnv`);
  if (provider.apiKeyEnv && typeof provider.apiKeyEnv !== "string") errors.push(`Provider '${id}' apiKeyEnv must be a string`);
  if (provider.apiKeyEnv && !env[provider.apiKeyEnv] && !isLocalBaseUrl(provider.baseUrl)) {
    warnings.push(`Provider '${id}' key environment variable is not set: ${provider.apiKeyEnv}`);
  }
  try {
    const providerUrl = new URL(provider.baseUrl);
    if (provider.apiKeyEnv && providerUrl.protocol === "http:" && !isLoopbackHost(providerUrl.hostname) && provider.allowInsecureHttp !== true) {
      errors.push(`Provider '${id}' would send credentials over non-loopback HTTP; use HTTPS or set allowInsecureHttp=true explicitly`);
    }
  } catch {
    // baseUrl validation reports the URL error above.
  }
  if (provider.models && (!Array.isArray(provider.models) || provider.models.some((model) => typeof model !== "string" || !model))) {
    errors.push(`Provider '${id}' models must be an array of non-empty strings`);
  }
  if (provider.maxRetries != null && (!Number.isInteger(provider.maxRetries) || provider.maxRetries < 0 || provider.maxRetries > 10)) {
    errors.push(`Provider '${id}' maxRetries must be an integer from 0 to 10`);
  }
  if (provider.headers && (typeof provider.headers !== "object" || Array.isArray(provider.headers))) {
    errors.push(`Provider '${id}' headers must be an object`);
  }
}

export function isLoopbackHost(host) {
  const normalized = String(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

export function isLocalBaseUrl(baseUrl) {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function getProviderApiKey(provider, env = process.env) {
  if (provider.apiKey) return provider.apiKey;
  if (provider.apiKeyEnv) return env[provider.apiKeyEnv];
  return undefined;
}

export function getClientToken(config, env = process.env) {
  const tokenEnv = config.server?.clientAuth?.tokenEnv;
  return tokenEnv ? env[tokenEnv] : undefined;
}

export function sanitizeConfig(config) {
  const copy = structuredClone(config);
  delete copy._meta;
  for (const provider of Object.values(copy.providers ?? {})) {
    if (provider.apiKey) provider.apiKey = "[REDACTED]";
    if (provider.headers) provider.headers = redactObject(provider.headers);
  }
  return copy;
}

export async function writeConfig(path, config, options = {}) {
  const configPath = resolveConfigPath(path, options.cwd);
  if (!options.force && await configExists(configPath)) {
    throw new ConfigError(`Refusing to overwrite existing configuration: ${configPath}`, { configPath });
  }
  await mkdir(dirname(configPath), { recursive: true });
  const clean = structuredClone(config);
  delete clean._meta;
  await writeFile(configPath, `${JSON.stringify(clean, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return configPath;
}

export function createPresetConfig(preset, options = {}) {
  const model = options.model;
  const providerId = options.providerId ?? preset;
  const config = createDefaultConfig();
  config.providers = {};
  config.routes = {};
  config.defaults.provider = providerId;

  const presets = {
    openrouter: {
      type: "openai-chat",
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
      apiKeyEnv: options.apiKeyEnv ?? "OPENROUTER_API_KEY",
      models: [model ?? "deepseek/deepseek-v4-flash-latest"],
      headers: {
        "HTTP-Referer": "${OPENROUTER_SITE_URL:-http://localhost}",
        "X-Title": "${OPENROUTER_APP_NAME:-Agent OpenCodex}",
      },
    },
    openai: {
      type: options.wireApi === "responses" ? "openai-responses" : "openai-chat",
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      apiKeyEnv: options.apiKeyEnv ?? "OPENAI_API_KEY",
      models: [model ?? "gpt-5.6-luna"],
    },
    deepseek: {
      type: "openai-chat",
      baseUrl: options.baseUrl ?? "https://api.deepseek.com/v1",
      apiKeyEnv: options.apiKeyEnv ?? "DEEPSEEK_API_KEY",
      models: [model ?? "deepseek-chat"],
    },
    xai: {
      type: "openai-chat",
      baseUrl: options.baseUrl ?? "https://api.x.ai/v1",
      apiKeyEnv: options.apiKeyEnv ?? "XAI_API_KEY",
      models: [model ?? "grok-code-fast-1"],
    },
    ollama: {
      type: "openai-chat",
      baseUrl: options.baseUrl ?? "http://127.0.0.1:11434/v1",
      models: [model ?? "qwen3-coder"],
    },
    anthropic: {
      type: "anthropic",
      baseUrl: options.baseUrl ?? "https://api.anthropic.com/v1",
      apiKeyEnv: options.apiKeyEnv ?? "ANTHROPIC_API_KEY",
      models: [model ?? "claude-sonnet-4-6"],
      anthropicVersion: "2023-06-01",
    },
    gemini: {
      type: "gemini",
      baseUrl: options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
      apiKeyEnv: options.apiKeyEnv ?? "GEMINI_API_KEY",
      models: [model ?? "gemini-3-pro"],
    },
  };

  if (!presets[preset]) throw new ConfigError(`Unknown preset '${preset}'`, { presets: Object.keys(presets) });
  config.providers[providerId] = {
    ...presets[preset],
    maxRetries: 2,
    retryStatuses: [408, 409, 429, 500, 502, 503, 504],
  };
  config.defaults.model = config.providers[providerId].models[0];
  if (options.port != null) config.server.port = Number(options.port);
  if (options.host) config.server.host = options.host;
  return config;
}
