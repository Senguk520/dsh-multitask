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
 * ── 为什么**不能**只处理根会话（2026-10-31 的真实漏网）───────────────────────
 *
 * 早先这里对委派子代理直接 `return`，理由是「工作区是会话的属性，子代理与父会话共享
 * 同一个 cwd，对每个 worker 重复检查纯属浪费」。这个理由在**父会话确实补过**时成立，
 * 但它依赖一个不成立的假设：父会话创建时本模块就在。
 *
 * 实测漏网（会话 `98884e02` / 父会话 `session-c6c3729b`，工作区 `E:\buddy-register`）：
 *
 *   1. 父会话创建时 header 是 `standard` —— 本模块**根本不在**，没人补；
 *   2. 2.3 秒后用户把它切成 `multitask`，但 `agent/created` **不会重放**，仍然没人补；
 *   3. 子代理以 `multitask_ptc` 创建时本模块已就位，却因为「是委派子代理」被跳过；
 *   4. 结果：`E:\buddy-register` 始终缺 `WRITE_OWNER`，ACL 沙箱 `grantWrite` 报
 *      `Win32 5`，PTC worker 的 `run_code` 与内层 `pwsh` 全部起不来。
 *
 * 所以判据从「是不是根会话」改成「**这个 cwd 处理过没有**」：`handled` 已按规范化
 * 路径去重，父会话补过时子代理这一跳只是查一次 Set，不会产生第二次子进程。反过来说，
 * 若父会话没补（首轮前切换 / 跨模式派发），子代理就是**唯一**能补的时机。
 *
 * ── 为什么还要给**既存对象**补一次继承 + 标签（2026-11-01 的真实缺口）──────────
 *
 * 宿主那三样授权**只在对象创建时**继承，从不向既有子目录回溯。实测本机
 * `E:\dsh-multitask`：根三项齐全，而 `.git`、`docs`、`lib`、`presets`、`test`、
 * `.github`、`.cursor`（2026-10-27 创建）**一条都没有**；只有 `research`
 * （2026-11-01 创建）齐全。后果不是「权限紧」而是「沙箱命令直接失败」：
 *
 *     fatal: Unable to create '.../.git/index.lock': Permission denied
 *
 * 沙箱 shell 是 **Low IL + 受限令牌**（restricting 列表只有 logon SID / Everyone /
 * 能力 SID / temp SID，**不含 Authenticated Users**），对未盖章的既存目录建文件时，
 * DACL 里没有它认得的 ACE。所以从本插件发布起就在用的老工作区，**根修好了、子目录
 * 却继续坏**，而用户不该为此换目录 —— 这就是在「补根的 `WRITE_OWNER`」之后**串行**
 * 再做一次整树补齐的理由。
 *
 * ── 为什么是「镜像父目录既有条目」，而不是插件自己发明策略────────────────────
 *
 * 子目录缺的不是一条新规则，而是一次「重新继承」：能力 ACE、Everyone 的
 * delete-child 拒绝、Low 标签 —— 这三样**根的 DACL / SACL 里已经写着**（宿主写的）。
 * 所以脚本只做三件加法，一次也不生成策略：
 *
 *   1. `icacls <dir> /grant *<当前用户 SID>:(WO) /T` —— 整树一趟；
 *   2. `icacls <dir> /inheritance:e /T` —— 把父目录的既有可继承条目拉回来；
 *   3. `icacls <dir> /setintegritylevel (OI)(CI)Low /T` —— 与宿主一致的 Low 标签。
 *
 * 能力 SID **不硬编码**：插件不知道、也不该知道宿主这一会话算出的能力 SID；让对象
 * 去继承根上那一份，宿主改主意时子目录跟着变。反过来，若插件自己发明一条 ACE，
 * 它就会在宿主换策略后变成一个**没人负责的残留**。
 *
 * ⚠️ 顺序不可反：写标签需要对象上的 `WRITE_OWNER`（本文件 26-27 行那两条实验），
 * 所以必须先补 `WO`（`ensureWriteOwner` 补根、本步补树），再谈继承与标签。
 *
 * ── 这一步的代价 ─────────────────────────────────────────────────────────────
 *
 * `/T` 是**整树**操作：带 `node_modules` 的大工作区是一次几百毫秒到十几秒的遍历，
 * 远比根目录那一次重。所以：
 *
 *   · 先做**快筛**：根下**一层**（直接子目录 **+ 直接文件**，不递归）都已带
 *     `Mandatory Label` → `SUB-OK` 早退，**一次写入都不做**（修好之后每次会话只付
 *     这几次只读 `icacls`）；
 *   · 超时单独放到 `REPAIR_TIMEOUT_MS`（120s），仍走 `runPowerShell` 唯一出口；
 *   · 可关：`config.autoRepairStampedChildren: false`，与 `autoGrantWriteOwner` 独立。
 *
 * ⚠️ 已知顺序前提（未实测，按宿主时序推断）：脚本镜像的是**执行那一刻**根上已有的
 * 条目。对「根还没被宿主盖过章」的全新工作区，第一次会话可能只来到标签、不来能力
 * ACE；下一次会话快筛只看一层对象的标签，就会判 `SUB-OK`。本模块按「老工作区根早已
 * 盖章」这个目标场景实现，没有为这一情形加额外探针 —— 探针要判断「继承到的 ACE 是否
 * 等于宿主这一会话的策略」，那等于把宿主策略复制进插件，方向是反的。
 *
 * ── 为什么还要监听 `agent-preset/selected` ───────────────────────────────────
 *
 * 「首轮前切进本模式」这条路径上，`agent/created` 早已过去（当时本模块还没挂载），
 * 只有那个**无载体广播**能把「该补了」这个信号送到 —— 与 `coordinator-guard` 处理
 * 「切进来」是同一个理由。
 *
 * 切换是双向的，而本模块只该管「切进本模式」这一个方向：`agent-preset/selected`
 * 的第二个参数就是新的 preset id，直接用它与本模块所属 id 比较；参数缺席时才退回
 * 读注册表的活绑定。**绝不能**对切走的会话动手 —— 那会给一个别的模式的 cwd 补授权，
 * 让宿主的三合一写入有机会盖章，正是 `sensitiveReasonFor()` 要防的那类后果。
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
 * 授权 / 补齐失败最坏是「回到今天的行为」（子代理的 shell 起不来），而那**不是**本模块
 * 引入的问题。所以任何失败都只记日志、绝不影响会话创建。可关：
 * `config.autoGrantWriteOwner: false`（整个模块不注册）与
 * `config.autoRepairStampedChildren: false`（只关整树补齐）。
 *
 * 标识（可 grep）：
 *
 *     MULTITASK-WORKSPACE-ACL-OK           已有 WRITE_OWNER，无需动作
 *     MULTITASK-WORKSPACE-ACL-GRANTED      补上了最小授权
 *     MULTITASK-WORKSPACE-ACL-SKIPPED      跳过（reason=… 说明为什么）
 *     MULTITASK-WORKSPACE-ACL-FAILED       尝试失败（reason=…），已如实记录
 *     MULTITASK-WORKSPACE-ACL-SUB-OK       直接子目录都已带标签，未做任何修改
 *     MULTITASK-WORKSPACE-ACL-SUB-REPAIRED 既存对象的继承与 Low 标签已补齐
 *     MULTITASK-WORKSPACE-ACL-SUB-SKIPPED  补齐跳过（reason=… 说明为什么）
 *     MULTITASK-WORKSPACE-ACL-SUB-FAILED   补齐失败（reason=…），已如实记录
 *
 * ── 它绝不做的事 ─────────────────────────────────────────────────────────────
 *
 *   · 绝不授 `FullControl` / `Modify`：授权侧只写一条 `TakeOwnership`，补齐侧只写
 *     `WRITE_OWNER` 与宿主已经在根上的 Low 标签；
 *   · 不改目录**所有者**、不删任何既有 ACE；不 `/grant:r`、不 `/deny`、不 `/reset`、
 *     不 `takeown`。`buildGrantScript()` 不碰 SACL；`buildRepairScript()` 只镜像宿主
 *     已写的 Low 标签，不发明、也不替换宿主的策略；
 *   · 只在 Windows 上动作；非 `workspace-write` 的会话不动；
 *   · 不碰非本 preset 的会话（与同仓守卫同一条纪律）：`agent/created` 靠 scope 过滤，
 *     切换广播靠 `presetId` 显式比对（只认「切进来」这一个方向）
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
 * 「既存对象盖章补齐」的超时（毫秒）。它是一次**整树** `/T` 操作：小仓库秒级，
 * 带 `node_modules` 的大工作区可能十几秒 —— 沿用根目录那 15s，会在遍历到一半时
 * 被杀掉、等于白做一次；120s 只是防御性地兜住病态情形，不是预期耗时。
 */
