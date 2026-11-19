/**
 * 压缩预算设置面校验（纯 module / 零依赖 / 不写盘 / 不 spawn）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `compaction` 是本插件的第三个 volatile 设置字段。面板编辑的两项
 * （`headroomTokens` / `maxTokens`）最终由 `composition.mjs` 的
 * `normalizeCompaction()` 写成 `compaction-basic` 那一行的 `config`。这条链路
 * 有三处会静默出错：
 *
 *   1. 缺省预算漂移。两者若不再相等（历史上是 8192 / 65536），摘要就可能比
 *      预留空间还大，压完立刻再次越过阈值 —— 表现是「压缩完马上又压」，重试
 *      耗尽后直接报错。本脚本把「两项相等」钉成不变量。
 *   2. 触发点算错。上游公式是
 *      `threshold = floor(min(W × 0.8, W − O − H))`（`maxTokens` **不参与**），
 *      O 是请求的输出预留、H 是 headroom。O 不是常数 —— 这里把它参数化：既对
 *      三档窗口 × O=32768 断言压力预算为正、触发点不早于 0.65 × W，也覆盖
 *      「O 接近窗口」（1M × 256000：约 75%）与「O 吃掉整个窗口」（256k × 256000：
 *      W−O−H < 0，上游必抛）两个端点。后一组是**已知不安全组合**，不是产品缺陷；
 *      这样这组绿灯才不会被读成「任意 O 都安全」。
 *   3. 按模型的预算换算错。全局缺省对大窗口偏保守，所以 `buildPlugins()` 还会把
 *      每个模型的窗口换算成 `modelPolicies`（C6）：换算要单调（窗口越大预算越
 *      大）、去重（上游遇到重复键会在**加载期**抛错，把整条 preset 打成 broken）、
 *      且只写上游认识的四个键。这里同时钉住「没有有效输入时不产生 `modelPolicies`
 *      键」—— 那是无参 `buildPlugins()` 逐字等价的硬约束。
 *   4. **让位**（`yieldNativeCompaction`）把非让位路径的输出改坏了。这是 C7 守的
 *      东西：6 组输入的整份行表与「改代码之前」的 golden 逐字节相同（只有三处由
 *      运行环境决定的位被归一化，见 C7a），而让位路径**只**多出 `auto: false` /
 *      `disabled: true`、**只**少掉 `modelPolicies` —— `tool-result-pruner` 一个字
 *      都不许动（它不发起模型调用，billion-context 不拦它；让位后这一行是**挂着但
 *      不可达** —— `auto: false` 之后 `compaction-basic` 的自动压缩 listener 一个都
 *      不注册，而那是 `pruneSession` 唯一的调用者，所以它原样保留、只是不再被驱动）。
 *
 * ── 为什么用 `buildPlugins()` 验证，而不是 import `normalizeCompaction` ──────
 *
 * `normalizeCompaction()` 是 composition 的**私有**函数（未导出）。
 * `buildPlugins()` 才是公开入口：`readCompaction()` 的产物正是从这里进到
 * `compaction-basic` 行的 `config`。所以下面直接驱动公开入口、读那一行的
 * `config` —— 断言的正是「宿主半传什么、运行时拿到什么」。
 *
 * ── 它不碰任何东西 ───────────────────────────────────────────────────────────
 *
 * 只 `import` 两个模块（composition，以及为 C7a 的 golden 指纹用的 Node 内置
 * `node:crypto`），不加载 DSH、不起会话、不写文件、不 spawn。宿主半
 * （`lib/index.js`）只在 C7f–C7h 里用**动态** import 取 `apply`，并用假 ctx 驱动它
 * （宿主半的 `inject = []` 纪律：除 `agentPresets` 注册表外没有必需服务），
 * 因此**不需要**任何宿主 registry；导入失败就记「未覆盖」，绝不拖垮 C1–C6。
 *
 * @module dsh-multitask/test/compaction-settings
 */
import { createHash } from 'node:crypto'
import { COMPACTION_DEFAULTS, buildPlugins } from '../../presets/multitask/composition.mjs'

/** 缺省预算 —— 与 `composition.mjs` 的 `COMPACTION_DEFAULTS` 必须是同一组数字。 */
const DEFAULTS = Object.freeze({ headroomTokens: 8192, maxTokens: 8192 })

/** 本插件缺省的 headroom（H）—— 与 `COMPACTION_DEFAULTS.headroomTokens` 一致。 */
const HEADROOM = 8192

/** 三档窗口：128k / 256k / 1M。 */
const WINDOWS = [128000, 262144, 1048576]

/** 缺省输出预留（O）：三档窗口那组沿用历史用例的 32768。 */
const DEFAULT_OUTPUT_RESERVE = 32768

/** 上游缺省的 `thresholdRatio`：触发点按窗口比例封顶。 */
const THRESHOLD_RATIO = 0.8

/**
 * 已知不安全组合 —— **不是产品缺陷**。
 *
 * O=256000 已接近窗口 262144 本身，W−O 只剩 6144；在本插件缺省 H=8192 下
 * W−O−H = −2048，压缩预算必然为负，摘要根本无从谈起。要绕开只能把 O 调小
 * （把 H 压到 6144 以下虽然能让预算转正，但触发点会早到失去意义，不是可用配置）。
 * 这是「模型输出预留接近窗口大小」时的固有限制，成立条件已写进
 * `docs/DESIGN.md` / `docs/DESIGN_zh.md` 的压缩那一格。列在这里是为了让用例
 * **明确断言它失败**，而不是让绿灯暗示「任意 O 都安全」。
 */
const KNOWN_UNSAFE = Object.freeze([{ window: 262144, outputReserve: 256000 }])

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
 * 取 `compaction-basic` 那一行的 `config`（按 `buildPlugins()` 的完整选项传参）。
 *
 * C6 要同时看全局 `compaction` 与按模型的 `modelPolicies`，所以不能只接压缩入参。
 *
 * @param options - 传给 `buildPlugins()` 的选项。
 * @returns 那一行的 `config`。
 */
function compactionConfigOf(options) {
  const row = findRow(buildPlugins(options), 'compaction-basic')
  assert(row !== undefined, 'buildPlugins() 的行表里找不到 compaction-basic 行')
  assert(row.config !== null && typeof row.config === 'object', 'compaction-basic 行的 config 不是对象')
  return row.config
}

/**
 * 取 `compaction-basic` 那一行（它才是设置最终的落点）。
 *
 * @param compaction - 传给 `buildPlugins()` 的压缩入参。
 * @returns 那一行的 `config`。
 */
function compactionConfig(compaction) {
  return compactionConfigOf({ compaction })
}

/**
 * C6 的四档窗口（二进制单位）与**期望的摘要预算**。
 *
 * 期望值按 `composition.mjs` 的换算规则手算：`round(W / 16)` 再夹在 [4096, 65536]，
 * 于是 1M → 65536、256k → 16384、128k → 8192、64k → 4096。这四档同时覆盖了两端
 * 的夹子（1M 撞上限、64k 撞下限）。
 *
 * `defaultMaxTokens` 统一取 `DEFAULT_OUTPUT_RESERVE`（32768）：四档的 `W − O` 都远
 * 大于 `max(16384, 0.1W)`，所以不该有任何一档被「输出预留吃掉窗口」的判据跳过。
 */
const POLICY_CASES = Object.freeze([
  { contextWindow: 65536, budget: 4096 },
  { contextWindow: 131072, budget: 8192 },
  { contextWindow: 262144, budget: 16384 },
  { contextWindow: 1048576, budget: 65536 },
])

/**
 * 造一条 C6 的入参（模型名里带窗口，方便从产物反查是哪一档）。
 *
 * @param contextWindow - 模型窗口。
 * @param extra - 要覆盖 / 追加的字段。
 * @returns `{ provider, model, contextWindow, defaultMaxTokens }`。
 */
function policyEntry(contextWindow, extra) {
  return {
    provider: 'deepseek',
    model: `model-${contextWindow}`,
    contextWindow,
    defaultMaxTokens: DEFAULT_OUTPUT_RESERVE,
    ...extra,
  }
}

/**
 * 从 `compaction-basic` 的 `config` 里取 `modelPolicies`，并断言它确实是个数组。
 *
 * @param config - 那一行的 `config`。
 * @returns 策略数组。
 */
function policiesOf(config) {
  const policies = config.modelPolicies
  assert(Array.isArray(policies), `config.modelPolicies 应是数组，实际 ${JSON.stringify(policies)}`)
  return policies
}

