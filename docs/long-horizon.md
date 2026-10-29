# Long-horizon runs

## Automatic mode: just use Codex

Pick a ChatGPT web model in Codex (the desktop app or the CLI) and work as usual. The bridge keeps Codex's
config current with two small hooks, so a task keeps going until its check passes:

1. You send a request. The app remembers what the project looked like.
2. The model works and stops. If it changed files, the project's **acceptance command** runs.
3. If the command fails, Codex is sent back to work in the same chat with the output, instead of stopping.
   This repeats until the command passes or a limit is hit.
4. If the command passes, the turn ends normally.

A turn that did not change any file (a question, an explanation) is never touched, and neither is a turn whose
last words are a question to you. Models other than `chatgpt-web/*`, subagents and projects that switched it off
are left alone. Nothing needs to be started and nothing is shown to configure.

**Where the acceptance command comes from** (first match wins, nearest folder first):

| Source | Example |
| --- | --- |
| `.codex/longrun.json` | `{ "acceptance": "npm test", "maxContinuations": 20 }` |
| a line in `AGENTS.md` | `acceptance: npm test` |
| the project's test runner | `npm test` (a real test script), `python -m pytest -q`, `cargo test`, `go test ./...`, `dotnet test`, `make test` |

Without any of these the hooks stay quiet, and Codex shows a one-time note on how to add the line.

**Limits** (per request; a new message from you starts a new budget): 40 automatic continuations, 20 hours, the
acceptance command is stopped after 30 minutes, and the loop ends early when the same failure comes back 5 times with
no change to the project. Change them in `~/.codex-chatgpt-web/longrun.json` (`maxContinuations`, `maxHours`,
`sameFailureLimit`, `acceptanceTimeoutMinutes`) or per project.

**Control it from a terminal** (`codex-chatgpt-web` is the installed runtime command):

