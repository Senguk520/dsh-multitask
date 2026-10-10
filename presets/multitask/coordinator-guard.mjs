/**
 * multitask-coordinator-guard — Multitask 模式的「减震器」。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * Multitask 模式要求主对话（协调者）只承载三类信息：用户的需求、下发的任务书、
 * 子代理回报的结论。任何过程性数据（文件内容、命令输出、搜索结果、构建日志）
 * 都不得进入协调者的上下文 —— 它们由子代理在自己的上下文里消化。
 *
 * 光靠人格指令做不到这一点：模型仍可能「顺手」自己跑一条命令。本模块把这条纪律
 * 变成**机制**：协调者的 agent scope 上装一条工具限制，把变更类/执行类/检索类工具
 * 从它的可见面里摘掉。工具不在，就调用不了，也就污染不了主上下文。
 *
 * ── 为什么限制协调者不会波及子代理（本模块成立的技术支点）────────────────────
 *
 * `dsh-subagent` 的 `applyChildComposition` 会强制每个子代理加入**父级那一份
 * preset**（`agentPresets.composeFrom(childCtx, parent.ctx)`），而 preset 注册表
 * 的 `join()` 是这样绑 scope 的：
 *
 *     parent: bindScopeParent(key, generation.key)   // 父是 preset 的 generation key
 *
 * 也就是说，协调者的 agent scope 与子代理的 agent scope **都直接挂在同一个
 * `generation.key` 下 —— 二者是兄弟，不是父子**。
 *
 * 而 `dsh-tools` 的 `view(scope)` 只沿 `chainLayers(scope)`（该 scope 自己的祖先链）
 * 逐层判定可见性：
 *
 *     if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
 *
 * 本模块把限制装在**协调者自己的 agent layer** 上。这个 layer 不在子代理的祖先链里，
 * 所以子代理完全不受影响，仍然从 `generation.key` 层继承完整工具集。
 *
 * 这恰好是我们要的：主对话窄、worker 宽。
 *
 * ── 为什么按「补集」下发，而不是写死黑名单 ──────────────────────────────────
 *
 * `tools.restrict()` 对**不存在的工具名会抛错**（见 dsh-tools 的 `restrict()`：
 * 它会拿 `restrictableNames` 校验每个名字）。所以不能预先写死一张黑名单 ——
 * 宿主 roster 一变，那张表就报错。
 *
 * 本模块反过来做：读该 scope **当前可见**的全部工具名，`deny = 可见集 − 保留集`。
 * 于是：
 *   - 名单里的每个名字都必然存在（它就是刚读出来的），`restrict()` 不会抛错；
 *   - 宿主以后新增任何工具，默认对协调者关闭 —— **无需改这个文件**；
 *   - 需要维护的只是那张**小的保留集**。
 *
 * 这与同生态里的 `dsh-liangshen` preset 的 `tool-catalog.mjs` 是同一个手法。
 *
 * ── 时机为什么必须在组装瀑布之外 ────────────────────────────────────────────
 *
 * `SystemPrompt.assemble()` 会**先**收集工具提供方并渲染各 section 的文本，
 * **然后**才跑 `system-prompt/assemble` 瀑布。因此在瀑布**内部**装限制，改变不了
 * 它所服务的那一次请求 —— 只能下一轮生效，等于第一次请求漏网。
 *
 * 所以本模块只在瀑布之外的两个安全窗口装限制：
 *   - `agent/created` —— 首次 prompt 组装之前（这是主路径）；
 *   - `tools/post-execute` —— 每次工具调用结束后，自愈补装。
 *
 * ── 失败要响亮 ──────────────────────────────────────────────────────────────
 *
 * 限制装不上，等于减震器失效、模式名存实亡。所以任何失败路径都写一条明确的
 * 警告日志（每种原因只报一次，避免刷屏），**不静默降级**。
 *
 * ── 模式隔离：只接管**属于本 preset** 的 agent（本轮修复的缺陷）──────────────
 *
 * 同一工作区里可以并存多种模式的会话（standard / ptc / Multitask…），每个会话各自
 * 绑一份 preset。**本守卫只允许收窄本 preset 自己的会话**，别的模式一个工具都不能少。
 *
 * 曾经的做法是「只要不是被委派的子代理，就收窄」。它错了，而且错得很隐蔽：
 *
 *   1. 新建会话按 profile 的 `selectedDefault` 起手（本机是 Multitask），
 *      `agent/created` 一到，本守卫就把限制装上了；
 *   2. 用户在**首轮之前**把该会话切成 standard —— 这是 DSH 允许的（`agent-preset/locked`
 *      只挡「已经开跑」的会话）；
 *   3. 切换会把该 agent 的 scope 父链**重绑**到 standard 的 generation key，于是本守卫
 *      不再是它的祖先、收不到它按 scope 过滤的事件 —— **可限制本身并不会因此消失**：
 *      `tools.restrict()` 把限制记在**该 agent 自己的 scope layer** 上（见 dsh-tools 的
 *      `restrict()`：`this.layers.effect(this.ctx, …)`，用的是 `agent.ctx` 的 scope），
 *      重绑父链不动它；
 *   4. 结果是那个 standard 会话被按 **Multitask 的保留集**削掉了 21 个工具
 *      （`read_image` `pwsh` `write` `edit` `web_search` `ssh_*` `task_board_*` …），
 *      表现为「standard 模式读不了图、没有终端」，而**没有任何日志**。
 *
 * 修法是加一条**归属判据**：`agent` 当前所属的 preset id 必须等于本守卫所属的
 * preset id，否则一律**卸掉**限制（而不是装上）。判据由注册表的 `composedPreset()`
 * 提供 —— 它读的就是 agent 当前绑定的那一份 preset，会随切换改变，而**不是**
 * 会话头里那个「创建时的 preset」（后者正是上面第 1 步会把人带偏的东西）。
 *
 * 与之配套，本模块还监听两个**无载体广播**（`tools/change`、`agent-preset/selected`）：
 * 它们不受 scope 过滤，所以「已经切走、本守卫够不到」的 agent 也能在这一刻被
 * 解除限制。没有这条，切换后那 21 个工具会一直缺着。
 *
 * @module dsh-multitask/presets/multitask/coordinator-guard
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-coordinator-guard'

/** 工具注册表必须先存在，才能读可见面、装限制。 */
export const inject = ['tools']

