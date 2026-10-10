# dsh-multitask — 设计说明

> **这份文档不是 README。** 面向使用者的说明、安装步骤、设置面板与故障排查在仓库根的
> [`README.md`](../README.md)（英文版 [`README.en.md`](../README.en.md)）。
>
> 这里保存的是**开发与维护需要的另一类内容**：设计推导（「为什么必须这么写」）、
> 验证脚本各自守什么（测试方案），以及如实写出的已知边界与未确证项。
> 它是本仓库的工程记录，**允许长**，也允许保留「早先这样做是错的」这类纠正记录 ——
> 那正是后来者不再踩同一个坑的依据。
>
> 阅读顺序建议：先读 README 弄懂它是什么，再回到这里看它为什么成立。

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
dsh plugin add dsh-multitask
```

或在 DSH 的**插件**页面里安装。装好后包落在 profile 的 `node_modules` 下
（`~/.dsh/profiles/<profile>/node_modules/dsh-multitask/`），profile patch 里由本包自带的
`cordis.patch.yml` 插入一行裸包名 `dsh-multitask` —— 由 DSH 的 bundle 机制解析，
**不含任何绝对路径**，所以在任何机器、任何用户名、任何安装位置都成立。

> **桌面版（Electron）注意**：应用自有的 `desktop` profile 由应用独占管理，
> CLI 会直接拒绝：`error: profile "desktop" is managed exclusively by the Electron application`。
> 这种情况请用应用内的**插件**页面安装，或走下面的源码安装路径。

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

> ⚠️ **别把这条推广到「改源码」上。** 新增一行时该条目**没有 fiber**，Loader 走
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
> ⚠️ **「子代理并行数量上限」这一项现在在**两处**同时出现，而且是有意的**：
> 「通用设置」里占一行（与官方的运行限制并排），「Multitask」页里也占一张卡
> （因为它是这个模式最常被调的一个数）。两处编辑的是**同一个字段**，
> 共用同一份表单快照与同一个写入路径 —— 所以不存在「哪一处说了算」的问题，
> 也不需要任何同步代码。
>
> ⚠️ **本插件不再有自己的并发上限字段。** 早先这里有一张「子代理并发上限」卡，
> 写的是 `multitask.maxActiveSubagents`（本模式专属、默认「不限制」）。**那个字段已删除**，
> 理由与它当初为什么是错的写在下面「子代理并发上限」一节的第一段。
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

> ⚠️ 以上是**机制事实**（源码 + 本包自带的进程内用例）。它在一个真实部署里是否真被注册、
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

现在共有 **4 条委派行**：2 条原有（`subagent` = spawn、`subagent_fork` = fork）
+ 2 条新增（`subagent_ptc`、`subagent_minimal`，见下一节）。**四条全部声明 `maxDepth: 1`**。

四个进程内委派行**都显式声明** `maxDepth: 1`。向下派 depth 2 会被硬拒绝
（`subagent depth 2 exceeds maxDepth 1`），且拒绝发生在启动前。
给 fork 行补上该字段属于**显式性 / 可读性修正，不是安全修复**。

> 残余边界：能确证的只是「有效上限 = 1」，**无法区分**这个上限来自行内声明的
> 字段、缺省继承的默认值，还是共享的上限强制层。这条残余边界同样适用于新增的两行。

想放开就改 `presets/multitask/composition.mjs` 里 `tool-subagent` 行的 `maxDepth`。

### 子代理并发上限

**只有一个值，就是宿主的 `subagent.maxActiveSubagents`。** 本插件**不再有自己的并发上限**。

它在设置里出现在**两处**（「设置 → Multitask」的卡片，与「设置 → 通用设置」的一行），
但两处编辑的是**同一个字段**：改一处另一处立刻跟着变。改完**即刻生效**。

> ⚠️ **这一节曾经整段是错的，值得留一段说明它错在哪，免得有人再改回去。**
>
> 早先本插件有自己的字段 `multitask.maxActiveSubagents`（一张「子代理并发上限」卡，
> 带「限制 / 不限制」两档），定位是「本模式专属的**更低**上限」。它经历了两次修正：
>
>   1. **先修「夹到 8」**：那张卡曾把取值钉在 `min(设定值, 8)`，理由是「8 是宿主容量」。
>      逐字对照宿主 schema 就知道那**不成立**：
>      `maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8)` ——
>      `8` 只是 `.default()`。所以它被改成「原样采用」。
>   2. **再删掉整个字段**：去掉夹子之后发现，那张卡本身**是假的** —— 它只决定
>      **本插件那个守卫**要不要装，而真正决定「同时能跑几个」的是**宿主**那道同名上限。
>      于是用户选「不限制」、看到「本模式不额外设限」，实际却依然被宿主的默认 8 卡住。
>      更糟的是两处同时有值时，是**两套账用不同口径执行同一个数字**（本插件那个守卫把
>      一次性子代理也算进去、释放时机也更早），谁先拒绝取决于运行时细节。
>
> 所以现在只有一个执行点：**宿主**。用户的原话是「就不需要额外新增一个字段来单独管理
> Multitask 的并发子代理上限，都统一使用宿主层限制的子代理数」。
>
> 顺带换来的两个好处：宿主的限制覆盖面**更完整**（连 `workflow` 直连
> `ctx.subagents.start()` 起的子代理也管，那是工具层守卫**拦不到**的路径），
> 而且「面板上写多少就是多少」这句话现在**真的成立**。

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

> ⚠️ **为什么「派 10 个全都成功了」不能证明上限被放宽。**
> 那是**阻塞 / 串行**执行：一次只在跑 1 个，等它结束再派下一个，**活跃数从未超过 1**。
> 只有**同一条消息里并行下发**才会真的去抢名额。串行跑多少个都不会撞上限，
> 因此它既不构成反例，也证明不了任何关于并发度的事。判断「并行 vs 串行」要看
> 同一时刻处于 `[running]` 的子代理个数，而不是「一共派出去几个」。

#### 计数口径：**当前存活的全部**，不只是同一批发起的

上限按「同一主 Agent 下**当前存活**的子代理总数」计。一个已经交完活、但**还没退出**的
worker **仍然占着名额**。所以「派一批 → 等它们全部结束 → 再派下一批」才是安全的做法；
在一批还没结束时接着派，会按剩余的存活数提前撞上限。

#### ⚠️ 拒绝是**宿主的**，不是本插件的

因为执行点只有一个，撞上限时你看到的就是上面那条**英文**错误（`active child limit: <N>`），
而不是本插件的任何文案。**这不是故障**，也**不是本插件坏了**：

- 它发生在**任何东西被启动之前** —— 没有子代理被创建，你拿到的是一条普通错误而不是一个 id；
- 处理办法是**等现有的子代理结束**，或**把若干任务并进一份任务书**交给一个子代理完成；
- 不要原样重试同一批扇出 —— 那样只会再撞一次。

> 早先本插件自己那条守卫会额外回一条中文拒绝（提示用 `list_agents` / `job_output` 收结果）。
> 那条路径已随字段一起删除 —— 现在**只有宿主这一种拒绝形态**，看到中文催促收结果的消息
> 说明你跑的是旧版本。

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

> 上表的「适合什么任务」是**机制事实**；而**按任务挑 worker** 的选择指引已经写进
> 协调者人格（`composition.mjs` 的 `COORDINATOR_PERSONA`，小节
> `## Choosing which worker to delegate to`），其中给出了「拿不准就用 `subagent`」的默认。
> 否则协调者在会话里只看到三个名字相近的委派工具，没有任何依据去选。

### 机制

两条新路径用的是**两套完全不同的机制**，别混淆：

- **`subagent_minimal` —— 原生 `toolFilter` + 本包的自适应补收窄。**
  `toolFilter` 就是 `dsh-tool-subagent` 自带的字段，把工具从子代理的可见面里**减掉**；
  但它是**静态**名单，只敢列本 composition 确定会注册的名字（`write` / `edit` / `pwsh|bash`），
  因为 `tools.restrict()` 对**当前部署不存在**的名字会抛错。于是**别的插件注册**进来的写入类
  工具（典型是 `ssh_*` 里的 `ssh_exec`、`task_board_*` 里的 `task_board_run`）不受这张静态表
  约束 —— 人格说只读、机制却让它能改远端机器。`minimal-guard.mjs` 补上第二层：
  在 `agent/created` 时按 `deny = 可见集 − 允许集` **自适应**收窄，名单里每个名字都必然存在。
