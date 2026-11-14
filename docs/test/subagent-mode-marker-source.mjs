/**
 * 模式标记的**来源**回归（进程内、零依赖、不加载 DSH）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `subagent-mode.mjs` 与 `minimal-guard.mjs` 都要先回答「这个子代理来自哪条委派行」。
 * 它们靠读该子代理 `subagent/descriptor` 事件里的 **provider 名**来回答。
 *
 * ── ⚠️ 这条路换过一次，别再按旧版本读 ─────────────────────────────────────
 *
 * 旧版本读的是委派行的 `persona` 里一段字符串标记，主来源是子代理自己的
 * `deployment:persona-prefix` 段落（还要读上游未文档化的 `systemPrompt.layers.merge`）。
 *
 * **DSH 0.2.1-rc.2 把那条路彻底断了**：`@deepseek-ai/dsh-tool-subagent` 的 Config
 * 删除了 `persona` 与 `toolFilter`，配置里只要出现就逐字抛
 *
 *     tool-subagent: persona is no longer supported; configure persona and tool plugins
 *     in an Agent Preset and select it with agentPreset (spawn only)
 *
 * 后果不是「人格不生效」而是**整个 preset 挂载失败** —— 模式从新会话列表里彻底消失。
 * 所以类型标记改挂在 `provider` 上：它由行决定、原样写进 descriptor、可按 worker 种类
 * 各起一个名字。读法因此只剩一步，也不再依赖任何未文档化结构。
 *
 * ── 它用什么替身 ─────────────────────────────────────────────────────────────
 *
 * 一个几百字节的假 `ctx` / 假 `agent` / 假工具面：只实现两个模块**实际用到**的成员。
 * 与 `approval-gate-integration.mjs` 同款取向 —— 不是「模拟 DSH」，而是「用最小替身
 * 把调用点逼出来」；模块用了替身没有的东西就会抛错，探针即红。
 *
 * @module dsh-multitask/test/subagent-mode-marker-source
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (name) => import(pathToFileURL(path.join(here, '..', '..', 'presets', 'multitask', name)).href)
const rel = (name) => path.join(here, '..', '..', 'presets', 'multitask', name)

const SUBAGENT_MODE = await load('subagent-mode.mjs')
const MINIMAL_GUARD = await load('minimal-guard.mjs')

/** 与 composition.mjs 的 `PTC_PROVIDER` / `MINIMAL_PROVIDER` 逐字一致。 */
const PTC_PROVIDER = 'multitask_ptc'
const MINIMAL_PROVIDER = 'multitask_minimal'

/** 旧版本写在 persona 开头的标记 —— 只用于续接旧会话。 */
const LEGACY_PTC_MARKER = '[multitask-mode:ptc]'
const LEGACY_MINIMAL_MARKER = '[multitask-mode:minimal]'

const results = []
const log = { info: [], warn: [] }