/**
 * 本守卫所属的 preset id —— 模式隔离判据的默认值。
 *
 * 正常情况下由 composition 那行显式传入（宿主半还会把它对齐到 profile 里可能的
 * `config.presetId` 覆盖值），这里只作为「直接调用本模块、没给配置」时的兜底。
 */
const DEFAULT_PRESET_ID = 'multitask'

/**
 * 「读不出事实」的独立取值，与「确定不属于任何 preset」（`undefined`）区分开。
 *
 * 两者的处置不同：`undefined` 是**确定的答案**（该 agent 没加入任何 preset），
 * 安静地不管即可；而读不出事实时既不能收窄（可能削到别的模式）、也不该假装没事，
 * 所以要留一条警告。
 */
const PRESET_UNKNOWN = Symbol('dsh-multitask/unknown-preset')

/**
 * 协调者默认保留的工具。
 *
 * 设计原则（用户选定的「平衡：只读核对」）：
 *   保留 —— 只读核对、委派、结果回收、与用户交互、编排；
 *   摘除 —— 一切写入/执行/检索/管理类工具。
 *
 * 这里**只列保留集，不列摘除面**：摘掉哪些名字由 `deny = 可见集 − 保留集`
 * 反推（见下方 `sync()`），所以 `write` `edit` `pwsh` `bash`、
 * `web_search` `web_fetch` `read_image`、`ssh_*`、`task_board_*`、
 * `plugin_manager`、`cordis_inspect_*` 被摘除的**唯一依据**就是「它们不在这里」。
 * 它们的具体种类在 docs/DESIGN.md 里作为例子列出，仅用于阅读。
 *
 * 不要在这里补第二张「摘除名单」：补进来也没人会读它，只会让后来者误以为
 * 摘除依据是那张表。（此处原本有一个 23 项的 `NOISY_BY_DEFAULT` 常量，
 * 因为全文无任何读取点、纯属误导，已删除。）
 *
 * 这个表可以放心写宽：不在当前 roster 里的名字不会造成任何后果
 * （deny 只从「实际可见集」里取，保留集多写几个名字只是不起作用而已）。
 */