const REPAIR_TIMEOUT_MS = 120_000

/**
 * 本模块所属 preset id —— 「切进来的到底是不是本模式」这条判据的默认值。
 *
 * 正常运行由 composition 那行显式传入（`config.presetId`），宿主半在 profile 覆盖
 * `config.presetId` 时也会一起对齐（`lib/index.js` 的 `applyGuardOverrides`）。
 * 这里的字面量只服务「直接调用本模块、没给配置」的情形。
 */
const DEFAULT_PRESET_ID = 'multitask'

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
 * `buildRepairScript()` 的脚本（PowerShell）。**路径同样只从 `$env:DSH_MT_ACL_DIR` 读**，
 * 不拼进脚本文本。
 *
 * 它**不发明策略**：只把工作区根上宿主已经写好的可继承条目，重新拉回既存对象，并写上
 * 与宿主一致的 Low 标签 —— 能力 SID 不硬编码、也不由插件生成。顺序（写入共三次：
 * 一次整树 `/T` 加 `WRITE_OWNER`、一次 `/T` 拉回继承、一次 `/T` 写标签）：
 *
 *   1. `icacls <dir> /grant *<当前用户 SID>:(WO) /T` —— 整树一趟的**加法**授权
 *      （写标签需要对象上的 `WRITE_OWNER`；绝不用 `/grant:r`，那会替换该 SID 既有 ACE）；
 *   2. `icacls <dir> /inheritance:e /T` —— 让既有对象重新继承父目录的可继承条目
 *      （能力 ACE 与 Everyone 的 delete-child 拒绝由此获得）。该开关在 icacls 帮助里
 *      写作 `/inheritancelevel:[e|d|r]`，而不少环境也接受 `/inheritance:e`。为了不在
 *      老环境上让这一步直接失败（失败本身是 fail-open，但**等于修不了**），脚本**先试**
 *      `/inheritance:e`，退出码非零时**再试** `/inheritancelevel:e`（两次都带
 *      `/T /C /Q`，仍在这**一个**子进程内），两次都失败才输出
 *      `FAILED: re-enabling DACL inheritance failed (…)`。
 *      ⚠️ 这两种拼写哪个、以及在目标环境是否可用，**均未实测** —— 它是兜底，
 *      不保证两者都成立；真正可用与否要看那次运行的退出码。
 *   3. `icacls <dir> /setintegritylevel (OI)(CI)Low /T` —— 与宿主一致的 Low 标签
 *      （目录带 `(OI)(CI)`；文件只落一条 Low）。
 *
 * 写之前先**快筛**：若 cwd **一层**（= **直接子目录 + 直接文件**，即
 * `Get-ChildItem -LiteralPath $dir -Force` 的那一层、**不递归**）都已带 `Mandatory Label`，
 * 直接 `SUB-OK` 退出，一次写入都不做。
 *
 * ⚠️ 为什么是「一层」而不是递归：快筛只回答一个问题 —— **要不要动手**；真正把继承与
 * 标签铺到整棵树的是后面那三趟 `/T`，所以快筛不必先走一遍整树（那等于把刚省下的代价
 * 又付一次）。但「一层」**必须同时包含直接文件**，不能只看子目录：根下直接落着的文件
 * 同样可能是在盖章之前创建的孤儿，而它下面没有子目录来「代表」它的状态 —— 只看子目录
 * 会出现这条死路：「子目录都有标签 ⇒ `SUB-OK` 早退 ⇒ 根下那个孤儿文件永远没人修」，
 * 沙箱 shell 一改它就以权限错误失败。
 *
 * 快筛是**只读**的：icacls 不接受一次传多个名字（本机实测：追加第二个名字 ⇒
 * `Invalid parameter`，exit 87），所以按对象逐个查（一层通常只有几十个以内）；所有
 * **写入**则都是 `/T` 一趟。识别用 icacls 的 `Mandatory Label` 行（本机为英文；
 * `icacls <文件>` 也会输出该行，所以同一个 `Test-MandatoryLabel` 对文件同样成立），
 * 并额外容忍标签行里的 `(NW)` 标记，作为输出本地化时的兜底 —— 未实测。
 * 输出单行，供 `parseRepairOutcome()` 解析：
 *
 *   - `SUB-OK`                  无需动作；
 *   - `SUB-REPAIRED count=<n>`  已补齐（n = 本次补齐的**一层对象数**：直接子目录 + 直接文件）；
 *   - `SUB-SKIPPED reason=<r>`  不适用（路径不存在 / 不是目录 / 空路径）；
 *   - `FAILED: <msg>`           硬失败（含任一 icacls 非零退出、复读没看到标签）。
 *
 * ⚠️ 新脚本里只有 `/T` 与 `/inheritance:e` 这两个 icacls 动作，**绝不**出现
 * `FullControl`、`/grant:r`、`/deny`、`/reset`、`SetOwner` 或 `takeown`。
 * ⚠️ `/setintegritylevel`、`/inheritance:e` 与 `/inheritancelevel:e` 的实机行为
 * **都未在本机执行过**（本仓约束：只读不写 ACL）：参数形态取自本机 `icacls /?` 与
 * 只读 `icacls` 输出，其中 `/T` 与继承开关的组合按帮助里「`/T` 对操作递归」的通用
 * 语义保守选用。两种继承拼写的兜底**同样未实测**，不保证任一在目标环境可用。
 *
 * @returns PowerShell 脚本文本。
 */
