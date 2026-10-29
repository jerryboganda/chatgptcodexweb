import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_FILES = 400;
const WALK_LIMIT = 3000;
const SKIPPED_DIRECTORIES = new Set([
  ".git", "node_modules", ".longrun", "dist", "build", "target", "out", ".next", ".venv", "venv", "__pycache__", ".cache", "coverage",
]);

function git(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function statLine(path: string): string {
  try {
    const info = statSync(path);
    return `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return "gone";
  }
}

function walk(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0 && found.length < WALK_LIMIT) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(join(directory, entry.name));
      } else if (entry.isFile()) {
        found.push(join(directory, entry.name));
        if (found.length >= WALK_LIMIT) break;
      }
    }
  }
  return found.sort();
}

/**
 * A short identity for "what the work tree looks like right now". It changes when the model edits,
 * creates or deletes files, so the Stop hook can tell a turn that did work from one that only
 * answered a question. Git repositories use HEAD plus the status list with each changed file's
 * size and time; anything else falls back to a bounded directory walk.
 */
export function workTreeFingerprint(cwd: string): string {
  const hash = createHash("sha256");
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (top) {
    hash.update(`head:${git(top, ["rev-parse", "HEAD"])?.trim() ?? "none"}\n`);
    const status = git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]) ?? "";
    const entries = status.split("\0").filter(Boolean).sort();
    hash.update(`count:${entries.length}\n`);
    for (const entry of entries.slice(0, MAX_FILES)) {
      const path = entry.slice(3);
      hash.update(`${entry.slice(0, 2)}:${path}:${statLine(join(top, path))}\n`);
    }
    return `git:${hash.digest("hex").slice(0, 32)}`;
  }
  const files = walk(cwd);
  hash.update(`count:${files.length}\n`);
  for (const file of files) hash.update(`${relative(cwd, file)}:${statLine(file)}\n`);
  return `dir:${hash.digest("hex").slice(0, 32)}`;
}
