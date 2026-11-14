/**
 * 只读 worker 的**目录级过滤**回归（进程内、零依赖、不加载 DSH）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `minimal-guard.mjs` 要把 `subagent_minimal` 收窄成真只读。它用
 * `deny = 可见集 − 允许集` 调 `tools.restrict()`，但那条路**结构上够不到一类工具**：
 *
 *   `tools.restrict()` 只认**继承面**的名字。`dsh-tools` 的 `view()` 里，
 *   `inherited` 才进 `restrictableNames`，而**注册在该 agent 自己 scope 上**的名字
 *   只进 `visible`、不进 `restrictableNames` —— 写进 deny 会抛
 *   `names unknown global tool`。
 *
 * 于是「按 agent 单独安装」的工具永远摘不掉。实测命中的正是这一类：
 * `subagent` / `subagent_ptc` / `subagent_minimal` 三行设了
 * `modelSelectionSettings: true`，那个开关让 `dsh-tool-subagent` 改为逐 agent
 * `installScoped`（注册到该 agent 自己的 ctx），于是它们留在 minimal worker 的
 * 目录里。证据吻合：**没设**那个开关的 `subagent_fork` 被成功摘掉了。
 *
 * 本机实测（`H:\test4` / `H:\test5`，读**请求头的 `tools` 数组**，不是 worker 自述）：
 * minimal worker 的目录恰好是「允许集 10 项 + 这三个委派工具」= 13 项。
 *
 * ── 它为什么必须与 `restrict()` 并存（而不是代替它）─────────────────────────
 *
 * 两者管的是**不同的面**，缺一不可：
 *
 *   - `restrict()` 改的是 **restriction 层**（执行侧的可见性判定），
 *     管得住的那些名字靠它；
 *   - 目录过滤改的是 **`assembly.tools`**（模型能看到的那份 schema 数组），
 *     专门补上 restriction 够不到的那一类。
 *
 * 所以 C2 那条用例**刻意断言 `deny` 里没有那三个委派工具** —— 那正是
 * 「目录过滤是承重的、不是冗余」的证据。若哪天上游让它们变得可 restrict，
 * 这条会红，提醒把重复的那半边收掉。
 *
 * ⚠️ 这不是安全边界。真正的拦截是 `maxDepth`（minimal worker 深度为 1，
 * 再往下派会撞 `Error: subagent depth 2 exceeds maxDepth 1`）与静态 `toolFilter`。
 * 它修的是**一致性**：人格里逐字写着 "Do not delegate further; you cannot,
 * and you should not try"，而模型抬头就能看见三个委派工具。
 *
 * ── 它用什么替身 ─────────────────────────────────────────────────────────────
 *
 * 一个几百字节的假 `ctx` / 假 `agent` / 假工具注册表：只实现本模块**实际用到**的
 * 成员，并按真实形状区分「继承面」与「自己 scope」。与本目录其他脚本同款取向。
 *
 * ⚠️ 本文件的用例**全是 async**，所以运行器必须 `await` 每个用例体 ——
 * 就地调用不 `await` 会让每条用例在第一个 `await` 处被记成「通过」，
 * 而失败既不进列表也不印用例名（本仓 README 专门写过这个坑）。
 * 形状是「`test()` 只入队 + `runTests()` 逐个 await」。
 *
 * @module dsh-multitask/test/minimal-guard-catalog
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(here, '..', '..', 'presets', 'multitask', 'minimal-guard.mjs')
/**
 * minimal worker 那一行的 **provider 名** —— 与 `composition.mjs` / `minimal-guard.mjs`
 * 里的 `MINIMAL_PROVIDER` 逐字一致。
 *
 * 标记的载体是 provider 名（写进 `subagent/descriptor` 的 `data.provider`），
 * 不再是 persona 里的字符串：新版 DSH 删除了委派行的 `persona` 配置项。
 */
const MINIMAL_PROVIDER = 'multitask_minimal'

const results = []
const log = { info: [], warn: [] }

/** 用例队列：`test()` 只入队，真正执行在 `runTests()` 里（必须 await）。 */
const queue = []

function test(name, fn) {
  queue.push({ name, fn })
}

/** 逐个 await 执行队列里的用例 —— 这是 async 用例唯一正确的运行形状。 */
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

