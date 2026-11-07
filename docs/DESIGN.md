# dsh-multitask — 设计说明

> 本文件只描述当前版本的设计与行为；历史、实测数字与更正记录另行维护，不并入本文。

> **这份文档不是 README。** 面向使用者的说明、安装步骤、设置面板与故障排查在仓库根的
> [`README.md`](../README.md)（英文）与 [`README.zh.md`](../README.zh.md)（中文）。
>
> 这里保存的是**开发与维护需要的另一类内容**：设计推导（「为什么必须这么写」）、
> 各项规则所依据的上游事实与失败取向，以及如实写出的已知边界与未确证项。
> 它描述**当前版本**的设计与行为 —— 某条规则此刻是什么、为什么成立、失效时怎样降级。
>
> 阅读顺序建议：先读 README 弄懂它是什么，再回到这里看它为什么成立。
> ⚠️ **测试套件的内容不在这份文档里** —— `test/` 不随仓库与发布物分发，写在这里读者也拿不到。

把 Cursor 的 **Multitask** 工作模式复现到 DSH。

**主对话只做三件事**：理解用户需求 → 翻译成任务书下发子代理 → 汇总子代理的结论。
读文件、跑命令、构建、搜索、调试 —— 一切过程性数据都在**子代理的上下文**里消化，
永不进入主对话。结果是主对话的上下文始终只包含高价值信息。

---

## 它到底做了什么

| | 主对话（协调者） | 子代理（worker） |
|---|---|---|
| 工具面 | **被机制性收窄**：只读核对 + 委派 + 结果回收 + 交互 | **完整**（含写文件、跑命令、构建） |
| 上下文 | 需求 + 任务书 + 结论 | 全部过程数据 |
| 职责 | 理解、翻译、下发、核对、汇报 | 干活 |

关键在于「**被机制性收窄**」这五个字。

只靠一段人格指令说「请你自己不要跑命令」是**软约束** —— 模型可能顺手就跑了。
本插件把这条纪律做成**硬机制**：协调者的 agent scope 上装一条工具限制，
把变更类与重噪音工具从它的可见面里摘掉。**工具不在，就调用不了，也就污染不了主上下文。**

---

## 安装

本包**零运行时依赖**（不 import 任何 npm 包），所以不需要 pnpm 装依赖树，
也不会往 `node_modules` 里塞第三方代码。

### 给使用者：装正式包

```
dsh plugin --profile <profile> add dsh-multitask
```

`--profile` 是个**选项，不能省** —— `dsh plugin add dsh-multitask` 会直接报
`error: required option '--profile <name>' not specified`。`<profile>` 是目标 profile 名
（桌面版应用自己那个叫 `desktop`；`~/.dsh/profiles/` 下有哪些目录就是哪些）。

装好后包落在该 profile 的 `node_modules` 下
（`~/.dsh/profiles/<profile>/node_modules/dsh-multitask/`），并且 DSH 会**自动**把
`dsh-multitask` 追加进该 profile 的 `dsh.profile.bundles` 层列表（依据是本包声明了
`dsh.bundle.patch` —— `runProfilePnpm()` 在 pnpm 成功后走 `reconcile()`，
「新装的 bundle 依赖自动启用」）。本包自带的 `cordis.patch.yml` 插入的是一行裸包名，
**不含任何绝对路径**，所以在任何机器、任何用户名、任何安装位置都成立。
**装完要重启应用** —— bundle 层在启动时组装。

> **桌面版（Electron）注意**：装之前请**完全退出应用** —— 上游 `requireDesktopProfile()`
> 的报错原文就是这么要求的（`... then fully quit it before running dsh plugin --profile desktop.`）。
> 理由是 pnpm 要重写 profile 的 `node_modules`，让应用占着里面的文件是有风险的。
> 另外，「拒绝 desktop」那条**只对从 npm 单独安装的 `dsh` 生效**：CLI 里的判据是
> `if (!manageDesktopProfile) rejectElectronProfile(...)`，而应用自带的启动器
> （`dsh.cmd` → `dsh-desktop-host`）会传 `manageDesktopProfile: true`，所以它**可以**
> 管理 desktop；从 npm 单独安装的 `dsh` 则会在这一步被拒。

### 给开发者：从源码 checkout 运行

clone 本仓库、直接跑工作区里的源码时用这条（改动不经过 npm）。在 profile 的
`cordis.patch.yml` 末尾**追加**一段，用**绝对** `file://` URL 指向你本地的入口：

```yaml
- insert:
    - id: multitask
      name: 'file:///你的绝对路径/dsh-multitask/lib/index.js'
```

两点注意：

- **路径里的空格与 `%` 必须百分号编码**（Windows 上尤其常见）。稳妥做法是让程序替你编码，
  而不是手写 —— 例如在 PowerShell 里：
  `(New-Object System.Uri('H:\my repo\dsh-multitask\lib\index.js')).AbsoluteUri`
  它会产出 `file:///H:/my%20repo/dsh-multitask/lib/index.js` 这种可直接粘进 YAML 的形式。
- **`?v=N` 是可选的缓存键**（见「改源码后如何生效」）。它只在 `file://` 这种方式下有意义。

卸载就是把这整段删掉，然后重启应用。

**装这一行不需要重启。** DSH 的 HMR 服务在 `cordis.patch.yml` 上装了 watcher，改动会被热重载。
装好后可以在插件列表里看到本行 `fiberPhase: "active"`。

> ⚠️ **这条免重启不适用于「改源码」。** 新增一行时该条目**没有 fiber**，Loader 走
> `await this.init()` 会真正 `import()`，所以免重启成立；而**改源码后递增一个已经在运行的
> 条目的 `?v=N`** 只改到它的 `name`，Loader 走的是 name-only 分支、**不重新加载** ——
> 那种情况**必须重启**。详见「改源码后如何生效」。

---

## 使用

**新建会话**时，在模式选择器里选 **「Multitask 减震器模式」**。

> preset 只能在**会话开始前**选择。会话已经开跑后切换会报 `agent-preset/locked` —— 这是
> DSH 的既有约束（工具面与提示词在首轮就冻结了），不是本插件的限制。

---

## 用法：把需求变成任务书

选中模式后，你正常提需求即可。协调者会把需求翻译成**自包含**的任务书下发给子代理。

它被指示让每份任务书都带上这八项：

1. **目标** —— 一句话，且结果可判定完成/未完成
2. **已核实的现状** —— 它已知的事实直接写进去，不让子代理重新发现一遍
3. **项目约定** —— 必须遵守的既有规则
4. **安全闸** —— 绝对不能碰的东西，并声明其优先级最高
5. **编号任务** —— 具体步骤，附确切命令或路径
6. **条件分支** —— 「若发现 X 则做 A，若 Y 则做 B」，免得它回来问已知的事
7. **停止条件** —— 什么情况下停下来汇报，而不是自己瞎猜着往下走
8. **回报格式** —— 要什么回来：做了什么、如何验证、什么没做完、哪些决策点属于你

互不依赖的任务会被**并行**下发，协调者一边等一边继续做事。

---

## 可调项

改 profile 的 patch 层即可调整，不需要碰本包源码。注意本行是 `insert:` 形状，
所以要按 **id 定位**来覆盖它的 `config`：

```yaml
# <profile 目录>/cordis.patch.yml
# 追加在 dsh-multitask 的 insert 块之后即可（同 id 的后者覆盖前者）。
- id: multitask
  config:
    presetId: multitask          # 想同时装多个变体时改这个
    order: 5                     # 模式选择器里的排序
    guardEnabled: true           # false = 关掉减震器（退回软约束，仅供排查）
    keep:                        # 追加到协调者保留集
      - web_search
      - web_fetch
    extraDeny:                   # 强制摘除（优先于保留集）
      - read
```

也可以用 `enabled: false` 整个关掉本插件（不声明 preset，模式从选择器消失）。

### 设置面板（本包唯一的客户端半：`lib/client.js`）

本包装好后，DSH 的「**设置**」里会多出一个一级页面「**Multitask**」（浏览器侧 bundle 是
`lib/client.js`，由 `package.json` 的 `dsh.client` 声明），以及「**通用设置**」里的两行。
它们把上面那些可调项里**真正值得手动改的**集中到一处，不用再去改 patch 文件：

**「Multitask」页 —— 两张卡片**

| 卡片 | 对应字段 | 作用范围 |
|---|---|---|
| 子代理使用的模型 | `multitask.subagentModels[]`（`subagentType` / `provider` / `model`） | 四类 worker **各自的默认模型**。「所有子代理使用同一个模型」选**是**时，四类一起写成同一条路线；选**否**时每类单独指定，「继承协调者」是默认项 |
| 子代理并行数量上限 | `subagent.maxActiveSubagents` | **与「设置 → 通用设置」里的那个值是同一个** —— 两处 UI 编辑同一个字段，所以改一处另一处立刻跟着变。它决定**同一主 Agent 下同时能存活多少个子代理**，对所有模式生效，Multitask 不例外。改完**即刻生效** |

**「通用设置」页 —— 两行**（与官方的语言 / 外观 / 开发者工具并排）

| 行 | 对应字段 | 作用范围 |
|---|---|---|
| 最大递归深度 | `subagent.maxDepth` | **宿主平面**：对所有模式生效，不只是 Multitask |
| 子代理并行数量上限 | `subagent.maxActiveSubagents` | 同上。**与 Multitask 页那张卡是同一个值** |

> 「最大递归深度」放在**通用设置**而不是本插件自己那一页，是因为它是**宿主平面**的、
> 对所有模式生效 —— 放进 Multitask 页会让人以为只对 Multitask 有效。那一槽是官方为
> 「不需要独立页面、只占一行的偏好」准备的座位（`settings.general.item`，官方用它放
> 语言 / 外观 / 开发者工具）。两行按官方那一段的行样式画（标题 + 说明在左、控件在右、
> 底部 0.5px 分隔线、上下 16px、**外面没有卡片**），所以并排时看不出接缝。
>
> ⚠️ **「子代理并行数量上限」这一项在**两处**同时出现，而且是有意的**：
> 「通用设置」里占一行（与官方的运行限制并排），「Multitask」页里也占一张卡
> （因为它是这个模式最常被调的一个数）。两处编辑的是**同一个字段**，
> 共用同一份表单快照与同一个写入路径 —— 所以不存在「哪一处说了算」的问题，
> 也不需要任何同步代码。
>
> 「保存」提交的是 `multitask` 命名空间里**唯一**的字段（`subagentModels[]`），
> 所以那条保存条**只服务模型卡**：并发上限是**改完即写**的（松开控件即提交，没有保存按钮）。
> 这与会说谎的做法相反 —— 若让一个即时生效的行去等一个保存按钮，用户会以为自己改的值
> 还没落地，而它其实早就生效了。
>
> 模型卡的**形态不落盘**，由字段自身推导：「所有子代理使用同一个模型」的形态由
> `subagentModels[]` 推导 —— 四类指向同一条路线即「是」，否则即「否」。切换形态本身
> 不产生脏值（没有值可写时保存按钮保持灰着），也不会在切换时静默改掉别的配置。
> **「不能设成 0」靠 UI 层与宿主侧共同保证**：数字框的下限是 1，而万一有非法值绕过了 UI
> （手改 YAML 等），宿主侧也会把它**收敛成 1**，绝不当作「不限制」。

> 之所以注册成 `settings.section`（设置导航里的一级页）而不是 `plugins.item`（侧栏「插件」页的
> 子槽）：后者按官方设计是给「在插件页里配置官方插件」用的，而这里的诉求是「在设置里、
> 新用户找得到」。理由与取舍写在 `lib/client.js` 的文件头。
>
> ⚠️ 改 `lib/client.js` 属于**改源码** —— 按「改源码后如何生效」一节，需要**重启应用**。

### 协调者默认保留什么

**保留**

- 只读核对：`read` `grep` `glob` `file_info`
- 委派：`subagent` `subagent_ptc` `subagent_minimal` `subagent_fork`
- 子代理控制：`send_message` `interrupt_agent` `list_agents`
- 结果回收：`job_list` `job_output` `job_kill`
- 编排：`workflow`
- 交互与自我管理：`ask_user_question` `todo_write` `create_goal` `get_goal` `update_goal` `exit_plan_mode` `present` `skill`

**摘除**（一切写入/执行/检索/管理类）

`write` `edit` `pwsh` `bash` · `web_search` `web_fetch` `read_image` ·
`ssh_*` · 任务板读写 · `plugin_manager` · `cordis_inspect_*` ·
`load_workspace_dependencies` · `task_board_*`

> 保留集是**白名单**，且 `deny = 当前可见集 − 保留集` 是每次动态算出来的。
> 所以宿主以后新增任何工具，**默认对协调者关闭**，不需要改这个包。
> 要开哪个，往 `keep` 里加一行即可。

#### 其中的 `file_info`：只读文件元数据工具

本包自带一个只读工具 `file_info`（`presets/multitask/file-info.mjs`，零 import）。
它补的是一个真实缺口（代号 **D5**）：`read` 只回内容与行数、**不回字节数**，
`glob` / `grep` 回的是匹配结果 —— 于是「这几个文件一共多大」这类核对**只能靠 shell**，
而协调者恰恰**没有** shell（被本包摘掉了）。`file_info` 收一组路径，
走 `ctx.fs.resolve()` + `ctx.fs.stat()`（与 `read` **同一道**受沙箱围栏的 seam，
只是不读内容、不写任何东西），一次报出各项字节数与**总字节数**。
大小未知时明确报「未知」且 `sizeBytes` 键**整个缺席**（不是 `0`）；
不存在 / 不可读 / 目录各自成类，绝不伪装成 0 字节文件。

它**不受**多模式开关（`DSH_MULTITASK_MULTI_MODE`）门控 —— 那个开关管的是 worker 三件套，
而 D5 的洞在单模式下一样存在。名字已进**两个**白名单：协调者的 `DEFAULT_KEEP`
与 minimal worker 的 `DEFAULT_MINIMAL_KEEP`（两个白名单都是**默认关闭**，
漏加一行不报错，只让该角色看不到它）。

> ⚠️ 以上是**机制事实**（源码 + 白名单两处都在位）。它在一个真实部署里是否真被注册、
> 协调者与 minimal worker 是否真能看到它，需要装机后核对 —— 这属于使用者的验证步骤，
> 不是本包能替你确认的事。

### 子代理模型：由你在设置面板里按 worker 类型决定

**默认继承协调者同模型**。想给某一类 worker 换个模型，去设置页「Multitask」的那张模型卡里
按类型指定（`subagent` / `subagent_fork` / `subagent_ptc` / `subagent_minimal` 各一行），
插件会把它翻译成该委派行的 `agentOptions`。

> ⚠️ **AI 不能临时指派模型。** 本包**刻意不启用**宿主那个
> `modelSelectionSettings` 开关（它会让委派工具公开 `provider` / `model` /
> `reasoning_effort` 三个字段与 `list_subagent_models`，让**协调者自己在某次调用里**
> 挑模型）。理由是两条路会互相打架：本包要的是「模型由用户按类型定」，而那个开关给的是
> 「模型由 AI 在会话里即兴定」。所以四行委派工具**都不设**它。
>
> 附带一个好处：那个开关会让委派工具改为**逐 agent 安装**，从而**结构上不可收窄** ——
> 不设它，四条委派工具回到全局注册，只读 worker 的收窄逻辑对它们也就正常生效了。

### 委派深度

固定为 **1**：协调者 → worker。worker 不能再往下派。
避免任务无限扩散，也避免上下文层级失控。

共有 **4 条委派行**：`subagent`（spawn）、`subagent_fork`（fork），
以及 `subagent_ptc`、`subagent_minimal`（后两条见下一节）。**四条全部声明 `maxDepth: 1`**。

四个进程内委派行**都显式声明** `maxDepth: 1`。向下派 depth 2 会被硬拒绝
（`subagent depth 2 exceeds maxDepth 1`），且拒绝发生在启动前。
显式写出该字段属于**可读性**考虑，它不承担安全职责。

> 残余边界：能确证的只是「有效上限 = 1」，**无法区分**这个上限来自行内声明的
> 字段、缺省继承的默认值，还是共享的上限强制层。这条残余边界对四条行同样适用。

想放开就改 `presets/multitask/composition.mjs` 里 `tool-subagent` 行的 `maxDepth`。

### 子代理并发上限

**只有一个值，就是宿主的 `subagent.maxActiveSubagents`。** 本插件不另设并发上限。

它在设置里出现在**两处**（「设置 → Multitask」的卡片，与「设置 → 通用设置」的一行），
但两处编辑的是**同一个字段**：改一处另一处立刻跟着变。改完**即刻生效**。

#### 8 是宿主的**默认值**，不是天花板

