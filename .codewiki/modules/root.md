---
title: root
type: module
source_files:
  - client.js
  - index.js
  - .probe-idxfail.mjs
  - .probe-inc.mjs
  - .probe-nochange-commit.mjs
  - .probe-nochange.mjs
  - .probe-two-round.mjs
  - .probe3.mjs
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
tags: [root, client, dsh-codewiki, tests, probes]
---

## Overview

仓库根目录是 dsh-codewiki 插件的「门面 + 质量防线」所在，由三部分组成：

1. **`client.js`（约 1741 行）—— 插件的客户端半侧（浏览器端）**。它通过 `window.__ModuleLoader__.load`（`client.js:10`）以 `@local/dsh-codewiki` 身份注册到 dsh 宿主的模块系统，挂载两个 UI 出入口：插件设置页条目（`plugins.item`，id 为 `codewiki`）与侧边栏编译任务面板（`main` + `sidebar.panellist`）。所有数据来自宿主半侧（`index.js`）注册的仅回环 HTTP 端点（`GET /api/codewiki/jobs`、`POST /api/codewiki/control` 等），设置读写经宿主 Config 服务命名空间 `codewiki`，**插件端不持有任何模型凭证**（`client.js:1-8` 头注释）。

2. **35 个 `test-*.mjs` 测试脚本**，构成从「宿主编排冒烟」到「原生引擎跨进程契约」再到「wiki 产物行号锚点自检」的完整测试矩阵。它们按迁移阶段（阶段 0–5）与子系统分层，多数完全离线（注入假 llm / 假引擎），少数依赖真实 git、真实 Python venv 或真实 FSoft 编译产物（缺失时 SKIP）。

3. **6 个 `.probe-*.mjs` 临时探针脚本**，用于诊断原生引擎增量链路的具体疑点（index 失败后 HEAD 为何前移、无变化轮提交了什么、两轮 update 是否真的进 update 分支等）。文件头注释明确标注「跑完即删」「不提交」（如 `.probe-idxfail.mjs:1`、`.probe-inc.mjs:1`），属于排查期产物。

插件整体语义：维护各仓库 `.codewiki/` 目录下随仓库提交的活 wiki（入口 `CodeWiki.md`），由会话工具 `codewiki_generate` 提交编译任务，服务端阶段机推进，模型请求全部经宿主 llm 服务（插件零直连），可选启用 FSoft 原生引擎（lib/engine/ 适配层）。

## Key Components

### client.js —— 浏览器半侧

#### 装载入口与常量

- `client.js:10-12`：`window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) {...} })`。id 必须等于 `package.json` 的 name——client-modules 按 nearestPackage 的 name 校验注册者（`client.js:7`）。
- `client.js:13-15`：`require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')`，解构 `Switch, Button, Input, Tag`。

| 常量 | 行号 | 用途 |
| --- | --- | --- |
| `NS` | `client.js:17` | 设置命名空间 / profile patch 条目 id，值 `'codewiki'` |
| `KEY` | `client.js:18` | 面板 key；`sidebar.panellist` 的 id 必须与它一致 |
| `JOBS_PATH` / `CONTROL_PATH` | `client.js:19-20` | 任务列表与控制（取消/编译/刷新）端点 |
| `PANEL_ORDER = 52` | `client.js:21` | 面板排在 dsh-hindsight-on-demand（50）之后 |
| `POLL_MS = 2000` | `client.js:22` | 任务面板轮询间隔 |
| `REPOS_PATH` / `SESSIONS_PATH` / `SESSIONS_ITEM_PATH` | `client.js:23-25` | 仓库总览 / 会话列表 / 会话单条全文端点 |
| `MODELS_PATH` / `EFFORTS_PATH` | `client.js:26-27` | 模型目录与思考档位端点 |
| `GENERIC_EFFORTS` | `client.js:30` | 目录未声明档位时的通用档 `['off','low','medium','high','xhigh','max']`；选错档由 llmChat 兜底剥档重试（`client.js:28-29`） |
| `REPOS_POLL_MS = 10000` | `client.js:31` | 总览轮询间隔 |
| `ACTIVE_STAGES` | `client.js:33` | 七段活动阶段 `['queued','articles','crosscut','compose','review','index','commit']`；queued 单列最前（单项目串行时后提交项目在此等待） |

#### 词典 `zh()` / `en()`

- `client.js:35-221`（中文）、`client.js:222-406`（英文）。词典值必须是字符串——若为函数 `t()` 会回退返回键名（`client.js:8`）。
- 关键词条：设置项文案（`enabled`/`autoCommitHint` 45 行长文、`planMode`、`agenticArticles`、`symbolIncremental`、`bigTokenBudget`、`autoUpdateMin`、`excludePaths` 等）；阶段文案 `stageQueued…stageCancelled`（`client.js:127-137`）；原生引擎八段阶段名映射说明（`client.js:138-148`，引擎八段与面板七步「不是一回事」）；状态文案 `stateMissing/stateUncompiled/stateClean/stateStale/stateError`（`client.js:170-174`）。

#### 样式与基础工具

- `client.js:408-505`：构造 `<style data-plugin="@local/dsh-codewiki">`，全部选择器以 `data-dscw-*` 属性锚定（页面/面板/步骤条/徽标/会话行等）；`client.js:505` HMR/重复加载时按选择器去重，避免样式表堆叠。
- `el(tag, props, ...children)`（`client.js:507-509`）：`React.createElement` 薄封装。
- `apiGet(p)`（`client.js:511-516`）/ `apiPost(p, data)`（`client.js:517-526`）：fetch 封装，`!res.ok` 时抛 `body.error || HTTP <status>`。

#### `apply(ctx)` —— 挂载点（`client.js:528-564`）

