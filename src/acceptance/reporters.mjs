import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "../utils/crypto.mjs";
import { writeJson } from "../utils/json.mjs";

export async function writeAcceptanceReports(report, reportDir) {
  await mkdir(reportDir, { recursive: true });
  const jsonPath = join(reportDir, "report.json");
  const markdownPath = join(reportDir, "summary.md");
  const junitPath = join(reportDir, "junit.xml");
  await writeJson(jsonPath, report);
  await writeFile(markdownPath, buildMarkdown(report), "utf8");
  await writeFile(junitPath, buildJunit(report), "utf8");
  const manifest = await buildManifest(reportDir, ["manifest.json"]);
  const manifestPath = join(reportDir, "manifest.json");
  await writeJson(manifestPath, {
    generated_at: new Date().toISOString(),
    algorithm: "sha256",
    files: manifest,
  });
  return { jsonPath, markdownPath, junitPath, manifestPath };
}

export function buildMarkdown(report) {
  const lines = [
    `# Acceptance Report: ${report.name}`,
    "",
    `- Result: **${report.ok ? "PASS" : "FAIL"}**`,
    `- Started: ${report.startedAt}`,
    `- Duration: ${report.durationMs} ms`,
    `- Checks: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
    "",
    "## Checks",
    "",
    "| Check | Type | Result | Duration | Message |",
    "|---|---|---:|---:|---|",
  ];
  for (const result of report.results) {
    lines.push(`| ${escapeCell(result.id)} | ${escapeCell(result.type)} | ${result.status.toUpperCase()} | ${result.durationMs} ms | ${escapeCell(result.message ?? "")} |`);
  }
  if (report.services?.length) {
    lines.push("", "## Services", "", "| Service | PID | Result | Log |", "|---|---:|---:|---|");
    for (const service of report.services) {
      lines.push(`| ${escapeCell(service.id)} | ${service.pid ?? ""} | ${(service.status ?? "unknown").toUpperCase()} | ${escapeCell(service.log ?? "")} |`);
    }
  }
  lines.push("", "## Reproduce", "", "```bash", report.reproduceCommand, "```", "");
  return lines.join("\n");
}

export function buildJunit(report) {
  const failures = report.results.filter((result) => result.status === "failed").length;
  const skipped = report.results.filter((result) => result.status === "skipped").length;
  const cases = report.results.map((result) => {
    const attrs = `name="${xml(result.id)}" classname="agent-opencodex.${xml(result.type)}" time="${(result.durationMs / 1000).toFixed(3)}"`;
    if (result.status === "failed") return `  <testcase ${attrs}><failure message="${xml(result.message ?? "failed")}">${xml(JSON.stringify(result.evidence ?? {}))}</failure></testcase>`;
    if (result.status === "skipped") return `  <testcase ${attrs}><skipped message="${xml(result.message ?? "skipped")}"/></testcase>`;
    return `  <testcase ${attrs}/>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(report.name)}" tests="${report.results.length}" failures="${failures}" skipped="${skipped}" time="${(report.durationMs / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

async function buildManifest(root, exclusions = []) {
  const files = await walk(root);
  const output = [];
  for (const path of files) {
    const rel = relative(root, path).replaceAll("\\", "/");
    if (exclusions.includes(rel)) continue;
    const content = await readFile(path);
    output.push({ path: rel, bytes: content.byteLength, sha256: sha256(content) });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await walk(child));
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

function escapeCell(value) { return String(value).replaceAll("|", "\\|").replaceAll("\n", " "); }
function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
