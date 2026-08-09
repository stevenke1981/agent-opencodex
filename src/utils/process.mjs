import { spawn } from "node:child_process";

export function runProcess(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new TypeError("command must be a non-empty array of strings");
  }
  const [executable, ...args] = command;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; options.onStdout?.(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; options.onStderr?.(chunk); });
    child.on("error", (error) => { spawnError = error; });
    if (options.stdin != null) child.stdin.end(String(options.stdin));
    else child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        code: code ?? (spawnError ? 127 : 1),
        signal,
        stdout,
        stderr: spawnError ? `${stderr}${stderr ? "\n" : ""}${spawnError.message}` : stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
