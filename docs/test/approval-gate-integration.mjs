/**
 * approval-gate 逻辑链集成探针（进程内、零依赖、不加载 DSH）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `approval-gate.mjs` 的全部价值都建立在几条**没写在它自己代码里**的上游事实上
 * （`overrideOf` 取最后一条、`agent/created` 晚于委派钉死、`ask` 决策的合法形状…）。
 * 那些事实无法在这里复现，但**本模块基于它们所作的决定**可以：
 *
 *   1. 门控方向 —— 父会话不是 `ask` 时**一个字都不能动**（这是红线：headless 部署靠
 *      `never` 保证不会被挂住等一个永远不来的答复）；
 *   2. 事件形状 —— 写进去的 `approval/policy` **必须省略 `source`**（校验只允许
 *      `source: 'delegation'`，而这不是委派继承来的）；返回的 `ask` 必须是
 *      `{ kind: 'ask', reason, displayReason }`；
 *   3. 转呈方向 —— 子代理的请求要落到**父会话**上，父会话自己的请求要原样放行，
 *      转呈失败要**退回原路径**（绝不能把一次拒绝悄悄变成放行）。
 *
 * 这些正是「改一处、坏一片」的地方：门控写反会把 headless 会话挂住；事件多写一个
 * `source` 会让 appends 直接抛错；转呈失败不退回会让工具调用悬着不返回。
 *
 * ── 它用什么替身 ─────────────────────────────────────────────────────────────
 *
 * 一个几百字节的假 `ctx` / 假 `approval` / 假 `agent`：只实现本模块**实际用到**的成员。
 * 这不是「模拟 DSH」，而是「用最小替身把调用点逼出来」—— 如果本模块用了替身没有的东西，
 * 那行会抛错，探针就红了（这本身也是有用信号：说明本模块依赖了预期之外的能力）。
 *
 * @module dsh-multitask/test/approval-gate-integration
 */
import { apply, classifyShellCommand, escapesWorkspace, isDelegatedChild } from '../../presets/multitask/approval-gate.mjs'

const results = []

/** 跑一条同步用例并记录（与同目录另两个脚本同形状）。 */
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/** 异步版本的用例包装（本文件的用例都是 async，所以必须 await 完再记结果）。 */
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

// ── 替身 ─────────────────────────────────────────────────────────────────────

/**
 * 造一个假 session。
 *
 * ── 为什么它还要带 `seq` / `eventAt`（本次新增）────────────────────────────
 *
 * 「唤醒后重试转呈」要判断父会话**此刻有没有打开的回合**，而那个判据来自上游
 * `hasOpenTurn`：从日志尾部倒序扫，`turn/start` 为真、`turn/end` 为假。
 * 所以替身必须能表达「日志里有哪些事件」—— 否则那条判据在测试里永远是
 * `undefined`（读不出来），重试路径就**测不到**，只有真机上才会跑。
 *
 * `seq` 与 `eventAt` 的语义**照抄上游**：`seq` 是日志长度，`eventAt(seq)` 就是 `log[seq]`。
 *
 * @param options - `{ id, cwd, policy }`；`policy` 模拟该会话当前的有效策略。
 * @returns 带 `header` / `append` / `appends` / `seq` / `eventAt` 的替身。
 */
function fakeSession(options = {}) {
  const appends = []
  const log = []
  const header = { id: options.id ?? 'sess-1' }
  if (options.cwd !== undefined) header.cwd = options.cwd
  if (options.origin !== undefined) header.origin = options.origin
  if (options.parentSession !== undefined) header.parentSession = options.parentSession
  if (options.delegationDepth !== undefined) header.delegationDepth = options.delegationDepth
  return {
    id: header.id,
    header,
    appends,
    /** 会话日志（供 `eventAt` / `seq` 读；与上游的 `log` 同义）。 */
    log,
    /** 照抄上游：`seq` 就是日志长度。 */
    get seq() {
      return log.length
    },
    /** 照抄上游：`eventAt(seq)` 就是 `log[seq]`（`SessionSeq` 在运行期是恒等函数）。 */
    eventAt(seq) {
      return log[seq]
    },
    append(type, data) {
      appends.push({ type, data })
    },
  }
}

/**
 * 往会话日志里追加一个事件（只影响 `eventAt` / `seq` 看到的形状，不进 `appends`）。
 *
 * @param session - 目标会话替身。
 * @param type - 事件类型（本组用例只用到 `turn/start` / `turn/end`）。
 */
function pushEvent(session, type) {
  session.log.push({ type })
}

/** 标记该会话开了一个回合。 */
function openTurn(session) {
  pushEvent(session, 'turn/start')
}

/** 标记该会话的回合结束了。 */
function closeTurn(session) {
  pushEvent(session, 'turn/end')
}

/**
 * 造一个假 agent。
 *
 * @param session - 该 agent 的会话替身。
 * @param events - 一个有 `on` 的假事件注册表（用来捕获 `system-prompt/assemble`）。
 * @returns agent 替身。
 */
function fakeAgent(session, events = []) {
  return {
    id: session.id,
    session,
    ctx: {
      on(event, handler) {
        events.push({ event, handler })
        return () => {}
      },
      systemPrompt: {
        getContextOrder: () => 0,
      },
      tools: {},
    },
  }
}

/**
 * 造一个假 ctx，记录所有事件注册与日志。
 *
 * @param options - `{ services, logger }`。
 * @returns `{ ctx, handlers, logs, on: 捕获的注册 }`。
 */
function fakeCtx(options = {}) {
  const handlers = []
  const logs = { info: [], warn: [] }
  const services = options.services ?? {}
  const ctx = {
    on(event, handler, opts) {
      handlers.push({ event, handler, opts })
      return () => {}
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
 * 造一个假 approval 服务。
 *
 * @param policies - `Map<session, policy>`；未知会话按 `options.defaultPolicy` 处理。
 * @param requestImpl - 自定义的 `request` 实现（用来模拟成功 / 抛错）。
 * @returns approval 替身（含调用记录）。
 */
function fakeApproval(policies, requestImpl) {
  const requests = []
  return {
    requests,
    effectivePolicy(session) {
      return policies.get(session)
    },
    async request(req) {
      requests.push(req)
      if (requestImpl !== undefined) return await requestImpl(req)
      return 'allowed-once'
    },
  }
}

/**
 * 造一个假 `subagents` 服务（兜底通知用的消息通道）。
 *
 * 只实现本模块真正用到的那一个方法：`sendMessage(sender, targetId, content, options)`。
 * `sendImpl` 可注入失败，用来验证「通知发不出去也不改变审批结果」。
 *
 * @param sendImpl - 自定义实现；不传则总是成功。
 * @returns 替身（含 `sent` 调用记录）。
 */
function fakeSubagents(sendImpl) {
  const sent = []
  const stub = {
    sent,
    /**
     * 投递时的附加动作（可选）。`bridge` 这样的用例靠它模拟「通知唤醒父会话」——
     * 即 `steer` + `wakeup = true` 在真实上游里的那一步。
     */
    onSend: undefined,
    async sendMessage(sender, targetId, content, options) {
      sent.push({ sender, targetId, content, options })
      if (stub.onSend !== undefined) await stub.onSend()
      if (sendImpl !== undefined) return await sendImpl(sender, targetId, content, options)
      return 'message-id-1'
    },
  }
  return stub
}

/** 取某事件注册的 handler（找不到就抛，让用例立刻红）。 */
function handlerFor(handlers, event) {
  const found = handlers.find((h) => h.event === event)
  assert(found !== undefined, `本模块没有注册 ${event} 的监听器`)
  return found
}

/**
 * 构造一组「父会话是 ask、子代理是 never」的标准场景。
 *
 * @param approvals - approval 替身。
 * @param subagents - 可选的 `subagents` 替身（兜底通知用；不传则该服务缺席）。
 * @returns `{ parent, child, childEvents, parentEvents, services }`。
 */
function scene(approvals, subagents) {
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({
    id: 'child-1',
    cwd: 'H:\\proj',
    origin: 'subagent',
    parentSession: 'parent-1',
    delegationDepth: 1,
  })
  const childEvents = []
  const parent = fakeAgent(parentSession, [])
  const child = fakeAgent(childSession, childEvents)
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
  }
  if (subagents !== undefined) services.subagents = subagents
  return { parent, child, childEvents, parentEvents: [], services }
}

console.log('===== dsh-multitask approval-gate 逻辑链集成探针（进程内 / 零依赖）=====')

// ── 一、B：策略放开与门控 ────────────────────────────────────────────────────
console.log('\n--- 1. B：门控与策略放开 ---')

await testAsync('I1 父会话是 ask：子代理被放开，且写进去的事件**省略 source**', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })

  const created = handlerFor(handlers, 'agent/created')
  created.handler({ agent: child })

  const policyWrites = child.session.appends.filter((a) => a.type === 'approval/policy')
  assert(policyWrites.length === 1, `应当恰好写一条 approval/policy，实际 ${policyWrites.length} 条`)
  assert(policyWrites[0].data.policy === 'ask', `策略应当是 ask，实际 ${JSON.stringify(policyWrites[0].data.policy)}`)
  assert(
    !Object.prototype.hasOwnProperty.call(policyWrites[0].data, 'source'),
    'approval/policy 不该带 source 字段 —— 运行期虽不校验它，但 source: "delegation" ' +
      '的语义是「从父级委派继承而来」，而本模块做的恰恰是纠正委派的钉死，带上就是说反话',
  )
})

