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

本文件为 `@local/dsh-codewiki` 插件（版本 0.10.11，声明于 `package.json:25`）的系统总览，专为零上下文的未来 agent 编写。插件把 Rust CLI `cw`（来自 `mraza007/codewiki`）接入 DeepSeek Harness，提供代码 wiki 的编译、更新与进度查询能力。仓库由四个逻辑部分构成：核心实现与配置（`index.js`/`client.js`/`cordis.patch.yml`/`package.json`/`.gitignore`，下称 core-and-config）、文档与元信息（`README.md`/`CodeWiki.md`/`CHANGELOG.md`，下称 docs-and-meta）、测试脚本（`test-*.mjs`，下称 test-scripts）与测试/监听日志（`.tmp-test-*.log`、`watcher2.log`、`.probe3.txt`，下称 logs-and-temp）。整体以 cordis 插件机制挂载（`cordis.patch.yml:13` 的 `insert` 条目 id 为 `codewiki`，见 `cordis.patch.yml:14`），全部模型调用经宿主 `llm` 服务完成（唯一通道 `llmChat`，`index.js:288-307`），编译由宿主常驻服务以阶段机推进（`createJobService`，`index.js:1238-2240`），零子代理。

当前版本（0.10.11）的关键形态：

- 规划（plan）阶段已删除（0.10.7）：模块清单由 `localPlan`（`index.js:685-698`）按顶层目录本地分组，提交后直接进 articles。
- hy3 192k 适配（0.10.8）：普通单请求输入预算 110k（`BATCH_TOKEN_BUDGET`，`index.js:374`），110k–420k 输入自动升大档单请求（默认 `volces-ark`/`glm-5.3-flash` 512k，常量在 `index.js:374-377`）；模块总量超 420k 才拆观察→合成批；仅单文件连大档都装不下才转会话通道兜底。
- 编译产物提交（0.10.11）是阶段机里的独立 `commit` 阶段（`STAGE_HANDLER` 的 `commit: tickCommit` 行在 `index.js:2066`），走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（`autoCommitWiki`，`index.js:2948-3030`）。

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

`core-and-config` 是系统运转中枢：`apply`（`index.js:3110-3169`）注入 `agents`（`index.js:3111`）与 `llm`（`index.js:3112`），注册四个工具与四个 webServer 端点并启动服务；`docs-and-meta` 为其提供人机接口说明与配置约定；`test-scripts` 直接 `import './index.js'`（`test-batch.mjs:7-12`、`test-orchestration.mjs:24`）验证契约；`logs-and-temp` 收集测试与 watcher 输出以供排查。

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

