---
title: client-interface
type: module
source_files:
  - client.js
tags: [client, react, api-wrapper, plugin-system, sidebar-panel, config-forms]
---

## Overview

`client-interface` 是 CodeWiki 插件的前端半侧（实现于仓库根 `client.js`，文件头标注 v0.4.1，第 1 行），经 `window.__ModuleLoader__.load` 由宿主插件系统加载，模块 id 为 `@local/dsh-codewiki`（第 10-11 行），`factory(require)` 内引入 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（解构 `Switch`/`Button`/`Input`/`Tag`，第 13-15 行）。它承担三类职责：

1. **插件设置页**：向宿主 `plugins.item` 槽位注入设置卡片 `CodewikiCard`（id = NS = `'codewiki'`，order 30，第 475-487 行），设置读写走宿主 `configForms` 服务命名空间 `'codewiki'`（第 17、472 行），热生效无需重启。
2. **侧边栏面板**：向 `main` 与 `sidebar.panellist` 两个槽位注册 `CodewikiPanel`/`PanelIcon`（第 490-501 行），轮询宿主半侧 webServer 端点渲染编译任务进度、仓库总览（总览/任务/设置三个标签页）与编译会话记录，并提供取消、编译、排除等控制操作。
3. **API 封装**：`apiGet`/`apiPost`（第 449-464 行）封装对 `GET /api/codewiki/jobs`（第 19 行）、`POST /api/codewiki/control`（第 20 行，仅回环）、`GET /api/codewiki/repos`（第 23 行）、`GET /api/codewiki/sessions`（第 24 行）、`GET /api/codewiki/sessions/item`（第 25 行）、`GET /api/codewiki/models`（第 26 行）、`GET /api/codewiki/model-efforts`（第 27 行）的访问。

关键约定（文件头注释，第 2-8 行）：两个挂载点分别为「插件」页设置表单与侧边栏面板（数据来自 `GET /api/codewiki/jobs`、`POST /api/codewiki/control`）；面板 key 与 `sidebar.panellist` 的 id 必须同为 `KEY`（第 18 行）；设置 id 必须等于 package.json 的 `name`（client-modules 按 nearestPackage 的 name 校验注册者）；locale 词典值必须是字符串——词典值若为函数，`t()` 会回退返回键名。

当前代码中活跃阶段常量 `ACTIVE_STAGES` 为 `['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']`（第 33 行），包含终态前的 `commit` 阶段，并配合 `STAGE_WEIGHTS`（第 1010 行）计算总体进度。

## Key Components

### 常量与配置（client.js 17-33, 1010）

- `NS = 'codewiki'`（第 17 行）：插件命名空间 = profile patch 条目 id = 设置命名空间。
- `KEY = 'codewiki'`（第 18 行）：面板 key；`sidebar.panellist` 的 id 必须与它一致。
- `JOBS_PATH = '/api/codewiki/jobs'`（第 19 行）：编译任务列表端点。
- `CONTROL_PATH = '/api/codewiki/control'`（第 20 行）：控制端点（cancel/compile/refresh，仅回环）。
- `PANEL_ORDER = 52`（第 21 行）：面板排序，排在 dsh-hindsight-on-demand（50）之后。
- `POLL_MS = 2000`（第 22 行）：任务列表轮询间隔。
- `REPOS_PATH = '/api/codewiki/repos'`（第 23 行）：仓库状态与调度信息端点。
- `SESSIONS_PATH = '/api/codewiki/sessions'`（第 24 行）：编译会话列表端点。
- `SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'`（第 25 行）：编译会话单项详情端点。
- `MODELS_PATH = '/api/codewiki/models'`（第 26 行）：模型目录端点。
- `EFFORTS_PATH = '/api/codewiki/model-efforts'`（第 27 行）：模型思考档位端点（按 provider+model 查询）。
- `REPOS_POLL_MS = 10000`（第 31 行）：仓库列表轮询间隔。
- `ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']`（第 33 行）：活跃阶段列表（queued 单列最前——单项目串行时后提交的项目在此等待，第 32 行注释）；用于步骤条、总体进度与焦点判断。
- `STAGE_WEIGHTS = { queued: 0, articles: 0.63, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05, commit: 0.02 }`（第 1010 行，定义于面板辅助函数区）：各阶段在总体进度中的定权，供 `overallPct` 使用。

