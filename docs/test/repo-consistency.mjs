/**
 * 仓库一致性校验（静态 / 离线，零依赖，不碰任何东西）。
 *
 * ── 它守的是什么（都是实测过的结论，见 README 对应小节）──────────────────────
 *
 *   1. **并发上限只有一个执行点**：本插件**不再有自己的并发上限字段、也不再装并发
 *      守卫** —— 「同时能跑几个」完全由宿主 `subagent.maxActiveSubagents` 决定。
 *      这一节守的是「别把它重建回来」：任何 `MAX_ACTIVE_*` 常量、任何
 *      `concurrency-guard` 行、任何自己那份 `maxActiveSubagents` 都会变红。
 *   2. **文档与代码一致**：README 里关于并发上限的说法必须与实现逐字对得上。
 *   2e. **两份 README 的骨架同步**：英文版（`README.md`）与中文版（`README.zh.md`）
 *      是逐节对译，所以**骨架**必须一致 —— 标题层级序列、代码块围栏数、表格数。
 *      R 组只校验中文版（断言匹配的是中文句子），英文版因此完全没有别的东西看着它。
 *   3. **测试文件归位**：仓库里任何测试类的文件都必须在 `test/` 下。
 *
 * ── 为什么是「静态」校验（本仓库的一条既有取舍）─────────────────────────────
 *
 * 它只读文件、只比对字符串，不加载 DSH、不起会话、**不写任何东西**。这与
 * `guard-mode-isolation-regression.mjs` 同取向：那套脚本也是进程内、零 spawn。
 * 区别只在于本文件连被测模块都不 import（除必要时加载几个纯数据模块），
 * 因为它的目标是「文本里写的」与「代码里做的」是否对得上。
 *
 * ⚠️ 本文件**永不修改任何文件**，也不 spawn 任何进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 从本文件的位置推导仓库根 —— 所以整个仓库可以放在任何路径下（含非 ASCII 路径）。
const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')

/** 参与校验的实现文件。 */
const HOST_HALF = path.join(ROOT, 'lib', 'index.js')
/** 注册两个自建 provider 的模块 —— M8 的判据对象（**不是** `HOST_HALF`）。 */
const PROVIDER_MODULE = path.join(ROOT, 'lib', 'worker-providers.js')
const CLIENT_HALF = path.join(ROOT, 'lib', 'client.js')
const COMPOSITION = path.join(ROOT, 'presets', 'multitask', 'composition.mjs')
const SUBAGENT_MODE = path.join(ROOT, 'presets', 'multitask', 'subagent-mode.mjs')
const MINIMAL_GUARD = path.join(ROOT, 'presets', 'multitask', 'minimal-guard.mjs')
/** 协调者那一半的机制（保留集的所在）—— G3 的判据对象。 */
const COORDINATOR_GUARD = path.join(ROOT, 'presets', 'multitask', 'coordinator-guard.mjs')
const APPROVAL_GATE = path.join(ROOT, 'presets', 'multitask', 'approval-gate.mjs')
const WORKSPACE_ACL = path.join(ROOT, 'presets', 'multitask', 'workspace-acl.mjs')
/** 跨模式派发模块 —— M9 / M10 的判据对象。 */
const DISPATCH = path.join(ROOT, 'presets', 'multitask', 'preset-dispatch.mjs')
const WORKSPACE_ACL_TEST = path.join(ROOT, 'docs', 'test', 'workspace-acl-rules.mjs')
/**
 * 参与文档一致性校验的那一份 README。
 *
 * ⚠️ 必须是**中文版**（`README.zh.md`）：本文件 R 组的断言匹配的是中文句子
 * （「只有一个值」「不是天花板」「所有测试文件都必须写进 `test/`」…），
 * 它们在英文版里无从匹配。两份 README 是逐节对译，所以以中文版为断言对象即可 ——
 * 英文版承载同样的内容，改中文版却漏改英文版属于文档维护问题，不在这套脚本的射程内。
 *
 * 仓库根的 `README.md` 是**英文**版（GitHub 的惯例是让默认入口是英文），
 * 中文版在 `README.zh.md` —— 所以这里刻意不写 `README.md`。
 */
const README = path.join(ROOT, 'README.zh.md')
/**
 * 英文版的 README。
 *
 * 仓库根用 `README.md` 放**英文**（GitHub 的默认入口惯例就是英文），中文版在
 * `README.zh.md`。两者是逐节对译，所以这里能与上面那份做骨架对照 —— 见 2f 组。
 */
const README_EN = path.join(ROOT, 'README.md')

/**
 * 本机工程记录（`docs/remember.md`，被 `.gitignore` 忽略、不进发布物）。
 *
 * ── 为什么 R6 / N1 盯的是它，而不是 README ─────────────────────────────────
 *
 * 这两条守的都是**测试套件自身**的约定（「测试都放 `test/`」、README 里的用例数要与
 * 脚本实际计数一致）。而 `test/` 与本文件**都是本地专属**：`.gitignore` 把两者都忽略，
 * 所以 GitHub 上的访客**看不到任何一个**。
 *
 * 于是把它们写进 README（npm 页面首页）是错的 —— 那会让读者看到一套自己永远拿不到的
 * 脚本清单。**「描述测试的东西」只应该待在「测试自己看得见的地方」**，也就是本文件。
 * 这两条断言因此改读它：判据一个字没变，只是换了盯着的文档。
 *
 * ⚠️ 本文件缺席时**跳过而不是判红**：它与 `test/` 同进退（两者都被忽略），
 * 所以「文件不在」只可能出现在「整套测试本来也不在」的场景里 —— 那种情况下判红只会
 * 给出一个没法照做的失败提示。
 */
const REMEMBER = path.join(ROOT, 'docs', 'remember.md')

/**
 * 公开发布的设计说明（`docs/DESIGN.md`，在 `package.json` 的 `files` 里，随包分发）。
 *
 * M5b 的判据对象之一：那张「三类 `approval/asked` 前缀」的对照表就在它里面，
 * 而它是**读者真的能拿到**的那份文档 —— 它的可观测性承诺必须与实现同步。
 */
const DESIGN = path.join(ROOT, 'docs', 'DESIGN.md')

/**
 * 读一份**本地专属**的文档；缺席时返回 undefined（调用方据此跳过并说明原因）。
 *
 * @param file - 绝对路径。
 * @returns 文件内容，或在文件不存在时返回 undefined。
 */
function readOptionalLocal(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 被删除的那个守卫模块的路径 —— 只用来断言「它**不**存在」。
 *
 * 留着这个常量是有意的：`presets/multitask/concurrency-guard.mjs` 曾经存在，
 * 而重新引入它正是本节要挡的回归。
 */
const REMOVED_GUARD = path.join(ROOT, 'presets', 'multitask', 'concurrency-guard.mjs')

/**
 * 宿主 `subagent.maxActiveSubagents` 的**默认值**：`8`。
 *
 * ⚠️ 这是**默认值，不是容量上界** —— 这一点曾经被本文件搞错过：宿主 schema 是
 * `z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8)`，宿主 README
 * 也写着「调高后已有树可接纳更多子代理」。所以本插件**不该**把用户设的值夹到这个
 * 数上（早先的版本正是这么做的）。下面这个常量只用于 R 组确认 README 的叙述自洽。
 */
const HOST_DEFAULT_LIMIT = 8

/** 宿主在名额不足时抛出的错误原文（逐字，来自 `ActivationPool.reserve()`）。 */
const HOST_ERROR = 'subagent limit reached (active child limit: '

const results = []

/**
 * 跑一条用例并记录结果（与 `guard-mode-isolation-regression.mjs` 同形状）。
 *
 * ⚠️ 这里**只入队、不就地调用**是刻意的：本文件的用例都是同步的，所以没有那套
 * 「`async` 用例一 await 就立刻记通过」的坑，但保留同一形状，好让两套脚本读起来
 * 是一套东西。若将来有人把某条改成 `async`，必须同时改成「入队 + 收尾 await」，
 * 否则那条用例会**恒绿**。
 *
 * @param name - 用例名。
 * @param fn - 断言体；抛错即算失败。
 */
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/**
 * 最小的断言（本仓库刻意不用 `node:assert`：那些脚本要在受限环境里跑，
 * 自带一个就够，也少一处依赖）。
 *
 * @param cond - 条件。
 * @param message - 不成立时的说明（**必须指名是哪一处不一致**）。
 */
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

/**
 * 读文件（UTF-8）。读不到就直接失败 —— 找不到被测文件本身也是不一致。
 *
 * @param file - 绝对路径。
 * @returns 文件内容。
 */
function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`无法读取 ${file}: ${error.message}`)
  }
}

/**
 * 递归找出所有「测试类」文件（按名字与内容两路特征扫，而不是只看文件名）。
 *
 * 两路判据**任一**成立即算违规：
 *   · **名字路** —— 路径里出现 `test` / `verify` / `probe` / `spec` / `regression` /
 *     `diag` / `check` 这类字样；
 *   · **内容路** —— 内容里既有断言痕迹（`node:assert` / `console.assert` /
 *     `process.exitCode` / `process.exit(1)` / `spawnSync`），又自带一个极小的
 *     `test()` 运行器（`function test(` 或 `const results = []`）。
 *
 * 之所以要按**内容**也扫一遍：一个名叫 `audit-runner.mjs` 的探针脚本放在 `tools/`
 * 下，名字看不出来、内容看得出来，正是本规则要挡住的东西。
 *
 * ⚠️ 名字路有两个曾经真实漏过东西的坑，别再踩回去（两处都实测复现过）：
 *   1. **边界必须包含路径分隔符**。旧判据的边界只有 `^` 与 `[-_.]`，于是
 *      `tools/verify-runner.mjs` 这种「关键字正好是某个路径段的开头」的名字**不匹配**
 *      —— 关键字前面是 `/`，不在边界集里。
 *   2. **扫的扩展名必须与判据里列的扩展名一致**。旧判据里写了 `.ps1`，但遍历时
 *      只读 `.mjs|js|cjs|ts`，于是仓库根下摆一个 `check-security.ps1` 谁都看不见。
 *      现在两处共用 `SCANNED`，从结构上消除这种自相矛盾。
 *
 * @returns 违规文件的相对路径数组。
 */
function testLikeFilesOutsideTest() {
  const SKIP_DIRS = new Set(['.git', 'node_modules', '.cursor', 'test'])
  /**
   * 按**相对路径**整体排除的目录 —— 只有 `research/`。
   *
   * `research/` 下是**外部仓库的拷贝**（第三方研究副本，2026-10-31 就在仓库里），
   * 其中的 `*.spec.ts` 与 `vitest.config.ts` 属于那份拷贝自己的测试体系，
   * 不属于本仓库的测试资产，所以整个目录不进入扫描。
   *
   * ⚠️ 判据刻意用「根下的**相对路径**精确比对」，而不是 `SKIP_DIRS.add('research')`：
   * 按目录名排除会连带放过将来任何位置一个叫 `research/` 的目录，而那恰恰是本规则
   * 该抓的东西（`tools/research/verify.mjs` 不该因为它叫 research 就溜过去）。
   * 除这一个目录外，没有放宽任何目录。
   */
  const EXCLUDED_DIRS = new Set(['research'])
  /** 会进入扫描的扩展名 —— **必须**与 `NAME_HINT` 的扩展名列表一致（见上方第 2 条）。 */
  const SCANNED = /\.(mjs|js|cjs|ts|ps1)$/i
  /** 名字路判据；边界含路径分隔符（见上方第 1 条）。 */
  const NAME_HINT = /(?:^|[-_.\/\\])(test|tests|verify|probe|spec|specs|regression|diag|diagnose|check)[-_.]?[^\/\\]*\.(mjs|js|cjs|ts|ps1)$/i
  /**
   * 关键字**嵌在词中间**也算（如 `mytest.mjs`）—— 沿用本文件改动前就有的那一路，
   * 因此只列 `test`：`test` 作为子串几乎不会误伤正常文件名，而 `check` / `probe`
   * 这类子串会（`checksum.mjs` 不是测试）。边界之外的宽松度刻意保持原样，不趁机扩大。
   */
  const NAME_LOOSE = /(^|[\\/])[^\\/]*test[^\\/]*\.(mjs|js|cjs|ts|ps1)$/i
  const CONTENT_HINT = /node:assert|node:test|console\.assert|process\.exitCode|process\.exit\(1\)|spawnSync/
  const RUNNER_HINT = /function\s+test\s*\(|const\s+results\s*=\s*\[\]/
  const found = []

  /** 深度优先遍历（同步，够用）。 */
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        // 根下 `research/`（外部仓库拷贝）整体不扫，见 EXCLUDED_DIRS 的注释。
        if (EXCLUDED_DIRS.has(path.relative(ROOT, full).replace(/\\/g, '/'))) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!SCANNED.test(entry.name)) continue
      const rel = path.relative(ROOT, full).replace(/\\/g, '/')
      const text = (() => {
        try {
          return fs.readFileSync(full, 'utf8')
        } catch {
          return ''
        }
      })()
      const nameSays = NAME_HINT.test(rel) || NAME_LOOSE.test(rel)
      const contentSays = CONTENT_HINT.test(text) && RUNNER_HINT.test(text)
      if (nameSays || contentSays) found.push(rel)
    }
  }

  walk(ROOT)
  return found
}