/**
 * 复刻上游 `compaction-basic` 的触发点公式（实测行号见 `composition.mjs` 的注释）：
 *
 *     messageBudget  = W − O
 *     pressureBudget = W − O − H
 *     pressureBudget <= 0  ⇒  上游抛 `TargetPressureConfigError`（没有 threshold）
 *     threshold      = floor(min(W × 0.8, pressureBudget))
 *
 * @param window - 模型的上下文窗口 W。
 * @param outputReserve - 请求的输出预留 O。
 * @param headroom - 压缩预留 H。
 * @returns 这一组的全部中间量与结论。
 */
function trigger(window, outputReserve, headroom = HEADROOM) {
  const messageBudget = window - outputReserve
  const pressureBudget = messageBudget - headroom
  const ratioCap = window * THRESHOLD_RATIO
  const safe = pressureBudget > 0
  const threshold = safe ? Math.floor(Math.min(ratioCap, pressureBudget)) : undefined
  return {
    window,
    outputReserve,
    headroom,
    messageBudget,
    pressureBudget,
    ratioCap,
    safe,
    threshold,
    percent: threshold === undefined ? '—' : `${((threshold / window) * 100).toFixed(1)}%`,
  }
}

/**
 * 把一组用例的 W / O / H / W−O−H / 0.8W / threshold / 百分比逐行打印出来。
 *
 * @param rows - `trigger()` 的产物。
 */
function printTriggers(rows) {
  for (const row of rows) {
    console.log(
      `        W=${row.window}  O=${row.outputReserve}  H=${row.headroom}  ` +
        `W−O−H=${row.pressureBudget}  0.8W=${row.ratioCap}  ` +
        `threshold=${row.threshold === undefined ? '—' : row.threshold}  (${row.percent})` +
        (row.safe ? '' : '  ← 上游抛 TargetPressureConfigError'),
    )
  }
}

console.log('\n--- C1–C4 composition.mjs：缺省预算与覆盖规则 ---')

test('C1 缺省（undefined / {} / null）⇒ headroom 与 maxTokens 都是 8192', () => {
  for (const input of [undefined, {}, null]) {
    const actual = compactionConfig(input)
    assert(
      sameValue(actual, DEFAULTS),
      `buildPlugins({ compaction: ${JSON.stringify(input)} }) 的 config = ${JSON.stringify(actual)}，` +
        `应为 ${JSON.stringify(DEFAULTS)}`,
    )
  }
})

test('C2 只给 headroomTokens ⇒ maxTokens 跟随为同一个值', () => {
  const actual = compactionConfig({ headroomTokens: 16384 })
  assert(
    actual.maxTokens === 16384,
    `只给 headroomTokens=16384 时 maxTokens 应跟随为 16384，实际 ${JSON.stringify(actual.maxTokens)}`,
  )
  assert(
    actual.headroomTokens === 16384,
    `headroomTokens 应原样保留 16384，实际 ${JSON.stringify(actual.headroomTokens)}`,
  )
})

test('C3 只给 maxTokens ⇒ headroom 保持默认 8192，maxTokens 用用户值', () => {
  const actual = compactionConfig({ maxTokens: 12000 })
  assert(
    actual.headroomTokens === 8192,
    `只给 maxTokens=12000 时 headroomTokens 应保持默认 8192，实际 ${JSON.stringify(actual.headroomTokens)}`,
  )
  assert(
    actual.maxTokens === 12000,
    `maxTokens 应原样保留 12000，实际 ${JSON.stringify(actual.maxTokens)}`,
  )
})

test('C4 缺省不变量：maxTokens <= headroomTokens（摘要永远装得进预留空间）', () => {
  const actual = compactionConfig(undefined)
  assert(
    actual.maxTokens <= actual.headroomTokens,
    `缺省 maxTokens=${actual.maxTokens} 不应大于 headroomTokens=${actual.headroomTokens}`,
  )
  // 再逐项钉一遍：将来若 COMPACTION_DEFAULTS 被改错，失败文案要指得出是哪一项。
  assert(
    actual.headroomTokens === 8192 && actual.maxTokens === 8192,
    `缺省应为 8192 / 8192，实际 ${actual.headroomTokens} / ${actual.maxTokens}`,
  )
  assert(
    sameValue(actual, COMPACTION_DEFAULTS),
    `compaction-basic 行的 config 与 COMPACTION_DEFAULTS 不一致：` +
      `${JSON.stringify(actual)} vs ${JSON.stringify(COMPACTION_DEFAULTS)}`,
  )
})

console.log('\n--- C5 上游触发公式：输出预留 O 不是常数（三档窗口 / 1M × 256k / 256k × 256k）---')

test('C5a 三档窗口 × O=32768：压力预算 > 0 且 threshold >= 0.65 × W', () => {
  const rows = WINDOWS.map((window) => trigger(window, DEFAULT_OUTPUT_RESERVE))
  printTriggers(rows)
  for (const row of rows) {
    assert(
      row.safe,
      `W=${row.window}、O=${row.outputReserve}：W − O − H = ${row.pressureBudget} 应为正，` +
        '否则上游抛 TargetPressureConfigError',
    )
    assert(
      row.threshold >= 0.65 * row.window,
      `W=${row.window}、O=${row.outputReserve}：threshold=${row.threshold} 早于 0.65 × W=${0.65 * row.window}`,
    )
  }
})

test('C5b W=1048576 × O=256000（DeepSeek 适配器默认输出预留）：threshold >= 0.70 × W', () => {
  // 这一档的预算项比 0.8 × W 更紧，所以触发点不会封顶在 80%，而是落在约 74.8%。
  const rows = [trigger(1048576, 256000)]
  printTriggers(rows)
  const row = rows[0]
  assert(row.safe, `W=1048576、O=256000：压力预算 ${row.pressureBudget} 应为正`)
  assert(
    row.threshold === 784384,
    `W=1048576、O=256000、H=8192：threshold 应为 1048576 − 256000 − 8192 = 784384，实际 ${row.threshold}`,
  )
  assert(
    row.threshold >= 0.70 * row.window,
    `threshold=${row.threshold}（${row.percent}）低于 0.70 × W=${0.70 * row.window}`,
  )
  assert(
    row.threshold < row.ratioCap,
    `threshold=${row.threshold} 不应达到 0.8 × W=${row.ratioCap}：O=256000 已让预算项成为更紧的那一侧`,
  )
})

test('C5c W=262144 × O=256000：已知不安全组合，W−O−H < 0（上游必抛，不是产品缺陷）', () => {
  const rows = []
  for (const combo of KNOWN_UNSAFE) {
    const row = trigger(combo.window, combo.outputReserve)
    rows.push(row)
    // 「已知不安全」在这里被明确断言：预算为负、算不出 threshold。这不是本插件的
    // 产品缺陷，而是模型输出预留接近窗口大小时上游公式的固有限制（条件见文档）。
    assert(
      !row.safe,
      `W=${row.window}、O=${row.outputReserve}：该组合应被判为已知不安全（预算 ${row.pressureBudget}）`,
    )
    assert(
      row.pressureBudget < 0,
      `W=${row.window}、O=${row.outputReserve}、H=${row.headroom}：W − O − H 应为负数，实际 ${row.pressureBudget}`,
    )
    assert(
      row.threshold === undefined,
      `预算为负时不应算出 threshold（实际 ${row.threshold}）——上游会抛 TargetPressureConfigError`,
    )
  }
  printTriggers(rows)
})

console.log('\n--- C6 按模型推导压缩预算（composition.mjs 的 modelPolicies）---')

test('C6a 1M / 256k / 128k / 64k 窗口（O=32768）⇒ 65536 / 16384 / 8192 / 4096', () => {
  const input = POLICY_CASES.map(({ contextWindow }) => policyEntry(contextWindow))
  const policies = policiesOf(compactionConfigOf({ modelPolicies: input }))
  assert(
    policies.length === POLICY_CASES.length,
    `应有 ${POLICY_CASES.length} 条策略，实际 ${policies.length}：${JSON.stringify(policies)}`,
  )
  const byModel = new Map(policies.map((policy) => [policy.model, policy]))
  for (const { contextWindow, budget } of POLICY_CASES) {
    const policy = byModel.get(`model-${contextWindow}`)
    assert(policy !== undefined, `窗口 ${contextWindow} 没有对应的策略`)
    assert(
      policy.headroomTokens === budget,
      `W=${contextWindow}：headroomTokens 应为 round(W/16) 夹在 [4096, 65536] = ${budget}，` +
        `实际 ${policy.headroomTokens}`,
    )
    assert(
      policy.maxTokens === budget,
      `W=${contextWindow}：maxTokens 应等于 headroomTokens = ${budget}，实际 ${policy.maxTokens}`,
    )
  }
  console.log(
    '        ' + policies.map((policy) => `${policy.model} → ${policy.headroomTokens}`).join('  '),
  )
})

