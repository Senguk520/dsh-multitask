# dsh-multitask — the Multitask "shock absorber" mode

[中文](README.md) · [Design notes and measured evidence](docs/DESIGN.md) · MIT License

A work mode for DSH in which **the main conversation does exactly three things**: understand what you asked for, turn it into task briefs, and report back what the Subagents concluded. Every piece of process data — file contents, command output, build logs, search results, dead ends — is digested inside a **Subagent's context** and never enters the main one. The main conversation therefore holds only high-value information.

This is a **mechanism**, not a prompt asking the model to behave. Once the mode is selected, the main conversation (the coordinator) genuinely has a narrower tool surface: the tools that would drag in process data — writing files, running commands, searching the web — are **not in its visible set**. It cannot call them, so it cannot pollute its own context. A Subagent (worker) is the opposite: it gets the full tool surface, does the work, and returns only its conclusion.

Zero runtime dependencies. No changes to DSH source.

---

## How it differs from other modes

| | Main conversation (coordinator) | Subagent (worker) |
|---|---|---|
| Tool surface | read-only checks + delegation + result retrieval + interaction | full (write files, run commands, build, search…) |
| Context | your request + task briefs + conclusions | all the process data |
| Job | understand, translate, dispatch, verify, report | do the work |

What the coordinator keeps (a whitelist):

- **Read-only checks** — `read` `grep` `glob` `file_info`
- **Delegation** — `subagent` `subagent_fork` `subagent_ptc` `subagent_minimal`
- **Subagent control** — `send_message` `interrupt_agent` `list_agents`
- **Result retrieval** — `job_list` `job_output` `job_kill`
- **Orchestration** — `workflow`
- **Interaction and self-management** — `ask_user_question` `todo_write` `create_goal` `get_goal` `update_goal` `exit_plan_mode` `present` `skill`

Anything not on that list is withheld by default — `write`, `edit`, `pwsh`, `web_search`, `web_fetch`, `read_image`, `ssh_*`, `task_board_*`, `plugin_manager`, and so on. The rule is a **complement**: withheld = currently visible − kept. Any tool the host adds later is therefore also withheld from the coordinator by default, with no change needed in this plugin.

The read-only tools are kept on purpose: the coordinator is meant to **verify** a Subagent's claims independently instead of trusting them blindly.

---

## Installation

### From the published package (recommended)

```
dsh plugin add dsh-multitask
```

Or install it from the in-app **Plugins** page. The package lands in the profile's `node_modules`, and the bundled `cordis.patch.yml` inserts a bare package name (`dsh-multitask`) with no absolute paths — so it works on any machine, any user name, any install location.

> **Desktop (Electron) note.** The app manages its own `desktop` profile exclusively, and the CLI refuses outright: `error: profile "desktop" is managed exclusively by the Electron application`. In that case install from the in-app **Plugins** page, or use the source route below.

### From a source checkout

To run the sources in your working tree (edits without going through npm), **append** this block to the profile's `cordis.patch.yml`, pointing at your local entry with an **absolute** `file://` URL:

```yaml
- insert:
    - id: multitask
      name: 'file:///absolute/path/to/dsh-multitask/lib/index.js?v=6'
```

Two things to watch:

- **Spaces and `%` in the path must be percent-encoded** (common on Windows). Let a program encode it rather than typing it by hand — in PowerShell: `(New-Object System.Uri('H:\my repo\dsh-multitask\lib\index.js')).AbsoluteUri`.
- **The trailing `?v=N` is a cache key**, and it only means anything in this `file://` mode (see Development → "Making source edits take effect").

**Adding this row needs no restart**: DSH watches `cordis.patch.yml` and hot-reloads it.

---

## Usage

When creating a **new session**, pick **"Multitask 减震器模式"** in the mode selector, then just ask for what you want.

> The mode can only be chosen **before a session starts**. A session that is already running cannot switch into it — that is an existing DSH constraint (the tool surface and prompt freeze on the first turn), not a limitation of this plugin.