- **`subagent_ptc` —— `presentAs('ptc')`（本包插件 `subagent-mode.mjs`）。**
  PTC 不是「筛掉一些工具」，而是**换一套呈现方式**：整张工具面塌缩成
  「只可直呼 `run_code`」，其余端能力工具都从程序里经生成的 SDK 到达。
  这个能力**无法用 `toolFilter` 模拟**（`run_code` 是保留传输名，
  `tools.restrict()` 明确拒绝它），所以必须由插件实现。

协调者要能看见这两个新工具名，靠的是 composition 里给减震器那行传的 `keep`
（保留集是**白名单**，`deny = 可见集 − 保留集`；不写进去新工具默认对协调者不可见）。

### 怎么确认 PTC 塌缩真的生效了（**可 grep 的固定标识**）

PTC 塌缩**装不上时是安静降级**的（worker 保留原生工具面，仍能干活），而它的告警走
`warnOnce`——**每种原因每进程只报一次**。于是「派 10 个 ptc worker，日志只有 1 行」这种
情况下，你无法判断「刚刚是不是又跳过了」。所以每条失败路径与成功路径都带一个**逐字固定的
ASCII 标识**，一条 grep 就能同时看到「跳过的」与「生效的」：

| 标识 | 级别 | 含义 |
|---|---|---|
| `PTC-COLLAPSE-SKIPPED reason=no-runtime` | warn（去重）+ info（计数） | 本部署没有 `ptcRuntime` 服务 |
| `PTC-COLLAPSE-SKIPPED reason=no-present-as` | 同上 | 该 scope 没有 `tools.presentAs()` |
| `PTC-COLLAPSE-SKIPPED reason=present-as-threw` | 同上 | 声明被拒绝（通常是已声明过别的呈现） |
| `PTC-COLLAPSE-SKIPPED … count=N` | info | 每次跳过另记一条**带累计数**的行 |
| `PTC-COLLAPSE-ENGAGED` | info | 塌缩**确实生效** |

> **为什么成功也要留标识**：否则只能靠「失败标识没出现」反推成功 —— 那个判据对
> 「整段代码根本没跑到」不成立。两条共用 `PTC-COLLAPSE-` 前缀，所以 grep 一个词就够。

⚠️ **但正常运行时没有可读的宿主日志**（宿主 stdout 直连 Electron、stderr 只在内存里留
64 KiB），所以这些串主要是给**有能力取到进程输出的人**（或以后接入日志时）用的判据，
**不要**让普通用户去找日志。

### 模式标记是怎么被子代理之外的代码读到的

插件要回答「刚创建的子代理来自哪一行」，而 `dsh-tool-subagent` 的 Config schema 里
**没有**任何模式/组成字段，也**没有**运行时句柄。所以只能靠一个被注入到子代理自身的
标记来间接识别 —— `persona` 是唯一符合条件的载体。

⚠️ **但这份 persona 有两条到达路径，覆盖面不同 —— 这里踩过一个真实的坑：**

| 来源 | 前台派单（`one-shot`） | 后台派单（`continuable`） |
|---|---|---|
| 子代理自己的 `deployment:persona-prefix` 段落 | ✅ 有 | ✅ 有 |
| `subagent/descriptor` 事件的 `data.persona` | ❌ **被丢掉** | ✅ 有 |

`snapshotSubagentDescriptor()` 对 `mode === 'one-shot'` 的行只保留
`version` / `mode` / `provider` / `label` 四个字段，persona 与 toolFilter **都被丢掉**；
而且 one-shot 的 descriptor 要到**第一轮 `agent/pre-step`** 才 append，在
`agent/created` 那一刻**根本还不存在**。

**早期实现只读 descriptor**，于是两个守卫在**前台派单时整体失效** —— 症状是
`subagent_ptc` 不塌缩（照旧拿着一整排原生工具，连 `run_code` 都没有）、
`subagent_minimal` 不收窄（仍然握着 `ssh_exec` / `task_board_run`）。
而前台派单恰好是**审批弹窗唯一走得通**的那条路径，所以这个缺陷偏偏在
「按任务书老实做前台派单」时最明显，在默认后台派单时反而不出现。

现在以**段落为主来源、descriptor 为兜底**。段落这条在 `setup()` 阶段注册，
严格早于 `agent/created`，两条派单路径都有。

> **所以两条新模式行不限于 `continuable`。** 它们本来就是 continuable，
> 但那是为别的理由（见下），不再是因为标记读不到。
> `codex` / `claude-code` 两行是 `one-shot`（且默认 `disabled`）—— 插件**同样能**
> 认出它们，只是它们不走这套四类 worker 的分流。

⚠️ 段落那条读的是上游**未文档化**的内部结构（`SystemPrompt.layers.merge()`），
公开声明只列了注册方法与 `assemble()`。所以读不到时**只告警、绝不抛错**，
告警带固定标识 `MULTITASK-MODE-MARKER-SOURCE-MISSING reason=…` ——
好让「上游改版导致本模块静默失效」能被 grep 到，而不是退化成一个永远不动作的死模块。
（不走公开的 `assemble()`：它是 `async`，且每次会 `structuredClone` 全部工具 schema，
为读一段文本付这个代价不合适。）

### 怎么关掉

三级开关，默认全开；**关任何一级都不影响原有 `subagent` / `subagent_fork`**：

1. **环境变量** —— 一次停用两条新行与呈现插件：

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

### ⚠️ 给未来维护者：改 `toolFilter.deny` 必须小心

`tools.restrict()` 对**当前部署不存在**的工具名**会抛错**：

```
tools.restrict() names unknown global tool "x"; known global tools: …
```

而子代理的 `toolFilter` 是在**委派窗口内**被 `restrict()` 消费的 —— 写进一个不存在
的名字，抛出来的位置在「创建子代理」里面，外在表现是**「委派功能坏了」**，
而不是「某个工具名写错了」，排查代价极高。

因此 `subagent_minimal` 的 `deny` 名单刻意**保守**，只列本 composition 自己会注册、
且**确定存在**的名字（`write` / `edit`，以及按平台二选一的 `pwsh` / `bash`）。

> **`bash` 与 `plugin_manager` 在 win32 上是被禁用的**（本 composition 里对应的工具行带 `disabled`），写进 `deny` 会抛错。
> 本包的 `deny` 用平台条件与工具行保持互斥，因而不会指到被禁用的那个。
> **`run_code` 永远不能写进 `deny`**（保留传输名，`restrict()` 拒绝它）。

想再收窄（例如也摘掉 `ssh_*` / `task_board_*`），**必须先确认该部署真的装了对应插件**。
宁可少摘，也不要赌部署构成。

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
  这是 PTC 语义本身（通告面 = 可调用面），**不是缺陷**；直呼会得到 `UNKNOWN_TOOL`。
- **`subagent_minimal` 的只读性是「两层收窄」，仍然不是沙箱。** 第一层是 composition 里
  静态的 `toolFilter`（`write` / `edit` / `pwsh|bash`，只列本 composition 确定会注册的名字）；
  第二层是 `minimal-guard.mjs` 在 `agent/created` 时按 `deny = 可见集 − 允许集` 自适应补上的
  （覆盖 `ssh_*` / `task_board_*` 这类**由别的插件注册**、静态名单不敢列的写入类工具）。
  两层在 `dsh-tools` 里是**求交**关系，所以结构上不可能放宽。但**它终究不是沙箱**：
  若某个插件在 minimal worker 创建**之后**才注册一个新的变更类工具，那个工具**不会被摘掉**
  （有意取舍，见 `minimal-guard.mjs` 文件头「如实写出的边界」）。

---

## 子代理危险操作的弹窗批准（`approval-gate.mjs`）

