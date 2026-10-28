---
title: articles_agentic
type: module
source_files:
  - lib/articles-agentic.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/article-contract.js
  - index.js
  - test-articles-agentic.mjs
tags: [agentic, orchestration, batch, article-writing]
---

## Overview

`articles_agentic` 是 dsh-codewiki 的**第二条文章执行通道**（agentic 通道），与 `index.js` 里 `runRealtimeTasks` 驱动的**单轮通道**（源码整包内联进 prompt → 模型一次吐出全文 → 插件落盘）并列。它吸收自 FSoft-AI4Code/CodeWiki 的 module agent：模型不再依赖插件把源码塞进上下文，而是自己用 `read_code`/`list_files` 现场读源码、用 `edit_article` 增量地写文章，必要时用 `generate_sub_module` 把大模块拆给子任务单独成文。

核心文件是 `lib/articles-agentic.js`（本模块主体，334 行），它把"单篇执行"与"批量编排"两层职责合在一处：

- **单篇执行**：`runOneArticle`（lib/articles-agentic.js:33）跑一次 agentic 循环并把文章落盘，同时负责子模块递归派发与写集闸门。
- **批量编排**：`runAgenticArticles`（lib/articles-agentic.js:231）是并发池，形状与 `runRealtimeTasks` 一致（返回 `Map(customId → 结果)`），但每个任务跑的是 agentic 循环而非单轮 prompt。
- **辅助**：`sourceTokensOf`（lib/articles-agentic.js:185）、`resolveTaskRoute`（lib/articles-agentic.js:208）、`markBigAgenticTasks`（lib/articles-agentic.js:320）为批量编排提供"按源文本量打大档标记、按任务自带档位选路"等判据。

循环本体在 `lib/agentic.js`（`runAgenticArticle`，lib/agentic.js:331），工具实现（`makeReadCodeTool`、`makeArticleEditor` 等）、工具 schema（`TOOL_SCHEMAS`，lib/agentic.js:27）与开场提示词（`buildOpeningPrompt`，lib/agentic.js:506）都在那里。宿主 llm 服务适配（`makeHostStream`/`toRequestMessages`/`makeFsWorkspace`）在 `lib/agentic-host.js`，写集闸门（`makeWriteSet`/`isWritable`）在 `lib/article-contract.js`。

失败语义与单轮通道一致：单任务失败只记账、不影响其它任务；任何环节（缺 llm / 无 workspace / agentic 循环抛错）都返回 `ok:false`，由调用方（`index.js` 的 `startAgenticRun` 与 fallback 逻辑）决定是否整体降级到单轮通道（见 [[index]]）。

## Key Components

本模块（`lib/articles-agentic.js`）对外导出的全部符号：