- `inject: ['slots', 'locale', 'configForms']`（`client.js:529`）。
- `client.js:531-532`：`ctx.locale.bind(NS)` + `ctx.locale.register(NS, { zh: zh(), en: en() })`。
- `client.js:535`：`form = ctx.configForms.get(NS)`——设置读写全部经它。
- 插件页条目（`client.js:537-550`）：`ctx.slots.register({ name:'plugins.item', id:NS, order:30, ... }, CodewikiCard)`；宿主支持 `configForms.whileServed` 时（`client.js:546-547`）仅在宿主服务该命名空间期间显形（插件停用时设置页不残留）。
- 侧边栏面板（`client.js:552-564`）：`ctx.slots.inject('main', ... key:KEY ..., CodewikiPanel)` + `ctx.slots.inject('sidebar.panellist', ... id:KEY, order:PANEL_ORDER ..., PanelIcon)`，返回统一 disposer。

#### `CodewikiCard(props)`（`client.js:570-1058`）—— 设置表单

| 成员 | 行号 | 说明 |
| --- | --- | --- |
| 组件状态 | `client.js:573-580` | `snapshot/draft/notice/error/catalog/catalogError` |
| 模型目录拉取 | `client.js:582-593` | `useEffect` GET `MODELS_PATH`；失败置 `catalogError`，表单退回「手填 provider/model」形态（不阻断保存） |
| 配置快照订阅 | `client.js:596-613` | `form.subscribe(pull)`；仅 `snap.revision` 变化时 `structuredClone(snap.value)` 覆盖草稿（`client.js:604-606`），避免用户输入被回写冲掉 |
| 摘要视图 | `client.js:616` | `props.view === 'summary'` 时返回一行简介 |
| `setPath` | `client.js:618-625` | 不可变更新 draft 的单键 |
| `dirty` | `client.js:627-630` | `JSON.stringify` 比对 draft 与 snapshot.value |
| `useEfforts(provider, model)` | `client.js:642-673` | Hook：GET `EFFORTS_PATH?provider&model`，返回 `{for, efforts, defaultEffort, error, loading}`；普通档与大档各调一份（`client.js:674-675`） |
| `modelTrio` | `client.js:680-784` | provider/model/effort 三联渲染：换 provider 清空 model 与旧档位（`client.js:30-33`）；目录里没有的 provider/model 保留 `__custom` 选项防静默丢配置（`client.js:708-711`、`client.js:732`）；模型未声明档位时给 `GENERIC_EFFORTS` 手选（`client.js:747-763`） |
| `save()` | `client.js:786-825` | 校验：`maxConcurrency` 1–8（788-792）、`bigConcurrency` 0 或 1–8（794-798，0=跟随默认档）、`agenticMaxSteps` 1–100（800-804）、`planMode` 仅 `['auto','dirs']`（806-809）；对 25 个键（`client.js:812`）diff 出 `{op:'set'}` 列表后 `form.mutate(ops, snapshot.revision)`；`accepted=false` → 冲突提示（820） |
| `discard()` | `client.js:827-831` | 还原草稿 |
| 表单渲染 | `client.js:837-1057` | 五节：运行（启用/提醒/自动提交/工作区过滤/并发/串行/并行/语言/binaryPath）、编译模型（+ `sessionTier`，940-948）、大档模型（+ `bigTokenBudget`）、编译流程（planMode/agentic/agenticMaxSteps/symbolIncremental）、调度与排除（autoUpdate/autoUpdateMin/excludePaths 文本域 1039-1044）、保存条（1050-1056） |

#### `CodewikiPanel()`（`client.js:1455-1724`）—— 任务面板

| 成员 | 行号 | 说明 |
| --- | --- | --- |
| 状态 | `client.js:1457-1465` | `jobs`（null=未拿到首轮）/`err`/`busyId`/`tab`（默认 `'overview'`）/`sessJob`/`copiedPath` |
| 采样 refs | `client.js:1466-1470` | `sparkRef`（jobId→tps 数组）、`batchRateRef`（jobId→`{at, completed, rate}`）——面板侧 2s 轮询差分 |
| 轮询 effect | `client.js:1472-1512` | 每 `POLL_MS` GET `JOBS_PATH`；`inFlight` 防请求重叠（1476）；tps 压入 30 点滚动窗口（1484-1489）；批量速率 EWMA：`rate = prev.rate*0.6 + inst*0.4`（1494-1497） |
| `mountedRef` | `client.js:1515-1516` | 卸载后不再 setState（轮询回包可能晚于卸载） |
| `cancel(jobId)` | `client.js:1517-1525` | POST `CONTROL_PATH {action:'cancel'}` |
| `copyPath` | `client.js:1526-1532` | 剪贴板复制 wiki 路径，1.5s 后还原按钮文案 |
| 分组/焦点 | `client.js:1539-1551` | 按 cwd 分组组内最新在前；focus = 活动任务按 `updatedAt` 最新者，否则全部任务最新者；其余收进「历史任务」折叠区 |
| `jobCard(job)` | `client.js:1553-1670` | 见下 |
| 渲染 | `client.js:1672-1723` | Tab 条（overview/tasks/sessions/settings，1683-1690）；tasks 渲染焦点卡 + 按 cwd 分组的历史 `<details>`（1695-1716）；渲染异常整体显形防白屏（1719-1723） |

`jobCard` 内部要点：

