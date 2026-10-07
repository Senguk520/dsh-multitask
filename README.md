# dsh-multitask — Multitask「减震器」模式

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

### 给开发者：从源码 checkout 安装

改本包源码时用这条，因为工作区里的改动不会经过 npm：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-multitask.ps1
```

脚本会：从**自身所在目录**推导出 `lib/index.js` 的绝对 `file://` URL（所以它在你自己的
checkout 路径下就能用，中文路径也没问题）→ 备份 profile 的 `cordis.patch.yml` →
只**追加**一行（不改动既有内容）→ 用逐字节前缀校验确认原内容完好 → 原子替换。
重复执行是幂等的。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-multitask.ps1 -Uninstall
```

指定别的 profile：加 `-ProfileDir "C:\path\to\profile"`。

**装这一行不需要重启。** DSH 的 HMR 服务在 `cordis.patch.yml` 上装了 watcher，改动会被热重载。
装好后可以在插件列表里看到本行 `fiberPhase: "active"`。

> ⚠️ **别把这条推广到「改源码」上。** 新增一行时该条目**没有 fiber**，Loader 走
> `await this.init()` 会真正 `import()`，所以免重启成立；而**改源码后递增一个已经在运行的
> 条目的 `?v=N`** 只改到它的 `name`，Loader 走的是 name-only 分支、**不重新加载** ——
> 那种情况**必须重启**。详见「改源码后如何生效」。

### 第二步：启用「子代理可选模型」（可选但推荐）

如果你希望**手动指定**某个子代理用别的模型，需要额外打开一个宿主设置：

```powershell
node .\tools\enable-subagent-model-selection.mjs
```

原因：`subagent` 工具只在宿主设置 `subagentModelSelection.enabled` 为真时，才会公开
`provider` / `model` / `reasoning_effort` 三个字段和 `list_subagent_models` 工具；
该设置**默认关闭**，关着的时候这些字段在工具 schema 里**根本不存在**。

脚本会自动从 profile 自己的 provider 配置推导白名单（不会与真实路由漂移），
并用 profile 自带的真实 `yaml` 解析器校验「原有条目逐项不变」后才写入。
撤回：`node .\tools\enable-subagent-model-selection.mjs --revert`

> 这是**宿主层**设置，不限于 Multitask 模式 —— 打开后对所有 preset 生效。

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
# C:\Users\asus\.dsh\profiles\desktop\cordis.patch.yml
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
| 子代理并发上限 | `multitask.maxActiveSubagents` | **只对 Multitask 模式生效**：本模式下同时运行多少个子代理。默认**不限制**；部署自身的上限始终有效，**两者取较小值**。只对此后新建的会话生效 |

**「通用设置」页 —— 两行**（与官方的语言 / 外观 / 开发者工具并排）

| 行 | 对应字段 | 作用范围 |
|---|---|---|
| 最大递归深度 | `subagent.maxDepth` | **宿主平面**：对所有模式生效，不只是 Multitask |
| 子代理并行数量上限 | `subagent.maxActiveSubagents` | 同上 |

> 两项运行限制放在**通用设置**而不是本插件自己那一页，是因为它们**在宿主平面上**、
> 对所有模式生效 —— 放进 Multitask 页会让人以为只对 Multitask 有效。那一槽是官方为
> 「不需要独立页面、只占一行的偏好」准备的座位（`settings.general.item`，官方用它放
> 语言 / 外观 / 开发者工具）。两行按官方那一段的行样式画（标题 + 说明在左、控件在右、
> 底部 0.5px 分隔线、上下 16px、**外面没有卡片**），所以并排时看不出接缝。
>
> ⚠️ 别把这条推广到下面那张「子代理并发上限」卡上 —— 两者**不是同一层的东西**：
>
> | | 通用设置那两行 | Multitask 页那张并发卡 |
> |---|---|---|
> | 字段 | `subagent.maxDepth` / `subagent.maxActiveSubagents` | `multitask.maxActiveSubagents` |
> | 平面 | **宿主平面**，对所有模式生效 | **本模式专属**，只在 Multitask 里生效 |
> | 摆放理由 | 所有模式都受影响，放进本页会误导 | 只对本模式生效，放进本页**才是对的** |
>
> 两者**同时生效、取较小值**：部署自身的上限始终有效，本模式这张卡只能把上限压得**更低**，
> 不可能把它放宽。

> 「保存」提交的是 `multitask` 命名空间里的**两个字段**（`subagentModels[]` 与
> `maxActiveSubagents`），一次保存同时服务**两张卡** —— 但保存条仍然**只有一条**，
> 而且它**紧贴**这两张卡：控件与影响范围必须挨着，否则「保存到底保存了什么」要靠猜。
> 两个字段**要么一起落地、要么一起不动**（同一个 `mutate` 调用、同一个 ops 数组，
> 所以 revision 也只推高一次，不会出现「半保存」）。
> 「通用设置」里的两项运行限制相反，是**改完即写**（松开控件即提交），所以它们没有保存按钮。
>
> 两张卡的**形态都不落盘**，都由字段自身推导：
>
> - 「所有子代理使用同一个模型」—— 形态由 `subagentModels[]` 推导：四类指向同一条路线
>   即「是」，否则即「否」；
> - 「限制子代理并发数」—— 形态由 `maxActiveSubagents` **有无值**推导：字段**有值** = 限制
>   （下方出现数字框），字段**缺席** = 不限制。
>
> 所以切换形态本身都不产生脏值（没有值可写时保存按钮保持灰着），也不会在切换时静默
> 改掉另一张卡的配置。**「不能设成 0」正是靠这一层加 UI 层共同保证**：数字框的下限是 1，
> 而万一有非法值绕过了 UI（手改 YAML 等），宿主侧也会把它**收敛成 1**，
> 绝不当作「不限制」（见下方「子代理并发上限」一节）。

> 之所以注册成 `settings.section`（设置导航里的一级页）而不是 `plugins.item`（侧栏「插件」页的
> 子槽）：后者按官方设计是给「在插件页里配置官方插件」用的，而这里的诉求是「在设置里、
> 新用户找得到」。理由与取舍写在 `lib/client.js` 的文件头。
>
> ⚠️ 改 `lib/client.js` 属于**改源码** —— 按「改源码后如何生效」一节，需要**重启应用**。

### 协调者默认保留什么

**保留**

- 只读核对：`read` `grep` `glob` `file_info`
- 委派：`subagent` `subagent_ptc` `subagent_minimal` `subagent_fork`
- 子代理控制：`send_message` `interrupt_agent` `list_agents` `list_subagent_models`
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
它补的是一个实测缺口（代号 **D5**）：`read` 只回内容与行数、**不回字节数**，
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

> ⚠️ 以上是**机制事实**（源码 + 35 条进程内用例）。它在本机**真实会话**里是否真被注册、
> 协调者与 minimal worker 是否真能看到它，属**装机后的地基验证，本轮未实测**。

### 子代理模型

默认**继承协调者同模型**。需要时协调者可以手动指定：先用 `list_subagent_models`
查看可用路由，再在委派调用里带上 `provider` / `model` / `reasoning_effort`。
**不做自动选型** —— 那是你的决定，不是插件的猜测。

> 前提是已执行第二步（`enable-subagent-model-selection.mjs`）。该设置关闭时，
> 这三个字段在工具 schema 里根本不存在，协调者也看不到 `list_subagent_models`。

### 委派深度

固定为 **1**：协调者 → worker。worker 不能再往下派。
避免任务无限扩散，也避免上下文层级失控。

现在共有 **4 条委派行**：2 条原有（`subagent` = spawn、`subagent_fork` = fork）
+ 2 条新增（`subagent_ptc`、`subagent_minimal`，见下一节）。**四条全部声明 `maxDepth: 1`**。

四个进程内委派行**都显式声明** `maxDepth: 1`。运行时实测两条原有路径**都不可穿透**：
fork worker 无论用 `subagent` 还是 `subagent_fork` 向下派 depth 2，都被硬拒绝
（`subagent depth 2 exceeds maxDepth 1`），且拒绝发生在启动前。
给 fork 行补上该字段属于**显式性 / 可读性修正，不是安全修复**。

> 残余边界：实验只能证明「有效上限 = 1」，**无法区分**这个上限来自行内声明的
> 字段、缺省继承的默认值，还是共享的上限强制层。补写字段后这两种解释仍无法区分。
> 这条残余边界同时适用于新增的两行 —— 它们同样只声明、未单独实测。

想放开就改 `presets/multitask/composition.mjs` 里 `tool-subagent` 行的 `maxDepth`。

### 子代理并发上限（本模式专属）

设置页「Multitask」的第二张卡，字段 `multitask.maxActiveSubagents`。
它限制**本模式下同时运行多少个子代理**；默认**不限制**。

它与「通用设置」里的 `subagent.maxActiveSubagents`（宿主平面，默认 8）**同时生效、取较小值** ——
宿主那个是全局的，撞上时报的是 `ACTIVATION_LIMIT_REACHED` 硬拒绝；这张卡给 Multitask 单开一个
**更低**的上限。它**只能压低**，不可能把部署自身的上限放宽。

**三种取值，语义各不相同**（这是本功能唯一微妙的地方）：

| 字段 | 含义 |
|---|---|
| **缺席**（没设过） | **不限制** —— 与「本功能加入之前」逐字等价：守卫模块**一个监听器都不注册** |
| 安全整数 `>= 1` | 限制到该值 |
| 其它任何值（`0` / `-1` / `2.5` / `'4'` / `NaN` / `null`…） | **收敛成 `1`**（= 最多 1 个并发），**绝不当成「不限制」** |

> **收敛方向是刻意选的，别把它当 bug 改掉。** 把非法值当成「不限制」会比用户的意图**更宽松**：
> 用户既然碰了这个字段，就是想要一个上限。误填一个垃圾值的代价只是「上限变成 1」——
> 难看，但安全、而且立刻可见；静默取消限制则什么都不会发生，直到超发把协调者的上下文撑爆。
> **「不能设成 0」正是靠这一层加 UI 层共同保证。**
>
> ⚠️ 唯一的例外是「**缺席**」：那不是非法值，是**没设过**。设置面板的「不限制」正是通过
> **删掉这个键**来表达的，所以它必须与不限制等价。

#### ⚠️ 这是**软上限**，不是安全边界

必须写清楚，因为它很容易被读成比实际更强的东西。它的准确性质是
「**对协调者常规委派路径的节流**」，不是权限边界、不是资源配额、不是「子代理数量绝不会超过 N」的保证：

- **`workflow` 是已实证的旁路。** 工作流引擎**直连** `ctx.subagents.start()` 创建子代理，
  绕过了工具层 —— 而拦截恰好只发生在工具层。所以工作流起的子代理**会被计数，但拦不住**。
- 由此推论出一条容易看错的行为：一个**未被拒绝**的入口（`workflow`）冲过上限之后，
  **协调者随后走常规委派路径的请求会被拒绝**，直到计数回落到上限以下。
  也就是说：**超发的代价没有消失，只是被转嫁给了正常路径。**
- 拒绝方式是**工具层错误**（一条文本结果），不是宿主的硬拒绝错误码。
- 计数只覆盖**协调者的直接子代理**。

| 入口 | 是否计数 | 能否被拒绝 |
|---|---|---|
| `subagent` / `subagent_fork`（工具层） | 计数 | **能** |
| `subagent_ptc` / `subagent_minimal`（工具层） | 计数 | **能** |
| `workflow`（引擎直连 `ctx.subagents.start`） | **计数** | **不能** |

> 上面这张表与完整边界（含「我们的软上限比宿主更严的两种情形」）写在
> `presets/multitask/concurrency-guard.mjs` 的文件头，那里是权威版本。

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
  工具（本机实测：6 个 `ssh_*` 含 `ssh_exec`、8 个 `task_board_*` 含 `task_board_run`）曾经
  依然可见 —— 人格说只读、机制却让它能改远端机器。`minimal-guard.mjs` 补上第二层：
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

### 为什么两条新行只能是 `continuable`

插件要回答「刚创建的子代理来自哪一行」，而 `dsh-tool-subagent` 的 Config schema 里
**没有**任何模式/组成字段，也**没有**运行时句柄。所以只能靠一个被注入到子代理自身的
标记来间接识别 —— `persona` 是唯一符合条件的载体（它是委派行上的配置，既写进子代理
的 system prompt，又被原样快照进子代理 session 的 `subagent/descriptor` 事件）。

⚠️ 但那个快照**只在 continuable 分支里才包含 persona**。
`dsh-subagent` 的 `snapshotSubagentDescriptor()` 对 `mode === 'one-shot'` 的行只保留
`version` / `mode` / `provider` / `label` 四个字段，persona 与 toolFilter **都被丢掉**：

```
标记能被子代理之外读到的前提 = 该委派行是 backgroundMode: 'continuable'
```

这不是偏好，是上游快照的字段集决定的。所以两条新模式行都是 `continuable`。

> 顺带一提：原有两行**本来就是** `continuable`，所以没有历史包袱；
> 而 `codex` / `claude-code` 两行是 `one-shot`（且默认 `disabled`），
> 它们**不可能**支持这套模式标记 —— 这属于设计边界，不是待修的缺陷。

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

> **`bash` 与 `plugin_manager` 在本机（win32）是被禁用的**，写进 `deny` 会抛错。
> 本包的 `deny` 用平台条件与工具行保持互斥，因而不会指到被禁用的那个。
> **`run_code` 永远不能写进 `deny`**（保留传输名，`restrict()` 拒绝它）。

想再收窄（例如也摘掉 `ssh_*` / `task_board_*`），**必须先确认该部署真的装了对应插件**。
宁可少摘，也不要赌部署构成。

### 已知边界与未确证项

如实列出，避免把推断当结论：

- **「PTC 对推理质量的实际增益」未经实测验证。** 这是**用户的设计假设**
  （不同工具面影响推理表现），本包只把机制搭好；要判定它是否成立，
  需要用真实任务对比 `subagent` 与 `subagent_ptc` 的效果，本机尚未做过这个对比。
- **`agent/created` 是否严格早于子代理首次 prompt 组装：源码推断成立，本轮未实测。**
  `coordinator-guard` 依赖同一时机且已端到端验证过（减震器确实生效），
  但那是它自己的链路；PTC 呈现这一条**没有**做过端到端验证。
- **PTC 呈现链路未在真实会话里跑过。** 已完成的验证是：模块零依赖可加载、
  逻辑在假 ctx 上有 **41 项常驻用例**（含「协调者绝不塌缩」「无运行时则安静跳过」）、
  结构性断言与三道自检。**真实子代理是否真的塌缩成 `run_code`，待装机后实测。**
- **本机是否已装 PTC 运行时尚未确认。** 插件在运行时用 `ctx.get('ptcRuntime')` 探测，
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

如果第二组失败（子代理也不能跑命令），说明减震器**装错了位置** —— 请参看下面的
「设计要点」并检查 `ctx.logger` 里的 `dsh-multitask` 日志。

日志里能看到实际收窄了哪些工具：

```
dsh-multitask: coordinator scope engaged — withheld 21 tool(s): edit, pwsh, read_image, ssh_exec, ...
```

### 本机实测结果

以下是本机上真实跑出来的数字（端到端，非推算）。协调者与 worker 各派一个子代理自述工具面：

| | 协调者 | worker |
|---|---|---|
| 工具数 | **21** | **41–42** |
| `pwsh` | ❌ 不在可见面里 | ✅ 有 |
| `write` / `edit` | ❌ | ✅ |
| `ssh_*` / `task_board_*` / `web_search` / `read_image` | ❌ | ✅ |
| 实际执行命令 | 无法发起调用（工具不存在） | `echo final-ok` → `final-ok` |

> ⚠️ **这张表是「加入 `file_info` 之前」的实测值，上面两个数字都还没有重测。**
> 本轮新增的 `file_info` 同时进了协调者的保留集与整份 roster，按同一套算法（`deny = 可见集 − 保留集`）
> 推算，**加入后协调者预期 22、worker 预期 42–43**（两侧各多一个），而
> `withheld N tool(s)` 里的 N **预期不变**（可见集与保留集各 +1，差额守恒）。
> **但这些是推算，不是实测** —— 重测需要重启应用后开一个真实会话，本轮**没做**。
> 因此上表照旧保留 21 / 41–42 这两个**真正跑出来的**数字，宁可标明前提，也不写一个没跑过的数字。
> 同一条规则适用于上面那行日志样本里的 `withheld 21`。

一个有意思的旁证：worker 自己报告说，它的 system prompt 声称「你不能改文件、不能跑命令」，
但它的工具列表里明明有 `pwsh` —— 它主动指出了这个矛盾。这正是**机制**（工具限制）
与**提示词**必须一致的原因；后来修正 worker 人格就是为此（见下）。

---

## Worker 人格（一个实测发现的坑）

子代理加入的是**父级那一份 preset**，所以它们**默认继承协调者人格** ——
装出来就是「你也是协调者，你不能改文件、不能跑命令」。

这不是理论推演。本机首轮验证里，worker 的 system prompt 逐字写着：

> You are the coordinator (a "shock absorber") … your tool set is deliberately narrow
> — you cannot edit files or run commands

而那个 worker 实际上拥有全套工具。一个被告知「你不能执行」的 worker，会倾向于拒绝干活 ——
而那正是它唯一被派出去要做的事。

**修法**：本包给两个进程内委派行都配了独立的 worker 人格，并声明它拥有完整工具集。
两份**刻意不共用同一份文本**（上下文起点不同）：

| 委派行 | 人格常量 |
|---|---|
| `tool-subagent`（spawn） | `WORKER_PERSONA` |
| `tool-subagent-fork`（fork） | `FORK_PERSONA` |

`dsh-subagent` 会把它作为子代理**自己 scope** 上的 section 注册，
按 scope 层叠「最近的作用域赢得同名 section」的规则盖掉协调者那份。
（`subagent_ptc` / `subagent_minimal` 另有两份各自的 `*_PERSONA`，见「多模式子代理」一节。）

修复前后对比（实测）：

| | 修复前 | 修复后 |
|---|---|---|
| `You are the coordinator` 在 worker 提示词里 | 偏移 50 | **完全消失** |
| `WORKER subagent` | **不存在** | 偏移 60 |
| `FULL tool set` | **不存在** | 偏移 364 |

`verify.mjs` 曾有常驻回归用例防止以后有人把它改回去 —— 那个套件不随包发布，
但这条约束仍然成立：改回旧措辞会让上面的指纹表失效。

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

> 这条推断已用**真实的** `dsh-scope` / `dsh-tools` 模块实测验证过，不是只读源码得出的。
> 测试还带了反例对照：如果把子代理挂到协调者 scope 下（父子而非兄弟），它**确实**会丢工具 ——
> 这证明测试对 scope 结构是敏感的，不是碰巧通过。

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

1. 新建会话按 profile 的 `selectedDefault` 起手（本机是 Multitask）；
   `agent/created` 一到，减震器就把限制装上了；
2. 用户在**首轮之前**把该会话切成 standard —— 这是 DSH 允许的
   （`agent-preset/locked` 只挡「已经开跑」的会话）；
3. 切换会把该 agent 的 scope 父链**重绑**到 standard 的 generation key
   （注册表的 `bind()` → `binding.parent.rebind(generation.key)`）。于是减震器不再是
   它的祖先、收不到它按 scope 过滤的事件 —— **但限制本身不会因此消失**：
   `tools.restrict()` 把限制记在**该 agent 自己的 scope layer** 上
   （见 `dsh-tools` 的 `restrict()`：`this.layers.effect(this.ctx, …)`），重绑父链不动它；
4. 结果：那个 standard 会话被按 **Multitask 的保留集**削掉 21 个工具
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
> 否则说明用例是恒真的。当前实测：`13 条断言组，13 通过，0 失败`，判别力已确认。

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

已用真实会话核对过这一点：Multitask 会话里委派出的子代理，其
`subagent/descriptor` 的 persona 是 `WORKER subagent in Multitask mode`、
工具面 44 个（含 `read_image` / `pwsh`），路由 `coderelay/deepseek-v4.1-flash`；
而 standard 会话的子代理走的是 standard 的配置。两者在同一台机器上并存，
各用各的——这正是「多模式并存」应有的样子。

⚠️ 反过来的一条边界：**子代理的模型映射只在 Multitask 内生效**。
profile patch 里那份 `subagentModels` 挂在 `dsh-multitask` 那一行的 `config` 上，
由宿主半读进 composition 的委派行 `agentOptions`，所以它**只影响 Multitask 会话
委派出的子代理**；standard 会话里的子代理不受它管辖。这正是要求里的
「要分清楚」。

---

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\install-multitask.ps1 -Uninstall
```