- `DEFAULT_MAX_STEPS`（lib/articles-agentic.js:21）—— 再导出自 `lib/agentic.js` 的唯一定义点（=30，lib/agentic.js:325）。保持既有导入路径可用（`index.js` 与测试都从本模块拿），避免又出现一份独立常量。
- `runOneArticle(task, opts)`（lib/articles-agentic.js:33）—— 单篇跑一次 agentic 循环并落盘。返回 `{ ok, stopReason, article, steps, usedTools, outputTokens, subModules }`。详见 [[#Architecture]] 中的子模块派发与写集闸门逻辑。
- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（lib/articles-agentic.js:185）—— 估算模块源文本量（近似 token 数），供 `markBigAgenticTasks` 当判据。CJK 按 1、其余按 3.5 字符/token（lib/articles-agentic.js:320-329），与 `index.js` 的 `estimateTokens` 同口径。读不到的文件按 0 计（lib/articles-agentic.js:182）。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（lib/articles-agentic.js:208）—— 单任务选档。任务自带 `provider`+`model`（大档任务，由 `markBigAgenticTasks` 打标）时完全以任务为准，且 `reasoningEffort` 也以任务为准（空 = 模型默认档，绝不回落默认档的 effort，因为默认档 effort 如 `off` 可能不被大档模型支持）；否则全用参数里的默认档（lib/articles-agentic.js:205-222）。
- `runAgenticArticles(tasks, opts)`（lib/articles-agentic.js:231）—— 并发池编排，详见 [[#Architecture]] 的双池设计。返回 `Map(customId → { name, ok, stopReason, steps, tools, subModules })`。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（lib/articles-agentic.js:320）—— 按体量给 agentic 任务打大档标记（纯逻辑，与 `index.js` 的 `prepareArticleTasks` 里 `markBig` 同语义）。`bigTier = { provider, model, reasoningEffort?, budget }`；未配置（无 provider）或 `budget=0` 时原样返回（lib/articles-agentic.js:314-317）。agentic 通道不装填源码，所以单轮通道"装填超预算"判据不适用，改用等价物：模块源文本量超过 `budget` 就当大档（lib/articles-agentic.js:314-318）。

## Architecture

agentic 批量写作的执行链（组件 ≥3，画框图）：

```text
                 ┌─────────────────────────────────────────────────────┐
                 │ index.js: tickArticles (agentic 分支, line 3017)     │
                 │   markBigAgenticTasks(tasks, bigTier, sizeOf)        │
                 │   → 超预算模块标 bigTier:true + provider/model        │
                 └───────────────────────┬─────────────────────────────┘
                                         │ startAgenticRun(job, tasks)
                                         ▼
                 ┌─────────────────────────────────────────────────────┐
                 │ runAgenticArticles (lib/articles-agentic.js:231)     │
                 │   双池：normalTasks → 默认档池(concurrency)           │
                 │         bigTasks    → 大档池(bigConcurrency)          │
                 └───────┬───────────────────────────────┬─────────────┘
                         │ 每任务                          │ 每任务(带 provider/model)
                         ▼                                ▼
                 ┌─────────────────────────────────────────────────────┐
                 │ runOneArticle (lib/articles-agentic.js:33)            │
                 │   makeArticleEditor / makeFsWorkspace                 │
                 │   dispatchSub 闭包（子模块派发, ≤subDepth 层）        │
                 │   isWritable 写集闸门（allowedWritePaths）            │
                 └───────────────┬───────────────────────────────────────┘
                                 │ runAgenticArticle (lib/agentic.js:331)
                                 ▼
                 ┌─────────────────────────────────────────────────────┐
                 │ 工具循环 (maxSteps=30)                                │
                 │   streamFn = makeHostStream (lib/agentic-host.js:83)  │
                 │   tools = { read_code, list_files, edit_article,     │
                 │            generate_sub_module }                      │
                 └─────────────────────────────────────────────────────┘
```

### 双池并发（lib/articles-agentic.js:231-312）

`runAgenticArticles` 把任务分成两池——`bigTier !== true` 的进默认档池（上限 `concurrency`），`bigTier === true` 的进大档池（上限 `bigConcurrency`）。两池各自独立限流、用 `Promise.all` 同时推进（lib/articles-agentic.js:257-311）。`bigConcurrency` 为 0/未传时回落到 `concurrency`（lib/articles-agentic.js:250-255）。大档常是付费长上下文，与免费默认档配额互不相干（lib/articles-agentic.js:227-230）。

每个 worker（`runPool`/`worker`，lib/articles-agentic.js:257-308）从游标取任务，先调 `onRequestStart(t)`（可选记录器钩子，返回 `{ onDelta }`）拿到 `rec`，再 `resolveTaskRoute` 选档后交给 `runOneArticle`。单任务抛错被 `try/catch` 收敛为 `stopReason:'error'` 记进 `notes`，不向外炸（lib/articles-agentic.js:300-304）。

### 子模块递归派发（lib/articles-agentic.js:71-128）

模型在父模块文章里可调 `generate_sub_module` 把一部分拆出去。`runOneArticle` 就地构建 `dispatchSub` 闭包：

- 深度封顶：当 `_depth >= subDepth`（默认 2）时 `dispatchSub` 置为 `null`，并把 `subModuleBlocked` 置为 `'max-depth'`（lib/articles-agentic.js:82-84, 137）——工具层据此诚实回"已到嵌套上限，请在本文里当普通小节写"，避免模型在父文写指向不存在文件的死链（lib/articles-agentic.js:79-82 注释）。
- 子模块名全局唯一（上游 issue #76/#113 教训）：同一次父任务共享 `taken` 名集合；重名先加父模块名前缀，仍重则跳过（lib/articles-agentic.js:71-94）。
- 路径：父文在 `modules/<父>.md`，子模块落在同层 `modules/<父>/<子>.md`（lib/articles-agentic.js:33-34），由 `runOneArticle` 递归跑 `subDepth` 层（lib/articles-agentic.js:105-122）。
- 关键陷阱（lib/articles-agentic.js:113-121 注释）：递归时 `onSubModule` 必须传 `null` 而不是 `dispatchSub`——`dispatchSub` 是本层闭包，深度判定绑在本层 `_depth` 上；原样下传会让子层永远用父层深度，`subDepth` 封顶形同虚设、模型可无限往下拆（旧实现因此堆溢出）。传 `null` 后子层自己重建 `dispatchSub`，绑定子层 `_depth = _depth + 1`。

### 写集闸门（lib/articles-agentic.js:48-67, 151-167）

agentic 通道里模型有自由工具循环，但**能写哪些文件必须由调度器说了算**：父任务只准写自己那一篇，子模块只准写调度器分配给它那一条路径。`allowedWritePaths` 编译成 `makeWriteSet`（lib/article-contract.js:323），`undefined` 时保持旧行为不设限（lib/articles-agentic.js:66-67）；传 `null`/`[]` 视为"谁都不许写"（lib/articles-agentic.js:66）。落盘前用 `isWritable(task.articlePath, writeSet, { cwd })` 校验（lib/articles-agentic.js:155-166），越界一律不落盘且把原因（`writeSetViolation`）交调用方记账（lib/articles-agentic.js:159-165）。子模块递归时父任务写集会下传，但子层只拿到自己那一条路径（lib/articles-agentic.js:67），因此子层越界写父文会被 `isWritable` 拒掉并记账。

### 空文章兜底（lib/articles-agentic.js:144-149, 146-149）

模型全程没写过正文但最后一段文本像文章：`runAgenticArticle` 已在无工具调用时收下它（lib/agentic.js:331-337），这里再做兜底校验——空文章算失败（`ok:false`，`stopReason:'empty-article'`），不能把空文件写下去覆盖旧文。

## Data Flow

一次 agentic 批量写作的数据流：

1. `index.js` 的 `tickArticles` 在 `c0.agenticArticles && tasks.length` 分支（index.js:2879）组装任务清单（full 走 `localPlan`/语义规划，stale 走预构建任务），先调 `markBigAgenticTasks` 按 `sourceTokensOf(t, job.cwd)` 打大档标记（index.js:3021-3032），再把任务标 `agentic:true` 后交给 `startAgenticRun`（index.js:3033-3042）。
2. `startAgenticRun`（index.js:2676）调用 `runAgenticArticles`，注入 `llm`、`provider`/`model`/`reasoningEffort`、并发、`cwd`、文章格式、`maxSteps: c.agenticMaxSteps`、`fixAnchors`、`allowedWritePaths`（所有任务 `articlePath` 的集合，index.js:2696）、`notes`、`onRequestStart`/`onTaskDone`（记账 token 与进度）。
3. `runAgenticArticles` 建双池，每个任务 `runOneArticle` → `runAgenticArticle`，模型每轮 `streamFn`（`makeHostStream`，把裸消息经 `toRequestMessages` 转成宿主正式 Message、用 `BlockAssembler` 收成 blocks）拿回 blocks，执行 `read_code`/`edit_article`/`generate_sub_module` 等工具，结果回灌下一轮（lib/agentic.js:331-356）。
4. 单篇完成后，`runOneArticle` 经 `isWritable` 闸门落盘（可选 `fixAnchors` 校正行号锚点，lib/articles-agentic.js:168-176），返回带 `subModules` 的结果。
5. `runAgenticArticles` 把结果写进 `results`（按 `customId`），派生子模块记进 `notes`（lib/articles-agentic.js:281-298），返回 `Map`。
6. 结果进 `batchResults` 由 `settleJob` 收割（index.js:2460），失败过半且未退过一次时由 `shouldFallBackHere`（index.js:2585）/模块级 `shouldFallBackFromAgentic`（index.js:1293，失败数×2 > 总数）触发退回单轮通道重跑失败篇（index.js:2627-2665）。

## Connections

- [[index]] —— 唯一调用方：`tickArticles` 的 agentic 分支（index.js:2879）组装任务、`startAgenticRun`（index.js:2676）驱动执行、`shouldFallBackFromAgentic`（index.js:1293）判定退回单轮；`runRealtimeTasks` 是同形单轮通道。
- [[agentic]] —— 循环本体 `runAgenticArticle`（lib/agentic.js:331）、工具实现（`makeReadCodeTool`/`makeListFilesTool`/`makeArticleEditor`）、工具 schema（`TOOL_SCHEMAS`）、开场提示词 `buildOpeningPrompt` 都在那里。
- [[agentic-host]] —— 宿主 llm 适配 `makeHostStream`/`toRequestMessages`/`makeFsWorkspace`（lib/agentic-host.js）。
- [[article-contract]] —— 写集闸门 `makeWriteSet`/`isWritable`（lib/article-contract.js:336/336）被 `runOneArticle` 用于落盘前校验。
- [[orchestration]] —— 整体 `codewiki_generate` 流水线（articles → crosscut → review → index → commit）的阶段编排在 `index.js` 的 job service 里。

## Known Issues

- **子模块深度封顶依赖"传 null 而不是闭包"**：旧实现把 `dispatchSub` 原样下传，子层 `_depth >= subDepth` 永远用父层深度判定，导致 `subDepth` 形同虚设、可无限递归堆溢出。当前实现靠传 `null` + 子层重建校正（lib/articles-agentic.js:113-121），回归防护见 `test-articles-agentic.mjs:182-215`。
- **大档 effort 回落风险**：`resolveTaskRoute` 在任务自带 provider/model 但缺 reasoningEffort 时返回空 effort（""），刻意不回落默认档的 `off`（lib/articles-agentic.js:207-210 测试）；若调用方忘记传 `reasoningEffort` 而大档模型又不认空 effort，需要模型侧兜底。
- **outputTokens 只有粗估**：`runAgenticArticles` 注释明确 `streamFn` 侧收不到 usage（chunk 里 usage 会出现多次），所以 `outputTokens` 按 `out?.usage?.outputTokens` 粗估（lib/articles-agentic.js:277-278），记账精度低于单轮通道。
- **空文章覆盖旧文**：若 `runOneArticle` 兜底校验未拦住（如 `writeArticle:false` 时不落盘但仍返回 `ok:true` 空文章），旧文不会被覆盖但结果会被记为成功——由 `settleJob`/`tally` 侧负责甄别。