The coordinator translates your request into **self-contained** task briefs — a Subagent cannot see this conversation, so a brief must carry everything it needs (goal, verified current state, project conventions, safety rails, numbered tasks, conditional branches, stop conditions, report format). Independent briefs are dispatched **in parallel**, and the coordinator keeps working while they run.

---

## The four kinds of Subagent

The coordinator has four delegation paths, and the difference is mainly the **tool surface**:

| Delegation tool | Tool surface | Best for |
|---|---|---|
| `subagent` | **full** | the default — writing code, running tests, editing files, execution work |
| `subagent_fork` | **full** + the **completed turns** of this conversation | review and continuation — when the work must build on what is already established here |
| `subagent_ptc` | **PTC-collapsed**: only `run_code` is directly callable; every other tool is reached from inside a program via a generated SDK | programmatic bulk work — filtering, aggregating, or moving large data sets whose intermediate values should never enter the context |
| `subagent_minimal` | **read-only**: write and execute tools are removed | investigation, quick answers, fact-checking |

When in doubt, use `subagent`. That guidance lives in the coordinator persona, and the coordinator picks per task.

**Delegation is one level deep**: coordinator → worker, and a worker cannot delegate further. Jobs that need splitting are split by the coordinator into flat briefs.

---

## Settings

Once installed, DSH's settings gain the following.

**The "Multitask" page — two cards**

| Card | Field | What it does |
|---|---|---|
| Model used by Subagents | `multitask.subagentModels[]` | the default model for each of the four worker kinds. Either "use one model for every Subagent" or per-kind; the default is "inherit coordinator". Applies only to sessions created **afterwards** |
| Subagent parallelism limit | `subagent.maxActiveSubagents` | **the same field** as the row in Settings → General, and it takes effect immediately |

**The "General" page — two rows** (alongside the built-in language / appearance / developer-tools rows)

| Row | Field | Scope |
|---|---|---|
| Maximum recursion depth | `subagent.maxDepth` | host-level: applies to every mode, not just Multitask |
| Subagent parallelism limit | `subagent.maxActiveSubagents` | same; and it is the same value as the card on the Multitask page |

The session header also shows how many Subagents are currently running.

The model card's **shape is derived, never stored**: all four kinds pointing at one route means "use one model for every Subagent", anything else means per-kind. Switching the shape creates no dirty state.

### The Subagent parallelism limit

**There is only one value**: the host's `subagent.maxActiveSubagents`. It appears in **two places** in Settings (the card on the Multitask page, and a row in General), but both edit **the same field** — change it in either and the other follows immediately. This plugin adds no cap of its own, and there is no second layer cutting you off.

That field's default is **8**: with no configuration, 8 is all you get. But 8 is a **default, not a ceiling** — **whatever you write is the limit**. To run N, set it to N — in either of the two Settings locations, or by giving the host row a config:

```yaml
- id: subagent
  config:
    maxActiveSubagents: 16
```

When the limit is exceeded, the extra delegations are dropped **before anything starts**, with this error, verbatim:

```
Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
```

**The refusal is the host's.** It is neither a broken plugin nor a fault: the host raises it while handing out slots, before any Subagent is created — so you get a plain error rather than a Subagent id. The fix is to **wait for existing Subagents to finish**, or **merge several tasks into one brief** for a single Subagent. Do not retry the same fan-out unchanged.

The count is "**total live Subagents under one main Agent**", not just the ones you started in the same round: a worker that has finished its brief but has not exited **still occupies a slot**. So the safe pattern is "dispatch a batch → let them all finish → dispatch the next batch".

> ⚠️ **"I dispatched 10 and they all succeeded" does not prove the limit was raised.** That is blocking / serial execution: one runs at a time, and the next starts only after the previous ends, so **the live count never exceeded 1**. Only a fan-out **inside a single message** actually competes for slots. To tell parallel from serial, look at how many Subagents are running at one instant, not at how many you dispatched in total.

