---

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

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json` (package.json:1-28)、`cordis.patch.yml` (cordis.patch.yml:1-16)、`index.js` 中的 `Config` schema (index.js:51-71) 与 `liveConfig` (index.js:77-102)、`client.js` 的设置表单与侧边栏面板 (client.js:1-1375)、`README.md` (README.md:1-67)、`CodeWiki.md` (CodeWiki.md:1-75)、`CHANGELOG.md` (CHANGELOG.md:1-673)、`.gitignore` (.gitignore:1-12) 与两个自检脚本 `test-batch.mjs` (test-batch.mjs:1-501) / `test-orchestration.mjs` (test-orchestration.mjs:1-1358) 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema (`Config`，index.js:51)、运行时快照 (`liveConfig`，index.js:77)、浏览器草稿 (`snapshot`/`draft`，client.js:463-464)、人工文档 (`README.md` 与 `CodeWiki.md`)。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包 (index.js:77-102)、client.js:680 的保存键白名单、以及 README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面 (v0.10.11，package.json:3) 的字段全集共 19 项 (index.js:52-70)，全部 `.volatile()`——每次 `execute`/`tick` 经 `liveConfig` (index.js:77) 重新解包，改完立即生效，不需要重启 dsh。编译模型三档齐备：普通档 (`batchProvider`/`batchModel`/`batchReasoningEffort`，index.js:54-56)、大档 (`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`，index.js:57-60，0.10.4 引入、0.10.8 全面启用)、会话通道兜底档位 `sessionTier` (index.js:61)。0.10.1 起删除内置百炼直连 (CHANGELOG.md:147-159)，`batchProvider` 留空提交即失败 (index.js:2184)，插件不保存任何密钥。0.10.9 新增 `autoCommit` (index.js:66)：编译产物由插件自己提交，会话模型不再等待编译或代跑 git (CHANGELOG.md:33-47)；0.10.10 补齐三态语义——`autoCommitState` (index.js:1214-1219) 是唤醒与系统提示两条通道共用的唯一判定 (CHANGELOG.md:22)，`git add` 改用 pathspec 形式而非 `-A`（路径唯一来源 `WIKI_PATHS` index.js:36，CHANGELOG.md:23）。0.10.11 把提交升级为阶段机里的**独立 commit 阶段**并改走**分支合并式**——`tickIndex` 有产物且开关开启时 `setStage('commit')` 提前返回 (index.js:2033-2036)，`tickCommit` (index.js:2042-2058) 调 `autoCommitWiki` (index.js:2948-3030) 先在主题分支 `codewiki/wiki-<jobId>` 上提交、再合并回原分支并删除主题分支 (CHANGELOG.md:9)，产物提交不再长在用户当前分支的收尾里，终态 done 最多晚一个 tick (CHANGELOG.md:8)。模型目录发现由 `listModelCatalog` (index.js:2624-2645) 与端点 `GET /api/codewiki/models` (index.js:2842-2857)、档位端点 `GET /api/codewiki/model-efforts` (index.js:2861-2881，客户端常量 client.js:25) 支持，设置页的模型选择是 provider/model/effort 三级联动 (`modelTrio`，client.js:570-669)。

## Key Components

### `.gitignore` (.gitignore:1-12)

运行期产物与构建产物的边界，纯声明文件：

- .gitignore:1-3 忽略 `node_modules/`、`vendor/codewiki/target/`、`*.log`
- .gitignore:5-6 `bin/*.bak-*` 二进制备份安全网（丢失源码时代的最后产物；**不**忽略 `bin/cw.exe` 本身）
- .gitignore:8-9 `.orch-test-out.txt`、`.probe3.txt` 探测残留
- .gitignore:11-12 `.dsh-ops/` DSH 运行期产物（面板会话流、工具调用记录），不入库
- 注意 `.codewiki/` 不在忽略列表——wiki 必须随仓库提交；若被项目级 ignore 忽略，`autoCommitWiki` (index.js:2948-3030) 会拒绝自动提交而不是静默丢产物 (index.js:2969-2972)。

### `CHANGELOG.md` (CHANGELOG.md:1-673)

插件从 0.1.0 (CHANGELOG.md:659) 到 0.10.11 (CHANGELOG.md:3) 的完整变更日志，记录修复、功能、测试与配置演变，是本模块行为演变的事实来源。近期关键版本：

- 0.10.11 (CHANGELOG.md:3-15)：编译收尾新增独立 commit 阶段——`STAGE_HANDLER` 加 `commit: tickCommit` (index.js:2066)，阶段顺序变为 queued → articles → crosscut → compose → review → index → commit → done，终态最多晚一个 tick，中途死在 commit 阶段的任务重启后重跑本阶段、对已入库产物报 noChanges 幂等 (CHANGELOG.md:8)；`autoCommitWiki` 重写为「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → `git branch -d` 删主题分支」(CHANGELOG.md:9，实现 index.js:2994-3026)；detached HEAD/建分支失败降级直接提交、合并失败中止并保留主题分支、全部前置安全检查在分支切换之前执行 (CHANGELOG.md:10，实现 index.js:2995-3010/3016-3023)；面板 `ACTIVE_STAGES` 加 `commit`、进度权重 articles 0.63/commit 0.02 (CHANGELOG.md:11，实现 client.js:28/947)；`codewiki_progress` 的 autoCommit 输出加 `mode`/`branch`/`fallback` (CHANGELOG.md:12，实现 index.js:2527-2529)。
- 0.10.10 (CHANGELOG.md:17-31)：两轴 code-review 修复——① `autoCommitState` (index.js:1214-1219) 成为自动提交三态（`committed`/`no-changes`/`pending`）的唯一判定，唤醒与系统提示两条通道共用，`no-changes` 一律静默 (CHANGELOG.md:22)；② `git add -A -- .codewiki CodeWiki.md` 改为 `git add -- .codewiki CodeWiki.md`（pathspec 形式，CHANGELOG.md:23）；③ 自动提交失败原因（含 `index.lock` 被并发占用等 git stderr 摘录）写进 `reason` (CHANGELOG.md:24，实现 index.js:2982/2989)；④ 面板任务卡显示三态（成功短 sha/「产物无改动，未提交」/「产物未自动提交（原因）」）(CHANGELOG.md:25，实现 client.js:1256-1264)；⑤⑥ 两处测试竞态修复——jobs 测试文件名追加随机 token (CHANGELOG.md:27，实现 test-orchestration.mjs:19-23)、并发提交块改 `stall` mock (CHANGELOG.md:26，实现 test-orchestration.mjs:943-947)。
- 0.10.9 (CHANGELOG.md:33-47)：`autoCommitWiki` (index.js:2948) 把「等编译完成 → 会话模型代跑 git」收回插件侧 (CHANGELOG.md:38)；`wakeCompileSession` (index.js:1221) 在自动提交成功时完全不打扰会话 (CHANGELOG.md:40，静默 return index.js:1225)；安全边界逐条列出 (CHANGELOG.md:39)；设置项 `autoCommit` 默认 true (CHANGELOG.md:42、index.js:66)。
- 0.10.8 (CHANGELOG.md:49-61)：编译流水线适配 hy3 192k——放弃 32k 时代拆批策略，`prepareArticleTasks` (index.js:560-645) 改大档单请求优先 (CHANGELOG.md:54)；审校改**批量校对** `batchProofreadBatchPrompt` (index.js:859-886)/`settleProofread` (index.js:1426-1450) (CHANGELOG.md:56)；面板 `lastTimedStage` 过滤 `ACTIVE_STAGES` (CHANGELOG.md:57，实现 client.js:919-922)。
- 0.10.7 (CHANGELOG.md:63-72)：删除规划阶段——`tickPlan`/`batchPlannerPrompt`/`parsePlan` 三段全删，模块清单由 `localPlan` (index.js:685-698) 按顶层目录本地分组 (CHANGELOG.md:68)。
- 0.10.6 (CHANGELOG.md:74-82)：非终态任务的工作区过滤放行——jobs/repos 端点不再藏掉占串行闸门的非终态编译中任务 (index.js:2737-2738，CHANGELOG.md:80)。
- 0.10.5 (CHANGELOG.md:84-94)：`codewiki_progress` 输出 schema 的 `progress` 补 null 分支 (index.js:2508，CHANGELOG.md:90)。
- 0.10.4 (CHANGELOG.md:96-122)：`resolveModelInfoOf(llm)` 修正宿主方法名（`LlmService` 暴露的是 `resolveModelInfo`，`resolveModel` 只在 adapter 注册表接口）(index.js:2651-2656，CHANGELOG.md:102)；新增大档四项配置 (CHANGELOG.md:105-112，index.js:57-60)。
- 0.10.3 (CHANGELOG.md:124-133)：修掉「单文件 110k–128k 分不出多批被误判装不下而白送会话通道」的缺陷。
- 0.10.1 (CHANGELOG.md:147-159)：删除 `bailianChat` 内置直连与 `resolveBatchApiKey` 凭证解析链 (CHANGELOG.md:152-153)，`llmChat` (index.js:288-307) 成为唯一模型通道，`submit` 硬校验 provider/model/llm 三项 (index.js:2182-2191，CHANGELOG.md:154)。

重要常量与默认值：`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:26)、`DEFAULT_BATCH_MODEL='hy3'` (index.js:27)、`BATCH_TOKEN_BUDGET=110000` (index.js:374)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:379)、大档默认 `volces-ark`/`glm-5.3-flash`/`420000` (index.js:30-33)、`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (index.js:1020)、`serialProjects` 默认 true (index.js:63)、`maxConcurrency` 默认 2 (index.js:24) / 硬顶 `CONCURRENCY_HARD_CAP=8` (index.js:22)。

### `CodeWiki.md` (CodeWiki.md:1-75)

插件自身的项目 wiki 入口（CodeWiki.md 公约），结构：Overview (CodeWiki.md:5-7)、Key Components (CodeWiki.md:9-31)、Architecture (CodeWiki.md:33-57)、Data Flow (CodeWiki.md:59-61)、Connections (CodeWiki.md:63-66)、Known Issues (CodeWiki.md:68-75)。

- Key Components 逐条列出 `Config` (CodeWiki.md:12)、`buildSessionSteerText` (CodeWiki.md:13)、`installUpdateReminder` (CodeWiki.md:14)、`autoCommitWiki` (CodeWiki.md:15，逐条安全边界)、`autoCommitState` (CodeWiki.md:16，0.10.10)、`wakeCompileSession` (CodeWiki.md:17)、`runCw`/`parseStatus` (CodeWiki.md:18)、模型执行模块 (CodeWiki.md:19)、`createJobService` (CodeWiki.md:20)、工具定义 (CodeWiki.md:21-22)、webServer 端点 (CodeWiki.md:23)、`apply` (CodeWiki.md:24)、`client.js` 组件 (CodeWiki.md:26-29)、挂载文件 (CodeWiki.md:30-31)。
- Architecture 图 (CodeWiki.md:35-57) 描绘 queued→articles→crosscut→compose→review→index 阶段机与 autoCommitWiki 收尾（0.10.7 后无 plan；compose 仅在输入超 420k 大档预算的拆分时出现；两条通道的三态判定共用 `autoCommitState()`，CodeWiki.md:54）。
- Known Issues (CodeWiki.md:70-75) 记录插件注册不热加载、junction 依赖、断点文件语义、会话通道对发起会话的依赖。
- 本文件是编译产物、内容有滞后：当前停留在 0.10.10 口径——`autoCommitWiki` 条目 (CodeWiki.md:15)、`createJobService` 描述 (CodeWiki.md:20) 与 Architecture 图 (CodeWiki.md:42/50-54) 仍是「index 收尾直接提交」的 0.10.9 描述（图中无 commit 节点、未提主题分支合并），且 CodeWiki.md:15 引用的 `WIKI_PATHS` 锚点写 index.js:35（实际 index.js:36），待下次对本仓库重编译时由流水线刷新。

### `client.js` (client.js:1-1375)

浏览器半侧：注册插件页设置卡片 (`plugins.item`) 与侧边栏面板 (`main`+`sidebar.panellist`)，经 `configForms` 读写命名空间 `codewiki`，轮询宿主端点（挂载点说明 client.js:1-8）。

- 挂载常量：`NS='codewiki'` (client.js:17)、`KEY='codewiki'` (client.js:18)、`JOBS_PATH` (client.js:19)、`CONTROL_PATH` (client.js:20)、`PANEL_ORDER=52` (client.js:21)、`POLL_MS=2000` (client.js:22)、`REPOS_PATH` (client.js:23)、`MODELS_PATH` (client.js:24)、`EFFORTS_PATH` (client.js:25)、`REPOS_POLL_MS=10000` (client.js:26)。`ACTIVE_STAGES=['queued','articles','crosscut','compose','review','index','commit']` (client.js:28)——0.10.7 起无 `plan`、0.10.11 起加 `commit`，`queued` 单列最前表示串行排队 (client.js:27 注释)。
- 词典：`zh()` (client.js:30-171) 与 `en()` (client.js:172-313) 返回全量中英文文案；`autoCommit`/`autoCommitHint` (client.js:39-40 zh、client.js:181-182 en，0.10.11 起 hint 描述「主题分支 codewiki/wiki-<任务id> 提交后合并回原分支并删除」的完整语义)；阶段词条含 `stageCommit: '提交产物中'`/`'Committing'` (client.js:95 zh、client.js:237 en)；自动提交三态词条 `autoCommitOk`/`autoCommitNone`/`autoCommitPending` (client.js:112-114 zh、client.js:254-256 en)；大档分区词条 `secBig`/`bigProvider`/`bigProviderOff`/`bigTokenBudget`/`bigDisabled` 等 (client.js:64-75 zh、client.js:206-217 en)；`sessionTier` (client.js:76-77 zh、client.js:218-219 en)。
- 基础工具：`el(tag,props,...children)` (client.js:397-399)、`apiGet(p)` (client.js:401-406)、`apiPost(p,data)` (client.js:407-416)。
- 模块入口：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})` (client.js:10-12)，factory 返回 `{inject:['slots','locale','configForms'], apply(ctx){...}}` (client.js:418-420)。`apply` 内：`tBound` 与词典注册 (client.js:421-422)、`form=ctx.configForms.get(NS)` (client.js:425)、`mount` 注册 `plugins.item`（order 30，client.js:428-440，`whileServed` 门控 436-440）、侧边栏双 slot 注册面板与 `PanelIcon`（main key=KEY 445、panellist id=KEY order=PANEL_ORDER 446-451，client.js:443-454）。
- 设置卡片 `CodewikiCard` (client.js:460-859)：状态 `snapshot`/`draft`/`notice`/`error` (client.js:463-466)、`catalog`/`catalogError` (client.js:469-470)；挂载拉 `MODELS_PATH` (client.js:472-483)；订阅快照按 `revision` 覆盖草稿 (client.js:486-503)；summary 视图 (client.js:506)；`setPath` (client.js:508-515)、`dirty` memo (client.js:517-520)、`selectedProvider` memo (client.js:523-527)；`useEfforts(provider,model)` hook (client.js:532-563) 二次拉档位，普通档与大档各一份实例 (client.js:564-565)；`modelTrio({...})` (client.js:570-669) 渲染 provider/model/effort 三行，换 provider 清空 model 与旧档位 (client.js:587-594)，`allowEmptyProvider` 时首项「（未启用大档）」(client.js:596)，目录缺失退文本输入 (client.js:578-583)、错误提示 (client.js:603-605)，已配置但目录缺失的 provider/model 保留选项 (client.js:598-601)；`save()` (client.js:671-693) 校验 `maxConcurrency` 1–8 整数 (client.js:673-677)，保存键白名单 19 项 (client.js:680)，`form.mutate(ops, revision)` 单层 op + CAS (client.js:687)；`discard()` (client.js:695-699)；loading 态 (client.js:701-703)。表单渲染 (client.js:705-858)：运行节 (client.js:708-781，含 `autoCommit` 开关 client.js:729-737)、编译模型节 (client.js:783-798)、大档节 (client.js:800-815)、调度与排除节 (client.js:817-849)、保存条 (client.js:851-857)。
- 面板辅助：`stageLabel`/`stateLabel`/`kindLabelOf` (client.js:865-867)、`progressBar` (client.js:868-871)、`repoName` (client.js:872-875)、`fmtMs` (client.js:876-882)、`fmtTok` (client.js:883-888)、`fmtDur` (client.js:889-894)、`fmtAgo` (client.js:895-898)、`Spark` (client.js:900-912)、`stepName` (client.js:916)、`lastTimedStage(job)` (client.js:919-922，过滤 `ACTIVE_STAGES` 防旧任务残留 `plan` 键导致失败/取消不标红)、`stageBar` (client.js:923-945，点标签用 `step*` 词条族、悬停 title 用 `stageLabel`)、`STAGE_WEIGHTS={queued:0,articles:0.63,crosscut:0.1,compose:0.05,review:0.15,index:0.05,commit:0.02}` (client.js:947，0.10.11 起 articles 0.65→0.63 腾出 commit 0.02，总和不变)、`overallPct` (client.js:948-956)、`throughputBadge` (client.js:959-979)、`usageLine` (client.js:981-997)。
- `ReposTab` (client.js:1000-1143)：轮询 `REPOS_PATH`（10s，client.js:1009-1025）；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并 POST `control refresh` (client.js:1030-1048)；`compile` POST `{action:'compile',cwd}` (client.js:1050-1058)；调度卡与仓库行渲染 (client.js:1063-1142，仓库行 lastJob 块 1115-1135)。
- `CodewikiPanel` (client.js:1145-1358)：轮询 `JOBS_PATH`（2s）防重入并差分采样 tps/批量速率 (client.js:1147-1198)；`cancel` POST control (client.js:1203-1211)；`copyPath` 剪贴板 (client.js:1212-1218)；按 cwd 分组 (client.js:1225-1231)；焦点任务选择 (client.js:1233-1237)；`jobCard` 渲染 (client.js:1239-1310，自动提交三态显示于 client.js:1256-1264——成功短 sha + 主题分支名进 meta (1258)、「无改动」一句 (1259)、失败原因存入 `acTitle` 进任务行 `title` 防一行 meta 被撑爆 (1261-1262、1265))；三标签页 总览/任务/设置 (client.js:1312-1352)。
- `PanelIcon` (client.js:1360-1371)：内联 SVG 书页图标。

### `cordis.patch.yml` (cordis.patch.yml:1-16)

Bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂 (cordis.patch.yml:2-3)。

- 注释设置项清单 (cordis.patch.yml:4-12)：`binaryPath` (5)、`batchProvider`（必须是模型设置里已注册的 provider，留空=提交失败，6）、`batchModel`（默认 hy3，7）、`batchReasoningEffort` (8)、`maxConcurrency`（1–8 默认 2，9）、`serialProjects`（默认开，10）、`articleLanguage` (11)、`updateReminder` (12)。**注意这份注释是子集**：`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 未列入，完整清单以 `Config` (index.js:51-71) 为准。
- `insert:` 节点 (cordis.patch.yml:13-16)：`id: codewiki` (14)、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (15，空格转 %20)、`config: {}` (16)。id 与 package.json:2 的 `name`、client.js:17-18 的 `NS`/`KEY` 三处必须一致。无代码函数。

### `index.js` 的 `Config` 与 `liveConfig` (index.js:51-102)

`Config` z.object (index.js:51-71) 含 19 字段，全部 `.volatile()`：

| 字段 | 定义行 | 类型/默认 | 语义 |
| --- | --- | --- | --- |
| `enabled` | index.js:52 | boolean / `true` | 停用后两个工具立即报错 |
| `binaryPath` | index.js:53 | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)`（`resolveBinary` index.js:108-128） |
| `batchProvider` | index.js:54 | string / `'workbuddy'` (index.js:26) | 编译模型提供商；**留空将无法提交任务**（0.10.1 起无内置直连） |
| `batchModel` | index.js:55 | string / `'hy3'` (index.js:27) | 编译模型 id，全部模型环节共用 |
| `batchReasoningEffort` | index.js:56 | string / `''` | 思考档位 id；可选值由模型目录实时读取（/api/codewiki/model-efforts） |
| `bigProvider` | index.js:57 | string / `'volces-ark'` (index.js:30) | 大档提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | index.js:58 | string / `'glm-5.3-flash'` (index.js:31) | 大档模型 id（512k 上下文） |
| `bigReasoningEffort` | index.js:59 | string / `''` | 大档思考档位 |
| `bigTokenBudget` | index.js:60 | number / `420000` (index.js:33) | 大档单请求输入预算；模块源码总量超此值才拆观察→合成，单文件超此值转会话通道 |
| `sessionTier` | index.js:61 | string / `''` | 会话通道档位 id（dsh-subagent-auto-router 档位）；留空=自动选路 |
| `maxConcurrency` | index.js:62 | number / `2` (index.js:24) | 编译请求并发上限 1–8，硬顶 `CONCURRENCY_HARD_CAP=8` (index.js:22) |
| `serialProjects` | index.js:63 | boolean / `true` | 单项目串行：其余仓库任务进 queued 排队 |
| `articleLanguage` | index.js:64 | string / `'中文'` | wiki 文章书写语言 |
| `updateReminder` | index.js:65 | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒（仅当仓库根存在 `CodeWiki.md` 入口） |
| `autoCommit` | index.js:66 | boolean / `true` | 0.10.9：编译完成后由插件自己提交产物（0.10.11 起走主题分支→合并回原分支，只 add `.codewiki/` 与 `CodeWiki.md`） |
| `excludePaths` | index.js:67 | string / `''` | 排除清单：换行/分号/逗号分隔绝对路径，命中拒编译（`excludedItem` index.js:252-261，报错带命中排除项 index.js:2150-2154/2297-2298） |
| `autoUpdate` | index.js:68 | boolean / `false` | 定时扫描历史工作区提交增量编译（调度器 index.js:3120-3149） |
| `autoUpdateMin` | index.js:69 | number / `30` | 扫描间隔分钟，最小 5 (liveConfig index.js:98) |
| `workspaceOnly` | index.js:70 | boolean / `true` | 任务页/总览只显示已添加 dsh 工作区任务 |

`liveConfig(config)` (index.js:77-102) 归一化：`bigTokenBudget` 下限被 `BATCH_TOKEN_BUDGET` 110k 兜住 (index.js:89)；`maxConcurrency` clamp 到 1–`CONCURRENCY_HARD_CAP`，非法值回落 `DEFAULT_CONCURRENCY=2` (index.js:91-93)；`articleLanguage` 空值回落 `'中文'` (index.js:95)；`serialProjects`/`autoCommit`/`workspaceOnly` 用 `!== false` 保默认 (index.js:94/99/100)；`autoUpdate` 需 `=== true` (index.js:97)；`batchModel`/`bigModel` 空值回落各自默认 (index.js:84/87)。0.10.1 起无任何密钥字段。

其他相关常量：`PLUGIN_NAME='dsh-codewiki'` (index.js:18)、`CW_SUBCOMMANDS` 子命令白名单 (index.js:20)、`WIKI_PATHS=['.codewiki','CodeWiki.md']` (index.js:36)、`JOBS_FILE` 默认 `os.tmpdir()/dsh-codewiki-jobs.json` (index.js:1015)、`TICK_MS` 默认 10s、下限 250ms (index.js:1016)、`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟 (index.js:1020)、`SESSION_TASK_DIR` (index.js:1021)、`ORPHAN_TAKEOVER_MS` 默认 5 分钟 (index.js:1064)、`MAX_JOBS_KEPT=30` (index.js:1065)、`REPOS_FILE` (index.js:1070)、`JOB_TERMINAL={done,failed,cancelled}` (index.js:1083)、`BATCH_TOKEN_BUDGET=110000` (index.js:374)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:379)、`commitHintCache` 60s TTL (index.js:2930)。

### `package.json` (package.json:1-28)

包身份与宿主识别标志。

| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| package.json:2-3 | `name`/`version` | `@local/dsh-codewiki` / `0.10.11` | 与 CHANGELOG 同步；id 必须等于 client.js:11 的加载 id 与 cordis.patch.yml:14 |
| package.json:6-7 | `type`/`main` | `module` / `index.js` | 服务端半侧入口 |
| package.json:8-11 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | 两个半侧显式导出 |
| package.json:13-16 | `engines` | `node >=20`、`dsh >=0.2.0-rc.0` | 兼容性判定（0.2.1-rc.1 起第三方插件按 engines.dsh 判定） |
| package.json:17-19 | `dependencies` | `@deepseek-ai/schemastery ^3.18.4` | 唯一依赖，仅 `Config` 用（index.js:14 import） |
| package.json:21-23 | `dsh.client.platform` | `"web"` | 驱动宿主扫描器把 client.js 送进浏览器 |
| package.json:24-26 | `dsh.bundle.patch` | `"cordis.patch.yml"` | bundle 安装找补丁 |

### `README.md` (README.md:1-67)

面向使用者的文档：工具表 (README.md:7-13) 列 `cw` (9)/`codewiki_generate` (10)/`codewiki_update` (11)/`codewiki_progress` (12)/设置页 (13)；`codewiki_generate` 关键行为 (README.md:15-22)；设置节 (README.md:24-40) 逐项解释 `batchProvider`/`batchModel` (README.md:29，0.10.1 起唯一通道)、`batchReasoningEffort` (30)、大档四项 (31)、`sessionTier` (32)、`binaryPath`/`maxConcurrency`/`serialProjects`/`articleLanguage`/`updateReminder` (34-38)、`autoCommit` (39，含完整安全边界与三态判定描述)、volatile 说明 (40)；安装 (README.md:42-57) 用 file:/// 直挂（步骤含 patch 片段 49-54、schemastery junction 56）；开发节 (README.md:59-65) 指向 vendor/codewiki、bin/cw.exe、client.js 与验证命令 (67)。注意 README 的 `autoCommit` 条目 (README.md:39) 描述的是「编译终态后直接 git add+commit」，尚未跟上 0.10.11 的独立 commit 阶段与分支合并式语义（对照 index.js:66/2033-2036/2994-3026）。

### `test-batch.mjs` (test-batch.mjs:1-501)

纯函数自检（`node test-batch.mjs`）。从 index.js 导入 (test-batch.mjs:7-12)：`collectSources`、`classifySessionTask`、`estimateTokens`、`fixAnchors`、`numberLines`、`buildSessionSteerText`、`prepareArticleTasks`、`runRealtimeTasks`、`localPlan`、`packArticles`、`scanRepoFiles`、`listModelCatalog`、`resolveModelEfforts`、`installWebServer`。假 llm 用 `makeLlm(reply)` (test-batch.mjs:173-188) 按 stream 协议吐块。覆盖：estimateTokens 计费 (23-28)、collectSources 装填/oversized (30-44)、numberLines 尾换行 (46-51)、prepareArticleTasks 普通/大档单请求/超大会话通道 (53-84)、多文件观察批分割 (86-105)、大档模型接管与关闭回退 (107-131)、`classifySessionTask` 三态 (133-149)、`buildSessionSteerText` 档位钉死 (151-167)、runRealtimeTasks 通道/混合档分派/tps/abort (169-251)、失败记账 (253-275)、localPlan 分组 (277-288)、packArticles 截断 (290-301)、scanRepoFiles 黑名单 (303-317)、llm 通道失败错误码透传 (323-338)、listModelCatalog (340-362)、`/api/codewiki/models` 端点回环 403 (364-392)、resolveModelEfforts 与 model-efforts 端点 (394-446)、0.10.1 反向断言不再导出 `resolveBatchApiKey` (448-451)、fixAnchors 符号修正 13 项 (453-495)。

### `test-orchestration.mjs` (test-orchestration.mjs:1-1358)

服务化编排冒烟（`node test-orchestration.mjs`）。导入 `{name, apply}` (test-orchestration.mjs:24)；设 `DSH_CODEWIKI_TICK_MS='300'` (15) 与独立 `DSH_CODEWIKI_JOBS_FILE`——0.10.10 起文件名追加随机 token (test-orchestration.mjs:19-23)，避免 pid 复用时历史残留的同名文件被原样读入，让「单项目串行」误判为已有项目在编译、表现为「偶发 20 项失败」(CHANGELOG.md:27)。测试配置基线 `batchCfg()` (test-orchestration.mjs:38) 固定 `workbuddy`/`hy3`。辅助：`makeCtx` (44-84，模拟 cordis inject 切片语义)、`makeMockAgent` (87-101)、`makeFixtureRepo` (103-120，**自带 git identity** user.name/email 113-116——0.10.9 起 `autoCommitWiki` 缺身份会拒绝提交)、`llmProxy` (126-133，转发 `activeLlm`)、`makeBatchMock` (138-202，假 llm 按 prompt 首行特征应答，支持 stall/bigArticle)、`waitJob` (205-218)、`fakeReq`/`fakeRes` (220-232)。

覆盖块：系统提示提醒 (234-263)、注册 (265-277)、cw 工具 (279-283)、codewiki_update+commitHintText (285-403，0.10.10 新增 committed/noChanges 静默断言 376-385 与 pending 带原因断言 386-400)、autoCommitWiki 安全边界 (405-506，0.10.11 重写：正常提交断言 `mode==='branch'`、主题分支名前缀与合并后已删除 417-420、提交信息带 docs(wiki) 前缀与任务 id 421、只提交两个目标路径 422-423、源码改动留在工作区 424-425、无改动 noChanges 427-428、非 git/被 ignore/合并中/缺身份各拒绝分支 431-479、**detached HEAD 降级直接提交** 481-489、**主题分支名被占用降级且预占分支不被误删** 491-505；add/add 冲突路径为防御性代码、黑盒单测构造不出来，492-494 注释说明)、autoCommitState 三态 (508-518，含 committed 优先于 noChanges 517)、wakeCompileSession 唤醒与零打扰 (520-556：autoCommit 成功 → done 完全不唤醒 529-530、noChanges 同样零唤醒 533-534、pending 带原因唤醒 536-542)、本地规划 (558-615)、全量编译阶段机 (617-658，0.10.11 端到端断言 stageTimings 含独立 commit 阶段 (632) 与 `mode==='branch'` (633)、自动提交只含 wiki 产物 634-644、不唤醒会话 645)、横切拆分 (660-688)、文章观察→合成分割 (690-724)、单项目串行排队 (726-773)、唯一通道 (775-807)、stale 逐篇更新 (809-830)、codewiki_progress (832-868)、宿主重启重跑与旧 plan 任务迁移 (869-926)、并发占位合并 (928-976，0.10.10 起 stall mock 防竞态 943-947)、面板端点与取消 (978-1030)、排除清单 (1032-1085)、knownRepos (1087-1125)、工作区过滤 (1127-1188)、registry 异常降级 (1190-1218)、schema 校验 (1220-1258)、孤儿接管 (1260-1292)、模型缺失诚实报错 (1294-1307)、严格 cordis 语义 (1309-1331)、Temp 清理 (1333-1350)。

## Architecture

```text
┌───────────────────── 配置的四层表示 ─────────────────────┐
│ package.json:20-27 (dsh.*) ──► cordis.patch.yml:13-16     │
│  （id=codewiki 三处一致: :14 / client.js:17-18）           │
│        ▼                                                   │
│ index.js:51 Config（19 字段，全部 .volatile()）             │
│   ├─► index.js:77 liveConfig()（execute/tick 每次热解包）   │
│   │     ▼ 消费端: resolveBinary(108)/submit(2148)/          │
│   │              tickIndex(2010)/tickCommit(2042)           │
│   └─► client.js:425 configForms.get('codewiki')             │
│           │ getSnapshot / mutate(ops, revision)             │
│           ▼ CodewikiCard (client.js:460) 设置表单            │
└────────────────────────────────────────────────────────────┘
 client.js:19-25 ──HTTP(仅回环)──► index.js:2686 端点:
   /jobs /repos /models /model-efforts /control
 autoCommit 是唯一拥有专属阶段机的配置项:
   tickIndex(2033) ─setStage('commit')─► tickCommit(2042)
     ─► autoCommitWiki(2948) 主题分支→合并回原分支
```

## Data Flow

1. **配置流**：`cordis.patch.yml:13-16` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)` (index.js:3110) → 每次执行前 `liveConfig(config)` (index.js:77-102) 解包 volatile 值 → 落到 `resolveBinary` (index.js:108)、`installWebServer` (index.js:2686)、各阶段 tick (`tickArticles` index.js:1619 / `tickCrosscut` index.js:1764 / `tickReview` index.js:1898 / `tickIndex` index.js:2010 / `tickCommit` index.js:2042) 与 `submit` (index.js:2148) 等消费点。每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` (client.js:460) 挂载 → 拉 `/api/codewiki/models` 得 provider 目录 (client.js:472-483) → 用户编辑 `draft` → `dirty` 深比较 (client.js:517-520) → `save()` (client.js:671-693) 生成单层 `{op:'set'}` 数组（白名单 19 键 client.js:680）→ `form.mutate(ops, revision)` (client.js:687) CAS 写入 → 宿主持久化 + 热生效 → 订阅回调收到新 `revision` 回填草稿 (client.js:486-503)。
3. **模型目录与档位发现流**：`GET /api/codewiki/models` (index.js:2842-2857) → `listModelCatalog(llmRef)` (index.js:2624-2645) → 返回 `{ok, providers:[{id,name,models:[{id,name}],error?}]}`；`GET /api/codewiki/model-efforts?provider=&model=` (index.js:2861-2881) → `resolveModelEfforts` (index.js:2662-2684) → `resolveModelInfoOf` (index.js:2651-2656，优先宿主 `resolveModelInfo`、回落 `resolveModel`) → 返回 `{ok,provider,model,efforts:[{id,name,description}],defaultEffort,context}`。设置页 `useEfforts` (client.js:532-563) 消费。
4. **文档补建流**：编译收尾 `tickIndex` (index.js:2010-2040) → `ensureWikiEntry(job.cwd, language)` (index.js:214-247，调用点 2022-2026) → 仓库根缺 `CodeWiki.md` 则按语言写双语模板，已有入口绝不覆盖。
5. **提醒与自动提交流**：`installUpdateReminder` (index.js:3076-3108) 在 agent 创建时注册系统提示 section `codewiki:update-reminder` (index.js:3086)；text 回调每次组装时求值 (index.js:3088-3094)——`updateReminder === false`、仓库根无 `CodeWiki.md` 返回空串，否则拼 `reminderText(cwd)` (index.js:3065-3074) 与 `commitHintText(cwd)` (index.js:3032-3063：经 `autoCommitState` 判定仅 `pending` 才比较最近编译 `finishedAt` 与 `git log` 时间戳 index.js:3043-3049，60s TTL 缓存 index.js:2930/3035/3061)。0.10.11 起 `tickIndex` 在有产物且开关开启时 `setStage('commit')` 提前返回 (index.js:2033-2036)，`tickCommit` (index.js:2042-2058) 于下一 tick 调用 `autoCommitWiki` (index.js:2948-3030) 走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」——提交成功或 `noChanges` 则 `wakeCompileSession` (index.js:1221-1236，静默 return 在 1225) 完全不打扰会话；提交失败不改变任务终态（`tickCommit` 恒置 done，index.js:2055），只记录 `reason` 供「产物待提交」提醒与面板展示；终态 done 因此最多晚一个 tick（默认 `TICK_MS` 10s，index.js:1016）。
6. **编排任务流**：工具 `codewiki_generate.execute` (index.js:2291-2395) 先 `runCw status` 判态 → `svc.submit` (index.js:2148-2213) 建 job → `tick()` (index.js:2069-2146) 按 `STAGE_HANDLER` (index.js:2060-2067) 调阶段函数 → `prepareArticleTasks` (index.js:560-645) 拆普通/大档/会话通道任务 → `submitBatchFor` (index.js:1501-1529)/`startBatchChatRun` (index.js:1459-1499)/`runRealtimeTasks` (index.js:332-361)/`llmChat` (index.js:288-307，唯一模型通道) → `settleJob` (index.js:1356-1377) 收割、`writeValidated` (index.js:1382-1398) 校验落盘；index 之后进 commit 阶段 (index.js:2042-2058)。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki` (MIT)，提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其本地 fork (CodeWiki.md:65)。
- [[plugin-orchestration]] — `createJobService` (index.js:1238-2240) 驱动的阶段机 queued→articles→crosscut→compose→review→index→commit（0.10.7 起无 plan、0.10.11 起加 commit；CodeWiki.md:20 的描述尚未含 commit 节），本文的配置项（并发、模型三档、语言、排除清单、自动更新、autoCommit）全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方（`CodewikiPanel` client.js:1145 / `ReposTab` client.js:1000）。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制 (CodeWiki.md:66)。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh（配置值本身热读）。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，package.json:21-23 的 `dsh.client.platform` 声明新增后也需重启才会把 client.js 送进浏览器 (CodeWiki.md:70)。
2. **Junction 依赖**：`@deepseek-ai/schemastery` (package.json:17-19，仅供 `Config` 用) 靠插件本地 junction 解析；换机器需重建 (CodeWiki.md:71)。
3. **文档清单与语义有滞后**：`cordis.patch.yml:4-12` 注释只列 8 项设置，`autoCommit`/大档四项/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 未列入；`README.md:39` 的 autoCommit 条目与 `CodeWiki.md` 的 autoCommitWiki 条目/`createJobService` 描述/架构图 (CodeWiki.md:15、20、42、50-54) 仍停在 0.10.10 及更早的「index 收尾直接提交」口径，未反映 0.10.11 的独立 commit 阶段与分支合并式，且 CodeWiki.md:15 的 `WIKI_PATHS` 锚点写 index.js:35（实际 index.js:36）；client.js:1 的头注释仍标 `v0.4.1` 而词典内容已是 0.10.11。完整字段以 `Config` (index.js:51-71) 与 client.js:680 白名单为准；旧版文档若残留 `defaultProvider`/`batchApiKey` 等已删字段一律作废（0.10.1 删内置直连，CHANGELOG.md:147-159）。
4. **新增 Config 字段要改四处**：index.js:51（schema）、index.js:77（liveConfig 解包）、client.js:680（保存字段白名单）、`README.md`（人工文档）。漏掉 client.js:680 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback `<cwd>/.codewiki` (`wikiPathFor` index.js:993-998)。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠，插件消费侧由 `normalizeArticlePath` (index.js:167) / `normalizeIndexLinks` (index.js:171-179) 归一为 `/`（0.5.0.2 起 Rust 层根治，插件层保留为纵深防御，CodeWiki.md:73）。
7. **会话通道依赖发起会话**：`job.sessionId` 为空（面板提交/自动调度）时，超预算文章与校对任务直接整体失败并明示原因 (`dispatchSessionTasks` index.js:1537-1571，fail 在 1540-1543)，不退大档兜底、不静默跳过校对；超时默认 30 分钟 (`SESSION_TASK_TIMEOUT_MS` index.js:1020，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调)。只有单文件连大档预算都装不下（或 bigProvider 留空）才转会话通道 (`prepareArticleTasks` index.js:560-645、CodeWiki.md:75)。
8. **维护提醒依赖 `CodeWiki.md` 与 git**：提醒注入的门控在 section text 回调 (index.js:3088-3094)——仓库根无 `CodeWiki.md` 返回空串，入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒 (index.js:3060 catch)。
9. **严格 cordis 语义**：`apply` (index.js:3111-3112) 用 `ctx.inject` 获取 `agents`/`llm` 服务，禁止直接访问 `ctx.xxx`（否则抛 without inject）；工具注册单工具失败仅丢该工具不回滚全部 (index.js:3153-3165)。
10. **任务拆分边界**：普通单请求预算 `BATCH_TOKEN_BUDGET=110000` (index.js:374)，装填上限=大档预算或 `BATCH_TOKEN_HARD_LIMIT=128000` (index.js:379)；110k–420k 区间大档单请求一次写完，模块总量超 `bigTokenBudget` (index.js:60) 才拆观察批 `#obs`，单文件连大档都装不下才转会话通道。0.10.3 修掉 `batches.length===1` 误判转会话的缺陷 (CHANGELOG.md:124-133)。
11. **Web 安全**：`isLoopbackRequest` (index.js:2588-2591) 仅放行 127.0.0.1/::1；请求体超 1MB 拒绝 (`readBodyJson` index.js:2599-2617)。工作区过滤只过滤终态任务、非终态任务始终可见 (index.js:2737-2738)。
12. **大档空 provider**：`modelTrio` 的 `allowEmptyProvider:true` 时首项「（未启用大档）」(client.js:596)，未选 provider 时 effort 区显 `bigDisabled` 提示 (client.js:633)。目录/档位拉取失败退化为文本输入，不阻断保存 (client.js:578-583、603-605)。
13. **二进制解析**：`resolveBinary` (index.js:108-128) PATH `where`/`which` 优先，失败回退捆绑 `bin/cw(.exe)`，再不行返回 `'cw'` 让 spawn 报错；`runCw` (index.js:130-155) 超时 `SIGKILL`，`signal` abort 杀进程。
14. **autoCommit 拒绝分支、三态与分支合并式（0.10.11）**：`autoCommitWiki` (index.js:2948-3030) 在非 git 仓库 (2959)、无 HEAD (2960)、merge/rebase/cherry-pick 进行中 (2962-2964)、目标路径未解决冲突 (2965)、`.codewiki/`（或未 tracked 的 `CodeWiki.md`）被 `.gitignore` 忽略 (2969-2972)、缺 `user.name`/`user.email` (2974-2976) 时一律拒绝并降级为「产物待提交」提醒——绝不半个提交；只 add `.codewiki` 与 `CodeWiki.md` 两个路径（pathspec 形式 `git add -- …`，**不是 `-A`**，index.js:2981-2982、`WIKI_PATHS` index.js:36）、不跑仓库钩子 (`--no-verify`，index.js:2988)；`git add`/`git commit` 自身失败（含 `index.lock` 并发占用）把 stderr 摘录写进 `reason` (index.js:2982/2989)。分支流程：detached HEAD (index.js:2995-2998) 或建主题分支失败 (3000-3003) 降级 `mode:'direct'` 并带 `fallback` 原因；进入主题分支后任何失败先切回原分支 (try/finally index.js:3006-3010)，绝不把用户留在插件建出的分支上；合并冲突/失败 → `git merge --abort` (index.js:3017)、保留主题分支等手动合并 (3019-3022)，绝不强合；成功后 `git branch -d` 删主题分支（`-d` 只删已合并分支，绝不强删，index.js:3024-3025）。三态判定唯一来源是 `autoCommitState` (index.js:1214-1219)：`committed` 优先于 `noChanges`，旧 job（无 autoCommit 字段）按 `pending` 与升级前行为一致——唤醒 (index.js:1225) 与系统提示 (index.js:3043) 两条通道共用，否则同一次「无改动」会被打扰两次 (CHANGELOG.md:22)。`codewiki_progress` 的 autoCommit 输出带 `mode`/`branch`/`fallback` (index.js:2527-2529)，render 三态各一句 (index.js:2554-2560)。
15. **非显然语义**：`queued` 置于 `ACTIVE_STAGES` 首位点亮第 0 点表示串行排队 (client.js:27-28)；0.10.11 起 `commit` 也在 `ACTIVE_STAGES`，阶段徽章「提交产物中」/「Committing」词条齐备 (client.js:95/237)、`STAGE_WEIGHTS` 为 articles 0.63 / commit 0.02 (client.js:947)，但步骤条短标签用的 `step*` 词条族（zh client.js:99/147-151、en 238/289-293）没有 `stepCommit`，第 7 个点的短标签只能靠 t() 的缺键回退；`codewiki_progress` 描述里的 stage 枚举 (index.js:2484) 未列 `queued`/`commit`；终态 done 因独立 commit 阶段最多晚一个 tick (index.js:2033-2035 + `TICK_MS` index.js:1016)；旧任务残留的 `plan` 计时键被 `lastTimedStage` 过滤 (client.js:919-922)；插件不保存/传递任何密钥，凭证全由宿主 `llm.stream()` 从模型设置解析（submit 校验 index.js:2182-2192）；.gitignore:5-6 的 `bin/*.bak-*` 是丢失源码时代的安全网，不忽略 `bin/cw.exe` 本身；测试 fixture 必须自带 git identity (test-orchestration.mjs:113-116)，jobs 测试文件名带随机 token 防 pid 复用污染 (test-orchestration.mjs:19-23)；面板上自动提交失败原因放任务行 `title` 而非 meta，防一行被撑爆 (client.js:1252-1265)；中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等 (index.js:2043-2045、CHANGELOG.md:8)。