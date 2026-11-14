/**
 * workspace-acl 规则与决策校验（进程内 / 零依赖 / 不触碰任何 ACL）。
 *
 * ── 它守的是什么 ─────────────────────────────────────────────────────────────
 *
 * `workspace-acl.mjs` 会在会话开始时给工作区目录补一条**最小**权限。
 * 它是本仓库里唯一会改**系统状态**（目录 ACL）的模块，所以它最要紧的三条性质
 * 必须被静态钉住：
 *
 *   1. **只授 `TakeOwnership`** —— 绝不 `FullControl` / `Modify`。
 *      这是红线：`FullControl` 会额外给出「改权限 + 夺所有权」，远超沙箱所需。
 *   2. **看不清楚就不动作** —— 读不出沙箱模式、不是 `workspace-write`、
 *      没有 cwd、被配置关掉，都必须**什么都不做**（而不是猜着改 ACL）。
 *      ⚠️ 「是子代理」**不**在这一列里：那一跳**不再早退**（早退正是 2026-10-31
 *      漏网的成因），它只被要求「除了 ACL-* 家族日志之外不写别的」—— 见 W10。
 *   3. **任何失败都不抛** —— 最坏退回「shell 起不来」的旧状态，绝不阻塞会话创建。
 *
 * ── 它刻意不做什么 ───────────────────────────────────────────────────────────
 *
 * **不会**对着任何真实目录跑授权：唯一的子进程调用指向一个**不存在的路径**
 * （`Get-Acl` 必然抛错），因此这个文件跑一万次也不会改动任何 ACL。
 * 真正改动 ACL 的端到端验证在装机后由使用者做（见 README）。
 *
 * @module dsh-multitask/test/workspace-acl-rules
 */
// ── 变异测试的内存内注入口（见 `test/workspace-acl-guard-mutation.mjs`）──────────
//
// 变异测试要让本文件的**同一批用例**跑在一份被改坏的模块上，同时**绝不写 `presets/`**。
// 做法：把那份变异后的源码放在仓库外的临时文件里，用 `DSH_MT_ACL_MODULE_URL` 把它的
// `file://` URL 传进来，本文件只在拿到这个变量时才从那里加载**同一组导出**。
// 不设该变量时（正常自检、任何人手工跑）走的仍是下面那条相对导入 —— 也就是说
// 判据一条都没动，入口处多出来的只是一条**可选**、纯本地的重定向。
const overrideUrl = process.env.DSH_MT_ACL_MODULE_URL
const preset = overrideUrl === undefined || overrideUrl === ''
  ? await import('../../presets/multitask/workspace-acl.mjs')
  : await import(overrideUrl)
const {
  apply,
  buildGrantScript,
  buildRepairScript,
  isDelegatedChild,
  parseGrantOutcome,
  parseRepairOutcome,
  sensitiveReasonFor,
} = preset

const results = []

/** 跑一条同步用例并记录（与同目录其他脚本同形状）。 */
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
 * 跑一条异步用例并记录。
 *
 * ⚠️ 必须 `await` 断言体再记录：`test()` 若就地调用却不等，`async` 用例一碰到
 * 第一个 `await` 就交回控制权，结果会被**立刻**记成通过 —— 那种用例永远是绿的。
 * 本仓库对这一点的纪律写在 README 的「自检」一节。
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

/** 最小断言（本仓库刻意不用 `node:assert`）。 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 造一个假 ctx，记录事件注册与日志。
 *
 * @param options - `{ mode }`：`sandboxPolicy.resolve` 返回的模式；
 *   `null` 表示该服务缺席（用来验证「读不出就不动作」）。
 * @returns `{ ctx, handlers, logs }`。
 */
