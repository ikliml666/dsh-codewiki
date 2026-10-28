---
title: agentic_article
type: module
source_files:
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - index.js
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
  - test-agentic-fallback.mjs
  - test-orchestration.mjs
tags: [agentic, article-generation, llm-loop, tool-use, streaming]
---

## Overview

本模块是 dsh-codewiki 的 **agentic 文章写作通道**（与 `index.js` 里 `runRealtimeTasks` 的
单轮整包装填通道并列的第二条文章执行通道）。它把「模块任务清单」跑成一篇 wiki 文章：
模型不再是「一次性把全部源码塞进 prompt 求一篇文章」，而是拿到一组工具（读码、列目录、
增量编辑文章、可选地把子模块派出去另写），在一个工具调用循环里反复读源码、精确改文章，
读完即止。

模块由四层协作，全部位于 `lib/`：

- **`lib/agentic.js`** —— 纯逻辑的工具循环本体与四个工具实现（`runAgenticArticle`、
  `makeReadCodeTool`、`makeListFilesTool`、`makeArticleEditor`、`buildToolset`、
  `buildOpeningPrompt`，以及 JSON 参数解析辅助）。它只消费 `{role, content}` 裸消息和
  `ContentBlock`，不依赖任何宿主对象，因此可用假 `streamFn` 完全离线测试
  （见 `test-agentic.mjs`）。
- **`lib/agentic-host.js`** —— 把裸消息适配成宿主 `@deepseek-ai/dsh-llm` 的正式 `Message`
  （`toRequestMessages`），把 chunk 流收成 blocks（`makeHostStream`），并把真实文件系统
  包成一个 `workspace` 抽象（`makeFsWorkspace`）。
- **`lib/articles-agentic.js`** —— 单篇/批量执行器：把「模块任务」交给循环并落盘
  （`runOneArticle`、`runAgenticArticles`），按源文本量给超大模块打大档标记
  （`markBigAgenticTasks`、`sourceTokensOf`），以及单任务的选档/并发池（`resolveTaskRoute`）。
- **`lib/article-contract.js`** —— 文章契约闸门（`inspectArticle` 等）。agentic 通道写的
  文章落盘前后都要过它，因此本模块也直接依赖它来判「坏文章不落盘」「写集越界不落盘」。
  不过 agentic 通道本身不在 `article-contract.js` 里实现闸门，而是复用 `index.js` 的
  `contractCheck`（`index.js:581`）在落盘点收口。

通道开关：`index.js` 的 Config 字段 `agenticArticles`（默认 `true`，`index.js:90`，
`liveConfig` 透出在 `index.js:109`）决定是否走本通道；`agenticMaxSteps`（默认 `30`，
`index.js:3135`，硬顶 100）是单篇步数上限。生产链路由 `index.js` 的 `tickArticles`
（`index.js:3135`）在组装文章任务时调用 `markBigAgenticTasks`（`index.js:3277`）与
`startAgenticRun`（`index.js:2932`）。

回退语义：agentic 通道单篇失败只记账、不影响其它任务；若**本批失败过半**，由
`shouldFallBackFromAgentic`（`index.js:1364`）判定退回单轮通道重跑一次失败篇
（`index.js:3200`、`shouldFallBackHere` `index.js:2664`），且 `job.agenticRetried`
只退一次（`index.js:2665`）避免每 tick 死循环。

## Key Components

### lib/agentic.js（纯逻辑工具循环本体）

- `TOOL_SCHEMAS`（`lib/agentic.js:27`，导出）—— 四个工具的 JSON-Schema 形态定义数组：
  `read_code`、`list_files`、`edit_article`、`generate_sub_module`。每个含 `name`、
  `description`、`parameters`（JSON-Schema 对象，`required` 与字段说明）。这是 `runAgenticArticle`
  实际声明给模型的工具清单来源（`lib/agentic.js:354` 按可用情况过滤）。
- `MAX_READ_LINES = 2000`（`lib/agentic.js:93`）—— 单次 `read_code` 返回的**行数**上限。
- `MAX_READ_CHARS = 40000`（`lib/agentic.js:96`）—— 单次 `read_code` 返回的**字符**上限；
  仅限行数挡不住单行超长/压缩产物（实测单行 20 万字符一次回吐 5.7 万 token），字符上限兜底
  （`lib/agentic.js:164`）。
