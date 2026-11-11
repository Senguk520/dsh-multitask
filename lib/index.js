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
const providersSpecifier = new URL('./worker-providers.js', import.meta.url)
const entryQuery = new URL(import.meta.url).search
if (entryQuery !== '') {
  compositionSpecifier.search = entryQuery
  // 同一个理由：本文件在源码 checkout 路径下也可能被 `?v=N` 换缓存键，
  // 而相对 import **不继承**入口的 query —— 不传播的话改了 `worker-providers.js`
  // 只会从旧缓存取回旧模块，且不报错。
  providersSpecifier.search = entryQuery
}
const composition = await import(compositionSpecifier.href)
const { registerWorkerProviders } = await import(providersSpecifier.href)

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
// volatile 字段刻意**嵌套**在根下面（`subagentModels` 与 `watchdog` 各一个节点）、
// 而不是把根做成 volatile：根若为 volatile，`resolveConfig()` 交回的就是一个
// `{get()}` 引用，`apply()` 里对 `config.enabled` / `config.keep` / `config.extraDeny` /
// `config.guardEnabled` / `config.presetId` / `config.order` 的读取会**全部变成
// undefined**，减震器保留集与总开关就此静默失效。官方
// `subagent-model-selection-settings` 用的正是同样的嵌套写法。

/** 设置字段名：`<类型键> -> { subagentType, provider, model }` 的数组。 */
const MODEL_MAP_FIELD = 'subagentModels'

/** 模型映射字段的键名；导出供本地回归（`test/repo-consistency.mjs`）断言它真的是 volatile 的。 */
export const MODEL_MAP_FIELD_NAME = MODEL_MAP_FIELD

/**
 * 设置字段名：`{ stallTimeoutMs, tickMs, mode }` —— 子代理停滞看门狗的阈值。
 *
 * ⚠️ 它和 `subagentModels` 一样**必须**是 volatile 字段（节点上带 `meta.volatile`）：
 * 面板每改一次都写这个键，若它被判成普通配置变更，loader 会**重启本插件**，撞上
 * `mounted` 守卫后不再声明 —— 表现是「Multitask 模式从新会话列表消失」。
 *
 * 单位**只有毫秒**：面板显示秒、写回毫秒，换算全部在客户端读/写各一处完成；
 * 本文件、composition 与看门狗模块看到的永远是毫秒。
 */
const WATCHDOG_FIELD = 'watchdog'

/** 看门狗字段的键名；导出供本地回归（`test/repo-consistency.mjs`）断言它真的是 volatile 的。 */
export const WATCHDOG_FIELD_NAME = WATCHDOG_FIELD

/**
 * 设置字段名：`{ headroomTokens?, maxTokens?, retainTokens?, thresholdRatio?, retainRatio? }`
 * —— 本 preset 给子代理 realm 的**默认压缩预算**，注入 preset 内部
 * `compaction-basic` 那一行的 `config`；字段缺席时用 `COMPACTION_DEFAULTS`。
 *
 * ⚠️ 与另外两个字段一样**必须**是 volatile（节点上带 `meta.volatile`）：否则每次
 * 「改完即写」都会重启本插件的 fiber，撞上 `mounted` 守卫后不再声明 —— 表现同样
 * 是「Multitask 模式从新会话列表消失」。
 *
 * ── 为什么这份预算由本 preset 自己给出（issue #5）────────────────────────────
 *
 * 本 preset 把压缩放在 `isolate: { compaction: true }` 的组里，那是**独立 realm**，
 * 组内的 `compaction-basic` 只认这一行 `config` 里的值。压力预算是
 * （`contextWindow − 请求输出预留 − headroomTokens`），在 `O + H ≥ W` 时降到零以下
 * （O = 请求输出预留，H = headroom，W = 窗口），此时 `compaction-basic` 直接抛
 * `TargetPressureConfigError`；条件是相对的，不取决于窗口绝对值。所以本 preset
 * 自带一组按「常见窗口 + 常见输出预留」挑的默认值（`composition.mjs` 的
 * `COMPACTION_DEFAULTS`）：`headroomTokens: 8192`、摘要上限 `maxTokens: 8192`，
 * **两者成对相等**。相等是刻意的：`maxTokens` 的语义（也是它在上游的默认行为）
 * 就是跟随 `headroomTokens` ——「给摘要预留多少空间 / 摘要最多占多少空间」；只有
 * 两者相等，一次摘要请求才永远装得进预留空间，不会压完立刻二次触发。
 *
 * 背景（只作对比）：上游 `compaction-basic` 自身的默认是 `headroomTokens: 65536`、
 * `maxTokens` 跟随它，那是按大窗口挑的一组数；本 preset 不用这组值。本字段在本
 * preset 里因此只是**手动覆盖**的入口：不填，就是上面那组默认预算。
 *
 * 单位是 **token**（不是毫秒）：这几个值原样交给 `compaction-basic`，本包不做换算。
 */
const COMPACTION_FIELD = 'compaction'

/** 压缩字段的键名；导出供本地回归断言它真的是 volatile 的。 */
export const COMPACTION_FIELD_NAME = COMPACTION_FIELD

/** 超时处理三态：停掉 worker / 只记录 / 关闭看门狗。 */
const WATCHDOG_MODES = ['interrupt', 'log', 'off']

/** 缺省值（**毫秒**）。字段缺失或非法时落回这里，绝不抛错。 */
const WATCHDOG_DEFAULTS = Object.freeze({ stallTimeoutMs: 300000, tickMs: 30000, mode: 'interrupt' })

/**
 * 允许范围（**毫秒**）。
 *
 * 越界时**钳制**而不是丢弃：用户填了一个 10 分钟阈值却因为手滑多打一位数，
 * 落回默认 5 分钟比落回 5 分钟再让他猜原因更难解释。负数 / NaN / 字符串是
 * 「根本不是时长」，一律落回默认。
 */
const WATCHDOG_RANGE = Object.freeze({
  stallTimeoutMs: Object.freeze({ min: 5000, max: 3600000 }),
  tickMs: Object.freeze({ min: 1000, max: 300000 }),
})

