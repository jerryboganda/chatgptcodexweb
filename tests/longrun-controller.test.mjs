import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runLongRun } from "../scripts/longrun/longrun.mjs";
import { scenario } from "./fixtures/longrun-harness.mjs";

const advice = (over) => ({ say: JSON.stringify({ action: "continue", waitSeconds: 0, contextHealth: "ok", reason: "fine", nextHint: "", ...over }) });

test("the controller moves a confused chat to a fresh one and writes the briefing it receives", async () => {
  await scenario(
    [{ progress: "IN_PROGRESS", write: { "a.txt": "1" }, notes: "NEXT: csv" }, { progress: "DONE" }],
    async ({ repo, calls, controllerCalls, config, deps }) => {
      const state = await runLongRun(config(), deps());
      assert.equal(state.status, "done");
      const [first, second] = calls();
      assert.equal(first.resume, false);
      assert.equal(second.resume, false, "a fresh chat, not a resume");
      assert.ok(second.prompt.includes("BRIEFING FROM THE SUPERVISOR") && second.prompt.includes("BRIEF: csv parser is half done"));
      assert.ok(second.prompt.includes("Supervisor note: Re-check the tokenizer"));
      const [decide, brief] = controllerCalls();
      assert.ok(decide.prompt.startsWith("[longrun-controller:decide]") && decide.prompt.includes("Build the thing"));
      assert.ok(brief.prompt.startsWith("[longrun-controller:brief]") && brief.prompt.includes("NEXT: csv"));
      for (const call of [decide, brief]) {
        assert.ok(call.args.includes("gpt-6-luna") && call.args.includes('model_reasoning_effort="high"') && call.args.includes("read-only"));
        assert.ok(path.relative(repo, call.cwd).startsWith(".."), "controller runs outside the repository");
      }
      assert.equal(controllerCalls().length, 2);
      assert.equal(state.controllerCalls, 2);
    },
    [advice({ action: "fresh", contextHealth: "polluted", reason: "chat mixes tasks", nextHint: "Re-check the tokenizer" }), { say: "BRIEF: csv parser is half done" }],
  );
});

test("the model and effort of the controller are configurable", async () => {
  await scenario([{ progress: "IN_PROGRESS", write: { "a.txt": "1" } }, { progress: "DONE" }], async ({ controllerCalls, config, deps }) => {
    await runLongRun(config({ controllerModel: "gpt-6-terra", controllerEffort: "xhigh" }), deps());
    const [call] = controllerCalls();
    assert.ok(call.args.includes("gpt-6-terra") && call.args.includes('model_reasoning_effort="xhigh"'));
  }, [advice({})]);
});

test("the controller can keep the same chat where the policy would have switched", async () => {
  await scenario([
    { progress: "IN_PROGRESS", write: { "a.txt": "1" } },
    { type: "fail", message: "stream disconnected" },
    { type: "fail", message: "stream disconnected" },
    { type: "fail", message: "stream disconnected" },
    { progress: "DONE" },
  ], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    assert.ok(calls().slice(1).every((c) => c.resume && c.threadArg === "thread-1"));
    assert.equal(state.threads.length, 1);
  }, [advice({ reason: "transient network problem, the chat is fine" })]);
});

test("a context-full failure is always a fresh chat, whatever the controller says", async () => {
  await scenario([
    { type: "fail", message: "Codex ran out of room in the model's context window." },
    { progress: "DONE" },
  ], async ({ calls, config, deps }) => {
    await runLongRun(config(), deps());
    assert.equal(calls()[1].resume, false);
  }, [advice({ action: "continue" }), { say: "BRIEF" }]);
});

test("rate-limit and login waits stay in the policy's hands", async () => {
  await scenario([
    { type: "fail", message: "You've reached the usage limit. Try again in 2 hours." },
    { progress: "DONE" },
  ], async ({ calls, waits, controllerCalls, config, deps }) => {
    await runLongRun(config(), deps());
    assert.deepEqual(waits, [2 * 3_600_000]);
    assert.equal(calls()[1].resume, true);
    assert.equal(controllerCalls().length, 0, "not even consulted");
  }, [advice({ action: "fresh" })]);
});

test("unusable controller answers fall back to the built-in policy", async () => {
  for (const script of [[{ say: "I think we should rest." }], [{ type: "fail" }], [{ type: "hang" }]]) {
    await scenario([{ progress: "IN_PROGRESS", write: { "a.txt": "1" } }, { progress: "DONE" }], async ({ calls, config, deps }) => {
      const state = await runLongRun(config({ controllerTimeoutMs: 700 }), deps());
      assert.equal(state.status, "done");
      assert.equal(calls().length, 2);
      assert.equal(calls()[1].resume, true);
      assert.ok(state.controllerFailures >= 1, JSON.stringify(script));
    }, script);
  }
});

test("a stop recommendation only counts after repeated failures", async () => {
  await scenario([{ type: "fail", message: "stream disconnected" }, { progress: "DONE" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.status, "done");
    assert.equal(calls().length, 2, "one failure is not enough to stop");
  }, [advice({ action: "stop", reason: "give up" })]);

  await scenario([{ type: "fail", message: "stream disconnected" }], async ({ calls, config, deps }) => {
    const state = await runLongRun(config(), deps());
    assert.equal(state.stopReason, "controller_stop");
    assert.equal(calls().length, 3);
  }, [advice({}), advice({}), advice({ action: "stop", reason: "same failure three times" })]);
});

test("the controller can be switched off", async () => {
  await scenario([{ progress: "IN_PROGRESS", write: { "a.txt": "1" } }, { progress: "DONE" }], async ({ controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controller: false }), deps());
    assert.equal(state.status, "done");
    assert.equal(controllerCalls().length, 0);
  }, [advice({ action: "fresh" })]);
});