function fakeCtx(options = {}) {
  const handlers = []
  const logs = { info: [], warn: [] }
  const services = {}
  if (options.mode !== null) {
    services.sandboxPolicy = { resolve: () => ({ mode: options.mode ?? 'workspace-write' }) }
  }
  const ctx = {
    on(event, handler) {
      handlers.push({ event, handler })
      return () => {}
    },
    get(name) {
      return services[name]
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
  }
  return { ctx, handlers, logs }
}

/**
 * 造一个假 agent。
 *
 * @param header - 会话头（`cwd` / `delegationDepth` / `origin` / `parentSession`）。
 * @returns agent 替身。
 */
function fakeAgent(header) {
  return { id: 'sess-1', session: { header } }
}

/** 等子进程与微任务排空（用于让 fire-and-forget 的检查跑完）。 */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个**不存在**的路径：授权脚本对它必然抛错，因此不会改动任何 ACL。 */
const NONEXISTENT = 'H:\\__dsh_mt_acl_test_nonexistent__'

console.log('===== dsh-multitask workspace-acl 规则与决策校验（进程内 / 零依赖）=====')

// ── 一、授权脚本的内容：只允许 TakeOwnership（红线）──────────────────────────
console.log('\n--- 1. 授权脚本只授最小权限（红线）---')

test('W1 生成的脚本只含 TakeOwnership，绝不含 FullControl / Modify', () => {
  const script = buildGrantScript()
  assert(
    script.includes('[System.Security.AccessControl.FileSystemRights]::TakeOwnership'),
    '脚本里找不到 TakeOwnership —— 它是最小授权本身，缺了就没在修问题',
  )
  assert(
    !/FullControl/.test(script),
    '脚本里出现了 FullControl —— 那会额外给出「改权限 + 夺所有权」，' +
      '远超沙箱所需的 WRITE_OWNER。这是本模块最要紧的一条红线。',
  )
  assert(
    !/::Modify\b/.test(script),
    '脚本里出现了 Modify —— Modify 不含 WRITE_OWNER，正是当前失败的那一档，修不了问题',
  )
  assert(
    !/::WriteOwner\b/.test(script) || script.includes('::TakeOwnership'),
    '脚本应当用 TakeOwnership（WRITE_OWNER 的 .NET 名），不要混用别的写法',
  )
})

test('W2 脚本不删既有 ACE、不改所有者、不动 SACL', () => {
  const script = buildGrantScript()
  assert(!/RemoveAccessRule|PurgeAccessRules|SetOwner|RemoveAccessRuleAll/.test(script), '脚本里出现了删除 ACE 或改所有者的动作 —— 本模块只做加法')
  assert(!/Audit|SACL|IntegrityLevel|setintegritylevel/i.test(script), '脚本里出现了改审计 / 标签的动作 —— 那是宿主沙箱的职责，不是本模块的')
})

test('W3 路径经环境变量传入，不拼进脚本（无注入面）', () => {
  const script = buildGrantScript()
  assert(script.includes('$env:DSH_MT_ACL_DIR'), '脚本没有从环境变量读路径 —— 那样路径就得拼进脚本文本，引入注入面')
  assert(!/\$\{?dir\}?/.test(script.replace(/\$dir/g, '')), '脚本里出现了把路径直接插值的写法')
})

// ── 二、输出解析（纯函数）────────────────────────────────────────────────────
console.log('\n--- 2. 子进程输出的解析 ---')

test('W4 三种结论都能正确解析', () => {
  assert(parseGrantOutcome('HAS-WRITE-OWNER', 0) === 'ok', 'HAS-WRITE-OWNER 应当解析为 ok')
  assert(parseGrantOutcome('GRANTED-WRITE-OWNER', 0) === 'granted', 'GRANTED-WRITE-OWNER 应当解析为 granted')
  assert(parseGrantOutcome('FAILED: 拒绝访问。', 1) === 'failed', 'FAILED 应当解析为 failed')
  assert(parseGrantOutcome('GRANT-VERIFY-FAILED', 1) === 'failed', 'GRANT-VERIFY-FAILED 应当解析为 failed')
})

test('W5 认不出的输出不抛错，归到 ok / unknown', () => {
  // 契约是「任何意外都不得影响会话」，所以解析器永不许抛。
  assert(parseGrantOutcome(undefined, 0) === 'ok', '缺输出 + exit 0 应当算 ok')
  assert(parseGrantOutcome('', 0) === 'ok', '空输出 + exit 0 应当算 ok')
  assert(parseGrantOutcome('完全认不出的东西', 3) === 'unknown', '认不出 + 非零退出应当算 unknown')
  assert(parseGrantOutcome(null, null) === 'unknown', 'null 输入应当算 unknown 而不是抛错')
  assert(parseGrantOutcome(123, 0) === 'ok', '非字符串输出不应抛错')
})

// ── 三、子代理判据（与同仓守卫一致）─────────────────────────────────────────
console.log('\n--- 3. 子代理判据 ---')

test('W6 三个信号任一成立即为子代理', () => {
  assert(isDelegatedChild(undefined) === false, 'undefined 不是子代理')
  assert(isDelegatedChild({ session: { header: null } }) === false, 'null header 不是子代理')
  assert(isDelegatedChild(fakeAgent({ cwd: 'X' })) === false, '普通会话（只有 cwd）不是子代理')
  assert(isDelegatedChild(fakeAgent({ origin: 'subagent' })) === true, 'origin 判据失效')
  assert(isDelegatedChild(fakeAgent({ parentSession: 'p' })) === true, 'parentSession 判据失效')
  assert(isDelegatedChild(fakeAgent({ delegationDepth: 1 })) === true, 'delegationDepth 判据失效')
})

// ── 四、决策：只在看得清楚、且该做的时候才动作 ──────────────────────────────
console.log('\n--- 4. 决策：看不清楚就不动作 ---')

const run = (ctx, handlers, agent) => {
  const created = handlers.find((h) => h.event === 'agent/created')
  assert(created !== undefined, '本模块没有注册 agent/created')
  created.handler({ agent })
}

await testAsync('W7 读不出沙箱模式：跳过（绝不在看不清楚时改 ACL）', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: null })
  apply(ctx, { enabled: true })
  run(ctx, handlers, fakeAgent({ cwd: NONEXISTENT }))
  await settle(50)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-WORKSPACE-ACL-SKIPPED reason=sandbox-mode-unreadable')),
    `读不出模式时必须跳过，实际日志：${logs.info.join(' | ')}`,
  )
  assert(logs.info.every((m) => !m.includes('GRANTED')), '看不清楚时绝不该发生授权')
})

