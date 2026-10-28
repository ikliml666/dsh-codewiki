---
title: articles_agentic
type: module
source_files:
  - lib/articles-agentic.js
  - test-articles-agentic.mjs
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/article-contract.js
tags: [agentic, 文章编排, 并发池, 子模块派发, 写集闸门]
---

## Overview

`lib/articles-agentic.js` 是 CodeWiki 编译流水线的「第二条执行通道」——batch orchestration of agentic article tasks（agentic 文章任务的批量编排）。它与 `index.js` 里的 `runRealtimeTasks`（单轮 prompt → 全文，见 [[index]]）并列，但差别巨大：

- **单轮通道**（`runRealtimeTasks`）：把源码内联进 prompt，模型一次吐出全文，插件落盘。超预算要拆「观察批 → 合成批」。
- **agentic 通道（本模块）**：吸收自 FSoft-AI4Code/CodeWiki 的 module agent。模型自己用 `read_code`/`list_files` 现场读源码、用 `edit_article` 增量写文章，**不再把源码整包塞进 prompt**。因此没有「装填超预算 → 拆观察批 → 合成」这一整套（见 `lib/articles-agentic.js:1-11` 的模块头注释）。

该模块提供三个层级的对外能力：

1. `runOneArticle`（[[lib/articles-agentic.js:33]]）：单篇 agentic 循环 + 落盘，并就地支持「递归派发子模块」。
2. `runAgenticArticles`（[[lib/articles-agentic.js:231]]）：并发池批量跑多篇，支持「默认档 / 大档」双池限流、任务级失败记账、子模块结果汇总。
3. 纯逻辑辅助：`sourceTokensOf`（[[lib/articles-agentic.js:185]]）估模块源文本量、`resolveTaskRoute`（[[lib/articles-agentic.js:208]]）解析任务路由、`markBigAgenticTasks`（[[lib/articles-agentic.js:320]]）按体量打大档标记。

**失败语义与单轮通道一致**：单任务失败只记账、不影响其它任务；返回 `Map(customId → 结果)`。任何环节（缺 llm / 无 workspace / agentic 循环抛错）都抛或返回 `ok:false`，由 `index.js` 的 `tickArticles` 决定是否整体降级到单轮通道（见 [[index]] 的 `shouldFallBackHere` / `shouldFallBackFromAgentic`）。

本模块本身不绑定任何具体 llm 服务，也不直接读磁盘——它把所有 IO 通过注入的 `fsImpl`/`pathImpl`/`workspace`/`streamFn` 完成，所以测试（`test-articles-agentic.mjs`）可以完全离线、用假 `streamFn` 模拟模型（见 [[test-articles-agentic.mjs:36]] 的 `scripted`）。

## Key Components

### 导出常量

- `DEFAULT_MAX_STEPS`（`lib/articles-agentic.js:21`，从 `./agentic.js` 再导出）：agentic 单篇写作的最大步数（工具调用轮次）。**唯一定义点**在 `lib/agentic.js:325`（值为 `30`）；本模块只是再导出，保持既有导入路径可用，避免再出现一份独立常量（index.js 的 `agenticMaxSteps` 默认值也必须与之对齐，见 `index.js:91`）。

### `runOneArticle(task, opts)` — 单篇 agentic 循环 + 落盘

定义于 [[lib/articles-agentic.js:33-179]]。返回 `{ ok, stopReason, article, steps, usedTools, outputTokens, subModules }`。

关键形参与行为（行号区间覆盖全部签名与逻辑）：