/** 跑一条用例并记录（与同目录另几个脚本同形状）。 */
function test(name, fn) {
  log.info.length = 0
  log.warn.length = 0
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/** 最小断言（本仓库刻意不用 `node:assert`）。 */
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// ── 替身 ─────────────────────────────────────────────────────────────────────

/**
 * 造一个假 agent（会话头三信号齐全 ⇒ 会被判成子代理）。
 *
 * @param options - `{ id, provider, persona, cwd }`。
 *   `provider` 写进 `subagent/descriptor` 的 `data.provider`（**主通道**）；
 *   `persona` 同样写进 descriptor 的 `data.persona`（**旧会话兜底**）。
 * @returns `{ agent, surface }`；`surface` 用来观察工具面是否被改动。
 */
function fakeChild(options = {}) {
  const engaged = []
  const denied = new Set()
  const ALL = [
    'read', 'grep', 'glob', 'file_info', 'web_search', 'web_fetch', 'skill', 'todo_write', 'present',
    'run_code', 'pwsh', 'write', 'edit', 'ssh_exec', 'task_board_run', 'structured_output',
  ]
  const surface = {
    engaged,
    schemas: () => ALL.filter((n) => !denied.has(n)).map((name) => ({ name })),
    view: () => ({ restrictableNames: ALL.filter((n) => n !== 'structured_output') }),
    restrict({ deny }) {
      for (const n of deny) denied.add(n)
      engaged.push([...deny].sort())
      return () => {}
    },
    presentAs(mode) {
      engaged.push(mode)
      return () => {}
    },
  }

  const events = []
  if (options.provider !== undefined || options.persona !== undefined) {
    events.push({
      type: 'subagent/descriptor',
      data: {
        version: 3,
        mode: 'continuable',
        provider: options.provider ?? 'spawn',
        label: 'probe',
        ...(options.persona === undefined ? {} : { persona: options.persona }),
      },
    })
  }

  const id = options.id ?? 'child-1'
  const agent = {
    id,
    session: {
      id,
      // 三个信号任一成立即判为子代理；这里给最直接的那个。
      header: { id, origin: 'subagent', cwd: options.cwd ?? 'H:\\ws' },
      snapshotEvents: () => events,
    },
    ctx: {
      tools: surface,
      // 两个守卫现在都不再读 systemPrompt；这里故意**不提供**它，
      // 以便「还在偷偷读段落」的实现直接抛错暴露出来。
      get: () => undefined,
    },
  }
  return { agent, surface }
}

/**
 * 造一个假插件 ctx。
 *
 * @param options - `{ ptcRuntime }`：是否模拟本部署存在 PTC 运行时。
 * @returns 带 `emit` 的假 ctx。
 */
function fakeCtx(options = {}) {
  const listeners = new Map()
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    get(name) {
      if (name === 'ptcRuntime') return options.ptcRuntime === false ? undefined : { language: 'typescript' }
      return undefined
    },
    logger: {
      info: (m) => log.info.push(m),
      warn: (m) => log.warn.push(m),
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload)
    },
  }
}

/** 装载一个守卫模块，返回假 ctx。 */
function boot(mod, options = {}) {
  const ctx = fakeCtx(options)
  mod.apply(ctx, { enabled: true })
  return ctx
}

console.log('--- P. 主通道：provider 名 ---')

test('P1 ★ PTC：provider 为 multitask_ptc 时必须塌缩成 run_code + SDK', () => {
  const ctx = boot(SUBAGENT_MODE)
  const { agent, surface } = fakeChild({ id: 'ptc-1', provider: PTC_PROVIDER })
  ctx.emit('agent/created', { agent })
  assert(
    surface.engaged.includes('ptc'),
    `ptc worker 应当被 presentAs('ptc') 塌缩，实际动作：${JSON.stringify(surface.engaged)}`,
  )
})

test('P2 ★ minimal：provider 为 multitask_minimal 时必须收窄', () => {
  const ctx = boot(MINIMAL_GUARD)
  const { agent, surface } = fakeChild({ id: 'min-1', provider: MINIMAL_PROVIDER })
  ctx.emit('agent/created', { agent })

  assert(surface.engaged.length === 1, `应当装 1 条收窄，实际 ${surface.engaged.length}`)
  const deny = surface.engaged[0]
  assert(
    deny.includes('ssh_exec'),
    `ssh_exec 应当被摘掉（它是「只读面仍能执行远端命令」的那一条），实际：${JSON.stringify(deny)}`,
  )
  assert(deny.includes('task_board_run'), 'task_board_run 应当被摘掉')
  assert(deny.includes('pwsh'), 'pwsh 应当被摘掉（允许集里没有它）')
  assert(deny.includes('write'), 'write 应当被摘掉（静态 toolFilter 已删除，必须由本层摘）')
  assert(deny.includes('edit'), 'edit 应当被摘掉')
  assert(!deny.includes('read'), 'read 必须保留')
  assert(!deny.includes('file_info'), 'file_info 必须保留（只读 worker 靠它核对交付物）')
})

console.log('\n--- L. 兜底：旧会话的 persona 标记 ---')

