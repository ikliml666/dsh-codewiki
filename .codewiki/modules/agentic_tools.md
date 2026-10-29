---
title: agentic_tools
type: module
source_files:
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
---

## Overview

`agentic_tools` 是模块 `agentic` 的全部源码与测试，对应上游 FSoft-AI4Code/CodeWiki 的
`src/be/agent_tools/`（读源码、编辑文章、递归派发子模块）以及
`documentation_generator.py` 里 pydantic-ai 工具循环（`run_module_agent`）。它把「一次性把源码
塞进 prompt 求一篇文章」改造成一个**可反复读代码、可精确编辑文章、可把大模块拆给子任务的写作工作台**，
从而让行号/签名这类硬事实可以现场核对，而不是靠一次性读进上下文后猜。

本模块由四个源文件构成，职责分层清晰：

- `lib/agentic.js`（第 1–541 行）：纯逻辑。定义四个工具的 JSON Schema（`TOOL_SCHEMAS`，第 27–87 行）、
  工具实现（`makeReadCodeTool` / `makeListFilesTool` / `makeArticleEditor` / `safeRelPath`）、
  工具调度表 `buildToolset`（第 279–315 行）、工具循环本体 `runAgenticArticle`（第 331–432 行），
  以及开场提示词 `buildOpeningPrompt`（第 506–540 行）与坏 JSON 容错解析（`stripJsonFence` /
  `sliceBalancedObject` / `parseToolArgs`）。该文件**不绑定任何 llm 服务、不碰文件系统**，全部靠注入的
  `workspace` 抽象访问真实仓库，因此测试可完全离线（见 `test-agentic.mjs`）。
- `lib/agentic-host.js`（第 1–135 行）：把裸消息适配成宿主 `dsh-llm` 的正式 `Message`（`toRequestMessages`，
  第 34–79 行），把 `llm.stream` 的 chunk 流收成 `blocks`（`makeHostStream`，第 83–108 行），并提供一个
  真实文件系统 workspace `makeFsWorkspace`（第 111–135 行）。
- `lib/articles-agentic.js`（第 1–333 行）：把「模块任务清单」跑成文章的执行器。单篇入口 `runOneArticle`
  （第 33–179 行，含子模块递归派发 `dispatchSub`），并发池 `runAgenticArticles`（第 231–312 行），
  以及大档标记 / 体量估算 / 选档的纯函数（`markBigAgenticTasks` / `sourceTokensOf` / `resolveTaskRoute`）。
- `lib/article-contract.js`（第 1–378 行）：文章契约闸门与写集闸门。被 `inspectArticle`（第 213–335 行）
  判结构完整性；被 `makeWriteSet` / `isWritable`（第 352–378 行）做 agentic 通道的「能写哪些文件」闸门。

测试三件套：`test-agentic.mjs`（工具循环与全部异常路径，离线假 `streamFn`）、`test-agentic-host.mjs`
（裸消息↔宿主 Message、多结果展开、收流、FS 越界）、`test-articles-agentic.mjs`（执行器与子模块递归派发接线，
走真实临时目录）。

## Key Components

### lib/agentic.js — 纯逻辑工具循环

常量与导出：

- `TOOL_SCHEMAS`（第 27–87 行）：四个工具的 JSON Schema 数组，直接对应宿主 `ToolSchema`。
  包含 `read_code`（第 28–42 行）、`list_files`（第 43–53 行）、`edit_article`（第 54–71 行）、
  `generate_sub_module`（第 72–86 行）。`buildOpeningPrompt` 从中取 `name`/`description` 列给模型。
- `MAX_READ_LINES = 2000`（第 93 行）：单次 `read_code` 行数上限。
- `MAX_READ_CHARS = 40000`（第 96 行）：单次 `read_code` 字符上限，挡住压缩产物/单行超长文件
  （注释指出 2000 行上限对「只有 1 行、20 万字符」的文件无效，会一次回吐 5.7 万 token）。
- `IGNORED_DIRS`（第 98 行）：`list_files` 一律不列出的目录白名单
  （`node_modules`/`.git`/`dist`/`build`/`.next`/`target`/`vendor`/`__pycache__`/`.venv`/`venv`）。
