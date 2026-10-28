import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runLongRun } from "../scripts/longrun/longrun.mjs";
import { buildContinuePrompt, buildHandoffPrompt, decideNext, DEFAULTS, initialState, progressShrank } from "../scripts/longrun/lib.mjs";
import { scenario } from "./fixtures/longrun-harness.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const files = { progress: ".longrun/PROGRESS.md" };

test("a compaction death spiral is cut short and the work moves to a fresh chat", async () => {
  await scenario([{ type: "loop" }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    const started = Date.now();
    const state = await runLongRun(config({ stallMs: 60_000, progressMs: 0 }), deps());
    assert.equal(state.status, "done");
    assert.equal(state.failuresByKind.stuck, 1);
    const [, second] = calls();
    assert.equal(second.resume, false, "a poisoned chat is never resumed");
    assert.ok(second.prompt.includes("taking over a long-running task"));
    assert.ok(second.prompt.includes("do not dump whole files"), "the new chat is warned about the loop");
    assert.equal(state.threads.length, 2);
    assert.ok(Date.now() - started < 20_000);
  });
});

test("a round that stays busy without changing anything is stuck too", async () => {
  await scenario([{ type: "spin" }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config({ stallMs: 60_000, progressMs: 700 }), deps());
    assert.equal(state.status, "done");
    assert.equal(state.failuresByKind.stuck, 1);
    assert.equal(calls()[1].resume, false);
  });
});

test("after a stuck round the forced compaction limit is raised for the next chats", async () => {
  await scenario([{ type: "spin" }, { type: "spin" }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config({ stallMs: 60_000, progressMs: 500, compactLimit: 1000 }), deps());
    assert.equal(state.status, "done");
    const limits = calls().map((c) => c.args.find((a) => String(a).startsWith("model_auto_compact_token_limit=")));
    assert.deepEqual(limits, ["model_auto_compact_token_limit=1000", "model_auto_compact_token_limit=1500", "model_auto_compact_token_limit=2250"]);
  });
});

test("a long round that keeps changing files is left alone", async () => {
  await scenario([{ type: "work", steps: 14, progress: "DONE" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config({ stallMs: 60_000, progressMs: 900 }), deps());
    assert.equal(state.status, "done");
    assert.equal(calls().length, 1);
    assert.equal(state.failuresByKind.stuck, undefined);
  });
});

test("repeated stuck rounds stop with a clear reason instead of looping for hours", async () => {
  await scenario([{ type: "spin" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config({ stallMs: 60_000, progressMs: 500, policy: { maxStuckInARow: 2 } }), deps());
    assert.equal(state.status, "stopped");
    assert.equal(state.stopReason, "stuck_loop");
    assert.equal(calls().length, 3);
    assert.ok(calls().slice(1).every((c) => !c.resume));
  });
});

test("the controller cannot talk the supervisor back into a poisoned chat", async () => {
  await scenario([{ type: "spin" }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(
      config({ stallMs: 60_000, progressMs: 500 }), deps(),
    );
    assert.equal(state.status, "done");
    assert.equal(calls()[1].resume, false);
  }, [
    { say: JSON.stringify({ action: "continue", contextHealth: "ok", reason: "looks fine" }) },
    { say: "BRIEFING: the previous chat looped" },
  ]);
});

test("the chat is recorded as soon as it starts, so a crash resumes it instead of abandoning it", async () => {
  await scenario([{ type: "hang" }, { progress: "DONE" }], async ({ repo, calls, config, deps }) => {
    const stateFile = path.join(repo, ".longrun", "state.json");
    const running = runLongRun(config({ stallMs: 2500, progressMs: 0 }), deps());
    let midRound;
    for (let i = 0; i < 40 && !midRound?.threadId; i += 1) {
      await wait(50);
      try { midRound = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
    }
    assert.equal(midRound.threadId, "thread-1");
    assert.equal(midRound.pending, "continue");
    assert.equal(midRound.status, "running");
    const state = await running;
    assert.equal(state.status, "done");
    assert.equal(calls()[1].threadArg, "thread-1");
  });
});

test("the briefing is kept when the handoff attempt dies before a chat starts", async () => {
  await scenario([
    { type: "fail", message: "stream disconnected before completion" },
    { type: "crash_early", message: "bridge refused the connection" },
    { progress: "DONE" },
  ], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    const [, second, third] = calls();
    assert.ok(second.prompt.includes("BRIEF-TEXT-42"), "the first handoff carries the briefing");
    assert.equal(third.resume, false);
    assert.ok(third.prompt.includes("BRIEF-TEXT-42"), "so does the retry of the handoff");
  }, [
    { say: JSON.stringify({ action: "fresh", contextHealth: "polluted", reason: "confused" }) },
    { say: "BRIEF-TEXT-42" },
    { say: "{}" },
  ]);
});

