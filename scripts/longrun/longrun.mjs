#!/usr/bin/env node
// Long-run supervisor: drives `codex exec` unattended for hours. It keeps a progress file the model
// maintains, resumes the same chat after a failure, hands the work to a fresh chat when the old one
// cannot continue, restarts the bridge launcher if it died, and only finishes when the acceptance
// command passes and the model has written `STATUS: DONE`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLLER_DEFAULTS, DEFAULTS, KIND, PROGRESS_TEMPLATE, buildBriefPrompt, buildContinuePrompt, buildDecidePrompt, buildHandoffPrompt,
  buildInitialPrompt, buildWatchPrompt, capText, classifyFailure, decideNext, extractJson, initialState, mergeControllerAdvice, normalizeAdvice,
  normalizeWatchAdvice, parseProgress,
} from "./lib.mjs";
import {
  JEV_DEFAULTS, JEV_MODES, JevError, classifyQuestions, classifyVerdict, createJevClient, decideQuestions, decideVerdict, jevState,
  settleDecide, settleWatch, watchQuestions, watchVerdict,
} from "./jev.mjs";
import { loadKey } from "./jev-key.mjs";

const sha = (value) => createHash("sha1").update(value).digest("hex");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function git(repo, args, input) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", input, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function checkPort(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
}

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d) => { out = (out + d).slice(-20_000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => { killTree(child); out += "\n[verify timed out]"; }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, tail: `${out}\n${e.message}`.slice(-6000) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, tail: out.slice(-6000) }); });
  });
}

export function findCodex() {
  if (process.env.LONGRUN_CODEX) return { exe: process.env.LONGRUN_CODEX, args: [] };
  const root = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (existsSync(root)) {
    const found = readdirSync(root)
      .map((d) => path.join(root, d, "codex.exe"))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (found[0]) return { exe: found[0], args: [] };
  }
  return { exe: "codex", args: [] };
}

