import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary with an argument array (no shell, so paths with spaces or
 * quotes are safe). Rejects only if the process could not start, e.g. ENOENT
 * when the binary is not installed, or when `signal` aborts it.
 */
export function run(
  cmd: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      signal: opts.signal,
      env: opts.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (opts.onStdout) opts.onStdout(chunk);
      else stdout += chunk;
    });
    // Keep only the tail of stderr; that's where ffmpeg puts the real error.
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function lastLines(text: string, count = 3): string {
  return text.trim().split(/\r?\n/).slice(-count).join(" | ") || "Unknown error";
}