它会删掉 profile patch 里的托管块（连周围空行一起清掉），并在动手前备份。
preset 会立刻从所有**新**会话的模式选择器里消失（已开跑的会话不受影响）。

不需要重启：DSH 会热重载这个 patch 文件，行被移除后插件被卸载，并在卸载时注销
自己那份 preset 声明（见 `lib/index.js` 的 `releaseOwn()` 与 `ctx.effect(() => () => …)`）。
如果模式仍然没消失，再重启应用，并检查日志里有没有 `dsh-multitask` 开头的警告。

想**临时停用**而不卸载，给这一行加 `disabled: true`（或用 `enabled: false` 关掉插件本身）：

```yaml
- id: multitask
  disabled: true
```

如果之前执行过第二步，可以单独撤回模型选择设置：

```powershell
node .\tools\enable-subagent-model-selection.mjs --revert
```

---

## 包结构

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → 装载时插入 host 行；dsh.client → 浏览器半
├── cordis.patch.yml                    # 向 profile roster 插入 plugin 行（供 bundle 安装方式用）
├── install-multitask.ps1               # 源码 checkout 的安装/卸载脚本（路径从自身推导）
├── LICENSE                             # MIT
├── README.md
├── test/
│   └── guard-mode-isolation-regression.mjs   # 减震器「模式隔离」回归校验（含反向验证）
├── tools/
│   └── enable-subagent-model-selection.mjs   # 第二步：打开子代理可选模型
├── lib/
│   ├── index.js                        # host 半：激活时向 agentPresets 声明自带 preset
│   └── client.js                       # ★ 浏览器半：设置里的一级页「Multitask」两张卡 + 通用设置两行
└── presets/multitask/
    ├── composition.mjs                 # preset 组成 + 协调者人格 + 各模式 worker 人格
    ├── coordinator-guard.mjs           # ★ 减震器（含「模式隔离」归属判据）
    ├── subagent-mode.mjs               # ★ 多模式子代理：PTC 呈现（零依赖，零 import）
    ├── minimal-guard.mjs               # ★ subagent_minimal 的自适应收窄（零依赖，零 import）
    ├── concurrency-guard.mjs           # ★ 本模式的子代理并发节流（零依赖，零 import）
    └── file-info.mjs                   # ★ 只读文件元数据工具 file_info（零依赖，零 import）
