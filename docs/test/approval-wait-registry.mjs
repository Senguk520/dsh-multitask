/**
 * 「审批等待登记表」跨模块契约校验（进程内 / 零依赖 / 离线 / 不写盘 / 不 spawn）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * 三个模块共享一张挂在 `globalThis` 上的表：
 *
 *   · 写入端 `approval-gate.mjs`（`waitEnter` / `waitExit`，`try/finally` 包住 `approval.request`）；
 *   · 读取端 `interrupt-before-send.mjs`（`awaitingApproval(targetId)` ⇒ 跳过这次中断）；
 *   · 读取端 `subagent-watchdog.mjs`（tick 内命中 ⇒ `continue`，不删在册、不判停滞、不 interrupt）。
 *
 * 判据必须是三处逐字一致的 `entry !== undefined && entry.n > 0`。这条契约的失效方向**全是
 * 静默的**：
 *
 *   1. 读端漏判 ⇒ 用户刚点下的「允许」被 `decide()` 里的 `if (signal?.aborted) return 'cancelled'`
 *      静默丢弃，worker 重发同一条命令、弹出逐字相同的第二张卡 —— 没有任何报错；
 *   2. 读端写宽（把正常路径也跳过）⇒ 纠错变慢，「steer 立即生效」这条承诺消失，同样没有报错；
 *   3. 看门狗写宽 ⇒ 所有停滞都被放过，父会话永远收不到唤醒。
 *
 * 所以这组用例是**成对**的：A1 / A3 断言「该跳过时跳过」，A2 / A4 断言「其余一律照旧」。
 * 只有一半的用例集是危险的 —— 它会把「关掉整条路径」判成满分，A2 / A4 就是防那一手。
 *
 * ── 时间尺度 ─────────────────────────────────────────────────────────────────
 *
 * 看门狗用 `stallTimeoutMs: 120, tickMs: 10`、观察窗 400ms，与 `subagent-watchdog.mjs` 同款
 * （那里解释了为什么不往下调：毫秒级定时器的一次调度漂移就能吃掉小余量）。整套 < 1.5s。
 *
 * ── 它不碰任何东西 ───────────────────────────────────────────────────────────
 *
 * 假 ctx（`on` / `emit` / `get` / `logger`）、假 `agents`（一个 `Map`）、假 `subagents`
 * （记录 `interrupt` 入参）。不起会话、不加载 DSH、不读环境变量、不写文件。
 * 唯一一次 `node:fs` 读取是 A5 的静态钉子（只读本仓库自己的源码）。
 *
 * @module dsh-multitask/test/approval-wait-registry
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply as applyInterruptBeforeSend } from '../../presets/multitask/interrupt-before-send.mjs'
import {
  apply as applyWatchdog,
  ENGAGED_MARKER,
  SKIPPED_MARKER,
  STALLED_MARKER,
} from '../../presets/multitask/subagent-watchdog.mjs'

/**
 * 登记表的全局键名 —— 跨文件契约的**字面量**。
 *
 * 刻意不从实现里 import：本仓库的预设模块「零 import」，且这个键是**三份自带副本**的
 * 独立字面量。测试里再写第四份，等于把契约的三种写法都钉在同一个字符串上（A5 逐文件比对）。
 */
const APPROVAL_WAIT_KEY = 'dsh-multitask:approval-wait:v1'

/**
 * `interrupt-before-send.mjs` 的两条日志标识。
 *
 * 该模块**没有**导出 marker 常量（运行时导出面只有 `apply` / `inject` / `name`），
 * 所以这里用字面量 —— 而不是为了测试去改实现文件加 export。
 */
const STEER_SKIPPED_MARKER = 'MULTITASK-STEER-INTERRUPT-SKIPPED'
const STEER_ENGAGED_MARKER = 'MULTITASK-STEER-INTERRUPT-ENGAGED'

