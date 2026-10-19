/**
 * multitask-worker-persona — 给子代理换上**它那一类 worker** 的人格。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 子代理加入的是**父级那一份 preset**（`dsh-subagent` 的 `composeFrom`），所以它默认
 * 继承**协调者**的人格 —— 「你不能改文件、不能跑命令」。而 worker 恰恰要干这些事。
 * 实测已经证明这个矛盾会让 worker 拒活（详见 `composition.mjs` 里 `WORKER_PERSONA`
 * 上方那段）。
 *
 * ── 为什么这件事现在必须由本模块做（旧版本不是这样）──────────────────────────
 *
 * 旧版本把人格配在委派行的 `persona` 上，由 `dsh-subagent` 的 `applyChildComposition()`
 * 注册成子代理 scope 上的 `deployment:persona-prefix` section。
 *
 * **DSH 0.2.1-rc.2 删除了那个配置项**，而且不是静默忽略 —— 配置里只要出现 `persona`
 * （或 `toolFilter`），`dsh-tool-subagent` 的 `apply()` 就逐字抛
 *
 *     tool-subagent: persona is no longer supported; configure persona and tool plugins
 *     in an Agent Preset and select it with agentPreset (spawn only)
 *
 * 后果不是「人格不生效」，而是**整个 preset 挂载失败** —— 模式从新会话列表里彻底消失。
 * 所以人格必须由本包自己在**子代理的 scope** 上注册，而不是求上游代劳。
 *
 * ── 怎么认出「这个子代理是哪一类 worker」──────────────────────────────────────
 *
 * 靠 **provider 名**。它是唯一同时满足三件事的字段：
 *
 *   1. 由**委派行**决定（不是模型传的参数）；
 *   2. 原样写进 `subagent/descriptor` 事件（`data.provider`），因而在 `agent/created`
 *      这个窗口里读得到；
 *   3. 同一个内置 provider 实现可以起多个名字，所以每类 worker 各占一个。
 *
 * 四条行因此在 `composition.mjs` 里各绑一个 provider：`spawn` / `fork` /
 * `multitask_ptc` / `multitask_minimal`。本模块把 provider 名映射到人格文本，
 * 文本由 composition 通过 `config.personas` 传进来 —— **刻意不走 import**：
 *
 *   · 相对 import 不会继承入口的 `?v=N` query，改了 `composition.mjs` 之后本模块会从
 *     旧缓存取回**旧人格文本**，而且不报错（这个陷阱在本包文件头与 `local()` 的注释里
 *     各写过一遍）；
 *   · 人格文本是"数据"，不是"逻辑"，摆在 row 的 config 里不违反任何分层；
 *   · 于是「哪一行用哪份人格」只剩**一处**定义，不在两个文件里各写一遍。
 *
 * ── 为什么读 descriptor 而不是别的地方 ────────────────────────────────────────
 *
 * `subagent/descriptor` 是唯一**持久**、**按子代理一份**、**外部可读**的委派元数据。
 * `agent/created` 触发时它已经写入（`setup()` 里 append，`announce()` 才发
 * `agent/created`，见上游 `materializeTracked` 的顺序），所以这个窗口读得到。
 *
 * 兜底：历史会话（旧版本创建的）descriptor 里有 `persona` 但没有我们认识的 provider。
 * 那种情况退回读 `persona` 里的旧标记，好让**续接旧会话**仍然拿到正确人格。
 *
 * ── 失败取向 ─────────────────────────────────────────────────────────────────
 *
 * **绝不抛错、绝不阻塞会话创建**。最坏情况是子代理拿到协调者人格（旧行为），
 * 这是可用的、只是不理想。反过来，若这里抛错，代价是**该子代理起不来**。
 *
 * 但「静默降级」不等于「看不见」：读不到人格、注册被拒这两条路径各留一条带固定
 * 标识的 warn，可 grep。
 *
 * @module dsh-multitask/presets/multitask/worker-persona
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-worker-persona'

/**
 * 本模块**不**声明 `inject`。
 *
 * 它要的都不是「服务」：`agent/created` 是 ctx 事件，`systemPrompt` 从 `agent.ctx`
 * 上取。声明 `inject: ['systemPrompt']` 会把它绑在宿主服务的就绪时机上，而本模块
 * 的设计前提正是「读不到就安静退场」。
 */