/** 本部署的**完整** roster（取自实测请求头的 44 项）。 */
const FULL_ROSTER = [
  'ask_user_question', 'create_goal', 'edit', 'exit_plan_mode', 'file_info', 'get_goal',
  'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents',
  'present', 'pwsh', 'read', 'read_image', 'send_message', 'skill', 'ssh_cluster',
  'ssh_download', 'ssh_exec', 'ssh_list', 'ssh_tunnel', 'ssh_upload', 'subagent',
  'subagent_fork', 'subagent_minimal', 'subagent_ptc', 'task_board_create', 'task_board_get',
  'task_board_list', 'task_board_manage', 'task_board_run', 'task_board_schedule',
  'task_board_set_parent', 'task_board_update', 'todo_write', 'update_goal', 'web_fetch',
  'web_search', 'workflow', 'write',
]

/**
 * 按 agent 单独安装（`installScoped`）因而**不可 restrict** 的名字。
 *
 * ⚠️ 如今只剩 `structured_output` —— 那是上游 `dsh-subagent` 在配了 `outputSchema`
 * 的委派里注册到子代理自己 scope 上的**永久存在**的一类，不随本包配置变化。
 *
 * 早先这里还有 `subagent` / `subagent_minimal` / `subagent_ptc`：成因是那三行设了
 * `modelSelectionSettings: true`（该开关让工具改为**逐 agent 安装**）。本轮已把该开关
 * 从四行**全部移除**，于是它们回到全局注册、**变得可 restrict** —— 见 `DELEGATION_TOOLS`。
 */
const CHILD_OWN = ['structured_output']

/**
 * 本 composition 的**四条委派行**。移除 `modelSelectionSettings` 之后它们都走全局注册，
 * 因而都进了 `restrictableNames`、能被 `restrict()` 摘掉。
 */
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_ptc', 'subagent_minimal']

/**
 * 一个**合成的**「别的插件按 agent 单独安装」的工具名 —— 目录过滤的存在理由。
 *
 * 它既不在允许集里、又不可 restrict，所以 `restrict()` 结构上摘不掉它；只有目录过滤
 * 能把它从模型看到的那份 catalog 里去掉。用合成名字而不是真实工具，是因为本包里
 * **已经不存在**这样的真实工具了：那个真实案例（三个委派工具）已随
 * `modelSelectionSettings` 的移除而消失。
 */
const PER_AGENT_LEAK = 'some_plugin_per_agent_tool'

