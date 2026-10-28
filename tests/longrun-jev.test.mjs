import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JevError, classifyVerdict, createJevClient, decideQuestions, decideVerdict, jevState, redact, settleDecide, settleWatch, watchVerdict } from "../scripts/longrun/jev.mjs";
import { SEALERS, applyKeyInput, clearKey, collapseRepeats, loadKey, saveKey, validateKey } from "../scripts/longrun/jev-key.mjs";
import { runLongRun } from "../scripts/longrun/longrun.mjs";
import { scenario } from "./fixtures/longrun-harness.mjs";

// ---- answer builders (the shapes the API documents) ----------------------------------------------

const choice = (labels, label, p) => {
  const rest = (1 - p) / (labels.length - 1);
  return {
    type: "choice", choice: label, probabilities: Object.fromEntries(labels.map((l) => [l, l === label ? p : rest])),
    confidence: (p - 1 / labels.length) / (1 - 1 / labels.length),
  };
};
const score = (level, confidence = 0.95) => ({ type: "score", score: level, confidence, legend: { 0: "ok", 1: "degraded", 2: "polluted" }, probabilities: {} });
const decideAnswers = (action, p, level = 0, healthConfidence = 0.95) => ({ action: choice(["continue", "fresh", "stop"], action, p), health: score(level, healthConfidence) });
const watchAnswers = (action, p) => ({ action: choice(["wait", "fresh", "restart"], action, p) });
const classifyAnswers = (label, p) => ({ kind: choice(["transient", "rate_limit", "auth", "context", "other"], label, p) });

/** A fake Jev client. `route(kind, n)` returns the answers (or throws) for the n-th call of that kind of question. */
function fakeJev(route) {
  const calls = [];
  const seen = { decide: 0, watch: 0, classify: 0 };
  return {
    calls,
    byKind: (kind) => calls.filter((c) => c.kind === kind),
    async systemOne(request) {
      const kind = request.questions.health ? "decide" : request.questions.kind ? "classify" : "watch";
      calls.push({ ...request, kind });
      seen[kind] += 1;
      return route(kind, seen[kind]);
    },
  };
}

const luna = (over) => ({ say: JSON.stringify({ action: "continue", waitSeconds: 0, contextHealth: "ok", reason: "fine", nextHint: "", ...over }) });
const events = (repo) => readFileSync(path.join(repo, ".longrun", "events.jsonl"), "utf8");
const IN_PROGRESS = (n) => ({ progress: "IN_PROGRESS", write: { [`f${n}.txt`]: String(n) } });

// ---- pure rules ------------------------------------------------------------------------------------

test("redact masks credential-looking text and the exact key, and jevState caps the size", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnop1234", "key sk-abcdefghijklmnopqrstuv", "gh ghp_abcdefghijklmnopqrstuvwx", "aws AKIAABCDEFGHIJKLMNOP",
    "password=hunter2hunter2", "TYPESAFE=tsk_live_exact_value_123", "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "max_tokens: 5000 and 12 tests passed",
  ].join("\n");
  const out = redact(text, ["tsk_live_exact_value_123"]);
  for (const leaked of ["abcdefghijklmnop1234", "sk-abcdefghijklmnopqrstuv", "ghp_abcdefghijklmnopqrstuvwx", "AKIAABCDEFGHIJKLMNOP", "hunter2hunter2", "tsk_live_exact_value_123", "MIIabc"]) {
    assert.ok(!out.includes(leaked), `${leaked} must be masked`);
  }
  assert.ok(out.includes("max_tokens: 5000 and 12 tests passed"), "ordinary text is untouched");
  assert.ok(jevState("x".repeat(200_000), [], 1000).length <= 1100);
});

