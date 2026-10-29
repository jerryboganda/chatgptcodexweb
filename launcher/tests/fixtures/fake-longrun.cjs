// Stands in for scripts/longrun/longrun.mjs in the manager tests. Mode comes from FAKE_MODE:
//   done          write a finished STATUS.json and exit 0
//   stopped       write a stopped STATUS.json and exit 2
//   crash         exit 3 without writing a status
//   crash-once    exit 3 the first time, then behave like "done"
//   error         print an error and exit 1
//   hang          hold the lock and run until killed
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const repo = flag("--repo");
const stateDir = path.join(repo, ".longrun");
fs.mkdirSync(stateDir, { recursive: true });
fs.appendFileSync(path.join(stateDir, "argv.log"), `${JSON.stringify(argv)}\n`);

const writeStatus = (status, stopReason) => {
  fs.writeFileSync(path.join(stateDir, "STATUS.json"), JSON.stringify({
    status, stopReason, rounds: 2, threads: 1, lastVerify: { ok: status === "done" }, updatedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(stateDir, "REPORT.md"), `# Long-run report\n\n- Status: ${status}\n`);
  fs.writeFileSync(path.join(stateDir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), message: `finished: ${status}` })}\n`);
};

let mode = process.env.FAKE_MODE ?? "done";
if (mode === "crash-once") {
  const marker = path.join(stateDir, "crashed-once");
  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "1"); process.exit(3); }
  mode = "done";
}
if (mode === "crash") process.exit(3);
if (mode === "error") { console.error("longrun: The task changed since this state was created."); process.exit(1); }
fs.writeFileSync(path.join(stateDir, "lock"), String(process.pid));
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const stopped = mode === "stopped";
  writeStatus(stopped ? "stopped" : "done", stopped ? "no_progress" : "done");
  fs.rmSync(path.join(stateDir, "lock"), { force: true });
  process.exit(stopped ? 2 : 0);
}