const DEFAULT_KEEP = [
  // ── 只读核对：用来独立验证子代理的结论，而不是盲信它的回报 ──
  'read',
  'grep',
  'glob',
  // `file_info`（本包 `file-info.mjs` 注册的只读元数据工具）归入「只读核对」这一类，
  // 因为它补的正是**核对**这件事上的一个洞：`read` 不回字节数，于是「这个交付文件
  // 到底多大 / 是不是空的 / 存不存在」这类核对只能靠 shell —— 而协调者**没有** shell
  // （它被本文件摘掉了）。没有这一行，协调者就无法独立验证「五个文件的总字节数」
  // 这类子代理结论，只能盲信回报。
  //
  // ⚠️ 必须写在这个常量里，而不是靠 composition 那行的 `config.keep` 追加：
  // 那处传的是 `['subagent_ptc','subagent_minimal']`，语义是「Multitask 有哪几条
  // 委派路径」（见 composition.mjs 的注释，它专门说明该处**只**定义委派路径）。
  // 本工具与委派无关，塞进那里会让那张表的名实不符。两处都是**追加**语义
  // （`keep = new Set(DEFAULT_KEEP)` 之后逐项 `add`），所以写在这里不会被覆盖。
  'file_info',

  // ── 委派：Multitask 的核心动作 ──
  'subagent',
  'subagent_fork',

  // ── 子代理控制：后续追问、中断、清点 ──
  'send_message',
  'interrupt_agent',
  'list_agents',
  // ⚠️ 这里**刻意不列 `list_subagent_models`**：那是「让 AI 在某次委派里临时指定
  // 子代理模型」那条能力的配套发现工具，而本模式**不要**那条能力 ——
  // 子代理用哪个模型由用户在设置面板里按 worker 类型决定。
  // 该工具本就不会被注册（要它出现，委派行得设 `modelSelectionSettings: true`，
  // 而 composition 里四行都不设），所以不列它既正确、也少一处误导。

  // ── 结果回收：后台子代理的产出要能取回来 ──
  'job_list',
  'job_output',
  'job_kill',

  // ── 编排：协调者正是该跑扇出脚本的角色 ──
  'workflow',

  // ── 与用户交互与自我管理 ──
  'ask_user_question',
  'todo_write',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'present',
  // 技能正文是「怎么做」的操作手册，不是过程数据；协调者需要它来写任务书。
  'skill',
]

/** 一个每次进程只警告一次的记录器。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/coordinator-guard: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 子代理的 session header 由 `dsh-subagent` 的 `childSessionMeta()` 写入：
 * `origin: 'subagent'`、`parentSession`、`delegationDepth`。三者任一成立即视为子代理。
 * 用三个信号而不是一个，是为了在 header 字段被裁剪或处于构造中间态时仍然判得准 ——
 * 判错的代价很高：把 worker 当成协调者，worker 就没工具可用了。
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
 * 读一个 agent scope 当前**可见**的工具名。
 *
 * 先试 agent 自己的 scoped 视图，再退回全局注册表 —— 与 `dsh-liangshen` 的
 * `tool-catalog.mjs` 同款容错写法：某些测试桩只提供 `sdkSchemas`。
 *
 * 会滤掉 `run_code`：它是 PTC 呈现模式的保留传输名，`restrict()` 明确拒绝它。
 *
 * @param ctx - 插件上下文（用来兜底取全局 tools 服务）。
 * @param agent - 目标 agent。
 * @returns 可见工具名数组；读不到时返回空数组。
 */
function visibleToolNames(ctx, agent) {
  const candidates = []
  const scoped = agent?.ctx?.tools
  if (scoped !== undefined && scoped !== null) candidates.push(scoped)
  try {
    const registry = ctx.get('tools')
    if (registry !== undefined && registry !== null) candidates.push(registry)
  } catch {
    // 取不到全局注册表不算致命，继续试 scoped 视图。
  }

  for (const tools of candidates) {
    for (const method of ['schemas', 'sdkSchemas']) {
      if (typeof tools?.[method] !== 'function') continue
      try {
        const schemas = tools[method](agent)
        if (!Array.isArray(schemas)) continue
        const names = []
        for (const schema of schemas) {
          const toolName = schema?.name
          if (typeof toolName !== 'string' || toolName === '') continue
          if (toolName === 'run_code') continue
          names.push(toolName)
        }
        if (names.length > 0) return names
      } catch {
        // 换下一个来源；读不到不是致命错误。
      }
    }
  }
  return []
}

