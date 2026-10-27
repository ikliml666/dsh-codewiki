---
title: System Architecture Overview
type: architecture
source_files:
  - package.json
  - cordis.patch.yml
  - index.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/graph-diff.js
  - lib/incremental.js
  - README.md
  - CHANGELOG.md
  - .gitignore
  - .codewiki/_index.md
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接, 编译流水线, 吸收自FSoft]
---

## Overview

本文件是 `@local/dsh-codewiki`（当前版本 0.13.4，`package.json:3`）的系统总览，写给对仓库零上下文的未来 agent。插件把 Rust CLI `cw`（来自 mraza007/codewiki，`README.md:3`）接入 DeepSeek Harness，提供仓库内活 wiki（`<repo>/.codewiki/`，随仓库提交共享）的编译、更新与进度查询。全部模型环节在插件内完成、零子代理：模型调用唯一通道是 `llmChat`（`index.js:454-479`），它经宿主 `llm.stream()` 发请求，请求带 `source: { kind: 'plugin:codewiki' }`（`index.js:1774`）与 `temperature: 0`（`index.js:1774`）；编译由宿主常驻服务 `createJobService`（`index.js:1374-2670`）以 10s tick（`TICK_MS`，`index.js:1374`）阶段机推进。

仓库由四部分组成：**core-and-config**（`index.js` 宿主半侧单文件 4034 行 + `lib/` 七个吸收模块 + `client.js` 浏览器半侧 + `cordis.patch.yml`/`package.json`/`.gitignore`）、**docs-and-meta**（`README.md`/`CHANGELOG.md`/`.codewiki/_index.md` 等；仓库无独立 `CodeWiki.md` 文档，入口由流水线在缺省时自动生成，见 `ensureWikiEntry` `index.js:286-319`）、**test-scripts**（`test-*.mjs` 回归脚本）、**logs-and-temp**（`*.log` 被 `.gitignore:2` 忽略，`.dsh-ops/` 见 `.gitignore:2-3`）。挂载方式是 `cordis.patch.yml:19-24` 的 `insert` 条目（id `codewiki`，本地开发走 `file:///` 直挂，`config: {}` 表示全部用 `Config` schema 默认值）。

当前版本（0.13.4）的关键形态：

