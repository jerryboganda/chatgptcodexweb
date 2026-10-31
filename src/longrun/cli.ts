import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { stdin, stdout } from "node:process";
import type { AppConfig } from "../config";
import { atomicWriteFile, getConfigDir, loadConfig } from "../config";
import { getCodexConfigPath, getCodexHome, MANAGED_ROUTE_COMMENT } from "../codex-integration-shared";
import {
  DRIVER_START, driverInstructionsPath, ensureDriverInstructions, removeDriverBlock, type DriverEnsureResult,
} from "./driver";
import { handlePrompt, handleStop, defaultDeps, appendLog, type HookOutput } from "./hooks";
import {
  ensureLongrunHooks, inspectLongrunHooks, longrunHookCommands, removeLongrunHooks, type EnsureResult,
} from "./hook-install";
import { resolveProject } from "./project";
import { DEFAULT_WORKER_TIMEOUT_MINUTES, formatWorkerResult, runWorker } from "./worker";
import { acquireWorkerLock, describeWorker, liveWorker, stopWorker } from "./worker-lock";
import { formatHealth, scanSessions } from "./health";
import {
  appServerStartedAt, defaultWatchdogDeps, judgeDrivers, launchResume, loadResumeHistory, resumeMessage, watchdogTick,
} from "./resume";
import { loadLongrunSettings, longrunSettingsPath, saveLongrunSettings, WORKER_EFFORTS } from "./settings";

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
  const driver = syncDriverInstructions(config);
  if (driver.action === "error") appendLog(getConfigDir(), "install_error", { part: "driver", message: driver.message.slice(0, 300) });
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