---

## Approving dangerous operations

In this mode all the real work is done by Subagents, and DSH turns their approval chain off by default (the policy is pinned to `never`, and the model is additionally told to self-censor). This plugin wires it back up as a **two-level gate**:

| Level | Behaviour |
|---|---|
| Level 1 (deterministic rules) | safe commands **run directly, without interrupting you** — no extra model request, no change to the sandbox |
| Level 2 (relay to the parent session) | dangerous commands **raise an approval card in the main conversation** for you to allow or reject — reusing the existing approval panel, with no new UI |

Level 1 covers what the sandbox cannot express: destructive commands **inside** the workspace (`rm -rf .`, `git reset --hard`, `git clean -fd`), non-file dangers (`git push --force`, `npm publish`, `curl | bash`, privilege escalation, execution-policy changes), and writes outside the workspace. A missed pattern behaves exactly like having no plugin at all, so Level 1 can only **add** a prompt — never remove protection.

**The red line**: all of this is enabled **only in interactive sessions** — the parent session's approval policy must be `ask`. Headless and unattended deployments rely on `never` to guarantee they are never left waiting for an answer that will not come, and this plugin does nothing at all in that environment.

Authorisation is **one-shot every time**: "Allow once" authorises that call only, and the same call prompts again next time. There is no "always allow".

**With a background dispatch whose turn has ended**, there is nowhere to raise a card (the relay needs the parent session to have an open turn). The plugin then does its best to have a message from that Subagent appear in the main conversation, naming which child session it is, what it wants to run, and where to answer. **That is a notice, not an approval** — the message channel carries no approval result, so the loop still closes only by answering inside that child session; until you do, the call stays blocked.

---

## Common problems

**The mode does not appear in the new-session selector.** First confirm the plugin row is actually installed (visible in the plugins list, and not `disabled`), then restart the app. If it is still missing, look in the log for warnings beginning with `dsh-multitask` — they name the cause (registry absent, composition invalid, id held by an earlier module instance, and so on).

**A Subagent fails to run any command at all**, with this error, verbatim:

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace path>)
```

This is not about concurrency (it reproduces with a single Subagent running) and not about the command (even `Get-Location` fails). It is a **directory-permission precondition on the workspace folder**: DSH's ACL sandbox must write a security descriptor onto the session's writable root, and that call includes a mandatory integrity label. The label lives in the SACL, so the call additionally needs **WRITE_OWNER**, while the owner's implicit rights cover only `READ_CONTROL` and `WRITE_DAC`. A folder that grants you only *Modify* therefore lacks it and the call fails — which is why a workspace under your user profile works with no setup, while a folder created directly under a drive root (inheriting only Modify) does not.

**The repair is already automatic.** At session start this plugin checks the workspace folder and, if `WRITE_OWNER` is missing, **adds exactly that one permission** (a non-inherited `TakeOwnership`) and stops. It needs no approval and no elevation, and you should **never** widen a folder to *Full control* for this — that would additionally hand over the right to change permissions and take ownership, far beyond what is needed.

If a Subagent is still refused, the automatic grant did not land: the folder is **owned by another account**, or it is **not writable** by this process. In that case, treat it as your decision — it is the specific, fixable cause, with the folder named. **Read-only tools are unaffected**, so content and file-metadata tasks are always delegable.

**You hit the parallelism limit.** See "The Subagent parallelism limit" above; the refusal is the host's. Wait for existing Subagents, or merge tasks into one brief.

**No approval card appeared.** First check that the session's approval policy is `ask` (a headless configuration is `never`, and then this plugin stays entirely out of the way). If you dispatched in the background and the turn has ended, see the last paragraph of "Approving dangerous operations".

**Source edits have no effect.** You must **restart the app**. Bumping `?v=N` in the profile patch alone is a no-op for a row that is already running: the loader only sees that its name changed, so it neither reloads the module nor restarts it. See "Making source edits take effect" in [docs/DESIGN.md](docs/DESIGN.md).

---

## Verifying that it actually works

With the mode selected, have the coordinator try these:

| You say | Expected |
|---|---|
| "Read package.json yourself and tell me the version." | ✅ succeeds (read-only checks are kept) |
| "Run `git status` yourself." | ❌ the call is impossible — the tool is not in its visible set |
| "Delegate to a Subagent to run `git status` and report the conclusion." | ✅ the Subagent runs it and brings back only the conclusion |
| "Delegate to a Subagent to read package.json and report the file name and size." | ✅ the read-only route always works (`read` / `file_info`) |

The log shows which tools were actually withheld (all lines are prefixed `dsh-multitask:`):

```
dsh-multitask: coordinator scope engaged — withheld N tool(s): edit, pwsh, read_image, ssh_exec, ...
```

The approval gate's preconditions and its verification steps — including the fallback path for background dispatches — are in [docs/DESIGN.md](docs/DESIGN.md), under "Verifying that it actually works" and "Approving dangerous operations".

---

## Tunables (profile)

Override by **id**, appending after the `dsh-multitask` `insert` block (a later entry with the same id wins):

```yaml
- id: multitask
  config:
    presetId: multitask          # change this to install several variants side by side
    order: 5                     # position in the mode selector
    guardEnabled: true           # false = disable the shock absorber (soft constraints only; diagnostics)
    keep:                        # appended to the coordinator's keep list
      - web_search
      - web_fetch
    extraDeny:                   # force-remove (wins over the keep list)
      - read