- **三层吸收能力（0.13.0，四层对照表 `README.md:32-37`）**：AST 符号提取（`extractRepoGraph` `lib/symbols.js:785-805`，AST 不可用时表驱动 `REGEX_RULES` 正则降级 `lib/symbols.js:302-368`）、LLM 语义聚类模块划分（`clusterComponents` `lib/cluster.js:291-389`，真递归下钻 `subdivide` `lib/cluster.js:396-422`）、agentic 工具循环写作（`runAgenticArticles` `lib/articles-agentic.js:204-279`，工具 `lib/agentic.js:323-383`）、符号级增量判定（`filterStaleTasks`/`slimGraph`/`graphFromSnapshot` 等 `lib/incremental.js:140-194`）。全部用 Node + tree-sitter WASM 实现，不引 Python 运行时（依赖落在 `vendor/tree-sitter/`，`README.md:39`）。三个开关 `planMode`（`index.js:77`）、`agenticArticles`（`index.js:78`，步数上限 `agenticMaxSteps` `index.js:79`）、`symbolIncremental`（`index.js:79`）默认全开（`cordis.patch.yml:14-17`），任一环节失败自动降级；0.13.1 把 `generate_sub_module` 子模块递归成文真正接进生产链路（`lib/articles-agentic.js:204-300` + `CHANGELOG.md:48-66`），0.13.2 修掉 `subDepth` 递归封顶失效的真缺陷（`CHANGELOG.md:48`）并加 `codeHash` 纯注释判定（`lib/graph-diff.js:108-111` + `lib/incremental.js:69-84`），0.13.3 用真实模型跑通 agentic 通道并修重复读抑制等三缺陷（`CHANGELOG.md:67-81`），0.13.4 修工具层四个实测翻车点（CRLF 行尾匹配、子模块封顶死链、`read_code` 字符上限、忽略目录与负行号，`CHANGELOG.md:67-81`）。
- **阶段机无独立 plan 阶段（0.10.7 删）**：`STAGE_HANDLER`（`index.js:2862-2869`）为 `articles` → `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit`；模块划分在 `articles` 开头就地由 `buildPlan`（`index.js:3638-3661`）完成，`queued` 唤醒恒进 `articles`（`index.js:2862-2869`）。
- **三级装填预算**：普通单请求 110k（`BATCH_TOKEN_BUDGET` `index.js:586`）、兜底硬上限 128k（`BATCH_TOKEN_HARD_LIMIT` `index.js:42`）、大档预算 420k（`DEFAULT_BIG_TOKEN_BUDGET` `index.js:39`，默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` `index.js:40-41` = volces-ark/glm-5.3-flash 512k 上下文）。
- **双池并发（0.12.2）**：`runRealtimeTasks`（`index.js:810-869`）按任务装填时打的 `bigTier` 标记把大档与默认档请求拆进两个独立限流池、`Promise.all` 同时推进（`index.js:564`）；agentic 通道同样接双池（0.13.2，`markBigAgenticTasks` `lib/articles-agentic.js:287-300` 打标，`startAgenticRun` `index.js:95-142` 传 `bigConcurrency`）。
- **提交是独立 commit 阶段（0.10.11）**：`tickCommit`（`index.js:3906-3922`）调 `autoCommitWiki`（`index.js:3906-3988`），走「主题分支 `codewiki/wiki-<jobId>`（`index.js:3906`）提交 → 合并回原分支 → 删主题分支」，失败降级不丢产物。
- **编译对象闸门（0.12.0/0.12.1）**：`detectLinkedWorktree`（`index.js:349-365`）拒绝 git worktree、`isDeadCompileTarget`（`index.js:349-357`）拒绝「无可编译源码」的空壳目录，submit/面板/启动清理三处共用。
- **会话透明化（0.11.0/0.12.0）**：每个 LLM 请求的 prompt/输出落盘（`beginSessionRecord` `index.js:1427-1469`），跨任务聚合（`listAllSessionRecords` `index.js:1389-1409`）供面板全局「会话」Tab，保留 24h（`SESSION_TTL_MS` `index.js:1389`）。
- **多仓库并行（0.11.0）**：`serialProjects`（`index.js:73`）默认开 = 上限 1；关闭后按 `parallelProjects`（`index.js:2884`，派生 `parallelLimit` `index.js:2884-2888`）1–4 并行推进。

## System Overview

```text
┌────────────────────────────┐    ┌───────────────────────┐
│ docs-and-meta              │    │ logs-and-temp         │
│ README/CHANGELOG/_index    │◄───│ *.log / .dsh-ops       │
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