test('C6b 每条策略的 headroomTokens === maxTokens（摘要永远装得进预留空间）', () => {
  const policies = policiesOf(
    compactionConfigOf({ modelPolicies: POLICY_CASES.map(({ contextWindow }) => policyEntry(contextWindow)) }),
  )
  assert(policies.length > 0, '一组合法输入不应产出空策略')
  for (const policy of policies) {
    assert(
      policy.headroomTokens === policy.maxTokens,
      `${policy.provider}/${policy.model}：headroomTokens=${policy.headroomTokens} 与 ` +
        `maxTokens=${policy.maxTokens} 不相等 —— 摘要可能大过预留空间，压完立刻再压`,
    )
  }
})

test('C6c 每条策略只有 provider / model / headroomTokens / maxTokens —— 不带 contextWindow', () => {
  const policies = policiesOf(
    compactionConfigOf({ modelPolicies: POLICY_CASES.map(({ contextWindow }) => policyEntry(contextWindow)) }),
  )
  for (const policy of policies) {
    const keys = Object.keys(policy).sort()
    assert(
      sameValue(keys, ['headroomTokens', 'maxTokens', 'model', 'provider']),
      `${policy.provider}/${policy.model}：策略键应为 provider / model / headroomTokens / maxTokens，` +
        `实际 ${JSON.stringify(keys)} —— 上游 policy 出现未知键会在加载期失败`,
    )
    assert(
      !('contextWindow' in policy),
      `${policy.provider}/${policy.model}：策略里不该带 contextWindow（那是本地输入，不是上游字段）`,
    )
  }
})

test('C6d 重复 provider/model 只保留一条（保留第一次出现的换算结果）', () => {
  const input = [
    policyEntry(1048576, { model: 'dup' }),
    policyEntry(65536, { model: 'dup' }),
    policyEntry(131072, { model: 'dup', provider: 'other' }),
  ]
  const policies = policiesOf(compactionConfigOf({ modelPolicies: input }))
  assert(policies.length === 2, `重复键应被去重成 2 条（deepseek / other 各一条），实际 ${policies.length}：${JSON.stringify(policies)}`)
  const deepseek = policies.find((policy) => policy.provider === 'deepseek')
  const other = policies.find((policy) => policy.provider === 'other')
  assert(deepseek !== undefined, '缺少 deepseek/dup 的策略')
  assert(other !== undefined, '缺少 other/dup 的策略 —— 不同 provider 的同名 model 不是重复键')
  assert(
    deepseek.headroomTokens === 65536,
    `重复键应保留第一条（1M → 65536），实际 ${deepseek.headroomTokens}`,
  )
  assert(
    other.headroomTokens === 8192,
    `other/dup 应按自己的窗口 131072 换算成 8192，实际 ${other.headroomTokens}`,
  )
})

test('C6e 非法条目被静默丢弃且不抛错（空 model / 负数窗口 / 非整数 / 非对象）', () => {
  const input = [
    policyEntry(262144, { model: '' }),
    policyEntry(262144, { model: '   ' }),
    policyEntry(262144, { provider: '' }),
    policyEntry(262144, { provider: 42 }),
    policyEntry(-262144, { model: 'negative-window' }),
    policyEntry(131072.5, { model: 'fractional-window' }),
    policyEntry('262144', { model: 'string-window' }),
    policyEntry(262144, { model: 42 }),
    null,
    'not-an-object',
    [],
    undefined,
    policyEntry(262144, { model: 'valid' }),
  ]
  let config
  try {
    config = compactionConfigOf({ modelPolicies: input })
  } catch (error) {
    throw new Error(`非法输入不应让 buildPlugins() 抛错，实际抛了：${error.message}`)
  }
  const policies = policiesOf(config)
  assert(
    policies.length === 1,
    `非法条目应全部丢弃、只剩 1 条（model-262144 的 valid），实际 ${policies.length}：${JSON.stringify(policies)}`,
  )
  assert(
    policies[0].model === 'valid',
    `留下的应是那条合法条目（model=valid），实际 ${JSON.stringify(policies[0])}`,
  )
})

test('C6f 输出预留吃掉窗口（W=262144、O=256000）⇒ 不生成策略，且不出现 modelPolicies 键', () => {
  const config = compactionConfigOf({
    modelPolicies: [policyEntry(262144, { model: 'greedy', defaultMaxTokens: 256000 })],
  })
  assert(
    !('modelPolicies' in config),
    `该窗口 W−O=6144 < max(16384, 0.1W)，不应生成策略，实际 config=${JSON.stringify(config)}`,
  )
  assert(
    sameValue(config, DEFAULTS),
    `没有策略时 config 应仍是全局缺省 ${JSON.stringify(DEFAULTS)}，实际 ${JSON.stringify(config)}`,
  )
})

test('C6g 不传 modelPolicies（undefined / null / [] / 非数组）⇒ config 与改动前逐字相同', () => {
  for (const options of [
    undefined,
    {},
    { modelPolicies: undefined },
    { modelPolicies: null },
    { modelPolicies: [] },
    { modelPolicies: 'not-an-array' },
  ]) {
    const config = compactionConfigOf(options)
    assert(
      !('modelPolicies' in config),
      `options=${JSON.stringify(options)}：不应出现 modelPolicies 键，实际 ${JSON.stringify(config)}`,
    )
    assert(
      sameValue(config, DEFAULTS),
      `options=${JSON.stringify(options)}：config 应逐字等于 ${JSON.stringify(DEFAULTS)}，` +
        `实际 ${JSON.stringify(config)}`,
    )
  }
})

test('C6h 先按 provider 再按 model 排序，最多 256 条（超出截断，与输入顺序无关）', () => {
  const shuffled = [
    policyEntry(262144, { provider: 'beta', model: 'a' }),
    policyEntry(262144, { provider: 'alpha', model: 'b' }),
    policyEntry(262144, { provider: 'alpha', model: 'a' }),
  ]
  const sorted = policiesOf(compactionConfigOf({ modelPolicies: shuffled }))
  const labels = sorted.map((policy) => `${policy.provider}/${policy.model}`)
  assert(
    sameValue(labels, ['alpha/a', 'alpha/b', 'beta/a']),
    `策略应按 provider → model 升序，实际 ${JSON.stringify(labels)}`,
  )

  // 300 条不同模型：截断到 256 条，且截断发生在排序之后（留下的是码元序最小的 256 个）。
  const many = Array.from({ length: 300 }, (_, index) =>
    policyEntry(262144, { model: `m-${String(index).padStart(3, '0')}` }),
  )
  const capped = policiesOf(compactionConfigOf({ modelPolicies: many }))
  assert(capped.length === 256, `最多接受 256 条策略，实际 ${capped.length} 条`)
  assert(
    capped[0].model === 'm-000' && capped[capped.length - 1].model === 'm-255',
    `截断应发生在排序之后（保留码元序最小的 256 条），实际首尾 ${capped[0].model} / ${capped[capped.length - 1].model}`,
  )
})

test('C6i 用户手填的全局预算不受策略影响（手动值仍走全局，策略只补按模型的部分）', () => {
  const config = compactionConfigOf({
    compaction: { headroomTokens: 16384 },
    modelPolicies: [policyEntry(1048576)],
  })
  assert(
    config.headroomTokens === 16384 && config.maxTokens === 16384,
    `用户手填的 headroomTokens=16384 应原样生效，实际 ${config.headroomTokens} / ${config.maxTokens}`,
  )
  const policies = policiesOf(config)
  assert(policies.length === 1, `策略仍应生成 1 条，实际 ${policies.length}`)
  assert(
    policies[0].headroomTokens === 65536,
    `1M 模型的策略应是 65536，不受全局手填值影响，实际 ${policies[0].headroomTokens}`,
  )
})

console.log('\n--- C7 让位给 billion-context（yieldNativeCompaction）---')

/**
 * 三处**由运行环境决定**的行内容 —— C7a 的 golden 必须把它们归一化掉，否则换一台
 * 机器（不同平台 / 没装可选包 / 环境变量不同）就会红，而红的原因与本次改动无关：
 *
 *   ① `tool-bash` / `tool-pwsh` 的 `disabled`：由 `process.platform` 决定；
 *   ② `tool-subagent-list-agents` 行的**存在与否**：由宿主探测决定
 *      （`LIST_AGENTS_SUBPATH`）；
 *   ③ `tool-subagent-ptc` / `tool-subagent-minimal` 两行与 `coordinator-guard.keep`
 *      里的两个工具名：由 `DSH_MULTITASK_MULTI_MODE` 决定。
 *
 * 归一化只抹掉**取值**、不抹结构：C7a 仍然逐字节比较其余全部内容，并且下面还会
 * 单独断言归一化掉的这几处与当前环境一致（C7a 的第 2–4 条断言）。
 */