test("a confident answer that agrees with the policy stands; everything else goes to the Codex model", () => {
  const v = (over) => ({ action: "continue", actionConfidence: 0.8, health: "ok", healthConfidence: 0.9, ...over });
  assert.equal(settleDecide(v(), "continue").final, true);
  assert.equal(settleDecide(v({ actionConfidence: 0.5 }), "continue").final, false, "not confident");
  assert.equal(settleDecide(v({ action: "fresh", actionConfidence: 0.7 }), "continue").final, false, "a fresh chat over a healthy default needs high confidence");
  assert.equal(settleDecide(v({ action: "fresh", actionConfidence: 0.9 }), "continue").advice.action, "fresh");
  assert.equal(settleDecide(v({ action: "continue", actionConfidence: 0.99 }), "fresh").final, false, "the policy's fresh chat is never turned back by Jev alone");
  assert.equal(settleDecide(v({ action: "fresh", actionConfidence: 0.7 }), "fresh").final, true);
  assert.equal(settleDecide(v({ action: "stop", actionConfidence: 0.99 }), "continue").final, false, "a stop is always arbitrated");
  assert.equal(settleDecide(v({ health: "polluted" }), "continue").final, false, "polluted with a continue answer is contradictory");
  const polluted = settleDecide(v({ action: "fresh", actionConfidence: 0.9, health: "polluted" }), "continue");
  assert.equal(polluted.advice.contextHealth, "polluted");
  const unsure = settleDecide(v({ health: "polluted", healthConfidence: 0.5 }), "continue");
  assert.equal(unsure.advice.contextHealth, "degraded", "an unsure 'polluted' is downgraded so it cannot force a fresh chat");
  assert.equal(settleDecide(undefined, "continue").final, false);
});

test("waiting needs confidence, killing a round needs high confidence", () => {
  const v = (action, confidence) => ({ action, confidence, p: confidence });
  assert.equal(settleWatch(v("wait", 0.7)).final, true);
  assert.equal(settleWatch(v("wait", 0.5)).final, false);
  assert.equal(settleWatch(v("fresh", 0.7)).final, false);
  assert.equal(settleWatch(v("restart", 0.9)).advice.action, "restart");
});

test("answers are read defensively: score levels, derived confidence, unknown labels", () => {
  assert.equal(decideVerdict(decideAnswers("continue", 0.9, 2)).health, "polluted");
  const countingFromOne = { action: choice(["continue", "fresh", "stop"], "continue", 0.9), health: { type: "score", score: 3, confidence: 0.9, legend: { 1: "ok", 2: "degraded", 3: "polluted" } } };
  assert.equal(decideVerdict(countingFromOne).health, "polluted");
  assert.equal(decideVerdict(decideAnswers("continue", 0.9, 1.4)).health, "degraded");
  const noConfidence = { action: { choice: "fresh", probabilities: { continue: 0.1, fresh: 0.85, stop: 0.05 } } };
  assert.ok(Math.abs(decideVerdict(noConfidence).actionConfidence - 0.775) < 1e-9);
  assert.equal(decideVerdict({ action: { choice: "explode", confidence: 1 } }), undefined);
  assert.equal(decideVerdict({}), undefined);
  assert.equal(watchVerdict({ action: { choice: "restart", confidence: 0.9 } }).action, "restart");
});

test("a failure is only reclassified to a recoverable kind and only on high confidence, never to fatal", () => {
  assert.equal(classifyVerdict(classifyAnswers("rate_limit", 0.97)).kind, "rate_limit");
  assert.equal(classifyVerdict(classifyAnswers("auth", 0.97)).kind, "auth");
  assert.equal(classifyVerdict(classifyAnswers("context", 0.97)).kind, "context");
  assert.equal(classifyVerdict(classifyAnswers("rate_limit", 0.5)).kind, undefined);
  assert.equal(classifyVerdict(classifyAnswers("transient", 0.99)).kind, undefined);
  assert.equal(classifyVerdict(classifyAnswers("other", 0.99)).kind, undefined);
  assert.equal(Object.keys(decideQuestions()).join(), "action,health");
});

// ---- HTTP client against a local server ------------------------------------------------------------