- **`index.js`（宿主半侧中枢）**：入口 `apply`（`index.js:1737-1801`）注入 `agentsRef`（`index.js:1742`）与 `llmRef`（`index.js:1742`）、创建并启动服务（`index.js:1742-1743`）、注册四个工具（`index.js:1742`：cw / codewiki_generate / codewiki_update / codewiki_progress，单工具 schema 违规只丢该工具的防御在 `index.js:3578-3589`）、挂 `installWebServer`（`index.js:3578-3643`，九个回环端点见 `index.js:4034-4098`）、布 `installUpdateReminder`（`index.js:4082-4114`）、启动 60s 心跳的自动更新调度 `autoScan`（`index.js:4082-4111`）。
- **`lib/`（吸收自 FSoft CodeWiki 的七个模块）**：symbols（AST 提取 + 正则降级）、cluster（两阶段聚类 + 真递归下钻）、agentic + agentic-host + articles-agentic（工具循环写作）、graph-diff + incremental（符号级增量，含 `codeHash` 注释判定）；导入清单在 `index.js:16-24`，能力矩阵与降级路径见 `README.md:30-35`。
- **`client.js`（浏览器半侧）**：`window.__ModuleLoader__.load`（`client.js:548-549`）注册设置表单 `CodewikiCard`（`client.js:548` 起的函数作用域，含运行/编译模型/大档模型/编译流程（吸收自 FSoft CodeWiki）/调度与排除五节 + 保存条）与侧边栏 `CodewikiPanel`（`client.js:1418-1663`：总览/任务/会话/设置四 Tab），入口图标 `PanelIcon`（`client.js:21`，`PANEL_ORDER`（`client.js:21`）= 52）。设置命名空间 `NS`（`client.js:1`）= `codewiki`。
- **宿主服务依赖**：llm（唯一模型通道，凭证由宿主按 provider 解析，插件零密钥）、webServer（面板端点）、agents（编译终态 steer 唤醒与会话通道派发）、tools（工具注册）、workspaceRegistry（任务过滤，见 `wsFilterPaths` `index.js:3594-3609`）。
- **docs-and-meta**：README 是用户面文档，CHANGELOG 逐版本记录设计决策，`.codewiki/_index.md` 是仓库 wiki 的入口索引；**test-scripts** 直接 `import` 插件验证契约（`test-batch.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs` 等），`test-wiki-anchors.mjs` 守卫本文这类 wiki 文章的行号锚点（其符号提取规则与 `fixAnchors` `index.js:608-643` 同源）。

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

1. **提交入口与闸门**：会话调 `codewiki_generate`（`generateToolDefinition`（`index.js:3077-3289`）的 execute（`index.js:49-215`））：`normalizeCwd`（`index.js:49-54`，调用在 `index.js:324`）→ 排除清单 `excludedItem`（`index.js:324-336`，调用在 `index.js:349`/`index.js:349`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:408`）→ 空壳闸门（`clearSourceProbeCache`（`index.js:392-395`）清缓存 + `hasCompilableSources`（`index.js:392-406`）判定，`index.js:162-169`）→ `cw status`（`runCw`（`index.js:162-187`）调用在 `index.js:213`）→ `parseStatus`（`index.js:213-226`）三态（调用在 `index.js:3057`）。幂等：同仓库活动任务直接返回（`findActive`（`index.js:3057`）调用在 `index.js:3057`）；clean 短路（`index.js:606-609`）；stale 按文章 frontmatter 的 `source_files`（`parseSourceFiles`（`index.js:1317-1329`））逐篇预构建（`index.js:79-94`）——若 `symbolIncremental` 开启，用 `loadSnapshot`（`index.js:3077`）+ `extractCurrentGraph`（`index.js:20-37`）+ `graphFromSnapshot`（`index.js:21`）+ `filterStaleTasks`（`index.js:21`）做组件级过滤，全部滤掉则只刷新基线不重写（`index.js:21-27`）；missing 先 `cw init`（`index.js:3241-3247`）再全量提交（`index.js:3241-3248`）。`svc.submit`（`index.js:3241-3326`）再过三道闸（`index.js:1576-1597`）、`rememberRepo` 登记（`index.js:1904`）、落 `submitting` 占位（`index.js:1904-1926`）、编译模型三项校验（`index.js:1789-1798`，provider/model/llm 任一缺失即 fail 留痕）、排队判定后 `persist`+`flush`+立即 `tick`（`index.js:3292-3294`）。`codewiki_update`（`updateToolDefinition`（`index.js:3083-3135`））是固定 scope=auto 的包装；`codewiki_progress`（`progressToolDefinition`（`index.js:3370-3474`））只读查进度。

2. **项目闸门与排队**：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelLimit` 并行。submit 把后到任务预置 `queued`（`index.js:2922-2935`，`pendingStage`/`pendingTasks` 寄存），`tick`（`index.js:2885-2971`）每轮先算 `activeIds` 集合（忙碌项优先、再按提交顺序唤醒最早 queued，`index.js:2885-2894`），轮到时落地预置字段（`index.js:2885-2894`）、非本轮项目跳过（`index.js:1890`）；取消不受闸门限制（`index.js:1890-1899`，中断在飞请求），且跨实例取消标记由 `syncCancelFlags`（`index.js:1890-1901`，调用在 `index.js:1566`）每轮拾取。另一实例停更超 `ORPHAN_TAKEOVER_MS`（`index.js:1566`，默认 5 分钟）即孤儿接管（`index.js:1566-1574`）。

