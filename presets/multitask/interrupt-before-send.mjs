/**
 * multitask-interrupt-before-send — 让「追加给子代理的话」**立刻**生效，而不是排队。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 协调者发现子代理正在做错事时，唯一的手段是 `send_message`。而宿主的投递语义是
 * **`steer`（步骤边界投递）**：
 *
 *     A working target receives the message at its nearest step boundary through
 *     Steer; an inactive target starts or resumes a turn.
 *
 * 「nearest step boundary」听起来很快，实际上**不是**：一步可以是一整个长工具调用
 * （跑一次构建、拉一次依赖、递归扫一棵目录树）。更糟的是宿主自己的说明里还有一句
 * ——目标不活跃时**排队等下一轮**。于是就出现了用户实测到的那种情形：
 *
 *   · 子代理正按一条**错误**的要求往下做；
 *   · 协调者发一条纠错 —— 它进了收件箱/步骤边界队列；
 *   · 那条错误的要求**继续跑完**，纠错才被读到；
 *   · 等到那时，错误已经造成（文件改错、命令跑完、产物写坏）。
 *
 * 结论很直接：**光发不够，必须先停掉当前轮次**。纠错的价值全在时效上，晚一步就
 * 只剩善后。
 *
 * ── 为什么是「挂一个钩子」而不是「自己再注册一个工具」───────────────
 *
 * 有两件事可以做：
 *
 *   1. 注册一个新工具（例如 `steer_with_interrupt`），指望模型在纠错时主动选它；
 *   2. 不改工具面，在两个动作之间**插一次中断**。
 *
 * 选 2。理由是**可靠性**：方案 1 的正确性依赖模型每次都选对工具，而模型在赶进度时
 * 不会去分辨「这次是追加还是纠错」—— 那正是它刚刚做错事的那一刻。而 `send_message`
 * 只有一条路径，拦在它前面就**不可能**漏。
 *
 * 更准确地说：本模块不改变任何工具的**语义**，只改变**时机** ——
 * 用户发出的那句「追加」照旧是那句，但它不再排在错误要求的后面。
 *
 * ── 为什么先中断不会让「正常追加」变坏 ──────────────────────────────────────
 *
 * 这是本模块最需要交代清楚的一点，否则它看起来像「每次发消息都暴力打断」。
 *
 * 宿主的 `interrupt` 有三个关键性质（逐字来自上游文档）：
 *
 *   · **只停当前轮次**：`stops a child's current turn while keeping its inbox and
 *     descendants intact` —— 收件箱与它派出的后代都不动；
 *   · **对已结束的目标是空操作**：`an absent or settled target still renders the
 *     acceptance line`，不抛错、不改任何状态；
 *   · **授权即血缘**：`authority = { kind: 'ancestor', agent }`，非祖先（自我、
 *     兄弟、已失效）会被明确拒绝。
 *
 * 于是三种情形都成立：
 *
 *   | 子代理此刻 | 先中断的效果 | 用户体验 |
 *   |---|---|---|
 *   | 已结束、等下一轮 | 空操作 | 与不加本模块完全一样 |
 *   | 正跑**错**的东西 | 停掉当前轮次 | 纠错立刻被读到 —— 本模块的全部意义 |
 *   | 正跑**对**的东西 | 停掉当前轮次 | 这一步的进度没了，但下一轮从纠错开始 |
 *
 * 第三行是**代价**，必须如实承认：中途追加会牺牲当前这一步的进度。它换来的是
 * 「追加永远能及时生效」。这里刻意默认开启：在本模式里，**追加几乎总是为了纠错**
 * （任务书已经把该说的事说完了，能中途再说的多半是「刚才那条说错了」），而排队会让
 * 纠错失效。要退回宿主原语义（排队）就把这一行配成 `enabled: false`。
 *
 * 只提供**整行开关**、不提供「按消息内容判断该不该中断」的智能选项，是刻意的：
 * 那种判断只能靠模型自己说「我这条是纠错」，而模型恰恰是最容易搞错这件事的地方。
 * 一个永远成立的规则比一个需要判断的规则可靠。
 *
 * ── 只在**协调者 → 子代理**方向拦截 ─────────────────────────────────────────
 *
 * 硬前置：发送方**不能**是被委派的子代理。
 *
 * 因为 worker 也能给它的父会话发消息（汇报进度）。若对那个方向也先中断，被停掉的
 * 就是**主对话自己的回合** —— 用户正在看的回答会被掐断。那是本模块最不该发生的
 * 副作用，而它只需要一条判据就能避免：`isDelegatedChild(agent)` 为真就一个字都不动。
 *
 * 顺带一提，即使判据写漏了，`authority: { kind: 'ancestor' }` 也会在非祖先方向
 * 失败（上游明确拒绝），而下面的 try/catch 只会记一条 info —— 双层防护。
 *
 * ── 时序：为什么中断排在 `next()` 之前 ───────────────────────────────────────
 *
 * `tools/pre-execute` 是**执行之前**的瀑布：返回 `next()` 才真正跑工具。所以顺序只能是
 *
 *     拦截 send_message → interrupt(目标) → next()（= 真正发送）
 *
 * 反过来（先发再中断）等于什么都没做：消息已经在队列里排在错误要求后面了。
 *
 * ⚠️ 中断是**同步**的（`interrupt(...): void`），而取消是**协作式**的 —— 真正的
 * 收尾会稍后发生。所以这里刻意**不等**目标变成空闲（那可能是一整个工具调用，
 * 会把这个工具调用一起挂住）。不等也不会退回旧行为：轮次已经被标记取消，
 * 投进去的消息会在**下一轮开头**被读到，而不是等错误要求跑完。
 *
 * ── 失败取向：静默降级 ──────────────────────────────────────────────────────
 *
 * 中断失败（服务缺失、目标不是自己的后代、id 读不出来）**绝不能**影响发送本身 ——
 * 那会把「纠错稍晚」变成「纠错根本没发出去」，方向正好反了。所以任何失败都只是
 * 记一条带固定标识的 info，然后照常 `next()`。
 *
 * @module dsh-multitask/presets/multitask/interrupt-before-send
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-interrupt-before-send'

/**
 * 本模块**不**声明 `inject`。
 *
 * 它要的都不是「服务就绪才能装」的东西：`tools/pre-execute` 是 ctx 事件，
 * `subagents` 在调用那一刻才去取。声明注入会把它绑死在宿主服务的就绪时机上，
 * 而本模块的设计前提正是「取不到就安静退场」。
 */
