import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export interface AcceptanceResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The end of the combined output, cut at a line boundary and stripped of colour codes. */
  tail: string;
  durationMs: number;
  /** Identity of the failure that ignores timings, counters and paths' volatile parts. */
  signature: string;
}

const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const BUFFER_LIMIT = 1_000_000;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Keep the last `limit` characters, starting at a line boundary when one is close. */
export function tailOf(text: string, limit: number): string {
  const clean = stripAnsi(text).replace(/\r\n?/g, "\n").trimEnd();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(clean.length - limit);
  const newline = cut.indexOf("\n");
  return `…\n${newline >= 0 && newline < limit / 4 ? cut.slice(newline + 1) : cut}`;
}

export function failureSignature(exitCode: number | null, timedOut: boolean, output: string): string {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-40);
  const normalized = lines
    .map((line) => line.replace(/\d{3,}/g, "#").replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/gi, "#").replace(/\s+/g, " "))
    .join("\n");
  return createHash("sha1").update(`${timedOut ? "timeout" : exitCode}\n${normalized}`).digest("hex").slice(0, 16);
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch { /* The process may already have exited. */ }
}

/** Run the acceptance command in the project directory. Never throws; a failure to start is a failed check. */
export function runAcceptance(
  command: string,
  cwd: string,
  { timeoutMs, tailChars }: { timeoutMs: number; tailChars: number },
): Promise<AcceptanceResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const all = output + extra;
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        tail: tailOf(all, tailChars),
        durationMs: Date.now() - started,
        signature: failureSignature(exitCode, timedOut, all),
      });
    };
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      });
    } catch (error) {
      resolve({
        ok: false, exitCode: null, timedOut: false, tail: `Could not start the acceptance command: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0, signature: failureSignature(null, false, String(error)),
      });
      return;
    }
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > BUFFER_LIMIT) output = output.slice(output.length - BUFFER_LIMIT / 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(null, `\n[long-run] The acceptance command was stopped after ${Math.round(timeoutMs / 60_000)} minutes.`);
    }, timeoutMs);
    child.on("error", (error) => finish(null, `\n${error.message}`));
    child.on("close", (code) => finish(code));
  });
}