宿主 `subagent.maxActiveSubagents` 的默认值是 **8**，所以**不做任何配置时，8 就是你能拿到的全部**。
一次**并行**扇出超过这个数时，多出来的委派**在启动之前**被丢弃，错误原文**逐字**如下：

```
Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
```

它对应宿主 `dsh-subagent` 的 `ACTIVATION_LIMIT_REACHED`（名额不足时在
`ActivationPool.reserve()` 里抛出）。

⚠️ **但 8 不是上界，只是没人改过的默认值**（上界是安全整数）。**写的是多少，上限就是多少** ——
而因为你设的**就是**宿主的那个字段，所以不存在「还有另一层在截你」这回事：

| 想跑多少 | 怎么做 |
|---|---|
| N 个 | 把「子代理并行数量上限」设成 `N`（设置里两处任选一处，或 profile 里给 `- id: subagent` 加 `config: maxActiveSubagents: N`） |

> **判断并行还是串行，看同一时刻处于 `[running]` 的子代理个数，而不是「一共派出去几个」。**
> 串行执行时一次只跑 1 个、等它结束再派下一个，活跃数从未超过 1 —— 于是「派 10 个全都成功了」
> 并不证明上限被放宽：只有**同一条消息里并行下发**才会真的去抢名额，串行跑多少个都不会撞上限。

#### 计数口径：**当前存活的全部**，不只是同一批发起的

上限按「同一主 Agent 下**当前存活**的子代理总数」计。一个已经交完活、但**还没退出**的
worker **仍然占着名额**。所以「派一批 → 等它们全部结束 → 再派下一批」才是安全的做法；
在一批还没结束时接着派，会按剩余的存活数提前撞上限。

#### ⚠️ 拒绝是**宿主的**，不是本插件的

因为执行点只有一个，撞上限时你看到的就是上面那条**英文**错误（`active child limit: <N>`），
而不是本插件的任何文案。**这不是故障**，也**不是本插件坏了**：

- 它发生在**任何东西被启动之前** —— 没有子代理被创建，你拿到的是一条普通错误而不是一个 id；
- 处理办法是**等现有的子代理结束**，或**把若干任务并进一份任务书**交给一个子代理完成；
- 原样重试同一批扇出只会再撞一次。

---

## 多模式子代理：按任务类型挑 worker

前面的「减震器」解决的是**协调者不该自己动手**。这一节解决另一半：
**该派哪种 worker 出去**。

### 三种 worker，三种工具面

| 委派工具 | 工具面 | 适合什么任务 |
|---|---|---|
| `subagent` | **完整**：写文件、跑命令、构建、搜索…… | 默认。写代码、跑测试、改文件、执行类任务 |
| `subagent_ptc` | **PTC 塌缩**：只能直呼 `run_code`，其余一切在程序里经生成的 SDK 调用 | 程序化批量处理：海量数据过滤/聚合/搬运、需要对很多项做同一件事、中转数据不该进上下文 |
| `subagent_minimal` | **只读**：摘掉 `write` / `edit` / `pwsh`（win32） | 只读调研、快速问答、核查事实、读代码回答问题 |

`subagent_fork` 不属于这个维度：它的区分点是**继承本对话上下文**，与工具面正交，
所以它没有对应的第三种工具面变体。

> 上表的「适合什么任务」是**机制事实**；**按任务挑 worker** 的选择指引写在
> 协调者人格（`composition.mjs` 的 `COORDINATOR_PERSONA`，小节
> `## Choosing which worker to delegate to`）里，判据是**任务的形状**而不是主题。
>
> ⚠️ **人格里刻意不含「拿不准就用 `subagent`」这类默认回退。** 那样的默认答案是一句
> **指令**，模型每次拿不准时都被它推向最宽的那条路，于是「按形状挑」的整段说明被它抵消掉。
>
> 替代写法是「每次都要回答哪个更合适」，而不是给一个默认答案。测试从两个方向钉住它：
> 正向钉住「按形状挑」的四条判据、反向钉住那句默认回退不许回来，并且把两份 README 的
> 同一句话也纳入 —— 人格与 README 必须同时改，否则读者会按那句默认回退写任务书。

### 机制

两条多模式路径走的是**两套完全不同的机制**：

- **`subagent_minimal` —— 本包的自适应收窄（`minimal-guard.mjs`）。**
  在 `agent/created` 时按 `deny = 可见集 − 允许集` 收窄，名单里每个名字都必然存在于
  该 scope 的实际可见面，所以不会抛错；别的插件注册进来的写入类工具
  （典型是 `ssh_*` 里的 `ssh_exec`、`task_board_*` 里的 `task_board_run`）也一并被摘，
  而且不需要预先知道它们的名字。人格说只读、机制也做到了只读。

  > ⚠️ **这里只有上面这一层收窄。** 静态名单只能列出几个确定存在的名字，这一层覆盖的
  > 面更宽，但**失败后果不同**：本模块装不上时没有兜底，minimal worker 就是完全不收窄。
  > 因此它的失败一律**响亮告警**，并带 `MINIMAL-NARROW-SKIPPED reason=…`。

- **`subagent_ptc` —— `presentAs('ptc')`（本包插件 `subagent-mode.mjs`）。**
  PTC 不是「筛掉一些工具」，而是**换一套呈现方式**：整张工具面塌缩成
  「只可直呼 `run_code`」，其余端能力工具都从程序里经生成的 SDK 到达。
  这个能力**无法用工具筛选模拟**（`run_code` 是保留传输名，
  `tools.restrict()` 明确拒绝它），所以必须由插件实现。

协调者要能看见这两个多模式工具名，靠的是 composition 里给减震器那行传的 `keep`
（保留集是**白名单**，`deny = 可见集 − 保留集`；不写进去新工具默认对协调者不可见）。

### PTC 塌缩的可观测标识（**可 grep 的固定串**）

PTC 塌缩**装不上时安静降级**（worker 保留原生工具面，仍能干活），而它的告警走
`warnOnce` —— **每种原因每进程只报一次**，所以「某一刻是否又跳过了」不能靠日志行数判断。
每条失败路径与成功路径都带一个**逐字固定的 ASCII 标识**，共用 `PTC-COLLAPSE-` 前缀，
一条 grep 就能同时看到「跳过的」与「生效的」：

| 标识 | 级别 | 含义 |
|---|---|---|
| `PTC-COLLAPSE-SKIPPED reason=no-runtime` | warn（去重）+ info（计数） | 本部署没有 `ptcRuntime` 服务 |
| `PTC-COLLAPSE-SKIPPED reason=no-present-as` | 同上 | 该 scope 没有 `tools.presentAs()` |
| `PTC-COLLAPSE-SKIPPED reason=present-as-threw` | 同上 | 声明被拒绝（通常是已声明过别的呈现） |
| `PTC-COLLAPSE-SKIPPED … count=N` | info | 每次跳过另记一条**带累计数**的行 |
| `PTC-COLLAPSE-ENGAGED` | info | 塌缩**确实生效** |

> **成功路径同样留标识**：否则只能靠「失败标识没出现」反推成功，而那个判据对
> 「整段代码根本没跑到」不成立。

⚠️ **正常运行时没有可读的宿主日志**（宿主 stdout 直连 Electron、stderr 只在内存里留
64 KiB），所以这些串是给**能取到进程输出的人**（或以后接入日志时）用的判据，
普通用户不需要去找日志。

### 模式标记是怎么被子代理之外的代码读到的

插件要回答「刚创建的子代理来自哪一行」，读的是 `subagent/descriptor` 的 `provider` 字段。

`dsh-tool-subagent` 的 Config 里能区分委派行的字段是 provider / toolName /
modelSelectionSettings / agentOptions / agentPreset / allowedAgentPresets / maxDepth。
其中只有 `provider` 同时满足三个条件：

1. 由**委派行**决定（不是模型传的参数）；
2. 原样写进 `subagent/descriptor`（`data.provider`），因而在 `agent/created` 窗口读得到；
3. 同一个实现可以注册多个名字，所以每类 worker 各占一个。

四条委派行因此各绑一个 provider 名：`spawn` / `fork` / `multitask_ptc` /
`multitask_minimal`。前两个用宿主内置的（主路径不冒额外注册失败的险），后两个由本包
在**宿主平面**注册（`lib/worker-providers.js`），注册不上时那两个工具**根本不出现**，
模式降级成「只有两条委派路径」而不是抛错。

`toolName` 虽然也按行而异，但**不落进子代理会话**（descriptor 里没有它），所以不能当标记。

**为什么不能读 `persona` 标记：** 上游删除了 `persona` 与 `toolFilter` 两个配置项，
配置里出现即抛

```
tool-subagent: persona is no longer supported; configure persona and tool plugins
in an Agent Preset and select it with agentPreset (spawn only)
```

**后果不是「人格不生效」，而是整个 preset 挂载失败** —— 模式从新会话列表里彻底消失。
`provider` 是这里剩下的唯一位点：读法只有一步、不依赖任何未文档化结构，且
**前台派单与后台派单没有覆盖差异**（descriptor 在 `setup()` 里 append，`agent/created`
必晚于它）。

**人格的投送方式：** 人格由 `worker-persona.mjs` 在 `agent/created` 窗口按 provider 名
注册到子代理自己的 scope 上（同一个段落名 `deployment:persona-prefix`，scope 层叠规则
不变，照样盖掉协调者那份）。人格文本通过 `config.personas` 从 composition 传入，
不走 import —— 相对 import 不继承入口的 `?v=N` query，改了文本会从旧缓存取回旧内容且不报错。

**旧会话兼容：** 更早版本创建的会话，descriptor 里的 provider 是通用名，不带
`multitask_ptc` / `multitask_minimal`；这些会话在 persona 里留着
`[multitask-mode:ptc]` / `[multitask-mode:minimal]` 标记。两个守卫因此各保留一条
**只读**旧标记的兜底路径：`provider` 给不出结论时回退到 persona 标记，让续接这类会话
时不至于丢掉收窄 / 塌缩。

> **这两个 provider 名是排他的。** 一旦读到 `multitask_ptc` / `multitask_minimal`，
> 它就是该子代理的最终身份，残留的旧标记不会再推翻它。少了这一条，一个 PTC worker 只要
> descriptor 里带着旧 minimal 标记就会被当成只读 worker 收窄 —— 那是把它的工具面削掉，
> 且完全静默。`test/subagent-mode-marker-source.mjs` 的 L3 用例锁的正是这一点。

### 怎么关掉

三级开关，默认全开；**关任何一级都不影响 `subagent` / `subagent_fork`**：

1. **环境变量** —— 一次停用两条多模式行与呈现插件：

   ```powershell
   $env:DSH_MULTITASK_MULTI_MODE = '0'   # 需要重启应用（模块加载时读取）
   ```

   之所以用环境变量而不是 config 字段：profile patch 只能按 id 覆盖 roster 里
   **已存在**的行，够不到 preset 声明内部的这些行。

2. **删行或禁用行** —— 改 `presets/multitask/composition.mjs`，给
   `tool-subagent-ptc` / `tool-subagent-minimal` 加 `disabled: true`。
   改源码**必须重启应用**才会重新加载；习惯上同时递增 profile patch 里的 `?v=N`
   （只递增不重启**无效**，见「改源码后如何生效」）。

3. **只关 PTC 呈现、保留 `subagent_ptc` 工具** —— 把 `subagent-mode` 那行的
   `config.enabled` 改成 `false`。关掉后 `subagent_ptc` 仍可用，
   只是退化成与 `subagent` 同样的原生工具面。

### ⚠️ 给未来维护者：改 minimal 的允许集必须小心

`tools.restrict()` 对**当前部署不存在**的工具名**会抛错**：

```
tools.restrict() names unknown global tool "x"; known global tools: …
```

这正是 `minimal-guard.mjs` 用 `deny = 可见集 − 允许集`、而不用静态 deny 名单的原因：
名单里的名字取自**刚读出来的可见面**，必然合法，所以那条错误路径不会被走到。

> **`DEFAULT_MINIMAL_KEEP` 是允许集（白名单）。** 多列一个本部署没有的名字是**安全的**
> （它不在可见集里，算差集时不参与），但**少列**一个该保留的名字就会把它摘掉。

**`run_code` 不能出现在 `deny` 里**（保留传输名，`restrict()` 拒绝它），
代码里由 `CATALOG_EXEMPT` 兜住。

### 已知边界与未确证项

如实列出，避免把推断当结论：

- **「PTC 对推理质量的实际增益」是一个待验证的设计假设。** 不同工具面可能影响推理表现，
  本包只把机制搭好；要判定它是否成立，需要用真实任务对比 `subagent` 与 `subagent_ptc` 的效果。
- **`agent/created` 是否严格早于子代理首次 prompt 组装：源码推断成立，尚缺端到端验证。**
  `coordinator-guard` 依赖同一个时机，且它的失败取向是显式告警；
  PTC 呈现这一条则没有端到端验证，失效时安静降级。
- **PTC 呈现链路需要一次真实会话才能确认。** 进程内可以验证的是：模块零依赖可加载，
  逻辑在替身 ctx 上正确（判据包括「协调者绝不塌缩」「无运行时则安静跳过」）。
  **真实子代理是否真的塌缩成 `run_code`，只能在装机后核对。**
- **PTC 运行时是否存在只能在运行时判定。** 插件用 `ctx.get('ptcRuntime')` 探测，
  缺失时**安静跳过**并告警（worker 保留原生工具面，仍能干活）。
  若日志里出现 `a subagent was configured for "ptc" presentation, but this deployment
  has no "ptcRuntime" service`，就是这种情况。
- **纯 PTC 模式下子代理不能直呼 `write` / `pwsh`**，只能经 `run_code` 里的 SDK 调用。
  这是 PTC 语义本身（通告面 = 可调用面），**不是缺陷**；直呼会得到
  `Error: unknown tool "<名字>": only run_code is callable directly — call <名字> from inside a run_code program instead`
  （原文如此：小写的 `unknown tool`）。
- **`subagent_minimal` 的只读性是「一层自适应收窄」，仍然不是沙箱。**
  `minimal-guard.mjs` 在 `agent/created` 时按 `deny = 可见集 − 允许集` 收窄，覆盖
  `write` / `edit` / `pwsh` 以及 `ssh_*` / `task_board_*` 这类**由别的插件注册**的工具。
  它**没有第二层兜底**：静态 `toolFilter` 那层已不存在，所以本模块装不上时
  minimal worker 完全不收窄（会响亮告警）。
  **它终究不是沙箱**：若某个插件在 minimal worker 创建**之后**才注册一个新的变更类工具，
  那个工具**不会被摘掉**（有意取舍，见 `minimal-guard.mjs` 文件头「如实写出的边界」）。
- **全工具面 worker 的底噪里有一块纯浪费，`worker-guard.mjs` 专门摘它。**
  委派深度固定为 1，worker 再往下派一律被拒（逐字 `Error: subagent depth 2 exceeds maxDepth 1`），
  但拒绝发生在**调用之后**。在那之前，5 个委派工具的完整 schema 一直挂在 worker 目录里，
  跟着**每一次请求**重发。经验数据：约八成 worker 的目录里挂着这 5 个用不上的委派工具，
  合计 **6,266 字符**，占全工具面 worker 底噪（52,445 字符）的 **11.9%**；同时观测到
  **184 次** `depth 2 exceeds maxDepth 1` 的拒绝 —— 它们确实不可用。
  本模块把「黑名单 ∩ 可见集」下发为 deny，**不损失任何能力**（判据是「调用必然被拒」，
  不是「看起来没用」：`interrupt_agent` / `send_message` / `list_agents` 刻意**不摘**）。
  失败取向与 minimal-guard **相反** —— 它失败最坏是那块 schema 继续重发，功能一件不少，
  所以静默降级、只记一条告警。

  ⚠️ **它对 PTC 同样有效，而且是收益最大的一条路径。** 与全工具面 worker 相比，
  省下 **6,303 字符 ≈10.3%** —— 两者的差异只在那 5 个委派工具，其余 roster 相同。
  机理是：PTC 的 SDK 文档由 `sdkSchemas(scope)` 生成，而它读的是 `view(scope).visible`；
  `restrict()` 把限制挂在该 agent 自己的 layer 上，`chainLayers()` 会读这一层。
  所以 `presentAs('ptc')` 塌缩不省它（塌缩只改「能不能直接调」），
  **`restrict()` 才省它**。

---

## 委派底噪的构成（实测）

`request/header` 是**每一次请求**重发的那份固定底噪；按 agent 类型取首个 header，构成如下：

| 类型 | 工具数 | tools 字符 | system 字符 | 合计 |
|---|---|---|---|---|
| `subagent_minimal` | 10 | 5,719 | 7,870 | 13,589 |
| `subagent` / `subagent_fork`（全工具面） | 50 | ~42,600 | ~9,700 | ~52,300 |
| `subagent_ptc`（已塌缩） | **1** | 2,496 | **61,057** | **63,553** |

