#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 把 package.json 的版本号写进 README 顶部那张横幅（docs/image/*.svg）
//
// ── 这个脚本在解决什么 ──────────────────────────────────────────────────────
//   README 顶部的 banner 里印着一行 `v1.3.7 · MIT · 零运行时依赖`。版本号由
//   `bump.yml` 在每次推送落到 main 之后自动 patch +1，可图里的那几个字不会自己
//   变 —— 于是 banner 会安静地停在某个旧版本上。这**不会有任何报错**：图片照常
//   显示、页面照常打开，只是内容已经过期了。静态图片 + 自动涨版本，这两个事实
//   放在一起，过期是必然的，只是早晚的区别。
//
//   这里把「图」和 `package.json` 绑成一份数据，让它们只能一起变：
//     · `bump.yml` 在 `npm version patch` 之后调 `--write`，把新号写进 SVG。
//       改图和涨版本进**同一个提交** —— 不多出一条提交，也不会出现「版本涨了、
//       图还没跟上」的中间态。
//     · `publish.yml` 在发布前调 `--check`：号对不上就**硬失败**。宁可卡住一次
//       发布，也不把一张写着旧版本的 banner 发到 npm 上去。
//
// ── 约定：`id="version"` 是唯一的锚点 ──────────────────────────────────────
//   SVG 里版本号出现的位置写成 `<tspan id="version">1.3.7</tspan>`。
//   脚本只认这个标记，不认字面量 —— 以后改版式、换配色、挪位置都不会影响同步，
//   只要把那个 tspan 一起挪过去就行。
//
//   同理，替换**只动 tspan 中间那几个字节**，文件其余部分原样保留：SVG 是手写
//   的版式文件，脚本不该顺手把它重新排版一遍（那样每次都会产出巨大 diff）。
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   node .github/scripts/banner.mjs --write   # 写入 package.json 当前的版本号
//   node .github/scripts/banner.mjs --check   # 只比对，不一致时退出码 1
//
//   两个模式共用同一份「读版本号 → 找标记 → 替换」逻辑，所以 `--check` 判定的
//   就是 `--write` 会写出的结果，不存在两套口径对不上的可能。
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根目录：本文件在 `.github/scripts/` 下，往上两级。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const IMAGE_DIR = path.join(ROOT, 'docs', 'image')

// 匹配 `<tspan id="version">` 到 `</tspan>`：前后两段捕获原样保留，只替换中间。
// 用 `[^<]*` 而不是 `.+?`，是为了在 SVG 被换行/缩进弄坏时直接匹配不上、把问题
// 暴露出来，而不是悄悄吃掉半段标签。
const MARKER = /(<tspan id="version">)([^<]*)(<\/tspan>)/g
// 读当前值用的非全局正则：`match` 要拿到捕获组，且不能受 `g` 的 `lastIndex` 影响。
const CURRENT = /<tspan id="version">([^<]*)<\/tspan>/

const mode = process.argv.includes('--check') ? 'check' : 'write'

/** 退出前把要说的话分成「失败的」和「提醒的」，在 CI 日志里好认。 */
function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function warn(message) {
  console.warn(`::warning::${message}`)
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

// 版本号是这次同步的唯一来源，先把它本身检查干净：空串或非字符串会让整批 SVG
// 被写成 `v`，而且是在没有任何报错的情况下。
if (typeof version !== 'string' || version.trim() === '') {
  fail(`package.json 里的 version 不是有效字符串（读到 ${JSON.stringify(version)}），无法同步 banner`)
}

const entries = await readdir(IMAGE_DIR)
const svgs = entries.filter((name) => name.endsWith('.svg')).sort()

if (svgs.length === 0) {
  fail(`${path.relative(ROOT, IMAGE_DIR)} 下没有任何 SVG 横幅，同步无从谈起（目录是不是被改名了？）`)
}

/** 一次扫描的结果：哪些文件真的需要改，以及锚点还在不在。 */
const changed = []
const missingMarker = []

for (const name of svgs) {
  const file = path.join(IMAGE_DIR, name)
  const text = await readFile(file, 'utf8')

  const current = text.match(CURRENT)?.[1]
  if (current === undefined) {
    missingMarker.push(name)
    continue
  }
  if (current === version) continue

  // 只替换 tspan 中间那一段，文件其余字节原样保留。
  const next = text.replace(MARKER, (_, open, _value, close) => `${open}${version}${close}`)
  changed.push({ name, file, next, current })
}

if (missingMarker.length > 0) {
  // 不是硬失败：一个 SVG 里没有版本号是合理的（比如将来加一张纯 logo 的图）。
  // 但必须吭一声 —— 万一锚点是在改版式时被误删的，这里就是唯一的信号。
  warn(`${missingMarker.join('、')} 里没有 <tspan id="version"> 锚点，已跳过`)
}

// 全都没有锚点，就不是「跳过一两张图」了，而是这套机制已经失效：`--check` 会
// 永远通过，版本号再也没有人管。这种情况必须硬失败，不能退化成一条警告。
if (missingMarker.length === svgs.length) {
  fail('没有任何 SVG 带 <tspan id="version"> 锚点：版本号同步已经失效（锚点是不是被改名或删掉了？）')
}

if (changed.length === 0) {
  const where = svgs.filter((name) => !missingMarker.includes(name))
  console.log(`banner 已是最新：${where.join('、')} 都是 v${version}`)
  process.exit(0)
}

if (mode === 'check') {
  for (const item of changed) {
    console.error(`  ${item.name}: v${item.current} → 应为 v${version}`)
  }
  fail(
    `banner 里印的版本号与 package.json 的 v${version} 不一致 —— ` +
      `README 顶部会因此显示一个过期的版本号。运行 node .github/scripts/banner.mjs --write 修好后一起提交。`,
  )
}

for (const item of changed) {
  await writeFile(item.file, item.next, 'utf8')
  console.log(`已更新 ${item.name}：v${item.current} → v${version}`)
}

console.log(`::notice::banner 版本号已同步到 v${version}（${changed.length} 个文件）`)
