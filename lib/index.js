/**
 * dsh-multitask — host 半（node 侧）。
 *
 * 职责只有一件事：在插件激活时，把本包自带的 **Multitask agent preset** 声明给
 * DSH 的 agent-preset 注册表。声明成功 = 该 preset 出现在新会话的模式选择器里，
 * 选中它即进入 Multitask 工作模式。
 *
 * 这个「插件自带 preset 并在激活时声明」的路子不是本包发明的 —— 同一 profile 里
 * 已装好的 `@linxin666/dsh-liangshen` 就是这么做的，本包沿用同一套已验证的契约：
 *
 *   - 声明对象形状由 `@deepseek-ai/dsh-agent-preset` 的 Config 定义：
 *     `{ id, name, description, order, plugins }`（`id` 与 `plugins` 必填）；
 *   - `ctx.agentPresets.register(definition)` 是**异步**的，返回一个
 *     **注销器**；注销器由声明方拥有，必须在卸载时调用，否则 preset 会残留在
 *     注册表里（还可能因为 id 重复导致下次声明失败）；
 *   - 注册表服务可能比本插件晚出现，所以用 `ctx.inject(['agentPresets'], ...)`
 *     兜住「先加载」的情况。
 *
 * 本包**不需要**任何 DSH 源码改动 —— 这是刻意的：本机是打包发行版，
 * 没有可编辑的源码树，一切扩展都必须走插件面。
 *
 * ── 为什么用动态 import 而不是静态 import ────────────────────────────────────
 *
 * 本包在工作区里、**不在** HMR 监视的根目录下，所以改源码不会被自动重载，
 * Node 的 ESM 缓存会一直返回旧模块。DSH 给的唯一免重启杠杆是 profile patch
 * 文件（它**是**被热重载的），因此可以把行里的 URL 加一个 `?v=N` 来换掉缓存键。
 *
 * 但实测发现一个关键陷阱：**相对导入不会继承入口的 query**。也就是说，
 * 只给入口加 `?v=2`，入口本身会刷新，而它 import 的 `composition.mjs`
 * 仍然从旧缓存取 —— 改了 preset 文本却看不出变化，且毫无报错。实测结果：
 *
 *     入口 ?v=2 -> entry-v2  ✓ 刷新
 *     composition -> inner-v1 ✗ 未刷新（仍是旧内容）
 *
 * 所以这里显式把入口自己的 query 传播到相对 import 上，让**一次 URL 版本号
 * 递增刷新整张模块图**。实测（传播 query 后）两者都会刷新。
 *
 * 附带好处：`fileURLToPath` 会丢弃 query，`realpathSync` 仍解析到真实文件，
 * 所以 `dsh-app-boot` 的 `manifestOf()`/兼容性预检照常工作 —— 已实测确认。
 */
const compositionSpecifier = new URL('../presets/multitask/composition.mjs', import.meta.url)
const entryQuery = new URL(import.meta.url).search
if (entryQuery !== '') compositionSpecifier.search = entryQuery
const composition = await import(compositionSpecifier.href)

const { buildPlugins } = composition
const presetMetadata = composition.definition

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask'
/**
 * 本插件不硬依赖任何服务即可激活，所以不声明 `inject`。
 *
 * 注册表在部分部署里可能不存在（没有装 preset 支持的瘦身 profile）。这种情况下
 * 本插件仍应正常加载并**明确告警**，而不是让整条 profile 因为缺服务而挂起。
 */
export const inject = []

/**
 * 已经装载过本插件的 Context 集合。
 *
 * 同一份模块被同一 Context 装载两次时（HMR 替换、补丁叠加），第二次 `apply`
 * 会尝试用一个**重复的 preset id** 去注册，注册表会直接抛
 * `Duplicate agent preset` —— 或者更糟：先注销掉第一次的声明，让正在使用
 * 该 preset 的会话失去它的组合。这里做一次幂等拦截。
 */
const mounted = new WeakSet()

// ── 按类型给子代理指定默认模型（本包自己就是那个设置命名空间）──────────────────
//
// ── 为什么本包必须自己声明一个 `Config` ──────────────────────────────────────
//
// `@deepseek-ai/dsh-settings` 暴露给设置面板的命名空间**就是 profile 条目 id**
// （它的 `describe()` 用 `entry.options.id` 当 `ns`），而它只暴露该条目 Config 里
// 声明了 `.volatile()` 的字段 —— 普通字段被 `projectForm()` 过滤掉，写路径也要过
// `isVolatilePath()`。本包在 profile 里正是一个 id 为 `multitask` 的普通条目
// （由 `cordis.patch.yml` 的 `insert:` 插入），所以**它自己**就是最合适的命名空间，
// 不必再加一个包。
//
// ── 为什么是**手写**的零依赖 schema ──────────────────────────────────────────
//
// 本包没有 `node_modules`，`@deepseek-ai/schemastery` / `@deepseek-ai/cosmokit`
// 都**解析不到**（实测 `ERR_MODULE_NOT_FOUND`）。所以这里不能 `import z from
// '@deepseek-ai/schemastery'`，只能手写一个满足下列**已被逐条实测**的契约对象：
//
//   · `toJSON()` 返回 schemastery 的 `{uid, refs}` 图 —— dsh-settings 的
//     `volatileForm()` 会 `new z(schema.toJSON())` 把它水合成真 schema 再用；
//   · `[Symbol.for('schemastery')] === true` 且 `type`/`meta` 就位 ——
//     `dsh-app-boot` 的 `isNativeConfigSchema()` 靠这三样认它是原生 schema；
//   · `meta` 必须是对象（`volatileForm` 直接读 `schema.meta.volatile`）；
//   · `dict` 必须存在 —— **这一条最容易漏，且漏了会出大事**：loader 的
//     `equalExceptVolatile()` 在 `!schema.dict` 时直接退回**整份 raw 配置的严格比较**，
//     于是「只改了 volatile 字段」也会被判成普通配置变更 → **重启 fiber** →
//     撞上下面的 `mounted` 守卫而不再声明 → 表现是「Multitask 模式从新会话列表消失」。
//     实测确认：给了 `dict` 之后判定为 volatile-only，不重启；
//   · `~standard.vendor` 必须是 `'schemastery'` —— loader 的 `isSchemastery()`
//     用这个字符串决定要不要走 volatile 感知比较，写别的值同样会退回严格比较；
//   · `~standard.validate()` **对任何输入都不得抛错** —— cordis 的
//     `resolveConfig()` 把 issues 当异常抛，而它跑在 fiber 的配置解析里，
//     抛出来等于这个插件起不来（模式消失）。所以下面做的是**清洗**而不是**拒绝**。
//
// volatile 字段刻意**嵌套**在 `subagentModels` 上、而不是把根做成 volatile：
// 根若为 volatile，`resolveConfig()` 交回的就是一个 `{get()}` 引用，
// `apply()` 里对 `config.enabled` / `config.keep` / `config.extraDeny` /
// `config.guardEnabled` / `config.presetId` / `config.order` 的读取会**全部变成
// undefined**，减震器保留集与总开关就此静默失效。官方
// `subagent-model-selection-settings` 用的正是同样的嵌套写法。

