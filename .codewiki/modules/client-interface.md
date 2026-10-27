---
title: client-interface
type: module
source_files:
  - client.js
  - index.js
  - .codewiki/modules/core-and-config.md
tags: [client, react, api-wrapper, plugin-system, sidebar-panel, config-forms]
---

## Overview

`client-interface` 是 CodeWiki 插件的浏览器半侧（实现于仓库根 `client.js`，文件头标注 v0.4.1，第 1 行），经 `window.__ModuleLoader__.load` 由宿主插件系统加载，模块 id 为 `@local/dsh-codewiki`（第 10-11 行），`factory(require)` 内引入 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（解构 `Switch`/`Button`/`Input`/`Tag`，第 13-15 行）。它承担三类职责：

1. **插件设置页**：向宿主 `plugins.item` 槽位注入设置卡片 `CodewikiCard`（id = NS = `'codewiki'`，order 30，第 518-525 行），设置读写走宿主 `configForms` 服务命名空间 `'codewiki'`（第 17、515 行），热生效无需重启。
2. **侧边栏面板**：向 `main` 与 `sidebar.panellist` 两个槽位注册 `CodewikiPanel`/`PanelIcon`（第 533-544 行），面板内含「总览 / 任务 / 会话 / 设置」四个标签页（第 1645-1652 行），轮询宿主半侧 webServer 端点渲染编译任务进度、仓库总览与编译会话记录，并提供取消、编译、排除等控制操作。
3. **API 封装**：`apiGet`/`apiPost`（第 491-496 行、第 497-506 行）封装对 `GET /api/codewiki/jobs`（第 19 行）、`POST /api/codewiki/control`（第 20 行，仅回环）、`GET /api/codewiki/repos`（第 23 行）、`GET /api/codewiki/sessions`（第 24 行）、`GET /api/codewiki/sessions/item`（第 25 行）、`GET /api/codewiki/models`（第 26 行）、`GET /api/codewiki/model-efforts`（第 27 行）的访问。

关键约定（文件头注释，第 2-8 行）：两个挂载点分别为「插件」页设置表单与侧边栏面板（数据来自 `GET /api/codewiki/jobs`、`POST /api/codewiki/control`）；面板 key 与 `sidebar.panellist` 的 id 必须同为 `KEY`（第 18 行）；设置 id 必须等于 package.json 的 `name`（client-modules 按 nearestPackage 的 name 校验注册者）；locale 词典值必须是字符串——词典值若为函数，`t()` 会回退返回键名。

当前代码中活跃阶段常量 `ACTIVE_STAGES` 为 `['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']`（第 33 行），包含终态前的 `commit` 阶段，并配合 `STAGE_WEIGHTS`（第 1129 行）计算总体进度。通用思考档位 `GENERIC_EFFORTS` 为 `['off', 'low', 'medium', 'high', 'xhigh', 'max']`（第 30 行），用于模型目录未声明档位时的手填回退。

## Key Components

### 常量与配置（client.js 17-33）

- `NS = 'codewiki'`（第 17 行）：插件命名空间 = profile patch 条目 id = 设置命名空间。
- `KEY = 'codewiki'`（第 18 行）：面板 key；`sidebar.panellist` 的 id 必须与它一致。
- `JOBS_PATH = '/api/codewiki/jobs'`（第 19 行）：编译任务列表端点。
- `CONTROL_PATH = '/api/codewiki/control'`（第 20 行）：控制端点（cancel/compile/refresh，仅回环）。
- `PANEL_ORDER = 52`（第 21 行）：面板排序，排在 dsh-hindsight-on-demand（50）之后。
- `POLL_MS = 2000`（第 22 行）：任务列表轮询间隔。
- `REPOS_PATH = '/api/codewiki/repos'`（第 23 行）：仓库状态与调度信息端点。
- `SESSIONS_PATH = '/api/codewiki/sessions'`（第 24 行）：编译会话列表端点（全局聚合时不带 jobId）。
- `SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'`（第 25 行）：编译会话单项详情端点。
- `MODELS_PATH = '/api/codewiki/models'`（第 26 行）：模型目录端点。
- `EFFORTS_PATH = '/api/codewiki/model-efforts'`（第 27 行）：模型思考档位端点（按 provider+model 查询）。
- `GENERIC_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']`（第 30 行）：目录未声明 efforts 的模型在设置页展示的通用思考档位；选了模型不支持的值由 llmChat 兜底剥档重试，不会失败。
- `REPOS_POLL_MS = 10000`（第 31 行）：仓库列表轮询间隔。
- `ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']`（第 33 行）：活跃阶段列表（queued 单列最前——单项目串行时后提交的项目在此等待，第 32 行注释）；用于步骤条、总体进度与焦点判断。终态阶段（`done`/`failed`/`cancelled`/`partial`，均不在该数组内）由 `lastTimedStage`/`overallPct`/`stageBar` 单独处理（`partial` 表示「写成了部分文章但有变化没被消化」，仍是终态，见数据模型小节）。

