---
title: articles_agentic
type: module
source_files:
  - lib/articles-agentic.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/article-contract.js
  - test-articles-agentic.mjs
  - index.js
tags: [agentic, batch, articles, sub-module, write-set]
---

## Overview

`lib/articles-agentic.js` 是 dsh-codewiki 里 **agentic 文章执行通道**（第二条写作通道）的核心模块。它与 `index.js` 里的 `runRealtimeTasks`（单轮 prompt → 全文）并列，但工作方式完全不同（见 `lib/articles-agentic.js` 第 1–11 行注释）：

- **单轮通道**：把源码整包内联进 prompt，模型一次吐出全文，插件落盘。
- **agentic 通道（本模块）**：吸收自 FSoft-AI4Code/CodeWiki 的 module agent——模型自己用 `read_code`/`list_files` 读源码、用 `edit_article` 增量写文章，不再需要把源码整包塞进 prompt（因此没有「装填超预算 → 拆观察批 → 合成」这一整套）。

本模块职责：把一份「模块任务清单」（`tasks`）批量跑成一批 wiki 文章，支持：

1. **单篇执行** `runOneArticle`：跑一次 agentic 工具循环（`runAgenticArticle`），把文章落盘到 `task.articlePath`，并就地递归派发子模块（`generate_sub_module` → 单独成文落到 `modules/<父>/<子>.md`）。
2. **批量并发** `runAgenticArticles`：双池限流（默认档池 + 大档池），每个任务跑 `runOneArticle`，返回 `Map(customId → 结果)`，失败只记账不影响其它任务。
3. **选档 / 打标**：`resolveTaskRoute`（单任务选档）、`markBigAgenticTasks`（按模块源文本量给超大模块打大档标记）、`sourceTokensOf`（估模块源 token 量，作为打标判据）。
4. **写集闸门**：`allowedWritePaths` 由调用方传入，约束「模型能写哪些文件」——父任务只准写自己那一篇，子模块只准写调度器分配给它的那一条路径。越界一律不落盘并记账。

失败语义与单轮通道一致：单任务失败只记账、不影响其它任务；返回 `Map(customId → 结果)`，由调用方（`index.js` 的 `tickArticles`）决定是否整体降级到单轮通道。

## Key Components

本模块（`lib/articles-agentic.js`）导出的全部公开符号：

### 常量

- `DEFAULT_MAX_STEPS`（第 21 行，从 `./agentic.js` 再导出）：单篇 agentic 写作步数上限（= 30）。唯一定义点在 `lib/agentic.js` 第 325 行，这里再导出只是为了保持既有导入路径可用（`index.js` / 测试都从本模块拿）。

### 函数

- `runOneArticle(task, opts)`（第 33–179 行）：单篇跑一次 agentic 循环并落盘。返回 `{ ...out, subModules, ok }`，其中 `out` 来自 `runAgenticArticle`（含 `article`、`steps`、`usedTools`、`stopReason`、`messages`；`runAgenticArticle` 本身不返回 `usage`，故上层取 `out.usage` 时实为 `undefined` 并退化为 `0`）。关键行为：
  - 已有旧文（`task.prevArticlePath`）先读进 `initialArticle`，交给 `makeArticleEditor` 作为增量改写起点（第 59–63 行）。
  - 构建 `workspace = makeFsWorkspace(...)`、`writeSet = makeWriteSet(allowedWritePaths)`（未传 `allowedWritePaths` 时 `writeSet = null`，保持旧行为不设限；传 `null/[]` 视为「谁都不许写」）（第 64–67 行）。
  - `streamFn` 可注入（`injectedStreamFn`，离线测试用假模型）；默认走 `makeHostStream` 接宿主 llm（第 69 行）。
  - 子模块名全局唯一：同一次父任务共享一份 `_takenNames` 集合，重名加父模块名前缀，仍重则跳过（第 71–94 行）。父模块目录名取文章文件名 basename（如 `modules/commerce.md` → `commerce`）（第 75–77 行）。
  - 深度封顶：`atMaxDepth = _depth >= subDepth`（默认 `subDepth=2`），到顶时 `dispatchSub` 传 `null`，并把 `subModuleBlocked='max-depth'` 带下去，让工具层说实话而不是笼统回「已派发」（第 79–82 行、第 137 行）。
  - 递归派发子模块：`dispatchSub` 闭包就地调 `runOneArticle` 写子文章，路径为 `<wiki>/modules/<父>/<子>.md`；递归时 `onSubModule` 传 `null`、`_depth` 递增、`subModuleBlocked` 按 `_depth+1 >= subDepth` 判定，让子层自己重建深度判定（第 83–128 行）。
  - 空文章兜底：模型全程没写正文时判 `ok:false, stopReason:'empty-article'`，不覆盖旧文（第 144–149 行）。
  - 写集闸门：要落盘时若 `allowedWritePaths` 已设，调 `isWritable(task.articlePath, writeSet, {cwd})`，越界返回 `ok:false, stopReason:'write-set', writeSetViolation`（第 151–167 行）。
  - 落盘前可选 `fixAnchors`（锚点修正，失败不影响落盘）（第 168–176 行）。

- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（第 185–203 行）：估算模块源文本 token 量（CJK 按 1、其余按 `ceil((len-cjk)/3.5)`，与 `index.js` `estimateTokens` 同口径），作为 `markBigAgenticTasks` 的判据。读不到的文件按 0 计、不阻断。

- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（第 208–222 行）：单任务选档。任务自带 `provider` 且 `model` 都非空时完全以任务为准（含 `reasoningEffort`，空 = 模型默认档，绝不回落默认档 effort）；否则全用参数里的默认档。

- `runAgenticArticles(tasks, opts)`（第 231–312 行）：并发池，与 `runRealtimeTasks` 同形状（返回 `Map(customId → 结果)`）。要点：
  - **双池**：`bigTier !== true` 的走默认档池（`concurrency`），`bigTier === true` 的走大档池（`bigConcurrency`）；两池各自独立限流、同时推进。`bigConcurrency` 为 0/未传时回落到 `concurrency`（第 244–255 行）。
  - 每个 worker 调 `resolveTaskRoute` 选档后跑 `runOneArticle`，成功/失败都 `results.set(customId, {...})`（第 257–304 行）。
  - `onTaskDone({outputTokens, durationMs})` 钩子；派生子模块写入 `notes`（第 279–283 行）。
  - 失败记账：越界写 `writeSetViolation` 记一条 note，否则记「未产出正文」note；异常记 `stopReason:'error'`（第 292–304 行）。

- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（第 320–333 行）：按体量给 agentic 任务打大档标记（纯函数，不改原对象）。`bigTier = { provider, model, reasoningEffort?, budget }`，仅当 `provider` 非空且 `budget>0` 时生效；模块源文本量（`sizeOf` 或 `task.sourceChars`）超过 `budget` 的任务打上 `provider`/`model`/`bigTier:true`（及可选 `reasoningEffort`）。未配置时原样返回。

### 依赖的相邻模块符号（非本模块定义，但本模块直接调用）

- `lib/agentic.js`：`runAgenticArticle`（第 331 行，工具循环本体）、`makeArticleEditor`（第 200 行）、`DEFAULT_MAX_STEPS`（第 325 行）、`TOOL_SCHEMAS`、`buildToolset`、`buildOpeningPrompt` 等。
- `lib/agentic-host.js`：`makeHostStream`（第 83 行，接宿主 llm 的 streamFn 工厂）、`makeFsWorkspace`（第 111 行，仓库 readFile/listDir 抽象）。
- `lib/article-contract.js`：`makeWriteSet`（第 352 行）、`isWritable`（第 365 行，写集闸门）。

## Architecture

组件 / 流程非平凡（批量 + 子模块递归 + 双池 + 写集闸门），框图如下：