- 计数 meta：`已写 okCount/total`、`failedCount`（`client.js:1559-1562`）。
- 原生通道：活动期显示 `引擎阶段 <名> <百分比>`（八段名经 `NATIVE_STAGE_KEYS` 映射，`client.js:1067-1071`）；终态显示质量门/落地结果（1568-1570）。面板七步与引擎八段**有意分开显示**（`client.js:138-139`、1563-1564 注释）。
- `elapsedSplit`（`client.js:1581-1585`）：排队时长取 `stageTimings.queued`，执行时长 = 总时长 − 排队——避免「2 小时排队被看成编译跑了 2 小时」（1579-1580 注释）。
- 自动提交三态（`client.js:1598-1606`）：`committed` → sha+分支；`noChanges` → 「产物无改动，未提交」；否则「产物未自动提交」，失败原因放行 title（`acTitle`，1596-1604）。
- partial 阻塞：`未消化 N 项` 入 meta，前 3 条阻塞原因拼 `blockTitle` 悬停显示（`client.js:1610-1614`）。
- queued 可见性：`queueAhead` 显示「在等谁」（`client.js:1639-1642`，服务端注入）。
- 总进度条 `overallPct`（`client.js:1643`）；用量行 `usageLine`（1644）；notes 尾条 + 活动流 `<details>`（1645-1652）；taskList 明细（1654-1659）；wikiPath + 复制按钮（1660-1668）。

#### 渲染辅助（面板级）

| 函数/常量 | 行号 | 说明 |
| --- | --- | --- |
| `stageLabel`/`stateLabel`/`kindLabelOf` | `client.js:1075`、`1074`、`1075` | 词典键拼接 |
| `NATIVE_STAGE_KEYS` | `client.js:1067-1071` | 引擎八段 → 面板标签：`env→nativeEnv, graph→nativeGraph, cluster→nativeCluster, articles→stageArticles, validate→nativeValidate, index→stageIndex, baseline→nativeBaseline, commit→stageCommit` |
| `progressBar(done,total)` | `client.js:1076-1079` | 百分比条 |
| `repoName(cwd)` | `client.js:1080-1083` | 取路径末两段（父目录/目录名），Temp 沙箱残留一眼可辨 |
| `fmtMs`/`fmtTok`/`fmtDur`/`fmtAgo` | `client.js:1084-1106` | 时长/ token（k/M 缩写）/分钟级时长/「N 前」 |
| `Spark` | `client.js:1108-1120` | tps 微趋势 SVG polyline；<2 个有效值返回 null |
| `stepName`/`lastTimedStage` | `client.js:1127`、`1127-1130` | 旧任务可能残留已删阶段（如 plan）的计时键，须过滤到 `ACTIVE_STAGES`，否则 `indexOf` 得 -1 导致失败不标红 |
| `stageBar(job)` | `client.js:1131-1156` | 七段步骤条：完成绿点（title 带各阶段耗时）、当前实心点+实时计时；**partial 与 done 一样视为全跑完**（1134-1136），只有 failed/cancelled 在最后计时段标红/黄 |
| `STAGE_WEIGHTS`/`overallPct` | `client.js:1158-1169` | 权重 `{queued:0, articles:0.63, crosscut:0.1, compose:0.05, review:0.15, index:0.05, commit:0.02}`；阶段内按 taskList 完成数折算，封顶 99，done/partial 才 100（1163、1168） |
| `throughputBadge` | `client.js:1172-1192` | 实时通道 tok/s+Spark；批量通道 篇/分+ETA；无样本时显示批量已运行时长 |
| `usageLine` | `client.js:1194-1210` | 输入（提交时估算）/输出（实测）/请求数（批量+实时分列），`overTier2` 超档请求数红字 |

#### `ReposTab()`（`client.js:1213-1357`）—— 总览 Tab

- 轮询 `REPOS_PATH` 每 10s（端点 `client.js:23`、间隔 `client.js:1221`），`inFlightRef` 防重叠（1221-1224）。
- `toggleExclude(r)`（`client.js:1243-1261`）：直接改插件配置 `excludePaths`（按 `/[\n;，,]+/` 拆分、大小写/尾斜杠归一比较），`form.mutate` 成功后 POST `control {action:'refresh'}` 使服务端总览缓存失效并立即重拉。
- `compile(cwd)`（`client.js:1263-1271`）：POST `control {action:'compile', cwd}`。
- 调度块（`client.js:1277-1305`）：开/关、间隔、上次扫描与错误、下次扫描估算（`lastScan + intervalMin*60000`，60s 心跳有同量级误差，注释 1291）。
- 仓库行（`client.js:1308-1351`）：状态色映射（1310：clean→done、stale→stale、error→failed、其余 cancelled）；stale 时「更新」按钮（1316-1321）；排除/取消排除（1322-1326）；lastJob 元信息——**partial 也视为终态**，否则已结束任务会被误判「在跑」（1330-1331 注释）。

#### `SessionView({job, onClose})`（`client.js:1363-1453`）—— 会话视图

- `global = !job`：单任务（1.1.0）与全局聚合（1.2.0）共用；列表 5s 轮询，per-job 带 `?jobId=`（`client.js:1370-1388`）。
- 选中行按 `(jobId, n)` 拉 `SESSIONS_ITEM_PATH` 全文（`client.js:1389-1396`）。
- 列表行（`client.js:1435-1451`）：状态标 ▸/✓/✗；全局模式行内带 jobId、cwd 末段仓库目录名、model、`~Nk ch` 输出、`in Nk tok`、开始时间。
- 详情（`client.js:1409-1428`）：prompt 折叠 `<details>` + 模型输出全文。

#### `PanelIcon(props)`（`client.js:1726-1737`）

摊开的书形 SVG（16×16，两段 path），作为 `sidebar.panellist` 出入口图标。

### 测试矩阵（test-*.mjs）

