/**
 * dsh-multitask — 浏览器半（client bundle）。
 *
 * 职责有两个座位：
 *   1. 「设置」里的**一级页面**「Multitask」：按类型或统一指定子代理使用的模型；
 *   2. 「设置 → 通用设置」里的**两行**：最大递归深度、子代理并行数量上限。
 * 都是「本模式真正可配的行为集中到设置里」，而不是散落在「插件」侧栏页。
 *
 * ── 为什么是 `settings.section` 而不是 `plugins.item` ────────────────────────
 * 官方四个内置配置页（ui-settings-shell / -agent-loop / -subagent / -web-search）
 * 都注册进 `plugins.item`，而那个 slot 是**侧栏「插件」页**的子槽（由
 * `@deepseek-ai/dsh-client-ui-plugin-manager` 在 `main` 上声明），**不在设置里**；
 * 插件页自己的说明文案就是「在这里配置官方插件……内置插件列表及运行状态可在
 * 「设置 → 内置插件」中查看」。用户的诉求是「在设置中增加」并且「方便新用户」，
 * 所以这里改用 `settings.section` —— 设置导航里的一级页面，由
 * `@deepseek-ai/dsh-client-ui-settings-general` 无常声明，不需要额外的可见性条件。
 *
 * ── 为什么两项运行限制走 `settings.general.item` ─────────────────────────────
 * 它们是**宿主平面**设置（对所有模式生效，不只 Multitask）。放在本插件自己那一页
 * 会让人以为只对 Multitask 有效，所以放进「通用设置」 —— 那个 slot 正是官方为
 * 「不需要独立页面、只占一行的偏好」准备的座位（官方用它放语言 / 外观 / 开发者
 * 工具）。注意它的注册项只有 `id` / `order`，**没有 `label`**：那一段只负责把行
 * 竖着摞起来，行内部（含标题）由行自己画，所以每一行都带自己的 inject face。
 *
 * ── 本文件是在浏览器里跑的 ───────────────────────────────────────────────────
 * 它不是 ES 模块，而是 DSH 的 lazy-CJS 产物：外层 `window.__ModuleLoader__.load`
 * 注册一个 factory，factory 内用**同步 `require`** 取依赖。可用的 specifier 只有
 * 两类：(1) 平台种子表（react / react/jsx-runtime / react-dom / react-dom/client /
 * @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
 * dsh-client-ui-primitives / dsh-client-ui-dockkit）；(2) 在 package.json 的
 * `dsh.client.inject` 里列出的包。本文件只 require 种子表里的 "react"，其余一切
 * 都走 cordis 的服务注入（ctx.locale / ctx.configForms / ctx.remote）。
 *
 * ⚠️ 本文件**必须先于** package.json 里的 `dsh.client` 声明存在：声明了
 * `dsh.client` 而 `exports["./client"]` 指不到文件时，客户端模块系统会抛
 * MissingClientBundleError，整个 `clientModules` fiber FAILED —— 那会让
 * `window.__DSH_BOOT__` 再也不被注入，整张 Web 插件名单都加载不出来。
 */

