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
| signed out | wait 10 min, up to 6 times, then stop with `needs_login` |
| launcher or bridge not running | start the launcher and wait for the bridge |
| rounds that change nothing | fresh chat after 3, stop after 6 (`no_progress`) |
| unknown model / configuration error | stop at once (`fatal_error`) |
| supervisor killed or machine restarted | run the same command again: it resumes from `.longrun/state.json` |

A fresh chat receives the original task, the progress file, recent commits, uncommitted changes, the last
acceptance output and a briefing written by the controller. Nothing depends on the old chat's memory.

## The controller

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
--model chatgpt-web/gpt-6-sol --effort xhigh   # the coding chat (web quota)
```

## Unattended use

- Keep the machine awake: the script holds a Windows keep-awake request while it runs (`--no-keep-awake` to disable).
- Survive a reboot: register the same command with Windows Task Scheduler (run at logon). It resumes.
- Be told when it ends: `--notify-cmd "<command>"` runs with `LONGRUN_STATUS` and `LONGRUN_REASON` set.
- Inspect: `.longrun/REPORT.md`, `.longrun/STATUS.json`, `.longrun/events.jsonl`, `.longrun/rounds/`.
- `--sandbox danger-full-access` lets the model run `git commit` itself on Windows; the default
  `workspace-write` cannot write `.git`, and the supervisor's checkpoint commits cover that.

## Limits

- It cannot make a model correct. The acceptance command is what decides "done", so give it real checks
  (tests, linters, a build, a script with hidden cases). A task without one only stops when the model says so.
- A chat can still lose detail in a very long job. The progress file and briefing are what carry it, so
  keep standing rules in the task text; ChatGPT itself redacts credential-looking values from summaries.
- It does not sign in for you.
