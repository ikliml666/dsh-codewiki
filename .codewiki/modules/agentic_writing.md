---
title: agentic_writing
type: module
source_files:
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - index.js
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-agentic-fallback.mjs
  - test-articles-agentic.mjs
tags: [agentic, writing, tools, stream, batch]
---

## Overview

`agentic_writing` 是把「模块任务清单」跑成 wiki 文章的第二条执行通道（对应 `index.js` 里 `runRealtimeTasks` 单轮整包装填的旧通道，见 [[orchestration]]）。它吸收自 FSoft-AI4Code/CodeWiki 的 module agent：模型不再靠「一次性把源码内联进 prompt 求一篇全文」，而是拿到一个可反复读源码、可对文章做精确编辑、可把大模块递归派给子任务的工作台。核心文件有三层：

- `lib/agentic.js` —— 纯逻辑的工具循环：定义 4 个工具（`read_code` / `list_files` / `edit_article` / `generate_sub_module`），实现它们的纯函数式版本，并提供一个不绑死任何 llm 服务的 `runAgenticArticle(opts)` 循环（消费 `{role, content}` 裸消息、只认 blocks）。
- `lib/agentic-host.js` —— 工具循环 ↔ 宿主 llm 服务的适配层：把裸消息转成宿主正式 `Message`、`BlockAssembler` 收流、以及 FS `workspace` 抽象。
- `lib/articles-agentic.js` —— 编排层：`runOneArticle` 跑单篇并落盘（含子模块递归派发），`runAgenticArticles` 做双池并发批跑（大档/默认档各自限流），`markBigAgenticTasks` 按源文本量打大档标记。

落盘闸门（写集 write-set）由 `lib/article-contract.js` 的 `makeWriteSet` / `isWritable` 提供（见 [[article-contract]]），保证 agentic 通道里模型有自由工具循环时，仍能约束「能写哪些文件」。

## Key Components

### lib/agentic.js（工具循环核心，共 541 行）

- `TOOL_SCHEMAS` (27–87)：4 个工具的 JSON Schema 定义数组——`read_code`(29)、`list_files`(44)、`edit_article`(55)、`generate_sub_module`(73)。契约与 `lib/agentic.js` 顶部注释(17–19)一致：`runAgenticArticle({ mission, workspace, streamFn, tools?, maxSteps })` → `{ article, steps, usedTools, stopReason }`。
- `MAX_READ_LINES = 2000` (93)：`read_code` 单次返回行数上限（截取前 N 行并提示继续读）。
- `MAX_READ_CHARS = 40000` (96)：单次 `read_code` 字符上限（约 11k token）。只限行数挡不住压缩产物——实测单行 20 万字符文件一次回吐 5.7 万 token，因此加字符上限。
- `IGNORED_DIRS` (98)：`list_files` 一律隐藏的目录（`node_modules`/`.git`/`dist`/`build`/`.next`/`target`/`vendor`/`__pycache__`/`.venv`/`venv`）。
- `numberLines(text)` (101–106)：按 `i+1| ` 前缀格式化每行的行号（模型据此引用行号）。返回 `string`。
- `makeReadCodeTool(workspace, { seen, getStep })` (115–177)：`read_code` 实现。去重记账——同一 `(path, 起始行, 结束行)` 再读只回「你已在第 N 步读过这段」(129–135)；行范围裁剪(124–147)；行上限(156)与字符上限(164)截断；越界路径拒绝(121)。`seen` 为 `Map`，`getStep` 返回当前步号。
- `makeListFilesTool(workspace)` (179–197)：`list_files` 实现。`depth` 限 1–4(183)；过滤 `IGNORED_DIRS`(191)；隐藏目录数计入 note(194)。
- `makeArticleEditor(initial = '')` (200–263)：返回 `{ edit, get article, set article }`。`edit(args)` 三命令：
  - `view`(204)：返回带行号的全文（空文给说明）。
  - `str_replace`(208)：`old_str` 唯一匹配才替换（行尾归一化 `\r\n`↔`\n` 再匹配，命中后按原文风格写回，避免悄悄改成 LF）(216–229)；多处匹配报「不唯一」(224)；未匹配给可操作提示(221)。
  - `insert`(231)：`line=0` 插到最前，否则插到第 line 行之后；负数行号报错不静默吞成最前(235)；行号越界报错(246)。
