/**
 * 「转呈挂起等父会话下一个 open turn」的探针（进程内、零依赖、不加载 DSH）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `approval.request()` 的第一行是 `if (!hasOpenTurn(session)) throw …`，而本 preset 的
 * 协调者人格要求「等待时结束回合」。两条叠起来的后果是：**只要子代理在协调者不在回合内
 * 的时候请求审批，转呈就必然失败**，而父会话真正长时间开着回合的时刻是**用户下一条消息
 * 到达之后** —— 可能是几分钟后。
 *
 * 上一版只等 10 秒，于是「用户回来之前攒下的审批」全部落到子会话里。现在改成**挂起**：
 * 保留那次请求（子代理的工具调用继续阻塞），监听父会话的下一个 `turn/start`，醒来后
 * **再验一次日志**才重新转呈，并且有时间的上限与次数的上限。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────────────────
 *
 * `approval-gate-integration.mjs` 的替身 `ctx` 只能**记录**监听器，不能**派发**事件 ——
 * 而这条修复的核心机制正是「收到 `session/event` 上的 `turn/start`」。把这个能力塞进
 * 那个文件会让它所有既有用例的替身一起变形（那是几十条已经定稿的断言），所以这里另起
 * 一份带派发器的替身，只钉这条链。
 *
 * @module dsh-multitask/docs/test/approval-relay-wait
 */
import { apply } from '../../presets/multitask/approval-gate.mjs'

const results = []

/** 跑一条异步用例并记录（与同目录其余探针同形状）。 */
async function testAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/** 最小断言（本仓库刻意不用 `node:assert`）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 等 `ms` 毫秒（只用于「等了这么久之后仍然挂着」这类判据）。 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

// ── 替身 ─────────────────────────────────────────────────────────────────────

/**
 * 造一个**可派发**的假 ctx。
 *
 * `on()` 记录监听器并返回**真的能注销**的 disposer —— 这一点是必需的：本组用例要证明
 * 「挂起收尾之后不再有监听器」，而一个永远返回 `() => {}` 的替身会让那条断言恒真。
 *
 * @param options - `{ services }`。
 * @returns `{ ctx, handlers, logs }`。
 */
