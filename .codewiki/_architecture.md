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

本文件是 `@local/dsh-codewiki`（当前版本 0.13.4，`package.json:3`）的系统总览，写给对仓库零上下文的未来 agent。插件把 Rust CLI `cw`（来自 mraza007/codewiki，`README.md:3`）接入 DeepSeek Harness，提供仓库内活 wiki（`<repo>/.codewiki/`，随仓库提交共享）的编译、更新与进度查询。全部模型环节在插件内完成、零子代理：模型调用唯一通道是 `llmChat`（`index.js:412-437`），它经宿主 `llm.stream()` 发请求，请求带 `source: { kind: 'plugin:codewiki' }`（`index.js:412`）与 `temperature: 0`（`index.js:412`）；编译由宿主常驻服务 `createJobService`（`index.js:1695-2971`）以 10s tick（`TICK_MS`，`index.js:1295`）阶段机推进。

仓库由四部分组成：**core-and-config**（`index.js` 宿主半侧单文件 4034 行 + `lib/` 七个吸收模块 + `client.js` 浏览器半侧 + `cordis.patch.yml`/`package.json`/`.gitignore`）、**docs-and-meta**（`README.md`/`CHANGELOG.md`/`.codewiki/_index.md` 等；仓库无独立 `CodeWiki.md` 文档，入口由流水线在缺省时自动生成，见 `ensureWikiEntry` `index.js:246-279`）、**test-scripts**（`test-*.mjs` 回归脚本）、**logs-and-temp**（`*.log` 被 `.gitignore:2` 忽略，`.dsh-ops/` 见 `.gitignore:2-3`）。挂载方式是 `cordis.patch.yml:19-24` 的 `insert` 条目（id `codewiki`，本地开发走 `file:///` 直挂，`config: {}` 表示全部用 `Config` schema 默认值）。

当前版本（0.13.4）的关键形态：