### 词典与国际化（client.js 35-344）

- `zh()`（第 35-189 行）：中文字字典，覆盖标题/简介、设置项与提示（title/summary/intro/secRun/enabled/updateReminder/autoCommit/workspaceOnly/maxConcurrency/serialProjects/parallelProjects/secCompile/batchProvider/batchModel/batchReasoningEffort*/secBig/bigProvider/bigModel/bigReasoningEffort*/bigTokenBudget/sessionTier/articleLanguage/binaryPath/panelTitle/stage*/state*/kind*/autoUpdate*/excludePaths*/sched* 等）。
- `en()`（第 190-344 行）：英文字字典，键集与 `zh()` 一致。
- 注册：`apply` 内 `const tBound = ctx.locale.bind(NS)`（第 469 行）与 `ctx.effect(() => ctx.locale.register(NS, { zh: zh(), en: en() }), 'dscw: dictionaries')`（第 470 行）。

### 样式注入（client.js 346-443）

- `style` 元素（第 346-443 行）：`style.dataset.plugin = '@local/dsh-codewiki'`（第 347 行）；CSS 按两组属性选择器组织——设置页 `data-dscw-*`（第 349-354 行）与侧栏面板 `data-dscw-p-*`（第 361-435 行），含六阶段步骤条（第 399-406 行）、吞吐徽标（第 413-414 行）与用量/错误/活动流（第 416-420 行）样式。
- HMR 防重（第 442-443 行）：`document.head` 已存在同名 `style[data-plugin="@local/dsh-codewiki"]` 时不再追加，避免重复加载堆叠样式表。

### API 封装与 DOM 助手（client.js 445-464）

- `el(tag, props, ...children)`（第 445-447 行）：`React.createElement` 包装。
- `apiGet(p)`（第 449-454 行）：GET + `accept: application/json`；非 2xx 抛 `body.error || HTTP {status}`。
- `apiPost(p, data)`（第 455-464 行）：POST `application/json` body；错误处理同 `apiGet`。

### 模块入口 apply(ctx)（client.js 466-1551）

- 入口声明：`return { inject: ['slots', 'locale', 'configForms'], apply(ctx) { ... } }`（第 466-467 行），`apply(ctx)` 方法体从第 468 行起涵盖至第 1551 行闭括号（内部定义所有 UI 组件）。
- 词典注册（第 469-470 行）；`form = ctx.configForms.get(NS)`（第 472 行）。
- `plugins.item` 挂载（第 475-487 行）：`mount` 注册 `{ name: 'plugins.item', id: NS, order: 30, label, locale: NS, inject: () => ({ t: tBound }) }` + `CodewikiCard`（第 476-482 行）；宿主提供 `ctx.configForms.whileServed` 时仅在该命名空间被服务期间挂载（插件停用/未加载则插件页不显形，第 484-487 行），否则直接挂载。
- 侧边栏面板挂载（第 490-501 行）：`ctx.effect` 内同时注入 `main`（`{ name: 'main', key: KEY }` + `CodewikiPanel`，第 492 行）与 `sidebar.panellist`（`{ id: KEY, order: PANEL_ORDER, label }` + `PanelIcon`，第 493-498 行），effect 返回 disposers 逐个清理（第 500-501 行）。

### 设置卡片 CodewikiCard(props)（client.js 508-922）