await testAsync('I2 父会话是 never：一个字都不动（headless 部署的红线）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'never' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  handlerFor(handlers, 'agent/created').handler({ agent: child })

  assert(child.session.appends.length === 0, '父会话不是 ask 时不该写任何事件')
  assert(
    logs.warn.some((m) => m.includes('MULTITASK-APPROVAL-GATE-SKIPPED reason=parent-not-interactive')),
    '跳过时应当留着可 grep 的标识（含原因）',
  )
})

await testAsync('I3 协调者（非子代理）：完全不受影响', async () => {
  const approvals = fakeApproval(new Map([['x', 'ask']]))
  const { parent, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  handlerFor(handlers, 'agent/created').handler({ agent: parent })

  assert(parent.session.appends.length === 0, '非委派会话不该被本模块写入任何东西')
})

await testAsync('I4 同一个子代理只放开一次（agent/created 也会在 resume 时发）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const created = handlerFor(handlers, 'agent/created')
  created.handler({ agent: child })
  created.handler({ agent: child })
  created.handler({ agent: child })

  const policyWrites = child.session.appends.filter((a) => a.type === 'approval/policy')
  assert(policyWrites.length === 1, `重复触发只应写一条，实际 ${policyWrites.length} 条`)
})

await testAsync('I4b 瞬时失败必须保持可重试（不能一次缺席就永久钉死）', async () => {
  // 场景：父 agent 那一刻还不在册（真实存在于冷恢复的时序里）。此时不能把该子代理
  // 记成「已处理」—— 否则 `agent/created` 下次再发时就被去重挡掉，这个 worker 会
  // **永远**停在 `never` 上，而且没有任何日志说明它为什么没被放开。
  const approvals = fakeApproval(new Map())
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({ id: 'child-1', origin: 'subagent', parentSession: 'parent-1', delegationDepth: 1 })
  const parent = fakeAgent(parentSession)
  const child = fakeAgent(childSession)
  approvals.effectivePolicy = (session) => (session === parentSession ? 'ask' : 'never')

  let parentVisible = false
  const services = {
    approval: approvals,
    agents: { get: (id) => (parentVisible && id === 'parent-1' ? parent : undefined) },
  }
  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const created = handlerFor(handlers, 'agent/created')

  // 第一次：父还看不到 ⇒ 跳过，且**不能**写事件
  created.handler({ agent: child })
  assert(child.session.appends.length === 0, '父不在册时不该写事件')

  // 第二次（例如 resume）：父已在册 ⇒ 必须真的放开
  parentVisible = true
  created.handler({ agent: child })
  const policyWrites = child.session.appends.filter((a) => a.type === 'approval/policy')
  assert(
    policyWrites.length === 1,
    `瞬时缺席之后的第二次机会必须生效，实际写了 ${policyWrites.length} 条 —— ` +
      '若在开头就登记「已处理」，这里会是 0 条，而那个 worker 就永久停在 never 上了',
  )
})

await testAsync('I5 缺 approval 服务 / 缺 append：静默跳过，不抛错', async () => {
  const { child, services } = scene(undefined)
  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  handlerFor(handlers, 'agent/created').handler({ agent: child })
  assert(child.session.appends.length === 0, '缺 approval 服务时不该写事件')

  // 缺 append 的会话
  const approvals = fakeApproval(new Map())
  const scene2 = scene(approvals)
  approvals.effectivePolicy = (session) => (session === scene2.parent.session ? 'ask' : 'never')
  scene2.child.session.append = undefined
  const second = fakeCtx({ services: scene2.services })
  apply(second.ctx, { enabled: true })
  handlerFor(second.handlers, 'agent/created').handler({ agent: scene2.child })
})

await testAsync('I6 载荷畸形（没有 agent / 不是对象）不炸掉会话创建', async () => {
  const approvals = fakeApproval(new Map())
  const { services } = scene(approvals)
  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const created = handlerFor(handlers, 'agent/created')
  created.handler(undefined)
  created.handler({})
  created.handler({ agent: undefined })
  created.handler({ agent: null })
  created.handler({ agent: { session: null } })
  assert(logs.warn.length === 0, `这些畸形输入都应当被静默忽略，实际有 ${logs.warn.length} 条警告`)
})

await testAsync('I7 enabled: false 时什么都不注册', async () => {
  const approvals = fakeApproval(new Map())
  const { services } = scene(approvals)
  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: false })
  assert(handlers.length === 0, `应当一个监听器都不注册，实际注册了 ${handlers.length} 个`)
})

// ── 二、委派上下文改写 ───────────────────────────────────────────────────────
console.log('\n--- 2. 纠正如实性：改写那句「会自动拒绝」的委派上下文 ---')

await testAsync('I8 改写在子代理自己的 scope 上注册，且只动那一条', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, childEvents, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  handlerFor(handlers, 'agent/created').handler({ agent: child })

  const reg = childEvents.find((e) => e.event === 'system-prompt/assemble')
  assert(reg !== undefined, '应当已在子代理 scope 上注册 system-prompt/assemble 的改写')

  const assembled = {
    sections: [],
    contexts: [
      { name: 'approval:policy', text: 'Approval policy: ask. ...' },
      { name: 'subagent:delegation', text: 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.' },
      { name: 'other', text: 'untouched' },
    ],
  }
  const out = await reg.handler(assembled, {}, async () => assembled)

  const delegation = out.contexts.find((c) => c.name === 'subagent:delegation')
  assert(
    !delegation.text.includes('are rejected automatically'),
    '那句「会自动拒绝」必须被改掉 —— 留着它模型会自我审查、连请求都不发起，第二级闸门永远等不到请求',
  )
  assert(
    delegation.text.includes('routed to the user'),
    '改写后的文本应当说明请求会交给用户裁决',
  )
  // 其余条目必须原样
  assert(out.contexts.find((c) => c.name === 'other').text === 'untouched', '不该动别的 context')
  assert(out.sections === assembled.sections, '不该动 sections')
})

