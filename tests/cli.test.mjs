import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { main } from "../src/cli.mjs";

function capture() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => { text += chunk.toString(); });
  return { stream, get text() { return text; } };
}

test("CLI version and unknown command exit codes", async () => {
  const out = capture();
  const err = capture();
  assert.equal(await main(["version"], { stdout: out.stream, stderr: err.stream }), 0);
  assert.match(out.text, /^0\.1\.0/);
  assert.equal(await main(["does-not-exist"], { stdout: out.stream, stderr: err.stream }), 2);
  assert.match(err.text, /Unknown command/);
});
