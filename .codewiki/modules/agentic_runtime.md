---
title: agentic_runtime
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
tags: [agentic, article-generation, tools, orchestration]
---

## Overview

`agentic_runtime` 是 dsh-codewiki 的「智能体文章写作」第二条执行通道（与 `index.js` 内 `runRealtimeTasks` 的单轮整包装填通道并列）。它吸收自 FSoft-AI4Code/CodeWiki 的 module agent：模型不再一次性把源码塞进 prompt 求一篇文章，而是被赋予一个可反复读源码、可对文章做精确编辑、可把大模块拆给子任务的工具工作台——行号/签名这类硬事实可以现场核对，而不是靠一次性读进上下文后猜。

本模块由四个文件协作完成：

- `lib/agentic.js`：纯逻辑核心。工具循环 `runAgenticArticle`、四个工具实现（`read_code` / `list_files` / `edit_article` / `generate_sub_module`）、工具 schema `TOOL_SCHEMAS`、提示词 `buildOpeningPrompt`、坏 JSON 解析 `parseToolArgs`/`stripJsonFence`/`sliceBalancedObject`，以及行号前缀 `numberLines`。**不绑定任何宿主 llm 服务，测试可完全离线**（见 `test-agentic.mjs`）。
- `lib/agentic-host.js`：纯逻辑与宿主 llm 服务（`@deepseek-ai/dsh-llm`）之间的适配层。`toRequestMessages` 把循环里的裸消息转成宿主正式 `Message` 并展开多 tool 结果；`makeHostStream` 把 `llm.stream` 的 chunk 流用 `BlockAssembler` 收成 `blocks`；`makeFsWorkspace` 把仓库抽象成 `readFile`/`listDir`。
- `lib/articles-agentic.js`：执行器。把「模块任务清单」跑成文章——`runOneArticle`（单篇，含子模块递归派发）、`runAgenticArticles`（并发池，双池分大档/默认档）、`markBigAgenticTasks`/`sourceTokensOf`/`resolveTaskRoute`（选档与体量估算）。
- `lib/article-contract.js`：写集闸门 `makeWriteSet`/`isWritable`（被 `articles-agentic.js` 用来限定每个任务能落盘的路径）。

宿主接线在 `index.js` 的编译阶段机里：`tickArticles`（`index.js:2879`）在 `agenticArticles` 配置开启且任务非空时进入 agentic 通道，经 `markBigAgenticTasks` 打大档标记后调 `startAgenticRun`（`index.js:2676`），后者调 `runAgenticArticles`；执行结果进 `batchResults`，由 `settleJob` 收割；失败率过半时 `shouldFallBackHere`（`index.js:2585`）触发退回单轮通道重跑一次。两个核心配置：`agenticArticles`（默认 `true`，`Config` 见 `index.js:70`）与 `agenticMaxSteps`（默认 `30`，`index.js:88`，硬顶 100）。注意 `DEFAULT_MAX_STEPS = 30` 的唯一定义点在 `lib/agentic.js:323`，`index.js` 的默认值必须与之保持一致（历史上两处各写 24/30 导致同一配置两种行为）。

## Key Components

### lib/agentic.js — tool loop, tools, and orchestration logic

`lib/agentic.js` 是纯逻辑核心，不依赖宿主 llm 服务，全部通过注入的 `streamFn` / `workspace` 抽象访问外部世界，便于离线测试。

**工具 Schema（数组导出）**

- `TOOL_SCHEMAS`（第 27–87 行）：四个工具 `read_code`、`list_files`、`edit_article`、`generate_sub_module` 的 JSON Schema 定义（对应宿主 `ToolSchema`）。每个 schema 的 `description` 直接复用实际提示词里的要求（如 `read_code` 的「引用的行号以返回的『行号| 』前缀为准，禁止自行推算」，见第 31–32 行），保证模型看到的工具说明与硬约束一致。

**常量**