- `DEFAULT_MAX_STEPS = 30`（第 325 行）：单篇 agentic 写作的默认步数上限。**唯一定义点**——
  `articles-agentic.js` 从这里导入再导出，`index.js` 的 `agenticMaxSteps` 默认值也必须与之一致（30），
  否则直接调用拿 24、生产链路拿 30 出现两态行为。

导出函数：

- `numberLines(text)`（第 101–106 行）：给每行加 `行号| ` 前缀，模型据此引用行号。
- `makeReadCodeTool(workspace, { seen, getStep })`（第 115–177 行）：`read_code` 实现。
  - 越界路径直接拒（第 120–121 行）。
  - **重复读抑制**（第 108–114 行、第 127–135 行）：同一 `(path, 起始行, 结束行)` 再读不回吐正文，
    只回「你已经在第 N 步读过这段」；去重记账发生在读盘之前（第 123 行），避免白读。
  - 行范围夹取与行数/字符双重截断（第 144–167 行）。
  - 原始 key 与「夹取后等价 key」都记（第 149–152 行）：不带 `end_line` 与显式写满全文视为同一段。
- `makeListFilesTool(workspace)`（第 179–197 行）：`list_files` 实现。深度 `1..4` 夹取（第 183 行），
  过滤 `IGNORED_DIRS`（第 191 行），末尾标注「已隐藏 N 个依赖/版本控制目录」（第 194 行）。
- `makeArticleEditor(initial)`（第 200–263 行）：文章编辑工具，`article` 状态在闭包里。
  - `view`：返回带行号全文，空文章给说明（第 204–207 行）。
  - `str_replace`：行尾归一化（CRLF 先归一成 `\n` 再匹配，命中后按原文风格写回，避免悄悄改成 LF，
    见第 212–229 行）。唯一匹配才替换，多处匹配或非匹配给出可操作提示（第 219–225 行）。
  - `insert`：负数行号必须报错（第 235–236 行），否则静默插到最前会让内容跑到文件头；
    空文章 `split` 出 `['']` 当零行处理（第 244–245 行）。
  - 返回对象带 `article` getter/setter（第 258–262 行）。
- `safeRelPath(rel)`（第 266–273 行）：路径越界防护，拒绝 `/` 开头、`C:\` 盘符、`..` 跳出。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（第 279–315 行）：
  组装可调度的工具表 `read_code`/`list_files`/`edit_article`/`generate_sub_module`。
  - `generate_sub_module`（`onSubModule` 为空时）：**必须说实话**——旧实现回「已记录/已派发」会让模型在
    父文写下死链。`subModuleBlocked === 'max-depth'` 时明确说「已到嵌套上限，请在本文当普通小节写」
    （第 294–299 行）；否则说「当前模式不支持递归成文」（第 301–305 行）。
- `runAgenticArticle(opts)`（第 331–432 行）：循环本体。签名 `runAgenticArticle({ mission, streamFn,
  workspace, tools?, editor?, onSubModule?, subModuleBlocked?, maxSteps?, signal?, initialMessages?,
  systemPrompt?, articleFormat? })`。
  - 缺 `streamFn` 直接抛错（第 347 行）。
  - 只把实际可用的工具声明给模型（第 354 行）。
  - 循环（第 367–423 行）：每步 `stepRef.current = step` 供 `read_code` 报步号；调 `streamFn` 拿
    `blocks`；模型消息原样进历史（含它自己发的 tool-call，否则下一轮对不上 callId，第 382–383 行）；
    无工具调用 = 写完，若 editor 还空且文本像文章则收下正文（第 389–395 行）；执行工具结果作为 `tool`
    消息回灌（第 397–422 行）。
  - 返回 `{ article, steps, usedTools, stopReason, messages }`；`stopReason` 取值：
    `max-steps`/`aborted`/`stream-error`/`empty-response`/`finished`（第 365、369、377、380、393 行）。
- `stripJsonFence(s)`（第 439–444 行）：剥 ```` ```json ```` 围栏。
- `sliceBalancedObject(s)`（第 447–473 行）：从任意位置截出第一个括号平衡的 JSON 对象（跳过字符串内括号）。
- `parseToolArgs(raw, steps, step, toolName)`（第 476–500 行）：三级递进（原样→剥围栏→截平衡对象），
  都失败则记 `warning` 并给 `{}`，不中断（第 498 行）。
- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（第 506–540 行）：组装开场提示词，
  含工作步骤、`generate_sub_module` 可选章节、硬要求（不许编造文件/行号、不用围栏包整篇等，见第 535–538 行）。

### lib/agentic-host.js — 宿主适配层

`SOURCE = { kind: 'plugin:codewiki' }`（第 15 行）：所有本插件构造消息的统一 source 标记。

- `IDENTITY = new WeakMap()`（第 26 行）：裸消息对象 → 已构造正式 `Message` 的缓存。WeakMap 以裸消息
  对象为键，循环结束对象回收后缓存自动释放；避免每步给同一消息换新 UUID（违反宿主 MessageId 稳定性要求）。
- `stableKeyFor(role, r, index)`（第 29–31 行）：tool 角色一拆多时，键里带上结果序号。
- `toRequestMessages(messages, { provider, model })`（第 34–79 行）：裸消息 → 宿主 `RequestMessage[]`。
  - user 消息：`createUserMessage`（第 42 行）。
  - assistant 消息：有 `id` 直接透传（第 48 行），否则 `createAssistantMessage`（带 `provider`/`model`，第 51–54 行）。
  - tool 消息：**一条裸 tool 消息装多条结果，展开成多条 `createToolResultMessage`**（第 58–76 行），
    每条带 `toolCallId`/`source.callId`（第 67–69 行），用 `IDENTITY`/`stableKeyFor` 维持身份稳定。
  - 未知 role 被忽略。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（第 83–108 行）：
  建一个 `streamFn` 交给 `runAgenticArticle`，返回 `{ blocks, finish, usage }`。
  - 缺 `llm.stream` 直接抛「需要宿主 llm 服务」（第 84 行）。
  - 用 `BlockAssembler` 收 chunk（第 86、97 行）；`temperature: 0`（第 94 行）；
    `reasoningEffort` 非空才透传（第 91 行）；`tools` 空则不带 `tools` 字段（第 93 行）。
  - `finish.kind === 'error'|'aborted'` 时抛错（第 101–103 行）。
  - 每帧 `onDelta(chunk)`、收完 `onFinish(out)`，失败仅记日志不影响写作（第 98、105 行）。
- `makeFsWorkspace(fs, path, cwd)`（第 111–135 行）：真实 FS workspace，`readFile`（第 120–124 行）/
  `listDir`（第 125–133 行）都校验「相对路径必须落在 cwd 内」（第 114–118 行，符号链接逃逸由
  `safeRelPath` 再兜一层）。`listDir` 返回 `{ path, dir }`，子目录用完整相对路径（第 130 行）。

### lib/articles-agentic.js — agentic 执行器

导出再导出的常量：

- `DEFAULT_MAX_STEPS`（第 21 行，从 `lib/agentic.js` 再导出）：保持既有导入路径可用，避免再出现一份独立常量。

核心导出函数：

- `runOneArticle(task, { ... })`（第 33–179 行）：单篇跑一次 agentic 循环并落盘。
  签名含 `llm, provider, model, reasoningEffort, language, cwd, fsImpl, pathImpl, articleFormat,
  systemPrompt, maxSteps, signal, onDelta, onSubModule, subModuleBlocked, writeArticle, fixAnchors,
  allowedWritePaths, streamFn, subDepth, _depth, _takenNames` 等（第 33–56 行）。
  - 已有旧文作初始内容交给 editor，模型用 `str_replace` 增量改（第 58–63 行）。
  - `workspace = makeFsWorkspace(...)`（第 64 行），写集 `writeSet = makeWriteSet(allowedWritePaths)`
    （第 67 行，未传入 `undefined` 时保持旧行为不设限）。
  - `streamFn` 可注入（离线测试用假模型，第 69 行），默认走 `makeHostStream`。
  - **子模块递归派发 `dispatchSub`**（第 82–128 行）：用 `_takenNames` 共享已用名集合保证全局唯一
    （第 73、89–94 行，重名加父模块名前缀、仍重则跳过）；
    子文章落在 `<wiki>/modules/<父 slug>/<子 slug>.md`（第 96 行）。
    深度封顶 `subDepth`（默认 2）：`_depth >= subDepth` 时 `dispatchSub = null`（第 82–83 行），
    并下传 `subModuleBlocked: 'max-depth'`（第 118 行）让工具层说实话。
    递归时 `onSubModule` 传 `null` 而非 `dispatchSub`（第 117 行）——否则子层永远用父层 `_depth` 判定，
    封顶形同虚设。
  - 空文章算失败（第 146–149 行，`stopReason: 'empty-article'`），不覆盖旧文。
  - 写集闸门：越界一律不落盘并记账 `stopReason: 'write-set'`（第 155–167 行）。
  - 落盘前可经 `fixAnchors` 修正锚点（第 168–174 行），然后 `mkdirSync` + `writeFileSync`（第 175–176 行）。
  - 返回 `{ ...out, subModules, ok }`；`subModules` 项含 `{ name, path, ok, stopReason }`。
- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（第 185–203 行）：按 CJK×1、其余÷3.5 口径估 token，
  读不到的文件按 0 计（与 `index.js` `estimateTokens` 同口径，供大档判据比较）。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（第 208–222 行）：任务自带
  `provider+model`（大档任务）时完全以任务为准且 effort 以任务为准（空=模型默认档，不回落默认档 effort，
  因为默认档 effort 可能不被大档模型支持）；否则全用默认档。
- `runAgenticArticles(tasks, { concurrency, bigConcurrency, notes, signal, onTaskDone, onRequestStart, ...rest })`（第 231–312 行）：
  **双池**并发（与 `runRealtimeTasks` 同形状，返回 `Map(customId → 结果)`）。带 `bigTier` 标记的任务走
  大档池（`bigConcurrency`，为 0/未传时回落 `concurrency`），其余走默认档池（第 244–255 行）。
  单任务失败只记账、`stopReason: 'error'`，不向外炸（第 300–304 行）。结果项含
  `{ name, ok, stopReason, steps, tools, subModules }`（第 284–291 行）。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（第 320–333 行）：按模块源文本量给超大模块打大档标记
  （agentic 通道不装填源码，判据换成源文本量而非单轮通道的「装填超预算」）。`bigTier` 未配置（无 provider）
  或 `budget` 为 0 时原样返回（第 322–325 行）。纯函数不改原对象（第 326–332 行）。

### lib/article-contract.js — 文章契约与写集闸门

常量与表：

- `ARTICLE_CONTRACT_VERSION = 1`（第 16 行）。
- `TYPE_BY_DIR`（第 19–26 行）：目录 → 允许的 `type`（`modules→module`、`concepts→concept` 等）。
- `ROOT_TYPES`（第 28–32 行）：根目录特殊文章类型（`_architecture.md`、`_index.md`、`_patterns.md`）。
- `REQUIRED_SECTIONS`（第 36–45 行）：各类型必需章节（`module`/`architecture` 必须含 `Overview`+
  `Key Components`，其余类型只要 `Overview`）。
- `REQUIRED_FIELDS = ['title', 'type', 'source_files']`（第 46 行）；`tags` 是必填字段但允许空列表
  （第 260–262 行）。
- `SEVERITY`（第 56–73 行）：问题分级。`error` 级＝结构破坏必须拒写（重复 frontmatter/未闭合围栏/
  坏 source_files/死链/空正文/缺必填字段/缺必需章节等）；`warning` 级＝结构完整但内容不达标（不拒写，
  令终态降为 partial）。`missing-section` 与 `empty-section` 分开（第 54–55 行、第 70–72 行）。

导出函数：

- `parseFrontmatter(content)`（第 77–90 行）：只认文首第一个 `---` 块，返回
  `{ fields, body, endLine, closed, raw }`。
- `parseYamlLite(raw)`（第 94–118 行）：极简 YAML（只支持 `key: value` 与 `- item` 列表）。
  双引号标量能 `JSON.parse` 时按 JSON 权威解（YAML 1.2 是 JSON 超集，正确还原转义），失败回退切引号；
  单引号标量还原 `''` 转义（第 120–135 行）。
