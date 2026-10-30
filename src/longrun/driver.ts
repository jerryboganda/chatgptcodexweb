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
    "You are the driver, and you ARE a Luna model whenever your session model is gpt-6-luna or gpt-5.6-luna. You do not do the real work yourself: every step that creates, edits, debugs, tests or reviews code, and every analysis, architecture explanation, code review or investigation of a project, is done by a ChatGPT web worker running a stronger model (step 3). This is the rule even when the task looks small or is only a question about the project. What you do yourself: understand the request, run commands to check results (the acceptance command, tests, git), keep PROGRESS.md, hand jobs over, and relay the worker's result. Only a short chat reply that needs no project knowledge stays with you.",
    "",
    "1. Before anything else, create `.longrun/PROGRESS.md` in the project: the goal, the acceptance command, what is done, what is next, decisions, known failures, the environment (step 3) and the manual steps (step 8). Update it after every worker job.",
    '2. Choose an acceptance command that can really pass on this PC: the project\'s tests, lint and build. If the project\'s own full pipeline also needs the network, Docker, credentials or a deployment, do not use that as the acceptance command; use the part that can pass here and list the rest under "manual steps". Add `acceptance: <command>` to the project\'s AGENTS.md if it has none.',
    "3. Check the environment yourself before the first worker job: whether the network reaches the hosts the project needs (package registry, Go, git remote), whether the toolchains it needs are on PATH, whether Docker is installed, and whether the credentials the goal depends on exist. You have network and full access; the worker's sandbox may not. Install or download what is missing yourself, and write the result under \"environment\" in PROGRESS.md.",
    `4. Hand each coding job to ONE worker at a time, and keep each job to one slice: one change that can be finished and checked in about half an hour. Split a big goal into slices in PROGRESS.md and send them one after another; never send a whole feature as a single job. Write the brief to \`.longrun/brief.md\`, then run this command in the project folder: \`${workerCommand} --brief-file .longrun/brief.md\`. It starts a fresh ChatGPT web chat on \`${settings.workerModel}\` at \`${settings.workerEffort}\` effort, retries in another fresh chat if that chat breaks, and prints the worker's report and the changed files. It can take many minutes: run it with a timeout of at least 3600000 ms and wait for it. Each worker starts with an empty context, so the brief must be complete and short: the goal, the acceptance command, the relevant part of PROGRESS.md and the environment, the files to touch, the focused check to run, and what to report back. Do not use the subagent tool for this.`,
    "5. You do these yourself, never the worker: downloads and installs, network access, toolchain and environment setup, credential, Docker and deployment checks, and every full-suite or acceptance run. The worker writes and fixes code and runs only focused checks. If a worker reports `BLOCKED:`, resolve that blocker yourself or record it as a manual step; never send the same blocker to another worker.",
    "6. When a worker returns, check its work yourself: read the diff and run the acceptance command. Do not trust the worker's word.",
    "7. If a worker errors, stalls, loses its chat or returns without doing the job, start a new worker with a shorter brief that names the failure. After three failed attempts at the same step, say so in your answer instead of looping.",
    "8. If something stops the goal that nobody on this PC can fix (credentials you do not have, Docker or a server you cannot reach, a decision that is the user's), write it under \"manual steps\" in PROGRESS.md with exactly what the user must do, finish everything else, and say so plainly in your answer. Do not keep retrying it.",
    "9. Keep going until the acceptance command passes. A Stop hook runs it after your turn and sends you back to work if it fails.",
    "10. Keep your own messages short; the worker holds the detail.",
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
