# dsh-multitask — the Multitask "shock absorber" mode

[中文](README.zh.md) · [Design notes and measured evidence](docs/DESIGN.md) · MIT License

A work mode for **DeepSeek Harness（DSH）** in which **the main conversation does exactly three things**: understand what you asked for, turn it into task briefs, and report back what the Subagents concluded. Every piece of process data — file contents, command output, build logs, search results, dead ends — is digested inside a **Subagent's context** and never enters the main one. The main conversation therefore holds only high-value information.

This is a **mechanism**, not a prompt asking the model to behave. Once the mode is selected, the main conversation (the coordinator) genuinely has a narrower tool surface: the tools that would drag in process data — writing files, running commands, searching the web — are **not in its visible set**. It cannot call them, so it cannot pollute its own context. A Subagent (worker) is the opposite: it gets the full tool surface, does the work, and returns only its conclusion.

Zero runtime dependencies. No changes to DSH source.

At a glance:

| Capability | What it gives you |
|---|---|
| Narrowed coordinator tool surface | the main conversation cannot write, run commands or search — those tools are genuinely absent, not merely discouraged |
| Process data never reaches the main conversation | file contents, command output, build logs and dead ends stay inside a worker's context |
| Four kinds of Subagent | a full-surface worker, a fork that inherits completed turns, a programmatic PTC worker and a read-only worker, chosen by task shape |
| Dispatch to another mode | hand a brief to any other installed agent preset and receive only its conclusion |
| Two-level approval gate | safe commands run untouched; dangerous ones raise a card in the main conversation |
| Corrections take effect immediately | a follow-up message stops the worker's current turn first instead of queueing behind the wrong work |
| Mode isolation | several modes can share one workspace; each narrows only its own sessions |
| Cross-session settings | pick a model per worker kind and set the parallelism limit, both in Settings |
| Automatic workspace permission repair | on Windows the one missing permission is added at session start, and only that one |
| Read-only metadata tool `file_info` | byte counts and file kinds without reading contents, so the coordinator can verify a claim itself |
| Zero runtime dependencies | no changes to DSH source |

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

### Mode isolation: it only narrows its own sessions

The narrowing is applied only to sessions whose live preset binding is this preset. A session belonging to another mode in the same workspace keeps its own tool roster and is not touched — so you can run several modes side by side without them eating each other's tools.

Switching a session out of the mode lifts the restriction again, and switching into it before the first turn narrows it before the first request is even made.

`presetId` is that ownership key. If you change it to install variants side by side, each variant narrows only its own sessions; and if it no longer matches the registered preset id, **no** session is narrowed at all — the mode can look installed while quietly doing nothing.

When ownership cannot be read, the guard prefers **not** to narrow rather than risk narrowing a neighbour's session. The cost of a registry hiccup is therefore one possibly un-narrowed turn, never a broken neighbouring mode.

---

## Installation

### From the published package (recommended)

```
dsh plugin --profile <profile> add dsh-multitask
```

`--profile` is an **option** and cannot be dropped — `dsh plugin add dsh-multitask` fails outright with `error: required option '--profile <name>' not specified`. `<profile>` is the profile to install into: the desktop app owns one called `desktop`, and this checkout commonly uses `web`; if you are unsure, look at the directories under `~/.dsh/profiles/`.

The package then lands in that profile's `node_modules`, and DSH **automatically** appends `dsh-multitask` to the profile's `dsh.profile.bundles` layer list (because this package declares `dsh.bundle.patch`). The bundled `cordis.patch.yml` inserts a bare package name with no absolute paths — so it works on any machine, any user name, any install location. **Restart the app afterwards** — bundle layers are composed at startup.

You can also install it from the in-app **Plugins** page, which needs no command line.

> **Desktop (Electron) note.** **Fully quit the app first** — pnpm rewrites the profile's `node_modules`, and the running app holding those files open will make it fail. The desktop app's own `dsh` launcher can manage `desktop`; a `dsh` **installed separately from npm** is refused outright (`error: profile "desktop" is managed exclusively by the Electron application`). In that case use the in-app **Plugins** page, or the source route below.

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

> The mode can be chosen **before a session's first turn starts**, and a session whose first turn has not yet started can still be switched into or out of it. What is frozen is a session that has **already started running its first turn** — that is an existing DSH constraint (the tool surface and prompt freeze on the first turn), not a limitation of this plugin.

The coordinator translates your request into **self-contained** task briefs — a Subagent cannot see this conversation, so a brief must carry everything it needs (goal, verified current state, project conventions, safety rails, numbered tasks, conditional branches, stop conditions, report format). Independent briefs are dispatched **in parallel**, and the coordinator keeps working while they run.

---

## The four kinds of Subagent

The coordinator has four delegation paths, and the difference is mainly the **tool surface**:

