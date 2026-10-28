---
title: article_batch
type: module
source_files:
  - index.js
  - lib/articles-agentic.js
  - test-batch.mjs
  - test-articles-agentic.mjs
tags: [batch, orchestration, agentic, articles, concurrency]
---

## Overview

`article_batch` 负责把「要写的模块文章」清单组装成可并发执行的批量请求、并在插件内后台并发池里
跑完它们——这是 CodeWiki 流水线 0.10.7 之后「零子代理全批量」主链的核心执行层。模块名里的
"agentic article tasks" 指两条并列的执行通道：

- **单轮通道**（`runRealtimeTasks` @ `index.js:591`）：把源码内联进 prompt，模型一次吐出全文，
  插件落盘。这是 `prepareArticleTasks` @ `index.js:1165` 装配出的批量任务的标准执行器。
- **agentic 通道**（`runAgenticArticles` @ `lib/articles-agentic.js:231`）：模型自己用
  `read_code`/`list_files` 读源码、`edit_article` 增量写文章，来自 `lib/articles-agentic.js`
  （吸收自 FSoft-AI4Code/CodeWiki 的 module agent）。`index.js` 的 `tickArticles`
  @ `index.js:2879` 二选一走哪条。

两条通道共享同一套「任务对象」形状（`customId`/`name`/`articlePath`/`keepInMemory`/
`batchPrompt`/`bigTier`/`provider`/`model`/`reasoningEffort`）与同一套结果记账
（`tally` @ `index.js:2550`、`applyTaskResult` @ `index.js:553`）。装配（`prepareArticleTasks`）
处理超预算拆分逻辑：单请求装得下就单批直出；装不下就拆成多个「观察批」（`#obs`，keepInMemory）
各自跑完后再合成一篇完整文章；连大档预算（`bigProvider`/`bigModel`）都装不下的单文件才转
会话通道兜底（`dispatchSessionTasks` @ `index.js:2797`），由发起会话模型派子智能体完成。

编排服务以 10s tick（`TICK_MS` @ `index.js:1877`）推进每个 job 的阶段机：
`articles → crosscut → compose → review → index → commit`。本模块覆盖的是其中「任务装配 +
并发执行 + 会话通道兜底」这一部分。`listModelCatalog` / `resolveModelEfforts` / `installWebServer`
是支撑「编译模型设置」与「本地面板后端」的辅助导出，供设置页级联下拉与 `/api/codewiki/*`
回环端点使用。

所有模型调用都走**宿主 llm 服务**这一唯一通道（`llmChat` @ `index.js:467`），凭证由宿主按
provider 解析，插件不存任何密钥（0.10.1 删除了内置百炼直连通道，见 `test-batch.mjs:518` 的
`resolveBatchApiKey === undefined` 断言）。

## Key Components

以下为本模块对外导出的函数与内部支撑函数（含行号区间与用途）。任务对象字段贯穿全文。

### 输入装填与 token 预算

- `estimateTokens(text)` @ `index.js:449` — 粗算 token 数：CJK 字符 ≈1 token/字，其余（ASCII 代码为主）
  ≈3.5 字符/token。只为把单请求装进模型上下文（hy3 192k），非精确分词。被 `collectSources` /
  `prepareArticleTasks` / `packArticles` / `scanRepoFiles` 等广泛使用。
- `BATCH_TOKEN_BUDGET` @ `index.js:663` — 单个请求输入 token 预算，默认 `110000`（hy3 上下文 192k、
  输出上限 64k，扣余量后取 110k）。普通档装填上限。
- `BATCH_TOKEN_HARD_LIMIT` @ `index.js:668` — 超预算兜底装填上限，默认 `128000`（hy3 真实窗口反推：
  输入+输出共享 192k、输出上限 64k，故输入必须 ≤128k）。
- `numberLines(content)` @ `index.js:679` — 给源码每行加「`N| `」grep 风格前缀（`1| let x = ...`），
  让模型引用行号以前缀为准而非自己数行。尾部至多去一个换行；空文件输出 `1| `。
