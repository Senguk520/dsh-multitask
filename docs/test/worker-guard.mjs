/**
 * worker 委派工具摘除的回归（进程内、零依赖、不加载 DSH）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * 本模式的委派深度固定 1，worker 再往下派一律被拒，逐字文本是
 * `Error: subagent depth 2 exceeds maxDepth 1`。但拒绝发生在**调用之后** ——
 * 在那之前，5 个委派工具的完整 schema 一直挂在 worker 目录里，跟着**每一次请求**重发。
 *
 * 实测（本机 726 个 worker 会话，读 `request/header` 的 `tools` 数组，非 worker 自述）：
 *
 *   - 575 个（79.2%）worker 的目录里挂着 `subagent*`；
 *   - 这 5 个合计 6,266 字符 = 全工具面 worker 底噪（52,445 字符）的 11.9%；
 *   - 同时实测到 184 次 `depth 2 exceeds maxDepth 1` 的拒绝。
 *
 * 所以摘掉它们**不损失任何能力**，只省 token。
 *
 * ── 它守的三条边界（这三条比「省了多少」更重要）─────────────────────────────
 *
 *   1. **只摘必然失败的。** 判据是「拿掉它会不会让 worker 少干成一件事」。
 *      `interrupt_agent` / `send_message` / `list_agents` 同样没什么用，但不属于
 *      「必然被拒」，写进来就变成用一个猜测换 token —— 所以本文件反向钉住它们必须在。
 *   2. **不能抛错。** 上游删除 `toolFilter` 的教训：写死的名字在别的部署里可能不存在，
 *      而 `restrict()` 对不存在的名字抛错，且它在委派窗口里被调用 —— 抛出来表现为
 *      「委派功能坏了」。所以 `deny` 必须是「黑名单 ∩ 可见集」。
 *   3. **不碰协调者、不碰 minimal。** 协调者归 `coordinator-guard`，minimal 归
 *      `minimal-guard`（白名单里本来就没有委派工具）。
 *
 * ⚠️ 本文件的用例**全是同步的**，但沿用了「入队 + 逐个执行」的形状，以便与
 * 同目录其他脚本一致（async 用例不 await 会把失败记成通过，本仓 README 写过这个坑）。
 *
 * @module dsh-multitask/test/worker-guard
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(here, '..', '..', 'presets', 'multitask', 'worker-guard.mjs')

/** minimal worker 的 provider 名 —— 与 `minimal-guard.mjs` 逐字一致。 */
const MINIMAL_PROVIDER = 'multitask_minimal'

/** 本测试期望被摘掉的 5 个名字。 */
const UNUSABLE = ['subagent', 'subagent_fork', 'subagent_minimal', 'subagent_ptc', 'subagent_preset']

/**
 * 本部署 worker 的实测 roster（55 项，取自 `request/header` 的 `tools` 数组）。
 *
 * 用它而不是缩小的假 roster，是为了让「没有误伤」这条断言有真实的对照面：
 * 少几个名字就会让「其余全部保留」变得廉价地成立。
 */
const FULL_ROSTER = [
  'ask_user_question', 'create_goal', 'edit', 'exit_plan_mode', 'file_info', 'get_goal',
  'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents',
  'load_workspace_dependencies', 'present', 'pwsh', 'read', 'read_image', 'send_message',
  'skill', 'ssh_cluster', 'ssh_download', 'ssh_exec', 'ssh_list', 'ssh_tunnel', 'ssh_upload',
  'subagent', 'subagent_fork', 'subagent_minimal', 'subagent_ptc', 'subagent_preset',
  'task_board_create', 'task_board_get', 'task_board_github_close_issue',
  'task_board_github_comment', 'task_board_github_create_pr', 'task_board_github_get',
  'task_board_github_link_pr', 'task_board_github_list', 'task_board_github_refresh',
  'task_board_github_repositories', 'task_board_github_setup', 'task_board_list',
  'task_board_manage', 'task_board_run', 'task_board_schedule', 'task_board_set_parent',
  'task_board_update', 'todo_write', 'update_goal', 'web_fetch', 'web_search', 'working_directory',
  'workflow', 'write',
]

/**
 * 按 agent 单独安装因而**不可 restrict** 的名字 —— 目录级过滤存在的理由。
 *
 * 这里刻意挑 `subagent_preset`：它既在摘除名单里、又不可 restrict，
 * 于是「`restrict()` 够不到、只有目录过滤能摘掉」这条路径上跑的是**真实**工具名，
 * 而不是一个假名。用假名会让断言在「过滤器什么都不过滤」时也能通过。
 */
const PER_AGENT_UNRESTRICTABLE = 'subagent_preset'

const results = []
const log = { info: [], warn: [] }
const queue = []

function test(name, fn) {
  queue.push({ name, fn })
}