| Delegation tool | Tool surface | Best for |
|---|---|---|
| `subagent` | **full** | the default — writing code, running tests, editing files, execution work |
| `subagent_fork` | **full** + the **completed turns** of this conversation — it does **not** see the turn currently in flight, so a fact stated in the dispatching turn must be repeated in the brief | review and continuation — when the work must build on what is already established here |
| `subagent_ptc` | **PTC-collapsed**: only `run_code` is directly callable; every other tool is reached from inside a program via a generated SDK | programmatic bulk work — filtering, aggregating, or moving large data sets whose intermediate values should never enter the context |
| `subagent_minimal` | **read-only**: write and execute tools are removed, but it keeps `read` `grep` `glob` `read_image` `file_info` `skill` `todo_write` `present` and **can still search and fetch the web** | investigation, quick answers, fact-checking |

Pick by the shape of the task, not by habit. The four paths have different tool surfaces, and the choice is made per delegation in the coordinator persona (section `## Choosing which worker to delegate to`).

**Delegation is one level deep**: coordinator → worker, and a worker cannot delegate further. Jobs that need splitting are split by the coordinator into flat briefs.

### What a worker does not get

The four kinds also differ in **persona**, not only in tool surface. A fork worker is told that the seeded turns are the coordinator's work and not its own, so it reviews instead of pretending to have done it. A PTC worker is told that its closing message is the fallback channel if `run_code` breaks. The read-only worker is told it may search and fetch the web, so it does not report back that it "cannot look anything up".

On top of that, five delegation tools — `subagent`, `subagent_fork`, `subagent_ptc`, `subagent_minimal`, `subagent_preset` — are removed from a worker's tool catalog outright, for every kind except the read-only worker. A worker therefore cannot delegate: the tool is **not there** rather than present-and-refused. This costs no capability, because the host's fixed depth of 1 would refuse every such call anyway; it only stops that schema being re-sent on every single request. The coordinator is untouched by this, and the read-only worker is narrowed by its own allowlist instead.

This is **not a security boundary** — the real block is the host's depth limit. If it fails to install it degrades silently, leaving only a log line containing `WORKER-GUARD-SKIPPED`, and nothing is lost functionally. Its switch is the `worker-guard` row's `config.enabled` in `presets/multitask/composition.mjs` (which also accepts an additive `config.extraDeny`), and changing it requires a restart.

If a worker's persona cannot be installed at all, that worker keeps the coordinator persona and the log shows `WORKER-PERSONA-SKIPPED`.

### Corrections stop the worker first

When the coordinator sends a follow-up to a running worker, the target's current turn is stopped **first**, and only then is the message delivered — it does not queue until the next step boundary. This matters because a single step can be one long tool call: a build, a dependency pull, a recursive scan. A correction that merely queued would let the wrong instruction run to completion before your new one was even read.

Stopping is not "the task was cancelled". The inbox and any descendants are kept, every fact already accepted is still in the session log, and only the one in-flight action is dropped. A correction to work that was on the right track therefore loses almost nothing — and the message may carry information the worker could not have had.

It only ever acts in the coordinator → worker direction. A message that a worker sends upward is not preceded by an interrupt, because that would cut the main conversation's own turn. If the interrupt fails, or the deployment exposes no interrupt capability, the message is still sent normally and corrections simply revert to queueing: you see an info line, not an error. Its only switch is the `interrupt-before-send` row's `config.enabled` in the composition, and changing it requires a restart.

### The read-only `file_info` tool

It is **this package's own tool** and the only self-authored tool on the coordinator's keep list. Its input is exactly one field: `paths`, an array of one or more path strings (up to 256), resolved by the filesystem backend with relative paths taken against the session working directory.

The output is one entry per requested path — `requestedPath`, `resolvedPath`, `status`, `sizeKnown`, `sizeBytes` when known, and a `note` explaining an odd state — plus a `totals` block (`requested`, `files`, `directories`, `others`, `missing`, `errors`, `bytes`, `unknownSizes`, `complete`).

`status` is one of `file`, `directory`, `other`, `missing` or `error`. A directory is reported **as a directory with no byte count**. A missing or uninspectable path is reported as such and is **never** reported as 0 bytes: when the backend cannot supply a size, `sizeKnown` is `false` and `sizeBytes` is absent rather than fabricated as zero.

`totals.bytes` sums **only** the known sizes, `unknownSizes` counts the rest, and `complete` is true only when every requested path is a known-size regular file — so a partial sum never masquerades as a total.

It never reads file contents and never modifies anything: it only resolves and stats each path. That is exactly why it is safe to keep in a mode whose entire point is keeping data out of the main conversation, and why the coordinator can use it to check a worker's claim ("five files, this many bytes") instead of trusting the report. It also serves the read-only worker, and it is deliberately **not** affected by the `DSH_MULTITASK_MULTI_MODE` switch.

If the filesystem capability is unavailable at load time the tool is simply **not registered** — the model never sees a route that would fail — leaving a log line containing `FILE-INFO-SKIPPED`; success logs `FILE-INFO-ENGAGED`.

---

## Dispatching to another mode

The four paths above are this mode's **own** workers. One more path reaches **outside** this mode:

| Delegation tool | Target | Best for |
|---|---|---|
| `subagent_preset` | **any installed agent preset** (including third-party modes installed from the market) | when the job is genuinely something that other mode exists to do |

This is what makes the coordinator a layer between **you and every installed mode**: it picks one by reading what that mode says about itself, hands the brief over, and only receives the conclusion. The work happens in **that mode's worker**, not in your main conversation.

To use it, call with `list: true` first to read the roster (id, name, description, and whether each mode can currently compose a session), then choose by description. **The description is the only reliable statement of a mode's capabilities** — do not guess from the id. A mode marked `CANNOT RUN` is broken and must not be chosen.

Three boundaries:

- **The brief must be fully self-contained.** A cross-mode worker may not even share this mode's tool conventions, so it needs the background written out even more completely than an ordinary worker.
- **You cannot dispatch to this mode itself.** That would spawn a sub-coordinator, which the depth limit then refuses to let delegate — the call is rejected outright and points you at the four built-in paths.
- **Workers cannot dispatch further.** `subagent_preset` belongs to the coordinator; the tool refuses a worker's call itself, with its own message ("A delegated worker cannot dispatch further (delegation depth is fixed at 1)"), before any depth limit is consulted — deliberately, so the error names the real cause instead of surfacing a bare `depth 2 exceeds maxDepth 1` that looks unrelated. Splitting therefore always stays with the coordinator.

**A fourth boundary (measured, and worth knowing): a cross-mode worker is not governed by this mode's guards.**

In `setup()` a subagent is attached to the **target mode's** scope with `bindScopeParent(childKey, targetGenerationKey)`, and events like `agent/created` and `tools/pre-execute` reach only listeners **on that scope chain**. A cross-mode worker's chain is `[itself, target mode]` — it does **not** contain this mode. That cuts both ways:

- **The good side:** this mode's persona injection, read-only narrowing, and approval gate never leak into someone else's mode. A task you hand to a read-only mode will not be told "you have the full tool set" by this mode.
- **The side to keep in mind:** the **approval gate does not cover it either**. Upstream pins a child session's approval policy to `never`, so a cross-mode worker's dangerous operations are **refused outright** (fail-closed — never silently allowed), but **no card is raised to ask you**. It is governed by the target mode; if that mode has guards of its own, they apply.

So cross-mode dispatching is a **capability router, not a security proxy**. Work that needs this mode's two-level gate should still go to one of the four built-in paths.

The provider is fixed to `spawn` and is not a configuration option: upstream requires a provider that can select another preset to declare the `agentPreset` capability **and** not inherit the parent's context. The built-in `spawn` satisfies both and `fork` does not. Hard-coding it avoids a class of capability error that would otherwise only surface at delegation time.

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

### How the settings page behaves

- The **Save / Discard bar** at the bottom of the Multitask page controls **only the model card**. The parallelism limit writes instantly, so editing it does not light up Save — that is not a broken button.
- Save and Discard stay **greyed out until the model mapping actually changes**.
- If the settings were changed elsewhere, a **banner** appears telling you to discard your draft and try again.
- The model dropdowns are populated from a **live catalogue**. While it loads you see a loading message; if it fails you see an error with a **Retry** button and the only choice is "Inherit coordinator"; and a saved model that is no longer advertised stays selectable with a "(saved but currently unavailable)" suffix, so you can still clear it.
- In "use one model for every Subagent" mode the first option is the placeholder **"Choose a model"**; picking it resets **all four** kinds to inherit. In per-kind mode each dropdown starts with **"Inherit coordinator (default)"**; selecting it removes that kind's entry.
- The two numeric rows (recursion depth, parallelism limit) accept **digits only** and are committed when the field loses focus or you press **Enter** — not on every keystroke. They also have **− / +** steppers; typing something invalid turns the box red with inline correction text and the value is **not** written.
- **"Maximum recursion depth" carries the hint "0 disables Subagents entirely".** Setting it to 0 turns delegation off altogether — the parallelism limit, by contrast, has a floor of 1 and rejects 0.
- A deployment that stores settings **read-only** shows a banner saying so and disables every control; a deployment that does not serve the settings namespace says exactly that instead of rendering an empty page.
- All of this page's copy ships in **both English and Simplified Chinese** and follows the DSH UI language.
- The settings page is not the whole story: `enabled`, `presetId`, `order`, `guardEnabled`, `keep` and `extraDeny` have **no UI at all** and are profile-YAML only — see "Tunables (profile)" below.

### The session-header counter