### 词典与国际化（client.js 35-210、211-386）

- `zh()`（第 35-210 行）：中文字字典，覆盖标题/简介、设置项与提示（title/summary/intro/secRun/enabled/updateReminder/autoCommit/workspaceOnly/maxConcurrency/bigConcurrency/serialProjects/parallelProjects/secCompile/batchProvider/batchModel/batchReasoningEffort*/secBig/bigProvider/bigModel/bigReasoningEffort*/bigTokenBudget/sessionTier/articleLanguage/binaryPath/panelTitle/stage*/state*/kind*/autoUpdate*/excludePaths*/sched*/tab*/sess*/secPipeline/planMode*/agenticArticles*/symbolIncremental* 等）。
- `en()`（第 211-386 行）：英文字字典，键集与 `zh()` 一致。
- 注册：`apply` 内 `const tBound = ctx.locale.bind(NS)`（第 511 行）与 `ctx.effect(() => ctx.locale.register(NS, { zh: zh(), en: en() }), 'dscw: dictionaries')`（第 512 行）。

### 样式注入（client.js 388-483）

- `style` 元素（第 388-483 行）：`style.dataset.plugin = '@local/dsh-codewiki'`（第 389 行）；CSS 按两组属性选择器组织——设置页 `data-dscw-*`（第 389-399 行）与侧栏面板 `data-dscw-p-*`（第 400-480 行），含六阶段步骤条（第 440-453 行）、吞吐徽标（第 454-457 行）与用量/错误/活动流（第 458-465 行）样式。
- HMR 防重（第 485 行）：`document.head` 已存在同名 `style[data-plugin="@local/dsh-codewiki"]` 时不再追加，避免重复加载堆叠样式表。

### API 封装与 DOM 助手（client.js 487-506）

- `el(tag, props, ...children)`（第 487-489 行）：`React.createElement` 包装。
- `apiGet(p)`（第 491-496 行）：GET + `accept: application/json`；非 2xx 抛 `body.error || HTTP {status}`。
- `apiPost(p, data)`（第 497-506 行）：POST `application/json` body；错误处理同 `apiGet`。

### 模块入口 apply(ctx)（client.js 508-544）

- 入口声明：`return { inject: ['slots', 'locale', 'configForms'], apply(ctx) { ... } }`（第 508-510 行），`apply(ctx)` 方法体从第 510 行起（其内部定义各组件，如 `CodewikiCard` 等位于后续行；本段描述的入口声明与槽位挂载逻辑位于 508-544 行）。
- 词典注册（第 511-512 行）；`form = ctx.configForms.get(NS)`（第 515 行）。
- `plugins.item` 挂载（第 518-525 行）：`mount` 注册 `{ name: 'plugins.item', id: NS, order: 30, label, locale: NS, inject: () => ({ t: tBound }) }` + `CodewikiCard`（第 518-525 行）；宿主提供 `ctx.configForms.whileServed` 时仅在该命名空间被服务期间挂载（插件停用/未加载则插件页不显形，第 526-527 行），否则直接挂载（第 529 行）。
- 侧边栏面板挂载（第 533-544 行）：`ctx.effect` 内同时注入 `main`（`{ name: 'main', key: KEY }` + `CodewikiPanel`，第 535 行）与 `sidebar.panellist`（`{ id: KEY, order: PANEL_ORDER, label }` + `PanelIcon`，第 536-539 行），effect 返回 disposers 逐个清理（第 543 行）。

### 设置卡片 CodewikiCard(props)（client.js 550-1038）