**PTC 塌缩后反而最贵**：它的 `tools` 确实降到 1 项，但 `system` 里多出一节
`## Writing code for run_code` 独占 **49,551 字符 / 885 行**（人格本体只有 10,049 字符）。
也就是说 `presentAs('ptc')` 改的是「能不能调」，**没有**改「要不要读」。
四类里 `subagent_minimal` 最便宜，这是它值得作为纯读任务默认选择的可量化理由。

全工具面 worker 的 schema 来源（55 份样本，合计 52,445 字符）：

| 来源 | 工具数 | 字符 | 占比 |
|---|---|---|---|
| 插件 `task_board_*` | 17 | 20,244 | 38.6% |
| 内置核心 | 20 | 17,991 | 34.3% |
| 委派工具（`worker-guard` 已摘） | 5 | 6,266 | 11.9% |
| 插件 `ssh_*` | 6 | 4,039 | 7.7% |
| 目标跟踪 / 子代理控制 / 计划模式 | 7 | 3,905 | 7.4% |

> **底噪不累积，是「轮数 × 常量」。** 同一 worker 的每步上下文增量中位数约 1,278 tokens，
> 所以省底噪的收益随轮数放大，而「会话变得更大」这个体感更多来自轮数而不是单条消息。

### ⚠️ 那两块插件工具**不要动**（用户已明确决定）

上表里 `task_board_*`（17 个）与 `ssh_*`（6 个）合计占 schema 的 **46%**，是最值得砍的
一块。**结论是不砍 —— 这是用户的决定，不是遗漏。** 依据如下：

- **它们由别的插件提供，配置归属那个插件。** 在主配置里把 `web-ui-ssh` 那一行改成
  `disabled: true` **会禁用整个插件行，不只是摘掉工具**：那个插件自己的 UI 与功能会
  一起消失。工具只是外观，插件是功能，两者不是一回事。
- **`task_board` 并非零调用。** 全量扫描（816 个会话、不排除任何模式）记录到 23 次调用，
  集中在 1 个会话 —— 它属于「偶尔在用」，砍掉会损失真实功能。
- **`ssh` 确实零配置零调用**（`~/.dsh/dsh-ssh.json` 不存在，6 个 `ssh_*` 里
  `ssh_list` 6 次、`ssh_exec` 1 次），但同上一条：关它的代价是整个插件消失，
  而省下的是每次请求 4,039 字符。用户判断不划算。

**能动的只有本插件自己注册的工具。** 这一步由 `worker-guard` 完成：摘掉 5 个
委派工具（6,266 字符），对 PTC 的 SDK 文档也生效，省 6,303 字符。

> 这条边界比数字重要：**「谁注册的，谁才有权收窄」**。跨插件去摘工具，看起来省了
> token，实际是在拆别人的功能骨架。

---

## 子代理危险操作的弹窗批准（`approval-gate.mjs`）

**是什么**：给委派出去的子代理补回一层「危险操作要问人」的闸门，卡片显示在**父会话**里，
用宿主现成的审批面板。

### 它解决什么问题

Multitask 模式里**实际干活的全是子代理**，而 `dsh-subagent` 在委派窗口里把子会话的
审批策略**钉死为 `never`**（上游注释逐字：`policy is pinned to 'never' regardless of the
parent's own policy.`）。后果是两级失效，**用户收不到子代理的审批请求**：

1. 审批服务的 `decide()` **第一行**就是
   `if (effectivePolicy(session) === 'never') return 'rejected'` —— 早于瀑布派发，
   所以 Web 端的审批应答者根本不会被调用；
2. 子代理的 system prompt 里还有一句
   `operations that require approval are rejected automatically`，
   于是模型**自我审查**、连请求都不发起。

本模块同时处理这两点，构成**两级闸门**：

| 级别 | 做什么 | 在哪实现 |
|---|---|---|
| 第一级 | 安全命令直接执行，**不打扰用户** | 本模块的确定性规则表（`tools/pre-execute`） |
| 第二级 | 危险命令弹窗，由用户批准 / 拒绝 | 本模块的转呈（`approval/request`）+ **上游现成的审批面板** |

### 为什么不新建审批 UI（这一条决定了整个设计）

审批面板挂在 `conversation.composer` 上，而它只为**当前正在显示的那个会话**渲染：

```js
const pendingInteraction = useSessionStatus((snapshot) =>
  sessionId === undefined ? undefined : snapshot.get(sessionId)?.pendingInteraction)
```

子代理会话在侧边栏**被隐藏**（`if (session.origin === "subagent") return false`），
父行也**不聚合**子会话的待审状态。所以「让子会话自己弹窗」在后端与前端都不成立 ——
除非用户正好打开了那个子会话。

本模块因此采取**转呈**：子代理的请求被改写成一次**面向父会话**的审批请求，
于是它落在主对话里，用上游现成的面板显示。**不新增任何 UI、不碰沙箱、不碰 DSH 源码。**

### 三个动作（以及它们各自的地基）

**① 放开策略（B）。** 在 `agent/created` 里往子会话追加一条 `approval/policy = 'ask'`。

成立的地基是两条上游事实，都已逐行核实：

- `overrideOf(session)` **倒序**扫描日志、命中即返回 ⇒ **后写覆盖先写**；
- `agent/created` **必然晚于**委派钉死 —— 上游 `initializeAgent` 是**先 `await setup()`
  再 `publish()`**，而钉死发生在 `setup` 里。时序没有竞态窗口。

⚠️ 写入时**省略 `source` 字段**。理由与校验无关：运行期**完全不校验** `source`
（唯一的校验是词表 `policy ∈ ["ask","never"]`）；`'delegation'` 只是 v0/v1 迁移期的取值约束，
当前会话格式是 v4，带上它既不会抛错、也不表示任何事。省略的真实理由是**语义**：
`source: 'delegation'` 的意思是「这个值从父级委派继承而来」，而本模块做的恰恰是**纠正**
委派的钉死（父级写 `never`，这里写 `ask`），带上就是说反话。

**这条写入跨重启存活**，不需要恢复路径。载入期只丢弃「最后一条没有换行的**不完整**记录」
（torn tail），与事件是否在回合内无关；而 `approval/policy` **不在**任何回合包含校验里
（只有 `approval/asked` / `approval/decided` 要求回合归属）。可观测的判据是日志序列：
宿主钉死的 `{"policy":"never","source":"delegation"}` 紧跟本插件写的 `{"policy":"ask"}`，
两条都落在第一个 `turn/start` 之前。

⚠️ 这条写入**会落进会话日志** —— 那是 `overrideOf` 唯一能读到的地方（策略不能写 session
header，那会抛 `session header uses retired policy baseline fields`）。

**不**调上游的 `setPolicy(agent, 'ask')` 是因为它会 inject 一条
`The approval policy changed from "never" to "ask" (changed by the user).` ——
**措辞不实**（改的是插件，不是用户），而那条消息会进会话日志、被模型当作用户意图读。
改策略后模型怎么知道？**上游自己会说**：它注册的 runtime context 按当前有效策略渲染，
策略一改，下一次组装就自动变成 `Approval policy: ask. …`。

**② 纠正那句误导性提示。** 上游把委派上下文注册在**子代理自己的 ctx 层**上，
文本里含 `operations that require approval are rejected automatically`。
只要这句还在，模型就会自我审查、不去发起需要审批的调用 —— 于是第二级永远等不到请求。

**不能**用「再注册一个同名 context」覆盖它：同层重名直接抛错
（`prompt context "…" is already registered in this scope`），而 `context()` 只做
**跨层遮蔽**（scoped 遮蔽 global），本模块的层在子代理层之上、注册同名条目只会被遮蔽。
所以改写走 `system-prompt/assemble` 瀑布，在**组装结果**上替换那一条。

触发条件刻意是**内容**而不是只有名字：只有文本里确实含那句原话时才改写，否则原样返回并
记一条 `reason=context-wording-changed` 的 warn —— 上游改了措辞时我们**不猜**，
宁可少改一次也不写错话。

**③ 两级分流与转呈。** 见下两节。

### 第一级：确定性规则，不是 Auto 审查

官方 Auto 预设的规格是 `{ sandbox: 'danger-full-access', approval: 'ask' }` ——
**启用它会关掉文件沙箱**（上游文档逐字：`Auto provides no file sandbox`），
而且每次调用多一次 LLM 请求、无缓存。那是拆安全机制，不是加闸门。

所以第一级**只有确定性模式匹配**：无额外模型请求、无沙箱变更、行为可预测。

**它补的是沙箱表达不了的那一类**（这是本级的真正价值）：

| 类别 | 为什么沙箱拦不住 |
|---|---|
| 工作区**之内**的破坏性命令 | 沙箱对工作区内的写入是**允许**的 —— `rm -rf .`、`git reset --hard`、`git clean -fd` 都在这一类 |
| 非文件类危险 | 沙箱完全不表达：`git push --force`、`npm publish`、`curl \| bash`、`sudo`、改执行策略、杀进程、改计划任务 |
| 往工作区**之外**写 | 会被沙箱拒绝，但拒绝发生在执行时；本级把它提前变成一次询问 |

**失败方向是安全的**：漏判一条模式 = 与「没有本模块」完全一样（命令照旧在沙箱下执行），
**不会放宽任何东西**。所以本级只可能**增加**一次询问，绝不可能减少保护。

反过来说，**误报是它真正的风险**：每次无谓的询问都会让用户向「无脑点允许」靠一点。
所以规则表是**成对**维护的：既有一张「必问」清单，也有一张「必放行」清单，改正则时两边一起跑。
刻意不问的例子：`git clean -nd`（干跑）、`chmod +x`、`chown user:user f`（日常）、
`net user` / `wmic process list`（只读列举）、`ls /`、`cat /etc/hosts`（只读）、
**`icacls <路径>`（不带变更开关时只是显示权限）**。

> ⚠️ **最后那条的判据是「有没有变更开关」。** `icacls` 只在**出现变更开关**
> （`/grant` `/deny` `/remove` `/setowner` `/reset` `/inheritance` `/g` `/p` …）时
> 才算危险，而 `takeown` 仍然一律问。

**覆盖到 PTC 程序内部**：`run_code` 的桥在派发子调用时构造的输入带 `parent` 令牌，
而它走的就是 `scheduler.prepare` → `prepareExecution` —— 后者第一件事就是跑
`tools/pre-execute` 瀑布。所以 PTC 程序里经 SDK 发起的 `pwsh` / `write` **同样**过规则表。
链路逐段为：桥构造带 `parent: exec.token` 的输入 → `scheduler.prepare` → 调度器对象
→ `prepareScheduledExecution` → `tools/pre-execute` 瀑布。

⚠️ 有两条路径**不走**审查，本级并不全覆盖。上游 Auto 的文档把这两类与「内层工具调用」
区分得很清楚，逐字为：

> The outer `run_code` transport and direct Node effects inside a PTC program do not pass
> through inner-tool review.

也就是：

1. **外层 `run_code` 传输本身** —— 它自己是那次 PTC 运行的入口，不是「内层调用」；
2. **PTC 程序体内直连 Node 的效果**（`require('fs').writeFileSync`、`child_process.exec`、
   直接 `fetch` 等）—— 它们根本不是工具调用，规则表没有任何机会看到它们。**那里只剩沙箱这一层。**

旁证：官方 Auto 的守卫正是按同一条界线切的 —— 它的第一行对「外层 `run_code`」直接放行
（`exec.parent === void 0 && exec.name === RUN_CODE_NAME` 就跳过），而带 `parent` 的内层调用
才会进入审查。本模块与它覆盖的是同一个集合。

还有一条与审计无关但容易混淆的：`run_code` **自身**不带 `sandbox_permissions` 时不由本模块过问；
带提权时走的是沙箱自己的 `approveEscalation`（它自己发一条审批请求，与本模块无关）。

### 第二级：转呈给父会话

`approval/request` 是公开瀑布，Web 应答者是通过 `ctx.remote.$on('approval/request')`
注册的**转发**监听器。本模块注册时带 `{ prepend: true }` —— 这是**必须**的：
排在转发者后面的话，请求已经发给浏览器、面板已经为（不可见的）子会话渲染了，再改也来不及。

多级委派（子代理又委派了子代理）时，本模块**一次走到根**（沿 `parentSession` 上溯，
带迭代上限防畸形父链成环），而不是逐级转呈 —— 用户本来就该在根会话里裁决。

**转呈失败时退回原路径**（父会话此刻没有打开回合、父会话已结束、服务缺失…）：
交回下游，由上游按老样子处理，最坏结果是 fail-closed 的 `unavailable`，
并记一条 `MULTITASK-APPROVAL-RELAY-FAILED`。**绝不**因为转呈不了就把一次拒绝变成放行。

### 门控：只在交互式会话启用（红线）

**父会话**的有效策略必须是 `ask`，否则本模块**一个字都不动**：
子代理保持 `never`，与没有本模块时**逐字等价**。headless / 无人值守部署靠 `never`
保证「不会被挂住等一个永远不来的答复」，本模块绝不把 `ask` 装到那种环境上。

同样地，第一级也读**子代理当前的有效策略**：策略不是 `ask` 时一律放行、绝不返回 `ask` ——
因为那时返回 `ask` 只会被 `decide()` 的第一行判成 `rejected`，**会把一条原本能在沙箱里
正常跑完的命令变成拒绝**，比不问更糟。

### 怎么确认它生效了

两条观测通道，只有第一条落盘。

#### 证据一：持久事件（唯一跨重启存活的通道）

闸门的每一次询问都会在**会话日志**里留下一条 `approval/asked`，用户的答复留下
`approval/decided`。三类询问的 `reason` 前缀彼此不同，因此**一条 grep 就能把它们分开**：

| `approval/asked` 的 `reason` 以什么开头 | 是谁在问 |
|---|---|
| `Multitask approval gate flagged a destructive shell command (…): …` | **第一级**：规则表判定危险（或往工作区外写时是 `a write outside the workspace`） |
| `Multitask approval gate: a delegated Subagent (……) asked to run "…"` | **第二级**：把子代理的请求转呈给了父会话 |
| `Auto review denied tool "…": …` | **自动审查（EXP）**自己拒绝，本模块未插手 |

`approval/decided` 的 `outcome` 是 `allowed-once` / `rejected` / `cancelled` 三者之一 ——
没有「永久允许」这一档。

⚠️ **`session.v4.jsonl.zstd` 是多帧拼接的**，直接整文件解压只解第一帧。要按 `0x28B52FFD`
魔数切帧后逐帧解压，否则会看到「日志里什么都没有」的假象。

#### 证据二：`MULTITASK-*` 日志标识（只对**接了日志汇聚**的部署有效）

下面这些标识走 `ctx.logger`；没有 sink 接收时**不会落盘**。在会话目录里 grep 不到它们，
不代表闸门没生效。

| 标识 | 含义 |
|---|---|
| `MULTITASK-APPROVAL-GATE-ENGAGED` | 已放开一个子代理的策略，闸门就位 |
| `MULTITASK-APPROVAL-GATE-SKIPPED reason=…` | 跳过了（`reason=` 说明为什么：父会话不是 ask / 缺服务 / 载荷畸形…） |
| `MULTITASK-APPROVAL-ASK` | 第一级判定某次调用危险，正在征求用户同意 |
| `MULTITASK-APPROVAL-YIELDED reason=auto-review` | 让位给自动审查，本模块不再升 `ask` |
| `MULTITASK-APPROVAL-RELAYED` | 第二级把子代理的请求转呈给了父会话（含结果） |
| `MULTITASK-APPROVAL-RELAY-FAILED reason=…` | 转呈失败，已退回原路径 |
| `MULTITASK-APPROVAL-NOTIFY-SENT` | 转呈失败后，已尽力用消息通道把「有决定在等你」送到父会话 |
| `MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=…` | 没发通知及原因（`disabled-by-config` / `no-subagents-service` / `not-direct-parent` / `signal-aborted`） |
| `MULTITASK-APPROVAL-NOTIFY-FAILED` | 通知本身发不出去（不影响审批结果） |
| `MULTITASK-APPROVAL-RELAY-RETRY-RETRIED` | 通知唤醒父会话后重试转呈**成功**，用户的决定已拿到（含 outcome） |
| `MULTITASK-APPROVAL-RELAY-RETRY-WAITING` | 正在等父会话的回合打开（`reason=turn-already-open` 时不必等） |
| `MULTITASK-APPROVAL-RELAY-RETRY-SKIPPED reason=…` | 没有重试及原因（`disabled-by-config` / `not-a-turn-boundary-failure` / `notice-not-delivered` / `turn-state-unreadable` / `signal-aborted` / `parent-not-interactive`） |
| `MULTITASK-APPROVAL-RELAY-RETRY-FAILED reason=…` | 重试没成功（`window-elapsed` / `retry-threw` / `no-approval-service`），已退回原路径 |