await testAsync('I9 上游改了措辞时不猜：原样返回并留一条可 grep 的 warn', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, childEvents, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  handlerFor(handlers, 'agent/created').handler({ agent: child })
  const reg = childEvents.find((e) => e.event === 'system-prompt/assemble')

  const assembled = { sections: [], contexts: [{ name: 'subagent:delegation', text: 'upstream rewrote this sentence entirely' }] }
  const out = await reg.handler(assembled, {}, async () => assembled)

  assert(out.contexts[0].text === 'upstream rewrote this sentence entirely', '认不出的措辞必须原样保留')
  assert(
    logs.warn.some((m) => m.includes('reason=context-wording-changed')),
    '认不出时应当留一条可 grep 的提示，让人去核对新措辞是否仍然误导',
  )
})

await testAsync('I10 组装结果畸形时原样返回（不炸掉提示词组装）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, childEvents, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  handlerFor(handlers, 'agent/created').handler({ agent: child })
  const reg = childEvents.find((e) => e.event === 'system-prompt/assemble')

  for (const weird of [undefined, null, {}, { contexts: 'nope' }, { contexts: null }]) {
    const out = await reg.handler(weird, {}, async () => weird)
    assert(out === weird, `畸形输入应当原样返回，实际返回了 ${JSON.stringify(out)}`)
  }
})

// ── 三、第一级分流（C1-b）────────────────────────────────────────────────────
console.log('\n--- 3. C1-b：第一级分流的判定与形状 ---')

/**
 * 跑一次 pre-execute。
 *
 * @param handler - 注册的监听器。
 * @param exec - 工具执行输入。
 * @param downstream - 上游给出的决定。
 * @returns 监听器的返回值。
 */
async function runPreExecute(handler, exec, downstream = { kind: 'allow' }) {
  return await handler(exec, async () => downstream)
}

await testAsync('I11 危险命令：升级为 ask，且形状是上游认的那一种', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const out = await runPreExecute(pre.handler, {
    name: 'pwsh',
    agent: child,
    arguments: { command: 'Remove-Item -Recurse -Force .\\dist' },
  })

  assert(out.kind === 'ask', `应当升级为 ask，实际 ${JSON.stringify(out)}`)
  assert(typeof out.reason === 'string' && out.reason !== '', 'ask 必须带非空的 reason（它写进 durable 审计）')
  assert(out.displayReason !== undefined, '应当带 displayReason 让面板显示本地化文案')
  assert(typeof out.displayReason.zh === 'string' && out.displayReason.zh !== '', 'displayReason 应当含中文')
  assert(typeof out.displayReason.en === 'string' && out.displayReason.en !== '', 'displayReason 应当含英文')
})

await testAsync('I12 安全命令：原样返回上游的 allow（不打扰用户）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const allow = { kind: 'allow' }
  const out = await runPreExecute(
    pre.handler,
    { name: 'pwsh', agent: child, arguments: { command: 'Get-ChildItem -Path .' } },
    allow,
  )
  assert(out === allow, '安全命令应当把上游的决定原样返回')
})

await testAsync('I13 上游已经拒绝：绝不被本模块升级成 ask（不覆盖别人的拒绝）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const deny = { kind: 'deny', reason: 'blocked by someone else' }
  const out = await runPreExecute(
    pre.handler,
    { name: 'pwsh', agent: child, arguments: { command: 'rm -rf /' } },
    deny,
  )
  assert(out === deny, '上游的拒绝必须原样返回')
})

await testAsync('I14 策略不是 ask 时绝不返回 ask（否则会制造出一个必然被拒的询问）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  // 子代理仍被钉死为 never（例如父会话不是 ask、本模块没放开它）
  approvals.effectivePolicy = () => 'never'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const allow = { kind: 'allow' }
  const out = await runPreExecute(
    pre.handler,
    { name: 'pwsh', agent: child, arguments: { command: 'rm -rf ./build' } },
    allow,
  )
  assert(
    out === allow,
    '策略是 never 时返回 ask 只会被 decide() 第一行判成 rejected —— ' +
      '那会把一条原本能在沙箱里跑完的命令变成拒绝，比不问更糟',
  )
})

await testAsync('I15 协调者（非子代理）的危险命令不由本模块过问', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const allow = { kind: 'allow' }
  const out = await runPreExecute(
    pre.handler,
    { name: 'pwsh', agent: parent, arguments: { command: 'rm -rf ./build' } },
    allow,
  )
  assert(out === allow, '本模块只管委派出来的子代理')
})

await testAsync('I16 写工作区之外的文件：升级为 ask；工作区内：放行', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const outside = await runPreExecute(pre.handler, {
    name: 'write',
    agent: child,
    arguments: { file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', content: 'x' },
  })
  assert(outside.kind === 'ask', `工作区之外的写入应当升级为 ask，实际 ${JSON.stringify(outside)}`)

  const inside = await runPreExecute(pre.handler, {
    name: 'write',
    agent: child,
    arguments: { file_path: 'H:\\proj\\src\\a.js', content: 'x' },
  })
  assert(inside.kind === 'allow', '工作区内的写入应当放行（沙箱自己会兜底）')
})

await testAsync('I17 工具参数畸形不抛错（一律放行）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  for (const args of [undefined, null, {}, { command: 123 }, { command: '' }, { command: null }]) {
    const out = await runPreExecute(pre.handler, { name: 'pwsh', agent: child, arguments: args })
    assert(out.kind === 'allow', `畸形参数应当放行，实际 ${JSON.stringify(out)}`)
  }
})

await testAsync('I18 classify: false 时第一级整段不注册', async () => {
  const approvals = fakeApproval(new Map())
  const { services } = scene(approvals)
  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true, classify: false })
  assert(
    handlers.every((h) => h.event !== 'tools/pre-execute'),
    'classify: false 时不该注册第一级',
  )
  assert(
    handlers.some((h) => h.event === 'approval/request'),
    '关掉第一级不该影响第二级',
  )
})

// ── 四、第二级转呈（C2）─────────────────────────────────────────────────────
console.log('\n--- 4. C2：把子代理的请求转呈给父会话 ---')

/**
 * 跑一次 approval/request 的监听器。
 *
 * @param handler - 注册的监听器。
 * @param request - 审批请求。
 * @returns `{ outcome, nextCalls }`。
 */
async function runRelay(handler, request) {
  let nextCalls = 0
  const outcome = await handler(request, async () => {
    nextCalls += 1
    return 'next-result'
  })
  return { outcome, nextCalls }
}

await testAsync('I19 子代理的请求：转呈给父会话，带可追溯的归因文案', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  assert(relay.opts?.prepend === true, '转呈必须 prepend —— 排在转发者后面就来不及了')

  const { outcome, nextCalls } = await runRelay(relay.handler, {
    agent: child,
    toolName: 'pwsh',
    callId: 'call-9',
    reason: 'escalate sandbox to danger-full-access: need to touch C:\\Windows',
  })

  assert(outcome === 'allowed-once', `应当把父会话的裁定原样返回，实际 ${String(outcome)}`)
  assert(nextCalls === 0, '转呈成功后不该再走下游')
  assert(approvals.requests.length === 1, `应当恰好向父会话发起一次请求，实际 ${approvals.requests.length} 次`)

  const forwarded = approvals.requests[0]
  assert(forwarded.agent === parent, '转呈的目标必须是**父会话**（这样面板才会出现在主对话里）')
  assert(forwarded.toolName === 'pwsh', '工具名应当原样带上')
  assert(forwarded.callId === 'call-9', 'callId 应当原样带上（面板用它做关联）')
  assert(
    forwarded.reason.includes('child-1'.slice(0, 8)) || forwarded.reason.includes('Subagent'),
    '理由里应当说明这是子代理发起的，让用户知道是谁在要权限',
  )
  assert(forwarded.displayReason?.zh !== undefined, '转呈应当带中文本地化文案')
})

await testAsync('I20 父会话自己的请求：原样放行（不自我转呈、不死循环）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: parent, toolName: 'pwsh' })
  assert(outcome === 'next-result', '父会话的请求应当交回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(approvals.requests.length === 0, '不该为自己再发起一次请求')
})

await testAsync('I21 父会话不是 ask：不转呈，交回下游', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'never'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '父会话不是交互式时应当交回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(approvals.requests.length === 0, '不该向一个非交互式会话发起请求')
})

