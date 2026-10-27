---
title: System Architecture Overview
type: architecture
source_files:
  - package.json
  - cordis.patch.yml
  - index.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/graph-diff.js
  - lib/incremental.js
  - client.js
  - README.md
  - CHANGELOG.md
  - .codewiki/_index.md
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接, 编译流水线, 吸收自FSoft]
---

## Overview

本文件是 `@local/dsh-codewiki`（当前版本 0.13.5，`package.json:3`）的系统总览，写给对仓库零上下文的未来 agent。插件把 Rust CLI `cw`（来自 mraza007/codewiki，`README.md:3`）接入 DeepSeek Harness，提供仓库内活 wiki（`<repo>/.codewiki/`，随仓库提交共享）的编译、更新与进度查询。全部模型环节在插件内完成、零子代理：模型调用唯一通道是 `llmChat`（`index.js:452-477`），它经宿主 `llm.stream()` 发请求，请求带 `source: { kind: 'plugin:codewiki' }` 与 `temperature: 0`；编译由宿主常驻服务 `createJobService`（`index.js:1774-3070`）以 10s tick（`TICK_MS`，`index.js:1374`）阶段机推进。

仓库由四部分组成：**core-and-config**（`index.js` 宿主半侧单文件 4132 行 + `lib/` 七个吸收模块 + `client.js` 浏览器半侧 + `cordis.patch.yml`/`package.json`/`.gitignore`）、**docs-and-meta**（`README.md`/`CHANGELOG.md`/`.codewiki/_index.md` 等；无独立 `CodeWiki.md` 入口文件，入口由流水线在缺省时自动生成，见 `ensureWikiEntry` `index.js:286-319`）、**test-scripts**（`test-*.mjs` 回归脚本）、**logs-and-temp**（运行时日志与 `.dsh-ops/`）。挂载方式是 `cordis.patch.yml:19-24` 的 `insert` 条目（id `codewiki`，本地开发走 `file:///` 直挂，`config: {}` 表示全部用 `Config` schema 默认值，`cordis.patch.yml:22`）。

当前版本（0.13.5）的关键形态：

- **四层吸收能力（0.13.0）**：AST 符号提取（`extractRepoGraph` `lib/symbols.js:785-805`，AST 不可用时正则降级 `regexExtract` `lib/symbols.js:374-440`）、LLM 语义聚类模块划分（`clusterComponents` `lib/cluster.js:291-389`，真递归下钻 `subdivide` `lib/cluster.js:396-422`）、agentic 工具循环写作（`runAgenticArticles` `lib/articles-agentic.js:204-279`，工具定义 `TOOL_SCHEMAS` `lib/agentic.js:27-87`）、符号级增量判定（`filterStaleTasks`/`slimGraph`/`graphFromSnapshot` `lib/incremental.js`）。全部用 Node + tree-sitter WASM 实现，不引 Python 运行时（依赖落在 `vendor/tree-sitter/`，`README.md:32`）。三个开关 `planMode`（`index.js:76`）、`agenticArticles`（`index.js:77`，步数上限 `agenticMaxSteps` `index.js:78`）、`symbolIncremental`（`index.js:79`）默认全开（`cordis.patch.yml:14-18`），任一环节失败自动降级。0.13.1 把 `generate_sub_module` 子模块递归成文真正接进生产链路（`runOneArticle` 的 `dispatchSub` `lib/articles-agentic.js:74-117`），0.13.2 修掉 `subDepth` 递归封顶（`lib/articles-agentic.js:74-110`）并加 `codeHash` 纯注释判定（`codeHash` `lib/graph-diff.js:108-111` + `filterStaleTasks` 的 cosmeticOnly 降级 `lib/incremental.js:140-156`），0.13.3 用真实模型跑通 agentic 通道并修重复读抑制（`makeReadCodeTool` 的 `seen` 记账 `lib/agentic.js:115-177` 起）、MessageId 漂移（`toRequestMessages` `lib/agentic-host.js:34-79`）、探针三坑，0.13.4 修工具层四个实测翻车点（CRLF 行尾匹配、`read_code` 字符上限 `MAX_READ_CHARS` `lib/agentic.js:96`、忽略目录 `IGNORED_DIRS` `lib/agentic.js:98`、负行号），0.13.5 新增 `pruneOrphanModules` 孤儿清理（`index.js:259-281`）与 `fixAnchors` 锚点就近绑定（`index.js:608-730`）。
- **阶段机无独立 plan 阶段（0.10.7 删）**：`STAGE_HANDLER`（`index.js:2861-2868`）为 `articles` → `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `commit`；模块划分在 `articles` 开头就地由 `buildPlan`（`index.js:2161-2184`）完成，`queued` 唤醒恒进 `articles`（`index.js:2919-2926`）。
- **三级装填预算**：普通单请求 110k（`BATCH_TOKEN_BUDGET` `index.js:581`）、兜底硬上限 128k（`BATCH_TOKEN_HARD_LIMIT` `index.js:586`）、大档预算 420k（`DEFAULT_BIG_TOKEN_BUDGET` `index.js:42`，默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL` `index.js:39-40` = volces-ark/glm-5.3-flash 512k 上下文）。
- **双池并发（0.12.2）**：`runRealtimeTasks`（`index.js:509-568`）按任务装填时打的 `bigTier` 标记把大档与默认档请求拆进两个独立限流池、`Promise.all` 同时推进；agentic 通道同样接双池（`runAgenticArticles` `lib/articles-agentic.js:204-279` 的 `pools` 分池，`markBigAgenticTasks` `lib/articles-agentic.js:287-300` 打标，`startAgenticRun` `index.js:2110-2157` 传 `bigConcurrency`）。
- **提交是独立 commit 阶段（0.10.11）**：`tickCommit`（`index.js:2843-2859`）调 `autoCommitWiki`（`index.js:3906-3988`），走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」，失败降级不丢产物。
- **编译对象闸门（1.2.0/1.2.1）**：`detectLinkedWorktree`（`index.js:349-365`）拒绝 git worktree、`isDeadCompileTarget`（`index.js:418-426`）拒绝「无源码的空壳目录」，submit/面板/启动清理三处共用。
- **会话透明化（0.11.0/0.12.0）**：每个 LLM 请求的 prompt/输出落盘（`beginSessionRecord` `index.js:1481-1523`），跨任务聚合（`listAllSessionRecords` `index.js:1427-1447`）供面板全局「会话」Tab，保留 24h（`SESSION_TTL_MS` `index.js:1389`）。
- **多仓库并行（0.10.0/0.11.0）**：`serialProjects`（`index.js:73`）默认开 = 上限 1；关闭后按 `parallelProjects`（`index.js:74`），派生 `parallelLimit`（`index.js:115-119`）1–4 并行推进。