function fingerprintOf(repo, files, isGit) {
  const progress = existsSync(files.progressAbs) ? readFileSync(files.progressAbs, "utf8") : "";
  if (isGit) {
    return sha([git(repo, ["rev-parse", "HEAD"]).out, git(repo, ["status", "--porcelain"]).out, sha(progress)].join("\n"));
  }
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if ([".git", ".longrun", "node_modules"].includes(name) || entries.length > 5000) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else entries.push(`${path.relative(repo, full)}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  walk(repo);
  return sha(`${entries.join("\n")}\n${sha(progress)}`);
}

/** Keeps one copy of the progress file per round so a handoff can notice (and recover from) a file that lost its content. */
function snapshotProgress(dirs, files, roundNo) {
  try {
    if (!existsSync(files.progressAbs)) return;
    const text = readFileSync(files.progressAbs, "utf8");
    if (!text.trim()) return;
    mkdirSync(dirs.history, { recursive: true });
    writeFileSync(path.join(dirs.history, `${String(roundNo).padStart(4, "0")}.md`), text);
  } catch {}
}

function largestSnapshot(dirs) {
  let best = "";
  try {
    for (const name of readdirSync(dirs.history).sort()) {
      const text = readFileSync(path.join(dirs.history, name), "utf8");
      if (text.length >= best.length) best = text;
    }
  } catch {}
  return best;
}

/** Runs one Codex round and reports how it ended. Never throws. */
function runCodexRound({ config, prompt, kind, threadId, roundNo, dirs, onEvent, fingerprint, onWatch }) {
  const common = [
    "--json", "--skip-git-repo-check", "-m", config.model, "-c", `model_reasoning_effort="${config.effort}"`,
    ...(config.compactLimit ? ["-c", `model_auto_compact_token_limit=${config.compactLimit}`] : []),
  ];
  const finalFile = path.join(dirs.rounds, `${String(roundNo).padStart(4, "0")}.final.txt`);
  const args = kind === "continue"
    ? ["exec", "resume", ...common, "-c", `sandbox_mode="${config.sandbox}"`, "-o", finalFile, threadId, "-"]
    : ["exec", ...common, "-s", config.sandbox, "-o", finalFile, "-"];
  const rawFile = path.join(dirs.rounds, `${String(roundNo).padStart(4, "0")}.jsonl`);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.codex.exe, [...config.codex.args, ...args], {
        cwd: config.repo, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ outcome: "failed", failureText: `spawn failed: ${error.message}`, durationMs: 0 });
      return;
    }
    const result = { outcome: undefined, threadId, failureText: "", lastMessage: "", durationMs: 0 };
    let lastActivity = Date.now();
    let buffer = "";
    let stderrTail = "";
    let sawCompleted = false;
    let turnFailed = "";
    let lastError = "";
    let stalled = false;
    let settled = false;
    // A round can look busy while going nowhere: reconnect and compaction errors keep arriving, or the model
    // re-reads the project after every compaction. Neither counts as activity; what counts is output that is not
    // a reconnect notice, and a change to the repository or the progress file.
    let stuckWhy = "";
    let lastFp = fingerprint?.();
    let lastFpAt = Date.now();
    let lastChange = Date.now();
    let compactionStreak = 0;
    let compactionFp;
    const stuck = (why) => { if (!stuckWhy) stuckWhy = why; killTree(child); };
    // What the controller is shown when it is asked, mid-round, whether this chat is still doing useful work.
    let restartWhy = "";
    let watching = false;
    let nextWatchMs = config.watchMs;
    let compactionErrors = 0;
    const recent = [];
    const commandCounts = new Map();
    const note = (event) => {
      let line;
      if (event.type === "item.completed" && event.item?.type === "command_execution") {
        const command = String(event.item.command ?? "").replace(/^"?[^"]*powershell(?:\.exe)?"?\s+-Command\s+/i, "").replace(/\s+/g, " ").trim().slice(0, 160);
        commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);
        line = `ran: ${command} (exit ${event.item.exit_code ?? "?"})`;
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
        line = `said: ${String(event.item.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
      } else if (event.type === "item.completed") line = `item: ${event.item?.type ?? "?"}`;
      else if (event.type === "error") line = `error: ${String(event.message ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
      if (line) { recent.push(line); if (recent.length > 25) recent.shift(); }
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      appendFileSync(rawFile, `${line}\n`);
      let event;
      try { event = JSON.parse(line); } catch { return; }
      onEvent?.(event);
      note(event);
      if (event.type === "error" && /compact/i.test(event.message ?? "")) compactionErrors += 1;
      const reconnecting = event.type === "error" && /^Reconnecting/i.test(event.message ?? "");
      if (!reconnecting) lastActivity = Date.now();
      if (event.type === "thread.started" && event.thread_id) result.threadId = event.thread_id;
      else if (event.type === "turn.completed") sawCompleted = true;
      else if (event.type === "turn.failed") turnFailed = event.error?.message ?? "turn failed";
      else if (event.type === "error" && event.message && !reconnecting) lastError = event.message;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") result.lastMessage = event.item.text ?? "";
      if (event.type === "error" && /compact/i.test(event.message ?? "") && fingerprint && config.policy.compactionErrorsBeforeFresh) {
        const fp = fingerprint();
        compactionStreak = fp === compactionFp ? compactionStreak + 1 : 1;
        compactionFp = fp;
        if (compactionStreak >= config.policy.compactionErrorsBeforeFresh) {
          stuck(`${compactionStreak} compaction failures in a row without any change to the repository or progress file`);
        }
      }
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) { handleLine(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    });
    child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-3000); });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);

    const fingerprintEveryMs = Math.min(30_000, config.pollMs * 6);
    const watchdog = setInterval(() => {
      const at = Date.now();
      if (at - lastActivity > config.stallMs) { stalled = true; killTree(child); return; }
      if (fingerprint && (config.progressMs || onWatch) && at - lastFpAt >= fingerprintEveryMs) {
        lastFpAt = at;
        const fp = fingerprint();
        if (fp !== lastFp) { lastFp = fp; lastChange = at; nextWatchMs = config.watchMs; }
        else if (config.progressMs && at - lastChange > config.progressMs) {
          stuck(`no change to the repository or progress file for ${Math.max(1, Math.round(config.progressMs / 60_000))} min while the round kept running`);
        }
      }
      // The controller looks at a round that has changed nothing for a while, long before the hard limit above.
      if (onWatch && !watching && !stuckWhy && !restartWhy && config.watchMs && at - lastChange >= nextWatchMs) {
        watching = true;
        const [topCommand, topCount] = [...commandCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
        const silentMs = at - lastActivity;
        Promise.resolve(onWatch({
          elapsedMs: at - startedAt, idleMs: at - lastChange, silentMs, recent: [...recent], compactionErrors,
          topCommand: topCount > 1 ? { command: topCommand, times: topCount } : undefined,
        })).then((advice) => {
          watching = false;
          nextWatchMs = Date.now() - lastChange + config.watchMs;
          if (settled || !advice) return;
          if (advice.action === "fresh") stuck(`the controller judged this chat stuck: ${advice.reason || "no reason given"}`);
          // A restart is only honoured for a process that really has gone quiet; one that is still producing output is not hung.
          else if (advice.action === "restart" && Date.now() - lastActivity >= config.stallMs / 4) {
            restartWhy = `the controller judged the process hung: ${advice.reason || "no reason given"}`;
            killTree(child);
          }
        }).catch(() => { watching = false; });
      }
    }, config.pollMs);

    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (buffer.trim()) handleLine(buffer);
      result.durationMs = Date.now() - startedAt;
      result.exitCode = exitCode;
      if (spawnError) { result.outcome = "failed"; result.failureText = `spawn failed: ${spawnError.message}`; }
      else if (stuckWhy) { result.outcome = "stuck"; result.failureText = stuckWhy; }
      else if (restartWhy) { result.outcome = "stalled"; result.failureText = restartWhy; }
      else if (stalled) { result.outcome = "stalled"; result.failureText = `no output for ${Math.round(config.stallMs / 1000)}s`; }
      else if (turnFailed || (exitCode !== 0 && !sawCompleted)) {
        result.outcome = "failed";
        result.failureText = [...new Set([turnFailed, lastError, stderrTail].filter(Boolean))].join("\n").slice(-4000) || `exit code ${exitCode}`;
      } else result.outcome = "completed";
      resolve(result);
    };
    child.on("error", (error) => finish(-1, error));
    child.on("close", (code) => finish(code));
    config.onChild?.(child);
  });
}

/**
 * One small, stateless call to the controller model (a fresh chat, read-only, outside the repository so
 * no project instructions leak in). Returns the model's text, or undefined on any failure or timeout.
 */
async function askController(config, state, prompt, tag, log) {
  if (!config.controller) return undefined;
  const cwd = path.join(os.tmpdir(), `longrun-controller-${state.id}`);
  mkdirSync(cwd, { recursive: true });
  const outFile = path.join(cwd, `${tag}.out.txt`);
  try { unlinkSync(outFile); } catch {}
  const args = [
    "exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-m", config.controllerModel,
    "-c", `model_reasoning_effort="${config.controllerEffort}"`, "-o", outFile, "-",
  ];
  state.controllerCalls = (state.controllerCalls ?? 0) + 1;
  const text = await new Promise((resolve) => {
    let child;
    try { child = spawn(config.codex.exe, [...config.codex.args, ...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { resolve(undefined); return; }
    let lastMessage = "";
    let buffer = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        try {
          const event = JSON.parse(buffer.slice(0, at));
          if (event.type === "item.completed" && event.item?.type === "agent_message") lastMessage = event.item.text ?? lastMessage;
        } catch {}
        buffer = buffer.slice(at + 1);
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, config.controllerTimeoutMs);
    const done = (code) => {
      clearTimeout(timer);
      const fromFile = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
      resolve(timedOut || (code !== 0 && !fromFile && !lastMessage) ? undefined : (fromFile || lastMessage));
    };
    child.on("error", () => done(-1));
    child.on("close", done);
  });
  if (text === undefined) { state.controllerFailures = (state.controllerFailures ?? 0) + 1; log(`controller ${tag}: no answer, using the built-in policy`); }
  else writeFileSync(path.join(config.stateDir, `controller-${String(state.controllerCalls).padStart(4, "0")}-${tag}.txt`), capText(text, 8000));
  return text;
}

/**
 * Jev is the controller's fast first line (see jev.mjs): one call returns its answers, or undefined when Jev is off or
 * failed, in which case the Codex model (or the policy alone) decides. A rejected key switches Jev off for the rest of
 * the run, and so do three failures in a row, so a dead API never slows every round.
 */
async function askJev(config, state, tag, evidence, questions, log) {
  const jev = config.jev;
  if (!jev || jev.disabled) return undefined;
  state.jevCalls = (state.jevCalls ?? 0) + 1;
  const started = Date.now();
  try {
    const answers = await jev.client.systemOne({ state: jevState(evidence, jev.secrets), questions });
    jev.failures = 0;
    writeFileSync(
      path.join(config.stateDir, `jev-${String(state.jevCalls).padStart(4, "0")}-${tag}.json`),
      JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - started, answers }, null, 2),
    );
    return answers;
  } catch (error) {
    state.jevFailures = (state.jevFailures ?? 0) + 1;
    jev.failures += 1;
    log(`Jev ${tag}: ${error instanceof JevError ? error.message : String(error?.message ?? error).slice(0, 200)}`);
    if (error instanceof JevError && (error.status === 401 || error.status === 403)) jev.disabled = `the API rejected the key (HTTP ${error.status})`;
    else if (jev.failures >= 3) jev.disabled = "3 failures in a row";
    if (jev.disabled) log(`Jev is off for the rest of this run: ${jev.disabled}`);
    return undefined;
  }
}

/**
 * Jev's part of a decide or watch consultation. Undefined means the Codex model answers alone (Jev off or failed);
 * otherwise { final, advice, effective }: `final` means Jev's answer stands and the Codex model is not asked. In `jev`
 * mode nothing arbitrates, so an answer that is not sure enough leaves the policy to decide; `shadow` is never final.
 */
async function consultJev(config, state, kind, evidence, proposed, log) {
  const jev = config.jev;
  const answers = await askJev(config, state, kind, evidence, kind === "decide" ? decideQuestions() : watchQuestions(), log);
  if (!answers) return undefined;
  const settled = kind === "decide" ? settleDecide(decideVerdict(answers), proposed, jev.thresholds) : settleWatch(watchVerdict(answers), jev.thresholds);
  if (!settled.reason) {
    state.jevFailures = (state.jevFailures ?? 0) + 1;
    log(`Jev ${kind}: the answer had an unexpected shape; ignoring it`);
    return undefined;
  }
  if (jev.mode === "shadow") {
    log(`Jev (shadow) ${kind}: ${settled.reason}`);
    return { final: false, effective: settled.effective };
  }
  if (settled.final) {
    state.jevAccepted = (state.jevAccepted ?? 0) + 1;
    log(`Jev ${kind} stands: ${settled.reason}`);
    return settled;
  }
  if (jev.mode === "jev") {
    log(`Jev ${kind} is not sure enough (${settled.reason}); the policy decides`);
    return { final: true, effective: settled.effective };
  }
  state.jevEscalated = (state.jevEscalated ?? 0) + 1;
  log(`Jev ${kind}: ${settled.reason}; asking ${config.controllerModel}`);
  return { final: false, effective: settled.effective };
}

/** Counts how often Jev and the Codex model would have done the same thing, whenever both were asked. */
function noteAgreement(config, state, kind, jevEffective, lunaEffective, log) {
  if (!jevEffective || !lunaEffective) return;
  const key = jevEffective === lunaEffective ? "jevAgree" : "jevDisagree";
  state[key] = (state[key] ?? 0) + 1;
  if (key === "jevDisagree") log(`Jev and ${config.controllerModel} disagree on ${kind}: Jev ${jevEffective}, ${config.controllerModel} ${lunaEffective}`);
}

/** Second opinion on a failure the regex rules could not place; it only ever moves to a recoverable kind. */
async function reclassifyFailure(config, state, text, log) {
  const answers = await askJev(config, state, "classify", capText(text, 4000), classifyQuestions(), log);
  const verdict = classifyVerdict(answers, config.jev.thresholds);
  if (!verdict) return undefined;
  if (config.jev.mode === "shadow") { log(`Jev (shadow) classify: ${verdict.jevKind}`); return undefined; }
  if (verdict.kind) log(`Jev classifies this failure as ${verdict.kind} (confidence ${Math.round(verdict.confidence * 100)}%)`);
  return verdict.kind;
}

/** Turns the controller mode and the stored key into the runtime Jev state, or undefined when Jev stays off. */
function setupJev(config, userConfig, log) {
  const requested = config.controllerMode;
  if (requested === "luna") {
    if (config.requireJev) throw new Error("Jev is required (--require-jev) but the controller mode is luna");
    return undefined;
  }
  // Jev does not depend on the Codex model: with that model switched off nothing can arbitrate, so Jev decides when it
  // is sure and the policy decides otherwise (what `jev` mode does).
  const mode = !config.controller && requested === "auto" ? "jev" : requested;
  const fallback = config.controller ? `${config.controllerModel} decides alone` : "the built-in policy decides alone";
  let client = userConfig.jevClient;
  let secrets = [];
  let origin = "injected client";
  if (!client) {
    const found = loadKey({ file: userConfig.jevKeyFile });
    if (!found.key) {
      const problem = found.source === "unreadable"
        ? `the stored API key cannot be read (${found.error}); run "node scripts/longrun/jev-key.mjs set" again`
        : 'Jev is not set up; run "node scripts/longrun/jev-key.mjs set"';
      if (config.requireJev) throw new Error(`Jev is required (--require-jev) but ${problem}`);
      log(`Jev is OFF: ${problem}. ${fallback}.`);
      return undefined;
    }
    client = createJevClient({
      apiKey: found.key, baseUrl: userConfig.jevBaseUrl ?? process.env.LONGRUN_JEV_URL ?? JEV_DEFAULTS.baseUrl,
      model: userConfig.jevModel ?? JEV_DEFAULTS.model, timeoutMs: userConfig.jevTimeoutMs ?? JEV_DEFAULTS.timeoutMs,
    });
    secrets = [found.key];
    origin = found.source === "env" ? "key from the environment" : `key stored with ${found.scheme}`;
  }
  const thresholds = {
    minConfidence: userConfig.jevMinConfidence ?? JEV_DEFAULTS.minConfidence,
    highConfidence: userConfig.jevHighConfidence ?? JEV_DEFAULTS.highConfidence,
  };
  if (!(thresholds.minConfidence > 0 && thresholds.minConfidence <= thresholds.highConfidence && thresholds.highConfidence <= 1)) {
    throw new Error("Jev confidence thresholds must satisfy 0 < min <= high <= 1");
  }
  log(`Jev is on (${mode}; ${origin}; confidence ${thresholds.minConfidence} / ${thresholds.highConfidence})`);
  return { client, mode, secrets, thresholds, failures: 0, disabled: undefined };
}

/** The facts the controller reasons over, capped so the call stays small. */
function buildEvidence({ config, state, round, proposal, verify, progressText, lastMessage, isGit, big }) {
  const thread = state.threads.at(-1);
  const lines = [
    `Original task (start): ${capText(config.taskText.trim().replace(/\s+/g, " "), big ? 4000 : 1500)}`,
    `Elapsed ${((Date.now() - state.startedAt) / 3_600_000).toFixed(1)}h; supervisor rounds ${state.rounds}; chats used ${state.threads.length}; rounds on the current chat ${thread ? state.rounds - thread.firstRound + 1 : 0}.`,
    `Counters: consecutiveFailures=${state.consecutiveFailures}, sameChatFailures=${state.sameThreadFailures}, roundsWithoutChange=${state.noProgressRounds}, failuresByKind=${JSON.stringify(state.failuresByKind)}.`,
    proposal ? `The supervisor's own proposal: action=${proposal.action}, reason=${proposal.reason}.` : "",
    `Last round: ${round.outcome} after ${Math.round((round.durationMs ?? 0) / 1000)}s.`,
    round.failureText ? `Failure text:\n${capText(round.failureText, 1500)}` : "",
    lastMessage ? `Last message from the agent:\n${capText(lastMessage, big ? 3000 : 1500)}` : "",
    verify ? `Acceptance command (${config.verify}): ${verify.ok ? "passing" : "failing"}\n${capText(verify.tail ?? "", 1500)}` : "",
    `Progress file (${big ? "large part" : "start"}):\n${progressText ? capText(progressText, big ? 20_000 : 4500) : "(missing or empty)"}`,
    isGit ? `Recent commits:\n${git(config.repo, ["log", "--oneline", big ? "-30" : "-8"]).out || "(none)"}` : "",
    isGit ? `Uncommitted changes:\n${capText(git(config.repo, ["status", "--short"]).out || "(clean)", 800)}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

function prepareGit(config, state, log) {
  const isGit = git(config.repo, ["rev-parse", "--is-inside-work-tree"]).out === "true";
  if (!isGit) return { isGit };
  const exclude = git(config.repo, ["rev-parse", "--git-path", "info/exclude"]).out;
  if (exclude) {
    const file = path.resolve(config.repo, exclude);
    const rel = path.relative(config.repo, config.stateDir).replace(/\\/g, "/");
    const entry = `${rel}/`;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!existing.split(/\r?\n/).includes(entry) && !rel.startsWith("..")) {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${existing.endsWith("\n") || !existing ? "" : "\n"}${entry}\n`);
    }
  }
  if (!state.branch && config.branch) {
    const dirty = git(config.repo, ["status", "--porcelain"]).out;
    if (dirty && !config.allowDirty) {
      throw new Error("The working tree has uncommitted changes. Commit or stash them, or pass --allow-dirty.");
    }
    const name = `longrun/${state.id}`;
    const made = git(config.repo, ["checkout", "-b", name]);
    if (!made.ok) throw new Error(`Could not create branch ${name}: ${made.err}`);
    state.branch = name;
    log(`working on branch ${name}`);
  }
  return { isGit };
}