- **三层吸收能力（0.13.0，四层对照表 `README.md:32-37`）**：AST 符号提取（`extractRepoGraph` `lib/symbols.js:785-805`，AST 不可用时表驱动 `REGEX_RULES` 正则降级 `lib/symbols.js:302-368`）、LLM 语义聚类模块划分（`clusterComponents` `lib/cluster.js:291-389`，真递归下钻 `subdivide` `lib/cluster.js:396-422`）、agentic 工具循环写作（`runAgenticArticles` `lib/articles-agentic.js:204-279`，工具 `lib/agentic.js:323-383`）、符号级增量判定（`filterStaleTasks`/`slimGraph`/`graphFromSnapshot` 等 `lib/incremental.js:140-194`）。全部用 Node + tree-sitter WASM 实现，不引 Python 运行时（依赖落在 `vendor/tree-sitter/`，`README.md:32`）。三个开关 `planMode`（`index.js:76`）、`agenticArticles`（`index.js:77`，步数上限 `agenticMaxSteps` `index.js:78`）、`symbolIncremental`（`index.js:79`）默认全开（`cordis.patch.yml:14-17`），任一环节失败自动降级；0.13.1 把 `generate_sub_module` 子模块递归成文真正接进生产链路（`lib/articles-agentic.js:204-300` + `CHANGELOG.md:75-93`），0.13.2 修掉 `subDepth` 递归封顶失效的真缺陷（`CHANGELOG.md:46`）并加 `codeHash` 纯注释判定（`lib/graph-diff.js:108-111` + `lib/incremental.js:140-155`），0.13.3 用真实模型跑通 agentic 通道并修重复读抑制等三缺陷（`CHANGELOG.md:67-81`），0.13.4 修工具层四个实测翻车点（CRLF 行尾匹配、子模块封顶死链、`read_code` 字符上限、忽略目录与负行号，`CHANGELOG.md:67-81`）。
- **阶段机无独立 plan 阶段（0.10.7 删）**：`STAGE_HANDLER`（`index.js:2762-2769`）为 `articles` → `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit`；模块划分在 `articles` 开头就地由 `buildPlan`（`index.js:2074-2097`）完成，`queued` 唤醒恒进 `articles`（`index.js:2820-2827`）。
- **三级装填预算**：普通单请求 110k（`BATCH_TOKEN_BUDGET` `index.js:541`）、兜底硬上限 128k（`BATCH_TOKEN_HARD_LIMIT` `index.js:546`）、大档预算 420k（`DEFAULT_BIG_TOKEN_BUDGET` `index.js:42`，默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` `index.js:39-40` = volces-ark/glm-5.3-flash 512k 上下文）。
- **双池并发（0.12.2）**：`runRealtimeTasks`（`index.js:469-528`）按任务装填时打的 `bigTier` 标记把大档与默认档请求拆进两个独立限流池、`Promise.all` 同时推进（`index.js:524`）；agentic 通道同样接双池（0.13.2，`markBigAgenticTasks` `lib/articles-agentic.js:287-300` 打标，`startAgenticRun` `index.js:2023-2070` 传 `bigConcurrency`）。
- **提交是独立 commit 阶段（0.10.11）**：`tickCommit`（`index.js:2744-2760`）调 `autoCommitWiki`（`index.js:3807-3889`），走「主题分支 `codewiki/wiki-<jobId>`（`index.js:2744`）提交 → 合并回原分支 → 删主题分支」，失败降级不丢产物。
- **编译对象闸门（0.12.0/0.12.1）**：`detectLinkedWorktree`（`index.js:309-325`）拒绝 git worktree、`isDeadCompileTarget`（`index.js:378-386`）拒绝「无可编译源码」的空壳目录，submit/面板/启动清理三处共用。
- **会话透明化（0.11.0/0.12.0）**：每个 LLM 请求的 prompt/输出落盘（`beginSessionRecord` `index.js:1402-1444`），跨任务聚合（`listAllSessionRecords` `index.js:1348-1368`）供面板全局「会话」Tab，保留 24h（`SESSION_TTL_MS` `index.js:1310`）。
- **多仓库并行（0.11.0）**：`serialProjects`（`index.js:73`）默认开 = 上限 1；关闭后按 `parallelProjects`（`index.js:74`，派生 `parallelLimit` `index.js:115-119`）1–4 并行推进。

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

- **`index.js`（宿主半侧中枢）**：入口 `apply`（`index.js:3969-4033`）注入 `agentsRef`（`index.js:3970`）与 `llmRef`（`index.js:3971`）、创建并启动服务（`index.js:3969-3970`）、注册四个工具（`index.js:3969-3985`：cw / codewiki_generate / codewiki_update / codewiki_progress，单工具 schema 违规只丢该工具的防御在 `index.js:3969-3980`）、挂 `installWebServer`（`index.js:3479-3774`，九个回环端点见 `index.js:3969-4033`）、布 `installUpdateReminder`（`index.js:3935-3967`）、启动 60s 心跳的自动更新调度 `autoScan`（`index.js:3983-4012`）。
- **`lib/`（吸收自 FSoft CodeWiki 的七个模块）**：symbols（AST 提取 + 正则降级）、cluster（两阶段聚类 + 真递归下钻）、agentic + agentic-host + articles-agentic（工具循环写作）、graph-diff + incremental（符号级增量，含 `codeHash` 注释判定）；导入清单在 `index.js:16-24`，能力矩阵与降级路径见 `README.md:30-35`。
- **`client.js`（浏览器半侧）**：`window.__ModuleLoader__.load`（`client.js:10-11`）注册设置表单 `CodewikiCard`（`client.js:548` 起的函数作用域，含运行/编译模型/大档模型/编译流程（吸收自 FSoft CodeWiki）/调度与排除五节 + 保存条）与侧边栏 `CodewikiPanel`（`client.js:1418-1663`：总览/任务/会话/设置四 Tab），入口图标 `PanelIcon`（`client.js:1665`，`PANEL_ORDER`（`client.js:21`）= 52）。设置命名空间 `NS`（`client.js:17`）= `codewiki`。
- **宿主服务依赖**：llm（唯一模型通道，凭证由宿主按 provider 解析，插件零密钥）、webServer（面板端点）、agents（编译终态 steer 唤醒与会话通道派发）、tools（工具注册）、workspaceRegistry（任务过滤，见 `wsFilterPaths` `index.js:3495-3510`）。
- **docs-and-meta**：README 是用户面文档，CHANGELOG 逐版本记录设计决策，`.codewiki/_index.md` 是仓库 wiki 的入口索引；**test-scripts** 直接 `import` 插件验证契约（`test-batch.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs` 等），`test-wiki-anchors.mjs` 守卫本文这类 wiki 文章的行号锚点（其符号提取规则与 `fixAnchors` `index.js:568-577` 同源）。

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

1. **提交入口与闸门**：会话调 `codewiki_generate`（`generateToolDefinition`（`index.js:2978-3190`）的 execute（`index.js:2978-3144`））：`normalizeCwd`（`index.js:49-54`，调用在 `index.js:3026`）→ 排除清单 `excludedItem`（`index.js:284-296`，调用在 `index.js:3028`/`index.js:3072`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:3033`）→ 空壳闸门（`clearSourceProbeCache`（`index.js:368-371`）清缓存 + `hasCompilableSources`（`index.js:352-366`）判定，`index.js:3047-3054`）→ `cw status`（`runCw`（`index.js:162-187`）调用在 `index.js:3061`）→ `parseStatus`（`index.js:213-226`）三态（调用在 `index.js:3066`）。幂等：同仓库活动任务直接返回（`findActive`（`index.js:2958`）调用在 `index.js:3072`）；clean 短路（`index.js:2978-2981`）；stale 按文章 frontmatter 的 `source_files`（`parseSourceFiles`（`index.js:1238-1250`））逐篇预构建（`index.js:2978-2993`）——若 `symbolIncremental` 开启，用 `loadSnapshot`（`index.js:3121`）+ `extractCurrentGraph`（`index.js:1563-1580`）+ `graphFromSnapshot`（`index.js:3129`）+ `filterStaleTasks`（`index.js:3130`）做组件级过滤，全部滤掉则只刷新基线不重写（`index.js:2978-2984`）；missing 先 `cw init`（`index.js:2978-2984`）再全量提交（`index.js:3180-3187`）。`svc.submit`（`index.js:2859-2944`）再过三道闸（`index.js:2861-2882`）、`rememberRepo` 登记（`index.js:2883`）、落 `submitting` 占位（`index.js:2886-2908`）、编译模型三项校验（`index.js:2978-2987`，provider/model/llm 任一缺失即 fail 留痕）、排队判定后 `persist`+`flush`+立即 `tick`（`index.js:2940-2942`）。`codewiki_update`（`updateToolDefinition`（`index.js:3200-3252`））是固定 scope=auto 的包装；`codewiki_progress`（`progressToolDefinition`（`index.js:3271-3375`））只读查进度。

