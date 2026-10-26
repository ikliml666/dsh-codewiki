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

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.12.2"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。

代码分成两半，职责严格分离：

- `index.js`（宿主半侧，行1起至行3632）封装本地 `cw` CLI（`runCw` 见行142-167）、定义 `Config` 配置（行51-73）、实现 `createJobService` 阶段机（行1541-2604），注册四个模型工具（`cwToolDefinition` 行1039-1102 / `generateToolDefinition` 行2611-2789 / `updateToolDefinition` 行2799-2851 / `progressToolDefinition` 行2870-2974），并通过 `installWebServer`（行3078-3373）在回环地址暴露查询与控制端点，插件入口 `apply` 在行3568-3632。
- `client.js`（浏览器半侧，行10起至行1594）经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`CodewikiCard` 行520-950）和侧边栏面板（`CodewikiPanel` 行1332-1577、`PanelIcon` 行1579-1590），靠轮询而非推送更新界面（轮询间隔 `POLL_MS=2000` 行22，`REPOS_POLL_MS=10000` 行31）。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → `done`（阶段处理函数 `STAGE_HANDLER` 行2395-2402，`tick` 行2404-2490 按 10 秒节拍 `TICK_MS` 行1163 推进一步）。规划阶段已于 0.10.7 删除（`localPlan` 行832-845 本地分组替代，旧 `plan` 阶段在 `tick` 行2468-2475 被迁移到 `articles`）。全部状态落在 `JOBS_FILE`（行1162），因此宿主重启、多实例并存都能靠磁盘快照接管续跑（`acquireTickLock` 行1436-1450，`mergeFromDisk` 行1595-1616）。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行392-417），默认 `workbuddy/hy3`（192k 上下文，行26-27），单请求输入预算 110k（`BATCH_TOKEN_BUDGET` 行521）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行30-31，预算 420k，行33），仍装不下才转会话通道兜底（`dispatchSessionTasks` 在行1870-1904）。编译产物自提交在 0.10.11 起独立成 `commit` 阶段（`tickCommit` 行2377-2393），走主题分支合并式（`autoCommitWiki` 行3406-3488）。

## Key Components

### package.json（行1-28）
- `name`：行2，`"@local/dsh-codewiki"`，插件注册 id（client.js `load` 的 `id` 行11须与此一致）；`NS`（行17 client.js）/`KEY`（行18 client.js）为设置命名空间与面板 key，默认 `'codewiki'`。
- `version`：行3，`"0.12.2"`。
- `private` / `type`：行5-6，私有模块、ESM。
- `exports`：行8-11，`.` 指向 `index.js`，`./client` 指向 `client.js`。
- `dsh.client.platform`：行21-23，固定 `web`。
- `dsh.bundle.patch`：行24-26，指向 `cordis.patch.yml`。
- `dependencies`：行17-19，仅 `@deepseek-ai/schemastery "^3.18.4"`。

