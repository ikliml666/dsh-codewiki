---
title: System Architecture Overview
type: architecture
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - test-orchestration.mjs
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-orchestration.log
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接]
---

## Overview

本文件是 `@local/dsh-codewiki` 的系统总览，写给对仓库零上下文的未来 agent。插件（插件名 `PLUGIN_NAME`（`index.js:27`），当前版本 0.13.1（`package.json:3`））把 Rust CLI `cw`（来自 mraza007/codewiki，`README.md:3`）接入 DeepSeek Harness，提供仓库内活 wiki（`<repo>/.codewiki/`）的编译、更新与进度查询。全部模型环节在插件内完成、零子代理：模型调用唯一通道是 `llmChat`（`index.js:412-437`，经宿主 `llm.stream()`，请求带 `source: { kind: 'plugin:codewiki' }`（`index.js:27`）与 `temperature: 0`（`index.js:27`））；编译由宿主常驻服务 `createJobService`（`index.js:1693-2947`）以 tick 阶段机推进。

仓库由四个逻辑部分构成：**core-and-config**（`index.js` 宿主半侧单文件 4009 行 + `lib/` 七个吸收模块 + `client.js` 浏览器半侧 1680 行 + `cordis.patch.yml`/`package.json`/`.gitignore`）、**docs-and-meta**（`README.md`/`CodeWiki.md`/`CHANGELOG.md`）、**test-scripts**（`test-*.mjs` 回归脚本）、**logs-and-temp**（`.tmp-test-*.log` 与 `watcher2.log`，均为被 `*.log`（`.gitignore:3`）忽略的历史调试产物）。挂载方式是 `cordis.patch.yml:19-22` 的 `insert` 条目（id `codewiki`，file:/// 直挂）。

当前版本（0.13.1）的关键形态：

- **三层吸收能力（0.13.0，`README.md:5`、`CHANGELOG.md:25`，四层对照表 `README.md:32-35`）**：AST 符号提取（`extractRepoGraph`（`index.js:16`））、LLM 语义聚类模块划分（`clusterComponents`（`index.js:17`））、agentic 工具循环写作（`runAgenticArticles`（`index.js:23`））、符号级增量判定（`filterStaleTasks`/`slimGraph`/`graphFromSnapshot` 等（`index.js:19-22`））。全部用 Node + tree-sitter WASM 实现，不引 Python 运行时。三个开关 `planMode`（`index.js:76`）、`agenticArticles`（`index.js:77`，步数上限 `agenticMaxSteps`（`index.js:78`））、`symbolIncremental`（`index.js:79`）默认全开（`README.md:37`），任一环节失败自动降级；0.13.1 修复了 `generate_sub_module` 子模块递归成文的接线（`CHANGELOG.md:3-23`、`README.md:39`）。
- **阶段机无独立 plan 阶段（0.10.7 删）**：`STAGE_HANDLER`（`index.js:2738-2745`）为 articles → crosscut →（超预算拆分时 compose）→ review → index → commit；模块划分在 articles 开头就地由 `buildPlan`（`index.js:2064-2087`）完成，queued 唤醒恒进 articles（`index.js:2738`）。
- **三级装填预算**：普通单请求 110k（`BATCH_TOKEN_BUDGET`（`index.js:541`））、兜底硬上限 128k（`BATCH_TOKEN_HARD_LIMIT`（`index.js:546`））、大档预算 420k（`DEFAULT_BIG_TOKEN_BUDGET`（`index.js:42`），默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`（`index.js:39-40`）= volces-ark/glm-5.3-flash 512k 上下文）。
- **双池并发（0.12.2）**：`runRealtimeTasks`（`index.js:469-528`）按任务装填时打的 `bigTier` 标记把大档与默认档请求拆进两个独立限流池、`Promise.all` 同时推进（`index.js:526`）。
- **提交是独立 commit 阶段（0.10.11）**：`tickCommit`（`index.js:2720-2736`）调 `autoCommitWiki`（`index.js:3783-3865`），走「主题分支 codewiki/wiki-\<jobId\> 提交 → 合并回原分支 → 删主题分支」，失败降级不丢产物。
- **编译对象闸门（0.12.0/0.12.1）**：`detectLinkedWorktree`（`index.js:309-325`）拒绝 git worktree、`isDeadCompileTarget`（`index.js:378-386`）拒绝「无可编译源码」的空壳目录，submit/面板/启动清理三处共用。
- **会话透明化（0.11.0/0.12.0）**：每个 LLM 请求的 prompt/输出落盘（`beginSessionRecord`（`index.js:1400-1442`）），跨任务聚合（`listAllSessionRecords`（`index.js:1346-1366`））供面板全局「会话」Tab，保留 24h（`SESSION_TTL_MS`（`index.js:1308`））。
- **多仓库并行（0.11.0）**：`serialProjects`（`index.js:73`）默认开 = 上限 1；关闭后按 `parallelProjects`（`index.js:74`，派生 `parallelLimit`（`index.js:115-119`））1–4 并行推进。

## System Overview

```text
┌────────────────────────────┐    ┌───────────────────────┐
│ docs-and-meta              │    │ logs-and-temp         │
│ README/CodeWiki/CHANGELOG  │◄───│ .tmp-*.log/watcher2   │
└─────────────┬──────────────┘    └───────────┬───────────┘
              │ 约定/口径                      │ 回归输出
              ▼                               ▼