- `collectSources(cwd, files, budget=BATCH_TOKEN_BUDGET)` @ `index.js:1094` — 把源文件内联成 markdown
  文本，按 token 预算**整文件**装填（不做半文件截断，避免行号误导）。返回
  `{ text, skipped, oversized }`：`skipped` 是预算装不下的文件清单；`oversized=true` 表示连第一个
  文件都装不下（返回仅这一个文件，由上层转超预算兜底）。缺文件在文内标注「文件不存在或读取失败」，
  不抛错。
- `packArticles(articles, budget=BATCH_TOKEN_BUDGET)` @ `index.js:1409` — 横切输入装配：预算内整篇
  装填；装不下的只装「头部」（frontmatter + Overview 段，截在 `## Key Components` 之前）并标注
  「超预算，仅头部」。输入 `{name, text}[]`，输出拼接文本。
- `localPlan(files)` @ `index.js:1300` — 本地规划：按顶层目录分组生成模块清单（0.10.7 起唯一规划
  路径，模型勘探阶段已删）。`{project, modules, concepts:[]}`，每个 module 含 `name`/`summary`/`files`。
- `scanRepoFiles(cwd)` @ `index.js:2121` — 仓库源码扫描（本地规划/语义规划输入）：黑名单目录
  `SCAN_SKIP_DIRS` @ `index.js:2107` + 二进制后缀 `SCAN_SKIP_EXT` @ `index.js:2112` + 单文件 256KB +
  总数 2000 上限。返回 `{path, bytes}[]`。

### 任务装配（核心）

- `batchArticlePrompt({language, mission, sourcesText, prevArticle})` @ `index.js:1125` — 单轮文章
  prompt 模板：语言声明 + 任务 + 内联源码（带行号前缀）+ 可选旧文 + frontmatter/格式规范
  （`articleFormatSection`）。要求「只输出文章本身，禁止用 markdown 围栏整体包裹」。
- `articleFormatSection()` @ `index.js:1256` — 文章格式规范模板（Overview / Key Components /
  Architecture / Data Flow / Connections / Known Issues 等章节要求）。本仓 `modules/` 文章格式即据此。
- `batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal)` @ `index.js:1491`
  — 文章分割「观察批」prompt：一批源码 → 该批紧凑技术观察（保留函数/类/常量/行号，不贴大段源码）。
- `batchArticleComposePrompt({language, mission, moduleName, observationsText, prevArticle})` @ `index.js:1511`
  — 文章分割「合成」prompt：全部批次观察（+可选旧文）→ 完整模块文章。输入体积远小于原始源码。
- `prepareArticleTasks(tasks, {cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget})` @
  `index.js:1165` — **批量任务装配主函数**。把通用任务清单（`{name, mission, sources, articlePath,
  prevArticlePath, customId?}`）装填成批量请求，返回 `{ prepared, sessionTasks }`。逻辑：
  - 判定大档是否启用（`bigTier`，由 `bigProvider` 决定，未配置则 `null`）。
  - 单文件装填上限 = 大档启用则 `bigBudget`，否则 `BATCH_TOKEN_HARD_LIMIT`（128k）。
  - `tooBig`（单文件连大档都装不下）→ `emitSession` 进 `sessionTasks`（会话通道兜底）。
  - 整任务一个请求装得下（普通档预算内，或 110k–singleLimit 走大档）→ `emitSingle` 进 `prepared`
    （prompt 超 110k 普通预算时 `markBig(t)` 打大档标记 `t.bigTier=true`、`t.provider`/`t.model`/
    `t.reasoningEffort`）。
  - 装不下 → 逐文件按 110k 普通预算拆成多个观察批（`#{name}#obs${i}`，`keepInMemory:true`），
    收割后拼观察包提交一个合成请求（`composePlan` 携带 `articlePath`/`mission`/`prevArticlePath`）。
  - 拆完只剩一批 → 按普通预算单请求写完。
  - 任务对象上 `model`/`provider`/`reasoningEffort`/`bigTier` 决定该任务用哪个模型跑；
    `sessionTasks` 带 `batchPrompt`（派发时写入任务文件供子智能体读取）。