`MULTITASK-APPROVAL-GATE-SKIPPED` 与 `ENGAGED` 都随计数递增，所以派了 N 个 worker
却一个都没放开时，日志里能看出「跳过了几次、每次为什么」。

#### 自动审查让位的判据

「让位」的结果是**什么都不做**，所以只留下**缺席**证据。缺席证据在这组组合里是充分的：

| 情形 | 持久事件里应当看到 | 不应当看到 |
|---|---|---|
| EXP 放行 | 该调用**没有任何** `approval/asked` | 没有 `Multitask approval gate flagged …` |
| EXP 拒绝（策略 `ask`） | 一条 `Auto review denied tool …`（EXP 自己的），**随后**一条 `Multitask approval gate: a delegated Subagent …`（本模块转呈，`reason` 末尾带着 EXP 的原文） | 没有 `Multitask approval gate flagged …`（若出现，说明本模块**又**按规则表问了第二遍，即让位失效） |
| EXP 拒绝（策略 `never`） | 一条 `Auto review denied tool …`，`approval/decided` 为 `rejected` | 没有第二级的 `a delegated Subagent …` |

判据的关键是**同一条命令在 `approval/asked` 里只出现一次** —— 出现两条就说明本模块
**又**按规则表问了第二遍，即让位失效。

### 边界：这个模块不提供什么

- **父会话空闲时，转呈要靠「唤醒 + 重试」这一条路兜住，它有一个窗口上限。**
  `approval.request` 要求父会话有一个打开的回合，否则抛错。这种「回合刚好关着」的个例
  **不是随机故障**：后台派单时协调者派完就不等了，父会话的回合随之结束，子代理后面才动手 ——
  所以它在一部分请求上稳定复现。这一前提现在由人格与同名段遮蔽**显式**保证
  （见「协调者何时结束回合」），不再是宿主的默认行为。
  本模块的处置是：转呈失败 → 发通知（那条通知会把空闲的父会话唤醒）→ 等回合打开 → 重试一次。
  于是这类个例通常**几毫秒**就回到正常路径（主对话里出现一张审批卡）。
  仍然有三条边界：① 只在**通知确实送达**时才等（没有送达就没东西会去唤醒父会话）；
  ② 只在**「缺打开回合」这一种失败**上重试（别的失败重试不会变好，还可能造成重复询问）；
  ③ 窗口默认 10 秒（`config.relayRetryWindowMs`，设 0 关闭），耗尽后退回原路径并 fail-closed。
- **兜底通知不是批准，重试成功才是「已批准」。** 转呈失败后，本模块会尽力通过 Agent 消息通道
  （`subagents.sendMessage`）让主对话出现一条来自该子代理的消息，写明**是哪个子会话、
  想执行什么、去哪里作答**。这段文案刻意写成**条件式**（「若本对话里出现了审批卡就在这里作答，
  否则打开那个子会话」）——因为重试可能成功、也可能失败，文案必须在两种结局下都为真；
  而消息通道**不携带审批结果**，若被读成放行就等于绕过了审批。另有两条边界：
  它只对**可续接**的 worker 有效（本模式四类 worker 都是；`subagent_codex` /
  `subagent_claude_code` 若是外部一次性后端就发不出去）。可续接性由 **provider 的能力**决定：
  实现了 `prepareContinuable()` 的 provider 走进程内续接路径，`sendMessage` 才认它。
  本包那两个自建 provider（`multitask_ptc` / `multitask_minimal`）与内置的
  `spawn` / `fork` 都实现了它，所以四类 worker 全部满足这条前提。
  且 `sendMessage` 只认**直接**父子，多级委派时会跳过（记 `not-direct-parent`）。
- **重试没能成功时，请求会一直挂着，兜底不解除它。** 这是最容易被误解的一条：宿主把请求发给浏览器后，
  客户端会为那个（不可见的）子会话**无条件**物化作用域并接住它，而审批路径**没有任何超时**，
  所以那次工具调用会一直阻塞。`run_code` 是例外（它的预算**包含**审批等待）。兜底的作用是让
  用户**知道并找得到**那个请求，真正的解除要靠用户去那个子会话批准/取消，或取消整个回合。
  日志上区分得开：重试成功是 `-RELAY-RETRY-RETRIED`（拿到了决定），
  没成功是 `-RELAY-RETRY-FAILED reason=window-elapsed`（要用户自己去子会话）。
- **规则表是模式匹配，会漏判新型危险命令。** 所以真正的闸门是第二级，
  第一级只负责「安全的不用打扰用户」。
- **上游改版可能让本模块失效**：它依赖几个未文档化的上游细节（`overrideOf` 取最后一条、
  `source` 的迁移期语义、`agent/created` 晚于 `setup`、`sendMessage` 的授权宽严）。失效时的
  表现是**闸门不生效**（回到没有本模块时的行为），**不是**权限被放大 ——
  因为父会话不是 `ask` 时本模块什么都不做，而所有失败路径都是「交回下游」。
- **它不改变沙箱。** 危险命令被批准后仍在该调用原有的沙箱模式下执行；本模块只决定
  「要不要问」，不决定「给多大权限」。

### 可调项（这一行的 `config`）

**profile patch 够不到这一行。** 宿主半（`lib/index.js` 的 `applyGuardOverrides`）只把顶层那几个
开关应用到 preset 内部，而且只改 `coordinator-guard` 那一行 —— 所以改这一行的开关要动
`presets/multitask/composition.mjs` 里 `approval-gate` 那一行的 `config`，然后重启应用。

| 字段 | 默认 | 作用 |
|---|---|---|
| `classify` | `true` | 第一级（规则表）总开关。`false` = 危险命令不再被拦下询问；第二级转呈仍在 |
| `relay` | `true` | 第二级（转呈）总开关。`false` = 子代理的请求不再落到主对话 |
| `relayRetryWindowMs` | `10000` | 「回合刚好关着」时等父会话开回合的上限（毫秒）。`0` = 关闭重试 |
| `notifyOnRelayFailure` | `true` | 转呈失败时的兜底通知。`false` 关掉它（重试照常进行） |
| `extraDangerPatterns` | `[]` | 追加危险模式，每项 `{ id, re }` 或裸字符串 / 正则 |
| `safePatterns` | `[]` | 追加「命中也不问」的放行模式 |
| `shellTools` | `['pwsh', 'bash']` | 追加需要看命令文本的工具名 |
| `fileTools` | `['write', 'edit']` | 追加「会把 `file_path` 指向工作区之外」的写工具名 |
| `autoApproveTempRoots` | 各平台临时目录 | 「草稿区」根目录：往这里写、或**只**删这里的东西，都不问。传 `[]` 关闭这一档 |

**这几个字段的失败方向并不一样，下面几条值得单独写清：**

- `extraDangerPatterns` / `shellTools` / `fileTools` 是**加法**，失败方向安全：漏配一条 =
  那种情况不被过问（与本模块不存在时等价），**不会**放过任何它本来会问的东西。
- **`safePatterns` 是减法，方向与 `DANGER_PATTERNS` 相反** —— 它取消的是本模块**已经**判定的
  危险。所以它默认**刻意留空**：写错它等于静默放行一条危险命令，而「少问一次」与「多放一次」
  在日志上都看不出来（一次都没问，就没有 `MULTITASK-APPROVAL-ASK` 可对账）。
  要加它，必须有与 `DANGER_PATTERNS` 那几条同等强度的依据，并且两侧用例一起跑。
- `relayRetryWindowMs` 的非法值（负数、`NaN`、非数字）一律**退回默认 10 秒**，而不是被读成
  「不限制」—— 无限等待会让子代理在父会话永不醒来时被永久挂住，那正是本模块最不该制造的状态。
- `shellTools` / `fileTools` 里**名称写错不会报错**，只会静默漏判（命令照旧在沙箱下执行）。
  所以默认只列本 composition 真的会注册的那几个，宁可少列。

### 临时目录为什么默认免询问（`autoApproveTempRoots`）

这一档默认开启，也是唯一一处「本模块主动少问一次」的取舍，所以它的理由与边界都要写清。

**理由一：临时目录是草稿纸，不是用户资产。** DSH 自己在 `%TEMP%` 下建 `dsh-subagent-*`、
`dsh-acl-locks`、`dsh-spill-*` 等运行期目录；一个 worker 往那里写中间产物或清掉自己的临时目录，
是正常工作的一部分。为它弹窗，只会训练用户养成「闭眼点允许」的习惯 —— 而那会直接削弱真正的
危险询问。**噪声也是安全性的一部分**：一个每次都问的闸门等于没有闸门。

**理由二：它不改任何权限。** 这一档只影响「要不要问」，不改变沙箱、不改变 ACL、不改变
DSH 对写入范围的判定。能写到哪里仍然由沙箱决定；本模块只是不再为一个低信息量的动作打扰用户。

**边界一：删除的豁免比写入严得多。** 写入只看「目标在不在允许根下」；删除还额外要求
**整条命令**都只碰允许根 —— 没有 shell 元字符（`;` `|` `&` `` ` `` `$` `>` `<`，以及 `,` 与换行）、
至少一个绝对路径参数、**所有**路径参数都在根下、路径里不含 `..` 段、且不含相对路径参数。
五条缺一不可：

| 命令 | 结果 | 为什么 |
|---|---|---|
| `rm -rf /tmp/x` | 不问 | 唯一目标在允许根下 |
| `rm -rf /tmp/x /home/u` | **照问** | 混了一个根外路径 —— 豁免不许被借道 |
| `rm -rf C:\Windows` | **照问** | 根外 |
| `rm -rf $env:TEMP\x` | **照问** | 含 `$`，目标无法静态判定 |
| `Remove-Item -Recurse C:\Windows` | **照问** | 根外 |
| `Remove-Item -LiteralPath "/tmp/a","C:\Windows" -Recurse -Force` | **照问** | 逗号粘连：两个路径之间没有空格 |
| `rm -rf /tmp/../../../etc` | **照问** | `..` 段把目标带出根外，词法前缀比较挡不住 |
| `rm -rf /tmp/a ..` | **照问** | 相对路径参数，删的是工作目录的父级 |

方向是刻意的：**豁免误判一次就会放过整行危险命令，而多问一次只是一次点击**。

**边界二：它确实让 worker 能静默往一个共享目录放文件。** `%TEMP%` 是所有进程共享的、
通常可写的目录，所以严格地说，这一档放开了「静默放置文件到共享位置」这件事。评估为可接受的两个
依据：① 本模块从来就不是沙箱，放置文件本身不产生执行；② 从临时目录执行脚本
（`pwsh <temp>\x.ps1`）本来就不在任何危险模式里 —— 也就是说，即使关掉这一档，
那条路径也不会被拦下。要让「从临时目录执行」也受管，需要新增一条危险模式，
那是**另一件事**（并且要先确认它不会误伤正常的构建脚本调用）。

**要收紧就传 `[]`**：那一档立刻消失，连删临时目录也会照问。想让某个私有缓存目录也免询问，
把它加进数组即可（例如一个专门的构建输出目录）。

### 引号里的文本 vs 实际执行的内容

第一级是**对命令文本做模式匹配**，而命令文本里既有「会执行的代码」，也有「只是数据的字符串」。
两者在字面上可能一模一样：

```powershell
Get-ChildItem . | Select-String -Pattern 'log|sh'   # 单引号内是正则交替，没有管道
cat urls.txt | sh                                    # 真的把内容喂给 shell
```

`pipe-to-shell` 的模式只认 `|` 后面跟 shell 名，于是第一行也被判成「管道到 shell」——
一次纯粹的误报。它的代价不只是多点一次「允许」：**每次无谓的询问都在训练用户闭眼点允许**，
那会削弱真正危险的那几次询问。

所以判定分两步：

1. 对**文本型模式**（`pipe-to-shell` / `pipe-to-iex` / `invoke-expression`）逐个命中检查，
   命中点若落在引号内、且引号前面是**纯数据/正则语义**的参数名或 cmdlet
   （`-Pattern` / `-match` / `-like` / `-eq` / `Select-String` …），就跳过这一个命中；
2. 同一条命令里**其余**命中照旧判危险 —— 只要有一个不是字面量，整条就是危险的。

`-Command` / `-c` 刻意**不在**数据语义名单里：它们的引号内容会进解释器，
`pwsh -Command "cat x | sh"` 是一条真的管道命令。

⚠️ 这条豁免**只作用于文本型模式**。`rm-recursive-force` / `remove-item-force` 这类
「命令本身就是动作」的模式绝不能进来 —— 对它们做引号豁免会让
`Remove-Item -LiteralPath '...'` 整类命令失去保护。

### 审批卡必须画出真实目标

一条带 `..` 的命令，字面写法与真实落点可能相差很远：

```
Remove-Item -LiteralPath "<temp>\dsh-mt-rt\..\..\..\..\dsh-mt-shadow" -Recurse -Force
                                       真正指向 %USERPROFILE%\dsh-mt-shadow
```

只说字面文本的话，用户在**看不到落点**的情况下点了「允许」—— 那不是知情同意，
这张卡也就失去了存在的理由。所以第一级的 `ask` 决策会把折叠后的路径一并带进
`reason` 与 `displayReason`（决策本身仍按 `..` 一律照问，折叠**只用于显示**）。

折叠是**纯词法**的（只消掉 `.` / `..` 段，不解析符号链接、不碰文件系统）：
审批卡需要的是「命令文本声称的目标」，而不是当前磁盘状态。不含 `..` 的路径不会多出这一行，
否则卡面上每个正常路径都要加一句，反而更难读。

---

## 纠错时序：追加给子代理的话必须**立刻**生效（`interrupt-before-send.mjs`）

### 它解决什么问题

协调者发现子代理正在做错事时，唯一的手段是 `send_message`。而宿主的投递语义是
**`steer`（步骤边界投递）**：

```
A working target receives the message at its nearest step boundary through Steer;
an inactive target starts or resumes a turn.
```

「最近的步骤边界」听起来很快，实际上不是：**一步可以是一整个长工具调用**（跑一次构建、
拉一次依赖、递归扫一棵目录树）。而子代理做错事时，它正在跑的往往恰好就是这种长任务。
于是：

1. 子代理按一条**错误**的要求往下做；
2. 协调者发一条纠错 —— 它进了收件箱 / 步骤边界队列；
3. 那条错误的要求**继续跑完**，纠错才被读到；
4. 到那时错误已经造成（文件改错、命令跑完、产物写坏）。

**纠错的价值全在时效上**，晚一步就只剩善后。所以光发不够，还得先把当前轮次停掉。

### 它怎么做

在 `tools/pre-execute` 上拦 `send_message`，在**发送真正发生之前**调一次
`ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent })`。

中断是**同步**的，只停当前轮次并保留收件箱（上游逐字：
`stops a child's current turn while keeping its inbox and descendants intact`）。
消息内容一个字不改 —— 本模块只改变它的**时机**。

### 为什么拦 `send_message`，而不是新注册一个「纠错」工具

新工具的正确性依赖模型每次都选对工具，而模型在赶进度时恰恰不会去分辨
「这是追加还是纠错」—— 那正是它刚做错事的那一刻。`send_message` 只有一条路径，
拦在它前面就**不可能**漏。这就是本包一贯的取向：**人格说明意图，机制保证行为**。

### 打断不等于「任务被中断」：它保留下来的远多于它拿掉的

中断走 `keepInbox`，只中止**当前轮次**：

| 保留 | 拿掉 |
|---|---|
| 收件箱里所有排队消息（`keepInbox`，上游逐字） | 正在进行中的**那一个动作**（例如还没跑完的长命令） |
| 它派出的后代（`descendants intact`） | 那个动作的结果不会进上下文（因为它没完成） |
| **已经建立的全部上下文** —— 会话日志里每一条已 append 的事实都还在（上游：`every accepted fact is appended to the session log before the next step derives from it`），读过的文件、跑过的命令、得出的结论都不清掉 | |

所以「大方向对、细节要调」的情形不但没有损失，反而更划算：让它带着全部已建立的状态
立刻改道，好过按错的细节做完再返工。而且**新的一条消息本身可能就带着关键信息**
（用户刚补充的约束、刚发现的路径、刚否决的方案）—— 那正是不该等它跑完的理由。

结论：本模块的取向不是「用一个代价换时效」，而是**纠错本来就该立刻生效，等待没有好处**。

要退回宿主原语义（排队）就把这一行配成 `enabled: false`。

刻意**不**提供「按内容判断该不该中断」的选项：那种判断只能靠模型自己声明
「我这条是纠错」，而那正是它最容易搞错的地方。一个永远成立的规则比一个需要判断的规则可靠。

### 只拦「协调者 → 子代理」这一个方向

