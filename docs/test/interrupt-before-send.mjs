/**
 * interrupt-before-send 回归（进程内 / 零依赖）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `presets/multitask/interrupt-before-send.mjs` 在 `send_message` **执行之前**先调一次
 * `subagents.interrupt`，目的是让「纠错」立刻生效，而不是排在错误要求后面。
 *
 * 这条链上有四个方向都可能写反，而每一个写反都不报错、只表现为「纠错又变慢了」——
 * 那正是它要修的那个毛病，所以必须逐条钉住：
 *
 *   1. **顺序**：中断必须在 `next()`（真正发送）**之前**。反过来的话，消息已经进了
 *      队列再中断，等于什么都没做；
 *   2. **方向**：只拦「协调者 → 子代理」。worker 给父会话发汇报时必须原样通过 ——
 *      否则被停掉的是**主对话自己的回合**，用户正在看的回答会被掐断；
 *   3. **只拦 send_message**：别的工具一个都不许被碰到；
 *   4. **失败不改行为**：中断抛错、服务缺失、目标 id 读不出来时，发送必须照常发生。
 *      把「纠错稍晚」降级成「纠错没发出去」，方向正好反了。
 *
 * ── 为什么用「调用顺序」而不是「返回值」来断言 ───────────────────────────────
 *
 * 本模块对 `tools/pre-execute` 的返回值**不做任何修改**（它一律 `return await next()`）。
 * 于是「它有没有生效」在返回值上完全看不出来 —— 只能看副作用：`interrupt` 被调过没有、
 * 以及它是不是在 `next()` 之前。这一点如果不用测试钉住，未来有人把拦截写成
 * 「先 next() 再 interrupt」时，所有返回值断言都会照旧全绿。
 *
 * @module dsh-multitask/test/interrupt-before-send
 */
import { apply, name } from '../../presets/multitask/interrupt-before-send.mjs'

const results = []

/**
 * 跑一条**异步**用例并记录。
 *
 * ⚠️ 本套件里每一条都是异步的（都要 `await` 监听器），所以这里只能有异步版本。
 * 用一个同步的 `try { fn() } catch` 包异步函数是个**静默失效**的坑：它只拿到一个
 * pending Promise，于是每条断言都记成通过，哪怕里面炸了 —— 比没有测试更坏。
 *
 * @param title - 用例名。
 * @param fn - 异步断言体；reject 即算失败。
 */
async function testAsync(title, fn) {
  try {
    await fn()
    results.push({ name: title, ok: true })
    console.log(`  PASS  ${title}`)
  } catch (error) {
    results.push({ name: title, ok: false, message: error.message })
    console.log(`  FAIL  ${title}\n        ${error.message}`)
  }
}

/** 最小断言（本仓库刻意不用 `node:assert`：少一处依赖）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 造一个假 ctx。
 *
 * @param services - 要注入的服务（这里只用 `subagents`）。
 * @returns `{ ctx, handlers, logs }`。
 */