┌────────────────────────────┐    ┌───────────────────────┐
│ core-and-config            │◄───│ test-scripts          │
│ index.js + lib/* + client  │导入│ test-*.mjs            │
└─────────────┬──────────────┘    └───────────────────────┘
              │ cordis.patch.yml file:/// 直挂（id codewiki）
              ▼
┌────────────────────────────┐
│ DeepSeek Harness 宿主      │
│ llm/webServer/agents/tools │
└────────────────────────────┘
```

- **`index.js`（宿主半侧中枢）**：入口 `apply`（`index.js:3945-4009`）注入 `agentsRef`（`index.js:1656`）与 `llmRef`（`index.js:1661`）、创建并启动服务（`index.js:3945-3946`）、注册四个工具（`index.js:3945`：cw / codewiki_generate / codewiki_update / codewiki_progress）、挂 `installWebServer`（`index.js:3455-3750`，七个回环端点）、布 `installUpdateReminder`（`index.js:3911-3943`）、启动 60s 心跳的自动更新调度 `autoScan`（`index.js:3959-3986`，定时器 `index.js:3987-3989`）。
- **`lib/`（吸收自 FSoft CodeWiki 的七个模块）**：symbols（AST 提取）、cluster（两阶段聚类）、agentic + agentic-host + articles-agentic（工具循环写作）、graph-diff + incremental（符号级增量）；导入清单在 `index.js:16-24`，能力矩阵与降级路径见 `README.md:32-35`。
- **`client.js`（浏览器半侧）**：`window.__ModuleLoader__.load`（`client.js:10-11`）注册设置表单 `CodewikiCard`（`client.js:548-1036`：运行/编译模型/大档模型/编译流程/调度与排除五节 + 保存条（`client.js:548-557`））与侧边栏 `CodewikiPanel`（`client.js:1418-1663`：总览/任务/会话/设置四 Tab），入口图标 `PanelIcon`（`client.js:1665`，`PANEL_ORDER`（`client.js:21`）= 52）。设置命名空间 `NS`（`client.js:17`）= `codewiki`。
- **宿主服务依赖**：llm（唯一模型通道，凭证由宿主按 provider 解析，插件零密钥）、webServer（面板端点）、agents（编译终态 steer 唤醒与会话通道派发）、tools（工具注册）、workspaceRegistry（任务过滤）。
- **docs-and-meta**：README 是用户面文档，CodeWiki.md 是项目 wiki 入口，CHANGELOG 逐版本记录设计决策；**test-scripts** 直接 `import` 插件验证契约（`test-batch.mjs:7-12`、`test-orchestration.mjs:24`），`test-wiki-anchors.mjs:1-8` 守卫本文这类 wiki 文章的行号锚点。

## Data Flow

```text
┌──────────┐ codewiki_generate ┌───────────────┐ cw status/init ┌─────────┐
│ 会话/面板 │──────────────────►│ JobService     │───────────────►│ cw CLI  │
│ (agent/  │◄─────────────────│ (createJob-    │◄───────────────│ bin/cw  │
│  client) │ jobId/stage 即回  │  Service)      │ 三态/基线刷新   └─────────┘
└────┬─────┘                   └──────┬────────┘
     │ GET /api/codewiki/jobs         │ tick 阶段机: articles→crosscut→(compose)→review→index→commit
     ▼                                ▼
┌──────────┐ 2s 轮询/取消    ┌───────────────┐  llmChat（唯一通道）
│client.js │────────────────│ 双池并发执行器 │───────────►宿主 llm.stream
│ 渲染任务卡 │◄───────────────│ (batchResults) │◄────流式文本+usage
└──────────┘                └──────┬────────┘
                                   │ fixAnchors 校正 → writeValidated 落盘 .codewiki/
                                   ▼
                        ┌──────────────────────────┐
                        │ tickCommit → autoCommitWiki│
                        │ 主题分支提交→合并回原分支   │
                        └──────────────────────────┘
```

1. **提交入口与闸门**：会话调 `codewiki_generate`（`generateToolDefinition`（`index.js:2954-3166`）的 execute（`index.js:2954`））：`normalizeCwd`（`index.js:49-54`，调用在 `index.js:3002`）→ 排除清单 `excludedItem`（`index.js:284-293`，调用在 `index.js:3004-3005`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:3009`）→ 空壳闸门（`clearSourceProbeCache`（`index.js:368-371`）清缓存 + `hasCompilableSources`（`index.js:352-366`）判定，`index.js:3023-3030`）→ `cw status`（`runCw`（`index.js:162-187`）调用在 `index.js:3037`）→ `parseStatus`（`index.js:213-226`）三态（调用在 `index.js:3042`）。幂等：同仓库活动任务直接返回（`findActive`（`index.js:2934`）调用在 `index.js:3048`）；clean 短路（`index.js:2954-2957`）；stale 按文章 frontmatter 的 `source_files`（`parseSourceFiles`（`index.js:1236-1248`））逐篇预构建（`index.js:2954-3016`）——若 `symbolIncremental` 开启，用 `loadSnapshot`（`index.js:3097`）+ `extractCurrentGraph`（`index.js:1561-1578`）+ `graphFromSnapshot`（`index.js:3106`）+ `filterStaleTasks`（`index.js:2954`）做组件级过滤，全部滤掉则只刷新基线不重写（`index.js:2954-2959`）；missing 先 `cw init`（`index.js:2954-2960`）再全量提交（`index.js:3156-3163`）。`svc.submit`（`index.js:2835-2920`）再过三道闸（`index.js:2837-2858`）、`rememberRepo` 登记（`index.js:2859`）、落 `submitting` 占位（`index.js:2862-2867`）、编译模型三项校验（`index.js:2954-2963`，provider/model/llm 任一缺失即 fail 留痕）、排队判定后 `persist`+`flush`+立即 `tick`（`index.js:2916-2918`）。`codewiki_update`（`updateToolDefinition`（`index.js:3176-3228`））是固定 scope=auto 的包装；`codewiki_progress`（`progressToolDefinition`（`index.js:3247-3351`））只读查进度。

2. **项目闸门与排队**：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelLimit` 并行。submit 把后到任务预置 `queued`（`index.js:2761-2770`，`pendingStage`/`pendingTasks` 寄存），`tick`（`index.js:2747-2833`）每轮先算 `activeIds` 集合（忙碌项优先、再按提交顺序唤醒最早 queued，`index.js:2758-2770`），轮到时落地预置字段（`index.js:2796-2806`）、非本轮项目跳过（`index.js:2808`）；取消不受闸门限制（`index.js:2761-2771`，中断在飞请求），且跨实例取消标记由 `syncCancelFlags`（`index.js:1809-1820`，调用在 `index.js:2757`）每轮拾取。另一实例停更超 `ORPHAN_TAKEOVER_MS`（`index.js:1485`，默认 5 分钟）即孤儿接管（`index.js:2761-2770`）。

3. **阶段机与持久化**：`STAGE_HANDLER`（`index.js:2738-2745`）按 articles（`tickArticles`（`index.js:2213-2391`））→ crosscut（`tickCrosscut`（`index.js:2415-2498`））→ compose（`tickCompose`（`index.js:2501-2513`））→ review（`tickReview`（`index.js:2550-2661`））→ index（`tickIndex`（`index.js:2663-2718`））→ commit（`tickCommit`（`index.js:2720-2736`））推进；`setStage`（`index.js:1784-1794`）统一计各阶段耗时。job 持久化 `JOBS_FILE`（`index.js:1292`，tick 默认 `TICK_MS`（`index.js:1293`）10s），`saveJobs`（`index.js:1605-1610`）保留最近 `MAX_JOBS_KEPT`（`index.js:1486`）= 30 条；多实例安全靠 `mergeFromDisk`（`index.js:1747-1768`）磁盘吸收与 `acquireTickLock`（`index.js:1588-1603`）进程级推进锁。宿主重启由 `settleJob`（`index.js:1833-1863`）恢复：agentic 任务按 `agentic: true` 标记重跑（`index.js:2738-2744`），其余按持久化 `batchPrompt` 快照重跑（`index.js:2738-2745`），都缺则 fail（`index.js:2738`）。旧 plan 阶段任务迁移到 articles（`index.js:2738-2745`）。

4. **规划（articles 开头就地）**：full 编译无 `job.plan` 时 `buildPlan`（调用在 `index.js:2328`）：`planMode=dirs` 直接 `localPlan`（`index.js:2066-2070`；定义 `index.js:862-875`，`slugify`（`index.js:1230-1232`）保留 CJK）；`planMode=auto`（默认）走 `semanticPlan`（`index.js:884-965`）——`extractRepoGraph` 提取全仓符号图（`index.js:903`）、`resolveImportEdges` 建依赖边（`index.js:920`）、`clusterComponents` 让模型按职责聚成层级模块树（`index.js:931`）、`toPlanModules` 转模块清单（`index.js:2064`），组件图与依赖边随 plan 持久化（`index.js:2064-2076`）供 stale 组件级比对；提取不可用/聚类失败/空结果均记 note 退回 `localPlan`（`index.js:2084-2086`）。

5. **文章阶段双通道**：`agenticArticles` 开（默认）时任务打 `agentic: true`（`index.js:2014`）并交 `startAgenticRun`（`index.js:2014-2060`，内部 `runAgenticArticles` 在 `index.js:2020`，单篇步数上限在 `index.js:2014`）——模型自己 `read_code`/`list_files`/`edit_article` 多轮增量写作，源码不整包内联，因此没有观察批装填链。收割统一进 `tally`（`index.js:1887-1919`，按名去重防重复计数在 `index.js:2014`）；失败**严格过半**（`shouldFallBackFromAgentic`（`index.js:855-860`））且本 job 未退回过（`shouldFallBackHere`（`index.js:1923-1930`，守 `job.agenticRetried`）时，只把失败篇重排进旧通道重跑一次（`index.js:2278-2316`：失败篇收集 `index.js:2014-2023`，`prepareArticleTasks` 重装 `index.js:2293-2297`，置位 `index.js:2298`）。`agenticArticles` 关则走旧通道 `prepareArticleTasks`（`index.js:727-812`，调用在 `index.js:2364`）：整包装得下单请求直出（`index.js:2014`），110k–大档预算区间升大档（`markBig`（`index.js:739-747`，判定在 `index.js:761`），装填上限 `index.js:2014`），总量超大档预算才拆观察→合成（`index.js:2014-2031`；模板 `batchArticleObservePrompt`（`index.js:1051-1067`）/`batchArticleComposePrompt`（`index.js:1071-1099`），收割重建合成批 `index.js:2014-2065`）；仅单文件连大档都装不下转会话通道（`index.js:2014`）。

6. **会话通道兜底**：`dispatchSessionTasks`（`index.js:2131-2165`）把完整写作指令写任务文件并 steer 发起会话派子智能体；每 tick 由 `progressSessionTasks`（`index.js:2169-2188`）按 `classifySessionTask`（`index.js:1448-1458`）三态收割（timeout/harvest/wait），steer 文案由 `buildSessionSteerText`（`index.js:1465-1483`）统一生成（`sessionTier`（`index.js:70`）非空时钉死档位）；宿主重启后 `resendSessionSteer`（`index.js:2192-2205`）重发一次。超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS`（`index.js:1297`））按失败处理、不降级。

7. **模型调用与双池限流**：`runRealtimeTasks`（`index.js:469-528`）按 `bigTier` 标记分池（`index.js:477-489`；`bigConcurrency` 为 0/未填回落默认档 `index.js:111-113`），两池同时推进（`index.js:469`）；大档任务自带 provider+model 时思考档位完全以任务为准、不回落普通档（`index.js:469-473`）。`bigTier` 三个来源：文章装填 `markBig`（`index.js:739`）、横切单批直出（`index.js:2470-2477`）、批量校对 `markBigTask`（`index.js:2595-2601`）；`submitBatchFor`（`index.js:2089-2123`）把 bigTier 连同模型信息持久化进 `job.tasks`（`index.js:2104`），重启重跑不掉池。模型不支持所配思考档位时 `llmChat` 剥档重试一次（`index.js:469-473`）。

8. **落盘、横切与校对**：结果经 `applyTaskResult`（`index.js:441-454`）或 `writeValidated`（`index.js:1868-1884`）落盘，两者都先过 `fixAnchors`（`index.js:568-651`）做行号锚点确定性校正；源码内联带 `numberLines`（`index.js:557-559`）行号前缀与 token 预算装填（`collectSources`（`index.js:656-683`）、`estimateTokens`（`index.js:394-402`））。横切 `tickCrosscut`：总量 ≤ 大档预算单批直出（`index.js:441-458`），否则每篇模块文章一个观察任务（`index.js:441-448`，模板 `batchObservePrompt`（`index.js:1030-1047`））、合成批只吃观察（`submitComposeBatch`（`index.js:2515-2525`））；产出 `_architecture`/`_patterns`/concepts（模板 `batchArchitecturePrompt`（`index.js:1004-1010`）、`batchPatternsPrompt`（`index.js:1012-1018`）、`batchConceptPrompt`（`index.js:1020-1026`），输入装填 `packArticles`（`index.js:969-988`））。审校为批量校对：`localReview`（`index.js:2528-2548`）本地核对后，多篇按 110k 贪心合并（`index.js:441-499`）提交 `batchProofreadBatchPrompt`（`index.js:1126-1153`），收割 `settleProofread`（`index.js:1934-1958`）按 `@@@article:`/`