/** 规范化一个 preset id：只接受非空字符串。 */
function normalizePresetId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 按会话 id 找回一个**活着的** agent。
 *
 * 只在「切进本模式」那一刻用得到：那个 agent 从没被本守卫收窄过，所以在册表里找不着，
 * 但广播只给了会话 id。`agents` 是宿主面服务（dsh-agent 注册为 `agents`），
 * 沿 ctx 链向上取得到，`get(id)` 是只读查询、返回 undefined 表示已不在。
 *
 * @param ctx - 本守卫的上下文。
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
 * 读一个 agent **当前实际所属**的 preset id。
 *
 * 用注册表的 `composedPreset()` —— 它读的是 `standingMountFor(agent.ctx)`，也就是
 * agent **当前绑定**的那一份 preset，会随会话切换而改变。刻意**不读** session
 * header 里的 `agentPreset`：那个字段记的是「创建时用的是哪一份」，切换之后就不成立
 * —— 本轮缺陷正是从这里把人带偏的（会话头写 multitask、实际早就是 standard）。
 *
 * 三种返回刻意区分：
 *   - 一个字符串：确定的答案；
 *   - `undefined`：确定「没有加入任何 preset」；
 *   - `PRESET_UNKNOWN`：读不出来（注册表缺席、方法缺失、抛错）。
 *
 * @param ctx - 本守卫的上下文（作为第二个取服务的来源）。
 * @param agent - 目标 agent。
 * @returns preset id、`undefined`，或 `PRESET_UNKNOWN`。
 */
function composedPresetId(ctx, agent) {
  const agentCtx = agent?.ctx
  if (agentCtx === undefined || agentCtx === null) return PRESET_UNKNOWN

  const carriers = [agentCtx, ctx]
  for (const carrier of carriers) {
    try {
      const registry = carrier?.get?.('agentPresets')
      if (registry === undefined || registry === null) continue
      if (typeof registry.composedPreset !== 'function') continue
      // composedPreset 对「没加入任何 preset」返回 undefined —— 那是**有效答案**，
      // 不是读取失败，所以原样返回（normalize 会把它保留成 undefined）。
      return normalizePresetId(registry.composedPreset(agentCtx))
    } catch {
      // 换下一个来源；都读不到才算 UNKNOWN。
    }
  }
  return PRESET_UNKNOWN
}

/**
 * 判定一个 agent 当前该由**哪一份** preset 收窄。
 *
 * 判据分两层，顺序不可颠倒：
 *
 *   1. **活绑定（权威）**：`registry.composedPreset(agent.ctx)` 读的是 agent **当前**
 *      绑定的那一份 preset，会随会话切换而改变。这是唯一能识别「已切走」的信号。
 *   2. **创建时的预设（退路）**：只有在活绑定**读不出来**时才用它 ——
 *      `undefined`（还没绑上）或 `PRESET_UNKNOWN`（注册表读不到）。
 *
 * ⚠️ 退路**只用于「活绑定缺席」，绝不用于「活绑定是别的 id」**。这个区分是关键：
 * 已切走的会话活绑定是**存在**的（被重绑到了新 generation），会明确返回另一个 id，
 * 因此在第 1 层就被拦下 —— 不会因为会话头还写着旧值而被误收窄。
 *
 * 为什么需要第 2 层：新建会话的 preset 绑定与 `agent/created` 的先后顺序没有实证，
 * 若绑定更晚，只读活绑定会让**真正的 Multitask 会话**也停止收窄（主功能静默失效）。
 * 退路把这种时序不确定性消掉，代价是「注册表读不到 + 会话头已过期」这一组合会判错 ——
 * 而那种组合不可能出现：本守卫是**由该注册表装载的**，它不在，本模块也不会在。
 *
 * @param ctx - 本守卫的上下文。
 * @param agent - 目标 agent。
 * @param warn - 每次进程只报一次的告警器。
 * @returns preset id，或 `undefined`（确定/推定没加入任何 preset）。
 */
function ownerPresetId(ctx, agent, warn) {
  const live = composedPresetId(ctx, agent)
  if (typeof live === 'string') return live
  if (live === PRESET_UNKNOWN) {
    warn('could not read which preset an agent is composed with; falling back to the preset recorded when its session was created (the live binding is the authority, so this is only reached when it is unavailable)')
  }
  return normalizePresetId(agent?.session?.header?.agentPreset)
}

