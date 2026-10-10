/**
 * multitask-workspace-acl — 让子代理的 shell 在**新工作区**里开箱即用。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * Windows 上，DSH 的 ACL 沙箱在给一个工作区授权时，会**一次**调用
 * `SetNamedSecurityInfoW` 同时写三样东西（`info = 20` 把 DACL 与 SACL 合成一次写入）：
 * 能力 SID 的允许 ACE、Everyone 的 delete-child 拒绝、以及 **Low 完整性标签**。
 *
 * 其中**标签住在 SACL 里**。写入 SACL 需要 `WRITE_OWNER`（`SE_SECURITY_NAME` 特权
 * 在本场景并不必要），而所有者的隐式权限**只覆盖 `READ_CONTROL` 与 `WRITE_DAC`** ——
 * 也就是说：**一个只给自己授了 Modify 的目录，缺的正是写标签那一半所需的权限**，
 * 于是整次调用失败，子代理的每一条命令都报：
 *
 *     Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区路径>)
 *
 * `H:\` 根目录只给 `Authenticated Users:(M)`（Modify），所以**在 H 盘下新建的目录
 * 天生带这个缺陷**；而用户目录（`C:\Users\<你>`）给的是可继承的 `(F)`，其下新建目录
 * 天然满足。这解释了一个实测现象：同一个插件，在用户目录下的工作区一切正常，
 * 在 `H:\test2` 这类路径下则任何命令都跑不起来。
 *
 * ── 为什么只补 `WRITE_OWNER`，而且**只补这一项**──────────────────────────────
 *
 * 本机实验已定论（`icacls` 复现，两条都测过）：
 *
 *   · Modify-only 目录执行「写完整性标签」⇒ `exit 5`（= DSH 报的 Win32 5）；
 *   · 只加一条**非继承**的 `WRITE_OWNER` 之后，同一个动作 ⇒ `exit 0`。
 *
 * 所以最小所需就是它一项。**绝不授 `FullControl`**：那个还包含「改权限 + 夺所有权」，
 * 远超所需。（顺带一提：宿主自带的 `diagnose-windows-sandbox-acl` 技能授的正是
 * `FullControl`；本模块刻意比它克制。）
 *
 * 另外，`WRITE_OWNER` 是**所有者给自己的**：目录所有者本来就能随时夺回所有权，
 * 所以这条 ACE 不扩大任何人的实际权力，只是把「所有者本可做的事」变成「沙箱可以做的事」。
 *
 * ── 为什么必须在**会话开始**时做 ──────────────────────────────────────────────
 *
 * 那三样授权在沙箱**构造 / 首次解析策略**时就发生（宿主侧 `AclSandbox.init()` 对每个
 * 可写根逐个 `grantWrite`），早于任何一条命令。所以修复必须在此之前落地，
 * 否则「新工作区的第一条命令」仍会失败一次。
 *
 * 本模块挂在 `agent/created` 上（与同仓其他守卫同一时机），此时会话刚发布、
 * 第一条用户消息尚未进入 —— 足够早。
 *
 * ── 幂等性，以及为什么它不重复打扰 ────────────────────────────────────────────
 *
 * 宿主侧本身是幂等的：三样都在时会在 `909765` 的早退处短路、**根本不发那次调用**。
 * 本模块自己也幂等（实测：重复授权后 `(WO)` 仍只有一条，因为
 * `AddAccessRule` 对完全相同的规则会去重），并且按**工作区路径每进程只尝试一次**。
 *
 * ── 为什么走子进程（本插件唯一使用 node 内置模块的地方）───────────────────────
 *
 * Node 没有读写 ACL 的 API，这件事只能用 `icacls` 或 PowerShell 的
 * `System.Security.AccessControl` 做。本模块选后者（能精确只写 `TakeOwnership` 一项），
 * 通过一次性 `powershell.exe -NoProfile -NonInteractive -EncodedCommand` 执行：
 * 脚本整体 base64（UTF-16LE），**工作区路径经环境变量传入而不拼进脚本** ——
 * 于是路径里出现引号、空格、非 ASCII 都不会构成注入面。
 *
 * 「零 import」是本仓预设模块的约定，所以这里用**动态** `import('node:child_process')`：
 * 模块的静态导入面保持为空，仓库既有的「模块零依赖可加载」断言继续成立。
 *
 * ── 失败取向：绝不阻塞会话 ───────────────────────────────────────────────────
 *
 * 授权失败最坏是「回到今天的行为」（子代理的 shell 起不来），而那**不是**本模块引入的
 * 问题。所以任何失败都只记日志、绝不影响会话创建。可关：`config.autoGrantWriteOwner: false`。
 *
 * 标识（可 grep）：
 *
 *     MULTITASK-WORKSPACE-ACL-OK           已有 WRITE_OWNER，无需动作
 *     MULTITASK-WORKSPACE-ACL-GRANTED      补上了最小授权
 *     MULTITASK-WORKSPACE-ACL-SKIPPED      跳过（reason=… 说明为什么）
 *     MULTITASK-WORKSPACE-ACL-FAILED       尝试失败（reason=…），已如实记录
 *
 * ── 它绝不做的事 ─────────────────────────────────────────────────────────────
 *
 *   · 绝不授 `FullControl` / `Modify`（只授 `TakeOwnership`）；
 *   · 不改目录**所有者**、不动 SACL、不删任何既有 ACE；
 *   · 只在 Windows 上动作；非 `workspace-write` 的会话不动；
 *   · 不碰非本 preset 的会话（与同仓守卫同一条纪律）。
 *
 * @module dsh-multitask/presets/multitask/workspace-acl
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'multitask-workspace-acl'

/**
 * 本模块**不**声明 `inject`：它需要的一切都是探测得到的
 * （`sandboxPolicy` 缺席就跳过），声明成硬依赖反而会把一个可选能力变成安装门槛。
 */
