---
title: documentation-and-config
type: module
source_files:
  - .gitignore
  - CodeWiki.md
  - README.md
  - client.js
  - cordis.patch.yml
  - index.js
  - package.json
  - test-batch.mjs
  - test-orchestration.mjs
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json` (package.json:25-28)、`cordis.patch.yml` (cordis.patch.yml:22-33)、`index.js` 中的 `Config` schema (index.js:102-128) 与 `liveConfig` (index.js:102-144)、`client.js` 的设置表单与侧边栏面板 (client.js:7-1703)、`README.md` (README.md:1-156)、`CodeWiki.md` (CodeWiki.md:1-75) 与两个自检脚本 `test-batch.mjs` (test-batch.mjs:1-642) / `test-orchestration.mjs` (test-orchestration.mjs:1-1552) 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema (`Config`，index.js:70)、运行时快照 (`liveConfig`，index.js:102)、浏览器草稿 (`snapshot`/`draft`，client.js:553-554)、人工文档 (`README.md` 与 `CodeWiki.md`)。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包 (index.js:102-144)、`client.js` `save()` 的保存键白名单 (client.js:766)、README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面 (v0.14.0，package.json:3) 的字段全集共 **25 项** (index.js:3491-3517)，全部 `.volatile()`——每次 `execute`/`tick` 经 `liveConfig` (index.js:102) 重新解包，改完立即生效，不需要重启 dsh。编译模型三档齐备：普通档 (`batchProvider`/`batchModel`/`batchReasoningEffort`，index.js:73-75)、大档 (`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`，index.js:76-79，0.10.4 引入、0.10.8 全面启用)、会话通道兜底档位 `sessionTier` (index.js:80)。0.10.1 起删除内置百炼直连 (README.md:97)，`batchProvider` 留空提交即失败 (index.js:4655)，插件不保存任何密钥。0.10.9 新增 `autoCommit` (index.js:4655)：编译产物由插件自己提交，会话模型不再等待编译或代跑 git；0.10.11 起 `autoCommitWiki` 升级为**分支合并式**——`tickIndex` 有产物且开关开启时 `setStage('commit')` 提前返回 (index.js:3459-3461)，`tickCommit` (index.js:3465-3480) 调 `autoCommitWiki` (index.js:3346-3428) 先在主题分支 `codewiki/wiki-<jobId>` 上提交、再合并回原分支并删除主题分支 (index.js:4265-4299)，产物提交不再长在用户当前分支的收尾里，终态 done 最多晚一个 tick。模型目录发现由 `listModelCatalog` (index.js:4265-4286) 与端点 `GET /api/codewiki/models` (index.js:4549-4564)、档位端点 `GET /api/codewiki/model-efforts` (index.js:4568-4588) 支持，设置页的模型选择是 provider/model/effort 三级联动 (`modelTrio`，client.js:660-764)。

## Key Components

### `.gitignore` (.gitignore:1-13)

运行期产物与构建产物的边界，纯声明文件：

- .gitignore:1-3 忽略 `node_modules/`、`vendor/codewiki/target/`、`*.log`
- .gitignore:5-6 `bin/*.bak-*` 二进制备份安全网（丢失源码时代的最后产物；**不**忽略 `bin/cw.exe` 本身）
- .gitignore:8-9 `.orch-test-out.txt`、`.probe3.txt` 探测残留
- .gitignore:11-12 `.dsh-ops/` DSH 运行期产物（面板会话流、工具调用记录），不入库
- 注意 `.codewiki/` 不在忽略列表——wiki 必须随仓库提交；若被项目级 ignore 忽略，`autoCommitWiki` (index.js:4655-4737) 会拒绝自动提交而不是静默丢产物 (index.js:4676-4679)。

### `package.json` (package.json:1-29)

包身份与宿主识别标志：

| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| package.json:2-3 | `name`/`version` | `@local/dsh-codewiki` / `0.14.0` | 与 client.js:11 的加载 id、cordis.patch.yml:20 的 `id` 三处必须一致 |
| package.json:6-7 | `type`/`main` | `module` / `index.js` | 服务端半侧入口 |
| package.json:8-11 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | 两个半侧显式导出 |
| package.json:13-16 | `engines` | `node >=20`、`dsh >=0.2.0-rc.0` | 兼容性判定（0.2.1-rc.1 起第三方插件按 engines.dsh 判定） |
| package.json:17-19 | `dependencies` | `@deepseek-ai/schemastery ^3.18.4` | 唯一依赖，仅 `Config` 用 (index.js:70 import) |
| package.json:22-24 | `dsh.client.platform` | `"web"` | 驱动宿主扫描器把 client.js 送进浏览器 |
| package.json:25-27 | `dsh.bundle.patch` | `"cordis.patch.yml"` | bundle 安装找补丁 |

### `cordis.patch.yml` (cordis.patch.yml:3-33)

Bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂 (cordis.patch.yml:2-3)。

- 注释设置项清单 (cordis.patch.yml:6-18)：`binaryPath` (6)、`batchProvider` (7)、`batchModel` (8)、`batchReasoningEffort` (9)、`maxConcurrency` (10)、`bigConcurrency` (11)、`serialProjects` (12)、`articleLanguage` (13)、`planMode` (14)、`agenticArticles` (15)、`agenticMaxSteps` (16)、`symbolIncremental` (17)、`updateReminder` (18)。**注意这份注释是子集**：`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`/`parallelProjects` 未列入，完整清单以 `Config` (index.js:70-96) 为准。
- `insert:` 节点 (cordis.patch.yml:21-26)：`id: codewiki` (20)、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (21，空格转 %20)、`config: {}` (24)。id 与 package.json:2 的 `name`、client.js:18 的 `NS`/`KEY` 三处必须一致。无代码函数。

### `CodeWiki.md` (CodeWiki.md:1-75)

插件自身的项目 wiki 入口（CodeWiki.md 公约）。结构：Overview (CodeWiki.md:5-7)、Key Components (CodeWiki.md:9-31)、Architecture (CodeWiki.md:33-57)、Data Flow (CodeWiki.md:59-61)、Connections (CodeWiki.md:63-66)、Known Issues (CodeWiki.md:68-75)。

- Key Components 逐条列出 `index.js` 组件：`Config` (CodeWiki.md:12)、模型执行模块 (CodeWiki.md:20)、`createJobService` 阶段机 (CodeWiki.md:21)、`cwToolDefinition`/`generateToolDefinition` (CodeWiki.md:22-23)、webServer 端点 (CodeWiki.md:23)、`apply` (CodeWiki.md:24)；`client.js` 组件 (CodeWiki.md:26-30)。
- Architecture 图 (CodeWiki.md:35-57) 描绘 queued→articles→crosscut→compose→review→index 阶段机与 autoCommitWiki 收尾（无 plan；compose 仅在输入超 420k 大档预算的拆分时出现）。
- Known Issues (CodeWiki.md:70-75) 记录插件注册不热加载、junction 依赖、cw 无 `--version`、上游 stale 反斜杠路径、断点文件语义、会话通道对发起会话的依赖。

### `README.md` (README.md:1-156)

面向使用者的文档：工具表 (README.md:15-21) 列 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`/设置页；`codewiki_generate` 关键行为 (README.md:19-27)；增量与质量保证 (README.md:100-145) 描述 0.14.0 的变更采集/规划/诚实终态/契约闸门；编译流水线吸收自 FSoft CodeWiki (README.md:102-117)；设置节 (README.md:106-127) 逐项解释 `batchProvider`/`batchModel` (README.md:97，0.10.1 起唯一通道)、大档四项 (README.md:111)、`sessionTier` (README.md:100)、`binaryPath`/`maxConcurrency`/`bigConcurrency`/`serialProjects`/`articleLanguage`/`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`/`updateReminder` (README.md:102-111)、`autoCommit` (README.md:112，含完整安全边界与三态判定描述)、volatile 说明 (README.md:113)；安装 (README.md:115-131) 用 file:/// 直挂；开发节 (README.md:132-141) 指向 vendor/codewiki、bin/cw.exe、client.js 与验证命令。

### `index.js` 的 `Config` 与 `liveConfig` (index.js:70-144)

`Config` z.object (index.js:70-96) 含 25 字段，全部 `.volatile()`：

| 字段 | 定义行 | 类型/默认 | 语义 |
| --- | --- | --- | --- |
| `enabled` | index.js:71 | boolean / `true` | 停用后两个工具立即报错 |
| `binaryPath` | index.js:72 | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)`（`resolveBinary` index.js:150） |
| `batchProvider` | index.js:73 | string / `'workbuddy'` | 编译模型提供商；**留空将无法提交任务**（0.10.1 起无内置直连） |
| `batchModel` | index.js:74 | string / `'hy3'` | 编译模型 id，全部模型环节共用 |
| `batchReasoningEffort` | index.js:75 | string / `''` | 思考档位 id；可选值由 `/api/codewiki/model-efforts` 实时读取 |
| `bigProvider` | index.js:76 | string / `'volces-ark'` | 大档提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | index.js:77 | string / `'glm-5.3-flash'` | 大档模型 id（512k 上下文） |
| `bigReasoningEffort` | index.js:78 | string / `''` | 大档思考档位 |
| `bigTokenBudget` | index.js:79 | number / `420000` | 大档单请求输入预算；模块源码总量超此值才拆观察→合成，单文件超此值转会话通道 |
| `sessionTier` | index.js:80 | string / `''` | 会话通道档位 id（dsh-subagent-auto-router 档位）；留空=自动选路 |
| `maxConcurrency` | index.js:81 | number / `2` | 默认档并发上限 1–8，硬顶 `CONCURRENCY_HARD_CAP=8` (index.js:41) |
| `bigConcurrency` | index.js:82 | number / `0` | 大档并发上限 1–8；`0`/留空 = 跟随 `maxConcurrency`（与 0.12.1 前单池行为等价） |
| `serialProjects` | index.js:83 | boolean / `true` | 单项目串行：其余仓库任务进 queued 排队 |
| `parallelProjects` | index.js:84 | number / `2` | 并行推进的仓库编译任务上限（1–4）：关闭单项目串行后生效 |
| `articleLanguage` | index.js:85 | string / `'中文'` | wiki 文章书写语言 |
| `planMode` | index.js:86 | string / `'auto'` | 模块划分：`auto`=AST 符号+LLM 语义聚类；`dirs`=顶层目录分组 |
| `agenticArticles` | index.js:87 | boolean / `true` | 文章写作走 agentic 工具循环（模型自读源码、增量写） |
| `agenticMaxSteps` | index.js:88 | number / `30` | agentic 单篇步数上限（1–100） |
| `symbolIncremental` | index.js:89 | boolean / `true` | stale 增量按 AST 符号级判定变更 |
| `updateReminder` | index.js:90 | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒（仅当仓库根存在 `CodeWiki.md`） |
| `autoCommit` | index.js:91 | boolean / `true` | 编译完成后插件自己在主题分支提交产物再合并回原分支（0.10.11 起分支合并式） |
| `excludePaths` | index.js:92 | string / `''` | 排除清单：换行/分号/逗号分隔绝对路径（`excludedItem` index.js:339） |
| `autoUpdate` | index.js:93 | boolean / `false` | 定时扫描历史工作区提交增量编译（调度器，index.js:4831） |
| `autoUpdateMin` | index.js:94 | number / `30` | 扫描间隔分钟，最小 5 |
| `workspaceOnly` | index.js:95 | boolean / `true` | 任务页/总览只显示已添加 dsh 工作区任务 |

`liveConfig(config)` (index.js:102-144) 归一化：`bigTokenBudget` 下限被 `BATCH_TOKEN_BUDGET` 110k 兜住 (index.js:115)；`maxConcurrency` clamp 到 1–`CONCURRENCY_HARD_CAP`，非法值回落 `DEFAULT_CONCURRENCY=2` (index.js:117-119)；`bigConcurrency` 0/未填=跟随默认档 (index.js:121-123)；新增 `parallelLimit`——`serialProjects===false` 时取 `parallelProjects`（1–4，默认 2），否则 1 (index.js:125-129)；`articleLanguage` 空值回落 `'中文'` (index.js:130)；`serialProjects`/`autoCommit`/`workspaceOnly` 用 `!== false` 保默认 (index.js:124/141/142)；`autoUpdate` 需 `=== true` (index.js:139)；`batchModel`/`bigModel` 空值回落各自默认 (index.js:110/113)。0.10.1 起无任何密钥字段。

其它相关常量：`PLUGIN_NAME='dsh-codewiki'` (index.js:39)、`CW_SUBCOMMANDS` 子命令白名单 (index.js:1876)、`WIKI_PATHS=['.codewiki','CodeWiki.md']` (index.js:1877)、`JOBS_FILE` 默认 `os.tmpdir()/dsh-codewiki-jobs.json` (index.js:1881)、`TICK_MS` 默认 10s、下限 250ms (index.js:1882)、`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (index.js:2069)、`SESSION_TASK_DIR` (index.js:2075)、`ORPHAN_TAKEOVER_MS` 默认 5 分钟 (index.js:2069)、`MAX_JOBS_KEPT=30` (index.js:2070)、`REPOS_FILE` (index.js:2075)、`JOB_TERMINAL={done,failed,cancelled}`(含 partial) (index.js:2104)、`BATCH_TOKEN_BUDGET=110000` (index.js:663)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:668)。

### `client.js` (client.js:1-1703)

浏览器半侧：注册插件页设置卡片 (`plugins.item`) 与侧边栏面板 (`main`+`sidebar.panellist`)，经 `configForms` 读写命名空间 `codewiki`，轮询宿主端点（挂载点说明 client.js:1-8）。

- 挂载常量：`NS='codewiki'` (client.js:19)、`KEY='codewiki'` (client.js:20)、`JOBS_PATH` (client.js:23)、`CONTROL_PATH` (client.js:24)、`PANEL_ORDER=52` (client.js:25)、`POLL_MS=2000` (client.js:26)、`REPOS_PATH` (client.js:27)、`SESSIONS_PATH` (client.js:24)、`SESSIONS_ITEM_PATH` (client.js:25)、`MODELS_PATH` (client.js:26)、`EFFORTS_PATH` (client.js:27)、`REPOS_POLL_MS=10000` (client.js:31)。`ACTIVE_STAGES=['queued','articles','crosscut','compose','review','index','commit']` (client.js:33)——无 `plan`、含 `commit`，`queued` 单列最前表示串行排队。
- 词典：`zh()` (client.js:35-210) 与 `en()` (client.js:211-) 返回全量中英文文案；阶段词条含 `stageCommit: '提交产物中'`/`'Committing'` (client.js:133)；自动提交三态词条 `autoCommitOk`/`autoCommitNone`/`autoCommitPending` (client.js:151-153)；大档分区词条 `secBig`/`bigProviderOff`/`bigDisabled` 等 (client.js:102-111)；`sessionTier` (client.js:112-113)；FSoft 三档能力词条 `secPipeline`/`planMode`/`agenticArticles`/`symbolIncremental` (client.js:90-101)。
- 基础工具：`el(tag,props,...children)` (client.js:491)、`apiGet(p)` (client.js:497-502)、`apiPost(p,data)` (client.js:497-506)。
- 模块入口：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})` (client.js:10-12)，factory 返回 `{inject:['slots','locale','configForms'], apply(ctx){...}}` (client.js:511-513)。`apply` 内：`tBound` 与词典注册 (client.js:518-519)、`form=ctx.configForms.get(NS)` (client.js:1688)、`mount` 注册 `plugins.item`（order 30，client.js:518-525，走 `whileServed` 门控 526-530）、侧边栏双 slot 注册面板与 `PanelIcon`（main key=KEY 535、panellist id=KEY order=PANEL_ORDER 536-542）。
- 设置卡片 `CodewikiCard` (client.js:550-1038)：状态 `snapshot`/`draft`/`notice`/`error` (client.js:553-556)；挂载拉 `MODELS_PATH` (client.js:26-37)；订阅快照按 `revision` 覆盖草稿 (client.js:598-615)；summary 视图 (client.js:607)；`setPath` (client.js:613-620)、`dirty` memo (client.js:622-625)、`selectedProvider` memo (client.js:660-664)；`useEfforts(provider,model)` hook (client.js:766-797) 二次拉档位，普通档与大档各一份实例 (client.js:654-655)；`modelTrio({...})` (client.js:660-764) 渲染 provider/model/effort 三行，换 provider 清空 model 与旧档位 (client.js:515-522)，`allowEmptyProvider` 时首项「（未启用大档）」(client.js:807)、目录缺失退文本输入 (client.js:699-718)、错误提示 (client.js:726-727)、已配置但目录缺失的 provider/model 保留选项 (client.js:689-691)；`save()` (client.js:766-805) 校验 `maxConcurrency` 1–8 整数 (client.js:769-772)、`bigConcurrency` 0 或 1–8 (client.js:774-778)、`agenticMaxSteps` 1–100 (client.js:780-784)、`planMode` 白名单 (client.js:786-789)，保存键白名单 **25 项** (client.js:792)，`form.mutate(ops, revision)` 单层 op + CAS (client.js:799)；`discard()` (client.js:807-811)；表单渲染五段：运行节 (client.js:819-913，含 `autoCommit` 开关 client.js:841-849)、编译模型节 (client.js:914-930)、大档节 (client.js:931-947)、FSoft 流程节 (client.js:948-994)、调度与排除节 (client.js:995-1028)、保存条 (client.js:1029-1036)。
- 面板辅助：`stageLabel`/`stateLabel`/`kindLabelOf` (client.js:1044-1046)、`progressBar` (client.js:1047-1050)、`repoName` (client.js:1051-1054)、`fmtMs`/`fmtTok`/`fmtDur`/`fmtAgo` (client.js:1055-1077)、`Spark` (client.js:1079-1091)、`stepName` (client.js:1095)、`lastTimedStage`/`stageBar` (client.js:1098-1127，过滤 `ACTIVE_STAGES` 防旧任务残留 `plan` 键导致失败/取消不标红)、`STAGE_WEIGHTS={queued:0,articles:0.63,crosscut:0.1,compose:0.05,review:0.15,index:0.05,commit:0.02}` (client.js:1130，articles 0.63/commit 0.02，总和不变)、`overallPct` (client.js:1143-1153)、`throughputBadge` (client.js:1165-1185)、`usageLine` (client.js:33-49)。
- `ReposTab` (client.js:1184-1328)：轮询 `REPOS_PATH`（10s，client.js:23-27）；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并 POST `control refresh` (client.js:1214-1232)；`compile` POST `{action:'compile',cwd}` (client.js:1234-1242)；调度卡 (client.js:515-541)；仓库行渲染 (client.js:1278-1323)。
- `SessionView` (client.js:1334-1424)：单任务/全局会话记录视图，5s 轮询 (client.js:1357)，点开按 (jobId,n) 拉全文 (client.js:1363-1367)。
- `CodewikiPanel` (client.js:1426-1686)：2s 轮询 `JOBS_PATH`（回环，client.js:1450-1481，防重入）；`cancel` POST control (client.js:1488-1496)；`copyPath` 剪贴板 (client.js:1497-1503)；按 cwd 分组 (client.js:1524-1530)；焦点任务选择 (client.js:1559-1560)；`jobCard` 渲染 (client.js:1524-1632，自动提交三态显示于 client.js:1560-1568——成功短 sha+分支、无改动一句、失败原因存入 `acTitle` 进任务行 `title` client.js:1564-1567)；三标签页 总览/任务/会话/设置 (client.js:1645-1656)。
- `PanelIcon` (client.js:1688-1699)：内联 SVG 书页图标。

### `test-batch.mjs` (test-batch.mjs:1-642)

纯函数自检（`node test-batch.mjs`）。从 index.js 导入 (test-batch.mjs:521-527)：`collectSources`/`classifySessionTask`/`estimateTokens`/`fixAnchors`/`numberLines`/`buildSessionSteerText`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`packArticles`/`scanRepoFiles`/`listModelCatalog`/`resolveModelEfforts`/`installWebServer`/`validateArticleEnvelope`。覆盖：estimateTokens 计费 (test-batch.mjs:25-29)、collectSources 装填/oversized/tail 尾换行 (test-batch.mjs:32-45)、numberLines (test-batch.mjs:47-52)、prepareArticleTasks 普通/大档单请求/超大会话通道 (test-batch.mjs:54-86)、多文件观察批分割 (test-batch.mjs:87-107)、大档模型接管与关闭回退 (test-batch.mjs:108-132)、`classifySessionTask` 三态 (test-batch.mjs:134-150)、`buildSessionSteerText` 档位钉死 (test-batch.mjs:152-168)、runRealtimeTasks 通道/混合档分派/tps/abort (test-batch.mjs:170-322)、失败记账 (test-batch.mjs:323-345)、localPlan 分组 (test-batch.mjs:347-358)、packArticles 截断 (test-batch.mjs:360-371)、scanRepoFiles 黑名单 (test-batch.mjs:373-387)、llm 通道失败错误码透传 (test-batch.mjs:393-408)、listModelCatalog (test-batch.mjs:410-432)、`/api/codewiki/models` 端点回环 403 (test-batch.mjs:434-462)、resolveModelEfforts 与 model-efforts 端点 (test-batch.mjs:464-516)、0.10.1 反向断言不再导出 `resolveBatchApiKey` (test-batch.mjs:518-521)、fixAnchors 符号修正 13 项 (test-batch.mjs:523-602)、validateArticleEnvelope 半截 frontmatter 闸门 (test-batch.mjs:605-636)。

### `test-orchestration.mjs` (test-orchestration.mjs:1-1552)

服务化编排冒烟（`node test-orchestration.mjs`）。导入 `{name, apply, SESSIONS_DIR}` (test-orchestration.mjs:45)；设 `DSH_CODEWIKI_TICK_MS='300'` (test-orchestration.mjs:44) 与独立 `DSH_CODEWIKI_JOBS_FILE`——0.10.10 起文件名追加随机 token (test-orchestration.mjs:51-52)，避免 pid 复用时历史残留的同名文件被原样读入，让「单项目串行」误判为已有项目在编译、表现为「偶发失败」(test-orchestration.mjs:94-96)。测试配置基线 `batchCfg()` (test-orchestration.mjs:45) 固定 `workbuddy`/`hy3` 并显式关掉三档 FSoft 能力 (`LEGACY_CHANNEL`，test-orchestration.mjs:110)，因新通道断言会改请求次数/装填方式。辅助：`makeCtx` (test-orchestration.mjs:133-173，模拟 cordis inject 切片语义)、`makeMockAgent` (test-orchestration.mjs:132-146)、`makeFixtureRepo` (test-orchestration.mjs:145-162，**自带 git identity** user.name/email 122-123——0.10.9 起 `autoCommitWiki` 缺身份会拒绝提交)、`llmProxy` (test-orchestration.mjs:230，转发 `activeLlm`)、`makeBatchMock` (test-orchestration.mjs:245-327，按 prompt 首行特征应答)、`waitJob` (test-orchestration.mjs:255-268)、`fakeReq`/`fakeRes` (test-orchestration.mjs:245-257)。

覆盖块：系统提示提醒 (test-orchestration.mjs:260-288)、注册 (test-orchestration.mjs:291-308)、cw 工具 (test-orchestration.mjs:304-308)、codewiki_update+commitHintText (test-orchestration.mjs:310-428，0.10.10 新增 committed/noChanges 静默断言 406-409 与 pending 带原因断言 411-425)、autoCommitWiki 安全边界 (test-orchestration.mjs:430-531，0.10.11 重写：正常提交断言 `mode==='branch'`、主题分支名前缀与合并后已删除 442-446、提交信息带 docs(wiki) 前缀与任务 id 446、只提交两个目标路径 448、源码改动留在工作区 450、无改动 noChanges 452、非 git/被 ignore/合并中/缺身份各拒绝分支 457-498、**detached HEAD 降级直接提交** 506-514、**主题分支名被占用降级且预占分支不被误删** 516-530)、autoCommitState 三态 (test-orchestration.mjs:533-543，含 committed 优先于 noChanges 542)、wakeCompileSession 唤醒与零打扰 (test-orchestration.mjs:545-581：autoCommit 成功 → done 完全不唤醒 554、noChanges 同样零唤醒 558、pending 带原因唤醒 561-567)、本地规划 (test-orchestration.mjs:583-640)、全量编译阶段机 (test-orchestration.mjs:642-700，端到端断言 stageTimings 含独立 commit 阶段 657 与 `mode==='branch'` 658、自动提交只含 wiki 产物 661-663、不唤醒会话 670)、大模块横切拆分 (test-orchestration.mjs:715-749)、文章观察→合成分割 (test-orchestration.mjs:751-749 续)、单项目串行排队 (test-orchestration.mjs:751-807)、并行项目上限 (test-orchestration.mjs:809-838)、唯一通道 (test-orchestration.mjs:840-872)、stale 逐篇更新 (test-orchestration.mjs:874-895)、codewiki_progress (test-orchestration.mjs:897-933)、宿主重启重跑与旧 plan 任务迁移 (test-orchestration.mjs:934-991)、并发占位合并 (test-orchestration.mjs:993-1041)、面板端点与取消 (test-orchestration.mjs:1043-1095)、排除清单 (test-orchestration.mjs:1097-1150)、knownRepos (test-orchestration.mjs:1152-1190)、工作区过滤 (test-orchestration.mjs:1192-1253)、registry 异常防御 (test-orchestration.mjs:1255-1283)、工具输出 schema 形态 (test-orchestration.mjs:1285-1323)、孤儿接管 (test-orchestration.mjs:1325-1357)、全局会话 Tab 与 worktree 闸门 (test-orchestration.mjs:1359-1434)、空壳目录闸门 (test-orchestration.mjs:1436-1485)、编译模型缺失诚实报错 (test-orchestration.mjs:1487-1500)、严格 cordis 语义 (test-orchestration.mjs:1502-1524)、Temp 残留清理 (test-orchestration.mjs:1526-1543)。

## Architecture

```text
┌───────────────────── 配置的四层表示 ─────────────────────┐
│ package.json:2 + cordis.patch.yml:19-24 ──► 三处 id=codewiki 一致
│        ▼
│ index.js:70 Config（25 字段，全部 .volatile()）
│   ├─► index.js:102 liveConfig（execute/tick 每次热解包）
│   │     ▼ 消费端: resolveBinary(150)/submit(3579)/tickIndex(3346)/tickCommit(3465)
│   └─► client.js:515 configForms.get('codewiki')
│           │ getSnapshot / subscribe / mutate(ops, revision)
│           ▼ CodewikiCard (client.js:550) 设置表单（25 键白名单 client.js:792）
└────────────────────────────────────────────────────────────┘
  client.js:19-27 ──HTTP(仅回环)──► index.js 端点:
    /jobs /repos /sessions /sessions/item /models /model-efforts /control
  autoCommit 是唯一拥有专属阶段机的配置项:
    tickIndex(3346) ─setStage('commit')─► tickCommit(3465)
      ─► autoCommitWiki(4655) 主题分支 codewiki/wiki-<jobId> 提交→合并回原分支→删主题分支
```

## Data Flow

1. **配置流**：`cordis.patch.yml:19-24` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)` (index.js:4817) → 每次执行前 `liveConfig(config)` (index.js:102-144) 解包 volatile 值 → 落到 `resolveBinary` (index.js:150)、`installWebServer` (index.js:4327)、各阶段 tick (`tickArticles` index.js:2879 / `tickCrosscut` index.js:3098 / `tickReview` index.js:3233 / `tickIndex` index.js:3346 / `tickCommit` index.js:3465) 与 `submit` (index.js:3579) 等消费点。每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` (client.js:550) 挂载 → 拉 `/api/codewiki/models` 得 provider 目录 (client.js:607-618) → 用户编辑 `draft` → `dirty` 深比较 (client.js:766-769) → `save()` (client.js:515-554) 生成单层 `{op:'set'}` 数组（白名单 25 键 client.js:792）→ `form.mutate(ops, revision)` (client.js:799) CAS 写入 → 宿主持久化 + 热生效 → 订阅回调收到新 `revision` 回填草稿 (client.js:576-593)。
3. **模型目录与档位发现流**：`GET /api/codewiki/models` (index.js:4265-4280) → `listModelCatalog(llmRef)` (index.js:4303-4324) → 返回 `{ok, providers:[{id,name,models:[{id,name}],error?}]}`；`GET /api/codewiki/model-efforts?provider=&model=` (index.js:4292-4312) → `resolveModelEfforts` (index.js:4303-4325) → `resolveModelInfoOf` (index.js:4292-4297，优先宿主 `resolveModelInfo`、回落 `resolveModel`) → 返回 `{ok,provider,model,efforts:[{id,name,description}],defaultEffort,context}`。设置页 `useEfforts` (client.js:622-653) 消费。
4. **文档补建流**：编译收尾 `tickIndex` (index.js:3346-3456) → `ensureWikiEntry(job.cwd, language)` (index.js:301-334，调用点 346-349) → 仓库根缺 `CodeWiki.md` 则按语言写双语模板，已有入口绝不覆盖。
5. **提醒与自动提交流**：`installUpdateReminder` (index.js:4783-4815) 在 agent 创建时注册系统提示 section `codewiki:update-reminder` (index.js:4772)；text 回调每次组装时求值 (index.js:4739-4745)——`updateReminder===false`、仓库根无 `CodeWiki.md` 返回空串，否则拼 `reminderText(cwd)` (index.js:2271-2280) 与 `commitHintText(cwd)` (index.js:3346-3377：经 `autoCommitState` 判定仅 `pending` 才比较最近编译 `finishedAt` 与 `git log` 时间戳 index.js:2386-2391，60s TTL 缓存 index.js:3465/4742)。0.10.11 起 `tickIndex` 在有产物且开关开启时 `setStage('commit')` 提前返回 (index.js:4655-4657)，`tickCommit` (index.js:2278-2293) 于下一 tick 调用 `autoCommitWiki` (index.js:1877-1959) 走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」——提交成功或 `noChanges` 则 `wakeCompileSession` (index.js:2278-2293，静默 return 在 2282) 完全不打扰会话；提交失败不改变任务终态（`tickCommit` 恒置 done，index.js:3479），只记录 `reason` 供「产物待提交」提醒与面板展示；终态 done 因此最多晚一个 tick（默认 `TICK_MS` 10s，index.js:1877）。
6. **编排任务流**：工具 `codewiki_generate.execute` (index.js:3758-4037) 先 `runCw status` 判态 → `svc.submit` (index.js:3579-3680) 建 job → `tick()` (index.js:3491-3577) 按 `STAGE_HANDLER` (index.js:3482-3489) 调阶段函数 → `prepareArticleTasks` (index.js:1165-1250) 拆普通/大档/会话通道任务 → `submitBatchFor` (index.js:2755-2789)/`startBatchChatRun` (index.js:2629-2671)/`runRealtimeTasks` (index.js:591-650)/`llmChat` (index.js:467-492，唯一模型通道) → `settleJob` (index.js:2460-2490) 收割、`writeValidated` (index.js:2522-2539) 校验落盘；index 之后进 commit 阶段 (index.js:3458-3462)。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki` (MIT)，提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其本地 fork (CodeWiki.md:65)。
- [[plugin-orchestration]] — `createJobService` (index.js:2295-3707) 驱动的阶段机 queued→articles→crosscut→compose→review→index→commit（无 plan、加 commit；CodeWiki.md:20 的描述尚未含 commit 节），本文的配置项（并发双档、并行上限、模型三档、语言、排除清单、自动更新、autoCommit）全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方（`CodewikiPanel` client.js:1426 / `ReposTab` client.js:1184 / `SessionView` client.js:1334）。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制 (CodeWiki.md:66)。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh（配置值本身热读）。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，package.json:22-24 的 `dsh.client.platform` 声明新增后也需重启才会把 client.js 送进浏览器 (CodeWiki.md:70)。
2. **Junction 依赖**：`@deepseek-ai/schemastery` (package.json:17-19，仅供 `Config` 用) 靠插件本地 junction 解析；换机器需重建 (CodeWiki.md:71)。
3. **文档清单与语义有滞后**：`cordis.patch.yml:22-33` 注释只列部分设置项，`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`/`parallelProjects` 未列入；`README.md:112` 的 autoCommit 条目与 `CodeWiki.md` 的 autoCommitWiki 条目/`createJobService` 描述/架构图 (CodeWiki.md:20) 仍是「index 收尾直接提交」的 0.10.9 口径，未反映 0.10.11 的独立 commit 阶段与分支合并式，且 CodeWiki.md 引用的 `WIKI_PATHS` 锚点写 index.js:55（实际 index.js:55）；client.js:1 的头注释仍标 `v0.4.1` 而词典内容已是 0.14.0。完整字段以 `Config` (index.js:70-96) 与 client.js:792 白名单为准；旧版文档若残留 `defaultProvider`/`batchApiKey` 等已删字段一律作废（0.10.1 删内置直连）。
4. **新增 Config 字段要改四处**：index.js:70（schema）、index.js:102（liveConfig 解包）、client.js:792（保存字段白名单）、`README.md`（人工文档）。漏掉 client.js:792 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback `<cwd>/.codewiki` (`wikiPathFor` index.js:1854-1859)。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠，插件消费侧由 `normalizeArticlePath` (index.js:209) / `normalizeIndexLinks` (index.js:213-221) 归一为 `/`（0.5.0.2 起 Rust 层根治，插件层保留为纵深防御，CodeWiki.md:73）。
7. **会话通道依赖发起会话**：`job.sessionId` 为空（面板提交/自动调度）时，超预算文章与校对任务直接整体失败并明示原因 (`dispatchSessionTasks` index.js:2797-2831，fail 在 2801-2802)，不退大档兜底、不静默跳过校对；超时默认 30 分钟 (`SESSION_TASK_TIMEOUT_MS` index.js:1881，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调)。只有单文件连大档预算都装不下（或 bigProvider 留空）才转会话通道 (`prepareArticleTasks` index.js:1165-1250、CodeWiki.md:75)。
8. **维护提醒依赖 `CodeWiki.md` 与 git**：提醒注入的门控在 section text 回调 (index.js:4739-4745)——仓库根无 `CodeWiki.md` 返回空串，入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒 (index.js:4767 catch)。
9. **严格 cordis 语义**：`apply` (index.js:4817-4819) 用 `ctx.inject` 获取 `agents`/`llm` 服务，禁止直接访问 `ctx.xxx`（否则抛 without inject）；工具注册单工具失败仅丢该工具不回滚全部 (index.js:4862-4878)。
10. **任务拆分边界**：普通单请求预算 `BATCH_TOKEN_BUDGET=110000` (index.js:663)，装填上限=大档预算或 `BATCH_TOKEN_HARD_LIMIT=128000` (index.js:668)；110k–420k 区间大档单请求一次写完，模块总量超 `bigTokenBudget` (index.js:79) 才拆观察批 `#obs`，单文件连大档都装不下才转会话通道。0.10.3 修掉 `batches.length===1` 误判转会话的缺陷。
11. **Web 安全**：`isLoopbackRequest` (index.js:4229-4232) 仅放行 127.0.0.1/::1；请求体超 1MB 拒绝 (`readBodyJson` index.js:4240-4258)。工作区过滤只过滤终态任务、非终态任务始终可见 (index.js:4379, client.js:1244-1244)。
12. **大档空 provider**：`modelTrio` 的 `allowEmptyProvider:true` 时首项「（未启用大档）」(client.js:660)，未选 provider 时 effort 区显 `bigDisabled` 提示 (client.js:723)；目录/档位拉取失败退化为文本输入，不阻断保存 (client.js:699-718、1210-1211)。
13. **二进制解析**：`resolveBinary` (index.js:150-170) PATH `where`/`which` 优先，失败回退捆绑 `bin/cw(.exe)`，再不行返回 `'cw'` 让 spawn 报错；`runCw` (index.js:172-197) 超时 `SIGKILL`，`signal` abort 杀进程。
14. **autoCommit 拒绝分支、三态与分支合并式（0.10.11）**：`autoCommitWiki` (index.js:4655-4737) 在非 git 仓库 (4666)、无 HEAD (4667)、merge/rebase/cherry-pick 进行中 (4669-4671)、目标路径未解决冲突 (4672)、`.codewiki/`（或未 tracked 的 `CodeWiki.md`）被 `.gitignore` 忽略 (4676-4679)、缺 `user.name`/`user.email` (4681-4683) 时一律拒绝并降级为「产物待提交」提醒——绝不半个提交；只 add `.codewiki` 与 `CodeWiki.md` 两个路径（pathspec 形式 `git add -- …`，**不是 `-A`**，index.js:55、`WIKI_PATHS` index.js:2271）、不跑仓库钩子 (`--no-verify`，index.js:4695)；`git add`/`git commit` 自身失败（含 `index.lock` 并发占用）把 stderr 摘录写进 `reason` (index.js:4689/4696)。分支流程：detached HEAD (index.js:4702-4705) 或建主题分支失败 (4707-4710) 降级 `mode:'direct'` 并带 `fallback` 原因；进入主题分支后任何失败先切回原分支 (try/finally 4710-4717)，绝不把用户留在插件建出的分支上；合并冲突/失败 → `git merge --abort` (4723)、保留主题分支等手动合并 (4724-4729)，绝不强合；成功后 `git branch -d` 删主题分支（`-d` 只删已合并分支，绝不强删，4722）。三态判定唯一来源是 `autoCommitState` (index.js:2271-2276)：`committed` 优先于 `noChanges`，旧 job（无 autoCommit 字段）按 `pending` 与升级前行为一致——唤醒 (index.js:2278) 与系统提示 (index.js:4795) 两条通道共用，否则同一次「无改动」会被打扰两次。`codewiki_progress` 的 autoCommit 输出带 `mode`/`branch`/`fallback` (index.js:4159-4172)，render 三态各一句 (test-orchestration.mjs:419-421)。
15. **非显然语义**：`queued` 置于 `ACTIVE_STAGES` 首位点亮第 0 点表示串行排队 (client.js:32-33)；0.10.11 起 `commit` 也在 `ACTIVE_STAGES` (client.js:33)，阶段徽章「提交产物中」/「Committing」词条齐备 (client.js:1129)、`STAGE_WEIGHTS` 为 articles 0.63 / commit 0.02 (client.js:1129)；步骤条短标签用的 `step*` 词条族（zh client.js:1098、client.js:1102-1106）没有 `stepCommit`，第 7 个点的短标签只能靠 t() 的缺键回退；`codewiki_progress` 描述里的 stage 枚举 (index.js:1877) 未列 `queued`/`commit`；终态 done 因独立 commit 阶段最多晚一个 tick (index.js:4655-4657 + `TICK_MS` index.js:1877)；旧任务残留的 `plan` 计时键被 `lastTimedStage`/`stageBar` 过滤 (client.js:231-260)；插件不保存/传递任何密钥，凭证全由宿主 `llm.stream()` 从模型设置解析（submit 校验 index.js:3648-3651）；.gitignore:5-6 的 `bin/*.bak-*` 是丢失源码时代的安全网，不忽略 `bin/cw.exe` 本身；测试 fixture 必须自带 git identity (test-orchestration.mjs:122-123)，jobs 测试文件名带随机 token 防 pid 复用污染 (test-orchestration.mjs:51-52)；面板上自动提交失败原因放任务行 `title` 而非 meta，防一行被撑爆 (client.js:1564-1567)；中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等。
