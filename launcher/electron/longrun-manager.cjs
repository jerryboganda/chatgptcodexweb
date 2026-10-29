const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { processRunning, terminateOwnedProcessTree } = require("./process-tree.cjs");

const EFFORTS = ["medium", "high", "xhigh"];
const SANDBOXES = ["workspace-write", "danger-full-access"];
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_DELAY_MS = 15_000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function sameRepo(a, b) {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function lastLine(file, bytes = 4096) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      return lines[lines.length - 1];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Turns what the form sent into a job record, or throws an Error whose message the form can show. */
function normalizeInput(input, { existingRepos = [], statSync = fs.statSync } = {}) {
  if (!input || typeof input !== "object") throw new Error("Missing job details.");
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (!repo || !path.isAbsolute(repo)) throw new Error("Choose the project folder.");
  let isDirectory = false;
  try { isDirectory = statSync(repo).isDirectory(); } catch {}
  if (!isDirectory) throw new Error("The project folder does not exist.");
  if (existingRepos.some((other) => sameRepo(other, repo))) throw new Error("This project folder already has a long-run job.");
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (task.length < 20) throw new Error("Describe the task in a few sentences.");
  if (task.length > 200_000) throw new Error("The task is too long.");
  const effort = input.effort ?? "xhigh";
  if (!EFFORTS.includes(effort)) throw new Error("Effort must be medium, high or xhigh.");
  const sandbox = input.sandbox ?? "workspace-write";
  if (!SANDBOXES.includes(sandbox)) throw new Error("Unknown sandbox mode.");
  const maxHours = input.maxHours === undefined || input.maxHours === "" ? 24 : Number(input.maxHours);
  if (!Number.isFinite(maxHours) || maxHours < 1 || maxHours > 168) throw new Error("Time budget must be 1 to 168 hours.");
  const verify = typeof input.verify === "string" ? input.verify.trim() : "";
  if (verify.length > 2000) throw new Error("The acceptance command is too long.");
  const title = (typeof input.title === "string" && input.title.trim()) || path.basename(repo);
  return {
    title: title.slice(0, 80),
    repo: path.resolve(repo),
    task,
    verify,
    effort,
    sandbox,
    maxHours,
    controller: input.controller !== false,
  };
}

/** The supervisor's command line for one job. `--launcher` is this app, so a swallowed bridge restart reopens it. */
function buildArgs(job, { scriptPath, taskFile, launcher, restart = false }) {
  const args = [
    scriptPath,
    "--repo", job.repo,
    "--task", taskFile,
    "--effort", job.effort,
    "--sandbox", job.sandbox,
    "--max-hours", String(job.maxHours),
  ];
  if (job.verify) args.push("--verify", job.verify);
  if (job.controller === false) args.push("--no-controller");
  if (launcher) args.push("--launcher", launcher);
  if (restart) args.push("--restart");
  return args;
}

class LongrunManager {
  /**
   * @param {object} options
   * @param {string} options.dataDir where jobs.json and the per-job folders live
   * @param {string} options.scriptPath longrun.mjs
   * @param {string} options.executable runs the script (the app itself, in ELECTRON_RUN_AS_NODE mode)
   * @param {object} [options.env] extra environment for the supervisor
   * @param {string} [options.launcher] what the supervisor starts when the bridge is down
   */
  constructor({
    dataDir, scriptPath, executable, env = {}, launcher, logger, onChange = () => {}, onFinished = () => {},
    restartDelayMs = RESTART_DELAY_MS, spawnProcess = spawn, now = () => Date.now(),
  }) {
    Object.assign(this, { dataDir, scriptPath, executable, env, launcher, logger, onChange, onFinished, restartDelayMs, spawnProcess, now });
    this.jobsFile = path.join(dataDir, "jobs.json");
    this.children = new Map();
    this.timers = new Map();
    this.restarts = new Map();
    this.errors = new Map();
    this.stopping = new Set();
    this.shuttingDown = false;
    this.jobs = this.#load();
  }

  available() {
    return fs.existsSync(this.scriptPath);
  }

  #load() {
    const data = readJson(this.jobsFile);
    return Array.isArray(data?.jobs) ? data.jobs.filter((job) => job && typeof job.id === "string") : [];
  }

  #save() {
    writePrivateFileAtomic(this.jobsFile, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2));
  }

  #find(id) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error("Unknown long-run job.");
    return job;
  }

  #jobDir(job) { return path.join(this.dataDir, job.id); }

  #stateDir(job) { return path.join(job.repo, ".longrun"); }

  #externalPid(job) {
    const raw = (() => { try { return fs.readFileSync(path.join(this.#stateDir(job), "lock"), "utf8"); } catch { return ""; } })();
    const pid = Number(raw);
    const own = this.children.get(job.id)?.pid;
    return Number.isInteger(pid) && pid > 0 && pid !== own && processRunning(pid) ? pid : undefined;
  }

  /** One job as the window shows it: the record plus what the supervisor last wrote. */
  describe(job) {
    const dir = this.#stateDir(job);
    const status = readJson(path.join(dir, "STATUS.json"));
    const state = readJson(path.join(dir, "state.json"));
    const child = this.children.get(job.id);
    const externalPid = child ? undefined : this.#externalPid(job);
    const running = Boolean(child) || externalPid !== undefined;
    const final = status && status.status !== "running" ? status.status : undefined;
    let phase = "idle";
    if (running) phase = "running";
    else if (final) phase = final;
    else if (this.timers.has(job.id)) phase = "restarting";
    else if (job.desired === "running") phase = "waiting";
    return {
      id: job.id,
      title: job.title,
      repo: job.repo,
      effort: job.effort,
      sandbox: job.sandbox,
      verify: job.verify,
      maxHours: job.maxHours,
      createdAt: job.createdAt,
      desired: job.desired,
      phase,
      external: externalPid !== undefined,
      stopReason: status?.stopReason ?? state?.stopReason,
      rounds: status?.rounds ?? state?.rounds ?? 0,
      chats: status?.threads ?? state?.threads?.length ?? 0,
      acceptance: status?.lastVerify ? (status.lastVerify.ok ? "passing" : "failing") : "not run",
      jev: status?.jev,
      updatedAt: status?.updatedAt,
      startedAt: state?.startedAt,
      activity: (() => {
        const line = lastLine(path.join(dir, "events.jsonl"));
        if (!line) return undefined;
        try { return String(JSON.parse(line).message ?? "").slice(0, 300); } catch { return undefined; }
      })(),
      error: this.errors.get(job.id),
      hasReport: fs.existsSync(path.join(dir, "REPORT.md")),
    };
  }

  list() {
    return this.jobs.map((job) => this.describe(job));
  }

  create(input) {
    const fields = normalizeInput(input, { existingRepos: this.jobs.map((job) => job.repo) });
    const id = crypto.randomBytes(6).toString("hex");
    const job = {
      id, title: fields.title, repo: fields.repo, verify: fields.verify, effort: fields.effort, sandbox: fields.sandbox,
      maxHours: fields.maxHours, controller: fields.controller, desired: "idle", createdAt: new Date(this.now()).toISOString(),
    };
    fs.mkdirSync(this.#jobDir(job), { recursive: true });
    fs.writeFileSync(path.join(this.#jobDir(job), "task.md"), `${fields.task}\n`);
    this.jobs.push(job);
    this.#save();
    this.onChange();
    return this.describe(job);
  }

  start(id, { restart = false } = {}) {
    const job = this.#find(id);
    if (!this.available()) throw new Error("The long-run supervisor is missing from this installation.");
    if (this.shuttingDown) throw new Error("The launcher is closing.");
    if (this.children.has(id)) return this.describe(job);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (!restart && this.#externalPid(job)) {
      job.desired = "running";
      this.#save();
      return this.describe(job);
    }
    this.errors.delete(id);
    job.desired = "running";
    this.#save();
    this.#spawn(job, { restart });
    this.onChange();
    return this.describe(job);
  }

  #spawn(job, { restart = false } = {}) {
    const dir = this.#jobDir(job);
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, "supervisor.log");
    try { if (fs.statSync(logFile).size > LOG_LIMIT_BYTES) fs.renameSync(logFile, `${logFile}.old`); } catch {}
    const log = fs.openSync(logFile, "a");
    const args = buildArgs(job, {
      scriptPath: this.scriptPath, taskFile: path.join(dir, "task.md"), launcher: this.launcher, restart,
    });
    let child;
    try {
      child = this.spawnProcess(this.executable, args, {
        cwd: job.repo,
        env: { ...process.env, ...this.env },
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(log);
    }
    this.children.set(job.id, child);
    this.logger?.info("longrun.started", { id: job.id, pid: child.pid, repo: job.repo, restart });
    child.once("error", (error) => {
      if (this.children.get(job.id) === child) this.children.delete(job.id);
      this.errors.set(job.id, `Could not start the supervisor: ${error.message}`);
      this.logger?.warn("longrun.spawn_failed", { id: job.id, message: error.message });
      this.onChange();
    });
    child.once("exit", (code, signal) => this.#exited(job, child, code, signal));
  }

  #exited(job, child, code, signal) {
    if (this.children.get(job.id) !== child) return;
    this.children.delete(job.id);
    const stoppedByUs = this.stopping.delete(job.id) || this.shuttingDown;
    const status = readJson(path.join(this.#stateDir(job), "STATUS.json"));
    const finalStatus = status && status.status !== "running" ? status.status : undefined;
    this.logger?.info("longrun.exited", { id: job.id, code, signal, status: finalStatus ?? null });
    if (stoppedByUs) { this.onChange(); return; }
    if (finalStatus) {
      this.onFinished({ ...this.describe(job), phase: finalStatus });
      this.onChange();
      return;
    }
    // The supervisor died without finishing: bring it back, but give up on a crash loop and say why.
    const history = (this.restarts.get(job.id) ?? []).filter((at) => this.now() - at < RESTART_WINDOW_MS);
    history.push(this.now());
    this.restarts.set(job.id, history);
    const detail = lastLine(path.join(this.#jobDir(job), "supervisor.log")) ?? `exit code ${code ?? signal}`;
    if (history.length > MAX_RESTARTS_IN_WINDOW || code === 1) {
      this.errors.set(job.id, detail.slice(0, 400));
      job.desired = "idle";
      this.#save();
      this.onChange();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (!this.shuttingDown && job.desired === "running") {
        try { this.start(job.id); } catch (error) { this.errors.set(job.id, error.message); this.onChange(); }
      }
    }, this.restartDelayMs);
    timer.unref?.();
    this.timers.set(job.id, timer);
    this.onChange();
  }

  stop(id) {
    const job = this.#find(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    job.desired = "idle";
    this.#save();
    const child = this.children.get(id);
    if (child) {
      this.stopping.add(id);
      terminateOwnedProcessTree(child);
    } else {
      const pid = this.#externalPid(job);
      if (pid) terminateOwnedProcessTree({ pid, exitCode: null, signalCode: null, kill: () => true });
    }
    this.onChange();
    return this.describe(job);
  }

  remove(id) {
    const job = this.#find(id);
    if (this.children.has(id) || this.#externalPid(job)) throw new Error("Stop the job before removing it.");
    this.jobs = this.jobs.filter((candidate) => candidate.id !== id);
    this.#save();
    fs.rmSync(this.#jobDir(job), { recursive: true, force: true });
    this.onChange();
  }

  /** Bring back every job that was meant to run and has not finished. Called when the app starts. */
  resumeAll({ staggerMs = 2000 } = {}) {
    let delay = 0;
    for (const job of this.jobs) {
      if (job.desired !== "running") continue;
      const status = readJson(path.join(this.#stateDir(job), "STATUS.json"));
      if (status && status.status !== "running") continue;
      const timer = setTimeout(() => {
        this.timers.delete(job.id);
        try { this.start(job.id); } catch (error) { this.errors.set(job.id, error.message); this.onChange(); }
      }, delay);
      timer.unref?.();
      this.timers.set(job.id, timer);
      delay += staggerMs;
    }
    this.onChange();
  }

  reportPath(id) {
    const job = this.#find(id);
    return path.join(this.#stateDir(job), "REPORT.md");
  }

  folderPath(id) {
    return this.#find(id).repo;
  }

  /** The app is closing: stop the supervisors but keep `desired`, so the next start resumes them. */
  shutdown() {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const child of this.children.values()) {
      try { terminateOwnedProcessTree(child); } catch (error) { this.logger?.warn("longrun.stop_failed", { message: error.message }); }
    }
  }
}

module.exports = { LongrunManager, normalizeInput, buildArgs, EFFORTS, SANDBOXES };
