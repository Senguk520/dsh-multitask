/**
 * multitask-concurrency-guard — Multitask 模式的「子代理并发节流器」。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * Multitask 的主要用法是「一条消息里并行下发多个委派」。并行度失控的代价很具体：
 * 每个子代理都要占一个真实会话、一份模型配额、一段宿主资源；而且回报会**同时**涌回
 * 协调者的上下文，把它一次撑爆 —— 那正是减震器模式要避免的事。
 *
 * 宿主 `dsh-subagent` 自己有一个 `maxActiveSubagents`（默认 8），但它是**全局**的：
 * 一旦撞上，报出来的是 `ACTIVATION_LIMIT_REACHED` 硬拒绝，而且它对「本模式想更保守
 * 一点」这件事一无所知。本模块给 Multitask **单开一个更低的上限**，两者同时生效、
 * 取较小值。
 *
 * ── ★ 上限的天花板就是 8：本模块自己收敛，不把「配置值」当成「能做到的值」────────
 *
 * 本模式下**同时活跃**的子代理数，真实上限是 **8** —— 宿主 `maxActiveSubagents` 的
 * 默认值。实测（真实会话，一条消息里并行下发 10 个）：前 8 个同时 `[running]`，
 * 第 9、10 个**在启动之前**被宿主拒绝，错误原文逐字：
 *
 *     Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
 *
 * 所以 `config.maxActive` 不会被原样采用：`normalizeLimit()` 把它钉在
 * `min(设定值, MAX_ACTIVE_CEILING)`（常量见下）。配置 16 **不等于**能跑 16 ——
 * 那只会让本模块的日志与拒绝文案承诺一个宿主根本不会给的名额（前 8 个之后，
 * 用户看到的是上面那条英文错误，而我们的守卫永远不会触发）。
 *
 * 反过来说，「派 10 个全部成功」这个观察**不是**反例：那是**阻塞 / 串行**执行
 * （一次只在跑 1 个，等它结束再派下一个），活跃数从未超过 1。只有**同一条消息里
 * 并行下发**才会真的去抢那 8 个名额；串行跑多少个都不会撞上限，也证明不了上限
 * 被放宽。
 *
 * ── ⚠️ 这是「软上限」，不是安全边界 ─────────────────────────────────────────
 *
 * 必须把这句话写在最前面，因为很容易把它读成比实际更强的东西。它的准确性质是：
 *
 *     **对协调者「常规委派路径」的节流。**
 *
 * 它不是权限边界、不是资源配额、不是「子代理数量绝不会超过 N」的保证。四条理由：
 *
 *   1. **`workflow` 是已知的旁路（已实证，不是猜测）。** `dsh-tool-workflow` 起的
 *      子代理由**工作流引擎直连服务**创建 —— `ctx.subagents.start(this.provider, …)`
 *      （证据：`G:\DSH\resources\app.asar:1077303`；同文件 `:1077538` 的
 *      `ctx.subagents.getProvider(provider)` 是同一条直连路径）。而工具层的拦截发生在
 *      `dsh-tools` 的 `tools/pre-execute` 瀑布与 `guardReason(exec)`
 *      （`_dshsrc/dsh-tools/lib/index.js:3225`、`:3241`）—— **只有经工具层的调用**
 *      才会经过那里。所以工作流起的子代理 **完全绕过本守卫的拒绝**。
 *   2. 已知偏差（见下方「已知偏差」一节）：我们的计数与宿主的名额不是同一套账。
 *   3. 拒绝方式是**工具层错误**（一条 `Error:` 文本结果），不是宿主的硬拒绝错误码，
 *      模型完全可以换别的入口重试。
 *   4. 计数只覆盖**协调者的直接子代理**，不覆盖宿主全局的其它会话。
 *
 * 由此推论出一条容易看错的行为，如实写出来：
 *
 *     一个**未被拒绝**的入口（`workflow`）冲过上限之后，**协调者随后走常规委派
 *     路径的请求会被本守卫拒绝**，直到计数回落到上限以下。
 *
 * 也就是说：超发的代价没有消失，只是被**转嫁**给了正常路径。这是「宁可保守，
 * 也不放过」的取向的直接后果，读到这里的人应当知道它。
 *
 * ── 各入口的实际行为（逐条对照，别只看「能不能拦」）──────────────────────────
 *
 *   | 入口                                     | 是否计数 | 能否被拒绝 |
 *   |------------------------------------------|----------|------------|
 *   | `subagent` / `subagent_fork`（工具层）    | 计数     | **能**     |
 *   | `subagent_ptc` / `subagent_minimal`（工具层） | 计数 | **能**     |
 *   | `workflow`（引擎直连 `ctx.subagents.start`） | **计数** | **不能** |
 *
 * 第二行两条之所以也在工具层：它们是本 composition 自己注册的委派行，协调者能看见它们
 * （`coordinator-guard.mjs` 的保留集里显式列了 `subagent_ptc` / `subagent_minimal`）。
 *
 * 第三行是关键的缺口：`workflow` **绕过了工具层**，但我们**照样数得到它**。原因是
 * 工作流引擎起的子代理**仍然是真正的 subagent 子级** —— 它的 session header 带着
 * `origin: 'subagent'` 与 `parentSession`（asar `:988188`、`:988190`、`:992532` 同款），
 * 因此创建时会照常触发 `agent/created`（asar `:285265`：
 * `await serial agent/created listeners`），于是进入我们的 `residents` 集合。
 *
 * ── 为什么是「拒绝」而不是「排队」────────────────────────────────────────────
 *
 * 排队会引入一个更难查的坏法：协调者以为自己已经派下去了，实际上任务在队列里等着，
 * 而它已经跑去 `job_output` 取结果。宿主自己在 `ActivationPool.reserve()` 上也是
 * 拒绝而非排队（`dsh-subagent:727-734`，理由是「避免等待后代的父代理又等待自己
 * 占用的名额」）。本模块沿用同一取向：拒绝 + 一条说清理由与下一步的文本。
 *
 * ── 技术支点：`agent.ctx.tools.guard()` 是按 agent 作用域的同步拦截器 ─────────
 *
 * `_dshsrc/dsh-tools/lib/index.js:2912-2935` 的文档逐字：
 *
 *     Register a monotonic guard after the extensible `tools/pre-execute` waterfall.
 *     A plain-context guard applies globally; one registered through `agent.ctx`
 *     applies only to that agent. Any matching guard may deny by returning a reason,
 *     while no guard can force-allow a call another guard denies.
 *     @param guard - synchronous check; a returned string denies the execution.
 *
 * 所以本模块把守卫装在**协调者自己的 agent scope** 上 —— 与减震器同一手法，子代理
 * 完全不受影响。返回**字符串**即拒绝：宿主把它变成 `Error: ${reason}`、`isError: true`，
 * 并且**不派发**（`:3241-3257`）。时序上 `tools/pre-execute` 瀑布（`:3225`）先跑、
 * 之后才查 guards（`:3241`），因此本守卫在工具体执行、工作被创建**之前**运行。
 *
 * 官方包自己就这么用（形状逐字同构）：
 * `_dshsrc/dsh-subagent-in-process-driver/lib/index.js:85`
 * `childCtx.tools.guard((exec) => … ? void 0 : \`…\`)`。
 *
 * ⚠️ **guard 是同步的**。计数**必须**是同步整数，靠事件增减，**绝不能在 guard 里
 * await**（那会让它返回一个 Promise —— 而 Promise 不是字符串，既不放行也不拒绝，
 * 语义完全失控）。本模块在 guard 内只做「读计数、比较、自增」三件同步的事。
 *
 * ── ★ 必须处理的缺陷：`isConcurrencySafe: () => true` 与并行扇出 ─────────────
 *
 * 委派工具声明了 `isConcurrencySafe: () => true`
 * （`_dshsrc/dsh-tool-subagent/lib/index.js:489`），所以**一条消息里的 N 个并行委派
 * 会先全部通过 guard、再各自创建 agent**。若 guard 只读「已创建」计数，N 个都会看到
 * 同一个旧值 ⇒ 全部放行 ⇒ 超发可达 N−1。而「一条消息并行下发多个委派」**正是
 * Multitask 的主要用法** —— 也就是说，不处理这个缺陷，本模块在它最该生效的场景下
 * 几乎不生效。
 *
 * ── 修法：pending 预占（同步自增），与居民数相加 ──────────────────────────────
 *
 *     used = residents.size（来自 agent/created、agent/disposed）
 *          + pending      （来自 guard 放行时的同步自增、tools/result 时归还）
 *
 * guard 放行时**同步** `pending += 1`。自增本身是同步操作，不违反上面那条约束。
 * N 个并行委派会依次进入各自的同步区间，第 N+1 个看到更新后的计数，于是被拒绝 ——
 * 并行扇出从「超发 N−1」收敛到接近 0（见下方「结算方式为何不依赖事件次序」）。
 *
 * ── ★ 结算方式为何不依赖事件次序（也就为何不会永久泄漏名额）──────────────────
 *
 * 委派被放行之后，有**两件**事会先后发生，而它们的次序**未被证实**：
 *   · `agent/created`（子代理真的被建出来了）；
 *   · `tools/result`（那次工具调用结算了）。
 *
 * 本模块**刻意不去配对它们**。规则只有两条，各自独立、各自幂等：
 *
 *   1. `pending` 的每一份预占都绑定在**那一次 exec 对象本身**上（引用身份），
 *      且**只**由该 exec 自己的 `tools/result` 归还。一增一减，同一个键。
 *   2. `residents` **只**由 `agent/created` 增、`agent/disposed` 减，与预占无关。
 *
 * 于是无论两件事谁先谁后：
 *   · 先 created 后 result —— 窗口内 `used` 暂时**多算 1**（同一份委派被居民与预占
 *     各计一次），result 到达后自愈；
 *   · 先 result 后 created —— 窗口内 `used` 暂时**少算 1**，created 到达后补上。
 *
 * 两种偏差都只是**短暂**的，且都不改变「一份委派最终恰好占一个名额」这条终态。
 * 更关键的是：**没有任何一条路径能让预占永久留在计数里** —— 只要 `tools/result` 会
 * 到达（已从源码确证：`finishScheduledExecution()` 无论成功、失败、被取消，
 * 都会走 `notifyResult()`，`dsh-tools:3382-3397`、`:3409`），预占就一定被归还。
 * 万一某次调用真的没有等到 result（整个会话被拆掉），那个协调者的**全部状态也随
 * `agent/disposed` 一起丢弃**，不会留给下一个会话。
 *
 * 由此得到本模块的取舍，它是有意选的：
 *
 *     **宁可短暂多算（少放行一两个），也绝不永久卡死（再也不放行）。**
 *
 * ── ★ `workflow` 子代理没有预占 —— 会不会把配对逻辑搞坏？────────────────────
 *
 * 不会。这正是上面那条「不去配对」的设计要挡住的情形：`workflow` 起的子代理
 * **没有**对应的预占（它压根没经过 guard），但它在 `agent/created` 里被
 * `isDelegatedChild()` 认成子代理、进入 `residents` —— 计数如实反映现实。
 *
 * 因为预占与居民是**两套独立、各自自洽**的账，一条「只有居民、没有预占」的路径
 * 不会让任何计数器变成负数或产生偏移。若反过来做「预占必须与 created 一一配对」，
 * `workflow` 的子代理就会变成一条永远配不上对的居民，或者反过来让某个预占永远
 * 归不了还 —— 那正是要避免的坏法。
 *
 * ── 已知偏差（逐条对照 `_dshsrc/dsh-subagent/README.zh.md:51-55`）─────────────
 *
 * 宿主文档里描述它的名额语义时有四句话，本模块与它们**都不是**同一套账，如实列出：
 *
 *   1. 「正在停止的 Activation 仍占名额」—— 宿主直到 handle 释放才归还名额，而我们
 *      在 `agent/disposed` 时就释放。**我们的释放可能更早 ⇒ 可能多放行 1 个**
 *      （方向偏松）。
 *   2. 「冷恢复在重建 Agent 前预占名额」—— 宿主的 `pool.reserve` 早于 `agent/created`
 *      （`dsh-subagent:970`），而我们的计数**从** `agent/created` 开始。所以在冷恢复
 *      正在进行、子代理尚未建出的那个窗口里，**我们少算 1**（方向偏松）。
 *   3. 「一次性和外部提供方运行**不受此限制**」—— 宿主不把一次性子代理算进名额，
 *      而我们按 `agent/created` 数，**会把一次性子代理也算进去**。也就是说
 *      **我们的软上限比宿主更严**（方向偏紧，是安全的那一侧，但要写明）。
 *   4. 我们的拒绝是一条**工具层错误结果**（一条中文文本），与宿主的
 *      `ACTIVATION_LIMIT_REACHED` 硬拒绝**不是同一个错误码**，也不会带上宿主的
 *      `info` 字段。宿主那条拒绝的**错误原文**（实测，容量 8）是：
 *
 *          Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
 *
 *      看到那条英文错误的人不应当去搜 `ACTIVATION_LIMIT_REACHED`（那是内部错误码，
 *      不在给用户看的文本里），也不应当把它当成「本守卫坏了」—— 它就是我们这个上限
 *      之上的那道宿主容量墙，见文件头「天花板就是 8」。
 *
 * 另有一条结构性边界：本模块只数**协调者的直接子代理**（`parentSession` 指向协调者）。
 * 本 composition 把 `maxDepth` 钉死在 1，孙代不可能出现；若哪个部署放宽了深度，
 * 孙代**不计入**本上限（宿主的 pool 会跨可续接的父子链共享名额，那时两者会进一步分叉）。
 *
 * ── 覆盖不到的入口 ───────────────────────────────────────────────────────────
 *
 *   · `subagent` / `subagent_fork` / `subagent_ptc` / `subagent_minimal` —— **可拦**，
 *     它们是协调者能看见的委派工具（`coordinator-guard.mjs` 的保留集）。
 *   · `subagent_codex` / `subagent_claude_code` —— 本 composition 里默认 `disabled`，
 *     所以协调者根本看不见 ⇒ 天然覆盖；但本模块**照列它们的名字**，一旦那些行被打开，
 *     节流自动覆盖（只按名字判断，多列一个停用的名字没有任何后果）。
 *   · **`workflow` —— 已确认的缺口，见文件开头。** 它计数但拦不住。
 *
 * ── 失败要响亮（与 `minimal-guard.mjs` 取向一致）─────────────────────────────
 *
 * 守卫装不上 = 这个上限是假的（协调者可以无限并发派活，而设置面板上明明写着有上限）。
 * 所以探测不到 `agent.ctx.tools.guard` 时必须写一条明确的告警日志（每种原因只报一次，
 * 避免刷屏），**不静默降级**。
 *
 * ── 零依赖、零 import ────────────────────────────────────────────────────────
 *
 * 本仓库对预设内模块的约定（见 `subagent-mode.mjs` / `minimal-guard.mjs` 的文件头）。
 * 常量在本文件内自带一份，不与别的模块互相 import：那些模块的常量都是**消费方**
 * （保留集、允许集），与这里「哪些名字算一次委派」是**不同的东西**，合并只会让
 * 以后改一个牵动另一个。
 *
 * @module dsh-multitask/presets/multitask/concurrency-guard
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-concurrency-guard'

/** 工具注册表必须先存在，`agent.ctx.tools.guard()` 才有意义。 */
export const inject = ['tools']