await testAsync('I22 转呈失败（父会话没有打开的回合）：退回原路径，绝不把拒绝变成放行', async () => {
  const approvals = fakeApproval(new Map(), async () => {
    throw new Error('approval.request() outside an open turn: ...')
  })
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '转呈失败必须退回原路径（下游最高会把结果定成 fail-closed）')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-FAILED')),
    '转呈失败应当留一条可 grep 的记录（这是已知限制，不是静默吞掉）',
  )
})

await testAsync('I23 多级委派：一次走到根，而不是逐级转呈', async () => {
  const approvals = fakeApproval(new Map())
  const rootSession = fakeSession({ id: 'root-1', cwd: 'H:\\proj' })
  const midSession = fakeSession({ id: 'mid-1', origin: 'subagent', parentSession: 'root-1', delegationDepth: 1 })
  const leafSession = fakeSession({ id: 'leaf-1', origin: 'subagent', parentSession: 'mid-1', delegationDepth: 2 })
  const root = fakeAgent(rootSession)
  const mid = fakeAgent(midSession)
  const leaf = fakeAgent(leafSession)
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'root-1' ? root : id === 'mid-1' ? mid : undefined) },
  }
  approvals.effectivePolicy = (session) => (session === rootSession ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  await runRelay(relay.handler, { agent: leaf, toolName: 'pwsh' })
  assert(approvals.requests.length === 1, '应当只发起一次请求（不逐级转呈）')
  assert(approvals.requests[0].agent === root, '转呈的目标应当是**根**会话，而不是中间那一级')
})

await testAsync('I24 父链畸形（环 / 断链）不死循环、不抛错', async () => {
  const approvals = fakeApproval(new Map())
  const aSession = fakeSession({ id: 'a', origin: 'subagent', parentSession: 'b', delegationDepth: 1 })
  const bSession = fakeSession({ id: 'b', origin: 'subagent', parentSession: 'a', delegationDepth: 1 })
  const a = fakeAgent(aSession)
  const b = fakeAgent(bSession)
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'a' ? a : id === 'b' ? b : undefined) },
  }
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  // 环状父链：上溯到上限后应当放弃转呈并交回下游，而不是无限循环。
  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: a, toolName: 'pwsh' })
  assert(outcome === 'next-result', '父链不可信时应当交回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
})

await testAsync('I25 断链（父 agent 已不在册）：不转呈，交回下游', async () => {
  const approvals = fakeApproval(new Map())
  const childSession = fakeSession({ id: 'orphan', origin: 'subagent', parentSession: 'gone', delegationDepth: 1 })
  const orphan = fakeAgent(childSession)
  const services = { approval: approvals, agents: { get: () => undefined } }
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: orphan, toolName: 'pwsh' })
  assert(outcome === 'next-result', '父 agent 不在册时应当交回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(approvals.requests.length === 0, '不该向一个取不到的会话发起请求')
})

await testAsync('I26 relay: false 时第二级整段不注册', async () => {
  const approvals = fakeApproval(new Map())
  const { services } = scene(approvals)
  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true, relay: false })
  assert(
    handlers.every((h) => h.event !== 'approval/request'),
    'relay: false 时不该注册第二级',
  )
  assert(
    handlers.some((h) => h.event === 'tools/pre-execute'),
    '关掉第二级不该影响第一级',
  )
})

await testAsync('I27 转呈保留原请求的 signal（取消时主对话提示也随之消失）', async () => {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const controller = new AbortController()
  await runRelay(relay.handler, { agent: child, toolName: 'pwsh', signal: controller.signal })
  assert(approvals.requests[0].signal === controller.signal, '应当沿用原子请求的 signal')
})

// ── 四之二、兜底通知（转呈失败时把「有决定在等你」送到用户眼前）──────────────
console.log('\n--- 4b. 兜底通知：转呈失败时指路给用户 ---')

/**
 * 造一个「转呈必然失败」的 approval 替身（模拟父会话没有打开的回合）。
 *
 * @returns approval 替身。
 */
function failingApproval() {
  return fakeApproval(new Map(), async () => {
    throw new Error('approval.request() outside an open turn: ...')
  })
}

await testAsync('I28 转呈失败：发了通知，且返回值仍是下游结果（决议不变）', async () => {
  const approvals = failingApproval()
  const subs = fakeSubagents()
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  // ⚠️ `relayRetryWindowMs: 0` 把「唤醒后重试」关掉，这条用例才只测通知本身：
  // 开着它的话，本用例会在等父会话开回合上真的耗满那个窗口（默认 10 秒），
  // 而它要断言的东西（通知发了、返回值不变）与等不等得到回合毫无关系。
  apply(ctx, { enabled: true, relayRetryWindowMs: 0 })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '返回值必须仍是下游结果 —— 通知绝不能改变审批结果')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(subs.sent.length === 1, `应当恰好发一条兜底通知，实际 ${subs.sent.length} 条`)

  const sent = subs.sent[0]
  assert(sent.sender === child, 'sender 必须是那个子代理（消息通道据此做归属）')
  assert(sent.targetId === 'parent-1', 'targetId 必须是父会话 id')
  const text = sent.content.map((b) => b.text).join('\n')
  assert(text.includes('child-1'), '通知里必须写出子会话 id —— 用户得靠它找到那个会话')
  assert(text.includes('pwsh'), '通知里必须写出工具名')
  // ⚠️ 这一条是本兜底里**最关键的语义**：消息通道不携带审批结果，所以通知只能「指路」。
  // 若文案让协调者读成「已获批」，它就会绕过审批继续干 —— 那比不通知更糟。
  assert(
    /not an approval|stays blocked|only your answer releases it/i.test(text),
    '通知必须明确写出「这不是批准、在你作答前那次调用保持阻塞」—— ' +
      '消息通道不携带审批结果，文案若被读成放行就等于绕过了审批',
  )
  assert(sent.options?.signal !== undefined, 'sendMessage 的 options.signal 是必填，必须给')
})

await testAsync('I29 发通知本身失败：仍不改变返回值（绝不把失败变成放行）', async () => {
  const approvals = failingApproval()
  const subs = fakeSubagents(async () => {
    throw new Error('direct parent is not live; the message was not delivered')
  })
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '通知失败时返回值必须仍然是下游结果')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(subs.sent.length === 1, '确实尝试发过一次')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-NOTIFY-FAILED')),
    '通知失败要留一条可 grep 的记录',
  )
})

await testAsync('I30 缺 subagents 服务：跳过通知，不抛错、不改变返回值', async () => {
  const approvals = failingApproval()
  // 注意：不传 subagents 替身 ⇒ 该服务缺席
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '缺服务时仍要退回下游')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=no-subagents-service')),
    '缺服务要留可 grep 的原因',
  )
})

await testAsync('I31 父会话不是 ask：早退路径不发通知（那是噪音）', async () => {
  const approvals = fakeApproval(new Map())
  const subs = fakeSubagents()
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = () => 'never'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '应当退回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(subs.sent.length === 0, '早退路径（非本模块的事）不该发通知')
})

await testAsync('I32 父会话自己的请求：不发通知', async () => {
  const approvals = fakeApproval(new Map())
  const subs = fakeSubagents()
  const { parent, services } = scene(approvals, subs)
  approvals.effectivePolicy = () => 'ask'

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  await runRelay(relay.handler, { agent: parent, toolName: 'pwsh' })
  assert(subs.sent.length === 0, '非委派会话的请求不该触发通知')
})