- `MAX_READ_LINES = 2000`（第 93 行）：单次 `read_code` 返回行数上限。
- `MAX_READ_CHARS = 40000`（第 96 行）：单次 `read_code` 返回字符上限（约 11k token）。只限行数挡不住压缩产物/单行超长文件——实测单行 20 万字符文件一次回吐 5.7 万 token，故加字符上限。
- `IGNORED_DIRS`（第 98 行）：`list_files` 一律不列出的目录（`node_modules`、`.git`、`dist`、`build`、`.next`、`target`、`vendor`、`__pycache__`、`.venv`、`venv`）。模型看到会把它们当源码探索，白烧步数。
- `DEFAULT_MAX_STEPS = 30`（第 325 行）：单篇 agentic 写作默认步数上限（工具调用轮次）。**全仓唯一定义点**，`articles-agentic.js` 从这里再导出，`index.js` 的 `agenticMaxSteps` 默认值（第 88 行）也必须与之一致。

**工具实现（全部纯函数式，靠 `workspace` 抽象访问真实仓库）**

- `numberLines(text)`（第 101–106 行）：给每行加 `N| ` grep 风格前缀，供模型据此引用行号。
- `makeReadCodeTool(workspace, { seen, getStep })`（第 115–177 行）：`read_code` 工具。去重记账由 `seen`（`Map`）持有；同一 `(path, 起始行, 结束行)` 再读只回「你已在第 N 步读过这段」（N 由 `getStep()` 取），省下模型自己的上下文（实测模型反复读同一大文件、累计上下文 2.1MB、步数耗尽未写完）。越界路径、`path` 缺失、行号超长、读盘失败均返回 `{ isError:true, ... }`。行数超出 `MAX_READ_LINES` 截前 N 行并提示、字符超出 `MAX_READ_CHARS` 截断并提示（第 154–170 行）。
- `makeListFilesTool(workspace)`（第 179–197 行）：`list_files` 工具。越界路径拒绝；深度 `depth` 夹在 `[1,4]`（第 183 行）；按 `IGNORED_DIRS` 过滤（第 191 行），并报告隐藏了几个依赖/版本控制目录（第 194 行）。
- `makeArticleEditor(initial)`（第 200–263 行）：文章编辑工具。状态闭包在 `article` 变量里，返回 `{ edit, article }`，`article` 是 getter/setter（第 260–262 行）。`edit` 支持三种 `command`：
  - `view`：返回带行号全文（空文章报「当前为空」）（第 204–207 行）。
  - `str_replace`：行尾归一化（CRLF 兼容，统一按 `\n` 匹配再按原风格写回，避免悄悄把整文件改成 LF，见第 212–228 行）；`old_str` 缺失/未命中/多处命中分别报错（第 209–226 行），命中后返回新长度。
  - `insert`：负数行号报错而非静默插到最前（第 235–237 行）；`line=0` 插到最前，否则插到第 `line` 行之后（第 249–253 行）；空文章 `split` 出来是 `['']`，当零行处理避免多余空行（第 244–245 行）。
- `safeRelPath(rel)`（第 266–273 行）：路径越界防护，拒绝 `/` 开头、`C:/` 绝对路径及任何 `../` 跳出去的路径，返回规范化 POSIX 相对路径或 `null`。

**工具调度表**

- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（第 279–315 行）：返回 `{ read_code, list_files, edit_article, generate_sub_module }`。`generate_sub_module` 的实现：缺 `module_name` 报错；`onSubModule` 为 `null` 时**必须说实话**——区分 `subModuleBlocked === 'max-depth'`（已到嵌套上限）与其它原因（不支持递归），分别给出模型能据以行动的指示（第 290–306 行），旧实现一律回「已记录/已派发」会让模型写下指向不存在文件的死链且父任务仍记 ok。

**循环本体**