/** 假注册表：区分「继承面」与「自己 scope」，并按真实规则拒绝不可 restrict 的名字。 */
function makeSurface(names = FULL_ROSTER, nonRestrictable = CHILD_OWN) {
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
 * 造一个假 subagent_minimal worker（会话头带子代理信号）。
 *
 * 类型标记走 `subagent/descriptor` 的 `provider`（与真实运行时一致），
 * 不再走 system prompt 段落里的 persona 字符串 —— 上游已删除 `persona` 配置项，
 * 那条段落根本不会再被注册。
 */
function fakeWorker(id = 'w1') {
  const surface = makeSurface()
  const listeners = new Map()
  const events = [
    {
      type: 'subagent/descriptor',
      data: { version: 3, mode: 'continuable', provider: MINIMAL_PROVIDER, label: 'probe' },
    },
  ]
  const agent = {
    id,
    session: { id, header: { id, origin: 'subagent', delegationDepth: 1, cwd: 'H:\\ws' }, snapshotEvents: () => events },
    ctx: {
      tools: surface,
      // 刻意**不**提供 systemPrompt：守卫现在不读它了，若还在读就会抛错暴露出来。
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

  /**
   * 触发该 worker 自己 scope 上的 `system-prompt/assemble`，返回各处理器的输出。
   *
   * ⚠️ `next()` 必须**不带参**调用并返回下游组装结果 —— 上游的约定正是
   * 「waterfall(…, assembly, context, next)」，`next()` 即「其余处理器的结果」。
   * 传参进去会让被测代码拿到 `undefined`，从而误判成「没有目录可滤」。
   *
   * @param assembly - 本次组装结果。
   * @returns 各处理器返回的组装结果数组（没有处理器时为空数组）。
   */
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

/** 假插件 ctx（本模块只用 `on` / `logger`）。 */
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

/** 装载守卫模块，返回假 ctx。 */
function boot(mod) {
  const ctx = fakeCtx()
  mod.apply(ctx, { enabled: true })
  return ctx
}

/** 把 roster 变成组装结果里的 tools 数组。 */
const toolsOf = (names) => names.map((name) => ({ name }))

const mod = await import(pathToFileURL(GUARD).href)

console.log('--- C. 目录级过滤：restrict() 够不到的那一类必须从目录里消失 ---')

test('C1 ★ 一个「别的插件按 agent 单独安装」的工具被目录过滤摘掉（restrict 摘不掉它）', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('w1')
  // roster 里加一个**不可 restrict** 的外来工具：这正是目录过滤存在的理由。
  worker.surface.schemas = () => toolsOf([...FULL_ROSTER, PER_AGENT_LEAK])
  worker.surface.view = () => ({ restrictableNames: [...FULL_ROSTER].filter((n) => n !== PER_AGENT_LEAK) })
  ctx.emit('agent/created', { agent: worker.agent })

  // 前提：继承面那半边确实生效了（否则下面的断言会在错误的前提下通过）。
  assert(
    worker.surface.restricted.length >= 1,
    `继承面应当已被 restrict（ssh_* / task_board_* / pwsh …），实际 ${worker.surface.restricted.length} 条`,
  )
  assert(worker.listenerCount('system-prompt/assemble') === 1, '应当恰好注册一个目录过滤器')

  const outs = await worker.assembleTools({ tools: toolsOf([...FULL_ROSTER, PER_AGENT_LEAK]) })
  assert(outs.length === 1, `应当恰好有一个处理器返回结果，实际 ${outs.length}`)
  const kept = outs[0].tools.map((t) => t.name)
  assert(
    !kept.includes(PER_AGENT_LEAK),
    `${PER_AGENT_LEAK} 必须从目录里消失（它不可 restrict，只有目录过滤能摘掉它），实际仍在：${kept.join(', ')}`,
  )
  // 同时确认它**没有**进 deny —— 进了就会让 `restrict()` 抛错。
  assert(
    !worker.surface.restricted.flat().includes(PER_AGENT_LEAK),
    `${PER_AGENT_LEAK} 出现在了 deny 里 —— 那会让 restrict() 抛 unknown global tool`,
  )
})

test('C2 ★ 四条委派工具现在**由 restrict() 摘掉**（开关移除后它们回到全局注册）', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('w2')
  ctx.emit('agent/created', { agent: worker.agent })

  const deny = worker.surface.restricted.flat()
  // 这是本轮**行为变化**的核心：移除 `modelSelectionSettings` 让委派工具回到全局注册，
  // 于是它们进了 `restrictableNames`、能被 `restrict()` 摘掉 —— 而不再需要靠目录过滤兜。
  for (const tool of DELEGATION_TOOLS) {
    assert(
      deny.includes(tool),
      `${tool} 应当被 restrict() 摘掉（它现在走全局注册）。若不在 deny 里，` +
        '说明它又在按 agent 单独安装 —— 检查 composition 里是否有人把 modelSelectionSettings 加回来了',
    )
  }
  for (const must of ['ssh_exec', 'ssh_cluster', 'ssh_upload', 'task_board_run', 'pwsh', 'write', 'edit']) {
    assert(deny.includes(must), `${must} 应当被 restrict 摘掉，实际 deny=${deny.join(', ')}`)
  }
})

test('C2b 目录过滤仍然保留 —— 它要挡的是「别的插件按 agent 单独安装」那一类', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('w2b')
  ctx.emit('agent/created', { agent: worker.agent })
  // 即使本轮的真实泄漏已消失，目录过滤**不该被顺手删掉**：它的存在理由是结构性的
  // （`restrict()` 只认继承面），第三方的逐-agent 工具随时可能出现。
  assert(worker.listenerCount('system-prompt/assemble') === 1, '目录过滤必须仍然装上')
})

test('C3 目录过滤保留允许集，并放过 harness 内部传输名', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('w3')
  ctx.emit('agent/created', { agent: worker.agent })

  const roster = [...FULL_ROSTER, 'run_code', 'structured_output']
  const outs = await worker.assembleTools({ tools: toolsOf(roster) })
  const kept = new Set(outs[0].tools.map((t) => t.name))

  for (const keep of ['read', 'grep', 'glob', 'file_info', 'web_search', 'web_fetch', 'skill', 'todo_write', 'present', 'read_image']) {
    assert(kept.has(keep), `允许集成员 ${keep} 不该被目录过滤摘掉`)
  }
  for (const exempt of ['run_code', 'structured_output']) {
    assert(kept.has(exempt), `${exempt} 是 harness 内部传输名，滤掉它会让相应能力失效`)
  }
  for (const gone of ['ssh_exec', 'task_board_run', 'pwsh', 'write', 'edit', 'subagent', 'subagent_ptc']) {
    assert(!kept.has(gone), `${gone} 应当已从目录消失`)
  }
  assert(
    !kept.has('send_message') && !kept.has('workflow') && !kept.has('list_agents'),
    '只读 worker 不该保留编排类工具（那是协调者的面）',
  )
})

