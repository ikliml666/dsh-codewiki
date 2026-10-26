---
title: System Architecture Overview
type: architecture
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
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

本文件为 `@local/dsh-codewiki` 插件（版本 0.12.1，声明于 `package.json:25`）的系统总览，专为零上下文的未来 agent 编写。插件把 Rust CLI `cw`（来自 `mraza007/codewiki`）接入 DeepSeek Harness，提供代码 wiki 的编译、更新与进度查询能力。仓库由四个逻辑部分构成：核心实现与配置（`index.js`/`client.js`/`cordis.patch.yml`/`package.json`/`.gitignore`，下称 core-and-config）、文档与元信息（`README.md`/`CodeWiki.md`/`CHANGELOG.md`，下称 docs-and-meta）、测试脚本（`test-*.mjs`，下称 test-scripts）与测试/监听日志（`.tmp-test-*.log`、`watcher2.log`、`.probe3.txt`，下称 logs-and-temp）。整体以 cordis 插件机制挂载（`cordis.patch.yml:14` 的 `insert` 条目 id 为 `codewiki`，见 `cordis.patch.yml:15`），全部模型调用经宿主 `llm` 服务完成（唯一通道 `llmChat`（`index.js:392-417`））；编译由宿主常驻服务以阶段机推进（`createJobService`（`index.js:1541-2604`）），零子代理。

当前版本（0.12.1）的关键形态：

- 规划（plan）阶段已删除（0.10.7）：模块清单由 `localPlan`（`index.js:832-845`）按顶层目录本地分组，提交后直接进 articles（`STAGE_HANDLER` 不含 plan 行，`index.js:2395-2402`）。
- hy3 192k 适配（0.10.8）：普通单请求输入预算 110k（`BATCH_TOKEN_BUDGET`，`index.js:521`）；110k–420k 输入自动升大档单请求（默认 `volces-ark`/`glm-5.3-flash` 512k，常量在 `index.js:521-524`）；模块源码总量超 420k 才拆观察→合成批；仅单文件连大档都装不下才转会话通道兜底。
- 编译产物提交（0.10.11 起）是阶段机里的独立 `commit` 阶段（`STAGE_HANDLER` 的 `commit: tickCommit` 在 `index.js:2401`），走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（`autoCommitWiki`（`index.js:3406-3488`））。
- worktree 闸门（0.12.0）：`detectLinkedWorktree`（`index.js:289-305`）用 `git rev-parse --git-dir`/`--git-common-dir` 判定 linked worktree，三处拦截（`svc.submit` 的闸门在 `index.js:2500-2505`、`codewiki_generate` 的闸门在 `index.js:2666-2674`、`autoScan` 的 `isWorktreeCwd` 跳过在 `index.js:3596`）。
- 空壳目录闸门（0.12.1）：`isDeadCompileTarget`（`index.js:358-366`）统一判定 worktree 与「无可编译源码」的空壳目录，面板任务列表/仓库总览/启动清理三处共用（过滤在 `index.js:3134`、`index.js:3181`，启动清理在 `index.js:358-373`）。
- 会话记录与全局 Tab（0.11.0/0.12.0）：`beginSessionRecord`（`index.js:1270-1312`）把每个 LLM 请求的 prompt/输出落盘，`listAllSessionRecords`（`index.js:1216-1236`）跨任务聚合，面板「会话」Tab 可看。
- 并行项目推进（0.11.0）：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelProjects`（1–4）并行推进多仓库（`liveConfig` 的 `parallelLimit` 派生在 `index.js:102-106`，闸门逻辑在 `tick` 的 `index.js:2415-2427`）。

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
│ (index.js/client.js)  │导入│ (test-*.mjs)          │
└───────────┬───────────┘    └───────────────────────┘
            │ 经 cordis.patch.yml file:/// 挂载
            ▼
┌───────────────────────┐
│ DeepSeek Harness 宿主 │
│ (llm/webServer/agents)│
└───────────────────────┘
```