/**
 * ⚠️ **本插件不再有自己的并发上限字段** —— 这是一次**删除**，别再把它加回来。
 *
 * 早先这里有一个 `maxActiveSubagents`（`multitask` 命名空间下的第二个 volatile 字段），
 * 配合「Multitask 设置页」那张并发卡，宣称「本模式专属的更低上限」。它以「字段缺席 ⇒
 * 不限制」表达「不限制」那一档。
 *
 * 它被删掉的原因是**它是假的**：真正决定「同时能跑几个」的是**宿主**
 * `subagent.maxActiveSubagents`（见下），本插件那个字段只决定**本插件自己那个守卫**
 * 要不要装 —— 而守卫的计数口径与宿主不同（它把一次性子代理也算进去、释放时机更早）。
 * 于是「本模式设不限制」的用户以为没有上限，实际上依然被宿主那层的默认 8 卡住；
 * 而两处同时有值时，又是两套账在执行同一个数字，谁先拒绝取决于运行时细节。
 *
 * 用户的决定（逐字）：「就不需要额外新增一个字段来单独管理 Multitask 的并发子代理上限。
 * 都统一使用宿主层限制的子代理数。」所以现在**只有一个值**：
 *
 *     subagent.maxActiveSubagents（宿主 `dsh-subagent` 那一行的 config）
 *
 * 设置面板里**两处 UI**（「设置 → Multitask」与「设置 → 通用设置」）编辑的是
 * **同一个字段**，因此改一处另一处立刻跟着变 —— 这正是需求要的效果。
 *
 * 本插件不再有任何并发相关的字段、守卫或行；执行完全交给宿主。
 */

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
const SCHEMA_UID = { string: 1, route: 2, routes: 3, root: 4, number: 5, watchdog: 6, compaction: 7 }

/**
 * 该 schema 的 `{uid, refs}` 图。
 *
 * 形状与真 schemastery 的 `toJSON()` 产物一致（见 `_probe_*` 里对照过的输出）：
 * `refs` 是 uid → 节点 的映射，节点之间用 uid 互相引用。
 *
 * ⚠️ 名字里的 `MODEL_` 是历史遗留（本图曾同时承载一个并发上限字段，那个字段已删除）。
 * 刻意**不改名**，因为 `toJSON()` 直接把它交给 `new z(...)` 水合，改名只是噪音。
 */