```text
index.js: startAgenticRun (2953) ──tasks[]=modules/<slug>.md──▶ markBigAgenticTasks
        │
        ▼
┌─ runAgenticArticles (231): 双池 ─────────────────────────────┐
│ 默认档池(concurrency) / 大档池(bigConcurrency，0则回落)        │
│ 每 worker: resolveTaskRoute 选档 → runOneArticle             │
└───────────────────────────────────────────────────────────────┘
        │ per task
        ▼
┌─ runOneArticle (33) ─────────────────────────────────────────┐
│ workspace+editor(旧文) / writeSet / streamFn / dispatchSub   │
│   └─▶ runAgenticArticle (agentic.js:331, ≤30 步工具循环)     │
│         └─ generate_sub_module ─▶ 递归 runOneArticle         │
│            落盘 modules/<父>/<子>.md（深度封顶 _depth≥subDepth）│
└───────────────────────────────────────────────────────────────┘
        │ 落盘前 isWritable(writeSet)? (article-contract.js:365)
   ┌────┴────┐
 true→writeFileSync(175)   false→ok:false, stopReason:'write-set'
        │
        ▼
results.set(customId, {ok,stopReason,steps,tools,subModules}) → index.js settleJob
```

`makeHostStream`（lib/agentic-host.js:83）负责把裸消息经 `toRequestMessages`（第 34 行）转成宿主正式消息、用 `BlockAssembler` 收成 blocks；`makeFsWorkspace`（第 111 行）把 `readFile`/`listDir` 限制在 `cwd` 内（配合 `safeRelPath` 防 `../` 越界）。

## Data Flow

以一次完整批量编译（`index.js` 的 `tickArticles` → `startAgenticRun`）为例，数据流向如下：

1. **任务构建**（`index.js` 第 3275–3285 行）：full 编译时，`job.plan.modules` 映射成任务对象 `{ name: 'modules/<slug>.md', mission, sources, cwd, articlePath, prevArticlePath }`；`expectedNames` 固化清单作为完整性判定分母。
2. **打大档标记**（`index.js` 第 3298–3309 行）：调 `markBigAgenticTasks(tasks, { bigTier:{provider,model,reasoningEffort,budget}, sizeOf: (t)=>sourceTokensOf(t, job.cwd) })`。超大模块（源文本量 > `budget`）被标 `bigTier:true` + `provider`/`model`。
3. **启动执行器**（`index.js` 第 2953–3002 行 `startAgenticRun`）：调 `runAgenticArticles(tasks, { llm, provider, model, reasoningEffort, concurrency, bigConcurrency, cwd, language, articleFormat, maxSteps, fixAnchors, allowedWritePaths: 每个任务 articlePath, notes, signal, onRequestStart, onTaskDone })`。返回结果进 `batchResults`，由 `settleJob` 统一收割。
4. **双池并发**（`lib/articles-agentic.js` 第 244–311 行）：`bigTier` 任务进大档池、其余进默认档池；每个 worker 对单任务调 `resolveTaskRoute` 选档 → `runOneArticle`。
5. **单篇写作**（`lib/articles-agentic.js` 第 33–179 行）：`runOneArticle` 组装 `workspace`/`editor`/`streamFn`/`writeSet`，调 `runAgenticArticle` 跑工具循环。模型每步可选 `generate_sub_module` → 触发 `dispatchSub` → 递归 `runOneArticle` 写 `modules/<父>/<子>.md`（受 `subDepth` 封顶）。
6. **落盘闸门**（第 151–177 行）：落盘前 `isWritable` 校验；通过则 `mkdirSync(dirname)` + `writeFileSync`。父文章 `task.articlePath` 与子模块路径都必须在 `writeSet` 内，越界返回 `write-set` 失败。空文章（第 144–149 行）直接判失败不落盘。
7. **结果回传**（第 280–304 行）：每篇结果 `results.set(customId, { name, ok, stopReason, steps, tools, subModules })`；派生子模块、越界/失败原因写入 `notes`；异常记 `stopReason:'error'`。
8. **收割与降级**（`index.js` 第 3156–3262 行 `tickArticles`）：`settleJob` 拿到结果后 `tally` 入账；若大面积失败且旧通道可用（`shouldFallBackHere`），失败篇退回单轮 `prepareArticleTasks` 重跑（`job.agenticRetried=true`），已写成功的文章不再重写。

## Connections

