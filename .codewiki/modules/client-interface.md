---
title: client-interface
type: module
source_files:
  - client.js
tags: [client, react, api-wrapper, plugin-system, sidebar-panel, config-forms]
---

## Overview

`client-interface` 是 CodeWiki 插件的前端半侧（实现于仓库根 `client.js`，文件头标注 v0.4.1，第 1 行），经 `window.__ModuleLoader__.load` 由宿主插件系统加载，模块 id 为 `@local/dsh-codewiki`（第 10-11 行），`factory(require)` 内引入 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（解构 `Switch/Button/Input/Tag`，第 13-15 行）。它承担三类职责：

1. **插件设置页**：向宿主 `plugins.item` 槽位注入设置卡片 `CodewikiCard`（id = NS = `'codewiki'`，order 30，第 420-427 行），设置读写走宿主 `configForms` 服务命名空间 `'codewiki'`（第 17、417 行），热生效无需重启。
2. **侧边栏面板**：向 `main` 与 `sidebar.panellist` 两个槽位注册 `CodewikiPanel`/`PanelIcon`（第 435-446 行），轮询宿主半侧 webServer 端点渲染编译任务进度与仓库总览（总览/任务/设置三个标签页），并提供取消、编译、排除等控制操作。
3. **API 封装**：`apiGet`/`apiPost`（第 393-408 行）封装对 `GET /api/codewiki/jobs`（第 19 行）、`POST /api/codewiki/control`（第 20 行，仅回环）、`GET /api/codewiki/repos`（第 23 行）、`GET /api/codewiki/models`（第 24 行）、`GET /api/codewiki/model-efforts`（第 25 行）的访问。

关键约定（文件头注释，第 2-8 行）：两个挂载点分别为「插件」页设置表单与侧边栏面板（数据来自 `GET /api/codewiki/jobs`、`POST /api/codewiki/control`）；面板 key 与 `sidebar.panellist` 的 id 必须同为 `KEY`（第 18 行）；设置 id 必须等于 package.json 的 `name`（client-modules 按 nearestPackage 的 name 校验注册者）；locale 词典值必须是字符串——词典值若为函数，`t()` 会回退返回键名。

当前代码中活跃阶段常量 `ACTIVE_STAGES` 为 `['queued', 'articles', 'crosscut', 'compose', 'review', 'index']`（第 28 行），已不含早期版本的 `plan` 阶段。

## Key Components

### 常量与配置

- `NS = 'codewiki'`（第 17 行）：插件命名空间 = profile patch 条目 id = 设置命名空间。
- `KEY = 'codewiki'`（第 18 行）：面板 key；`sidebar.panellist` 的 id 必须与它一致。
- `JOBS_PATH = '/api/codewiki/jobs'`（第 19 行）：编译任务列表端点。
- `CONTROL_PATH = '/api/codewiki/control'`（第 20 行）：控制端点（cancel/compile/refresh，仅回环）。
- `PANEL_ORDER = 52`（第 21 行）：面板排序，排在 dsh-hindsight-on-demand（50）之后。
- `POLL_MS = 2000`（第 22 行）：任务列表轮询间隔。
- `REPOS_PATH = '/api/codewiki/repos'`（第 23 行）：仓库状态与调度信息端点。
- `MODELS_PATH = '/api/codewiki/models'`（第 24 行）：模型目录端点。
- `EFFORTS_PATH = '/api/codewiki/model-efforts'`（第 25 行）：模型思考档位端点（按 provider+model 查询）。
- `REPOS_POLL_MS = 10000`（第 26 行）：仓库列表轮询间隔。
- `ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index']`（第 28 行）：活跃阶段列表（queued 单列最前——单项目串行时后提交的项目在此等待，第 27 行注释）；用于步骤条、总体进度与焦点判断。
- `STAGE_WEIGHTS = { queued: 0, articles: 0.65, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }`（第 939 行，定义于面板辅助函数区）：各阶段在总体进度中的定权，供 `overallPct` 使用。

### 词典与国际化