```

`enabled: false` turns the whole plugin off (no preset is declared, and the mode disappears from the selector).

The remaining switches live in the `config` of the corresponding rows in `presets/multitask/composition.mjs`:

| Row | Effect of disabling |
|---|---|
| `subagent-mode` | the PTC presentation is off, and `subagent_ptc` degrades to the same native surface as `subagent` |
| `minimal-guard` | the read-only worker reverts to "only the static three withheld" and can see write-capable tools installed by other plugins again — **no security benefit** |
| `approval-gate` | dangerous operations no longer prompt (back to default DSH behaviour) |
| `workspace-acl` | `WRITE_OWNER` is no longer granted automatically (or use `config.autoGrantWriteOwner: false`) |

The environment variable `DSH_MULTITASK_MULTI_MODE=0` disables the `subagent_ptc` and `subagent_minimal` paths and the PTC presentation plugin in one step, without touching the original `subagent` / `subagent_fork`; it is read at module load, so it needs an app restart.

Source edits take effect only after a **restart**.

---

## Uninstalling

If you installed from the package manager, let it do the work: `dsh plugin remove dsh-multitask`, or uninstall from the **Plugins** page.
If you installed from a source checkout, delete the whole `- insert: - id: multitask` block from the profile patch.

Either way the mode disappears from the selector for **new** sessions (running sessions are unaffected), and **no restart is needed** — DSH hot-reloads that patch, and the plugin unregisters its own preset declaration on unload. To **suspend** it temporarily instead, add `disabled: true` to that row.

---

## Development

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → inserts the host row on install; dsh.client → the browser half
├── cordis.patch.yml                    # inserts the plugin row into the profile roster
├── lib/
│   ├── index.js                        # host half: declares the bundled preset with agentPresets
│   └── client.js                       # browser half: the Multitask settings page + two General rows
├── presets/multitask/
│   ├── composition.mjs                 # the preset composition + coordinator persona + the four worker personas
│   ├── coordinator-guard.mjs           # the shock absorber (including the mode-isolation ownership check)
│   ├── subagent-mode.mjs               # PTC presentation: collapses a marked Subagent onto run_code
│   ├── minimal-guard.mjs               # adaptive narrowing for the read-only worker
│   ├── approval-gate.mjs               # the approval gate for dangerous operations
│   ├── workspace-acl.mjs               # workspace ACL: grants WRITE_OWNER (the only module that changes system state)
│   └── file-info.mjs                   # the read-only metadata tool file_info
├── docs/DESIGN.md                      # design reasoning, measured evidence, verification checklist
├── README.md / README.en.md
└── LICENSE
```