- `safeRelPath(rel)` (266–273)：路径越界防护。拒绝绝对路径、`C:`、`../` 跳出去（返回 `null`）。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })` (279–315)：拼出工具调度表 `{ read_code, list_files, edit_article, generate_sub_module }`。`generate_sub_module` 实现(285)：有 `onSubModule` 时回调它；无则必须说实话——`subModuleBlocked === 'max-depth'` 说「嵌套上限」(294)，否则说「当前模式不支持递归成文」(301)，绝不说谎「已派发/已记录」以免父文写死死链。
- `DEFAULT_MAX_STEPS = 30` (325)：单篇默认步数上限（唯一定义点；`index.js` 的 `agenticMaxSteps` 默认值必须与之一致，见 `index.js:92`）。
- `runAgenticArticle(opts)` (331–432)：循环本体。参数 `mission / streamFn / workspace / tools / editor / onSubModule / subModuleBlocked / maxSteps / signal / initialMessages / systemPrompt / articleFormat`(332–345)。`streamFn({ messages, tools, signal }) → { blocks, finish }`(328)。每步 `stepRef.current = step`(368)；`signal.aborted` → `stopReason='aborted'`(369)；调用 `streamFn` 拿到 `blocks`，原样 push 模型消息(383)；过滤 `tool-call`/`text`(385–387)；无工具调用即「写完」：editor 还空则收下正文文本(391)；执行工具调用并把结果作为 `tool-result` 消息回灌(398–422)。返回 `{ article, steps, usedTools, stopReason, messages }`(425–431)。
- `stripJsonFence(s)` (439–444)：剥 ```` ```json ```` 围栏。
- `sliceBalancedObject(s)` (447–473)：从任意位置截出第一个括号平衡的 `{...}`（跳过字符串字面量里的括号）。
- `parseToolArgs(raw, steps, step, toolName)` (476–500)：三级递进 `[原样 → 剥围栏 → 截平衡对象]`(481–485)；对象直通；坏 JSON 记 `steps.warning` 并退化 `{}`（不中断循环）(498)。
- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })` (506–541)：开场提示词。`toolList` 列可用工具(507)；有 `generate_sub_module` 才加「拆分」段落(508, 525–533)；硬要求强调「不许编造、用真实行号、不用围栏包整篇」(535–538)。

### lib/agentic-host.js（宿主适配层，共 135 行）

- `SOURCE = { kind: 'plugin:codewiki' }` (15)：宿主 `Message` 的 source 标记。
- `IDENTITY = new WeakMap()` (26)：裸消息对象 → 已构造宿主 `Message` 的缓存，保证消息跨边界身份稳定（MessageId 不每步换 UUID）。
- `stableKeyFor(role, r, index)` (29–31)：tool 角色一拆多时的稳定键（`role#index#toolCallId`）。
- `toRequestMessages(messages, { provider, model })` (34–79)：裸消息 → 宿主 `RequestMessage[]`。`user`(39) / `assistant`(46，带 provider/model 的 `source`，已有 `id` 透传不重造) / `tool`(58，一条 tool 消息装多条结果 → 展开成多条 `ToolResultMessage`，键带结果序号)；未知 role 忽略。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })` (83–108)：返回 `(params) => { blocks, finish, usage }`。经 `toRequestMessages` 转换(87)，`llm.stream(...)`(88)逐 chunk 用 `BlockAssembler` 收(97)；`finish.kind` 为 `error`/`aborted` 抛错(101)；无 `tools` 时不带 `tools` 字段(93)；`temperature: 0`(94)；`onDelta`/`onFinish` 失败不影响写作(98,105)。
- `makeFsWorkspace(fs, path, cwd)` (111–135)：仓库 `workspace` 抽象。`absOf` 把相对路径解析到 `cwd` 内、符号链接逃逸由 `safeRelPath` 再兜一层(112–118)；`readFile`(120)/`listDir`(125) 越界抛「越界路径」；`listDir` 返回 `{ path, dir }` 列表。

### lib/articles-agentic.js（编排层，共 333 行）

- `export { DEFAULT_MAX_STEPS }` (21)：从 `lib/agentic.js` 再导出，保持既有导入路径（避免又出一份独立常量）。
- `runOneArticle(task, {...})` (33–179)：跑单篇并落盘。关键参数：`llm / provider / model / reasoningEffort / cwd / fsImpl / pathImpl / articleFormat / systemPrompt / maxSteps / signal / onDelta / onSubModule / subModuleBlocked / writeArticle / fixAnchors / allowedWritePaths / streamFn / subDepth=2 / _depth=0 / _takenNames`(33–56)。已有旧文作为 `initialArticle` 交给 editor 做增量改(60–63)；`makeFsWorkspace`(64)；写集 `makeWriteSet(allowedWritePaths)`(67)；`streamFn` 可注入（离线测试用假模型，默认走 `makeHostStream`）(69)。**子模块递归派发** `dispatchSub`(83–128)：`slugOf`(75)、父目录名 `parentSlug`(77)、`atMaxDepth = _depth >= subDepth`(82)；子文章落 `modules/<父>/<子>.md`(96)；重名加父前缀仍重则跳过(89–93)；递归 `runOneArticle` 并把 `onSubModule` 传 `null`、`subModuleBlocked = (_depth+1) >= subDepth ? 'max-depth' : null`(117–118)，使子层自己重建深度判定（否则 `subDepth` 封顶形同虚设）。调用 `runAgenticArticle`(130)；空文章判失败 `stopReason='empty-article'`(147)；写集闸门 `isWritable` 越界返回 `write-set` 原因(155–167)；`fixAnchors` 修正(169–174)；落盘(175–176)。返回 `{ ...out, subModules, ok }`。
- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })` (185–203)：模块源文本量（近似 token），CJK 按 1、其余按 `ceil((len-cjk)/3.5)` 计（与 `index.js` `estimateTokens` 同口径，见 `index.js:529` 注释）；读不到按 0。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })` (208–222)：单任务选档。任务自带 `provider+model`（大档任务）时完全以任务为准、`reasoningEffort` 也以任务为准（空=模型默认档，不回落默认档 effort）(209–216)；否则全用参数默认档。
- `runAgenticArticles(tasks, { concurrency, bigConcurrency, notes, signal, onTaskDone, onRequestStart, ...rest })` (231–312)：双池并发批跑，返回 `Map(customId → 结果)`。普通任务走默认档池、带 `bigTier` 走大档池(245–255)；`runPool` + `worker` 按 `cursor` 取任务(257–307)；每个任务 `resolveTaskRoute` 后 `runOneArticle`(268–276)；结果 `results.set(t.customId, { name, ok, stopReason, steps, tools, subModules })`(284–291)；`outputTokens` 按步数粗估（chunk 里 usage 多次出现，收不到）(278)；失败/越界记 `notes`(292–298)。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })` (320–333)：按源文本量打大档标记（agentic 不装填源码，用源文本量等价物替代「装填超预算」判据）。`bigTier = { provider, model, reasoningEffort?, budget }`；`sizeOf` 缺省退 `task.sourceChars`；`size > budget` 才打 `bigTier: true`(327–332)；未配 provider / 无 budget 原样返回。

