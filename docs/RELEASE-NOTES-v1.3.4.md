# v1.3.4

> 建立在 v1.3.3 之上的修复版。1.3.0 – 1.3.3 这四个版本号**都从未对外发布**
> （详见 `RELEASE-NOTES-v1.3.3.md` 开头），本版修的是三个人都能撞到的问题中的三个。

## 本版要点

- **`dsh web` 卡死、`SIGTERM` 无响应、只能强杀 —— 根因修好了。** 会话一多，一次工具面重算
  会自激成跨会话扇出（放大因子 `2^(N-1)·(N-1)!` 量级），主线程被占死。本版把重算**有界化**，
  并加了一条**零广播快路**：目标与已装集合相同时一次 `release` / `restrict` / `emit` 都不发。
- **派单之后不再"一边等一边刷"。** 协调者派完单会反复去看 worker 跑到哪了，用过程数据把等待
  填满、烧掉主对话的上下文。现在它**结束回合**，worker 回报时由运行时以**新回合**唤醒它 ——
  结论不会丢。人格与工具说明两处一起改，不再是两句话互相矛盾、交给模型自行裁决。
- **worker 静默卡死不再是"没人知道"的状态。** 插件在父侧给被委派的子代理计时，超时（默认
  5 分钟无任何工具活动）主动停掉它 —— 停下会唤醒父会话，于是"卡住"变成一条可见的汇报，而
  不是永远等下去。

## 修复

### 跨会话重算扇出（P0：主线程占死）

**症状**：在册会话一多，`dsh web` 卡死，`SIGTERM` 也不响应，只能强杀进程。

**根因**：宿主 `tools.restrict()`（`dsh-tools/lib/index.js:2991-3005`）**没有传 `notify: false`**，
所以限制的**装**与**卸**都会同步 `emit('tools/change')`；而 `tools/change` 的处理是
「遍历**全部在册会话**重算」。旧 `sync()` 又是「先 `release` 再 `restrict`」，
一次重算固定自打两次广播，每次广播又让每个在册会话各重算一次 ——
放大因子是 `2^(N-1)·(N-1)!` 量级。

**修法（两层，彼此独立）**，见 `presets/multitask/coordinator-guard.mjs`：

1. **有界 pass 闸门**：五个入口（`agent/created`、`tools/post-execute`、
   `agent-preset/selected`、`tools/change`、切模式时的 `release`）全部过闸。pass 期间由
   `release()` / `restrict()` 自己打回来的 `tools/change` **只置 dirty、不递归**；pass 结束后
   按 dirty 补跑**至多 2 轮**全量核对（`sync()` 幂等，多跑无害），仍未 settle 就打
   `MULTITASK-GUARD-UNSETTLED`。`passDepth` 在 `finally` 里**强制复位** —— 不解锁会让之后所有
   入口都被判成「重入」，守卫永久停摆。
2. **快路**：`view().restrictableNames` 在 `admits()` 过滤**之前**就是继承面全集
   （`dsh-tools:3066-3070`），所以 `deny = restrictableNames ∩ (¬keep ∪ extraDeny)` 与
   「先卸再读可见面」**等价**。目标集合与已装集合相同时：**零 `release` / 零 `restrict` /
   零 `emit`**，自激的源头被整段拿掉。

**实测证据**：修复前 N = 12 个在册会话，一次 `tools/change` → `restrict=179`，直接触发熔断
（CAP = 220）；修复后同样场景 **`restrict=0 dispose=0 emit=0`**。`scope-local` 名字的诊断告警
**保留**（结构上摘不掉的名字仍 warn 一次），`guard-mode-isolation-regression` 的 T14 由红转绿。

### 派单后不结束回合（P1：用过程数据填满等待）

**症状**：协调者派完单不停下来 —— 反复 `list_agents` / `job_output` 看「跑到哪了」，
一个本该一轮结束的动作被拖成好几轮，上下文烧在**没有任何结论**的信息上。

**根因**：宿主 `dsh-tool-subagent/lib/index.js:509-518` **无条件**注入一段系统提示
（段名 `tool:subagent`、order `2800`），其中一句逐字是
「… continue useful work while they run」；而该行的 Config 只有 `provider` / `toolName` /
`modelSelectionSettings` / `agentOptions` / `agentPreset` / `allowedAgentPresets` / `maxDepth`，
**没有任何开关能关掉这段**。协调者人格 `composition.mjs` 的第 3 步也写着同样的
"keep working while they run" —— 全仓库此前**没有任何一条**规定「无事可推进就结束回合」。