async function withServer(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { requests.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, requests.length); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run({ url: `http://127.0.0.1:${server.address().port}`, requests }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };

test("the client posts state and questions with a bearer key and returns the answers", async () => {
  await withServer((req, res) => json(res, 200, { answers: { passed: { type: "noul", noul: 0.97 } } }), async ({ url, requests }) => {
    const client = createJevClient({ apiKey: "tsk-secret-key-1234567890", baseUrl: `${url}/`, retries: 0 });
    const answers = await client.systemOne({ state: "all green", questions: { passed: { type: "noul", instructions: "Did it pass?" } } });
    assert.equal(answers.passed.noul, 0.97);
    const [request] = requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer tsk-secret-key-1234567890");
    assert.deepEqual(JSON.parse(request.body), { state: "all green", questions: { passed: { type: "noul", instructions: "Did it pass?" } }, model: "jev-latest" });
  });
});

test("the client retries 5xx and 429, honours Retry-After, and gives up on 401 without leaking the key", async () => {
  const key = "tsk-secret-key-1234567890";
  await withServer((req, res, n) => (n === 1 ? json(res, 503, { error: "busy" }) : n === 2 ? json(res, 429, {}, { "retry-after": "0" }) : json(res, 200, { answers: { ok: { type: "noul", noul: 1 } } })), async ({ url, requests }) => {
    const slept = [];
    const client = createJevClient({ apiKey: key, baseUrl: url, retries: 2, sleep: async (ms) => { slept.push(ms); } });
    assert.equal((await client.systemOne({ state: "s", questions: {} })).ok.noul, 1);
    assert.equal(requests.length, 3);
    assert.equal(slept[0], 400);
    assert.equal(slept[1], 0, "Retry-After wins over the back-off");
  });
  await withServer((req, res) => json(res, 401, { error: `invalid key ${key}` }), async ({ url, requests }) => {
    const client = createJevClient({ apiKey: key, baseUrl: url, retries: 2, sleep: async () => {} });
    const error = await client.systemOne({ state: "s", questions: {} }).catch((e) => e);
    assert.ok(error instanceof JevError);
    assert.equal(error.status, 401);
    assert.equal(requests.length, 1, "a rejected key is not retried");
    assert.ok(!error.message.includes(key), "the key is scrubbed from the error");
  });
});

test("a server that never answers times out instead of hanging the supervisor", async () => {
  await withServer(() => {}, async ({ url }) => {
    const client = createJevClient({ apiKey: "tsk-secret-key-1234567890", baseUrl: url, retries: 0, timeoutMs: 150 });
    const error = await client.systemOne({ state: "s", questions: {} }).catch((e) => e);
    assert.ok(error instanceof JevError && /timed out/.test(error.message), String(error?.message));
  });
});

// ---- key storage -----------------------------------------------------------------------------------

test("keys are validated before they are stored", () => {
  assert.equal(validateKey("  tsk-abcdefghijklmnop  ").key, "tsk-abcdefghijklmnop");
  for (const bad of ["", "short", "has space inside the key value", "ключ-abcdefghijklmnop", "x".repeat(600)]) assert.equal(validateKey(bad).ok, false, bad);
});

test("a stored key round-trips, is not kept in plain text, and the environment overrides it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-key-test-"));
  try {
    const file = path.join(dir, "key.json");
    const key = "tsk-test-key-0123456789abcdef";
    const scheme = process.platform === "win32" ? "dpapi-user" : "plain-0600";
    assert.equal(saveKey(key, { file }).scheme, scheme);
    const raw = readFileSync(file, "utf8");
    if (process.platform === "win32") assert.ok(!raw.includes(key), "the file holds a DPAPI blob, not the key");
    const loaded = loadKey({ env: {}, file });
    assert.equal(loaded.key, key);
    assert.equal(loaded.source, "stored");
    assert.equal(loadKey({ env: { TYPESAFE_API_KEY: "tsk-from-the-environment-1" }, file }).source, "env");
    assert.equal(clearKey({ file }), true);
    assert.equal(loadKey({ env: {}, file }).source, "none");
    assert.equal(clearKey({ file }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hidden prompt takes pasted text, backspace, clear and Enter, and ignores terminal escape sequences", () => {
  const key = "apikey_0123456789abcdef_0123456789abcdef";
  assert.deepEqual(applyKeyInput("", `\u001b[200~${key}\u001b[201~`), { value: key });
  assert.deepEqual(applyKeyInput("ab", "c\u007f\u007fx"), { value: "ax" });
  assert.deepEqual(applyKeyInput("abc", "\u001b[A\u001b[D"), { value: "abc" }, "arrow keys add nothing");
  assert.deepEqual(applyKeyInput("abc", "\u0015"), { value: "" }, "Ctrl+U clears");
  assert.deepEqual(applyKeyInput("", `${key}\r`), { value: key, done: true });
  assert.equal(applyKeyInput("abc", "\u0003").cancelled, true);
});

test("a key pasted several times in a row is used once", () => {
  const key = "apikey_0123456789abcdef_0123456789abcdef0123456789abcdef";
  assert.deepEqual(collapseRepeats(key.repeat(18)), { value: key, copies: 18 });
  assert.deepEqual(collapseRepeats(key), { value: key, copies: 1 });
  assert.deepEqual(collapseRepeats(`${key}x`), { value: `${key}x`, copies: 1 }, "different text is left alone");
});

test("an unreadable stored key is reported, not thrown", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-key-test-"));
  try {
    const file = path.join(dir, "key.json");
    saveKey("tsk-test-key-0123456789abcdef", { file, scheme: "plain-0600" });
    writeFileSync(file, "{ not json");
    assert.equal(loadKey({ env: {}, file }).source, "unreadable");
    assert.ok(SEALERS["plain-0600"] && SEALERS["dpapi-user"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the supervisor with Jev in front of the Codex model -------------------------------------------

test("auto: a confident Jev answer that agrees with the policy decides alone and the Codex model is never asked", async () => {
  const jev = fakeJev(() => decideAnswers("continue", 0.95));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ repo, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(controllerCalls().length, 0);
    assert.equal(jev.calls.length, 1);
    const [call] = jev.calls;
    assert.ok(call.state.includes("Build the thing") && call.state.includes("The supervisor's own proposal: action=continue"));
    assert.deepEqual(Object.keys(call.questions), ["action", "health"]);
    assert.equal(state.jevAccepted, 1);
    assert.match(readFileSync(path.join(repo, ".longrun", "REPORT.md"), "utf8"), /Jev calls: 1 \(answered alone: 1, sent on to the Codex model: 0/);
    assert.ok(existsSync(path.join(repo, ".longrun", "jev-0001-decide.json")));
  }, [luna({})]);
});

test("auto: an unsure Jev answer is sent on to the Codex model, and the two are compared", async () => {
  const jev = fakeJev(() => decideAnswers("continue", 0.5));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(controllerCalls().length, 1);
    assert.equal(state.jevEscalated, 1);
    assert.equal(state.jevAgree, 1);
  }, [luna({})]);
});

test("auto: a confident 'fresh' moves to a new chat, and the Codex model only writes the briefing", async () => {
  const jev = fakeJev(() => decideAnswers("fresh", 0.97));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ calls, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(calls()[1].resume, false);
    assert.ok(calls()[1].prompt.includes("BRIEF-J"));
    const controller = controllerCalls();
    assert.equal(controller.length, 1);
    assert.ok(controller[0].prompt.startsWith("[longrun-controller:brief]"));
  }, [{ say: "BRIEF-J" }]);
});