function fakeCtx(options = {}) {
  const logs = { info: [], warn: [] }
  const services = options.services ?? {}
  const handlers = []
  const ctx = {
    on(event, handler, onOptions) {
      const entry = { event, handler, opts: onOptions }
      handlers.push(entry)
      return () => {
        const at = handlers.indexOf(entry)
        if (at < 0) return false
        handlers.splice(at, 1)
        return true
      }
    },
    get(name) {
      return services[name]
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
  }
  return { ctx, handlers, logs }
}

/**
 * 把某个事件派发给所有已注册的监听器（快照遍历：监听器可以在回调里注销自己）。
 *
 * @param handlers - `fakeCtx()` 记录的监听器表。
 * @param event - 事件名。
 * @param args - 派发参数。
 */
function dispatch(handlers, event, ...args) {
  for (const entry of [...handlers]) {
    if (entry.event !== event) continue
    entry.handler(...args)
  }
}

/** 当前还挂着几个某事件的监听器（用来钉住「收尾之后没有泄漏」）。 */
function countHandlers(handlers, event) {
  return handlers.filter((entry) => entry.event === event).length
}

/**
 * 造一个假 session（`seq` / `eventAt` 照抄上游：`seq` 是日志长度，`eventAt(seq)` 是 `log[seq]`）。
 *
 * @param options - `{ id, cwd, origin, parentSession, delegationDepth }`。
 * @returns 会话替身。
 */
function fakeSession(options = {}) {
  const log = []
  const appends = []
  const header = { id: options.id ?? 'sess-1' }
  if (options.cwd !== undefined) header.cwd = options.cwd
  if (options.origin !== undefined) header.origin = options.origin
  if (options.parentSession !== undefined) header.parentSession = options.parentSession
  if (options.delegationDepth !== undefined) header.delegationDepth = options.delegationDepth
  return {
    id: header.id,
    header,
    log,
    appends,
    get seq() {
      return log.length
    },
    eventAt(seq) {
      return log[seq]
    },
    append(type, data) {
      appends.push({ type, data })
    },
  }
}

/** 往会话日志里追加一个事件（只影响 `eventAt` / `seq`，不进 `appends`）。 */
function pushEvent(session, type) {
  session.log.push({ type })
}

/** 照抄上游 `hasOpenTurn`：从日志尾部倒序扫，`turn/start` 为真、`turn/end` 为假。 */
function turnOpenOf(session) {
  for (let seq = session.log.length - 1; seq >= 0; seq -= 1) {
    const type = session.log[seq].type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/** 造一个假 agent。 */
function fakeAgent(session) {
  return {
    id: session.id,
    session,
    ctx: {
      on() {
        return () => {}
      },
      systemPrompt: { getContextOrder: () => 0 },
      tools: {},
    },
  }
}

/**
 * 造一个**照抄上游语义**的假 approval：父会话没有打开回合时 `request()` 抛原文错误。
 *
 * 这一点很关键 —— 判据必须来自「父会话的日志」，否则「挂起期间不能成功、唤醒之后才能
 * 成功」这条链在测试里就是我自己摆出来的，而不是被模块的判据逼出来的。
 *
 * @returns approval 替身（含 `requests` 调用记录）。
 */
function fakeApproval(outcome = 'allowed-once') {
  const requests = []
  return {
    requests,
    effectivePolicy(session) {
      return session?.header?.approvalPolicy ?? 'ask'
    },
    async request(req) {
      requests.push(req)
      if (!turnOpenOf(req.agent.session)) {
        throw new Error(
          'approval.request() outside an open turn: the approval/asked + approval/decided audit pair ' +
            'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). ' +
            'Ask from inside the turn that needs the decision.',
        )
      }
      return outcome
    },
  }
}

/** 造一个假 `subagents`（兜底通知用的消息通道）。 */
function fakeSubagents() {
  const sent = []
  return {
    sent,
    async sendMessage(sender, targetId, content, options) {
      sent.push({ sender, targetId, content, options })
      return 'message-id-1'
    },
  }
}

/**
 * 标准场景：父会话回合**关着**（协调者已结束回合），子代理请求审批。
 *
 * @returns 场景部件。
 */
function scene() {
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({
    id: 'child-1',
    cwd: 'H:\\proj',
    origin: 'subagent',
    parentSession: 'parent-1',
    delegationDepth: 1,
  })
  // 「协调者派完单就不等了」⇒ 父会话的回合此刻是关着的。这就是真实形态。
  pushEvent(parentSession, 'turn/end')
  const parent = fakeAgent(parentSession)
  const child = fakeAgent(childSession)
  const approvals = fakeApproval()
  const subs = fakeSubagents()
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
    subagents: subs,
  }
  return { parent, child, parentSession, childSession, approvals, subs, services }
}

/**
 * 装好模块并取出转呈监听器。
 *
 * @param config - 传给 `apply` 的配置。
 * @returns 场景 + `{ relay, handlers, logs }`。
 */
function setup(config) {
  const parts = scene()
  const { ctx, handlers, logs } = fakeCtx({ services: parts.services })
  apply(ctx, config)
  const entry = handlers.find((h) => h.event === 'approval/request')
  assert(entry !== undefined, '模块没有注册 approval/request 监听器')
  return { ...parts, relay: entry.handler, handlers, logs }
}

/**
 * 启动一次转呈（**不** await：本组用例要观察「它还挂着」）。
 *
 * @param relay - 转呈监听器。
 * @param request - 审批请求。
 * @returns 可观察的状态对象（`settled` / `outcome` / `nextCalls` / `done`）。
 */
function startRelay(relay, request) {
  const state = { settled: false, outcome: undefined, nextCalls: 0, done: undefined }
  state.done = relay(request, async () => {
    state.nextCalls += 1
    return 'next-result'
  }).then((outcome) => {
    state.settled = true
    state.outcome = outcome
  })
  return state
}

/**
 * 让父会话开一个回合：**既写日志也派事件** —— 真实上游就是这两件事一起发生。
 *
 * @param parts - `{ parentSession, handlers }`。
 */
function openParentTurn(parts) {
  pushEvent(parts.parentSession, 'turn/start')
  dispatch(parts.handlers, 'session/event', parts.parentSession, { type: 'turn/start' })
}

/** 让父会话的回合结束（只写日志：回合结束不派任何需要本模块监听的事件）。 */
function closeParentTurn(parts) {
  pushEvent(parts.parentSession, 'turn/end')
}

console.log('===== dsh-multitask 审批转呈「挂起等下一个 open turn」探针（进程内 / 零依赖）=====')

// ── 一、挂起：不再 10 秒后放弃 ───────────────────────────────────────────────
console.log('\n--- 1. 挂起：转呈失败后保留请求，等父会话的下一个 open turn ---')

await testAsync('W1 ★ 默认上限是 10 分钟（不是上一版的 10 秒），且失败后进入挂起而不是放弃', async () => {
  const parts = setup({ enabled: true })
  const state = startRelay(parts.relay, { agent: parts.child, toolName: 'pwsh' })

  await delay(400)

  assert(state.settled === false, '400ms 后就返回了 —— 说明它没有挂起，仍在按旧窗口放弃')
  assert(state.nextCalls === 0, '挂起期间不该退回下游（那会把请求甩给用户看不见的子会话）')
  assert(parts.approvals.requests.length === 1, `应当只有首次那次失败，实际 ${parts.approvals.requests.length} 次`)
  assert(parts.subs.sent.length === 1, '挂起之前必须先发出那条兜底通知（它是唤醒父会话的唯一手段）')

  const park = parts.logs.info.find((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-PARK-ENTER'))
  assert(park !== undefined, '挂起要留一条可 grep 的 PARK-ENTER')
  assert(park.includes('600000'), `默认上限必须是 10 分钟（600000ms），实际日志：${park}`)

  // 挂起期间**不**在跨模块登记表里占位：那张表是给「卡已经在等用户」用的，
  // 挂起期间还没有卡，占位会让 watchdog 在整个等待里都不判停滞。
  const table = globalThis['dsh-multitask:approval-wait:v1']
  assert(
    !(table instanceof Map) || table.get('child-1') === undefined,
    '挂起期间不该往 approval-wait 登记表里占位（那会让 watchdog 在整个等待里失明）',
  )

  // 收尾：让它真的走完一次成功路径，免得留下 10 分钟的定时器。
  openParentTurn(parts)
  await state.done
  assert(state.outcome === 'allowed-once', `唤醒之后应当拿到真实裁决，实际 ${String(state.outcome)}`)
})

// ── 二、唤醒 → 重试 → 子代理拿到真实裁决 ─────────────────────────────────────
console.log('\n--- 2. 唤醒：父会话的下一个 turn/start 会触发重试 ---')

await testAsync('W2 ★ 父会话开回合之后自动重试一次，子代理拿到真实裁决（不再是 next() 兜底）', async () => {
  const parts = setup({ enabled: true, relayRetryWindowMs: 60000 })
  const state = startRelay(parts.relay, { agent: parts.child, toolName: 'pwsh', callId: 'call-7', reason: 'write outside the workspace' })

  await delay(200)
  assert(state.settled === false, '父会话还没开回合，不该已经返回')
  assert(parts.approvals.requests.length === 1, '此时应当只失败过一次')

  openParentTurn(parts)
  await state.done

  assert(state.outcome === 'allowed-once', `应当把父会话的裁决原样返回，实际 ${String(state.outcome)}`)
  assert(state.nextCalls === 0, '已经拿到裁决时不该再退回下游')
  assert(parts.approvals.requests.length === 2, `应当恰好两次 request（原次失败 + 唤醒后重试），实际 ${parts.approvals.requests.length} 次`)
  assert(parts.approvals.requests[1].agent === parts.parent, '重试仍然必须打到父会话上')

  // 载荷必须与原次**逐字相同** —— 否则用户会在不同时机看到不同措辞的卡。
  const [first, second] = parts.approvals.requests
  assert(first.reason === second.reason, `reason 必须逐字一致：\n  首次：${first.reason}\n  重试：${second.reason}`)
  assert(
    JSON.stringify(first.displayReason) === JSON.stringify(second.displayReason),
    'displayReason 必须逐字一致（两处各写一份文案时最容易漂移的就是它）',
  )
  assert(first.callId === second.callId, 'callId 必须沿用（面板靠它关联那次调用）')

  // 「挂起 → 唤醒 → 重试 → 成功」四步都要能在日志里 grep 出来。
  for (const marker of [
    'MULTITASK-APPROVAL-RELAY-RETRY-PARK-ENTER',
    'MULTITASK-APPROVAL-RELAY-RETRY-PARK-WAKE reason=turn-start',
    'MULTITASK-APPROVAL-RELAY-RETRY-RETRIED',
    'MULTITASK-APPROVAL-RELAY-RETRY-PARK-EXIT reason=relayed',
  ]) {
    assert(
      parts.logs.info.some((m) => m.includes(marker)),
      `日志里找不到 ${marker} —— 这条链必须逐步可诊断`,
    )
  }
  // 收尾之后监听器必须全部摘掉（否则每挂起一次就多留两个）。
  assert(countHandlers(parts.handlers, 'session/event') === 0, '收尾之后 session/event 监听器必须已注销')
  assert(countHandlers(parts.handlers, 'agent/disposed') === 0, '收尾之后 agent/disposed 监听器必须已注销')
})

await testAsync('W3 ★ 回合开了又关：醒来后**再验一次**，验不过就继续挂起（不盲问）', async () => {
  const parts = setup({ enabled: true, relayRetryWindowMs: 60000 })
  const state = startRelay(parts.relay, { agent: parts.child, toolName: 'pwsh' })

  await delay(150)

  // 父会话开了回合、随即又结束（协调者读完通知就回复了）—— 这正是最常见的真实形态。
  openParentTurn(parts)
  closeParentTurn(parts)
  await delay(150)

  assert(state.settled === false, '回合已经关了，不该贸然去问（那会再撞一次守卫）')
  assert(parts.approvals.requests.length === 1, `验不过就不该重试，实际 ${parts.approvals.requests.length} 次`)
  assert(
    parts.logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-PARK-EXIT reason=turn-closed-again')),
    '这一支要留可 grep 的收尾记录（否则「为什么没问」与「为什么卡住」分不开）',
  )

  // 第二个回合：这次真的开着，应当重试成功。
  openParentTurn(parts)
  await state.done
  assert(state.outcome === 'allowed-once', `第二个回合应当重试成功，实际 ${String(state.outcome)}`)
  assert(parts.approvals.requests.length === 2, `应当恰好重试一次，实际 ${parts.approvals.requests.length} 次`)
})

// ── 三、超时：走兜底通知，且不重复通知、不泄漏状态 ───────────────────────────
console.log('\n--- 3. 超时：有界，且有界之后什么都不再发生 ---')

await testAsync('W4 ★ 等满上限：退回原路径 + 只发一条通知，之后不再重试（不泄漏状态）', async () => {
  const parts = setup({ enabled: true, relayRetryWindowMs: 150 })
  const state = startRelay(parts.relay, { agent: parts.child, toolName: 'pwsh' })

  await state.done

  assert(state.outcome === 'next-result', '等不到时必须退回下游（绝不能把一次拒绝变成放行）')
  assert(state.nextCalls === 1, '应当恰好走一次下游')
  assert(parts.approvals.requests.length === 1, '超时之后不该有第二次 request')
  assert(parts.subs.sent.length === 1, `兜底通知必须恰好一条，实际 ${parts.subs.sent.length} 条`)
  assert(
    parts.logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-FAILED reason=window-elapsed')),
    '超时要点名原因（它是「为什么卡片还是没出现」的答案）',
  )
  assert(
    parts.logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-PARK-EXIT reason=timeout')),
    '超时要留可 grep 的收尾记录',
  )

  // ⚠️ 这一段是「不泄漏」的实质：超时之后父会话**再**开回合，本模块不该再动作。
  openParentTurn(parts)
  closeParentTurn(parts)
  await delay(200)

  assert(parts.approvals.requests.length === 1, '超时之后父会话再开回合，不该再发起 request（监听器必须已摘掉）')
  assert(parts.subs.sent.length === 1, '不该重复通知（那会把用户骗去看一张不存在的卡）')
  assert(state.nextCalls === 1, '不该再走一次下游')
  assert(countHandlers(parts.handlers, 'session/event') === 0, '超时之后 session/event 监听器必须已注销')
})

// ── 四、abort：挂起的请求被干净清理 ──────────────────────────────────────────
console.log('\n--- 4. abort：挂起期间被中止，干净退出 ---')

await testAsync('W5 ★ 挂起期间请求被 abort：立即收尾，登记表与监听器都不留残留', async () => {
  const parts = setup({ enabled: true, relayRetryWindowMs: 60000 })
  const controller = new AbortController()
  const state = startRelay(parts.relay, { agent: parts.child, toolName: 'pwsh', signal: controller.signal })

  await delay(150)
  assert(state.settled === false, 'abort 之前应当还挂着')

  controller.abort()
  await state.done

  assert(state.outcome === 'next-result', '被中止时要退回下游（上游会把 `cancelled` 结算掉）')
  assert(state.nextCalls === 1, '应当恰好走一次下游')
  assert(parts.approvals.requests.length === 1, '中止之后不该再发起 request')
  assert(
    parts.logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=signal-aborted')),
    '中止要留可 grep 的原因',
  )
  assert(
    parts.logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-PARK-EXIT reason=aborted')),
    '中止要留可 grep 的收尾记录',
  )
  assert(countHandlers(parts.handlers, 'session/event') === 0, '中止之后 session/event 监听器必须已注销')
  assert(countHandlers(parts.handlers, 'agent/disposed') === 0, '中止之后 agent/disposed 监听器必须已注销')

  const table = globalThis['dsh-multitask:approval-wait:v1']
  assert(
    !(table instanceof Map) || table.get('child-1') === undefined,
    '中止之后登记表里不许留下这个子代理的幽灵项（那会让两个 interrupt 方永远跳过它）',
  )

  // 中止之后父会话再开回合：不该复活那次请求。
  openParentTurn(parts)
  await delay(150)
  assert(parts.approvals.requests.length === 1, '中止之后父会话再开回合，不该复活那次转呈')
})

await testAsync('W6 父 agent 被释放：不再等满上限（那张卡已经没有地方可去）', async () => {
  const parts = setup({ enabled: true, relayRetryWindowMs: 60000 })
  const state = startRelay(parts.relay, { agent: parts.child, toolName: 'pwsh' })

  await delay(120)
  dispatch(parts.handlers, 'agent/disposed', { agent: parts.parent })
  await state.done

  assert(state.outcome === 'next-result', '父会话没了就只能退回下游')
  assert(state.nextCalls === 1, '应当恰好走一次下游')
  assert(
    parts.logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=parent-disposed')),
    '父会话被释放要留可 grep 的原因',
  )
  assert(countHandlers(parts.handlers, 'session/event') === 0, '收尾之后监听器必须已注销')
})

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\n转呈挂起探针：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
