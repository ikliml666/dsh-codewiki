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
  - test-agentic-host.mjs
  - test-batch.mjs
tags: [agentic, orchestration, articles, dual-pool, write-set]
---

## Overview

`articles_agentic` 是 dsh-codewiki 的**第二条文章执行通道**（与 `index.js` 的 `runRealtimeTasks` 单轮装填通道并列）。它把「模块任务清单」跑成 wiki 文章：模型不再一次性拿内联源码吐全文，而是拿到一个工作台——自己用 `read_code`/`list_files` 读源码、用 `edit_article` 增量写文章、必要时用 `generate_sub_module` 把大模块递归拆给子任务单独成文。

代码分布在四个文件：

- `lib/articles-agentic.js` —— 通道编排层：`runOneArticle`（单篇跑循环+落盘+派发子模块）与 `runAgenticArticles`（并发池、双池限流、大档标记）。
- `lib/agentic.js` —— 纯逻辑工具循环：工具 schema、四种工具实现、步循环 `runAgenticArticle`、开场提示词。
- `lib/agentic-host.js` —— 适配层：裸消息 ↔ 宿主 `Message` 转换（`toRequestMessages`）、`makeHostStream` 把宿主 `llm.stream` 收成 blocks、仓库 workspace 抽象。
- `lib/article-contract.js` 的 `makeWriteSet`/`isWritable` —— 写集闸门（FSoft 的 write-set），限定每个 agentic 任务只允许写调度器分配给它的那一条路径。

失败语义与单轮通道一致：单任务失败只记账（`notes`）、不影响其它任务，返回 `Map(customId → 结果)`。任何环节（缺 llm / 无 workspace / 循环抛错）都抛或返回 `ok:false`，由 `index.js` 的 `tickArticles` 决定整体是否降级到单轮通道。

## Key Components

### lib/articles-agentic.js

- `DEFAULT_MAX_STEPS`（第 21 行，`export { DEFAULT_MAX_STEPS }`）：从 `lib/agentic.js` 再导出的步数上限（=30），保持既有导入路径可用，避免两处各定义一份常量。

- `runOneArticle(task, opts)`（第 33–179 行）：单篇跑一次 agentic 循环并落盘。
  - 入参 `task`：`{ mission, name, articlePath, sources, prevArticlePath, customId }`。`opts` 含 `llm`、`provider`、`model`、`reasoningEffort`、`language`、`cwd`、`maxSteps`（默认 `DEFAULT_MAX_STEPS`）、`subDepth`（默认 `2`，第 53 行）、`_depth`（默认 `0`，第 54 行，递归时 +1）、`allowedWritePaths`（默认 `null`，第 51 行）、`injectedStreamFn`（离线测试注入假模型）、`fixAnchors`、`writeArticle`、`onSubModule`、`subModuleBlocked`、`_takenNames`。
  - 返回 `{ ok, stopReason, article, steps, usedTools, outputTokens, subModules }`（第 24 行注释）。
  - 子模块派发闭包 `dispatchSub`（第 82–128 行）：模型调 `generate_sub_module` 时就地递归 `runOneArticle` 写子模块，路径为 `modules/<父 slug>/<子 slug>.md`（第 96 行）。深度封顶：`atMaxDepth = _depth >= subDepth`（第 82 行），到顶则 `dispatchSub = null` 且把 `subModuleBlocked='max-depth'` 下传工具层（第 82–84、137 行）。重名加父模块名前缀（第 89–93 行），共享 `_takenNames` 集合防互相覆盖（第 73、122 行）。
  - 空文章兜底：`!article.trim()` 时返回 `ok:false, stopReason:'empty-article'`（第 146–149 行）。
  - 写集闸门：当 `allowedWritePaths` 有值时用 `isWritable(task.articlePath, writeSet, ...)` 校验（第 155–167 行），越界返回 `ok:false, stopReason:'write-set', writeSetViolation`（第 159–166 行）。通过后 `fixAnchors` 校正锚点再 `fsImpl.writeFileSync` 落盘（第 168–177 行）。

- `sourceTokensOf(task, cwd, opts)`（第 185–203 行）：估算模块源文本量（近似 token 数），作为大档判据。`est` 同 `index.js` 的 `estimateTokens` 口径（CJK 按 1、其余按 3.5 字符/token，第 190–193 行）。读不到的文件按 0 计（第 198–200 行）。