test("auto: Jev cannot turn the policy's fresh chat back into a continue; the Codex model arbitrates that one", async () => {
  const jev = fakeJev((kind) => (kind === "classify" ? classifyAnswers("other", 0.9) : decideAnswers("continue", 0.95)));
  await scenario([
    IN_PROGRESS(1), { type: "fail", message: "stream disconnected" }, { type: "fail", message: "stream disconnected" },
    { type: "fail", message: "stream disconnected" }, { progress: "DONE" },
  ], async ({ calls, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(jev.byKind("decide").length, 4);
    assert.equal(controllerCalls().length, 1, "only the disagreement with the policy reached the Codex model");
    assert.equal(state.jevAccepted, 3);
    assert.equal(state.jevEscalated, 1);
    assert.ok(calls().slice(1).every((c) => c.resume && c.threadArg === "thread-1"), "the Codex model kept the chat");
    assert.equal(state.threads.length, 1);
  }, [luna({ reason: "transient network problem, the chat is fine" })]);
});

test("shadow: both are asked, the Codex model acts, and a disagreement is counted", async () => {
  const jev = fakeJev(() => decideAnswers("fresh", 0.97));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ repo, calls, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "shadow", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(calls()[1].resume, true, "the Codex model said continue, so Jev's fresh did nothing");
    assert.equal(controllerCalls().length, 1);
    assert.equal(state.jevDisagree, 1);
    assert.match(events(repo), /Jev and gpt-6-luna disagree on decide/);
  }, [luna({})]);
});