await testAsync('W8 非 workspace-write：跳过（read-only 不需要授权）', async () => {
  for (const mode of ['read-only', 'danger-full-access']) {
    const { ctx, handlers, logs } = fakeCtx({ mode })
    apply(ctx, { enabled: true })
    run(ctx, handlers, fakeAgent({ cwd: NONEXISTENT }))
    await settle(50)
    assert(
      logs.info.some((m) => m.includes(`MULTITASK-WORKSPACE-ACL-SKIPPED reason=sandbox-mode-${mode}`)),
      `mode=${mode} 时必须跳过，实际日志：${logs.info.join(' | ')}`,
    )
    assert(logs.info.every((m) => !m.includes('GRANTED')), `mode=${mode} 时绝不该授权`)
  }
})

await testAsync('W9 没有 cwd：跳过', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  run(ctx, handlers, fakeAgent({}))
  await settle(50)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-WORKSPACE-ACL-SKIPPED reason=no-session-cwd')),
    `无 cwd 时必须跳过，实际日志：${logs.info.join(' | ')}`,
  )
})

await testAsync('W10 子代理这一跳只许写 ACL-* 家族日志（守的是「不旁逸出别的东西」）', async () => {
  // ── 这条判据守的是什么，以及它为什么**不是**「零日志」──────────────────────────
  //
  // 旧判据是「处理子代理时一条日志都不许有」，它已经与本模块的设计**直接冲突**：
  // 实现**刻意不再对委派子代理早退**（见 `workspace-acl.mjs` 里 `consider()` 上方那段
  // 落网记录 —— 「是子代理就 return」正是 2026-10-31 漏网的成因），于是子代理这一跳
  // 会照常走「补根的 WRITE_OWNER → 补既存对象」两步，必然留下记录：
  // `NONEXISTENT` 本就不存在，且本沙箱里 spawn 本身就 EPERM —— 两种情形都**应该**
  // 如实记一条 FAILED（那正是「失败只记日志、不抛」的承诺）。所以「零日志」这条断言
  // 必然恒红，它守的也不是任何真实性质。
  //
  // 换成：**只允许**出现 `MULTITASK-WORKSPACE-ACL-*` 这一族日志
  // （`-OK` / `-GRANTED` / `-FAILED` / `-SKIPPED` / `-SUB-OK` / `-SUB-REPAIRED` /
  // `-SUB-SKIPPED` / `-SUB-FAILED`），**不许**出现其它任何日志（info 与 warn 一起算）。
  //
  // 它守的是「**子代理这一跳不会写别的日志、也不会做别的事**」：护栏跳过的文案、
  // `warnOnceFactory` 那条带前缀的告警、以及将来任何新加的旁路日志，只要不在这族里
  // 就会被这条抓住；而「这一跳该不该处理」本身由 W13（每 cwd 只一次）与
  // W18 / W23（敏感目录一次子进程都不起）去守，不归这里管。
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  run(ctx, handlers, fakeAgent({ cwd: NONEXISTENT, origin: 'subagent', delegationDepth: 1 }))
  await settle(80)
  const strangers = [...logs.info, ...logs.warn].filter((m) => !m.includes('MULTITASK-WORKSPACE-ACL-'))
  assert(
    strangers.length === 0,
    `子代理这一跳只许产生 MULTITASK-WORKSPACE-ACL-* 家族日志，实际还有 ${strangers.length} 条别的：${strangers.join(' | ')}`,
  )
})

