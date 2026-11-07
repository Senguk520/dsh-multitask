/**
 * multitask-coordinator-prompt — 让协调者**在派单之后结束回合**。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 协调者派完单不会停：它反复去看 worker「跑到哪了」，用过程数据把等待填满，于是
 * 一个本该一轮结束的动作被拖成好几轮，把宝贵的上下文烧在没有任何结论的信息上。
 *
 * 成因不只在人格里。宿主 `dsh-tool-subagent`（`lib/index.js:509-518`）会**无条件**
 * 注入一段系统提示，名字 `tool:subagent`、order `getSectionOrder("TOOL_SUBAGENT")`
 * = 2800，正文开头逐字是
 *
 *     "Start independent delegations with …together in one assistant message and
 *      continue useful work while they run."
 *
 * 最后半句就是那句「边做边瞄」的来源：它被读成「派完单要继续产出回合」。而宿主
 * 该行的 Config 只有 `provider` / `toolName` / `modelSelectionSettings` /
 * `agentOptions` / `agentPreset` / `allowedAgentPresets` / `maxDepth`，**没有任何
 * 开关能关掉这段**。
 *
 * ── 为什么能盖掉它 ────────────────────────────────────────────────────────────
 *
 * 段落可以**按名字被更近的作用域遮蔽**。`dsh-system-prompt/lib/index.js:245-249`
 * 明写 "A scoped section shadows a global section with the same name; duplicates
 * within one layer throw"，合并见 `dsh-scope`（`lib/index.js:177-181`）。
 *
 * 也就是说：只要在**协调者自己的 scope** 上注册一个同名段 `tool:subagent`，它就赢。
 * 这不是新发明的机制 —— 本仓库已有同款先例：`worker-persona.mjs:264-268` 在
 * **子代理 scope** 上用同名段 `deployment:persona-prefix` 盖掉上游那份。
 *
 * ── 为什么是「另写一段」而不是改人格就够 ──────────────────────────────────────
 *
 * 人格（`composition.mjs` 的 `COORDINATOR_PERSONA`）里已经写明了本条的优先级，但
 * 人格是一条消息，宿主那段 `tool:subagent` 同样在 prompt 里，而且它是工具自带的
 * 说明 —— 模型通常会把它当成更具体的指令。把同名段换掉，才是让**落点**（结束回合）
 * 与人格一致，而不是让两句话互相矛盾、由模型自行裁决。
 *
 * 文本刻意**保留宿主那句的开头语义**（"Start independent delegations …"），只在
 * 「然后该干什么」处换成「能收尾就收尾」。
 *
 * ── 判据（只认协调者，且只认本 preset）──────────────────────────────────────
 *
 * 1. 跳过 `isDelegatedChild` —— worker 要的是「干活然后回报」，不是「结束回合」；
 *    给 worker 也盖这一段会把「派完就停」误读成「做一点就停」。
 * 2. 要求归属本 preset：优先读活绑定 `agent.ctx.get('agentPresets')?.composedPreset()`
 *    （它会随切模式而变，是权威信号），读不到才退回
 *    `session.header.agentPreset === config.presetId`（新建会话的绑定时序没有实证，
 *    只读活绑定会让真正的本模式会话也漏装）。
 *
 * 两条判据与 `coordinator-guard.mjs` 的 `isDelegatedChild` / `ownerPresetId` 同形 ——
 * 本仓库的「零 import」约定要求每个 `.mjs` 自带一份，所以这里独立实现，不 import。
 *
 * ── 失败取向 ─────────────────────────────────────────────────────────────────
 *
 * **绝不抛错、绝不阻塞会话创建**。`systemPrompt` 服务缺席、`section()` 不存在或抛错，
 * 一律**静默降级**（只留一条 info），最坏结果是回到宿主原语义（「边做边瞄」）。
 * 反过来若这里抛错，代价是**该会话起不来** —— 那比多刷几轮严重得多。
 *
 * @module dsh-multitask/presets/multitask/coordinator-prompt
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-coordinator-prompt'

/**
 * 本模块**不**声明 `inject:'systemPrompt'`。
 *
 * 服务从 `agent.ctx` 上取，且**允许取不到**（取不到就跳过）。声明 `inject` 会把这
 * 一行绑在宿主服务的就绪时机上 —— 服务不在时整行不装载，与本行「读不到就安静退场」
 * 的取向相反，也和 `worker-persona.mjs` 的取舍不一致。
 */
