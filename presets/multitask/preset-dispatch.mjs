/**
 * multitask-preset-dispatch — 让协调者能派活给**别的模式**。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 到此为止，协调者只能派给本 preset 内部的四类 worker（`subagent` / `subagent_fork` /
 * `subagent_ptc` / `subagent_minimal`）。而用户从**插件市场**装进来的模式（
 * standard / ptc / minimal / cordis / 任何第三方 preset）各自有自己的一套人格、工具面
 * 与工作流 —— 它们在本包里**完全不可达**。
 *
 * 本模块补上这一条：注册一个 `subagent_preset` 工具，让协调者按**各模式自己的描述**
 * 挑一个，把任务书投进去。于是「减震器」这个名字才真正成立：
 *
 *     用户  ──►  协调者（减震器）  ──►  任意已安装的模式
 *
 * 协调者的上下文里只留下任务书与结论，而中间过程在**那个模式的 worker** 里发生。
 *
 * ── 为什么不去读别的模式的内部结构 ──────────────────────────────────────────
 *
 * 刻意**只**用两样东西：注册表的 `list()`（拿到 id / 名称 / 描述 / 是否 broken）与
 * 上游的 `startActivation({ request: { agentPreset } })`。**不**解析别的 preset 的
 * 插件行、不猜它的工具名、不读它的 config —— 那是别人家的实现细节，任何一次上游改版
 * 都会让本模块跟着坏。按「描述文本」挑模式，是唯一稳定且不越界的依据。
 *
 * ── 为什么必须用 `spawn` provider ──────────────────────────────────────────
 *
 * `dsh-subagent` 的 `assertCapabilities()` 里有一条硬约束：
 *
 *     if (request.agentPreset !== undefined && (!provider.capabilities.agentPreset
 *         || provider.inheritsParentContext)) throw … "does not support independent agent preset selection"
 *
 * 即：**能选别的 preset** 与 **继承父会话上下文** 在语义上互斥（继承前缀的 fork 后端
 * 无法中途换一套组合）。内置的 `spawn` 能力位是 `agentPreset: true` +
 * `inheritsParentContext: false`，正好满足；`fork` 不满足。所以这里固定用 `spawn`，
 * 不做成配置项 —— 配错了只会在**委派那一刻**抛错，而报错信息指向的是 provider 能力，
 * 排查成本远高于「干脆不开放这个开关」。
 *
 * ── 失败取向 ─────────────────────────────────────────────────────────────────
 *
 * **绝不吞错**：派不出去时必须把原因原样带回去（未知 preset、broken、能力不匹配）。
 * 协调者据此能改派，而不是对着一个空 id 发呆。这与 `minimal-guard` 的「响亮告警」同向，
 * 与 `subagent-mode` 的「安静降级」相反 —— 因为这里的失败对**本次任务**是致命的。
 *
 * @module dsh-multitask/presets/multitask/preset-dispatch
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-preset-dispatch'

/**
 * 需要一个能起子代理的服务。
 *
 * 用 `inject` 而不是「apply 里探测」：本模块的**全部**价值就是这条委派路径，
 * 服务不在时注册一个必然失败的工具只会让模型浪费一轮。让 loader 把本行显示为
 * “waiting for subagents” 比塞一个坏工具诚实。
 */
export const inject = ['tools', 'subagents']

/** 工具名 —— 与协调者保留集里的那一项必须逐字一致（测试里比对）。 */
export const TOOL_NAME = 'subagent_preset'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    preset: {
      type: 'string',
      description:
        'Exact agent-preset id of the mode this worker should run under, as reported by the roster (call this tool with `list: true` first if you do not know the ids).',
    },
    prompt: {
      type: 'string',
      description:
        'The complete, self-contained task. The worker runs under a DIFFERENT mode: it does not see this conversation, and it does not share this mode\u2019s worker types.',
    },
    description: {
      type: 'string',
      description: 'A short (3-5 word) label for display.',
    },
    list: {
      type: 'boolean',
      description:
        'When true, return the installed modes (id, name, description, and whether each one can currently compose a session) instead of delegating. Use it to discover what is available.',
    },
  },
  required: [],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'False when the delegation was refused; the message says why.' },
    subagentId: { type: 'string', description: 'Durable child session id, present only when ok.' },
    message: { type: 'string', description: 'Human-readable result, or the exact refusal.' },
  },
  required: ['ok', 'message'],
}