- 状态：`snapshot`/`draft`/`notice`/`error`（第 553-556 行），模型目录 `catalog`/`catalogError`（第 559-560 行）。
- 模型目录拉取 `useEffect`（第 562-573 行）：挂载时 `apiGet(MODELS_PATH)`；`data?.ok === false` 或异常时置 `catalogError`，设置页退回「手填」形态，不阻断保存。
- 配置快照订阅 `useEffect`（第 576-593 行）：`pull` 读 `form.getSnapshot()` 并 `setSnapshot`；仅当 `snap.status === 'ready'` 且 `revision` 变化时 `setDraft(structuredClone(snap.value))`（第 583-588 行，宿主值变更含保存成功后的回收读才覆盖草稿）；`form.subscribe(pull)` 订阅（第 591 行）。
- 摘要视图（第 596 行）：`props?.view === 'summary'` 时只返回一行简介（插件页列表项）。
- `setPath(key, value)`（第 598-605 行）：不可变更新 draft。
- `dirty` memo（第 607-610 行）：JSON 比较草稿与快照。
- `selectedProvider` memo（第 613-617 行）：从 catalog 匹配 `draft.batchProvider`，未命中为 null（手填形态）。
- 思考档位 `useEfforts`（第 622-653 行）：返回 `{ for, efforts, defaultEffort, error, loading }`；`useEffect` 依赖 `[p, m]`（第 626-651 行），二者齐备时按 `${EFFORTS_PATH}?provider=…&model=…`（第 631 行）拉取档位清单（来自模型目录，不手填裸字符串），失败或为空时 UI 各有提示与回退。`effortsState`/`bigEffortsState` 调用（第 654-655 行）。
- `modelTrio({ pKey, mKey, eKey, state, allowEmptyProvider, providerPlaceholder })`（第 660-764 行）：渲染一个模型的三个字段（提供商/模型/思考程度），普通档与大档共用；换提供商时联动清空模型与档位（第 677-684 行），已配置但目录缺失的 provider 保留 `__custom` 选项防静默丢失（第 689-691 行），catalogError 时退化为 Input（第 669-673 行）。
- `save()`（第 766-805 行）：校验 `maxConcurrency` 并发上限为 1-8 整数（第 768-772 行）；校验 `bigConcurrency` 0 或 1-8 整数（第 774-778 行）；校验 `agenticMaxSteps` 1-100 整数（第 780-784 行）；校验 `planMode` 白名单（第 786-789 行）；对 `['enabled', 'binaryPath', 'maxConcurrency', 'bigConcurrency', 'serialProjects', 'parallelProjects', 'articleLanguage', 'updateReminder', 'autoCommit', 'workspaceOnly', 'batchProvider', 'batchModel', 'batchReasoningEffort', 'bigProvider', 'bigModel', 'bigReasoningEffort', 'bigTokenBudget', 'sessionTier', 'excludePaths', 'autoUpdate', 'autoUpdateMin', 'planMode', 'agenticArticles', 'agenticMaxSteps', 'symbolIncremental']` 逐键 JSON 差分构建 ops（第 792 行）；`form.mutate(ops, snapshot.revision)` 提交（第 799 行），接受与否分别提示 saved/conflict（第 800 行）。
- `discard()`（第 807-811 行）：草稿重置为快照并清空提示。
- 加载/不可用态渲染（第 813-815 行）。
- 渲染（第 817-1037 行）：
  - `secRun` 运行区（第 820-913 行）：`enabled` 开关（第 823-830 行）、`updateReminder` wiki 维护提醒开关（第 832-839 行）、`autoCommit` 自动提交编译产物开关（第 841-848 行）、`workspaceOnly` 只显示工作区任务开关（第 850-857 行）、`maxConcurrency` 并发上限输入（第 859-866 行）、`bigConcurrency` 大档并发上限输入（第 868-877 行）、`serialProjects` 单项目串行开关（第 878-885 行）、`parallelProjects` 并行项目上限输入（第 887-896 行）、`articleLanguage` 文章语言输入（第 897-902 行）、`binaryPath` cw 可执行路径输入（第 903-911 行）。
  - `secCompile` 编译模型区（第 915-930 行，唯一通道：模型设置里已注册的 provider/model）：调用 `modelTrio` 渲染 `batchProvider`/`batchModel`/`batchReasoningEffort`（第 919 行），以及 `sessionTier` 兜底档位手填（第 920-927 行）。
  - `secBig` 大档模型区（第 932-947 行）：调用 `modelTrio` 渲染 `bigProvider`(allowEmptyProvider=true)/`bigModel`/`bigReasoningEffort`（第 936 行），以及 `bigTokenBudget` 输入（第 937-945 行）。
  - `secPipeline` 编译流程区（第 949-994 行，吸收自 FSoft CodeWiki）：`planMode` 语义聚类/目录分组选择（第 953-963 行）、`agenticArticles` agentic 写作开关（第 965-972 行）、`agenticMaxSteps` 步数上限输入（第 974-983 行）、`symbolIncremental` 符号级增量开关（第 984-993 行）。
  - `secSchedule` 调度与排除区（第 996-1028 行）：`autoUpdate` 自动更新开关（第 999-1007 行）、`autoUpdateMin` 扫描间隔分钟输入（第 1008-1016 行）、`excludePaths` 排除清单多行文本域（换行/分号/逗号分隔绝对路径，第 1017-1026 行）。
  - 保存条（第 1030-1036 行）：放弃/保存按钮按 `dirty`/`snapshot.writable` 禁用；error 红字或干净态 notice Tag。

