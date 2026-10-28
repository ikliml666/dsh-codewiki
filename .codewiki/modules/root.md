---
title: root
type: module
source_files:
  - client.js
  - test-agentic-fallback.mjs
  - test-agentic-host.mjs
  - test-agentic.mjs
  - test-article-contract.mjs
  - test-articles-agentic.mjs
  - test-batch.mjs
  - test-change-set.mjs
  - test-cluster.mjs
  - test-cwd-paths.mjs
  - test-engine-apply-plan.mjs
  - test-engine-bridge.mjs
  - test-engine-client.mjs
  - test-engine-contract.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-manifest.mjs
  - test-engine-output-real.mjs
  - test-engine-output.mjs
  - test-engine-process-tree.mjs
  - test-engine-python-entry.mjs
  - test-engine-quality-gate.mjs
  - test-graphdiff.mjs
  - test-incremental-e2e.mjs
  - test-incremental.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-semantic-plan.mjs
  - test-sessions.mjs
  - test-symbols.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
tags: [root, client-ui, sidebar-panel, test-suite, orchestration]
---

## Overview

仓库根目录（root）承载两类互为表里的源码，共 34 个文件：

1. **`client.js`（1703 行）—— dsh-codewiki 插件的「客户端半侧」（浏览器）**。它以 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) { … } })`（10-12 行）注册，向宿主 UI 注入两个挂载点（2-5 行头注释）：「插件」页的设置卡片 `plugins.item`（id=codewiki）与侧边栏编译任务面板（`main` slot + `sidebar.panellist`）。面板数据全部来自宿主半侧 webServer 的回环端点（19-27 行的 7 个路径常量），设置读写经 `configForms` 命名空间 `'codewiki'`（6 行注释、515 行）。**插件不保存、不传递任何密钥**——模型与凭证都取自模型设置里选中的 provider/model（73 行 `batchProviderHint`）。
2. **33 个 `test-*.mjs` 脚本 —— 插件验收套件**。每个都是 `node test-xxx.mjs` 直接运行的独立进程，绝大多数完全离线（注入假 llm / 临时目录 / 临时 git 仓库）；少数依赖外部环境（真实 git、1A 造的 venv、1C 真实编译产物、web-tree-sitter WASM）时显式打印 `SKIP` 退出而非假装通过。统一退出约定：按失败数以非零码退出（`process.exit(fails ? 1 : 0)`，部分脚本以等价的 `process.exitCode = 1` 收尾）。

`client.js` 没有自己的单测（浏览器环境）；它的行为契约靠两件事对齐：词典与端点常量（19-27 行）与 `index.js` 侧 `installWebServer` 注册的同名端点一一对应（端点行为由 test-batch.mjs 434-516 验证），面板消费的 job 字段（`stage`/`stageTimings`/`taskList`/`batchProgress`/`autoCommit` 等）由 test-orchestration.mjs 的端点断言守护。

## Key Components

### client.js：注册壳、常量与词典

| 行号 | 成员 | 说明 |
| --- | --- | --- |
| 10-12 | `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) })` | 入口；id 必须等于 package.json 的 `name`（7 行注释：client-modules 按 nearestPackage 的 name 校验注册者） |
| 13-15 | 依赖 | `react`；`@deepseek-ai/dsh-client-ui-primitives` 的 `Switch/Button/Input/Tag` |
| 17 | `NS = 'codewiki'` | profile patch 条目 id = 设置命名空间 |
| 18 | `KEY = 'codewiki'` | 面板 key；`sidebar.panellist` 的 id 必须与它一致 |
| 19 | `JOBS_PATH = '/api/codewiki/jobs'` | 任务列表（面板 2s 轮询） |
| 20 | `CONTROL_PATH = '/api/codewiki/control'` | 控制（cancel / compile / refresh），仅回环 |
| 21 | `PANEL_ORDER = 52` | 排在 dsh-hindsight-on-demand（50）之后 |
| 22 | `POLL_MS = 2000` | 任务轮询间隔 |
| 23 | `REPOS_PATH = '/api/codewiki/repos'` | 仓库总览（10s 轮询） |
| 24 | `SESSIONS_PATH = '/api/codewiki/sessions'` | 会话列表（5s 轮询；带 `?jobId=` 为单任务） |
| 25 | `SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'` | 单条会话全文（按 `jobId`+`n`） |
| 26 | `MODELS_PATH = '/api/codewiki/models'` | 模型目录（provider/model 级联下拉数据源） |
| 27 | `EFFORTS_PATH = '/api/codewiki/model-efforts'` | 思考档位（按 provider+model 查询） |
| 30 | `GENERIC_EFFORTS = ['off','low','medium','high','xhigh','max']` | 目录未声明 efforts 的模型（如 trae/mimo-v2.6-flash）在设置页展示的通用档位；选了不支持的值由 llmChat 兜底剥档重试（28-29 行注释） |
| 31 | `REPOS_POLL_MS = 10000` | 总览轮询间隔 |
| 33 | `ACTIVE_STAGES = ['queued','articles','crosscut','compose','review','index','commit']` | 七个活动阶段；queued 单列最前——单项目串行时后提交项目在此等待，阶段条第 0 个点亮表示排队（32 行注释） |
| 35-210 | `zh()` | 中文词典（约 170 键；8 行注释：词典值必须是字符串，若为函数 `t()` 会回退返回键名） |
| 211-386 | `en()` | 英文词典（键集与 zh 一致） |
| 388-483 | `style` | 全部面板/设置页 CSS，`[data-dscw-*]` 属性选择器（如 `[data-dscw-p-job]` 407、六阶段步骤条 441-453、会话行 470-477） |
| 485 | HMR 去重 | 仅当 `document.head` 无 `style[data-plugin="@local/dsh-codewiki"]` 时追加，避免重复加载堆叠样式表 |
| 487-489 | `el(tag, props, ...children)` | `React.createElement` 薄包装——全文无 JSX 的构元方式 |
| 491-496 | `apiGet(p)` | GET JSON；`!res.ok` 时抛 `body.error \|\| 'HTTP <status>'`（494） |
| 497-506 | `apiPost(p, data)` | POST JSON，同样错误语义（504） |

### client.js：`apply(ctx)` —— 挂载与生命周期（508-544）