export function buildRepairScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $dir = $env:DSH_MT_ACL_DIR',
    '  if ([string]::IsNullOrWhiteSpace($dir)) { Write-Output "FAILED: empty path"; exit 1 }',
    '  if (-not (Test-Path -LiteralPath $dir)) { Write-Output "SUB-SKIPPED reason=path-missing"; exit 0 }',
    '  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Write-Output "SUB-SKIPPED reason=not-a-directory"; exit 0 }',
    '  $icacls = "icacls.exe"',
    '  if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {',
    '    $candidate = Join-Path $env:SystemRoot "System32\\icacls.exe"',
    '    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $icacls = $candidate }',
    '  }',
    '  function Test-MandatoryLabel([string]$p) {',
    '    $text = & $icacls $p 2>$null',
    '    if ($LASTEXITCODE -ne 0) { return $false }',
    '    foreach ($line in @($text)) { if ($line -like "*Mandatory Label*" -or $line -like "*(NW)*") { return $true } }',
    '    return $false',
    '  }',
    '  $children = @(Get-ChildItem -LiteralPath $dir -Force | ForEach-Object { $_.FullName })',
    '  if ($children.Count -eq 0) { Write-Output "SUB-OK"; exit 0 }',
    '  $missing = @()',
    '  foreach ($child in $children) { if (-not (Test-MandatoryLabel $child)) { $missing += $child } }',
    '  if ($missing.Count -eq 0) { Write-Output "SUB-OK"; exit 0 }',
    '  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '  & $icacls $dir /grant ("*" + $me + ":(WO)") /T /C /Q | Out-Null',
    '  $grantExit = $LASTEXITCODE',
    '  if ($grantExit -ne 0) { Write-Output ("FAILED: adding WRITE_OWNER to the tree failed (icacls exit " + $grantExit + ")"); exit 1 }',
    '  & $icacls $dir /inheritance:e /T /C /Q | Out-Null',
    '  $inheritExit = $LASTEXITCODE',
    '  if ($inheritExit -ne 0) {',
    '    & $icacls $dir /inheritancelevel:e /T /C /Q | Out-Null',
    '    $inheritExit = $LASTEXITCODE',
    '  }',
    '  if ($inheritExit -ne 0) { Write-Output ("FAILED: re-enabling DACL inheritance failed (icacls exit " + $inheritExit + ")"); exit 1 }',
    '  & $icacls $dir /setintegritylevel "(OI)(CI)Low" /T /C /Q | Out-Null',
    '  $labelExit = $LASTEXITCODE',
    '  if ($labelExit -ne 0) { Write-Output ("FAILED: writing the Low integrity label failed (icacls exit " + $labelExit + ")"); exit 1 }',
    '  $verify = @($missing)',
    '  $git = Join-Path $dir ".git"',
    '  if ((Test-Path -LiteralPath $git -PathType Container) -and -not ($verify -contains $git)) { $verify += $git }',
    '  $still = @($verify | Where-Object { -not (Test-MandatoryLabel $_) })',
    '  if ($still.Count -gt 0) { Write-Output ("FAILED: integrity label still missing on " + $still.Count + " object(s) after repair"); exit 1 }',
    '  Write-Output ("SUB-REPAIRED count=" + $missing.Count)',
    '  exit 0',
    '} catch {',
    '  Write-Output ("FAILED: " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n')
}