| 测试文件 | 守护对象 | 运行方式 |
| --- | --- | --- |
| `test-orchestration.mjs` | `index.js` 服务编排全链 | mock 宿主 llm + 真实 cw CLI + 真实服务 tick（300ms） |
| `test-batch.mjs` | `index.js` 导出的批量编译纯函数 + `runRealtimeTasks` + web 端点 | 纯函数 + mock llm，全离线 |
| `test-engine-contract.mjs` | `lib/engine/contract.js`、`lib/engine/mapping.js` | 纯函数（阶段 0 契约） |
| `test-engine-output.mjs` | `lib/engine/output.js` 产物解析/校验 | 临时目录合成 docs 树 |
| `test-engine-output-real.mjs` | 同上 + 真实 FSoft 产物 | 读 `.probe-fsoft/wiki_out_1c/docs`，缺失即 SKIP（33-36） |
| `test-engine-bridge.mjs` | `lib/engine/openai-bridge.js` 纯转换 | 纯函数（OpenAI ↔ DSH 双向映射） |
| `test-engine-llm-bridge.mjs` | `lib/engine/llm-bridge.js` 服务器边界 | `startLlmBridge` + 假 llm.stream |
| `test-engine-client.mjs` | `lib/engine/client.js` 协议层 + 进程层 | 协议纯函数 + 真实 Python 子进程（`FAKE_MODE` 破坏矩阵） |
| `test-engine-manifest.mjs` | `lib/engine/manifest.js` 环境指纹/锁/doctor | 注入 probe 桩 + 临时目录 |
| `test-engine-process-tree.mjs` | `lib/engine/process-tree.js` | **真实进程树**（根+孙进程，真杀） |
| `test-engine-python-entry.mjs` | `lib/engine/python/entry.py`、`stage_map.py` | 真实 venv（`DSH_CODEWIKI_ENGINE_PYTHON` 或 `.probe-fsoft/venv`），缺失 SKIP（46-51） |
| `test-engine-quality-gate.mjs` | `lib/engine/quality-gate.js` 采用门 | 真 git 临时仓库 + 合成/真实产物 |
| `test-engine-apply-plan.mjs` | `lib/engine/apply-plan.js` 原子应用 | 注入桩（真 git 仅用于 `verifyCommitScope`） |
| `test-engine-native-job.mjs` | 阶段 4 生产接线（JobService → 原生通道） | 假引擎 `test-fixtures/fake-native-engine.mjs` 为**真进程**，16 用例 |
| `test-engine-native-incremental.mjs` | 阶段 5 统一增量生产链 | 同上，9 用例 |
| `test-agentic.mjs` | `lib/agentic.js` 工具循环 | 假 `streamFn`，全离线 |
| `test-agentic-host.mjs` | `lib/agentic-host.js` 消息/FS 适配 | 纯函数 + 假 stream |
| `test-articles-agentic.mjs` | `lib/articles-agentic.js` 执行器/子模块递归/双池/写集 | 真 FS 临时目录 + 假 streamFn |
| `test-agentic-fallback.mjs` | agentic→单轮退回链 | `shouldFallBackFromAgentic`/`prepareArticleTasks`/`runAgenticArticles` |
| `test-incremental.mjs` | `lib/incremental.js` 符号级增量判定 | `extractRepoGraph` 真提取，离线 |
| `test-incremental-e2e.mjs` | 快照落盘→判定→是否重写端到端 | 真实目录 |
| `test-update-planner.mjs` | `lib/update-planner.js` 增量计划器（P0-3） | 真 AST 图 + import 边 |
| `test-update-record.mjs` | `lib/update-record.js` 终态判定（P0-2） | 纯函数 + 落盘回读 |
| `test-change-set.mjs` | `lib/change-set.js` 四路变更集（P0-1） | 真实 git 临时仓库 |
| `test-graphdiff.mjs` | `lib/graph-diff.js` 与 FSoft Python 上游对拍 | golden 基准 `test-fixtures/graphdiff-golden.json`（1-17） |
| `test-article-contract.mjs` | `lib/article-contract.js` 文章契约闸门（P0-4） | 纯函数 + 可注入 `fsImpl` |
| `test-prune-orphans.mjs` | `index.js` 的 `pruneOrphanModules` | 真 FS，重点「不误删」 |
| `test-semantic-plan.mjs` | `index.js` 的 `semanticPlan` 端到端 | 真 AST + 假/无 llm 三场景 |
| `test-cluster.mjs` | `lib/cluster.js` 聚类三段式（顶层/下钻/超级分组）与全部降级 | 注入 completer 模拟模型，不碰网络 |
| `test-symbols.mjs` | `lib/symbols.js` 多语言 AST + import 边 + 正则降级 | web-tree-sitter，缺失 SKIP（42-45） |
| `test-sessions.mjs` | `index.js` 会话记录存储 | 手工构造记录文件 + TTL |
| `test-wiki-entry.mjs` | `ensureWikiEntry` + Windows 路径规范化 | 临时目录 |
| `test-worktree.mjs` | `detectLinkedWorktree` 三态 + `isWorktreeCwd`/`hasCompilableSources`/`isDeadCompileTarget` | 真实 git worktree |
| `test-cwd-paths.mjs` | cw 工具三种 cwd 形态（MSYS/Windows/不存在） | **手动集成测试**：`node test-cwd-paths.mjs <真实仓库路径>`（2、8） |
| `test-wiki-anchors.mjs` | `.codewiki/**/*.md` 行号锚点自检 | 自省式：校验本仓库自己的 wiki |

#### 重磅测试详解

**`test-orchestration.mjs`（约 1550 行，编排冒烟）**

