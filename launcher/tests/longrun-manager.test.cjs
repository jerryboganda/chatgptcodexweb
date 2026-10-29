const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LongrunManager, normalizeInput, buildArgs } = require("../electron/longrun-manager.cjs");

const fakeSupervisor = path.join(__dirname, "fixtures", "fake-longrun.cjs");
const TASK = "Build the thing in three phases and keep every commit message prefixed.";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-longrun-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "project");
  fs.mkdirSync(repo);
  return { root, repo, dataDir: path.join(root, "data") };
}

function manager(t, { env = {}, restartDelayMs = 50, ...extra } = {}) {
  const space = workspace(t);
  const events = { changes: 0, finished: [] };
  const instance = new LongrunManager({
    dataDir: space.dataDir,
    scriptPath: fakeSupervisor,
    executable: process.execPath,
    env,
    launcher: "C:/app/Codex Web GPT.exe",
    restartDelayMs,
    onChange: () => { events.changes += 1; },
    onFinished: (job) => events.finished.push(job),
    ...extra,
  });
  t.after(() => instance.shutdown());
  return { ...space, instance, events };
}

function until(predicate, label, timeoutMs = 15_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try { value = predicate(); } catch { value = false; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      return setTimeout(tick, 25);
    };
    tick();
  });
}

const input = (repo, over = {}) => ({ repo, task: TASK, verify: "npm test", effort: "high", ...over });

test("the form input is checked before a job is created", (t) => {
  const { repo } = workspace(t);
  assert.throws(() => normalizeInput(input("relative/path")), /Choose the project folder/);
  assert.throws(() => normalizeInput(input(path.join(repo, "missing"))), /does not exist/);
  assert.throws(() => normalizeInput(input(repo, { task: "short" })), /Describe the task/);
  assert.throws(() => normalizeInput(input(repo, { effort: "instant" })), /Effort must be/);
  assert.throws(() => normalizeInput(input(repo, { sandbox: "none" })), /Unknown sandbox/);
  assert.throws(() => normalizeInput(input(repo, { maxHours: 0 })), /Time budget/);
  assert.throws(() => normalizeInput(input(repo), { existingRepos: [repo] }), /already has a long-run job/);
  const ok = normalizeInput(input(repo));
  assert.equal(ok.effort, "high");
  assert.equal(ok.sandbox, "workspace-write");
  assert.equal(ok.maxHours, 24);
  assert.equal(ok.controller, true);
  assert.equal(ok.title, path.basename(repo));
});

test("the supervisor command line carries the job's settings", () => {
  const job = { repo: "C:/p", verify: "npm test", effort: "xhigh", sandbox: "danger-full-access", maxHours: 12, controller: false };
  const args = buildArgs(job, { scriptPath: "S", taskFile: "T", launcher: "L", restart: true });
  assert.deepEqual(args, [
    "S", "--repo", "C:/p", "--task", "T", "--effort", "xhigh", "--sandbox", "danger-full-access", "--max-hours", "12",
    "--verify", "npm test", "--no-controller", "--launcher", "L", "--restart",
  ]);
  const plain = buildArgs({ ...job, verify: "", controller: true, sandbox: "workspace-write" }, { scriptPath: "S", taskFile: "T" });
  assert.ok(!plain.includes("--verify") && !plain.includes("--no-controller") && !plain.includes("--restart") && !plain.includes("--launcher"));
});

test("creating a job stores the task and lists it as not started", (t) => {
  const { instance, repo, dataDir } = manager(t);
  const created = instance.create(input(repo));
  assert.equal(created.phase, "idle");
  assert.equal(fs.readFileSync(path.join(dataDir, created.id, "task.md"), "utf8").trim(), TASK);
  assert.equal(instance.list().length, 1);
  assert.throws(() => instance.create(input(repo)), /already has a long-run job/);
  const reloaded = new LongrunManager({ dataDir, scriptPath: fakeSupervisor, executable: process.execPath });
  assert.equal(reloaded.list()[0].id, created.id);
});

