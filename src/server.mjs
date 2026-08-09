import http from "node:http";
import { createId, safeEqual } from "./utils/crypto.mjs";
import { withHeartbeat, createTimeoutSignal } from "./utils/async.mjs";
import { createLogger } from "./logger.mjs";
import { ContinuationStore } from "./continuation-store.mjs";
import { resolveRouteCandidates, listModels } from "./router.mjs";
import { parseResponsesRequest, canonicalMessagesForContinuation } from "./responses/parse.mjs";
import { ResponsesBridge, sseEventToString } from "./responses/bridge.mjs";
import { prepareAdapter } from "./adapters/index.mjs";
import { AocxError, RequestError, UpstreamError, toPublicError } from "./errors.mjs";
import { SERVICE_NAME, VERSION } from "./version.mjs";
import { buildCompactV1Output, COMPACT_PROMPT, extractCompactUserMessages } from "./responses/compaction.mjs";

export function createGateway(options) {
  if (!options?.config) throw new TypeError("createGateway requires config");
  const config = options.config;
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({
    level: config.logging?.level,
    json: config.logging?.json,
    logFile: config.logging?.file,
    env,
  });
  const continuationStore = options.continuationStore ?? new ContinuationStore(config.continuation);
  const shutdownGraceMs = Number.isFinite(options.shutdownGraceMs)
    ? Math.max(0, Number(options.shutdownGraceMs))
    : 1_000;
  const startedAt = Date.now();
  let server;
  let state = "stopped";
  let address;
  let activeRequests = 0;

  async function handler(req, res) {
    const requestId = createId("req");
    const requestLogger = logger.child({ requestId });
    activeRequests += 1;
    const finished = () => { activeRequests = Math.max(0, activeRequests - 1); };
    res.once("finish", finished);
    res.once("close", () => { if (!res.writableFinished) finished(); });

    setCommonHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { service: SERVICE_NAME, version: VERSION, status: "ok" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        const ready = state === "ready";
        sendJson(res, ready ? 200 : 503, {
          service: SERVICE_NAME,
          version: VERSION,
          status: ready ? "ready" : state,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          pid: process.pid,
          port: address?.port ?? null,
          active_requests: activeRequests,
        }, ready ? {} : { "retry-after": "1" });
        return;
      }

      authorizeClient(req, config, env);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, { object: "list", data: listModels(config) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleResponses(req, res, { config, env, logger: requestLogger, continuationStore, requestId });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        await handleCompact(req, res, { config, env, logger: requestLogger, continuationStore, requestId });
        return;
      }
      sendJson(res, 404, { error: { message: "Route not found", type: "not_found", code: "not_found", request_id: requestId } });
    } catch (error) {
      await requestLogger.error("request_failed", {
        method: req.method,
        path: url.pathname,
        code: error?.code,
        message: error?.message,
      });
      if (!res.headersSent) sendJson(res, error.status ?? 500, toPublicError(error, requestId));
      else if (!res.writableEnded) res.end();
    }
  }

  return {
    config,
    continuationStore,
    get state() { return state; },
    get address() { return address; },
    get server() { return server; },
    async start(overrides = {}) {
      if (server) return address;
      state = "starting";
      const host = overrides.host ?? config.server.host;
      const port = overrides.port ?? config.server.port;
      const current = http.createServer((req, res) => { handler(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, toPublicError(error, createId("req")));
        else res.destroy(error);
      }); });
      server = current;
      current.keepAliveTimeout = 65_000;
      current.headersTimeout = 70_000;
      current.requestTimeout = 0;
      try {
        await listen(current, port, host);
      } catch (error) {
        server = undefined;
        state = "stopped";
        throw error;
      }
      const raw = current.address();
      address = typeof raw === "object" && raw ? { host, port: raw.port, family: raw.family } : { host, port };
      state = "ready";
      await logger.info("gateway_ready", { ...address, version: VERSION });
      return address;
    },
    async stop() {
      if (!server) return;
      state = "stopping";
      const current = server;
      server = undefined;
      const closed = new Promise((resolve) => current.close(() => resolve()));
      current.closeIdleConnections?.();
      const forceTimer = setTimeout(() => current.closeAllConnections?.(), shutdownGraceMs);
      try {
        await closed;
      } finally {
        clearTimeout(forceTimer);
        address = undefined;
        state = "stopped";
        await logger.info("gateway_stopped");
      }
    },
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen(port, host); }
    catch (error) { onError(error); }
  });
}

