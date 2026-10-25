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

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.10.11"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。

代码分成两半，职责严格分离：

- `index.js`（共 3169 行）是宿主半侧。它封装本地 `cw` CLI（`runCw` 见行130）、定义 `Config` 配置（行51）、实现 `createJobService` 阶段机（行1238），注册四个模型工具（`cw` 行892 / `codewiki_generate` 行2247 / `codewiki_update` 行2407 / `codewiki_progress` 行2478），并通过 `installWebServer`（行2686）在回环地址上暴露查询与控制端点。
- `client.js`（共 1375 行）是浏览器半侧。经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`plugins.item`）和侧边栏面板（`main` + `sidebar.panellist`），靠轮询而非推送更新界面（轮询间隔 `POLL_MS=2000` 行22，`REPOS_POLL_MS=10000` 行26）。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → `done`，规划阶段已于 0.10.7 删除（旧 `plan` 阶段在 `tick` 里被迁移到 `articles`，见行2124-2131），提交后直接进 `articles`。`tick`（行2069）按 10 秒节拍每次推进一步（`TICK_MS` 见行1016），全部状态落在 `JOBS_FILE`（行1015），因此宿主重启、多实例并存都能靠磁盘快照接管续跑。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行288），默认 `workbuddy/hy3`（192k 上下文，行26-27），单请求输入预算 110k（行374）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行30-31，预算 420k，行33），仍装不下才转会话通道兜底（`dispatchSessionTasks` 见行1537）。编译产物自提交在 0.10.11 起独立成 `commit` 阶段（`tickCommit` 见行2042），走主题分支合并式（`autoCommitWiki` 见行2948）。

## Key Components

### package.json（行1-28）
- `name`：行2，`"@local/dsh-codewiki"`，插件注册 id，须与 client.js 中 `NS`/`KEY` 一致。
- `version`：行3，`"0.10.11"`。
- `private` / `type`：行5-6，私有模块、ESM。
- `exports`：行8-11，`.` 指向 `index.js`，`./client` 指向 `client.js`。
- `dsh.client.platform`：行21-23，固定 `web`。
- `dsh.bundle.patch`：行25，指向 `cordis.patch.yml`。
- `dependencies`：行17-19，仅 `@deepseek-ai/schemastery "^3.18.4"`。

### index.js — 配置与基础层（行17-280）
- `PLUGIN_NAME`：行18，`'dsh-codewiki'`，同时 `export const name` 行19。
- `CW_SUBCOMMANDS`：行20，白名单 `['init','status','index','meta','path','projects','setup','uninstall']`。
- `CONCURRENCY_HARD_CAP`：行22，硬顶 `8`。
- `DEFAULT_CONCURRENCY` 等：行24-33，默认并发2、批量/大档模型与预算常量。
- `WIKI_PATHS`：行36，`['.codewiki', 'CodeWiki.md']`，自动提交唯一 pathspec。
- `Config`：行51-71，`z.object` 共 19 个 `.volatile()` 字段：`enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`。
- `liveConfig(config)`：行77-102，折算运行时值，并发钳 `[1,8]`、`autoUpdateMin` 下限5、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`。
- `normalizeCwd(input)`：行40-45，仅 win32 将 `/e/...` 归一 `E:/...`。
- `resolveBinary(cfg)`：行108-128，顺序：配置 `binaryPath` → PATH `cw` → 插件 `bin/cw(.exe)` → 裸 `'cw'`。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`：行130-155，`spawn` 收集输出，超时/abort 发 `SIGKILL`，返回 `{exitCode,stdout,stderr,timedOut}` 永不 reject。
- `normalizeArticlePath(p)`：行167，反斜杠转正斜杠。
- `normalizeIndexLinks(cwd)`：行171-179，修正 `_index.md` 链接头内 `\`→`/`。
- `parseStatus(stdout)`：行181-194，解析 `cw status` 为 `{state,changedFiles,staleArticles}`，四态 `missing/uncompiled/clean/stale`。
- `countWikiArticles(wikiPath)`：行197-209，递归统计 `.codewiki/` 下 `.md` 篇数。
- `ensureWikiEntry(cwd, language='中文')`：行214-247，缺 `CodeWiki.md` 时按语言生成入口，已存在不覆盖。
- `excludedItem` / `isExcluded`：行252-264，排除清单 `[\n;，,]+` 分隔，子树命中（大小写不敏感）。
- `estimateTokens(text)`：行272-280，CJK 1 token/字，其余 3.5 字符/token。

### index.js — 模型通道与执行器（行282-361）
- `BATCH_TOKEN_BUDGET`：行374，`110000` 单请求输入预算。
- `BATCH_TOKEN_HARD_LIMIT`：行379，`128000` 超预算兜底装填上限。
- `llmChat({llm,provider,model,reasoningEffort,prompt,signal})`：行288-307，唯一模型通道，走宿主 `llm.stream` + `BlockAssembler`，`temperature:0`，来源 `plugin:codewiki`。
- `applyTaskResult(task, content, notes)`：行311-324，`keepInMemory` 回内存，否则 `fixAnchors` 后落盘。
- `runRealtimeTasks(tasks, {...})`：行332-361，唯一并发执行器，按 `maxConcurrency` 消费队列，返回 `Map(customId→{ok,stopReason,content?})`。

### index.js — 源码装填与任务装配（行363-886）
- `numberLines(content)`：行390-392，每行加 `N| ` 前缀。
- `fixAnchors(content, cwd)`：行401-484，落盘前第四层锚点校正，只改行号数字。
- `collectSources(cwd, files, budget)`：行489-516，整文件内联，返回 `{text,skipped,oversized}`。
- `batchArticlePrompt(...)`：行520-547，单轮文章 prompt 骨架。
- `prepareArticleTasks(tasks, {...})`：行560-645，三级降级装配，返回 `{prepared,sessionTasks}`。
- `articleFormatSection()`：行651-680，文章格式唯一条款来源。
- `localPlan(files)`：行685-698，本地顶层目录分组规划（0.10.7 起唯一规划路径）。
- `packArticles(articles, budget)`：行702-721，横切输入装配，截头部标注。
- `crosscutIntro` / `batchArchitecturePrompt` / `batchPatternsPrompt` / `batchConceptPrompt`：行723-759，横切模板。
- `batchObservePrompt`：行763-780，横切 map 观察（无 frontmatter）。
- `batchArticleObservePrompt`：行784-800，文章分割 map 观察。
- `batchArticleComposePrompt`：行804-832，观察合成整文。
- `batchProofreadPrompt`：行836-855，单篇校对。
- `batchProofreadBatchPrompt`：行859-886，多篇合并校对（`@@@article/