test('C4 目录过滤只作用在该 worker 自己的 scope 上（兄弟与协调者不受影响）', async () => {
  const ctx = boot(mod)
  const a = fakeWorker('sibling-a')
  const b = fakeWorker('sibling-b')
  ctx.emit('agent/created', { agent: a.agent })
  ctx.emit('agent/created', { agent: b.agent })

  const roster = toolsOf(FULL_ROSTER)
  const outA = await a.assembleTools({ tools: roster })
  const outB = await b.assembleTools({ tools: roster })
  assert(outA[0].tools.length === outB[0].tools.length, '两个 worker 的目录应当同样被收窄')
  assert(outA[0].tools.length < roster.length, '目录确实被收窄了')

  // 协调者（没有子代理信号）**一个处理器都不许装**。
  const root = fakeWorker('root')
  root.agent.session.header = { id: 'root', cwd: 'H:\\ws' }
  ctx.emit('agent/created', { agent: root.agent })
  assert(root.listenerCount('system-prompt/assemble') === 0, '协调者 scope 上不该注册 assemble 处理器（减震器语义）')
  const rootOuts = await root.assembleTools({ tools: roster })
  assert(rootOuts.length === 0, '协调者的目录不该被本模块碰过')
})

test('C5 组装里没有 tools 数组时原样放过，不抛错', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('w5')
  ctx.emit('agent/created', { agent: worker.agent })
  const assembly = { contexts: [] }
  const outs = await worker.assembleTools(assembly)
  assert(outs[0] === assembly, '没有 tools 时应原样返回同一个组装结果')
})

test('C6 没有可滤项时原样返回同一个对象（不无谓分配）', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('w6')
  ctx.emit('agent/created', { agent: worker.agent })
  const already = { tools: toolsOf(['read', 'grep']) }
  const outs = await worker.assembleTools(already)
  assert(outs[0] === already, '没有可滤项时应当返回**同一个**对象')
})

test('C7 目录过滤生效但继承面无可摘项时，也照样装上（不能早退跳过）', async () => {
  // 这一条锁的是「目录里刚好只剩不可 restrict 的那些」这个边界：早期实现把它放在
  // `deny.length === 0` 的早退**之后**，于是那种情形会被整个跳过 —— 而真实会话里
  // 差集不为空，所以它只在极端配置下才现形。
  const ctx = boot(mod)
  const worker = fakeWorker('w7')
  // 只留一个**不可 restrict** 的外来工具 + 一个允许集成员。
  worker.surface.schemas = () => toolsOf(['read', PER_AGENT_LEAK])
  worker.surface.view = () => ({ restrictableNames: ['read'] })
  ctx.emit('agent/created', { agent: worker.agent })

  assert(worker.surface.restricted.length === 0, '这些名字都不可 restrict，deny 应当为空')
  assert(worker.listenerCount('system-prompt/assemble') === 1, 'deny 为空也必须装上目录过滤器')

  const outs = await worker.assembleTools({ tools: toolsOf(['read', PER_AGENT_LEAK]) })
  const kept = outs[0].tools.map((t) => t.name)
  assert(kept.includes('read'), 'read 必须保留')
  assert(!kept.includes(PER_AGENT_LEAK), `${PER_AGENT_LEAK} 必须被目录过滤摘掉（即便 deny 为空）`)
})

console.log('\n--- L. 记账：首次真的滤掉东西时记一条，之后不再重复 ---')

test('L1 ★ 目录过滤只在第一次真的滤掉东西时记一条 info（组装是每条请求都跑的路径）', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('l1')
  const roster = [...FULL_ROSTER, PER_AGENT_LEAK]
  worker.surface.schemas = () => toolsOf(roster)
  worker.surface.view = () => ({ restrictableNames: [...FULL_ROSTER].filter((n) => n !== PER_AGENT_LEAK) })
  ctx.emit('agent/created', { agent: worker.agent })

  await worker.assembleTools({ tools: toolsOf(roster) })
  const first = log.info.filter((m) => m.includes('read-only worker catalog filtered'))
  assert(first.length === 1, `第一次组装应当恰好记 1 条目录过滤日志，实际 ${first.length} 条`)
  assert(
    first[0].includes(PER_AGENT_LEAK),
    `那条日志必须列出被滤掉的名字（它是「过度过滤」的唯一出口），实际：${first[0]}`,
  )

  // 再组装几次：不该再多记（否则每条请求一行，等于刷屏）。
  await worker.assembleTools({ tools: toolsOf(roster) })
  await worker.assembleTools({ tools: toolsOf(roster) })
  const after = log.info.filter((m) => m.includes('read-only worker catalog filtered'))
  assert(after.length === 1, `重复组装不该再记日志，实际累计 ${after.length} 条`)
})

