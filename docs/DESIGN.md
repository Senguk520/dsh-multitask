# dsh-multitask — Design notes

> **English** · [中文](DESIGN_zh.md)

> This document describes only the current version's design and behaviour; history, measured numbers and correction records are maintained separately and are not merged into it.

> **This document is not the README.** User-facing explanations, installation steps, the Settings panel and troubleshooting live in [`README.md`](../README.md) (English) and [`README.zh.md`](../README.zh.md) (Chinese) at the repository root.
>
> What is kept here is **another kind of content that development and maintenance need**: the design derivation ("why it must be written this way"), the upstream facts and failure posture each rule rests on, and the known boundaries and unconfirmed items, stated honestly. It describes the **current version's** design and behaviour — what a rule is right now, why it holds, and how it degrades when it fails.
>
> Suggested reading order: read the README first to understand what it is, then come back here to see why it holds. ⚠️ **The contents of the test suite are not in this document** — `test/` is not distributed with the repository or the published package, so a reader would not get it even if it were written here.

Reproduce Cursor's **Multitask** work mode in DSH.

**The main conversation does exactly three things**: understand the user's request → translate it into task briefs and dispatch them to subagents → summarize the subagents' conclusions. Reading files, running commands, building, searching, debugging — all the process data is digested inside the **subagent's context** and never enters the main conversation. The result is that the main conversation's context always holds only high-value information.

---

## What it actually does

| | Main conversation (coordinator) | Subagent (worker) |
|---|---|---|
| Tool surface | **mechanically narrowed**: read-only checks + delegation + result retrieval + interaction | **full** (including writing files, running commands, building) |
| Context | request + task briefs + conclusions | all the process data |
| Job | understand, translate, dispatch, verify, report | do the work |

The key is the phrase **mechanically narrowed**.

Relying on a persona instruction alone to say "please don't run commands yourself" is a **soft constraint** — the model may just run them anyway. This plugin turns that discipline into a **hard mechanism**: a tool restriction is installed on the coordinator's agent scope, pulling mutating and high-noise tools out of its visible surface. **If a tool is not there, it cannot be called, and so it cannot pollute the main context.**

---

## Installation

This package has **zero runtime dependencies** (it imports no npm package), so there is no need to install a dependency tree with pnpm, and no third-party code is pushed into `node_modules`.

### For users: install the published package

```
dsh plugin --profile <profile> add dsh-multitask
```