test('L1 旧会话（provider=spawn、persona 带 ptc 标记）仍然被识别并塌缩', () => {
  const ctx = boot(SUBAGENT_MODE)
  const { agent, surface } = fakeChild({
    id: 'legacy-ptc',
    provider: 'spawn',
    persona: `${LEGACY_PTC_MARKER} You are a PTC worker…`,
  })
  ctx.emit('agent/created', { agent })
  assert(surface.engaged.includes('ptc'), '续接旧会话时 ptc 塌缩应当仍然生效')
})

test('L2 旧会话（provider=spawn、persona 带 minimal 标记）仍然被收窄', () => {
  const ctx = boot(MINIMAL_GUARD)
  const { agent, surface } = fakeChild({
    id: 'legacy-min',
    provider: 'spawn',
    persona: `${LEGACY_MINIMAL_MARKER} You are a read-only RESEARCH worker…`,
  })
  ctx.emit('agent/created', { agent })
  assert(surface.engaged.length === 1, `旧会话的 minimal 收窄应当生效，实际 ${surface.engaged.length}`)
})

test('L3 provider 名优先于旧 persona 标记（两者冲突时以 provider 为准）', () => {
  const ctx = boot(MINIMAL_GUARD)
  // provider 说是 ptc，persona 里残留 minimal —— 必须听 provider 的，不动作。
  const { agent, surface } = fakeChild({
    id: 'conflict',
    provider: PTC_PROVIDER,
    persona: `${LEGACY_MINIMAL_MARKER} stale`,
  })
  ctx.emit('agent/created', { agent })
  assert(
    surface.engaged.length === 0,
    `provider=ptc 的行不该被只读收窄，实际动作：${JSON.stringify(surface.engaged)}`,
  )
})

console.log('\n--- N. 负向：不该动作的一律不动作 ---')

test('N1 别的委派行（spawn / fork）不受影响', () => {
  const ptcCtx = boot(SUBAGENT_MODE)
  const { agent: a1, surface: s1 } = fakeChild({ id: 'plain-spawn', provider: 'spawn' })
  ptcCtx.emit('agent/created', { agent: a1 })
  assert(s1.engaged.length === 0, `spawn 行不该被塌缩，实际：${JSON.stringify(s1.engaged)}`)

  const minCtx = boot(MINIMAL_GUARD)
  const { agent: a2, surface: s2 } = fakeChild({ id: 'plain-fork', provider: 'fork' })
  minCtx.emit('agent/created', { agent: a2 })
  assert(s2.engaged.length === 0, 'fork 行不该被只读收窄')
})

test('N2 没有 descriptor（读不到 provider）⇒ 两个守卫都不动作，且不抛错', () => {
  const ptcCtx = boot(SUBAGENT_MODE)
  const { agent: a1, surface: s1 } = fakeChild({ id: 'none-1' })
  ptcCtx.emit('agent/created', { agent: a1 })
  assert(s1.engaged.length === 0, 'ptc 侧不该动作')

  const minCtx = boot(MINIMAL_GUARD)
  const { agent: a2, surface: s2 } = fakeChild({ id: 'none-2' })
  minCtx.emit('agent/created', { agent: a2 })
  assert(s2.engaged.length === 0, 'minimal 侧不该动作')
})

test('N3 协调者（没有子代理信号）绝不被碰 —— 两个守卫都不动作', () => {
  const { agent, surface } = fakeChild({ id: 'root', provider: MINIMAL_PROVIDER })
  // 抹掉三个子代理信号，让它看起来像用户会话。
  agent.session.header = { id: 'root', cwd: 'H:\\ws' }

  const ptcCtx = boot(SUBAGENT_MODE)
  ptcCtx.emit('agent/created', { agent })
  assert(surface.engaged.length === 0, 'PTC 侧绝不该碰协调者（会改写减震器语义）')

  const minCtx = boot(MINIMAL_GUARD)
  minCtx.emit('agent/created', { agent })
  assert(surface.engaged.length === 0, 'minimal 侧绝不该碰协调者')
})