1. **提交**：会话内调用 `codewiki_generate`（定义于 `index.js:40-190`）：`normalizeCwd`（`index.js:40-45`）→ 排除清单校验（`excludedItem`，`index.js:252-264`）→ `cw status` 判态（`parseStatus`，`index.js:181-194`）→ 预构建任务后经 `submit`（`index.js:2148-2213`）创建 job 立即返回 `{submitted, jobId, stage}`。`scope=auto` 在 clean 态直接报告（`index.js:40`），stale 态逐篇预构建直达 articles（`index.js:40-66`）；`codewiki_update`（`index.js:40-92`）是固定 `scope=auto` 的包装；`codewiki_progress`（`index.js:40-144`）只读查进度。submit 先落 `submitting` 占位（`index.js:40-44`），编译模型校验失败落 `failed`（`index.js:40-49`）。
2. **串行闸门**：`serialProjects` 默认开时，`submit` 把后到任务预置 `queued`（`index.js:2148-2156`），`tick`（`index.js:2069-2146`）每轮先算 `activeId`（`index.js:2078-2083`），轮到时才把 `pendingStage`/`pendingTasks` 落地（`index.js:2109-2118`）。
3. **阶段机**：`STAGE_HANDLER`（`index.js:2060-2067`）按 articles（`tickArticles`，`index.js:1619-1740`）→ crosscut（`index.js:2060-2142`）→（超预算时 compose，`index.js:2060-2084`）→ review（`index.js:2060-2170`）→ index（`index.js:2060-2090`）→ commit（`index.js:2060-2076`）推进。文章阶段：full 就地 `localPlan`（`index.js:2060-2065`）→ `prepareArticleTasks`（`index.js:560-645`）装填，装不下的单文件经 `dispatchSessionTasks`（`index.js:1537-1571`）转会话通道，每 tick 由 `progressSessionTasks`（`index.js:1575-1594`）按 `classifySessionTask`（`index.js:1027-1037`）收割。
4. **模型调用**：每请求经 `llmChat`（`index.js:288-307`）走宿主 `llm.stream()`，模型由 `batchProvider`/`batchModel` 决定（默认 `workbuddy`/`hy3`，`index.js:26-27`），插件不保存任何密钥；结果由 `fixAnchors`（`index.js:401-484`）校正行号锚点后经 `writeValidated`（`index.js:1382-1398`）落盘 `<repo>/.codewiki/`。横切产出 `_architecture`/`_patterns`/concepts（prompt 模板 `index.js:288-310`），审校为批量校对（`batchProofreadBatchPrompt`，`index.js:859-886`；收割 `settleProofread`，`index.js:1426-1450`）。
5. **index 收尾**：`tickIndex` 执行 `cw index` + `cw meta update`（`index.js:2010-2011`）并自动补建 `CodeWiki.md` 入口（`ensureWikiEntry`，`index.js:214-247`，调用在 `index.js:2023`）；有产物且 `autoCommit` 开启时 `setStage('commit')` 提前返回（`index.js:2033-2036`），不再就地提交。
6. **commit 阶段**：`tickCommit`（`index.js:2042-2058`）调用 `autoCommitWiki`（`index.js:2948-3030`）：先建主题分支 `codewiki/wiki-<jobId>`（`index.js:2042-2043`），在其上执行 `commitOn` 的 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（`index.js:2979-2991`，pathspec 由 `WIKI_PATHS` 常量唯一定义，`index.js:36`），finally 保证切回原分支（`index.js:2042-2044`），再 `git merge --no-edit`（`index.js:2042`）并以 `git branch -d` 删主题分支（`index.js:2042-2043`）。安全前置（非 git 仓库、无 HEAD、合并/变基中、未解决冲突、被 `.gitignore` 忽略、缺 `user.name`）在分支切换之前执行（`index.js:2042-2061`）；detached HEAD（`index.js:2042-2046`）或建分支失败（`index.js:2042-2045`）降级为直接提交（`mode:'direct'`）；合并失败 → `git merge --abort` 保留主题分支（`index.js:2042-2049`）。提交完成才置 `done` 并唤醒会话（`index.js:2055-2057`）；中途死在 commit 阶段的任务重启后重跑本阶段，对已入库产物报 noChanges（幂等）。
7. **三态唤醒**：`autoCommitState`（`index.js:1214-1219`）是唯一判定——`wakeCompileSession`（`index.js:1221-1236`）在 committed/no-changes 时静默（`index.js:1225`），仅 failed 或 pending 才 steer；系统提示 section 的 `commitHintText`（`index.js:3032-3063`）走同一判定。
8. **面板**：`CodewikiPanel`（`client.js:1145`）每 2s（`POLL_MS`，`client.js:22`）轮询 `GET /api/codewiki/jobs`（注册于 `index.js:2727-2745`），总览页 `ReposTab`（`client.js:1000`）轮询 `GET /api/codewiki/repos`（`index.js:2749-2835`，30s 缓存），取消与一键编译经 `POST /api/codewiki/control`（`index.js:2882-2913`）。
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

- `core-and-config` 的配置字段语义由 `docs-and-meta` 定义：`Config` schema（`index.js:51-71`）与 README 设置段逐项对应（`batchProvider` 见 `README.md:29`、大档四项见 `README.md:56`、`autoCommit` 见 `README.md:39`）。
- `test-scripts` 强依赖 `core-and-config` 的导出：`test-batch.mjs:7-12` 导入 `collectSources`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`fixAnchors` 等纯函数；`test-cwd-paths.mjs:20` 调 `apply`；`test-wiki-entry.mjs:10` 导入 `ensureWikiEntry`/`parseStatus`/`normalizeIndexLinks`。
- `logs-and-temp` 被动依赖 `test-scripts` 与 watcher 进程产生内容（如 `.tmp-test-orchestration.log:1` 来自旧版编排测试）。
- 挂载与发现：`cordis.patch.yml:13-15` 以 file:/// 直挂 `index.js`（id `codewiki`）；`package.json:2-5` 的 `exports["./client"]` + `package.json:2-4` 的 `dsh.client.platform: "web"` 让宿主沿挂载条目发现 `client.js`（`engines.dsh >=0.2.0-rc.0` 声明在 `package.json:2`）。