- 状态：`snapshot`/`draft`/`notice`/`error`（第 511-514 行），模型目录 `catalog`/`catalogError`（第 517-518 行）。
- 模型目录拉取 `useEffect`（第 520-531 行）：挂载时 `apiGet(MODELS_PATH)`；`data?.ok === false` 或异常时置 `catalogError`，设置页退回「手填」形态，不阻断保存。
- 配置快照订阅 `useEffect`（第 534-551 行）：`pull` 读 `form.getSnapshot()` 并 `setSnapshot`；仅当 `snap.status === 'ready'` 且 `revision` 变化时 `setDraft(structuredClone(snap.value))`（第 543-546 行，宿主值变更含保存成功后的回收读才覆盖草稿）；`form.subscribe(pull)` 订阅（第 549 行）。
- 摘要视图（第 554 行）：`props?.view === 'summary'` 时只返回一行简介（插件页列表项）。
- `setPath(key, value)`（第 556-563 行）：不可变更新 draft。
- `dirty` memo（第 565-568 行）：JSON 比较草稿与快照。
- `selectedProvider` memo（第 571-575 行）：从 catalog 匹配 `draft.batchProvider`，未命中为 null（手填形态）。
- 思考档位 `useEfforts`（第 580-611 行）：返回 `{ for, efforts, defaultEffort, error, loading }`；`useEffect` 依赖 `[p, m]`（第 584 行），二者齐备时按 `${EFFORTS_PATH}?provider=…&model=…`（第 589 行）拉取档位清单（来自模型目录，不手填裸字符串），失败或为空时 UI 各有提示与回退。`effortsState`/`bigEffortsState` 调用（第 612-613 行）。
- `modelTrio({ pKey, mKey, eKey, state, allowEmptyProvider, providerPlaceholder })`（第 618-722 行）：渲染一个模型的三个字段（提供商/模型/思考程度），普通档与大档共用；换提供商时联动清空模型与档位（第 635-642 行），已配置但目录缺失的 provider 保留 `__custom` 选项防静默丢失（第 647-649 行），catalogError 时退化为 Input（第 626-631 行）。
- `save()`（第 724-746 行）：校验 `maxConcurrency` 并发上限为 1-8 整数（第 727-730 行）；对 `['enabled', 'binaryPath', 'maxConcurrency', 'serialProjects', 'parallelProjects', 'articleLanguage', 'updateReminder', 'autoCommit', 'workspaceOnly', 'batchProvider', 'batchModel', 'batchReasoningEffort', 'bigProvider', 'bigModel', 'bigReasoningEffort', 'bigTokenBudget', 'sessionTier', 'excludePaths', 'autoUpdate', 'autoUpdateMin']` 逐键 JSON 差分构建 ops（第 733-737 行）；`form.mutate(ops, snapshot.revision)` 提交（第 740 行），接受与否分别提示 saved/conflict（第 741 行）。
- `discard()`（第 748-752 行）：草稿重置为快照并清空提示。
- 加载/不可用态渲染（第 754-756 行）。
- 渲染（第 758-921 行）：
  - `secRun` 运行区（第 761-844 行）：`enabled` 开关（第 764-772 行）、`updateReminder` wiki 维护提醒开关（第 773-781 行）、`autoCommit` 自动提交编译产物开关（第 782-790 行）、`workspaceOnly` 只显示工作区任务开关（第 791-799 行）、`maxConcurrency` 并发上限输入（第 800-808 行）、`serialProjects` 单项目串行开关（第 809-817 行）、`parallelProjects` 并行项目上限输入（第 818-827 行）、`articleLanguage` 文章语言输入（第 828-833 行）、`binaryPath` cw 可执行路径输入（第 834-842 行）。
  - `secCompile` 编译模型区（第 846-861 行，唯一通道：模型设置里已注册的 provider/model）：调用 `modelTrio` 渲染 `batchProvider`/`batchModel`/`batchReasoningEffort`（第 850 行），以及 `sessionTier` 兜底档位手填（第 851-859 行）。
  - `secBig` 大档模型区（第 862-878 行）：调用 `modelTrio` 渲染 `bigProvider`(allowEmptyProvider=true)/`bigModel`/`bigReasoningEffort`（第 867 行），以及 `bigTokenBudget` 输入（第 868-876 行）。
  - `secSchedule` 调度与排除区（第 879-912 行）：`autoUpdate` 自动更新开关（第 883-891 行）、`autoUpdateMin` 扫描间隔分钟输入（第 892-900 行）、`excludePaths` 排除清单多行文本域（换行/分号/逗号分隔绝对路径，第 901-910 行）。
  - 保存条（第 913-920 行）：放弃/保存按钮按 `dirty`/`snapshot.writable` 禁用；error 红字或干净态 notice Tag。

