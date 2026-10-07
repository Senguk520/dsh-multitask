/**
 * multitask-subagent-mode — 按「委派行」给子代理换上不同的**呈现模式**。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 工具面的**种类与数量**会影响模型的推理表现：同一个 DSH + DeepSeek 组合，在
 * 「完整原生工具面」与「PTC 塌缩面」下各有擅长的任务类。所以协调者应当能按任务
 * 类型派遣不同工具面的 worker —— 程序化批量处理交给 PTC worker，只读调研交给
 * 收窄过的只读 worker，写代码/跑命令交给完整工具面的标准 worker。
 *
 * 本模块负责其中**只有它才能做**的那一半：**PTC 呈现**。
 *
 * 另一半（`subagent_minimal` 的只读工具子集）是**原生能力**，由 composition 里那一行
 * 的 `toolFilter.deny` 直接实现，与本模块无关 —— 别把这件事实现在这里。
 *
 * ── 为什么「工具子集」和「呈现模式」是两件不同的事 ──────────────────────────
 *
 * 容易混淆，所以写清楚：
 *
 *   - `toolFilter`（原生，配置在委派行上）—— **收窄可见的工具集合**。
 *     它只能做减法，且 `run_code` 是被保留的传输名，`restrict()` 明确拒绝它。
 *   - `presentAs('ptc')`（本模块）—— **改变工具面被呈现的方式**：整张工具面塌缩成
 *     「模型只能直呼 `run_code`，其余一切在程序里经生成的 SDK 调用」。
 *     这不是筛选，是换一套呈现；用 `toolFilter` 模拟不出来。
 *
 * 所以 `subagent_ptc` 那一行**刻意不配 `toolFilter`** —— 塌缩由本模块完成。
 *
 * ── 为什么必须读 `subagent/descriptor`，以及为什么只有 continuable 行能用 ────
 *
 * 本模块要回答的第一个问题是：「刚创建的这个子代理，是来自哪一条委派行？」
 *
 * `dsh-tool-subagent` 的 Config schema 里**没有**任何模式/组成字段（完整 schema 是
 * provider / toolName / modelSelectionSettings / enableRunInBackground /
 * backgroundMode / agentOptions / persona / toolFilter / maxDepth），也**没有**
 * 「这个子代理用了哪一行」的运行时句柄。所以只能靠一个由该行**注入到子代理自身**
 * 的标记来间接识别 —— 而 `persona` 正是唯一符合这个条件的现成载体：
 * 它是委派行上的配置，会被写进子代理自己的 system prompt，同时又被原样快照进
 * 子代理 session 的 `subagent/descriptor` 事件。
 *
 * ⚠️ **但那个快照只在 continuable 分支里才包含 persona。**
 * `dsh-subagent` 的 `snapshotSubagentDescriptor()` 对 `mode === 'one-shot'` 的行
 * 只保留 `version` / `mode` / `provider` / `label` 四个字段，persona 与 toolFilter
 * **都被丢掉**。也就是说：
 *
 *     模式标记能被子代理之外读到的前提 = 该委派行是 backgroundMode: 'continuable'
 *
 * 这不是本模块的偏好，是上游快照的字段集决定的。所以 composition 里两条新模式行
 * 都是 continuable。（已核实：descriptor 事件在子代理创建窗口内、`setup()` 阶段就
 * append 进 session，早于 `agent/created` —— 见 `dsh-subagent` 的
 * `activations.materialize()`：先 `setup`（append descriptor + applyChildComposition），
 * 再 `announce`（发出 `agent/created`）。）
 *
 * ── 为什么失败一律静默降级（本模块与 coordinator-guard 的取向相反）──────────
 *
 * `coordinator-guard` 装不上就**响亮告警**，因为装不上等于减震器失效、模式名存实亡。
 * 本模块的失败后果**小得多**：最坏情况是某个 PTC worker 退化成普通原生工具面 ——
 * 它仍然是一个能干活、能完整完成任务的子代理，只是少了程序化批量的便利。
 *
 * 反过来，如果这里抛错，代价是**整个子代理会话起不来**。两害相权，本模块选择：
 * 任何一步不确定就**不动作**，只留一条 warn（每种原因只报一次），绝不中断会话。
 *
 * ⚠️ 但「降级」不等于「看不见」：`warnOnce` 每种原因每进程只报一次，于是派 N 个 ptc
 * worker 而塌缩装不上时，日志里也只有 1 行 warn —— 外在表现是「日志看着正常，实际上
 * 这批 worker 全都拿着完整工具面、却被人格告知只能直呼 `run_code`」。所以每条失败路径
 * 都带固定标识 `PTC-COLLAPSE-SKIPPED reason=…`、成功路径带 `PTC-COLLAPSE-ENGAGED`，
 * 并且每次跳过另记一条带累计数的行（见 `noteCollapseSkipped()`）。**只加可见性，不改取向。**
 *
 * ── 绝不碰协调者 ─────────────────────────────────────────────────────────────
 *
 * ≥ 对协调者 scope 调 `presentAs('ptc')` 会把它的只读核对工具全部塌缩成「只能经
 *   SDK 到达」，**减震器的语义就被改写了**：协调者保留 `read`/`grep`/`glob` 的目的
 *   正是让它能独立核对子代理的结论，而不是盲信。
 *
 * 所以本模块用与 guard 相同的三信号判定（`origin` / `parentSession` /
 * `delegationDepth`）**先确证这是子代理**，否则直接返回。这是硬前置，不是优化。
 *
 * @module dsh-multitask/presets/multitask/subagent-mode
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-subagent-mode'

/**
 * 本模块**不**声明 `inject`。
 *
 * 它需要的东西都不是「服务」：`agent/created` 是 ctx 事件，`presentAs` 是从
 * `agent.ctx.tools` 上取的、`ptcRuntime` 是用 `ctx.get()` 探测的。
 *
 * 声明 `inject: ['tools']` 反而有害：那会让本模块在 tools 服务存在之前就挂住，
 * 也会把一个可选能力变成硬依赖 —— 而本模块的设计前提正是「能力缺失时安静退场」。
 */