- `resolveTaskRoute(task, opts)`（第 208–222 行）：单任务选档。任务自带 `provider`+`model`（大档任务）时完全以任务为准，`reasoningEffort` 也以任务为准（空=模型默认档），不回落默认档的 effort（第 209–216 行）；否则用 `opts` 里的默认档（第 217–221 行）。

- `runAgenticArticles(tasks, opts)`（第 231–312 行）：并发池，与 `runRealtimeTasks` 同形状（返回 `Map(customId → 结果)`），但每个任务跑 agentic 循环。
  - 双池：`normalTasks = list.filter(t => t.bigTier !== true)`、`bigTasks = list.filter(t => t.bigTier === true)`（第 245–246 行）；各自独立限流、同时推进（第 247–255 行）。`bigConcurrency` 为 0/未传回落到 `concurrency`（第 251–253 行）。
  - 每个任务：`resolveTaskRoute` 选档 → `runOneArticle`（第 268–276 行）。`onTaskDone` 上报 `outputTokens`/`durationMs`（第 279 行）。
  - 子模块记账：派生出子模块时 `notes.push('...派生出 N 个子模块文章...')`（第 282 行）。失败记账：`writeSetViolation` → 越界提醒，否则 → 未产出正文提醒（第 293–297 行）。异常走 `catch` 记 `notes` 并 `results.set(customId, { ok:false, stopReason:'error' })`（第 300–304 行）。

- `markBigAgenticTasks(tasks, opts)`（第 320–333 行）：按体量打大档标记（纯函数，与 `index.js` `prepareArticleTasks` 的 markBig 同语义）。`bigTier = { provider, model, reasoningEffort?, budget }`；未配置 provider 或 budget 为 0 时原样返回（第 322–325 行）。`sizeOf` 缺省回落 `t.sourceChars`（第 327 行）。超 budget 的任务写入 `provider`/`model`/`bigTier:true` 及可选 `reasoningEffort`（第 329–331 行）。

### lib/agentic.js

- `TOOL_SCHEMAS`（第 27–87 行）：四个工具的 JSON Schema。
  - `read_code`（第 28–42 行）：`{ path, start_line?, end_line? }`。
  - `list_files`（第 43–53 行）：`{ path?, depth? }`。
  - `edit_article`（第 54–71 行）：`{ command, old_str?, new_str?, line?, text? }`，`command ∈ [view, str_replace, insert]`。
  - `generate_sub_module`（第 72–87 行）：`{ module_name, components[], description }`，`required: ['module_name', 'description']`。

- `numberLines(text)`（第 101–106 行）：行号前缀格式化，模型据此引用行号。

- `makeReadCodeTool(workspace, opts)`（第 115–177 行）：`read_code` 实现。常量 `MAX_READ_LINES = 2000`（第 93 行）、`MAX_READ_CHARS = 40000`（第 96 行，挡压缩产物/单行超长文件）、`IGNORED_DIRS`（第 98 行，模型看不到 `node_modules` 等）。重复读抑制：同一 `(path, 起, 止)` 再读只回「你已在第 N 步读过」（第 115–135 行）。越界路径拒绝（第 120–121 行）。`safeRelPath` 先兜一层（第 120 行）。

- `makeListFilesTool(workspace)`（第 179–197 行）：`list_files` 实现，过滤 `IGNORED_DIRS`，返回 `path` 与 `dir` 标记（第 192–195 行）。

- `makeArticleEditor(initial)`（第 200–263 行）：文章编辑工具，状态在闭包里。返回 `{ edit, get article, set article }`（第 258–262 行）。`edit` 处理 `view`/`str_replace`/`insert`：`str_replace` 行尾归一化（CRLF→LF 匹配，命中后还原，第 216–229 行）、`insert` 拒绝负行号（第 235–237 行）。

- `safeRelPath(rel)`（第 266–273 行）：路径越界防护，拒绝 `/` 开头、`C:`、`../` 跳目录。

- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（第 279–315 行）：装配 `{ read_code, list_files, edit_article, generate_sub_module }`。`generate_sub_module`（第 285–313 行）：`onSubModule` 为 null 时按 `subModuleBlocked`（'max-depth' vs 'unsupported'）说实话拒绝（第 290–306 行），绝不编造「已派发」（避免死链）。

- `DEFAULT_MAX_STEPS = 30`（第 325 行）：单篇步数上限唯一来源。