- `task`：`{ name, mission?, sources?, articlePath, prevArticlePath?, provider?, model?, reasoningEffort?, bigTier? }`。`mission` 缺省时按 `task.name` 兜底（[[lib/articles-agentic.js:57]]）。
- `llm / provider / model / reasoningEffort / language`（[[lib/articles-agentic.js:34-35]]）：传给宿主 llm 通道；`language` 默认 `'中文'`。
- `fsImpl`（默认 `fs`）、`pathImpl`（默认 `path`）：文件系统抽象，便于测试注入假实现（[[lib/articles-agentic.js:36-38]]）。
- `articleFormat` / `systemPrompt`：拼进开场提示词（[[lib/articles-agentic.js:39-40]]，实际消费在 `lib/agentic.js` 的 `buildOpeningPrompt`）。
- `maxSteps`（默认 `DEFAULT_MAX_STEPS`）、`signal`（取消）、`onDelta`（流式回调）（[[lib/articles-agentic.js:41-43]]）。
- `onSubModule` / `subModuleBlocked`：外部注入的子模块派发钩子与「不可用原因」；若不传则走本层自建的 `dispatchSub`（[[lib/articles-agentic.js:44-45]]，[[lib/articles-agentic.js:79-128]]）。
- `writeArticle`（默认 `true`）：是否把正文落盘（[[lib/articles-agentic.js:46]]）。
- `fixAnchors`（可选函数）：落盘前跑行号锚点校正（消费 `index.js` 的 `fixAnchors`，见 [[lib/articles-agentic.js:169-174]] 与 [[index]]）。
- `allowedWritePaths`（默认 `undefined`）：写集闸门，见下文「写集闸门」小节（[[lib/articles-agentic.js:51]]，[[lib/articles-agentic.js:67]]，[[lib/articles-agentic.js:155-167]]）。
- `subDepth`（默认 `2`）、`_depth`（默认 `0`，递归用）、`_takenNames`（默认 `null`，递归用）：子模块递归深度封顶与跨层重名去重（[[lib/articles-agentic.js:53-55]]，[[lib/articles-agentic.js:73-128]]）。
- `streamFn: injectedStreamFn`（默认 `null`）：注入假模型，离线测试用；默认走宿主 `makeHostStream`（[[lib/articles-agentic.js:69]]，[[lib/articles-agentic.js:69]]）。

核心步骤：

1. 读旧文作 `editor` 初始内容（增量改而非从零重写，[[lib/articles-agentic.js:59-63]]）。
2. 建 `workspace`（`makeFsWorkspace`）、编译写集（`makeWriteSet`，[[lib/articles-agentic.js:64-67]]）、建 `streamFn`（[[lib/articles-agentic.js:69]]）。
3. 子模块名全局唯一：同一次父任务内共享 `_takenNames`，重名加父模块名前缀、仍重则跳过（[[lib/articles-agentic.js:73-94]]）；父目录名取文章文件名 slug（[[lib/articles-agentic.js:77]]）。
4. 深度封顶：`_depth >= subDepth` 时 `dispatchSub = null`，且 `subModuleBlocked='max-depth'`（[[lib/articles-agentic.js:82-84]]，[[lib/articles-agentic.js:137]]）。
5. 调 `runAgenticArticle`（[[lib/agentic.js:331]]）跑循环（[[lib/articles-agentic.js:130-142]]）。
6. 空文章兜底：没写过正文但 `stopReason==='finished'` 算 `'empty-article'` 失败（[[lib/articles-agentic.js:146-149]]）。
7. 写集闸门：越界 `return { ok: false, stopReason: 'write-set', writeSetViolation }`（[[lib/articles-agentic.js:155-167]]）。
8. `fixAnchors` 校正后 `mkdirSync` + `writeFileSync` 落盘（[[lib/articles-agentic.js:175-176]]）。成功返回 `{ ...out, subModules, ok: true }`（[[lib/articles-agentic.js:175]]）。

### `sourceTokensOf(task, cwd, opts)` — 估模块源文本量

定义于 [[lib/articles-agentic.js:185-203]]。CJK 字符按 1、其余按 3.5 字符/token 估算（与 `index.js` 的 `estimateTokens` 同口径，见 [[index.js:536-544]]），用于 `markBigAgenticTasks` 的体量判据。读不到的文件按 0 计（不阻断）。`opts.fsImpl`/`opts.pathImpl` 默认 `fs`/`path`。

### `resolveTaskRoute(task, opts)` — 任务路由解析

定义于 [[lib/articles-agentic.js:208-222]]。任务自带 `provider`+`model`（非空）时**完全以任务为准**，`reasoningEffort` 也以任务为准（空 = 模型默认档，不回落默认档的 effort）；否则用参数里的默认档。返回 `{ provider, model, reasoningEffort }`。