硬前置：发送方不能是被委派的子代理。因为 worker 也能给父会话发消息（汇报进度），
若对那个方向也先中断，被停掉的会是**主对话自己的回合** —— 用户正在看的回答被掐断。
判据与其它守卫同源（`origin` / `parentSession` / `delegationDepth` 三信号）。

即使那条判据写漏了，`authority: { kind: 'ancestor' }` 也会在非祖先方向被上游拒绝，
而失败只记一条 info、不影响发送 —— 双层防护。

### 失败取向：静默降级

中断失败（服务缺失、目标不是自己的后代、id 读不出来）**绝不**影响发送本身。
把「纠错稍晚」降级成「纠错根本没发出去」方向正好反了。所以任何失败都只记一条带固定标识的 info，
然后照常发送。

### 怎么确认它生效了

| 持久事件里应当看到 | 含义 |
|---|---|
| `turn/end` 的 `data.reason.kind` 为 `aborted`，且 `reason.reason.kind` 为 **`parent`** | 该回合被**父级**取消 |
| 紧随其后（毫秒级）新开一个回合，并以 `completed` 结束 | 那就是读纠错消息的回合 —— 这是预期行为，不是失败 |

**打断延迟**从父会话发出 `send_message` 到回合 `aborted` 计算，量级是毫秒。**不要**用
「发出纠正 → 收到最终回复」来算：打断之后宿主会新开一个回合读纠错并**重新组织回答**，
那段二次生成是子代理的写作时间，与打断无关。

三个容易判错的点：

1. **`aborted` 有两种来源，`reason.reason.kind` 区分它们**：`user` = 用户按了停止键，
   `parent` = 父级取消。只有 `parent` 才可能是本模块。
2. **但 `parent` 不等于「本模块干的」**：协调者可以直接调用 `interrupt_agent` 工具主动停下
   子代理 —— 这类中断占多数。判据必须**加一道反证**：去父会话日志里查有没有 `interrupt_agent`
   的 `tool/call`。
3. **不要取「最后一个回合」**：被掐断的回合永远不是最后一个（后面还有那个读纠错的回合）。
   要找的是**任意**一个 `parent` 型取消。

📌 **一个副作用**：`parent` 型中断会把该 worker 尚未答复的**审批请求一起结掉** ——
审批记录的 `outcome` 是 `cancelled`（既不是 `rejected` 也不是 `allowed`），用户看到的现象是
「正要点的卡自己消失了」。语义上是对的（回合没了，请求无人受理）。

（若接了日志汇聚，对应标识是 `MULTITASK-STEER-INTERRUPT-ENGAGED` /
`-SKIPPED reason=…` / `-FAILED`；没有 sink 时不会落盘。）

---

## 跨模式派发（`preset-dispatch.mjs`）

**是什么**：把「减震器」的作用面从**本 preset 内部**扩展到**用户与所有已安装模式之间**那一层。

### 它做什么

注册一个工具 `subagent_preset`。协调者用它把任务书投给**任意已安装的 agent preset**
（standard / ptc / minimal / cordis / 任何从插件市场装进来的第三方模式），只收回结论。

```
用户 ──► 协调者（减震器）──► 任意已安装的模式 ──► 结论回到主对话
```

### 为什么按「描述」挑，而不是解析对方的内部结构

判据只有两样**稳定**的东西：注册表的 `list()`（id / 名称 / **描述** / 是否 broken）与上游的
`startActivation({ request: { agentPreset } })`。

刻意**不**解析别的 preset 的插件行、不猜它的工具名、不读它的 `config`：

- 那些是别人家的实现细节，任何一次上游改版或插件升级都会让本模块连带坏掉；
- 而「这个模式是干什么的」唯一**权威且稳定**的来源，就是它自己发布的 `description`；
- 于是市场里新装一个模式**不需要改本包一行代码**，它就自动可选 —— 这正是「让市场去完善功能」
  的落地方式。

`list: true` 的返回里也带「当前能不能起来」：标着 `CANNOT RUN` 的模式是坏的，不能选，
调用方据此改派而不是对着一个空 id 发呆。

### 三条硬边界

1. **provider 固定 `spawn`，不做配置项。** 上游 `assertCapabilities()` 要求：带 `agentPreset`
   的请求必须由「声明 `agentPreset` 能力 **且** 不继承父会话上下文（
   `inheritsParentContext === false`）」的 provider 承担。内置 `spawn` 满足，`fork` 不满足。
   做成配置项只会制造一类「配错了到委派那一刻才抛错」的故障，而且错误信息指向 provider 能力、
   与本模块毫无关系 —— 所以写死。
2. **不能派给本模式自己。** 那会造一个「子协调者」，而深度限制让它派不出去。调用被明确拒绝，
   并给出正确替代（四条内置路径）—— 直接拒绝比让用户等一次注定失败的委派好。
3. **worker 不能再往下派。** 与四类 worker 同一条判据（`isDelegatedChild` 三信号）。
   不在这一层挡住的话，那次调用会走到 `startActivation` 才被深度限制拒绝，报错说的是
   `subagent depth 2 exceeds maxDepth 1` —— 看不出与跨模式派发有关，很容易被误读成功能坏了。

### ★ 第四条边界：跨模式 worker 不受本模式守卫管辖（源码确证）

这一条不是推测，是从两处上游源码读出来的，而且它同时解释了「为什么安全」与「哪里不安全」：

**① 事件按作用域链派发。** `dsh-agent` 的 `agentCarrier(agent)` 就是
`scopeTarget(agent, agent)`，而 `scopeTarget` 的过滤器只放行这样的监听者：

```js
const tag = scopeOf(ctx)
if (tag === void 0) return true
for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true
```

也就是「订阅者所在的 scope 必须在这条链上」。`agent/created`、`agent/disposed` 都走它。

**② 子代理挂到目标模式的 scope 下。** 注册表的 `bind()` 对子代理执行
`bindScopeParent(childKey, generation.key)`，其中 `generation.key` 是**目标 preset**
（`mountPreset` 返回的 `scopeOf(ctx)`）那一份的键。

两条合起来：跨模式 worker 的 scope 链是 `[它自己, 目标模式]`，**不含本模式**。于是：

| 本模式的守卫 | 对跨模式 worker |
|---|---|
| `worker-persona`（人格注入） | **不作用** —— 正好，不会把「你有完整工具集」套到只读模式上 |
| `minimal-guard`（只读收窄） | **不作用** —— 收窄归目标模式自己 |
| `approval-gate`（两级闸门） | **不作用** —— 见下 |
| `subagent-mode`（PTC 塌缩） | **不作用** —— 那本来只认本模式的 `multitask_ptc` |

**所以必须说清楚：跨模式派发是能力路由，不是安全代理。**

审批闸门覆盖不到的后果是具体的：上游 `captureDelegatedPolicyOverrides()` 把子会话的
审批策略钉死为 `'never'`，所以跨模式 worker 的危险操作会**直接被拒绝**（fail-closed，
**不会**静默放行），但**不会弹卡问你**。需要本模式两级闸门保护的任务，仍然应该派给
四条内置路径。

### 它与「四类 worker」的分工

- 四类 worker（`subagent` / `subagent_fork` / `subagent_ptc` / `subagent_minimal`）是
  **本模式自己的**工具面分流：同一个模式下，谁去干活、看得见多少工具；
- `subagent_preset` 是**跨模式**的路由：这件事本来就该由别的模式来做。

两者不重叠，也不互相替代。协调者人格里写明了这条分工与「拿不准就问用户 —— 模式是用户装的，
他知道为什么装」。

---

## 验证它真的生效了

三件事各有一个可观测判据。

### 协调者的工具面

它应当能读、不能写、不能跑命令：

| 你说 | 期望 |
|---|---|
| 「你直接读一下 package.json 告诉我版本」 | ✅ 成功（只读核对是保留的） |
| 「你自己跑一下 `git status`」 | ❌ 调用不了 —— 工具不在它的可见面里 |

子代理仍然能干活：

| 你说 | 期望 |
|---|---|
| 「派个子代理跑 `git status` 并把结论告诉我」 | ✅ 子代理成功执行，只把结论带回来 |
| 「派个子代理读一下 package.json 并报出文件名与大小」 | ✅ 只读路径始终可用（`read` / `file_info`） |

若第二组失败（子代理也不能跑命令），说明减震器**装错了位置** —— 见「设计要点」。

> ⚠️ **先排除一种与本包无关的失败**：子代理的 shell 可能在**会话一开始**就被一处权限写入
> 整体拒掉，症状是任意命令（连 `Get-Location` 都算）都回
> `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<路径>)`。
> 那是工作区 ACL 的问题（见「已知边界」的 `WRITE_OWNER` 一节），不是减震器、也不是命令本身。
> **只读工具不受影响**，所以那一组里最后一条仍然应当成功。

收窄了哪些工具在日志里是固定串：

```
dsh-multitask: coordinator scope engaged — withheld N tool(s): edit, pwsh, read_image, ssh_exec, ...
```

### 审批闸门（危险操作弹窗）

**前置**：当前会话的审批策略必须是 `ask`（新建会话默认如此；headless 部署与
「永不需要批准」的配置是 `never`，那种情况下本模块**完全不介入**）。

| 你说 | 期望 |
|---|---|
| 「派个子代理跑 `Get-ChildItem` 把文件名列出来」 | ✅ **无弹窗**，直接出结果（第一级判定安全） |
| 「派个子代理删掉 `.\build` 目录（用 `rm -rf`）」 | 🔔 主对话 composer 处**弹出审批卡**，标题写明是哪个子代理要执行什么 |

| 你的操作 | 期望 |
|---|---|
| 点**拒绝** | ❌ 命令**确实没有执行**；子代理拿到的结果是 `the user rejected tool "..."` |
| 点**允许一次** | ✅ 执行成功；**再次**发同样调用会**再次弹窗**（`allowed-once` 是唯一授权，没有「永久允许」） |

持久事件里对应的判据：

| 持久事件里应当看到 | 含义 |
|---|---|
| `approval/asked` 一条，`reason` 以 `Multitask approval gate flagged a destructive shell command (…): …` 开头 | 第一级弹了卡 |
| 随后 `approval/decided`，`outcome` 为 `rejected` | 拒绝了，命令没执行 |
| 随后 `approval/decided`，`outcome` 为 `allowed-once` | 批准了这一次；再次发同样调用会**再次**出现 `approval/asked` |

反方向的判据：**父会话策略是 `never` 时**，`approval/asked` 里**不应**出现任何
`Multitask approval gate …` —— 那说明红线（不在 headless 环境启闸）守住了。
（日志汇聚侧对应 `MULTITASK-APPROVAL-GATE-SKIPPED reason=parent-not-interactive` 且没有 `ENGAGED`。）

#### 兜底通路（后台派单 / 父会话空闲）

「弹窗」那条路径要求**父会话此刻有一个打开的回合**；**后台派单 + 回合结束再等回调**时
它不成立，于是转呈先失败一次，本模块发通知唤醒父会话并**重试转呈**（见「边界」第一条）。
后台派一次危险命令后，主对话会出现**三种形态之一**：

| 你看到的 | 含义 |
|---|---|
| 结构化**审批卡** | 转呈生效（父会话恰好有打开的回合），**或**唤醒后重试成功 —— 两种成因都走这一形态 |
| 一条**来自该子代理的消息**，写着「a decision from you is waiting」并给出子会话 id，**随后**出现审批卡 | 第一次转呈失败、通知已发出、重试成功。消息与卡片是**同一件事**：消息是唤醒手段，卡片才是作答处 |
| **只有那条消息，没有卡片** | 重试没能成功（窗口耗尽等）—— 这是**通知，不是批准**；按消息里的 id 打开那个子会话作答 |

判据是**卡片是否存在**，不是「有没有消息」：重试会**同时**留下消息与卡片，窗口默认 10 秒，
所以要等窗口过完再看一眼。批准/拒绝**只能在那个子会话里完成**，消息通道不携带审批结果。
`approval/asked` 里应当只有**一条** `Multitask approval gate: a delegated Subagent …`
—— 出现两条说明重试造成了重复询问，那是缺陷。

#### 跨重启存活

`approval/policy` 的写入跨重启存活，不需要恢复路径：载入期只丢弃「最后一条没有换行的
**不完整**记录」（torn tail），与事件是否在回合内无关；而 `approval/policy` 不在任何回合
包含校验里（只有 `approval/asked` / `approval/decided` 要求回合归属）。
子会话日志里应当看到宿主钉死的 `{"policy":"never","source":"delegation"}` 紧跟一条本插件写的
`{"policy":"ask"}`，两条都落在第一个 `turn/start` 之前；重启后新会话里的子代理仍应为 `ask`。

---

### 怎么自己核对收窄效果

协调者与 worker 各派一个子代理，让它报自己的工具面：

| | 协调者 | worker |
|---|---|---|
| `pwsh` | ❌ 不在可见面里 | ✅ 有 |
| `write` / `edit` | ❌ | ✅ |
| `ssh_*` / `task_board_*` / `web_search` / `read_image` | ❌ | ✅ |
| 实际执行命令 | 无法发起调用（工具不存在） | 正常执行并回结果 |

⚠️ **别拿 worker 自述的工具数当判据。** worker 凭印象报自己的能力会**偏窄**，
且遗漏的常常是它刚刚成功调用过的那一个；同一份报告里可能既写着「Created file」、
又报「我没有 `write`」。
判据应当是「它**实际调用了什么**」，而不是它列出的清单。这也正是**机制**（工具限制）
必须与**提示词**一致的原因 —— 人格说它不能，机制却让它能，模型就会在自己的推理里指出这个矛盾。

---

## Worker 人格：为什么每类 worker 都要单独一份

子代理加入的是**父级那一份 preset**，所以它们**默认继承协调者人格** ——
装出来就是「你也是协调者，你不能改文件、不能跑命令」，而它实际上拥有全套工具。

一个被告知「你不能执行」的 worker，会倾向于拒绝干活 —— 而那正是它唯一被派出去要做的事。
所以这**不是措辞好不好听的问题，是会实质削弱整个模式的问题**。

**修法**：本包给每一类 worker 配了独立的人格，并声明它拥有对应的工具面。
各份**刻意不共用同一份文本**（上下文起点与工具面都不同）：

| 委派行 | provider 名 | 人格常量 |
|---|---|---|
| `tool-subagent` | `spawn` | `WORKER_PERSONA` |
| `tool-subagent-fork` | `fork` | `FORK_PERSONA` |
| `tool-subagent-ptc` | `multitask_ptc` | `PTC_WORKER_PERSONA` |
| `tool-subagent-minimal` | `multitask_minimal` | `MINIMAL_WORKER_PERSONA` |

**注入者是本包的 `worker-persona.mjs`**：它在 `agent/created` 窗口按 **provider 名**挑出该行的
文本，注册到**子代理自己的 scope** 上（段落名 `deployment:persona-prefix`）。上游的委派行
不再接受 `persona` 配置项，所以人格不经过 `dsh-subagent`。scope 层叠规则不变：
「最近的作用域赢得同名 section」，照样盖掉协调者那份。

核对方式：让一个 worker 报它的工具面，看它的提示词里是否还残留
`You are the coordinator`、以及 `WORKER subagent` / `FULL tool set` 是否在。

⚠️ 这三处措辞是**人格措辞的指纹**：它们**不受任何自动化守卫保护**，这条约束靠人遵守 ——
改掉它们，上面这条核对就失效。

### fork 特有的坑：它会把父会话的历史当成自己的

`subagent_fork` 的上下文起点和其他三条**不一样**：它被喂入父会话**全部已完成轮次**。
这带来一个别处没有的失效：那些轮次看起来就是「它自己的对话」。

失效症状：

- 一个 fork worker 自称「我作为协调者」；
- 另一个报「我派过 fork」，而实际派 fork 的是它自己那个父会话；
- 它把父会话的轮次算成自己的轮次，于是据此推断自己的权限边界 —— 而那个边界是**协调者的**，
  比它实际拥有的窄得多，也完全不是它该据以行事的依据。

**这不是「偶尔读错」，而是这份上下文的结构性后果**：喂进去的是「已完成轮次」，其中每一轮
assistant 发言在字面上都是第一人称。模型没有额外信号能区分「这是我」与「这是喂给我的」。

**修法**：`FORK_PERSONA` 里专门开一节，把两件事永久分开 ——
「我做过什么」只算这一段会话里、简报到达之后我自己发起的调用；
「我读到什么」是协调者选择给我的背景，可以引用、可以核对，但**不得当作自己做过的事汇报**，
也不得据它推断自己的能力。同时点名两个具体后果：

1. **别从 transcript 推断自己的工具面。** 协调者的工具面被机制性收窄过（不能写文件、不能跑命令），
   所以一段满是「我做不到，我去派个子代理」的对话描述的是**它的**限制，不是 fork worker 的。
