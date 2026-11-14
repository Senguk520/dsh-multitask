/**
 * subagent-watchdog 行为校验（进程内 / 零依赖 / 不 spawn / 不写盘）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * 看门狗是**定时器 + 在册表**，两者的失效都只在运行期可见，而且失效方向是「静默」：
 *
 *   · 判据写错 ⇒ 该停的没停，父会话永远收不到唤醒 —— 正是本模块要消灭的那种静默；
 *   · 判据写反 ⇒ 把**活跃**的 worker 停掉，或去停别的模式 / 别人的 worker；
 *   · 清理漏了 ⇒ 进程挂着不退出（测试脚本会一直等到被外面杀掉）。
 *
 * 所以下面既有正向（会停）也有反向（活跃不杀、别的模式不碰、已释放不再处理），
 * 还有 fail-open（服务缺席时只记日志、不抛错）。
 *
 * ── 时间尺度 ─────────────────────────────────────────────────────────────────
 *
 * `apply` 用 `stallTimeoutMs: 120, tickMs: 10`，整套 < 2s。
 *
 * 这两个数是**余量**换来的，不要往下调：基准是毫秒级定时器，冷启动 / JIT / GC 的一次
 * 抖动就能到几十毫秒。早先用 `stallTimeoutMs: 20, tickMs: 5`（W2 每 5ms 保活、总共
 * 只跑 60ms）只有 4 倍余量，实测约 25–30% 概率把**活跃** worker 误判成停滞而变红。
 *
 * 现在的余量：
 *   · W2 每 20ms 保活一次、共 15 次（≈280ms）：单次间隔对 120ms 阈值是 6 倍；
 *   · W1 等 400ms 观察窗，判据在 130ms 上下拍板：约 3 倍；
 *   · W3 / W4 的**反向**断言等 300ms，同样远超 120ms —— 否则「没被停」可能只是
 *     「还没来得及停」，反向用例就退化成永绿。
 *
 * 不靠事件循环的即时性取胜：所有间隔都按「一次漂移吃掉一整段余量仍然安全」来定。
 *
 * ── 它不碰任何东西 ───────────────────────────────────────────────────────────
 *
 * 假 ctx（`on` / `emit` / `get` / `logger` / `dispose`）、假 `agents` 服务（一个 `Map`）、
 * 假 `subagents` 服务（记录 `interrupt` 的入参）。不起会话、不加载 DSH、不 spawn、
 * 不写文件。
 *
 * @module dsh-multitask/test/subagent-watchdog
 */
import {
  apply,
  STALLED_MARKER,
  ENGAGED_MARKER,
  SKIPPED_MARKER,
  NO_PARENT_MARKER,
} from '../../presets/multitask/subagent-watchdog.mjs'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 本模块自己的源码 —— W7 的静态钉子要直接读它（只读，不写盘）。 */
const SOURCE_FILE = fileURLToPath(new URL('../../presets/multitask/subagent-watchdog.mjs', import.meta.url))

const results = []

/**
 * 跑一条（可能异步的）用例并记录结果。
 *
 * ⚠️ 必须 `await`：本文件的用例全都要等定时器，漏了 `await` 会让它们**恒绿**。
 *
 * @param label - 用例名。
 * @param fn - 断言体；抛错即算失败。
 */
async function test(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
    console.log(`  PASS  ${label}`)
  } catch (error) {
    results.push({ label, ok: false, message: error.message })
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

/** 最小断言（本仓库刻意不用 `node:assert`：少一处依赖）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 等一会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 深比较（本仓库刻意不用 `node:assert`，这里只需要比对象字面量）。
 *
 * 用值比较而不是 `===`：瀑布的契约是「把下游给的对象原样返回」，
 * 拿同一个引用去比会把「包了一层新对象」这种错放过去。
 *
 * @param a - 左值。
 * @param b - 右值。
 * @returns 两者结构相同则为 true。
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => deepEqual(a[key], b[key]))
}

/**
 * 从源码里截出以 `marker` 开头的那次调用的完整文本（按括号配对找收尾）。
 *
 * 只做括号计数：被截的是一段合法 JS，括号必然配平；注释里出现的成对括号也不影响。
 *
 * @param source - 源码全文。
 * @param marker - 调用的开头，例如 `ctx.on('tools/post-execute'`。
 * @returns 从 marker 到对应 `)` 的切片（含）。
 */
function sliceCallAt(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`源码里找不到 ${marker}`)
  const open = source.indexOf('(', start)
  if (open < 0) throw new Error(`${marker} 之后没有左括号`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`从 ${marker} 起找不到配对的收尾括号`)
}