- `runAgenticArticle(opts)`（第 331–432 行）：单篇 agentic 写作主循环。参数 `opts`：`mission`、`streamFn`、`workspace`、`tools`（额外工具）、`editor`、`onSubModule`、`subModuleBlocked`、`maxSteps`（默认 `DEFAULT_MAX_STEPS`）、`signal`、`initialMessages`、`systemPrompt`、`articleFormat`。
  - `streamFn` 非函数直接抛错（第 347 行）。
  - 用 `buildToolset` + extraTools 合并成工具表，`TOOL_SCHEMAS` 过滤出实际可用的声明给模型（没有 workspace 就不声明 `read_code` 等，第 354 行）。
  - 循环最多 `maxSteps` 轮（第 367 行）：每轮调 `streamFn` 拿回 assistant blocks（用 `try/catch` 把 stream 错误收敛为 `stopReason: 'stream-error'`，第 372–379 行）；blocks 空则 `empty-response`（第 380 行）；把 assistant 消息原样进历史（含它自己发出的 `tool-call`，否则下一轮对不上 callId，第 383 行）；无工具调用 = 模型认为写完，若 `editor` 还空且给了正文则收下正文（第 389–395 行）；有调用则逐条执行、结果作为 `tool-result` 消息回灌（第 397–422 行）。
  - `stopReason` 取值：`finished` / `max-steps` / `empty-response` / `stream-error` / `aborted`（signal 中止，第 369 行）；返回 `{ article, steps, usedTools, stopReason, messages }`（第 425–432 行）。

**坏 JSON 解析（三级递进）**

