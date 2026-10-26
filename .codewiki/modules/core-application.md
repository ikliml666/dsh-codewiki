---
title: core-application
type: module
source_files:
  - index.js
  - client.js
  - package.json
tags: [CodeWiki, 编译流水线, 阶段机, DeepSeek Harness, 侧边栏面板, React, 宿主llm服务, 大档模型, cw CLI]
---

## Overview

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.13.1"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。

代码分成两半，职责严格分离：

- `index.js`（宿主半侧，行1 起）封装本地 `cw` CLI（`runCw` 见行162-187）、定义 `Config` 配置（行60-86）、实现 `createJobService` 阶段机（行1693-2947），注册四个模型工具（`cwToolDefinition` 行1159-1222 / `generateToolDefinition` 行2954-3166 / `updateToolDefinition` 行3176-3228 / `progressToolDefinition` 行3247-3351），并通过 `installWebServer`（行3455-3750）在回环地址暴露查询与控制端点，插件入口 `apply` 在行3945-4009。
- `client.js`（浏览器半侧，行10 起）经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`CodewikiCard` 行548-1036）和侧边栏面板（`CodewikiPanel` 行1418-1663、`PanelIcon` 行1665-1676），靠轮询而非推送更新界面（轮询间隔 `POLL_MS=2000` 行22，`REPOS_POLL_MS=10000` 行31）。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → `done`（阶段处理函数 `STAGE_HANDLER` 行2738-2745，`tick` 行2747-2833 按 10 秒节拍 `TICK_MS` 行1293 推进一步）。规划阶段已于 0.10.7 删除（`localPlan` 行862-875 本地分组替代，旧 `plan` 阶段在 `tick` 行2811-2818 被迁移到 `articles`）。全部状态落在 `JOBS_FILE`（行1292），因此宿主重启、多实例并存都能靠磁盘快照接管续跑（`acquireTickLock` 行1588-1602，`mergeFromDisk` 行1747-1768）。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行412-437），默认 `workbuddy/hy3`（192k 上下文，行35-36），单请求输入预算 110k（`BATCH_TOKEN_BUDGET` 行541）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行39-40，预算 420k，行42），仍装不下才转会话通道兜底（`dispatchSessionTasks` 在行2131-2165）。编译产物自提交在 0.10.11 起独立成 `commit` 阶段（`tickCommit` 行2720-2736），走主题分支合并式（`autoCommitWiki` 行3783-3865）。

## Key Components

### package.json（行1-28）
- `name`：行2，`"@local/dsh-codewiki"`，插件注册 id（client.js `load` 的 `id` 行11须与此一致）；`NS`（行17 client.js）/`KEY`（行18 client.js）为设置命名空间与面板 key，默认 `'codewiki'`。
- `version`：行3，`"0.13.1"`。
- `private` / `type`：行5-6，私有模块、ESM。
- `exports`：行8-11，`.` 指向 `index.js`，`./client` 指向 `client.js`。
- `dsh.client.platform`：行21-23，固定 `web`。
- `dsh.bundle.patch`：行24-26，指向 `cordis.patch.yml`。
- `dependencies`：行17-19，仅 `@deepseek-ai/schemastery "^3.18.4"`。