export const inject = []

/** 被拦截的工具名。宿主用它做「全局命名的续接子级控制」。 */
const TOOL_NAME = 'send_message'

/**
 * 子会话 id 在参数里可能出现的键名 —— 与上游自己的解析顺序**逐字一致**。
 *
 * 上游是 `arg(args, "target") || arg(args, "agent_id") || arg(args, "sessionId") ||
 * arg(args, "job_id")`。这里照抄同一顺序，否则我们可能中断 A 而消息发给 B ——
 * 那比不中断更糟。
 */
const TARGET_KEYS = ['target', 'agent_id', 'sessionId', 'job_id']

/** 子代理会话的 `origin` 标记（与其它守卫同一常量）。 */
const SUBAGENT_ORIGIN = 'subagent'

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 与 `coordinator-guard.mjs` / `minimal-guard.mjs` / `subagent-mode.mjs` /
 * `approval-gate.mjs` 用**同一条判据**（`origin` / `parentSession` /
 * `delegationDepth` 三信号）。本模块里它的作用是**方向闸门**：子代理发出的消息
 * 一个字都不拦（否则会掐断主对话自己的回合）。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为被委派的子代理。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === SUBAGENT_ORIGIN) return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 造一个「同因只报一次」的告警函数。
 *
 * 与同目录其它模块同款：热路径上的告警必须去重，否则一个长会话会被同一条消息刷屏。
 *
 * @param ctx - 插件上下文。
 * @returns 告警函数。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/interrupt-before-send: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉工具调用。
    }
  }
}

/**
 * 从工具参数里取出目标会话 id。
 *
 * @param args - 工具的 arguments。
 * @returns 目标 id，或 undefined（取不到就**不中断**，绝不猜一个）。
 */
function targetIdOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
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

  /**
   * 「`interrupt` 是不是一个可用的方法」只探测一次。
   *
   * 探测放在调用期而不是装载期是刻意的：`subagents` 服务可能在 preset 挂载之后
   * 才就绪，装载期探测会把一个**暂时**缺席的服务记成永久缺失。
   */
  let interruptUnavailableWarned = false

  /** 记一条结果（固定标识，便于 grep）。 */
  const note = (kind, detail) => {
    try {
      ctx.logger?.info?.(`dsh-multitask: MULTITASK-STEER-INTERRUPT-${kind}${detail === undefined ? '' : ` ${detail}`}`)
    } catch {
      // 同上。
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec?.name !== TOOL_NAME) return await next()

      const agent = exec?.agent
      // 方向闸门：worker → 父会话的汇报**绝不**拦截（否则会掐断主对话的回合）。
      if (isDelegatedChild(agent)) return await next()

      const targetId = targetIdOf(exec?.arguments)
      if (targetId === undefined) {
        // 取不到目标就不中断：宁可纠错晚一点，也不能靠猜去停一个会话。
        note('SKIPPED', 'reason=no-target-id')
        return await next()
      }

      const subagents = ctx.get?.('subagents')
      if (subagents === undefined || subagents === null || typeof subagents.interrupt !== 'function') {
        // 服务缺失或版本没有这个能力：照常发送，只是纠错会晚一步。
        if (!interruptUnavailableWarned) {
          interruptUnavailableWarned = true
          warn(
            'this deployment\u2019s subagent service exposes no interrupt(); corrections are queued in the target inbox as before',
          )
        }
        note('SKIPPED', 'reason=no-interrupt-api')
        return await next()
      }

      // ── 就是这里：先停当前轮次，再让发送照常往下走 ──────────────────────────
      //
      // `authority` 用 `ancestor` 形状：上游据此做**血缘**校验，非祖先（自我、
      // 兄弟、已失效）会被拒绝。用 `kind: 'user'` 是错的 —— 那声称「用户下的命令」，
      // 而这里下命令的是插件，不是用户。
      try {
        subagents.interrupt(targetId, { kind: 'ancestor', agent })
        note('ENGAGED', `target=${JSON.stringify(targetId)}`)
      } catch (error) {
        // 中断失败**不改变**发送：把「纠错稍晚」降级成「纠错没发出去」方向正好反了。
        note(
          'FAILED',
          `target=${JSON.stringify(targetId)} reason=${error instanceof Error ? error.message : String(error)}`,
        )
      }

      return await next()
    } catch (error) {
      // 任何意外都不得影响这次发送（见文件头「失败取向」）。
      warn(`intercepting ${TOOL_NAME} failed: ${error instanceof Error ? error.message : String(error)}`)
      return await next()
    }
  })
}