await testAsync('I33 多级委派：父链上不是直接父子时不发（sendMessage 只认直接父）', async () => {
  const approvals = failingApproval()
  const subs = fakeSubagents()
  const rootSession = fakeSession({ id: 'root-1', cwd: 'H:\\proj' })
  const midSession = fakeSession({ id: 'mid-1', origin: 'subagent', parentSession: 'root-1', delegationDepth: 1 })
  const leafSession = fakeSession({ id: 'leaf-1', origin: 'subagent', parentSession: 'mid-1', delegationDepth: 2 })
  const root = fakeAgent(rootSession)
  const mid = fakeAgent(midSession)
  const leaf = fakeAgent(leafSession)
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'root-1' ? root : id === 'mid-1' ? mid : undefined) },
    subagents: subs,
  }
  approvals.effectivePolicy = (session) => (session === rootSession ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome } = await runRelay(relay.handler, { agent: leaf, toolName: 'pwsh' })
  assert(outcome === 'next-result', '应当退回下游')
  assert(subs.sent.length === 0, '转呈目标是根、而 sendMessage 只到直接父 —— 不该发（会错投给中间层）')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=not-direct-parent')),
    '跳过要留可 grep 的原因',
  )
})

await testAsync('I34 notifyOnRelayFailure: false 时整个兜底关闭（转呈仍然工作）', async () => {
  const approvals = failingApproval()
  const subs = fakeSubagents()
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, notifyOnRelayFailure: false })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  assert(outcome === 'next-result', '应当退回下游')
  assert(subs.sent.length === 0, '关掉后不该发通知')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=disabled-by-config')),
    '关掉要留可 grep 的原因',
  )
})

await testAsync('I35 signal 已中止：跳过通知（那次请求已经没有意义）', async () => {
  const approvals = failingApproval()
  const subs = fakeSubagents()
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const relay = handlerFor(handlers, 'approval/request')

  const controller = new AbortController()
  controller.abort()
  await runRelay(relay.handler, { agent: child, toolName: 'pwsh', signal: controller.signal })
  assert(subs.sent.length === 0, '请求已中止时不该再发通知')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=signal-aborted')),
    '跳过要留可 grep 的原因',
  )
})

await testAsync('I36 下游永不返回（真实挂起形态）：通知仍然发出去了', async () => {
  // 这是本兜底存在的**理由**，所以必须有一条用例钉住它。
  //
  // 转呈失败之后，下游会把请求发给浏览器；客户端会为那个**不可见**的子会话物化作用域
  // 并接住它，而审批路径没有任何超时 —— 于是这次 `next()` 永远不返回。
  // 若通知排在 `await next()` 之后，恰好在最需要它的场景里它永远发不出去。
  const approvals = failingApproval()
  const subs = fakeSubagents()
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')

  const { ctx, handlers } = fakeCtx({ services })
  // ⚠️ `relayRetryWindowMs: 0`：本用例只测「通知与下游的先后」，与「等不等得到回合」
  // 无关。开着重试窗口的话，这里会真的耗满 10 秒才发现父会话根本不会开回合。
  apply(ctx, { enabled: true, relayRetryWindowMs: 0 })
  const relay = handlerFor(handlers, 'approval/request')

  // 下游永不 settle（模拟被客户端接住后无限挂起）。
  let nextCalled = false
  const pending = relay.handler(
    { agent: child, toolName: 'pwsh' },
    () => {
      nextCalled = true
      return new Promise(() => {})
    },
  )

  // 让微任务队排空，但不 await 那个永不返回的 promise。
  for (let i = 0; i < 20; i += 1) await Promise.resolve()

  assert(nextCalled === true, '下游应当已被调过（说明确实走到了退回路径）')
  assert(
    subs.sent.length === 1,
    '下游挂起时通知必须**已经发出** —— 这正是把通知放在 await next() 之前的原因；' +
      `实际发出 ${subs.sent.length} 条`,
  )
  void pending
})

// ── 四之三、唤醒之后重试一次转呈（「回合刚好关着」那一类个例）──────────────────
//
// 这一组钉的是本次新增的行为：转呈失败后，那条兜底通知会把**空闲的父会话唤醒**
// （`sendMessage` → `steer` → `wakeup = true`），于是通常几毫秒后回合就开了 ——
// 本模块抓住那个回合并重试一次，于是这类个例从「用户得自己去子会话里找」
// 变成「主对话里正常出现一张审批卡」。
//
// 每一条都覆盖一个**不能错**的分支：它们错的方向要么是「白等 10 秒」，
// 要么是「在非交互式会话上发起询问」，要么是「重复询问」。
console.log('\n--- 4c. 唤醒后重试：回合刚开时把卡片送到主对话 ---')

/**
 * 造一个「父会话回合关着 → 通知唤醒 → 回合打开」的标准场景。
 *
 * `onSend` 模拟 `sendMessage` 的唤醒副作用（上游是 `steer` + `wakeup = true`）——
 * 这正是重试能成立的前提。默认只把回合打开。
 *
 * @param options - `{ openOnWake, beforeOpen }`。
 * @returns `{ parent, child, services, subs, approvals, parentSession }`。
 */
function turnBoundaryScene(options = {}) {
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({
    id: 'child-1',
    cwd: 'H:\\proj',
    origin: 'subagent',
    parentSession: 'parent-1',
    delegationDepth: 1,
  })
  // 父会话的回合**此刻是关着的** —— 这就是真实个例的形状（协调者后台派单、回合已结束）。
  closeTurn(parentSession)
  const parent = fakeAgent(parentSession)
  const child = fakeAgent(childSession)

  const approvals = fakeApproval(new Map(), async () => {
    // 第一次：父会话还没有打开的回合 ⇒ 上游抛错（与真实报错同形）。
    if (approvals.requests.length === 1) throw new Error('approval.request() outside an open turn: ...')
    return 'allowed-once'
  })
  approvals.effectivePolicy = (session) => (session === parentSession ? 'ask' : 'never')

  const subs = fakeSubagents()
  subs.onSend = () => {
    if (options.beforeOpen !== undefined) options.beforeOpen(parentSession)
    if (options.openOnWake !== false) openTurn(parentSession)
  }

  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
    subagents: subs,
  }
  return { parent, child, services, subs, approvals, parentSession, childSession }
}

await testAsync('I38 ★ 回合刚开：重试一次，把用户的决定拿回来（不再让用户自己去子会话）', async () => {
  const { parent, child, services, subs, approvals } = turnBoundaryScene()

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 500 })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })

  assert(outcome === 'allowed-once', `重试成功后应当返回用户的决定，实际 ${String(outcome)}`)
  assert(nextCalls === 0, '已经拿到决定时不该再退回下游 —— 那次请求已经有结论了')
  assert(
    approvals.requests.length === 2,
    `应当恰好两次 request（原次失败 + 重试成功），实际 ${approvals.requests.length} 次`,
  )
  assert(approvals.requests[1].agent === parent, '重试仍然必须打到父会话上')
  assert(subs.sent.length === 1, '通知仍然只发一条（它是唤醒父会话的手段）')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-RETRIED')),
    '重试成功要留一条可 grep 的记录（否则「卡片为什么出现了」无从查起）',
  )
})

await testAsync('I39 重试的载荷与首次**逐字相同**（否则用户会在不同时机看到不同措辞的卡）', async () => {
  const { child, services, approvals } = turnBoundaryScene()

  const { ctx, handlers } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 500 })
  const relay = handlerFor(handlers, 'approval/request')

  await runRelay(relay.handler, { agent: child, toolName: 'pwsh', callId: 'call-abc', reason: 'write outside the workspace' })
  assert(approvals.requests.length === 2, '本用例需要一个「首次失败 + 重试」的序列')
  const [first, second] = approvals.requests
  assert(first.toolName === second.toolName, 'toolName 必须一致')
  assert(first.reason === second.reason, `reason 必须逐字一致：\n  首次：${first.reason}\n  重试：${second.reason}`)
  assert(
    JSON.stringify(first.displayReason) === JSON.stringify(second.displayReason),
    'displayReason 必须逐字一致 —— 两处各写一份文案时最容易漂移的就是它',
  )
  assert(first.callId === second.callId, 'callId 必须沿用（面板靠它关联那次调用）')
})

