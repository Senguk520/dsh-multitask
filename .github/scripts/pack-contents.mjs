/**
 * 入包内容把关 —— 发布前核对「哪些文件该进 npm 包、哪些不该」。
 *
 *   node .github/scripts/pack-contents.mjs
 *
 * ── 它守的规矩 ──────────────────────────────────────────────────────────────
 *
 * 口径：**入包内容 = package.json 的 `files` ∩ 远程仓库里已跟踪的文件**。
 *
 * 被 `.gitignore` 忽略的东西只活在本机上，一个都不许进包 ——
 * `install-multitask.ps1`、`test/`、`.cursor/`、`docs/remember.md` 都属于这一类。
 * `.gitignore` 自己虽在仓库里，但它不在 `files` 里，同样不入包。
 *
 * ── 为什么要有这个脚本（不是口头约定）────────────────────────────────────
 *
 * 两条要害都是实测出来的，靠人记不住：
 *
 *   1. **`files` 里写目录会绕过 `.gitignore`。** 实测：`files: ["docs"]` 会把
 *      `docs/remember.md`（私有笔记）一起卷进包；写成 `"docs/DESIGN.md"` 则不会。
 *      本仓库真的因此泄漏过一次。
 *   2. **`files` 里写错的路径是静默忽略的。** npm 不报错、不警告，只是那个路径
 *      一个文件都不贡献 —— 于是不动声色地发出一个缺文件的包。
 *
 * 所以 CI 里跑它，本地也能跑：**本机 `npm publish` 与走 CI 不是同一件事**
 * （CI 是干净 checkout，本机那些被忽略的文件根本不存在），发之前先跑一次。
 *
 * ⚠️ 它只读、只打印，不写任何文件、不改任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()

/**
 * 跑一条外部命令。
 *
 * Windows 上 `npm` 是 `npm.cmd`，Node 出于安全考虑不允许直接 spawn `.cmd`，
 * 所以那里要过一层 shell。参数都是本文件里写死的字面量，没有注入面。
 *
 * @param cmd - 可执行文件名。
 * @param args - 参数数组。
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd === 'npm',
    windowsHide: true,
  })
  if (result.error) {
    console.error(`无法执行 ${cmd}：${result.error.message}`)
    process.exit(2)
  }
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/**
 * 跑一条 git 命令并把输出拆成行。
 *
 * git 的退出码 1 表示「没有命中匹配」，对本脚本的调用方式来说那是正常结果，不算失败。
 *
 * `-c core.quotepath=false` 是必需的：默认 git 会把非 ASCII 路径转义成 `\346\226\207`
 * 这种形式，而打包清单里是原样的中文路径，不关掉就一条都对不上。
 *
 * @param args - git 的参数数组。
 * @param input - 写到 stdin 的内容（`--stdin` 那些子命令用）。
 * @returns 输出行数组。
 */
function git(args, input) {
  const result = run('git', ['-c', 'core.quotepath=false', ...args])
  if (result.status !== 0 && result.status !== 1) {
    console.error(`git ${args.join(' ')} 执行失败：${result.stderr.trim()}`)
    process.exit(2)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// ── 一、取打包清单 ──────────────────────────────────────────────────────────
const pack = run('npm', ['pack', '--dry-run', '--json'])
if (pack.status !== 0) {
  console.error('npm pack --dry-run 失败：')
  console.error(pack.stderr.trim() || pack.stdout.trim())
  process.exit(1)
}

let spec
try {
  spec = JSON.parse(pack.stdout.replace(/^\uFEFF/, ''))[0]
} catch (error) {
  console.error(`无法解析 npm pack 的输出：${error.message}`)
  process.exit(2)
}
const packed = spec.files.map((entry) => entry.path).sort()

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// ── 二、逐条核对 ────────────────────────────────────────────────────────────
const tracked = new Set(git(['ls-files']))
// `--no-index` 是关键：不加它，git 对**已跟踪**的文件直接报「未被忽略」，
// 于是「某个被忽略的文件被误提交了」这件事正好被漏掉 —— 而那恰恰是要挡的。
const ignored = new Set(git(['check-ignore', '--no-index', '--stdin'], packed.join('\n')))

const problems = []

for (const file of packed) {
  if (!tracked.has(file)) problems.push(`不在远程仓库里（未被 git 跟踪）：${file}`)
  if (ignored.has(file)) problems.push(`被 .gitignore 忽略却进了包：${file}`)
}

// `files` 里每一项都必须真的贡献出文件（npm 对写错的路径是静默忽略的）。
for (const entry of pkg.files || []) {
  const name = String(entry).replace(/\/$/, '')
  const contributes = packed.some((file) => file === name || file.startsWith(`${name}/`))
  if (!contributes) {
    problems.push(`files 里的 "${entry}" 一个文件都没入包 —— 路径写错了？npm 会静默忽略它`)
  }
}

// package.json 指向的入口必须在包里，否则装上去就是个坏的包。
const entries = new Set()
if (typeof pkg.main === 'string') entries.add(pkg.main)
for (const value of Object.values(pkg.exports ||{})) {
  if (typeof value === 'string') entries.add(value)
  else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) if (typeof inner === 'string') entries.add(inner)
  }
}
const patch = pkg.dsh?.bundle?.patch
if (typeof patch === 'string') entries.add(patch)
for (const entry of entries) {
  const file = entry.replace(/^\.\//, '')
  if (!packed.includes(file)) problems.push(`package.json 指向的入口不在包里：${file}`)
}

// ── 三、报告 ────────────────────────────────────────────────────────────────
console.log(`入包 ${packed.length} 项（${pkg.name}@${pkg.version}）：`)
for (const file of packed) console.log(`  ${file}`)

if (problems.length > 0) {
  console.error('')
  console.error(`入包内容核对不通过（${problems.length} 项）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('')
console.log('入包内容核对通过：全部来自远程仓库，且没有被 .gitignore 忽略的文件。')