/**
 * 运行期核对要用到真模块 —— **只加载、不调用任何会写东西的东西**。
 *
 * 这里刻意让「模块能不能加载」本身成为一条被断言的属性：本仓库对预设模块的约定是
 * 零依赖、零 import，而 `composition.mjs` / `lib/index.js` 又都在**模块求值时**
 * 就把行表构造出来（`definition.plugins` 里的无参 `buildPlugins()`）——
 * 任何一处语法或引用错误都会在这里变成可读的失败，而不是等到装机时才炸。
 *
 * ⚠️ 加载失败**不抛**，记下来交给 D0 报一个清楚的失败；否则整个脚本会在打印任何
 * 结果之前就崩掉。
 */
const loaded = { composition: undefined, host: undefined, approvalGate: undefined, workspaceAcl: undefined }
const loadErrors = []
for (const [key, file] of [
  ['composition', COMPOSITION],
  ['host', HOST_HALF],
  ['approvalGate', APPROVAL_GATE],
  ['workspaceAcl', WORKSPACE_ACL],
]) {
  try {
    loaded[key] = await import(pathToFileURL(file).href)
  } catch (error) {
    loadErrors.push(`${path.relative(ROOT, file)}: ${error.message}`)
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
 * 行表里**所有**出现过的 id（用于断言某个 id **不在**表里）。
 *
 * @param rows - 行表。
 * @returns id 数组。
 */
function allRowIds(rows) {
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.id === 'string') out.push(row.id)
    if (Array.isArray(row.config)) out.push(...allRowIds(row.config))
  }
  return out
}

console.log('===== dsh-multitask 仓库一致性校验（静态 / 离线）=====')
console.log(`仓库根: ${ROOT}`)

// ── 零、模块必须能加载（一切前提）─────────────────────────────────────────────
console.log('\n--- 0. 模块加载 ---')

test('D0 三个实现模块都能被 import（零依赖可加载）', () => {
  assert(
    loadErrors.length === 0,
    `以下模块无法加载（语法错误 / 依赖缺失）：\n        - ${loadErrors.join('\n        - ')}`,
  )
})

// ── 一、并发上限：**只有一个执行点**（宿主），本插件不许再有自己那份 ──────────
//
// ⚠️ 这一节**被整段重写过两次**，两次的原因都值得留在这里，因为它们是同一个错误的
// 两个阶段：
//
//   第一阶段：这里断言「三道收敛都必须把值夹到 8」，理由是「8 是 DSH 宿主的容量」。
//   **那个前提是错的** —— 宿主 schema 逐字为
//       maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8)
//   8 只是 `.default()`。于是插件把用户设的 16 砍成 8，而那本来是可以生效的。
//
//   第二阶段：去掉夹子之后，这里改成断言「三道收敛都原样采用」。**那也不够** ——
//   实测确认：宿主那道**同名**上限始终同时生效，而本插件那个字段只决定**本插件自己
//   那个守卫**要不要装。于是用户在「Multitask」页选「不限制」、看到「本模式不额外设限」，
//   实际却依然被宿主的默认 8 卡住 —— **那个面板在撒谎**。
//
// 所以现在这一节守的是**删除本身**：本插件不再有并发上限字段、不再有并发守卫行、
// 不再有那个模块。只有宿主一个执行点。谁把它重建回来，这里就会红。
console.log('\n--- 1. 并发上限：只剩宿主一个执行点 ---')

test('C1 ★ concurrency-guard.mjs 已删除，且不许重建', () => {
  assert(
    !fs.existsSync(REMOVED_GUARD),
    'presets/multitask/concurrency-guard.mjs 又存在了 —— 那个守卫已按「只有一个执行点」' +
      '的决定整体删除。它的计数口径与宿主不同（把一次性子代理也算进去、释放时机更早），' +
      '两套账同时生效会让「面板上写多少」变得不可预测。',
  )
})

test('C2 composition.mjs 不再有任何并发上限的痕迹（常量 / 收敛函数 / 守卫行）', () => {
  const composition = read(COMPOSITION)
  assert(
    !/MAX_ACTIVE_CEILING/.test(composition.replace(/^[ \t]*(?:\*|\/\/).*$/gm, '')),
    'composition.mjs 的**代码行**里又出现了 MAX_ACTIVE_CEILING',
  )
  assert(
    !/function\s+normalizeMaxActive\s*\(/.test(composition),
    'composition.mjs 又有了 normalizeMaxActive —— 那是给已删除的守卫行收敛入参用的',
  )
  assert(
    !/concurrency-guard/.test(composition.replace(/^[ \t]*(?:\*|\/\/).*$/gm, '')),
    'composition.mjs 的**代码行**里又出现了 concurrency-guard 行',
  )
})

test('C3 ★ lib/index.js 不再声明自己的并发上限字段', () => {
  const host = read(HOST_HALF)
  const code = host.replace(/^[ \t]*(?:\*|\/\/).*$/gm, '')
  assert(
    !/MAX_ACTIVE_FIELD/.test(code),
    'lib/index.js 的代码里又出现了 MAX_ACTIVE_FIELD —— 那是本插件自己那份并发上限字段，已删除',
  )
  assert(
    !/MAX_ACTIVE_FIELD_NAME/.test(code),
    'lib/index.js 又在导出 MAX_ACTIVE_FIELD_NAME（已删除）',
  )
  assert(
    !/function\s+normalizeMaxActive\s*\(/.test(code) && !/function\s+readMaxActive\s*\(/.test(code),
    'lib/index.js 又有了 normalizeMaxActive / readMaxActive —— 它们服务的是已删除的那个字段',
  )
})

test('C4 ★ 宿主半的 Config 不再声明那个字段（它现在归宿主 dsh-subagent 所有）', () => {
  assert(loaded.host !== undefined, 'lib/index.js 没加载成功')
  const validated = loaded.host.Config['~standard'].validate({ subagentModels: [], watchdog: {} })
  const keys = Object.keys(validated.value).filter((k) => k !== '~standard')
  assert(
    keys.includes('subagentModels') && keys.includes('watchdog'),
    `Config.validate 必须同时产出 subagentModels 与 watchdog（本插件的两个 volatile 字段），实际键：${keys.join(', ')}`,
  )
  assert(
    !keys.includes('maxActiveSubagents'),
    'Config.validate 又产出了 maxActiveSubagents —— 那个字段已删除，不再归本插件所有',
  )
})

test('C5 ★ 面板两处 UI 编辑的是**同一个**宿主字段', () => {
  const client = read(CLIENT_HALF)
  // 真源只有一处：宿主命名空间的路径。两处 UI 都必须指向它。
  const refs = [...client.matchAll(/concurrencyRef:\s*"([^"]+)"/g)].map((m) => m[1])
  assert(refs.length >= 2, `应当有两处 UI 的 ref（zh / en 各一份），实际 ${refs.length} 处`)
  for (const ref of refs) {
    assert(
      ref === 'subagent.maxActiveSubagents',
      `有一处 UI 的 concurrencyRef 是 "${ref}"，应当指向宿主字段 "subagent.maxActiveSubagents" —— ` +
        '两处 UI 必须编辑同一个值，否则改一处另一处不会跟着变',
    )
  }
  assert(
    !/multitask\.maxActiveSubagents/.test(client),
    'client.js 里仍引用 multitask.maxActiveSubagents —— 那个字段已删除，面板不能再指向它',
  )
})

test('C6 ★ 面板里没有「不限制」那一档了（该字段无法表达它）', () => {
  const client = read(CLIENT_HALF)
  for (const key of ['optCapOff', 'optCapOn', 'concurrencyModeLabel', 'concurrencyModeDesc', 'concurrencyValueDesc', 'invalidConcurrency']) {
    assert(
      !new RegExp(`${key}:`).test(client),
      `client.js 里仍留着 ${key} —— 「限制 / 不限制」那一档已删除：` +
        '宿主那个字段自带默认值，无法表达「不限制」，留着只会让用户以为取消了上限',
    )
  }
})

test('C7 concurrency-guard / normalizeMaxActive 不许出现在任何实现文件里', () => {
  for (const file of [COMPOSITION, HOST_HALF, CLIENT_HALF]) {
    const code = read(file).replace(/^[ \t]*(?:\*|\/\/).*$/gm, '')
    assert(
      !/(?:concurrency-guard|normalizeMaxActive|readMaxActive)/.test(code),
      `${path.basename(file)} 的代码里又出现了已删除的并发机制（concurrency-guard / ` +
        'normalizeMaxActive / readMaxActive）',
    )
  }
})

// ── 一之四、那张卡的**排版**：同一句话不许在一屏里出现多次 ─────────────────────
//
// 这两条守的是一个**实测截图确认过**的排版缺陷，不是审美偏好：
//
//   1. 卡片标题、卡片内那一行的**视觉**标题、以及说明文字，三处曾经都在说
//      「子代理并行数量上限」（标题一字不差地重复了两遍）。
//   2. 那个行组件原本是给「通用设置」那种**无卡片**列表画的（左右没有内边距），
//      直接塞进卡片后行文字贴到卡片左边框上，与卡片标题对不齐。
//
// 两者都是**静态可检**的，所以写成断言 —— 否则下次调文案时很容易再退回去。
console.log('\n--- 1f. 卡片的排版（三层文案各说各的，不重复）---')

test('C10 ★ 卡片里那一行不许再把标题画出来（否则与卡片标题逐字重复两次）', () => {
  const client = read(CLIENT_HALF)

  // ⚠️ 先澄清一件事：卡片标题与那一行的标签**用同一个词是对的**（本轮改动之后
  // 它们甚至就是同一个字典键 `maxActive`）—— 那正是「这是同一个设置」的信号。
  // 所以判据**不是**「两个字符串必须不同」，而是：**在卡片语境里，标题只画一次**。
  //
  // 实测截图确认过的那个缺陷是：卡片标题画了一遍，卡片内那一行又把同一个词画了一遍，
  // 一屏里同一句话出现两次，而两者的字号字体几乎一样，看的人只会觉得「重复」。
  //
  // 修法是 `LimitRow` 接受 `inCard`：置真时**不渲染视觉标题**，`label` 只留给
  // `aria-label`（读屏用户照旧听得到，标题层级不靠视觉重复来撑）。
  // 这条断言锁的就是那个分支 —— 谁把标题改回无条件渲染，这里立刻红。
  assert(
    /props\.inCard !== true\)\s*leftText\.push/.test(client),
    '`LimitRow` 又无条件渲染标题了 —— 卡片里会让同一句话出现两次。' +
      '正确形状是「只有非卡片语境才 push 标题」（`props.inCard !== true` 那一支），' +
      '`label` 仍要传下去，它是输入框的 aria-label。',
  )

  // 反向：两个语境都必须仍然把 `label` 交到输入框的无障碍标签上 ——
  // 「视觉上省掉」不等于「无障碍上省掉」，后者会让读屏用户听到一个没有名字的输入框。
  assert(
    /"aria-label":\s*props\.label/.test(client),
    '`LimitRow` 的输入框不再带 `aria-label: props.label` —— 卡片里省掉视觉标题之后，' +
      '读屏用户会听到一个没有名字的输入框',
  )
})

test('C11 ★ 卡片里的那一行必须用卡片内的行距（否则与卡片标题对不齐）', () => {
  const client = read(CLIENT_HALF)
  // 行组件必须**两种语境都能表达**：无卡片列表用 .mt-grow，卡片里用 .mt-growCard。
  assert(
    /\.mt-growCard\{/.test(client),
    'client.js 里没有 .mt-growCard 规则 —— 卡片里那一行会沿用 .mt-grow 的零左右内边距，' +
      '行文字贴到卡片边框上，与卡片标题对不齐（实测截图确认过）',
  )
  assert(
    /\.mt-growCard\{padding:14px 16px/.test(client),
    '.mt-growCard 的左右内边距必须是 16px（与 .mt-cardHead / .mt-cardNote 同一套度量）',
  )
  // 覆盖必须真的生效：单类选择器同权重，靠的是**书写顺序**。
  const grow = client.indexOf('.mt-grow{')
  const growCard = client.indexOf('.mt-growCard{')
  assert(grow >= 0 && growCard >= 0, '.mt-grow / .mt-growCard 两条规则都必须存在')
  assert(
    grow < growCard,
    '.mt-growCard 必须写在 .mt-grow **之后** —— 两者同为单类选择器，权重相同，' +
      '只有靠书写顺序才能覆盖 padding',
  )
  // 卡片里那一行必须真的把 inCard 传下去。
  assert(
    /inCard:\s*true/.test(client),
    'CardSection 里没有传 `inCard: true` —— 那一行仍会渲染视觉标题，并与卡片标题重复',
  )
})

// ── 一之五、不许出现「AI 临时指派模型」那个开关 ───────────────────────────────
//
// 这是用户明确要求删掉的一条能力：`modelSelectionSettings: true` 会让委派工具公开
// `provider` / `model` / `reasoning_effort` 三个字段 + `list_subagent_models`，从而让
// **协调者自己在某次调用里**挑模型。本包要的是「模型由用户在设置面板里按 worker 类型
// 决定」（走行的 `agentOptions`，见 B12），两条路会互相打架。
//
// 它还有一个**结构副作用**，那正是当初 minimal worker 泄漏的成因：该开关让工具改为
// **逐 agent 安装**，而 `restrict()` 只认继承面 ⇒ 那些工具**结构上不可收窄**。
// 所以「不加回来」这件事有两重价值，值得一条专门的断言。
console.log('\n--- 1e. 不许出现 AI 临时指派模型那个开关 ---')

test('C8 ★ 四行委派配置都不得设 modelSelectionSettings（AI 不得临时指派模型）', () => {
  const composition = read(COMPOSITION)
  // 逐行看：注释里出现这个词是**允许**的（本文件与 README 都在解释为什么不设它），
  // 但**代码行**里不许有。判据是「该行不是注释 且 含 modelSelectionSettings: 」。
  for (const raw of composition.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('*') || line.startsWith('//')) continue
    assert(
      !/modelSelectionSettings\s*:/.test(line),
      `composition.mjs 里有一行**代码**设置了 modelSelectionSettings："${line}" —— ` +
        '那会让协调者能在会话里临时指派模型（用户在面板里的设置会被绕过），' +
        '并让那些工具结构上不可收窄。',
    )
  }
})

test('C9 ★ 协调者的保留集里不再有 list_subagent_models（它是那条能力的配套工具）', () => {
  const guard = read(path.join(ROOT, 'presets', 'multitask', 'coordinator-guard.mjs'))
  for (const raw of guard.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('*') || line.startsWith('//')) continue
    assert(
      !/'list_subagent_models'/.test(line),
      `coordinator-guard.mjs 的保留集里又出现了 list_subagent_models："${line}" —— ` +
        '它是「AI 临时指派模型」的配套发现工具，该能力已按用户要求删除',
    )
  }
})

test('B12 ★ 用户面板的模型设置**仍然生效**（删掉的是 AI 那条路，不是这条）', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  // ⚠️ 这一条是上一条的**反向守护**，两者缺一不可：删掉 AI 指派之后，很容易顺手把
  // `workerAgentOptions` 一起当成「模型选择」删掉 —— 那会静默废掉用户面板里那张卡。
  const rows = loaded.composition.buildPlugins({
    modelMap: [
      { subagentType: 'subagent', provider: 'p', model: 'm-a' },
      { subagentType: 'subagent_minimal', provider: 'p', model: 'm-b', reasoningEffort: 'high' },
    ],
  })
  const cfgOf = (id) => {
    const row = findRow(rows, id)
    assert(row !== undefined, `行表里找不到 ${id}`)
    return row.config ?? {}
  }
  const sub = cfgOf('tool-subagent')
  assert(
    sub.agentOptions?.provider === 'p' && sub.agentOptions?.model === 'm-a',
    '用户为 subagent 指定的模型没有变成该行的 agentOptions —— 面板那张卡失效了',
  )
  const min = cfgOf('tool-subagent-minimal')
  assert(
    min.agentOptions?.model === 'm-b' && min.agentOptions?.reasoningEffort === 'high',
    '用户为 minimal 指定的模型/强度没有生效',
  )
  // 没配的类型必须**不带** agentOptions（= 继承协调者），这条语义与之前逐字一致。
  const fork = cfgOf('tool-subagent-fork')
  assert(
    !Object.prototype.hasOwnProperty.call(fork, 'agentOptions'),
    '没有为用户配置的类型不该产生 agentOptions —— 它必须表现为「继承协调者」',
  )
})

test('B13 无参 buildPlugins() 时四行都不带 agentOptions（与加入该功能之前等价）', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  const rows = loaded.composition.buildPlugins(undefined)
  for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-ptc', 'tool-subagent-minimal']) {
    const cfg = findRow(rows, id)?.config ?? {}
    assert(
      !Object.prototype.hasOwnProperty.call(cfg, 'agentOptions'),
      `${id} 在无配置时不该带 agentOptions`,
    )
  }
})

