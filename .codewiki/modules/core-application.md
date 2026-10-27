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

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.13.4"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。0.13.0 起吸收 FSoft-AI4Code/CodeWiki 的 AST 符号提取、LLM 语义聚类、agentic 写作与符号级增量（`package.json` 行4 的 `description`；实现见 `semanticPlan` 行884-967、`startAgenticRun` 行2023-2070、符号快照比对行2702-2723）。

代码分成两半，职责严格分离：

- `index.js`（宿主半侧）：封装本地 `cw` CLI（`runCw` 行162-187）、定义 `Config` 配置（行60-86）、实现 `createJobService` 阶段机（行1695-2971），注册四个模型工具（`cwToolDefinition` 行1161-1224 / `generateToolDefinition` 行2978-3190 / `updateToolDefinition` 行3200-3252 / `progressToolDefinition` 行3271-3375），并通过 `installWebServer`（行3479-3774）在回环地址暴露查询与控制端点，插件入口 `apply` 在行3969-4033。
- `client.js`（浏览器半侧，行10 起）经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`CodewikiCard` 行548-1036）和侧边栏面板（`CodewikiPanel` 行1418-1663、`PanelIcon` 行1665-1676），靠轮询而非推送更新界面（轮询间隔 `POLL_MS=2000` 行22，`REPOS_POLL_MS=10000` 行31）。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → `done`（`STAGE_HANDLER` 行2762-2769，`tick` 行2771-2857 按 10 秒节拍 `TICK_MS` 行1295 推进）。规划阶段已于 0.10.7 删除（`localPlan` 行862-875 本地分组替代，旧 `plan` 阶段在 `tick` 行2835-2842 被迁移到 `articles`）。全部状态落在 `JOBS_FILE`（行1294），因此宿主重启、多实例并存都能靠磁盘快照接管续跑（`acquireTickLock` 行1590-1604，`mergeFromDisk` 行1749-1770）。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行412-437），默认 `workbuddy/hy3`（192k 上下文，行35-36），单请求输入预算 110k（`BATCH_TOKEN_BUDGET` 行541）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行39-40，预算 420k，行42），仍装不下才转会话通道兜底（`dispatchSessionTasks` 在行2141-2175）。编译产物自提交在 0.10.11 起独立成 `commit` 阶段（`tickCommit` 行2744-2760），走主题分支合并式（`autoCommitWiki` 行3807-3889）。

## Key Components

### package.json（行1-29）

- `name`：行2，`"@local/dsh-codewiki"`，插件注册 id（client.js `load` 的 `id` 行11须与此一致）；`NS`（行17 client.js）/`KEY`（行18 client.js）为设置命名空间与面板 key，默认 `'codewiki'`。
- `version`：行3，`"0.13.4"`。
- `private` / `type` / `license`：行5-6、行12，私有模块、ESM、MIT。
- `exports`：行8-11，`.` 指向 `index.js`（行9），`./client` 指向 `client.js`（行10）。
- `engines`：行13-16，node `>=20`（行14）、dsh `>=0.2.0-rc.0`（行15）。
- `dsh.client.platform`：行21-23，固定 `web`。
- `dsh.bundle.patch`：行24-26，指向 `cordis.patch.yml`。
- `dependencies`：行17-19，仅 `@deepseek-ai/schemastery "^3.18.4"`。

### index.js — 配置与基础层（行1-386）

