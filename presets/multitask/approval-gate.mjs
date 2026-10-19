/**
 * multitask-approval-gate — 让子代理的**危险操作**能弹到用户面前，由用户裁决。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * `dsh-subagent` 在委派窗口里把子会话的审批策略**钉死为 `never`**：
 *
 *     approvalPolicy: parent.ctx.get("approval") === undefined ? undefined : 'never'
 *     // 注释原文：policy is pinned to 'never' regardless of the parent's own policy.
 *
 * 后果是两级失效，**用户永远收不到审批请求**：
 *
 *   1. `dsh-user-approval` 的 `decide()` **第一行**就是
 *      `if (effectivePolicy(session) === 'never') return 'rejected'` —— 早于瀑布派发，
 *      所以 Web 应答者（`ui-approval`）根本不会被调用；
 *   2. 子代理的 system prompt 里还有一句 `operations that require approval are
 *      rejected automatically`，于是模型**自我审查**、连请求都不发起。
 *
 * 本模块把这两处一起修掉，并补上分流与转呈，构成两级闸门：
 *
 *   - **第一级（本模块的规则分类）**：安全命令直接放行，不打扰用户；
 *   - **第二级（转呈 + 上游面板）**：危险命令改成一次真实的审批请求，由用户批准/拒绝。
 *
 * ── 为什么不新建审批 UI（这一条决定了整个设计）───────────────────────────────
 *
 * 审批面板（`ui-approval`）挂在 `conversation.composer` 上，而它只为**当前正在显示的
 * 那个会话**渲染：
 *
 *     const pendingInteraction = useSessionStatus((snapshot) =>
 *       sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
 *
 * 子代理会话在侧边栏**被隐藏**（`if (session.origin === "subagent") return false`），
 * 父行也**不聚合**子会话的待审状态（父行只读 `statuses.get(s.id)`）。所以「子会话自己
 * 弹窗」这件事在后端与前端都不成立 —— 除非用户正好打开了那个子会话。
 *
 * 因此本模块采取**转呈**：子代理的请求被改写成一次**面向父会话**的审批请求，于是它
 * 落在主对话里，用上游现成的面板显示。**不新增任何 UI，不碰沙箱，不碰 DSH 源码。**
 *
 * ── B 为什么成立：`overrideOf` 取**最后一条** ─────────────────────────────────
 *
 * `dsh-user-approval` 的 `overrideOf(session)` 从会话尾部**倒序**扫描、命中即返回：
 *
 *     for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
 *       const event = session.eventAt(SessionSeq(seq));
 *       if (event?.type === "approval/policy") return event.data.policy;
 *     }
 *
 * 即「后写覆盖先写」。而 `effectivePolicy = overrideOf(session) ?? config.policy ?? 'ask'`。
 * 所以只要在委派的钉死**之后**再追加一条 `approval/policy`，子代理的有效策略就变了。
 *
 * ── B 的时序为什么无竞态（这是整件事的地基）─────────────────────────────────
 *
 * 委派的时序是（已在 `dsh-subagent` / `dsh-agent-loop` 里逐行核实）：
 *
 *     setup(childCtx, child)      // 里面同步 append 了 approval/policy = 'never'
 *     → await agents.create({ setup })
 *     → initializeAgent: 先 await setup()，再 publish()   // ← 顺序被写死
 *     → announce(agent) → await ctx.serial('agent/created', { agent })
 *
 * 关键在 `initializeAgent`：**先 await setup 再 publish**。`agent/created` 发出时，
 * `never` 已经在日志里了。所以本模块在 `agent/created` 里追加的 `ask` **必然排在它后面**，
 * `overrideOf` 必然读到 `ask`。不存在「有时早有时晚」的窗口。
 *
 * ── 为什么**直接写事件**，而不是调 `ctx.approval.setPolicy(agent, 'ask')` ───────
 *
 * `setPolicy` 干两件事：写事件 + inject 一条用户消息，而那条消息的原文是
 *
 *     The approval policy changed from "never" to "ask" (changed by the user).
 *
 * **措辞不实** —— 改策略的是插件，不是用户。一条写进会话日志、又被模型当作用户意图读的
 * 假陈述，比少一条提示糟得多。所以本模块只做前者（写事件，**省掉 `source` 字段**：
 * 带上 `source: 'delegation'` 表示「从父级委派继承而来」，而本模块做的恰恰是**纠正**
 * 委派的钉死，所以说的是反话；运行期并不校验这个字段，见下方写入处的说明），
 * 并且**不自己 inject 任何消息**。
 *
 * 那模型怎么知道策略变了？**上游自己会说**：`dsh-user-approval` 注册了一段 runtime
 * context，其文本是 `effective(agent) === 'never' ? NEVER_SENTENCE : ASK_SENTENCE`，
 * 每次组装提示词时按**当前有效策略**渲染。策略一改，下一次组装就自动变成
 * `Approval policy: ask. Operations that require approval may ask through the
 * configured answerers...`。这件事由策略所有者负责，比插件自己编一条更可靠。
 *
 * ── 为什么要改写那句误导性的 system prompt（只改策略是不够的）─────────────────
 *
 * 委派上下文是 `dsh-subagent` 通过 `childCtx.systemPrompt.context({ name:
 * 'subagent:delegation', ... })` 注册在**子代理自己的 ctx 层**上的，文本逐字为
 * `operations that require approval are rejected automatically`。只要这句还在，模型就会
 * 自我审查、不去发起需要审批的调用 —— 于是第二级闸门永远等不到请求。
 *
 * **不能**用「再注册一个同名 context」覆盖它：同层重名直接抛错
 * （`prompt context "..." is already registered in this scope`），而
 * `SystemPrompt.context()` 只做**跨层遮蔽**（scoped 遮蔽 global）。本模块的层在子代理
 * 层**之上**，注册同名条目只会被子代理层遮蔽 —— 徒劳。
 *
 * 所以改写走 `system-prompt/assemble` 瀑布：在**组装结果**上把那一条的文本换掉。
 * 这是唯一可行的位置（上游自带的 invariant 插件也用同一个瀑布做后置校验）。
 * 触发条件是**内容**而不是名字：只有文本里确实含那句假陈述时才改写，否则原样返回并
 * 记一条 warn —— 上游改了措辞时我们**不猜**，宁可少改一次也不写错话。
 *
 * ── C1-b：第一级为什么是**确定性规则**而不是 Auto 审查 ────────────────────────
 *
 * 官方 Auto 预设的规格是 `{ sandbox: 'danger-full-access', approval: 'ask' }` ——
 * **启用它会关掉文件沙箱**（其文档原文：`Auto provides no file sandbox`）。那是拆安全
 * 机制，不是加闸门。本模块因此只做**确定性模式匹配**：没有额外 LLM 请求、没有沙箱变更、
 * 行为可预测、失败方向只会是「少问一次」而不是「多放一次」。
 *
 * 第一级能加什么，沙箱加不了什么（这是本级的**真正价值**，值得写清楚）：
 *   - 沙箱保护的是**工作区之外**；工作区**之内**的破坏性命令（`rm -rf .`、
 *     `git reset --hard`、`git clean -fd`）它是允许的 —— 那正是本级的覆盖点；
 *   - 非文件类危险它完全不表达：`git push --force`、`npm publish`、`curl | sh`、
 *     提权（`sudo` / `Start-Process -Verb RunAs`）、改执行策略、杀进程、改计划任务。
 *
 * ⚠️ 本级的失败方向是**安全的**：漏判一个模式 = 和「没有本模块」完全一样（命令照旧在
 * 沙箱下执行），不会放宽任何东西。所以它只可能**增加**一次询问，绝不可能减少保护。
 *
 * ── C1-b 覆盖范围：连 PTC 程序**内部**的调用也过这里（比预期更好）────────────
 *
 * `run_code` 的 PTC 桥在派发子调用时构造的输入是
 *
 *     const input = { callId: subCallId, rootCallId: exec.rootCallId, name, schema,
 *                     arguments: normalized.dispatched, ...agent, parent: exec.token, signal }
 *     const prepared = await scheduler.prepare(input)
 *
 * 而 `scheduler.prepare` 就是 `prepareScheduledExecution` → `prepareExecution`，后者**第一件
 * 事**就是跑 `ctx.waterfall(carrier, 'tools/pre-execute', exec, ...)`。所以 PTC 程序里经
 * SDK 发起的 `pwsh` / `write` 等调用**同样**经过本模块的规则表。
 *
 * ⚠️ 但有两条**真实的**缺口，不要误以为本级覆盖了它们：
 *   1. PTC 程序体内**直连 Node 的效果**（`require('fs').writeFileSync`、
 *      `child_process.exec` 等）不经过任何内层工具审查 —— 上游文档逐字承认：
 *      `The outer run_code transport and direct Node effects inside a PTC program do
 *      not pass through inner-tool review.` 那里只剩沙箱这一层。
 *   2. `run_code` 自身**不带 `sandbox_permissions`** 时不会被本模块问；带提权时走的是
 *      沙箱自己的 `approveEscalation`（它自己发一条 `approval/request`）。
 *
 * ── C2：转呈为什么必须**先于**上游的转发者 ───────────────────────────────────
 *
 * `approval/request` 是公开瀑布，Web 应答者是通过 `ctx.remote.$on('approval/request')`
 * 注册的**转发**监听器：它把请求发给浏览器，让 `ui-approval` 构造 `PendingApproval`。
 * 如果我们排在它后面，请求已经被发走了 —— 面板已经为**子会话**渲染（不可见），
 * 我们再做什么都晚了。所以本模块 `{ prepend: true }`，并**自己**向父会话发起一次新的
 * 请求，把结果当作对原子请求的回答返回。
 *
 * 多级委派（子代理又委派了子代理）时，本模块**一次走到根**（沿 `parentSession` 上溯），
 * 而不是逐级转呈 —— 少一次递归就少一处可出错的地方，而且用户本来就该在根会话里裁决。
 *
 * ── 门控：只在**交互式**会话、且**父会话策略为 `ask`** 时启用 ──────────────────
 *
 * 这是硬前置，不是优化。headless / 无人值守部署靠 `never` 保证「不会被挂住等一个永远
 * 不会来的答复」；本模块绝不把 `never` 装到那种环境上。所以：
 *   - 父会话 `effectivePolicy !== 'ask'` ⇒ 子代理**保持 `never`**，与没有本模块时逐字等价；
 *   - 第一级也读**子代理当前的有效策略**：策略不是 `ask` 时一律 `next()` 放行，
 *     绝不让一条注定被 `never` 拒掉的 `ask` 把原本能跑的命令变成拒绝。
 *
 * ── 失败取向：静默降级（与 `subagent-mode` 同向，与 `minimal-guard` 反向）────────
 *
 * 装不上最坏是「回到今天的状态」：子代理仍是 `never`、危险命令仍照旧在沙箱下跑。
 * 这**不是**一个安全承诺失效（`minimal-guard` 那种才必须响亮告警），所以失败路径全部
 * 静默降级，每种原因只记一次 warn。但「降级」不等于「看不见」：每条路径都带固定标识，
 * 便于 grep：
 *
 *     MULTITASK-APPROVAL-GATE-ENGAGED     策略已放开、闸门已就位
 *     MULTITASK-APPROVAL-GATE-SKIPPED     跳过了（reason=… 说明为什么）
 *     MULTITASK-APPROVAL-ASK              第一级判定为危险，向用户发起审批
 *     MULTITASK-APPROVAL-RELAYED          第二级把子代理请求转呈给了父会话
 *     MULTITASK-APPROVAL-RELAY-FAILED     转呈失败（reason=…），已退回原路径
 *     MULTITASK-APPROVAL-RELAY-RETRY-*    转呈失败后唤醒父会话并重试的结果（见下节）
 *
 * ── 「回合刚好关着」：为什么会有个例，以及怎么补（本次修复）──────────────────
 *
 * 转呈有一个**硬前置**：父会话此刻必须有一个**打开的回合**。这不是本模块的约束，
 * 而是上游 `approval.request()` 的第一行：
 *
 *     if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn:
 *       the approval/asked + approval/decided audit pair must be turn-enclosed
 *       (a bare event between turns is crash-tail garbage on reload). ...")
 *
 * 而 `hasOpenTurn` 的实现是「从日志尾部倒序扫：`turn/start` 为真、`turn/end` 为假」。
 * 于是只要**子代理发起请求的那一刻**父会话的回合正好是关着的，转呈就必然失败 ——
 * 而那一刻与父会话开回合之间，可能只差**几毫秒**（磁盘实测：父会话回合于
 * `01:44:28.369` 结束，子代理于 `01:44:36.032` 发起请求且转呈失败，而父会话的
 * 回合 `01:44:36.036` 就开了 —— 3 毫秒）。
 *
 * 这类个例的成因是**后台派单**：协调者派完就不等了，父会话的回合随之结束；子代理跑完
 * 准备工作、真正要写文件时，父会话正处于空闲。它**不是随机故障**，而是「派单时机」与
 * 「子代理动手时机」错开时的必然结果 —— 所以它会在**一部分**请求上稳定复现（落在回合
 * 缝隙里的那几次），而不是偶发。
 *
 * 修法利用了兜底通知的**副作用**：`sendMessage` 的投递走 `steer` 且 `wakeup = true`，
 * 所以那条「有决定在等你」的通知会把**空闲的父会话真的唤醒**（写一个 `turn/start`）。
 * 于是本模块在发出通知之后**等那个回合打开、再转呈一次**：
 *
 *   · 只在**确认通知已送达**时才等 —— 通知没送出去就说明没有任何东西会唤醒父会话，
 *     等待纯属浪费；
 *   · 只在**第一种失败**（`outside an open turn`）时才重试。两条理由都是硬的：
 *     ① 上游那条守卫在 `session.append('approval/asked', …)` **之前**，所以重试
 *     **不可能**产生第二次 `asked`、也不可能让用户看到第二张卡；
 *     ② 别的失败原因（父会话已销毁、审批服务消失）重试既没用，又可能造成重复询问；
 *   · 有**窗口上限**（默认 10 秒，`config.relayRetryWindowMs` 可调，设 0 即关闭）；
 *   · 窗口内始终等不到就**退回原路径**，与没有这段重试时**逐字等价**（fail-closed 不变）。
 *
 * ⚠️ 通知的文案因此必须**在两种结局下都为真**：它既不能说「卡片一定在主对话里」（重试
 * 可能失败），也不能说「必须去子会话作答」（重试可能成功）。所以文案写成条件式 ——
 * 「若本对话里出现了审批卡，就在这里作答；否则打开那个子会话，提示在那里」。
 * 这个要求写在 `docs/DESIGN.md` 的「如实写出的边界」里；测试钉住的是它的**底线**
 * （`test/approval-gate-integration.mjs` 的 I28：通知不许被读成放行 —— 必须写明
 * 「这不是批准、在你作答前保持阻塞」）。⚠️ 那句**条件式措辞本身**目前没有任何用例在比对：
 * 改它时要自己把两种结局都核一遍（有卡片 / 没有卡片）。
 *
 * ── 红线（本模块绝不做的事）──────────────────────────────────────────────────
 *
 *   - 不设 `sandbox_permissions`、不关沙箱、不改沙箱模式；
 *   - 不启用 Auto 审查（会关掉文件沙箱）；
 *   - 不把 `approvalPolicy` 写进 session header（那会抛
 *     `session header uses retired policy baseline fields`）；
 *   - 不碰非委派的（协调者 / 用户）会话；不动**子代理自己的**委派策略以外的任何东西；
 *   - 父会话策略不是 `ask` 时**什么都不做**。
 *
 * @module dsh-multitask/presets/multitask/approval-gate
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-approval-gate'

/**
 * 本模块**不**声明 `inject`。
 *
 * 它需要的一切都是「探测得到、缺了就退场」的东西：`approval` / `agents` 用 `ctx.get()`
 * 试探，`systemPrompt` / `tools` 走事件与 scope 方法。声明成硬依赖反而会把一个可选能力
 * 变成安装门槛 —— 而本模块的设计前提正是「能力缺失时安静退场」，退回今天的行为。
 */
