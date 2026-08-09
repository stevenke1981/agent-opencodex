import { resolveRouteCandidates } from "./router.mjs";
import { validateConfig } from "./config.mjs";
import { createGateway } from "./server.mjs";
import { createLogger } from "./logger.mjs";
import { buildRedactor, collectSecretsFromEnv } from "./utils/redact.mjs";

export async function runDoctor(config, options = {}) {
  const env = options.env ?? process.env;
  const checks = [];
  const add = (id, status, message, details) => checks.push({ id, status, message, ...(details ? { details } : {}) });

  const validation = validateConfig(config, { env });
  add("config", validation.valid ? "pass" : "fail", validation.valid ? "Configuration is valid" : "Configuration is invalid", {
    errors: validation.errors,
    warnings: validation.warnings,
  });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 20 ? "pass" : "fail", `Node.js ${process.versions.node}`, { required: ">=20.11" });

  const remote = !["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.server?.host);
  const protectedRemote = !remote || config.server?.clientAuth?.mode === "bearer";
  add("binding", protectedRemote ? "pass" : "fail",
    remote ? "Remote listener is protected by bearer authentication" : "Gateway is bound to loopback");

  for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
    let parsed;
    try { parsed = new URL(provider.baseUrl); } catch { parsed = null; }
    add(`provider:${providerId}:url`, parsed ? "pass" : "fail", parsed
      ? `${providerId} base URL is valid`
      : `${providerId} base URL is invalid`);
    if (provider.apiKeyEnv) {
      add(`provider:${providerId}:credential`, env[provider.apiKeyEnv] ? "pass" : "warn",
        env[provider.apiKeyEnv]
          ? `${provider.apiKeyEnv} is available`
          : `${provider.apiKeyEnv} is not set`);
    } else {
      add(`provider:${providerId}:credential`, "pass", `${providerId} does not require an API-key environment variable`);
    }
  }

  try {
    const candidates = resolveRouteCandidates(config.defaults?.model, config);
    add("default-route", candidates.length ? "pass" : "fail", `Default route resolves to ${candidates.length} candidate(s)`, {
      candidates: candidates.map((entry) => ({ provider: entry.providerId, model: entry.upstreamModel })),
    });
  } catch (error) {
    add("default-route", "fail", error.message);
  }

  if (options.probe) {
    for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
      const probe = await probeProvider(providerId, provider, env, options.timeoutMs ?? 10_000);
      add(`provider:${providerId}:probe`, probe.status, probe.message, probe.details);
    }
  }

  if (options.inference) {
    const probe = await probeDefaultInference(config, env, options.timeoutMs ?? 30_000);
    add("default-route:inference", probe.status, probe.message, probe.details);
  }

  const counts = checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] ?? 0) + 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0 });
  return {
    ok: counts.fail === 0,
    status: counts.fail ? "fail" : counts.warn ? "warn" : "pass",
    counts,
    checks,
  };
}

async function probeDefaultInference(config, env, timeoutMs) {
  const redact = buildRedactor(collectSecretsFromEnv(env));
  const probeConfig = structuredClone(config);
  probeConfig.server = {
    ...probeConfig.server,
    host: "127.0.0.1",
    port: 0,
    clientAuth: { mode: "none", tokenEnv: probeConfig.server?.clientAuth?.tokenEnv },
  };
  probeConfig.logging = { ...probeConfig.logging, level: "silent", file: null };
  const logger = createLogger({ level: "silent", quiet: true, env });
  const gateway = createGateway({ config: probeConfig, env, logger, shutdownGraceMs: 100 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const address = await gateway.start();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaults?.model,
        input: "Reply with OK.",
        max_output_tokens: 8,
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status !== "completed") {
      return {
        status: "fail",
        message: `Default model inference failed with HTTP ${response.status}`,
        details: {
          model: config.defaults?.model,
          status: response.status,
          code: body.error?.code,
          error: redact(body.error?.message),
        },
      };
    }
    const hasOutput = body.output?.some((item) =>
      item.type === "message" && item.content?.some((part) => part.type === "output_text" && part.text));
    return {
      status: hasOutput ? "pass" : "fail",
      message: hasOutput
        ? `Default model '${config.defaults?.model}' completed an end-to-end inference`
        : `Default model '${config.defaults?.model}' returned no output text`,
      details: { model: config.defaults?.model, status: response.status },
    };
  } catch (error) {
    return {
      status: "fail",
      message: `Default model inference failed: ${error.name === "AbortError" ? "timeout" : redact(error.message)}`,
      details: { model: config.defaults?.model },
    };
  } finally {
    clearTimeout(timer);
    await gateway.stop();
  }
}

async function probeProvider(providerId, provider, env, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const url = provider.healthUrl ?? provider.modelsUrl ?? defaultProbeUrl(provider);
    const headers = { accept: "application/json", ...(provider.headers ?? {}) };
    const key = provider.apiKey ?? (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined);
    if (key) {
      if (provider.type === "anthropic") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = provider.anthropicVersion ?? "2023-06-01";
      } else if (provider.type === "gemini") headers["x-goog-api-key"] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    return {
      status: response.ok ? "pass" : response.status === 401 || response.status === 403 ? "warn" : "fail",
      message: `${providerId} probe returned HTTP ${response.status}`,
      details: { url, status: response.status },
    };
  } catch (error) {
    return {
      status: "fail",
      message: `${providerId} probe failed: ${error.name === "AbortError" ? "timeout" : error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function defaultProbeUrl(provider) {
  const base = String(provider.baseUrl).replace(/\/+$/, "");
  if (provider.type === "gemini") return `${base}/models`;
  return `${base}/models`;
}