## Key Components

### `index.js`（宿主半侧中枢，4132 行）

入口与配置：

- `Config`（schema）：`index.js:60-86` —— 全部设置项（`enabled`/`binaryPath`/`batchProvider`/`batchModel`/`batchReasoningEffort`/`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`maxConcurrency`/`bigConcurrency`/`serialProjects`/`parallelProjects`/`articleLanguage`/`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`/`updateReminder`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly`），全部 `volatile()`（改完即生效）。
- `liveConfig(config)`：`index.js:92-134` —— 把 `Config` 的 live 值夹到安全范围（并发 1–8、大档并发 0/未填回落默认档、`parallelLimit` 派生等）。
- `normalizeCwd(input)`：`index.js:49-54` —— Windows/Git-Bash 盘符路径归一（仅 win32）。
- `apply(ctx, config)`：`index.js:4068-4132` —— 插件入口：`ctx.inject(['agents'])`（`index.js:4069`）与 `ctx.inject(['llm'])`（`index.js:4070`）取服务引用，创建并启动服务（`createJobService`+`service.start()`，`index.js:4071-4072`），注册四个工具（`cwToolDefinition`/`generateToolDefinition`/`updateToolDefinition`/`progressToolDefinition`，`index.js:4113-4129`，单工具 schema 违规只丢该工具 `index.js:4116-4128`）、挂 `installWebServer`（`index.js:4130`）与 `installUpdateReminder`（`index.js:4131`）、与 60s 心跳的自动更新调度 `autoScan`（`index.js:4082-4111`）。

编译请求与闸门：

- `runCw(binary, cwd, args, timeoutMs, signal)`：`index.js:162-187` —— 调 cw CLI 的 child 进程封装（kill SIGKILL 超时）。
- `normalizeArticlePath` / `normalizeIndexLinks` / `parseStatus`：`index.js:199-226` —— cw 三态输出（missing/uncompiled/clean/stale）解析。
- `pruneOrphanModules(job)`：`index.js:259-281` —— 全量编译后清理改名产生的孤儿模块文章（只删 `.codewiki/modules/*.md`），安全边界见注释 `index.js:259-266`。
- `ensureWikiEntry(cwd, language)`：`index.js:286-319` —— 仓库根缺 `CodeWiki.md` 时自动生成（中文/英文两版，已有不覆盖）。
- `detectLinkedWorktree(cwd)` / `isWorktreeCwd(cwd)`：`index.js:349-365` / `index.js:373-384` —— worktree 判定（带 60s 缓存）。
- `hasCompilableSources(cwd)` / `clearSourceProbeCache`：`index.js:392-411` —— 源码探测（带 10min 缓存）。
- `isDeadCompileTarget(cwd)`：`index.js:418-426` —— worktree 或空壳目录的统一判定。

模型通道与装填：