await testAsync('I40 通知没送达：不等窗口（没有东西会去唤醒父会话，等就是白等）', async () => {
  const { child, services, approvals } = turnBoundaryScene()
  // 让通知发不出去。
  services.subagents = fakeSubagents(async () => {
    throw new Error('direct parent is not live; the message was not delivered')
  })

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 5000 })
  const relay = handlerFor(handlers, 'approval/request')

  const startedAt = Date.now()
  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  const elapsed = Date.now() - startedAt

  assert(outcome === 'next-result', '没有重试成功时仍要退回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(approvals.requests.length === 1, '通知没送达时不该重试')
  // ⚠️ 这条断言是**耗时**判据，而不只是状态判据：它钉住「不许把窗口白等掉」。
  // 5000ms 的窗口下，真去等的话这条用例必然远超 1 秒。
  assert(elapsed < 1000, `通知没送达时不许去等窗口（用了 ${elapsed}ms，窗口是 5000ms）`)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=notice-not-delivered')),
    '跳过要留可 grep 的原因',
  )
})

await testAsync('I41 别的失败原因：不重试（等下去不会变好，重试还可能造成重复询问）', async () => {
  const { parent, child, services, approvals } = turnBoundaryScene()
  // 换一个**不是**「缺打开回合」的失败原因，并把回合打开（说明「等」本来能成功）。
  approvals.request = async function request(req) {
    this.requests.push(req)
    throw new Error('the delegating parent agent was disposed')
  }

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 5000 })
  const relay = handlerFor(handlers, 'approval/request')

  const startedAt = Date.now()
  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  const elapsed = Date.now() - startedAt

  assert(outcome === 'next-result', '应当退回下游')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(approvals.requests.length === 1, '只有「缺打开回合」才重试 —— 别的失败重试会重复询问')
  assert(elapsed < 1000, `不许为别的失败原因去等窗口（用了 ${elapsed}ms）`)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=not-a-turn-boundary-failure')),
    '跳过要留可 grep 的原因',
  )
})

await testAsync('I42 窗口内始终等不到回合：退回原路径（fail-closed 的性质不变）', async () => {
  // 父会话永远不醒来（通知送出去了，但那边没有把回合开起来）。
  const { child, services, approvals } = turnBoundaryScene({ openOnWake: false })

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 150 })
  const relay = handlerFor(handlers, 'approval/request')

  const { outcome, nextCalls } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })

  assert(outcome === 'next-result', '等不到时必须退回下游（绝不能把一次拒绝变成放行）')
  assert(nextCalls === 1, '应当恰好走一次下游')
  assert(approvals.requests.length === 1, '窗口内没等到回合就不该重试')
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-FAILED reason=window-elapsed')),
    '窗口耗尽要留可 grep 的记录 —— 它是「为什么卡片还是没出现」的答案',
  )
})

await testAsync('I43 等待期间请求被中止：立即放弃重试', async () => {
  const { child, services, approvals } = turnBoundaryScene({ openOnWake: false })
  const controller = new AbortController()
  // 通知投递时（即进入等待之前）就把它中止掉。
  services.subagents.onSend = () => {
    controller.abort()
  }

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 5000 })
  const relay = handlerFor(handlers, 'approval/request')

  const startedAt = Date.now()
  const { outcome } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh', signal: controller.signal })
  const elapsed = Date.now() - startedAt

  assert(outcome === 'next-result', '应当退回下游')
  assert(approvals.requests.length === 1, '请求已中止时不该重试')
  assert(elapsed < 1000, `中止之后不该继续等（用了 ${elapsed}ms）`)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=signal-aborted')),
    '跳过要留可 grep 的原因',
  )
})

await testAsync('I44 ★ 等待期间父会话不再是 ask：放弃重试（绝不在非交互式会话上发起询问）', async () => {
  const { child, services, approvals, parentSession } = turnBoundaryScene({
    // 通知唤醒之后、重试之前，用户把那个会话切成了「永不需要批准」。
    beforeOpen: () => {
      approvals.effectivePolicy = () => 'never'
    },
  })

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true, relayRetryWindowMs: 5000 })
  const relay = handlerFor(handlers, 'approval/request')

  const startedAt = Date.now()
  const { outcome } = await runRelay(relay.handler, { agent: child, toolName: 'pwsh' })
  const elapsed = Date.now() - startedAt

  assert(outcome === 'next-result', '应当退回下游')
  assert(approvals.requests.length === 1, '策略已经不是 ask 时不许再发起询问（返回 ask 只会被上游判成拒绝）')
  assert(elapsed < 1000, `放弃要快（用了 ${elapsed}ms）`)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=parent-not-interactive')),
    '跳过要留可 grep 的原因',
  )
  assert(parentSession !== undefined, '场景已建立')
})

// ── 五、纯函数导出面（供别处复用与测试）────────────────────────────────────
console.log('\n--- 5. 导出面 ---')

test('I37 导出的判据与纯函数可用', () => {
  assert(typeof isDelegatedChild === 'function', 'isDelegatedChild 应当导出')
  assert(typeof classifyShellCommand === 'function', 'classifyShellCommand 应当导出')
  assert(typeof escapesWorkspace === 'function', 'escapesWorkspace 应当导出')
  assert(isDelegatedChild(undefined) === false, 'undefined 不是子代理')
  assert(isDelegatedChild({ session: { header: { origin: 'subagent' } } }) === true, 'origin 判据失效')
  assert(isDelegatedChild({ session: { header: { parentSession: 'p' } } }) === true, 'parentSession 判据失效')
  assert(isDelegatedChild({ session: { header: { delegationDepth: 2 } } }) === true, 'delegationDepth 判据失效')
  assert(isDelegatedChild({ session: { header: null } }) === false, '空 header 不该算子代理')
})

// ── 五之三、让位给自动审查（EXP）────────────────────────────────────────────
//
// 用户开了「自动审查（实验）」权限预设时，EXP 才是那个会话的把关人；本模块再升一次
// `ask` 只会变成「EXP 放行了却又弹卡问用户」。这两条用例锁住「该让位时让位、不该让位时
// 行为完全不变」。
console.log('\n--- 5c. 让位给自动审查（EXP 接管时不再重复打扰）---')

/**
 * 造一个「会话权限预设名固定为 name」的 permissionPresets 桩。
 *
 * @param name - `current()` 要返回的预设名；`undefined` 表示服务缺席。
 * @returns 桩服务。
 */
function fakePermissionPresets(name) {
  return { current: () => name }
}