**修法（软硬两半）**：

- **软**：协调者人格新增 `## Ending your turn after a dispatch`（`composition.mjs`）。四件事：
  结束回合是**正确**动作；结论不会丢 —— 回报以**新回合**到达；禁止用过程数据
  （`list_agents` / `job_list` / `job_output`）填等待；**本条覆盖宿主那句** ——
  "continue useful work" 只意味着「不要阻塞在派单上」。
- **硬**：新增 `presets/multitask/coordinator-prompt.mjs`，在**协调者 scope** 上注册**同名段**
  `tool:subagent`（order `2800`）**遮蔽**宿主那份。机制出处：
  `dsh-system-prompt/lib/index.js:245-249`「A scoped section shadows a global section with the
  same name」，先例是本仓库 `worker-persona.mjs:264-268`（在子代理 scope 上盖掉上游那份）。
  这条的目的不是重复人格，而是让**落点**与人格一致。判据与 `coordinator-guard.mjs` 同形：
  跳过 `isDelegatedChild`（worker 要的是「干活然后回报」），且要求归属本 preset。
  遮蔽装不上时**静默降级**回宿主原语义 —— 绝不抛错，最坏只是多刷几轮，不会让会话起不来。

### 子代理静默卡死（P1.5：父会话零事件）

**症状**：worker 陷在同一处反复改（典型是花括号增生），既不退回、也不报错、更不再产出；
父会话**收不到任何事件**。协调者按新纪律结束了回合，于是整个任务停在半空 —— 界面上看不出
任何异常，只能靠人肉轮询发现。

**根因**：宿主 `dsh-subagent/lib/index.js:2978-2981` 那一行 Config 只有 `maxDepth` 与
`maxActiveSubagents` —— **没有**步数上限、空闲超时或看门狗；而父会话的两条通道
（`subagent/end` `:199-206`、结算通知 `:2040-2062`）都只在子代理**真正 idle 时**才发。
卡死的 worker 永远不 idle，所以两条都是哑的。`dsh-repeat-tool-reminder` 只认**同参数**重复
（`thresholds [3,5,8]`），「同一处来回改、每轮内容不同」会被当成新链重置，且只提醒不终止。

**修法**：新增 `presets/multitask/subagent-watchdog.mjs`。父侧按「最后一次工具活动」给每个
被委派的 worker 计时（`tools/post-execute` 刷新），每 `tickMs`（默认 30 秒）巡检；超过
`stallTimeoutMs`（默认 5 分钟）就**先摘记录、再** `subagents.interrupt(id, { kind: 'ancestor' })`
（拿得到父 agent 时连同 `agent` 一起传）。停下会触发宿主的 `subagent-settled` 通知 ⇒
父会话被唤醒，「卡住」于是成了一条**可见的汇报**。日志标记
`[MULTITASK-WATCHDOG-STALLED] child=<id> idle=<ms>ms`；`interruptOnStall` 默认 `true`。
**面板可调停滞阈值 / 巡检间隔 / 超时处理（三态），保存后新建会话生效**（已开跑会话沿用启动值；
profile patch 够不到 preset 内部的行，阈值只能走面板）。
它**不自动重派** —— 该不该重派由看得见报告的协调者决定。

**实测**：`node test/subagent-watchdog.mjs` **7/7 全绿**（W1 停滞即停、W2 活跃不误杀、
W3 不碰别的模式、W4 释放后不再处理、W5 服务缺席 fail-open；W6 瀑布契约：处理器必须把
下游结果原样传回；W7 源码钉子：防止改回普通监听）。

## 验证方式

五条本地回归全绿（脚本在 `test/`，**本地专属、不随包分发** —— `test/` 整个目录被
`.gitignore` 忽略，也不进 `npm pack` 产物）：

| 脚本 | 结果 | 守什么 |
|---|---|---|
| `test/guard-mode-isolation-regression.mjs` | **14/14** | 模式隔离：只收窄属于本 preset 的会话 |
| `test/repo-consistency.mjs` | **52/52** | 仓库一致性：静态 / 离线，不加载 DSH、不写文件 |
| `test/coordinator-guard-fanout.mjs` | **6/6**（`--prove` **7/7**） | 重算扇出：一次 `tools/change` 不得自激放大 |
| `test/coordinator-prompt-contract.mjs` | **14/14** | 派单后收尾：人格文本 + 同名段遮蔽 |
| `test/subagent-watchdog.mjs` | **7/7** | 停滞看门狗：卡死会被停、活跃不误杀、别的模式不碰 |