### `runAgenticArticles(tasks, opts)` — 并发池批量编排

定义于 [[lib/articles-agentic.js:231-312]]。返回 `Map<customId, result>`。

- `concurrency`（默认 `2`）：默认档池并发上限（[[lib/articles-agentic.js:232]]）。
- `bigConcurrency`（默认 `0`）：大档池并发上限；`0`/未传时回落到 `concurrency`（[[lib/articles-agentic.js:233]]，[[lib/articles-agentic.js:250-255]]）。
- `notes`（数组，就地 push）：记录派生子模块、越界、失败等信息（[[lib/articles-agentic.js:234]]，[[lib/articles-agentic.js:281-298]]）。
- `signal` / `onTaskDone` / `onRequestStart`：取消、完成回调、请求起手钩子（[[lib/articles-agentic.js:235-237]]）；`onRequestStart(task)` 可返回 `{ onDelta, onDone, onError }` 记录器（[[lib/articles-agentic.js:265]]，[[lib/articles-agentic.js:299]]，[[lib/articles-agentic.js:303]]）。
- 双池：按 `t.bigTier === true` 把任务切成 `normalTasks` / `bigTasks`，各自独立限流、同时推进（[[lib/articles-agentic.js:245-255]]）。
- 每篇调 `runOneArticle`，`...rest` 透传其余默认档参数（[[lib/articles-agentic.js:269-276]]）。
- 结果记账：`results.set(t.customId, { name, ok, stopReason, steps, tools, subModules })`（[[lib/articles-agentic.js:284-291]]）；单篇抛错只记 `stopReason:'error'`、notes 记失败、回调 `rec?.onError`（[[lib/articles-agentic.js:278-282]]）。`outputTokens` 按 `out?.usage?.outputTokens` 粗估（[[lib/articles-agentic.js:278]]）。

### `markBigAgenticTasks(tasks, opts)` — 按体量打大档标记

定义于 [[lib/articles-agentic.js:320-333]]。纯函数（不改入参）。

- `opts.bigTier = { provider, model, reasoningEffort?, budget }`；无 `provider`、或 `budget` 为 0 时原样返回（[[lib/articles-agentic.js:322-325]]）。
- `opts.sizeOf`（可选）：自定义体量函数；缺省用 `t.sourceChars`（[[lib/articles-agentic.js:327]]）。
- 源文本量 `size > budget` 时给任务打上 `{ ...t, provider, model, bigTier: true }`，并带 `reasoningEffort`（[[lib/articles-agentic.js:326-331]]）。
- 与单轮通道 `prepareArticleTasks` 的 `markBig` 同语义：agentic 通道不装填源码（模型自己读），所以判据换成「模块源文本量是否超 budget」（见 [[lib/articles-agentic.js:314-319]]）。

### 写集闸门（依赖 `lib/article-contract.js`）

- `makeWriteSet(paths)`（[[lib/article-contract.js:352-355]]）：把路径清单编译成 `Set`（规范化 POSIX 路径）；非数组返回 `null`（表示不检查）。
- `isWritable(target, writeSet, { cwd })`（[[lib/article-contract.js:365-378]]）：写集内返回 `true`；`cwd` 下按绝对路径比对，防 `../` 越界。
- 在 `runOneArticle` 中：未传 `allowedWritePaths`（=undefined）保持旧行为不设限；传 `null/[]` 视为「谁都不许写」（有意的收紧，[[lib/articles-agentic.js:66-67]]，[[lib/articles-agentic.js:33-45]]）。子模块递归时只拿到自己那条路径作为写集（[[lib/articles-agentic.js:112]]）。

## Architecture

本模块是「编排层」：它把单篇 agentic 循环（`lib/agentic.js` 的 `runAgenticArticle`）、宿主适配（`lib/agentic-host.js` 的 `makeHostStream`/`makeFsWorkspace`）、文章契约写集（`lib/article-contract.js` 的 `makeWriteSet`/`isWritable`）与子模块递归串起来。组件关系如下（框内标注文件:符号）：