test('L2 没有可滤项时不记日志（没有隐藏任何东西就没什么可报的）', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('l2')
  ctx.emit('agent/created', { agent: worker.agent })
  await worker.assembleTools({ tools: toolsOf(['read', 'grep', 'glob']) })
  const rows = log.info.filter((m) => m.includes('read-only worker catalog filtered'))
  assert(rows.length === 0, `没有滤掉任何东西时不该记日志，实际 ${rows.length} 条`)
})

console.log('\n--- R. 释放：两个清理动作都必须被卸掉（不能互相覆盖）---')

test('R1 ★ 收窄的动作与目录过滤的动作各自独立登记，释放时**都**执行', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('r1')
  ctx.emit('agent/created', { agent: worker.agent })

  assert(worker.listenerCount('system-prompt/assemble') === 1, '应当已注册目录过滤')
  assert(worker.surface.restricted.length === 1, '应当已施加继承面限制')

  ctx.emit('agent/disposed', { agent: worker.agent })

  assert(
    worker.listenerCount('system-prompt/assemble') === 0,
    'agent/disposed 之后目录过滤必须已被卸掉 —— 否则 scope key 复用时新 agent 会继承一条该消失的过滤。' +
      '（早期实现把两个 disposer 写进同一个 WeakMap 键，后写覆盖前写，正是这条用例挡的缺陷。）',
  )
})

test('R2 同一 worker 重复触发不会重复登记（幂等）', async () => {
  const ctx = boot(mod)
  const worker = fakeWorker('r2')
  ctx.emit('agent/created', { agent: worker.agent })
  ctx.emit('agent/created', { agent: worker.agent })
  assert(worker.listenerCount('system-prompt/assemble') === 1, '同一 agent 重复触发不该重复登记')
  assert(worker.surface.restricted.length === 1, '同一 agent 重复触发不该重复施加限制')
})

await runTests()

console.log('\n--- D. 判别力：把目录过滤拿掉，C1 必须变红 ---')
{
  const fs = await import('node:fs')
  const original = fs.readFileSync(GUARD, 'utf8')
  // 把「装上目录过滤」改成什么也不做（即没有这一层时的行为）。
  const broken = original.replace(
    'const catalogEngaged = engageCatalogFilter(agent, allowed)',
    'const catalogEngaged = false',
  )
  if (broken === original) {
    console.log('  SKIP  找不到锚点行，判别力检查无法进行')
    results.push({ name: '判别力检查', ok: false, message: '找不到锚点行' })
  } else {
    fs.writeFileSync(GUARD, broken)
    try {
      const brokenMod = await import(pathToFileURL(GUARD).href + `?broken=${Date.now()}`)
      const ctx = fakeCtx()
      brokenMod.apply(ctx, { enabled: true })
      const worker = fakeWorker('broken')
      // 与 C1 同样的形状：roster 里带一个不可 restrict 的外来工具。
      const roster = [...FULL_ROSTER, PER_AGENT_LEAK]
      worker.surface.schemas = () => toolsOf(roster)
      worker.surface.view = () => ({ restrictableNames: [...FULL_ROSTER].filter((n) => n !== PER_AGENT_LEAK) })
      ctx.emit('agent/created', { agent: worker.agent })

      // 没有目录过滤这一层时：处理器根本不注册，目录就是未过滤的那一份，
      // 那个不可 restrict 的外来工具自然还在（restrict 摘不掉它）。
      assert(
        worker.listenerCount('system-prompt/assemble') === 0,
        '去掉目录过滤后不该还注册处理器 —— 否则说明锚点替换没生效',
      )
      const outs = await worker.assembleTools({ tools: toolsOf(roster) })
      const kept = outs.length === 0 ? roster : outs[0].tools.map((t) => t.name)
      assert(
        kept.includes(PER_AGENT_LEAK),
        `去掉目录过滤后 ${PER_AGENT_LEAK} **应当**重新出现在目录里（证明 C1 不是恒真的）`,
      )
      console.log(`  PASS  去掉目录过滤后 ${PER_AGENT_LEAK} 重新泄漏 —— C1 因此不是恒真的`)
    } catch (error) {
      console.log(`  FAIL  判别力检查：${error.message}`)
      results.push({ name: '判别力检查', ok: false, message: error.message })
    } finally {
      fs.writeFileSync(GUARD, original)
    }
  }
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n只读 worker 目录过滤：${results.length} 条用例，${results.length - failed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