export const inject = []

/** 与 `subagent-mode` / `coordinator-guard` 保持同一判据：是不是被委派的子代理。 */
const SUBAGENT_ORIGIN = 'subagent'

/** 本模块只在 Windows 上做任何事（ACL 沙箱是 Windows 专属）。 */
const IS_WINDOWS = process.platform === 'win32'

/** 子进程超时（毫秒）。正常一次授权约数百毫秒；超时只是防御性地兜住异常。 */
const TIMEOUT_MS = 15000

/**
 * 授权脚本（PowerShell）。**路径经环境变量 `DSH_MT_ACL_DIR` 传入**，不拼进脚本文本
 * —— 所以任何路径内容都不构成注入面。
 *
 * 输出约定（stdout 单行，供调用方解析）：
 *   - `HAS-WRITE-OWNER`    当前用户已有 `WRITE_OWNER`，未做任何修改；
 *   - `GRANTED-WRITE-OWNER` 补上了最小授权，且已复读确认；
 *   - `GRANT-VERIFY-FAILED` 写入后复读没看到，如实报失败；
 *   - `FAILED: <msg>`      抛错（含访问被拒）。
 *
 * ⚠️ 脚本里只用 `[System.Security.AccessControl.FileSystemRights]::TakeOwnership`。
 * 任何把它改成 `::FullControl` 或 `::Modify` 的改动都会被 `test/workspace-acl-rules.mjs`
 * 与 `test/repo-consistency.mjs` 拦住 —— 那是本模块最要紧的一条红线。
 *
 * @returns PowerShell 脚本文本。
 */