- The session header shows how many Subagents are currently running, in three truthful states: a **count** when one or more are running, an explicit **"none running"** when the number is zero, and an explicit **"count unavailable"** rather than a guess when the projection cannot be read.
- It is **hidden entirely inside a sub-session** (a worker does not show a counter for its own siblings' children) and until the model catalogue has loaded.
- It sits **alongside** the host's own counter rather than replacing it, so seeing two numbers is expected.

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

### How this interacts with Experimental Auto Review

DSH has an experimental feature, Auto Review: it switches the permission preset to `auto`, so **every native tool call** (and every inner call inside a PTC program) is first risk-classified by a reviewer running the same model. It and this plugin are **two independent gates** on the same chain, enforced by two separate pieces of code.

While it is on, **this plugin's Level 1 yields** — the reviewer is the authority for that session:

| Reviewer decision | Result |
|---|---|
| allow (low risk, or a medium action with explicit authorisation) | runs immediately — **this plugin does not raise `ask`**, so you are not asked twice |
| deny, with the approval policy at `ask` | the reviewer returns `ask` itself, which reaches this plugin's Level-2 relay → a card appears in the main conversation for you |
| deny, with the policy at `never` | the reviewer's denial is final; `AUTO_REVIEW_DENIED` goes straight back to the Subagent |
| reviewer failure | treated as `deny` (fail-closed) — never a silent allow |

**With Auto Review off, behaviour is completely unchanged**: this plugin raises `ask` from the rule table as before. The test is "is this session's permission preset `auto`", the same test the reviewer uses, so the two sides can never disagree about who is in charge. The switch is `yieldToAutoReview` (default `true`); pass `false` to keep prompting even when the reviewer is in charge.

⚠️ Two boundaries worth knowing:

- **The reviewer does not review the outer `run_code`**, only the inner calls inside it; a `subagent_ptc` worker can produce Node side effects directly from its program. For a PTC worker, **the sandbox is still the last line**, not the reviewer.
- **Review costs extra tokens**: every reviewed call is a full model request.

Authorisation is **one-shot every time**: "Allow once" authorises that call only, and the same call prompts again next time. There is no "always allow".

**With a background dispatch whose turn has ended**, the first relay fails (it needs the parent session to have an open turn). The plugin then sends a message from that Subagent into the main conversation, naming which child session it is, what it wants to run, and where to answer — and **that message itself wakes the idle parent session**, so the plugin immediately retries the relay against the turn it just opened. In practice an ordinary approval card therefore appears in the main conversation within seconds; answer it there.

Only if that retry also fails (the window elapses, 10 seconds by default) do you need to open the child session named in the message and decide there. **The message is not an approval** — the message channel carries no approval result, so reading it as a go-ahead would bypass the gate; until you answer, that call stays blocked.

### Which commands it stops for

Level 1 is a **pattern table, not an AI review**. It only ever *adds* a prompt: a command no pattern matches is equivalent to not having this module at all. The families it matches:

- **Recursive / forced deletion** — `rm -rf`, `Remove-Item -Recurse` / `-Force`, `del /q`, `rd /s`
- **Disk and boot operations** — `format X:`, `diskpart` / `fdisk` / `parted` / `mkfs`, `dd of=`, `bcdedit` / `bootrec`
- **Power state** — `shutdown`, `Restart-Computer`, `Stop-Computer`, `reboot`
- **Git history and remote destruction** — `push --force` / `--force-with-lease` / `-f`, `reset --hard`, `clean -f`, `filter-branch` / `filter-repo`, `remote remove`, `checkout -- .`
- **Package publishing** — `npm` / `pnpm` / `yarn` / `bun` `publish` / `unpublish`, `cargo publish` / `yank`, `twine upload`, `dotnet nuget push`, `docker push`
- **Privilege escalation** — `sudo` / `doas` / `pkexec` / `runas` / `gsudo`, `Start-Process -Verb RunAs`, `Set-ExecutionPolicy`
- **System mutation** — accounts and groups, the registry, services, scheduled tasks, WMI, the firewall, ownership changes
- **Remote-code execution** — `Invoke-Expression` / `iex`, piping into a shell, `-EncodedCommand`, `certutil -urlcache`, `bitsadmin`, forced process kill

Deliberately **not** matched, so do not "fix" it into prompting on harmless commands: dry runs such as `git clean -nd`; `icacls` on a path without a mutation flag; bare `net user` and `wmic process list`; `chmod +x`; reading credential files; `ls /etc`. Writing **outside the workspace** is a separate check, made on the write tools' `file_path` rather than on command text.

Quoted text is judged by its context: inside `-Pattern` / `-match` / `-like` / `-eq` / `Select-String` the command text is not treated as code, so searching *for* a dangerous string does not prompt — while the body of `-Command` / `-c` deliberately **is** treated as code, so a dangerous command inside it does prompt.

### What the approval card shows

The card may be shown a path that contains `..`. When that changes where the path really lands, the reason line and both displayed descriptions carry the **resolved target** next to the literal one, together with the id of the rule that matched — so you approve the destination, not just the spelling.

Authorisation is **one-shot**: "Allow once" authorises that call only, and the same call prompts again next time. There is no "always allow".

Level 1 never pre-empts an upstream decision. It runs **after** the downstream handlers and only upgrades an `allow` into an `ask`; if something earlier in the chain already said `ask` or `deny`, that verdict stands and this module's card does not appear — so a write may be stopped by a different prompt than this module's.

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

**A worker stopped mid-sentence and the turn looks like it crashed.** A single reply has a hard ceiling on how much it can emit. Hitting it ends the turn with reason `max-tokens`, and from the outside that looks exactly like a crash. **It is not context exhaustion.** The fix is not to shrink what the worker should read; it is to split what it should write. Workers are told to keep one write under roughly 400–500 lines and to resume from the tail of a truncated file rather than starting over, which is why a large deliverable often arrives as a skeleton followed by successive edits. If a worker reports the same construct failing twice, that is a deliberate stop signal, not stubbornness: it will report the location and the verbatim error instead of varying the fix. The recovery is to start a **fresh** worker on that one spot rather than sending the same worker another retry instruction.

**No approval card appeared.** First check that the session's approval policy is `ask` (a headless configuration is `never`, and then this plugin stays entirely out of the way). If you dispatched in the background and the turn has ended, see the paragraph beginning "With a background dispatch whose turn has ended" in "Approving dangerous operations".

**Source edits have no effect.** You must **restart the app**. Bumping `?v=N` in the profile patch alone is a no-op for a row that is already running: the loader only sees that its name changed, so it neither reloads the module nor restarts it. See "Making source edits take effect" in [docs/DESIGN.md](docs/DESIGN.md).

### When the automatic permission repair runs

- **It is Windows-only.** On macOS and Linux the module is completely inert and registers nothing.
- **It only runs for a root (non-delegated) session whose resolved sandbox mode is `workspace-write`.** A `read-only` or `danger-full-access` session gets no grant, and the skip is logged. This is why a user in another sandbox mode must not wait for a repair that will never run.
- **The folder it touches is the session's own working directory**, not "the writable root" in the abstract. No cwd means no action.
- **What it adds:** exactly one `Allow` entry for the **current user's** SID with the single right `TakeOwnership` and no inheritance flags. The owner, the SACL and every existing ACE are left alone. It never widens to *Full control* or *Modify*.
- **It is safe to let it run every session:** an existing `WRITE_OWNER` short-circuits with no write at all, and after adding the entry the script re-reads the ACL and reports a verification failure if the entry did not land.
- **It is tried once per workspace per process** (keyed on the lowercased, trailing-slash-stripped working directory). A failed attempt is not retried by a later session in the same process — fix the cause, then restart the app.
- **It never blocks the session:** the grant is fire-and-forget, so session creation is never held up. The consequence is the one edge case: a command queued in the very first moments can still hit `grantWrite` once before the entry lands.
- **It can be turned off** with `autoGrantWriteOwner: false` — but only in the `workspace-acl` row's `config` inside `presets/multitask/composition.mjs`, not from the profile patch (the profile patch only rewrites the coordinator row).
- **Outcome markers** you can grep: `MULTITASK-WORKSPACE-ACL-OK`, `-GRANTED`, `-SKIPPED reason=…`, `-FAILED reason=… dir=…`.
- If it fails, the causes are **broader than "another owner or not writable"**: a timeout, a spawn failure, or the grant not landing all count, and each is reported. On machines where PowerShell itself is blocked (AppLocker / WDAC / Constrained Language Mode) the repair can never succeed — and that is the case where the fix really is your decision.

---

## Verifying that it actually works

With the mode selected, have the coordinator try these:

| You say | Expected |
|---|---|
| "Read package.json yourself and tell me the version." | ✅ succeeds (read-only checks are kept) |
| "Run `git status` yourself." | ❌ the call is impossible — the tool is not in its visible set |
| "Delegate to a Subagent to run `git status` and report the conclusion." | ✅ the Subagent runs it and brings back only the conclusion |
| "Delegate to a Subagent to read package.json and report the file name and size." | ✅ the read-only route always works (`read` / `file_info`) |

With a log sink attached, the log shows which tools were actually withheld — grep for `dsh-multitask` **without** the trailing colon, because the informational "engaged / withheld N tools" lines use the plain `dsh-multitask:` prefix while the guard warnings carry their module name, e.g. `dsh-multitask/coordinator-guard:`, `dsh-multitask/minimal-guard:`, `dsh-multitask/subagent-mode:` or `dsh-multitask/worker-persona:`. Grepping for `dsh-multitask:` alone will **miss exactly the warnings that tell you a guard failed to engage**. ⚠️ This deployment does **not** persist that channel (measured: the only occurrences left in session logs are source text echoed in conversation), so failing to grep it does **not** mean nothing was withheld — the judge is that calling those tools fails:

```
dsh-multitask: coordinator scope engaged — withheld N tool(s): edit, pwsh, read_image, ssh_exec, ...
```

The approval gate's preconditions and its verification steps — including the fallback path for background dispatches — are in [docs/DESIGN.md](docs/DESIGN.md), under "Verifying that it actually works" and "Approving dangerous operations".

---

## Self-correction: each side's conclusions get checked by the other

This mode has a quiet but important property: **a claim from either side must be grounded in evidence — neither gets by on "I remember" or "I assumed".** It does not depend on a model being asked to review itself; it rests on two mechanisms:

- **When the coordinator's premise is wrong, the worker pushes back.** The worker persona requires it to ground every claim in what it actually observed, never to report a result it did not obtain, and — on hitting a blocking situation — to stop and report it verbatim instead of improvising a workaround. So when a premise in the brief does not hold, it names the premise that does not.
- **Whatever a worker reports, the coordinator re-checks independently.** Keeping the read-only tools (`read` / `grep` / `glob` / `file_info`) is exactly what lets it go and look for itself rather than treating the report as fact.

In other words: the worker is not there to agree with the brief, and the coordinator may not promote a report into a conclusion — **neither side accepts the other's assertion on trust.**

That is not inferred from the design intent; it was measured. The three screenshots below are consecutive views of one end-to-end test report, and the three mistakes in it were **all corrected by a worker**:

![Test report 1: all four delegation paths exercised, depth limit, context isolation and concurrency](docs/test_image/1.png)

![Test report 2: reading outside the workspace is fully permitted, and the complete write-outside-the-workspace chain](docs/test_image/2.png)

![Test report 3: the three mistakes I made (all corrected by a worker) and the final on-disk state](docs/test_image/3.png)

- **Misjudged the asar as unreadable.** The coordinator first concluded "a packed archive means the sources are unreadable" and told the worker to back off; the worker contradicted it — `ripgrep` reads `.asar` as text, and inside is the real, commented source. The coordinator re-checked, confirmed the worker was right and it was wrong, and got source-level answers to six of seven questions.
- **Wrote the wrong escalation value.** The coordinator wrote "the narrowest escalation that is still wider", which the native worker read as `workspace-write` — the mode it was already in. Line-by-line verification of the source left no room for interpretation: `app.asar:911220` reads `if (mode === effectiveMode) return effectiveMode;` — **the same level is a silent no-op that never requests approval**; `:911221` reads `is not strictly wider than` (a level that is not wider throws outright); and the ladder has exactly one rung (`:911150-151`, `"workspace-write": ["danger-full-access"]`). The second refusal (byte-for-byte identical to the first) was therefore purely a defect in the brief, and it burned an approval window for nothing. Switching to `danger-full-access` went through on the first try.
- **Misjudged the temp directory's permissions.** The coordinator asserted the temp directory "needs no escalation"; the cleanup worker measured it being refused and pointed out that the brief's premise did not hold. The correct reading: a **session-private** temp directory (with its own SID and ACE) is not the same as the platform temp root.

One more case from the same run: a file appeared that no brief had asked for, and two independent lines of evidence agreed it was written by a PTC worker probing its own native tool permissions — it deliberately picked a path that looked nonexistent, expected a refusal, and the write succeeded; seeing the file in a concurrent call, it first misattributed it to a sibling worker, and later **withdrew its own "it was not me"**. An independent forensic worker measured the file's NTFS creation time and found it matching that account to the millisecond, inside a 15.6-second window between two other writes — while stating plainly that the filesystem cannot attribute authorship. The evidence established that the file belonged to this session; attribution came from the worker's own account, and that distinction was not glossed over.

To check this yourself: put a **deliberately wrong premise** in a brief (assert that some file is unreadable, say), and expect the worker to name the premise that does not hold rather than work around it.

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
| `minimal-guard` | the read-only worker is **not narrowed at all** — it sees every tool the composition registers, including write-capable ones and anything other plugins add. There is no static layer behind it any more (DSH 0.2.1-rc.2 removed the delegation row's `toolFilter`), so this switch is a **security downgrade**, not a convenience. Because the worker guard deliberately skips the read-only worker, switching `minimal-guard` off also makes the five delegation tools visible to it again |
| `worker-guard` | the five delegation tools are no longer removed from worker catalogs; only tokens are wasted, since the host's depth limit still refuses every call. It also accepts an additive `config.extraDeny` |
| `interrupt-before-send` | corrections go back to queueing at the next step boundary instead of stopping the target's current turn |
| `approval-gate` | dangerous operations no longer prompt (back to default DSH behaviour) |
| `workspace-acl` | `WRITE_OWNER` is no longer granted automatically (or use `config.autoGrantWriteOwner: false`) |

The environment variable `DSH_MULTITASK_MULTI_MODE=0` removes the `subagent_ptc` and `subagent_minimal` delegation paths (and their two keep-list entries) in one step, without touching the original `subagent` / `subagent_fork`. It does **not** unmount the PTC presentation row: `subagent-mode` — the row that performs the collapse — is mounted unconditionally. Because no `multitask_ptc` worker then exists, the collapse has nothing to act on, so the practical effect is as if the presentation were off, but the row itself is still there. To turn the presentation off for real, disable the `subagent-mode` row. Only `0`, `false` and `off` disable the variable's switch — any other value, including a typo, leaves it enabled. It is read at module load, so it needs an app restart.

### The approval-gate row's switches

The profile patch cannot reach this row's `config` — the host half applies only the top-level switches, and only to the `coordinator-guard` row. To change it, edit its `config` in `presets/multitask/composition.mjs` and restart the app:

| Field | Default | What it does |
|---|---|---|
| `classify` | `true` | Master switch for Level 1 (the deterministic rule table). `false` = dangerous commands are no longer stopped to ask; the Level-2 relay still runs |
| `relay` | `true` | Master switch for Level 2 (the relay). `false` = a Subagent's request no longer reaches the main conversation |
| `relayRetryWindowMs` | `10000` | How long to wait for the parent session to open a turn when the turn was just closed (ms). `0` disables the retry (back to notice-only) |
| `notifyOnRelayFailure` | `true` | The fallback notice when the relay fails. `false` turns it off: the relay still proceeds when the parent turn is **already open**, but when the turn is **closed** the notice is the only thing that can wake the parent session, so the retry cannot run and the request stays blocked until you answer in the child session |
| `extraDangerPatterns` | `[]` | Extra danger patterns, each `{ id, re }` or a bare string / regex. It can only **add** a prompt, never remove one |
| `safePatterns` | `[]` | Extra "match but do not ask" allow-patterns. ⚠️ This is a **prompt-suppressing** channel: a mistake silently lets a dangerous command through |
| `shellTools` | `['pwsh', 'bash']` | Extra tool names whose command text should be classified (a wrong name does not error, it silently misses) |
| `fileTools` | `['write', 'edit']` | Extra write tools whose `file_path` may point outside the workspace |
| `autoApproveTempRoots` | each platform's temp directory | "Scratch space" roots: writing there, or deleting **only** there, does not prompt. Pass `[]` to turn this off |
| `yieldToAutoReview` | `true` | When this session's permission preset is `auto` (Auto Review is on), yield to the reviewer instead of raising a second `ask`. Pass `false` to keep prompting anyway |

`extraDangerPatterns` / `shellTools` / `fileTools` are **additive**: missing one only means those cases are not examined (equivalent to not having this module), and it never lets through something this module would have asked about. `safePatterns` is **subtractive**: it cancels a danger this module has **already** judged, which is why it is deliberately empty by default — a mistake there is a silent permit, not one fewer prompt.

### Temp-directory exemption (`autoApproveTempRoots`)

The temp directory is the **scratch paper every process shares** — DSH itself creates `dsh-subagent-*` and `dsh-acl-locks` there. A worker writing intermediate artifacts there is ordinary work; prompting for it only trains you to click "Allow" without looking, which weakens the prompts that matter. Two cases are exempt by default:

- **writing into** the temp directory (a `write` / `edit` whose `file_path` lands under an allowed root);
- **deleting only inside** it (under the strict conditions below).

The default roots are derived from `TEMP` / `TMP` / `TMPDIR` and `%LOCALAPPDATA%\Temp` (no `node:os` import — this package's preset modules are dependency-free), and `/tmp` is added on every platform. Setting this field **replaces** that whole list: if you list only your own cache directory, the platform temp directory is no longer exempt. To extend rather than replace, list the temp roots again together with your own. An empty array turns the exemption off entirely, so even the temp directory prompts.

**The deletion exemption is deliberately strict** — four conditions, all required: no shell metacharacters (`,`, newline, and `;` `|` `&` `` ` `` `$` `>` `<`); at least one absolute path argument; **every** path argument under an allowed root; and no relative path arguments, with no `..` segment anywhere in a path. So:

| Command | Result |
|---|---|
| `rm -rf /tmp/x` | no prompt |
| `rm -rf /tmp/x /home/u` | **prompts** — one path is outside the roots |
| `rm -rf C:\Windows` | **prompts** |
| `rm -rf $env:TEMP\x` | **prompts** — it contains `$`, so no exemption |
| `Remove-Item -Recurse C:\Windows` | **prompts** |
| `Remove-Item -LiteralPath "/tmp/a","C:\Windows" -Recurse -Force` | **prompts** — comma-glued, the two paths have no space between them |
| `rm -rf /tmp/../../../etc` | **prompts** — `..` walks the path outside the root |
| `rm -rf /tmp/a ..` | **prompts** — a relative path argument deletes the parent of the working directory |

The last three rows are three real holes measured on 1.2.10 (comma gluing, `..` traversal, and relative path arguments all rode the exemption); the fix and its regressions land from 1.2.12.

The reason is blunt: one wrong exemption lets an entire dangerous command through, while one extra prompt costs a click. **This tier only decides whether to interrupt you, never what the sandbox allows** — where a worker can actually write is still decided by DSH's sandbox and ACL.

Source edits take effect only after a **restart**.

---

## Uninstalling

If you installed from the package manager, let it do the work: `dsh plugin --profile <profile> remove dsh-multitask`, or uninstall from the **Plugins** page.
If you installed from a source checkout, delete the whole `- insert: - id: multitask` block from the profile patch.

Either way the mode disappears from the selector for **new** sessions (running sessions are unaffected), and **no restart is needed** — DSH hot-reloads that patch, and the plugin unregisters its own preset declaration on unload. To **suspend** it temporarily instead, add `disabled: true` to that row.

---

## Development

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → inserts the host row on install; dsh.client → the browser half
├── cordis.patch.yml                    # inserts the plugin row into the profile roster
├── lib/
│   ├── index.js                        # host half: declares the bundled preset with agentPresets and registers the two worker backends
│   ├── worker-providers.js             # registers the two self-built worker backends multitask_ptc and multitask_minimal
│   └── client.js                       # browser half: the Multitask settings page + two General rows
├── presets/multitask/
│   ├── composition.mjs                 # the preset composition + coordinator persona + the four worker personas
│   ├── coordinator-guard.mjs           # the shock absorber (including the mode-isolation ownership check)
│   ├── subagent-mode.mjs               # PTC presentation: collapses a marked Subagent onto run_code
│   ├── minimal-guard.mjs               # adaptive narrowing for the read-only worker
│   ├── worker-guard.mjs                # removes the five delegation tools from a worker's catalog (it only saves tokens; the host's depth limit is the real block)
│   ├── worker-persona.mjs              # routes a worker's provider name to its persona text (so each of the four kinds gets its own persona)
│   ├── approval-gate.mjs               # the approval gate for dangerous operations
│   ├── interrupt-before-send.mjs        # correction timing: interrupt the target's turn before relaying
│   ├── preset-dispatch.mjs             # cross-mode dispatch: hands a brief to any installed agent preset
│   ├── workspace-acl.mjs               # workspace ACL: grants WRITE_OWNER (the only module that changes system state)
│   └── file-info.mjs                   # the read-only metadata tool file_info
├── docs/
│   ├── DESIGN.md                       # design reasoning, upstream evidence, known boundaries
│   └── test_image/                     # the screenshots the READMEs embed
├── README.md (English) / README.zh.md (Chinese)
└── LICENSE
```

The preset modules (`presets/multitask/*.mjs`) **import nothing**: they pull in no `@deepseek-ai/*` dependency, because a failed import means the whole preset fails to mount. The cost is that a few constants are duplicated, and changing one means changing the other.

### Making source edits take effect

**Restart the app after editing the sources.** This package lives outside the HMR-watched root, so Node's ESM cache keeps serving the old module; and although the profile patch itself *is* hot-reloaded, **bumping `?v=N` on a row that is already running only changes its name** — the loader takes the name-only branch and does not reload. A fresh process reading that row for the first time is what actually picks up your latest source.

Two related traps: a relative import does **not** inherit the entry's query (this package propagates it explicitly, so one bump refreshes the whole module graph), and "delete and re-add within one save" does not work either (the comparison is by id, so it is still the same row) — you must delete, let it settle, then add it back.

---

## Known boundaries

- **The mode is only selectable in a new session.** A running session cannot switch in.
- **What the coordinator cannot see, it cannot verify.** Keeping read-only tools is exactly what lets it check a Subagent's claims; remove `read` / `grep` / `glob` and that ability is gone.
- **Self-correction is a dependable tendency, not a hard guarantee.** That all three mistakes were pushed back on is a measured result, and it rests on two mechanisms being present **at the same time**: the worker persona forbidding results it did not obtain, and the coordinator keeping its read-only tools. With either one gone, the correction may simply not happen.
- **Delegation depth is 1.** A worker cannot delegate further; very large jobs must be split by the coordinator into parallel briefs.
- **PTC's "collapse" is a presentation collapse, not a capability cut — by design, not a defect.** The direct surface of `subagent_ptc` really is just `run_code`, but the SDK binding table remains fully callable from inside a program; remove it and PTC is an empty shell.
- **The read-only worker is "one adaptive layer of narrowing", still not a sandbox.** Narrowing is done by `minimal-guard.mjs` alone (`deny = visible set − allowed set`): the names come from the real visible surface, so the call cannot throw, and any tool a host or plugin registers later is withheld from that worker by default. DSH 0.2.1-rc.2 removed the delegation row's `toolFilter`, so the old static layer no longer exists — meaning **there is no fallback if this one layer fails to install** (it warns loudly). Also, if a plugin registers a new mutating tool **after** that worker is created, it will not be withheld (a deliberate trade-off).
- **The approval gate's fallback is only a pointing notice.** When the relay fails the request stays pending, and the notice does not release it; only answering in that child session does.
- **The rule table is pattern matching, so it will miss novel dangerous commands.** The real gate is therefore the Level-2 relay; Level 1 only exists to keep safe commands from bothering you.
- **An upstream change can disable a guard**, and every such failure fails towards "the behaviour you had without that guard", never towards wider permissions.

More complete boundaries, unverified items, and the measured evidence behind every claim are in [docs/DESIGN.md](docs/DESIGN.md).

## License

[MIT](LICENSE)