function fakeCtx(services = {}) {
  const handlers = []
  const logs = { info: [], warn: [] }
  const ctx = {
    on(event, handler, opts) {
      handlers.push({ event, handler, opts })
      return () => {}
    },
    get(serviceName) {
      return services[serviceName]
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
  }
  return { ctx, handlers, logs }
}

/**
 * 造一个假 agent。
 *
 * @param header - 会话头字段（`origin` / `parentSession` / `delegationDepth`）。
 * @returns agent 替身。
 */
function fakeAgent(header) {
  return { id: header?.id ?? 'agent-1', session: { header } }
}

/**
 * 造一个假 `subagents` 服务。
 *
 * `interrupt` 往 `calls` 里记一笔；`runPre` 会把 `next()` 也记进**同一个**数组，
 * 于是「谁先谁后」可以被直接断言。
 *
 * @param options - `{ throwOnInterrupt, hasInterrupt }`。
 * @returns 替身（含 `calls`）。
 */
function fakeSubagents(options = {}) {
  const calls = []
  const stub = {
    calls,
    interrupt(targetSessionId, authority) {
      calls.push({ kind: 'interrupt', targetSessionId, authority })
      if (options.throwOnInterrupt === true) throw new Error('not an ancestor')
    },
  }
  // 模拟「部署里的服务没有这个能力」：方法不存在。
  if (options.hasInterrupt === false) delete stub.interrupt
  return stub
}

/**
 * 取某个事件的 handler（找不到就抛，让用例立刻红）。
 *
 * @param handlers - `fakeCtx` 捕获的注册列表。
 * @returns 监听器。
 */
function preExecuteHandler(handlers) {
  const found = handlers.find((h) => h.event === 'tools/pre-execute')
  assert(found !== undefined, '本模块没有注册 tools/pre-execute —— 拦截不会发生')
  return found.handler
}

/**
 * 跑一次 pre-execute，把 `next()` 记进调用方给的 `calls`（与 interrupt 同一条时间线）。
 *
 * @param handler - 监听器。
 * @param exec - 工具执行输入。
 * @param calls - 顺序记录数组（通常是 `subagents.calls`）。
 * @returns 监听器的返回值。
 */
async function runPre(handler, exec, calls) {
  return await handler(exec, async () => {
    if (Array.isArray(calls)) calls.push({ kind: 'next' })
    return { kind: 'allow' }
  })
}

/** 协调者（不是子代理）。 */
const COORDINATOR = fakeAgent({ id: 'coordinator-1' })

/** 一个子代理。 */
const CHILD = fakeAgent({ id: 'child-1', origin: 'subagent', parentSession: 'coordinator-1', delegationDepth: 1 })

console.log('===== dsh-multitask interrupt-before-send 回归（进程内 / 零依赖）=====')

// ── 一、模块形状 ────────────────────────────────────────────────────────────
console.log('\n--- 1. 模块形状 ---')

await testAsync('S1 导出 name 与 apply，且 apply 注册了 tools/pre-execute', async () => {
  assert(name === 'multitask-interrupt-before-send', `name 不对：${name}`)
  const { ctx, handlers } = fakeCtx({ subagents: fakeSubagents() })
  apply(ctx, { enabled: true })
  preExecuteHandler(handlers)
})

await testAsync('S2 enabled: false 时完全不注册（可关闭）', async () => {
  const { ctx, handlers } = fakeCtx({ subagents: fakeSubagents() })
  apply(ctx, { enabled: false })
  assert(handlers.length === 0, `关闭后仍注册了 ${handlers.length} 个监听器`)
})

// ── 二、主路径：先中断，再发送 ──────────────────────────────────────────────
console.log('\n--- 2. 主路径：中断必须在发送之前 ---')

await testAsync('S3 ★ 协调者发 send_message：顺序是 interrupt → next，目标是消息的收件人', async () => {
  const subagents = fakeSubagents()
  const { ctx, handlers } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  const out = await runPre(
    preExecuteHandler(handlers),
    { name: 'send_message', agent: COORDINATOR, arguments: { agent_id: 'child-1', message: 'stop, wrong file' } },
    subagents.calls,
  )

  const order = subagents.calls.map((c) => c.kind).join(',')
  assert(
    order === 'interrupt,next',
    `调用顺序必须是 interrupt,next，实际 "${order}" —— ` +
      '先 next 再 interrupt 与不中断等价（消息已经排在错误要求后面了）',
  )
  const interruptCall = subagents.calls[0]
  assert(
    interruptCall.targetSessionId === 'child-1',
    `中断目标不对：${JSON.stringify(interruptCall.targetSessionId)}（应当等于消息的 agent_id）`,
  )
  assert(out?.kind === 'allow', '返回值必须原样透传（本模块不改变 send_message 的语义）')
})

await testAsync('S4 ★ authority 用 ancestor 形状，且携带发起调用的 agent', async () => {
  const subagents = fakeSubagents()
  const { ctx, handlers } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  await runPre(
    preExecuteHandler(handlers),
    { name: 'send_message', agent: COORDINATOR, arguments: { agent_id: 'child-1', message: 'x' } },
    subagents.calls,
  )

  const authority = subagents.calls[0]?.authority
  assert(authority?.kind === 'ancestor', `authority.kind 应当是 ancestor，实际 ${JSON.stringify(authority?.kind)}`)
  assert(authority?.agent === COORDINATOR, 'authority.agent 必须是发起这次调用的 agent —— 上游据它做血缘校验')
})

await testAsync('S5 目标 id 的所有别名都能认出来（与上游解析顺序一致）', async () => {
  for (const key of ['target', 'agent_id', 'sessionId', 'job_id']) {
    const subagents = fakeSubagents()
    const { ctx, handlers } = fakeCtx({ subagents })
    apply(ctx, { enabled: true })
    await runPre(
      preExecuteHandler(handlers),
      { name: 'send_message', agent: COORDINATOR, arguments: { [key]: `child-via-${key}`, message: 'x' } },
      subagents.calls,
    )
    assert(
      subagents.calls[0]?.targetSessionId === `child-via-${key}`,
      `参数名 ${key} 没有被识别为目标`,
    )
  }
})

// ── 三、方向闸门：worker → 父会话必须原样通过 ───────────────────────────────
console.log('\n--- 3. 方向闸门（写反了会掐断主对话自己的回合）---')

await testAsync('S6 ★ 子代理给父会话发汇报：一个字都不拦', async () => {
  const subagents = fakeSubagents()
  const { ctx, handlers } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  const out = await runPre(
    preExecuteHandler(handlers),
    { name: 'send_message', agent: CHILD, arguments: { agent_id: 'coordinator-1', message: 'progress report' } },
    subagents.calls,
  )

  assert(
    subagents.calls.every((c) => c.kind !== 'interrupt'),
    'worker 的汇报触发了中断 —— 被停掉的会是主对话自己的回合，用户正在看的回答会被掐断',
  )
  assert(out?.kind === 'allow', 'worker 的消息必须原样通过（返回值不得被改写）')
})

// ── 四、只拦 send_message ───────────────────────────────────────────────────
console.log('\n--- 4. 只拦 send_message，别的工具一概不碰 ---')

await testAsync('S7 别的工具即使参数里带 agent_id 也不中断', async () => {
  const subagents = fakeSubagents()
  const { ctx, handlers } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  for (const toolName of ['subagent', 'interrupt_agent', 'read', 'job_output', 'subagent_fork']) {
    await runPre(
      preExecuteHandler(handlers),
      { name: toolName, agent: COORDINATOR, arguments: { agent_id: 'child-1', message: 'x' } },
      subagents.calls,
    )
  }
  assert(
    subagents.calls.every((c) => c.kind !== 'interrupt'),
    `非 send_message 的工具触发了中断`,
  )
})

// ── 五、失败取向：绝不把「稍晚」变成「没发」 ─────────────────────────────────
console.log('\n--- 5. 失败取向：中断失败也必须照常发送 ---')

await testAsync('S8 ★ interrupt 抛错：发送照常发生，且只记 info（不刷 warn）', async () => {
  const subagents = fakeSubagents({ throwOnInterrupt: true })
  const { ctx, handlers, logs } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  const out = await runPre(
    preExecuteHandler(handlers),
    { name: 'send_message', agent: COORDINATOR, arguments: { agent_id: 'child-1', message: 'x' } },
    subagents.calls,
  )

  const order = subagents.calls.map((c) => c.kind).join(',')
  assert(order === 'interrupt,next', `中断抛错后仍必须继续发送，实际顺序 "${order}"`)
  assert(out?.kind === 'allow', '中断失败时发送必须照常进行 —— 否则「纠错稍晚」变成了「纠错没发出去」')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-STEER-INTERRUPT-FAILED')),
    '中断失败应当留一条可 grep 的 info',
  )
})