```text
            task = {name, mission, sources, articlePath, prevArticlePath?,
                    provider?, model?, bigTier?}
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ runAgenticArticles (articles-agentic.js:231) │  批量并发池
        │  双池: normalTasks / bigTasks (by bigTier)   │
        └───────────────┬─────────────────────────────┘
                        │ 每篇 tasks[i]
                        ▼
        ┌─────────────────────────────────────────────┐
        │ runOneArticle (articles-agentic.js:33)       │  单篇编排
        │  - makeArticleEditor (旧文作初值)             │
        │  - makeFsWorkspace / makeWriteSet            │
        │  - dispatchSub (子模块递归闭包)              │
        └───┬───────────────┬───────────────┬─────────┘
            │               │               │
            ▼               ▼               ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
   │ runAgentic-  │ │ generate_    │ │ makeHostStream        │
   │ Article      │ │ sub_module   │ │ (agentic-host.js:83) │
   │ (agentic.js: │ │ 调用 onSub-  │ │  → llm.stream        │
   │  331)        │ │  Module 闭包 │ │                       │
   └──────┬───────┘ └──────┬───────┘ └──────────┬───────────┘
          │                │                    │
          │   read_code / list_files /          │ 裸消息→宿主
          │   edit_article / generate_sub_module│ Message + BlockAssembler
          ▼                ▼                    ▼
   ┌─────────────────────────────────────────────────────┐
   │ workspace={readFile,listDir} (agentic-host.js:111)   │
   │ + toolset (agentic.js:279) + article-contract 写集   │
   └───────────────────────┬─────────────────────────────┘
                            │ isWritable 校验 (article-contract.js:365)
                            ▼
                 落盘 articlePath (articles-agentic.js:175-176)
                 子模块落盘 modules/<父>/<子>.md (articles-agentic.js:96)
```

要点：

- **双池**（`runAgenticArticles` 内的 `pools`，[[lib/articles-agentic.js:244-255]]）：`bigTier===true` 的任务进大档池（`bigConcurrency`），其余进默认档池（`concurrency`），两池各自 `Promise.all` 同时推进（[[lib/articles-agentic.js:257-310]]）。大档常是付费长上下文，与免费默认档配额互不相干。
- **子模块递归**是「本层闭包 + 深度封顶」结构：`runOneArticle` 自建 `dispatchSub`（[[lib/articles-agentic.js:79-128]]），递归调用时把 `onSubModule` 传 `null`、`_depth+1`、重算 `subModuleBlocked`（[[lib/articles-agentic.js:117-120]]），让子层按自己的深度重建判定，深度才能逐层递增（issue「subDepth 失效」的回归防护，见测试 [[test-articles-agentic.mjs:143-215]]）。
- **写集闸门**只在 `allowedWritePaths` 明确传入时启用；不设限（`undefined`）保持旧行为（[[lib/articles-agentic.js:66-67]]，[[lib/articles-agentic.js:155-167]]）。

## Data Flow

以 `index.js` 的 `tickArticles` 触发一次 agentic 全量编译为例（[[index.js:3151-3211]]）：

