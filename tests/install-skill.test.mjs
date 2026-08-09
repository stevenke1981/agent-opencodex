import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(root, "scripts", "install-skill.ps1");
const source = join(root, "skills", "agent-opencodex");

test("Windows skill installer replaces safely and verifies every file", {
  skip: process.platform !== "win32",
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "aocx-skill-install-"));
  const destination = join(temporary, "Codex Skills", "agent-opencodex");
  try {
    const clean = await install(destination);
    assert.equal(clean.ok, true);
    assert.equal(clean.backup, null);
    assert.equal(clean.hashesVerified, true);
    assert.deepEqual(await manifest(destination), await manifest(source));

    await writeFile(join(destination, "old-marker.txt"), "previous installation", "utf8");
    const replacement = await install(destination);
    assert.equal(replacement.ok, true);
    assert.equal(replacement.hashesVerified, true);
    assert.ok(replacement.backup);
    assert.notEqual(dirname(replacement.backup), dirname(destination));
    assert.equal(
      (await realpath(replacement.backupDirectory)).toLowerCase(),
      (await realpath(join(temporary, "skill-backups"))).toLowerCase(),
    );
    assert.equal(await readFile(join(replacement.backup, "old-marker.txt"), "utf8"), "previous installation");
    assert.deepEqual(await manifest(destination), await manifest(source));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Windows skill installer preserves an existing destination when the source is invalid", {
  skip: process.platform !== "win32",
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "aocx-skill-failure-"));
  const destination = join(temporary, "agent-opencodex");
  const invalidSource = join(temporary, "invalid-source");
  try {
    await mkdir(destination, { recursive: true });
    await mkdir(invalidSource, { recursive: true });
    await writeFile(join(destination, "old-marker.txt"), "keep me", "utf8");
    await assert.rejects(
      execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer,
        "-Source", invalidSource, "-Destination", destination, "-Json",
      ]),
      /not an Agent OpenCodex skill package/,
    );
    assert.equal(await readFile(join(destination, "old-marker.txt"), "utf8"), "keep me");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function install(destination) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer,
    "-Destination", destination, "-Json",
  ]);
  return JSON.parse(stdout.trim());
}

async function manifest(directory) {
  const files = await listFiles(directory);
  return Promise.all(files.map(async (path) => {
    const data = await readFile(path);
    return {
      path: relative(directory, path).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
    };
  }));
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat().sort((a, b) => a.localeCompare(b));
}