### 面板辅助函数与小组件（client.js 928-1060）

- `stageLabel(stage)`（第 928 行）/`stateLabel(st)`（第 929 行）/`kindLabelOf(t, kind)`（第 930 行）：拼接 `stage*`/`state*`/`kind*` 键取翻译。
- `progressBar(done, total)`（第 931-934 行）：total>0 时渲染 `data-dscw-p-bar` 进度条（宽度取完成比）。
- `repoName(cwd)`（第 935-938 行）：取路径末两段「父目录/目录名」，Temp 沙箱残留一眼可辨。
- `fmtMs(ms)`（第 939-945 行）：`HH:MM:SS`/`MM:SS`；`fmtTok(n)`（第 946-951 行）：token 数 k/M 缩写；`fmtDur(ms)`（第 952-957 行）：`X min`/`X h Y min`；`fmtAgo(iso)`（第 958-961 行）：相对时间 + agoSuffix。
- `Spark({ values, width = 56, height = 16 })`（第 963-975 行）：纯 SVG path 微趋势线，过滤非正数，少于 2 点返回 null。
- `stepName(s)`（第 979 行）；`lastTimedStage(job)`（第 982-985 行）：返回 `stageTimings` 中最后一个属于 ACTIVE_STAGES 的键。
- `stageBar(job)`（第 986-1008 行）：七阶段（含 queued 与 commit）步骤条——已完成绿点（title 带各阶段耗时）、当前阶段实心点 + 实时计时（第 996 行）、失败/取消在最后计时段标红/黄（failIdx 逻辑第 989 行，标记第 1002-1003 行），终态 done 全绿。
- `STAGE_WEIGHTS`（第 1010 行，常量定义见前文）与 `overallPct(job)`（第 1011-1019 行）：按 `STAGE_WEIGHTS` 累计已完成阶段权重，阶段内按 `taskList` 完成数折算（第 1017 行），封顶 99、done 才 100（第 1013、1018 行）。
- `throughputBadge(job, sparkOf, rateOf)`（第 1022-1042 行）：`job.tps > 0` 时显示 tok/s + Spark（实时通道，第 1025-1027 行）；否则批量通道按 `rateOf` 速率与 `batchProgress` 显示 篇/分 + ETA（第 1032-1037 行），无完成样本时显示自 `batchSubmittedAt` 起的执行时长（第 1039 行）；非活动阶段返回 null（第 1023 行）。
- `usageLine(job)`（第 1044-1060 行）：输入（提交时估算）/输出（响应实测）token（第 1047-1050 行）、请求数（批量/实时拆分，第 1051-1056 行）；`u.overTier2` 个超单请求预算（按大档装填）请求数红字提示（第 1059 行）。

### 总览标签页 ReposTab()（client.js 1063-1206）

- 状态：`data`/`err`/`busyCwd`/`mountedRef`（第 1065-1069 行）、`inFlightRef`（第 1071 行，防重叠拉取第 1073 行）、`exclBusy`（第 1092 行）。
- `pull()`（第 1072-1083 行）：`apiGet(REPOS_PATH)`；`useEffect` 首拉 + `setInterval(pull, REPOS_POLL_MS)`（第 1084-1088 行）。
- `toggleExclude`（第 1093-1111 行）：读 form 快照并校验可写（第 1094-1095 行）；`excludePaths` 按换行/分号/全半角逗号拆分（第 1099 行），路径归一化（去尾斜杠 + 小写，第 1098 行）判断已排除与否，增删后 `form.mutate` 写回（第 1102 行，与设置卡保存同链路经宿主 configForms 持久化热生效）；成功后 POST `control {action:'refresh'}` 失效服务端总览缓存并立即重拉（第 1104 行）。
- `compile(cwd)`（第 1113-1121 行）：POST `control {action:'compile', cwd}` 触发单仓库编译。
- 渲染（第 1126-1205 行）：调度卡（开/关、间隔、上次扫描/上次错误，第 1128-1138 行）；启用且有扫描记录时推算下次扫描时间与剩余时长、显示扫描/提交统计（第 1139-1154 行）；仓库列表（第 1157-1201 行）——名称、排除标签、状态色映射（clean→done / stale→stale / error→failed / 其余→cancelled，第 1160 行）、stale 时的「更新」按钮（第 1166-1171 行）、排除/取消排除按钮（第 1172-1176 行）、变更文件数/文章数/最近任务元信息与进度条（第 1178-1198 行）；空态 reposEmpty（第 1201 行）；渲染异常就地显形 `Repos error: …`（第 1203-1205 行）。