/** 设置字段名：`<类型键> -> { subagentType, provider, model }` 的数组。 */
const MODEL_MAP_FIELD = 'subagentModels'

/** 模型映射字段的键名；导出供 `verify.mjs` 断言它真的是 volatile 的。 */
export const MODEL_MAP_FIELD_NAME = MODEL_MAP_FIELD

/**
 * 设置字段名：本模式自己的「子代理并发上限」。
 *
 * ── 语义（与设置面板那半边冻结的契约，逐条对齐）──────────────────────────────
 *
 *   · 字段**缺席** ⇒ 不限制。这是「本字段加入之前」的行为，必须逐字保留；
 *   · 有值 ⇒ 安全整数且 **≥ 1**（0 不是合法上限，它会被收敛成 1）；
 *   · 其它任何输入（非安全整数 / `NaN` / `Infinity` / `< 1` / 字符串 / `null`）
 *     一律**夹到 1**。
 *
 * ⚠️ 收敛方向是**刻意**选的：把非法值当成「不限制」会**比用户的意图更宽松**
 * ——用户既然碰了这个字段，就是想要一个上限。代价是「误填一个垃圾值 = 变成上限 1」，
 * 这比静默失效更容易被发现，也更安全。
 *
 * ⚠️ 唯一的例外是「字段缺席」：那不是非法值，是**没设过**，必须与不限制等价
 * （面板的「不限制」正是通过 `{op: 'unset'}` 把键删掉来表达的，见 client.js）。
 *
 * 命名与宿主 `dsh-subagent` 的 `maxActiveSubagents` 对齐：两者管的是同一件事，
 * 且**同时生效、取较小值**。本字段只是给本模式一个更低的上限。
 */
const MAX_ACTIVE_FIELD = 'maxActiveSubagents'

/** 并发上限字段的键名；导出供 `verify.mjs` 断言它真的是 volatile 的。 */
export const MAX_ACTIVE_FIELD_NAME = MAX_ACTIVE_FIELD

/**
 * 4 类 worker 的类型键 —— 与 `composition.mjs` 的 `WORKER_MODEL_TYPES` 是同一组值。
 *
 * 客户端面板、本文件与 composition 三处一致；测试里会断言它们逐字相等，
 * 好让「某天只改了一处」变成可见的失败，而不是面板里凭空多出一个无效选项。
 */
const WORKER_MODEL_TYPES = ['subagent', 'subagent_fork', 'subagent_ptc', 'subagent_minimal']

/**
 * 产出一个**没有键**的普通对象（原型是 `Object.prototype`）。
 *
 * 刻意不写裸的空对象字面量：本仓库已多次实测到「写入路径吞掉空花括号」会让整个
 * 文件变成语法错误，所以空对象统一由本函数产出。
 *
 * @returns 一个新的空对象。
 */
function emptyRecord() {
  return Object.create(Object.prototype)
}

/** schemastery `toJSON()` 图里各节点的 uid（自选常数，只需在本图内唯一）。 */
const SCHEMA_UID = { string: 1, route: 2, routes: 3, root: 4, maxActive: 5 }

/**
 * 该 schema 的 `{uid, refs}` 图。
 *
 * 形状与真 schemastery 的 `toJSON()` 产物一致（见 `_probe_*` 里对照过的输出）：
 * `refs` 是 uid → 节点 的映射，节点之间用 uid 互相引用。
 *
 * ⚠️ 名字里的 `MODEL_` 是历史遗留：本图现在同时承载**两个** volatile 字段
 * （`subagentModels` 与 `maxActiveSubagents`）。刻意**不改名**，因为
 * `toJSON()` 直接把它交给 `new z(...)` 水合，改名只是噪音、不影响行为。
 */
const MODEL_SCHEMA_REFS = {
  [SCHEMA_UID.string]: { type: 'string' },
  [SCHEMA_UID.route]: {
    type: 'object',
    dict: {
      subagentType: SCHEMA_UID.string,
      provider: SCHEMA_UID.string,
      model: SCHEMA_UID.string,
    },
  },
  [SCHEMA_UID.routes]: {
    type: 'array',
    // ★ volatile 字段之一（模型映射表）。面板因此可读可写，且改动**不会重启本插件**。
    meta: { volatile: true },
    inner: SCHEMA_UID.route,
  },
  [SCHEMA_UID.maxActive]: {
    type: 'number',
    // ★ volatile 字段之二（本模式的子代理并发上限）。
    //
    // 这里**必须**带 `meta.volatile: true`，这不是可选项：`dsh-settings` 的
    // `volatileForm()` 靠它决定这一节要不要出现在面板上，loader 的
    // `equalExceptVolatile()` 也靠它把「只改了这一个字段」判成 volatile-only。
    // 一旦漏掉，面板写它就会让整份配置被判成**普通**变更 ⇒ 重启本插件 ⇒
    // 撞上 `mounted` 守卫而不再声明 ⇒ 表现是「Multitask 模式从新会话列表消失」。
    //
    // 刻意**不给**它写 `meta.default`：数字节点上没有「缺席即默认值」这回事 ——
    // 本字段的语义正是「**缺席** ⇒ 不限制」，给它补一个默认数字反而会把「没设过」
    // 压成「设过一个值」。`equal()` 对带 `meta.volatile` 的节点在**第一行**就返回
    // true（见 cordis-plugin-loader 的 `equal()`），根本走不到 `?? meta.default`
    // 那一句，所以这里不给默认值是安全的 —— 这与根节点必须给 `meta.default`
    // （那是对象节点的 `isRecord` 判据）**不是**同一个理由，别把两者混起来。
    meta: { volatile: true },
  },
  [SCHEMA_UID.root]: {
    type: 'object',
    // ★ `default` 必须是「空对象」，**绝不能省**。真 schemastery 的每个对象节点都带
    // `meta:{default:{}}`，这里必须对齐。loader 的 `equal()` 比较时会把**缺席的那一侧**
    // 替换成 `schema.meta.default`；而 `default` 缺席时替换结果仍是 undefined，
    // `isRecord(undefined)` 为假 ⇒ 直接退回「整份配置严格比较」⇒ 判为**非** volatile
    // ⇒ **重启 fiber** ⇒ 撞上 `mounted` 守卫而不再声明 ⇒ 模式从新会话列表消失。
    //
    // 这一条只在**首次保存**时咬人（`undefined → {subagentModels:[...]}`），
    // 也就是用户第一次点「保存」的那一刻 —— 由 `_w6/_probe_firstsave.mjs` 实测确认：
    // 省掉它该用例 FAIL，补上它全部 PASS。
    meta: { default: emptyRecord() },
    dict: {
      [MODEL_MAP_FIELD]: SCHEMA_UID.routes,
      [MAX_ACTIVE_FIELD]: SCHEMA_UID.maxActive,
    },
  },
}