await testAsync('W11 enabled: false / autoGrantWriteOwner: false：一个监听器都不注册', async () => {
  const a = fakeCtx({ mode: 'workspace-write' })
  apply(a.ctx, { enabled: false })
  assert(a.handlers.length === 0, `enabled: false 时不该注册监听器，实际 ${a.handlers.length} 个`)

  const b = fakeCtx({ mode: 'workspace-write' })
  apply(b.ctx, { enabled: true, autoGrantWriteOwner: false })
  assert(b.handlers.length === 0, `autoGrantWriteOwner: false 时不该注册监听器，实际 ${b.handlers.length} 个`)
  assert(
    b.logs.info.some((m) => m.includes('MULTITASK-WORKSPACE-ACL-SKIPPED reason=disabled-by-config')),
    '被配置关掉时应当留一条可 grep 的记录',
  )
})

await testAsync('W12 载荷畸形不抛错（承诺：任何意外都不得影响会话创建）', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  const created = handlers.find((h) => h.event === 'agent/created')
  // 这几种输入都不该抛 —— 抛了就会破坏会话创建。
  created.handler(undefined)
  created.handler({})
  created.handler({ agent: null })
  created.handler({ agent: { session: null } })
  created.handler({ agent: { session: { header: { cwd: 123 } } } })
  await settle(60)
  assert(logs.warn.length === 0, `畸形输入应当被静默忽略，实际有 ${logs.warn.length} 条警告：${logs.warn.join(' | ')}`)
})

await testAsync('W13 同一工作区只尝试一次（每进程去重）', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  const created = handlers.find((h) => h.event === 'agent/created')
  // 同一个 cwd（末尾斜杠也应视为同一个）连开三次。
  created.handler({ agent: fakeAgent({ cwd: NONEXISTENT }) })
  created.handler({ agent: fakeAgent({ cwd: NONEXISTENT }) })
  created.handler({ agent: fakeAgent({ cwd: `${NONEXISTENT}\\` }) })
  await settle(4000)
  const attempts = logs.info.filter((m) => /ACL-(GRANTED|FAILED|OK)/.test(m)).length
  assert(attempts === 1, `同一工作区只应尝试一次，实际 ${attempts} 次（日志：${logs.info.join(' | ')}）`)
})

await testAsync('W14 授权失败只记日志、不抛、不影响调用方', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  // 不存在的路径 ⇒ 脚本必然报 FAILED。这里要证明的是：模块如实记录，且不抛。
  run(ctx, handlers, fakeAgent({ cwd: NONEXISTENT }))
  await settle(6000)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-WORKSPACE-ACL-FAILED reason=')),
    `失败必须留可 grep 的记录，实际日志：${logs.info.join(' | ')}`,
  )
  assert(
    logs.info.every((m) => !m.includes('GRANTED')),
    '对着不存在的路径绝不该报 GRANTED',
  )
})

// ── 五、护栏：DSH 自己的目录绝不能被盖章（2026-10-21 事故的直接修复）──────────
//
// ⚠️ 这一节为什么必须存在：
//
// 本模块只写一条无害的 `TakeOwnership`，但它会让宿主 `AclSandbox.init()` 的
// `grantWrite()` 从「Win32 5 失败」变成「成功」—— 而那次调用**一次写入三样东西**：
// 能力 ACE、`Everyone:(CI)(DENY)(DC)`、以及 Low 完整性标签。
//
// 若 cwd 是 DSH 自己的状态目录（`~/.dsh` 或它下面的 profiles），这三样就会继承进
// `node_modules` 与 `cordis.patch.yml`。`DENY(DC)` 是显式拒绝、deny 先于 allow 求值，
// 连所有者的 FullControl 也压不住 —— 症状正是「普通权限起不来、管理员可以」。
//
// 本机实测这条路径**已经被走到过**：有 5 个根会话把
// `C:\Users\asus\.dsh\profiles\desktop` 当作工作区，那个目录现在带着
// `Everyone:(CI)(DENY)(DC)` 与 `Low Mandatory Level:(OI)(CI)(NW)`。
console.log('\n--- 5. 护栏：敏感目录一律不碰 ---')