await testAsync('I45 ★ EXP 接管（预设 = auto）时本模块让位，不再升 ask', async () => {
  const approvals = fakeApproval(new Map())
  const { child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'
  // 上游 EXP 自己的门就是 `current(...) === 'auto'`，这里复刻同一判据。
  services.permissionPresets = fakePermissionPresets('auto')

  const { ctx, handlers, logs } = fakeCtx({ services })
  apply(ctx, { enabled: true })
  const pre = handlerFor(handlers, 'tools/pre-execute')

  const out = await runPreExecute(pre.handler, {
    name: 'pwsh',
    agent: child,
    arguments: { command: 'Remove-Item -Recurse -Force .\\dist' },
  })

  assert(
    out.kind === 'allow',
    `EXP 接管时本模块必须让位（返回下游的 allow），实际：${JSON.stringify(out)} —— ` +
      '否则就是「EXP 已经放行、却仍弹卡问用户」那个重复打扰',
  )
  assert(
    logs.info.some((m) => m.includes('MULTITASK-APPROVAL-YIELDED reason=auto-review')),
    '让位时应当留一条可 grep 的固定标识（否则「让位了」与「压根没跑到」无法区分）',
  )
})

await testAsync('I46 ★ 没有 EXP（预设不是 auto）时行为完全不变，照样升 ask', async () => {
  // 三种「不是 auto」：没装（服务缺席）、用户选的别的预设、EXP 选过但后来被判成 custom。
  for (const [label, presets] of [
    ['服务缺席', undefined],
    ['用户选了别的预设', fakePermissionPresets('read-only')],
    ['EXP 选过但已成 custom', fakePermissionPresets('custom')],
  ]) {
    const approvals = fakeApproval(new Map())
    const { child, services } = scene(approvals)
    approvals.effectivePolicy = () => 'ask'
    if (presets !== undefined) services.permissionPresets = presets

    const { ctx, handlers } = fakeCtx({ services })
    apply(ctx, { enabled: true })
    const pre = handlerFor(handlers, 'tools/pre-execute')

    const out = await runPreExecute(pre.handler, {
      name: 'pwsh',
      agent: child,
      arguments: { command: 'Remove-Item -Recurse -Force .\\dist' },
    })

    assert(
      out.kind === 'ask',
      `${label}：本模块应当照旧升 ask，实际：${JSON.stringify(out)} —— ` +
        '「没开 EXP 就保持现状」是用户明确要求的行为',
    )
  }
})

// ── 六、反向验证：把每条关键守卫改坏，对应用例必须变红 ─────────────────────────
//
// 与 `repo-consistency.mjs` / `guard-mode-isolation-regression.mjs` 同一条纪律：
// **一条永远绿的守卫断言，恰好等于没有那条断言**。上面那 28 条里，凡是「断言某个东西
// 不该发生」的（门控、省略 source、退回原路径…），都有写错成恒真的风险，所以这里把每条
// 保护的实现改坏，用同一套探针再跑一遍，确认**确实会红**。
//
// 变异是在**内存里**做的（加载 `data:` URL 的副本）：不改动磁盘上的任何文件。
console.log('\n--- 6. 反向验证（把守卫改坏后应当变红）---')

/** 读本模块源码（用来做内存变异）。 */
const SOURCE_URL = new URL('../../presets/multitask/approval-gate.mjs', import.meta.url)
const SOURCE = await (await import('node:fs/promises')).readFile(SOURCE_URL, 'utf8')

/**
 * 把锚点字面量转成**容忍 CRLF** 的正则。
 *
 * ⚠️ 为什么必须这样：本仓在 Windows 上工作，`git` 的 `core.autocrlf` 会把检出后的
 * 工作副本写成 CRLF（`git status` 自己就提示 `LF will be replaced by CRLF`）。
 * 锚点字面量里的换行是**真正的 LF 字符**，一旦工作副本变成 CRLF，
 * `SOURCE.includes(anchor)` 就整片失配 —— 表现是「变异找不到目标片段」，
 * 也就是**判别力静默下降**（本机实测：8 条变异只剩 5 条能确认，而汇总行看起来
 * 只是少了几行确认日志）。仓库里各文件的换行并不保证一致（实测
 * `approval-gate.mjs` 是 CRLF 而新写的模块是 LF），所以判据必须两边都吃得下。
 *
 * @param anchor - 锚点字面量（含真实换行）。
 * @returns 匹配同一段文本、但换行处 `\n` 与 `\r\n` 都接受的正则。
 */
function anchorPattern(anchor) {
  return new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'))
}

/**
 * 在内存里把源码改坏，加载成模块。
 *
 * @param label - 变异名（用于诊断）。
 * @param from - 要被替换的源码片段（必须**逐字**存在，否则算变异失败）。
 * @param to - 替换成什么。
 * @returns `{ module }` 或 `{ error }`。
 */
async function mutant(label, from, to) {
  const pattern = anchorPattern(from)
  if (!pattern.test(SOURCE)) return { error: `变异「${label}」找不到目标片段` }
  const mutated = SOURCE.replace(pattern, to)
  const url = `data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`
  try {
    return { module: await import(url) }
  } catch (error) {
    return { error: `变异「${label}」无法加载: ${error.message}` }
  }
}

/**
 * 对一个变异体跑「父会话是 never 时不该写事件」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 是否**违规写入了**（true = 用例会红 = 判别力确认）。
 */
function mutantWritesWhenParentNever(module) {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'never'
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const created = handlers.find((h) => h.event === 'agent/created')
  if (created === undefined) return false
  created.handler({ agent: child })
  return child.session.appends.length > 0
}

/**
 * 对一个变异体跑「写进去的事件是否带上了非法的 source 字段」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 违规带上了 `source` 时为 true。
 */
function mutantWritesSourceField(module) {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const created = handlers.find((h) => h.event === 'agent/created')
  if (created === undefined) return false
  created.handler({ agent: child })
  const write = child.session.appends.find((a) => a.type === 'approval/policy')
  if (write === undefined) return false
  return Object.prototype.hasOwnProperty.call(write.data, 'source')
}

/**
 * 对一个变异体跑「策略不是 ask 时是否会返回 ask」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 违规返回了 `ask` 时为 true（异步）。
 */
async function mutantAsksUnderNever(module) {
  const approvals = fakeApproval(new Map())
  const { child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'never'
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const pre = handlers.find((h) => h.event === 'tools/pre-execute')
  if (pre === undefined) return false
  const out = await pre.handler(
    { name: 'pwsh', agent: child, arguments: { command: 'rm -rf ./build' } },
    async () => ({ kind: 'allow' }),
  )
  return out?.kind === 'ask'
}

/**
 * 对一个变异体跑「上游拒绝是否被覆盖成 ask」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 覆盖了上游的拒绝时为 true（异步）。
 */
async function mutantOverridesDeny(module) {
  const approvals = fakeApproval(new Map())
  const { child, services } = scene(approvals)
  approvals.effectivePolicy = () => 'ask'
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const pre = handlers.find((h) => h.event === 'tools/pre-execute')
  if (pre === undefined) return false
  const deny = { kind: 'deny', reason: 'blocked upstream' }
  const out = await pre.handler(
    { name: 'pwsh', agent: child, arguments: { command: 'rm -rf /' } },
    async () => deny,
  )
  return out !== deny
}

/**
 * 对一个变异体跑「转呈目标是否是父会话」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 转呈到了别处时为 true（异步）。
 */
async function mutantRelaysWrongTarget(module) {
  const approvals = fakeApproval(new Map())
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const relay = handlers.find((h) => h.event === 'approval/request')
  if (relay === undefined) return false
  await relay.handler({ agent: child, toolName: 'pwsh' }, async () => 'next-result')
  if (approvals.requests.length === 0) return true
  return approvals.requests[0].agent !== parent
}

/**
 * 对一个变异体跑「转呈失败是否退回原路径」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 没有退回（直接吞掉）时为 true（异步）。
 */
async function mutantSwallowsRelayFailure(module) {
  const approvals = fakeApproval(new Map(), async () => {
    throw new Error('approval.request() outside an open turn: ...')
  })
  const { parent, child, services } = scene(approvals)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const relay = handlers.find((h) => h.event === 'approval/request')
  if (relay === undefined) return false
  let nextCalls = 0
  await relay.handler({ agent: child, toolName: 'pwsh' }, async () => {
    nextCalls += 1
    return 'next-result'
  })
  return nextCalls === 0
}

/**
 * 对一个变异体跑「瞬时失败之后是否还能重试」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 永久钉死（第二次机会不生效）时为 true。
 */
function mutantPinsAfterTransientMiss(module) {
  const approvals = fakeApproval(new Map())
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({ id: 'child-1', origin: 'subagent', parentSession: 'parent-1', delegationDepth: 1 })
  const parent = fakeAgent(parentSession)
  const child = fakeAgent(childSession)
  approvals.effectivePolicy = (session) => (session === parentSession ? 'ask' : 'never')
  let parentVisible = false
  const services = {
    approval: approvals,
    agents: { get: (id) => (parentVisible && id === 'parent-1' ? parent : undefined) },
  }
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const created = handlers.find((h) => h.event === 'agent/created')
  if (created === undefined) return false
  created.handler({ agent: child })
  parentVisible = true
  created.handler({ agent: child })
  return child.session.appends.filter((a) => a.type === 'approval/policy').length === 0
}

/**
 * 对一个变异体跑「通知是否在下游挂起时仍然发出」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 通知**没有**发出（= 用例会红）时为 true（异步）。
 */
async function mutantNotifiesAfterAwait(module) {
  const approvals = fakeApproval(new Map(), async () => {
    throw new Error('approval.request() outside an open turn: ...')
  })
  const subs = fakeSubagents()
  const { parent, child, services } = scene(approvals, subs)
  approvals.effectivePolicy = (session) => (session === parent.session ? 'ask' : 'never')
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true })
  const relay = handlers.find((h) => h.event === 'approval/request')
  if (relay === undefined) return false
  // 下游永不 settle：若通知排在 await 之后，它就永远发不出去。
  void relay.handler({ agent: child, toolName: 'pwsh' }, () => new Promise(() => undefined))
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  return subs.sent.length === 0
}

