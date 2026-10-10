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
const DANGER_PATTERNS = [
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

/**
 * 判定一次工具调用是否需要征求用户同意（第一级闸门）。
 *
 * @param exec - 工具执行输入（含 `name` / `arguments`）。
 * @param options - 编译好的模式表、工具名集合与工作区信息。
 * @returns 命中时的描述，否则 undefined。
 */
export function classifyExecution(exec, options) {
  const toolName = exec?.name
  if (typeof toolName !== 'string' || toolName === '') return undefined

  if (options.shellTools.has(toolName)) {
    const command = stringArg(exec, 'command')
    const hit = classifyShellCommand(command, options.danger, options.safe)
    if (hit !== undefined) return { kind: 'shell', pattern: hit, command }
    return undefined
  }

  if (options.fileTools.has(toolName)) {
    const filePath = stringArg(exec, 'file_path')
    if (filePath === undefined) return undefined
    if (escapesWorkspace(filePath, options.cwd, options.caseInsensitive)) {
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
      `A delegated Subagent (${String(childId).slice(0, 8)}) asked to run "${toolName}", and that request could not be shown in this conversation's composer: the turn that made it is not open right now. The request itself is still pending inside that Subagent's own session.`,
      '',
      `  ${childId}`,
      '',
      'To decide, open that Subagent\'s session (the Subagents list in this session header, or the id above). The approval prompt with "Allow once" / "Reject" is there.',
      '',
      'What it wants to run:',
      `${detail ?? '(no detail supplied by the asker)'}`,
      '',
      'Until you answer it there, that call stays blocked and cannot proceed. Do not retry it or work around it: only your answer releases it.',
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
        const hit = classifyExecution(exec, { shellTools, fileTools, danger, safe, cwd, caseInsensitive })
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
          const attribution = `a delegated Subagent (${String(childId).slice(0, 8)})`

          // 向父会话发起一次**新的**审批请求。它会走完整条链路（含上游的转发者），
          // 于是由 `ui-approval` 在主对话里渲染成面板 —— 这正是本模块要的效果。
          relayAttempted = true
          const outcome = await approval.request({
            agent: parent,
            toolName,
            ...request.callId !== undefined ? { callId: request.callId } : {},
            reason: `${ASK_REASON_PREFIX}: ${attribution} asked to run "${toolName}"${original === undefined ? '' : ` — ${original}`}`,
            displayReason: {
              en: `${attribution} asked to run "${toolName}". ${original ?? 'Approve to let that single call proceed.'}`,
              zh: `${attribution} 请求执行「${toolName}」。${original ?? '批准则仅放行这一次调用。'}`,
            },
            // 沿用原子请求的 signal：子代理被取消时，主对话里的提示也应随之消失。
            ...request.signal !== undefined ? { signal: request.signal } : {},
          })

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
          // 这是**已知限制**，不是缺陷 —— 不能因为转呈不了就把一次拒绝变成放行。
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
          // 所以：通知在 await 之前**启动**（`void` —— 不等它，一次 RTT 都不欠），
          // 而返回值仍然是下游的结果 —— 通知绝不参与审批决定。
          if (relayAttempted) {
            void notifyRelayFailure({ agent, parent, toolName, childId, signal: request?.signal, detail: original })
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