/**
 * ★ 本模式「同时活跃子代理」的硬天花板：**8**。
 *
 * 这不是本插件的预算，而是 **DSH 宿主的容量**：
 *
 *   · 宿主 `subagent.maxActiveSubagents` 的默认值就是 8（其 Config schema 里
 *     `z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8).volatile()`）；
 *   · 名额不足时的拒绝在 `ActivationPool.reserve()` 里抛出，错误原文见文件头。
 *
 * 宿主把上限抬到 8 以上是它自己的事；本模块的定位始终是「**更低**的那个上限」，
 * 所以这里把本模式的活动上限钉在 8 以内 —— 配置 16 也绝不请求 16。
 *
 * ⚠️ 本文件与 `composition.mjs` **各自留一份**常量（本仓库预设模块的约定：互不 import），
 * `test/` 下的本地回归会比对这两份值与 README 的说法，让「只改了一处」变成可见的失败。
 */
export const MAX_ACTIVE_CEILING = 8

/**
 * 算作「一次委派」的工具名。
 *
 * 判据是**名字**，不是「这一次调用会不会真的建出子代理」—— guard 是同步的，看不到
 * 未来。所以这张表要宽一点：漏列一个委派工具 = 那个入口完全不计数（静默失效），
 * 多列一个当前不存在或停用的名字 = **没有任何后果**（同名工具不出现就永远不会匹配）。
 *
 * ⚠️ 刻意**不含 `workflow`**：它不是一个单纯的委派工具（它还做扇出编排、跑脚本），
 * 而且拦也拦不住它起子代理的那条路径（见文件头）。把它写进来只会让「workflow 被
 * 拒绝」看起来像在防超发，实际只是挡住了一个更大的功能，却对超发毫无影响。
 *
 * ⚠️ 也不含 `task_board_run` 一类入口：它们由别的插件注册，且不在协调者的保留集里
 * （协调者看不见它们）。名字不出现就永远不会匹配，所以「没列」在这里是安全的下界，
 * 但**不是**「那些入口不影响子代理数量」的断言 —— 它们不在本模块能观测到的范围内。
 */