// ── 一之二、运行期核对：本插件不再产生任何并发相关的东西 ────────────────────────
//
// ⚠️ 这一组曾经守着「三道收敛各自的收敛语义」（夹到 8 / 原样采用 / 非法值夹到 1 /
// 缺席即不限制），被测对象是 `concurrency-guard.mjs` 与那两个 `normalizeMaxActive`。
// 它们现在**全都不存在了**，所以那批用例整组删除 —— 留着只会引用已删除的符号。
//
// 现在这里守的是「**产出的行表里没有并发那一行**」以及「字段真的不再被声明」。
// 这是可执行的反向守护：谁把那条链路重建回来（哪怕只是残留一个 id），这里就会红。
console.log('\n--- 1b. 运行期核对（不写任何文件、不起会话）---')

test('B1 ★ buildPlugins() 产出的行表里没有 concurrency-guard 行（删干净了）', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  const ids = allRowIds(loaded.composition.buildPlugins(undefined))
  assert(
    !ids.includes('concurrency-guard'),
    `行表里又出现了 concurrency-guard 行 —— 那意味着并发守卫被重建了。现有 id：${ids.join(', ')}`,
  )
  // 顺带确认那四条委派行与减震器仍在（别把有用的东西一起删掉了）。
  for (const must of ['tool-subagent', 'subagent-mode', 'minimal-guard', 'coordinator-guard']) {
    assert(ids.includes(must), `行表里缺少 ${must} —— 删除并发链路时误伤了别的行`)
  }
})

test('B2 ★ 即使有人传了 maxActiveSubagents，行表里也不会出现并发那一行', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  // 这个入参已经不被 composition 消费了。传它**必须**没有任何后果 ——
  // 若哪天它又能变出一行来，说明旧的接线被接回去了。
  const ids = allRowIds(loaded.composition.buildPlugins({ maxActiveSubagents: 3 }))
  assert(
    !ids.includes('concurrency-guard'),
    'buildPlugins({maxActiveSubagents:3}) 竟然产出了一行 concurrency-guard —— 旧接线被接回去了',
  )
})

test('B3 ★ 宿主半不再导出并发上限的字段名（面板不可能再指向本插件自己的字段）', () => {
  assert(loaded.host !== undefined, 'lib/index.js 没加载成功')
  assert(
    loaded.host.MAX_ACTIVE_FIELD_NAME === undefined,
    'lib/index.js 又导出了 MAX_ACTIVE_FIELD_NAME —— 那个字段已删除',
  )
  // 模型映射那个导出必须还在（它才是本插件唯一保留的设置面）。
  assert(
    typeof loaded.host.MODEL_MAP_FIELD_NAME === 'string',
    'lib/index.js 的 MODEL_MAP_FIELD_NAME 不见了 —— 删并发链路时误伤了模型映射',
  )
})

test('B4 ★ 两个设置字段（subagentModels / watchdog）都带 meta.volatile（面板写它们不得重启插件）', () => {
  assert(loaded.host !== undefined, 'lib/index.js 没加载成功')
  // ⚠️ 为什么这条必须留：漏掉 volatile ⇒ 面板写入被判成普通配置变更 ⇒ **重启本插件**
  // ⇒ 撞上 `mounted` 守卫而不再声明 ⇒ 表现是「Multitask 模式从新会话列表消失」。
  // 两个字段任何一个漏掉都会**单独**炸，所以必须逐个钉住：
  //   · `subagentModels` —— 模型映射那张卡；
  //   · `watchdog` —— 看门狗阈值那张卡（它写的是**整个对象**，一次写错同样重启）。
  const names = [loaded.host.MODEL_MAP_FIELD_NAME, loaded.host.WATCHDOG_FIELD_NAME]
  const validated = loaded.host.Config['~standard'].validate({ subagentModels: [], watchdog: {} })
  for (const name of names) {
    const node = loaded.host.Config.dict?.[name]
    assert(node !== undefined, `Config.dict 里找不到字段节点 ${name}`)
    assert(
      node.meta?.volatile === true,
      `${name} 节点缺少 meta.volatile —— 面板写它会让整份配置被判成普通变更 ⇒ 重启插件`,
    )
    const reference = validated.value[name]
    assert(
      typeof reference?.get === 'function' && Symbol.for('cosmokit.volatile.write') in reference,
      `validate() 必须把 ${name} 换成 volatile 引用（面板的「清空」靠删键表达，读不到当前快照就失效）`,
    )
  }
})

// ── 二、README 与代码一致 ────────────────────────────────────────────────────
console.log('\n--- 2. README 与实现一致 ---')

test('R1 ★ README 的并发一节写明「只有一个值、两处 UI 编辑同一字段」', () => {
  const readme = read(README)
  const start = readme.indexOf('### 子代理并发上限')
  assert(start >= 0, 'README 里找不到「### 子代理并发上限」一节')
  const end = readme.indexOf('\n---', start)
  const section = readme.slice(start, end >= 0 ? end : start + 20000)
  assert(
    /只有一个值/.test(section),
    'README 的并发一节没有写明「只有一个值」—— 这正是本轮改动的结论',
  )
  assert(
    /同一个字段/.test(section),
    'README 没有写明两处 UI 编辑的是**同一个字段**（改一处另一处跟着变）',
  )

  // ⚠️ 反向判据必须**逐行**看，并且允许「更正性叙述」。
  // 这一节要把「早先本插件有自己的字段、那张卡是假的」这件事写下来 —— 那是
  // 一份**纠正记录**，不是待清理的陈旧说法。整节一刀切地禁掉那些字符串会把正确的
  // 文档判红（本仓在 R7 上踩过同一种坑：否定词必须在同一行）。
  const STALE = /multitask\.maxActiveSubagents/
  const CORRECTION = /早先|曾经|旧的|已推翻|那个理由是|错的|不再|不许|删除|是假的/
  for (const raw of section.split('\n')) {
    if (!STALE.test(raw)) continue
    assert(
      CORRECTION.test(raw),
      `README 的并发一节里有一行仍在**当成现行行为**写着已删除的字段："${raw.trim()}" —— ` +
        '用户照着它去 profile 里改那个键不会有任何效果。若是作为「已删除的旧设计」提及，' +
        '请在同一行里带上「早先 / 曾经 / 已删除」这类标记',
    )
  }
})

test('R2 README 引用了宿主那条错误原文（含 active child limit）', () => {
  const readme = read(README)
  assert(
    readme.includes(HOST_ERROR),
    `README 里没有逐字引用宿主的容量错误（"${HOST_ERROR}"）—— 用户撞上它时无法从文档里认出来`,
  )
})

test('R2b ★ README 写明「8 是宿主的默认值、不是天花板」以及怎么改', () => {
  const readme = read(README)
  // 这条是本轮修正的核心事实：8 只是默认值，而「写多少就是多少」的前提是
  // **只有一个执行点**。不写清楚，用户会一直以为是插件在截他。
  assert(
    /默认值.*不是天花板|不是天花板/.test(readme),
    'README 没有写明「8 是宿主的默认值、不是天花板」—— 这正是本轮修正的核心事实',
  )
  assert(
    /写的是多少，上限就是多少|写多少就是多少|写的是多少/.test(readme),
    'README 没有写「写的是多少，上限就是多少」这条承诺',
  )
  assert(
    /id:\s*subagent/.test(readme),
    'README 没有给出改这个值的可操作路径（profile 里给 `- id: subagent` 加 config）',
  )
  // ⚠️ 反向：**不该**再教人去抬「两处」—— 现在只有一个值，说两处会让人以为
  // 还有第二层在截他，而那正是这次改掉的那个假象。
  assert(
    !/两处都抬|抬\s*\*\*两处\*\*/.test(readme),
    'README 里仍写着「要跑更多得抬两处」—— 那个字段已删除，现在只有一个值，' +
      '这句会让用户以为还有另一层在限制他',
  )
})

test('R3 README 解释了「串行跑 N>8 看起来能成功」这个错觉', () => {
  const readme = read(README)
  assert(
    /阻塞\s*\/\s*串行|串行/.test(readme) && /活跃数从未超过\s*1|从未超过\s*1/.test(readme),
    'README 没有解释「串行执行时活跃数从未超过 1」，因此 N>8 看起来能成功这一错觉仍会误导人',
  )
})

test('R4 ★ README 写明计数口径（当前存活的全部，不只是同一批发起的）', () => {
  const readme = read(README)
  const start = readme.indexOf('### 子代理并发上限')
  assert(start >= 0, 'README 里找不到并发一节')
  const section = readme.slice(start, start + 4000)
  // ⚠️ 这条口径是**面板上写着的东西**（「同一主 Agent 下同时存活的子代理总数」），
  // 而它是最容易被误解的一处：用户以为是「同一批发起几个」，实际是「现在活着几个」。
  assert(
    /当前存活/.test(section),
    'README 的并发一节没有写明计数口径是「当前存活」的子代理总数',
  )
  assert(
    /占着名额|仍然占/.test(section),
    'README 没有写明「交完活但还没退出的 worker 仍然占着名额」这个后果',
  )
})

test('R5 ★ README 写明「拒绝来自宿主、这不是插件坏了」', () => {
  const readme = read(README)
  assert(
    /拒绝是\*\*宿主的\*\*|拒绝来自\*\*宿主\*\*|宿主的\*\*，不是本插件的/.test(readme),
    'README 没有写明「撞上限时的拒绝来自宿主」—— 不写清楚，用户会以为是本插件坏了',
  )
  assert(
    /不是本插件坏了|这不是故障/.test(readme),
    'README 没有明确写「这不是故障、也不是本插件坏了」',
  )

  // ⚠️ 反向判据必须**逐行**看，并且允许「更正性叙述」（与 R1 同一条纪律，别在这里
  // 又退回整篇一刀切 —— R1 当初就是这么误报过一次）。
  //
  // ⚠️ 白名单要**够宽**：这一次它漏掉了「曾把取值钉在」（只有「曾」、没有「曾经」），
  // 于是把一句正确的纠正记录判成了现行说法。判据的目的是「这句话有没有在说
  // 『现在就该这么干』」，所以凡是「已删除 / 已推翻 / 先修 / 曾 / 不是」这类
  // 回顾性措辞都该放行 —— 宁可少报一次，也不要让正确的文档无法通过。
  const STALE = /夹到\s*`?8`?|按\s*`?8`?\s*算|钉在\s*8\s*以内|multitask\.maxActiveSubagents/
  const CORRECTION = /早先|曾经|曾|先修|旧的|已推翻|已删除|删除|是假的|不是|不再|不许|不得|意味着|被改回/
  for (const raw of readme.split('\n')) {
    if (!STALE.test(raw)) continue
    assert(
      CORRECTION.test(raw),
      `README 里有一行仍在**当成现行行为**写着旧说法："${raw.trim()}" —— ` +
        '用户照着它去改不会有任何效果。若是作为「已推翻 / 已删除的旧设计」提及，' +
        '请在同一行里带上「早先 / 曾 / 先修 / 不是」这类标记',
    )
  }
})

