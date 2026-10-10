# dsh-multitask — Multitask 减震器模式

[English](README.en.md) · [设计与实测记录](docs/DESIGN.md) · MIT License

一个装进 DSH 的工作模式：**主对话只做三件事** —— 理解你的需求、把需求翻译成任务书下发给子代理、汇总子代理的结论。读文件、跑命令、构建、搜索、调试所产生的一切过程性数据，都在**子代理的上下文**里消化，永不进入主对话。主对话的上下文因此长期只留高价值信息。

这不是靠提示词请求模型「请你自己别动手」，而是**机制**。选中本模式后，主对话（协调者）的工具面被实际收窄：写文件、跑命令、检索这类会带来大量过程数据的工具**不在它的可见面里** —— 调用不了，也就污染不了它的上下文。子代理（worker）相反：它拿到完整工具面，把活干完，只把结论带回来。

零运行时依赖，不改动 DSH 源码。

---

## 它和别的模式差在哪

| | 主对话（协调者） | 子代理（worker） |
|---|---|---|
| 工具面 | 只读核对 + 委派 + 结果回收 + 交互 | 完整（写文件、跑命令、构建、搜索…） |
| 上下文 | 你的需求 + 任务书 + 结论 | 全部过程数据 |
| 职责 | 理解、翻译、下发、核对、汇报 | 干活 |

协调者保留的工具（白名单）：

- **只读核对** —— `read` `grep` `glob` `file_info`
- **委派** —— `subagent` `subagent_fork` `subagent_ptc` `subagent_minimal`
- **子代理控制** —— `send_message` `interrupt_agent` `list_agents`
- **结果回收** —— `job_list` `job_output` `job_kill`
- **编排** —— `workflow`
- **交互与自我管理** —— `ask_user_question` `todo_write` `create_goal` `get_goal` `update_goal` `exit_plan_mode` `present` `skill`

不在上表里的工具默认对它关闭，例如 `write` `edit` `pwsh` `web_search` `web_fetch` `read_image`、`ssh_*`、`task_board_*`、`plugin_manager`。判据是**补集**：摘除面 = 当前可见集 − 保留集，所以宿主以后新增任何工具，默认也对协调者关闭，本插件不需要跟着改。

只读核对能力是刻意留给协调者的：它要能**独立验证**子代理的结论，而不是盲信回报。

---

## 安装

### 用发布包（推荐）

```
dsh plugin add dsh-multitask
```

或在 DSH 的**插件**页面里安装。包落在 profile 的 `node_modules` 下，由本包自带的 `cordis.patch.yml` 插入一行裸包名 `dsh-multitask`，不含任何绝对路径，所以在任何机器、任何用户名、任何安装位置都成立。

> **桌面版（Electron）注意**：应用自有的 `desktop` profile 由应用独占管理，CLI 会直接拒绝（`error: profile "desktop" is managed exclusively by the Electron application`）。这种情况请用应用内的**插件**页面安装，或走下面的源码安装路径。

### 从源码 checkout 运行

clone 本仓库、直接跑工作区里的源码时，在 profile 的 `cordis.patch.yml` 末尾**追加**一段，用**绝对** `file://` URL 指向本地入口：

```yaml
- insert:
    - id: multitask
      name: 'file:///你的绝对路径/dsh-multitask/lib/index.js?v=6'
```

两点注意：

- **路径里的空格与 `%` 必须百分号编码**（Windows 上尤其常见）。稳妥做法是让程序替你编码，而不是手写 —— 例如在 PowerShell 里：`(New-Object System.Uri('H:\my repo\dsh-multitask\lib\index.js')).AbsoluteUri`。
- **末尾的 `?v=N` 是缓存键**，只在 `file://` 这种方式下有意义（见「开发 → 改源码后如何生效」）。

**新增这一行不需要重启**：DSH 在 `cordis.patch.yml` 上装了 watcher，改动会被热重载。

---

## 使用

**新建会话**时，在模式选择器里选 **「Multitask 减震器模式」**，然后正常提需求即可。

> 模式只能在**会话开始前**选择。已经开跑的会话切不进来 —— 这是 DSH 的既有约束（工具面与提示词在首轮就冻结了），不是本插件的限制。

