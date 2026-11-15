/**
 * multitask-task-key — 同一个任务键，不许同时有两个 worker。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 协调者想「停掉 worker A、改派 worker B 做同一件事」，实际结果常常是 **A 没停、
 * B 又开始**：两个 agent 并发改同一批文件。插件侧此前**没有任何机制**能识别
 * 「这两次派发是同一件事」—— `subagent` / `subagent_fork` / `subagent_ptc` /
 * `subagent_minimal` 的参数里没有任务标识（参数只有 `cwd` / `description` /
 * `prompt`），所以「同一件事的第二次派发」与「两件不同的事」在机制上一模一样。
 *
 * 人格纪律只能缓解，不能强制。本模块做**机械强制**，但判据是**显式任务键**，
 * 不是语义相似度 —— 后者判不准，而且会误杀「两个 worker 各做一件相似的事」。
 *
 * ── 约定：每份 brief 带一行任务键 ────────────────────────────────────────────
 *
 *      task: fix-gate-a
 *
 * 文法（`SLUG_PATTERN`）：3-64 字符，小写，`[a-z0-9][a-z0-9._-]{2,63}`。
 * 语义：同一件工作用同一个 slug，不同工作必须不同 slug，**重启同一个任务复用原 slug**。
 *
 * ── 行为 ─────────────────────────────────────────────────────────────────────
 *
 * 挂 `tools/pre-execute`。**只对四个已确证 schema 的派遣工具强制**
 * （`VERIFIED_DISPATCH_TOOLS`：`subagent` / `subagent_fork` / `subagent_ptc` /
 * `subagent_minimal`；任务书字段是 `prompt`，`description` 只作兜底）。当
 * `exec.name` 属于这四个时：
 *
 *   · 没有任务键            → 拒绝（deny），文案要求补 `task: <slug>`
 *   · 有键但文法不合法      → 拒绝，文案给出文法
 *   · 一份 brief 里两个不同的键 → 拒绝（解析不确定 ⇒ fail-closed）
 *   · 有键且该键**在运行中** → 拒绝，文案给出已有 worker 的会话 id 前 8 位与已运行时长
 *   · 有键且无冲突          → 登记后放行
 *
 * 其余派遣类工具（`spawn_teammate` / `subagent_preset` / `workflow` 以及任何
 * schema 未在本仓库确证的工具）**一律放行**，并记一行
 * `TASK-KEY-SKIPPED reason=unknown-schema tool=<name>`（同一次会话内同一个工具只记一次，
 * 避免刷屏）。
 *
 * ⚠️ 这条边界是刻意的：**这个守卫宁可漏拦，也不能堵死它看不懂的派遣路径。**
 * 一个解析不出 brief 的工具被硬拒，等于把一条合法派遣路径变成不可用；而漏拦的
 * 后果只是「团队工具下的同键并发不被检测」—— 也就是回到加本模块之前。
 *
 * ── 登记表契约（跨文件约定，别改字面量）──────────────────────────────────────
 *
 * 键：`globalThis[REGISTRY_KEY]`，值：
 *
 *     {
 *       claims: Map<string, Claim>,   // key = 父会话 id + '::' + slug
 *       gone:   string[],             // 已 disposed 的会话 id（有界，仅用于兜底释放）
 *     }
 *
 *     Claim = {
 *       key, slug, tool,
 *       parentIds: string[],          // 父会话的候选 id（session.id 与 agent.id 去重）
 *       startedAt: number,            // Date.now()，用于算「已运行时长」
 *       ids: string[],                // 子会话的候选 id（空数组 = 还没绑上）
 *       bound: boolean,                // 已被 `agents.get()` 确认过至少一次活着
 *     }
 *
 * 作用域：**按父会话隔离**（键里带父会话 id），不同主对话互不干扰。
 *
 * 释放：`agent/disposed` 时清掉对应键；每次检查前再顺带做过期清理 ——
 * 对**已不再活跃**的会话 id 视为释放（判据是 `agents.get(id) === undefined`，
 * 且该 id 曾被确认活着；`agents` 服务不可用时退回 `gone` 名单）。
 * **已绑定的 claim 绝不做时间过期**：一个长任务跑 40 分钟不该被判过期。
 *
 * 唯一的例外是**未绑定的占位**：pre-execute 放行之后派遣本身失败（宿主
 * `subagent.maxActiveSubagents` 上限、provider 抛错等），子会话从未创建 ⇒
 * `agent/created` 不触发 ⇒ `bound` 永远是 false、`ids` 为空。这种占位若一直留着，
 * 该 slug 在本对话内就**永久被占**，协调者只能换 slug —— 而「重启同一个任务」本应
 * 复用原 slug。所以 `UNBOUND_CLAIM_TTL_MS`（默认 600000 = 10 分钟）之后，它在下次
 * 检查时被释放并允许重新登记，同时记 `TASK-KEY-RELEASED reason=unbound-expired`。
 * 已绑定的 claim 不受这一条影响。
 *
 * ── 失败取向 ─────────────────────────────────────────────────────────────────
 *
 * **fail-closed**：在**能读到 brief** 的前提下解析不确定（键文法不合法、一份 brief
 * 两个键）一律拒绝，并说明要求。但**只**为这些情况拒绝 —— 别的工具、别的方向（worker →
 * 父会话的汇报、以及 worker 自己的任何调用）一个字都不碰。
 *
 * **宁可漏拦，不可堵死**：brief 字段一个都取不到的工具（schema 未确证）放行 + 一行
 * `info`（`TASK-KEY-SKIPPED reason=unknown-schema`），而不是硬拒 —— 理由见上面
 * 「行为」那一节。
 *
 * 另一条「安静」路径是机制本身出意外（监听器抛错）：那退成放行 + 一行 warn，
 * 因为本模块的失败不该把一次正常派发变成拒绝。**功能上**这等于回到加本模块之前。
 *
 * @module dsh-multitask/presets/multitask/task-key
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-task-key'

/**
 * 本模块**不**声明 `inject`。
 *
 * 它要的东西都不是「服务就绪才能装」的：`tools/pre-execute` / `agent/created` /
 * `agent/disposed` 都是 ctx 事件，`agents` 在**调用那一刻**才去取。声明注入会把它
 * 绑死在宿主服务的就绪时机上，而本模块的设计前提正是「取不到就按已知信息判定」。
 */
