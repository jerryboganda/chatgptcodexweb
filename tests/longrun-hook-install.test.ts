import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_ROUTE_COMMENT } from "../src/codex-integration-shared";
import {
  installCodexInterruptHookCommand, restoreCodexInterruptHook, verifyCodexInterruptHook,
} from "../src/codex-interrupt-hook";
import {
  LONGRUN_HOOKS_END, LONGRUN_HOOKS_START, ensureLongrunHooks, inspectLongrunHooks, installLongrunHooks,
  longrunHookCommands, longrunHookHash, removeLongrunHooks,
} from "../src/longrun/hook-install";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "longrun-install-"));
  cleanup.push(path);
  return path;
}

const COMMANDS = { stop: '"C:\\rt\\bun.exe" "C:\\rt\\cli.js" "--home" "C:\\h" "hook" "stop"', prompt: '"C:\\rt\\bun.exe" "C:\\rt\\cli.js" "--home" "C:\\h" "hook" "prompt"' };
const CONFIG = "C:/Users/test/.codex/config.toml";
const BASE = `${MANAGED_ROUTE_COMMENT}\nopenai_base_url = "http://127.0.0.1:17841/v1"\nmodel = "chatgpt-web/gpt-6-sol"\n`;

test("hook hashes match the values Codex 0.165 accepted for the same command and timeout", () => {
  // Captured from a real run: Codex executed both hooks, so it considered these hashes trusted.
  const stop = "node C:\\Users\\Admin\\AppData\\Local\\Temp\\cwg-lr\\hooktest\\hook.cjs stop";
  const prompt = "node C:\\Users\\Admin\\AppData\\Local\\Temp\\cwg-lr\\hooktest\\hook.cjs prompt";
  expect(longrunHookHash("stop", stop, 600)).toBe("sha256:94b290b6adfa58560e736d67f6a1bab166c6d2bc15a3ac933cbdd3974810fc40");
  expect(longrunHookHash("user_prompt_submit", prompt, 10)).toBe("sha256:41490aefe137336b583842d13755eb7d6bd7e76085af7b50a455d84aad59e204");
});

test("the hook commands use the Windows shapes Codex really executes", () => {
  // Codex 0.165 never runs a hook whose program path is in double quotes; plain words and a PowerShell call work.
  const plain = longrunHookCommands({ runtimeCommand: ["C:\\rt\\bun.exe", "C:\\app\\cli.js"] }, "C:\\h", "win32");
  expect(plain.stop).toBe("C:\\rt\\bun.exe C:\\app\\cli.js --home C:\\h hook stop");
  expect(plain.prompt.endsWith("hook prompt")).toBe(true);
  const windows = longrunHookCommands({ runtimeCommand: ["C:\\Program Files\\rt\\bun.exe", "C:\\app\\cli.js"] }, "C:\\h", "win32");
  expect(windows.stop).toBe("powershell -NoProfile -NonInteractive -Command \"& 'C:\\Program Files\\rt\\bun.exe' 'C:\\app\\cli.js' '--home' 'C:\\h' 'hook' 'stop'\"");
  expect(windows.prompt.endsWith("'hook' 'prompt'\"")).toBe(true);
  const apostrophe = longrunHookCommands({ runtimeCommand: ["C:\\O'Neil\\bun.exe", "C:\\app\\cli.js"] }, "C:\\h", "win32");
  expect(apostrophe.stop).toContain("'C:\\O''Neil\\bun.exe'");
  expect(() => longrunHookCommands({ runtimeCommand: ["C:\\100%\\bun.exe"] }, "C:\\h", "win32")).toThrow("cannot pass");
  const posix = longrunHookCommands({ runtimeCommand: ["/opt/rt/bun", "/opt/app/cli.js"] }, "/home/x/.h", "linux");
  expect(posix.stop).toBe("'/opt/rt/bun' '/opt/app/cli.js' '--home' '/home/x/.h' 'hook' 'stop'");
  expect(() => longrunHookCommands({ runtimeCommand: ['C:\\bad"path'] }, "C:\\h", "win32")).toThrow("cannot pass");
});