协调者会把你的需求翻译成**自包含**的任务书 —— 子代理看不到这段对话，所以任务书必须带上它需要知道的一切（目标、已核实的现状、项目约定、安全闸、编号任务、条件分支、停止条件、回报格式）。互不依赖的任务会**并行**下发，协调者一边等一边继续做事。

---

## 四类子代理

协调者有四条委派路径，差别主要在**工具面**：

| 委派工具 | 工具面 | 适用任务 |
|---|---|---|
| `subagent` | **完整** | 默认。写代码、跑测试、改文件、执行类任务 |
| `subagent_fork` | **完整** + 继承本对话的**已完成轮次** | 复查、续写 —— 需要「接着这份上下文往下做」时 |
| `subagent_ptc` | **PTC 塌缩**：只能直呼 `run_code`，其余工具在程序里经生成的 SDK 调用 | 程序化批量处理：海量数据的过滤/聚合/搬运，中转数据不该进上下文 |
| `subagent_minimal` | **只读**：摘掉写入与执行类工具 | 只读调研、快速问答、核查事实 |

拿不准用 `subagent`。这条判别指引写在协调者人格里，由它按任务自行选择。

**委派深度固定为 1**：协调者 → worker，worker 不能再往下派。需要拆分的任务由协调者拆成扁平的几份任务书。

---

## 设置

本包装好后，DSH 的设置里会多出这些：

**「Multitask」页 —— 两张卡**

| 卡片 | 字段 | 作用 |
|---|---|---|
| 子代理使用的模型 | `multitask.subagentModels[]` | 四类 worker 各自的默认模型。可选「所有子代理使用同一个模型」，也可按类型分别指定；默认是「继承协调者」。只对此后**新建**的会话生效 |
| 子代理并行数量上限 | `subagent.maxActiveSubagents` | 与「设置 → 通用设置」里那一行**是同一个字段**，改完即刻生效 |

**「通用设置」页 —— 两行**（与官方的语言 / 外观 / 开发者工具并排）

| 行 | 字段 | 作用范围 |
|---|---|---|
| 最大递归深度 | `subagent.maxDepth` | 宿主平面：对所有模式生效，不只是 Multitask |
| 子代理并行数量上限 | `subagent.maxActiveSubagents` | 同上，且与 Multitask 页那张卡是同一个值 |

会话头部还会显示当前正在运行的子代理数量。

模型卡的**形态不落盘**，由字段自身推导：四类指向同一条路线即「所有子代理使用同一个模型」，否则即「按类型分别指定」。切换形态本身不产生脏值。

### 子代理并发上限

**只有一个值**：宿主的 `subagent.maxActiveSubagents`。它在设置里出现在**两处**（「设置 → Multitask」的卡片，与「设置 → 通用设置」的一行），但两处编辑的是**同一个字段** —— 改一处另一处立刻跟着变，改完即刻生效。本插件不另设上限，也没有第二层在截你。

这个字段的默认值是 **8**：不做任何配置时，8 就是你能拿到的全部。但 8 是宿主的**默认值，不是天花板** —— **写的是多少，上限就是多少**。想跑 N 个，就把它设成 N：设置里两处任选一处，或给宿主那一行加 config：

```yaml
- id: subagent
  config:
    maxActiveSubagents: 16
```

超过上限时，多出来的委派**在启动之前**被丢弃，错误原文逐字为：

```
Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
```

这条拒绝来自**宿主**，不是本插件坏了，也不是故障：它是宿主在发名额时抛出的，发生在任何子代理被创建之前 —— 你拿到的是一条普通错误，而不是一个子代理 id。处理办法是**等现有的子代理结束**，或**把若干任务并进一份任务书**交给一个子代理完成；不要原样重试同一批扇出。

计数口径是「同一主 Agent 下**当前存活**的子代理总数」，不只是同一批发起的：一个已经交完活、但还没退出的 worker **仍然占着名额**。所以「派一批 → 等它们全部结束 → 再派下一批」才是安全的做法。