- `llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta })`：`index.js:452-477` —— 唯一模型通道，带 `source: { kind: 'plugin:codewiki' }`、`temperature: 0`；`UNSUPPORTED_REASONING_EFFORT` 时剥档重试一次（`index.js:452-456`）。
- `runRealtimeTasks(tasks, {...})`：`index.js:509-568` —— 双池并发执行器（默认档/大档各一池，同时推进）。
- `estimateTokens(text)`：`index.js:434-442` —— CJK≈1 token/字、其余≈3.5 字符/token 的粗算。
- `numberLines(content)`：`index.js:597-599` —— 源码行号前缀（`N| `）注入。
- `fixAnchors(content, cwd)`：`index.js:608-730` —— 落盘前 `file:NN(-MM)` 锚点确定性校正（就近绑定，倒序区间 `Math.abs` 翻正）。
- `collectSources(cwd, files, budget)`：`index.js:735-762` —— 源文件按 token 预算整文件内联（超预算整任务转会话通道）。
- `prepareArticleTasks(tasks, {...})`：`index.js:806-891` —— 单轮通道批量请求装填（含 `markBig` 打大档标记、观察批拆分 `_split/`、`emitSession` 转会话通道）。

规划：

- `shouldFallBackFromAgentic(results)`：`index.js:934-939` —— agentic 失败过半才算系统性失败。
- `localPlan(files)`：`index.js:941-954` —— 顶层目录分组（`slugify` 保留 CJK，`index.js:1311-1313`）。
- `semanticPlan(files, {...})`：`index.js:963-1046` —— AST 提取 + LLM 聚类（`extractRepoGraph` 调用 `index.js:982`，`resolveImportEdges` 建边 `index.js:999`，`clusterComponents` 聚类 `index.js:1010`），`plan.graph` 不带 `sourceCode`（`index.js:1029-1038`）。
- `slugify(name)`：`index.js:1311-1313` —— 模块名 → 文件 slug（保留 CJK）。
- `parseSourceFiles(fm)` / `readSourceFiles(articlePath)`：`index.js:1317-1339` —— 读 frontmatter 的 `source_files`。

提示词模板（单轮/横切/校对）：`articleFormatSection()` `index.js:897-926`、`batchArticlePrompt` `index.js:766-793`、`packArticles` `index.js:1050-1069`、`batchArchitecturePrompt` `index.js:1085-1091`、`batchPatternsPrompt` `index.js:1093-1099`、`batchConceptPrompt` `index.js:1101-1107`、`batchObservePrompt` `index.js:1111-1128`、`batchArticleObservePrompt` `index.js:1132-1148`、`batchArticleComposePrompt` `index.js:1152-1180`、`batchProofreadPrompt` `index.js:1184-1203`、`batchProofreadBatchPrompt` `index.js:1207-1234`。

会话记录：`SESSIONS_DIR` `index.js:1390`、`beginSessionRecord(job, task)` `index.js:1481-1523`、`classifySessionTask` `index.js:1529-1539`、`buildSessionSteerText` `index.js:1546-1564`、`listAllSessionRecords` `index.js:1427-1447`、`pruneSessionRecords` `index.js:1449-1469`。

编排服务（`createJobService(config, onSettled)` `index.js:1774-3070`）：

- `JOBS_FILE` `index.js:1373`、`TICK_MS` `index.js:1374`、`MAX_JOBS_KEPT` `index.js:1567` 与 `acquireTickLock`/`saveJobs`/`mergeFromDisk` `index.js:1669-1691`/`index.js:1828-1849`。
- `setStage` `index.js:1865-1875`、`touch` `index.js:1860-1862`、`tally` `index.js:1984-2015`、`writeValidated` `index.js:1949-1973`、`settleJob` `index.js:1914-1944`、`shouldFallBackHere` `index.js:2019-2026`。
- `startBatchChatRun(job, prepared)` `index.js:2063-2105`、`startAgenticRun(job, tasks)` `index.js:2110-2157`、`submitBatchFor` `index.js:2186-2220`、`dispatchSessionTasks` `index.js:2228-2262`、`progressSessionTasks` `index.js:2266-2285`、`resendSessionSteer` `index.js:2289-2302`。
- 阶段处理：`tickArticles` `index.js:2310-2502`、`tickCrosscut` `index.js:2526-2609`、`tickCompose` `index.js:2612-2624`、`tickReview` `index.js:2661-2772`、`tickIndex` `index.js:2774-2841`、`tickCommit` `index.js:2843-2859`、`STAGE_HANDLER` `index.js:2861-2868`、`tick` `index.js:2870-2956`、`submit` `index.js:2958-3043`、`cancel` `index.js:3045-3054`。
- 工具定义：`cwToolDefinition` `index.js:1240-1303`、`generateToolDefinition` `index.js:3077-3289`、`updateToolDefinition` `index.js:3299-3351`、`progressToolDefinition` `index.js:3370-3473`。
- 面板后端 `installWebServer` `index.js:3578-3873`（`/api/codewiki/jobs`、`/repos`、`/sessions`、`/sessions/item`、`/models`、`/model-efforts`、`/control`）；模型目录 `listModelCatalog` `index.js:3516-3537`、`resolveModelEfforts` `index.js:3554-3576`。
- 自动提交 `autoCommitWiki` `index.js:3906-3988`、`commitHintText` `index.js:3990-4021`、`reminderText` `index.js:4023-4032`、`installUpdateReminder` `index.js:4034-4066`；`WIKI_PATHS` `index.js:45`（`['.codewiki', 'CodeWiki.md']`）。

