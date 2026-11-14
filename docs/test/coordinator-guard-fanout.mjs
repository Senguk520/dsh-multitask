/**
 * 协调者守卫「装限制不该有副作用」回归校验（进程内，零依赖，不 spawn、不写盘）。
 *
 * 校验对象：dsh-multitask/presets/multitask/coordinator-guard.mjs
 *
 * 缺陷：`sync()` 原来是「先 release 再读 schemas 再 restrict」。`dispose()` 与
 * `restrict()` 在宿主里都**同步** emit `tools/change`，而 `tools/change` 的处理是
 * 「遍历全部在册 agent 重算」—— 于是一次宿主广播会被守卫自己的动作放大成阶乘级
 * 重算（N 个会话 → 指数级递归）。重算闸门只能封顶，做不到「零副作用」。
 *
 * 修法（本测试要钉住的性质）：目标 deny 集与已装的一致时，**一次调用都不发** ——
 * 既不 dispose、也不 restrict、更不自打广播。
 *
 * 桩必须复刻的两条宿主契约（缺陷成立的前提）：
 *   · `tools.restrict({ deny })` 在返回前同步 emit `tools/change`；
 *   · 它返回的 disposer 被调用时也同步 emit `tools/change`。
 * 熔断 CAP = 10N + 100：自打广播超限就停发并置 overflow（旧代码在 N=12 上根本跑不完）。
 *
 * 用法：
 *   node test/coordinator-guard-fanout.mjs           # 正向用例（默认不碰 fixtures）
 *   node test/coordinator-guard-fanout.mjs --prove   # 另加判别力验证：修复前的守卫必须 overflow
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(here, '..', '..', 'presets', 'multitask', 'coordinator-guard.mjs')
const PREFIX_FIXTURE = path.join(here, 'fixtures', 'coordinator-guard-prefix.mjs')
/** 修复前的守卫（本轮快路之前、且没有 pass 闸门的那一版）。 */
const PREFIX_COMMIT = 'd9e4fe8'

const PROVE = process.argv.includes('--prove')

/** 一个真实的宽工具面（取自线上 worker 会话的实测名单，44 个）。 */
const FULL = [
  'ask_user_question', 'create_goal', 'edit', 'exit_plan_mode', 'file_info', 'get_goal',
  'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents',
  'load_workspace_dependencies', 'present', 'pwsh', 'read', 'read_image', 'send_message',
  'skill', 'ssh_cluster', 'ssh_download', 'ssh_exec', 'ssh_list', 'ssh_tunnel', 'ssh_upload',
  'subagent', 'subagent_fork', 'subagent_minimal', 'subagent_ptc', 'task_board_create',
  'task_board_get', 'task_board_list', 'task_board_manage', 'task_board_run',
  'task_board_schedule', 'task_board_set_parent', 'task_board_update', 'todo_write',
  'update_goal', 'web_fetch', 'web_search', 'workflow', 'write',
]

const KEEP_CONFIG = ['subagent_ptc', 'subagent_minimal']
const CONFIG = { enabled: true, presetId: 'multitask', keep: KEEP_CONFIG }
const capOf = (n) => 10 * n + 100

// ── 报告骨架 ──────────────────────────────────────────────────────────────────
const results = []
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}
const names = (set) => [...set].sort().join(',')

let stopNow = false

/**
 * 跑一条用例。
 *
 * @param label - 用例名（打印用）。
 * @param body - 断言体（可为 async）；返回值作为附注打印。
 * @param hardStop - 失败后是否立即停止（用例 1 的停止条件）。
 * @returns 是否通过。
 */