## Module Roles

各模块在系统中的具体职责与关键连接点：

### docs-and-meta（`README.md`, `CodeWiki.md`, `CHANGELOG.md`）

- **职责**：`README.md` 提供工具清单（`codewiki_generate` 在 `README.md:10`、`codewiki_update` 在 `README.md:11`、`codewiki_progress` 在 `README.md:12`）与设置字段定义（设置段自 `README.md:11` 起）；`CodeWiki.md:3` 是插件自身的 wiki 入口（CodeWiki.md 公约），`CodeWiki.md:65` 声明上游连接 `[[codewiki-upstream]]`（布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`）；`CHANGELOG.md` 记录版本演进——0.10.11 在 `CHANGELOG.md:3-15`（独立 commit 阶段与主题分支合并）、0.10.10 在 `CHANGELOG.md:17-31`（三态语义与测试竞态）、0.10.9 在 `CHANGELOG.md:33-47`（autoCommit 引入）、0.10.8 在 `CHANGELOG.md:49-61`（hy3 适配与大档）、0.10.7 在 `CHANGELOG.md:63-72`（删规划阶段）、0.10.5 在 `CHANGELOG.md:84-94`（progress schema nullable 修复）。
- **连接**：以纯文本形式描述 core-and-config 的行为契约；README 安装段（`README.md:42-57`）明确 file:/// 直挂不需要 profile link。

### core-and-config（`index.js`, `client.js`, `cordis.patch.yml`, `package.json`, `.gitignore`）

- **职责**：`index.js` 是插件唯一核心实现（Node ESM 单文件），按功能分组的关键符号：

  - 规范化与 cw 进程：`normalizeCwd`（`index.js:40`）、`resolveBinary`（`index.js:108-128`，PATH 优先、捆绑兜底）、`runCw`（`index.js:130-155`）、`normalizeArticlePath`（`index.js:167`）、`normalizeIndexLinks`（`index.js:171-179`）、`parseStatus`（`index.js:181-194`）、`countWikiArticles`（`index.js:197-209`）、`ensureWikiEntry`（`index.js:214-247`）、排除清单 `excludedItem`/`isExcluded`（`index.js:252-264`）。
  - 编译执行链：`estimateTokens`（`index.js:272-280`）、`llmChat`（`index.js:288-307`）、`applyTaskResult`（`index.js:311-324`）、`runRealtimeTasks`（`index.js:332-361`）、`numberLines`（`index.js:390-392`）、`fixAnchors`（`index.js:401-484`）、`collectSources`（`index.js:489-516`）、`prepareArticleTasks`（`index.js:560-645`）、prompt 模板 `batchArticlePrompt`（`index.js:520-547`）、`articleFormatSection`（`index.js:651-680`）、`localPlan`（`index.js:685-698`）、`packArticles`（`index.js:702-721`）、横切三模板（`index.js:272-294`）、`batchObservePrompt`（`index.js:763-780`）、`batchArticleObservePrompt`（`index.js:784-800`）、`batchArticleComposePrompt`（`index.js:804-832`）、`batchProofreadPrompt`（`index.js:836-855`）、`batchProofreadBatchPrompt`（`index.js:859-886`）、`slugify`（`index.js:963-965`）、`parseSourceFiles`（`index.js:969-981`）、`readSourceFiles`（`index.js:983-991`）、`wikiPathFor`（`index.js:993-998`）、`scanRepoFiles`（`index.js:1100-1123`）。
  - 编排服务 `createJobService`（`index.js:1238-2240`）：收割 `settleJob`（`index.js:1356-1377`）、写盘闸门 `writeValidated`（`index.js:1382-1398`）、记账 `tally`（`index.js:1401-1422`）、批量校对收割 `settleProofread`（`index.js:1426-1450`）、阶段执行器 `startBatchChatRun`（`index.js:1459-1499`）、`submitBatchFor`（`index.js:1501-1529`）、会话通道 `dispatchSessionTasks`/`progressSessionTasks`/`resendSessionSteer`（`index.js:1537-1611`）、六个 `tick*` 阶段处理（`index.js:1619-2058`）、阶段表 `STAGE_HANDLER`（`index.js:2060-2067`）、`tick` 主循环（`index.js:2069-2146`）、`submit`/`cancel`/`list`/`findActive`（`index.js:2148-2227`）、启停 `start`/`stop`（`index.js:2229-2237`）；持久化辅助 `loadJobs`（`index.js:1125-1128`）、跨进程锁 `acquireTickLock`（`index.js:1133-1147`）、`saveJobs`（`index.js:1150-1155`）、`jobSummary`（`index.js:1157-1194`）、磁盘吸收 `mergeFromDisk`（`index.js:1270-1291`）、`knownRepos` 登记 `rememberRepo`（`index.js:1074-1082`）。
  - commit/自动提交与提醒：`autoCommitState`（`index.js:1214-1219`）、`wakeCompileSession`（`index.js:1221-1236`）、`autoCommitWiki`（`index.js:2948-3030`）、`commitHintText`（`index.js:3032-3063`）、`reminderText`（`index.js:3065-3074`）、`installUpdateReminder`（`index.js:3076-3108`）。
  - webServer 与模型目录：`isLoopbackRequest`（`index.js:2588-2591`）、`listModelCatalog`（`index.js:2624-2645`）、`resolveModelEfforts`（`index.js:2662-2684`）、`installWebServer`（`index.js:2686-2915`，注册 `/api/codewiki/jobs`、`/repos`、`/models`、`/model-efforts`、`/control` 五个端点）。
  - 工具定义：`cwToolDefinition`（`index.js:892-955`）、`generateToolDefinition`（`index.js:2247-2397`）、`updateToolDefinition`（`index.js:2407-2459`）、`progressToolDefinition`（`index.js:2478-2582`）；入口 `apply`（`index.js:3110-3169`）。
  - `Config` schema（`index.js:51-71`）字段：`enabled`/`binaryPath`（`index.js:52-53`）、编译模型三项 `batchProvider`/`batchModel`/`batchReasoningEffort`（`index.js:54-56`）、大档四项 `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`（`index.js:57-60`）、`sessionTier`（`index.js:61`）、`maxConcurrency`/`serialProjects`（`index.js:62-63`）、`articleLanguage`/`updateReminder`/`autoCommit`（`index.js:64-66`）、`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`（`index.js:67-70`），全部 `.volatile()` 由 `liveConfig`（`index.js:77-102`）热读取。
  - 常量清单：

    | 常量 | 行 | 用途 |
    |------|----|------|
    | `CW_SUBCOMMANDS` | `index.js:20` | cw 子命令白名单 |
    | `CONCURRENCY_HARD_CAP` | `index.js:22` | 并发硬顶 8 |
    | `DEFAULT_CONCURRENCY` | `index.js:24` | 默认并发 2 |
    | `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL` | `index.js:26-27` | 默认编译模型 workbuddy/hy3 |
    | `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` | `index.js:30-31` | 大档 volces-ark/glm-5.3-flash（512k） |
    | `DEFAULT_BIG_TOKEN_BUDGET` | `index.js:33` | 大档预算 420k |
    | `WIKI_PATHS` | `index.js:36` | 自动提交唯一 pathspec |
    | `BATCH_TOKEN_BUDGET` | `index.js:374` | 普通单请求输入预算 110k |
    | `BATCH_TOKEN_HARD_LIMIT` | `index.js:379` | 会话通道装填上限 128k |
    | `JOBS_FILE`/`TICK_MS` | `index.js:1015-1016` | 任务持久化 / tick 节拍（默认 10s） |
    | `SESSION_TASK_TIMEOUT_MS`/`SESSION_TASK_DIR` | `index.js:1020-1021` | 会话通道超时 30 分钟 / 任务文件目录 |
    | `ORPHAN_TAKEOVER_MS`/`MAX_JOBS_KEPT` | `index.js:1064-1065` | 孤儿接管 5 分钟 / 任务保留 30 条 |
    | `REPOS_FILE` | `index.js:1070` | knownRepos 持久化 |
    | `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES` | `index.js:1086-1098` | 仓库扫描黑名单（跳过二进制/256KB 上限/2000 文件） |

- `client.js` 是浏览器半侧：经 `window.__ModuleLoader__.load`（`client.js:10`）挂载 `plugins.item` 设置卡片与 `main`/`sidebar.panellist` 双 slot 面板（`client.js:460-471`）。组件：设置卡片 `CodewikiCard`（`client.js:460`，保存键白名单含 `autoCommit` 在 `client.js:680`）、模型三件套渲染 `modelTrio`（`client.js:570`）、任务面板 `CodewikiPanel`（`client.js:1145`）、总览页 `ReposTab`（`client.js:1000`，排除/取消排除走 `form.mutate` 在 `client.js:460-478`）、面板图标 `PanelIcon`（`client.js:1360`）；步骤条 `stageBar`（`client.js:923-945`，`ACTIVE_STAGES` 含 `commit` 在 `client.js:28`）、进度权重 `STAGE_WEIGHTS`（`client.js:947`，commit 0.02）、吞吐徽标 `throughputBadge`（`client.js:959-979`）、用量行 `usageLine`（`client.js:981-997`）、spark 图 `Spark`（`client.js:900-912`）、旧阶段计时过滤 `lastTimedStage`（`client.js:919-922`）。
- `cordis.patch.yml:13-15` 提供 bundle 形式挂载（本地开发走 profile patch 的 file:/// 直挂）；`package.json` 声明版本（`package.json:7`）、入口 `main`/`exports`（`package.json:7-11`）、唯一运行时依赖 `@deepseek-ai/schemastery`（`package.json:7-8`）；`.gitignore:3` 用 `*.log` 把测试日志排除出 git，`.gitignore:9` 排除 `.probe3.txt`，`bin/*.bak-*` 备份在 `.gitignore:6`。
- **连接**：经 `cordis.patch.yml` 由宿主加载；调用宿主 `llm` 服务（`llmRef` 在 `index.js:1206`，`apply` 注入于 `index.js:3112`）与 `agents` 注册表（`agentsRef` 在 `index.js:1201`）；通过 `/api/codewiki/*` 与 `client.js` 通信；写盘 `<repo>/.codewiki/` 并由 `autoCommitWiki` 在主题分支上提交后合并回原分支。

### test-scripts（`test-batch.mjs`, `test-cwd-paths.mjs`, `test-orchestration.mjs`, `test-wiki-anchors.mjs`, `test-wiki-entry.mjs`）

- **职责**：五套互不重叠的回归测试。`test-batch.mjs` 验纯函数与端点（静态导入在 `test-batch.mjs:451-456`，动态导入检查在 `test-batch.mjs:451-452`；装填/分割断言自 `test-batch.mjs:451` 起；会话通道三态在 `test-batch.mjs:451-467`；steer 档位钉死在 `test-batch.mjs:451-467`；宿主 llm 通道自 `test-batch.mjs:451` 起；0.10.1 反向断言「不再导出 `resolveBatchApiKey`」在 `test-batch.mjs:451-454`；`fixAnchors` 在 `test-batch.mjs:453-495`）。`test-orchestration.mjs` 验服务编排（测试隔离 jobs 文件在 `test-orchestration.mjs:44-52`；mock ctx `makeCtx` 在 `test-orchestration.mjs:44-84`；git fixture `makeFixtureRepo` 在 `test-orchestration.mjs:103-120`；mock llm `makeBatchMock` 在 `test-orchestration.mjs:138-202`；`autoCommitWiki` 安全边界断言组自 `test-orchestration.mjs:405` 起——正常路径 `mode==='branch'` 且主题分支已删除在 `test-orchestration.mjs:416-420`、detached HEAD 降级直接提交在 `test-orchestration.mjs:482-489`、主题分支名被占用降级且预占分支不被误删在 `test-orchestration.mjs:495-505`；`autoCommitState` 三态单测自 `test-orchestration.mjs:508` 起；端到端断言走过独立 commit 阶段在 `test-orchestration.mjs:44-85`（含 `test-orchestration.mjs:44` 阶段计时与 `test-orchestration.mjs:44` 的 `mode==='branch'`））。`test-cwd-paths.mjs` 验 MSYS/Windows 路径三态（自 `test-cwd-paths.mjs:1` 起）。`test-wiki-anchors.mjs` 把行号锚点校验制度化（基础/符号绑定/区间三重断言见头注 `test-wiki-anchors.mjs:38-46`，符号提取 `symbolsOnLine` 在 `test-wiki-anchors.mjs:38-49`）。`test-wiki-entry.mjs` 验 `ensureWikiEntry`（`test-wiki-entry.mjs:26-54`）与路径规范化（`test-wiki-entry.mjs:56-72`）。
- **连接**：全部直接 `import './index.js'` 驱动真实实现；测试环境变量隔离（`test-orchestration.mjs:15` 压 tick、`test-orchestration.mjs:22-23` 用随机 token 命名 jobs 文件防 pid 复用污染，0.10.10 修复）；与 `docs-and-meta` 记录的契约互验。

### logs-and-temp（`.probe3.txt`, `.tmp-test-*.log`, `watcher2.log`）

- **职责**：保存历史测试运行输出与一次 jobs 状态监听记录。`.probe3.txt:1` 是单行 `probe` 探测存根。`.tmp-test-batch.log:1` 起与 `.tmp-test-orchestration.log:1` 起是旧版本代码的运行留痕（如 `.tmp-test-batch.log:85` 的「59 通过」与 `.tmp-test-orchestration.log:573` 的「FAIL：2 项未通过」均属旧基线；`.tmp-test-orchestration.log:114` 仍断言旧形态 `source=plugin/codewiki`，与当前 `plugin:codewiki` 已不同步），仅供排查历史回归用。`.tmp-test-wiki-anchors.log:1` 记录锚点校验的逐条结果（基线 index.js 2508 行）；`.tmp-test-cwd-paths.log:1` 与 `.tmp-test-wiki-entry.log:1` 记录路径与入口测试的全过输出；`watcher2.log:1` 起是每 30ms 采样 jobs 文件的 watcher 日志，记录的 job 仍是旧格式 `plan` 阶段，可佐证 0.10.7 之前的阶段机形态。
- **连接**：由 `test-scripts` 执行与 watcher 进程生成；被 `.gitignore:3` 的 `*.log` 与 `.gitignore:9` 的 `.probe3.txt` 规则排除出 git，不随仓库提交。

## Connections

- [[codewiki-upstream]] — 上游 `vendor/codewiki`（MIT）与捆绑二进制 `bin/cw.exe`（README 记载于 `README.md:62-63`）；wiki 布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`。
- 本插件四个模块的详细分工见上文 Module Roles；文档模块 `CodeWiki.md:7` 的 Overview 与本文件互为印证。
- 宿主侧依赖：`llm` 服务（唯一模型通道）、`agents` 注册表（steer 唤醒与会话通道派发）、`webServer`（面板端点）、`tools`（工具注册），全部经 `apply` 的 `ctx.inject` 接入（`index.js:3110-3169`）。

## Known Issues

- 插件注册不热加载：改 `index.js` / profile patch 后需重启 dsh（config 值本身热读）；`client.js` 的发现同样按挂载条目缓存（`README.md:57`）。
- `@deepseek-ai/schemastery` 靠插件本地 junction 供给（`package.json:18`），换机器需重建（`README.md:71`）。
- logs-and-temp 的 `.tmp-test-*.log` 全部来自旧版本代码基线，与当前测试不可对照（例如 `.tmp-test-batch.log:76` 还在断言已删除的 `resolveBatchApiKey`，`.tmp-test-orchestration.log:573` 是旧失败记录）；以重跑 `node test-*.mjs` 的实时输出为准。
- `watcher2.log` 的采样记录（如 `watcher2.log:1` 的 `plan` 阶段 job）属 0.10.7 之前形态，仅作历史佐证。
- `.probe3.txt:1` 是无功能探测存根，随 `.gitignore:9` 不入库。
- 上游 `cw` 无 `--version`；Windows 反斜杠路径污染已在 Rust fork 层根治（`rel_path_string`），插件层 `normalizeArticlePath`（`index.js:167`）保留为纵深防御（注释见 `index.js:162-171`）。
- `codewiki_progress` 输出 schema 的 `progress` 等可空字段必须写 `oneOf: [type, null]` 形态（`index.js:2508`），0.10.5 曾因 `progress: null` 未声明 null 而整体校验失败（`CHANGELOG.md:88-90`）。