export const inject = []

/**
 * 子代理进程内委派的子会话「origin」值（`dsh-subagent` 的 `childSessionMeta` 写入）。
 * 与别的守卫模块各自留一份，是保持「预设模块互不 import」的代价（见 docs/DESIGN.md）。
 */
const SUBAGENT_ORIGIN = 'subagent'

/**
 * 需要看命令文本的 shell 工具名。
 *
 * 只列**本 composition 真的会注册**的两个（`tool-bash` / `tool-pwsh`，按平台互斥启用）
 * —— 名字错了不会报错，只会静默漏判，所以宁可少列。用户可用 `config.shellTools` 追加。
 */
const DEFAULT_SHELL_TOOLS = ['pwsh', 'bash']

/** 会把 `file_path` 指向某处、从而可能写到工作区之外的写工具。 */
const DEFAULT_FILE_TOOLS = ['write', 'edit']

/**
 * 危险命令的确定性模式表。
 *
 * 每条含 `id`（给人看、出现在询问文案里）与 `re`（正则）。**大小写不敏感**。
 * 设计取向是「确定性」：宁可少列几条，也不放一条会频繁误报的进来 ——
 * 一次误报就会让用户开始无脑点「允许」，那比不做还糟。
 *
 * ⚠️ 少了某一条的后果只是「这条命令和以前一样直接执行」，所以这张表**天然是安全的**：
 * 它决定的是「要不要多问一次」，不是「要不要放行」。
 */
