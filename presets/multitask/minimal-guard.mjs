/**
 * multitask-minimal-guard — 把 `subagent_minimal` 收窄成**真的**只读 worker。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * `composition.mjs` 里 `tool-subagent-minimal` 那一行的 `toolFilter.deny` 是**静态**
 * 三项（`write` / `edit` / `pwsh|bash`）。它只敢列「本 composition 自己确定会注册」
 * 的名字，因为 `tools.restrict()` 对**当前部署不存在**的名字会**抛错**，而它是在
 * 委派窗口里被调用的 —— 抛出来的表现是「委派功能坏了」，极难反查。
 *
 * 后果是：任何**由别的插件**注册进这个部署的工具，对 minimal worker 依然可见。
 * 实测（自查 + 实调）确认本机部署里 minimal worker 仍持有：
 *
 *   - 6 个 `ssh_*`（含 `ssh_exec` —— 它在**远端主机**上执行命令）；
 *   - 8 个 `task_board_*`（含 `task_board_run`）。
 *
 * 也就是说「只读调研 worker」其实能改远端机器、能触发看板任务 —— 人格说它不能，
 * 机制却让它能。**人格与机制不一致**正是本包反复踩过的坑。
 *
 * ── 为什么是「自适应」而不是把静态名单写长 ───────────────────────────────────
 *
 * 不能把 `ssh_*` 直接写进 `MINIMAL_DENY`：**没装 ssh 插件的部署**会在创建 minimal
 * worker 时**直接失败**，比现在更糟（这正是 `composition.mjs` 作者当初不列它们的理由）。
 *
 * 本模块改用同仓 `coordinator-guard.mjs` 已验证的手法 —— **从该 scope 实际可见的
 * 工具集反推 deny**：
 *
 *     deny = 可见集 − 允许集
 *
 * 于是名单里每个名字都必然合法（它就是刚读出来的），`restrict()` 不会抛错；
 * 宿主或插件以后新增任何工具，默认对 minimal worker 关闭 —— **无需改这个文件**。
 *
 * ── 两层 restrict 的交互：求交，不是替换（本模块成立的技术支点）──────────────
 *
 * `dsh-subagent` 的 `applyChildComposition` 已经先施加了**静态** `toolFilter`
 * （`_investigation/_dshsrc/dsh-subagent/lib/index.js:522`）：
 *
 *     if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);
 *
 * 本模块要在**同一 scope** 上再施加一层。两层会不会互相覆盖？**不会**，三处源码互证：
 *
 *   1. `dsh-tools/lib/index.js:2889-2891`（JSDoc）：`Restrictions **intersect**;`；
 *   2. `dsh-tools/lib/index.js:2909`：`layer.restrictions.append(compiled)` —— 追加；
 *   3. `dsh-scope/lib/index.js:98-109`：`append()` 用一个**新 `Symbol()`** 作 key，
 *      只 `data.set`，**从不覆盖已有条目**；再由 `dsh-tools/lib/index.js:2642` 的
 *      `admits()` **遍历全部** restriction，任一命中即判不可见。
 *
 * 所以有效 deny = 静态层 ∪ 自适应层，**结构上不可能放宽权限**。
 *
 * ⚠️ 由此推出一个**反直觉但有依据**的决定：本模块**不**把静态三项
 * （`write` / `edit` / `pwsh|bash`）重复写进 deny。两个理由：
 *   - 求交语义下它们**不是必需**的：即使本模块漏掉某项，静态层仍然拦着，不会漏；
 *   - 重复写**反而危险**：deny 里的名字必须存在于 `restrictableNames`，而 `bash` 与
 *     `pwsh` 是**互斥**的（另一平台那个名字根本没注册）—— 无条件同时列出会在 win32 上
 *     抛 `names unknown global tool "bash"`。静态那层用平台条件避开了这个坑，
 *     本模块不该把它再引入一遍。
 *
 * 还有一点让「重复列出」更加没有意义：本模块在 `agent/created` 时读到的可见集，
 * 是**静态层已经生效之后**的面（见下「时机」），`write`/`edit`/`pwsh` 根本不在里面。
 *
 * ── 允许集：白名单，而且**多列不存在的名字是安全的**─────────────────────────
 *
 * 算法是「可见集 − 允许集」，所以允许集里列一个本部署没有的 `foo` 不会产生任何后果
 * （`foo` 不在可见集里，算差集时自然不参与）。**这正是本方案相对静态名单的优势**：
 * 允许集可以放心写宽、跨部署复用；而静态 deny 名单写宽就会抛错。
 *
 * ── 时机：`agent/created`，且必须在首次 prompt 组装之前 ──────────────────────
 *
 * 理由与 `coordinator-guard.mjs` / `subagent-mode.mjs` 完全相同：`SystemPrompt.assemble()`
 * 会先收集工具提供方并渲染各 section 文本，然后才跑 `system-prompt/assemble` 瀑布，
 * 所以在瀑布**内部**改工具面改变不了它服务的那次请求 —— 只能下一轮生效，
 * 等于第一次请求漏网。`agent/created` 是瀑布之外的安全窗口。
 *
 * 能拿到 persona 标记的前提是描述符已经写进 session。已核实：`dsh-subagent` 的
 * `activations.materialize()` 是**先 `setup`**（append descriptor + applyChildComposition）
 * **再 `announce`**（发出 `agent/created`），且 `setup` 里 `append("subagent/descriptor")`
 * 是同步的 —— 所以本模块在 `agent/created` 里一定读得到标记，也一定能看到静态层已生效。
 *
 * ── 失败要响亮（与 subagent-mode 取向相反，与 coordinator-guard 一致）────────
 *
 * 收窄装不上，等于「只读 worker」是假的：它仍能改远端机器。所以任何失败路径都写一条
 * 明确的警告日志（每种原因只报一次，避免刷屏），**不静默降级**。
 * 注意这与 `subagent-mode.mjs` 刻意相反：那里装不上只是少一层便利，而这里装不上
 * 是一个**安全承诺**没兑现。
 *
 * ── 绝不碰协调者与别的 worker ────────────────────────────────────────────────
 *
 * 硬前置与 `coordinator-guard.mjs` / `subagent-mode.mjs` 用**同一条判据**
 * （`origin` / `parentSession` / `delegationDepth` 三信号）：不是子代理就一律不动作。
 * 然后还要命中 `[multitask-mode:minimal]` 标记 —— 没标记的行
 * （`subagent` / `subagent_fork` / `subagent_ptc`）**完全不受影响**。
 *
 * ── 如实写出的边界（别把它当成比实际更强的东西）─────────────────────────────
 *
 *   1. 本模块只读 `agent.ctx.tools.restrict` / `schemas` / `view`。若该部署的
 *      工具服务不暴露这些，收窄**装不上**（会响亮告警），此时 minimal worker 退回
 *      「只有静态三项被摘掉」的旧状态 —— 那是**没有变好**，不是变坏。
 *   2. 触发点只有 `agent/created` + `agent/disposed`（卸限制）。**没有**自愈重算：
 *      若某个插件在 minimal worker 创建**之后**才注册一个全局变更类工具，
 *      那个工具不会被摘掉。这是有意的取舍 —— 代价是「会话中途热装插件」这一种
 *      假设性场景，收益是不为每个 worker 的每次工具调用都重扫一遍 session 事件。
 *   3. 子代理**自己 scope 上**注册的工具（例如委派运行时按需注册的
 *      `structured_output`）**不受任何 restriction 影响**：`dsh-tools` 的
 *      `view()` 把 own 层注册无条件放进可见面（`dsh-tools/lib/index.js:2975-2978`）。
 *      这是上游的设计（注释 `:2944-2949` 明说：过滤必须不能掐掉子代理作答所依赖的
 *      机制）。本模块因此**必须**把这些名字从 deny 里排除（它们不在
 *      `restrictableNames` 里，写进去会抛错）。
 *
 * @module dsh-multitask/presets/multitask/minimal-guard
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-minimal-guard'

/** 工具注册表必须先存在，才能读可见面、装限制。 */
export const inject = ['tools']