export const inject = []

/**
 * persona 里的模式标记。
 *
 * ⚠️ 必须与 `composition.mjs` 导出的 `PTC_MODE_MARKER` **逐字一致**。
 * 两个文件各自留一份常量而不是互相 import，是为了保持本模块「零 import」的约定；
 * 代价是改一处必须改两处，`verify.mjs` 里有用例比对这两个字符串来挡住不同步。
 */
const PTC_MODE_MARKER = '[multitask-mode:ptc]'

/**
 * 「塌缩被跳过」的固定标识串。
 *
 * ⚠️ 这两个串是**给人拿去搜日志**的：逐字固定、ASCII、不要改写或本地化。
 *
 * 为什么非要有它：本模块的告警走 `warnOnceFactory`，**每进程每种原因只报一次**（防刷屏
 * 所必需）。但它顺手把「跳过次数」和「走的哪条路」也吞掉了 —— 派 10 个 ptc worker 时
 * 日志里也只有 1 行，无法判断「是否刚刚又跳过了 5 次」。固定标识把这件事变成可搜事实。
 *
 * 两个串共用 `PTC-COLLAPSE-` 前缀，所以一条 grep 就能同时看到「跳过的」与「生效的」，
 * warn / info 两条通道也都在这个前缀下。`reason=` 的值是 ASCII kebab-case 短名，
 * 三个失败分支各一个（见 `noteCollapseSkipped()` 的三处调用点）。
 */
const PTC_COLLAPSE_SKIPPED = 'PTC-COLLAPSE-SKIPPED'

/** 塌缩**成功**时的对应标识（与失败标识同前缀，便于对照「这个 worker 到底塌缩了没」）。 */
const PTC_COLLAPSE_ENGAGED = 'PTC-COLLAPSE-ENGAGED'

/** 一个每次进程只警告一次的记录器（与 coordinator-guard 同款，避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/subagent-mode: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 三个信号任一成立即视为子代理 —— 与 `coordinator-guard.mjs` 的 `isDelegatedChild`
 * 保持**同一条判据**（那里写明：判错的代价很高）。这里判错的方向更危险：
 * 把协调者误判成子代理，就会对它应用 PTC 塌缩，直接改写减震器语义。
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
 * 取该子代理 session 里能看到的事件数组。
 *
 * 两个来源都试：`ownEvents()`（本 session 自有的事件，不含 fork 继承的前缀）优先，
 * 再退到 `snapshotEvents()`（全量）。二者都是同步读，因而能在 `agent/created`
 * 这个非异步窗口里使用 —— 这也是本模块必须同步判定的原因：
 * 呈现一旦错过首次 prompt 组装，第一次请求就已经发出去、塌缩不了。
 *
 * 注：这两个方法在上游被标记为 deprecated（推荐异步 `sessionQuery`），但那套 API 是
 * 异步的、且在瘦身部署里可能不存在；本模块要的是「创建窗口内的同步读」，
 * 所以这里用它们并用 try/catch 包住 —— 取不到就当作「没有标记」而不是抛错。
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
 * descriptor 是**唯一**能读到「这一行用了哪份 persona」的地方：它不是子代理的
 * system prompt（那要等组装，且可能已被 scope 层叠改写），而是委派行原样的快照。
 * `dsh-subagent` 自己对 descriptor 的定性就是「first event is authoritative」。
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
 * 判定该子代理应当使用哪种呈现模式。
 *
 * 目前只有一种非原生模式（ptc），但判定写成「返回模式名」而不是「是不是 ptc 的布尔」，
 * 是为了以后要加 `both` 或别的模式时不必改调用点的形状。
 *
 * 找不到标记 = 返回 undefined = 什么都不做。这样做的直接后果是：`subagent` /
 * `subagent_fork` 这两条**原有**委派路径的 persona 里没有本模块认识的标记，
 * 于是它们完全不受影响 —— 这是「不破坏现有单模式行为」的实现方式，而不是靠额外判断。
 *
 * @param agent - 目标子代理。
 * @returns `'ptc'`，或 undefined（表示保持原生）。
 */