const ENVIRONMENT_OPTIONAL_ROWS = new Set([
  'tool-subagent-list-agents',
  'tool-subagent-ptc',
  'tool-subagent-minimal',
])
const PLATFORM_DISABLED_ROWS = new Set(['tool-bash', 'tool-pwsh'])
const MULTI_MODE_TOOLS = ['subagent_ptc', 'subagent_minimal']

/**
 * 把行表复制一份并抹掉三处环境决定的取值（判据见上面那段注释）。
 *
 * ⚠️ 这段必须与抓 golden 时的脚本**逐字相同**；改这里等于改 golden 的定义，
 * 要重新抓一遍 golden 才能看出「到底变了什么」。
 *
 * @param rows - `buildPlugins()` 产出的行表。
 * @returns 归一化后的深拷贝。
 */
function normalizeEnvironment(rows) {
  const copy = JSON.parse(JSON.stringify(rows))
  const walk = (list) => {
    const kept = []
    for (const row of list) {
      if (row === null || typeof row !== 'object') {
        kept.push(row)
        continue
      }
      if (ENVIRONMENT_OPTIONAL_ROWS.has(row.id)) continue
      if (PLATFORM_DISABLED_ROWS.has(row.id) && 'disabled' in row) row.disabled = '<platform>'
      if (Array.isArray(row.config)) walk(row.config)
      if (row.id === 'coordinator-guard' && Array.isArray(row.config?.keep)) {
        row.config.keep = row.config.keep.filter((name) => !MULTI_MODE_TOOLS.includes(name))
      }
      kept.push(row)
    }
    list.length = 0
    list.push(...kept)
  }
  walk(copy)
  return copy
}

/**
 * @param rows - `buildPlugins()` 产出的行表。
 * @returns 归一化后整份快照的 sha256。
 */
function snapshotDigest(rows) {
  return createHash('sha256').update(JSON.stringify(normalizeEnvironment(rows)), 'utf8').digest('hex')
}

/**
 * C7a 的 golden —— 在**改动代码之前**用同一份 normalizer 对 6 组输入算出的 sha256。
 *
 * 六组输入覆盖：空参、只给全局预算、只给按模型的策略、两者都给、模型映射 + 看门狗、
 * 非法预算（`headroomTokens: 0` 被丢弃 ⇒ 与空参同值）。任何一组变了都说明「不传
 * `yieldNativeCompaction` 时的输出」被动过 —— 那正是本组最不能破的约束。
 */
const GOLDEN_OUTPUT = Object.freeze([
  {
    name: '{}',
    input: {},
    sha256: '4e67da94099f498aee00a260ece87437a527d74b2e52b72ad373810c5e60e136',
  },
  {
    name: '{ compaction: { headroomTokens: 16384 } }',
    input: { compaction: { headroomTokens: 16384 } },
    sha256: '9c49de39c7993e73423751f55fe9ed3e4c3e930c3be9e513a91f1b47412c7657',
  },
  {
    name: "{ modelPolicies: [{ provider: 'p', model: 'm', contextWindow: 1048576 }] }",
    input: { modelPolicies: [{ provider: 'p', model: 'm', contextWindow: 1048576 }] },
    sha256: '70c99d69feed36be4a86914b2f9e228368d806492c55f47a9ed8b0b36c836116',
  },
  {
    name: "{ compaction: { retainTokens: 5 }, modelPolicies: [{ provider: 'p', model: 'm', contextWindow: 131072 }] }",
    input: {
      compaction: { retainTokens: 5 },
      modelPolicies: [{ provider: 'p', model: 'm', contextWindow: 131072 }],
    },
    sha256: '5e2d12260aa1d4fbd7630190001c80a7ae1c5fd0129af04d042a142b3d5a53b9',
  },
  {
    name: '{ modelMap: {…4 类}, watchdog: { stallTimeoutMs: 120000, tickMs: 5000, mode: \'log\' } }',
    input: {
      modelMap: {
        subagent: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
        subagent_fork: { provider: 'deepseek', model: 'deepseek-reasoner' },
        subagent_ptc: { provider: 'p2', model: 'm2' },
        subagent_minimal: { provider: 'p3', model: 'm3' },
      },
      watchdog: { stallTimeoutMs: 120000, tickMs: 5000, mode: 'log' },
    },
    sha256: '1be53b5854db3b6175fe2e3e953f818342b9216f32e74c0993307fe34a8a80e7',
  },
  {
    name: '{ compaction: { headroomTokens: 0 } }（非法值，应被丢弃）',
    input: { compaction: { headroomTokens: 0 } },
    sha256: '4e67da94099f498aee00a260ece87437a527d74b2e52b72ad373810c5e60e136',
  },
])

/**
 * 取压缩组的行表（组本身也是一个 `cordis:group`，`findRow` 能按 id 找到它）。
 *
 * @param options - 传给 `buildPlugins()` 的选项。
 * @returns 压缩组的行数组。
 */
function compactionGroupOf(options) {
  const group = findRow(buildPlugins(options), 'compaction')
  assert(group !== undefined, 'buildPlugins() 的行表里找不到 compaction 组')
  assert(Array.isArray(group.config), 'compaction 组的 config 不是行数组')
  return group.config
}

test('C7a 不传 yieldNativeCompaction ⇒ 6 组输入与改前 golden 逐字节相同（仅归一化 3 处环境位）', () => {
  for (const { name, input, sha256 } of GOLDEN_OUTPUT) {
    const actual = snapshotDigest(buildPlugins(input))
    assert(
      actual === sha256,
      `${name}：整份行表的指纹 ${actual} 与改前 golden ${sha256} 不同 —— ` +
        '「不传 yieldNativeCompaction」的输出必须与本次改动之前逐字节相同',
    )
  }
  // 归一化掉的位必须与当前环境一致，否则上面的绿灯就掩盖了真实差异。
  const rows = buildPlugins({})
  const ids = []
  const disabled = new Map()
  const walk = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue
      ids.push(row.id)
      if ('disabled' in row) disabled.set(row.id, row.disabled)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  assert(
    disabled.get('tool-bash') === (process.platform === 'win32'),
    `tool-bash.disabled 应为 ${process.platform === 'win32'}（当前平台 ${process.platform}），实际 ${disabled.get('tool-bash')}`,
  )
  assert(
    disabled.get('tool-pwsh') === (process.platform !== 'win32'),
    `tool-pwsh.disabled 应为 ${process.platform !== 'win32'}（当前平台 ${process.platform}），实际 ${disabled.get('tool-pwsh')}`,
  )
  assert(
    ids.includes('tool-subagent-ptc') === ids.includes('tool-subagent-minimal'),
    '多模式那两行必须同时出现或同时缺席（同一开关控制）',
  )
  // 无参调用与显式 false 必须等价 —— 这一条不依赖任何环境。
  assert(
    sameValue(buildPlugins({}), buildPlugins({ yieldNativeCompaction: false })),
    'buildPlugins({}) 与 buildPlugins({ yieldNativeCompaction: false }) 不等价',
  )
})

test('C7b 让位 ⇒ compaction-basic.config.auto === false，且原有预算键一个不删', () => {
  const config = compactionConfigOf({ yieldNativeCompaction: true })
  assert(
    config.auto === false,
    `让位时 compaction-basic.config.auto 应为 false，实际 ${JSON.stringify(config.auto)}`,
  )
  // 预算键也是 `compaction.config` 里的原有内容：让位只**关自动压缩**，不删配置 ——
  // bili 中途消失时下一份声明仍是一份健全的预算。
  assert(
    config.headroomTokens === DEFAULTS.headroomTokens && config.maxTokens === DEFAULTS.maxTokens,
    `让位时缺省预算应保持 ${JSON.stringify(DEFAULTS)}，实际 ` +
      `${config.headroomTokens} / ${config.maxTokens}`,
  )
  const withUserBudget = compactionConfigOf({
    compaction: { headroomTokens: 16384, retainTokens: 7 },
    yieldNativeCompaction: true,
  })
  assert(
    withUserBudget.headroomTokens === 16384 &&
      withUserBudget.maxTokens === 16384 &&
      withUserBudget.retainTokens === 7,
    `让位时用户手填的预算应原样保留，实际 ${JSON.stringify(withUserBudget)}`,
  )
})