const DELEGATION_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'subagent_ptc',
  'subagent_minimal',
  'subagent_codex',
  'subagent_claude_code',
])

/**
 * 一个每次进程只警告一次的记录器（与 `coordinator-guard.mjs` / `minimal-guard.mjs` 同款）。
 *
 * @param ctx - 插件上下文。
 * @returns 记录函数：同一句话只写一次。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/concurrency-guard: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 与 `coordinator-guard.mjs` / `minimal-guard.mjs` 保持**同一条判据**（三信号任一成立）。
 * 这里判错的代价同样是双向的：
 *   · 把协调者误判成子代理 ⇒ 永远不装守卫 ⇒ 上限形同虚设（静默失效）；
 *   · 把子代理误判成协调者 ⇒ 会去给 worker 装守卫、并把它算进居民，方向反了。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为被委派的子代理。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 把 `config.maxActive` 收敛成「一个可用上限」或 `undefined`（= 不限制）。
 *
 * ── 为什么这里还要再收敛一次（上游不是已经清洗过了吗）────────────────────────
 *
 * 上游（`composition.mjs` 的 `normalizeMaxActive`）确实清洗过，但这一份是**防线**，
 * 不是重复的抄写：本模块的入参来自 preset 行 config，而 preset 行可以被 profile
 * patch、别的 composer、或手写 YAML 直接构造出来 —— 那些路径都不经过上游那个函数。
 * 一个守卫模块把自己的行为押在「调用方一定清洗过」上，就等于是没有防线。
 *
 * ── 两种「空」必须分开 ──────────────────────────────────────────────────────
 *
 *   · `undefined`（**键缺席**）⇒ 返回 `undefined` = 不限制，且调用方**立即返回、
 *     一个监听器都不注册**。这是「本功能加入之前」的行为，必须逐字保留。
 *   · **其它一切**（`0` / `-1` / `NaN` / `Infinity` / `2.5` / `'4'` / `null` /
 *     布尔 / 对象 / 数组）⇒ **一律收敛成 1**。
 *
 * 第二条的方向是**刻意**选的，别把它当 bug 改掉：把非法值当成「不限制」会**比用户的
 * 意图更宽松**。用户既然碰了这个字段，就是想要一个上限；一个手抖的字符串只会让上限
 * 变成「最多 1 个并发」—— 难看，但安全、而且立刻可见。静默取消限制则什么都不会发生，
 * 直到超发把协调者的上下文撑爆。
 *
 * ── ★ 合法值再夹一层：`min(值, MAX_ACTIVE_CEILING)`───────────────────────────
 *
 * 合法整数也**不是**原样采用：超过天花板（8）的一律按 8 算。理由是那之上的名额
 * 宿主根本不给（见文件头与 `MAX_ACTIVE_CEILING`）—— 照抄 16 只会让我们自己的日志
 * 与计数承诺一个不存在的容量，实际却由宿主在 8 那里用另一条英文错误拒绝。
 * 这一行 `Math.min` 是「本模式最多同时活跃几个」的**唯一**权威收敛点。
 *
 * @param raw - `config.maxActive` 的原始值。
 * @returns 安全整数 `>= 1` 且 `<= MAX_ACTIVE_CEILING`，或 `undefined`（不限制）。
 */