export const inject = []

/**
 * 登记表的全局键名。
 *
 * 与 `dsh-multitask:approval-wait:v1`（`approval-gate.mjs` / `interrupt-before-send.mjs`
 * 共用的那张审批等待表）同一种风格：`dsh-multitask:<用途>:v<版本>`。
 * 本仓库零 import，所以每个需要它的模块各自带一份字面量 —— **改这个名字就是改契约**。
 */
export const REGISTRY_KEY = 'dsh-multitask:task-key:v1'

/**
 * slug 文法。
 *
 * 3-64 字符（首字符 + 至少 2 个后续字符），首字符必须是 `[a-z0-9]`，
 * 其后允许 `[a-z0-9._-]`。刻意不接受大写与空格：键会被写进日志与拒绝文案，
 * 宽文法只会让「`Fix Gate A`」和「`fix-gate-a`」成为两个不同的任务。
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/

/**
 * 派遣类工具名 —— 只有这些调用的参数里**一定**有任务书（任务键就从里面解析）。
 *
 * 分成两组，因为「是不是派遣」与「schema 是否已确证」是两件事：
 *
 *   · `VERIFIED_DISPATCH_TOOLS` —— 已确证 schema，**强制**检查；
 *   · `UNVERIFIED_DISPATCH_TOOLS` —— 是派遣，但 brief 字段名在本仓库与解包副本里
 *     都没有确证，**放行**并记一行 skip（宁可漏拦，不可堵死）。
 *
 * 四个已确证的名字是本模式自己的四条委派路径（`composition.mjs` 的四行 `toolName`，
 * 逐字一致）。`subagent_preset` 是跨模式派发（`preset-dispatch.mjs` 注册）；
 * `spawn_teammate` 是团队工具（团队构建下才在协调者目录里）；`workflow` 是宿主的
 * 编排工具 —— 三者的 brief 字段都**没有**在本仓库里确证。
 */
