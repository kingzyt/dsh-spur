# Session keep-alive (@kingzyt/dsh-spur)

English | [中文](README.zh.md)

A DeepSeek Harness plugin that gives every session a manual switch in the right sidebar. Once the switch is on, a stopped session is reminded to carry on as soon as it goes idle; the main agent writes 「已经完成所有任务」 in the `reply` argument of `spur_reply`, and the reminder for that session stays off until you turn it back on.

It is a standalone bundle that lives outside the DSH source tree. Installing it only touches the user profile directory (`package.json`, `node_modules` and the lockfile under `$DSH_HOME/profiles/<profile>`); the DSH repository itself is never modified.

## Install

Requires DeepSeek Harness `>= 0.2.2-rc.4`.

From the GitHub source:

```
dsh plugin --profile web add github:kingzyt/dsh-spur
```

From a local development directory (edits take effect after a reload):

```
dsh plugin --profile web add D:\projects\dsh-plugins\spur
```

You can also use the `plugin_manager` tool from a session (`install_bundle`, with an absolute directory path or `github:kingzyt/dsh-spur`), or choose “Add local directory” on the Plugins page.

The installed row is `spur`; the package name is `@kingzyt/dsh-spur`.

## Companion plugin: context tools

The reminder mentions `context_usage` and `compact_context`, and the “compact after a few silent reminders” option uses the host compaction service. Both come from the companion plugin:

