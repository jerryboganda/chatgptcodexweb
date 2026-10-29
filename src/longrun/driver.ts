import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, stripUtf8Bom } from "../config";
import { getCodexHome } from "../codex-integration-shared";
import type { LongrunSettings } from "./settings";

export const DRIVER_START = "<!-- BEGIN codex-chatgpt-web: Luna drives, Sol works -->";
export const DRIVER_END = "<!-- END codex-chatgpt-web: Luna drives, Sol works -->";

export function driverInstructionsPath(codexHome = getCodexHome()): string {
  return join(codexHome, "AGENTS.md");
}

/**
 * The text Codex gives every session through ~/.codex/AGENTS.md. It only asks anything of a Luna model that
 * is the main agent; any other model or a subagent is told to ignore it, so web workers are never affected.
 */
export const DEFAULT_WORKER_COMMAND = "codex-chatgpt-web worker run";

type DriverSettings = Pick<LongrunSettings, "workerModel" | "workerEffort">;

export function driverInstructions(settings: DriverSettings, workerCommand = DEFAULT_WORKER_COMMAND): string {
  return [
    "## Luna drives, Sol works",
    "",
    "Managed by codex-chatgpt-web. Change the worker effort with `codex-chatgpt-web longrun worker <medium|high|xhigh>` or switch this off with `codex-chatgpt-web longrun driver off`.",
    "",
    "This applies only if you are a Luna model (gpt-6-luna or gpt-5.6-luna) and the main agent. If you are any other model, or a subagent, ignore this section.",
    "",
    "You are the driver. You do not write or change code yourself: every step that creates, edits, debugs, tests or reviews code is done by a ChatGPT web worker running a stronger model (step 3). This is the rule even when the task looks small. What you do yourself: understand the request, read files, run commands to check results (the acceptance command, tests, git), keep PROGRESS.md, and answer questions. The one exception is a plain question or explanation that changes no files.",
    "",
    "1. Before anything else, create `.longrun/PROGRESS.md` in the project: the goal, the acceptance command, what is done, what is next, decisions and known failures. Update it after every worker job.",
    '2. If the project has no acceptance command, pick its test or build command and add a line `acceptance: <command>` to the project\'s AGENTS.md.',
    `3. Hand each job to ONE worker at a time. Write the brief to \`.longrun/brief.md\`, then run this command in the project folder: \`${workerCommand} --brief-file .longrun/brief.md\`. It starts a fresh ChatGPT web chat on \`${settings.workerModel}\` at \`${settings.workerEffort}\` effort, retries in another fresh chat if that chat breaks, and prints the worker's report and the changed files. It can take many minutes: run it with a timeout of at least 3600000 ms and wait for it. Each worker starts with an empty context, so the brief must be complete and short: the goal, the acceptance command, the relevant part of PROGRESS.md, the files to touch, and what to report back. Do not use the subagent tool for this.`,
    "4. When a worker returns, check its work yourself: read the diff and run the acceptance command. Do not trust the worker's word.",
    "5. If a worker errors, stalls, loses its chat or returns without doing the job, start a new worker with a shorter brief that names the failure. After three failed attempts at the same step, say so in your answer instead of looping.",
    "6. Keep going until the acceptance command passes. A Stop hook runs it after your turn and sends you back to work if it fails.",
    "7. Keep your own messages short; the worker holds the detail.",
  ].join("\n");
}

function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function renderBlock(settings: DriverSettings, workerCommand: string | undefined, ending: string): string {
  return `${DRIVER_START}\n${driverInstructions(settings, workerCommand)}\n${DRIVER_END}`.replace(/\n/g, ending);
}

type Located = { start: number; end: number } | "none" | "damaged";

function locate(text: string): Located {
  const starts = text.split(DRIVER_START).length - 1;
  const ends = text.split(DRIVER_END).length - 1;
  if (starts === 0 && ends === 0) return "none";
  if (starts !== 1 || ends !== 1) return "damaged";
  const start = text.indexOf(DRIVER_START);
  const end = text.indexOf(DRIVER_END);
  if (end < start) return "damaged";
  return { start, end: end + DRIVER_END.length };
}

export function upsertDriverBlock(
  text: string, settings: DriverSettings, workerCommand?: string,
): { text: string; changed: boolean } {
  const ending = lineEnding(text);
  const block = renderBlock(settings, workerCommand, ending);
  const found = locate(text);
  if (found === "damaged") throw new Error("The Luna driver section of ~/.codex/AGENTS.md was edited by hand; repair or remove it, then retry.");
  if (found === "none") {
    const lead = text.length === 0 ? "" : text.endsWith(`${ending}${ending}`) ? "" : text.endsWith(ending) ? ending : `${ending}${ending}`;
    return { text: `${text}${lead}${block}${ending}`, changed: true };
  }
  const next = text.slice(0, found.start) + block + text.slice(found.end);
  return { text: next, changed: next !== text };
}

export function removeDriverBlock(text: string): { text: string; removed: boolean } {
  const found = locate(text);
  if (found === "none") return { text, removed: false };
  if (found === "damaged") throw new Error("The Luna driver section of ~/.codex/AGENTS.md was edited by hand; repair or remove it, then retry.");
  const ending = lineEnding(text);
  const before = text.slice(0, found.start).replace(/(?:\r\n|\n|\r)+$/, "");
  const after = text.slice(found.end).replace(/^(?:\r\n|\n|\r)+/, "");
  const next = before === "" ? after : after === "" ? `${before}${ending}` : `${before}${ending}${ending}${after}`;
  return { text: next, removed: true };
}

export type DriverEnsureResult =
  | { action: "installed" | "updated" | "unchanged" | "removed" | "absent" }
  | { action: "skipped"; reason: string };

/**
 * Keep ~/.codex/AGENTS.md in line with the driver setting. Only the marked block is ever touched; a file
 * that holds nothing else is deleted when the block is removed. Best effort and idempotent.
 */
export function ensureDriverInstructions(options: {
  filePath: string;
  settings: DriverSettings;
  workerCommand?: string;
  enabled: boolean;
  routeInstalled: boolean;
}): DriverEnsureResult {
  const { filePath, settings, enabled, routeInstalled, workerCommand } = options;
  const original = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const text = stripUtf8Bom(original);
  const bom = text === original ? "" : "﻿";
  if (!enabled) {
    const removed = removeDriverBlock(text);
    if (!removed.removed) return { action: "absent" };
    if (removed.text.trim() === "") rmSync(filePath, { force: true });
    else atomicWriteFile(filePath, `${bom}${removed.text}`, { protectDirectory: false });
    return { action: "removed" };
  }
  if (!routeInstalled) return { action: "skipped", reason: "the Codex route is not installed" };
  const next = upsertDriverBlock(text, settings, workerCommand);
  if (!next.changed) return { action: "unchanged" };
  atomicWriteFile(filePath, `${bom}${next.text}`, { protectDirectory: false });
  return { action: original.includes(DRIVER_START) ? "updated" : "installed" };
}