### 单轮执行通道

- `llmChat({llm, provider, model, reasoningEffort, prompt, signal, onDelta})` @ `index.js:467` — 宿主 llm
  服务通道（唯一通道）。走 `llm.stream`，`temperature:0`；支持 `reasoningEffort` 档位；遇到
  `UNSUPPORTED_REASONING_EFFORT` 自动剥掉 effort 用模型默认档重试一次；`finish.kind==='error'|'aborted'`
  抛错。返回 `{content, outputTokens}`。`onDelta` 每 chunk 回调（会话记录器做实时落盘）。
- `runRealtimeTasks(tasks, {model, reasoningEffort, concurrency, bigConcurrency, notes, onTaskDone,
  signal, llm, provider, onRequestStart})` @ `index.js:591` — **单轮通道并发池执行器（唯一执行器）**。
  - 分池：带 `bigTier===true` 的任务进大档池（`bigConcurrency`，0/未传则回落 `concurrency`），
    其余进默认档池（`concurrency`）。两池各自独立限流、同时推进。
  - 每 worker 消费队列：按 `t.provider||provider` 与 `t.model||model` 路由（任务自带 provider+model
    时 effort 完全以任务为准，不回落默认档）；`temperature` 固定 0；`onTaskDone` 上报
    `{outputTokens, durationMs}` 供 tps 采样。
  - 结果经 `applyTaskResult(t, content, notes)` 落盘/回内存，进 `results` Map（`customId → 结果`）。
  - 单任务失败只记账（`notes.push`），`stopReason:'error'`，不影响其它任务；`signal.aborted` 时
    池子停止消费。
  - `onRequestStart(t)` 返回 `{onDelta, onDone, onError}` 钩子（面板「会话」视图记录用）。
- `applyTaskResult(task, content, notes)` @ `index.js:553` — 任务结果统一出口。`keepInMemory` 任务
  （横切/校对）只回 `{name, ok:true, content}`；文章任务经**契约闸门** `contractCheck` 校验（坏文章
  不落盘，`stopReason:'contract'`），通过后 `fixAnchors` 校正行号锚点再 `fs.writeFileSync` 落盘
  （`stopReason:'completed'`）；落盘异常 `stopReason:'error'`。
- `validateArticleEnvelope(content)` @ `index.js:1082` — 文章信封校验：必须以 `---` 开头、并以独占一行的
  `---` 闭合（否则半截 frontmatter 能落盘却永不校正锚点）。返回 `null`=合格，否则原因短语。
- `fixAnchors(content, cwd)` @ `index.js:856` — 落盘前把 `file:NN(-MM)` 锚点对照源码确定性校正
  （含 CHANGELOG 版本节重定位 `fixChangelogAnchors` @ `index.js:709`、单/多锚点就近绑定、倒序区间翻正）。
  返回 `{text, fixed, unresolved}`。

### agentic 执行通道（`lib/articles-agentic.js`）

- `runOneArticle(task, {...})` @ `lib/articles-agentic.js:33` — 单篇跑一次 agentic 循环并落盘。模型用
  `read_code`/`list_files` 读源码、`edit_article` 增量写（不再内联源码）。支持子模块派发
  （`generate_sub_module`，递归深度封顶 `subDepth=2`，子文章落 `<wiki>/modules/<父>/<子>.md`）、
  写集闸门 `allowedWritePaths`（`isWritable`）、`fixAnchors` 校正。空文章算失败。
- `sourceTokensOf(task, cwd, {fsImpl, pathImpl})` @ `lib/articles-agentic.js:185` — 模块源文本量估算
  （与 `estimateTokens` 同口径），给 `markBigAgenticTasks` 当判据。
- `resolveTaskRoute(task, {provider, model, reasoningEffort})` @ `lib/articles-agentic.js:208` — 单任务
  选档：任务自带 provider+model 时完全以任务为准（含 effort），否则用参数默认档。