### `lib/symbols.js`（AST 符号提取，884 行）

- `DEFAULT_VENDOR_DIR` `lib/symbols.js:25` —— web-tree-sitter 依赖的 vendor 子根。
- `LANG_RULES` `lib/symbols.js:36-271` —— 16 种语言的表驱动 AST 规则（js/ts/py/rs/go/java/c/cpp/c#/rb/php/kotlin/scala/dart/bash/lua）。
- `SUPPORTED_EXTS` `lib/symbols.js:273-276` —— 扩展名 → 语言映射。
- `REGEX_RULES` `lib/symbols.js:302-368` —— 16 种语言的正则降级规则；`regexExtract(relPath, content, lang)` `lib/symbols.js:374-440` 按行扫产出与 AST 同形状的符号记录（命中记 `stats.regex`）。
- `parseParamList(text)` `lib/symbols.js:443-466` —— 参数列表文本 → 参数名数组（AST/正则共用）。
- `class SymbolExtractor` `lib/symbols.js:472-779`：构造器 `lib/symbols.js:473-481`；`vendorImport` `lib/symbols.js:484-495`、`init` `lib/symbols.js:498-519`（`web-tree-sitter` 惰性导入）、`getParser(lang)` `lib/symbols.js:521-542`、`resolveWasmDir` `lib/symbols.js:544-547`、`extractFile` `lib/symbols.js:551-594`（AST 不可用降级正则）、`walk` `lib/symbols.js:597-695`（容器/函数/方法/箭头递归收集）、`findArrow`/`findDeclarator`/`stripCallSuffix`/`fieldText`/`parseParams`/`parseBases`/`sliceSource`/`extractDoc`/`componentId` `lib/symbols.js:697-779`。
- `extractRepoGraph(files, opts)` `lib/symbols.js:785-805` —— 批量提取，返回 `{ graph: Map<id,node>, byFile, skipped, extractor, ready, stats }`（节点 `id` 形如 `<相对路径>#<符号名>`）。
- `resolveImportEdges(graph, byFile, files)` `lib/symbols.js:810-833` —— 把 import 语句解析成本仓相对路径依赖边，落到节点 `dependsOn`；`extractImportSpecs` `lib/symbols.js:837-847`、`resolveSpec` `lib/symbols.js:849-884`。

### `lib/cluster.js`（LLM 语义聚类，468 行）

- `formatComponents`/`clusterPrompt`/`subClusterPrompt`/`superGroupPrompt` `lib/cluster.js:28-129` —— 提示词构造。
- `parseJsonLoose` `lib/cluster.js:135-153`、`parseClusterResponse` `lib/cluster.js:156-195`、`normalizeModuleName` `lib/cluster.js:198-206`。
- `heuristicCluster(components)` `lib/cluster.js:219-244` —— 目录分组兜底（单顶层目录自动下探第二层）。
- `fillMissing` `lib/cluster.js:247-268`、`moduleFiles` `lib/cluster.js:274-281`。
- `clusterComponents(opts)` `lib/cluster.js:291-389` —— 主入口：顶层聚类 → 超大模块递归下钻（`subdivide` `lib/cluster.js:396-422`，`maxDepth` 默认 2）→ 顶层过多超级分组（`parseSuperGroups` `lib/cluster.js:425-456`）；返回 `{ modules: 叶子模块, tree, concepts, warnings, stats, byId }`。
- `toPlanModules(result)` `lib/cluster.js:460-467` —— 转 job.plan.modules 形状（`{ name, summary, files }`）。

### `lib/agentic.js`（agentic 工具循环纯逻辑，542 行）