- `zh()`（第 30-167 行）：中文字典，覆盖标题/简介、设置项与提示（title/summary/intro/secRun/enabled/updateReminder/autoCommit/workspaceOnly/maxConcurrency/serialProjects/secCompile/batchProvider/batchModel/batchReasoningEffort*/secBig/bigProvider/bigModel/bigReasoningEffort*/bigTokenBudget/sessionTier/articleLanguage/binaryPath/panelTitle/stage*/state*/kind*/autoUpdate*/excludePaths*/sched* 等）。
- `en()`（第 168-305 行）：英文字典，键集与 `zh()` 一致。
- 注册：`apply` 内 `ctx.effect(() => ctx.locale.register(NS, { zh: zh(), en: en() }), 'dscw: dictionaries')`（第 414 行）；`tBound = ctx.locale.bind(NS)`（第 413 行）。

### 样式注入

- `style` 元素（第 307-385 行）：`style.dataset.plugin = '@local/dsh-codewiki'`（第 308 行）；CSS 按两组属性选择器组织——设置页 `data-dscw-*`（第 310-320 行）与侧栏面板 `data-dscw-p-*`（第 321-384 行），含六阶段步骤条（第 359-372 行）、吞吐徽标（第 373-376 行）与用量/错误/活动流（第 377-384 行）样式。
- HMR 防重（第 386-387 行）：`document.head` 已存在同名 `style[data-plugin="@local/dsh-codewiki"]` 时不再追加，避免重复加载堆叠样式表。

### API 封装与 DOM 助手

- `el(tag, props, ...children)`（第 389-391 行）：`React.createElement` 包装。
- `apiGet(p)`（第 393-398 行）：GET + `accept: application/json`；非 2xx 抛 `body.error || HTTP {status}`。
- `apiPost(p, data)`（第 399-408 行）：POST `application/json` body；错误处理同 `apiGet`。

### 模块入口 apply(ctx)

- `inject: ['slots', 'locale', 'configForms']`（第 411 行）；`apply(ctx)`（第 412-1351 行）。
- 词典注册（第 413-414 行）；`form = ctx.configForms.get(NS)`（第 417 行）。
- `plugins.item` 挂载（第 420-432 行）：`mount` 注册 `{ name: 'plugins.item', id: NS, order: 30, label, locale: NS, inject: () => ({ t: tBound }) }` + `CodewikiCard`（第 420-427 行）；宿主提供 `ctx.configForms.whileServed` 时仅在该命名空间被服务期间挂载（插件停用/未加载则插件页不显形，第 428-432 行），否则直接挂载。
- 侧边栏面板挂载（第 435-446 行）：`ctx.effect` 内同时注入 `main`（`{ name: 'main', key: KEY }` + `CodewikiPanel`，第 437 行）与 `sidebar.panellist`（`{ id: KEY, order: PANEL_ORDER, label }` + `PanelIcon`，第 438-443 行），effect 返回 disposers 逐个清理（第 445 行）。

### 设置卡片 CodewikiCard(props)（第 452-851 行）