```bash
codex-chatgpt-web longrun status     # on/off, whether Codex has the hooks, which command checks this folder
codex-chatgpt-web longrun off        # stop continuing on its own (removes the hooks)
codex-chatgpt-web longrun on         # turn it back on
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
the driver: it keeps `.longrun/PROGRESS.md`, hands the coding and review to **one ChatGPT web worker at a time**
(`chatgpt-web/gpt-6-sol` at the effort you chose), checks every result itself, and starts a fresh worker with a short
brief when one fails. A new worker means a new ChatGPT chat, so one long or broken web chat cannot spoil the task, and
Luna's own thread uses Codex's native compaction. The Stop hook above supervises Luna sessions too, so the task ends
when the acceptance command passes, not when Luna says so.

The bridge installs the instructions as a marked block in `~/.codex/AGENTS.md` (only when the route is installed). The
block asks something only of a main-agent Luna; any other model or subagent is told to ignore it. Luna hands a job over
by running `codex-chatgpt-web worker run --brief-file .longrun/brief.md`, a plain command (the block holds its exact
path). It starts `codex exec` on the worker model in a new chat, so the worker's own Stop hook also keeps it going until
the acceptance command passes. If that chat breaks, up to three fresh chats are tried, each told what went wrong. Codex's
built-in subagent tool is not used: it only starts agents when the user asks for them by name, so it cannot be relied on.

```bash
codex-chatgpt-web longrun worker xhigh     # worker effort: medium, high or xhigh (default high)
codex-chatgpt-web longrun driver off       # Luna works alone again; `driver on` switches it back
codex-chatgpt-web longrun status           # shows the driver, the worker and whether the block is installed
```

Open a new Codex chat after changing either setting. Whether Luna hands the work over is its own decision, guided by
the block; the acceptance command is what enforces completion. The worker's sandbox is `workerSandbox` in
`~/.codex-chatgpt-web/longrun.json` (`workspace-write` by default, or `danger-full-access`).

The rest of this page describes the **unattended supervisor**, a separate script for jobs you start yourself.

`scripts/longrun/longrun.mjs` drives a Codex task for hours without you. The coding itself runs through
the bridge on your **ChatGPT web quota** (a `chatgpt-web/*` model). A small **controller** model supervises it.
The controller is a native model, so its few short calls use the **Codex quota**; it defaults to
`gpt-6-luna` at `high` effort and can be changed or switched off.

```bash
node scripts/longrun/longrun.mjs --repo <project> --task task.md --verify "npm test"
```

Windows: `scripts\longrun\longrun.cmd` takes the same arguments.

## What it does

1. Creates a work branch (`longrun/<id>`), adds `.longrun/` to `.git/info/exclude`, and writes
   `.longrun/PROGRESS.md`. The task prompt tells the model to keep that file current: goal, standing
   instructions word for word, plan, what is done, decisions, the next step, how to verify, and `STATUS`.
2. Runs `codex exec` in rounds. After each round it makes a checkpoint commit of leftover work and runs your
   acceptance command (`--verify`).
3. The task is finished only when the acceptance command exits 0 **and** the model has written
   `STATUS: DONE`. Otherwise the next round continues, with the failing output attached.
4. Handles trouble itself:

| Situation | Response |
| --- | --- |
| stream dropped, ChatGPT stopped responding, tab closed, bridge refused | back off and resume the same chat; after 3 in a row move to a fresh chat |
| round silent for `--stall-minutes` (default 30) | kill it, then resume |
| chat's context is full or compaction failed | fresh chat with a written briefing |
| usage limit | wait for the time in the message (default 15 min), not counted as a failure |
| "model is at capacity" | same, but waits 5 min when the message gives no time |
| signed out | wait 10 min, up to 6 times, then stop with `needs_login` |
| launcher or bridge not running | start the launcher and wait for the bridge |
| a round that keeps running but changes nothing for `--progress-minutes` (default 40), or fails to compact its context 3 times in a row | kill it and move to a fresh chat (a poisoned chat is never resumed); a forced `--compact-limit` is raised by 50% for the next chats; after 3 such rounds in a row stop with `stuck_loop` |
| rounds that change nothing | fresh chat after 3, stop after 6 (`no_progress`) |
| unknown model / configuration error | stop at once (`fatal_error`) |
| supervisor killed or machine restarted | run the same command again: it resumes from `.longrun/state.json` |

A fresh chat receives the original task, the progress file, recent commits, uncommitted changes, the last
acceptance output and a briefing written by the controller. Nothing depends on the old chat's memory.

Details that keep the handoff safe:

- A chat is written to `state.json` the moment it starts, so a crashed supervisor resumes that chat instead of abandoning it.
- The briefing is kept until a handoff chat has really started; a handoff that dies early is retried with it.
- With `--compact-limit`, the quoted task, progress file and briefing are shrunk to fit the new chat's window.
- Every round's progress file is saved in `.longrun/progress-history/`. If the current file lost most of its
  content, the handoff also carries the longest earlier version.
- After a stuck round the new chat is told not to dump whole files into the conversation and to commit early.
- While the acceptance command fails, the model is told to keep `STATUS: IN_PROGRESS`.

## The controller

While a round is running, the controller also checks on it. If the repository and progress file have not changed
for `--watch-minutes` (default 10), it is shown the recent commands, the repeated ones, compaction errors and the
time since the process last produced output, and answers `wait`, `fresh` (the chat is looping or poisoned: kill
it and continue in a new chat with a briefing) or `restart` (the process is silent and hung: resume the same chat).
A `restart` is honoured only for a process that really is silent. If the controller does not answer, the hard
limit (`--progress-minutes`) still applies.

After every round that is not final, the controller reads a short evidence summary and answers with JSON:
continue in the same chat or start a fresh one, how healthy the context looks (`ok`, `degraded`,
`polluted`), an optional pause and an optional hint for the next round. When a fresh chat is chosen it also
writes the briefing. Its answer is advice: the built-in policy keeps every hard limit. The controller
cannot override a rate-limit or login wait, a full context window or any stop, cannot declare the task
finished, and can only recommend stopping after three consecutive failures. If it does not answer or answers
badly, the built-in policy decides alone.

```bash
--controller-model gpt-6-luna      # or env LONGRUN_CONTROLLER_MODEL
--controller-effort high           # high | xhigh | ...; or env LONGRUN_CONTROLLER_EFFORT
--controller-every 1               # consult after every n-th successful round
--no-controller                    # built-in policy only
--controller-mode auto             # auto | jev | shadow | luna, see "Jev as the fast first line"; or env LONGRUN_CONTROLLER_MODE
--model chatgpt-web/gpt-6-sol --effort xhigh   # the coding chat (web quota)
```

## Jev as the fast first line

[Jev](https://typesafe.ai) (TypeSafe AI) is a decision model, not a chat model: it is sent the same evidence summary
and typed questions and returns a choice or score with probabilities and a confidence, usually in well under a
second. When a Jev key is set up, the controller asks Jev first and only asks the Codex model (Luna) when Jev is
unsure, so most routine decisions cost no Codex quota and no minutes of waiting. Without a key nothing changes.

```bash
node scripts/longrun/jev-key.mjs set      # hidden prompt; one live check; stored per user (Windows DPAPI)
node scripts/longrun/jev-key.mjs status   # where the key comes from, never the key itself
node scripts/longrun/jev-key.mjs test     # one sample decision with its latency
node scripts/longrun/jev-key.mjs clear
```

Type the key only into that prompt, never into a chat. `TYPESAFE_API_KEY` in the environment overrides the stored key.

| Mode (`--controller-mode`) | Behaviour |
| --- | --- |
| `auto` (default) | Jev answers; the Codex model is asked only for the cases below. No key: same as `luna`, with a `Jev is OFF` line in the log. |
| `shadow` | Both are asked and the Codex model acts; Jev's answer is logged and the agreement counted in `REPORT.md`. Use it to judge Jev on your own jobs before trusting it. |
| `jev` | Jev decides; when it is unsure the policy decides alone. The Codex model only writes briefings. |
| `luna` | The Codex model only, as before. |

What Jev decides, and when its answer stands:

- **Between rounds** (continue or a fresh chat, plus a context-health score). It stands when its confidence is at least
  `--jev-confidence` (default 0.6) and it agrees with the policy's own proposal, or when it moves a chat to a fresh one at
  `--jev-high-confidence` (default 0.85). It never turns a fresh chat that the policy chose back into a continue, and a `stop`
  or contradictory answer (a continue with a "polluted" context) always goes to the Codex model.
- **While a round runs** (wait, fresh, restart). `wait` needs the normal confidence; ending a round needs the high one.
- **An error the rules cannot place** (they call it transient): Jev may recognise a rate limit, a login or a full context.
  Only at high confidence, and it can never produce a fatal stop.
- Briefings and hints are text, so they stay with the Codex model.

If Jev fails three times in a row, or the API rejects the key, Jev is switched off for the rest of the run and the Codex
model carries on. Every Jev answer is saved as `.longrun/jev-NNNN-<kind>.json` (probabilities, no evidence, no key).

**Jev is on for every run by default.** Anyone who starts a run as this Windows user gets it, because the key is stored
per user and the default mode is `auto`; no flag is needed. Do not pass `--controller-mode luna` unless you mean to turn
it off. It does not depend on the Codex model: `--no-controller` switches only the Codex model off, and Jev then decides
alone (when it is unsure, the policy does). To make a run fail instead of quietly running without Jev (no key, an
unreadable key, or `luna` mode), pass `--require-jev` or set `LONGRUN_REQUIRE_JEV=1`.

To see whether Jev is deciding in a run, read `.longrun/STATUS.json`: `jev` has `active`, `mode`, `off` (why, when it is
not active) and the call counts; `REPORT.md` has the same in a `- Jev:` line, and `events.jsonl` starts with
`Jev is on (...)` or `Jev is OFF: ...`.

What is sent to TypeSafe: the same short evidence summary Luna sees (task start, counters, last messages, acceptance
output, the start of the progress file, recent commits, uncommitted file names), with credential-looking text masked
(bearer tokens, `sk-`/`ghp_`/AWS/Slack keys, JWTs, private-key blocks, `password=`/`token=` values). Nothing is sent when
there is no key or in `luna` mode. Jev's confidence is not claimed to be calibrated by the vendor, so the thresholds are
yours to tune; run a job in `shadow` first.

## Unattended use

- Keep the machine awake: the script holds a Windows keep-awake request while it runs (`--no-keep-awake` to disable).
- Survive a reboot: register the same command with Windows Task Scheduler (run at logon). It resumes.
- Be told when it ends: `--notify-cmd "<command>"` runs with `LONGRUN_STATUS` and `LONGRUN_REASON` set.
- Reconnect and compaction errors do not count as activity for the silent-round watchdog (`--stall-minutes`).
- Inspect: `.longrun/REPORT.md`, `.longrun/STATUS.json`, `.longrun/events.jsonl`, `.longrun/rounds/`.
- `--sandbox danger-full-access` lets the model run `git commit` itself on Windows; the default
  `workspace-write` cannot write `.git`, and the supervisor's checkpoint commits cover that.

## Tested end to end

Real runs through the bridge, each judged by a hidden acceptance script, with faults injected on purpose:

| Worker effort | Task | Faults | Result |
| --- | --- | --- | --- |
| high | expression-language interpreter | codex killed at +7 min, supervisor killed at +16 min | 118/118 checks, 3 rounds |
| extra high | ledger application in 6 phases | 3 codex kills, launcher closed, supervisor killed and restarted, ChatGPT "at capacity" for 45 min | 78/78 checks, 12 rounds, controller moved the job to a fresh chat at round 8 |
| high | utility library, no controller | 3 codex kills in a row | 89/89 checks; fresh chat opened (`chat_keeps_failing`) and kept every standing rule |
| medium | utility library, Jev on | 1 codex kill | 89/89 checks, 3 rounds |

This shows the recovery paths work; it does not promise a literal 100% on every job. Jobs of 10 to 20 hours
depend on the acceptance command and on ChatGPT staying available.

## Limits

- It cannot make a model correct. The acceptance command is what decides "done", so give it real checks
  (tests, linters, a build, a script with hidden cases). A task without one only stops when the model says so.
- A chat can still lose detail in a very long job. The progress file and briefing are what carry it, so
  keep standing rules in the task text; ChatGPT itself redacts credential-looking values from summaries.
- It does not sign in for you.
