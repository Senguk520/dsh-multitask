/**
 * multitask-worker-guard — 把「调了必被拒」的委派工具从 worker 的工具面里摘掉。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 本模式的委派深度是**固定 1**（`subagent` 的 `maxDepth`）。worker 再往下派一律被拒，
 * 拒绝文本逐字是：
 *
 *     Error: subagent depth 2 exceeds maxDepth 1
 *
 * 但拒绝发生在**调用之后**。在那之前，这 5 个委派工具的完整 schema 一直挂在 worker
 * 的目录里，跟着**每一次请求**重发。实测（本机 726 个 worker 会话，读 `request/header`
 * 的 `tools` 数组，非 worker 自述）：
 *
 *   - **575 个（79.2%）** 的 worker 目录里挂着 `subagent*`；
 *   - 这 5 个工具合计 **6,266 字符**，占全工具面 worker 底噪（52,445 字符）的 **11.9%**；
 *   - 同时实测到 **184 次** `depth 2 exceeds maxDepth 1` 的拒绝 —— 证明它们确实不可用。
 *
 * 也就是说这是一块**纯浪费**：付了 schema 的钱，换来一个必然失败的调用。摘掉它
 * 不损失任何能力，这是本模块与 `minimal-guard.mjs` 最重要的区别。
 *
 * ── 为什么不照抄 minimal 的白名单 ─────────────────────────────────────────────
 *
 * `minimal-guard.mjs` 用的是**白名单**（`DEFAULT_MINIMAL_KEEP`），因为它的目标是
 * 「保证只读」——漏列一个的代价是模式弱一点，多列一个的代价是安全承诺失效。
 *
 * 本模块的目标完全不同：**全工具面 worker 什么都能干**，任何白名单都会误伤。
 * 所以这里用**黑名单**，而且只列「调用必被拒」这一类。判据是：
 * **拿掉它会不会让 worker 少干成一件事？** 对委派工具，答案是不会 —— 它本来就干不成。
 *
 * ── 为什么黑名单在这里是安全的（与 `toolFilter` 被删的那个坑无关）──────────
 *
 * 上游删除 `toolFilter` 的教训是：写死的名字在**别的部署**里可能不存在，而
 * `restrict()` 对不存在的名字会**抛错**，且它是在委派窗口里被调用的 —— 抛出来表现为
 * 「委派功能坏了」，极难反查。
 *
 * 所以本模块**不直接下发这张黑名单**，而是先读该 scope 实际可见的工具名，再求交：
 *
 *     deny = 黑名单 ∩ 可见集
 *
 * 于是每个名字都必然合法，`restrict()` 不会抛错。没装委派工具的部署、或以后换了
 * 工具名的部署，本模块自动变成空操作，**不需要改这个文件**。
 *
 * ── 失败取向：静默降级（与 minimal-guard 相反）──────────────────────────────
 *
 * 本模块失败最坏的后果是「那块 schema 继续重发」—— 浪费一点 token，功能一件不少。
 * 这与 `minimal-guard.mjs`（失败 = 只读承诺没兑现）**方向相反**，所以告警取向也相反：
 * 这里**只记一次 info/warn，绝不喧哗**，更不影响会话创建。
 *
 * ── 为什么单开一行，而不是并入 minimal-guard ─────────────────────────────────
 *
 * 三条理由，任一条都足够：
 *   1. **失败后果相反**（见上）—— 合并会让两套告警契约含混；
 *   2. **作用对象不重叠**：minimal-guard 只管 `multitask_minimal`，本模块只管另外三种；
 *   3. **策略方向相反**：一个是白名单（保证只读），一个是黑名单（只摘必然失败的）。
 *
 * ── 它不改变什么（别把它当成比实际更强的东西）────────────────────────────────
 *
 *   - **不是安全边界。** 真正的拦截仍然是 `maxDepth`。本模块只省 token，
 *     不新增任何限制：即使它装不上，调用也照样会被拒。
 *   - **不碰协调者、不碰 minimal worker。** 协调者的工具面由 `coordinator-guard.mjs`
 *     负责；minimal 由 `minimal-guard.mjs` 负责（它的白名单里本来就没有委派工具）。
 *   - **它确实作用于 PTC，而且省得最多 —— 这一条曾经写反过。**
 *
 * ── 修正记录：PTC 那一节我判断错了（同日实测推翻）────────────────────────────
 *
 * 本文件初版断言「它不解决 PTC」，理由是 `request/header` 的 `tools` 数组只有
 * `run_code`（2,126 字符），委派工具只出现在 49,551 字符的
 * `## Writing code for run_code` 一节里，而那一节「是否随可见集收缩尚未验证」。
 *
 * **假设错在「尚未验证」这四个字被当成了「大概是不会」。** 实测把它推翻了：
 *
 *   今天 11:32:53 的 PTC worker（本模块尚未生效）：SDK 声明 **55** 个工具 → 61,081 字符
 *   今天 19:16:41 的 PTC worker（本模块已生效）：SDK 声明 **50** 个工具 → 54,778 字符
 *
 * 两侧唯一差异就是那 5 个委派工具（其余 roster 完全相同），差额 **6,303 字符**。
 * 也就是说 PTC 的 SDK 文档是 `sdkSchemas(scope)` 的纯函数，而 `sdkSchemas` 读
 * `view(scope).visible`；`restrict()` 把限制挂在该 agent 自己的 layer 上，
 * `chainLayers()` 会读它 —— 链路是通的，省下来的比例约等于工具数占比。
 *
 * 这反而是本模块**收益最大**的一条路径：PTC 的底噪（61,081 字符）比全工具面
 * worker（52,639）还贵，其中 6,303/61,081 ≈ **10.3%** 是这 5 个用不上的工具。
 *
 * ⚠️ 教训（比结论更重要）：**「读不出来」与「读出来是不变的」是两回事。**
 * 当初看到委派工具不在 `tools` 里，正确做法是去读 SDK 那一节里有没有它，
 * 而不是写一句「尚未验证」然后把结论往保守方向猜。保守猜测在这里恰好是错的。
 *
 * @module dsh-multitask/presets/multitask/worker-guard
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-worker-guard'

/** 工具注册表必须先存在，才能读可见面、装限制。 */
export const inject = ['tools']