function checkpoint(config, isGit, roundNo, log) {
  if (!isGit || config.noCheckpoint) return;
  if (!git(config.repo, ["status", "--porcelain"]).out) return;
  git(config.repo, ["add", "-A"]);
  const identity = git(config.repo, ["config", "user.email"]).out
    ? [] : ["-c", "user.name=longrun", "-c", "user.email=longrun@localhost"];
  const done = git(config.repo, [
    ...identity, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", `${config.checkpointPrefix}checkpoint before round ${roundNo}`,
  ]);
  if (done.ok) log(`checkpoint commit before round ${roundNo}`);
}

async function ensureBridge(config, log, sleep) {
  if (!config.bridgePort) return true;
  if (await checkPort(config.bridgePort)) return true;
  log(`bridge on port ${config.bridgePort} is not reachable`);
  const launch = () => {
    if (!(config.launcher && existsSync(config.launcher))) return;
    log("starting the launcher");
    try { spawn(config.launcher, config.launcherArgs ?? [], { detached: true, stdio: "ignore", windowsHide: false }).unref(); }
    catch (error) { log(`could not start the launcher: ${error.message}`); }
  };
  launch();
  const deadline = Date.now() + config.bridgeWaitMs;
  let lastLaunch = Date.now();
  while (Date.now() < deadline) {
    await sleep(config.bridgePollMs ?? 3000);
    if (await checkPort(config.bridgePort)) { log("bridge is back"); return true; }
    // A launch can be swallowed (an instance that is still shutting down holds the single-instance lock), so it is
    // retried while waiting; an extra launch of a running app is harmless.
    if (Date.now() - lastLaunch >= (config.relaunchMs ?? 45_000)) { lastLaunch = Date.now(); launch(); }
  }
  return false;
}