/**
 * 解析补齐脚本的 stdout，得到闭合的判定。
 *
 * 刻意**不抛错**：任何不认识的输出都归到 `skipped`（exit 0）或 `failed`（非零），
 * 由调用方记日志 —— 这个模块的契约是「任何意外都不得影响会话」。
 *
 * @param stdout - 子进程的标准输出。
 * @param exitCode - 子进程退出码。
 * @returns `'ok'` / `'repaired'` / `'skipped'` / `'failed'`。
 */
export function parseRepairOutcome(stdout, exitCode) {
  const text = typeof stdout === 'string' ? stdout : ''
  if (text.includes('SUB-REPAIRED')) return 'repaired'
  if (text.includes('SUB-OK')) return 'ok'
  if (text.includes('SUB-SKIPPED')) return 'skipped'
  if (text.includes('FAILED')) return 'failed'
  return exitCode === 0 ? 'skipped' : 'failed'
}

/**
 * 判断一个 agent 是不是被委派的子代理（与同仓守卫同一三信号判据）。
 *
 * ⚠️ 本模块**不再**用它做早退判据 —— 那条判据正是 2026-10-31 漏网的成因：
 * 「父会话创建时还不是本模式」时父会话没补，而子代理又被这里跳过，于是谁都不补。
 * 保留导出只因为它是与其它守卫共享的诊断口径（测试与排查会读它）。
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
 * 按会话 id 找回一个**活着的** agent。
 *
 * 只在 `agent-preset/selected` 这条广播路径上用得到：广播只给会话 id，不给 agent。
 * `agents` 是宿主面服务（dsh-agent 注册为 `agents`），沿 ctx 链向上取得到；
 * `get(id)` 是只读查询，返回 undefined 表示该会话已不在。
 *
 * @param ctx - 插件上下文。
 * @param id - 会话 / agent id。
 * @returns 该 agent，或 undefined。
 */
