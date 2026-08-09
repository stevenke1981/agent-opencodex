import { AocxError } from "../errors.mjs";

export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException("Aborted", "AbortError"));
    timer = setTimeout(() => finish(resolve), ms);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timer;
  let parentAbort;
  let disposed = false;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const detachParent = () => {
    if (parentAbort) parentSignal?.removeEventListener("abort", parentAbort);
    parentAbort = undefined;
  };
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    clearTimer();
    detachParent();
  };

  if (parentSignal) {
    parentAbort = () => abort(parentSignal.reason);
    if (parentSignal.aborted) parentAbort();
    else parentSignal.addEventListener("abort", parentAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => abort(new AocxError(`Operation timed out after ${timeoutMs} ms`, {
      code: "timeout",
      status: 504,
      retryable: true,
    })), timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    clearTimer,
    // Compatibility alias: stop only the local deadline while retaining parent cancellation.
    cancel: clearTimer,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      detachParent();
    },
  };
}

export async function* withHeartbeat(iterable, intervalMs, heartbeatFactory, signal) {
  const iterator = iterable[Symbol.asyncIterator]();
  let pending = iterator.next();
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      const result = await pending;
      if (result.done) return;
      yield result.value;
      pending = iterator.next();
      continue;
    }

    const winner = await Promise.race([
      pending.then((result) => ({ type: "next", result })),
      sleep(intervalMs, signal).then(() => ({ type: "heartbeat" })),
    ]);
    if (winner.type === "heartbeat") {
      yield heartbeatFactory();
      continue;
    }
    if (winner.result.done) return;
    yield winner.result.value;
    pending = iterator.next();
  }
}

export async function collectAsync(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

export function backoffDelay(attempt, baseMs = 250, maxMs = 4_000) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt)));
  const jitter = Math.floor(Math.random() * Math.max(1, exponential * 0.2));
  return exponential + jitter;
}