`core-and-config` 是系统运转中枢：`apply`（`index.js:3568-3632`）注入 `agentsRef`（`index.js:1504`）与 `llmRef`（`index.js:1509`），注册四个工具与七个 webServer 端点并启动服务；`docs-and-meta` 为其提供人机接口说明与配置约定；`test-scripts` 直接 `import './index.js'`（`test-batch.mjs:7-12`、`test-orchestration.mjs:24`）验证契约；`logs-and-temp` 收集测试与 watcher 输出以供排查。

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
│client.js │──────────────────►│ 并发池/收割   │───────────►│ 宿主 llm │
│ (面板)   │◄──────────────────│ (startBatch- │◄───────────│ 服务     │
└──────────┘  2s 轮询渲染       │  ChatRun)    │ 流式结果    └─────────┘
                               └──────┬────────┘
                                      │ fixAnchors 校正后落盘
                                      ▼
                        ┌────────────────────────┐
                        │ autoCommitWiki: 主题分支 │
                        │ codewiki/wiki-<jobId>   │
                        │ 提交→合并回原分支→删分支  │
                        └────────────────────────┘
```

1. **提交**：会话内调用 `codewiki_generate`（定义于 `generateToolDefinition`（`index.js:2611-2789`））：`normalizeCwd`（`index.js:40-45`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:2666`）→ 空壳目录闸门（`hasCompilableSources` 判定在 `index.js:2681-2687`）→ 排除清单校验（`excludedItem`（`index.js:264-273`），调用在 `index.js:2661-2662`）→ `cw status` 判态（`parseStatus`（`index.js:193-206`），调用在 `index.js:2611-2616`）→ 预构建任务后经 `svc.submit`（定义在 `index.js:2492-2577`）创建 job 立即返回 `{submitted, jobId, stage}`。`scope=auto` 在 clean 态直接报告（`index.js:2611-2614`），`stale` 态逐篇预构建直达 articles（`index.js:2730-2758`）；`codewiki_update`（`updateToolDefinition`（`index.js:2799-2851`））是固定 `scope=auto` 的包装；`codewiki_progress`（`progressToolDefinition`（`index.js:2870-2974`））只读查进度。submit 先落 `submitting` 占位（`index.js:2611-2632`），编译模型校验失败落 `failed`（`index.js:2611-2620`）。
2. **项目闸门**：`serialProjects` 默认开（串行=上限 1）；关闭后按 `parallelLimit`（1–4）并行。`svc.submit` 把后到任务预置 `queued`（`index.js:2418-2431`），`tick`（`index.js:2404-2490`）每轮先算 `activeIds` 集合（忙碌项优先入集，再按提交顺序唤醒最早 queued 直到上限，`index.js:2415-2427`），轮到时才把 `pendingStage`/`pendingTasks` 落地（`index.js:2453-2462`）。
3. **阶段机**：`STAGE_HANDLER`（`index.js:2395-2402`）按 articles（`tickArticles`，`index.js:1952-2073`）→ crosscut（`tickCrosscut`，`index.js:2097-2180`）→（超预算拆分时 compose，`tickCompose`，`index.js:2183-2195`）→ review（`tickReview`，`index.js:2232-2343`）→ index（`tickIndex`，`index.js:2345-2375`）→ commit（`tickCommit`，`index.js:2377-2393`）推进。文章阶段：full 就地 `localPlan`（调用在 `index.js:2028`）→ `prepareArticleTasks`（`index.js:707-792`）装填，装不下的单文件经 `dispatchSessionTasks`（`index.js:1870-1904`）转会话通道，每 tick 由 `progressSessionTasks`（`index.js:1908-1927`）按 `classifySessionTask`（`index.js:1318-1328`）收割。
4. **模型调用**：每请求经 `llmChat`（`index.js:392-417`）走宿主 `llm.stream()`，模型由 `batchProvider`/`batchModel` 决定（默认 `workbuddy`/`hy3`，常量在 `index.js:26-27`），插件不保存任何密钥；结果由 `fixAnchors`（`index.js:548-631`）校正行号锚点后经 `writeValidated`（`index.js:1707-1723`）落盘 `<repo>/.codewiki/`。横切产出 `_architecture`/`_patterns`/concepts（prompt 模板 `batchArchitecturePrompt`（`index.js:884-890`）、`batchPatternsPrompt`（`index.js:892-898`）、`batchConceptPrompt`（`index.js:900-906`）），审校为批量校对（`batchProofreadBatchPrompt`（`index.js:1006-1033`）；收割 `settleProofread`（`index.js:1751-1775`））。
5. **index 收尾**：`tickIndex` 执行 `cw index` + `cw meta update`（`index.js:2345-2354`）并自动补建 `CodeWiki.md` 入口（`ensureWikiEntry`（`index.js:226-259`），调用在 `index.js:2345-2349`）；有产物且 `autoCommit` 开启时 `setStage(job, 'commit')` 提前返回，不再就地提交（`index.js:2368-2371`）。
6. **commit 阶段**：`tickCommit`（`index.js:2377-2393`）调用 `autoCommitWiki`（`index.js:3406-3488`）：先执行安全前置（非 git 仓库 `index.js:2377`、无 HEAD `index.js:2377`、合并/变基中 `index.js:2377-2379`、未解决冲突 `index.js:2377`、被 `.gitignore` 忽略 `index.js:2377-2380`、缺 `user.name`/`user.email` `index.js:3432-3434`），pathspec 由 `WIKI_PATHS` 常量唯一定义（`index.js:36`）；detached HEAD 或建主题分支失败降级为直接提交（`mode:'direct'`，`index.js:2377-2385`）；正常路径建主题分支 `codewiki/wiki-<jobId>`（`index.js:2377`），在其上执行 `commitOn` 的 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（`index.js:3437-3449`），finally 保证切回原分支（`index.js:2377-2383`），再 `git merge --no-edit` 并以 `git branch -d` 删主题分支（`index.js:2377-2388`）。合并失败 → `git merge --abort` 保留主题分支（`index.js:2377-2384`）。提交完成才置 `done` 并唤醒会话（`index.js:2390-2392`）；中途死在 commit 阶段的任务重启后重跑本阶段，对已入库产物报 noChanges（幂等）。
7. **三态唤醒**：`autoCommitState`（`index.js:1517-1522`）是唯一判定——`wakeCompileSession`（`index.js:1524-1539`）在 committed/no-changes 时静默（`index.js:1528`），仅 failed 或 pending 才 steer；系统提示 section 的 `commitHintText`（`index.js:3490-3521`）走同一判定（`index.js:3501`）。
8. **面板**：`CodewikiPanel`（`client.js:1332`）每 2s（`POLL_MS`，`client.js:22`）轮询 `GET /api/codewiki/jobs`（注册于 `index.js:3119-3155`），总览页 `ReposTab`（`client.js:1332`）轮询 `GET /api/codewiki/repos`（`index.js:3156-3248`，30s 缓存），会话视图 `SessionView`（`client.js:1332`）轮询 `GET /api/codewiki/sessions`（`index.js:3254-3275`，0.12.0 起不带 `jobId` 为全局聚合）与单条 `GET /api/codewiki/sessions/item`（`index.js:3276-3293`），取消与一键编译经 `POST /api/codewiki/control`（`index.js:3340-3371`）。
9. **测试**：test-scripts 导入 `index.js` 驱动相同流程（mock 宿主 `llm` 服务 + 真实 `cw` CLI），运行输出留痕于 logs-and-temp。

