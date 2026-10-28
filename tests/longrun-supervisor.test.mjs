import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runLongRun } from "../scripts/longrun/longrun.mjs";
import { git, scenario } from "./fixtures/longrun-harness.mjs";

const VERIFY = "node -e \"process.exit(require('fs').existsSync('done.txt')?0:1)\"";

test("the acceptance command gates completion; work goes to a branch with checkpoint commits", async () => {
  await scenario([
    { write: { "a.txt": "1" }, progress: "IN_PROGRESS" },
    { write: { "done.txt": "yes" }, progress: "DONE" },
  ], async ({ repo, calls, config, deps }) => {
    const state = await runLongRun(config({ verify: VERIFY }), deps());
    assert.equal(state.status, "done");
    assert.equal(state.rounds, 2);
    const [first, second] = calls();
    assert.equal(first.resume, false);
    assert.ok(first.args.includes("-s") && first.args.includes("workspace-write"));
    assert.ok(first.args.includes('model_reasoning_effort="high"'));
    assert.ok(first.prompt.includes("Build the thing") && first.prompt.includes("LONG-RUN PROTOCOL"));
    assert.equal(second.resume, true);
    assert.equal(second.threadArg, "thread-1");
    assert.ok(second.prompt.includes("Continue the task") && second.prompt.includes("last failed"));
    assert.match(git(repo, "branch", "--show-current"), /^longrun\//);
    assert.match(git(repo, "log", "--format=%s"), /longrun: checkpoint before round 2/);
    assert.ok(existsSync(path.join(repo, ".longrun", "REPORT.md")));
    assert.ok(!git(repo, "status", "--porcelain").includes(".longrun"));
  });
});

test("a model that says it is finished while the acceptance command fails is sent back to work", async () => {
  await scenario([
    { progress: "DONE" },
    { progress: "DONE", write: { "done.txt": "yes" } },
  ], async ({ calls, config, deps }) => {
    const state = await runLongRun(config({ verify: VERIFY }), deps());
    assert.equal(state.status, "done");
    assert.equal(calls().length, 2);
  });
});

test("transient failures are retried in the same chat with growing waits", async () => {
  await scenario([
    { type: "fail", message: "stream disconnected before completion: ChatGPT stopped responding" },
    { type: "fail", message: "stream disconnected before completion: ChatGPT stopped responding" },
    { progress: "DONE" },
  ], async ({ calls, waits, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    assert.equal(waits.length, 2);
    assert.ok(waits[1] > waits[0]);
    assert.deepEqual(calls().map((c) => c.threadArg), [undefined, "thread-1", "thread-1"]);
    assert.equal(state.consecutiveFailures, 0);
  });
});

test("a round that goes silent is killed and resumed", async () => {
  await scenario([{ type: "hang" }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    const started = Date.now();
    const state = await runLongRun(config({ stallMs: 600 }), deps());
    assert.equal(state.status, "done");
    assert.equal(state.failuresByKind.transient, 1);
    assert.equal(calls()[1].resume, true);
    assert.ok(Date.now() - started < 20_000);
  });
});

test("after repeated failures the work moves to a fresh chat that is handed the progress and history", async () => {
  await scenario([
    { progress: "IN_PROGRESS", notes: "NEXT: finish csv.js", write: { "src.txt": "x" } },
    { type: "fail", message: "stream disconnected" },
    { type: "fail", message: "stream disconnected" },
    { type: "fail", message: "stream disconnected" },
    { progress: "DONE", notes: "all done" },
  ], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    const all = calls();
    assert.equal(all.length, 5);
    const handoff = all[4];
    assert.equal(handoff.resume, false);
    assert.ok(handoff.prompt.includes("taking over a long-running task"));
    assert.ok(handoff.prompt.includes("NEXT: finish csv.js"));
    assert.ok(handoff.prompt.includes("checkpoint before round 2"));
    assert.equal(state.threads.length, 2);
  });
});

test("a full context window goes straight to a fresh chat", async () => {
  await scenario([
    { type: "fail", message: "Codex ran out of room in the model's context window." },
    { progress: "DONE" },
  ], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    assert.equal(calls()[1].resume, false);
    assert.ok(calls()[1].prompt.includes("taking over"));
  });
});

test("a usage limit waits for the stated time without burning the failure budget", async () => {
  await scenario([
    { type: "fail", message: "You've reached the usage limit. Try again in 2 hours." },
    { progress: "DONE" },
  ], async ({ waits, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    assert.deepEqual(waits, [2 * 3_600_000]);
    assert.equal(state.consecutiveFailures, 0);
  });
});

test("login problems are waited out a few times, then the run stops with a clear reason", async () => {
  await scenario([{ type: "fail", message: "ChatGPT requested sign-in" }], async ({ calls, waits, config, deps }) => {
    const state = await runLongRun(config({ policy: { maxAuthWaits: 2 } }), deps());
    assert.equal(state.status, "stopped");
    assert.equal(state.stopReason, "needs_login");
    assert.equal(calls().length, 3);
    assert.equal(waits.length, 2);
  });
});

test("a configuration error stops at once", async () => {
  await scenario([{ type: "fail", message: "unknown model chatgpt-web/nope" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.stopReason, "fatal_error");
    assert.equal(calls().length, 1);
  });
});

test("rounds that change nothing get a fresh chat and finally stop instead of burning hours", async () => {
  await scenario([{ progress: "IN_PROGRESS" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config({ policy: { noProgressRoundsBeforeFresh: 2, noProgressRoundsBeforeStop: 4 } }), deps());
    assert.equal(state.stopReason, "no_progress");
    assert.ok(calls().some((c, i) => i > 0 && !c.resume), "a fresh chat was tried");
    assert.equal(calls().length, 5);
  });
});

test("a supervisor that dies mid-run resumes from its saved state and finishes", async () => {
  await scenario([{ progress: "IN_PROGRESS", write: { "a.txt": "1" } }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    await assert.rejects(
      runLongRun(config(), deps({ afterRound: async () => { throw new Error("power cut"); } })),
      /power cut/,
    );
    const second = await runLongRun(config(), deps());
    assert.equal(second.status, "done");
    assert.equal(calls().length, 2);
    assert.equal(calls()[1].threadArg, "thread-1");
  });
});

test("a finished run is not started again", async () => {
  await scenario([{ progress: "DONE" }], async ({ calls, config, deps }) => {
    await runLongRun(config(), deps());
    const again = await runLongRun(config(), deps());
    assert.equal(again.status, "done");
    assert.equal(calls().length, 1);
  });
});

test("uncommitted work is protected, and two supervisors cannot share one state directory", async () => {
  await scenario([{ progress: "DONE" }], async ({ repo, config, deps }) => {
    writeFileSync(path.join(repo, "wip.txt"), "unsaved");
    await assert.rejects(runLongRun(config(), deps()), /uncommitted changes/);
    rmSync(path.join(repo, "wip.txt"));
    const stateDir = path.join(repo, ".longrun");
    writeFileSync(path.join(stateDir, "lock"), String(process.ppid));
    await assert.rejects(runLongRun(config(), deps()), /Another long-run supervisor/);
    rmSync(path.join(stateDir, "lock"));
    assert.equal((await runLongRun(config(), deps())).status, "done");
  });
});

test("changing the task refuses to reuse old state", async () => {
  await scenario([{ progress: "IN_PROGRESS" }], async ({ config, deps }) => {
    await runLongRun(config({ policy: { maxRounds: 1 } }), deps());
    await assert.rejects(runLongRun(config({ taskText: "A different task", restart: false }), deps()), /task changed/);
  });
});
