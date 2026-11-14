/**
 * coordinator-prompt 契约校验（静态 + 进程内 / 零依赖 / 不 spawn / 不写盘）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * 本轮修的是「协调者派完单不结束回合」。它由**两半**共同保证，任一半失效都会让缺陷
 * 原样回来：
 *
 *   1. **人格**（`composition.mjs` 的 `COORDINATOR_PERSONA`）：写明「没活可推进就
 *      结束回合」，并明确这条**覆盖**宿主 `tool:subagent` 那句「continue useful work
 *      while they run」。人格是模型的主纪律，缺了它，光有遮蔽也只是换个说法。
 *   2. **同名段遮蔽**（`presets/multitask/coordinator-prompt.mjs`）：宿主
 *      `dsh-tool-subagent` 那段是**无条件注入**、且没有 Config 能关，只能在更近的
 *      作用域上注册同名段 `tool:subagent` 把它盖掉（`dsh-system-prompt:245-249`）。
 *
 * 所以下面既有**文本断言**（人格里必须有那三句、旧指令不许回来），也有**行为断言**
 * （真的装段、装的对象对、装到哪、卸得掉、读不到服务时不炸）。
 *
 * ── 为什么既测「装了」也测「没装」──────────────────────────────────────────
 *
 * 只测正向是危险的：一个忽略判据、见到 agent 就装的实现也能全绿，而那会把
 * 「没活就结束回合」装到 **worker** 身上 —— worker 的整个意义是把活干完，这等于用
 * 修缺陷的手法制造一个更大的缺陷。所以子代理与外模式两条**反向**用例是必须的。
 *
 * ── 它不碰任何东西 ───────────────────────────────────────────────────────────
 *
 * 只读一个源文件、`import` 一个纯插件模块、在内存里造假 ctx 与假 agent：
 * 不起会话、不加载 DSH、不 spawn 进程、不写文件。
 *
 * @module dsh-multitask/test/coordinator-prompt-contract
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, SHADOW_TEXT, name, inject } from '../../presets/multitask/coordinator-prompt.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMPOSITION = path.join(ROOT, 'presets', 'multitask', 'composition.mjs')

const results = []

/** 跑一条用例并记录（与同目录 `approval-gate-rules.mjs` 同形状）。 */
function test(label, fn) {
  try {
    fn()
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

/** 读一个 UTF-8 文本文件。 */
function read(file) {
  return fs.readFileSync(file, 'utf8')
}

/**
 * 从 composition.mjs 的源码里切出 `COORDINATOR_PERSONA` 的**模板字面量正文**。
 *
 * 必须切片而不是全文匹配：本文件（与 composition 的注释）自己就会提到
 * "continue useful work while they run" 这类**被引用**的原话，全文匹配会把「注释里
 * 引用旧指令」误判成「人格里还有旧指令」。
 *
 * @param source - composition.mjs 的全文。
 * @returns 人格正文。
 */
function coordinatorPersonaOf(source) {
  const header = 'export const COORDINATOR_PERSONA = `'
  const start = source.indexOf(header)
  assert(start >= 0, 'composition.mjs 里找不到 COORDINATOR_PERSONA 的赋值语句 —— 判据失效，请先更新本测试')
  const bodyStart = start + header.length
  const bodyEnd = source.indexOf('`\n\n/**', bodyStart)
  assert(
    bodyEnd > bodyStart,
    '切不出 COORDINATOR_PERSONA 的模板字面量正文（找不到结束反引号）—— 判据失效，请先更新本测试',
  )
  return source.slice(bodyStart, bodyEnd)
}

/**
 * 造一个假的插件上下文。
 *
 * 只实现 `apply()` 用到的四样东西：`on` / `get` / `logger` / `systemPrompt`。
 *
 * @param options.withSystemPrompt - 是否提供 `systemPrompt` 服务（缺省提供）。
 * @returns 假 ctx（附 `emit` 与记录数组）。
 */
function makeCtx({ withSystemPrompt = true } = {}) {
  /** @type {Map<string, Array<(payload: any) => void>>} */
  const listeners = new Map()
  const sections = []
  const disposed = []
  const log = []

  const ctx = {
    sections,
    disposed,
    log,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    get() {
      return undefined
    },
    logger: {
      info: (message) => log.push(message),
      warn: (message) => log.push(message),
      debug: () => {},
    },
  }

  if (withSystemPrompt) {
    ctx.systemPrompt = {
      section(options) {
        sections.push(options)
        return () => disposed.push(options)
      },
      getSectionOrder: () => 2800,
    }
  }

  return ctx
}

/**
 * 造一个假 agent。
 *
 * @param options.header - 会话头字段（`agentPreset` 缺省为 `multitask`）。
 * @param options.withSystemPrompt - 该 agent 的 scope 是否暴露 `systemPrompt`。
 * @param options.livePreset - 若给出，`agent.ctx.get('agentPresets')` 返回一个
 *   `composedPreset()` 恒等于它的注册表（模拟**活绑定**，权威归属信号）。
 * @returns 假 agent（附它自己 scope 上的记录数组）。
 */
function makeAgent({ header = {}, withSystemPrompt = true, livePreset } = {}) {
  const sections = []
  const disposed = []
  const agentCtx = {}

  if (livePreset !== undefined) {
    const registry = { composedPreset: () => livePreset }
    agentCtx.get = (service) => (service === 'agentPresets' ? registry : undefined)
  }

  if (withSystemPrompt) {
    agentCtx.systemPrompt = {
      section(options) {
        sections.push(options)
        return () => disposed.push(options)
      },
      getSectionOrder: () => 2800,
    }
  }

  return {
    agent: {
      session: { header: { agentPreset: 'multitask', ...header } },
      // `ctx.tools` 刻意不给：本模块不读工具面（那正是它只需系统提示服务的原因）。
      ctx: agentCtx,
    },
    sections,
    disposed,
  }
}

const SOURCE = read(COMPOSITION)
const PERSONA = coordinatorPersonaOf(SOURCE)

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 1. 人格：结尾动作、通知路径、优先级 ---')
// ─────────────────────────────────────────────────────────────────────────────

test('P1 人格写明「没有可推进的事就结束回合」', () => {
  // 用**实际写下的措辞**断言，不用宽泛正则：正则越松，越容易在句子被改写后仍然绿。
  assert(
    PERSONA.includes('END YOUR TURN'),
    'COORDINATOR_PERSONA 里没有 "END YOUR TURN" —— 「没活可推进就结束回合」这条指令缺失，' +
      '派单之后的「边做边瞄」就会原样回来',
  )
  assert(
    PERSONA.toLowerCase().includes('end your turn') || PERSONA.toLowerCase().includes('ending the turn'),
    'COORDINATOR_PERSONA 里没有小写形式的 "end(ing) the turn" —— 只有大写强调句、正文没有解释，' +
      '模型读到的是口号而不是纪律',
  )
})

test('P2 人格写明「结论以新回合到达、不会因结束回合而丢失」', () => {
  assert(
    PERSONA.toLowerCase().includes('new turn'),
    'COORDINATOR_PERSONA 里没有 "new turn" —— 必须说明 worker 的结论**以新回合到达**，' +
      '否则「结束回合」会被读成「放弃结果」，模型反而更不敢停',
  )
  assert(
    PERSONA.includes('Nothing is lost by ending early'),
    'COORDINATOR_PERSONA 里没有 "Nothing is lost by ending early" —— 这是让模型敢停的那句保证',
  )
})

test('P3 人格写明本条**覆盖**宿主那句「continue useful work while they run」', () => {
  assert(
    PERSONA.includes('THIS section overrides it'),
    'COORDINATOR_PERSONA 里没有 "THIS section overrides it" —— 优先级没说清时，' +
      '宿主注入的那句「continue useful work while they run」会与人格互相矛盾，由模型自行裁决',
  )
  assert(
    PERSONA.includes('continue useful work while they run'),
    'COORDINATOR_PERSONA 没有点名宿主那句原话 —— 不点名就等于没驳回，模型仍可能照它执行',
  )
})

test('P4 旧的「然后边做边瞄」指令已经不在', () => {
  // 只看全文即可：这句是**旧第 3 步**的原话，任何位置再出现都意味着旧纪律回来了。
  assert(
    !SOURCE.includes('then keep working while they run'),
    'composition.mjs 里又出现了 "then keep working while they run" —— 那正是本轮要修掉的成因，' +
      '它会让人格里新增的「结束回合」被抵消',
  )
  // 反向确认：新第 3 步确实在人格里（否则上面那条可能只是「删了但没换」）。
  assert(
    PERSONA.includes('Then do only the coordinator\'s own work'),
    'COORDINATOR_PERSONA 里没有新第 3 步（"Then do only the coordinator\'s own work"）—— ' +
      '旧指令删掉了、新的没顶上，等于把这一段留空',
  )
})

test('P5 人格禁止用过程数据填等待（轮询 / 替 worker 读文件）', () => {
  for (const tool of ['list_agents', 'job_list', 'job_output']) {
    assert(
      PERSONA.includes(tool),
      `COORDINATOR_PERSONA 没有点名 \`${tool}\` —— 不点名的话，「不要轮询」会被读成一句空泛的劝告`,
    )
  }
  assert(
    PERSONA.includes('Never spend the wait on process data'),
    'COORDINATOR_PERSONA 缺少 "Never spend the wait on process data" 这条总纲',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. 模块形状：导出与文本 ---')
// ─────────────────────────────────────────────────────────────────────────────

test('M1 模块导出形状与 worker-persona 一致（name / inject / apply / 文本常量）', () => {
  assert(name === 'multitask-coordinator-prompt', `模块名漂移了：${JSON.stringify(name)}`)
  assert(Array.isArray(inject), '`inject` 必须是数组（本模块刻意不声明服务依赖）')
  assert(typeof apply === 'function', '模块没有导出 apply()')
  assert(typeof SHADOW_TEXT === 'string' && SHADOW_TEXT !== '', '模块没有导出 SHADOW_TEXT 常量')
})

test('M2 SHADOW_TEXT 保留宿主开头语义，落点改成「结束回合」', () => {
  assert(
    SHADOW_TEXT.startsWith('Start independent delegations'),
    'SHADOW_TEXT 没有保留宿主那句的开头语义（"Start independent delegations …"）—— ' +
      '整段换掉会让「怎么派单」的说明也一起消失',
  )
  assert(
    SHADOW_TEXT.includes('END YOUR TURN'),
    'SHADOW_TEXT 里没有 "END YOUR TURN" —— 遮蔽段没换掉落点，宿主原语义照旧生效',
  )
  for (const tool of ['list_agents', 'job_list', 'job_output']) {
    assert(SHADOW_TEXT.includes(tool), `SHADOW_TEXT 没有点名 \`${tool}\` —— 轮询禁令会落空`)
  }
})

test('M3 模块确实被挂进组合（否则遮蔽从未生效，而上面各条仍可全绿）', () => {
  assert(
    /local\(['"]\.\/coordinator-prompt\.mjs['"]\)/.test(SOURCE),
    'composition.mjs 里没有 `local(\'./coordinator-prompt.mjs\')` —— 模块存在但没被装载，' +
      '宿主那句「continue useful work while they run」会原样生效',
  )
  assert(
    /id:\s*['"]coordinator-prompt['"]/.test(SOURCE),
    'composition.mjs 里没有 id 为 coordinator-prompt 的行 —— 装载行被改名或删除',
  )
  assert(
    /config:\s*\{\s*enabled:\s*true,\s*presetId:\s*PRESET_ID\s*\}/.test(SOURCE),
    'composition.mjs 里那一行没有 `config: { enabled: true, presetId: PRESET_ID }` —— ' +
      '缺 presetId 时模块内部会判定「无法归属」并安静跳过，遮蔽永远不会装上',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. 行为：装哪段 / 给谁装 / 卸得掉 ---')
// ─────────────────────────────────────────────────────────────────────────────

test('B1 协调者被装上同名段 tool:subagent，order 2800，文本含 END YOUR TURN', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, presetId: 'multitask' })
  const { agent, sections } = makeAgent()

  ctx.emit('agent/created', { agent })

  assert(sections.length === 1, `期望恰好注册 1 段，实际 ${sections.length} 段`)
  const options = sections[0]
  assert(
    options.name === 'tool:subagent',
    `段名必须是 host 那段的名字（tool:subagent），实际 ${JSON.stringify(options.name)} —— ` +
      '改个名字就不会遮蔽，宿主那句会继续生效，而且不报错',
  )
  assert(options.order === 2800, `段顺序必须是 2800，实际 ${JSON.stringify(options.order)}`)
  const text = typeof options.text === 'function' ? options.text() : options.text
  assert(typeof text === 'string', '段的 text 既不是字符串也不是函数')
  assert(text.includes('END YOUR TURN'), '注册的段正文里没有 "END YOUR TURN"')
  assert(
    ctx.log.some((line) => line.includes('[MULTITASK-COORDINATOR-PROMPT-ENGAGED]')),
    '注册成功没有留下 [MULTITASK-COORDINATOR-PROMPT-ENGAGED] 日志 —— 出问题时无从 grep',
  )
})

test('B2 子代理不被装段（反向用例：装错方向会削弱 worker）', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, presetId: 'multitask' })

  for (const header of [
    { origin: 'subagent' },
    { parentSession: 'session-parent' },
    { delegationDepth: 1 },
  ]) {
    const { agent, sections } = makeAgent({ header })
    ctx.emit('agent/created', { agent })
    assert(sections.length === 0, `子代理 ${JSON.stringify(header)} 被装了段 —— ` +
      'worker 会被「没活就结束回合」约束，而它的整个意义是把活干完')
  }

  assert(
    ctx.log.some((line) => line.includes('[MULTITASK-COORDINATOR-PROMPT-SKIPPED]')),
    '被跳过的路径没有留下 [MULTITASK-COORDINATOR-PROMPT-SKIPPED] 日志',
  )
})

test('B3 别的 preset 的会话不被装段（模式隔离）', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, presetId: 'multitask' })

  const { agent, sections } = makeAgent({ header: { agentPreset: 'standard' } })
  ctx.emit('agent/created', { agent })
  assert(sections.length === 0, 'standard 模式的会话被装上了本模式的提示段 —— 越界改别的模式的纪律')
})

test('B4 读不到 systemPrompt 时安静跳过，且不抛错（fail-open）', () => {
  const ctx = makeCtx({ withSystemPrompt: false })
  const { agent, sections } = makeAgent({ withSystemPrompt: false })

  // 不抛就是通过的一半：`emit` 内部没有 try，抛错会直接冒到这里。
  let thrown
  try {
    apply(ctx, { enabled: true, presetId: 'multitask' })
    ctx.emit('agent/created', { agent })
  } catch (error) {
    thrown = error
  }
  assert(thrown === undefined, `读不到 systemPrompt 时抛错了：${thrown?.message} —— 代价是该会话起不来`)
  assert(sections.length === 0, '读不到 systemPrompt 却注册了段（不可能，但说明判据被绕过）')
})

test('B5 agent/disposed 调用 disposer，且同一 agent 再次 created 能重新注册', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, presetId: 'multitask' })
  const { agent, sections, disposed } = makeAgent()

  ctx.emit('agent/created', { agent })
  assert(sections.length === 1, `首次注册应为 1 段，实际 ${sections.length}`)

  // 重复 created 不得重复注册：同一 scope 注册同名段会被服务直接拒绝。
  ctx.emit('agent/created', { agent })
  assert(sections.length === 1, `同一 agent 的重复 agent/created 又注册了一段（共 ${sections.length} 段）—— ` +
    '同一个 scope 注册同名 section 会被服务拒绝')

  ctx.emit('agent/disposed', { agent })
  assert(disposed.length === 1, `agent/disposed 没有调用 disposer（调用 ${disposed.length} 次）—— ` +
    'scope key 被复用后，遗留段会让新会话莫名收到「结束回合」')

  ctx.emit('agent/created', { agent })
  assert(sections.length === 2, `disposed 之后重新 created 应能重新注册，实际仍是 ${sections.length} 段`)
})