/**
 * 对一个变异体跑「是否无视失败原因一律重试」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 对**非**「缺打开回合」的失败也重试了时为 true（异步）。
 */
async function mutantRetriesAnyFailure(module) {
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({
    id: 'child-1',
    cwd: 'H:\\proj',
    origin: 'subagent',
    parentSession: 'parent-1',
    delegationDepth: 1,
  })
  closeTurn(parentSession)
  const parent = fakeAgent(parentSession)
  const child = fakeAgent(childSession)
  // 反复失败，且失败原因**不是**「缺打开回合」。
  const approvals = fakeApproval(new Map(), async () => {
    throw new Error('the delegating parent agent was disposed')
  })
  approvals.effectivePolicy = (session) => (session === parentSession ? 'ask' : 'never')
  const subs = fakeSubagents()
  subs.onSend = () => openTurn(parentSession)
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
    subagents: subs,
  }
  const { ctx, handlers } = fakeCtx({ services })
  module.apply(ctx, { enabled: true, relayRetryWindowMs: 80 })
  const relay = handlers.find((h) => h.event === 'approval/request')
  if (relay === undefined) return false
  await relay.handler({ agent: child, toolName: 'pwsh' }, async () => 'next-result')
  return approvals.requests.length > 1
}

/**
 * 对一个变异体跑「通知没送达时是否仍然去等窗口」这条探针。
 *
 * @param module - 变异后的模块。
 * @returns 白等了一场（超过窗口的一半）时为 true（异步）。
 */
async function mutantWaitsWithoutNotice(module) {
  const parentSession = fakeSession({ id: 'parent-1', cwd: 'H:\\proj' })
  const childSession = fakeSession({
    id: 'child-1',
    cwd: 'H:\\proj',
    origin: 'subagent',
    parentSession: 'parent-1',
    delegationDepth: 1,
  })
  closeTurn(parentSession)
  const parent = fakeAgent(parentSession)
  const child = fakeAgent(childSession)
  const approvals = fakeApproval(new Map(), async () => {
    throw new Error('approval.request() outside an open turn: ...')
  })
  approvals.effectivePolicy = (session) => (session === parentSession ? 'ask' : 'never')
  // 通知**发不出去** ⇒ 没有任何东西会去唤醒父会话 ⇒ 回合永远不会开。
  const subs = fakeSubagents(async () => {
    throw new Error('direct parent is not live; the message was not delivered')
  })
  const services = {
    approval: approvals,
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
    subagents: subs,
  }
  const { ctx, handlers } = fakeCtx({ services })
  const windowMs = 400
  module.apply(ctx, { enabled: true, relayRetryWindowMs: windowMs })
  const relay = handlers.find((h) => h.event === 'approval/request')
  if (relay === undefined) return false
  const startedAt = Date.now()
  await relay.handler({ agent: child, toolName: 'pwsh' }, async () => 'next-result')
  return Date.now() - startedAt >= windowMs * 0.75
}

let mutantsConfirmed = 0
let mutantsAttempted = 0

/**
 * 跑一个变异体并确认判别力。
 *
 * @param label - 变异名。
 * @param from - 原片段。
 * @param to - 改坏成什么。
 * @param probe - 探针函数（返回 true 表示「用例会红」）。
 * @param guards - 这个变异应当打红的用例名（仅用于报告）。
 */
async function checkMutant(label, from, to, probe, guards) {
  mutantsAttempted += 1
  const made = await mutant(label, from, to)
  if (made.error !== undefined) {
    console.log(`\n!! ${made.error}`)
    return
  }
  const violated = await probe(made.module)
  if (violated) {
    mutantsConfirmed += 1
    console.log(`\n判别力确认：${label}\n  改坏后，「${guards}」会红 —— 该用例不是恒真的。`)
  } else {
    console.log(`\n!! 判别力不足：${label}\n  改坏后，「${guards}」仍然通过，说明用例抓不住这个缺陷。`)
  }
}

await checkMutant(
  '去掉「父会话必须是 ask」的门控',
  "if (parentPolicy !== 'ask') {",
  'if (false) {',
  mutantWritesWhenParentNever,
  'I2 父会话是 never：一个字都不动',
)

await checkMutant(
  '给策略事件带上非法的 source 字段',
  "session.append('approval/policy', { policy: 'ask' })",
  "session.append('approval/policy', { policy: 'ask', source: 'delegation' })",
  mutantWritesSourceField,
  'I1 写进去的事件省略 source',
)

await checkMutant(
  '去掉第一级的「策略必须是 ask」前置',
  "if (effectivePolicyOf(ctx, agent.session) !== 'ask') return downstream",
  'if (false) return downstream',
  mutantAsksUnderNever,
  'I14 策略不是 ask 时绝不返回 ask',
)

await checkMutant(
  '让第一级无视上游的拒绝（抢跑）',
  'const downstream = await next()',
  'const downstream = { kind: "allow" }',
  mutantOverridesDeny,
  'I13 上游已经拒绝：绝不被升级成 ask',
)

await checkMutant(
  '把转呈目标错写成子代理自己',
  "      agent: root,\n      toolName: name,",
  "      agent: undefined,\n      toolName: name,",
  mutantRelaysWrongTarget,
  'I19 转呈的目标必须是父会话',
)

await checkMutant(
  '转呈失败时吞掉错误（不退回原路径）',
  "          }\n          return await next()\n        }\n      },\n      { prepend: true },",
  "          }\n          return 'relay-failure-swallowed'\n        }\n      },\n      { prepend: true },",
  mutantSwallowsRelayFailure,
  'I22 转呈失败：退回原路径',
)

await checkMutant(
  '把「已处理」登记挪回开头（瞬时缺席会永久钉死）',
  '    if (released.has(agent)) return\n',
  '    if (released.has(agent)) return\n    released.add(agent)\n',
  mutantPinsAfterTransientMiss,
  'I4b 瞬时失败必须保持可重试',
)

await checkMutant(
  '把通知挪到 await next() 之后（挂起时永不发出）',
  '          if (relayAttempted) {\n            const notice = notifyRelayFailure({',
  '          if (relayAttempted) {\n            await next()\n            const notice = notifyRelayFailure({',
  mutantNotifiesAfterAwait,
  'I36 下游永不返回时通知仍然发出',
)

await checkMutant(
  '无视失败原因一律重试（会重复询问 / 白等）',
  '      if (!message.includes(OPEN_TURN_REQUIRED_HINT)) {',
  '      if (false) {',
  mutantRetriesAnyFailure,
  'I41 别的失败原因：不重试',
)

await checkMutant(
  '通知没送达也照等窗口（白等一场）',
  '        if (delivered !== true) {',
  '        if (false) {',
  mutantWaitsWithoutNotice,
  'I40 通知没送达：不等窗口',
)

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\napproval-gate 集成探针：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败` +
    `；反向验证判别力：${mutantsConfirmed} / ${mutantsAttempted} 已确认`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
if (mutantsConfirmed !== mutantsAttempted) process.exitCode = 1