2. **项目闸门与排队**：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelLimit` 并行。submit 把后到任务预置 `queued`（`index.js:2922-2935`，`pendingStage`/`pendingTasks` 寄存），`tick`（`index.js:2771-2857`）每轮先算 `activeIds` 集合（忙碌项优先、再按提交顺序唤醒最早 queued，`index.js:2785-2794`），轮到时落地预置字段（`index.js:2820-2829`）、非本轮项目跳过（`index.js:2832`）；取消不受闸门限制（`index.js:2785-2794`，中断在飞请求），且跨实例取消标记由 `syncCancelFlags`（`index.js:1811-1822`，调用在 `index.js:2781`）每轮拾取。另一实例停更超 `ORPHAN_TAKEOVER_MS`（`index.js:1487`，默认 5 分钟）即孤儿接管（`index.js:2785-2793`）。

3. **阶段机与持久化**：`STAGE_HANDLER`（`index.js:2762-2769`）按 articles（`tickArticles`（`index.js:2223-2415`））→ crosscut（`tickCrosscut`（`index.js:2439-2522`））→ compose（`tickCompose`（`index.js:2525-2537`））→ review（`tickReview`（`index.js:2574-2685`））→ index（`tickIndex`（`index.js:2687-2742`））→ commit（`tickCommit`（`index.js:2744-2760`））推进；`setStage`（`index.js:1786-1796`）统一计各阶段耗时。job 持久化 `JOBS_FILE`（`index.js:1294`，tick 默认 `TICK_MS`（`index.js:1295`）10s），`saveJobs`（`index.js:1607-1612`）保留最近 `MAX_JOBS_KEPT`（`index.js:1488`）= 30 条；多实例安全靠 `mergeFromDisk`（`index.js:1749-1770`）磁盘吸收与 `acquireTickLock`（`index.js:1590-1604`）进程级推进锁。宿主重启由 `settleJob`（`index.js:1835-1865`）恢复：agentic 任务按 `agentic: true` 标记重跑（`index.js:1844-1852`），其余按持久化 `batchPrompt` 快照重跑（`index.js:2762-2769`），都缺则 fail（`index.js:2762`）。旧 plan 阶段任务迁移到 articles（`index.js:2762-2769`）。

4. **规划（articles 开头就地）**：full 编译无 `job.plan` 时 `buildPlan`（调用在 `index.js:2338`）：`planMode=dirs` 直接 `localPlan`（`index.js:2076-2080`；定义 `index.js:862-875`，`slugify`（`index.js:1232-1234`）保留 CJK）；`planMode=auto`（默认）走 `semanticPlan`（`index.js:884-967`）——`extractRepoGraph` 提取全仓符号图（`index.js:903`）、`resolveImportEdges` 建依赖边（`index.js:920`）、`clusterComponents` 让模型按职责聚成层级模块树（`index.js:931`）、`toPlanModules` 转模块清单（`index.js:943`），组件图（**不含** `sourceCode`，0.13.2 删除冗余，`CHANGELOG.md:61`）与依赖边随 plan 持久化（`index.js:947-959`）供 stale 组件级比对；提取不可用/聚类失败/空结果均记 note 退回 `localPlan`（`index.js:2094-2096`）。

5. **文章阶段双通道**：`agenticArticles` 开（默认）时任务打 `agentic: true`（`index.js:2023`）并交 `startAgenticRun`（`index.js:2023-2070`，内部 `runAgenticArticles` 在 `index.js:2029`，单篇步数上限 `agenticMaxSteps` 传入在 `index.js:2039`）——模型自己 `read_code`/`list_files`/`edit_article` 多轮增量写作，源码不整包内联，因此没有观察批装填链；0.13.3 起 `read_code` 带**重复读抑制**（`seen` 记账键为 `path + 起始行 + 结束行`，去重判定发生在读盘之前，`CHANGELOG.md:28`），`DEFAULT_MAX_STEPS` 唯一定义在 `lib/agentic.js`（= 30，`CHANGELOG.md:57`）。收割统一进 `tally`（`index.js:1897-1928`，`replace`/`mergeByName` 两个独立开关，`CHANGELOG.md:59`）；失败**严格过半**（`shouldFallBackFromAgentic`（`index.js:855-860`））且本 job 未退回过（`shouldFallBackHere`（`index.js:1932-1939`，守 `job.agenticRetried`）时，只把失败篇重排进旧通道重跑一次（`index.js:2288-2326`：失败篇收集在 `index.js:2023-2032`，`prepareArticleTasks` 重装 `index.js:2303-2307`，置位 `index.js:2308`）。`agenticArticles` 关则走旧通道 `prepareArticleTasks`（`index.js:727-812`，调用在 `index.js:2388`）：整包装得下单请求直出（`index.js:2023`），110k–大档预算区间升大档（`markBig`（`index.js:739-747`，判定在 `index.js:761`），装填上限 `index.js:2023`），总量超大档预算才拆观察→合成（`index.js:2023-2040`；模板 `batchArticleObservePrompt`（`index.js:1053-1069`）/`batchArticleComposePrompt`（`index.js:1073-1101`），收割重建合成批 `index.js:2023-2074`）；仅单文件连大档都装不下转会话通道（`index.js:2023`）。

6. **会话通道兜底**：`dispatchSessionTasks`（`index.js:2141-2175`）把完整写作指令写任务文件并 steer 发起会话派子智能体；每 tick 由 `progressSessionTasks`（`index.js:2179-2198`）按 `classifySessionTask`（`index.js:1450-1460`）三态收割（timeout/harvest/wait），steer 文案由 `buildSessionSteerText`（`index.js:1467-1485`）统一生成（`sessionTier`（`index.js:70`）非空时钉死档位）；宿主重启后 `resendSessionSteer`（`index.js:2202-2215`）重发一次。超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS`（`index.js:1299`））按失败处理、不降级。