- `runAgenticArticle(opts)`（第 331–432 行）：循环本体。入参 `mission`、`streamFn`、`workspace`、`tools?`、`editor?`、`onSubModule`、`subModuleBlocked`、`maxSteps`、`signal`、`systemPrompt`、`articleFormat`。
  - 声明可用工具给模型（第 354 行），开场提示词 `buildOpeningPrompt`（第 359 行）。
  - 步循环（第 367–423 行）：每步调 `streamFn` 拿 `blocks`；无工具调用即视为写完，若 editor 空而给了正文则收下（第 389–395 行）；有工具调用则执行并回灌 `tool-result`（第 398–422 行）。
  - 终止原因 `stopReason` 取值：`'max-steps'`（默认，第 365 行）、`'aborted'`（第 369 行）、`'stream-error'`（第 377 行）、`'empty-response'`（第 380 行）、`'finished'`（第 393 行）。
  - 返回 `{ article, steps, usedTools, stopReason, messages }`（第 425–431 行）。

- `stripJsonFence(s)`（第 439–444 行）：剥 ```` ```json ```` 围栏。
- `sliceBalancedObject(s)`（第 447–473 行）：截首个括号平衡的 JSON 对象（跳过字符串字面量）。
- `parseToolArgs(raw, steps, step, toolName)`（第 476–500 行）：坏 JSON 不中断，按「原样→剥围栏→截平衡对象」三级递进解析，失败记 warning 回灌（第 481–499 行）。
- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（第 506–541 行）：拼开场提示词（工作方式六步、硬要求、可选拆分提示），`articleFormat` 追加格式条款（第 539 行）。

### lib/agentic-host.js

- `SOURCE = { kind: 'plugin:codewiki' }`（第 15 行）。
- `toRequestMessages(messages, opts)`（第 34–79 行）：裸消息 → 宿主正式 `Message`。user 用 `createUserMessage`、assistant 用 `createAssistantMessage`（带 provider/model）、tool 一条消息多结果展开成多条 `createToolResultMessage`（第 58–75 行）。`IDENTITY = new WeakMap()`（第 26 行）缓存稳定 MessageId，跨边界身份不变。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（第 83–108 行）：建 `streamFn` 交给 `runAgenticArticle`。`BlockAssembler` 收 chunk 成 blocks（第 86–99 行）；`finish.kind === 'error' || 'aborted'` 抛错（第 101–103 行）；`temperature: 0`（第 94 行）。
- `makeFsWorkspace(fs, path, cwd)`（第 111–135 行）：仓库 workspace 抽象，仅暴露 `{ readFile, listDir }`，越界路径拒绝（第 114–123 行）。

### lib/article-contract.js（写集闸门）

- `makeWriteSet(paths)`（第 352–355 行）：构建允许写入的路径集合（Set），非数组返回 null（不检查）。
- `normalizeWritePath(p)`（第 357–361 行）：POSIX 规范化（反斜杠→正斜杠）。
- `isWritable(target, writeSet, { cwd })`（第 365–378 行）：判定目标是否在写集内，相对路径以 cwd 基准解析后比对，防 `../` 越界（第 370–376 行）。

## Architecture

```text
tickArticles (index.js:3268)
   │  agenticArticles 开关开？
   ▼
markBigAgenticTasks (lib/articles-agentic.js:320)  sizeOf=sourceTokensOf
   │  超 budget 的任务打 bigTier 标记
   ▼
startAgenticRun (index.js:2927) ── agentic:true 任务持久化
   │  ┌──────────── 双池并行 ────────────┐
   ▼ 默认档池                    ▼ 大档池(bigConcurrency)
runAgenticArticles (lib/articles-agentic.js:231)
   │  每任务 resolveTaskRoute 选档
   ▼
runOneArticle (lib/articles-agentic.js:33)
   │  makeWriteSet + isWritable 闸门 (article-contract.js:352/365)
   ▼
runAgenticArticle (lib/agentic.js:331)  ── 步循环 ──┐
   │  makeHostStream (lib/agentic-host.js:83)       │
   │      │ 宿主 llm.stream (provider/model/effort) │
   │      ▼                                          │
   │  buildToolset (lib/agentic.js:279)              │
   │   ├ read_code   (makeReadCodeTool:115)          │
   │   ├ list_files  (makeListFilesTool:179)         │
   │   ├ edit_article(makeArticleEditor:200) ────────┤ 落盘/递归
   │   └ generate_sub_module → onSubModule ──────────┘ (dispatchSub:82 递归 runOneArticle)