- `PLUGIN_NAME`：行27，`'dsh-codewiki'`，同时 `export const name` 行28。
- `CW_SUBCOMMANDS`：行29，白名单 `['init','status','index','meta','path','projects','setup','uninstall']`。
- `CONCURRENCY_HARD_CAP`：行31，硬顶 `8`。
- 默认常量：行33-42，`DEFAULT_CONCURRENCY`(行33)、`DEFAULT_BATCH_PROVIDER`(行35)、`DEFAULT_BATCH_MODEL`(行36)、`DEFAULT_BIG_PROVIDER`(行39)、`DEFAULT_BIG_MODEL`(行40)、`DEFAULT_BIG_TOKEN_BUDGET`(行42)。
- `WIKI_PATHS`：行45，`['.codewiki', 'CodeWiki.md']`，自动提交唯一 pathspec。
- `Config`：行60-86，`z.object` 共 25 个 `.volatile()` 字段：`enabled`(行61)、`binaryPath`(行62)、`batchProvider`(行63)、`batchModel`(行64)、`batchReasoningEffort`(行65)、`bigProvider`(行66)、`bigModel`(行67)、`bigReasoningEffort`(行68)、`bigTokenBudget`(行69)、`sessionTier`(行70)、`maxConcurrency`(行71)、`bigConcurrency`(行72)、`serialProjects`(行73)、`parallelProjects`(行74)、`articleLanguage`(行75)、`planMode`(行76)、`agenticArticles`(行77)、`agenticMaxSteps`(行78)、`symbolIncremental`(行79)、`updateReminder`(行80)、`autoCommit`(行81)、`excludePaths`(行82)、`autoUpdate`(行83)、`autoUpdateMin`(行84)、`workspaceOnly`(行85)。
- `val(x)` 行88-90 与 `liveConfig(config)`：行92-134，折算运行时值，`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行105）、并发钳 `[1,8]`（行107-109、行111-113）、`parallelLimit` 串行时强制 1（行115-119）、`autoUpdateMin` 下限5（行130）。
- `normalizeCwd(input)`：行49-54，仅 win32 将 `/e/...` 归一 `E:/...`。
- `resolveBinary(cfg)`：行140-160，顺序：配置 `binaryPath`（行141）→ PATH `where`/`which` 探测（行146-155）→ 插件 `bin/cw(.exe)`（行157-158）→ 裸 `'cw'`（行159）。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行162-187，`spawn` 收集输出，超时/abort 发 `SIGKILL`（行168-173），返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `normalizeArticlePath(p)` 行199（export，`\`→`/`）、`normalizeIndexLinks(cwd)` 行203-211（export，修正 `_index.md` 链接头）。
- `parseStatus(stdout)`：行213-226，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing`(行215)/`uncompiled`(行216)/`clean`(行217)/`stale`(行218-225)。
- `countWikiArticles(wikiPath)`：行229-241，递归统计 `.codewiki/` 下 `.md` 篇数（总览卡用）。
- `ensureWikiEntry(cwd, language='中文')`：行246-279，缺 `CodeWiki.md` 时按语言生成入口（中文模板行252-263，英文行265-276），已存在不覆盖。
- `excludedItem` 行284-293 / `isExcluded` 行294-296：排除清单判定（换行/分号/逗号分隔，Windows 大小写不敏感）。
- `detectLinkedWorktree`：行309-325（export），用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree（行313-323）；`WORKTREE_CACHE_TTL_MS` 60s（行330）、`isWorktreeCwd` 行333-344（export，带缓存版）。
- `hasCompilableSources` 行352-366（export，10 分钟探测缓存 `SOURCE_PROBE_TTL_MS` 行350）、`clearSourceProbeCache` 行368-371（export，手动编译前清缓存）、`isDeadCompileTarget` 行378-386（export，worktree 或无源码即死对象；目录不存在不算 dead）。

### index.js — 模型通道与执行器（行388-546）

### index.js — 模型通道与执行器（行388-546）

### index.js — 源码装填、任务装配与 prompt 构造（行557-1155）

### index.js — 工具：cw 与 codewiki_generate（行1161-3190）

### index.js — 作业服务、阶段机与 HTTP 端点（行1290-3774）

### index.js — 自动提交、提醒注入与 apply 入口（行3789-4034）

### client.js — 浏览器半侧（行1-1681）

## Architecture

## Data Flow

## Connections

## Known Issues

### index.js — 配置与基础层（行27-386）
- `PLUGIN_NAME`：行27，`'dsh-codewiki'`，同时 `export const name` 行28。
- `CW_SUBCOMMANDS`：行29，白名单 `['init','status','index','meta','path','projects','setup','uninstall']`。
- `CONCURRENCY_HARD_CAP`：行31，硬顶 `8`。
- 默认常量：行33-42，`DEFAULT_CONCURRENCY`(行33)、`DEFAULT_BATCH_PROVIDER`(行35)、`DEFAULT_BATCH_MODEL`(行36)、`DEFAULT_BIG_PROVIDER`(行39)、`DEFAULT_BIG_MODEL`(行40)、`DEFAULT_BIG_TOKEN_BUDGET`(行42)。
- `WIKI_PATHS`：行45，`['.codewiki', 'CodeWiki.md']`，自动提交唯一 pathspec。
- `Config`：行60-86，`z.object` 共 25 个 `.volatile()` 字段：`enabled`(行61)、`binaryPath`(行62)、`batchProvider`(行63)、`batchModel`(行64)、`batchReasoningEffort`(行65)、`bigProvider`(行66)、`bigModel`(行67)、`bigReasoningEffort`(行68)、`bigTokenBudget`(行69)、`sessionTier`(行70)、`maxConcurrency`(行71)、`bigConcurrency`(行72)、`serialProjects`(行73)、`parallelProjects`(行74)、`articleLanguage`(行75)、`planMode`(行76)、`agenticArticles`(行77)、`agenticMaxSteps`(行78)、`symbolIncremental`(行79)、`updateReminder`(行80)、`autoCommit`(行81)、`excludePaths`(行82)、`autoUpdate`(行83)、`autoUpdateMin`(行84)、`workspaceOnly`(行85)。
- `val(x)` 行88-90 与 `liveConfig(config)`：行92-134，折算运行时值，`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行105）、并发钳 `[1,8]`（行107-109、行111-113）、`parallelLimit` 串行时强制 1（行115-119）、`autoUpdateMin` 下限5（行130）。
- `normalizeCwd(input)`：行49-54，仅 win32 将 `/e/...` 归一 `E:/...`。
- `resolveBinary(cfg)`：行140-160，顺序：配置 `binaryPath`（行141）→ PATH `where`/`which` 探测（行146-155）→ 插件 `bin/cw(.exe)`（行157-158）→ 裸 `'cw'`（行159）。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行162-187，`spawn` 收集输出，超时/abort 发 `SIGKILL`（行168-173），返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `normalizeArticlePath(p)` 行199（export，`\`→`/`）、`normalizeIndexLinks(cwd)` 行203-211（export，修正 `_index.md` 链接头）。
- `parseStatus(stdout)`：行213-226，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing`(行215)/`uncompiled`(行216)/`clean`(行217)/`stale`(行218-225)。
- `countWikiArticles(wikiPath)`：行229-241，递归统计 `.codewiki/` 下 `.md` 篇数（总览卡用）。
- `ensureWikiEntry(cwd, language='中文')`：行246-279，缺 `CodeWiki.md` 时按语言生成入口（中文模板行252-263，英文行265-276），已存在不覆盖。
- `excludedItem` 行284-293 / `isExcluded` 行294-296：排除清单判定（换行/分号/逗号分隔，Windows 大小写不敏感）。
- `detectLinkedWorktree`：行309-325（export），用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree（行313-323）；`WORKTREE_CACHE_TTL_MS` 60s（行330）、`isWorktreeCwd` 行333-344（export，带缓存版）。
- `hasCompilableSources` 行352-366（export，10 分钟探测缓存 `SOURCE_PROBE_TTL_MS` 行350）、`clearSourceProbeCache` 行368-371（export，手动编译前清缓存）、`isDeadCompileTarget` 行378-386（export，worktree 或无源码即死对象；目录不存在不算 dead）。