test("a finished supervisor is reported once with its result", async (t) => {
  const { instance, repo, events } = manager(t, { env: { FAKE_MODE: "done" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => events.finished.length === 1, "the finish notice");
  const job = instance.list()[0];
  assert.equal(job.phase, "done");
  assert.equal(job.acceptance, "passing");
  assert.equal(job.rounds, 2);
  assert.equal(job.hasReport, true);
  assert.equal(events.finished[0].phase, "done");
  const logged = JSON.parse(fs.readFileSync(path.join(repo, ".longrun", "argv.log"), "utf8").trim());
  assert.ok(logged.includes("--launcher") && logged.includes("--verify"));
});

test("a stopped supervisor stays stopped and can be resumed with a restart", async (t) => {
  const { instance, repo, events } = manager(t, { env: { FAKE_MODE: "stopped" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => events.finished.length === 1, "the stop notice");
  const job = instance.list()[0];
  assert.equal(job.phase, "stopped");
  assert.equal(job.stopReason, "no_progress");
  instance.start(id, { restart: true });
  await until(() => events.finished.length === 2, "the second run");
  const lines = fs.readFileSync(path.join(repo, ".longrun", "argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(!lines[0].includes("--restart"));
  assert.ok(lines[1].includes("--restart"));
});

test("a supervisor that dies without a result is brought back", async (t) => {
  const { instance, repo, events } = manager(t, { env: { FAKE_MODE: "crash-once" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => events.finished.length === 1, "the restarted run to finish");
  assert.equal(instance.list()[0].phase, "done");
  const runs = fs.readFileSync(path.join(repo, ".longrun", "argv.log"), "utf8").trim().split("\n");
  assert.equal(runs.length, 2);
});

test("an exit with an error is shown, not retried forever", async (t) => {
  const { instance, repo, dataDir } = manager(t, { env: { FAKE_MODE: "error" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => instance.list()[0].error, "the error");
  const job = instance.list()[0];
  assert.match(job.error, /The task changed/);
  assert.equal(job.desired, "idle");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const runs = fs.readFileSync(path.join(repo, ".longrun", "argv.log"), "utf8").trim().split("\n");
  assert.equal(runs.length, 1);
  assert.ok(fs.existsSync(path.join(dataDir, id, "supervisor.log")));
});

test("stopping ends the supervisor, keeps it stopped and does not restart it", async (t) => {
  const { instance, repo } = manager(t, { env: { FAKE_MODE: "hang" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => instance.list()[0].phase === "running" && fs.existsSync(path.join(repo, ".longrun", "lock")), "a running job");
  instance.stop(id);
  await until(() => instance.list()[0].phase === "idle", "the stop");
  assert.equal(instance.list()[0].desired, "idle");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(instance.list()[0].phase, "idle");
  assert.equal(fs.readFileSync(path.join(repo, ".longrun", "argv.log"), "utf8").trim().split("\n").length, 1);
});

test("a supervisor left over from an earlier app session is adopted, not duplicated", (t) => {
  const { instance, repo } = manager(t);
  const { id } = instance.create(input(repo));
  fs.mkdirSync(path.join(repo, ".longrun"), { recursive: true });
  // Another live process (this test runner's parent) holds the lock.
  fs.writeFileSync(path.join(repo, ".longrun", "lock"), String(process.ppid));
  const started = instance.start(id);
  assert.equal(started.phase, "running");
  assert.equal(started.external, true);
  assert.equal(fs.existsSync(path.join(repo, ".longrun", "argv.log")), false);
});

test("resume brings back unfinished jobs and leaves finished and stopped ones alone", async (t) => {
  const { instance, repo, root, events } = manager(t, { env: { FAKE_MODE: "done" } });
  const second = path.join(root, "second");
  const third = path.join(root, "third");
  fs.mkdirSync(second);
  fs.mkdirSync(third);
  const a = instance.create(input(repo));
  const b = instance.create(input(second));
  const c = instance.create(input(third));
  instance.jobs.forEach((job) => { job.desired = "running"; });
  fs.mkdirSync(path.join(second, ".longrun"), { recursive: true });
  fs.writeFileSync(path.join(second, ".longrun", "STATUS.json"), JSON.stringify({ status: "done" }));
  instance.jobs.find((job) => job.id === c.id).desired = "idle";
  instance.resumeAll({ staggerMs: 10 });
  await until(() => events.finished.length === 1, "the resumed job");
  assert.equal(instance.list().find((job) => job.id === a.id).phase, "done");
  assert.equal(fs.existsSync(path.join(second, ".longrun", "argv.log")), false);
  assert.equal(fs.existsSync(path.join(third, ".longrun", "argv.log")), false);
  assert.equal(instance.list().find((job) => job.id === b.id).phase, "done");
});

test("closing the app stops the supervisors but keeps them marked to resume", async (t) => {
  const { instance, repo } = manager(t, { env: { FAKE_MODE: "hang" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => fs.existsSync(path.join(repo, ".longrun", "lock")), "a running job");
  instance.shutdown();
  await until(() => !instance.children.has(id), "the supervisor to exit");
  assert.equal(instance.jobs[0].desired, "running");
  assert.throws(() => instance.start(id), /closing/);
});

test("a job cannot be removed while it runs", async (t) => {
  const { instance, repo, dataDir } = manager(t, { env: { FAKE_MODE: "hang" } });
  const { id } = instance.create(input(repo));
  instance.start(id);
  await until(() => fs.existsSync(path.join(repo, ".longrun", "lock")), "a running job");
  assert.throws(() => instance.remove(id), /Stop the job/);
  instance.stop(id);
  await until(() => !instance.children.has(id), "the stop");
  instance.remove(id);
  assert.equal(instance.list().length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, id)), false);
  assert.ok(fs.existsSync(repo), "the project itself is never touched");
});