function startKeepAwake(config) {
  if (!config.keepAwake || process.platform !== "win32") return undefined;
  const script = [
    "Add-Type -Namespace W -Name K -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
    "while ($true) { [W.K]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 30 }",
  ].join("; ");
  return spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    stdio: "ignore", windowsHide: true,
  });
}

/** What other sessions read to see whether Jev is deciding in this run. */
function jevStatus(config, state) {
  const jev = config.jev;
  const off = !jev ? (config.controllerMode === "luna" ? "controller mode luna" : "not set up") : jev.disabled;
  return {
    active: Boolean(jev) && !jev.disabled, mode: jev?.mode ?? config.controllerMode, ...(off ? { off } : {}),
    calls: state.jevCalls ?? 0, answeredAlone: state.jevAccepted ?? 0, sentOn: state.jevEscalated ?? 0,
    failures: state.jevFailures ?? 0, agreed: state.jevAgree ?? 0, disagreed: state.jevDisagree ?? 0,
  };
}

function writeReport(dirs, state, extra, jev) {
  const lines = [
    "# Long-run report", "",
    `- Status: **${state.status}**${state.stopReason ? ` (${state.stopReason})` : ""}`,
    `- Branch: ${state.branch ?? "(not a git repository)"}`,
    `- Rounds: ${state.rounds}`,
    `- Chats used: ${state.threads.length}`,
    `- Started: ${new Date(state.startedAt).toISOString()}`,
    `- Failures by kind: ${JSON.stringify(state.failuresByKind)}`,
    `- Controller calls: ${state.controllerCalls ?? 0} (unanswered: ${state.controllerFailures ?? 0})`,
    ...(jev ? [`- Jev: ${jev.active ? `on (${jev.mode})` : `OFF (${jev.off})`}`] : []),
    ...(state.jevCalls
      ? [`- Jev calls: ${state.jevCalls} (answered alone: ${state.jevAccepted ?? 0}, sent on to the Codex model: ${state.jevEscalated ?? 0}, failed: ${state.jevFailures ?? 0}; agreed with the Codex model on ${state.jevAgree ?? 0} of ${(state.jevAgree ?? 0) + (state.jevDisagree ?? 0)})`]
      : []),
    `- Last acceptance: ${state.lastVerify ? (state.lastVerify.ok ? "passing" : "failing") : "not run"}`,
    "", "## Chats", ...state.threads.map((t) => `- ${t.id} (round ${t.firstRound}, ${t.reason})`),
    ...(extra ? ["", extra] : []),
  ];
  writeFileSync(path.join(dirs.state, "REPORT.md"), lines.join("\n"));
  writeJsonAtomic(path.join(dirs.state, "STATUS.json"), {
    status: state.status, stopReason: state.stopReason, rounds: state.rounds, branch: state.branch,
    threads: state.threads.length, lastVerify: state.lastVerify, ...(jev ? { jev } : {}), updatedAt: new Date().toISOString(),
  });
}