test("jev: an unsure answer leaves the decision to the policy without calling the Codex model", async () => {
  const jev = fakeJev(() => decideAnswers("fresh", 0.5));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ calls, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "jev", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(controllerCalls().length, 0);
    assert.equal(calls()[1].resume, true);
  }, [luna({ action: "fresh" })]);
});

test("luna: Jev is never called, even when a client is supplied", async () => {
  const jev = fakeJev(() => decideAnswers("continue", 0.95));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ controllerCalls, config, deps }) => {
    await runLongRun(config({ controllerMode: "luna", jevClient: jev }), deps());
    assert.equal(jev.calls.length, 0);
    assert.equal(controllerCalls().length, 1);
  }, [luna({})]);
});

test("a failing Jev falls back to the Codex model, and three failures in a row switch it off for the run", async () => {
  const jev = fakeJev(() => { throw new JevError("HTTP 503: busy", { status: 503, retryable: true }); });
  await scenario([IN_PROGRESS(1), IN_PROGRESS(2), IN_PROGRESS(3), IN_PROGRESS(4), { progress: "DONE" }], async ({ repo, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(jev.calls.length, 3, "no fourth attempt once the breaker tripped");
    assert.equal(controllerCalls().length, 4, "the Codex model answered every time");
    assert.equal(state.jevFailures, 3);
    assert.match(events(repo), /Jev is off for the rest of this run: 3 failures in a row/);
  }, [luna({})]);
});

test("a rejected key switches Jev off at once", async () => {
  const jev = fakeJev(() => { throw new JevError("HTTP 401: invalid key", { status: 401 }); });
  await scenario([IN_PROGRESS(1), IN_PROGRESS(2), { progress: "DONE" }], async ({ repo, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(jev.calls.length, 1);
    assert.equal(controllerCalls().length, 2);
    assert.match(events(repo), /the API rejected the key \(HTTP 401\)/);
  }, [luna({})]);
});

test("Jev judges a running round: a confident 'fresh' ends a looping chat, with no Codex model call except the briefing", async () => {
  const jev = fakeJev((kind) => (kind === "watch" ? watchAnswers("fresh", 0.97) : kind === "decide" ? decideAnswers("fresh", 0.95) : classifyAnswers("other", 0.9)));
  await scenario([{ type: "spin" }, { progress: "DONE" }], async ({ repo, calls, controllerCalls, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev, stallMs: 60_000, progressMs: 120_000, watchMs: 500 }), deps());
    assert.equal(state.status, "done");
    assert.equal(state.failuresByKind.stuck, 1);
    assert.equal(calls()[1].resume, false);
    assert.ok(jev.byKind("watch")[0].state.includes("Get-Content src/a.js"), "Jev sees the repeated command");
    assert.deepEqual(controllerCalls().map((c) => c.prompt.split("\n")[0]), ["[longrun-controller:brief]"]);
    assert.match(events(repo), /Jev watch stands: Jev: fresh/);
  }, [{ say: "BRIEF-W" }]);
});