export const VERIFIED_DISPATCH_TOOLS = ['subagent', 'subagent_fork', 'subagent_ptc', 'subagent_minimal']

/** 派遣类、但 brief schema 未确证的工具：放行 + 一次 `info`（见文件头）。 */
export const UNVERIFIED_DISPATCH_TOOLS = ['spawn_teammate', 'subagent_preset', 'workflow']

/**
 * 全部派遣类工具（已确证 + 未确证）。
 *
 * 保留这个导出只是因为它是**对外契约**的并集（判别力测试用它对「强制所有工具」做
 * 变异）；决策本身按上面两组分别处理，**不要**用它来判断是否强制。
 */
export const DISPATCH_TOOLS = [...VERIFIED_DISPATCH_TOOLS, ...UNVERIFIED_DISPATCH_TOOLS]

/**
 * 未绑定占位的存活上限（毫秒）。
 *
 * 只对**未绑定**的占位生效：pre-execute 放行之后派遣失败（宿主并发上限、provider 抛错），
 * 子会话从未创建，`agent/created` 不会来把 id 绑上去。没有这个上限，那个 slug 在本对话内
 * 就永久被占，而「重启同一个任务」本应复用 slug。
 *
 * **已绑定的 claim 永不过期**：一个跑 40 分钟的长任务不该被判过期 —— 那会在最需要接手的
 * 时刻拒绝接手。这里刻意不做成配置读取：本模块没有配置面（`composition.mjs` 只传
 * `enabled`），多一个阈值旋钮只会让行为在部署之间悄悄漂移。
 */
export const UNBOUND_CLAIM_TTL_MS = 600000

/**
 * 任务书可能出现的参数字段，**按顺序取第一个存在的字符串**。
 *
 * 真实 schema（`.tmp-asar/tool-subagent.js` 的 `parameters`）：brief 在 `prompt`，
 * 而 `description` 是必填的「3-5 个词的显示标签」，**不是**任务书 —— 它排在最后，
 * 只在 `prompt` 缺失时兜底。四个已确证工具都吃这一对字段名。
 */
const BRIEF_FIELDS = ['prompt', 'description']

/** 「专用任务键字段」的候选名：某些工具可能有独立的 `task` 字段而不是行内约定。 */
const KEY_FIELDS = ['task', 'task_key', 'taskKey', 'slug']

/** 子代理会话的 `origin` 标记（与其它守卫同一常量）。 */
const SUBAGENT_ORIGIN = 'subagent'

/** `gone` 名单的上限：只用于兜底释放，留最近这些就够。 */
const GONE_LIMIT = 256

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 与 `coordinator-guard.mjs` / `minimal-guard.mjs` / `subagent-mode.mjs` /
 * `approval-gate.mjs` / `interrupt-before-send.mjs` 用**同一条判据**（三信号）。
 *
 * 本模块里它是**方向闸门**：worker 的调用一个字都不碰。理由不是礼貌 ——
 * worker 本来就派不出去（深度固定 1），它的委派调用必然撞 `depth 2 exceeds maxDepth 1`；
 * 在这里再拒一次只会把那条真实的报错换成本模块的「你缺任务键」，反而更难查。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为被委派的子代理。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === SUBAGENT_ORIGIN) return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 一个 agent 的**登记用 id 候选**：`session.id` 优先，其次 `agent.id`。
 *
 * 为什么要两个：会话尚未发布时 `session.id` 还不在（`subagent-watchdog.mjs` 里记过
 * 同一个坑），而 `agent.id` 一定在。两者在多数部署里是同一个值，所以去重。
 *
 * @param agent - 任意 agent / 子代理。
 * @returns 去重后的 id 数组（可能为空）。
 */
