---
title: System Architecture Overview
type: architecture
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/graph-diff.js
  - lib/incremental.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接]
---

## Overview

本文件为 `@local/dsh-codewiki` 插件（版本 0.13.1，声明于 `package.json:25`）的系统总览，专为零上下文的未来 agent 编写。插件把 Rust CLI `cw`（来自 `mraza007/codewiki`）接入 DeepSeek Harness，提供代码 wiki 的编译、更新与进度查询能力。仓库由四个逻辑部分构成：核心实现与配置（`index.js`/`lib/*.js`/`client.js`/`cordis.patch.yml`/`package.json`/`.gitignore`，下称 core-and-config）、文档与元信息（`README.md`/`CodeWiki.md`/`CHANGELOG.md`，下称 docs-and-meta）、测试脚本（`test-*.mjs`，下称 test-scripts）与测试/监听日志（`.tmp-test-*.log`、`watcher2.log`，下称 logs-and-temp）。整体以 cordis 插件机制挂载（`cordis.patch.yml:19-22` 的 `insert` 条目 id 为 `codewiki`），全部模型调用经宿主 `llm` 服务完成（唯一通道 `llmChat`（`index.js:412-437`））；编译由宿主常驻服务以阶段机推进（`createJobService`（`index.js:1693-2947`）），零子代理。

当前版本（0.13.1）的关键形态：

- 吸收 FSoft-AI4Code/CodeWiki 的三层能力（0.13.0，`README.md:5`、`CHANGELOG.md:31`）：AST 符号提取（`lib/symbols.js`，`index.js:16` 导入 `extractRepoGraph`/`resolveImportEdges`）、LLM 语义聚类模块划分（`lib/cluster.js`，`index.js:17` 导入 `clusterComponents`/`toPlanModules`）、agentic 工具循环写作（`lib/agentic.js`/`lib/agentic-host.js`/`lib/articles-agentic.js`，`index.js:23-24` 导入 `runAgenticArticles`/`buildOpeningPrompt`/`TOOL_SCHEMAS`）、符号级增量判定（`lib/graph-diff.js`/`lib/incremental.js`，`index.js:18-22` 导入 `diffGraphs`/`slimGraph`/`filterStaleTasks` 等）。全部用 Node + tree-sitter WASM 实现，不引 Python 运行时；任一环节不可用自动降级（`README.md:37-42` 的四层表格）。三个开关 `planMode`/`agenticArticles`（+`agenticMaxSteps`）/`symbolIncremental` **默认全开**（`index.js:76-79`，`README.md:37`），分别设 `dirs`/`false`/`false` 可回退 0.12.x 行为。
- 规划（plan）阶段已删除（0.10.7，`CHANGELOG.md:39-48`）：提交后直接进 articles，模块清单由 `buildPlan`（`index.js:2064-2087`）生成——`planMode=auto` 走 `semanticPlan`（`index.js:884-965`，AST 符号 + 模型聚类），失败退回 `localPlan`（`index.js:862-875`）顶层目录分组；阶段表 `STAGE_HANDLER`（`index.js:2738-2745`）不含 plan。
- hy3 192k 适配（0.10.8）：普通单请求输入预算 110k（`BATCH_TOKEN_BUDGET`（`index.js:541`））；110k–420k 输入自动升大档单请求（默认 `volces-ark`/`glm-5.3-flash` 512k，常量在 `index.js:541-544`）；模块源码总量超 420k 才拆观察→合成批；仅单文件连大档都装不下才转会话通道兜底。
- 编译产物提交（0.10.11 起）是阶段机里的独立 `commit` 阶段（`STAGE_HANDLER` 的 `commit: tickCommit` 在 `index.js:2744`），走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（`autoCommitWiki`（`index.js:3783-3865`））。
- worktree 闸门（0.12.0）：`detectLinkedWorktree`（`index.js:309-325`）用 `git rev-parse --git-dir`/`--git-common-dir` 判定 linked worktree，三处拦截（`svc.submit` 的闸门在 `index.js:2843-2848`、`codewiki_generate` 的闸门在 `index.js:3007-3017`、`autoScan` 的 `isWorktreeCwd` 跳过在 `index.js:3973`）。
- 空壳目录闸门（0.12.1）：`isDeadCompileTarget`（`index.js:378-386`）统一判定 worktree 与「无可编译源码」的空壳目录，面板任务列表/仓库总览/启动清理三处共用（过滤在 `index.js:3511` 与 `index.js:3558`，启动清理在 `index.js:378-393`）。
- 会话记录与全局 Tab（0.11.0/0.12.0）：`beginSessionRecord`（`index.js:1400-1442`）把每个 LLM 请求的 prompt/输出落盘，`listAllSessionRecords`（`index.js:1346-1366`）跨任务聚合，面板「会话」Tab 可看。
- 并行项目推进（0.11.0）：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelProjects`（1–4）并行推进多仓库（`liveConfig` 的 `parallelLimit` 派生在 `index.js:115-119`，闸门逻辑在 `tick` 的 `index.js:2758-2770`）。
- 双池并发（0.12.2）：`runRealtimeTasks`（`index.js:469-528`）把 `bigTier === true` 的大档任务与默认档任务拆进两个**独立限流的池**（分池在 `index.js:469-487`），分别受 `maxConcurrency`（`index.js:71`）与 `bigConcurrency`（`index.js:72`）约束、`Promise.all` 同时推进（`index.js:526`）；设置页分条配置（`README.md:52-53`）。

## System Overview

系统组件与职责连接的总框图如下：

```text
┌───────────────────────┐    ┌───────────────────────┐
│ docs-and-meta         │    │ logs-and-temp         │
│ (README/CodeWiki/     │◄───│ (.tmp-*.log 等)       │
│  CHANGELOG)           │验证│                       │
└───────────┬───────────┘    └───────────┬───────────┘
            │ 描述/配置约定               │ 测试产出
            ▼                            ▼