- 环境隔离：`DSH_CODEWIKI_TICK_MS=300`（15）；JOBS_FILE 用 `pid + 随机 token` 命名（22-23）——只用 pid 时历史运行残留的同名文件会在 pid 复用时被读入，导致「单项目串行」误判（19-21 注释，0.10.10 教训）。
- `LEGACY_CHANNEL`（44）显式关闭 planMode/agenticArticles/symbolIncremental 三档：本文件守护**旧通道**的请求次数与装填方式，新通道由 test-agentic-*/test-semantic-plan/test-incremental* 守护（37-43 注释）。
- `makeCtx`（51-91）：cordis 两种 inject 风格；`ctx.effect` 立即执行、返回函数收为 disposer（84-88 防线：错写成 `ctx.effect(() => service.stop())` 会让 tick 停摆、整套测试挂死）。
- `makeBatchMock`（145-227）：假 llm 按 prompt 首行特征应答（文章观察员/文章作者/架构观察员/审校员等），支持 `stall`（挂起等 abort，202-209）与 `bigArticle`。
- 关键块行号：系统提示提醒 260-288（须 `.codewiki/` **且**根有 `CodeWiki.md` 才注入，277-282 守护收紧）；`codewiki_update`/`commitHintText` 310-428（scope 强制 `auto`、git 时间戳比较、60s cwd 缓存、自动提交失败原因入提醒 380-393）；`autoCommitWiki` 安全边界 431-531（分支合并式、非 git/被忽略/合并中/缺 identity 四拒、detached HEAD 与主题分支名占用降级 direct 且不误删预占分支 506-530）；`wakeCompileSession` 546-581（autoCommit 成功或 noChanges → **零唤醒**，556-559）；全量编译端到端 643-683（PROOFED 校对回写、`docs(wiki):` 提交、工作区干净、不唤醒会话）；串行/并行 752-838（`queueAhead` 端点字段 775-782）；stale 逐篇 875-895（只重写声明 `core.py` 的 2 篇）；重启恢复 934-991（阶段快照重跑 + 旧 plan 任务迁移到 articles，勘探员快照作废 966-989）；并发提交占位与 flush 合并 994-1041；面板端点 1044-1095（403 非回环、jobs 无 apiKey 字段 1061）；排除清单 1098-1150（报错含命中排除项 1125-1133）；knownRepos 1153-1190；`workspaceOnly` 1193-1253（**工作区外非终态任务不过滤**——藏掉就无法取消，1217-1232）；registry 抛错降级不过滤 1256-1283；输出 schema 校验 1286-1323；孤儿任务接管 1326-1357（停更 6 分钟且有 `cancelRequested` 的 foreign 任务被接管）；全局会话 + worktree 闸门 1360-1434；空壳目录闸门 1437-1485；缺编译模型诚实报错 1488-1500（provider 留空 → job 落 failed 留痕）；严格 cordis 语义 1503-1524；Temp 残留清理 1527-1543。

**`test-batch.mjs`（批量执行链自检）**

- 导入清单见 7-13。分段：`estimateTokens`（25-29，CJK 1/字、ASCII ceil(len/3.5)）；`collectSources`（32-45，行号前缀内联、缺失标注、超预算 `oversized`/`skipped`）；`numberLines`（48-52，尾换行只去一个）；`prepareArticleTasks`（55-132）：110k–420k 区间**大档单请求**不拆不转会话通道（78-82、112-121），大档关闭/未配置时超预算单文件 → 会话通道兜底（83-85、123-126），多文件超预算 → `#obs` 观察批（keepInMemory、每批 ≤110k、`splitFor`/`composePlan`，88-106）；`classifySessionTask` 三态（135-150，超时优先于已产出 141-142）；`buildSessionSteerText`（153-168，sessionTier 钉死 `tier: "codeiwiki"`）；`runRealtimeTasks`（171-408）：混合池按任务自带 provider/model/effort 路由（209-228）、大档/默认档**分池限流**（232-297，`peakNormal=2`/`peakBig=1` 两池并行）、tps 采样与外部 signal（299-321）、失败记账与错误码透传（324-345、394-408）；`localPlan`（348-358，根文件归 `root` 组）；`packArticles`（361-371，超预算只装头部）；`scanRepoFiles`（374-387，黑名单/二进制/超大/空文件）；`listModelCatalog` 与 `/api/codewiki/models`（411-462，回环 200/非回环 403）；`resolveModelEfforts` 与 `/api/codewiki/model-efforts`（465-516）；0.10.1 凭证移除断言 `resolveBatchApiKey === undefined`（519-521）；`fixAnchors` 对抗用例（524-603：倒序区间翻正 551-557、一行多锚点各自绑定最近符号不拉平 571-598、单锚点行宽松判定 599-601）；`validateArticleEnvelope`（606-636，正文里的 `---` 分隔线不误判 633-635）。

**`test-engine-native-job.mjs`（阶段 4 生产接线，16 用例）**

- 全链：`codewiki_generate.execute → JobService.submit → tick → tickNative → runNativeJob → doctor/lock → runEngine(client.js 真 spawn) → 假引擎进程 → gateNativeOutput(真实) → applyNativeOutput(真实) → cw init/index/meta(真实) → autoCommitWiki(真实 git) → finishJob`（1-19 注释）。
- `makeRepo`（57-93）：**模式文件必须放仓库外**（54-56 注释：放进仓库会变成未提交源码改动，质量门判 uncommitted-input，测试自己污染被测对象）。
- 用例 1（259-311）：done 只由 gate+apply 共同成立；**引擎锁随产物进同一个提交**（277-292：分两次写会让每轮编译后工作区多一个脏文件，下一轮变化集永远不干净）；提交清单是真实路径而非 git 八进制转义（286-289）；job 文件与日志中不得出现 `dsh-bridge-` 占位 key（307-310）。
- 用例 2（313-328）：首次编译（无 wiki）引擎 done 但终态 **partial**——`_meta.yaml` 是本次才出现且未提交的文件，宁可见地「没完成」也不把未入库基线记成已消化。
- 用例 7（383-399）：锁漂移 → failed，`engineLock.status === 'drift'`，引擎从未被要求 generate。
- 用例 11（443-481）：取消 → cancelled 终态、进程树终止 note（470）、迟到结果不覆盖终态（474-477）。
- 用例 13（511-520）：`nativeEngine:false` 完全走旧通道，假引擎零调用；`legacyLlmFor`（139-176）按**仓库真实文件**生成 source_files——`root` 模块只能挂根上文件（`CodeWiki.md`，141-147），否则文章契约闸门判失败、测的是夹具不是旧通道。
- 用例 15（544-577）：假 `runEngine` 坚称 done + writtenCount=2 但产物目录为空 → **真质量门拦下**（引擎自我评价不能替代质量门）。
- 用例 16（579-622）：cancelled/failed 短路分支不进 gate/apply；提交前已 abort → cancelled 且 `runEngine` 不被调用（617-621）。

