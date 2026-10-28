---
title: agentic_core
type: module
source_files:
  - index.js
  - lib/agentic.js
  - lib/articles-agentic.js
  - lib/agentic-host.js
  - lib/article-contract.js
  - test-agentic.mjs
  - test-articles-agentic.mjs
  - test-agentic-host.mjs
  - test-agentic-fallback.mjs
tags: [agentic, article-generation, tool-loop, llm, wiki]
---

## Overview

`agentic_core` 是 dsh-codewiki 里第二条文章生成通道（"agentic 通道"）的内核，吸收自 FSoft-AI4Code/CodeWiki 的 module agent 思路：不再把源码整包塞进一次 prompt 求一篇文章，而是给模型一个可反复读代码、可对文章做精确编辑、可把大模块拆给子任务的工作台。

它由三个源文件构成，职责边界清晰：

- `lib/agentic.js` —— 纯逻辑层。定义四个工具（read_code / list_files / edit_article / generate_sub_module）的 JSON Schema、工具实现、工具循环 `runAgenticArticle`，以及开场提示词 `buildOpeningPrompt`。完全不依赖宿主 llm 服务，测试可离线跑（用注入的假 `streamFn` 模拟模型）。
- `lib/articles-agentic.js` —— 执行器层。把"模块任务清单"跑成文章：`runOneArticle` 跑单篇并落盘（含子模块递归派发与写集闸门），`runAgenticArticles` 用双池并发跑整批任务，`markBigAgenticTasks` / `sourceTokensOf` / `resolveTaskRoute` 负责选档与打大档标记。
- `lib/agentic-host.js` —— 适配层。把 `lib/agentic.js` 的裸消息/block 适配到宿主 `@deepseek-ai/dsh-llm` 的正式 Message 与流（`toRequestMessages` / `makeHostStream`），并暴露文件系统 workspace 抽象 `makeFsWorkspace`。

与之配合的契约闸门在 `lib/article-contract.js`（`makeWriteSet` / `isWritable` / `inspectArticle`），本模块的"写集"限制直接复用它。

上游价值主张与本模块差异（见 `lib/agentic.js:1` 注释）：工具循环写成纯逻辑 + 注入 `streamFn`/工具实现，不绑死 pydantic-ai，也不绑死宿主的 llm 服务；agentic 工具读写的是 `{readFile, listDir}` 抽象（见 `lib/agentic-host.js:81` 的 `makeFsWorkspace`），便于在插件里接到任何 cwd。

## Key Components

### lib/agentic.js

公开导出：`TOOL_SCHEMAS`（27）、`numberLines`（101）、`makeReadCodeTool`（115）、`makeListFilesTool`（179）、`makeArticleEditor`（200）、`safeRelPath`（266）、`buildToolset`（279）、`DEFAULT_MAX_STEPS`（325）、`runAgenticArticle`（331）、`stripJsonFence`（439）、`sliceBalancedObject`（447）、`parseToolArgs`（476）、`buildOpeningPrompt`（506）。

常量：

- `MAX_READ_LINES = 2000`（93）—— 单次 read_code 行数上限。
- `MAX_READ_CHARS = 40000`（96）—— 单次 read_code 字符上限（≈11k token），防御单行超长文件（如压缩产物）一次回吐数万 token。
- `IGNORED_DIRS`（98）—— list_files 一律不列出的目录：`node_modules, .git, dist, build, .next, target, vendor, __pycache__, .venv, venv`。
- `DEFAULT_MAX_STEPS = 30`（325）—— 单篇 agentic 写作步数上限（工具调用轮次）。注释明确指出唯一定义点在此，index.js 的 `agenticMaxSteps` 默认值必须与之一致（30），此前两处各写一个常量（24/30）造成同一配置两种行为。

`TOOL_SCHEMAS`（27–87）：四个工具的 JSON Schema 形态。每个工具名与参数对应宿主 `ToolSchema`：
- `read_code`（29）：参数 `path`（必填）、`start_line`、`end_line`。
- `list_files`（44）：参数 `path`、`depth`（默认 1）。
- `edit_article`（55）：参数 `command`（enum: view/str_replace/insert）、`old_str`、`new_str`、`line`、`text`。
- `generate_sub_module`（73）：参数 `module_name`、`components`、`description`。