3. **阶段机与持久化**：`STAGE_HANDLER`（`index.js:2310-2317`）按 articles（`tickArticles`（`index.js:2526-2718`））→ crosscut（`tickCrosscut`（`index.js:2612-2695`））→ compose（`tickCompose`（`index.js:2661-2673`））→ review（`tickReview`（`index.js:2774-2897`））→ index（`tickIndex`（`index.js:2843-2898`））→ commit（`tickCommit`（`index.js:1865-1881`））推进；`setStage`（`index.js:1865-1875`）统一计各阶段耗时。job 持久化 `JOBS_FILE`（`index.js:1374`，tick 默认 `TICK_MS`（`index.js:1686`）10s），`saveJobs`（`index.js:1567-1572`）保留最近 `MAX_JOBS_KEPT`（`index.js:1828`）= 30 条；多实例安全靠 `mergeFromDisk`（`index.js:1669-1690`）磁盘吸收与 `acquireTickLock`（`index.js:1914-1928`）进程级推进锁。宿主重启由 `settleJob`（`index.js:1914-1944`）恢复：agentic 任务按 `agentic: true` 标记重跑（`index.js:805-813`），其余按持久化 `batchPrompt` 快照重跑（`index.js:805-812`），都缺则 fail（`index.js:805`）。旧 plan 阶段任务迁移到 articles（`index.js:805-812`）。

4. **规划（articles 开头就地）**：full 编译无 `job.plan` 时 `buildPlan`（调用在 `index.js:2161`）：`planMode=dirs` 直接 `localPlan`（`index.js:941-945`；定义 `index.js:1311-1324`，`slugify`（`index.js:1311-1313`）保留 CJK）；`planMode=auto`（默认）走 `semanticPlan`（`index.js:16-99`）——`extractRepoGraph` 提取全仓符号图（`index.js:16`）、`resolveImportEdges` 建依赖边（`index.js:17`）、`clusterComponents` 让模型按职责聚成层级模块树（`index.js:17`）、`toPlanModules` 转模块清单（`index.js:1026`），组件图（**不含** `sourceCode`，0.13.2 删除冗余，`CHANGELOG.md:101`）与依赖边随 plan 持久化（`index.js:941-953`）供 stale 组件级比对；提取不可用/聚类失败/空结果均记 note 退回 `localPlan`（`index.js:941-943`）。

