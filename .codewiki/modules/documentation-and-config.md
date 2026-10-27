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

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json` (package.json:25-28)、`cordis.patch.yml` (cordis.patch.yml:22-33)、`index.js` 中的 `Config` schema (index.js:102-122) 与 `liveConfig` (index.js:92-117)、`client.js` 的设置表单与侧边栏面板 (client.js:7-1381)、`README.md` (README.md:1-155)、`CodeWiki.md` (CodeWiki.md:1-75)、`CHANGELOG.md` (CHANGELOG.md:1-956)、`.gitignore` (.gitignore:1-12) 与两个自检脚本 `test-batch.mjs` (test-batch.mjs:1-642) / `test-orchestration.mjs` (test-orchestration.mjs:1-1358) 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema (`Config`，index.js:70)、运行时快照 (`liveConfig`，index.js:102)、浏览器草稿 (`snapshot`/`draft`，client.js:552-553)、人工文档 (`README.md` 与 `CodeWiki.md`)。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包 (index.js:92-117)、client.js:92 的保存键白名单、以及 README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面 (v0.14.0，package.json:3) 的字段全集共 19 项 (index.js:3491-3509)，全部 `.volatile()`——每次 `execute`/`tick` 经 `liveConfig` (index.js:102) 重新解包，改完立即生效，不需要重启 dsh。编译模型三档齐备：普通档 (`batchProvider`/`batchModel`/`batchReasoningEffort`，index.js:2271-2273)、大档 (`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`，index.js:55-58，0.10.4 引入、0.10.8 全面启用)、会话通道兜底档位 `sessionTier` (index.js:3346)。0.10.1 起删除内置百炼直连 (CHANGELOG.md:291-303)，`batchProvider` 留空提交即失败 (index.js:2386)，插件不保存任何密钥。0.10.9 新增 `autoCommit` (index.js:4655)：编译产物由插件自己提交，会话模型不再等待编译或代跑 git (CHANGELOG.md:395-409)；0.10.10 补齐三态语义——`autoCommitState` (index.js:4265-4270) 是唤醒与系统提示两条通道共用的唯一判定 (CHANGELOG.md:305)，`git add` 改用 pathspec 形式而非 `-A`（路径唯一来源 `WIKI_PATHS` index.js:45，CHANGELOG.md:306）。0.10.11 把提交升级为阶段机里的**独立 commit 阶段**并改走**分支合并式**——`tickIndex` 有产物且开关开启时 `setStage('commit')` 提前返回 (index.js:2843-2846)，`tickCommit` (index.js:3906-3922) 调 `autoCommitWiki` (index.js:3906-3988) 先在主题分支 `codewiki/wiki-<jobId>` 上提交、再合并回原分支并删除主题分支 (CHANGELOG.md:292)，产物提交不再长在用户当前分支的收尾里，终态 done 最多晚一个 tick (CHANGELOG.md:291)。模型目录发现由 `listModelCatalog` (index.js:3516-3537) 与端点 `GET /api/codewiki/models` (index.js:3516-3531)、档位端点 `GET /api/codewiki/model-efforts` (index.js:658-678，客户端常量 client.js:658) 支持，设置页的模型选择是 provider/model/effort 三级联动 (`modelTrio`，client.js:658-757)。

## Key Components

### `.gitignore` (.gitignore:1-12)

运行期产物与构建产物的边界，纯声明文件：

- .gitignore:1-3 忽略 `node_modules/`、`vendor/codewiki/target/`、`*.log`
- .gitignore:5-6 `bin/*.bak-*` 二进制备份安全网（丢失源码时代的最后产物；**不**忽略 `bin/cw.exe` 本身）
- .gitignore:8-9 `.orch-test-out.txt`、`.probe3.txt` 探测残留
- .gitignore:11-12 `.dsh-ops/` DSH 运行期产物（面板会话流、工具调用记录），不入库
- 注意 `.codewiki/` 不在忽略列表——wiki 必须随仓库提交；若被项目级 ignore 忽略，`autoCommitWiki` (index.js:4655-4737) 会拒绝自动提交而不是静默丢产物 (index.js:3906-3909)。

### `CHANGELOG.md` (CHANGELOG.md:1-956)

插件从 0.1.0 (CHANGELOG.md:942) 到 0.14.0 (CHANGELOG.md:3) 的完整变更日志，记录修复、功能、测试与配置演变，是本模块行为演变的事实来源。近期关键版本：

- 0.10.11 (CHANGELOG.md:286-298)：编译收尾新增独立 commit 阶段——`STAGE_HANDLER` 加 `commit: tickCommit` (index.js:3482)，阶段顺序变为 queued → articles → crosscut → compose → review → index → commit → done，终态最多晚一个 tick，中途死在 commit 阶段的任务重启后重跑本阶段、对已入库产物报 noChanges 幂等 (CHANGELOG.md:291)；`autoCommitWiki` 重写为「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → `git branch -d` 删主题分支」(CHANGELOG.md:292，实现 index.js:4655-4687)；detached HEAD/建分支失败降级直接提交、合并失败中止并保留主题分支、全部前置安全检查在分支切换之前执行 (CHANGELOG.md:293，实现 index.js:33-48/3016-3023)；面板 `ACTIVE_STAGES` 加 `commit`、进度权重 articles 0.63/commit 0.02 (CHANGELOG.md:294，实现 client.js:292/947)；`codewiki_progress` 的 autoCommit 输出加 `mode`/`branch`/`fallback` (CHANGELOG.md:295，实现 index.js:962-964)。
- 0.10.10 (CHANGELOG.md:300-314)：两轴 code-review 修复——① `autoCommitState` (index.js:2271-2276) 成为自动提交三态（`committed`/`no-changes`/`pending`）的唯一判定，唤醒与系统提示两条通道共用，`no-changes` 一律静默 (CHANGELOG.md:305)；② `git add -A -- .codewiki CodeWiki.md` 改为 `git add -- .codewiki CodeWiki.md`（pathspec 形式，CHANGELOG.md:306）；③ 自动提交失败原因（含 `index.lock` 被并发占用等 git stderr 摘录）写进 `reason` (CHANGELOG.md:307，实现 index.js:985/2989)；④ 面板任务卡显示三态（成功短 sha/「产物无改动，未提交」/「产物未自动提交（原因）」）(CHANGELOG.md:308，实现 client.js:221-229)；⑤⑥ 两处测试竞态修复——jobs 测试文件名追加随机 token (CHANGELOG.md:310，实现 test-orchestration.mjs:19-23)、并发提交块改 `stall` mock (CHANGELOG.md:309，实现 test-orchestration.mjs:943-947)。
- 0.10.9 (CHANGELOG.md:316-330)：`autoCommitWiki` (index.js:4655) 把「等编译完成 → 会话模型代跑 git」收回插件侧 (CHANGELOG.md:321)；`wakeCompileSession` (index.js:2278) 在自动提交成功时完全不打扰会话 (CHANGELOG.md:323，静默 return index.js:81)；安全边界逐条列出 (CHANGELOG.md:321)；设置项 `autoCommit` 默认 true (CHANGELOG.md:325、index.js:81)。
- 0.10.8 (CHANGELOG.md:339-351)：编译流水线适配 hy3 192k——放弃 32k 时代拆批策略，`prepareArticleTasks` (index.js:1165-1250) 改大档单请求优先 (CHANGELOG.md:339)；审校改**批量校对** `batchProofreadBatchPrompt` (index.js:2030-2057)/`settleProofread` (index.js:2030-2054) (CHANGELOG.md:340)；面板 `lastTimedStage` 过滤 `ACTIVE_STAGES` (CHANGELOG.md:340，实现 client.js:33-36)。
- 0.10.7 (CHANGELOG.md:351-360)：删除规划阶段——`tickPlan`/`batchPlannerPrompt`/`parsePlan` 三段全删，模块清单由 `localPlan` (index.js:1300-1313) 按顶层目录本地分组 (CHANGELOG.md:351)。
- 0.10.6 (CHANGELOG.md:357-365)：非终态任务的工作区过滤放行——jobs/repos 端点不再藏掉占串行闸门的非终态编译中任务 (index.js:2836-2837，CHANGELOG.md:363)。
- 0.10.5 (CHANGELOG.md:367-377)：`codewiki_progress` 输出 schema 的 `progress` 补 null 分支 (index.js:3367，CHANGELOG.md:373)。
- 0.10.4 (CHANGELOG.md:385-411)：`resolveModelInfoOf(llm)` 修正宿主方法名（`LlmService` 暴露的是 `resolveModelInfo`，`resolveModel` 只在 adapter 注册表接口）(index.js:4290-4295，CHANGELOG.md:384)；新增大档四项配置 (CHANGELOG.md:388-391，index.js:448-451)。
- 0.10.3 (CHANGELOG.md:407-416)：修掉「单文件 110k–128k 分不出多批被误判装不下而白送会话通道」的缺陷。
- 0.10.1 (CHANGELOG.md:430-442)：删除 `bailianChat` 内置直连与 `resolveBatchApiKey` 凭证解析链 (CHANGELOG.md:434)，`llmChat` (index.js:467-486) 成为唯一模型通道，`submit` 硬校验 provider/model/llm 三项 (index.js:3579-3588，CHANGELOG.md:437)。

重要常量与默认值：`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:1881)、`DEFAULT_BATCH_MODEL='hy3'` (index.js:1378)、`BATCH_TOKEN_BUDGET=110000` (index.js:1378)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:1378)、大档默认 `volces-ark`/`glm-5.3-flash`/`420000` (index.js:1378-1381)、`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (index.js:73)、`serialProjects` 默认 true (index.js:71)、`maxConcurrency` 默认 2 (index.js:71) / 硬顶 `CONCURRENCY_HARD_CAP=8` (index.js:71)。

### `CodeWiki.md` (CodeWiki.md:1-75)

插件自身的项目 wiki 入口（CodeWiki.md 公约），结构：Overview (CodeWiki.md:5-7)、Key Components (CodeWiki.md:9-31)、Architecture (CodeWiki.md:33-57)、Data Flow (CodeWiki.md:59-61)、Connections (CodeWiki.md:63-66)、Known Issues (CodeWiki.md:68-75)。

- Key Components 逐条列出 `Config` (CodeWiki.md:12)、`buildSessionSteerText` (CodeWiki.md:13)、`installUpdateReminder` (CodeWiki.md:14)、`autoCommitWiki` (CodeWiki.md:15，逐条安全边界)、`autoCommitState` (CodeWiki.md:16，0.10.10)、`wakeCompileSession` (CodeWiki.md:17)、`runCw`/`parseStatus` (CodeWiki.md:18)、模型执行模块 (CodeWiki.md:20)、`createJobService` (CodeWiki.md:18)、工具定义 (CodeWiki.md:21-22)、webServer 端点 (CodeWiki.md:23)、`apply` (CodeWiki.md:24)、`client.js` 组件 (CodeWiki.md:26-29)、挂载文件 (CodeWiki.md:30-31)。
- Architecture 图 (CodeWiki.md:35-57) 描绘 queued→articles→crosscut→compose→review→index 阶段机与 autoCommitWiki 收尾（0.10.7 后无 plan；compose 仅在输入超 420k 大档预算的拆分时出现；两条通道的三态判定共用 `autoCommitState()`，CodeWiki.md:54）。
- Known Issues (CodeWiki.md:70-75) 记录插件注册不热加载、junction 依赖、断点文件语义、会话通道对发起会话的依赖。
- 本文件是编译产物、内容有滞后：当前停留在 0.10.10 口径——`autoCommitWiki` 条目 (CodeWiki.md:15)、`createJobService` 描述 (CodeWiki.md:20) 与 Architecture 图 (CodeWiki.md:15/50-54) 仍是「index 收尾直接提交」的 0.10.9 描述（图中无 commit 节点、未提主题分支合并），且 CodeWiki.md:15 引用的 `WIKI_PATHS` 锚点写 index.js:35（实际 index.js:35），待下次对本仓库重编译时由流水线刷新。

### `client.js` (client.js:10-1384)

浏览器半侧：注册插件页设置卡片 (`plugins.item`) 与侧边栏面板 (`main`+`sidebar.panellist`)，经 `configForms` 读写命名空间 `codewiki`，轮询宿主端点（挂载点说明 client.js:1-8）。

- 挂载常量：`NS='codewiki'` (client.js:19)、`KEY='codewiki'` (client.js:20)、`JOBS_PATH` (client.js:23)、`CONTROL_PATH` (client.js:26)、`PANEL_ORDER=52` (client.js:27)、`POLL_MS=2000` (client.js:23)、`REPOS_PATH` (client.js:26)、`MODELS_PATH` (client.js:27)、`EFFORTS_PATH` (client.js:27)、`REPOS_POLL_MS=10000` (client.js:27)。`ACTIVE_STAGES=['queued','articles','crosscut','compose','review','index','commit']` (client.js:246)——0.10.7 起无 `plan`、0.10.11 起加 `commit`，`queued` 单列最前表示串行排队 (client.js:27 注释)。
- 词典：`zh()` (client.js:81-222) 与 `en()` (client.js:81-222) 返回全量中英文文案；`autoCommit`/`autoCommitHint` (client.js:45-46 zh、client.js:45-46 en，0.10.11 起 hint 描述「主题分支 codewiki/wiki-<任务id> 提交后合并回原分支并删除」的完整语义)；阶段词条含 `stageCommit: '提交产物中'`/`'Committing'` (client.js:150 zh、client.js:150 en)；自动提交三态词条 `autoCommitOk`/`autoCommitNone`/`autoCommitPending` (client.js:152-154 zh、client.js:88-90 en)；大档分区词条 `secBig`/`bigProvider`/`bigProviderOff`/`bigTokenBudget`/`bigDisabled` 等 (client.js:111-122 zh、client.js:70-81 en)；`sessionTier` (client.js:70-71 zh、client.js:70-71 en)。
- 基础工具：`el(tag,props,...children)` (client.js:491-493)、`apiGet(p)` (client.js:497-502)、`apiPost(p,data)` (client.js:495-504)。
- 模块入口：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})` (client.js:10-12)，factory 返回 `{inject:['slots','locale','configForms'], apply(ctx){...}}` (client.js:511-513)。`apply` 内：`tBound` 与词典注册 (client.js:518-519)、`form=ctx.configForms.get(NS)` (client.js:1688)、`mount` 注册 `plugins.item`（order 30，client.js:428-440，`whileServed` 门控 436-440）、侧边栏双 slot 注册面板与 `PanelIcon`（main key=KEY 445、panellist id=KEY order=PANEL_ORDER 446-451，client.js:1665-1676）。
- 设置卡片 `CodewikiCard` (client.js:550-949)：状态 `snapshot`/`draft`/`notice`/`error` (client.js:26-29)、`catalog`/`catalogError` (client.js:598-599)；挂载拉 `MODELS_PATH` (client.js:607-618)；订阅快照按 `revision` 覆盖草稿 (client.js:613-630)；summary 视图 (client.js:622)；`setPath` (client.js:660-667)、`dirty` memo (client.js:766-769)、`selectedProvider` memo (client.js:515-519)；`useEfforts(provider,model)` hook (client.js:807-838) 二次拉档位，普通档与大档各一份实例 (client.js:658-659)；`modelTrio({...})` (client.js:658-757) 渲染 provider/model/effort 三行，换 provider 清空 model 与旧档位 (client.js:657-664)，`allowEmptyProvider` 时首项「（未启用大档）」(client.js:657)，目录缺失退文本输入 (client.js:657-662)、错误提示 (client.js:764-766)，已配置但目录缺失的 provider/model 保留选项 (client.js:764-767)；`save()` (client.js:71-93) 校验 `maxConcurrency` 1–8 整数 (client.js:71-75)，保存键白名单 19 项 (client.js:797)，`form.mutate(ops, revision)` 单层 op + CAS (client.js:805)；`discard()` (client.js:805-809)；loading 态 (client.js:805-807)。表单渲染 (client.js:81-234)：运行节 (client.js:81-154，含 `autoCommit` 开关 client.js:81-89)、编译模型节 (client.js:81-96)、大档节 (client.js:81-96)、调度与排除节 (client.js:81-113)、保存条 (client.js:81-87)。
- 面板辅助：`stageLabel`/`stateLabel`/`kindLabelOf` (client.js:1045-1047)、`progressBar` (client.js:1047-1050)、`repoName` (client.js:1051-1054)、`fmtMs` (client.js:1055-1061)、`fmtTok` (client.js:1062-1067)、`fmtDur` (client.js:1068-1073)、`fmtAgo` (client.js:1074-1077)、`Spark` (client.js:1079-1091)、`stepName` (client.js:1096)、`lastTimedStage(job)` (client.js:33-36，过滤 `ACTIVE_STAGES` 防旧任务残留 `plan` 键导致失败/取消不标红)、`stageBar` (client.js:1102-1124，点标签用 `step*` 词条族、悬停 title 用 `stageLabel`)、`STAGE_WEIGHTS={queued:0,articles:0.63,crosscut:0.1,compose:0.05,review:0.15,index:0.05,commit:0.02}` (client.js:1125，0.10.11 起 articles 0.65→0.63 腾出 commit 0.02，总和不变)、`overallPct` (client.js:1130-1138)、`throughputBadge` (client.js:1143-1163)、`usageLine` (client.js:1165-1181)。
- `ReposTab` (client.js:23-166)：轮询 `REPOS_PATH`（10s，client.js:1214-1230）；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并 POST `control refresh` (client.js:1234-1252)；`compile` POST `{action:'compile',cwd}` (client.js:515-523)；调度卡与仓库行渲染 (client.js:1184-1263，仓库行 lastJob 块 1115-1135)。
- `CodewikiPanel` (client.js:19-232)：轮询 `JOBS_PATH`（2s）防重入并差分采样 tps/批量速率 (client.js:1488-1539)；`cancel` POST control (client.js:1497-1505)；`copyPath` 剪贴板 (client.js:1524-1530)；按 cwd 分组 (client.js:1559-1565)；焦点任务选择 (client.js:1426-1430)；`jobCard` 渲染 (client.js:1516-1587，自动提交三态显示于 client.js:1516-1524——成功短 sha + 主题分支名进 meta (1258)、「无改动」一句 (1259)、失败原因存入 `acTitle` 进任务行 `title` 防一行 meta 被撑爆 (1261-1262、1265))；三标签页 总览/任务/设置 (client.js:36-76)。
- `PanelIcon` (client.js:1688-1699)：内联 SVG 书页图标。

### `cordis.patch.yml` (cordis.patch.yml:3-18)

Bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂 (cordis.patch.yml:2-3)。

- 注释设置项清单 (cordis.patch.yml:6-18)：`binaryPath` (6)、`batchProvider`（必须是模型设置里已注册的 provider，留空=提交失败，7）、`batchModel`（默认 hy3，8）、`batchReasoningEffort` (9)、`maxConcurrency`（1–8 默认 2，10）、`serialProjects`（默认开，12）、`articleLanguage` (13)、`updateReminder` (18)。**注意这份注释是子集**：`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 未列入，完整清单以 `Config` (index.js:70-90) 为准。
- `insert:` 节点 (cordis.patch.yml:21-26)：`id: codewiki` (20)、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (21，空格转 %20)、`config: {}` (24)。id 与 package.json:2 的 `name`、client.js:18-19 的 `NS`/`KEY` 三处必须一致。无代码函数。

### `index.js` 的 `Config` 与 `liveConfig` (index.js:102-153)

`Config` z.object (index.js:70-90) 含 19 字段，全部 `.volatile()`：

| 字段 | 定义行 | 类型/默认 | 语义 |
| --- | --- | --- | --- |
| `enabled` | index.js:61 | boolean / `true` | 停用后两个工具立即报错 |
| `binaryPath` | index.js:150 | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)`（`resolveBinary` index.js:140-160） |
| `batchProvider` | index.js:63 | string / `'workbuddy'` (index.js:63) | 编译模型提供商；**留空将无法提交任务**（0.10.1 起无内置直连） |
| `batchModel` | index.js:63 | string / `'hy3'` (index.js:63) | 编译模型 id，全部模型环节共用 |
| `batchReasoningEffort` | index.js:65 | string / `''` | 思考档位 id；可选值由模型目录实时读取（/api/codewiki/model-efforts） |
| `bigProvider` | index.js:66 | string / `'volces-ark'` (index.js:66) | 大档提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | index.js:67 | string / `'glm-5.3-flash'` (index.js:67) | 大档模型 id（512k 上下文） |
| `bigReasoningEffort` | index.js:68 | string / `''` | 大档思考档位 |
| `bigTokenBudget` | index.js:69 | number / `420000` (index.js:69) | 大档单请求输入预算；模块源码总量超此值才拆观察→合成，单文件超此值转会话通道 |
| `sessionTier` | index.js:70 | string / `''` | 会话通道档位 id（dsh-subagent-auto-router 档位）；留空=自动选路 |
| `maxConcurrency` | index.js:71 | number / `2` (index.js:71) | 编译请求并发上限 1–8，硬顶 `CONCURRENCY_HARD_CAP=8` (index.js:31) |
| `serialProjects` | index.js:61 | boolean / `true` | 单项目串行：其余仓库任务进 queued 排队 |
| `articleLanguage` | index.js:75 | string / `'中文'` | wiki 文章书写语言 |
| `updateReminder` | index.js:61 | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒（仅当仓库根存在 `CodeWiki.md` 入口） |
| `autoCommit` | index.js:61 | boolean / `true` | 0.10.9：编译完成后由插件自己提交产物（0.10.11 起走主题分支→合并回原分支，只 add `.codewiki/` 与 `CodeWiki.md`） |
| `excludePaths` | index.js:339 | string / `''` | 排除清单：换行/分号/逗号分隔绝对路径，命中拒编译（`excludedItem` index.js:324-333，报错带命中排除项 index.js:324-328/2297-2298） |
| `autoUpdate` | index.js:83 | boolean / `false` | 定时扫描历史工作区提交增量编译（调度器 index.js:83-112） |
| `autoUpdateMin` | index.js:84 | number / `30` | 扫描间隔分钟，最小 5 (liveConfig index.js:84) |
| `workspaceOnly` | index.js:61 | boolean / `true` | 任务页/总览只显示已添加 dsh 工作区任务 |

`liveConfig(config)` (index.js:102-127) 归一化：`bigTokenBudget` 下限被 `BATCH_TOKEN_BUDGET` 110k 兜住 (index.js:663)；`maxConcurrency` clamp 到 1–`CONCURRENCY_HARD_CAP`，非法值回落 `DEFAULT_CONCURRENCY=2` (index.js:41-43)；`articleLanguage` 空值回落 `'中文'` (index.js:73)；`serialProjects`/`autoCommit`/`workspaceOnly` 用 `!== false` 保默认 (index.js:83/99/100)；`autoUpdate` 需 `=== true` (index.js:63)；`batchModel`/`bigModel` 空值回落各自默认 (index.js:67/87)。0.10.1 起无任何密钥字段。

其他相关常量：`PLUGIN_NAME='dsh-codewiki'` (index.js:39)、`CW_SUBCOMMANDS` 子命令白名单 (index.js:1876)、`WIKI_PATHS=['.codewiki','CodeWiki.md']` (index.js:1877)、`JOBS_FILE` 默认 `os.tmpdir()/dsh-codewiki-jobs.json` (index.js:1881)、`TICK_MS` 默认 10s、下限 250ms (index.js:1882)、`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (index.js:2069)、`SESSION_TASK_DIR` (index.js:2075)、`ORPHAN_TAKEOVER_MS` 默认 5 分钟 (index.js:4637)、`MAX_JOBS_KEPT=30` (index.js:1572)、`REPOS_FILE` (index.js:1572)、`JOB_TERMINAL={done,failed,cancelled}` (index.js:1572)、`BATCH_TOKEN_BUDGET=110000` (index.js:3888)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:3888)、`commitHintCache` 60s TTL (index.js:3888)。

### `package.json` (package.json:1-28)

包身份与宿主识别标志。

| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| package.json:2-3 | `name`/`version` | `@local/dsh-codewiki` / `0.14.0` | 与 CHANGELOG 同步；id 必须等于 client.js:11 的加载 id 与 cordis.patch.yml:20 |
| package.json:6-7 | `type`/`main` | `module` / `index.js` | 服务端半侧入口 |
| package.json:8-11 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | 两个半侧显式导出 |
| package.json:13-16 | `engines` | `node >=20`、`dsh >=0.2.0-rc.0` | 兼容性判定（0.2.1-rc.1 起第三方插件按 engines.dsh 判定） |
| package.json:17-19 | `dependencies` | `@deepseek-ai/schemastery ^3.18.4` | 唯一依赖，仅 `Config` 用（index.js:70 import） |
| package.json:22-24 | `dsh.client.platform` | `"web"` | 驱动宿主扫描器把 client.js 送进浏览器 |
| package.json:25-27 | `dsh.bundle.patch` | `"cordis.patch.yml"` | bundle 安装找补丁 |

### `README.md` (README.md:1-155)

面向使用者的文档：工具表 (README.md:15-21) 列 `cw` (9)/`codewiki_generate` (10)/`codewiki_update` (11)/`codewiki_progress` (12)/设置页 (13)；`codewiki_generate` 关键行为 (README.md:19-26)；设置节 (README.md:98-119) 逐项解释 `batchProvider`/`batchModel` (README.md:97，0.10.1 起唯一通道)、`batchReasoningEffort` (98)、大档四项 (99)、`sessionTier` (100)、`binaryPath`/`maxConcurrency`/`serialProjects`/`articleLanguage`/`updateReminder` (102-106)、`autoCommit` (112，含完整安全边界与三态判定描述)、volatile 说明 (113)；安装 (README.md:111-126) 用 file:/// 直挂（步骤含 patch 片段 122-127、schemastery junction 129）；开发节 (README.md:106-114) 指向 vendor/codewiki、bin/cw.exe、client.js 与验证命令 (140)。注意 README 的 `autoCommit` 条目 (README.md:112) 描述的是「编译终态后直接 git add+commit」，尚未跟上 0.10.11 的独立 commit 阶段与分支合并式语义（对照 index.js:81/2033-2036/2994-3026）。

### `test-batch.mjs` (test-batch.mjs:1-642)

纯函数自检（`node test-batch.mjs`）。从 index.js 导入 (test-batch.mjs:174-180)：`collectSources`、`classifySessionTask`、`estimateTokens`、`fixAnchors`、`numberLines`、`buildSessionSteerText`、`prepareArticleTasks`、`runRealtimeTasks`、`localPlan`、`packArticles`、`scanRepoFiles`、`listModelCatalog`、`resolveModelEfforts`、`installWebServer`。假 llm 用 `makeLlm(reply)` (test-batch.mjs:521-536) 按 stream 协议吐块。覆盖：estimateTokens 计费 (25-29)、collectSources 装填/oversized (32-45)、numberLines 尾换行 (48-52)、prepareArticleTasks 普通/大档单请求/超大会话通道 (54-86)、多文件观察批分割 (87-106)、大档模型接管与关闭回退 (108-132)、`classifySessionTask` 三态 (134-150)、`buildSessionSteerText` 档位钉死 (152-168)、runRealtimeTasks 通道/混合档分派/tps/abort (170-322)、失败记账 (323-345)、localPlan 分组 (347-358)、packArticles 截断 (360-371)、scanRepoFiles 黑名单 (373-387)、llm 通道失败错误码透传 (393-408)、listModelCatalog (410-432)、`/api/codewiki/models` 端点回环 403 (434-462)、resolveModelEfforts 与 model-efforts 端点 (464-516)、0.10.1 反向断言不再导出 `resolveBatchApiKey` (518-521)、fixAnchors 符号修正 13 项 (523-603)。

### `test-orchestration.mjs` (test-orchestration.mjs:1-1358)

服务化编排冒烟（`node test-orchestration.mjs`）。导入 `{name, apply}` (test-orchestration.mjs:45)；设 `DSH_CODEWIKI_TICK_MS='300'` (15) 与独立 `DSH_CODEWIKI_JOBS_FILE`——0.10.10 起文件名追加随机 token (test-orchestration.mjs:51-55)，避免 pid 复用时历史残留的同名文件被原样读入，让「单项目串行」误判为已有项目在编译、表现为「偶发 20 项失败」(CHANGELOG.md:441)。测试配置基线 `batchCfg()` (test-orchestration.mjs:94) 固定 `workbuddy`/`hy3`。辅助：`makeCtx` (44-84，模拟 cordis inject 切片语义)、`makeMockAgent` (87-101)、`makeFixtureRepo` (103-120，**自带 git identity** user.name/email 113-116——0.10.9 起 `autoCommitWiki` 缺身份会拒绝提交)、`llmProxy` (126-133，转发 `activeLlm`)、`makeBatchMock` (138-202，假 llm 按 prompt 首行特征应答，支持 stall/bigArticle)、`waitJob` (205-218)、`fakeReq`/`fakeRes` (220-232)。

覆盖块：系统提示提醒 (234-263)、注册 (265-277)、cw 工具 (279-283)、codewiki_update+commitHintText (285-403，0.10.10 新增 committed/noChanges 静默断言 376-385 与 pending 带原因断言 386-400)、autoCommitWiki 安全边界 (405-506，0.10.11 重写：正常提交断言 `mode==='branch'`、主题分支名前缀与合并后已删除 417-420、提交信息带 docs(wiki) 前缀与任务 id 421、只提交两个目标路径 422-423、源码改动留在工作区 424-425、无改动 noChanges 427-428、非 git/被 ignore/合并中/缺身份各拒绝分支 431-479、**detached HEAD 降级直接提交** 481-489、**主题分支名被占用降级且预占分支不被误删** 491-505；add/add 冲突路径为防御性代码、黑盒单测构造不出来，492-494 注释说明)、autoCommitState 三态 (508-518，含 committed 优先于 noChanges 517)、wakeCompileSession 唤醒与零打扰 (520-556：autoCommit 成功 → done 完全不唤醒 529-530、noChanges 同样零唤醒 533-534、pending 带原因唤醒 536-542)、本地规划 (558-615)、全量编译阶段机 (617-658，0.10.11 端到端断言 stageTimings 含独立 commit 阶段 (632) 与 `mode==='branch'` (633)、自动提交只含 wiki 产物 634-644、不唤醒会话 645)、横切拆分 (660-688)、文章观察→合成分割 (690-724)、单项目串行排队 (726-773)、唯一通道 (775-807)、stale 逐篇更新 (809-830)、codewiki_progress (832-868)、宿主重启重跑与旧 plan 任务迁移 (869-926)、并发占位合并 (928-976，0.10.10 起 stall mock 防竞态 943-947)、面板端点与取消 (978-1030)、排除清单 (1032-1085)、knownRepos (1087-1125)、工作区过滤 (1127-1188)、registry 异常降级 (1190-1218)、schema 校验 (1220-1258)、孤儿接管 (1260-1292)、模型缺失诚实报错 (1294-1307)、严格 cordis 语义 (1309-1331)、Temp 清理 (1333-1350)。

## Architecture

```text
┌───────────────────── 配置的四层表示 ─────────────────────┐
│ package.json:20-27 (dsh.*) ──► cordis.patch.yml:19-24     │
│  （id=codewiki 三处一致: :20 / client.js:17-18）           │
│        ▼                                                   │
│ index.js:51 Config（19 字段，全部 .volatile()）             │
│   ├─► index.js:77 liveConfig()（execute/tick 每次热解包）   │
│   │     ▼ 消费端: resolveBinary(108)/submit(2148)/          │
│   │              tickIndex(2010)/tickCommit(2042)           │
│   └─► client.js:425 configForms.get('codewiki')             │
│           │ getSnapshot / mutate(ops, revision)             │
│           ▼ CodewikiCard (client.js:460) 设置表单            │
└────────────────────────────────────────────────────────────┘
 client.js:19-25 ──HTTP(仅回环)──► index.js:2774 端点:
   /jobs /repos /models /model-efforts /control
 autoCommit 是唯一拥有专属阶段机的配置项:
   tickIndex(2033) ─setStage('commit')─► tickCommit(2042)
     ─► autoCommitWiki(2948) 主题分支→合并回原分支
```

## Data Flow

1. **配置流**：`cordis.patch.yml:19-24` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)` (index.js:4817) → 每次执行前 `liveConfig(config)` (index.js:102-127) 解包 volatile 值 → 落到 `resolveBinary` (index.js:150)、`installWebServer` (index.js:4327)、各阶段 tick (`tickArticles` index.js:2879 / `tickCrosscut` index.js:3098 / `tickReview` index.js:3233 / `tickIndex` index.js:3346 / `tickCommit` index.js:3465) 与 `submit` (index.js:3579) 等消费点。每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` (client.js:550) 挂载 → 拉 `/api/codewiki/models` 得 provider 目录 (client.js:607-618) → 用户编辑 `draft` → `dirty` 深比较 (client.js:766-769) → `save()` (client.js:515-537) 生成单层 `{op:'set'}` 数组（白名单 19 键 client.js:797）→ `form.mutate(ops, revision)` (client.js:797) CAS 写入 → 宿主持久化 + 热生效 → 订阅回调收到新 `revision` 回填草稿 (client.js:486-503)。
3. **模型目录与档位发现流**：`GET /api/codewiki/models` (index.js:4265-4280) → `listModelCatalog(llmRef)` (index.js:4303-4324) → 返回 `{ok, providers:[{id,name,models:[{id,name}],error?}]}`；`GET /api/codewiki/model-efforts?provider=&model=` (index.js:4292-4312) → `resolveModelEfforts` (index.js:3543-3565) → `resolveModelInfoOf` (index.js:3557-3562，优先宿主 `resolveModelInfo`、回落 `resolveModel`) → 返回 `{ok,provider,model,efforts:[{id,name,description}],defaultEffort,context}`。设置页 `useEfforts` (client.js:620-651) 消费。
4. **文档补建流**：编译收尾 `tickIndex` (index.js:3346-3376) → `ensureWikiEntry(job.cwd, language)` (index.js:301-334，调用点 2022-2026) → 仓库根缺 `CodeWiki.md` 则按语言写双语模板，已有入口绝不覆盖。
5. **提醒与自动提交流**：`installUpdateReminder` (index.js:4783) 在 agent 创建时注册系统提示 section `codewiki:update-reminder` (index.js:4772)；text 回调每次组装时求值 (index.js:4739-4745)——`updateReminder === false`、仓库根无 `CodeWiki.md` 返回空串，否则拼 `reminderText(cwd)` (index.js:2271-2280) 与 `commitHintText(cwd)` (index.js:3346-3377：经 `autoCommitState` 判定仅 `pending` 才比较最近编译 `finishedAt` 与 `git log` 时间戳 index.js:2386-2392，60s TTL 缓存 index.js:3465/3035/3061)。0.10.11 起 `tickIndex` 在有产物且开关开启时 `setStage('commit')` 提前返回 (index.js:4655-4658)，`tickCommit` (index.js:2278-2294) 于下一 tick 调用 `autoCommitWiki` (index.js:1877-1959) 走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」——提交成功或 `noChanges` 则 `wakeCompileSession` (index.js:1757-1772，静默 return 在 1225) 完全不打扰会话；提交失败不改变任务终态（`tickCommit` 恒置 done，index.js:985），只记录 `reason` 供「产物待提交」提醒与面板展示；终态 done 因此最多晚一个 tick（默认 `TICK_MS` 10s，index.js:1374）。
6. **编排任务流**：工具 `codewiki_generate.execute` (index.js:3579-3683) 先 `runCw status` 判态 → `svc.submit` (index.js:3491-3556) 建 job → `tick()` (index.js:3482-3559) 按 `STAGE_HANDLER` (index.js:1165-1172) 调阶段函数 → `prepareArticleTasks` (index.js:2755-2840) 拆普通/大档/会话通道任务 → `submitBatchFor` (index.js:2629-2657)/`startBatchChatRun` (index.js:591-631)/`runRealtimeTasks` (index.js:467-496)/`llmChat` (index.js:2460-2479，唯一模型通道) → `settleJob` (index.js:2522-2543) 收割、`writeValidated` (index.js:1949-1965) 校验落盘；index 之后进 commit 阶段 (index.js:1949-1965)。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki` (MIT)，提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其本地 fork (CodeWiki.md:65)。
- [[plugin-orchestration]] — `createJobService` (index.js:2295-3317) 驱动的阶段机 queued→articles→crosscut→compose→review→index→commit（0.10.7 起无 plan、0.10.11 起加 commit；CodeWiki.md:20 的描述尚未含 commit 节），本文的配置项（并发、模型三档、语言、排除清单、自动更新、autoCommit）全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方（`CodewikiPanel` client.js:1426 / `ReposTab` client.js:1184）。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制 (CodeWiki.md:66)。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh（配置值本身热读）。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，package.json:22-24 的 `dsh.client.platform` 声明新增后也需重启才会把 client.js 送进浏览器 (CodeWiki.md:70)。
2. **Junction 依赖**：`@deepseek-ai/schemastery` (package.json:17-19，仅供 `Config` 用) 靠插件本地 junction 解析；换机器需重建 (CodeWiki.md:71)。
3. **文档清单与语义有滞后**：`cordis.patch.yml:22-33` 注释只列部分设置项，`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 未列入；`README.md:112` 的 autoCommit 条目与 `CodeWiki.md` 的 autoCommitWiki 条目/`createJobService` 描述/架构图 (CodeWiki.md:15、20、42、50-54) 仍停在 0.10.10 及更早的「index 收尾直接提交」口径，未反映 0.10.11 的独立 commit 阶段与分支合并式，且 CodeWiki.md:20 的 `WIKI_PATHS` 锚点写 index.js:35（实际 index.js:35）；client.js:60 的头注释仍标 `v0.4.1` 而词典内容已是 0.10.11。完整字段以 `Config` (index.js:60-80) 与 client.js:680 白名单为准；旧版文档若残留 `defaultProvider`/`batchApiKey` 等已删字段一律作废（0.10.1 删内置直连，CHANGELOG.md:749-761）。
4. **新增 Config 字段要改四处**：index.js:51（schema）、index.js:77（liveConfig 解包）、client.js:680（保存字段白名单）、`README.md`（人工文档）。漏掉 client.js:680 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback `<cwd>/.codewiki` (`wikiPathFor` index.js:1854-1859)。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠，插件消费侧由 `normalizeArticlePath` (index.js:213) / `normalizeIndexLinks` (index.js:209-217) 归一为 `/`（0.5.0.2 起 Rust 层根治，插件层保留为纵深防御，CodeWiki.md:73）。
7. **会话通道依赖发起会话**：`job.sessionId` 为空（面板提交/自动调度）时，超预算文章与校对任务直接整体失败并明示原因 (`dispatchSessionTasks` index.js:2797-2831，fail 在 1540-1543)，不退大档兜底、不静默跳过校对；超时默认 30 分钟 (`SESSION_TASK_TIMEOUT_MS` index.js:1881，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调)。只有单文件连大档预算都装不下（或 bigProvider 留空）才转会话通道 (`prepareArticleTasks` index.js:1165-1250、CodeWiki.md:75)。
8. **维护提醒依赖 `CodeWiki.md` 与 git**：提醒注入的门控在 section text 回调 (index.js:4739-4745)——仓库根无 `CodeWiki.md` 返回空串，入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒 (index.js:3990 catch)。
9. **严格 cordis 语义**：`apply` (index.js:4817-4818) 用 `ctx.inject` 获取 `agents`/`llm` 服务，禁止直接访问 `ctx.xxx`（否则抛 without inject）；工具注册单工具失败仅丢该工具不回滚全部 (index.js:4809-4821)。
10. **任务拆分边界**：普通单请求预算 `BATCH_TOKEN_BUDGET=110000` (index.js:581)，装填上限=大档预算或 `BATCH_TOKEN_HARD_LIMIT=128000` (index.js:586)；110k–420k 区间大档单请求一次写完，模块总量超 `bigTokenBudget` (index.js:69) 才拆观察批 `#obs`，单文件连大档都装不下才转会话通道。0.10.3 修掉 `batches.length===1` 误判转会话的缺陷 (CHANGELOG.md:407-416)。
11. **Web 安全**：`isLoopbackRequest` (index.js:4229-4232) 仅放行 127.0.0.1/::1；请求体超 1MB 拒绝 (`readBodyJson` index.js:4240-4258)。工作区过滤只过滤终态任务、非终态任务始终可见 (index.js:3491-3492)。
12. **大档空 provider**：`modelTrio` 的 `allowEmptyProvider:true` 时首项「（未启用大档）」(client.js:111)，未选 provider 时 effort 区显 `bigDisabled` 提示 (client.js:660)。目录/档位拉取失败退化为文本输入，不阻断保存 (client.js:111-116、603-605)。
13. **二进制解析**：`resolveBinary` (index.js:150-170) PATH `where`/`which` 优先，失败回退捆绑 `bin/cw(.exe)`，再不行返回 `'cw'` 让 spawn 报错；`runCw` (index.js:172-197) 超时 `SIGKILL`，`signal` abort 杀进程。
14. **autoCommit 拒绝分支、三态与分支合并式（0.10.11）**：`autoCommitWiki` (index.js:4655-4737) 在非 git 仓库 (2959)、无 HEAD (2960)、merge/rebase/cherry-pick 进行中 (2962-2964)、目标路径未解决冲突 (2965)、`.codewiki/`（或未 tracked 的 `CodeWiki.md`）被 `.gitignore` 忽略 (2969-2972)、缺 `user.name`/`user.email` (2974-2976) 时一律拒绝并降级为「产物待提交」提醒——绝不半个提交；只 add `.codewiki` 与 `CodeWiki.md` 两个路径（pathspec 形式 `git add -- …`，**不是 `-A`**，index.js:55-56、`WIKI_PATHS` index.js:2271）、不跑仓库钩子 (`--no-verify`，index.js:3906)；`git add`/`git commit` 自身失败（含 `index.lock` 并发占用）把 stderr 摘录写进 `reason` (index.js:985/2989)。分支流程：detached HEAD (index.js:962-965) 或建主题分支失败 (3000-3003) 降级 `mode:'direct'` 并带 `fallback` 原因；进入主题分支后任何失败先切回原分支 (try/finally index.js:962-966)，绝不把用户留在插件建出的分支上；合并冲突/失败 → `git merge --abort` (index.js:1750)、保留主题分支等手动合并 (3019-3022)，绝不强合；成功后 `git branch -d` 删主题分支（`-d` 只删已合并分支，绝不强删，index.js:1750-1751）。三态判定唯一来源是 `autoCommitState` (index.js:1746-1751)：`committed` 优先于 `noChanges`，旧 job（无 autoCommit 字段）按 `pending` 与升级前行为一致——唤醒 (index.js:1710) 与系统提示 (index.js:7) 两条通道共用，否则同一次「无改动」会被打扰两次 (CHANGELOG.md:305)。`codewiki_progress` 的 autoCommit 输出带 `mode`/`branch`/`fallback` (index.js:962-964)，render 三态各一句 (index.js:962-968)。
15. **非显然语义**：`queued` 置于 `ACTIVE_STAGES` 首位点亮第 0 点表示串行排队 (client.js:33-34)；0.10.11 起 `commit` 也在 `ACTIVE_STAGES`，阶段徽章「提交产物中」/「Committing」词条齐备 (client.js:1129/237)、`STAGE_WEIGHTS` 为 articles 0.63 / commit 0.02 (client.js:33)，但步骤条短标签用的 `step*` 词条族（zh client.js:1096/147-151、en 238/289-293）没有 `stepCommit`，第 7 个点的短标签只能靠 t() 的缺键回退；`codewiki_progress` 描述里的 stage 枚举 (index.js:1877) 未列 `queued`/`commit`；终态 done 因独立 commit 阶段最多晚一个 tick (index.js:4655-4657 + `TICK_MS` index.js:4655)；旧任务残留的 `plan` 计时键被 `lastTimedStage` 过滤 (client.js:1098-1101)；插件不保存/传递任何密钥，凭证全由宿主 `llm.stream()` 从模型设置解析（submit 校验 index.js:454-464）；.gitignore:5-6 的 `bin/*.bak-*` 是丢失源码时代的安全网，不忽略 `bin/cw.exe` 本身；测试 fixture 必须自带 git identity (test-orchestration.mjs:197-200)，jobs 测试文件名带随机 token 防 pid 复用污染 (test-orchestration.mjs:19-23)；面板上自动提交失败原因放任务行 `title` 而非 meta，防一行被撑爆 (client.js:36-49)；中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等 (index.js:3906-3908、CHANGELOG.md:291)。
