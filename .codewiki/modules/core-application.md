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

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.14.0"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `.` 与 `./client` 两个入口分别对应 `./index.js` 与 `./client.js`（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。0.13.0 起吸收 FSoft-AI4Code/CodeWiki 的 AST 符号提取、LLM 语义聚类、agentic 写作与符号级增量（`package.json` 行4 的 `description`；实现见 `semanticPlan` 行1322-1405、`startAgenticRun` 行2676-2726、符号快照比对见 `tickIndex` 中行3420-3444）。

代码分成两半，职责严格分离：

- `index.js`（宿主半侧）：封装本地 `cw` CLI（`runCw` 行162-197）、定义 `Config` 配置（行70-96）、实现 `createJobService` 阶段机（行2295-3707），注册四个模型工具（`cwToolDefinition` 行1599-1662 / `generateToolDefinition` 行3714-4038 / `updateToolDefinition` 行4048-4100 / `progressToolDefinition` 行4119-4223），并通过 `installWebServer`（行4327-4622）在回环地址暴露查询与控制端点，插件入口 `apply` 在行4817-4881。
- `client.js`（浏览器半侧，行10 起）经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`CodewikiCard` 行548-1036）和侧边栏面板（`CodewikiPanel` 行1418-1663、`PanelIcon` 行1665-1676），靠轮询而非推送更新界面（轮询间隔 `POLL_MS=2000` 行22，`REPOS_POLL_MS=10000` 行31）。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → `done`（`STAGE_HANDLER` 行3482-3489，`tick` 行3491-3577 按 10 秒节拍 `TICK_MS` 行1877 推进）。规划阶段已于 0.10.7 删除（`localPlan` 行1300-1313 本地分组替代，旧 `plan` 阶段在 `tick` 行3555-3562 被迁移到 `articles`）。全部状态落在 `JOBS_FILE`（行1876），因此宿主重启、多实例并存都能靠磁盘快照接管续跑（`acquireTickLock` 行2182-2196，`mergeFromDisk` 行2349-2370）。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行467-492），默认 `workbuddy/hy3`（192k 上下文，行44-45），单请求输入预算 110k（`BATCH_TOKEN_BUDGET` 行663）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行49-50，预算 420k，行52），仍装不下才转会话通道兜底（`dispatchSessionTasks` 在行2797-2831）。编译产物自提交在 0.10.11 起独立成 `commit` 阶段（`tickCommit` 行3465-3480），走主题分支合并式（`autoCommitWiki` 行4655-4737）。

## Key Components

### package.json（行1-29）

- `name`：行2，`"@local/dsh-codewiki"`，插件注册 id（client.js `load` 的 `id` 行11须与此一致）；`NS`（行17 client.js）/`KEY`（行18 client.js）为设置命名空间与面板 key，默认 `'codewiki'`。
- `version`：行3，`"0.14.0"`。
- `private` / `type` / `license`：行5-6、行12，私有模块、ESM、MIT。
- `exports`：行8-11，`.` 指向 `index.js`（行9），`./client` 指向 `client.js`（行10）。
- `engines`：行13-16，node `>=20`（行14）、dsh `>=0.2.0-rc.0`（行15）。
- `dsh.client.platform`：行21-23，固定 `web`。
- `dsh.bundle.patch`：行24-26，指向 `cordis.patch.yml`。
- `dependencies`：行17-19，仅 `@deepseek-ai/schemastery "^3.18.4"`。

### index.js — 配置与基础层（行37-441）

- `PLUGIN_NAME`：行37，`'dsh-codewiki'`，同时 `export const name` 行38。
- `CW_SUBCOMMANDS`：行39，白名单 `['init','status','index','meta','path','projects','setup','uninstall']`。
- `CONCURRENCY_HARD_CAP`：行41，硬顶 `8`。
- 默认常量：行43-52，`DEFAULT_CONCURRENCY`(行43)、`DEFAULT_BATCH_PROVIDER`(行44)、`DEFAULT_BATCH_MODEL`(行45)、`DEFAULT_BIG_PROVIDER`(行49)、`DEFAULT_BIG_MODEL`(行50)、`DEFAULT_BIG_TOKEN_BUDGET`(行52)。
- `WIKI_PATHS`：行55，`['.codewiki', 'CodeWiki.md']`，自动提交唯一 pathspec。
- `Config`：行70-96，`z.object` 共 25 个 `.volatile()` 字段：`enabled`(行71)、`binaryPath`(行72)、`batchProvider`(行73)、`batchModel`(行74)、`batchReasoningEffort`(行75)、`bigProvider`(行76)、`bigModel`(行77)、`bigReasoningEffort`(行78)、`bigTokenBudget`(行79)、`sessionTier`(行80)、`maxConcurrency`(行81)、`bigConcurrency`(行82)、`serialProjects`(行83)、`parallelProjects`(行84)、`articleLanguage`(行85)、`planMode`(行86)、`agenticArticles`(行87)、`agenticMaxSteps`(行88)、`symbolIncremental`(行89)、`updateReminder`(行90)、`autoCommit`(行91)、`excludePaths`(行92)、`autoUpdate`(行93)、`autoUpdateMin`(行94)、`workspaceOnly`(行95)。
- `val(x)` 行98-100 与 `liveConfig(config)`：行102-144，折算运行时值，`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行115）、并发钳 `[1,8]`（行117-119、行121-123）、`parallelLimit` 串行时强制 1（行125-129）、`autoUpdateMin` 下限5（行140）。
- `normalizeCwd(input)`：行59-64，仅 win32 将 `/e/...` 归一 `E:/...`。
- `resolveBinary(cfg)`：行150-170，顺序：配置 `binaryPath`（行151）→ PATH `where`/`which` 探测（行154-165）→ 插件 `bin/cw(.exe)`（行167-168）→ 裸 `'cw'`（行169）。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行162-197，`spawn` 收集输出，超时/abort 发 `SIGKILL`（行178-182），返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `normalizeArticlePath(p)` 行209（export，`\`→`/`）、`normalizeIndexLinks(cwd)` 行213-221（export，修正 `_index.md` 链接头）。
- `parseStatus(stdout)`：行223-236，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing`(行225)/`uncompiled`(行226)/`clean`(行227)/`stale`(行235)。
- `countWikiArticles(wikiPath)`：行239-251，递归统计 `.codewiki/` 下 `.md` 篇数（总览卡用）。
- `ensureWikiEntry(cwd, language='中文')`：行301-334，缺 `CodeWiki.md` 时按语言生成入口（中文模板行307-318，英文行320-331），已存在不覆盖。
- `excludedItem` 行339-348 / `isExcluded` 行349-351：排除清单判定（换行/分号/逗号分隔，Windows 大小写不敏感）。
- `detectLinkedWorktree`：行364-380（export），用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree（行367-379）；`WORKTREE_CACHE_TTL_MS` 60s（行385）、`isWorktreeCwd` 行388-399（export，带缓存版）。
- `hasCompilableSources` 行407-421（export，10 分钟探测缓存 `SOURCE_PROBE_TTL_MS` 行405）、`clearSourceProbeCache` 行423-426（export，手动编译前清缓存）、`isDeadCompileTarget` 行433-441（export，worktree 或无源码即死对象；目录不存在不算 dead）。