> ⚠️ **「派 10 个全都成功了」不能证明上限被放宽。** 那是**阻塞 / 串行**执行：一次只在跑 1 个，等它结束再派下一个，**活跃数从未超过 1**。只有**同一条消息里并行下发**才会真的去抢名额。判断并行还是串行，看同一时刻处于 running 的子代理个数，而不是「一共派出去几个」。

---

## 危险操作的审批

在这个模式里干活的全是子代理，而 DSH 默认把子代理的审批请求整条链条关掉（策略钉死为 `never`，模型还会自我审查）。本插件把它接回来，构成**两级闸门**：

| 级别 | 行为 |
|---|---|
| 第一级（确定性规则） | 安全的命令**直接执行，不打扰你** —— 无额外模型请求，也不改变沙箱 |
| 第二级（转呈父会话） | 危险命令**在主对话弹出审批卡**，由你批准或拒绝 —— 复用上游现成的审批面板，不新增 UI |

第一级补的是**沙箱表达不了**的那一类：工作区**之内**的破坏性命令（`rm -rf .`、`git reset --hard`、`git clean -fd`）、非文件类危险（`git push --force`、`npm publish`、`curl | bash`、提权、改执行策略）、以及往工作区之外写。漏判一条模式 = 与没有本插件完全一样，所以它只可能**增加**一次询问，不会减少任何保护。

**红线**：这一切**只在交互式会话**启用 —— 父会话的审批策略必须是 `ask`。headless / 无人值守部署靠 `never` 保证「不会被挂住等一个永远不来的答复」，本插件在那种环境里一个字都不动。

授权是**每次一次性**的：点「允许一次」只放行这一次，再次发同样调用会再次弹窗，没有「永久允许」。

**后台派单 + 你的回合已结束**时弹窗无处可弹（转呈要求父会话有一个打开的回合）。此时插件会尽力通过消息通道，让主对话出现一条来自该子代理的消息，写明是哪个子会话、想执行什么、去哪里作答。**那是通知，不是批准** —— 消息通道不携带审批结果，闭环仍然要在那个子会话里作答才能完成；在你作答之前，那次调用保持阻塞。

---

## 常见问题

**模式没出现在新会话的选择器里** —— 先确认这一行插件确实装上了（插件列表里能看到，且不是 `disabled`），再重启应用；仍然没有，就在日志里找 `dsh-multitask` 开头的警告，它会说明原因（注册表不在、composition 校验不过、id 被更早的模块实例占用等）。

**子代理执行任何命令都失败**，报错逐字为：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区路径>)
```

这不是并发的问题（只有一个子代理在跑也照样失败），也不是命令的问题（换成 `Get-Location` 也失败），而是**工作区目录的权限前置条件**：DSH 的 ACL 沙箱要在可写根上写一次安全描述符，其中包含完整性标签；标签住在 SACL 里，因而那次调用额外需要 **WRITE_OWNER**，而所有者的隐式权限只覆盖 `READ_CONTROL` 与 `WRITE_DAC`。只给自己授了 *Modify* 的目录因此缺这一项，调用就会失败 —— 所以用户目录下的工作区开箱可用，而直接建在盘符根下（只继承 Modify）的目录会全废。

**修复已经自动完成**：本插件在会话开始时检查工作区目录，缺 `WRITE_OWNER` 就**只补这一项**（一条非继承的 `TakeOwnership`），然后停止。它不需要批准、不需要提权，也**绝不要**把目录放宽到 *Full control* —— 那会额外给出「改权限 + 夺所有权」，远超所需。

若子代理仍然被拒，说明自动补没落地：目录**属于别的账户**，或它在当前进程**不可写**。这时请把「哪个目录、自动补没落地」如实交给你决策。**只读工具不受影响**，所以「读文件、查元数据、改文件」这类任务始终派得出去。

**撞上并发上限** —— 见上面的「子代理并发上限」。那是宿主的拒绝，等现有子代理结束，或把任务合并成一份任务书。

**审批弹窗没出现** —— 先确认当前会话的审批策略是 `ask`（headless 配置是 `never`，那时本插件完全不介入）；若你是后台派单且回合已经结束，见「危险操作的审批」最后一节。

**改了源码却不生效** —— 必须**重启应用**。只递增 profile patch 里的 `?v=N` 对已经在运行的条目是空操作：loader 只看到 name 变了，既不会重新加载模块，也不会重启。细节见 [docs/DESIGN.md](docs/DESIGN.md) 的「改源码后如何生效」。

---

## 验证它真的生效了

选中模式，让协调者试这几件事：

| 你说 | 期望 |
|---|---|
| 「你直接读一下 package.json 告诉我版本」 | ✅ 成功（只读核对是保留的） |
| 「你自己跑一下 `git status`」 | ❌ 调用不了 —— 工具不在它的可见面里 |
| 「派个子代理跑 `git status` 并把结论告诉我」 | ✅ 子代理成功执行，只把结论带回来 |
| 「派个子代理读一下 package.json 并报出文件名与大小」 | ✅ 只读路径始终可用（`read` / `file_info`） |

日志里能看到实际收窄了哪些工具（前缀 `dsh-multitask:`）：

```
dsh-multitask: coordinator scope engaged — withheld N tool(s): edit, pwsh, read_image, ssh_exec, ...
```

审批闸门的前置条件与验证步骤（含后台派单的兜底通路）写在 [docs/DESIGN.md](docs/DESIGN.md) 的「验证它真的生效了」与「审批闸门」两节。

---

## 可调项（profile）

按 **id 定位**覆盖，追加在 `dsh-multitask` 那段 `insert` 之后即可（同 id 的后者覆盖前者）：

```yaml
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