test('R6 「所有测试文件都必须写进 test/」这条规矩还在（认本机记录）', () => {
  // ⚠️ 判据盯着 `docs/remember.md` 而不是 README：这条规矩讲的是**测试放哪**，而
  // `test/` 被 `.gitignore` 忽略 —— 把这种话写进 README（npm 首页）等于向读者描述
  // 一套他们拿不到的脚本。详见 REMEMBER 常量的注释。
  const remember = readOptionalLocal(REMEMBER)
  if (remember === undefined) {
    console.log('  SKIP  R6（本机记录 docs/remember.md 不在，说明本地专属文档未建立）')
    return
  }
  assert(
    /所有测试文件都必须写进\s*`?test\/?`?/.test(remember),
    'docs/remember.md 缺少「所有测试文件都必须写进 test/」这条规矩（它是本仓库的常驻约定）',
  )
  assert(
    !/所有测试文件都必须写进\s*`?test\/?`?/.test(read(README)),
    'README（会随发布物分发）里又出现了「测试必须写进 test/」这类约定 —— ' +
      '**描述测试的东西只该待在能被测试看见的地方**：读者拿不到 `test/`，写在那里没有意义。' +
      '请把它留在 docs/remember.md。',
  )
})

test('R7 任何文档都不把 verify.mjs 当成一个现存的脚本（那个文件已不存在）', () => {
  // 前提：`verify.mjs` 确实不存在。若哪天它真的被加回来（且落在合法位置），
  // 文档提到它就不再是「陈旧引用」，这条用例自然失去意义 —— 直接跳过，
  // 免得把一份正确的文档判红。
  const exists = [path.join(ROOT, 'verify.mjs'), path.join(ROOT, 'docs', 'test', 'verify.mjs')].some((f) => fs.existsSync(f))
  if (exists) return

  // ⚠️ 范围是**三份文档**（两版 README + 本机记录）：`verify.mjs` 这个词现在只可能出现在
  // 本机记录里，但把它一并纳入判据，是为了挡住「有人把那段历史又抄回 README」。
  // 缺席的文件跳过（本机记录与 `test/` 同进退，可能整份都不在）。
  const targets = [
    ['README.md', path.join(ROOT, 'README.md')],
    ['README.zh.md', README],
    ['docs/remember.md', REMEMBER],
  ]
  // ⚠️ 否定词必须在**同一行**上。早期版本允许「上下两行」的窗口，实测那份写法是
  // **恒真**的：把这段改成 `verify.mjs` 是常驻回归套件（正是本条要挡的陈述）后，
  // 仍然过关 —— 因为文档段落密集，相邻两行里几乎总会碰到「没有 / 不存在」之类的词。
  const NEGATION = /不再存在|不存在|并不存在|没有|曾有|历史|旧备份/
  for (const [label, file] of targets) {
    const text = readOptionalLocal(file)
    if (text === undefined) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('verify.mjs')) continue
      assert(
        NEGATION.test(lines[i]),
        `${label} 里仍有把 verify.mjs 当作现存脚本的说法："${lines[i].trim()}" —— ` +
          '该文件在仓库里与 test/ 下都不存在，现存的回归脚本是 guard-mode-isolation-regression.mjs',
      )
    }
  }
})

// ── 二之二、跨模块常量：两份手抄的标记必须逐字一致 ───────────────────────────
//
// 本仓库的预设模块约定「零 import、常量各自留一份」，代价是改一处必须改两处。
// 这一节就是那个代价的守卫：两份不一致时，PTC 呈现 / 只读收窄会**静默失效**
// （认不出这一行属于哪类 worker = 什么都不做），而那正是最难查的一类坏法。
//
// ⚠️ 标记的载体已经换过一次：旧版本是 persona 里的 `[multitask-mode:…]` 字符串，
// 新版 DSH 删除了委派行的 `persona` 配置项（配置里出现即抛错、整个 preset 挂载失败），
// 所以改成 **provider 名**。这两条断言因此比对 provider 常量。
console.log('\n--- 2b. 跨模块常量一致（手抄两份的代价守卫）---')

test('M1 PTC 的 provider 名在 composition 与 subagent-mode 里逐字一致', () => {
  const markerOf = (source, where) => {
    const match = source.match(/const\s+PTC_PROVIDER\s*=\s*'([^']*)'/)
    assert(match !== null, `${where} 里找不到 PTC_PROVIDER 字面量`)
    return match[1]
  }
  const a = markerOf(read(COMPOSITION), 'composition.mjs')
  const b = markerOf(read(SUBAGENT_MODE), 'subagent-mode.mjs')
  assert(
    a === b,
    `PTC_PROVIDER 不同步：composition.mjs="${a}"，subagent-mode.mjs="${b}" —— ` +
      '这会让 PTC 呈现静默失效（认不出 provider 名 = 什么都不做）',
  )
})

test('M2 minimal 的 provider 名在 composition 与 minimal-guard 里逐字一致', () => {
  const markerOf = (source, where) => {
    const match = source.match(/const\s+MINIMAL_PROVIDER\s*=\s*'([^']*)'/)
    assert(match !== null, `${where} 里找不到 MINIMAL_PROVIDER 字面量`)
    return match[1]
  }
  const a = markerOf(read(COMPOSITION), 'composition.mjs')
  const b = markerOf(read(MINIMAL_GUARD), 'minimal-guard.mjs')
  assert(
    a === b,
    `MINIMAL_PROVIDER 不同步：composition.mjs="${a}"，minimal-guard.mjs="${b}" —— ` +
      '这会让只读收窄静默失效（认不出 provider 名 = 完全不收窄）',
  )
})

// ── 二之三、新契约：委派行只许用 provider 名作类型标记 ─────────────────────────
//
// ⚠️ 这一节守的是**一次上游删除**，值得把来龙去脉写下来：
//
// DSH 0.2.1-rc.2 的 `dsh-tool-subagent` 删除了 `persona` / `toolFilter` /
// `backgroundMode` 三个配置项，而且**不是静默忽略** —— `apply()` 开头逐字抛
//
//     tool-subagent: persona is no longer supported; configure persona and tool plugins
//     in an Agent Preset and select it with agentPreset (spawn only)
//
// 后果是**整个 preset 挂载失败**，模式从新会话选择器里彻底消失。这一条极容易在
// 「补一句人格 / 加一条工具收窄」时被人手写回去（两者都是当初很有用的字段），
// 所以必须由测试挡住，而不是靠人记得。
console.log('\n--- 2c-bis. 新契约：委派行只许用 provider 名（已删字段不许回来）---')

test('M6 ★ 四行委派配置都不得再出现 persona / toolFilter / backgroundMode', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  const rows = loaded.composition.buildPlugins(undefined)
  const removed = ['persona', 'toolFilter', 'backgroundMode']
  const offenders = []
  const walk = (list) => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue
      const config = row.config
      if (config !== undefined && config !== null && !Array.isArray(config)) {
        for (const field of removed) {
          if (Object.prototype.hasOwnProperty.call(config, field)) offenders.push(`${row.id}.${field}`)
        }
      }
      if (Array.isArray(config)) walk(config)
    }
  }
  walk(rows)
  assert(
    offenders.length === 0,
    `以下行仍在使用新版已删除的字段：${offenders.join(', ')} —— ` +
      '它们会让整个 preset 挂载失败（tool-subagent 见到 persona 即抛错），模式会从选择器里消失',
  )
})

test('M7 ★ 每类 worker 的 provider 名与人格注入表逐字对齐', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  const rows = loaded.composition.buildPlugins(undefined)
  const personaRow = findRow(rows, 'worker-persona')
  assert(personaRow !== undefined, 'composition 里找不到 worker-persona 行 —— 人格不会被注入')
  const personas = personaRow.config?.personas
  assert(
    personas !== undefined && personas !== null && typeof personas === 'object',
    'worker-persona 行没有 config.personas —— 人格表缺失',
  )

  // composition 导出的映射是唯一真源；行表里的 provider 必须与它一致。
  const providers = loaded.composition.WORKER_PROVIDERS
  assert(providers !== undefined, 'composition 没有导出 WORKER_PROVIDERS')
  for (const [type, provider] of Object.entries(providers)) {
    const rowId = `tool-subagent${type === 'subagent' ? '' : `-${type.replace('subagent_', '')}`}`
    const row = findRow(rows, rowId)
    assert(row !== undefined, `行表里找不到 ${rowId}（类型 ${type}）`)
    assert(
      row.config?.provider === provider,
      `${rowId} 的 provider 是 ${JSON.stringify(row.config?.provider)}，` +
        `但 WORKER_PROVIDERS 说应当是 ${JSON.stringify(provider)} —— 守卫会认不出这个 worker`,
    )
    assert(
      Object.prototype.hasOwnProperty.call(personas, provider),
      `人格表里没有 provider "${provider}"（${type}）—— 那个 worker 会拿着协调者人格去干活`,
    )
  }
})

