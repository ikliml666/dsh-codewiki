---
title: core-application
type: module
source_files:
  - index.js
tags: [CodeWiki, 编译流水线, 阶段机, 编排服务, cw CLI, 宿主llm服务, 大档模型, 会话通道, 回环WebServer, DeepSeek Harness]
---

## Overview

`core-application` 是 `dsh-codewiki` 插件**宿主半侧的应用层与编译流水线实现**，全部位于仓库根 `index.js`（当前版本 **4882** 行）。它把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线：四个模型工具（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`）只负责判态与提交，真正的编译由常驻的 `createJobService` 以 10s 节拍（`TICK_MS` 第 1877 行）推进一个 job 阶段机完成。浏览器半侧的 `client.js`、包元数据 `package.json`、配置 schema `Config` 与行号契约 `articleFormatSection` 已分别拆到 [[client-interface]]、[[core-and-config]]、[[configuration-and-metadata]] 三个模块，本文只覆盖 `index.js` 里「编排服务 + 阶段机 + 三通道（批量并发池 / agentic / 会话兜底）+ 回环 WebServer + 产物自动提交」这一层，不重复它们的内部行号。

流水线核心契约是 **阶段机 + 磁盘快照**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → 终态 `done`/`partial`/`failed`/`cancelled`（`STAGE_HANDLER` 第 3482-3489 行，`tick` 第 3491-3577 行按 `TICK_MS=10000` 推进）。规划阶段已于 0.10.7 删除——`full` 任务的模块清单在 `tickArticles` 阶段开头就地由 `buildPlan`/`localPlan` 本地重建（第 2879 行起，`plan` 旧阶段在 `tick` 第 3555-3562 行被迁移到 `articles`）。全部 job 状态落在 `JOBS_FILE`（第 1876 行），因此宿主重启、多实例并存都能靠磁盘快照接管续跑（`acquireTickLock` 第 2182-2196 行、`mergeFromDisk` 第 2349-2370 行、`settleJob` 第 2460 行按 `batchPrompt` 快照重跑）。

模型通道唯一：宿主 `llm` 服务（`llmChat` 第 467-492 行）。默认编译模型 `workbuddy/hy3`（192k 上下文，第 45-46 行常量），单请求输入预算 110k（`BATCH_TOKEN_BUDGET` 第 663 行）；单文件超预算（普通档 128k 硬上限 `BATCH_TOKEN_HARD_LIMIT` 第 668 行，或开启大档时 `bigTokenBudget`）改用大档 `volces-ark/glm-5.3-flash`（512k，第 49-50 行）。仍装不下才转 **会话通道兜底**：把完整写作/校对指令写入任务文件、`steer` 发起会话模型派子智能体完成，由本服务轮询收割（`dispatchSessionTasks` 第 2797-2831 行、`buildSessionSteerText` 第 2049 行、`progressSessionTasks` 第 2835 行）。编译产物自提交 0.10.11 起独立成 `commit` 阶段（`tickCommit` 第 3465-3480 行），走主题分支合并式（`autoCommitWiki` 第 4655-4737 行），默认不再要求会话模型代跑 git。

0.13.0 起吸收 FSoft-AI4Code/CodeWiki 的 AST 符号提取 + LLM 语义聚类（`semanticPlan` 第 1322-1405 行）、agentic 工具循环写作（`startAgenticRun` 第 2676-2727 行，经 `lib/articles-agentic.js`）与符号级增量判定（`extractCurrentGraph` 第 2149 行，`lib/incremental.js` 快照比对），全部用 Node + tree-sitter WASM 实现，不需要 Python 运行时；任一环节失败自动降级回顶层目录分组 / 单轮整包装填 / 文件级增量，不会中断编译（`package.json` 第 4 行 `description`、`cordis.patch.yml` 第 2 行）。

## Key Components

本模块全部实现都在 `index.js`（`package.json`/`client.js`/配置 schema 见 [[core-and-config]]/[[client-interface]]）。下文按「规划与编译提交 → 编排服务与阶段机 → 三通道（批量/agentic/会话） → 回环 WebServer → 产物提交」分层列出公开函数与关键闭包。

### cw 工具封装与判态（行150-301）

- `resolveBinary(cfg)`：行150-170，顺序：配置 `binaryPath`（行151）→ PATH `where`/`which` 探测（行154-165）→ 插件 `bin/cw(.exe)`（行167-168）→ 裸 `'cw'`（行169）。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行172-197，`spawn` 收集输出，超时/abort 发 `SIGKILL`（行178-182），返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `parseStatus(stdout)`：行223-236，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing`(行225)/`uncompiled`(行226)/`clean`(行227)/`stale`(行235)。
- `normalizeArticlePath(p)` 行209（export，`\`→`/`）、`normalizeIndexLinks(cwd)` 行213-221（export，修正 `_index.md` 链接头）。
- `countWikiArticles(wikiPath)`：行239-251，递归统计 `.codewiki/` 下 `.md` 篇数（仓库总览卡用）。
- `ensureWikiEntry(cwd, language='中文')`：行301-334，缺 `CodeWiki.md` 时按语言生成入口（中文模板行307-318，英文行320-331），已存在不覆盖。
- `excludedItem` 行339-348 / `isExcluded` 行349-351：排除清单判定（换行/分号/逗号分隔，Windows 大小写不敏感）。

### worktree / 可编译源码 / 死目标判定（行353-441）

- `detectLinkedWorktree(cwd)`：行364-380（export），用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree（行367-379）。
- `isWorktreeCwd(cwd)`：行388-399（export），带 60s 缓存版（`WORKTREE_CACHE_TTL_MS` 行385）。
- `hasCompilableSources(cwd)`：行407-421（export，10 分钟探测缓存 `SOURCE_PROBE_TTL_MS` 行405）。
- `clearSourceProbeCache(cwd)`：行423-426（export，手动编译前清缓存）。
- `isDeadCompileTarget(cwd)`：行433-441（export，worktree 或无源码即死对象；目录不存在不算 dead）。

### 模型通道与执行器（行449-668）

- `estimateTokens(text)`：行449-457（export），CJK 1 token/字，其余 3.5 字符/token。
- `llmChat({llm,provider,model,reasoningEffort,prompt,signal,onDelta})`：行467-492，唯一模型通道，走宿主 `llm.stream` + `BlockAssembler`（行468-479），`temperature:0`（行474），来源 `plugin:codewiki`（行473）；模型不支持配置的 effort 时剥档重试一次（行481-484）；失败统一抛错（行486-487）。
- `applyTaskResult(task, content, notes)`：行553-576，`keepInMemory` 任务回内存、文章任务经 `fixAnchors` 后落盘（行567-570）。
- `runRealtimeTasks(tasks, {...})`：行591-650（export），唯一并发执行器，按任务 `bigTier` 标记分池（行596-611）——默认档/大档各自独立限流；每任务可带自己的 `provider/model/reasoningEffort`（行623-631）；`onTaskDone` 上报 `{outputTokens,durationMs}` 供 tps 采样（行636）；`onRequestStart` 挂钩会话记录（行620）；返回 `Map(customId→{ok,stopReason,content?})`（行649）。
- `BATCH_TOKEN_BUDGET`：行663，`110000` 单请求输入预算；`BATCH_TOKEN_HARD_LIMIT` 行668，`128000` 超预算兜底装填上限。

### 源码装填与任务装配（行679-1593）

- `numberLines(content)`：行679-681（export），每行加 `N| ` 前缀（弱模型自己数行首尾常错，强制以前缀为准）。
- `changelogSections(clLines)`：行699-707（export），把 CHANGELOG 按 `## 版本号` 节切开供锚点重定位。
- `fixChangelogAnchors(content, cwd)`：行709-825（export），CHANGELOG 流水账锚点按「版本节首 + 相对偏移」重定位。
- `repairUnclosedFrontmatter(content)`：行834-854（export），修复未闭合 frontmatter（闭合 `---` 被写成空行）。
- `fixAnchors(content, cwd)`：行856-1073（export），落盘前第四层锚点校正（frontmatter 解析行865-874、符号就近绑定 `symbolsWithPos` 行912-922、声明形态消歧 `locate` 行969-987、区间/倒序处理行1016-1067），只改行号数字。
- `validateArticleEnvelope(content)`：行1082-1089（export），校验文章必须以成对 `---` frontmatter 开头（结尾 `---` 须独占一行）。
- `collectSources(cwd, files, budget)`：行1094-1121（export），整文件内联不做半文件截断（行1107），返回 `{text,skipped,oversized}`。
- `batchArticlePrompt({language,mission,sourcesText,prevArticle})`：行1125-1152，单轮文章 prompt（旧文行号禁用条款行1138）。
- `prepareArticleTasks(tasks, {...})`：行1165-1250（export），三级降级装配（普通档/大档/会话兜底）：大档判定行1169-1176、`markBig` 行1177-1185、单请求直出 `emitSingle` 行1196-1202、`emitSession` 行1203-1207、单文件连大档都装不下转会话（行1208、1227）、超预算拆观察批（行1214-1245），返回 `{prepared,sessionTasks}`。
- `articleFormatSection()`：行1256-1285，文章格式唯一条款来源（frontmatter + 六章节 + Markdown 规范）。
- `shouldFallBackFromAgentic(results)`：行1293-1298（export），agentic 批次失败过半才算系统性失败。
- `localPlan(files)`：行1300-1313（export），本地顶层目录分组规划（`slugify` 行1670-1672），`planMode='dirs'` 时唯一路径。
- `semanticPlan(files, {...})`：行1322-1405（export），AST 符号提取 `extractRepoGraph`（行1341）+ 依赖边 `resolveImportEdges`（行1358）+ LLM 语义聚类 `clusterComponents`（行1369）；plan 持久化 tree/graph 但**不带** sourceCode（行1384-1397），失败退回 `localPlan`（行1343-1350、1371-1372、1401-1402）。
- `packArticles(articles, budget)`：行1409-1428，横切输入装填（超预算截头部行1416-1422）。
- 横切/校对/观察 prompt 模板：`crosscutIntro` 行1430-1442、`batchArchitecturePrompt` 行1444-1450、`batchPatternsPrompt` 行1452-1458、`batchConceptPrompt` 行1460-1466、`batchObservePrompt` 行1470-1487（横切观察）、`batchArticleObservePrompt` 行1491-1507（超大模块分文件观察）、`batchArticleComposePrompt` 行1511-1539（观察合成）、`batchProofreadPrompt` 行1543-1562（单篇校对）、`batchProofreadBatchPrompt` 行1566-1593（多篇按 `@@@article:`/`
