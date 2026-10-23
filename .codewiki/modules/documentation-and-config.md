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

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json`（包身份、导出、宿主扫描标志）、`cordis.patch.yml`（bundle 挂载补丁）、`index.js` 中的 `Config` schema 与 `liveConfig`（配置真源）、`client.js` 中的设置表单与面板（配置的唯一图形入口）、`README.md` / `CodeWiki.md`（面向人的文档）、`CHANGELOG.md`（面向历史的决策记录）、`.gitignore`（运行期产物边界）以及两个自检脚本 `test-batch.mjs` / `test-orchestration.mjs` 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema（`index.js:48` 的 `Config` z.object）、运行时快照（`index.js:73` 的 `liveConfig`）、浏览器草稿（`client.js:455-462` 的 `snapshot/draft` 状态）、人工文档（`README.md` 与 `CodeWiki.md`）。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包、`client.js:672` 的保存字段白名单、以及 README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面（v0.10.4，见 `package.json:3`）的字段全集共 18 项，全部 `.volatile()`——即改完立即生效（每次 `execute`/`tick` 时经 `liveConfig` 重新解包），不需要重启 dsh。其中与「编译模型」相关的四项普通档（`batchProvider` / `batchModel` / `batchReasoningEffort`）与四项大档（`bigProvider` / `bigModel` / `bigReasoningEffort` / `bigTokenBudget`）在 0.10.1 起彻底删除内置百炼直连：`batchProvider` 留空提交即失败（`CHANGELOG.md:61`、`CodeWiki.md:7`），插件不保存任何密钥（`test-batch.mjs:109` 断言 `resolveBatchApiKey===undefined`）。模型目录发现由 `listModelCatalog`（`index.js:2507`）与配套端点 `GET /api/codewiki/models`（`index.js:1987` 注册）以及档位端点 `GET /api/codewiki/model-efforts`（`client.js:25` 的 `EFFORTS_PATH`）支持，设置页的模型选择改成了 provider/model/effort 三级联动（`client.js:562` 的 `modelTrio`）。

## Key Components

### `.gitignore`（根目录，12 行）
运行期产物与构建产物的边界，纯声明文件：
- `1| node_modules/`、`2| vendor/codewiki/target/`、`3| *.log`
- `6| bin/*.bak-*` 二进制备份安全网（丢失源码的最后产物）
- `8| .orch-test-out.txt`、`9| .probe3.txt`
- `12| .dsh-ops/` DSH 运行期产物（面板会话流、工具调用记录）
- 注意 `.codewiki/` 不在忽略列表——wiki 必须随仓库提交。

### `CHANGELOG.md`（根目录，至 0.10.4）
插件 `dsh-codewiki` 从 0.1.0 到 0.10.4 的完整变更日志，记录修复、功能、测试与配置演变；大量引用 `index.js`/`client.js` 函数与行号，是本模块行为的事实来源。
- 关键函数（实现位于 `index.js` 等）：`resolveModelEfforts`(CHANGELOG.md:9,75)、`resolveModelInfoOf(llm)`(CHANGELOG.md:9)、`prepareArticleTasks`(CHANGELOG.md:16,36)、`runRealtimeTasks`(CHANGELOG.md:17,59)、`submitBatchFor`(CHANGELOG.md:18)、`buildSessionSteerText`(CHANGELOG.md:89)、`listModelCatalog`(CHANGELOG.md:101)、`classifySessionTask`(CHANGELOG.md:114)、`dispatchSessionTasks`/`progressSessionTasks`/`resendSessionSteer`(CHANGELOG.md:115)、`createJobService`(CHANGELOG.md:115)、`wakeCompileSession`(CHANGELOG.md:218)、`fixAnchors`(CHANGELOG.md:127)、`numberLines`(CHANGELOG.md:138)、`modelTrio`(CHANGELOG.md:19, client.js 抽出)、`excludedItem`(CHANGELOG.md:210)、`commitHintText`(CHANGELOG.md:231)。
- 重要常量与默认值：`DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'`(CHANGELOG.md:73)；`BATCH_TOKEN_BUDGET`=110000（CHANGELOG.md:73）、`BATCH_TOKEN_HARD_LIMIT`=128000（CHANGELOG.md:47）；大档四项 `bigProvider` 默认 `volces-ark`、`bigModel` 默认 `glm-5.3-flash`、`bigReasoningEffort` 默认空、`bigTokenBudget` 默认 420000（CHANGELOG.md:15-16）；`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟（CHANGELOG.md:114）、`serialProjects` 默认 true（CHANGELOG.md:76）、`maxConcurrency` 默认 2（CHANGELOG.md:77）、`CONCURRENCY_HARD_CAP`=8（CHANGELOG.md:77）。

### `CodeWiki.md`（根目录）
插件自身项目 wiki 入口（CodeWiki.md 公约），描述 Overview/Key Components/Architecture/Data Flow/Connections/Known Issues，引用 `index.js`/`client.js`/`cordis.patch.yml`/`package.json` 的实现细节与行号。
- 关键组件与行号：`Config`（CodeWiki.md:12，index.js:48）volatile 设置项列表含 enabled/binaryPath/maxConcurrency(默认2,1-8)/serialProjects(默认true)/articleLanguage/updateReminder/batchProvider(默认workbuddy)/batchModel(默认hy3)/batchReasoningEffort(默认空)/sessionTier/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget 等；`buildSessionSteerText`（CodeWiki.md:13，0.9.2 纯函数）；`installUpdateReminder`（CodeWiki.md:14）；`runCw`/`parseStatus`（CodeWiki.md:15）；模型执行模块 `estimateTokens`/`collectSources`/`prepareArticleTasks`/`classifySessionTask`/`startBatchChatRun`/`submitBatchFor`/`settleJob`/`runRealtimeTasks`/`llmChat`/`listModelCatalog`/`resolveModelEfforts`（CodeWiki.md:16）；`createJobService`（CodeWiki.md:17）tick 阶段机 `queued→plan→articles→crosscut→compose→review→index`，单项目串行闸门，会话通道 dispatch/progress/resend，持久化 `os.tmpdir()/dsh-codewiki-jobs.json`；`cwToolDefinition`/`generateToolDefinition`（CodeWiki.md:19）；webServer 端点（CodeWiki.md:13）`GET /api/codewiki/jobs`、`GET /api/codewiki/repos`、`GET /api/codewiki/models`、`POST /api/codewiki/control {action:'cancel'|'refresh'|'compile', jobId}`；`apply`（CodeWiki.md:21）；`client.js` 组件 `CodewikiCard`（CodeWiki.md:25）、`CodewikiPanel`（CodeWiki.md:26）、`modelTrio` 复用（CodeWiki.md:25）；`cordis.patch.yml`（CodeWiki.md:27）、`package.json`（CodeWiki.md:28）。重要常量 BATCH_TOKEN_BUDGET=110000、BATCH_TOKEN_HARD_LIMIT=128000（CodeWiki.md:13），hy3 上下文 192k 输出上限 64k。

### `client.js`（浏览器半侧，约1340行）
职责：注册插件页设置卡片（`plugins.item`）与侧边栏面板（`main`+`sidebar.panellist`），经 `configForms` 读写命名空间 `codewiki`，轮询宿主端点获取任务/仓库/模型目录。
- 挂载与导出：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory(require){...}})`（client.js:10），返回 `{inject:['slots','locale','configForms'], apply(ctx){...}}`（client.js:410-412）。`apply` 内：`ctx.locale.register(NS,{zh:zh(),en:en()})`（414）、`ctx.configForms.get(NS)`（417）、`ctx.slots.inject('plugins.item',...)`（420，order 30）、`ctx.slots.inject('main'/'sidebar.panellist',...)`（437-443，PANEL_ORDER=52）。
- 常量：`NS='codewiki'`（17）、`KEY='codewiki'`（18）、`JOBS_PATH='/api/codewiki/jobs'`（19）、`CONTROL_PATH='/api/codewiki/control'`（20）、`PANEL_ORDER=52`（21）、`POLL_MS=2000`（22）、`REPOS_PATH='/api/codewiki/repos'`（23）、`MODELS_PATH='/api/codewiki/models'`（24）、`EFFORTS_PATH='/api/codewiki/model-efforts'`（25）、`REPOS_POLL_MS=10000`（26）、`ACTIVE_STAGES=['queued','plan','articles','crosscut','compose','review','index']`（28）、`STAGE_WEIGHTS={queued:0,plan:0.05,articles:0.6,crosscut:0.1,compose:0.05,review:0.15,index:0.05}`（928）。
- 词典函数：`zh()`（30）、`en()`（168）返回全量中英文文案键值。
- 基础工具：`el(tag,props,...children)`（389）、`apiGet(p)`（393，抛 `body.error||HTTP`）、`apiPost(p,data)`（399）。
- 设置卡片组件 `CodewikiCard(props)`（452）：状态 `snapshot/draft/notice/error/catalog/catalogError`（455-462）；挂载时 `apiGet(MODELS_PATH)` 拉目录（466），订阅 `form.subscribe(pull)`（493）；`setPath(key,value)`（500）深拷草稿；`dirty` memo（509）；`selectedProvider` memo（515）；`useEfforts(provider,model)`（524）自定义钩子拉档位；`effortsState`/`bigEffortsState`（556-557）；`modelTrio({pKey,mKey,eKey,state,allowEmptyProvider,providerPlaceholder})`（562）渲染三行联动（换提供商清空模型与旧档位 582-585，目录缺失保留自定义 option 591-593，档位下拉含默认项与描述 643-654）；`save`（663）校验 `maxConcurrency` 1-8 整数（666），白名单 ops 键 18 项（672）：`['enabled','binaryPath','maxConcurrency','serialProjects','articleLanguage','updateReminder','workspaceOnly','batchProvider','batchModel','batchReasoningEffort','bigProvider','bigModel','bigReasoningEffort','bigTokenBudget','sessionTier','excludePaths','autoUpdate','autoUpdateMin']`，调用 `form.mutate(ops,revision)`（679）；`discard`（687）；渲染运行节（700）、编译模型节（`modelTrio` 普通档 770）、大档节（`modelTrio` 允许空 provider 787）、调度与排除节（800）、保存条（834）。
- 面板辅助函数：`stageLabel`（848）、`stateLabel`（849）、`kindLabelOf`（850）、`progressBar`（851）、`repoName`（855）、`fmtMs`（859）、`fmtTok`（866）、`fmtDur`（872）、`fmtAgo`（878）、`Spark({values,width,height})`（883）SVG polyline、`stepName`（899）、`lastTimedStage`（900）、`stageBar(job)`（904）六阶段步骤条、`overallPct(job)`（929）加权进度封顶99、`throughputBadge(job,sparkOf,rateOf)`（940）、`usageLine(job)`（962）。
- 总览标签 `ReposTab()`（981）：轮询 `REPOS_PATH`（994），`toggleExclude(r)`（1011）经 `form.mutate` 改 `excludePaths` 并 `apiPost(CONTROL_PATH,{action:'refresh'})`，`compile(cwd)`（1031）发 `{action:'compile',cwd}`；渲染调度卡与仓库行。
- 主面板 `CodewikiPanel()`（1126）：轮询 `JOBS_PATH`（1146，防重入 `inFlight` 1142），`sparkRef`/`batchRateRef` 采样（1134-1137，EWMA 1163），`cancel(jobId)`（1184），`copyPath`（1193），按 cwd 分组（1206），焦点任务选择（1217），`jobCard(job)`（1220）渲染卡片，`PanelIcon`（1328）SVG。
- 样式注入：`style` 元素（307-387）带 `data-plugin` 标记。

### `cordis.patch.yml`（根目录，16 行）
Bundle 或本地 file:// 挂载补丁，声明插件 id 与入口，注释设置项清单。
- 注释列设置项（cordis.patch.yml:5-12）：`binaryPath`/`batchProvider`(必须是模型设置已注册 provider，留空=提交失败)/`batchModel`(默认 hy3)/`batchReasoningEffort`/`maxConcurrency`(1-8默认2)/`serialProjects`(默认开)/`articleLanguage`/`updateReminder`。
- `insert:` 节点（13）：`id: codewiki`（14），`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`（15，空格转 %20），`config: {}`（16）。id 与 `client.js:18` 的 `NS`、`client.js:18` 的 `KEY` 三处必须一致。无代码函数。

### `index.js` 的 `Config` 与 `liveConfig`
`Config` z.object（index.js:48）含 18 字段，全部 `.volatile()`：

| 行号 | 字段 | 类型/默认 | 语义 |
| --- | --- | --- | --- |
| index.js:42 | `enabled` | boolean / `true` | 停用后工具立即报错 |
| index.js:103 | `binaryPath` | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)`（`resolveBinary` index.js:103） |
| index.js:42 | `batchProvider` | string / `''` | 编译模型提供商（宿主模型设置里的 provider id）；**空 = 提交失败**（0.10.1 起无内置直连） |
| index.js:42 | `batchModel` | string / `'hy3'` | 编译模型 id（默认 hy3，上下文192k输出64k） |
| index.js:42 | `batchReasoningEffort` | string / `''` | 编译模型推理档位（空=默认） |
| index.js:42 | `bigProvider` | string / `''` | 大档提供商；留空=关闭大档退回旧行为 |
| index.js:42 | `bigModel` | string / `''` | 大档模型（默认 volces-ark/glm-5.3-flash 由常量 DEFAULT_BIG_PROVIDER index.js:30 等） |
| index.js:42 | `bigReasoningEffort` | string / `''` | 大档推理档位 |
| index.js:42 | `bigTokenBudget` | number / `420000` | 大档 token 预算，下限被 BATCH_TOKEN_BUDGET 110k 兜住（liveConfig index.js:85） |
| index.js:42 | `sessionTier` | string / `''` | 会话通道档位 id；留空让会话模型自动选路 |
| index.js:42 | `maxConcurrency` | number / `2` | 编译请求并发上限 1–8，liveConfig clamp 到 CONCURRENCY_HARD_CAP=8 (index.js:22,87) |
| index.js:42 | `serialProjects` | boolean / `true` | 单项目串行闸门，busy 时新任务进 queued |
| index.js:42 | `articleLanguage` | string / `'中文'` | wiki 文章书写语言，liveConfig 默认中文 (index.js:91) |
| index.js:42 | `updateReminder` | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒（门控看仓库根 CodeWiki.md） |
| index.js:257 | `excludePaths` | string / `''` | 排除清单：换行/分号/逗号分隔绝对路径，命中拒编译（`isExcluded` index.js:257） |
| index.js:42 | `autoUpdate` | boolean / `false` | 自动更新定时扫描历史工作区提交增量编译 |
| index.js:42 | `autoUpdateMin` | number / `30` | 自动更新扫描间隔分钟 |
| index.js:42 | `workspaceOnly` | boolean / `true` | 任务页/总览页只显示已添加 dsh 工作区任务 |

`liveConfig(config)`（index.js:73）归一化：
- 并发限 1–8（index.js:87）
- bigTokenBudget 下限 110k（index.js:85）
- articleLanguage 默认中文（index.js:91）
- 其他字段直接透传，无密钥处理（0.10.1 起无 `batchApiKey`）。

相关常量：`PLUGIN_NAME='dsh-codewiki'`(index.js:18)；`CONCURRENCY_HARD_CAP=8`(index.js:22)；`DEFAULT_CONCURRENCY=2`(index.js:24)；`DEFAULT_BATCH_PROVIDER='workbuddy'`(index.js:26)；`DEFAULT_BATCH_MODEL='hy3'`(index.js:27)；`DEFAULT_BIG_PROVIDER='volces-ark'`(index.js:30)；`DEFAULT_BIG_MODEL='glm-5.3-flash'`(index.js:31)；`DEFAULT_BIG_TOKEN_BUDGET=420000`(index.js:33)；`BATCH_TOKEN_BUDGET=110000`(index.js:369)；`BATCH_TOKEN_HARD_LIMIT=128000`(index.js:374)。

### `package.json`（根目录）
包身份与宿主识别标志。
| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| 3 | `version` | `0.10.4` | 与 CHANGELOG 同步 |
| 7 | `main` | `index.js` | 服务端半侧入口 |
| 9 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | 两个半侧显式导出 |
| 13-16 | `engines` | `node >=20`、`dsh >=0.2.0-rc.0` | 宿主兼容性 |
| 18 | `dependencies` | `@deepseek-ai/schemastery ^3.18.4` | 唯一依赖，仅 Config 用 |
| 22 | `dsh.client.platform` | `"web"` | 驱动宿主装载 client.js |
| 25 | `dsh.bundle.patch` | `"cordis.patch.yml"` | bundle 安装找补丁 |

### `README.md`（根目录）
面向使用者文档：描述工具 cw / codewiki_generate / codewiki_update / codewiki_progress 与设置页；安装用 file:/// 挂载到 cordis.patch.yml；开发指引指向 vendor/codewiki、bin/cw.exe、client.js。注意其中若提及旧版 `defaultProvider`/`batchApiKey` 等为历史残留，以 Config 为准。

### `test-batch.mjs`（纯函数自检）
导入 index.js 的 `collectSources`/`classifySessionTask`/`estimateTokens`/`fixAnchors`/`numberLines`/`buildSessionSteerText`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`packArticles`/`scanRepoFiles`/`listModelCatalog`/`resolveModelEfforts`/`installWebServer` (test-batch.mjs:173-178)；`makeLlm`(test-batch.mjs:173) mock；覆盖大档接管(107)、会话兜底(83)、观察批分割(87)、锚点修正(453)、0.10.1删密钥断言 `resolveBatchApiKey===undefined`(451)。

### `test-orchestration.mjs`（编排冒烟）
`makeCtx`(40)、`makeFixtureRepo`(99)、`makeBatchMock`(127)、`waitJob`(192)；独立 `DSH_CODEWIKI_JOBS_FILE`(19) 隔离；覆盖系统提示提醒、注册、全量编译、横切拆分、文章分割、单项目串行、重启重跑、面板端点、排除清单、knownRepos、工作区过滤、孤儿接管、编译模型缺失报错、严格 cordis、Temp 清理。

## Architecture

```text
┌─────────────────────── 配置的四层表示 ───────────────────────┐
│ package.json:22-25  dsh.client.platform / dsh.bundle.patch     │
│        │（宿主扫描）                                          │
│        ▼                                                      │
│ cordis.patch.yml:13-16  insert: id=codewiki → index.js         │
│        │                                                      │
│        ▼                                                      │
│ index.js:42  Config (z.object, 18字段, 全 volatile)            │
│        │                                                      │
│        ├──► index.js:73  liveConfig()  ← 每次 execute/tick 解包│
│        │        │  clamp: concurrency≤8, bigTokenBudget≥110k  │
│        │        ▼                                             │
│        │   runCw / 批量通道 / installWebServer（消费端）        │
│        │                                                      │
│        └──► client.js:417 configForms.get('codewiki')         │
│                 │ getSnapshot / mutate(ops, revision)         │
│                 ▼                                             │
│            CodewikiCard:452 设置表单（插件页 + 面板两处挂载）   │
│                 │ 字段白名单 client.js:672                     │
│                 ▼                                             │
│            README.md / CodeWiki.md 人工文档（须与 Config 同步） │
└───────────────────────────────────────────────────────────────┘

  client.js:19/20/23/24/25 ──HTTP(仅回环)──► index.js:2569 installWebServer
      /api/codewiki/jobs     GET  → service.list()
      /api/codewiki/repos    GET  → cw status 现算 + 缓存 + scheduler
      /api/codewiki/models   GET  → listModelCatalog(index.js:2507)
      /api/codewiki/model-efforts GET → resolveModelEfforts(index.js:2545)
      /api/codewiki/control  POST → cancel / refresh / compile
```

## Data Flow

1. **配置流**：`cordis.patch.yml:13-16` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)`（`index.js:2876`）→ 每次执行前 `liveConfig(config)`（`index.js:73`）解包 volatile 值 → 落到 `resolveBinary`（index.js:103）、`installWebServer`（index.js:2569）等消费点。因为每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` 挂载 → 拉 `/api/codewiki/models` 得 provider 目录（`client.js:452`）→ 用户编辑 `draft` → `dirty` 深比较（509）→ `save()` 生成单层 `{op:'set'}` 数组（白名单 client.js:452）→ `form.mutate(ops, revision)` CAS 写入 → 宿主持久化 + 热生效 → `pull()` 收到新 `revision` 回填草稿（493）。
3. **模型目录与档位发现流**：`GET /api/codewiki/models`（`index.js:2507` 注册）→ `listModelCatalog(llmRef)`（`index.js:2507`）→ 返回 `{ok, providers:[{id,name,models:[{id,name}]}]}`；`GET /api/codewiki/model-efforts?provider=&model=`（`client.js:524`）→ `resolveModelEfforts`（`index.js:2545`）返回 `{ok,provider,model,efforts:[{id,name,description}],defaultEffort,context}`。设置页 `useEfforts` 消费。
4. **文档补建流**：编译收尾 → `ensureWikiEntry(job.cwd, language)`（`index.js:209`）→ `CodeWiki.md` 不存在则按语言写模板，存在则原样保留。
5. **提醒注入流**：`installUpdateReminder`（`index.js:2842`）在 agent 创建时注册系统提示 section；`text` 回调每次组装时求值——`updateReminder === false`、会话 cwd 缺失、或仓库根无 `CodeWiki.md` 时返回空串；否则拼 `reminderText(cwd)`（`index.js:2831`）与 `commitHintText(cwd)`（`index.js:2804`）结果。`commitHintText` 比较最近编译 `finishedAt` 与 `git log` 时间戳，60s TTL 缓存。
6. **编排任务流**：工具 `codewiki_generate.execute`（`index.js:2197`）先 `runCw status` 判态 → `svc.submit` 建 job → `tick()`（`index.js:1987`）按 `STAGE_HANDLER`（`index.js:1978`）调阶段函数 → `prepareArticleTasks`（`index.js:555`）拆普通/大档/会话 → `submitBatchFor`/`startBatchChatRun`/`runRealtimeTasks`/`llmChat`（`index.js:283` 唯一通道）→ `settleJob` 收割。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki`（MIT），提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其本地 fork。
- [[plugin-orchestration]] — `createJobService`（`index.js:1252`）驱动的七阶段状态机，本文的配置项（并发、模型通道、大档、语言、排除清单、自动更新）全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方（`CodewikiPanel` / `ReposTab`）。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh（配置值本身热读）。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，`package.json:22` 的 `dsh.client.platform` 声明新增后也需重启才会把 `client.js` 送进浏览器（CodeWiki.md:28）。
2. **Junction 依赖**：`@deepseek-ai/schemastery`（`package.json:18`，仅供 `Config` 用）靠插件本地 junction 解析；换机器需重建。
3. **文档与配置历史漂移**：`cordis.patch.yml:6-13` 注释清单已准确，但旧版文档可能残留 `defaultProvider`/`batchApiKey` 等已删字段；以 `Config`（`index.js:48`）与 `client.js:672` 的字段白名单为准。0.10.1 起无内置百炼直连，`batchProvider` 留空提交即失败（CHANGELOG.md:61）。
4. **新增 Config 字段要改四处**：`index.js:42`（schema）、`index.js:73`（liveConfig 解包）、`client.js:672`（保存字段白名单）、`README.md`（人工文档）。漏掉 `client.js:672` 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，见 `wikiPathFor` index.js:1027）。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠，插件消费侧已由 `normalizeArticlePath`（index.js:162）/`normalizeIndexLinks`（index.js:166）归一为 `/`。
7. **会话通道依赖发起会话**：`job.sessionId` 为空（面板提交 / 自动调度）时，超预算文章与校对任务直接整体失败并明示原因，不退超大兜底、不静默跳过校对；超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS` index.js:1054，CHANGELOG.md:114）。
8. **维护提醒依赖 `CodeWiki.md` 与 git**：`reminderText` 在仓库根无 `CodeWiki.md` 时整段不出现（`index.js:2831` 逻辑），入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒（`index.js:2804` catch）。
9. **严格 cordis 语义**：`apply` 内所有服务经 `ctx.inject` 获取，禁止直接访问 `ctx.xxx`（否则抛 without inject）；工具注册单工具失败仅丢该工具（`index.js:2876`）。
10. **任务拆分边界**：单文件 >110k 但 ≤128k 走大档单请求不转会话；>128k 转会话通道；多文件超预算拆观察批 #obs；单文件连大档都装不下才转会话（`prepareArticleTasks` index.js:555）。0.10.2 修掉 batches.length===1 误判转会话。
11. **Web 安全**：`isLoopbackRequest`（index.js:2471）仅 127.0.0.1/::1；请求体 >1MB 拒（index.js:2471）。