test("installing adds trusted Stop and UserPromptSubmit hooks and is idempotent", () => {
  const first = installLongrunHooks(BASE, CONFIG, COMMANDS);
  expect(first.changed).toBe(true);
  const document = Bun.TOML.parse(first.text) as any;
  expect(document.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: COMMANDS.stop, timeout: 3600 });
  expect(document.hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: "command", command: COMMANDS.prompt, timeout: 15 });
  const states = Object.entries(document.hooks.state as Record<string, { trusted_hash: string }>);
  expect(states.map(([key]) => key.replace(/^.*config\.toml:/, "")).sort()).toEqual(["stop:0:0", "user_prompt_submit:0:0"]);
  for (const [key, value] of states) {
    const event = key.includes(":stop:") ? "stop" : "user_prompt_submit";
    expect(value.trusted_hash).toBe(longrunHookHash(event, event === "stop" ? COMMANDS.stop : COMMANDS.prompt, event === "stop" ? 3600 : 15));
  }
  expect(inspectLongrunHooks(first.text, CONFIG, COMMANDS)).toBe("current");
  const second = installLongrunHooks(first.text, CONFIG, COMMANDS);
  expect(second.changed).toBe(false);
  expect(second.text).toBe(first.text);
});

test("removal restores the original text for common endings", () => {
  for (const original of [BASE, BASE.trimEnd(), "", BASE.replaceAll("\n", "\r\n"), `${BASE}\n[features]\nmulti_agent = true\n`]) {
    const installed = installLongrunHooks(original, CONFIG, COMMANDS).text;
    expect(installed).toContain(LONGRUN_HOOKS_START);
    const removed = removeLongrunHooks(installed);
    expect(removed.removed).toBe(true);
    const normalize = (value: string) => value.replace(/(\r?\n)+$/, "");
    expect(normalize(removed.text)).toBe(normalize(original));
    expect(removeLongrunHooks(removed.text).removed).toBe(false);
  }
});

test("a changed command replaces the old block instead of adding a second one", () => {
  const installed = installLongrunHooks(BASE, CONFIG, COMMANDS).text;
  const newer = { stop: COMMANDS.stop.replace("rt", "rt2"), prompt: COMMANDS.prompt.replace("rt", "rt2") };
  expect(inspectLongrunHooks(installed, CONFIG, newer)).toBe("stale");
  const updated = installLongrunHooks(installed, CONFIG, newer);
  expect(updated.changed).toBe(true);
  expect(updated.text.split(LONGRUN_HOOKS_START).length - 1).toBe(1);
  expect((Bun.TOML.parse(updated.text) as any).hooks.Stop).toHaveLength(1);
  expect(inspectLongrunHooks(updated.text, CONFIG, newer)).toBe("current");
});

test("a hand-edited block is reported as damaged and never rewritten", () => {
  const installed = installLongrunHooks(BASE, CONFIG, COMMANDS).text;
  const onlyStart = installed.replace(LONGRUN_HOOKS_END, "");
  expect(inspectLongrunHooks(onlyStart, CONFIG, COMMANDS)).toBe("damaged");
  expect(() => installLongrunHooks(onlyStart, CONFIG, COMMANDS)).toThrow("edited by hand");
  expect(() => removeLongrunHooks(onlyStart)).toThrow("refusing to edit");
  const duplicated = `${installed}\n${installed}`;
  expect(inspectLongrunHooks(duplicated, CONFIG, COMMANDS)).toBe("damaged");
  expect(inspectLongrunHooks(installed.replace(/trusted_hash = "sha256:[0-9a-f]+"/, 'trusted_hash = "sha256:00"'), CONFIG, COMMANDS)).toBe("stale");
});

test("hooks the user already has keep their places and the new group gets the next index", () => {
  const existing = `${BASE}\n[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "mine"\n`;
  const installed = installLongrunHooks(existing, CONFIG, COMMANDS).text;
  const document = Bun.TOML.parse(installed) as any;
  expect(document.hooks.Stop).toHaveLength(2);
  expect(document.hooks.Stop[0].hooks[0].command).toBe("mine");
  expect(Object.keys(document.hooks.state).some((key) => key.endsWith(":stop:1:0"))).toBe(true);
  expect(inspectLongrunHooks(installed, CONFIG, COMMANDS)).toBe("current");
});

