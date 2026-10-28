---
title: root
type: module
source_files:
  - client.js
  - .probe-inc.mjs
  - .probe-two-round.mjs
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
  - test-engine-native-incremental.mjs
  - test-engine-native-job.mjs
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
tags: [root, browser-client, sidebar-panel, settings, test-suite]
---

## Overview

仓库根目录（模块 `root`）承载 dsh-codewiki 插件的两类源码：

1. **`client.js`（1741 行）—— 浏览器半侧**，插件唯一的前端文件。经宿主的 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) {…} })`（`client.js:10-12`）加载，要求宿主提供 `slots` / `locale` / `configForms` 三个能力（`client.js:529`）。它有两个挂载点（`client.js:2-5`）：
   - 「插件」页 `plugins.item`（id=`codewiki`，`client.js:17`）—— 设置表单 `CodewikiCard`（`client.js:570`）；
   - 侧边栏面板 `main` + `sidebar.panellist`（key/id 均为 `codewiki`，`client.js:18`）—— 编译任务面板 `CodewikiPanel`（`client.js:1455`）。

   全部数据来自宿主半侧 webServer 的回环端点（`client.js:19-27` 定义了 7 个 `/api/codewiki/*` 路径常量）；设置读写经宿主 Config 服务的 `'codewiki'` 命名空间（`client.js:6`）。注册者 id 必须等于 `package.json` 的 `name`（client-modules 按 nearestPackage 校验，`client.js:7`）；插件自身不保存、不传递任何密钥。

2. **`test-*.mjs` ×33 —— 整个插件的测试套件**。每个测试是独立可执行脚本：`node test-xxx.mjs` 直跑，内部用 `check()` / `checkAsync()` 累计通过/失败并以退出码报告（如 `test-agentic.mjs:12-21`）。按层次分四组：纯函数/单元测试、agentic 写作通道测试、原生引擎（FSoft 迁移）契约与生产链测试、插件级编排冒烟。另有 `.probe-inc.mjs` 与 `.probe-two-round.mjs` 两份**临时探针**，头部注释明确「不提交」（`.probe-inc.mjs:1`、`.probe-two-round.mjs:1`）。

宿主半侧主入口 `index.js`、`lib/` 库与 `test-fixtures/` 夹具属其它模块；本文只在测试的 import 关系与客户端的端点契约处引用它们。

## Key Components

### client.js：加载外壳与常量

| 名称 | 行号 | 用途 |
| --- | --- | --- |
| `window.__ModuleLoader__.load` | `client.js:10` | 插件加载入口；`id: '@local/dsh-codewiki'`（`client.js:11`）必须与 `package.json` name 一致 |
| `factory(require)` | `client.js:12-15` | 取 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，解构 `Switch/Button/Input/Tag` |
| `NS` | `client.js:531` | `'codewiki'`：设置命名空间 = profile patch 条目 id；`configForms.get(NS)`（`client.js:535`）与 `ctx.locale.bind(NS)`（`client.js:531`）共用 |
| `KEY` | `client.js:18` | `'codewiki'`：面板 key；`main` 的 key 与 `sidebar.panellist` 的 id 必须一致（`client.js:552-561`） |
| `JOBS_PATH` | `client.js:19` | `GET /api/codewiki/jobs`：任务列表轮询 |
| `CONTROL_PATH` | `client.js:20` | `POST /api/codewiki/control`：仅回环；`cancel` / `compile` / `refresh` 三动作 |
| `PANEL_ORDER` | `client.js:21` | `52`，排在 dsh-hindsight-on-demand（50）之后 |
| `POLL_MS` | `client.js:22` | `2000`：任务轮询间隔 |
| `REPOS_PATH` | `client.js:23` | `GET /api/codewiki/repos`：仓库总览 |
| `SESSIONS_PATH` | `client.js:24` | `GET /api/codewiki/sessions`：会话记录列表（单任务 / 全局聚合） |
| `SESSIONS_ITEM_PATH` | `client.js:25` | `GET /api/codewiki/sessions/item`：单条 prompt/输出全文 |
| `MODELS_PATH` | `client.js:26` | `GET /api/codewiki/models`：模型目录（设置页级联下拉数据源） |
| `EFFORTS_PATH` | `client.js:27` | `GET /api/codewiki/model-efforts`：思考档位 |
| `GENERIC_EFFORTS` | `client.js:30` | 目录未声明档位时的通用档位 `['off','low','medium','high','xhigh','max']`；选错由 llmChat 兜底剥档重试（`client.js:28-29`） |
| `REPOS_POLL_MS` | `client.js:31` | `10000`：总览轮询间隔 |
| `ACTIVE_STAGES` | `client.js:33` | `['queued','articles','crosscut','compose','review','index','commit']`；queued 单列最前表示排队（`client.js:32`） |

### client.js：词典、样式与工具函数

- `zh()`（`client.js:35-221`）与 `en()`（`client.js:222-406`）：全量 UI 文案。约束见 `client.js:8`——词典值必须是字符串，若为函数 `t()` 会回退返回键名。
- 样式表（`client.js:408-503`）：`style.dataset.plugin = '@local/dsh-codewiki'`（`client.js:409`），含面板卡片、步骤条、徽标、会话视图等全部 `data-dscw-*` 规则；`client.js:505` 有 HMR/重复加载防堆叠守卫。
- `el(tag, props, ...children)`（`client.js:507-509`）：`React.createElement` 薄封装。
- `apiGet(p)`（`client.js:511-516`）：fetch + JSON 解析；`!res.ok` 时抛 `Error(body.error || HTTP n)`。
- `apiPost(p, data)`（`client.js:517-526`）：POST JSON，错误处理同上。

### client.js：apply(ctx)——挂载逻辑（`client.js:528-1739`）

- `inject: ['slots', 'locale', 'configForms']`（`client.js:529`）；`apply(ctx)` 在 `client.js:530`。
- `tBound = ctx.locale.bind(NS)`（`client.js:531`）；`ctx.effect(() => ctx.locale.register(NS, { zh: zh(), en: en() }), 'dscw: dictionaries')`（`client.js:532`）。
- `const form = ctx.configForms.get(NS)`（`client.js:535`）。
- 「插件」页挂载（`client.js:538-550`）：`mount` 注册 `plugins.item` 条目（`id: NS, order: 30`，`inject: () => ({ t: tBound })`，`client.js:539-545`）；宿主服务该命名空间期间才显形——优先走 `ctx.configForms.whileServed([NS], mount)`（`client.js:546-547`），否则直接 `mount()`（`client.js:549`）。
- 侧边栏面板挂载（`client.js:553-564`）：一次性注入两个 slot——`main`（`key: KEY` → `CodewikiPanel`，`client.js:555`）与 `sidebar.panellist`（`id: KEY, order: PANEL_ORDER` → `PanelIcon`，`client.js:556-561`）；disposers 数组统一清理（`client.js:554-563`）。

### client.js：CodewikiCard——设置卡片（`client.js:570-1058`）

状态与方法：

- 状态：`snapshot/draft/notice/error`（`client.js:573-576`）、模型目录 `catalog/catalogError`（`client.js:579-580`；拉不到时退回「手填」形态、不阻断保存，`client.js:577-578`）。
- 目录拉取 `useEffect`（`client.js:582-593`）：`apiGet(MODELS_PATH)`（`client.js:584`）；`data.ok === false` 时 `setCatalogError`（`client.js:587`）。
- 配置订阅 `useEffect`（`client.js:596-613`）：`form.getSnapshot()` + `form.subscribe(pull)`（`client.js:611`）；仅 `status === 'ready'` 且 `revision` 变化才用 `structuredClone(snap.value)` 覆盖草稿（`client.js:603-607`）。
- 摘要视图：`props?.view === 'summary'` 返回一行简介（`client.js:616`）。
- `setPath(key, value)`（`client.js:618-625`）：structuredClone 草稿后写单键。
- `dirty` memo（`client.js:627-630`）：`JSON.stringify` 比较草稿与快照。
- `selectedProvider` memo（`client.js:633-637`）：目录中未命中 = null = 手填形态。
- `useEfforts(provider, model)`（`client.js:642-673`）：自定义 hook；缓存键 `${p}\u0000${m}`（`client.js:674`），请求 `${EFFORTS_PATH}?provider=…&model=…`（`client.js:675`），返回 `{ for, efforts, defaultEffort, error, loading }`。`effortsState` / `bigEffortsState` 各一份（`client.js:674-675`）。
- `modelTrio({ pKey, mKey, eKey, state, allowEmptyProvider, providerPlaceholder })`（`client.js:680-784`）：提供商/模型/档位三字段渲染。换提供商清空模型与旧档位（`client.js:30-33`）；已配置但目录缺失的 provider 保留 `__custom` 选项（`client.js:708-711`）；模型目录缺失时回退手填 Input（`client.js:719-724`）；档位四分支：无 provider（`client.js:743-744`）、loading/error（`client.js:745-746`）、目录未声明 → `GENERIC_EFFORTS` 手动选（`client.js:747-763`）、有声明档位（`client.js:765-780`）。
- `save()`（`client.js:786-825`）：校验 `maxConcurrency` 1–8 整数（`client.js:788-792`）、`bigConcurrency` 0=跟随默认档/负值小数超顶拦截（`client.js:793-798`）、`agenticMaxSteps` 1–100（`client.js:799-804`）、`planMode` 白名单 `['auto','dirs']`（`client.js:805-809`）；然后按 25 个白名单键逐个 diff 出 `{op:'set', path:[key], value}` ops（`client.js:535-541`），`form.mutate(ops, snapshot.revision)`（`client.js:819`），`accepted ? saved : conflict`（`client.js:820`）。
- `discard()`（`client.js:827-831`）；loading/unavailable 态（`client.js:833-835`）。
- 渲染（`client.js:837-1057`）五个分区 + 保存条：运行区（`client.js:840-933`：`enabled`/`updateReminder`/`autoCommit`/`workspaceOnly` 开关，`maxConcurrency`/`bigConcurrency`/`parallelProjects`/`articleLanguage`/`binaryPath` 输入）、编译模型区（`client.js:935-950`：batch 三件套 + `sessionTier`）、大档模型区（`client.js:952-967`：big 三件套 `allowEmptyProvider: true` + `bigTokenBudget`）、编译流程区（`client.js:969-1014`：`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`）、调度与排除区（`client.js:1016-1048`：`autoUpdate`/`autoUpdateMin`/`excludePaths` textarea）。

`save()` 覆盖的全部配置键（`client.js:786` 白名单）：`enabled`、`binaryPath`、`maxConcurrency`、`bigConcurrency`、`serialProjects`、`parallelProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`workspaceOnly`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`planMode`、`agenticArticles`、`agenticMaxSteps`、`symbolIncremental`。

### client.js：面板渲染辅助（`client.js:1064-1210`）

- `stageLabel(stage)`（`client.js:1064`）：`stage` + 首字母大写拼词典键。
- `NATIVE_STAGE_KEYS`（`client.js:1067-1071`）：原生引擎八段契约阶段名 → 词典键；`articles/index/commit` 直接复用步骤条标签，避免同一阶段两种说法（`client.js:1072-1073`）。`nativeStageName(stage)`（`client.js:1072`）。
- `stateLabel`（`client.js:1074`）、`kindLabelOf`（`client.js:1075`）。
- `progressBar(done, total)`（`client.js:1076-1079`）。
- `repoName(cwd)`（`client.js:1080-1083`）：取路径最后两段（父目录/目录名），Temp 沙箱残留一眼可辨。
- `fmtMs`（`client.js:1084-1090`，h:mm:ss）、`fmtTok`（`client.js:1091-1096`，M/k 缩写）、`fmtDur`（`client.js:1097-1102`）、`fmtAgo`（`client.js:1103-1106`）。
- `Spark({ values })`（`client.js:1108-1120`）：纯 SVG polyline，数据来自面板侧 30 点滚动窗口（`client.js:1107`）。
- `stepName(s)`（`client.js:1124`）；`lastTimedStage(job)`（`client.js:1127-1130`）：过滤掉已删阶段（如 plan）的残留计时键，避免 `indexOf` 得 -1 导致失败时步骤条全熄（`client.js:1125-1126`）。
- `stageBar(job)`（`client.js:1131-1156`）：七段步骤条；`partial` 与 `done` 一样全绿（`client.js:1134-1136`），只有 failed/cancelled 在最后计时段标红/黄（`client.js:1150-1151`）；运行中阶段实时计时（`client.js:1144`）。
- `STAGE_WEIGHTS`（`client.js:1158`）：`{ queued: 0, articles: 0.63, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05, commit: 0.02 }`。
- `overallPct(job)`（`client.js:1159-1169`）：五阶段定权线性推进、阶段内按 `taskList` 完成数折算；封顶 99，`done/partial` 才 100（`client.js:1557`）。
- `throughputBadge(job, sparkOf, rateOf)`（`client.js:1172-1192`）：实时通道 tok/s + Spark（`client.js:1174-1178`）；批量通道 篇/分（EWMA 平滑）+ ETA（`client.js:1179-1187`）；无完成样本时显示执行时长（`client.js:1188-1189`）。
- `usageLine(job)`（`client.js:1194-1210`）：输入（提交时估算）/输出（响应实测）+ 按批量/实时分通道的请求数（`client.js:1209-1214`）+ `overTier2` 超预算红字（`client.js:1209`）。

### client.js：ReposTab / SessionView / CodewikiPanel / PanelIcon

- `ReposTab()`（`client.js:1213-1357`）—— 总览 Tab：
  - `pull`（`client.js:1222-1233`）：`inFlightRef` 防重叠，`setInterval(pull, REPOS_POLL_MS)`（`client.js:1236`）。
  - `toggleExclude(r)`（`client.js:1243-1261`）：直接改配置 `excludePaths`（与设置卡保存同链路 `form.mutate`，`client.js:1252`）；成功后 `apiPost(CONTROL_PATH, { action: 'refresh' })` 失效服务端缓存并重拉（`client.js:1254-1255`）。
  - `compile(cwd)`（`client.js:1263-1271`）：`POST control { action:'compile', cwd }`。
  - 渲染（`client.js:1276-1353`）：调度块（`client.js:1278-1305`，`nextScan = lastScan + interval` 估算 `client.js:1290-1303`）、repos 列表（状态色标 `client.js:1310`、stale 时给「更新」按钮 `client.js:1316-1321`、排除切换 `client.js:1322-1326`、lastJob 进度条 `client.js:1328-1349`；`partial` 也是终态 `client.js:1330-1331`）。
- `SessionView({ job, onClose })`（`client.js:1363-1453`）—— 会话视图：`global = !job`（`client.js:1365`）走全局聚合接口；列表 5s 轮询（`client.js:1386`），单任务带 `?jobId=`（`client.js:1377`）；选中后按 `(jobId, n)` 拉单条全文（`client.js:1392`）；行状态标记 running▸/done✓/error✗（`client.js:1440`）。
- `CodewikiPanel()`（`client.js:1455-1724`）—— 主面板：
  - 状态（`client.js:1457-1465`）：`jobs`（null=未拿到首轮）、`tab`（overview/tasks/sessions/settings）、`sessJob`（`setSessJob` 打开时切到 tasks Tab，`client.js:1464`）。
  - 采样引用（`client.js:1467-1470`）：`sparkRef`（jobId → tps 数组，上限 30，`client.js:1468`）、`batchRateRef`（jobId → `{at, completed, rate}`）；EWMA `rate = prev.rate*0.6 + inst*0.4`（`client.js:1495-1496`）。
  - 轮询 `useEffect`（`client.js:1472-1512`）：`inFlight` 防重叠（`client.js:1476`）、`apiGet(JOBS_PATH)`（`client.js:1479`）、差分采样（`client.js:1483-1499`）、`setInterval(pull, POLL_MS)`（`client.js:1510`）。
  - `mountedRef`（`client.js:1515-1516`）、`cancel(jobId)`（`client.js:1517-1525`，`POST control cancel`）、`copyPath`（`client.js:1526-1532`）。
  - `isActive(job)`（`client.js:1536`）；按 cwd 分组（`client.js:1539-1545`）；焦点任务 focus/rest（`client.js:1548-1551`：活动优先取最新，其余进「历史任务」折叠区）。
  - `jobCard(job)`（`client.js:1553-1670`）：meta 组装（写/败计数 `client.js:1581-1583`；native 通道附加行 `client.js:1172-1178`；partial 阻塞计数 `client.js:1131-1135`；`elapsedSplit` 把已用时拆排队/执行 `client.js:1194-1206`；autoCommit 三态 `client.js:1597-1606`，失败原因放 title 不塞 meta `client.js:1594-1596`；partial 的前 3 条阻塞 detail 放悬停 `client.js:1610-1614`）；渲染（kind Tag + 阶段徽标 + `throughputBadge` + 会话按钮 + 取消按钮 `client.js:1616-1634`、`stageBar`、queueAhead 在等谁 `client.js:1639-1642`、总进度条、`usageLine`、notes/活动流、error、taskList、wikiPath + 复制路径 `client.js:1660-1668`）。
  - 渲染主体（`client.js:1672-1723`）：`sessJob` 占满整页（`client.js:570-571`）；Tab 条（`client.js:1683-1690`）；`tab==='sessions'` 用 `job: null` 的全局 SessionView（`client.js:1693`）；`tab==='settings'` 内嵌 `CodewikiCard`（`client.js:1694`）；渲染构建期异常直接显形避免白屏（`client.js:1719-1723`；ReposTab 同样有 try/catch `client.js:1354-1356`）。
- `PanelIcon(props)`（`client.js:1726-1737`）：16×16 SVG「摊开的书」。

### client.js：消费的服务端数据形状（契约面）

| 对象 | 字段 | 消费位置 |
| --- | --- | --- |
| job 摘要 | `id, cwd, kind, stage, cancelRequested, channel, nativeStage, nativePercent, nativeResult.gate.outcome, nativeResult.apply.outcome, blockers[{kind,detail}], batchProgress{completed,total}, batchSubmittedAt, taskList[{name,state}], articles[{ok}], writtenCount, failedCount, tps, stageTimings{queued,…}, stageStartedAt, createdAt, updatedAt, finishedAt, usage{inputTok,outputTok,requests,batchRequests,realtimeRequests,overTier2}, notes[], error, wikiPath, autoCommit{committed,sha,branch,noChanges,reason}, queueAhead[]` | `client.js:1553-1670`（jobCard）、`client.js:1143-1210` |
| repos 行 | `cwd, state(missing/uncompiled/clean/stale/error), excluded, staleArticles, changedFiles, articleCount, lastJob` | `client.js:1276-1352` |
| scheduler 块 | `enabled, intervalMin, lastScan, lastError, scanning, lastScanRepos, lastScanSubmitted` | `client.js:1273-1304` |
| sessions 行 | `jobId, n, name, status(running/done/error), cwd, model, outputChars, inputTokens, startedAt` | `client.js:1436-1451` |
| session 单条 | `prompt, output, error` | `client.js:1409-1427` |
| 模型目录 | `{ok, providers[{id, name, models[{id,name}]}], error}` | `client.js:584-592` |
| 档位 | `{ok, efforts[{id,name,description}], defaultEffort, error}` | `client.js:653-668` |

### 测试套件总览

运行约定：需要隔离的测试自设 `DSH_CODEWIKI_JOBS_FILE`（含随机 token，见 `test-orchestration.mjs:22-23`）并把 tick 压到下限 `DSH_CODEWIKI_TICK_MS = '300'`（`test-orchestration.mjs:15`、`test-engine-native-job.mjs:28`、`test-engine-native-incremental.mjs:28`）；环境缺失的测试显式 `SKIP` 退出 0（见 Known Issues）。

### 测试明细：插件级功能（import 自 `./index.js`）

- **test-orchestration.mjs**（`test-orchestration.mjs:44` `import { name, apply, SESSIONS_DIR }`）：编排冒烟总纲。`LEGACY_CHANNEL`（`test-orchestration.mjs:45`）显式关闭三档新能力（`planMode:'dirs'`、`agenticArticles:false`、`symbolIncremental:false`），`batchCfg` 基线（`test-orchestration.mjs:133`）；`llmProxy` 转发 `activeLlm`（`test-orchestration.mjs:132-141`）；`makeBatchMock` 按 prompt 首行特征应答（`test-orchestration.mjs:145-227`）；`waitJob` 轮询 JOBS_FILE（`test-orchestration.mjs:230-243`）。覆盖块：系统提示提醒（`test-orchestration.mjs:259`）、注册（`test-orchestration.mjs:291`）、cw 工具（`test-orchestration.mjs:304`）、codewiki_update + commitHintText（`test-orchestration.mjs:311`）、autoCommitWiki 安全边界（`test-orchestration.mjs:431`：分支合并式/非 git/.gitignore/合并中/缺 identity/detached HEAD 降级/主题分支名占用）、autoCommitState 三态（`test-orchestration.mjs:534`）、wakeCompileSession（`test-orchestration.mjs:546`）、本地规划（`test-orchestration.mjs:584`）、全量编译阶段机（`test-orchestration.mjs:643`）、横切精准拆分（`test-orchestration.mjs:686`）、文章观察→合成分割（`test-orchestration.mjs:716`）、单项目串行（`test-orchestration.mjs:752`）、并行项目上限（`test-orchestration.mjs:810`）、宿主 llm 唯一通道（`test-orchestration.mjs:841`）、stale 逐篇更新（`test-orchestration.mjs:875`）、codewiki_progress（`test-orchestration.mjs:898`）、宿主重启重跑（`test-orchestration.mjs:934`）、并发提交占位 + flush 合并（`test-orchestration.mjs:994`）、面板端点与取消（`test-orchestration.mjs:1044`）、排除清单/repos/compile（`test-orchestration.mjs:1099`）、knownRepos（`test-orchestration.mjs:1153`）、workspaceOnly 过滤（`test-orchestration.mjs:1193`）、registry 异常防御（`test-orchestration.mjs:1256`）、输出 schema（`test-orchestration.mjs:1286`）、孤儿任务接管（`test-orchestration.mjs:1326`）、全局会话 + worktree 闸门（`test-orchestration.mjs:1360`）、空壳目录闸门（`test-orchestration.mjs:1437`）、编译模型缺失诚实报错（`test-orchestration.mjs:1488`）、严格 cordis 语义（`test-orchestration.mjs:1503`）、Temp 残留清理（`test-orchestration.mjs:1527`）。
- **test-sessions.mjs**（`test-sessions.mjs:8` `import { SESSIONS_DIR, listSessionRecords, readSessionRecord, pruneSessionRecords, listAllSessionRecords }`）：列表按 n 倒序、单条全文、全局聚合 jobId/limit/jobIds 过滤（`test-sessions.mjs:31-43`）、TTL 清理与幂等（`test-sessions.mjs:45-55`）、全过期目录移除（`test-sessions.mjs:57-63`）。
- **test-wiki-entry.mjs**（`test-wiki-entry.mjs:10` `import { ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus }`）：入口生成/绝不覆盖/英文文案/幂等（`test-wiki-entry.mjs:25-54`）、Windows 路径规范化（`test-wiki-entry.mjs:56-72`）。
- **test-worktree.mjs**（`test-worktree.mjs:11` `import { detectLinkedWorktree, isWorktreeCwd, hasCompilableSources, isDeadCompileTarget }`）：真实 git 建 linked worktree 三态（`test-worktree.mjs:38-53`）、布尔封装与缓存（`test-worktree.mjs:56-62`）、空壳目录（`test-worktree.mjs:64-70`）、dead 判定（`test-worktree.mjs:72-77`）。
- **test-prune-orphans.mjs**（`test-prune-orphans.mjs:10` `import { pruneOrphanModules }`）：全量删孤儿/失败文章保留（`test-prune-orphans.mjs:33-55`）、stale 一律不动（`test-prune-orphans.mjs:57-68`）、无 plan/空清单不删（`test-prune-orphans.mjs:70-85`）、concepts 与 `_architecture.md` 永不碰（`test-prune-orphans.mjs:87-96`）、slugify 与中文/斜杠/括号模块名匹配（`test-prune-orphans.mjs:115-149`）、删除失败记账不中断（`test-prune-orphans.mjs:153-181`）。
- **test-cwd-paths.mjs**（`test-cwd-paths.mjs:5` `import * as plugin`）：MSYS 路径归一化执行（`test-cwd-paths.mjs:32-45`）、Windows 路径 status 三态（`test-cwd-paths.mjs:48-57`）、不存在路径干净报错（`test-cwd-paths.mjs:62-69`）；`resolveBinary` 未导出只能间接验证（`test-cwd-paths.mjs:27-28`）。
- **test-semantic-plan.mjs**（`test-semantic-plan.mjs:175` `import { semanticPlan, localPlan, scanRepoFiles }`）：无模型降级（`test-semantic-plan.mjs:165-177`）、source_files 非空且存在（`test-semantic-plan.mjs:52-58`）、模块文件并集（`test-semantic-plan.mjs:60-69`）、LLM 聚类路径（`test-semantic-plan.mjs:71-112`）、坏 JSON/请求抛错降级（`test-semantic-plan.mjs:114-140`）、空仓库 fallback（`test-semantic-plan.mjs:142-149`）、`plan.graph` 可序列化且不带 `sourceCode`（`test-semantic-plan.mjs:151-172`）、slug 唯一（`test-semantic-plan.mjs:180-184`）。

### 测试明细：批量流水线与增量

- **test-batch.mjs**（`test-batch.mjs:7-13` `import { collectSources, …, validateArticleEnvelope } from './index.js'`）：`estimateTokens`（`test-batch.mjs:25`）、`collectSources` token 预算（`test-batch.mjs:32`）、`numberLines` 尾换行（`test-batch.mjs:48`）、`prepareArticleTasks` 装填/大档接管/观察批分割（`test-batch.mjs:55-132`）、`classifySessionTask` 三态（`test-batch.mjs:135`）、`buildSessionSteerText` 档位钉死（`test-batch.mjs:153`）、`runRealtimeTasks` 并发池/失败记账/大档分池限流/tps/取消（`test-batch.mjs:171-345`）、`localPlan`（`test-batch.mjs:348`）、`packArticles`（`test-batch.mjs:361`）、`scanRepoFiles` 黑名单（`test-batch.mjs:374`）、`listModelCatalog` 与 `/api/codewiki/models` 端点（`test-batch.mjs:410-462`）、`resolveModelEfforts` 与 `/api/codewiki/model-efforts`（`test-batch.mjs:465-516`）、内置直连通道已删除（`test-batch.mjs:519-521`）、`fixAnchors` 对抗用例（`test-batch.mjs:524-603`）、`validateArticleEnvelope`（`test-batch.mjs:606-636`）。
- **test-incremental.mjs**（`test-incremental.mjs:7-12`，import 自 `./lib/incremental.js`、`./lib/symbols.js`、`./lib/graph-diff.js`）：`slimGraph` 不含源码但固化 bodyHash（`test-incremental.mjs:31-47`）、纯注释变更用 codeHash 降级（`test-incremental.mjs:49-118`）、无实质变更跳过（`test-incremental.mjs:128-140`）、added/deleted/renamed（`test-incremental.mjs:142-225`）、`symbolFallback` 保守保留（`test-incremental.mjs:160-167`）、快照 io 与版本守卫（`test-incremental.mjs:193-214`）、`sameSnapshotContent`（`test-incremental.mjs:227-237`）。
- **test-incremental-e2e.mjs**（`test-incremental-e2e.mjs:7-8`）：真实目录端到端五场景——提取符号图（`test-incremental-e2e.mjs:43`）、快照落盘 `.codewiki/temp/symbol-graph.json`（`test-incremental-e2e.mjs:52`）、只改函数体重写/只改空白注释全跳过/签名变更/新增与删除源文件（`test-incremental-e2e.mjs:61-137`）、无 `.codewiki` 时安静返回 null（`test-incremental-e2e.mjs:139`）。
- **test-update-planner.mjs**（`test-update-planner.mjs:7-12`）：接口变更反向依赖波及（`test-update-planner.mjs:47-61`）、纯注释两篇 keep（`test-update-planner.mjs:63-73`）、实现细节不波及依赖方（`test-update-planner.mjs:75-86`）、新文件同模块路由与无归属 `needsFull`（`test-update-planner.mjs:88-134`）、删除/改名理由（`test-update-planner.mjs:136-162`）、缺 source_files → review（`test-update-planner.mjs:164-175`）、stale scan 死链/已删符号（`test-update-planner.mjs:177-210`）、fileLevel 降级（`test-update-planner.mjs:212-224`）、`buildModuleMap`/`migrateModuleMap`/`sameModuleMap`（`test-update-planner.mjs:256-280`）、`realChangedIds`（`test-update-planner.mjs:282-293`）。
- **test-update-record.mjs**（`test-update-record.mjs:11-14`）：`TERMINAL` 含 partial（`test-update-record.mjs:47`）、1 成功 19 失败 → partial 且不推进基线（`test-update-record.mjs:62-76`）、全部失败/缺页/unmapped/缺 sources/quality/index/取消各 blocker（`test-update-record.mjs:78-133`）、无变更 done（`test-update-record.mjs:135-140`）、full 无 plan 缺页（`test-update-record.mjs:142-152`）、`extraBlockers`（`test-update-record.mjs:154-162`）、`buildUpdateRecord`/落盘回读（`test-update-record.mjs:164-204`）。
- **test-change-set.mjs**（`test-change-set.mjs:11` `import { collectChangeSet } from './lib/change-set.js'`）：no-git/missing-base/unreachable-base 降级语义（`test-change-set.mjs:47-72`）、四路采集 committed/staged/unstaged/untracked + delete/rename（`test-change-set.mjs:84-139`）、去重（`test-change-set.mjs:141-150`）、`.codewiki/` 排除与 ignored 记账（`test-change-set.mjs:152-164`）、POSIX 规范化（`test-change-set.mjs:166-175`）、可注入 execFile（`test-change-set.mjs:177-194`）、可 JSON 序列化（`test-change-set.mjs:196-203`）。
- **test-graphdiff.mjs**（`test-graphdiff.mjs:7-10`）：与 FSoft 上游 Python 原版逐位对拍，基准 `test-fixtures/graphdiff-golden.json` 缺失即退出（`test-graphdiff.mjs:13-17`；由 `test-fixtures/gen-graphdiff-golden.py` 生成，`test-graphdiff.mjs:2-3`）；组件级 diff 的 body/edge/interface 分类与改名配对（`test-graphdiff.mjs:55-104`）。

### 测试明细：语义规划、符号与 agentic 通道

- **test-cluster.mjs**（`test-cluster.mjs:4-9`）：提示词结构（`test-cluster.mjs:44-62`）、`parseJsonLoose` JSON 抢救（`test-cluster.mjs:65-82`）、`parseClusterResponse` 丢弃不存在 id/去重（`test-cluster.mjs:85-107`）、`normalizeModuleName`（`test-cluster.mjs:113-118`）、启发式聚类与 `fillMissing`（`test-cluster.mjs:121-150`）、无 LLM 降级（`test-cluster.mjs:153-165`）、LLM 正常路径与漏组件补齐（`test-cluster.mjs:168-199`）、抛错/垃圾降级（`test-cluster.mjs:201-216`）、下钻（`test-cluster.mjs:219-267`）、`maxDepth` 多层递归（`test-cluster.mjs:270-343`）、超级分组（`test-cluster.mjs:362-402`）、`toPlanModules`（`test-cluster.mjs:405-414`）。
- **test-symbols.mjs**（`test-symbols.mjs:8-12`）：web-tree-sitter 不可用整档 SKIP（`test-symbols.mjs:42-45`）；JS/TS/Python/Go/Rust/Java/C#/C 符号提取（`test-symbols.mjs:48-211`）、语法错误/空文件/未知扩展（`test-symbols.mjs:213-226`）、import 依赖边（`test-symbols.mjs:228-269`）、插件自身源码自检（`test-symbols.mjs:271-286`）、`regexExtract` 正则兜底与降级记账（`test-symbols.mjs:288-351`）、语言表（`test-symbols.mjs:353-359`）。
- **test-agentic.mjs**（`test-agentic.mjs:4-8`）：`numberLines`/`safeRelPath`（`test-agentic.mjs:76-87`）、`read_code` 全文/行范围/越界（`test-agentic.mjs:89-129`）、`list_files`（`test-agentic.mjs:131-148`）、`edit_article` insert/str_replace/view（`test-agentic.mjs:151-207`）、工具循环全部路径（`test-agentic.mjs:210-453`：结果回灌、未知工具、坏 JSON、maxSteps、streamFn 抛错、abort、正文不覆盖、`generate_sub_module` 委派与安全桩）、`buildOpeningPrompt`（`test-agentic.mjs:456`）、`parseToolArgs` 围栏/夹取（`test-agentic.mjs:464-499`）、重复读去重（`test-agentic.mjs:501-540`）、CRLF 行尾保真（`test-agentic.mjs:542-561`）、字符上限（`test-agentic.mjs:563-571`）、隐藏 `node_modules`/`.git`（`test-agentic.mjs:573-587`）、负行号报错（`test-agentic.mjs:589-595`）、`buildToolset` 四工具（`test-agentic.mjs:597-600`）。
- **test-articles-agentic.mjs**（`test-articles-agentic.mjs:7`）：落盘（`test-articles-agentic.mjs:48-63`）、`generate_sub_module` 真递归写出子文章（`test-articles-agentic.mjs:66-98`）、重名加父前缀（`test-articles-agentic.mjs:100-124`）、`subDepth` 封顶 0/1/2（`test-articles-agentic.mjs:126-215`，顺序无关断言见 `test-articles-agentic.mjs:143-149`）、子失败父成功（`test-articles-agentic.mjs:217-245`）、池化汇总（`test-articles-agentic.mjs:248-293`）、`markBigAgenticTasks`（`test-articles-agentic.mjs:299-329`）、双池并行与 `resolveTaskRoute`（`test-articles-agentic.mjs:331-387`）、`sourceTokensOf` CJK 口径（`test-articles-agentic.mjs:389-397`）、`allowedWritePaths` 写集闸门四条（`test-articles-agentic.mjs:399-470`）。
- **test-agentic-host.mjs**（`test-agentic-host.mjs:6`）：裸消息↔宿主 Message 转换（`test-agentic-host.mjs:18-64`）、`makeHostStream` chunk 收流与 tools 透传（`test-agentic-host.mjs:79-134`）、`makeFsWorkspace` 越界拒绝（`test-agentic-host.mjs:142-168`）、消息 id 跨转换稳定（`test-agentic-host.mjs:171-184`）。
- **test-agentic-fallback.mjs**（`test-agentic-fallback.mjs:13-14`）：退回链三段——① `shouldFallBackFromAgentic` 严格过半判定（`test-agentic-fallback.mjs:27-51`）②重排任务带 `mission/articlePath` 才可被 `prepareArticleTasks` 装填（`test-agentic-fallback.mjs:59-98`）③执行器逐篇返回 Map、失败过半触发退回（`test-agentic-fallback.mjs:101-120`）。

### 测试明细：文章契约

- **test-article-contract.mjs**（`test-article-contract.mjs:12-16`）：头部注释列明真实仓库缺陷回归（重复 frontmatter、未闭合、坏 source_files，`test-article-contract.mjs:3-7`）；各 issue kind（`test-article-contract.mjs:36-149`）；`parseFrontmatter`/`parseYamlLite`/`extractSections`/`fencesBalanced`/`collectWikiLinks`（`test-article-contract.mjs:151-187`）；必需章节表按类型（`test-article-contract.mjs:189-194`）；分级 error（拒写）/warning（放行降 partial）（`test-article-contract.mjs:210-218`）；写集闸门 `makeWriteSet`/`isWritable`（`test-article-contract.mjs:220-232`）。

### 测试明细：原生引擎（FSoft 迁移）

- **test-engine-contract.mjs**（`test-engine-contract.mjs:14-30`）：契约版本/八段阶段序/终态集（`test-engine-contract.mjs:43-46`）、`engineResult` 不变量（`test-engine-contract.mjs:49-105`：done 不许带 blockers、partial 必带、数字归一、`engine.deps` 显式保留）、`engineProgress`（`test-engine-contract.mjs:107-114`）、`engineError`（`test-engine-contract.mjs:116-127`）、`validateEngineResult`（`test-engine-contract.mjs:129-143`）、`describeEngineResult`（`test-engine-contract.mjs:145-156`）、`mapFsoftOutput` 产物映射（`test-engine-contract.mjs:162-334`：overview→CodeWiki.md、`moduleSlug`、parent/leaf/artifact pageKind、source_files 只认真实证据、unmapped 不静默、slug 冲突、update_record）。
- **test-engine-client.mjs**（`test-engine-client.mjs:21-25`）：协议层十种破坏（`test-engine-client.mjs:39-154`：非 JSON 行/半行/未知 requestId/重复 result/cancel 后 late-result/CRLF/UTF-8 跨 chunk/超大行上限/版本常量）；进程层真实 spawn 假 python 引擎（夹具 `test-engine-client.mjs:158-218`、包装 `test-engine-client.mjs:220-241`），覆盖 garbage/noresult/failed-but-exit0/done-but-exit3/crash/slow 超时/late 取消/wrongid/连续调用隔离/命令不存在/中文空格 cwd（`test-engine-client.mjs:243-360`）。
- **test-engine-bridge.mjs**（`test-engine-bridge.mjs:19-27`）：`toLlmRequest` 请求映射（`test-engine-bridge.mjs:40-175`：system 槽、tool_calls 还原、tools→ToolSchema、参数映射、空 messages/缺 provider 抛错）；`chunksToCompletion`（`test-engine-bridge.mjs:181-268`：增量拼 arguments、DSH 互斥 TokenUsage 折算 `prompt_tokens`、reasoning 不混 content）；SSE（`test-engine-bridge.mjs:274-334`）；占位 key（`test-engine-bridge.mjs:340-356`）；assistant 消息必须带 `source` 的回归（宿主 `forAdapter` 读 `source.replayState`，`test-engine-bridge.mjs:358-415`）。
- **test-engine-llm-bridge.mjs**（`test-engine-llm-bridge.mjs:18`）：绑定 `127.0.0.1` 随机端口（`test-engine-llm-bridge.mjs:59-66`）、401/不回显 key（`test-engine-llm-bridge.mjs:68-89`）、非流式 usage 折算（`test-engine-llm-bridge.mjs:91-112`）、工具调用转发（`test-engine-llm-bridge.mjs:114-128`）、流式 `[DONE]` 收尾（`test-engine-llm-bridge.mjs:131-163`）、502/400（`test-engine-llm-bridge.mjs:165-196`）、`/v1/models`（`test-engine-llm-bridge.mjs:198-209`）、伪造 key（`test-engine-llm-bridge.mjs:211-220`）、`/healthz` 无凭证（`test-engine-llm-bridge.mjs:222-230`）、日志无 Authorization（`test-engine-llm-bridge.mjs:232-247`）、断连 abort 上游（`test-engine-llm-bridge.mjs:249-272`）、超时（`test-engine-llm-bridge.mjs:274-288`）、缺参抛错（`test-engine-llm-bridge.mjs:290-294`）。
- **test-engine-manifest.mjs**（`test-engine-manifest.mjs:10-19`）：`probeEnvironment`/`fingerprintOf`（pip check 不进指纹，`test-engine-manifest.mjs:36-63`）、`readLock` 容错（`test-engine-manifest.mjs:65-76`）、`compareLock` absent/match/drift/unhealthy（`test-engine-manifest.mjs:78-112`）、`writeLock`（`test-engine-manifest.mjs:114-142`）、`doctor` 五态（`test-engine-manifest.mjs:144-190`）。
- **test-engine-output.mjs**（`test-engine-output.mjs:12-19`）：`bodyLength`/`relativeLinks`（`test-engine-output.mjs:65-77`）、`collectOutput` 缺失/坏 JSON/更新记录（`test-engine-output.mjs:79-119`）、`validateOutput` 各 problem kind（`test-engine-output.mjs:121-217`）、`buildWritePlan` componentFiles 证据（`test-engine-output.mjs:219-227`）。
- **test-engine-output-real.mjs**（`test-engine-output.mjs:234-235` 同源 import；真实产物路径硬编码于 `test-engine-output-real.mjs:32`，不存在则 `process.exit(0)` 跳过 `test-engine-output-real.mjs:33-36`）：用 1C 全量编译真输出钉两个真实缺陷——hierarchical 布局子目录页必须被收集（`test-engine-output-real.mjs:97-114`）、whole-repository 模式 `module_tree={}` 时页进写集且 `source_files` 置空 `attribution=unattributed`（`test-engine-output-real.mjs:57-84`）。
- **test-engine-quality-gate.mjs**（`test-engine-quality-gate.mjs:21-38`）：done 路径（`test-engine-quality-gate.mjs:113-134`）、缺陷类（缺入口/空壳/编造来源/死链/坏 JSON，`test-engine-quality-gate.mjs:138-193`）、降级类 `empty-module-tree`/`no-source-evidence` 及 `toQualityIssues` 必须喂给 `judgeOutcome`（否则盲区判 done，`test-engine-quality-gate.mjs:197-224`）、基线判定 `readCommittedBaseline`/`assessBaseline`（未提交工作区不得当已提交基线，`test-engine-quality-gate.mjs:228-310`）、`renderArticle` 正文一字不动 + `yamlScalar` 危险 YAML 标题安全（`test-engine-quality-gate.mjs:314-393`）、`toContractBlockers`（`test-engine-quality-gate.mjs:397-428`）、真实产物组（`test-engine-quality-gate.mjs:431-502`）。
- **test-engine-apply-plan.mjs**（`test-engine-apply-plan.mjs:14-25`）：模块不变量（`test-engine-apply-plan.mjs:139-171`）、`checkWriteTargets` 写集校验（`test-engine-apply-plan.mjs:177-215`）、正常路径与 dryRun（`test-engine-apply-plan.mjs:221-258`）、拒写场景（`test-engine-apply-plan.mjs:260-299`）、index/baseline 失败回滚（`test-engine-apply-plan.mjs:305-351`）、提交失败不回滚（`test-engine-apply-plan.mjs:357-401`）、entryMode keep/overwrite（`test-engine-apply-plan.mjs:407-426`）、partial 不洗成 done（`test-engine-apply-plan.mjs:445-482`）、索引规范化与缺页（`test-engine-apply-plan.mjs:484-569`）、零注入（`test-engine-apply-plan.mjs:571-596`）、`verifyCommitScope` 真 git（`test-engine-apply-plan.mjs:601-648`）。
- **test-engine-process-tree.mjs**（`test-engine-process-tree.mjs:18`）：真实两层进程树（`test-engine-process-tree.mjs:32-43`）、孙进程必死不留孤儿（`test-engine-process-tree.mjs:78-100`）、重复终止幂等（`test-engine-process-tree.mjs:102-112`）、onLog 无凭证（`test-engine-process-tree.mjs:114-128`）。
- **test-engine-python-entry.mjs**（入口 `test-engine-python-entry.mjs:35`、`stage_map.py` `test-engine-python-entry.mjs:24`；`findPython` 找不到 1A venv 则 SKIP `test-engine-python-entry.mjs:35-51`）：协议面非法 action/非 JSON/cancel（`test-engine-python-entry.mjs:79-140`）、真 venv doctor 报真实版本与 pip check（`test-engine-python-entry.mjs:144-173`）、凭证面不泄漏 api_key（`test-engine-python-entry.mjs:177-208`）、阶段映射与 `ENGINE_STAGES` 同集合（`test-engine-python-entry.mjs:212-247`）。
- **test-engine-native-job.mjs**（`test-engine-native-job.mjs:57` `FAKE_ENGINE = test-fixtures/fake-native-engine.mjs`；`test-engine-native-job.mjs:38-39` import `apply`/`runNativeJob`；夹具 `makeRepo` `test-engine-native-job.mjs:57-93`、旧通道假 llm `legacyLlmFor` `test-engine-native-job.mjs:139-176`）：16 个生产接线用例——完整成功（`test-engine-native-job.mjs:259`）、首次编译不得伪 done（`test-engine-native-job.mjs:298`）、质量门拦下引擎自报 done（`test-engine-native-job.mjs:315`）、引擎 failed（`test-engine-native-job.mjs:329`）、协议破坏（`test-engine-native-job.mjs:341`）、环境缺失不跑引擎（`test-engine-native-job.mjs:351`）、锁漂移（`test-engine-native-job.mjs:368`）、index 失败回滚（`test-engine-native-job.mjs:386`）、基线失败（`test-engine-native-job.mjs:401`）、提交失败 partial（`test-engine-native-job.mjs:415`）、取消进程树终止（`test-engine-native-job.mjs:428`）、单项目串行（`test-engine-native-job.mjs:468`）、旧通道不受影响（`test-engine-native-job.mjs:496`）、stale 通道归属（`test-engine-native-job.mjs:507`）、假 runEngine + 真质量门（`test-engine-native-job.mjs:529`）、短路分支（`test-engine-native-job.mjs:564`）。
- **test-engine-native-incremental.mjs**（`test-engine-native-incremental.mjs:36-38` import `apply`/`runNativeJob`/`native-state`）：9 个统一增量生产链用例——两轮 full→stale update 且引擎经足迹证明读到持久化状态（`test-engine-native-incremental.mjs:189-242`）、无变化不重写不提交（`test-engine-native-incremental.mjs:246`）、四路 + delete/rename 被看见且未提交进 `unconsumed`（`test-engine-native-incremental.mjs:287`）、未提交变化两轮不丢（`test-engine-native-incremental.mjs:302`）、缺依赖图显式 full（`test-engine-native-incremental.mjs:332`）、base 不可达/版本不兼容显式 full（`test-engine-native-incremental.mjs:350`）、index/baseline 失败回滚状态、commit 失败不回滚（`test-engine-native-incremental.mjs:381-451`）、取消（`test-engine-native-incremental.mjs:455`）、旧通道不受影响（`test-engine-native-incremental.mjs:475`）。

### 测试明细：wiki 自校验与临时探针

- **test-wiki-anchors.mjs**：不是插件单元测试，而是校验 `.codewiki/` 下全部 `.md` 文章的行号锚点（`test-wiki-anchors.mjs:38`、扫描与判定 `test-wiki-anchors.mjs:224-277`）。三基准（工作区 ∪ HEAD ∪ 编译基线 `last_compiled_commit`）任一有效即通过（`test-wiki-anchors.mjs:41-56`、`test-wiki-anchors.mjs:96-118`）；新鲜度感知的软/硬两档（`test-wiki-anchors.mjs:124-149`、分档逻辑 `test-wiki-anchors.mjs:264-277`）；CHANGELOG 版本节语义校验（`test-wiki-anchors.mjs:157-167`、`test-wiki-anchors.mjs:311-334`，且永远软报告 `test-wiki-anchors.mjs:314-320`）；符号绑定只在唯一锚点行的分句内校验（`test-wiki-anchors.mjs:336-392`；多锚点行有意不绑定 `test-wiki-anchors.mjs:204-211`）；`--strict` 强制按新鲜处理（`test-wiki-anchors.mjs:39`、`test-wiki-anchors.mjs:136`）。
- **.probe-inc.mjs**（临时探针，不提交）：`DSH_CODEWIKI_TICK_MS='300'` 与独立 JOBS_FILE（`.probe-inc.mjs:14-17`）、动态 `import('./index.js')`（`.probe-inc.mjs:59`）、假引擎 `.probe-inc.mjs:15`、`nativeCfg` `.probe-inc.mjs:45`、经 `codewiki_generate` 提交并轮询（`.probe-inc.mjs:46-63`）、两轮打印 full/stale 事实（`.probe-inc.mjs:66-77`）；REPO 路径硬编码 `.probe-inc.mjs:8`。
- **.probe-two-round.mjs**（临时探针）：`import { runNativeJob } from './lib/engine/native-run.js'`（`.probe-two-round.mjs:11`）、假引擎 `.probe-two-round.mjs:10`、deps 注入 `.probe-two-round.mjs:27-31`、绕过 JobService 直调两轮（`.probe-two-round.mjs:38`、`.probe-two-round.mjs:60`）、打印引擎足迹 `.probe-two-round.mjs:69-70`。

## Architecture

```text
┌──────────────────── 浏览器半侧 client.js ────────────────────┐
│ CodewikiCard (570|) 设置表单   CodewikiPanel (1455|) 四Tab面板 │
│  │ configForms('codewiki') 读写   │ 轮询 jobs 2s / repos 10s   │
└──┼──────────────────────────────────┼─────────────────────────┘
   ▼ form.mutate → 宿主 Config 服务    ▼ GET /api/codewiki/jobs|repos|sessions
┌──────── 宿主半侧 index.js（installWebServer + JobService）────┐
│        POST /api/codewiki/control（cancel/compile/refresh）   │
└──────────────────────────▲───────────────────────────────────┘
                           │ import { … } from './index.js' / './lib/…'
┌──────────────────────────┴───────────────────────────────────┐
│ test-*.mjs ×33（node 直跑；check 计数；失败 exit 1）           │
│  单元/纯函数: symbols·cluster·graph-diff·incremental·         │
│               update-planner·update-record·change-set·batch   │
│  原生引擎: contract·client·openai-bridge·llm-bridge·manifest· │
│            output·quality-gate·apply-plan·process-tree·entry  │
│  生产链: native-job / native-incremental                      │
│    └► test-fixtures/fake-native-engine.mjs（真进程假引擎）     │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **任务进度流（面板）**：`apply` 注册 `main` slot 后 `CodewikiPanel` 挂载，`useEffect`（`client.js:1472`）起 2s 轮询 `apiGet(JOBS_PATH)`（`client.js:1479`）；服务端 summary 携带 `batchProgress/taskList/queueAhead/tps/usage`；面板做差分采样写入 `sparkRef`（tps 上限 30 点）与 `batchRateRef`（EWMA 速率，`client.js:1483-1499`），随后 `setJobs` 重渲染 `jobCard`/`stageBar`/`throughputBadge`。取消走 `apiPost(CONTROL_PATH, { action: 'cancel', jobId })`（`client.js:1520`）。
2. **设置读写流**：`CodewikiCard` 挂载读 `form.getSnapshot()`（`client.js:573`）并 `form.subscribe`（`client.js:611`）；用户经 `setPath`（`client.js:618`）改草稿；`save()` 校验（`client.js:786-809`）后 `form.mutate(ops, snapshot.revision)`（`client.js:819`）——经宿主 Config 服务 `'codewiki'` 命名空间热生效，无需重启（`client.js:570` intro 文案）。模型目录 `apiGet(MODELS_PATH)`（`client.js:584`）；思考档位 `useEfforts` → `EFFORTS_PATH`（`client.js:651`）。
3. **总览与调度流**：`ReposTab` 10s 轮询 `REPOS_PATH`（`client.js:23`）→ `repos[].state/staleArticles/lastJob`；stale 仓库给「更新」按钮 `compile(r.cwd)`（`client.js:1316-1321`）→ control `action:'compile'`；排除切换写 `excludePaths` 后 control `action:'refresh'` 失效服务端缓存（`client.js:1252-1255`）。
4. **会话记录流**：`SessionView` 5s 轮询（`client.js:1363`）；单任务带 `?jobId=`、全局不带（`client.js:25`）；点行后按 `(jobId, n)` 拉 `SESSIONS_ITEM_PATH` 单条全文（`client.js:1392`）。
5. **测试执行流**：每个 `test-*.mjs` 独立进程 `node test-xxx.mjs`，`check()/checkAsync()` 累计后 `process.exit(fails ? 1 : 0)`；需隔离的测试自设 `DSH_CODEWIKI_JOBS_FILE`（随机 token）与 `DSH_CODEWIKI_TICK_MS='300'` 加速服务 tick；原生生产链测试用 `nativeEnginePython: process.execPath` + `nativeEngineEntry: FAKE_ENGINE` 让 `lib/engine/client.js` 走真实 spawn/协议/gate/apply/git 链路（`test-engine-native-job.mjs:613-614`）。

## Connections

- [[index]] —— 宿主半侧主入口：本模块全部插件级测试的直接被测对象（`apply`/`installWebServer`/`semanticPlan`/`localPlan`/`pruneOrphanModules`/`autoCommitWiki`/`ensureWikiEntry` 等导出）。
- [[test-fixtures]] —— `fake-native-engine.mjs` 假引擎、`graphdiff-golden.json` 对拍基准与 `gen-graphdiff-golden.py` 生成脚本。
- [[lib-symbols]] · [[lib-cluster]] · [[lib-graph-diff]] · [[lib-incremental]] · [[lib-update-planner]] · [[lib-update-record]] · [[lib-change-set]] · [[lib-article-contract]] —— 语义规划与增量链的被测库（分别由 test-symbols / test-cluster / test-graphdiff / test-incremental* / test-update-planner / test-update-record / test-change-set / test-article-contract 覆盖）。
- [[lib-agentic]] · [[lib-articles-agentic]] · [[lib-agentic-host]] —— agentic 写作通道（test-agentic / test-articles-agentic / test-agentic-host / test-agentic-fallback）。
- [[lib-engine-contract]] · [[lib-engine-client]] · [[lib-engine-openai-bridge]] · [[lib-engine-llm-bridge]] · [[lib-engine-manifest]] · [[lib-engine-output]] · [[lib-engine-quality-gate]] · [[lib-engine-apply-plan]] · [[lib-engine-native-run]] · [[lib-engine-process-tree]] —— 原生引擎适配层（test-engine-* 系列逐一对应）。

## Known Issues

- **面板七步与引擎八段粒度不一致**：原生引擎的八段契约阶段与面板粗粒度七步不是一回事，混着显示会让人以为步骤条错了——引擎自报阶段另起一行（`client.js:138-139`、`client.js:1563-1564`）。
- **旧任务残留计时键**：旧任务可能残留已删阶段（如 plan）的 `stageTimings` 键，`indexOf` 得 -1 会让失败/取消时步骤条全熄——`lastTimedStage` 过滤兜底（`client.js:1125-1130`）。
- **partial 的显示语义**：`overallPct` 把 partial 按 100 显示、`stageBar` 不标红（`client.js:1131-1133`、`client.js:1159`）——「活干完了但完整性没成立」，依赖终态标签与 blockers 说明原因。
- **部分测试依赖本机绝对路径，缺失即 SKIP**：`test-engine-output-real.mjs:32` 与 `test-engine-quality-gate.mjs:433-434` 硬编码 `E:/ik/.../.probe-fsoft/wiki_out_1c/docs`；`test-engine-python-entry.mjs:39-41` 依赖 1A venv；`test-cwd-paths.mjs:8` 默认仓库路径；`.probe-inc.mjs:8` 同样硬编码。这些文件在其它机器上覆盖会静默缩水（SKIP 打印后 exit 0，如 `test-engine-output-real.mjs:33-36`）。
- **JOBS_FILE 残留竞态（已修复但需知悉）**：`test-orchestration.mjs:19-23` 记录了只用 pid 命名时 pid 复用会读到历史 fixture、导致「偶发 20 项失败」；现用随机 token 命名并在收尾删除。
- **首次编译的 baseline-uncommitted**：无 wiki 仓库首次编译产生的 `.codewiki/_meta.yaml` 是未提交文件，质量门判 `baseline-uncommitted` → 终态 partial（`test-engine-native-job.mjs:73-80` 注释，阶段 5 已知真实限制；测试用 `preInit` 夹具规避）。
- **test-wiki-anchors 的启发式边界**：多锚点行有意不做符号绑定（`test-wiki-anchors.mjs:204-211`）；CHANGELOG 版本节失败永远软报告（`test-wiki-anchors.mjs:314-320`）。
- **test-graphdiff 依赖外部生成步骤**：缺 `test-fixtures/graphdiff-golden.json` 时直接 `process.exit(1)`（`test-graphdiff.mjs:14-17`），需先跑 `python test-fixtures/gen-graphdiff-golden.py`。
- **词典值类型约束**：client.js 词典值必须是字符串；若写成函数，`t()` 会回退返回键名（`client.js:8`）。
- **面板为纯轮询**：任务 2s（`client.js:1221`）、总览 10s（`client.js:31`）、会话 5s（`client.js:1386`），无服务端推送；`inFlight`/`inFlightRef` 防重叠但不防抖动。
- **环境型 SKIP 清单**：`test-symbols.mjs:42-45`（tree-sitter 缺失）、`test-worktree.mjs:30-36`（git 不可用）、`test-engine-python-entry.mjs:46-51`（无 venv）、`test-engine-output-real.mjs:33-36` 与 `test-engine-quality-gate.mjs:436-438`（无真实产物）——CI 需注意这些是覆盖盲区而非通过。