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
 * 承载「本行 persona」的 system prompt 段落名。
 *
 * 逐字为 `dsh-subagent` 的 `applyChildComposition()` 注册它时用的名字
 * （上游常量 `PERSONA_PREFIX_SECTION` 的值）。名字漂了不会报错，只会**读不到** ——
 * 于是退化成「找不到标记 = 什么都不做」这种最难查的坏法。
 */
const PERSONA_SECTION_NAME = 'deployment:persona-prefix'

/**
 * 从子代理**自己的 system prompt 段落**里取该行配置的 persona（**主来源**）。
 *
 * 为什么它是主来源：这是**两条委派路径都有**的那一份。`applyChildComposition()`
 * 在 `setup()` 阶段注册该段落，而 `setup()` 严格早于 `agent/created`
 * （上游 `initializeAgent` 先 `await setup()`、再 `await publish()`）——
 * 与 `coordinator-guard` 依赖的时序是同一条。
 *
 * 对比 `descriptorPersona()`：那个只在 `backgroundMode: 'continuable'` 行上有效，
 * 所以**不能**单独用它。只用它会让「只读收窄」在**前台派单**时整体失效 ——
 * 而前台派单恰好是审批弹窗唯一走得通的路径，于是外在表现会变成
 * 「前台派单测出来一切正常、默认后台派单时反而没问题，唯独前台那批 worker
 * 仍然握着 `ssh_exec`」这种极难归因的坏法。
 *
 * ⚠️ 读法用的是上游**未文档化**的内部结构（`SystemPrompt` 的公开声明只列了注册方法、
 * 顺序查询与 `assemble()`；`layers` / `merge()` 都不在其中）。所以这里的原则是：
 *
 *   - 全程不抛错，任何一步读不到都返回 undefined，由调用方退到兜底来源；
 *   - **结构性缺失**（连 `layers.merge` 都不在）记一条带**固定标识**的 warn ——
 *     那说明上游改了内部结构，本模块对前台派单会开始静默失效，这件事必须可 grep；
 *   - 段落**不存在**不告警：那是「该行本来就没配 persona」，属于正常情形。
 *
 * 不走公开的 `assemble()`：它是 `async`，而且每次会 `structuredClone` 全部工具 schema
 * （本部署 40+ 个），为读一段文本付这个代价不合适。
 *
 * @param agent - 目标子代理。
 * @param warn - 每进程每原因只报一次的记录器。
 * @returns persona 文本，或 undefined。
 */
function promptSectionPersona(agent, warn) {
  const service = (() => {
    try {
      const direct = agent?.ctx?.systemPrompt
      if (direct !== undefined && direct !== null) return direct
      return agent?.ctx?.get?.('systemPrompt')
    } catch {
      return undefined
    }
  })()

  const layers = service?.layers
  if (layers === undefined || layers === null || typeof layers.merge !== 'function') {
    warn(
      "this deployment's systemPrompt service exposes no readable section layers, so a subagent's own " +
        'persona section cannot be read; the mode marker falls back to the subagent descriptor, which omits ' +
        'persona for foreground (one-shot) delegations — those workers are NOT narrowed ' +
        '[MULTITASK-MODE-MARKER-SOURCE-MISSING reason=no-section-layers]',
    )
    return undefined
  }

  try {
    // scope 键就是 agent 对象本身：上游 `assembleContextFor()` 传的是 `{ scope: agent }`，
    // 而 `createScope(loopCtx, this)` 用的键也是这个 agent。
    // 子代理自己的层在链条最内侧，因此它盖掉全局那份部署级 persona。
    const sections = layers.merge(agent, (layer) => layer.sections)
    const section = sections?.get?.(PERSONA_SECTION_NAME)
    const text = section?.text
    // `text` 可以是函数（按组装上下文求值）；本行配置的 persona 是纯字符串，
    // 遇到函数形态说明读到的不是委派行那一份，按「读不到」处理。
    return typeof text === 'string' && text !== '' ? text : undefined
  } catch (error) {
    warn(
      `reading a subagent's own persona section failed: ${error instanceof Error ? error.message : String(error)} — ` +
        'the mode marker falls back to the subagent descriptor, which omits persona for foreground ' +
        '(one-shot) delegations [MULTITASK-MODE-MARKER-SOURCE-MISSING reason=merge-threw]',
    )
    return undefined
  }
}

