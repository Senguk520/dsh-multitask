/**
 * 看门狗设置面校验（纯 module / 零依赖 / 不写盘 / 不 spawn）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `watchdog` 是本插件的第二个 volatile 设置字段：面板上的「停滞阈值 / 巡检间隔 /
 * 超时处理（三态）」保存时写的**整个对象**就是它。这条链路有三处各自会静默出错：
 *
 *   1. `lib/index.js` 的 `normalizeWatchdogSettings()` —— 清洗函数。它跑在 fiber 的
 *      配置解析路径上，**永不抛错**；写错一个分支不会报错，只会让用户填的值被
 *      悄悄换成别的数字（最坏是「设了 10 分钟却按 5 分钟停人」）。
 *   2. 面板显示的是**秒**、存的是**毫秒**，换算在客户端做；这里钉住的是宿主半收到的
 *      始终是毫秒，且越界时**钳制**而不是丢弃。
 *   3. `composition.mjs` 把三态派生成本行的 `enabled` / `interruptOnStall`。派生反了
 *      的后果是不对称的：`interrupt` 被派生成「只记录」= 卡死仍然静默；`log` 被派生成
 *      「停人」= 用户以为只是观察，worker 却被杀了。两个方向都不可接受。
 *
 * ── 为什么用 `buildPlugins()` 验证 composition，而不是 import `normalizeWatchdog` ──
 *
 * `normalizeWatchdog()` 是 composition 的**私有**函数（未导出）。`buildPlugins()` 才是
 * 公开入口，`readWatchdog()` 的产物正是从这里进到 `subagent-watchdog` 行的 `config`。
 * 所以下面直接驱动公开入口、读那一行的 `config` —— 断言的正是「宿主半传什么、运行时
 * 拿到什么」，比断言私有函数或源码文本都更接近实际。
 *
 * ── 它不碰任何东西 ───────────────────────────────────────────────────────────
 *
 * 只 `import` 两个模块（它们的模块求值本身就是本地回归的一部分：语法 / 引用错误会在
 * 这里变成可读的失败），不加载 DSH、不起会话、不写文件、不 spawn。
 *
 * @module dsh-multitask/test/watchdog-settings
 */
import { normalizeWatchdogSettings } from '../../lib/index.js'
import { buildPlugins } from '../../presets/multitask/composition.mjs'

/** 缺省值（**毫秒**）—— 与 `lib/index.js` 的 `WATCHDOG_DEFAULTS` 同一组数字。 */
const DEFAULTS = Object.freeze({ stallTimeoutMs: 300000, tickMs: 30000, mode: 'interrupt' })

const results = []
let assertionCount = 0

/**
 * 断言；失败即抛错，由 `test()` 记成一条 FAIL。
 *
 * @param condition - 断言条件。
 * @param message - 失败文案（要能单独说清哪里错了）。
 */
function assert(condition, message) {
  assertionCount += 1
  if (!condition) throw new Error(message)
}

/**
 * 结构比较 —— 两个值都是纯数据，JSON 比较足够。
 *
 * @param left - 实际值。
 * @param right - 期望值。
 * @returns 两者结构是否一致。
 */
function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 跑一条用例并记录结果；抛错即红，不中断后面的用例。
 *
 * @param label - 用例名。
 * @param fn - 断言体。
 */
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

/**
 * 在 `buildPlugins()` 产出的行表里按 id 找一行（会走进 `cordis:group` 的 config 数组）。
 *
 * @param rows - 行表。
 * @param id - 目标行 id。
 * @returns 找到的行，或 undefined。
 */
