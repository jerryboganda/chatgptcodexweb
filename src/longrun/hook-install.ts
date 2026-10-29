import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { AppConfig } from "../config";
import { atomicWriteFile, getConfigDir, preserveUtf8Bom, stripUtf8Bom } from "../config";
import { canonicalConfigPath, canonicalJson, lineEnding } from "../codex-interrupt-hook";
import { MANAGED_ROUTE_COMMENT } from "../codex-integration-shared";
import { hookCommandLine } from "../hook-command";
import { longrunDirectory } from "./settings";

export const LONGRUN_HOOKS_START =
  "# Managed by codex-chatgpt-web: long-run hooks keep a ChatGPT web task going until its acceptance check passes.";
export const LONGRUN_HOOKS_END = "# End codex-chatgpt-web long-run hooks.";
/** The Stop hook runs the project's acceptance command, which can take a while. */
export const STOP_HOOK_TIMEOUT_SECONDS = 3600;
export const PROMPT_HOOK_TIMEOUT_SECONDS = 15;

export interface LongrunHookCommands {
  stop: string;
  prompt: string;
}

export type LongrunHookStatus = "missing" | "current" | "stale" | "damaged";

/** Same launch as the interrupt hook (the installed runtime runs `hook stop` or `hook prompt`), in a shape Codex really executes. */
export function longrunHookCommands(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): LongrunHookCommands {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const build = (action: string) => {
    return hookCommandLine([...config.runtimeCommand, "--home", absoluteHome, "hook", action], platform);
  };
  return { stop: build("stop"), prompt: build("prompt") };
}