- `runAgenticArticles(tasks, {concurrency, bigConcurrency, notes, signal, onTaskDone, onRequestStart,
  ...rest})` @ `lib/articles-agentic.js:231` — **agentic 通道并发池执行器**，与 `runRealtimeTasks`
  同形状（返回 `Map(customId→结果)`）。双池（bigTier 走大档池），每任务跑 `runOneArticle`，
  收集子模块派生信息，输出 `outputTokens` 粗估。失败只记账。
- `markBigAgenticTasks(tasks, {bigTier, sizeOf})` @ `lib/articles-agentic.js:320` — 按模块源文本量给
  agentic 任务打大档标记（`provider`/`model`/`bigTier`/`reasoningEffort`），与单轮通道 `markBig` 同语义。

### 会话通道兜底（`index.js`）

- `classifySessionTask(task, nowMs=Date.now())` @ `index.js:2032` — 会话通道任务收割三态：
  `timeout`（派发后超 `SESSION_TASK_TIMEOUT_MS` @ `index.js:1881`，默认 30 分钟未产出）/
  `harvest`（目标文件已产出、mtime≥派发时间、以 `---` 开头）/`wait`（尚未产出/旧文件未更新/写一半）。
- `buildSessionSteerText({job, snapshots, tier, resend})` @ `index.js:2049` — 会话通道 steer 文本：
  `sessionTier` 非空时把档位钉死（要求 delegate 显式传 `tier`、不依赖自动选路）。review 阶段用校对措辞。
- `dispatchSessionTasks(job, tasks)` @ `index.js:2797` — 把完整写作指令写入任务文件
  （`SESSION_TASK_DIR` @ `index.js:1882`），steer 一条短消息给发起会话；快照随 `job.sessionTasks`
  持久化。发起会话不可用时 `fail` 返回 `null`。
- `progressSessionTasks(job)` @ `index.js:2835` — 会话通道收割：`harvest` 落盘入账、`timeout` 记失败、
  `wait` 留待下轮；全部终态才推进。
- `resendSessionSteer(job)` @ `index.js:2858` — 宿主重启接管后重发 steer（`resend:true`），不重置
  `dispatchedAt`。

### 编排服务内部（阶段机驱动，调用上面的装配/执行）

- `submitBatchFor(job, prepared)` @ `index.js:2755` — 把装配好的批量任务固化进 `job.tasks`（持久化
  `batchPrompt`/`bigTier`/`splitFor`/`composePlan`/`proofreadItems`，供宿主重启重跑），启动
  `startBatchChatRun`，记并发与模型文案。
- `startBatchChatRun(job, prepared)` @ `index.js:2629` — 单轮通道执行器包装：包 `runRealtimeTasks`，
  结果进 `batchResults`，由 `settleJob` 收割；带 `AbortController` 取消钩子与 `onRequestStart` 会话记录。
- `startAgenticRun(job, tasks)` @ `index.js:2676` — agentic 通道执行器包装：包 `runAgenticArticles`，
  同样进 `batchResults` 由 `settleJob` 收割。
- `tickArticles(job)` @ `index.js:2879` — articles 阶段：组装任务（stale 用预构建 / full 本地规划）→
  `prepareArticleTasks` 装配 → `submitBatchFor` 提交（或 agentic 通道 `startAgenticRun`）；收割后处理
  观察批合成（`tickCompose`）、agentic 失败退回单轮（`shouldFallBackHere` @ `index.js:2585`）。
- `beginSessionRecord(job, task)` @ `index.js:1984` — 记录每个 LLM 请求的 prompt/流式输出到
  `SESSIONS_DIR`（面板「会话」视图数据底座），3s 节流写、完成时全文覆盖。

### 模型目录与面板后端

- `listModelCatalog(llm)` @ `index.js:4265` — 枚举宿主 llm 服务里已注册的 provider 及其模型，作为设置页
  「编译模型」级联下拉数据源。兼容 `id`/`provider`、`displayName`/`name` 两种字段；单个 provider 的
  `listModels` 抛错不影响其它，条目保留附 `error`；llm 未注入返回 `{ok:false, providers:[]}`。