function findRow(rows, id) {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.id === id) return row
    if (Array.isArray(row.config)) {
      const hit = findRow(row.config, id)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/**
 * 取 `subagent-watchdog` 那一行（它才是设置最终的落点）。
 *
 * @param watchdog - 传给 `buildPlugins()` 的看门狗入参。
 * @returns 那一行的 `config`。
 */
function watchdogConfig(watchdog) {
  const row = findRow(buildPlugins({ watchdog }), 'subagent-watchdog')
  assert(row !== undefined, 'buildPlugins() 的行表里找不到 subagent-watchdog 行')
  assert(row.config !== null && typeof row.config === 'object', 'subagent-watchdog 行的 config 不是对象')
  return row.config
}

console.log('\n--- S1–S4 lib/index.js：设置清洗（永不抛错，只落默认 / 钳制）---')

test('S1 缺省（undefined / {} / null）⇒ 三项默认值', () => {
  for (const input of [undefined, {}, null]) {
    const actual = normalizeWatchdogSettings(input)
    assert(
      sameValue(actual, DEFAULTS),
      `normalizeWatchdogSettings(${JSON.stringify(input)}) = ${JSON.stringify(actual)}，` +
        `应为默认值 ${JSON.stringify(DEFAULTS)}`,
    )
  }
  // 再逐项钉一遍：将来若 DEFAULTS 被改错，失败文案要指得出是哪一项。
  const fresh = normalizeWatchdogSettings(undefined)
  assert(fresh.stallTimeoutMs === 300000, `缺省 stallTimeoutMs 应为 300000，实际 ${fresh.stallTimeoutMs}`)
  assert(fresh.tickMs === 30000, `缺省 tickMs 应为 30000，实际 ${fresh.tickMs}`)
  assert(fresh.mode === 'interrupt', `缺省 mode 应为 'interrupt'，实际 ${JSON.stringify(fresh.mode)}`)
})

test('S2 NaN / 负数 / 字符串 ⇒ 落默认（它们表达的是「根本没有这个时长」）', () => {
  const badStalls = [
    ['NaN', NaN],
    ['负数', -1000],
    ['零', 0],
    ['字符串', '300000'],
    ['Infinity', Infinity],
  ]
  for (const [label, value] of badStalls) {
    const actual = normalizeWatchdogSettings({ stallTimeoutMs: value })
    assert(
      actual.stallTimeoutMs === DEFAULTS.stallTimeoutMs,
      `stallTimeoutMs 为 ${label} 时应落默认 ${DEFAULTS.stallTimeoutMs}，实际 ${actual.stallTimeoutMs}`,
    )
  }
  const badTicks = [
    ['NaN', NaN],
    ['负数', -1],
    ['字符串', '30000'],
  ]
  for (const [label, value] of badTicks) {
    const actual = normalizeWatchdogSettings({ tickMs: value })
    assert(
      actual.tickMs === DEFAULTS.tickMs,
      `tickMs 为 ${label} 时应落默认 ${DEFAULTS.tickMs}，实际 ${actual.tickMs}`,
    )
  }
})

test('S3 越界钳制（不丢弃用户的意图）：stallTimeoutMs 5000–3600000 / tickMs 1000–300000', () => {
  const cases = [
    ['stallTimeoutMs', 1, 5000],
    ['stallTimeoutMs', 9e9, 3600000],
    ['tickMs', 1, 1000],
    ['tickMs', 9e9, 300000],
  ]
  for (const [field, input, expected] of cases) {
    const actual = normalizeWatchdogSettings({ [field]: input })[field]
    assert(actual === expected, `${field}=${input} 应钳到 ${expected}，实际 ${actual}`)
    // 另一个字段不该被这次钳制带偏。
    const other = field === 'stallTimeoutMs' ? 'tickMs' : 'stallTimeoutMs'
    const otherActual = normalizeWatchdogSettings({ [field]: input })[other]
    assert(
      otherActual === DEFAULTS[other],
      `只传了 ${field}，${other} 应保持默认 ${DEFAULTS[other]}，实际 ${otherActual}`,
    )
  }
})

test('S4 三态：off / log / interrupt 原样保留，非法值落 interrupt', () => {
  for (const mode of ['off', 'log', 'interrupt']) {
    const actual = normalizeWatchdogSettings({ mode })
    assert(actual.mode === mode, `mode=${JSON.stringify(mode)} 应原样保留，实际 ${JSON.stringify(actual.mode)}`)
    assert(
      actual.stallTimeoutMs === DEFAULTS.stallTimeoutMs && actual.tickMs === DEFAULTS.tickMs,
      `mode=${JSON.stringify(mode)} 不应影响两个时长字段`,
    )
  }
  for (const bad of ['nope', '', 'OFF', 1, null]) {
    const actual = normalizeWatchdogSettings({ mode: bad })
    assert(
      actual.mode === 'interrupt',
      `非法 mode=${JSON.stringify(bad)} 应落 'interrupt'，实际 ${JSON.stringify(actual.mode)}`,
    )
  }
})

console.log('\n--- S5 composition.mjs：三态 → 本行 config 的派生 ---')

test('S5 off ⇒ enabled:false；log ⇒ 只报警不停人；interrupt ⇒ 报警并停人', () => {
  const expectations = [
    ['off', false, false],
    ['log', true, false],
    ['interrupt', true, true],
  ]
  for (const [mode, enabled, interruptOnStall] of expectations) {
    const config = watchdogConfig({ stallTimeoutMs: 60000, tickMs: 5000, mode })
    assert(
      config.enabled === enabled,
      `mode=${JSON.stringify(mode)} 应派生 enabled=${enabled}，实际 ${JSON.stringify(config.enabled)}`,
    )
    assert(
      config.interruptOnStall === interruptOnStall,
      `mode=${JSON.stringify(mode)} 应派生 interruptOnStall=${interruptOnStall}，` +
        `实际 ${JSON.stringify(config.interruptOnStall)}`,
    )
    // 阈值本身要原样透传（派生只决定两个开关，不改数字）。
    assert(
      config.stallTimeoutMs === 60000 && config.tickMs === 5000,
      `mode=${JSON.stringify(mode)} 时阈值应原样透传 60000 / 5000，` +
        `实际 ${config.stallTimeoutMs} / ${config.tickMs}`,
    )
    assert(
      config.presetId === 'multitask',
      `mode=${JSON.stringify(mode)} 时 presetId 应为 'multitask'，实际 ${JSON.stringify(config.presetId)}`,
    )
  }
})

test('S5b 默认值与模块常量一致：无参 buildPlugins() 与 normalizeWatchdogSettings(undefined) 同值', () => {
  // 两份常量（lib 的 WATCHDOG_DEFAULTS 与 composition 的 DEFAULT_WATCHDOG）若漂移，
  // 「没配过」与「配成默认值」就是两种行为 —— 这正是最难被发现的设置类回归。
  const defaults = normalizeWatchdogSettings(undefined)
  const config = watchdogConfig(undefined)
  assert(
    config.stallTimeoutMs === defaults.stallTimeoutMs,
    `无参 buildPlugins() 的 stallTimeoutMs=${config.stallTimeoutMs}，` +
      `与 normalizeWatchdogSettings(undefined) 的 ${defaults.stallTimeoutMs} 不一致`,
  )
  assert(
    config.tickMs === defaults.tickMs,
    `无参 buildPlugins() 的 tickMs=${config.tickMs}，` +
      `与 normalizeWatchdogSettings(undefined) 的 ${defaults.tickMs} 不一致`,
  )
  assert(
    config.interruptOnStall === (defaults.mode === 'interrupt'),
    `默认 mode=${JSON.stringify(defaults.mode)} 应派生 interruptOnStall=${defaults.mode === 'interrupt'}，` +
      `实际 ${JSON.stringify(config.interruptOnStall)}`,
  )
  assert(
    config.enabled === (defaults.mode !== 'off'),
    `默认 mode=${JSON.stringify(defaults.mode)} 应派生 enabled=${defaults.mode !== 'off'}，` +
      `实际 ${JSON.stringify(config.enabled)}`,
  )
  // 面板不传 watchdog 时，composition 也必须给出「今天这组值」—— 与加入设置面之前逐字等价。
  assert(
    defaults.stallTimeoutMs === 300000 && defaults.tickMs === 30000 && defaults.mode === 'interrupt',
    `默认值漂移：期望 300000 / 30000 / interrupt，实际 ${JSON.stringify(defaults)}`,
  )
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 汇总 ---')
const passed = results.filter((entry) => entry.ok).length
const failed = results.length - passed
console.log(`  用例组总数: ${results.length}`)
console.log(`  断言总数: ${assertionCount}`)
console.log(`  PASS: ${passed}`)
console.log(`  FAIL: ${failed}`)
console.log(failed === 0 ? '  结论: 全绿' : '  结论: 有红灯，见上面的 FAIL 明细')

if (failed > 0) process.exitCode = 1