### 会话视图 SessionView({ job, onClose })（client.js 1210-1294）

- 状态：`list`/`err`/`sel`/`item`（第 1212-1215 行）。
- 列表轮询 `useEffect`（第 1216-1234 行）：每 5s `apiGet(SESSIONS_PATH?jobId=)` 拉取会话数组。
- 单项详情 `useEffect`（第 1235-1242 行）：`sel` 变更时 `apiGet(SESSIONS_ITEM_PATH?jobId=&n=)` 拉取 prompt/output。
- 渲染（第 1244-1293 行）：标题与关闭按钮（第 1245-1248 行）、任务 id（第 1249 行）、列表态（第 1272-1292 行）显示每个请求 n、名称、状态标记、模型、输出字符数、输入 token、开始时间；选中态（第 1250-1271 行）显示 meta 与 prompt/pre/输出 pre；空态 sessEmpty（第 1277 行）。

### 主面板 CodewikiPanel()（client.js 1296-1537）

- 状态：`jobs`（null = 尚未拿到首轮，第 1298 行）、`err`（第 1299 行）、`busyId`（第 1300 行）、`tab`（默认 'overview'，第 1301 行）、`sessJob`（第 1302 行）、`copiedPath`（第 1304 行）；`sparkRef`（jobId→tps 滚动窗口 Map，第 1306 行）、`batchRateRef`（jobId→{at, completed, rate} Map，第 1307 行）、`sparkOf`/`rateOf`（第 1308-1309 行）；`mountedRef`（第 1354-1355 行，卸载后不再 setState）。
- 轮询 `useEffect`（第 1311-1351 行）：每 `POLL_MS` 拉取 `JOBS_PATH`（inFlight 防重叠，第 1315 行）；对每个 job 把 `j.tps` 推入 sparkRef 窗口（超 30 点 shift，第 1323-1328 行）；`batchProgress.completed` 差分计算瞬时速率（篇/分）并按 `prev.rate*0.6 + inst*0.4` EWMA 平滑（第 1329-1338 行）；任务离开批量态时从 batchRateRef 删除（第 1338 行）。
- `cancel(jobId)`（第 1356-1364 行）：POST `control {action:'cancel', jobId}`。
- `copyPath(p)`（第 1365-1371 行）：剪贴板写入 wiki 路径，1.5s 后清除「已复制」态；权限拒绝时静默。
- `kindLabel`（第 1373 行）；`isActive(job)`（第 1375 行）：stage ∈ ACTIVE_STAGES。
- 分组（第 1378-1384 行）：按 cwd 分组、保持首次出现顺序、组内 unshift 最新在前（服务历史折叠区）。
- 焦点任务（第 1387-1390 行）：活动任务按 updatedAt 取最新，无活动取最近更新任务；其余收进「历史任务」折叠区。
- `jobCard(job)`（第 1392-1485 行）：kind Tag、阶段文本（data-state 着色，第 1434-1437 行）、吞吐徽标（第 1438 行）、会话按钮（第 1439-1442 行）、取消按钮（`cancelRequested` 时禁用并显示「取消中…」，第 1443-1449 行）、`stageBar`（第 1451 行）、meta 行（已写/失败/批次/已用时或总耗时，第 1399-1417 行）、排队可见性 queueAhead（第 1454-1457 行）、总进度条（仅活动任务，第 1458 行）、`usageLine`（第 1459 行）、最新一条 note + 活动流 details（第 1460-1467 行）、error 行（第 1468 行）、活动任务的任务清单 ✓/✗/· 列表（第 1469-1474 行）、wiki 路径与复制按钮（第 1475-1483 行）、自动提交结果展示（第 1421-1430 行）。
- 渲染（第 1487-1536 行）：标题 + 进行中计数（第 1492-1497 行）；三标签按钮（第 1498-1505 行）；`tab === 'overview'` → ReposTab（第 1506 行）、`tab === 'settings'` → 内嵌 CodewikiCard（第 1507 行）、`tab === 'tasks'` → 错误/加载/空态/焦点卡 + 历史折叠（按工作区分组，第 1508-1528 行）；渲染构建期异常就地显形 `Panel error: …` 避免整块白屏（第 1532-1536 行）。