**`test-engine-native-incremental.mjs`（阶段 5 统一增量，9 用例）**

- 用例 1（195-248）：两轮生产链。第一轮 full 后 `.codewiki/_native-state/` 落 `state.json`、`docs/module_tree.json`、`docs/metadata.json`、`docs/update_record.json`、依赖图与文章副本（201-207）；**状态与文章同批提交且提交只含 wiki 路径**（209-214）；`cw index` 不把 `_native-state`（`_` 开头目录）收进索引（218-220）。第二轮 stale：决议 `update`、`baseCommit` 是上一轮基线而非 HEAD（229-232）；引擎侧硬证据——`updateOptions.rung=3`、`readState` 四份状态全 true、`docs_markdown>0`（236-244，证据来自假引擎自己 stat 的足迹而非调用方自述）。
- 用例 2（250-264）：无变化轮 `updateOutcome='no_change'`，无新提交，提交层如实报 noChanges。
- 用例 3（266-301）与用例 4（303-329）：committed/staged/unstaged/untracked 四路 + delete/rename 全被看见；未提交部分进 `state.json` 的 `unconsumed` **持续携带**，直到真的进 commit 才移出并记 `consumedNow`；有未提交源码改动时终态不得 done、基线不推进（296-300）。
- 用例 5/6（331-374）：缺依赖图 / 变化集不可达 / 引擎版本不兼容 → **显式 full**（绝不假装 clean），降级只进 notes 不硬判 partial（342），全量完整成功仍推进基线（343）。
- 用例 7（376-448）：index 失败 / baseline 失败 → **整批回滚**（受管 `state.json`、`module_tree.json` 随文章回到 pre-image，HEAD 不动）；commit 失败 → partial **不回滚**（445-447）。
- 用例 8（450-466）：取消 → cancelled、`canAdvanceBaseline=false`、`_meta.yaml` 不变。
- 用例 9（468-484）：`nativeEngine=false` 时旧通道照常，原生引擎零调用、不产生 `_native-state`。

**其余要点（按文件）**

- `test-update-record.mjs:62-76`：钉死旧缺陷「1 成功 19 失败也是 done 且照常推进基线」——现在任何未消化项 ⇒ partial/failed 且 partial 绝不推进基线；`buildUpdateRecord` 只存摘要不塞整图（179-185）。
- `test-change-set.mjs:177-201`：git 默认 `core.quotepath=true` 会把中文路径输出成八进制转义，采集器必须还原真实路径，否则中文 wiki 产物会污染 `sourceChanges` 造成增量每轮误判。
- `test-wiki-anchors.mjs`：三基准并集（编译基线 `last_compiled_commit` ∪ 工作区 ∪ HEAD，41-56 注释、96-118）；**新鲜度感知严格度**（124-149）——结构类失败（越界/区间无序）永远硬失败，同步类失败（空行/版本节/符号未绑定）在源文件滞后时降级软报告（265-272）；CHANGELOG 追加式漂移永远软报告（311-334）；「符号在文件里根本不存在」是铁证真错，硬失败（371-389）。
- `test-article-contract.mjs:3-7`：背景即真实入库缺陷（`concepts/wiki-generation-flow.md:64` 起重复 frontmatter、`modules/client-interface.md:227` 起重复整篇、`learnings/update-reminder-entry-gap.md` frontmatter 未闭合、`source_files` 指向已删 `.tmp-test-*.log`）；分级语义 210-218（结构破坏 error 拒写、缺章节 warning 放行降 partial）；写集闸门 `makeWriteSet`/`isWritable` 220-232。
- `test-engine-quality-gate.mjs:211-224`：`judgeOutcome` 不喂 `toQualityIssues` 时看不见「来源证据缺失」，会把空归属产物判成 done——这正是 `toQualityIssues` 存在的理由；`yamlScalar` 338-371：危险 YAML 标题（冒号+空格/` #`/反斜杠/裸数字/布尔/`~` 等）必须同时通过本仓 `parseFrontmatter` 与 serde_yaml（双引号形态须为合法 JSON 字符串）两套读者。
- `test-cluster.mjs:269-343`：maxDepth 曾经只是 `>1` 布尔开关的回归防护——用「按提示词模块名决定拆几份」的桩模型验证层数可配（`maxDepth=2` → 2 层、`=3` → 3 层）。
- `test-incremental.mjs:69-118`：纯注释改动降级（`codeHash` 判定）——bodyHash 变但 stripComments 后相同 → 不重写；老快照缺 `codeHash` 时保守保留（109-118）。
- `test-update-planner.mjs:47-61`：反向依赖影响（slugify 接口变更 → 使用方 `billing.md` 也重写，旧实现只写第一篇）；新文件无归属 → `unmappedChanges + needsFull` 绝不静默丢弃（106-120）。
- `test-agentic.mjs:401-419`：无 `onSubModule` 时子模块调用必须 isError——旧实现回「已记录子模块 x」会让模型在父文里写下指向不存在文件的死链。
- `test-articles-agentic.mjs:143-215`：subDepth 失效回归——旧实现 `dispatchSub` 是本层闭包原样下传，深度永不递增（实测 subDepth=2 直接堆溢出）；改用与顺序无关的两个断言：磁盘文章目录层数 ≤ subDepth + 模型调用次数有界。
- `test-engine-bridge.mjs:359-400`：1C 真实模型暴露的回归——桥生成的 assistant 历史消息必须带 `source`（宿主 `forAdapter` 读 `source.replayState`，缺了会抛错并耗尽引擎重试）；usage 折算 217-225（DSH 互斥计数 → OpenAI `prompt_tokens` = 净输入 + 缓存读写）。
- `test-engine-llm-bridge.mjs:249-272`：客户端断连 → 上游 signal 被 abort（不省就会白烧 token）。
- `test-engine-client.mjs:52-155`：协议破坏矩阵（非 JSON 行、半行截断、未知 requestId、重复 result 先到先得、cancel 后 late-result、多字节 UTF-8 跨 chunk、单行上限）；进程层 243-361（退出码与语义 result 分离、超时终止进程树、中文空格路径）。
- `test-engine-apply-plan.mjs:283-299`：写集里有越界路径 → **整批拒写**（不是跳过该条）；回滚不变量 305-351；提交失败不回滚 357-401；`verifyCommitScope` 中文路径 655-668。
- `test-engine-process-tree.mjs:78-100`：根进程退出后**孙进程也必须死**（mock 掉的 process.kill 永远是对的，必须真进程验证）。
- `test-engine-python-entry.mjs:125-155`：契约按 `{requestId, action, ...payload}` **平铺**发送，入口若只读 `msg.payload` 会丢失 repoPath/docsDir，增量轮长出 `_native-state/docs/_native-state/docs/...` 自嵌套；157-184：入口必须自己把 stdin 钉成 UTF-8（Windows cp936 会把中文路径变乱码）。
- `test-graphdiff.mjs:28-53`：与 FSoft 上游 Python（difflib/hashlib）逐位对拍，容差 1e-12；组件级分类 58-104（改名配对、interface/body/edge 归类、counts 自洽）。
- `test-prune-orphans.mjs:79-85`：**空 modules 清单是最危险输入，必须一个不动**；删除失败记账不中断 153-181。
- `test-semantic-plan.mjs:162-172`：`plan.graph` 不携带 sourceCode（plan 会整包写进 JOBS_FILE），并有 <400KB 体积防线。
- `test-symbols.mjs:292-351`：WASM 不可用时正则兜底必须真的出符号且记账（`stats.regex`），不能静默丢整块语言。