test('B6 归属判定听活绑定，会话头是过期信息（两个方向都要对）', () => {
  // 方向一：活绑定说本模式、会话头还写着别的模式 —— 装。
  // 这是「从别的模式切进 Multitask」的会话，会话头停留在创建时的那份。
  {
    const ctx = makeCtx()
    apply(ctx, { enabled: true, presetId: 'multitask' })
    const { agent, sections } = makeAgent({
      header: { agentPreset: 'standard' },
      livePreset: 'multitask',
    })
    ctx.emit('agent/created', { agent })
    assert(
      sections.length === 1,
      `活绑定是 multitask、会话头是 standard 的会话没被装段（${sections.length} 段）—— ` +
        '归属只读会话头会漏掉「切进来」的会话，缺陷原样复现',
    )
  }

  // 方向二：活绑定说别的模式、会话头还写着 multitask —— 不许装。
  {
    const ctx = makeCtx()
    apply(ctx, { enabled: true, presetId: 'multitask' })
    const { agent, sections } = makeAgent({
      header: { agentPreset: 'multitask' },
      livePreset: 'standard',
    })
    ctx.emit('agent/created', { agent })
    assert(
      sections.length === 0,
      `活绑定是 standard、只剩会话头写着 multitask 的会话被装了段（${sections.length} 段）—— ` +
        '会话头是创建时的旧值，听它等于越界改别的模式的纪律',
    )
  }
})