function agentById(ctx, id) {
  try {
    const agents = ctx?.get?.('agents')
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
    return agents.get(id)
  } catch {
    return undefined
  }
}

/**
 * 读一个 agent **当前绑定**的 preset id。
 *
 * 这是 `agent-preset/selected` 第二个参数缺席时的兜底 —— 那个参数是权威的新取值，
 * 而这里读的是注册表的活绑定（会随切换改变）。刻意不读 session header 的
 * `agentPreset`：它记的是「创建时用的是哪一份」，正是本次缺陷里会把人带偏的东西。
 *
 * 读不出来时返回 undefined；调用点把它当作「不确认是本模式」→ **不动作**
 * （保守方向：补错目录的代价比漏补一次大得多）。
 *
 * @param ctx - 插件上下文。
 * @param agent - 目标 agent。
 * @returns preset id，或 undefined。
 */
function composedPresetId(ctx, agent) {
  const agentCtx = agent?.ctx
  if (agentCtx === undefined || agentCtx === null) return undefined
  for (const carrier of [agentCtx, ctx]) {
    try {
      const registry = carrier?.get?.('agentPresets')
      if (registry === undefined || registry === null || typeof registry.composedPreset !== 'function') continue
      const id = registry.composedPreset(agentCtx)
      if (typeof id === 'string' && id !== '') return id
    } catch {
      // 换下一个来源；都读不到就当作「不确认」。
    }
  }
  return undefined
}