### 它解决什么问题

Multitask 模式里**实际干活的全是子代理**，而 `dsh-subagent` 在委派窗口里把子会话的
审批策略**钉死为 `never`**（上游注释逐字：`policy is pinned to 'never' regardless of the
parent's own policy.`）。后果是两级失效，**用户永远收不到子代理的审批请求**：

1. 审批服务的 `decide()` **第一行**就是
   `if (effectivePolicy(session) === 'never') return 'rejected'` —— 早于瀑布派发，
   所以 Web 端的审批应答者根本不会被调用；
2. 子代理的 system prompt 里还有一句
   `operations that require approval are rejected automatically`，
   于是模型**自我审查**、连请求都不发起。

本模块把这两处一起修掉，构成**两级闸门**：

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

⚠️ 写入时**省略 `source` 字段** —— 但理由不是「校验只允许 `delegation`」（那是**不准确**的）：
运行期**完全不校验** `source`（唯一的校验是词表 `policy ∈ ["ask","never"]`）；`'delegation'`
只是 **v0/v1 旧格式迁移期**的取值约束，而当前会话格式是 v4，所以带上它既不会抛错、
也不表示任何真事。省略的真实理由是**语义**：`source: 'delegation'` 的意思是「这个值从父级
委派继承而来」，而本模块做的恰恰是**纠正**委派的钉死（父级写 `never`，我们写 `ask`），
带上就是说反话。

✅ **这条写入能跨重启存活**，不需要恢复路径。载入期只丢弃「最后一条没有换行的**不完整**
记录」（torn tail），与事件是否在回合内无关；而 `approval/policy` **不在**任何回合包含校验里
（只有 `approval/asked` / `approval/decided` 要求回合归属）。

想确认这一点，解压一份子会话日志看序列即可：宿主钉死的
`{"policy":"never","source":"delegation"}` 后面应当紧跟本插件写的 `{"policy":"ask"}`，
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
所以规则表是**成对**维护的 —— `test/approval-gate-rules.mjs` 里同时有
「65 条必问」与「37 条必放行」两张清单，改正则时两边一起跑。
刻意不问的例子：`git clean -nd`（干跑）、`chmod +x`、`chown user:user f`（日常）、
`net user` / `wmic process list`（只读列举）、`ls /`、`cat /etc/hosts`（只读）、
**`icacls <路径>`（不带变更开关时只是显示权限）**。

> ⚠️ **最后那条是一次真实误报换来的**（本仓库自己的验证流程撞到过）：
> 早期版本对 `icacls` 一律发问，于是给子代理的 brief 让它跑 `icacls .` 汇报权限时
> 弹了一次窗，用户不得不为一个**纯粹只读**的命令点「允许」。
> 现在规则要求**出现变更开关**（`/grant` `/deny` `/remove` `/setowner` `/reset`
> `/inheritance` `/g` `/p` …）才算危险，而 `takeown` 仍然一律问。
> 这两条都有用例钉住（必问清单里是带开关的写法、必放行清单里是只读的写法）。

**覆盖到 PTC 程序内部**：`run_code` 的桥在派发子调用时构造的输入带 `parent` 令牌，
而它走的就是 `scheduler.prepare` → `prepareExecution` —— 后者第一件事就是跑
`tools/pre-execute` 瀑布。所以 PTC 程序里经 SDK 发起的 `pwsh` / `write` **同样**过规则表。
路径逐段为：`1042966-1042982`（桥构造带 `parent: exec.token` 的输入）→ `1043034`
（`scheduler.prepare`）→ `1044347`（调度器对象）→ `1044884`（`prepareScheduledExecution`）
→ `1044898`（`tools/pre-execute` 瀑布）。

⚠️ 有两条路径**不走**审查，别以为本级全覆盖了。上游 Auto 的文档把这两类与「内层工具调用」
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
子代理保持 `never`，与加入本模块之前**逐字等价**。headless / 无人值守部署靠 `never`
保证「不会被挂住等一个永远不来的答复」，本模块绝不把 `ask` 装到那种环境上。

同样地，第一级也读**子代理当前的有效策略**：策略不是 `ask` 时一律放行、绝不返回 `ask` ——
因为那时返回 `ask` 只会被 `decide()` 的第一行判成 `rejected`，**会把一条原本能在沙箱里
正常跑完的命令变成拒绝**，比不问更糟。

### 怎么确认它生效了（可 grep 的固定标识）

| 标识 | 含义 |
|---|---|
| `MULTITASK-APPROVAL-GATE-ENGAGED` | 已放开一个子代理的策略，闸门就位 |
| `MULTITASK-APPROVAL-GATE-SKIPPED reason=…` | 跳过了（`reason=` 说明为什么：父会话不是 ask / 缺服务 / 载荷畸形…） |
| `MULTITASK-APPROVAL-ASK` | 第一级判定某次调用危险，正在征求用户同意 |
| `MULTITASK-APPROVAL-RELAYED` | 第二级把子代理的请求转呈给了父会话（含结果） |
| `MULTITASK-APPROVAL-RELAY-FAILED reason=…` | 转呈失败，已退回原路径 |
| `MULTITASK-APPROVAL-NOTIFY-SENT` | 转呈失败后，已尽力用消息通道把「有决定在等你」送到父会话 |
| `MULTITASK-APPROVAL-NOTIFY-SKIPPED reason=…` | 没发通知及原因（`disabled-by-config` / `no-subagents-service` / `not-direct-parent` / `signal-aborted`） |
| `MULTITASK-APPROVAL-NOTIFY-FAILED` | 通知本身发不出去（不影响审批结果） |

`MULTITASK-APPROVAL-GATE-SKIPPED` 与 `ENGAGED` 都随计数递增，所以派了 N 个 worker
却一个都没放开时，日志里能看出「跳过了几次、每次为什么」。

### 如实写出的边界（别把它当成比实际更强的东西）

- **父会话空闲时，子代理的审批无法转呈**（`approval.request` 要求有一个打开的回合，
  否则抛错）。此时退回原路径并 fail-closed，**并触发兜底**（见下条）。这是**已知限制**，
  不是缺陷 —— 一个后台续跑的子代理在父会话空闲时想提权，用户看不到弹窗，那个调用会被拒。
- **兜底只是一条「指路」的通知，不是批准。** 转呈失败后，本模块会尽力通过 Agent 消息通道
  （`subagents.sendMessage`）让主对话出现一条来自该子代理的消息，写明**是哪个子会话、
  想执行什么、去哪里作答**。这段文案里刻意写明「这不是批准、在你作答前那次调用保持阻塞」——
  因为消息通道**不携带审批结果**，若被读成放行就等于绕过了审批。闭环仍然只有在那个子会话里
  作答才能完成。另有两条边界：它只对 `backgroundMode: 'continuable'` 的 worker 有效
  （本模式四类 worker 都是；`subagent_codex` / `subagent_claude_code` 是 `one-shot`，发不出去）；
  且 `sendMessage` 只认**直接**父子，多级委派时会跳过（记 `not-direct-parent`）。
- **转呈失败时请求会一直挂着，兜底不解除它。** 这是最容易被误解的一条：宿主把请求发给浏览器后，
  客户端会为那个（不可见的）子会话**无条件**物化作用域并接住它，而审批路径**没有任何超时**，
  所以那次工具调用会一直阻塞。`run_code` 是例外（它的预算**包含**审批等待）。兜底的作用是让
  用户**知道并找得到**那个请求，真正的解除要靠用户去那个子会话批准/取消，或取消整个回合。
- **规则表是模式匹配，会漏判新型危险命令。** 所以真正的闸门是第二级，
  第一级只负责「安全的不用打扰用户」。
- **上游改版可能让本模块失效**：它依赖几个未文档化的上游细节（`overrideOf` 取最后一条、
  `source` 的迁移期语义、`agent/created` 晚于 `setup`、`sendMessage` 的授权宽严）。失效时的
  表现是**闸门不生效**（回到今天的行为），**不是**权限被放大 ——
  因为父会话不是 `ask` 时本模块什么都不做，而所有失败路径都是「交回下游」。