### 面板图标 PanelIcon(props)（client.js 1539-1550）

- SVG 摊开的书本（wiki 页），默认 16×16、stroke currentColor，接受 `props.size`（第 1540 行）。

### 数据模型（外部 API 与表单值对象）

- **设置命名空间 `codewiki` 值对象**（由 `form.getSnapshot().value` 提供，第 539 行；`save()` 差量键全集见第 733 行）：宿主 Config 服务持久化的插件配置，全部字段如下：
  - `enabled`（bool，默认 true）：启用插件；停用后 `cw` 与 `codewiki_generate` 工具立即报错（第 767 行读取 `!== false`，词典第 37 行）。
  - `updateReminder`（bool，默认 true）：会话系统提示注入收尾提醒（第 776 行读取 `!== false`，词典第 42 行）。
  - `autoCommit`（bool，默认 true）：编译完成由插件自动提交产物（第 785 行读取 `!== false`，词典第 44 行）。
  - `workspaceOnly`（bool，默认 true）：任务页只显示工作区任务（第 794 行读取 `!== false`，词典第 46 行）。
  - `maxConcurrency`（number，1–8，默认 2）：编译并发上限（第 803 行 `String(draft.maxConcurrency ?? 2)`，词典第 48 行）。
  - `serialProjects`（bool，默认 true）：单项目串行（第 812 行读取 `!== false`，词典第 50 行）。
  - `parallelProjects`（number，1–4，默认 2）：并行项目上限，关闭单项目串行后生效（第 824 行 `Math.max(1, Math.min(4, Number(e.target.value) || 2))`，词典第 52 行）。
  - `articleLanguage`（string）：文章语言（如「中文」）（第 829-833 行）。
  - `binaryPath`（string）：cw 可执行路径，空=优先 PATH（第 836-842 行）。
  - `batchProvider`（string）：编译模型提供商 id（第 850 行）。
  - `batchModel`（string）：编译模型 id（第 850 行）。
  - `batchReasoningEffort`（string|null）：编译模型思考档位（来自目录）（第 850 行）。
  - `bigProvider`（string|null，空=关闭大档）：大档提供商 id（第 867 行）。
  - `bigModel`（string）：大档模型 id（第 867 行）。
  - `bigReasoningEffort`（string|null）：大档思考档位（第 867 行）。
  - `bigTokenBudget`（string|number，默认 420000）：大档输入预算（第 871 行，词典第 87 行）。
  - `sessionTier`（string）：兜底档位（dsh-subagent-auto-router 档位 id）（第 853-858 行）。
  - `excludePaths`（string，多行/分号/逗号分隔绝对路径）：排除清单（第 905 行）。
  - `autoUpdate`（bool，默认 false）：自动更新开关（第 886 行读取 `=== true`，词典第 159 行）。
  - `autoUpdateMin`（number，最小 5，默认 30）：扫描间隔分钟（第 895 行 `String(draft.autoUpdateMin ?? 30)`，词典第 161 行）。