/**
 * 每次进程只警告一次的记录器（与其余守卫同款）。
 *
 * @param ctx - 插件上下文。
 * @returns 记录函数。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/preset-dispatch: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 三个信号任一成立即视为子代理 —— 与 `coordinator-guard.mjs` / `minimal-guard.mjs` /
 * `subagent-mode.mjs` / `approval-gate.mjs` 保持**同一条判据**。
 *
 * 本模块用它回答一个具体问题：**调用者是不是正在本模式里干活的 worker？**
 * 如果是就必须拒绝 —— 委派深度固定为 1，worker 再派只会在 `startActivation` 里撞
 * `subagent depth 2 exceeds maxDepth 1`。那次失败白烧一轮，而且报错信息指向深度限制、
 * 与本模块毫无关系，很容易被误读成「跨模式派发坏了」。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为被委派的子代理。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 读注册表名册，并把它折成「可直接展示」的行。
 *
 * 上游的 `list()` 是 **async**（`dsh-agent-preset-registry` 的 `list()` 会 await 每一份
 * 声明的诊断，所以它必须异步）。任何一种读取失败都折成空数组，由调用方给出可读的拒绝。
 *
 * @param registry - `ctx.agentPresets`。
 * @returns `[{ id, name, description, broken }]`；注册表不可用或读取失败时为空数组。
 */
async function readRoster(registry) {
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
  try {
    const rows = await registry.list()
    if (!Array.isArray(rows)) return []
    return rows.map((row) => ({
      id: typeof row?.id === 'string' ? row.id : '',
      name: typeof row?.name === 'string' ? row.name : undefined,
      description: typeof row?.description === 'string' ? row.description : undefined,
      broken: typeof row?.broken === 'string' ? row.broken : undefined,
    })).filter((row) => row.id !== '')
  } catch {
    return []
  }
}

/**
 * 把名册渲染成给模型看的纯文本。
 *
 * 刻意**不用**动态 schema 枚举：名册会随用户安装 / 卸载插件而变，而工具 schema 在注册
 * 时就被投影进请求了。用文本返回 + 执行时校验，永远不会出现「枚举是旧的」这种错。
 *
 * @param rows - 名册行。
 * @param selfId - 本模式自己的 preset id（会被标注出来）。
 * @returns 多行文本。
 */
function renderRoster(rows, selfId) {
  if (rows.length === 0) {
    return 'No agent presets are registered in this deployment, so there is nothing to dispatch to.'
  }
  const lines = rows.map((row) => {
    const label = row.name === undefined ? row.id : `${row.name} (${row.id})`
    const notes = []
    if (row.id === selfId) notes.push('this mode')
    if (row.broken !== undefined) notes.push(`CANNOT RUN: ${row.broken}`)
    const suffix = notes.length === 0 ? '' : `  [${notes.join('; ')}]`
    const description = row.description === undefined ? '' : `\n    ${row.description}`
    return `- ${label}${suffix}${description}`
  })
  return `Installed agent modes:\n${lines.join('\n')}`
}

