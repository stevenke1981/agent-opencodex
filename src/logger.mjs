import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { collectSecretsFromEnv, buildRedactor, redactObject } from "./utils/redact.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(options = {}) {
  const level = options.level ?? "info";
  const threshold = LEVELS[level] ?? LEVELS.info;
  const redactor = buildRedactor([...(options.secrets ?? []), ...collectSecretsFromEnv(options.env)]);
  const json = options.json ?? false;
  const logFile = options.logFile;

  async function write(entry) {
    const safeEntry = redactObject(entry, redactor);
    const line = `${JSON.stringify(safeEntry)}\n`;
    if (logFile) {
      await mkdir(dirname(logFile), { recursive: true });
      await appendFile(logFile, line, "utf8");
    }
    if (!options.quiet) {
      if (json) process.stderr.write(line);
      else {
        const details = safeEntry.data ? ` ${JSON.stringify(safeEntry.data)}` : "";
        process.stderr.write(`[${safeEntry.time}] ${safeEntry.level.toUpperCase()} ${safeEntry.message}${details}\n`);
      }
    }
  }

  const logger = {};
  for (const [name, weight] of Object.entries(LEVELS)) {
    if (name === "silent") continue;
    logger[name] = (message, data) => {
      if (weight < threshold) return Promise.resolve();
      return write({ time: new Date().toISOString(), level: name, message, ...(data === undefined ? {} : { data }) });
    };
  }
  logger.child = (data) => {
    const child = {};
    for (const name of ["debug", "info", "warn", "error"]) {
      child[name] = (message, extra) => logger[name](message, { ...data, ...(extra ?? {}) });
    }
    return child;
  };
  logger.redact = redactor;
  return logger;
}