用 `enabled: false` 可整个关掉本插件（不声明 preset，模式从选择器消失）。

其余开关改 `presets/multitask/composition.mjs` 里对应行的 `config`：

| 行 | 关掉的效果 |
|---|---|
| `subagent-mode` | PTC 呈现停用，`subagent_ptc` 退化成与 `subagent` 一样的原生工具面 |
| `minimal-guard` | 只读 worker 退回「只摘静态三项」，重新看到别的插件装进来的写入类工具 —— **没有安全收益** |
| `approval-gate` | 危险操作不再弹窗（回到 DSH 默认行为） |
| `workspace-acl` | 不再自动补 `WRITE_OWNER`（也可用 `config.autoGrantWriteOwner: false`） |

环境变量 `DSH_MULTITASK_MULTI_MODE=0` 一次停用 `subagent_ptc` / `subagent_minimal` 两条路径与 PTC 呈现插件，不影响原有的 `subagent` / `subagent_fork`；它在模块加载时读取，需要重启应用。

改源码必须在**重启**后生效。

---

## 卸载

用包管理器装的，交给它：`dsh plugin remove dsh-multitask`，或在**插件**页面里卸载。
从源码 checkout 装的，把 profile patch 里那一整段 `- insert: - id: multitask` 删掉。

两种方式下，模式都会从**新**会话的选择器里消失（已开跑的会话不受影响），且**不需要重启** —— DSH 会热重载这个 patch，插件卸载时会注销自己那份 preset 声明。想**临时停用**而不卸载，给那一行加 `disabled: true`。

---

## 开发

```
dsh-multitask/
├── package.json                        # dsh.bundle.patch → 装载时插入 host 行；dsh.client → 浏览器半
├── cordis.patch.yml                    # 向 profile roster 插入 plugin 行
├── lib/
│   ├── index.js                        # host 半：激活时向 agentPresets 声明自带 preset
│   └── client.js                       # 浏览器半：设置页「Multitask」+ 通用设置两行
├── presets/multitask/
│   ├── composition.mjs                 # preset 组成 + 协调者人格 + 四类 worker 人格
│   ├── coordinator-guard.mjs           # 减震器（含「模式隔离」归属判据）
│   ├── subagent-mode.mjs               # PTC 呈现：把带标记的子代理塌缩成 run_code
│   ├── minimal-guard.mjs               # 只读 worker 的自适应收窄
│   ├── approval-gate.mjs               # 审批闸门：危险操作弹窗
│   ├── workspace-acl.mjs               # 工作区 ACL：补 WRITE_OWNER（唯一改系统状态的模块）
│   └── file-info.mjs                   # 只读元数据工具 file_info
├── docs/DESIGN.md                      # 设计推导、实测记录、验证清单
├── README.md / README.en.md
└── LICENSE
```