- 508-510| 模块面：`{ inject: ['slots','locale','configForms'], apply(ctx) { … } }`。
- 511-512| `tBound = ctx.locale.bind(NS)`；`ctx.effect(() => ctx.locale.register(NS, { zh: zh(), en: en() }), 'dscw: dictionaries')`。
- 515| `form = ctx.configForms.get(NS)` —— 之后所有设置读写（含总览页的排除清单增删）都走它。
- 518-525| `mount()`：`ctx.slots.inject('plugins.item', () => ctx.slots.register({ name:'plugins.item', id: NS, order: 30, label, locale, inject: () => ({ t: tBound }) }, CodewikiCard))`。
- 526-530| 宿主支持 `configForms.whileServed` 时用其守卫挂载（「插件未加载/停用时插件页不显形」，517 行注释）；否则直接 `mount()`。
- 533-544| 侧边栏面板 effect（id `'dscw: panel'`）：两条 `slots.inject` —— `main`（key=KEY）挂 `CodewikiPanel`；`sidebar.panellist`（id=KEY、order=`PANEL_ORDER`）挂 `PanelIcon`。返回 disposer 数组，卸载时逐个 `try { d?.() } catch {}`（543）。

### client.js：`CodewikiCard`（550-1038）—— 设置卡片

状态与副作用：

- 553-556| `snapshot / draft / notice / error`；559-560| `catalog / catalogError`（模型目录，562-573 拉取 `MODELS_PATH`；失败时 `catalogError` 有值 → 设置页退回「手填」形态，不阻断保存，557-558 行注释）。
- 576-593| 快照订阅：`form.getSnapshot()` + `form.subscribe(pull)`；仅当 `snap.status === 'ready'` 且 `revision` 变化才 `structuredClone(snap.value)` 覆盖草稿（583-588）——宿主值变更（含保存成功后的回收读）才覆盖，用户编辑中的草稿不被冲掉。
- 596| `props.view === 'summary'` → 返回一行 `t('summary')`（插件页列表项形态）。
- 598-605| `setPath(key, value)`：structuredClone 草稿后改单键。
- 607-610| `dirty`：`JSON.stringify(draft) !== JSON.stringify(snapshot.value)`。
- 613-617| `selectedProvider`：目录命中的 provider 条目，未命中为 null（手填形态）。
- 622-653| `useEfforts(provider, model)`：二次拉取 `EFFORTS_PATH?provider=&model=`；状态形状 `{ for, efforts, defaultEffort, error, loading }`（623），`for` 是 `provider\0model` 键。654-655| 普通档 `effortsState` 与大档 `bigEffortsState` 各一份，同一套读取逻辑（620-621 行注释）。
- 660-764| `modelTrio({ pKey, mKey, eKey, state, allowEmptyProvider, providerPlaceholder })`：一个模型的三个字段（提供商/模型/思考程度）共用渲染与目录联动——换提供商清空模型与旧档位（677-684）、目录里已配置但已删除的 provider/model 保留为 `__custom` 选项避免静默丢配置（688-691、706-714）、目录未声明档位时给 `GENERIC_EFFORTS` 手选（727-743）、大档 `allowEmptyProvider=true` 多一个「（未启用）」空选项（686），provider 留空时档位处改显 `bigDisabled` 提示（723）。

保存与校验（766-805）：

- 768-771| `maxConcurrency`：1–8 整数。
- 773-778| `bigConcurrency`：0 = 跟随默认档（不报错）；负值/小数/超硬顶拦下。
- 779-784| `agenticMaxSteps`：1–100 整数（开关关闭时值仍要合法，避免下次开启拿到脏值）。
- 785-789| `planMode`：白名单 `['auto','dirs']`，防手填脏值永久存在配置里。
- 790-797| 对 25 个配置键（`enabled/binaryPath/maxConcurrency/bigConcurrency/serialProjects/parallelProjects/articleLanguage/updateReminder/autoCommit/workspaceOnly/batchProvider/batchModel/batchReasoningEffort/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget/sessionTier/excludePaths/autoUpdate/autoUpdateMin/planMode/agenticArticles/agenticMaxSteps/symbolIncremental`）逐个 JSON diff 生成 `{ op:'set', path:[key], value }`。
- 798-804| `form.mutate(ops, snapshot.revision)`；被拒 → `t('conflict')`「保存冲突：设置已被他处修改」（121 行）。
- 807-811| `discard()`：回滚草稿到快照。

渲染（813-1037）：loading/unavailable/无草稿 → 加载提示（813-815）；否则五个 section —— 「运行」（819-913：enabled/updateReminder/autoCommit/workspaceOnly/maxConcurrency/bigConcurrency/serialProjects/parallelProjects/articleLanguage/binaryPath）、「编译模型」（914-930：batch `modelTrio` + `sessionTier` 兜底档位）、「大档模型」（931-947：big `modelTrio` + `bigTokenBudget`）、「编译流程」（948-994：planMode/agenticArticles/agenticMaxSteps/symbolIncremental）、「调度与排除」（995-1028：autoUpdate/autoUpdateMin/excludePaths textarea）；最后保存条（1029-1036：放弃更改 / 保存 / error 红字或 notice Tag）。

### client.js：面板展示层小工具（1044-1181）