test('M8 ★ 两个自建 provider 名都在宿主半的注册清单里', () => {
  // ⚠️ 判据必须落在**真正注册 provider 的那个模块**上，而且必须解析**数组字面量**。
  // 曾经的写法是「在 `lib/index.js` 里搜 `multitask_ptc`」—— 那是**恒真**的：
  // 该文件里这个名字只出现在一行注释（「注册两类 worker 的 provider：`multitask_ptc` …」），
  // 所以哪怕把注册清单整个清空，断言照样通过。实测反向验证时它没变红，才暴露出来。
  const host = read(HOST_HALF)
  const providerModule = read(PROVIDER_MODULE)

  // ① 宿主半必须真的委派给那个模块（否则模块写得再对也不会被调用）。
  assert(
    /registerWorkerProviders\s*\(\s*ctx/.test(host) || /registerWorkerProviders\(ctx/.test(host),
    '宿主半没有调用 registerWorkerProviders(ctx, …) —— 两个自建 provider 根本不会被注册',
  )

  // ② 注册清单本身：从数组字面量里解析，而不是在整份文件里搜字符串。
  const literal = providerModule.match(/WORKER_PROVIDER_NAMES\s*=\s*\[([^\]]*)\]/)
  assert(literal !== null, 'worker-providers.js 里找不到 WORKER_PROVIDER_NAMES 的数组字面量')
  const registered = [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert(
    registered.length > 0,
    'WORKER_PROVIDER_NAMES 是空数组 —— 两个委派工具都不会出现（tool-subagent 等 provider 出现才注册）',
  )

  for (const provider of ['multitask_ptc', 'multitask_minimal']) {
    assert(
      registered.includes(provider),
      `注册清单里没有 "${provider}"（实际：${JSON.stringify(registered)}）—— ` +
        '那条委派工具会根本不出现，模式静默降级成「只有两条委派路径」',
    )
  }

  // ③ 内置的两个名字**绝不能**被本包重复注册：注册表对重名是硬拒绝（DUPLICATE_PROVIDER），
  //    抛出位置在本插件的 apply 里，等于整个插件起不来。判据同样只看**数组元素**，
  //    不看注释（文件头必须提到 spawn / fork 才能解释为什么不能注册它们）。
  for (const builtin of ['spawn', 'fork']) {
    assert(
      !registered.includes(builtin),
      `注册清单里出现了内置 provider 名 "${builtin}" —— 重复注册会撞 DUPLICATE_PROVIDER，本插件整个起不来`,
    )
  }
})

// ── 2c-bis-2、跨模式派发：工具名与保留集必须逐字对齐 ─────────────────────────
//
// 这两条守的是一件很容易「改一处、静默失效」的事：
//
//   · `preset-dispatch.mjs` 注册的工具名，必须与 `composition.mjs` 给协调者保留集
//     （`coordinator-guard` 的 `keep`）里那一项**逐字相同**。差一个字符，协调者就
//     **看不见**这个工具 —— 保留集是白名单，`deny = 可见集 − 保留集`，没写进去的一律
//     被摘掉。而「工具不见了」在会话里表现为「模型不会用」，不会报任何错。
//   · 派发行本身必须真的挂进 composition，且**不受** `DSH_MULTITASK_MULTI_MODE` 门控：
//     跨模式派发与本模式内部的 ptc / minimal 两类 worker 不是同一件事，被那个开关连带
//     关掉是设计事故。
console.log('\n--- 2c-bis-2. 跨模式派发：工具名与保留集逐字对齐 ---')

test('M9 ★ subagent_preset 的工具名与协调者保留集逐字一致', () => {
  const dispatch = read(DISPATCH)
  const literal = dispatch.match(/export const TOOL_NAME = '([^']+)'/)
  assert(literal !== null, 'preset-dispatch.mjs 里找不到 TOOL_NAME 的字面量')
  const toolName = literal[1]

  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  const rows = loaded.composition.buildPlugins(undefined)
  const guard = findRow(rows, 'coordinator-guard')
  assert(guard !== undefined, '行表里找不到 coordinator-guard')
  const keep = Array.isArray(guard.config?.keep) ? guard.config.keep : []
  assert(
    keep.includes(toolName),
    `协调者保留集里没有 "${toolName}"（实际：${JSON.stringify(keep)}）—— ` +
      '保留集是白名单，没写进去的工具会被减震器摘掉，协调者根本看不见跨模式派发',
  )
})

test('M10 ★ preset-dispatch 行挂在组合里，且不在多模式开关的分支内', () => {
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')
  const rows = loaded.composition.buildPlugins(undefined)
  const row = findRow(rows, 'preset-dispatch')
  assert(
    row !== undefined,
    '行表里找不到 preset-dispatch —— 跨模式派发整个不存在，而 README 会继续说它有',
  )
  assert(
    typeof row.name === 'string' && row.name.startsWith('file://') && row.name.includes('preset-dispatch.mjs'),
    `preset-dispatch 行的 name 不是指向本文件的 file:// URL（实际：${JSON.stringify(row.name)}）—— ` +
      '相对名会被解析到 profile 根，模块根本加载不起来',
  )

  // ── 它必须**不在** `...(MULTI_MODE_ENABLED ? [...] : [])` 这个分支里 ──
  //
  // ⚠️ 这里刻意**不用** `buildPlugins({ multiMode: false })` 那种写法：该开关只读
  // `process.env.DSH_MULTITASK_MULTI_MODE`（模块求值时读一次），传一个同名 option
  // 完全是空操作 —— 那样的断言是**恒真**的，什么也守不住。实测踩过这个坑。
  //
  // 所以判据落在**源码结构**上：算出那个条件展开的三元区间，断言本行不在其中。
  const source = read(COMPOSITION)
  const branchStart = source.indexOf('...(MULTI_MODE_ENABLED ? [')
  assert(branchStart >= 0, 'composition.mjs 里找不到 MULTI_MODE_ENABLED 的条件展开 —— 判据需同步更新')
  const branchEnd = source.indexOf('] : [])', branchStart)
  assert(branchEnd > branchStart, 'MULTI_MODE_ENABLED 条件展开的收尾标记找不到 —— 判据需同步更新')
  const dispatchIndex = source.indexOf("id: 'preset-dispatch'")
  assert(dispatchIndex >= 0, 'composition.mjs 里找不到 preset-dispatch 行')
  assert(
    dispatchIndex < branchStart || dispatchIndex > branchEnd,
    'preset-dispatch 被放进了 MULTI_MODE_ENABLED 的分支里 —— 跨模式派发与本模式内部的 ' +
      'ptc / minimal 两类 worker 是彼此独立的能力，关掉多模式开关不该连带关掉它',
  )
})

// ── 2c-bis-3、提示词变量必须已注册（1.2.9 发版后立刻炸出来的那个错）────────────
//
// 这一条守的是一个**每一轮都失败**的致命错误，值得把事故经过写在这里：
//
// composition.mjs 的 persona 行曾写着
//     suffix: 'Your working directory is {{cwd}}.'
// 而新版 DSH 的 `@deepseek-ai/dsh-agent-loop` 只注册了两个提示词变量：
//     ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider)
//     ctx.systemPrompt.variable("model",    (context) => context.agent?.options.model)
// 全 asar 里**没有任何模块**注册 `cwd`。于是 `dsh-system-prompt` 的 `interpolate()`
// 在渲染 `deployment:persona-suffix` 时抛：
//     unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
//     registered variables: provider, model
// 症状不是「某个功能不灵」，而是**每一轮运行都失败**。
//
// 危害在于它的隐蔽性：那个后缀从最初提交就存在，但更早时整个 preset 因为
// `persona` 字段被上游删除而**根本挂载不上**，所以这段渲染代码从来没被执行过 ——
// 挂载修好后它才第一次运行，问题才暴露。也就是说「静态检查通过」不等于「能跑」，
// 而这一条断言至少能把「引用了不存在的变量」变成提交前就变红的失败。
console.log('\n--- 2c-bis-3. 提示词变量必须已注册（否则每轮都炸）---')

test('M11 ★ 组合里的 {{变量}} 只许用 provider / model（其余会每轮渲染失败）', () => {
  // 允许集 = 上游 `dsh-agent-loop` 实际注册的两个。
  // ⚠️ 上游以后新增变量时，这里要跟着更新；否则会把合法写法误判成错误。
  const REGISTERED = ['provider', 'model']
  const source = read(COMPOSITION)

  // ⚠️ **必须先剥掉注释再匹配。**
  //
  // 第一版直接对全文匹配，结果被自己的说明注释绊倒：`persona` 行上方那段注释里
  // 为了记录事故原文写了 `suffix: 'Your working directory is {{cwd}}.'` 和上游的
  // 报错文本，于是守卫把「注释里提到的坏写法」当成了「代码里的坏写法」，永远红。
  // 这类假阳性比漏报更糟：红了之后人会去改断言，而不是改问题。
  //
  // 剥法：`/* … */` 整块删掉，再逐行删掉 `//` 之后的部分。本文件的行都是单行配置
  // 或模板字符串，不含需要保留的注释内代码，所以这个简化是安全的。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at >= 0 ? line.slice(0, at) : line
    })
    .join('\n')

  const used = [...new Set([...code.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]))]

  assert(
    used.length > 0,
    '剥掉注释后组合里一个提示词变量都没解析出来 —— 判据可能已失效（例如文本被改写）',
  )

  const unknown = used.filter((name) => !REGISTERED.includes(name))
  assert(
    unknown.length === 0,
    `组合引用了未注册的提示词变量：${unknown.map((n) => `{{${n}}}`).join(', ')} —— ` +
      `上游只注册了 ${REGISTERED.map((n) => `{{${n}}}`).join(' / ')}。` +
      '引用其余的会让**每一轮提示词组装都抛错**（unknown prompt variable），' +
      '整轮运行直接失败，而不是某个功能失效。' +
      '需要工作目录这类信息时，用上游 `dsh-working-directory` 提供的运行时上下文，不要在 persona 里写变量。',
  )
})

test('M12 ★ 五份人格都带有「会被中途打断」与「卡住要停」两节', () => {
  // ── 这一条守的是什么 ──────────────────────────────────────────────────────
  //
  // 这两节是**纯提示词**，没有任何运行时机制会因为它们的缺席而报错。删掉它们，
  // 回归照样全绿 —— 它们唯一的守卫就是这条断言。所以必须钉住，否则下一次「精简
  // 人格」时它们会静默消失，而那两种失效都是真实发生过的：
  //
  //   1. worker 不知道协调者会中途掐断它，于是把新指令读成「我搞砸了」，**从头重做**
  //      —— 而它其实保留着全部已建立的上下文（打断只丢进行中的那一个动作）。
  //   2. worker 陷进同一个构造（典型是 `A ? { … } : { … }` 的花括号增生）后不肯停，
  //      反复改到协调者的时间被耗光；它本该报出来让协调者**换一个新 worker**。
  //
  // ⚠️ 判据只查小节标题，不查内文：内文是该按各 worker 机制改写的（PTC 要讲
  // 「被掐掉的程序不交回没打印的东西」、minimal 要讲「两次搜不到就该报」），
  // 逐字比对会让合理的改写变红。标题是「这一节还在」的最小可靠信号。
  assert(loaded.composition !== undefined, 'composition.mjs 没加载成功')

  const WORKERS = [
    'WORKER_PERSONA',
    'FORK_PERSONA',
    'PTC_WORKER_PERSONA',
    'MINIMAL_WORKER_PERSONA',
  ]
  for (const name of WORKERS) {
    const text = loaded.composition[name]
    assert(typeof text === 'string' && text !== '', `composition 里没有导出 ${name}`)
    assert(
      text.includes('## The coordinator may interrupt you mid-turn'),
      `${name} 缺少「会被中途打断」那一节 —— ` +
        'worker 会把协调者的纠错读成自己犯错，于是从头重做（实测过的失效）',
    )
    assert(
      text.includes('## Stop before you thrash'),
      `${name} 缺少「卡住就停」那一节 —— ` +
        'worker 会陷在同一个构造里反复改，而正确出路是报出来让协调者换一个新 worker',
    )
  }

  // 协调者那一侧是配套的：worker 报「卡住」时，处置必须是**换人**而不是加压。
  const coordinator = loaded.composition.COORDINATOR_PERSONA
  assert(typeof coordinator === 'string' && coordinator !== '', 'composition 里没有导出 COORDINATOR_PERSONA')
  assert(
    coordinator.includes('## When a worker reports that it is stuck'),
    'COORDINATOR_PERSONA 缺少「worker 报告卡住时怎么处置」那一节 —— ' +
      '配套的 worker 已经会报告了，但协调者不知道要换人，于是会给同一个 worker 发「再试一次」',
  )
  assert(
    coordinator.includes('## Intervening in a running worker'),
    'COORDINATOR_PERSONA 缺少「中途插手」那一节 —— 与 interrupt-before-send 的机制不配套',
  )
})

test('M13 ★ 四路选择必须按形状判断，且旧的「拿不准就用 subagent」不许回来', () => {
  // ── 这条守的是什么 ────────────────────────────────────────────────────────
  //
  // 实测的委派分布（仅主会话 · 按 `callId` 去重 · 按**委派发生那一刻**的人格版本归组，
  // 见 `test/measure-delegation.mjs`）：旧人格下 `subagent` 432/657 = **65.8%**，
  // `subagent_minimal` 159、`subagent_ptc` 27、`subagent_fork` 25、`subagent_preset` 14。
  //
  // ⚠️ 这里曾经写的是「260/341 = 80%」。那个数按会话 header 的 `agentPreset` 过滤，
  // 漏掉了 13 个 header 写着 `standard`、中途被切到 multitask 之后又发了 326 次委派的
  // 会话。口径漏报的地方就是这里，别把那两个数相减。
  //
  // 于是这个模式存在的理由（「不同工具面下同一模型的推理表现不同，所以按任务挑面」）
  // 实际上没有兑现：另外三条路基本是装饰。
  //
  // 原因在提示词里，而且是可以精确定位的一句：旧版结尾写着
  //   "When in doubt, use **subagent**."
  // 那是一句**默认回退指令** —— 模型在每次拿不准时都被它推向最宽的那条路，
  // 于是「按形状挑」的整段说明被这一句抵消掉了。
  //
  // 所以这条断言有两个方向：
  //   ① 正向：决策依据必须**按任务形状**给（不是按主题、不是按习惯）；
  //   ② 反向：那句默认回退不许回来。它回来了，其余判据都会重新失效。
  const coordinator = loaded.composition.COORDINATOR_PERSONA
  assert(typeof coordinator === 'string' && coordinator !== '', 'composition 里没有导出 COORDINATOR_PERSONA')

  // ① 正向：四路各自的适用形状都要在场，且必须点明「按形状而非主题」。
  assert(
    coordinator.includes('Match the SHAPE of the task'),
    'COORDINATOR_PERSONA 缺少「按任务形状挑 worker」的判据 —— ' +
      '退回按主题/习惯挑会把 65.8% 的老比例守住，其余三条路继续当装饰',
  )
  for (const path of ['subagent_minimal', 'subagent_ptc', 'subagent', 'subagent_fork']) {
    assert(
      coordinator.includes(path),
      `COORDINATOR_PERSONA 没有提到 ${path} —— 少一条路等于把它从选项里删掉`,
    )
  }
  // 两条「模糊时怎么定」的判据，各自能独立推翻一个常见误选。
  assert(
    coordinator.includes('Does anything need to be MUTATED'),
    '缺少「要不要改东西」这条判据 —— 纯读取任务会被推到 subagent，那是本模式最大的浪费',
  )
  assert(
    coordinator.includes('Is the work a LOOP over data'),
    '缺少「是不是对数据做循环」这条判据 —— 批量任务会被拆成几十次单调用，上下文成本翻倍',
  )

  // ② 反向：默认回退指令不许回来。
  assert(
    !/When in doubt, use \*\*subagent\*\*/.test(coordinator),
    'COORDINATOR_PERSONA 里又出现了 "When in doubt, use **subagent**" —— ' +
      '那是一句默认回退指令，会把「按形状挑」的整段说明抵消掉，' +
      '实测后果就是旧人格下 65.8% 的委派挤在 subagent 上。要表达「判断权归你」，' +
      '应当说「每次都要回答哪个更合适」，而不是给一个默认答案',
  )

  // ③ 跨模式那条：必须点明 `subagent` 拿不到别的模式，只有 `subagent_preset` 能。
  assert(
    coordinator.includes('This is the ONLY way to get a worker that is not a Multitask worker'),
    'COORDINATOR_PERSONA 没有说明「只有 subagent_preset 能拿到非 Multitask worker」—— ' +
      '用户点名某个模式时，模型会用 subagent 搪塞过去，而那是同一个模式换了套工具面',
  )
  // ④ 用户点名的模式是指令，不是提示。
  assert(
    coordinator.includes('that is an instruction, not a hint'),
    'COORDINATOR_PERSONA 没有写「用户点名的模式是指令」—— ' +
      '这会让「用 standard 做这件事」被静默实现成 subagent',
  )

  // ⑤ README 的两张表也必须按形状描述，且不许把那句默认回退写回来。
  //
  // 人格与 README 是两份独立写给读者看的说明，但它们描述的是同一个决策。README 里
  // 留着「拿不准就用 subagent」会让用户以为默认答案是 subagent，从而在任务书里
  // 主动这么要求 —— 那正好把人格拉回旧行为。两处必须同时改。
  for (const [label, text] of [
    ['README.md', read(README_EN)],
    ['README.zh.md', read(README)],
  ]) {
    assert(
      !/When in doubt, use `subagent`|拿不准用 `subagent`|拿不准就用 `subagent`/.test(text),
      `${label} 里还留着「拿不准就用 subagent」—— 人格里这句已删除，README 留着会让用户按旧默认写任务书`,
    )
  }
  assert(
    read(README_EN).includes('Pick by the shape of the task'),
    'README.md 没有写「按任务形状挑 worker」—— 英文版仍在暗示 subagent 是默认答案',
  )
  assert(
    read(README).includes('按任务的形状挑'),
    'README.zh.md 没有写「按任务形状挑 worker」—— 中文版仍在暗示 subagent 是默认答案',
  )
})