### 面板辅助函数与小组件（client.js 1044-1181）

- `stageLabel(stage)`（第 1044 行）/`stateLabel(st)`（第 1045 行）/`kindLabelOf(t, kind)`（第 1046 行）：拼接 `stage*`/`state*`/`kind*` 键取翻译。
- `progressBar(done, total)`（第 1047-1050 行）：total>0 时渲染 `data-dscw-p-bar` 进度条（宽度取完成比）。
- `repoName(cwd)`（第 1051-1054 行）：取路径末两段「父目录/目录名」，Temp 沙箱残留一眼可辨。
- `fmtMs(ms)`（第 1055-1061 行）：`HH:MM:SS`/`MM:SS`；`fmtTok(n)`（第 1062-1067 行）：token 数 k/M 缩写；`fmtDur(ms)`（第 1068-1073 行）：`X min`/`X h Y min`；`fmtAgo(iso)`（第 1074-1077 行）：相对时间 + agoSuffix。
- `Spark({ values, width = 56, height = 16 })`（第 1079-1091 行）：纯 SVG path 微趋势线，过滤非正数，少于 2 点返回 null。
- `stepName(s)`（第 1095 行）；`lastTimedStage(job)`（第 1098-1101 行）：返回 `stageTimings` 中最后一个属于 ACTIVE_STAGES 的键。
- `stageBar(job)`（第 1102-1127 行）：七阶段（含 queued 与 commit）步骤条——已完成绿点（title 带各阶段耗时）、当前阶段实心点 + 实时计时（第 1115 行）、失败/取消在最后计时段标红/黄（failIdx 逻辑第 1108 行，标记第 1121-1122 行）；`partial` 与 `done` 一样视作「所有阶段都跑过」而全绿（第 1107 行 `cleanEnd`），只有 `failed`/`cancelled` 才在末尾标红/黄。
- `STAGE_WEIGHTS = { queued: 0, articles: 0.63, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05, commit: 0.02 }`（第 1129 行）：各阶段在总体进度中的定权，供 `overallPct` 使用。
- `overallPct(job)`（第 1130-1140 行）：按 `STAGE_WEIGHTS` 累计已完成阶段权重，阶段内按 `taskList` 完成数折算（第 1138 行）；终态时 `done` 或 `partial` 均显示 100（第 1134 行，活干完了，由终态标签区分是否完整），非 done/partial 的终态（failed/cancelled）返回 null（不显示进度条）；活动阶段封顶 99（第 1139 行）。
- `throughputBadge(job, sparkOf, rateOf)`（第 1143-1163 行）：非活动阶段返回 null（第 1144 行）；`job.tps > 0` 时显示 tok/s + Spark（实时通道，第 1146-1148 行）；否则批量通道按 `rateOf` 速率与 `batchProgress` 显示 篇/分 + ETA（第 1150-1158 行），无完成样本时显示自 `batchSubmittedAt` 起的执行时长（第 1159-1161 行）。
- `usageLine(job)`（第 1165-1181 行）：输入（提交时估算）/输出（响应实测）token（第 1168-1171 行）、请求数（批量/实时拆分，第 1172-1177 行）；`u.overTier2` 个超单请求预算（按大档装填）请求数红字提示（第 1180 行）。

### 总览标签页 ReposTab()（client.js 1184-1328）

- 状态：`data`/`err`/`busyCwd`/`mountedRef`（第 1186-1190 行）、`inFlightRef`（第 1192 行，防重叠拉取第 1193-1204 行）、`exclBusy`（第 1213 行）。
- `pull()`（第 1193-1204 行）：`apiGet(REPOS_PATH)`；`useEffect` 首拉 + `setInterval(pull, REPOS_POLL_MS)`（第 1205-1209 行）。
- `toggleExclude`（第 1214-1232 行）：读 form 快照并校验可写（第 1215-1216 行）；`excludePaths` 按换行/分号/全半角逗号拆分（第 1220 行），路径归一化（去尾斜杠 + 小写，第 1219 行）判断已排除与否，增删后 `form.mutate` 写回（第 1223 行，与设置卡保存同链路经宿主 configForms 持久化热生效）；成功后 POST `control {action:'refresh'}` 失效服务端总览缓存并立即重拉（第 1225 行）。
- `compile(cwd)`（第 1234-1242 行）：POST `control {action:'compile', cwd}` 触发单仓库编译。
- 渲染（第 1247-1327 行）：调度卡（开/关、间隔、上次扫描/上次错误，第 1249-1276 行）；启用且有扫描记录时推算下次扫描时间与剩余时长、显示扫描/提交统计（第 1260-1274 行）；仓库列表（第 1278-1323 行）——名称、排除标签、状态色映射（clean→done / stale→stale / error→failed / 其余→cancelled，第 1281 行）、stale 时的「更新」按钮（第 1287-1292 行）、排除/取消排除按钮（第 1293-1298 行）、变更文件数/文章数/最近任务元信息与进度条（第 1299-1320 行）；空态 reposEmpty（第 1323 行）；渲染异常就地显形 `Repos error: …`（第 1325-1327 行）。