/**
 * 从子代理的 `subagent/descriptor` 事件里取该行配置的 persona（**兜底来源**）。
 *
 * descriptor 是「委派行原样的快照」，上游自己的定性是
 * 「first event is authoritative」，所以它是很干净的一份 —— 但**覆盖面有限**：
 *
 *   `snapshotSubagentDescriptor()` 对 `mode === 'one-shot'` 的行只保留
 *   `version` / `mode` / `provider` / `label`，persona 与 toolFilter **都被丢掉**；
 *   而且 one-shot 的 descriptor 要到**第一轮 `agent/pre-step`** 才 append
 *   （`attachDescriptorAppend`），在 `agent/created` 那一刻**根本还不存在**。
 *
 * 所以它只对 `continuable` 行有效。本机实测（全部 340 个会话、298 条 descriptor）：
 * one-shot 的 76 条**无一带 persona**，continuable 的 222 条里 219 条带 ——
 * 分界线与上面那段字段集完全一致。
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
 * 取该子代理所属委派行的 persona —— 主来源优先，descriptor 兜底。
 *
 * 两个来源都取自同一个 `request.persona`，内容一致；顺序之所以这样定，是因为
 * 主来源在**两条派单路径上都存在**，而兜底只在后台那条上存在。
 *
 * @param agent - 目标子代理。
 * @param warn - 每进程每原因只报一次的记录器。
 * @returns persona 文本，或 undefined。
 */
function childPersona(agent, warn) {
  const fromPrompt = promptSectionPersona(agent, warn)
  if (typeof fromPrompt === 'string') return fromPrompt
  return descriptorPersona(agent)
}

/**
 * 判定该子代理是不是 minimal（只读）worker。
 *
 * 找不到标记 = 不是本模块的对象。这样做的直接后果是：`subagent` / `subagent_fork` /
 * `subagent_ptc` 三条**别的**委派路径完全不受影响 —— 这是「不破坏现有模式」的实现
 * 方式，而不是靠额外判断。
 *
 * ⚠️ 判「不是」与「读不到 persona」在本模块里**不可区分**，而两者的后果不同：
 * 前者是「这条行按设计不用收窄」，后者是「本该收窄却没读出来」。这个方向是**安全**的
 * （不收窄 ≠ 放宽权限：静态 `toolFilter` 仍在，本模块只是没能补上第二层），
 * 但它意味着「读不到」必须**可观测** —— 所以两个来源的读取路径都带固定标识告警，
 * 而不是静默返回 undefined。
 *
 * @param agent - 目标子代理。
 * @param warn - 每进程每原因只报一次的记录器。
 * @returns 命中 minimal 标记时为 true。
 */