async function handleResponses(req, res, context) {
  const body = await readJsonBody(req, context.config.server.maxBodyBytes);
  const parsed = parseResponsesRequest(body, {
    defaultModel: context.config.defaults.model,
    continuationStore: context.continuationStore,
  });
  if (parsed.compactionRequest) {
    parsed.tools = [];
    parsed.toolChoice = "none";
    parsed.store = false;
  }
  const abort = new AbortController();
  req.once("aborted", () => abort.abort(new AocxError("Client aborted request", { code: "client_cancelled", status: 499 })));
  res.once("close", () => {
    if (!res.writableEnded) abort.abort(new AocxError("Client disconnected", { code: "client_cancelled", status: 499 }));
  });
  const timeout = createTimeoutSignal(context.config.server.requestTimeoutMs, abort.signal);
  try {
    const { prepared, selected } = await prepareRouted(parsed, context, timeout.signal);

    await context.logger.info("route_selected", {
      selector: parsed.model,
      provider: selected.providerId,
      upstreamModel: selected.upstreamModel,
      stream: parsed.stream,
      warnings: parsed.warnings,
    });

    const bridge = new ResponsesBridge({ model: parsed.model, toolMetadata: parsed.toolMetadata, compaction: parsed.compactionRequest });
    const events = withHeartbeat(
      prepared.events,
      context.config.server.heartbeatMs,
      () => ({ type: "heartbeat" }),
      timeout.signal,
    );

    if (parsed.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-request-id": context.requestId,
      });
      res.write(sseEventToString(bridge.createdEvent()));
      let terminal = false;
      try {
        for await (const event of events) {
          const encoded = bridge.accept(event);
          if (["done", "incomplete", "error"].includes(event.type)) terminal = true;
          for (const outputEvent of encoded) res.write(sseEventToString(outputEvent));
        }
        if (!terminal) for (const outputEvent of bridge.complete()) res.write(sseEventToString(outputEvent));
      } catch (error) {
        if (!res.writableEnded) {
          for (const outputEvent of bridge.fail({ message: error.message, code: error.code ?? "stream_error" })) {
            res.write(sseEventToString(outputEvent));
          }
        }
      }
      rememberContinuation(parsed, bridge, context.continuationStore);
      res.end();
      return;
    }

    for await (const event of events) bridge.accept(event);
    if (bridge.status === "in_progress") bridge.complete();
    rememberContinuation(parsed, bridge, context.continuationStore);
    sendJson(res, 200, bridge.toResponseJson(), { "x-request-id": context.requestId });
  } finally {
    timeout.dispose();
  }
}