/** 内置的危险模式表。导出供回归直接使用真实规则，而不是在测试里重抄一份。 */
export const DANGER_PATTERNS = [
  // ── 递归 / 强制删除（工作区**之内**的破坏，沙箱允许，正是本级要补的洞）──────
  // `rm -rf` / `rm -fr` / `rm -r -f` / `rm --recursive`（PowerShell 里 `rm` 是
  // `Remove-Item` 的别名，所以这一条在 win32 上同样命中）
  { id: 'rm-recursive-force', re: /\brm\b[^\n]*?(?:\s-[a-z]*[rf][a-z]*\b|\s--(?:recursive|force)\b)/i },
  // PowerShell：Remove-Item 带 -Recurse 或 -Force
  { id: 'remove-item-force', re: /\bRemove-Item\b[^\n]*?-(?:Recurse|Force)\b/i },
  // cmd：del /s /q、erase /q
  { id: 'cmd-del-force', re: /\b(?:del|erase)\b[^\n]*?\/[a-z]*[sq]/i },
  // cmd：rd /s、rmdir /s
  { id: 'cmd-rmdir-recursive', re: /\b(?:rd|rmdir)\b[^\n]*?\/[a-z]*s/i },
  // ⚠️ 刻意**不**单列「目标是根目录」这一条：它必然与上面两条重复（`rm -rf /` 已命中
  // `rm-recursive-force`），而单独写会误伤 `ls /`、`Get-ChildItem C:\` 这类**只读**命令。

  // ── 磁盘 / 分区 / 引导 ────────────────────────────────────────────────────
  { id: 'format-volume', re: /\bformat\s+[a-z]:/i },
  { id: 'disk-partition', re: /\b(?:diskpart|fdisk|parted|mkfs(?:\.\w+)?)\b/i },
  { id: 'raw-device-write', re: /\bdd\b[^\n]*?\bof=/i },
  { id: 'boot-config', re: /\b(?:bcdedit|bootrec)\b/i },
  { id: 'power-state', re: /\b(?:shutdown|Restart-Computer|Stop-Computer|poweroff|reboot)\b|\bhalt\b/i },

  // ── 版本控制：不可逆地丢工作 / 改远端历史 ──────────────────────────────────
  { id: 'git-force-push', re: /\bgit\s+push\b[^\n]*?(?:--force(?:-with-lease)?\b|(?<![\w-])-f\b)/i },
  { id: 'git-reset-hard', re: /\bgit\s+reset\b[^\n]*?--hard\b/i },
  // ⚠️ 必须要求出现 `f`：`git clean -nd` 是**干跑**（dry run），把它也问一遍是纯噪音。
  { id: 'git-clean-force', re: /\bgit\s+clean\b[^\n]*?-[a-z]*f/i },
  { id: 'git-rewrite-history', re: /\bgit\s+(?:filter-branch|filter-repo)\b/i },
  { id: 'git-remote-remove', re: /\bgit\s+remote\s+(?:remove|rm)\b/i },
  { id: 'git-discard-worktree', re: /\bgit\s+(?:checkout|restore)\b[^\n]*?(?:--\s+\.|\s\.\s*$)/i },

  // ── 发布 / 外发（不可撤回）────────────────────────────────────────────────
  { id: 'package-publish', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish)\b/i },
  { id: 'crate-publish', re: /\bcargo\s+(?:publish|yank)\b/i },
  { id: 'python-publish', re: /\btwine\s+upload\b/i },
  { id: 'nuget-push', re: /\bdotnet\s+nuget\s+push\b/i },
  { id: 'container-push', re: /\bdocker\s+push\b/i },

  // ── 提权 ──────────────────────────────────────────────────────────────────
  { id: 'privilege-escalation', re: /\b(?:sudo|doas|pkexec|runas|gsudo)\b/i },
  { id: 'elevated-spawn', re: /\bStart-Process\b[^\n]*?-Verb\s+RunAs\b/i },
  { id: 'execution-policy', re: /\bSet-ExecutionPolicy\b/i },
  // ⚠️ 要求写动词：`net user` 单独一条是**只读**的（列出账户），不能问。
  { id: 'account-mutation', re: /\bnet\s+(?:user|localgroup)\b[^\n]*?\/(?:add|delete)\b|\b(?:New|Remove|Set|Enable|Disable)-LocalUser\b|\bAdd-LocalGroupMember\b/i },
  { id: 'registry-mutation', re: /\breg\s+(?:add|delete|import|restore)\b|\b(?:Set|New|Remove)-ItemProperty\b[^\n]*?HKLM/i },
  { id: 'service-mutation', re: /\bsc\s+(?:create|delete|config)\b|\b(?:New|Remove)-Service\b/i },
  { id: 'scheduled-task', re: /\bschtasks\b|\b(?:New|Register|Unregister|Disable)-ScheduledTask\b/i },
  // ⚠️ `icacls <路径>` / `cacls <路径>`（**不带任何变更开关**）是只读的 —— 它只是**显示** ACL。
  //     早期版本对它们一律发问，结果连「读一下这个目录的权限」都要用户点一次允许。
  //     **这不是理论问题**：本模块自己的验证流程就撞到过它 —— 给子代理的 brief 让它跑
  //     `icacls .` 汇报权限，于是弹了一次窗，用户不得不为一个只读命令点「允许」。
  //     所以这里要求**出现变更类开关**才算危险。
  //     `takeown` 的用途本身就是接管所有权（`/f` 是它的必需参数），所以照旧一律问。
  //     `chmod` / `chown` 同理：只问递归与系统路径（`chmod +x` 是构建脚本日常）。
  {
    id: 'ownership-change',
    re: /\btakeown\b|\b(?:icacls|cacls)\b[^\n]*?\s\/(?:grant|deny|remove|setowner|reset|restore|inheritance|substitute|g|p|d|e|r)\b|\b(?:chown|chmod)\b[^\n]*?\s-R\b|\b(?:chown|chmod)\b[^\n]*?(?:[a-z]:[\\/](?:Windows|Program Files(?: \(x86\))?)\b|\/(?:etc|usr|bin|sbin|boot|dev|proc|sys)\/)/i,
  },
  // ⚠️ 只在**写**的用法上问：`wmic process list` 是只读查询。
  { id: 'wmi-mutation', re: /\bwmic\b[^\n]*?\b(?:call|create|delete|set)\b/i },
  { id: 'firewall-mutation', re: /\bnetsh\b[^\n]*?\b(?:add|delete|set)\b/i },

  // ── 动态求值 / 下载即执行 / 混淆 ──────────────────────────────────────────
  { id: 'invoke-expression', re: /\b(?:Invoke-Expression|iex)\b/i },
  { id: 'pipe-to-shell', re: /\|\s*(?:(?:ba|z|k|d)?sh|bash|zsh|pwsh|powershell)\b/i },
  { id: 'pipe-to-iex', re: /\|\s*(?:iex|Invoke-Expression)\b/i },
  { id: 'encoded-command', re: /(?:-|\/)EncodedCommand\b/i },
  { id: 'certutil-download', re: /\bcertutil\b[^\n]*?-urlcache\b/i },
  { id: 'bitsadmin', re: /\bbitsadmin\b/i },

  // ── 系统路径**写入**（必须带写意图，否则 `ls /etc` 会被误问）───────────────
  {
    id: 'system-path-write',
    re: /(?:>>?\s*|\b(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Set-Item|Copy-Item|Move-Item|Rename-Item)\b[^\n]*?)(?:[a-z]:[\\/](?:Windows|Program Files(?: \(x86\))?|ProgramData)\b|\/(?:etc|usr|bin|sbin|boot|dev|proc|sys)\/)/i,
  },
  // 凭据文件的**写入**（读取不问：读凭据不具破坏性，问它是噪音）。
  {
    id: 'credential-write',
    re: /(?:>>?\s*|\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|rm|del|erase)\b[^\n]*?)(?:\.ssh[\\/]|id_rsa\b|id_ed25519\b|\.aws[\\/]credentials|\.git-credentials|\.npmrc\b)/i,
  },

  // ── 进程 ──────────────────────────────────────────────────────────────────
  { id: 'kill-all', re: /\btaskkill\b[^\n]*?\/[a-z]*f\b|\bStop-Process\b[^\n]*?-Force\b|(?<![\w-])kill\s+-9\s+-\d/i },
]

/**
 * 即使命中上面的模式也**直接放行**的命令（误报出口）。
 *
 * 与危险表相反：这里放的是「看着像、实际无害」的常见写法。刻意留空 ——
 * 没有实测依据就不要往这里加，因为它是一条**抑制询问**的通道。
 */
const SAFE_PATTERNS = []

/** 「需要审批」的审计理由前缀（英文，写进 durable 日志）。 */
const ASK_REASON_PREFIX = 'Multitask approval gate'

/**
 * 上游 `approval.request()` 在「父会话没有打开的回合」时抛出的原文里的一段。
 *
 * 用它**识别失败种类**：只有这一类失败值得等 —— 因为兜底通知会把空闲的父会话唤醒，
 * 回合随后就会打开（见文件头「回合刚好关着」一节）。别的失败原因等下去不会变好。
 *
 * ⚠️ 用子串而不是整句：上游那句话很长（`approval.request() outside an open turn:
 * the approval/asked + approval/decided audit pair must be turn-enclosed ...`），
 * 后面那段解释属于**措辞**，改它不该让本模块的重试静默失效。
 */
const OPEN_TURN_REQUIRED_HINT = 'outside an open turn'

/**
 * 转呈重试的默认窗口（毫秒）。
 *
 * 磁盘实测：父会话回合结束与子代理发起请求之间只差 7.7 秒，而父会话被唤醒后
 * **3 毫秒**就开了回合。所以 10 秒对这个用途是宽裕的；它真正防的是「父会话永远不会醒来」
 * （窗口关闭、部署异常）时不要把子代理无限挂住。
 */
const DEFAULT_RELAY_RETRY_WINDOW_MS = 10000

/**
 * 轮询间隔（毫秒）。
 *
 * 必须远小于窗口（否则一次轮询就吃掉整个窗口），也远大于零（否则变成忙等待）。
 * 100ms 的代价可以忽略：这段时间里子代理本来就在等审批。
 */
const RELAY_RETRY_POLL_MS = 100

/**
 * 等「通知是否送达」的上限（毫秒）。
 *
 * 只用来回答一个问题：「有没有东西会去唤醒父会话」。`sendMessage` 是一次本地投递，
 * 正常在毫秒级返回；给它 2 秒是防御它意外挂住 —— 那种情况下**不重试**才是对的
 * （没有送达就没有唤醒，等下去只是白等）。
 */
const NOTIFY_ACK_TIMEOUT_MS = 2000

/** 每次进程只警告一次的记录器（与同仓守卫同款，避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/approval-gate: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 与 `coordinator-guard.mjs` / `minimal-guard.mjs` / `subagent-mode.mjs` 用**同一条判据**
 * （`origin` / `parentSession` / `delegationDepth` 三信号）。判错的方向在这里是：
 * 把一个**用户会话**当成子代理，就会去改它的审批策略 —— 那是改用户的会话，
 * 属于越界，所以三信号判据必须与其他守卫保持一致。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为被委派的子代理。
 */
export function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === SUBAGENT_ORIGIN) return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 编译一组模式（内含的字符串 / 正则都接受），坏模式只记一次警告并跳过。
 *
 * @param entries - `{ id, re }` 或裸字符串 / RegExp。
 * @param warn - 警告函数。
 * @returns 可用的 `{ id, re }` 数组。
 */
