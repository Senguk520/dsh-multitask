/**
 * dsh-multitask — 两类自建 worker 的 **provider** 注册（宿主半的辅助模块）。
 *
 * ── 它为什么存在 ─────────────────────────────────────────────────────────────
 *
 * 本模式要按 worker 种类给出不同的人格与不同的工具面，而「这个子代理属于哪一类」必须
 * 有一个**由委派行决定、且落进子代理会话**的标记。DSH 0.2.1-rc.2 删除了
 * `dsh-tool-subagent` 的 `persona` 与 `toolFilter` 两个配置项（配置里出现即抛错、
 * 整个 preset 挂载失败），于是只剩 `provider` 满足条件：
 *
 *   · 由**这一行**决定（不是模型传的参数）；
 *   · 原样写进 `subagent/descriptor`（`data.provider`），在 `agent/created` 窗口读得到；
 *   · 同一个实现可以注册多个名字，因此「每类 worker 一个名字」成立。
 *
 * 内置的 `spawn` / `fork` 已经被主路径两条委派行占用，所以另外两类 worker 需要**新的
 * provider 名**：`multitask_ptc` 与 `multitask_minimal`。本模块就负责注册它们。
 *
 * ── 为什么不直接在 profile patch 里加两行 `dsh-subagent-spawn-in-process` ─────
 *
 * 那样在「用发布包安装」的路径下可行（bundle patch 会展开），但**源码 checkout 的
 * 安装路径**（`install-multitask.ps1` 只往 profile patch 追加一行 `file://` 条目）
 * 拿不到 bundle patch，两个 provider 就不存在 —— 两条委派工具**静默不注册**，
 * 模式退化成只能派两类 worker。放在宿主半里则两条安装路径都成立。
 *
 * ── 为什么不把这两行放进 preset 内部 ─────────────────────────────────────────
 *
 * ⚠️ 这是踩过的坑，别改回去：`ctx.subagents.registerProvider()` 的 effect 由**服务
 * 自己的 context** 拥有，不是调用方的 fiber。于是把注册行放进 preset 之后，preset
 * 重新声明（改设置里的模型就会触发）时**旧注册不会被卸掉**，新一代再注册同名 provider
 * 会撞 `a subagent provider named "…" is already registered` —— 而那会让
 * **整个 preset 挂载失败**，模式直接从新会话列表消失。放在宿主半、且整进程只注册一次，
 * 这个竞态就不存在。
 *
 * ── 实现为什么与上游 `dsh-subagent-spawn-in-process` 逐字同形 ────────────────
 *
 * 它是进程内 spawn 后端，本模块只是给同一个后端**再起两个名字**。能力位必须齐全，
 * 否则 `dsh-subagent` 的 `assertCapabilities()` 会在**委派时**拒绝：
 *
 *   · `depthLimit` —— 四行都写了 `maxDepth`，缺了它委派直接抛 UNSUPPORTED_CAPABILITY；
 *   · `agentOptions` —— 用户在设置面板里按类型指定模型时，`agentOptions` 会随请求下发；
 *   · `agentPreset` / `outputSchema` —— 与上游保持一致，避免「同名 provider 能力不同」
 *     带来的行为差异；
 *   · `inheritsParentContext: false` —— spawn 是**全新上下文**，与 fork 相反。
 *
 * `prepareContinuable()` 返回 `` 表示「没有继承前缀」。它的**存在**就是
 * `dsh-subagent` 判断「这个 provider 支持续接」的依据（`startActivation` 据此走
 * `startLocal` 而不是 `startExternal`），所以四类 worker 都保持可续接 —— 审批闸门的
 * 兜底通知依赖这一点。
 *
 * @module dsh-multitask/lib/worker-providers
 */

/**
 * 进程内 spawn 后端（与上游 `@deepseek-ai/dsh-subagent-spawn-in-process` 同形）。
 *
 * 上游那个类没有导出（`lib/index.js` 只导出 `Config` / `apply` / `inject` / `name`），
 * 所以这里按同样的形状重写一遍。字段改名或语义变化时，`dsh-subagent` 的
 * `assertCapabilities()` 会立刻以委派失败的形式暴露出来，不会静默失配。
 */