### index.js — 模型通道与执行器（行449-668）

- `estimateTokens(text)`：行449-457（export），CJK 1 token/字，其余 3.5 字符/token。
- `llmChat({llm,provider,model,reasoningEffort,prompt,signal,onDelta})`：行467-492，唯一模型通道，走宿主 `llm.stream` + `BlockAssembler`（行468-479），`temperature:0`（行474），来源 `plugin:codewiki`（行473）；模型不支持配置的 effort 时剥档重试一次（行481-484）；失败统一抛错（行486-487）。
- `applyTaskResult(task, content, notes)`：行553-576，`keepInMemory` 任务回内存、文章任务经 `fixAnchors` 后落盘（行567-570）。
- `runRealtimeTasks(tasks, {...})`：行591-650（export），唯一并发执行器，按任务 `bigTier` 标记分池（行596-611）——默认档/大档各自独立限流；每任务可带自己的 `provider/model/reasoningEffort`（行623-631）；`onTaskDone` 上报 `{outputTokens,durationMs}` 供 tps 采样（行636）；`onRequestStart` 挂钩会话记录（行620）；返回 `Map(customId→{ok,stopReason,content?})`（行649）。
- `BATCH_TOKEN_BUDGET`：行663，`110000` 单请求输入预算；`BATCH_TOKEN_HARD_LIMIT` 行668，`128000` 超预算兜底装填上限。

### index.js — 源码装填与任务装配（行679-1593）
- `numberLines(content)`：行679-681（export），每行加 `N| ` 前缀。
- `fixAnchors(content, cwd)`：行856-1073（export），落盘前第四层锚点校正（frontmatter 解析行865-874、`symbolsOnLine` 行923、声明形态消歧行969-987），只改行号数字。
- `collectSources(cwd, files, budget)`：行1094-1121（export），整文件内联不做半文件截断（行1107），返回 `{text,skipped,oversized}`。
- `batchArticlePrompt`：行1125-1152，单轮文章 prompt（旧文行号禁用条款行1138）。
- `prepareArticleTasks(tasks, {...})`：行1165-1250（export），三级降级装配（普通档/大档/会话兜底）：大档判定行1169-1176、`markBig` 行1177-1185、单请求直出 `emitSingle` 行1196-1202、`emitSession` 行1203-1207、单文件连大档都装不下转会话（行1208、1227）、超限拆观察批（行1214-1245），返回 `{prepared,sessionTasks}`。
- `articleFormatSection()`：行1256-1285，文章格式唯一条款来源（frontmatter+六章节）。
- `shouldFallBackFromAgentic(results)`：行1293-1298（export），agentic 批次失败过半才算系统性失败。
- `localPlan(files)`：行1300-1313（export），本地顶层目录分组规划（0.10.7 起唯一兜底规划路径）。
- `semanticPlan(files, {...})`：行1322-1405（export），AST 符号提取（`extractRepoGraph` 行1341） + 依赖边（`resolveImportEdges` 行1358） + LLM 语义聚类（`clusterComponents` 行1369）；plan 持久化 tree/graph 但**不带** sourceCode（行1384-1397），失败退回 `localPlan`（行1343-1350、1371-1372、1401-1402）。
- `packArticles(articles, budget)`：行1409-1428，横切输入装填（超预算截头部行1416-1422）。
- 横切/校对模板：`crosscutIntro` 行1430-1442、`batchArchitecturePrompt` 行1444-1450、`batchPatternsPrompt` 行1452-1458、`batchConceptPrompt` 行1460-1466、`batchObservePrompt` 行1470-1487（横切观察）、`batchArticleObservePrompt` 行1491-1507（分割观察）、`batchArticleComposePrompt` 行1511-1539（分割合成）、`batchProofreadPrompt` 行1543-1562、`batchProofreadBatchPrompt` 行1566-1593（`@@@article:`/`
