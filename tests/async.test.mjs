import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createTimeoutSignal, sleep } from "../src/utils/async.mjs";

test("sleep removes abort listeners after normal completion", async () => {
  const controller = new AbortController();
  const pending = sleep(5, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  await pending;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("timeout signal dispose removes its parent listener", () => {
  const parent = new AbortController();
  const timeout = createTimeoutSignal(10_000, parent.signal);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  timeout.dispose();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("clearing the local deadline keeps parent cancellation active until dispose", () => {
  const parent = new AbortController();
  const timeout = createTimeoutSignal(10_000, parent.signal);
  timeout.clearTimer();
  parent.abort(new Error("parent stopped"));
  assert.equal(timeout.signal.aborted, true);
  assert.match(String(timeout.signal.reason), /parent stopped/);
  timeout.dispose();
});