- 1044-1046| `stageLabel / stateLabel / kindLabelOf`：按词典键拼名（`stage${首字母大写}${余部}`）。
- 1047-1050| `progressBar(done, total)`：4px 圆角进度条，百分比钳 0–100。
- 1051-1054| `repoName(cwd)`：取「父目录/目录名」两段（1053 行注释：Temp 沙箱残留一眼可辨）。
- 1055-1061| `fmtMs(ms)`：`h:mm:ss` / `mm:ss`；1062-1067| `fmtTok(n)`：k/M 缩写；1068-1073| `fmtDur(ms)`：分钟/小时；1074-1077| `fmtAgo(iso)`：「xx 前」。
- 1079-1091| `Spark({ values, width=56, height=16 })`：纯 SVG polyline 微趋势线（数据来自面板侧 30 点 tps 滚动窗口，1078 行注释）。
- 1095| `stepName(s)`；1098-1101| `lastTimedStage(job)`：过滤 `stageTimings` 里旧任务残留的已删阶段计时键（如 plan）——否则 `indexOf` 得 -1 导致失败/取消时 `failIdx` 失效、步骤条全熄不标红（1096-1097 行注释）。
- 1102-1127| `stageBar(job)`：七阶段步骤条。已完成绿点（title 带各阶段耗时）、当前实心点+实时计时；终态判定：`cleanEnd = stage==='done' || 'partial'` 全绿（1107，partial 与 done 一样「所有阶段都跑过了」，1105-1106 行注释），只有 failed/cancelled 在最后计时段标红/黄（1121-1122）。
- 1128-1140| `STAGE_WEIGHTS = { queued: 0, articles: 0.63, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05, commit: 0.02 }`（1129）+ `overallPct(job)`（1130-1140）：已完成阶段权重累加 + 当前阶段按 `taskList` 完成数折算；封顶 99，仅 done/partial 到 100（1134，partial 是活干完了但完整性没成立）。
- 1143-1163| `throughputBadge(job, sparkOf, rateOf)`：实时通道 `tok/s` + `Spark`；批量通道完成速率（篇/分）+ ETA；无完成样本时显示「执行中 + 时长」（自 `batchSubmittedAt` 起算，1159-1161）。
- 1165-1181| `usageLine(job)`：输入（提交时估算）/输出（响应实测）/请求数（批量+实时分列，1173-1175）；`u.overTier2` 超单请求预算请求数红字提示「按大档装填」（1180）。

### client.js：`ReposTab`（1184-1328）—— 总览标签页

- 1186-1190| 状态 + `mountedRef`；1192-1204| `pull()`：`inFlightRef` 去重（服务卡顿时不重叠拉取）。
- 1205-1209| `useEffect`：立即拉一次 + `REPOS_POLL_MS` 定时器。
- 1213-1232| `toggleExclude(r)`：直接改插件配置 `excludePaths`（`form.mutate`，与设置卡保存同链路、经宿主 configForms 持久化并热生效，1211-1212 行注释）；成功后 `POST CONTROL { action:'refresh' }` 失效服务端总览缓存并立即重拉（1224-1226）。
- 1234-1242| `compile(cwd)`：`POST CONTROL { action:'compile', cwd }`（stale 仓库的「更新」按钮）。
- 1244-1245| `sched = data?.scheduler`、`repos = data?.repos`。
- 1247-1327| 渲染（整体包 try/catch，异常显形 1325-1327）：调度块（1249-1276——开/关 Tag、扫描间隔、上次扫描/错误、下次扫描 = 上次扫描 + 间隔，「60s 心跳有同量级误差，显示为约值」1262 行注释，附 `lastScanRepos/lastScanSubmitted` 统计）；仓库卡列表（1278-1324——`state` 五态映射 `clean→done / stale→stale / error→failed / 其余→cancelled`（1281）、`excluded` Tag、stale 时「更新」按钮、排除/取消排除按钮、lastJob 的 meta 行 + 进度条；`ljActive` 排除 `done/partial/failed/cancelled` 四终态，否则已结束任务会被当成在跑继续显示进度条（1301 行注释））。

### client.js：`SessionView`（1334-1424）—— 会话视图（LLM 请求记录）

- 1330-1333 行注释：像给 codewiki 专门开的会话；`job` 为 null 走全局聚合接口（不带 jobId），跨任务列出并发池全部请求，行里带「哪个任务 + 哪个仓库」；选中后仍按 `(jobId, n)` 拉单条全文；保留 24h。
- 1336| `global = !job`；1337-1340| `list / err / sel / item`。
- 1341-1359| 列表 5s 轮询（`SESSIONS_PATH`，单任务带 `?jobId=`）。
- 1360-1367| 选中 `sel` 后拉 `SESSIONS_ITEM_PATH?jobId=&n=` 单条全文。
- 1370-1423| 渲染：标题（全局 `sessGlobalTitle` / 单任务 `sessTitle`）、返回按钮；行状态标 ▸/✓/✗（1411），行副标题拼 `状态 · jobId · 仓库尾段 · 模型 · ~Nk ch · in Nk tok · 时间`（1413-1421）；详情页 meta 行 + prompt `<details>` + 输出 `<pre>`（1391-1397）。

### client.js：`CodewikiPanel`（1426-1686）—— 主面板

- 1428-1436| 状态：`jobs`（null = 尚未拿到首轮）/`err`/`busyId`/`tab`（默认 `'overview'`）/`sessJob`/`copiedPath`；`setSessJob(j)` 打开单任务会话视图时强制 `setTab('tasks')`（1435，单任务会话占满整页；全局「会话」Tab 留在 Tab 条内随时可切走，1433-1434 行注释）。
- 1438-1441| `sparkRef: Map<jobId, number[]>`（tps 滚动窗口）、`batchRateRef: Map<jobId, { at, completed, rate }>`、`sparkOf(id)`、`rateOf(id)`。
- 1443-1483| 2s 轮询 effect：in-flight 守卫（1447「上次请求未回包（服务卡顿）时不重叠拉取」）；tps 采样压入 30 点窗口（1454-1460）；批量完成速率 EWMA：`rate = prev.rate * 0.6 + inst * 0.4`，`inst` 为本次间隔的瞬时篇/分（1465-1468）。
- 1486-1496| `mountedRef`（卸载后不再 setState，1485 行注释）+ `cancel(jobId)`：`POST CONTROL { action:'cancel', jobId }`，按钮在 `cancelRequested === true` 时禁用并显示「取消中…」。
- 1497-1503| `copyPath(p)`：剪贴板写入，1.5s「已复制」反馈；权限拒绝静默（1502）。
- 1505-1507| `kindLabel`；`isActive(job) = ACTIVE_STAGES.includes(job.stage)`。
- 1509-1516| 按 cwd 分组：保持首现顺序，组内 `unshift`（最新在前），供历史折叠区用。
- 1518-1522| 焦点任务：活动任务按 `updatedAt/createdAt` 新→旧取第一个；无活动取最近更新的一个；其余收进「历史任务」折叠区。
- 1524-1632| `jobCard(job)`：状态行（kind Tag、stage 着色标签、`throughputBadge`、「会话」按钮、活动期取消按钮）→ `stageBar(job)` → meta 行（已写 x/y 篇、失败数；已用时拆「排队/执行」——`elapsedSplit`（1543-1547）从 `stageTimings.queued` 取排队时长、执行 = 总时长 − 排队，「不再让 2 小时排队被看成编译跑了 2 小时」，1542 行注释；自动提交三态 1556-1568——`committed` 显示短 sha+分支、`noChanges`「产物无改动」、否则「产物未自动提交」且失败原因放 title 不塞 meta（1557-1558 行注释）；partial 未消化阻塞数 + 原因前 3 条放 title 悬停，1569-1577）→ `queueAhead`「在等谁」（1600-1604）→ 活动期总进度条 → `usageLine` → 最新一条 note + 活动流 `<details>`（1607-1614）→ error → 活动期 `taskList`（✓/✗/· 逐任务，1616-1621）→ `wikiPath` + 复制路径按钮（1622-1630）。
- 1634-1686| 渲染（try/catch 包裹，渲染构建期异常直接显形避免白屏，1682 行注释）：Tab 条（总览/任务/会话/设置，1645-1652）；`overview` → `ReposTab`；`sessions` → 全局 `SessionView`（job=null）；`settings` → 内嵌 `CodewikiCard`（1656）；`tasks` → focus 卡 + 「历史任务」折叠区（按 cwd 分组、组头显示 `repoName`）。
- 1688-1699| `PanelIcon(props)`：16px「摊开的书」SVG 图标。