test("unparseable or incompatible config is refused without producing output", () => {
  expect(() => installLongrunHooks("this = is = not toml", CONFIG, COMMANDS)).toThrow("could not be parsed");
  const inline = `${BASE}[hooks]\nStop = [ { hooks = [ { type = "command", command = "x" } ] } ]\n`;
  expect(() => installLongrunHooks(inline, CONFIG, COMMANDS)).toThrow();
});

test("the long-run block and the interrupt hook coexist, in either order", () => {
  const interrupt = installCodexInterruptHookCommand(BASE, CONFIG, "interrupt-cmd");
  const both = installLongrunHooks(interrupt.text, CONFIG, COMMANDS).text;
  verifyCodexInterruptHook(both, interrupt.installed);
  expect(inspectLongrunHooks(both, CONFIG, COMMANDS)).toBe("current");
  const withoutInterrupt = restoreCodexInterruptHook(both, interrupt.installed);
  expect(inspectLongrunHooks(withoutInterrupt, CONFIG, COMMANDS)).toBe("current");
  expect(withoutInterrupt).not.toContain("interrupt-cmd");

  const longrunFirst = installLongrunHooks(BASE, CONFIG, COMMANDS).text;
  const interruptSecond = installCodexInterruptHookCommand(longrunFirst, CONFIG, "interrupt-cmd");
  verifyCodexInterruptHook(interruptSecond.text, interruptSecond.installed);
  expect(inspectLongrunHooks(interruptSecond.text, CONFIG, COMMANDS)).toBe("current");
  const restored = restoreCodexInterruptHook(interruptSecond.text, interruptSecond.installed);
  expect(removeLongrunHooks(restored).text.replace(/\s+$/, "")).toBe(BASE.replace(/\s+$/, ""));
});

test("ensure installs, repairs, backs up once, and removes when switched off", () => {
  const home = temp();
  const configPath = join(home, "config.toml");
  expect(ensureLongrunHooks({ configPath, commands: COMMANDS, enabled: true, home })).toEqual({ action: "skipped", reason: "Codex config.toml does not exist" });
  writeFileSync(configPath, 'model = "gpt-6"\n');
  expect(ensureLongrunHooks({ configPath, commands: COMMANDS, enabled: true, home })).toEqual({ action: "skipped", reason: "the Codex route is not installed" });
  expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-6"\n');

  writeFileSync(configPath, BASE);
  expect(ensureLongrunHooks({ configPath, commands: COMMANDS, enabled: true, home })).toEqual({ action: "installed" });
  const backup = join(home, "longrun", "config.toml.before-longrun");
  expect(readFileSync(backup, "utf8")).toBe(BASE);
  expect(inspectLongrunHooks(readFileSync(configPath, "utf8"), configPath, COMMANDS)).toBe("current");
  expect(ensureLongrunHooks({ configPath, commands: COMMANDS, enabled: true, home })).toEqual({ action: "unchanged" });

  const moved = { stop: COMMANDS.stop.replace("rt", "rt3"), prompt: COMMANDS.prompt.replace("rt", "rt3") };
  expect(ensureLongrunHooks({ configPath, commands: moved, enabled: true, home })).toEqual({ action: "updated" });
  expect(readFileSync(backup, "utf8")).toBe(BASE);

  expect(ensureLongrunHooks({ configPath, commands: moved, enabled: false, home })).toEqual({ action: "removed" });
  expect(readFileSync(configPath, "utf8").trimEnd()).toBe(BASE.trimEnd());
  expect(ensureLongrunHooks({ configPath, commands: moved, enabled: false, home })).toEqual({ action: "absent" });
  expect(existsSync(`${configPath}.tmp`)).toBe(false);
});

test("ensure keeps a byte order mark and refuses to touch a damaged block", () => {
  const home = temp();
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, `\uFEFF${BASE}`);
  ensureLongrunHooks({ configPath, commands: COMMANDS, enabled: true, home });
  expect(readFileSync(configPath, "utf8").startsWith("\uFEFF")).toBe(true);
  const damaged = readFileSync(configPath, "utf8").replace(LONGRUN_HOOKS_END, "");
  writeFileSync(configPath, damaged);
  expect(() => ensureLongrunHooks({ configPath, commands: COMMANDS, enabled: true, home })).toThrow("edited by hand");
  expect(readFileSync(configPath, "utf8")).toBe(damaged);
});
