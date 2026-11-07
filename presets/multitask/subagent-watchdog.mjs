/**
 * multitask-subagent-watchdog — 父侧盯着子代理，卡死就把它停掉。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 协调者现在被要求「没有可推进的事就结束回合」。这条纪律要成立，前提是**它会被
 * 唤醒**：worker 干完活，宿主要通知父会话，父会话才有一轮可以处理结论。可这条前提
 * 在 worker **静默卡死**时不成立 —— 宿主**没有任何**子代理步数上限、空闲超时或看门狗，
 * 而且只有真正 idle 时才发 `subagent/end` 与结算通知。于是：
 *
 *   · worker 陷在同一个构造里反复改（典型是 `A ? { … } : { … }` 的花括号增生）；
 *   · 它不退回、不报错、也不再产生任何事件；
 *   · 父会话**什么也收不到** —— 它按纪律结束了回合，就再也不会被叫醒。
 *
 * 这比「协调者多刷几轮」更糟：整个任务停在半空，而界面上看不出任何异常。
 *
 * ── 为什么必须在**父侧**计时 ──────────────────────────────────────────────────
 *
 * 判据只能是「多久没有活动」。而「活动」这件事，判断点在**工具的每次调用之后**
 * （`tools/post-execute`）—— 那是子代理 scope 上的事件，但本插件在父 preset 的 scope
 * 上就能收到它（`exec.agent` 带着是谁发起的），所以计时的一方是父侧。
 *
 * 停在子代理身上另有一个不可替代的**副作用**：停下会触发 `subagent-settled` 通知，
 * 于是父会话被唤醒，卡死就从「静默」变成「可见」—— 协调者会在新回合里看到一条
 * 「某个 worker 被看门狗停了」，它因此知道该复查、该换人。这正是本模块存在的理由：
 * 不是为了让 worker 少跑，而是为了让**卡死有声音**。
 *
 * ── 为什么是「停掉」而不是「重新派单」───────────────────────────────────────
 *
 * 停掉是**可观测**的最小动作：它不丢上下文（中断只丢进行中的那一个动作），它不重复
 * 副作用（重派会让同一个写入动作做两遍），而它的通知就是唤醒父会话的那条路。重派是
 * 协调者的决定 —— 它看得见报告、看得见文件现状；本模块看不见这些，替它重派只会
 * 制造重复劳动与并发两套结果。
 *
 * ── 判据：只认「本 preset 协调者的子代理」────────────────────────────────────
 *
 * 1. 必须是被委派出来的子代理（`isDelegatedChild` 同形判据，本仓库零 import 约定，
 *    所以自带一份）；
 * 2. 父会话必须属于本 preset —— 优先看**父 agent 的活绑定**
 *    `父agent.ctx.get('agentPresets')?.composedPreset()`，那会随切模式而变，是权威
 *    信号；父 agent 查不到（或活绑定读不出来）时**不猜**，退回子代理自己的
 *    `session.header.agentPreset`；两者都不成立就**不纳入**。
 *
 * 判错的方向不对称：把一个 standard 模式的 worker 纳入在册，最坏是多一条停它的日志；
 * 但把**别的协调者**正在等待的 worker 停掉，等于替另一个会话做决定。所以拿不准时
 * 一律不纳入（fail-open），只留一条 info。
 *
 * ── 失败取向 ─────────────────────────────────────────────────────────────────
 *
 * **绝不抛错、绝不阻塞任何事件**。服务缺席、`interrupt` 不存在或抛错，一律记一条日志
 * 就退场 —— 最坏是「卡死仍然静默」，而抛错的代价是**把正常会话弄坏**。
 *
 * @module dsh-multitask/presets/multitask/subagent-watchdog
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-subagent-watchdog'

/**
 * 本模块**不**声明 `inject`。
 *
 * `subagents` / `agents` 都在**调用期**才去取，且允许取不到。声明注入会把这行绑在
 * 宿主服务的就绪时机上 —— 服务缺席时整行不装载，而本行「读不到就安静退场」的取向
 * 恰恰相反（与 `coordinator-prompt.mjs` / `interrupt-before-send.mjs` 同一条取舍）。
 */
