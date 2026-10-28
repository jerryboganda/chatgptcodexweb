import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-codex.mjs");
export const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

/**
 * A scratch git repository plus a scripted fake codex. `script` lists one scenario per worker invocation and
 * `controllerScript` one per controller invocation; the controller is off unless a script is given.
 */
export async function scenario(script, run, controllerScript) {
  const root = mkdtempSync(path.join(os.tmpdir(), "longrun-test-"));
  const repo = path.join(root, "repo");
  const dir = path.join(root, "fake");
  spawnSync("git", ["init", "-q", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  writeFileSync(path.join(root, "script.json"), JSON.stringify(script));
  process.env.FAKE_CODEX_DIR = dir;
  process.env.FAKE_CODEX_SCRIPT = path.join(root, "script.json");
  if (controllerScript) {
    writeFileSync(path.join(root, "controller.json"), JSON.stringify(controllerScript));
    process.env.FAKE_CONTROLLER_SCRIPT = path.join(root, "controller.json");
  } else delete process.env.FAKE_CONTROLLER_SCRIPT;
  const waits = [];
  const read = (prefix) => readdirSync(dir).filter((f) => f.startsWith(prefix)).sort((a, b) => parseInt(a.slice(prefix.length)) - parseInt(b.slice(prefix.length)))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
  const calls = () => read("call-");
  const controllerCalls = () => { try { return read("controller-"); } catch { return []; } };
  const config = (over = {}) => ({
    repo, taskText: "Build the thing", quiet: true, bridgePort: 0, keepAwake: false, effort: "high",
    codex: { exe: process.execPath, args: [fake] }, pollMs: 50, controller: Boolean(controllerScript), controllerTimeoutMs: 20_000,
    // Never let a stored or environment API key send test evidence to the real Jev API; Jev tests pass a fake client.
    controllerMode: "luna", ...over,
  });
  const deps = (over = {}) => ({ sleep: async (ms) => { waits.push(ms); }, jitter: 0.5, ...over });
  try {
    await run({ repo, root, waits, calls, controllerCalls, config, deps });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