/** 看门狗配置：与 `subagent-watchdog.mjs` 的 W1 完全一致（120ms 算停滞，10ms 巡一次）。 */
const WATCHDOG_CONFIG = { enabled: true, presetId: 'multitask', stallTimeoutMs: 120, tickMs: 10 }

const results = []

/**
 * 跑一条异步用例并记录。
 *
 * ⚠️ 本文件每条用例都要 `await`（A3 / A4 还在等定时器），所以只能有异步版本：
 * 拿同步 `try { fn() } catch` 包异步函数只会拿到一个 pending Promise，于是**每条都记成通过**。
 *
 * @param title - 用例名。
 * @param fn - 异步断言体；reject 即算失败。
 */
async function testAsync(title, fn) {
  try {
    await fn()
    results.push({ title, ok: true })
    console.log(`  PASS  ${title}`)
  } catch (error) {
    results.push({ title, ok: false, message: error?.message ?? String(error) })
    console.log(`  FAIL  ${title}\n        ${error?.message ?? error}`)
  }
}

/** 最小断言（本仓库刻意不用 `node:assert`：少一处依赖）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 等一会儿（只用于看门狗的两个时间相关用例）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 清掉登记表 —— 每条用例收尾必做，否则残留会让**对照组**静默变绿。 */
function clearApprovalWait() {
  delete globalThis[APPROVAL_WAIT_KEY]
}

/**
 * 写入登记表（只允许测试这样做；实现里只有 `approval-gate.mjs` 是写入方）。
 *
 * @param entries - `[id, entry]` 数组。
 */
function setApprovalWait(entries) {
  globalThis[APPROVAL_WAIT_KEY] = new Map(entries)
}

/**
 * 造一个假 ctx —— 同时满足两个模块的取用面。
 *
 * `interrupt-before-send` 只用 `on` / `get('subagents')` / `logger`；
 * `subagent-watchdog` 另外要 `get('agents')` 与 `emit('dispose')`。
 *
 * @param options.withSubagents - 是否提供 `subagents` 服务（缺省提供）。
 * @returns 假 ctx（含 `agents` 表、`interrupts` 记录、`log` 记录、`handlers` 注册表）。
 */
function makeCtx({ withSubagents = true } = {}) {
  /** @type {Map<string, Array<Function>>} */
  const listeners = new Map()
  /** 假 `agents` 服务：会话 / agent id -> agent。 */
  const agents = new Map()
  /** `interrupt()` 的每一次入参（顺序即调用顺序）。 */
  const interrupts = []
  /** 日志分流记录；`all` 是**按时间顺序**的合集（本文件的所有日志断言都看它）。 */
  const log = { info: [], warn: [], all: [] }

  const record = (bucket, message) => {
    const text = String(message)
    log[bucket].push(text)
    log.all.push(text)
  }

  return {
    agents,
    interrupts,
    log,
    /** 注册表原文（event -> handler 数组）；瀑布类用例要直接取出 handler 调。 */
    handlers: listeners,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      // 复制一份再遍历：处理器里若又 `on` 同一个事件，不会把本次遍历搞成无限循环。
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    get(service) {
      if (service === 'agents') return { get: (id) => agents.get(id) }
      if (service === 'subagents') {
        if (!withSubagents) return undefined
        return {
          interrupt(id, options) {
            interrupts.push({ id, options })
          },
        }
      }
      return undefined
    },
    logger: {
      info: (message) => record('info', message),
      warn: (message) => record('warn', message),
      debug: () => {},
    },
  }
}

/**
 * 造一个假 agent。
 *
 * ⚠️ 会话头必须**不带** `origin` / `parentSession` / `delegationDepth`：三者任一成立就会命中
 * `isDelegatedChild`，`interrupt-before-send` 会走**方向闸门**整条放过 —— A1 / A2 会因此
 * 变成永绿（断电的用例最难看出来的就是这一种）。
 *
 * @param id - 会话 id。
 * @returns agent 替身。
 */
function fakeAgent(id) {
  return { id, session: { header: {} } }
}