export const inject = []

/** 日志前缀（可 grep）。 */
const PREFIX = 'dsh-multitask/subagent-watchdog'

/** 停止了一个停滞 worker 时打的标记。 */
export const STALLED_MARKER = '[MULTITASK-WATCHDOG-STALLED]'

/** 第一次真的纳入一个 worker 时打的标记（每进程一次）。 */
export const ENGAGED_MARKER = '[MULTITASK-WATCHDOG-ENGAGED]'

/** 跳过一条 agent/created 时打的标记（每进程一次 / 每个理由一次）。 */
export const SKIPPED_MARKER = '[MULTITASK-WATCHDOG-SKIPPED]'

/**
 * 默认停滞阈值：5 分钟。
 *
 * 够长，长到不会误杀一个正在长思考 / 长命令里的 worker（一次 `read` 动辄几十秒，
 * 一次整树命令可以是分钟级）；又够短，短到卡死不会把协调者的等待拖成整晚。
 */
const DEFAULT_STALL_TIMEOUT_MS = 300000

/** 默认巡检间隔：30 秒。 */
const DEFAULT_TICK_MS = 30000

/**
 * 每次进程只报一次的记录器（与 `coordinator-prompt.mjs` 的 `noteOnceFactory` 同意图）。
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
      write?.call(logger, `${PREFIX}: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 与 `coordinator-guard.mjs` / `coordinator-prompt.mjs` 的 `isDelegatedChild` **同一条
 * 判据**（三个信号任一成立）。本仓库「零 import」约定要求每个 `.mjs` 自带一份。
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
 * 读不出来（agent 的 ctx 缺席 / 注册表缺席 / 方法缺失 / 抛错 / 返回空）时返回
 * `undefined`，由调用方决定退路 —— 本模块**不**把它当成「不属于本 preset」，因为
 * 「读不到」与「不是」是两件事（前者要退到会话头）。
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
    return undefined
  }
}

/**
 * 按会话 id 找回一个**活着的** agent（与 `coordinator-guard.mjs` 同款容错写法）。
 *
 * `agents` 是宿主面服务（`dsh-agent` 注册为 `agents`），`get(id)` 是只读查询、
 * 返回 `undefined` 表示已不在。
 *
 * @param ctx - 本模块的上下文。
 * @param id - 会话 / agent id。
 * @returns 该 agent，或 `undefined`。
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
 * 把配置里的毫秒数收敛成正数；非法值退回默认值。
 *
 * @param value - 配置值。
 * @param fallback - 默认值。
 * @returns 一个正数（毫秒）。
 */