### index.js — 配置与基础层（行27-386）
- `PLUGIN_NAME`：行27，`'dsh-codewiki'`，同时 `export const name` 行28。
- `CW_SUBCOMMANDS`：行29，白名单 `['init','status','index','meta','path','projects','setup','uninstall']`。
- `CONCURRENCY_HARD_CAP`：行31，硬顶 `8`。
- 默认常量：行33-42，`DEFAULT_CONCURRENCY`(行33)、`DEFAULT_BATCH_PROVIDER`(行35)、`DEFAULT_BATCH_MODEL`(行36)、`DEFAULT_BIG_PROVIDER`(行39)、`DEFAULT_BIG_MODEL`(行40)、`DEFAULT_BIG_TOKEN_BUDGET`(行42)。
- `WIKI_PATHS`：行45，`['.codewiki', 'CodeWiki.md']`，自动提交唯一 pathspec。
- `Config`：行60-86，`z.object` 共 25 个 `.volatile()` 字段：`enabled`(行61)、`binaryPath`(行62)、`batchProvider`(行63)、`batchModel`(行64)、`batchReasoningEffort`(行65)、`bigProvider`(行66)、`bigModel`(行67)、`bigReasoningEffort`(行68)、`bigTokenBudget`(行69)、`sessionTier`(行70)、`maxConcurrency`(行71)、`bigConcurrency`(行72)、`serialProjects`(行73)、`parallelProjects`(行74)、`articleLanguage`(行75)、`planMode`(行76)、`agenticArticles`(行77)、`agenticMaxSteps`(行78)、`symbolIncremental`(行79)、`updateReminder`(行80)、`autoCommit`(行81)、`excludePaths`(行82)、`autoUpdate`(行83)、`autoUpdateMin`(行84)、`workspaceOnly`(行85)。
- `liveConfig(config)`：行92-134，折算运行时值，并发钳 `[1,8]`（行107-109）、`autoUpdateMin` 下限5（行130）、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行105）。
- `normalizeCwd(input)`：行49-54，仅 win32 将 `/e/...` 归一 `E:/...`。
- `resolveBinary(cfg)`：行140-160，顺序：配置 `binaryPath` → PATH `cw` → 插件 `bin/cw(.exe)` → 裸 `'cw'`。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行162-187，`spawn` 收集输出，超时/abort 发 `SIGKILL`，返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `parseStatus(stdout)`：行213-226，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing/uncompiled/clean/stale`。
- `ensureWikiEntry(cwd, language='中文')`：行246-279，缺 `CodeWiki.md` 时按语言生成入口，已存在不覆盖。
- `detectLinkedWorktree` / `isWorktreeCwd`：行309-325、行333-344，用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree，命中不给 worktree 编译。
- `hasCompilableSources` 行352-366、`isDeadCompileTarget` 行378-386，排除空壳/残留目录。

### index.js — 模型通道与执行器（行394-528）
- `estimateTokens(text)`：行394-402，CJK 1 token/字，其余 3.5 字符/token。
- `BATCH_TOKEN_BUDGET`：行541，`110000` 单请求输入预算；`BATCH_TOKEN_HARD_LIMIT` 行546，`128000` 超预算兜底装填上限。
- `llmChat({llm,provider,model,reasoningEffort,prompt,signal,onDelta})`：行412-437，唯一模型通道，走宿主 `llm.stream` + `BlockAssembler`，`temperature:0`，来源 `plugin:codewiki`；不支持的 effort 自动重试（行426-429）。
- `runRealtimeTasks(tasks, {...})`：行469-528（`export`），唯一并发执行器，按 `maxConcurrency` 分池（默认档/大档）消费队列，返回 `Map(customId→{ok,stopReason,content?})`，支持 `onRequestStart` 挂钩会话记录。

### index.js — 源码装填与任务装配（行557-965）
- `numberLines(content)`：行557-559，每行加 `N| ` 前缀。
- `fixAnchors(content, cwd)`：行568-651（`export`），落盘前第四层锚点校正，只改行号数字。
- `collectSources(cwd, files, budget)`：行656-683（`export`），整文件内联，返回 `{text,skipped,oversized}`。
- `prepareArticleTasks(tasks, {...})`：行727-812（`export`），三级降级装配（普通档/大档/会话兜底），返回 `{prepared,sessionTasks}`。
- `articleFormatSection()`：行818-847，文章格式唯一条款来源（frontmatter+章节）。
- `localPlan(files)`：行862-875（`export`），本地顶层目录分组规划（0.10.7 起唯一规划路径）。
- `semanticPlan(files, {...})`：行884-965（`export`），AST 符号提取 + LLM 语义聚类，失败退回 `localPlan`。
- 横切/校对模板：`batchArchitecturePrompt` 行1004-1010、`batchPatternsPrompt` 行1012-1018、`batchConceptPrompt` 行1020-1026、`batchObservePrompt` 行1030-1047、`batchArticleObservePrompt` 行1051-1067、`batchArticleComposePrompt` 行1071-1099、`batchProofreadPrompt` 行1103-1122、`batchProofreadBatchPrompt` 行1126-1153。

### index.js — 服务与工具（行1159-4009）
- `cwToolDefinition` 行1159-1222、`generateToolDefinition` 行2954-3166、`updateToolDefinition` 行3176-3228、`progressToolDefinition` 行3247-3351，四个工具定义。
- `createJobService(config, onSettled)` 行1693-2947：核心服务，内含 `submit`(行2835-2920)、`cancel`(行2922-2931)、`tick`(行2747-2833)、阶段处理 `tickArticles`/`tickCrosscut`/`tickCompose`/`tickReview`/`tickIndex`/`tickCommit` 及 `STAGE_HANDLER`(行2738-2745)。
- `installWebServer` 行3455-3750：回环端点 `/api/codewiki/jobs`、`/repos`、`/sessions`、`/models`、`/model-efforts`、`/control`。
- `autoCommitWiki` 行3783-3865：主题分支提交后合并回原分支。
- `commitHintText` 行3867-3898、`reminderText` 行3900-3909、`installUpdateReminder` 行3911-3943：系统提示提醒注入。
- `apply(ctx, config)` 行3945-4009：插件入口，注册工具、启动服务、挂载面板。

### client.js — 浏览器半侧（行10-1680）
- 常量：`NS` 行17、`KEY` 行18、`JOBS_PATH` 行19、`POLL_MS` 行22、`REPOS_PATH` 行23、`SESSIONS_PATH` 行24、`MODELS_PATH` 行26、`EFFORTS_PATH` 行27、`REPOS_POLL_MS` 行31、`ACTIVE_STAGES` 行33。
- 词典 `zh`/`en` 行35-384，样式注入行386-483。
- `apiGet`/`apiPost` 行489-504。
- `CodewikiCard` 行548-1036：设置表单，含模型目录联动、思考档位拉取（`useEfforts` 行620-651）、保存校验。
- `ReposTab` 行1177-1320：总览标签页，仓库 wiki 状态与调度信息。
- `SessionView` 行1326-1416：LLM 请求会话记录查看。
- `CodewikiPanel` 行1418-1663：侧边栏面板，任务进度、步骤条、吞吐徽标、取消按钮。
- `PanelIcon` 行1665-1676：面板图标。

## Architecture

```text
┌─────────────────┐   GET/POST /api/codewiki/* (loopback)   ┌────────────────────┐
│  client.js      │ ───────────────────────────────────────► │  index.js          │
│  CodewikiPanel  │ ◄──────────── JSON jobs/repos ─────────── │  installWebServer  │
│  ReposTab       │                                           │  createJobService  │
│  SessionView    │                                           │   ├ submit()       │
└─────────────────┘                                           │   ├ tick() 10s     │
                                                             │   └ STAGE_HANDLER  │
                                                             │      articles→     │
                                                             │      crosscut→     │
                                                             │      review→index→ │
                                                             │      commit→done   │
                                                             └─────────┬──────────┘
                                                                       │ llmChat()
                                                                       ▼
                                                             ┌────────────────────┐
                                                             │ 宿主 llm 服务       │
                                                             │ workbuddy/hy3      │
                                                             │ volces-ark/glm-5.3 │
                                                             └────────────────────┘
```

## Data Flow

1. 会话模型调用 `codewiki_generate`（行2954）→ `svc.submit`（行2835）判态并提交 job，立即返回。
2. `tick`（行2747）每 10s 唤醒，按 `parallelLimit` 闸门推进活跃 job（行2758-2770）。
3. 阶段 `articles`：`prepareArticleTasks`（行727）装填源码 → `startBatchChatRun`（行1967）经 `runRealtimeTasks`（行469）调 `llmChat`（行412）写文章。
4. `crosscut`/`review`：横切与校对 prompt 经同一并发池，结果 `writeValidated`（行1868）落盘前校验 frontmatter。
5. `index`：`runCw('index')` + `runCw('meta','update')` 更新索引与基线（行2663-2674）。
6. `commit`：`autoCommitWiki`（行3783）在主题分支提交 `.codewiki/` 与 `CodeWiki.md` 后合并回原分支（行2720-2736）。
7. 面板通过 `GET /api/codewiki/jobs` 轮询进度，不阻塞编译。

## Connections

- [[cw-cli-wrapper]] — `runCw` 与 `cwToolDefinition` 封装的本地 CLI 边界
- [[compile-pipeline]] — `createJobService` 阶段机与 `STAGE_HANDLER` 编排
- [[agentic-writing]] — `agenticArticles` 开关与 `runAgenticArticles` 通道
- [[session-records]] — `beginSessionRecord` 与 client.js `SessionView` 的数据底座
- [[model-catalog]] — `listModelCatalog` / `resolveModelEfforts` 与设置页联动

## Known Issues

- **linked worktree 不编译**：`detectLinkedWorktree`（行309-325）在 `submit` 与 `generateToolDefinition` 双闸门拦截，避免主仓库与 worktree 产物互覆盖（行2843-2848）。
- **空壳目录不编译**：`hasCompilableSources`（行352-366）扫描不到源码时拒绝提交，防止自动调度反复生成失败任务（行2854-2858）。
- **超大文件转会话通道**：单文件超 `BATCH_TOKEN_HARD_LIMIT` 且未配大档时，`prepareArticleTasks` 标 `sessionTasks`（行770），由发起会话派子智能体兜底（行2131-2165）。
- **行号锚点漂移**：弱模型自数行易错，`fixAnchors`（行568-651）在落盘前确定性校正 `file:NN` 锚点，但符号歧义时仅记录不强制改（行637-639）。
- **旧任务阶段迁移**：0.10.7 前残留 `plan` 阶段任务在 `tick` 中被强制迁到 `articles`（行2811-2818），不可重跑旧规划快照。