- `IGNORED_DIRS`（`lib/agentic.js:98`）—— `list_files` 一律不列出的目录
  （`node_modules/.git/dist/build/.next/target/vendor/__pycache__/.venv/venv` 等）。
- `numberLines(text)`（`lib/agentic.js:101`，导出）—— 给文本每行加 `N| ` 前缀，模型据此引用行号。
- `makeReadCodeTool(workspace, { seen, getStep })`（`lib/agentic.js:115`，导出）—— 构造 `read_code`
  工具实现（本质上是 `(args) => { isError, text }`）。核心特性：
  - 路径越界防护：`safeRelPath`（`lib/agentic.js:266`）拒绝 `../`/绝对路径/`C:` 盘符
    （`lib/agentic.js:121` 报错）。
  - **重复读抑制**：`seen` map 以 `(path, start, end)` 为键记账（`lib/agentic.js:127`–`152`），
    同段再读只回「你已在第 N 步读过」（用 `getStep()` 报真实步号，`lib/agentic.js:116`、
    `lib/agentic.js:132`），不重复把整文件读进上下文。不同文件、不同行范围不互相影响。
  - 行/字符截断：超 `MAX_READ_LINES` 截前 N 行（`lib/agentic.js:156`），超 `MAX_READ_CHARS`
    截字符（`lib/agentic.js:164`）。
- `makeListFilesTool(workspace)`（`lib/agentic.js:179`，导出）—— `list_files` 实现：读目录、
  过滤 `IGNORED_DIRS`（`lib/agentic.js:191`）、标注 `dir` 标记（`lib/agentic.js:129`）、
  缺目录给说明（`lib/agentic.js:193`）。`depth` 夹在 1–4（`lib/agentic.js:183`）。
- `makeArticleEditor(initial)`（`lib/agentic.js:200`，导出）—— 文章编辑器的闭包状态
  （`let article`）。返回一个对象，含：
  - `edit(args)`（`lib/agentic.js:202`）：三种 command——
    - `view`（`lib/agentic.js:204`）：返回带行号的文章全文；空文章给说明（`lib/agentic.js:205`）。
    - `str_replace`（`lib/agentic.js:208`）：按 `old_str` 替换；**行尾归一化**先统一成 `\n`
      再匹配（`lib/agentic.js:216`–`228`，解决 core.autocrlf 下 CRLF 永远匹配不上的坑），
      `old_str` 必须唯一（`lib/agentic.js:223`）、缺失给可操作提示（`lib/agentic.js:221`）。
    - `insert`（`lib/agentic.js:231`）：在第 `line` 行后插入（`line=0` 插到最前）；
      **负数行号必须报错**而非静默插到最前（`lib/agentic.js:235`），越界报错
      （`lib/agentic.js:246`）。
  - `get article` / `set article`（`lib/agentic.js:260`–`261`）：读写闭包内文章正文，
    供循环读取最终成稿。
- `safeRelPath(rel)`（`lib/agentic.js:266`，导出）—— 路径越界防护，已见上。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（`lib/agentic.js:279`，
  导出）—— 把 `makeReadCodeTool`/`makeListFilesTool`/`editor.edit`/`generate_sub_module`
  打包成 `{ read_code, list_files, edit_article, generate_sub_module }` 调度表
  （`lib/agentic.js:280`）。`generate_sub_module` 实现（`lib/agentic.js:285`）：
  - 有 `onSubModule` 时回调它（`lib/agentic.js:308`）。
  - 没有时**必须说实话**：区分 `subModuleBlocked='max-depth'`（嵌套到顶，
    `lib/agentic.js:294`）与无递归支持（`lib/agentic.js:301`），分别回 `isError:true`
    并指示模型「就地写成普通小节，别留死链」。旧实现一律回「已派发」导致死链
    （`lib/agentic.js:291`）。
- `DEFAULT_MAX_STEPS = 30`（`lib/agentic.js:325`，导出）—— 单篇步数上限的唯一定义点；
  `articles-agentic.js` 从此再导出，与 `index.js` 的 `agenticMaxSteps` 默认值一致（见注释
  `lib/agentic.js:321`–`324`）。