export const inject = []

/**
 * 被遮蔽的段落名，逐字为宿主 `dsh-tool-subagent` 注册的那个。
 *
 * 名字必须**逐字一致**：漂了不会报错，只会盖不住（于是宿主那句「continue useful
 * work while they run」继续生效）—— 最难查的一种坏法。
 */
const SHADOW_SECTION_NAME = 'tool:subagent'

/** 段落顺序键 —— 与宿主 `dsh-tool-subagent` 用的是同一个，落在同一位置。 */
const SHADOW_ORDER_KEY = 'TOOL_SUBAGENT'

/**
 * `getSectionOrder` 读不到时用的顺序值。
 *
 * 逐字为宿主 `dsh-system-prompt` 的 `SECTION_ORDERS.TOOL_SUBAGENT`（= 2800）。
 * 顺序值只影响「这段排在哪」，漂一点不致命，但仍要与被遮蔽的那段重合才有意义。
 */
const DEFAULT_SHADOW_ORDER = 2800

/**
 * 替换宿主那段用的正文。
 *
 * 保留宿主开头「用本模式的 subagent 工具同时开几路」的语义（那是准确且有用的），
 * 把落点改成「没有可推进的事就结束回合」，并把宿主那句 "continue useful work while
 * they run" 的误读**正面驳回**：不许轮询过程数据，不许替 worker 读文件。
 *
 * 写成常量而不是拼字符串：集成/契约测试按字面量断言它，别让格式变动把断言变成空转。
 */
export const SHADOW_TEXT = `Start independent delegations with the subagent tools of this mode — start several delegations in one assistant message. When nothing is left to advance (no brief to write, no reported claim waiting for verification, no answer owed to the user), END YOUR TURN: the runtime notifies you when a worker finishes and its report arrives as a new turn, so nothing is lost. Do not poll list_agents / job_list / job_output to watch progress, and do not read or redo the files a worker owns.`

/** 注册成功时的日志标记（可 grep）。 */
const ENGAGED_MARKER = '[MULTITASK-COORDINATOR-PROMPT-ENGAGED]'

/** 被跳过时的日志标记（可 grep）。 */
const SKIPPED_MARKER = '[MULTITASK-COORDINATOR-PROMPT-SKIPPED]'

/**
 * 每次进程只报一次的记录器。
 *
 * 与 `worker-persona.mjs` 的 `warnOnceFactory` **同意图**（同一条消息只出一次，避免
 * 每个 worker 刷一行），但级别是 `info`：被跳过不是故障 —— 子代理本来就该跳过，
 * `systemPrompt` 读不到也只是回到宿主原语义。用 warn 会让正常会话看起来像坏了。
 *
 * @param ctx - preset scope 的插件上下文。
 * @returns 记录函数（`(level, message) => void`）。
 */
