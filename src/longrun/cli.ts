import { existsSync, readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import type { AppConfig } from "../config";
import { atomicWriteFile, getConfigDir, loadConfig } from "../config";
import { getCodexConfigPath } from "../codex-integration-shared";
import { handlePrompt, handleStop, defaultDeps, appendLog, type HookOutput } from "./hooks";
import {
  ensureLongrunHooks, inspectLongrunHooks, longrunHookCommands, removeLongrunHooks, type EnsureResult,
} from "./hook-install";
import { resolveProject } from "./project";
import { loadLongrunSettings, longrunSettingsPath, saveLongrunSettings } from "./settings";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

async function readPayload(): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PAYLOAD_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function print(output: HookOutput): void {
  if (output) stdout.write(`${JSON.stringify(output)}\n`);
}

/**
 * `hook stop` and `hook prompt`: Codex runs these at the end of a turn and when the user sends a
 * message. They fail open. Any error means "do nothing", so a bug here can never trap a task.
 */
export async function runLongrunHook(kind: "stop" | "prompt"): Promise<void> {
  const home = getConfigDir();
  try {
    const payload = await readPayload();
    if (!payload) return;
    const deps = defaultDeps(home);
    print(kind === "stop" ? await handleStop(payload, deps) : handlePrompt(payload, deps));
  } catch (error) {
    appendLog(home, "hook_error", { kind, message: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
  }
}

function hookCommandsFor(config: Pick<AppConfig, "runtimeCommand">) {
  return longrunHookCommands(config, getConfigDir());
}

/** Keep Codex's config in line with the long-run setting. Never throws; the bridge must start regardless. */
export function syncLongrunHooks(config: Pick<AppConfig, "runtimeCommand">): EnsureResult | { action: "error"; message: string } {
  try {
    const settings = loadLongrunSettings(getConfigDir(), {});
    return ensureLongrunHooks({
      configPath: getCodexConfigPath(),
      commands: hookCommandsFor(config),
      enabled: settings.enabled,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(getConfigDir(), "install_error", { message: message.slice(0, 300) });
    return { action: "error", message };
  }
}

function describeProject(directory: string): string[] {
  const plan = resolveProject(directory);
  if (!plan.enabled) return [`This folder: long-run is switched off (${plan.root}).`];
  if (!plan.acceptance) {
    return [
      `This folder: no acceptance command found (${plan.root}).`,
      '  Add a line like "acceptance: npm test" to AGENTS.md and long-run will keep going until it passes.',
    ];
  }
  const where = plan.acceptance.file ? ` (${plan.acceptance.file})` : ` (detected: ${plan.acceptance.source})`;
  return [`This folder: acceptance command is \`${plan.acceptance.command}\`${where}.`];
}

const USAGE = `Usage: codex-chatgpt-web longrun [status [folder] | on | off | install | uninstall]

  status [folder]   show whether long-run is on, whether Codex has the hooks, and which command checks a folder
  on / off          turn the automatic "keep going until the check passes" behaviour on or off
  install           (re)install the Codex hooks now; they are also kept in place whenever the bridge starts
  uninstall         remove the Codex hooks and switch long-run off`;

export async function longrunCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  const write = (line = "") => stdout.write(`${line}\n`);
  if (action === "help" || action === "--help") { write(USAGE); return; }
  const home = getConfigDir();
  const configPath = getCodexConfigPath();

  if (action === "status") {
    const folder = args.shift() ?? process.cwd();
    const settings = loadLongrunSettings(home);
    write(`Long-run: ${settings.enabled ? "ON" : "OFF"} for models starting with ${settings.modelPrefixes.join(", ")}`);
    let hooks = "unknown (the bridge is not set up yet)";
    try {
      const commands = hookCommandsFor(loadConfig());
      const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
      const status = inspectLongrunHooks(text, configPath, commands);
      hooks = status === "current" ? "installed and trusted by Codex"
        : status === "missing" ? "not installed" : status === "stale" ? "out of date (repaired when the bridge starts)" : "damaged, needs a manual look";
    } catch { /* Status is informational. */ }
    write(`Codex hooks: ${hooks}`);
    for (const line of describeProject(folder)) write(line);
    write(`Limits per request: ${settings.maxContinuations} automatic continuations, ${settings.maxHours} h, check timeout ${settings.acceptanceTimeoutMinutes} min.`);
    write(`Settings file: ${longrunSettingsPath(home)}`);
    return;
  }

  if (action === "on" || action === "off" || action === "install") {
    if (action !== "install") saveLongrunSettings({ enabled: action === "on" }, home);
    const result = syncLongrunHooks(loadConfig());
    write(action === "off" ? "Long-run is OFF. Codex will no longer be asked to continue." : "Long-run is ON.");
    if (result.action === "skipped") write(`Hooks were not changed: ${result.reason}.`);
    else if (result.action === "error") throw new Error(`Hooks were not changed: ${result.message}`);
    else write(`Codex hooks: ${result.action}.`);
    if (action !== "off") write("Restart Codex (or open a new chat) so it picks up the hooks.");
    return;
  }

  if (action === "uninstall") {
    saveLongrunSettings({ enabled: false }, home);
    if (existsSync(configPath)) {
      const original = readFileSync(configPath, "utf8");
      const removed = removeLongrunHooks(original.replace(/^﻿/, ""));
      if (removed.removed) {
        atomicWriteFile(configPath, original.startsWith("﻿") ? `﻿${removed.text}` : removed.text, { protectDirectory: false });
      }
      write(removed.removed ? "Long-run hooks removed from Codex." : "No long-run hooks were installed.");
    }
    write("Long-run is OFF.");
    return;
  }

  throw new Error(`Unknown longrun action: ${action}\n\n${USAGE}`);
}