test('W15 DSH 状态目录、它的祖先、盘符根、安装目录、系统目录全部拦下', () => {
  // 拦：DSH 状态目录本身与其子目录
  for (const p of ['.dsh', '.dsh\\profiles', '.dsh\\profiles\\desktop', '.dsh\\sessions']) {
    const full = `${process.env.USERPROFILE ?? 'C:\\Users\\u'}\\${p}`
    assert(sensitiveReasonFor(full) === 'dsh-state-dir', `${full} 必须被拦（它是 DSH 自己的状态目录），实际：${sensitiveReasonFor(full)}`)
  }
  // 拦：状态目录的祖先（给祖先盖章等于把范围放大到整个用户目录）
  for (const p of [process.env.USERPROFILE, 'C:\\Users']) {
    assert(
      sensitiveReasonFor(p) === 'ancestor-of-dsh-state',
      `${p} 必须被拦（它是 .dsh 的祖先），实际：${sensitiveReasonFor(p)}`,
    )
  }
  // 拦：盘符根（盖章会继承到整块盘）
  assert(sensitiveReasonFor('H:\\') === 'drive-root', '盘符根必须被拦')
  assert(sensitiveReasonFor('C:\\') === 'drive-root', '盘符根必须被拦')
  assert(sensitiveReasonFor('H:') === 'drive-root', '不带斜杠的盘符根也必须被拦')
  // 拦：安装目录（cwd 是正在运行的 node.exe 的祖先）
  const execDir = process.execPath.slice(0, process.execPath.lastIndexOf('\\'))
  assert(
    sensitiveReasonFor(execDir) === 'contains-running-app',
    `运行中程序的目录必须被拦：${execDir}，实际：${sensitiveReasonFor(execDir)}`,
  )
})

test('W16 普通工作区不被误拦（护栏不能把正常用法一起废掉）', () => {
  for (const p of ['H:\\dsh-multitask', 'H:\\test5', 'H:\\CodeRelay', 'D:\\projects\\app']) {
    const reason = sensitiveReasonFor(p)
    // 注意：若用户恰好把工作区放在 `C:\Users\asus` 下，那会被祖先规则拦下 —— 那是设计。
    // 这里只用与用户目录无关的路径，确保断言不依赖具体机器。
    if (p.startsWith('C:')) continue
    assert(reason === undefined, `普通工作区 ${p} 不该被拦，实际：${reason}`)
  }
})

test('W17 空路径与畸形输入不抛（契约：任何意外都不得影响会话）', () => {
  for (const v of ['', '   ', undefined, null, 123,]) {
    let threw = false
    try {
      sensitiveReasonFor(v)
    } catch {
      threw = true
    }
    assert(!threw, `sensitiveReasonFor(${String(v)}) 抛错了 —— 它必须永不抛`)
  }
})

await testAsync('W18 ★ 敏感目录上：连一次子进程都不许启动', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  const dshDir = `${process.env.USERPROFILE ?? 'C:\\Users\\u'}\\.dsh\\profiles\\desktop`
  run(ctx, handlers, fakeAgent({ cwd: dshDir }))
  // ⚠️ 必须等得足够久（与 W13 同量级，那里也是等一次真实 powershell 往返）。
  //
  // 这里踩过一个坑：第一版只等 300ms，而 `ensureWriteOwner` 是 fire-and-forget、
  // 真实 powershell 往返要几百毫秒到数秒。于是「把护栏改成告警但仍照做」那种变异
  // 虽然真的启动了子进程，却因为日志还没回来而**假通过** —— 变异验证里表现为
  // 「未命中」。等满 4000ms 之后，那种变异会稳定留下 ACL-* 日志，W18 才真的抓得住它。
  //
  // 断言方向是「等够了仍然没有任何授权痕迹」，而不是「某一瞬间没有」。
  await settle(4000)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-WORKSPACE-ACL-SKIPPED reason=sensitive-path-dsh-state-dir')),
    `指向 DSH 状态目录时必须跳过并留下可 grep 的记录，实际：${logs.info.join(' | ')}`,
  )
  // 关键：不该有任何「尝试过授权」的痕迹。
  assert(
    logs.info.every((m) => !/ACL-(GRANTED|FAILED|OK)/.test(m)),
    `敏感目录上不该发生任何授权尝试，实际日志：${logs.info.join(' | ')}`,
  )
})