- `stripJsonFence(s)`（第 439–444 行）：剥 ```` ```json ```` 围栏。
- `sliceBalancedObject(s)`（第 447–473 行）：从任意位置截出第一个括号平衡的 JSON 对象（跳过字符串字面量里的括号）。
- `parseToolArgs(raw, steps, step, toolName)`（第 476–500 行）：按「原样 → 剥围栏 → 截首个平衡对象」三级递进解析；对象直达、`{}` 给空对象、坏 JSON 记 `warning` 并给 `{}`（不中断，让模型自己改，第 498 行）；非对象 JSON（array/标量）记 warning。

**开场提示词**

- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（第 506–541 行）：拼出给模型的首条 user 消息。含任务、工具清单、工作方式 6 步、硬要求、文章格式（若 `articleFormat` 非空）。schema 里含 `generate_sub_module` 时才附「拆分」小节（第 508、525–533 行）。

### lib/agentic-host.js — host llm adapter

`lib/agentic-host.js` 是纯逻辑（裸消息/`blocks`）与宿主 llm 服务（`@deepseek-ai/dsh-llm`）之间的适配层，只做三件事：裸消息 → 正式 `Message`、一条 tool 消息的多结果展开成多条、chunk 流收成 `blocks`。

**常量**

- `SOURCE = { kind: 'plugin:codewiki' }`（第 15 行）：所有经本层构造的消息来源标记。

**身份稳定缓存**

- `IDENTITY = new WeakMap()`（第 26 行）：裸消息对象 → 已构造好的正式消息。宿主 d.ts 要求 `MessageId` 跨每个表示边界保持稳定（`message.d.ts:126`）；循环每轮都会把同一份 messages 重新丢进 `toRequestMessages`，若每次都重新 `createUserMessage` 会每步换新 UUID——用 `WeakMap` 以裸消息对象为键，天然跟随循环消息生命周期，循环结束回收即释放（第 17–26 行）。

**裸消息 → 宿主 RequestMessage[]**

- `toRequestMessages(messages, { provider, model })`（第 34–79 行）：
  - `user`：缓存优先，无则 `createUserMessage`，存入 `IDENTITY`（第 39–45 行）。
  - `assistant`：已带 `id` 的正式消息透传不重造（第 47–48 行）；否则 `createAssistantMessage`，`source` 带 `provider`/`model`（第 49–57 行）。
  - `tool`：循环里一条 tool 消息装多条结果 → 宿主每条结果一条消息，按 `r.toolCallId` 用 `createToolResultMessage` 展开（第 58–75 行）；`stableKeyFor` 给 tool 角色带结果序号做缓存键（第 29–31 行）。
  - 未知 role 忽略（第 61–76 行）。

**streamFn 构造**

- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（第 83–108 行）：缺 `llm.stream` 直接抛「需要宿主 llm 服务」（第 84 行）。返回 `(params) => { blocks, finish, usage }`：用 `BlockAssembler` 收 chunk 流（`new BlockAssembler()`，第 86 行），把裸 `messages` 经 `toRequestMessages` 转换后调 `llm.stream`，`temperature: 0`（第 94 行），有 `tools` 时带 `tools`（只传 `name`/`description`/`parameters`，第 93 行），`reasoningEffort` 非空才带（第 91 行）；`finish.kind` 为 `error`/`aborted` 时抛错（第 101–103 行）；`onDelta`/`onFinish` 回调失败不影响写作（第 98、105 行）。

**仓库 workspace 抽象**

- `makeFsWorkspace(fs, path, cwd)`（第 111–135 行）：`rootAbs = path.resolve(cwd)`；`absOf(rel)` 把相对路径解析成绝对路径并校验仍落在 `rootAbs` 内（含 `safeRelPath` 与真实路径双重兜底，第 113–118 行）。返回：
  - `readFile(rel)`：越界抛「越界路径」，否则 `fs.readFileSync(abs, 'utf8')`（第 120–124 行）。
  - `listDir(rel)`：越界抛错，否则 `fs.readdirSync(abs, { withFileTypes: true })`，把每个条目映射成 `{ path, dir }`（子目录路径拼完整相对路径，第 125–133 行）。

### lib/articles-agentic.js — article executor, pooling, sub-module dispatch

`lib/articles-agentic.js` 把「模块任务清单」跑成文章。`runOneArticle` 是单篇入口（含子模块递归派发），`runAgenticArticles` 是并发池入口（双池：大档/默认档），`markBigAgenticTasks`/`sourceTokensOf`/`resolveTaskRoute` 是选档与体量估算的纯函数。与单轮通道失败语义一致：单任务失败只记账、不影响其它任务，返回 `Map(customId → 结果)`。

**再导出**

- `export { DEFAULT_MAX_STEPS }`（第 21 行）：从 `lib/agentic.js` 再导出，保持既有导入路径可用，避免又冒出一份独立常量。

**单篇执行 + 子模块递归派发**

- `runOneArticle(task, { llm, provider, model, reasoningEffort, language, cwd, fsImpl, pathImpl, articleFormat, systemPrompt, maxSteps, signal, onDelta, onSubModule, subModuleBlocked, writeArticle, fixAnchors, allowedWritePaths, streamFn: injectedStreamFn, subDepth=2, _depth=0, _takenNames })`（第 33–179 行）：
  - `mission` 取 `task.mission` 或默认文案（第 57 行）；若 `task.prevArticlePath` 存在则读旧文作 `editor` 初始内容（增量改而非重写，第 59–63 行）。
  - `workspace = makeFsWorkspace(...)`（第 64 行）；`writeSet = allowedWritePaths === undefined ? null : (makeWriteSet(...) ?? new Set())`——未设限时保持旧行为不设限，传 `null`/`[]` 视为「谁都不许写」（第 67 行，FSoft write-set 吸收）。
  - `streamFn = injectedStreamFn ?? makeHostStream(...)`（第 69 行）。
  - 子模块名全局唯一（`slugOf` + `_takenNames` 共享，重名加父前缀、再重则跳过，对应上游 issue #76/#113，第 71–94 行）；`parentSlug` 取文章文件名（第 77 行）。
  - 深度封顶：`atMaxDepth = _depth >= subDepth`，到顶则 `dispatchSub = null`，并用 `subModuleBlocked='max-depth'` 让工具层说实话（第 79–84 行）；`dispatchSub`（第 85–128 行）就地递归调 `runOneArticle` 写子模块文章，路径为 `modules/<父 slug>/<子 slug>.md`（第 96 行），递归时把 `onSubModule` 传 `null`、`_depth+1`、`subModuleBlocked` 重算（`(_depth+1) >= subDepth ? 'max-depth' : null`），并把写集限制为该子模块自己的路径（第 110–121 行）。
  - 调用 `runAgenticArticle`（第 130–142 行）；空文章兜底判失败（`empty-article`，第 146–149 行）。
  - 落盘：`writeArticle && task.articlePath` 时先过写集闸门 `isWritable`，越界返回 `ok:false, stopReason:'write-set'`（第 151–167 行）；`fixAnchors` 可选修正行号锚点（第 168–174 行）；`mkdirSync` + `writeFileSync`（第 175–176 行）。最终返回 `{ ...out, subModules, ok:true }`（第 178 行）。

**体量估算与选档（纯函数）**

- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（第 185–203 行）：按 CJK 1 token、非 CJK 3.5 字符/token 估源文本 token（与 `index.js` `estimateTokens` 同口径），供 `markBigAgenticTasks` 当判据；读不到的文件按 0 计不阻断。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（第 208–222 行）：任务自带 `provider`+`model` 时完全以任务为准（effort 也以任务为准，空 = 模型默认档，绝不回落默认档 effort），否则全用参数默认档（半套只写 provider 不算自带）。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（第 320–333 行）：按源文本量超 `bigTier.budget` 的模块打大档标记 `{ provider, model, bigTier:true, reasoningEffort? }`。agentic 通道不装填源码（模型自己读），故用「源文本量超预算」作等价判据；`bigTier` 无 provider 或 `budget=0` 时原样返回。纯函数，不改原对象。

**并发池（双池）**

- `runAgenticArticles(tasks, { concurrency=2, bigConcurrency=0, notes, signal, onTaskDone, onRequestStart, ...rest })`（第 231–312 行）：与 `runRealtimeTasks` 同形状，但每个任务跑 agentic 循环。`bigTier === true` 的任务走大档池（`bigConcurrency`，为 0/未传回落 `concurrency`），其余走默认档池（`concurrency`），两池各自独立限流、同时推进（第 244–255 行）。`runPool` 内 `worker` 循环取任务、调 `resolveTaskRoute` 选档、调 `runOneArticle`、结果进 `results` `Map` 且单任务失败不向外炸（被捕获后记 `ok:false`，第 300–304 行）；派生子模块记 `notes`（第 281–283 行）。

### lib/article-contract.js — write-set gate (consumed by agentic)

`lib/article-contract.js` 是文章契约闸门（frontmatter/章节/链接/围栏校验），其写集相关函数被 agentic 通道用来限定每个任务能落盘的路径。其余校验函数（`inspectArticle`、`parseFrontmatter` 等）供落盘闸门使用，本文仅列 agentic 直接消费的部分：

- `makeWriteSet(paths)`（第 352–355 行）：返回 `null` 表示调用方没设限（不检查）；传入数组则编译成规范化 POSIX 路径 `Set`。
- `normalizeWritePath(p)`（第 357–361 行）：把路径规整为 `/` 分隔、去两端空白的 POSIX 路径，空串返回 `null`。
- `isWritable(target, writeSet, { cwd })`（第 365–378 行）：写集为 `null` 直接放行；否则按规范化 POSIX 路径比对，或相对 cwd 解析后比对——防止 `../` 越界写到别的仓库（第 370–376 行）。

### index.js — orchestration wiring

### index.js — orchestration wiring

`index.js` 把 agentic 通道接入编译阶段机的 `articles` 阶段。`runRealtimeTasks` 是单轮通道；agentic 通道与之并列，由 `tickArticles` → `startAgenticRun` → `runAgenticArticles` 串起，结果进 `batchResults` 由 `settleJob` 收割。

**配置（`Config`，第 70–96 行）**

- `agenticArticles`（第 87 行）：默认 `true`。开启则文章写作走 agentic 工具循环，关闭走单轮整包装填。
- `agenticMaxSteps`（第 88 行）：默认 `30`，硬顶 100。`liveConfig` 中取值（第 133–136 行）与 `lib/agentic.js:323` 的 `DEFAULT_MAX_STEPS` 必须一致。

**阶段机入口**

- `tickArticles(job)`（第 2879 行起）：若 `batchRef` 有值则先收割（含 agentic 退回分支，` shouldFallBackHere`，见下）。否则组装模块任务：当 `c0.agenticArticles && tasks.length`（第 3017 行）时，经 `markBigAgenticTasks` 打大档标记（第 3021–3032 行，用 `sourceTokensOf` 估体量），把任务标 `agentic:true`（第 3033–3038 行），调 `startAgenticRun`（第 3042 行）后 `return`——不进入单轮 `prepareArticleTasks` 分支。

**agentic 执行器**

- `startAgenticRun(job, tasks)`（第 2676–2726 行）：与 `startBatchChatRun` 并列的第二条通道。调 `runAgenticArticles(tasks, { ... })`，传入 `llm: llmRef`、`provider/model/reasoningEffort`、`concurrency`、`bigConcurrency`、`cwd`、`language`、`articleFormat: articleFormatSection()`（第 2691 行，格式条款含章节骨架与硬约束）、`maxSteps: c.agenticMaxSteps`、`fixAnchors`、`allowedWritePaths: tasks.filter(t=>t.articlePath).map(t=>t.articlePath)`（第 2696 行，写集闸门）、`signal`、`onRequestStart`/`onTaskDone`。结果进 `batchResults`，由 `settleJob` 统一收割；与单轮通道的区别是任务里没有 `batchPrompt`，所以 `settleJob` 的「执行器丢失重跑」分支要认 `agentic` 标记。

**退回判定**

- `shouldFallBackHere(job, results, tasks)`（第 2585–2592 行）：仅在「本批过半失败」且「本 job 还没退回过（`job.agenticRetried` 为假）」时返回 true。`isAgentic = (r) => agenticList.some(t => t.name === r.name)`（第 2590 行），只对本批里 `t.agentic === true` 的任务算失败率。
- `shouldFallBackFromAgentic(results)`（第 1293–1298 行，模块级导出便于单测）：`relevant` 空返回 false；失败数 `* 2 > 长度`（严格过半）才触发退回。
- 退回分支在 `tickArticles`（第 2944–2979 行）：只重排失败篇（`failedNames`），已写成功的文章不再重写；重排出的重试任务含 `mission`/`articlePath`，经 `prepareArticleTasks` 装填成单轮请求（或会话通道），并置 `job.agenticRetried = true` 防止每 tick 重新提交成死循环。

**写集/落盘协同**

- `runOneArticle` 落盘时调 `isWritable`（经 `makeWriteSet`），越界返回 `write-set`，由 `index.js` 调用方（`startAgenticRun` 的 `allowedWritePaths`）统一约束每个任务的可写路径。
- 子模块递归时父任务写集不下传为 `undefined`：父任务的 `allowedWritePaths` 只含父文路径，子任务拿到的写集只有它自己那条路径（第 110–121 行），子层越界写父文会被 `isWritable` 拒掉并记账。

## Architecture

组件 ≥3 且流程非平凡，框图如下（agentic 单篇写作闭环；编排与落盘在外层）：

```text
                 compile job (index.js tickArticles)
                          │  agenticArticles=true
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │ startAgenticRun ── runAgenticArticles (双池: 大档/默认档)   │
   │   allowedWritePaths = [各任务 articlePath]                 │
   └───────────────┬──────────────────────────────────────────┘
                   │ per task
                   ▼
   ┌──────────────────────────────────────────────────────────┐
   │ runOneArticle                                              │
   │  makeFsWorkspace ──► workspace {readFile, listDir}         │
   │  makeArticleEditor ──► article (闭包)                      │
   │  makeHostStream ──► streamFn (llm.stream + BlockAssembler)  │
   │  dispatchSub ──► 子模块递归 runOneArticle (深度≤subDepth)   │
   └───────┬───────────────────────────┬───────────────┬──────┘
           │ call                        │ read/write    │ sub-module
           ▼                             ▼               ▼
   ┌───────────────┐           ┌─────────────────┐  ┌─────────────────┐
   │ runAgenticArticle          │ makeReadCodeTool │  │ generate_sub_module │
   │  (工具循环 ≤30步)          │ makeListFilesTool│  │ → onSubModule    │
   │  buildToolset              │ makeArticleEditor│  └─────────────────┘
   │  buildOpeningPrompt        │ safeRelPath      │
   └───────┬───────────────────┴─────────────────┘
           │ tool-result 回灌 + 无调用则 finished
           ▼
   ┌──────────────────────────────────────────────────────────┐
   │ 落盘门: isWritable(writeSet) → fixAnchors → writeFileSync    │
   └──────────────────────────────────────────────────────────┘

   宿主适配层 agentic-host.js:
   agentic 裸消息 ──toRequestMessages──► 宿主 Message (+tool 一拆多)
   llm.stream chunks ──makeHostStream──► BlockAssembler ──► blocks