- 状态：`snapshot`/`draft`/`notice`/`error`（第 455-458 行），模型目录 `catalog`/`catalogError`（第 461-462 行）。
- 模型目录拉取 `useEffect`（第 464-475 行）：挂载时 `apiGet(MODELS_PATH)`；`data.ok === false` 或异常时置 `catalogError`，设置页退回「手填」形态，不阻断保存。
- 配置快照订阅 `useEffect`（第 478-495 行）：`pull` 读 `form.getSnapshot()` 并 `setSnapshot`；仅当 `snap.status === 'ready'` 且 `revision` 变化时 `setDraft(structuredClone(snap.value))`（第 485-490 行，宿主值变更含保存成功后的回收读才覆盖草稿）；`form.subscribe(pull)` 订阅（第 493 行）。
- 摘要视图（第 498 行）：`props.view === 'summary'` 时只返回一行简介（插件页列表项）。
- `setPath(key, value)`（第 500-507 行）：不可变更新 draft。
- `dirty` memo（第 509-512 行）：JSON 比较草稿与快照。
- `selectedProvider` memo（第 515-519 行）：从 catalog 匹配 `draft.batchProvider`，未命中为 null（手填形态）。
- 思考档位 `useEfforts`（第 524-555 行）：返回 `{ for, efforts, defaultEffort, error, loading }`；`useEffect` 依赖 `[p, m]`（第 527 行），二者齐备时按 `EFFORTS_PATH?provider=…&model=…`（第 533 行）拉取档位清单（来自模型目录，不手填裸字符串），失败或为空时 UI 各有提示与回退。`effortsState`/`bigEffortsState` 调用（第 556-557 行）。
- `modelTrio({ pKey, mKey, eKey, state, allowEmptyProvider, providerPlaceholder })`（第 562-661 行）：渲染一个模型的三个字段（提供商/模型/思考程度），普通档与大档共用；换提供商时联动清空模型与档位（第 579-586 行），已配置但目录缺失的 provider 保留 `__custom` 选项防静默丢失（第 591-593 行），catalogError 时退化为 Input（第 571-575 行）。
- `save()`（第 663-685 行）：校验 `maxConcurrency` 并发上限为 1-8 整数（第 665-669 行）；对 `['enabled','binaryPath','maxConcurrency','serialProjects','articleLanguage','updateReminder','autoCommit','workspaceOnly','batchProvider','batchModel','batchReasoningEffort','bigProvider','bigModel','bigReasoningEffort','bigTokenBudget','sessionTier','excludePaths','autoUpdate','autoUpdateMin']` 逐键 JSON 差分构建 ops（第 672-676 行）；`form.mutate(ops, snapshot.revision)` 提交（第 679 行），接受与否分别提示 saved/conflict（第 680 行）。
- `discard()`（第 687-691 行）：草稿重置为快照并清空提示。
- 加载/不可用态渲染（第 693-695 行）。
- 渲染（第 697-851 行）：
  - `secRun` 运行区（第 700-773 行）：`enabled` 开关（第 703-711 行）、`updateReminder` wiki 维护提醒开关（第 712-720 行）、`autoCommit` 自动提交编译产物开关（第 721-729 行）、`workspaceOnly` 只显示工作区任务开关（第 730-738 行）、`maxConcurrency` 并发上限输入（第 739-747 行）、`serialProjects` 单项目串行开关（第 748-756 行）、`articleLanguage` 文章语言输入（第 757-762 行）、`binaryPath` cw 可执行路径输入（第 763-771 行）。
  - `secCompile` 编译模型区（第 775-790 行，唯一通道：模型设置里已注册的 provider/model）：调用 `modelTrio` 渲染 `batchProvider`/`batchModel`/`batchReasoningEffort`（第 779 行），以及 `sessionTier` 兜底档位手填（第 780-788 行）。
  - `secBig` 大档模型区（第 792-807 行）：调用 `modelTrio` 渲染 `bigProvider`(allowEmptyProvider=true)/`bigModel`/`bigReasoningEffort`（第 796 行），以及 `bigTokenBudget` 输入（第 797-805 行）。
  - `secSchedule` 调度与排除区（第 809-841 行）：`autoUpdate` 自动更新开关（第 812-820 行）、`autoUpdateMin` 扫描间隔分钟输入（第 821-829 行）、`excludePaths` 排除清单多行文本域（换行/分号/逗号分隔绝对路径，第 830-839 行）。
  - 保存条（第 843-850 行）：放弃/保存按钮按 `dirty`/`snapshot.writable` 禁用；error 红字或干净态 notice Tag。

### 面板辅助函数与小组件（第 857-989 行）