- **任务对象 job**（`GET /api/codewiki/jobs` 返回数组元素，被 `jobCard` 消费，第 1392-1485 行）：编译任务运行态。字段包括：
  - `id`（string，第 1431 行引用）：任务唯一标识。
  - `cwd`（string，第 1381 行分组用）：仓库工作区路径。
  - `kind`（`full`/`stale`/`resume`，第 1433 行）：编译类型。
  - `stage`（string，见 ACTIVE_STAGES 及终态 `done`/`failed`/`cancelled`，第 1435 行）：当前阶段。
  - `createdAt`（ISO 时间戳，第 1411 行引用）：任务创建时间。
  - `updatedAt`（ISO 时间戳，第 1387 行）：任务更新时间。
  - `finishedAt`（ISO 时间戳，终态时间戳，第 1415 行）：任务结束时间。
  - `articles`（数组，元素含 `ok` 布尔，第 1394 行）：文章结果列表。
  - `writtenCount`（number，第 1400 行）：已写文章数（无 taskList 时）。
  - `failedCount`（number，第 1401 行）：失败文章数。
  - `taskList`（数组，元素 `{name, state}`，第 1396 行）：阶段内任务清单。
  - `batchProgress`（`{completed, total}`，第 1402 行）：批量进度。
  - `batchSubmittedAt`（ISO 时间戳，第 1029 行）：批量提交时间。
  - `tps`（number，实时通道吞吐，第 1024 行）：实时 tokens/s。
  - `usage`（`{inputTok, outputTok, requests, batchRequests, realtimeRequests, overTier2}`，第 1045 行）：用量统计。
  - `notes`（字符串数组，活动流，第 1461 行）：动态提示信息。
  - `error`（string，第 1468 行）：错误信息。
  - `wikiPath`（string，第 1475 行）：wiki 入口路径。
  - `stageTimings`（对象，阶段名→耗时 ms，第 995 行）：各阶段计时。
  - `stageStartedAt`（ISO，当前阶段开始，第 996 行）：阶段起始时间。
  - `cancelRequested`（bool，第 1447 行）：取消请求已发。
  - `autoCommit`（对象，含 `committed`/`sha`/`noChanges`/`reason`/`branch`，第 1423-1429 行）：自动提交结果。
  - `auto`（bool，自动调度触发，于 ReposTab 第 1189 行消费）：是否自动更新任务。
  - `queueAhead`（string 数组，第 1454 行）：排队时前方任务标识。

- **仓库对象与调度对象**（`GET /api/codewiki/repos` 返回，被 `ReposTab` 消费，第 1123-1201 行）：
  - `repos` 数组元素含 `cwd`（第 1163 行）、`state`（`missing`/`uncompiled`/`clean`/`stale`/`error`，第 1159 行）、`excluded`（bool，第 1164 行）、`lastJob`（任务对象快照，第 1179 行）、`staleArticles`（number，第 1186 行）、`changedFiles`（number，第 1186 行）、`articleCount`（number，第 1187 行）。
  - `scheduler` 对象含 `enabled`（第 1131 行）、`intervalMin`（第 1132 行）、`scanning`（第 1133 行）、`lastScan`（ISO，第 1136 行）、`lastError`（第 1137 行）、`lastScanRepos`（number，第 1144 行）、`lastScanSubmitted`（number，第 1144 行）。

- **会话对象 session**（`GET /api/codewiki/sessions` 返回，被 `SessionView` 消费，第 1278-1292 行）：元素含 `n`（请求序号）、`name`、`model`、`status`（`running`/`done`/`error`）、`startedAt`、`outputChars`、`inputTokens`；单项详情含 `prompt`、`output`、`error`。

## Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│      client.js — @local/dsh-codewiki（加载入口 10-12）         │
│  apply(ctx)（468-1551）：注册 zh/en 词典（469-470）· 注入 slots │
└───────┬───────────────────────────────┬───────────────────────┘
        ▼ plugins.item（order 30）      ▼ main + sidebar.panellist
┌───────────────────────────┐  ┌──────────────────────────────┐
│ CodewikiCard（508-922）    │  │ CodewikiPanel（1296-1537）    │
│ ├ 目录 MODELS_PATH 520-531 │  │ ├ ReposTab 总览（1063-1206）  │
│ ├ 档位 EFFORTS_PATH 580    │  │ ├ SessionView（1210-1294）   │
│ └ 保存 form.mutate 724-746 │  │ └ 设置 tab ↘ CodewikiCard    │
└─────────────┬─────────────┘  └───────────────┬──────────────┘
              ▼                                ▼