export const inject = []

/**
 * 承载「这份人格」的 system prompt 段落名。
 *
 * 逐字为上游常量 `PERSONA_PREFIX_SECTION` 的值。名字必须逐字一致：漂了不会报错，
 * 只会**读不到 / 盖不住**（于是 worker 又拿回协调者人格）—— 最难查的一种坏法。
 */
const PERSONA_SECTION_NAME = 'deployment:persona-prefix'

/** 段落顺序键 —— 与上游 `dsh-persona` 用的是同一个，保证落在同一位置。 */
const PERSONA_ORDER_KEY = 'DEPLOYMENT_PERSONA_PREFIX'

/**
 * 旧版本写在 persona 开头的模式标记。
 *
 * **只用于续接旧会话**：那些会话的 descriptor 里留着带标记的 persona，而 provider
 * 是当年那个通用名（`spawn`），认不出 worker 种类。新会话走 provider 名，不需要它。
 */
const LEGACY_PTC_MARKER = '[multitask-mode:ptc]'
const LEGACY_MINIMAL_MARKER = '[multitask-mode:minimal]'

/** 一个每次进程只警告一次的记录器（与其余守卫同款，避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/worker-persona: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 三个信号任一成立即视为子代理 —— 与 `coordinator-guard.mjs` 的 `isDelegatedChild`
 * 保持**同一条判据**（那里写明：判错的代价很高）。这里判错的方向尤其危险：
 * 把协调者误判成子代理，就会**覆盖协调者自己的人格**，减震器的语义当场被改写。
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
 * `agent/created` 这个非异步窗口里使用。上游把这两个方法标为 deprecated，
 * 但这里要的就是「创建窗口内的同步读」。取不到就当作没有 descriptor，而不是抛错。
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
 * 读该子代理的委派元数据：`{ provider, persona }`。
 *
 * 只认**第一条** `subagent/descriptor` —— 上游的定性是「first event is authoritative」，
 * 后续同类型事件不得改写已声明的组合。
 *
 * @param agent - 目标子代理。
 * @returns provider 名与旧版 persona（都可能缺）。
 */
function descriptorOf(agent) {
  for (const event of sessionEvents(agent)) {
    if (event?.type !== 'subagent/descriptor') continue
    const data = event?.data
    const provider = typeof data?.provider === 'string' && data.provider !== '' ? data.provider : undefined
    const persona = typeof data?.persona === 'string' && data.persona !== '' ? data.persona : undefined
    return { provider, persona }
  }
  return { provider: undefined, persona: undefined }
}

/**
 * 按 provider 名（或旧版 persona 标记）选出该子代理应当使用的人格。
 *
 * @param agent - 目标子代理。
 * @param personas - `provider名 -> 人格文本`，由 composition 通过 config 传入。
 * @returns 人格文本，或 undefined（不是本包的四类 worker 之一）。
 */
function personaForChild(agent, personas) {
  const { provider, persona } = descriptorOf(agent)

  // 主通道：provider 名。新会话全部走这里。
  if (typeof provider === 'string' && personas !== undefined && personas !== null) {
    const text = personas[provider]
    if (typeof text === 'string' && text !== '') return text
  }

  // 兜底：旧会话的 persona 标记。仅当 provider 认不出来时才看它，
  // 免得「provider 已改名」与「旧标记残留」互相干扰。
  if (typeof persona === 'string' && persona !== '') {
    if (persona.includes(LEGACY_PTC_MARKER) || persona.includes(LEGACY_MINIMAL_MARKER)) {
      const key = persona.includes(LEGACY_PTC_MARKER) ? 'multitask_ptc' : 'multitask_minimal'
      const text = personas?.[key]
      if (typeof text === 'string' && text !== '') return text
    }
  }

  return undefined
}

