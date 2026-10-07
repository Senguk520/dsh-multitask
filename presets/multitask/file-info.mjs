/**
 * multitask-file-info — 一个**只读**的文件元数据工具（报字节数等）。
 *
 * ── 它解决什么问题（实测缺陷 D5）─────────────────────────────────────────────
 *
 * 本机部署里**没有任何工具**能取一个文件的元数据：`read` 只回「内容 + 总行数」，
 * 不回字节数；`glob` / `grep` 回的是匹配结果，不是大小。于是「这五个文件一共多大」
 * 这类问题**只能靠 shell**（`Get-Item ... | Measure-Object Length -Sum`）。
 * 而 shell 一旦不可用（沙箱拒绝 / 平台没有可用的 shell / 命令被拦），这个信息就
 * **完全拿不到** —— 没有第二条路可走。这就是 D5。
 *
 * ── 为什么是「本仓库内的绕道」，而不是把 `read` 改了 ──────────────────────────
 *
 * `read` 内部**本来就有**字节数：`dsh-tool-fs` 的 `resolveRegularReadTarget()` 已经
 * 拿到 `info`，`info.size` 就是字节数（见 `dsh-tool-fs/lib/index.js:202-213`、
 * `:348` 用它决定是否流式读）。上游要把它暴露给模型只需三处小改（output schema
 * 加一个字段、返回值带一个字段、render 多打一行）。
 *
 * 但这台机器上**没有可编辑的 DSH 源码树**：只有 `G:\DSH\resources\app.asar`
 * （发布归档）。所以上游那半边只能上报，**本模块是绕道**：不去改 `read`，
 * 而是自己注册一个新工具，走**同一道** `ctx.fs` seam 拿同样的 `info`。
 *
 * ── 为什么零 import（本包预设内模块的硬约定）────────────────────────────────
 *
 * `subagent-mode.mjs` / `minimal-guard.mjs` / `coordinator-guard.mjs` 都是零 import。
 * 本模块照做，代价是常量表要自己留一份（例如工具名），收益是不会把
 * `@deepseek-ai/*` 变成 preset 模块图的**硬依赖**：导入失败 = 整份 preset 挂载失败。
 *
 * ── 为什么不用 `node:fs`（这是安全取向，不是风格洁癖）────────────────────────
 *
 * `node:fs` 会**绕过**部署的沙箱策略与路径解析契约。`ctx.fs` 是部署真正围栏过的那道
 * seam：`dsh-fs-sandbox` 注册它（`说明-文件与命令的管控机制.md:35`），`read` / `write` /
 * `edit` / `read_image` 全部经它。所以本模块也用 `ctx.fs.resolve()` +
 * `ctx.fs.stat()` —— 与 `read` 拿到的是**同一个** `info`，只是不读内容。
 *
 * ── 为什么一注册就是普通对象字面量（不是 `defineTool`）───────────────────────
 *
 * `ctx.tools.register()` 的校验只有四件事（`dsh-tools/lib/index.js:2878-2887`）：
 * `output` 是对象且 `output.render` 是函数、`output.schema` 属于受支持的 JSON Schema
 * 子集、`timeoutMs` 若给必须是正有限数、名字不得是保留传输名 `run_code`。
 * **不要求 `defineTool`，也不要求 `parameters` 已被编译。** 同生态里就有现成先例：
 * `dsh-subagent-in-process-driver/lib/index.js:55` 直接注册普通对象字面量。
 *
 * ⚠️ 代价必须写清楚：`register()` **不代验参数**（参数校验只存在于 `defineTool` 包出来
 * 的那层 wrapper 里，见 `dsh-tools/lib/index.js:866-870`）。所以本模块**自己**校验
 * 入参，并把「我宣传了什么」与「我实际强制什么」保持一致 —— 参数 schema 上写了
 * `additionalProperties: false`，就必须真的拒绝多余键。
 *
 * ── 为什么输入是「一组路径」（而不是一个）────────────────────────────────────
 *
 * D5 的原始用例就是「五个文件，要**总**字节数」。一次调用收一组路径，让「一条程序
 * 顶一长串单次调用」的收益也在原生面上成立，并且**总字节数由本工具算**，不必让模型
 * 自己把五个数字加起来（那正是它算错的地方）。
 *
 * ── 「未知大小」必须与 0 字节可区分（本模块最容易被写错的一处）────────────────
 *
 * `FsInfo.size` 是**可选**的（`{ version; type: 'file'|'directory'|'other'; size?: number }`）
 * —— provider 可以不报。`dsh-tool-fs:348` 拿 `info.size === void 0` 当「大小未知」，
 * 配置文档也写「Files at or above this size (**or of unknown size**) stream…」。
 * 所以：
 *
 *   · 大小未知 ⇒ `sizeKnown: false`，**且 `sizeBytes` 这个键整个缺席**（不是 `0`）——
 *     缺席不可能被误读成 0，而 `0` 会被；
 *   · 只有 `type === 'file'` 且 `size` 是有限非负数时，才报 `sizeBytes`；
 *   · 目录**不报字节数**（POSIX 给目录的 size 是元数据块大小，报出来只会被误读），
 *     但仍然如实报 `status: 'directory'`；
 *   · 不存在 / 不可读**各自成类**（`missing` / `error`），绝不当成 0 字节的文件。
 *
 * ── 失败要响亮（与 `minimal-guard.mjs` 同取向）───────────────────────────────
 *
 * 本模块存在的理由是「拿不到元数据时还有第二条路」。所以**装不上必须喊出来**：
 * `ctx.fs` 不可用 / `tools.register` 抛错时，一条带固定标识的 warn（每种原因一次），
 * 且**宁可什么都不注册**，也不要注册一个调了必然失败的工具 —— 后者会让模型以为
 * 它有这条路，而实际上没有（比没有更糟）。
 *
 * 两个固定标识逐字 ASCII，专供装机后 grep 日志：
 *   · `FILE-INFO-ENGAGED` —— 工具**真的**注册上了；
 *   · `FILE-INFO-SKIPPED reason=…` —— 没注册，以及为什么。
 *
 * @module dsh-multitask/presets/multitask/file-info
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-file-info'

/**
 * ⚠️ 声明 `fs` 是**硬前置**，而不是可选项。
 *
 * 理由与 `dsh-tool-fs` 逐字相同（`dsh-tool-fs/lib/index.js:1176-1180` 的 inject 就是
 * `["tools","fs","systemPrompt"]`）：没有 fs 服务时，本工具**无法**取得任何元数据，
 * 而它唯一的卖点就是「能取到」。声明 inject 让 cordis 直接把它挂住（mount 审计里
 * 显示为 waiting，是**可见**的），好过注册一个空壳工具。
 *
 * `apply()` 里仍保留一条运行期兜底检查（测试桩 / 局部挂载会绕过 inject），
 * 见下。
 */