- `stageLabel(stage)`（第 857 行）/`stateLabel(st)`（第 858 行）/`kindLabelOf(t, kind)`（第 859 行）：拼接 `stage*/state*/kind*` 键取翻译。
- `progressBar(done, total)`（第 860-863 行）：total>0 时渲染 `data-dscw-p-bar` 进度条（宽度取完成比）。
- `repoName(cwd)`（第 864-867 行）：取路径末两段「父目录/目录名」，Temp 沙箱残留一眼可辨。
- `fmtMs(ms)`（第 868-874 行）：`HH:MM:SS`/`MM:SS`；`fmtTok(n)`（第 875-880 行）：token 数 k/M 缩写；`fmtDur(ms)`（第 881-886 行）：`X min`/`X h Y min`；`fmtAgo(iso)`（第 887-890 行）：相对时间 + agoSuffix。
- `Spark({ values, width = 56, height = 16 })`（第 892-904 行）：纯 SVG path 微趋势线，过滤非正数，少于 2 点返回 null。
- `stepName(s)`（第 908 行）；`lastTimedStage(job)`（第 911-914 行）：返回 `stageTimings` 中最后一个属于 ACTIVE_STAGES 的键。
- `stageBar(job)`（第 915-937 行）：六阶段（含 queued）步骤条——已完成绿点（title 带各阶段耗时）、当前阶段实心点 + 实时计时（第 925 行）、失败/取消在最后计时段标红/黄（failIdx 逻辑第 918 行，标记第 927-933 行），终态 done 全绿。
- `STAGE_WEIGHTS`（第 939 行，常量定义见前文）与 `overallPct(job)`（第 940-948 行）：按 `STAGE_WEIGHTS` 累计已完成阶段权重，阶段内按 `taskList` 完成数折算（第 945-947 行），封顶 99、done 才 100（第 942、947 行）。
- `throughputBadge(job, sparkOf, rateOf)`（第 951-971 行）：`job.tps > 0` 时显示 tok/s + Spark（实时通道，第 953-956 行）；否则批量通道按 `rateOf` 速率与 `batchProgress` 显示 篇/分 + ETA（第 958-965 行），无完成样本时显示自 `batchSubmittedAt` 起的执行时长（第 967-968 行）；非活动阶段返回 null（第 952 行）。
- `usageLine(job)`（第 973-989 行）：输入（提交时估算）/输出（响应实测）token（第 976-979 行）、请求数（批量/实时拆分，第 980-985 行）；`u.overTier2` 个超单请求预算（按大档装填）请求数红字提示（第 988 行）。

### 总览标签页 ReposTab()（第 992-1135 行）

- 状态：`data`/`err`/`busyCwd`/`mountedRef`（第 994-998 行）、`inFlightRef`（第 1000 行，防重叠拉取第 1002 行）、`exclBusy`（第 1021 行）。
- `pull()`（第 1001-1012 行）：`apiGet(REPOS_PATH)`；`useEffect` 首拉 + `setInterval(pull, REPOS_POLL_MS)`（第 1013-1017 行）。
- `toggleExclude`（第 1022-1040 行）：读 form 快照并校验可写（第 1023-1024 行）；`excludePaths` 按换行/分号/全半角逗号拆分（第 1028 行），路径归一化（去尾斜杠 + 小写，第 1027 行）判断已排除与否，增删后 `form.mutate` 写回（第 1031 行，与设置卡保存同链路经宿主 configForms 持久化热生效）；成功后 POST `control {action:'refresh'}` 失效服务端总览缓存并立即重拉（第 1033 行）。
- `compile(cwd)`（第 1042-1050 行）：POST `control {action:'compile', cwd}` 触发单仓库编译。
- 渲染（第 1055-1131 行）：调度卡（开/关、间隔、上次扫描/上次错误，第 1057-1067 行）；启用且有扫描记录时推算下次扫描时间与剩余时长、显示扫描/提交统计（第 1068-1083 行）；仓库列表（第 1086-1130 行）——名称、排除标签、状态色映射（clean→done / stale→stale / error→failed / 其余→cancelled，第 1089 行）、stale 时的「更新」按钮（第 1095-1100 行）、排除/取消排除按钮（第 1101-1105 行）、变更文件数/文章数/最近任务元信息与进度条（第 1107-1127 行）；空态 reposEmpty（第 1130 行）；渲染异常就地显形 `Repos error: …`（第 1132-1134 行）。

### 主面板 CodewikiPanel()（第 1137-1337 行）

