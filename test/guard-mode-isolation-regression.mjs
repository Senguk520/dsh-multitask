/**
 * 减震器「模式隔离」回归校验（进程内，零依赖，不碰 profile、不起服务）。
 *
 * 校验对象：dsh-multitask/presets/multitask/coordinator-guard.mjs
 * 校验目标：限制只允许装在**属于本 preset** 的会话上；别的模式一个工具都不能少。
 *
 * 末尾带**反向验证**：把归属判据改坏（禁用），同一套用例必须变红 ——
 * 否则这些用例就是恒真的、等于没写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 从本文件的位置推导被测模块 —— 所以整个仓库可以放在任何路径下（含非 ASCII 路径）。
// 本文件在 <repo>/test/ 下，被测模块在 <repo>/presets/multitask/ 下。
const here = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(here, '..', 'presets', 'multitask', 'coordinator-guard.mjs')

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

const log = { info: [], warn: [], engaged: [], lifted: [] }

/** 一个会「真的变窄」的工具注册表：restrict 之后 schemas() 就少掉那些名字。 */
function makeSurface(all = FULL) {
  const active = []
  return {
    engaged: active,
    schemas() {
      const denied = new Set()
      for (const r of active) if (!r.disposed) for (const n of r.deny) denied.add(n)
      return all.filter((n) => !denied.has(n)).map((name) => ({ name }))
    },
    restrict({ deny }) {
      const rec = { deny: new Set(deny), disposed: false }
      active.push(rec)
      log.engaged.push([...deny].sort())
      return () => {
        rec.disposed = true
        log.lifted.push([...rec.deny].sort())
      }
    },
    /** 当前实际可见的名字（用来断言「别的模式一个都没少」）。 */
    visible() {
      return this.schemas().map((s) => s.name)
    },
  }
}

function makeCtx() {
  const listeners = new Map()
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    get() {
      return undefined
    },
    logger: {
      info: (m) => log.info.push(m),
      warn: (m) => log.warn.push(m),
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    listenerCount(name) {
      return (listeners.get(name) ?? []).length
    },
  }
}

/**
 * 造一个 agent。
 * @param composed - 该 agent 当前所属的 preset：字符串 / undefined（没加入）/ 'THROW'（读不出来）
 */
function makeAgent({ id, composed, surface, header }) {
  const registry = {
    composedPreset() {
      if (composed === 'THROW') throw new Error('registry exploded')
      return composed
    },
  }
  const agentCtx = {
    tools: surface,
    get(name) {
      if (name === 'agentPresets') return composed === 'MISSING' ? undefined : registry
      return undefined
    },
  }
  return { id, session: { id, header }, ctx: agentCtx }
}

/** 可外部改写的 agent（验证「切换」路径用）。 */
function makeSwitchable({ id, initial, surface }) {
  let mode = initial
  const registry = {
    composedPreset() {
      if (mode === 'THROW') throw new Error('registry exploded')
      return mode
    },
  }
  const agent = { id, session: { id }, ctx: { tools: surface, get: (n) => (n === 'agentPresets' ? registry : undefined) } }
  return { agent, setMode: (next) => { mode = next } }
}