5. **文章阶段双通道**：`agenticArticles` 开（默认）时任务打 `agentic: true`（`index.js:2110`）并交 `startAgenticRun`（`index.js:2116-2163`，内部 `runAgenticArticles` 在 `index.js:78`，单篇步数上限 `agenticMaxSteps` 传入在 `index.js:77`）——模型自己 `read_code`/`list_files`/`edit_article` 多轮增量写作，源码不整包内联，因此没有观察批装填链；0.13.3 起 `read_code` 带**重复读抑制**（`seen` 记账键为 `path + 起始行 + 结束行`，去重判定发生在读盘之前，`CHANGELOG.md:28`），`DEFAULT_MAX_STEPS` 唯一定义在 `lib/agentic.js`（= 30，`CHANGELOG.md:57`）。收割统一进 `tally`（`index.js:1976-2007`，`replace`/`mergeByName` 两个独立开关，`CHANGELOG.md:59`）；失败**严格过半**（`shouldFallBackFromAgentic`（`index.js:2019-2024`））且本 job 未退回过（`shouldFallBackHere`（`index.js:933-940`，守 `job.agenticRetried`）时，只把失败篇重排进旧通道重跑一次（`index.js:806-844`：失败篇收集在 `index.js:806-815`，`prepareArticleTasks` 重装 `index.js:77-81`，置位 `index.js:77`）。`agenticArticles` 关则走旧通道 `prepareArticleTasks`（`index.js:806-891`，调用在 `index.js:818`）：整包装得下单请求直出（`index.js:818`），110k–大档预算区间升大档（`markBig`（`index.js:818-826`，判定在 `index.js:818`），装填上限 `index.js:1132`），总量超大档预算才拆观察→合成（`index.js:1132-1149`；模板 `batchArticleObservePrompt`（`index.js:1152-1168`）/`batchArticleComposePrompt`（`index.js:1152-1180`），收割重建合成批 `index.js:1152-1203`）；仅单文件连大档都装不下转会话通道（`index.js:1152`）。

6. **会话通道兜底**：`dispatchSessionTasks`（`index.js:2228-2262`）把完整写作指令写任务文件并 steer 发起会话派子智能体；每 tick 由 `progressSessionTasks`（`index.js:1529-1548`）按 `classifySessionTask`（`index.js:1529-1539`）三态收割（timeout/harvest/wait），steer 文案由 `buildSessionSteerText`（`index.js:70-88`）统一生成（`sessionTier`（`index.js:70`）非空时钉死档位）；宿主重启后 `resendSessionSteer`（`index.js:1378-1391`）重发一次。超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS`（`index.js:1378`））按失败处理、不降级。

7. **模型调用与双池限流**：`runRealtimeTasks`（`index.js:810-869`）按 `bigTier` 标记分池（`index.js:95-110`；`bigConcurrency` 为 0/未填回落默认档 `index.js:95-97`），两池同时推进（`index.js:95`）；大档任务自带 provider+model 时思考档位完全以任务为准、不回落普通档（`index.js:810-814`）。`bigTier` 三个来源：文章装填 `markBig`（`index.js:818`）、横切单批直出（`index.js:2706-2713`）、批量校对 `markBigTask`（`index.js:2186-2192`）；`submitBatchFor`（`index.js:2186-2220`）把 bigTier 连同模型信息持久化进 `job.tasks`（`index.js:1713`），重启重跑不掉池。模型不支持所配思考档位时 `llmChat` 剥档重试一次（`index.js:452-456`）。

8. **落盘、横切与校对**：结果经 `applyTaskResult`（`index.js:1949-1962`）或 `writeValidated`（`index.js:608-624`）落盘，两者都先过 `fixAnchors`（`index.js:608-728`）做行号锚点确定性校正；源码内联带 `numberLines`（`index.js:597-600`）行号前缀与 token 预算装填（`collectSources`（`index.js:434-461`）、`estimateTokens`（`index.js:2526-2534`））。横切 `tickCrosscut`：总量 ≤ 大档预算单批直出（`index.js:2526-2544`），否则每篇模块文章一个观察任务（`index.js:1111-1122`，模板 `batchObservePrompt`（`index.js:2626-2643`））、合成批只吃观察（`submitComposeBatch`（`index.js:254-264`））；产出 `_architecture`/`_patterns`/concepts（模板 `batchArchitecturePrompt`（`index.js:1093-1099`）、`batchPatternsPrompt`（`index.js:1101-1107`）、`batchConceptPrompt`（`index.js:1050-1056`），输入装填 `packArticles`（`index.js:2639-2658`））。审校为批量校对：`localReview`（`index.js:2639-2659`）本地核对后，多篇按 110k 贪心合并（`index.js:1207-1228`）提交 `batchProofreadBatchPrompt`（`index.js:2030-2057`），收割 `settleProofread`（`index.js:2030-2054`）按 `@@@article:`/`