- 状态：`jobs`（null = 尚未拿到首轮，第 1139 行）、`err`（第 1140 行）、`busyId`（第 1141 行）、`tab`（默认 'overview'，第 1142 行）、`copiedPath`（第 1143 行）；`sparkRef`（jobId→tps 滚动窗口 Map，第 1145 行）、`batchRateRef`（jobId→{at, completed, rate} Map，第 1146 行）、`sparkOf`/`rateOf`（第 1147-1148 行）；`mountedRef`（第 1193-1194 行，卸载后不再 setState）。
- 轮询 `useEffect`（第 1150-1190 行）：每 `POLL_MS` 拉取 `JOBS_PATH`（inFlight 防重叠，第 1152 行）；对每个 job 把 `j.tps` 推入 sparkRef 窗口（超 30 点 shift，第 1163-1166 行）；`batchProgress.completed` 差分计算瞬时速率（篇/分）并按 `prev.rate*0.6 + inst*0.4` EWMA 平滑（第 1170-1176 行）；任务离开批量态时从 batchRateRef 删除（第 1177 行）。
- `cancel(jobId)`（第 1195-1203 行）：POST `control {action:'cancel', jobId}`。
- `copyPath(p)`（第 1204-1210 行）：剪贴板写入 wiki 路径，1.5s 后清除「已复制」态；权限拒绝时静默。
- `kindLabel`（第 1212 行）；`isActive(job)`（第 1214 行）：stage ∈ ACTIVE_STAGES。
- 分组（第 1217-1223 行）：按 cwd 分组、保持首次出现顺序、组内 unshift 最新在前（服务历史折叠区）。
- 焦点任务（第 1225-1229 行）：活动任务按 updatedAt 取最新，无活动取最近更新任务；其余收进「历史任务」折叠区。
- `jobCard(job)`（第 1231-1289 行）：kind Tag、阶段文本（data-state 着色，第 1247-1250 行）、吞吐徽标（第 1251 行）、取消按钮（`cancelRequested` 时禁用并显示「取消中…」，第 1252-1257 行）、`stageBar`（第 1260 行）、meta 行（已写/失败/批次/已用时或总耗时，第 1237-1243 行）、总进度条（仅活动任务，第 1262 行）、`usageLine`（第 1263 行）、最新一条 note + 活动流 details（第 1264-1271 行）、error 行（第 1272 行）、活动任务的任务清单 ✓/✗/· 列表（第 1273-1278 行）、wiki 路径与复制按钮（第 1279-1287 行）。
- 渲染（第 1291-1331 行）：标题 + 进行中计数（第 1293-1298 行）；三标签按钮（第 1299-1306 行）；`tab === 'overview'` → ReposTab（第 1307 行）、`tab === 'settings'` → 内嵌 CodewikiCard（第 1308 行）、`tab === 'tasks'` → 错误/加载/空态/焦点卡 + 历史折叠（按工作区分组，第 1309-1329 行）；渲染构建期异常就地显形 `Panel error: …` 避免整块白屏（第 1332-1336 行）。

### 面板图标 PanelIcon(props)（第 1339-1350 行）

- SVG 摊开的书本（wiki 页），默认 16×16、stroke currentColor，接受 `props.size`（第 1340 行）。

### 数据模型（外部 API 与表单值对象）