1. **任务装配**：`plan.modules` 映射成 `{ name, mission, sources, cwd, articlePath, prevArticlePath }`（[[index.js:3270-3280]]）。`prevArticlePath` 指向已存在的同 slug 文章，作增量上下文（[[index.js:3278]]）。
2. **打大档标记**：`markBigAgenticTasks(tasks, { bigTier, sizeOf: t => sourceTokensOf(t, job.cwd) })`（[[index.js:3293-3304]]）——按模块源文本量是否超 `bigTokenBudget` 决定 `bigTier`。
3. **落表 + 启动**：把任务标记 `agentic:true`（宿主重启重跑时按 agentic 通道而非找 `batchPrompt`，[[index.js:3309]]），调 `startAgenticRun`（[[index.js:2948]]）。
4. **进入本模块**：`startAgenticRun` 调 `runAgenticArticles`，透传 `llm/provider/model/reasoningEffort/concurrency/bigConcurrency/cwd/language/articleFormat(maxSteps=agenticMaxSteps)/fixAnchors/allowedWritePaths(各任务 articlePath)/notes/signal/onRequestStart/onTaskDone`（[[index.js:2954-2979]]）。
5. **双池执行**：`runAgenticArticles` 把任务分池，每篇 `runOneArticle`；单篇内部 `makeArticleEditor`(旧文作初值) → `makeFsWorkspace` → `makeWriteSet` → `runAgenticArticle`（[[lib/articles-agentic.js:64-142]]）。
6. **模型循环**：`runAgenticArticle`（`lib/agentic.js:331`）用注入的 `streamFn`（生产环境 = `makeHostStream` → `llm.stream`，[[lib/agentic-host.js:83-108]]）驱动 `read_code / list_files / edit_article / generate_sub_module` 工具循环，循环写进 `editor.article`（[[lib/agentic.js:382-423]]）。
7. **子模块派发**：模型调 `generate_sub_module` → `runOneArticle` 的 `dispatchSub` 闭包 → 递归 `runOneArticle`（子任务 `articlePath = modules/<父slug>/<子slug>.md`，写集只有自己那条路径，[[lib/articles-agentic.js:96-122]]）→ 结果 push 进父的 `subModules`。
8. **落盘闸门**：父/子 `runOneArticle` 各自用 `isWritable(articlePath, writeSet)` 校验，越界返回 `ok:false, stopReason:'write-set'`（[[lib/articles-agentic.js:155-167]]）；通过则 `fixAnchors` 校正后 `writeFileSync`（[[lib/articles-agentic.js:168-176]]）。
9. **汇总收割**：`runAgenticArticles` 把每篇 `{ name, ok, stopReason, steps, tools, subModules }` 写入 `results` Map，并在 `notes` 记录派生子模块 / 越界 / 失败（[[lib/articles-agentic.js:281-298]]）；结果进 `batchResults` 由 `settleJob` 收割（[[index.js:2555-2585]]）。
10. **失败降级**：`tickArticles` 调 `shouldFallBackHere` → `shouldFallBackFromAgentic`（失败过半且本 job 未退过，[[index.js:2680-2687]]，[[index.js:2680-2685]]），把失败篇退回单轮通道 `prepareArticleTasks` 重跑一次（只重排失败篇，[[index.js:3216-3254]]）。
11. **重启接管**：没有 `batchPrompt` 的 agentic 任务在执行器丢失时按任务本身（`mission+articlePath+sources`）整批重跑（[[index.js:2564-2572]]）。

## Connections

- **[[index]]**（`index.js`）：唯一的真实调用方与编排宿主。`tickArticles` 装配任务并调 `markBigAgenticTasks` + `startAgenticRun`（[[index.js:3293-3317]]）；`startAgenticRun` 直接 `runAgenticArticles`（[[index.js:2948-2998]]）；`shouldFallBackFromAgentic` / `shouldFallBackHere` 与本模块失败语义联动（[[index.js:1380-1385]]，[[index.js:2680-2687]]）；`settleJob` 的「执行器丢失重跑」分支认 `agentic:true` 标记（[[index.js:2555-2563]]）；`agenticArticles` / `agenticMaxSteps` / `big*` 配置项透成本模块（[[index.js:90-91]]，[[index.js:3151-3316]]）。
- **[[agentic]]**（`lib/agentic.js`）：提供 `runAgenticArticle`（单篇工具循环，[[lib/agentic.js:331]]）、`makeArticleEditor`（[[lib/agentic.js:200]]）、`buildToolset`（[[lib/agentic.js:279]]）、`TOOL_SCHEMAS` / `buildOpeningPrompt`、`DEFAULT_MAX_STEPS`（[[lib/agentic.js:325]]）。本模块只是它的「批量 + 落盘 + 子模块递归」外壳。
- **[[agentic-host]]**（`lib/agentic-host.js`）：提供 `makeHostStream`（裸消息 → 宿主 `llm.stream` + `BlockAssembler`，[[lib/agentic-host.js:83]]）与 `makeFsWorkspace`（仓库 readFile/listDir 抽象，[[lib/agentic-host.js:111]]），是 `runOneArticle` 拿到真实模型与真实文件系统的入口。
- **[[article-contract]]**（`lib/article-contract.js`）：提供 `makeWriteSet`（[[lib/article-contract.js:352]]）与 `isWritable`（[[lib/article-contract.js:365]]），实现本模块的「写集闸门」；也承载文章契约质量门（供 index.js 的 `contractCheck` / `fixAnchors` 使用）。
- **[[test-articles-agentic]]**（`test-articles-agentic.mjs`）：本模块的离线测试，用假 `streamFn`（`scripted`，[[test-articles-agentic.mjs:37]]）覆盖「基本落盘 / 子模块递归 / 重名去重 / subDepth 封顶 / 双池 / 写集闸门」等全部关键路径（[[test-articles-agentic.mjs:47-470]]）。

