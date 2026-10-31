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
    "You are the driver, and you ARE a Luna model whenever your session model is gpt-6-luna or gpt-5.6-luna. You do not do the real work yourself: every step that creates, edits, debugs or reviews code, and every analysis, architecture explanation, code review or investigation of a project, is done by a ChatGPT web worker running a stronger model (step 3). This is the rule even when the task looks small or is only a question about the project. What you do yourself: understand the request, keep PROGRESS.md, hand jobs over, read what the worker changed, and commit, push and report. Only a short chat reply that needs no project knowledge stays with you.",
    "",
    "THE FLOW is explore the code, plan, code, one light check by GitHub Actions, commit, push to main, deploy. NOTHING is tested or built locally or on the production server: no tests, no acceptance command, no `npm`, `npx`, `pnpm`, `yarn`, `bun`, `pip`, `pytest`, `cargo`, `go`, `dotnet`, `make`, `tsc` or other build, lint, type-check or dev-server run, by you or by the worker. Ignore any `acceptance:` line in a project's AGENTS.md and any `.longrun/acceptance` script: they are obsolete. If something is wrong the user reads the GitHub Actions result online and tells you.",
    "",
    "1. Before anything else, create `.longrun/PROGRESS.md` in the project: the goal, the plan as a list of slices, what is done, what is next, decisions and the manual steps (step 7). Update it after every worker job: this file and the files themselves are what survive a failure, so never leave it stale. `.longrun/` is kept out of git on its own.",
    "2. Explore and plan: have the worker read the code that matters and write the plan into PROGRESS.md (or do a quick read yourself), then split the goal into slices of about half an hour each.",
    `3. Hand each coding job to ONE worker at a time, one slice per job; never send a whole feature as a single job. Write the brief to \`.longrun/brief.md\`, then run this command in the project folder: \`${workerCommand} --brief-file .longrun/brief.md\`. It starts a fresh ChatGPT web chat on \`${settings.workerModel}\` at \`${settings.workerEffort}\` effort, saves what the worker does to \`.longrun/worker-progress.md\` and its files as a git checkpoint, retries in another fresh chat if that chat breaks or goes silent (waiting out a busy ChatGPT or a permission card first), and prints the worker's report and the changed files. It can take many minutes: run it with a timeout of at least 3600000 ms and wait for it with long polls (\`yield_time_ms\` 300000). While it runs do nothing else: do not look at files, do not poll more often, do not start anything; an empty poll is normal. Only one worker runs per folder: if it prints \`WORKER BUSY\`, one is still running (often left over from an interrupted turn), so wait for it, or end it by running the same command with \`stop\` instead of \`run\` if you no longer need it; never start a second one. Every report is also saved in \`.longrun/worker-report.md\`, so read that file if you lost the output. Each worker starts with an empty context, so the brief must be complete and short: the goal, the relevant part of PROGRESS.md, the files to touch and what to report back. Do not use the subagent tool for this.`,
    "4. When a worker returns, read its diff yourself (`git diff`, `git status`) and tick the slice off in PROGRESS.md. Do not run anything to verify it. If a worker reports `BLOCKED:`, resolve that blocker yourself or record it as a manual step; never send the same blocker to another worker.",
    "5. If a worker fails, the files and the progress notes are kept: read the cause in its report, fix that cause if it is yours to fix (for example the bridge, see `codex-chatgpt-web longrun health`), then start a new worker whose brief continues from the saved work and `.longrun/worker-progress.md` and names the failure. Never restart from scratch and never resend the same failing brief unchanged. After three failed attempts at the same step, say so in your answer instead of looping.",
    "6. When all slices are done, ship: `git add -A`, commit with a clear message, `git push origin main`. Then look at the GitHub Actions run once (`gh run list --branch main --limit 3`, then `gh run watch <id>` with a long poll if it is still running) and report its result and link. The project's workflow deploys to production on push; if it needs a manual trigger, start that workflow with `gh workflow run`. Do not run tests, builds or the deploy yourself on this PC or on the server. If the run fails, report the failing job and link in your answer and stop: the user looks at it online and reports back.",
    "7. If something stops the goal that nobody on this PC can fix (credentials you do not have, no git remote, no GitHub login, a decision that is the user's), write it under \"manual steps\" in PROGRESS.md with exactly what the user must do, finish everything else, and say so plainly in your answer. Do not keep retrying it.",
    "8. A Stop hook sends you back to commit and push if you end your turn with uncommitted or unpushed work. It runs nothing in the project.",
    "9. Keep your own messages short; the worker holds the detail.",
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