```

## Data Flow

1. **装配阶段**（`tickArticles`，`index.js` 第 3268–3297 行）：当 `liveConfig(config).agenticArticles` 为真且 `tasks` 非空，先用 `markBigAgenticTasks` 按 `sourceTokensOf(t, job.cwd)` 估算体量给超大模块打大档标记（第 3272–3283 行），把每个任务标 `agentic:true` 持久化进 `job.tasks`（第 3284–3289 行），调 `startAgenticRun` 启动执行器（第 3293 行）。该通道没有 `batchPrompt` 快照——宿主重启后 `settleJob` 按 `job.tasks` 里 `agentic===true` 的任务整批重跑（第 2550–2556 行）。

2. **执行阶段**（`startAgenticRun`，`index.js` 第 2927–2977 行）：调 `runAgenticArticles`，传入 `llmRef`、`provider`/`model`/`reasoningEffort`、`concurrency`/`bigConcurrency`、`cwd`、`articleFormat`、`maxSteps`、`fixAnchors` 和 `allowedWritePaths`（父任务的全部 articlePath 清单，第 2947 行）。结果进 `batchResults`，由 `settleJob` 收割（第 2959–2960 行）。

3. **单篇循环**（`runOneArticle` → `runAgenticArticle`）：每步通过 `makeHostStream` 把裸消息转成宿主 `Message`（`toRequestMessages`）并调 `llm.stream`，`BlockAssembler` 收成 blocks 回灌；模型用工具读码/写文章；`makeArticleEditor` 维护文章状态。无工具调用即收尾（第 389–395 行）。

4. **子模块递归**：模型调 `generate_sub_module` → `dispatchSub`（第 82–128 行）递归 `runOneArticle`，子文章落在 `modules/<父 slug>/<子 slug>.md`，子任务的写集只有自己那条路径（第 112 行），`_depth` 逐层 +1 直到 `subDepth` 封顶（第 118 行）。

5. **落盘与闸门**：`runOneArticle` 末段用 `isWritable` 校验目标路径（第 155–167 行），通过后 `fixAnchors` 校正行号锚点再 `writeFileSync`（第 168–177 行）。空文章判 `ok:false`（第 146–149 行）。

6. **收割与降级**（`tickArticles`，`index.js` 第 3130–3325 行）：`shouldFallBackHere`（第 3262–2671 行）判定本批失败过半（`shouldFallBackFromAgentic`，第 1364–1369 行）且 `!job.agenticRetried` 时，已成功的文章 `tally` 入账，失败的篇目退回单轮 `prepareArticleTasks` 通道重跑一次（第 3195–3233 行），并置 `job.agenticRetried=true` 防死循环。

## Connections

- [[article_contract]] —— 写集闸门 `makeWriteSet`/`isWritable` 的来源（`lib/article-contract.js`）。
- [[agentic]] —— 工具循环与工具实现（`lib/agentic.js`），本模块的核心纯逻辑。
- [[agentic_host]] —— 宿主 llm 适配层（`lib/agentic-host.js`）。
- [[articles]] / [[batch]] —— 单轮装填通道 `runRealtimeTasks` 与 `prepareArticleTasks`，agentic 通道失败时的降级目标（`index.js`）。
- [[codewiki_pipeline]] —— 服务阶段机 `tickArticles`/`startAgenticRun`/`settleJob` 所在编排（`index.js`）。

## Known Issues

- `subDepth` 封顶曾失效（issue「subDepth 失效」）：旧实现里 `dispatchSub` 是本层闭包、递归时原样下传，子层 `_depth >= subDepth` 永远用父层深度 → 永不触发 → 模型可无限往下拆（实测 `subDepth=2` 直接栈溢出）。修复点是递归时 `onSubModule` 传 `null`（让子层按自己的 `_depth` 重建判定，第 117 行），并使深度逐层递增（第 118 行）。回归防护见 `test-articles-agentic.mjs` 第 143–215 行。
- agentic 通道的 `outputTokens` 在 `runAgenticArticles` 里按步数粗估（第 278 行注释：streamFn 侧 usage 可能多次出现），不精确，仅供 tps 采样与用量累计参考。
- 写集闸门只在调用方传 `allowedWritePaths` 时生效；传 `undefined` 时保持旧行为不设限（第 67 行），`null`/`[]` 视为「谁都不许写」（有意收紧）。
- 大档标记依赖 `sourceTokensOf`（读源码估算），拿不到体量的任务不打大档、走默认档（第 197–201 行注释）。