/** 协调者（不是被委派子代理 —— 方向闸门必须放它进主路径）。 */
const COORDINATOR = fakeAgent('coordinator-1')

/**
 * 造一个假的父 agent（协调者），带**活绑定** preset。
 *
 * @param id - 会话 id。
 * @param preset - `composedPreset()` 的返回值（看门狗的归属判据）。
 * @returns 假 agent。
 */
function makeParent(id, preset = 'multitask') {
  return {
    session: { id, header: { agentPreset: preset } },
    ctx: { get: (service) => (service === 'agentPresets' ? { composedPreset: () => preset } : undefined) },
  }
}

/**
 * 造一个假的被委派子代理。
 *
 * @param id - 会话 id（看门狗的在册键、也是 `interrupt` 的目标 id）。
 * @param parentId - 父会话 id。
 * @returns 假 agent。
 */
function makeChild(id, parentId) {
  return {
    session: { id, header: { origin: 'subagent', parentSession: parentId } },
    // 子代理自己的 scope 不提供 preset 注册表 —— 归属只能由父侧决定。
    ctx: {},
  }
}

/**
 * 取出 `tools/pre-execute` 的处理器（找不到或数量不对就立刻红）。
 *
 * `tools/pre-execute` 是**瀑布**（`(exec, next)`），返回值只有直接调 handler 才看得见。
 *
 * @param ctx - 假 ctx。
 * @returns 处理器。
 */
function preExecuteHandler(ctx) {
  const list = ctx.handlers.get('tools/pre-execute') ?? []
  assert(
    list.length === 1,
    `tools/pre-execute 的处理器应当恰好注册 1 个，实际 ${list.length} 个 —— 本用例要直接调它`,
  )
  return list[0]
}

/**
 * 跑一次 pre-execute，把 `next()` 也记进**同一个**调用数组（顺序与次数都能断言）。
 *
 * @param handler - 处理器。
 * @param exec - 工具执行输入。
 * @param calls - 顺序记录数组。
 * @returns 处理器的返回值。
 */
async function runPre(handler, exec, calls) {
  return await handler(exec, async () => {
    calls.push({ kind: 'next' })
    return { kind: 'allow' }
  })
}

/**
 * 模拟一条「协调者 → 某个子代理」的 send_message。
 *
 * @param targetId - 收件人 id。
 * @returns `{ calls, out }`：调用顺序记录与返回值。
 */
async function steer(targetId) {
  const ctx = makeCtx()
  applyInterruptBeforeSend(ctx, { enabled: true })
  const calls = []
  const out = await runPre(
    preExecuteHandler(ctx),
    { name: 'send_message', agent: COORDINATOR, arguments: { agent_id: targetId, message: 'steer' } },
    calls,
  )
  return { ctx, calls, out }
}

/** 装机前先清一遍：外面若残留一份表，A2 / A4 会在不知不觉中被跳过。 */
clearApprovalWait()

console.log('\n===== approval-wait 登记表跨模块契约校验（进程内 / 零依赖）=====')

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 1. 该跳过时真的跳过（interrupt-before-send）---')
// ─────────────────────────────────────────────────────────────────────────────