const MODEL_SCHEMA_REFS = {
  [SCHEMA_UID.string]: { type: 'string' },
  [SCHEMA_UID.number]: { type: 'number' },
  [SCHEMA_UID.route]: {
    type: 'object',
    dict: {
      subagentType: SCHEMA_UID.string,
      provider: SCHEMA_UID.string,
      model: SCHEMA_UID.string,
      // ★ 缺了这一行，`reasoningEffort` 会在**校验阶段**就被 schema 剥掉：
      // 用户在 YAML 里写了、面板里选了，值也到不了 `buildPlugins()`，
      // 委派行拿到的 `agentOptions` 里没有它，模型于是用默认强度（issue #4）。
      // schemastery 的 object 节点只保留 `dict` 里声明过的键 —— 这是它的语义，
      // 不是 bug，所以「支持一个字段」与「在 schema 里声明它」是同一件事。
      reasoningEffort: SCHEMA_UID.string,
    },
  },
  [SCHEMA_UID.routes]: {
    type: 'array',
    // ★ 三个 volatile 字段之一（模型映射表）。面板因此可读可写，
    // 且改动**不会重启本插件**。
    meta: { volatile: true },
    inner: SCHEMA_UID.route,
  },
  [SCHEMA_UID.watchdog]: {
    type: 'object',
    // ★ 三个 volatile 字段之一（子代理停滞看门狗的阈值）。
    //
    // 整块对象 volatile：面板每次改一项都会把**整个对象**一次写下去（见 client.js），
    // loader 的 `equal()` 一看到这个节点的 `meta.volatile` 就整棵子树判为「无变化」，
    // 于是保存只更新 volatile 引用、不重启 fiber。
    //
    // ⚠️ 子字段**刻意不带** volatile：schemastery 的
    // `validateVolatileSchema()` 明确禁止「volatile 里再套 volatile」
    // （"volatile fields require a fixed object path without an enclosing volatile field"）。
    // 一个对象节点自身带 volatile 是允许的 —— `Schema.resolve()` 会把它的副本
    // 去掉 volatile 后正常解析，再用 `createVolatile()` 包成引用。
    meta: {
      volatile: true,
      description: 'Subagent stall watchdog: stall timeout, check interval, and what to do on a stall.',
    },
    dict: {
      stallTimeoutMs: SCHEMA_UID.number,
      tickMs: SCHEMA_UID.number,
      mode: SCHEMA_UID.string,
    },
  },
  [SCHEMA_UID.compaction]: {
    type: 'object',
    // ★ 第三个 volatile 字段（子代理 realm 的压缩预算）。
    //
    // 整块对象 volatile，理由与 `watchdog` 逐字相同：面板改一项就写整块，loader 的
    // `equal()` 看到 `meta.volatile` 就判「无变化」，于是只换引用、不重启 fiber。
    // 子字段同样**不带** volatile（`validateVolatileSchema()` 禁止嵌套 volatile）。
    //
    // 五个键就是 `compaction-basic` 里与预算有关的那一组（见
    // `normalizeCompactionSettings()`）。字段缺席 = 用本包的缺省预算
    // （`COMPACTION_DEFAULTS`），这里不补默认，好让面板能区分「没写」与「写了」。
    meta: {
      volatile: true,
      description: 'Compaction budget injected into the Subagent realm: headroom, summary size, and policy ratios.',
    },
    dict: {
      headroomTokens: SCHEMA_UID.number,
      maxTokens: SCHEMA_UID.number,
      retainTokens: SCHEMA_UID.number,
      thresholdRatio: SCHEMA_UID.number,
      retainRatio: SCHEMA_UID.number,
    },
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
      [WATCHDOG_FIELD]: SCHEMA_UID.watchdog,
      [COMPACTION_FIELD]: SCHEMA_UID.compaction,
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
 * @returns `{ subagentType, provider, model, reasoningEffort? }` 数组，只含合法条目。
 */
function normalizeModelList(raw) {
  const list = raw !== null && typeof raw === 'object' && Array.isArray(raw[MODEL_MAP_FIELD])
    ? raw[MODEL_MAP_FIELD]
    : []
  const cleaned = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { subagentType, provider, model, reasoningEffort } = entry
    // 未知类型一并丢弃：面板只会给这四类，而手改的 YAML 写错键名时，
    // 留着它没有意义（composition 侧也会再过滤一次）。
    if (typeof subagentType !== 'string' || !WORKER_MODEL_TYPES.includes(subagentType)) continue
    if (typeof provider !== 'string' || provider.trim() === '') continue
    if (typeof model !== 'string' || model.trim() === '') continue
    const route = { subagentType, provider, model }
    // ★ `reasoningEffort` 必须**透传**，不能像早先那样重建对象时只挑三个键：
    // 那是 issue #4 的第二处丢弃点（第一处是 schema 的 `dict` 没声明它）。
    // 语义与 composition 侧一致：只接受非空串，其余一律视为「用模型默认强度」，
    // 于是字段**缺席**而不是带着一个空值 —— 上游 `resolveChildAgentOptions()`
    // 正是按「字段在不在」决定要不要覆盖继承来的强度。
    if (typeof reasoningEffort === 'string' && reasoningEffort.trim() !== '') {
      route.reasoningEffort = reasoningEffort
    }
    cleaned.push(route)
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
 * 配置的变更被判成「非 volatile」，从而重启本插件（后果见上）。所以这里**每个**字段
 * 都带 `meta.volatile`，并在 `validate` 里换成 volatile 引用：
 * `subagentModels`（模型映射）、`watchdog`（停滞看门狗阈值）与
 * `compaction`（子代理 realm 的压缩预算）。
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
      base[WATCHDOG_FIELD] = createVolatile(normalizeWatchdogSettings(raw?.[WATCHDOG_FIELD]))
      base[COMPACTION_FIELD] = createVolatile(normalizeCompactionSettings(raw?.[COMPACTION_FIELD]))
      // ⚠️ 这里**刻意不碰** `maxActiveSubagents`（它可能残留在用户的 profile 里，见上）。
      // 那个键现在由宿主 `dsh-subagent` 那一行拥有；本插件既不声明、不校验、也不读它。
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
  const value = unwrapVolatile(config?.[MODEL_MAP_FIELD])
  return Array.isArray(value) ? value : []
}

/**
 * 读出一个**可能是** volatile 引用的原始值。
 *
 * `resolveConfig()` 交回的配置里，声明的 volatile 字段已经是 `{get()}` 引用；
 * 而手写的 profile / 测试入参里通常就是普通值。两种形状都要吃得下。
 *
 * @param raw - 原始值。
 * @returns 当前快照（不是引用时原样返回）。
 */
function unwrapVolatile(raw) {
  return raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
}

/**
 * 把一个毫秒数收敛进 `[min, max]`。
 *
 * 缺省 / 非数字 / 非有限数 / **负数和 0** 一律落回 `fallback`：它们表达的是
 * 「根本没有这个时长」，硬钳到下限只会让人以为配置被读成了别的意思。
 * 正的越界值（例如多打一位数）则**钳制**，不丢弃用户的意图。
 *
 * @param value - 原始值。
 * @param range - `{ min, max }`（毫秒）。
 * @param fallback - 落回值（毫秒）。
 * @returns 一个整数毫秒。
 */
function clampWatchdogMs(value, range, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/**
 * 把任意输入清洗成规整的看门狗设置。
 *
 * ⚠️ **永不抛错、只落默认 / 钳制**：它跑在 fiber 的配置解析路径上（`validate()` 里），
 * 抛错等于本插件起不来。也正因为如此，它和 `normalizeModelList` 一样是纯清洗：
 * 不读环境、不写任何东西，供测试直接 import。
 *
 * 单位始终是**毫秒** —— 面板上的「秒」只在浏览器那一侧换算（读：`/1000`，
 * 写：`*1000`），本函数不做任何秒/毫秒换算。
 *
 * @param raw - 原始值，可能是任何东西（含 volatile 引用）。
 * @returns `{ stallTimeoutMs, tickMs, mode }`。
 */
export function normalizeWatchdogSettings(raw) {
  const source = unwrapVolatile(raw)
  const value = source !== null && typeof source === 'object' && !Array.isArray(source)
    ? source
    : emptyRecord()
  return {
    stallTimeoutMs: clampWatchdogMs(
      value.stallTimeoutMs,
      WATCHDOG_RANGE.stallTimeoutMs,
      WATCHDOG_DEFAULTS.stallTimeoutMs,
    ),
    tickMs: clampWatchdogMs(value.tickMs, WATCHDOG_RANGE.tickMs, WATCHDOG_DEFAULTS.tickMs),
    mode: WATCHDOG_MODES.includes(value.mode) ? value.mode : WATCHDOG_DEFAULTS.mode,
  }
}

/**
 * 从 `apply()` 收到的（已解析的）配置里取出看门狗设置。
 *
 * `config[WATCHDOG_FIELD]` 是上面那个 volatile 引用，所以这里取的是**当前**快照。
 * 缺失 / 非法一律由 `normalizeWatchdogSettings()` 收敛成默认值 —— `apply()` 永远
 * 拿到一个可以直接塞进 `buildPlugins({ watchdog })` 的对象。
 *
 * @param config - `apply()` 的第二参数。
 * @returns `{ stallTimeoutMs, tickMs, mode }`（毫秒）。
 */
export function readWatchdog(config) {
  return normalizeWatchdogSettings(config?.[WATCHDOG_FIELD])
}

/**
 * 可以透传给 `compaction-basic` 的字段及其判据 —— **与 `composition.mjs` 里那张表
 * 逐字同义**（那边是组装时的第二道收敛，这边是配置解析时的第一道）。
 *
 * 令牌（`headroomTokens` / `maxTokens` / `retainTokens`）要求正整数；
 * 比例（`thresholdRatio` / `retainRatio`）要求 `(0, 1]`。
 */
const COMPACTION_FIELDS = Object.freeze({
  headroomTokens: (value) => Number.isSafeInteger(value) && value > 0,
  maxTokens: (value) => Number.isSafeInteger(value) && value > 0,
  retainTokens: (value) => Number.isSafeInteger(value) && value > 0,
  thresholdRatio: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1,
  retainRatio: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1,
})

/**
 * 把任意输入清洗成规整的压缩预算。
 *
 * ⚠️ **永不抛错、只丢弃**（与 `normalizeModelList` / `normalizeWatchdogSettings`
 * 同一条纪律：这里跑在 fiber 的配置解析路径上，抛错等于本插件起不来）。
 *
 * 返回值**只包含用户真的写了的字段**，这里不补默认值 —— 缺省预算由组装层
 * （`composition.mjs` 的 `normalizeCompaction()` + `COMPACTION_DEFAULTS`）统一给出，
 * 清洗与缺省分开，面板才能区分「用户没写」与「用户写了某个值」。
 *
 * @param raw - 原始值，可能是任何东西（含 volatile 引用）。
 * @returns `{ headroomTokens?, maxTokens?, retainTokens?, thresholdRatio?, retainRatio? }`。
 */
export function normalizeCompactionSettings(raw) {
  const source = unwrapVolatile(raw)
  const value = source !== null && typeof source === 'object' && !Array.isArray(source)
    ? source
    : emptyRecord()
  const cleaned = emptyRecord()
  for (const [field, isValid] of Object.entries(COMPACTION_FIELDS)) {
    const candidate = value[field]
    if (isValid(candidate)) cleaned[field] = candidate
  }
  return cleaned
}

/**
 * 从 `apply()` 收到的（已解析的）配置里取出压缩预算。
 *
 * @param config - `apply()` 的第二参数。
 * @returns 供 `buildPlugins({ compaction })` 消费的对象；没有配置时是空对象。
 */
export function readCompaction(config) {
  return normalizeCompactionSettings(config?.[COMPACTION_FIELD])
}

// ── 模型目录预取：上下文窗口 → `modelPolicies`（供组装层换算压缩预算）──────────
//
// 压缩预算若要按模型窗口来算，窗口本身只有 DSH 的 `llm` 服务知道。于是这里在**首次
// 声明之后**异步枚举一次目录，把每个可用模型的窗口收集成快照，交给
// `buildPlugins({ modelPolicies })`；真正的换算（headroom / maxTokens）在组装层做，
// 本文件只负责**产出这份数据**。
//
// 三条硬约束：
//   ① **不阻塞首次声明** —— `build()` 是同步的，声明必须立刻落地，所以首份声明用空
//      快照（与加入本功能之前逐字等价），预取完成后内容真的变了才 `redeclare()`。
//   ② **用户值优先** —— 用户只要在压缩预算里填了任一项，就完全不生成这份快照，
//      免得组装层的按模型策略把用户手写的数字覆盖掉。
//   ③ **失败一律静默回落** —— 目录读不到、单个 provider / 模型抛错、超时，都只告警并
//      保留已有结果。模式消失远比预算不精确严重。

/** `modelPolicies` 的条数上限 —— 目录异常大时不能把声明撑爆。 */
const MODEL_POLICY_LIMIT = 256
/** 整轮目录枚举的总时限（毫秒）；到点就用已有结果。 */
const MODEL_DIRECTORY_TIMEOUT_MS = 10_000
/** 单个模型的解析时限（毫秒）。 */
const MODEL_INFO_TIMEOUT_MS = 3_000

/**
 * 判断「用户是否显式配置了压缩预算」。
 *
 * `readCompaction()` 只返回用户**真的写了**的字段（缺省值由组装层统一补），所以
 * 空对象 == 用户没配。用 `Object.keys().length` 而不是 `=== undefined` 判断，是因为
 * 用户可能只填了五项里的任意一项。
 *
 * @param compaction - `readCompaction(config)` 的返回值。
 * @returns 用户填了任一项时为 true。
 */
function hasConfiguredCompaction(compaction) {
  return (
    compaction !== null &&
    typeof compaction === 'object' &&
    !Array.isArray(compaction) &&
    Object.keys(compaction).length > 0
  )
}

/**
 * 把一条 `llm.resolveModelInfo()` 的结果收敛成 policy；窗口不合法时返回 `undefined`。
 *
 * 只产出**结构合法**的数据：preset 行 config 被上游拒收时注册表**不会回滚**，只会把
 * preset 打成 broken。所以宁可少一条策略，也不传一个可疑值。
 *
 * @param provider - 已清洗的 provider id。
 * @param model - 已清洗的 model id。
 * @param info - `resolveModelInfo()` 的返回值。
 * @returns `{ provider, model, contextWindow, defaultMaxTokens? }` 或 `undefined`。
 */
function modelPolicyOf(provider, model, info) {
  const contextWindow = info?.context?.contextWindow
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined
  const policy = { provider, model, contextWindow }
  const defaultMaxTokens = info?.defaultMaxTokens
  // 输出预留是**可选**的：缺席按 0 处理；一旦给了就必须是非负整数，否则**整条丢弃**。
  // 拿不准的数当成 0 会把预算算大，而算大正是会把上游 `O + H ≥ W` 顶穿的方向。
  if (defaultMaxTokens !== undefined && defaultMaxTokens !== null) {
    if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens < 0) return undefined
    policy.defaultMaxTokens = defaultMaxTokens
  }
  return policy
}

/**
 * 「按模型推导的压缩预算会不会被跳过」的预判边界值 —— 宿主半**只用来告警**。
 *
 * ⚠️ 这些数字必须与组装层 `presets/multitask/composition.mjs` 的
 * `MODEL_POLICY_LIMITS` 逐条一致：真正做换算与跳过的是那边的
 * `normalizeModelPolicies()`（推导见该文件 1179-1198 行的注释）。宿主半不参与任何
 * 计算，只把目录里的窗口原样传下去；这里复刻一份判据，是为了在「该模型注定会被
 * 跳过、回落到默认概要大小」时给用户一条可自查的日志，而不是让预算悄悄退回全局值。
 *
 * 两处一旦漂移，症状是「日志说有预算、实际没有」或反过来 —— 改任何一边都要同步。
 */
const COMPACTION_SKIP_RULES = Object.freeze({
  /** 摘要预算按窗口的 `1 / divisor` 推导（1M → 65536、256k → 16384）。 */
  divisor: 16,
  /** 摘要预算下限：再小摘要就只剩骨架。 */
  minBudget: 4096,
  /** 摘要预算上限：与上游缺省 headroom（65536）同量级。 */
  maxBudget: 65536,
  /** 「输出预留吃掉窗口」的判据之一：扣掉输出预留后至少还要剩这么多 token。 */
  minRoom: 16384,
  /** 判据之二：剩下的空间还要 ≥ 窗口的 10%。 */
  minRoomRatio: 0.1,
  /** 预算之外还要留的余量：摘要请求本身也要占位置。 */
  safetyMargin: 1024,
  /** 算出来的可用预算低于这个数就整条丢弃。 */
  minSafe: 1024,
})

/** 一条告警里最多列出多少个被跳过的模型（超出部分只报个数）。 */
const COMPACTION_SKIP_REPORT_LIMIT = 20

/**
 * 复刻组装层的**跳过**判据：这条 policy 会不会在 `normalizeModelPolicies()` 里被丢掉。
 *
 * **与 `composition.mjs` 的 `normalizeModelPolicies()` 保持同一判据**（逐条对齐那儿的
 * :1247-1252）：
 *
 *     room = contextWindow − (defaultMaxTokens ?? 0)
 *     if (!(room >= max(16384, contextWindow × 0.1))) → 'no-room'
 *     budget = clamp(round(contextWindow / 16), 4096, 65536)
 *     safe   = min(budget, room − 1024)
 *     if (safe < 1024) → 'too-tight'
 *
 * 输入必须已经过 `modelPolicyOf()`（provider / model 非空、窗口为正整数、预留值合法），
 * 非法输入在上游就被归入 `'invalid'`，走不到这里。
 *
 * @param policy - `{ provider, model, contextWindow, defaultMaxTokens? }`。
 * @returns `'no-room'` / `'too-tight'`；不会被跳过时返回 `undefined`。
 */
function compactionSkipReasonOf(policy) {
  const {
    divisor, minBudget, maxBudget, minRoom, minRoomRatio, safetyMargin, minSafe,
  } = COMPACTION_SKIP_RULES
  const room = policy.contextWindow - (policy.defaultMaxTokens ?? 0)
  if (!(room >= Math.max(minRoom, policy.contextWindow * minRoomRatio))) return 'no-room'
  const budget = Math.max(minBudget, Math.min(maxBudget, Math.round(policy.contextWindow / divisor)))
  const safe = Math.min(budget, room - safetyMargin)
  if (safe < minSafe) return 'too-tight'
  return undefined
}

/**
 * 把一条 `skipped` 记录格式化成告警里的一段。只给人看，不做任何计算。
 *
 * @param entry - `{ provider, model, contextWindow, defaultMaxTokens?, reason }`。
 * @returns 形如 `providerA/modelX (window=256000, reserve=256000, no-room)` 的文本。
 */
function describeSkippedModel(entry) {
  // 非法值原样标成 `invalid`：`'invalid'` 这一类的 `contextWindow` / `defaultMaxTokens`
  // 恰恰是「拿到的数不合法」，打印一个看起来正常的数字反而会误导。
  const window = Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0
    ? entry.contextWindow
    : 'invalid'
  const reserve = entry.defaultMaxTokens ?? 0
  const reserveText = Number.isSafeInteger(reserve) && reserve >= 0 ? reserve : 'invalid'
  return `${entry.provider}/${entry.model} (window=${window}, reserve=${reserveText}, ${entry.reason})`
}

/**
 * 拼出那条「预算被跳过」的告警正文（不含 `dsh-multitask: ` 前缀）。
 *
 * 最多列 `COMPACTION_SKIP_REPORT_LIMIT` 个，其余只报个数 —— 目录异常大时不能让一行
 * 日志被几十个模型名撑爆。
 *
 * @param skipped - `skipped` 数组。
 * @returns 一行可读文本。
 */
function compactionSkipMessage(skipped) {
  const shown = skipped
    .slice(0, COMPACTION_SKIP_REPORT_LIMIT)
    .map(describeSkippedModel)
    .join('; ')
  const rest = skipped.length - COMPACTION_SKIP_REPORT_LIMIT
  const tail = rest > 0 ? `; … +${rest} more` : ''
  return `compaction budget skipped for ${skipped.length} model(s): ${shown}${tail}`
}

/**
 * 清洗 / 去重 / 排序 `modelPolicies`。
 *
 * **排序不是整洁癖**：`redeclare()` 用 `JSON.stringify` 比较声明内容，目录枚举顺序
 * 不稳定就会让「内容没变」被判成「变了」，于是每次启动都白重注册一遍 —— 而重注册
 * 有自己的代价（注销旧代、新会话才生效）。排序后同一份目录永远得到同一个指纹。
 *
 * `provider` / `model` **原样保留、不 trim**：上游按这两个字符串精确匹配，改一个
 * 字符就等于换了身份；只把「全是空白」的当空串丢弃（与组装层同一口径）。
 *
 * @param raw - 待清洗的条目（可能含非法值）。
 * @returns 规整后的数组（至多 `MODEL_POLICY_LIMIT` 条）。
 */
function normalizeModelPolicies(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const cleaned = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const provider = entry.provider
    const model = entry.model
    const contextWindow = entry.contextWindow
    if (typeof provider !== 'string' || provider.trim() === '') continue
    if (typeof model !== 'string' || model.trim() === '') continue
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) continue
    // 与 `modelPolicyOf()` 同一口径：预留值给了就必须是非负整数，否则整条丢弃。
    const defaultMaxTokens = entry.defaultMaxTokens
    if (defaultMaxTokens !== undefined && defaultMaxTokens !== null) {
      if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens < 0) continue
    }
    // 与组装层 / 上游完全同键：`JSON.stringify([provider, model])`，不走分隔符拼接。
    const key = JSON.stringify([provider, model])
    if (seen.has(key)) continue
    seen.add(key)
    const policy = { provider, model, contextWindow }
    if (defaultMaxTokens !== undefined && defaultMaxTokens !== null) policy.defaultMaxTokens = defaultMaxTokens
    cleaned.push(policy)
  }
  cleaned.sort((left, right) => {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1
    if (left.model !== right.model) return left.model < right.model ? -1 : 1
    return 0
  })
  return cleaned.slice(0, MODEL_POLICY_LIMIT)
}