- **它不改变沙箱。** 危险命令被批准后仍在该调用原有的沙箱模式下执行；本模块只决定
  「要不要问」，不决定「给多大权限」。

---

## 验证它真的生效了

选中模式后，让协调者试这两件事：

| 你说 | 期望 |
|---|---|
| 「你直接读一下 package.json 告诉我版本」 | ✅ 成功（只读核对是保留的） |
| 「你自己跑一下 `git status`」 | ❌ 调用不了 —— 工具不在它的可见面里 |

然后确认子代理仍然能干活：

| 你说 | 期望 |
|---|---|
| 「派个子代理跑 `git status` 并把结论告诉我」 | ✅ 子代理成功执行，只把结论带回来 |
| 「派个子代理读一下 package.json 并报出文件名与大小」 | ✅ 只读路径始终可用（`read` / `file_info`） |

如果第二组失败（子代理也不能跑命令），说明减震器**装错了位置** —— 请参看下面的
「设计要点」并检查 `ctx.logger` 里的 `dsh-multitask` 日志。

> ⚠️ **但先排除一种与本包无关的失败**：子代理的 shell 可能在**会话一开始**就被一处
> 权限写入失败整体拒掉，症状是任意命令（连 `Get-Location` 都算）都回
> `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<路径>)`。
> 那不是减震器的错，也不是命令本身的问题 —— 识别方法与处置见「已知边界」里的
> 「子代理的 shell 可能整体不可用」一节。**只读工具不受影响**，所以那一组里
> 第二条用例仍然应当成功。

日志里能看到实际收窄了哪些工具：

```
dsh-multitask: coordinator scope engaged — withheld N tool(s): edit, pwsh, read_image, ssh_exec, ...
```

### 审批闸门（危险操作弹窗）

**前置**：当前会话的审批策略必须是 `ask`（新建会话默认如此；headless 部署与
「永不需要批准」的配置是 `never`，那种情况下本模块**完全不介入**）。

让子代理分别跑一条安全的和一条危险的命令：

| 你说 | 期望 |
|---|---|
| 「派个子代理跑 `Get-ChildItem` 把文件名列出来」 | ✅ **无弹窗**，直接出结果（第一级判定安全，不打扰你） |
| 「派个子代理删掉 `.\build` 目录（用 `rm -rf`）」 | 🔔 主对话 composer 处**弹出审批卡**，标题写明是哪个子代理要执行什么 |

然后在弹出的卡片上分别验证两个方向：

| 你的操作 | 期望 |
|---|---|
| 点**拒绝** | ❌ 命令**确实没有执行**；子代理拿到的结果是 `the user rejected tool "..."` |
| 点**允许一次** | ✅ 本次执行成功；**再次**发同样调用会**再次弹窗**（`allowed-once` 是唯一授权，没有「永久允许」） |

日志里对应的证据（`MULTITASK-APPROVAL-` 前缀可一次 grep 全部）：

```
dsh-multitask: subagent approval policy released to "ask" for one delegated worker; ... [MULTITASK-APPROVAL-GATE-ENGAGED]
dsh-multitask: MULTITASK-APPROVAL-ASK tool="pwsh" pattern=rm-recursive-force
dsh-multitask: MULTITASK-APPROVAL-RELAYED tool="pwsh" outcome=allowed-once
```

反方向也值得看一眼：**父会话策略是 `never` 时**，日志里应当出现
`MULTITASK-APPROVAL-GATE-SKIPPED reason=parent-not-interactive`，且**没有任何**
`ENGAGED` —— 那说明红线（不在 headless 环境启闸）守住了。

#### 兜底通路（后台派单 / 父会话空闲）

上面那条「弹窗」路径要求**父会话此刻有一个打开的回合**。前台派单时那个条件成立；
**后台派单 + 回合结束再等回调**时不成立，于是转呈失败，走兜底。验证步骤：

1. **重启应用**，开一个 Multitask 会话（该会话应为 `ask`）。
2. 让协调者**后台**派一个子代理跑一条危险命令（例如
   `Remove-Item -Path '.\build' -Recurse -Force`），**然后让你的回合结束**
   （不要在等它的时候继续对话）。
3. 观察主对话，会看到**三种形态之一**：

| 你看到的 | 含义 |
|---|---|
| 结构化**审批卡** | `approval.request` 转呈生效（父会话恰好有打开的回合） |
| 一条**来自该子代理的消息**，写着「a decision from you is waiting」并给出子会话 id | 兜底 (d) 生效 —— 这是**通知，不是批准** |
| **什么都没有** | 两条都没生效；此时那个子代理会一直阻塞，需要手动打开它的会话来处理 |

4. 若是消息形态：按它给的 id（或页头子代理列表）**打开那个子会话**，在它自己的
   composer 里作答 —— 批准/拒绝**只能在那个子会话里完成**，消息通道不携带审批结果。
5. 日志里对应 `MULTITASK-APPROVAL-RELAY-FAILED reason=…` 紧跟一条
   `MULTITASK-APPROVAL-NOTIFY-SENT`。（消息发不出去时是 `-NOTIFY-FAILED`，
   父链非直接父子时是 `-NOTIFY-SKIPPED reason=not-direct-parent`。）

> ⚠️ **上表是预期，不是已观测结果。** 机制侧已核实的是：`sendMessage` 的授权只做
> 「是否注册表实例」的同一性检查、投递走 `steer` 且 `wakeup = true`（空闲父会话会真的写
> `turn/start`）、消息落成 `user/message` + `source.kind='agent-message'` 并进入对话流。
> 而「由**插件**（而不是子代理自己）发起这条消息」这一层，需要在真实会话里按上面的
> 步骤验证。

#### 跨重启存活（为什么它能存活，以及怎么确认）

`approval/policy` 这条写入**能跨重启存活**，不需要恢复路径。依据是机制：载入期只丢弃
「最后一条没有换行的**不完整**记录」（torn tail），与事件是否在回合内无关；而
`approval/policy` **不在**任何回合包含校验里（只有 `approval/asked` / `approval/decided`
要求回合归属）。

想自己复核，解压一份 `~/.dsh/sessions/<工作区>/` 下的子会话日志看序列：应当能看到
`{"policy":"never","source":"delegation"}`（宿主钉死）紧跟一条 `{"policy":"ask"}`（本插件），
两条都落在第一个 `turn/start` 之前。（那些日志是 zstd、**多帧** —— 每次 append 一帧，
要逐帧解压才能看全；用 `zstdDecompressSync` 带 `{ info: true }` 逐帧读 `engine.bytesWritten`
推进即可。）**注意**：不要动那些文件，只读。

另外值得做一次**重启确认**：放开策略之后重启应用，看新会话里的子代理是否仍为 `ask`。

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

## Worker 人格（一个必须避开的坑）

子代理加入的是**父级那一份 preset**，所以它们**默认继承协调者人格** ——
装出来就是「你也是协调者，你不能改文件、不能跑命令」，而它实际上拥有全套工具。

一个被告知「你不能执行」的 worker，会倾向于拒绝干活 —— 而那正是它唯一被派出去要做的事。
所以这**不是措辞好不好听的问题，是会实质削弱整个模式的问题**。

**修法**：本包给两个进程内委派行都配了独立的 worker 人格，并声明它拥有完整工具集。
两份**刻意不共用同一份文本**（上下文起点不同）：

| 委派行 | 人格常量 |
|---|---|
| `tool-subagent`（spawn） | `WORKER_PERSONA` |
| `tool-subagent-fork`（fork） | `FORK_PERSONA` |

`dsh-subagent` 会把它作为子代理**自己 scope** 上的 section 注册，
按 scope 层叠「最近的作用域赢得同名 section」的规则盖掉协调者那份。
（`subagent_ptc` / `subagent_minimal` 另有两份各自的 `*_PERSONA`，见「多模式子代理」一节。）

核对方式：让一个 worker 报它的工具面，看它的提示词里是否还残留
`You are the coordinator`、以及 `WORKER subagent` / `FULL tool set` 是否在。