/**
 * 造一个 schema 节点对象（**递归**地把子节点也造成节点对象）。
 *
 * ── 为什么 `dict` / `inner` 里必须是**节点对象**，不能是 uid ──────────────────
 *
 * 这两个形状服务于**不同的**消费者，混淆它们会同时踩坏两边：
 *
 *   · `toJSON()` 返回的 `{uid, refs}` 图里，节点之间**必须**用 uid 互相引用 ——
 *     这是 schemastery 的序列化格式，`new z(json)` 会照着 `refs` 把 uid 还原成节点；
 *   · 但**活的** schema 对象本身（`Config.dict.subagentModels`）必须已经是节点对象，
 *     因为 `dsh-settings` 的 `volatileForm()` 与 `isVolatilePath()` 是**直接遍历
 *     活对象**的：前者读 `schema.dict` 的每个孩子再取 `child.meta.volatile`，
 *     后者读 `schema.dict[key]` 然后递归。若这里的值是数字 uid，`meta` 取不到，
 *     `volatileForm()` 会返回 undefined ⇒ 设置面板**根本看不到这一节**
 *     （`describe()` 里 `if (form === void 0) return []` 直接跳过本条目）。
 *
 * 实测踩到过：只按 `refs` 铺 uid 的那一版，探针里 `volatileForm` / `isVolatilePath`
 * 双双为 FAIL。所以这里两边都铺。
 *
 * @param uid - 该节点在 `MODEL_SCHEMA_REFS` 里的 uid。
 * @returns 一个可供 schemastery 重新水合、也可被设置管线直接遍历的节点。
 */
function modelSchemaNode(uid) {
  const refs = MODEL_SCHEMA_REFS[uid]
  const node = {
    uid,
    type: refs.type,
    // 每个节点都要有自己的 meta 对象（不能共享）：`plainSchema()` 会**原地**删掉
    // 子节点的 `meta.volatile`，共享一份就把 volatile 标记永久抹掉了。
    meta: { ...(refs.meta ?? {}) },
    // 每次返回深拷贝：水合与 plainSchema 都会原地改写 meta。
    toJSON: () => JSON.parse(JSON.stringify({ uid, refs: MODEL_SCHEMA_REFS })),
  }
  if (refs.dict !== undefined) {
    const dict = {}
    for (const [key, childUid] of Object.entries(refs.dict)) dict[key] = modelSchemaNode(childUid)
    node.dict = dict
  }
  if (refs.inner !== undefined) node.inner = modelSchemaNode(refs.inner)
  return node
}

/**
 * 把任意输入清洗成规整的模型映射表。
 *
 * ⚠️ **永不抛错、只丢弃**。理由见上面 `Config` 的注释：这个函数跑在 fiber 的配置
 * 解析路径上，抛错等于本插件起不来。宁可某个类型退回「继承协调者」，也不要因为
 * 一个手抖的字符串让整个 Multitask 模式消失。
 *
 * @param raw - 原始配置值，可能是任何东西。
 * @returns `{ subagentType, provider, model }` 数组，只含合法条目。
 */
function normalizeModelList(raw) {
  const list = raw !== null && typeof raw === 'object' && Array.isArray(raw[MODEL_MAP_FIELD])
    ? raw[MODEL_MAP_FIELD]
    : []
  const cleaned = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { subagentType, provider, model } = entry
    // 未知类型一并丢弃：面板只会给这四类，而手改的 YAML 写错键名时，
    // 留着它没有意义（composition 侧也会再过滤一次）。
    if (typeof subagentType !== 'string' || !WORKER_MODEL_TYPES.includes(subagentType)) continue
    if (typeof provider !== 'string' || provider.trim() === '') continue
    if (typeof model !== 'string' || model.trim() === '') continue
    cleaned.push({ subagentType, provider, model })
  }
  return cleaned
}

/**
 * cosmokit 的 volatile 写协议符号（跨 ESM/CJS 副本稳定，因为它挂在 `Symbol.for` 上）。
 *
 * 本包不能 import cosmokit，但可以**照它的协议**造一个引用对象：
 * `isVolatile()` 只检查这个符号在不在，`updateVolatile()` 也只是调它。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 递归冻结一份快照（与 cosmokit 的 `createVolatile` 语义一致）。 */
function freezeSnapshot(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSnapshot))
  const out = Object.create(Object.prototype)
  for (const [key, item] of Object.entries(value)) out[key] = freezeSnapshot(item)
  return Object.freeze(out)
}

/** 造一个 volatile 引用（稳定的 `{get()}`，值只能被 loader 通过写协议换掉）。 */
function createVolatile(value) {
  let current = freezeSnapshot(value)
  const reference = {
    get: () => current,
    [VOLATILE_WRITE]: (next) => {
      current = next
    },
  }
  return Object.freeze(reference)
}

/**
 * 本插件的 Config —— 手写、零依赖。
 *
 * 声明的**每个**字段都必须是 volatile 的。只要再放一个普通字段，面板写它就会让整份
 * 配置的变更被判成「非 volatile」，从而重启本插件（后果见上）。所以这里两个字段都带
 * `meta.volatile`，并在 `validate` 里各自换成 volatile 引用。
 */
