---
title: core-application
type: module
source_files:
  - index.js
  - client.js
  - package.json
tags: [CodeWiki, 编译流水线, 阶段机, 百炼, DeepSeek Harness, 侧边栏面板, React]
---

## Overview

`core-application` 是 dsh-codewiki 插件（`package.json` 声明 `name: "@local/dsh-codewiki"`、`version: 0.9.1`、`exports` 暴露 `./index.js` 与 `./client.js`）的应用层：它把「整仓 wiki 编译」做成一条**服务化、零子代理、提交即返回**的后台流水线，并配一套浏览器端面板。

代码分成两半，职责严格分离：

- `index.js`（2869 行）是宿主半侧。它封装本地 `cw` CLI（`index.js:104` `runCw`）、定义 `Config` 配置（`index.js:37-51`）、实现 `createJobService` 阶段机（`index.js:1192-2143`）、注册四个模型工具（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`），并通过 `installWebServer`（`index.js:2526`）在回环地址上暴露统计与控制的 HTTP 端点。
- `client.js`（1189 行）是浏览器半侧。它经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（`client.js:10-11`）注册，向宿主注入设置卡片（`plugins.item`）和侧边栏面板（`main` + `sidebar.panellist`），靠轮询而非推送更新界面。

流水线的核心契约是**阶段机 + 文件状态**：一个 job 从 `plan` 依次推进到 `articles` → `crosscut` → `compose` → `review` → `index` → `done`，每一步由 `tick()`（`index.js:2013`）按 10 秒节拍推进一步（`index.js:1016` `TICK_MS`），全部状态落在 `JOBS_FILE`（`index.js:1015`），因此宿主重启、多实例并存都能靠磁盘快照接管续跑。

## Key Components

### index.js — 配置与基础层

- `Config`：`index.js:37-51`，`@deepseek-ai/schemastery` schema，共 13 个字段，全部带 `.volatile()`：`enabled`（停用后两个工具立即报错）、`binaryPath`（留空优先用 PATH 里的 `cw`）、`batchProvider`（留空=百炼兼容通道，非空=宿主 llm 服务）、`batchModel`（默认 `'qwen3.7-flash'`）、`batchApiKey`、`batchThinkingBudget`（0=关思考，上限 32768）、`maxConcurrency`（默认 8）、`articleLanguage`（默认 `'中文'`）、`updateReminder`、`excludePaths`、`autoUpdate`、`autoUpdateMin`（默认 30，最小 5）、`workspaceOnly`（默认 `true`）。
- `val(x)`：`index.js:53`，兼容 schemastery 的 `get()` 访问形态。
- `liveConfig(config)`：`index.js:57-76`，把配置折算成运行时值：`batchThinkingBudget` 钳到 `[0, 32768]`，`maxConcurrency` 钳到 `[1, CONCURRENCY_HARD_CAP]`，`autoUpdateMin` 下限 5，`workspaceOnly !== false` 归一为布尔。
- `CONCURRENCY_HARD_CAP`：`index.js:22`，值 `8`，编译请求并发硬顶。
- `normalizeCwd(input)`：`index.js:26-31`，仅 win32 把 MSYS 盘符路径 `/e/...` 归一为 `E:/...`；POSIX 原样保留。
- `CW_SUBCOMMANDS`：`index.js:20`，`['init','status','index','meta','path','projects','setup','uninstall']`，`cw` 工具据此白名单校验。

### index.js — cw CLI 封装与三态判定

- `resolveBinary(cfg)`：`index.js:82-102`，解析顺序为「配置里的 `binaryPath` → PATH 里的 `cw`（win32 用 `where`，其余用 `which`）→ 插件自带 `bin/cw(.exe)` → 裸 `'cw'`」。PATH 优先的理由见行内注释：用户装的 `cw` 与其源码同步演进，捆绑副本只兜底。
- `runCw(binary, cwd, args, timeoutMs = 120000, signal)`：`index.js:104-128`，`spawn` 子进程收集 stdout/stderr，超时 `SIGKILL`，`signal.abort` 也 `SIGKILL`；返回 `{ exitCode, stdout, stderr, timedOut }`，永不 reject（`error` 事件也 resolve 成 `exitCode: -1`）。
- `normalizeArticlePath(p)`：`index.js:141`，把 `\` 换成 `/`。`cw 0.5.0.2` 起 Rust 层已输出 `/`，这层是纵深防御（`index.js:141-150` 注释记录了 `0.5.0.1` 源码丢失的历史）。
- `normalizeIndexLinks(cwd)`：`index.js:145-153`，`cw index` 直写的 `.codewiki/_index.md` 里，把 `[[link|title]]` 链接头中的 `\` 规范化为 `/`；文件不存在静默返回 `false`。
- `parseStatus(stdout)`：`index.js:155-169`，把 `cw status` 文本解析成 `{ state, changedFiles, staleArticles }`。四个关键字判定：`'No wiki found'` → `missing`、`'has not been compiled yet'` → `uncompiled`、`'Wiki is up to date'` → `clean`，其余按 `^\s+[M!]\s+(.+)$` 逐行归类（`M` 进 changedFiles，`!` 进 staleArticles，state 记 `stale`）。
- `countWikiArticles(wikiPath)`：`index.js:171-185`，递归数 `.codewiki/` 下 `.md` 篇数（含 `_index`），失败返回 `null`。
- `ensureWikiEntry(cwd, language = '中文')`：`index.js:188-224`，仓库根缺 `CodeWiki.md` 时按语言写一份入口说明；**已存在绝不覆盖**（人工速查手册优先）。
- `excludedItem(cwd, list)`：`index.js:226-235`，排除清单按 `[\n;，,]+` 分隔，`cwd` 等于某项或位于其子树内即命中（Windows 大小写不敏感），返回命中的原文；`isExcluded(cwd, list)`：`index.js:236-238` 是它的布尔投影。

### index.js — Token 预算、模型通道与执行器

- `estimateTokens(text)`：`index.js:247-259`，CJK 字符（`0x4e00-0x9fff`、`0x3000-0x303f`、`0xff00-0xffef`）按 1 token/字，其余按 3.5 字符/token。只为把单请求输入压进 qwen3.7-flash ≤32k 低价档，不追求精确分词。
- `llmChat({ llm, provider, model, prompt, signal })`：`index.js:261-281`，走宿主 llm 服务（`llm.stream` + `BlockAssembler`），`temperature: 0`；`finish.kind` 为 `error`/`aborted` 时抛错，缺 content 也抛错。**该通道不下发思考预算**（宿主侧是 `reasoningEffort` 枚举而非 token 数）。
- `bailianChat({ apiKey, model, thinkingBudget, prompt, signal })`：`index.js:283-303`，`POST ${BAILIAN_BASE}/chat/completions`，`thinkingBudget > 0` 时下发 `enable_thinking: true` 与 `thinking_budget`；返回 `{ content, outputTokens }`。
- `applyTaskResult(task, content, notes)`：`index.js:305-322`，任务结果出口。`keepInMemory` 任务只回内存；其余任务先跑 `fixAnchors` 修锚点（修正条数与存疑清单写进 `notes`）再 `writeFileSync` 落盘。
- `runRealtimeTasks(tasks, { apiKey, model, thinkingBudget, concurrency, notes, onTaskDone, signal, llm, provider })`：`index.js:324-351`，**唯一执行器**。按 `maxConcurrency` 起 worker 从游标消费任务队列，`provider` 非空走 `llmChat`、否则走 `bailianChat`（`chat` 选择在 `index.js:330-332`）；每任务回调 `onTaskDone({ outputTokens, durationMs })` 供面板算 tps；单任务异常只记 `notes` 并置该任务 `ok: false`；返回 `Map(customId → {ok, stopReason, content?})`。
- `BAILIAN_BASE`：`index.js:361`，`'https://dashscope.aliyuncs.com/compatible-mode/v1'`。
- `BATCH_TOKEN_BUDGET`：`index.js:364`，`28000`（≤32k 低价档留 ~4k 余量）。
- `BATCH_TOKEN_HARD_LIMIT`：`index.js:368`，`200000`（0.9.0 起只用于「会话通道任务文件装填上限」，不再表示升档提交）。

### index.js — 行号锚点、源码装填与任务装配

- `numberLines(content)`：`index.js:379-381`，给每行加 `N| ` 前缀（grep 风格），让模型引用行号以前缀为准而不是自己数行（弱模型中段会系统性错位）。
- `fixAnchors(content, cwd)`：`index.js:390-476`，**文章落盘前的第四层兜底**。只处理 frontmatter 之后的行；用 `symbolsOnLine`（`index.js:410-419`，与 `test-wiki-anchors.mjs` 同源）从行内反引号提取符号；锚点正则 `anchorRe = /([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g`（`index.js:425`）。起点行不含该符号时在全文找出现行：恰好一处 → 修正；多处 → 只认 `function`/`class`/`const`/`let` 的**声明形态**（正则见 `index.js:451`），仍歧义则不动并记 `unresolved`。区间尾越界钳到文件尾（`index.js:472`）。只改行号数字，`source_files` 之外的文件一律不碰。
- `collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)`：`index.js:478-507`，把源文件内联成 markdown（每段 `### <rel>` + 带 `numberLines` 的围栏）。**只整文件装填，绝不半文件截断**（半截代码会误导行号）。返回 `{ text, skipped, oversized }`：`skipped` 是预算装不下的文件清单（会追加一段「不得涉及它们」的警告），`oversized: true` 表示连第一个文件都装不下。
- `batchArticlePrompt({ language, mission, sourcesText, prevArticle })`：`index.js:509-537`，单轮文章 prompt 骨架；有旧文时附上并明确「行号不得沿用」；末尾拼 `articleFormatSection()`。
- `hostCtxRef`：`index.js:539`，`apply` 时捕获的宿主 ctx，供凭证库注入使用。
- `resolveBatchApiKey(hostCtx, cfg)`：`index.js:546-576`，凭证链为「显式 `batchApiKey` → `hostCtx.inject(['credentials'])` 解析 `ALIYUN_BAILIAN_API_KEY`」，注入用 `Promise.race` 加 3 秒上限（`index.js:550`），取不到返回 `null`（不是抛错），来源记在 `source` 字段（`config` / `credentials(<来源>)`）。
- `prepareArticleTasks(tasks, { cwd, language })`：`index.js:578-636`，任务装配与**三级降级**：
  1. 先按 28k 装填（`collectSources`），装不下就试 200k（`index.js:582-584`）；
  2. 若 28k 有文件被跳过，或整 prompt 估算超预算（`index.js:576`），按 28k 逐文件装填拆成多个 `_split` 观察批（`#obs` 任务，`keepInMemory`，带 `splitFor` 与 `composePlan`，`index.js:613-634`）；
  3. 单文件连观察批预算都装不下、或分不出多批 → 整任务转「会话通道」（`sessionTasks`，`forceSession`，`index.js:627-629`）。
  返回 `{ prepared, sessionTasks }`。
- `articleFormatSection()`：`index.js:642-671`，文章格式条款的唯一来源：frontmatter 必须含 `title`/`type`/`source_files`/`tags`，正文六章节 `Overview`/`Key Components`/`Architecture`/`Data Flow`/`Connections`/`Known Issues`；行号必须以「行号| 」前缀为准；`source_files` 必须列全读过的文件（含测试）；功能被注释/禁用要写明具体位置；Architecture 组件 ≥3 时要 UTF-8 框图；`Connections` 用 `[[backlinks]]`；写给零上下文的未来 agent。

### index.js — Prompt 模板

- `batchPlannerPrompt(fileLines)`：`index.js:675`，规划 prompt（输入是文件清单，输出纯 JSON）。
- `localPlan(files)`：`index.js:697-712`，规划兜底：按顶层目录分组，`concepts: []`，`project` 标「本地兜底规划」。
- `packArticles(articles, budget = BATCH_TOKEN_BUDGET)`：`index.js:714-733`，横切输入装配；整篇装不下时只装 `## Key Components` 之前的头部并标「超预算，仅头部」。
- `crosscutIntro(language, what, requirements)`：`index.js:735`。
- `batchArchitecturePrompt(language, articlesText)`：`index.js:749`；`batchPatternsPrompt(...)`：`index.js:757`；`batchConceptPrompt(language, concept, articlesText)`：`index.js:765`。
- `batchObservePrompt(language, moduleName, articleText)`：`index.js:775-794`，横切 map 阶段：一篇文章 → 紧凑观察（职责、对外接口+行号、依赖方向、值得进总览的模式/风险、`source_files` 原样）。
- `batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal)`：`index.js:796-814`，文章分割的 map 阶段，要求「宁全勿简」但禁止贴大段源码。
- `batchArticleComposePrompt({ language, mission, moduleName, observationsText, prevArticle })`：`index.js:816-846`，合并各批观察成整篇（附 `articleFormatSection()`）。
- `batchProofreadPrompt({ language, articleText, sourcesText })`：`index.js:848-867`，校对 prompt：四项核对（frontmatter 完整性、逐符号核行号、补漏的 `source_files`、改写与源码不符的段落），输出**修正后的整文**而非 diff。

### index.js — 工具定义

- `cwToolDefinition(cfg)`：`index.js:873-936`，`cw` 工具。`execute`（`index.js:913`）依次校验：插件已启用（`index.js:916`）、`cwd` 存在（`index.js:917`）、`args` 非空（`index.js:919`）、子命令在 `CW_SUBCOMMANDS` 白名单内（`index.js:921`）；随后 `runCw(... 120000, exec?.signal)`（`index.js:924`），超时抛错（`index.js:924`）。输出 schema 为 `{ cwd, command, exitCode, stdout, stderr, timedOut }`。
- `generateToolDefinition(cfg, svc)`：`index.js:2150-2299`，`codewiki_generate` 工具，是整条流水线的**总入口**。`execute`（`index.js:2193`）的前置校验：`enabled`（`index.js:2195`）、`svc` 已初始化（`index.js:2196`）、`cwd` 存在（`index.js:2198`）、排除清单（`index.js:2200`）。随后 `runCw(..., ['status'], 120000, exec?.signal)` 判态（`index.js:2208`），超时/失败分别抛错（`index.js:2209`、`index.js:2209-2211`）。分支：
  - 已有活动任务 → 直接返回该 job（`index.js:2219-2225`）；
  - `scope=stale` 但无 wiki → 自动升全量（`index.js:2230-2233`）；
  - `clean` 且非 `full` → 只报告不提交（`index.js:2238`）；
  - `stale` 且有过期文章 → 逐篇构造 `prebuiltTasks`，无 `source_files` 的文章跳过（`index.js:2244-2249`），提交 `kind: 'stale'`（`index.js:2262`）；
  - `stale` 但无过期文章却有变更 → `meta update` 刷新基线并报告（`index.js:2273-2276`）；
  - `missing` → 先 `cw init`（`index.js:2283-2286`）再提交 `kind: 'full'`（`index.js:2283`）。
- `updateToolDefinition(cfg, generateDef)`：`index.js:2308-2360`，`codewiki_update` 是固定 `scope: 'auto'` 的快捷入口（`execute` 在 `index.js:2348`，内部 `generateDef.execute({ ...args, scope: 'auto' }, exec)` 见 `index.js:2350`），错误信息里的工具名会被替换成 `codewiki_update`（`index.js:2356`）。
- `samePath(a, b)`：`index.js:2368`，路径归一后小写比较；`progressView(job)`：`index.js:2373-2378`，在 job 摘要上补 `progress` 百分比。
- `progressToolDefinition(cfg, svc)`：`index.js:2379-2461`，`codewiki_progress` 只读工具。`execute`（`index.js:2446`）校验启用与 `svc`（`index.js:2448-2449`），支持按 `jobId`（`index.js:2453`）与 `cwd`（`index.js:2456`）过滤。

### index.js — createJobService（阶段机核心）

`createJobService(config, onSettled)`：`index.js:1192-2143`，返回 `{ submit, cancel, list, findActive, start, stop }`（`index.js:2813`）。

**实例身份与持久化**

- `instanceId`：`index.js:1200`，`svc-<base36 时间>-<随机 6 位>`；tick 只推进本实例创建的 job，防止另一实例用旧快照重复推进同一 job（双提交）。
- `dirty` / `dirtyIds` / `persist()`：`index.js:1204-1207`，只有状态变更才整写 `JOBS_FILE`；本实例动过的 job id 在 `flush` 时不允许被磁盘快照反向覆盖（`index.js:1206-1207` 注释解释了 cancel/fail 与慢 tick 交错时丢现场的坑）。
- Temp 沙箱残留清理：`index.js:1213-1224`，`cwd` 位于系统临时目录的终态任务启动即移除并立即落盘（只标脏会被 `mergeFromDisk` 吸回）。
- `mergeFromDisk()`：`index.js:1224-1245`，吸收另一实例新增的 job，以及「磁盘更新且本实例没动过」的同 id job；合并后按 `createdAt` 排序。
- `flush()`：`index.js:1246-1249`，先 `mergeFromDisk` 再 `saveJobs`。

**内部记账辅助**

- `note(job, msg)`：`index.js:1251-1254`，追加日志并只保留最近 50 条。
- `touch(job)`：`index.js:1257-1259`，状态变更唯一入口，必须同时标脏并登记 `dirtyIds`（否则纯内存变更进不了 `JOBS_FILE`）。
- `setStage(job, stage)`：`index.js:1262-1272`，切换阶段前先把上一阶段耗时累加进 `job.stageTimings`，再记 `stageStartedAt`。
- `addUsage(job, { inputTok, outputTok, requests, batch, realtime, overTier2 })`：`index.js:1274-1283`，累加 `job.usage`（输入是提交时估算，输出是响应实测）。
- `syncCancelFlags()`：`index.js:1286-1297`，每轮 tick 从磁盘拾取别实例写入的 `cancelRequested`。
- `fail(job, msg)`：`index.js:1300-1308`，置 `failed`、写 `job.error`/`finishedAt`；`submitting` 期的失败不再唤醒会话（错误随工具调用同步返回）。
- `apiKeyOf(job)`：`index.js:1310-1317`，凭证优先用内存缓存（不落盘），缺失时重解析，仍取不到就抛错终止。

**阶段收割与落盘闸门**

- `settleJob(job)`：`index.js:1320-1341`，返回 `null` 表示阶段还在跑。三条路：`batchResults` 已有结果 → 清 `batchProgress`/`batchSubmittedAt` 并返回；`batchRuns` 在执行 → 返回 `null`；执行器丢失（宿主重启）→ 若 `job.tasks` 的 `batchPrompt` 快照齐全则**重跑本阶段**（幂等，文章重写覆盖），否则 `fail`。
- `writeValidated(job, task, content)`：`index.js:1346-1363`，`keepInMemory` 任务的唯一写盘点。**闸门：输出必须以 `---` 开头**，缺 frontmatter 不落盘、原文件保留（`index.js:1346-1349`）；通过后跑 `fixAnchors` 再写。
- `tally(job, results, tasks, { replace = false })`：`index.js:1365-1389`，结果记账：`keepInMemory` 且成功的结果过 `writeValidated`；新条目计入 `writtenCount`/`failedCount`；`replace: true`（校对阶段）覆盖同名条目，且**校对失败不推翻已写成功的原文**（`ok` 保持原值）。

**批次执行器与会话通道**

- `batchRuns` / `batchResults` / `batchAborters`：`index.js:1392-1394`，三个 Map 用来解耦 tick 与长请求：存活性标记、待收割结果（`null` = 执行器整体失败）、取消用的 `AbortController`。
- `startBatchChatRun(job, prepared)`：`index.js:1395-1438`，启动后台并发池。`batchProvider` 非空时凭证直接给空串（宿主按 provider 解析，插件不碰 key，`index.js:1401`）；`onTaskDone` 里累加 `batchProgress`、把 tps 样本压入 `job.tpsSamples`（保留最近 20 条）、把输出 token 入账（`index.js:1412-1420`）；整体 reject 时写 `batchResults = null` 并 `fail`；`finally` 里清 `batchRuns`/`batchAborters`，终态时连 `batchResults` 也清掉。
- `submitBatchFor(job, prepared)`：`index.js:1440-1464`，提交前**预记账**输入 token 与请求数，并统计超 32k 档的请求数（按 3 倍价，`index.js:1444-1446`）；把 `prepared` 快照化写进 `job.tasks`——`batchPrompt` 是「宿主重启后重跑本阶段的唯一依据」，`#obs` 任务额外带 `splitFor`/`composePlan`（`index.js:1453-1459`）；然后 `startBatchChatRun` 并 `note` 启动信息。
- `dispatchSessionTasks(job, tasks)`：`index.js:1467-1512`，会话通道派发。把每个 `batchPrompt` 写成 `SESSION_TASK_DIR` 下的任务文件（`index.js:1477-1482`），`agent.steer` 一条汇总消息让发起会话调子智能体（`index.js:1506`）；`job.stage === 'review'` 时消息措辞改成「校对」并要求覆写原文章（`index.js:1486`）；发起会话不可用时直接 `fail`。
- `progressSessionTasks(job)`：`index.js:1517-1536`，收割：`timeout` 记失败、`harvest` 走 `writeValidated`、其余留待下轮；返回 `true` 表示全部终态。校对阶段用 `replace: true` 记账（`index.js:1526`）。
- `resendSessionSteer(job)`：`index.js:1540-1563`，宿主重启接管后重发一次 steer，**不重置 `dispatchedAt`**（超时计时保持原起点，子智能体重写同一文件所以幂等）。

**阶段处理器**

- `tickPlan(job)`：`index.js:1565-1609`。有在途批次 → `settleJob` 收割，解析 JSON 计划，解析失败降级 `localPlan(scanRepoFiles(job.cwd))`（`index.js:1573-1575`）。首次进入 → `scanRepoFiles` 取文件清单（空则 `fail`），先试 `runMainModelPlan`（主模型规划，避开 32k 低价档、也不占百炼并发池），失败或产出不可解析再降级百炼批量（`index.js:1588-1601`）。
- `runMainModelPlan(job, prompt)`：`index.js:1614-1664`。路由顺序与会话主线 compaction 一致：`agent.session.requestHeader()?.config` 优先，退回 `agent.options`（`index.js:1616-1622`）；经 `llm.stream` 单轮流收集；任何异常只 `note` 并返回 `null`（走批量回退），不 fail 任务。
- `tickArticles(job)`：`index.js:1665-1775`，最长的一段。收割分支里先处理 `#obs` 观察批：按文章名归并观察文本，每篇只重建**一条**合成任务（`composedArticles` 去重，`index.js:1689-1722`）；全部批失败则该篇缺席本轮编译但不 fail 整个 job；合成任务为空且无在途会话任务时直接推进阶段（`index.js:1727-1731`）。首次进入按 `kind` 取任务（`stale` 用 `job.tasks`，`full` 用 `job.plan.modules` 映射成 `modules/<slug>.md`，`index.js:1734-1754`），再交 `prepareArticleTasks`，分流出 `prepared`（批量）与 `sessionTasks`（会话通道）。收尾守卫：`writtenCount === 0` 直接 `fail`（`index.js:1773`）。
- `crosscutTasks(job, pack)`：`index.js:1778-1798`，横切任务组 = `_architecture.md` + `_patterns.md` + `job.plan.concepts` 逐个 `concepts/<slug>.md`，全部 `keepInMemory`。
- `tickCrosscut(job)`：`index.js:1799-1862`。输入是成功模块文章全文；用**原始总量**判拆分（`index.js:1837`，因为 `packArticles` 会截头部，pack 体积永远装得下，不能作依据）。≤28k 单批直出；超了改成「每篇文章一个观察任务」并发跑（`_obs/<name>`，`index.js:1842-1846`），置 `job.crosscutSplit = true`。
- `tickCompose(job)`：`index.js:1865-1877`，合成批收尾：观察批收尾时**不走 tally**（不写盘不计数），只拼观察包再提交合成（`index.js:1865-1878`）；合成批断点丢失（stage 落盘与提交落盘之间进程中断）时留痕降级进校对，不静默。
- `submitComposeBatch(job, observationsText)`：`index.js:1879-1890`，合成提交失败时**降级跳过横切**进校对，不推翻已写成功的文章。
- `localReview(job)`：`index.js:1892-1913`，本地核对三件事：文件是否还在（丢了回退 `writtenCount`）、是否以 `---` 开头（缺则 `skipProofread`）、`source_files` 是否都存在。只记账不删文。
- `tickReview(job)`：`index.js:1914-1977`。对每篇合格文章按 `BATCH_TOKEN_BUDGET - articleTokens` 装填源码；装不下先升 200k，仍不行就转会话通道校对（`index.js:1943-1949`）；批量批提交失败只 `note`「跳过校对」不 fail。会话通道校对收割完才进 index。
- `tickIndex(job)`：`index.js:1979-2003`。`writtenCount > 0` 时依次跑 `cw index`、`cw meta update`（各 120s），失败只 `note`「编译基线可能未刷新」；`normalizeIndexLinks` 报告链接规范化；`ensureWikiEntry` 补入口。最后 `setStage('done')`、写 `finishedAt`，并 `onSettled?.(job, 'done')` 唤醒发起会话。
- `STAGE_HANDLER`：`index.js:2004-2012`，`{ plan, articles, crosscut, compose, review, index }` 六项映射。
- `tick()`：`index.js:2013-2057`。防重入（`ticking`）+ 跨进程锁（`acquireTickLock`，`index.js:1108-1121`）；`syncCancelFlags()` 后遍历非终态 job：**孤儿接管**（`owner` 非本实例且停更超 `ORPHAN_TAKEOVER_MS` 则改 owner、`touch`、对在途会话任务补发 steer，`index.js:2027-2034`）、`submitting` 占位跳过（`index.js:2033`）、`cancelRequested` 则 abort 在飞请求并置 `cancelled`（`index.js:2033-2044`）、其余派给 `STAGE_HANDLER`，handler 抛错统一 `fail`；终态 job 立即 `persist()`，最后 `flush()`，`finally` 释放锁。

**对外方法与生命周期**

- `submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId })`：`index.js:2059-2116`。排除清单（`index.js:2059-2063`）→ `rememberRepo` → 同 cwd 有非终态 job 直接返回 `{ job: existing, existed: true }`（`index.js:2065-2066`）→ **先建 `stage: 'submitting'` 占位**（`resolveBatchApiKey` 最长等 3s，占位挡住并发重复提交，`index.js:2068-2088`）→ 解析凭证（llm 通道只校验 provider/model 与 `llmRef`，`index.js:2097-2101`）→ 置 `plan`（full）或 `articles`（stale）→ `persist()`、`flush()`，再 `void tick()` 立即推进一步。
- `cancel(jobId)`：`index.js:2118-2128`，先 `mergeFromDisk`（别实例提交的 job 可能还没吸收），置 `cancelRequested` 并 `flush`。
- `list`：`index.js:2129`；`findActive(cwd)`：`index.js:2130`；`start()`：`index.js:2132-2136`（`setInterval` 按 `TICK_MS` 跑 tick，`timer.unref()`）；`stop()`：`index.js:2137-2140`。

**job 对象的全部字段**（`index.js:2069-2088`）

`id`（`job-<base36 时间>-<序号>`）、`cwd`、`wikiPath`、`scope`、`language`、`kind`（`full`/`stale`）、`owner`（instanceId）、`stage`、`auto`、`sessionId`、`plan`、`batchRef`、`tasks`、`articles`、`writtenCount`、`failedCount`、`usage`（`inputTok`/`outputTok`/`requests`/`batchRequests`/`realtimeRequests`/`overTier2`）、`stageTimings`、`stageStartedAt`、`notes`、`createdAt`、`updatedAt`。运行期追加：`credentialSource`、`apiKey`（`index.js:2111-2112`，`apiKey` 不落盘）、`batchProgress`、`batchSubmittedAt`、`tpsSamples`、`sessionTasks`、`cancelRequested`、`crosscutSplit`、`error`、`finishedAt`。

### index.js — 持久化与常量

- `JOBS_FILE`：`index.js:1015`，`DSH_CODEWIKI_JOBS_FILE` 或 `os.tmpdir()/dsh-codewiki-jobs.json`；`TICK_MS`：`index.js:1016`，默认 10000，下限 250。
- `SESSION_TASK_TIMEOUT_MS`：`index.js:1020`，默认 30 分钟，下限 5 分钟；`SESSION_TASK_DIR`：`index.js:1021`，与 job 文件同目录的 `dsh-codewiki-session-tasks`。
- `classifySessionTask(task, nowMs)`：`index.js:1027-1037`，纯函数三态：超时 → `'timeout'`；文件不存在/读不到/`mtime` 早于派发时间/不以 `---` 开头 → `'wait'`；否则 `'harvest'`。
- `ORPHAN_TAKEOVER_MS`：`index.js:1039`，默认 5 分钟，下限 60 秒；`MAX_JOBS_KEPT`：`index.js:1040`，`30`。
- `REPOS_FILE`：`index.js:1045`，已知仓库清单（独立于 job 历史，避免 `MAX_JOBS_KEPT` 截断后总览丢工作区）；`loadKnownRepos()`：`index.js:1046-1048`；`rememberRepo(cwd)`：`index.js:1049-1056`，大小写与尾斜杠归一后去重追加。
- `JOB_TERMINAL`：`index.js:1058`，`Set(['done','failed','cancelled'])`。
- `SCAN_SKIP_DIRS`：`index.js:1061-1065`；`SCAN_SKIP_EXT`：`index.js:1066-1071`；`SCAN_MAX_FILE_BYTES`：`index.js:1072`，256KB；`SCAN_MAX_FILES`：`index.js:1073`，2000。
- `scanRepoFiles(cwd)`：`index.js:1075-1098`，递归扫描；目录名以 `.` 开头或命中黑名单即跳过；空文件与超 256KB 文件跳过；`path` 用 `/` 分隔的相对路径，附 `bytes`。
- `loadJobs()`：`index.js:1100-1103`；`JOBS_LOCK_FILE`：`index.js:1105`；`acquireTickLock()`：`index.js:1108-1121`，用 `flag: 'wx'` 独占创建，已存在且 mtime 超 60s 则强删重试（崩溃残留锁）；`releaseTickLock()`：`index.js:1123`。
- `saveJobs(jobs)`：`index.js:1125-1129`，只留最近 30 条，落盘时剔除 `apiKey`（重启重解析），但保留 `cancelRequested`（跨 tick 存活靠它）。
- `jobSummary(job)`：`index.js:1131-1165`，面板与工具共用的投影：`id`/`cwd`/`kind`/`scope`/`auto`/`stage`/`batchId`/`writtenCount`/`failedCount`/`cancelRequested`/`articles`/`taskList`（已结算在前、当前批 `pending` 在后，进度条分母即其长度）/`batchProgress`/`batchSubmittedAt`/`stageStartedAt`/`stageTimings`/`usage`/`notes`（最近 8 条）/`error`/`createdAt`/`updatedAt`/`finishedAt`/`tps`（`tpsSamples` 的总输出 token ÷ 总毫秒）。

### index.js — 唤醒、Web 端点与插件入口

- `agentsRef`：`index.js:1172`；`llmRef`：`index.js:1177`（注释记录了 cordis 下直接访问 `ctx.llm` 会抛 `cannot get property "llm" without inject` 的坑）。
- `wakeCompileSession(job, outcome, agents = agentsRef)`：`index.js:1179-1190`，只对 `job.sessionId` 对应会话 `agent.steer` 一条消息：失败报错文案或「编译完成·请提交改动」（提示只 add `.codewiki/` 与 `CodeWiki.md`，不要 `git add -A`）。无 agent/冷会话一律静默。
- `isLoopbackRequest(req)`：`index.js:2467-2470`；`writeJson(res, code, obj)`：`index.js:2472-2476`；`readBodyJson(req)`：`index.js:2478-2501`，1MB 上限。
- `listModelCatalog(llm)`：`index.js:2503-2524`，`llm.listProviders()` + 逐个 `listModels`；字段名兼容 `id`/`provider`、`displayName`/`name`；单个 provider 抛错只记该条 `error`，不影响其他。
- `installWebServer(ctx, service, extra = {})`：`index.js:2526-2722`。`extra` 是 `{ config, schedState, compile }`。`workspaceRegistry` 经 `ctx.inject` 取（`index.js:2536`，兼容旧 mock 直传实例），`wsFilterPaths()`（`index.js:2542-2558`）在 `workspaceOnly` 关闭或无工作区时返回 `null`（不过滤）。四个端点均 `kind: 'exact'` 且先过 `guard`（回环之外 403）：
  - `GET /api/codewiki/jobs`（`index.js:2573-2591`）：`service.list()` 经工作区过滤后返回 `{ now, jobs }`；异常把错误栈前 8 行写进 500 响应体（宿主 webserver 对 handler reject 只回空 400，无法排查）。
  - `GET /api/codewiki/repos`（`index.js:2593-2677`）：仓库总览，30 秒缓存且以工作区清单签名 `wsSig` 失效；每个 cwd 现跑 `cw status` + `wikiPathFor` + `countWikiArticles`，附 `excluded`、`lastJob`、`state`、`staleArticles`、`changedFiles`、`wikiPath`、`articleCount`，并带 `scheduler` 段（`enabled`/`intervalMin`/`lastScan`/`scanning`/`lastError`/`lastScanRepos`/`lastScanSubmitted`）。
  - `GET /api/codewiki/models`（`index.js:2674-2688`）：模型目录，30 秒缓存。
  - `POST /api/codewiki/control`（`index.js:2697-2727`）：只接受 POST；`action: 'cancel'` + `jobId`、`action: 'refresh'`（清 repos 缓存）、`action: 'compile'` + `cwd`（可选 `scope` 限 `auto`/`full`/`stale`，调 `compile`），未知 action 返回 400 并列出合法形状。
- `commitHintCache`：`index.js:2736`；`commitHintText(cwd, jobs = loadJobs())`：`index.js:2737-2762`，60 秒 TTL。取最近一次 `stage === 'done'` 且 `writtenCount > 0` 的 job，用 `git -C cwd log -1 --format=%ct -- .codewiki CodeWiki.md`（5s 超时）比对：job 完成时间晚于最后一次提交 → 注入「请提交改动」提示；提交后时间戳反超自动静默；非 git 仓库不提醒。
- `reminderText(cwd)`：`index.js:2764-2773`，系统提示里的固定五条维护纪律（收尾必须 `codewiki_generate`、不要手改 `.codewiki/`、编译是后台任务不要等、路径用绝对路径、与代码一起提交）。
- `installUpdateReminder(ctx, config)`：`index.js:2775-2807`，给每个 agent 注入 `systemPrompt.section`（`name: 'codewiki:update-reminder'`，order 取 `TOOL_REPORT` + 1）；`text` 是回调，每次组装系统提示都实时求值：开关关闭、无 `cwd`、仓库根无 `CodeWiki.md` 一律返回空串。存量 agent 经 `agents.list()` 遍历，新增的走 `agent/created`。
- `apply(ctx, config)`：`index.js:2809-2869`，插件入口。顺序为：存 `hostCtxRef` → 注入 `agents`/`llm` → `createJobService(config, wakeCompileSession)` → `service.start()` → `ctx.effect(() => () => service.stop())`（必须返回清理函数本身，写成 `() => service.stop()` 会在启动时当场停服）→ 构造三个工具定义 → 起 60 秒心跳的自动更新调度器 `autoScan`（`index.js:2822-2846`，按 `autoUpdateMin` 节流，对历史工作区逐个 `scope: 'auto'` 提交，单仓库失败只记 `lastError`）→ 经 `ctx.inject(['tools'])` 注册四个工具（**逐个 try/catch**：单个 schema 违规只丢该工具，否则 cordis 会把 apply 回调失败视为 fiber FAILED 并回滚已注册的全部工具，`index.js:2859-2866`）→ `installWebServer` → `installUpdateReminder`。

### client.js — 浏览器半侧

**入口与挂载**

- 文件头注释 `client.js:3-10` 记录了全部硬约束：两个挂载点（`plugins.item` 设置表单、`main` + `sidebar.panellist` 侧边栏面板）、设置经 `configForms`（命名空间 `'codewiki'`）读写、**`id` 必须等于 `package.json` 的 `name`**（client-modules 按 nearestPackage 的 name 校验注册者）、**词典值必须是字符串**（函数会让 `t()` 回退返回键名）。
- `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) {...} })`：`client.js:10-11`。
- 常量：`NS = 'codewiki'`（`client.js:18`）、`KEY = 'codewiki'`（`client.js:18`，`sidebar.panellist` 的 id 必须与 `main` 的 key 一致）、`JOBS_PATH`（`client.js:19`）、`CONTROL_PATH`（`client.js:20`）、`PANEL_ORDER = 52`（`client.js:20`，排在 dsh-hindsight-on-demand 的 50 之后）、`POLL_MS = 2000`（`client.js:23`）、`REPOS_PATH`（`client.js:23`）、`MODELS_PATH`（`client.js:24`）、`REPOS_POLL_MS = 10000`（`client.js:24`）、`ACTIVE_STAGES = ['plan','articles','crosscut','compose','review','index']`（`client.js:24`）。
- `zh()`：`client.js:28-143`；`en()`：`client.js:144-259`，两份完整词典（面板文案、阶段名、状态名、调度器文案都在内）。
- `style`：`client.js:261-341`，用 `document.createElement('style')` 拼 CSS 字符串并挂 `data-plugin="@local/dsh-codewiki"`；注入前查重，避免 HMR 重复加载堆叠样式表（`client.js:341`）。
- `el(tag, props, ...children)`：`client.js:344-346`，`React.createElement` 的薄封装。
- `apiGet(p)`：`client.js:347-352`；`apiPost(p, data)`：`client.js:353-362`，都从响应体里取 `error` 字段抛错。
- `apply(ctx)`：`client.js:366-401`。`inject: ['slots', 'locale', 'configForms']`（`client.js:366`）。`ctx.locale.register(NS, { zh: zh(), en: en() })` 包在 `ctx.effect` 里（`client.js:368`）；`form = ctx.configForms.get(NS)`（`client.js:368`）；`plugins.item` 只在宿主服务该命名空间期间挂载——用 `configForms.whileServed([NS], mount)`，老宿主无该方法时直接 `mount()`（`client.js:374-386`）；`main` + `sidebar.panellist` 两个注册同在一个 `ctx.effect` 里，disposer 逐个兜异常（`client.js:389-400`）。

**组件**

- `CodewikiCard(props)`：`client.js:406-688`，设置卡片。`props.view === 'summary'` 时只返回一行简介（`client.js:454`）。状态有 `snapshot`（`form.getSnapshot()`）、`draft`、`notice`、`error`、`catalog`、`catalogError`。首次挂载拉 `/api/codewiki/models` 填级联下拉（`client.js:416-429`），拉不到就退回手填形态。配置快照通过 `form.subscribe` 订阅，只有 `revision` 变化才覆盖草稿（`client.js:437-455`）。`dirty` 用 `JSON.stringify(draft) !== JSON.stringify(snapshot.value)` 判定（`client.js:463-467`）。`save()`（`client.js:475-503`）先本地校验 `maxConcurrency` 必须是 1–8 的整数、`batchThinkingBudget` 必须是 0–32768 的整数，然后**只对真正变了的 13 个 key 生成 `set` op**，带 `snapshot.revision` 调 `form.mutate`（乐观并发，冲突提示 `conflict`）。`discard()`（`client.js:504-508`）回滚草稿。
- `repoName(cwd)`：`client.js:701-704`，取最后两段路径（Temp 沙箱残留一眼可辨）。
- `fmtMs`：`client.js:705-711`；`fmtTok`：`client.js:712-717`（M/k 缩写）；`fmtDur`：`client.js:718-723`；`fmtAgo`：`client.js:724-728`。
- `Spark({ values, width = 56, height = 16 })`：`client.js:729-742`，纯 SVG `polyline` 微趋势线，少于 2 个有效点返回 `null`。
- `stepName(s)`：`client.js:745`；`lastTimedStage(job)`：`client.js:746-749`，取 `stageTimings` 的最后一个 key 作为失败/取消时的定位点。
- `stageBar(job)`：`client.js:750-772`，六阶段步骤条。已完成绿点（`title` 带该阶段耗时）、当前阶段实心点 + 实时计时（`stageStartedAt` 起算）、终态时 `done` 全绿、`failed`/`cancelled` 在最后计时段标红/黄。
- `STAGE_WEIGHTS`：`client.js:774`，`{ plan: 0.05, articles: 0.6, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }`。`overallPct(job)`：`client.js:775-783`，六阶段定权线性推进 + 阶段内按 `taskList` 完成数折算，**封顶 99，只有 `done` 才 100**。
- `throughputBadge(job, sparkOf, rateOf)`：`client.js:786-806`。三级显示：有 `job.tps` → `tok/s` + spark；有 `batchSubmittedAt` 且有速率样本 → `篇/分 · ETA`；只有 `batchSubmittedAt` → 批次已执行时长。
- `usageLine(job)`：`client.js:808-824`，输入（提交时估算）/输出（实测）token、请求数（分批量/实时通道）、超 32k 档请求数红字提示。
- `ReposTab()`：`client.js:827-970`，总览标签页。轮询 `/api/codewiki/repos`（`client.js:835-852`，`inFlightRef` 防重叠）；`toggleExclude(r)`（`client.js:857-875`）直接改 `excludePaths`（与设置卡同一 `form.mutate` 链路），成功后 `POST {action:'refresh'}` 再重拉；`compile(cwd)`（`client.js:877-884`）发 `{action:'compile', cwd}`。渲染出错时返回 `Repos error: <stack>`（`client.js:939`），不让整块白屏。
- `CodewikiPanel()`：`client.js:972-1172`，侧边栏主面板。轮询 `JOBS_PATH`（`client.js:983-1023`），并在面板侧做**客户端采样**：`sparkRef`（jobId → 最近 30 个 tps 点，`client.js:998-1004`）与 `batchRateRef`（EWMA，系数 `0.6 * prev + 0.4 * inst`，`client.js:1006-1010`）；上一次请求未回包时不重叠拉取（`client.js:992`）。`cancel(jobId)`：`client.js:1030-1037`；`copyPath(p)`：`client.js:1039-1047`；`jobCard(job)`：`client.js:1066` 起渲染单个任务（状态、阶段条、进度条、吞吐徽标、任务明细、活动流、错误行）。
- `PanelIcon(props)`：`client.js:1174-1185`，16×16 摊开的书 SVG。

## Architecture

```text
┌──────────────────────────────┐        ┌──────────────────────────────────────┐
│ 浏览器半侧 client.js          │        │ 宿主半侧 index.js                     │
│                              │        │                                      │
│ CodewikiCard  settings──┐    │ config │  apply() 2809 ─ Config 37             │
│   (plugins.item)        │    ├───────►│    ├─ cwTool/generate/update/progress │
│ CodewikiPanel ──────────┤    │        │    ├─ installWebServer 2526           │
│   main + panellist      │◄───┼─ HTTP ─┤    └─ installUpdateReminder 2775     │
│ ReposTab / PanelIcon    │    │ 回环    │                                      │
│ stageBar/overallPct 774 │    │        │  createJobService 1192                │
└──────────────────────────┘        │    │   tick() 2013 ─ per 10s ─┐            │
                                    │    │   STAGE_HANDLER 2004     │            │
                                    │    │   settleJob 1320 ◄───────┘            │
                                    │    │   batchRuns/Results/Aborters 1392     │
                                    │    └──────────┬───────────────────────────┘
                                    │               │ runRealtimeTasks 324
                                    ▼               ▼
                    ┌───────────────────────┐  ┌──────────────────────────────┐
                    │ 本地 cw CLI           │  │ 百炼 chat/completions 283     │
                    │ resolveBinary 82      │  │ 或宿主 llm 服务 llmChat 261   │
                    │ runCw 104（120s 超时）│  │ 或会话通道 dispatchSession 1467│
                    └───────────────────────┘  └──────────────────────────────┘

持久化（同目录、同生命周期）：JOBS_FILE 1015 · REPOS_FILE 1045
  · JOBS_LOCK_FILE 1105（60s 过期） · SESSION_TASK_DIR 1021
```

三条执行通道的取舍是这张图的核心：批量通道（百炼直连或宿主 llm）吃 ≤28k 单请求与多批观察；会话通道在该模块连 200k 都装不下时兜底，把写作/校对交给发起会话的子智能体；`cw` CLI 只负责判态、建索引、刷基线这三件「本地事实」工作，不参与任何文本生成。

## Data Flow

1. **初始化**：`apply()`（`index.js:2809`）建服务、`service.start()` 起 10s tick、注册四个工具、装 Web 端点与系统提示提醒；`client.js` 的 `apply()`（`client.js:366`）注册词典、样式、设置卡片与侧边栏面板。
2. **提交判态**：调用方（模型工具 / 面板编译按钮 / 自动调度）→ `codewiki_generate.execute`（`index.js:2193`）→ `cw status` → `parseStatus`（`index.js:155`）得四态之一。
3. **建 job**：`svc.submit`（`index.js:2059`）先落 `submitting` 占位、解析凭证、再置 `plan`（full）或 `articles`（stale），`persist()` + `flush()` 后立即 `void tick()`。
4. **规划** `tickPlan`（`index.js:1565`）：`scanRepoFiles` → 先试主模型规划（`runMainModelPlan`）→ 降级百炼批量 → 均不可用则 `localPlan` 按顶层目录分组。产出 `job.plan = { project, modules[], concepts[] }`。
5. **写文章** `tickArticles`（`index.js:1665`）：`job.plan.modules` → 任务（`name: modules/<slug>.md`）→ `prepareArticleTasks`（`index.js:578`）分流：
   - `prepared` → `submitBatchFor`（`index.js:1440`）→ `startBatchChatRun`（`index.js:1395`）→ `runRealtimeTasks`（`index.js:324`）并发打模型；
   - `#obs` 观察批 → 收割后 `batchArticleComposePrompt`（`index.js:816`）合成；
   - `sessionTasks` → `dispatchSessionTasks`（`index.js:1467`）写任务文件 + steer 会话。
   结果回 `batchResults`，下一轮 `settleJob`（`index.js:1320`）收割 → `tally`（`index.js:1365`）→ `writeValidated`（`index.js:1346`，frontmatter 闸门 + `fixAnchors` 修锚点）落盘。
6. **横切** `tickCrosscut`（`index.js:1799`）：读回成功文章全文 → ≤28k 单批直出 `_architecture.md`/`_patterns.md`/概念文章；超预算改「每篇一个观察」→ `tickCompose`（`index.js:1865`）合成。
7. **校对** `tickReview`（`index.js:1914`）：`localReview`（`index.js:1892`）先本地核对 frontmatter/文件存在性/`source_files`，再按文章+源码装填 `batchProofreadPrompt`（`index.js:848`）；结果 `tally(..., { replace: true })` 覆盖同名条目，校对失败不推翻原文。
8. **索引** `tickIndex`（`index.js:1979`）：`cw index` → `cw meta update` → `normalizeIndexLinks` → `ensureWikiEntry` → `done` + `finishedAt` + `onSettled(job, 'done')` → `wakeCompileSession`（`index.js:1179`）steer 发起会话提改动提醒。
9. **进度回流**：面板每 2s 拉 `/api/codewiki/jobs`（`client.js:945`），每 10s 拉 `/api/codewiki/repos`；`jobSummary`（`index.js:1131`）的 `taskList` 决定进度条分母，`STAGE_WEIGHTS`（`client.js:774`）决定进度条权重，tps/速率由面板侧采样计算。
10. **取消**：`cancel()` 置 `cancelRequested` 并 `flush`（`index.js:2118`）；下一轮 `tick` 读到后 `abort` 在飞请求（未完成请求不计费）、丢弃未收割结果、置 `cancelled`（`index.js:2037-2048`）。
11. **重启接管**：进程重启后新 `instanceId` 与原 `owner` 不符，`tick` 在 `idleMs > ORPHAN_TAKEOVER_MS` 时改 owner 接管（`index.js:2027-2034`）；在途会话任务补发 steer（`resendSessionSteer`），批量任务的执行器已随连接消失，靠 `settleJob` 用 `job.tasks` 的 `batchPrompt` 快照重跑。

## Connections

- 上游 CLI：`[[cw-cli-wrapper]]`（本模块经 `runCw` `index.js:104`、`parseStatus` `index.js:155`、`normalizeArticlePath` `index.js:141` 与 `cw` 交互）。行号锚点的对照实现与 `test-wiki-anchors.mjs` 同源（见 `index.js:165-168` 注释）。
- 提示词工程：`[[prompt-templates]]`（`articleFormatSection` `index.js:642-671` 与各 `batch*Prompt` 家族是本文类的产出格式与判据来源）。
- 持久化与并发：`[[job-store-and-locking]]`（`JOBS_FILE`/`JOBS_LOCK_FILE`/`REPOS_FILE`、`mergeFromDisk`、`dirtyIds` 的语义在此展开）。
- 面板与宿主 UI：`[[sidebar-panel-ui]]`（`client.js` 的 slot 挂载、词典、样式、组件树）。
- 外部依赖：阿里云百炼 OpenAI 兼容入口（`index.js:330`）、宿主 `llm` 服务（`llmChat` `index.js:261`）、宿主 `agents` 服务（`wakeCompileSession` `index.js:1179`）、`credentials` 服务（`resolveBatchApiKey` `index.js:546`）、`webServer` 服务（`installWebServer` `index.js:2526`）、`workspaceRegistry` 服务（`index.js:2536`）、`systemPrompt` 服务（`installUpdateReminder` `index.js:2775`）。
- 参考实现：侧边栏面板的挂载方式与 `dsh-hindsight-on-demand` 同款，`PANEL_ORDER = 52` 排在它的 50 之后（`client.js:21`）。

## Known Issues

- **Token 估算只是近似**：`estimateTokens`（`index.js:247`）用「CJK 1 token/字 + 其余 3.5 字符/token」，与真实分词器有偏差。预算靠 `BATCH_TOKEN_BUDGET = 28000` 留的 ~4k 余量吸收，但边界任务仍可能被实际计费判进 32k 以上档（`submitBatchFor` 会在 `over_tier2` 里显式提示，`index.js:1444-1446`）。
- **锁是单文件 + 60 秒过期**：`acquireTickLock`（`index.js:1108`）靠 `wx` 独占创建 + mtime 判断，进程崩溃残留的锁要等 60 秒才被强删；这段时间内所有实例都让路，任务原地停摆。`releaseTickLock`（`index.js:1123`）只在 `finally` 执行，异常路径可能留下短期残锁。
- **执行器随连接生死**：`runRealtimeTasks` 的请求没有服务端批次可续查，宿主一重启就只剩「按 `batchPrompt` 快照全阶段重跑」这一条路（`settleJob` `index.js:1330-1342`）。快照缺失时直接 `fail`，已写成的文章不回滚但本阶段作废。
- **会话通道依赖发起会话存活**：`dispatchSessionTasks`（`index.js:1467`）在无 agent 或无 `steer` 时直接 fail（`index.js:1470-1474`）。面板、自动调度这类无会话提交一旦触发超预算任务就必然失败，只能「从会话内重新提交编译」。会话通道也不降级回百炼，超时（默认 30 分钟，`index.js:1010`）即按失败处理。
- **会话通道的收割判据偏松**：`classifySessionTask`（`index.js:1027`）只要求 `mtime >= dispatchedAt` 且以 `---` 开头。子智能体写到一半（frontmatter 已落、正文未完成）时 mtime 与首字符都可能同时满足，`writeValidated` 的闸门同样只看开头三横线（`index.js:1346`），存在把半成品当成品收割的窗口。
- **`fixAnchors` 明示的盲区**：符号在文内出现多处且都不是唯一声明形态时，它选择「不动」并记 `unresolved`（`index.js:460-463`）；点分符号（如 `Config.articleLanguage`）歧义时退试首段，仍可能命中错误行；`source_files` 之外的文件引用一律不碰（`index.js:395-397`），所以 frontmatter 漏列文件时锚点不会被校验。
- **tick 是串行推进**：`tick()`（`index.js:2013`）对 `jobs` 逐个 `await handler`，一个 job 的 `settleJob`/`runCw`（最长 120s）会拖住同实例里其他 job 的推进。`ticking` 重入锁与 `TICK_MS = 10000` 让节拍可能被显著拉长。
- **`cw status` 解析强依赖文本**：`parseStatus`（`index.js:155`）匹配的是 `'No wiki found'`、`'has not been compiled yet'`、`'Wiki is up to date'` 三个英文字面量与 `^\s+[M!]\s+` 行格式。上游 `cw` 改一句文案，三态判定就会整体落到「无法解析 → 改走全量编译」（`index.js:2213`），代价是白跑一次全量。
- **Windows 路径兼容是启发式**：`normalizeCwd`（`index.js:26`）只处理 `/e/...` 这一类 MSYS 盘符写法；`excludedItem`/`rememberRepo`/`samePath` 各自做归一与大小写处理（`index.js:226`、`index.js:1049`、`index.js:2368`），三处规则不完全一致，混合大小写与尾斜杠组合时可能出现「排除了但仍出现在总览」这类不一致。
- **面板的速率/进度是客户端估算**：`overallPct`（`client.js:775`）用固定 `STAGE_WEIGHTS`（`client.js:774`）与实际耗时无关，`batchRateRef` 的 EWMA 也只在面板轮询跨度内有效；刷新页面或换工作区后 tps 曲线与 ETA 会从零重建，不反映真实剩余时间。
- **UI 兜底只覆盖渲染期异常**：`ReposTab`（`client.js:972`）与 `CodewikiPanel`（`client.js:1142-1145`）用 try/catch 把渲染异常显示成 `... error: <stack>`，但样式表或 `@deepseek-ai/dsh-client-ui-primitives` 加载失败发生在更外层，仍可能整块不渲染。
- **面板轮询无退避**：`CodewikiPanel` 固定 2s（`client.js:391`）、`ReposTab` 固定 10s（`client.js:391`），只做了「不重叠」没做指数退避；Web 服务卡顿时前端仍按原频率发请求。
