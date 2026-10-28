#!/usr/bin/env node
// Stores the TypeSafe (Jev) API key for the long-run supervisor without ever putting it in the repository, a log, a
// command line or a chat. On Windows the key is sealed with DPAPI for the current user (it cannot be decrypted by
// another account or on another machine); elsewhere it is a 0600 file. TYPESAFE_API_KEY in the environment wins.
//
//   node scripts/longrun/jev-key.mjs set       prompt for the key (hidden), check it with one live call, store it
//   node scripts/longrun/jev-key.mjs status    where the key comes from; never prints it
//   node scripts/longrun/jev-key.mjs test      one sample controller decision against the live API, with latency
//   node scripts/longrun/jev-key.mjs clear     delete the stored key
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JevError, createJevClient, decideQuestions, decideVerdict, jevState, settleDecide } from "./jev.mjs";

export const KEY_ENV = "TYPESAFE_API_KEY";
const ENTROPY = "codex-chatgpt-web/jev-api-key/v1";

export const defaultKeyFile = (home = os.homedir()) => path.join(home, ".codex-chatgpt-web", "jev-api-key.json");

// ---------------------------------------------------------------------------------------------
// Sealing. The key goes to PowerShell on stdin (never on a command line, where other processes could read it).
// ---------------------------------------------------------------------------------------------

function powershell(script, input) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  if (result.status !== 0) {
    const why = String(result.stderr ?? "").trim().split(/\r?\n/)[0] || `exit ${result.status}`;
    throw new Error(`the Windows DPAPI helper failed (${why.slice(0, 160)})`);
  }
  return String(result.stdout ?? "").trim();
}

const DPAPI_HEAD = `Add-Type -AssemblyName System.Security; $v = [Console]::In.ReadToEnd().Trim(); $e = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); `;
const DPAPI_PROTECT = `${DPAPI_HEAD}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v), $e, 'CurrentUser'))`;
const DPAPI_UNPROTECT = `${DPAPI_HEAD}[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v), $e, 'CurrentUser'))`;

export const SEALERS = Object.freeze({
  "dpapi-user": { protect: (key) => powershell(DPAPI_PROTECT, key), unprotect: (blob) => powershell(DPAPI_UNPROTECT, blob) },
  "plain-0600": { protect: (key) => key, unprotect: (blob) => blob },
});

export const defaultScheme = () => (process.platform === "win32" ? "dpapi-user" : "plain-0600");

/** A key is a printable ASCII token with no spaces. The vendor's prefix is not assumed. */
export function validateKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return { ok: false, reason: "the key is empty" };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: "the key has spaces or non-ASCII characters (was something else pasted?)" };
  if (key.length < 16 || key.length > 512) return { ok: false, reason: `the key has ${key.length} characters, which does not look like an API key` };
  return { ok: true, key };
}

