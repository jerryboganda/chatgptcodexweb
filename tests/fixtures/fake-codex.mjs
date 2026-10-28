// A scripted stand-in for `codex exec` used by the long-run supervisor tests. Worker invocations take the next
// scenario from FAKE_CODEX_SCRIPT (a JSON array; the last entry repeats). Controller invocations (their prompt
// starts with "[longrun-controller") take scenarios from FAKE_CONTROLLER_SCRIPT. Everything is recorded in FAKE_CODEX_DIR.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_CODEX_DIR;
mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const next = (name) => {
  const file = path.join(dir, name);
  const n = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(n));
  return n;
};

if (prompt.startsWith("[longrun-controller")) {
  const n = next("ccounter");
  writeFileSync(path.join(dir, `controller-${n}.json`), JSON.stringify({ args, prompt, cwd: process.cwd() }));
  const script = process.env.FAKE_CONTROLLER_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_CONTROLLER_SCRIPT, "utf8")) : [{ say: "{}" }];
  const scenario = script[Math.min(n, script.length) - 1];
  if (scenario.type === "hang") await new Promise(() => {});
  if (scenario.type === "fail") { process.stderr.write("controller unavailable"); process.exit(1); }
  const out = args[args.indexOf("-o") + 1];
  if (out && scenario.say !== undefined) writeFileSync(out, scenario.say);
  emit({ type: "thread.started", thread_id: `controller-${n}` });
  emit({ type: "item.completed", item: { type: "agent_message", text: scenario.say ?? "" } });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
}

const n = next("counter");
const resume = args[1] === "resume";
const threadArg = resume ? args[args.length - 2] : undefined;
writeFileSync(path.join(dir, `call-${n}.json`), JSON.stringify({ args, resume, threadArg, prompt, cwd: process.cwd() }));

const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, "utf8"));
const scenario = script[Math.min(n, script.length) - 1];
const threadId = threadArg ?? scenario.thread ?? `thread-${n}`;

for (const [file, content] of Object.entries(scenario.write ?? {})) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, content);
}
if (scenario.progress) {
  mkdirSync(".longrun", { recursive: true });
  writeFileSync(".longrun/PROGRESS.md", `# LONGRUN PROGRESS\n\nSTATUS: ${scenario.progress}\n\n${scenario.notes ?? ""}\n`);
}
if (scenario.append) appendFileSync(scenario.append.file, scenario.append.text);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (scenario.type === "crash_early") { process.stderr.write(scenario.message ?? "bridge refused"); process.exit(3); }

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
if (scenario.type === "hang") await new Promise(() => {});
// A compaction death spiral: the same reconnect/compaction error again and again, nothing ever changes.
if (scenario.type === "loop") for (;;) { emit({ type: "error", message: "Reconnecting... 1/2 (stream disconnected before completion: ChatGPT compaction had no observed activity for 300000ms)" }); await pause(100); }
// Busy but going nowhere: commands keep running, no file is touched.
if (scenario.type === "spin") for (;;) { emit({ type: "item.completed", item: { type: "command_execution", command: "Get-Content src/a.js", exit_code: 0 } }); await pause(100); }
// A slow but healthy round: a new file every 150 ms for `steps` steps, then it finishes.
if (scenario.type === "work") {
  for (let i = 0; i < (scenario.steps ?? 12); i += 1) {
    writeFileSync(`work-${i}.txt`, String(i));
    emit({ type: "item.completed", item: { type: "command_execution", command: `step ${i}`, exit_code: 0 } });
    await pause(150);
  }
}
if (scenario.type === "crash") { process.stderr.write(scenario.message ?? "boom"); process.exit(3); }
if (scenario.type === "fail") {
  for (let i = 1; i <= 2; i += 1) emit({ type: "error", message: `Reconnecting... ${i}/5 (${scenario.message})` });
  emit({ type: "error", message: scenario.message });
  emit({ type: "turn.failed", error: { message: scenario.message } });
  process.exit(1);
}
emit({ type: "item.completed", item: { type: "agent_message", text: scenario.say ?? "ok" } });
emit({ type: "turn.completed", usage: {} });