`numberLines`（101–106）：给文本每行加 `行号| ` 前缀（`1| a\n2| b`）。工具层据此让模型引用真实行号。

`makeReadCodeTool(workspace, { seen, getStep })`（115–177）：构造 read_code 实现。要点：
- `safeRelPath`（120）先做越界防护，越界返回 isError（121）。
- 重复读抑制（108–135）：同一 `(path, 起始行, 结束行)` 再读不再回吐正文，只回"你已经在第 N 步读过这段"。去重记账发生在读盘之前（123），`seen` key 同时记下原始 key 与"夹取后等价 key"（149–152），使"不带 end_line 与显式写满全文"视为同一段。
- 行范围夹取（143–147）：超文件长度报错 `超出文件长度`。
- 行数上限 `MAX_READ_LINES`（156）与字符上限 `MAX_READ_CHARS`（164）双重截断，截断时在返回里附带说明（168–170）。

`makeListFilesTool(workspace)`（179–197）：构造 list_files 实现。depth 夹到 [1,4]（183）；`IGNORED_DIRS` 过滤（191）；隐藏目录时附带"（已隐藏 N 个依赖/版本控制目录）"说明（194）。

`makeArticleEditor(initial = '')`（200–263）：文章状态闭包，返回 `{ edit, get article, set article }`。`edit`（202）处理三种命令：
- `view`（204）：空文章回"（文章当前为空）"，否则 `numberLines(article)`。
- `str_replace`（208）：CRLF 归一化（216–228）——因 `.codewiki` 下 28/36 篇是 CRLF（`core.autocrlf=true`），匹配前统一成 `\n`，命中后按原文风格写回，避免悄悄把整个文件改成 LF。old_str 唯一性校验（223–226），不唯一则报错且不动文章。
- `insert`（231）：负数行号必须报错（235），不能静默插到最前；`line=0` 插到最前，否则插到第 line 行之后；CRLF 同样归一化（242–253）。

`safeRelPath(rel)`（266–273）：拒绝 `/` 开头、Windows 盘符、`..` 以及包含 `/../` 的路径。

`buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（279–315）：把所有工具装配成对象 `{read_code, list_files, edit_article, generate_sub_module}`。`generate_sub_module` 实现（285–313）区分两种失败原因并诚实报错：若 `onSubModule` 不存在，按 `subModuleBlocked` 值返回——`'max-depth'` 回"已经到达子模块嵌套上限"并提示把该部分当普通小节写（294–299），否则回"当前模式不支持递归成文"（301–305）。**禁止**像旧实现那样谎称"已记录子模块 X（已派发）"，否则父文会写下指向不存在文件的死链且 `ok:true`（290–306）。

`runAgenticArticle(opts)`（331–432）：循环本体。参数：`mission, streamFn, workspace, tools?, editor?, onSubModule?, subModuleBlocked?, maxSteps=DEFAULT_MAX_STEPS, signal?, initialMessages?, systemPrompt?, articleFormat?`。`streamFn` 缺失直接抛错（347）。`editor` 缺省自建（348）。`stepRef.current` 供 read_code 报真实步号（350）。只把实际可用的工具声明给模型（`TOOL_SCHEMAS.filter`，354）；`messages` 以 `buildOpeningPrompt` 开场（356–361）。
循环（367–423）：每步调 `streamFn({messages, tools, signal})`（373），取 `blocks`；模型消息原样进历史（含自己发出的 tool-call，383）；执行工具调用并作为 `tool` 消息回灌（385–422）。停止条件与 `stopReason`：

| 情况 | stopReason |
| --- | --- |
| 信号 abort | `aborted`（369） |
| streamFn 抛错 | `stream-error`（377） |
| 空响应 blocks | `empty-response`（380） |
| 无工具调用（模型认为写完） | `finished`；若 editor 空但正文像文章则收下正文（389–395） |
| 循环跑满 maxSteps | `max-steps`（365，默认） |

返回 `{ article, steps, usedTools, stopReason, messages }`（425–431）。`usedTools` 是 Set（364）。

`stripJsonFence(s)`（439–444）：剥 ```json 围栏（三级递进第一步）。`sliceBalancedObject(s)`（447–473）：从任意位置截出第一个括号平衡的 JSON 对象，跳过字符串字面量里的括号。`parseToolArgs(raw, steps, step, toolName)`（476–500）：依次尝试 原样→剥围栏→截平衡对象 三级解析（481–485）；坏 JSON 不中断，把警告 `工具 X 参数不是合法 JSON` 推入 `steps`（498）并回 `{}`，让模型自己改（475）。

`buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（506–541）：拼开场提示词。包含任务、可用工具列表、`工作方式`六步、`硬要求`（不许编造行号、用真实行号、不用 markdown 围栏包整篇）等。当 schema 含 `generate_sub_module` 时追加 `拆分（可选）`段落（525–533）。

### lib/articles-agentic.js

公开导出：`DEFAULT_MAX_STEPS`（再导出，21）、`runOneArticle`（33）、`sourceTokensOf`（185）、`resolveTaskRoute`（208）、`runAgenticArticles`（231）、`markBigAgenticTasks`（320），并 import `runAgenticArticle, makeArticleEditor`（15）、`makeHostStream, makeFsWorkspace`（16）、`makeWriteSet, isWritable`（17）。

`runOneArticle(task, opts)`（33–179）：单篇跑一次 agentic 循环并落盘。要点：
- `mission` 默认（57）；`prevArticlePath` 旧文作初始内容交给 editor 做增量改（60–63）。
- `workspace = makeFsWorkspace(fsImpl, pathImpl, cwd)`（64）；`writeSet`（67）—— `allowedWritePaths === undefined` 时保持旧行为不设限，传 `null/[]` 视为"谁都不许写"。
- 子模块名全局唯一（71–74）：同一次父任务共享 `_takenNames`，重名加父模块名前缀，仍重则跳过（89–93）。
- 深度封顶：`atMaxDepth = _depth >= subDepth`（82）；`subDepth` 默认 2（53）。`dispatchSub` 闭包（83–128）递归调 `runOneArticle` 写子模块，路径 `modules/<父 slug>/<子 slug>.md`（96）；子层 `onSubModule: null`（117）且 `subModuleBlocked` 按 `_depth+1 >= subDepth` 判定（118），**绝不能原样下传父层 dispatchSub**（否则子层永远用父层深度判定，封顶形同虚设、可无限往下拆，实测 subDepth=2 直接堆溢出）。
- `runAgenticArticle` 调用（130–142）后，空文章兜底判失败（146–149，`stopReason='empty-article'`）；写集越界落盘判失败（151–167，`stopReason='write-set'`）；`fixAnchors` 可选修正行号锚点（169–174）。返回 `{ ...out, subModules, ok }`（178）。

`sourceTokensOf(task, cwd, opts)`（185–203）：近似 token 数（CJK 按 1、其余按 3.5 字符/token，与 index.js `estimateTokens` 同口径），读不到的文件按 0 计不阻断。

`resolveTaskRoute(task, opts)`（208–222）：任务自带 `provider+model` 时完全以任务为准（大档任务，effort 也以任务为准，空=模型默认档，绝不回落默认档 effort），否则用参数默认档。

`runAgenticArticles(tasks, opts)`（231–312）：并发池，与 `runRealtimeTasks` 同形状返回 `Map(customId → 结果)`。双池（244–255）：`bigTier===true` 走大档池（`bigConcurrency`，0/未传回落 concurrency），其余走默认档池。每任务调 `resolveTaskRoute`（268）后 `runOneArticle`（269）；单任务失败只记账（300–303），不影响其它任务。结果项（284–291）含 `name, ok, stopReason, steps, tools, subModules`。

`markBigAgenticTasks(tasks, { bigTier, sizeOf })`（320–333）：根据模块源文本量打大档标记。agentic 通道不装填源码，故用"源文本量 > budget"替代单轮通道的"装填超预算"判据（314–319）。`bigTier` 无 provider 时原样返回（322–323）。为纯函数，不改原对象。

### lib/agentic-host.js

公开导出：`toRequestMessages`（34）、`makeHostStream`（83）、`makeFsWorkspace`（111）。import 自 `@deepseek-ai/dsh-llm`：`BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage`（11–13）。`SOURCE = { kind: 'plugin:codewiki' }`（15）。`IDENTITY` WeakMap（26）缓存裸消息→正式消息的稳定身份（26–31）。

`toRequestMessages(messages, { provider, model })`（34–79）：裸 `{role, content}` → 宿主 `RequestMessage[]`。user→`createUserMessage`（42）；assistant 有 id 透传（48），否则 `createAssistantMessage`（51，带 provider/model）；tool 一条消息装多条结果→展开成多条 `createToolResultMessage`（58–75，`toolCallId` + `source.callId`）。

`makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（83–108）：构造 `streamFn`。要求 `llm.stream` 是函数否则抛错（84）。用 `BlockAssembler` 收 chunk（86–107）；`temperature: 0`（94）；`finish.kind` 为 error/aborted 抛错（101–103）；返回 `{ blocks, finish, usage }`（104）。