window.__ModuleLoader__.load({
	id: "dsh-multitask",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region 文案
		/** English copy. */
		const en = {
			nav: "Multitask",
			title: "Multitask",
			intro: "Settings that govern how the shock-absorber mode delegates work to Subagents.",
			unavailable: "This deployment does not serve that settings namespace, so it cannot be configured here.",
			readOnly: "This deployment stores settings read-only.",
			loading: "Reading the current configuration…",
			saving: "Saving…",
			saveFailed: "The deployment did not accept that change, so the control was reset to the stored value.",
			modelsTitle: "Model used by Subagents",
			modelsScopeNote: "Which model each kind of Subagent gets by default. Applies to sessions created afterwards only — a session that is already running keeps the configuration it started with, including the Subagents it delegates after this change. Open a new session to apply it.",
			modelsRef: "multitask.subagentModels[]",
			modelsCatalogLoading: "Loading models…",
			modelsCatalogFailed: "The model catalog could not be loaded, so no model can be chosen yet.",
			modelsCatalogRetry: "Retry",
			modelsCatalogPartial: "Some providers could not be loaded; a saved choice that is no longer advertised stays selectable so you can clear it.",
			modelsCatalogEmpty: "No provider currently advertises a model.",
			modelsConflict: "Settings changed elsewhere. The list below shows the stored values — choose again to apply your change.",
			uniformLabel: "Use one model for every Subagent",
			uniformDesc: "Yes: all four kinds share one model. No: each kind gets its own.",
			optSame: "Yes",
			optPerType: "No",
			uniformSelectLabel: "Model Subagents use",
			uniformSelectDesc: "All four kinds of Subagent use this single model.",
			uniformUnset: "Choose a model",
			typeModelsInherit: "Inherit coordinator (default)",
			typeModelsUnavailable: " (saved but currently unavailable)",
			typeSubagent: "subagent",
			typeSubagentFork: "subagent_fork",
			typeSubagentPtc: "subagent_ptc",
			typeSubagentMinimal: "subagent_minimal",
			typeSubagentHint: "full tool surface (write files, run commands, build)",
			typeSubagentForkHint: "inherits this conversation's completed turns",
			typeSubagentPtcHint: "PTC surface (calls run_code)",
			typeSubagentMinimalHint: "read-only surface (research, quick answers)",
			// ⚠️ 它编辑的是**宿主**的字段（`subagent.maxActiveSubagents`），
			// 与 Settings → General 里那一行**是同一个值**：改一处另一处立刻跟着变。
			// 卡片标题与宿主那一行**逐字一致** —— 措辞一致本身就在传达「这是同一个设置」。
			//
			// ⚠️ 文案分**三层**，各说各的，不许互相重复（这一条是踩过坑后写下的：
			// 早先卡片标题与行标题一字不差、说明又各讲了一遍计数口径，同一屏里
			// 同一句话出现三次 —— 实测截图确认）。三层各司其职：
			//   1. `concurrencyTitle`  —— 这张卡**叫什么**（与宿主那行同名）；
			//   2. `concurrencyScopeNote` —— 它**与谁同源**（这张卡的存在理由）；
			//   3. `maxActiveHint`（复用宿主的）—— 这个数**在数什么**（+ 控件行）。
			concurrencyTitle: "Subagent parallelism limit",
			concurrencyRef: "subagent.maxActiveSubagents",
			concurrencyScopeNote: "The same value as the row in Settings → General — change it in either place and the other follows.",
			maxDepth: "Maximum recursion depth",
			maxDepthHint: "0 disables Subagents entirely",
			maxActive: "Subagent parallelism limit",
			maxActiveHint: "total live Subagents under one main Agent",
			stepDown: "Decrease",
			stepUp: "Increase",
			invalidDepth: "Enter a whole number of 0 or more.",
			invalidActive: "Enter a whole number of 1 or more.",
			// 会话头部那一格（与设置页共用同一个 NS）：用 headerRunning* 前缀，
			// 免得和上面的设置项键名相撞。
			headerRunning: "{count} running",
			headerRunningNone: "No Subagents running",
			headerRunningUnavailable: "Running Subagent count unavailable",
			// 子代理停滞看门狗：面板用**秒**，配置里存**毫秒**（换算只在控制器里各做一次）。
			watchdogTitle: "Subagent stall watchdog",
			watchdogNote: "Only sessions created after saving use these values; a session that is already running keeps what it started with.",
			watchdogStallLabel: "How long a subagent must be quiet to count as stalled (seconds)",
			watchdogStallHint: "Measured in seconds from the Subagent's last output.",
			watchdogTickLabel: "Advanced: check interval (seconds), rarely needs changing",
			watchdogTickHint: "Seconds between checks; the default usually fits.",
			watchdogModeLabel: "When a Subagent stalls",
			watchdogModeOff: "Watchdog off",
			watchdogModeLog: "Record only",
			watchdogModeInterrupt: "Stop and wake",
			invalidSeconds: "Enter a whole number of 5 or more.",
			// 思考强度：档位**只能**来自模型目录（`models[].reasoning.efforts`），
			// 所以这里的文案只负责「没选 / 默认 / 各不相同」三种非档位状态。
			effortLabel: "Reasoning effort",
			effortDefault: "Model default",
			// 子代理聊久了会被自动总结。这张卡只决定「给总结留多少空间」，
			// 是手动覆盖的入口：缺省预算已适配常见模型，一般不需要动。
			compactionTitle: "Subagent context compaction",
			compactionRef: "multitask.compaction",
			compactionNote: "When a Subagent's conversation grows long it is summarized automatically; this decides how much room that summary gets. The defaults fit common models, so you normally do not need to touch this. Changes apply to new sessions only.",
			compactionHeadroomLabel: "Tokens reserved before compaction",
			compactionHeadroomHint: "Room kept free for the summary before automatic compaction starts (the grey number in the box is what is currently in effect). DSH's own default of 65536 makes small-context models run out of room and fail outright.",
			compactionMaxLabel: "Maximum tokens for the summary",
			compactionMaxHint: "A cap on how long the summary may get — a cap, not a target. Left empty it follows the reserved value above.",
			invalidTokens: "Enter a whole number of 1 or more."
		};
		/** Simplified Chinese copy. */
		const zh = {
			nav: "Multitask",
			title: "Multitask",
			intro: "减震器模式下，协调者向子代理派活时的相关设置。",
			unavailable: "本部署没有提供该设置命名空间，暂时无法在此配置。",
			readOnly: "本部署的设置为只读。",
			loading: "正在读取当前配置…",
			saving: "保存中…",
			saveFailed: "本部署没有接受这次修改，控件已回到已保存的值。",
			modelsTitle: "子代理使用的模型",
			modelsScopeNote: "决定各类子代理默认用哪个模型。只对此后新建的会话生效：已开跑的会话（含它之后派出的子代理）一直用启动时那份配置，要让改动生效请新开一个会话。",
			modelsRef: "multitask.subagentModels[]",
			modelsCatalogLoading: "正在加载模型…",
			modelsCatalogFailed: "无法加载模型目录，因此暂时无法选择模型。",
			modelsCatalogRetry: "重试",
			modelsCatalogPartial: "部分模型提供方暂时无法加载；已保存但不再公布的选项仍可选中，以便你把它清掉。",
			modelsCatalogEmpty: "当前没有模型提供方公布模型。",
			modelsConflict: "设置已在其他位置更新；下方显示的是已保存的值，请重新选择。",
			uniformLabel: "所有子代理使用同一个模型",
			uniformDesc: "选「是」：四类子代理共用同一个模型。选「否」：每类单独指定。",
			optSame: "是",
			optPerType: "否",
			uniformSelectLabel: "子代理使用的模型",
			uniformSelectDesc: "四类子代理都使用这一个模型。",
			uniformUnset: "请选择模型",
			typeModelsInherit: "继承协调者（默认）",
			typeModelsUnavailable: "（已保存但当前不可用）",
			typeSubagent: "subagent",
			typeSubagentFork: "subagent_fork",
			typeSubagentPtc: "subagent_ptc",
			typeSubagentMinimal: "subagent_minimal",
			typeSubagentHint: "完整工具面（写文件、跑命令、构建）",
			typeSubagentForkHint: "继承本对话的已完成轮次",
			typeSubagentPtcHint: "PTC 塌缩面（直呼 run_code）",
			typeSubagentMinimalHint: "只读面（只读调研 / 快速问答）",
			// ⚠️ 这张卡编辑的是**宿主**的字段（`subagent.maxActiveSubagents`），
			// 与「设置 → 通用设置」里那一行**是同一个值**：改一处另一处立刻跟着变。
			// 卡片标题与宿主那一行**逐字一致** —— 用户要的就是「看起来是同一个设置」，
			// 措辞一致本身就在传达这件事。
			//
			// ⚠️ 文案分**三层**，各说各的，不许互相重复（踩过坑：早先卡片标题与行标题
			// 一字不差、说明又各讲了一遍计数口径，同一屏里同一句话出现三次）。
			//   1. `concurrencyTitle`  —— 这张卡**叫什么**（与宿主那行同名）；
			//   2. `concurrencyScopeNote` —— 它**与谁同源**（这张卡的存在理由）；
			//   3. `maxActiveHint`（复用宿主的）—— 这个数**在数什么**（+ 控件行）。
			concurrencyTitle: "子代理并行数量上限",
			concurrencyRef: "subagent.maxActiveSubagents",
			concurrencyScopeNote: "与「设置 → 通用设置」里那一行是同一个值，改一处另一处立刻跟着变。",
			maxDepth: "最大递归深度",
			maxDepthHint: "填 0 即完全禁用子代理",
			maxActive: "子代理并行数量上限",
			maxActiveHint: "同一主 Agent 下同时存活的子代理总数",
			stepDown: "减少",
			stepUp: "增加",
			invalidDepth: "请输入不小于 0 的整数。",
			invalidActive: "请输入不小于 1 的整数。",
			headerRunning: "{count} 个正在运行",
			headerRunningNone: "没有正在运行的子代理",
			headerRunningUnavailable: "无法获取正在运行的子代理数",
			watchdogTitle: "子代理停滞看门狗",
			watchdogNote: "只对保存后新建的会话生效；已在跑的会话沿用启动时的值。",
			watchdogStallLabel: "子代理安静多久算停滞（秒）",
			watchdogStallHint: "从子代理最后一次输出算起的秒数。",
			watchdogTickLabel: "高级：巡检频率（秒），一般不需要改",
			watchdogTickHint: "每隔多少秒巡检一次；通常用默认值即可。",
			watchdogModeLabel: "超时处理",
			watchdogModeOff: "关闭看门狗",
			watchdogModeLog: "只记录不停止",
			watchdogModeInterrupt: "停止并唤醒",
			invalidSeconds: "请输入不小于 5 的整数。",
			// 思考强度：档位**只能**来自模型目录（`models[].reasoning.efforts`），
			// 所以这里的文案只负责「没选 / 默认 / 各不相同」三种非档位状态。
			effortLabel: "思考强度",
			effortDefault: "模型默认",
			// 子代理聊久了会被自动总结。这张卡只决定「给总结留多少空间」，
			// 是手动覆盖的入口：缺省预算已适配常见模型，一般不需要动。
			compactionTitle: "子代理上下文压缩",
			compactionRef: "multitask.compaction",
			compactionNote: "子代理聊久了，前面的对话会被自动总结成一段摘要；这里决定给这次总结留多少空间。默认值已经适配常见模型，一般不需要改。改动只对新开的会话生效。",
			compactionHeadroomLabel: "压缩前预留多少 token",
			compactionHeadroomHint: "自动压缩开始前，先给摘要留出来的余量（输入框里的灰字就是当前生效的值）。DSH 自带的 65536 会让小窗口模型直接放不下，压缩根本跑不起来。",
			compactionMaxLabel: "摘要最多写多少 token",
			compactionMaxHint: "摘要最多允许写多长——只是上限，不是目标长度。留空时跟随上面「预留」的值。",
			invalidTokens: "请输入不小于 1 的整数。"
		};
		//#endregion
		//#region 通用工具
		/** 本插件的字典命名空间。 */
		const NS = "settings.multitask";
		/** 子代理运行限制所在的宿主命名空间（由 dsh-base 的 `subagent` 行提供）。 */
		const LIMITS_NS = "subagent";
		/** 路线身份串：provider 与 model 之间用一个不会被 id 用到的分隔符。 */
		function routeKey(route) {
			return route.provider + "\u0000" + route.model;
		}
		/** 把草稿文本解析成整数；非法返回 undefined。 */
		function parseWhole(text, floor) {
			const trimmed = String(text === undefined || text === null ? "" : text).trim();
			if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) return undefined;
			const value = Number(trimmed);
			if (!Number.isSafeInteger(value) || value < floor) return undefined;
			return value;
		}
		/**
		 * 极小的可订阅状态容器。
		 *
		 * 刻意不依赖渲染层的 hooks 约定（官方页用 `hooks: {...}` + `useXxx` 绑定），
		 * 而是自己维护监听者，配合组件内的 useSyncExternalStore 风格订阅 —— 少一层
		 * 契约就少一处可能让整页空白的失败点。
		 */
		function createStore(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (next) => {
					snapshot = next;
					for (const listener of [...listeners]) listener();
				}
			};
		}
		/** 用 store 驱动一个 React 组件。 */
		function useStore(store) {
			return react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}
		//#endregion
		//#region 「子代理运行限制」控制器（读写 subagent）
		/**
		 * 读写宿主 `subagent` 命名空间里的两项运行限制。
		 *
		 * ── 为什么是「改完即写」而不是「草稿 + 保存」────────────────────────────
		 * 这两项住在「设置 → 通用设置」里，而通用设置那一段的行都是**即时生效**的
		 * 偏好行（官方的语言、外观、开发者工具都是这个形态），整段没有保存按钮。
		 * 所以这里不维护草稿：+/- 点一次写一次，文字框在失焦 / 回车时写一次。
		 * 若沿用草稿 + 保存，用户在通用设置里改完就会以为已经生效 —— 那是撒谎。
		 */
		var LimitsController = class {
			/**
			 * @param form - 宿主 `subagent` 命名空间的共享表单。
			 */
			constructor(form) {
				this.form = form;
				this.saving = false;
				this.failed = false;
				this.disposed = false;
				this.saveGeneration = 0;
				this.store = createStore(this.projection());
				this.unsubscribe = form.subscribe(() => {
					if (this.disposed) return;
					this.publish();
				});
			}
			/** 停止订阅并作废在途的写入结算。 */
			dispose() {
				this.disposed = true;
				this.saveGeneration += 1;
				this.unsubscribe();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			getState() {
				return this.store.getSnapshot();
			}
			/** 表单快照里的已存储值。 */
			snapshotValue() {
				const snapshot = this.form.getSnapshot();
				const value = snapshot.value || {};
				return {
					status: snapshot.status,
					writable: snapshot.writable === true,
					revision: snapshot.revision,
					maxDepth: value.maxDepth,
					maxActive: value.maxActiveSubagents,
				};
			}
			/**
			 * 写一项运行限制。
			 *
			 * 非法值由调用方拦下（这里只接受已经解析好的整数）；与已存储值相同时
			 * 直接返回，不做一次没有意义的写入。
			 * @param field - 字段名：`maxDepth` 或 `maxActive`。
			 * @param value - 已经解析好的整数。
			 */
			async commit(field, value) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				const path = field === "maxDepth" ? "maxDepth" : "maxActiveSubagents";
				if (stored[field] === value) return;
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.publish();
				const accepted = await this.form.mutate([{ op: "set", path: [path], value }], stored.revision);
				if (generation !== this.saveGeneration || this.disposed) return;
				const landed = this.snapshotValue()[field] === value;
				this.saving = false;
				this.failed = accepted !== true || !landed;
				this.publish();
			}
			projection() {
				const stored = this.snapshotValue();
				const depthText = stored.maxDepth === undefined ? "" : String(stored.maxDepth);
				const activeText = stored.maxActive === undefined ? "" : String(stored.maxActive);
				return {
					status: stored.status,
					writable: stored.writable,
					depthText,
					activeText,
					// 「这项有没有配」与「草稿合不合法」是两件事：字段缺席时输入框是空的，
					// 但那是**未设置**，不是**填错了**，所以不在这里判成错误。
					depthSet: parseWhole(depthText, 0) !== undefined,
					activeSet: parseWhole(activeText, 1) !== undefined,
					saving: this.saving,
					failed: this.failed,
				};
			}
			publish() {
				if (this.disposed) return;
				this.store.set(this.projection());
			}
		};
		//#endregion
		//#region 「子代理模型与并发上限」控制器（读写 multitask）
		/**
		 * 本插件自己的宿主命名空间 —— 就是本包在 profile 里的**条目 id**。
		 *
		 * `dsh-settings` 用 `entry.options.id` 作命名空间（`describe()` 的 `ns`），
		 * 而本包由 `cordis.patch.yml` 以 `insert: [{ id: multitask, ... }]` 插入，
		 * 所以这里的值必须与那个 id 逐字一致。刻意与 `MODEL_NS` / `LIMITS_NS`
		 * 用同一种「字符串拼写」写法：客户端包不 import 宿主包。
		 */
		const TYPE_MODELS_NS = "multitask";
		/**
		 * 4 类 worker 的类型键。
		 *
		 * ⚠️ 必须与宿主半 `lib/index.js` 的 `WORKER_MODEL_TYPES`、以及
		 * `composition.mjs` 导出的同名常量**逐字一致**。三处任一漂移都会让面板
		 * 提供一个无效选项（宿主侧会静默丢弃它，用户看到的则是「选了但没生效」）。
		 * 浏览器端无法 import 那两个文件，故以字符串拼写；
		 * `presets/multitask/run-model-map-tests.mjs` 最后一条用例断言宿主与
		 * composition 两处逐字相同，本文件的这份由 `_work` 下的静态探针核对。
		 */
		const WORKER_TYPES = ["subagent", "subagent_fork", "subagent_ptc", "subagent_minimal"];
		/**
		 * ⚠️ **并发上限不在这里了 —— 它属于宿主命名空间 `subagent`。**
		 *
		 * 本类曾经同时管第二个字段 `maxActiveSubagents`（本插件自己的并发上限）。
		 * 那个字段连同 `concurrency-guard.mjs` 已整条删除：它只决定本插件的守卫要不要装，
		 * 而真正决定「同时能跑几个」的是宿主的同名上限 —— 两套账执行同一个数字，
		 * 于是「本模式设不限制」的用户依然被宿主的默认 8 卡住。
		 *
		 * 现在「设置 → Multitask」那张并发卡与「设置 → 通用设置」那一行编辑的是
		 * **同一个值**（宿主 `subagent.maxActiveSubagents`），两者共用同一个
		 * `LimitsController` 实例 —— 所以改一处另一处立刻跟着变，不需要任何同步代码。
		 * 本类从此只管模型映射。
		 */
		/**
		 * 本字段与页面其它数字输入共用的下限。
		 *
		 * 常量只留**一处**：数字框的 `parseWhole`、加减按钮的 `Math.max` 读的都是它
		 * —— 于是「不能填 0」不可能在某一条路径上被漏掉。
		 */
		const CONCURRENCY_FLOOR = 1;
		/** 类型键 → 那一行说明文案的字典键。 */
		const TYPE_LABEL_KEYS = {
			subagent: "typeSubagent",
			subagent_fork: "typeSubagentFork",
			subagent_ptc: "typeSubagentPtc",
			subagent_minimal: "typeSubagentMinimal",
		};
		/**
		 * 把「类型 → 路线」序列化成宿主字段要的数组。
		 *
		 * 按 `WORKER_TYPES` 的固定顺序产出：写回时顺序稳定，用户改一次 A 不会让
		 * 数组里 B 的位置跟着抖动（抖动的 diff 会让「设置被外部改动」的冲突判断
		 * 变得难读）。
		 *
		 * @param map - 类型 → `{ provider, model, reasoningEffort? }`。
		 * @returns `[{ subagentType, provider, model, reasoningEffort? }]`，只含已指定的类型。
		 */
		function serializeModelMap(map) {
			const list = [];
			for (const type of WORKER_TYPES) {
				const route = map.get(type);
				if (route === undefined) continue;
				const entry = { subagentType: type, provider: route.provider, model: route.model };
				// ★ `reasoningEffort` 必须一起写回：早先这里只写三个字段，于是用户在
				// 面板上**改别的类型**时，这一类的思考强度会被整份数组的重写抹掉
				// —— issue #4 报的「effort 被丢弃」里就有这一处。
				if (typeof route.reasoningEffort === "string" && route.reasoningEffort !== "") {
					entry.reasoningEffort = route.reasoningEffort;
				}
				list.push(entry);
			}
			return list;
		}
		/**
		 * 两组「类型 → 路线」是否等价。
		 *
		 * ⚠️ `reasoningEffort` **必须**参与比较：少了它，「只改了强度」的一次选择会被
		 * 判成「没有变化」而根本不提交（`commit()` 开头就是这条早退）。
		 * @param left - 一组映射。
		 * @param right - 另一组映射。
		 * @returns 是否完全一致（顺序无关）。
		 */
		function sameModelMap(left, right) {
			return WORKER_TYPES.every((type) => {
				const a = left.get(type);
				const b = right.get(type);
				if (a === undefined || b === undefined) return a === undefined && b === undefined;
				return a.provider === b.provider
					&& a.model === b.model
					&& (a.reasoningEffort || "") === (b.reasoningEffort || "");
			});
		}
		/**
		 * 一条路线是否指向与 `current` **同一个模型**。
		 *
		 * 用途只有一个：决定要不要保留已有的 `reasoningEffort`。上游
		 * `resolveChildAgentOptions()` 的语义是「路由变了且没指定强度 ⇒ 删掉继承值，
		 * 交回模型默认」—— 所以换模型时**必须**丢掉旧的强度（那个 id 属于旧模型、
		 * 在新模型上可能根本不存在），而重选同一个模型要保留它。
		 * @param current - 已存的路线，可能没有。
		 * @param provider - 新路线的 provider。
		 * @param model - 新路线的 model。
		 * @returns 是否同一个模型。
		 */
		function sameRoute(current, provider, model) {
			return current !== undefined && current.provider === provider && current.model === model;
		}
		/**
		 * `multitask` 表单的控制器 —— **本类只管模型映射**。
		 *
		 * 它曾经同时管第二个字段 `maxActiveSubagents`（本插件自己的并发上限）。
		 * 那条链路已整条删除（见 `lib/index.js` 与 composition 里的说明），
		 * 现在并发上限由 `LimitsController`（宿主 `subagent` 命名空间）独家管理 ——
		 * 「设置 → Multitask」那张卡与「设置 → 通用设置」那一行读写的都是它。
		 *
		 * ── 为什么这两件事当时必须在同一个控制器里（历史，留着以免重建错误）──────
		 * `configForms` 的冲突判定是**按命名空间计一次 revision** 的：表单快照带一个
		 * `revision`，`mutate(ops, expectedRevision)` 用它对账。当两个字段同属
		 * `multitask` 命名空间时，若为并发上限另起一个控制器去读**同一个**表单，
		 * 两个控制器就会各自冻结一份 `revision`、各自写一次 —— 先写的那次把 revision
		 * 推高，后写的那次被判成「设置已在其他位置更新」，或退化成半保存。
		 *
		 * ⚠️ 现在两个字段**已在不同的命名空间**（模型映射在 `multitask`、并发上限在
		 * `subagent`），所以那条约束不再适用 —— 两次写入互不影响，各自的 revision
		 * 各自结算。这也是「一个值、两处 UI」能成立的前提。
		 */
		var TypeModelsController = class {
			/**
			 * @param form - 本插件自己那个宿主命名空间的共享表单。
			 * @param ctx - 客户端上下文，用它的 `remote.session.modelCatalog()` 取模型目录。
			 */
			constructor(form, ctx) {
				this.form = form;
				this.ctx = ctx;
				this.catalogStatus = "idle";
				this.catalogGroups = [];
				this.catalogPartial = false;
				this.catalogGeneration = 0;
				this.saveGeneration = 0;
				this.saving = false;
				this.failed = false;
				this.conflict = false;
				this.disposed = false;
				// 「统一 / 按类型」只是**显示形态**，不是要落盘的草稿：切换不改写任何值，
				// 所以只留在这一个字段里；`undefined` = 由已存映射如实推导。
				this.viewMode = undefined;
				this.store = createStore(this.projection());
				this.unsubscribe = form.subscribe(() => {
					if (this.disposed) return;
					// 本页没有草稿需要保护：外部改动直接反映到界面（每一帧都由表单快照
					// 派生）；写入中被拒的那一次由 `commit()` 结算成 conflict / failed。
					this.publish();
				});
			}
			/** 停止订阅并作废在途的读写结算。 */
			dispose() {
				this.disposed = true;
				this.saveGeneration += 1;
				this.catalogGeneration += 1;
				this.unsubscribe();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			getState() {
				return this.store.getSnapshot();
			}
			/**
			 * 表单快照里的已存储值（只读模型映射 —— 并发上限已不归本类管）。
			 */
			snapshotValue() {
				const snapshot = this.form.getSnapshot();
				const value = snapshot.value;
				return {
					status: snapshot.status,
					writable: snapshot.writable === true,
					revision: snapshot.revision,
					list: value && Array.isArray(value.subagentModels) ? value.subagentModels : [],
				};
			}
			/**
			 * 已存储的「类型 → 路线」映射。
			 *
			 * 只收合法条目（类型在名单内、provider 与 model 都是非空串）：
			 * 手改的 YAML 可能留下半截条目，那种条目在宿主侧会被丢掉，
			 * 面板也不该把它当成一个已生效的选择显示出来。
			 */
			storedMap() {
				const map = new Map();
				for (const entry of this.snapshotValue().list) {
					if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
					const type = entry.subagentType;
					if (typeof type !== "string" || !WORKER_TYPES.includes(type)) continue;
					if (typeof entry.provider !== "string" || entry.provider.trim() === "") continue;
					if (typeof entry.model !== "string" || entry.model.trim() === "") continue;
					const route = { provider: entry.provider, model: entry.model };
					// 手写的 YAML 里可能有强度：读进来，面板才能显示并回写它。
					if (typeof entry.reasoningEffort === "string" && entry.reasoningEffort !== "") {
						route.reasoningEffort = entry.reasoningEffort;
					}
					map.set(type, route);
				}
				return map;
			}
			/**
			 * 四类是否已经指向同一条路线；是则返回那条路线。
			 *
			 * 空映射（四类都继承）**不算**统一：那时没有任何已选的模型，
			 * 统一选择框显示的是占位项而不是一个假装被选中的值。
			 *
			 * 判据读的是**已存**映射 —— 本页没有草稿，改完即写。
			 */
			uniformRoute() {
				const map = this.storedMap();
				if (map.size === 0 || map.size !== WORKER_TYPES.length) return undefined;
				const first = map.values().next().value;
				for (const route of map.values()) {
					if (route.provider !== first.provider || route.model !== first.model) return undefined;
				}
				return first;
			}
			/**
			 * 由**已存值**推导出的形态。
			 *
			 * 四类都指向同一条路线 ⇒ 统一形态；其余一律按类型形态。于是「上次是
			 * 怎么配的」在重新打开设置时自然还原，不需要额外存一个形态字段。
			 */
			storedMode() {
				return this.uniformRoute() === undefined ? "perType" : "uniform";
			}
			/**
			 * 当前显示的形态。
			 *
			 * 没在本页切过就由已存映射如实推导；切过就用本地那个显示形态 ——
			 * 切换本身**不写**任何值（见 `setUniformMode`），所以它不需要落盘。
			 */
			mode() {
				return this.viewMode === undefined ? this.storedMode() : this.viewMode;
			}
			/** 模型目录里的可选路线（保持提供方与模型的原顺序）。 */
			catalogRoutes() {
				const rows = [];
				for (const group of this.catalogGroups) {
					for (const model of group.models || []) {
						rows.push({
							key: routeKey({ provider: group.id, model: model.id }),
							provider: group.id,
							model: model.id,
							label: (group.name || group.id) + " / " + (model.name || model.id),
						});
					}
				}
				return rows;
			}
			/**
			 * 某个模型公布的「思考强度」档位。
			 *
			 * ── 为什么必须取自目录，而不是写死 low/medium/high ──────────────────
			 * effort id 是**适配器自己的**标识（`ReasoningEffortId()` 会校验它），
			 * 不同提供方、不同模型的档位名字与数量都不同：写死一组名字，要么选不到
			 * 模型真有的档，要么提交一个上游不认的值。目录里
			 * `models[].reasoning.efforts[]` 正是为此存在（`dsh-api-remotes` 的
			 * `modelCatalog` 返回结构），`defaultEffort` 则是该模型的默认档。
			 *
			 * 模型没有公布 `reasoning` 时返回空列表 —— 面板据此**不画**强度控件，
			 * 而不是画一个空的下拉框。
			 *
			 * @param route - 该类型已存的路线；`undefined` 表示没选模型。
			 * @returns `{ efforts, defaultEffort }`。
			 */
			effortsFor(route) {
				if (route === undefined) return { efforts: [], defaultEffort: undefined };
				const group = this.catalogGroups.find((candidate) => candidate !== null && candidate.id === route.provider);
				const models = group === undefined || !Array.isArray(group.models) ? [] : group.models;
				const model = models.find((candidate) => candidate !== null && candidate.id === route.model);
				const reasoning = model === undefined || model === null ? undefined : model.reasoning;
				const efforts = reasoning === undefined || !Array.isArray(reasoning.efforts)
					? []
					: reasoning.efforts.filter((effort) => (
						effort !== null
						&& typeof effort === "object"
						&& typeof effort.id === "string"
						&& effort.id !== ""
					));
				return {
					efforts,
					defaultEffort: typeof reasoning?.defaultEffort === "string" ? reasoning.defaultEffort : undefined,
				};
			}
			/**
			 * 为**一条**待选路线造出「选项列表 + 当前值」。
			 *
			 * ⚠️ `<option>` 的 `value` 用**下标**，不用 `routeKey`：routeKey 里有一个
			 * `\u0000` 分隔符，而 NUL 在 HTML 属性值里是解析错误字符。identity 仍然
			 * 由 routeKey 承担（React key 与「是不是同一条路线」的比较都用它），
			 * DOM 层则完全不碰它 —— 于是「当前选中哪个模型」不依赖一个可能在 DOM
			 * 层被改写的字符串。
			 *
			 * ★ 已保存但目录里不再公布的路线**必须**出现在选项列表里：`<select>` 的
			 * `value` 若匹配不到任何选项，浏览器会显示第一项，界面于是撒谎说
			 * 「继承协调者」，而配置里其实还留着旧值。把它补进列表（标 stale），
			 * 用户才能看见它并把它清掉。
			 *
			 * @param route - 当前选中的路线；`undefined` 表示没选。
			 * @returns `{ value, options }`，`value` 为空串即「没选」。
			 */
			optionsFor(route) {
				const base = this.catalogRoutes();
				const known = new Set(base.map((row) => row.key));
				const entries = [];
				if (route !== undefined) {
					const key = routeKey(route);
					if (!known.has(key)) {
						entries.push({
							key,
							provider: route.provider,
							model: route.model,
							label: route.provider + " / " + route.model,
							stale: true,
						});
					}
				}
				for (const row of base) entries.push({ ...row, stale: false });
				// 当前值按**下标**定位：上面保证了「已存的路线一定在 entries 里」，
				// 所以这里必定找得到；即便万一没找到也退回「没选」而不是抛错
				// —— 这里抛错会让整页空白，那比显示一个默认值严重得多。
				const found = route === undefined
					? -1
					: entries.findIndex((entry) => entry.key === routeKey(route));
				return {
					value: found < 0 ? "" : String(found),
					options: entries.map((entry, index) => ({
						value: String(index),
						key: entry.key,
						provider: entry.provider,
						model: entry.model,
						label: entry.label,
						stale: entry.stale,
					})),
				};
			}
			/** 每个类型那一行的当前值与可选路线（当前值来自**已存**映射）。 */
			rows() {
				const desired = this.storedMap();
				return WORKER_TYPES.map((type) => {
					const route = desired.get(type);
					const built = this.optionsFor(route);
					const effort = this.effortsFor(route);
					return {
						type,
						labelKey: TYPE_LABEL_KEYS[type],
						value: built.value,
						options: built.options,
						// 已存的强度（空串 = 用模型默认）与这个模型公布的档位。
						effort: route === undefined || typeof route.reasoningEffort !== "string" ? "" : route.reasoningEffort,
						efforts: effort.efforts,
						defaultEffort: effort.defaultEffort,
					};
				});
			}
			/**
			 * 统一形态那一行：四类共用的那一条路线。
			 *
			 * 四类并不一致时（刚切到统一、或本来就各写各的），取**第一类**
			 * 已存的值作为起点，避免选择框随机挑一条。
			 */
			uniformRow() {
				const route = this.uniformRoute() || this.storedMap().values().next().value;
				const built = this.optionsFor(route);
				const effort = this.effortsFor(route);
				return {
					value: built.value,
					options: built.options,
					effort: this.uniformEffort(),
					efforts: effort.efforts,
					defaultEffort: effort.defaultEffort,
				};
			}
			/**
			 * 统一形态下那一行的思考强度。
			 *
			 * 四类**全都相同**时才显示那一个值；不一致（刚切到统一 / 有的类型没设）
			 * 就显示「模型默认」。这里刻意不学模型下拉「取第一类作为起点」的做法：
			 * 强度是可选字段，显示某一个类型的值会让人以为四类都是它。
			 *
			 * @returns effort id，空串表示没设（模型默认）。
			 */
			uniformEffort() {
				const values = [...this.storedMap().values()].map((route) => (
					typeof route.reasoningEffort === "string" ? route.reasoningEffort : ""
				));
				if (values.length === 0) return "";
				const first = values[0];
				return values.every((value) => value === first) ? first : "";
			}
			/**
			 * 切换「统一 / 按类型」—— **只换显示形态，不写任何值**。
			 *
			 * 切回按类型时原来的四类值还在；切到统一时若四类本就不同，选择框先
			 * 显示第一类的值（见 `uniformRow`），用户真的选了才覆盖 —— 切一下
			 * 不会静默改掉另外三类的配置。因为不改数据，这里没有需要落盘的东西。
			 * @param next - 是否使用统一形态。
			 */
			setUniformMode(next) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				this.viewMode = next ? "uniform" : "perType";
				this.failed = false;
				if (next && this.catalogStatus === "idle") this.loadCatalog();
				this.publish();
			}
			/**
			 * 统一形态下选定一条路线：四类一起写成同一条 —— **改完即写**。
			 *
			 * 这是**一次** `mutate`：整个 `subagentModels` 数组按「四类同一条」序列化
			 * 后写下去，与当初保存按钮提交的是同一份值、同一条路径。
			 */
			setUniform(value) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				const current = this.storedMap();
				const next = new Map(current);
				if (value === "") {
					// 占位项 = 没有统一模型：四类一起回到「继承协调者」。
					for (const type of WORKER_TYPES) next.delete(type);
				} else {
					const option = this.uniformRow().options.find((candidate) => candidate.value === value);
					if (option === undefined) return;
					for (const type of WORKER_TYPES) {
						next.set(type, this.routeFor(current.get(type), option.provider, option.model));
					}
				}
				this.viewMode = "uniform";
				this.failed = false;
				if (this.catalogStatus === "idle") this.loadCatalog();
				this.commit(next);
			}
			/**
			 * 为某一类选择模型；`value` 为空串表示「继承协调者」。
			 *
			 * 改完即写：以**已存**映射为底、只改这一项，然后把整份映射提交一次
			 * （见 `commit`）。
			 * @param type - 类型键。
			 * @param value - `rows()` 给出的选项 value（下标），或空串。
			 */
			setType(type, value) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				if (!WORKER_TYPES.includes(type)) return;
				const current = this.storedMap();
				const next = new Map(current);
				if (value === "") {
					next.delete(type);
				} else {
					const row = this.rows().find((candidate) => candidate.type === type);
					const option = row === undefined ? undefined : row.options.find((candidate) => candidate.value === value);
					if (option === undefined) return;
					next.set(type, this.routeFor(current.get(type), option.provider, option.model));
				}
				this.failed = false;
				if (this.catalogStatus === "idle") this.loadCatalog();
				this.commit(next);
			}
			/**
			 * 造一条新路线，并在「还是同一个模型」时保留原来的思考强度。
			 *
			 * 换模型 ⇒ 丢掉旧的 effort：那个 id 属于旧模型自己的档位表，搬到新模型上
			 * 可能根本不存在（上游 `ReasoningEffortId()` 会拒绝），而且上游本来就规定
			 * 「路由变了且没指定强度 ⇒ 交回模型默认」。重选同一个模型 ⇒ 保留，否则
			 * 用户只是想确认一下当前模型，强度就被悄悄清掉了。
			 *
			 * @param current - 该类型已存的路线。
			 * @param provider - 新 provider。
			 * @param model - 新 model。
			 * @returns 新路线对象。
			 */
			routeFor(current, provider, model) {
				const route = { provider, model };
				if (sameRoute(current, provider, model)
					&& typeof current.reasoningEffort === "string"
					&& current.reasoningEffort !== "") {
					route.reasoningEffort = current.reasoningEffort;
				}
				return route;
			}
			/**
			 * 为某一类设置思考强度；`effortId` 为空串表示「用模型默认」（删掉该字段）。
			 *
			 * 没有已存路线时**什么都不做**：没有模型就没有档位表，写一个强度进去
			 * 只会变成一个上游不认的值（还会让「继承协调者」变成一个半配置的条目）。
			 *
			 * @param type - 类型键。
			 * @param effortId - 目录里该模型公布的 effort id，或空串。
			 */
			setTypeEffort(type, effortId) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				if (!WORKER_TYPES.includes(type)) return;
				const next = new Map(this.storedMap());
				const current = next.get(type);
				if (current === undefined) return;
				const route = { provider: current.provider, model: current.model };
				if (typeof effortId === "string" && effortId !== "") route.reasoningEffort = effortId;
				next.set(type, route);
				this.failed = false;
				this.commit(next);
			}
			/**
			 * 统一形态下设置四类的思考强度 —— 一次 `mutate` 写整份数组。
			 *
			 * 只作用于**已经有路线**的类型：统一形态下它们本来就是同一个模型，
			 * 而「没选的类型」不该因为设了一次强度就凭空出现一条配置。
			 *
			 * @param effortId - effort id，空串表示四类都回到模型默认。
			 */
			setUniformEffort(effortId) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				const next = new Map(this.storedMap());
				if (next.size === 0) return;
				for (const [type, route] of next) {
					const updated = { provider: route.provider, model: route.model };
					if (typeof effortId === "string" && effortId !== "") updated.reasoningEffort = effortId;
					next.set(type, updated);
				}
				this.failed = false;
				this.commit(next);
			}
			/** 设置被外部改动后，把模型目录重新读一遍。 */
			refreshCatalog() {
				if (this.disposed) return;
				this.catalogGeneration += 1;
				this.catalogStatus = "idle";
				this.catalogPartial = false;
				this.loadCatalog();
			}
			async loadCatalog() {
				if (this.disposed || this.catalogStatus === "loading") return;
				const generation = this.catalogGeneration;
				this.catalogStatus = "loading";
				this.catalogPartial = false;
				this.publish();
				try {
					const response = await this.ctx.remote.session.modelCatalog();
					if (generation !== this.catalogGeneration || this.disposed) return;
					if (response && response.ok) {
						this.catalogGroups = response.value.groups || [];
						this.catalogPartial = (response.value.failures || []).length > 0;
						this.catalogStatus = "ready";
					} else {
						this.catalogStatus = "error";
					}
				} catch (error) {
					if (generation !== this.catalogGeneration || this.disposed) return;
					this.catalogStatus = "error";
				}
				this.publish();
			}
			/**
			 * 把想要的那份映射写成**一次** `mutate` —— 改完即写，没有草稿。
			 *
			 * ── 为什么写的是整份数组 ─────────────────────────────────────────────
			 * `subagentModels` 在宿主那边是**一个**字段（一个数组），而
			 * `dsh-settings` 的 `mutate(ns, ops, expectedRevision)` 收的是一个 ops
			 * **数组**（内部 `ops.reduce(...)` 依次施加）。所以「用户改了某一个
			 * `<select>`」落下来就是一次 `mutate` + 一个 `set`：写入的是「以已存
			 * 映射为底、只改这一项」之后的整份映射，与当初保存按钮提交的是同一份
			 * 值、同一条路径：
			 *   [
			 *     { op: "set", path: ["subagentModels"], value: [{ subagentType, provider, model, reasoningEffort? }, …] }
			 *   ]
			 *
			 * ── 期望 revision 从哪来 ─────────────────────────────────────────────
			 * 没有草稿，也就没有「开始编辑时冻结的 revision」：写之前现读
			 * `form.getSnapshot().revision`，与 `LimitsController.commit()` 一致。
			 *
			 * ── 失败 / 冲突之后：界面回到真实值 ──────────────────────────────────
			 * 本类不持有草稿，`projection()` 的每一帧都直接从表单快照派生，所以这里
			 * 不需要「回滚」—— 写入被拒时下一次 `publish()` 显示的就是宿主里真实的
			 * 值，不可能留下一个假的选择。`conflict` 只在「写入被拒 + revision 已经
			 * 往前走了」（别的窗口刚改过同一份设置）时置真，其余失败走 `failed`。
			 *
			 * @param desired - 这次想落盘的整份映射（已含本次改动）。
			 */
			async commit(desired) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				if (sameModelMap(this.storedMap(), desired)) return;
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.conflict = false;
				this.publish();
				const ops = [{ op: "set", path: ["subagentModels"], value: serializeModelMap(desired) }];
				let accepted = false;
				try {
					accepted = await this.form.mutate(ops, stored.revision);
				} catch (error) {
					accepted = false;
				}
				if (generation !== this.saveGeneration || this.disposed) return;
				const after = this.snapshotValue();
				const landed = sameModelMap(this.storedMap(), desired);
				const rejected = accepted !== true || !landed;
				this.saving = false;
				this.conflict = accepted !== true && after.revision !== stored.revision;
				this.failed = rejected && !this.conflict;
				this.publish();
			}
			projection() {
				const stored = this.snapshotValue();
				return {
					status: stored.status,
					writable: stored.writable,
					mode: this.mode(),
					rows: this.rows(),
					uniformRow: this.uniformRow(),
					catalogStatus: this.catalogStatus,
					catalogPartial: this.catalogPartial,
					catalogEmpty: this.catalogStatus === "ready" && this.catalogRoutes().length === 0,
					saving: this.saving,
					failed: this.failed,
					conflict: this.conflict,
				};
			}
			publish() {
				if (this.disposed) return;
				this.store.set(this.projection());
			}
		};
		//#endregion
		//#region 「子代理停滞看门狗」控制器（读写 multitask.watchdog）
		/**
		 * 面板用**秒**、配置里存**毫秒** —— 两个方向各换算**一次**，都在本类里：
		 *   读：`projection()` 里 `Math.round(ms / 1000)`；
		 *   写：`commitSeconds()` 里 `seconds * 1000`。
		 * 类之外的任何地方只见到秒（UI）或毫秒（存储），不出现第三种口径。
		 *
		 * 默认值与宿主 `lib/index.js` 的 `WATCHDOG_DEFAULTS` 一致（300 s / 30 s /
		 * interrupt）。字段缺席或非法时面板照常显示这两个默认值 —— 宿主的
		 * `normalizeWatchdogSettings()` 对同一份输入给出的也是这两个值，所以面板
		 * 显示的就是实际生效值，不是一次猜测。
		 */
		const WATCHDOG_DEFAULTS = Object.freeze({ stallSeconds: 300, tickSeconds: 30, mode: "interrupt" });
		/** 三态：关闭 / 只记录 / 停止并唤醒 —— 与宿主的 `WATCHDOG_MODES` 逐字一致。 */
		const WATCHDOG_MODES = ["off", "log", "interrupt"];
		var WatchdogController = class {
			constructor(form) {
				this.form = form;
				this.saving = false;
				this.failed = false;
				this.conflict = false;
				this.failedField = "";
				this.disposed = false;
				this.saveGeneration = 0;
				this.store = createStore(this.projection());
				this.unsubscribe = form.subscribe(() => {
					if (this.disposed) return;
					this.publish();
				});
			}
			/** 停止订阅并作废在途的写入结算。 */
			dispose() {
				this.disposed = true;
				this.saveGeneration += 1;
				this.unsubscribe();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			getState() {
				return this.store.getSnapshot();
			}
			/**
			 * 表单快照里的 `watchdog` 那一块，收敛成「一定有值」的形状。
			 *
			 * `projectForm()` 即使配置里没有这个字段也会铺上默认值，所以正常情况
			 * 走的就是 `record`；这里仍按同一套默认值兜底，免得半截 YAML 让整张卡
			 * 显示空框。
			 */
			snapshotValue() {
				const snapshot = this.form.getSnapshot();
				const value = snapshot.value || {};
				const raw = value.watchdog;
				const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
				return {
					status: snapshot.status,
					writable: snapshot.writable === true,
					revision: snapshot.revision,
					stallMs: Number.isSafeInteger(record.stallTimeoutMs) && record.stallTimeoutMs > 0
						? record.stallTimeoutMs
						: WATCHDOG_DEFAULTS.stallSeconds * 1000,
					tickMs: Number.isSafeInteger(record.tickMs) && record.tickMs > 0
						? record.tickMs
						: WATCHDOG_DEFAULTS.tickSeconds * 1000,
					mode: WATCHDOG_MODES.includes(record.mode) ? record.mode : WATCHDOG_DEFAULTS.mode,
				};
			}
			/**
			 * 把三项写成**一次** `mutate`：整块 `watchdog` 一个 `set`。
			 *
			 * `watchdog` 在宿主 schema 里是**一个**对象节点（整块 volatile），所以
			 * 改任何一项都提交整个对象 —— 与模型卡「改一项写整份数组」的形状一致。
			 * `expectedRevision` 现读，不做草稿期冻结（本页没有草稿）。
			 * @param patch - `{ stallTimeoutMs?, tickMs?, mode? }`，毫秒。
			 */
			async commit(patch) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				const next = {
					stallTimeoutMs: patch.stallTimeoutMs === undefined ? stored.stallMs : patch.stallTimeoutMs,
					tickMs: patch.tickMs === undefined ? stored.tickMs : patch.tickMs,
					mode: patch.mode === undefined ? stored.mode : patch.mode,
				};
				if (next.stallTimeoutMs === stored.stallMs && next.tickMs === stored.tickMs && next.mode === stored.mode) return;
				const field = patch.tickMs !== undefined ? "tick" : patch.mode !== undefined ? "mode" : "stall";
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.conflict = false;
				this.failedField = "";
				this.publish();
				let accepted = false;
				try {
					accepted = await this.form.mutate([{ op: "set", path: ["watchdog"], value: next }], stored.revision);
				} catch (error) {
					accepted = false;
				}
				if (generation !== this.saveGeneration || this.disposed) return;
				const after = this.snapshotValue();
				const landed = after.stallMs === next.stallTimeoutMs && after.tickMs === next.tickMs && after.mode === next.mode;
				this.saving = false;
				this.conflict = accepted !== true && after.revision !== stored.revision;
				this.failed = (accepted !== true || !landed) && !this.conflict;
				this.failedField = this.failed ? field : "";
				this.publish();
			}
			/** 面板控件交来的是**秒**；这里换算成毫秒后交给 `commit()`。 */
			commitSeconds(patch) {
				const converted = {};
				if (patch.stallSeconds !== undefined) converted.stallTimeoutMs = patch.stallSeconds * 1000;
				if (patch.tickSeconds !== undefined) converted.tickMs = patch.tickSeconds * 1000;
				if (patch.mode !== undefined) converted.mode = patch.mode;
				return this.commit(converted);
			}
			projection() {
				const stored = this.snapshotValue();
				const stallSeconds = Math.round(stored.stallMs / 1000);
				const tickSeconds = Math.round(stored.tickMs / 1000);
				return {
					status: stored.status,
					writable: stored.writable,
					stallSeconds,
					stallText: String(stallSeconds),
					tickSeconds,
					tickText: String(tickSeconds),
					mode: stored.mode,
					saving: this.saving,
					conflict: this.conflict,
					failed: this.failed,
					stallFailed: this.failed === true && this.failedField === "stall",
					tickFailed: this.failed === true && this.failedField === "tick",
				};
			}
			publish() {
				if (this.disposed) return;
				this.store.set(this.projection());
			}
		};
		//#endregion
		//#region 「子代理 realm 的压缩预算」控制器（读写 multitask.compaction）
		/**
		 * 面板只编辑两项（`headroomTokens` / `maxTokens`），其余三项
		 * （`retainTokens` / `thresholdRatio` / `retainRatio`）**原样保留**。
		 *
		 * ── 这张卡在整条链路里的位置（issue #5）───────────────────────────────
		 * 本 preset 的压缩在 `isolate: { compaction: true }` 的组内，宿主
		 * `cordis.patch.yml` 那里的修正进不到组里。上游缺省 `headroomTokens: 65536`
		 * 会让压力预算（`contextWindow − 请求输出预留 − headroomTokens`）在 ≤128k
		 * 窗口的模型上变成零以下，直接抛 `TargetPressureConfigError`。
		 *
		 * **缺省预算已经由组装层给出**（`composition.mjs` 的 `COMPACTION_DEFAULTS`：
		 * 8192 / 65536，推导与「为什么对大窗口无影响」见那边 `normalizeCompaction()`
		 * 的注释）。所以这张卡**不是**修复本身，只是想手动覆盖时的入口 ——
		 * 平时用户不需要打开它，更不需要看懂它。
		 *
		 * ── 为什么写的是整块对象 ─────────────────────────────────────────────
		 * `compaction` 在宿主 schema 里是**一个**对象节点（整块 volatile），与 `watchdog`
		 * 同形：改一项就提交整个对象，`expectedRevision` 现读（本页没有草稿）。
		 *
		 * ── 留空 = 用缺省预算 ────────────────────────────────────────────────
		 * 字段缺席意味着「回到本包的缺省预算」（不是上游那组会出错的 65536）。
		 * 清空输入框提交的是**删掉这个键**，而不是写一个 0。
		 */
		var CompactionController = class {
			constructor(form) {
				this.form = form;
				this.saving = false;
				this.failed = false;
				this.conflict = false;
				this.failedField = "";
				this.disposed = false;
				this.saveGeneration = 0;
				this.store = createStore(this.projection());
				this.unsubscribe = form.subscribe(() => {
					if (this.disposed) return;
					this.publish();
				});
			}
			/** 停止订阅并作废在途的写入结算。 */
			dispose() {
				this.disposed = true;
				this.saveGeneration += 1;
				this.unsubscribe();
			}
			subscribe(listener) {
				return this.store.subscribe(listener);
			}
			getState() {
				return this.store.getSnapshot();
			}
			/**
			 * 表单快照里的 `compaction` 那一块。
			 *
			 * `rest` 是**原样回写**用的底稿：面板不认识的三项（以及将来上游新增的项）
			 * 必须跟着写回去，否则用户手写在 profile 里的 `thresholdRatio` 会在
			 * 「改一次预留」时被整块覆盖掉。
			 */
			snapshotValue() {
				const snapshot = this.form.getSnapshot();
				const value = snapshot.value || {};
				const raw = value.compaction;
				const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
				const readTokens = (candidate) => (
					Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined
				);
				return {
					status: snapshot.status,
					writable: snapshot.writable === true,
					revision: snapshot.revision,
					rest: record,
					headroomTokens: readTokens(record.headroomTokens),
					maxTokens: readTokens(record.maxTokens),
				};
			}
			/**
			 * 写一项压缩预算（token）。
			 *
			 * @param patch - `{ headroomTokens? , maxTokens? }`；未出现的项沿用已存值。
			 */
			async commit(patch) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				const headroom = patch.headroomTokens === undefined ? stored.headroomTokens : patch.headroomTokens;
				const summary = patch.maxTokens === undefined ? stored.maxTokens : patch.maxTokens;
				if (headroom === stored.headroomTokens && summary === stored.maxTokens) return;
				const next = { ...stored.rest };
				if (headroom === undefined) delete next.headroomTokens;
				else next.headroomTokens = headroom;
				if (summary === undefined) delete next.maxTokens;
				else next.maxTokens = summary;
				const field = patch.maxTokens === undefined ? "headroom" : "max";
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.conflict = false;
				this.failedField = "";
				this.publish();
				let accepted = false;
				try {
					accepted = await this.form.mutate([{ op: "set", path: ["compaction"], value: next }], stored.revision);
				} catch (error) {
					accepted = false;
				}
				if (generation !== this.saveGeneration || this.disposed) return;
				const after = this.snapshotValue();
				const landed = after.headroomTokens === headroom && after.maxTokens === summary;
				this.saving = false;
				this.conflict = accepted !== true && after.revision !== stored.revision;
				this.failed = (accepted !== true || !landed) && !this.conflict;
				this.failedField = this.failed ? field : "";
				this.publish();
			}
			projection() {
				const stored = this.snapshotValue();
				return {
					status: stored.status,
					writable: stored.writable,
					headroomText: stored.headroomTokens === undefined ? "" : String(stored.headroomTokens),
					maxTokensText: stored.maxTokens === undefined ? "" : String(stored.maxTokens),
					saving: this.saving,
					conflict: this.conflict,
					failed: this.failed,
					headroomFailed: this.failed === true && this.failedField === "headroom",
					maxTokensFailed: this.failed === true && this.failedField === "max",
				};
			}
			publish() {
				if (this.disposed) return;
				this.store.set(this.projection());
			}
		};
		/** 压缩预算的最小合法值（token）：0 与负数在 `compaction-basic` 里都是非法配置。 */
		const COMPACTION_FLOOR = 1;
		//#endregion
		//#region 样式表
		/**
		 * 一次性注入的样式表。
		 *
		 * ── 为什么不再用内联 style 对象（本页原先的写法）──────────────────────
		 * 内联对象表达不了 `:hover` / `:active` / `:focus-visible` / `@media`，
		 * 于是旧版既没有悬停与按下反馈，也没有「减少动态效果」这条无障碍分支，
		 * 视觉上只能靠堆边框与字号硬撑，才显得单调。改为一张真实样式表之后，
		 * 状态、焦点环、窄屏折行、减动效全部可用。
		 *
		 * ── 颜色一律走部署自己的 `--dsw-*` 令牌 ──────────────────────────────
		 * 浅色 / 深色 / 皮肤中心换肤都由令牌自动跟随，本页不需要任何主题分支；
		 * 每个 var() 都带一个回退值，令牌缺席时仍可读。写法与官方客户端模块一致：
		 * `<style data-plugin-css=...>` + 存在性守卫，重复挂载不会插第二份。
		 */
		const CSS = [
			"/* dsh-multitask 设置页 */",
			".mt-root{display:flex;flex-direction:column;gap:24px;max-width:720px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif);font-size:14px;line-height:22px}",
			".mt-head{display:flex;flex-direction:column;gap:6px}",
			".mt-title{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:-.01em}",
			".mt-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",

			".mt-card{background:var(--dsw-alias-bg-layer-1,#f6f7f9);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,16px);overflow:hidden}",
			".mt-cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 16px 0}",
			".mt-cardTitle{font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}",
			".mt-cardNote{margin:0;padding:6px 16px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".mt-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm,8px);padding:1px 6px;white-space:nowrap}",

			".mt-rows{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}",
			// ⚠️ 这一行的**换行与保底宽度**是修过 bug 的，别退回去（模型卡加上思考
			// 强度下拉之后暴露的排版问题）：
			//   · `.mt-rowControl` 曾经是 `flex:none`，两个 `min-width:208px` 的下拉
			//     硬占 424px 且绝不收缩；
			//   · `.mt-rowText` 曾经是 `flex:1;min-width:0`，可以被压到 0 宽；
			//   两者相加 = 面板 560~720px 时左侧说明文字被压成一字一行（截图确认过：
			//   subagent / subagent_ptc / subagent_minimal 三行竖排）。
			// 现在：整行允许换行、文字有 180px 保底、控件可换行并右对齐。空间不够时
			// 宁可让第二个下拉掉到下一行，也不许再压文字。
			".mt-row{display:flex;align-items:center;gap:16px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
			".mt-row:last-child{border-bottom:none}",
			".mt-rowText{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:180px}",
			".mt-rowLabel{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}",
			".mt-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".mt-rowDescBad{color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".mt-rowControl{flex:0 1 auto;display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-left:auto;max-width:100%}",
			".mt-steps{display:flex;align-items:center;gap:6px}",
			".mt-rowNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l2)}",

			".mt-banner{margin:0;padding:10px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-top:.5px solid var(--dsw-alias-border-l2)}",
			".mt-banner[data-tone=warn]{color:var(--dsw-alias-state-warning-primary,#9a6700)}",
			".mt-banner[data-tone=error]{color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".mt-banner[data-tone=info]{color:var(--dsw-alias-label-tertiary)}",

			".mt-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
			".mt-segBtn{appearance:none;border:0;background:transparent;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:5px 18px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;transition:background .15s ease,color .15s ease,box-shadow .15s ease}",
			".mt-segBtn:hover:not(:disabled):not([data-on=true]){background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.09));color:var(--dsw-alias-label-primary)}",
			".mt-segBtn:active:not(:disabled){transform:scale(.97)}",
			".mt-segBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			// 选中项必须是**实心**的：只靠白底 + 淡阴影在读屏与低对比屏上几乎看不出来，
			// 用户会分不清当前是哪一项。这里用业务主色填充 + 反白字，
			// 浅色 / 深色 / 皮肤下都自动成立。
			".mt-segBtn[data-on=true]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.18)}",
			".mt-segBtn:disabled{opacity:.5;cursor:default}",
			".mt-segBtn[data-on=true]:disabled{opacity:.6}",

			// `.mt-selectWrap` 必须允许在控件区里**被动换行**（不许按内容继续撑宽），
			// 否则两个下拉会把整行顶穿；`max-width:100%` 保证窄面板下不溢出卡片。
			".mt-selectWrap{position:relative;display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:100%}",
			".mt-selectWrap::after{content:'';position:absolute;right:13px;width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:translateY(-2px) rotate(45deg);pointer-events:none}",
			// `min-width` 从 208px 降到 150px：一行放两个下拉时（模型 + 思考强度）
			// 208 让它们共占 424px，628px 的面板只剩 150px 给说明文字；150 时共占
			// 308px，左侧约 272px，足够横向排两行。`max-width` 不变，宽面板照旧显示全名。
			".mt-select{appearance:none;font:inherit;font-size:13px;line-height:20px;height:34px;min-width:150px;max-width:280px;padding:0 32px 0 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);cursor:pointer;text-overflow:ellipsis;transition:border-color .15s ease}",
			".mt-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l4)}",
			".mt-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".mt-select:disabled{opacity:.5;cursor:default}",
			// 展开的 <option> 弹出层由浏览器原生绘制，**不继承** .mt-select 的 background
			// —— 它按 UA 默认画成白底，而选项文字却继承了深色主题的近白 label-primary，
			// 于是糊成一片。显式给 option 设色即可：这两个令牌本身已随主题翻转
			// （浅色 bg-base=#fff / label-primary 近黑；深色 bg-base=#151517 /
			// label-primary 近白），所以深浅两态同时正确，且不依赖任何主题标记或操作系统设置。
			".mt-select option{background-color:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary)}",
			// 再让弹出层自身的原生装饰（边框、滚动条）也跟上深色。用 DSH 自己的深色标记
			// 收窄作用域，浅色模式完全不受影响；即便将来标记改名，这条只是静默失效，
			// 上面那条仍然保证文字可读。
			"body[data-ds-dark-theme] .mt-select{color-scheme:dark}",

			".mt-num{font:inherit;font-size:13px;line-height:20px;height:34px;width:84px;padding:0 10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);transition:border-color .15s ease}",
			".mt-num:hover:not(:disabled){border-color:var(--dsw-alias-border-l4)}",
			".mt-num:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".mt-num[data-bad=true]{border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".mt-num:disabled{opacity:.5}",
			".mt-step{appearance:none;width:30px;height:34px;font:inherit;font-size:16px;line-height:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.05));border:0;border-radius:var(--dsw-radius-md,12px);cursor:pointer;transition:background .15s ease,color .15s ease}",
			".mt-step:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".mt-step:active:not(:disabled){transform:scale(.94)}",
			".mt-step:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".mt-step:disabled{opacity:.4;cursor:default}",

			// ── 通用设置里的两行 ──
			// 这两行住进官方「通用设置」那一段，必须**看起来就是那一段的行**：官方
			// 行（语言 / 外观 / 开发者工具）是「标题+说明在左、控件在右、底部 0.5px
			// 分隔线、上下 16px」的扁平行，外面**没有卡片**。这里的取值与官方
			// `DeveloperToolsRow.module.css` 逐项对齐（分隔线用 border-l2、标题
			// 14/20、说明 12/18 且用 label-secondary），所以并排时看不出接缝。
			".mt-grow{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			// ★ 同一个 `LimitRow` 组件在**卡片里**的变体。
			//
			// 它必须与「通用设置」那两行**长得不一样**，这不是审美问题：
			// `.mt-grow` 是照着官方通用设置那一段画的扁平行（左右**没有**内边距、
			// 靠上下 16px 与底部分隔线撑开），因为那一段本身就没有卡片外框。
			// 一旦把它直接塞进 `.mt-card`，行文字会贴到卡片左边框上，与卡片自己的
			// 标题 / 说明（都有 16px 内边距）**对不齐** —— 实测截图里肉眼可见。
			//
			// 所以卡片语境下换成与 `.mt-row` 同一套度量（左右 16px、上下 14px），
			// 并去掉底部那条线：它是 `.mt-rows` 里的**最后一行**，上面已经有
			// `.mt-rows` 的 `border-top` 作分隔，再画一条会让卡片底部出现双线。
			".mt-growCard{padding:14px 16px;border-bottom:none}",
			".mt-growText{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".mt-growTitle{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".mt-growDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".mt-growDescBad{color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".mt-growControl{flex:none;display:flex;align-items:center;gap:6px}",
			".mt-btn{appearance:none;font:inherit;font-size:13px;line-height:20px;padding:6px 14px;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .15s ease,filter .15s ease}",
			".mt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".mt-btn:active:not(:disabled){transform:scale(.97)}",
			".mt-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".mt-btn:disabled{opacity:.45;cursor:default}",

			"@media (max-width:560px){.mt-row{flex-wrap:wrap;gap:10px}.mt-rowControl{width:100%}.mt-select{min-width:0;width:100%;max-width:none}.mt-selectWrap{width:100%}}",
			"@media (prefers-reduced-motion:reduce){.mt-btn,.mt-step,.mt-segBtn,.mt-select,.mt-num{transition:none}.mt-btn:active:not(:disabled),.mt-step:active:not(:disabled),.mt-segBtn:active:not(:disabled){transform:none}}"
		].join("");
		const CSS_TAG = "dsh-multitask/settings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-multitask";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region 小组件
		/** 仍被会话头部那一格沿用的三个字色。 */
		const palette = {
			labelTertiary: "var(--dsw-alias-label-tertiary, #6e7781)",
			business: "var(--dsw-alias-state-business-primary, #0969da)",
			danger: "var(--dsw-alias-state-error-primary, #cf222e)",
		};
		/** 一行提示；`tone` 决定它是普通说明、警告还是错误。 */
		function banner(text, key, tone) {
			return react.createElement("p", { key, className: "mt-banner", "data-tone": tone === undefined ? "info" : tone }, text);
		}
		/** 卡片外壳：标题、可选源码字段、说明、若干行、可选尾部提示。 */
		function card(props) {
			const head = [react.createElement("span", { key: "t", className: "mt-cardTitle" }, props.title)];
			if (props.ref !== undefined) head.push(react.createElement("code", { key: "r", className: "mt-code" }, props.ref));
			const children = [react.createElement("div", { key: "head", className: "mt-cardHead" }, ...head)];
			if (props.note !== undefined) children.push(react.createElement("p", { key: "note", className: "mt-cardNote" }, props.note));
			children.push(...(props.middle || []));
			if (props.rows !== undefined && props.rows.length > 0) {
				children.push(react.createElement("div", { key: "rows", className: "mt-rows" }, ...props.rows));
			}
			children.push(...(props.tail || []));
			return react.createElement("section", { key: props.sectionKey, className: "mt-card" }, ...children);
		}
		/**
		 * 一行设置：左侧标题与说明，右侧控件。
		 * @param label - 行的主文案。
		 * @param desc - 可选的一行说明，用最淡的字色。
		 * @param control - 右侧控件节点。
		 * @param key - React key。
		 * @param descBad - 说明此刻是**纠错**而非提示，改用错误字色。
		 */
		function row(label, desc, control, key, descBad) {
			const text = [react.createElement("div", { key: "l", className: "mt-rowLabel" }, label)];
			if (desc !== undefined) {
				text.push(react.createElement("div", {
					key: "d",
					className: descBad === true ? "mt-rowDesc mt-rowDescBad" : "mt-rowDesc",
				}, desc));
			}
			return react.createElement(
				"div",
				{ key, className: "mt-row" },
				react.createElement("div", { className: "mt-rowText" }, ...text),
				react.createElement("div", { className: "mt-rowControl" }, control),
			);
		}
		/** 二选一的分段控件；`value` 命中哪一项，哪一项就是实心的。 */
		function segmented(value, options, onChange, key, disabled) {
			return react.createElement(
				"div",
				{ key, className: "mt-seg", role: "radiogroup" },
				...options.map((option) =>
					react.createElement(
						"button",
						{
							key: option.value,
							type: "button",
							role: "radio",
							"aria-checked": value === option.value,
							"data-on": value === option.value ? "true" : "false",
							disabled: disabled === true,
							className: "mt-segBtn",
							onClick: () => onChange(option.value),
						},
						option.label,
					),
				),
			);
		}
		/**
		 * 下拉选择框。
		 *
		 * `options` 的每一项是 `{ value, key, label }`：`value` 进 DOM（必须是
		 * 安全的短字符串），`key` 只作 React 的 key（可以是带 `\u0000` 的身份串）。
		 *
		 * `ariaLabel` 只用于同一行里有**两个**下拉时区分它们（模型 + 思考强度）：
		 * 可见的文字标题已经在左侧，读屏用户否则只听到「下拉框」。传 `undefined`
		 * 时 React 不会渲染该属性，单下拉的行因此与加入本参数之前完全一致。
		 *
		 * `title` 是**视觉上的**同一件事：强度下拉里只写着「模型默认」，不悬停根本
		 * 看不出这一栏是思考强度。只有强度下拉传它，模型下拉不受影响。
		 */
		function selectField(value, options, onChange, key, disabled, ariaLabel, title) {
			return react.createElement(
				"div",
				{ key, className: "mt-selectWrap" },
				react.createElement(
					"select",
					{
						className: "mt-select",
						value,
						disabled: disabled === true,
						"aria-label": ariaLabel,
						title,
						onChange: (event) => onChange(event.target.value),
					},
					...options.map((option) => react.createElement("option", { key: option.key, value: option.value }, option.label)),
				),
			);
		}
		/** 表单顶部的状态横幅（读取中 / 不可配置 / 只读），以及底部的两条失败提示。 */
		function statusParts(t, state) {
			const middle = [];
			if (state.status === "loading") middle.push(banner(t("loading"), "loading", "info"));
			else if (state.status === "unavailable") middle.push(banner(t("unavailable"), "unavailable", "warn"));
			else if (state.status === "ready" && !state.writable) middle.push(banner(t("readOnly"), "readonly", "warn"));
			const tail = [];
			if (state.conflict === true) tail.push(banner(t("modelsConflict"), "conflict", "warn"));
			if (state.failed === true) tail.push(banner(t("saveFailed"), "failed", "error"));
			return { middle, tail };
		}
		//#endregion
		//#region 页面组件
		/**
		 * 思考强度下拉 —— **只在这个模型公布档位时**才存在。
		 *
		 * ── 为什么不能写死 low / medium / high ──────────────────────────────────
		 * effort id 属于**适配器**（上游 `ReasoningEffortId()` 会拒绝不认识的 id），
		 * 不同提供方、不同模型的档位名字与数量都不同。所以选项一律来自目录的
		 * `models[].reasoning.efforts[]`（见 `TypeModelsController.effortsFor`）。
		 * 模型没公布 = 不画控件，而不是画一个只有「模型默认」一项的空下拉。
		 *
		 * ── 为什么要把「已存但已不在目录里」的档位补进选项 ──────────────────────
		 * 与模型下拉同一条理由（见 `optionsFor`）：`<select>` 的 `value` 匹配不到任何
		 * 选项时，浏览器会显示第一项 —— 界面于是撒谎说「模型默认」，而配置里其实
		 * 还留着那个旧 id。补一项标 stale，用户才看得见它、并把它清掉。
		 *
		 * @param meta - `{ effort, efforts }`（来自 `rows()` / `uniformRow()`）。
		 * @param onChange - 交回 effort id（空串 = 模型默认）。
		 * @param key - React key。
		 * @param locked - 控件是否禁用。
		 * @param t - 文案函数。
		 * @returns 下拉节点；该模型没有公布任何档位时 `undefined`。
		 */
		function effortField(meta, onChange, key, locked, t) {
			if (!Array.isArray(meta.efforts) || meta.efforts.length === 0) return undefined;
			const current = typeof meta.effort === "string" ? meta.effort : "";
			const options = [{ value: "", key: "__default__", label: t("effortDefault") }];
			for (const effort of meta.efforts) {
				options.push({
					value: effort.id,
					key: effort.id,
					label: typeof effort.name === "string" && effort.name !== "" ? effort.name : effort.id,
				});
			}
			if (current !== "" && !options.some((option) => option.value === current)) {
				options.push({
					value: current,
					key: "__stale__",
					label: current + t("typeModelsUnavailable"),
				});
			}
			// aria-label 与 title 用同一句文案：前者给读屏，后者给鼠标悬停 ——
			// 光看「模型默认」四个字，没人知道这一栏是思考强度。
			const effortLabel = t("effortLabel");
			return selectField(current, options, onChange, key, locked, effortLabel, effortLabel);
		}
		/**
		 * 「子代理使用的模型」一节 —— **改完即写**。
		 *
		 * 只有两种显示形态，由上面的分段控件切换：
		 *   · 是 —— 四类子代理共用同一条路线（一行下拉）；
		 *   · 否 —— 每类各自指定（四行下拉，「继承协调者」即该类型不写进配置）。
		 * 两种形态落到 `subagentModels[]` 上是同一份数据，切换形态不改写任何值，
		 * 因此这里没有「统一模式」这类额外的存储字段。任何一个下拉框被改动，
		 * 都会立刻走 `TypeModelsController.commit()` 写一次（本页没有保存按钮）。
		 */
		function ModelsSection(props) {
			const t = props.t;
			const state = useStore(props.typeModelsStore);
			const parts = statusParts(t, state);
			const rows = [];
			const middle = [...parts.middle];
			if (state.status === "ready") {
				const locked = !state.writable || state.saving;
				// 写入期间控件一律禁用；同时给一条「保存中…」，否则用户只看到控件
				// 突然变灰，分不清是在写还是坏了。
				if (state.saving) middle.push(banner(t("saving"), "saving", "info"));
				// 目录状态：说清「现在能不能选」，而不是给一个空列表让人猜。
				// 失败时不额外加横幅 —— 失败文案就是那一行的标题，右侧就是重试按钮，
				// 否则同一句话会出现两遍。
				if (state.catalogStatus === "loading") middle.push(banner(t("modelsCatalogLoading"), "cat-loading", "info"));
				else if (state.catalogStatus === "error") {
					rows.push(row(
						t("modelsCatalogFailed"),
						undefined,
						react.createElement("button", { type: "button", className: "mt-btn", onClick: props.retryCatalog }, t("modelsCatalogRetry")),
						"retry",
					));
				} else if (state.catalogStatus === "ready") {
					if (state.catalogPartial) middle.push(banner(t("modelsCatalogPartial"), "cat-partial", "warn"));
					if (state.catalogEmpty) middle.push(banner(t("modelsCatalogEmpty"), "cat-empty", "warn"));
				}
				rows.push(row(
					t("uniformLabel"),
					t("uniformDesc"),
					segmented(
						state.mode === "uniform" ? "same" : "perType",
						[{ value: "same", label: t("optSame") }, { value: "perType", label: t("optPerType") }],
						(value) => props.setUniformMode(value === "same"),
						"mode",
						locked,
					),
					"mode",
				));
				if (state.mode === "uniform") {
					// 统一模式：一行下拉。占位项就是「还没选」，与「继承协调者」同形（空串）。
					const options = [{ value: "", key: "__unset__", label: t("uniformUnset") }];
					for (const option of state.uniformRow.options) {
						options.push({
							value: option.value,
							key: option.key,
							label: option.stale ? option.label + t("typeModelsUnavailable") : option.label,
						});
					}
					const control = [selectField(state.uniformRow.value, options, (value) => props.setUniform(value), "uniform-select", locked, t("uniformSelectLabel"))];
					const effort = effortField(state.uniformRow, (value) => props.setUniformEffort(value), "uniform-effort", locked, t);
					if (effort !== undefined) control.push(effort);
					rows.push(row(
						t("uniformSelectLabel"),
						t("uniformSelectDesc"),
						react.createElement(react.Fragment, null, ...control),
						"uniform-select",
					));
				} else {
					for (const item of state.rows) {
						// 「继承协调者」永远是第一项：它是默认值，也是清掉一条已存选择的方式。
						const options = [{ value: "", key: "__inherit__", label: t("typeModelsInherit") }];
						for (const option of item.options) {
							options.push({
								value: option.value,
								key: option.key,
								label: option.stale ? option.label + t("typeModelsUnavailable") : option.label,
							});
						}
						const control = [selectField(item.value, options, (value) => props.setType(item.type, value), "type-select-" + item.type, locked, t(item.labelKey))];
						// 强度控件只在这个模型**自己公布了档位**时出现；「继承协调者」
						// 时 `item.efforts` 为空 ⇒ 不会画一个空下拉。
						const effort = effortField(item, (value) => props.setTypeEffort(item.type, value), "type-effort-" + item.type, locked, t);
						if (effort !== undefined) control.push(effort);
						rows.push(row(
							t(item.labelKey),
							t(item.labelKey + "Hint"),
							react.createElement(react.Fragment, null, ...control),
							item.type,
						));
					}
				}
			}
			return card({
				sectionKey: "models",
				title: t("modelsTitle"),
				ref: t("modelsRef"),
				note: t("modelsScopeNote"),
				middle,
				rows,
				tail: parts.tail,
			});
		}
		/**
		 * 「子代理并行数量上限」一节 —— ⚠️ **它编辑的是宿主那一个值**。
		 *
		 * 这一节与「设置 → 通用设置」里那一行**是同一个字段**
		 * （宿主 `subagent.maxActiveSubagents`），共用一个 `LimitsController`：
		 * 两处读的是同一份表单快照、写的是同一个 path，所以改一处另一处立刻跟着变 ——
		 * 不需要任何同步代码，「一个值、两处 UI」自动成立。
		 *
		 * 它因此**复用 `LimitRow`**，而不是自己再画一套数字框：控件、提交时机、
		 * 纠错文案、加减按钮的下限全都在那一处定义，两处 UI 不可能漂移。
		 *
		 * ── 与上面模型卡的区别只在**字段归谁管** ────────────────────────────────
		 * 两张卡现在都是**改完即写**：这张写宿主的 `subagent` 命名空间（走
		 * `LimitsController`），模型卡写本插件的 `multitask` 命名空间（走
		 * `TypeModelsController.commit()`）。两个字段住在不同命名空间、各有自己的
		 * revision，所以两次写入互不影响 —— 这也是「一个值、两处 UI」能成立的前提。
		 *
		 * ── 为什么「不限制」那一档没有了 ────────────────────────────────────────
		 * 早先这里有「限制 / 不限制」分段控件，因为当时那个字段是**本插件自己的**、
		 * 可以为「缺席」。现在这个值就是宿主的 `maxActiveSubagents`，而宿主那一行
		 * 自己就带一个默认值（8）——「不限制」在这个字段上**无法表达**，硬留着只会
		 * 让用户以为自己取消了上限、而实际仍被宿主的数字卡住（那正是这次改动的起因）。
		 * 所以只留一个数字：**写的是多少，上限就是多少。**
		 */
		function ConcurrencySection(props) {
			const t = props.t;
			const state = useStore(props.limitsStore);
			// 未就绪时只画标题（不画控件）：`LimitRow` 自己会把 `locked` 传下去，
			// 但一个读不出值的空框比没有框更让人困惑，所以这里整行不渲染。
			//
			// ⚠️ `label` 复用宿主那一行的键（`maxActive`），不另立一份文案 ——
			// 两处编辑的本来就是同一个字段，标题逐字一致才说得通。而 `inCard: true`
			// 让 `LimitRow` 换用卡片内的行距、并**省掉视觉上的标题**（卡片标题已经
			// 就是这个名字，再画一遍会让同一句话在一屏里重复）。
			// `label` 仍然传下去：它同时是输入框的 `aria-label`，读屏用户照旧听得到。
			const rows = state.status === "ready"
				? [react.createElement(LimitRow, {
					key: "cap-row",
					t,
					limitsStore: props.limitsStore,
					field: "maxActive",
					label: t("maxActive"),
					desc: t("maxActiveHint"),
					invalid: "invalidActive",
					floor: CONCURRENCY_FLOOR,
					inCard: true,
					commit: (field, value) => props.commitLimit(field, value),
				})]
				: [];
			return card({
				sectionKey: "concurrency",
				title: t("concurrencyTitle"),
				ref: t("concurrencyRef"),
				note: t("concurrencyScopeNote"),
				rows,
			});
		}
		/**
		 * 一行运行限制：标题与说明在左，数字输入与加减按钮在右。
		 *
		 * ⚠️ 这一个组件服务**两处** UI：「设置 → 通用设置」里的两行，以及
		 * 「设置 → Multitask」那张并行数量卡。后者之所以复用它而不是自己画一套，
		 * 是因为两处编辑的**本来就是同一个字段** —— 共用控件就不可能漂移。
		 *
		 * ── 但它必须能表达两种**排版**语境（否则会重复又错位）──────────────────
		 *
		 *   1. **无卡片列表**（通用设置那一段）：`.`mt-grow` 的扁平行，左右没有内边距，
		 *      靠上下 16px 与底部分隔线撑开 —— 因为那一段本身没有卡片外框。
		 *   2. **卡片里**（Multitask 那张卡）：换上 `.mt-growCard`（左右 16px，与卡片
		 *      标题 / 说明对齐），并且**不再重复渲染标题** —— 卡片标题已经就是这一行的
		 *      名字，再画一遍会让同一句话在一屏里出现三次（实测截图确认过）。
		 *      这种情况下 `label` 仍然传下去，只用于 `aria-label`：视觉上省掉，
		 *      读屏用户仍然听得到，标题层级不靠视觉重复来撑。
		 *
		 * @param props.label - 行的主文案（在卡片里只作为无障碍标签）。
		 * @param props.desc - 可选的一行说明，用最淡的字色。
		 * @param props.inCard - 渲染在卡片里（换行距 + 不重复标题）。
		 *
		 * ── 为什么文本只存在组件本地 ────────────────────────────────────────────
		 * 这些行都是**即时生效**的，所以提交时机是失焦 / 回车，而不是每个按键
		 * —— 每敲一个数字就写一次配置，既吵又会在中途写下非法值。输入中的文本因此
		 * 留在组件本地（`draft`），显示值则是「正在编辑就用草稿，否则用已存值」。
		 *
		 * 提交后立刻把显示值交回 store：写成功就是新值，写失败就是旧值 + 行内报错。
		 * 非法值（解析不出来，或低于 `floor`）**同样不提交** —— 纠错提示在输入过程中
		 * 就出现了，失焦时草稿一并丢弃、显示值交回已存值。这样控件永远不会停留在一个
		 * 「配置里其实没有」的数字上。
		 */
		function LimitRow(props) {
			const t = props.t;
			const state = useStore(props.limitsStore);
			// 字段名 → 显示文本 / 失败标记：默认走「通用设置」那两行的命名，
			// 看门狗那两行用 `textKey` / `failedKey` 指定自己的键（同一个控件、不同的 store）。
			const stored = props.textKey === undefined
				? (props.field === "maxDepth" ? state.depthText : state.activeText)
				: state[props.textKey];
			const fieldFailed = props.failedKey === undefined
				? (props.field === "maxDepth" ? state.depthFailed === true : state.activeFailed === true)
				: state[props.failedKey] === true;
			const [draft, setDraft] = react.useState(null);
			const locked = state.status !== "ready" || !state.writable || state.saving;
			// 派生态：store 已经跟上（或这一行刚写失败）时，交回 store 的值。
			if (draft !== null && (draft === stored || fieldFailed)) setDraft(null);
			const shown = draft === null ? stored : draft;
			const parsed = parseWhole(shown, props.floor);
			// 只对「用户刚敲进去的东西」报错：字段本来就缺席时的空框是**未设置**，不是填错。
			const invalid = draft !== null && shown.trim() !== "" && parsed === undefined;
			const step = (delta) => {
				const base = parsed === undefined ? props.floor : parsed;
				props.commit(props.field, Math.max(props.floor, base + delta));
			};
			const commitDraft = () => {
				if (parsed !== undefined) props.commit(props.field, parsed);
				setDraft(null);
			};
			const desc = invalid ? t(props.invalid) : fieldFailed ? t("saveFailed") : props.desc;
			// 卡片里不重复标题（见上方注释）；标题缺席时说明就是左侧唯一文本。
			const leftText = [];
			if (props.inCard !== true) leftText.push(react.createElement("div", { key: "l", className: "mt-growTitle" }, props.label));
			if (desc !== undefined) {
				leftText.push(react.createElement("div", {
					key: "d",
					className: invalid || fieldFailed ? "mt-growDesc mt-growDescBad" : "mt-growDesc",
				}, desc));
			}
			return react.createElement(
				"div",
				{ className: props.inCard === true ? "mt-grow mt-growCard" : "mt-grow" },
				react.createElement("div", { className: "mt-growText" }, ...leftText),
				react.createElement(
					"div",
					{ className: "mt-growControl" },
					react.createElement("button", {
						type: "button",
						className: "mt-step",
						disabled: locked,
						"aria-label": t("stepDown"),
						onClick: () => step(-1),
					}, "\u2212"),
					react.createElement("input", {
						className: "mt-num",
						type: "text",
						inputMode: "numeric",
						"aria-label": props.label,
						"aria-invalid": invalid === true,
						"data-bad": invalid === true ? "true" : "false",
						// 占位符只在「未设置」时露出来：压缩预算那两行用它显示**当前生效值**
						// （缺省或用户值），其余行不传就和不加这个属性完全一样。
						placeholder: props.placeholder,
						value: shown,
						disabled: locked,
						onChange: (event) => setDraft(event.target.value),
						onBlur: commitDraft,
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						},
					}),
					react.createElement("button", {
						type: "button",
						className: "mt-step",
						disabled: locked,
						"aria-label": t("stepUp"),
						onClick: () => step(1),
					}, "+"),
				),
			);
		}
		/**
		 * 「子代理停滞看门狗」一节 —— 三条控件：停滞阈值、巡检间隔、超时处理。
		 *
		 * 两条数字行复用 `LimitRow`（同一个控件、同一种提交时机），单位是**秒**；
		 * 换算成毫秒只发生在 `WatchdogController.commitSeconds()` 里，本组件只传秒。
		 *
		 * ⚠️ 这张卡的值**只对保存后新建的会话生效**：宿主在读配置时把 `watchdog`
		 * 快照进 preset 声明，已开跑的会话沿用启动时那份 —— 卡片 `note` 必须把这件事
		 * 写在用户看得见的地方，而不是只写在代码注释里。
		 */
		function WatchdogSection(props) {
			const t = props.t;
			const state = useStore(props.watchdogStore);
			const parts = statusParts(t, state);
			const middle = [...parts.middle];
			if (state.saving === true) middle.push(banner(t("saving"), "saving", "info"));
			const locked = state.status !== "ready" || state.writable !== true || state.saving === true;
			const rows = [];
			if (state.status === "ready") {
				rows.push(react.createElement(LimitRow, {
					key: "watchdog-stall",
					t,
					limitsStore: props.watchdogStore,
					field: "stall",
					textKey: "stallText",
					failedKey: "stallFailed",
					label: t("watchdogStallLabel"),
					desc: t("watchdogStallHint"),
					invalid: "invalidSeconds",
					floor: WATCHDOG_SECONDS_FLOOR,
					inCard: true,
					commit: (field, value) => props.commitWatchdog({ stallSeconds: value }),
				}));
				rows.push(react.createElement(LimitRow, {
					key: "watchdog-tick",
					t,
					limitsStore: props.watchdogStore,
					field: "tick",
					textKey: "tickText",
					failedKey: "tickFailed",
					label: t("watchdogTickLabel"),
					desc: t("watchdogTickHint"),
					invalid: "invalidSeconds",
					floor: WATCHDOG_SECONDS_FLOOR,
					inCard: true,
					commit: (field, value) => props.commitWatchdog({ tickSeconds: value }),
				}));
				rows.push(row(
					t("watchdogModeLabel"),
					undefined,
					segmented(
						state.mode,
						[
							{ value: "off", label: t("watchdogModeOff") },
							{ value: "log", label: t("watchdogModeLog") },
							{ value: "interrupt", label: t("watchdogModeInterrupt") },
						],
						(mode) => props.commitWatchdog({ mode }),
						"watchdog-mode",
						locked,
					),
					"watchdog-mode-row",
				));
			}
			return card({
				sectionKey: "watchdog",
				title: t("watchdogTitle"),
				note: t("watchdogNote"),
				middle,
				rows,
				tail: parts.tail,
			});
		}
		/** 两项秒数控件共用的下限（5 秒）：低于它的阈值 / 巡检频率没有实际意义。 */
		const WATCHDOG_SECONDS_FLOOR = 5;
		/**
		 * 压缩预算的缺省值 —— **与 `presets/multitask/composition.mjs` 的
		 * `COMPACTION_DEFAULTS` 必须保持一致**。
		 *
		 * 浏览器 bundle import 不了宿主那边的 ESM，这对数字只能在这里再写一份；
		 * 改了那边的缺省就必须同步改这里（以及本节里计算「生效值」的那段推导），
		 * 否则输入框里的灰字会撒谎。
		 */
		const COMPACTION_DEFAULT_HEADROOM = "8192";
		const COMPACTION_DEFAULT_MAX_TOKENS = "65536";
		/**
		 * 「子代理上下文压缩」一节 —— 两项 token 预算，复用 `LimitRow`。
		 *
		 * 这张卡是**手动覆盖的入口**，不是修复本身：缺省预算（8192 / 65536）已由
		 * 组装层写进 `compaction-basic` 那一行，用户什么都不填也已经被修好了。
		 * 所以文案的原则是「先告诉你一般不用管，再告诉你在管什么」。
		 *
		 * 输入框的**占位灰字显示当前生效值**（见 `LimitRow` 的 `placeholder`）：
		 * 空框不再是「看不出现在是什么」，而是直接写着 8192 / 65536（或用户自己
		 * 写过的值）。生效规则镜像 `normalizeCompaction()`：headroom 缺省 8192；
		 * maxTokens 缺省 = 用户 headroom ?? 65536（上游「maxTokens 跟随 headroom」
		 * 的语义，只对用户显式写的 headroom 生效）。
		 */
		function CompactionSection(props) {
			const t = props.t;
			const state = useStore(props.compactionStore);
			const parts = statusParts(t, state);
			const middle = [...parts.middle];
			if (state.saving === true) middle.push(banner(t("saving"), "saving", "info"));
			const rows = [];
			if (state.status === "ready") {
				// 当前生效值：留空的项按缺省规则补上（镜像 `normalizeCompaction()`）。
				const headroomSet = state.headroomText !== "";
				const effectiveHeadroom = headroomSet ? state.headroomText : COMPACTION_DEFAULT_HEADROOM;
				const effectiveMax = state.maxTokensText !== ""
					? state.maxTokensText
					: (headroomSet ? state.headroomText : COMPACTION_DEFAULT_MAX_TOKENS);
				rows.push(react.createElement(LimitRow, {
					key: "compaction-headroom",
					t,
					limitsStore: props.compactionStore,
					field: "headroom",
					textKey: "headroomText",
					failedKey: "headroomFailed",
					label: t("compactionHeadroomLabel"),
					desc: t("compactionHeadroomHint"),
					invalid: "invalidTokens",
					floor: COMPACTION_FLOOR,
					inCard: true,
					placeholder: effectiveHeadroom,
					commit: (field, value) => props.commitCompaction({ headroomTokens: value }),
				}));
				rows.push(react.createElement(LimitRow, {
					key: "compaction-max",
					t,
					limitsStore: props.compactionStore,
					field: "max",
					textKey: "maxTokensText",
					failedKey: "maxTokensFailed",
					label: t("compactionMaxLabel"),
					desc: t("compactionMaxHint"),
					invalid: "invalidTokens",
					floor: COMPACTION_FLOOR,
					inCard: true,
					placeholder: effectiveMax,
					commit: (field, value) => props.commitCompaction({ maxTokens: value }),
				}));
			}
			return card({
				sectionKey: "compaction",
				title: t("compactionTitle"),
				ref: t("compactionRef"),
				note: t("compactionNote"),
				middle,
				rows,
				tail: parts.tail,
			});
		}
		/**
		 * 设置里的一级页「Multitask」。
		 *
		 * 四张卡都是**改完即写**，本页没有操作条：模型卡每一次选择直接走
		 * `TypeModelsController.commit()`，并发上限走宿主的 `LimitsController`，
		 * 看门狗与压缩预算走各自的控制器（都与模型映射同一个 `multitask` 命名空间）。
		 * 两个命名空间各自结算自己的 revision。
		 */
		function MultitaskSection(props) {
			const t = props.t;
			return react.createElement(
				"div",
				{ className: "mt-root" },
				react.createElement(
					"header",
					{ key: "head", className: "mt-head" },
					react.createElement("h2", { className: "mt-title" }, t("title")),
					react.createElement("p", { className: "mt-intro" }, t("intro")),
				),
				react.createElement(ModelsSection, { key: "models", ...props }),
				react.createElement(ConcurrencySection, { key: "concurrency", ...props }),
				react.createElement(WatchdogSection, { key: "watchdog", ...props }),
				react.createElement(CompactionSection, { key: "compaction", ...props }),
			);
		}
		//#endregion
		//#region 会话头部「正在运行」计数格
		/**
		 * 会话头部动作条里的一格：如实显示**正在运行的直接子代理数**。
		 *
		 * ── 为什么是「另加一格」而不是改官方那一格 ──────────────────────────────
		 * 官方 `@deepseek-ai/dsh-client-ui-subagent` 在同一槽（`id: "subagent-catalog"`，
		 * `order: -30`）显示的是**父会话持久化目录（catalog）的条数**，不是活着的子代理数。
		 * 用户看到「44 个子智能体」会误以为它们常驻内存。这里用**自有 id** 在它旁边多显示
		 * 一个「N 个正在运行」，让「目录总数」与「真正活着几个」并排出现 —— 零功能损失
		 * （官方那格与它自己的下拉导航原样保留，我们不遮蔽、不改它）。
		 *
		 * ── 数据从哪来（不需要新增 inject，也不需要新的跨包依赖）──────────────
		 * `sessionId` / `useSessions` / `useSessionStatus` / `t` 都是**框架按槽的 scope
		 * 注入的 standard kit**，任何注册进 `conversation.session.header.actions` 的条目
		 * 都拿得到 —— 官方组件与另一个独立包（agent-team）都是这么用的。取数表达式与
		 * 官方同源：
		 *   projectionsBySession[sessionId].values.subagentCatalog  ← 服务端投影的目录条目
		 *   statuses.get(id)?.running ?? summaries[id]?.running     ← 实时状态，缺则退回摘要
		 *
		 * ── 三种状态都如实，绝不用 0 冒充「不知道」────────────────────────────
		 *   · 目录已加载：running > 0 → 「N 个正在运行」；running === 0 → 「没有正在运行的子代理」
		 *   · 投影已报错 → 「无法获取正在运行的子代理数」（响亮，不显示 0）
		 *   · 目录尚未加载且无错 → 不渲染该格（与官方同一取舍：官方无目录时也不显示）
		 *   · 当前会话本身是子会话 → 不渲染（官方在同位置同样留空）
		 */
		function RunningSubagentCount(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const useSessions = props.useSessions;
			const useSessionStatus = props.useSessionStatus;
			// ⚠️ 先无条件调用全部 hook —— hook 的数量与顺序必须跨渲染稳定，
			// 所以「要不要渲染」的判断一律放到 hook 之后，用条件渲染而不是提前 return。
			const isChildSession = useSessions((s) => s.byId[sessionId]?.origin === "subagent");
			const catalog = useSessions((s) => s.projectionsBySession[sessionId]?.values?.subagentCatalog);
			const failed = useSessions((s) => {
				const snapshot = s.projectionsBySession[sessionId];
				return snapshot !== undefined && snapshot.state === "error";
			});
			const statuses = useSessionStatus((s) => s);
			const summaries = useSessions((s) => s.byId);
			// running 判定与官方完全一致：实时 status 优先，缺则退回会话摘要。
			let running = 0;
			if (Array.isArray(catalog)) {
				for (const entry of catalog) {
					if ((statuses.get(entry.id)?.running ?? summaries[entry.id]?.running) === true) running += 1;
				}
			}
			if (isChildSession === true) return null;
			if (failed) {
				return react.createElement(
					"span",
					{
						key: "header-running",
						style: { fontSize: "12px", lineHeight: "18px", color: palette.danger, whiteSpace: "nowrap" },
					},
					t("headerRunningUnavailable"),
				);
			}
			// 目录还没到（未加载）时保持沉默：这里显示 0 会是**错误信息**。
			if (!Array.isArray(catalog)) return null;
			return react.createElement(
				"span",
				{
					key: "header-running",
					style: {
						fontSize: "12px",
						lineHeight: "18px",
						whiteSpace: "nowrap",
						// 有活的用蓝色提一下，0 个则压到最淡的字色，避免抢眼。
						color: running > 0 ? palette.business : palette.labelTertiary,
					},
				},
				running > 0 ? t("headerRunning", { count: running }) : t("headerRunningNone"),
			);
		}
		//#endregion
		//#region 插件本体
		/**
		 * 必须就位的服务：slots（设置槽注册表）、locale（本页文案）、
		 * configForms（读写宿主设置命名空间）、remote / remote.session（模型目录）。
		 * 任一缺席时 cordis 只会推迟本页挂载，不会让页面炸掉。
		 */
		const inject = ["slots", "locale", "configForms", "remote", "remote.session"];
		/**
		 * 挂载「Multitask」设置页，以及「通用设置」里的两行。
		 * @param ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-multitask: dictionaries");
			const limits = new LimitsController(ctx.configForms.get(LIMITS_NS));
			const models = new TypeModelsController(ctx.configForms.get(TYPE_MODELS_NS), ctx);
			// 看门狗、压缩预算与模型映射住在**同一个**命名空间（`multitask`）的三个字段上，
			// 所以共用同一份表单、各自结算自己的 revision（各写自己整块字段）。
			const watchdog = new WatchdogController(ctx.configForms.get(TYPE_MODELS_NS));
			const compaction = new CompactionController(ctx.configForms.get(TYPE_MODELS_NS));
			ctx.effect(() => () => {
				limits.dispose();
				models.dispose();
				watchdog.dispose();
				compaction.dispose();
			}, "dsh-multitask: form subscriptions");
			// 模型目录只在页面建立后读一次；失败由页面上的「重试」按钮显式重来，
			// 不做后台轮询 —— 少一条常驻链路就少一处静默失败。
			models.loadCatalog();
			const face = () => ({
				t,
				typeModelsStore: models.store,
				retryCatalog: () => models.refreshCatalog(),
				setUniformMode: (next) => models.setUniformMode(next),
				setUniform: (value) => models.setUniform(value),
				setType: (type, key) => models.setType(type, key),
				// ★ 思考强度：档位来自模型目录，所以这里是「按类型 / 统一」两个写入口，
				// 与模型选择走同一个控制器、同一份 `subagentModels` 数组（一次 mutate）。
				setTypeEffort: (type, effortId) => models.setTypeEffort(type, effortId),
				setUniformEffort: (effortId) => models.setUniformEffort(effortId),
				// ★ 并发上限那一节走**宿主**那个控制器 —— 与「设置 → 通用设置」里的
				// 「子代理并行数量上限」是同一个值、同一份表单、同一个 path。
				// 所以这里把 limits 的 store 与 commit 一起交下去，两处 UI 由同一份
				// 数据驱动：改一处，另一处立刻跟着变（不需要任何同步代码）。
				limitsStore: limits.store,
				commitLimit: (field, value) => limits.commit(field, value),
				// ★ 看门狗卡：同一个 `multitask` 命名空间里的另一个字段。
				// 控件交来的是**秒**，`commitSeconds()` 负责换算成毫秒后整块写入。
				watchdogStore: watchdog.store,
				commitWatchdog: (patch) => watchdog.commitSeconds(patch),
				// ★ 压缩预算卡：同一个 `multitask` 命名空间里的另一个字段（token，不换算）。
				compactionStore: compaction.store,
				commitCompaction: (patch) => compaction.commit(patch),
				// 模型卡没有操作条：三个 setter 自己就是写入路径（改完即写），
				// 失败与冲突由控制器状态驱动页脚横幅。
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "multitask",
				order: 20,
				label: () => t("nav"),
				locale: NS,
				inject: face,
			}, MultitaskSection));
			// ── 通用设置里的两行 ────────────────────────────────────────────────
			// `settings.general.item` 正是为「不需要独立页面、只占一行」的偏好准备的
			// 座位，官方用它放语言 / 外观 / 开发者工具。两项运行限制是**宿主平面**
			// 设置（对所有模式生效，不只 Multitask），所以它们属于通用设置，而不是
			// 本插件自己那一页 —— 放在自己的页面里会让人以为只对 Multitask 生效。
			//
			// ⚠️ 该槽的注册项只有 `id` / `order` 两个选项，**没有 `label`**：那一段
			// 只负责把行竖着摞起来，行内部连自己的标题都由行自己画。所以每一行都带
			// 自己的 inject face。
			const limitRows = [
				{ id: "multitask-max-depth", order: 30, field: "maxDepth", labelKey: "maxDepth", descKey: "maxDepthHint", invalidKey: "invalidDepth", floor: 0 },
				{ id: "multitask-max-active", order: 31, field: "maxActive", labelKey: "maxActive", descKey: "maxActiveHint", invalidKey: "invalidActive", floor: 1 },
			];
			for (const spec of limitRows) {
				ctx.slots.inject("settings.general.item", () => ctx.slots.register({
					name: "settings.general.item",
					id: spec.id,
					order: spec.order,
					locale: NS,
					inject: () => ({
						t,
						limitsStore: limits.store,
						field: spec.field,
						label: t(spec.labelKey),
						desc: t(spec.descKey),
						invalid: spec.invalidKey,
						floor: spec.floor,
						commit: (field, value) => limits.commit(field, value),
					}),
				}, LimitRow));
			}
			// 会话头部动作条：在官方那格（id "subagent-catalog"、order -30）**旁边**加一格。
			// ⚠️ 必须用**自有 id** —— list 槽只在「同 id + 同 priority」时才冲突，用自有 id
			// 就是「新增一格」，官方那格与它的下拉导航原样保留（我们不改它、不遮蔽它）。
			// order -25 落在官方 -30 与 agent-team -20 之间，紧随官方那一格之后。
			// locale 用**本包自有**的 NS：官方那个 "subagent" 已注册过 zh/en，重复注册会抛错。
			// 不需要新增 inject —— sessionId / useSessions / useSessionStatus / t 都由框架
			// 按该槽的 scope 注入（standard kit），与注册它的包无关。
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "multitask-running",
				order: -25,
				locale: NS,
			}, RunningSubagentCount));
		}
		//#endregion
		exports.NS = NS;
		exports.LIMITS_NS = LIMITS_NS;
		exports.TYPE_MODELS_NS = TYPE_MODELS_NS;
		exports.WORKER_TYPES = WORKER_TYPES;
		exports.serializeModelMap = serializeModelMap;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