/**
 * 造一个假的插件上下文。
 *
 * 实现 `apply()` 用到的全部四样东西：`on` / `get` / `logger`，外加测试用的 `emit`。
 *
 * @param options.withSubagents - 是否提供 `subagents` 服务（缺省提供）。
 * @returns 假 ctx（附 `agents` 表、`interrupts` 记录、`log` 记录、`handlers` 注册表）。
 */
function makeCtx({ withSubagents = true } = {}) {
  /** @type {Map<string, Array<(payload: any) => void>>} */
  const listeners = new Map()
  /** 假 `agents` 服务：会话 id -> agent。 */
  const agents = new Map()
  /** `interrupt()` 的每次入参。 */
  const interrupts = []
  const log = []

  const ctx = {
    agents,
    interrupts,
    log,
    /**
     * 注册表原文（event -> 处理器数组）。
     *
     * W6 要**取出**注册的处理器按宿主的调用形状直接调它：瀑布的返回值只在
     * 「谁接住返回值」那里看得见，走 `emit` 验不出来。
     */
    handlers: listeners,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    get(service) {
      if (service === 'agents') {
        return { get: (id) => agents.get(id) }
      }
      if (service === 'subagents') {
        if (!withSubagents) return undefined
        return {
          interrupt(id, options) {
            interrupts.push({ id, options })
          },
        }
      }
      return undefined
    },
    logger: {
      info: (message) => log.push(message),
      warn: (message) => log.push(message),
      debug: () => {},
    },
  }

  return ctx
}

/**
 * 造一个假的父 agent（协调者）。
 *
 * `composedPreset()` 是**活绑定** —— 本模块的权威归属信号。
 *
 * @param id - 会话 id。
 * @param preset - 活绑定返回的 preset id。
 * @returns 假 agent。
 */
function makeParent(id, preset = 'multitask') {
  return {
    session: { id, header: { agentPreset: preset } },
    ctx: {
      get: (service) => (service === 'agentPresets' ? { composedPreset: () => preset } : undefined),
    },
  }
}

/**
 * 造一个假的被委派子代理。
 *
 * @param id - 会话 id。
 * @param parentId - 父会话 id。
 * @returns 假 agent。
 */
function makeChild(id, parentId) {
  return {
    session: { id, header: { origin: 'subagent', parentSession: parentId } },
    // 子代理自己的 scope 不提供 preset 注册表 —— 归属只能由父侧决定。
    ctx: {},
  }
}

/**
 * 标准配置：120ms 算停滞，10ms 巡一次。
 *
 * 阈值不要往下调：见文件头的「时间尺度」。W2 靠「保活间隔 ≪ 阈值」留余量，
 * 而保活本身就是一个毫秒级定时器 —— 两者接近到 4 倍以内时，一次调度抖动就会翻红。
 */
const CONFIG = { enabled: true, presetId: 'multitask', stallTimeoutMs: 120, tickMs: 10 }

/**
 * 发 `times` 次工具调用事件、每次间隔 `everyMs`（模拟一个真的在干活的 worker）。
 *
 * 用「计数 + 显式 await」而不是 `setInterval` + 总时长：定时器漂移不会改变**发了多少次**，
 * 于是这条用例验的东西与机器快慢无关，只有发送节奏会随负载轻微伸缩。
 *
 * @param ctx - 假 ctx。
 * @param agent - 发出调用的 agent。
 * @param times - 发多少次。
 * @param everyMs - 相邻两次的间隔。
 * @returns 最后一次发完即 resolve 的 Promise。
 */
async function keepAlive(ctx, agent, times, everyMs) {
  for (let index = 0; index < times; index += 1) {
    // 宿主把 `tools/post-execute` 当**瀑布**调用：结果与 `next` 都要喂给处理器。
    // 只给 `exec` 会让处理器里的 `return next()` 炸在这儿，测出来的就成了假红。
    ctx.emit('tools/post-execute', { agent }, { kind: 'accept' }, () => ({ kind: 'accept' }))
    if (index < times - 1) await sleep(everyMs)
  }
}

