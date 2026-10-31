"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LONGRUN_START = "codex-chatgpt-web: long-run hooks";
const LONGRUN_END = "# End codex-chatgpt-web long-run hooks.";
const ACTIVE_LONGRUN_EVENTS = new Set(["task_started", "remind_ship", "worker_busy", "worker_session"]);
const LONGRUN_ACTIVE_WINDOW_MS = 120_000;
const PROBE_TIMEOUT_MS = 2_500;

function readTail(filePath, maxBytes = 8_192) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* already closed */ }
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function routeStatus(configText, expectedUrl) {
  if (configText === null) return { tone: "off", facts: { reason: "no-codex-config" } };
  const match = /^\s*openai_base_url\s*=\s*"([^"]+)"/m.exec(configText);
  if (!match) return { tone: "warn", facts: { reason: "not-routed" } };
  if (expectedUrl && match[1].replace(/\/+$/, "") !== expectedUrl.replace(/\/+$/, "")) {
    return { tone: "warn", facts: { reason: "other-route" } };
  }
  return { tone: "ok", facts: {} };
}

// Reads the managed long-run block of the Codex config and the last decision from hook.log.
// Only metadata is read: event names and timestamps, never prompts or command output.
function longrunStatus(configText, logTail, version, now) {
  if (configText === null) return { tone: "off", facts: { reason: "no-codex-config" } };
  const start = configText.indexOf(LONGRUN_START);
  const end = configText.indexOf(LONGRUN_END);
  if (start === -1 || end === -1 || end < start) return { tone: "warn", facts: { reason: "not-installed" } };
  const block = configText.slice(start, end);
  if (!block.includes("hook stop") || !block.includes("hook prompt")) {
    return { tone: "warn", facts: { reason: "damaged" } };
  }
  if (version && !block.includes(`${version}-`)) return { tone: "warn", facts: { reason: "stale" } };
  let last = null;
  for (const line of (logTail ?? "").split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.event === "string" && typeof parsed.at === "string") {
        last = { event: parsed.event, at: Date.parse(parsed.at) };
        if (!Number.isFinite(last.at)) last = null;
        break;
      }
    } catch { /* a cut first line of the tail */ }
  }
  const active = last !== null && ACTIVE_LONGRUN_EVENTS.has(last.event) && now - last.at < LONGRUN_ACTIVE_WINDOW_MS;
  return {
    tone: active ? "busy" : "ok",
    facts: last ? { event: last.event, at: last.at } : {},
  };
}

function bridgeStatus(config, health) {
  if (!config) return { tone: "off", facts: { reason: "not-configured" } };
  if (!health) return { tone: "error", facts: { reason: "unreachable", port: config.port } };
  const turns = Number(health.active_http_turns) || 0;
  const browserTurns = Number(health.active_browser_turns) || 0;
  if (health.accepting_turns === false) return { tone: "warn", facts: { reason: "draining", turns, browserTurns } };
  return { tone: turns > 0 || browserTurns > 0 ? "busy" : "ok", facts: { turns, browserTurns, port: config.port } };
}

function chatgptStatus(browser) {
  if (!browser) return { tone: "off", facts: { reason: "not-ready" } };
  if (browser.status === "error") return { tone: "error", facts: { reason: "error" } };
  if (browser.authenticated !== true) return { tone: "warn", facts: { reason: "signed-out" } };
  if (browser.status === "running" || browser.status === "testing") return { tone: "busy", facts: {} };
  if (browser.status === "loading") return { tone: "busy", facts: { reason: "loading" } };
  return { tone: "ok", facts: {} };
}

// Only the live part of MCP is judged here: the local runtime. Whether the ChatGPT connector was
// verified is a saved fact and is reported as one, so a stale flag can never look like a live check.
function mcpStatus(config, health, state) {
  if (!config || config.mode !== "full") return { tone: "off", facts: { reason: "browser-only" } };
  if (!health) return { tone: "error", facts: { reason: "runtime-down" } };
  return {
    tone: "ok",
    facts: { connectorVerified: state?.mcpSetupComplete === true },
  };
}

function createLiveStatus({
  readConfig,
  fetchHealth,
  browserSnapshot,
  getState,
  codexConfigPath,
  hookLogPath,
  releaseVersion,
  now = Date.now,
}) {
  async function probeHealth(config) {
    if (!config) return null;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(fetchHealth(config)).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS); }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function collect() {
    const checkedAt = now();
    let config = null;
    try { config = readConfig(); } catch { config = null; }
    const health = await probeHealth(config);
    const configText = readText(codexConfigPath);
    let browser = null;
    try { browser = browserSnapshot(); } catch { browser = null; }
    let state = null;
    try { state = getState(); } catch { state = null; }
    const routeUrl = config ? `http://${config.host}:${config.port}/v1` : null;
    return {
      checkedAt,
      items: [
        { id: "bridge", ...bridgeStatus(config, health) },
        { id: "chatgpt", ...chatgptStatus(browser) },
        { id: "route", ...routeStatus(configText, routeUrl) },
        { id: "mcp", ...mcpStatus(config, health, state) },
        { id: "longrun", ...longrunStatus(configText, readTail(hookLogPath), releaseVersion ?? config?.releaseVersion, checkedAt) },
      ],
    };
  }

  return { collect };
}

function defaultPaths({ codexHome, coreHome }) {
  return {
    codexConfigPath: path.join(codexHome, "config.toml"),
    hookLogPath: path.join(coreHome, "longrun", "hook.log"),
  };
}

module.exports = {
  bridgeStatus,
  chatgptStatus,
  createLiveStatus,
  defaultPaths,
  longrunStatus,
  mcpStatus,
  routeStatus,
};