/** Matches codex_config::version_for_toml for a normalized command hook (verified against Codex 0.165). */
export function longrunHookHash(event: "stop" | "user_prompt_submit", command: string, timeout: number): string {
  const identity = canonicalJson({ event_name: event, hooks: [{ type: "command", command, timeout, async: false }] });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

type Located = { start: number; end: number };

/** The managed block, with the blank line before it. "damaged" when the markers are not a single clean pair. */
function locate(text: string): Located | "none" | "damaged" {
  const starts = text.split(LONGRUN_HOOKS_START).length - 1;
  const ends = text.split(LONGRUN_HOOKS_END).length - 1;
  if (starts === 0 && ends === 0) return "none";
  if (starts !== 1 || ends !== 1) return "damaged";
  const start = text.indexOf(LONGRUN_HOOKS_START);
  const markerEnd = text.indexOf(LONGRUN_HOOKS_END);
  if (markerEnd < start) return "damaged";
  let from = start;
  while (from > 0 && /[\r\n]/.test(text[from - 1]!)) from -= 1;
  // Keep one line ending that belonged to the text before the block.
  const ending = lineEnding(text);
  if (from < start) from = Math.min(start, from + ending.length);
  let to = markerEnd + LONGRUN_HOOKS_END.length;
  const tail = /^(?:\r\n|\n|\r)/.exec(text.slice(to));
  if (tail) to += tail[0].length;
  return { start: from, end: to };
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    return Bun.TOML.parse(text.replace(/\r\n?/g, "\n")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function hookGroups(document: Record<string, unknown> | undefined, event: string): unknown[] | undefined {
  const hooks = document?.hooks;
  if (hooks === undefined || typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return undefined;
  const groups = (hooks as Record<string, unknown>)[event];
  return Array.isArray(groups) ? groups : undefined;
}

function hookState(document: Record<string, unknown> | undefined): Record<string, unknown> {
  const state = (document?.hooks as Record<string, unknown> | undefined)?.state;
  return state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : {};
}

function groupCommand(group: unknown): string | undefined {
  const hooks = (group as { hooks?: unknown } | undefined)?.hooks;
  const first = Array.isArray(hooks) ? hooks[0] as { command?: unknown } | undefined : undefined;
  return typeof first?.command === "string" ? first.command : undefined;
}

export function removeLongrunHooks(text: string): { text: string; removed: boolean } {
  const found = locate(text);
  if (found === "none") return { text, removed: false };
  if (found === "damaged") throw new Error("The long-run hook markers in Codex config.toml are duplicated or incomplete; refusing to edit them.");
  return { text: text.slice(0, found.start) + text.slice(found.end), removed: true };
}

function buildBlock(
  configPath: string, commands: LongrunHookCommands, indexes: { prompt: number; stop: number }, ending: string,
): string {
  const key = canonicalConfigPath(configPath);
  const q = JSON.stringify;
  return [
    LONGRUN_HOOKS_START,
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${q(commands.prompt)}`,
    `timeout = ${PROMPT_HOOK_TIMEOUT_SECONDS}`,
    "",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${q(commands.stop)}`,
    `timeout = ${STOP_HOOK_TIMEOUT_SECONDS}`,
    "",
    `[hooks.state.${q(`${key}:user_prompt_submit:${indexes.prompt}:0`)}]`,
    `trusted_hash = ${q(longrunHookHash("user_prompt_submit", commands.prompt, PROMPT_HOOK_TIMEOUT_SECONDS))}`,
    "",
    `[hooks.state.${q(`${key}:stop:${indexes.stop}:0`)}]`,
    `trusted_hash = ${q(longrunHookHash("stop", commands.stop, STOP_HOOK_TIMEOUT_SECONDS))}`,
    LONGRUN_HOOKS_END,
  ].join(ending);
}

/** Add the block to config text that does not contain one. Throws when the TOML shape cannot take it. */
function appendBlock(text: string, configPath: string, commands: LongrunHookCommands): string {
  const before = parse(text);
  if (!before) throw new Error("Codex config.toml could not be parsed as TOML; the long-run hooks were not installed.");
  const indexes = {
    prompt: hookGroups(before, "UserPromptSubmit")?.length ?? 0,
    stop: hookGroups(before, "Stop")?.length ?? 0,
  };
  if (before.hooks !== undefined && hookGroups(before, "Stop") === undefined && (before.hooks as Record<string, unknown>).Stop !== undefined) {
    throw new Error("Codex config.toml defines hooks.Stop in a shape the long-run hooks cannot extend.");
  }
  const ending = lineEnding(text);
  const lead = text.length === 0 ? "" : text.endsWith(`${ending}${ending}`) ? "" : text.endsWith(ending) ? ending : `${ending}${ending}`;
  const next = `${text}${lead}${buildBlock(configPath, commands, indexes, ending)}${ending}`;
  const after = parse(next);
  const stopGroups = hookGroups(after, "Stop");
  const promptGroups = hookGroups(after, "UserPromptSubmit");
  if (!after || groupCommand(stopGroups?.[indexes.stop]) !== commands.stop
    || groupCommand(promptGroups?.[indexes.prompt]) !== commands.prompt) {
    throw new Error("The long-run hooks could not be added to Codex config.toml without changing its meaning.");
  }
  return next;
}

export function inspectLongrunHooks(text: string, configPath: string, commands: LongrunHookCommands): LongrunHookStatus {
  const found = locate(text);
  if (found === "damaged") return "damaged";
  if (found === "none") return "missing";
  const document = parse(text);
  if (!document) return "damaged";
  const state = hookState(document);
  const key = canonicalConfigPath(configPath);
  const check = (event: string, name: string, command: string, timeout: number) => {
    const groups = hookGroups(document, event) ?? [];
    const index = groups.findIndex((group) => groupCommand(group) === command);
    if (index < 0) return false;
    const entry = state[`${key}:${name}:${index}:0`] as { trusted_hash?: unknown } | undefined;
    return entry?.trusted_hash === longrunHookHash(name as "stop", command, timeout);
  };
  return check("Stop", "stop", commands.stop, STOP_HOOK_TIMEOUT_SECONDS)
    && check("UserPromptSubmit", "user_prompt_submit", commands.prompt, PROMPT_HOOK_TIMEOUT_SECONDS)
    ? "current" : "stale";
}

/** Install, or replace a stale block. Returns the new text and whether anything changed. */
export function installLongrunHooks(
  text: string, configPath: string, commands: LongrunHookCommands,
): { text: string; changed: boolean } {
  const status = inspectLongrunHooks(text, configPath, commands);
  if (status === "current") return { text, changed: false };
  if (status === "damaged") throw new Error("The long-run hook section of Codex config.toml was edited by hand; repair or remove it, then retry.");
  const base = status === "stale" ? removeLongrunHooks(text).text : text;
  return { text: appendBlock(base, configPath, commands), changed: true };
}

export type EnsureResult =
  | { action: "installed" | "updated" | "unchanged" | "removed" | "absent" }
  | { action: "skipped"; reason: string };

/**
 * Bring Codex's config in line with the settings: install (or repair) the hooks when long-run is on
 * and the bridge route is installed, remove them when it is off. Best effort and idempotent; it
 * only ever touches its own marked block, and keeps one backup of the file as it was before.
 */
export function ensureLongrunHooks(options: {
  configPath: string;
  commands: LongrunHookCommands;
  enabled: boolean;
  home?: string;
}): EnsureResult {
  const { configPath, commands, enabled } = options;
  const home = options.home ?? getConfigDir();
  if (!existsSync(configPath)) return { action: "skipped", reason: "Codex config.toml does not exist" };
  const original = readFileSync(configPath, "utf8");
  const text = stripUtf8Bom(original);
  if (!text.includes(MANAGED_ROUTE_COMMENT) && locate(text) === "none") {
    return { action: "skipped", reason: "the Codex route is not installed" };
  }
  let result: { text: string; action: "installed" | "updated" | "unchanged" | "removed" | "absent" };
  if (!enabled) {
    const removed = removeLongrunHooks(text);
    result = { text: removed.text, action: removed.removed ? "removed" : "absent" };
  } else {
    const hadBlock = locate(text) !== "none";
    const installed = installLongrunHooks(text, configPath, commands);
    result = { text: installed.text, action: !installed.changed ? "unchanged" : hadBlock ? "updated" : "installed" };
  }
  if (result.action === "unchanged" || result.action === "absent") return { action: result.action };
  const backup = join(longrunDirectory(home), "config.toml.before-longrun");
  if (!existsSync(backup)) {
    mkdirSync(longrunDirectory(home), { recursive: true });
    copyFileSync(configPath, backup);
  }
  atomicWriteFile(configPath, preserveUtf8Bom(result.text, original), { protectDirectory: false });
  return { action: result.action };
}