console.log('\n===== subagent-watchdog 行为校验（进程内 / 零依赖）=====')

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 1. 会停：停滞的 worker 被停掉，父会话因此能被唤醒 ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W1 ★ 120ms 无活动的子代理被 interrupt 一次，id 是子会话 id', async () => {
  const ctx = makeCtx()
  apply(ctx, CONFIG)

  const parent = makeParent('session-parent')
  const child = makeChild('session-child', 'session-parent')
  ctx.agents.set('session-parent', parent)

  ctx.emit('agent/created', { agent: parent })
  ctx.emit('agent/created', { agent: child })

  // 120ms 阈值 + 10ms 巡检 ⇒ 判据在 130ms 上下拍板；400ms 观察窗留了约 3 倍余量。
  await sleep(400)

  assert(
    ctx.interrupts.length === 1,
    `期望 interrupt 恰好 1 次，实际 ${ctx.interrupts.length} 次 —— ` +
      '停滞的 worker 没被停下来，父会话就永远收不到唤醒（正是本模块要消灭的那种静默）',
  )
  assert(
    ctx.interrupts[0].id === 'session-child',
    `interrupt 的 id 是 ${JSON.stringify(ctx.interrupts[0].id)}，应当是子会话 id "session-child" —— ` +
      '停错对象等于替别的会话做决定',
  )
  assert(
    ctx.interrupts[0].options?.kind === 'ancestor',
    `interrupt 的 authority 是 ${JSON.stringify(ctx.interrupts[0].options?.kind)}，应当是 "ancestor" —— ` +
      '上游据此做血缘校验，写错会被拒绝',
  )
  assert(
    ctx.interrupts[0].options?.agent === parent,
    'interrupt 没有带上父 agent —— 有父 agent 时必须传它（血缘校验要靠它判定祖先关系）',
  )
  assert(
    ctx.log.some((line) => line.includes(STALLED_MARKER)),
    `日志里没有 ${STALLED_MARKER} —— 出问题时无从 grep`,
  )
  assert(
    ctx.log.some((line) => line.includes(ENGAGED_MARKER)),
    `日志里没有 ${ENGAGED_MARKER} —— 无法确认看门狗真的纳入了这个 worker`,
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. 活跃不误杀：每次工具调用都算活动 ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W2 ★ 每 20ms 有一次工具调用的子代理，约 280ms 内 interrupt 0 次', async () => {
  const ctx = makeCtx()
  apply(ctx, CONFIG)

  const parent = makeParent('session-parent')
  const child = makeChild('session-child', 'session-parent')
  ctx.agents.set('session-parent', parent)

  ctx.emit('agent/created', { agent: parent })
  ctx.emit('agent/created', { agent: child })

  // 15 次 × 20ms 间隔：单次静默最长 20ms，对 120ms 阈值是 6 倍余量。
  await keepAlive(ctx, child, 15, 20)

  assert(
    ctx.interrupts.length === 0,
    `活跃的 worker 被停了 ${ctx.interrupts.length} 次 —— ` +
      '判据只看「多久没活动」，任何工具调用都必须刷新时间戳，否则正常干活的 worker 会被误杀',
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. 不碰别的模式：归属判定听父会话的活绑定 ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W3 ★ 父会话组的是 standard ⇒ 该子代理从不在册，interrupt 0 次', async () => {
  const ctx = makeCtx()
  apply(ctx, CONFIG)

  const parent = makeParent('session-parent', 'standard')
  const child = makeChild('session-child', 'session-parent')
  ctx.agents.set('session-parent', parent)

  ctx.emit('agent/created', { agent: parent })
  ctx.emit('agent/created', { agent: child })

  // 等过 120ms 阈值（300ms，2.5 倍）：不该在册的 worker 若被误纳入，这段时间足够它被停 ——
  // 等太短会让「没被停」仅仅意味着「还没来得及停」，反向用例就成了永绿。
  await sleep(300)

  assert(
    ctx.interrupts.length === 0,
    `别的模式的 worker 被停了 ${ctx.interrupts.length} 次 —— ` +
      '那等于替另一个会话做决定（它的协调者没要求任何看门狗）',
  )
  assert(
    ctx.log.some((line) => line.includes(SKIPPED_MARKER) && line.includes('other-preset')),
    `日志里没有带 reason=other-preset 的 ${SKIPPED_MARKER} —— ` +
      '「为什么没纳入」必须留痕，否则判据写错时完全看不出来',
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 4. 已释放不再处理：agent/disposed 之后从在册里删掉 ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W4 ★ 子代理 disposed 之后再等 300ms，interrupt 0 次', async () => {
  const ctx = makeCtx()
  apply(ctx, CONFIG)

  const parent = makeParent('session-parent')
  const child = makeChild('session-child', 'session-parent')
  ctx.agents.set('session-parent', parent)

  ctx.emit('agent/created', { agent: parent })
  ctx.emit('agent/created', { agent: child })
  // 立刻释放：远早于 120ms 的停滞阈值。
  ctx.emit('agent/disposed', { agent: child })

  // 300ms：若这条记录留在在册表里，130ms 上下就该被停 —— 等这么长才证明它真的被删掉了。
  await sleep(300)

  assert(
    ctx.interrupts.length === 0,
    `已经释放的 worker 仍被停了 ${ctx.interrupts.length} 次 —— ` +
      '在册表里留着过期记录，会对一条已经不存在的会话报警并去 interrupt 它',
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 5. fail-open：服务缺席只记日志、不抛错 ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W5 ★ ctx.get("subagents") 返回 undefined 时不抛错，只记日志', async () => {
  const ctx = makeCtx({ withSubagents: false })

  let thrown
  try {
    apply(ctx, CONFIG)
    const parent = makeParent('session-parent')
    const child = makeChild('session-child', 'session-parent')
    ctx.agents.set('session-parent', parent)
    ctx.emit('agent/created', { agent: parent })
    ctx.emit('agent/created', { agent: child })
    // 正向用例（要看见停滞真的被判出来）：400ms 观察窗，同 W1 的约 3 倍余量。
    await sleep(400)
  } catch (error) {
    thrown = error
  }

  assert(
    thrown === undefined,
    `subagents 服务缺席时抛错了：${thrown?.message} —— 代价是把正常会话弄坏，` +
      '而最坏只该是「这条停滞继续静默」',
  )
  assert(
    ctx.log.some((line) => line.includes(STALLED_MARKER)),
    `日志里没有 ${STALLED_MARKER} —— 停滞的判定与「停不掉」的处置应当分别留痕`,
  )
  assert(
    ctx.log.some((line) => line.includes('no-interrupt-api')),
    '日志里没有 reason=no-interrupt-api —— 停不掉的路径必须留下原因，否则无法与「没停滞」区分',
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 6. 瀑布契约：tools/post-execute 必须把下游结果原样传回 ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W6 ★ 处理器返回下游 next() 的结果；next 抛错时照常抛出', async () => {
  const ctx = makeCtx()
  apply(ctx, CONFIG)

  const handlers = ctx.handlers.get('tools/post-execute') ?? []
  assert(
    handlers.length === 1,
    `tools/post-execute 的处理器应当恰好注册 1 个，实际 ${handlers.length} 个 —— ` +
      '本用例要直接调它，数量不对说明注册路径变了',
  )

  const child = makeChild('session-child', 'session-parent')

  // 正向：宿主给的 `next()` 结果必须原样（值上）回到调用方。
  // 返回一个**新**对象再深比较，才验得出「原样传回」而不是「碰巧同一个引用」。
  const expected = { kind: 'accept', ok: 42 }
  const returned = handlers[0]({ agent: child }, { kind: 'accept' }, () => ({ kind: 'accept', ok: 42 }))
  assert(
    deepEqual(returned, expected),
    `处理器返回了 ${JSON.stringify(returned)}，应当是下游结果 ${JSON.stringify(expected)} —— ` +
      '`tools/post-execute` 是**瀑布**（`(exec, result, next)`）。返回 undefined 会把每一次工具调用的' +
      '结果抹成 undefined，宿主随后读 `result.kind` 就抛 ' +
      "\"Cannot read properties of undefined (reading 'kind')\"；" +
      '表现为「七种工具全炸、动作却已经执行」，而且跨重启存活 —— 这条断言就守这里',
  )

  // 反向：下游抛的错必须照常冒泡，不能被这层 try/catch 吞掉。
  const boom = new Error('downstream exploded')
  let thrown
  try {
    handlers[0]({ agent: child }, { kind: 'accept' }, () => {
      throw boom
    })
  } catch (error) {
    thrown = error
  }
  assert(
    thrown === boom,
    '下游 next() 抛的错被吞掉了 —— 瀑布里的异常必须照常冒泡，否则真实故障会静默：' +
      '动作已经执行、结果却永远不回来',
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 7. 静态钉子：源码里 tools/post-execute 的处理器必须 return next() ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W7 ★ 源码中 tools/post-execute 的那次 ctx.on(…) 内含 return next()', () => {
  const source = fs.readFileSync(SOURCE_FILE, 'utf8')
  const call = sliceCallAt(source, "ctx.on('tools/post-execute'")

  // 签名：必须接住 `next`（第二个参数是结果、第三个是 next —— 少写一个就会拿到错误的东西）。
  assert(
    /\(\s*exec\s*,\s*_?result\s*,\s*next\s*\)/.test(call),
    `处理器签名不是 (exec, _result, next)：\n${call.split('\n')[0]}\n` +
      '`tools/post-execute` 是瀑布，签名写错就接不住 `next`',
  )

  // 静态钉子：瀑布里必须把下游结果传回去 —— 这条是 W6 的「行为」断言的源码侧备份，
  // 防止有人把它改回普通监听（改了 W6 会红，但源码钉子让红指向具体那一行）。
  assert(
    call.includes('return next()'),
    `这一段里没有 return next()：\n${call}\n` +
      '`tools/post-execute` 是**瀑布** —— 少了这一句，每一次工具调用的结果都变成 undefined' +
      '（而动作已经执行），宿主读 `result.kind` 时抛 ' +
      "\"Cannot read properties of undefined (reading 'kind')\"",
  )
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 8. 父会话说没就没了：不许调 interrupt（{kind} 缺 agent 必 TypeError） ---')
// ─────────────────────────────────────────────────────────────────────────────

await test('W8 ★ 父 agent 解析不到时 interrupt 0 次，且 NO-PARENT 与 STALLED 都在日志里', async () => {
  const ctx = makeCtx()
  apply(ctx, CONFIG)

  // 父会话**不在** `agents` 表里（它就是「说没就没了」的那种场景）。归属只能靠子代理
  // 会话头的 `agentPreset` 兜底 —— 没有它，worker 根本不会被纳入，本用例就成了永绿。
  const child = makeChild('session-child', 'session-parent')
  child.session.header.agentPreset = 'multitask'
  ctx.emit('agent/created', { agent: child })

  // 120ms 阈值 + 10ms 巡检；400ms 观察窗同 W1（约 3 倍余量）。
  await sleep(400)

  assert(
    ctx.interrupts.length === 0,
    `父 agent 解析不到时仍调用了 interrupt ${ctx.interrupts.length} 次 —— ` +
      '`{ kind: "ancestor" }` 缺 `agent` 会让宿主在 dsh-subagent 里直接读 `authority.agent` 而抛 ' +
      'TypeError（被本模块 catch 吞成 [reason=interrupt-threw]），于是 worker 继续卡、' +
      '父会话不被唤醒：最需要兜底的场景必然失败',
  )
  assert(
    ctx.log.some((line) => line.includes(NO_PARENT_MARKER)),
    `日志里没有 ${NO_PARENT_MARKER} —— 「判出停滞但没敢停」这件事必须留痕，` +
      '否则与「没判出停滞」无法区分',
  )
  assert(
    ctx.log.some((line) => line.includes(STALLED_MARKER)),
    `日志里没有 ${STALLED_MARKER} —— 停不了人**不等于**没判出停滞：` +
      '「判出停滞」这条事实必须照记，否则会以为看门狗根本没工作',
  )

  ctx.emit('dispose')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 汇总 ---')
const passed = results.filter((entry) => entry.ok).length
const failed = results.length - passed
console.log(`  用例总数: ${results.length}`)
console.log(`  PASS: ${passed}`)
console.log(`  FAIL: ${failed}`)
console.log(failed === 0 ? '  结论: 全绿' : '  结论: 有红灯，见上面的 FAIL 明细')

process.exitCode = failed === 0 ? 0 : 1
