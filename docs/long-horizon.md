# Long-horizon runs

## The flow: explore, plan, code, commit, push, deploy

Nothing is tested or built on this PC or on the production server. No test suite, no acceptance command, no `npm`,
`bun`, `pnpm`, `yarn`, `pip`, `cargo` or `go` run, no type check, no lint, by Luna or by the worker. Every task goes
through the same flow:

1. **Explore** the code that matters.
2. **Plan** the change as slices of about half an hour each, in `.longrun/PROGRESS.md`.
3. **Code** one slice at a time with the ChatGPT web worker.
4. **Commit everything and push to `main`.**
5. **One light check, by GitHub Actions**: Luna looks at the run once (`gh run list`, `gh run watch`) and reports it. The
   project's workflow deploys to production on push.

If the GitHub Actions run fails, Luna reports the failing job and its link and stops. You read the run online and tell
it what you see; it then looks at that. Nothing loops on a failing check.

## Automatic mode: just use Codex

The bridge keeps Codex's config current with two small hooks. They only do two things:

- A `UserPromptSubmit` hook marks the start of a request and restates the flow to a Luna driver.
- A `Stop` hook looks at a **Luna driver** that ends its turn with uncommitted or unpushed work and sends it back to
  commit, push and report the GitHub Actions run. At most 3 reminders per request. It only reads `git status`; it never
  runs a project command. It also waits while a worker is still running in the folder.

A turn that did not change any file (a question, an explanation) is never touched, and neither is a turn whose last
words are a question to you. Models other than the Luna driver, subagents and projects that switched it off are left
alone. Old `acceptance:` lines in `AGENTS.md`, `.codex/longrun.json` and `.longrun/acceptance` scripts are ignored.

**Limits** (per request; a new message from you starts a new budget): 3 "commit and push" reminders and 20 hours.
Change them in `~/.codex-chatgpt-web/longrun.json` (`maxContinuations`, `maxHours`) or per project in
`.codex/longrun.json`.

**Control it from a terminal** (`codex-chatgpt-web` is the installed runtime command):

```bash
codex-chatgpt-web longrun status     # on/off, whether Codex has the hooks, how this folder is handled
codex-chatgpt-web longrun off        # stop the reminders (removes the hooks)
codex-chatgpt-web longrun on         # turn them back on
```

Other switches: set `CODEX_LONGRUN=off` in the environment, create an empty `.longrun/off` file in a project, or put
`"enabled": false` in `.codex/longrun.json`.

**Trouble inside a turn** is handled by the bridge itself, with no hook involved: when ChatGPT says the model is at
capacity or a usage limit was reached, the bridge keeps the Codex stream alive and retries in a fresh chat once the
time passes (up to 2 hours per turn; `limitWaitMinutes` in the bridge config, `0` turns it off). A failed compaction
falls back to a fresh summary instead of failing, and every compaction carries the original task, the standing
instructions and the last tool actions, whatever the model wrote in its summary.

**Safety.** The hooks fail open: any error means Codex behaves as if they were not installed. They only edit their own
marked block of `config.toml` (a backup of the file from before the first change is kept in
`~/.codex-chatgpt-web/longrun/`), and the block is removed by `longrun off` and by uninstalling the integration.
Decisions are logged without prompts or command output in `~/.codex-chatgpt-web/longrun/hook.log`. Start a new Codex
chat after the first install so Codex loads the hooks.

## Luna drives, Sol works

Pick a **Luna** model (`gpt-6-luna`, High) in Codex and type the task as usual. Luna runs on your **Codex quota** and is
the driver: it keeps `.longrun/PROGRESS.md`, hands the exploration, planning and coding to **one ChatGPT web worker at a
time** (`chatgpt-web/gpt-6-sol` at the effort you chose), reads every result, and at the end commits, pushes to `main` and
reports the GitHub Actions run. A new worker means a new ChatGPT chat, so one long or broken web chat cannot spoil the
task, and Luna's own thread uses Codex's native compaction.

The bridge installs the instructions as a marked block in `~/.codex/AGENTS.md` (only when the route is installed). The
block asks something only of a main-agent Luna; any other model or subagent is told to ignore it. Luna hands a job over
by running `codex-chatgpt-web worker run --brief-file .longrun/brief.md`, a plain command (the block holds its exact
path). It starts `codex exec` on the worker model in a new chat with full access (`danger-full-access`, approvals off).
Only one worker runs per folder: a second `worker run` prints `WORKER BUSY` (stopping a Luna turn does not stop the
worker it started), `worker status` and `worker stop` show or end it, and every report is also saved in
`.longrun/worker-report.md`. Codex's built-in subagent tool is not used: it only starts agents when the user asks for
them by name, so it cannot be relied on.