/**
 * 判断一个目录是否属于「**本模块绝不触碰**」的那一类，并给出原因。
 *
 * ── 为什么必须有这道护栏（真实事故，2026-10-21）────────────────────────────
 *
 * 本模块做的是一件**小**事（给工作区补一条 `WRITE_OWNER`），但它解锁的是一个**大**动作：
 * 宿主 `AclSandbox.init()` 的 `grantWrite()` 原本在一个只授了 *Modify* 的目录上会以
 * `Win32 5` 失败、**什么都写不进去**；本模块补齐 `WRITE_OWNER` 之后，那次调用就成功了，
 * 于是宿主**一次写入三样东西**（`info = 20` 把 DACL 与 SACL 合成一次写）：
 *
 *   1. 能力 SID 的允许 ACE；
 *   2. **`Everyone:(CI)(DENY)(DC)`** —— 拒删子项；
 *   3. **`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`** —— 低完整性标签。
 *
 * 第 2 项会**向下继承到每一个子目录**，而且它是**显式 deny**：deny 先于 allow 求值，
 * 所以连所有者的 `FullControl` 也压不住它。实测（本机）：
 *
 *     icacls "C:\Users\asus\.dsh\profiles\desktop"
 *       Everyone:(CI)(DENY)(DC)
 *       Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
 *
 * 也就是说，**只要某个会话的 cwd 落在 DSH 自己的目录上**，本模块就会替宿主把这两样
 * 打到 DSH 身上 —— 而这个目录里装着 `node_modules` 与 `cordis.patch.yml`。子目录被拒删
 * 的直接后果就是「换包 / 清理失败」，表现正是普通权限起不来、管理员可以
 * （管理员能夺所有权绕过 deny）。这条路径**在本机已被走到过**：实测有 5 个根会话
 * 把 `C:\Users\asus\.dsh\profiles\desktop` 当作工作区。
 *
 * ⚠️ 归因要说准，别把责任推错方向：
 *
 *   · 上面那三样**不是本模块写的** —— 本模块只写一条 `TakeOwnership`，
 *     且 `test/workspace-acl-rules.mjs` 的 W1/W2 静态钉住了「绝不含 FullControl /
 *     Modify、绝不删 ACE、绝不改所有者、绝不动 SACL」；
 *   · 但对 *Modify-only* 的目录，**本模块是那次写入能从失败变成成功的原因**；
 *   · 对一个本来就有 *FullControl* 的目录（例如 `C:\Users\asus\.dsh\profiles\desktop`），
 *     宿主自己就能写成功，本模块的 `Test-WriteOwner` 会判 `HAS-WRITE-OWNER` 并**不改动
 *     任何东西** —— 所以那处痕迹是宿主独立留下的。
 *
 * 结论：这是**本模块缺少「哪些目录不该碰」这道判断**的缺陷。授权本身是加法的、
 * 无害的；真正危险的是它为宿主那次三合一写入开了门，而门后是 DSH 自己。
 *
 * ── 判据为什么是这四条 ───────────────────────────────────────────────────────
 *
 * 全都指向同一件事：**这个目录一旦被沙箱盖章，坏的是「能不能启动 / 能不能更新」**，
 * 而不是「某个 worker 能不能写文件」。所以宁可跳过（退回「shell 起不来」的旧状态，
 * 那是可解释、可绕过的），也绝不在这些位置动手。
 *
 * @param dir - 候选工作区目录（会话 cwd）。
 * @returns 敏感路径的原因标识；不敏感时返回 undefined。
 */
export function sensitiveReasonFor(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return 'empty-path'
  const normalized = dir.replace(/[\\/]+$/, '')
  if (normalized === '') return 'empty-path'
  const lower = normalized.toLowerCase()

  // ① 盘符根。`H:\` 只授 `Authenticated Users:(M)`，正是需要 WRITE_OWNER 的那种目录 ——
  //    也正因如此它最危险：盖章会继承到整块盘。
  if (/^[a-z]:$/.test(lower)) return 'drive-root'

  // ② 目录里装着**正在运行的程序本身** → 这是安装目录。
  //    用「cwd 是不是 execPath 的祖先」来判定，不必知道安装路径长什么样：
  //    execPath 形如 `G:\DSH\resources\runtime\...\node.exe`，于是 `G:\DSH` 会被判出。
  const exec = process.execPath
  if (typeof exec === 'string' && exec !== '') {
    const execLower = exec.toLowerCase()
    if (execLower.startsWith(lower + '\\') || execLower.startsWith(lower + '/')) return 'contains-running-app'
  }

  // ③ DSH 的状态目录（`~/.dsh`，含 profiles 与 sessions）以及它的**祖先**
  //    （`C:\Users\asus`、`C:\Users`、`C:\` …）。祖先一并挡掉：给祖先打低完整性标签
  //    等于把范围放大到整个用户目录。
  const home = typeof process.env.USERPROFILE === 'string' ? process.env.USERPROFILE : ''
  if (home !== '') {
    const homeLower = home.toLowerCase().replace(/[\\/]+$/, '')
    const stateLower = homeLower + '\\.dsh'
    if (lower === stateLower || lower.startsWith(stateLower + '\\')) return 'dsh-state-dir'
    if (homeLower === lower || homeLower.startsWith(lower + '\\')) return 'ancestor-of-dsh-state'
  }

  // ④ 系统目录。
  for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[name]
    if (typeof value !== 'string' || value === '') continue
    const sysLower = value.toLowerCase().replace(/[\\/]+$/, '')
    if (lower === sysLower || lower.startsWith(sysLower + '\\')) return 'system-dir'
  }

  return undefined
}