function idsOf(agent) {
  const out = []
  for (const value of [agent?.session?.id, agent?.id]) {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 取（必要时创建）登记表。
 *
 * 三种异常都要免疫：`globalThis` 被冻结、`claims` 不是 Map、`gone` 不是数组 ——
 * 任一情况下本模块不能反过来炸掉工具调用。
 *
 * @returns `{ claims, gone }`；连表都造不出来时返回 `undefined`。
 */
function registryOf() {
  try {
    let table = globalThis[REGISTRY_KEY]
    if (table === null || typeof table !== 'object' || !(table.claims instanceof Map)) {
      table = { claims: new Map(), gone: [] }
      globalThis[REGISTRY_KEY] = table
    }
    if (!Array.isArray(table.gone)) table.gone = []
    return table
  } catch {
    return undefined
  }
}

/**
 * 把一个值按 slug 文法检查。
 *
 * @param raw - 候选文本（**未** trim，调用方负责）。
 * @returns 合法时返回规范化后的 slug，否则 `undefined`。
 */
function normalizeSlug(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return undefined
  return SLUG_PATTERN.test(value) ? value : undefined
}

/**
 * 从一份任务书里解析任务键。
 *
 * 接受两种写法（行首可有空白，`task` 大小写不敏感）：
 *
 *     task: fix-gate-a
 *     task=fix-gate-a
 *
 * 返回四种结果，其中三种都**必须**被拒绝（fail-closed），只有 `ok` 放行：
 *
 *     { kind: 'ok', slug }            恰好一个合法键
 *     { kind: 'missing' }             一行都没有 —— 加一行就能修好
 *     { kind: 'invalid', raw }        有关键行，但值不是合法 slug
 *     { kind: 'ambiguous', slugs }    一份 brief 里出现两个**不同**的键
 *
 * @param brief - 任务书全文。
 * @returns 解析结果。
 */
export function parseTaskKey(brief) {
  if (typeof brief !== 'string' || brief === '') return { kind: 'missing' }
  const found = []
  for (const line of brief.split(/\r?\n/)) {
    // 允许行首空白与可选的列表标记（`- ` / `* ` / `+ `）：
    // 拒绝一条**其实写了键**的 brief，是比接受一条不规范的更糟的错。
    const match = /^\s*(?:[-*+]\s+)?task\s*[:=]\s*(.*)$/i.exec(line)
    if (match === null) continue
    found.push(match[1].trim())
  }
  if (found.length === 0) return { kind: 'missing' }
  const slugs = []
  for (const raw of found) {
    const slug = normalizeSlug(raw)
    if (slug === undefined) return { kind: 'invalid', raw }
    if (!slugs.includes(slug)) slugs.push(slug)
  }
  if (slugs.length > 1) return { kind: 'ambiguous', slugs }
  return { kind: 'ok', slug: slugs[0] }
}

/**
 * 从工具参数里取出**任务书文本**。
 *
 * 顺序见 `BRIEF_FIELDS` 的注释：先 `prompt`（四个已确证工具的 brief 字段），
 * 再 `description`（显示标签，只作兜底）。
 *
 * ⚠️ 它只对**已确证 schema** 的工具被调用：别的工具连 brief 字段名都不知道，
 * 取不到就该放行，而不是把 `missing` 当成「没有任务键」去拒绝（见文件头）。
 *
 * @param args - 工具的 `arguments`。
 * @returns `{ text, field }`，或 `undefined`（一个候选字段都没有）。
 */
function briefOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const field of BRIEF_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value !== '') return { text: value, field }
  }
  return undefined
}

/**
 * 把工具参数解析成任务键（行内约定 + 专用字段兜底）。
 *
 * @param args - 工具的 `arguments`。
 * @returns `parseTaskKey` 的四种结果之一；连 brief 字段都没有时也给 `missing`。
 */
export function taskKeyOf(args) {
  const brief = briefOf(args)
  if (brief !== undefined) {
    const parsed = parseTaskKey(brief.text)
    // 行内没有键时，再看有没有**独立的**任务键字段（某些工具可能就这么设计）。
    if (parsed.kind === 'missing' && args !== null && typeof args === 'object') {
      for (const field of KEY_FIELDS) {
        const raw = args[field]
        if (typeof raw !== 'string' || raw.trim() === '') continue
        const slug = normalizeSlug(raw)
        if (slug === undefined) return { kind: 'invalid', raw: raw.trim() }
        return { kind: 'ok', slug }
      }
    }
    return parsed
  }
  return { kind: 'missing' }
}

