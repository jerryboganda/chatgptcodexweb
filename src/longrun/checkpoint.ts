import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const KEEP = 20;
const IDENTITY = {
  GIT_AUTHOR_NAME: "Codex", GIT_AUTHOR_EMAIL: "codex@users.noreply.github.com",
  GIT_COMMITTER_NAME: "Codex", GIT_COMMITTER_EMAIL: "codex@users.noreply.github.com",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync("git", args, {
      cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, ...env },
    });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Save the work tree as a commit under `refs/longrun/` without touching the branch, the index or any file, so work a
 * failed worker attempt left behind can always be found again (`git diff refs/longrun/<name>`). Returns the ref, or
 * undefined when there is nothing to save or this is not a git work tree. Never throws.
 */
export function saveCheckpoint(cwd: string, label: string, now = Date.now()): string | undefined {
  const scratch = join(tmpdir(), `longrun-index-${process.pid}-${now}`);
  try {
    const indexPath = git(cwd, ["rev-parse", "--git-path", "index"]);
    if (!indexPath.ok) return undefined;
    const real = resolve(cwd, indexPath.stdout);
    if (existsSync(real)) copyFileSync(real, scratch);
    const env = { GIT_INDEX_FILE: scratch, ...IDENTITY };
    if (!git(cwd, ["add", "-A"], env).ok) return undefined;
    const tree = git(cwd, ["write-tree"], env);
    if (!tree.ok || !tree.stdout) return undefined;
    const head = git(cwd, ["rev-parse", "-q", "--verify", "HEAD"]);
    const headTree = head.ok ? git(cwd, ["rev-parse", "HEAD^{tree}"]) : undefined;
    if (headTree?.ok && headTree.stdout === tree.stdout) return undefined;
    const commit = git(cwd, ["commit-tree", tree.stdout, ...(head.ok ? ["-p", head.stdout] : []), "-m", `long-run checkpoint: ${label}`.slice(0, 200)], env);
    if (!commit.ok || !commit.stdout) return undefined;
    const ref = `refs/longrun/checkpoint-${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${commit.stdout.slice(0, 7)}`;
    if (!git(cwd, ["update-ref", ref, commit.stdout]).ok) return undefined;
    const refs = git(cwd, ["for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/longrun/"]);
    if (refs.ok) for (const old of refs.stdout.split(/\r?\n/).filter(Boolean).slice(KEEP)) git(cwd, ["update-ref", "-d", old]);
    return ref;
  } catch {
    return undefined;
  } finally {
    try { rmSync(scratch, { force: true }); } catch { /* a temp file */ }
  }
}
