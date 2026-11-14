# `docs/test/` —— `test/` 的公开镜像

这里是仓库根 `test/` 目录里**适合随仓库公开**的那部分契约测试的镜像副本。

## 一、唯一可执行来源仍是 `test/`

仓库根的 `test/` 被 `.gitignore` 忽略（第 5 行那条 `test/`），只活在开发者本机。
改断言、加用例、修探针，**都在 `test/` 下做**；本目录是只读镜像，不承担「原始来源」的角色。

两份的差异**只有相对路径前缀**（加上 `repo-consistency.mjs` 的 `ROOT` 与三处对测试文件的引用）：

| 在 `test/` 里 | 在 `docs/test/` 里 |
| --- | --- |
| `from '../presets/...'` / `from '../lib/...'` | `from '../../presets/...'` / `from '../../lib/...'` |
| `path.join(here, '..', 'presets', ...)` | `path.join(here, '..', '..', 'presets', ...)` |
| `const ROOT = path.join(here, '..')` | `const ROOT = path.join(here, '..', '..')` |
| `path.join(ROOT, 'test', 'x.mjs')` | `path.join(ROOT, 'docs', 'test', 'x.mjs')` |

断言语义一字未改：镜像里没有为了让某条断言变绿而放宽任何判据。

## 二、为什么单独放一份

GitHub 上的读者拿不到 `test/`（它被忽略），于是这套契约测试——它们到底断言了什么、
断言了多少条——在仓库页面上完全不可见。把适合公开的部分镜像到这里，是为了：

1. 让读者能**直接读到**这套测试，而不是只看到文档里的一句「有测试」；
2. 让 CI 有机会直接跑（`node docs/test/xxx.mjs`），不必先恢复被忽略的目录。

## 三、哪些测试故意不在这里

| 文件 | 为什么不在 |
| --- | --- |
| `verify-interrupt.mjs` | **机器绑定**：递归扫 `~/.dsh/sessions/**/*.zstd`，别的机器上没有那些会话，必然失败 |
| `ptc-sdk-size.mjs` | **机器绑定**：硬编码 `G:\DSH\resources\app.asar`（本机 DSH 安装路径），并读同一份本地会话库；换机必然 `找不到 ...app.asar` |
| `measure-delegation.mjs`、`measure-tool-surface.mjs` | **一次性测量**：统计本机会话日志里的工具调用分布，结论已写进文档，脚本本身不是回归 |
| `_probe-guard-fanout.mjs`、`_probe-model-policies.mjs` | **一次性探针**：用来回答当时的某个具体问题，不是常驻用例 |
| `list-agents-probe.mjs` | **宿主机探针**：探 `list-agents` 那行在新/旧宿主上是否还在，结论依赖本机装的是哪版 DSH |
| `m13-mutation.mjs`、`m14-mutation.mjs`、`worker-guard-mutation.mjs`、`workspace-acl-guard-mutation.mjs` | **变异脚手架**：判别力验证的载具，要先把目标模块改坏才能跑，不是独立用例 |
| `ROUND-TEST-PROMPT.md` | 交给外部 agent 的一次性提示词，不是测试 |

## 四、怎么跑

逐条执行，没有统一的 `run-all`（本次刻意不做）：

```sh
node docs/test/repo-consistency.mjs
node docs/test/coordinator-prompt-contract.mjs
node docs/test/interrupt-before-send.mjs
node docs/test/subagent-watchdog.mjs
node docs/test/watchdog-settings.mjs
node docs/test/approval-wait-registry.mjs
node docs/test/approval-gate-rules.mjs
node docs/test/approval-gate-integration.mjs
node docs/test/worker-guard.mjs
node docs/test/minimal-guard-catalog.mjs
node docs/test/preset-dispatch.mjs
node docs/test/coordinator-guard-fanout.mjs
node docs/test/compaction-settings.mjs
node docs/test/guard-mode-isolation-regression.mjs
node docs/test/workspace-acl-rules.mjs
node docs/test/subagent-mode-marker-source.mjs
```

每条都应当 **exit 0**，末尾会打印自己的用例数/断言数。

⚠️ 其中几个会**先在 `presets/multitask/*.mjs` 上做原地改写、再在 `finally` 里改回来**
（`minimal-guard-catalog.mjs`、`subagent-mode-marker-source.mjs` 的反向验证段），进程被强杀时
可能留下改坏的模块。跑之前 `git status presets` 看一眼，跑完再看一眼。

`coordinator-guard-fanout.mjs` 另有 `--prove` 模式（默认不跑）：它要一份 `fixtures/` 里的
旧守卫快照，并会用 `git show` 从历史里重建。默认模式不需要 git。

## 五、和 npm 包的关系

`docs/test/` 是公开镜像，**不在 `package.json` 的 `files` 白名单里**，因此不入包。
`files` 末尾那条 `"!docs/test"` 只是把这条意图写进配置——`files` 是白名单，`docs/` 整体不在其中，
`docs/test/` 本来就不会被打进 tarball。

另一件事是 `.gitignore` 里紧随 `test/` 之后的那两行 `!docs/test/`、`!docs/test/**`：
`test/` 没有前导斜杠，git 会匹配**任意层级**的同名目录，于是新建的 `docs/test/` 也处在被忽略状态；
不加这两行例外，这个目录永远 `git add` 不进去。
