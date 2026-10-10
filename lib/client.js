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
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			discard: "Discard changes",
			modelsTitle: "Model used by Subagents",
			modelsScopeNote: "Which model each kind of Subagent gets by default. Applies to sessions created afterwards; a session that is already running keeps the model it started with.",
			modelsRef: "multitask.subagentModels[]",
			modelsCatalogLoading: "Loading models…",
			modelsCatalogFailed: "The model catalog could not be loaded, so no model can be chosen yet.",
			modelsCatalogRetry: "Retry",
			modelsCatalogPartial: "Some providers could not be loaded; a saved choice that is no longer advertised stays selectable so you can clear it.",
			modelsCatalogEmpty: "No provider currently advertises a model.",
			modelsConflict: "Settings changed elsewhere. Discard your draft and try again.",
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
			headerRunningUnavailable: "Running Subagent count unavailable"
		};
		/** Simplified Chinese copy. */
		const zh = {
			nav: "Multitask",
			title: "Multitask",
			intro: "减震器模式下，协调者向子代理派活时的相关设置。",
			unavailable: "本部署没有提供该设置命名空间，暂时无法在此配置。",
			readOnly: "本部署的设置为只读。",
			loading: "正在读取当前配置…",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			discard: "放弃修改",
			modelsTitle: "子代理使用的模型",
			modelsScopeNote: "决定各类子代理默认用哪个模型。只对此后新建的会话生效；已开跑的会话保持它启动时的模型。",
			modelsRef: "multitask.subagentModels[]",
			modelsCatalogLoading: "正在加载模型…",
			modelsCatalogFailed: "无法加载模型目录，因此暂时无法选择模型。",
			modelsCatalogRetry: "重试",
			modelsCatalogPartial: "部分模型提供方暂时无法加载；已保存但不再公布的选项仍可选中，以便你把它清掉。",
			modelsCatalogEmpty: "当前没有模型提供方公布模型。",
			modelsConflict: "设置已在其他位置更新。请放弃修改后重试。",
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
			headerRunningUnavailable: "无法获取正在运行的子代理数"
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
		 * @param map - 类型 → `{ provider, model }`。
		 * @returns `[{ subagentType, provider, model }]`，只含已指定的类型。
		 */
		function serializeModelMap(map) {
			const list = [];
			for (const type of WORKER_TYPES) {
				const route = map.get(type);
				if (route === undefined) continue;
				list.push({ subagentType: type, provider: route.provider, model: route.model });
			}
			return list;
		}
		/**
		 * 两组「类型 → 路线」是否等价。
		 * @param left - 一组映射。
		 * @param right - 另一组映射。
		 * @returns 是否完全一致（顺序无关）。
		 */
		function sameModelMap(left, right) {
			return WORKER_TYPES.every((type) => {
				const a = left.get(type);
				const b = right.get(type);
				if (a === undefined || b === undefined) return a === undefined && b === undefined;
				return a.provider === b.provider && a.model === b.model;
			});
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
				// 草稿用 `undefined` 表示「还没碰过」；空 Map 是合法草稿（四类全继承）。
				this.draft = undefined;
				this.draftRevision = undefined;
				// 形态草稿：`undefined` = 沿用由已存值推导出来的形态。
				this.draftMode = undefined;
				this.store = createStore(this.projection());
				this.unsubscribe = form.subscribe(() => {
					if (this.disposed) return;
					// 外部改动与本页草稿冲突时告知用户，而不是静默覆盖。
					if (!this.saving && this.draftRevision !== undefined) {
						const snapshot = this.form.getSnapshot();
						if (snapshot.revision !== this.draftRevision) {
							if (sameModelMap(this.storedMap(), this.draft)) this.clearDraft();
							else this.conflict = true;
						}
					}
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
					map.set(type, { provider: entry.provider, model: entry.model });
				}
				return map;
			}
			/** 当前想写下去的那份映射（有草稿就用草稿）。 */
			desiredMap() {
				return this.draft === undefined ? this.storedMap() : this.draft;
			}
			/**
			 * 四类是否已经指向同一条路线；是则返回那条路线。
			 *
			 * 空映射（四类都继承）**不算**统一：那时没有任何已选的模型，
			 * 统一选择框显示的是占位项而不是一个假装被选中的值。
			 */
			uniformRoute() {
				const map = this.desiredMap();
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
			/** 当前形态（有草稿就用草稿）。 */
			mode() {
				return this.draftMode === undefined ? this.storedMode() : this.draftMode;
			}
			/** 保证草稿存在（第一次触碰时从已存储值立起）。 */
			beginDraft() {
				if (this.draft === undefined) {
					this.draft = this.storedMap();
					this.draftRevision = this.snapshotValue().revision;
				}
				return this.draft;
			}
			/**
			 * 放弃草稿：模型映射与并发上限**一起**回退。
			 *
			 * 只有模型映射需要回退 —— 并发上限已改由 `LimitsController`（宿主命名空间）
			 * 的「改完即写」路径管理，本类不再持有它的草稿。
			 */
			clearDraft() {
				this.draft = undefined;
				this.draftRevision = undefined;
				this.draftMode = undefined;
				this.failed = false;
				this.conflict = false;
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
			/** 每个类型那一行的当前值与可选路线。 */
			rows() {
				const desired = this.desiredMap();
				return WORKER_TYPES.map((type) => {
					const built = this.optionsFor(desired.get(type));
					return {
						type,
						labelKey: TYPE_LABEL_KEYS[type],
						value: built.value,
						options: built.options,
					};
				});
			}
			/**
			 * 统一形态那一行：四类共用的那一条路线。
			 *
			 * 已存值与草稿不一致时（用户刚切到统一、或四类本来就不同），
			 * 取**第一类**当前的值作为起点，避免选择框随机挑一条。
			 */
			uniformRow() {
				const route = this.uniformRoute() || this.desiredMap().values().next().value;
				const built = this.optionsFor(route);
				return { value: built.value, options: built.options };
			}
			/**
			 * 切换「统一 / 按类型」。
			 *
			 * 只改形态，**不动**任何已选的路线：切回按类型时原来的四类值还在。
			 * 切到统一时若四类本就不同，选择框先显示第一类的值（见 `uniformRow`），
			 * 用户选了新的才真正覆盖 —— 切一下不会静默改掉另外三类的配置。
			 * @param next - 是否使用统一形态。
			 */
			setUniformMode(next) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				this.beginDraft();
				this.draftMode = next ? "uniform" : "perType";
				this.failed = false;
				if (next && this.catalogStatus === "idle") this.loadCatalog();
				this.publish();
			}
			/** 统一形态下选定一条路线：四类一起写成同一条。 */
			setUniform(value) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				const routes = this.beginDraft();
				if (value === "") {
					// 占位项 = 没有统一模型：四类一起回到「继承协调者」。
					for (const type of WORKER_TYPES) routes.delete(type);
				} else {
					const option = this.uniformRow().options.find((candidate) => candidate.value === value);
					if (option === undefined) return;
					for (const type of WORKER_TYPES) {
						routes.set(type, { provider: option.provider, model: option.model });
					}
				}
				this.draftMode = "uniform";
				this.failed = false;
				if (this.catalogStatus === "idle") this.loadCatalog();
				this.publish();
			}
			/**
			 * 为某一类选择模型；`value` 为空串表示「继承协调者」。
			 * @param type - 类型键。
			 * @param value - `rows()` 给出的选项 value（下标），或空串。
			 */
			setType(type, value) {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				if (!WORKER_TYPES.includes(type)) return;
				const routes = this.beginDraft();
				if (value === "") {
					routes.delete(type);
				} else {
					const row = this.rows().find((candidate) => candidate.type === type);
					const option = row === undefined ? undefined : row.options.find((candidate) => candidate.value === value);
					if (option === undefined) return;
					routes.set(type, { provider: option.provider, model: option.model });
				}
				this.failed = false;
				if (this.catalogStatus === "idle") this.loadCatalog();
				this.publish();
			}
			discard() {
				if (this.saving) return;
				this.clearDraft();
				this.publish();
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
			 * 提交这次草稿。
			 *
			 * ── 为什么是**一次** `mutate` 带**两个**路径 ────────────────────────────
			 * 两个字段住在**同一个**命名空间、共用同一次 `revision` 对账，所以它们必须
			 * 在同一次写入里落地。拆成两次 `mutate` 的后果是实打实的：第一次成功会
			 * 把 revision 推高，第二次带着旧 revision 去写就会被判成「设置已在其他位置
			 * 更新」—— 用户看到的是「保存失败」，而配置其实已经改了一半。
			 * `dsh-settings` 的 `mutate(ns, ops, expectedRevision)` 收的就是一个 ops
			 * **数组**（内部 `ops.reduce(...)` 依次施加）。
			 *
			 * ops 的确切形状（**只有一项** —— 并发上限已不在这里，见上）：
			 *   [
			 *     { op: "set",  path: ["subagentModels"], value: [{ subagentType, provider, model }, …] }
			 *   ]
			 */
			async save() {
				const stored = this.snapshotValue();
				if (this.disposed || stored.status !== "ready" || !stored.writable || this.saving) return;
				if (this.draft === undefined) return;
				const desired = this.desiredMap();
				const modelsDirty = !sameModelMap(this.storedMap(), desired);
				if (!modelsDirty) return;
				if (stored.revision !== this.draftRevision) {
					this.conflict = true;
					this.publish();
					return;
				}
				const generation = this.saveGeneration;
				this.saving = true;
				this.failed = false;
				this.conflict = false;
				this.publish();
				const ops = [{ op: "set", path: ["subagentModels"], value: serializeModelMap(desired) }];
				const accepted = await this.form.mutate(ops, this.draftRevision);
				if (generation !== this.saveGeneration || this.disposed) return;
				const landed = sameModelMap(this.storedMap(), desired);
				this.saving = false;
				this.failed = accepted !== true || !landed;
				if (!this.failed) this.clearDraft();
				this.publish();
			}
			projection() {
				const stored = this.snapshotValue();
				const dirty = this.draft !== undefined && !sameModelMap(this.storedMap(), this.draft);
				return {
					status: stored.status,
					writable: stored.writable,
					// 脏值只看模型映射 —— 并发上限走的是另一条「改完即写」的路径。
					dirty,
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
			".mt-row{display:flex;align-items:center;gap:16px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			".mt-row:last-child{border-bottom:none}",
			".mt-rowText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
			".mt-rowLabel{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}",
			".mt-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".mt-rowDescBad{color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".mt-rowControl{flex:none;display:flex;align-items:center;gap:8px}",
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
			// 用户会分不清当前是哪一项。这里用业务主色填充 + 反白字，与「保存」按钮
			// 同一套官方令牌配对，浅色 / 深色 / 皮肤下都自动成立。
			".mt-segBtn[data-on=true]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.18)}",
			".mt-segBtn:disabled{opacity:.5;cursor:default}",
			".mt-segBtn[data-on=true]:disabled{opacity:.6}",

			".mt-selectWrap{position:relative;display:inline-flex;align-items:center;min-width:0}",
			".mt-selectWrap::after{content:'';position:absolute;right:13px;width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:translateY(-2px) rotate(45deg);pointer-events:none}",
			".mt-select{appearance:none;font:inherit;font-size:13px;line-height:20px;height:34px;min-width:208px;max-width:280px;padding:0 32px 0 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);cursor:pointer;text-overflow:ellipsis;transition:border-color .15s ease}",
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

			".mt-actions{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}",
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
			".mt-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".mt-btn[data-primary=true]:hover:not(:disabled){filter:brightness(1.08)}",

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
		/** 卡片外壳：标题、可选源码字段、说明、若干行、可选操作条。 */
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
		 */
		function selectField(value, options, onChange, key, disabled) {
			return react.createElement(
				"div",
				{ key, className: "mt-selectWrap" },
				react.createElement(
					"select",
					{
						className: "mt-select",
						value,
						disabled: disabled === true,
						onChange: (event) => onChange(event.target.value),
					},
					...options.map((option) => react.createElement("option", { key: option.key, value: option.value }, option.label)),
				),
			);
		}
		/**
		 * 页面底部唯一的操作条。
		 *
		 * ── 为什么是**一条**而不是每张卡片一条 ────────────────────────────────
		 * `save` 一次提交 `multitask` 这**一个**命名空间里的**两个字段**
		 * （`subagentModels` 与 `maxActiveSubagents`），而模型卡与并发卡正是这两
		 * 个字段各自的界面。两张卡同属**同一个表单、共用同一个 `revision`**，本来
		 * 就必须一次提交（见 `save()` 里那段「为什么是一次 mutate 带两个路径」）。
		 * 若每张卡各放一枚，先点的那枚会把 revision 推高，后点的那枚带着旧 revision
		 * 去写就会被判成「设置已在其他位置更新」—— 用户看到的是莫名其妙的失败，而
		 * 「点哪张卡的保存」与「实际写了什么」也对不上（映射弱）。
		 * 因此操作条只放一条，放在两张卡片之下，并如实反映**两节合起来**的脏值。
		 * @param states - 两张卡片的状态，用于合并「是否有未保存改动」与「是否在保存中」。
		 */
		function actionBar(t, states, onSave, onDiscard) {
			const ready = states.every((state) => state.status === "ready" && state.writable === true);
			if (!ready) return undefined;
			const saving = states.some((state) => state.saving === true);
			const dirty = states.some((state) => state.dirty === true);
			return react.createElement(
				"div",
				{ className: "mt-actions" },
				react.createElement(
					"button",
					{ type: "button", className: "mt-btn", "data-primary": "true", disabled: saving || !dirty, onClick: onSave },
					saving ? t("saving") : t("save"),
				),
				react.createElement(
					"button",
					{ type: "button", className: "mt-btn", disabled: saving || !dirty, onClick: onDiscard },
					t("discard"),
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
		 * 「子代理使用的模型」一节。
		 *
		 * 只有两种形态，由上面的分段控件切换：
		 *   · 是 —— 四类子代理共用同一条路线（一行下拉）；
		 *   · 否 —— 每类各自指定（四行下拉，「继承协调者」即该类型不写进配置）。
		 * 两种形态落到 `subagentModels[]` 上是同一份数据，切换不改写任何值，
		 * 因此这里没有「统一模式」这类额外的存储字段。
		 */
		function ModelsSection(props) {
			const t = props.t;
			const state = useStore(props.typeModelsStore);
			const parts = statusParts(t, state);
			const rows = [];
			const middle = [...parts.middle];
			if (state.status === "ready") {
				const locked = !state.writable || state.saving;
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
					rows.push(row(
						t("uniformSelectLabel"),
						t("uniformSelectDesc"),
						selectField(state.uniformRow.value, options, (value) => props.setUniform(value), "uniform-select", locked),
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
						rows.push(row(
							t(item.labelKey),
							t(item.labelKey + "Hint"),
							selectField(item.value, options, (value) => props.setType(item.type, value), "type-select-" + item.type, locked),
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
		 * ── 与上面模型卡的两处关键差别（都不是风格问题）─────────────────────────
		 *   1. **改完即写**，不经过本页的保存按钮。理由与通用设置那一段完全相同：
		 *      这个值住在宿主命名空间，那一处的行都是即时生效的偏好行。若在这里改成
		 *      「草稿 + 保存」，同一张卡在通用设置里立刻生效、在 Multitask 页里却要
		 *      按保存 —— 那是对用户的谎言。
		 *   2. **它不参与本页 `actionBar` 的脏值判定**：那条操作条现在只服务模型映射
		 *      （`dirty` 只看模型），否则「模型没改、上限改了」会让保存按钮亮起来，
		 *      而按下去什么也不会发生。
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
			const stored = props.field === "maxDepth" ? state.depthText : state.activeText;
			const fieldFailed = props.field === "maxDepth" ? state.depthFailed === true : state.activeFailed === true;
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
			const desc = invalid ? t(props.invalid) : fieldFailed ? t("limitsSaveFailed") : props.desc;
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
		/** 设置里的一级页「Multitask」。 */
		function MultitaskSection(props) {
			const t = props.t;
			const modelsState = useStore(props.typeModelsStore);
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
				// ★ 操作条**只服务模型卡**了 —— 并发上限那张卡是**改完即写**的
				// （走宿主那个 `LimitsController`），不经过这里的保存按钮。
				// 所以 `dirty` 只看模型映射：否则「模型没改、上限改了」会让保存按钮
				// 亮起来，而按下去什么也不会发生（那是本页最容易犯的一类谎）。
				actionBar(t, [modelsState], props.save, props.discard),
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
			ctx.effect(() => () => {
				limits.dispose();
				models.dispose();
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
				// ★ 并发上限那一节走**宿主**那个控制器 —— 与「设置 → 通用设置」里的
				// 「子代理并行数量上限」是同一个值、同一份表单、同一个 path。
				// 所以这里把 limits 的 store 与 commit 一起交下去，两处 UI 由同一份
				// 数据驱动：改一处，另一处立刻跟着变（不需要任何同步代码）。
				limitsStore: limits.store,
				commitLimit: (field, value) => limits.commit(field, value),
				// 操作条那对按钮**只服务模型映射**了：并发上限改完即写，不经过这里。
				// 所以「保存」只在模型映射真的脏时才可点（`dirty` 只看模型）。
				save: () => {
					if (models.getState().dirty) models.save();
				},
				discard: () => models.discard(),
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