## Known Issues

下列已知缺陷或行为边界均从源码注释与测试回归点提炼，未做功能屏蔽：

- **`outputTokens` 是粗估**：`runAgenticArticles` 里 `outputTokens = Number(out?.usage?.outputTokens) || 0`——注释明说「streamFn 侧收不到（chunk 里 usage 会出现多次），这里按步数粗估」（[[lib/articles-agentic.js:277-278]]）。做 tps 采样时只能当近似。

- **子模块递归深度必须在 `dispatchSub` 闭包里原样重建判定**：旧实现把本层闭包 `dispatchSub` 原样下传，子层 `_depth >= subDepth` 永远用父层深度 → 永不触发 → 模型无限往下拆（实测 `subDepth=2` 堆溢出）。修复方式见 [[lib/articles-agentic.js:113-120]]（传 `onSubModule:null`、`_depth+1`、`subModuleBlocked` 重算）。相关回归测试 `test-articles-agentic.mjs:143-215`。

- **深度封顶时必须说实话，否则死链**：`dispatchSub` 为 `null` 时，必须把 `subModuleBlocked='max-depth'` 传递给工具层（[[lib/articles-agentic.js:82-84]]，[[lib/articles-agentic.js:83]]）。否则 `lib/agentic.js` 的 `generate_sub_module` 实现会笼统回「已记录/已派发」，模型据而在父文写「详见 xxx.md」，那个文件从未生成 → 死链且父任务仍记 `ok:true`（[[lib/agentic.js:290-306]]）。

- **空文章兜底**：模型全程没写过正文但最后一段文本像文章，`runAgenticArticle` 会收下它（[[lib/agentic.js:331-336]]）；`runOneArticle` 再兜底 `stopReason==='finished'` 时判 `'empty-article'` 失败（[[lib/articles-agentic.js:33-36]]），防止空文件覆盖旧文。

- **写集不传 = 不设限**：`allowedWritePaths === undefined` 时 `writeSet=null`，`isWritable` 恒返回 `true`（[[lib/articles-agentic.js:66-67]]，[[lib/article-contract.js:366]]）；只有显式传 `null/[]` 才是「谁都不许写」的收紧。旧调用方与测试沿用不设限行为（回归测试 `test-articles-agentic.mjs:433-447`）。

- **`markBigAgenticTasks` 体量判据是「源文本量」而非「装填预算」**：因为 agentic 通道不把源码内联进 prompt（模型自己读），所以单轮通道那条「装填超预算」判据不适用，改用模块源文本量超 `budget` 作为等价物（[[lib/articles-agentic.js:314-319]]）。`sizeOf` 缺省取 `t.sourceChars`（[[lib/articles-agentic.js:327]]），调用方 `tickArticles` 实际传的是 `sourceTokensOf`（[[index.js:3302]]）。

- **双池回落边界**：`bigConcurrency` 为 `0`/未传时回落到 `concurrency`（[[lib/articles-agentic.js:250-255]]，[[index.js:128-130]]）；`bigTier` 任务若没配 `provider`（或 `budget=0`）则 `markBigAgenticTasks` 原样返回、不进大档池（[[lib/articles-agentic.js:322-325]]）。

- **降级只退一次**：`shouldFallBackHere` 守 `job.agenticRetried`，agentic 失败退回单轮通道只重跑一次，否则退回后仍失败会每 tick 重新提交成死循环（[[index.js:2680-2687]]，[[index.js:2680]]）。