┌───────────────────────────────────────────────────────────────┐
│ apiGet/apiPost（449-464）→ 宿主 webServer /api/codewiki/*      │
│ jobs（2s 轮询）· repos（10s 轮询）· models · model-efforts    │
│ sessions · control（POST：cancel/compile/refresh，仅回环）     │
└───────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **初始化**：`window.__ModuleLoader__.load`（第 10 行）→ `factory` 建样式表（第 346-443 行，HMR 去重 442-443 行）→ `apply(ctx)`（第 468 行）：`tBound`（第 469 行）、词典注册（第 470 行）、取 `form`（第 472 行）、`whileServed` 守卫下挂 `plugins.item`（第 475-487 行）、`ctx.effect` 挂双 slot 挂载面板并返回 disposers 清理（第 490-501 行）。
2. **配置读写**：`CodewikiCard` 经 `form.getSnapshot()` + `form.subscribe` 同步宿主值到草稿（第 534-551 行，revision 门控防止覆盖编辑中的草稿）；保存 `save()` 差量 ops → `form.mutate(ops, snapshot.revision)`（第 724-746 行），revision 过期提示冲突重试；总览页 `toggleExclude` 也走同一条 `form.mutate` 链路（第 1093-1111 行）。
3. **任务流（2s 轮询）**：`apiGet(JOBS_PATH)`（第 1311-1351 行）→ `setJobs`；面板侧差分采样：tps → sparkRef 滚动窗口（≤30 点，第 1323-1328 行），batchProgress.completed → EWMA 速率（0.6/0.4，第 1329-1338 行）；`jobCard` 渲染步骤条/吞吐徽标/进度/用量/活动流；`cancel` 经 `apiPost(CONTROL_PATH)`（第 1356-1364 行）；会话视图 5s 轮询 `SESSIONS_PATH`（第 1216-1234 行）。
4. **仓库流（10s 轮询）**：`apiGet(REPOS_PATH)`（第 1072-1088 行）→ 调度卡 + 仓库状态列表；stale 仓库可 `compile`（第 1113-1121 行）、可 `toggleExclude`（第 1093-1111 行，写配置后 POST refresh 失效服务端缓存再重拉）。
5. **模型目录/档位流**：设置卡挂载拉 `MODELS_PATH`（第 520-531 行）；provider 变更联动清空模型与档位（第 635-642 行）；provider/model 齐备时拉 `EFFORTS_PATH`（第 589-608 行）；目录不可用逐级退化为手填，不阻断保存。

## Connections

- [[core-logic]]：本模块消费的 `/api/codewiki/jobs|control|repos|models|model-efforts|sessions|sessions/item` 端点由宿主半侧服务提供（常量定义第 19-27 行）；任务对象字段（stage/taskList/batchProgress/usage/notes/stageTimings/tps 等，见数据模型小节）的语义在本模块被消费。
- [[configuration-management]]：设置读写链路——`configForms` 命名空间 `'codewiki'`（第 17、472 行）、`getSnapshot/subscribe/mutate` 用法（第 534-551、724-746、1093-1111 行）与设置键全集（第 733 行）。

## Known Issues

- `ReposTab` 的状态→颜色映射（第 1160 行）把 `missing`/`uncompiled` 归入 `'cancelled'`，仓库卡片因此显示警告黄色；CSS 中为 `data-state="missing"`/`"uncompiled"` 定义的第三级灰（第 387 行）从仓库卡片永远命中不了——文本标签仍正确显示「未初始化/未编译」（词典第 138-139 行），仅颜色与设计意图不符。
- `sparkRef` 的 tps 窗口不随任务终态清理（仅 push/shift，第 1323-1328 行；对照 `batchRateRef` 在任务离开批量态时会删除，第 1338 行）：终态任务残留最后一窗数据，但因 `throughputBadge` 只在活动阶段渲染（第 1023 行），目前无可见影响。
- （历史，已消除）早期版本 `save()` 校验曾引用字典中不存在的键，且手填预算项与模型目录档位下拉并存。当前 `batchReasoningEffort`/`bigReasoningEffort` 已完整取代为模型目录档位下拉（第 580-611、618-722 行），`save()` 仅校验 `maxConcurrency`（第 727-730 行），不再引用任何未定义键；`autoCommit`/`parallelProjects` 等设置项已纳入保存键全集（第 733 行）。