export function buildGrantScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $dir = $env:DSH_MT_ACL_DIR',
    '  if ([string]::IsNullOrWhiteSpace($dir)) { Write-Output "FAILED: empty path"; exit 1 }',
    '  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '  function Test-WriteOwner([string]$p, $sid) {',
    '    $acl = Get-Acl -LiteralPath $p',
    '    foreach ($ace in $acl.Access) {',
    '      if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }',
    '      $s = $null',
    '      try { $s = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) } catch { continue }',
    '      if ($null -eq $s -or $s.Value -ne $sid.Value) { continue }',
    '      $has = ($ace.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::TakeOwnership) -eq [System.Security.AccessControl.FileSystemRights]::TakeOwnership',
    '      if ($has) { return $true }',
    '    }',
    '    return $false',
    '  }',
    '  if (Test-WriteOwner $dir $me) { Write-Output "HAS-WRITE-OWNER"; exit 0 }',
    '  $acl = Get-Acl -LiteralPath $dir',
    '  $owner = $null',
    '  try { $owner = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $owner = $null }',
    '  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(',
    '    $me,',
    '    [System.Security.AccessControl.FileSystemRights]::TakeOwnership,',
    '    [System.Security.AccessControl.AccessControlType]::Allow',
    '  )',
    '  $acl.AddAccessRule($rule)',
    '  Set-Acl -LiteralPath $dir -AclObject $acl',
    '  if (Test-WriteOwner $dir $me) {',
    '    if ($null -ne $owner -and $owner -ne $me.Value) { Write-Output "GRANTED-WRITE-OWNER owner=$owner" } else { Write-Output "GRANTED-WRITE-OWNER" }',
    '    exit 0',
    '  }',
    '  Write-Output "GRANT-VERIFY-FAILED"',
    '  exit 1',
    '} catch {',
    '  Write-Output ("FAILED: " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n')
}

/**
 * 解析授权脚本的 stdout，得到闭合的判定。
 *
 * 刻意**不抛错**：任何不认识的输出都归到 `unknown`，由调用方记日志 ——
 * 这个模块的契约是「任何意外都不得影响会话」。
 *
 * @param stdout - 子进程的标准输出。
 * @param exitCode - 子进程退出码。
 * @returns `'ok'`（已有授权）/ `'granted'`（本次补上）/ `'failed'` / `'unknown'`。
 */
export function parseGrantOutcome(stdout, exitCode) {
  const text = typeof stdout === 'string' ? stdout : ''
  if (text.includes('HAS-WRITE-OWNER')) return 'ok'
  if (text.includes('GRANTED-WRITE-OWNER')) return 'granted'
  if (text.includes('FAILED') || text.includes('GRANT-VERIFY-FAILED')) return 'failed'
  return exitCode === 0 ? 'ok' : 'unknown'
}

/**
 * 判断一个 agent 是不是被委派的子代理（与同仓守卫同一三信号判据）。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为子代理。
 */
export function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === SUBAGENT_ORIGIN) return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/** 每次都只警告一次的记录器（与同仓守卫同款，避免刷屏）。 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-multitask/workspace-acl: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 读一个会话当前生效的沙箱模式。
 *
 * 读不到时返回 undefined —— 调用点把「读不到」当作**不动作**（保守方向：
 * 不在看不清楚的情况下改任何目录的权限）。
 *
 * @param ctx - 插件上下文。
 * @param session - 目标会话。
 * @returns `'workspace-write'` / `'read-only'` / `'danger-full-access'`，或 undefined。
 */
function sandboxModeOf(ctx, session) {
  try {
    const policy = ctx?.get?.('sandboxPolicy')
    if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return undefined
    const resolved = policy.resolve({ session })
    const mode = resolved?.mode
    return typeof mode === 'string' ? mode : undefined
  } catch {
    return undefined
  }
}

/**
 * 跑一次性 PowerShell，返回 `{ stdout, exitCode, timedOut }`。**本模块唯一的副作用出口。**
 *
 * 动态 import 是刻意的：保持本模块的静态导入面为空（仓库既有的
 * 「预设模块零依赖可加载」断言继续成立）。
 *
 * @param script - 要执行的 PowerShell 脚本文本（经 `-EncodedCommand` 传入）。
 * @param env - 额外环境变量（工作区路径走这里，不拼进脚本）。
 * @returns 子进程结果；任何意外都归到 `exitCode: null`。
 */