await testAsync('S9 服务没有 interrupt 方法：不中断、不抛错、告警只报一次', async () => {
  const subagents = fakeSubagents({ hasInterrupt: false })
  const { ctx, handlers, logs } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  for (let i = 0; i < 3; i += 1) {
    const out = await runPre(
      preExecuteHandler(handlers),
      { name: 'send_message', agent: COORDINATOR, arguments: { agent_id: 'child-1', message: 'x' } },
      subagents.calls,
    )
    assert(out?.kind === 'allow', '缺 interrupt 能力时消息必须照常通过')
  }
  assert(
    logs.info.some((m) => m.includes('MULTITASK-STEER-INTERRUPT-SKIPPED reason=no-interrupt-api')),
    '缺能力时应当留一条可 grep 的跳过标识',
  )
  const unavail = logs.warn.filter((m) => m.includes('no interrupt()'))
  assert(unavail.length === 1, `「没有 interrupt API」的告警应当只报一次，实际 ${unavail.length} 次`)
})

await testAsync('S10 取不到目标 id：不中断（宁可晚一点，也不靠猜去停一个会话）', async () => {
  const subagents = fakeSubagents()
  const { ctx, handlers, logs } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  const out = await runPre(
    preExecuteHandler(handlers),
    { name: 'send_message', agent: COORDINATOR, arguments: { message: 'x' } },
    subagents.calls,
  )

  assert(subagents.calls.every((c) => c.kind !== 'interrupt'), '没有目标 id 时不该中断')
  assert(out?.kind === 'allow', '没有目标 id 时消息必须照常通过')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-STEER-INTERRUPT-SKIPPED reason=no-target-id')),
    '缺目标 id 时应当留一条可 grep 的跳过标识',
  )
})

await testAsync('S11 畸形载荷不抛错（调用点依赖这条）', async () => {
  const subagents = fakeSubagents()
  const { ctx, handlers } = fakeCtx({ subagents })
  apply(ctx, { enabled: true })

  for (const exec of [undefined, null, {}, { name: 'send_message' }, { name: 'send_message', arguments: null }]) {
    const out = await runPre(preExecuteHandler(handlers), exec, subagents.calls)
    assert(out !== undefined, `畸形载荷应当原样放行，实际 ${JSON.stringify(out)}`)
  }
  assert(subagents.calls.every((c) => c.kind !== 'interrupt'), '畸形载荷不该触发中断')
})

await testAsync('S12 ctx.get 抛错时也不影响发送（服务层异常不能炸掉消息）', async () => {
  const { ctx, handlers, logs } = fakeCtx()
  ctx.get = () => {
    throw new Error('service registry is on fire')
  }
  apply(ctx, { enabled: true })

  const calls = []
  const out = await runPre(
    preExecuteHandler(handlers),
    { name: 'send_message', agent: COORDINATOR, arguments: { agent_id: 'child-1', message: 'x' } },
    calls,
  )
  assert(out?.kind === 'allow', 'ctx.get 抛错时仍必须让消息通过')
  assert(
    logs.warn.some((m) => m.includes('intercepting send_message failed')),
    '意外应当留一条 warn，但不得影响发送',
  )
})

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\ninterrupt-before-send 回归：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
