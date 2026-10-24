---
title: documentation-and-config
type: module
source_files:
  - .gitignore
  - CHANGELOG.md
  - CodeWiki.md
  - client.js
  - cordis.patch.yml
  - index.js
  - package.json
  - README.md
  - test-batch.mjs
  - test-orchestration.mjs
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json` (package.json:25-26)、`cordis.patch.yml` (cordis.patch.yml:2-16)、`index.js` 中的 `Config` schema (index.js:48) 与 `liveConfig` (index.js:73)、`client.js` 中的设置表单与面板 (client.js:7-397, client.js:7-207)、`README.md` / `CodeWiki.md` (CodeWiki.md:28-65)、`CHANGELOG.md`、`.gitignore` (.gitignore:1-12) 以及两个自检脚本 `test-batch.mjs` (test-batch.mjs:7-12) / `test-orchestration.mjs` (test-orchestration.mjs:875) 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema (`index.js:48` 的 `Config` z.object)、运行时快照 (`index.js:73` 的 `liveConfig`)、浏览器草稿 (`client.js:455-462` 的 `snapshot/draft` 状态)、人工文档 (`README.md` 与 `CodeWiki.md`)。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包、`client.js:672` 的保存字段白名单、以及 README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面 (v0.10.4，见 `package.json:3`) 的字段全集共 18 项，全部 `.volatile()` (index.js:1987)——即改完立即生效 (每次 `execute`/`tick` 时经 `liveConfig` 重新解包)，不需要重启 dsh。其中与「编译模型」相关的四项普通档 (`batchProvider` / `batchModel` / `batchReasoningEffort`) 与四项大档 (`bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`) 在 0.10.1 起彻底删除内置百炼直连：`batchProvider` 留空提交即失败 (`CHANGELOG.md:61`、`CodeWiki.md:7`)，插件不保存任何密钥 (`CodeWiki.md:51`)。模型目录发现由 `listModelCatalog` (`index.js:2507`) 与配套端点 `GET /api/codewiki/models` 以及档位端点 `GET /api/codewiki/model-efforts` (`client.js:25` 的 `EFFORTS_PATH`) 支持，设置页的模型选择改成了 provider/model/effort 三级联动 (`client.js:562` 的 `modelTrio`)。

## Key Components

### `.gitignore` (.gitignore:1-12)

运行期产物与构建产物的边界，纯声明文件：

- `.gitignore:1-3` 忽略 `node_modules/`、`vendor/codewiki/target/`、`*.log`
- `.gitignore:6` `bin/*.bak-*` 二进制备份安全网（不忽略 `bin/cw.exe` 本身）
- `.gitignore:8-12` `.orch-test-out.txt`、`.probe3.txt`、`.dsh-ops/` DSH 运行期产物（面板会话流、工具调用记录）
- 注意 `.codewiki/` 不在忽略列表——wiki 必须随仓库提交。

### `CHANGELOG.md` (CHANGELOG.md)

插件 `dsh-codewiki` 从 0.1.0 到 0.10.4 的完整变更日志，记录修复、功能、测试与配置演变；大量引用 `index.js`/`client.js` 函数与行号，是本模块行为的事实来源。

- 关键函数（实现位于 `index.js` 等）：`resolveModelEfforts` (CHANGELOG.md:75)、`resolveModelInfoOf(llm)` (CHANGELOG.md:9)、`prepareArticleTasks` (CHANGELOG.md:36)、`runRealtimeTasks` (CHANGELOG.md:59)、`submitBatchFor` (CHANGELOG.md:18)、`buildSessionSteerText` (CHANGELOG.md:89)、`listModelCatalog` (CHANGELOG.md:101)、`classifySessionTask` (CHANGELOG.md:114)、`dispatchSessionTasks`/`progressSessionTasks`/`resendSessionSteer` (CHANGELOG.md:115)、`createJobService` (CHANGELOG.md:115)、`wakeCompileSession` (CHANGELOG.md:218)、`fixAnchors` (CHANGELOG.md:127)、`numberLines` (CHANGELOG.md:138)、`modelTrio` (CHANGELOG.md:19, client.js 抽出)、`excludedItem` (CHANGELOG.md:210)、`commitHintText` (CHANGELOG.md:231)。
- 重要常量与默认值：`DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'` (CHANGELOG.md:73)；`BATCH_TOKEN_BUDGET`=110000 (CHANGELOG.md:73)、`BATCH_TOKEN_HARD_LIMIT`=128000 (CHANGELOG.md:73)；大档四项 `bigProvider` 默认 `volces-ark`、`bigModel` 默认 `glm-5.3-flash`、`bigReasoningEffort` 默认空、`bigTokenBudget` 默认 420000 (CHANGELOG.md:15)；`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (CHANGELOG.md:114)、`serialProjects` 默认 true (CHANGELOG.md:76)、`maxConcurrency` 默认 2 (CHANGELOG.md:77)、`CONCURRENCY_HARD_CAP`=8 (CHANGELOG.md:77)。

### `CodeWiki.md` (CodeWiki.md)

插件自身项目 wiki 入口 (CodeWiki.md 公约)，描述 Overview (CodeWiki.md:7)、Key Components (CodeWiki.md:9-28)、Architecture (CodeWiki.md:30-47)、Data Flow (CodeWiki.md:49-51)、Connections (CodeWiki.md:53-56)、Known Issues (CodeWiki.md:58-64)。

- 关键组件与行号：`Config` (CodeWiki.md:12，引用 index.js:48) volatile 设置项列表；`buildSessionSteerText` (CodeWiki.md:13)；`installUpdateReminder` (CodeWiki.md:14)；`runCw`/`parseStatus` (CodeWiki.md:15)；模型执行模块 `estimateTokens`/`collectSources`/`prepareArticleTasks`/`classifySessionTask`/`startBatchChatRun`/`submitBatchFor`/`settleJob`/`runRealtimeTasks`/`llmChat`/`listModelCatalog`/`resolveModelEfforts` (CodeWiki.md:16)；`createJobService` (CodeWiki.md:17) tick 阶段机 `queued→plan→articles→crosscut→compose→review→index`；`cwToolDefinition`/`generateToolDefinition` (CodeWiki.md:19)；webServer 端点 (CodeWiki.md:13) `GET /api/codewiki/jobs`、`GET /api/codewiki/repos`、`GET /api/codewiki/models`、`POST /api/codewiki/control {action:'cancel'|'refresh'|'compile', jobId}`；`apply` (CodeWiki.md:21)；`client.js` 组件 `CodewikiCard` (CodeWiki.md:25)、`CodewikiPanel` (CodeWiki.md:26)、`modelTrio` 复用 (CodeWiki.md:25)；`cordis.patch.yml` (CodeWiki.md:27)、`package.json` (CodeWiki.md:28)。重要常量 `BATCH_TOKEN_BUDGET=110000`、`BATCH_TOKEN_HARD_LIMIT=128000` (CodeWiki.md:13)。

### `client.js` (client.js)

职责：注册插件页设置卡片 (`plugins.item`) 与侧边栏面板 (`main`+`sidebar.panellist`)，经 `configForms` 读写命名空间 `codewiki`，轮询宿主端点获取任务/仓库/模型目录。

- 常量与默认值：`NS='codewiki'` (client.js:17)、`KEY='codewiki'` (client.js:18)、`JOBS_PATH='/api/codewiki/jobs'` (client.js:19)、`CONTROL_PATH='/api/codewiki/control'` (client.js:20)、`PANEL_ORDER=52` (client.js:21)、`POLL_MS=2000` (client.js:22)、`REPOS_PATH='/api/codewiki/repos'` (client.js:23)、`MODELS_PATH='/api/codewiki/models'` (client.js:24)、`EFFORTS_PATH='/api/codewiki/model-efforts'` (client.js:25)、`REPOS_POLL_MS=10000` (client.js:26)、`ACTIVE_STAGES=['queued','plan','articles','crosscut','compose','review','index']` (client.js:28)、`STAGE_WEIGHTS={queued:0,plan:0.05,articles:0.6,crosscut:0.1,compose:0.05,review:0.15,index:0.05}` (client.js:928)。
- 词典函数：`zh()` (client.js:30-167)、`en()` (client.js:168-305) 返回全量中英文文案。
- 基础工具：`el(tag,props,...children)` (client.js:393)、`apiGet(p)` (client.js:393)、`apiPost(p,data)` (client.js:399)。
- 模块入口：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory(require){...}})` (client.js:10-343)，factory 返回 `{inject:['slots','locale','configForms'], apply(ctx){...}}` (client.js:420-422)。`apply` 内：`tBound=ctx.locale.bind(NS)` (client.js:420)；`ctx.effect` 注册词典 (client.js:414)；`form=ctx.configForms.get(NS)` (client.js:420)；`mount` 用 `ctx.slots.inject('plugins.item',...)` (client.js:420-432)；侧边栏 `ctx.slots.inject('main',...)` 与 `'sidebar.panellist'` 注册 `CodewikiPanel`/`PanelIcon` (client.js:435-446)。
- 设置卡片组件 `CodewikiCard` (client.js:452-842)：状态 `snapshot`/`draft`/`notice`/`error`/`catalog`/`catalogError` (client.js:455-462)；挂载拉 `MODELS_PATH` (client.js:452-463)；订阅 `form` 快照变更覆盖草稿 (client.js:452-469)；`setPath(key,value)` (client.js:500)、`dirty` memo (client.js:509)、`selectedProvider` memo (client.js:515)；`useEfforts(provider,model)` hook (client.js:524-555) 拉档位；`modelTrio({pKey,mKey,eKey,state,allowEmptyProvider,providerPlaceholder})` (client.js:562-661) 返回 provider/model/effort 三行 JSX，换 provider 清空 model 与 eKey (client.js:452-459)，目录缺失回退 Input (client.js:452-456,602)，allowEmptyProvider 时加 `(未启用大档)` (client.js:452)，保留已配置但目录缺失的 provider/model (client.js:591,614)，effort 下拉处理 loading/error/无档位/已知未知 (client.js:452-486)；`save()` (client.js:663-685) 校验 `maxConcurrency` 整数 1-8 (client.js:665-669)，保存键白名单 (client.js:672) `['enabled','binaryPath','maxConcurrency','serialProjects','articleLanguage','updateReminder','workspaceOnly','batchProvider','batchModel','batchReasoningEffort','bigProvider','bigModel','bigReasoningEffort','bigTokenBudget','sessionTier','excludePaths','autoUpdate','autoUpdateMin']`，`form.mutate(ops, revision)` 单层 op + CAS；`discard()` (client.js:687)。
- 面板辅助函数：`stageLabel` (client.js:848)、`stateLabel` (client.js:849)、`kindLabelOf` (client.js:850)、`progressBar` (client.js:851)、`repoName` (client.js:855)、`fmtMs` (client.js:859)、`fmtTok` (client.js:866)、`fmtDur` (client.js:872)、`fmtAgo` (client.js:878)、`Spark` (client.js:883)、`stepName` (client.js:899)、`lastTimedStage` (client.js:900)、`stageBar` (client.js:904)、`overallPct` (client.js:929)、`throughputBadge` (client.js:940)、`usageLine` (client.js:962)。
- `ReposTab` 组件 (client.js:981-1124)：轮询 `REPOS_PATH` (client.js:981-997)；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并 POST `control refresh` (client.js:1011-1029)；`compile` POST `control {action:'compile',cwd}` (client.js:1031-1039)。
- `CodewikiPanel` 组件 (client.js:1126-1326)：轮询 `JOBS_PATH` 防重入 (client.js:1126-1166)；`cancel` POST `control {action:'cancel',jobId}` (client.js:1184)；`copyPath` 剪贴板 (client.js:1193)；按 cwd 分组 (client.js:1126-1132)；焦点任务选择 (client.js:1126-1130)；`jobCard` 渲染 (client.js:1220-1278)。
- `PanelIcon` (client.js:1328-1339)：内联 SVG 书页图标。

### `cordis.patch.yml` (cordis.patch.yml:2-16)

Bundle 或本地 file:// 挂载补丁，声明插件 id 与入口，注释设置项清单。

- 注释列设置项 (cordis.patch.yml:5-13)：`binaryPath`/`batchProvider` (必须是模型设置已注册 provider，留空=提交失败)/`batchModel` (默认 hy3)/`batchReasoningEffort`/`maxConcurrency` (1-8 默认 2)/`serialProjects` (默认开)/`articleLanguage`/`updateReminder`。
- `insert:` 节点 (cordis.patch.yml:13)：`id: codewiki` (cordis.patch.yml:14)，`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (cordis.patch.yml:15，空格转 %20)，`config: {}` (cordis.patch.yml:16)。id 与 `client.js:18` 的 `NS`、`client.js:18` 的 `KEY` 三处必须一致。无代码函数。

### `index.js` 的 `Config` 与 `liveConfig` (index.js)

`Config` z.object (index.js:48) 含 18 字段，全部 `.volatile()`：

| 字段 | 类型/默认 | 语义与行号 |
| --- | --- | --- |
| `enabled` | boolean / `true` | 停用后工具立即报错 (index.js:48) |
| `binaryPath` | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)` (`resolveBinary` index.js:103) (index.js:103) |
| `batchProvider` | string / `''` 或默认 `workbuddy` (常量 DEFAULT_BATCH_PROVIDER index.js:26) | 编译模型提供商；**空 = 提交失败** (0.10.1 起无内置直连) (index.js:48, CHANGELOG.md:61) |
| `batchModel` | string / `'hy3'` (DEFAULT_BATCH_MODEL index.js:27) | 编译模型 id (index.js:48) |
| `batchReasoningEffort` | string / `''` | 编译模型推理档位（空=默认） (index.js:48) |
| `bigProvider` | string / `''` 或默认 `volces-ark` (DEFAULT_BIG_PROVIDER index.js:30) | 大档提供商；留空=关闭大档 (index.js:48) |
| `bigModel` | string / `''` 或默认 `glm-5.3-flash` (DEFAULT_BIG_MODEL index.js:31) | 大档模型 (index.js:48) |
| `bigReasoningEffort` | string / `''` | 大档推理档位 (index.js:48) |
| `bigTokenBudget` | number / `420000` (DEFAULT_BIG_TOKEN_BUDGET index.js:33) | 大档 token 预算，下限被 BATCH_TOKEN_BUDGET 110k 兜住 (liveConfig index.js:85) (index.js:48) |
| `sessionTier` | string / `''` | 会话通道档位 id；留空让会话模型自动选路 (index.js:48) |
| `maxConcurrency` | number / `2` (DEFAULT_CONCURRENCY index.js:23) | 编译请求并发上限 1–8，liveConfig clamp 到 CONCURRENCY_HARD_CAP=8 (index.js:22,87) (index.js:48) |
| `serialProjects` | boolean / `true` | 单项目串行闸门，busy 时新任务进 queued (index.js:48) |
| `articleLanguage` | string / `'中文'` | wiki 文章书写语言，liveConfig 默认中文 (index.js:91) (index.js:48) |
| `updateReminder` | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒 (index.js:48) |
| `excludePaths` | string / `''` | 排除清单：换行/分号/逗号分隔绝对路径，命中拒编译 (`isExcluded` index.js:257) (index.js:257) |
| `autoUpdate` | boolean / `false` | 自动更新定时扫描历史工作区提交增量编译 (index.js:48) |
| `autoUpdateMin` | number / `30` | 自动更新扫描间隔分钟 (index.js:48) |
| `workspaceOnly` | boolean / `true` | 任务页/总览页只显示已添加 dsh 工作区任务 (index.js:48) |

`liveConfig(config)` (index.js:73) 归一化：

- 并发限 1–8 (index.js:87)
- bigTokenBudget 下限 110k (index.js:85)
- articleLanguage 默认中文 (index.js:91)
- 其他字段直接透传，无密钥处理 (0.10.1 起无 `batchApiKey`)。

相关常量：`PLUGIN_NAME='dsh-codewiki'` (index.js:1054)；`CONCURRENCY_HARD_CAP=8` (index.js:1054)；`DEFAULT_CONCURRENCY=2` (index.js:1054)；`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:1054)；`DEFAULT_BATCH_MODEL='hy3'` (index.js:1054)；`DEFAULT_BIG_PROVIDER='volces-ark'` (index.js:1054)；`DEFAULT_BIG_MODEL='glm-5.3-flash'` (index.js:1054)；`DEFAULT_BIG_TOKEN_BUDGET=420000` (index.js:1054)；`BATCH_TOKEN_BUDGET=110000` (index.js:1054)；`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:1054)；`SESSION_TASK_TIMEOUT_MS` 默认 30min (index.js:1054)。

### `package.json` (package.json)

包身份与宿主识别标志。

| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| package.json:3-4 | `version` | `0.10.4` | 与 CHANGELOG 同步 |
| package.json:7 | `main` | `index.js` | 服务端半侧入口 |
| package.json:8-11 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | 两个半侧显式导出 |
| package.json:13 | `engines` | `node >=20` | 宿主兼容性 |
| package.json:17 | `dependencies` | `@deepseek-ai/schemastery` | 唯一依赖，仅 Config 用 |
| package.json:22 | `dsh.client.platform` | `"web"` | 驱动宿主装载 client.js |
| package.json:25 | `dsh.bundle.patch` | `"cordis.patch.yml"` | bundle 安装找补丁 |

### `README.md` (README.md)

面向使用者文档：描述工具 cw / codewiki_generate / codewiki_update / codewiki_progress 与设置页；安装用 file:/// 挂载到 cordis.patch.yml；开发指引指向 vendor/codewiki、bin/cw.exe、client.js。注意其中若提及旧版 `defaultProvider`/`batchApiKey` 等为历史残留，以 Config 为准。

### `test-batch.mjs` (test-batch.mjs)

纯函数自检 (`node test-batch.mjs`)。从 index.js 导入 (test-batch.mjs:173-178)：collectSources、classifySessionTask、estimateTokens、fixAnchors、numberLines、buildSessionSteerText、prepareArticleTasks、runRealtimeTasks、localPlan、packArticles、scanRepoFiles、listModelCatalog、resolveModelEfforts、installWebServer。假 llm 用 `makeLlm` (test-batch.mjs:173) 按 stream 协议吐块，覆盖：estimateTokens 计费、collectSources 装填/oversized、numberLines 尾换行、prepareArticleTasks 普通/大档单请求/超大会话/多文件观察批/大档模型接管、classifySessionTask 三态、buildSessionSteerText 档位钉死、runRealtimeTasks 通道/混合档/tps/abort/失败记账、localPlan 分组、packArticles 截断、scanRepoFiles 黑名单、listModelCatalog 目录、/api/codewiki/models 回环、resolveModelEfforts 档位、fixAnchors 符号修正。

### `test-orchestration.mjs` (test-orchestration.mjs)

服务化编排冒烟 (`node test-orchestration.mjs`)。导入 `name`,`apply` (test-orchestration.mjs:20)；设 `DSH_CODEWIKI_TICK_MS=300` (test-orchestration.mjs:28) 与独立 `JOBS_FILE` (test-orchestration.mjs:19)。辅助：`makeCtx` (test-orchestration.mjs:40) 模拟 cordis inject；`makeMockAgent` (test-orchestration.mjs:83) systemPrompt section；`makeFixtureRepo` (test-orchestration.mjs:99) git 仓库；`makeBatchMock` (test-orchestration.mjs:127) 假 llm 按 prompt 特征应答；`waitJob` (test-orchestration.mjs:192) 轮询 JOBS_FILE；`fakeReq`/`fakeRes` (test-orchestration.mjs:207/217)。覆盖：系统提示提醒、注册、cw 工具、codewiki_update+commitHintText、wakeCompileSession 唤醒、规划阶段（含降级）、全量编译阶段机、横切拆分、文章分割、单项目串行排队、唯一通道、stale 逐篇更新、codewiki_progress 过滤、重启重跑快照、并发占位合并、面板端点取消、排除清单、knownRepos、工作区过滤、registry 异常降级、schema 校验、孤儿接管、模型缺失报错、严格 cordis 语义、Temp 清理。

## Architecture

```text
┌────────────────────── 配置的四层表示 ──────────────────────┐
│ package.json:22-25 → cordis.patch.yml:13-16 (id=codewiki)   │
│        │                                                     │
│        ▼                                                     │
│ index.js:48 Config (18字段 volatile)                         │
│        ├──► index.js:73 liveConfig() 解包                    │
│        │       ▼                                             │
│        │   运行消费端: runCw / installWebServer(index.js:2569)│
│        └──► client.js:417 configForms.get('codewiki')        │
│                │ getSnapshot / mutate(ops, revision)         │
│                ▼                                             │
│           CodewikiCard:452 设置表单 (插件页+面板)             │
└─────────────────────────────────────────────────────────────┘
  client.js:19/20/23/24/25 ──HTTP(回环)──► index.js:2569 端点:
  /jobs(GET) /repos(GET) /models(GET) /model-efforts(GET) /control(POST)
```

## Data Flow

1. **配置流**：`cordis.patch.yml:13-16` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)` (`index.js:2876`) → 每次执行前 `liveConfig(config)` (`index.js:73`) 解包 volatile 值 → 落到 `resolveBinary` (index.js:103)、`installWebServer` (index.js:2569) 等消费点。因为每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` 挂载 → 拉 `/api/codewiki/models` 得 provider 目录 (`client.js:452-463`) → 用户编辑 `draft` → `dirty` 深比较 (client.js:509) → `save()` 生成单层 `{op:'set'}` 数组 (白名单 client.js:452) → `form.mutate(ops, revision)` CAS 写入 → 宿主持久化 + 热生效 → `pull()` 收到新 `revision` 回填草稿 (client.js:493)。
3. **模型目录与档位发现流**：`GET /api/codewiki/models` (`index.js:2507` 注册) → `listModelCatalog(llmRef)` (`index.js:2507`) → 返回 `{ok, providers:[{id,name,models:[{id,name}]}]}`；`GET /api/codewiki/model-efforts?provider=&model=` (`client.js:524`) → `resolveModelEfforts` (`index.js:2545`) 返回 `{ok,provider,model,efforts:[{id,name,description}],defaultEffort,context}`。设置页 `useEfforts` 消费。
4. **文档补建流**：编译收尾 → `ensureWikiEntry(job.cwd, language)` (`index.js:209`) → `CodeWiki.md` 不存在则按语言写模板，存在则原样保留。
5. **提醒注入流**：`installUpdateReminder` (`index.js:2842`) 在 agent 创建时注册系统提示 section；`text` 回调每次组装时求值——`updateReminder === false`、会话 cwd 缺失、或仓库根无 `CodeWiki.md` 时返回空串；否则拼 `reminderText(cwd)` (`index.js:2831`) 与 `commitHintText(cwd)` (`index.js:2804`) 结果。`commitHintText` 比较最近编译 `finishedAt` 与 `git log` 时间戳，60s TTL 缓存。
6. **编排任务流**：工具 `codewiki_generate.execute` (`index.js:2197`) 先 `runCw status` 判态 → `svc.submit` 建 job → `tick()` (`index.js:1987`) 按 `STAGE_HANDLER` (`index.js:1978`) 调阶段函数 → `prepareArticleTasks` (`index.js:555`) 拆普通/大档/会话 → `submitBatchFor`/`startBatchChatRun`/`runRealtimeTasks`/`llmChat` (`index.js:283` 唯一通道) → `settleJob` 收割。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki` (MIT)，提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其本地 fork。
- [[plugin-orchestration]] — `createJobService` (`index.js:1252`) 驱动的七阶段状态机，本文的配置项 (并发、模型通道、大档、语言、排除清单、自动更新) 全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方 (`CodewikiPanel` / `ReposTab`)。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh (配置值本身热读)。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，`package.json:22` 的 `dsh.client.platform` 声明新增后也需重启才会把 `client.js` 送进浏览器 (CodeWiki.md:28, CodeWiki.md:28)。
2. **Junction 依赖**：`@deepseek-ai/schemastery` (`package.json:18`，仅供 `Config` 用) 靠插件本地 junction 解析；换机器需重建。
3. **文档与配置历史漂移**：`cordis.patch.yml:6-13` 注释清单已准确，但旧版文档可能残留 `defaultProvider`/`batchApiKey` 等已删字段；以 `Config` (`index.js:48`) 与 `client.js:672` 的字段白名单为准。0.10.1 起无内置百炼直连，`batchProvider` 留空提交即失败 (CHANGELOG.md:61, CodeWiki.md:7)。
4. **新增 Config 字段要改四处**：`index.js:48` (schema)、`index.js:73` (liveConfig 解包)、`client.js:672` (保存字段白名单)、`README.md` (人工文档)。漏掉 `client.js:672` 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback (`<cwd>/.codewiki`，见 `wikiPathFor` index.js:1027)。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠，插件消费侧已由 `normalizeArticlePath` (index.js:162) / `normalizeIndexLinks` (index.js:166) 归一为 `/`。
7. **会话通道依赖发起会话**：`job.sessionId` 为空 (面板提交 / 自动调度) 时，超预算文章与校对任务直接整体失败并明示原因，不退超大兜底、不静默跳过校对；超时默认 30 分钟 (`SESSION_TASK_TIMEOUT_MS` index.js:1054，CHANGELOG.md:114)。仅当单文件连 128k 大档都装不下且大档关闭时才转会话通道 (CHANGELOG.md:114, CodeWiki.md:65)。
8. **维护提醒依赖 `CodeWiki.md` 与 git**：`reminderText` 在仓库根无 `CodeWiki.md` 时整段不出现 (`index.js:2831` 逻辑)，入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒 (`index.js:2804` catch)。
9. **严格 cordis 语义**：`apply` (index.js:2876) 用 `ctx.inject` 获取服务，禁止直接访问 `ctx.xxx` (否则抛 without inject)；工具注册单工具失败仅丢该工具。
10. **任务拆分边界**：单文件 >110k 但 ≤128k 走大档单请求不转会话；>128k 转会话通道；多文件超预算拆观察批 #obs；单文件连大档都装不下才转会话 (`prepareArticleTasks` index.js:555)。0.10.2 修掉 batches.length===1 误判转会话。
11. **Web 安全**：`isLoopbackRequest` (index.js:2471) 仅 127.0.0.1/::1；请求体 >1MB 拒 (`readBodyJson` 限 1MB，index.js:2482)。
12. **大档空 provider**：`modelTrio` 的 `allowEmptyProvider:true` 时首项 `(未启用大档)` (client.js:562)，未选 provider 时 effort 区显 `bigDisabled` 提示 (client.js:625)。目录/档位拉取失败退化为文本输入不阻断保存 (client.js:562-566, 571-597)。
13. **二进制解析**：`resolveBinary` (index.js:103) PATH `where`/`which` 优先，失败回退捆绑 `bin/cw(.exe)`，再不行返回 `'cw'` 让 spawn 报错；`runCw` (index.js:125) 超时 `SIGKILL`，`signal` abort 杀进程。
14. **非显然语义**：`queued` 阶段置于 `ACTIVE_STAGES` 首位点亮第 0 点表示单项目串行排队 (CHANGELOG.md:78)；插件不保存/传递任何密钥，凭证全由宿主 `llm.stream()` 从模型设置解析 (CodeWiki.md:51)；`.gitignore` 中 `bin/*.bak-*` 是安全网，不忽略 `bin/cw.exe` 本身 (.gitignore:6)。