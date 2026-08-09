import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcceptance } from "../src/acceptance/runner.mjs";

test("acceptance runner writes all evidence formats", async () => {
  const root = await mkdtemp(join(tmpdir(), "aocx-accept-"));
  await writeFile(join(root, "sample.txt"), "hello acceptance\n", "utf8");
  const specPath = join(root, "spec.json");
  await writeFile(specPath, JSON.stringify({
    version: 1,
    name: "unit-acceptance",
    root: ".",
    checks: [
      { id: "file", type: "file", path: "sample.txt", contains: "acceptance" },
      { id: "command", type: "command", command: [process.execPath, "--version"], expect: { exitCode: 0, stdoutIncludes: "v" } },
      { id: "json", type: "json", path: "spec.json", pointer: "/version", equals: 1 }
    ]
  }, null, 2));
  const result = await runAcceptance({ specPath, reportDir: join(root, "report") });
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.summary, { passed: 3, failed: 0, skipped: 0 });
  for (const path of Object.values(result.paths)) assert.ok((await readFile(path)).length > 0);
  const manifest = JSON.parse(await readFile(result.paths.manifestPath, "utf8"));
  assert.ok(manifest.files.some((entry) => entry.path === "report.json" && entry.sha256.length === 64));
});