## Dependency Graph

各模块间的依赖方向（箭头表示「依赖于」或「被描述/验证于」）：

```text
┌──────────────────┐       ┌──────────────────┐
│ docs-and-meta    │◄──────│ core-and-config  │
│ (描述契约)        │ 描述   │ (实现插件)        │
└──────────────────┘       └────────┬─────────┘
                                    │ import ./index.js
                                    ▼
                          ┌──────────────────┐
                          │ test-scripts      │
                          │ (test-*.mjs)      │
                          └─────────┬─────────┘
                                    │ 产出
                                    ▼
                          ┌──────────────────┐
                          │ logs-and-temp    │
                          │ (.tmp-*.log 等)  │
                          └──────────────────┘
```

- `core-and-config` 的配置字段语义由 `docs-and-meta` 定义：`Config` schema（`index.js:51-73`）与 README 设置段逐项对应（`batchProvider` 见 `README.md:29`、`bigProvider` 等大档四项见 `README.md:31`、`autoCommit` 见 `README.md:40`、`parallelProjects` 见 `index.js:65`）。
- `test-scripts` 强依赖 `core-and-config` 的导出：`test-batch.mjs:7-12` 导入 `collectSources`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`fixAnchors` 等纯函数；`test-cwd-paths.mjs:20` 调 `apply`；`test-wiki-entry.mjs:10` 导入 `ensureWikiEntry`/`parseStatus`/`normalizeIndexLinks`。
- `logs-and-temp` 被动依赖 `test-scripts` 与 watcher 进程产生内容（如 `.tmp-test-orchestration.log:1` 来自旧版编排测试）。
- 挂载与发现：`cordis.patch.yml:14-17` 以 file:/// 直挂 `index.js`（id `codewiki`）；`package.json` 的 `exports["./client"]` + `dsh.client.platform: "web"` 让宿主沿挂载条目发现 `client.js`（`engines.dsh >=0.2.0-rc.0` 声明在 `package.json:2-5`）。

