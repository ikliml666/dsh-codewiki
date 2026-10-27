---
title: System Architecture Overview
type: architecture
source_files:
  - package.json
  - cordis.patch.yml
  - index.js
  - client.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/graph-diff.js
  - lib/incremental.js
  - README.md
  - .codewiki/_index.md
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接, 编译流水线, 吸收自FSoft]
---

## Overview

本文件是 `@local/dsh-codewiki`（当前版本 0.14.0，`package.json:3`）的系统总览，写给对仓库零上下文的未来 agent。插件把 Rust CLI `cw`（来自 mraza007/codewiki，`README.md:3`）接入 DeepSeek Harness，提供仓库内活 wiki（`<repo>/.codewiki/`，随仓库提交共享）的编译、更新与进度查询。全部模型环节在插件内完成、零子代理：模型调用唯一通道是 `llmChat`（`index.js:467-492`），它经宿主 `llm.stream()` 发请求，请求带 `source: { kind: 'plugin:codewiki' }` 与 `temperature: 0`；编译由宿主常驻服务 `createJobService`（`index.js:2295-3706`）以 10s tick（`TICK_MS`，`index.js:1877`）阶段机推进。

仓库由四部分组成：**core-and-config**（`index.js` 宿主半侧单文件 4881 行 + `lib/` 七个吸收模块 + `client.js` 浏览器半侧 + `cordis.patch.yml`/`package.json`）、**docs-and-meta**（`README.md`/`.codewiki/_index.md` 等；无独立 `CodeWiki.md` 入口文件，入口由流水线在缺省时自动生成，见 `ensureWikiEntry` `index.js:301-334`）、**test-scripts**（`test-*.mjs` 回归脚本）、**logs-and-temp**（运行时日志与 `.dsh-ops/`）。挂载方式是 `cordis.patch.yml:19-33` 的 `insert` 条目（id `codewiki`，本地开发走 `file:///` 直挂，`config: {}` 表示全部用 `Config` schema 默认值，`cordis.patch.yml:22`）。

当前版本（0.14.0）的关键形态：