### 探针脚本（临时，`.probe-*.mjs`）

| 文件 | 目的 | 关键行 |
| --- | --- | --- |
| `.probe-idxfail.mjs` | index 失败后 HEAD 为何前移 | `runNativeJob` stale + `runCw` 在 index 上返回 exitCode 1（39-49），打印 HEAD 前移与新提交文件（51-56） |
| `.probe-inc.mjs` | 两轮 native 增量在生产链的真实行为 | 走 `index.js` 的 `apply` + 独立 JOBS_FILE（9-14）；硬编码本机 REPO 路径（8）；打印两轮 incremental/apply/blockers 与引擎足迹（66-78） |
| `.probe-nochange-commit.mjs` | 无变化轮到底提交了什么 | mode `update-nochange`（34），打印 HEAD diff（38-43） |
| `.probe-nochange.mjs` | 用例 2（update-nochange）为何卡住 | 完整服务链 + 90s 超时打印现场（55-69），两轮 full/stale（71-83） |
| `.probe-two-round.mjs` | 确认第二轮真的进了 update 分支 | runNativeJob 两轮，打印 outcome/gate/apply/incremental 与引擎调用（37-70） |
| `.probe3.mjs` | staged 文件场景 | JOBS_FILE + `gen.execute`，`staged.py` add 后 stale（54-61） |

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ window.__ModuleLoader__.load({ id: '@local/dsh-codewiki' })      │
│ client.js:10 factory(require) → apply(ctx)                       │
└───────────────┬──────────────────────────────────┬───────────────┘
                │ slots.inject('plugins.item')     │ slots.inject('main')
                ▼                                  ▼ + 'sidebar.panellist'
   ┌────────────────────────┐        ┌─────────────────────────────────┐
   │ CodewikiCard (570)     │        │ CodewikiPanel (1455)            │
   │ 设置表单 / 模型三联选择  │        │ Tabs: 总览│任务│会话│设置        │
   │ form = configForms(NS) │        │ ReposTab(1213) SessionView(1363)│
   └───────────┬────────────┘        └───────────────┬─────────────────┘
               │ form.mutate(ops, rev)               │ apiGet 2s/10s/5s 轮询
               ▼                                     ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 宿主半侧 index.js：/api/codewiki/{jobs,control,repos,sessions,   │
   │ sessions/item,models,model-efforts}（仅回环 127.0.0.1）          │
   └──────────────────────────────────────────────────────────────────┘
