/**
 * 跨模式派发（`preset-dispatch.mjs`）的行为回归 —— 进程内、零依赖、不加载 DSH。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `subagent_preset` 是「减震器」从**本 preset 内部**扩展到**用户与所有已安装模式之间**
 * 的唯一通道。它的失败方式都很难在会话里看出来：
 *
 *   · 拒绝路径写错 ⇒ 协调者拿到一个空 id，对着它发呆，或者把「派给自己」当成功能坏了；
 *   · `provider` 写错 ⇒ 到**委派那一刻**才抛能力错误，报错指向 provider，与本模块无关；
 *   · worker 也能调用 ⇒ 撞深度限制，报错说的是 `subagent depth 2 exceeds maxDepth 1`，
 *     同样看不出与跨模式派发有关。
 *
 * 所以这里逐条把**可观察的行为**钉住：注册了什么、什么时候拒绝、拒绝时说什么、
 * 真的派出去时请求长什么样。
 *
 * ── 它用什么替身 ─────────────────────────────────────────────────────────────
 *
 * 一个几十字节的假 `ctx`（只实现 `tools.register` / `get` / `logger`）与假
 * `subagents`。与同目录其他脚本同款取向：不是「模拟 DSH」，而是「把调用点逼出来」——
 * 模块用到替身没有的成员就会抛错，用例即红。
 *
 * @module dsh-multitask/test/preset-dispatch
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.join(here, '..', '..', 'presets', 'multitask', 'preset-dispatch.mjs')
const dispatch = await import(pathToFileURL(MODULE).href)

const results = []
const log = { info: [], warn: [] }
const registered = []
let started = []

/** 跑一条用例并记录（与同目录另几个脚本同形状）。 */
async function test(name, fn) {
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

/** 最小断言（本仓库刻意不用 `node:assert`）。 */
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// ── 替身 ─────────────────────────────────────────────────────────────────────

/**
 * 造一个假插件 ctx。
 *
 * @param options - `{ roster, subagents }`；`roster` 为 undefined 表示注册表不可用。
 * @returns 假 ctx。
 */
function fakeCtx(options = {}) {
  return {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    get(name) {
      if (name === 'agentPresets') {
        return options.roster === undefined ? undefined : { list: async () => options.roster }
      }
      if (name === 'subagents') return options.subagents
      return undefined
    },
    logger: {
      info: (m) => log.info.push(m),
      warn: (m) => log.warn.push(m),
    },
  }
}

/** 一份名册：包含可运行的、坏掉的、以及本模式自己。 */
const ROSTER = [
  { id: 'standard', order: 1 },
  { id: 'ptc', name: 'PTC', order: 2 },
  { id: 'broken-one', broken: 'tool-subagent: boom' },
  { id: 'multitask', name: 'Multitask' },
]

/** 一个会记录调用参数的假 subagents 服务。 */
function fakeSubagents() {
  return {
    list: () => ['spawn', 'fork', 'multitask_ptc', 'multitask_minimal'],
    resolveMaxDepth: (n) => n,
    async startActivation(spec) {
      started.push(spec)
      return { childId: 'child-123' }
    },
  }
}

const rootAgent = { id: 'root', session: { id: 'root', header: { id: 'root', cwd: 'H:\\ws' } } }
const childAgent = {
  id: 'kid',
  session: { id: 'kid', header: { id: 'kid', origin: 'subagent', parentSession: 'root' } },
}

/** 装载一次，返回刚注册的那个工具定义。 */
function boot(options = {}) {
  const before = registered.length
  dispatch.apply(
    fakeCtx({ roster: ROSTER, subagents: fakeSubagents(), ...options }),
    { enabled: true, selfPresetId: 'multitask' },
  )
  const tool = registered[before]
  assert(tool !== undefined, '本行没有注册任何工具')
  return tool
}

console.log('===== 跨模式派发（preset-dispatch）行为回归 =====')

console.log('\n--- 1. 注册 ---')
const tool = boot()

await test('D1 注册的工具名是 subagent_preset，且留了 ENGAGED 标识', () => {
  // ⚠️ 必须在**用例内部**重新装载一次：`boot()` 在模块顶层已经跑过，而 `test()` 会在
  // 每条用例前清空 `log`，所以顶层那次留下的 ENGAGED 早已被清掉。在顶层断言它，
  // 测到的永远是「日志里没有」—— 那是判据错，不是行为错（实测踩过）。
  const fresh = boot()
  assert(fresh.name === dispatch.TOOL_NAME, `工具名是 ${JSON.stringify(fresh.name)}，与导出的 TOOL_NAME 不一致`)
  assert(
    log.info.some((m) => m.includes('PRESET-DISPATCH-ENGAGED')),
    '注册成功时应当留一条可 grep 的 ENGAGED 标识（否则「整段没跑到」与「跑成功了」无法区分）',
  )
})

await test('D2 工具声明了 output.schema 与 render（注册的硬要求）', () => {
  assert(tool.output !== undefined, '没有 output —— dsh-tools 的 register() 会直接拒绝')
  assert(typeof tool.output.render === 'function', 'output.render 不是函数 —— register() 会拒绝')
  assert(typeof tool.output.schema === 'object', 'output.schema 不是对象')
})

console.log('\n--- 2. 名册（list: true）---')

await test('D3 list 返回名册，并标出坏模式与本模式', async () => {
  const out = await tool.execute({ list: true }, { agent: rootAgent })
  assert(out.ok === true, `list 应当成功，实际：${JSON.stringify(out)}`)
  assert(out.message.includes('standard') && out.message.includes('ptc'), '名册里应当列出可运行的模式')
  assert(out.message.includes('CANNOT RUN'), '坏模式必须被标出来，否则协调者会选到一个起不来的模式')
  assert(out.message.includes('this mode'), '本模式应当被标出来，避免协调者把它当成可派目标')
})

await test('D4 注册表不可用时 list 给出可读的空结果，不抛错', async () => {
  const isolated = boot({ roster: undefined })
  const out = await isolated.execute({ list: true }, { agent: rootAgent })
  assert(out.ok === true, '注册表不在时 list 也不该抛错')
  assert(out.message.includes('No agent presets'), `应当解释没有可选模式，实际：${JSON.stringify(out.message)}`)
})

console.log('\n--- 3. 拒绝路径（每条都必须说清原因）---')

await test('D5 缺 preset / 缺 prompt 分别被拒，并指向 list', async () => {
  const noPreset = await tool.execute({}, { agent: rootAgent })
  assert(noPreset.ok === false && noPreset.message.includes('list: true'), '缺 preset 时应当提示用 list: true 查 id')
  const noPrompt = await tool.execute({ preset: 'standard' }, { agent: rootAgent })
  assert(noPrompt.ok === false && noPrompt.message.includes('prompt'), '缺 prompt 时应当说明任务书必填')
})

await test('D6 未知 preset 被拒，并列出可用 id', async () => {
  const out = await tool.execute({ preset: 'nope', prompt: 'x' }, { agent: rootAgent })
  assert(out.ok === false, '未知 id 不该被放行')
  assert(out.message.includes('Unknown agent preset'), '应当明确说「未知」')
  assert(out.message.includes('standard'), '应当列出可用 id，好让协调者改派')
})

await test('D7 broken 的 preset 被拒，并原样带出上游诊断', async () => {
  const out = await tool.execute({ preset: 'broken-one', prompt: 'x' }, { agent: rootAgent })
  assert(out.ok === false, '坏模式不该被放行')
  assert(out.message.includes('boom'), `应当带出上游的诊断原文，实际：${JSON.stringify(out.message)}`)
})

await test('D8 派给本模式自己被拒，并指向四条内置路径', async () => {
  const out = await tool.execute({ preset: 'multitask', prompt: 'x' }, { agent: rootAgent })
  assert(out.ok === false, '派给自己必须被拒（会造出一个派不出去的子协调者）')
  assert(out.message.includes('subagent_fork'), '应当指出正确的替代路径')
})

await test('D9 ★ worker 派单被拒，且没有真的启动任何东西', async () => {
  started = []
  const out = await tool.execute({ preset: 'ptc', prompt: 'x' }, { agent: childAgent })
  assert(out.ok === false, 'worker 不该能跨模式派发')
  assert(
    out.message.includes('depth is fixed at 1'),
    `拒绝理由必须说清是深度限制（否则会被误读成功能坏了），实际：${JSON.stringify(out.message)}`,
  )
  assert(started.length === 0, '被拒时绝不能已经启动了一个子代理')
})

await test('D10 没有调用者 agent 时被拒', async () => {
  const out = await tool.execute({ preset: 'standard', prompt: 'x' }, {})
  assert(out.ok === false && out.message.includes('calling Agent'), '没有 exec.agent 时应当明确拒绝')
})

console.log('\n--- 4. 正常派发：请求长什么样 ---')

await test('D11 ★ 派发请求带 agentPreset、provider 固定 spawn、prompt 是文本块', async () => {
  started = []
  const out = await tool.execute({ preset: 'ptc', prompt: 'do it', description: 'bulk work' }, { agent: rootAgent })
  assert(out.ok === true && out.subagentId === 'child-123', `派发失败：${JSON.stringify(out)}`)
  assert(started.length === 1, '应当恰好启动一个子代理')

  const spec = started[0]
  assert(spec.request.agentPreset === 'ptc', `agentPreset 是 ${JSON.stringify(spec.request.agentPreset)}`)
  assert(
    spec.provider === 'spawn',
    `provider 是 ${JSON.stringify(spec.provider)} —— 上游要求可跨 preset 的 provider 是 spawn（fork 不满足能力位）`,
  )
  assert(spec.request.prompt?.[0]?.type === 'text', 'prompt 必须是文本内容块数组')
  assert(spec.request.prompt[0].text === 'do it', 'prompt 文本被改写了')
  assert(spec.request.parent === rootAgent, 'parent 必须是发起调用的那个 agent')
  assert(spec.label === 'bulk work', `label 未透传，实际：${JSON.stringify(spec.label)}`)
})

await test('D12 启动抛错时如实带回原因（不吞、不猜）', async () => {
  const failing = {
    resolveMaxDepth: () => 1,
    async startActivation() {
      throw new Error('provider refused: nope')
    },
  }
  const isolated = boot({ subagents: failing })
  const out = await isolated.execute({ preset: 'standard', prompt: 'x' }, { agent: rootAgent })
  assert(out.ok === false, '启动失败必须报告失败')
  assert(
    out.message.includes('provider refused'),
    `必须原样带回上游错误（协调者据此才能改派），实际：${JSON.stringify(out.message)}`,
  )
  assert(
    log.warn.some((m) => m.includes('PRESET-DISPATCH-SKIPPED reason=start-threw')),
    '失败路径应当留一条可 grep 的固定标识',
  )
})

await test('D13 subagents 服务不可用时被拒，不抛错', async () => {
  const isolated = boot({ subagents: undefined })
  const out = await isolated.execute({ preset: 'standard', prompt: 'x' }, { agent: rootAgent })
  assert(out.ok === false && out.message.includes('subagent service'), '服务不在时应当给出可读的拒绝')
})

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n跨模式派发：${results.length} 条用例，${results.length - failed.length} 通过，${failed.length} 失败`)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