// 本节守的是「遮蔽段只能装到 agent 自己的 scope 上」：插件级 `ctx` 就是 preset scope，
// 而子代理的 scope 链**也包含 preset scope** —— 一旦允许回退到那里注册，worker 也会
// 被塞进「END YOUR TURN」，可能让它提前收工（比原缺陷更糟）。
test('B7 插件级 ctx 有 systemPrompt、agent scope 没有 ⇒ 一段都不许注册（不得退回 preset scope）', () => {
  const ctx = makeCtx({ withSystemPrompt: true })
  apply(ctx, { enabled: true, presetId: 'multitask' })
  const { agent, sections } = makeAgent({ withSystemPrompt: false })

  // 不抛也是通过的一半：fallback 版会安静地在插件级注册。
  let thrown
  try {
    ctx.emit('agent/created', { agent })
  } catch (error) {
    thrown = error
  }
  assert(thrown === undefined, `读不到 agent 级 systemPrompt 时抛错了：${thrown?.message}`)

  assert(
    sections.length === 0,
    `agent scope 没有 systemPrompt，却被注册了 ${sections.length} 段 —— ` +
      '取不到服务时只许安静跳过（fail-open）',
  )
  assert(
    ctx.sections.length === 0,
    `退回插件级 ctx 注册了 ${ctx.sections.length} 段 —— 插件级就是 preset scope，` +
      '子代理的 scope 链也包含它：一旦走这条回退，worker 也会被塞进 "END YOUR TURN"',
  )
  assert(
    ctx.log.some((line) => line.includes('[MULTITASK-COORDINATOR-PROMPT-SKIPPED]') && line.includes('reason=no-system-prompt')),
    '跳过路径没有留下 [MULTITASK-COORDINATOR-PROMPT-SKIPPED] + reason=no-system-prompt 的日志',
  )
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
