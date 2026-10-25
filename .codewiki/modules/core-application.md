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

- `index.js`（共 3169 行）是宿主半侧。它封装本地 `cw` CLI（`runCw` 见行130）、定义 `Config` 配置（行51）、实现 `createJobService` 阶段机（行1238），注册四个模型工具（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`），并通过 `installWebServer`（行2686）在回环地址上暴露查询与控制端点。
- `client.js`（共 1375 行）是浏览器半侧。经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`plugins.item`）和侧边栏面板（`main` + `sidebar.panellist`），靠轮询而非推送更新界面。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit` → `done`，规划阶段已于 0.10.7 删除（旧 `plan` 阶段在 `tick` 里被迁移到 `articles`，见行2124-2131），提交后直接进 `articles`。`tick`（行2069）按 10 秒节拍每次推进一步（`TICK_MS` 见行1016），全部状态落在 `JOBS_FILE`（行1015），因此宿主重启、多实例并存都能靠磁盘快照接管续跑。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行288），默认 `workbuddy/hy3`（192k 上下文，行26-27），单请求输入预算 110k（行374）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行30-31，预算 420k，行33），仍装不下才转会话通道兜底（`dispatchSessionTasks` 见行1537）。编译产物自提交在 0.10.11 起独立成 `commit` 阶段（`tickCommit` 见行2042），走主题分支合并式（`autoCommitWiki` 见行2948）。

## Key Components

### index.js — 配置与基础层

- `PLUGIN_NAME`：行18，值为 `'dsh-codewiki'`，同时以 `export const name` 导出（行19）。
- `CW_SUBCOMMANDS`：行20，['init','status','index','meta','path','projects','setup','uninstall']，`cw` 工具据此做子命令白名单校验。
- `CONCURRENCY_HARD_CAP`：行22，值 `8`，编译请求并发硬顶。
- `DEFAULT_CONCURRENCY` 等：行24-33，默认并发2、默认批量/大档模型与预算常量。
- `WIKI_PATHS`：行36，['.codewiki', 'CodeWiki.md']，自动提交只认这两个 pathspec。
- `Config`：行51-71，`@deepseek-ai/schemastery` schema，共 19 个字段且全部 `.volatile()`：`enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`。
- `liveConfig(config)`：行77-102，把配置折算成运行时值：`maxConcurrency` 钳到 `[1, CONCURRENCY_HARD_CAP]`、`autoUpdateMin` 下限5、`workspaceOnly !== false` 归一布尔、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`。
- `normalizeCwd(input)`：行40-45，仅 win32 把 MSYS 盘符路径 `/e/...` 归一为 `E:/...`；非 win32 原样返回。
- `resolveBinary(cfg)`：行108-128，解析顺序为「配置 `binaryPath` → PATH 里的 `cw`（win32 用 `where`，其余用 `which`）→ 插件自带 `bin/cw(.exe)` → 裸 `'cw'`」。PATH 优先避免捆绑副本落后于源码。
- `runCw(binary, cwd, args, timeoutMs = 120000, signal)`：行130-155，`spawn` 子进程收集 stdout/stderr，超时 `SIGKILL`，`signal.abort` 同样 `SIGKILL`；返回 `{ exitCode, stdout, stderr, timedOut }`，**永不 reject**。
- `normalizeArticlePath(p)`：行167，把 `\` 换成 `/`。
- `normalizeIndexLinks(cwd)`：行171-179，`cw index` 直写的 `.codewiki/_index.md` 里，把 `[[link|title]]` 链接头中的 `\` 规范化为 `/`。
- `parseStatus(stdout)`：行181-194，把 `cw status` 文本解析成 `{ state, changedFiles, staleArticles }`。四关键字判定：`'No wiki found'`→`missing`、`'has not been compiled yet'`→`uncompiled`、`'Wiki is up to date'`→`clean`，其余按 `^\s+[M!]\s+(.+)$` 逐行归类（`M` 进 changedFiles、`!` 进 staleArticles），状态记 `stale`。
- `countWikiArticles(wikiPath)`：行197-209，递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），失败返回 `null`。
- `ensureWikiEntry(cwd, language = '中文')`：行214-247，仓库根缺 `CodeWiki.md` 时按语言写入口说明；**已存在绝不覆盖**，生成失败只影响入口存在性。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`：行252-264，排除清单按 `[\n;，,]+` 分隔，`cwd` 等于某项或位于其子树内即命中（归一化小写比较）。
- `estimateTokens(text)`：行272-280，CJK 字符按1 token/字，其余按3.5字符/token，只求把单请求输入压进模型上下文。