```

测试矩阵的分层（箭头指向被守护的实现）：

```text
┌──────────────────────── 测试矩阵（仓库根 test-*.mjs）────────────────────────┐
│ 编排冒烟         test-orchestration.mjs ──► index.js 服务阶段机      │
│ 批量执行链       test-batch.mjs ──► index.js 纯函数 + runRealtime    │
│ 原生引擎(0-5)    contract/output/output-real/bridge/llm-bridge/      │
│                  client/manifest/process-tree/python-entry/          │
│                  quality-gate/apply-plan/native-job/                 │
│                  native-incremental ──► lib/engine/*                 │
│ agentic 通道     agentic / agentic-host / articles-agentic /          │
│                  agentic-fallback ──► lib/agentic*.js                │
│ 增量体系         incremental / incremental-e2e / update-planner /     │
│                  update-record / change-set / graphdiff ──► lib/*    │
│ 产物契约         article-contract / prune-orphans / wiki-anchors /    │
│                  wiki-entry ──► lib/article-contract.js / index.js   │
│ AST 与聚类       symbols / cluster / semantic-plan ──► lib/symbols.js│
│ 宿主边界         worktree / cwd-paths / sessions ──► index.js        │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **设置流**：`form.getSnapshot()` 初始化 → `structuredClone(snap.value)` 进 draft（`client.js:606`）→ 用户经 `setPath`（618-625）修改 → `save()` diff 出 set ops（812-816）→ `form.mutate(ops, snapshot.revision)`（819）→ 宿主 Config 服务持久化并热生效 → `form.subscribe` 回收读，仅 revision 变化才覆盖草稿（596-613）。排除清单的 UI 改写（`ReposTab.toggleExclude`，1243-1261）走同一条 mutate 链。
2. **任务进度流**：`CodewikiPanel` 每 2s GET `/api/codewiki/jobs`（1472-1512）→ 客户端差分采样（tps → 30 点窗口画 Spark；`batchProgress.completed` → EWMA 速率算 ETA）→ `jobCard`/`stageBar`/`overallPct`/`throughputBadge`/`usageLine` 渲染 → 取消 POST `control {action:'cancel'}`（1517-1525）。queued 任务的「在等谁」由服务端在 jobs 响应注入 `queueAhead`（1639-1642）。
3. **总览流**：`ReposTab` 每 10s GET `/api/codewiki/repos`（1234-1238）→ `scheduler` 块 + `repos[]` → 「更新」按钮 POST `control {action:'compile'}`（1263-1271）；排除变更后 POST `control {action:'refresh'}` 失效服务端缓存（1254）。
4. **会话流**：`SessionView` 5s 轮询 `sessions`（全局不带 jobId / 单任务带 `?jobId=`，1377）→ 选中行按 `(jobId, n)` 拉 `sessions/item` 全文（1389-1396）。
5. **测试数据流**：所有涉及 JobService 的测试把 `DSH_CODEWIKI_JOBS_FILE` 指向 tmp 下 `pid+随机 token` 的独立文件（`test-orchestration.mjs:22-23`、`test-engine-native-job.mjs:31-32`、`test-engine-native-incremental.mjs:29-30`、`test-sessions.mjs:7`、`test-worktree.mjs:10`），收尾删除；假引擎的**模式文件必须放仓库外**（`test-engine-native-job.mjs:54-56`、`test-engine-native-incremental.mjs:59-62`），否则成为未提交源码改动、被质量门判 `uncommitted-input`——测试脚本自己污染被测对象。

## Connections

- [[index]] —— 宿主半侧入口：`client.js` 的一切 fetch 目标（`/api/codewiki/*` 七个端点）与设置命名空间 `codewiki` 都由它注册；`test-orchestration.mjs`、`test-batch.mjs`、`test-agentic-fallback.mjs`、`test-cwd-paths.mjs`、`test-prune-orphans.mjs`、`test-sessions.mjs`、`test-worktree.mjs`、`test-semantic-plan.mjs` 直接 `import './index.js'`。
- [[lib-engine]] —— 原生引擎适配层（阶段 0–5）：`test-engine-*.mjs` 全系守护 `lib/engine/contract.js`、`output.js`、`openai-bridge.js`、`llm-bridge.js`、`client.js`、`manifest.js`、`process-tree.js`、`quality-gate.js`、`apply-plan.js`、`native-run.js`。
- [[test-fixtures]] —— `test-fixtures/fake-native-engine.mjs` 是阶段 4/5 测试的「真进程假引擎」，`test-fixtures/graphdiff-golden.json` 是 `test-graphdiff.mjs` 的对拍基准（由 `gen-graphdiff-golden.py` 生成）。
- [[lib-agentic]] —— agentic 通道四件套：`test-agentic.mjs`、`test-agentic-host.mjs`、`test-articles-agentic.mjs`、`test-agentic-fallback.mjs` 分层守护 `lib/agentic.js` → `lib/agentic-host.js` → `lib/articles-agentic.js` → `index.js` 退回判定。

## Known Issues

1. **partial 任务 meta 重复**：`client.js:1576` 与 `client.js:1612` 对同一 partial 任务各 push 一次 `` `未消化 ${blockers.length} 项` ``（同一段逻辑被复制成两份，注释也重复），任务卡 meta 行会出现两次「未消化 N 项」。
2. **excludePaths 占位符转义损坏**：`client.js:1043` `placeholder: 'E:\path\to\excluded-repo'` 未用原始字符串，`\t` 会被解释为制表符、`\p`/`\e` 被吞，占位文案渲染为乱码。应写成 `'E:\\path\\to\\excluded-repo'` 或 `String.raw`。
3. **机器特定绝对路径**：`.probe-inc.mjs:8` 硬编码 `E:/ik/Documents/trae_projects/1/dsh plugin/dsh-codewiki`；`test-cwd-paths.mjs:8` 默认参数 `E:/ik/.../Wxxy-CampusLogin`（可由 argv 覆盖）；`test-engine-output-real.mjs:32,37` 与 `test-engine-quality-gate.mjs:433-434` 引用 `.probe-fsoft/wiki_out_1c`——后两者有 SKIP 守卫，前两者在别的机器上无法直接运行。
4. **探针脚本待清理**：`.probe-idxfail.mjs:1`、`.probe-nochange-commit.mjs:1` 标注「跑完即删」，`.probe-inc.mjs:1` 标注「不提交」，`.probe-nochange.mjs`、`.probe-two-round.mjs`、`.probe3.mjs` 头注释无清理标注；6 个探针当前仍全部留在仓库根，属排查期残留。
5. **环境依赖导致的 SKIP/失败**：`test-engine-python-entry.mjs:46-51` 找不到 1A venv 即 SKIP；`test-symbols.mjs:42-45` web-tree-sitter 缺失即 SKIP（AST 用例全跳，仅正则兜底用例保留在 292 行以后但同样提前退出）；`test-worktree.mjs:30-36` git 不可用即 SKIP；`test-wiki-anchors.mjs:225-228` 在 `.codewiki/` 无任何 `.md` 时直接 exit 1（wiki 未编译即红）。
6. **note 展示截断**：`client.js:1646` 任务卡只显示最后一条 note，多条历史需手动展开「活动流」`<details>`（1649-1651）——有意为之，但活动密集时一眼只能看到最新一条。