/**
 * 装载本模块：注册 `subagent_preset`。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled, selfPresetId }`（见 `composition.mjs` 那一行）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)
  const selfId = typeof config?.selfPresetId === 'string' && config.selfPresetId !== '' ? config.selfPresetId : 'multitask'

  /**
   * 取注册表。
   *
   * 直接用 `ctx.get()`：Cordis 的服务查找沿父链上溯，而 `agentPresets` 没有被 isolate
   * 到任何 realm 里，所以 preset 内的 scope 也能取到宿主平面那一份。
   *
   * @returns 注册表，或 undefined。
   */
  const registryOf = () => {
    try {
      for (const name of ['agentPresets']) {
        const registry = ctx.get?.(name)
        if (registry !== undefined && registry !== null) return registry
      }
    } catch {
      // 服务不可用不是致命错误：调用方会给出可读的拒绝。
    }
    return undefined
  }

  /**
   * 派一个任务给指定模式。
   *
   * @param args - 工具参数。
   * @param exec - 工具执行输入（含 `agent` / `signal`）。
   * @returns 输出对象。
   */
  const delegate = async (args, exec) => {
    const presetId = typeof args?.preset === 'string' ? args.preset.trim() : ''
    const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
    if (presetId === '') return { ok: false, message: 'A `preset` id is required. Call with `list: true` to see the available ids.' }
    if (prompt.trim() === '') return { ok: false, message: 'A non-empty `prompt` is required: the worker does not see this conversation.' }

    const parent = exec?.agent
    if (parent === undefined || parent === null) {
      return { ok: false, message: 'This tool requires a calling Agent (exec.agent was undefined).' }
    }

    // ── 硬前置：worker 不能再往下派 ──
    //
    // 委派深度固定为 1（composition 里四行都是 `maxDepth: 1`）。不在这一层挡住的话，
    // 这次调用会一直走到 `startActivation` 才被深度限制拒绝，而那条报错说的是
    // 「subagent depth 2 exceeds maxDepth 1」，看不出与跨模式派发有关 —— 很容易被
    // 误读成「这个功能坏了」，然后有人去改 provider 或 preset，白绕一圈。
    if (isDelegatedChild(parent)) {
      return {
        ok: false,
        message:
          'A delegated worker cannot dispatch further (delegation depth is fixed at 1). ' +
          'Do the work yourself, or report back so the coordinator can dispatch it.',
      }
    }

    const registry = registryOf()
    if (registry === undefined) {
      return { ok: false, message: 'The agent-preset registry is unavailable in this deployment, so no mode can be selected.' }
    }

    const rows = await readRoster(registry)
    if (rows.length === 0) {
      return { ok: false, message: 'The preset roster is empty, so there is no mode to dispatch to.' }
    }

    const known = rows.filter((row) => row.broken === undefined).map((row) => row.id)
    if (!known.includes(presetId)) {
      const broken = rows.find((row) => row.id === presetId)
      if (broken !== undefined && broken.broken !== undefined) {
        return {
          ok: false,
          message: `Agent preset "${presetId}" exists but cannot compose a session: ${broken.broken}`,
        }
      }
      return {
        ok: false,
        message: `Unknown agent preset "${presetId}". Available: ${known.length === 0 ? '(none that can run)' : known.join(', ')}`,
      }
    }

    if (presetId === selfId) {
      // 派给本模式会造出一个「子协调者」。深度限制会让它派不出去，但那是一次白跑，
      // 而且很容易让人误以为这功能坏了 —— 直接拒绝并给出正确的替代路径。
      return {
        ok: false,
        message:
          `"${presetId}" is this mode itself. To work inside Multitask use its own delegation tools ` +
          '(subagent / subagent_fork / subagent_ptc / subagent_minimal) instead.',
      }
    }

    const subagents = (() => {
      try {
        return ctx.get('subagents')
      } catch {
        return undefined
      }
    })()
    if (subagents === undefined || subagents === null || typeof subagents.startActivation !== 'function') {
      return { ok: false, message: 'The subagent service is unavailable, so no mode can be dispatched to.' }
    }

    // 与上游 `tool-subagent` 同形：可选字段只在有值时才写进去，避免用显式的 undefined
    // 顶掉后端默认值。
    const request = {
      prompt: [{ type: 'text', text: prompt }],
      parent,
      agentPreset: presetId,
    }
    // `maxDepth` 只在服务能解析时才带上（能力位不匹配会在 startActivation 里被拒）。
    try {
      const maxDepth = subagents.resolveMaxDepth?.(1)
      if (maxDepth !== undefined) request.maxDepth = maxDepth
    } catch {
      // 解析不了就不带：让服务用它自己的默认值。
    }

    try {
      const activation = await subagents.startActivation({
        provider: 'spawn',
        label: typeof args?.description === 'string' && args.description !== '' ? args.description : `delegate to ${presetId}`,
        request,
        signal: exec?.signal,
        delivery: 'parent',
      })
      const subagentId = typeof activation?.childId === 'string' ? activation.childId : undefined
      if (subagentId === undefined) {
        return { ok: false, message: `Dispatching to "${presetId}" returned no subagent id.` }
      }
      ctx.logger?.info?.(
        `dsh-multitask: delegated to agent preset "${presetId}" as subagent ${subagentId} [PRESET-DISPATCH-STARTED]`,
      )
      return { ok: true, subagentId, message: `Started a "${presetId}" worker: ${subagentId}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(
        `dispatching to agent preset "${presetId}" failed: ${message} [PRESET-DISPATCH-SKIPPED reason=start-threw]`,
      )
      return { ok: false, message: `Dispatching to "${presetId}" failed: ${message}` }
    }
  }

  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Delegate a self-contained task to a worker running under a DIFFERENT installed agent mode (agent preset). ' +
        'Use it when another mode fits the job better than this mode\u2019s own workers \u2014 for example a mode installed from the ' +
        'plugin market that specialises in a workflow this mode does not cover. ' +
        'Call with `list: true` to read the roster (id, name, description) and pick by what each mode says it is for; ' +
        'the descriptions are the only stable, mode-owned description of their capabilities. ' +
        'The worker returns its result to you and does not see this conversation, so the brief must be self-contained. ' +
        'It starts in the background and this call returns its id immediately.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args?.list === true) {
          const rows = await readRoster(registryOf())
          return { ok: true, message: renderRoster(rows, selfId) }
        }
        return delegate(args, exec)
      },
    })
    ctx.logger?.info?.(
      `dsh-multitask: registered "${TOOL_NAME}" \u2014 the coordinator can dispatch to any installed agent mode [PRESET-DISPATCH-ENGAGED]`,
    )
  } catch (error) {
    warn(
      `registering "${TOOL_NAME}" failed: ${error instanceof Error ? error.message : String(error)} \u2014 ` +
        'cross-mode dispatching is unavailable, the rest of the mode keeps working [PRESET-DISPATCH-SKIPPED reason=register-threw]',
    )
  }
}