await testAsync('A1 ★ 目标正等审批 ⇒ interrupt 0 次、next() 恰好一次、日志留 SKIPPED reason=awaiting-approval', async () => {
  setApprovalWait([['agent-x', { n: 1, at: Date.now() }]])
  try {
    const { ctx, calls, out } = await steer('agent-x')

    assert(
      ctx.interrupts.length === 0,
      `目标正等着一张审批卡时仍调用了 interrupt ${ctx.interrupts.length} 次 —— ` +
        '那会让 decide() 开头的 `if (signal?.aborted) return \'cancelled\'` 命中，' +
        '用户刚点下的「允许」被静默丢弃，worker 重发同一条命令、弹出逐字相同的第二张卡',
    )
    const nextCalls = calls.filter((call) => call.kind === 'next')
    assert(
      nextCalls.length === 1,
      `next() 应当恰好被调用 1 次（消息必须照常送达），实际 ${nextCalls.length} 次`,
    )
    assert(
      out?.kind === 'allow',
      `返回值应当是下游的 {kind:'allow'}（本模块不改写返回值），实际 ${JSON.stringify(out)}`,
    )
    const skipped = ctx.log.all.filter((line) => line.includes(STEER_SKIPPED_MARKER))
    assert(
      skipped.some((line) => line.includes('reason=awaiting-approval')),
      `日志里没有带 reason=awaiting-approval 的 ${STEER_SKIPPED_MARKER} —— ` +
        `「为什么没中断」必须可 grep，否则与「没判出目标」无法区分。实际日志：${JSON.stringify(ctx.log.all)}`,
    )
  } finally {
    clearApprovalWait()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. 对照组：除「正等审批」以外一律照旧中断（防「关掉正常路径」）---')
// ─────────────────────────────────────────────────────────────────────────────

const CONTROL_VARIANTS = [
  {
    label: '表根本不存在',
    setup: () => clearApprovalWait(),
  },
  {
    label: '表存在但没有该 id',
    setup: () => setApprovalWait([['somebody-else', { n: 1, at: Date.now() }]]),
  },
  {
    label: '该 id 的 n === 0（一次审批都没在等）',
    setup: () => setApprovalWait([['agent-x', { n: 0, at: Date.now() }]]),
  },
]

await testAsync('A2 ★ 对照组 3 个变体 ⇒ interrupt 各 1 次、目标 id 正确、日志留 ENGAGED', async () => {
  for (const variant of CONTROL_VARIANTS) {
    variant.setup()
    try {
      const { ctx, calls, out } = await steer('agent-x')

      assert(
        ctx.interrupts.length === 1,
        `[${variant.label}] interrupt 应当恰好 1 次，实际 ${ctx.interrupts.length} 次 —— ` +
          '跳过逻辑写宽了就等于关掉了 steer 的即时生效（本组就是防这个）',
      )
      assert(
        ctx.interrupts[0].id === 'agent-x',
        `[${variant.label}] 中断目标不对：${JSON.stringify(ctx.interrupts[0].id)}，应当是 "agent-x"`,
      )
      assert(
        ctx.interrupts[0].options?.kind === 'ancestor',
        `[${variant.label}] authority 应当是 ancestor，实际 ${JSON.stringify(ctx.interrupts[0].options?.kind)}`,
      )
      assert(
        ctx.log.all.some((line) => line.includes(STEER_ENGAGED_MARKER)),
        `[${variant.label}] 日志里没有 ${STEER_ENGAGED_MARKER} —— 无法确认中断真的发生`,
      )
      assert(
        calls.filter((call) => call.kind === 'next').length === 1 && out?.kind === 'allow',
        `[${variant.label}] 发送必须照常发生：next() 一次 + 返回值透传`,
      )
    } finally {
      clearApprovalWait()
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. 看门狗：该跳过时跳过 ---')
// ─────────────────────────────────────────────────────────────────────────────

await testAsync('A3 ★ 在册 worker 正等审批 ⇒ interrupt 0 次、无 STALLED、有 reason=awaiting-approval', async () => {
  setApprovalWait([['session-child', { n: 1, at: Date.now() }]])
  const ctx = makeCtx()
  try {
    applyWatchdog(ctx, WATCHDOG_CONFIG)

    const parent = makeParent('session-parent')
    const child = makeChild('session-child', 'session-parent')
    ctx.agents.set('session-parent', parent)

    ctx.emit('agent/created', { agent: parent })
    ctx.emit('agent/created', { agent: child })

    // 120ms 阈值 + 10ms 巡检 ⇒ 判据在 130ms 上下拍板；400ms 观察窗留约 3 倍余量。
    await sleep(400)

    // 先证明这个 worker 真的**在册**：否则「没被判停滞」可能只是「压根没被看」——永绿的假象。
    assert(
      ctx.log.all.some((line) => line.includes(ENGAGED_MARKER)),
      `日志里没有 ${ENGAGED_MARKER} —— 这个 worker 根本没被纳入在册，本用例等于没测`,
    )
    assert(
      ctx.interrupts.length === 0,
      `正等审批的 worker 被 interrupt ${ctx.interrupts.length} 次 —— ` +
        '等审批时 `at` 不会被刷新（那张卡本身就是一次工具调用的中间态），' +
        '所以它和真的卡死在时间戳上长得一模一样；中断它等于丢掉用户那次点击',
    )
    assert(
      !ctx.log.all.some((line) => line.includes(STALLED_MARKER)),
      `日志里出现了 ${STALLED_MARKER} —— 「正等审批」不得被判成停滞：` +
        '两条事实混在一起会让运维去查一个并不存在的卡死',
    )
    const skipped = ctx.log.all.filter((line) => line.includes(SKIPPED_MARKER))
    assert(
      skipped.some((line) => line.includes('reason=awaiting-approval')),
      `日志里没有带 reason=awaiting-approval 的 ${SKIPPED_MARKER} —— ` +
        `「为什么这一轮什么都没做」必须留痕。实际日志：${JSON.stringify(ctx.log.all)}`,
    )
  } finally {
    clearApprovalWait()
    // 10ms 的 setInterval 必须停掉，否则进程挂在这里不退出。
    ctx.emit('dispose')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 4. 看门狗对照组：不在表里的 worker 照停 ---')
// ─────────────────────────────────────────────────────────────────────────────

await testAsync('A4 ★ 不在表里的 worker 停滞 ⇒ interrupt 1 次、目标正确、日志含 STALLED', async () => {
  clearApprovalWait()
  const ctx = makeCtx()
  try {
    applyWatchdog(ctx, WATCHDOG_CONFIG)

    const parent = makeParent('session-parent')
    const child = makeChild('session-child', 'session-parent')
    ctx.agents.set('session-parent', parent)

    ctx.emit('agent/created', { agent: parent })
    ctx.emit('agent/created', { agent: child })

    await sleep(400)

    assert(
      ctx.interrupts.length === 1,
      `期望 interrupt 恰好 1 次，实际 ${ctx.interrupts.length} 次 —— ` +
        '停滞判定被审批表的判据误伤（读端写宽），父会话就永远收不到唤醒',
    )
    assert(
      ctx.interrupts[0].id === 'session-child',
      `interrupt 的目标是 ${JSON.stringify(ctx.interrupts[0].id)}，应当是 "session-child"`,
    )
    assert(
      ctx.log.all.some((line) => line.includes(STALLED_MARKER)),
      `日志里没有 ${STALLED_MARKER} —— 停滞的判定必须留痕，否则无从 grep`,
    )
  } finally {
    clearApprovalWait()
    ctx.emit('dispose')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 5. 静态钉子：三个模块各自持有逐字相同的键名 ---')
// ─────────────────────────────────────────────────────────────────────────────

await testAsync('A5 ★ 三个 presets/multitask/*.mjs 里都能逐字找到同一行 APPROVAL_WAIT_KEY', () => {
  const nail = `const APPROVAL_WAIT_KEY = 'dsh-multitask:approval-wait:v1'`
  const files = ['approval-gate.mjs', 'interrupt-before-send.mjs', 'subagent-watchdog.mjs']
  for (const file of files) {
    const path = fileURLToPath(new URL(`../../presets/multitask/${file}`, import.meta.url))
    const source = fs.readFileSync(path, 'utf8')
    assert(
      source.includes(nail),
      `${file} 里找不到这一行：\n  ${nail}\n` +
        '本仓库约定零 import，键名靠三份**独立字面量**对齐：任何一处拼错，' +
        '这一端就会永远读不到表（读不到 = 永远不跳过），而且不会报错',
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok)
console.log(
  `\napproval-wait 登记表契约：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const entry of failed) console.log(`  - ${entry.title}: ${entry.message}`)
  process.exitCode = 1
}
