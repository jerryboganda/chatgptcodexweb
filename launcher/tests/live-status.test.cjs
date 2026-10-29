"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  bridgeStatus,
  chatgptStatus,
  createLiveStatus,
  longrunStatus,
  mcpStatus,
  routeStatus,
} = require("../electron/live-status.cjs");

const CONFIG = { host: "127.0.0.1", port: 17841, mode: "full", releaseVersion: "6.1.14" };
const HOOK_BLOCK = [
  "# Managed by codex-chatgpt-web: long-run hooks keep a ChatGPT web task going until its acceptance check passes.",
  "[[hooks.Stop.hooks]]",
  'command = "C:\\\\x\\\\versions\\\\6.1.14-win32-x64\\\\runtime\\\\bun.exe cli.js hook stop"',
  "[[hooks.UserPromptSubmit.hooks]]",
  'command = "C:\\\\x\\\\versions\\\\6.1.14-win32-x64\\\\runtime\\\\bun.exe cli.js hook prompt"',
  "# End codex-chatgpt-web long-run hooks.",
].join("\n");

test("bridge status reflects reachability, draining and active turns", () => {
  assert.equal(bridgeStatus(null, null).tone, "off");
  assert.deepEqual(bridgeStatus(CONFIG, null), { tone: "error", facts: { reason: "unreachable", port: 17841 } });
  assert.equal(bridgeStatus(CONFIG, { accepting_turns: false }).tone, "warn");
  assert.equal(bridgeStatus(CONFIG, { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 }).tone, "ok");
  const busy = bridgeStatus(CONFIG, { accepting_turns: true, active_http_turns: 1, active_browser_turns: 1 });
  assert.equal(busy.tone, "busy");
  assert.deepEqual(busy.facts, { turns: 1, browserTurns: 1, port: 17841 });
});

test("ChatGPT status distinguishes signed-out, working, loading and error", () => {
  assert.equal(chatgptStatus(null).tone, "off");
  assert.deepEqual(chatgptStatus({ status: "signed-out", authenticated: false }), { tone: "warn", facts: { reason: "signed-out" } });
  assert.equal(chatgptStatus({ status: "error", authenticated: true }).tone, "error");
  assert.equal(chatgptStatus({ status: "running", authenticated: true }).tone, "busy");
  assert.equal(chatgptStatus({ status: "ready", authenticated: true }).tone, "ok");
});

test("route status compares the Codex base URL with the bridge", () => {
  const url = "http://127.0.0.1:17841/v1";
  assert.equal(routeStatus(null, url).tone, "off");
  assert.deepEqual(routeStatus('model = "x"\n', url), { tone: "warn", facts: { reason: "not-routed" } });
  assert.equal(routeStatus('openai_base_url = "http://127.0.0.1:9/v1"\n', url).facts.reason, "other-route");
  assert.equal(routeStatus(`openai_base_url = "${url}/"\n`, url).tone, "ok");
});

test("MCP status is a live runtime check and reports the saved connector flag as a fact", () => {
  assert.equal(mcpStatus({ ...CONFIG, mode: "browser-only" }, {}, {}).tone, "off");
  assert.deepEqual(mcpStatus(CONFIG, null, {}), { tone: "error", facts: { reason: "runtime-down" } });
  assert.deepEqual(mcpStatus(CONFIG, { status: "ok" }, {}), { tone: "ok", facts: { connectorVerified: false } });
  assert.deepEqual(mcpStatus(CONFIG, { status: "ok" }, { mcpSetupComplete: true }), { tone: "ok", facts: { connectorVerified: true } });
});

test("long-run status reads the managed block and the last hook decision", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  assert.equal(longrunStatus(null, null, "6.1.14", now).tone, "off");
  assert.equal(longrunStatus("model = 1\n", null, "6.1.14", now).facts.reason, "not-installed");
  assert.equal(longrunStatus(HOOK_BLOCK.replace("hook stop", "other"), null, "6.1.14", now).facts.reason, "damaged");
  assert.equal(longrunStatus(HOOK_BLOCK, null, "6.2.0", now).facts.reason, "stale");
  assert.deepEqual(longrunStatus(HOOK_BLOCK, null, "6.1.14", now), { tone: "ok", facts: {} });
  const recent = `{"at":"2026-10-29T09:59:30.000Z","event":"acceptance","session":"s"}\n`;
  const busy = longrunStatus(HOOK_BLOCK, `partial line\n${recent}`, "6.1.14", now);
  assert.equal(busy.tone, "busy");
  assert.equal(busy.facts.event, "acceptance");
  const old = `{"at":"2026-10-29T09:00:00.000Z","event":"continue","session":"s"}\n`;
  assert.equal(longrunStatus(HOOK_BLOCK, old, "6.1.14", now).tone, "ok");
  const done = `{"at":"2026-10-29T09:59:50.000Z","event":"accepted","session":"s"}\n`;
  assert.equal(longrunStatus(HOOK_BLOCK, done, "6.1.14", now).tone, "ok");
});

test("collect combines every probe and survives failing probes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-status-"));
  try {
    const codexConfigPath = path.join(dir, "config.toml");
    const hookLogPath = path.join(dir, "hook.log");
    fs.writeFileSync(codexConfigPath, `openai_base_url = "http://127.0.0.1:17841/v1"\n${HOOK_BLOCK}\n`);
    fs.writeFileSync(hookLogPath, `{"at":"2026-10-29T10:00:00.000Z","event":"continue","session":"s"}\n`);
    const live = createLiveStatus({
      readConfig: () => CONFIG,
      fetchHealth: async () => ({ status: "ok", accepting_turns: true, active_http_turns: 1, active_browser_turns: 0 }),
      browserSnapshot: () => ({ status: "ready", authenticated: true }),
      getState: () => ({ mcpSetupComplete: false }),
      codexConfigPath,
      hookLogPath,
      now: () => Date.parse("2026-10-29T10:00:05Z"),
    });
    const status = await live.collect();
    assert.equal(status.checkedAt, Date.parse("2026-10-29T10:00:05Z"));
    assert.deepEqual(status.items.map((item) => [item.id, item.tone]), [
      ["bridge", "busy"], ["chatgpt", "ok"], ["route", "ok"], ["mcp", "ok"], ["longrun", "busy"],
    ]);

    const broken = createLiveStatus({
      readConfig: () => { throw new Error("unreadable"); },
      fetchHealth: async () => { throw new Error("down"); },
      browserSnapshot: () => { throw new Error("no browser"); },
      getState: () => { throw new Error("no state"); },
      codexConfigPath: path.join(dir, "missing.toml"),
      hookLogPath: path.join(dir, "missing.log"),
    });
    const fallback = await broken.collect();
    assert.deepEqual(fallback.items.map((item) => item.tone), ["off", "off", "off", "off", "off"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung health probe is reported as unreachable instead of blocking the status", async () => {
  const live = createLiveStatus({
    readConfig: () => CONFIG,
    fetchHealth: () => new Promise(() => {}),
    browserSnapshot: () => null,
    getState: () => ({}),
    codexConfigPath: path.join(os.tmpdir(), "does-not-exist.toml"),
    hookLogPath: path.join(os.tmpdir(), "does-not-exist.log"),
  });
  const started = Date.now();
  const status = await live.collect();
  assert.ok(Date.now() - started < 6_000);
  assert.equal(status.items[0].tone, "error");
  assert.equal(status.items[3].tone, "error");
});