⚠️ 这三处措辞是**人格措辞的指纹**，不是脚本 —— `test/` 下**没有任何脚本会比对它们**。
`verify.mjs` 这个名字在仓库里、`test/` 里都**不存在**（现行脚本只有「自检」一节列出的那七份，
它们管的是别的机制）。所以这条约束仍然成立，只是**靠人遵守**：改回旧措辞会让上面这条核对失效。

---

## 设计要点（为什么这么写）

### 为什么协调者被限制，子代理却不受影响

这是整个模式的支点。

`dsh-subagent` 的 `applyChildComposition()` 会强制每个子代理加入**父级那一份 preset**，
而 `toolFilter` 只能**收窄**、不能放宽。所以「协调者窄、worker 宽」**没法靠配置实现** ——
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

### ★ 模式隔离：只收窄**属于本 preset** 的会话（1.0.0 修复的缺陷）

**要求**：同一个工作区里允许多种模式的会话并存（standard / ptc / Multitask…）。
减震器只准动 **Multitask 自己的会话**，别的模式**一个工具都不能少**。

**曾经的做法**是「只要不是被委派的子代理，就收窄」。它错得很隐蔽，完整链条是：

1. 新建会话按 profile 的 `selectedDefault` 起手（若默认就是 Multitask 则必然踩到）；
   `agent/created` 一到，减震器就把限制装上了；
2. 用户在**首轮之前**把该会话切成 standard —— 这是 DSH 允许的
   （`agent-preset/locked` 只挡「已经开跑」的会话）；
3. 切换会把该 agent 的 scope 父链**重绑**到 standard 的 generation key
   （注册表的 `bind()` → `binding.parent.rebind(generation.key)`）。于是减震器不再是
   它的祖先、收不到它按 scope 过滤的事件 —— **但限制本身不会因此消失**：
   `tools.restrict()` 把限制记在**该 agent 自己的 scope layer** 上
   （见 `dsh-tools` 的 `restrict()`：`this.layers.effect(this.ctx, …)`），重绑父链不动它；
4. 结果：那个 standard 会话被按 **Multitask 的保留集**削掉一批工具
   （`read_image` `pwsh` `write` `edit` `web_search` `ssh_*` `task_board_*` …），
   而**没有任何日志**。外在表现是「standard 模式读不了图、没有终端」，
   看起来像图像输入坏了或终端坏了，与真正的原因隔着好几层。

**修法**（`coordinator-guard.mjs`）：

- **加一条归属判据**：`registry.composedPreset(agent.ctx)` 必须等于本 preset id，
  否则一律**卸掉**限制（而不是「什么都不做」）。判据读的是 agent **当前绑定**的 preset，
  会随切换改变；刻意**不读** session header 里的 `agentPreset` —— 那个字段记的是
  「创建时用的是哪一份」，切换之后就不成立，正是上面第 1 步会把人带偏的东西。
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

> 回归校验：13 条进程内用例（`guard-mode-isolation-regression.mjs`），含**反向验证** ——
> 把归属判据改成 `if (false)` 后必须有 6 条变红（T2/T3/T5/T6/T11/T13），
> 否则说明用例是恒真的。反向验证的做法：把归属判据改成 `if (false)`，那 6 条必须变红。

#### 判据分两层，顺序不可颠倒

1. **活绑定（权威）**：`registry.composedPreset(agent.ctx)` —— agent **当前**绑定的那份
   preset，会随切换改变。这是唯一能识别「已切走」的信号。
2. **会话头里的 `agentPreset`（退路）**：**只在活绑定读不出来时**才用。

⚠️ 退路**只用于「活绑定缺席」，绝不用于「活绑定是别的 id」**。这个区分是关键：
已切走的会话活绑定是**存在**的（被重绑到了新 generation），会明确返回另一个 id，
在第 1 层就被拦下 —— 不会因为会话头还写着旧值而被误收窄。用例 T13 专门钉这一点：
活绑定说 standard、会话头写着 multitask 时，**必须听活绑定**。

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

核对方式：在一个 Multitask 会话里委派一个子代理，看它的 `subagent/descriptor` ——
persona 应当是 `WORKER subagent in Multitask mode`，且工具面包含 `read_image` / `pwsh`
这类被协调者摘掉的工具。

⚠️ 反过来的一条边界：**子代理的模型映射只在 Multitask 内生效**。
profile patch 里那份 `subagentModels` 挂在 `dsh-multitask` 那一行的 `config` 上，
由宿主半读进 composition 的委派行 `agentOptions`，所以它**只影响 Multitask 会话
委派出的子代理**；standard 会话里的子代理不受它管辖。这正是要求里的
「要分清楚」。

---

## 卸载

**用包管理器装的**，就交给它：

```
dsh plugin remove dsh-multitask
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

> ⚠️ 本包**没有**独立的宿主层设置需要单独撤回 —— 早先有一个「打开子代理可选模型」的
> 第二步脚本（`tools/enable-subagent-model-selection.mjs`），已随「AI 不得临时指派模型」
> 的决策**整体移除**。若你之前跑过它，profile patch 里可能留着
> `- id: subagent-model-selection-settings` 那一段（`enabled: false`，已经不生效）；
> 想清理可以手动删掉它，**但先确认没有别的 preset 依赖它**（见「已知边界」）。

---

## 包结构

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → 装载时插入 host 行；dsh.client → 浏览器半
├── cordis.patch.yml                    # 向 profile roster 插入 plugin 行（供 bundle 安装方式用）
├── LICENSE                             # MIT
├── README.md                           # ★ 面向使用者的说明（中文）
├── README.en.md                        # ★ 面向使用者的说明（英文）
├── docs/
│   └── DESIGN.md                       # ★ 本文件：设计推导 / 验证清单
├── lib/
│   ├── index.js                        # host 半：激活时向 agentPresets 声明自带 preset
│   └── client.js                       # ★ 浏览器半：设置里的一级页「Multitask」两张卡 + 通用设置两行
└── presets/multitask/
    ├── composition.mjs                 # preset 组成 + 协调者人格 + 各模式 worker 人格
    ├── coordinator-guard.mjs           # ★ 减震器（含「模式隔离」归属判据）
    ├── subagent-mode.mjs               # ★ 多模式子代理：PTC 呈现（零依赖，零 import）
    ├── minimal-guard.mjs               # ★ subagent_minimal 的自适应收窄（零依赖，零 import）
    ├── approval-gate.mjs               # ★ 审批闸门：危险操作弹窗请用户裁决（零依赖，零 import）
    ├── workspace-acl.mjs               # ★ 工作区 ACL：补 WRITE_OWNER，让 shell 开箱即用（唯一改系统状态的模块）
    └── file-info.mjs                   # ★ 只读文件元数据工具 file_info（零依赖，零 import）
```

⚠️ `concurrency-guard.mjs` **不在**这份清单里，也不在仓库里 —— 它已随「并发上限只剩宿主
一个执行点」的决定整体删除，`test/repo-consistency.mjs` 的 C1 会钉住「它不许被重建」。

`package.json` 的 `files` 字段是上面这份清单里**随发布物分发**的那一部分（`lib` /
`presets` / `cordis.patch.yml` / `README.md` / `README.en.md` / `docs/DESIGN.md` / `LICENSE`）。
**测试套件不在其中**（本包不发测试）。`test/` 目录里的用例见下节，它们**不在**上面
这份清单里：`test/` 是本地目录，不随仓库与发布物分发（`.gitignore` 有对应规则）。仓库根下的
`install-multitask.ps1` 同样只在本地存在（`.gitignore` 已忽略）。

### 自检（`test/` —— 所有测试与校验文件的唯一去处）

> ★ **规矩：所有测试文件都必须写进 `test/`。**
> 探针、校验脚本、一次性核对、诊断脚本、回归套件 —— 一律放 `test/`，用
> `node test/<名字>.mjs` 运行，**不要**放在 `lib/` / `presets/` / `tools/` 或仓库根下。
> `test/` 整个目录被 `.gitignore` 忽略，按「是测试就不进远端」的规矩**刻意不跟踪**
> （也不进 `npm pack` 的产物），所以它**只在本地存在**，不要试图把它加回追踪。
> 这条规矩由 `test/repo-consistency.mjs` 自动核对：仓库里出现一个 `test/` 之外的
> 测试类文件，它就会失败并指名那个文件。