export const inject = ['tools', 'fs']

/**
 * 模型面工具名。
 *
 * ── 为什么叫 `file_info` 而不是 `stat` ────────────────────────────────────────
 *
 * 1. `stat` 会**过度承诺**：POSIX `stat` 回 mtime / mode / uid / inode…，而本工具只回
 *    「字节数 + 类型」这几项（`FsInfo` 里本来也只有这些）。名字一旦叫 `stat`，
 *    模型会期待一个它拿不到的完整 stat 结构。
 * 2. 与既有命名风格一致：DSH 的工具名是 snake_case 的「名词_动词/名词」形
 *    （`read_image` `job_list` `job_output` `task_board_get` `subagent_minimal`），
 *    `file_info` 落在这个形态里；`stat` 是个孤立的动词。
 * 3. 与 `read` / `grep` / `glob` 并列时也不歧义：那三个都是「对文件做什么」，
 *    `file_info` 一眼就是「问它的元数据」。
 *
 * ⚠️ 不要改成 `run_code` —— 那是 PTC 呈现的保留传输名，`register()` 会**硬拒**
 * （`dsh-tools/lib/index.js:2885`）。
 */
const TOOL_NAME = 'file_info'

/** 一次调用允许的路径数上限。防的是一条畸形调用把整个回合拖死，不是防模型。 */
const MAX_PATHS = 256