/** The command a Luna session runs to start a worker, in the syntax of the shell Codex gives it. */
export function workerCommandLine(
  runtimeCommand: string[], home: string, platform: NodeJS.Platform = process.platform,
): string {
  const quote = platform === "win32"
    ? (value: string) => `'${value.replace(/'/g, "''")}'`
    : (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const words = [...runtimeCommand, "--home", home, "worker", "run"].map(quote).join(" ");
  return platform === "win32" ? `& ${words}` : words;
}

/** "Luna drives, Sol works": the instructions that tell a Luna session to hand coding to a ChatGPT web worker. */
export function syncDriverInstructions(
  config?: Pick<AppConfig, "runtimeCommand">,
): DriverEnsureResult | { action: "error"; message: string } {
  try {
    const home = getConfigDir();
    const settings = loadLongrunSettings(home, {});
    const configPath = getCodexConfigPath();
    const routeInstalled = existsSync(configPath) && readFileSync(configPath, "utf8").includes(MANAGED_ROUTE_COMMENT);
    return ensureDriverInstructions({
      filePath: driverInstructionsPath(),
      settings,
      workerCommand: config ? workerCommandLine(config.runtimeCommand, home) : undefined,
      enabled: settings.enabled && settings.driver,
      routeInstalled,
    });
  } catch (error) {
    return { action: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function describeProject(directory: string): string[] {
  const plan = resolveProject(directory);
  if (!plan.enabled) return [`This folder: long-run is switched off (${plan.root}).`];
  return [`This folder: long-run is on (${plan.root}). Nothing here is tested or built; the work is committed, pushed to main and checked by GitHub Actions.`];
}

const WORKER_USAGE = `Usage: codex-chatgpt-web worker run [--brief-file <file>] [--effort <medium|high|xhigh>] [--model <chatgpt-web/...>]
                                  [--cwd <folder>] [--timeout-minutes <n>] [--attempts <n>]
       codex-chatgpt-web worker status [--cwd <folder>]
       codex-chatgpt-web worker stop [--cwd <folder>]

run     runs one job on the ChatGPT web worker and prints its report. The brief is read from --brief-file, or from stdin.
        Only one worker runs per folder; the last report is also saved to .longrun/worker-report.md.
status  says whether a worker is running in the folder.
stop    ends the worker that is running in the folder, for example one left over from an interrupted turn.`;

const WORKER_REPORT = join(".longrun", "worker-report.md");

/** The driver may be interrupted while its worker runs; the report is kept so the next turn can still read it. */
function saveWorkerReport(cwd: string, body: string): void {
  try {
    mkdirSync(join(cwd, ".longrun"), { recursive: true });
    writeFileSync(join(cwd, WORKER_REPORT), `# Last worker report (finished ${new Date().toISOString()})\n\n${body}\n`);
  } catch { /* The report is a convenience: the worker's output already went to its caller. */ }
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/** `worker run`: what a Luna driver calls to hand one job to the ChatGPT web worker. */
export async function workerCommand(args: string[]): Promise<void> {
  const action = args.shift();
  if (action !== "run" && action !== "status" && action !== "stop") {
    stdout.write(`${WORKER_USAGE}\n`);
    if (action !== undefined && action !== "help" && action !== "--help") throw new Error(`Unknown worker action: ${action}`);
    return;
  }
  const home = getConfigDir();
  if (action === "status" || action === "stop") {
    const folder = resolvePath(optionValue(args, "--cwd") ?? process.cwd());
    if (action === "stop") {
      const stopped = stopWorker(folder, home);
      stdout.write(stopped ? `Stopped the worker in ${folder} (${describeWorker(stopped)}).\n` : `No worker was running in ${folder}.\n`);
      return;
    }
    const running = liveWorker(folder, home);
    stdout.write(running ? `A worker is running in ${folder}: ${describeWorker(running)}.\n` : `No worker is running in ${folder}.\n`);
    const report = join(folder, WORKER_REPORT);
    if (existsSync(report)) stdout.write(`Last report: ${report} (${new Date(statSync(report).mtimeMs).toISOString()})\n`);
    return;
  }
  const settings = loadLongrunSettings(home);
  const effort = (optionValue(args, "--effort") ?? settings.workerEffort).toLowerCase();
  if (!WORKER_EFFORTS.some((item) => item === effort)) throw new Error(`--effort must be one of ${WORKER_EFFORTS.join(", ")}`);
  const model = optionValue(args, "--model") ?? settings.workerModel;
  if (!/^chatgpt-web\/[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error("--model must be a chatgpt-web/ model");
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = optionValue(args, name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
    return value;
  };
  const briefFile = optionValue(args, "--brief-file");
  const cwd = resolvePath(optionValue(args, "--cwd") ?? process.cwd());
  let brief: string;
  if (briefFile) {
    const file = resolvePath(cwd, briefFile);
    if (!existsSync(file)) throw new Error(`Brief file not found: ${file}`);
    brief = readFileSync(file, "utf8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    brief = Buffer.concat(chunks).toString("utf8");
  }
  if (brief.trim() === "") throw new Error("The brief is empty.");
  if (settings.enabled === false || settings.driver === false) {
    appendLog(home, "worker_run_while_off", {});
  }
  const timeoutMs = Math.round(number("--timeout-minutes", DEFAULT_WORKER_TIMEOUT_MINUTES, 1, 600) * 60_000);
  const attempts = Math.round(number("--attempts", 3, 1, 10));
  const held = acquireWorkerLock({ cwd, model, effort }, home);
  if ("busy" in held) {
    appendLog(home, "worker_busy_refused", { pid: held.busy.pid });
    stdout.write([
      `WORKER BUSY: another worker is still running in this folder (${describeWorker(held.busy)}), so no second one was started.`,
      `It is often left over from an interrupted turn. Wait for it, then read ${WORKER_REPORT}; or end it with this command's \`stop\` action instead of \`run\` if you no longer need its result.`,
    ].join("\n") + "\n");
    process.exitCode = 3;
    return;
  }
  const beat = setInterval(held.beat, 60_000);
  const startedAt = Date.now();
  try {
    const result = await runWorker({
      cwd, brief, model, effort, timeoutMs, attempts,
      heartbeatMs: 300_000,
      log: (line) => stdout.write(`${line}\n`),
    });
    appendLog(home, "worker_finished", { ok: result.ok, attempts: result.attempts, minutes: Math.round((Date.now() - startedAt) / 60_000) });
    const report = formatWorkerResult(result);
    saveWorkerReport(cwd, report);
    stdout.write(`${report}\n`);
    if (!result.ok) process.exitCode = 2;
  } finally {
    clearInterval(beat);
    held.release();
  }
}

const USAGE = `Usage: codex-chatgpt-web longrun [status [folder] | health [--hours <n>] | resume [<session-id>] | on | off | install | uninstall | worker <effort> | driver on|off]

  status [folder]   show whether long-run is on, whether Codex has the hooks, and how a folder is handled
  health [--hours]  are the long runs of the last day alive? per project: driver, worker, and what looks wrong
  resume [id]       resume Luna drivers whose turn died (Codex restarted); the bridge does this on its own every 2 minutes.
                    With a session id, send that driver a "continue" now; add --message "<text>" to say something else
  on / off          turn the automatic "finish, commit and push" reminders on or off
  install           (re)install the Codex hooks now; they are also kept in place whenever the bridge starts
  uninstall         remove the Codex hooks and switch long-run off
  worker <effort>   the ChatGPT web worker's effort when a Luna model drives a task: ${WORKER_EFFORTS.join(", ")}
  driver on|off     let a Luna model (Codex quota) drive tasks and hand the coding to the ChatGPT web worker`;

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
    let driverBlock = "not installed";
    try {
      const file = driverInstructionsPath();
      driverBlock = existsSync(file) && readFileSync(file, "utf8").includes(DRIVER_START) ? "installed" : "not installed";
    } catch { /* Status is informational. */ }
    write(`Luna drives, Sol works: ${settings.driver ? "ON" : "OFF"}. Worker: ${settings.workerModel} at ${settings.workerEffort} effort. Instructions in ~/.codex/AGENTS.md: ${driverBlock}.`);
    for (const line of describeProject(folder)) write(line);
    write("Worker access: full, with no sandbox and no approval prompts, so the worker is never refused a file, tool or network access.");
    write(`Limits per request: ${settings.maxContinuations} "commit and push" reminders, ${settings.maxHours} h. No tests, builds or acceptance checks run anywhere.`);
    write(`Settings file: ${longrunSettingsPath(home)}`);
    return;
  }

  if (action === "health") {
    const raw = optionValue(args, "--hours");
    const hours = raw === undefined ? 24 : Number(raw);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("--hours must be a number from 1 to 168");
    const settings = loadLongrunSettings(home);
    const now = Date.now();
    for (const line of formatHealth(scanSessions(getCodexHome(), now, settings, { hours }), now, (cwd) => liveWorker(cwd, home))) write(line);
    return;
  }


  if (action === "resume") {
    const target = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
    const message = optionValue(args, "--message") ?? resumeMessage();
    const settings = loadLongrunSettings(home);
    const now = Date.now();
    if (target) {
      const session = scanSessions(getCodexHome(), now, settings, { hours: 168, days: 14 }).find((item) => item.id === target);
      if (!session) throw new Error(`No Codex session ${target} was found in the last week.`);
      if (!session.cwd) throw new Error("That session has no folder to resume in.");
      const launched = launchResume(session, message, { onExit: (code, reason) => { write(`The resumed turn ended (exit code ${code ?? "none"}${reason ? `: ${reason}` : ""}).`); } });
      appendLog(home, launched.started ? "resume_started" : "resume_failed", { session: session.id, cwd: session.cwd, manual: true });
      if (!launched.started) throw new Error(`Could not resume: ${launched.reason}`);
      write(`Resumed ${session.model} in ${session.cwd}. Waiting for its turn to finish (Ctrl+C leaves it running).`);
      await new Promise<void>((done) => { process.once("SIGINT", () => done()); const wait = setInterval(() => {}, 1000); process.once("exit", () => clearInterval(wait)); });
      return;
    }
    const sessions = scanSessions(getCodexHome(), now, settings, { hours: 8, days: 2 });
    const verdicts = judgeDrivers({ now, sessions, appServerStartedAt: appServerStartedAt(), workerIn: (cwd) => liveWorker(cwd, home), history: loadResumeHistory(home) });
    if (verdicts.length === 0) write("No Luna drivers were active in the last 8 hours.");
    for (const verdict of verdicts) write(`${verdict.session.cwd}: ${verdict.resume ? "dead, resuming" : verdict.why}`);
    if (verdicts.some((verdict) => verdict.resume)) {
      const resumed = watchdogTick(defaultWatchdogDeps(home));
      write(`Resumed ${resumed.length} driver${resumed.length === 1 ? "" : "s"}; they continue in the background.`);
      if (resumed.length > 0) await new Promise((done) => setTimeout(done, 15_000));
    }
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

  if (action === "worker" || action === "driver") {
    const value = (args.shift() ?? "").toLowerCase();
    if (action === "worker") {
      const effort = WORKER_EFFORTS.find((item) => item === value);
      if (!effort) throw new Error(`Usage: codex-chatgpt-web longrun worker <${WORKER_EFFORTS.join("|")}>`);
      saveLongrunSettings({ workerEffort: effort }, home);
      write(`The ChatGPT web worker will run at ${effort} effort.`);
    } else {
      if (value !== "on" && value !== "off") throw new Error("Usage: codex-chatgpt-web longrun driver on|off");
      saveLongrunSettings({ driver: value === "on" }, home);
      write(value === "on" ? "Luna drives, Sol works is ON." : "Luna drives, Sol works is OFF.");
    }
    const result = syncDriverInstructions(loadConfig());
    if (result.action === "error") throw new Error(`The Codex instructions were not changed: ${result.message}`);
    write(result.action === "skipped" ? `Instructions were not changed: ${result.reason}.` : `Codex instructions: ${result.action}.`);
    write("Open a new Codex chat so it picks up the change.");
    return;
  }

  if (action === "uninstall") {
    saveLongrunSettings({ enabled: false }, home);
    try {
      const file = driverInstructionsPath();
      if (existsSync(file)) {
        const original = readFileSync(file, "utf8");
        const removed = removeDriverBlock(original);
        if (removed.removed) {
          if (removed.text.trim() === "") rmSync(file, { force: true });
          else atomicWriteFile(file, removed.text, { protectDirectory: false });
        }
      }
    } catch (error) {
      write(`The Luna driver instructions were not removed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