- `runAgenticArticle(opts)`（`lib/agentic.js:331`，导出）—— **循环本体**。签名字段：
  `mission`、`streamFn`、`workspace`、`tools?`、`editor?`、`onSubModule?`、
  `subModuleBlocked?`、`maxSteps=DEFAULT_MAX_STEPS`、`signal?`、`initialMessages?`、
  `systemPrompt=`、`articleFormat=`。流程（`lib/agentic.js:367` 起 `for` 循环）：
  1. 每步调 `streamFn({ messages, tools: schemas, signal })`，收 `blocks`
     （`lib/agentic.js:373`，`blocks` 取数组或 `out.blocks`）；
  2. 模型消息原样进历史（`lib/agentic.js:383`，保留其 tool-call，否则下一轮 callId 对不上）；
  3. 无工具调用 = 写完（`lib/agentic.js:389`）：若 editor 空且正文非空则收下正文
     （`lib/agentic.js:391`），`stopReason='finished'`；
  4. 否则对每个 `tool-call` 执行工具实现、把结果拼成 `tool-result` 消息回灌
     （`lib/agentic.js:398`–`421`，未知工具/抛错都归一成 `isError` 结果不中断）。
  返回 `{ article, steps, usedTools, stopReason, messages }`（`lib/agentic.js:425`）。
  `stopReason` 取值：`finished` / `max-steps` / `empty-response` / `stream-error` /
  `aborted`（对应 `lib/agentic.js:369`、`380`、`377`、`363`）。