- `TOOL_SCHEMAS` `lib/agentic.js:27-87` —— 四个工具定义：`read_code`/`list_files`/`edit_article`（`view`/`str_replace`/`insert`）/`generate_sub_module`。
- 常量 `MAX_READ_LINES=2000` `lib/agentic.js:98`、`MAX_READ_CHARS=40000` `lib/agentic.js:98`、`IGNORED_DIRS` `lib/agentic.js:98`。
- `numberLines(text)` `lib/agentic.js:101-106`、`makeReadCodeTool(workspace, {seen, getStep})` `lib/agentic.js:115-177`（重复读抑制，去重判定在读盘前）、`makeListFilesTool` `lib/agentic.js:179-197`、`makeArticleEditor(initial)` `lib/agentic.js:200-263`（CRLF 兼容的 str_replace/insert）、`safeRelPath` `lib/agentic.js:266-273`。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })` `lib/agentic.js:279-315` —— 工具调度表（`subModuleBlocked` 区分 `max-depth`/`unsupported` 如实报错）。
- `DEFAULT_MAX_STEPS = 30` `lib/agentic.js:325`（唯一定义点）。
- `runAgenticArticle(opts)` `lib/agentic.js:331-432` —— 循环本体：每步调 `streamFn` 拿 blocks、执行工具、结果回灌；返回 `{ article, steps, usedTools, stopReason, messages }`。
- `stripJsonFence` `lib/agentic.js:439-444`、`sliceBalancedObject` `lib/agentic.js:447-473`、`parseToolArgs` `lib/agentic.js:476-500`、`buildOpeningPrompt` `lib/agentic.js:506-541`。

### `lib/agentic-host.js`（agentic ↔ 宿主 llm 适配，135 行）

- `SOURCE = { kind: 'plugin:codewiki' }` `lib/agentic-host.js:15`。
- `toRequestMessages(messages, { provider, model })` `lib/agentic-host.js:34-79` —— 裸消息 ↔ 宿主正式 Message（WeakMap 缓存稳定 MessageId，`lib/agentic-host.js:34`）。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })` `lib/agentic-host.js:83-108` —— 返回 `(params) => { blocks, finish, usage }`，`temperature: 0`。
- `makeFsWorkspace(fs, path, cwd)` `lib/agentic-host.js:111-135` —— `readFile`/`listDir` 的 cwd 内路径抽象（越界抛错）。

### `lib/articles-agentic.js`（agentic 任务执行器，301 行）

- `DEFAULT_MAX_STEPS` 再导出 `lib/articles-agentic.js:20`。
- `runOneArticle(task, {...})` `lib/articles-agentic.js:32-152` —— 单篇跑一次 agentic 循环并落盘；内含 `dispatchSub` 子模块递归派发（`subDepth` 默认 2，`_depth >= subDepth` 时置 `null` 传 `subModuleBlocked='max-depth'`，`lib/articles-agentic.js:74-117`），落盘路径 `modules/<父 slug>/<子 slug>.md`（`lib/articles-agentic.js:32`）；空文章记失败（`lib/articles-agentic.js:32-35`）。
- `sourceTokensOf(task, cwd, {...})` `lib/articles-agentic.js:158-176` —— 模块源文本量估算（与 `estimateTokens` 同口径）。
- `resolveTaskRoute(task, {...})` `lib/articles-agentic.js:181-195` —— 任务自带 provider/model 时完全以任务为准、不回落默认档 effort。
- `runAgenticArticles(tasks, {...})` `lib/articles-agentic.js:204-279` —— 双池并发（默认档 `concurrency`/大档 `bigConcurrency`），结果进 `Map(customId→结果)`，汇总 `subModules` 进 job note。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })` `lib/articles-agentic.js:287-300` —— 按源文本量超预算打大档标记（大档未配置原样返回）。

### `lib/graph-diff.js`（符号级增量 diff，579 行）

- 变更类常量 `CLASS_ADDED`/`CLASS_DELETED`/`CLASS_IFACE`/`CLASS_BODY`/`CLASS_EDGE`/`CLASS_RENAMED` `lib/graph-diff.js:14-19`、`DIFF_TRUNCATED_MARKER` `lib/graph-diff.js:21`。
- `stripComments(text)` `lib/graph-diff.js:69-100`、`stripTrailingComment` `lib/graph-diff.js:43-62`（五种行首注释 `LINE_COMMENT_MARKS`、块注释 `BLOCK_COMMENT_PAIRS`、行尾只认 `//`/`#`）。
- `codeHash(node)` `lib/graph-diff.js:108-111` —— 剥注释后的 sha1（0.13.2 加）；`documentedSource` `lib/graph-diff.js:114-119`、`bodyHash` `lib/graph-diff.js:121-126`、`signature`/`signatureChanged` `lib/graph-diff.js:128-145`。
- difflib 移植：`buildB2J`/`findLongestMatch`/`getMatchingBlocks`/`sequenceRatio` `lib/graph-diff.js:156-236`、`bodySimilarity` `lib/graph-diff.js:239-245`、`unifiedDiff`/`unifiedBodyDiff` `lib/graph-diff.js:327-362`、`pairRenames` `lib/graph-diff.js:371-407`。
- `emptyGraphDiff`/`graphDiffCounts`/`changedIds`/`isDiffEmpty` `lib/graph-diff.js:413-444`、`diffGraphs(oldGraph, newGraph, opts)` `lib/graph-diff.js:447-564`（六类变更 + renamed 配对）、`serializeDiff` `lib/graph-diff.js:567-578`。

### `lib/incremental.js`（快照存取 + 组件级过滤，206 行）