test('N4 同一 agent 触发两次 agent/created 不重复动作（启动 + 恢复路径）', () => {
  const ctx = boot(MINIMAL_GUARD)
  const { agent, surface } = fakeChild({ id: 'twice', provider: MINIMAL_PROVIDER })
  ctx.emit('agent/created', { agent })
  ctx.emit('agent/created', { agent })
  assert(surface.engaged.length === 1, `重复事件不该重复收窄，实际 ${surface.engaged.length}`)
})

console.log('\n--- M. 失败路径必须可观测（不能静默失效）---')

test('M1 该部署没有 ptcRuntime 时记 no-runtime，而不是「没有标记」', () => {
  const ctx = boot(SUBAGENT_MODE, { ptcRuntime: false })
  const { agent } = fakeChild({ id: 'no-rt', provider: PTC_PROVIDER })
  ctx.emit('agent/created', { agent })

  const warned = log.warn.join('\n')
  assert(
    warned.includes('PTC-COLLAPSE-SKIPPED reason=no-runtime'),
    `缺运行时应当记 no-runtime，实际：${JSON.stringify(log.warn)}`,
  )
})

test('M2 minimal 侧拿不到 tools.restrict 时必须响亮告警（本版本没有静态层兜底）', () => {
  const ctx = boot(MINIMAL_GUARD)
  const { agent, surface } = fakeChild({ id: 'no-restrict', provider: MINIMAL_PROVIDER })
  surface.restrict = undefined
  ctx.emit('agent/created', { agent })

  const warned = log.warn.join('\n')
  assert(
    warned.includes('MINIMAL-NARROW-SKIPPED reason=no-restrict'),
    `应当有带固定标识的 warn，实际：${JSON.stringify(log.warn)}`,
  )
  assert(
    warned.includes('toolFilter'),
    '告警必须说明「静态 toolFilter 已随上游删除、身后没有第二层」，否则使用者会低估风险',
  )
})

// ── 反向验证：把主通道拿掉，P1/P2 必须变红 ────────────────────────────────────
//
// 否则这两条可能就是恒真的。做法与同目录其他脚本一致：**改源码**（不是改用例），
// 跑一遍，再改回来。
console.log('\n--- 反向验证（判别力确认）---')
{
  const fs = await import('node:fs')
  const targets = [
    ['subagent-mode.mjs', rel('subagent-mode.mjs'), `if (provider === PTC_PROVIDER) return 'ptc'`],
    ['minimal-guard.mjs', rel('minimal-guard.mjs'), 'if (provider === MINIMAL_PROVIDER) return true'],
  ]
  let checked = 0
  for (const [label, file, needle] of targets) {
    const original = fs.readFileSync(file, 'utf8')
    // 把 provider 判定换成恒假 —— 等价于「主通道失效」。
    const broken = original.replace(needle, needle.replace(/=== *(\w+)/, '=== "__disabled__"'))
    if (broken === original) {
      console.log(`  SKIP  ${label}：找不到 provider 判定，反向验证无法进行`)
      continue
    }
    fs.writeFileSync(file, broken)
    try {
      // 换一个带 cache-busting 查询的新 URL，避免 ESM 命中旧模块。
      const mod = await import(pathToFileURL(file).href + `?broken=${Date.now()}`)
      const ctx = fakeCtx()
      mod.apply(ctx, { enabled: true })
      const { agent, surface } = fakeChild({ id: `rev-${label}`, provider: PTC_PROVIDER })
      log.warn.length = 0
      ctx.emit('agent/created', { agent })
      assert(
        surface.engaged.length === 0,
        `去掉 provider 判定后 ${label} 竟然还有动作（${surface.engaged.length} 条）—— 说明 P1/P2 是恒真的`,
      )
      console.log(`  PASS  去掉 provider 判定后 ${label} 静默不动作（P1/P2 因此不是恒真的）`)
      checked++
    } catch (error) {
      console.log(`  FAIL  反向验证（${label}）：${error.message}`)
      results.push({ name: `反向验证 ${label}`, ok: false, message: error.message })
    } finally {
      fs.writeFileSync(file, original)
    }
  }
  if (checked === targets.length) {
    console.log('  判别力确认：两个模块去掉 provider 判定后都静默不动作。')
  }
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n模式标记来源回归：${results.length} 条用例，${results.length - failed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