class InProcessSpawnProvider {
  /**
   * @param name - 注册到 `ctx.subagents` 的名字；委派行的 `config.provider` 必须与它逐字相同。
   */
  constructor(name) {
    this.name = name
    /** 与上游 spawn 后端一致的能力位（缺 `depthLimit` 会让带 `maxDepth` 的委派直接失败）。 */
    this.capabilities = {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    }
    /** spawn 是全新上下文：不继承父会话的历史。 */
    this.inheritsParentContext = false
  }

  /**
   * 续接准备的贡献。
   *
   * 方法**存在**本身即「本 provider 支持续接」；返回空对象 = 不给子会话任何继承前缀
   * （与上游逐字一致）。
   *
   * @returns 空的准备结果。
   */
  prepareContinuable() {
    return Promise.resolve({})
  }
}

/**
 * 本包需要注册的 provider 名 —— 必须与 `presets/multitask/composition.mjs` 的
 * `PTC_PROVIDER` / `MINIMAL_PROVIDER` 逐字一致（测试里比对）。
 *
 * 主路径的 `spawn` / `fork` **不在此列**：它们是宿主内置的，由 `@deepseek-ai/dsh-base`
 * 装好。本包绝不重复注册它们 —— 重名会撞 `DUPLICATE_PROVIDER`。
 */
export const WORKER_PROVIDER_NAMES = ['multitask_ptc', 'multitask_minimal']

/**
 * 幂等地把两类自建 provider 注册到宿主的 `subagents` 服务上。
 *
 * ── 为什么必须先查 `getProvider()` ──────────────────────────────────────────
 *
 * 三条路径会让「同一个名字注册两次」：HMR 热替换（同一模块的两个实例）、插件被
 * profile patch 重复插入、以及**上游注册器的 effect 由服务自己拥有**（见文件头）——
 * 后一种情况下旧注册在插件卸载后仍然活着。注册表对重名是硬拒绝，抛错会让本插件
 * 整个起不来。查一次再注册，三种情况一起挡住。
 *
 * ── 失败为什么只告警 ────────────────────────────────────────────────────────
 *
 * 两个 provider 只服务 `subagent_ptc` / `subagent_minimal` 两条**可选**委派路径。
 * 注册不上时那两条工具根本不出现（`tool-subagent` 会等 `subagent/provider-added`），
 * 模式退化成「只剩 subagent / subagent_fork」—— 仍然完全可用。相比之下，抛错会让
 * 整个插件加载失败、连主路径都没了。所以这里只告警，且带固定标识方便 grep。
 *
 * @param ctx - 宿主插件上下文（profile 级的那一行）。
 * @param warn - 记录器（调用方提供，便于统一前缀）。
 */
export function registerWorkerProviders(ctx, warn) {
  // 服务可能比本插件晚出现（瘦身部署甚至没有它），所以用 inject 兜住。
  const install = (subagents) => {
    for (const providerName of WORKER_PROVIDER_NAMES) {
      try {
        if (typeof subagents?.registerProvider !== 'function') {
          warn(
            `the subagents service exposes no registerProvider(); the "${providerName}" worker backend was NOT ` +
              `registered, so that delegation tool will be missing [MULTITASK-PROVIDER-SKIPPED reason=no-register-api]`,
          )
          continue
        }
        // 已经注册过（热替换 / 重复插入 / 上游 effect 存活）就不再注册。
        const existing = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
        if (existing !== undefined) continue
        subagents.registerProvider(new InProcessSpawnProvider(providerName))
      } catch (error) {
        warn(
          `registering the "${providerName}" worker backend failed: ` +
            `${error instanceof Error ? error.message : String(error)} — that delegation tool will be missing, ` +
            `the rest of the mode keeps working [MULTITASK-PROVIDER-SKIPPED reason=register-threw]`,
        )
      }
    }
  }

  try {
    const direct = (() => {
      try {
        return ctx.get('subagents')
      } catch {
        return undefined
      }
    })()
    if (direct !== undefined && direct !== null) {
      install(direct)
      return
    }
    // 兜底：等服务出现。回调由 Cordis 在服务可用时调用一次，且随本插件卸载失效。
    ctx.inject(['subagents'], (child) => {
      install(child.subagents)
    })
  } catch (error) {
    warn(
      `installing the worker backends failed: ${error instanceof Error ? error.message : String(error)} — ` +
        `subagent_ptc / subagent_minimal will be missing [MULTITASK-PROVIDER-SKIPPED reason=install-threw]`,
    )
  }
}