- `stripJsonFence(s)`（`lib/agentic.js:439`，导出）—— 剥 ```json 围栏。
- `sliceBalancedObject(s)`（`lib/agentic.js:447`，导出）—— 从任意位置截出首个括号平衡的
  JSON 对象（跳过字符串字面量里的括号）。
- `parseToolArgs(raw, steps, step, toolName)`（`lib/agentic.js:476`，导出）—— 三级递进解析
  工具参数：原样 → 剥围栏 → 截首个平衡对象（`lib/agentic.js:481`–`485`），坏 JSON 记
  `steps` 警告并回 `{}` 不中断（`lib/agentic.js:498`）。
- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（`lib/agentic.js:506`，
  导出）—— 拼开场系统提示词：任务、可用工具清单、六步工作法、禁用项（不许编造文件/行号、
  不用 markdown 围栏包裹整篇）、可选的子模块拆分说明（`lib/agentic.js:525` 仅当
  `generate_sub_module` 在 schemas 里才加）。

### lib/agentic-host.js（宿主 llm 适配层）

- `SOURCE = { kind: 'plugin:codewiki' }`（`lib/agentic-host.js:15`）—— 消息来源标记。
- `IDENTITY = new WeakMap()`（`lib/agentic-host.js:26`）—— 裸消息 → 正式 Message 的身份缓存，
  以裸对象为键，跨表示边界稳定 MessageId（`lib/agentic-host.js:17`–`25`）。
- `stableKeyFor(role, r, index)`（`lib/agentic-host.js:29`）—— tool 角色一拆多时的稳定键
  （带结果序号）。
- `toRequestMessages(messages, { provider, model })`（`lib/agentic-host.js:34`，导出）——
  裸消息 → 宿主 `RequestMessage[]`：
  - `user` → `createUserMessage`（`lib/agentic-host.js:42`）；
  - `assistant` 有 `id` 则透传（`lib/agentic-host.js:46`），否则 `createAssistantMessage`
    （带 `provider/model` source，`lib/agentic-host.js:51`）；
  - `tool` 一条消息**多个结果拆成多条** `ToolResultMessage`（`lib/agentic-host.js:58`–`74`，
    每条带 `callId` 与 `isError`）。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（`lib/agentic-host.js:83`，
  导出）—— 返回一个 `(params) => { blocks, finish, usage }`，是交给 `runAgenticArticle`
  的 `streamFn`。内部用 `BlockAssembler` 收 chunk（`lib/agentic-host.js:86`），
  经 `toRequestMessages` 转消息（`lib/agentic-host.js:87`），透传 `temperature:0`
  （`lib/agentic-host.js:94`）、`reasoningEffort`（`lib/agentic-host.js:91`）、
  `signal`（`lib/agentic-host.js:95`）；`finish.kind==='error'|'aborted'` 抛错
  （`lib/agentic-host.js:101`）。
- `makeFsWorkspace(fs, path, cwd)`（`lib/agentic-host.js:111`，导出）—— 把真实 fs 包成
  `workspace` 抽象，只暴露 `readFile`/`listDir`，且**再兜一层越界**：真实绝对路径必须落在
  `cwd` 内（`lib/agentic-host.js:113`–`118`），否则抛「越界路径」。

### lib/articles-agentic.js（单篇/批量执行器）

- `DEFAULT_MAX_STEPS`（`lib/articles-agentic.js:21`，从 `./agentic.js` 再导出）—— 保持既有导入路径。
- `runOneArticle(task, opts)`（`lib/articles-agentic.js:33`，导出）—— 跑单篇 agentic 循环并落盘。
  关键字段与行为：
  - `task`：`name`（形如 `modules/commerce.md`）、`mission`、`articlePath`、`sources`、
    `prevArticlePath`（旧文作增量上下文，`lib/articles-agentic.js:60`）。
  - 构造 `editor`（`makeArticleEditor`，`lib/articles-agentic.js:63`）、`workspace`
    （`makeFsWorkspace`，`lib/articles-agentic.js:64`）、`writeSet`（写集闸门，
    `lib/articles-agentic.js:69`）、`streamFn`（默认 `makeHostStream`，
    `lib/articles-agentic.js:69`，可注入假模型）。
  - **子模块递归派发**：`dispatchSub`（`lib/articles-agentic.js:83`）当 `_depth < subDepth`
    时递归 `runOneArticle` 写子文章，路径 `modules/<父 slug>/<子 slug>.md`
    （`lib/articles-agentic.js:96`），并全局去重重名（`lib/articles-agentic.js:73`–`94`）。
    深度封顶 `_depth >= subDepth` 时传 `null`（`lib/articles-agentic.js:82`–`84`）。
  - 调 `runAgenticArticle`（`lib/articles-agentic.js:130`），空文章兜底判失败
    （`empty-article`，`lib/articles-agentic.js:147`）。
  - 落盘：写集校验越界返回 `write-set` 失败（`lib/articles-agentic.js:155`–`166`），
    否则 `fixAnchors` 修正行号锚点后写盘（`lib/articles-agentic.js:168`–`176`）。
  - 返回 `{ ...out, subModules, ok }`（`lib/articles-agentic.js:178`）。
- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（`lib/articles-agentic.js:185`，导出）——
  按 CJK/非 CJK 口径估模块源文本 token（与 `index.js` 的 `estimateTokens` 同口径，
  `lib/articles-agentic.js:186`–`194`），作大档判据（读不到按 0 计）。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（`lib/articles-agentic.js:208`，
  导出）—— 单任务选档：任务自带 `provider+model` 时全以任务为准、effort 也以任务为准
  （空 = 模型默认档，不回落默认档 effort，`lib/articles-agentic.js:210`–`216`），否则用默认档。
- `runAgenticArticles(tasks, opts)`（`lib/articles-agentic.js:231`，导出）—— **并发池**：
  返回 `Map(customId → 结果)`，与 `runRealtimeTasks` 同形状。双池——`bigTier` 任务走大档池
  （`bigConcurrency`），其余走默认档池（`concurrency`），各自独立限流同时推进
  （`lib/articles-agentic.js:245`–`255`、`lib/articles-agentic.js:310`）。
  每任务调 `runOneArticle`（`lib/articles-agentic.js:269`），失败记 note 不中断
  （`lib/articles-agentic.js:300`–`302`）。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（`lib/articles-agentic.js:320`，导出）——
  纯函数：源文本量超 `bigTier.budget` 的模块打上 `provider/model/bigTier=true`（可选
  `reasoningEffort`，`lib/articles-agentic.js:329`–`330`），未配置 `bigProvider` 时原样返回
  （`lib/articles-agentic.js:322`–`323`）。agentic 通道不装填源码，判据换成源文本量。

### lib/article-contract.js（文章契约闸门，被本模块复用）

- `inspectArticle(content, opts)`（`lib/article-contract.js:213`）—— 主入口，返回 `issues[]`
  （空数组 = 通过）。判 `frontmatter` 闭合/字段、type 与目录匹配、`source_files` 存在性与证据来源、
  正文重复 frontmatter/围栏/空章、内部链接死链（`lib/article-contract.js:241`–`332`）。
- `makeWriteSet(paths)` / `isWritable(target, writeSet, { cwd })`（`lib/article-contract.js:365`、
  `lib/article-contract.js:350`）—— 写集闸门：返回哪些路径可写；agentic 的 `allowedWritePaths`
  经 `makeWriteSet` 编译，落盘前 `isWritable` 校验越界（见 `index.js:156` 与
  `lib/articles-agentic.js:155`）。
- `SEVERITY`（`lib/article-contract.js:56`）—— error 级拒写、warning 级放行记账；
  `hasBlockingIssue`（`lib/article-contract.js:346`）只拦 error 级。

## Architecture

```text
  模块任务 task(articlePath, mission, sources)
              │
              ▼
  ┌───────────────────────────────────┐
  │ runOneArticle (articles-agentic.js:33)│
  │  · makeArticleEditor / makeFsWorkspace │
  │  · makeWriteSet(allowedWritePaths)     │
  │  · dispatchSub -> 递归子模块           │
  └───────────────┬───────────────┘
                  │ streamFn + workspace + editor
                  ▼
  ┌───────────────────────────────────┐
  │ runAgenticArticle (agentic.js:331)  │ 纯逻辑循环（可离线）
  │  for step < maxSteps:               │
  │   streamFn -> blocks                │
  │   tool-call -> tools[name](args)    │
  │   tool-result 回灌 messages         │
  │  -> { article, steps, stopReason }  │
  └───┬───────────┬───────────┬────┘
      │           │           │
      ▼           ▼           ▼
 ┌────────┐ ┌──────────┐ ┌──────────────┐
 │read_code│ │list_files│ │ edit_article  │  buildToolset(agentic.js:279)
 │(115)    │ │(179)     │ │(200)         │  + generate_sub_module(285)
 └───┬────┘ └────┬─────┘ └──────┬───────┘
     │           │              │
     ▼           ▼              ▼
 workspace  workspace      editor.article (闭包状态)
 (readFile/ (listDir)        (view/insert/str_replace)
  listDir)
                  │
   ┌──────────────┴─────────────── 生产链路：streamFn 由宿主提供 ──┐
   ▼                                                      ▼
 ┌──────────────────────┐   toRequestMessages   ┌──────────────────────┐
 │ makeHostStream       │ ───────► (agentic-host.js:34) ───► 宿主 llm.stream │
 │ (agentic-host.js:83) │ ◄─────── BlockAssembler ◄── 流式 chunk         │
 └──────────────────────┘                       └──────────────────────┘
                  │ runOneArticle 落盘前
                  ▼
  inspectArticle / isWritable (article-contract.js:213/365)  → ok 才 writeFileSync