const results = []
function test(name, fn) {
  log.info.length = 0
  log.warn.length = 0
  log.engaged.length = 0
  log.lifted.length = 0
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function boot(mod) {
  const ctx = makeCtx()
  mod.apply(ctx, { enabled: true, presetId: 'multitask', keep: KEEP_CONFIG })
  return ctx
}

function suite(mod, label) {
  console.log(`\n===== ${label} =====`)

  test('T1 归属本 preset 的会话：被收窄，且只摘掉保留集之外的工具', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S1', composed: 'multitask', surface })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 1, `应装 1 条限制，实际 ${surface.engaged.length}`)
    const deny = [...surface.engaged[0].deny]
    for (const must of ['read_image', 'pwsh', 'write', 'edit', 'web_search']) {
      assert(deny.includes(must), `deny 里应当包含 ${must}`)
    }
    for (const keep of ['read', 'grep', 'glob', 'subagent', 'subagent_ptc', 'workflow', 'skill']) {
      assert(!deny.includes(keep), `deny 里不该包含保留集成员 ${keep}`)
    }
    const left = surface.visible()
    assert(left.includes('read') && left.includes('subagent_ptc'), '保留集必须仍然可见')
    assert(!left.includes('read_image'), 'read_image 应已对协调者不可见')
  })

  test('T2 ★ 归属别的模式（standard）的会话：一个工具都不许摘 —— 本轮缺陷', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S2', composed: 'standard', surface })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 0, `不该装任何限制，实际装了 ${surface.engaged.length} 条`)
    const left = surface.visible()
    for (const must of ['read_image', 'pwsh', 'write', 'edit', 'web_search', 'task_board_list']) {
      assert(left.includes(must), `standard 会话的 ${must} 被削掉了`)
    }
    assert(left.length === FULL.length, `工具数应保持 ${FULL.length}，实际 ${left.length}`)
  })

  test('T3 ★ 从 Multitask 切走：已装上的限制必须被解除', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const { agent, setMode } = makeSwitchable({ id: 'S3', initial: 'multitask', surface })

    ctx.emit('agent/created', { agent })
    assert(surface.engaged.length === 1, '先决条件：应已装上限')
    assert(!surface.visible().includes('read_image'), '先决条件：read_image 应已被摘')

    // 用户把该会话切到 standard：注册表广播 `agent-preset/selected`
    setMode('standard')
    ctx.emit('agent-preset/selected', 'S3', 'standard')

    assert(surface.engaged[0].disposed === true, '限制应已被 dispose')
    const left = surface.visible()
    assert(left.includes('read_image') && left.includes('pwsh'), '切换后 read_image / pwsh 必须恢复可见')
    assert(left.length === FULL.length, `切换后工具数应恢复到 ${FULL.length}，实际 ${left.length}`)
  })

  test('T4 被委派的子代理：从不收窄', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S4', composed: 'multitask', surface, header: { origin: 'subagent', delegationDepth: 1 } })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 0, '子代理不该被收窄')
    assert(surface.visible().length === FULL.length, '子代理必须保有完整工具面')
  })

  test('T5 没加入任何 preset：不收窄，也不报错', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S5', composed: undefined, surface })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 0, '没加入 preset 的 agent 不该被收窄')
    assert(surface.visible().length === FULL.length, '工具面应保持完整')
  })

  test('T6 ★ 读不出所属 preset：宁可不收窄，也不能削到别的模式', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S6', composed: 'THROW', surface })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 0, '读不出归属时不该收窄')
    assert(surface.visible().length === FULL.length, '工具面应保持完整')
    assert(log.warn.some((m) => m.includes('could not read which preset')), '应当留下一条说明原因的警告')
  })

  test('T7 ★ 收窄在先、随后读不出归属：也要解除（不能留在早退路径之后）', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const { agent, setMode } = makeSwitchable({ id: 'S7', initial: 'multitask', surface })

    ctx.emit('agent/created', { agent })
    assert(surface.engaged.length === 1, '先决条件：应已装上限')

    setMode('THROW')
    ctx.emit('tools/post-execute', { agent }, null, () => ({ kind: 'accept' }))

    assert(surface.engaged[0].disposed === true, '读不出归属时也应解除先前装上的限制')
  })

  test('T8 自愈路径：归属仍是本 preset 时重算', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S8', composed: 'multitask', surface })
    ctx.emit('agent/created', { agent })
    const first = surface.engaged.length
    ctx.emit('tools/post-execute', { agent }, null, () => ({ kind: 'accept' }))
    assert(surface.engaged.length > first, '自愈路径应当重算并重装限制')
    assert(!surface.visible().includes('read_image'), '重算后 read_image 仍应不可见')
  })

  test('T9 tools/change 广播：遍历在册 agent 做全量重判', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S9', composed: 'multitask', surface })
    ctx.emit('agent/created', { agent })
    const before = surface.engaged.length
    ctx.emit('tools/change')
    assert(
      surface.engaged.length > before || surface.engaged[before - 1].disposed,
      'tools/change 应触发重判',
    )
  })

  test('T10 装载即注册了切换与工具变化两条广播监听', () => {
    const ctx = boot(mod)
    assert(ctx.listenerCount('agent-preset/selected') === 1, '应监听 agent-preset/selected')
    assert(ctx.listenerCount('tools/change') === 1, '应监听 tools/change')
    assert(ctx.listenerCount('agent/created') === 1, '应监听 agent/created')
    assert(ctx.listenerCount('tools/post-execute') === 1, '应监听 tools/post-execute')
    assert(ctx.listenerCount('agent/disposed') === 1, '应监听 agent/disposed')
  })

  test('T11 ★ 从别的模式切进 Multitask：应立刻收窄（该 agent 从不在册）', () => {
    const surface = makeSurface()
    const { agent, setMode } = makeSwitchable({ id: 'S11', initial: 'standard', surface })

    // 宿主面服务：广播只给 session id，切进来的 agent 得靠它找回
    const ctx = makeCtx()
    ctx.get = (name) => (name === 'agents' ? { get: (id) => (id === 'S11' ? agent : undefined) } : undefined)
    mod.apply(ctx, { enabled: true, presetId: 'multitask', keep: KEEP_CONFIG })

    // 先在 standard 下出现：不该被收窄
    ctx.emit('agent/created', { agent })
    assert(surface.engaged.length === 0, '先决条件：standard 阶段不该被收窄')

    // 用户把它切成 Multitask
    setMode('multitask')
    ctx.emit('agent-preset/selected', 'S11', 'multitask')

    assert(surface.engaged.length === 1, '切进 Multitask 后应立刻装上限')
    assert(!surface.visible().includes('read_image'), '切进来之后 read_image 应被摘掉')
  })

  test('T12 活绑定读不出来、会话头写着本模式：按会话头收窄（新建会话的时序退路）', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S12', composed: 'MISSING', surface, header: { agentPreset: 'multitask' } })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 1, '会话头写着本模式时应收窄（否则主功能会静默失效）')
    assert(!surface.visible().includes('read_image'), 'read_image 应已被摘')
    assert(log.warn.some((m) => m.includes('could not read which preset')), '应留下一条说明用了退路的警告')
  })

  test('T13 ★ 活绑定是别的模式、但会话头仍写着本模式：必须听活绑定（不许收窄）', () => {
    const ctx = boot(mod)
    const surface = makeSurface()
    const agent = makeAgent({ id: 'S13', composed: 'standard', surface, header: { agentPreset: 'multitask' } })
    ctx.emit('agent/created', { agent })

    assert(surface.engaged.length === 0, '活绑定说它属于 standard，就不许收窄 —— 会话头是过期信息')
    assert(surface.visible().length === FULL.length, `工具面应保持完整，实际 ${surface.visible().length}`)
  })
}