- **设置命名空间 `codewiki` 值对象**（由 `form.getSnapshot().value` 提供，第 485 行；`save()` 差量键全集见第 672 行）：宿主 Config 服务持久化的插件配置，全部字段如下：
  - `enabled`（bool，默认 true）：启用插件；停用后 `cw` 与 `codewiki_generate` 工具立即报错。
  - `updateReminder`（bool，默认 true）：会话系统提示注入收尾提醒。
  - `autoCommit`（bool，默认 true）：编译完成由插件自动提交产物（只 add .codewiki/ 与 CodeWiki.md）。
  - `workspaceOnly`（bool，默认 true）：任务页只显示工作区任务。
  - `maxConcurrency`（number，1–8，默认 2）：编译并发上限。
  - `serialProjects`（bool，默认 true）：单项目串行。
  - `articleLanguage`（string）：文章语言（如「中文」）。
  - `binaryPath`（string）：cw 可执行路径，空=优先 PATH。
  - `batchProvider`（string）：编译模型提供商 id。
  - `batchModel`（string）：编译模型 id。
  - `batchReasoningEffort`（string|null）：编译模型思考档位（来自目录）。
  - `bigProvider`（string|null，空=关闭大档）：大档提供商 id。
  - `bigModel`（string）：大档模型 id。
  - `bigReasoningEffort`（string|null）：大档思考档位。
  - `bigTokenBudget`（string|number，默认 420000）：大档输入预算。
  - `sessionTier`（string）：兜底档位（dsh-subagent-auto-router 档位 id）。
  - `excludePaths`（string，多行/分号/逗号分隔绝对路径）：排除清单。
  - `autoUpdate`（bool，默认 false）：自动更新开关。
  - `autoUpdateMin`（number，最小 5，默认 30）：扫描间隔分钟。

- **任务对象 job**（`GET /api/codewiki/jobs` 返回数组元素，被 `jobCard` 消费，第 1231-1289 行）：编译任务运行态。字段包括：`id`、`cwd`、`kind`（`full`/`stale`/`resume`）、`stage`（见 ACTIVE_STAGES 及终态 `done`/`failed`/`cancelled`）、`createdAt`（ISO，第 1242 行引用）、`updatedAt`（ISO，第 1226 行）、`finishedAt`（ISO，终态时间戳，第 1243 行）、`articles`（数组，元素含 `ok` 布尔，第 1233 行）、`writtenCount`（number，第 1239 行）、`failedCount`（number，第 1240 行）、`taskList`（数组，元素 `{name, state}`，第 1235 行）、`batchProgress`（`{completed, total}`，第 1241 行）、`batchSubmittedAt`（ISO 时间戳，第 958 行）、`tps`（number，实时通道吞吐，第 953 行）、`usage`（`{inputTok, outputTok, requests, batchRequests, realtimeRequests, overTier2}`，第 974 行）、`notes`（字符串数组，活动流，第 1264 行）、`error`（string，第 1272 行）、`wikiPath`（string，第 1279 行）、`stageTimings`（对象，阶段名→耗时 ms，第 912 行）、`stageStartedAt`（ISO，当前阶段开始，第 925 行）、`cancelRequested`（bool，第 1256 行）、`auto`（bool，自动调度触发，于 ReposTab 第 1118 行消费）。

- **仓库对象与调度对象**（`GET /api/codewiki/repos` 返回，被 `ReposTab` 消费，第 1055-1131 行）：`repos` 数组元素含 `cwd`、`state`（`missing`/`uncompiled`/`clean`/`stale`/`error`）、`excluded`（bool）、`lastJob`（任务对象快照）、`staleArticles`（number）、`changedFiles`（number）、`articleCount`（number）；`scheduler` 对象含 `enabled`、`intervalMin`、`scanning`、`lastScan`（ISO）、`lastError`、`lastScanRepos`（number）、`lastScanSubmitted`（number）。

## Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│      client.js — @local/dsh-codewiki（加载入口 10-12 行）      │
│  apply(ctx)（412）：注册 zh/en 词典（413-414）· 注入 slots（420-446）│
└───────┬───────────────────────────────┬───────────────────────┘
        ▼ plugins.item（order 30）      ▼ main + sidebar.panellist
┌───────────────────────────┐  ┌──────────────────────────────┐
│ CodewikiCard（452-851）   │  │ CodewikiPanel（1137-1337）   │
│ ├ 目录 MODELS_PATH 464-475│  │ ├ ReposTab 总览（992-1135）  │
│ ├ 档位 EFFORTS_PATH 524   │  │ ├ 任务 jobCard（1231-1289）  │
│ └ 保存 form.mutate 663-685│  │ └ 设置 tab ↘ CodewikiCard    │
└─────────────┬─────────────┘  └───────────────┬──────────────┘
              ▼                                ▼