### 会话视图 SessionView({ job, onClose })（client.js 1334-1424）

- 状态：`list`/`err`/`sel`/`item`（第 1337-1340 行）。
- 列表轮询 `useEffect`（第 1341-1359 行）：每 5s `apiGet(global ? SESSIONS_PATH : SESSIONS_PATH?jobId=)` 拉取会话数组（第 1348 行，global = job 为空走聚合接口）。
- 单项详情 `useEffect`（第 1360-1367 行）：`sel` 变更时 `apiGet(SESSIONS_ITEM_PATH?jobId=&n=)` 拉取 prompt/output（第 1363 行）。
- 渲染（第 1370-1423 行）：标题与关闭/返回按钮（第 1371-1375 行）、任务 id 或全局提示（第 1376-1378 行）、列表态（第 1406-1422 行）显示每个请求 n、名称、状态标记、模型、输出字符数、输入 token、开始时间、全局态还带任务 id 与仓库名；选中态（第 1380-1399 行）显示 meta 与 prompt/pre/输出 pre；空态 sessEmpty（第 1405 行）。

### 主面板 CodewikiPanel()（client.js 1426-1686）

- 状态：`jobs`（null = 尚未拿到首轮，第 1428 行）、`err`（第 1429 行）、`busyId`（第 1430 行）、`tab`（默认 'overview'，第 1431 行）、`sessJob`（第 1432 行，单任务会话视图）、`copiedPath`（第 1436 行）；`sparkRef`（jobId→tps 滚动窗口 Map，第 1438 行）、`batchRateRef`（jobId→{at, completed, rate} Map，第 1439 行）、`sparkOf`/`rateOf`（第 1440-1441 行）；`mountedRef`（第 1486-1487 行，卸载后不再 setState）。
- 轮询 `useEffect`（第 1443-1483 行）：每 `POLL_MS` 拉取 `JOBS_PATH`（inFlight 防重叠，第 1445-1447 行）；对每个 job 把 `j.tps` 推入 sparkRef 窗口（超 30 点 shift，第 1454-1459 行）；`batchProgress.completed` 差分计算瞬时速率（篇/分）并按 `prev.rate*0.6 + inst*0.4` EWMA 平滑（第 1462-1469 行）；任务离开批量态时从 batchRateRef 删除（第 1470 行）。
- `cancel(jobId)`（第 1488-1496 行）：POST `control {action:'cancel', jobId}`。
- `copyPath(p)`（第 1497-1503 行）：剪贴板写入 wiki 路径，1.5s 后清除「已复制」态；权限拒绝时静默。
- `kindLabel`（第 1505 行）；`isActive(job)`（第 1507 行）：stage ∈ ACTIVE_STAGES。
- 分组（第 1510-1516 行）：按 cwd 分组、保持首次出现顺序、组内 unshift 最新在前（服务历史折叠区）。
- 焦点任务（第 1518-1522 行）：活动任务按 updatedAt 取最新，无活动取最近更新任务；其余收进「历史任务」折叠区。
- `jobCard(job)`（第 1524-1632 行）：kind Tag、阶段文本（data-state 着色，第 1581-1585 行）、吞吐徽标（第 1585 行）、会话按钮（第 1586-1589 行）、取消按钮（`cancelRequested` 时禁用并显示「取消中…」，第 1590-1595 行）、`stageBar`（第 1598 行）、meta 行（已写/失败/批次/已用时或总耗时，第 1530-1555 行）、排队可见性 queueAhead（第 1601-1604 行）、总进度条（仅活动任务，第 1605 行）、`usageLine`（第 1606 行）、最新一条 note + 活动流 details（第 1607-1614 行）、error 行（第 1615 行）、活动任务的任务清单 ✓/✗/· 列表（第 1616-1621 行）、wiki 路径与复制按钮（第 1622-1630 行）、自动提交结果展示（第 1559-1568 行）。
- 渲染（第 1634-1685 行）：标题 + 进行中计数（第 1639-1644 行）；四标签按钮 overview/tasks/sessions/settings（第 1645-1652 行）；`tab === 'overview'` → ReposTab（第 1653 行）、`tab === 'sessions'` → 全局 SessionView（job=null，第 1655 行）、`tab === 'settings'` → 内嵌 CodewikiCard（第 1656 行）、`tab === 'tasks'` → 错误/加载/空态/焦点卡 + 历史折叠（按工作区分组，第 1657-1678 行）；渲染构建期异常就地显形 `Panel error: …` 避免整块白屏（第 1681-1685 行）。