test('M14 ★ 会写文件的 worker 必须知道「一次回复的输出上限」，且不许把 max-tokens 说成上下文耗尽', () => {
  // ── 这条守的是什么 ────────────────────────────────────────────────────────
  //
  // 2026-10-21 11:12 实测的一例：一个 worker 连续四步**整份重写**同一张样式表，
  // 单条消息从 32,787 字符涨到 108,291 字符，最后一步输出正好撞到 **32,768 tokens**，
  // `turn/end` 的 reason 是 `max-tokens`，回合就此结束、没有续轮。
  //
  // 三件事同时成立，而它们看起来互相矛盾：
  //   · 它的 `contextWindow` 是 **1,000,000**；
  //   · 它死时上下文只用了 **100,254 tokens = 10%**；
  //   · 结束原因是 `max-tokens`，不是上下文超限。
  //
  // 所以这是**单次输出的上限**，不是上下文耗尽。这个区分不是措辞问题：
  // 按「上下文耗尽」去处置会缩短阅读清单（无效，因为阅读没占多少），
  // 而真正的修法是把**写入**拆开。
  //
  // 协调者当时对用户报的正是「Worker 上下文耗尽」，一句话把两个方向都带偏了。
  // 这条断言把两侧都钉住：worker 要知道上限并在写之前就拆，协调者要知道
  // `max-tokens` 不等于上下文耗尽、且任务书要按写入量拆。
  const CEILING = '32,768'

  // ① 能写文件的 worker：必须带这一节，且必须点明上限与 max-tokens。
  for (const name of ['WORKER_PERSONA', 'FORK_PERSONA', 'PTC_WORKER_PERSONA']) {
    const text = loaded.composition[name]
    assert(typeof text === 'string' && text !== '', `composition 里没有导出 ${name}`)
    assert(
      text.includes('Never emit a whole large file'),
      `${name} 缺少「一次回复别吐整份大文件」那一节 —— ` +
        '这个 worker 能写文件，就会撞 32,768 的输出上限，而症状看起来像崩溃',
    )
    assert(
      text.includes(CEILING),
      `${name} 没有写出实测的上限 ${CEILING} —— 不给数字，模型只会把它当成「尽量不要」的软建议`,
    )
    assert(
      text.includes('max-tokens'),
      `${name} 没有点名 \`max-tokens\` 这个结束原因 —— ` +
        'worker 认不出这个原因就会把截断读成自己的方法错了，于是换一种写法重来，而不是从断点续写',
    )
  }

  // ② 只读 worker 不该有这一节：它不写文件，多写一条反而稀释它真正的约束。
  const minimal = loaded.composition.MINIMAL_WORKER_PERSONA
  assert(
    !minimal.includes('Never emit a whole large file'),
    'MINIMAL_WORKER_PERSONA 里出现了输出上限那一节 —— 它是只读 worker，' +
      '这条对它没有可执行的落点，只会稀释「读不到就说读不到」',
  )

  // ③ 协调者：任务书要按写入量拆，且不许把 max-tokens 报成上下文耗尽。
  const coordinator = loaded.composition.COORDINATOR_PERSONA
  assert(
    coordinator.includes(CEILING),
    `COORDINATOR_PERSONA 没有提到 ${CEILING} —— 它写任务书时会把「重做整份样式表」当成一件事派出去`,
  )
  assert(
    coordinator.includes('is NOT context exhaustion'),
    'COORDINATOR_PERSONA 没有区分「输出上限」与「上下文耗尽」—— ' +
      '实测协调者对被截断的 worker 报的原话是「Worker 上下文耗尽」，' +
      '那句把用户和后续处置都带偏了：真正的修法是拆写入，不是缩短阅读',
  )
})

// ── 2c. approval-gate 的静态约束 ─────────────────────────────────────────────
//
// 这三条锁的是「改一处、坏一片」的三个位置。它们都不是风格问题，各有确切的坏后果：
//
//   1. **`subagent:delegation` 的条目名** —— 改写靠这个名字定位那条 context。名字漂了
//      就等于**静默不改**，而后果是模型继续自我审查、第二级闸门永远等不到请求
//      （连日志都不会有，因为「没找到」与「不需要改」在代码里是同一个分支）。
//   2. **`approval/policy` 必须省略 `source`** —— 事件校验只允许 `source: 'delegation'`，
//      带上它会让 `session.append` 直接抛错，而那时正在创建会话。
//   3. **`ask` 决策的三个字段** —— `kind` 写错会让上游把它当成未知决定；少了
//      `displayReason` 面板就没有本地化文案。
console.log('\n--- 2c. approval-gate 的静态约束（名字漂了就静默失效）---')

test('M3 改写定位用的条目名与上游逐字一致（spelling 漂了就静默不改）', () => {
  const gate = read(APPROVAL_GATE)
  // 定位上游那条委派上下文的条目名（`dsh-subagent` 的 applyChildComposition 里逐字写的）。
  assert(
    gate.includes("entry?.name !== 'subagent:delegation'"),
    'approval-gate.mjs 里找不到对条目名 "subagent:delegation" 的判定 —— ' +
      '这个名字是定位上游那条委派上下文的唯一依据，写错就等于静默不改写',
  )
  // 纠错依据的那句原话（上游 SUBAGENT_DELEGATION_CONTEXT 里逐字存在的片段）。
  assert(
    gate.includes('operations that require approval are rejected automatically'),
    'approval-gate.mjs 里找不到用来识别原话的片段 —— ' +
      '没有它就无法判断「这条文本是否仍然误导」，改写会退化成盲改',
  )
})

test('M4 approval/policy 的写入省略 source（结论对，理由需如实）', () => {
  const gate = read(APPROVAL_GATE)
  const call = gate.match(/session\.append\('approval\/policy',\s*\{[^}]*\}\)/)
  assert(call !== null, 'approval-gate.mjs 里找不到 approval/policy 的写入调用')
  // 结论：仍然**必须省略** `source` —— 但理由不是「校验只允许 delegation」（那是错的，
  // 运行期根本不校验它），而是「`source: 'delegation'` 表示从父级委派继承而来，
  // 而本模块做的恰恰是纠正委派的钉死，带上就是说反话」。
  assert(
    !call[0].includes('source'),
    'approval/policy 的写入带上了 source 字段 —— 运行期虽不校验它，但 ' +
      'source: "delegation" 的语义是「从父级委派继承而来」，而本模块做的是纠正委派钉死，' +
      `带上就是说反话。实际写法：${call[0]}`,
  )
  // 防复发：那句错的理由（「校验只允许 delegation」）不许再出现在代码或注释里。
  assert(
    !/校验只允许|only\s+permits?\s+`?source/i.test(gate),
    'approval-gate.mjs 里又出现了「校验只允许 source: delegation」这个**不准确**的说法 —— ' +
      '核实结果：运行期完全不校验 source；该规则只在 v0/v1 旧格式迁移期生效，当前格式是 v4',
  )
})

test('M4b 兜底通知的调用在 await 下游**之前**（挂起时它才发得出去）', () => {
  const gate = read(APPROVAL_GATE)
  // ⚠️ 必须把范围**收窄到 C2 段落**：`const downstream = await next()` 这个形状在第一级
  // （`tools/pre-execute`）里也有一处，它在文件顺序上早于通知调用 —— 全文搜索会误报。
  const relayAt = gate.indexOf("if (config?.relay !== false) {")
  assert(relayAt >= 0, 'approval-gate.mjs 里找不到 C2 转呈段落（if (config?.relay !== false)）')
  const relay = gate.slice(relayAt)

  // ⚠️ 这里**不能**要求 `void` 前缀：本次改动起，通知的返回值被用来判断「是否有东西会去唤醒
  // 父会话」，所以它现在是 `const notice = …`（一个未 await 的 promise）。判据因此放宽到
  // 「调用本身」，而它**是否被 await 在 next() 之前**由下面两条断言分别钉住。
  const notifyAt = relay.indexOf('notifyRelayFailure(')
  assert(notifyAt >= 0, 'C2 段落里找不到兜底通知的调用（notifyRelayFailure）')

  // ⚠️ 范围还必须再收窄到**通知所在的那个 catch 块**：C2 的 `try` 里有若干早退路径
  // （非子代理 / 父会话不是 ask / 服务缺失），它们各自 `return await next()` ——
  // 那些都在 notify 之前，但与「通知的顺序」毫无关系，全文或整段扫描都会误报。
  const catchAt = relay.lastIndexOf('} catch (error) {', notifyAt)
  assert(
    catchAt >= 0 && catchAt < notifyAt,
    '兜底通知不在 C2 的 catch 块里 —— 形状变了，请人工核对（它必须只在**转呈失败**时才发）',
  )
  const catchBlock = relay.slice(catchAt, notifyAt)

  // ⚠️ 检查前必须先剥掉 `//` 注释：这段注释里**引用了** `return await next()` 这个字面量
  // 来解释早退路径，直接对原文做正则会把注释当成代码 —— 这正是本条守卫第一版误报的原因。
  const code = catchBlock.replace(/\/\/[^\n]*/g, '')

  // catch 块内、通知之前不许出现 `await next()`。
  //
  // 兜底要解决的正是「下游永不返回」：转呈失败后下游会把请求发给浏览器，客户端为那个
  // **不可见**的子会话物化作用域并接住它，而审批路径没有任何超时 —— 那次 await 永远
  // 不返回。若通知排在它之后，恰好在最需要它的场景里它永远发不出去。
  assert(
    !/await\s+next\(\)/.test(code),
    'C2 的 catch 块里，兜底通知**之前**出现了一次 `await next()` —— ' +
      '说明通知被挪到了下游之后，而下游可能无限挂起（客户端接住请求且审批无超时），' +
      '那样通知就永远发不出去。通知必须在 await 之前启动。',
  )

  // 通知之后必须仍然退回下游（fail-closed 的性质不能丢）。
  const afterNotify = relay.slice(notifyAt)
  assert(
    /return\s+await\s+next\(\)/.test(afterNotify),
    'C2 段落的兜底通知之后找不到 `return await next()` —— 转呈失败必须退回原路径',
  )
})