// ── 六、既存子目录补齐（`buildRepairScript`）：最小加法 / 路径只经环境变量 / 先筛后写 ──
//
// ⚠️ 这一节**全部是静态判定**，一条 ACL 命令都不跑 —— 原因和本文件开头写的一样：
//
// `buildRepairScript()` 一旦真跑，`icacls … /T` 会递归改写**整棵树**的 ACL，而本仓
// 约束是「测试绝不执行任何 ACL 变更命令」。所以这里只读脚本文本的**字面量**，外加
// 一个不存在的路径（沿用 `NONEXISTENT` 的手法）证明「一份都没改」。
//
// 守的三条性质，各自都有确切的坏后果，不是风格问题：
//
//   1. **只做最小加法** —— 脚本以 `/T` 递归作用于整棵工作区，一条被放大的权限会
//      一次继承到每一个既存子目录。`(F)` / `FullControl` 会连「改权限 + 夺所有权」
//      一起给出去；`SetOwner` / `takeown` 改所有者；`RemoveAccessRule` / `/deny` /
//      `/reset` / `/grant:r` 不是加法而是替换或删改。
//   2. **路径只经环境变量** —— 拼进脚本文本就是注入面（与 W3 同一条理由）。
//   3. **先筛后写** —— 子目录都已带标签的幂等会话必须**一次写入都不做**，否则每次
//      会话都在整棵树上重写三遍 ACL：代价白付，且每次写入都是一次新的出错机会。
console.log('\n--- 6. 补齐脚本：最小加法 / 路径只经环境变量 / 先筛后写 ---')

test('W19 补齐脚本只做最小加法：只补继承与 Low 标签，绝不放宽授权', () => {
  const script = buildRepairScript()

  // ── 红线先判（顺序刻意如此）：一旦有人把 `:(WO)` 写成 `:(F)`，报错必须直接落在
  // 红线上，而不是先抱怨「找不到 `:(WO)`」—— 后者会被误读成「少写了一个字」。
  //
  // 为什么这几条不是风格：脚本以 `/T` 递归作用于**整棵树**，被放大的那一档权限会
  // 一次继承到每一个既存子目录；而 `/grant:r`、`/reset`、`RemoveAccessRule` 是替换
  // 或删除既有 ACE —— 宿主写在根上的撤销项一旦被抹掉，目录的权限就只剩本脚本这一次
  // 写的结果，那已经不是「补齐」，是「重写」。
  const forbidden = [
    ['FullControl', 'FullControl 会额外给出「改权限 + 夺所有权」，远超沙箱所需的 WRITE_OWNER —— 这是本模块最要紧的一条红线'],
    ['(F)', '`(F)` 就是 Full control 的 icacls 写法 —— 把红线换个拼法而已'],
    [':(M)', '`:(M)` 是 Modify：不含 WRITE_OWNER，写不了标签，却仍然比所需更宽'],
    ['SetOwner', '改所有者不是加法：它把目录的所有权从使用者手里拿走'],
    ['RemoveAccessRule', '删除既有 ACE 不是加法 —— 补齐只允许追加'],
    ['/deny', '`/deny` 是显式拒绝：deny 先于 allow 求值，连所有者的 FullControl 也压不住（2026-10-21 事故的形态）'],
    ['/reset', '`/reset` 把 ACL 重置成继承来的那一份，等于删掉既有 ACE'],
    ['/grant:r', '`/grant:r` 会替换该 SID 的既有 ACE，而不是追加'],
    ['takeown', '`takeown` 是夺所有权 —— 与 SetOwner 同一类，不是加法'],
  ]
  for (const [needle, why] of forbidden) {
    assert(!script.includes(needle), `补齐脚本里出现了 ${needle} —— ${why}。这是红线。`)
  }
  assert(!/takeown/i.test(script), '补齐脚本里出现了 takeown 的变体拼写 —— 夺所有权不是加法，这是红线')

  // ── 正向：三件必须做的事各自都得在（缺了就不是「只做最小加法」，是「什么都没补」）。
  const required = [
    ['/inheritance:e', '把父目录的可继承条目拉回既存对象 —— 宿主写的能力 ACE 与 delete-child 拒绝都靠这一条到达子目录'],
    ['/setintegritylevel', '写完整性标签是这一步的目的：根上是 Low，既存子目录没有就跟宿主不一致'],
    ['Low', '标签等级必须是 Low（与宿主一致）；改成 Medium/High 会让沙箱内的写入行为变样'],
    ['/T', '整树递归：只改根不动子目录，等于什么都没补'],
    [':(WO)', '整树加的那一条必须是 WRITE_OWNER —— 写标签所需的最小权限，也是本模块唯一允许授出的一档'],
  ]
  for (const [needle, why] of required) {
    assert(script.includes(needle), `补齐脚本里找不到 ${needle} —— ${why}`)
  }
})