2. **别把协调者的派发当成自己的。** 简报里提到的前一个 worker 是另一个会话，fork 没有跑过它。

另外它**读不到自己的会话 id**（那在它看不到的元数据里），所以人格里明说：需要时就说拿不到，
不许猜、更不许拿协调者的 id 顶替。

⚠️ 这一条**不可由自动化守卫保证**：它是一段提示词，而「模型会不会把喂进来的历史当成自己的」
只能靠人复查。能守住的部分只有「人格文本确实注入到了 fork worker 上」—— 那由
`worker-persona.mjs` 的 provider 映射保证。

### 四个 worker 都要知道的两件事

`WORKER_PERSONA` / `FORK_PERSONA` / `PTC_WORKER_PERSONA` / `MINIMAL_WORKER_PERSONA`
四份人格各有一节 **`## The coordinator may interrupt you mid-turn`** 与
**`## Stop before you thrash, and say so`**。两条都不是可选的润色，各自堵一类实际失效：

**一、被中途打断是常态，不是犯错。** 协调者会在 worker 干活期间直接掐断当前轮次并续发新指令
（见「纠错时序」那一节，延迟量级是毫秒）。worker 若不预先知道这件事，会把「突然来的新指令」
读成自己搞砸了，于是从头重做 —— 而它其实保留着全部已建立的上下文，重做纯属浪费。

所以四份人格都写明：**已读、已跑、已得的结论不会被清掉**，丢的只是被打断时正在进行的那**一个**动作；
新指令在冲突处**优先于原简报**；**不要从头重做**；并且**要跨断面汇报**（打断前完成到哪、打断后做了什么），
否则协调者无法判断纠错有没有生效。

⚠️ 各份要按各自机制写，不能照抄：

- **PTC** 那一份额外点明「被掐掉的程序不会把它没打印的东西交回来」—— 这正是它要求
  「边算边打印决策就绪的结果」的另一个理由，打印过的状态能活过中断，没打印的不能。
- **fork** 那一份额外点明「继承来的轮次仍然不是我的」—— 中断不改变这条界线，
  它只增加「这一段会话里，纠错前后我做了什么」。

**二、陷进同一个构造时要停下来报告，而不是继续改。** 典型是
**大型或深层嵌套块里的条件表达式**（`A ? { … } : { … }`，或不断增生的三元花括号）：
每次尝试增删一个花括号，报错跟着移动，下一次尝试让局部更乱。到那一步它已经不在收敛，
只是在消耗协调者的时间。

人格给的是可执行的判据而不是劝告：**同一构造两次失败就是信号**，停止编辑；
**报清文件、构造、上一次的逐字报错、尝试次数**；**给出它认为的意图形状与外围结构**；
并且**绝不用删掉分支或弱化条件的方式来「修好」**—— 那样文件能解析了，但行为被悄悄改了，
协调者根本不知道该去看。

第三类 worker（minimal）没有写权限，所以它那一节换成同构的失效：**同一个事实两次搜索不到**就是信号，
要报出试过的路径与模式；**不许把「我没找到」写成「不存在」**。

### 协调者侧：卡住是「换人」的信号，不是「加压」的信号

对应地，协调者人格里有一节 **`## When a worker reports that it is stuck`**，规定的处置是
**派一个全新的 worker 专门处理那一个点**，而不是让原 worker 再试一次：

- 原 worker 的上下文里已经装着若干次失败尝试，**那些尝试本身就是问题** —— 它会继续锚定在自己写过的形状上，
  再给指令只会得到第四种变体；
- 新 worker 干净地读一遍文件，这正是它唯一的优势：**它没有投入到一个不成立的形状里**；
- 给新 worker 的简报要刻意窄：确切文件与构造、上一次的逐字报错、外围结构、以及
  「可以按你的判断重构这个块，但行为要保持、文件其余部分不要动」。

并且写明了**止损**：如果新 worker 也在同一处失败两次，那说明这个构造需要用户做设计决定，
应当如实上报，而不是再开第三个 worker。

> 这一节的判据是「同一构造两次」，不是「感觉很困难」—— 后者无法执行，前者可以。
> 这也是本包一贯的取向：给人格可判定的规则，而不是意图描述。

### 第三个事实：一次回复的输出上限，不是上下文上限

撞到输出上限的 worker 从外面看像崩溃：回合就此结束、没有续轮。三件事可同时成立 ——
`contextWindow` 是 **1,000,000**、上下文用量只有**一成**、结束原因是 **`max-tokens`**。
所以这是**单次回复的输出上限**（本机全库最大 `outputTokens` 恰为 32,768），
而**不是**上下文耗尽。这个区分决定处置方式：

- 按「上下文耗尽」去处置 → 缩短阅读清单。**无效**，读文件只占了那一成里的一小部分。
- 按「输出上限」去处置 → 把**写入**拆开。**有效**，问题就出在一次吐了十万字符。

**落点**：

- 三份**能写文件**的人格（`WORKER_PERSONA` / `FORK_PERSONA` / `PTC_WORKER_PERSONA`）各有一节
  **`## Never emit a whole large file in one reply`**，写明上限数字、`max-tokens`
  这个结束原因的名字、以及四条可执行做法：一次写入控制在 400–500 行内、先写骨架再分段 `edit`、
  被截断后从**尾部续写**而不是从头重来、开工前就把拆点定好。
- **`MINIMAL_WORKER_PERSONA` 刻意不写这一节**：它是只读 worker，没有可执行的落点，
  多一条只会稀释它真正的约束（读不到就说读不到）。
- **协调者**那一侧有两条：任务书要**按写入量拆**（「重做五节的整张样式表」本身就是几件事），
  并且**不许把 `max-tokens` 报成上下文耗尽**。

> 为什么这条不能只写成「尽量不要一次写太大」：软建议在 30,000 token 处不会生效。
> 给数字、给结束原因的名字、给「从尾部续写」这个具体动作，模型才有可判定的落点 ——
> 与本包其他守卫的取向一致。

---

## 设计要点（为什么这么写）

### 为什么协调者被限制，子代理却不受影响

这是整个模式的支点。

`dsh-subagent` 的 `applyChildComposition()` 会强制每个子代理加入**父级那一份 preset**，
而任何工具筛选都只能**收窄**、不能放宽（委派行不再有 `toolFilter`，只剩**同一个 preset 内的
scope 级 restriction**，语义同样是只减不增）。所以「协调者窄、worker 宽」**没法靠配置实现** ——
必须在 preset 内部动手。

突破口在 preset 注册表的 `join()`：它把 agent 的 scope 绑到 **preset 的 generation key** 上，
不是绑到父 agent 的 scope 上：

```js
parent: bindScopeParent(key, generation.key)
```

于是**协调者与子代理的 agent scope 是兄弟，不是父子**。而 `dsh-tools` 判定可见性时
只沿各自的祖先链走：

```js
if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
```

限制装在**协调者自己的 layer** 上 —— 这个 layer 不在子代理的祖先链里，
所以子代理完全不受影响。

> 这条推断可以用**真实的** `dsh-scope` / `dsh-tools` 模块验证（不必只读源码）：
> 把子代理挂到协调者 scope 下（父子而非兄弟），它**确实**会丢工具 ——
> 这证明该判据对 scope 结构是敏感的，不是碰巧通过。

### 为什么按补集下发，而不是写死黑名单

`tools.restrict()` 对**不存在的工具名会抛错**。写死黑名单的话，宿主 roster 一变就报错。

本插件反过来：读该 scope 当前**可见**的全部工具名，`deny = 可见集 − 保留集`。
于是名单里每个名字都必然存在，而且新工具默认被挡在外面。

### 为什么限制必须在组装瀑布之外装

`SystemPrompt.assemble()` 会**先**收集工具提供方、渲染各 section 文本，**然后**才跑
`system-prompt/assemble` 瀑布。所以在瀑布**内部**装限制改变不了它服务的那次请求 ——
只能下一轮生效，等于第一次请求漏网。

本插件只在两个安全窗口装：`agent/created`（首次组装之前）与 `tools/post-execute`（自愈补装）。

### ★ 模式隔离：只收窄**属于本 preset** 的会话

**要求**：同一个工作区里允许多种模式的会话并存（standard / ptc / Multitask…）。
减震器只准动 **Multitask 自己的会话**，别的模式**一个工具都不能少**。

**做法**（`coordinator-guard.mjs`）：

- **加一条归属判据**：`registry.composedPreset(agent.ctx)` 必须等于本 preset id，
  否则一律**卸掉**限制（而不是「什么都不做」）。判据读的是 agent **当前绑定**的 preset，
  会随切换改变；刻意**不读** session header 里的 `agentPreset` —— 那个字段记的是
  「创建时用的是哪一份」，切换之后就不成立。
- **判据放在每一条早退路径之前**：读不出可见面、读不出工具注册表等情形，都不该让一条
  **装错了对象**的限制继续留着。
- **读不出归属时不收窄**（fail-open）：宁可这一轮少收窄一次（下一个窗口会重试），
  也不能削到别的模式 —— 削错了没有任何日志，比漏装难查得多。
- **监听两个无载体广播**：`agent-preset/selected`（注册表在 `session/event` 后转发，
  参数是会话 id）与 `tools/change`（无参数）。**这条不可省**：会话一旦切走，
  减震器就不在它的祖先链上了，按 scope 过滤的 `tools/post-execute` **再也收不到它的
  任何事件** —— 「最后一次 sync」永远不会来。广播没有载体、不受 scope 过滤，才能把
  「该重判了」这个信号送到。两个方向都覆盖：切**走**时按在册表重判并解除；
  切**进来**时那个 agent 从没收窄过、不在册，靠 `agents.get(id)` 找回来再收窄
  （否则「首轮之前切进 Multitask」会漏装，第一轮工具面偏宽）。

`definition.id` 与守卫判据共用同一个导出常量 `PRESET_ID`，且宿主半会用**实际注册的那个
id** 覆盖守卫行的 `config.presetId` —— 两者一旦漂移，减震器会认为「没有一个会话属于我」，
于是整个模式静默失效（只留一句 warn），所以刻意让它们同源而不是各写一份字面量。

#### 判据分两层，顺序不可颠倒

1. **活绑定（权威）**：`registry.composedPreset(agent.ctx)` —— agent **当前**绑定的那份
   preset，会随切换改变。这是唯一能识别「已切走」的信号。
2. **会话头里的 `agentPreset`（退路）**：**只在活绑定读不出来时**才用。

⚠️ 退路**只用于「活绑定缺席」，绝不用于「活绑定是别的 id」**。这个区分是关键：
已切走的会话活绑定是**存在**的（被重绑到了新 generation），会明确返回另一个 id，
在第 1 层就被拦下 —— 不会因为会话头还写着创建时的值而被误收窄。

为什么需要退路：新建会话的 preset 绑定与 `agent/created` 的先后顺序没有实证。
若绑定更晚，只读活绑定会让**真正的 Multitask 会话**也停止收窄 —— 那是把主功能改坏。
退路把这种时序不确定性消掉。

### ★ 多模式并存：同一个工作区里各自独立

**要求**：同一工作区里，不同会话可以**同时**用不同模式（standard / ptc / Multitask…），
互不干扰；**在哪个模式的会话里委派，子代理就用哪个模式的配置**。

这条由两件事共同保证：

| 关注点 | 由谁保证 | 依据 |
|---|---|---|
| 主对话工具面各按各的模式 | 本文件的归属判据 | 限制只装在属于本 preset 的会话上 |
| 子代理用父会话那一份配置 | **DSH 自身** | `dsh-subagent` 的 `applyChildComposition()` 调 `agentPresets.composeFrom(childCtx, parent.ctx)`，强制子代理加入**父级那一份 preset** |

所以「在 Multitask 会话里委派 → 子代理拿到 Multitask 的 worker 人格与四类工具面」
不是本插件额外做的事，而是 DSH 的既有契约 + 本插件把 preset 声明对。

核对方式：在一个 Multitask 会话里委派一个子代理，读它的 `subagent/descriptor` ——
`provider` 应当是 `spawn` / `fork` / `multitask_ptc` / `multitask_minimal` 之一
（这正是四类 worker 的判据），且该子代理的提示词里应是 `WORKER subagent in Multitask mode`，
工具面包含 `read_image` / `pwsh` 这类被协调者摘掉的工具。

> ⚠️ 不要用 `descriptor.persona` 判断：委派行不接受 `persona` 配置项，那份字段对新会话
> 不会被写入；人格由 `worker-persona.mjs` 按 `provider` 名注入。descriptor 里出现 `persona`
> 只可能来自较早创建的会话，本包对它有只读兜底。

⚠️ 反过来的一条边界：**子代理的模型映射只在 Multitask 内生效**。
profile patch 里那份 `subagentModels` 挂在 `dsh-multitask` 那一行的 `config` 上，
由宿主半读进 composition 的委派行 `agentOptions`，所以它**只影响 Multitask 会话
委派出的子代理**；standard 会话里的子代理不受它管辖。这正是要求里的
「要分清楚」。

### 重算必须有界（跨会话扇出的根因与两层修法）

**现象**：在册会话一多，一次 `tools/change` 就能把主线程占死 —— `dsh web` 卡死，
`SIGTERM` 也无响应，最后只能强杀进程。实测（N = 12 个在册会话）修复前的一次
`tools/change` 打出 **`restrict=179`**，直接触发熔断（CAP = 220）。

**机制出处**：

- 宿主 `tools.restrict()`（`dsh-tools/lib/index.js:2991-3005`）**没有传 `notify: false`**，
  所以**装**和**卸**限制都会同步 `emit('tools/change')`。
- 而 `tools/change` 的处理是「遍历全部在册会话重算」。于是**每次重算自打两次广播**，
  而每次广播又让所有在册会话各重算一次 —— 放大因子是 `2^(N-1)·(N-1)!` 量级。
  旧 `sync()` 还「先 `release` 再 `restrict`」，正好把这两次广播都用满。
- 快路的依据在 `dsh-tools:3066-3070`：`view().restrictableNames` 是在 `admits()` 过滤
  **之前**填满的，也就是说它已经是**继承面全集**，不必先卸一遍再读。

**修法（两层，彼此独立）**：

1. **有界 pass 闸门**（`coordinator-guard.mjs` 的 `pass()`）。五个入口
   （`agent/created`、`tools/post-execute`、`agent-preset/selected`、`tools/change`、
   切模式时的 `release`）**全部**过闸；pass 期间由 `release()` / `restrict()` 自己打回来的
   `tools/change` **只置 dirty、不递归**；pass 结束后按 dirty 补跑**至多 2 轮**全量核对
   （`sync()` 幂等，多跑无害），仍未 settle 就打一条
   `MULTITASK-GUARD-UNSETTLED`。`passDepth` **必须在 `finally` 里复位**：cordis 的 `emit`
   是同步的，body 一旦抛错而闸门没解锁，之后所有入口都会被判成「重入」而只置 dirty，
   守卫就**永久停摆**。
2. **快路**：`deny = restrictableNames ∩ (¬keep ∪ extraDeny)` —— 直接按继承面全集算差集，
   与「先卸再读可见面」**等价**。目标集合与已装集合相同时**零 `release` / 零 `restrict` /
   零 `emit`**，自激的源头被整段拿掉。

**实测**：修复前 N = 12 时一次 `tools/change` → `restrict=179` 并触发熔断；
修复后同样场景 `restrict=0 dispose=0 emit=0`。`scope-local` 名字的诊断告警**保留** ——
结构上摘不掉的名字仍会 warn 一次（T14 由红转绿）。

**失效时的降级方向**：

- 闸门失效（`finally` 没复位）= 守卫永久停摆，且**工具面偏宽也不会报警**，这是最坏的一种。
  降级方向是「宁可多跑一次全量核对，也不要锁死」：异常路径一律复位，拿不准时按**未重入**处理。
- 快路读不到 `view().restrictableNames`（旧宿主、测试桩）→ 退回慢路（先 `release` 再读可见面）。
  正确性不变，只是回到「每次重算两次广播」；这时闸门是**唯一**的防线 —— 两层修法不能只留一层。
- 宿主将来给 `restrict()` 补上 `notify: false`（或不再因体积变更广播 `tools/change`），
  闸门与快路就退化成纯提速，原样保留即可。

### 协调者何时结束回合（软硬两半：人格 + 同名段遮蔽）

**现象**：派单之后协调者不停 —— 它反复去看 worker「跑到哪了」（`list_agents` /
`job_output`），用过程数据把等待填满。一个本该一轮结束的动作被拖成好几轮，
把上下文烧在**没有任何结论**的信息上。

**机制出处**：