/**
 * 跑一次性 PowerShell，返回 `{ stdout, exitCode, timedOut }`。**本模块唯一的副作用出口。**
 *
 * 动态 import 是刻意的：保持本模块的静态导入面为空（仓库既有的
 * 「预设模块零依赖可加载」断言继续成立）。
 *
 * @param script - 要执行的 PowerShell 脚本文本（经 `-EncodedCommand` 传入）。
 * @param env - 额外环境变量（工作区路径走这里，不拼进脚本）。
 * @param timeoutMs - 本次调用的超时（毫秒）。缺省是根目录授权那一档 15s；整树补齐
 *   （`buildRepairScript()`）显式传 120s —— 两者仍是**同一个**子进程出口。
 * @returns 子进程结果；任何意外都归到 `exitCode: null`。
 */
async function runPowerShell(script, env, timeoutMs = TIMEOUT_MS) {
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
    }, timeoutMs)

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
 * 装载本模块：在会话开始时，确保工作区目录具备 DSH ACL 沙箱所需的 `WRITE_OWNER`，
 * 并在其后串行补一次既存对象的继承与 Low 标签（见文件头「既存对象」那一节）。
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

  /**
   * 本模块所属的 preset id —— 「切进来的到底是不是本模式」这条判据。
   *
   * 由 composition 传入（与 `definition.id` 同源）；宿主半在 profile 覆盖
   * `config.presetId` 时也会一起对齐，所以这里读到的总是**实际注册**的那个 id。
   */
  const selfPresetId = typeof config?.presetId === 'string' && config.presetId.trim() !== ''
    ? config.presetId.trim()
    : DEFAULT_PRESET_ID

  /**
   * 是否在补完根的 `WRITE_OWNER` 之后，再补一次既存对象的继承与 Low 标签。
   *
   * 默认开；`config.autoRepairStampedChildren: false` **只**关这一步，根的
   * `WRITE_OWNER` 照补（两个开关互相独立）。`autoGrantWriteOwner: false` 是上面
   * 那条更早的早退 —— 那是「整个模块不注册」的既有语义，不是只关授权。
   */
  const repairStampedChildren = config?.autoRepairStampedChildren !== false

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

  /**
   * 尽力给**既存对象**补齐宿主写在根上的可继承条目与 Low 标签。**任何失败都只记日志。**
   *
   * 只由 `consider()` 在 `ensureWriteOwner(dir)` **之后**串行调用：顺序不可反 ——
   * 根先有 `WRITE_OWNER`，后面 `icacls ... /T` 的继承与写标签才在整棵树上成立。
   * 同样 fire-and-forget：整树 `/T` 比根目录那一次重，绝不能拖住会话发布。
   *
   * @param dir - 工作区目录（会话 cwd）。
   */
  const ensureStampedChildren = async (dir) => {
    let result
    try {
      // 整树操作走与授权**同一个** `runPowerShell` 出口，只是超时单独放宽。
      result = await runPowerShell(buildRepairScript(), { DSH_MT_ACL_DIR: dir }, REPAIR_TIMEOUT_MS)
    } catch (error) {
      result = { stdout: '', exitCode: null, timedOut: false, error }
    }
    const outcome = result.timedOut
      ? 'failed'
      : parseRepairOutcome(result.stdout, result.exitCode)

    try {
      switch (outcome) {
        case 'ok':
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SUB-OK ${JSON.stringify(dir)} existing top-level entries (directories and files) already carry the integrity label; nothing was changed`,
          )
          return
        case 'repaired':
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SUB-REPAIRED ${JSON.stringify(dir)} — existing objects re-inherited the parent entries and the Low integrity label was written (WRITE_OWNER and Low only, no FullControl)`,
          )
          return
        case 'skipped': {
          const match = /SUB-SKIPPED\s+reason=(\S+)/.exec(String(result.stdout ?? ''))
          const reason = match !== null ? match[1] : 'unrecognized-output'
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SUB-SKIPPED reason=${JSON.stringify(reason)} dir=${JSON.stringify(dir)}`,
          )
          return
        }
        default: {
          const detail = result.timedOut
            ? `timed out after ${REPAIR_TIMEOUT_MS}ms`
            : (result.error !== undefined
                ? String(result.error?.message ?? result.error)
                : (String(result.stdout ?? '').trim().replace(/^FAILED:\s*/, '') || `exit ${String(result.exitCode)}`))
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SUB-FAILED reason=${JSON.stringify(detail)} dir=${JSON.stringify(dir)}`,
          )
          return
        }
      }
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }

  /**
   * 判定一个 agent 是否需要为它的 cwd 补授权，并在需要时发起一次。
   *
   * 判据刻意**不看**「是不是根会话」：这个 cwd 处理过没有，由 `handled` 回答。
   * 父会话已经补过时，子代理这一跳只查一次 Set；父会话没补时（首轮前切换 /
   * 跨模式派发），子代理就是唯一能补的时机 —— 见文件头那段落网记录。
   *
   * @param agent - 待检查的 agent。
   * @param trigger - 触发来源（只用于日志与告警文案）。
   */
  const consider = (agent, trigger) => {
    try {
      const session = agent?.session
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        try {
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SKIPPED reason=no-session-cwd trigger=${trigger}`,
          )
        } catch {
          // 同上。
        }
        return
      }

      const mode = sandboxModeOf(ctx, session)
      if (mode !== 'workspace-write') {
        try {
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SKIPPED reason=sandbox-mode-${String(mode ?? 'unreadable')} dir=${JSON.stringify(cwd)} trigger=${trigger}`,
          )
        } catch {
          // 同上。
        }
        return
      }

      // ── 护栏：DSH 自己的目录、它的祖先、盘符根、安装目录、系统目录一律不碰 ──
      //
      // ⚠️ 这一条是 2026-10-21 事故的直接修复，别删。理由见 `sensitiveReasonFor()`
      // 的注释：本模块只写一条无害的 `TakeOwnership`，但它会让宿主那次**三合一**写入
      // （能力 ACE + `Everyone:DENY(DC)` + Low 完整性标签）从「失败」变成「成功」。
      // 打在 DSH 自己的目录上，后果是普通权限起不来、只有管理员能进。
      //
      // 方向必须是「跳过」而不是「照做但告警」：跳过最坏退回「shell 起不来」
      // —— 那是可解释、可绕过的旧状态；照做的代价是 DSH 装不回来。
      const sensitive = sensitiveReasonFor(cwd)
      if (sensitive !== undefined) {
        try {
          ctx.logger?.info?.(
            `dsh-multitask: MULTITASK-WORKSPACE-ACL-SKIPPED reason=sensitive-path-${sensitive} dir=${JSON.stringify(cwd)} trigger=${trigger}` +
              ' — this directory holds DSH itself or its state; granting WRITE_OWNER here would let the sandbox stamp it',
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
      // 串行两步：① 先补根的 WRITE_OWNER（宿主盖章的前提）；② 再补既存对象的继承
      // 与 Low 标签。顺序不可反 —— 根没有 WO 时，第二步的整树写入根本不会成立。
      // 第一步通常只需数百毫秒，而第一条命令要等用户发消息之后才可能出现 —— 来得及。
      ensureWriteOwner(cwd)
        .then(() => (repairStampedChildren ? ensureStampedChildren(cwd) : undefined))
        .catch((error) => {
          warn(`checking ${JSON.stringify(cwd)} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
        })
    } catch (error) {
      // 兜底：本模块的任何意外都不得影响会话。
      warn(`checking a workspace on ${trigger} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 主路径：会话创建时检查并（必要时）补最小授权 ─────────────────────────────
  //
  // 为什么是 `agent/created`：它与同仓其他守卫同一时机（会话刚发布、第一条用户消息
  // 尚未进入），而沙箱的授权发生在首次执行命令时 —— 所以这里来得及。
  //
  // ⚠️ **不再对委派子代理早退**：那会让「父会话创建时不是 multitask（首轮前切换 /
  // 跨模式派发）」这一整类情形无人补授权，而子代理恰恰是唯一还在的正确时机。
  // 重复触发由 `handled` 按 cwd 兜住，代价只有一次 Set 查询。
  //
  // payload 刻意解构：`agent/created` 传的是 payload **对象**，不是 agent 本身。
  ctx.on('agent/created', (payload) => {
    consider(payload?.agent, 'agent/created')
  })

  // ── 切换路径：首轮前切进本模式时补一次（`agent/created` 已经过去了）─────────
  //
  // `agent-preset/selected` 是无载体广播，由注册表以
  // `ctx.emit("agent-preset/selected", sessionId, id)` 发出 —— 两个参数分别是
  // 会话 id 与**新的** preset id。本模块只处理「切进来」这一个方向：
  // 对切走的会话补授权，等于给别的模式的工作区盖章，方向是反的。
  ctx.on('agent-preset/selected', (sessionId, presetId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const agent = agentById(ctx, sessionId)
    if (agent === undefined) return
    // 第二个参数是权威答案；缺席时才退回读活绑定。两者都读不到 → **不动作**。
    const target = typeof presetId === 'string' && presetId !== ''
      ? presetId
      : composedPresetId(ctx, agent)
    if (target !== selfPresetId) return
    consider(agent, 'agent-preset/selected')
  })
}