/**
 * 逐个 await 执行队列里的用例。
 *
 * ⚠️ **必须 async 且逐个 await**：本文件里有 async 用例（W7 要触发组装瀑布）。
 * 同步调用会得到「用例通过」的假象 —— 返回值是个未 await 的 Promise，
 * 失败既不进列表也不印用例名，而进程退出码却是 1。本仓 README 专门记录过这个坑，
 * 我在这里又踩了一次（第一版就是同步的，W7 明明有异常却报 8/8 通过）。
 */
async function runTests() {
  for (const { name, fn } of queue) {
    log.info.length = 0
    log.warn.length = 0
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`  PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, message: error.message })
      console.log(`  FAIL  ${name}\n        ${error.message}`)
    }
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// ── 替身 ─────────────────────────────────────────────────────────────────────

/**
 * 假工具注册表：区分「继承面」与「自己 scope」，并按真实规则拒绝不可 restrict 的名字。
 *
 * @param names - 可见的工具名。
 * @param nonRestrictable - 其中不可 restrict 的那些。
 * @returns 假 surface。
 */
function makeSurface(names = FULL_ROSTER, nonRestrictable = []) {
  const restricted = []
  const restrictable = names.filter((n) => !nonRestrictable.includes(n))
  return {
    restricted,
    schemas: () => names.map((name) => ({ name })),
    view: () => ({ restrictableNames: restrictable }),
    restrict({ deny }) {
      const unknown = deny.filter((n) => !restrictable.includes(n))
      if (unknown.length > 0) {
        // 与上游逐字同形：这正是「把自己 scope 的名字写进 deny」的后果。
        throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
      }
      restricted.push([...deny].sort())
      return () => {}
    },
  }
}

/**
 * 造一个假 worker。
 *
 * @param provider - descriptor 里的 provider 名（`spawn` / `fork` / `multitask_ptc` / `multitask_minimal`）。
 * @param id - 会话 id。
 * @param surface - 可选：替换默认的假工具面。
 * @returns 假 agent 与它的组装触发器。
 */
function fakeWorker(provider = 'spawn', id = 'w1', surface = makeSurface()) {
  const listeners = new Map()
  const events = [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider, label: 'probe' } },
  ]
  const agent = {
    id,
    session: {
      id,
      header: { id, origin: 'subagent', delegationDepth: 1, cwd: 'H:\\ws' },
      snapshotEvents: () => events,
    },
    ctx: {
      tools: surface,
      get: () => undefined,
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(fn)
        return () => {
          const arr = listeners.get(name)
          if (arr !== undefined) arr.splice(arr.indexOf(fn), 1)
        }
      },
    },
  }

  /** 触发该 worker 自己 scope 上的 `system-prompt/assemble`。 */
  const assembleTools = async (assembly) => {
    const out = []
    for (const fn of [...(listeners.get('system-prompt/assemble') ?? [])]) {
      out.push(await fn(assembly, { scope: agent }, async () => assembly))
    }
    return out
  }

  const listenerCount = (name) => (listeners.get(name) ?? []).length
  return { agent, surface, assembleTools, listenerCount }
}

/** 假插件 ctx。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    get: () => undefined,
    logger: { info: (m) => log.info.push(m), warn: (m) => log.warn.push(m) },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
}

/** 装载守卫，返回假 ctx。 */
function boot(mod, config = { enabled: true }) {
  const ctx = fakeCtx()
  mod.apply(ctx, config)
  return ctx
}

const mod = await import(pathToFileURL(GUARD).href)

console.log('--- W. 摘掉「调了必被拒」的委派工具（纯省 token）---')

test('W1 ★ worker 的 5 个委派工具被摘掉，其余一个不少', () => {
  const ctx = boot(mod)
  const worker = fakeWorker('spawn', 'w1')
  ctx.emit('agent/created', { agent: worker.agent })

  const deny = worker.surface.restricted.flat()
  for (const tool of UNUSABLE) {
    assert(deny.includes(tool), `${tool} 应当在 deny 里 —— 它每次调用都被 maxDepth 拒绝，留着只是白付 schema 的钱`)
  }
  // 「其余一个不少」是这条用例的重点：黑名单写错会误伤，而误伤的代价是 worker 真的少个能力。
  const mistakenlyDenied = deny.filter((n) => !UNUSABLE.includes(n))
  assert(
    mistakenlyDenied.length === 0,
    `deny 里出现了不该摘的工具：${mistakenlyDenied.join(', ')} —— 本模块是黑名单，多摘一个都等于拿走真实能力`,
  )
  // 6 个名字都在 roster 里，所以 deny 应当正好 5 个（subagent_preset 也在 FULL_ROSTER 里）。
  assert(deny.length === UNUSABLE.length, `deny 应当恰好 ${UNUSABLE.length} 项，实际 ${deny.length}：${deny.join(', ')}`)
})

test('W2 ★ 仍然可用的控制类工具不许被摘（判据是「必然被拒」，不是「没什么用」）', () => {
  const ctx = boot(mod)
  const worker = fakeWorker('spawn', 'w2')
  ctx.emit('agent/created', { agent: worker.agent })
  const deny = worker.surface.restricted.flat()
  // 这三个同样「没什么用」（worker 没有子代理），但**不属于「必然被拒」** ——
  // 把它们写进黑名单就超出了判据，等于用一个猜测去换 token。
  for (const must of ['interrupt_agent', 'send_message', 'list_agents']) {
    assert(
      !deny.includes(must),
      `${must} 被摘掉了 —— 本模块的判据是「调用必然被拒」，而不是「看起来没用」。` +
        '超出判据的黑名单会在某个部署里拿走真实能力',
    )
  }
  for (const must of ['pwsh', 'write', 'edit', 'read', 'grep', 'ssh_exec', 'task_board_run']) {
    assert(!deny.includes(must), `${must} 被摘掉了 —— 全工具面 worker 必须保留它`)
  }
})

test('W3 ★ 黑名单里存在但当前部署没有的名字不会让 restrict() 抛错', () => {
  // 上游删除 `toolFilter` 的教训：写死的名字在别的部署里可能不存在，而
  // `restrict()` 对不存在的名字**抛错**，且它在委派窗口里被调用 —— 抛出来表现为
  // 「委派功能坏了」，极难反查。所以 deny 必须是「黑名单 ∩ 可见集」。
  const roster = FULL_ROSTER.filter((n) => n !== 'subagent_preset' && n !== 'subagent_ptc')
  const surface = makeSurface(roster)
  const ctx = boot(mod)
  const worker = fakeWorker('spawn', 'w3', surface)
  ctx.emit('agent/created', { agent: worker.agent })

  // 没有抛错即通过；再确认摘的正好是「可见的那几个」。
  const deny = surface.restricted.flat()
  assert(deny.includes('subagent') && deny.includes('subagent_fork'), `应当摘掉可见的那两个，实际 deny=${deny.join(', ')}`)
  assert(!deny.includes('subagent_ptc'), 'subagent_ptc 不在该部署的可见集里，不该出现在 deny 里 —— 那会抛 unknown global tool')
  assert(log.warn.length === 0, `不该有告警（这是一次正常收窄），实际：${log.warn.join(' | ')}`)
})

test('W4 ★ 不碰 minimal worker（它由白名单负责）', () => {
  const ctx = boot(mod)
  const worker = fakeWorker(MINIMAL_PROVIDER, 'w4')
  ctx.emit('agent/created', { agent: worker.agent })
  assert(
    worker.surface.restricted.length === 0,
    `minimal worker 不该被本模块动 —— 它的工具面由 minimal-guard 的白名单负责，实际 deny=${worker.surface.restricted.flat().join(', ')}`,
  )
  assert(worker.listenerCount('system-prompt/assemble') === 0, 'minimal worker 上不该注册目录过滤器')
})

test('W5 ★ 不碰协调者（没有子代理信号就什么都不做）', () => {
  const ctx = boot(mod)
  const surface = makeSurface()
  const listeners = new Map()
  const agent = {
    id: 'coord',
    session: { id: 'coord', header: { id: 'coord', cwd: 'H:\\ws' }, snapshotEvents: () => [] },
    ctx: {
      tools: surface,
      get: () => undefined,
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(fn)
        return () => {}
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert(surface.restricted.length === 0, '协调者不该被本模块动 —— 它的工具面由 coordinator-guard 负责')
  assert((listeners.get('system-prompt/assemble') ?? []).length === 0, '协调者上不该注册目录过滤器')
})

test('W6 ★ restrict() 抛错时只记一次告警，不影响会话创建', () => {
  const surface = makeSurface()
  surface.restrict = () => {
    throw new Error('simulated roster race')
  }
  const ctx = boot(mod)
  const worker = fakeWorker('spawn', 'w6', surface)
  // 不抛出去就是通过 —— 本模块对外的承诺是「任何意外都不得影响会话创建」。
  ctx.emit('agent/created', { agent: worker.agent })
  assert(log.warn.length >= 1, 'restrict() 抛错时必须记一笔告警，不能静默')
  assert(
    log.warn.some((m) => m.includes('WORKER-GUARD-SKIPPED')),
    `告警里应当带可 grep 的跳过标识，实际：${log.warn.join(' | ')}`,
  )
})

test('W7 目录级过滤生效：不可 restrict 的委派工具也从模型看到的那份目录里消失', async () => {
  // `subagent_preset` 刻意设成不可 restrict：它既在摘除名单里、又够不到 `restrict()`，
  // 于是这条路径上跑的是真实工具名，而不是假名 —— 假名会让断言在
  // 「过滤器什么都不过滤」时也能通过。
  const surface = makeSurface(FULL_ROSTER, [PER_AGENT_UNRESTRICTABLE])
  const ctx = boot(mod)
  const worker = fakeWorker('spawn', 'w7', surface)
  ctx.emit('agent/created', { agent: worker.agent })
  assert(worker.listenerCount('system-prompt/assemble') === 1, '应当恰好注册一个目录过滤器')

  // 前提：它确实没进 deny（进了会让 restrict() 抛 unknown global tool）。
  const deny = surface.restricted.flat()
  assert(
    !deny.includes(PER_AGENT_UNRESTRICTABLE),
    `${PER_AGENT_UNRESTRICTABLE} 不可 restrict，出现在 deny 里会让 restrict() 抛错`,
  )
  assert(deny.length === UNUSABLE.length - 1, `restrict() 应当只摘掉可 restrict 的 ${UNUSABLE.length - 1} 个，实际 ${deny.length}`)

  const outs = await worker.assembleTools({ tools: FULL_ROSTER.map((name) => ({ name })) })
  assert(outs.length === 1, `应当恰好有一个处理器返回结果，实际 ${outs.length}`)
  const kept = outs[0].tools.map((t) => t.name)
  for (const tool of UNUSABLE) {
    assert(!kept.includes(tool), `${tool} 必须从目录里消失，实际仍在`)
  }
  assert(kept.length === FULL_ROSTER.length - UNUSABLE.length, `应当只剩 ${FULL_ROSTER.length - UNUSABLE.length} 项，实际 ${kept.length}`)
})

test('W8 幂等：同一 worker 重复触发不会重复装限制', () => {
  const ctx = boot(mod)
  const worker = fakeWorker('spawn', 'w8')
  ctx.emit('agent/created', { agent: worker.agent })
  ctx.emit('agent/created', { agent: worker.agent })
  assert(worker.surface.restricted.length === 1, `应当只装一次 restrict，实际 ${worker.surface.restricted.length} 次`)
  assert(worker.listenerCount('system-prompt/assemble') === 1, '目录过滤器也应当只有一个')
})

test('W9 ★ PTC worker 也必须被收窄（初版曾错误地把 PTC 排除在外）', () => {
  // ── 这条为什么必须存在 ────────────────────────────────────────────────────
  //
  // 本模块初版断言「它不解决 PTC 的 SDK 文档」，理由是 PTC 的 `request/header.tools`
  // 里只有 `run_code`，委派工具只出现在 `## Writing code for run_code` 那一节，
  // 而那一节「是否随可见集收缩尚未验证」。**那个保守猜测是错的。**
  //
  // 同日的两个真实会话构成干净对照（其余 roster 完全相同，只差这 5 个）：
  //
  //   11:32:53（本模块未生效）：SDK 声明 55 个工具 → 61,081 字符
  //   19:16:41（本模块已生效）：SDK 声明 50 个工具 → 54,778 字符   ← 省 6,303 字符
  //
  // 机理：SDK 文档由 `sdkSchemas(scope)` 生成，它读 `view(scope).visible`；
  // `restrict()` 挂在 agent 自己的 layer 上，`chainLayers()` 会读这一层。
  // 所以 PTC 不是例外 —— 它恰好是**收益最大**的一条（PTC 底噪比全工具面还贵）。
  //
  // 若哪天有人图省事把 `multitask_ptc` 加进「不接管」名单（就像 `multitask_minimal`
  // 那样），这条会红，而 PTC 会静默地退回每次请求重发 6,303 字符。
  const surface = makeSurface()
  const ctx = boot(mod)
  const worker = fakeWorker('multitask_ptc', 'w9', surface)
  ctx.emit('agent/created', { agent: worker.agent })

  const deny = surface.restricted.flat()
  for (const tool of UNUSABLE) {
    assert(
      deny.includes(tool),
      `${tool} 应当从 PTC worker 上摘掉 —— PTC 的 SDK 文档会逐个声明它，` +
        '实测摘掉这 5 个让文档从 61,081 降到 54,778 字符。PTC 不是本模块的例外',
    )
  }
  // 反向：PTC worker 需要的能力一个都不能少（它靠 run_code 里的 SDK 调这些）。
  for (const must of ['pwsh', 'write', 'edit', 'read', 'grep', 'ssh_exec', 'task_board_run']) {
    assert(!deny.includes(must), `${must} 被从 PTC worker 上摘掉了 —— 它要经程序里的 SDK 调用这个工具`)
  }
})

// ── 汇总 ─────────────────────────────────────────────────────────────────────

await runTests()
const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`worker-guard：${results.length} 条用例，${results.length - failed.length} 通过，${failed.length} 失败`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