- **四层吸收能力（0.13.0）**：AST 符号提取（`extractRepoGraph` `lib/symbols.js:785-805`，AST 不可用时正则降级 `regexExtract` `lib/symbols.js:374-440`）、LLM 语义聚类模块划分（`clusterComponents` `lib/cluster.js:291-389`，真递归下钻 `subdivide` `lib/cluster.js:396-422`）、agentic 工具循环写作（`runAgenticArticles` `lib/articles-agentic.js:231-306`，工具定义 `TOOL_SCHEMAS` `lib/agentic.js:27-87`）、符号级增量判定（`filterStaleTasks`/`slimGraph`/`graphFromSnapshot` `lib/incremental.js`）。全部用 Node + tree-sitter WASM 实现，不引 Python 运行时（依赖落在 `vendor/tree-sitter/`，`README.md:88`）。三个开关 `planMode`（`index.js:86`）、`agenticArticles`（`index.js:87`，步数上限 `agenticMaxSteps` `index.js:88`）、`symbolIncremental`（`index.js:89`）默认全开（`cordis.patch.yml:15-18`），任一环节失败自动降级。0.13.1 把 `generate_sub_module` 子模块递归成文真正接进生产链路（`runOneArticle` 的 `dispatchSub` `lib/articles-agentic.js:83-126`），0.13.2 修掉 `subDepth` 递归封顶（`lib/articles-agentic.js:33-69`）并加 `codeHash` 纯注释判定（`codeHash` `lib/graph-diff.js:108-111` + `filterStaleTasks` 的 cosmeticOnly 降级 `lib/incremental.js:140-194` 内 `cosmeticOnly` 分支），0.13.3 用真实模型跑通 agentic 通道并修重复读抑制（`makeReadCodeTool` 的 `seen` 记账 `lib/agentic.js:115-177`）、MessageId 漂移（`toRequestMessages` `lib/agentic-host.js:34-79`）、探针三坑，0.13.4 修工具层四个实测翻车点（`MAX_READ_CHARS` `lib/agentic.js:96`、忽略目录 `IGNORED_DIRS` `lib/agentic.js:98`、负行号、`read_code` CRLF），0.13.5 新增 `pruneOrphanModules` 孤儿清理（`index.js:271-296`）与 `fixAnchors` 锚点就近绑定（`index.js:856-1073`，含 CHANGELOG 流水账节首重定位）。
- **阶段机无独立 plan 阶段（0.10.7 删）**：`STAGE_HANDLER`（`index.js:3482-3489`）为 `articles` → `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit`；模块划分在 `articles` 开头就地由 `buildPlan`（`index.js:2730-2753`）完成，`queued` 唤醒恒进 `articles`（`index.js:3540-3549`）。
- **三级装填预算**：普通单请求 110k（`BATCH_TOKEN_BUDGET` `index.js:663`）、兜底硬上限 128k（`BATCH_TOKEN_HARD_LIMIT` `index.js:668`）、大档预算 420k（`DEFAULT_BIG_TOKEN_BUDGET` `index.js:49`，默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` `index.js:50-51` = volces-ark/glm-5.3-flash 512k 上下文）。
- **双池并发（0.12.2）**：`runRealtimeTasks`（`index.js:591-651`）按任务装填时打的 `bigTier` 标记把大档与默认档请求拆进两个独立限流池、`Promise.all` 同时推进；agentic 通道同样接双池（`runAgenticArticles` `lib/articles-agentic.js:231-306` 的 `pools` 分池，`markBigAgenticTasks` `lib/articles-agentic.js:320-333` 打标，`startAgenticRun` `index.js:2676-2726` 传 `bigConcurrency`）。
- **提交是独立 commit 阶段（0.10.11）**：`tickCommit`（`index.js:3465-3480`）调 `autoCommitWiki`（`index.js:4655-4737`），走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」，失败降级不丢产物。
- **编译对象闸门（1.2.0/1.2.1）**：`detectLinkedWorktree`（`index.js:364-380`）拒绝 git worktree、`isDeadCompileTarget`（`index.js:433-441`）拒绝「无源码的空壳目录」，submit/面板/启动清理三处共用。
- **会话透明化（0.11.0/1.2.0）**：每个 LLM 请求的 prompt/输出落盘（`beginSessionRecord` `index.js:1984-2026`），跨任务聚合（`listAllSessionRecords` `index.js:1930-1950`）供面板全局「会话」Tab，保留 24h（`SESSION_TTL_MS` `index.js:1892`）。
- **多仓库并行（0.10.0/0.11.0）**：`serialProjects`（`index.js:83`）默认开 = 上限 1；关闭后按 `parallelProjects`（`index.js:84`），派生 `parallelLimit`（`index.js:125-129`）1–4 并行推进。

## Key Components

### `index.js`（宿主半侧中枢，4881 行）

入口与配置：

- `Config`（schema）：`index.js:70-96` —— 全部设置项（`enabled`/`binaryPath`/`batchProvider`/`batchModel`/`batchReasoningEffort`/`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`maxConcurrency`/`bigConcurrency`/`serialProjects`/`parallelProjects`/`articleLanguage`/`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`/`updateReminder`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`），全部 `volatile()`（改完即生效）。
- `liveConfig(config)`：`index.js:102-144` —— 把 `Config` 的 live 值夹到安全范围（并发 1–8、大档并发 0/未填回落默认档、`parallelLimit` 派生等）。
- `normalizeCwd(input)`：`index.js:59-64` —— Windows/Git-Bash 盘符路径归一（仅 win32）。
- `WIKI_PATHS` `index.js:55`（`['.codewiki', 'CodeWiki.md']`）—— 自动提交唯一 pathspec。
- `apply(ctx, config)`：`index.js:4817-4881` —— 插件入口：`ctx.inject(['agents'])`（`index.js:4818`）与 `ctx.inject(['llm'])`（`index.js:2295`）取服务引用，创建并启动服务（`createJobService`+`service.start()`，`index.js:4820-4821`），注册四个工具（`cwToolDefinition`/`generateToolDefinition`/`updateToolDefinition`→`updateDef`/`progressToolDefinition`，定义见 `cwToolDefinition` `index.js:1599`、`generateToolDefinition` `index.js:3714`、`updateToolDefinition` `index.js:4048`、`progressToolDefinition` `index.js:4119`；单工具 schema 违规只丢该工具，注册处 `index.js:4327-4343`）、挂 `installWebServer`（`index.js:4783` 定义，调用 `index.js:4831`）与 `installUpdateReminder`（`index.js:4826` 定义，调用 `index.js:4880`）、布 60s 心跳的自动更新调度 `autoScan`（`index.js:4831-4858`）。

编译请求与闸门：

- `runCw(binary, cwd, args, timeoutMs, signal)`：`index.js:172-197` —— 调 cw CLI 的 child 进程封装（kill SIGKILL 超时）。
- `normalizeArticlePath` `index.js:209` / `normalizeIndexLinks` `index.js:213` / `parseStatus`：`index.js:223-236` —— cw 三态输出（missing/uncompiled/clean/stale）解析。
- `pruneOrphanModules(job)`：`index.js:271-296` —— 全量编译后清理改名产生的孤儿模块文章（只删 `.codewiki/modules/*.md`，安全边界见 `index.js:253-270`）。
- `ensureWikiEntry(cwd, language)`：`index.js:301-334` —— 仓库根缺 `CodeWiki.md` 时自动生成（中文/英文两版，已有不覆盖）。
- `detectLinkedWorktree(cwd)` `index.js:364-380` / `isWorktreeCwd(cwd)`：`index.js:388-399` —— worktree 判定（`isWorktreeCwd` 带 60s 缓存）。
- `hasCompilableSources(cwd)` `index.js:407-421` / `clearSourceProbeCache`：`index.js:423-426` —— 源码探测（带 10min 缓存）。
- `isDeadCompileTarget(cwd)`：`index.js:433-441` —— worktree 或空壳目录的统一判定。

模型通道与装填：

- `llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta })`：`index.js:467-492` —— 唯一模型通道，带 `source: { kind: 'plugin:codewiki' }`、`temperature: 0`；`UNSUPPORTED_REASONING_EFFORT` 时剥档重试一次（`index.js:482-485`）。
- `runRealtimeTasks(tasks, {...})`：`index.js:591-651` —— 双池并发执行器（默认档/大档各一池，同时推进）。
- `estimateTokens(text)`：`index.js:449-457` —— CJK≈1 token/字、其余≈3.5 字符/token 的粗算。
- `numberLines(content)`：`index.js:679-681` —— 源码行号前缀（`N| `）注入。
- `fixAnchors(content, cwd)`：`index.js:856-1073` —— 落盘前 `file:NN(-MM)` 锚点确定性校正（子helpers：`repairUnclosedFrontmatter` `index.js:834-854`、`changelogSections` `index.js:699-707`、`fixChangelogAnchors` `index.js:709-825`、`validateArticleEnvelope` `index.js:1082-1089`）。
- `collectSources(cwd, files, budget)`：`index.js:1094-1121` —— 源文件按 token 预算整文件内联（超预算整任务转会话通道）。
- `prepareArticleTasks(tasks, {...})`：`index.js:1165-1250` —— 单轮通道批量请求装填（含 `markBig` 打大档标记、观察批拆分 `_split/`、合成批 `batchArticleComposePrompt`、超大文件 `emitSession` 转会话通道）。

规划：

- `shouldFallBackFromAgentic(results)`：`index.js:1293-1298` —— agentic 失败过半才算系统性失败。
- `localPlan(files)`：`index.js:1300-1313` —— 顶层目录分组（`slugify` 保留 CJK，`index.js:1670-1672`）。
- `semanticPlan(files, {...})`：`index.js:1322-1405` —— AST 提取 + LLM 聚类（`extractRepoGraph` 调用 `index.js:1341` 附近，`resolveImportEdges` 建边 `index.js:1358` 附近，`clusterComponents` 聚类 `index.js:1369` 附近），`plan.graph` 不带 `sourceCode`（`index.js:1388-1397`）。
- `slugify(name)`：`index.js:1670-1672` —— 模块名 → 文件 slug（保留 CJK）。
- `parseSourceFiles(fm)` `index.js:1676-1688` / `readSourceFiles(articlePath)`：`index.js:1690-1698` —— 读 frontmatter 的 `source_files`。
- `scanRepoFiles(cwd)`：`index.js:2121-2144` —— 仓库源码扫描（黑名单目录 + 二进制后缀 + 单文件 256KB + 总数 2000）。
- `extractCurrentGraph(cwd)`：`index.js:2149-2172` —— 当前代码的符号图（stale 增量与 index 快照共用）。

提示词模板（单轮/横切/校对）：`articleFormatSection()` `index.js:1256-1285`、`batchArticlePrompt` `index.js:1125-1152`、`packArticles` `index.js:1409-1428`、`batchArchitecturePrompt` `index.js:1444-1450`、`batchPatternsPrompt` `index.js:1452-1458`、`batchConceptPrompt` `index.js:1460-1466`、`batchObservePrompt` `index.js:1470-1487`、`batchArticleObservePrompt` `index.js:1491-1507`、`batchArticleComposePrompt` `index.js:1511-1539`、`batchProofreadPrompt` `index.js:1543-1562`、`batchProofreadBatchPrompt` `index.js:1566-1593`。

会话记录：`SESSIONS_DIR` `index.js:1893`、`beginSessionRecord(job, task)` `index.js:1984-2026`、`classifySessionTask` `index.js:2032-2042`、`buildSessionSteerText` `index.js:2049-2067`、`listAllSessionRecords` `index.js:1930-1950`、`pruneSessionRecords` `index.js:1952-1972`。

编排服务（`createJobService(config, onSettled)` `index.js:2295-3706`）：

- `JOBS_FILE` `index.js:1876`、`TICK_MS` `index.js:1877`、`MAX_JOBS_KEPT` `index.js:2070`、`ORPHAN_TAKEOVER_MS` `index.js:2069` 与 `acquireTickLock`/`saveJobs`/`mergeFromDisk` `index.js:2182-2196`/`index.js:2199-2204`/`index.js:2349-2370`。
- `setStage` `index.js:2386-2396`、`touch` `index.js:2381-2383`、`tally` `index.js:2550-2581`、`writeValidated` `index.js:2522-2539`、`settleJob` `index.js:2460-2490`、`shouldFallBackHere` `index.js:2585-2592`、`settleProofread` `index.js:2596-2620`。
- 执行器：`startBatchChatRun(job, prepared)` `index.js:2629-2671`、`startAgenticRun(job, tasks)` `index.js:2676-2726`、`buildPlan` `index.js:2730-2753`、`submitBatchFor` `index.js:2755-2789`、`dispatchSessionTasks` `index.js:2797-2831`、`progressSessionTasks` `index.js:2835-2854`、`resendSessionSteer` `index.js:2858-2871`。
- 阶段处理：`tickArticles` `index.js:2879-3074`、`tickCrosscut` `index.js:3098-3181`、`tickCompose` `index.js:3184-3196`、`submitComposeBatch` `index.js:3198-3208`、`localReview` `index.js:3211-3231`、`tickReview` `index.js:3233-3344`、`tickIndex` `index.js:3346-3463`、`tickCommit` `index.js:3465-3480`、`STAGE_HANDLER` `index.js:3482-3489`、`tick` `index.js:3491-3577`、`submit` `index.js:3579-3680`、`cancel` `index.js:3682-3691`。
- 工具定义：`cwToolDefinition` `index.js:1599-1662`、`generateToolDefinition` `index.js:3714-4038`、`updateToolDefinition` `index.js:4048-4100`、`progressToolDefinition` `index.js:4119-4223`。
- 面板后端 `installWebServer` `index.js:4327-4622`（端点 `/api/codewiki/jobs`、`/repos`、`/sessions`、`/sessions/item`、`/models`、`/model-efforts`、`/control`）；模型目录 `listModelCatalog` `index.js:4265-4286`、`resolveModelEfforts` `index.js:4303-4325`。
- 自动提交 `autoCommitWiki` `index.js:4655-4737`、`commitHintText` `index.js:4739-4770`、`reminderText` `index.js:4772-4781`、`installUpdateReminder` `index.js:4783-4815`。

### `lib/symbols.js`（AST 符号提取，885 行）

- `DEFAULT_VENDOR_DIR` `lib/symbols.js:25` —— web-tree-sitter 依赖的 vendor 子根（`vendor/tree-sitter`）。
- `LANG_RULES` `lib/symbols.js:36-271` —— 16 种语言的表驱动 AST 规则（js/ts/py/rs/go/java/c/cpp/c#/rb/php/kotlin/scala/dart/bash/lua）。
- `SUPPORTED_EXTS` `lib/symbols.js:273-276` —— 扩展名 → 语言映射。
- `REGEX_RULES` `lib/symbols.js:302-368` —— 16 种语言的正则降级规则；`regexExtract(relPath, content, lang)` `lib/symbols.js:374-440` 按行扫产出与 AST 同形状的符号记录（命中记 `stats.regex`）。
- `parseParamList(text)` `lib/symbols.js:443-466` —— 参数列表文本 → 参数名数组（AST/正则共用）。
- `class SymbolExtractor` `lib/symbols.js:472-779`：构造器 `lib/symbols.js:473-481`；`vendorImport` `lib/symbols.js:484-495`、`init` `lib/symbols.js:498-519`（web-tree-sitter 惰性导入）、`getParser(lang)` `lib/symbols.js:521-542`、`resolveWasmDir` `lib/symbols.js:544-547`、`extractFile` `lib/symbols.js:551-594`（AST 不可用降级正则）、`walk` `lib/symbols.js:597-695`（容器/函数/方法/箭头递归收集）、`findArrow`/`findDeclarator`/`stripCallSuffix`/`fieldText`/`parseParams`/`parseBases`/`sliceSource`/`extractDoc`/`componentId` `lib/symbols.js:697-779`。
- `extractRepoGraph(files, opts)` `lib/symbols.js:785-805` —— 批量提取，返回 `{ graph: Map<id,node>, byFile, skipped, extractor, ready, stats }`（节点 `id` 形如 `<相对路径>#<符号名>`）。
- `resolveImportEdges(graph, byFile, files)` `lib/symbols.js:810-833` —— 把 import 语句解析成本仓相对路径依赖边，落到节点 `dependsOn`；`extractImportSpecs` `lib/symbols.js:837-847`、`resolveSpec` `lib/symbols.js:849-884`。

### `lib/cluster.js`（LLM 语义聚类，468 行）

- `formatComponents`/`clusterPrompt`/`subClusterPrompt`/`superGroupPrompt` `lib/cluster.js:28-129` —— 提示词构造。
- `parseJsonLoose` `lib/cluster.js:135-153`、`parseClusterResponse` `lib/cluster.js:156-195`、`normalizeModuleName` `lib/cluster.js:198-206`、`guessPath` `lib/cluster.js:208-212`。
- `heuristicCluster(components)` `lib/cluster.js:219-244` —— 目录分组兜底（单顶层目录自动下探第二层）。
- `fillMissing` `lib/cluster.js:247-268`、`moduleFiles` `lib/cluster.js:274-281`。
- `clusterComponents(opts)` `lib/cluster.js:291-389` —— 主入口：顶层聚类 → 超大模块递归下钻（`subdivide` `lib/cluster.js:396-422`，`DEFAULT_MAX_DEPTH` 默认 2 `lib/cluster.js:287`）→ 顶层过多超级分组（`parseSuperGroups` `lib/cluster.js:425-456`）；返回 `{ modules: 叶子模块, tree, concepts, warnings, stats, byId }`。
- `toPlanModules(result)` `lib/cluster.js:460-467` —— 转 job.plan.modules 形状（`{ name, summary, files }`）。

### `lib/agentic.js`（agentic 工具循环纯逻辑，542 行）

- `TOOL_SCHEMAS` `lib/agentic.js:27-87` —— 四个工具定义：`read_code`/`list_files`/`edit_article`（`view`/`str_replace`/`insert`）/`generate_sub_module`。
- 常量 `MAX_READ_LINES=2000` `lib/agentic.js:98`、`MAX_READ_CHARS=40000` `lib/agentic.js:96`、`IGNORED_DIRS` `lib/agentic.js:98`。
- `numberLines(text)` `lib/agentic.js:101-106`、`makeReadCodeTool(workspace, {seen, getStep})` `lib/agentic.js:115-177`（重复读抑制，去重判定在读盘前）、`makeListFilesTool` `lib/agentic.js:179-197`、`makeArticleEditor(initial)` `lib/agentic.js:200-263`（CRLF 兼容的 str_replace/insert）、`safeRelPath` `lib/agentic.js:266-273`。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })` `lib/agentic.js:279-315` —— 工具调度表（`subModuleBlocked` 区分 `max-depth`/`unsupported` 如实报错）。
- `DEFAULT_MAX_STEPS = 30` `lib/agentic.js:325`（唯一定义点）。
- `runAgenticArticle(opts)` `lib/agentic.js:331-432` —— 循环本体：每步调 `streamFn` 拿 blocks、执行工具、结果回灌；返回 `{ article, steps, usedTools, stopReason, messages }`。
- `stripJsonFence` `lib/agentic.js:439-444`、`sliceBalancedObject` `lib/agentic.js:447-473`、`parseToolArgs` `lib/agentic.js:476-500`、`buildOpeningPrompt` `lib/agentic.js:506-541`。

### `lib/agentic-host.js`（agentic ↔ 宿主 llm 适配，136 行）

- `SOURCE = { kind: 'plugin:codewiki' }` `lib/agentic-host.js:15`。
- `toRequestMessages(messages, { provider, model })` `lib/agentic-host.js:34-79` —— 裸消息 ↔ 宿主正式 Message（WeakMap 缓存稳定 MessageId，`lib/agentic-host.js:26、34`）。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })` `lib/agentic-host.js:83-108` —— 返回 `(params) => { blocks, finish, usage }`，`temperature: 0`。
- `makeFsWorkspace(fs, path, cwd)` `lib/agentic-host.js:111-135` —— `readFile`/`listDir` 的 cwd 内路径抽象（越界抛错）。

### `lib/articles-agentic.js`（agentic 任务执行器，301 行）

- `DEFAULT_MAX_STEPS` 再导出 `lib/articles-agentic.js:20`。
- `runOneArticle(task, {...})` `lib/articles-agentic.js:32-152` —— 单篇跑一次 agentic 循环并落盘；内含 `dispatchSub` 子模块递归派发（`subDepth` 默认 2，`_depth >= subDepth` 时置 `null` 传 `subModuleBlocked='max-depth'`，`lib/articles-agentic.js:83-126`），落盘路径 `modules/<父 slug>/<子 slug>.md`；空文章记失败（`lib/articles-agentic.js:33-36`）。
- `sourceTokensOf(task, cwd, {...})` `lib/articles-agentic.js:185-203` —— 模块源文本量估算（与 `estimateTokens` 同口径）。
- `resolveTaskRoute(task, {...})` `lib/articles-agentic.js:208-222` —— 任务自带 provider/model 时完全以任务为准、不回落默认档 effort。
- `runAgenticArticles(tasks, {...})` `lib/articles-agentic.js:231-306` —— 双池并发（默认档 `concurrency`/大档 `bigConcurrency`），结果进 `Map(customId→结果)`，汇总 `subModules` 进 job note。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })` `lib/articles-agentic.js:320-333` —— 按源文本量超预算打大档标记（大档未配置原样返回）。

### `lib/graph-diff.js`（符号级增量 diff，579 行）

- 变更类常量 `CLASS_ADDED`/`CLASS_DELETED`/`CLASS_IFACE`/`CLASS_BODY`/`CLASS_EDGE`/`CLASS_RENAMED` `lib/graph-diff.js:14-19`、`DIFF_TRUNCATED_MARKER` `lib/graph-diff.js:21`。
- `stripComments(text)` `lib/graph-diff.js:69-100`、`stripTrailingComment` `lib/graph-diff.js:43-62`（五种行首注释 `LINE_COMMENT_MARKS`、块注释 `BLOCK_COMMENT_PAIRS`、行尾只认 `//`/`#`）。
- `codeHash(node)` `lib/graph-diff.js:108-111` —— 剥注释后的 sha1（0.13.2 加）；`documentedSource` `lib/graph-diff.js:114-119`、`bodyHash` `lib/graph-diff.js:121-126`、`signature`/`signatureChanged` `lib/graph-diff.js:128-145`。
- difflib 移植：`buildB2J`/`findLongestMatch`/`getMatchingBlocks`/`sequenceRatio` `lib/graph-diff.js:156-236`、`bodySimilarity` `lib/graph-diff.js:239-245`、`unifiedDiff`/`unifiedBodyDiff` `lib/graph-diff.js:327-362`、`pairRenames` `lib/graph-diff.js:371-407`（`DEFAULT_TAU_REN=0.8` `lib/graph-diff.js:358`、`DEFAULT_MAX_DIFF_TOKENS=2000` `lib/graph-diff.js:229`）。
- `emptyGraphDiff`/`graphDiffCounts`/`changedIds`/`isDiffEmpty` `lib/graph-diff.js:413-444`、`diffGraphs(oldGraph, newGraph, opts)` `lib/graph-diff.js:447-564`（六类变更 + renamed 配对）、`serializeDiff` `lib/graph-diff.js:567-578`。

### `lib/incremental.js`（快照存取 + 组件级过滤，207 行）

- `SNAPSHOT_VERSION=1` `lib/incremental.js:26`、`SNAPSHOT_REL='temp/symbol-graph.json'` `lib/incremental.js:22`、`SLIM_FIELDS` `lib/incremental.js:26`（不含 `sourceCode`）。
- `slimComponent` `lib/incremental.js:28-34`、`slimGraph(graph, { commit, now })` `lib/incremental.js:37-48`、`sameSnapshotContent` `lib/incremental.js:53-66`。
- `graphFromSnapshot(snap)` `lib/incremental.js:69-88`、`snapshotPath`/`loadSnapshot`/`saveSnapshot` `lib/incremental.js:90-115`、`normRel` `lib/incremental.js:118-120`、`componentsByFile` `lib/incremental.js:123-132`。
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)` `lib/incremental.js:140-194` —— 核心判定（纯函数）；`cosmeticOnly` 降级：bodyHash 变但 codeHash 没变且 docstring 没变的不重写（`lib/incremental.js:154-169`）；返回 `{ keep, dropped, change, counts, cosmeticOnly }`。
- `describeChange(counts)` `lib/incremental.js:197-206`。

### `client.js`（浏览器半侧，1681 行）

- `NS='codewiki'` `client.js:19`（设置命名空间）、`KEY='codewiki'` `client.js:23`、`PANEL_ORDER=52` `client.js:24`、端点常量 `JOBS_PATH`/`REPOS_PATH`/`SESSIONS_PATH`/`SESSIONS_ITEM_PATH`/`MODELS_PATH`/`EFFORTS_PATH` `client.js:27-35`、`ACTIVE_STAGES` `client.js:33`、`POLL_MS=2000` `client.js:26`。
- `CodewikiCard(props)` `client.js:550` 起 —— 设置表单（`view='summary'` 一行简介、`view='page'` 完整表单 + 保存条；含运行/编译模型/大档模型/编译流程/调度与排除五节，词典见 `client.js:39-119`）。
- `CodewikiPanel()` `client.js:1426-1671` —— 侧边栏任务列表（总览/任务/会话/设置四 Tab，2s 轮询 `POLL_MS` `client.js:22`）。
- `PanelIcon` `client.js:1688` 起的入口图标（`sidebar.panellist` 注册 `client.js:534-539`）。

## Architecture

```text
┌────────────────────────────┐    ┌───────────────────────┐
│ docs-and-meta              │    │ logs-and-temp         │
│ README CHANGELOG _index    │◄───│ *.log / .dsh-ops       │
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

- **`index.js`（宿主半侧中枢）**：入口 `apply`（`index.js:4817-4881`）注入 `agentsRef`（`index.js:2258`）与 `llmRef`（`index.js:2263`）、创建并启动服务（`index.js:1599-1600`）、注册四个工具（`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`，定义见 `cwToolDefinition` `index.js:3714`、`generateToolDefinition` `index.js:4048`、`updateToolDefinition` `index.js:4119`、`progressToolDefinition` `index.js:4327`，注册于 `index.js:4783-4799`）、挂 `installWebServer`（`index.js:4831` 定义，调用 `index.js:4879`）、布 `installUpdateReminder`（`index.js:4783` 定义，调用 `index.js:4880`）、启动 60s 心跳的自动更新调度 `autoScan`（`index.js:4831-4858`）。
- **`lib/`**：`symbols`（AST 提取 + 正则降级）、`cluster`（两阶段聚类 + 真递归下钻）、`agentic` + `agentic-host` + `articles-agentic`（工具循环写作）、`graph-diff` + `incremental`（符号级增量，含 `codeHash` 注释判定）；导入清单在 `index.js:16-24`，能力矩阵与降级路径见 `README.md:32-35`。
- **`client.js`（浏览器半侧）**：`window.__ModuleLoader__.load`（`client.js:10-12`）注册设置卡片 `CodewikiCard`（`client.js:550` 起，含运行/编译模型/大档模型/编译流程/调度与排除五节 + 保存条）与侧边栏 `CodewikiPanel`（`client.js:1426` 起：总览/任务/会话/设置四 Tab），入口图标 `PanelIcon`（`client.js:1688`，`PANEL_ORDER=52` `client.js:24`）。设置命名空间 `NS='codewiki'`（`client.js:19`）。
- **宿主服务依赖**：llm（唯一模型通道，凭证由宿主按 provider 解析，插件零密钥）、webServer（面板端点，仅回环 `isLoopbackRequest` `index.js:4229-4232`）、agents（编译终态 steer 唤醒与会话通道派发 `wakeCompileSession` `index.js:2278-2293`）、tools（工具注册）、workspaceRegistry（任务过滤，`wsFilterPaths` `index.js:4343-4358`）。
- **docs-and-meta**：README 是用户面文档，CHANGELOG 逐版本记录设计决策，`.codewiki/_index.md` 是仓库 wiki 的入口索引；**test-scripts** 直接 `import` 插件验证契约（`test-batch.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs` 等），`test-wiki-anchors.mjs` 守卫本仓文章的行号锚点（其符号提取规则与 `fixAnchors` `index.js:856-1073` 同源，见 `index.js:909` 注释）。

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

1. **提交入口与闸门**：会话调 `codewiki_generate`（`generateToolDefinition` `index.js:3714` 的 execute `index.js:3758-4036`）：`normalizeCwd`（`index.js:59`）→ 排除清单 `excludedItem`（`index.js:339`，调用在 `index.js:364`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:423`）→ 空壳闸门（`clearSourceProbeCache` `index.js:407` 清缓存 + `hasCompilableSources` `index.js:172` 判定，调用在 `index.js:223`）→ `cw status`（`runCw` `index.js:3694` 调用在 `index.js:1690`）→ `parseStatus`（`index.js:2149` 调用在 `index.js:21`）三态。幂等：同仓库活动任务直接返回（`findActive` `index.js:3579` 调用在 `index.js:2079`）；clean 短路（`index.js:2310`）；stale 按文章 frontmatter 的 `source_files`（`readSourceFiles` `index.js:2371` 调用在 `index.js:3491` 附近）逐篇预构建（`index.js:3875` 附近）——若 `symbolIncremental` 开启，用 `loadSnapshot`（调用在 `index.js:3863`）+ `extractCurrentGraph`（`index.js:4048`，调用在 `index.js:4825`）+ `graphFromSnapshot`（调用在 `index.js:3870`）+ `filterStaleTasks`（由 `planUpdate` 内部调用）做组件级过滤，全部滤掉则只刷新基线不重写（`index.js:4119` 附近）；missing 先 `cw init`（`index.js:4021`）再全量提交（`index.js:4028`）。`svc.submit`（`index.js:3579-3680`）再过三道闸（`index.js:3585-3602`）、`rememberRepo` 登记（`index.js:3603`）、落 `submitting` 占位（`index.js:3607-3642`）、编译模型三项校验（`index.js:3648-3651`，provider/model/llm 任一缺失即 fail 留痕）、排队判定后 `persist`+`flush`+立即 `tick`（`index.js:3677-3678`）。`codewiki_update`（`updateToolDefinition` `index.js:4048-4100`）是固定 scope=auto 的包装（`execute` `index.js:4088-4098` 复用 `generateDef.execute`）；`codewiki_progress`（`progressToolDefinition` `index.js:4119-4223`）只读查进度。

2. **项目闸门与排队**：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelLimit` 并行（`index.js:3505-3514`）。submit 把后到任务预置 `queued`（`index.js:3667-3671`，`pendingStage`/`pendingTasks` 寄存），`tick`（`index.js:3491-3577`）每轮先算 `activeIds` 集合（忙碌项优先、再按提交顺序唤醒最早 queued，`index.js:3506-3514`），轮到时落地预置字段（`index.js:3540-3549`）、非本轮项目跳过（`index.js:2411`）；取消不受闸门限制（`index.js:2069-2078`，中断在飞请求），且跨实例取消标记由 `syncCancelFlags`（`index.js:2411-2422`，调用在 `index.js:3501`）每轮拾取。另一实例停更超 `ORPHAN_TAKEOVER_MS`（`index.js:2069`，默认 5 分钟）即孤儿接管（`index.js:3521-3525`）。

3. **阶段机与持久化**：`STAGE_HANDLER`（`index.js:3482-3489`）按 articles（`tickArticles` `index.js:2879-3074`）→ crosscut（`tickCrosscut` `index.js:3098-3181`）→ compose（`tickCompose` `index.js:3184-3196`）→ review（`tickReview` `index.js:3233-3344`）→ index（`tickIndex` `index.js:3346-3463`）→ commit（`tickCommit` `index.js:3465-3480`）推进；`setStage`（`index.js:2386-2396`）统一计各阶段耗时。job 持久化 `JOBS_FILE`（`index.js:1876`，tick 默认 `TICK_MS` `index.js:1877` 10s），`saveJobs`（`index.js:2199-2204`）保留最近 `MAX_JOBS_KEPT`（`index.js:2070`）= 30 条；多实例安全靠 `mergeFromDisk`（`index.js:2349-2370`）磁盘吸收与 `acquireTickLock`（`index.js:2182-2196`）进程级推进锁。宿主重启由 `settleJob`（`index.js:2460-2490`）恢复：agentic 任务按 `agentic: true` 标记重跑（`index.js:2676-2682`，`startAgenticRun` `index.js:2676-2726`），其余按持久化 `batchPrompt` 快照重跑（`index.js:2481-2486`），都缺则 fail（`index.js:2488`）。旧 plan 阶段任务迁移到 articles（`index.js:3555-3561`）。

4. **规划（articles 开头就地）**：full 编译无 `job.plan` 时 `buildPlan`（调用在 `index.js:2994`）：`planMode=dirs` 直接 `localPlan`（`index.js:1300-1313`，dirs 分支 `index.js:1304`；`slugify` `index.js:1322-1324` 保留 CJK）；`planMode=auto`（默认）走 `semanticPlan`（`index.js:2730-2813`）——`extractRepoGraph` 提取全仓符号图（调用在 `index.js:1341`）、`resolveImportEdges` 建依赖边（调用在 `index.js:1358`）、`clusterComponents` 让模型按职责聚成层级模块树（调用在 `index.js:1369`）、`toPlanModules` 转模块清单（调用在 `index.js:1381`），组件图（**不含** `sourceCode`，`index.js:1385-1394`）与依赖边随 plan 持久化（`index.js:2745` 附近）供 stale 组件级比对；提取不可用/聚类失败/空结果均记 note 退回 `localPlan`（`index.js:2750` 附近）。

5. **文章阶段双通道**：`agenticArticles` 开（默认）时任务打 `agentic: true`（`index.js:2676`）并交 `startAgenticRun`（`index.js:87-137`，内部 `runAgenticArticles` 调用在 `index.js:2682`，单篇步数上限 `agenticMaxSteps` 传入在 `index.js:2692`），模型自己 `read_code`/`list_files`/`edit_article` 多轮增量写作，源码不整包内联，因此没有观察批装填链；0.13.3 起 `read_code` 带**重复读抑制**（`seen` 记账键为 `path + 起始行 + 结束行`，去重判定发生在读盘之前，`lib/agentic.js:115-177`），`DEFAULT_MAX_STEPS` 唯一定义在 `lib/agentic.js`（= 30，`lib/agentic.js:325`）。收割统一进 `tally`（`index.js:2550-2581`，`replace`/`mergeByName` 两个独立开关）。失败**严格过半**（`shouldFallBackFromAgentic` `index.js:1293-1298`）且本 job 未退回过（`shouldFallBackHere` `index.js:2585-2592`，守 `job.agenticRetried`）时，只把失败篇重排进旧通道重跑一次（`index.js:1165-1185`：失败篇收集在 `index.js:1177`，`prepareArticleTasks` 重装调用在 `index.js:1491`，置位 `index.js:2964`）。`agenticArticles` 关则走旧通道 `prepareArticleTasks`（`index.js:1511-1596`，调用在 `index.js:2797`）：整包装得下单请求直出（`index.js:87`），110k–大档预算区间升大档（`markBig` `index.js:87`，判定在 `index.js:1177`/`1211`），总量超大档预算才拆观察→合成（`index.js:1214-1247`；模板 `batchArticleObservePrompt` `index.js:1491-1507`/`batchArticleComposePrompt` `index.js:1511-1539`，收割重建合成批 `index.js:2915-2927`）；仅单文件连大档都装不下转会话通道（`index.js:1208`/`dispatchSessionTasks` `index.js:2797-2831`）。

6. **会话通道兜底**：`dispatchSessionTasks`（`index.js:2797-2831`）把完整写作指令写任务文件并 steer 发起会话派子智能体；每 tick 由 `progressSessionTasks`（`index.js:2835-2854`）按 `classifySessionTask`（`index.js:2032-2042`）三态收割（timeout/harvest/wait），steer 文案由 `buildSessionSteerText`（`index.js:2049-2067`）统一生成（`sessionTier` `index.js:2821` 非空时钉死档位）；宿主重启后 `resendSessionSteer`（`index.js:2858-2871`）重发一次。超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS` `index.js:1881`）按失败处理、不降级。

7. **模型调用与双池限流**：`runRealtimeTasks`（`index.js:591-651`）按 `bigTier` 标记分池（`index.js:105-120`；`bigConcurrency` 为 0/未填回落默认档 `index.js:1177-1185`），两池同时推进（`index.js:3278`）；大档任务自带 provider+model 时思考档位完全以任务为准、不回落普通档（`index.js:2755-2757`）。`bigTier` 三个来源：文章装填 `markBig`（`index.js:467-475`）、横切单批直出（`index.js:3153-3159`）、批量校对 `markBigTask`（`index.js:2676-2682`）；`submitBatchFor`（`index.js:2755-2789`）把 bigTier 连同模型信息持久化进 `job.tasks`（`index.js:2770-2776`），重启重跑不掉池。模型不支持所配思考档位时 `llmChat` 剥档重试一次（`index.js:481-484`）。agentic 通道同样分池：`markBigAgenticTasks`（`lib/articles-agentic.js:320-333`）按源文本量打标，`startAgenticRun` 传 `bigConcurrency`（`index.js:2688`）。

8. **落盘、横切与校对**：结果经 `applyTaskResult`（`index.js:553-576`）或 `writeValidated`（`index.js:2522-2539`）落盘，两者都先过 `fixAnchors`（`index.js:856-1073`）做行号锚点确定性校正；源码内联带 `numberLines`（`index.js:679-681`）行号前缀与 token 预算装填（`collectSources` `index.js:1094-1121`、`estimateTokens` `index.js:449-457`）。横切 `tickCrosscut`：总量 ≤ 大档预算（未配置大档则为 128k 硬上限）单批直出（`index.js:3098-3115`），否则每篇模块文章一个观察任务（`index.js:1470-1473`，模板 `batchObservePrompt` `index.js:3198-3215`）、合成批只吃观察（`submitComposeBatch` `index.js:1444-1454`）；产出 `_architecture`/`_patterns`/concepts（模板 `batchArchitecturePrompt` `index.js:1452-1458`、`batchPatternsPrompt` `index.js:1460-1466`、`batchConceptPrompt` `index.js:1409-1415`，输入装填 `packArticles` `index.js:3211-3230`）。审校为批量校对：`localReview`（`index.js:1566-1586`）本地核对后，多篇按 110k 贪心合并（`index.js:2596-2617`）提交 `batchProofreadBatchPrompt`（`index.js:1566-1593`），收割 `settleProofread`（`index.js:2596-2620`）按 `@@@article`/`