/**
 * 装载协调者守卫。
 *
 * @param ctx - preset scope 的插件上下文（工具限制会挂在它所属作用域上）。
 * @param config - 该行在 composition 里的 `config`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  // 本守卫只收窄**绑定到本 preset** 的会话。id 由 composition 那行传入
  // （宿主半会把 profile 里可能的 `config.presetId` 覆盖值对齐到这里）。
  const presetId = normalizePresetId(config?.presetId) ?? DEFAULT_PRESET_ID

  const keep = new Set(DEFAULT_KEEP)
  for (const entry of config?.keep ?? []) {
    if (typeof entry === 'string' && entry !== '') keep.add(entry)
  }
  const extraDeny = new Set()
  for (const entry of config?.extraDeny ?? []) {
    if (typeof entry === 'string' && entry !== '') extraDeny.add(entry)
  }

  const warn = warnOnceFactory(ctx)

  /** 每个协调者的在线限制：agent -> { deny, dispose }。 */
  const live = new WeakMap()

  /**
   * 本守卫**正在收窄**的 agent：sessionId -> agent。
   *
   * `live` 用 WeakMap 是为了不阻止回收，但它**不可枚举**，而「模式切换」这件事
   * 只会以一个广播事件（`agent-preset/selected`）的形式到达，事件里只有 session id。
   * 所以要另存一张可枚举、可按 id 查的表。
   *
   * 只有「确实被收窄」的 agent 才会进来：放过的不记，免得白白延长它们的存活期。
   */
  const tracked = new Map()

  /** 取一个 agent 的会话 id（广播事件用的就是它）。 */
  const keyOf = (agent) => {
    const id = agent?.session?.id ?? agent?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * 卸掉一个协调者的现行限制。
   *
   * @param agent - 目标 agent。
   * @returns 是否真的卸掉了一条（用于区分「原本就没装」与「刚卸掉」）。
   */
  const release = (agent) => {
    const key = keyOf(agent)
    if (key !== undefined) tracked.delete(key)
    const state = live.get(agent)
    if (state === undefined) return false
    live.delete(agent)
    try {
      state.dispose()
      return true
    } catch (error) {
      warn(`lifting an earlier coordinator restriction failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 重算并装上一个协调者的限制。
   *
   * 先卸再读再装，是**故意**的：`schemas()` 返回的是**已经过限制**的可见面，
   * 如果不先卸掉旧的限制，下一次重算就只看得到上次留下的那个缝，
   * 新注册的工具永远补不进 deny 集。
   *
   * @param agent - 目标 agent。
   */
  const sync = (agent) => {
    if (agent === undefined || agent === null) return

    // 子代理走原路：它们必须有完整工具集来干活。
    if (isDelegatedChild(agent)) {
      release(agent)
      return
    }

    // ── 模式隔离：只接管**属于本 preset** 的会话 ──────────────────────────────
    //
    // 放在每一条「不能自行解除」的早退路径之前：读不出可见面、读不出工具注册表
    // 等等，都不该让一条**装错了对象**的限制继续留着。
    const owner = ownerPresetId(ctx, agent, warn)
    if (owner !== presetId) {
      // 三种情形都**卸掉**，而不是「不动」：
      //   · 属于别的模式 —— 收窄别的模式的工具面正是本轮要修的缺陷；
      //   · `undefined`（没加入任何 preset，或推定如此）—— 本模式管不着它；
      //   · 认不出来 —— 宁可这一轮少收窄一次（下一个窗口会重试），
      //     也不能把别的模式削掉。削错了**没有任何日志**，比漏装难查得多。
      const lifted = release(agent)
      if (lifted) {
        ctx.logger?.info?.(
          `dsh-multitask: released the shock absorber for a session of another mode (${owner ?? 'no preset'}); its tool roster is left untouched`,
        )
      }
      return
    }

    // 先卸掉旧限制，才能读到未过滤的全量可见面。
    release(agent)

    const visible = visibleToolNames(ctx, agent)
    if (visible.length === 0) {
      // 读不到工具面时**不能**装一条空限制 —— 那会静默地「什么都没限制」，
      // 让模式看起来生效了而实际漏风。留待下一个窗口重试。
      warn('no tool schemas were readable for a coordinator scope; the shock absorber is NOT engaged for this session yet (will retry on the next tool call)')
      return
    }

    const deny = visible.filter((toolName) => extraDeny.has(toolName) || !keep.has(toolName))
    if (deny.length === 0) return

    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      warn('the agent scope exposes no tools.restrict(); the shock absorber cannot be engaged and this session keeps the full roster')
      return
    }

    try {
      const dispose = tools.restrict({ deny })
      if (typeof dispose !== 'function') {
        warn('the tool registry did not confirm the coordinator restriction; this session keeps the full roster')
        return
      }
      live.set(agent, { deny: new Set(deny), dispose })
      const key = keyOf(agent)
      if (key !== undefined) tracked.set(key, agent)
      ctx.logger?.info?.(
        `dsh-multitask: coordinator scope engaged — withheld ${deny.length} tool(s): ${[...deny].sort().join(', ')}`,
      )
    } catch (error) {
      // restrict() 会在名字未知时抛错。走到这里说明「可见集 − 保留集」里
      // 混进了注册表不认识的名字，这是 roster 竞态，不是正常状态 —— 必须报出来。
      warn(`engaging the coordinator restriction failed: ${error instanceof Error ? error.message : String(error)} — this session keeps the full roster`)
    }
  }

  /**
   * 处理「某个会话的 preset 可能变了」这件事。
   *
   * 两个**无载体广播**（`tools/change`、`agent-preset/selected`）共用它。
   *
   * 为什么这条不可省：会话一旦切走，本守卫就不在那个 agent 的祖先链上了，按 scope
   * 过滤的 `tools/post-execute` **再也收不到它的任何事件** —— 也就是「最后一次 sync」
   * 永远不会来，装错的限制会一直留着。而广播没有载体、不受 scope 过滤，所以能把
   * 「该重判了」这个信号送到。
   *
   * 两个方向都要处理：
   *   · 切**走**（Multitask → 别的模式）：该 agent 在册，直接重判 → 解除；
   *   · 切**进来**（别的模式 → Multitask）：该 agent **不在册**（从没收窄过），
   *     所以要用 `agents` 服务按 id 把它找回来，否则「首轮之前切进 Multitask」
   *     会漏装收窄，第一轮工具面偏宽。
   *
   * `id` 缺席（`tools/change` 就是这种）时退化为遍历在册 agent 做一次有界全量核对，
   * 正好覆盖「切换与工具变化同时发生」的情形。
   *
   * @param id - 可选的会话 id。
   */
  const resync = (id) => {
    if (typeof id === 'string' && id !== '') {
      const agent = tracked.get(id) ?? agentById(ctx, id)
      if (agent !== undefined) sync(agent)
      return
    }
    for (const agent of [...tracked.values()]) sync(agent)
  }

  // ── 主路径：agent 一出现就装，赶在首次 prompt 组装之前 ──
  //
  // payload 刻意解构：`agent/created` 传的是 payload **对象**，不是 agent 本身。
  // 把第一个参数当 agent 读，会得到一个没有 session、没有 ctx 的对象，
  // 限制就被静默跳过 —— 这是同生态插件里被明确记录过的坑。
  ctx.on('agent/created', ({ agent }) => {
    sync(agent)
  })

  // ── 自愈路径：每次工具调用结束后重算 ──
  //
  // 每个「两次组装之间」的窗口都适合修正**下一次**组装。宿主如果在本会话存续期间
  // 又注册了新工具，这里会把它补进 deny 集。
  //
  // 声明 prepend 与 concurrency-safe，使它不会拖慢无关的只读调用。
  ctx.on('tools/post-execute', (exec, _result, next) => {
    sync(exec?.agent)
    return next()
  }, { prepend: true })

  // ── 切换路径：会话换了 preset 就要立刻重判归属 ──
  //
  // `agent-preset/selected` 由注册表以 `ctx.emit("agent-preset/selected", sessionId, id)`
  // 广播（dsh-agent-preset-registry 监听 `session/event` 后转发）。两个参数分别是
  // 会话 id 与新的 preset id —— 这里只关心前者。
  ctx.on('agent-preset/selected', (sessionId) => {
    resync(sessionId)
  })

  // ── 工具面变化：兜底重判 ──
  //
  // `tools/change` 是**无参数**广播（dsh-tools 在工具层变化时 emit，注册表
  // recompose 之后也会 emit），所以走全量核对分支。
  ctx.on('tools/change', () => {
    resync(undefined)
  })

  // ── 释放：agent 离开时必须卸掉限制 ──
  //
  // 限制层是按 scope key 存活的。scope key 被回收后复用到新 agent 上，
  // 会继承一条本该消失的过滤 —— 那就是「新会话莫名少了一堆工具」的成因。
  ctx.on('agent/disposed', ({ agent }) => {
    release(agent)
  })
}