test('M5 第一级的 ask 决策带齐 kind / reason / displayReason（建议，非必需）', () => {
  const gate = read(APPROVAL_GATE)
  const anchor = gate.match(/return\s*\{\s*\n\s*kind:\s*'ask',/)
  assert(anchor !== null, 'approval-gate.mjs 里找不到第一级的 ask 决策字面量')

  // ⚠️ 这里用**花括号配对**取整块，而不是「从这里往后 N 个字符」。
  // 最初写的是固定 700 字符窗口，只要有人给 displayReason 补一句说明（那是好事）
  // 窗口就装不下收尾的 `}`，于是这条断言报「找不到字面量」—— 一个**因为改进而失败**的
  // 假红。配对取块的代价是多十几行，换来的是它不再对字数敏感。
  const start = anchor.index + anchor[0].indexOf('{')
  let depth = 0
  let end = -1
  for (let i = start; i < gate.length; i += 1) {
    if (gate[i] === '{') depth += 1
    else if (gate[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert(end !== -1, 'ask 决策的花括号没有配对 —— 源码本身可能是坏的')
  const decision = gate.slice(start, end + 1)

  assert(decision.includes("kind: 'ask'"), 'ask 决策没有 kind: \'ask\'')
  // ⚠️ `reason` 与 `displayReason` 在类型上都是**可选**的（`{ kind: 'ask'; reason?: string;
  // displayReason?: {...} }`），客户端在缺 `displayReason` 时会回落到 `reason`。
  // 所以这里断言的是**本模块自己的最佳实践**（官方 Auto 也总是两个一起给），
  // 而不是「不带就坏」—— 别把这条读成上游的硬约束。
  assert(decision.includes('reason'), 'ask 决策缺少 reason（写进 durable 审计，强烈建议带上）')
  assert(
    decision.includes('displayReason'),
    'ask 决策缺少 displayReason —— 面板会回落到 reason（不是坏了，但用户看不到本地化文案）',
  )
  // 文档里不许再把它写成硬约束。
  const readme = read(README)
  assert(
    !/reason.*必需|必需.*reason|displayReason.*必需|必需.*displayReason/.test(readme),
    'README 把 reason / displayReason 写成了「必需」—— 它们在类型上都是可选的',
  )
})

test('M5b ★ 持久事件的三类 reason 前缀逐字在位（文档的核对方法依赖它们）', () => {
  // ── 为什么值得单开一条 ────────────────────────────────────────────────────
  //
  // 实测（2026-10-20 全量扫描 718 个会话 / 789 MB）确证：`ctx.logger` 在本部署**不落盘**
  // （非消息类事件里 warn 前缀 0 条、info 前缀 16 条且全是对话中回显的源码）。
  // 于是 `MULTITASK-*` 标识在实际环境里**无法用来核对**，唯一可靠的观测通道是持久的
  // `approval/asked` / `approval/decided` 事件 —— 而那条通道的判据是**理由文本的前缀**。
  //
  // 所以这些前缀一旦漂移，DESIGN.md 与 remember.md 里教的核对方法就会静默失效：
  // 读者按文档去分第一级 / 第二级 / 自动审查，会一条都分不出来，而且**不会有任何报错**。
  // 这正是「文档里的可观测性承诺」最容易被悄悄破坏的那一类。
  const gate = read(APPROVAL_GATE)
  const composition = read(COMPOSITION)

  // 第一级：`${ASK_REASON_PREFIX} flagged …` —— 常量定义在模板里。
  assert(
    /const ASK_REASON_PREFIX = 'Multitask approval gate'/.test(gate),
    'ASK_REASON_PREFIX 不再是 "Multitask approval gate" —— 文档按这个前缀区分第一级',
  )
  assert(
    /flagged \$\{hit\.kind === 'shell' \? 'a destructive shell command' : 'a write outside the workspace'\}/.test(gate),
    '第一级的理由不再带 "flagged a destructive shell command / a write outside the workspace" —— 文档按它区分第一级',
  )

  // 第二级：`${ASK_REASON_PREFIX}: a delegated Subagent (……) asked to run "……"`。
  assert(
    /a delegated Subagent \(\$\{String\(id\)\.slice\(0, 8\)\}\) asked to run "\$\{name\}"/.test(gate),
    '第二级转呈的理由文本变了 —— 文档按 "Multitask approval gate: a delegated Subagent" 区分它',
  )

  // 自动审查那一类不是本模块写的，但文档拿它做对照，所以也钉住它在**读者能看到的那份文档**里
  // 的原文。`DESIGN.md` 随包分发（在 package.json 的 files 里），所以它是正确的对象。
  // ⚠️ 别把这条写成「README 里必须有」——README 是面向使用者的说明，没有这张对照表。
  assert(
    /Auto review (?:denied|rejected) tool/.test(read(DESIGN)),
    'DESIGN.md 里不再出现 `Auto review denied tool …` —— 而它正是文档用来区分「EXP 自己拒绝」的判据',
  )
})

// ── 2d. 文档里的实测数字必须与用例数一致（防陈旧）───────────────────────────
//
// 这一条是为一个**真实发生过**的缺陷加的：文档曾把规则表那套写成「7 条断言组，
// 7 通过」，而实跑是 8 条 —— `repo-consistency.mjs` 当时不校验它，所以测试抓不到。
// 口径按「实际 `test(` 计数」对齐：文档里每个「N 条断言组」都必须等于对应脚本的用例数。
//
// ⚠️ 它现在读的是 `docs/remember.md`（与 R6 同一个理由：用例数属于**测试套件**的内容，
// 而 `test/` 与那份记录都是本地专属，读者拿不到）。
console.log('\n--- 2d. 文档实测数字与用例数一致（防陈旧）---')

test('N1 approval-gate-rules 的用例数与本机记录写的数字一致', () => {
  const remember = readOptionalLocal(REMEMBER)
  if (remember === undefined) {
    console.log('  SKIP  N1（本机记录 docs/remember.md 不在，说明本地专属文档未建立）')
    return
  }
  const rules = read(path.join(ROOT, 'docs', 'test', 'approval-gate-rules.mjs'))
  const actual = (rules.match(/^test\('/gm) ?? []).length
  assert(actual > 0, 'approval-gate-rules.mjs 里数不到用例')
  // 只抓「N 条断言组」这个短语 —— 后面可能接「，N 通过，0 失败（必问 58 条…）」等多种收尾，
  // 所以**不能**要求反引号或固定后缀紧跟其后（第一版就是这么误报「找不到」的）。
  const claimed = [...remember.matchAll(/(\d+)\s*条断言组/g)].map((m) => Number(m[1]))
  assert(
    claimed.includes(actual),
    `docs/remember.md 里没有「${actual} 条断言组」这个数字（找到的是 ${claimed.join(' / ') || '无'}）—— ` +
      '规则表那套的实际用例数是 ' + actual + '，请同步那份记录的「实测」行',
  )
  // 反向：README 里**不该**再出现「N 条断言组」—— 那是测试套件的计数，
  // 写进会随发布物分发的文档就是给读者看一个他没有的脚本清单。
  for (const [label, file] of [['README.md', README_EN], ['README.zh.md', README]]) {
    assert(
      !/\d+\s*条断言组|\d+\s*assertion groups/.test(read(file)),
      `${label} 里又出现了用例计数（「N 条断言组」）—— ` +
        '它属于测试套件的内容，请留在 docs/remember.md（详见那里的说明）',
    )
  }
})

// ── 2e. 两份 README 的骨架必须同步（英文版否则无人看着它）────────────────────
//
// ⚠️ 这一条补的是一个**结构性盲区**，不是风格偏好：
//
//   · R 组（R1–R7）与 N1 全都读**中文版** —— 它们的断言匹配「只有一个值」
//     「不是天花板」这类**中文句子**，在英文版里无从匹配。所以英文版此前
//     **没有任何断言在看它**：中文版改了、英文版漏改，整套校验照旧全绿。
//   · 两份 README 是**逐节对译**，所以「骨架」必须逐项一致：标题层级序列、
//     代码块围栏数、表格数。这三样与语言无关，却是「漏译一整节」「漏贴一个
//     代码块」「漏掉一张对照表」的可靠信号。
//
// ⚠️ 刻意**不**比对字数或段落数：翻译本来就会让句子长短不同（中文更紧凑），
// 拿字数当判据只会天天误报，最后被人忽略掉。
//
// 已知取舍：它挡不住「两版同时少了一节」或「英文版某一节内容写错了」——
// 那些需要人工对照。它挡的是最容易发生、也最容易蒙混过 review 的那一类：**只改了一版**。
console.log('\n--- 2e. 两份 README 的骨架同步（英文版否则无人校验）---')

/**
 * 取一份 Markdown 的**骨架**：标题层级序列、代码块围栏数、表格数。
 *
 * 逐行扫描，并**跳过围栏内部** —— 否则 README 里那些「示例里的 Markdown」
 * （比如「日志里能看到…」下面那段日志样本、以及包结构树）会被数成真标题。
 *
 * ⚠️ 入参是**文本**而不是路径，是为了让下面的反向验证能在内存里喂变异体进来 ——
 * 本文件对外的承诺是「永不写任何文件」。
 *
 * @param text - Markdown 全文。
 * @returns `{ heads, fences, tables }`；`heads` 是每级标题的层数（1–6）。
 */
function markdownSkeleton(text) {
  const heads = []
  let fences = 0
  let tables = 0
  let insideFence = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fences++
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue
    const heading = raw.match(/^(#{1,6})\s+\S/)
    if (heading !== null) heads.push(heading[1].length)
    if (/^\|[\s:\-|]+\|\s*$/.test(raw) && raw.includes('-')) tables++
  }
  return { heads, fences, tables }
}

test('P1 ★ 两份 README 的骨架一致（漏译一整节 / 漏贴代码块会被抓到）', () => {
  for (const [label, file] of [['中文版', README], ['英文版', README_EN]]) {
    assert(fs.existsSync(file), `${label}的 README 不存在：${path.relative(ROOT, file)}`)
  }
  const zh = markdownSkeleton(read(README))
  const en = markdownSkeleton(read(README_EN))

  // 围栏必须成对：奇数说明有一处 ``` 没闭合，渲染时会把后面的正文吞进代码块。
  assert(
    zh.fences % 2 === 0 && en.fences % 2 === 0,
    `代码块围栏数必须是偶数（成对开闭）：中文版 ${zh.fences}、英文版 ${en.fences} —— ` +
      '奇数说明有一处 ``` 没有闭合，Markdown 渲染会把后续正文吞进代码块里',
  )

  // 标题：先比总数（能直接说清「少了一整节」），再逐项比层级（能说到第几个开始分叉）。
  assert(
    zh.heads.length === en.heads.length,
    `两份 README 的标题总数不同：中文版 ${zh.heads.length} 个、英文版 ${en.heads.length} 个 —— ` +
      '两份是逐节对译，数量不同通常意味着有一版漏译（或多出）了一整节',
  )
  for (let index = 0; index < zh.heads.length; index++) {
    assert(
      zh.heads[index] === en.heads[index],
      `两份 README 的标题层级在第 ${index + 1} 个标题处分叉：中文版 h${zh.heads[index]}、` +
        `英文版 h${en.heads[index]} —— 层级序列必须逐项一致，它是「两版是否还对应同一节」的判据`,
    )
  }

  assert(
    zh.fences === en.fences,
    `两份 README 的代码块数量不同：中文版 ${zh.fences} 个围栏、英文版 ${en.fences} 个 —— ` +
      '常见成因是新加的命令示例只贴进了一版',
  )
  assert(
    zh.tables === en.tables,
    `两份 README 的表格数量不同：中文版 ${zh.tables} 张、英文版 ${en.tables} 张 —— ` +
      '常见成因是新加的参数表 / 故障对照表只贴进了一版',
  )
})

// ── 2f. workspace-acl 的红线（本仓库唯一会改系统状态的模块）───────────────────
//
// 这个模块会在会话开始时给工作区目录补一条权限。它是本仓库唯一改动**系统状态**
// （目录 ACL）的地方，所以它最要紧的三条性质必须静态钉住 —— 而它们各自都有确切的
// 坏后果，不是风格问题：
//
//   1. **只许 `TakeOwnership`** —— `FullControl` 会额外给出「改权限 + 夺所有权」，
//      远超 ACL 沙箱所需的 `WRITE_OWNER`。这是本模块最要紧的一条红线。
//   2. **看得清楚才动作** —— 脚本必须从环境变量读路径（不拼进脚本文本），
//      且不得删除既有 ACE / 改所有者 / 动 SACL。
//   3. **文案不许把可修的写成不可修的** —— 历史上注入文本与 README 曾把这个问题写成
//      「部署级限制」「需要一次已批准的受限外运行」，而那正是「要用户批准才能修」的来源。
console.log('\n--- 2f. workspace-acl 的红线（唯一改系统状态的模块）---')

test('A1 授权脚本只授 TakeOwnership（绝不 FullControl / Modify）', () => {
  const module = loaded.workspaceAcl
  assert(module !== undefined, 'workspace-acl.mjs 没有加载成功，无法校验')
  assert(typeof module.buildGrantScript === 'function', 'workspace-acl.mjs 应当导出 buildGrantScript')
  const script = module.buildGrantScript()
  assert(
    script.includes('::TakeOwnership'),
    '授权脚本里找不到 TakeOwnership —— 它是最小授权本身',
  )
  // 红线一：绝不许出现 FullControl。
  assert(
    !/FullControl/.test(script),
    '授权脚本里出现了 FullControl —— 那会额外给出「改权限 + 夺所有权」，' +
      '远超 ACL 沙箱所需的 WRITE_OWNER。这是本仓库最要紧的一条红线。',
  )
  assert(!/::Modify\b/.test(script), '授权脚本里出现了 Modify —— Modify 不含 WRITE_OWNER，修不了问题')
  // 红线二：只做加法。
  assert(
    !/RemoveAccessRule|PurgeAccessRules|SetOwner/.test(script),
    '授权脚本里出现了删除 ACE 或改所有者的动作 —— 本模块只做加法',
  )
  assert(
    !/IntegrityLevel|setintegritylevel/i.test(script),
    '授权脚本里出现了改完整性标签的动作 —— 那是宿主沙箱的职责，不是本模块的',
  )
  // 红线三：路径不拼进脚本。
  assert(script.includes('$env:DSH_MT_ACL_DIR'), '授权脚本没有从环境变量读路径 —— 那会引入注入面')
})

test('A2 composition 与 README 不得再把该问题写成「不可修」', () => {
  const composition = read(COMPOSITION)
  const readme = read(README)
  for (const [label, text] of [['composition.mjs', composition], ['README.md', readme]]) {
    assert(
      !/unrestricted run/i.test(text),
      `${label} 里又出现了「unrestricted run」—— 核实结果：修它只需一次 DACL 写入，` +
        '所有者隐式拥有 WRITE_DAC，同进程即可完成，与「受限外运行」无关',
    )
    assert(
      !/DEPLOYMENT-level refusal/i.test(text),
      `${label} 里又出现了「DEPLOYMENT-level refusal」—— 那是**不实**定性：` +
        '这是一个可修的目录权限前置条件',
    )
  }
  // 正向要求：必须写清真正缺的是什么、以及只补那一项。
  assert(/WRITE_OWNER/.test(composition), 'composition.mjs 必须写明真正缺的是 WRITE_OWNER')
  assert(
    /WRITE_OWNER/.test(readme),
    'README.md 必须写明真正缺的是 WRITE_OWNER',
  )
  assert(
    /Full control|FullControl/.test(composition),
    'composition.mjs 必须明确禁止把目录放宽到 Full control',
  )
})

test('A3 任何文件都不得出现给用户授 (F) 的现成命令', () => {
  // `(F)` 会连「改权限 + 夺所有权」一起给出去。历史上本仓库一度给出过这种命令，
  // 那既是过度授权，也误导读者以为修复需要更大的权限。
  for (const file of [COMPOSITION, README, WORKSPACE_ACL, APPROVAL_GATE]) {
    const text = read(file)
    assert(
      !/\/grant\s+"?[^"\n]*:\(F\)/i.test(text),
      `${path.relative(ROOT, file)} 里出现了给人照抄的 \`: (F)\` 授权命令 —— ` +
        '最小所需是 WRITE_OWNER，绝不用 Full control',
    )
  }
})

// ── 二之七、资产守卫：锁住三项「弄丢了不会报错」的护城河 ──────────────────────
//
// 这三项资产有一个共同点：**弄丢时没有任何报错**。
//   · `minimal` 的允许集里多一个写入 / 执行类工具 —— 会话照常跑，只读承诺已经没了；
//   · `ptc` / `minimal` 的 provider 名被改名 —— 守卫认不出那一行属于哪类 worker，
//     PTC 塌缩与只读收窄**静默失效**（什么都不做，也不报错）；
//   · 协调者的保留集多一项 —— 那个工具悄无声息地回到协调者手里
//     （`write` 一旦回来，「机制上不能自己动手」这条就作废了）；少一项则是能力被静默摘掉。
//
// 所以它们必须由断言挡住，而不是靠人记得。`docs/AGENT-TEAM-COMPAT.md` §11.4 提议的正是
// 这三条；本节省略了已经存在的跨模块比对（M1 / M2 比对两份手抄的 provider 名，
// G2 不再重复那一件事，它多管的是**字面值本身**与宿主注册清单）。
console.log('\n--- 2g. 资产守卫：minimal 白名单 / 语义键 / 协调者保留集 ---')

/**
 * 从一个 `const <name> = [ … ]` 数组字面量里取出**字符串元素**。
 *
 * 为什么不能直接 `match(/NAME\s*=\s*\[([^\]]*)\]/)` 再抓引号：这两张表的**注释里也带
 * 单引号**（`DEFAULT_KEEP` 的注释原文就写着 `['subagent_ptc','subagent_minimal']`），
 * 直接抓会把注释里的名字当成元素 —— 于是「集合恰好相等」那条在真文件上恒红，
 * 或者更糟：有人为了让它变绿去删注释。所以这里按字符扫一遍，行注释与块注释都跳过。
 *
 * 注释里的引号一律不算元素；元素只认**数组层级上**出现的字符串。
 *
 * @param source - 整份源码。
 * @param name - 常量名（如 `DEFAULT_KEEP`）。
 * @returns 元素字符串数组（按源码顺序）。
 */
function arrayLiteralElements(source, name) {
  const open = new RegExp(`const\\s+${name}\\s*=\\s*\\[`).exec(source)
  assert(open !== null, `源码里找不到 ${name} 的数组字面量 —— 判据需要它，请先确认常量还在`)
  const elements = []
  let depth = 1
  let i = open.index + open[0].length
  while (i < source.length && depth > 0) {
    const ch = source[i]
    // 行注释：跳到行尾（注释里的引号因此不会被当成元素）。
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    // 块注释：跳到收尾处。
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let value = ''
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          value += source[i + 1] ?? ''
          i += 2
          continue
        }
        value += source[i]
        i += 1
      }
      i += 1
      if (depth === 1) elements.push(value)
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') depth -= 1
    i += 1
  }
  return elements
}

test('G1 ★ minimal 的只读白名单不含任何写入 / 执行类工具', () => {
  // 判据对象：`minimal-guard.mjs` 的 `DEFAULT_MINIMAL_KEEP`（只读 worker 的允许集）。
  // 它没被 export，所以按源码解析（与 M1 / M2 解析常量的做法一致）。
  const keep = arrayLiteralElements(read(MINIMAL_GUARD), 'DEFAULT_MINIMAL_KEEP')
  assert(
    keep.length > 0,
    'DEFAULT_MINIMAL_KEEP 解析出来是空的 —— 要么常量改名了，要么解析失效，这条断言此刻没有判别力',
  )

  const WHY = 'minimal 的只读承诺靠这张表，加一个写入类工具就等于把安全边界拆了'
  for (const banned of ['write', 'edit', 'pwsh', 'bash']) {
    assert(
      !keep.includes(banned),
      `${WHY} —— DEFAULT_MINIMAL_KEEP 里出现了 "${banned}"（实际表：${keep.join(', ')}）`,
    )
  }
  const remote = keep.filter((n) => n.startsWith('ssh_') || n.startsWith('task_board_'))
  assert(
    remote.length === 0,
    `${WHY} —— DEFAULT_MINIMAL_KEEP 里出现了可在远端执行 / 写任务板的工具：` +
      `${remote.join(', ')}（实测过：不收窄的 worker 能执行 ssh_exec、能触发 task_board_run）`,
  )
})

test('G2 ★ 两个语义键（provider 名）不许改名，宿主注册清单必须恰好是这两个', () => {
  const composition = read(COMPOSITION)
  const literalOf = (source, name, where) => {
    const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`))
    assert(match !== null, `${where} 里找不到 ${name} 字面量`)
    return match[1]
  }
  const WHY =
    '这两个名字是守卫的语义键：改名会静默关掉 PTC 塌缩与只读收窄 —— ' +
    '守卫按 provider 名认这一行属于哪类 worker，认不出就什么都不做，而且不报错'

  const ptc = literalOf(composition, 'PTC_PROVIDER', 'composition.mjs')
  const minimal = literalOf(composition, 'MINIMAL_PROVIDER', 'composition.mjs')
  assert(ptc === 'multitask_ptc', `${WHY}（composition.mjs 的 PTC_PROVIDER 现在是 "${ptc}"）`)
  assert(minimal === 'multitask_minimal', `${WHY}（composition.mjs 的 MINIMAL_PROVIDER 现在是 "${minimal}"）`)

  // 宿主半的注册清单必须**恰好**是这两个名字（顺序不限）：M8 只要求「都包含」，
  // 这里要求「不多不少」——多注册一个名字同样是漂移。
  const providerSource = read(PROVIDER_MODULE)
  const reg = providerSource.match(/WORKER_PROVIDER_NAMES\s*=\s*\[([^\]]*)\]/)
  assert(reg !== null, 'worker-providers.js 里找不到 WORKER_PROVIDER_NAMES 的数组字面量')
  const registered = [...reg[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  const expected = [ptc, minimal].slice().sort().join(',')
  const actual = registered.slice().sort().join(',')
  assert(
    registered.length === 2 && actual === expected,
    `WORKER_PROVIDER_NAMES 必须恰好是这两个名字（顺序不限）：期望 ${JSON.stringify([ptc, minimal].slice().sort())}，` +
      `实际 ${JSON.stringify(registered)} —— 多一个会注册出不需要的 worker，少一个那条委派工具根本不出现`,
  )
})

test('G3 ★ 协调者保留集必须恰好是那 21 个名字（多一个少一个都要红）', () => {
  // 保留集是**白名单**（`deny = 可见集 − 保留集`），所以两个方向都会出事：
  // 多一项 = 那个工具回到协调者手里，少一项 = 能力被静默摘掉。
  const EXPECTED = [
    'read',
    'grep',
    'glob',
    'file_info',
    'subagent',
    'subagent_fork',
    'send_message',
    'interrupt_agent',
    'list_agents',
    'job_list',
    'job_output',
    'job_kill',
    'workflow',
    'ask_user_question',
    'todo_write',
    'create_goal',
    'get_goal',
    'update_goal',
    'exit_plan_mode',
    'present',
    'skill',
  ]
  const actual = arrayLiteralElements(read(COORDINATOR_GUARD), 'DEFAULT_KEEP')
  assert(
    actual.length > 0,
    'DEFAULT_KEEP 解析出来是空的 —— 要么常量改名了，要么解析失效，这条断言此刻没有判别力',
  )
  const missing = EXPECTED.filter((n) => !actual.includes(n))
  const extra = actual.filter((n) => !EXPECTED.includes(n))
  const duplicated = actual.filter((n, index) => actual.indexOf(n) !== index)
  assert(
    missing.length === 0 && extra.length === 0 && duplicated.length === 0,
    `DEFAULT_KEEP 漂移了（期望 21 个，实际 ${actual.length} 个）：` +
      `缺 ${missing.length > 0 ? missing.join(', ') : '无'}；` +
      `多 ${extra.length > 0 ? extra.join(', ') : '无'}；` +
      `重复 ${duplicated.length > 0 ? duplicated.join(', ') : '无'} —— ` +
      '保留集是白名单：多一个就等于把那个工具放回协调者手里（write 一旦回来，「机制上不能自己动手」就作废），' +
      '少一个等于把能力静默摘掉。改保留集必须同步文档 §4.1 与 §11.1',
  )
})

// ── 三、测试文件归位 ─────────────────────────────────────────────────────────
console.log('\n--- 3. 测试文件归位（全部必须在 test/ 下）---')

test('T1 仓库里没有 test/ 之外的测试类文件', () => {
  const offenders = testLikeFilesOutsideTest()
  assert(
    offenders.length === 0,
    `发现 ${offenders.length} 个 test/ 之外的测试类文件：\n        - ${offenders.join('\n        - ')}\n` +
      '        规则：所有测试 / 探针 / 校验 / 诊断脚本都必须放在 test/ 下。',
  )
})

test('T2 test/ 仍在 .gitignore 里（本地保留、不随仓库分发）', () => {
  const ignore = read(path.join(ROOT, '.gitignore'))
  assert(
    /^test\/\s*$/m.test(ignore),
    '.gitignore 里没有单独的 `test/` 规则 —— 按「是测试就不进远端」的约定，test/ 整个目录都应当被忽略',
  )
})

// ── 四、反向验证：把「并发那一行」加回来，用例必须变红 ────────────────────────
//
// 与 `guard-mode-isolation-regression.mjs` 同一条纪律：**一条永远绿的守卫断言，
// 恰好等于没有那条断言**。
//
// ⚠️ 这一节的方向**跟着规格翻转过两次**，值得记下来：
//   · 最初证明「去掉 `min(值, 8)` 会让用例红」（那时规格是「必须夹到 8」）；
//   · 然后反过来证明「加回夹子会让用例红」（规格变成「不许夹」）；
//   · 现在规格是「**整个并发链路都不许存在**」，所以要证明的是
//     「**把那一行加回来会让用例红**」。
// 每次翻转都必须同步改这里 —— 方向不跟着翻，这一节就会退化成一段恒绿的装饰。
console.log('\n--- 4. 反向验证（把并发那一行加回来应当变红）---')

let mutantOk = false
{
  // 被判据检出的「回归」形态：composition 里又出现一行 concurrency-guard。
  // 这里**只在内存里**改字符串，不碰磁盘（本文件对外的承诺就是永不写文件）。
  const source = read(COMPOSITION)
  const back = source.replace(
    "        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },",
    "        { id: 'concurrency-guard', name: local('./concurrency-guard.mjs'), config: { enabled: true } },\n" +
      "        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },",
  )

  if (back === source) {
    console.log('\n!! 找不到用于变异的锚点，反向验证无法进行')
  } else {
    // 这正是 C2 用的那条判据（对代码行做正则）。它在真文件上必须**不**命中，
    // 在变异体上必须命中 —— 两端都验过，才说明 C2 是有判别力的。
    const hits = (text) => /concurrency-guard/.test(text.replace(/^[ \t]*(?:\*|\/\/).*$/gm, ''))
    const realClean = !hits(source)
    const mutantCaught = hits(back)
    mutantOk = realClean && mutantCaught
    console.log(
      mutantOk
        ? '\n判别力确认：真文件里没有 concurrency-guard 行（C2 通过），把那一行加回来后 C2 立刻会红 —— 该用例不是恒真的。'
        : `\n!! 判别力不足：真文件 clean=${realClean}，变异体被检出=${mutantCaught}（两者都应为 true）`,
    )
  }
}

// ── 4b. 反向验证：搓掉英文版的一节，P1 必须变红 ──────────────────────────────
//
// 与上面同一条纪律。P1 这类「两份文档骨架对照」的断言有一个特别容易掉进去的坏法：
// 判据写成恒真（比如两边都解析失败、都得到空骨架，于是「相等」）。
// 所以必须在**内存里**把英文版搓掉一节，确认 P1 真的会红。
//
// 三种搓法各验一次，因为它们是三种不同的漏译形态：
//   ① 删掉一个小节标题 —— 标题总数与层级序列同时变化；
//   ② 删掉一个代码块 —— 只有围栏数变化；
//   ③ 删掉一张表格的分隔行 —— 只有表格数变化。
let skeletonMutantOk = false
{
  const zhText = read(README)
  const enText = read(README_EN)
  const base = markdownSkeleton(enText)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // ① 去掉英文版的一个 `###` 小节标题（连同它那一行文字）。
  const noSection = enText.replace(/^### .*$/m, '')
  // ② 去掉英文版的一整个代码块（含围栏）。
  const noFence = enText.replace(/^```[a-z]*\r?\n[\s\S]*?\r?\n```\r?$/m, '')
  // ③ 去掉英文版的一张表格（表头 + 分隔行 + 数据行，直到空行）。
  const noTable = enText.replace(/^\|[\s\S]*?(?=\r?\n\r?\n)/m, '')

  const cases = [
    ['删掉一个小节标题', noSection, (s) => !same(s.heads, base.heads)],
    ['去掉一个代码块', noFence, (s) => s.fences !== base.fences],
    ['去掉一张表格', noTable, (s) => s.tables !== base.tables],
  ]

  const realClean = same(markdownSkeleton(zhText), base)
  const caught = cases.filter(([label, text, detector]) => {
    if (text === enText) {
      console.log(`\n!! 「${label}」的变异锚点没匹配上，该种搓法无法验证`)
      return false
    }
    const ok = detector(markdownSkeleton(text))
    if (!ok) console.log(`\n!! 变异「${label}」没有被 P1 的判据检出`)
    return ok
  }).length

  skeletonMutantOk = realClean && caught === cases.length
  console.log(
    skeletonMutantOk
      ? `\n判别力确认：真文件的两份骨架一致（P1 通过），三种漏译形态（标题 / 代码块 / 表格）各搓掉一处后 P1 都会红 —— 该用例不是恒真的。`
      : `\n!! 判别力不足：真文件一致=${realClean}，被检出 ${caught} / ${cases.length} 种漏译形态`,
  )
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\n仓库一致性：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败` +
    `；反向验证判别力：${mutantOk ? '已确认' : '未确认'} / 文档骨架：${skeletonMutantOk ? '已确认' : '未确认'}`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
if (!mutantOk || !skeletonMutantOk) process.exitCode = 1