```

`lib/agentic.js` 与 `lib/agentic-host.js` 分工明确：`agentic.js` 是纯逻辑（只认 `{role,content}` blocks、不绑 pydantic-ai、不绑宿主 llm）；`agentic-host.js` 负责把裸消息转成带 `id`+`source` 的正式 `Message`、把一条多结果 tool 消息展开成多条、把 chunk 流收成 blocks。`articles-agentic.js` 是执行器（建 workspace/editor/stream、派发子模块、落盘），`article-contract.js` 仅在写集闸门处被消费。

## Data Flow

单篇写作闭环（`runAgenticArticle`）的步级数据流：

1. **初始化**：`runOneArticle` 构造 `workspace`（`makeFsWorkspace`）、`editor`（`makeArticleEditor`，带 `prevArticlePath` 旧文作初始内容）、`streamFn`（`makeHostStream` 或测试注入）、`onSubModule`（`dispatchSub` 闭包）、`subModuleBlocked`。`runAgenticArticle` 合并 `buildToolset` 与额外工具，按 `TOOL_SCHEMAS` 过滤出可用声明，首条消息用 `buildOpeningPrompt` 生成（含任务、工具清单、6 步工作方式、硬要求、文章格式）。

2. **每步**：调 `streamFn({ messages, tools, signal })` → 拿回 assistant `blocks`（`BlockAssembler.blocks()`）。blocks 空 → `stopReason='empty-response'` 退出；有 `tool-call` → 执行，无 → 模型认为写完（`finished`，空 editor 时收下正文）。

3. **工具调用执行**：对每条 `tool-call`：用 `parseToolArgs`（三级递进：原样→剥围栏→截平衡对象）解析参数；按 `tools[name]` 找到实现并 `await`；抛错/未知工具都包成 `{ isError, text }` 结果。结果作为 `tool-result` 消息（每个 callId 一条）push 进 `messages`，并记入 `steps`/`usedTools`。

4. **重复读抑制**：`makeReadCodeTool` 用 `seen` Map 记账 `(path,start,end)`，同一段再读只回「你已在第 N 步读过」（N 来自 `getStep()`），不再碰文件系统，省下模型自身上下文。

5. **子模块派发**：模型调 `generate_sub_module` → `onSubModule`（即 `dispatchSub`）递归调 `runOneArticle` 写子文章（路径 `modules/<父 slug>/<子 slug>.md`），写集只含子模块自身路径；父文章里只留指向子文章的链接。深度到顶（`_depth >= subDepth`）时 `dispatchSub=null` 且 `subModuleBlocked='max-depth'`，工具层据实报告而非谎称已成文。

6. **落盘**：`runAgenticArticle` 返回 `{ article, steps, usedTools, stopReason, messages }`。`runOneArticle` 校验非空（空则 `empty-article` 失败），过写集闸门 `isWritable`（`allowedWritePaths` 越界返回 `write-set`），可选 `fixAnchors` 修正行号锚点，最后 `fs.writeFileSync` 落盘。

7. **编排收割**：`startAgenticRun` 把每篇结果收进 `batchResults`；`tickArticles`/`settleJob` 收割。失败率过半且 `!job.agenticRetried` → `shouldFallBackHere` 触发，只重排失败篇经 `prepareArticleTasks` 走单轮通道重跑一次。

## Connections

## Known Issues
