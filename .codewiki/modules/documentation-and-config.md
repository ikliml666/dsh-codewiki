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

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json` (package.json:25-28)、`cordis.patch.yml` (cordis.patch.yml:2-5)、`index.js` 中的 `Config` schema (index.js:51-71) 与 `liveConfig` (index.js:51-75)、`client.js` 中的设置表单与侧边栏面板 (client.js:7-1351)、`README.md` / `CodeWiki.md` (CodeWiki.md:31-75)、`CHANGELOG.md` (CHANGELOG.md:1-643)、`.gitignore` (.gitignore:1-12) 以及两个自检脚本 `test-batch.mjs` (test-batch.mjs:7-12) / `test-orchestration.mjs` (test-orchestration.mjs:1023) 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema (index.js:51 的 `Config` z.object)、运行时快照 (index.js:51 的 `liveConfig`)、浏览器草稿 (client.js:455-462 的 `snapshot`/`draft` 状态)、人工文档 (`README.md` 与 `CodeWiki.md`)。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包、client.js:672 的保存字段白名单、以及 README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面 (v0.10.9，见 package.json:3) 的字段全集共 19 项 (index.js:2052-2070)，全部 `.volatile()`——即每次 `execute`/`tick` 时经 `liveConfig` (index.js:2052) 重新解包，改完立即生效，不需要重启 dsh。编译模型三档齐备：普通档 (`batchProvider`/`batchModel`/`batchReasoningEffort`，index.js:2052-2054)、大档 (`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`，index.js:54-57，0.10.4 引入、0.10.8 全面启用)、会话通道兜底档位 `sessionTier` (index.js:58)。0.10.1 起删除内置百炼直连 (CHANGELOG.md:82)，`batchProvider` 留空提交即失败 (index.js:2052)，插件不保存任何密钥 (index.js:2052 注释、CodeWiki.md:61)。0.10.9 新增 `autoCommit` (index.js:2052)：编译产物由插件自己提交，会话模型不再等待编译或代跑 git (CHANGELOG.md:82-96、index.js:2052)。模型目录发现由 `listModelCatalog` (index.js:2052) 与端点 `GET /api/codewiki/models` (index.js:2052)、档位端点 `GET /api/codewiki/model-efforts` (index.js:2052，客户端常量 client.js:568) 支持，设置页的模型选择是 provider/model/effort 三级联动 (`modelTrio`，client.js:562-661)。

## Key Components

### `.gitignore` (.gitignore:1-12)

运行期产物与构建产物的边界，纯声明文件：

- .gitignore:1-3 忽略 `node_modules/`、`vendor/codewiki/target/`、`*.log`
- .gitignore:5-6 `bin/*.bak-*` 二进制备份安全网（丢失源码时代的最后产物；**不**忽略 `bin/cw.exe` 本身）
- .gitignore:8-9 `.orch-test-out.txt`、`.probe3.txt` 探测残留
- .gitignore:11-12 `.dsh-ops/` DSH 运行期产物（面板会话流、工具调用记录），不入库
- 注意 `.codewiki/` 不在忽略列表——wiki 必须随仓库提交；若被项目级 ignore 忽略，`autoCommitWiki` (index.js:2926-2932) 会拒绝自动提交而不是静默丢产物。

### `CHANGELOG.md` (CHANGELOG.md:1-643)

插件从 0.1.0 (CHANGELOG.md:629) 到 0.10.9 (CHANGELOG.md:3) 的完整变更日志，记录修复、功能、测试与配置演变，是本模块行为演变的事实来源。近期关键版本：

- 0.10.9 (CHANGELOG.md:8-22)：`autoCommitWiki` (index.js:2926) 把「等编译完成 → 会话模型代跑 git」收回插件侧；`wakeCompileSession` (index.js:2926) 在自动提交成功时完全不打扰会话 (CHANGELOG.md:10)；设置项 `autoCommit` 默认 true (CHANGELOG.md:12、index.js:2926)。
- 0.10.8 (CHANGELOG.md:26-38)：编译流水线适配 hy3 192k——放弃 32k 时代拆批策略，大档单请求优先 (CHANGELOG.md:26)；审校改**批量校对** `batchProofreadBatchPrompt`/`settleProofread` (CHANGELOG.md:26，实现 index.js:859/1406)；面板 `lastTimedStage` 过滤 `ACTIVE_STAGES` (CHANGELOG.md:27，实现 client.js:917)。
- 0.10.7 (CHANGELOG.md:38-47)：删除规划阶段——`tickPlan`/`batchPlannerPrompt`/`parsePlan` 三段全删，模块清单由 `localPlan` (index.js:685) 按顶层目录本地分组，阶段机不再有 plan (CHANGELOG.md:38)。
- 0.10.6 (CHANGELOG.md:44-52)：非终态任务的工作区过滤放行——jobs/repos 端点不再藏掉占串行闸门的编译中任务 (index.js:2694-2698)。
- 0.10.5 (CHANGELOG.md:54-64)：`codewiki_progress` 输出 schema 的 `progress` 补 null 分支 (index.js:2471)。
- 0.10.4 (CHANGELOG.md:72-98)：`resolveModelInfoOf(llm)` 修正宿主方法名 (index.js:2631)；新增大档四项配置 (CHANGELOG.md:72)。
- 0.10.1 (CHANGELOG.md:117-129)：删除 `bailianChat` 内置直连与 `resolveBatchApiKey` 凭证解析链，`llmChat` (index.js:288) 成为唯一模型通道，`submit` 硬校验 provider/model/llm 三项 (index.js:2145-2154)。

重要常量与默认值：`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:1020)、`DEFAULT_BATCH_MODEL='hy3'` (index.js:1020)、`BATCH_TOKEN_BUDGET=110000` (index.js:1020)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:1020)、大档默认 `volces-ark`/`glm-5.3-flash`/420000 (index.js:1020-1023)、`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (index.js:1020)、`serialProjects` 默认 true (index.js:1020)、`maxConcurrency` 默认 2 / 硬顶 8 (index.js:1020-1022)。

### `CodeWiki.md` (CodeWiki.md:1-72)

插件自身的项目 wiki 入口（CodeWiki.md 公约），结构：Overview (CodeWiki.md:5-7)、Key Components (CodeWiki.md:9-30)、Architecture (CodeWiki.md:32-54)、Data Flow (CodeWiki.md:56-58)、Connections (CodeWiki.md:60-63)、Known Issues (CodeWiki.md:65-72)。

- Key Components 逐条列出 `Config` (CodeWiki.md:12)、`buildSessionSteerText` (CodeWiki.md:13)、`installUpdateReminder` (CodeWiki.md:14)、`autoCommitWiki` (CodeWiki.md:15，逐条安全边界)、`wakeCompileSession` (CodeWiki.md:16)、`runCw`/`parseStatus` (CodeWiki.md:17)、模型执行模块 (CodeWiki.md:18)、`createJobService` (CodeWiki.md:13)、工具定义 (CodeWiki.md:20-21)、webServer 端点 (CodeWiki.md:13)、`apply` (CodeWiki.md:13)、`client.js` 组件 (CodeWiki.md:13-16)、挂载文件 (CodeWiki.md:13-14)。
- Architecture 图 (CodeWiki.md:34-54) 描绘 queued→articles→crosscut→compose→review→index 阶段机与 autoCommitWiki 收尾（0.10.7 后无 plan；compose 仅在输入超 420k 大档预算的拆分时出现）。
- Known Issues (CodeWiki.md:67-72) 记录插件注册不热加载、junction 依赖、断点文件语义、会话通道对发起会话的依赖。

### `client.js` (client.js:1-1354)

浏览器半侧：注册插件页设置卡片 (`plugins.item`) 与侧边栏面板 (`main`+`sidebar.panellist`)，经 `configForms` 读写命名空间 `codewiki`，轮询宿主端点。

- 挂载常量：`NS='codewiki'` (client.js:19)、`KEY='codewiki'` (client.js:19)、`JOBS_PATH` (client.js:19)、`CONTROL_PATH` (client.js:20)、`PANEL_ORDER=52` (client.js:19)、`POLL_MS=2000` (client.js:19)、`REPOS_PATH` (client.js:23)、`MODELS_PATH` (client.js:24)、`EFFORTS_PATH` (client.js:25)、`REPOS_POLL_MS=10000` (client.js:19)。`ACTIVE_STAGES=['queued','articles','crosscut','compose','review','index']` (client.js:28)——0.10.7 起无 `plan`，`queued` 单列最前表示串行排队。
- 词典：`zh()` (client.js:30-167) 与 `en()` (client.js:168-305) 返回全量中英文文案；0.10.9 新增 `autoCommit`/`autoCommitHint` (client.js:39-40)，大档分区词条 `secBig`/`bigProvider`/`bigTokenBudget`/`bigDisabled` 等 (client.js:64-75)。
- 基础工具：`el(tag,props,...children)` (client.js:399)、`apiGet(p)` (client.js:399)、`apiPost(p,data)` (client.js:399)。
- 模块入口：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})` (client.js:10-12)，factory 返回 `{inject:['slots','locale','configForms'], apply(ctx){...}}` (client.js:426-428)。`apply` 内：`tBound=ctx.locale.bind(NS)` (client.js:426)、词典注册 (client.js:426)、`form=ctx.configForms.get(NS)` (client.js:426)、`mount` 注册 `plugins.item` (client.js:426-438)、侧边栏双 slot 注册面板与 `PanelIcon` (client.js:435-446)。
- 设置卡片 `CodewikiCard` (client.js:458-857)：状态 `snapshot`/`draft`/`notice`/`error`/`catalog`/`catalogError` (client.js:458-465)；挂载拉 `MODELS_PATH` (client.js:464-475)；订阅快照按 `revision` 覆盖草稿 (client.js:458-475)；`setPath` (client.js:458)、`dirty` memo (client.js:458)、`selectedProvider` memo (client.js:515)；`useEfforts(provider,model)` hook (client.js:524-555) 二次拉档位，普通档与大档各一份 (client.js:556-557)；`modelTrio({...})` (client.js:562-661) 渲染 provider/model/effort 三行，换 provider 清空 model 与旧档位 (client.js:579-586)，`allowEmptyProvider` 时首项「（未启用大档）」(client.js:458)，目录缺失退文本输入 (client.js:570-576)，已配置但目录缺失的 provider/model 保留选项 (client.js:590-593)；`save()` (client.js:458-480) 校验 `maxConcurrency` 1–8 整数 (client.js:458-462)，保存键白名单 19 项 (client.js:458) `['enabled','binaryPath','maxConcurrency','serialProjects','articleLanguage','updateReminder','autoCommit','workspaceOnly','batchProvider','batchModel','batchReasoningEffort','bigProvider','bigModel','bigReasoningEffort','bigTokenBudget','sessionTier','excludePaths','autoUpdate','autoUpdateMin']`，`form.mutate(ops, revision)` 单层 op + CAS；`discard()` (client.js:458)。表单分区：运行节 (client.js:700-773，含 `autoCommit` 开关 client.js:721-729)、编译模型节 (client.js:458-473)、大档节 (client.js:458-473)、调度与排除节 (client.js:458-490)、保存条 (client.js:458-465)。
- 面板辅助：`stageLabel` (client.js:863)、`stateLabel` (client.js:863)、`kindLabelOf` (client.js:863)、`progressBar` (client.js:863)、`repoName` (client.js:864)、`fmtMs` (client.js:863)、`fmtTok` (client.js:863)、`fmtDur` (client.js:881)、`fmtAgo` (client.js:887)、`Spark` (client.js:863)、`stepName` (client.js:863)、`lastTimedStage(job)` (client.js:863-866，过滤 `ACTIVE_STAGES` 防旧任务残留 `plan` 键导致失败不标红)、`stageBar` (client.js:915)、`STAGE_WEIGHTS={queued:0,articles:0.65,crosscut:0.1,compose:0.05,review:0.15,index:0.05}` (client.js:863，plan 的 0.05 已并入 articles)、`overallPct` (client.js:863)、`throughputBadge` (client.js:863)、`usageLine` (client.js:863)。
- `ReposTab` (client.js:998-1141)：轮询 `REPOS_PATH` (client.js:998-1014)；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并 POST `control refresh` (client.js:998-1016)；`compile` POST `{action:'compile',cwd}` (client.js:998-1006)。
- `CodewikiPanel` (client.js:1143-1343)：轮询 `JOBS_PATH` 防重入并差分采样 tps/批量速率 (client.js:1143-1183)；`cancel` POST control (client.js:1143-1151)；`copyPath` 剪贴板 (client.js:1204-1210)；按 cwd 分组 (client.js:1143-1149)；焦点任务选择 (client.js:1143-1146)；`jobCard` 渲染 (client.js:1143-1201)；三标签页 总览/任务/设置 (client.js:1299-1308)。
- `PanelIcon` (client.js:1352-1363)：内联 SVG 书页图标。

### `cordis.patch.yml` (cordis.patch.yml:2-16)

Bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂 (cordis.patch.yml:2-3)。

- 注释设置项清单 (cordis.patch.yml:5-13)：`binaryPath` (5)、`batchProvider`（必须是模型设置里已注册的 provider，留空=提交失败，6）、`batchModel`（默认 hy3，7）、`batchReasoningEffort` (8)、`maxConcurrency`（1–8 默认 2，9）、`serialProjects`（默认开，10）、`articleLanguage` (11)、`updateReminder` (12)。**注意这份注释是子集**：`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`workspaceOnly` 未列入，完整清单以 `Config` (index.js:51-71) 为准。
- `insert:` 节点 (cordis.patch.yml:13-16)：`id: codewiki` (14)、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (15，空格转 %20)、`config: {}` (16)。id 与 client.js:18 的 `NS`、client.js:18 的 `KEY` 三处必须一致。无代码函数。

### `index.js` 的 `Config` 与 `liveConfig` (index.js)

`Config` z.object (index.js:51-71) 含 19 字段，全部 `.volatile()`：

| 字段 | 定义行 | 类型/默认 | 语义 |
| --- | --- | --- | --- |
| `enabled` | index.js:49 | boolean / `true` | 停用后两个工具立即报错 |
| `binaryPath` | index.js:108 | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)`（`resolveBinary` index.js:108） |
| `batchProvider` | index.js:51 | string / `'workbuddy'` (index.js:26) | 编译模型提供商；**留空将无法提交任务**（0.10.1 起无内置直连） |
| `batchModel` | index.js:52 | string / `'hy3'` (index.js:27) | 编译模型 id，全部模型环节共用 |
| `batchReasoningEffort` | index.js:53 | string / `''` | 思考档位 id；可选值由模型目录实时读取（/api/codewiki/model-efforts） |
| `bigProvider` | index.js:54 | string / `'volces-ark'` (index.js:30) | 大档提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | index.js:55 | string / `'glm-5.3-flash'` (index.js:31) | 大档模型 id（512k 上下文） |
| `bigReasoningEffort` | index.js:56 | string / `''` | 大档思考档位 |
| `bigTokenBudget` | index.js:57 | number / `420000` (index.js:33) | 大档单请求输入预算；模块源码总量超此值才拆观察→合成，单文件超此值转会话通道 |
| `sessionTier` | index.js:58 | string / `''` | 会话通道档位 id（dsh-subagent-auto-router 档位）；留空=自动选路 |
| `maxConcurrency` | index.js:59 | number / `2` (index.js:24) | 编译请求并发上限 1–8，硬顶 `CONCURRENCY_HARD_CAP=8` (index.js:22) |
| `serialProjects` | index.js:60 | boolean / `true` | 单项目串行：其余仓库任务进 queued 排队 |
| `articleLanguage` | index.js:61 | string / `'中文'` | wiki 文章书写语言 |
| `updateReminder` | index.js:62 | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒 |
| `autoCommit` | index.js:63 | boolean / `true` | 0.10.9：编译完成后由插件自己提交产物（只 add `.codewiki/` 与 `CodeWiki.md`） |
| `excludePaths` | index.js:252 | string / `''` | 排除清单：换行/分号/逗号分隔绝对路径，命中拒编译（`excludedItem` index.js:252） |
| `autoUpdate` | index.js:65 | boolean / `false` | 定时扫描历史工作区提交增量编译 |
| `autoUpdateMin` | index.js:66 | number / `30` | 扫描间隔分钟，最小 5（liveConfig index.js:95） |
| `workspaceOnly` | index.js:67 | boolean / `true` | 任务页/总览只显示已添加 dsh 工作区任务 |

`liveConfig(config)` (index.js:77-101) 归一化：`bigTokenBudget` 下限被 `BATCH_TOKEN_BUDGET` 110k 兜住 (index.js:77)；`maxConcurrency` clamp 到 1–`CONCURRENCY_HARD_CAP`，非法值回落 `DEFAULT_CONCURRENCY=2` (index.js:77-79)；`articleLanguage` 空值回落 `'中文'` (index.js:92)；`serialProjects`/`autoCommit`/`workspaceOnly` 用 `!== false` 保默认 (index.js:91/96/97)；`autoUpdate` 需 `=== true` (index.js:94)。0.10.1 起无任何密钥字段。

其他相关常量：`PLUGIN_NAME='dsh-codewiki'` (index.js:1015)、`JOBS_FILE` 默认 `os.tmpdir()/dsh-codewiki-jobs.json` (index.js:1015)、`TICK_MS` 默认 10s (index.js:1013)、`SESSION_TASK_DIR` (index.js:1015)、`ORPHAN_TAKEOVER_MS` 默认 5 分钟 (index.js:1015)、`MAX_JOBS_KEPT=30` (index.js:1015)、`REPOS_FILE` (index.js:1015)、`JOB_TERMINAL={done,failed,cancelled}` (index.js:1015)、`commitHintCache` 60s TTL (index.js:1015)。

### `package.json` (package.json:1-28)

包身份与宿主识别标志。

| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| package.json:2-3 | `name`/`version` | `@local/dsh-codewiki` / `0.10.9` | 与 CHANGELOG 同步；id 必须等于 client.js:10 的加载 id |
| package.json:7 | `main` | `index.js` | 服务端半侧入口 |
| package.json:8-11 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | 两个半侧显式导出 |
| package.json:13-16 | `engines` | `node >=20`、`dsh >=0.2.0-rc.0` | 兼容性判定（0.2.1-rc.1 起第三方插件按 engines.dsh 判定） |
| package.json:17-19 | `dependencies` | `@deepseek-ai/schemastery` | 唯一依赖，仅 `Config` 用 |
| package.json:22-25 | `dsh.client.platform` | `"web"` | 驱动宿主扫描器把 client.js 送进浏览器 |
| package.json:25-27 | `dsh.bundle.patch` | `"cordis.patch.yml"` | bundle 安装找补丁 |

### `README.md` (README.md:1-67)

面向使用者的文档：工具表 (README.md:11-17) 列 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`/设置页；`codewiki_generate` 关键行为 (README.md:15-22)；设置节 (README.md:11-27) 逐项解释 `batchProvider`/`batchModel` (29，0.10.1 起唯一通道)、`batchReasoningEffort` (30)、大档四项 (31)、`sessionTier` (32)、`binaryPath`/`maxConcurrency`/`serialProjects`/`articleLanguage`/`updateReminder` (34-38)、`autoCommit` (39，含完整安全边界描述)；安装 (README.md:11-26) 用 file:/// 直挂；开发节 (README.md:11-17) 指向 vendor/codewiki、bin/cw.exe、client.js 与验证命令。

### `test-batch.mjs` (test-batch.mjs:1-501)

纯函数自检（`node test-batch.mjs`）。从 index.js 导入 (test-batch.mjs:173-178)：`collectSources`、`classifySessionTask`、`estimateTokens`、`fixAnchors`、`numberLines`、`buildSessionSteerText`、`prepareArticleTasks`、`runRealtimeTasks`、`localPlan`、`packArticles`、`scanRepoFiles`、`listModelCatalog`、`resolveModelEfforts`、`installWebServer`。假 llm 用 `makeLlm(reply)` (test-batch.mjs:173-188) 按 stream 协议吐块。覆盖：estimateTokens 计费 (test-batch.mjs:24)、collectSources 装填/oversized (31)、numberLines 尾换行 (47)、prepareArticleTasks 普通/大档单请求/超大会话通道 (54)、多文件观察批分割 (87)、大档模型接管与关闭回退 (108)、`classifySessionTask` 三态 (134)、`buildSessionSteerText` 档位钉死 (152)、runRealtimeTasks 通道/混合档分派/tps/abort/失败记账 (169-338)、localPlan 分组 (277)、packArticles 截断 (290)、scanRepoFiles 黑名单 (303)、listModelCatalog (340)、`/api/codewiki/models` 端点回环 403 (364)、resolveModelEfforts 与 model-efforts 端点 (394)、0.10.1 反向断言不再导出 `resolveBatchApiKey` (448-451)、fixAnchors 符号修正 13 项 (453-495)。

### `test-orchestration.mjs` (test-orchestration.mjs:1-1270)

服务化编排冒烟（`node test-orchestration.mjs`）。导入 `{name, apply}` (test-orchestration.mjs:38)；设 `DSH_CODEWIKI_TICK_MS='300'` (15) 与独立 `DSH_CODEWIKI_JOBS_FILE` (19)。测试配置基线 `batchCfg()` (test-orchestration.mjs:38) 固定 `workbuddy`/`hy3`。辅助：`makeCtx` (40，模拟 cordis inject 切片语义)、`makeMockAgent` (83)、`makeFixtureRepo` (99，**自带 git identity** user.name/email——0.10.9 起 autoCommitWiki 缺身份会拒绝提交，test-orchestration.mjs:38-41)、`makeBatchMock` (134，假 llm 按 prompt 首行特征应答)、`waitJob` (201)、`fakeReq`/`fakeRes` (216/226)。覆盖块：系统提示提醒 (231)、注册 (262)、cw 工具 (275)、codewiki_update+commitHintText (282)、autoCommitWiki 安全边界 (377-448：正常提交只含两路径、noChanges 不空提交、非 git/被 ignore/合并中/缺身份各拒绝分支)、wakeCompileSession 唤醒与零打扰 (451-482：autoCommit 成功 → done 完全不唤醒，test-orchestration.mjs:38-39)、本地规划 (485)、全量编译阶段机 (544)、横切拆分 (585)、文章观察→合成分割 (615)、单项目串行排队 (651)、唯一通道 (700)、stale 逐篇更新 (734)、codewiki_progress (757)、宿主重启重跑与旧 plan 任务迁移 (793)、并发占位合并 (853)、面板端点与取消 (893)、排除清单 (947)、knownRepos (1002)、工作区过滤 (1042)、registry 异常降级 (1105)、schema 校验 (1135)、孤儿接管 (1175)、模型缺失诚实报错 (1209)、严格 cordis 语义 (1224)、Temp 清理 (1248)。

## Architecture

```text
┌────────────────────── 配置的四层表示 ──────────────────────┐
│ package.json:20-26 (dsh.*) → cordis.patch.yml:13-16         │
│        │ (id=codewiki，三处一致: client.js:17/18)            │
│        ▼                                                     │
│ index.js:48 Config (19字段 .volatile())                      │
│        ├──► index.js:74 liveConfig() 解包（execute/tick 热读）│
│        │       ▼                                             │
│        │   消费端: resolveBinary(105) / installWebServer(2646)│
│        └──► client.js:417 configForms.get('codewiki')        │
│                │ getSnapshot / mutate(ops, revision)         │
│                ▼                                             │
│           CodewikiCard (client.js:452) 设置表单               │
└─────────────────────────────────────────────────────────────┘
  client.js:19/20/23/24/25 ──HTTP(回环)──► index.js:2646 端点:
  /jobs /repos /models /model-efforts /control
```

## Data Flow

1. **配置流**：`cordis.patch.yml:13-16` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)` (index.js:3048) → 每次执行前 `liveConfig(config)` (index.js:3048) 解包 volatile 值 → 落到 `resolveBinary` (index.js:3048)、`installWebServer` (index.js:3048)、阶段 tick 等消费点。每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` 挂载 → 拉 `/api/codewiki/models` 得 provider 目录 (client.js:458-469) → 用户编辑 `draft` → `dirty` 深比较 (client.js:458) → `save()` 生成单层 `{op:'set'}` 数组（白名单 client.js:458）→ `form.mutate(ops, revision)` CAS 写入 → 宿主持久化 + 热生效 → 订阅回调收到新 `revision` 回填草稿 (client.js:458-475)。
3. **模型目录与档位发现流**：`GET /api/codewiki/models` (注册于 index.js:2604) → `listModelCatalog(llmRef)` (index.js:2604-2625) → 返回 `{ok, providers:[{id,name,models:[{id,name}],error?}]}`；`GET /api/codewiki/model-efforts?provider=&model=` (注册于 index.js:2604) → `resolveModelEfforts` (index.js:2604-2626) → `resolveModelInfoOf` (index.js:2604-2609，优先宿主 `resolveModelInfo`、回落 `resolveModel`) → 返回 `{ok,provider,model,efforts:[{id,name,description}],defaultEffort,context}`。设置页 `useEfforts` (client.js:528) 消费。
4. **文档补建流**：编译收尾 `tickIndex` → `ensureWikiEntry(job.cwd, language)` (index.js:2010-2043) → 仓库根缺 `CodeWiki.md` 则按语言写双语模板，已有入口绝不覆盖。
5. **提醒与自动提交流**：`installUpdateReminder` (index.js:3014) 在 agent 创建时注册系统提示 section `codewiki:update-reminder`；text 回调每次组装时求值 (index.js:3014-3020)——`updateReminder === false`、仓库根无 `CodeWiki.md` 返回空串，否则拼 `reminderText(cwd)` (index.js:2978-2987) 与 `commitHintText(cwd)` (index.js:3014-3043，比较最近编译 `finishedAt` 与 `git log` 时间戳，60s TTL 缓存 index.js:3014)。0.10.9 起 `tickIndex` (index.js:3014-3020) 在编译终态调用 `autoCommitWiki` (index.js:3014-3055) 由插件自己提交产物，成功则 `wakeCompileSession` (index.js:3014) 直接 return 不打扰会话。
6. **编排任务流**：工具 `codewiki_generate.execute` (index.js:2131) 先 `runCw status` 判态 → `svc.submit` (index.js:2131) 建 job → `tick()` (index.js:2131) 按 `STAGE_HANDLER` (index.js:2131) 调阶段函数 → `prepareArticleTasks` (index.js:2131) 拆普通/大档/会话通道任务 → `submitBatchFor` (index.js:2131)/`startBatchChatRun` (index.js:2131)/`runRealtimeTasks` (index.js:2131)/`llmChat` (index.js:2131，唯一模型通道) → `settleJob` (index.js:2131) 收割、`writeValidated` (index.js:2131) 校验落盘。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki` (MIT)，提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其本地 fork（CodeWiki.md:62）。
- [[plugin-orchestration]] — `createJobService` (index.js:1238) 驱动的阶段机 queued→articles→crosscut→compose→review→index（0.10.7 起无 plan；CodeWiki.md:20），本文的配置项（并发、模型三档、语言、排除清单、自动更新、autoCommit）全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方（`CodewikiPanel` client.js:1143 / `ReposTab` client.js:1143）。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制（CodeWiki.md:63）。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh（配置值本身热读）。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，package.json:22 的 `dsh.client.platform` 声明新增后也需重启才会把 client.js 送进浏览器 (CodeWiki.md:31)。
2. **Junction 依赖**：`@deepseek-ai/schemastery` (package.json:18，仅供 `Config` 用) 靠插件本地 junction 解析；换机器需重建 (CodeWiki.md:68)。
3. **文档清单是子集**：`cordis.patch.yml:4-12` 注释只列 8 项设置，`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`workspaceOnly` 未列入；完整字段以 `Config` (index.js:51-71) 与 client.js:672 白名单为准。旧版文档若残留 `defaultProvider`/`batchApiKey` 等已删字段一律作废（0.10.1 删内置直连，CHANGELOG.md:436）。
4. **新增 Config 字段要改四处**：index.js:48（schema）、index.js:74（liveConfig 解包）、client.js:672（保存字段白名单）、`README.md`（人工文档）。漏掉 client.js:672 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback `<cwd>/.codewiki` (`wikiPathFor` index.js:993-998)。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠，插件消费侧由 `normalizeArticlePath` (index.js:167) / `normalizeIndexLinks` (index.js:167) 归一为 `/`（0.5.0.2 起 Rust 层根治，插件层保留为纵深防御，index.js:167-171 注释）。
7. **会话通道依赖发起会话**：`job.sessionId` 为空（面板提交/自动调度）时，超预算文章与校对任务直接整体失败并明示原因 (`dispatchSessionTasks` index.js:2286-2292)，不退大档兜底、不静默跳过校对；超时默认 30 分钟 (`SESSION_TASK_TIMEOUT_MS` index.js:2286，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调)。只有单文件连大档预算都装不下（或 bigProvider 留空）才转会话通道 (`prepareArticleTasks` index.js:2286、CodeWiki.md:75)。
8. **维护提醒依赖 `CodeWiki.md` 与 git**：`reminderText` 在仓库根无 `CodeWiki.md` 时整段不出现 (index.js:3003)，入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒 (index.js:3003 catch)。
9. **严格 cordis 语义**：`apply` (index.js:3048) 用 `ctx.inject` 获取 `agents`/`llm` 服务 (index.js:3048-3049)，禁止直接访问 `ctx.xxx`（否则抛 without inject）；工具注册单工具失败仅丢该工具不回滚全部 (index.js:3048-3060)。
10. **任务拆分边界**：普通单请求预算 `BATCH_TOKEN_BUDGET=110000` (index.js:371)，装填上限=大档预算或 `BATCH_TOKEN_HARD_LIMIT=128000` (index.js:376)；110k–420k 区间大档单请求一次写完，模块总量超 `bigTokenBudget` (index.js:57) 才拆观察批 `#obs`，单文件连大档都装不下才转会话通道。0.10.3 修掉 `batches.length===1` 误判转会话的缺陷 (CHANGELOG.md:94-103)。
11. **Web 安全**：`isLoopbackRequest` (index.js:2568-2571) 仅放行 127.0.0.1/::1；请求体超 1MB 拒绝 (`readBodyJson` index.js:2568-2586)。工作区过滤对终态任务生效、非终态任务始终可见 (index.js:2568-2572)。
12. **大档空 provider**：`modelTrio` 的 `allowEmptyProvider:true` 时首项「（未启用大档）」(client.js:568)，未选 provider 时 effort 区显 `bigDisabled` 提示 (client.js:568)。目录/档位拉取失败退化为文本输入，不阻断保存 (client.js:568-574)。
13. **二进制解析**：`resolveBinary` (index.js:108-128) PATH `where`/`which` 优先，失败回退捆绑 `bin/cw(.exe)`，再不行返回 `'cw'` 让 spawn 报错；`runCw` (index.js:108-133) 超时 `SIGKILL`，`signal` abort 杀进程。
14. **autoCommit 拒绝分支**：`autoCommitWiki` (index.js:2926-2967) 在非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中 (index.js:2926-2928)、目标路径未解决冲突 (2917)、`.codewiki/` 被 `.gitignore` 忽略 (2918-2924)、缺 `user.name`/`user.email` (2926-2928) 时一律拒绝并降级为「产物待提交」提醒——绝不半个提交；只 add `.codewiki` 与 `CodeWiki.md` 两个路径 (index.js:2926)、不跑仓库钩子 (`--no-verify`，2938)。
15. **非显然语义**：`queued` 置于 `ACTIVE_STAGES` 首位点亮第 0 点表示串行排队 (client.js:27-28)；旧任务残留的 `plan` 计时键被 `lastTimedStage` 过滤 (client.js:28-33)；插件不保存/传递任何密钥，凭证全由宿主 `llm.stream()` 从模型设置解析 (index.js:2064-2069)；.gitignore:5-6 的 `bin/*.bak-*` 是丢失源码时代的安全网，不忽略 `bin/cw.exe` 本身；测试 fixture 必须自带 git identity，否则 e2e 只能走 autoCommit 降级分支 (test-orchestration.mjs:172-175)。