/**
 * 「调用必然被拒」的工具名。
 *
 * 判据只有一个：**在深度固定为 1 的 worker 上，这个名字的每一次调用都会被宿主拒绝。**
 * 因此摘掉它不会让 worker 少干成任何事。
 *
 * ⚠️ 这里**不是**在描述「worker 不该做的事」。`interrupt_agent` / `send_message` /
 * `list_agents` 同样没什么用（worker 没有子代理），但它们不属于「必然被拒」——
 * 把它们写进来就超出了本模块的判据，会变成用一个猜测去换 token。不写。
 */
const UNUSABLE_IN_WORKERS = [
  'subagent',
  'subagent_fork',
  'subagent_ptc',
  'subagent_minimal',
  'subagent_preset',
]

/**
 * 本模块**不接管**的 provider 名 —— 与 `minimal-guard.mjs` 的 `MINIMAL_PROVIDER` 逐字一致。
 *
 * 那个 worker 的工具面由白名单负责，其允许集里本来就没有委派工具。再叠一层只是
 * 冗余，却会让「哪个模块改了这个 worker」在日志里变得难读。
 */
const MINIMAL_PROVIDER = 'multitask_minimal'

/** harness 内部传输名：出现在 allow/deny 里 `restrict()` 一律抛错。 */
const TRANSPORT_NAMES = ['run_code', 'structured_output']

/**
 * 「读不出事实」的独立取值，与「确实没有 provider 名」区分开。
 *
 * 两者的处置相同（都不动作），但只有前者值得记一笔 —— 后者是旧会话的正常形态。
 */
const PROVIDER_UNKNOWN = Symbol('dsh-multitask/unknown-provider')

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 判据与 `minimal-guard.mjs` / `coordinator-guard.mjs` **逐字同源**（三信号任一成立）。
 * 判错方向在这里代价很高：把协调者误判成 worker 就会在它身上摘工具。
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
 * `ownEvents()` 优先，退到 `snapshotEvents()`；二者都是同步读，因而能在
 * `agent/created` 这个非异步窗口里使用。取不到就当作「没有 descriptor」，不抛错。
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
 * 读该子代理委派行的 provider 名（`subagent/descriptor` 的 `data.provider`）。
 *
 * 只认第一条 descriptor —— 上游定性「first event is authoritative」。
 *
 * @param agent - 目标子代理。
 * @returns provider 名；读不到时返回 `PROVIDER_UNKNOWN`。
 */