/**
 * 把毫秒时长渲染成人类可读的一段（用于「已运行时长」）。
 *
 * @param ms - 已运行毫秒数（非有限或负数按 0 处理）。
 * @returns 例如 `12s` / `4m 12s` / `1h 03m`。
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0) / 1000)
  if (total < 60) return `${Math.round(total)}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(total % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** slug 文法的**人读**描述（拒绝文案里逐字使用，测试对着它断言）。 */
const GRAMMAR =
  '3-64 characters, lowercase, `[a-z0-9][a-z0-9._-]{2,63}` (letters, digits, dot, underscore, hyphen; must start with a letter or digit)'

/** 「同一件工作复用同一个 slug」这条语义的**人读**描述。 */
const SAME_JOB_RULE =
  'Use the SAME slug for the same piece of work — including when you restart that task — and a DIFFERENT slug for different work (e.g. `fix-gate-a` vs `fix-gate-b`).'

/**
 * 造一个「同因只报一次」的告警函数（与同目录其它模块同款）。
 *
 * @param ctx - 插件上下文。
 * @returns 告警函数。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/task-key: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉工具调用。
    }
  }
}

/**
 * 装载本模块。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled }`（见 `composition.mjs` 那一行）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)

  /**
   * 取 `agents` 服务（活 agent 的权威来源）。
   *
   * @returns 服务，或 `undefined`。
   */
  const agentsService = () => {
    try {
      const service = ctx.get?.('agents')
      return service === undefined || service === null ? undefined : service
    } catch {
      return undefined
    }
  }

  /**
   * 查一个会话 id 是不是**此刻还活着**。
   *
   * 三态，刻意区分「不知道」与「不在了」：
   *
   *     true      服务明确认识这个 id
   *     false     服务在用、且明确不认识这个 id（⇒ 已释放）
   *     undefined 服务不可用（⇒ 只能靠 `gone` 名单兜底，别乱释放）
   *
   * @param ids - 同一个会话的候选 id。
   * @returns 三态判定。
   */
  const livenessOf = (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return undefined
    const service = agentsService()
    if (service === undefined || typeof service.get !== 'function') return undefined
    try {
      for (const id of ids) {
        if (service.get(id) !== undefined) return true
      }
      return false
    } catch {
      return undefined
    }
  }

  /**
   * 过期清理：把**已经失效**的占位删掉。
   *
   * 三个判据，任一成立即释放：
   *   1. 该会话 id 出现在 `gone` 名单里（`agent/disposed` 记录的兜底）；
   *   2. `agents.get()` 明确不认识它，**且**它曾被确认活着（`claim.bound`）——
   *      加 `bound` 这个前置是为了不在绑定瞬间把刚登记的占位误删；
   *   3. **未绑定**的占位超过了 `UNBOUND_CLAIM_TTL_MS`（见该常量的注释）：
   *      pre-execute 放行之后派遣失败（宿主并发上限、provider 抛错），子会话从未
   *      创建 ⇒ 这个占位永远不会被绑定。不释放，该 slug 就在本对话内永久被占，
   *      而「重启同一个任务」本应复用 slug。
   *
   * ⚠️ 判据 3 **只**看未绑定的占位。已绑定的 claim 绝不做时间过期：一个长任务跑
   * 40 分钟不该被判过期 —— 那会在最需要接手的时候拒绝接手。
   *
   * @param table - 登记表。
   * @param callerIds - 当前调用方的 id 候选（用来判断「父会话是不是也没了」）。
   * @param now - 当前时间（`Date.now()`；判别力测试会把它整体推移）。
   */
  const prune = (table, callerIds, now) => {
    const gone = table.gone
    for (const [key, claim] of [...table.claims.entries()]) {
      if (claim === null || typeof claim !== 'object') {
        table.claims.delete(key)
        continue
      }
      const ids = Array.isArray(claim.ids) ? claim.ids : []
      const name = ids.find((id) => gone.includes(id))
      if (name !== undefined) {
        table.claims.delete(key)
        continue
      }
      // 未绑定的占位：派遣失败后它不会再被绑定，超过阈值就放开这个 slug。
      const unbound = claim.bound !== true || ids.length === 0
      const startedAt = typeof claim.startedAt === 'number' ? claim.startedAt : undefined
      if (unbound && startedAt !== undefined && now - startedAt > UNBOUND_CLAIM_TTL_MS) {
        table.claims.delete(key)
        logReleased(claim, now)
        continue
      }
      if (claim.bound === true && livenessOf(ids) === false) {
        table.claims.delete(key)
        continue
      }
      // 还没绑上子会话的占位：父会话如果整体没了（也没在这次调用的候选里），
      // 它永远不会再被绑定 —— 顺手回收，避免 Map 无限增长。
      const parentIds = Array.isArray(claim.parentIds) ? claim.parentIds : []
      const sameParent = parentIds.some((id) => callerIds.includes(id))
      if (ids.length === 0 && !sameParent && livenessOf(parentIds) === false) {
        table.claims.delete(key)
      }
    }
  }

  /**
   * 记一行「占位被释放」（marker 与 `TASK-KEY-CLAIMED` / `-REFUSED` 同款）。
   *
   * 文案里的 `reason=unbound-expired` 是**日志契约**：协调者与测试按它 grep。
   *
   * @param claim - 被释放的占位。
   * @param now - 当前时间。
   */
  const logReleased = (claim, now) => {
    const startedAt = typeof claim?.startedAt === 'number' ? claim.startedAt : now
    try {
      ctx.logger?.info?.(
        `dsh-multitask: TASK-KEY-RELEASED slug=${JSON.stringify(claim?.slug)} tool=${JSON.stringify(
          claim?.tool,
        )} reason=unbound-expired age=${formatDuration(now - startedAt)}`,
      )
    } catch {
      // 同上：日志不可用不影响派发。
    }
  }

  /**
   * 判定一次**已确证工具**的派遣调用（**唯一**的放行/拒绝决策点）。
   *
   * 刻意收成一个函数：判别力测试要把它整段改成恒放行，然后确认主用例变红
   * （见 `test/task-key.mjs` 第 6 组）。决策分散在多个分支里就无法证明断言还在看它。
   *
   * ⚠️ 它**只**被 `VERIFIED_DISPATCH_TOOLS` 的调用走到。一个解析不出 brief 的工具
   * 不该走到这里 —— 走到这里就意味着「没有任务键」⇒ 硬拒（问题 B）。
   *
   * @param exec - 工具执行输入。
   * @param now - 当前时间（`Date.now()`）。
   * @returns `{ kind: 'allow' }` 或 `{ kind: 'deny', reason }`。
   */
  function judge(exec, now) {
    const args = exec?.arguments
    const parsed = taskKeyOf(args)

    if (parsed.kind === 'missing') {
      return {
        kind: 'deny',
        reason:
          'This dispatch has no task key, and a task key is mandatory for every delegated brief. ' +
          'Add a line `task: <slug>` (or `task=<slug>`) to the brief and dispatch again, e.g. `task: fix-gate-a`. ' +
          `Slug grammar: ${GRAMMAR}. ${SAME_JOB_RULE} ` +
          'The key is what lets this mode tell "a second dispatch of the same job" apart from "a second, unrelated job": ' +
          'without it two workers can be sent at the same files and both will write them.',
      }
    }

    if (parsed.kind === 'invalid') {
      return {
        kind: 'deny',
        reason:
          `The task key ${JSON.stringify(parsed.raw)} is not a valid slug. Slug grammar: ${GRAMMAR}. ` +
          `${SAME_JOB_RULE} Fix the \`task:\` line and dispatch again.`,
      }
    }

    if (parsed.kind === 'ambiguous') {
      return {
        kind: 'deny',
        reason:
          `This brief carries ${parsed.slugs.length} different task keys (${parsed.slugs
            .map((slug) => JSON.stringify(slug))
            .join(', ')}), so it is not clear which job this dispatch belongs to. ` +
          'A brief carries exactly one `task: <slug>` line: keep the key of the work this worker is doing, ' +
          'and remove the other one (if the brief covers two jobs, dispatch them as two briefs).',
      }
    }

    // ── 到这里 parsed.kind === 'ok' ──
    const caller = exec?.agent
    const callerIds = idsOf(caller)
    if (callerIds.length === 0) {
      // 取不到父会话 id 就没法做「按父会话隔离」——那是本模块唯一的隔离手段，
      // 猜一个会让两个无关对话互相干扰，所以按 fail-closed 拒绝。
      return {
        kind: 'deny',
        reason:
          'This delegation has no resolvable calling session id, so the task key cannot be scoped to this conversation. ' +
          'Dispatch from a normal session, or drop the `task:` line and use another route.',
      }
    }

    const table = registryOf()
    if (table === undefined) {
      // 登记表都造不出来（`globalThis` 被冻结之类）：无法强制，只能放行 + 告警。
      warn('the task-key registry is unavailable, so this dispatch is not deduplicated [TASK-KEY-SKIPPED]')
      return { kind: 'allow' }
    }

    prune(table, callerIds, now)

    const key = `${callerIds[0]}::${parsed.slug}`
    const existing = table.claims.get(key)
    if (existing !== undefined) {
      return { kind: 'deny', reason: describeConflict(parsed.slug, existing, now) }
    }

    table.claims.set(key, {
      key,
      slug: parsed.slug,
      tool: typeof exec?.name === 'string' ? exec.name : 'unknown',
      parentIds: callerIds,
      startedAt: now,
      ids: [],
      bound: false,
    })
    try {
      ctx.logger?.info?.(
        `dsh-multitask: TASK-KEY-CLAIMED slug=${JSON.stringify(parsed.slug)} tool=${JSON.stringify(String(exec?.name))} parent=${JSON.stringify(callerIds[0])}`,
      )
    } catch {
      // 同上：日志不可用不影响派发。
    }
    return { kind: 'allow' }
  }

  // ── 派遣闸门 ───────────────────────────────────────────────────────────────
  //
  // 先 `next()` 再判：**绝不覆盖别人的拒绝**（与 `approval-gate.mjs` 的分流同向）。
  // 上游说 allow 之后才轮到本模块表态，于是「别的守卫已经拒了」这件事不会被本模块
  // 改写成一个看起来完全不同的理由。
  //
  // ⚠️ 强制面**只有四个已确证 schema 的工具**。其余派遣类工具（brief 字段名没有
  // 确证）一律放行 + 一次 `info`：一个解析不出 brief 的工具被硬拒，就是把一条合法
  // 派遣路径堵死；漏拦只是回到加本模块之前（团队工具下同键并发不被检测）。
  const skipped = new Set()
  const skipOnce = (tool) => {
    if (skipped.has(tool)) return
    skipped.add(tool)
    try {
      ctx.logger?.info?.(
        `dsh-multitask: TASK-KEY-SKIPPED reason=unknown-schema tool=${JSON.stringify(tool)}`,
      )
    } catch {
      // 同上。
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      // 上游瀑布自己炸了：原样抛回去，别把它变成本模块的拒绝。
      throw error
    }
    try {
      if (downstream?.kind !== 'allow') return downstream
      const tool = exec?.name
      if (typeof tool !== 'string') return downstream
      // 方向闸门：worker 的调用一个字都不碰（见 `isDelegatedChild` 的注释）。
      if (isDelegatedChild(exec?.agent)) return downstream
      if (!VERIFIED_DISPATCH_TOOLS.includes(tool)) {
        // 连派遣类都算不上的工具（`read` / `pwsh` / …）：一个字都不碰，也不记日志。
        if (UNVERIFIED_DISPATCH_TOOLS.includes(tool)) skipOnce(tool)
        return downstream
      }

      const verdict = judge(exec, Date.now())
      if (verdict.kind === 'deny') {
        try {
          ctx.logger?.info?.(
            `dsh-multitask: TASK-KEY-REFUSED tool=${JSON.stringify(tool)} reason=${JSON.stringify(
              verdict.reason.slice(0, 160),
            )}`,
          )
        } catch {
          // 同上。
        }
        return { kind: 'deny', reason: verdict.reason }
      }
      return downstream
    } catch (error) {
      // 本模块自己的意外不能把一次正常派发变成拒绝：放行 + 一行 warn。
      warn(
        `task-key check failed, this dispatch is not deduplicated: ${
          error instanceof Error ? error.message : String(error)
        } [TASK-KEY-SKIPPED reason=check-threw]`,
      )
      return downstream
    }
  })

  // ── 绑定子会话 id ───────────────────────────────────────────────────────────
  //
  // 派发那一刻子会话还不存在（工具还没执行），所以占位先登记、id 后绑。
  // 只认**无歧义**的绑定：该父会话**恰好一个**未绑定的占位时才绑 ——
  // 并行派发多份 brief 时宁可不绑（拒绝文案里就说「id 还没拿到」），
  // 也不要把 A 的 id 记到 B 的任务上。
  ctx.on('agent/created', (payload) => {
    try {
      const child = payload?.agent
      const header = child?.session?.header
      if (header === undefined || header === null || typeof header !== 'object') return
      const parentSession = typeof header.parentSession === 'string' ? header.parentSession : ''
      if (parentSession === '') return
      const childIds = idsOf(child)
      if (childIds.length === 0) return

      const table = registryOf()
      if (table === undefined) return
      const candidates = []
      for (const claim of table.claims.values()) {
        if (claim === null || typeof claim !== 'object') continue
        if (Array.isArray(claim.ids) && claim.ids.length > 0) continue
        const parentIds = Array.isArray(claim.parentIds) ? claim.parentIds : []
        if (!parentIds.includes(parentSession)) continue
        candidates.push(claim)
      }
      if (candidates.length !== 1) return
      const claim = candidates[0]
      claim.ids = childIds
      claim.bound = true
    } catch (error) {
      warn(
        `binding a child session to its task key failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })

  // ── 释放：disposed 即放开那个键 ─────────────────────────────────────────────
  ctx.on('agent/disposed', (payload) => {
    try {
      const ids = idsOf(payload?.agent)
      if (ids.length === 0) return
      const table = registryOf()
      if (table === undefined) return
      for (const [key, claim] of [...table.claims.entries()]) {
        const claimIds = Array.isArray(claim?.ids) ? claim.ids : []
        if (claimIds.some((id) => ids.includes(id))) table.claims.delete(key)
      }
      for (const id of ids) {
        if (table.gone.includes(id)) continue
        table.gone.push(id)
      }
      while (table.gone.length > GONE_LIMIT) table.gone.shift()
    } catch (error) {
      warn(`releasing a task key failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  try {
    ctx.logger?.info?.(
      'dsh-multitask: task keys are enforced — a second dispatch of a live task key is refused [TASK-KEY-ENGAGED]',
    )
  } catch {
    // 日志通道不可用不影响任何行为。
  }
}

/**
 * 组装「这个键已经在跑」的拒绝文案。
 *
 * 三个信息缺一不可，否则协调者无从处置：
 *   1. **谁在跑**（会话 id 前 8 位 + 已运行时长）；
 *   2. 两条出路（等它结束 / 先 `interrupt_agent` 再派）；
 *   3. 为什么 `send_message` 不算「停」—— 它会给目标**新开**一轮，worker 接着跑。
 *
 * @param slug - 冲突的任务键。
 * @param claim - 已有的占位。
 * @param now - 当前时间。
 * @returns 拒绝文案（英文）。
 */
function describeConflict(slug, claim, now) {
  const ids = Array.isArray(claim?.ids) ? claim.ids : []
  const startedAt = typeof claim?.startedAt === 'number' ? claim.startedAt : now
  const elapsed = formatDuration(now - startedAt)
  const who =
    ids.length === 0
      ? `a worker whose session id is not known yet (dispatched ${elapsed} ago — the delegation has not returned its id yet)`
      : `worker ${String(ids[0]).slice(0, 8)} (running ${elapsed})`
  return (
    `Task ${JSON.stringify(slug)} is already being worked on by ${who} in this conversation, ` +
    'so a second dispatch of the same task key is refused: two workers on one job write the same files concurrently and silently overwrite each other. ' +
    'Either wait for that worker to finish, or stop it first with `interrupt_agent` and then dispatch again. ' +
    'Do NOT try to stop it with `send_message`: a message aborts its current turn and opens a NEW one, so the worker keeps running and reads your stop instruction on the next turn — `interrupt_agent` is the only thing that actually stops it. ' +
    'If this is genuinely a different piece of work, give it a different slug (and if it is the same work being taken over, restarted or reassigned, keep this slug and dispatch only after the first worker is stopped).'
  )
}