- `extractSections(body)`（第 138–158 行）：解析 `## 标题` 章节，遇围栏内标题不计（第 145 行）。
- `fencesBalanced(body)`（第 161–164 行）：代码围栏是否成对。
- `collectWikiLinks(body)`（第 167–176 行）：收集 `[[...]]` 与 `.md` 链接目标。
- `hasDuplicateFrontmatter(body)`（第 179–193 行）：正文里是否又出现了一份 frontmatter。
- `isRepoRelativeFile(p)`（第 195–203 行）：`source_files` 条目必须是仓库相对文件路径（非绝对、非 `../`、
  非目录形态）。
- `inspectArticle(content, opts)`（第 213–335 行）：主入口，返回 `issues[]`（空＝通过）。选项含 `cwd`、
  `articlePath`、`expectedType`、`readableSources`、`allowedLinks`、`fsImpl`、`requiredSections`、
  `allowEmptySourceFiles`（第 213–232 行）。依次查：空文、frontmatter、必填字段、type 与目录匹配、
  source_files 格式/存在性/是否本次证据、`empty-body`/`duplicate-frontmatter`/`unclosed-fence`、
  必需章节存在且非空、重复章节、章节非空、内部链接目标存在性（第 235–333 行）。
- `issueSummary(issues)`（第 338–343 行）：压成一行人类可读文案，`null` 表示通过。
- `hasBlockingIssue(issues)`（第 346–348 行）：只有 `error` 级才拦落盘。
- `makeWriteSet(paths)`（第 352–355 行）：编译允许写入路径集合，`null`＝调用方没设限。
- `normalizeWritePath(p)`（第 357–361 行）：`\`→`/`、去空、posix 归一。
- `isWritable(target, writeSet, { cwd })`（第 365–378 行）：写集比对，相对路径以 `cwd` 解析后比对，
  防 `../` 越界写到别的仓库；`writeSet` 为 `null` 时一律放行。

## Architecture

工具循环（纯逻辑）与宿主适配层、执行器、契约闸门的分层关系如下：

```text
        index.js (tickArticles/startAgenticRun)
                     │ tasks[], bigTier, writeSet
                     ▼
        lib/articles-agentic.js (runOneArticle/双池)
             │ dispatchSub 递归派发  │ markBigAgenticTasks
             ▼ runAgenticArticle     ▼
   lib/agentic.js (循环本体 331)   lib/article-contract.js
   ┌──────────────────────┐        makeWriteSet/isWritable
   │ buildToolset(279)     │              │ stopReason:'write-set'
   │ TOOL_SCHEMAS(27)      │              │
   └──┬─────────┬─────────┘              │
 streamFn│     │ tools                   │
      ▼  │     ▼                          │
 lib/agentic-host.js   read_code/list_files/  │
 ┌──────────────┐   edit_article/generate_sub │
 │ makeHostStream│   _module  → workspace{readFile,
 │ toRequestMsgs│     listDir} (safeRelPath 越界)
 └──────┬───────┘                            │
        │ chunk 流                            │
        ▼                                     │
 @deepseek-ai/dsh-llm llm.stream ─────────────┘