### 测试套件（33 个 `test-*.mjs`）

统一形态：顶部 `check(label, fn)` / `check(cond, msg)` 小框架，逐条打印 `PASS/FAIL`（或 ✓/✗；个别脚本只做末尾汇总），末尾以失败数决定退出码。按被测层分四组：

**组 1 —— 插件核心单元（纯函数 + mock 宿主 llm，全部离线）：**

| 文件 | 被测对象（import 自） | 守护要点 |
| --- | --- | --- |
| test-batch.mjs | `./index.js`：`collectSources/classifySessionTask/estimateTokens/fixAnchors/numberLines/buildSessionSteerText/prepareArticleTasks/runRealtimeTasks/localPlan/packArticles/scanRepoFiles/listModelCatalog/resolveModelEfforts/installWebServer/validateArticleEnvelope`（7-13） | 装填/token 估算（25-52）；观察批分割（88-106）；大档接管超长输入、`bigTier` 标记（109-132）；会话通道三态 `timeout/harvest/wait`（135-150）；`sessionTier` 钉进 steer 文本（152-168）；宿主 llm 通道、大/默认档**分池限流**峰值探测（232-297）；`localPlan` 顶层目录分组（347-358）；`fixAnchors` 多锚点行「各自绑定最近符号」对抗用例（571-601）；端点回环 403 守卫（434-516）；0.10.1 删除直连通道回归断言 `resolveBatchApiKey === undefined`（519-521） |
| test-agentic.mjs | `./lib/agentic.js`：`runAgenticArticle/makeArticleEditor/makeReadCodeTool/makeListFilesTool/buildToolset/buildOpeningPrompt/parseToolArgs/safeRelPath/numberLines/TOOL_SCHEMAS`（4-8） | 工具循环全异常路径（未知工具/坏 JSON/工具抛错/maxSteps/stream-error/abort，276-363）；「finish 前清空的文章不会被正文覆盖」（365-378）；`generate_sub_module` 无回调时必须报错「不能谎称已成文」（401-419）；`read_code` 重复读去重（501-540）；CRLF 行尾保真（542-561）；单行超长文件字符上限（563-571） |
| test-agentic-host.mjs | `./lib/agentic-host.js`：`toRequestMessages/makeHostStream/makeFsWorkspace`（6） | 裸消息↔宿主 `Message` 转换（18-64）、一条 tool 消息多结果展开（38-53）、chunk 收流与 tools 透传（79-112）、FS 越界拒绝（160-168）、同一批消息多次转换 **MessageId 稳定**（171-184） |
| test-articles-agentic.mjs | `./lib/articles-agentic.js`：`runOneArticle/runAgenticArticles/markBigAgenticTasks/sourceTokensOf/resolveTaskRoute`（7） | `generate_sub_module` 真递归写子文章（66-98）；**subDepth 封顶回归**——旧实现 `dispatchSub` 是本层闭包、`_depth` 永不递增，实测 subDepth=2 直接堆溢出（145-149 行注释、182-215 用序无关断言）；子失败记账父仍成功（217-245）；双池限流与 `bigConcurrency=0` 回落（331-387）；写集闸门 `allowedWritePaths`（399-470） |
| test-agentic-fallback.mjs | `./index.js` 的 `shouldFallBackFromAgentic/prepareArticleTasks` + `./lib/articles-agentic.js` 的 `runAgenticArticles`（13-14） | agentic 退回链路三段：① 过半失败判定（严格过半，27-51）；② 重试任务字段够旧通道装填、缺源码退化为可继续空装填（59-98）；③ 执行器必须返回逐篇 `ok` 的 Map，失败只挑失败篇（101-120） |
| test-article-contract.mjs | `./lib/article-contract.js` 的 `inspectArticle/parseFrontmatter/parseYamlLite/extractSections/fencesBalanced/collectWikiLinks/hasDuplicateFrontmatter/issueSummary/REQUIRED_SECTIONS/TYPE_BY_DIR/hasBlockingIssue/makeWriteSet/isWritable/normalizeWritePath/SEVERITY`（12-16） | P0-4「坏文章不能入库」：真实仓库曾进过未闭合 frontmatter / 正文重复整篇 / 死 source_files（3-7 行注释逐条点名）；非必需空章节只 warning 放行（88-96）；分级——结构破坏 error 拒写、章节缺失 warning 降 partial（210-218）；写集闸门绝对/越界路径（220-232） |
| test-cluster.mjs | `./lib/cluster.js` 的 `clusterComponents/heuristicCluster/fillMissing/moduleFiles/formatComponents/clusterPrompt/subClusterPrompt/superGroupPrompt/parseJsonLoose/parseClusterResponse/parseSuperGroups/normalizeModuleName/toPlanModules`（4-9） | LLM 聚类三段式（顶层/下钻/超级分组）；JSON 抢救（剥围栏/修尾逗号，65-82）；组件不丢不变量（每条降级路径后 `got.size === components.length`）；**maxDepth 逐层递增回归**——旧实现只对顶层做一次 for、maxDepth 退化成布尔（270-272 行注释、313-343） |
| test-symbols.mjs | `./lib/symbols.js` 的 `SymbolExtractor/extractRepoGraph/resolveImportEdges/extractImportSpecs/resolveSpec/LANG_RULES/SUPPORTED_EXTS/regexExtract`（8-12） | 8+ 语言 AST 提取（JS/Py/Go/Rust/Java/C#/C，48-211）；import 边解析（229-269）；本插件自身源码自检 `graph.size > 30`（272-286）；**WASM 不可用时正则兜底不再静默丢符号**（292-342） |
| test-graphdiff.mjs | `./lib/graph-diff.js`：`bodySimilarity/bodyHash/unifiedDiff/diffGraphs/serializeDiff/sequenceRatio/normalizeBody/documentedSource/truncateToTokens`（7-10） | 与 FSoft 上游 Python 原版**逐位对拍**：golden 由 `test-fixtures/gen-graphdiff-golden.py` 生成（2-3 行注释；缺文件 exit 1，14-17）；组件级改名配对、interface/body/edge 分类（58-104） |
| test-change-set.mjs | `./lib/change-set.js` 的 `collectChangeSet`（11） | P0-1：旧 `cw status` 只看 `git diff <last>..HEAD`，未提交/暂存/未跟踪全看不见（2-5 行注释）；四路采集（committed/staged/unstaged/untracked）+ deleted/renamed、`.codewiki/` 自身产物排除出 `sourceChanges`（152-164）、POSIX 路径规范化（166-175）、可注入 execFile（177-194） |
| test-incremental.mjs | `./lib/incremental.js`（7-10）+ `./lib/symbols.js` 的 `extractRepoGraph`、`./lib/graph-diff.js` 的 `bodyHash/stripComments` | 快照不含源码但带 sha1 `bodyHash`（31-40）；**纯注释变更降级 cosmetic 不重写**（69-118，README 承诺过的场景；老快照缺 `codeHash` 时保守保留）；`sameSnapshotContent` 忽略 `generatedAt/commit` 防空转提交（227-237） |
| test-incremental-e2e.mjs | `./index.js` 的 `extractCurrentGraph/currentCommit` + `./lib/incremental.js`（7-8） | 端到端主收益链路：快照落盘 `.codewiki/temp/symbol-graph.json` → 只改函数体实现 → 该文章重写、无关文章跳过（61-76）；只改空白/注释两篇全跳过（78-95） |
| test-update-planner.mjs | `./lib/update-planner.js` 的 `planUpdate/realChangedIds/dependentsOf/scanStaleArticle/buildModuleMap/migrateModuleMap/sameModuleMap/isSourcePath/MODULE_MAP_VERSION`（7-10） | P0-3：旧 `filterStaleTasks` 做不到的三件事（3-5 行注释）——反向依赖影响（接口变更连依赖方文章一起写，47-61）、新文件同模块路由 / 无归属 ⇒ `needsFull` 绝不静默丢弃（88-120）、未重写页 stale scan（正文引用已删符号升级 write、死链 review，177-210） |
| test-update-record.mjs | `./lib/update-record.js` 的 `judgeOutcome/buildUpdateRecord/saveUpdateRecord/loadUpdateRecord/recordPath/describeOutcome/isTerminalStage/TERMINAL/UPDATE_RECORD_VERSION`（11-14） | P0-2：「1 成功 19 失败也是 done 且照常推进基线」缺陷钉死（2-6 行注释、62-76）——任何未消化项 ⇒ partial/failed，partial **绝不推进基线**；`TERMINAL` 含 partial（47-52）；记录可 JSON 往返且不塞整图（179-185） |
| test-prune-orphans.mjs | `./index.js` 的 `pruneOrphanModules`（10） | 会**删文件**的逻辑只测「会不会误删」：增量一律不动（57-68）、`plan.modules` 为空数组时一个不删（79-85）、concepts/ 与根级文章永不碰（87-96）、删除失败记账不中断（153-181）、中文/斜杠模块名与任务组装侧同一文件名（128-149） |
| test-sessions.mjs | `./index.js` 的 `SESSIONS_DIR/listSessionRecords/readSessionRecord/pruneSessionRecords/listAllSessionRecords`（8） | 记录按 `n` 倒序、单条全文读取、24h TTL 清理（45-55）、全空 job 目录移除（57-63）、1.2.0 全局聚合带 `jobId`（31-43） |
| test-wiki-entry.mjs | `./index.js` 的 `ensureWikiEntry/normalizeArticlePath/normalizeIndexLinks/parseStatus`（10） | 入口缺失生成（含 `.codewiki` 绝对路径与 `codewiki_generate` 指引）、**已有入口绝不覆盖**（34-39）、幂等；Windows `\` 路径在 stale 清单与 `_index.md` 链接头统一收口（56-72） |
| test-worktree.mjs | `./index.js` 的 `detectLinkedWorktree/isWorktreeCwd/hasCompilableSources/isDeadCompileTarget`（11） | 用真实 `git worktree add` 建判据（判据来自 git 本身而非目录命名，3 行注释）；空壳目录（只剩 `.codewiki` 骨架）判 `hasCompilableSources === false`（64-70）；git 不可用显式 SKIP（30-36） |
| test-cwd-paths.mjs | `./index.js` 全插件 `apply` 后直调 `cw` 工具 `execute`（20） | 0.2.3 路径修复：MSYS 形式（`/e/x`）、Windows 形式、不存在路径干净报错「cwd 不存在」（61-69）；默认仓库路径硬编码需 argv 覆盖（8） |

**组 2 —— FSoft 原生引擎适配层（`lib/engine/`，阶段 0-3 契约）：**

| 文件 | 被测对象 | 守护要点 |
| --- | --- | --- |
| test-engine-contract.mjs | `./lib/engine/contract.js` + `./lib/engine/mapping.js`（14-30） | `ENGINE_CONTRACT_VERSION=1`、八段 `ENGINE_STAGES`、四终态（43-47）；「done 不许带阻塞原因」「partial 必须带可机读阻塞原因」（54-71）；`engine.deps` 白名单归一化必须显式保留（84-105）；`mapFsoftOutput`：页映射、parent/leaf/artifact pageKind、无证据不臆造 source_files、unmapped 带原因绝不静默丢弃、slug 冲突（189-334） |
| test-engine-client.mjs | `./lib/engine/client.js` 的 `createProtocolReader/runEngine/ENGINE_PROTOCOL_VERSION`（21-25） | 唯一跨语言边界的**协议破坏面**（5-15 行注释）：非 JSON stdout、半行 JSON、未知 requestId 不污染结果、缺 result 退出码 0 也不算成功、退出码与语义不一致以 result 为准、取消后 late-result 不覆盖终态（39-154）；假 Python 引擎按 `FAKE_MODE` 吐协议（158-233）；进程层真 spawn（243-360） |
| test-engine-manifest.mjs | `./lib/engine/manifest.js`（10-19） | 环境可信层：probe/指纹（16 hex）/lock 读写/doctor 四态 `absent/match/drift/unhealthy`；pip check 状态**不进指纹**（修依赖不算换引擎，59-63）；probe 抛错 → `probe-failed` 不外抛（185-190） |
| test-engine-output.mjs | `./lib/engine/output.js`（12-19） | 产物解析/校验：缺页被吞 / 空壳页 / 编造 source_files / 死链各有 kind（79-217）；同输入两次结果稳定（206-212）；`componentFiles` 作为 source_files 证据（219-227） |
| test-engine-output-real.mjs | 同上 + `mapFsoftOutput`（22-23） | 只有用 **1C 真实编译产物**才暴露的两个缺陷（2-15 行注释）：hierarchical 子目录页必须被收集（97-114）；whole-repository 模式 `module_tree.json` 是 `{}` 但页仍在——页进写集、`source_files` 空、`attribution='unattributed'`，并报可机读 `empty-module-tree`（57-84）。产物路径硬编码，缺失即 SKIP（32-37） |
| test-engine-python-entry.mjs | `lib/engine/python/entry.py` + `stage_map.py`（22-24） | 唯一自写 Python 的三个失败面（5-13 行注释）：协议面（非法 action/非 JSON/cancel 回可机读失败，79-140）、环境面（真 venv doctor 报真实版本与 pip check，找不到 venv 显式 SKIP，33-51/144-173）、**凭证面**（隔离 HOME 下输出不含 `api_key/sk-/credentials.json` 字样，63-67/177-208） |
| test-engine-bridge.mjs | `./lib/engine/openai-bridge.js` 的 `toLlmRequest/finishReasonToOpenAI/chunksToCompletion/sseFrame/chunksToSse/PLACEHOLDER_KEY_PATTERN/isPlaceholderKey`（19-27） | 纯转换两件最容易悄悄错的事（8-15 行注释）：OpenAI 请求 → DSH 请求——**tools 必须映射成 ToolSchema**，否则 agentic 工具循环退化成「模型说要调工具但永远调不到」（10-13）；DSH chunk → OpenAI 响应（非流式/流式**同源**、tool_calls 增量拼接、usage 互斥计数折算 219-225）；占位 key 边界（340-356）；assistant 历史消息必须带 `source`（宿主 forAdapter 读 `source.replayState`，纯单测抓不到的 1C 回归，358-400） |
| test-engine-llm-bridge.mjs | `./lib/engine/llm-bridge.js` 的 `startLlmBridge`（18） | 桥作为宿主凭证看门人的边界行为（2-15 行注释）：绑 `127.0.0.1` 随机端口、无/伪造占位 key 一律 401 且错误体不回显 key（68-89/211-220）、日志永不出现 Authorization（232-247）、上游失败 502 + OpenAI 错误体、流式必须以 `[DONE]` 收尾否则引擎 SSE 挂住（142）、客户端断连 → 上游 signal abort 省 token（249-272） |
| test-engine-process-tree.mjs | `./lib/engine/process-tree.js` 的 `isAlive/terminateProcessTree`（18） | **不 mock** 的真进程树测试（3-8 行注释：mock 掉的 process.kill 永远是对的）——根退出后孙进程必须死不留孤儿（78-100）、重复终止幂等（102-112）、非法 pid noop（69-76）、日志写明终止手段且不含凭证字样（114-128） |
| test-engine-quality-gate.mjs | `./lib/engine/quality-gate.js` 的 `gateNativeOutput/renderArticle/titleOf/yamlScalar/readCommittedBaseline/uncommittedSourceChanges/assessBaseline/toContractBlockers/toQualityIssues`（21-35） | 采用门（比阶段 2 更高一层：「页写成 wiki 文章还成立吗」）：缺入口 failed 不可写（138-145）、空壳页 skip 不进 rendered（147-156）、空模块树是 degradation 不是 defect 但仍不许 done/推基线（197-209）、**`judgeOutcome` 看不见来源证据缺失 → 必须经 `toQualityIssues` 喂入**（211-224）、未提交工作区不得当已提交基线（228-294）、`yamlScalar` 危险标题双读者语义一致（parseYamlLite 与 serde_yaml/JSON 转义，338-387） |
| test-engine-apply-plan.mjs | `./lib/engine/apply-plan.js` 的 `applyNativeOutput/checkWriteTargets/toApplyBlockers/verifyCommitScope` + 常量（14-25） | 原子应用四阶段 `APPLY_STAGES = ['write','index','baseline','commit']`（139-141）；写集白名单仅 `.codewiki` 与 `CodeWiki.md`（143-145）；不变量：索引/基线失败**回滚**（新文件删除、旧内容原样复原、305-338）、提交失败**不回滚**且终态 partial 绝不洗成 done（357-401/445-482）、`partial`/`unknown` 裁决不许被落地器洗白、基线不推进（445-482）；缺页静默成功的真实 cw 行为也拦（542-569）；`verifyCommitScope` 用真 git 判提交里到底有什么（601-648） |

**组 3 —— 端到端编排冒烟：test-orchestration.mjs（1551 行）**

mock 宿主 llm 服务（`llm.stream` 按 prompt 首行特征应答，插件零直连）+ 真实 cw CLI + 真实服务 tick。关键基建：

- 15| `process.env.DSH_CODEWIKI_TICK_MS = '300'` 压 tick 间隔加速；
- 22-23| `DSH_CODEWIKI_JOBS_FILE` 用 pid + 随机 token 命名（19-21 行注释：只用 pid 时 tmp 残留同名文件会在 pid 复用时被读入，让单项目串行误判——0.10.10 修复记录）；
- 44-45| `LEGACY_CHANNEL = { planMode:'dirs', agenticArticles:false, symbolIncremental:false }` 显式关掉三档新能力——本套几乎全部断言的是**旧通道**的请求次数与装填方式，不钉住会因「通道换了」而非「功能坏了」失败；
- 51| `makeCtx`：cordis 严格语义 mock（`inject` 传「ctx 切片」而非实例，70-71 行注释；`effect` 立即执行并收集 disposer，81-83 行注释）；
- 133| `llmProxy` 恒转发到 `activeLlm`，各测试块只需 `makeBatchMock()`（145）一处接线；
- 230| `waitJob`、245| `fakeReq`、255| `fakeRes`。

覆盖的 26 个场景（各 section 行号）：系统提醒布线与守护收紧（261-288：有 `.codewiki` 且根有 `CodeWiki.md` 才注入）、注册与 cw 工具（291-308）、`codewiki_update`/`commitHintText`（311-428）、`autoCommitWiki` 安全边界（431-531：正常分支合并式提交只含两个目标路径、非 git/被 ignore/合并中/缺 identity 拒绝、detached HEAD 降级、预占分支不误删）、`autoCommitState` 三态（534-543）、`wakeCompileSession`（546-581：插件已自动提交或产物无改动 → **零唤醒**）、本地规划零规划请求（584-640）、全量编译阶段机 + 自动提交落库核查（643-683）、横切精准拆分（686-713）、文章观察→合成分割（716-749）、单项目串行 queued/queueAhead/自动轮到（752-807）、并行项目上限（810-838）、全程宿主 llm 通道（841-872）、stale 逐篇更新恰好更新 2 篇（875-895）、`codewiki_progress`（898-933）、宿主重启按 prompt 快照重跑 + 旧 plan 任务迁移（934-991）、并发提交占位与 flush 合并不丢外部 job（994-1041）、面板端点 403 守卫/取消/进度透出（1044-1095）、排除清单（1098-1150）、knownRepos 独立于 job 历史（1153-1190）、workspaceOnly 过滤与非终态放行（1193-1253）、registry 抛错降级不过滤（1256-1283）、输出 schema 校验（1286-1323）、foreign 孤儿任务按停更超时接管（1326-1357）、全局会话聚合接口 + worktree 闸门（1360-1434）、空壳目录闸门与面板过滤（1437-1485）、编译模型缺失诚实报错不静默跑空（1488-1500）、严格 cordis 语义（1503-1524）、Temp 残留清理（1527-1543）。

**组 4 —— 元测试：test-wiki-anchors.mjs（403 行）**

校验 `.codewiki/` 文章自身的行号锚点（对流水线产物系统性幻觉行号的制度化反击，2-3 行注释）：

- **三基准并集**（41-55 行注释）：`编译基线版（.codewiki/_meta.yaml 的 last_compiled_commit） ∪ 工作区 ∪ HEAD` 任一解释得了该锚点即通过——只认工作区会把「改完未提交」窗口的 115 处正确锚点误判（44-47 行注释实测数据），只认双基准会在提交后失效（52-55 行注释：--strict 败数从 18 跳到 111）。实现：`readSourceFile`（57-78）、`compiledCommitForViews`（86-91）、`loadSource` 按**全文**去重缓存（96-118）。
- **新鲜度感知的硬/软两档**（8-28 行注释）：结构事实（行号越界/区间无序/越界）永远硬失败；同步事实（指向空行、符号未绑定、CHANGELOG 版本节）在源文件滞后于编译基线时降级软报告——`isFresh` 用逐字比较工作区与基线（135-149）。CHANGELOG 是追加式流水账，其锚点失败**永远**软报告（268-274、311-334）。
- 符号绑定（`symbolsOnLine` 187-202，`FILE_LIKE` 186 排除文件名伪符号）只在**单锚点行**校验，且按「锚点左侧最近分句边界」切分归属（335-392 行注释给出两个靠此消掉的真实反例）；「符号在文件里根本不存在」是铁证真错走 struct 硬失败，符号在但不在区间走 sync 可降级（370-389）。

## Architecture

```text
┌───────────────────── 浏览器半侧（client.js = @local/dsh-codewiki）─────────────────────┐
│  plugins.item 设置卡（order 30）          侧边栏面板（key='codewiki'，order 52）        │
│  ┌───────────────────────────┐   ┌────────────────────────────────────────────────┐  │
│  │ CodewikiCard              │   │ CodewikiPanel（Tab：总览/任务/会话/设置）       │  │
│  │  modelTrio·save·discard   │   │  ├ ReposTab      （repos 端点 10s 轮询）        │  │
│  │  useEfforts（档位目录）   │   │  ├ jobCard+stageBar（jobs 端点 2s 轮询+取消）   │  │
│  │  excludePaths 增删        │   │  └ SessionView   （sessions 端点 5s 轮询）      │  │
│  └─────────────┬─────────────┘   └───────────────────────────┬────────────────────┘  │
└────────────────┼─────────────────────────────────────────────┼───────────────────────┘
                 │ configForms.get('codewiki')                 │ apiGet / apiPost（仅回环）
                 │  .mutate / .subscribe / .getSnapshot        │ /api/codewiki/{jobs, control,
                 ▼                                             │  repos, sessions, sessions/item,
┌──────────────────────────────────────────────────────────────▼──────────────────────┐
│ 宿主半侧（index.js，见 [[index]]）：Config 服务('codewiki') + webServer + 编排服务    │
│ 阶段机：queued → articles → crosscut → compose → review → index → commit             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

测试套件按层对齐同一条垂直线：组 1 钉 `index.js` 与 `lib/` 纯函数（装填/增量/契约/聚类/符号）；组 2 钉 `lib/engine/` 的跨进程契约（Python 引擎协议、OpenAI 桥、产物映射、采用门、原子落地）；组 3 用 mock llm + 真 cw 走完整阶段机；组 4 反向校验 wiki 产物自身质量。

## Data Flow

**设置读写**：`Switch/Input` onChange → `setPath`（598-605）改 `draft` →「保存」→ `save()` 四道校验（768-789）→ `form.mutate(ops, snapshot.revision)`（799）→ 宿主 Config 服务持久化并热生效（38 行 intro：「此处设置经 configForms 热生效，无需重启」）。宿主侧值变更经 `form.subscribe` 回流，仅在 `revision` 前进时覆盖草稿（583-588）；`revision` 不符 → 「保存冲突」提示（121 行）。

**任务进度**：`CodewikiPanel` 每 2s `apiGet(JOBS_PATH)`（1443-1483），每次回包差分出 tps 窗口与批量 EWMA 速率（1454-1470）喂 `throughputBadge`；面板渲染（`stageBar`/`overallPct`/`jobCard` 等）只消费 job 自身字段（`stage`/`stageStartedAt`/`stageTimings`/`taskList`/`batchProgress`/`usage`/`autoCommit`/`queueAhead`）。取消：`POST CONTROL { action:'cancel', jobId }`（1488-1496）。

**仓库总览**：`ReposTab` 每 10s `apiGet(REPOS_PATH)`（1205-1209）；排除/恢复 = `form.mutate` 改 `excludePaths` → `POST control { action:'refresh' }` 失效服务端缓存 → 立即重拉（1214-1232）；stale 仓库「更新」= `POST control { action:'compile', cwd }`（1237）。

**会话记录**：`SessionView` 5s 列表轮询，选中后按 `(jobId, n)` 拉单条全文（1341-1367）。

**模型目录**：`MODELS_PATH` 一次拉 providers/models（562-573）；`useEfforts` 按 provider+model 拉 `EFFORTS_PATH`（622-653）；目录不可用逐级降级：provider 手填 → model 手填 → `GENERIC_EFFORTS` 通用档位 → 最终由 llmChat 剥档重试兜底（28-29、727-743）。

**测试侧**：每个脚本自建隔离环境——`fs.mkdtempSync` 临时目录、临时 git 仓库（test-change-set.mjs 23-42 的 `makeRepo`、test-orchestration.mjs 110 的 `makeFixtureRepo`）、独立 `DSH_CODEWIKI_JOBS_FILE`；mock 宿主服务后跑真实代码路径，结束按失败数以非零码退出。

## Connections

- [[index]] —— 宿主半侧（插件主体）：本文所有端点、`configForms` 命名空间、`cw`/`codewiki_generate`/`codewiki_progress`/`codewiki_update` 工具与编排服务阶段机的实现方；client.js 的 7 个路径常量（19-27）与其 `installWebServer` 注册一一对应。
- [[lib-agentic]]、[[lib-agentic-host]]、[[lib-articles-agentic]] —— agentic 写作通道与宿主适配层（test-agentic*.mjs、test-articles-agentic.mjs 守护）。
- [[lib-article-contract]] —— 文章契约闸门（test-article-contract.mjs、test-wiki-anchors.mjs 共用其 `parseFrontmatter`）。
- [[lib-engine]] —— FSoft 原生引擎适配层：`contract/mapping/client/manifest/output/openai-bridge/llm-bridge/process-tree/quality-gate/apply-plan` 与 `python/entry.py`（组 2 全部 test-engine-*.mjs 守护）。
- [[lib-cluster]]、[[lib-symbols]]、[[lib-graph-diff]] —— 语义聚类的 AST 提取、LLM 聚类与对拍基准。
- [[lib-change-set]]、[[lib-incremental]]、[[lib-update-planner]]、[[lib-update-record]] —— 变更集采集 → 符号级增量 → 增量计划 → 终态判定的 P0 链路。
- [[lib-articles-agentic]] 之外的旧通道装填/收割由 [[index]] 内的 `prepareArticleTasks`/`runRealtimeTasks` 承担（test-batch.mjs 是其主守护）。

## Known Issues

- **通用思考档位是尽力而为**：目录未声明 efforts 的模型（client.js 28-29 行注释）只能给 `GENERIC_EFFORTS` 手选；选了模型不支持的值靠 llmChat 兜底「剥档重试」，请求不失败但所选档位实际不生效。
- **自动提交的合并冲突路径**：合并冲突时产物保留在主题分支 `codewiki/wiki-<jobId>` 等手动合并（client.js 45 行 `autoCommitHint`）；test-orchestration.mjs 516-519 行注释也明确「真正的 add/add 冲突在黑盒测试里构造不出来」，该防御路径无单测覆盖。
- **test-orchestration.mjs 钉旧通道**：`LEGACY_CHANNEL`（44 行）显式关闭语义规划/agentic 写作/符号级增量三档——新通道的行为回归分别依赖 test-semantic-plan.mjs、test-agentic-host.mjs、test-incremental*.mjs；改通道时两套断言需同步。
- **硬编码的本机路径**：test-engine-output-real.mjs 32-37 与 test-engine-quality-gate.mjs 433-437 的 1C 真实产物路径（`E:/ik/.../.probe-fsoft/wiki_out_1c/docs`）、test-cwd-paths.mjs 8 的默认仓库路径——其他机器上相应测试整组 SKIP 或需 argv 覆盖。
- **环境依赖的 SKIP 面**：test-engine-python-entry.mjs 46-51（需 1A venv，`DSH_CODEWIKI_ENGINE_PYTHON` 可覆盖）、test-symbols.mjs 42-45（需 web-tree-sitter WASM）、test-worktree.mjs 30-36（需可用 git）、test-graphdiff.mjs 14-17（需先跑 `test-fixtures/gen-graphdiff-golden.py` 生成 golden，否则 exit 1）。
- **test-orchestration 的 tmp 残留史**：JOBS_FILE 仅用 pid 命名时会在 pid 复用后读入历史 fixture 任务（19-23 行注释，0.10.10 已用随机 token 修复）；Windows 上临时目录句柄延迟释放时部分清理走 `catch` 放弃（如 1039、1433、1548）。
- **test-wiki-anchors 的软报告窗口**：源码滞后于编译基线时，同步类失败（空行/符号未绑定/版本节）只能软报告（8-28、268-274 行注释）——真错误要等下次 `codewiki_generate` 重编译基线前移后才升级为硬断言；`--strict` 可立即按硬断言跑（136 行）。
- **面板轮询的边界**：`copyPath` 在剪贴板权限拒绝时静默无反馈（client.js 1502）；`ReposTab` 的「下次扫描」按「上次扫描 + 间隔」估算，60s 心跳带来同量级误差只能显示为约值（1262 行注释）。