- `resolveModelEfforts(llm, provider, model)` @ `index.js:4303` — 单个 provider/model 的「思考程度」档位
  （`resolveModelInfo` 的 `reasoning.efforts` + `defaultEffort` + `context.tokens`），设置页下拉数据源。
  失败返回 `{ok:false, efforts:[], defaultEffort:null}`。
- `installWebServer(ctx, service, extra)` @ `index.js:4327` — 本机面板后端：注册
  `GET /api/codewiki/jobs`、`/repos`、`/sessions`、`/models`、`/model-efforts`、`/control`（均仅回环
  地址，非回环 403）。`listModelCatalog`/`resolveModelEfforts` 在此被端点调用。

### 辅助解析

- `slugify(name)` @ `index.js:1670` — 顶层目录名 → 模块 slug（保留 CJK，清空格）。
- `parseSourceFiles(fm)` @ `index.js:1676` — 从 frontmatter 文本解析 `source_files`（inline `[a,b]` 与
  block `- a` 两式），返回相对路径数组。
- `readSourceFiles(articlePath)` @ `index.js:1690` — 读文章 frontmatter 取 `source_files`。

## Architecture

```text
   ┌─────────────────────────── tickArticles (index.js:2879) ───────────────────────────┐
   │  组装任务：scanRepoFiles→buildPlan(localPlan/semanticPlan)→模块任务清单            │
   └───────────────┬──────────────────────────────────────────────────┬───────────────┘
                   │  agenticArticles 开关 (Config.agenticArticles)      │
                   ▼                                                    ▼
   ┌───────────────────────────┐                  ┌──────────────────────────────────────┐
   │  prepareArticleTasks       │                  │  markBigAgenticTasks                 │
   │  (index.js:1165)           │                  │  (articles-agentic.js:320)           │
   │  单轮通道任务装配           │                  │  agentic 通道打大档标记                │
   └───────────────┬───────────┘                  └──────────────────┬───────────────────┘
                   │ {prepared, sessionTasks}                        │ agenticTasks
     ┌─────────────┴──────────┐                              ┌───────▼────────────────────┐
     │ dispatchSessionTasks    │ (超预算单文件)               │ startAgenticRun            │
     │ (index.js:2797)         │                              │ (index.js:2676)           │
     │ 会话通道兜底             │                              │  runAgenticArticles       │
     └─────────────┬──────────┘                              │  (articles-agentic.js:231)│
                   │ 会话模型→子智能体写盘                     │  runOneArticle×N          │
                   ▼                                          └────────────┬───────────────┘
   ┌───────────────────────────┐                                          │ Map(customId→res)
   │ submitBatchFor            │                                          ▼
   │ (index.js:2755)           │                          ┌──────────────────────────────┐
   │ 固化 job.tasks + 启动执行  │                          │ settleJob→tally 记账          │
   └───────────────┬───────────┘                          └──────────────────────────────┘
                   ▼
   ┌───────────────────────────┐   双池并发（bigTier 分池）    ┌──────────────────────────────┐
   │ startBatchChatRun         │───► runRealtimeTasks          │ llm.stream (宿主 llm 服务)   │
   │ (index.js:2629)           │    (index.js:591)            │ llmChat (index.js:467)        │
   └───────────────┬───────────┘                             └──────────────────────────────┘
                   │ Map(customId→res)
                   ▼
   ┌───────────────────────────┐
   │ tally (index.js:2550)      │  文章任务→applyTaskResult 落盘(契约闸门+fixAnchors)
   │                          │  横切/校对 keepInMemory→writeValidated 校验后落盘
   └───────────────────────────┘

   会话通道回收：classifySessionTask(index.js:2032) → progressSessionTasks(index.js:2835)
                 buildSessionSteerText(index.js:2049) / resendSessionSteer(index.js:2858)
```

## Data Flow

## Connections

## Known Issues
