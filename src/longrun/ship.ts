import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What is left to ship: work not yet committed, and commits not yet pushed. */
export interface ShipState {
  dirty: boolean;
  /** Commits on this branch that its upstream does not have. */
  ahead: number;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    return { ok: result.status === 0, stdout: result.stdout ?? "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Paths the long-run tooling keeps in the project (progress notes, briefs, reports); they are never part of the work. */
const OWN_FILES = /(?:^|[\s"/\\])\.longrun[\\/]/;

/** `undefined` when the folder is not a git work tree. Reads state only; it never runs a project command. */
export function shipState(cwd: string): ShipState | undefined {
  const status = git(cwd, ["status", "--porcelain"]);
  if (!status.ok) return undefined;
  const dirty = status.stdout.split(/\r?\n/).some((line) => line.trim() !== "" && !OWN_FILES.test(line));
  const ahead = git(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
  return { dirty, ahead: ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0 };
}

/**
 * Keep `.longrun/` out of commits (and out of `git add -A`) by listing it in the repository's own `info/exclude`,
 * which is never committed. Best effort: a missing repository or an unwritable file changes nothing.
 */
export function excludeOwnFiles(cwd: string): void {
  try {
    const path = git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
    if (!path.ok) return;
    const file = resolve(cwd, path.stdout.trim());
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (/^\/?\.longrun\/?\s*$/m.test(current)) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}.longrun/\n`);
  } catch { /* the exclusion is a convenience */ }
}