本仓**不含**测试文件：按「是测试就不进远端」的规矩，`test/` 整个目录都不跟踪
（`.gitignore` 里有对应规则），发布物里也没有（见上面的 `files` 清单）。
回归校验只在本地跑，用例不随仓库分发。

本地现有七套校验，都从各自脚本的位置推导被测模块，所以仓库放在任何路径下
（含非 ASCII 路径）都能跑：

```powershell
node test/guard-mode-isolation-regression.mjs    # 减震器的「模式隔离」回归
node test/repo-consistency.mjs                   # 并发上限收敛 / 文档一致性 / 模块常量 / 测试文件归位
node test/subagent-mode-marker-source.mjs        # 模式标记的来源（前台/后台两条派单路径）
node test/minimal-guard-catalog.mjs              # 只读 worker 的目录级过滤（restrict 够不到的那类）
node test/approval-gate-rules.mjs                # 审批闸门：规则表的漏判与误报
node test/approval-gate-integration.mjs          # 审批闸门：门控 / 事件形状 / 转呈方向
node test/workspace-acl-rules.mjs                # 工作区 ACL：最小授权红线 / 看不清楚就不动作
```

**第一套（模式隔离）** 覆盖 13 条用例（归属判据、模式切换的两个方向、子代理不受影响、
读不出归属时的取向…），并自带**反向验证**：把归属判据改成 `if (false)` 后必须有 6 条
变红（T2/T3/T5/T6/T11/T13），否则说明用例是恒真的。

**第二套（仓库一致性）** 是**静态 / 离线**检查：**不加载 DSH、不起会话、不写任何文件**，
只 `import` 本仓库自己的那五个模块（因此「模块能加载」本身也是一条断言）。
它分下列几组断言，共 38 条：

| 组 | 守什么 |
|---|---|
| **0 / 1**：只剩宿主一个执行点 | `concurrency-guard.mjs` **不得存在**；`composition.mjs` 的**代码行**里不得再出现 `MAX_ACTIVE_CEILING` / `normalizeMaxActive` / `concurrency-guard`；`lib/index.js` 不得再声明 `MAX_ACTIVE_FIELD` 或那两个收敛函数；面板两处 UI 的 `concurrencyRef` 必须都指向 `subagent.maxActiveSubagents`，且不得再出现 `multitask.maxActiveSubagents` / 「限制 ⇄ 不限制」那两档文案 |
| **1b**：运行期核对 | 真调 `buildPlugins()`：行表里**没有** `concurrency-guard` 行（哪怕显式传了 `maxActiveSubagents` 也得没有），而四条委派行与三个守卫行仍在（防「删除时误伤」）；`Config.validate` 不再产出 `maxActiveSubagents`，而 `subagentModels` 仍在 |
| **1d**：唯一的设置字段仍是 volatile | `subagentModels` 必须带 `meta.volatile` 并被换成 volatile 引用 —— 漏掉它会让面板写入被判成普通变更 ⇒ **重启插件** ⇒ 模式从新会话列表消失。它现在是**唯一**的字段，所以出错时没有别的字段会连带暴露 |
| **1e**：不许出现「AI 临时指派模型」 | `composition.mjs` 的**代码行**里不得出现 `modelSelectionSettings:`（注释里解释「为什么不设」是允许的）；协调者保留集里不得再列 `list_subagent_models`；**同时**用反向守护钉住「用户面板那张模型卡仍生效」—— 真调 `buildPlugins({modelMap})`，断言四行的 `agentOptions` 该有的有、该缺的缺（这条挡的是「删 AI 那条路时顺手把用户那条也删掉」） |
| **1f**：那张卡的排版 | 卡片标题与那一行的标签**用同一个词是对的**（它就是「同一个设置」的信号），所以判据不是「两个字符串必须不同」，而是**在卡片语境里标题只画一次**：`LimitRow` 只在 `props.inCard !== true` 时才渲染视觉标题，而 `label` 仍要交到输入框的 `aria-label`（省视觉 ≠ 省无障碍）；卡片里那一行必须用 `.mt-growCard`（左右 16px，与卡片标题同一套度量），且该规则必须写在 `.mt-grow` **之后**（同为单类选择器，只靠书写顺序覆盖） |
| **2 / 2b**：文档与实现一致 | README 必须写明「只有一个值、两处 UI 编辑同一字段」「计数口径是当前存活」「拒绝来自宿主、这不是插件坏了」「8 是宿主**默认值**、不是天花板」，并逐字引用宿主那条错误原文、解释「串行时活跃数从未超过 1」的错觉；**并逐行禁止**把已删除的 `multitask.maxActiveSubagents` 当成现行行为（作为「已删除的旧设计」提及时，同一行必须带更正标记）；两份手抄的模式标记必须逐字一致 |
| **2c**：审批闸门的静态约束 | 改写用的条目名 `subagent:delegation` 与那句原话必须逐字在位（名字漂了就是**静默不改**，连日志都没有）；`approval/policy` 的写入**省略 `source`**（`source: 'delegation'` 的语义是「从父级委派继承」，与本模块的纠正相反）；兜底通知的调用**在 `await next()` 之前**（下游可能无限挂起，排在后面就永远发不出去）；那句错的理由（「校验只允许 delegation」）不许再出现 |
| **2d**：文档与实际用例数一致 | README 里每个「N 条断言组，N 通过」都必须等于对应脚本实际的 `test(` 计数 —— 这条防的是文档里的数字随着用例增删而悄悄过期，读者据此判断覆盖范围时会得出错误结论 |
| **2e**：工作区 ACL 的红线 | 授权脚本只许 `TakeOwnership`（**出现 `FullControl` / `Modify` 即失败**）；只做加法（不许删 ACE / 改所有者 / 动标签）；路径必须经环境变量传入；文档里不许再出现那两类**不实的**旧定性（把该问题说成「部署级」、说成需要一次沙箱之外的不受限运行），也不许出现给人照抄的 `:(F)` 授权命令 |
| **3**：测试文件归位 | 仓库里没有 `test/` 之外的测试类文件（**按内容特征扫**，不只是看文件名）；`test/` 仍在 `.gitignore` 里 |

它还自带**反向验证**：在内存里把 `concurrency-guard` 那一行**加回** composition，
第 1 组的判据必须立刻命中（同时在真文件上必须**不**命中）—— 两端都验过，才说明那组
用例不是**恒真**的。

**第三套（审批闸门规则表）** 校验第一级的模式表，8 条断言组，两头都测：

- **漏判**（该问的没问）58 条危险命令：递归删除、磁盘/引导/电源、改远端历史、
  发布外发、提权、系统级变更、下载即执行、系统路径与凭据写入、强杀进程；
- **误报**（不该问的问了）32 条日常命令 —— 这一张与上面**同等重要**，
  因为每次无谓的询问都在把用户往「无脑点允许」推。刻意放行的有 `git clean -nd`（干跑）、
  `chmod +x`、`chown user:user f`、`net user` / `wmic process list`（只读列举）、
  `cat /etc/hosts`（只读）；
- 另有工作区逃逸判定（含 `H:\project-x` 不得被判成 `H:\proj` 的子目录）、畸形输入不抛错、
  大小写不敏感。


**第四套（审批闸门逻辑链）** 用几百字节的假 `ctx` / `approval` / `agent` 把 `apply()`
真跑起来，38 条断言组覆盖三件最容易写反的事：门控方向（父会话不是 `ask` 时**一个字都不能动**）、
事件与决策的形状（`source` 省略、`ask` 三个字段齐全）、转呈方向（目标是**父**会话、
父会话自己的请求要放行、失败要**退回原路径**）。另含多级委派一次走到根、
畸形父链不成环、断链不转呈、`signal` 沿用，以及**瞬时缺席之后仍可重试**
（登记「已处理」必须在落库成功之后，否则一次服务未就绪会让该 worker 永久停在 `never`）…