- `SNAPSHOT_VERSION=1` `lib/incremental.js:26`、`SNAPSHOT_REL='temp/symbol-graph.json'` `lib/incremental.js:26`、`SLIM_FIELDS` `lib/incremental.js:26`（不含 `sourceCode`）。
- `slimComponent` `lib/incremental.js:28-34`、`slimGraph(graph, { commit, now })` `lib/incremental.js:37-48`、`sameSnapshotContent` `lib/incremental.js:53-66`。
- `graphFromSnapshot(snap)` `lib/incremental.js:69-88`、`snapshotPath`/`loadSnapshot`/`saveSnapshot` `lib/incremental.js:90-115`、`normRel` `lib/incremental.js:118-120`、`componentsByFile` `lib/incremental.js:123-132`。
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)` `lib/incremental.js:140-194` —— 核心判定（纯函数）；`cosmeticOnly` 降级：bodyHash 变但 codeHash 没变且 docstring 没变的不重写（`lib/incremental.js:154-170`）；返回 `{ keep, dropped, change, counts, cosmeticOnly }`。
- `describeChange(counts)` `lib/incremental.js:197-206`。

### `client.js`（浏览器半侧，1681 行）

- `NS='codewiki'` `client.js:19`（设置命名空间）、`KEY='codewiki'` `client.js:19`、`PANEL_ORDER=52` `client.js:19`、端点常量 `JOBS_PATH`/`REPOS_PATH`/`SESSIONS_PATH`/`MODELS_PATH`/`EFFORTS_PATH` `client.js:19-27`、`ACTIVE_STAGES` `client.js:33`。
- `CodewikiCard(props)` `client.js:548` 起 —— 设置表单（`view='summary'` 一行简介、`view='page'` 完整表单 + 保存条；含运行/编译模型/大档模型/编译流程/调度与排除五节）。
- `CodewikiPanel()` `client.js:1418-1663` —— 侧边栏任务列表（总览/任务/会话/设置四 Tab，2s 轮询 `POLL_MS` `client.js:22`）。
- `PanelIcon` `client.js:1665` 起的入口图标（`sidebar.panellist` 注册 `client.js:534-539`）。

## Architecture

```text
┌────────────────────────────┐    ┌───────────────────────┐
│ docs-and-meta              │    │ logs-and-temp         │
│ README/CHANGELOG/_index    │◄───│ *.log / .dsh-ops       │
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

- **`index.js`（宿主半侧中枢）**：入口 `apply`（`index.js:4068-4132`）注入 `agentsRef`（`index.js:4069`）与 `llmRef`（`index.js:4070`）、创建并启动服务（`index.js:4068-4069`）、注册四个工具（`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`，`index.js:4068-4084`）、挂 `installWebServer`（`index.js:4130`）、布 `installUpdateReminder`（`index.js:4131`）、启动 60s 心跳的自动更新调度 `autoScan`（`index.js:4082-4111`）。
- **`lib/`**：`symbols`（AST 提取 + 正则降级）、`cluster`（两阶段聚类 + 真递归下钻）、`agentic` + `agentic-host` + `articles-agentic`（工具循环写作）、`graph-diff` + `incremental`（符号级增量，含 `codeHash` 注释判定）；导入清单在 `index.js:16-24`，能力矩阵与降级路径见 `README.md:32-37`。
- **`client.js`（浏览器半侧）**：`window.__ModuleLoader__.load`（`client.js:10-12`）注册设置卡片 `CodewikiCard`（`client.js:548` 起，含运行/编译模型/大档模型/编译流程/调度与排除五节 + 保存条）与侧边栏 `CodewikiPanel`（`client.js:1418` 起：总览/任务/会话/设置四 Tab），入口图标 `PanelIcon`（`client.js:548-553`，`PANEL_ORDER=52` `client.js:548`）。设置命名空间 `NS='codewiki'`（`client.js:548`）。
- **宿主服务依赖**：llm（唯一模型通道，凭证由宿主按 provider 解析，插件零密钥）、webServer（面板端点）、agents（编译终态 steer 唤醒与会话通道派发）、tools（工具注册）、workspaceRegistry（任务过滤，`wsFilterPaths` `index.js:3594-3609`）。
- **docs-and-meta**：README 是用户面文档，CHANGELOG 逐版本记录设计决策，`.codewiki/_index.md` 是仓库 wiki 的入口索引；**test-scripts** 直接 `import` 插件验证契约（`test-batch.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs` 等），`test-wiki-anchors.mjs` 守卫本文这类 wiki 文章的行号锚点（其符号提取规则与 `fixAnchors` `index.js:608-730` 同源）。

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