async function test(label, body, { hardStop = false } = {}) {
  try {
    const note = await body()
    results.push({ label, ok: true })
    console.log(`PASS  ${label}${typeof note === 'string' && note !== '' ? `  — ${note}` : ''}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ label, ok: false, message })
    console.log(`FAIL  ${label}  — ${message}`)
    if (hardStop) {
      stopNow = true
      console.log('\n!! 停止条件命中（用例 1 必须是 0/0/0）：不再执行后续用例，也不放宽断言。')
    }
    return false
  }
}

// ── 世界：假 ctx + 假 tools 面 ─────────────────────────────────────────────────
/**
 * 自打一次广播。超过熔断线后不再 emit，只把 overflow 置起来 ——「停不下来」本身就是结论。
 */
function fire(state) {
  state.emit += 1
  if (state.emit > state.cap) {
    state.overflow = true
    return
  }
  state.ctx.emit('tools/change')
}

/** 一个会「真的变窄」的 scoped 工具面：装/卸都同步 emit `tools/change`。 */
function makeSurface(state) {
  const rec = { active: [], restrict: 0, dispose: 0, throwNext: false, throwOnRestrictRead: false }
  const restrictTool = ({ deny }) => {
    state.restrictCalls += 1
    rec.restrict += 1
    // 用例 5：模拟 roster 竞态 —— `restrict()` 对未知名字抛错（宿主契约）。
    if (rec.throwNext) {
      rec.throwNext = false
      throw new Error('tools.restrict() names unknown global tool "ghost_tool"')
    }
    const entry = { deny: new Set(deny), disposed: false }
    rec.active.push(entry)
    fire(state) // 宿主契约：装层之后立刻 emit（同步，返回前）。
    return () => {
      state.disposeCalls += 1
      rec.dispose += 1
      if (entry.disposed) return
      entry.disposed = true
      fire(state) // 宿主契约：卸层也 emit（同步）。
    }
  }
  const surface = {
    rec,
    schemas() {
      const denied = new Set()
      for (const r of rec.active) if (!r.disposed) for (const n of r.deny) denied.add(n)
      return state.roster.filter((n) => !denied.has(n)).map((name) => ({ name }))
    },
    /** 未 dispose 的记录 = 当前真的生效着的限制（用来断言「账」写成什么样）。 */
    live() {
      return rec.active.filter((r) => !r.disposed)
    },
  }
  // `restrict` 走 getter 而不是普通属性，是为了给用例 9 造**真的会穿出 sync()** 的异常：
  // `sync()` 在调 `restrict()` 之前先读一次 `typeof scoped?.restrict`（那一读在
  // `install()` 自己的 try 之外），所以「读就抛」能一路冒到 pass() 之外 —— 这正是
  // post-execute 处理器必须兜住、并且不得借机截断瀑布的那种形态。
  // （`restrict()` 调用本身抛错不会冒出去：`install()` 内部有 try/catch，所以那样
  // 造出来的用例对瀑布毫无判别力。）
  Object.defineProperty(surface, 'restrict', {
    get() {
      if (rec.throwOnRestrictRead) {
        rec.throwOnRestrictRead = false
        throw new Error('tools.restrict() could not be read (roster race)')
      }
      return restrictTool
    },
  })
  // `view()` 只在需要快路的世界里提供 —— 去掉它就是「旧宿主 / 测试桩」那种慢路。
  // `state.restrictable` 给出时用它（用例 8 要「可见面 ≠ 可摘面」），否则与 roster 一致。
  if (state.view) surface.view = () => ({ restrictableNames: new Set(state.restrictable ?? state.roster) })
  return surface
}

/** 假 ctx：只要 `on` / `get` / `logger` / `emit`（与守卫实际用到的面一致）。 */
function makeCtx(state) {
  const listeners = new Map()
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    get(name) {
      return name === 'agentPresets' ? { composedPreset: () => 'multitask' } : undefined
    },
    logger: {
      info: (m) => state.info.push(m),
      warn: (m) => state.warn.push(m),
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    listenerCount(name) {
      return (listeners.get(name) ?? []).length
    },
    /** 取出注册在该事件上的原始处理器（用例 9 要**直接调**瀑布那一环）。 */
    handlers(name) {
      return [...(listeners.get(name) ?? [])]
    },
  }
}

/** 造一个归属本 preset 的协调者 agent（`composedPreset()` 返回 'multitask'）。 */
function makeAgent(state, id, header) {
  const surface = makeSurface(state)
  const registry = { composedPreset: () => 'multitask' }
  const agent = {
    id,
    session: { id },
    ctx: {
      tools: surface,
      get: (n) => (n === 'agentPresets' ? registry : undefined),
    },
  }
  if (header !== undefined) agent.session.header = header
  agent.surface = surface
  return agent
}

/**
 * 建一个独立世界：apply 一次守卫，然后按宿主的方式逐个 emit `agent/created` 装填 N 个协调者。
 *
 * @param restrictable - 可选：`view().restrictableNames` 的自定义取值。缺省 = 整个 roster
 *   （即「可见面 == 可摘面」）。给出时用来造「可见面里有、可摘面里没有」的名字。
 */
function boot(mod, { n, view = true, restrictable }) {
  const state = {
    n,
    view,
    restrictable,
    cap: capOf(n),
    roster: [...FULL],
    emit: 0,
    overflow: false,
    restrictCalls: 0,
    disposeCalls: 0,
    warn: [],
    info: [],
  }
  const ctx = makeCtx(state)
  state.ctx = ctx
  mod.apply(ctx, CONFIG)
  const agents = []
  for (let i = 0; i < n; i += 1) {
    const agent = makeAgent(state, `S${i}`)
    agents.push(agent)
    ctx.emit('agent/created', { agent })
  }
  state.fill = { restrict: state.restrictCalls, dispose: state.disposeCalls, emit: state.emit }
  return { state, ctx, agents }
}

/** 归零计数：被测的是「一切稳定之后，宿主再 emit 一次」那一次扇出。 */
function reset(state) {
  state.restrictCalls = 0
  state.disposeCalls = 0
  state.emit = 0
  state.overflow = false
}

/** 让宿主 emit 一次「某个 agent 的工具调用结束了」——守卫的自愈入口。 */
function postExecute(ctx, agent) {
  ctx.emit('tools/post-execute', { agent }, undefined, () => undefined)
}

/** 打印每个 agent 的 deny 账（只在用例 1 失败时用；刻意不做任何「修正」）。 */
function dumpDenyDiff(agents) {
  const base = agents[0]?.surface.live()[0]?.deny
  console.log('\n── installed.deny 明细（用例 1 不是 0 时才打印）──────────────────────────')
  for (const agent of agents) {
    const live = agent.surface.live()
    const deny = live.length === 0 ? undefined : live[live.length - 1].deny
    const size = deny === undefined ? '（无生效限制）' : `size=${deny.size}`
    console.log(`  ${agent.id}: live=${live.length} ${size} restrict=${agent.surface.rec.restrict} dispose=${agent.surface.rec.dispose}`)
    if (deny !== undefined && base !== undefined) {
      const onlyTarget = [...deny].filter((n) => !base.has(n))
      const onlyInstalled = [...base].filter((n) => !deny.has(n))
      if (onlyTarget.length > 0 || onlyInstalled.length > 0) {
        console.log(`    与 S0 的 deny 对称差：只在该 agent=${onlyTarget.sort().join(',') || '-'} 只在 S0=${onlyInstalled.sort().join(',') || '-'}`)
      }
    }
  }
  console.log('─────────────────────────────────────────────────────────────────────────')
}

// ── 正向用例（当前实现）───────────────────────────────────────────────────────
const modUrl = pathToFileURL(GUARD).href
const ns = await import(modUrl)
const mod = typeof ns.default?.apply === 'function' ? ns.default : ns

// 用例 1：装好之后，一次 tools/change 必须零副作用。
await test(
  'T1 零副作用：稳定后一次 tools/change ⇒ restrict=0 / dispose=0 / emit=0',
  () => {
    const { state, ctx, agents } = boot(mod, { n: 12 })
    assert(state.fill.restrict >= 12, `先决条件：装填期必须真的装过限制，实际 restrict=${state.fill.restrict}`)
    reset(state)
    ctx.emit('tools/change')
    if (state.restrictCalls !== 0 || state.disposeCalls !== 0 || state.emit !== 0) {
      console.log(`     实测 restrict=${state.restrictCalls} dispose=${state.disposeCalls} emit=${state.emit}（要求全部为 0）`)
      dumpDenyDiff(agents)
      assert(false, `零副作用被破坏：restrict=${state.restrictCalls} dispose=${state.disposeCalls} emit=${state.emit}`)
    }
    return `restrict=0 dispose=0 emit=0（装填期 restrict=${state.fill.restrict}）`
  },
  { hardStop: true },
)

if (!stopNow) {
  // 用例 2：再来一次仍必须零副作用（幂等）。
  await test('T2 幂等：再 emit 一次 ⇒ 仍 restrict=0 / dispose=0 / emit=0', () => {
    const { state, ctx } = boot(mod, { n: 12 })
    assert(state.fill.restrict >= 12, `先决条件：装填期必须真的装过限制，实际 restrict=${state.fill.restrict}`)
    reset(state)
    ctx.emit('tools/change')
    ctx.emit('tools/change')
    assert(
      state.restrictCalls === 0 && state.disposeCalls === 0 && state.emit === 0,
      `两次广播后仍应为 0/0/0，实际 restrict=${state.restrictCalls} dispose=${state.disposeCalls} emit=${state.emit}`,
    )
    return `两次广播 0/0/0`
  })

  // 用例 3：工具面真的变了 —— 每个 agent 恰好重装一次。
  await test('T3 真实变更只装一次：新增一个工具名 ⇒ restrict=N / dispose=N，且 deny 都含新名字', () => {
    const n = 12
    const NEW_TOOL = 'brand_new_tool'
    const { state, ctx, agents } = boot(mod, { n })
    assert(state.fill.restrict >= n, `先决条件：装填期必须真的装过限制，实际 restrict=${state.fill.restrict}`)

    state.roster.push(NEW_TOOL)
    // 每个 agent 的账是整局累计的（含装填期），所以这里量的是**增量**。
    const before = agents.map((a) => ({ restrict: a.surface.rec.restrict, dispose: a.surface.rec.dispose }))
    reset(state)
    ctx.emit('tools/change')

    assert(state.restrictCalls === n, `应恰好 restrict ${n} 次，实际 ${state.restrictCalls}`)
    assert(state.disposeCalls === n, `应恰好 dispose ${n} 次，实际 ${state.disposeCalls}`)
    assert(state.overflow === false, '不该触发熔断（一次变更只需一轮）')

    let liveTotal = 0
    agents.forEach((agent, i) => {
      const live = agent.surface.live()
      assert(live.length === 1, `${agent.id} 应恰好有 1 条生效限制，实际 ${live.length}`)
      liveTotal += live.length
      assert(live[0].deny.has(NEW_TOOL), `${agent.id} 的 deny 应含新工具 ${NEW_TOOL}`)
      assert(
        agent.surface.rec.restrict - before[i].restrict === 1,
        `${agent.id} 应只被 restrict 一次，实际 ${agent.surface.rec.restrict - before[i].restrict}`,
      )
      assert(
        agent.surface.rec.dispose - before[i].dispose === 1,
        `${agent.id} 应只被 dispose 一次，实际 ${agent.surface.rec.dispose - before[i].dispose}`,
      )
    })
    return `restrict=${state.restrictCalls} dispose=${state.disposeCalls} 生效限制=${liveTotal}，全部含 ${NEW_TOOL}`
  })

  // 用例 4：子代理不连坐 —— 它既不被收窄，也不会因为它的重算去动别人。
  await test('T4 子代理不连坐：对 subagent emit tools/post-execute ⇒ 它不收到 restrict，其它 agent dispose 增量 0', () => {
    const n = 4
    const { state, ctx, agents } = boot(mod, { n })
    const sub = makeAgent(state, 'CHILD', { origin: 'subagent' })
    ctx.emit('agent/created', { agent: sub })
    assert(sub.surface.rec.restrict === 0, `先决条件：子代理在 agent/created 时就不该被 restrict，实际 ${sub.surface.rec.restrict}`)

    const before = agents.map((a) => a.surface.rec.dispose)
    reset(state)
    postExecute(ctx, sub)

    assert(sub.surface.rec.restrict === 0, `子代理不该收到 restrict，实际 ${sub.surface.rec.restrict}`)
    assert(sub.surface.live().length === 0, `子代理不该有生效限制，实际 ${sub.surface.live().length}`)
    assert(state.disposeCalls === 0, `其它 agent 的 dispose 增量应为 0，实际 ${state.disposeCalls}`)
    assert(state.emit === 0, `不该自打广播，实际 emit=${state.emit}`)
    agents.forEach((a, i) => assert(a.surface.rec.dispose === before[i], `${a.id} 的 dispose 不该增长`))
    return `子代理 restrict=0，其它 ${n} 个 agent dispose 增量 0，emit=0`
  })

  // 用例 5：fail-open —— 慢路照样装；装失败不留账，下一个窗口能补上。
  await test('T5 fail-open：无 view() 走慢路仍装；restrict 抛错不写账，下一次 post-execute 重装成功', () => {
    const n = 3
    const { state, ctx, agents } = boot(mod, { n, view: false })
    assert(state.fill.restrict >= n, `慢路在装填期应装上（≥${n} 次 restrict），实际 ${state.fill.restrict}`)

    const victim = agents[0]
    assert(victim.surface.live().length === 1, `先决条件：${victim.id} 应有 1 条生效限制，实际 ${victim.surface.live().length}`)

    // ① 让它的下一次 restrict 抛错（roster 竞态的形态）。
    victim.surface.rec.throwNext = true
    reset(state)
    postExecute(ctx, victim)

    assert(victim.surface.live().length === 0, `restrict 抛错后不该写账（生效限制应为 0），实际 ${victim.surface.live().length}`)
    assert(
      state.warn.some((m) => m.includes('engaging the coordinator restriction failed')),
      '应留下一条「装限制失败」的告警（响亮失败，不静默降级）',
    )

    // ② 下一个窗口必须能重装成功（fail-open，不拦会话）。
    reset(state)
    postExecute(ctx, victim)

    assert(victim.surface.live().length === 1, `下一个窗口应重装成功，实际生效限制 ${victim.surface.live().length}`)
    const deny = victim.surface.live()[0].deny
    assert(deny.has('write') && deny.has('pwsh'), '重装后的 deny 应含 write / pwsh')
    assert(victim.surface.rec.restrict >= 2, `restrict 应被再调一次，实际 ${victim.surface.rec.restrict}`)
    return `慢路装填 restrict=${state.fill.restrict}；抛错后 0 条生效限制 → 下一个窗口重装 1 条（deny=${deny.size}）`
  })

  // 用例 6：不许有闸门未收敛的噪声（那说明「零调用」没做到，只是被闸门压住了）。
  await test('T6 无 UNSETTLED 噪声：稳定后多轮事件 ⇒ 全程不出现 MULTITASK-GUARD-UNSETTLED', () => {
    const n = 12
    const { state, ctx, agents } = boot(mod, { n })
    assert(state.fill.restrict >= n, `先决条件：装填期必须真的装过限制，实际 ${state.fill.restrict}`)
    reset(state)

    for (let round = 0; round < 3; round += 1) ctx.emit('tools/change')
    for (const agent of agents) postExecute(ctx, agent)
    for (const agent of agents) ctx.emit('agent-preset/selected', agent.id, 'multitask')

    const noisy = state.warn.filter((m) => m.includes('MULTITASK-GUARD-UNSETTLED'))
    assert(noisy.length === 0, `不该出现闸门未收敛告警，实际 ${noisy.length} 条：${noisy[0] ?? ''}`)
    assert(state.overflow === false, '不该触发熔断')
    assert(
      state.restrictCalls === 0 && state.disposeCalls === 0 && state.emit === 0,
      `稳定后所有事件都应零副作用，实际 restrict=${state.restrictCalls} dispose=${state.disposeCalls} emit=${state.emit}`,
    )
    return `warn 共 ${state.warn.length} 条，无 UNSETTLED；restrict=0 dispose=0 emit=0`
  })

  // 用例 8：快路的 unpickable 判据必须与慢路一致 —— 只报「本想摘却摘不掉」的名字。
  //
  // 两条子用例合起来证明谓词的两条腿都在：
  //   ① keep 类（own-scope 的 `list_agents`）在可见面里、却不在可摘面里 ⇒ **不许**报
  //      （旧判据只看「可摘面里没有」，会把它当假警报出来，误导取证）；
  //   ② deny 类（`write`）在可见面里、却不在可摘面里 ⇒ **必须**报
  //      （只加了 keep 这条腿、把整类都吞掉的实现会红在这里）。
  await test('T8 快路判据：keep 类不在可摘面 ⇒ 不报 scope-local；deny 类不在可摘面 ⇒ 必须报', () => {
    const saidScopeLocal = (state) => state.warn.filter((m) => m.includes('scope-local'))

    // ① keep 侧：`list_agents` 是可摘面里**没有**的 keep 名字（模拟注册在 own scope 上）。
    const keepCase = boot(mod, { n: 1, restrictable: FULL.filter((name) => name !== 'list_agents') })
    const keepWarns = saidScopeLocal(keepCase.state)
    assert(
      keepCase.state.fill.restrict === 1,
      `先决条件：这条世界必须真的走快路并装上限制，实际 restrict=${keepCase.state.fill.restrict}`,
    )
    assert(
      keepWarns.length === 0,
      `keep 类名字不在 restrictableNames 里时**不该**报 scope-local（它本来就要留着），` +
        `实际报了 ${keepWarns.length} 条：${keepWarns.join(' | ')}`,
    )

    // ② deny 侧：`write` 既不在 keep 里、也不在可摘面里 —— 这才是真正摘不掉的那一个。
    const denyCase = boot(mod, { n: 1, restrictable: FULL.filter((name) => name !== 'write') })
    const denyWarns = saidScopeLocal(denyCase.state)
    assert(
      denyCase.state.fill.restrict === 1,
      `先决条件：这条世界必须真的走快路并装上限制，实际 restrict=${denyCase.state.fill.restrict}`,
    )
    assert(
      denyWarns.length === 1,
      `deny 类名字（write）不在 restrictableNames 里时**必须**报一条 scope-local，实际 ${denyWarns.length} 条`,
    )
    assert(
      denyWarns[0].includes('write'),
      `scope-local 告警里应点名 write，实际：${denyWarns[0]}`,
    )
    assert(
      !denyWarns[0].includes('list_agents'),
      `scope-local 告警不该连带 keep 类名字，实际：${denyWarns[0]}`,
    )
    return `keep 侧 0 条（list_agents 不再假警）；deny 侧 1 条且点名 write`
  })

  // 用例 9：post-execute 瀑布的完整性 —— 重算出意外时**不得**截断瀑布。
  //
  // 缺陷形态（desktop 上刚整片炸过的那种）：`pass(...)` 抛错 ⇒ `return next()` 不执行 ⇒
  // 瀑布返回 `undefined` ⇒ 宿主读 `result.kind` 抛 `Cannot read properties of undefined`。
  await test('T9 瀑布完整性：sync 抛错时 tools/post-execute 仍返回 next 的结果（且不是 undefined）', () => {
    const { state, ctx } = boot(mod, { n: 1 })
    const handlers = ctx.handlers('tools/post-execute')
    assert(handlers.length === 1, `应恰好注册 1 个 tools/post-execute 处理器，实际 ${handlers.length}`)
    const handler = handlers[0]
    const nextOnce = () => ({ kind: 'accept', ok: 7 })

    // 对照：没有任何意外时，处理器同样返回 next 的结果（证明下面比较的是同一个语义）。
    const control = handler({ agent: undefined }, { kind: 'accept' }, nextOnce)
    assert(
      control?.kind === 'accept' && control?.ok === 7,
      `对照：正常路径应原样返回 next() 的结果，实际 ${JSON.stringify(control)}`,
    )

    // 真正的意外：一个新 agent（还没装过限制）在快路上读 `restrict` 时抛错 ——
    // 这一读位于 `install()` 的 try 之外，所以异常会穿出 `pass()` 冒到处理器。
    const victim = makeAgent(state, 'BOOM')
    victim.surface.rec.throwOnRestrictRead = true

    const warnBefore = state.warn.length
    let returned
    let thrown
    try {
      returned = handler({ agent: victim }, { kind: 'accept' }, nextOnce)
    } catch (error) {
      thrown = error
    }

    assert(thrown === undefined, `处理器把异常抛了出去（瀑布被截断）：${thrown?.message}`)
    assert(
      returned !== undefined,
      '处理器返回了 undefined —— 宿主读 result.kind 会抛 "Cannot read properties of undefined (reading \'kind\')"，整片工具不可用',
    )
    assert(
      returned?.kind === 'accept' && returned?.ok === 7,
      `异常之后仍必须返回 next() 的结果 {kind:'accept',ok:7}，实际 ${JSON.stringify(returned)}`,
    )
    const newWarns = state.warn.slice(warnBefore)
    assert(
      newWarns.some((m) => m.includes('recomputing the coordinator restriction after a tool call failed')),
      `异常不该被静默吞掉：应留下一条「重算失败」的告警，实际新增 ${newWarns.length} 条：${newWarns.join(' | ')}`,
    )

    // 闸门必须已解锁：下一次正常 tool call 仍能重算并装上限制（finally 复位生效）。
    const restrictBefore = victim.surface.rec.restrict
    const after = handler({ agent: victim }, { kind: 'accept' }, nextOnce)
    assert(after?.ok === 7, `闸门解锁后的下一次调用也应返回 next() 的结果，实际 ${JSON.stringify(after)}`)
    assert(
      victim.surface.rec.restrict === restrictBefore + 1,
      `上一次抛错不得卡死 pass 闸门：下一次调用应真的装一次限制（restrict 应 +1），实际增量 ${victim.surface.rec.restrict - restrictBefore}`,
    )
    return `异常后仍返回 ${JSON.stringify(returned)}（不是 undefined），且下一次调用重装成功`
  })
}

// ── 判别力（--prove）：修复前的守卫必须被这条世界抓住 ─────────────────────────
if (PROVE) {
  /**
   * 把修复前的守卫落到 fixtures 里（默认模式不碰它）。
   *
   * `git show` 的输出**直接写进文件描述符**而不是走管道：本仓库的受限运行环境里
   * 子进程管道不可用（EPERM），写 fd 只依赖已打开的文件，不受影响。
   */
  const ensurePrefixFixture = () => {
    if (fs.existsSync(PREFIX_FIXTURE)) return PREFIX_FIXTURE
    fs.mkdirSync(path.dirname(PREFIX_FIXTURE), { recursive: true })
    const fd = fs.openSync(PREFIX_FIXTURE, 'w')
    try {
      execFileSync('git', ['show', `${PREFIX_COMMIT}:presets/multitask/coordinator-guard.mjs`], {
        cwd: path.join(here, '..', '..'),
        stdio: ['ignore', fd, 'inherit'],
      })
    } finally {
      fs.closeSync(fd)
    }
    return PREFIX_FIXTURE
  }

  await test('T7 判别力：修复前的守卫在同一 world（N=12）上必须熔断（overflow=true）', async () => {
    let fixture
    try {
      fixture = ensurePrefixFixture()
    } catch (error) {
      assert(false, `生成 fixtures 失败（${PREFIX_COMMIT} 的守卫）：${error instanceof Error ? error.message : String(error)}`)
    }
    const prefixNs = await import(pathToFileURL(fixture).href)
    const prefixMod = typeof prefixNs.default?.apply === 'function' ? prefixNs.default : prefixNs
    const { state, ctx } = boot(prefixMod, { n: 12 })
    assert(state.fill.restrict >= 12, `先决条件：修复前的守卫装填期也应装上，实际 ${state.fill.restrict}`)

    reset(state)
    ctx.emit('tools/change')
    assert(
      state.overflow === true,
      `修复前的守卫应把一次 tools/change 放大到熔断（cap=${state.cap}），实际 emit=${state.emit} overflow=${state.overflow}`,
    )
    return `修复前：一次 tools/change 自打广播 > ${state.cap} 次，overflow=true（当前实现为 0）`
  })
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\n${PROVE ? '（含 --prove 判别力）' : '（默认模式）'}${results.length} 条用例，` +
    `${results.length - failed.length} 通过，${failed.length} 失败`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.label}: ${f.message}`)
  process.exitCode = 1
}