async function runPowerShell(script, env) {
  const { spawn } = await import('node:child_process')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // 用绝对路径，避免 PATH 上出现同名程序；SystemRoot 缺失时退回裸名。
  const systemRoot = process.env.SystemRoot
  const exe = typeof systemRoot === 'string' && systemRoot !== ''
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'

  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ stdout: '', exitCode: null, timedOut: false, error })
      return
    }

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 杀不掉也不能卡住调用方：下面照样 resolve 一个超时结果。
      }
      finish({ stdout, exitCode: null, timedOut: true })
    }, TIMEOUT_MS)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => finish({ stdout, exitCode: null, timedOut: false, error }))
    child.on('close', (code) => finish({ stdout, exitCode: code, timedOut: false, stderr }))
    // 子进程不应拖住宿主进程退出。
    child.unref?.()
  })
}

/**
 * 装载本模块：在会话开始时，确保工作区目录具备 DSH ACL 沙箱所需的 `WRITE_OWNER`。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - 该行在 composition 里的 `config`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return
  if (config?.autoGrantWriteOwner === false) {
    try {
      ctx.logger?.info?.('dsh-multitask: MULTITASK-WORKSPACE-ACL-SKIPPED reason=disabled-by-config')
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
    return
  }
  // 非 Windows：ACL 沙箱不存在，本模块整段不动作（也不注册任何监听器）。
  if (!IS_WINDOWS) return

  const warn = warnOnceFactory(ctx)

  /** 已处理过的工作区路径（小写规范化）—— 每进程每个工作区只尝试一次。 */
  const handled = new Set()

  /**
   * 尽力确保某个工作区目录具备 `WRITE_OWNER`。**任何失败都只记日志。**
   *
   * @param dir - 工作区目录（会话 cwd）。
   */
  const ensureWriteOwner = async (dir) => {
    const result = await runPowerShell(buildGrantScript(), { DSH_MT_ACL_DIR: dir })
    const outcome = result.timedOut
      ? 'unknown'
      : parseGrantOutcome(result.stdout, result.exitCode)

    try {
      switch (outcome) {
        case 'ok':
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-OK ${JSON.stringify(dir)} already grants WRITE_OWNER; nothing was changed`,
          )
          return
        case 'granted':
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-GRANTED ${JSON.stringify(dir)} — added WRITE_OWNER only (no FullControl), so the ACL sandbox can provision this workspace`,
          )
          return
        default: {
          const detail = result.timedOut
            ? `timed out after ${TIMEOUT_MS}ms`
            : (result.error !== undefined
                ? String(result.error?.message ?? result.error)
                : (String(result.stdout ?? '').trim().replace(/^FAILED:\s*/, '') || `exit ${String(result.exitCode)}`))
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-FAILED reason=${JSON.stringify(detail)} dir=${JSON.stringify(dir)}`,
          )
          return
        }
      }
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }

  // ── 唯一路径：会话创建时检查并（必要时）补最小授权 ──────────────────────────
  //
  // 为什么是 `agent/created`：它与同仓其他守卫同一时机（会话刚发布、第一条用户消息
  // 尚未进入），而沙箱的授权发生在首次执行命令时 —— 所以这里来得及。
  //
  // 只处理**根会话**（非委派）：工作区是会话的属性，子代理与父会话共享同一个 cwd，
  // 对每个 worker 重复检查纯属浪费。
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (isDelegatedChild(agent)) return

      const session = agent?.session
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        try {
          ctx.logger?.info?.('dsh-multitask: MULTITASK-WORKSPACE-ACL-SKIPPED reason=no-session-cwd')
        } catch {
          // 同上。
        }
        return
      }

      const mode = sandboxModeOf(ctx, session)
      if (mode !== 'workspace-write') {
        try {
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SKIPPED reason=sandbox-mode-${String(mode ?? 'unreadable')} dir=${JSON.stringify(cwd)}`,
          )
        } catch {
          // 同上。
        }
        return
      }

      const key = cwd.replace(/[\\/]+$/, '').toLowerCase()
      if (handled.has(key)) return
      handled.add(key)

      // 不 await：本模块不得以任何方式拖住（或影响）会话发布。
      // 授权通常只需数百毫秒，而第一条命令要等用户发消息之后才可能出现 —— 来得及。
      ensureWriteOwner(cwd).catch((error) => {
        warn(`checking ${JSON.stringify(cwd)} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话创建。
      warn(`handling agent/created failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