┌───────────────────────────────────────────────────────────────┐
│ apiGet/apiPost（393-408）→ 宿主 webServer /api/codewiki/*      │
│ jobs（2s 轮询）· repos（10s 轮询）· models · model-efforts      │
│ control（POST：cancel/compile/refresh，仅回环）                │
└───────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **初始化**：`window.__ModuleLoader__.load`（第 10 行）→ `factory` 建样式表（第 307-387 行，HMR 去重 386-387）→ `apply(ctx)`（第 412 行）：`tBound`（第 413 行）、词典注册（第 414 行）、取 `form`（第 417 行）、`whileServed` 守卫下挂 `plugins.item`（第 420-432 行）、`ctx.effect` 挂双 slot 挂载面板并返回 disposers 清理（第 435-446 行）。
2. **配置读写**：`CodewikiCard` 经 `form.getSnapshot()` + `form.subscribe` 同步宿主值到草稿（第 478-495 行，revision 门控防止覆盖编辑中的草稿）；保存 `save()` 差量 ops → `form.mutate(ops, snapshot.revision)`（第 663-685 行），revision 过期提示冲突重试；总览页 `toggleExclude` 也走同一条 `form.mutate` 链路（第 1022-1040 行）。
3. **任务流（2s 轮询）**：`apiGet(JOBS_PATH)`（第 1150-1190 行）→ `setJobs`；面板侧差分采样：tps → sparkRef 滚动窗口（≤30 点），batchProgress.completed → EWMA 速率（0.6/0.4）；`jobCard` 渲染步骤条/吞吐徽标/进度/用量/活动流；`cancel` 经 `apiPost(CONTROL_PATH)`（第 1195-1203 行）。
4. **仓库流（10s 轮询）**：`apiGet(REPOS_PATH)`（第 1001-1017 行）→ 调度卡 + 仓库状态列表；stale 仓库可 `compile`（第 1042-1050 行）、可 `toggleExclude`（第 1022-1040 行，写配置后 POST refresh 失效服务端缓存再重拉）。
5. **模型目录/档位流**：设置卡挂载拉 `MODELS_PATH`（第 464-475 行）；provider 变更联动清空模型与档位（第 579-586 行）；provider/model 齐备时拉 `EFFORTS_PATH`（第 533-554 行）；目录不可用逐级退化为手填，不阻断保存。

## Connections

- [[core-logic]]：本模块消费的 `/api/codewiki/jobs|control|repos|models|model-efforts` 端点由宿主半侧服务提供（常量定义第 19-25 行）；任务对象字段（stage/taskList/batchProgress/usage/notes/stageTimings/tps 等，见数据模型小节）的语义在本模块被消费。
- [[configuration-management]]：设置读写链路——`configForms` 命名空间 `'codewiki'`（第 17、417 行）、`getSnapshot/subscribe/mutate` 用法（第 478-495、663-685、1022-1040 行）与设置键全集（第 672 行）。

## Known Issues

- （历史，已消除）早期版本 `save()` 校验曾引用字典中不存在的键，且手填预算项与模型目录档位下拉并存。当前 `batchReasoningEffort`/`bigReasoningEffort` 已完整取代为模型目录档位下拉（第 524-555、562-661 行），`save()` 仅校验 `maxConcurrency`（第 665-669 行），不再引用任何未定义键；`autoCommit` 等设置项已纳入保存键全集（第 672 行）。
- `ReposTab` 的状态→颜色映射（第 1089 行）把 `missing`/`uncompiled` 归入 `'cancelled'`，仓库卡片因此显示警告黄色；CSS 中为 `data-state="missing"`/`"uncompiled"` 定义的第三级灰（第 348 行）从仓库卡片永远命中不了——文本标签仍正确显示「未初始化/未编译」，仅颜色与设计意图不符。
- `sparkRef` 的 tps 窗口不随任务终态清理（仅 push/shift，第 1163-1166 行；对照 `batchRateRef` 在任务离开批量态时会删除，第 1177 行）：终态任务残留最后一窗数据，但因 `throughputBadge` 只在活动阶段渲染（第 952 行），目前无可见影响。