/**
 * minimal worker 的**允许集**（白名单）。
 *
 * 设计原则：只列「**可证明**是只读、或对任何东西都没有持久副作用」的名字。
 * 判据是「能不能证明它只读」，不是「它看起来有没有用」—— 因为这是白名单，
 * 漏列一个只读工具的代价是「这个模式弱一点」（可接受、可后补），
 * 而多列一个会写东西的代价是**安全承诺失效**（不可接受）。
 *
 * ⚠️ 与 `coordinator-guard.mjs` 的 `DEFAULT_KEEP` 是**两份不同的表**，不要合并：
 * 协调者要的是「委派 + 结果回收 + 编排」，worker 要的是「只读调研」。
 * 把委派类工具（`subagent` / `send_message` / `workflow` …）留给 worker 恰好是
 * 本模块要消灭的东西 —— 人格里明写「Do not delegate further」。
 *
 * 这个表可以放心写宽：不在当前 roster 里的名字不会造成任何后果。
 */
const DEFAULT_MINIMAL_KEEP = [
  // ── 只读文件面：人格里承诺的「read files, search file contents, discover paths」──
  'read',
  'grep',
  'glob',
  // `read_image` 读一个已存在的图像文件并把它交回模型，不产生任何持久副作用。
  // 它常由别的插件注册，所以在本 composition 的 roster 里可能不存在 ——
  // 无所谓：多列一个不存在的名字是安全的（见文件头「允许集」一节）。
  'read_image',
  // `file_info`（本包 `file-info.mjs` 注册）只调 `ctx.fs.resolve()` + `ctx.fs.stat()`，
  // 不读内容、不写任何东西 —— 属可证明的只读，所以收进允许集。
  //
  // 它对本模式尤其重要：只读调研 worker 的典型任务正是「核对这批交付物」，
  // 而它**没有** shell（静态层已摘掉 pwsh），所以字节数这类元数据原本**无路可走**。
  // 漏列它的代价与 `web_*` 那次同类：人格说它能核对、机制却不给工具 ——
  // 方向反过来（人格没有、实际有）但同样是「人格与机制不一致」。
  'file_info',

  // ── 联网检索：**用户明确要求保留**──
  //
  // 只读调研经常需要联网查资料，摘掉反而削弱这个模式的价值。这两条是
  // `MINIMAL_WORKER_PERSONA` 里如实写明的能力（「and search/fetch the web」），
  // 所以它们必须常驻在这里 —— 摘掉它们会让**人格与机制再次不一致**，
  // 而且是往「人格说有、实际没有」这个方向不一致。
  'web_search',
  'web_fetch',

  // ── 技能手册：读一份「怎么做」的操作说明，不改任何东西 ──
  'skill',

  // ── 自身进度与交付声明：没有持久副作用 ──
  //
  // `todo_write` 只改它**自己会话内**的待办列表；`present` 只是把已存在的文件
  // 声明为交付物（它不创建、不修改文件）。二者都不会碰到工作区或远端主机，
  // 所以归入「无害」。它们常驻的另一个理由是人格里承诺了「自己把活干完再汇报」，
  // 拿掉会让 worker 无法记录多步进度。
  'todo_write',
  'present',
]