/** 装机后可供 grep 的两个固定标识（逐字 ASCII，不要改写或本地化）。 */
const ENGAGED = 'FILE-INFO-ENGAGED'
const SKIPPED = 'FILE-INFO-SKIPPED'

/**
 * 参数 schema（**原始 JSON Schema**，不是 `defineTool` 的 DSL）。
 *
 * 这是直接交给 `register()` 的形状，所以 `required` 必须是**数组**（DSL 里那种
 * 写在属性节点内的 `required: true` 由编译器转换，这里没有编译器）。
 * `assertSupportedJsonSchema` 只接受子集：type / oneOf / properties / required /
 * additionalProperties / items / enum / const + 注解（description/title/default/examples）。
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One or more paths to report on, resolved by the filesystem backend (relative paths use the session working directory).',
    },
  },
  required: ['paths'],
}

/**
 * 输出值的 schema。
 *
 * `additionalProperties: false` 在**输出**方向上是硬约束：上游会用
 * `validateJsonSchemaValue(tool.output.schema, value, "value")` 校验 `execute` 的返回值
 * （`dsh-tools/lib/index.js:3541-3545`），多一个键就是 `ToolOutputError`。
 * 所以这里列出的字段必须与 `inspectOne()` / `totalsOf()` 产出的逐字一致。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entries: {
      type: 'array',
      description: 'One entry per requested path, in the requested order.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestedPath: { type: 'string', description: 'Exactly what the caller asked for.' },
          resolvedPath: {
            type: 'string',
            description: 'The backend-resolved path; equals requestedPath when resolution failed.',
          },
          status: {
            type: 'string',
            enum: ['file', 'directory', 'other', 'missing', 'error'],
            description:
              'What this path is. `missing` = absent, `error` = it could not be inspected (see note), `other` = neither a regular file nor a directory.',
          },
          sizeKnown: {
            type: 'boolean',
            description:
              'True only when this entry carries an authoritative byte count. False means the size is UNKNOWN, which is never the same as 0 bytes.',
          },
          sizeBytes: {
            type: 'integer',
            description: 'Byte count. Present if and only if sizeKnown is true.',
          },
          note: {
            type: 'string',
            description: 'Why this entry is in this state, when that is not self-evident.',
          },
        },
        required: ['requestedPath', 'resolvedPath', 'status', 'sizeKnown'],
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requested: { type: 'integer' },
        files: { type: 'integer' },
        directories: { type: 'integer' },
        others: { type: 'integer' },
        missing: { type: 'integer' },
        errors: { type: 'integer' },
        bytes: {
          type: 'integer',
          description: 'Sum of the KNOWN byte counts only. Unknown sizes contribute nothing, so read unknownSizes before treating this as a total.',
        },
        unknownSizes: { type: 'integer', description: 'How many regular files reported no byte count.' },
        complete: {
          type: 'boolean',
          description: 'True only when every requested path is a regular file whose byte count is known.',
        },
      },
      required: [
        'requested',
        'files',
        'directories',
        'others',
        'missing',
        'errors',
        'bytes',
        'unknownSizes',
        'complete',
      ],
    },
  },
  required: ['entries', 'totals'],
}

/** 一个每次进程每种原因只警告一次的记录器（与 minimal-guard / coordinator-guard 同款，避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/file-info: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/** 给错误消息用的类型名（`null` / 数组 / typeof，够诊断就行）。 */
function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 校验并归一化入参。
 *
 * ⚠️ 为什么必须自己校验：`ctx.tools.register()` **不代验参数**（只校验 output 与名字），
 * 校验只存在于 `defineTool` 包出来的那层 wrapper 里（`dsh-tools/lib/index.js:866-870`）。
 * 本模块零 import、不调 `defineTool`，所以这一步是**唯一**的入参防线。
 *
 * 抛出的错误会由执行流水线收进 `isError: true` 的工具结果
 * （`dsh-tools/lib/index.js:3310-3314`：`tool.execute` 的 reject → `toolErrorResult`），
 * 也就是说「抛出」在这里是**申报失败的正规方式**，不会变成未捕获异常。
 * 同生态的 `ToolArgsError` 就是这么用的。
 *
 * @param args - 模型生成的原始参数，形状任意。
 * @returns 校验通过的路径数组（保留调用方顺序）。
 */