export async function runLongRun(userConfig, deps = {}) {
  const config = {
    model: "chatgpt-web/gpt-6-sol", effort: "xhigh", sandbox: "workspace-write", branch: true, keepAwake: true,
    checkpointPrefix: "longrun: ", bridgeWaitMs: 180_000, pollMs: 5000, bridgePort: 17841, ...userConfig,
  };
  config.policy = { ...DEFAULTS, ...(userConfig.policy ?? {}) };
  config.stallMs = userConfig.stallMs ?? config.policy.stallMinutes * 60_000;
  config.progressMs = userConfig.progressMs ?? config.policy.roundProgressMinutes * 60_000;
  config.watchMs = userConfig.watchMs ?? config.policy.watchMinutes * 60_000;
  config.repo = path.resolve(config.repo);
  config.stateDir = path.resolve(config.stateDir ?? path.join(config.repo, ".longrun"));
  config.codex = config.codex ?? findCodex();
  // The coding rounds run on the ChatGPT web quota (a chatgpt-web/* model through the bridge). The controller is
  // a small native model that only advises, so it is cheap and its model and effort can be changed freely.
  config.controller = userConfig.controller ?? true;
  config.controllerModel = userConfig.controllerModel ?? process.env.LONGRUN_CONTROLLER_MODEL ?? CONTROLLER_DEFAULTS.model;
  config.controllerEffort = userConfig.controllerEffort ?? process.env.LONGRUN_CONTROLLER_EFFORT ?? CONTROLLER_DEFAULTS.effort;
  config.controllerTimeoutMs = userConfig.controllerTimeoutMs ?? CONTROLLER_DEFAULTS.timeoutMinutes * 60_000;
  config.controllerEvery = userConfig.controllerEvery ?? 1;
  // Jev answers the routine controller questions first and the Codex model only gets the uncertain ones (see jev.mjs).
  config.controllerMode = userConfig.controllerMode ?? process.env.LONGRUN_CONTROLLER_MODE ?? "auto";
  if (!JEV_MODES.includes(config.controllerMode)) throw new Error(`Unknown controller mode "${config.controllerMode}" (use ${JEV_MODES.join(", ")})`);
  config.requireJev = userConfig.requireJev ?? /^(1|true|yes)$/i.test(process.env.LONGRUN_REQUIRE_JEV ?? "");
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  const dirs = { state: config.stateDir, rounds: path.join(config.stateDir, "rounds"), history: path.join(config.stateDir, "progress-history") };
  mkdirSync(dirs.rounds, { recursive: true });
  const inRepo = !path.relative(config.repo, config.stateDir).startsWith("..");
  const progressAbs = path.join(config.stateDir, "PROGRESS.md");
  const files = { progressAbs, progress: inRepo ? path.relative(config.repo, progressAbs).replace(/\\/g, "/") : progressAbs };
  const log = (message, extra = {}) => {
    if (!config.quiet) console.log(`[${stamp()}] ${message}`);
    appendFileSync(path.join(dirs.state, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), message, ...extra })}\n`);
  };
  config.jev = setupJev(config, userConfig, log);

  const taskText = config.taskText ?? readFileSync(config.task, "utf8");
  config.taskText = taskText;
  const taskHash = sha(taskText);
  const stateFile = path.join(dirs.state, "state.json");
  const lock = path.join(dirs.state, "lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; }
    if (alive) throw new Error(`Another long-run supervisor (pid ${pid}) is using ${dirs.state}`);
  }
  writeFileSync(lock, String(process.pid));

  let state;
  if (existsSync(stateFile) && !config.restart) {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (state.taskHash !== taskHash) throw new Error("The task changed since this state was created. Pass --restart to start over.");
    if (state.status !== "running") {
      log(`state is already ${state.status}${state.stopReason ? ` (${state.stopReason})` : ""}`);
      unlinkSync(lock);
      return state;
    }
    log(`resuming: round ${state.rounds}, chat ${state.threadId ?? "(none)"}`);
  } else {
    state = initialState({ id: `${new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 14)}`, taskHash, now: now() });
  }
  const { isGit } = prepareGit(config, state, log);
  if (!existsSync(progressAbs)) writeFileSync(progressAbs, PROGRESS_TEMPLATE);
  writeJsonAtomic(stateFile, state);

  const keepAwake = startKeepAwake(config);
  let activeChild;
  config.onChild = (child) => { activeChild = child; };
  const onSignal = () => { if (activeChild) killTree(activeChild); try { unlinkSync(lock); } catch {} keepAwake?.kill(); process.exit(130); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    while (state.status === "running") {
      const roundNo = state.rounds + 1;
      const bridgeUp = await ensureBridge(config, log, sleep);
      checkpoint(config, isGit, roundNo, log);

      const verifyPrev = state.lastVerify;
      const kind = !state.threadId ? (state.rounds === 0 ? "initial" : "handoff") : state.pending === "fresh" ? "handoff" : "continue";
      const progressText = existsSync(progressAbs) ? readFileSync(progressAbs, "utf8") : "";
      const promptInput = { task: taskText, files, verifyCommand: config.verify };
      const { hint, brief } = state;
      const roundConfig = config.compactLimit && (state.compactScale ?? 1) > 1
        ? { ...config, compactLimit: Math.round(config.compactLimit * state.compactScale) } : config;
      if (roundConfig !== config) log(`forced compaction limit raised to ${roundConfig.compactLimit} tokens after a stuck round`);
      const prompt = kind === "initial" ? buildInitialPrompt(promptInput)
        : kind === "continue" ? buildContinuePrompt({ round: roundNo, files, verifyCommand: config.verify, verify: verifyPrev, reason: state.reason, hint })
          : buildHandoffPrompt({
            ...promptInput, progressText, earlierProgress: largestSnapshot(dirs), round: roundNo, reason: state.reason, verify: verifyPrev, brief, hint,
            // The new chat's window is about compactLimit tokens (roughly 4 characters each); quote at most about half of it.
            budgetChars: roundConfig.compactLimit ? roundConfig.compactLimit * 2 : undefined,
            gitLog: isGit ? git(config.repo, ["log", "--oneline", "-30"]).out : "",
            gitStatus: isGit ? capText(git(config.repo, ["status", "--short"]).out, 3000) : "",
          });
      state.hint = undefined;
      if (kind !== "continue") state.threadId = undefined;

      // A chat is recorded the moment it starts, not when its round ends, so a crashed supervisor (or machine)
      // resumes the same chat instead of abandoning it; the briefing is kept until a handoff chat really started.
      const adoptThread = (id) => {
        if (!id || id === state.threadId) return;
        state.threadId = id;
        state.threads.push({ id, firstRound: roundNo, reason: kind === "initial" ? "initial" : state.reason ?? kind });
        state.pending = "continue";
        state.brief = undefined;
        writeJsonAtomic(stateFile, state);
      };

      log(`round ${roundNo}: ${kind}${state.threadId ? ` (chat ${state.threadId})` : ""}`);
      const round = bridgeUp
        ? await runCodexRound({
          config: roundConfig, prompt, kind, threadId: state.threadId, roundNo, dirs,
          onEvent: (event) => { if (event.type === "thread.started") adoptThread(event.thread_id); },
          fingerprint: () => fingerprintOf(config.repo, files, isGit),
          // The controller (Luna by default) also judges a round while it is running, not only between rounds.
          onWatch: (config.controller || config.jev) && config.watchMs ? async (w) => {
            if (config.bridgePort && !(await checkPort(config.bridgePort))) return undefined;
            const progressText = existsSync(progressAbs) ? readFileSync(progressAbs, "utf8") : "";
            const evidence = [
              `Original task (start): ${capText(config.taskText.trim().replace(/\s+/g, " "), 1500)}`,
              `Round ${roundNo} (${kind}) has been running ${Math.round(w.elapsedMs / 60_000)} min. The repository and the progress file have not changed for ${Math.round(w.idleMs / 60_000)} min.`,
              `Chats used so far: ${state.threads.length}; failures so far: ${JSON.stringify(state.failuresByKind)}; stuck rounds in a row: ${state.stuckInARow ?? 0}.`,
              `Time since the process last produced any output (reconnect notices excluded): ${w.silentMs < 90_000 ? `${Math.round(w.silentMs / 1000)} s` : `${Math.round(w.silentMs / 60_000)} min`}.`,
              `Compaction errors in this round: ${w.compactionErrors}.`,
              w.topCommand ? `Most repeated command this round: ${w.topCommand.command} (${w.topCommand.times} times).` : "",
              `Recent activity, oldest first:\n${w.recent.length ? w.recent.join("\n") : "(no commands or messages yet)"}`,
              `Progress file (start):\n${progressText ? capText(progressText, 2500) : "(missing or empty)"}`,
              isGit ? `Uncommitted changes:\n${capText(git(config.repo, ["status", "--short"]).out || "(clean)", 600)}` : "",
            ].filter(Boolean).join("\n\n");
            const jev = config.jev ? await consultJev(config, state, "watch", evidence, undefined, log) : undefined;
            if (jev?.final) return jev.advice;
            if (!config.controller) return undefined;
            const answer = await askController(config, state, buildWatchPrompt(evidence), "watch", log);
            const advice = normalizeWatchAdvice(extractJson(answer));
            if (answer !== undefined && !advice) log("controller watch answered in an unexpected format; ignoring it");
            if (advice) log(`controller watch: ${advice.action}${advice.reason ? ` (${advice.reason})` : ""}`);
            if (jev && advice) noteAgreement(config, state, "watch", jev.effective, advice.action, log);
            return advice;
          } : undefined,
        })
        : { outcome: "failed", failureText: "bridge unreachable (ECONNREFUSED)", durationMs: 0 };
      adoptThread(round.threadId);
      snapshotProgress(dirs, files, roundNo);
      log(`round ${roundNo} ${round.outcome} after ${Math.round(round.durationMs / 1000)}s${round.failureText ? `: ${capText(round.failureText.replace(/\s+/g, " "), 300)}` : ""}`);

      let verify;
      if (round.outcome === "completed" && config.verify) {
        verify = await runShell(config.verify, config.repo, config.policy.verifyTimeoutMinutes * 60_000);
        verify = { ...verify, at: new Date().toISOString() };
        state.lastVerify = verify;
        log(`acceptance ${verify.ok ? "passed" : "failed"}`);
      }
      const progressNow = existsSync(progressAbs) ? readFileSync(progressAbs, "utf8") : "";
      const progress = parseProgress(progressNow);
      const effectiveVerify = config.verify ? (verify ?? state.lastVerify) : undefined;
      // An error text the regex rules cannot place is called transient; Jev may recognise a rate limit, a login or a full context in it.
      if (bridgeUp && config.jev && round.outcome === "failed" && round.failureText && !round.kind
        && classifyFailure(round.failureText) === KIND.TRANSIENT) {
        round.kind = await reclassifyFailure(config, state, round.failureText, log);
      }
      let decision = decideNext({
        state, round, verify: effectiveVerify, progress,
        fingerprint: fingerprintOf(config.repo, files, isGit), now: now(), jitter: deps.jitter ?? Math.random(), opts: config.policy,
      });
      // The controller may pick between continuing and a fresh chat; the policy keeps every hard limit.
      // The controller is a model behind the same bridge: while the bridge is down a call can only time out.
      const controllerUsable = config.controller && (!config.bridgePort || await checkPort(config.bridgePort));
      const jevUsable = Boolean(config.jev) && !config.jev.disabled && bridgeUp;
      const consult = (controllerUsable || jevUsable) && (decision.action === "continue" || decision.action === "fresh")
        && decision.reason !== "rate_limited" && decision.reason !== "waiting_for_login"
        && (round.outcome !== "completed" || decision.state.rounds % config.controllerEvery === 0);
      if (consult) {
        const evidence = buildEvidence({ config, state: decision.state, round, proposal: decision, verify: effectiveVerify, progressText: progressNow, lastMessage: round.lastMessage, isGit });
        const jev = config.jev ? await consultJev(config, decision.state, "decide", evidence, decision.action, log) : undefined;
        let advice = jev?.advice;
        if (!jev?.final && controllerUsable) {
          const answer = await askController(config, decision.state, buildDecidePrompt(evidence), "decide", log);
          advice = normalizeAdvice(extractJson(answer));
          if (answer !== undefined && !advice) { decision.state.controllerFailures += 1; log("controller answered in an unexpected format; ignoring it"); }
          if (jev && advice) noteAgreement(config, decision.state, "decide", jev.effective, advice.contextHealth === "polluted" ? "fresh" : advice.action, log);
        }
        if (advice) {
          log(`controller: ${advice.action}, context ${advice.contextHealth}${advice.reason ? `: ${advice.reason}` : ""}`);
          decision = mergeControllerAdvice({ decision, advice, state: decision.state, opts: config.policy });
          if (decision.reason.startsWith("controller_")) log(`controller changed the plan to ${decision.action}`);
        }
      }
      if (controllerUsable && decision.action === "fresh") {
        const evidence = buildEvidence({ config, state: decision.state, round, verify: effectiveVerify, progressText: progressNow, lastMessage: round.lastMessage, isGit, big: true });
        const written = await askController(config, decision.state, buildBriefPrompt(evidence), "brief", log);
        if (written?.trim()) decision.state.brief = capText(written.trim(), 6000);
      }
      state = { ...decision.state, pending: decision.action === "fresh" ? "fresh" : "continue", reason: decision.reason };
      if (decision.action === "fresh") state.threadId = undefined;
      writeJsonAtomic(stateFile, state);
      writeReport(dirs, state, undefined, jevStatus(config, state));
      log(`decision: ${decision.action} (${decision.reason})${decision.waitMs ? `, waiting ${Math.round(decision.waitMs / 1000)}s` : ""}`, { round: roundNo });
      await deps.afterRound?.(state, round);
      if (decision.waitMs) await sleep(decision.waitMs);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    keepAwake?.kill();
    try { unlinkSync(lock); } catch {}
  }

  log(`finished: ${state.status} (${state.stopReason})`);
  if (config.notifyCmd) {
    spawnSync(config.notifyCmd, { shell: true, windowsHide: true, env: { ...process.env, LONGRUN_STATUS: state.status, LONGRUN_REASON: state.stopReason ?? "" } });
  }
  return state;
}

function parseArgs(argv) {
  const out = { policy: {} };
  const flags = {
    "--repo": "repo", "--task": "task", "--verify": "verify", "--effort": "effort", "--model": "model", "--sandbox": "sandbox",
    "--state-dir": "stateDir", "--bridge-port": ["bridgePort", Number], "--compact-limit": ["compactLimit", Number],
    "--launcher": "launcher", "--codex": "codexExe", "--checkpoint-prefix": "checkpointPrefix", "--notify-cmd": "notifyCmd",
    "--controller-model": "controllerModel", "--controller-effort": "controllerEffort", "--controller-every": ["controllerEvery", Number],
    "--controller-mode": "controllerMode", "--jev-confidence": ["jevMinConfidence", Number], "--jev-high-confidence": ["jevHighConfidence", Number],
    "--max-hours": ["policy.maxHours", Number], "--stall-minutes": ["policy.stallMinutes", Number], "--progress-minutes": ["policy.roundProgressMinutes", Number], "--watch-minutes": ["policy.watchMinutes", Number],
    "--max-failures": ["policy.maxConsecutiveFailures", Number], "--max-rounds": ["policy.maxRounds", Number],
  };
  const bools = { "--allow-dirty": "allowDirty", "--no-branch": ["branch", false], "--no-checkpoint": "noCheckpoint", "--restart": "restart", "--no-keep-awake": ["keepAwake", false], "--no-controller": ["controller", false], "--require-jev": "requireJev","--accept-verify-only": ["policy.acceptVerifyOnly", true] };
  const set = (key, value) => { if (key.startsWith("policy.")) out.policy[key.slice(7)] = value; else out[key] = value; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags[arg]) {
      const [key, cast] = Array.isArray(flags[arg]) ? flags[arg] : [flags[arg], String];
      set(key, cast(argv[++i]));
    } else if (bools[arg]) {
      const [key, value] = Array.isArray(bools[arg]) ? bools[arg] : [bools[arg], true];
      set(key, value);
    } else throw new Error(`Unknown option ${arg}`);
  }
  if (out.codexExe) out.codex = { exe: out.codexExe, args: [] };
  return out;
}

const USAGE = `Usage: node longrun.mjs --repo <dir> --task <file.md> --verify "<command>" [options]

  --effort medium|high|xhigh   effort of the coding chat (default xhigh)   --model <id>   (default chatgpt-web/gpt-6-sol, web quota)
  --controller-model <id>      small model that supervises (default gpt-6-luna, Codex quota; env LONGRUN_CONTROLLER_MODEL)
  --controller-effort <e>      its effort (default high; env LONGRUN_CONTROLLER_EFFORT)
  --no-controller              switch the Codex controller model off (Jev, when set up, still decides)   --controller-every <n>  consult after every n-th ok round
  --controller-mode <m>        auto (default): Jev first, the Codex model only when Jev is unsure; jev | shadow | luna (env LONGRUN_CONTROLLER_MODE)
  --require-jev                refuse to start unless Jev is set up and the mode uses it (env LONGRUN_REQUIRE_JEV=1)
  --jev-confidence <0-1>       Jev answers alone above this (default 0.6); --jev-high-confidence <0-1> to kill a round or override the policy (0.85)
                               Jev needs a key: node scripts/longrun/jev-key.mjs set
  --sandbox <mode>             workspace-write | danger-full-access (default workspace-write)
  --max-hours <n>              wall-clock budget (default 24)       --stall-minutes <n>     kill a silent round (default 30)
  --watch-minutes <n>          the controller judges a running round that changed nothing for n minutes (default 10, 0 = off)
  --progress-minutes <n>       a running round that changes nothing for n minutes is killed, next chat is fresh (default 40, 0 = off)
  --compact-limit <tokens>     force earlier auto-compaction (testing)
  --accept-verify-only         finish when the command passes even without STATUS: DONE
  --allow-dirty  --no-branch  --no-checkpoint  --restart  --no-keep-awake
  --launcher <exe>  --bridge-port <n>  --notify-cmd "<cmd>"  --state-dir <dir>

Re-run the same command to resume after a reboot: state lives in <repo>/.longrun.`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.repo || !args.task) { console.log(USAGE); process.exit(1); }
    if (!args.launcher && process.env.LOCALAPPDATA) {
      args.launcher = path.join(process.env.LOCALAPPDATA, "Programs", "Codex Web GPT", "Codex Web GPT.exe");
    }
    const state = await runLongRun(args);
    process.exit(state.status === "done" ? 0 : 2);
  } catch (error) {
    console.error(`longrun: ${error.message}`);
    process.exit(1);
  }
}