### 面板图标 PanelIcon(props)（client.js 1688-1699）

- SVG 摊开的书本（wiki 页），默认 16×16、stroke currentColor，接受 `props.size`（第 1689 行）。

### 数据模型（外部 API 与表单值对象）

- **设置命名空间 `codewiki` 值对象**（由 `form.getSnapshot().value` 提供，第 553 行；`save()` 差量键全集见第 792 行）：宿主 Config 服务持久化的插件配置，全部字段如下：
  - `enabled`（bool，默认 true）：启用插件；停用后 `cw` 与 `codewiki_generate` 工具立即报错（第 826 行读取 `!== false`，词典第 40 行）。
  - `updateReminder`（bool，默认 true）：会话系统提示注入收尾提醒（第 835 行读取 `!== false`，词典第 42 行）。
  - `autoCommit`（bool，默认 true）：编译完成由插件自动提交产物（第 844 行读取 `!== false`，词典第 44 行）。
  - `workspaceOnly`（bool，默认 true）：任务页只显示工作区任务（第 853 行读取 `!== false`，词典第 46 行）。
  - `maxConcurrency`（number，1–8，默认 2）：默认档并发上限（第 862 行 `String(draft.maxConcurrency ?? 2)`，词典第 48 行）。
  - `bigConcurrency`（number，0–8，默认 0=跟随默认档）：大档并发上限（第 872 行 `?? 0`，词典第 50 行）。
  - `serialProjects`（bool，默认 true）：单项目串行（第 881 行读取 `!== false`，词典第 52 行）。
  - `parallelProjects`（number，1–4，默认 2）：并行项目上限，关闭单项目串行后生效（第 893 行 `Math.max(1, Math.min(4, Number(e.target.value) || 2))`，词典第 54 行）。
  - `articleLanguage`（string）：文章语言（如「中文」）（第 899-901 行）。
  - `binaryPath`（string）：cw 可执行路径，空=优先 PATH（第 905-908 行）。
  - `batchProvider`（string）：编译模型提供商 id（第 919 行）。
  - `batchModel`（string）：编译模型 id（第 919 行）。
  - `batchReasoningEffort`（string|null）：编译模型思考档位（来自目录）（第 919 行）。
  - `bigProvider`（string|null，空=关闭大档）：大档提供商 id（第 936 行）。
  - `bigModel`（string）：大档模型 id（第 936 行）。
  - `bigReasoningEffort`（string|null）：大档思考档位（第 936 行）。
  - `bigTokenBudget`（string|number，默认 420000）：大档输入预算（第 941 行，词典第 109 行）。
  - `sessionTier`（string）：兜底档位（dsh-subagent-auto-router 档位 id）（第 923-925 行）。
  - `excludePaths`（string，多行/分号/逗号分隔绝对路径）：排除清单（第 1021 行）。
  - `autoUpdate`（bool，默认 false）：自动更新开关（第 1002 行读取 `=== true`，词典第 179 行）。
  - `autoUpdateMin`（number，最小 5，默认 30）：扫描间隔分钟（第 1011 行 `String(draft.autoUpdateMin ?? 30)`，词典第 181 行）。
  - `planMode`（enum 'auto'|'dirs'，默认 'auto'）：模块划分方式（第 957 行）。
  - `agenticArticles`（bool，默认 true）：agentic 写作开关（第 967 行读取 `!== false`）。
  - `agenticMaxSteps`（number，1–100，默认 30）：agentic 单篇步数上限（第 979 行）。
  - `symbolIncremental`（bool，默认 true）：符号级增量开关（第 987 行读取 `!== false`）。