其中 9 条专测**兜底通知**（I28-I36）：转呈失败时发了通知且返回值不变、通知失败不影响返回值、
缺服务跳过、早退路径不发、多级委派跳过、配置可关、signal 中止跳过，以及最关键的一条 ——
**下游永不返回时通知仍然发出**（那正是把通知放在 `await next()` 之前的原因）。

它还自带**反向验证**：把 8 处关键守卫逐个改坏（在内存里改，不动磁盘文件），
每处都必须让对应用例变红。

**第五套（工作区 ACL 规则与决策）** 校验本仓库**唯一会改系统状态**的模块
（`workspace-acl.mjs` 会给工作区目录补一条最小权限），14 条断言组：

- **红线**：授权脚本只许出现 `TakeOwnership`（= `WRITE_OWNER`），
  **出现 `FullControl` 或 `Modify` 即失败**；只做加法（不许删既有 ACE、不许改所有者、不许动完整性标签）；路径必须经环境变量传入（不拼进脚本文本）；
- **看不清楚就不动作**：读不出沙箱模式、模式不是 `workspace-write`、没有 `cwd`、是子代理、
  被配置关掉 —— 五种情形都必须**什么都不做**，绝不猜着改 ACL；
- **承诺不破**：载荷畸形不抛错、同一工作区每进程只尝试一次、授权失败只记日志不抛。

⚠️ 它**不会**对着任何真实目录跑授权：唯一的子进程调用指向一个**不存在的路径**，
所以这个文件跑一万次也不会改动任何 ACL（真正改动 ACL 的验证在装机后由使用者做）。

它同样自带**反向验证**：把脚本里的 `TakeOwnership` 改成 `FullControl`（内存内改），
对应的红线断言必须变红。

**第六套（模式标记的来源）** 钉的是 `subagent-mode.mjs` / `minimal-guard.mjs` 共用的那一步：
**「这个子代理来自哪条委派行」是靠读 persona 里的模式标记回答的**。9 条用例：

- **F1 / F2（本轮缺陷的直接回归）**：**只给**子代理自己的 `deployment:persona-prefix`
  段落、**不给** `subagent/descriptor` 的 `persona` 字段 —— 即**前台派单**的形状。
  两者都必须识别出来（PTC 要塌缩、minimal 要摘掉 `ssh_exec` / `task_board_run` / `pwsh`）。
  早期实现只读 descriptor，**在这两条上必红**；
- **G1 / G2**：后台派单（descriptor 带 persona）仍被识别；段落读不到时 descriptor 兜底仍在；
- **N1–N3**：别条委派行的 persona 不受影响；两个来源都没有时不动作且不抛错；
  **协调者绝不被碰**（两个守卫都不碰 —— PTC 那边碰了会改写减震器语义）；
- **M1 / M2**：上游改了 `SystemPrompt` 内部结构时，必须留一条带固定标识
  `MULTITASK-MODE-MARKER-SOURCE-MISSING reason=…` 的 warn（**不许静默失效**），
  且告警之后仍走 descriptor 兜底；缺 `ptcRuntime` 时仍归到既有的 `no-runtime` 分支，
  不被误判成「没有标记」。

它自带**反向验证**：把两个模块的「主来源优先」改回「只读 descriptor」（改磁盘文件，
跑完**还原**），F1/F2 必须变红。

> 为什么这条缺陷值得单开一套：它**只在一种派单方式下出现**（前台），而那种方式恰好是
> **审批弹窗唯一走得通**的那条 —— 于是「按任务书老实做前台派单」时症状最明显，
> 默认后台派单时反而看不见。四个既有的守卫测试（第一、二套）都过，因为它们喂的是
> 模块自己的判据，没喂「persona 从哪来」这一层。

**第七套（只读 worker 的目录级过滤）** 钉的是 `minimal-guard.mjs` 的另一半：
`tools.restrict()` **结构上够不到一类工具**，那一类由**目录级过滤**兜住。12 条用例：

- **C1（合成案例）**：roster 里放一个**不可 restrict** 的外来工具名
  （测试里的 `PER_AGENT_LEAK`），它必须从目录里消失、**且不进 deny**（进了会让
  `restrict()` 抛 `unknown global tool`）。用合成名字是因为那个真实案例已随
  `modelSelectionSettings` 的移除而消失 —— 但这一层要挡的是**结构性**的那一类，
  任何第三方插件按 agent 单独安装工具就又会落进来；
- **C2（本轮行为变化的直接回归）**：四条委派工具现在**由 `restrict()` 摘掉**
  （移除那个开关后它们回到全局注册）。C2 同时是**回归哨兵**：若有人把
  `modelSelectionSettings` 加回来，那些工具又会变回逐-agent 安装、从 deny 里消失，C2 会红；
- **C2b**：即便真实泄漏消失，目录过滤**仍须装上**（不许被顺手删掉）；
- **C3–C6**：允许集与 harness 内部传输名（`run_code` / `structured_output`）被放过；
  只作用在该 worker 自己的 scope（兄弟与**协调者**都不受影响）；没有 `tools` 数组时原样放过；
  无可滤项时返回**同一个**对象（不无谓分配）；
- **C7**：目录里刚好只剩不可 restrict 的那些时，也必须装上过滤器 ——
  这一条挡的是「把目录过滤放在 `deny.length === 0` 早退之后」这个位置错误；
- **L1 / L2**：记账只在**第一次**真的滤掉东西时记一条，并列出被滤掉的名字
  （那是「过度过滤」的唯一出口）；没有隐藏任何东西时不记；
- **R1 / R2**：`restrict()` 与目录过滤**各自独立登记**清理动作，`agent/disposed` 时**都**执行，
  且重复触发不重复登记。R1 挡的是一个真实缺陷：两个 disposer 曾写进同一个 `WeakMap` 键，
  后写覆盖前写 —— 表现是 scope key 复用时新 agent 继承一条本该消失的过滤。

它自带**反向验证**：把「装上目录过滤」改成 `false`（改磁盘文件，跑完**还原**），
C1 必须变红。

> **为什么需要目录过滤这一层**：`dsh-tools` 的 `view()` 里只有 `inherited` 会进
> `restrictableNames`，而注册在该 agent **自己 scope** 上的名字只进 `visible` ——
> 写进 deny 会抛 `names unknown global tool`。所以凡是**按 agent 单独安装**的工具，
> `restrict()` 结构上都摘不掉。
>
> ⚠️ 这一层的原始触发案例是：`subagent` / `subagent_ptc` / `subagent_minimal` 三行
> 设了 `modelSelectionSettings: true`，而那个开关会让 `dsh-tool-subagent` 改为逐 agent
> `installScoped`。此时 minimal worker 的目录会变成「允许集 + 这三个」，即那几个委派
> 工具既不在 deny 里、又摘不掉。
>
> **那个开关现已从四行全部移除**，四条委派工具回到全局注册、由 `restrict()` 正常摘掉
> （见 C2）。但**这一层不能因此删掉**：它的存在理由是**结构性**的，任何第三方插件只要
> 按 agent 单独安装工具，就又会落进这条够不到的地带 —— 所以测试改用**合成的**外来
> 工具名继续守它。
>
> 这一层修的是**一致性**（人格逐字写着 "Do not delegate further; you cannot"，
> 模型却看得见委派工具），**不是安全边界** —— 真正的拦截是 `maxDepth`
> （minimal worker 深度为 1，再往下派会撞 `Error: subagent depth 2 exceeds maxDepth 1`）。

> **为什么这些校验刻意不用 `node --test`**：那个运行器会 spawn 子进程并捕获管道输出，
> 在受限沙箱下会以 `spawn EPERM` 失败。所以本仓的校验脚本都在**进程内**直接跑断言
> （自带一个极小的 `test()` 运行器），不 spawn、不捕获输出。
>
> 同理，写这类运行器时有一个必须避开的坑（本仓踩过）：`test()` 若**就地调用** `body()`
> 却不 `await`，`async` 用例一碰到第一个 `await` 就交回控制权，`test()` 于是**立刻**记一次
> 通过 —— 那条用例的断言一旦失败，**不会进 `failures` 列表、也不会印出用例名**，汇总行照印
> `ALL PASS`。**一条永远绿的守卫断言，恰好等于没有那条断言。** 正确形状是
> `test()` 只入队 + 收尾在 `await runTests()` 里逐个 `await body()`。
> 归属判据那套脚本的**反向验证**（把判据改坏、必须变红）就是用来证明这一点没被违反的。

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

