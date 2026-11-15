/**
 * task-key 回归（进程内 / 零依赖）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `presets/multitask/task-key.mjs` 要求每份 brief 带一行 `task: <slug>`，并在**同一个
 * 键**已经有一个活着的 worker 时拒绝第二次派发。它存在的理由是机制上一个洞：
 * 派遣工具的参数里没有任务标识，所以「同一件事的第二遍」与「两件不同的事」在参数上
 * 一模一样，两个 worker 会并发改同一批文件。
 *
 * 这条链上有五种写法都能让它静默失效，而每一种都**不报错**，只表现为「又并发写文件了」：
 *
 *   1. **无键也放行** —— 那等于什么都没做，只是多了一次解析；
 *   2. **重复键也放行** —— 本模块的主要价值消失；
 *   3. **文法不收** —— `Fix Gate` / `fix/a` 成为合法键，于是同一个任务因为写法不同
 *      被登记成两个，拦截在真正需要它的时候不生效；
 *   4. **key 不按父会话隔离** —— 两个无关主对话用了同名 slug 就会互相挡住；
 *   5. **释放不生效** —— 第一个 worker 结束后同键永远派不出去（比不拦更糟：任务卡死）。
 *
 * 第 8 组是**判别力**验证：把唯一的决策函数整段改成恒放行，上面第 2、3 条必须变红。
 * 一条永远绿的守卫断言，恰好等于没有那条断言。
 *
 * @module dsh-multitask/test/task-key
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import * as MODULE_API from '../../presets/multitask/task-key.mjs'

const { name, apply, parseTaskKey } = MODULE_API

const MODULE = new URL('../../presets/multitask/task-key.mjs', import.meta.url)

const results = []

/**
 * 跑一条**异步**用例并记录。
 *
 * ⚠️ 每一条都要 `await`，所以只能有异步版本：用同步的 `try/catch` 包 async 函数会只拿到
 * 一个 pending Promise，于是每条断言都记成通过 —— 比没有测试更坏。
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

/** 造一个假 ctx（`get` 走一个服务表；`on` 把注册记进数组）。 */
function fakeCtx(services = {}) {
  const handlers = []
  const logs = { info: [], warn: [] }
  const ctx = {
    on(event, handler) {
      handlers.push({ event, handler })
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

/** 造一个假 agent（`session.header` 是判方向的三个信号所在）。 */
function fakeAgent(id, header) {
  return { id, session: { id, header: header ?? {} } }
}

/** 协调者（不是子代理）。 */
function coordinator(id) {
  return fakeAgent(id, {})
}

/** 子代理会话：`parentSession` 指回协调者。 */
function childAgent(id, parentId) {
  return fakeAgent(id, { origin: 'subagent', parentSession: parentId, delegationDepth: 1 })
}

/**
 * 搭一个场景：假 ctx + 假 `agents` 服务 + 已调过 `apply` 的模块。
 *
 * `agents.get(id)` 就是本模块判断「会话还活着」的唯一权威来源，所以这里必须**真的**
 * 有这么一个表：只想让 `agent/created` 绑定成功、却在下一轮检查时被判成「已释放」的
 * 假服务会让 T2 假绿。
 *
 * @param api - 模块命名空间（正常用例传真模块，判别力用例传变异体）。
 * @param parentId - 协调者的会话 id。
 * @returns 场景句柄。
 */
function scene(api, parentId) {
  delete globalThis[api.REGISTRY_KEY]
  const live = new Map()
  const agents = { get: (id) => live.get(id) }
  const { ctx, handlers, logs } = fakeCtx({ agents })
  api.apply(ctx, { enabled: true })

  const parent = coordinator(parentId)
  live.set(parentId, parent)

  const handlerFor = (event) => {
    const found = handlers.filter((h) => h.event === event)
    assert(found.length === 1, `${event} 应当恰好注册 1 个处理器，实际 ${found.length} 个`)
    return found[0].handler
  }

  return {
    live,
    logs,
    parent,
    handlers,
    /** 跑一次派遣（`next()` 恒为 allow）。 */
    async dispatch(toolName, args, agent = parent) {
      return await handlerFor('tools/pre-execute')({ name: toolName, agent, arguments: args }, async () => ({
        kind: 'allow',
      }))
    },
    /** 模拟子会话创建（绑定点）。 */
    created(child) {
      live.set(child.id, child)
      handlerFor('agent/created')({ agent: child })
    },
    /** 模拟子会话销毁（释放点）。 */
    disposed(child) {
      live.delete(child.id)
      handlerFor('agent/disposed')({ agent: child })
    },
    /** 读登记表（不存在时返回 undefined）。 */
    table() {
      return globalThis[api.REGISTRY_KEY]
    },
  }
}

/** 一份带任务键的最小任务书。 */
function brief(slug, extra = '') {
  return `task: ${slug}\n\nDo the work.${extra === '' ? '' : `\n${extra}`}`
}

console.log('===== dsh-multitask task-key 回归（进程内 / 零依赖）=====')

// ── 一、模块形状与解析 ──────────────────────────────────────────────────────
console.log('\n--- 1. 模块形状与解析 ---')

await testAsync('K1 导出 name / apply / 文法 / 登记表键名', async () => {
  assert(name === 'multitask-task-key', `name 不对：${name}`)
  assert(typeof apply === 'function', '模块没有导出 apply()')
  assert(typeof parseTaskKey === 'function', '模块没有导出 parseTaskKey() —— 解析规则就无法被单独钉住')
  assert(MODULE_API.SLUG_PATTERN instanceof RegExp, '模块没有导出 SLUG_PATTERN')
  assert(
    MODULE_API.REGISTRY_KEY === 'dsh-multitask:task-key:v1',
    `登记表的全局键名漂移了：${MODULE_API.REGISTRY_KEY} —— 别的模块按这个字面量读它`,
  )
})

await testAsync('T6 ★ 解析：`task=slug`、行首空白、列表标记、大小写不敏感都认', async () => {
  for (const [text, slug] of [
    ['task: fix-gate-a', 'fix-gate-a'],
    ['task=fix-gate-a', 'fix-gate-a'],
    ['   task: fix-gate-a   ', 'fix-gate-a'],
    ['\tTASK=fix-gate-a', 'fix-gate-a'],
    ['- task: fix-gate-a', 'fix-gate-a'],
    ['* task: fix-gate-a\nbody', 'fix-gate-a'],
  ]) {
    const parsed = parseTaskKey(text)
    assert(parsed.kind === 'ok' && parsed.slug === slug, `${JSON.stringify(text)} 应当解析成 ${slug}，实际 ${JSON.stringify(parsed)}`)
  }
  assert(parseTaskKey('Tasks: do the thing').kind === 'missing', '"Tasks:" 不是任务键行（多了一个 s），不该被当成键')
})

// ── 二、主路径：登记与放行 ──────────────────────────────────────────────────
console.log('\n--- 2. 主路径：登记与放行 ---')

await testAsync('T1 ★ 有键且无冲突 → 放行，且登记表里真的有一条占位', async () => {
  const s = scene(MODULE_API, 'coord-1')
  const out = await s.dispatch('subagent', { description: 'fix gate', prompt: brief('fix-gate-a') })
  assert(out?.kind === 'allow', `应当放行，实际 ${JSON.stringify(out)}`)
  const table = s.table()
  assert(table !== undefined && table.claims instanceof Map, '登记表没有建立')
  const claim = table.claims.get('coord-1::fix-gate-a')
  assert(claim !== undefined, `登记表里没有 coord-1::fix-gate-a，实际键：${[...table.claims.keys()].join(', ')}`)
  assert(claim.slug === 'fix-gate-a' && claim.tool === 'subagent', '占位里的 slug / tool 记错了')
  assert(Array.isArray(claim.ids) && claim.ids.length === 0, '新占位不该已经带子会话 id（那一刻子会话还不存在）')
})

await testAsync('T2 ★ 同键第二次 → 拒绝，文案给出已有 worker 的 id 前 8 位与「不要用 send_message」', async () => {
  const s = scene(MODULE_API, 'coord-1')
  const first = await s.dispatch('subagent', { description: 'fix gate', prompt: brief('fix-gate-a') })
  assert(first?.kind === 'allow', '第一次应当放行')
  const child = childAgent('child-7f3a91c2d4e5', 'coord-1')
  s.created(child)

  const second = await s.dispatch('subagent_ptc', { description: 'same job again', prompt: brief('fix-gate-a') })
  assert(second?.kind === 'deny', `同键第二次必须被拒，实际 ${JSON.stringify(second)}`)
  const reason = String(second.reason)
  assert(reason.includes('child-7f'), `拒绝文案没有给出已有 worker 的 id 前 8 位：${reason}`)
  assert(/running \d+s|running \d+m/.test(reason), `拒绝文案没有给出已运行时长：${reason}`)
  assert(reason.includes('send_message'), '拒绝文案必须点明不要用 send_message 让旧 worker 停')
  assert(reason.includes('interrupt_agent'), '拒绝文案必须给出 interrupt_agent 这条正确出路')
  assert(reason.includes('fix-gate-a'), '拒绝文案必须点名冲突的任务键')
})

await testAsync('T2b 未绑上子会话 id 时也拒绝，并说明 id 还没拿到（不编一个 id）', async () => {
  const s = scene(MODULE_API, 'coord-1')
  await s.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
  // 刻意不 created：模拟同一批消息里两个派遣（第二个派发时第一个还没有会话 id）
  const second = await s.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
  assert(second?.kind === 'deny', '同键第二次仍必须被拒')
  assert(/not known yet/.test(String(second.reason)), `应当明确说 id 还不知道：${second.reason}`)
})

// ── 三、拒绝：没有键 / 键不合法 ─────────────────────────────────────────────
console.log('\n--- 3. 拒绝：没有键 / 键不合法 ---')

await testAsync('T3 ★ 没有任务键 → 拒绝，文案要求补 `task: <slug>` 并给出文法与复用规则', async () => {
  const s = scene(MODULE_API, 'coord-1')
  const out = await s.dispatch('subagent', { description: 'no key', prompt: 'Just do the thing.' })
  assert(out?.kind === 'deny', `没有任务键必须被拒，实际 ${JSON.stringify(out)}`)
  const reason = String(out.reason)
  assert(reason.includes('task: <slug>'), `文案必须逐字写出要求的形式：${reason}`)
  assert(reason.includes('[a-z0-9][a-z0-9._-]{2,63}'), `文案必须给出文法：${reason}`)
  assert(reason.includes('SAME slug'), `文案必须写明「同一件工作复用同一个 slug」：${reason}`)
  assert(s.table() === undefined || s.table().claims.size === 0, '被拒的派发不该登记任何占位')
})

await testAsync('T4 ★ 键不合法（大写 / 空格 / 太短 / 带斜杠）→ 拒绝并说明文法', async () => {
  const bad = ['Fix-Gate', 'fix gate', 'ab', 'fix/gate', 'fix-gate-a!']
  for (const raw of bad) {
    const s = scene(MODULE_API, 'coord-1')
    const out = await s.dispatch('subagent', { description: 'x', prompt: `task: ${raw}\n\nbody` })
    assert(out?.kind === 'deny', `task: ${raw} 必须被拒，实际 ${JSON.stringify(out)}`)
    assert(
      String(out.reason).includes('[a-z0-9][a-z0-9._-]{2,63}'),
      `拒绝文案必须给出文法（task: ${raw}）：${out.reason}`,
    )
    assert(String(out.reason).includes(JSON.stringify(raw)), `拒绝文案必须原样引用那个非法值（task: ${raw}）`)
  }
})

await testAsync('T4b fail-closed：一份 brief 里两个不同的键 → 拒绝；同一个键重复写 → 放行', async () => {
  const one = scene(MODULE_API, 'coord-2')
  const dup = await one.dispatch('subagent', { description: 'x', prompt: 'task: fix-gate-a\n\ntask: fix-gate-b\n\nbody' })
  assert(dup?.kind === 'deny', `两个不同的键必须被拒（解析不确定 ⇒ fail-closed），实际 ${JSON.stringify(dup)}`)
  assert(String(dup.reason).includes('fix-gate-a') && String(dup.reason).includes('fix-gate-b'), '文案要点名两个键')

  const two = scene(MODULE_API, 'coord-2')
  const same = await two.dispatch('subagent', { description: 'x', prompt: 'task: fix-gate-a\ntask=fix-gate-a\nbody' })
  assert(same?.kind === 'allow', `同一个键写两遍不该被拒，实际 ${JSON.stringify(same)}`)
})

// ── 四、释放 ────────────────────────────────────────────────────────────────
console.log('\n--- 4. 释放：第一个结束后同键可以再派 ---')

await testAsync('T5 ★ agent/disposed 之后同键可以再派（释放真的生效，不是永久占用）', async () => {
  const s = scene(MODULE_API, 'coord-1')
  await s.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
  const child = childAgent('child-7f3a91c2d4e5', 'coord-1')
  s.created(child)
  const blocked = await s.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
  assert(blocked?.kind === 'deny', '派发前应当是「被占着」的状态')

  s.disposed(child)
  assert(s.table().claims.size === 0, `disposed 之后登记表应当清空，实际还有 ${s.table().claims.size} 条`)

  const again = await s.dispatch('subagent', { description: 'takeover', prompt: brief('fix-gate-a') })
  assert(again?.kind === 'allow', `第一个结束后同键必须可以再派，实际 ${JSON.stringify(again)}`)
})

await testAsync('T5b 漏发 agent/disposed 时，靠 agents.get() 的活体检查也要释放（无时间 TTL）', async () => {
  const s = scene(MODULE_API, 'coord-1')
  await s.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
  const child = childAgent('child-7f3a91c2d4e5', 'coord-1')
  s.created(child)
  // 只把会话从活体表里拿掉，**不**发 agent/disposed —— 模拟漏发
  s.live.delete(child.id)

  const again = await s.dispatch('subagent', { description: 'takeover', prompt: brief('fix-gate-a') })
  assert(again?.kind === 'allow', `会话已不在活体表里，同键必须可以再派，实际 ${JSON.stringify(again)}`)
})

// ── 五、作用域与方向 ────────────────────────────────────────────────────────
console.log('\n--- 5. 作用域：按父会话隔离 / 方向闸门 / 非派遣工具 ---')

await testAsync('T7 ★ 不同父会话用同一个 slug → 互不干扰', async () => {
  const a = scene(MODULE_API, 'coord-a')
  const first = await a.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
  assert(first?.kind === 'allow', 'A 会话第一次应当放行')

  // 同一个登记表、另一场主对话：`globalThis` 上的表是共用的，隔离靠键里的父会话 id。
  const live = a.live
  const agents = { get: (id) => live.get(id) }
  const { ctx, handlers } = fakeCtx({ agents })
  MODULE_API.apply(ctx, { enabled: true })
  const parentB = coordinator('coord-b')
  live.set('coord-b', parentB)
  const preB = handlers.find((h) => h.event === 'tools/pre-execute').handler
  const third = await preB({ name: 'subagent', agent: parentB, arguments: { prompt: brief('fix-gate-a') } }, async () => ({
    kind: 'allow',
  }))
  assert(third?.kind === 'allow', `另一个父会话用同名 slug 必须放行，实际 ${JSON.stringify(third)}`)
  assert(a.table().claims.has('coord-a::fix-gate-a'), 'A 会话的占位不该被 B 的派发影响')
  assert(a.table().claims.has('coord-b::fix-gate-a'), 'B 会话应当有自己的占位（键里带父会话 id）')
})

await testAsync('T9 方向闸门：worker 自己的调用原样通过；非派遣工具一个字都不碰', async () => {
  const s = scene(MODULE_API, 'coord-1')
  const worker = childAgent('child-9', 'coord-1')
  const fromWorker = await s.dispatch('subagent', { description: 'x', prompt: 'no key at all' }, worker)
  assert(fromWorker?.kind === 'allow', `worker 的调用不该被本模块拒绝（真正的拦截是深度上限），实际 ${JSON.stringify(fromWorker)}`)

  for (const tool of ['read', 'pwsh', 'send_message', 'interrupt_agent', 'workflow']) {
    const out = await s.dispatch(tool, { prompt: 'no key' })
    assert(out?.kind === 'allow', `${tool} 不是派遣工具，不该被碰，实际 ${JSON.stringify(out)}`)
  }
  assert(s.table() === undefined || s.table().claims.size === 0, '这些调用不该登记任何占位')
})

// ── 六、判别力：把决策函数改成恒放行，T2/T3 必须变红 ────────────────────────
console.log('\n--- 6. 判别力：恒放行的变异体必须让 T2/T3 变红 ---')

await testAsync('T8 ★ 把 judge() 改成恒放行后，T2（重复键）与 T3（无键）都必须变红，且源文件逐字还原', async () => {
  const original = fs.readFileSync(MODULE, 'utf8')
  const mutant = original.replace(/(function judge\(exec, now\) \{\n)/, '$1    return { kind: \'allow\' }\n')
  assert(mutant !== original, '变异没有落地：找不到 `function judge(exec, now) {` —— 决策函数被改名后，这条判别力断言失去对象')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mt-task-key-'))
  const file = path.join(dir, 'mutant.mjs')
  fs.writeFileSync(file, mutant, 'utf8')
  try {
    const api = await import(pathToFileURL(file).href)

    // 变异体上，T1 的情形仍然放行（证明变异是「恒放行」，不是「恒拒绝」）
    const ok = scene(api, 'coord-m')
    const allowed = await ok.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
    assert(allowed?.kind === 'allow', '恒放行变异体上基础用例仍应放行 —— 否则这不是判别力验证')

    // T2 的核心断言必须失败
    const s2 = scene(api, 'coord-m')
    await s2.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
    s2.created(childAgent('child-7f3a91c2d4e5', 'coord-m'))
    const dup = await s2.dispatch('subagent', { description: 'x', prompt: brief('fix-gate-a') })
    assert(dup?.kind !== 'deny', `变异体上重复键竟然仍被拒（${JSON.stringify(dup)}）—— T2 断言的对象不是 judge()`)
    console.log('        RED   T2 同键第二次 立刻变红（变异体放行了重复键）')

    // T3 的核心断言必须失败
    const s3 = scene(api, 'coord-m')
    const miss = await s3.dispatch('subagent', { description: 'x', prompt: 'no key at all' })
    assert(miss?.kind !== 'deny', `变异体上无键竟然仍被拒（${JSON.stringify(miss)}）—— T3 断言的对象不是 judge()`)
    console.log('        RED   T3 没有任务键 立刻变红（变异体放行了无键派发）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // 真模块**没有被写过**：还原不是「再写回去」，而是根本没动。
  const after = fs.readFileSync(MODULE, 'utf8')
  assert(after === original, '源文件在判别力验证期间被改动了 —— 变异必须落在临时副本上')
})

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\ntask-key 回归：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
