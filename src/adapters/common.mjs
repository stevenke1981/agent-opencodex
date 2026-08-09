import { UpstreamError } from "../errors.mjs";
import { backoffDelay, createTimeoutSignal, sleep } from "../utils/async.mjs";

export function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

export function providerHeaders(candidate, env, defaults = {}) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json",
    ...defaults,
    ...(candidate.provider.headers ?? {}),
  };
  const apiKey = candidate.provider.apiKey ?? (candidate.provider.apiKeyEnv ? env[candidate.provider.apiKeyEnv] : undefined);
  return { headers, apiKey };
}

export async function fetchWithRetry(candidate, url, init, options = {}) {
  const provider = candidate.provider;
  const retries = provider.maxRetries ?? 1;
  const retryStatuses = new Set(provider.retryStatuses ?? [408, 409, 429, 500, 502, 503, 504]);
  const timeoutMs = provider.timeoutMs ?? options.timeoutMs ?? 300_000;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = createTimeoutSignal(timeoutMs, options.signal);
    try {
      const response = await fetch(url, { ...init, signal: timeout.signal });
      timeout.clearTimer();
      if (response.ok) return responseWithCleanup(response, () => timeout.dispose());

      const retryable = retryStatuses.has(response.status);
      const errorText = await readErrorText(response);
      timeout.dispose();
      lastError = new UpstreamError(formatProviderError(candidate.providerId, response.status, errorText), {
        provider: candidate.providerId,
        upstreamStatus: response.status,
        status: mapUpstreamStatus(response.status),
        retryable,
        code: "upstream_http_error",
      });
      if (!retryable || attempt >= retries) throw lastError;
      const delay = retryAfterMs(response.headers) ?? backoffDelay(attempt, provider.retryBaseMs ?? 250, provider.retryMaxMs ?? 4_000);
      await sleep(delay, options.signal);
    } catch (error) {
      timeout.dispose();
      if (error instanceof UpstreamError) {
        if (!error.retryable || attempt >= retries) throw error;
        lastError = error;
      } else if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      } else {
        lastError = new UpstreamError(`Provider '${candidate.providerId}' request failed: ${safeMessage(error)}`, {
          provider: candidate.providerId,
          status: 502,
          retryable: true,
          code: "upstream_network_error",
          cause: error,
        });
        if (attempt >= retries) throw lastError;
      }
      await sleep(backoffDelay(attempt, provider.retryBaseMs ?? 250, provider.retryMaxMs ?? 4_000), options.signal);
    }
  }
  throw lastError ?? new UpstreamError("Unknown upstream failure");
}

function responseWithCleanup(response, cleanup) {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    cleanup();
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finalize();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { finalize(); }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function readErrorText(response, maxBytes = 16_384) {
  try {
    const text = await response.text();
    return text.slice(0, maxBytes);
  } catch {
    return "";
  }
}

export function parseJsonSafe(text, fallback = undefined) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function usageFromOpenAI(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens,
    cached_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

export function stringifyToolResult(parts) {
  if (!Array.isArray(parts)) return String(parts ?? "");
  return parts.map((part) => part.type === "text" ? part.text : `[image: ${part.url}]`).join("\n");
}

function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return 502;
  if (status === 429) return 503;
  if (status >= 400 && status < 500) return 502;
  return status;
}

function formatProviderError(providerId, status, text) {
  const json = parseJsonSafe(text);
  const message = json?.error?.message ?? json?.message ?? text ?? `HTTP ${status}`;
  return `Provider '${providerId}' returned HTTP ${status}: ${String(message).slice(0, 2_000)}`;
}

function safeMessage(error) {
  if (error?.name === "AbortError") return "request aborted or timed out";
  return String(error?.message ?? error ?? "unknown error").slice(0, 1_000);
}