function modeForChild(agent) {
  const persona = descriptorPersona(agent)
  if (typeof persona !== 'string') return undefined
  if (persona.includes(PTC_MODE_MARKER)) return 'ptc'
  return undefined
}

/**
 * 探测 PTC 运行时是否可用。
 *
 * ⚠️ 这一步**不能省**，而且省掉的后果很严重：
 * `presentAs('ptc')` 本身**不会**因为没有运行时而抛错 —— 它只是给该 scope 的 layer
 * 设上 `mode`，并注册两段 systemPrompt section。真正报错发生在那两段 section 被
 * **渲染**的时候：`dsh-tools` 的 `requirePtcRuntime()` 会抛
 * `mode "ptc" requires a PTC runtime — load a ctx.ptcRuntime implementation …`。
 *
 * 也就是说：在缺少运行时的部署里贸然 `presentAs('ptc')`，会让该子代理的**首次
 * prompt 组装直接失败** —— 一个本来能正常干活的 worker 被本模块弄坏了。
 * 所以可用性必须在**调用 presentAs 之前**确认，而不是等它抛错。
 *
 * @param ctx - 插件上下文（与 dsh-liangshen 的 tool-catalog 同款探测写法）。
 * @returns 运行时存在时为 true。
 */
function ptcRuntimeReady(ctx) {
  try {
    return ctx.get('ptcRuntime') !== undefined && ctx.get('ptcRuntime') !== null
  } catch {
    return false
  }
}