/**
 * 快照的稳定指纹 —— 只用来判断「内容是否真的变了」。
 *
 * 失败时返回一个必然不同的字符串（而不是空串）：宁可多重声明一次，也不要漏掉真改动。
 *
 * @param policies - `normalizeModelPolicies()` 的返回值。
 * @returns 可比较的字符串。
 */
function modelPoliciesFingerprint(policies) {
  try {
    return JSON.stringify(policies)
  } catch {
    return `unserializable:${Date.now()}:${Math.random()}`
  }
}

/**
 * 给一个 `await` 加上**真正**的时间上限。
 *
 * `AbortSignal.timeout()` 只是把信号置为 aborted —— 它不会结束 `await`。若某个适配器
 * 不理会 `signal`（第三方实现完全可能），预取就会挂在那一个模型上，「3 秒 / 10 秒上限」
 * 形同虚设。所以这里自己计时，到点直接让这一条失败。
 *
 * 输掉比赛的那一边晚到的拒绝必须被吃掉（第一行那个 `catch`），否则会变成
 * `unhandledRejection`，在宿主里表现为一条莫名其妙的错误。
 *
 * @param promise - 待等待的 promise。
 * @param ms - 上限（毫秒）。
 * @returns `promise` 的结果；超时则抛错。
 */