- 宿主 `dsh-tool-subagent/lib/index.js:509-518` **无条件**注入一段系统提示
  （段名 `tool:subagent`、order `2800`），其中一句是
  「… continue useful work while they run」。该行的 Config 只有 `provider` / `toolName` /
  `modelSelectionSettings` / `agentOptions` / `agentPreset` / `allowedAgentPresets` /
  `maxDepth` —— **没有任何开关能关掉这段**。
- 协调者人格 `composition.mjs` 的第 3 步同样写着「keep working while they run」；
  修之前全仓库**没有任何一条**写着「无事可推进就结束回合」。
- 段落可以**按名字被更近的作用域遮蔽**：`dsh-system-prompt/lib/index.js:245-249` 明写
  "A scoped section shadows a global section with the same name"。同款先例是
  `worker-persona.mjs:264-268` —— 在**子代理 scope** 上用同名段盖掉上游那份。

**修法（两半，缺一不可）**：

- **软的一半**：协调者人格新增 `## Ending your turn after a dispatch`
  （`composition.mjs:185-193`）。它讲四件事：结束回合是**正确**动作；结论不会丢 ——
  worker 回报时运行时以**新回合**唤醒它；禁止拿过程数据填等待；以及**本条覆盖宿主那句**
  （"continue useful work" 只意味着「不要阻塞在派单上」，不意味着「必须继续产出回合」）。
- **硬的一半**：新增 `presets/multitask/coordinator-prompt.mjs`，在**协调者 scope** 上注册
  **同名段** `tool:subagent`（order `2800`）遮蔽宿主那份。目的不是重复人格，而是让**落点**
  与人格一致，而不是把两句矛盾的话一起交给模型裁决。判据与 `coordinator-guard.mjs` 同形：
  跳过 `isDelegatedChild`（worker 要的是「干活然后回报」，不是「结束回合」），
  且要求归属本 preset（活绑定优先，会话头 `agentPreset` 只作退路）。

**失效时的降级方向**：

- 遮蔽没装上（`systemPrompt` 服务缺席、`section()` 不存在或抛错）→ **静默降级**回宿主原语义
  （「边做边瞄」）。人格那半仍在，只是变成唯一防线，最坏结果是多刷几轮 —— 仍是可用会话。
- 反过来若这里抛错 → **该会话起不来**，那比多刷几轮严重得多，所以刻意 fail-open：
  绝不抛错、绝不阻塞会话创建。

### 子代理停滞看门狗（P1.5：把"静默卡死"变成可见事件）

**现象**：worker 陷在同一处反复改（典型是花括号增生 —— `A ? { … } : { … }` 越改越乱），
既不退回、也不报错，更不再产出任何东西。而父会话**收不到任何事件**：协调者按上一节的
纪律结束了回合，就再也不会被叫醒。整个任务停在半空，界面上看不出异常 —— 只能靠人肉
轮询发现。

**机制出处**：

- 宿主**没有任何**子代理步数上限、空闲超时或看门狗。`dsh-subagent/lib/index.js:2978-2981`
  那一行 Config 只有 `maxDepth` 与 `maxActiveSubagents` 两个数：一个限制深度、一个限制
  并发，**都与「跑了多久 / 有没有产出」无关**。
- 父会话只有两条通道能知道子代理结束了：`subagent/end`（`dsh-subagent/lib/index.js:199-206`）
  与结算通知（同文件 `:2040-2062`）。这两条都在子代理**真正 idle 时**才发 —— 卡死的 worker
  恰恰永远不 idle，于是两条通道一起哑掉。
- `dsh-repeat-tool-reminder` 不是替代品：它只认**同参数**的重复调用（`thresholds [3,5,8]`），
  「同一处来回改、每轮内容都不同」会被它当成一条新链并重置计数；而且它只提醒，**不终止**。

**修法**：新增 `presets/multitask/subagent-watchdog.mjs`，**在父侧**计时 —— 判据只能是
「多久没有活动」，而活动信号（`tools/post-execute`）在父 preset 的 scope 上就能收到：

- `agent/created` 时把「被委派出来的、且父会话组的是本 preset」的 worker 记进在册表。
  归属判据与 `coordinator-guard.mjs` 同形：先看父 agent 的**活绑定**，读不出来才退回子代理
  会话头的 `agentPreset`；两者都不成立就**不纳入**（拿不准时宁可不管 —— 把别的协调者正在
  等待的 worker 停掉，等于替另一个会话做决定）。
- 每次 `tools/post-execute` 刷新该 worker 的最后活动时间。**刻意不看调用内容**：一次长
  `read`、一次整树命令都是「它还在动」的确证，判据越粗越不会误杀。
- 每 `tickMs` 巡检一次；`now - at > stallTimeoutMs` 时**先从在册表删掉**，再调
  `subagents.interrupt(id, { kind: 'ancestor', agent: 父agent })`（父 agent 取不到时只给
  `kind`，由宿主按会话血缘判定）。先删后停，保证同一个 worker 只被处理一次。
- 停下会触发宿主的 `subagent-settled` 通知 ⇒ 父会话被唤醒 ⇒ 卡死从「静默」变成一条
  **可见的汇报**。这是本模块真正的目的：不是让 worker 少跑，而是让卡死有声音。
- 日志标记（可 grep）：`[MULTITASK-WATCHDOG-STALLED] child=<id> idle=<ms>ms`；首次纳入打
  `[MULTITASK-WATCHDOG-ENGAGED]`，跳过时打 `[MULTITASK-WATCHDOG-SKIPPED] … [reason=…]`。
- 配置：`stallTimeoutMs`（默认 `300000` = 5 分钟 —— 够长，长到不误杀正在长思考 / 长命令里
  的 worker；够短，短到卡死不至于把等待拖成整晚）、`tickMs`（默认 `30000`）、
  `interruptOnStall`（默认 `true`，置 `false` 时只报警不停人）。三项都由 `composition.mjs`
  那一行的 `config` 给默认值；**要改就改那一行并重启应用** —— profile 的 `cordis.patch.yml`
  **够不到 preset 声明内部的行**（`lib/index.js` 的 `applyGuardOverrides` 只按 id 匹配
  `coordinator-guard` / `workspace-acl`，只透传 `presetId` / `enabled` / `keep` / `extraDeny`），
  而且它的语义是**整份 config 替换**而不是合并：就算够得到，也会把 `enabled` / `presetId` 一起
  抹掉，看门狗随即以 `no-preset-id` 静默跳过。想按环境调阈值，正确做法是由 `lib/index.js`
  读一个环境变量再透传（与多模式开关同一条路）。`enabled: false` 时整行不动作。

**降级与已知边界**：

- `interrupt` 不存在（老版本宿主）或抛错 → **只记一条日志就退场**（fail-open，退回宿主原
  语义：卡死仍然静默）。绝不抛错 —— 把正常会话弄坏，比漏停一个 worker 严重得多。
- 「无活动」是**代理判据**，不是「卡死」的证明：一个长时间不调工具的正常长任务（长思考、
  等外部事件）会被判早。所以本模块只做「停下并把这件事交回父会话」，**不自动重派** ——
  重派会让同一个写入动作做两遍，而该不该重派要看报告与文件现状，那是协调者看得见、本模块
  看不见的东西。
- 若被判停的 worker 卡在**不可取消**的工具里，`subagent-settled` 也可能不来 —— 此时父会话
  仍不会被唤醒，只剩日志（`[MULTITASK-WATCHDOG-STALLED]`）可查，**仍需人看**。
- 清理是双通道的：定时器已 `unref()`（否则进程退不出去），并在 `ctx.on('dispose')` 与
  `ctx.effect` 上各挂一次停表（`stop` 幂等）。两条通道都缺席时最坏是进程里多一个定时器，
  不会阻塞会话。

---

## 卸载

**用包管理器装的**，就交给它：

```
dsh plugin --profile <profile> remove dsh-multitask
```

或在 DSH 的**插件**页面里卸载。

**从源码 checkout 装的**（profile patch 里那段 `- insert: - id: multitask`），
把那一整段手动删掉即可。

两种方式下，preset 都会从所有**新**会话的模式选择器里消失（已开跑的会话不受影响）。

不需要重启：DSH 会热重载这个 patch 文件，行被移除后插件被卸载，并在卸载时注销
自己那份 preset 声明（见 `lib/index.js` 的 `releaseOwn()` 与 `ctx.effect(() => () => …)`）。
如果模式仍然没消失，再重启应用，并检查日志里有没有 `dsh-multitask` 开头的警告。

想**临时停用**而不卸载，给这一行加 `disabled: true`（或用 `enabled: false` 关掉插件本身）：

```yaml
- id: multitask
  disabled: true
```

> ⚠️ 本包**没有**独立的宿主层设置需要单独撤回。若 profile patch 里残留
> `- id: subagent-model-selection-settings` 那一段（`enabled: false`，不生效），
> 它不属于本包当前的安装形态，可以手动删掉 —— **删前先确认没有别的 preset 依赖它**
> （见「已知边界」）。

---

## 包结构

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → 装载时插入 host 行；dsh.client → 浏览器半
├── cordis.patch.yml                    # 向 profile roster 插入 plugin 行（供 bundle 安装方式用）
├── LICENSE                             # MIT
├── README.md                           # ★ 面向使用者的说明（英文）
├── README.zh.md                        # ★ 面向使用者的说明（中文）
├── docs/
│   ├── DESIGN.md                       # ★ 本文件：设计推导 / 各项决定的上游依据
│   └── test_image/                     # README 引用的界面截图（文档素材，不是测试）
├── lib/
│   ├── index.js                        # host 半：激活时向 agentPresets 声明自带 preset
│   └── client.js                       # ★ 浏览器半：设置里的一级页「Multitask」两张卡 + 通用设置两行
└── presets/multitask/
    ├── composition.mjs                 # preset 组成 + 协调者人格 + 各模式 worker 人格
    ├── coordinator-guard.mjs           # ★ 减震器（含「模式隔离」归属判据）
    ├── subagent-mode.mjs               # ★ 多模式子代理：PTC 呈现（零依赖，零 import）
    ├── minimal-guard.mjs               # ★ subagent_minimal 的自适应收窄（零依赖，零 import）
    ├── worker-guard.mjs                # ★ 摘掉 worker 里「调了必被拒」的委派工具（纯省 token，零依赖）
    ├── approval-gate.mjs               # ★ 审批闸门：危险操作弹窗请用户裁决（零依赖，零 import）
    ├── interrupt-before-send.mjs        # ★ 纠错时序：拦 send_message，先停当前轮次再发送（零依赖，零 import）
    ├── preset-dispatch.mjs             # ★ 跨模式派发：把任务书投给任意已安装的 agent preset
    ├── workspace-acl.mjs               # ★ 工作区 ACL：补 WRITE_OWNER + 给既存子目录补齐盖章，让 shell 开箱即用（唯一改系统状态的模块，共两段写入）
    └── file-info.mjs                   # ★ 只读文件元数据工具 file_info（零依赖，零 import）