/** 一个每次进程只警告一次的记录器（与 coordinator-guard / subagent-mode 同款，避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/minimal-guard: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 三个信号任一成立即视为子代理 —— 与 `coordinator-guard.mjs` 的 `isDelegatedChild`
 * 保持**同一条判据**（那里写明：判错的方向代价很高）。这里判错的方向同样危险：
 * 把协调者误判成子代理，就会在协调者 scope 上摘工具，减震器的语义被改写。
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
 * persona 里的模式标记。
 *
 * ⚠️ 必须与 `composition.mjs` 导出的 `MINIMAL_MODE_MARKER` **逐字一致**。
 * 两个文件各自留一份常量而不是互相 import，是为了保持本包本地模块「零 import」的
 * 约定（`subagent-mode.mjs` 对 `PTC_MODE_MARKER` 也是这么做的）。
 */
const MINIMAL_MODE_MARKER = '[multitask-mode:minimal]'

/**
 * 取该子代理 session 里能看到的事件数组。
 *
 * `ownEvents()` 优先，退到 `snapshotEvents()`；二者都是同步读，因而能在
 * `agent/created` 这个非异步窗口里使用。上游把这两个方法标为 deprecated
 * （推荐异步 `sessionQuery`），但那套 API 在这里不可用：本模块需要的是
 * 「创建窗口内的同步读」。取不到就当作「没有标记」，而不是抛错。
 *
 * @param agent - 目标子代理。
 * @returns 事件数组（可能为空）。
 */
function sessionEvents(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return []
  for (const method of ['ownEvents', 'snapshotEvents']) {
    if (typeof session[method] !== 'function') continue
    try {
      const events = session[method]()
      if (Array.isArray(events) && events.length > 0) return events
    } catch {
      // 换下一个来源；读不到不是致命错误。
    }
  }
  return []
}

/**
 * 从子代理的 `subagent/descriptor` 事件里取该行配置的 persona。
 *
 * descriptor 是**唯一**能读到「这一行用了哪份 persona」的地方：它是委派行原样的
 * 快照，而不是子代理的 system prompt（那要等组装，且可能已被 scope 层叠改写）。
 *
 * @param agent - 目标子代理。
 * @returns persona 文本，或 undefined。
 */
function descriptorPersona(agent) {
  for (const event of sessionEvents(agent)) {
    if (event?.type !== 'subagent/descriptor') continue
    const persona = event?.data?.persona
    if (typeof persona === 'string' && persona !== '') return persona
  }
  return undefined
}