**A failed attempt never loses the work.** The worker's steps (what it said, changed and ran) are written to
`.longrun/worker-progress.md` as they happen, and after every attempt the work tree is saved as a git checkpoint under
`refs/longrun/` (without touching your branch, index or files; the last 20 are kept; `git diff refs/longrun/<name>`).
The files stay in the folder, and the next attempt is a fresh chat whose brief says what failed, which files already
changed and what the last attempt did, so it continues instead of starting over. `.longrun/` is kept out of commits
through the repository's own `.git/info/exclude`.

**Failures are told apart by cause**, so the wait matches it:

| Cause | What happens |
| --- | --- |
| ChatGPT asks for a tool permission | wait 20 s and retry; does not use up an attempt |
| ChatGPT is at capacity or rate limited | wait 5 min and retry; does not use up an attempt |
| the bridge or browser is not answering | wait 1 min and retry; does not use up an attempt (see `longrun health`) |
| the worker goes silent for 20 minutes | cut off and retried from its saved progress |
| the worker ran out of its hour | retried; Luna is told the slice was too big |
| the worker starts a test, build or package script | stopped at once and retried with a stricter brief |

Up to 3 real attempts per job, plus up to 6 free retries for the first three causes.

Who does what:

- **The worker** explores, plans and writes code in one small slice per job. It has full access, the network included. It
  never runs tests, builds, linters, type checkers or package scripts (a run that starts one is stopped), and it does not
  commit or push. Every brief starts with rules telling it not to build workarounds for what nobody on this PC can
  provide (a credential, an account, a server); it puts a line starting with `BLOCKED:` in its report instead, which
  Luna then clears itself or records as a manual step.
- **Luna** reads the diffs, keeps PROGRESS.md, waits for the worker with long polls and does nothing in between (no file
  checks, no frequent polling), then commits, pushes and reports the GitHub Actions run.
- **Manual steps**: something nobody on the PC can fix (credentials, no git remote or GitHub login, a decision) goes
  under "manual steps" in PROGRESS.md with what you must do; everything else is finished and Luna says so instead of
  retrying it.

```bash
codex-chatgpt-web longrun worker xhigh     # worker effort: medium, high or xhigh (default xhigh)
codex-chatgpt-web longrun driver off       # Luna works alone again; `driver on` switches it back
codex-chatgpt-web longrun status           # shows the driver, the worker and whether the block is installed
codex-chatgpt-web longrun health           # are the runs of the last day alive? per project, and what looks wrong
```

Open a new Codex chat after changing either setting. Whether Luna hands the work over is its own decision, guided by
the block.

`longrun health` reads Codex's own session files and says, per project, whether the Luna driver and the worker are working,
finished or interrupted, and flags a driver that went silent in the middle of a turn (Codex restarted or lost its
connection: open that chat and send "continue") and a worker that outlived its driver.

The worker has no sandbox: on Windows the `workspace-write` sandbox blocked tools that write caches or rename folders elsewhere
(hundreds of `EPERM`, `EACCES` and "Access is denied" errors in worker sessions against a handful in Luna's), so every
worker run uses full access and no approval prompts.

## A silent driver

When the Codex app-server restarts, every active Luna turn dies without an error: the chat shows a spinner and never
answers again. The bridge runs a watchdog (every 2 minutes) that reads Codex's session files, and resumes such a driver
with `codex exec resume <session> -` and a "continue, do not start over" message that points it at `.longrun/PROGRESS.md`,
the worker report and the progress notes. It only does so when it is sure the turn is dead:

- the driver is silent in the middle of a turn for 10 minutes **and** the app-server started after its last event (or it
  has been silent for 90 minutes);
- no worker is running in its folder (a running worker is left to finish first);
- it was not stopped by you (an interrupted turn is never touched) and it was active within the last 6 hours;
- it was not already resumed twice in the last 6 hours, or in the last 15 minutes.

Every decision is written to `hook.log` (`resume_started`, `resume_exit`, `resume_gave_up`). `longrun resume` shows the
verdict for each driver and resumes the dead ones now; `longrun resume <session-id>` sends one chat a "continue" (add
`--message "<text>"` to say something else), which is also how to move a running chat to a new set of instructions.
The resumed turn runs in the background and writes into the same chat; reopen the chat in Codex to see it.

One limit: the Codex desktop app owns every chat that is open in it, and `codex exec resume` is refused for such a chat
("already has an active writer", logged as `resume_blocked_by_app`). The watchdog then cannot help and `longrun health`
still flags the driver; type "continue" into that chat yourself.

## Limits

- It cannot make a model correct. Nothing is tested on this PC, so the only check is the GitHub Actions run after the
  push; read it, and tell Luna what you see if it fails.
- A literal guarantee that a 10 to 20 hour task finishes is not possible. What the flow guarantees is that work is never
  lost to a failed attempt, that causes outside the work (a busy ChatGPT, a permission card, a down bridge) are waited
  out, and that a driver that goes silent is reported as soon as it happens (see "A silent driver" above).