`makeFsWorkspace(fs, path, cwd)`（111–135）：仓库 workspace 抽象，只认 `readFile`/`listDir`（110）。`absOf` 用真实路径二次兜越界（112–118）——`safeRelPath` 兜一层，这里再兜一层防止符号链接逃逸。`readFile`（120）越界抛"越界路径"。`listDir`（125）返回 `{ path, dir }`，子目录用完整相对路径（130）。

### lib/article-contract.js（被本模块复用）

本模块只用到写集相关导出：`makeWriteSet`（323）、`isWritable`（336），以及 `inspectArticle`/`hasBlockingIssue` 供落盘前契约校验（在 index.js 调用）。`makeWriteSet(paths)`（323–326）返回 `Set` 或 null（未传数组）；`normalizeWritePath`（328–332）做 POSIX 归一化；`isWritable(target, writeSet, {cwd})`（336–349）按规范化路径比对，相对路径以 cwd 解析后比对防 `../` 越界。

## Architecture

```text
任务清单(customId,name,articlePath,sources)
        │
        ▼
runAgenticArticles ──双池──▶ runOneArticle ──▶ runAgenticArticle
   (articles-agentic.js)        │                  │
        │                       │ 子模块递归派发      │ streamFn({messages,tools})
        │                       ▼ (dispatchSub)      │
        │                  runOneArticle(子)         ▼
        │                       │             makeHostStream(agentic-host.js)
        │                       │                  │ 裸消息→正式Message(toRequestMessages)
        │                       │                  │ BlockAssembler 收流
        │                       │                  ▼
        │                       │             llm.stream(@deepseek-ai/dsh-llm)
        │                       ▼
        │                writeSet 闸门(isWritable)
        │                       │
        ▼                       ▼
   落盘 modules/X.md / modules/X/sub.md
        │
        └─▶ 写集限制：能写哪些文件由调度器说了算
```

组件归属：`runAgenticArticles`/`runOneArticle`/`markBigAgenticTasks` → `lib/articles-agentic.js`；`runAgenticArticle`/`buildToolset`/四个工具 → `lib/agentic.js`；`makeHostStream`/`toRequestMessages`/`makeFsWorkspace` → `lib/agentic-host.js`；`makeWriteSet`/`isWritable` → `lib/article-contract.js`。

循环内部数据流：每步 `runAgenticArticle` 调 `streamFn` 拿 `blocks`；`tool-call` 类 block 交给 `buildToolset` 里的工具实现执行，结果作为 `{role:'tool', content:[tool-result...]}` 回灌 `messages`（见 `lib/agentic.js:356`–422）；无 tool-call 时判 `finished`。`stepRef.current` 让 read_code 在重复读时报告真实步号（350）。

## Data Flow