function providerOf(agent) {
  for (const event of sessionEvents(agent)) {
    if (event?.type !== 'subagent/descriptor') continue
    const provider = event?.data?.provider
    if (typeof provider === 'string' && provider !== '') return provider
    return PROVIDER_UNKNOWN
  }
  return PROVIDER_UNKNOWN
}

/**
 * 读一个 agent scope 当前**可见**的工具名。
 *
 * 与 `minimal-guard.mjs` 的同名函数同款容错：先试 agent 自己的 scoped 视图，
 * 再退回全局注册表；`schemas` 与 `sdkSchemas` 都试。
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
        // 换下一个方法/来源。
      }
    }
  }
  return []
}

/**
 * 读该 scope 里**可以被 restrict 的**工具名集合。
 *
 * ⚠️ 这个名字集合与「可见集」不是一回事：`dsh-tools` 的 `view()` 只把**继承面**
 * 的名字放进 `restrictableNames`，而注册在该 agent **自己 scope** 上的名字只进
 * `visible` —— 写进 deny 会抛 `unknown global tool`。
 *
 * 读不到（该方法不存在或抛错）时返回 `undefined`，调用方据此**退回不看这个约束**
 * （而不是当作空集，那会把所有名字都判成不可 restrict，等于什么都不摘）。
 *
 * @param tools - agent 的 scoped tools 服务。
 * @param agent - 目标 agent。
 * @returns 可 restrict 的名字集合；读不到时为 `undefined`。
 */
function restrictableNameSet(tools, agent) {
  if (typeof tools?.view !== 'function') return undefined
  try {
    const view = tools.view(agent)
    const names = view?.restrictableNames
    if (names === undefined || names === null || typeof names[Symbol.iterator] !== 'function') return undefined
    return new Set(names)
  } catch {
    return undefined
  }
}