```

组件清单（含文件:行）：
- 循环本体 `runAgenticArticle` `lib/agentic.js:331`；工具调度 `buildToolset` `lib/agentic.js:279`。
- 四个工具：`read_code` `lib/agentic.js:115`、`list_files` `lib/agentic.js:179`、
  `edit_article` `lib/agentic.js:200`、`generate_sub_module` `lib/agentic.js:285`。
- 宿主适配：`toRequestMessages` `lib/agentic-host.js:34`、`makeHostStream` `lib/agentic-host.js:83`、
  `makeFsWorkspace` `lib/agentic-host.js:111`。
- 执行器：`runOneArticle` `lib/articles-agentic.js:33`、`runAgenticArticles` `lib/articles-agentic.js:231`、
  `markBigAgenticTasks` `lib/articles-agentic.js:320`、`sourceTokensOf` `lib/articles-agentic.js:185`。
- 闸门：`inspectArticle` `lib/article-contract.js:213`、`isWritable` `lib/article-contract.js:365`。

## Data Flow

1. **任务组装（生产链路）**：`index.js` 的 `tickArticles`（`index.js:3135`）在 `agenticArticles`
   开关打开时，把模块清单（`job.plan.modules` 或 stale 预构建任务，见 `index.js:3254`–`3264`）
   每个模块映射成 `{ name, mission, sources, cwd, articlePath, prevArticlePath }`，再用
   `markBigAgenticTasks`（`index.js:3277`）按 `sourceTokensOf` 体量打大档标记，然后打 `agentic:true`
   快照进 `job.tasks`（`index.js:3289`）并 `startAgenticRun`（`index.js:3298`）。

2. **进入执行器**：`startAgenticRun`（`index.js:2932`）对每个任务调 `runAgenticArticles`
   （`index.js:4872`），传入 `llm`/`provider`/`model`/`maxSteps=c.agenticMaxSteps`/
   `articleFormat=articleFormatSection()`（`index.js:2952`）/`allowedWritePaths`（所有任务的
   `articlePath` 列表，`index.js:2952`）。`runAgenticArticles` 双池并发（`lib/articles-agentic.js:231`），
   每任务 `runOneArticle`（`lib/articles-agentic.js:269`）。

3. **单篇循环**：`runOneArticle`（`lib/articles-agentic.js:33`）构造 `editor`、`workspace`
   （`makeFsWorkspace`，`lib/articles-agentic.js:64`）、`writeSet`（`lib/articles-agentic.js:67`），
   默认 `streamFn = makeHostStream`（`lib/articles-agentic.js:69`）。模型在 `runAgenticArticle`
   循环（`lib/agentic.js:367`）里用 `read_code`/`list_files` 现场读源码、`edit_article`
   增量写文章；`generate_sub_module` 命中时走 `dispatchSub` 递归写子文章
   （`lib/articles-agentic.js:83`–`128`）。

4. **工具结果回流**：每个 `tool-call` 由 `buildToolset` 的实现执行（`lib/agentic.js:279`），
   结果作为 `tool-result` 消息回灌 `messages`（`lib/agentic.js:421`），下一轮作为上下文。
   模型消息原样保留 tool-call（`lib/agentic.js:383`）以对齐 callId。

5. **落盘闸门**：循环结束拿到 `article`（`lib/agentic.js:426`）。`runOneArticle` 先判空文章
   （`empty-article`，`lib/articles-agentic.js:147`），再判写集越界（`write-set`，
   `lib/articles-agentic.js:155`，用 `isWritable` `lib/article-contract.js:365`），最后
   `fixAnchors` 修正行号锚点后 `fs.writeFileSync`（`lib/articles-agentic.js:176`–`176`）。
   注意：agentic 通道**不**经 `index.js` 的 `contractCheck` 做 frontmatter 完整校验后再落盘——
   写集只挡越界路径，其它结构问题由 `index.js` 的 `tally`/`localReview` 在后续阶段记账
   （`index.js:2629`、`index.js:3467`）。

6. **结果记账与回退**：`runAgenticArticles` 把每篇结果收进 `Map`（`lib/articles-agentic.js:231`），
   派生子模块记 note（`lib/articles-agentic.js:281`）。`startAgenticRun` 把结果交 `batchResults`
   由 `settleJob` 收割（`index.js:2539`）。若本批失败过半，`shouldFallBackHere`
   （`index.js:2664`）触发退回单轮通道重跑失败篇（`index.js:3200`–`3235`），`job.agenticRetried`
   只退一次（`index.js:2665`）。

7. **宿主重启恢复**：agentic 任务无 `batchPrompt` 快照，重启后 `settleJob` 按 `t.agentic===true`
   整批重跑（`index.js:2550`–`2554`）。

## Connections

- [[index]] —— 编排服务 `codewiki_generate` 的总入口；`tickArticles`（`index.js:3135`）、
  `startAgenticRun`（`index.js:2932`）、`shouldFallBackFromAgentic`（`index.js:1364`）、
  `shouldFallBackHere`（`index.js:2664`）把本模块接进阶段机。
- [[article-contract]] —— `inspectArticle`（`lib/article-contract.js:213`）/`isWritable`
  （`lib/article-contract.js:365`）是写集与结构闸门，被 `runOneArticle` 落盘点复用。
- [[engine-bridge]] / 原生引擎通道 —— 当 `nativeEngine=true` 时 full 编译改走原生 Python
  引擎（`index.js:nativeChannelFor`），不走本 agentic 通道；两者是并列的「文章生成」替代链路。
- 单轮整包装填通道（`runRealtimeTasks`，`index.js:662`）—— 与本通道并列；agentic 通道大面积
  失败时的回退目标（`index.js:3200` 分支）。
- [[cluster]] / 语义规划 —— `buildPlan`（`index.js:2986`）产出 `job.plan.modules`，是
  agentic 通道的任务来源；`planMode=dirs` 时退回 `localPlan`（目录分组，`index.js:1371`）。

## Known Issues

- **`generate_sub_module` 谎称已成文（已修）**：旧实现在 `onSubModule` 缺失时回「已记录子模块
  X」，导致父文写「详见 x.md」而文件从未生成（死链）。现 `buildToolset` 区分 `max-depth` 与
  无递归两种情况，均回 `isError:true` 并指示就地写成普通小节（`lib/agentic.js:285`–`313`，
  测试见 `test-agentic.mjs:401`）。
- **子模块嵌套深度失效（已修，回归防护）**：旧 `dispatchSub` 是闭包、递归时原样下传，子层
  `_depth >= subDepth` 永远用父层深度 → 可无限下拆直至栈溢出。现递归时显式重置 `onSubModule`
  与 `subModuleBlocked`、传 `_depth+1`（`lib/articles-agentic.js:117`–`120`），测试
  `test-articles-agentic.mjs:182`/`201` 用磁盘层数 + 调用次数有界来守护 `subDepth` 封顶真的生效。
- **重复读源码烧步数（已修）**：真实模型会反复读同一大文件，导致 `stopReason=max-steps` 文章没写完。
  `makeReadCodeTool` 的 `seen` 记账 + 「你已在第 N 步读过」提示把上下文省回模型自己
  （`lib/agentic.js:108`–`135`，测试 `test-agentic.mjs:501`）。
- **CRLF 下 str_replace 永远匹配不上（已修）**：core.autocrlf 下文章存 `\r\n`，模型按 view
  输出（`\n`）写 `old_str` 字面匹配永远失败。`edit_article` 匹配前统一行尾、命中后再按原风格写回
  （`lib/agentic.js:212`–`228`，测试 `test-agentic.mjs:542`）。
- **`insert` 负数行号被静默插到最前（已修）**：现负数行号直接报错（`lib/agentic.js:235`，
  测试 `test-agentic.mjs:589`）。
- **坏 JSON 工具参数导致整轮写不出文章（已修）**：模型常把 JSON 包在 ```json 围栏或夹在说明文字里，
  `parseToolArgs` 三级递进解析，失败当成工具结果回灌让模型自己改（`lib/agentic.js:476`–`500`，
  测试 `test-agentic.mjs:470`）。