7. **模型调用与双池限流**：`runRealtimeTasks`（`index.js:469-528`）按 `bigTier` 标记分池（`index.js:469-484`；`bigConcurrency` 为 0/未填回落默认档 `index.js:111-113`），两池同时推进（`index.js:469`）；大档任务自带 provider+model 时思考档位完全以任务为准、不回落普通档（`index.js:469-473`）。`bigTier` 三个来源：文章装填 `markBig`（`index.js:739`）、横切单批直出（`index.js:2494-2501`）、批量校对 `markBigTask`（`index.js:2619-2625`）；`submitBatchFor`（`index.js:2099-2133`）把 bigTier 连同模型信息持久化进 `job.tasks`（`index.js:2114`），重启重跑不掉池。模型不支持所配思考档位时 `llmChat` 剥档重试一次（`index.js:469-473`）。

8. **落盘、横切与校对**：结果经 `applyTaskResult`（`index.js:441-454`）或 `writeValidated`（`index.js:1870-1886`）落盘，两者都先过 `fixAnchors`（`index.js:568-651`）做行号锚点确定性校正；源码内联带 `numberLines`（`index.js:557-559`）行号前缀与 token 预算装填（`collectSources`（`index.js:656-683`）、`estimateTokens`（`index.js:394-402`））。横切 `tickCrosscut`：总量 ≤ 大档预算单批直出（`index.js:441-459`），否则每篇模块文章一个观察任务（`index.js:441-452`，模板 `batchObservePrompt`（`index.js:1032-1049`））、合成批只吃观察（`submitComposeBatch`（`index.js:2539-2549`））；产出 `_architecture`/`_patterns`/concepts（模板 `batchArchitecturePrompt`（`index.js:1006-1012`）、`batchPatternsPrompt`（`index.js:1014-1020`）、`batchConceptPrompt`（`index.js:1022-1028`），输入装填 `packArticles`（`index.js:971-990`））。审校为批量校对：`localReview`（`index.js:2552-2572`）本地核对后，多篇按 110k 贪心合并（`index.js:441-462`）提交 `batchProofreadBatchPrompt`（`index.js:1128-1155`），收割 `settleProofread`（`index.js:1943-1967`）按 `@@@article:`/`