- [[agentic]]：`lib/agentic.js` 提供工具循环本体 `runAgenticArticle`、工具定义 `TOOL_SCHEMAS`、工具实现（`makeReadCodeTool`/`makeListFilesTool`/`makeArticleEditor`/`buildToolset`）、`DEFAULT_MAX_STEPS` 与开场提示词 `buildOpeningPrompt`——本模块是它的「批量 + 子模块编排」外壳。
- [[agentic-host]]：`lib/agentic-host.js` 提供 `makeHostStream`（接宿主 llm 的 streamFn）与 `makeFsWorkspace`（仓库文件/目录抽象），本模块 `runOneArticle` 直接调用。
- [[article-contract]]：`lib/article-contract.js` 提供 `makeWriteSet`/`isWritable`（写集闸门）、`inspectArticle`/`hasBlockingIssue`（文章契约校验），本模块落盘前用写集闸门，index.js 写完后再跑契约校验。
- [[index]]：`index.js` 是调用方——`tickArticles`（第 3156 行）/ `startAgenticRun`（第 2953 行）组装任务、打大档标记、启动 `runAgenticArticles`，并据结果决定是否降级到单轮通道（`runRealtimeTasks` / `prepareArticleTasks`，见第 3221–3262 行 `shouldFallBackHere` 分支）。
- [[articles-batch]]（单轮实时通道 `runRealtimeTasks`）：与本模块并列的「第一条执行通道」，是 agentic 大面积失败时的降级目标。
- [[update-planner]] / [[incremental]]：决定 `job.plan.modules` 与 stale 任务的 `task.sources`，是本模块任务的来源。

## Known Issues

- **子模块深度封顶失效（历史回归，已修）**：旧实现里 `dispatchSub` 是**本层闭包**，递归时原样下传，子层的 `_depth >= subDepth` 判定永远用父层深度 → 永不触发 → 模型可无限往下拆（实测 `subDepth=2` 直接堆溢出）。修复点：递归时 `onSubModule` 传 `null`（第 117 行），让子层自己构建 `dispatchSub` 绑定自己的 `_depth`（= `_depth+1`，第 118–120 行）。`test-articles-agentic.mjs` 第 182–215 行两条用例（`subDepth=1` 只一层、`subDepth=2` 允许一层孙模块）专门回归防护。

- **到顶不派发时必须说实话**：`atMaxDepth` 时 `dispatchSub=null`，且把 `subModuleBlocked='max-depth'` 带进 `runAgenticArticle`（第 137 行），工具层（`lib/agentic.js` 第 294–299 行）据此回「已到嵌套上限，请在本文里当普通小节写清楚」，否则模型会写「详见 xxx.md」而死链且父任务仍记 `ok:true`（见 `lib/agentic.js` 第 290–305 行注释）。

- **写集闸门 `allowedWritePaths` 的三种语义**：① 不传 `undefined` → 保持旧行为不设限（`writeSet=null`，第 67 行）；② 传 `null/[]` → 编译成空集合，**谁都不许写**（刻意收紧，第 67 行）；③ 传具体路径数组 → 仅这些路径可写，越界返回 `stopReason:'write-set'`（第 155–167 行）。`index.js` 实际传的是各任务的 `articlePath` 列表（第 2973 行）。

- **子模块写集只含自己路径**：递归时 `allowedWritePaths` 改为 `[articlePath]`（子自己的那条，第 112 行），父子分开；子层越界写父文会被 `isWritable` 拒掉并记账（回归用例见 `test-articles-agentic.mjs` 第 449–470 行）。

- **`outputTokens` 是粗估**：`runAgenticArticles` 第 278 行直接取 `out.usage.outputTokens`，而 usage 在 chunk 流里会出现多次、streamFn 侧收不全，因此只按步数粗估（注释已明说），不是精确值。

- **`sourceTokensOf` 把整份源码读进内存**：第 197–199 行对每个 `sources` 文件 `readFileSync` 全文再估算，超大文件无分块；读不到按 0 计不阻断。

- **测试里残留的无效选项**：`test-articles-agentic.mjs` 第 238 行传了 `onSubModuleHook: null`，但 `runOneArticle` 的选项里没有这个键（有效键是 `onSubModule`），因此被静默忽略——属测试噪音，不影响行为。

- **`generate_sub_module` 的 `onSubModule` 钩子可选且默认递归**：`runOneArticle` 第 135 行 `onSubModule: onSubModule ?? dispatchSub`——若调用方（如测试或会话通道）想完全禁用派发，应显式传 `onSubModule` 占位或 `subDepth=0`（第 126–141 行用例验证 `subDepth=0` 时 `dispatchSub=null`、不产生子文章）。