test('C7c 让位 ⇒ compaction-basic.config 不含 modelPolicies（即便传了合法策略）', () => {
  const withoutInput = compactionConfigOf({ yieldNativeCompaction: true })
  assert(
    !('modelPolicies' in withoutInput),
    `让位时不应出现 modelPolicies 键，实际 ${JSON.stringify(withoutInput)}`,
  )
  const withInput = compactionConfigOf({
    yieldNativeCompaction: true,
    modelPolicies: [policyEntry(1048576), policyEntry(262144)],
  })
  assert(
    !('modelPolicies' in withInput),
    `让位时即便传了合法 modelPolicies 也不应写进 config，实际 ${JSON.stringify(withInput)}`,
  )
  // 键集逐条钉住：只有预算键 + auto，多一个都是回归。
  assert(
    sameValue(Object.keys(withInput).sort(), ['auto', 'headroomTokens', 'maxTokens']),
    `让位时 compaction-basic.config 的键应只有 auto / headroomTokens / maxTokens，` +
      `实际 ${JSON.stringify(Object.keys(withInput).sort())}`,
  )
})

test('C7d 让位 ⇒ command-compact.disabled === true；tool-result-pruner 与 golden 逐字相同', () => {
  const group = compactionGroupOf({ yieldNativeCompaction: true })
  const command = group.find((row) => row.id === 'command-compact')
  assert(command !== undefined, '压缩组里找不到 command-compact 行')
  assert(
    command.disabled === true,
    `让位时 command-compact.disabled 应为 true，实际 ${JSON.stringify(command.disabled)}`,
  )
  const pruner = group.find((row) => row.id === 'tool-result-pruner')
  const pristine = findRow(buildPlugins({}), 'tool-result-pruner')
  assert(pruner !== undefined && pristine !== undefined, '找不到 tool-result-pruner 行')
  assert(
    sameValue(pruner, pristine),
    `tool-result-pruner 一个字都不该变：让位版 ${JSON.stringify(pruner)}，` +
      `原始版 ${JSON.stringify(pristine)}`,
  )
  // 组本身的门（isolate / group / name）也不许动。
  const yieldedGroup = findRow(buildPlugins({ yieldNativeCompaction: true }), 'compaction')
  const pristineGroup = findRow(buildPlugins({}), 'compaction')
  assert(
    yieldedGroup.group === pristineGroup.group &&
      sameValue(yieldedGroup.isolate, pristineGroup.isolate) &&
      yieldedGroup.name === pristineGroup.name,
    '让位不该改变压缩组自身的 group / isolate / name',
  )
})

test('C7e 不让位（false / 缺省 / 非严格 true）⇒ config 没有 auto 键、command-compact 没有 disabled 键', () => {
  for (const options of [
    undefined,
    {},
    { yieldNativeCompaction: false },
    // 严格 `=== true`：这些**都不算**让位。
    { yieldNativeCompaction: 'true' },
    { yieldNativeCompaction: 1 },
    { yieldNativeCompaction: {} },
  ]) {
    const config = compactionConfigOf(options)
    assert(
      !('auto' in config),
      `options=${JSON.stringify(options)}：config 不应出现 auto 键，实际 ${JSON.stringify(config)}`,
    )
    const group = compactionGroupOf(options)
    const command = group.find((row) => row.id === 'command-compact')
    assert(command !== undefined, '压缩组里找不到 command-compact 行')
    assert(
      !('disabled' in command),
      `options=${JSON.stringify(options)}：command-compact 不应出现 disabled 键（不是 false，是没有），` +
        `实际 ${JSON.stringify(command)}`,
    )
  }
})

// ── C7f：让位探测的**行为级**验证（真 `apply()` + 假 ctx）──────────────────────
//
// 探测函数 `nativeCompactionYielded()` 是 `lib/index.js` 的**内部**符号（不导出：
// 该文件的导出面只留 DSH 插件契约，一个瞬态探测谓词不该占位成包的公开 API）。所以
// 这里不测它的返回值，而是驱动真正的 `apply()`、断言它最终**注册出去的声明**。
//
// 四种输入各自对应对声明的一处可观察后果：
//
//   · 闸门在   ⇒ `compaction-basic.config.auto === false`、`command-compact.disabled
//                === true`、`config` 里没有 `modelPolicies`；
//   · 闸门不在 ⇒ 三处都是**缺席**（不是 `false`，是没有键）；
//   · 读取抛错 ⇒ 与「闸门不在」逐字相同（异常一律按不让位处理）；
//   · ctx 太简 ⇒ 与「闸门不在」逐字相同，且插件照常激活。
//
// 假 ctx 只需提供 `agentPresets`（一个带 `register` 的记录器）：本插件的 `inject = []`，
// 其余服务（`llm` / `subagents` / 闸门）缺席都是**允许**的形态，所以不需要任何宿主
// registry。手法同 `test/_probe-model-policies.mjs`（那边已经用它覆盖 apply/inject 路径）。
//
// 动态 import：本文件主体只依赖 composition，宿主半导入失败（缺 worker-providers 之类）
// 不该拖垮 C1–C6 —— 那时把 C7f 记成「未覆盖」，而不是让整个脚本崩掉。
let apply
try {
  ;({ apply } = await import('../../lib/index.js'))
} catch (error) {
  apply = undefined
  console.log(`        （宿主半导入失败，C7f 记未覆盖：${error instanceof Error ? error.message : String(error)}）`)
}

/**
 * billion-context 的**压缩闸门服务名** —— 跨包契约的那一个字面量。
 *
 * 刻意在这里重写一遍而不是从 `lib/index.js` 导入：那是内部常量（未导出），而这个名字
 * 是双方契约本身，测试就该按字面量钉住它（`lib/index.js` 那边改名的表现是「本包永不
 * 让位」，属于必须被测试拦下的变更）。
 */
const GATE_SERVICE = 'biliBasicCompactionPolicy'

/**
 * 造一个够用的假宿主 ctx —— 只实现 `apply()` 真正会碰的那几个面。
 *
 * 刻意**不**提供 `llm` / `subagents`：缺服务时必须照常声明，那正是 `inject = []` 的纪律。
 * `reflect.get` 是 C7f 的主角：真实宿主的 `ctx.reflect.get(name, strict)` 返回服务实例，
 * 这里只按参数记录一次调用、再由 `reflectGet` 决定返回什么（或抛错）。
 *
 * @param options - `reflectGet`（返回值或抛错） / `withoutReflect` / `withoutInject` /
 *   `rejectYield`（注册表拒绝**带让位**的声明 → 驱动 C7h 的回滚 + 重试路径）。
 * @returns `{ ctx, declarations, attempts, injects, handlers, logs, probes }`。
 */
function fakeHostCtx(options = {}) {
  const logs = { info: [], warn: [] }
  /** 注册表**接受**了的声明（按落库顺序，失败的那次不进这里）。 */
  const declarations = []
  /** 每一次 `registry.register()` 调用（含被拒绝的），附「这份声明带不带让位」与时刻。 */
  const attempts = []
  /** 每一次 `ctx.inject(deps, cb)` 的登记 —— C7g / C7h 手动触发回调来模拟迟绑定。 */
  const injects = []
  /** `ctx.on(event, cb)` 的登记 —— C7h 用它模拟「设置面板写值 → loader 发事件」。 */
  const handlers = new Map()
  const probes = []
  const registry = {
    async register(declaration) {
      const yielded = declarationYieldsCompaction(declaration)
      attempts.push({ declaration, yielded, at: Date.now() })
      if (yielded && options.rejectYield === true) {
        throw new Error('fixture: the registry refused a declaration that yields native compaction')
      }
      declarations.push(declaration)
      return async () => {}
    },
  }
  const services = { agentPresets: registry }
  const ctx = {
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
    get: (name) => services[name],
    on: (event, callback) => {
      handlers.set(event, callback)
      return () => {}
    },
    effect: (callback) => {
      callback()
      return () => {}
    },
  }
  // 假 inject 只**登记**、从不自动触发：C7f 钉「apply() 那一刻的状态」，迟绑定那条腿
  // （服务晚出现 → 重声明）由 C7g / C7h 手动调用登记下来的回调来驱动。
  if (!options.withoutInject) {
    ctx.inject = (deps, callback) => {
      injects.push({ deps: Array.from(deps ?? []), callback })
    }
  }
  if (!options.withoutReflect) {
    ctx.reflect = {
      get(name, strict) {
        probes.push({ name, strict })
        return options.reflectGet === undefined ? undefined : options.reflectGet()
      },
    }
  }
  return { ctx, declarations, attempts, injects, handlers, logs, probes }
}

/**
 * 等 `apply()` 把声明交上来 —— `declare()` 是异步的（先 `await registry.register()`）。
 *
 * @param scene - `fakeHostCtx()` 的返回值。
 * @param expected - 期望的声明份数（本组一律 1）。
 * @returns 实际拿到的份数。
 */