`coordinator-guard-fanout.mjs` 带**反向验证**（`--prove`）：把 pass 闸门去掉后用例必须变红，
否则说明它们是恒真的。另外 `approval-gate-integration` / `preset-dispatch` /
`interrupt-before-send` 也跑过，未见回归。

## 升级

```bash
dsh plugin --profile <profile> add dsh-multitask
```

`--profile` 不能省（省了会报 `required option '--profile <name>' not specified`）。
装完要**重启应用** —— bundle 层是在启动时组装的。

> ⚠️ **给手工打过补丁的用户**：如果你曾经直接改过 `presets/multitask/coordinator-guard.mjs`
> （目录里留着 `coordinator-guard.mjs.bak-*` 之类的备份），请**先把手补丁还原成官方文件再升级**。
> 否则手补丁会与新版本**叠加**，两套修法同时生效，行为不可预期 —— 而且这是最难查的一类问题：
> 日志里看到的是"两者都不完全生效"，不是任何一方报错。

---

## English summary

Fixes the three things users actually hit.

**P0 — the `dsh web` freeze.** `tools.restrict()` in the host (`dsh-tools/lib/index.js:2991-3005`)
is called without `notify: false`, so both installing and removing a restriction emit
`tools/change`, whose handler re-runs the tool-surface check for **every registered session** — and
the old `sync()` did "release, then restrict", so each recompute fired two broadcasts. The fan-out
is `2^(N-1)·(N-1)!`-ish and kills the main thread. Two independent fixes in
`presets/multitask/coordinator-guard.mjs`: (a) a bounded recompute gate — all five entry points pass
through it, a self-triggered `tools/change` merely marks the state dirty, at most 2 merged rounds run
afterwards, and the gate is force-released in `finally`; (b) a fast path — `view().restrictableNames`
is the full inheritable surface *before* the `admits()` filter (`dsh-tools:3066-3070`), so
`deny = restrictableNames ∩ (¬keep ∪ extraDeny)` is equivalent to "release first, then read", and when
the target equals what is already installed nothing is released, restricted or emitted. Measured:
N = 12 sessions, one `tools/change` gave `restrict=179` and tripped the CAP (220) before the fix;
`restrict=0 dispose=0 emit=0` after it.

**P1 — the coordinator not ending its turn.** The host injects, unconditionally, a
`tool:subagent` section (order 2800) saying to "continue useful work while they run"
(`dsh-tool-subagent/lib/index.js:509-518`), with no config switch to turn it off, and the coordinator
persona said the same. Now: the persona gains `## Ending your turn after a dispatch` (ending the turn
is correct, the report arrives as a new turn, never fill the wait with process data, this overrides the
host sentence), and a new `presets/multitask/coordinator-prompt.mjs` registers a **same-named**
`tool:subagent` section in the coordinator's scope to shadow the host one — the documented mechanism
at `dsh-system-prompt/lib/index.js:245-249`, with `worker-persona.mjs:264-268` as precedent.

**P1.5 — silent worker stalls.** The host has no step cap, idle timeout or watchdog for
subagents (`dsh-subagent/lib/index.js:2978-2981` only declares `maxDepth` and
`maxActiveSubagents`), and the parent's only two channels — `subagent/end` (`:199-206`) and the
settlement notice (`:2040-2062`) — fire only when the child is genuinely idle. A worker stuck in
one spot therefore produces no events at all, and the parent session that ended its turn is never
woken. New `presets/multitask/subagent-watchdog.mjs` times every delegated worker on the parent
side (refreshed on `tools/post-execute`); after `stallTimeoutMs` (default 5 minutes) without any
tool activity it interrupts the child, which triggers `subagent-settled` and wakes the parent — a
stall becomes a visible report instead of an endless wait. It never re-dispatches: that decision
stays with the coordinator, who can see the report and the files.

**Upgrade**: `dsh plugin --profile <profile> add dsh-multitask`, then restart the app. If you patched
`coordinator-guard.mjs` by hand, restore the official file first — a leftover hand patch stacks on top
of the new code and produces behaviour nobody can predict.