**[kingzyt/dsh-context-tools](https://github.com/kingzyt/dsh-context-tools)** (package `@kingzyt/dsh-context-tools`)

For the full feature set install both:

```
dsh plugin --profile web add github:kingzyt/dsh-context-tools
dsh plugin --profile web add github:kingzyt/dsh-spur
```

It works without the companion plugin: the reminder text switches to a variant that names no tools, auto-compaction degrades to a single warning log, and everything else keeps working.

## Switch and stopping

- **Off by default.** Each session has its own switch in the right sidebar; a session with the switch off never receives a reminder.
- Once on, every completed turn (`turn/end` with `reason.kind === 'completed'`) is followed by a reminder when the session goes idle, with no cap on the number of reminders. If it stops again between reminders, the next one is queued.
- **Three labels stop it**: the main agent calls `spur_reply` with `reply` set to 「已经完成所有任务」 (done), 「进行不下去」 (genuinely blocked) or 「暂停」 (waiting for the user). All three switch this session's reminders off, and a later user message does not bring them back — reopen the switch in the panel to resume (reopening also clears the label).
- Turning the switch off in the panel is the other stop path, with the same effect: no reminders until you turn it back on.

The plugin never reads the reply text, never writes to the system prompt, and never explains its own machinery. There are exactly two channels between the plugin and the model: the reminder, and the `spur_reply` label entry.

## The reminder has two items

The reminder is exactly this, nothing else:

```
【保活提醒】你停下来了，「全部任务」确定完成了吗？

1. 没完成就继续做，不要偷懒，也不要停下来等确认。
2. 上下文到 60% 以上才需要担心预算：先用 context_usage 查真实占用。60% 以前不用焦虑，上下文够用；流程要求压缩时（例如开始新的一步、切换任务）照流程用 compact_context 压，不受这个百分比限制。
```

The second item follows the tool registry: both context tools registered names both; only the reader registered names only the reader; neither registers only “60% 以上才需要担心预算”, never a tool that cannot be called. The percentage is editable in the panel (`compactFloorPercent`). It is a “stop worrying about the budget” threshold, not a compaction permission: a flow (`/multi-step-plan`, at the start of every step) that wants to compact still compacts, and the reminder does not block it.

### Auto-task mode (a switch)

When it is on, every reminder appends a fixed paragraph after those two items, verbatim:

```
一直做到最后一步，中途不用问我，除非遇到原则性的分歧无法决断，必须要问我，才问我问题，但仅仅把问题问出来，然后停止即可，因为我也没法回复
在开始新的一步之前，记得使用上下文工具压缩会话，不然你会焦虑的
中途遇到4轮审评还过不了的情况，就直接开工，不用再审
审评在过关、或是4轮上限审完之前，不需要问我（只有过关和审到4轮不再审两种情况，其他情况都要继续审）
遇到要不要拆的情况，自行判断，不用问我
```

The plugin does not guess whether the current task is a multi-step one; it only looks at the switch. The “Message sent to the AI” block in the panel shows the whole text.

That text is editable: the panel has a text area (`autoTaskHint`) whose default is the paragraph above. Edits save themselves and apply to the following reminders; “Reset to defaults” restores the built-in text.

## Idle-driven reminders (events plus a watchdog)

Every time the session goes from running to idle, the plugin sends the reminder on the `agent/status` transition to `idle`, round after round like the built-in goal driver, until the main agent stops it with a label or you turn the switch off.

- Only completed turns count (`turn/end` with `completed`); aborted and failed turns are left alone.
- The reminder steps aside while the session is running, while a subagent runs, or while the inbox holds a message from someone else.
- Two reminders for one session are at least 2 minutes apart (configurable in the panel), so a burst of instant turns cannot produce a burst of reminders.
- **Watchdog**: every 60 seconds the plugin sweeps the watched sessions and, for any session that is on, idle and has no pending timer, performs one check and reminder. Lost events, a just-reloaded plugin, a session that stopped before you opened the panel — all of them are caught here, so “switch on but silent all day” cannot happen again.

## Compaction after silent reminders

Option `compactAfterIdleNudges` (default 3, `0` disables). Meaning: N reminders in a row passed with not a single tool call, which looks like a session squeezed by its context that no longer bothers to move.

At the (N+1)-th reminder the plugin first asks the host compaction service to compact the session (`compactNow`, folding earlier history into one summary checkpoint), then sends that reminder into the clean context. Any real work (any `tool/result`) or a user message resets the counter, so a session that is making progress is never compacted early.

A deployment without a compaction service (no `ctx.compaction` in the host plane) logs one warning and keeps reminding; it never stalls because compaction is unavailable. On this machine that service is provided by the host-plane backend of `@kingzyt/dsh-context-tools`.

## Shutdown after the task ends (off by default)

There is a switch in the panel: when it is on and the main agent ends the task with any stop label (done / blocked / paused), the plugin checks once more **one gap later** — if the switch is still on and the label is still there (you did not reopen it), it runs the shutdown command.

- On Windows it runs `shutdown /s /t 60`: a 60-second grace period during which the panel shows a countdown and a “Cancel shutdown” button that runs `shutdown /a`; the command line works too. The grace length is configurable (`shutdownGraceSeconds`).
- One stop label triggers it once; reopening the switch before the check cancels it, and reopening during the grace period also aborts it.
- Implemented on Windows only; other platforms log one warning and do not shut down.
- `shutdownDryRun` logs instead of executing, for trying the switch or running the smoke tests (cancellation follows the same dry run).

## The settings panel in the right sidebar

The host half registers a right-sidebar tab (kind `spur`); open it from “会话保活提醒” on the sidebar's guide page, where it stays as a tab for that session. The panel contains:

- **This session's switch**: off by default; turning it on starts the countdown.
- **Status**: whether the session is running, whether a reminder is scheduled, how many reminders this session has had; after the main agent stops it, whether it was “done”, “blocked” or “paused”.
- **Nudge once now**: enabled only while the session is on and idle, to confirm the plugin is alive.
- **Message sent to the AI**: shows the exact text of the next reminder. Editing a parameter or flipping a switch updates it immediately; about half a second later the change saves itself and the reminder really goes out with it.
- **Records**: this session's **probe count** (timer checks, including those that did not end in a reminder), **reminder count**, and the **times of the last three reminders** (hour:minute:second). The counts are cumulative for this run: a new user message does not reset them and a page refresh does not lose them; only a plugin reload or a DSH restart resets them.
- **Auto-task mode**: one switch plus an editable text area; the text area's content is appended verbatim to every reminder and “Reset to defaults” restores the built-in text. The switch is yours; the plugin does not judge whether this is a multi-step task.
- **Global parameters**: budget worry threshold, compaction after N silent reminders (`0` disables), minimum gap between reminders, cool-down after switching on, plus the shutdown-after-the-task switch, auto-task mode and its editable text. Changes save themselves and apply to reminders immediately; the footer only has “Reset to defaults”. While a shutdown is inside its grace period the session block shows a countdown and a “Cancel shutdown” button.

Everything is stored under `spur/` inside the profile directory (resolved through the host service `ctx.get('profileContext').dir`, so it works even when `DSH_PROFILE_DIR` is not exported into the process):

- `settings.json`: the global parameters saved from the panel. It is the plugin's own data file, not the profile's `cordis.patch.yml` — which is why the patch row carries no config and the saved values win over row config and code defaults.
- `records.json`: per-session switch, stop label, probe/reminder counts and the last three reminder times, written a few hundred milliseconds after every change and restored after a plugin reload or a DSH restart.

The panel talks to the host half over two routes: `GET /api/spur.state` and `POST /api/spur.action` (`config` / `preview` / `session` / `nudge` / `shutdown-cancel`).

## Exclusions

- **A subagent still running**: no reminder yet; check again after one gap, and only once every subagent in the tree is idle does the main session get its reminder.
- A current goal does not suppress the reminder: with the switch on it keeps nudging; a goal driving as well is simply two drivers, and the user asked for “do not stop”.
- Subagent sessions themselves (`origin === 'subagent'` or `delegationDepth > 0`): they never receive reminders; the parent session handles them.
- Turns the user stopped, that failed, or were aborted: only `turn/end` with `reason.kind === 'completed'` enters the judgment.
- While the session is running: the timer is armed when the turn ends, and a check that finds the agent still running is skipped until the next turn ends. Manual reminders behave the same way — the button is disabled and a call is refused while running. The running state in the panel is live from the session snapshot.

Details are in [docs/DETAIL.md](docs/DETAIL.md).

## Layout

| Path | Purpose |
|---|---|
| `cordis.patch.yml` | The rows this bundle inserts; only `insert`, never an override of a shipped row |
| `src/index.js` | Host half: the `spur_reply` tool, timers, reminders, panel routes |
| `client.js` | Client half: the right-sidebar tab and its panel |
| `scripts/smoke.mjs` | Offline smoke check (tools and panel routes included) |
| `scripts/client-smoke.mjs` | Offline check of the client half (registration and render shapes) |
| `locale/`, `icon.svg` | Display metadata and icon (Chinese and English) |
| `docs/DETAIL.md` | The document shown on the Plugins page |

## Verification

```
node scripts/smoke.mjs
node scripts/client-smoke.mjs
```

`smoke.mjs` loads `src/index.js` with a stub context, feeds session events, runs real timers and calls `spur_reply` and the two panel routes directly. It asserts: no reminder while the switch is off; a reminder after a completed turn once it is on; only the two items in the text; repeated reminders while the session keeps stopping; total silence after 「已经完成所有任务」 (even when the user speaks again); the same silence with blocked and paused, with the panel showing each state; other labels keep reminding; reopening the panel clears the stop label; switching off stops reminding and refuses manual nudges; auto-shutdown (not scheduled while off; one check and execute when on, dry-run logs only; paused also triggers; reopening before the check cancels; a cancel is possible during the grace period and reopening also aborts it); aborted turns are not poked; subagent sessions are not poked; sessions with a goal are still nudged; a running subagent defers the reminder until it finishes; a running session makes way; nothing is written to the system prompt; the tool surface is only `spur_reply`; the three reminder variants for the context-tool registry; the configurable threshold; auto-compaction after N silent reminders (including 0 to disable, tool activity resetting the counter, and the degraded path without a compaction service); panel state (including the reminder preview, probe/reminder counts and the last three times); saving settings (immediate effect, written to disk, restored on the next load); nudge once now; refusing a manual nudge while running; working without a `connection` service (reminders but no panel); and invalid configuration falling back to defaults.

`client-smoke.mjs` loads `client.js` with a stub `window.__ModuleLoader__` and stub React, then asserts the module id, injected services, tab type and guide entry, tab body registration, matching dictionary key sets for both languages, and that the first screen, off, on, stopped, running and missing-context-tools renders all return a sane structure.

What it does not cover: real rendering and clicks in the browser, authentication on the `/api` routes, real `agent.followup()` delivery and the session log. After a page refresh the “会话保活提醒” entry appears on the sidebar's guide page.

## After changing the code

There is no build step: the source is the loaded module. Changing `src/index.js` does not always require a restart — on this machine, editing the `spur` row config in the profile patch (even editing it back) reloads the entry and re-imports the module, so the new code takes effect immediately. If a change ever does not appear, a DSH restart always applies it.

The client half `client.js` is loaded by the browser and needs a page refresh; a change to the `dsh.client` manifest also needs a refresh before it enters the module table. Settings live in `<profile>/spur/settings.json` and records in `<profile>/spur/records.json`, both independent of `cordis.patch.yml`; unsaved drafts live in the browser's `localStorage` and survive tab switches and refreshes.