/**
 * 装载本模块：给带 PTC 标记的子代理 scope 声明 PTC 呈现。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行在 composition 里的 `config`（`{ enabled }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)

  /**
   * 已经成功声明过的 agent；`presentAs` 一个 scope 只能调一次
   * （再调会抛 `one composition selects one presentation`），所以必须去重。
   * 用 WeakSet 而不是 Set：agent 被回收后不该由本模块持有强引用。
   */
  const declared = new WeakSet()
  /** 已经失败过的 agent：同一原因只报一次，也不重试（重试同样会失败）。 */
  const refused = new WeakSet()

  /**
   * 按原因累计「塌缩被跳过」的次数。
   *
   * `warnOnce` 挡住了刷屏，但它顺手把「刚刚又跳过了几次」也吞掉了：派 N 个 ptc worker，
   * 日志里仍只有 1 行 warn。这里补的正是那一半 —— **warn 仍然每因只报一次**（不刷屏的
   * 承诺不变），额外让一条 info 随 count 递增，于是「跳过了几次」成为可 grep 的事实。
   *
   * 次数上界 = 委派出的 PTC worker 数：`declared` / `refused` 两个 WeakSet 保证同一个
   * agent 只记一次，且本函数只在 `agent/created` 上触发（每子代理一次，不是热点路径），
   * 所以这里的「每次都记」不会退化成刷屏。
   */
  const skipCounts = new Map()

  /**
   * 记一次「塌缩被跳过」，两条日志都带固定标识。
   *
   * 为什么这样拆：给人看的信息有两种 —— 「为什么跳过」（一次性、要完整，所以走 warnOnce）
   * 与「跳过了几次、刚才是第几次」（要能累计，所以走 info）。两者共用一个固定前缀，
   * 一条 grep 就能同时捞到。
   *
   * @param reason - 失败分支短名（ASCII kebab-case，见三个调用点）。
   * @param message - **原告警文本**，逐字保留；标识只追加在末尾，不重写措辞。
   */
  const noteCollapseSkipped = (reason, message) => {
    const count = (skipCounts.get(reason) ?? 0) + 1
    skipCounts.set(reason, count)
    // 追加而非替换：既有用例断言的是原文本里的片段（如 no "ptcRuntime" service）。
    warn(`${message} [${PTC_COLLAPSE_SKIPPED} reason=${reason}]`)
    try {
      // 计数只走 info：用 warn 会让 warnOnce 的去重失效、变成每个 worker 一行。
      // 注：`ctx.logger` 在本模块里确认可用的通道就是 `info` / `warn`（见成功路径与
      // warnOnceFactory），没有更低级别的通道可选。
      ctx.logger?.info?.(
        `dsh-multitask: ${PTC_COLLAPSE_SKIPPED} reason=${reason} count=${count} — the worker keeps the native tool surface`,
      )
    } catch {
      // 与 warnOnceFactory 同理：日志通道不可用不能反过来炸掉会话。
    }
  }

  const declarePresentation = (agent) => {
    if (declared.has(agent) || refused.has(agent)) return

    // ── 硬前置：绝不作用于协调者 ──
    if (!isDelegatedChild(agent)) return

    const mode = modeForChild(agent)
    // 没有标记 = 这条委派行没要求非原生呈现（`subagent` / `subagent_fork` 就在这一类）。
    if (mode === undefined) return

    if (!ptcRuntimeReady(ctx)) {
      refused.add(agent)
      noteCollapseSkipped(
        'no-runtime',
        `a subagent was configured for "${mode}" presentation, but this deployment has no "ptcRuntime" service, ` +
          `so the presentation was NOT declared and that worker keeps the native tool surface. ` +
          `Load a PTC runtime plugin (the ctx.ptcRuntime service provider) to enable it.`,
      )
      return
    }

    const tools = agent?.ctx?.tools
    if (tools === undefined || tools === null || typeof tools.presentAs !== 'function') {
      refused.add(agent)
      noteCollapseSkipped(
        'no-present-as',
        `the subagent scope exposes no tools.presentAs(); the "${mode}" presentation was not declared and ` +
          `that worker keeps the native tool surface`,
      )
      return
    }

    try {
      const disposer = tools.presentAs(mode)
      declared.add(agent)
      // 不主动 dispose：该 effect 由子代理自己的 scope 拥有，会随它一起回收。
      // 这里只确认拿到的是不是函数，拿不到也照常继续（呈现已经生效）。
      if (typeof disposer !== 'function') {
        warn(`tools.presentAs("${mode}") returned no disposer for a subagent scope; the declaration may outlive its agent`)
      }
      // 成功标识追加在原有文本末尾：级别（info）与措辞都不动，只让「塌缩真的生效了」
      // 变得可 grep —— 否则只能靠「没有失败标识」反推，那对「整段都没跑到」不成立。
      ctx.logger?.info?.(
        `dsh-multitask: subagent scope presented as "${mode}" — its tool surface is collapsed to run_code + the generated SDK [${PTC_COLLAPSE_ENGAGED}]`,
      )
    } catch (error) {
      // 走到这里通常是「该 scope 已经声明过别的呈现」，或 scope 尚未就绪。
      // 无论哪种都不该让子代理起不来，所以只记一笔就走。
      refused.add(agent)
      noteCollapseSkipped(
        'present-as-threw',
        `declaring the "${mode}" presentation for a subagent was declined: ` +
          `${error instanceof Error ? error.message : String(error)} — that worker keeps the native tool surface`,
      )
    }
  }

  // ── 主路径（也是本模块唯一的路径）──
  //
  // 时机理由与 coordinator-guard 完全相同：`SystemPrompt.assemble()` 先收集工具提供方
  // 再跑瀑布，所以在瀑布内部改呈现改变不了它服务的那次请求。`agent/created` 是
  // 「首次 prompt 组装之前」的安全窗口，而且 descriptor 事件此时已经写进 session
  // （见文件头对 setup → announce 顺序的说明），标记因而一定读得到。
  //
  // 载荷必须从 payload **对象**上取 `agent` 字段：`agent/created` 传的是 payload 对象，
  // 不是 agent 本身。把第一个参数当 agent 读，会得到一个没有 session、没有 ctx 的对象，
  // 于是 `isDelegatedChild` 判 false、整段被静默跳过 —— 同生态插件里被明确记录过的坑。
  ctx.on('agent/created', (payload) => {
    try {
      // ⚠️ 载荷解构**必须留在 try 内**。解构发生在 handler 函数体执行之前，所以写在
      // 参数位置（`({ agent }) => …`）时，「连载荷对象都没有」这一种输入会在进入 try
      // 之前就抛 TypeError，从而绕过下面这个 catch —— 而本模块对外的承诺恰恰是
      // 「任何意外都不得影响会话创建」，那样一处结构性缺口就把承诺作废了。
      // 宿主（dsh-agent-loop / dsh-subagent）恒以 `{ agent }` 形状发事件，所以这条
      // 路径实际上不可达；但让承诺在结构上成立，比依赖「宿主不会那样调用」更可靠。
      // 取到 undefined 同样安全：`isDelegatedChild` 用可选链读 header，对
      // undefined / null 一律返回 false，整段随之静默跳过（下面的用例锁住了这点）。
      declarePresentation(payload?.agent)
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话创建。
      warn(`handling agent/created for the presentation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