function normalizeLimit(raw) {
  if (raw === undefined) return undefined
  if (!Number.isSafeInteger(raw) || raw < 1) return 1
  // ★ 天花板：DSH 宿主的默认容量就是 8，配置更高只会请求一个拿不到的名额。
  return Math.min(raw, MAX_ACTIVE_CEILING)
}

/**
 * 装载并发节流器。
 *
 * @param ctx - preset scope 的插件上下文（守卫会挂在**各协调者自己**的 agent scope 上）。
 * @param config - 该行在 composition 里的 `config`（`{ enabled?, maxActive? }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const limit = normalizeLimit(config?.maxActive)
  // ★ 不限制 = **零监听器**。这不是优化，是语义：字段缺席时必须与「本功能加入之前」
  // 行为上完全无法区分，连事件监听器都不该多出来（否则每个会话创建都要多跑一遍
  // 本模块的回调，而我们什么都不会做）。
  if (limit === undefined) return

  const warn = warnOnceFactory(ctx)

  /** 协调者 agent -> 它的计数状态。 */
  const states = new WeakMap()
  /**
   * 协调者 session id -> 它的计数状态。
   *
   * 为什么要有这张表（而不是只用上面那个 WeakMap）：判「一个新出现的子代理属于哪个
   * 协调者」时，`agent/created` 只给出子代理自己的 header，里面有 `parentSession` 这个
   * **id 字符串**，没有父 agent 对象。用 id 查表是唯一不依赖别的服务（例如
   * `ctx.get('agents')`）的做法 —— 本模块刻意不 import 也不 inject 那个服务。
   */
  const armedById = new Map()
  /** 子代理 agent -> 它所属的计数状态（`agent/disposed` 时用来归还居民名额）。 */
  const ownerOfChild = new WeakMap()

  /**
   * 卸掉一个协调者的守卫，并丢弃它的全部计数。
   *
   * ⚠️ 丢弃整个状态（而不是只把计数清零）是**防泄漏的最后一道**：万一某个预占因为
   * 会话被拆而永远没等到 `tools/result`，它也随这个状态一起消失，绝不会留给下一个
   * 会话 —— 那正是「永久卡死」的成因。
   *
   * @param state - 某个协调者的状态。
   */
  const release = (state) => {
    if (state.released) return
    state.released = true
    if (armedById.get(state.agent.id) === state) armedById.delete(state.agent.id)
    states.delete(state.agent)
    state.residents.clear()
    state.reserved.clear()
    state.pending = 0
    const dispose = state.guardDispose
    state.guardDispose = undefined
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (error) {
      warn(`lifting an earlier concurrency guard failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 给一个协调者装上守卫（幂等）。
   *
   * @param agent - 刚出现的 agent（内部会先排掉子代理）。
   */
  const arm = (agent) => {
    if (agent === undefined || agent === null) return

    // 子代理不装守卫：上限管的是「协调者能派多少个」，不是「worker 能派多少个」。
    // worker 本来也看不到委派工具（maxDepth: 1），装上去只会白占一层。
    if (isDelegatedChild(agent)) return

    // 幂等：同一 agent 重复触发不再装第二层。
    if (states.has(agent)) return

    const state = {
      agent,
      /** guard 放行但结果尚未结算的委派数。 */
      pending: 0,
      /** 已建出、尚未 disposed 的子代理。 */
      residents: new Set(),
      /** 持有预占的那些 exec（引用身份）—— 归还时的释放凭据。 */
      reserved: new Set(),
      guardDispose: undefined,
      released: false,
    }

    /**
     * 当前占用（居民 + 预占）。
     * @returns 已占用的名额数。
     */
    const used = () => state.pending + state.residents.size

    /**
     * 同步守卫。**绝不允许在这里 await** —— 见文件头「guard 是同步的」。
     *
     * @param exec - 宿主造的 execution（`{ token, callId, name, agent, arguments, … }`）。
     * @returns 拒绝时返回**字符串理由**；放行时返回 `undefined`。
     */
    const check = (exec) => {
      if (state.released) return undefined
      if (exec === null || typeof exec !== 'object') return undefined
      if (typeof exec.name !== 'string' || !DELEGATION_TOOLS.has(exec.name)) return undefined

      // 只认自己的协调者。守卫本该只对这个 agent 生效（`agent.ctx.tools.guard` 的作用域
      // 语义），这一条是**防 scope key 复用**的兜底：`coordinator-guard.mjs` 的注释里
      // 记过那个坑（scope key 被回收后复用到新 agent 上，会继承一条本该消失的过滤）。
      // 一旦发现调用方不是自己，**放行且不计数** —— 别人的名额不该被我们的旧状态吃掉，
      // 计数也不该被算到一个已经不在的会话上。
      if (exec.agent !== undefined && exec.agent !== null && exec.agent !== agent) return undefined

      if (used() >= limit) {
        // ⚠️ 文案里必须说清「上限是 8 那一层是谁的」：本守卫只会在**本模式**的上限
        // 处触发；再往上还有宿主的容量墙（它的错误原文见文件头）。两句都点出来，
        // 模型才不会把「被本守卫拒绝」误读成「委派功能坏了」，也不会反复重试。
        const message =
          `本模式（Multitask）的子代理并发上限是 ${limit}（本模式的上限不超过 8，` +
          `8 也是 DSH 宿主自身的容量上限），当前已有 ${used()} 个子代理正在运行或正在启动，` +
          `所以这一次委派没有下发。请先用 list_agents / job_output 收下现有子代理的结果，` +
          `等它们结束后再派新的任务；也可以把若干任务并进同一份任务书里交给一个子代理完成。`
        return message
      }

      // ★ 同步预占。这一步是并行扇出能被压住的关键：同一批并行委派会依次进入这个
      // 同步区间，后进来的看到已经加上去的计数。
      state.pending += 1
      state.reserved.add(exec)
      return undefined
    }

    const tools = agent?.ctx?.tools
    if (tools === undefined || tools === null || typeof tools.guard !== 'function') {
      // 不静默降级：这个上限是设置面板上写着的东西，装不上就等于承诺没兑现。
      warn(
        'this deployment exposes no agent-scoped tools.guard(), so the Multitask Subagent concurrency limit ' +
          'is NOT enforced for this session (the coordinator keeps its full delegation parallelism)',
      )
      return
    }

    let dispose
    try {
      dispose = tools.guard(check)
    } catch (error) {
      // 走到这里说明 Tally 层拒绝了这次注册 —— 那守卫**没有**生效，不能登记状态
      // （登记了会让「居民 / 预占」永远从 0 开始，等于凭空占着名额）。
      warn(
        `engaging the Subagent concurrency guard failed: ${error instanceof Error ? error.message : String(error)} — ` +
          'the Multitask Subagent concurrency limit is NOT enforced for this session',
      )
      return
    }

    if (typeof dispose !== 'function') {
      // ⚠️ 这里**仍然登记状态**，这是刻意的：守卫可能已经装上了，只是没把注销器交回来。
      // 若此时不登记，`tools/result` 就找不到这个 state，预占永远还不回去 ⇒ 守卫在
      // 放行 `limit` 次之后**永久拒绝一切委派**。宁可留下一个卸不掉的守卫（它随 agent
      // scope 一起消失），也绝不制造「永久卡死」。
      warn(
        'the tool registry did not return a disposer for the Subagent concurrency guard; it may outlive this session',
      )
    }

    state.guardDispose = dispose
    states.set(agent, state)
    armedById.set(agent.id, state)
    ctx.logger?.info?.(
      `dsh-multitask: Subagent concurrency throttle engaged — at most ${limit} live Subagent(s) per coordinator this session`,
    )
  }

  // ── 主路径：agent 一出现就处理 ──────────────────────────────────────────────
  //
  // 载荷必须从 payload **对象**上取 `agent`：`agent/created` 传的是 payload 对象，
  // 不是 agent 本身。把第一个参数当 agent 读会得到一个没有 session、没有 ctx 的对象，
  // 于是 `isDelegatedChild` 判 false、整段被静默跳过 —— 同生态插件里被明确记录过的坑。
  //
  // ⚠️ 解构**必须留在 try 内**（与 `minimal-guard.mjs` 同因）：写在参数位置时，
  // 「连载荷对象都没有」这一种输入会在进入 try 之前就抛 TypeError，绕过下面的 catch。
  ctx.on('agent/created', (payload) => {
    try {
      const created = payload?.agent
      if (created === undefined || created === null) return

      if (isDelegatedChild(created)) {
        // 子代理：登记到它的协调者名下。**这一支不看它是从哪个入口派出来的** ——
        // 工具层（subagent / subagent_fork / …）与工作流引擎直连（workflow）建出来的
        // 子代理在 header 上长得一样，因此都进 residents。计数如实反映现实，
        // 而 `workflow` 那条路径没有预占也无所谓（见文件头：两套账各自自洽）。
        const parentId = created.session?.header?.parentSession
        const state = typeof parentId === 'string' && parentId !== '' ? armedById.get(parentId) : undefined
        if (state === undefined || state.released) return
        state.residents.add(created)
        ownerOfChild.set(created, state)
        return
      }

      arm(created)
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话创建。
      warn(`handling agent/created failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── 结算：归还预占 ──────────────────────────────────────────────────────────
  //
  // `tools/result` 是宿主在「权威最终结果」确定之后发出的观察者事件
  // （`dsh-tools:3395` 与 `:3409` 的 `notifyResult()`）。它**无论成功、失败还是被取消
  // 都会到**（`finishScheduledExecution()`，`:3382-3397`），所以它是预占唯一的、
  // 可靠的归还点。
  //
  // ⚠️ 用 `exec` 的**引用身份**做释放凭据，而不是「名字 + 计数」。只有自己放过的那
  // 一次调用才会被归还，重复事件（若将来宿主变了）也不会把计数减成负数。
  ctx.on('tools/result', (exec) => {
    try {
      if (exec === null || typeof exec !== 'object') return
      const agent = exec.agent
      if (agent === undefined || agent === null) return
      const state = states.get(agent)
      if (state === undefined || state.released) return
      if (!state.reserved.delete(exec)) return
      state.pending = state.pending > 0 ? state.pending - 1 : 0
    } catch (error) {
      warn(`settling a Subagent concurrency reservation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── 释放：协调者与子代理离开时各自归还 ──────────────────────────────────────
  //
  // 守卫层是按 scope key 存活的。scope key 被回收后复用到新 agent 上，会继承一条
  // 本该消失的守卫 —— 那是「新会话莫名被限流」的成因。所以协调者离开时**必须**卸掉。
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return

      const own = states.get(agent)
      if (own !== undefined) {
        release(own)
        return
      }

      // 子代理离开 ⇒ 归还居民名额。找不到归属不算异常（可能它是在本模块武装之前
      // 就建出来的，或它的协调者已经先走了）；静默忽略。
      const parent = ownerOfChild.get(agent)
      if (parent === undefined || parent.released) return
      parent.residents.delete(agent)
      ownerOfChild.delete(agent)
    } catch (error) {
      warn(`releasing the Subagent concurrency throttle failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── 卸载：本模块走了，守卫也不能留下 ────────────────────────────────────────
  //
  // 守卫挂在**别的 agent 的 scope** 上，`ctx` 自己的 fiber 回收管不到它们，
  // 所以必须显式卸。极简 ctx（例如本地校验里的假 ctx）可能没有 `effect`，
  // 那时监听器仍由 fiber 自动回收，只是守卫要等 agent 自己消失。
  try {
    ctx.effect(() => () => {
      for (const state of [...armedById.values()]) release(state)
    }, 'dsh-multitask: Subagent concurrency throttle')
  } catch {
    // 环境不支持 effect 时不影响主路径。
  }
}