export const Config = {
  ...modelSchemaNode(SCHEMA_UID.root),
  '~standard': {
    version: 1,
    // ★ 必须是这个字符串：loader 的 isSchemastery() 靠它选择 volatile 感知比较。
    vendor: 'schemastery',
    validate: (raw) => {
      const base = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...raw }
        : Object.create(Object.prototype)
      base[MODEL_MAP_FIELD] = createVolatile(normalizeModelList(raw))
      base[MAX_ACTIVE_FIELD] = createVolatile(normalizeMaxActive(raw))
      return { value: base }
    },
  },
}

// dsh-app-boot 的 isNativeConfigSchema() 认这三个标记，缺一个就会把本插件当成
// 「Config 不是原生 schemastery」并拒绝生成任何配置面。
Object.defineProperty(Config, Symbol.for('schemastery'), { value: true })

/**
 * 从 `apply()` 收到的（已解析的）配置里取出模型映射。
 *
 * `config[MODEL_MAP_FIELD]` 是上面那个 volatile 引用，所以这里取的是**当前**快照。
 *
 * @param config - `apply()` 的第二参数。
 * @returns 供 `buildPlugins({ modelMap })` 消费的数组；没有配置时为空数组。
 */
function readModelMap(config) {
  const raw = config?.[MODEL_MAP_FIELD]
  const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  return Array.isArray(value) ? value : []
}

/**
 * 把任意输入收敛成「合法的并发上限」或 `undefined`（= 不限制）。
 *
 * ⚠️ **永不抛错** —— 与 `normalizeModelList` 同一个理由：本函数跑在 fiber 的配置
 * 解析路径上，抛错等于本插件起不来（模式从新会话列表消失）。
 *
 * ── 两种「空」必须被区分开，这是本函数唯一微妙的地方 ─────────────────────────
 *
 *   · **字段缺席**（键不在 / 值为 `undefined`）⇒ 返回 `undefined` = **不限制**。
 *     这是刻意的：「没设过」不是「设错了」。设置面板的「不限制」正是用
 *     `{op: 'unset', path: ['maxActiveSubagents']}`（删键）来表达的。
 *   · **其它任何东西**（`0` / `-1` / `NaN` / `Infinity` / `2.5` / `'4'` / `null` /
 *     布尔 / 对象 / 数组）⇒ **夹到 1**。
 *
 * 第二条的方向是刻意选的：把非法值当成「不限制」会**比用户意图更宽松**。
 * 一个手抖的字符串只会让上限变成「最多 1 个并发」——难看，但安全且立刻可见；
 * 静默地取消限制则什么都不会发生，直到超发把协调者上下文撑爆。
 *
 * 判定只用 `Number.isSafeInteger` + `>= 1`，不额外做 `Math.max(1, …)`：对任何
 * 非安全整数它都直接落到 1，而 1 就是 `Math.max(1, x)` 在 `x < 1` 时的取值，
 * 两条路径同解，少一次转换就少一处能出错的地方。
 *
 * @param raw - 原始配置值（`Config` 的整个对象，不是单个字段）。
 * @returns 安全整数 `>= 1`，或 `undefined`（不限制）。
 */
function normalizeMaxActive(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw[MAX_ACTIVE_FIELD]
  if (value === undefined) return undefined
  return Number.isSafeInteger(value) && value >= 1 ? value : 1
}

/**
 * 从 `apply()` 收到的（已解析的）配置里取出并发上限。
 *
 * 镜像 `readModelMap` 的形状：`config[MAX_ACTIVE_FIELD]` 是 `validate` 换上的
 * volatile 引用，所以这里取的是**当前**快照；`apply()` 之后用户再改面板，
 * `redeclare()` 会重新走一遍 `build()`，因此这里读到的永远是最新值。
 *
 * ⚠️ 与 `readModelMap` 的一个关键差别：`undefined` 在这里是**有意义的值**
 * （不限制），所以**绝不能**把它兜底成别的数字。三个字段的三种含义必须分清：
 *   · `undefined` —— 字段缺席 ⇒ 不限制（本模式不额外设限）；
 *   · 安全整数 `>= 1` —— 限制到该值；
 *   · 其它 —— 不可能出现，`validate` 已经把它们收敛掉了（这里再收敛一次是冗余防线）。
 *
 * @param config - `apply()` 的第二参数。
 * @returns 供 `buildPlugins({ maxActiveSubagents })` 消费的数字，或 `undefined`。
 */
function readMaxActive(config) {
  const raw = config?.[MAX_ACTIVE_FIELD]
  const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  if (value === undefined) return undefined
  return Number.isSafeInteger(value) && value >= 1 ? value : 1
}

/**
 * 结构等价判断 —— 只用来决定「这次设置改动是否真的改变了声明内容」。
 *
 * 声明是纯数据（字符串 / 数字 / 布尔 / 数组 / 普通对象），所以 JSON 比较足够；
 * 万一遇到不可序列化的东西，一律判为「不同」（宁可多重声明一次，也不要漏掉真改动）。
 *
 * @param left - 一份声明。
 * @param right - 另一份声明。
 * @returns 两者结构是否一致。
 */