1. **递增 `?v=N`**（当次写入 profile patch，`entry.options.name` 随之更新）；
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

四个必须避开的坑，都已写进代码和回归测试：

1. **相对导入不继承入口的 query。** 只给入口加 `?v=N`，入口刷新了，但它相对导入的
   `composition.mjs` 仍从旧缓存取 —— 改了 preset 文本却毫无变化、也不报错。
   本包显式把 query 逐层传播（入口 → composition → concurrency-guard / subagent-mode /
   minimal-guard / approval-gate / coordinator-guard），所以**一次递增刷新整张模块图**。
2. **递增可能仍然不生效。** 如果更早的模块实例还占着 preset 声明，注册表会硬拒绝
   重复 id，而这个失败**只留一行 warn** —— 于是旧 preset 悄悄留在原地，看起来像"改了没用"。
   本包用进程级交接表让新实例接管旧声明；但**早于该机制**的实例无法被它触及。
   这时**重启**是最简单可靠的做法（会把进程里所有旧实例一并清掉）；要么把这一行删掉、
   保存、等应用稳定，**再保存一次**加回来（注意必须是两次保存，见上）。
3. **「自己撞自己」不再被误报成「旧实例占用」。** 曾经每次加载都打一条
   `is ALREADY registered by an older module instance` 的 warning，并给出照做**也没用**的修复建议 ——
   它其实是同一次加载里的两条声明路径（主路径与 `ctx.inject` 兜底）并发进入，
   而判断「是否已声明」用的 `release` 要等 `register()` 返回后才赋值，于是第二次带着同一个 id 再注册，
   撞上注册表对重复 id 的硬拒绝。现在不变式收在 `declare()` 自己身上（`declaring` 挡并发、
   `declared` 挡顺序，`release` 只管卸载时注销），`finally` 复位，晚到的兜底重试**照旧有效**。
   早先这里把「是否已声明」写成 `release !== undefined` 是**错的** —— 它只在注册表给了注销器
   时才为假，漏掉的那条路径见下一条。
   这只是误报：被拒的是同一实例里的第二次调用，第一次早已成功声明，**不影响 preset 正确性**，
   **递增 `?v=N` 的激活本来也不会因此失败**。修复后这条 warning **只在真被更早的实例占用时**才出现，
   因此它重新成为**可靠**的判据。
4. **同一个误报还有第二条路径：顺序重复进入。** 若注册表**接受了声明却不返回注销器**，
   `release` 恒为 `undefined`，上面那条判据就失效 —— 声明已 settle 之后兜底回调再进来，
   又拿同一个 id 二次注册，照样撞上重复 id 的硬拒绝。这**不是并发**：并发那一路已被
   `declaring` 挡住，这是**顺序**重复（`declaring` 管并发、`declared` 管顺序）。
   修法是把「是否已声明」从 `release` 独立出来：`declared` 在落库成功即置位，**有没有注销器都一样**，
   `release` 只管卸载时注销，调用点守卫改为 `!declared && !closed`，`declaring` 的 `finally` 复位保留。
   **不影响 preset 正确性**（第一次已成功落库），只影响那条日志的可靠性 —— 修复后
   `is ALREADY registered…` 才真正只在「被更早实例占用」时出现。边界：需注册表**违反自身契约**
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
  早先那个宿主层开关（`modelSelectionSettings`）已从四行委派配置里**整体移除**；
  它是**宿主层**设置，若你之前跑过安装脚本，profile 里可能还留着那一段。
- **子代理的 shell 需要工作区目录具备 `WRITE_OWNER`** —— 新工作区由插件自动补（见下节）；
  它不需要提权、不需要批准，也绝不该靠把目录放宽到 Full control 来解决。

### 子代理的 shell 曾整体不可用（已修复；原诊断已更正）

**症状（逐字）。** 任何子代理执行任何命令都失败，错误原文：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区路径>)
```

（路径部分是该会话的可写根目录。）

**怎么认出它、以及为什么不是你的命令或并发数的错。** 下面每一条都是识别判据：

| 现象 | 说明 |
|---|---|
| 只有 **1 个**子代理在跑时照样失败 | **与并发无关** —— 不是撞上 8 那个容量上限 |
| 换成 `Get-Location` 这类无副作用命令**照样失败** | **与命令无关** —— 不是命令写错了 |
| 把命令的工作目录指到系统临时目录，报错里**仍然**是会话的可写根 | **与工作目录无关** —— 拒的不是「这次命令要碰的路径」 |
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

- **最小授权就是 `WRITE_OWNER` 一项**，不是 `(F)`、也不是 `Modify`。
  **绝不要为了这个把目录放宽到 Full control** —— 那会额外给出「改权限 + 夺所有权」，
  远超所需。而且 `WRITE_OWNER` 是**所有者给自己的**：目录所有者本来就能随时夺回所有权，
  所以这条 ACE 不扩大任何人的实际权力，只是把「所有者本可做的事」变成「沙箱可以做的事」。
- 它**不需要**提权、**不需要** `SeSecurityPrivilege`、**不需要**「一次已批准的受限外运行」。
  整个动作只是一次 DACL 写入，而目录所有者隐式拥有 `WRITE_DAC` —— 同进程即可完成。
  （本仓库早期文档说它需要一次不受限运行，那是**错的**，已更正。）
- 想关掉：把该行的 `config.autoGrantWriteOwner` 设为 `false`。
- **开箱即用的做法**：把工作区放在用户目录下（那里天然满足）；盘符根下的路径则依赖上面的自动补。

**怎么核对修复是否生效。** 在一个只继承了 `Modify` 的新目录上开会话，然后：

1. 让子代理跑一条无副作用命令（如 `Get-Location`）—— 应当**退出码 0**、报错里没有 `grantWrite`；
2. 跑 `icacls .` 看那条 ACE 在不在。本模块补出来的指纹是 **`(WO,S)`**（非继承）：
   `icacls /grant ...:(WO)` 只会写出 `(WO)`，而 PowerShell 的
   `AddAccessRule(TakeOwnership)`（本模块用的写法）写出 `(WO,S)` ——
   两条并列试一次就能分清这个目录是被插件补过的，还是被人手工改过的。

> ⚠️ **日志标识不落盘，别去磁盘上找。** 上面那些 `MULTITASK-*` 标识走的是
> 应用的日志流，DSH **不会**把它们写成文件：`~/.dsh/logs/` 下通常只有其它插件自己写的日志，
> 没有 `MULTITASK-*` 行。所以**判定修复是否生效，请以 `icacls` 的实际输出为准**
> （看那条非继承的 `(WO...)` 在不在），不要指望 grep 到日志行。

**仍然失败时**，只有两种可能：目录**属于别的账户**，或它在当前进程**不可写** ——
此时那条 `WRITE_OWNER` 根本不会出现（`icacls <目录>` 里看不到 `(WO`）。

**协调者与 worker 应当怎么做。** 三条人格里已写明（`composition.mjs` 的
`COORDINATOR_PERSONA` / `WORKER_PERSONA` / `FORK_PERSONA`）：认出它、**别在循环里重试**、
**别自己去跑任何权限命令**、也**绝不把目录放宽到 Full control**；若仍被拒，
就把那个具体原因（哪个目录、自动补没落地）如实报给用户，并改走只读 + 文件编辑的路。
对使用者来说：

- 「读文件、查元数据、改文件」这类任务**始终派得出去**；
- 「跑构建、跑测试、执行命令」在自动补落地后**照常可用**；仍在被拒时说明上面那两种可能，
  而不是「减震器装错了位置」或「子代理坏了」—— 那两种解释在只读路径仍然可用这一点上就站不住。