- **单行超长文件灌爆上下文（已修，字符上限兜底）**：仅限行数挡不住压缩产物/单行 20 万字符文件，
  `MAX_READ_CHARS=40000` 兜底（`lib/agentic.js:96`–`167`，测试 `test-agentic.mjs:563`）。
- **步数上限两处取值漂移（已修）**：`articles-agentic.js` 与 `index.js` 曾各写一个常量（24/30），
  直接调 `runAgenticArticle` 拿 24、走生产拿 30。现 `DEFAULT_MAX_STEPS` 唯一定义在 `lib/agentic.js:325`，
  `articles-agentic.js:21` 再导出，`index.js` 的 `agenticMaxSteps` 默认值也对齐 30
  （`lib/agentic.js:321`–`324`）。
- **写集越界漏拦（接口已备，调用方需传）**：`runOneArticle` 的写集闸门只在 `allowedWritePaths`
  被传入时生效；`index.js` 的生产路径会传全部任务 `articlePath`（`index.js:2952`），但测试/旧调用方
  不传时（`undefined`）保持不设限旧行为（`lib/articles-agentic.js:67`、`433`）。子模块递归时父任务
  写集**只下传子自己那一条路径**（不包父文），避免子层越界覆盖父文（`lib/articles-agentic.js:112`、
  测试 `test-articles-agentic.mjs:449`）。
- **agentic 通道落盘不二次过契约闸门**：agentic 通道直接 `fs.writeFileSync`，只过写集越界校验，
  没有像单轮 keepInMemory 那样在落盘前跑 `validateArticleEnvelope`/`writeValidated`
  （`index.js:2601`）。因此 agentic 产出的结构问题（如未闭合 frontmatter、空章）依赖后续
  `localReview`（`index.js:3467`）与 `auditExistingArticles`（`index.js:1852`）在 review 阶段记账，
  而非当场拒写。