### lib/article-contract.js（写集闸门，本模块只用到 3 个导出，共 379 行）

- `makeWriteSet(paths)` (352–355)：返回 `Set`（规范化 POSIX 路径）或 `null`（调用方没设限=不检查）。
- `normalizeWritePath(p)` (357–361)：`\` 归一化、`path.posix.normalize`。
- `isWritable(target, writeSet, { cwd })` (365–378)：写集命中（规范化 + 以 cwd 解析后比对）才 `true`；`writeSet` 为 `null` 直接放行。

## Architecture

```text
┌──────────────┐  tasks   ┌───────────────────────────┐
│ index.js     │ ───────► │ runAgenticArticles        │ articles-agentic.js:231
│ tickArticles │         │  双池：normal / bigTier    │
└──────────────┘         └─────────────┬─────────────┘
                                         │ per task
                                         ▼
                               ┌──────────────────────┐
                               │ runOneArticle        │ articles-agentic.js:33
                               │  makeFsWorkspace     │ agentic-host.js:111
                               │  makeHostStream      │ agentic-host.js:83
                               │  dispatchSub(递归子模块)              │
                               └──────────┬───────────┘
                                          │ streamFn({messages,tools})
                  ┌───────────────────────▼────────────────────────┐
                  │ makeHostStream                          (host:83)│
                  │  toRequestMessages ─► llm.stream               │
                  │  BlockAssembler   ─► blocks                   │
                  └───────────────────────┬────────────────────────┘
                                          │ blocks
                                          ▼
                               ┌──────────────────────┐
                               │ runAgenticArticle    │ agentic.js:331
                               │  for step < maxSteps  │
                               │   buildToolset       │ agentic.js:279
                               │    read_code  ───────┼─► makeReadCodeTool ─► workspace.readFile
                               │    list_files ───────┼─► makeListFilesTool
                               │    edit_article ─────┼─► makeArticleEditor
                               │    generate_sub ─────┼─► onSubModule ──► dispatchSub(递归)
                               └──────────────────────┘