function noteOnceFactory(ctx) {
  const seen = new Set()
  return (level, message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      const logger = ctx?.logger
      const write = typeof logger?.[level] === 'function' ? logger[level] : logger?.info
      write?.call(logger, `dsh-multitask/coordinator-prompt: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 三个信号任一成立即视为子代理 —— 与 `coordinator-guard.mjs` / `worker-persona.mjs`
 * 的 `isDelegatedChild` **同一条判据**（那两处都写明：判错的代价很高）。这里判错的
 * 方向尤其危险：把 worker 判成协调者，就会往它身上装「没活就结束回合」，而 worker
 * 的整个意义是**把活干完**。
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

/** 规范化一个 preset id：只接受非空字符串。 */
function normalizePresetId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 读一个 agent **当前实际所属**的 preset id（活绑定）。
 *
 * 用注册表的 `composedPreset(agent.ctx)` —— 它读的是 `standingMountFor(agent.ctx)`，
 * 会随会话切换而改变。读不出来（注册表缺席 / 方法缺失 / 抛错 / 返回空）时返回
 * `undefined`，由调用方退回会话头。
 *
 * @param agent - 目标 agent。
 * @returns preset id，或 `undefined`。
 */
function composedPresetOf(agent) {
  const agentCtx = agent?.ctx
  if (agentCtx === undefined || agentCtx === null) return undefined
  try {
    const registry = agentCtx.get?.('agentPresets')
    if (registry === undefined || registry === null) return undefined
    if (typeof registry.composedPreset !== 'function') return undefined
    return normalizePresetId(registry.composedPreset(agentCtx))
  } catch {
    // 读不到不是致命错误：退回会话头。
    return undefined
  }
}

/**
 * 判定一个 agent 是否归属于本 preset。
 *
 * 两层，顺序不可颠倒（理由见 `coordinator-guard.mjs` 的 `ownerPresetId`）：
 * 活绑定是权威；只有在活绑定**读不出来**时才用会话头 `agentPreset` —— 那是
 * 「创建时用的是哪一份」，切换之后就过期了。
 *
 * @param agent - 目标 agent。
 * @param presetId - 本 preset 的 id（来自 composition 那一行）。
 * @returns 是否归属本 preset。
 */
function belongsToPreset(agent, presetId) {
  const live = composedPresetOf(agent)
  if (typeof live === 'string') return live === presetId
  return normalizePresetId(agent?.session?.header?.agentPreset) === presetId
}

/**
 * 取该 agent scope 上的 `systemPrompt` 服务。
 *
 * 先试 `agent.ctx.systemPrompt`，再试 `agent.ctx.get('systemPrompt')`（某些上下文
 * 只暴露 `get`）。取不到返回 `undefined` —— 调用方据此**安静跳过**，而不是抛错。
 *
 * @param agent - 目标 agent。
 * @param ctx - 本模块的上下文，作为第二个来源。
 * @returns systemPrompt 服务，或 `undefined`。
 */
function systemPromptOf(agent, ctx) {
  for (const carrier of [agent?.ctx, ctx]) {
    if (carrier === undefined || carrier === null) continue
    try {
      const direct = carrier.systemPrompt
      if (direct !== undefined && direct !== null) return direct
      const viaGet = carrier.get?.('systemPrompt')
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch {
      // 换下一个来源；读不到不是致命错误。
    }
  }
  return undefined
}

/**
 * 读本段应当使用的顺序值。
 *
 * `getSectionOrder` 拿不到（方法不存在、抛错、返回非有限数）时退回 2800 ——
 * 宁可位置与宿主那段重合，也不要因为一个读不到的顺序值把整段跳过。
 *
 * @param service - 该 agent scope 的 systemPrompt 服务。
 * @returns 段落顺序（有限数）。
 */
function shadowOrderOf(service) {
  try {
    if (typeof service?.getSectionOrder === 'function') {
      const order = service.getSectionOrder(SHADOW_ORDER_KEY)
      if (Number.isFinite(order)) return order
    }
  } catch {
    // 读不到就用常量。
  }
  return DEFAULT_SHADOW_ORDER
}

/**
 * 装载本模块：给协调者的 scope 装一段同名段，遮蔽宿主注入的 `tool:subagent`。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, presetId }`（见 `composition.mjs` 里那一行）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const presetId = normalizePresetId(config?.presetId)
  const note = noteOnceFactory(ctx)

  /**
   * 已经装上的 agent -> disposer。
   *
   * 用 WeakMap 而不是 Map：agent 回收后不该由本模块持有强引用。它同时承担**去重**
   * —— `agent/created` 在启动 / 恢复路径上可能对同一个 agent 触发两次
   * （`source: 'startup'` 与 `resume`），而同一个 scope 里注册**同名**段会被服务
   * 直接拒绝（"prompt section ... is already registered in this scope"）。
   *
   * 条目在 `agent/disposed` 时删除，因此同一个 agent 之后重新出现时能**重新注册**
   * （集成测试按这个语义断言）。
   */
  const installed = new WeakMap()

  const skip = (message) => note('info', `${SKIPPED_MARKER} ${message}`)

  /**
   * 给一个协调者装遮蔽段。
   *
   * @param agent - 刚被创建的 agent。
   */
  const install = (agent) => {
    if (agent === undefined || agent === null) return
    if (installed.has(agent)) return

    // ── 硬前置其一：绝不作用于子代理 ──
    // worker 的活是「干完并回报」，把「没活就结束回合」装到它身上会直接削弱执行力。
    if (isDelegatedChild(agent)) {
      skip('this agent is a delegated child, so it keeps the host section. [reason=delegated-child]')
      return
    }

    // ── 硬前置其二：只接管属于本 preset 的会话 ──
    // 别的模式有自己的提示词纪律，替它改工具说明是越界；无 config.presetId 时无法
    // 判定归属，同样不动（宁可不装，也不要装错对象）。
    if (presetId === undefined) {
      skip('no config.presetId was given, so preset ownership cannot be judged. [reason=no-preset-id]')
      return
    }
    if (!belongsToPreset(agent, presetId)) {
      skip(`this agent is not composed with the ${presetId} preset, so its prompt is left untouched. [reason=other-preset]`)
      return
    }

    const service = systemPromptOf(agent, ctx)
    if (service === undefined || typeof service.section !== 'function') {
      // fail-open：服务缺席时最坏退回宿主原语义（多刷几轮），绝不因此让会话起不来。
      skip('the agent scope exposes no systemPrompt.section(); the coordinator keeps the host wording. [reason=no-system-prompt]')
      return
    }

    const order = shadowOrderOf(service)
    try {
      const dispose = service.section({
        name: SHADOW_SECTION_NAME,
        order,
        text: () => SHADOW_TEXT,
      })
      // 不假定 `section()` 一定返回 disposer；没有就存一个空操作，仍算「已装上」。
      installed.set(agent, typeof dispose === 'function' ? dispose : () => {})
      try {
        ctx.logger?.info?.(
          `dsh-multitask: shadowed the host "tool:subagent" section for a coordinator — it is now told to END ITS TURN when nothing is left to advance ${ENGAGED_MARKER}`,
        )
      } catch {
        // 日志失败不影响已装上的段。
      }
    } catch (error) {
      // fail-open：注册被拒（例如同名重复）也只是回到宿主原语义。
      skip(
        `registering the coordinator section was declined: ${error instanceof Error ? error.message : String(error)} — ` +
          'this session keeps the host wording. [reason=section-threw]',
      )
    }
  }

  // ── 时机：`agent/created` ──
  //
  // `SystemPrompt.assemble()` 先收集工具提供方再跑瀑布，所以必须在「首次 prompt 组装
  // 之前」把段装上；`agent/created` 是这个安全窗口（与其余守卫完全相同）。
  //
  // 载荷必须从 payload **对象**上取 `agent` 字段（`agent/created` 传的是 `{ agent }`，
  // 不是 agent 本身）。把第一个参数当 agent 读会得到一个没有 session、没有 ctx 的
  // 对象，于是整段被静默跳过。
  ctx.on('agent/created', (payload) => {
    try {
      install(payload?.agent)
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话创建。
      skip(
        `handling agent/created for the coordinator prompt failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })

  // ── 释放：agent 离开时必须卸掉这一段 ──
  //
  // scope key 被回收后可能复用到新 agent 上，遗留一段本该消失的遮蔽会让新会话莫名
  // 收到「结束回合」的指令。卸掉的同时删掉在册记录，好让同名 agent 再出现时能重装。
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      const dispose = installed.get(agent)
      installed.delete(agent)
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      skip(
        `releasing the coordinator prompt section failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}