test('W20 补齐脚本的路径仍只经环境变量传入（不拼进脚本，无注入面）', () => {
  const script = buildRepairScript()
  // 与 W3 同一条判据、同一个手法：路径只能从 `$env:DSH_MT_ACL_DIR` 进来。
  assert(
    script.includes('$env:DSH_MT_ACL_DIR'),
    '补齐脚本没有从 $env:DSH_MT_ACL_DIR 读路径 —— 那样路径就得拼进脚本文本，引入注入面',
  )
  assert(
    !/\$\{?dir\}?/.test(script.replace(/\$dir/g, '')),
    '补齐脚本里出现了把路径直接插值的写法（`$dir` 只能在脚本内部由环境变量赋值）',
  )
  // 补一条 W3 没有的：脚本里不得出现盘符形态的绝对路径字面量 —— 那正是「路径被拼进来」的痕迹。
  assert(
    !/[A-Za-z]:\\/.test(script),
    '补齐脚本里出现了盘符形态的绝对路径字面量 —— 路径必须只从环境变量进来',
  )
})

test('W21 补齐结果四态都能解析，且任何输入都不抛', () => {
  // 四条规定协议行各归各位。
  assert(parseRepairOutcome('SUB-OK', 0) === 'ok', 'SUB-OK 应当解析为 ok')
  assert(parseRepairOutcome('SUB-REPAIRED count=3', 0) === 'repaired', 'SUB-REPAIRED 应当解析为 repaired')
  assert(parseRepairOutcome('SUB-SKIPPED reason=path-missing', 0) === 'skipped', 'SUB-SKIPPED 应当解析为 skipped')
  assert(parseRepairOutcome('FAILED: 拒绝访问。', 1) === 'failed', 'FAILED 应当解析为 failed')
  // 契约是「任何意外都不得影响会话」，所以解析器永不许抛；返回也必须是那四态之一。
  const states = new Set(['ok', 'repaired', 'skipped', 'failed'])
  const garbage = [
    ['空串', ''],
    ['null', null],
    ['undefined', undefined],
    ['乱码（控制字符 + 替换字符）', '\u0000\uFFFD乱码\uFFFD'],
    ['超长垃圾', 'x'.repeat(200_000)],
  ]
  for (const [label, value] of garbage) {
    let outcome
    let threw = false
    try {
      outcome = parseRepairOutcome(value, 0)
    } catch {
      threw = true
    }
    assert(!threw, `parseRepairOutcome(${label}) 抛错了 —— 它必须永不抛（抛了就会打断会话创建）`)
    assert(states.has(outcome), `parseRepairOutcome(${label}) 返回了四态之外的值：${String(outcome)}`)
  }
})

test('W22 快筛早退排在所有写动作之前（幂等会话一次写入都不做）', () => {
  const script = buildRepairScript()
  // 判据（等价说法）：**第一条 `SUB-OK` 之前不出现任何 icacls 写动作**。
  // 本实现里 `/grant` 只出现一次（那句整树 WO 授权），所以「位置比较」是稳定的；
  // 若将来出现多处 `/grant`，这条会退化成「第一条 SUB-OK 早于第一处写动作」——
  // 与本注释里的等价说法同义。
  const okAt = script.indexOf('SUB-OK')
  const grantAt = script.indexOf('/grant')
  assert(okAt >= 0, '补齐脚本里找不到 SUB-OK —— 快筛早退没了，于是每次会话都会在整棵树上写三遍')
  assert(grantAt >= 0, '补齐脚本里找不到 /grant —— 那句整树 WRITE_OWNER 授权没了')
  assert(
    okAt < grantAt,
    `SUB-OK 排在 /grant 之后（SUB-OK@${okAt}，/grant@${grantAt}）—— ` +
      '等于先写完再判断，幂等会话每次都要整树重写一遍 ACL',
  )
  // 快筛段必须**只读**：它只能跑 `icacls <子目录>`（无参数）来读 `Mandatory Label`。
  const fastPath = script.slice(0, okAt)
  for (const write of ['/grant', '/inheritance', 'setintegritylevel']) {
    assert(
      !fastPath.includes(write),
      `快筛段（第一条 SUB-OK 之前）里出现了写动作 ${write} —— 快筛必须是只读的，否则「先筛后写」就名不副实`,
    )
  }
})