export function saveKey(key, { file = defaultKeyFile(), scheme = defaultScheme() } = {}) {
  const sealer = SEALERS[scheme];
  if (!sealer) throw new Error(`unknown storage scheme ${scheme}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, scheme, savedAt: new Date().toISOString(), blob: sealer.protect(key) }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform === "win32") {
    // Defence in depth on top of DPAPI: only the current user keeps access to the file. Best effort.
    if (process.env.USERNAME) spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { windowsHide: true, stdio: "ignore" });
  } else {
    try { chmodSync(file, 0o600); } catch {}
  }
  return { file, scheme };
}

/** { key, source: "env" | "stored" | "none" | "unreadable", scheme?, error? }. The environment variable wins over the file. */
export function loadKey({ env = process.env, file = defaultKeyFile() } = {}) {
  const fromEnv = String(env[KEY_ENV] ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (!existsSync(file)) return { source: "none" };
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    const sealer = SEALERS[record.scheme];
    if (!sealer || typeof record.blob !== "string") return { source: "unreadable", error: "unknown file format" };
    const key = sealer.unprotect(record.blob);
    return key ? { key, source: "stored", scheme: record.scheme } : { source: "unreadable", error: "empty key" };
  } catch (error) {
    return { source: "unreadable", error: String(error.message).slice(0, 200) };
  }
}

export function clearKey({ file = defaultKeyFile() } = {}) {
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return existed;
}

// ---------------------------------------------------------------------------------------------
// Hidden prompt. In a terminal nothing is echoed; a pipe (`--stdin`) is read to the end.
// ---------------------------------------------------------------------------------------------

// Terminal escape sequences (arrow keys, the markers some terminals wrap around a paste) are not part of the key.
const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** One step of the hidden prompt: feeds a chunk of terminal input into the typed value. Pure, so it can be tested. */
export function applyKeyInput(value, chunk) {
  let out = value;
  for (const ch of String(chunk).replace(ESCAPE_SEQUENCE, "")) {
    if (ch === "\r" || ch === "\n") return { value: out, done: true };
    if (ch === "\u0003") return { value: out, cancelled: true };
    if (ch === "\u007f" || ch === "\b") out = out.slice(0, -1);
    else if (ch === "\u0015" || ch === "\u001b") out = "";
    else if (ch >= " ") out += ch;
  }
  return { value: out };
}

/** A hidden prompt shows nothing, so a key pasted again and again looks like nothing happened; N copies in a row are the key once. */
export function collapseRepeats(value) {
  const n = value.length;
  for (let size = 16; size <= n / 2; size += 1) {
    if (n % size === 0 && value.slice(0, size).repeat(n / size) === value) return { value: value.slice(0, size), copies: n / size };
  }
  return { value, copies: 1 };
}

export function readHidden(promptText, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      let data = "";
      input.setEncoding("utf8");
      input.on("data", (chunk) => { data += chunk; });
      input.on("end", () => resolve(data.trim()));
      input.on("error", reject);
      return;
    }
    let value = "";
    // The characters are never shown, only how many arrived, so a paste visibly worked.
    const draw = () => output.write(`\r\x1b[K${promptText}${value.length ? `[${value.length} characters]` : ""}`);
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value.trim());
    };
    const onData = (chunk) => {
      const step = applyKeyInput(value, chunk);
      value = step.value;
      if (step.cancelled) return finish(new Error("cancelled"));
      if (step.done) return finish();
      draw();
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    draw();
  });
}

/** Windows only: the key can be copied and read from the clipboard, which is cleared straight after, instead of pasted into a terminal. */
function readClipboard() {
  if (process.platform !== "win32") throw new Error("--clipboard is only available on Windows; type the key at the prompt instead");
  return powershell("Get-Clipboard -Raw");
}

function clearClipboard() {
  try { powershell("Set-Clipboard -Value $null"); } catch {}
}

// ---------------------------------------------------------------------------------------------
// Live checks
// ---------------------------------------------------------------------------------------------

async function pingKey(key) {
  const client = createJevClient({ apiKey: key, retries: 1, timeoutMs: 15_000 });
  const started = Date.now();
  const answers = await client.systemOne({
    state: "The build finished and all 42 tests passed.",
    questions: { passed: { type: "noul", instructions: "Does the state say the tests passed?" } },
  });
  return { ms: Date.now() - started, p: answers?.passed?.noul };
}

const SAMPLE_EVIDENCE = [
  "Original task (start): Build a CSV parser with tests.",
  "Counters: consecutiveFailures=0, sameChatFailures=0, roundsWithoutChange=0, failuresByKind={}.",
  "The supervisor's own proposal: action=continue, reason=not_done.",
  "Last round: completed after 412s.",
  "Last message from the agent:\nAdded the tokenizer and 6 tests, all passing. Next: quoted fields.",
  "Acceptance command (npm test): failing\n3 of 9 tests failed: quoted fields are not handled yet.",
  "Progress file (start):\nSTATUS: IN_PROGRESS\nNEXT: handle quoted fields in parse().",
].join("\n\n");

async function runTest(key) {
  const client = createJevClient({ apiKey: key, retries: 1 });
  const started = Date.now();
  const answers = await client.systemOne({ state: jevState(SAMPLE_EVIDENCE, [key]), questions: decideQuestions() });
  const ms = Date.now() - started;
  const verdict = decideVerdict(answers);
  const settled = settleDecide(verdict, "continue");
  return { ms, verdict, settled };
}

function describeError(error) {
  if (error instanceof JevError) return error.status === 401 || error.status === 403 ? `the API rejected the key (${error.message})` : error.message;
  return error?.message ?? String(error);
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/longrun/jev-key.mjs <set|status|test|clear> [options]

  set [--no-verify] [--force] [--stdin]   hidden prompt (shows only how many characters arrived); checks the key with one live call before storing it
  set --clipboard                         Windows: copy the key, run this, and the clipboard is read and then cleared
  status                                  where the key comes from (never prints it)
  test                                    one sample controller decision against the live API
  clear                                   delete the stored key

The key is stored per user under ${defaultKeyFile()} (sealed with Windows DPAPI).
${KEY_ENV} in the environment overrides the stored key.`;

async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => rest.includes(name);
  if (command === "set") {
    const fromClipboard = flag("--clipboard");
    if (!fromClipboard && !process.stdin.isTTY && !flag("--stdin")) throw new Error("run this in a terminal so the key can be typed hidden, or pipe it with --stdin, or use --clipboard");
    const typed = fromClipboard ? readClipboard() : await readHidden("TypeSafe API key (paste it, then press Enter; nothing is shown): ");
    const { value: single, copies } = collapseRepeats(typed);
    const checked = validateKey(single);
    if (!checked.ok) throw new Error(checked.reason);
    if (fromClipboard) clearClipboard();
    process.stderr.write(copies > 1 ? `Received the same ${checked.key.length}-character key ${copies} times; using it once.\n` : `Received ${checked.key.length} characters.\n`);
    if (!flag("--no-verify")) {
      try {
        const ping = await pingKey(checked.key);
        console.log(`The API accepted the key (${ping.ms} ms).`);
      } catch (error) {
        if (error instanceof JevError && (error.status === 401 || error.status === 403) && !flag("--force")) {
          throw new Error(`${describeError(error)}. Nothing was stored (use --force to store it anyway).`);
        }
        console.warn(`Could not confirm the key (${describeError(error)}); storing it anyway.`);
      }
    }
    const saved = saveKey(checked.key);
    console.log(`Stored (${saved.scheme}) in ${saved.file}`);
    if (process.env[KEY_ENV]) console.warn(`Note: ${KEY_ENV} is set in this environment and overrides the stored key.`);
    return 0;
  }
  if (command === "status") {
    const found = loadKey();
    if (found.source === "env") console.log(`Key: from ${KEY_ENV} in the environment (${found.key.length} characters).`);
    else if (found.source === "stored") console.log(`Key: stored (${found.scheme}) in ${defaultKeyFile()} (${found.key.length} characters).`);
    else if (found.source === "unreadable") console.log(`Key: a file exists but cannot be read (${found.error}). Run "set" again.`);
    else console.log('Key: none. Run "node scripts/longrun/jev-key.mjs set".');
    return found.key ? 0 : 1;
  }
  if (command === "test") {
    const found = loadKey();
    if (!found.key) throw new Error('no key; run "set" first');
    const { ms, verdict, settled } = await runTest(found.key);
    if (!verdict) throw new Error("the API answered, but not in the expected shape");
    console.log(`Jev answered in ${ms} ms.`);
    console.log(`  ${settled.reason}`);
    console.log(`  For this sample (policy proposes continue) the controller would ${settled.final ? "accept Jev's answer" : "ask the Codex model"}.`);
    return 0;
  }
  if (command === "clear") {
    console.log(clearKey() ? "Stored key deleted." : "No stored key.");
    return 0;
  }
  console.log(USAGE);
  return command ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(`jev-key: ${describeError(error)}`);
    process.exit(1);
  }
}
