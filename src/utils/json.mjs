import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `Invalid JSON in ${path}: ${error.message}`;
    throw error;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function getJsonPointer(value, pointer) {
  if (pointer === "" || pointer === "/") return value;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new TypeError(`JSON pointer must start with '/': ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, key) => (current == null ? undefined : current[key]), value);
}

export function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

export function deepGet(value, dotPath) {
  if (!dotPath) return value;
  return dotPath.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
}