await testAsync('W23 ★ 敏感目录上：根授权与整树补齐都不得起子进程', async () => {
  const { ctx, handlers, logs } = fakeCtx({ mode: 'workspace-write' })
  apply(ctx, { enabled: true })
  // 找一条**既敏感、又不存在**的路径：敏感 ⇒ 护栏必须拦；不存在 ⇒ 即使护栏被改坏，
  // 两个脚本也只会对着空路径失败/跳过，本用例仍然碰不到任何真实 ACL
  // （沿用本文件开头 `NONEXISTENT` 的手法）。
  const dshMissing = `${process.env.USERPROFILE ?? 'C:\\Users\\u'}\\.dsh\\profiles\\__dsh_mt_acl_nowhere__`
  assert(
    sensitiveReasonFor(dshMissing) === 'dsh-state-dir',
    `这条用例依赖的路径必须被判为敏感目录，实际：${String(sensitiveReasonFor(dshMissing))}`,
  )
  run(ctx, handlers, fakeAgent({ cwd: dshMissing }))
  // 与 W18 同样的等待：两个脚本都是 fire-and-forget，真实 powershell 往返要数百毫秒到数秒，
  // 等不够久会让「护栏失效」的变异假通过。断言方向是「等够了仍然没有任何子进程痕迹」。
  await settle(4000)
  assert(
    logs.info.some((m) => m.includes('MULTITASK-WORKSPACE-ACL-SKIPPED reason=sensitive-path-dsh-state-dir')),
    `指向敏感目录时必须跳过并留下可 grep 的记录，实际：${logs.info.join(' | ')}`,
  )
  // 根授权：不该有痕迹（与 W18 同一判据，这里再钉一次是为了让本用例自足）。
  assert(
    logs.info.every((m) => !/ACL-(GRANTED|FAILED|OK)/.test(m)),
    `敏感目录上不该发生根授权，实际日志：${logs.info.join(' | ')}`,
  )
  // 整树补齐：同样一次都不许起。⚠️ 关键在于 `ACL-SUB-*` 不匹配 W18 那条正则
  // （`ACL-(GRANTED|FAILED|OK)` 的 `SUB-` 挡在中间），所以「把补齐那一步挪到护栏之前」
  // 这种改法 W18 抓不到 —— 这条专门抓它。
  assert(
    logs.info.every((m) => !/ACL-SUB-/.test(m)),
    `敏感目录上不该发生整树补齐，实际日志：${logs.info.join(' | ')}`,
  )
})

//
// 与 `repo-consistency.mjs` / `guard-mode-isolation-regression.mjs` 同一条纪律：
// **一条永远绿的守卫断言，恰好等于没有那条断言**。下面把脚本里的最小授权改成
// `FullControl`（在内存里改，不动磁盘文件），确认 W1 真的会抓到。
console.log('\n--- 7. 反向验证（把最小授权改坏后应当变红）---')

let mutantCaught = false
{
  const original = buildGrantScript()
  const needle = '[System.Security.AccessControl.FileSystemRights]::TakeOwnership'
  if (!original.includes(needle)) {
    console.log(`\n!! 找不到用于变异的字符串，反向验证无法进行: ${needle}`)
  } else {
    const mutated = original.replace(needle, '[System.Security.AccessControl.FileSystemRights]::FullControl')
    // 复用 W1 的同一条判据（不是另写一套），确认它确实会红。
    const wouldFail = !/FullControl/.test(mutated) ? false : true
    mutantCaught = wouldFail
    console.log(
      wouldFail
        ? '\n判别力确认：把 TakeOwnership 改成 FullControl 后，W1 会红 —— 那条断言不是恒真的。'
        : '\n!! 判别力不足：改成 FullControl 后 W1 仍然通过。',
    )
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(
  `\nworkspace-acl 规则与决策：${results.length} 条断言组，${results.length - failed.length} 通过，${failed.length} 失败` +
    `；反向验证判别力：${mutantCaught ? '已确认' : '未确认'}`,
)
if (failed.length > 0) {
  console.log('失败明细：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.message}`)
  process.exitCode = 1
}
if (!mutantCaught) process.exitCode = 1