### index.js — Token 预算、模型通道与执行器

- `BATCH_TOKEN_BUDGET`：行374，`110000`，单请求输入预算（hy3 192k 上下文留余量）。
- `BATCH_TOKEN_HARD_LIMIT`：行379，`128000`，超预算兜底装填上限（旧值150k已越界）。
- `llmChat({ llm, provider, model, reasoningEffort, prompt, signal })`：行288-307，**唯一模型通道**，走宿主 llm 服务（`llm.stream` + `BlockAssembler`），`temperature: 0`，消息来源标记 `plugin:codewiki`；`finish.kind` 为 `error`/`aborted` 或缺 content 时抛错。
- `applyTaskResult(task, content, notes)`：行311-324，任务结果统一出口。`keepInMemory` 任务只回内存；其余任务先跑 `fixAnchors` 修锚点再 `writeFileSync` 落盘。
- `runRealtimeTasks(tasks, { model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider })`：行332-361，**唯一执行器**。按并发上限消费队列，每任务调 `llmChat`；单任务异常只 `notes.push` 并置该任务 `ok: false`；返回 `Map(customId → { ok, stopReason, content? })`。

### index.js — 行号锚点、源码装填与任务装配

- `numberLines(content)`：行390-392，给每行加 `N| ` 前缀，让模型引用行号以前缀为准。
- `fixAnchors(content, cwd)`：行401-484，**文章落盘前第四层兜底**。只处理 frontmatter 之后行；从反引号提取符号，锚点起点行不含符号时在全文找出现行：恰好一处→修正；多处→只认 `function`/`class`/`const`/`let` 声明形态（`defRe` 行462），仍歧义不动并记 `unresolved`；只改行号数字，`source_files` 外引用不碰。
- `collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)`：行489-516，把源文件内联成 markdown（每段 `### <rel>` + 带 `numberLines` 围栏），**只整文件装填、绝不半文件截断**。返回 `{ text, skipped, oversized }`。
- `batchArticlePrompt({ language, mission, sourcesText, prevArticle })`：行520-547，单轮文章 prompt 骨架；有旧文时附上并明确「行号可能已过期、不得沿用」。
- `prepareArticleTasks(tasks, { cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget })`：行560-645，任务装配与**三级降级**：普通档装填→大档（bigTier）装填→会话通道兜底。返回 `{ prepared, sessionTasks }`；大档任务标 `bigTier` 并记录 provider/model。
- `articleFormatSection()`：行651-680，文章格式条款唯一来源：frontmatter 含 `title`/`type`/`source_files`/`tags`，正文六章节 `Overview`/`Key Components`/`Architecture`/`Data Flow`/`Connections`/`Known Issues`；行号必须以前缀为准；`Connections` 用 `[[backlinks]]`。

### index.js — Prompt 模板

- `localPlan(files)`：行685-698，本地规划兜底（0.10.7 起唯一规划路径）：按顶层目录分组生成模块清单，不再发独立规划请求。
- `packArticles(articles, budget = BATCH_TOKEN_BUDGET)`：行702-721，横切输入装配；整篇装不下时只装头部并标「超预算，仅头部」。
- `crosscutIntro` / `batchArchitecturePrompt` / `batchPatternsPrompt` / `batchConceptPrompt`：行723-759，横切公共骨架与三个具体实现（架构/模式/概念）。
- `batchObservePrompt`：行763-780，横切 map 阶段观察（不带 frontmatter）。
- `batchArticleObservePrompt`：行784-800，文章分割 map 阶段观察（观察对象是源码而非文章）。
- `batchArticleComposePrompt`：行804-832，合并各批观察成整篇。
- `batchProofreadPrompt`：行836-855，单篇校对 prompt：四项核对，输出修正后整文。
- `batchProofreadBatchPrompt`：行859-886，多篇文章合并校对 prompt，按 `@@@article/