### index.js — 配置与基础层（行17-366）
- `PLUGIN_NAME`：行18，`'dsh-codewiki'`，同时 `export const name` 行19。
- `CW_SUBCOMMANDS`：行20，白名单 `['init','status','index','meta','path','projects','setup','uninstall']`。
- `CONCURRENCY_HARD_CAP`：行22，硬顶 `8`。
- 默认常量：行24-33，`DEFAULT_CONCURRENCY`(行24)、`DEFAULT_BATCH_PROVIDER`(行26)、`DEFAULT_BATCH_MODEL`(行27)、`DEFAULT_BIG_PROVIDER`(行30)、`DEFAULT_BIG_MODEL`(行31)、`DEFAULT_BIG_TOKEN_BUDGET`(行33)。
- `WIKI_PATHS`：行36，`['.codewiki', 'CodeWiki.md']`，自动提交唯一 pathspec。
- `Config`：行51-73，`z.object` 共 20 个 `.volatile()` 字段：`enabled`(行52)、`binaryPath`(行53)、`batchProvider`(行54)、`batchModel`(行55)、`batchReasoningEffort`(行56)、`bigProvider`(行57)、`bigModel`(行58)、`bigReasoningEffort`(行59)、`bigTokenBudget`(行60)、`sessionTier`(行61)、`maxConcurrency`(行62)、`bigConcurrency`(行63)、`serialProjects`(行64)、`parallelProjects`(行65)、`articleLanguage`(行66)、`updateReminder`(行67)、`autoCommit`(行68)、`excludePaths`(行69)、`autoUpdate`(行70)、`autoUpdateMin`(行71)、`workspaceOnly`(行72)。
- `liveConfig(config)`：行79-114，折算运行时值，并发钳 `[1,8]`（行94-96）、`autoUpdateMin` 下限5（行110）、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行92）。
- `normalizeCwd(input)`：行40-45，仅 win32 将 `/e/...` 归一 `E:/...`。
- `resolveBinary(cfg)`：行120-140，顺序：配置 `binaryPath` → PATH `cw` → 插件 `bin/cw(.exe)` → 裸 `'cw'`。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行142-167，`spawn` 收集输出，超时/abort 发 `SIGKILL`，返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `normalizeArticlePath(p)`：行179，反斜杠转正斜杠。
- `normalizeIndexLinks(cwd)`：行183-191，修正 `_index.md` 链接头内 `\`→`/`。
- `parseStatus(stdout)`：行193-206，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing/uncompiled/clean/stale`。
- `countWikiArticles(wikiPath)`：行209-221，递归统计 `.codewiki/` 下 `.md` 篇数。
- `ensureWikiEntry(cwd, language='中文')`：行226-259，缺 `CodeWiki.md` 时按语言生成入口，已存在不覆盖。
- `excludedItem` / `isExcluded`：行264-276，排除清单 `[\n;，,]+` 分隔，子树命中（大小写不敏感）。
- `detectLinkedWorktree(cwd)`：行289-305，用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree，命中不给 worktree 编译。
- `isWorktreeCwd` 行313-324（带缓存），`hasCompilableSources` 行332-346，`isDeadCompileTarget` 行358-366。

### index.js — 模型通道与执行器（行374-508）
- `estimateTokens(text)`：行374-382，CJK 1 token/字，其余 3.5 字符/token。
- `BATCH_TOKEN_BUDGET`：行521，`110000` 单请求输入预算。
- `BATCH_TOKEN_HARD_LIMIT`：行526，`128000` 超预算兜底装填上限。
- `llmChat({llm,provider,model,reasoningEffort,prompt,signal,onDelta})`：行392-417，唯一模型通道，走宿主 `llm.stream` + `BlockAssembler`，`temperature:0`，来源 `plugin:codewiki`；不支持的 effort 自动重试（行406-409）。
- `applyTaskResult(task, content, notes)`：行421-434，`keepInMemory` 回内存，否则 `fixAnchors` 后落盘。
- `runRealtimeTasks(tasks, {...})`：行449-508，唯一并发执行器（`export`），按 `maxConcurrency` 分池（默认档/大档）消费队列，返回 `Map(customId→{ok,stopReason,content?})`，支持 `onRequestStart` 挂钩会话记录。

### index.js — 源码装填与任务装配（行537-1033）
- `numberLines(content)`：行537-539，每行加 `N| ` 前缀。
- `fixAnchors(content, cwd)`：行548-631（`export`），落盘前第四层锚点校正，只改行号数字。
- `collectSources(cwd, files, budget)`：行636-663（`export`），整文件内联，返回 `{text,skipped,oversized}`。
- `batchArticlePrompt(...)`：行667-694，单轮文章 prompt 骨架。
- `prepareArticleTasks(tasks, {...})`：行707-792（`export`），三级降级装配（普通档/大档/会话兜底），返回 `{prepared,sessionTasks}`。
- `articleFormatSection()`：行798-827，文章格式唯一条款来源（frontmatter+章节）。
- `localPlan(files)`：行832-845（`export`），本地顶层目录分组规划（0.10.7 起唯一规划路径）。
- `packArticles(articles, budget)`：行849-868，横切输入装配，截头部标注。
- `crosscutIntro` 行870-882、`batchArchitecturePrompt` 行884-890、`batchPatternsPrompt` 行892-898、`batchConceptPrompt` 行900-906，横切模板。
- `batchObservePrompt` 行910-927，横切 map 观察（无 frontmatter）。
- `batchArticleObservePrompt` 行931-947，文章分割 map 观察。
- `batchArticleComposePrompt` 行951-979，观察合成整文。
- `batchProofreadPrompt` 行983-1002，单篇校对。
- `batchProofreadBatchPrompt` 行1006-1033，多篇合并校对（`@@@article`/`