```

`package.json` 的 `files` 字段与上面这份清单一致，所以 `npm pack` 出的内容就是它 ——
**测试套件不在其中**（本包不发测试）。

### 自检

**本包不发测试套件**（见上面的 `files` 清单）。回归校验放在仓库的 `test/` 目录里，不在发布物中。
当前与减震器直接相关的那一套是**模式隔离回归**：

```powershell
node test/guard-mode-isolation-regression.mjs
```

它覆盖 13 条用例（归属判据、模式切换的两个方向、子代理不受影响、读不出归属时的取向…），
并自带**反向验证**：把归属判据改成 `if (false)` 后必须有 6 条变红，否则说明用例是恒真的。
实测：`13 条断言组，13 通过，0 失败`，判别力已确认。
脚本从自身位置推导被测模块，所以仓库放在任何路径下（含非 ASCII 路径）都能跑。

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

**为什么**（已实测确证）：本包在工作区里，**不在** HMR 监视根下，所以改源码**不会**自动重载 ——
Node 的 ESM 缓存会继续返回旧模块。profile patch 文件**确实**被 HMR 监听（`dsh-hmr` 在
`cordis.patch.yml` 上装了 watcher，且 HMR 本身是启用的），所以改这个文件**会被感知**；
但**「被感知」不等于「会重新加载模块」**：

> `?v=N` 改的是这一行的 **name**，而 `cordis-plugin-loader` 对一个**已有 fiber（条目已在运行）**
> 的条目，看到「只有 `name` 变了」时走的是 `_patchContext(["name"])` 分支 —— 而它只在 diff
> **含 `config`** 时才 `fiber.update()`，否则**什么都不做**，**也不会 `import()`**。
> 只有**没有 fiber** 的新条目才会走 `await this.init()` 去真正加载模块。

于是 `entry.options.name` 被记成 `?v=N+1`（patch 文本确实落盘了），但**模块从未被重新 `import()`，
fiber 既没卸载也没更新** —— 进程继续跑旧的那一份。实测复现：原地 bump `?v` → **import 调用 0 次**；
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

四个实测踩过的坑，都已写进代码和回归测试：

1. **相对导入不继承入口的 query。** 只给入口加 `?v=N`，入口刷新了，但它相对导入的
   `composition.mjs` 仍从旧缓存取 —— 改了 preset 文本却毫无变化、也不报错。
   本包显式把 query 逐层传播（入口 → composition → concurrency-guard / subagent-mode /
   minimal-guard / coordinator-guard），所以**一次递增刷新整张模块图**。
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
- **改源码后必须重启应用**（并习惯性递增 `?v=N`）—— 只递增 `?v=N` 对已在运行的条目是空操作，
  见「改源码后如何生效」；本包**没有**自动监听工作区源码。
- **第二步是宿主层设置**，打开后对所有 preset 生效，不只是 Multitask。