// ── 正向：当前实现 ────────────────────────────────────────────────────────────
const live = await import(pathToFileURL(GUARD).href)
const liveFrom = results.length
suite(live, '当前实现')
const liveResults = results.slice(liveFrom)

// ── 反向：把归属判据禁用掉，同一套用例必须变红 ─────────────────────────────────
const source = fs.readFileSync(GUARD, 'utf8')
const needle = 'if (owner !== presetId) {'
let mutantOk = false
if (!source.includes(needle)) {
  console.log(`\n!! 找不到用于变异的字符串，反向验证无法进行: ${needle}`)
} else {
  const mutated = source.replace(needle, 'if (false) {')
  const url = 'data:text/javascript;base64,' + Buffer.from(mutated, 'utf8').toString('base64')
  const mutant = await import(url)
  const before = results.length
  suite(mutant, '反向验证（已禁用归属判据 —— 应当变红）')
  const mutantResults = results.slice(before)
  const reds = mutantResults.filter((r) => !r.ok).map((r) => r.name.split(' ')[0])
  mutantOk = reds.length > 0
  console.log(
    mutantOk
      ? `\n判别力确认：禁用归属判据后 ${reds.length} 条用例变红（${reds.join(', ')}）—— 这些用例不是恒真的。`
      : '\n!! 判别力不足：禁用归属判据后没有任何用例变红，说明用例抓不住这个缺陷。',
  )
}

// ── 汇总（只按「当前实现」那一段的成败判定；反向验证里的红是预期的）──────────
const failed = liveResults.filter((r) => !r.ok)
console.log(
  `\n当前实现：${liveResults.length} 条断言组，${liveResults.length - failed.length} 通过，${failed.length} 失败` +
    `；反向验证判别力：${mutantOk ? '已确认' : '未确认'}`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
if (!mutantOk) process.exitCode = 1