function sameDeclaration(left, right) {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * 跨模块实例的声明交接表。
 *
 * ── 为什么不能只用模块级变量 ─────────────────────────────────────────────────
 *
 * 前面说过，改本包源码要靠给行 URL 加 `?v=N` 来换掉 ESM 缓存键。但那个做法有个
 * 副作用：`?v=N` 换的是**缓存键**，于是 Node 会返回一个**全新的模块实例** ——
 * 模块级的 `let release` 归零了，新实例根本不知道上一个实例还挂着一份声明。
 *
 * 而注册表对重复 id 是硬拒绝的：
 *
 *     if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
 *
 * 结果就是：第一次 bump 能把新模式装上去，第二次 bump 会因为「id 已被占用」而
 * 声明失败 —— preset 悄悄退回旧定义，而且只在日志里留一行 warn。
 *
 * 所以交接表挂在 `globalThis`（进程级、用 `Symbol.for` 取，跨模块实例稳定），
 * 新实例在声明前先把旧实例那份注销掉，形成一个可靠的接力。
 *
 * ── 表里为什么必须带 owner ───────────────────────────────────────────────────
 *
 * 光有 id -> 注销器 是不够的，会踩到一个很隐蔽的竞态：
 *
 *   1. 旧实例注册完成，表里是 disposeA；
 *   2. URL bump，新实例接管：注销 A、注册得到 disposeB，表里换成 disposeB；
 *   3. **旧实例的 fiber 这时才卸载** —— 它按 id 去表里查，查到的是 disposeB，
 *      于是把**新实例那份还活着的声明**给注销了。
 *
 * 表现就是：热替换之后 preset 先是好的，过一会儿悄悄消失，日志里什么都没有。
 *
 * 所以每项都记下它的 owner（本模块实例的身份令牌），并且：
 *   - **接管**时（新实例声明前）才允许注销别人留下的项；
 *   - **卸载自己**时只动 owner 是自己的项，别人活着的声明一律不碰。
 *
 * @returns 进程级的 presetId -> { owner, dispose } 映射。
 */
const HANDOFF_KEY = Symbol.for('dsh-multitask.preset-declarations')
function declarationHandoff() {
  let map = globalThis[HANDOFF_KEY]
  if (map === undefined) {
    map = new Map()
    globalThis[HANDOFF_KEY] = map
  }
  return map
}

/**
 * 校验一份 preset 声明。
 *
 * 在**声明之前**校验，而不是等注册表拒绝：这样错误信息指向的是本包自己的
 * composition，而不是一堆注册表内部诊断。composition 是手写的，写错一个
 * `group` 的形状就足以让整个 preset 挂载失败，而挂载失败的表现是
 * 「新会话里根本看不到这个模式」—— 一个很难反推根因的现象。
 *
 * @param candidate - 待校验的声明对象。
 * @throws 当声明不满足注册表契约时抛出，并指出具体是第几行。
 */
function assertDeclaration(candidate) {
  if (typeof candidate?.id !== 'string' || candidate.id.trim() === '') {
    throw new Error('dsh-multitask: the preset id must be a non-empty string')
  }
  if (!Array.isArray(candidate.plugins) || candidate.plugins.length === 0) {
    throw new Error('dsh-multitask: the preset composition declares no plugin rows')
  }
  for (const [index, row] of candidate.plugins.entries()) {
    const at = `row ${index + 1}`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`dsh-multitask: ${at} is not a plugin row (expected a map with a "name")`)
    }
    if (typeof row.name !== 'string' || row.name === '') {
      throw new Error(`dsh-multitask: ${at} names no plugin (a "name" string is required)`)
    }
    if (row.group === true && !Array.isArray(row.config)) {
      throw new Error(`dsh-multitask: group ${at} must hold a list of plugin rows`)
    }
  }
}

/**
 * 把插件 config 里的调整应用到减震器那一行。
 *
 * 减震器的保留集是使用者最可能想改的东西（例如把 `web_search` 打开、
 * 或者反过来把只读核对也关掉）。这些调整必须落在 preset **内部**那一行上，
 * 因为限制是在 preset 的 scope 里装的 —— 宿主插件跑到不了那里去。
 *
 * `presetId` 也必须一起对齐，且**是覆盖而不是追加**：它决定减震器认哪些会话是
 * 「自己的」。profile 允许把 `config.presetId` 改成别的值（同一个包装两个变体时
 * 就靠这个区分），那时声明 id 变了、composition 里那份字面量却没变 —— 两者一漂移，
 * 减震器就会认为「没有一个会话属于我」，于是**整个模式静默失效**（只在日志里留一句
 * warn）。所以这里强制把守卫行对齐到**实际用于注册的那个 id**。
 *
 * @param rows - 原始插件行。
 * @param keep - 追加到保留集的工具名。
 * @param extraDeny - 强制摘除的工具名（即使它在保留集里）。
 * @param enabled - 减震器总开关。
 * @param presetId - 实际注册用的 preset id；决定减震器接管哪些会话。
 * @returns 调整后的插件行（不改动入参）。
 */
function applyGuardOverrides(rows, keep, extraDeny, enabled, presetId) {
  const hasKeep = Array.isArray(keep) && keep.length > 0
  const hasDeny = Array.isArray(extraDeny) && extraDeny.length > 0
  const hasPresetId = typeof presetId === 'string' && presetId.trim() !== ''
  return rows.map((row) => {
    if (row.id !== 'coordinator-guard') return row
    const config = { ...(row.config ?? {}) }
    if (hasPresetId) config.presetId = presetId
    if (enabled !== undefined) config.enabled = enabled
    if (hasKeep) config.keep = [...(config.keep ?? []), ...keep]
    if (hasDeny) config.extraDeny = [...(config.extraDeny ?? []), ...extraDeny]
    return { ...row, config }
  })
}