function compilePatterns(entries, warn) {
  const out = []
  for (const entry of entries) {
    const source = entry?.re ?? entry
    const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : String(source)
    try {
      out.push({ id, re: source instanceof RegExp ? source : new RegExp(String(source), 'i') })
    } catch (error) {
      warn(`ignoring a malformed danger pattern ${JSON.stringify(id)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return out
}

/**
 * 对一条 shell 命令做确定性危险判定。
 *
 * 纯函数、无副作用、不抛错 —— 这样可以脱离 DSH 运行时被测试与复用。
 * `SAFE_PATTERNS` 优先于危险表（它是误报出口）。
 *
 * @param command - 命令文本。
 * @param danger - 已编译的危险模式表。
 * @param safe - 已编译的放行模式表。
 * @returns 命中时的模式 id，否则 undefined。
 */
export function classifyShellCommand(command, danger = DANGER_PATTERNS, safe = SAFE_PATTERNS) {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  for (const { re } of safe) {
    try {
      if (re.test(command)) return undefined
    } catch {
      // 单个模式出错不影响其余判定。
    }
  }
  for (const { id, re } of danger) {
    try {
      if (re.test(command)) return id
    } catch {
      // 同上。
    }
  }
  return undefined
}

/**
 * 把路径字符串规范化到可比较的形式（不 import `node:path`，见下）。
 *
 * 为什么自己写而不是用 `node:path`：本仓库的预设模块约定「零 import」（彼此不 import，
 * 也不引入运行时依赖），而这个判断只需要「看起来是不是绝对路径 / 有没有往上层逃逸」，
 * 不需要真的解析到文件系统。**误判方向也是安全的**：漏判只是少问一次（命令照旧在
 * 沙箱下执行），不会放宽任何东西。
 *
 * @param value - 原始路径。
 * @returns `{ absolute: boolean, escapes: boolean, normalized: string }`。
 */
export function inspectPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { absolute: false, escapes: false, normalized: '' }
  }
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  // `~` 与 `~/x` 指向**家目录** —— 它不在工作区里（除非工作区就是家目录，那种情况下面
  // 按前缀比较仍然判得对）。把 `~` 当作绝对路径处理，否则 `~/.ssh/id_rsa` 会被当成
  // 「普通的相对路径」而放行，那是一个真实的漏判。
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized === '~' || normalized.startsWith('~/')
  // 只有**开头**的上溯才算逃逸：`a/../b` 仍在原地附近，`../../etc` 才是往外走。
  const escapes = /^(?:\.\.\/)+/.test(normalized)
  return { absolute, escapes, normalized }
}

/**
 * 判断一次写操作的目标是否**落在工作区之外**。
 *
 * 语义刻意保守：
 *   - 相对路径且不含**前导**上溯 ⇒ 认为在工作区内（沙箱自己会兜底）；
 *   - 绝对路径 ⇒ 与工作区前缀比对（win32 上大小写不敏感）；
 *   - 前导 `../` ⇒ 视为逃逸（这是最常见的一种「想往外面写」的写法）。
 *
 * @param filePath - 工具的 `file_path` 参数。
 * @param cwd - 会话工作目录（`session.header.cwd`）。
 * @param caseInsensitive - 是否大小写不敏感（win32 为 true）。
 * @returns 目标是否在工作区之外。
 */
export function escapesWorkspace(filePath, cwd, caseInsensitive) {
  const target = inspectPath(filePath)
  if (target.normalized === '') return false
  if (target.escapes) return true

  const root = inspectPath(cwd)
  if (!target.absolute) return false
  if (root.normalized === '') return true

  const fold = (text) => (caseInsensitive ? text.toLowerCase() : text)
  const a = fold(target.normalized)
  const b = fold(root.normalized).replace(/\/+$/, '')
  return !(a === b || a.startsWith(`${b}/`))
}

/**
 * 从 `exec` 上取一个字符串参数（工具参数是冻结的普通对象）。
 *
 * @param exec - 工具执行输入。
 * @param name - 参数名。
 * @returns 字符串参数，或 undefined。
 */
function stringArg(exec, name) {
  const value = exec?.arguments?.[name]
  return typeof value === 'string' ? value : undefined
}

/** 需要**递归删除**语义的模式 id —— 「删除能不能放行」只认这一组。 */
const DELETION_PATTERN_IDS = new Set([
  'rm-recursive-force',
  'remove-item-force',
  'cmd-del-force',
  'cmd-rmdir-recursive',
])

/**
 * 默认视为**免询问**的临时根目录。
 *
 * ── 为什么临时目录值得单独开一档 ─────────────────────────────────────────────
 *
 * 临时目录是**所有进程共享的草稿纸**：DSH 自己就在那里建 `dsh-subagent-*`、
 * `dsh-acl-locks` 之类的目录。一个 worker 往那里写中间产物是正常工作，不是危险操作 ——
 * 为它弹一次审批，只会训练用户「闭眼点允许」，那反而削弱了真正的危险询问。
 *
 * ── 为什么只从环境变量推导，不 import `node:os` ────────────────────────────
 *
 * 本仓库的预设模块约定「零 import」（彼此不 import，也不引入运行时依赖）。
 * `os.tmpdir()` 的取值本来就来自这些环境变量，直接读它们是等价且无依赖的。
 * win32 上补一条 `%LOCALAPPDATA%\Temp`，因为 `TEMP` 偶尔会被某些父进程改掉。
 *
 * @returns 规范化后的根目录列表（去重、去尾斜杠）。
 */
export function defaultTempRoots() {
  const candidates = []
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (typeof local === 'string' && local.trim() !== '') candidates.push(`${local}\\Temp`)
  }
  candidates.push('/tmp')

  const roots = []
  const seen = new Set()
  for (const entry of candidates) {
    const normalized = inspectPath(entry).normalized.replace(/\/+$/, '')
    if (normalized === '') continue
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(normalized)
  }
  return roots
}

/**
 * 判断一个路径是否落在**允许根**之下（含根目录本身）。
 *
 * 只做词法比较，不碰文件系统 —— 与 `escapesWorkspace` 同一取向：不需要真的解析，
 * 而且**误判方向是安全的**（判成「不在根下」只是多问一次）。
 *
 * @param filePath - 待判定的路径。
 * @param roots - 已规范化的允许根。
 * @param caseInsensitive - 是否大小写不敏感（win32 为 true）。
 * @returns 落在任一允许根下时为 true。
 */
export function isUnderRoots(filePath, roots, caseInsensitive) {
  if (!Array.isArray(roots) || roots.length === 0) return false
  const target = inspectPath(filePath)
  if (target.normalized === '' || !target.absolute || target.escapes) return false

  const fold = (text) => (caseInsensitive ? text.toLowerCase() : text)
  const a = fold(target.normalized)
  for (const root of roots) {
    const b = fold(String(root)).replace(/\/+$/, '')
    if (b === '') continue
    if (a === b || a.startsWith(`${b}/`)) return true
  }
  return false
}

/**
 * shell 元字符 —— 出现任何一个就**不**做「删除放行」的判定。
 *
 * 理由：这条豁免一旦误判，就会把「真正危险的一整行命令」放过去；而多问一次只是
 * 一次点击。所以宁可只认**最简单**的形态（单个删除命令 + 纯路径参数）。
 */
const SHELL_METACHARACTERS = /[;|&`$><]/

/**
 * 判断一条**删除**命令是否只作用于允许根（默认是临时目录）。
 *
 * 判定刻意保守，四个条件缺一不可：
 *   1. 命令行里**没有** shell 元字符（管道、串联、重定向、变量展开、命令替换都不认）；
 *   2. 至少有一个**绝对路径**参数；
 *   3. **所有**绝对路径参数都落在允许根下；
 *   4. 相对路径参数也算数：它会让「到底删的是哪」变得不可判定，所以直接判否。
 *
 * 于是 `rm -rf /tmp/x` 放行，而 `rm -rf /tmp/x /home/u`、`rm -rf $env:TEMP\x`、
 * `Remove-Item -Recurse C:\Windows` 都要询问。
 *
 * @param command - 命令文本。
 * @param roots - 已规范化的允许根。
 * @param caseInsensitive - 是否大小写不敏感。
 * @returns 可以视为「仅清理允许根」时为 true。
 */
export function confinedToRoots(command, roots, caseInsensitive) {
  if (typeof command !== 'string' || command.trim() === '') return false
  if (!Array.isArray(roots) || roots.length === 0) return false
  if (SHELL_METACHARACTERS.test(command)) return false

  const tokens = command
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter((token) => token !== '')

  const paths = []
  for (const token of tokens) {
    const inspected = inspectPath(token)
    if (inspected.normalized === '') continue
    // `-Recurse` / `--force` 这类选项不是路径；它们的 `inspectPath` 结果既不是绝对路径
    // 也不含 `/`，跳过即可（真正的判定只看路径 token）。
    if (!inspected.absolute && !inspected.normalized.includes('/')) continue
    paths.push(token)
  }

  if (paths.length === 0) return false
  return paths.every((token) => isUnderRoots(token, roots, caseInsensitive))
}

/**
 * 判定一次工具调用是否需要征求用户同意（第一级闸门）。
 *
 * @param exec - 工具执行输入（含 `name` / `arguments`）。
 * @param options - 编译好的模式表、工具名集合、工作区信息与允许根。
 * @returns 命中时的描述，否则 undefined。
 */
export function classifyExecution(exec, options) {
  const toolName = exec?.name
  if (typeof toolName !== 'string' || toolName === '') return undefined
  const tempRoots = Array.isArray(options?.tempRoots) ? options.tempRoots : []

  if (options.shellTools.has(toolName)) {
    const command = stringArg(exec, 'command')
    const hit = classifyShellCommand(command, options.danger, options.safe)
    if (hit === undefined) return undefined
    // 删除类命令：只有当它**只**碰允许根（临时目录）时才算清理，不打扰用户。
    if (DELETION_PATTERN_IDS.has(hit) && confinedToRoots(command, tempRoots, options.caseInsensitive)) {
      return undefined
    }
    return { kind: 'shell', pattern: hit, command }
  }

  if (options.fileTools.has(toolName)) {
    const filePath = stringArg(exec, 'file_path')
    if (filePath === undefined) return undefined
    if (escapesWorkspace(filePath, options.cwd, options.caseInsensitive)) {
      // 往临时目录里写是草稿行为：DSH 自己就在那里建运行时目录。
      if (isUnderRoots(filePath, tempRoots, options.caseInsensitive)) return undefined
      return { kind: 'file', pattern: 'write-outside-workspace', filePath }
    }
    return undefined
  }

  return undefined
}

/**
 * 沿 `parentSession` 上溯到**根**祖先 agent。
 *
 * 一次走到根（而不是逐级转呈）的理由：用户本来就该在根会话里裁决；少一层递归就少一处
 * 可出错的地方。加迭代上限是为了防御一条**畸形的**父链（不该出现，但真出现时不能变成
 * 死循环 —— 那会把子代理挂死）。
 *
 * @param ctx - 插件上下文（用于取 `agents` 服务）。
 * @param agent - 起点（子代理）。
 * @param limit - 最大上溯层数。
 * @returns 根祖先 agent；取不到时返回 undefined。
 */
function rootAncestorOf(ctx, agent, limit = 8) {
  let current = agent
  for (let hop = 0; hop < limit; hop += 1) {
    const header = current?.session?.header
    const parentId = header?.parentSession
    if (typeof parentId !== 'string' || parentId === '') return current
    const parent = agentById(ctx, parentId)
    if (parent === undefined || parent === null) return undefined
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * 按会话 id 找回一个**活着的** agent（与 `coordinator-guard.mjs` 同款容错写法）。
 *
 * @param ctx - 插件上下文。
 * @param id - 会话 / agent id。
 * @returns 该 agent，或 undefined。
 */
function agentById(ctx, id) {
  try {
    const agents = ctx?.get?.('agents')
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
    return agents.get(id)
  } catch {
    return undefined
  }
}

/**
 * 读一个会话当前的有效审批策略。
 *
 * `effectivePolicy` 是公开方法（反射声明 `effectivePolicy`），读的是
 * `overrideOf(session) ?? config.policy ?? 'ask'`。读不到时返回 undefined ——
 * 调用点一律把「读不到」当作**不满足门控**处理（保守方向：什么都不做）。
 *
 * @param ctx - 插件上下文。
 * @param session - 目标会话。
 * @returns `'ask'` / `'never'`，或 undefined。
 */
function effectivePolicyOf(ctx, session) {
  try {
    const approval = ctx?.get?.('approval')
    if (approval === undefined || approval === null || typeof approval.effectivePolicy !== 'function') return undefined
    const policy = approval.effectivePolicy(session)
    return typeof policy === 'string' ? policy : undefined
  } catch {
    return undefined
  }
}

/**
 * 装载本模块。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行在 composition 里的 `config`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)
  const danger = compilePatterns([...DANGER_PATTERNS, ...(config?.extraDangerPatterns ?? [])], warn)
  const safe = compilePatterns([...(config?.safePatterns ?? []), ...SAFE_PATTERNS], warn)
  const shellTools = new Set([...DEFAULT_SHELL_TOOLS, ...(config?.shellTools ?? [])])
  const fileTools = new Set([...DEFAULT_FILE_TOOLS, ...(config?.fileTools ?? [])])
  const caseInsensitive = process.platform === 'win32'

  /**
   * 「免询问」的根目录：往这里写文件、或只删这里的东西，都当作草稿行为放行。
   *
   * 默认是各平台临时目录（见 `defaultTempRoots()`）。`config.autoApproveTempRoots`
   * 可以**替换**它（传空数组 = 关掉这一档，连临时目录也要问）。
   *
   * ⚠️ 这一档只影响**询问**，不影响沙箱：能写到哪里仍然由 DSH 的沙箱与 ACL 决定。
   * 在这里放宽的只是「要不要打扰用户」，不是「能不能做」。
   */
  const tempRoots = Array.isArray(config?.autoApproveTempRoots)
    ? config.autoApproveTempRoots
        .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => inspectPath(entry).normalized.replace(/\/+$/, ''))
        .filter((entry) => entry !== '')
    : defaultTempRoots()

  /**
   * 已经放开过策略的子代理。
   *
   * `agent/created` 每次创建 / 恢复都会发（`source` 为 `startup` 或 `resume`），
   * 而本模块的处理对同一个 agent 只需一次，所以要按对象去重。
   * 用 WeakSet 而不是 Set：agent 被回收后不该由本模块持有强引用。
   */
  const released = new WeakSet()

  /** 已经注册过委托上下文改写的子代理（改写的注册也只能一次）。 */
  const rewritten = new WeakSet()

  /**
   * 「上游改了措辞」只提示一次。
   *
   * ⚠️ 这个标志**必须有**，因为改写回调跑在**每次**提示词组装上（那是热路径）：
   * 每次组装都记一条日志，会变成一个长请求里的刷屏源 —— 而它要说的其实只有一件事
   * 「措辞变了，去看一眼」。`warnOnce` 挡住了 warn 那一路，但 info 那一路是按次累加的，
   * 所以这里必须自己设一道闸。
   */
  let wordingNoticed = false

  /**
   * 累计「跳过」的次数，按原因分桶。
   *
   * `warnOnce` 挡住了刷屏，但它把「刚刚又跳过了几次」也一起吞掉了。这里补的正是那一半：
   * warn 仍然每因只报一次（不刷屏的承诺不变），另有一条 info 随 count 递增，
   * 于是「跳过了几次、为什么」成为可 grep 的事实。
   */
  const skipCounts = new Map()

  /**
   * 记一次「本模块没有动作」，两条日志都带固定标识。
   *
   * @param reason - 失败分支短名（ASCII kebab-case）。
   * @param detail - 给人看的完整句子。
   */
  const noteSkipped = (reason, detail) => {
    const count = (skipCounts.get(reason) ?? 0) + 1
    skipCounts.set(reason, count)
    warn(`${detail} [MULTITASK-APPROVAL-GATE-SKIPPED reason=${reason}]`)
    try {
      ctx.logger?.info?.(
        `dsh-multitask: MULTITASK-APPROVAL-GATE-SKIPPED reason=${reason} count=${count}`,
      )
    } catch {
      // 与 warnOnceFactory 同理：日志通道不可用不能反过来炸掉会话。
    }
  }

  /**
   * 把子代理的委派上下文改写为「可以请求批准」的版本。
   *
   * 触发条件是**内容**（必须含 `are rejected automatically`）而不是只有名字：上游改了措辞
   * 时本模块**不猜**，宁可少改一次也不写错话，并留一条 warn 让人知道需要跟进。
   *
   * 注册在**子代理自己的 ctx** 上，所以只影响这个子代理的提示词组装，兄弟与父会话都看不到。
   *
   * @param agent - 已放开的子代理。
   */
  const rewriteDelegationContext = (agent) => {
    if (rewritten.has(agent)) return
    const childCtx = agent?.ctx
    if (typeof childCtx.on !== 'function') {
      noteSkipped('no-child-ctx', 'the subagent scope exposes no event registry; its delegation context still claims approvals are rejected automatically')
      return
    }
    try {
      // 后置改写（先 next() 再改返回值）：上游自带的 invariant 插件用同一个瀑布做校验，
      // 所以这是这个瀑布上**既定的**后置位置。`assembly.contexts` 是本次组装的结果数组。
      childCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const assembled = await next()
        return rewriteContexts(assembled)
      })
      rewritten.add(agent)
    } catch (error) {
      noteSkipped(
        'context-rewrite-threw',
        `registering the delegation-context rewrite failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 在组装结果上把 `subagent:delegation` 那条 context 换成不误导的文本。
   *
   * @param assembled - 上游组装结果。
   * @returns 改写后的组装结果（不可改时原样返回）。
   */
  const rewriteContexts = (assembled) => {
    if (assembled === null || typeof assembled !== 'object' || !Array.isArray(assembled.contexts)) return assembled
    let touched = false
    const contexts = assembled.contexts.map((entry) => {
      if (entry?.name !== 'subagent:delegation' || typeof entry.text !== 'string') return entry
      if (!entry.text.includes(APPROVAL_CLAIM)) {
        // 上游改了措辞 —— 只提示**一次**，让人去看一眼新文本是否仍然误导。
        //
        // ⚠️ 这里的 `wordingNoticed` 闸门是必须的：本函数跑在**每次**提示词组装上，
        // 而「措辞不匹配」是个**恒定**条件 —— 没有这道闸，一个长请求里每次组装都会
        // 追加一条 info，日志会被这一件事淹掉（而那件事只需要看一次）。
        if (!wordingNoticed) {
          wordingNoticed = true
          noteSkipped(
            'context-wording-changed',
            'the delegation context no longer contains the "rejected automatically" claim; the rewrite was skipped (check whether the new wording is still accurate)',
          )
        }
        return entry
      }
      touched = true
      return { ...entry, text: entry.text.replace(APPROVAL_CLAIM, RELAYED_CLAIM) }
    })
    if (!touched) return assembled
    return { ...assembled, contexts }
  }

  /**
   * 放开一个子代理的审批策略 —— 本模块的核心动作（B）。
   *
   * 门控顺序刻意如此：**先**确认父会话策略是 `ask`，**再**动子会话。反过来的话，
   * 一个 headless 部署的子代理会先被放开、再被回滚，中间那段时间是不该有的窗口。
   *
   * @param agent - 新建 / 恢复的子代理。
   */
  const releasePolicy = (agent) => {
    if (released.has(agent)) return

    const approval = ctx.get('approval')
    if (approval === undefined || approval === null || typeof approval.effectivePolicy !== 'function') {
      noteSkipped('no-approval-service', 'this deployment composes no approval service, so subagents keep the pinned policy')
      return
    }

    // ── 门控：父会话必须是交互式的（`ask`）────────────────────────────────────
    const parent = rootAncestorOf(ctx, agent)
    if (parent === undefined) {
      noteSkipped('no-parent', 'the delegating parent agent is no longer live, so the subagent keeps the pinned policy')
      return
    }
    const parentPolicy = effectivePolicyOf(ctx, parent.session)
    if (parentPolicy !== 'ask') {
      noteSkipped(
        'parent-not-interactive',
        `the delegating session's approval policy is ${parentPolicy === undefined ? 'unreadable' : `"${parentPolicy}"`}, so this subagent keeps the pinned policy (headless deployments rely on this)`,
      )
      return
    }

    // ── 已经就是 `ask` 时不必再写一条事件 ─────────────────────────────────────
    if (effectivePolicyOf(ctx, agent.session) === 'ask') {
      released.add(agent)
      rewriteDelegationContext(agent)
      return
    }

    const session = agent?.session
    if (session === undefined || session === null || typeof session.append !== 'function') {
      noteSkipped('no-session-append', 'the subagent session exposes no append(); its policy stays pinned')
      return
    }

    try {
      // ── 关于 `source`：省略它是对的，但原来给的那个理由本身是错的 ──────────────
      //
      // 曾经写在这里的说法（「只有 `delegation` 这一个取值才是合法的」）**不准确**。
      // 核实结果：
      //
      //   · **运行期不校验 `source`**。`approval/policy` 在运行期唯一的校验是词表检查
      //     （只比对 `policy ∈ ["ask","never"]`），完全不看 `source`。
      //   · `'delegation'` 是**迁移期**的取值约束：它写在 `disposition(["policy"],
      //     ["source"])` 里（`source` 是 optional 位），只由 v0/v1 旧格式的迁移阶段
      //     （`assertReleasedPayloadSemantics` ← `assertReleasedEventPayload` ←
      //     `DecodedReleasedV1ToV2Stage.transformEvent`）执行。当前会话格式是 v4，
      //     这条路径不会走到我们写的事件上。
      //   · 所以带上 `source: 'delegation'` **不会抛错**（它正是那个被允许的值）。
      //
      // 那为什么仍然省略？因为**带上是如实的反面**：`source: 'delegation'` 表示「这个值
      // 是从父级委派继承来的」，而本模块做的恰恰是**纠正**委派的钉死（父级写的是 `never`，
      // 我们写 `ask`）。省略 `source` 才是「非委派来源」的如实表达。
      //
      // ⚠️ 这条写入**会落进会话日志**（这是 `overrideOf` 唯一能读到的地方 —— 策略不能写
      // session header，那会抛 `session header uses retired policy baseline fields`）。
      // 用户已明确接受这处持久化写入。
      //
      // 另：这条写入**能跨重启存活**，不需要恢复路径。载入期只丢弃「最后一条没有换行的
      // 不完整记录」（torn tail），与事件是否在回合内无关；而 `approval/policy` 不在任何
      // 回合包含校验里（只有 `approval/asked` / `approval/decided` 要求回合归属）。
      session.append('approval/policy', { policy: 'ask' })
    } catch (error) {
      noteSkipped(
        'append-threw',
        `appending the subagent approval policy failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    // ⚠️ 落库成功**之后**才记为已处理。这个顺序有实际后果：上面每一条早退路径都可能是
    // **暂时的**（服务尚未就绪、父 agent 尚未在册…），而 `agent/created` 在**冷恢复**时
    // 会再发一次 —— 那时重试是正确行为。反过来，若在开头就登记，一次瞬时缺席会让这个
    // worker 永远停在 `never` 上、且没有任何重来的机会。
    released.add(agent)

    // 策略已放开 —— 现在把那句「会自动拒绝」的误导文案改掉，否则模型仍不发起请求。
    rewriteDelegationContext(agent)

    try {
      ctx.logger?.info?.(
        'dsh-multitask: subagent approval policy released to "ask" for one delegated worker; ' +
          'approval-requiring calls now route to the user [MULTITASK-APPROVAL-GATE-ENGAGED]',
      )
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }

  /**
   * 记一次「兜底通知」的结果（发送成功 / 跳过 / 失败）。
   *
   * 标识与 `MULTITASK-APPROVAL-RELAY-*` 分开：转呈（首选闭环路径）与通知（兜底）是两件
   * 不同的事，日志里必须能一眼分清「这次是拿到了用户决定，还是只递了个信」。
   *
   * ⚠️ 这三个标识**不**经过 `warn`，只走 info：通知是尽力而为的辅助动作，失败不该以
   * warning 的形态出现（那会让日志看起来像闸门坏了）。真正的失败事实由
   * `MULTITASK-APPROVAL-RELAY-FAILED` 承担。
   *
   * @param kind - `SENT` / `SKIPPED` / `FAILED`。
   * @param reason - 跳过 / 失败原因的短名（ASCII kebab-case）；成功时不传。
   * @param detail - 给人看的补充说明。
   */
  const noteNotify = (kind, reason, detail) => {
    try {
      ctx.logger?.info?.(
        `dsh-multitask: MULTITASK-APPROVAL-NOTIFY-${kind}` +
          `${reason === undefined ? '' : ` reason=${reason}`}` +
          `${detail === undefined ? '' : ` — ${detail}`}`,
      )
    } catch {
      // 日志通道不可用不能反过来炸掉审批。
    }
  }

  /**
   * 转呈失败时的兜底通知（问题 1 的 (d)）：尽力把「有个决定在等你」送到用户眼前。
   *
   * ── 为什么需要它 ─────────────────────────────────────────────────────────────
   *
   * 转呈（首选闭环路径）要求父会话**此刻有一个打开的回合**。后台派单 + 回合结束再等回调
   * 时那个条件不成立，于是请求会落到子会话自己身上 —— 而子会话在侧边栏**被隐藏**
   * （`session.origin === 'subagent'` 的行不渲染）、页头子代理目录也不显示审批态，
   * 所以用户**看不到任何提示**。更糟的是它不会失败：客户端的 Gateway 会为任意 agentId
   * **无条件物化作用域**，于是请求被接住并**无限挂着**（审批路径没有任何超时），
   * 而子代理的工具调用就此阻塞。这条通知是让用户**知道并找得到**那个请求的唯一手段。
   *
   * ── 为什么走 `sendMessage` 而不是别的手段 ─────────────────────────────────────
   *
   * `sendMessage` 是上游唯一为「resident continuable child → 直接父会话」准备的通道，
   * 且它投递时 `wakeup = true` —— 空闲的父会话会**真的开一个回合**，于是这条消息落在
   * 主对话的对话流里（`user/message` + `source.kind='agent-message'`，带 surface op）。
   * 用户看得见，不是静默收件箱。
   *
   * ── 它**不**是批准（这一点必须写死在实现与文档里）─────────────────────────────
   *
   * 消息通道不携带审批结果。用户读完之后仍然要**去那个子会话里作答**，子代理才能拿到
   * 决定。所以这条通知的作用是「指路」，绝不是「替代同意」——
   * 文案里明确写了「在你作答之前那次调用保持阻塞，不要绕过」，避免协调者把它读成放行。
   *
   * ── 三条硬约束 ───────────────────────────────────────────────────────────────
   *
   *   1. **绝不改变返回值**：任何失败都只记日志，调用方仍然退回原路径（fail-closed）；
   *   2. **不猜**：只有当「直接父会话」正好等于我们要转呈的那个会话时才发 ——
   *      `sendMessage` 只支持**直接**父/子，多级委派时发不到根，那就干脆不发（记原因）；
   *   3. **不打扰已取消的请求**：signal 已中止时跳过。
   *
   * @param context - 子代理、父会话、工具名、子会话 id 与沿用 signal。
   * @returns 是否真的发出去了（仅供日志与测试使用，不影响审批结果）。
   */
  const notifyRelayFailure = async (context) => {
    const { agent, parent, toolName, childId, signal, detail } = context

    if (config?.notifyOnRelayFailure === false) {
      noteNotify('SKIPPED', 'disabled-by-config')
      return false
    }

    const subagents = ctx.get('subagents')
    if (subagents === undefined || subagents === null || typeof subagents.sendMessage !== 'function') {
      noteNotify('SKIPPED', 'no-subagents-service', 'this deployment composes no message-channel service')
      return false
    }

    const parentId = parent?.session?.id ?? parent?.id
    if (typeof parentId !== 'string' || parentId === '') {
      noteNotify('SKIPPED', 'no-parent-id')
      return false
    }

    // `sendMessage` 只认**直接**父会话。多级委派时（子 → 中间层 → 根）发不到根，
    // 而发到中间层只会吵醒一个 worker、对用户毫无帮助，所以那种情况直接不发。
    const immediateParentId = agent?.session?.header?.parentSession
    if (immediateParentId !== parentId) {
      noteNotify('SKIPPED', 'not-direct-parent', 'the resolved relaying session is not this subagent\'s direct parent')
      return false
    }

    if (signal !== undefined && signal.aborted === true) {
      noteNotify('SKIPPED', 'signal-aborted')
      return false
    }

    const text = [
      'Multitask approval gate — a decision from you is waiting.',
      '',
      `A delegated Subagent (${String(childId).slice(0, 8)}) asked to run "${toolName}", and that request could not be shown in this conversation's composer: the turn that made it is not open right now.`,
      '',
      'This same message wakes this conversation up, so an approval card may appear here within a few seconds — answer it here if it does. If no card appears, the request is still pending inside that Subagent\'s own session:',
      '',
      `  ${childId}`,
      '',
      'To decide in that case, open that Subagent\'s session (the Subagents list in this session header, or the id above). The approval prompt with "Allow once" / "Reject" is there.',
      '',
      'What it wants to run:',
      `${detail ?? '(no detail supplied by the asker)'}`,
      '',
      'Until you answer it — here or there — that call stays blocked and cannot proceed. Do not retry it or work around it: only your answer releases it.',
    ].join('\n')

    try {
      await subagents.sendMessage(agent, parentId, [{ type: 'text', text }], {
        // ⚠️ `signal` 是**必填**（上游类型就是 `{ readonly signal: AbortSignal }`）。
        // 沿用原子请求的 signal 是刻意的：那次请求被取消时，这条通知也失去意义。
        ...signal === undefined ? { signal: new AbortController().signal } : { signal },
      })
      noteNotify('SENT', undefined, `the user was told to open "${String(childId)}" and decide there (this notification is NOT an approval)`)
      return true
    } catch (error) {
      // 发不出去不改变任何结果：审批仍然退回原路径（fail-closed）。
      noteNotify('FAILED', undefined, `could not deliver the fallback notice: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // ── 主路径之一：agent/created 上做 B ────────────────────────────────────────
  //
  // 时机理由已写在文件头（`initializeAgent` 先 await setup 再 publish ⇒ `agent/created`
  // 必然晚于委派钉死）。载荷必须从 payload **对象**上取 `agent`，不能把第一个参数当
  // agent 读 —— 那是同生态插件里被明确记录过的坑。
  ctx.on('agent/created', (payload) => {
    try {
      // ⚠️ 解构留在 try 内（写在参数位置会让「连载荷都没有」这种输入在进入 try 之前就抛，
      // 绕过下面的 catch，而本模块对外的承诺是「任何意外都不得影响会话创建」）。
      const agent = payload?.agent
      if (!isDelegatedChild(agent)) return
      releasePolicy(agent)
    } catch (error) {
      warn(`handling agent/created failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── 主路径之二：第一级分流（C1-b）───────────────────────────────────────────
  //
  // **不** prepend：先让上游的策略（若有）表态，只在它说 `allow` 时把结果**升级**为
  // `ask`。这样本模块永远不会覆盖别人的拒绝，也不会与它们抢跑。
  if (config?.classify !== false) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const downstream = await next()
      try {
        if (downstream?.kind !== 'allow') return downstream

        const agent = exec?.agent
        if (!isDelegatedChild(agent)) return downstream

        // ⚠️ 这一条是**必须**的：策略不是 `ask` 时，返回 `ask` 只会被
        // `decide()` 的第一行按 `never` 判成 `rejected` —— 那会把一条原本能在沙箱里
        // 正常跑完的命令变成拒绝。宁可不问，也不能制造出一个必然被拒的询问。
        if (effectivePolicyOf(ctx, agent.session) !== 'ask') return downstream

        const cwd = agent?.session?.header?.cwd
        const hit = classifyExecution(exec, { shellTools, fileTools, danger, safe, cwd, caseInsensitive, tempRoots })
        if (hit === undefined) return downstream

        const label = hit.kind === 'shell' ? hit.command : hit.filePath
        ctx.logger?.info?.(
          `dsh-multitask: MULTITASK-APPROVAL-ASK tool=${JSON.stringify(exec.name)} pattern=${hit.pattern}`,
        )
        return {
          kind: 'ask',
          reason: `${ASK_REASON_PREFIX} flagged ${hit.kind === 'shell' ? 'a destructive shell command' : 'a write outside the workspace'} (${hit.pattern}): ${label}`,
          displayReason: {
            en: `A delegated Subagent wants to run ${exec.name}, which the Multitask approval gate flagged as destructive (${hit.pattern}). Approve only if you meant this.`,
            zh: `被委派的子代理要执行 ${exec.name}，Multitask 审批闸门判定它有破坏性（${hit.pattern}）。确认你确实要这么做再批准。`,
          },
        }
      } catch (error) {
        // 规则分类的任何意外都不得影响工具调用本身 —— 退回上游已经给出的决定。
        warn(`classifying a tool call failed: ${error instanceof Error ? error.message : String(error)}`)
        return downstream
      }
    })
  }

  // ── 主路径之三：第二级转呈（C2）─────────────────────────────────────────────
  //
  // `{ prepend: true }` 是**必须**的：上游的转发者会把请求发给浏览器。排在它后面的话，
  // 面板已经为（不可见的）子会话渲染了，再改也来不及。详见文件头。
  if (config?.relay !== false) {

    /**
     * 转呈重试窗口（毫秒）。`0` 表示关闭重试（退回 1.0.0 的行为）。
     *
     * 非法值一律**退回默认**而不是「不限制」：这个数只用来给等待封顶，把它读成
     * `Infinity` 会让子代理在父会话永不醒来时被无限挂住 —— 那是本模块最不该制造的状态。
     */
    const relayRetryWindowMs = (() => {
      const raw = config?.relayRetryWindowMs
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return DEFAULT_RELAY_RETRY_WINDOW_MS
      return raw
    })()

    /**
     * 父会话此刻有没有**打开的回合** —— 复刻上游 `hasOpenTurn` 的判据。
     *
     * 上游实现（逐字）是从日志尾部倒序扫，`turn/start` 为真、`turn/end` 为假。
     * 本函数照做，但返回**三态**：`true` / `false` / `undefined`（读不出来）。
     * `undefined` 与 `false` 必须分开 —— 前者只能放弃重试，后者才是「等一会儿就好」。
     *
     * ⚠️ 为什么可以自己扫：`eventAt(seq)` 在运行期就是 `this.log[seq]`，而
     * `SessionSeq(value)` 是恒等函数（`brandNumber` 返回入参）。所以传普通数字是安全的。
     * 但仍然整段包在 try 里：会话对象来自别的包，本模块的承诺是「任何意外都不得影响审批」。
     *
     * @param session - 待检查的会话（父会话）。
     * @returns `true` 有打开回合 / `false` 没有 / `undefined` 读不出来。
     */
    const openTurnStateOf = (session) => {
      try {
        if (session === undefined || session === null) return undefined
        if (typeof session.eventAt !== 'function') return undefined
        const end = session.seq
        if (typeof end !== 'number' || !Number.isFinite(end)) return undefined
        for (let seq = Math.floor(end) - 1; seq >= 0; seq -= 1) {
          const type = session.eventAt(seq)?.type
          if (type === 'turn/start') return true
          if (type === 'turn/end') return false
        }
        return false
      } catch {
        return undefined
      }
    }

    /** 等一小会儿（重试窗口内的轮询）。 */
    const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

    /**
     * 等一个 promise，但最多等 `ms` 毫秒；超时返回 `fallback`。
     *
     * ⚠️ 超时必须**清掉**那个定时器（`finally` 里的 `clearTimeout`）：它只是给等待封顶，
     * 让它留在事件循环里会让进程在本该结束时多挂住一段时间 —— 在测试里尤其明显。
     *
     * @param promise - 被等的 promise。
     * @param ms - 上限毫秒数。
     * @param fallback - 超时时的返回值。
     * @returns 原值或 `fallback`。
     */
    const withTimeout = async (promise, ms, fallback) => {
      let timer
      try {
        return await Promise.race([
          promise,
          new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }

    /**
     * 记一次重试相关的结果（固定标识，便于 grep）。
     *
     * @param kind - `WAITING` / `SKIPPED` / `RETRIED` / `FAILED`。
     * @param reason - 跳过或失败原因的短名；成功与等待时省略。
     * @param detail - 给人看的补充说明。
     */
    const noteRetry = (kind, reason, detail) => {
      try {
        ctx.logger?.info?.(
          `dsh-multitask: MULTITASK-APPROVAL-RELAY-RETRY-${kind}` +
            `${reason === undefined ? '' : ` reason=${reason}`}` +
            `${detail === undefined ? '' : ` — ${detail}`}`,
        )
      } catch {
        // 日志通道不可用不能反过来炸掉审批。
      }
    }

    /**
     * 组装转呈用的载荷 —— 首次转呈与「唤醒后重试」**必须**产生逐字相同的载荷。
     *
     * 抽出来是为了防漂移：两处各写一份的话，改动一边就会让用户在不同时机看到不同措辞的卡，
     * 而那种差异只在「重试真的发生」时才显形 —— 正是最难被发现的一类不一致。
     *
     * @param payload - 父会话、工具名、子会话 id、原始理由与原子请求。
     * @returns 供 `approval.request()` 消费的请求对象。
     */
    const buildRelayPayload = ({ root, name, id, why, source }) => ({
      agent: root,
      toolName: name,
      ...source?.callId !== undefined ? { callId: source.callId } : {},
      reason: `${ASK_REASON_PREFIX}: a delegated Subagent (${String(id).slice(0, 8)}) asked to run "${name}"${why === undefined ? '' : ` — ${why}`}`,
      displayReason: {
        en: `a delegated Subagent (${String(id).slice(0, 8)}) asked to run "${name}". ${why ?? 'Approve to let that single call proceed.'}`,
        zh: `被委派的子代理（${String(id).slice(0, 8)}）请求执行「${name}」。${why ?? '批准则仅放行这一次调用。'}`,
      },
      // 沿用原子请求的 signal：子代理被取消时，主对话里的提示也应随之消失。
      ...source?.signal !== undefined ? { signal: source.signal } : {},
    })

    /**
     * 唤醒父会话之后**重试一次**转呈，成功则返回用户的决定。
     *
     * 这一段解决的是「回合刚好关着」那一类个例（见文件头）。它的判据、上限与失败取向
     * 都写在文件头那一节里，这里只补充三处实现细节：
     *
     *   1. **回合已经开着时不必等通知。** 那种情况说明失败之后、进入这里之前，回合被
     *      **别的东西**打开了（用户自己发了消息等）—— 直接重试就是最优解，而通知是
     *      另一条独立的路。这一支也顺手让「通知被关掉」的部署仍能享受到重试。
     *   2. **回合关着时先等通知的送达结果。** 通知是唯一会唤醒父会话的东西
     *      （`sendMessage` → `steer` → `wakeup = true`）；它没送出去就说明不会有人来开
     *      回合，那这个窗口从头到尾都不该开。等待本身也有上限（`NOTIFY_ACK_TIMEOUT_MS`）——
     *      一次本地投递不该挂住，真挂住了就不重试，这与「没送达」是同一处置。
     *   3. **只在「缺打开回合」这一种失败上重试。** 判定依据是错误原文里的
     *      `outside an open turn`。别的失败（父会话已销毁、审批服务消失）等下去不会变好，
     *      而且重试它们有可能造成**重复询问** —— 而这一种**不可能**，因为上游那条守卫
     *      在 `append('approval/asked')` **之前**。
     *
     * @param context - 失败原因、父会话、工具名、子会话 id、原子请求与通知的 promise。
     * @returns 重试成功时的用户决定；没有重试、或重试仍失败时为 undefined。
     */
    const retryRelayAfterWake = async (context) => {
      const { error, parent: root, toolName: name, childId: id, original: why, request: source, notice } = context

      if (relayRetryWindowMs <= 0) {
        noteRetry('SKIPPED', 'disabled-by-config')
        return undefined
      }

      // 只有「父会话没有打开的回合」值得等 —— 别的失败等到天亮也不会变好。
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes(OPEN_TURN_REQUIRED_HINT)) {
        noteRetry('SKIPPED', 'not-a-turn-boundary-failure', `the relay failed for another reason: ${message.slice(0, 120)}`)
        return undefined
      }

      // 父会话的回合状态读不出来时**不猜**：等下去没有判据能说明「什么时候该停」。
      const initial = openTurnStateOf(root?.session)
      if (initial === undefined) {
        noteRetry('SKIPPED', 'turn-state-unreadable')
        return undefined
      }

      if (initial === true) {
        noteRetry('WAITING', 'turn-already-open')
      } else {
        // 回合关着 —— 唯一的指望是那条通知把父会话唤醒。先确认它真的送出去了。
        const delivered = await withTimeout(
          Promise.resolve(notice).then((value) => value === true).catch(() => false),
          NOTIFY_ACK_TIMEOUT_MS,
          false,
        )
        if (delivered !== true) {
          noteRetry('SKIPPED', 'notice-not-delivered', 'nothing will wake the parent session, so waiting would be pointless')
          return undefined
        }

        noteRetry('WAITING', undefined, `waiting up to ${relayRetryWindowMs}ms for the woken parent session to open a turn`)
        const deadline = Date.now() + relayRetryWindowMs
        for (;;) {
          if (source?.signal?.aborted === true) {
            noteRetry('SKIPPED', 'signal-aborted')
            return undefined
          }
          const observed = openTurnStateOf(root?.session)
          if (observed === true) break
          if (observed === undefined) {
            noteRetry('SKIPPED', 'turn-state-unreadable')
            return undefined
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            noteRetry('FAILED', 'window-elapsed', `the parent session did not open a turn within ${relayRetryWindowMs}ms`)
            return undefined
          }
          await sleep(Math.min(RELAY_RETRY_POLL_MS, remaining))
        }
      }

      // ── 重试转呈（载荷与原次**逐字相同**：用户看到的卡不该因重试而变样）─────────
      try {
        const approval = ctx.get('approval')
        if (approval === undefined || approval === null || typeof approval.request !== 'function') {
          noteRetry('FAILED', 'no-approval-service')
          return undefined
        }
        // ⚠️ 等待期间父会话的策略**可能已经变了**（用户切到「永不需要批准」等）。
        // 那时再问只会被 `decide()` 的第一行按 `never` 判成 `rejected` —— 这与本模块
        // 贯穿始终的取向相反：**绝不在非交互式会话上装 `ask`**。所以这里重读一次。
        if (effectivePolicyOf(ctx, root?.session) !== 'ask') {
          noteRetry('SKIPPED', 'parent-not-interactive')
          return undefined
        }
        const outcome = await approval.request(buildRelayPayload({ root, name, id, why, source }))
        noteRetry('RETRIED', undefined, `the retried relay reached the parent session; outcome=${String(outcome)}`)
        return outcome
      } catch (retryError) {
        noteRetry(
          'FAILED',
          'retry-threw',
          retryError instanceof Error ? retryError.message : String(retryError),
        )
        return undefined
      }
    }

    ctx.on(
      'approval/request',
      async (request, next) => {
        // 这几个变量声明在 try **之外**：catch 里的兜底通知要用到它们。
        // 注意 `relayAttempted` 这个标志 —— 它把「转呈失败」与「这不是本模块的事」
        // 分开：只有**真的调用过** `approval.request` 之后抛错才算失败，早退路径
        // （非子代理 / 父会话不是 ask / 服务缺失）绝不该发通知。
        let agent
        let parent
        let toolName = 'unknown'
        let childId = 'unknown'
        let original
        let relayAttempted = false

        try {
          agent = request?.agent
          if (!isDelegatedChild(agent)) return await next()

          // 一次走到根：多级委派时不逐级转呈（少一处递归就少一处出错点）。
          parent = rootAncestorOf(ctx, agent)
          if (parent === undefined || parent === agent) return await next()
          if (effectivePolicyOf(ctx, parent.session) !== 'ask') return await next()

          const approval = ctx.get('approval')
          if (approval === undefined || approval === null || typeof approval.request !== 'function') {
            return await next()
          }

          childId = agent?.session?.id ?? agent?.id ?? 'unknown'
          toolName = typeof request.toolName === 'string' && request.toolName !== '' ? request.toolName : 'unknown'
          original = typeof request.reason === 'string' && request.reason !== '' ? request.reason : undefined

          // 向父会话发起一次**新的**审批请求。它会走完整条链路（含上游的转发者），
          // 于是由 `ui-approval` 在主对话里渲染成面板 —— 这正是本模块要的效果。
          relayAttempted = true
          const outcome = await approval.request(
            buildRelayPayload({ root: parent, name: toolName, id: childId, why: original, source: request }),
          )

          try {
            ctx.logger?.info?.(
              `dsh-multitask: MULTITASK-APPROVAL-RELAYED tool=${JSON.stringify(toolName)} outcome=${String(outcome)}`,
            )
          } catch {
            // 日志通道不可用不能反过来炸掉审批。
          }
          return outcome
        } catch (error) {
          // 转呈失败（父会话此刻没有打开的回合、父会话已结束、服务缺失…）时**退回原路径**：
          // 上游的应答者仍会按老样子处理，最坏结果是 fail-closed 的 `unavailable`。
          // 不能因为转呈不了就把一次拒绝变成放行。
          try {
            ctx.logger?.info?.(
              `dsh-multitask: MULTITASK-APPROVAL-RELAY-FAILED reason=${error instanceof Error ? error.message : String(error)}`,
            )
          } catch {
            // 同上。
          }

          // ── 兜底：告诉用户「有个决定在等你、要打开哪个子会话去作答」─────────────
          //
          // 只在**真的尝试过转呈之后**失败时才发：早退路径（上面那些 `return await next()`）
          // 表示「这不是本模块的事」，那时发通知就是纯粹的噪音。
          //
          // ⚠️⚠️ 顺序是**先发通知、再 await 下游**，这不是风格问题：
          // 转呈失败最常见的后续是「下游把请求发给浏览器、客户端为那个不可见的子会话
          // 物化作用域并**接住**它」—— 那次 await **永远不返回**（审批路径没有任何超时）。
          // 若把通知放在 `await next()` 之后，**恰好在最需要它的场景里它永远发不出去**。
          //
          // 所以：通知在 await 之前**启动**（不等它，一次 RTT 都不欠），
          // 而返回值仍然是下游的结果 —— 通知绝不参与审批决定。
          if (relayAttempted) {
            const notice = notifyRelayFailure({
              agent,
              parent,
              toolName,
              childId,
              signal: request?.signal,
              detail: original,
            })

            // ── 唤醒之后重试一次转呈（本次修复的个例）────────────────────────────
            //
            // 上面那条通知会把**空闲的父会话**唤醒（`sendMessage` 走 `steer` 且
            // `wakeup = true`），所以「刚刚还没有打开的回合」通常在几毫秒后就开了。
            // 这一段的全部作用就是抓住那个刚打开的回合并重试一次 —— 于是这类个例
            // 从「用户得自己去子会话里找」变成「主对话里正常出现一张审批卡」。
            //
            // ⚠️ 它**必须**排在 `await next()` 之前：下游会把请求发给浏览器，而客户端
            // 会为那个不可见的子会话物化作用域并**接住**它 —— 那次 await 永远不返回。
            // 排在后面的话，重试根本没有机会发生。
            //
            // ⚠️ 它**不改变** fail-closed 的性质：重试只有在**拿到了用户的决定**时才
            // 返回那个决定；否则一律 `undefined`，调用方照旧 `return await next()`。
            const retried = await retryRelayAfterWake({
              error,
              agent,
              parent,
              toolName,
              childId,
              original,
              request,
              notice,
            })
            if (retried !== undefined) return retried
          }
          return await next()
        }
      },
      { prepend: true },
    )
  }
}

/** 上游委派上下文里那句**与放开后的策略相矛盾**的原话（逐字，用来定位要改写的条目）。 */
const APPROVAL_CLAIM = 'operations that require approval are rejected automatically'

/** 替换文本：只说事实 —— 需要审批的调用**会**被路由给用户裁决。 */
const RELAYED_CLAIM = 'operations that require approval are routed to the user for a decision, and a rejection is final for that call'