/**
 * 装载本模块：给子代理 scope 注册它那一类 worker 的人格段落。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, personas }`（见 `composition.mjs` 里那一行）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const personas = config?.personas
  const warn = warnOnceFactory(ctx)

  /**
   * 已经处理过的 agent。用 WeakSet 而不是 Set：agent 回收后不该由本模块持有强引用。
   *
   * 去重是必需的：`agent/created` 在启动 / 恢复路径上可能对同一个 agent 触发两次
   * （`source: 'startup'` 与 `resume`），而同一个 scope 里注册**同名** section 会被
   * 服务直接拒绝（`prompt section "..." is already registered in this scope`）。
   */
  const handled = new WeakSet()

  const installPersona = (agent) => {
    if (handled.has(agent)) return

    // ── 硬前置：绝不作用于协调者 ──
    if (!isDelegatedChild(agent)) return

    const service = (() => {
      try {
        const direct = agent?.ctx?.systemPrompt
        if (direct !== undefined && direct !== null) return direct
        return agent?.ctx?.get?.('systemPrompt')
      } catch {
        return undefined
      }
    })()

    if (service === undefined || service === null || typeof service.section !== 'function') {
      warn(
        'a subagent scope exposes no systemPrompt.section(); its worker persona was NOT installed and it keeps ' +
          'the coordinator persona. [WORKER-PERSONA-SKIPPED reason=no-system-prompt]',
      )
      handled.add(agent)
      return
    }

    const text = personaForChild(agent, personas)
    // 认不出来 = 这条委派行不是本包的四类 worker 之一（例如外部 provider），
    // 保持上游给它的组合即可。
    if (text === undefined) {
      handled.add(agent)
      return
    }

    try {
      // `getSectionOrder` 由服务提供；拿不到就退到 0 —— 与上游
      // `DEPLOYMENT_PERSONA_PREFIX` 的取值一致（见 dsh-system-prompt 的 SECTION_ORDERS）。
      const order =
        typeof service.getSectionOrder === 'function'
          ? service.getSectionOrder(PERSONA_ORDER_KEY)
          : 0
      service.section({
        name: PERSONA_SECTION_NAME,
        order: Number.isFinite(order) ? order : 0,
        text,
      })
      handled.add(agent)
      ctx.logger?.info?.(
        `dsh-multitask: installed the worker persona for a delegated subagent [WORKER-PERSONA-ENGAGED]`,
      )
    } catch (error) {
      handled.add(agent)
      warn(
        `installing a worker persona was declined: ${error instanceof Error ? error.message : String(error)} — ` +
          'that worker keeps the coordinator persona. [WORKER-PERSONA-SKIPPED reason=section-threw]',
      )
    }
  }

  // ── 时机：`agent/created` ──
  //
  // 与其余守卫完全相同：`SystemPrompt.assemble()` 先收集工具提供方再跑瀑布，所以在
  // 瀑布内部改人格改变不了它服务的那次请求；`agent/created` 是「首次 prompt 组装
  // 之前」的安全窗口。descriptor 在 `setup()` 里就已 append，因此此刻读得到。
  //
  // 载荷必须从 payload **对象**上取 `agent` 字段（`agent/created` 传的是
  // `{ agent }`，不是 agent 本身）。把第一个参数当 agent 读会得到一个没有 session、
  // 没有 ctx 的对象，于是 `isDelegatedChild` 判 false、整段被静默跳过。
  ctx.on('agent/created', (payload) => {
    try {
      installPersona(payload?.agent)
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话创建。
      warn(`handling agent/created for the worker persona failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