/**
 * 装载宿主插件：声明自带的 Multitask preset，并在卸载时注销它。
 *
 * @param ctx - 宿主插件上下文。
 * @param config - 该行在 profile patch 里的 `config`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('dsh-multitask: disabled by configuration; the Multitask preset is not declared')
    return
  }

  if (mounted.has(ctx)) {
    ctx.logger?.info?.('dsh-multitask: already mounted on this context; skipping the duplicate declaration')
    return
  }
  mounted.add(ctx)

  const warn = (message) => ctx.logger?.warn?.(`dsh-multitask: ${message}`)

  /**
   * 当前生效的注销器，**仅**用于卸载时把自己那份声明注销掉。
   *
   * 注意它**不表示**「是否已成功声明」—— 注册表可能接受声明却不把注销器交回来
   * （见下面 `typeof dispose !== 'function'` 那个分支），那时这里恒为 undefined。
   * 要判断「已声明」请用 `declared`，两者不是一回事。
   */
  let release
  /** 已注销或已卸载后，晚到的注册表就绪回调不得再声明。 */
  let closed = false
  /**
   * 本模块实例的身份令牌 —— 交接表用它区分「谁挂的那份声明」。
   *
   * 必须是每实例一份的新对象（不是字符串）：两次 `?v=N` 之间的实例永远是不同的
   * 对象，所以旧实例在卸载时不会误认领新实例的声明。详见 declarationHandoff 的注释。
   */
  const ownerToken = {}

  /** 组装此刻要提交的声明。 */
  const build = () => {
    const presetId = typeof config?.presetId === 'string' && config.presetId.trim() !== ''
      ? config.presetId
      : presetMetadata.id
    const order = typeof config?.order === 'number' && Number.isFinite(config.order)
      ? config.order
      : presetMetadata.order

    const declaration = {
      id: presetId,
      name: presetMetadata.name,
      description: presetMetadata.description,
      order,
      plugins: applyGuardOverrides(
        // 用户的两项设置在这里进入 composition：
        //   · 「子代理使用的模型」—— 没有配置时传空数组 ⇒ 四类 worker 都不带
        //     `agentOptions` ⇒ 继承协调者模型，与加入本参数之前**逐字等价**
        //     （既有测试大量无参调用 buildPlugins）；
        //   · 「子代理并发上限」—— **字段缺席时传 `undefined`**，让 composition
        //     把守卫行的 `config.maxActive` 整个**省掉**（不是传一个数字），
        //     从而与「本功能加入之前」逐字等价。绝不能在这里兜底成某个默认数字：
        //     那会把「用户没设过」变成「用户设了 N」。
        buildPlugins({
          modelMap: readModelMap(config),
          maxActiveSubagents: readMaxActive(config),
        }),
        config?.keep,
        config?.extraDeny,
        config?.guardEnabled,
        // 减震器认「哪些会话是自己的」用的 id —— 必须与实际注册的 `id` 同源，
        // 否则 profile 改过 `config.presetId` 时两者会漂移，导致减震器静默失效。
        presetId,
      ),
    }
    // 先校验一次，让 composition 的错误在**声明时**就带有明确的行号。
    assertDeclaration(declaration)
    return declaration
  }

  /**
   * 注销一份声明器。
   * @param dispose - 注册表返回的注销器（可能来自本实例，也可能来自旧实例）。
   * @param why - 出错时的日志上下文。
   */
  const releaseDisposer = async (dispose, why) => {
    if (typeof dispose !== 'function') return
    try {
      await dispose()
    } catch (error) {
      warn(`${why}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 释放本实例持有的那份声明，并把交接表里 owner 是自己的项清掉。
   *
   * 只动 owner 是自己的项 —— 这条约束就是用来挡住那个竞态的：
   * 旧实例的 fiber 可能在新实例已经接管**之后**才卸载，此时表里那项属于新实例，
   * 旧实例绝不能去注销它（否则会把还活着的 preset 悄悄搞没）。
   */
  const releaseOwn = async () => {
    const own = release
    release = undefined
    await releaseDisposer(own, 'releasing the preset declaration failed')

    const handoff = declarationHandoff()
    for (const [key, entry] of handoff) {
      if (entry.owner !== ownerToken) continue
      handoff.delete(key)
      if (entry.dispose !== own) {
        await releaseDisposer(entry.dispose, `releasing this instance's declaration of "${key}" failed`)
      }
    }
  }

  /**
   * 接管：把**别人**留下的、同 id 的旧声明注销掉。
   *
   * 这是「新实例声明之前」必须做的一步 —— 注册表对重复 id 是硬拒绝的，不清干净
   * 新声明就装不上，preset 会悄悄退回旧定义，日志里只有一行 warn。
   *
   * 注意它**不会**碰 owner 是自己的项（那由 releaseOwn 负责），所以两个方向
   * 各管各的，不会互相误杀。
   *
   * @param presetId - 要接管的 preset id。
   */
  const takeOver = async (presetId) => {
    const handoff = declarationHandoff()
    const entry = handoff.get(presetId)
    if (entry === undefined || entry.owner === ownerToken) return
    handoff.delete(presetId)
    await releaseDisposer(entry.dispose, `releasing a stale declaration of "${presetId}" from a previous module instance failed`)
  }

  /**
   * 「正在声明中」标志。
   *
   * `declare()` 必须**自身幂等**，光靠调用点上的守卫挡不住：调用点那个守卫
   * 只挡得住**顺序**发生的重复调用（而且它当时用的判据本身还是错的，见下面
   * `declared` 的注释），而主路径那句 `void declare()` 又没有被 await
   * —— 于是注册表本就就绪时（常态），inject 的兜底回调会**并发**挤进来，
   * 第二次声明照样走到 register(同一个 id) →
   * 注册表硬拒绝（:503）→ 打出「is ALREADY registered by an older module instance」。
   *
   * 那条 warning 的坏法有两层：① 它把「自己撞自己」说成「旧模块实例占用」，
   * 给的 `Fix:` 是按旧实例占用设计的，照着做**也不会消失**；② 它是用户文档里
   * 「已知失效模式」的**唯一判据**，一旦每次加载都误报，这个判据本身就失效了。
   *
   * 所以把不变式收进 declare 自己：`declaring` 挡**并发**进入，
   * `declared` 挡**顺序**重复（已经成功声明过就不必、也不能再声明）。
   */
  let declaring = false

  /**
   * 是否**已经成功声明过**。
   *
   * 这个标志必须与 `release` 分开，因为两者**不等价**：注册表接受声明之后可能
   * 不返回注销器（`declare()` 里 `typeof dispose !== 'function'` 那个分支），
   * 走 warn 那一支时 `release` 恒为 undefined。
   * 若仍拿 `release !== undefined` 当「已声明」的判据，则在这条路径上它**永远为假**
   * —— 于是声明已 settle 之后兜底回调再进来（顺序重复，`declaring` 已复位，
   * 挡不住），又拿同一个 id 去注册 → 注册表硬拒绝（:503）→ 被 catch 误判成
   * 「被更早的模块实例占用」，打出上面那条照做也没用的误导 warning。
   *
   * 真实注册表在成功时**总是**返回注销器（dsh-agent-preset-registry:523
   * `return unregister`），所以触发它需要注册表违反自己的契约 —— 低概率的异常
   * 路径。但那条 warning 的可靠性正依赖「declare() 幂等」这条不变式，
   * 所以这里必须在**成功落库之后**（无论有没有注销器）立起这个标志。
   *
   * ── 为什么 `releaseOwn()` 之后**不复位** `declared` ──────────────────────────
   * `releaseOwn()` 有两个调用场景，都不需要复位：
   *
   *   ① `declare()` 开头「先释放自己上一份」—— 由上面的守卫可推：能走到那一行
   *      必然 `declared === false`（否则 declare 早就 return 了），所以在这里复位
   *      是**空操作**，什么也放行不了、也什么都不会挡住。
   *   ② 卸载时的所有权注销 —— 那条路径在下面的 `ctx.effect(() => () => ...)` 里
   *      **先**置了 `closed = true`，而 `closed` 是守卫里排第一位、且**从不复位**的
   *      判据，之后任何进入都被它挡住。所以此处复位与否根本不影响行为，复位反而
   *      更危险：万一日后有人加一条「卸载后重挂」的路径，`declared` 被清掉就会
   *      放行二次注册，又撞回重复 id。
   *
   * 结论：`declared` 一旦置 true 就**不再复位**（`closed` 生命周期与它一致）。
   * 这不会锁死兜底重试 —— 兜底重试针对的是「注册表还没出现 / composition 校验
   * 不过」这两条**失败早退**路径，它们**根本走不到置位**，`finally` 里复位的
   * `declaring` 足以放开重试；真正置位意味着声明已经成功落库，本就不该再注册。
   */
  let declared = false

  /**
   * 当前**已成功落库**的那份声明。
   *
   * 只用于两件事：① 判断一次设置改动是否真的改变了内容（避免无谓的注销/重注册）；
   * ② 重注册失败时**回滚**回这一份。它存的是纯数据，所以可以直接深比较 / 重注册。
   */
  let lastDeclaration

  /**
   * 「正在重新声明中」标志 —— 独立于 `declaring` / `declared`。
   *
   * ── 为什么不能复用 `declaring` ───────────────────────────────────────────────
   *
   * `declaring` 的语义是「首次声明正在进行」，它与 `declared` 一起构成
   * 「**声明至多成功一次**」这条不变式。而重新声明的前提恰恰是 `declared === true`
   * —— 若共用同一个标志，`declare()` 开头那句 `if (declaring || declared) return`
   * 会把重新声明直接挡掉（`declared` 为真），或者反过来破坏首次声明的幂等。
   * 两者要挡的东西不同，所以必须是两个标志。
   *
   * 重声明入口自己也会先挡 `declaring`（首次声明还没结束时不去插队）。
   */
  let redeclaring = false

  /** 声明 preset（幂等：先接管同 id 的旧声明，再注册）。 */
  const declare = async () => {
    if (closed || declaring || declared) return
    declaring = true
    try {
      const registry = (() => {
        try {
          return ctx.get('agentPresets')
        } catch {
          return undefined
        }
      })()

      if (registry === undefined || typeof registry.register !== 'function') {
        // 不静默失败：使用者需要知道「模式没出现」是因为注册表不在，
        // 而不是因为本包写错了。
        warn('the agent-preset registry is unavailable in this deployment; the Multitask preset is NOT available. Install a profile that composes @deepseek-ai/dsh-agent-preset-registry.')
        return
      }

      let declaration
      try {
        declaration = build()
      } catch (error) {
        warn(`the bundled composition is invalid: ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      // 必须在**注册之前**接管同 id 的旧声明：注册表对重复 id 是硬拒绝的，
      // 清理不干净新声明就装不上（而且只会留一行 warn，非常难查）。
      await releaseOwn()
      await takeOver(declaration.id)

      try {
        const dispose = await registry.register(declaration)
        // 落库成功 —— **无论注册表有没有把注销器交回来**，本实例都已经声明过了，
        // 立刻立起 `declared`，好让声明 settle 之后才到的兜底回调被挡住。
        declared = true
        lastDeclaration = declaration
        if (typeof dispose !== 'function') {
          warn('the preset registry accepted the declaration but returned no disposer; the preset may linger after unload')
        } else {
          release = dispose
          // 记进进程级交接表，并标好 owner，好让下一个模块实例能接管、也让自己
          // 在卸载时只认领自己这一项。
          declarationHandoff().set(declaration.id, { owner: ownerToken, dispose })
        }
        ctx.logger?.info?.(`dsh-multitask: preset "${declaration.id}" declared — select 「${presetMetadata.name}」 for a new session`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 「重复 preset id」是本插件**唯一**会静默失灵的故障模式，而它的外在表现
        // 极具误导性：模式看起来还在，只是内容停留在旧版本 —— 改了 composition
        // 却「什么都没发生」。实测中就因为这个原因绕了很久。
        //
        // 触发条件是：桌面已经跑着一个由**更早的模块实例**注册的声明，而那个实例
        // 早于本包的交接表机制，所以新实例既找不到它、也无法注销它。
        // 这时必须把补救动作直接写进日志，而不是只说一句 "declaring failed"。
        if (/duplicate agent preset/i.test(message)) {
          warn(
            `preset "${declaration.id}" is ALREADY registered by an older module instance, so this ` +
              `declaration was rejected and the session keeps the PREVIOUS composition. ` +
              `Fix: remove the dsh-multitask row from the profile patch, let the app settle, then add it back. ` +
              `(Underlying error: ${message})`,
          )
        } else {
          warn(`declaring the preset failed: ${message}`)
        }
      }
    } finally {
      // 复位是**必需**的，不是防御性冗余：早退的两条路径（注册表还没出现、
      // composition 校验不过）都必须把守卫放开，否则 inject 的兜底回调就再也补不上 ——
      // 「注册表比本插件晚出现」正是那条兜底路径存在的全部理由。
      declaring = false
    }
  }

  /**
   * 重新声明 preset —— 让**设置里的模型映射**真正进入 composition。
   *
   * ── 为什么必须重新声明，而不是「热更新配置」───────────────────────────────────
   *
   * 委派行的 `config.agentOptions` 是在 preset **挂载时**被 `dsh-tool-subagent`
   * 的 `apply()` 闭包捕获的（见 composition 里 `workerAgentOptions` 的注释）。
   * 设置面板改的是本插件自己的 volatile 字段，loader 只会把新值**原地**写进
   * 那个引用（`_commitVolatile`），**不会**重新跑 `apply()`，更不会重新挂载 preset
   * 的那一代插件树。所以要让新值落到委派行上，只能由本函数主动：
   * **注销自己那份声明，再用新设置注册一份**。
   *
   * ── 为什么这样注销不会打断正在跑的会话（已从源码确证）──────────────────────
   *
   * 注册表用**引用计数代**管理：`unregister()` 只把该代标成 `retired`，
   * 真正拆树要等 `collect()`，而它开头就是 `if (!generation.retired || generation.users !== 0) return`。
   * 正在用这个 preset 的会话持着 `users > 0`，所以它们那一代**不会被拆**，
   * 会话继续在旧代上跑；只有**此后新建的会话**才会绑到新代。
   *
   * 反过来说，这也正是本功能的**生效边界**：已开跑的会话不会换模型。
   *
   * ── 为什么与 `declare()` 分开，且不复位 `declared` ───────────────────────────
   *
   * `declaring` / `declared` 共同保证「声明至多成功一次」，那是首次声明的幂等性，
   * 不能动。重新声明的前提恰恰是 `declared === true`，所以它用**独立的**
   * `redeclaring` 标志，并且**不**经过 `declare()`（否则会被它开头的守卫直接挡掉）。
   * `declared` 保持为 true 是正确的：本实例确实已成功声明过。
   *
   * ── 失败处理：响亮告警 + 把旧声明装回去 ──────────────────────────────────────
   *
   * 新设置坏掉时**绝不能**让整个模式消失。所以顺序是「先算新声明（含校验），
   * 再注销旧的」，且注册失败时立即尝试重新注册**上一份**声明。
   */
  const redeclare = async () => {
    // 没成功声明过就交给 `declare()` 那条路径，本函数不越权；
    // `declaring` 为真说明首次声明还没落定，这时插队会和它抢同一个 id。
    if (closed || !declared || redeclaring || declaring) return
    redeclaring = true
    try {
      const registry = (() => {
        try {
          return ctx.get('agentPresets')
        } catch {
          return undefined
        }
      })()
      if (registry === undefined || typeof registry.register !== 'function') return

      // 循环直到「当前设置」与「已落库的声明」一致。
      // 之所以要循环：用户可能在我们 await 注册的期间又改了一次设置，
      // 那样第二轮就会带上最新的值。正常情况下第二轮就因内容相同而退出。
      while (!closed) {
        let declaration
        try {
          // 先算（`build()` 内含 assertDeclaration）—— 坏 composition 在这里就抛，
          // 此时**还没碰**旧声明，等于零影响。
          declaration = build()
        } catch (error) {
          warn(`the bundled composition is invalid, so the settings change was NOT applied: ${error instanceof Error ? error.message : String(error)}`)
          return
        }

        if (lastDeclaration !== undefined && sameDeclaration(lastDeclaration, declaration)) return

        const previous = lastDeclaration
        // 注销自己那份（只动 owner 是自己的项，别的实例的声明一律不碰）。
        await releaseOwn()

        try {
          const dispose = await registry.register(declaration)
          lastDeclaration = declaration
          if (typeof dispose === 'function') {
            release = dispose
            declarationHandoff().set(declaration.id, { owner: ownerToken, dispose })
          } else {
            warn('the preset registry accepted the re-declaration but returned no disposer; the preset may linger after unload')
          }
          ctx.logger?.info?.(`dsh-multitask: preset "${declaration.id}" re-declared with the current Subagent model settings — it applies to sessions created from now on`)
          // 继续循环：若期间设置又变了，这一轮会把最新值补上；没变则下一轮直接 return。
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warn(`re-declaring the preset failed, so the model settings were NOT applied: ${message}`)

          // ★ 关键：把**旧声明**装回去。不能让一个坏设置把整个模式搞没。
          if (previous !== undefined) {
            try {
              const restore = await registry.register(previous)
              lastDeclaration = previous
              if (typeof restore === 'function') {
                release = restore
                declarationHandoff().set(previous.id, { owner: ownerToken, dispose: restore })
              }
              warn(`the previous composition of "${previous.id}" was restored, so Multitask keeps working with the settings it had before this change`)
            } catch (restoreError) {
              // 连回滚都失败：这是最坏情况，必须让人一眼看见（模式会消失）。
              warn(
                `could NOT restore the previous composition of "${previous.id}" — the Multitask preset is now ` +
                  `NOT declared and will be missing from the new-session list until the app reloads. ` +
                  `(Restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)})`,
              )
            }
          }
          return
        }
      }
    } finally {
      redeclaring = false
    }
  }

  // 主路径：注册表已就绪时立即声明。
  void declare()

  // 兜底路径：注册表比本插件晚出现时，等它出现再声明一次。
  // `ctx.inject` 的回调由 Cordis 在服务可用时调用一次，且随本插件卸载而失效。
  //
  // 这里的守卫与 declare() 内部那条**不是**重复，两者挡的东西不同：
  //   · 这一条是**调用点**上的廉价早退 —— 已经声明过 / 已卸载就没必要再起一个
  //     异步帧。它只看得见「稳定态」（declared / closed），**看不见** `declaring`
  //     那种瞬态，所以它挡不住并发自撞，也不该假装能挡。
  //   · declare() 里那一条才是**不变式**本体 —— 无论谁从哪个调用点进来，
  //     它都必须自己兜住并发（declaring）与顺序（declared）两种重复。
  //
  // 早先这里写的是 `release === undefined`，那是个错判据：它只在注册表**给出了**
  // 注销器时才为假，而「接受声明但不给注销器」那条路径上它恒为真 —— 于是调用点
  // 放行、declare() 内部也放行，二次注册就漏出去了。判据必须与 declare() 一致。
  try {
    ctx.inject(['agentPresets'], () => {
      if (!declared && !closed) void declare()
    })
  } catch {
    // 环境不支持 inject 时不影响主路径；主路径已经试过一次。
  }

  // ── 设置变化 → 重新声明 ─────────────────────────────────────────────────────
  //
  // 设置面板把新值写进本插件的 volatile 字段后，loader 的 `_commitVolatile()`
  // 会**原地**更新那个引用，并在**本 fiber 自己的 ctx** 上发出
  // `loader/volatile-update`（`cordis-plugin-loader/lib/index.js:417-423`：
  // `const self = Object.create(fiber.ctx); self[Context.filter] = (owner) => owner.fiber === fiber;
  //  fiber.ctx.emit(self, "loader/volatile-update", paths)`）——
  // 过滤条件是「监听器必须挂在这个 fiber 上」，而 `apply()` 拿到的 `ctx` 正是它，
  // 所以这里的监听器会收到。
  //
  // 收到后不做判断直接走 `redeclare()`：它自己会算一遍新声明并与已落库的那份比较，
  // 内容没变就立刻返回。这样读起来简单，也避免在这里重复一遍「什么算变化」的逻辑。
  //
  // `ctx.on` 返回的注销器由 fiber 的 effect 自动管理，卸载时自动摘掉，
  // 不需要额外登记。
  try {
    ctx.on('loader/volatile-update', () => {
      void redeclare()
    })
  } catch {
    // 极简 ctx（例如本地校验里的假 ctx）可能没有 `on`；那不是致命情况 ——
    // 此时设置改动不会自动生效，但模式本身照常声明与工作。
  }

  // 所有权：本实例卸载时只注销**自己**那份声明。
  //
  // 刻意不去碰交接表里属于别人的项：旧实例的 fiber 可能在新实例已经接管之后
  // 才卸载，那时如果按 id 去注销，就会把新实例还活着的声明搞没 ——
  // 表现是热替换后 preset 先好后消失，且无任何日志。
  ctx.effect(() => () => {
    closed = true
    return releaseOwn()
  }, 'dsh-multitask: preset declaration')
}