## Module Roles

各模块在系统中的具体职责与关键连接点：

### docs-and-meta（`README.md`, `CodeWiki.md`, `CHANGELOG.md`）

- **职责**：`README.md` 提供工具清单（`codewiki_generate` 在 `README.md:10`、`codewiki_update` 在 `README.md:11`、`codewiki_progress` 在 `README.md:12`）与设置字段定义（设置段自 `README.md:11` 起）；`CodeWiki.md:3` 是插件自身的 wiki 入口（CodeWiki.md 公约），`CodeWiki.md` 声明上游连接 `[[codewiki-upstream]]`（布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`，见 `CodeWiki.md:65`）；`CHANGELOG.md` 记录版本演进——0.12.1 在 `CHANGELOG.md:25-46`（worktree/空壳目录彻底不出现在面板与调度里）、0.12.0 在 `CHANGELOG.md:47-56`（全局会话 Tab + worktree 闸门）、0.11.2 在 `CHANGELOG.md:58-64`（通用思考档位）、0.11.1 在 `CHANGELOG.md:66-74`（大档 effort 回落修复）、0.11.0 在 `CHANGELOG.md:76-86`（会话透明化 + 并行项目）、0.10.11 在 `CHANGELOG.md:88-100`（独立 commit 阶段与主题分支合并）、0.10.10 在 `CHANGELOG.md:102-116`（三态语义与测试竞态）、0.10.9 在 `CHANGELOG.md:118-132`（autoCommit 引入）、0.10.8 在 `CHANGELOG.md:134-146`（hy3 适配与大档）、0.10.7 在 `CHANGELOG.md:148-157`（删规划阶段）。
- **连接**：以纯文本形式描述 core-and-config 的行为契约；README 安装段（`README.md:42-57`）明确 file:/// 直挂不需要 profile link。

### core-and-config（`index.js`, `client.js`, `cordis.patch.yml`, `package.json`, `.gitignore`）

- **职责**：`index.js` 是插件唯一核心实现（Node ESM 单文件，注释自 `index.js:1-7`），按功能分组的关键符号：

  - 规范化与 cw 进程：`normalizeCwd`（`index.js:40-45`）、`resolveBinary`（`index.js:120-140`）、`runCw`（`index.js:142-167`）、`normalizeArticlePath`（`index.js:179`）、`normalizeIndexLinks`（`index.js:183-191`）、`parseStatus`（`index.js:193-206`）、`countWikiArticles`（`index.js:209-221`）、`ensureWikiEntry`（`index.js:226-259`）、排除清单 `excludedItem`（`index.js:264-273`）/`isExcluded`（`index.js:274-276`）、worktree 检测 `detectLinkedWorktree`（`index.js:289-305`）与带缓存版 `isWorktreeCwd`（`index.js:313-324`）。
  - 死目标判定（0.12.1）：`hasCompilableSources`（`index.js:332-346`，10 分钟缓存 `SOURCE_PROBE_TTL_MS` 在 `index.js:330`）、`clearSourceProbeCache`（`index.js:348-351`）、统一判定 `isDeadCompileTarget`（`index.js:358-366`）、反登记 `forgetRepo`（`index.js:1376-1385`）。
  - 编译执行链：`estimateTokens`（`index.js:374-382`）、`llmChat`（`index.js:392-417`）、`applyTaskResult`（`index.js:421-434`）、`runRealtimeTasks`（`index.js:449-508`，含大档/默认档双池分派）、`numberLines`（`index.js:537-539`）、`fixAnchors`（`index.js:548-631`）、`collectSources`（`index.js:636-663`）、`prepareArticleTasks`（`index.js:707-792`）、prompt 模板 `batchArticlePrompt`（`index.js:667-694`）、`articleFormatSection`（`index.js:798-827`）、`localPlan`（`index.js:832-845`）、`packArticles`（`index.js:849-868`）、横切三模板（`batchArchitecturePrompt`（`index.js:884-890`）、`batchPatternsPrompt`（`index.js:892-898`）、`batchConceptPrompt`（`index.js:900-906`））、`batchObservePrompt`（`index.js:910-927`）、`batchArticleObservePrompt`（`index.js:931-947`）、`batchArticleComposePrompt`（`index.js:951-979`）、`batchProofreadPrompt`（`index.js:983-1002`）、`batchProofreadBatchPrompt`（`index.js:1006-1033`）、`slugify`（`index.js:1110-1112`）、`parseSourceFiles`（`index.js:1116-1128`）、`readSourceFiles`（`index.js:1130-1138`）、`wikiPathFor`（`index.js:1140-1145`）、`scanRepoFiles`（`index.js:1403-1426`）。
  - 会话记录（0.11.0/0.12.0）：`textDeltaOf`（`index.js:1261-1268`）、`beginSessionRecord`（`index.js:1270-1312`）、`listSessionRecords`（`index.js:1200-1209`）、`readSessionRecord`（`index.js:1210-1212`）、`listAllSessionRecords`（`index.js:1216-1236`）、`pruneSessionRecords`（`index.js:1238-1258`）。
  - 编排服务 `createJobService`（`index.js:1541-2604`）：收割 `settleJob`（`index.js:1681-1702`）、写盘闸门 `writeValidated`（`index.js:1707-1723`）、记账 `tally`（`index.js:1726-1747`）、批量校对收割 `settleProofread`（`index.js:1751-1775`）、阶段执行器 `startBatchChatRun`（`index.js:1784-1826`）、`submitBatchFor`（`index.js:1828-1862`）、会话通道 `dispatchSessionTasks`（`index.js:1870-1904`）/`progressSessionTasks`（`index.js:1908-1927`）/`resendSessionSteer`（`index.js:1931-1944`）、六个 `tick*` 阶段处理（`index.js:1952-2393`）、阶段表 `STAGE_HANDLER`（`index.js:2395-2402`）、`tick` 主循环（`index.js:2404-2490`）、`submit`（`index.js:2492-2577`）/`cancel`（`index.js:2579-2588`）/`list`（`index.js:2590`）/`findActive`（`index.js:2591`）、启停 `start`（`index.js:2593-2597`）/`stop`（`index.js:2598-2601`）；持久化辅助 `loadJobs`（`index.js:1428-1431`）、跨进程锁 `acquireTickLock`（`index.js:1436-1450`）、`saveJobs`（`index.js:1453-1458`）、`jobSummary`（`index.js:1460-1497`）、磁盘吸收 `mergeFromDisk`（`index.js:1595-1616`）、`knownRepos` 登记 `rememberRepo`（`index.js:1365-1373`）。
  - commit/自动提交与提醒：`autoCommitState`（`index.js:1517-1522`）、`wakeCompileSession`（`index.js:1524-1539`）、`autoCommitWiki`（`index.js:3406-3488`）、`commitHintText`（`index.js:3490-3521`）、`reminderText`（`index.js:3523-3532`）、`installUpdateReminder`（`index.js:3534-3566`）。
  - webServer 与模型目录：`isLoopbackRequest`（`index.js:2980-2983`）、`listModelCatalog`（`index.js:3016-3037`）、`resolveModelInfoOf`（`index.js:3043-3048`）、`resolveModelEfforts`（`index.js:3054-3076`）、`installWebServer`（`index.js:3078-3373`，注册 `/api/codewiki/jobs`、`/repos`、`/sessions`、`/sessions/item`、`/models`、`/model-efforts`、`/control` 七个端点）。
  - 工具定义：`cwToolDefinition`（`index.js:1039-1102`）、`generateToolDefinition`（`index.js:2611-2789`）、`updateToolDefinition`（`index.js:2799-2851`）、`progressToolDefinition`（`index.js:2870-2974`）；入口 `apply`（`index.js:3568-3632`）。
  - `Config` schema（`index.js:51-73`）字段：`enabled`/`binaryPath`（`index.js:52-53`）、编译模型三项 `batchProvider`/`batchModel`/`batchReasoningEffort`（`index.js:54-56`）、大档四项 `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`（`index.js:57-60`）、`sessionTier`（`index.js:61`）、`maxConcurrency`/`bigConcurrency`/`serialProjects`/`parallelProjects`（`index.js:62-65`）、`articleLanguage`/`updateReminder`/`autoCommit`（`index.js:66-68`）、`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`（`index.js:69-72`），全部 `.volatile()` 由 `liveConfig`（`index.js:79-114`）热读取。
  - 常量清单：

    | 常量 | 行 | 用途 |
    |------|----|------|
    | `CW_SUBCOMMANDS` | `index.js:20` | cw 子命令白名单 |
    | `CONCURRENCY_HARD_CAP` | `index.js:22` | 并发硬顶 8 |
    | `DEFAULT_CONCURRENCY` | `index.js:24` | 默认并发 2 |
    | `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL` | `index.js:26-27` | 默认编译模型 workbuddy/hy3 |
    | `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` | `index.js:30-31` | 大档 volces-ark/glm-5.3-flash（512k） |
    | `DEFAULT_BIG_TOKEN_BUDGET` | `index.js:33` | 大档预算 420k |
    | `WIKI_PATHS` | `index.js:36` | 自动提交唯一 pathspec（`.codewiki`、`CodeWiki.md`） |
    | `BATCH_TOKEN_BUDGET` | `index.js:521` | 普通单请求输入预算 110k |
    | `BATCH_TOKEN_HARD_LIMIT` | `index.js:526` | 会话通道装填上限 128k |
    | `JOBS_FILE`/`TICK_MS` | `index.js:1162-1163` | 任务持久化 / tick 节拍（默认 10s） |
    | `SESSION_TASK_TIMEOUT_MS`/`SESSION_TASK_DIR` | `index.js:1167-1168` | 会话通道超时 30 分钟 / 任务文件目录 |
    | `SESSION_TTL_MS`/`SESSIONS_DIR`/`SESSION_FLUSH_MS` | `index.js:1178-1180` | 会话记录保留 24h / 目录 / 流式节流 3s |
    | `ORPHAN_TAKEOVER_MS`/`MAX_JOBS_KEPT` | `index.js:1355-1356` | 孤儿接管 5 分钟 / 任务保留 30 条 |
    | `REPOS_FILE` | `index.js:1361` | knownRepos 持久化 |
    | `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES` | `index.js:1389-1401` | 仓库扫描黑名单（跳过二进制/256KB 上限/2000 文件） |

- `client.js` 是浏览器半侧：经 `window.__ModuleLoader__.load`（`client.js:10`）挂载 `plugins.item` 设置卡片与 `main`/`sidebar.panellist` 双 slot 面板（`client.js:520-546`）。组件：设置卡片 `CodewikiCard`（`client.js:520`，保存键白名单含 `autoCommit`/`parallelProjects` 在 `client.js:520`）、模型三件套渲染 `modelTrio`（`client.js:520-624`）、任务面板 `CodewikiPanel`（`client.js:520`）、总览页 `ReposTab`（`client.js:520`，排除/取消排除走 `form.mutate` 在 `client.js:520-538`）、会话视图 `SessionView`（`client.js:520`，单任务与全局共用）、面板图标 `PanelIcon`（`client.js:520-531`）；步骤条 `stageBar`（`client.js:520-542`，`ACTIVE_STAGES` 含 `commit` 在 `client.js:33`）、进度权重 `STAGE_WEIGHTS`（`client.js:520`，commit 0.02）、吞吐徽标 `throughputBadge`（`client.js:520-540`）、用量行 `usageLine`（`client.js:520-536`）、spark 图 `Spark`（`client.js:520-532`）、旧阶段计时过滤 `lastTimedStage`（`client.js:520-523`）、通用思考档位 `GENERIC_EFFORTS`（`client.js:30`，0.11.2 起目录未声明时可用）。
- `cordis.patch.yml:14-17` 提供 bundle 形式挂载（本地开发走 profile patch 的 file:/// 直挂）；`package.json` 声明版本 0.12.1（`package.json:7`）、入口 `main`/`exports`（`package.json:7-11`）、唯一运行时依赖 `@deepseek-ai/schemastery`（`package.json:7-9`）；`.gitignore:3` 用 `*.log` 把测试日志排除出 git，`.gitignore:9` 排除 `.probe3.txt`，`bin/*.bak-*` 备份在 `.gitignore:6`，`.dsh-ops/` 在 `.gitignore:12`。
- **连接**：经 `cordis.patch.yml` 由宿主加载；调用宿主 `llm` 服务（`llmRef` 在 `index.js:1509`，`apply` 注入于 `index.js:3570`）与 `agents` 注册表（`agentsRef` 在 `index.js:1504`）；通过 `/api/codewiki/*` 与 `client.js` 通信；写盘 `<repo>/.codewiki/` 并由 `autoCommitWiki` 在主题分支上提交后合并回原分支。

### test-scripts（`test-batch.mjs`, `test-cwd-paths.mjs`, `test-orchestration.mjs`, `test-wiki-anchors.mjs`, `test-wiki-entry.mjs`）

- **职责**：五套互不重叠的回归测试。`test-batch.mjs` 验纯函数与端点（静态导入在 `test-batch.mjs:520-525`，动态导入检查 `resolveBatchApiKey` 已删除在 `test-batch.mjs:520-521`；装填/分割断言自 `test-batch.mjs:520` 起；会话通道三态在 `test-batch.mjs:520-535`；steer 档位钉死在 `test-batch.mjs:520-536`；宿主 llm 通道自 `test-batch.mjs:520` 起；`fixAnchors` 在 `test-batch.mjs:522-564`）。`test-orchestration.mjs` 验服务编排（测试隔离 jobs 文件带随机 token 在 `test-orchestration.mjs:44-45`；mock ctx `makeCtx` 在 `test-orchestration.mjs:44-84`；git fixture `makeFixtureRepo` 含 git identity 在 `test-orchestration.mjs:103-120`；mock llm `makeBatchMock` 在 `test-orchestration.mjs:138-202`；`autoCommitWiki` 安全边界断言组自 `test-orchestration.mjs:405-506`——正常路径 `mode==='branch'` 且主题分支已删除在 `test-orchestration.mjs:416-420`、detached HEAD 降级直接提交在 `test-orchestration.mjs:482-489`、主题分支名被占用降级且预占分支不被误删在 `test-orchestration.mjs:495-505`；`autoCommitState` 三态单测在 `test-orchestration.mjs:508-518`；worktree 闸门在 `test-orchestration.mjs:44-80`；空壳目录闸门在 `test-orchestration.mjs:44-92`；并行项目上限在 `test-orchestration.mjs:44-73`）。`test-cwd-paths.mjs` 验 MSYS/Windows 路径三态（自 `test-cwd-paths.mjs:1` 起）。`test-wiki-anchors.mjs` 把行号锚点校验制度化（基础/符号绑定/区间三重断言见头注 `test-wiki-anchors.mjs:38-46`，符号提取 `symbolsOnLine` 在 `test-wiki-anchors.mjs:38-49`）。`test-wiki-entry.mjs` 验 `ensureWikiEntry`（`test-wiki-entry.mjs:26-54`）与路径规范化（`test-wiki-entry.mjs:56-72`）。
- **连接**：全部直接 `import './index.js'` 驱动真实实现；测试环境变量隔离（`test-orchestration.mjs:15` 压 tick、`test-orchestration.mjs:22-23` 用随机 token 命名 jobs 文件防 pid 复用污染，0.10.10 修复）；与 `docs-and-meta` 记录的契约互验。

### logs-and-temp（`.probe3.txt`, `.tmp-test-*.log`, `watcher2.log`）

- **职责**：保存历史测试运行输出与一次 jobs 状态监听记录。`.probe3.txt:1` 是单行 `probe` 探测存根。`.tmp-test-batch.log:1` 起与 `.tmp-test-orchestration.log:1` 起是旧版本代码的运行留痕（如 `.tmp-test-batch.log:85` 的「59 通过」与 `.tmp-test-orchestration.log` 的「FAIL：2 项未通过」均属旧基线；`.tmp-test-orchestration.log` 仍断言旧形态 `source=plugin/codewiki`，与当前 `plugin:codewiki` 已不同步），仅供排查历史回归用。`.tmp-test-wiki-anchors.log:1` 记录锚点校验的逐条结果（基线 index.js 2508 行，见 `.tmp-test-wiki-anchors.log:1`）。`.tmp-test-cwd-paths.log:1` 与 `.tmp-test-wiki-entry.log:1` 记录路径与入口测试的全过输出；`watcher2.log:1` 起是每 30ms 采样 jobs 文件的 watcher 日志，记录的 job 仍是旧格式 `plan` 阶段（如 `watcher2.log:1` 的 `job-muwdk1pk-2 plan`），可佐证 0.10.7 之前的阶段机形态。
- **连接**：由 `test-scripts` 执行与 watcher 进程生成；被 `.gitignore:3` 的 `*.log` 与 `.gitignore:9` 的 `.probe3.txt` 规则排除出 git，不随仓库提交。

## Connections

- [[codewiki-upstream]] — 上游 `vendor/codewiki`（MIT）与捆绑二进制 `bin/cw.exe`（README 记载于 `README.md:59-65` 开发段）；wiki 布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`（`CodeWiki.md:65`）。
- 本插件四个模块的详细分工见上文 Module Roles；文档模块 `CodeWiki.md` 的 Overview 与本文件互为印证。
- 宿主侧依赖：`llm` 服务（唯一模型通道，`llmRef` 在 `index.js:1509`）、`agents` 注册表（steer 唤醒与会话通道派发，`agentsRef` 在 `index.js:1504`）、`webServer`（面板端点）、`tools`（工具注册）、`systemPrompt`（维护提醒 section），全部经 `apply` 的 `ctx.inject` 接入（`index.js:3568-3632`）。

## Known Issues

- 插件注册不热加载：改 `index.js` / profile patch 后需重启 dsh（config 值本身热读）；`client.js` 的发现同样按挂载条目缓存（`README.md:57`）。
- `@deepseek-ai/schemastery` 靠插件本地 junction 供给（`package.json:17-19`），换机器需重建（`README.md:56`）。
- logs-and-temp 的 `.tmp-test-*.log` 全部来自旧版本代码基线，与当前测试不可对照（例如 `.tmp-test-batch.log:76` 还在断言已删除的 `resolveBatchApiKey`，`.tmp-test-orchestration.log` 是旧失败记录）；以重跑 `node test-*.mjs` 的实时输出为准。
- `watcher2.log` 的采样记录（如 `watcher2.log:1` 的 `plan` 阶段 job）属 0.10.7 之前形态，仅作历史佐证。
- `.probe3.txt:1` 是无功能探测存根，随 `.gitignore:9` 不入库。
- 上游 `cw` 无 `--version`；Windows 反斜杠路径污染已在 Rust fork 层根治（`rel_path_string`），插件层 `normalizeArticlePath`（`index.js:179`）保留为纵深防御（注释见 `index.js:174-183`）。
- `codewiki_progress` 输出 schema 的 `progress` 等可空字段必须写 `oneOf: [type, null]` 形态（`index.js:2900`），0.10.5 曾因 `progress: null` 未声明 null 而整体校验失败（`CHANGELOG.md:147-157` 记录）。
- `autoCommitWiki` 的合并冲突路径（编译期间用户在原分支推进产生的 add/add 冲突）在同步流程内构造不出来，为防御性代码、单测不覆盖（注释在 `test-orchestration.mjs:491-494` 与 `index.js:3406-3408`）。
- `isDeadCompileTarget`（`index.js:358-366`）对**已删除的目录**返回 `false`——「目录已被用户删掉」的历史任务仍留在面板（有意为之）；空壳判定依赖 `scanRepoFiles` 的 2000 文件上限与黑名单目录，全部源码都落在黑名单（如 `node_modules`/`.next`/`dist`）的极端仓库会被误判为空壳（`CHANGELOG.md:43`）。
- 会话通道任务依赖发起会话可用：面板/自动调度提交的 job 没有会话可 steer，超预算文章/校对任务直接整体失败并明示原因（`dispatchSessionTasks` 在 `index.js:1870-1876`）；超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS`，`index.js:1167`）。