function positiveMs(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 装载本模块：在父侧为每个属于本 preset 的 worker 计时，停掉长期无活动的那些。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, presetId, stallTimeoutMs, tickMs, interruptOnStall }`
 *   （见 `composition.mjs` 里那一行）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const presetId = normalizePresetId(config?.presetId)
  const stallTimeoutMs = positiveMs(config?.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS)
  const tickMs = positiveMs(config?.tickMs, DEFAULT_TICK_MS)
  /** 只要配置没显式置 false，就停。 */
  const interruptOnStall = config?.interruptOnStall !== false

  const note = noteOnceFactory(ctx)
  const skip = (message) => note('info', `${SKIPPED_MARKER} ${message}`)

  /**
   * 在册表：`agent -> { at, id, parentId }`。
   *
   * 用 `Map` 而不是 `WeakMap`：巡检要**遍历**，而且 `agent` 对象本身随 `agent/disposed`
   * 删除，强引用不会长期累积（同一路径下别的守卫也用 `Map` / `WeakMap` 各有先例）。
   * `at` 是最后一次活动的时刻，只有它参与判据。
   */
  const watched = new Map()

  /** 打一条 warn（停滞是**故障级**信号，不能被 info 淹掉）。 */
  const warn = (message) => {
    try {
      const logger = ctx?.logger
      const write = typeof logger?.warn === 'function' ? logger.warn : logger?.info
      write?.call(logger, `${PREFIX}: ${message}`)
    } catch {
      // 日志失败不能反过来炸掉巡检。
    }
  }

  /**
   * 判定一个刚出现的 agent 是否要纳入在册。
   *
   * 顺序不可颠倒：父 agent 的活绑定是权威；**读不到**才退回子代理自己的会话头。
   * 两者都不成立 ⇒ 不纳入（fail-open）。
   *
   * @param agent - 刚被创建的 agent。
   * @param parentId - 它的父会话 id（可能为 undefined）。
   * @returns 是否纳入。
   */
  const ownsThisChild = (agent, parentId) => {
    if (presetId === undefined) {
      skip('no config.presetId was given, so preset ownership cannot be judged. [reason=no-preset-id]')
      return false
    }

    const parentAgent = parentId === undefined ? undefined : agentById(ctx, parentId)
    const live = composedPresetOf(parentAgent)
    if (typeof live === 'string') {
      // 权威信号：父会话当前组的就是本 preset（或明确不是）。
      if (live === presetId) return true
      skip(
        `the parent session is composed with the ${live} preset, not ${presetId}, so its worker is left alone. [reason=other-preset]`,
      )
      return false
    }

    // 父 agent 查不到 / 活绑定读不出来：**不猜**，退回子代理自己的会话头。
    if (normalizePresetId(agent?.session?.header?.agentPreset) === presetId) return true

    skip(
      'neither the parent agent nor the child session header identifies this preset, so the worker is left alone. [reason=unknown-owner]',
    )
    return false
  }

  /**
   * 把一个 agent 纳入在册（已在本册时只刷新时间戳）。
   *
   * @param agent - 刚被创建的 agent。
   */
  const watch = (agent) => {
    if (agent === undefined || agent === null) return
    if (!isDelegatedChild(agent)) return

    const header = agent.session?.header
    const parentId =
      typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : undefined

    if (!ownsThisChild(agent, parentId)) return

    const id = agent?.session?.id ?? agent?.id
    const existing = watched.get(agent)
    if (existing !== undefined) {
      // 重复的 `agent/created`（启动 / 恢复两条路径都可能发一次）：刷新而不是新增。
      existing.at = Date.now()
      return
    }

    watched.set(agent, { at: Date.now(), id, parentId })
    note(
      'info',
      `${ENGAGED_MARKER} watching delegated children of the ${presetId} preset for stalls (stallTimeoutMs=${stallTimeoutMs})`,
    )
  }

  /**
   * 巡检一次。
   *
   * 处理顺序刻意是「先删除、再打断」：这样即使 `interrupt` 同步地又抛出 / 触发事件，
   * 同一个 worker 也不会在另一次巡检里被重复处理。
   */
  const tick = () => {
    const now = Date.now()
    for (const [agent, entry] of watched) {
      const idle = now - entry.at
      if (idle <= stallTimeoutMs) continue

      // 立刻从在册里删掉：停滞只处理一次。
      watched.delete(agent)

      warn(`${STALLED_MARKER} child=${entry.id} idle=${idle}ms`)

      if (!interruptOnStall) continue

      try {
        const subagents = ctx?.get?.('subagents')
        if (subagents === undefined || subagents === null || typeof subagents.interrupt !== 'function') {
          // fail-open：接口缺席（老版本宿主）时只能让这条停滞静默下去 —— 但**不能抛**。
          skip(
            'this deployment\u2019s subagent service exposes no interrupt(), so a stalled worker cannot be stopped. [reason=no-interrupt-api]',
          )
          continue
        }
        const parentAgent = entry.parentId === undefined ? undefined : agentById(ctx, entry.parentId)
        // `authority` 用 `ancestor` 形状：上游据此做**血缘**校验。取得到父 agent 就传它，
        // 取不到就只给 kind —— 由宿主自己按会话血缘判定（不猜一个 agent 对象）。
        if (parentAgent === undefined || parentAgent === null) {
          subagents.interrupt(entry.id, { kind: 'ancestor' })
        } else {
          subagents.interrupt(entry.id, { kind: 'ancestor', agent: parentAgent })
        }
      } catch (error) {
        // 停不掉不是致命错误：最坏是这条停滞继续静默，而不是把插件弄坏。
        skip(
          `stopping a stalled worker was declined: ${error instanceof Error ? error.message : String(error)} [reason=interrupt-threw]`,
        )
      }
    }
  }

  // ── 计时 ──────────────────────────────────────────────────────────────────
  //
  // `unref()` 是必须的：一个没有 unref 的 `setInterval` 会让进程**无法退出**
  // （测试脚本会挂在那儿直到被外面杀掉）。它不是所有运行时都有，所以用可选调用。
  let timer
  try {
    timer = setInterval(tick, tickMs)
    timer?.unref?.()
  } catch (error) {
    skip(
      `starting the watchdog timer failed: ${error instanceof Error ? error.message : String(error)} [reason=no-timer]`,
    )
    timer = undefined
  }

  /** 停掉定时器（幂等：`dispose` 与 `ctx.effect` 可能各调一次）。 */
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      if (timer !== undefined) clearInterval(timer)
    } catch {
      // 停不掉定时器不该让 dispose 抛错。
    }
  }

  // ── 纳入口：`agent/created` ───────────────────────────────────────────────
  //
  // payload 从**对象**上解构（`agent/created` 传的是 `{ agent }`，不是 agent 本身）。
  ctx.on('agent/created', (payload) => {
    try {
      watch(payload?.agent)
    } catch (error) {
      // 兜底：看门狗的任何意外都不得影响会话创建。
      skip(
        `handling agent/created for the watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })

  // ── 活动信号：任何一次工具调用都算活动 ─────────────────────────────────────
  //
  // 刻意**不**看调用内容：一次长 `read`、一次大范围 `grep`、一次整树命令都是
  // 「这个 worker 还在动」的确证。判据越粗，越不会误杀。
  // ⚠️ `tools/post-execute` 是**瀑布**（`(exec, result, next)`），必须 `return next()`
  // 把下游结果原样传回去。写成普通监听（返回 undefined）会让**每一次**工具调用的
  // 结果变成 undefined，宿主读 `result.kind` 时抛
  // `Cannot read properties of undefined (reading 'kind')` ——
  // 表现为「七种工具全炸、动作却已经执行」，而且跨重启存活，极难定位。
  // 对照 `coordinator-guard.mjs` 的同名处理器。
  ctx.on('tools/post-execute', (exec, _result, next) => {
    try {
      const entry = watched.get(exec?.agent)
      if (entry !== undefined) entry.at = Date.now()
    } catch {
      // 刷新时间戳失败最多让一个活跃 worker 被误停 —— 不该让这次工具调用出问题。
    }
    return next()
  })

  // ── 释放：worker 走了就从在册里删掉 ──────────────────────────────────────
  //
  // `agent/disposed` 之后它的 id 再无意义；留着只会让下一次巡检对一条过期记录报警。
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      watched.delete(agent)
    } catch {
      // 删不掉只是内存里多一条记录，下一次 tick 会因为拿不到 id 而忽略它。
    }
  })

  // ── 清理：插件被卸载时必须停表 ───────────────────────────────────────────
  //
  // 两种清理通道都挂上：`ctx.on('dispose')` 是 cordis 的事件，`ctx.effect` 是它推荐的
  // 作用域清理（有就用、没有就跳过）。`stop` 幂等，所以两条都触发也没有副作用。
  // ⚠️ 测试里靠 `ctx.emit('dispose')` 停表 —— 少了这条，进程会挂到超时。
  try {
    ctx.on('dispose', stop)
  } catch {
    // 事件通道不可用还有下面那条。
  }
  try {
    if (typeof ctx.effect === 'function') {
      // 回调**立即执行**、返回 disposer —— 所以必须写成 `() => () => stop()`，
      // 写成 `() => stop` 会在装载那一刻就把表停掉。
      ctx.effect(() => () => stop())
    }
  } catch {
    // fail-open：至少上面的 `dispose` 还挂着。
  }
}