/**
 * 判定该子代理是不是 minimal（只读）worker。
 *
 * 找不到标记 = 不是本模块的对象。这样做的直接后果是：`subagent` / `subagent_fork` /
 * `subagent_ptc` 三条**别的**委派路径完全不受影响 —— 这是「不破坏现有模式」的实现
 * 方式，而不是靠额外判断。
 *
 * @param agent - 目标子代理。
 * @returns 命中 minimal 标记时为 true。
 */
function isMinimalChild(agent) {
  const persona = descriptorPersona(agent)
  if (typeof persona !== 'string') return false
  return persona.includes(MINIMAL_MODE_MARKER)
}

/**
 * 读一个 agent scope 当前**可见**的工具名。
 *
 * 先试 agent 自己的 scoped 视图，再退回全局注册表 —— 与 `coordinator-guard.mjs` 的
 * `visibleToolNames()` 同款容错写法（某些瘦身部署/测试桩只提供其中一个）。
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

/**
 * 读该 scope 里**可以被 restrict 的**工具名集合。
 *
 * ⚠️ 这一步不是优化，是**防抛错**。`dsh-tools` 的 `view()`（`:2959-2985`）里，
 * 可见面由两部分拼成，但只有一部分是可限制的：
 *
 *     for (const [name, definition] of inherited) {          // 继承面（全局 + 祖先）
 *       restrictableNames.add(name)                            // ← 只有这些可 restrict
 *       if (layers.every((layer) => layer.admits(name))) visible.set(name, definition)
 *     }
 *     if (own !== void 0) for (const … of own.tools.entries()) {  // **自己 scope** 的注册
 *       visible.set(name, definition)                          // ← 进 visible，但**不进**
 *     }                                                        //   restrictableNames
 *
 * 而 `restrict()` 是拿 `restrictableNames` 校验的（`:2906-2908`），名字不在里面就抛
 * `names unknown global tool …`。子代理**自己 scope** 上会注册 `structured_output`
 * （`dsh-subagent-in-process-driver/lib/index.js:55` 的 `childCtx.tools.register`），
 * 它会出现在 `schemas()` 里却不可 restrict —— 照抄「可见集 − 允许集」就会**抛错**。
 *
 * 所以：拿得到这个集合就据它裁剪；拿不到（服务的形状不同）返回 undefined，
 * 表示「不知道，不能据此裁剪」，由调用方继续走并在抛错时响亮告警。
 *
 * @param tools - 候选工具服务对象。
 * @param agent - 目标 agent。
 * @returns 可限制名字的 Set，或 undefined（读不到）。
 */
function restrictableNameSet(tools, agent) {
  if (typeof tools?.view !== 'function') return undefined
  try {
    const view = tools.view(agent)
    const names = view?.restrictableNames
    if (names === undefined || names === null) return undefined
    return new Set(names)
  } catch {
    return undefined
  }
}