预设模块（`presets/multitask/*.mjs`）**零 import**：它们不引入任何 `@deepseek-ai/*` 依赖 —— 导入失败等于整份 preset 挂载失败。代价是少量常量各自留一份，由校验脚本比对。

### 自检

> ★ **规矩：所有测试文件都必须写进 `test/`。**
> 探针、校验脚本、一次性核对、诊断脚本、回归套件 —— 一律放 `test/`，用 `node test/<名字>.mjs` 运行，不要放在别处。`test/` 整个目录被 `.gitignore` 忽略，按「是测试就不进远端」的规矩刻意不跟踪，也不进发布物。

本地现有七套校验，都从脚本自身位置推导被测模块，所以仓库放在任何路径下（含非 ASCII 路径）都能跑：

```powershell
node test/guard-mode-isolation-regression.mjs    # 模式隔离回归（13 条断言组）
node test/repo-consistency.mjs                   # 仓库一致性 / 文档一致 / 测试归位（38 条断言组）
node test/subagent-mode-marker-source.mjs        # 模式标记的来源（前台与后台两条派单路径，9 条用例）
node test/minimal-guard-catalog.mjs              # 只读 worker 的目录级过滤（12 条用例）
node test/approval-gate-rules.mjs                # 审批规则表的漏判与误报（8 条断言组）
node test/approval-gate-integration.mjs          # 审批闸门的门控 / 事件形状 / 转呈方向（38 条断言组）
node test/workspace-acl-rules.mjs                # 工作区 ACL 的红线与决策（14 条断言组）
```

它们都是**进程内**运行、自带极小的 `test()` 运行器，不 spawn 子进程、不捕获管道输出（在受限沙箱下 `node --test` 会以 `spawn EPERM` 失败）。多数套件还自带**反向验证**：把关键守卫改坏，对应用例必须变红 —— 一条永远绿的断言等于没有那条断言。

### 改源码后如何生效

**改完源码要重启应用。** 本包在 HMR 监视根之外，Node 的 ESM 缓存会继续返回旧模块；profile patch 虽然会被热重载，但**改一个已经在运行的条目的 `?v=N` 只改到它的 name**，loader 走 name-only 分支、不重新加载。新进程首次加载该条目时，才会真正读到你最新的源码。

顺带两条容易踩的：相对导入**不继承**入口的 query（本包显式逐层传播，所以一次递增刷新整张模块图）；「在同一次保存里删掉又加回」也无效（按 id 比对，仍是同一个条目），必须删、等稳定、再加回。

---

## 已知边界

- **模式只能在新会话里选。** 已开跑的会话切不进来。
- **协调者看不见的东西，它也无法核对。** 保留只读工具正是为了让它能独立验证子代理的结论；若把 `read` / `grep` / `glob` 也摘掉，核实能力就没了。
- **委派深度是 1。** worker 不能再派；超大任务需要协调者拆成并行的多份任务书。
- **PTC 的「塌缩」是呈现塌缩，不是能力削减 —— 这是设计，不是缺陷。** `subagent_ptc` 的直接工具面确实只剩 `run_code`，但那份 SDK 绑定表仍然完整可调用（从程序内部）；砍掉它，PTC 就只剩一个空壳。
- **只读 worker 是「两层收窄」，仍然不是沙箱。** 静态 `toolFilter` 与自适应补收窄在 `dsh-tools` 里是求交关系，结构上不可能放宽；但若某个插件在 worker 创建**之后**才注册一个新的变更类工具，那个工具不会被摘掉（有意取舍）。
- **审批闸门的兜底只是一条指路通知。** 转呈失败时请求会一直挂着，通知不解除它；真正的解除要靠你在那个子会话里作答。
- **规则表是模式匹配，会漏判新型危险命令。** 所以真正的闸门是第二级转呈，第一级只负责「安全的不用打扰用户」。
- **上游改版可能让某个守卫失效**，失效取向一律是「回到没有该守卫的行为」，不是权限被放大。

更完整的边界、未确证项、以及每条结论的实测依据，都在 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