function parsePaths(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${TOOL_NAME}: arguments must be an object with a "paths" array, received ${typeName(args)}`)
  }
  // 声明了 additionalProperties: false 就必须真的拒绝多余键 —— 否则 schema 在说谎。
  for (const key of Object.keys(args)) {
    if (key !== 'paths') {
      throw new Error(`${TOOL_NAME}: unknown argument "${key}"; this tool accepts only "paths"`)
    }
  }
  const paths = args.paths
  if (paths === undefined) {
    throw new Error(`${TOOL_NAME}: "paths" is required — an array of one or more non-empty path strings`)
  }
  if (!Array.isArray(paths)) {
    throw new Error(`${TOOL_NAME}: "paths" must be an array of strings, received ${typeName(paths)}`)
  }
  if (paths.length === 0) {
    throw new Error(`${TOOL_NAME}: "paths" must not be empty; pass at least one path`)
  }
  if (paths.length > MAX_PATHS) {
    throw new Error(`${TOOL_NAME}: too many paths (${paths.length}); at most ${MAX_PATHS} per call`)
  }
  for (const [index, entry] of paths.entries()) {
    if (typeof entry !== 'string') {
      throw new Error(`${TOOL_NAME}: paths[${index}] must be a string, received ${typeName(entry)}`)
    }
    if (entry.trim() === '') {
      throw new Error(`${TOOL_NAME}: paths[${index}] must be a non-empty string`)
    }
  }
  return paths
}

/**
 * 本次调用所属会话的工作目录。
 *
 * 与 `dsh-tool-fs` 的 `sessionCwd()` 同款（`dsh-tool-fs/lib/index.js:173-175`）：
 * 取 `exec.agent.session.header.cwd`。取不到就返回 undefined，由后端套用它自己的默认值。
 * 包一层 try 是因为测试桩可以给出任意形状的 exec。
 *
 * @param exec - 当前工具执行上下文。
 * @returns 会话 cwd，或 undefined。
 */
function sessionCwd(exec) {
  try {
    return exec?.agent?.session?.header?.cwd
  } catch {
    return undefined
  }
}

/** XML 属性值转义 —— 路径里出现 `&` / `<` / `"` 时不能让渲染出的文本变成畸形结构。 */
function escapeAttribute(text) {
  return String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

/**
 * 检查**一个**路径。
 *
 * 每个 `await` 都各自包在 try 里：一次调用里某个路径不可读，绝不能把整批结果带走
 * —— D5 的用例（五个文件求和）最怕的就是「其中一个读不到 ⇒ 什么都拿不到」。
 *
 * ⚠️ 只调 `resolve` 与 `stat`：本模块**只读**，绝不调 fs 上任何写入/删除/建目录的方法。
 *
 * @param fs - `ctx.fs` 服务。
 * @param requestedPath - 调用方给的原始路径。
 * @param options - 交给 `fs.resolve` 的解析选项（cwd / signal）。
 * @param signal - 取消信号（转交给 `fs.stat`）。
 * @returns 一个 entry 记录，形状必须落在 OUTPUT_SCHEMA 之内。
 */
async function inspectOne(fs, requestedPath, options, signal) {
  let target
  try {
    target = await fs.resolve(requestedPath, options)
  } catch (error) {
    return {
      requestedPath,
      resolvedPath: requestedPath,
      status: 'error',
      sizeKnown: false,
      note: `could not resolve this path: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const resolvedPath = typeof target?.displayPath === 'string' && target.displayPath !== '' ? target.displayPath : requestedPath

  let info
  try {
    info = await fs.stat(target, signal)
  } catch (error) {
    return {
      requestedPath,
      resolvedPath,
      status: 'error',
      sizeKnown: false,
      note: `could not stat this path: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // 缺席的**申报方式**就是 `undefined`（`dsh-tool-fs/lib/index.js:205`），不是抛错。
  if (info === undefined || info === null) {
    return {
      requestedPath,
      resolvedPath,
      status: 'missing',
      sizeKnown: false,
      note: 'no such path (absent — this is not a zero-byte file)',
    }
  }

  if (info.type === 'directory') {
    return {
      requestedPath,
      resolvedPath,
      status: 'directory',
      sizeKnown: false,
      note: 'a directory has no meaningful byte count',
    }
  }

  if (info.type !== 'file') {
    return {
      requestedPath,
      resolvedPath,
      status: 'other',
      sizeKnown: false,
      note: `the backend reports this as "${String(info.type)}", neither a regular file nor a directory`,
    }
  }

  const size = info.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    // ⚠️ 这一支就是「不要编一个 0」的落点。`size` 是可选字段，provider 可以不报。
    return {
      requestedPath,
      resolvedPath,
      status: 'file',
      sizeKnown: false,
      note: 'the filesystem backend did not report a byte size for this file — the size is UNKNOWN, not 0',
    }
  }

  return {
    requestedPath,
    resolvedPath,
    status: 'file',
    sizeKnown: true,
    sizeBytes: Math.trunc(size),
  }
}

/**
 * 汇总一批 entry。
 *
 * `bytes` 只累加**已知**大小；`unknownSizes` 单独计数，并把 `complete` 置假 ——
 * 这样「总数看似拿到了，其实少了几个」这件事在结构化值里就自曝了，
 * 而不是让调用方从一个静默偏小的和里推断。
 *
 * @param entries - `inspectOne()` 的产出数组。
 * @returns 与 OUTPUT_SCHEMA 的 `totals` 逐字一致的对象。
 */
function totalsOf(entries) {
  const totals = {
    requested: entries.length,
    files: 0,
    directories: 0,
    others: 0,
    missing: 0,
    errors: 0,
    bytes: 0,
    unknownSizes: 0,
    complete: true,
  }
  for (const entry of entries) {
    if (entry.status === 'file') {
      totals.files += 1
      if (entry.sizeKnown === true) totals.bytes += entry.sizeBytes
      else totals.unknownSizes += 1
    } else if (entry.status === 'directory') totals.directories += 1
    else if (entry.status === 'other') totals.others += 1
    else if (entry.status === 'missing') totals.missing += 1
    else totals.errors += 1

    if (!(entry.status === 'file' && entry.sizeKnown === true)) totals.complete = false
  }
  return totals
}

/**
 * 把值渲染成模型面文本。
 *
 * 顶部那行**自带总字节数**：D5 的用例（「五个文件一共多大」）不必让模型自己去加。
 * `bytes="unknown"` 是「未知」在文本面的表达 —— 与 0 泾渭分明。
 *
 * ⚠️ renderer 抛错会被上游变成 `output.render failed`（`dsh-tools/lib/index.js:3547-3551`），
 * 所以这里对 `value` 的形状做防御性降级，绝不假设它长什么样。
 *
 * @param args - 原始参数（本渲染不用它，保留签名以符合契约）。
 * @param value - 已校验的返回值。
 * @returns 一个文本内容块。
 */
function render(_args, value) {
  const entries = Array.isArray(value?.entries) ? value.entries : []
  const totals = value?.totals ?? {}
  const lines = [
    `<file_info requested="${totals.requested ?? entries.length}" files="${totals.files ?? 0}" directories="${totals.directories ?? 0}" others="${totals.others ?? 0}" missing="${totals.missing ?? 0}" errors="${totals.errors ?? 0}" bytes="${totals.bytes ?? 0}" unknown_sizes="${totals.unknownSizes ?? 0}" complete="${totals.complete === true}">`,
  ]
  for (const entry of entries) {
    const size = entry?.sizeKnown === true ? String(entry.sizeBytes) : 'unknown'
    const note = typeof entry?.note === 'string' && entry.note !== '' ? ` note="${escapeAttribute(entry.note)}"` : ''
    lines.push(
      `<entry path="${escapeAttribute(entry?.requestedPath ?? '')}" resolved="${escapeAttribute(entry?.resolvedPath ?? '')}" status="${escapeAttribute(entry?.status ?? 'error')}" bytes="${size}"${note}/>`,
    )
  }
  if (totals.unknownSizes > 0) {
    lines.push(
      `<warning>${totals.unknownSizes} regular file(s) reported no byte count — bytes is a partial sum, not a total</warning>`,
    )
  }
  lines.push('</file_info>')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 装载只读元数据工具。
 *
 * @param ctx - preset scope 的插件上下文（`ctx.fs` 与 `ctx.tools` 都在它上面）。
 * @param config - 该行在 composition 里的 `config`（只认 `{ enabled }`）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)

  // ── 兜底：能力检查 ──
  //
  // `inject: ['tools','fs']` 已经保证真实宿主里两者都在（缺 fs 时 cordis 会把本行挂住，
  // 在 mount 审计里显示为 waiting）。这里再查一次，防的是**绕过 inject 的情形**：
  // 测试桩、局部挂载、或者某个部署把 fs 换成了一个没有 `stat` 的实现。
  //
  // ⚠️ 绝不「降级成注册一个残缺工具」：那会让模型以为自己有这条路，而调用必然失败 ——
  // 比根本没有这个工具更糟（它会浪费一整轮去试）。
  if (typeof ctx?.tools?.register !== 'function') {
    warn(
      `${SKIPPED} reason=no-tools — ctx.tools.register() is unavailable, so "${TOOL_NAME}" was NOT registered; ` +
        'no file metadata can be reported this session',
    )
    return
  }
  const fs = ctx?.fs
  if (fs === undefined || fs === null || typeof fs.stat !== 'function' || typeof fs.resolve !== 'function') {
    warn(
      `${SKIPPED} reason=no-fs — ctx.fs does not expose resolve()+stat(), so "${TOOL_NAME}" was NOT registered; ` +
        'file byte sizes remain reachable only through a shell this session',
    )
    return
  }

  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Report read-only metadata (byte count, kind) for one or more paths in a single call. ' +
        'Returns one entry per requested path: a regular file reports its byte count, or an explicit unknown-size marker ' +
        'when the filesystem backend does not provide one (never a fabricated 0); a directory is reported as a directory ' +
        'without a byte count; a missing or uninspectable path is reported as such and never as 0 bytes. ' +
        'The totals field sums the known byte counts. Use this instead of shell commands to measure or verify file sizes; ' +
        'nothing is read into the conversation and nothing is modified.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render,
      },
      // 纯只读 ⇒ 与别的只读工具并行调度，不让它拖慢无关调用。
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        // 入参非法 ⇒ 抛出（流水线会收成 `isError: true` 的工具结果）。见 parsePaths 的注释。
        const paths = parsePaths(args)

        const cwd = sessionCwd(exec)
        const signal = exec?.signal
        // 与 `dsh-tool-fs` 的 `sessionResolveOptions()` 同构：只在**有值**时才带上该键，
        // 不写 `cwd: undefined`（后者会让后端的默认值被一个显式的 undefined 顶掉）。
        const options = {}
        if (cwd !== undefined) options.cwd = cwd
        if (signal !== undefined && signal !== null) options.signal = signal

        const entries = []
        for (const requestedPath of paths) {
          // 已取消就不再逐个 stat：剩下的如实标成「没查」，不假装查过。
          if (signal?.aborted === true) {
            entries.push({
              requestedPath,
              resolvedPath: requestedPath,
              status: 'error',
              sizeKnown: false,
              note: 'not inspected: this call was aborted',
            })
            continue
          }
          entries.push(await inspectOne(fs, requestedPath, options, signal))
        }

        return { entries, totals: totalsOf(entries) }
      },
    })
    ctx.logger?.info?.(
      `dsh-multitask/file-info: ${ENGAGED} — registered read-only tool "${TOOL_NAME}" on ctx.fs.resolve()+stat()`,
    )
  } catch (error) {
    // 注册失败必须响亮：本模块是「shell 之外的第二条路」，装不上等于 D5 没解决。
    warn(
      `${SKIPPED} reason=register-failed — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