1. **提交入口与闸门**：会话调 `codewiki_generate`（`generateToolDefinition` `index.js:3077-3289` 的 execute `index.js:3077-3243`）：`normalizeCwd`（`index.js:49-54`，调用在 `index.js:3125`）→ 排除清单 `excludedItem`（`index.js:324-333`，调用在 `index.js:3127`）→ worktree 闸门（`detectLinkedWorktree` 调用在 `index.js:3132`）→ 空壳闸门（`clearSourceProbeCache` `index.js:408-411` 清缓存 + `hasCompilableSources` `index.js:392-406` 判定，`index.js:3146-3153`）→ `cw status`（`runCw` `index.js:162-187` 调用在 `index.js:3160`）→ `parseStatus`（`index.js:213-226`）三态（调用在 `index.js:3165`）。幂等：同仓库活动任务直接返回（`findActive` `index.js:3057` 调用在 `index.js:3171`）；clean 短路（`index.js:3077-3080`）；stale 按文章 frontmatter 的 `source_files`（`parseSourceFiles` `index.js:1317-1329`）逐篇预构建（`index.js:3077-3093`）——若 `symbolIncremental` 开启，用 `loadSnapshot`（调用在 `index.js:3220`）+ `extractCurrentGraph`（`index.js:1642-1659`，调用在 `index.js:3224`）+ `graphFromSnapshot`（调用在 `index.js:3228`）+ `filterStaleTasks`（调用在 `index.js:3229`）做组件级过滤，全部滤掉则只刷新基线不重写（`index.js:3077-3083`）；missing 先 `cw init`（`index.js:3077-3083`）再全量提交（`index.js:3279-3286`）。`svc.submit`（`index.js:2958-3043`）再过三道闸（`index.js:2960-2981`）、`rememberRepo` 登记（`index.js:2982`）、落 `submitting` 占位（`index.js:2985-3006`）、编译模型三项校验（`index.js:3077-3086`，provider/model/llm 任一缺失即 fail 留痕）、排队判定后 `persist`+`flush`+立即 `tick`（`index.js:3039-3041`）。`codewiki_update`（`updateToolDefinition` `index.js:3299-3351`）是固定 scope=auto 的包装；`codewiki_progress`（`progressToolDefinition` `index.js:3370-3473`）只读查进度。

2. **项目闸门与排队**：`serialProjects` 默认开（串行=上限 1），关闭后按 `parallelLimit` 并行。submit 把后到任务预置 `queued`（`index.js:2884-2893`，`pendingStage`/`pendingTasks` 寄存），`tick`（`index.js:2870-2956`）每轮先算 `activeIds` 集合（忙碌项优先、再按提交顺序唤醒最早 queued，`index.js:2885-2893`），轮到时落地预置字段（`index.js:2919-2929`）、非本轮项目跳过（`index.js:2931`）；取消不受闸门限制（`index.js:2884-2894`，中断在飞请求），且跨实例取消标记由 `syncCancelFlags`（`index.js:1890-1901`，调用在 `index.js:2880`）每轮拾取。另一实例停更超 `ORPHAN_TAKEOVER_MS`（`index.js:1566`，默认 5 分钟）即孤儿接管（`index.js:2884-2893`）。

3. **阶段机与持久化**：`STAGE_HANDLER`（`index.js:2861-2868`）按 articles（`tickArticles` `index.js:2310-2502`）→ crosscut（`tickCrosscut` `index.js:2526-2609`）→ compose（`tickCompose` `index.js:2612-2624`）→ review（`tickReview` `index.js:2661-2772`）→ index（`tickIndex` `index.js:2774-2841`）→ commit（`tickCommit` `index.js:2843-2859`）推进；`setStage`（`index.js:1865-1875`）统一计各阶段耗时。job 持久化 `JOBS_FILE`（`index.js:1373`，tick 默认 `TICK_MS` `index.js:1374` 10s），`saveJobs`（`index.js:1686-1691`）保留最近 `MAX_JOBS_KEPT`（`index.js:1567`）= 30 条；多实例安全靠 `mergeFromDisk`（`index.js:1828-1849`）磁盘吸收与 `acquireTickLock`（`index.js:1669-1683`）进程级推进锁。宿主重启由 `settleJob`（`index.js:1914-1944`）恢复：agentic 任务按 `agentic: true` 标记重跑（`index.js:1923-1931`，`startAgenticRun` `index.js:2110-2157`），其余按持久化 `batchPrompt` 快照重跑（`index.js:2861-2870`），都缺则 fail（`index.js:2861`）。旧 plan 阶段任务迁移到 articles（`index.js:2861-2868`）。

4. **规划（articles 开头就地）**：full 编译无 `job.plan` 时 `buildPlan`（调用在 `index.js:2425`）：`planMode=dirs` 直接 `localPlan`（`index.js:941-954`，dirs 分支 `index.js:2163-2167`；`slugify` `index.js:1311-1313` 保留 CJK）；`planMode=auto`（默认）走 `semanticPlan`（`index.js:963-1046`）——`extractRepoGraph` 提取全仓符号图（调用在 `index.js:982`）、`resolveImportEdges` 建依赖边（调用在 `index.js:999`）、`clusterComponents` 让模型按职责聚成层级模块树（调用在 `index.js:1010`）、`toPlanModules` 转模块清单（调用在 `index.js:1022`），组件图（**不含** `sourceCode`，0.13.2 删除冗余，`index.js:1026-1038`）与依赖边随 plan 持久化（`index.js:2425`）供 stale 组件级比对；提取不可用/聚类失败/空结果均记 note 退回 `localPlan`（`index.js:2181-2183`）。