- **任务对象 job**（`GET /api/codewiki/jobs` 返回数组元素，被 `jobCard` 消费，第 1524-1632 行）：编译任务运行态。字段包括：
  - `id`（string，第 1578 行引用）：任务唯一标识。
  - `cwd`（string，第 1513 行分组用）：仓库工作区路径。
  - `kind`（`full`/`stale`/`resume`，第 1580 行）：编译类型。
  - `stage`（string，见 ACTIVE_STAGES 及终态 `done`/`failed`/`cancelled`/`partial`，第 1582 行）：当前阶段。`partial` 是终态（写成了部分文章但有变化没被消化），不推进基线，但允许产物入库。
  - `createdAt`（ISO 时间戳，第 1543-1555 行引用）：任务创建时间。
  - `updatedAt`（ISO 时间戳，第 1519 行）：任务更新时间。
  - `finishedAt`（ISO 时间戳，终态时间戳，第 1552-1554 行）：任务结束时间。
  - `articles`（数组，元素含 `ok` 布尔，第 1526 行）：文章结果列表。
  - `writtenCount`（number，第 1532 行）：已写文章数（无 taskList 时）。
  - `failedCount`（number，第 1533 行）：失败文章数。
  - `taskList`（数组，元素 `{name, state}`，第 1528 行）：阶段内任务清单。
  - `batchProgress`（`{completed, total}`，第 1540 行）：批量进度。
  - `batchSubmittedAt`（ISO 时间戳，第 1150 行）：批量提交时间。
  - `tps`（number，实时通道吞吐，第 1145 行）：实时 tokens/s。
  - `usage`（`{inputTok, outputTok, requests, batchRequests, realtimeRequests, overTier2}`，第 1166 行）：用量统计。
  - `notes`（字符串数组，活动流，第 1607 行）：动态提示信息。
  - `error`（string，第 1615 行）：错误信息。
  - `wikiPath`（string，第 1622 行）：wiki 入口路径。
  - `stageTimings`（对象，阶段名→耗时 ms，第 1098-1101 行）：各阶段计时。
  - `stageStartedAt`（ISO，当前阶段开始，第 1115 行）：阶段起始时间。
  - `cancelRequested`（bool，第 1594 行）：取消请求已发。
  - `blockers`（数组，元素 `{kind, detail}`，第 1536 行引用）：终态 `partial` 时未消化变化的阻塞原因清单；任务行展示「未消化 N 项」（第 1537-1539、1573-1576 行），前 3 条并入任务行 title 悬停查看。
  - `autoCommit`（对象，含 `committed`/`sha`/`noChanges`/`reason`/`branch`，第 1559-1568 行）：自动提交结果。
  - `auto`（bool，自动调度触发，于 ReposTab 第 1311 行消费）：是否自动更新任务。
  - `queueAhead`（string 数组，第 1601 行）：排队时前方任务标识。

- **仓库对象与调度对象**（`GET /api/codewiki/repos` 返回，被 `ReposTab` 消费，第 1247-1327 行）：
  - `repos` 数组元素含 `cwd`（第 1284 行）、`state`（`missing`/`uncompiled`/`clean`/`stale`/`error`，第 1281 行）、`excluded`（bool，第 1285 行）、`lastJob`（任务对象快照，第 1300 行）、`staleArticles`（number，第 1308 行）、`changedFiles`（number，第 1308 行）、`articleCount`（number，第 1309 行）。
  - `scheduler` 对象含 `enabled`（第 1252 行）、`intervalMin`（第 1253 行）、`scanning`（第 1254 行）、`lastScan`（ISO，第 1257 行）、`lastError`（第 1258 行）、`lastScanRepos`（number，第 1265 行）、`lastScanSubmitted`（number，第 1266 行）。

- **会话对象 session**（`GET /api/codewiki/sessions` 返回，被 `SessionView` 消费，第 1406-1422 行）：元素含 `n`（请求序号）、`name`、`model`、`status`（`running`/`done`/`error`）、`startedAt`、`outputChars`、`inputTokens`、`cwd`、`jobId`；单项详情含 `prompt`、`output`、`error`（第 1389-1397 行）。

## Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│      client.js — @local/dsh-codewiki（加载入口 10-11）         │
│  apply(ctx)（508-1700）：注册 zh/en 词典（511-512）· 注入 slots（518-544）│
└───────┬───────────────────────────────┬───────────────────────┘
        ▼ plugins.item（order 30）      ▼ main + sidebar.panellist
┌───────────────────────────┐  ┌──────────────────────────────┐
│ CodewikiCard（550-1038）    │  │ CodewikiPanel（1426-1686）    │
│ ├ 目录 MODELS_PATH 562-573 │  │ ├ ReposTab 总览（1184-1328）  │
│ ├ 档位 EFFORTS_PATH 622    │  │ ├ SessionView（1334-1424）   │
│ └ 保存 form.mutate 766-805 │  │ └ 设置 tab ↘ CodewikiCard    │
└─────────────┬─────────────┘  └───────────────┬──────────────┘
               ▼                                ▼