/**
 * 装载 worker 守卫：把「调用必被拒」的委派工具从 worker 的目录里摘掉。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行在 composition 里的 `config`（`{ enabled, extraDeny }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  /** 黑名单 = 内置那 5 个 + 配置追加的（后者给「以后发现别的必然失败的工具」留口）。 */
  const denyList = new Set(UNUSABLE_IN_WORKERS)
  for (const entry of config?.extraDeny ?? []) {
    if (typeof entry === 'string' && entry !== '') denyList.add(entry)
  }

  /** 每种失败原因只报一次，避免刷屏。 */
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger?.warn?.(`dsh-multitask: ${message}`)
  }

  /** 已经处理过的 agent（幂等）。WeakSet：不持有强引用。 */
  const handled = new WeakSet()
  /** agent -> disposer 数组（同一 worker 上可能有两个独立动作）。 */
  const live = new WeakMap()

  const addCleanup = (agent, dispose) => {
    if (typeof dispose !== 'function') return
    const previous = live.get(agent)
    if (previous === undefined) {
      live.set(agent, [dispose])
      return
    }
    previous.push(dispose)
  }

  const release = (agent) => {
    const disposers = live.get(agent)
    if (disposers === undefined) return
    live.delete(agent)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸不掉不该影响 agent 回收 —— 这一层本来只省 token。
      }
    }
  }

  /**
   * 目录级过滤：把黑名单里的名字从**本次请求的工具目录**里滤掉。
   *
   * 为什么需要它，与 `minimal-guard.mjs` 同一个结构性理由：`restrict()` 只认继承面，
   * 任何按 agent 单独安装的工具都够不到。这里多一层 Directory 过滤是**兜底**，
   * 而且它改的正是喂给请求的那一份 `assembly.tools`。
   *
   * @param agent - 目标 worker。
   * @returns 是否挂上。
   */
  const engageCatalogFilter = (agent) => {
    const childCtx = agent?.ctx
    if (typeof childCtx?.on !== 'function') return false
    try {
      const dispose = childCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const assembled = await next()
        const tools = assembled?.tools
        if (!Array.isArray(tools)) return assembled
        const kept = tools.filter((tool) => !denyList.has(tool?.name))
        if (kept.length === tools.length) return assembled
        return { ...assembled, tools: kept }
      })
      addCleanup(agent, dispose)
      return true
    } catch {
      return false
    }
  }

  /**
   * 处理一个可能为 worker 的 agent。
   *
   * @param agent - 目标 agent。
   */
  const narrow = (agent) => {
    if (agent === undefined || agent === null) return

    // 硬前置 1：只作用于被委派的子代理。
    if (!isDelegatedChild(agent)) return

    // 硬前置 2：不碰 minimal（它由白名单负责，那里本来就没有委派工具）。
    const provider = providerOf(agent)
    if (provider === MINIMAL_PROVIDER) return

    if (handled.has(agent)) return

    const tools = agent?.ctx?.tools
    if (tools === undefined || tools === null) {
      warnOnce(
        'no-tools-service',
        'a worker scope exposes no tools service, so the unusable delegation tools were left in its catalog. ' +
          'Nothing is lost functionally — every call to them is still refused by maxDepth. [WORKER-GUARD-SKIPPED reason=no-tools]',
      )
      return
    }

    const visible = visibleToolNames(ctx, agent)
    if (visible.length === 0) {
      warnOnce(
        'no-visible-surface',
        'no tool schemas were readable for a worker scope, so the unusable delegation tools were left in ' +
          'its catalog. Nothing is lost functionally. [WORKER-GUARD-SKIPPED reason=no-visible-surface]',
      )
      return
    }

    // ── 关键：deny = 黑名单 ∩ 可见集 ──
    // 只摘「确实在他面前」的那几个，所以名单里永远不会出现当前部署不存在的名字，
    // `restrict()` 也就不会抛错（那正是上游删除 `toolFilter` 时踩的坑）。
    const restrictable = restrictableNameSet(tools, agent)
    const deny = []
    const seen = new Set()
    const hiddenByCatalogOnly = []
    for (const toolName of visible) {
      if (seen.has(toolName)) continue
      seen.add(toolName)
      if (!denyList.has(toolName)) continue
      if (TRANSPORT_NAMES.includes(toolName)) continue
      if (restrictable !== undefined && !restrictable.has(toolName)) {
        hiddenByCatalogOnly.push(toolName)
        continue
      }
      deny.push(toolName)
    }

    // 目录级过滤必须**先**装：restrict() 够不到的那一类只能靠它。
    const catalogEngaged = engageCatalogFilter(agent)

    if (deny.length === 0 && !catalogEngaged) {
      // 这个 worker 本来就没有委派工具（例如未来改了工具名），或两层都没装上。
      handled.add(agent)
      return
    }

    let withheld = 0
    if (deny.length > 0 && typeof tools.restrict === 'function') {
      try {
        const dispose = tools.restrict({ deny })
        addCleanup(agent, dispose)
        withheld = deny.length
      } catch (error) {
        warnOnce(
          'restrict-threw',
          `withholding the unusable delegation tools failed: ${error instanceof Error ? error.message : String(error)} — ` +
            'the worker keeps those schemas visible, and every call to them is still refused by maxDepth. ' +
            '[WORKER-GUARD-SKIPPED reason=restrict-threw]',
        )
      }
    }
    handled.add(agent)
    if (withheld > 0 || catalogEngaged) {
      ctx.logger?.info?.(
        `dsh-multitask: worker delegation tools withheld — ${withheld} via restrict()${catalogEngaged ? ' + catalog filter' : ''}: ${[...deny].sort().join(', ')}` +
          `${hiddenByCatalogOnly.length > 0 ? ` (catalog-only: ${hiddenByCatalogOnly.sort().join(', ')})` : ''}`,
      )
    }
  }

  // ── 主路径：worker 一出现就处理，赶在首次 prompt 组装之前 ──
  //
  // 载荷必须从 payload **对象**上取 `agent`：把第一个参数当 agent 读会得到一个
  // 没有 session、没有 ctx 的对象，整段被静默跳过（本包已记录过的坑）。
  ctx.on('agent/created', (payload) => {
    try {
      narrow(payload?.agent)
    } catch (error) {
      // 本模块的任何意外都不得影响会话创建（它只省 token）。
      warnOnce(
        'created-threw',
        `handling agent/created for the worker guard failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })

  // ── 释放：agent 离开时卸掉限制，避免 scope key 复用时把过滤带给新 agent ──
  ctx.on('agent/disposed', (payload) => {
    try {
      release(payload?.agent)
    } catch {
      // 同上：卸不掉不影响任何功能。
    }
  })
}