```

## Data Flow

1. **装配（`tickArticles`，`index.js:3004`）**：`index.js` 在 articles 阶段，若 `agenticArticles` 开且 `tasks.length`，用 `markBigAgenticTasks`(3318) 给超大模块打大档标记，把每个任务标 `agentic: true`(3334)，调 `startAgenticRun`(3339) → `runAgenticArticles`。
2. **双池批跑（`runAgenticArticles`，`articles-agentic.js:231`）**：按 `bigTier` 拆两池并发(245–255)，每任务回调 `onRequestStart`(265) 拿 `onDelta`，`resolveTaskRoute` 选档后 `runOneArticle`(269)。
3. **单篇循环（`runOneArticle`，33）**：建 `makeFsWorkspace`(64) + `makeHostStream`(69) + `makeArticleEditor`(63)，调用 `runAgenticArticle`(130)。
4. **工具回合（`runAgenticArticle`，331）**：每步把裸消息经 `toRequestMessages` 转成宿主 `RequestMessage`(`makeHostStream` 内，agentic-host.js:83)，`llm.stream` 吐 chunk，`BlockAssembler` 收成 `blocks`；模型若发出 `tool-call`，`buildToolset` 里对应实现读 `workspace`/`editor` 执行，结果作为 `tool-result` 回灌(421)。
5. **子模块递归**：模型调 `generate_sub_module` 时，`buildToolset` 经 `onSubModule=dispatchSub` 递归 `runOneArticle` 写子篇(85–128)，`subDepth` 封顶后工具层回 `max-depth` 提示直接写成本文小节。
6. **落盘与闸门**：`runOneArticle` 用 `isWritable` 校验 `task.articlePath` 在 `makeWriteSet(allowedWritePaths)` 内(155)，越界返回 `stopReason='write-set'`；通过则 `fixAnchors` 修正行号锚点后 `writeFileSync`(176)。
7. **结果回灌**：`runAgenticArticles` 把每篇结果 `results.set(customId, ...)`(284)，`index.js` 的 `settleJob`(2562) 收取（agentic 任务无 `batchPrompt` 快照，宿主重启按 agentic 通道重跑，见 `index.js:2399`）。失败过半且未退过时 `shouldFallBackHere`(2698) 退回单轮通道重跑失败篇（见 [[orchestration]] 与 `test-agentic-fallback.mjs`）。

## Connections

- [[orchestration]] —— `index.js` 的 `tickArticles`(3176)/`startAgenticRun`(2973)/`shouldFallBackHere`(2698)/`settleJob`(2562) 是 agentic 通道的生产调用方；`agenticMaxSteps` 配置在 `index.js:2399`，`shouldFallBackFromAgentic` 退回判定在 `index.js:1390`。
- [[article-contract]] —— 写集闸门 `makeWriteSet`/`isWritable`（article-contract.js:365/365）约束 agentic 通道能写哪些文件；`fixAnchors`(169) 的行号锚点修正亦来自该模块。
- [[engine-pipeline]] —— 原生引擎通道（阶段 4，native-run.js）是与 agentic 通道并列的第三条写作/编译路径，终态裁决更严格。
- [[single-round-runs]] —— `runRealtimeTasks` 单轮整包装填旧通道，是 agentic 失败退回的目标通道。

## Known Issues

- **步数用尽**：真实模型 + 45 步实测会出现循环读同一大文件（index.js 被读 13 次），`stopReason='max-steps'` 而文章没写完。因此 `makeReadCodeTool` 加了去重记账(115)，重复读只回「你已在第 N 步读过」不再回吐正文(129)。
- **CRLF 匹配**：真实仓库 `core.autocrlf=true`，`.codewiki` 下多篇文章是 CRLF。模型按 `view` 的 `\n` 输出写 `old_str` 会永远匹配不上，`str_replace` 会反复重试——故 `makeArticleEditor` 匹配前统一行尾(216–228)，命中后按原文风格写回，避免悄悄把全文件改 LF。
- **子模块死链（历史坑）**：旧 `generate_sub_module` 实现无论能否派发都回「已记录/已派发」，模型据此在父文写「详见 xxx.md」而文件从未生成。`buildToolset`(285–313) 现在区分 `max-depth` 与 `unsupported`，分别给模型能据以行动的指示（直接写成本文小节），见 `test-agentic.mjs:401`。
- **子模块深度封顶**：旧实现 `dispatchSub` 原样下传导致 `_depth >= subDepth` 恒不成立、模型可无限递归（subDepth=2 实测堆溢出）。现递归时把 `onSubModule` 传 `null`、`subModuleBlocked` 按 `_depth+1` 重算(117–118)，子层自重建深度，见 `test-articles-agentic.mjs:238/201`。
- **大档/默认档两池限流**：agentic 通道原本是单池，绕过 0.12.2 起的大档/默认档分池限流；`runAgenticArticles`(245–255) 补上双池，`bigConcurrency=0`/未传时回落 `concurrency`(251)。
- **坏 JSON 参数**：模型常把 JSON 包在 ```` ```json ```` 围栏或前后加解释句。`parseToolArgs`(476) 用「原样→剥围栏→截平衡对象」三级递进，坏参数记 `steps.warning` 回灌让模型自改(498)，而非直接中断。
- **行号锚点**：`read_code` 严格按 `numberLines` 的 `行号| ` 前缀(101)标注，模型引用行号一律以前缀为准，禁止自行数行（见 `test-agentic.mjs:76`）。