`--profile` is an **option and cannot be omitted** — `dsh plugin add dsh-multitask` fails outright with `error: required option '--profile <name>' not specified`. `<profile>` is the target profile name (the desktop app's own is called `desktop`; the profiles that exist are the directories under `~/.dsh/profiles/`).

Once installed, the package lands under that profile's `node_modules` (`~/.dsh/profiles/<profile>/node_modules/dsh-multitask/`), and DSH **automatically** appends `dsh-multitask` to that profile's `dsh.profile.bundles` layer list (because this package declares `dsh.bundle.patch` — `runProfilePnpm()` goes through `reconcile()` after pnpm succeeds, "newly installed bundle dependencies are enabled automatically"). The bundled `cordis.patch.yml` inserts a bare package name, **with no absolute paths**, so it holds on any machine, under any user name, at any install location. **Restart the app after installing** — bundle layers are composed at startup.

> **Desktop (Electron) note**: **fully quit the app** before installing — that is what the upstream `requireDesktopProfile()` error states verbatim (`... then fully quit it before running dsh plugin --profile desktop.`). The reason is that pnpm rewrites the profile's `node_modules`, and it is risky to let the app hold files inside it. Also, the "reject desktop" rule **only applies to a `dsh` installed separately from npm**: the test in the CLI is `if (!manageDesktopProfile) rejectElectronProfile(...)`, while the app's own launcher (`dsh.cmd` → `dsh-desktop-host`) passes `manageDesktopProfile: true`, so it **can** manage desktop; a `dsh` installed separately from npm is refused at that step.

### For developers: run from a source checkout

Use this when you clone this repository and run the sources in your working tree directly (edits do not go through npm). **Append** a block to the end of the profile's `cordis.patch.yml`, pointing at your local entry with an **absolute** `file://` URL:

```yaml
- insert:
    - id: multitask
      name: 'file:///absolute/path/to/dsh-multitask/lib/index.js'
```

Two things to watch:

- **Spaces and `%` in the path must be percent-encoded** (common on Windows). The safe approach is to let a program encode it rather than writing it by hand — for example, in PowerShell: `(New-Object System.Uri('H:\my repo\dsh-multitask\lib\index.js')).AbsoluteUri` produces a form like `file:///H:/my%20repo/dsh-multitask/lib/index.js` that can be pasted straight into YAML.
- **`?v=N` is an optional cache key** (see "Making source edits take effect"). It only means anything in this `file://` mode.

Uninstalling is just deleting that whole block, then restarting the app.

**Adding this row needs no restart.** DSH's HMR service has a watcher installed on `cordis.patch.yml`, so changes are hot-reloaded. Once installed, the row can be seen in the plugin list with `fiberPhase: "active"`.

> ⚠️ **This no-restart exemption does not apply to "editing the sources".** When a row is added, that entry **has no fiber**, so the Loader goes through `await this.init()` and genuinely calls `import()`, which is why no restart is needed; but **bumping `?v=N` on an already-running entry after a source edit** only changes its `name`, and the Loader takes the name-only branch and **does not reload** — that case **requires a restart**. See "Making source edits take effect".

---

## Usage

When creating a **new session**, pick **"Multitask 减震器模式"** in the mode selector.

> A preset can only be chosen **before a session starts**. Switching after the session has started running reports `agent-preset/locked` — an existing DSH constraint (the tool surface and the prompt freeze on the first turn), not a limitation of this plugin.

---

## Usage: turning a request into a task brief

Once the mode is selected, just state your request as usual. The coordinator translates it into **self-contained** task briefs and dispatches them to subagents.

It is instructed to make every task brief carry these eight items:

1. **Goal** — one sentence, and the result can be judged done / not done
2. **Verified current state** — facts it already knows go in directly, so the subagent does not rediscover them
3. **Project conventions** — existing rules that must be followed
4. **Safety gate** — what must never be touched, declared highest priority
5. **Numbered tasks** — concrete steps, with exact commands or paths
6. **Conditional branches** — "if you find X do A, if Y do B", so it does not come back asking about things already known
7. **Stop conditions** — when to stop and report instead of guessing its way onward
8. **Report format** — what to send back: what was done, how it was verified, what is unfinished, which decision points are yours

Tasks that do not depend on one another are dispatched **in parallel**, and the coordinator keeps working while it waits.

---

## Tunables

Adjust them in the profile's patch layer; no need to touch this package's sources. Note that this row has the `insert:` shape, so its `config` has to be overridden **by id**:

```yaml
# <profile directory>/cordis.patch.yml
# append it after the dsh-multitask insert block (a later entry with the same id wins)
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

You can also switch the whole plugin off with `enabled: false` (no preset is declared, and the mode disappears from the selector).

### The Settings panel (this package's only client half: `lib/client.js`)

Once this package is installed, DSH's **Settings** gains one top-level page, **Multitask** (the browser-side bundle is `lib/client.js`, declared by `package.json`'s `dsh.client`), plus two rows under **General**. They gather the tunables above that are **genuinely worth changing by hand** into one place, so you no longer have to edit the patch file:

**The "Multitask" page — two cards**

| Card | Field | Scope |
|---|---|---|
| Model used by Subagents | `multitask.subagentModels[]` (`subagentType` / `provider` / `model`) | the default model for each of the four worker kinds. With "use one model for every Subagent" set to **yes**, all four are written as one route; with **no**, each kind is set separately, and "inherit coordinator" is the default option |
| Subagent parallelism limit | `subagent.maxActiveSubagents` | **the same value** as the row in Settings → General — both UIs edit the same field, so changing one immediately changes the other. It decides **how many subagents can be live at once under one main Agent**, applies to every mode, and Multitask is no exception. Takes effect **immediately** |

**The "General" page — two rows** (alongside the built-in language / appearance / developer-tools rows)

| Row | Field | Scope |
|---|---|---|
| Maximum recursion depth | `subagent.maxDepth` | **host level**: applies to every mode, not just Multitask |
| Subagent parallelism limit | `subagent.maxActiveSubagents` | same; **and it is the same value as the card on the Multitask page** |

> "Maximum recursion depth" sits under **General** rather than on this plugin's own page because it is **host level** and applies to every mode — putting it on the Multitask page would make people think it only affects Multitask. That slot is the official seat for "a preference that needs no page of its own and takes only one row" (`settings.general.item`, which the built-in rows use for language / appearance / developer tools). The two rows are drawn in the official row style (title and description on the left, control on the right, a 0.5px divider at the bottom, 16px above and below, **no card around it**), so no seam is visible when they sit side by side.
>
> ⚠️ **"Subagent parallelism limit" appears in two places at once, deliberately**: it takes one row under **General** (alongside the built-in run limits), and one card on the **Multitask** page as well (because it is the number this mode is tuned most often). Both places edit **the same field**, share one form snapshot and one write path — so there is no "which one wins" question, and no sync code is needed.
>
> **Save** submits the **only** field in the `multitask` namespace (`subagentModels[]`), so that save bar **serves the model card alone**: the parallelism limit is **written on change** (it commits when you release the control; there is no save button). That is the opposite of an approach that lies — make an instant-apply row wait for a save button and the user concludes their change has not landed, when it took effect long ago.
>
> The model card's **shape is never persisted**; it is derived from the field itself: the shape of "use one model for every Subagent" is derived from `subagentModels[]` — all four kinds pointing at one route means "yes", anything else "no". Switching the shape creates no dirty state in itself (Save stays greyed out when there is no value to write) and never silently changes other settings on the switch. **"Cannot be set to 0" is guaranteed by the UI layer and the host side together**: the number box has a floor of 1, and should an illegal value get past the UI (a hand-edited YAML, say), the host side **converges it to 1** as well, never treating it as "unlimited".

> Why register as `settings.section` (a top-level page in the Settings navigation) rather than `plugins.item` (the sub-slot on the sidebar **Plugins** page): by official design the latter is for "configuring official plugins on the plugins page", whereas the requirement here is "in Settings, and findable by a new user". The reasoning and the trade-off are written in the file header of `lib/client.js`.
>
> ⚠️ Editing `lib/client.js` is **a source edit** — per the "Making source edits take effect" section, it needs an **app restart**.

### What the coordinator keeps by default

**Kept**

- Read-only checks: `read` `grep` `glob` `file_info`
- Delegation: `subagent` `subagent_ptc` `subagent_minimal` `subagent_fork`
- Subagent control: `send_message` `interrupt_agent` `list_agents`
- Result retrieval: `job_list` `job_output` `job_kill`
- Orchestration: `workflow`
- Interaction and self-management: `ask_user_question` `todo_write` `create_goal` `get_goal` `update_goal` `exit_plan_mode` `present` `skill`

**Removed** (everything that writes, executes, searches or manages)

`write` `edit` `pwsh` `bash` · `web_search` `web_fetch` `read_image` · `ssh_*` · task board read and write · `plugin_manager` · `cordis_inspect_*` · `load_workspace_dependencies` · `task_board_*`

> The keep set is an **allowlist**, and `deny = visible set − keep set` is computed dynamically every time. So any tool the host adds later is **withheld from the coordinator by default**, with no change needed in this package. To enable one, add a line to `keep`.

#### Including `file_info`: a read-only file-metadata tool

This package ships its own read-only tool `file_info` (`presets/multitask/file-info.mjs`, zero imports). It fills a real gap (codename **D5**): `read` returns contents and a line count but **not a byte count**, and `glob` / `grep` return matches — so a check like "how big are these files together" **needs a shell**, and the coordinator has precisely **no** shell (this package removed it). `file_info` takes a set of paths, goes through `ctx.fs.resolve()` + `ctx.fs.stat()` (the **same** sandbox-fenced seam `read` uses, only without reading contents or writing anything), and reports each entry's byte count and the **total byte count** in one call. When a size is unknown it says so explicitly and the `sizeBytes` key is **absent entirely** (not `0`); missing / unreadable / directory are each their own class, and never pass themselves off as a 0-byte file.

It is **not** gated by the multi-mode switch (`DSH_MULTITASK_MULTI_MODE`) — that switch governs the worker trio, and D5's hole exists in single mode just the same. The name is now in **two** allowlists: the coordinator's `DEFAULT_KEEP` and the minimal worker's `DEFAULT_MINIMAL_KEEP` (both allowlists are **closed by default**; a missing line raises no error, it only hides the tool from that role).

> ⚠️ The above is a **mechanism fact** (both the source and the allowlists are in place). Whether it is really registered in a live deployment, and whether the coordinator and the minimal worker can really see it, has to be checked after installation — that is the user's verification step, not something this package can confirm for you.

### Subagent models: you pick one per worker type in the Settings panel

**By default a subagent inherits the coordinator's model**. To give one worker kind a different model, set it per type on the model card of the Settings **Multitask** page (`subagent` / `subagent_fork` / `subagent_ptc` / `subagent_minimal`, one row each); the plugin translates it into that delegation row's `agentOptions`.

> ⚠️ **AI cannot assign models on the fly.** This package **deliberately leaves off** the host's `modelSelectionSettings` switch (which would expose the `provider` / `model` / `reasoning_effort` fields and `list_subagent_models` on the delegation tools, letting **the coordinator pick a model inside a given call**). The reason is that the two paths fight each other: this package wants "the model is set by the user, per kind", while that switch gives "the model is improvised by the AI in the session". So all four delegation tools **leave it unset**.
>
> One side benefit: that switch makes the delegation tools **installed per agent**, and therefore **structurally un-narrowable** — left unset, the four delegation tools go back to global registration, and the read-only worker's narrowing logic applies to them normally.

### Delegation depth

Fixed at **1**: coordinator → worker. A worker cannot delegate further. That keeps tasks from spreading without limit, and context layers from getting out of hand.

There are **4 delegation rows**: `subagent` (spawn), `subagent_fork` (fork), plus `subagent_ptc` and `subagent_minimal` (the last two are covered in the next section). **All four declare `maxDepth: 1`**.

All four in-process delegation rows **declare** `maxDepth: 1` explicitly. Delegating further at depth 2 is hard-refused (`subagent depth 2 exceeds maxDepth 1`), and the refusal happens before startup. Writing the field out is a **readability** choice; it carries no safety duty.

> Residual boundary: all that can be confirmed is "effective cap = 1"; there is **no way to tell** whether that cap comes from the field declared on the row, from a default inherited by omission, or from a shared cap-enforcement layer. This residual boundary applies to all four rows equally.

To loosen it, change `maxDepth` on the `tool-subagent` row in `presets/multitask/composition.mjs`.

### Concurrent subagent limit

**There is only one value, and it is the host's `subagent.maxActiveSubagents`.** This plugin sets no cap of its own.

It appears in **two places** in Settings (the card in Settings → Multitask, and a row in Settings → General), but both edit **the same field**: change one and the other follows immediately. Takes effect **immediately**.

#### 8 is the host's **default**, not a ceiling

The host's `subagent.maxActiveSubagents` defaults to **8**, so **with no configuration at all, 8 is all you get**. When a single **parallel** fan-out exceeds that number, the extra delegations are dropped **before anything starts**, with this error, verbatim:

```
Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
```

It corresponds to the host `dsh-subagent`'s `ACTIVATION_LIMIT_REACHED` (thrown from `ActivationPool.reserve()` when there are not enough slots).

⚠️ **But 8 is not the upper bound, only a default nobody has changed** (the upper bound is a safe integer). **Whatever you write is the limit** — and since what you set **is** the host's field, there is no such thing as "another layer cutting you off":

| How many you want to run | What to do |
|---|---|
| N | set "Subagent parallelism limit" to `N` (in either of the two Settings locations, or give `- id: subagent` a `config: maxActiveSubagents: N` in the profile) |

> **To tell parallel from serial, look at how many subagents are in `[running]` at one instant, not at how many you dispatched in total.** Serial execution runs one at a time and dispatches the next only after the previous ends, so the live count never exceeded 1 — and therefore "I dispatched 10 and they all succeeded" does **not** prove the limit was widened: only a fan-out **inside a single message** actually competes for slots, and no amount of serial work hits the ceiling.

#### What counts: **every live subagent**, not just the current batch

The limit counts "the total subagents **currently live** under one main Agent". A worker that has finished its brief but **has not exited** **still occupies a slot**. So "dispatch a batch → let them all finish → dispatch the next batch" is the safe pattern; dispatching while a batch is still finishing hits the ceiling early, per the remaining live count.

#### ⚠️ The rejection comes from **the host**, not from this plugin

Because there is only one enforcement point, hitting the limit shows you that **English** error above (`active child limit: <N>`), not any wording from this plugin. **This is not a fault**, and **this plugin is not broken**:

- it happens **before anything starts** — no subagent is created, and you get a plain error rather than an id;
- the fix is to **wait for the existing subagents to finish**, or **merge several tasks into one task brief** and hand it to a single subagent;
- retrying the same fan-out unchanged only hits it again.

---

## Multi-mode subagents: pick a worker by task type

The "shock absorber" above settles **the coordinator must not do the work itself**. This section settles the other half: **which kind of worker to send out**.

### Three kinds of worker, three tool surfaces

| Delegation tool | Tool surface | Best for |
|---|---|---|
| `subagent` | **full**: write files, run commands, build, search… | the default. Writing code, running tests, editing files, execution work |
| `subagent_ptc` | **PTC collapse**: only `run_code` is directly callable; everything else is reached from inside a program through the generated SDK | programmatic bulk work: filtering/aggregating/moving huge data sets, the same operation over many items, intermediate data that must not enter the context |
| `subagent_minimal` | **read-only**: `write` / `edit` / `pwsh` removed (win32) | read-only investigation, quick answers, fact-checking, reading code to answer a question |

`subagent_fork` is not on this axis: what distinguishes it is **inheriting this conversation's context**, orthogonal to the tool surface, so it has no corresponding third tool-surface variant.

> The "best for" column above is a **mechanism fact**; the guidance for **picking a worker by task** lives in the coordinator persona (`COORDINATOR_PERSONA` in `composition.mjs`, section `## Choosing which worker to delegate to`), and the criterion is the **shape of the task**, not its subject.
>
> ⚠️ **The persona deliberately contains no default fallback like "when unsure, use `subagent`".** Such a default answer is an **instruction**, and every time the model is unsure it pushes it onto the widest path, cancelling out the whole "pick by shape" passage.
>
> What replaces it is "answer which one fits better, every time", not a default answer. Tests pin it from both directions: positively pinning the four criteria of "pick by shape", negatively pinning that the default fallback must not come back, and folding the same sentence from both READMEs into the test too — the persona and the READMEs must change together, or readers write briefs around that default fallback.

### How the mechanism works

The two multi-mode paths run on **two entirely different mechanisms**:

- **`subagent_minimal` — this package's adaptive narrowing (`minimal-guard.mjs`).** At `agent/created` it narrows by `deny = visible set − allowed set`; every name on the list necessarily exists in that scope's actual visible surface, so it cannot throw; write-class tools other plugins registered (typically `ssh_exec` in `ssh_*`, `task_board_run` in `task_board_*`) are removed as well, without having to know their names in advance. The persona says read-only, and the mechanism makes it read-only too.

   > ⚠️ **Only this one narrowing layer exists here.** A static list can only name a few tools known to exist; this layer covers a wider surface, but **the failure consequence differs**: if this module fails to install there is no fallback, and the minimal worker is not narrowed at all. So its failure is always a **loud warning**, carrying `MINIMAL-NARROW-SKIPPED reason=…`.

- **`subagent_ptc` — `presentAs('ptc')` (this package's plugin `subagent-mode.mjs`).** PTC is not "filtering some tools out", it is **swapping the presentation**: the whole tool surface collapses to "only `run_code` is directly callable", and every other capability tool is reached from inside a program through the generated SDK. That capability **cannot be simulated by tool filtering** (`run_code` is a reserved transport name, and `tools.restrict()` refuses it outright), so a plugin has to implement it.

For the coordinator to see these two multi-mode tool names, the `keep` passed to the shock-absorber row in the composition is what does it (the keep set is an **allowlist**, `deny = visible set − keep set`; a new tool not written in is invisible to the coordinator by default).

### The observable marker of PTC collapse (**a fixed, greppable string**)

PTC collapse **degrades silently when it cannot install** (the worker keeps its native tool surface and still gets work done), and its warning goes through `warnOnce` — **once per reason per process** — so "was it skipped again at some point" cannot be judged by counting log lines. Every failure path and the success path carry a **verbatim fixed ASCII marker** sharing the `PTC-COLLAPSE-` prefix, so one grep shows the skipped ones and the engaged one at the same time:

| Marker | Level | Meaning |
|---|---|---|
| `PTC-COLLAPSE-SKIPPED reason=no-runtime` | warn (deduped) + info (count) | this deployment has no `ptcRuntime` service |
| `PTC-COLLAPSE-SKIPPED reason=no-present-as` | same | this scope has no `tools.presentAs()` |
| `PTC-COLLAPSE-SKIPPED reason=present-as-threw` | same | the declaration was refused (usually because a different presentation was already declared) |
| `PTC-COLLAPSE-SKIPPED … count=N` | info | each skip also writes a separate line **with the running count** |
| `PTC-COLLAPSE-ENGAGED` | info | the collapse **actually engaged** |

> **The success path leaves a marker too**: otherwise success can only be inferred from "the failure marker did not appear", and that criterion does not hold for "the whole block never ran".

⚠️ **In normal operation there is no readable host log** (host stdout goes straight to Electron, stderr keeps only 64 KiB in memory), so these strings are a criterion for **whoever can capture the process output** (or for whenever logging is wired in later); ordinary users need not go hunting for logs.

### How code outside the subagent reads the mode marker

To answer "which row did the just-created subagent come from", the plugin reads the `provider` field of `subagent/descriptor`.

In `dsh-tool-subagent`'s Config, the fields that can distinguish one delegation row are provider / toolName / modelSelectionSettings / agentOptions / agentPreset / allowedAgentPresets / maxDepth. Of these only `provider` meets three conditions at once:

1. it is decided by the **delegation row** (not a parameter the model passes);
2. it is written verbatim into `subagent/descriptor` (`data.provider`), and is therefore readable in the `agent/created` window;
3. one implementation can register several names, so each worker kind takes one.

The four delegation rows therefore each bind one provider name: `spawn` / `fork` / `multitask_ptc` / `multitask_minimal`. The first two use the host's built-ins (the main path takes no risk of an extra registration failing); the last two are registered by this package on the **host plane** (`lib/worker-providers.js`). If that registration fails, those two tools **simply do not appear**, and the mode degrades to "only two delegation paths" instead of throwing.

`toolName` also varies per row, but it **does not land in the subagent session** (the descriptor does not carry it), so it cannot serve as the marker.

**Why the `persona` marker cannot be read:** upstream removed the `persona` and `toolFilter` config options; their presence in config throws:

```
tool-subagent: persona is no longer supported; configure persona and tool plugins
in an Agent Preset and select it with agentPreset (spawn only)
```

**The consequence is not "the persona does not take effect" but that the entire preset fails to mount** — the mode disappears from the new-session list entirely. `provider` is the only site left: reading it takes one step, relies on no undocumented structure, and **foreground and background dispatch make no difference to coverage** (the descriptor is appended in `setup()`, and `agent/created` is necessarily later than that).

**How the persona is delivered:** `worker-persona.mjs` registers it onto the subagent's own scope in the `agent/created` window, keyed by provider name (the same segment name `deployment:persona-prefix`, scope layering rules unchanged, and it still shadows the coordinator's copy). The persona text arrives through `config.personas` from the composition, not through an import — a relative import does not inherit the entry's `?v=N` query, so an edited text would come back stale from an old cache without any error.

**Older-session compatibility:** sessions created by earlier versions carry a generic provider name in the descriptor, without `multitask_ptc` / `multitask_minimal`; those sessions keep `[multitask-mode:ptc]` / `[multitask-mode:minimal]` markers in the persona. Both guards therefore keep a **read-only** fallback path that reads the old marker: when `provider` yields no verdict, they fall back to the persona marker, so resuming such a session does not lose the narrowing / collapse.

> **These two provider names are exclusive.** Once `multitask_ptc` / `multitask_minimal` is read, it is that subagent's final identity, and a leftover old marker cannot overturn it. Without that rule, a PTC worker whose descriptor carried the old minimal marker would be narrowed as a read-only worker — shaving its tool surface down, entirely silently. The L3 case in `test/subagent-mode-marker-source.mjs` pins exactly this.

### How to turn it off

Three levels of switch, all on by default; **turning off any level leaves `subagent` / `subagent_fork` unaffected**:

1. **Environment variable** — disables both multi-mode rows and the presentation plugin at once:

   ```powershell
   $env:DSH_MULTITASK_MULTI_MODE = '0'   # needs an app restart (read at module load)
   ```

   The reason for an environment variable rather than a config field: a profile patch can only override rows that **already exist** in the roster, by id, and cannot reach these rows inside the preset declaration.

2. **Delete the rows, or disable them** — edit `presets/multitask/composition.mjs` and add `disabled: true` to `tool-subagent-ptc` / `tool-subagent-minimal`. Source edits **require an app restart** to reload; by convention also bump the `?v=N` in the profile patch (bumping alone without a restart **does nothing** — see "Making source edits take effect").

3. **Turn off only the PTC presentation, keep the `subagent_ptc` tool** — set `config.enabled` to `false` on the `subagent-mode` row. With it off, `subagent_ptc` still works; it just degrades to the same native tool surface as `subagent`.

### ⚠️ For future maintainers: changing the minimal allowed set is dangerous

`tools.restrict()` **throws** on a tool name that **does not exist in the current deployment**:

```
tools.restrict() names unknown global tool "x"; known global tools: …
```

That is exactly why `minimal-guard.mjs` uses `deny = visible set − allowed set` rather than a static deny list: the names on the list are taken from the **visible surface just read**, so they are necessarily valid, and that error path is never reached.

> **`DEFAULT_MINIMAL_KEEP` is the allowed set (an allowlist).** Listing an extra name this deployment does not have is **safe** (it is not in the visible set and drops out of the difference), but **leaving one out** that should be kept removes it.

**`run_code` must not appear in `deny`** (reserved transport name, `restrict()` refuses it); the code holds that case in `CATALOG_EXEMPT`.

### Known boundaries and unconfirmed items

Listed honestly, so an inference is not passed off as a conclusion:

- **"PTC's actual gain in reasoning quality" is a design hypothesis still awaiting verification.** Different tool surfaces may affect reasoning performance; this package only builds the mechanism. Deciding whether it holds needs real tasks comparing `subagent` against `subagent_ptc`.
- **Whether `agent/created` is strictly earlier than the subagent's first prompt assembly: the source inference holds, end-to-end verification is missing.** `coordinator-guard` depends on the same timing, and its failure posture is an explicit warning; the PTC presentation path has no end-to-end verification and degrades silently when it fails.
- **The PTC presentation chain needs one real session to confirm.** What can be verified in-process: the module loads with zero dependencies, and the logic is correct on a stand-in ctx (the criteria include "the coordinator never collapses" and "no runtime means a silent skip"). **Whether a real subagent actually collapses to `run_code` can only be checked on an installed build.**
- **Whether a PTC runtime exists can only be decided at runtime.** The plugin probes with `ctx.get('ptcRuntime')`; when missing it **skips silently** and warns (the worker keeps its native tool surface and still gets work done). If the log shows `a subagent was configured for "ptc" presentation, but this deployment has no "ptcRuntime" service`, that is this case.
- **Under pure PTC a subagent cannot call `write` / `pwsh` directly**, only through SDK calls inside `run_code`. That is PTC's semantics itself (advertised surface = callable surface), **not a defect**; calling directly yields `Error: unknown tool "<name>": only run_code is callable directly — call <name> from inside a run_code program instead` (verbatim: lowercase `unknown tool`).
- **`subagent_minimal`'s read-only-ness is "one adaptive narrowing layer", and still not a sandbox.** `minimal-guard.mjs` narrows at `agent/created` by `deny = visible set − allowed set`, covering `write` / `edit` / `pwsh` and tools **registered by other plugins** such as `ssh_*` / `task_board_*`. It has **no second fallback layer**: the static `toolFilter` layer no longer exists, so when this module fails to install the minimal worker is not narrowed at all (it warns loudly). **It is not a sandbox after all**: if some plugin registers a new mutating tool **after** the minimal worker is created, that tool **is not removed** (a deliberate trade-off, see "Boundaries stated honestly" in the `minimal-guard.mjs` file header).
- **Part of the full-surface worker's baseline noise is pure waste, and `worker-guard.mjs` removes exactly that.** Delegation depth is fixed at 1, so a worker dispatching further is always refused (verbatim `Error: subagent depth 2 exceeds maxDepth 1`), but the refusal happens **after the call**. Until then the full schema of the 5 delegation tools sits in the worker's catalog and is re-sent with **every request**. Empirical data: about four fifths of workers carry these 5 unusable delegation tools in their catalog, **6,266 characters** in total, **11.9%** of a full-surface worker's baseline noise (52,445 characters); at the same time **184** `depth 2 exceeds maxDepth 1` refusals were observed — they really are unusable. This module sends `denylist ∩ visible set` as deny, **losing no capability** (the criterion is "the call is bound to be refused", not "it looks useless": `interrupt_agent` / `send_message` / `list_agents` are deliberately **not** removed). Its failure posture is the **opposite** of minimal-guard's — the worst case is that block of schema keeps being re-sent, with nothing lost functionally, so it degrades silently and logs a single warning.

  ⚠️ **It works on PTC as well, and that is the most profitable path of all.** Compared with a full-surface worker it saves **6,303 characters ≈10.3%** — the two differ only in those 5 delegation tools; the rest of the roster is identical. The mechanism: PTC's SDK documentation is generated by `sdkSchemas(scope)`, which reads `view(scope).visible`; `restrict()` hangs the restriction on that agent's own layer, and `chainLayers()` reads that layer. So `presentAs('ptc')` collapse does not save it (collapse only changes "can this be called directly") — **`restrict()` is what saves it**.

---

## What delegation overhead is made of (measured)

`request/header` is the fixed baseline re-sent on **every request**; taking the first header per agent type, it breaks down as follows:

| Type | Tools | tools chars | system chars | Total |
|---|---|---|---|---|
| `subagent_minimal` | 10 | 5,719 | 7,870 | 13,589 |
| `subagent` / `subagent_fork` (full surface) | 50 | ~42,600 | ~9,700 | ~52,300 |
| `subagent_ptc` (collapsed) | **1** | 2,496 | **61,057** | **63,553** |

**Collapsing makes PTC the most expensive of the four**: its `tools` really does drop to 1 item, but `system` gains a section `## Writing code for run_code` that alone takes **49,551 characters / 885 lines** (the persona body itself is only 10,049 characters). Which is to say `presentAs('ptc')` changes "can it be called"; it does **not** change "does it have to be read". Among the four, `subagent_minimal` is the cheapest, which is the quantifiable reason it deserves to be the default for pure read tasks.

Where a full-surface worker's schema comes from (55 samples, 52,445 characters total):

| Source | Tools | Chars | Share |
|---|---|---|---|
| plugin `task_board_*` | 17 | 20,244 | 38.6% |
| built-in core | 20 | 17,991 | 34.3% |
| delegation tools (removed by `worker-guard`) | 5 | 6,266 | 11.9% |
| plugin `ssh_*` | 6 | 4,039 | 7.7% |
| goal tracking / subagent control / plan mode | 7 | 3,905 | 7.4% |

> **Baseline noise does not accumulate; it is "turns × a constant".** The median per-step context increment for the same worker is about 1,278 tokens, so the payoff of cutting baseline noise grows with the number of turns — and the feeling that "sessions got bigger" comes more from turns than from individual messages.

### ⚠️ **Do not touch** those two plugin tools (the user has decided)

In the table above `task_board_*` (17) and `ssh_*` (6) together make up **46%** of the schema, the block most worth cutting. **The conclusion is not to cut it — that is the user's decision, not an oversight.** The reasoning:

- **They are provided by other plugins, and the config belongs to that plugin.** Flipping the `web-ui-ssh` row to `disabled: true` in the main config **disables the whole plugin row, not just removes tools**: that plugin's own UI and features disappear with it. Tools are appearance, a plugin is capability; the two are not the same thing.
- **`task_board` is not zero-call.** A full scan (816 sessions, no mode excluded) recorded 23 calls, concentrated in 1 session — it is "occasionally in use", and cutting it would lose real functionality.
- **`ssh` really is zero-config, zero-call** (`~/.dsh/dsh-ssh.json` does not exist; across the 6 `ssh_*`, `ssh_list` has 6 calls and `ssh_exec` 1), but same as the previous point: turning it off costs the entire plugin, and buys back 4,039 characters per request. The user judged it not worth it.

**Only the tools this plugin itself registers can be touched.** `worker-guard` does that step: it removes the 5 delegation tools (6,266 characters), which also applies to PTC's SDK documentation, saving 6,303 characters.

> This boundary matters more than the numbers: **whoever registered a tool is the only one entitled to narrow it**. Reaching into another plugin to pull tools looks like saving tokens; in practice it is dismantling someone's feature skeleton.

---

## Approving dangerous subagent operations with a popup (`approval-gate.mjs`)

**What it is**: put a "dangerous operations must ask a human" gate back in front of delegated subagents, with the card shown in the **parent session** through the host's existing approval panel.

### The problem it solves

In Multitask mode **all the actual work is done by subagents**, and inside the delegation window `dsh-subagent` **pins the sub-session's approval policy to `never`** (upstream comment, verbatim: `policy is pinned to 'never' regardless of the parent's own policy.`). Both levels then fail, and **the user never receives the subagent's approval requests**:

1. The **first line** of the approval service's `decide()` is `if (effectivePolicy(session) === 'never') return 'rejected'` — before the waterfall dispatch, so the Web-side approval responder is never even called;
2. The subagent's system prompt also carries `operations that require approval are rejected automatically`, so the model **self-censors** and does not even issue the request.

This module handles both, forming a **two-stage gate**:

| Stage | What it does | Where it lives |
|---|---|---|
| Stage one | Safe commands run directly, **the user is not bothered** | This module's deterministic rule table (`tools/pre-execute`) |
| Stage two | Dangerous commands raise a popup, the user approves / rejects | This module's relay (`approval/request`) + **the upstream approval panel as-is** |

### Why not build a new approval UI (this decision drives the whole design)

The approval panel hangs off `conversation.composer`, and it renders only for **the session currently being displayed**:

```js
const pendingInteraction = useSessionStatus((snapshot) =>
  sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
```

Subagent sessions are **hidden** from the sidebar (`if (session.origin === "subagent") return false`), and the parent row does **not aggregate** a sub-session's pending state. So "let the sub-session pop its own dialog" does not hold up on either the backend or the frontend — unless the user happens to have that sub-session open.

The module therefore **relays**: the subagent's request is rewritten into one approval request **aimed at the parent session**, so it lands in the main conversation and is shown by the upstream panel as-is. **No new UI, no touching the sandbox, no touching DSH source.**

### The three actions (and the ground each one stands on)

**① Loosen the policy (B).** On `agent/created`, append `approval/policy = 'ask'` to the sub-session.

It stands on two upstream facts, both verified line by line:

- `overrideOf(session)` scans the log **in reverse** and returns on first hit ⇒ **the later write wins**;
- `agent/created` **necessarily fires after** the delegation pin — upstream `initializeAgent` does **first `await setup()`, then `publish()`**, and the pin happens inside `setup`. There is no race window in the ordering.

⚠️ The write **omits the `source` field**. The reason has nothing to do with validation: at runtime `source` is **not validated at all** (the only check is the vocabulary `policy ∈ ["ask","never"]`); `'delegation'` was only a value constraint from the v0/v1 migration era, the current session format is v4, and carrying it there neither throws nor means anything. The real reason to omit it is **semantics**: `source: 'delegation'` means "this value was inherited from the parent delegation", while what this module does is exactly the opposite — it **corrects** the delegation pin (the parent wrote `never`, this writes `ask`), so carrying it would say the reverse of the truth.

**This write survives a restart**, no recovery path needed. Load time only drops "the last **incomplete** record with no trailing newline" (torn tail), regardless of whether the event sat inside a turn; and `approval/policy` is **not** subject to any turn-containment check (only `approval/asked` / `approval/decided` require turn membership). The observable criterion is the log sequence: the host's pinned `{"policy":"never","source":"delegation"}` immediately followed by this plugin's `{"policy":"ask"}`, both landing before the first `turn/start`.

⚠️ This write **does land in the session log** — that is the only place `overrideOf` can read (the policy cannot be written to the session header, that throws `session header uses retired policy baseline fields`).

The reason for **not** calling upstream's `setPolicy(agent, 'ask')` is that it injects `The approval policy changed from "never" to "ask" (changed by the user).` — **the wording is false** (a plugin changed it, not the user), and that message lands in the session log and gets read by the model as user intent. How does the model learn the policy changed? **Upstream says so itself**: the runtime context it registers renders from the currently effective policy, so once the policy changes, the next assembly automatically becomes `Approval policy: ask. …`.

**② Fix that misleading prompt.** Upstream registers the delegation context on **the subagent's own ctx layer**, and the text contains `operations that require approval are rejected automatically`. As long as that line is there, the model self-censors and never issues a call that needs approval — so stage two never sees a request.

There is **no** way to override it by "registering another context with the same name": a duplicate name in the same layer throws outright (`prompt context "…" is already registered in this scope`), and `context()` only does **cross-layer shadowing** (scoped shadows global) — this module's layer sits above the subagent layer, so registering a same-named entry there would simply be shadowed. The rewrite therefore goes through the `system-prompt/assemble` waterfall, replacing that entry in the **assembly result**.

The trigger is deliberately **content**, not just the name: it rewrites only when the text really does contain that sentence, otherwise it returns the input untouched and logs a warn with `reason=context-wording-changed` — when upstream changes the wording we **do not guess**; better to skip one rewrite than to write something false.

**③ Two-stage triage and relay.** See the next two sections.

### Stage one: deterministic rules, not Auto review

The official Auto preset is specified as `{ sandbox: 'danger-full-access', approval: 'ask' }` — **enabling it turns the file sandbox off** (upstream docs, verbatim: `Auto provides no file sandbox`), and every call costs one extra LLM request with no caching. That is tearing down a safety mechanism, not adding a gate.

So stage one is **deterministic pattern matching only**: no extra model requests, no sandbox changes, predictable behavior.

**It covers the category the sandbox cannot express** (that is this stage's real value):

| Category | Why the sandbox does not stop it |
|---|---|
| Destructive commands **inside** the workspace | The sandbox **allows** writes inside the workspace — `rm -rf .`, `git reset --hard`, `git clean -fd` all fall in this class |
| Non-file dangers | The sandbox does not express them at all: `git push --force`, `npm publish`, `curl \| bash`, `sudo`, changing the execution policy, killing processes, modifying scheduled tasks |
| Writes **outside** the workspace | The sandbox rejects them, but the rejection happens at execution time; this stage turns it into a question up front |

**It fails safe**: a missed pattern is exactly the same as having no such module (the command still runs under the sandbox), **nothing gets loosened**. So this stage can only **add** a question, it can never remove protection.

Conversely, **false positives are its real risk**: every pointless question nudges the user a little closer to "just click allow". The rule table is therefore maintained **in pairs**: there is a "must ask" list and a "must allow" list, and both run together whenever a regex changes. Deliberately silent examples: `git clean -nd` (dry run), `chmod +x`, `chown user:user f` (everyday), `net user` / `wmic process list` (read-only listing), `ls /`, `cat /etc/hosts` (read-only), **`icacls <path>` (with no change switch it only shows permissions)**.

> ⚠️ **The criterion for that last one is "is there a change switch".** `icacls` only counts as dangerous when **a change switch is present** (`/grant` `/deny` `/remove` `/setowner` `/reset` `/inheritance` `/g` `/p` …), while `takeown` is still always asked.

**It reaches inside PTC programs**: when the `run_code` bridge dispatches a child call it builds input carrying a `parent` token, and that path is `scheduler.prepare` → `prepareExecution` — the latter's first act is to run the `tools/pre-execute` waterfall. So `pwsh` / `write` issued through the SDK inside a PTC program **also** go through the rule table. The chain, segment by segment: the bridge builds input with `parent: exec.token` → `scheduler.prepare` → scheduler object → `prepareScheduledExecution` → `tools/pre-execute` waterfall.

⚠️ Two paths **bypass** review; this stage is not full coverage. Upstream's Auto docs separate those two classes from "inner tool calls" clearly, verbatim:

> The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.

Namely:

1. **The outer `run_code` transport itself** — it is the entry point of that PTC run, not an "inner call";
2. **Node effects reached directly inside a PTC program body** (`require('fs').writeFileSync`, `child_process.exec`, direct `fetch`, etc.) — they are not tool calls at all, the rule table has no chance to see them. **Only the sandbox layer remains there.**

Corroborating evidence: the official Auto guard cuts along exactly the same line — its first line lets "outer `run_code`" straight through (it skips when `exec.parent === void 0 && exec.name === RUN_CODE_NAME`), and only inner calls carrying a `parent` enter review. This module covers the same set.

One more, unrelated to auditing but easy to confuse: when `run_code` **itself** carries no `sandbox_permissions`, this module does not touch it; when it carries an escalation, it goes through the sandbox's own `approveEscalation` (it issues its own approval request, independent of this module).

### Stage two: escalate to the parent session

`approval/request` is a public waterfall, and the Web responder is a **forwarding** listener registered via `ctx.remote.$on('approval/request')`. This module registers with `{ prepend: true }` — that is **mandatory**: queued behind the forwarder, the request has already gone to the browser and the panel has already rendered for the (invisible) sub-session, and changing it then is too late.

With multi-level delegation (a subagent that delegated again), this module **walks to the root in one hop** (following `parentSession` upward, with an iteration cap against a malformed parent chain forming a cycle) instead of relaying level by level — the user is supposed to decide in the root session anyway.

**When the relay fails it falls back to the original path** (the parent session has no open turn right now, the parent session has ended, the service is missing…): hand it back downstream and let upstream handle it the old way, worst case a fail-closed `unavailable`, and log `MULTITASK-APPROVAL-RELAY-FAILED`. It **never** turns a rejection into an allow just because it could not relay.

### Gating: enabled only in interactive sessions (a red line)

The **parent session's** effective policy must be `ask`, otherwise this module **does not move a single character**: the subagent stays at `never`, **byte-for-byte identical** to running without this module. Headless / unattended deployments rely on `never` to guarantee "never get hung waiting for an answer that never comes"; this module never installs `ask` into such an environment.

Likewise, stage one also reads **the subagent's current effective policy**: when the policy is not `ask` it always allows and never returns `ask` — because returning `ask` then would only be judged `rejected` by the first line of `decide()`, and **would turn a command that would otherwise have run fine under the sandbox into a rejection**, worse than not asking.

### How to confirm it is working

Two observation channels; only the first one hits disk.

#### Evidence one: durable events (the only channel that survives a restart)

Every question from the gate leaves one `approval/asked` in the **session log**, and the user's answer leaves `approval/decided`. The `reason` prefixes of the three kinds of question differ, so **a single grep separates them**:

| What the `reason` of `approval/asked` starts with | Who is asking |
|---|---|
| `Multitask approval gate flagged a destructive shell command (…): …` | **Stage one**: the rule table judged it dangerous (or, for a write outside the workspace, `a write outside the workspace`) |
| `Multitask approval gate: a delegated Subagent (……) asked to run "…"` | **Stage two**: the subagent's request was relayed to the parent session |
| `Auto review denied tool "…": …` | **Auto-review (EXP)** denied it itself, this module was not involved |

`approval/decided`'s `outcome` is one of `allowed-once` / `rejected` / `cancelled` — there is no "always allow" tier.

⚠️ **`session.v4.jsonl.zstd` is multiple concatenated frames**, decompressing the whole file only decodes the first frame. Split the frames on the `0x28B52FFD` magic number and decompress frame by frame, otherwise you will see the illusion that "there is nothing in the log".

#### Evidence two: `MULTITASK-*` log tags (only for deployments that **ship logs to an aggregator**)

These tags go through `ctx.logger`; with no sink receiving them they **never hit disk**. Not being able to grep them in the session directory does not mean the gate is not in effect.

| Tag | Meaning |
|---|---|
| `MULTITASK-APPROVAL-GATE-ENGAGED` | One subagent's policy was loosened, the gate is in place |
| `MULTITASK-APPROVAL-GATE-SKIPPED reason=…` | Skipped (`reason=` says why: parent session is not ask / service missing / malformed payload…) |
| `MULTITASK-APPROVAL-ASK` | Stage one judged a call dangerous and is asking the user for consent |
| `MULTITASK-APPROVAL-YIELDED reason=auto-review` | Stepped aside for auto-review, this module no longer raises `ask` |
| `MULTITASK-APPROVAL-RELAYED` | Stage two relayed the subagent's request to the parent session (including the result) |
| `MULTITASK-APPROVAL-RELAY-FAILED reason=…` | The relay failed, fell back to the original path |
| `MULTITASK-APPROVAL-NOTIFY-SENT` | After a failed relay, best effort to deliver "a decision is waiting for you" to the parent session over the message channel |
| `MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=…` | No notification was sent, and why (`disabled-by-config` / `no-subagents-service` / `not-direct-parent` / `signal-aborted`) |
| `MULTITASK-APPROVAL-NOTIFY-FAILED` | The notification itself could not be sent (does not affect the approval outcome) |
| `MULTITASK-APPROVAL-RELAY-RETRY-RETRIED` | Retrying the relay after the notification woke the parent session **succeeded**, the user's decision was obtained (including outcome) |
| `MULTITASK-APPROVAL-RELAY-RETRY-WAITING` | Waiting for the parent session's turn to open (no need to wait when `reason=turn-already-open`) |
| `MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=…` | No retry, and why (`disabled-by-config` / `not-a-turn-boundary-failure` / `notice-not-delivered` / `turn-state-unreadable` / `signal-aborted` / `parent-not-interactive`) |
| `MULTITASK-APPROVAL-RELAY-RETRY-FAILED reason=…` | The retry did not succeed (`window-elapsed` / `retry-threw` / `no-approval-service`), fell back to the original path |

Both `MULTITASK-APPROVAL-GATE-SKIPPED` and `ENGAGED` increment a counter, so when N workers were dispatched and not a single one was loosened, the log shows "how many times it skipped, and why each time".

#### When auto-review steps aside

The result of stepping aside is **doing nothing**, so it only leaves **absence** evidence. Absence evidence is sufficient in this combination:

| Case | What durable events should show | What they should not show |
|---|---|---|
| EXP allows | **No** `approval/asked` at all for that call | No `Multitask approval gate flagged …` |
| EXP denies (policy `ask`) | One `Auto review denied tool …` (EXP's own), **followed by** one `Multitask approval gate: a delegated Subagent …` (this module's relay, with EXP's original text at the end of `reason`) | No `Multitask approval gate flagged …` (if it appears, this module asked a **second** time by the rule table, i.e. stepping aside failed) |
| EXP denies (policy `never`) | One `Auto review denied tool …`, with `approval/decided` = `rejected` | No stage-two `a delegated Subagent …` |

The key criterion is **the same command appears only once in `approval/asked`** — two entries mean this module asked a **second** time by the rule table, i.e. stepping aside failed.

### Boundaries: what this module does not provide

- **When the parent session is idle, relaying has to be covered by the "wake + retry" path alone, and that path has a window cap.** `approval.request` requires the parent session to have an open turn and throws otherwise. The "the turn happens to be closed" case **is not a random failure**: on a background dispatch the coordinator dispatches and stops waiting, the parent session's turn ends with it, and the subagent only starts moving afterwards — so it reproduces reliably on a share of requests. That precondition is now **explicitly** guaranteed by the persona and same-name shadowing (see "When the coordinator ends its turn"), no longer a host default. This module's handling: relay fails → send the notification (that notification wakes the idle parent session) → wait for a turn to open → retry once. So these cases are usually back on the normal path (an approval card appears in the main conversation) within **milliseconds**. Three boundaries remain: ① it waits only when **the notification actually landed** (nothing else will wake the parent session); ② it retries only on **the "no open turn" failure** (other failures do not improve on retry and can produce duplicate prompts); ③ the window defaults to 10 seconds (`config.relayRetryWindowMs`, `0` disables it), and on expiry it falls back to the original path and fail-closed.
- **The fallback notification is not an approval; only a successful retry means "approved".** After a failed relay, this module does its best to make a message from that subagent appear in the main conversation over the Agent message channel (`subagents.sendMessage`), stating **which child session it is, what it wants to run, where to answer**. That wording is deliberately **conditional** ("if an approval card appeared in this conversation, answer here; otherwise open that child session") — the retry may succeed or fail, so the text has to be true under both outcomes; and the message channel **carries no approval result**, so reading it as a go-ahead would bypass the gate. Two more boundaries: it works only for **continuable** workers (all four worker kinds in this mode are; `subagent_codex` / `subagent_claude_code` cannot send anything if they are external one-shot backends). Continuability is decided by **the provider's capability**: a provider implementing `prepareContinuable()` takes the in-process continuation path, and only then does `sendMessage` recognise it. This package's two own providers (`multitask_ptc` / `multitask_minimal`) and the built-in `spawn` / `fork` all implement it, so all four worker kinds meet this precondition. And `sendMessage` only recognises **direct** parent/child; multi-level delegation skips it (recorded as `not-direct-parent`).
- **When the retry does not succeed, the request stays pending; the fallback does not release it.** This is the most misunderstood point: once the host has handed the request to the browser, the client **unconditionally** materialises a scope for that (invisible) child session and holds the request, and the approval path has **no timeout whatsoever**, so that tool call blocks indefinitely. `run_code` is the exception (its budget **includes** the approval wait). What the fallback does is make the user **aware of and able to find** that request; actually releasing it takes the user approving/cancelling in that child session, or cancelling the whole turn. The logs tell the two apart: a successful retry is `-RELAY-RETRY-RETRIED` (a decision was obtained), a failure is `-RELAY-RETRY-FAILED reason=window-elapsed` (the user has to go into the child session).
- **The rule table is pattern matching and will miss new kinds of dangerous command.** So the real gate is Level 2; Level 1 only handles "the safe ones need not bother the user".
- **An upstream rewrite can make this module stop working**: it depends on several undocumented upstream details (`overrideOf` taking the last entry, the migration-period semantics of `source`, `agent/created` arriving after `setup`, how strict `sendMessage`'s authorisation is). The symptom is **the gate going inert** (behaviour as if this module were absent), **not** permissions being widened — because this module does nothing when the parent session is not `ask`, and every failure path is "hand it back downstream".
- **It does not change the sandbox.** An approved dangerous command still runs under that call's original sandbox mode; this module decides **whether to ask**, not **how much permission to grant**.

### Tunables (the `config` on this line)

**The profile patch cannot reach this line.** The host half (`applyGuardOverrides` in `lib/index.js`) applies only those top-level switches to the preset's internals, and only to the `coordinator-guard` row — so changing this row's switches means editing the `config` on the `approval-gate` row in `presets/multitask/composition.mjs`, then restarting the app.

| Field | Default | Effect |
|---|---|---|
| `classify` | `true` | Master switch for Level 1 (the rule table). `false` = dangerous commands are no longer stopped for a prompt; Level 2 relaying still runs |
| `relay` | `true` | Master switch for Level 2 (relaying). `false` = a subagent's request no longer reaches the main conversation |
| `relayRetryWindowMs` | `10000` | Cap, in milliseconds, on waiting for the parent session to open a turn when "the turn happens to be closed". `0` = retries off |
| `notifyOnRelayFailure` | `true` | The fallback notification when a relay fails. `false` turns it off (retries carry on) |
| `extraDangerPatterns` | `[]` | Additional dangerous patterns, each `{ id, re }` or a bare string / regex |
| `safePatterns` | `[]` | Additional pass-through patterns that "match and still do not prompt" |
| `shellTools` | `['pwsh', 'bash']` | Additional tool names whose command text has to be inspected |
| `fileTools` | `['write', 'edit']` | Additional write tools that can point `file_path` outside the workspace |
| `autoApproveTempRoots` | each platform's temp directory | "Scratch area" roots: writing here, or deleting **only** things here, does not prompt. Pass `[]` to turn this tier off |

**These fields do not all fail in the same direction; a few deserve spelling out separately:**

- `extraDangerPatterns` / `shellTools` / `fileTools` are **additive**, so they fail in the safe direction: a missing entry means that case goes unquestioned (equivalent to this module being absent), and **never** lets through anything it would otherwise have asked about.
- **`safePatterns` is subtractive, the opposite direction to `DANGER_PATTERNS`** — what it cancels is danger this module has **already** established. Hence it is **deliberately empty** by default: writing it wrong silently lets a dangerous command through, and "asked one time fewer" and "let one through" are indistinguishable in the logs (nothing asked, so there is no `MULTITASK-APPROVAL-ASK` to reconcile against). Adding to it requires evidence as strong as that behind the `DANGER_PATTERNS` entries, plus test cases on both sides run together.
- An illegal `relayRetryWindowMs` (negative, `NaN`, non-numeric) **falls back to the 10-second default** rather than being read as "no limit" — an unbounded wait would hang the subagent forever whenever the parent session never wakes, which is the one state this module must never create.
- A **misspelled name** in `shellTools` / `fileTools` **raises no error**; it silently fails to match (the command still runs under the sandbox). So the defaults list only the ones this composition actually registers — better to list too few.

### Why temp directories skip the prompt by default (`autoApproveTempRoots`)

This tier is on by default and is the only place where this module actively asks one time fewer, so both its reasoning and its boundaries need spelling out.

**Reason one: a temp directory is scratch paper, not a user asset.** DSH itself creates `dsh-subagent-*`, `dsh-acl-locks`, `dsh-spill-*` and other runtime directories under `%TEMP%`; a worker writing intermediate artefacts there, or clearing out its own temp directory, is part of the normal job. A popup for that only trains the user to click Allow with their eyes shut — which directly weakens the prompts that do matter. **Noise is part of safety too**: a gate that asks every time is no gate at all.

**Reason two: it changes no permission.** This tier affects only **whether to ask**; it does not change the sandbox, does not change the ACL, does not change DSH's judgement of the writable range. Where a write can land is still the sandbox's decision; this module merely stops bothering the user about a low-information action.

**Boundary one: the delete exemption is far stricter than the write one.** A write only checks "is the target under an allowed root"; a delete additionally requires that **the whole command** touch only allowed roots — no shell metacharacters (`;` `|` `&` `` ` `` `$` `>` `<`, plus `,` and newlines), at least one absolute path argument, **all** path arguments under the root, no `..` segment in any path, and no relative path arguments. All five, or it does not count:

| Command | Result | Why |
|---|---|---|
| `rm -rf /tmp/x` | no prompt | the only target is under an allowed root |
| `rm -rf /tmp/x /home/u` | **still prompts** | one path outside the root is mixed in — the exemption must not be borrowed |
| `rm -rf C:\Windows` | **still prompts** | outside the root |
| `rm -rf $env:TEMP\x` | **still prompts** | contains `$`, so the target cannot be decided statically |
| `Remove-Item -Recurse C:\Windows` | **still prompts** | outside the root |
| `Remove-Item -LiteralPath "/tmp/a","C:\Windows" -Recurse -Force` | **still prompts** | comma fusing: no space between the two paths |
| `rm -rf /tmp/../../../etc` | **still prompts** | the `..` segments walk the target out of the root; a lexical prefix comparison cannot catch that |
| `rm -rf /tmp/a ..` | **still prompts** | relative path argument; it deletes the working directory's parent |

The direction is deliberate: **one mistaken exemption lets a whole dangerous command line through, while one extra prompt is one click**.

**Boundary two: it genuinely lets a worker drop files into a shared directory silently.** `%TEMP%` is a directory every process shares and usually can write to, so strictly speaking this tier opens up "silently placing files in a shared location". Two grounds for judging that acceptable: ① this module was never a sandbox, and placing a file does not by itself execute anything; ② executing a script from a temp directory (`pwsh <temp>\x.ps1`) is not in any dangerous pattern to begin with — that is, turning this tier off would not stop that path either. Making "execute from a temp directory" supervised needs a new dangerous pattern, which is **a separate piece of work** (and first needs confirming it does not hit normal build-script invocations).

**To tighten it, pass `[]`**: that tier disappears at once, and even deleting a temp directory prompts again. To exempt some private cache directory as well, add it to the array (a dedicated build output directory, say).

### Quoted text vs. what will actually run

Level 1 **pattern-matches the command text**, and command text holds both "code that will run" and "strings that are only data". The two can look identical character for character:

```powershell
Get-ChildItem . | Select-String -Pattern 'log|sh'   # regex alternation inside single quotes, no pipeline
cat urls.txt | sh                                    # genuinely pipes the content into a shell
```

The `pipe-to-shell` pattern only recognises `|` followed by a shell name, so the first line is judged "pipe to shell" as well — a pure false positive. Its cost is not just one extra click on Allow: **every pointless prompt trains the user to click Allow with their eyes shut**, which weakens the prompts that land.

So the judgement runs in two passes:

1. For **text-shaped patterns** (`pipe-to-shell` / `pipe-to-iex` / `invoke-expression`), check each hit one by one: if the hit falls inside quotes and the token before the quote is a parameter name or cmdlet with **pure data/regex semantics** (`-Pattern` / `-match` / `-like` / `-eq` / `Select-String` …), skip that one hit;
2. **Every other** hit in the same command is still judged dangerous — one hit that is not a literal and the whole line is dangerous.

`-Command` / `-c` are deliberately **not** on the data-semantics list: their quoted content goes into the interpreter, and `pwsh -Command "cat x | sh"` is a real pipeline command.

⚠️ This exemption **applies only to text-shaped patterns**. Patterns where "the command itself is the action", such as `rm-recursive-force` / `remove-item-force`, must never be included — a quote exemption for them would strip protection from the whole class of `Remove-Item -LiteralPath '...'` commands.

### The approval card must show the real target

A command carrying `..` can be written very differently from where it actually lands:

```
Remove-Item -LiteralPath "<temp>\dsh-mt-rt\..\..\..\..\dsh-mt-shadow" -Recurse -Force
                                       actually points at %USERPROFILE%\dsh-mt-shadow
```

Showing only the literal text means the user clicks Allow **without seeing where it lands** — that is not informed consent, and the card has lost its reason to exist. So a Level-1 `ask` decision carries the collapsed path into both `reason` and `displayReason` (the decision itself still prompts on any `..`; collapsing is **display only**).

Collapsing is **purely lexical** (it only cancels `.` / `..` segments, resolves no symlinks, does not touch the filesystem): the card needs "the target the command text claims", not the current disk state. A path without `..` does not get this extra line, otherwise every ordinary path on the card would carry a sentence and the card would read worse.

---

## Correction ordering: a message appended to a subagent must take effect **immediately** (`interrupt-before-send.mjs`)

### The problem it solves

When the coordinator sees a subagent doing the wrong thing, its only lever is `send_message`. And the host's delivery semantics are **`steer` (delivery at a step boundary)**:

```
A working target receives the message at its nearest step boundary through Steer;
an inactive target starts or resumes a turn.
```

"The nearest step boundary" sounds fast; it is not: **one step can be a whole long tool call** (run a build, fetch a dependency, walk a directory tree recursively). And when a subagent is doing the wrong thing, what it is running is usually exactly that kind of long task. So:

1. the subagent carries on against a **wrong** requirement;
2. the coordinator sends a correction — it lands in the inbox / step-boundary queue;
3. the wrong requirement **runs to completion** first, and only then is the correction read;
4. by then the damage is done (the file edited wrong, the command finished, the artefact written broken).

**A correction's entire value is its timing**; a step late and nothing is left but cleanup. So sending is not enough — the current turn has to be stopped first.

### How it does it

It intercepts `send_message` on `tools/pre-execute` and calls `ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent })` once, **before the send actually happens**.

The interrupt is **synchronous**; it stops only the current turn and keeps the inbox (upstream, verbatim: `stops a child's current turn while keeping its inbox and descendants intact`). Not one character of the message changes — this module changes only its **timing**.

### Why intercept `send_message` instead of registering a new "correction" tool

A new tool's correctness rests on the model picking the right tool every time, and a model pushing for progress is exactly when it will not stop to tell "is this an addition or a correction" apart — which is precisely the moment it has just done the wrong thing. `send_message` has only one path; intercepting ahead of it **cannot** miss. That is this package's standing stance: **the persona states intent, the mechanism guarantees behaviour**.

### Interrupting is not the same as "the task was interrupted": it keeps far more than it removes

The interrupt goes through `keepInbox` and aborts only **the current turn**:

| Kept | Removed |
|---|---|
| every queued message in the inbox (`keepInbox`, upstream verbatim) | **the one action** in flight (a long command that has not finished, say) |
| the descendants it spawned (`descendants intact`) | that action's result never enters the context (it did not complete) |
| **all context already built up** — every fact already appended to the session log is still there (upstream: `every accepted fact is appended to the session log before the next step derives from it`); files read, commands run and conclusions drawn are not cleared | |

So the "right overall, details need adjusting" case not only loses nothing, it comes out ahead: redirecting it immediately with all its established state beats finishing the wrong details and redoing them. And **the new message may itself carry the critical information** (a constraint the user just added, a path just discovered, an approach just rejected) — which is exactly why it should not be made to finish first.

Conclusion: this module's stance is not "trade something for timeliness" but **a correction should take effect immediately; waiting buys nothing**.

To go back to the host's original semantics (queueing), set this row to `enabled: false`.

It deliberately offers **no** option to "decide by content whether to interrupt": that judgement can only come from the model declaring "mine is a correction", which is exactly where it goes wrong most easily. A rule that always holds is more reliable than one that needs a judgement.

### It only intercepts the coordinator → subagent direction

Hard precondition: the sender must not be a delegated subagent. A worker can message its parent session too (to report progress), and interrupting that direction as well would stop **the main conversation's own turn** — cutting off the answer the user is looking at. The test is the same one the other guards use (the three signals `origin` / `parentSession` / `delegationDepth`).

Even if that test were written wrong, `authority: { kind: 'ancestor' }` is rejected upstream in a non-ancestor direction, and the failure logs one info line without affecting the send — two layers of protection.

### Failure stance: degrade silently

A failed interrupt (service missing, target not one of its own descendants, id unreadable) **never** affects the send itself. Degrading "the correction arrives late" into "the correction was never sent" is exactly backwards. So any failure logs one info line with a fixed marker, and the send goes ahead as usual.

### How to confirm it is working

| What the persisted events should show | Meaning |
|---|---|
| `turn/end` with `data.reason.kind` equal to `aborted` and `reason.reason.kind` equal to **`parent`** | that turn was cancelled by its **parent** |
| a new turn opened immediately after (within milliseconds) and ending as `completed` | that is the turn that reads the correction — expected behaviour, not a failure |

**Interrupt latency** is measured from the parent session emitting `send_message` to the turn's `aborted`, and is on the order of milliseconds. **Do not** measure "sent the correction → received the final reply": after the interrupt the host opens a new turn to read the correction and **rebuilds the answer**, and that second generation is the subagent's writing time, unrelated to the interrupt.

Three easy ways to get the diagnosis wrong:

1. **`aborted` has two sources, and `reason.reason.kind` tells them apart**: `user` = the user pressed stop, `parent` = a parent cancelled. Only `parent` can be this module.
2. **But `parent` does not mean "this module did it"**: the coordinator can call the `interrupt_agent` tool directly to stop a subagent on purpose — most interrupts are of that kind. The test must **add a counter-check**: look in the parent session's log for a `tool/call` of `interrupt_agent`.
3. **Do not take "the last turn"**: the turn that was cut off is never the last one (the turn that reads the correction follows it). What you look for is **any** `parent`-type cancellation.

📌 **One side effect**: a `parent`-type interrupt also settles the worker's **unanswered approval requests** with it — the approval record's `outcome` is `cancelled` (neither `rejected` nor `allowed`), and what the user sees is "the card I was about to click vanished by itself". Semantically that is right (the turn is gone, nobody is left to receive the request).

(With log aggregation wired up, the markers are `MULTITASK-STEER-INTERRUPT-ENGAGED` / `-SKIPPED reason=…` / `-FAILED`; without a sink nothing is written to disk.)

---

## Cross-mode dispatch (`preset-dispatch.mjs`)

**What it is**: it widens the shock absorber's reach from **inside this preset** to the layer **between the user and every installed mode**.

### What it does

Registers one tool, `subagent_preset`. The coordinator uses it to hand a task brief to **any installed agent preset** (standard / ptc / minimal / cordis / any third-party mode installed from the plugin market) and gets back the conclusion only.

```
User ──► coordinator (shock absorber)──► any installed mode ──► conclusion back to the main conversation
```

### Why it picks by description instead of parsing the other side's internals

The criteria are only two **stable** things: the registry's `list()` (id / name / **description** / whether it is broken) and upstream's `startActivation({ request: { agentPreset } })`.

It deliberately does **not** parse another preset's plugin rows, does not guess its tool names, and does not read its `config`:

- Those are other people's implementation details, and any single upstream revision or plugin upgrade breaks this module along with them;
- The only **authoritative and stable** source for "what this mode is for" is the `description` it publishes itself;
- So a mode newly installed from the market **requires not one line changed in this package** — it becomes selectable by itself, which is exactly how "let the market complete the feature set" lands.

The `list: true` return also carries "whether it can come up right now": a mode tagged `CANNOT RUN` is broken and must not be chosen, so the caller re-dispatches on that basis instead of staring at an empty id.

### Three hard boundaries

1. **The provider is fixed to `spawn` and is not a config option.** Upstream's `assertCapabilities()` requires that a request carrying `agentPreset` be served by a provider that declares the `agentPreset` capability **and** does not inherit the parent session's context (`inheritsParentContext === false`). The built-in `spawn` satisfies that; `fork` does not. Making it a config option would only manufacture a class of failure that throws at the moment of delegation, with an error message that points at provider capabilities and has nothing to do with this module — so it is hard-coded.
2. **It cannot dispatch to this mode itself.** That would mint a "sub-coordinator", and the depth limit then stops it from delegating anything. The call is rejected outright, with the correct alternative named (the four built-in paths) — a flat refusal beats making the user wait on a delegation that is certain to fail.
3. **A worker cannot dispatch further.** Same criterion as the four worker types (`isDelegatedChild`, three signals). Not stopped at this layer, that call travels to `startActivation` before the depth limit refuses it, and the error reads `subagent depth 2 exceeds maxDepth 1` — nothing visible ties it to cross-mode dispatch, so it is easily misread as the feature being broken.

### ★ Boundary four: a cross-mode worker is not governed by this mode's guards (confirmed in source)

This one is not conjecture; it is read out of two places in upstream source, and it explains both "why it is safe" and "where it is not":

**① Events dispatch along the scope chain.** `dsh-agent`'s `agentCarrier(agent)` is exactly `scopeTarget(agent, agent)`, and `scopeTarget`'s filter admits only listeners like this:

```js
const tag = scopeOf(ctx)
if (tag === void 0) return true
for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true
```

That is, "the scope the subscriber sits in must be on this chain". `agent/created` and `agent/disposed` both go through it.

**② A subagent hangs off the target mode's scope.** The registry's `bind()` runs `bindScopeParent(childKey, generation.key)` for a subagent, where `generation.key` is the key of the **target preset** (`scopeOf(ctx)` as returned by `mountPreset`).

Put together: a cross-mode worker's scope chain is `[itself, target mode]` and **does not contain this mode**. Hence:

| This mode's guard | On a cross-mode worker |
|---|---|
| `worker-persona` (persona injection) | **does not apply** — which is just as well: it will not put "you have the full tool set" onto a read-only mode |
| `minimal-guard` (read-only narrowing) | **does not apply** — narrowing belongs to the target mode itself |
| `approval-gate` (two-level gate) | **does not apply** — see below |
| `subagent-mode` (PTC collapse) | **does not apply** — that one only ever recognised this mode's `multitask_ptc` |

**So it has to be said plainly: cross-mode dispatch is a capability router, not a security proxy.**

The consequence of the approval gate not covering it is concrete: upstream's `captureDelegatedPolicyOverrides()` pins a child session's approval policy to `'never'`, so a cross-mode worker's dangerous operations are **refused outright** (fail-closed, **never** silently allowed), but **no card is raised to ask you**. Work that needs this mode's two-level gate should still be dispatched down one of the four built-in paths.

### How it divides work with the four worker types

- The four worker types (`subagent` / `subagent_fork` / `subagent_ptc` / `subagent_minimal`) are **this mode's own** tool-surface split: within one and the same mode, who goes and does the work, and how many tools they can see;
- `subagent_preset` is **cross-mode** routing: this job is one another mode exists to do.

The two do not overlap and do not stand in for each other. The coordinator persona spells out this division, and "when unsure, ask the user — the modes are installed by the user, and they know why they installed them".

---

## Verifying that it actually works

Each of the three things has one observable criterion.

### The coordinator's tool surface

It should be able to read, not to write, and not to run commands:

| You say | Expected |
|---|---|
| "Just read package.json and tell me the version" | ✅ succeeds (read-only checks are kept) |
| "Run `git status` yourself" | ❌ cannot be called — the tool is not in its visible set |

A subagent can still do the work:

| You say | Expected |
|---|---|
| "Dispatch a subagent to run `git status` and bring me the conclusion" | ✅ the subagent runs it, and only the conclusion comes back |
| "Dispatch a subagent to read package.json and report the file name and size" | ✅ the read-only path is always available (`read` / `file_info`) |

If the second group fails (the subagent cannot run commands either), the shock absorber is **installed in the wrong place** — see "Design points".

> ⚠️ **First rule out one failure that has nothing to do with this package**: a subagent's shell may be refused wholesale at **the very start of the session** by a single permission write, and the symptom is that any command (even `Get-Location`) comes back `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<path>)`. That is a workspace ACL problem (see the `WRITE_OWNER` section under "Known boundaries"), not the shock absorber and not the command itself. **Read-only tools are unaffected**, so the last item in that group should still succeed.

Which tools were withheld is a fixed string in the log:

```
dsh-multitask: coordinator scope engaged — withheld N tool(s): edit, pwsh, read_image, ssh_exec, ...
```

### The approval gate (popup for dangerous operations)

**Precondition**: the current session's approval policy must be `ask` (the default for a new session; a headless deployment or a "never needs approval" configuration is `never`, and in that case this module **does not engage at all**).

| You say | Expected |
|---|---|
| "Dispatch a subagent to run `Get-ChildItem` and list the file names" | ✅ **no popup**, results come straight back (the first level judged it safe) |
| "Dispatch a subagent to delete the `.\build` directory (with `rm -rf`)" | 🔔 an **approval card pops up** at the main conversation's composer, its title stating which subagent wants to run what |

| Your action | Expected |
|---|---|
| Click **Reject** | ❌ the command **genuinely did not run**; the subagent's result is `the user rejected tool "..."` |
| Click **Allow once** | ✅ it runs successfully; sending the same call **again** raises the popup **again** (`allowed-once` is the only grant, there is no "always allow") |

The corresponding criteria in the persisted events:

| In the persisted events you should see | Meaning |
|---|---|
| one `approval/asked` whose `reason` starts with `Multitask approval gate flagged a destructive shell command (…): …` | the first level raised the card |
| then `approval/decided` with `outcome` `rejected` | rejected, the command did not run |
| then `approval/decided` with `outcome` `allowed-once` | approved this once; sending the same call again produces `approval/asked` **again** |

The criterion in the other direction: **when the parent session's policy is `never`**, no `Multitask approval gate …` should appear in `approval/asked` — which shows the red line (do not raise the gate in a headless environment) held. (On the log-aggregation side it corresponds to `MULTITASK-APPROVAL-GATE-SKIPPED reason=parent-not-interactive` and no `ENGAGED`.)

#### The fallback path (background dispatch / idle parent session)

The popup path requires that **the parent session has an open turn right now**; on a **background dispatch where the turn has already ended and you then wait for the callback** that does not hold, so the relay fails once, this module sends a notice to wake the parent session and **retries the relay** (see the first item under "Boundaries"). After a background dispatch of one dangerous command, the main conversation shows **one of three shapes**:

| What you see | Meaning |
|---|---|
| a structured **approval card** | the relay worked (the parent session happened to have an open turn), **or** the retry succeeded after waking it — both causes take this shape |
| a **message from that subagent** saying "a decision from you is waiting" and giving the child session id, **followed by** an approval card | the first relay failed, the notice went out, the retry succeeded. The message and the card are **the same thing**: the message is the wake-up mechanism, the card is where you answer |
| **only that message, no card** | the retry did not succeed (window exhausted, etc.) — this is a **notice, not an approval**; open that child session by the id in the message and answer there |

The criterion is **whether the card exists**, not "whether there was a message": a retry leaves **both** the message and the card, and the window defaults to 10 seconds, so wait for the window to close before looking again. Approving/rejecting **can only be done inside that child session**; the message channel does not carry the approval outcome. There should be exactly **one** `Multitask approval gate: a delegated Subagent …` in `approval/asked` — two of them means the retry caused a duplicate ask, and that is a defect.

#### Surviving a restart

A write to `approval/policy` survives a restart and needs no recovery path: load time discards only "the last **incomplete** record with no trailing newline" (torn tail), and that has nothing to do with whether the event was inside a turn; and `approval/policy` is not subject to any turn-containment check (only `approval/asked` / `approval/decided` require turn ownership). In the child session's log you should see the host's pinned `{"policy":"never","source":"delegation"}` immediately followed by a `{"policy":"ask"}` written by this plugin, both landing before the first `turn/start`; after a restart, a subagent in a new session should still be `ask`.

---

### How to verify the narrowing yourself

Dispatch one subagent from the coordinator and one from a worker, and have each report its own tool surface:

| | coordinator | worker |
|---|---|---|
| `pwsh` | ❌ not in the visible set | ✅ present |
| `write` / `edit` | ❌ | ✅ |
| `ssh_*` / `task_board_*` / `web_search` / `read_image` | ❌ | ✅ |
| actually running a command | cannot even make the call (the tool does not exist) | runs it and returns the result |

⚠️ **Do not take the worker's self-reported tool count as the criterion.** A worker reporting its own capabilities from memory comes out **too narrow**, and what it leaves out is often the one it just called successfully; one and the same report can say "Created file" and also say "I have no `write`". The criterion should be **what it actually called**, not the list it recites. Which is exactly why the **mechanism** (tool restriction) has to agree with the **prompt** — the persona says it cannot, the mechanism lets it, and the model will point that contradiction out in its own reasoning.

---

## Worker personas: why each worker type needs its own

A subagent joins **the parent's own preset**, so by default it **inherits the coordinator persona** — what gets installed is "you are a coordinator too, you cannot write files, you cannot run commands", while it in fact holds the full tool set.

A worker told "you cannot execute" will tend to refuse the work — and that is the only thing it was dispatched to do. So this is **not a question of whether the wording sounds nice; it materially weakens the whole mode**.

**The fix**: this bundle gives each worker type a persona of its own and declares the tool surface it holds. The individual copies **deliberately do not share one text** (the starting context and the tool surface both differ):

| Delegation row | provider name | Persona constant |
|---|---|---|
| `tool-subagent` | `spawn` | `WORKER_PERSONA` |
| `tool-subagent-fork` | `fork` | `FORK_PERSONA` |
| `tool-subagent-ptc` | `multitask_ptc` | `PTC_WORKER_PERSONA` |
| `tool-subagent-minimal` | `multitask_minimal` | `MINIMAL_WORKER_PERSONA` |

**The injector is this bundle's `worker-persona.mjs`**: in the `agent/created` window it picks the text of that row by **provider name** and registers it on **the subagent's own scope** (section name `deployment:persona-prefix`). Upstream delegation rows no longer accept a `persona` config option, so the persona does not travel through `dsh-subagent`. The scope layering rule is unchanged: "the nearest scope wins for a section of the same name", which still overrides the coordinator's copy.

How to check: have a worker report its tool surface, then look at whether `You are the coordinator` is still left in its prompt, and whether `WORKER subagent` / `FULL tool set` are present.

⚠️ These three strings are **the fingerprint of the persona wording**: they are **not protected by any automated guard**, and this constraint is kept by people — change them and the check above stops working.

### The trap specific to fork: it treats the parent's history as its own

`subagent_fork` starts from a context that is **not the same** as the other three: it is fed **every completed turn** of the parent session. That brings a failure found nowhere else: those turns simply look like "its own conversation".

Symptoms of the failure:

- a fork worker refers to itself as "I, as the coordinator";
- another reports "I dispatched a fork", when the one that dispatched the fork was its own parent session;
- it counts the parent's turns as its own, and from that infers its own permission boundary — but that boundary is **the coordinator's**: far narrower than what it actually holds, and not at all the basis it should act on.

**This is not "an occasional misreading"; it is a structural consequence of this context**: what gets fed in is "completed turns", and every assistant utterance in them is literally first person. The model has no extra signal to tell "this was me" from "this was fed to me".

**The fix**: `FORK_PERSONA` devotes a section to keeping two things permanently apart — "what I did" counts only the calls I launched myself in this session, after the brief arrived; "what I read" is background the coordinator chose to give me, which I may cite and verify, but **must not report as work I did**, and must not infer my own capability from. It then names two concrete consequences:

1. **Do not infer your tool surface from the transcript.** The coordinator's tool surface has been narrowed by mechanism (it cannot write files, cannot run commands), so a stretch of dialogue full of "I cannot do that, I will dispatch a subagent" describes **its** limits, not a fork worker's.
2. **Do not take the coordinator's dispatch as your own.** The previous worker mentioned in the brief is another session; the fork never ran it.

It also **cannot read its own session id** (that lives in metadata it cannot see), so the persona says outright: if you need it, say you cannot get it — do not guess, and above all do not pass off the coordinator's id in its place.

⚠️ This one **cannot be guaranteed by an automated guard**: it is prompt text, and whether the model treats the fed-in history as its own can only be caught by human review. The only part that can be guarded is "the persona text really was injected into the fork worker" — and that is guaranteed by the provider mapping in `worker-persona.mjs`.

### Two things every worker must know

`WORKER_PERSONA` / `FORK_PERSONA` / `PTC_WORKER_PERSONA` / `MINIMAL_WORKER_PERSONA` — each of the four personas has a section **`## The coordinator may interrupt you mid-turn`** and one **`## Stop before you thrash, and say so`**. Neither is optional polish; each closes off one class of real failure:

**One: being interrupted mid-turn is normal, not a mistake.** The coordinator will cut the current turn off outright while a worker is working and follow with a new instruction (see the "correction timing" section — the delay is on the order of milliseconds). A worker that does not know this in advance reads "an instruction that arrives out of nowhere" as its own screw-up, and redoes the work from the top — when it in fact still holds all the context it built up, so the redo is pure waste.

So all four personas say it plainly: **what you have read, run and concluded is not wiped**; all that is lost is the **one** action in progress at the moment of the interrupt; a new instruction **outranks the original brief** where they conflict; **do not redo the work from the start**; and **report across the interrupt boundary** (how far you got before it, what you did after it) — otherwise the coordinator cannot tell whether the correction took.

⚠️ Each copy must be written to its own mechanism; they must not be copied from one another:

- The **PTC** copy adds that **a killed program does not hand back what it never printed** — another reason it requires printing decision-ready results as it computes: printed state survives an interrupt, unprinted state does not.
- The **fork** copy adds that **inherited turns are still not mine** — an interrupt does not move that line, it only adds "what I did in this session before and after the correction".

**Two: when you get stuck on the same construct, stop and report instead of continuing to edit.** The typical case is **a conditional expression inside a large or deeply nested block** (`A ? { … } : { … }`, or ternary braces that keep multiplying): each attempt adds or removes one brace, the error moves with it, and the next attempt leaves the spot messier. By that point it is no longer converging, just spending the coordinator's time.

The persona gives an executable test, not advice: **two failures on the same construct is the signal** — stop editing; **state the file, the construct, the verbatim last error and the number of attempts**; **give the shape it believes was intended plus the surrounding structure**; and **never "fix" it by deleting a branch or weakening a condition** — the file then parses, but the behaviour changed silently, and the coordinator has no idea where to look.

The third worker type (minimal) has no write permission, so its section swaps in the isomorphic failure: **the same fact not found twice** is the signal, and it must report the paths and patterns it tried; **it must never write "I did not find it" as "it does not exist"**.

### On the coordinator side: a stall means "swap the worker", not "push harder"

Correspondingly, the coordinator persona has a section **`## When a worker reports that it is stuck`**, and what it prescribes is to **dispatch a brand-new worker onto that one spot**, not to send the original one back in:

- the original worker's context already holds several failed attempts, and **those attempts are themselves the problem** — it stays anchored on the shape it has already written, and another instruction buys you a fourth variant;
- a fresh worker reads the file once, cleanly, and that is its only advantage: **it has nothing invested in a shape that does not hold**;
- the brief for the fresh worker is deliberately narrow: the exact file and construct, the verbatim last error, the surrounding structure, and "you may restructure this block at your own judgement, but the behaviour must stay and the rest of the file must not be touched".

It also states the **stop-loss**: if the fresh worker also fails twice at the same spot, the construct needs a design decision from the user — report it truthfully rather than opening a third worker.

> The test in this section is "the same construct twice", not "it feels hard" — the latter cannot be executed, the former can. This is also this bundle's consistent stance: give the persona rules that can be decided, not descriptions of intent.

### A third fact: the limit is one reply's output, not the context window

A worker that hits the output ceiling looks like a crash from the outside: the turn just ends, with no follow-up turn. Three things can hold at once — `contextWindow` is **1,000,000**, context usage is only **ten percent**, and the finish reason is **`max-tokens`**. So this is **the output ceiling of a single reply** (the largest `outputTokens` anywhere in this machine's registry happens to be exactly 32,768), and **not** context exhaustion. That distinction decides what you do:

- Handle it as "context exhaustion" → shorten the reading list. **Ineffective**: reading files accounts for only a small slice of that ten percent.
- Handle it as "the output ceiling" → split the **writes**. **Effective**: the trouble came from one reply spitting out a hundred thousand characters.

**Where it lands**:

- The three personas that **can write files** (`WORKER_PERSONA` / `FORK_PERSONA` / `PTC_WORKER_PERSONA`) each have a section **`## Never emit a whole large file in one reply`** that states the ceiling number, the name of the `max-tokens` finish reason, and four executable practices: keep one write within 400–500 lines; write a skeleton first and then `edit` in pieces; after a truncation continue **from the tail** rather than starting over; and settle the split points before starting work.
- **`MINIMAL_WORKER_PERSONA` deliberately omits this section**: it is a read-only worker with no landing point it can act on, and one more rule would only dilute its real constraint (cannot read it, say you cannot read it).
- On **the coordinator** side there are two: task briefs must be **split by write volume** ("redo the whole stylesheet across five sections" is several jobs in itself), and **`max-tokens` must not be reported as context exhaustion**.

> Why this cannot be written only as "try not to write too much at once": a soft suggestion does not take effect at 30,000 tokens. Give the number, give the name of the finish reason, give the concrete action "continue from the tail", and only then does the model have a landing point it can decide on — the same stance as this bundle's other guards.

---

## Design notes (why it is written this way)

### Why the coordinator is restricted and subagents are not

This is the fulcrum of the whole mode.

`applyChildComposition()` in `dsh-subagent` forces every subagent to join **the parent's copy of the preset**, and any tool filtering can only **narrow**, never widen (the delegation row no longer has a `toolFilter`; all that is left is a **scope-level restriction inside the same preset**, with the same semantics of only removing, never adding). So "narrow coordinator, wide worker" **cannot be achieved by configuration** — it has to be done inside the preset.

The way in is `join()` in the preset registry: it binds the agent's scope to **the preset's generation key**, not to the parent agent's scope:

```js
parent: bindScopeParent(key, generation.key)
```

So **the coordinator's agent scope and the subagent's are siblings, not parent and child**. And when `dsh-tools` decides visibility it only walks each chain's own ancestors:

```js
if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
```

The restriction is installed on **the coordinator's own layer** — a layer that is not in the subagent's ancestor chain, so the subagent is not affected at all.

> This inference can be verified against the **real** `dsh-scope` / `dsh-tools` modules (no need to merely read the source): hang a subagent under the coordinator's scope (parent and child rather than siblings) and it **does** lose tools — which proves the criterion is sensitive to scope structure, not passing by accident.

### Why the set is derived as a complement instead of a hard-coded denylist

`tools.restrict()` **throws on a tool name that does not exist**. With a hard-coded denylist, the first change to the host's roster breaks it.

This plugin goes the other way: read every tool name currently **visible** in that scope, `deny = visible set − keep set`. Every name in the list therefore necessarily exists, and new tools are withheld by default.

### Why the restriction must be installed outside the assembly waterfall

`SystemPrompt.assemble()` collects the tool providers and renders each section's text **first**, and only **then** runs the `system-prompt/assemble` waterfall. So installing the restriction **inside** the waterfall cannot change the request it is serving — it only takes effect on the next round, i.e. the first request slips through.

This plugin installs in two safe windows only: `agent/created` (before the first assembly) and `tools/post-execute` (self-healing re-install).

### ★ Mode isolation: narrow only the sessions that **belong to this preset**

**Requirement**: sessions in several modes may coexist in one workspace (standard / ptc / Multitask…). The shock absorber may touch **only Multitask's own sessions**; other modes must lose **not one tool**.

**How** (`coordinator-guard.mjs`):

- **Add an ownership criterion**: `registry.composedPreset(agent.ctx)` must equal this preset's id; otherwise always **remove** the restriction (not "do nothing"). The criterion reads the preset the agent is **currently bound** to, which changes on a switch; it deliberately **does not read** `agentPreset` from the session header — that field records "which one was used at creation time" and stops holding after a switch.
- **The criterion runs before every early-exit path**: failing to read the visible surface, failing to read the tool registry, and the like must never leave a restriction **installed on the wrong object** in place.
- **No narrowing when ownership cannot be read** (fail-open): better to skip one narrowing this round (the next window retries) than to cut into another mode — a wrong cut leaves no log at all and is far harder to find than a missed install.
- **Listen to two carrier-less broadcasts**: `agent-preset/selected` (the registry forwards it after `session/event`, with the session id as its argument) and `tools/change` (no arguments). **This is not optional**: once a session switches away, the shock absorber is no longer in its ancestor chain, and a scope-filtered `tools/post-execute` **never receives another event from it** — "one last sync" never comes. A broadcast has no carrier and is not scope-filtered, which is the only way to deliver the "rejudge" signal. Both directions are covered: on switching **away**, re-check against the registry and release; on switching **in**, that agent was never narrowed and is not in the registry, so it is fetched back with `agents.get(id)` and narrowed (otherwise "switched into Multitask before the first turn" would miss the install, and the first turn's tool surface would be too wide).

`definition.id` and the guard's criterion share one exported constant, `PRESET_ID`, and the host half overwrites the guard row's `config.presetId` with **the id actually registered** — the moment the two drift, the shock absorber concludes "no session belongs to me" and the whole mode silently stops working (one warn line, and that is all), so they are deliberately kept from one source rather than duplicated as two literals.

#### Two layers of criteria, and the order matters

1. **Live binding (authoritative)**: `registry.composedPreset(agent.ctx)` — the preset the agent is **currently** bound to, which changes on a switch. This is the only signal that can recognise "already switched away".
2. **`agentPreset` in the session header (the fallback)**: used **only when the live binding cannot be read**.

⚠️ The fallback is used **only for "the live binding is absent", never for "the live binding is a different id"**. The distinction is the point: a session that has switched away **has** a live binding (it was rebound to a new generation) and explicitly returns another id, so it is stopped at layer 1 — it cannot be wrongly narrowed because the session header still carries the value from creation time.

Why a fallback is needed: there is no measured evidence for the order between a new session's preset binding and `agent/created`. If the binding came later, reading only the live binding would also stop **genuine Multitask sessions** from being narrowed — that breaks the main feature. The fallback removes that timing uncertainty.

### ★ Several modes at once: independent within one workspace

**Requirement**: in one workspace, different sessions may use different modes **at the same time** (standard / ptc / Multitask…), without interfering; **whichever mode's session you delegate from, the subagent uses that mode's configuration**.

Two things guarantee this together:

| Concern | Guaranteed by | Basis |
|---|---|---|
| Each mode's tool surface in the main conversation | this document's ownership criterion | the restriction is installed only on sessions belonging to this preset |
| A subagent uses the parent session's copy of the configuration | **DSH itself** | `applyChildComposition()` in `dsh-subagent` calls `agentPresets.composeFrom(childCtx, parent.ctx)`, forcing the subagent into **the parent's copy of the preset** |

So "delegate from a Multitask session → the subagent gets Multitask's worker persona and one of the four tool surfaces" is not something this plugin adds on top; it is DSH's existing contract plus this plugin declaring the preset correctly.

How to check: delegate a subagent from a Multitask session and read its `subagent/descriptor` — `provider` should be one of `spawn` / `fork` / `multitask_ptc` / `multitask_minimal` (that is exactly the criterion for the four kinds of worker), and the subagent's prompt should contain `WORKER subagent in Multitask mode`, with the tool surface including tools the coordinator had removed, such as `read_image` / `pwsh`.

> ⚠️ Do not judge by `descriptor.persona`: the delegation row does not accept a `persona` config option, so that field is never written for new sessions; the persona is injected by `worker-persona.mjs` based on the `provider` name. A `persona` in the descriptor can only come from an earlier-created session, and this package has a read-only fallback for it.

⚠️ The converse boundary: **the subagent model mapping applies only inside Multitask**. The `subagentModels` in the profile patch hangs off the `dsh-multitask` row's `config` and is read by the host half into the composition's delegation row `agentOptions`, so it **affects only subagents delegated from Multitask sessions**; subagents in a standard session are outside its reach. That is exactly the "keep the two apart" the requirement asks for.

### The recount must be bounded (the root cause of cross-session fan-out and its two fixes)

**Symptom**: with enough registered sessions, a single `tools/change` pins the main thread — `dsh web` hangs, `SIGTERM` gets no response, and the only way out is to kill the process. Measured (N = 12 registered sessions): one `tools/change` before the fix printed **`restrict=179`** and tripped the breaker outright (CAP = 220).

**Where the mechanism comes from**:

- The host's `tools.restrict()` (`dsh-tools/lib/index.js:2991-3005`) **does not pass `notify: false`**, so both **installing** and **removing** a restriction synchronously `emit('tools/change')`.
- And `tools/change` is handled as "walk every registered session and recount". So **each recount fires two broadcasts of its own**, and each broadcast makes every registered session recount again — an amplification factor on the order of `2^(N-1)·(N-1)!`. The old `sync()` also went "`release` first, then `restrict`", which uses both broadcasts to the full.
- The fast path's basis is `dsh-tools:3066-3070`: `view().restrictableNames` is filled **before** the `admits()` filter, i.e. it is already the **full inherited surface**, so there is no need to remove first and then read.

**The fix (two layers, independent of each other)**:

1. **A bounded pass gate** (`pass()` in `coordinator-guard.mjs`). All five entry points (`agent/created`, `tools/post-execute`, `agent-preset/selected`, `tools/change`, and `release` on a mode switch) go through the gate; a `tools/change` fired back by `release()` / `restrict()` during a pass **only marks dirty, never recurses**; after the pass, dirty triggers at most **2 more** full recount rounds (`sync()` is idempotent, extra runs are harmless), and a state still not settled logs `MULTITASK-GUARD-UNSETTLED`. `passDepth` **must be reset in `finally`**: cordis's `emit` is synchronous, so if the body throws with the gate left locked, every later entry point is judged a "re-entry" and only marks dirty — the guard **stops for good**.
2. **The fast path**: `deny = restrictableNames ∩ (¬keep ∪ extraDeny)` — compute the difference against the full inherited surface directly, which is **equivalent** to "remove first, then read the visible surface". When the target set equals the installed set, **zero `release` / zero `restrict` / zero `emit`**, and the source of self-excitation is gone entirely.

**Measured**: before the fix, one `tools/change` at N = 12 → `restrict=179` and the breaker tripped; after the fix, the same scenario gives `restrict=0 dispose=0 emit=0`. The diagnostic warning for `scope-local` names is **kept** — names that cannot be removed structurally still warn once (T14 goes from red to green).

**How it degrades when it breaks**:

- Gate failure (`finally` did not reset) = the guard stops for good, and **a too-wide tool surface raises no alarm either** — the worst kind. The degradation direction is "rather one extra full recount than a deadlock": every exception path resets, and when in doubt it is treated as **not re-entered**.
- The fast path cannot read `view().restrictableNames` (old host, test stub) → fall back to the slow path (`release` first, then read the visible surface). Correctness is unchanged, it just returns to "two broadcasts per recount"; the gate is then the **only** line of defence — the two layers must not be reduced to one.
- If the host later adds `notify: false` to `restrict()` (or stops broadcasting `tools/change` on a size change), the gate and the fast path degrade into pure speed-ups; keep them as they are.

### When the coordinator ends its turn (a soft half and a hard half: persona + same-named segment shadowing)

**Symptom**: after a dispatch the coordinator does not stop — it keeps checking where the worker "has got to" (`list_agents` / `job_output`), filling the wait with process data. An action that should have ended in one turn is dragged over several, burning context on information with **no conclusion in it**.

**Where the mechanism comes from**:

- The host's `dsh-tool-subagent/lib/index.js:509-518` injects a system prompt section **unconditionally** (section name `tool:subagent`, order `2800`), one line of which is "… continue useful work while they run". That row's Config has only `provider` / `toolName` / `modelSelectionSettings` / `agentOptions` / `agentPreset` / `allowedAgentPresets` / `maxDepth` — **no switch turns this section off**.
- Step 3 of the coordinator persona in `composition.mjs` says "keep working while they run" as well; before the fix **not one line** anywhere in the repo said "end the turn when there is nothing to push forward".
- A section can be **shadowed by name from a nearer scope**: `dsh-system-prompt/lib/index.js:245-249` says plainly "A scoped section shadows a global section with the same name". The precedent is `worker-persona.mjs:264-268` — covering the upstream copy with a same-named section on **the subagent scope**.

**The fix (two halves, neither alone suffices)**:

- **The soft half**: the coordinator persona gains `## Ending your turn after a dispatch` (`composition.mjs:185-193`). It says four things: ending the turn is the **correct** action; the conclusion is not lost — when the worker reports, the runtime wakes it with a **new turn**; filling the wait with process data is forbidden; and **this section overrides the host's line** ("continue useful work" only means "do not block on the dispatch", not "keep producing turns").
- **The hard half**: a new `presets/multitask/coordinator-prompt.mjs` registers a **same-named section** `tool:subagent` (order `2800`) on **the coordinator scope**, shadowing the host's copy. The point is not to repeat the persona but to make what **lands** agree with it, instead of handing the model two contradictory lines to adjudicate. Its criterion mirrors `coordinator-guard.mjs`: skip `isDelegatedChild` (what a worker needs is "do the work, then report", not "end the turn"), and require ownership by this preset (live binding first, the session header's `agentPreset` only as fallback).

**How it degrades when it breaks**:

- Shadowing not installed (the `systemPrompt` service absent, `section()` missing or throwing) → **silently degrade** back to the host's original semantics ("work and keep an eye on it"). The persona half is still there, now the only line of defence; the worst outcome is a few extra turns — still a usable session.
- Conversely, throwing here → **that session never starts**, which is far worse than a few extra turns, so it deliberately fails open: it never throws and never blocks session creation.

### The subagent stall watchdog (P1.5: turning a silent hang into a visible event)

**Symptom**: the worker gets stuck rewriting the same spot (typically brace proliferation — `A ? { … } : { … }` getting messier with every pass), neither reverting nor raising an error, and producing nothing at all. And the parent session **receives no event**: the coordinator ended its turn per the discipline in the previous section, so it is never woken again. The whole task hangs mid-air and nothing looks wrong in the UI — only manual polling finds it.

**Where the mechanism comes from**:

- The host has **no** subagent step cap, idle timeout or watchdog. The Config on `dsh-subagent/lib/index.js:2978-2981` has only two numbers, `maxDepth` and `maxActiveSubagents`: one limits depth, one limits concurrency, **neither has anything to do with "how long it has run / whether it produced anything"**.
- The parent session has only two channels to learn that a subagent finished: `subagent/end` (`dsh-subagent/lib/index.js:199-206`) and the settle notification (same file, `:2040-2062`). Both fire only when the subagent is **genuinely idle** — and a stuck worker is exactly the one that never goes idle, so both channels go silent together.
- `dsh-repeat-tool-reminder` is no substitute: it only recognises repeated calls **with identical arguments** (`thresholds [3,5,8]`), so "back-and-forth on the same spot with different content each round" is read as a new chain and resets the count; and it only reminds, **it never terminates**.

**The fix**: a new `presets/multitask/subagent-watchdog.mjs` keeps time **on the parent side** — the only criterion available is "how long since any activity", and the activity signal (`tools/post-execute`) can be received on the parent preset's scope:

- On `agent/created`, record into the registry every worker that "was delegated, and whose parent session is composed with this preset". The ownership criterion mirrors `coordinator-guard.mjs`: read the parent agent's **live binding** first, fall back to the subagent session header's `agentPreset` only if unreadable; if neither holds, **do not enrol** it (when in doubt, leave it alone — stopping a worker another coordinator is waiting on amounts to deciding for that other session).
- Every `tools/post-execute` refreshes that worker's last-activity time. **The call's content is deliberately ignored**: a long `read`, a whole-tree command, both are proof that "it is still moving"; the coarser the criterion, the fewer false kills.
- Sweep once per `tickMs`; when `now - at > stallTimeoutMs`, **delete from the registry first**, then call `subagents.interrupt(id, { kind: 'ancestor', agent: parentAgent })`. If the parent agent cannot be resolved, do **not** call `interrupt` and log `[MULTITASK-WATCHDOG-NO-PARENT]` instead (`{kind:'ancestor'}` without `agent` makes the host throw a TypeError: `dsh-subagent/lib/index.js:1258-1261` reads `authority.agent` directly). Delete before stopping, so the same worker is handled exactly once.
- Stopping it triggers the host's `subagent-settled` notification ⇒ the parent session is woken ⇒ the hang turns from silent into a **visible report**. That is this module's real purpose: not to make workers run less, but to give a hang a voice.
- Log markers (greppable): `[MULTITASK-WATCHDOG-STALLED] child=<id> idle=<ms>ms`; `[MULTITASK-WATCHDOG-ENGAGED]` on first enrolment, `[MULTITASK-WATCHDOG-SKIPPED] … [reason=…]` when skipping; `[MULTITASK-WATCHDOG-NO-PARENT] child=<id> idle=<ms>ms` when a stall is diagnosed but the parent agent cannot be resolved (and therefore **nobody** is stopped).
- Config: `stallTimeoutMs` (default `300000` = 5 minutes — long enough not to false-kill a worker inside a long think / long command, short enough that a hang does not drag the wait out all night), `tickMs` (default `30000`), `interruptOnStall` (default `true`; set to `false` it only reports and never stops anyone). **Where the values come from**: the panel (the Multitask settings page) → `readWatchdog()` in `lib/index.js` → `buildPlugins({ watchdog })` → this row's `config`; the defaults written here serve only as **fallback** (`buildPlugins()` called with no arguments behaves as before). **Changes take effect for new sessions after saving; sessions already running keep the value they started with.** The profile's `cordis.patch.yml` **cannot reach a row inside a preset declaration** (`applyGuardOverrides` in `lib/index.js` matches `coordinator-guard` / `workspace-acl` by id only and passes through only `presetId` / `enabled` / `keep` / `extraDeny`), and its semantics are **whole-config replacement**, not merge: even if it could reach one, it would wipe `enabled` / `presetId` along with it, and the watchdog would then skip silently with `no-preset-id`. With `enabled: false` the whole row does nothing.

**Degradation and known boundaries**:

- `interrupt` missing (older host) or throwing → **log one line and bow out** (fail-open, back to the host's original semantics: a hang stays silent). Never throw — breaking a healthy session is far worse than missing the stop on one worker.
- "No activity" is a **proxy criterion**, not proof of a hang: a normal long task that simply makes no tool calls for a while (long thinking, waiting on an external event) will be judged early. So this module only does "stop it and hand the matter back to the parent session", **it never redispatches automatically** — a redispatch would perform the same write twice, and whether to redispatch depends on the report and the current state of the files, things the coordinator can see and this module cannot.
- If a worker judged stalled is stuck inside a **non-cancellable** tool, `subagent-settled` may never arrive either — the parent session is then still not woken, and all that is left is the log (`[MULTITASK-WATCHDOG-STALLED]`) — **a human still has to look**.
- Cleanup runs on two channels: the timer is `unref()`ed (otherwise the process cannot exit), and a stop is hung on both `ctx.on('dispose')` and `ctx.effect` (`stop` is idempotent). With both channels missing, the worst case is one extra timer left in the process; the session is never blocked.

---

## Uninstalling

**Installed with a package manager?** Let the package manager do it:

```
dsh plugin --profile <profile> remove dsh-multitask
```

Or uninstall it from DSH's **Plugins** page.

**Installed from a source checkout?** (that `- insert: - id: multitask` stanza in the profile patch) — just delete that whole stanza by hand.

In both cases, the preset disappears from the mode picker of every **new** session (sessions already running are unaffected).

No restart needed: DSH hot-reloads this patch file, the plugin is unloaded once the line is gone, and on unload it deregisters its own preset declaration (see `releaseOwn()` and `ctx.effect(() => () => …)` in `lib/index.js`). If the mode still does not disappear, restart the app and check the log for warnings that begin with `dsh-multitask`.

To **disable it temporarily** without uninstalling, add `disabled: true` to that line (or switch the plugin itself off with `enabled: false`):

```yaml
- id: multitask
  disabled: true
```

> ⚠️ This package has **no** standalone host-layer settings of its own that need rolling back separately. If a `- id: subagent-model-selection-settings` stanza lingers in the profile patch (`enabled: false`, inert), it is not part of this package's current install shape and can be deleted by hand — **but confirm first that no other preset depends on it** (see "Known boundaries").

---

## Package layout

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → inserts the host lines on load; dsh.client → the browser half
├── cordis.patch.yml                    # inserts the plugin line into the profile roster (for the bundle install path)
├── LICENSE                             # MIT
├── README.md                           # ★ user-facing documentation (English)
├── README.zh.md                        # ★ user-facing documentation (Chinese)
├── docs/
│   ├── DESIGN.md                       # ★ this file: design derivation / the upstream basis for each decision
│   ├── DESIGN_zh.md                    # the same document in Chinese
│   └── test_image/                     # UI screenshots referenced by the README (doc material, not tests)
├── lib/
│   ├── index.js                        # host half: declares its own preset to agentPresets on activation
│   └── client.js                       # ★ browser half: a top-level "Multitask" page in Settings (two cards) + two rows in General settings
└── presets/multitask/
    ├── composition.mjs                 # preset composition + coordinator persona + per-mode worker personas
    ├── coordinator-guard.mjs           # ★ the shock absorber (includes the "mode isolation" ownership test)
    ├── subagent-mode.mjs               # ★ multi-mode subagents: PTC presentation (zero dependencies, zero imports)
    ├── minimal-guard.mjs               # ★ adaptive narrowing for subagent_minimal (zero dependencies, zero imports)
    ├── worker-guard.mjs                # ★ strips the delegation tools that would always be rejected if called (pure token saving, zero dependencies)
    ├── approval-gate.mjs               # ★ approval gate: dangerous operations raise a popup for the user to rule on (zero dependencies, zero imports)
    ├── interrupt-before-send.mjs        # ★ correction ordering: intercepts send_message, stops the current turn before sending (zero dependencies, zero imports)
    ├── preset-dispatch.mjs             # ★ cross-mode dispatch: delivers a task brief to any installed agent preset
    ├── workspace-acl.mjs               # ★ workspace ACL: adds WRITE_OWNER + stamps existing subdirectories so the shell works out of the box (the only module that changes system state; two writes in total)
    └── file-info.mjs                   # ★ read-only file metadata tool file_info (zero dependencies, zero imports)
```

⚠️ `concurrency-guard.mjs` is **not** in this list, and not in the repository either — the concurrency limit has exactly one enforcement point, in the host, and this package installs no such guard.

The `files` field in `package.json` is the subset of the list above that **ships with the release** (`lib` / `presets` / `cordis.patch.yml` / `README.md` / `README.zh.md` / `docs/DESIGN.md` / `docs/DESIGN_zh.md` / `LICENSE`). **The test suite is not in it** — this package ships only the files the runtime actually needs.

The UI screenshots referenced by the README live in `docs/test_image/`: they are **documentation assets** (not test scripts, so they do not go into `test/`), **and they go into the repository but likewise not into the release package**. On GitHub they render directly by relative path; on the npm page, npm points the relative address back at this repository via the `repository` field (npm's docs state that the README is "rendered as GFM via the GitHub API", and the community reports the same — ⚠️ **this repository has not verified that line verbatim**). So the images only need to be in the repository; writing them into `files` would just add 1.3 MB to the package for nothing.

This package **does not ship its tests with the release**, so this document does not describe the test suite either — it covers design and behaviour only.

---

## Making source edits take effect

**The conclusion up front: after editing source, restart the app. Incrementing `?v=N` alone is not enough.**

**Why** (based on the load path of `cordis-plugin-loader`, not on inference): this package lives in the workspace, **not** under an HMR watch root, so a source edit **will not** reload anything — Node's ESM cache keeps returning the old module. The profile patch file **is** watched by HMR (`dsh-hmr` installs a watcher on `cordis.patch.yml`, and HMR itself is enabled), so a change to that file **is noticed**; but **being noticed is not the same as reloading the module**:

> `?v=N` changes the **name** on that line, and for an entry that **already has a fiber (the entry is already running)** `cordis-plugin-loader`, on seeing "only `name` changed", takes the `_patchContext(["name"])` branch — and that branch calls `fiber.update()` only when the diff **contains `config`**, otherwise it **does nothing**, and **does not `import()` either**. Only a **new entry with no fiber** goes through `await this.init()` to actually load the module.

So `entry.options.name` gets recorded as `?v=N+1` (the patch text really does land on disk), but **the module is never re-`import()`ed, and the fiber is neither unloaded nor updated** — the process keeps running the old copy. You can check it this way: bump `?v` in place → **0 import calls**; **add a new entry** → **1 import call**.

**So the right move is two things, and the second one is required:**

1. **Bump `?v=N`** (when the profile patch is written, `entry.options.name` updates with it);
2. **Restart the app** — only the **first** load of that entry in a new process has no old fiber, so only then does it actually read your latest source.

```yaml
# With a source-checkout install, the name on this line looks like (?v=N is that cache key):
name: 'file:///<your path>/dsh-multitask/lib/index.js?v=6'   # ← bump this number, then restart
```

> The published-package install (`dsh-multitask` inside `node_modules`) **has no** such query, and does not need it: the contents of `node_modules` change only when pnpm rewrites them.

> **Do not read this as "`?v` is useless".** `?v=N` is the **ESM cache key**, and its effect **still holds after a process restart** — after a restart the new process reads the latest source; its value is preventing "same specifier within the same process ⇒ hit the old module graph". The accurate relationship is: **a `?v` bump and a restart are an "or", not an "and"** — **the restart is required**, a `?v` bump is **good hygiene**, and harmless. Keep the habit.

**Corollary: "delete it and add it back in the same save" does not work either.** `EntryGroup.update()` compares by **id**; the id `multitask` is in both tables, before and after the edit, so it gets the **same `Entry`**, still only sees "the name changed", and still takes the name-only branch. **Two saves are required** (delete → wait until stable → add back), and the preset is briefly absent in between.

Four pitfalls, all already avoided in the code:

1. **Relative imports do not inherit the entry's query.** Add `?v=N` to the entry only: the entry refreshes, but the `composition.mjs` it imports relatively is still fetched from the old cache — you edit the preset text and nothing changes, with no error either. This package propagates the query explicitly, layer by layer (entry → `composition.mjs` → every `presets/multitask/*.mjs` module, all assembled through the same `local()`), so **one bump refreshes the whole module graph**.
2. **A bump may still not take effect.** If an older module instance still holds the preset declaration, the registry hard-rejects the duplicate id, and that failure **leaves only one warn line** — so the old preset quietly stays in place and it looks like "the change did nothing". This package uses a process-level handover table so a new instance can take over the old declaration; but instances **older than that mechanism** cannot be reached by it. Then a **restart** is the simplest reliable move (it wipes every old instance in the process); or delete the line, save, wait for the app to settle, and **save once more** to add it back (note that it must be two saves, see above).
3. **The declaration invariants live in `declare()` itself.** `declaring` guards concurrency, `declared` guards ordering, `release` only deregisters on unload, `finally` resets, and a late fallback retry **still works as before**. The two entry paths (the main path and the `ctx.inject` fallback) therefore never **collide with themselves**: `declared` is set the moment the registration lands — with or without a deregisterer — and the call-site guard is `!declared && !closed`. So that `is ALREADY registered by an older module instance` warning appears **only when an earlier instance really does hold it**, which makes it a **reliable** criterion. Boundary: it fires only if the registry **violates its own contract** (accepts a declaration but returns no deregisterer) — a low-probability exceptional path, and the plugin **warns anyway**.

---

## Known boundaries

- **A preset can only be chosen before the session starts.** A session already running cannot switch into it.
- **What the coordinator cannot see, it cannot verify.** The read-only tools are kept precisely so it can independently check a subagent's conclusions instead of trusting them blindly. Take `read`/`grep`/`glob` off its surface and the ability to verify is gone.
- **`maxDepth: 1` means a worker can no longer delegate.** Oversized work has to be split into parallel task briefs by you or the coordinator.
- **PTC's "collapse" is a presentation collapse, not a capability cut — that is the design, not a defect.** `subagent_ptc`'s direct tool surface really is down to `run_code` alone, but that SDK binding table **is still fully callable** (from inside the program via `tools.<name>(args)`). The upstream prompt states this verbatim: `These declarations are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.` Cutting the SDK surface would turn PTC into a shell that can only run empty programs — "one program replacing a long string of single calls" is the entire reason this mode exists. **So "pwsh is still callable inside PTC" is not a miss.**
- **A rejected native call inside PTC is "guided", not silent.** A native call to any name other than `run_code` returns an `isError` result reading `Error: unknown tool "pwsh": only run_code is callable directly — call pwsh from inside a run_code program instead` — it tells the model exactly which route to take instead. ⚠️ But **if that worker never made a native call at all** (the normal case: it read its own tool surface and knew better than to), then no rejection text ever appears in the session — in that case "no rejection" means **not triggered**, not "the gate was silent". The test is whether the session holds a `tool/result` with `isError=true`, not whether that string ever showed up (a worker restating its task brief writes those words too).
- **Editing source requires restarting the app** (and habitually bumping `?v=N`) — bumping `?v=N` alone is a no-op for an entry already running, see "How changes take effect after editing source"; this bundle does **not** watch workspace source automatically.
- **A subagent's model is decided by you in the Settings panel, per worker type; the AI cannot assign one mid-session.** The four-line delegation config contains no host-level switch such as `modelSelectionSettings`; if a profile patch still carries a matching block, it does not take effect and is not part of this bundle's install shape.
- **A subagent's shell requires `WRITE_OWNER` on the workspace directory** — new workspaces get it patched in automatically by the plugin (next section); it needs no elevation, no approval, and must never be solved by widening the directory to Full control. **Existing subdirectories** additionally need a one-time inheritance and Low label backfill (those three host grants inherit only at object creation, never retroactively), also covered in the next section.

### When a subagent's shell is unusable altogether: the workspace is missing `WRITE_OWNER`

**Symptom (verbatim).** With `WRITE_OWNER` missing on the workspace, every command a subagent runs fails, with this exact error:

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace path>)
```

(The path part is that session's writable root.)

**How to recognize it, and why it is neither your command nor your concurrency count.** Every line below is an identification criterion:

| Symptom | Explanation |
|---|---|
| It fails even with only **1** subagent running | **Nothing to do with concurrency** — you are not hitting the capacity cap of 8 |
| It fails the same way with a side-effect-free command such as `Get-Location` | **Nothing to do with the command** — the command is not malformed |
| Point the command's working directory at the system temp directory and the error **still** names the session's writable root | **Nothing to do with the working directory** — the path being refused is not the one the command wants to touch |
| Read-only tools (`read` / `grep` / `glob` / `file_info`) **work fine** | Only the "execute / write" route is blocked |
| Some workspaces work, others are dead | **It is about the workspace directory's permissions** — see below |

**The real cause: the workspace directory's permissions are missing `WRITE_OWNER`.**

When DSH's ACL sandbox grants a workspace, **one** call writes three things at once (`info = 20` folds the DACL and the SACL into a single write): an allow ACE for the capability SID, a delete-child deny for Everyone, and the **Low integrity label**. The catch is that **the label lives in the SACL**, and writing a SACL requires `WRITE_OWNER`; **the owner's implicit rights cover only `READ_CONTROL` and `WRITE_DAC`**, not it. The host documentation states this precondition itself:

> Granted directories must be caller-owned and grant `WRITE_OWNER` … A directory whose DACL grants only Modify now fails the grant loudly instead of silently skipping the confinement.

So a **directory where you granted yourself only `Modify`** makes the whole call fail, and every command a subagent runs errors out. That explains the asymmetry:

- A drive root usually grants only `Authenticated Users:(M)` (Modify), so **a directory created straight at a drive root carries this defect from birth**;
- A user directory (`C:\Users\<you>`) grants an inheritable `(F)`, so directories created under it **satisfy it naturally** — which is why the same plugin works fine in some workspaces and is dead in others.

**The fix: add one non-inherited `WRITE_OWNER` and touch nothing else.**

**The plugin performs the repair automatically; the user does nothing and approves nothing.** `workspace-acl.mjs` checks the workspace directory at session start and, if `WRITE_OWNER` is missing, **adds only that one thing** (a non-inherited `TakeOwnership`), then stops. It tries once per workspace per process, is idempotent, and a failure never affects the session.

#### When the grant is patched in

The criterion is "**has this cwd been handled**", not "is this the root session": `agent/created` does not bail early for a delegated subagent, and duplicate triggers are deduplicated by `handled` on the normalized path — when the parent session already patched, that is one `Set` lookup; when it did not, the subagent is the only remaining opportunity.

Direction matters too: listening on `agent-preset/selected` **handles only the "switching in" direction** — the second argument is the new preset id, compared directly against `config.presetId`, falling back to reading the live binding from the registry only when the argument is absent. Patching the grant for a session that switched away means stamping another mode's cwd, the wrong direction (see the "mode isolation" section).

The three criteria share one source and none can be dropped: `applyGuardOverrides` in `lib/index.js` syncs `workspace-acl`'s `presetId` — when a profile changes `config.presetId` to something else, aligning only the shock absorber makes that criterion mismatch silently and the switching path stalls again.

**Residual boundary: a worker dispatched across modes can still be missed.** Events dispatch along the scope chain; if the scope chain of a worker produced by `subagent_preset` does not include the target preset's guards (see the four guard types in the "cross-mode dispatch" section), this module never receives its `agent/created` — in that case the grant still depends on the parent session's hop, and if the parent is not in this mode either, nobody patches it. This one shares its origin with the existing boundary of the four guard types.

- **The minimal grant is exactly `WRITE_OWNER`**, not `(F)`, not `Modify`. **Never widen the directory to Full control for this** — that additionally hands over "change permissions + take ownership", far beyond what is needed. And `WRITE_OWNER` is **the owner granting it to itself**: the owner could always take ownership back anyway, so this ACE expands nobody's actual power, it only turns "what the owner could already do" into "what the sandbox can do".
- It **needs** no elevation, **needs** no `SeSecurityPrivilege`, **needs** no "approved restricted run outside the sandbox". The whole action is one DACL write, and the directory owner implicitly holds `WRITE_DAC` — it completes in-process.
- To turn it off: set that line's `config.autoGrantWriteOwner` to `false`.
- **The out-of-the-box approach**: put workspaces under the user directory (they satisfy it naturally); paths at a drive root rely on the auto-grant above.

**How to check whether the auto-grant took effect**: have a subagent run a side-effect-free command (such as `Get-Location`); it should exit **code 0** with no `grantWrite` in the error, then run `icacls .` and look at that ACE — this module's fingerprint is a **non-inherited `(WO,S)`** (`icacls /grant ...:(WO)` writes only `(WO)`, PowerShell's `AddAccessRule(TakeOwnership)` writes `(WO,S)`, so the two side by side tell you whether the plugin patched it or a human edited it by hand).

> ⚠️ **The log tag is not persisted.** `MULTITASK-*` goes to the app's log stream; DSH does not write them to files (under `~/.dsh/logs/` there are only logs other plugins write themselves). Judge by the actual `icacls` output.

**If it still fails**, there are only two possibilities: the directory **belongs to another account**, or it is **not writable in this process** — in that case that `WRITE_OWNER` never appears (no `(WO` in `icacls <dir>`).

#### Existing subdirectories: inheritance and backfilled labels (serialized after the grant)

**The problem: those three grants inherit only at object creation and never retroactively.** The three things the host's `grantWrite()` writes (the capability ACE, `Everyone:(CI)(DENY)(DC)`, and the `Mandatory Label`) are all **inheritable**, but inheritance happens only **at the moment an object is created**. So a workspace that predates the plugin release stays half-crippled for a long time: the root has all three, while `.git` / `docs` / `lib` / `presets` / `test` / `.github` / `.cursor` (created 2026-10-27) have **not one of them**; only `research`, created later (2026-11-01), has all three.

**This is not "permissions too tight", it is "the command fails outright".** The sandbox shell runs under **Low IL + a restricted token** (the restricting list holds only the logon SID / `Everyone` / the capability SID / the temp directory SID, **not `Authenticated Users`**), so in those directories it finds no principal it recognizes, and file creation is refused:

```
fatal: Unable to create '.../.git/index.lock': Permission denied
```

(`git add` is the most common one, usually followed by `[sandbox: file access denied under workspace-write mode]`.) **Approval has nothing to do with it**: approval only decides "whether to ask a human", it does not mean permission to step outside the sandbox. **The plugin has no dedicated git channel** — the gate holds only six git regexes (`git-force-push` / `git-reset-hard` / `git-clean-force` / `git-rewrite-history` / `git-remote-remove` / `git-discard-worktree`); plain `git add` / `git commit` / `git push` **are not asked at all**, `.git/` paths get zero special-casing, and the gate itself only upgrades `allow` to `ask` for delegated sub-sessions under a parent policy of `ask`, never returns `deny`, and never touches the sandbox.

**The fix: three `icacls` commands, and no policy is ever generated.**

| Order | Action | Why this one |
|---|---|---|
| 1 | `icacls <dir> /grant *<current user SID>:(WO) /T /C /Q` | Writing the integrity label needs `WRITE_OWNER` on the object (the host README admits it verbatim; earlier local experiments in this repo settled it too) |
| 2 | `icacls <dir> /inheritance:e /T /C /Q` | Makes existing objects re-inherit the parent's inheritable entries — that is how the capability ACE is obtained, **without hardcoding the capability SID** |
| 3 | `icacls <dir> /setintegritylevel "(OI)(CI)Low" /T /C /Q` | A Low label matching the host's (directories carry `(OI)(CI)`, files get a single Low entry) |

**The ordering precondition cannot be reversed**: steps 2 and 3 both write a security descriptor onto the objects, and without the `WRITE_OWNER` supplied by step 1 they cannot be written. The path is read only from `$env:DSH_MT_ACL_DIR`; it is never spliced into the script.

**Why not hardcode the capability SID, and why not invent a policy.** What the subdirectories lack is not a new rule but a "re-inheritance": those three things **are already written in the root's DACL / SACL** (by the host). Making the objects inherit the root's copy means subdirectories follow when the host changes its mind (swaps the capability SID, swaps the label); conversely, if the plugin generated an ACE of its own, it would become **a leftover nobody owns** once the host changes policy. For the same reason, inheriting `Everyone:(CI)(DENY)(DC)` along with the rest is **aligning with a freshly created workspace**, not new policy from this plugin — a workspace created today has it from birth. If it affects delete-child actions such as `git gc` inside `.git`, that is equally true of every new workspace; this step did not introduce it.

**Timing, fast filter and idempotence.** It runs **after** `ensureWriteOwner`, serially (the order cannot be reversed), once per cwd per process. Before touching anything it does a **read-only fast filter**: read `icacls` once per **direct** subdirectory (icacls does not accept several names in one call, measured locally); if all already carry a `Mandatory Label`, print `SUB-OK` and bail early, **making not a single write** — once repaired, each session pays only these few read-only calls.

**Switch and failure posture.** On by default; `config.autoRepairStampedChildren: false` turns this section off, **independently of** `autoGrantWriteOwner`. The timeout lives separately in `REPAIR_TIMEOUT_MS` (120 seconds) and still goes through the single `runPowerShell` exit. Failure is **fail-open**: log only, never throw, never block the session — worst case it falls back to today's behavior of "subdirectories keep getting refused". Tags: `MULTITASK-WORKSPACE-ACL-SUB-OK` / `-SUB-REPAIRED` / `-SUB-SKIPPED` / `-SUB-FAILED`.

**Known cost.** An old workspace gets one `(WO,S)` ACE added to each existing object on the first run; `/T` is a whole-tree operation, so a large workspace with `node_modules` costs anywhere from a few hundred milliseconds to over ten seconds of traversal the first time, after which the fast filter short-circuits it.

> ⚠️ **Unmeasured items (listed honestly).** This repo's constraint is "read only, no ACL writes", so the following were **never executed on this machine**: where `/inheritance:e` and `/setintegritylevel` actually land (argument shapes taken from local `icacls /?` and read-only `icacls` output); how `/T` behaves when it meets a **reparse point** (junction / symlink); using the `(NW)` tag as a fallback for identifying localized output; and the ordering precondition that a brand-new workspace whose root the host has not stamped yet may get only the label and not the capability ACE on its first session (inferred from host ordering). Judgment still rests on the actual `icacls` output.

### ⚠️ A guardrail: DSH's own directories must never be stamped

At the step that **patches the root's `WRITE_OWNER`** this module writes a single `TakeOwnership`; the existing-subdirectory backfill that follows adds inheritance and a Low label to those objects — but only the former is what gets DSH's own directories stamped, so not one of the five guardrails below can be dropped. Patching `WRITE_OWNER` turns the host's `AclSandbox.init()` `grantWrite()` from a failure into a success, and that call is **one write of three things** (`info = 20` folds the DACL and the SACL into a single write):

1. An allow ACE for the capability SID;
2. **`Everyone:(CI)(DENY)(DC)`** — denies delete-child, and **inherits down into every subdirectory**;
3. **`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`** — the low integrity label.

Item 2 is the key: it is an **explicit deny**, and deny is evaluated before allow — **even the owner's `FullControl` cannot override it**. Landing on DSH's own directories, the consequence is not "some worker fails to do its job" but **DSH refusing to start with ordinary privileges**: subdirectories refuse deletion, so repacking / cleanup / updates fail, and the symptom is exactly "won't start with ordinary privileges, works as administrator" (an administrator can take ownership and bypass the deny).

That is why the module carries a `sensitiveReasonFor()` guardrail: hitting any one of the following **skips** it (not "do it anyway but warn" — skipping at worst falls back to "the shell won't start", an explainable and escapable state; doing it anyway costs DSH its ability to be reinstalled):

| Reason tag | Criterion | Why |
|---|---|---|
| `drive-root` | `H:\` / `C:\` | The stamp would inherit across the whole drive |
| `contains-running-app` | cwd is an ancestor of `process.execPath` | That is the install directory, with a running program inside it |
| `dsh-state-dir` | `~/.dsh` and its subdirectories | It holds profiles / node_modules / sessions |
| `ancestor-of-dsh-state` | `%USERPROFILE%`, `C:\Users` … | Stamping an ancestor widens the scope to the entire user profile |
| `system-dir` | `%SystemRoot%` / `%ProgramFiles%` / `%ProgramData%` | System directories |

This table is locked by tests (the mutation cases in `workspace-acl-guard-mutation.mjs`).

**What the coordinator and workers should do.** The three personas already spell it out (`composition.mjs`'s `COORDINATOR_PERSONA` / `WORKER_PERSONA` / `FORK_PERSONA`): recognize it, **do not retry in a loop**, **do not run any permission command yourself**, and **never widen the directory to Full control**; if it is still refused, report that concrete cause (which directory, the auto-grant did not land) honestly to the user and switch to the read-only + file-editing route. For users:

- Tasks such as "read a file, look up metadata, edit a file" **can always be dispatched**;
- "Run a build, run tests, execute a command" **works as usual** once the auto-grant has landed; if it is still being refused, that points to the two possibilities above, not to "the shock absorber is installed in the wrong place" or "the subagent is broken" — both explanations collapse on the fact that the read-only path still works.