```

- **循环本体不碰 IO**：`runAgenticArticle`（agentic.js:331）只消费 `{role, content}` 裸消息与 `blocks`，
  通过注入的 `streamFn` 拿模型输出、通过 `workspace` 抽象读盘，因此 `test-agentic.mjs` 完全离线。
- **宿主适配是薄层**：`agentic-host.js` 只做两件事——裸消息↔宿主正式 `Message`（`toRequestMessages`），
  以及把一条装多条结果的 tool 消息展开成多条（`agentic-host.js:58–76`）；并负责 `BlockAssembler` 收流。
- **执行器是编排者**：`articles-agentic.js` 把模块任务清单变成 `runAgenticArticle` 调用，并在
  `runOneArticle` 内就地递归派发子模块（父子分开落盘），用 `makeWriteSet`/`isWritable` 做写集闸门。

## Data Flow

以 `index.js` 的 `tickArticles`（第 3156 行起）触发 `agentic` 通道为例，一次单篇写作的数据流：

1. **任务组装**：`tickArticles` 从 `job.plan.modules` 映射出 `tasks`（每篇含 `name`/`mission`/`sources`/
   `cwd`/`articlePath`/`prevArticlePath`，第 3275–3285 行），经 `markBigAgenticTasks` 给超大模块打大档标记
   （`agentic` 通道不装填源码，判据换成 `sourceTokensOf` 源文本量，第 3298–3309 行）。
2. **进入执行器**：`startAgenticRun` 调 `runAgenticArticles(tasks, …)`（index.js:2959），传入
   `llmRef`、`provider`/`model`/`reasoningEffort`、`maxConcurrency`/`bigConcurrency`、`cwd`、
   `articleFormat`、`maxSteps: c.agenticMaxSteps`、`allowedWritePaths`（各任务 `articlePath` 清单，第 2973 行）、
   `onRequestStart`/`onTaskDone` 钩子。
3. **双池取文章**：`runAgenticArticles` 把 `bigTier` 任务与默认档任务分池（articles-agentic.js:245–255），
   每篇进入 `runOneArticle`，`resolveTaskRoute` 选档（第 268 行）。
4. **单篇循环**：`runOneArticle` 用 `makeArticleEditor(prevArticle)` 起 editor、`makeFsWorkspace` 起 workspace、
   `makeHostStream` 起 `streamFn`（若 `streamFn` 已注入则直接用，第 69 行），再调 `runAgenticArticle`：
   - `runAgenticArticle` 先 `buildOpeningPrompt` 拼开场提示词（agentic.js:506），塞 `TOOL_SCHEMAS`
     （只声明实际可用的工具，第 354 行）。
   - 每步：`makeHostStream` 把裸消息经 `toRequestMessages` 转宿主 `Message`（一条 tool 消息展开成多条，
     agentic-host.js:58–76）、交给 `llm.stream`、`BlockAssembler` 收成 `blocks`。
   - 模型发 `read_code`/`list_files`：`makeReadCodeTool`/`makeListFilesTool` 走 `workspace`（真实 FS 经
     `safeRelPath` 越界校验，agentic-host.js:113–135 + agentic.js:266）。
   - 模型发 `edit_article`：`makeArticleEditor` 直接改闭包内 `article`（CRLF 归一化，agentic.js:201–229）。
   - 模型发 `generate_sub_module`：走 `dispatchSub`（articles-agentic.js:83–128），递归 `runOneArticle`
     写子文章到 `<modules>/<父>/<子>.md`，子层写集只含自己那条路径（第 112 行）。
   - 无工具调用 = 写完，`stopReason: 'finished'`（agentic.js:389–395）。
5. **落盘闸门**：`runOneArticle` 空文章判失败（第 146–149 行）；`isWritable(task.articlePath, writeSet)`
   越界则返回 `stopReason: 'write-set'`（第 155–167 行）；可选 `fixAnchors` 修正锚点后 `writeFileSync`
   （第 168–176 行）。
6. **回灌**：每篇结果 `{ name, ok, stopReason, steps, tools, subModules }` 进 `Map` 返回 `startAgenticRun`
   （index.js:2555），由 `settleJob` 统一收割；`onTaskDone` 累加 `job.batchProgress` 与用量（第 2977–2983 行）。

## Connections

- [[article_contract]] —— `lib/article-contract.js` 的 `inspectArticle`/`hasBlockingIssue` 在 `index.js` 落盘
  终态时判结构完整性；本模块的 `makeWriteSet`/`isWritable` 是 agentic 通道落到盘时的「写哪些文件」闸门。
- [[articles-agentic]] / 执行器与 `index.js` 的接线 —— `index.js` 在 `tickArticles`（第 3156 行）按
  `c0.agenticArticles` 开关切到本通道，`startAgenticRun`（第 2953 行）调 `runAgenticArticles`，
  `markBigAgenticTasks`/`sourceTokensOf` 由 `index.js:3307`（全量编译规划路径）调用。
- [[agentic-host]] —— 同上，`agentic-host.js` 的 `toRequestMessages`/`makeHostStream`/`makeFsWorkspace`
  是纯逻辑循环与宿主 `dsh-llm` 之间唯一的适配点。
- [[engine]]（原生 FSoft Python 引擎通道，lib/engine/）—— 与本 agentic 通道并列的第二条文章产出通道；
  原生通道正文由上游 prompt 决定（章节名非 `Overview`/`Key Components`），因此 `inspectArticle` 允许
  调用方用 `requiredSections` 覆盖章节要求（article-contract.js:217–224）。
- [[incremental]] / [[update-record]] / [[update-planner]] —— 决定哪些模块该写、失败率过半时回退单轮通道
  的上下文；`index.js` 在 `tickArticles` 里「单篇失败只记账，失败率过半且旧通道可用时退回单轮通道」。
- [[sessions]]（会话通道）—— 超批量预算文章走「会话模型→子智能体」的替代通道；agentic 通道与之不同，
  没有 `sessionTasks`，由自身工具循环完成写作。

## Known Issues

- **`subDepth` 封顶依赖 `onSubModule` 传 `null` 而非闭包**：`articles-agentic.js:117` 注释指出，递归派发时若原样
  下传 `dispatchSub` 闭包，子层 `_depth >= subDepth` 判定永远用父层 `_depth`，封顶形同虚设、模型可无限往下拆
  （实测 subDepth=2 直接堆溢出）。`test-articles-agentic.mjs` 的 `subDepth=1`/`subDepth=2` 两条用例是回归防护
  （第 182、201 行），用「磁盘层数」与「调用次数有界」两个与顺序无关的断言兜底。
- **子模块不可用时不得谎称成文**：旧 `buildToolset.generate_sub_module` 无论何种原因都回「已记录子模块 X（已派发）」，
  模型据此在父文写「详见 xxx.md」，而文件从未生成——死链且父任务记 `ok:true`。现改为 `subModuleBlocked` 区分
  `max-depth`/不支持两种原因分别说实话（agentic.js:290–306）；`test-agentic.mjs` 第 401、421 行断言必须 `isError=true`
  且不含「已记录子模块」。
- **`read_code` 重复读烧步数**：实跑发现真实模型一次探针把 `index.js` 读了 13 次，16 次读码只有 4 个不同文件，
  最终 `stopReason=max-steps` 文章没写完。`makeReadCodeTool` 加去重记账（agentic.js:115–114、127–135），
  重复读只回「你已在第 N 步读过」。
- **CRLF 跨行 `str_replace` 失配**：`.codewiki` 下 28/36 篇是 CRLF，模型按 view 输出（换行 `\n`）写的 `old_str`
  永远匹配不上存成 `\r\n` 的文章。`makeArticleEditor` 匹配前归一化行尾、命中后按原文风格写回（agentic.js:200–229）。
- **`insert` 负数行号静默插到最前**：`makeArticleEditor` 原用 `Math.max(0,…)` 吞掉负数，内容会跑到文件头。现
  负数明确报错（agentic.js:235–236）；`test-agentic.mjs` 第 589 行回归。
- **坏 JSON 参数退化**：模型常把 JSON 包在 ```` ```json ```` 围栏或夹在解释句里，`parseToolArgs` 三级递进兜底
  （strip/截平衡对象），都失败才记 warning 给 `{}`（agentic.js:439–500），避免工具拿空参数反复重试。
- **写集闸门需显式开启**：`runOneArticle` 的 `allowedWritePaths` 传 `undefined`（旧调用方/测试沿用）时保持旧行为
  不设限（articles-agentic.js:67）；传 `null/[]` 视为「谁都不许写」（有意收紧）。越界写返回
  `stopReason: 'write-set'`，测试见 `test-articles-agentic.mjs` 第 399 行。
- **`outputTokens` 为粗估**：`runAgenticArticles` 注释说明 chunk 里 `usage` 会出现多次，按 step 数粗估
  `outputTokens`（articles-agentic.js:277–279），面板 token 统计对 agentic 通道不精确。
- **未发现的缺陷**：本模块未实现「模型在连续轮次里重写同一段导致文章膨胀」的主动压缩；`MAX_READ_CHARS`/`MAX_READ_LINES`
  上限存在但未与 `source_files` 证据集做交叉校验（即读完的文本未必都进了 `source_files`）。