test("a failure text the rules cannot place is read by Jev; a rate limit is waited out like any other", async () => {
  const jev = fakeJev((kind) => (kind === "classify" ? classifyAnswers("rate_limit", 0.97) : decideAnswers("continue", 0.95)));
  await scenario([{ type: "fail", message: "Your account is paused for heavy use until the cooldown ends" }, { progress: "DONE" }], async ({ waits, config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.status, "done");
    assert.equal(state.failuresByKind.rate_limit, 1);
    assert.equal(state.failuresByKind.transient, undefined);
    assert.ok(waits.includes(15 * 60_000));
    assert.equal(jev.byKind("classify").length, 1);
  }, [luna({})]);
});

test("an unsure or 'other' classification leaves the failure transient", async () => {
  const jev = fakeJev((kind) => (kind === "classify" ? classifyAnswers("rate_limit", 0.4) : decideAnswers("continue", 0.95)));
  await scenario([{ type: "fail", message: "Your account is paused for heavy use until the cooldown ends" }, { progress: "DONE" }], async ({ config, deps }) => {
    const state = await runLongRun(config({ controllerMode: "auto", jevClient: jev }), deps());
    assert.equal(state.failuresByKind.transient, 1);
    assert.equal(state.failuresByKind.rate_limit, undefined);
  }, [luna({})]);
});

test("nothing credential-looking is sent to Jev", async () => {
  const jev = fakeJev(() => decideAnswers("continue", 0.95));
  await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ config, deps }) => {
    await runLongRun(config({
      controllerMode: "auto", jevClient: jev,
      taskText: "Build it. api_key=sk-abcdefghijklmnopqrstuvwxyz and token: ghp_abcdefghijklmnopqrstuvwxyz0123",
    }), deps());
    const sent = jev.calls.map((c) => c.state).join("\n");
    assert.ok(sent.includes("Build it."));
    assert.ok(!sent.includes("sk-abcdefghijklmnopqrstuvwxyz") && !sent.includes("ghp_abcdefghijklmnopqrstuvwxyz0123"));
  }, [luna({})]);
});

test("end to end through the real client: the key from the environment is used and never written to disk", async () => {
  const key = "tsk-env-key-0123456789abcdef";
  const saved = { key: process.env.TYPESAFE_API_KEY, url: process.env.LONGRUN_JEV_URL };
  await withServer((req, res) => json(res, 200, { answers: decideAnswers("continue", 0.95) }), async ({ url, requests }) => {
    process.env.TYPESAFE_API_KEY = key;
    process.env.LONGRUN_JEV_URL = url;
    try {
      await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ repo, controllerCalls, config, deps }) => {
        const state = await runLongRun(config({ controllerMode: "auto" }), deps());
        assert.equal(state.status, "done");
        assert.equal(controllerCalls().length, 0);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers.authorization, `Bearer ${key}`);
        assert.equal(JSON.parse(requests[0].body).model, "jev-latest");
        const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
        for (const file of walk(path.join(repo, ".longrun"))) assert.ok(!readFileSync(file, "utf8").includes(key), `${file} must not contain the key`);
        assert.match(events(repo), /Jev is on \(auto; key from the environment/);
      }, [luna({})]);
    } finally {
      for (const [name, value] of [["TYPESAFE_API_KEY", saved.key], ["LONGRUN_JEV_URL", saved.url]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});

test("without a key Jev stays off and the Codex model decides alone", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-nokey-"));
  try {
    await scenario([IN_PROGRESS(1), { progress: "DONE" }], async ({ repo, controllerCalls, config, deps }) => {
      const state = await runLongRun(config({ controllerMode: "auto", jevKeyFile: path.join(dir, "missing.json") }), deps());
      assert.equal(state.status, "done");
      assert.equal(controllerCalls().length, 1);
      assert.match(events(repo), /Jev is not set up/);
    }, [luna({})]);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown controller mode is refused up front", async () => {
  await scenario([{ progress: "DONE" }], async ({ config, deps }) => {
    await assert.rejects(runLongRun(config({ controllerMode: "turbo" }), deps()), /Unknown controller mode/);
  });
});