```

⚠️ `concurrency-guard.mjs` **不在**这份清单里，也不在仓库里 —— 并发上限只有宿主一个执行点，
本包不装这类守卫。

`package.json` 的 `files` 字段是上面这份清单里**随发布物分发**的那一部分（`lib` /
`presets` / `cordis.patch.yml` / `README.md` / `README.zh.md` / `docs/DESIGN.md` / `LICENSE`）。
**测试套件不在其中** —— 本包只发运行时真正需要的文件。

README 里引用的界面截图放在 `docs/test_image/`：它们是**文档素材**（不是测试脚本，所以不进
`test/`），**进仓库但同样不进发布包**。GitHub 上按相对路径直接渲染；npm 页面上的相对地址则由
npm 按 `repository` 字段指回本仓库（npm 文档写明 README 是「经 GitHub 的 API 渲染为 GFM」，
社区也一致如此报告 —— ⚠️ **本仓库没有逐字验证过这一条**）。所以图片进仓库即可，写进 `files`
只会平白给包添上 1.3 MB。

本包**不随发布物分发测试**，所以这份文档也不描述测试套件 —— 它只讲设计与行为。

---

## 改源码后如何生效

**结论先写在这里：改完源码要重启应用。只递增 `?v=N` 是不够的。**

**为什么**（依据是 `cordis-plugin-loader` 的加载路径，不是推断）：本包在工作区里，**不在** HMR 监视根下，所以改源码**不会**自动重载 ——
Node 的 ESM 缓存会继续返回旧模块。profile patch 文件**确实**被 HMR 监听（`dsh-hmr` 在
`cordis.patch.yml` 上装了 watcher，且 HMR 本身是启用的），所以改这个文件**会被感知**；
但**「被感知」不等于「会重新加载模块」**：

> `?v=N` 改的是这一行的 **name**，而 `cordis-plugin-loader` 对一个**已有 fiber（条目已在运行）**
> 的条目，看到「只有 `name` 变了」时走的是 `_patchContext(["name"])` 分支 —— 而它只在 diff
> **含 `config`** 时才 `fiber.update()`，否则**什么都不做**，**也不会 `import()`**。
> 只有**没有 fiber** 的新条目才会走 `await this.init()` 去真正加载模块。

于是 `entry.options.name` 被记成 `?v=N+1`（patch 文本确实落盘了），但**模块从未被重新 `import()`，
fiber 既没卸载也没更新** —— 进程继续跑旧的那一份。可这样核对：原地 bump `?v` → **import 调用 0 次**；
**新增条目** → **import 1 次**。

**所以正确的做法是两件事，其中第二件是必需的：**

1. **递增 `?v=N`**（写入 profile patch 时 `entry.options.name` 随之更新）；
2. **重启应用** —— 新进程**首次**加载该条目时没有旧的 fiber，才会真正读到你最新的源码。

```yaml
# 从源码 checkout 安装时，这一行的 name 形如（?v=N 就是那个缓存键）：
name: 'file:///<你的路径>/dsh-multitask/lib/index.js?v=6'   # ← 递增这个数字，然后重启
```

> 发布包安装方式（`node_modules` 里的 `dsh-multitask`）**没有**这个 query，
> 也不需要它：`node_modules` 的内容只在 pnpm 重写时变化。

> **不要把这条读成「`?v` 没用」。** `?v=N` 是 **ESM 的缓存键**，它的作用在**进程重启后依然成立** ——
> 重启后新进程读到的就是最新源码；它的价值是防止「同进程内 specifier 不变 ⇒ 命中旧模块图」。
> 准确的关系是：**`?v` bump 与重启是「或」不是「且」** —— **重启是必需的**，`?v` bump 是**良好卫生**，且无害。
> 保留这个习惯。

**推论：「在同一次保存里删掉又加回」也无效。** `EntryGroup.update()` 按 **id** 比对，
`multitask` 这个 id 在改动前后两张表里都在，拿到的是**同一个 `Entry`**，仍然只看到「名字变了」，
仍走 name-only 分支。**必须两次保存**（删 → 等稳定 → 加回），中间会短暂没有 preset。

四个坑，代码里都已绕开：

1. **相对导入不继承入口的 query。** 只给入口加 `?v=N`，入口刷新了，但它相对导入的
   `composition.mjs` 仍从旧缓存取 —— 改了 preset 文本却毫无变化、也不报错。
   本包显式把 query 逐层传播（入口 → `composition.mjs` → 每一个 `presets/multitask/*.mjs`
   模块，都经同一个 `local()` 拼接），所以**一次递增刷新整张模块图**。
2. **递增可能仍然不生效。** 如果更早的模块实例还占着 preset 声明，注册表会硬拒绝
   重复 id，而这个失败**只留一行 warn** —— 于是旧 preset 悄悄留在原地，看起来像"改了没用"。
   本包用进程级交接表让新实例接管旧声明；但**早于该机制**的实例无法被它触及。
   这时**重启**是最简单可靠的做法（会把进程里所有旧实例一并清掉）；要么把这一行删掉、
   保存、等应用稳定，**再保存一次**加回来（注意必须是两次保存，见上）。
3. **声明不变式收在 `declare()` 自己身上。** `declaring` 挡并发、`declared` 挡顺序，
   `release` 只管卸载时注销，`finally` 复位，晚到的兜底重试**照旧有效**。两条进入路径
   （主路径与 `ctx.inject` 兜底）因此都不会**自己撞自己**：`declared` 在落库成功即置位 ——
   有没有注销器都一样 —— 调用点守卫是 `!declared && !closed`。所以那条
   `is ALREADY registered by an older module instance` 的 warning **只在真被更早的实例占用时**
   才出现，是**可靠**的判据。边界：需注册表**违反自身契约**（接受了声明却不返回注销器）
   才触发，属低概率异常路径，且插件**本来就会 warn**。

---

## 已知边界

- **preset 只能在会话开始前选择。** 已开跑的会话无法切进来。
- **协调者看不见的东西，它也无法核对。** 保留只读工具就是为了让它能独立验证子代理的
  结论，而不是盲信。若你把 `read`/`grep`/`glob` 也摘掉，核实能力就没了。
- **`maxDepth: 1` 意味着 worker 不能再委派。** 超大任务需要你或协调者自己拆成并行任务书。
- **PTC 的「塌缩」是呈现塌缩，不是能力削减 —— 这是设计，不是缺陷。**
  `subagent_ptc` 的直接工具面确实只剩 `run_code` 一个，但那份 SDK 绑定表
  **仍然完整可调用**（从程序内部经 `tools.<name>(args)`）。上游在自己的提示词里逐字声明了
  这一点：`These declarations are SDK bindings for this program. A declaration does not make
  its name a directly callable tool; only names supplied as separate tool schemas may be
  called directly.` 砍掉 SDK 面会把 PTC 变成只能跑空程序的壳 —— 「一条程序顶一长串单次调用」
  正是这个模式存在的全部理由。**因此「PTC 里还能调 pwsh」不是漏判。**
- **PTC 的原生调用被拒时是「有指引的」，不是静默的。** 对 `run_code` 之外的名字发原生调用
  会得到一条 `isError` 结果，原文为
  `Error: unknown tool "pwsh": only run_code is callable directly — call pwsh from inside a
  run_code program instead` —— 它明确告诉模型该改走哪条路。⚠️ 但**如果那个 worker 压根没发起
  原生调用**（正常情形：它读了自己的工具面就知道不该发），那么会话里不会出现任何拒绝文本 ——
  此时「没有拒绝」是**没有触发**，不是「闸门静默」。判据是会话里有没有 `isError=true` 的
  `tool/result`，而不是有没有出现过那个字符串（worker 复述任务书时也会写出这些字眼）。
- **改源码后必须重启应用**（并习惯性递增 `?v=N`）—— 只递增 `?v=N` 对已在运行的条目是空操作，
  见「改源码后如何生效」；本包**没有**自动监听工作区源码。
- **子代理的模型由你在设置面板里按 worker 类型决定，AI 不能在会话里临时指派。**
  四行委派配置里没有 `modelSelectionSettings` 这类宿主层开关；profile patch 里若还留着
  相应的一段，它不生效，也不属于本包的安装形态。
- **子代理的 shell 需要工作区目录具备 `WRITE_OWNER`** —— 新工作区由插件自动补（见下节）；
  它不需要提权、不需要批准，也绝不该靠把目录放宽到 Full control 来解决。**既存子目录**
  还需要一次继承与 Low 标签的补齐（宿主那三样授权只在对象创建时继承，从不回溯），
  同样见下节。

### 子代理的 shell 什么时候整体不可用：工作区缺 `WRITE_OWNER`

**症状（逐字）。** 工作区缺 `WRITE_OWNER` 时，子代理执行任何命令都失败，错误原文：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区路径>)
```

（路径部分是该会话的可写根目录。）

**怎么认出它、以及为什么不是你的命令或并发数的错。** 下面每一条都是识别判据：

| 现象 | 说明 |
|---|---|
| 只有 **1 个**子代理在跑时照样失败 | **与并发无关** —— 不是撞上 8 那个容量上限 |
| 换成 `Get-Location` 这类无副作用命令**照样失败** | **与命令无关** —— 不是命令写错了 |
| 把命令的工作目录指到系统临时目录，报错里**仍然**是会话的可写根 | **与工作目录无关** —— 拒的不是命令要碰的那个路径 |
| 只读工具（`read` / `grep` / `glob` / `file_info`）**正常可用** | 只有「要执行/要写」的那条路被挡 |
| 有的工作区正常、有的全废 | **与工作区目录的权限有关** —— 见下 |

**真正的原因：工作区目录的权限里缺少 `WRITE_OWNER`。**

DSH 的 ACL 沙箱给工作区授权时，**一次**调用同时写三样东西（`info = 20` 把 DACL 与 SACL
合成一次写入）：能力 SID 的允许 ACE、Everyone 的 delete-child 拒绝、以及 **Low 完整性标签**。
关键在于**标签住在 SACL 里**，而写 SACL 需要 `WRITE_OWNER`；**所有者的隐式权限只覆盖
`READ_CONTROL` 与 `WRITE_DAC`**，不包括它。宿主文档自己写明了这条前置条件：

> Granted directories must be caller-owned and grant `WRITE_OWNER` … A directory whose DACL
> grants only Modify now fails the grant loudly instead of silently skipping the confinement.

于是**只给自己授了 `Modify` 的目录**会让整次调用失败，子代理的每条命令都报错。
这解释了那个不对称的现象：

- 盘符根通常只给 `Authenticated Users:(M)`（Modify），所以**直接建在盘符根下的目录天生带这个缺陷**；
- 用户目录（`C:\Users\<你>`）给的是可继承的 `(F)`，其下新建目录**天然满足** ——
  所以同一个插件在某些工作区一切正常、在另一些里全废。

**修法：补一条非继承的 `WRITE_OWNER` 即可，别的都不用动。**

**修复由插件自动完成，不需要使用者做任何事、也不需要批准。**
`workspace-acl.mjs` 在会话开始时检查工作区目录，缺 `WRITE_OWNER` 就**只补这一项**
（非继承的 `TakeOwnership`），然后停止。它按工作区每进程只尝试一次、幂等、失败绝不影响会话。

#### 补授权在什么时机发生

判据是「**这个 cwd 处理过没有**」，不是「是不是根会话」：`agent/created` 不对委派子代理
早退，重复触发由 `handled` 按规范化路径去重 —— 父会话补过时只查一次 `Set`，父会话没补时
子代理就是唯一还在的时机。

方向也要挑对：监听 `agent-preset/selected` 时**只处理「切进来」这一方向** —— 第二个参数是
新的 preset id，直接与 `config.presetId` 比较，参数缺席时才退回读注册表的活绑定。对切走的
会话补授权，等于给别的模式的 cwd 盖章，方向是反的（见「模式隔离」那一节）。

三处判据同源、缺一不可：`lib/index.js` 的 `applyGuardOverrides` 会同步 `workspace-acl` 的
`presetId` —— profile 把 `config.presetId` 改成别的值时，若只对齐减震器，上面那条判据会
静默失配，切换路径再次停摆。

**残余边界：跨模式派发的 worker 仍可能漏。** 事件按 scope 链派发，若 `subagent_preset`
产生的 worker 的 scope 链不包含目标 preset 的守卫（见「跨模式派发」那一节对四类守卫的
说明），本模块收不到它的 `agent/created` —— 那种情况下补授权仍要靠父会话那一跳，而父会话
若也不是本模式，就还是没人补。这一条与四类守卫的既有边界同源。

- **最小授权就是 `WRITE_OWNER` 一项**，不是 `(F)`、也不是 `Modify`。
  **绝不要为了这个把目录放宽到 Full control** —— 那会额外给出「改权限 + 夺所有权」，
  远超所需。而且 `WRITE_OWNER` 是**所有者给自己的**：目录所有者本来就能随时夺回所有权，
  所以这条 ACE 不扩大任何人的实际权力，只是把「所有者本可做的事」变成「沙箱可以做的事」。
- 它**不需要**提权、**不需要** `SeSecurityPrivilege`、**不需要**「一次已批准的受限外运行」。
  整个动作只是一次 DACL 写入，而目录所有者隐式拥有 `WRITE_DAC` —— 同进程即可完成。
- 想关掉：把该行的 `config.autoGrantWriteOwner` 设为 `false`。
- **开箱即用的做法**：把工作区放在用户目录下（那里天然满足）；盘符根下的路径则依赖上面的自动补。

**怎么核对自动补授权是否生效**：让子代理跑一条无副作用命令（如 `Get-Location`），应当
**退出码 0**、报错里没有 `grantWrite`；再跑 `icacls .` 看那条 ACE —— 本模块补出来的指纹是
**非继承的 `(WO,S)`**（`icacls /grant ...:(WO)` 只写出 `(WO)`，PowerShell 的
`AddAccessRule(TakeOwnership)` 写出 `(WO,S)`，两者并列即可分清是插件补的还是人手工改的）。

> ⚠️ **日志标识不落盘。** `MULTITASK-*` 走应用的日志流，DSH 不把它们写成文件
> （`~/.dsh/logs/` 下只有其它插件自己写的日志）。判定以 `icacls` 的实际输出为准。

**仍然失败时**，只有两种可能：目录**属于别的账户**，或它在当前进程**不可写** ——
此时那条 `WRITE_OWNER` 根本不会出现（`icacls <目录>` 里看不到 `(WO`）。

#### 既存子目录的继承与标签补齐（串行于补授权之后）

**问题：那三样授权只在对象创建时继承，从不回溯。** 宿主 `grantWrite()` 写下的三样东西
（能力 ACE、`Everyone:(CI)(DENY)(DC)`、`Mandatory Label`）都是**可继承**的，但继承只在
**创建对象**的那一刻发生。于是一个在插件发布前就存在的工作区会长期半残：根上三样齐全，
而 `.git` / `docs` / `lib` / `presets` / `test` / `.github` / `.cursor`（2026-10-27 创建）
**一条都没有**；只有之后新建的 `research`（2026-11-01 创建）齐全。

**这不是「权限偏紧」，是「命令直接失败」。** 沙箱 shell 跑在 **Low IL + 受限令牌**下
（restricting 列表只有 logon SID / `Everyone` / 能力 SID / 临时目录 SID，**不含
`Authenticated Users`**），它在那些目录上找不到自己认得的主体，于是建文件被拒：

```
fatal: Unable to create '.../.git/index.lock': Permission denied
```

（`git add` 是最常见的那一条，后面通常还跟着 `[sandbox: file access denied under
workspace-write mode]`。）**审批与它无关**：审批只决定「要不要问人」，不代表允许越出
沙箱。**插件对 git 没有专用通道** —— 闸门里只有六条 git 正则（`git-force-push` /
`git-reset-hard` / `git-clean-force` / `git-rewrite-history` / `git-remote-remove` /
`git-discard-worktree`），普通的 `git add` / `git commit` / `git push` **完全不问**，
`.git/` 路径零特判；闸门本身也只对委派子会话、父策略为 `ask` 时把 `allow` 升成 `ask`，
从不返回 `deny`，从不改沙箱。

**修法：三条 `icacls`，一次也不生成策略。**

| 顺序 | 动作 | 为什么是这一条 |
|---|---|---|
| 1 | `icacls <dir> /grant *<当前用户 SID>:(WO) /T /C /Q` | 写完整性标签需要对象上的 `WRITE_OWNER`（宿主 README 逐字承认；本仓库早前的本机实验也定论过） |
| 2 | `icacls <dir> /inheritance:e /T /C /Q` | 让既有对象重新继承父目录的可继承条目 —— 能力 ACE 由此获得，**不硬编码能力 SID** |
| 3 | `icacls <dir> /setintegritylevel "(OI)(CI)Low" /T /C /Q` | 与宿主一致的 Low 标签（目录带 `(OI)(CI)`，文件只落一条 Low） |

**顺序前提不可反**：第 2、3 条都要往对象上写安全描述符，没有第 1 条给的那个
`WRITE_OWNER` 就写不进去。路径只从 `$env:DSH_MT_ACL_DIR` 读，绝不拼进脚本。

**为什么不硬编码能力 SID、也不发明策略。** 子目录缺的不是一条新规则，而是一次
「重新继承」：这三样**根的 DACL / SACL 里已经写着**（宿主写的）。让对象去继承根上那一份，
宿主改主意（换能力 SID、换标签）时子目录跟着变；反过来，若插件自己生成一条 ACE，它会
在宿主换策略后变成一个**没人负责的残留**。同理，`Everyone:(CI)(DENY)(DC)` 一并继承下来
是**与新生工作区对齐**，不是本插件新增的策略 —— 今天新建一个工作区本来就有它。若它在
`.git` 里影响 `git gc` 这类「删子项」的动作，那对所有新工作区同样存在，不是这一步引入的。

**时机、快筛与幂等。** 它在 `ensureWriteOwner` **之后**串行执行（顺序不可反），每个 cwd
每进程一次。动手前先做**只读快筛**：逐个**直接**子目录读一次 `icacls`（icacls 不接受一次
传多个名字，本机实测），全部已带 `Mandatory Label` 就打印 `SUB-OK` 早退，**一次写入都不做**
—— 修好之后每次会话只付这几次只读调用。

**开关与失败取向。** 默认开启，`config.autoRepairStampedChildren: false` 关掉这一段，
与 `autoGrantWriteOwner` **相互独立**。超时单独放到 `REPAIR_TIMEOUT_MS`（120 秒），仍走
`runPowerShell` 唯一出口。失败 **fail-open**：只记日志，绝不抛，绝不阻塞会话 —— 最坏
退回「子目录继续被拒」这个今天的行为。标识：`MULTITASK-WORKSPACE-ACL-SUB-OK` /
`-SUB-REPAIRED` / `-SUB-SKIPPED` / `-SUB-FAILED`。

**已知代价。** 老工作区第一次会给既存对象各加一条 `(WO,S)` ACE；`/T` 是整树操作，带
`node_modules` 的大工作区第一次是几百毫秒到十几秒的遍历，之后靠快筛短路。

> ⚠️ **未实测项（如实列出）。** 本仓约束是「只读不写 ACL」，所以下面几条**没有在本机执行过**：
> `/inheritance:e` 与 `/setintegritylevel` 的实机落点（参数形态取自本机 `icacls /?` 与只读
> `icacls` 输出）；`/T` 与**重解析点**（junction / symlink）相遇时的行为；把 `(NW)` 标记当作
> 输出本地化兜底的识别方式；以及「根还没被宿主盖过章」的全新工作区首次会话可能只来标签、
> 不来能力 ACE 这个顺序前提（按宿主时序推断）。判定仍以 `icacls` 的实际输出为准。

### ⚠️ 护栏：DSH 自己的目录绝不能被盖章

本模块在**补根目录 `WRITE_OWNER`** 这一步只写一条 `TakeOwnership`；随后的既存子目录补齐会给这些对象
补继承与 Low 标签 —— 但让 DSH 自己的目录被盖章的仍然只有前者，所以下面五条护栏一条都不能少。
补齐 `WRITE_OWNER` 会让宿主 `AclSandbox.init()` 的 `grantWrite()` 从失败变成成功，而那次调用是
**一次写入三样东西**（`info = 20` 把 DACL 与 SACL 合成一次写）：

1. 能力 SID 的允许 ACE；
2. **`Everyone:(CI)(DENY)(DC)`** —— 拒删子项，且**向下继承到每一个子目录**；
3. **`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`** —— 低完整性标签。

第 2 项是关键：它是**显式 deny**，而 deny 先于 allow 求值 —— **连所有者的 `FullControl`
也压不住它**。落在 DSH 自己的目录上，后果不是「某个 worker 干活失败」，而是
**DSH 用普通权限起不来**：子目录被拒删，换包 / 清理 / 更新就会失败，表现正是「普通权限
起不来、管理员可以」（管理员能夺所有权绕过 deny）。

所以本模块有一条 `sensitiveReasonFor()` 护栏：命中下列任一条就**跳过**（不是「照做但告警」——
跳过最坏退回「shell 起不来」，那是可解释、可绕过的状态；照做的代价是 DSH 装不回来）：

| 原因标识 | 判据 | 为什么 |
|---|---|---|
| `drive-root` | `H:\` / `C:\` | 盖章会继承到整块盘 |
| `contains-running-app` | cwd 是 `process.execPath` 的祖先 | 那是安装目录，里面有正在运行的程序 |
| `dsh-state-dir` | `~/.dsh` 及其子目录 | 里面是 profiles / node_modules / sessions |
| `ancestor-of-dsh-state` | `%USERPROFILE%`、`C:\Users` … | 给祖先盖章等于把范围放大到整个用户目录 |
| `system-dir` | `%SystemRoot%` / `%ProgramFiles%` / `%ProgramData%` | 系统目录 |

这张表由测试锁定（`workspace-acl-guard-mutation.mjs` 的变异用例）。

**协调者与 worker 应当怎么做。** 三条人格里已写明（`composition.mjs` 的
`COORDINATOR_PERSONA` / `WORKER_PERSONA` / `FORK_PERSONA`）：认出它、**别在循环里重试**、
**别自己去跑任何权限命令**、也**绝不把目录放宽到 Full control**；若仍被拒，
就把那个具体原因（哪个目录、自动补没落地）如实报给用户，并改走只读 + 文件编辑的路。
对使用者来说：

- 「读文件、查元数据、改文件」这类任务**始终派得出去**；
- 「跑构建、跑测试、执行命令」在自动补落地后**照常可用**；仍在被拒时说明上面那两种可能，
  而不是「减震器装错了位置」或「子代理坏了」—— 那两种解释在只读路径仍然可用这一点上就站不住。