The preset modules (`presets/multitask/*.mjs`) **import nothing**: they pull in no `@deepseek-ai/*` dependency, because a failed import means the whole preset fails to mount. The cost is that a few constants are duplicated, and the verification scripts compare them.

### Local checks

> ★ **Rule: every test file belongs in `test/`.**
> Probes, verification scripts, one-off checks, diagnostics, regression suites — all go in `test/` and run with `node test/<name>.mjs`; nowhere else. The whole `test/` directory is ignored by `.gitignore` and deliberately untracked (tests do not go to the remote), and it is not part of the published package.

There are seven local suites; each derives the modules under test from its own location, so the checkout runs from any path, non-ASCII included:

```powershell
node test/guard-mode-isolation-regression.mjs    # mode-isolation regression (13 groups)
node test/repo-consistency.mjs                   # repo consistency / doc consistency / test placement (38 groups)
node test/subagent-mode-marker-source.mjs        # where the mode marker comes from (foreground and background dispatch, 9 cases)
node test/minimal-guard-catalog.mjs              # the read-only worker's catalog filter (12 cases)
node test/approval-gate-rules.mjs                # approval rule table: missed and false positives (8 groups)
node test/approval-gate-integration.mjs          # gate direction / event shape / relay direction (38 groups)
node test/workspace-acl-rules.mjs                # workspace ACL red lines and decisions (14 groups)
```

They all run **in-process** with a tiny built-in `test()` runner: no child processes, no captured pipes (under a restricted sandbox `node --test` fails with `spawn EPERM`). Most suites also carry **reverse verification**: break a key guard and the matching cases must go red — a guard that can never fail is no guard at all.

### Making source edits take effect

**Restart the app after editing the sources.** This package lives outside the HMR-watched root, so Node's ESM cache keeps serving the old module; and although the profile patch itself *is* hot-reloaded, **bumping `?v=N` on a row that is already running only changes its name** — the loader takes the name-only branch and does not reload. A fresh process reading that row for the first time is what actually picks up your latest source.

Two related traps: a relative import does **not** inherit the entry's query (this package propagates it explicitly, so one bump refreshes the whole module graph), and "delete and re-add within one save" does not work either (the comparison is by id, so it is still the same row) — you must delete, let it settle, then add it back.

---

## Known boundaries

- **The mode is only selectable in a new session.** A running session cannot switch in.
- **What the coordinator cannot see, it cannot verify.** Keeping read-only tools is exactly what lets it check a Subagent's claims; remove `read` / `grep` / `glob` and that ability is gone.
- **Delegation depth is 1.** A worker cannot delegate further; very large jobs must be split by the coordinator into parallel briefs.
- **PTC's "collapse" is a presentation collapse, not a capability cut — by design, not a defect.** The direct surface of `subagent_ptc` really is just `run_code`, but the SDK binding table remains fully callable from inside a program; remove it and PTC is an empty shell.
- **The read-only worker is "two layers of narrowing", still not a sandbox.** The static `toolFilter` and the adaptive narrowing intersect inside `dsh-tools`, so they cannot widen anything; but if a plugin registers a new mutating tool **after** that worker is created, it will not be withheld (a deliberate trade-off).
- **The approval gate's fallback is only a pointing notice.** When the relay fails the request stays pending, and the notice does not release it; only answering in that child session does.
- **The rule table is pattern matching, so it will miss novel dangerous commands.** The real gate is therefore the Level-2 relay; Level 1 only exists to keep safe commands from bothering you.
- **An upstream change can disable a guard**, and every such failure fails towards "the behaviour you had without that guard", never towards wider permissions.

More complete boundaries, unverified items, and the measured evidence behind every claim are in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