5. **文章阶段双通道**：`agenticArticles` 开（默认）时任务打 `agentic: true`（`index.js:2110-2115`）并交 `startAgenticRun`（`index.js:2110-2157`，内部 `runAgenticArticles` 调用在 `index.js:2116`，单篇步数上限 `agenticMaxSteps` 传入在 `index.js:2126`）——模型自己 `read_code`/`list_files`/`edit_article` 多轮增量写作，源码不整包内联，因此没有观察批装填链；0.13.3 起 `read_code` 带**重复读抑制**（`seen` 记账键为 `path + 起始行 + 结束行`，去重判定发生在读盘之前，`lib/agentic.js:115-177`），`DEFAULT_MAX_STEPS` 唯一定义在 `lib/agentic.js`（= 30，`lib/agentic.js:325`）。收割统一进 `tally`（`index.js:1984-2015`，`replace`/`mergeByName` 两个独立开关）。失败**严格过半**（`shouldFallBackFromAgentic` `index.js:934-939`）且本 job 未退回过（`shouldFallBackHere` `index.js:2019-2026`，守 `job.agenticRetried`）时，只把失败篇重排进旧通道重跑一次（`index.js:2375-2413`：失败篇收集在 `index.js:2110`，`prepareArticleTasks` 重装 `index.js:2390-2394`，置位 `index.js:2395`）。`agenticArticles` 关则走旧通道 `prepareArticleTasks`（`index.js:806-891`，调用在 `index.js:2475`）：整包装得下单请求直出（`index.js:2110-2111`），110k–大档预算区间升大档（`markBig` `index.js:818-826`，判定在 `index.js:840`），总量超大档预算才拆观察→合成（`index.js:2110-2145`；模板 `batchArticleObservePrompt` `index.js:1132-1148`/`batchArticleComposePrompt` `index.js:1152-1180`，收割重建合成批 `index.js:2110-2162`）；仅单文件连大档都装不下转会话通道（`index.js:2110`/`dispatchSessionTasks` `index.js:2228-2262`）。

6. **会话通道兜底**：`dispatchSessionTasks`（`index.js:2228-2262`）把完整写作指令写任务文件并 steer 发起会话派子智能体；每 tick 由 `progressSessionTasks`（`index.js:2266-2285`）按 `classifySessionTask`（`index.js:1529-1539`）三态收割（timeout/harvest/wait），steer 文案由 `buildSessionSteerText`（`index.js:1546-1564`）统一生成（`sessionTier` `index.js:70` 非空时钉死档位）；宿主重启后 `resendSessionSteer`（`index.js:2289-2302`）重发一次。超时默认 30 分钟（`SESSION_TASK_TIMEOUT_MS` `index.js:1378`）按失败处理、不降级。

7. **模型调用与双池限流**：`runRealtimeTasks`（`index.js:509-568`）按 `bigTier` 标记分池（`index.js:509-524`；`bigConcurrency` 为 0/未填回落默认档 `index.js:525-527`），两池同时推进（`index.js:509`）；大档任务自带 provider+model 时思考档位完全以任务为准、不回落普通档（`index.js:509-513`）。`bigTier` 三个来源：文章装填 `markBig`（`index.js:818-826`）、横切单批直出（`index.js:2581-2588`）、批量校对 `markBigTask`（`index.js:2706-2712`）；`submitBatchFor`（`index.js:2186-2220`）把 bigTier 连同模型信息持久化进 `job.tasks`（`index.js:2201`），重启重跑不掉池。模型不支持所配思考档位时 `llmChat` 剥档重试一次（`index.js:509-513`）。agentic 通道同样分池：`markBigAgenticTasks`（`lib/articles-agentic.js:287-300`）按源文本量打标，`startAgenticRun` 传 `bigConcurrency`（`index.js:2122`）。

8. **落盘、横切与校对**：结果经 `applyTaskResult`（`index.js:481-494`）或 `writeValidated`（`index.js:1949-1973`）落盘，两者都先过 `fixAnchors`（`index.js:608-730`）做行号锚点确定性校正；源码内联带 `numberLines`（`index.js:597-599`）行号前缀与 token 预算装填（`collectSources` `index.js:735-762`、`estimateTokens` `index.js:434-442`）。横切 `tickCrosscut`：总量 ≤ 大档预算（未配置大档则为 128k 硬上限）单批直出（`index.js:481-501`），否则每篇模块文章一个观察任务（`index.js:481-486`，模板 `batchObservePrompt` `index.js:1111-1128`）、合成批只吃观察（`submitComposeBatch` `index.js:2626-2636`）；产出 `_architecture`/`_patterns`/concepts（模板 `batchArchitecturePrompt` `index.js:1085-1091`、`batchPatternsPrompt` `index.js:1093-1099`、`batchConceptPrompt` `index.js:1101-1107`，输入装填 `packArticles` `index.js:1050-1069`）。审校为批量校对：`localReview`（`index.js:2639-2659`）本地核对后，多篇按 110k 贪心合并（`index.js:481-502`）提交 `batchProofreadBatchPrompt`（`index.js:1207-1234`），收割 `settleProofread`（`index.js:2030-2054`）按 `@@@article:`/`