/**
 * 装载只读守卫：把带 `[multitask-mode:minimal]` 标记的子代理 scope 收窄成真只读。
 *
 * @param ctx - preset scope 的插件上下文（限制会挂在目标 agent 自己的 scope 上）。
 * @param config - 该行在 composition 里的 `config`（`{ enabled, keep }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const keep = new Set(DEFAULT_MINIMAL_KEEP)
  for (const entry of config?.keep ?? []) {
    if (typeof entry === 'string' && entry !== '') keep.add(entry)
  }

  const warn = warnOnceFactory(ctx)

  /**
   * 已经成功收窄过的 agent。用 WeakSet 而不是 Set：agent 被回收后不该由本模块持有
   * 强引用。这也是**幂等**的实现方式 —— 同一 agent 重复触发不会重复施加。
   */
  const narrowed = new WeakSet()
  /** 每个 agent 的在线限制：agent -> dispose。用于 `agent/disposed` 时卸掉。 */
  const live = new WeakMap()

  /** 卸掉一个 worker 的现行限制。 */
  const release = (agent) => {
    const dispose = live.get(agent)
    if (dispose === undefined) return
    live.delete(agent)
    try {
      dispose()
    } catch (error) {
      warn(`lifting an earlier read-only restriction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 收窄一个 agent（若它确实是 minimal worker）。
   *
   * @param agent - 目标 agent。
   */
  const narrow = (agent) => {
    if (agent === undefined || agent === null) return

    // ── 硬前置 1：绝不作用于协调者 ──
    // 判错方向代价最高：在协调者 scope 上摘工具会改写减震器语义。
    if (!isDelegatedChild(agent)) return

    // ── 硬前置 2：只认 minimal 标记 ──
    // 没标记的行（subagent / subagent_fork / subagent_ptc）一律不动作。
    if (!isMinimalChild(agent)) return

    if (narrowed.has(agent)) return

    const tools = agent?.ctx?.tools
    if (tools === undefined || tools === null || typeof tools.restrict !== 'function') {
      warn(
        'a read-only worker scope exposes no tools.restrict(); it was NOT narrowed, so it keeps every tool ' +
          'the static filter did not remove (including any ssh_* / task_board_* this deployment registers)',
      )
      return
    }

    const visible = visibleToolNames(ctx, agent)
    if (visible.length === 0) {
      // 读不到工具面时**不能**装作收窄成功 —— 那会让「只读」变成一句空话。
      // 这里不装任何东西（也不放宽任何东西），只告警。
      warn(
        'no tool schemas were readable for a read-only worker scope; it was NOT narrowed, so it keeps every tool ' +
          'the static filter did not remove (will not be retried: the creation window has passed)',
      )
      return
    }

    const restrictable = restrictableNameSet(tools, agent)
    const deny = []
    const seen = new Set()
    for (const toolName of visible) {
      if (seen.has(toolName)) continue
      seen.add(toolName)
      // `run_code` 是 PTC 呈现的保留传输名，出现在 allow/deny 里 `restrict()` 一律抛错。
      if (toolName === 'run_code') continue
      // 不在 restrictableNames 里的名字（例如自己 scope 注册的 `structured_output`）
      // 既**不该**也**不能**被摘：写进 deny 会直接抛错。
      if (restrictable !== undefined && !restrictable.has(toolName)) continue
      if (keep.has(toolName)) continue
      deny.push(toolName)
    }

    // 差集为空时**不要**调 `restrict()`：`allow`/`deny` 全空会抛
    // `tools.restrict({}) is a no-op`。走到这里说明该 worker 的可见面本来就已经
    // 只剩允许集了 —— 那正是我们想要的状态，无事可做。
    if (deny.length === 0) return

    try {
      const dispose = tools.restrict({ deny })
      narrowed.add(agent)
      if (typeof dispose === 'function') {
        live.set(agent, dispose)
      } else {
        warn('the tool registry did not return a disposer for the read-only restriction; it may outlive its agent')
      }
      ctx.logger?.info?.(
        `dsh-multitask: read-only worker scope engaged — withheld ${deny.length} tool(s): ${[...deny].sort().join(', ')}`,
      )
    } catch (error) {
      // 走到这里说明 deny 里混进了注册表不认识的名字 —— 也就是上面那次可见面读取
      // 与这次施加之间发生了 roster 竞态。必须报出来，且**不重试、不降级**：
      // 少摘的工具不会因此被摘掉，但没有偷偷放宽任何东西（静态层仍在）。
      warn(
        `engaging the read-only restriction failed: ${error instanceof Error ? error.message : String(error)} — ` +
          'that worker keeps every tool the static filter did not remove',
      )
    }
  }

  // ── 主路径：worker 一出现就收窄，赶在首次 prompt 组装之前 ──
  //
  // 载荷必须从 payload **对象**上取 `agent`：`agent/created` 传的是 payload 对象，
  // 不是 agent 本身。把第一个参数当 agent 读，会得到一个没有 session、没有 ctx 的
  // 对象，于是 `isDelegatedChild` 判 false、整段被静默跳过 —— 同生态插件里被明确
  // 记录过的坑（`coordinator-guard.mjs` 的注释专门警告过）。
  ctx.on('agent/created', (payload) => {
    try {
      // ⚠️ 解构**必须留在 try 内**（与 `subagent-mode.mjs` 同因）：写在参数位置时，
      // 「连载荷对象都没有」这一种输入会在进入 try 之前就抛 TypeError，
      // 绕过下面这个 catch —— 而本模块对外的承诺是「任何意外都不得影响会话创建」。
      // 取到 undefined 同样安全：`isDelegatedChild` 用可选链读 header，
      // 对 undefined / null 一律返回 false，整段随之静默跳过。
      narrow(payload?.agent)
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话创建。
      warn(`handling agent/created for the read-only narrowing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── 释放：agent 离开时必须卸掉限制 ──
  //
  // 限制层是按 scope key 存活的。scope key 被回收后复用到新 agent 上，会继承一条
  // 本该消失的过滤 —— 那就是「新会话莫名少了一堆工具」的成因。
  ctx.on('agent/disposed', (payload) => {
    try {
      release(payload?.agent)
    } catch (error) {
      warn(`releasing the read-only restriction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