async function handleCompact(req, res, context) {
  const body = await readJsonBody(req, context.config.server.maxBodyBytes);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Compaction body must be a JSON object");
  if (typeof body.model !== "string" || !body.model) throw new RequestError("Compaction requires model");
  if (!Array.isArray(body.input)) throw new RequestError("Compaction requires input array");

  const abort = new AbortController();
  req.once("aborted", () => abort.abort(new AocxError("Client aborted request", { code: "client_cancelled", status: 499 })));
  res.once("close", () => {
    if (!res.writableEnded) abort.abort(new AocxError("Client disconnected", { code: "client_cancelled", status: 499 }));
  });
  const timeout = createTimeoutSignal(context.config.server.requestTimeoutMs, abort.signal);
  try {
    const parsed = parseResponsesRequest({
      model: body.model,
      input: body.input,
      instructions: COMPACT_PROMPT,
      stream: false,
      store: false,
      max_output_tokens: Number.isInteger(body.max_output_tokens) ? body.max_output_tokens : 4_096,
      tool_choice: "none",
      tools: [],
    }, { defaultModel: context.config.defaults.model, continuationStore: context.continuationStore });
    // The unary v1 endpoint returns replacement history rather than a v2 compaction item.
    parsed.compactionRequest = false;
    const { prepared, selected } = await prepareRouted(parsed, context, timeout.signal);
    await context.logger.info("compact_route_selected", {
      selector: parsed.model,
      provider: selected.providerId,
      upstreamModel: selected.upstreamModel,
    });
    const bridge = new ResponsesBridge({ model: parsed.model, toolMetadata: parsed.toolMetadata });
    for await (const event of prepared.events) bridge.accept(event);
    if (bridge.status === "in_progress") bridge.complete();
    if (bridge.status !== "completed") {
      throw new UpstreamError(bridge.toResponseJson().error?.message ?? "Compaction summarization failed", {
        code: "compaction_failed",
        status: 502,
      });
    }
    const summary = bridge.summary().outputText;
    sendJson(res, 200, { output: buildCompactV1Output(extractCompactUserMessages(body.input), summary) }, { "x-request-id": context.requestId });
  } finally {
    timeout.dispose();
  }
}

async function prepareRouted(parsed, context, signal) {
  const candidates = resolveRouteCandidates(parsed.model, context.config);
  let prepared;
  let selected;
  const failures = [];
  for (const candidate of candidates) {
    try {
      prepared = await prepareAdapter(candidate, parsed, {
        env: context.env,
        signal,
        timeoutMs: context.config.server.requestTimeoutMs,
      });
      selected = candidate;
      break;
    } catch (error) {
      failures.push({ provider: candidate.providerId, model: candidate.upstreamModel, code: error.code, message: error.message });
      await context.logger.warn("route_candidate_failed", failures.at(-1));
      if (!(error instanceof UpstreamError) || !error.retryable) throw error;
    }
  }
  if (!prepared || !selected) {
    throw new UpstreamError("All route candidates failed", {
      code: "all_candidates_failed",
      status: 503,
      retryable: true,
      details: failures,
    });
  }
  return { prepared, selected, failures };
}

function rememberContinuation(request, bridge, store) {
  if (request.compactionRequest || !request.store || !store.enabled) return;
  const summary = bridge.summary();
  if (!["completed", "incomplete"].includes(bridge.status)) return;
  store.set(bridge.id, { messages: canonicalMessagesForContinuation(request, summary) });
}

function authorizeClient(req, config, env) {
  if (config.server?.clientAuth?.mode !== "bearer") return;
  const envName = config.server.clientAuth.tokenEnv;
  const expected = env[envName];
  if (!expected) throw new AocxError(`Client authentication is enabled but ${envName} is not set`, { code: "auth_misconfigured", status: 503 });
  const authorization = req.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  const supplied = bearer || req.headers["x-agent-opencodex-key"];
  if (!supplied || !safeEqual(supplied, expected)) {
    throw new AocxError("Invalid or missing gateway bearer token", { code: "unauthorized", status: 401 });
  }
}

async function readJsonBody(req, maxBytes) {
  const contentType = String(req.headers["content-type"] ?? "application/json");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new RequestError("Content-Type must be application/json", { code: "unsupported_media_type", status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(`Request body exceeds ${maxBytes} bytes`, { code: "request_too_large", status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) throw new RequestError("Request body is empty");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new RequestError(`Invalid JSON: ${error.message}`);
  }
}

function setCommonHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isLocalOrigin(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-agent-opencodex-key");
  res.setHeader("access-control-expose-headers", "x-request-id");
  res.setHeader("vary", "Origin");
  res.setHeader("x-content-type-options", "nosniff");
}

function isLocalOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  } catch { return false; }
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}
