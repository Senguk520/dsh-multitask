/**
 * 算出这次该把 package.json 的版本号写到多少。
 *
 *   node .github/scripts/next-version.mjs <当前版本> <npm 上已发布的版本清单>
 *
 * 标准输出**一行**：该写进 package.json 的版本号（可能与当前版本相同）。
 * 出错时写 stderr 并以非零退出，方便 CI 直接当失败处理。
 *
 * ── 为什么要由 CI 独占版本号 ──────────────────────────────────────────────
 *
 * 多人协作时版本号是一份**共享状态**：谁在本地手改，谁就跟别人冲突，而且
 * 「我这边的号到底对不对」得靠每次开工前先拉一次才能确定。交给 CI 统一推进，
 * 协作者就只需要拉取，不必再关心这个文件。
 *
 * ── 推进规则（两条，都是为了不白白消耗版本号）──────────────────────────────
 *
 *   1. `当前版本 > npm 上最高的正式版` ⇒ **原样保留**，不推进。
 *      这表示有人显式指定了版本（例如要发 2.0.0 这种大版本），必须尊重。
 *      它还有一个副作用是想要的：一个**还没发布出去的**版本号可以跨多次提交
 *      复用 —— 于是「推 10 次代码」只会得到 1 次推进提交，而不是 10 次。
 *   2. 否则 ⇒ 取**最高正式版**的 patch + 1。
 *      基准用「npm 上最高的正式版」而不是「当前版本」，是为了兜住仓库落后于
 *      registry 的情况（例如有人回退了 package.json），保证新号一定大于已发布的一切。
 *
 * ── 为什么只看「正式版」────────────────────────────────────────────────────
 *
 * 带预发布后缀的版本（如 `2.0.0-beta.1`）不参与基准计算。否则「已发布里最高的是
 * 2.0.0-beta.1」会推出 2.0.1，把 2.0.0 这个正式号**跳过去** —— 显然不是本意。
 * 「一个正式版都还没发过」时同样原样保留当前版本，不去揣测该发什么。
 *
 * ⚠️ npm 的版本号是**永久**的：一旦发布，即使日后撤销，同一个号也不能再用
 * （见 npm 的 unpublish 政策）。所以这里宁可不推进，也不猜。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 解析一个语义化版本。
 *
 * @param text - 版本字符串。
 * @returns 拆好的四段；`prerelease` 在无后缀时是空数组。
 * @throws 不是合法的 `X.Y.Z[-预发布][+构建]` 时抛错。
 */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (match === null) throw new Error(`不是合法的语义化版本：${JSON.stringify(String(text))}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * 按 semver 的优先级规则比较两个版本。
 *
 * @param a - 解析后的版本。
 * @param b - 解析后的版本。
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b。
 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }

  // 预发布版本的优先级**低于**同号的正式版：1.0.0-alpha < 1.0.0。
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    // 前缀完全相同的一侧排在前面：1.0.0-alpha < 1.0.0-alpha.1。
    if (left === undefined) return -1
    if (right === undefined) return 1

    const leftIsNumber = /^\d+$/.test(left)
    const rightIsNumber = /^\d+$/.test(right)
    if (leftIsNumber && rightIsNumber) {
      const difference = Number(left) - Number(right)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    // 数字标识符的优先级低于字母标识符。
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * 按上方「推进规则」挑出这次要用的版本号。
 *
 * @param currentText - 当前 package.json 里的版本。
 * @param publishedList - npm 上已发布的全部版本（字符串数组）。
 * @returns 该写进 package.json 的版本号；与当前一致时即「不需要推进」。
 * @throws 当前版本非法时抛错。
 */
export function pickNextVersion(currentText, publishedList) {
  const current = parseVersion(currentText)
  const trimmedCurrent = String(currentText).trim()

  const stable = []
  for (const item of publishedList) {
    if (typeof item !== 'string') continue
    let parsed
    try {
      parsed = parseVersion(item)
    } catch {
      // registry 里出现解析不了的东西不该让整个流程停下 —— 跳过即可。
      continue
    }
    if (parsed.prerelease.length === 0) stable.push(parsed)
  }

  // 一个正式版都还没发过：当前版本就是待发版本，不去动它。
  if (stable.length === 0) return trimmedCurrent

  let base = stable[0]
  for (const version of stable) {
    if (compareVersions(version, base) > 0) base = version
  }

  // 已经有人把版本指到了已发布之上 —— 尊重它（可能是有意要发个大版本）。
  if (compareVersions(current, base) > 0) return trimmedCurrent

  return `${base.major}.${base.minor}.${base.patch + 1}`
}

/**
 * 从一个 packument（registry 上某包的完整元数据）里取出全部版本号。
 *
 * @param packument - registry 返回的 JSON。
 * @returns 版本字符串数组；字段形状不对时抛错。
 */
export function versionsFromPackument(packument) {
  if (packument === null || typeof packument !== 'object') {
    throw new Error(`registry 返回的不是一个对象：${JSON.stringify(packument)?.slice(0, 200)}`)
  }
  const versions = packument.versions
  if (versions === null || versions === undefined) return []
  if (typeof versions !== 'object') {
    throw new Error(`packument.versions 不是对象：${JSON.stringify(versions).slice(0, 200)}`)
  }
  return Object.keys(versions)
}

/**
 * 问 registry 要这个包已发布的全部版本。
 *
 * 之所以直接读 registry 而不调 `npm view`：
 *
 *   1. `npm view` 的输出是 JSON，若经 shell 传参会被**吞掉引号**（实测：`'["1.0.0"]'`
 *      变成 `[1.0.0]`，解析随即失败）。少一道转手就少一处能出错的地方。
 *   2. Windows 上 `npm` 是 `npm.cmd`，只能过 shell 启动，于是命令行里出现未转义的
 *      拼接参数 —— 而这一步在 CI 里是要**决定发什么版本号**的。
 *
 * 「包从未发布过」是**正常情况**，不是错误：registry 回 404，此时返回空数组，
 * 让上层按「尚无正式版」处理。
 *
 * @param packageName - 包名（支持 `@scope/name` 形式）。
 * @param registry - registry 基址。
 * @returns 已发布的版本字符串数组；从未发布过时为空数组。
 * @throws 网络或协议出错、且原因不是「包不存在」时抛错。
 */
export async function readPublishedVersions(packageName, registry = 'https://registry.npmjs.org') {
  // 作用域包的斜杠必须编码，否则会打到另一个路径上。
  const url = `${registry.replace(/\/+$/, '')}/${String(packageName).replace('/', '%2f')}`

  let response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    throw new Error(`访问 registry 失败（${url}）：${error.message}`)
  }

  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`registry 返回 ${response.status}（${url}）`)
  }

  return versionsFromPackument(await response.json())
}

/**
 * 直接执行时的入口：读 package.json、问 registry、打印该用的版本号。
 *
 * 用法：`node .github/scripts/next-version.mjs [package.json 所在目录]`
 */
async function main() {
  const root = path.resolve(process.argv[2] ?? '.')

  let manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    console.error(`读不出 ${path.join(root, 'package.json')}：${error.message}`)
    process.exit(2)
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    console.error('package.json 缺少 name 或 version')
    process.exit(2)
  }

  try {
    const published = await readPublishedVersions(manifest.name)
    console.log(pickNextVersion(manifest.version, published))
  } catch (error) {
    console.error(String(error.message))
    process.exit(2)
  }
}

// 被测试 import 时不要产生副作用，所以只在被直接执行时跑 main。
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) main()