┌───────────────────────┐    ┌───────────────────────┐
│ core-and-config       │◄───│ test-scripts          │
│ (index.js/lib/*)      │导入│ (test-*.mjs)          │
└───────────┬───────────┘    └───────────────────────┘
            │ 经 cordis.patch.yml file:/// 挂载
            ▼
┌───────────────────────┐
│ DeepSeek Harness 宿主 │
│ (llm/webServer/agents)│
└───────────────────────┘
```

`core-and-config` 是系统运转中枢：`apply`（`index.js:3945-4009`）注入 `agentsRef`（`index.js:1656`）与 `llmRef`（`index.js:1661`），注册四个工具（`index.js:3945-3961`）与七个 webServer 端点（`installWebServer`（`index.js:3455-3750`））并启动服务（`createJobService`（`index.js:1693-2947`），`start` 调用在 `index.js:3949`）；`docs-and-meta` 为其提供人机接口说明与配置约定；`test-scripts` 直接 `import './index.js'`（`test-batch.mjs:7-12`、`test-orchestration.mjs:24`）验证契约；`logs-and-temp` 收集测试与 watcher 输出以供排查。

## Data Flow

请求与数据在模块间的流动路径如下：

```text
┌──────────┐ codewiki_generate ┌──────────────┐ cw status ┌─────────┐
│ 会话/面板 │──────────────────►│ JobService    │──────────►│ cw CLI  │
│ (agent/  │◄──────────────────│ (createJob-   │◄──────────│ (bin/cw)│
│  client) │ jobId/stage 即回  │  Service)     │ 判态/落盘  └─────────┘
└────┬─────┘                   └──────┬────────┘
     │ GET /api/codewiki/jobs         │ tick 阶段机（…→index→commit）
     ▼                                ▼
┌──────────┐  runRealtimeTasks ┌──────────────┐  llmChat   ┌─────────┐
│client.js │──────────────────►│ 双池并发/收割 │───────────►│ 宿主 llm │
│ (面板)   │◄──────────────────│ (startBatch- │◄───────────│ 服务     │
└──────────┘  2s 轮询渲染       │  ChatRun /   │ 流式结果    └─────────┘
                               │  AgenticRun) │
                               └──────┬────────┘
                                      │ fixAnchors 校正后落盘
                                      ▼
                        ┌────────────────────────┐
                        │ autoCommitWiki: 主题分支 │
                        │ codewiki/wiki-<jobId>   │
                        │ 提交→合并回原分支→删分支  │
                        └────────────────────────┘
```

1. **提交**：会话内调用 `codewiki_generate`（定义于 `generateToolDefinition`（`index.js:2954-3166`））：`normalizeCwd`（`index.js:49-54`，调用在 `index.js:3002`）→ 排除清单校验（`excludedItem`（`index.js:284-293`），调用在 `index.js:3004-3005`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:3009`，报错/静默分支 `index.js:2954-2961`）→ 空壳目录闸门（`clearSourceProbeCache` 在 `index.js:3023`、`hasCompilableSources` 判定在 `index.js:3024-3030`）→ `cw status` 判态（`runCw` 调用在 `index.js:3037`、`parseStatus`（`index.js:213-226`）调用在 `index.js:3042`）→ 预构建任务后经 `svc.submit`（定义在 `index.js:2835-2920`）创建 job 立即返回 `{submitted, jobId, stage}`。submit 内部再过排除清单（`index.js:2837-2840`）、worktree（`index.js:2843-2848`）、空壳（`index.js:2853-2858`）三道闸门，随后 `rememberRepo`（`index.js:1495-1503`）登记、幂等检查（`index.js:2954-2955`）、落 `submitting` 占位（`index.js:2862-2884`）、编译模型校验（`index.js:2954-2963`，provider/model/llm 任一缺失即 fail 留痕）、排队判定后 `persist`+`flush`+立即 `tick`（`index.js:2916-2918`）。`scope=auto` 在 clean 态直接报告（`index.js:2954-2958`）；`stale` 态按文章 frontmatter 的 `source_files` 逐篇预构建直达 articles（`index.js:3072-3135`）；missing 态先 `cw init`（`index.js:2954-2960`）再全量提交（`index.js:3156-3163`）。`codewiki_update`（`updateToolDefinition`（`index.js:3176-3228`））是固定 `scope=auto` 的包装；`codewiki_progress`（`progressToolDefinition`（`index.js:3247-3351`））只读查进度。

2. **项目闸门**：`serialProjects` 默认开（串行=上限 1）；关闭后按 `parallelLimit`（1–4）并行。`svc.submit` 把后到任务预置 `queued`（`pendingStage`/`pendingTasks` 先寄存于 `index.js:2907-2910`，`setStage('queued')` 在 `index.js:2911`），`tick`（`index.js:2747-2833`）每轮先算 `activeIds` 集合（忙碌项优先入集，再按提交顺序唤醒最早 queued 直到上限，`index.js:2758-2770`），轮到时才落地预置字段（`index.js:2796-2806`）；取消不受闸门限制（`index.js:2761-2771`），且每轮 tick 从磁盘跨实例拾取取消标记（`syncCancelFlags`（`index.js:1809-1820`））。

3. **规划与阶段机**：`STAGE_HANDLER`（`index.js:2738-2745`）按 articles（`tickArticles`，`index.js:2213-2391`）→ crosscut（`tickCrosscut`，`index.js:2415-2498`）→（超预算拆分时 compose，`tickCompose`，`index.js:2501-2513`）→ review（`tickReview`，`index.js:2550-2661`）→ index（`tickIndex`，`index.js:2663-2718`）→ commit（`tickCommit`，`index.js:2720-2736`）推进。full 编译无 `job.plan` 时就地 `buildPlan`（调用在 `index.js:2328`）：`planMode=dirs` 直接 `localPlan`（`index.js:2066-2070`）；`planMode=auto`（默认）走 `semanticPlan`——先 `extractRepoGraph` 提取全仓符号图（`index.js:903-913`），再 `clusterComponents` 让模型按职责聚成层级模块树（`index.js:2738-2743`），并把组件图与依赖边随 plan 持久化（`index.js:2738-2749`）；提取/聚类/空结果任一失败都记 note 退回 `localPlan`（`index.js:2079-2086`）。

4. **文章阶段（0.13.0 双通道）**：`agenticArticles` 开启（默认）时任务打 `agentic: true` 标记（`index.js:2014`）并交 `startAgenticRun`（`index.js:2014-2060`，内部 `runAgenticArticles` 在 `index.js:2020`，单篇步数上限 `agenticMaxSteps` 传入于 `index.js:2029`）——模型自己 `read_code`/`list_files`/`edit_article` 多轮增量写作，无需源码整包内联，因此没有「超预算→拆观察批」整套装填，也没有 sessionTasks。收割后按 `tally`（`index.js:1887-1919`）记账；若失败**严格过半**（`shouldFallBackFromAgentic`（`index.js:855-860`）），且本 job 未退回过（`shouldFallBackHere`（`index.js:1923-1930`，守 `job.agenticRetried`），则只把失败篇重排进旧通道重跑一次（`index.js:2278-2316`：失败篇收集在 `index.js:2014-2023`，`prepareArticleTasks` 重装在 `index.js:2293-2297`，`job.agenticRetried = true` 在 `index.js:2298`）。`agenticArticles` 关闭时走旧通道 `prepareArticleTasks`（`index.js:727-812`）：110k–420k 区间升大档单请求写完（`markBig`（`index.js:739-747`）），总量超 420k 才拆观察→合成（观察模板 `batchArticleObservePrompt`（`index.js:1051-1067`）、合成模板 `batchArticleComposePrompt`（`index.js:1071-1099`），收割后重建合成批在 `index.js:2014-2070`）；仅单文件连大档都装不下经 `dispatchSessionTasks`（`index.js:2131-2165`）转会话通道，每 tick 由 `progressSessionTasks`（`index.js:2169-2188`）按 `classifySessionTask`（`index.js:1448-1458`）三态收割，steer 文案由 `buildSessionSteerText`（`index.js:1465-1483`）统一生成。

5. **模型调用（0.12.2 双池）**：每请求经 `llmChat`（`index.js:412-437`）走宿主 `llm.stream()`，模型由 `batchProvider`/`batchModel` 决定（默认 `workbuddy`/`hy3`，`index.js:35-36`），插件不保存任何密钥；模型不支持所配思考档位时剥档重试一次（`UNSUPPORTED_REASONING_EFFORT` 分支在 `index.js:412-416`）。并发分两档独立限流：`runRealtimeTasks`（`index.js:469-528`）按任务装填时打的 `bigTier` 标记分池（`index.js:477-478`）——大档进 `bigConcurrency` 池、其余进 `maxConcurrency` 池，两池各自 cursor/worker、`Promise.all(pools.map(runPool))` 同时推进（`index.js:526`）；`bigConcurrency` 为 0/未传时回落默认档（`index.js:485-487`）；大档任务自带 provider+model 时 effort 完全以任务为准、不回落普通档（`index.js:412-416`）。`bigTier` 标记的三个来源：文章装填 `markBig`（`index.js:739-747`）、横切单批直出（`index.js:2470-2477`）、批量校对 `markBigTask`（`index.js:2595-2601`）；`submitBatchFor` 把 `bigTier` 连同 provider/model/effort 持久化进 `job.tasks`（`index.js:412-415`），宿主重启按 prompt 快照重跑不掉池。结果由 `fixAnchors`（`index.js:568-651`）校正行号锚点后经 `writeValidated`（`index.js:1868-1884`）落盘 `<repo>/.codewiki/`。横切产出 `_architecture`/`_patterns`/concepts（模板 `batchArchitecturePrompt`（`index.js:1004-1010`）、`batchPatternsPrompt`（`index.js:1012-1018`）、`batchConceptPrompt`（`index.js:1020-1026`）），审校为批量校对（`batchProofreadBatchPrompt`（`index.js:1126-1153`）；收割 `settleProofread`（`index.js:1934-1958`）按 `@@@article:`/`