┌───────────────────────────────────────────────────────────────┐
│ apiGet/apiPost（491-506）→ 宿主 webServer /api/codewiki/*      │
│ jobs（2s 轮询 1443-1483）· repos（10s 轮询 1193-1209）        │
│ models · model-efforts · sessions（5s 轮询 1341-1359）        │
│ control（POST：cancel/compile/refresh，仅回环 1488-1496）      │
└───────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **初始化**：`window.__ModuleLoader__.load`（第 10 行）→ `factory` 建样式表（第 388-483 行，HMR 去重第 485 行）→ `apply(ctx)`（第 510 行）：`tBound`（第 511 行）、词典注册（第 512 行）、取 `form`（第 515 行）、`whileServed` 守卫下挂 `plugins.item`（第 518-525 行）、`ctx.effect` 挂双 slot 挂载面板并返回 disposers 清理（第 533-544 行）。
2. **配置读写**：`CodewikiCard` 经 `form.getSnapshot()` + `form.subscribe` 同步宿主值到草稿（第 576-593 行，revision 门控防止覆盖编辑中的草稿）；保存 `save()` 差量 ops → `form.mutate(ops, snapshot.revision)`（第 766-805 行），revision 过期提示冲突重试；总览页 `toggleExclude` 也走同一条 `form.mutate` 链路（第 1214-1232 行）。
3. **任务流（2s 轮询）**：`apiGet(JOBS_PATH)`（第 1443-1483 行）→ `setJobs`；面板侧差分采样：tps → sparkRef 滚动窗口（≤30 点，第 1454-1459 行），batchProgress.completed → EWMA 速率（0.6/0.4，第 1462-1469 行）；`jobCard` 渲染步骤条/吞吐徽标/进度/用量/活动流；`cancel` 经 `apiPost(CONTROL_PATH)`（第 1488-1496 行）；会话视图 5s 轮询 `SESSIONS_PATH`（第 1341-1359 行）。
4. **仓库流（10s 轮询）**：`apiGet(REPOS_PATH)`（第 1193-1209 行）→ 调度卡 + 仓库状态列表；stale 仓库可 `compile`（第 1234-1242 行）、可 `toggleExclude`（第 1214-1232 行，写配置后 POST refresh 失效服务端缓存再重拉）。
5. **模型目录/档位流**：设置卡挂载拉 `MODELS_PATH`（第 562-573 行）；provider 变更联动清空模型与档位（第 677-684 行）；provider/model 齐备时拉 `EFFORTS_PATH`（第 631-651 行）；目录不可用逐级退化为手填，不阻断保存。

## Connections

- [[core-application]] / [[core-and-config]]：本模块消费的 `/api/codewiki/jobs|control|repos|models|model-efforts|sessions|sessions/item` 七个回环端点由宿主半侧 `installWebServer`（`index.js` 第 4327 行）注册，含 `GET /api/codewiki/jobs`（第 4368-4404 行）、`GET /api/codewiki/repos`（第 4408-4497 行）、`GET /api/codewiki/sessions`（第 4503-4524 行）、`GET /api/codewiki/sessions/item`（第 4525-4542 行）、`GET /api/codewiki/models`（第 4549-4564 行）、`GET /api/codewiki/model-efforts`（第 4568-4588 行）、`POST /api/codewiki/control`（第 4589-4620 行，支持 `cancel`/`refresh`/`compile`）；设置卡模型目录/档位的数据源分别是 `listModelCatalog`（`index.js` 第 4265 行）与 `resolveModelEfforts`（第 4303 行）。任务对象字段（stage/taskList/batchProgress/usage/notes/stageTimings/tps/blockers 等，见数据模型小节）的语义在此半侧被生产、在本模块被消费（`repos` 端点构造的 `lastJob` 快照第 4452-4458 行只暴露部分字段）。
- [[core-and-config]]：宿主半侧 `Config` schema（25 个 `.volatile()` 字段，`index.js` 第 70-96 行）与 `liveConfig` 规范化（第 102-144 行）才是设置的唯一权威定义；本模块的 `CodewikiCard` 仅是同一命名空间 `codewiki` 的可视编辑前端。
- [[configuration-and-metadata]]：设置键全集的语义、默认值与 volatile 热生效规则（对照本模块 `save()` 差量键全集第 792 行、模型目录不可用时的手填回退第 668-673 行）。

## Known Issues

- `ReposTab` 的状态→颜色映射（第 1281 行）把 `missing`/`uncompiled` 归入 `'cancelled'`，仓库卡片因此显示警告黄色；CSS 中为 `data-state="missing"`/`"uncompiled"` 定义的第三级灰（第 429 行）从仓库卡片永远命中不了——文本标签仍正确显示「未初始化/未编译」（词典第 159-160 行），仅颜色与设计意图不符。
- `sparkRef` 的 tps 窗口不随任务终态清理（仅 push/shift，第 1438-1459 行；对照 `batchRateRef` 在任务离开批量态时会删除，第 1470 行）：终态任务残留最后一窗数据，但因 `throughputBadge` 只在活动阶段渲染（第 1144 行），目前无可见影响。
