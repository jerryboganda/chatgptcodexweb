# Long-horizon runs

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

## Limits

- It cannot make a model correct. The acceptance command is what decides "done", so give it real checks
  (tests, linters, a build, a script with hidden cases). A task without one only stops when the model says so.
- A chat can still lose detail in a very long job. The progress file and briefing are what carry it, so
  keep standing rules in the task text; ChatGPT itself redacts credential-looking values from summaries.
- It does not sign in for you.
