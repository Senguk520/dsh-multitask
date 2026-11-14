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
 * 只 `import` 一个模块（它的模块求值本身就是本地回归的一部分：语法 / 引用
 * 错误会在这里变成可读的失败），不加载 DSH、不起会话、不写文件、不 spawn。
 *
 * @module dsh-multitask/test/compaction-settings
 */
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