### index.js — 模型通道与执行器（行394-546）
- `estimateTokens(text)`：行394-402（export），CJK 1 token/字，其余 3.5 字符/token。
- `llmChat({llm,provider,model,reasoningEffort,prompt,signal,onDelta})`：行412-437，唯一模型通道，走宿主 `llm.stream` + `BlockAssembler`（行413-424），`temperature:0`（行419），来源 `plugin:codewiki`（行418）；模型不支持配置的 effort 时剥档重试一次（行426-429）；失败统一抛错（行431-432）。
- `applyTaskResult(task, content, notes)`：行441-454，`keepInMemory` 任务回内存、文章任务经 `fixAnchors` 后落盘（行445-448）。
- `runRealtimeTasks(tasks, {...})`：行469-528（export），唯一并发执行器，按任务 `bigTier` 标记分池（行471-489）——默认档/大档各自独立限流；每任务可带自己的 `provider/model/reasoningEffort`（行501-513）；`onTaskDone` 上报 `{outputTokens,durationMs}` 供 tps 采样（行514）；`onRequestStart` 挂钩会话记录（行498）；返回 `Map(customId→{ok,stopReason,content?})`（行527）。
- `BATCH_TOKEN_BUDGET`：行541，`110000` 单请求输入预算；`BATCH_TOKEN_HARD_LIMIT` 行546，`128000` 超预算兜底装填上限。

### index.js — 源码装填与任务装配（行557-1155）
- `numberLines(content)`：行557-559（export），每行加 `N| ` 前缀。
- `fixAnchors(content, cwd)`：行568-651（export），落盘前第四层锚点校正（frontmatter 解析行570-573、`symbolsOnLine` 行588-597、声明形态消歧行628-631），只改行号数字。
- `collectSources(cwd, files, budget)`：行656-683（export），整文件内联不做半文件截断（行667），返回 `{text,skipped,oversized}`。
- `batchArticlePrompt`：行687-714，单轮文章 prompt（旧文行号禁用条款行700）。
- `prepareArticleTasks(tasks, {...})`：行727-812（export），三级降级装配（普通档/大档/会话兜底）：大档判定行731-738、`markBig` 行739-747、单请求直出 `emitSingle` 行758-764、`emitSession` 行765-769、单文件连大档都装不下转会话（行770、789）、超限拆观察批 `_split/`（行774-807），返回 `{prepared,sessionTasks}`。
- `articleFormatSection()`：行818-847，文章格式唯一条款来源（frontmatter+六章节）。
- `shouldFallBackFromAgentic(results)`：行855-860（export），agentic 批次失败过半才算系统性失败。
- `localPlan(files)`：行862-875（export），本地顶层目录分组规划（0.10.7 起唯一兜底规划路径）。
- `semanticPlan(files, {...})`：行884-967（export），AST 符号提取（`extractRepoGraph` 行903）+ 依赖边（`resolveImportEdges` 行920）+ LLM 语义聚类（`clusterComponents` 行931）；plan 持久化 tree/graph 但**不带** sourceCode（行950-959），失败退回 `localPlan`（行905-917、933-935、962-965）。
- `packArticles(articles, budget)`：行971-990，横切输入装填（超预算截头部行977-985）。
- 横切/校对模板：`crosscutIntro` 行992-1004、`batchArchitecturePrompt` 行1006-1012、`batchPatternsPrompt` 行1014-1020、`batchConceptPrompt` 行1022-1028、`batchObservePrompt` 行1032-1049（横切观察）、`batchArticleObservePrompt` 行1053-1069（分割观察）、`batchArticleComposePrompt` 行1073-1101（分割合成）、`batchProofreadPrompt` 行1105-1124、`batchProofreadBatchPrompt` 行1128-1155（`@@@article:`/`