1. 入口调度（index.js `tickArticles`，见 `index.js:2879`）：当 `c0.agenticArticles && tasks.length` 时，用 `markBigAgenticTasks(tasks, { bigTier, sizeOf: (t)=>sourceTokensOf(t, job.cwd) })` 打大档标记，置 `agentic: true` 任务，调 `startAgenticRun(job, agenticTasks)`（`index.js:3042`）。
2. `startAgenticRun`（`index.js:2676`）调 `runAgenticArticles`，注入 `llm=llmRef`、`provider=c.batchProvider`、`model=c.batchModel`、`maxSteps=c.agenticMaxSteps`、`articleFormat`、`fixAnchors`、`allowedWritePaths`（父任务只列自己目标文章，`index.js:2696`）、`signal`、`onRequestStart/onTaskDone`（记账+进度）。结果进 `batchResults` 由 `settleJob` 统一收割。
3. `runAgenticArticles` 分双池（大档/默认档）并发，`runOneArticle` 每篇：建 `makeArticleEditor(prevArticle)`、`makeFsWorkspace`、`makeHostStream` 作为 `streamFn`、`dispatchSub` 闭包作为 `onSubModule`，再调 `runAgenticArticle`。
4. `runAgenticArticle` 循环：模型经 `streamFn` 读 `edit_article`/`read_code`/`list_files` 增量写作；`generate_sub_module` 触发 `dispatchSub` → 递归 `runOneArticle` 写 `modules/<父>/<子>.md`。
5. 落盘：`runOneArticle` 用 `isWritable(task.articlePath, writeSet)` 闸门（`lib/articles-agentic.js:156`），越界判 `write-set` 失败并记账 `writeSetViolation`；通过则 `fixAnchors` 后 `writeFileSync`。
6. 退回链路（index.js `tickArticles` `shouldFallBackHere`，`index.js:2944`）：本批 agentic 任务失败率过半且未退回过时，重排出失败篇 → `prepareArticleTasks` 装填成单轮整包装填请求重跑（`shouldFallBackFromAgentic` 严格过半判定，见 `test-agentic-fallback.mjs`）。

## Connections

- [[incremental]]：agentic 通道是 `tickArticles` 阶段的一部分，与增量更新（`lib/incremental.js`、`lib/update-planner.js`）共用同一套 job 状态机与 `settleJob`/`tally` 记账。
- [[article-contract]]：落盘前的契约闸门（`inspectArticle`/`hasBlockingIssue`）与写集闸门（`makeWriteSet`/`isWritable`）都来自 `lib/article-contract.js`，是 agentic 通道不被死链/越界污染 wiki 的防线。
- [[orchestration]]：index.js 的 `tickArticles`/`startAgenticRun`/`shouldFallBackHere`/`settleJob` 是 agentic 通道接入整套编译流水线（规划→文章→横切→校对→索引）的总线，失败时退回单轮通道（`runRealtimeTasks`）。
- 上游协议 `lib/agentic.js` 的契约注释（`lib/agentic.js:18`）明确 `runAgenticArticle` 的入参形态，下游 `lib/articles-agentic.js` 与 `lib/agentic-host.js` 都是围绕它适配。

## Known Issues

- 子模块深度封顶曾失效（`dispatchSub` 闭包被原样下传，子层永远用父层 `_depth` 判定，`_depth >= subDepth` 恒不成立，模型可无限往下拆，subDepth=2 实测堆溢出）。修复在 `lib/articles-agentic.js:83`–121：子层传 `onSubModule: null` + 按 `_depth+1` 重判 `subModuleBlocked`。回归测试见 `test-articles-agentic.mjs:145` 与 `:201`。
- 旧实现中 `generate_sub_module` 在无 `onSubModule` 时谎称"已记录/已派发"，导致父文写下指向不存在文件的死链且 `ok:true` 无人察觉。修复在 `lib/agentic.js:290`–306：区分 `max-depth` 与 `unsupported` 两种原因并诚实返回 `isError=true`。测试见 `test-agentic.mjs:401`。
- 步数上限两处各定义（24/30）造成同配置两种行为，已统一到 `lib/agentic.js:323` 的 `DEFAULT_MAX_STEPS=30`，并由 `lib/articles-agentic.js:21` 再导出（注释强调 index.js `agenticMaxSteps` 默认值必须一致）。
- read_code 重复读曾烧光步数（同大文件被读 13 次、累计 2.1MB 上下文最后 `max-steps` 文章没写完），`makeReadCodeTool` 的 `seen` 去重（`lib/agentic.js:115`–135）就地记账抑制重复读。
- CRLF 行尾（`.codewiki` 28/36 篇）曾导致 `str_replace` 因 `\r\n` 与 `view` 输出的 `\n` 不匹配而反复重试直到步数耗尽，`makeArticleEditor` 的行尾归一化（`lib/agentic.js:200`–228）修复，且命中后按原文风格写回不污染整文件。
- 字符上限防御：仅限行数挡不住压缩产物/单行超长文件（实测单行 20 万字符一次回吐 5.7 万 token），`MAX_READ_CHARS=40000`（`lib/agentic.js:96`）补充截断。