function isMinimalChild(agent, warn) {
  const persona = childPersona(agent, warn)
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
 * 既**不可收窄**、又**必须**放行的 harness 内部传输名。
 *
 * 它们由上游（不是本 composition）注册在子代理自己的 scope 上，且都不是「工具」
 * 而是运行时通路：
 *
 *   - `run_code` —— PTC 呈现的保留传输名，`restrict()` 明确拒绝它；
 *   - `structured_output` —— `dsh-subagent` 在配了 `outputSchema` 的委派里注册的
 *     结构化返回通路（`dsh-subagent-in-process-driver` 的 `childCtx.tools.register`）。
 *
 * 把它们从目录里滤掉会让「结构化返回」这类能力失效，而它们本来就只服务于本次委派、
 * 与「只读」不冲突。
 */
const CATALOG_EXEMPT = ['run_code', 'structured_output']

/**
 * 把**不在允许集里**的工具从组装结果的目录数组里滤掉（目录级过滤）。
 *
 * ── 为什么需要它：`restrict()` 有一条**结构上**够不到的地带 ────────────────
 *
 * `tools.restrict()` 只认**继承面**的名字：`dsh-tools` 的 `view()` 里，
 * `inherited` 才进 `restrictableNames`，而**注册在该 agent 自己 scope 上**的名字
 * 只进 `visible`、**不进** `restrictableNames` —— 写进 deny 会直接抛
 * `names unknown global tool`。
 *
 * 于是凡是「按 agent 单独安装」的工具，本模块的差分逻辑**永远摘不掉**。
 *
 * ⚠️ **这里记一段历史，因为它是本层存在的直接来由，而它的触发条件已经消失：**
 * 当初实测到的正是这一类 —— `subagent` / `subagent_ptc` / `subagent_minimal` 三行设了
 * `modelSelectionSettings: true`，那个开关会让 `dsh-tool-subagent` 不再全局注册工具、
 * 而是为每个 agent 单独 `installScoped`（注册到该 agent 自己的 ctx），于是它们进了
 * minimal worker 的目录却不可收窄。证据吻合：**没设**那个开关的 `subagent_fork`
 * 被成功摘掉了。实测（`H:\test4` / `H:\test5`，读请求头 `tools` 数组，非 worker 自述）：
 * minimal worker 的目录恰好是「允许集 10 项 + 这三个」= 13 项。
 *
 * **那个开关现在已从四行全部移除**（「AI 临时指派模型」那条能力与本包「模型由用户
 * 在面板里按 worker 类型决定」相冲突），于是四条委派工具回到全局注册、**由
 * `restrict()` 正常摘掉**。
 *
 * ⚠️ **但这一层不能因此删掉**：它的存在理由是**结构性**的 —— `restrict()` 只认继承面，
 * 任何第三方插件只要按 agent 单独安装工具，就又会落进这条够不到的地带。
 * 真实案例消失之后，`test/minimal-guard-catalog.mjs` 用**合成的**外来工具名继续守它
 * （见那里的 `PER_AGENT_LEAK`）。
 *
 * ── 为什么在组装瀑布上做，以及为什么它**不是**安全边界 ──────────────────────
 *
 * `assembly.tools` 正是喂给请求的那一份（`dsh-agent-loop` 的
 * `buildRequest(config, preparedCall, assembly.tools, …)`），也是模型唯一能看到
 * 工具目录的地方；`approval-gate.mjs` 早就用同一个瀑布改 `assembly.contexts`，
 * 这里是同一手法的第二个用例。
 *
 * ⚠️ **它只改「模型看到什么」，不改「能不能调」。** 真正的执行拦截仍然是
 * `maxDepth`（minimal worker 的深度是 1，再往下派会撞
 * `Error: subagent depth 2 exceeds maxDepth 1`）与静态 `toolFilter`。
 * 把这个过滤当成安全边界是错的 —— 它修的是**一致性**：人格里逐字写着
 * "Do not delegate further; you cannot, and you should not try"，
 * 而模型抬头就能看见三个委派工具。
 *
 * 纯函数、不改入参：瀑布的返回值就是权威结果。
 *
 * @param assembly - 本次组装结果。
 * @param allowed - 允许集（已并入 `CATALOG_EXEMPT`）。
 * @param hidden - 可选：把被滤掉的名字记进这个集合（调用方用于记账/日志）。
 * @returns 滤过的新组装结果；没有可滤项时**原样返回**（避免无谓分配）。
 */
function withoutUnlistedTools(assembly, allowed, hidden) {
  const tools = assembly?.tools
  if (!Array.isArray(tools)) return assembly
  const kept = tools.filter((tool) => {
    if (allowed.has(tool?.name)) return true
    hidden?.add(tool?.name)
    return false
  })
  if (kept.length === tools.length) return assembly
  return { ...assembly, tools: kept }
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
  /**
   * 每个 agent 的在线清理动作：agent -> dispose 数组。
   *
   * ⚠️ 必须是**数组**而不是单个 disposer：同一个 worker 上现在有两个独立的动作
   * （`restrict()` 的 restriction 层 + 目录级过滤），两者各有自己的 disposer。
   * 用单值会让后写的那次**静默覆盖**前一次 —— 表现是 `agent/disposed` 之后仍有一条
   * 限制留在 scope 上，而 scope key 被复用时新 agent 会继承一条本该消失的过滤
   * （README「释放」一节记的正是这个坑）。
   */
  const live = new WeakMap()

  /** 追加一个清理动作（若已有则并入，绝不相撞）。 */
  const addCleanup = (agent, dispose) => {
    if (typeof dispose !== 'function') return
    const previous = live.get(agent)
    if (previous === undefined) {
      live.set(agent, [dispose])
      return
    }
    previous.push(dispose)
  }

  /** 卸掉一个 worker 的全部现行限制。 */
  const release = (agent) => {
    const disposers = live.get(agent)
    if (disposers === undefined) return
    live.delete(agent)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        warn(`lifting an earlier read-only restriction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * 给一个 minimal worker 挂上**目录级过滤**（只改模型看到什么）。
   *
   * 为什么它与 `restrict()` 是两件事、且必须并存：`restrict()` 走的是 restriction 层，
   * 只认**继承面**的名字；而**按 agent 单独安装**的工具注册在该 agent 自己的 scope 上，
   * **结构上**不可 restrict（写进 deny 会抛 `unknown global tool`）。
   * 目录过滤补的正是这一块 —— 详见 `withoutUnlistedTools()` 的注释（那里记了它当初
   * 是被哪个真实案例逼出来的，以及为什么那个案例消失后这层仍需保留）。
   *
   * 注册在**子代理自己的 ctx** 上，所以只影响这个 worker 的组装，兄弟与父会话看不到。
   * 拿到的 disposer 交给 `addCleanup`，`agent/disposed` 时一并卸掉
   * （与 restriction 的释放走同一条路，避免两套生命周期各自漂移）。
   *
   * ⚠️ 失败方向：拿不到 event registry 就**只告警、不抛错**。本模块对外的承诺是
   * 「任何意外都不得影响会话创建」，而这一层修的是**一致性**（人格与目录对上），
   * 不是安全边界 —— 真正的拦截仍是 `maxDepth` 与静态 `toolFilter`。
   *
   * 第一次真的滤掉东西时记一条 info（每个 worker 一次），列出被滤掉的名字。
   * 这条日志是**过度过滤的出口**：允许集是白名单，若哪天它误伤了某个 harness
   * 内部工具，日志里会直接写着那个名字，而不是表现成「那个 worker 莫名其妙少了个能力」。
   *
   * @param agent - 目标 minimal worker。
   * @param allowed - 允许集。
   * @returns 是否成功挂上（供调用方决定要不要记「已收窄」）。
   */
  const engageCatalogFilter = (agent, allowed) => {
    const childCtx = agent?.ctx
    if (typeof childCtx?.on !== 'function') {
      warn(
        'a read-only worker scope exposes no event registry, so its tool CATALOG could not be filtered; ' +
          'any tool installed per-agent by another plugin stays visible to that worker, though calling one ' +
          'may still be refused by maxDepth',
      )
      return false
    }
    /** 被目录过滤摘掉的名字（只为「首次记账」服务，之后不再累积）。 */
    const hidden = new Set()
    /** 是否已经记过一次账（组装是每条请求都跑的路径，不能每次都记）。 */
    let reported = false

    try {
      const dispose = childCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
        // 后置过滤（先 next() 再改返回值）：与 approval-gate 改 contexts 的位置一致，
        // 是上游 invariant 插件确立的既定后置点。
        const assembled = await next()
        const filtered = withoutUnlistedTools(assembled, allowed, reported ? undefined : hidden)
        // 记账**只在第一次**真的滤掉东西时做一次：组装是每条请求都跑的路径，
        // 每次都记会刷屏，而这里要的只是「这个 worker 的面被改过、改了哪几个」这个事实。
        // （用 `reported` 而不是「清空 hidden」：后者会让下次组装重新累积并再次记一行。）
        if (!reported && filtered !== assembled && hidden.size > 0) {
          reported = true
          const names = [...hidden].sort()
          hidden.clear()
          ctx.logger?.info?.(
            `dsh-multitask: read-only worker catalog filtered — hid ${names.length} tool(s) that ` +
              `tools.restrict() structurally cannot remove: ${names.join(', ')}`,
          )
        }
        return filtered
      })
      // `addCleanup` 自己对「不是函数」有防护，所以不需要先判断再存。
      addCleanup(agent, dispose)
      if (typeof dispose !== 'function') {
        warn('the event registry did not return a disposer for the catalog filter; it may outlive its agent')
      }
      return true
    } catch (error) {
      warn(
        `engaging the read-only CATALOG filter failed: ${error instanceof Error ? error.message : String(error)} — ` +
          'that worker keeps the un-restrictable tools visible in its catalog',
      )
      return false
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
    if (!isMinimalChild(agent, warn)) return

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
    /** 「允许集」= 保留名单 + harness 内部传输名。目录过滤与 `deny` 都由它推导。 */
    const allowed = new Set([...keep, ...CATALOG_EXEMPT])
    const deny = []
    const seen = new Set()
    for (const toolName of visible) {
      if (seen.has(toolName)) continue
      seen.add(toolName)
      // `run_code` / `structured_output`：harness 内部传输名，出现在 allow/deny 里
      // `restrict()` 一律抛错，且滤掉它们会让结构化返回这类能力失效。
      if (CATALOG_EXEMPT.includes(toolName)) continue
      // 不在 restrictableNames 里的名字（按 agent 单独安装的那些）**不能**被 restrict
      // —— 写进 deny 会抛 `names unknown global tool`。它们只能靠下面的目录级过滤处理。
      if (restrictable !== undefined && !restrictable.has(toolName)) continue
      if (keep.has(toolName)) continue
      deny.push(toolName)
    }

    // ── 目录级过滤：补上 `restrict()` **结构上**够不到的那一类 ────────────────
    // 见 `withoutUnlistedTools()` 的注释：按 agent 单独安装的工具不在
    // `restrictableNames` 里，deny 永远摘不掉它们（实测的三个委派工具就是这一类）。
    // ⚠️ 必须在下面 `deny.length === 0` 的早退**之前**装 —— 否则「目录里刚好只剩
    // 这一类」时会被整个跳过，而那正是本轮实测命中的情形。
    const catalogEngaged = engageCatalogFilter(agent, allowed)

    // 差集为空时**不要**调 `restrict()`：`allow`/`deny` 全空会抛
    // `tools.restrict({}) is a no-op`。走到这里说明该 worker 的可见面本来就已经
    // 只剩允许集了 —— 那正是我们想要的状态，继承面上无事可做。
    if (deny.length === 0) {
      if (catalogEngaged) {
        narrowed.add(agent)
        ctx.logger?.info?.(
          'dsh-multitask: read-only worker catalog filtered — nothing to withhold on the inherited surface',
        )
      }
      return
    }

    try {
      const dispose = tools.restrict({ deny })
      narrowed.add(agent)
      // 用 `addCleanup`（数组追加）而不是 `live.set`（整体覆盖）：这个 worker 上
      // 还挂着上面那次目录过滤的 disposer，覆盖会让它永远不执行。
      addCleanup(agent, dispose)
      if (typeof dispose !== 'function') {
        warn('the tool registry did not return a disposer for the read-only restriction; it may outlive its agent')
      }
      ctx.logger?.info?.(
        `dsh-multitask: read-only worker scope engaged — withheld ${deny.length} tool(s): ${[...deny].sort().join(', ')}` +
          `${catalogEngaged ? ' (plus a catalog-level filter for tools that cannot be restricted)' : ''}`,
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