async function waitForDeclarations(scene, expected = 1, budgetMs = 3000) {
  const started = Date.now()
  while (scene.declarations.length < expected && Date.now() - started < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return scene.declarations.length
}

/**
 * 取一份**声明**里压缩组（`compaction`）的行数组；组本身也是一个 `cordis:group`。
 *
 * @param declaration - 注册表收到的声明对象。
 * @returns 压缩组的行数组。
 */
function compactionGroupOfDeclaration(declaration) {
  assert(declaration !== null && typeof declaration === 'object', '声明不是对象')
  assert(Array.isArray(declaration.plugins), '声明的 plugins 不是行表')
  const group = findRow(declaration.plugins, 'compaction')
  assert(group !== undefined, '声明里找不到 compaction 组')
  assert(Array.isArray(group.config), 'compaction 组的 config 不是行数组')
  return group.config
}

/**
 * 一份**声明**里有没有带让位 —— 只看 `compaction-basic.config.auto === false`。
 *
 * 为什么不用 `command-compact.disabled`：`auto` 是让位路径唯一一个「值一定是布尔」的
 * 落点（`disabled` 在非 Windows 平台上本来就会出现），拿它当判据不会把平台差异混进来。
 * 这个函数跑在假注册表的 `register()` 里，所以它**不能**用 `assert`（那会污染断言计数），
 * 读不懂的声明一律当「没带让位」。
 *
 * @param declaration - 注册表收到的声明对象。
 * @returns 带让位时为 true。
 */
function declarationYieldsCompaction(declaration) {
  try {
    const group = findRow(declaration?.plugins, 'compaction')
    const basic = group?.config?.find?.((row) => row.id === 'compaction-basic')
    return basic?.config?.auto === false
  } catch {
    return false
  }
}

/**
 * 轮询直到 `predicate()` 成立，**返回是否成立**（不在内部断言：调用方 assert 一次，
 * 断言计数才不会被轮询次数污染）。
 *
 * @param predicate - 观察条件。
 * @param budgetMs - 超时上限。
 * @param stepMs - 轮询间隔。
 * @returns 预算内成立为 true。
 */
async function waitFor(predicate, budgetMs = 5000, stepMs = 20) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

/**
 * 在整段窗口里**持续**满足条件 —— 专门用于「之后不再增长」这类负向断言。
 *
 * @param predicate - 观察条件。
 * @param durationMs - 观察窗口。
 * @param stepMs - 轮询间隔。
 * @returns 窗口内始终成立为 true。
 */
async function staysTrue(predicate, durationMs, stepMs = 50) {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (!predicate()) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

/**
 * 取出 `ctx.inject` 里登记了某个依赖的那一条登记。
 *
 * @param scene - `fakeHostCtx()` 的返回值。
 * @param dependency - 服务名。
 * @returns 那一条 `{ deps, callback }`。
 */
function injectRegistrationOf(scene, dependency) {
  const matches = scene.injects.filter((entry) => entry.deps.includes(dependency))
  assert(matches.length === 1, `ctx.inject 应恰好登记一次「${dependency}」，实际 ${matches.length} 次`)
  return matches[0]
}

/**
 * `test()` 的异步版 —— 本文件只有 C7f–C7h 需要（驱动真 `apply()` 必须等声明落地）。
 *
 * 语义与 `test()` 完全一致：抛错即记一条 FAIL，不中断后面的用例、不影响汇总计数。
 *
 * @param label - 用例名。
 * @param fn - 断言体（可以是异步的）。
 */
async function testAsync(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
    console.log(`  PASS  ${label}`)
  } catch (error) {
    results.push({ label, ok: false, message: error.message })
    console.log(`  FAIL  ${label}\n        ${error.message}`)
  }
}

await testAsync('C7f 行为级：闸门在 / 不在 / 读取抛错 / ctx 太简 ⇒ 声明里的 auto·disabled·modelPolicies', async () => {
  if (typeof apply !== 'function') {
    throw new Error('apply 未被导入（记录为未覆盖，不是探测逻辑失败）')
  }

  // ① 闸门在（bili 已经接管压缩）：探测到服务 ⇒ 让位。
  {
    const scene = fakeHostCtx({ reflectGet: () => ({ any: 'service instance' }) })
    apply(scene.ctx, { enabled: true, presetId: 'c7f-gate-present' })
    const count = await waitForDeclarations(scene)
    assert(count === 1, `闸门在时 apply() 应注册 1 份声明，实际 ${count}`)

    const group = compactionGroupOfDeclaration(scene.declarations[0])
    const basic = group.find((row) => row.id === 'compaction-basic')
    assert(basic !== undefined, '闸门在时的声明里找不到 compaction-basic 行')
    assert(
      basic.config.auto === false,
      `闸门在时 compaction-basic.config.auto 应为 false，实际 ${JSON.stringify(basic.config.auto)}`,
    )
    assert(
      !('modelPolicies' in basic.config),
      `闸门在时 compaction-basic.config 不应出现 modelPolicies，` +
        `实际键 ${JSON.stringify(Object.keys(basic.config).sort())}`,
    )
    const command = group.find((row) => row.id === 'command-compact')
    assert(command !== undefined, '闸门在时的声明里找不到 command-compact 行')
    assert(
      command.disabled === true,
      `闸门在时 command-compact.disabled 应为 true，实际 ${JSON.stringify(command.disabled)}`,
    )
    // 「宿主半只是把探测结果转交给组装层」—— 声明必须与组装层直接让位的产物逐字相同，
    // 多出来的任何一处都说明 apply() 自己偷偷改过行。
    assert(
      sameValue(group, compactionGroupOf({ compaction: {}, modelPolicies: [], yieldNativeCompaction: true })),
      `闸门在时的压缩组应与组装层让位产物逐字相同，实际 ${JSON.stringify(group)}`,
    )
    // 探测契约：服务名正确、`strict = false`（接受「服务已登记、fiber 还没 ACTIVE」）、
    // 且整次 apply() 只读一次（`build()` 不重复探）。
    assert(scene.probes.length === 1, `apply() 应只探测一次闸门服务，实际 ${scene.probes.length} 次`)
    assert(
      scene.probes[0].name === 'biliBasicCompactionPolicy',
      `探测的服务名应为 biliBasicCompactionPolicy，实际 ${JSON.stringify(scene.probes[0].name)}`,
    )
    assert(
      scene.probes[0].strict === false,
      `探测必须用宽松模式（get(name, false)），实际 strict=${JSON.stringify(scene.probes[0].strict)}`,
    )
    assert(
      scene.logs.warn.some((line) => line.includes('billion-context has taken over compaction')),
      `让位时应告知用户「原生压缩已让位、仅对新会话生效」，实际日志 ${JSON.stringify(scene.logs.warn)}`,
    )
  }

  // ② 闸门不在：三处都必须是**缺席**，而且整组与组装层非让位产物逐字相同。
  // 后面的 ③④⑤ 都要与这一份比，所以提到断言体外。
  let noGateGroup
  {
    const scene = fakeHostCtx()
    apply(scene.ctx, { enabled: true, presetId: 'c7f-gate-absent' })
    const count = await waitForDeclarations(scene)
    assert(count === 1, `闸门不在时 apply() 应注册 1 份声明，实际 ${count}`)
    const group = compactionGroupOfDeclaration(scene.declarations[0])
    noGateGroup = group

    const basic = group.find((row) => row.id === 'compaction-basic')
    assert(basic !== undefined, '闸门不在时的声明里找不到 compaction-basic 行')
    assert(
      !('auto' in basic.config),
      `闸门不在时 compaction-basic.config 不应出现 auto 键（不是 false，是没有），` +
        `实际键 ${JSON.stringify(Object.keys(basic.config).sort())}`,
    )
    const command = group.find((row) => row.id === 'command-compact')
    assert(command !== undefined, '闸门不在时的声明里找不到 command-compact 行')
    assert(
      !('disabled' in command),
      `闸门不在时 command-compact 不应出现 disabled 键（不是 false，是没有），` +
        `实际 ${JSON.stringify(command)}`,
    )
    assert(
      sameValue(group, compactionGroupOf({ compaction: {}, modelPolicies: [], yieldNativeCompaction: false })),
      `闸门不在时的压缩组应与组装层非让位产物逐字相同，实际 ${JSON.stringify(group)}`,
    )
    assert(
      scene.probes.length === 1,
      `apply() 应只探测一次闸门服务，实际 ${scene.probes.length} 次`,
    )
    assert(
      scene.probes[0].strict === false,
      `探测必须用宽松模式（get(name, false)），实际 strict=${JSON.stringify(scene.probes[0].strict)}`,
    )
  }

  // ③ `ctx.reflect.get()` 抛错：异常一律当「没探测到」，声明与 ② 逐字相同。
  {
    const scene = fakeHostCtx({
      reflectGet: () => {
        throw new Error('reflect exploded')
      },
    })
    let threw
    try {
      apply(scene.ctx, { enabled: true, presetId: 'c7f-reflect-throws' })
    } catch (error) {
      threw = error
    }
    assert(threw === undefined, `探测抛错不得拖垮 apply()，实际抛出 ${threw && threw.message}`)
    const count = await waitForDeclarations(scene)
    assert(count === 1, `探测抛错时仍应注册 1 份声明，实际 ${count}`)
    const group = compactionGroupOfDeclaration(scene.declarations[0])
    assert(
      sameValue(group, noGateGroup),
      `探测抛错时应按「不让位」出声明（与 ② 逐字相同），实际 ${JSON.stringify(group)}`,
    )
    assert(scene.probes.length === 1, `探测抛错时也只应读一次服务，实际 ${scene.probes.length} 次`)
    assert(
      !scene.logs.warn.some((line) => line.includes('billion-context has taken over compaction')),
      `探测抛错不代表让位，不应打让位日志，实际 ${JSON.stringify(scene.logs.warn)}`,
    )
  }

  // ④ 极简 ctx：没有 `reflect`（探测无从谈起）—— 插件照常激活、照常出声明。
  {
    const scene = fakeHostCtx({ withoutReflect: true })
    apply(scene.ctx, { enabled: true, presetId: 'c7f-no-reflect' })
    const count = await waitForDeclarations(scene)
    assert(count === 1, `ctx.reflect 缺失时仍应注册 1 份声明，实际 ${count}`)
    assert(
      sameValue(compactionGroupOfDeclaration(scene.declarations[0]), noGateGroup),
      'ctx.reflect 缺失时应按「不让位」出声明（与 ② 逐字相同）',
    )
    assert(
      scene.logs.info.some((line) => line.includes('"c7f-no-reflect" declared')),
      `插件应完成激活并打出声明日志，实际 info ${JSON.stringify(scene.logs.info)}`,
    )
    assert(
      scene.logs.warn.length === 0,
      `ctx.reflect 缺失本身不该告警，实际 ${JSON.stringify(scene.logs.warn)}`,
    )
  }

  // ⑤ 极简 ctx：没有 `inject`（三个兜底路径全落空）—— 仍然只告警、不抛、照常声明。
  {
    const scene = fakeHostCtx({ withoutInject: true })
    let threw
    try {
      apply(scene.ctx, { enabled: true, presetId: 'c7f-no-inject' })
    } catch (error) {
      threw = error
    }
    assert(threw === undefined, `ctx.inject 缺失不得拖垮 apply()，实际抛出 ${threw && threw.message}`)
    const count = await waitForDeclarations(scene)
    assert(count === 1, `ctx.inject 缺失时仍应注册 1 份声明，实际 ${count}`)
    assert(
      sameValue(compactionGroupOfDeclaration(scene.declarations[0]), noGateGroup),
      'ctx.inject 缺失时应按「不让位」出声明（与 ② 逐字相同）',
    )
    assert(
      scene.logs.info.some((line) => line.includes('"c7f-no-inject" declared')),
      `插件应完成激活并打出声明日志，实际 info ${JSON.stringify(scene.logs.info)}`,
    )
    assert(
      scene.logs.warn.some((line) => line.includes('installing the worker backends failed')),
      `subagents 兜底落空时应告警一次（提示 ptc/minimal 会缺），实际 ${JSON.stringify(scene.logs.warn)}`,
    )
    assert(
      scene.logs.warn.some((line) => line.includes('the model directory could not be read')),
      `llm 兜底落空时应告警一次（预算回落缺省），实际 ${JSON.stringify(scene.logs.warn)}`,
    )
  }
})

// ── C7g：迟绑定 —— `ctx.inject` 的回调真的被执行 ─────────────────────────────────
//
// C7f 只钉「`apply()` 那一刻闸门在不在」，而 bili 比本插件**晚** apply 是常态：静态探测
// 必然落空，唯一能把让位补上的是 `ctx.inject([GATE], cb)` 登记的那个回调。这条腿此前
// 零覆盖（假 `inject` 只登记、从不触发）。这里手动调用登记下来的回调 —— 等价于宿主
// 在服务真的出现时调用 —— 断言「重声明一次、新声明带让位、让位落库日志出现、再触发幂等」。

await testAsync('C7g 迟绑定：ctx.inject 回调触发 ⇒ 重声明一次并带上让位；再触发不再重声明', async () => {
  if (typeof apply !== 'function') {
    throw new Error('apply 未被导入（记录为未覆盖，不是探测逻辑失败）')
  }

  const scene = fakeHostCtx({ reflectGet: () => undefined })
  apply(scene.ctx, { enabled: true, presetId: 'c7g-late-binding' })

  // ① 起始：闸门不在（`reflect.get` 返回 undefined）⇒ 首份声明**不带**让位。
  assert(
    await waitFor(() => scene.declarations.length === 1),
    `闸门不在时 apply() 应注册 1 份声明，实际 ${scene.declarations.length}`,
  )
  assert(
    scene.probes.length === 1 && scene.probes[0].name === GATE_SERVICE,
    `apply() 应只在入口探测一次闸门服务，实际 ${JSON.stringify(scene.probes)}`,
  )
  const firstGroup = compactionGroupOfDeclaration(scene.declarations[0])
  const firstBasic = firstGroup.find((row) => row.id === 'compaction-basic')
  assert(firstBasic !== undefined, '首份声明里找不到 compaction-basic 行')
  assert(
    !('auto' in firstBasic.config),
    `闸门不在时 compaction-basic.config 不应出现 auto 键（不是 false，是没有），` +
      `实际键 ${JSON.stringify(Object.keys(firstBasic.config).sort())}`,
  )
  const firstCommand = firstGroup.find((row) => row.id === 'command-compact')
  assert(firstCommand !== undefined, '首份声明里找不到 command-compact 行')
  assert(
    !('disabled' in firstCommand),
    `闸门不在时 command-compact 不应出现 disabled 键（不是 false，是没有），实际 ${JSON.stringify(firstCommand)}`,
  )
  assert(
    sameValue(firstGroup, compactionGroupOf({ compaction: {}, modelPolicies: [], yieldNativeCompaction: false })),
    `首份声明应与组装层非让位产物逐字相同，实际 ${JSON.stringify(firstGroup)}`,
  )
  assert(
    scene.logs.info.some((line) => line.includes('compaction is NOT yielded')),
    `静态探测不到闸门时应留一条 info，实际 ${JSON.stringify(scene.logs.info)}`,
  )

  // ② 触发登记下来的回调 —— 「bili 晚于本插件 apply，服务此刻才出现」。
  const gate = injectRegistrationOf(scene, GATE_SERVICE)
  const registrationsBeforeTrigger = scene.attempts.length
  gate.callback()
  assert(
    await waitFor(() => scene.declarations.length === 2),
    `触发 inject 回调后应多出 1 份**已注册**声明，实际 ${scene.declarations.length} 份`,
  )
  assert(
    scene.attempts.length === registrationsBeforeTrigger + 1,
    `一次迟绑定应只重声明一次，实际新增 ${scene.attempts.length - registrationsBeforeTrigger} 次注册`,
  )
  const yieldedGroup = compactionGroupOfDeclaration(scene.declarations[1])
  const yieldedBasic = yieldedGroup.find((row) => row.id === 'compaction-basic')
  assert(yieldedBasic !== undefined, '重声明后的声明里找不到 compaction-basic 行')
  assert(
    yieldedBasic.config.auto === false,
    `迟绑定让位后 config.auto 应为 false，实际 ${JSON.stringify(yieldedBasic.config.auto)}`,
  )
  assert(
    !('modelPolicies' in yieldedBasic.config),
    `迟绑定让位后 config 不应出现 modelPolicies，实际键 ${JSON.stringify(Object.keys(yieldedBasic.config).sort())}`,
  )
  const yieldedCommand = yieldedGroup.find((row) => row.id === 'command-compact')
  assert(yieldedCommand !== undefined, '重声明后的声明里找不到 command-compact 行')
  assert(
    yieldedCommand.disabled === true,
    `迟绑定让位后 command-compact.disabled 应为 true，实际 ${JSON.stringify(yieldedCommand.disabled)}`,
  )
  assert(
    sameValue(yieldedGroup, compactionGroupOf({ compaction: {}, modelPolicies: [], yieldNativeCompaction: true })),
    `迟绑定让位后的压缩组应与组装层让位产物逐字相同，实际 ${JSON.stringify(yieldedGroup)}`,
  )
  assert(
    scene.logs.info.some((line) => line.includes('is now part of the registered preset declaration')),
    `让位真的进了注册表时应打「让位已落库」的 info，实际 ${JSON.stringify(scene.logs.info)}`,
  )
  assert(
    scene.logs.warn.some((line) => line.includes('billion-context has taken over compaction')),
    `迟绑定让位也应告知「仅对新会话生效」，实际 ${JSON.stringify(scene.logs.warn)}`,
  )
  // 迟绑定不重探：探测结论由回调改写，服务名不会再读第二眼。
  assert(scene.probes.length === 1, `迟绑定不应重新探测闸门服务，实际累计 ${scene.probes.length} 次`)

  // ③ 再触发一次同一个回调 ⇒ `closed || yielded` 守卫生效，不再产生新注册。
  gate.callback()
  assert(
    await staysTrue(
      () => scene.attempts.length === registrationsBeforeTrigger + 1 && scene.declarations.length === 2,
      400,
    ),
    `重复触发不应再注册：实际新增 ${scene.attempts.length - registrationsBeforeTrigger} 次、` +
      `已注册 ${scene.declarations.length} 份`,
  )

  // ④ `ctx.inject` 的依赖数组恰好是那一个服务名（多写一个都会让回调永不触发 / 过早触发）。
  const gateRegistration = injectRegistrationOf(scene, GATE_SERVICE)
  assert(
    sameValue(gateRegistration.deps, [GATE_SERVICE]),
    `ctx.inject 的依赖数组应恰好是 ${JSON.stringify([GATE_SERVICE])}，实际 ${JSON.stringify(gateRegistration.deps)}`,
  )
  assert(
    typeof gateRegistration.callback === 'function',
    `ctx.inject 应收到一个回调函数，实际 ${typeof gateRegistration.callback}`,
  )
})

// ── C7h：让位声明**应用失败** ⇒ 回滚 + 有界重试 ──────────────────────────────────
//
// 覆盖「探测到闸门、但那份带让位的声明装不上去」这条路：注册表拒绝 → 必须回滚到上一份
// **不让位**声明 → 之后 `build()` 也不许再按探测结果组装让位（回滚修复的核心不变式）→
// 自动重试有界（1 次原始 + 2 次重试），用完只留一条终局告警。
//
// 重试走真实定时器（1.5s / 3s 线性退避），所以这条用例约 6 秒；仓库里已有 10 秒级用例的
// 先例，可接受。所有等待都是「轮询直到条件成立 + 超时上限」，没有固定 sleep。

await testAsync('C7h 让位声明应用失败 ⇒ 回滚到不让位声明 + 有界重试（1+2 次）后停手', async () => {
  if (typeof apply !== 'function') {
    throw new Error('apply 未被导入（记录为未覆盖，不是探测逻辑失败）')
  }

  // 起始闸门不在（不带让位的第一份声明能成功）；`rejectYield` 让假注册表拒收任何带让位的声明。
  const scene = fakeHostCtx({ reflectGet: () => undefined, rejectYield: true })
  const config = { enabled: true, presetId: 'c7h-refused-yield' }
  apply(scene.ctx, config)
  assert(
    await waitFor(() => scene.declarations.length === 1),
    `闸门不在时 apply() 应注册 1 份声明，实际 ${scene.declarations.length}`,
  )

  const yieldAttempts = () => scene.attempts.filter((entry) => entry.yielded)
  const refusalWarnings = () => scene.logs.warn.filter((line) => line.includes('could NOT be applied'))

  injectRegistrationOf(scene, GATE_SERVICE).callback()

  // ① 让位声明注册失败 ⇒ 回滚到上一份（不让位）声明。
  assert(
    await waitFor(() => refusalWarnings().length >= 1),
    `让位声明被拒后应打出「could NOT be applied」告警，实际 warn ${JSON.stringify(scene.logs.warn)}`,
  )
  assert(
    scene.attempts[1]?.yielded === true,
    `第 2 次注册应是那份带让位的声明，实际序列 ${JSON.stringify(scene.attempts.map((entry) => entry.yielded))}`,
  )
  assert(
    scene.declarations.length >= 2,
    `回滚应把上一份声明重新注册回去，实际已注册 ${scene.declarations.length} 份`,
  )
  assert(
    sameValue(scene.declarations[1], scene.declarations[0]),
    `回滚回去的应是原来那份声明的全部内容：实际 ${JSON.stringify(scene.declarations[1]?.id)}`,
  )
  assert(
    scene.declarations.every((declaration) => declarationYieldsCompaction(declaration) === false),
    '被接受的声明里不应出现带让位的那一份（注册表拒绝了它）',
  )

  // ② 那条 warn 必须同时说清「失败」与「后果」两个字面量。
  assert(
    refusalWarnings()[0].includes('dsh_compaction_refused'),
    `让位失败告警应点名 dsh_compaction_refused，实际 ${JSON.stringify(refusalWarnings()[0])}`,
  )

  // ③ 重试有界：等终局告警，然后让位尝试恰好 3 次（1 次原始 + 2 次重试）。
  assert(
    await waitFor(() => scene.logs.warn.some((line) => line.includes('automatic retry budget')), 20000),
    `重试预算用尽后应打出终局告警，实际 warn ${JSON.stringify(scene.logs.warn)}`,
  )
  assert(
    yieldAttempts().length === 3,
    `让位尝试应恰好 3 次（1 次原始 + 2 次重试），实际 ${yieldAttempts().length} 次`,
  )
  const budgetWarnings = scene.logs.warn.filter((line) => line.includes('automatic retry budget'))
  assert(budgetWarnings.length === 1, `终局告警只应出现一次，实际 ${budgetWarnings.length} 次`)
  // 退避是真实的 1.5s / 3s：只断言**下界**（定时器不会提前触发），上界留给机器忙时。
  const [firstAttempt, secondAttempt, thirdAttempt] = yieldAttempts()
  assert(
    secondAttempt.at - firstAttempt.at >= 1400,
    `第 1 次重试应至少等 1.5s，实际 ${secondAttempt.at - firstAttempt.at}ms`,
  )
  assert(
    thirdAttempt.at - secondAttempt.at >= 2900,
    `第 2 次重试应至少等 3s，实际 ${thirdAttempt.at - secondAttempt.at}ms`,
  )
  // 预算用尽后没有任何待触发的定时器：再观察一小段，计数不许动。
  assert(
    await staysTrue(() => yieldAttempts().length === 3 && budgetWarnings.length === 1, 700),
    `重试预算用尽后不应再尝试，实际 ${yieldAttempts().length} 次`,
  )

  // ④ 核心不变式：之后 `build()` 产出的声明**不带**让位（`build()` 不再读探测结果）。
  // 观察口是公开的重声明路径：模拟设置面板写一个新值 → loader 发 `loader/volatile-update`
  // → 本插件用新设置重建声明。若 `build()` 仍按探测结果组装让位，这次注册会被假注册表
  // 拒绝（`rejectYield`），于是不会多出任何**已接受**的声明。
  const acceptedBefore = scene.declarations.length
  const attemptsBefore = scene.attempts.length
  config.compaction = { headroomTokens: 16384 }
  const onVolatileUpdate = scene.handlers.get('loader/volatile-update')
  assert(
    typeof onVolatileUpdate === 'function',
    `apply() 应挂上 loader/volatile-update 监听，实际登记的事件 ${JSON.stringify([...scene.handlers.keys()])}`,
  )
  onVolatileUpdate()
  assert(
    await waitFor(() => scene.declarations.length === acceptedBefore + 1),
    `设置改动后应多出 1 份已注册声明，实际新增 ${scene.declarations.length - acceptedBefore} 份`,
  )
  const rebuiltGroup = compactionGroupOfDeclaration(scene.declarations[scene.declarations.length - 1])
  const rebuiltBasic = rebuiltGroup.find((row) => row.id === 'compaction-basic')
  assert(rebuiltBasic !== undefined, '重建后的声明里找不到 compaction-basic 行')
  assert(
    !('auto' in rebuiltBasic.config),
    `回滚之后 build() 不应再产出让位（核心不变式），实际 ${JSON.stringify(rebuiltBasic.config)}`,
  )
  assert(
    rebuiltBasic.config.headroomTokens === 16384 && rebuiltBasic.config.maxTokens === 16384,
    `新设置应真的进了声明（证明 build() 重跑过），实际 ${JSON.stringify(rebuiltBasic.config)}`,
  )
  // 一次成功 = 只多一次注册；多出来的那次只可能是「被拒的让位声明 + 回滚」这一对。
  assert(
    scene.attempts.length === attemptsBefore + 1,
    `这次重声明应一次成功、不触发回滚，实际多出 ${scene.attempts.length - attemptsBefore} 次注册`,
  )
  const rebuiltCommand = rebuiltGroup.find((row) => row.id === 'command-compact')
  assert(
    rebuiltCommand !== undefined && !('disabled' in rebuiltCommand),
    `回滚之后 /compact 应重新提供，实际 ${JSON.stringify(rebuiltCommand)}`,
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