function withDeadline(promise, ms) {
  let timer
  promise.catch(() => {})
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
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
 * 把插件 config 里的调整应用到减震器与工作区 ACL 那两行。
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
 * `workspace-acl` 只取同一个 `presetId`（它用切换广播判断「切进来的是不是本模式」），
 * 保留集与开关仍然只属于减震器。
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
    // `workspace-acl` 也要对齐同一个 id：它用 `agent-preset/selected` 的第二个参数
    // 判断「切进来的是不是本模式」。profile 把 `config.presetId` 改成别的值时若只对齐
    // 减震器，补授权会在切换路径上静默停摆 —— 而那正是它唯一能补救的时机。
    if (row.id === 'workspace-acl') {
      if (!hasPresetId) return row
      return { ...row, config: { ...(row.config ?? {}), presetId } }
    }
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

  // ── 注册两类自建 worker 的 provider（`multitask_ptc` / `multitask_minimal`）──
  //
  // 这一步必须在**宿主平面**做，不能放进 preset 内部：provider 注册的 effect 由服务
  // 自己的 context 拥有，preset 重新声明时旧注册不会被卸掉，新一代再注册同名 provider
  // 会撞 `a subagent provider named "…" is already registered`，而那会让**整个 preset
  // 挂载失败**（模式从新会话列表消失）。这里注册一次、且靠 `getProvider()` 去重。
  //
  // 它服务的是两条**可选**委派路径，所以失败只告警（见 `worker-providers.js` 头部）。
  // 注册表比本插件晚出现时，该函数内部会用 `ctx.inject` 兜住。
  registerWorkerProviders(ctx, warn)

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

  /**
   * 模型目录快照 —— 「每个模型上下文窗口是多少」。
   *
   * 由下面的 `prefetchModelPolicies()` 异步写入，`build()` 每次组装时**现读**。
   * 初始为空数组，因此首份声明与加入本功能之前**逐字等价**（不传 `modelPolicies`
   * 与传空数组对组装层是同一件事）。预取完成后内容真的变了才触发重声明。
   */
  let modelPolicies = []

  /** 是否有一轮预取正在跑（同一时刻只跑一轮）。 */
  let prefetchingPolicies = false
  /** 预取期间又收到目录更新事件：本轮结束后再补一轮。 */
  let policyPrefetchAgain = false
  /** 首次声明 / 一次重声明进行中时快照变了：等它们结束后补一次重声明。 */
  let policyRedeclarePending = false
  /** 最近一次拿到的 `llm` 服务（目录更新事件要重新预取，卸载后不再用）。 */
  let llmService

  /** 组装此刻要提交的声明。 */
  const build = () => {
    const presetId = typeof config?.presetId === 'string' && config.presetId.trim() !== ''
      ? config.presetId
      : presetMetadata.id
    const order = typeof config?.order === 'number' && Number.isFinite(config.order)
      ? config.order
      : presetMetadata.order
    // 压缩预算读一次、用两处：既原样传给组装层，也用来判断「用户是否手填了值」。
    // 每次 `build()` 都重读 —— volatile 字段是**原地**更新的，缓存会读到旧值。
    const compaction = readCompaction(config)

    const declaration = {
      id: presetId,
      name: presetMetadata.name,
      description: presetMetadata.description,
      order,
      plugins: applyGuardOverrides(
        // 用户设置在这里进入 composition：「子代理使用的模型」与「停滞看门狗阈值」——
        // 没有配置时分别传空数组 / 默认值 ⇒ 与加入这些参数之前**逐字等价**
        // （既有测试大量无参调用 buildPlugins）。
        //
        // ⚠️ **并发上限不在这里传**：它已改由宿主 `dsh-subagent` 那一行独家拥有
        // （见文件上方那段注释）。本插件不再有自己的上限字段，也不再有并发守卫行。
        buildPlugins({
          modelMap: readModelMap(config),
          watchdog: readWatchdog(config),
          // 压缩预算同样进 preset 声明：它必须落在 preset 内部那一行，宿主 patch
          // 进不了 `isolate: { compaction: true }` 的组（issue #5）。
          compaction,
          // 按模型窗口生成的策略快照。**用户手填了压缩预算时一律传空数组**：
          // 那是用户明确写下的数字，组装层若再按模型策略覆盖就等于面板在撒谎。
          // 空数组 = 不生成策略，组装层回落到用户值 / 缺省值。
          modelPolicies: hasConfiguredCompaction(compaction) ? [] : modelPolicies,
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
      // 模型目录快照可能在本次注册**进行中**才落地（预取是异步的，而那时
      // `redeclare()` 会被 `declaring` 挡掉）。落定后补一次重声明：内容没变时
      // `redeclare()` 自己会因 `sameDeclaration()` 立刻返回，不会空转。
      if (policyRedeclarePending) {
        policyRedeclarePending = false
        void redeclare()
      }
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
      // 同 `declare()`：预取在本次重声明**进行中**落地时，那次 `redeclare()` 会被
      // `redeclaring` 挡掉。这里补一次；此时 `build()` 已经包含新快照，若上一轮
      // 的循环没赶上它会真的重注册，赶上了则因内容相同立刻返回。
      if (policyRedeclarePending) {
        policyRedeclarePending = false
        void redeclare()
      }
    }
  }

  // ── 模型目录预取 → 快照 → 重声明 ─────────────────────────────────────────────
  //
  // 三件事必须分开看，否则很容易写成「声明被拖慢」或「永远不生效」：
  //
  //   ① 首份声明**不等**目录：`build()` 是同步的，声明必须立刻落地（空快照）。
  //      「先让模式出现，再补预算」——模式的可见性比预算精确重要得多。
  //   ② 预取是**尽力而为**的旁路：只读 `llm` 的模型目录，任何一步失败只告警。
  //   ③ 快照落地后**才**重声明，且内容没变就不重声明 —— 重声明会换掉 preset 的
  //      一代（只对新会话生效），每次启动都白来一遍毫无意义。

  /**
   * 请求一次「按新快照重新声明」。
   *
   * 首次声明 / 另一次重声明**进行中**时不能直接调 `redeclare()` —— 它会被
   * `declaring` / `redeclaring` 挡掉，于是这次更新就悄悄丢了。所以那种时候只记一个
   * 待办标志，由两个 `finally` 在声明落定后补跑（见那两处注释）。
   */
  const requestPolicyRedeclare = () => {
    if (closed) return
    if (!declared || declaring || redeclaring) {
      policyRedeclarePending = true
      return
    }
    void redeclare()
  }

  /**
   * 记住 `llm` 服务，并在第一次见到它时挂上目录更新监听。
   *
   * 事件名来自 DSH 源码：`llm/adapters-updated`（按设计**不带载荷**，消费方自己重读
   * 注册表）与 `llm/models-updated`。两者都表示「目录可能变了」，因此都重新预取一次。
   * 监听器的注销器由 fiber 的 effect 管理，本插件卸载时自动摘掉。
   *
   * @param llm - `llm` 服务实例。
   */
  const adoptLlm = (llm) => {
    if (llm === undefined || llm === null) return
    const first = llmService === undefined
    llmService = llm
    if (!first || typeof ctx.on !== 'function') return
    for (const event of ['llm/adapters-updated', 'llm/models-updated']) {
      try {
        ctx.on(event, () => {
          if (llmService !== undefined) void prefetchModelPolicies(llmService)
        })
      } catch {
        // 极简 ctx（测试里的假 ctx）可能没有 `on`：目录变化不会自动刷新，
        // 但预取已经跑过一次，预算照常工作。
      }
    }
  }

  /**
   * 枚举模型目录，把每个模型的上下文窗口收集成 `modelPolicies` 快照。
   *
   * ── 失败边界（这里**只**告警，绝不让整条链挂掉）────────────────────────────────
   *
   *   · 用户显式配置了压缩预算 → 直接返回，快照保持空数组（用户值优先）。
   *   · 拿不到 `llm` 服务 → 由 `ctx.inject` 等它出现；一直不出现则什么也不做。
   *   · `listProviders()` 抛错 → 告警一次，快照保持原样。
   *   · 某个 provider 的 `listModels()` 抛错 → 告警，跳过该 provider。
   *   · 某个模型的 `resolveModelInfo()` 抛错 / 超过 3 秒 → 告警，跳过该模型。
   *   · 整轮超过 10 秒 → 停止枚举，用已经拿到的结果。
   *   · 拿到的数据结构不合法 → 静默丢弃该条（preset 行 config 被上游拒收时注册表
   *     **不会回滚**，只会把 preset 打成 broken，所以宁缺勿坏）。
   *
   * @param llm - `llm` 服务实例。
   */
  const prefetchModelPolicies = async (llm) => {
    // 守卫本身也可能抛：`readCompaction()` 读的是 volatile `get()`，`llm` 也可能只是
    // 长得像服务（属性访问即抛）。调用点一律是 `void prefetchModelPolicies(…)`，
    // 这里漏出去就会变成宿主的 unhandledRejection —— 所以连守卫一起兜在这一层。
    try {
      if (closed) return
      // 用户填了任一项压缩预算：不生成按模型策略，免得覆盖用户手写的数字。
      if (hasConfiguredCompaction(readCompaction(config))) return
      if (llm === null || typeof llm !== 'object') return
      if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return
      if (prefetchingPolicies) {
        // 同一时刻只跑一轮：把「再跑一次」记下来，本轮结束后补。
        policyPrefetchAgain = true
        return
      }
      prefetchingPolicies = true
    } catch (error) {
      // 与下面那条兜底同一条格式：只告警，不外抛。
      warn(
        `prefetching the model directory failed: ${error instanceof Error ? error.message : String(error)}; ` +
          'the context-window budget falls back to the composition defaults',
      )
      return
    }
    const deadline = Date.now() + MODEL_DIRECTORY_TIMEOUT_MS
    try {
      let providers
      try {
        providers = llm.listProviders()
      } catch (error) {
        warn(
          `reading the model directory failed: ${error instanceof Error ? error.message : String(error)}; ` +
            'the context-window budget falls back to the composition defaults',
        )
        return
      }
      if (!Array.isArray(providers)) return
      const collected = []
      /** 会被组装层跳过、回落到默认概要大小的模型 —— 只在末尾汇总成一条告警。 */
      const skipped = []
      for (const provider of providers) {
        if (closed || Date.now() >= deadline) break
        const providerId = provider?.id
        if (typeof providerId !== 'string' || providerId.trim() === '') continue
        let models
        try {
          // `listModels()` 没有 signal 参数，只能靠外面这条硬上限兜住。
          models = await withDeadline(llm.listModels(providerId), Math.max(1, deadline - Date.now()))
        } catch (error) {
          warn(
            `listing the models of provider "${providerId}" failed: ` +
              `${error instanceof Error ? error.message : String(error)}; that provider is skipped`,
          )
          continue
        }
        if (!Array.isArray(models)) continue
        for (const model of models) {
          if (closed || Date.now() >= deadline) break
          const modelId = model?.id
          if (typeof modelId !== 'string' || modelId.trim() === '') continue
          try {
            // 单模型 3 秒，同时不超过整轮的剩余时间 —— 后者保证总耗时不会
            // 因为「每个都慢 3 秒」而被乘成任意大。signal 之外再加一道硬上限：
            // 适配器不理会 signal 时，只有 `withDeadline` 能真正结束这一条。
            const timeoutMs = Math.max(1, Math.min(MODEL_INFO_TIMEOUT_MS, deadline - Date.now()))
            const info = await withDeadline(
              llm.resolveModelInfo(providerId, modelId, AbortSignal.timeout(timeoutMs)),
              timeoutMs,
            )
            const policy = modelPolicyOf(providerId, modelId, info)
            if (policy === undefined) {
              // 结构不合法（窗口 / 预留值不是合法整数）：组装层同样会丢弃这一条，
              // 于是它也只能回落默认概要大小 —— 和其它跳过一样记进 skipped。
              skipped.push({
                provider: providerId,
                model: modelId,
                contextWindow: info?.context?.contextWindow,
                defaultMaxTokens: info?.defaultMaxTokens,
                reason: 'invalid',
              })
            } else {
              // 结构合法，但预判它在组装层会被跳过（判据复刻见
              // `compactionSkipReasonOf()`）。**仍然照旧进 `collected`**：这条预判
              // 只负责记日志，不能让宿主半的清洗结果多出任何变化 —— 组装层自己会
              // 用同一判据再判一次，真正决定预算的永远是那边。
              const reason = compactionSkipReasonOf(policy)
              collected.push(policy)
              if (reason !== undefined) skipped.push({ ...policy, reason })
            }
          } catch (error) {
            warn(
              `resolving "${providerId}/${modelId}" failed: ` +
                `${error instanceof Error ? error.message : String(error)}; that model is skipped`,
            )
          }
        }
      }
      if (closed) return
      // 预取完成后**汇总一条**告警：这些模型的按模型预算在组装层会被跳过，于是回落到
      // 全局压缩缺省（`COMPACTION_DEFAULTS`）。只告警，不抛错、不影响声明。
      // 只会出现在「自动模式」这条路径上 —— 用户配了任一项压缩值时本函数在开头就已
      // 早退，根本不会枚举目录（见 `hasConfiguredCompaction()` 那道守卫）。
      if (skipped.length > 0) warn(compactionSkipMessage(skipped))
      const next = normalizeModelPolicies(collected)
      // 目录没给出任何可用窗口：保持快照原样（首次就是空数组，声明因此不变）。
      if (next.length === 0) return
      if (modelPoliciesFingerprint(next) === modelPoliciesFingerprint(modelPolicies)) return
      modelPolicies = next
      ctx.logger?.info?.(
        `dsh-multitask: learned the context window of ${next.length} model(s); ` +
          'the preset will carry per-model compaction budgets',
      )
      requestPolicyRedeclare()
    } catch (error) {
      // 兜底：上面每一步都有自己的 try/catch，这里只防「没想到的异常」把整条链挂掉。
      warn(
        `prefetching the model directory failed: ${error instanceof Error ? error.message : String(error)}; ` +
          'the context-window budget falls back to the composition defaults',
      )
    } finally {
      prefetchingPolicies = false
      if (policyPrefetchAgain && !closed) {
        policyPrefetchAgain = false
        void prefetchModelPolicies(llm)
      }
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

  // ── 模型目录预取：取 `llm` 服务，**不阻塞**上面的首次声明 ───────────────────────
  //
  // `llm` 不在本插件的 `inject` 里（`inject = []`：缺服务也必须能加载），所以**不能**
  // 用 `ctx.llm` —— 那会抛 `cannot get property "llm" without inject`。必须走
  // `ctx.get('llm')`；拿不到时用 `ctx.inject` 等它出现（与 `worker-providers.js` 里
  // `subagents` 的兜底同款：direct get → undefined 则 inject → 外层 try/catch）。
  //
  // 预取本身是 `void` 的：声明早已落地，目录慢或读不到都只影响「预算是否按模型算」。
  try {
    const direct = (() => {
      try {
        return ctx.get('llm')
      } catch {
        return undefined
      }
    })()
    if (direct !== undefined && direct !== null) {
      adoptLlm(direct)
      void prefetchModelPolicies(direct)
    } else {
      ctx.inject(['llm'], (child) => {
        // 服务就绪后预取一次；之后目录变化由 `adoptLlm()` 挂上的监听负责刷新。
        adoptLlm(child?.llm)
        void prefetchModelPolicies(child?.llm)
      })
    }
  } catch (error) {
    // `ctx.inject` 不可用（极简 ctx）或取服务时抛错：只是没有按模型预算，
    // preset 本身照常声明与工作。
    warn(
      `the model directory could not be read (${error instanceof Error ? error.message : String(error)}); ` +
        'the context-window budget falls back to the composition defaults',
    )
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
      // 用户可能刚把压缩预算**清空**（或清空后又想改回按模型策略）：此时补一次预取。
      // 否则快照会一直停在「用户值优先」期间留下的空数组上，直到下次重启。
      if (
        llmService !== undefined &&
        modelPolicies.length === 0 &&
        !hasConfiguredCompaction(readCompaction(config))
      ) {
        void prefetchModelPolicies(llmService)
      }
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