test("a progress file that lost most of its content is flagged to the next chat, and every round is snapshotted", async () => {
  await scenario([
    { type: "fail", message: "boom", progress: "IN_PROGRESS", notes: "LONGNOTES ".repeat(300) },
    { type: "fail", message: "boom", progress: "IN_PROGRESS", notes: "tiny" },
    { progress: "DONE" },
  ], async ({ repo, calls, config, deps }) => {
    const state = await runLongRun(config({ policy: { sameThreadFailuresBeforeFresh: 1 } }), deps());
    assert.equal(state.status, "done");
    const [, second, third] = calls();
    assert.ok(!second.prompt.includes("EARLIER, LONGER VERSION"), "nothing was lost yet");
    assert.ok(third.prompt.includes("EARLIER, LONGER VERSION") && third.prompt.includes("LONGNOTES"));
    assert.ok(existsSync(path.join(repo, ".longrun", "progress-history")));
    assert.equal(readdirSync(path.join(repo, ".longrun", "progress-history")).length, 3);
  });
});

const BASE = { status: "running", ...initialState({ id: "t", taskHash: "h", now: 0 }) };

test("policy: a stuck round always goes fresh, counts as a failure and stops after the limit", () => {
  const stuck = { outcome: "stuck", failureText: "no change for 40 min", durationMs: 1 };
  const first = decideNext({ state: BASE, round: stuck, progress: {}, now: 1, opts: DEFAULTS });
  assert.equal(first.action, "fresh");
  assert.equal(first.reason, "round_stuck");
  assert.equal(first.state.stuckInARow, 1);
  assert.equal(first.state.consecutiveFailures, 1);
  assert.equal(first.state.failuresByKind.stuck, 1);
  assert.equal(first.state.compactScale, 1.5);
  assert.ok(first.waitMs > 0);
  let state = first.state;
  let last;
  for (let i = 0; i < DEFAULTS.maxStuckInARow; i += 1) last = decideNext({ state, round: stuck, progress: {}, now: 1, opts: DEFAULTS }), state = last.state;
  assert.equal(last.action, "stop");
  assert.equal(last.reason, "stuck_loop");
  const healthy = decideNext({ state: first.state, round: { outcome: "completed" }, verify: { ok: false }, progress: {}, fingerprint: "a", now: 1, opts: DEFAULTS });
  assert.equal(healthy.state.stuckInARow, 0);
});

test("handoff prompt: scaled to a small context window, warns after a stuck round, keeps the briefing", () => {
  const huge = "x".repeat(200_000);
  const full = buildHandoffPrompt({ task: huge, files, progressText: huge, round: 4, reason: "round_stuck", brief: "BRIEF ".repeat(3000), gitLog: "abc one", gitStatus: "" });
  const small = buildHandoffPrompt({ task: huge, files, progressText: huge, round: 4, reason: "round_stuck", brief: "BRIEF ".repeat(3000), gitLog: "abc one", gitStatus: "", budgetChars: 20_000 });
  assert.ok(full.length > 60_000);
  assert.ok(small.length < 20_000, `small prompt was ${small.length} characters`);
  assert.ok(small.includes("BRIEF") && small.includes("abc one") && small.includes("do not dump whole files"));
  assert.ok(small.includes("LONG-RUN PROTOCOL"), "the protocol is never cut");
});

test("progress shrink detection ignores small files and ordinary edits", () => {
  assert.equal(progressShrank("short", "also short"), false);
  assert.equal(progressShrank("a".repeat(900), "a".repeat(2000)), false);
  assert.equal(progressShrank("a".repeat(400), "a".repeat(2000)), true);
  assert.equal(progressShrank("", "a".repeat(2000)), true);
});

test("a failing acceptance command tells the model to reset STATUS", () => {
  const text = buildContinuePrompt({ round: 2, files, verifyCommand: "npm test", verify: { ok: false, tail: "1 failing" }, reason: "verify_failing" });
  assert.ok(text.includes("STATUS: IN_PROGRESS"));
});
