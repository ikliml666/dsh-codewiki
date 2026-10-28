---
title: agentic_core
type: module
source_files:
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - test-agentic.mjs
  - test-articles-agentic.mjs
tags: [agentic, article-writing, llm-tool-loop, sub-module, client-factory]
---

## Overview

`agentic_core` 是 CodeWiki 插件里「agentic 文章写作通道」的核心逻辑层，对应上游
FSoft-AI4Code/CodeWiki 的 `src/be/agent_tools/`（read_code / str_replace_editor /
generate_sub_module_documentations）与 `documentation_generator.py` 里的 pydantic-ai 工具循环
（`run_module_agent`）。它把「一次性把源码塞进 prompt 求一篇文章」改成给模型一个**可反复读代码、
可对文章做精确编辑、可把大模块拆给子任务**的工作台，从而让行号 / 签名这类硬事实可以现场核对，
而不是靠一次性读进上下文后猜（见 `lib/agentic.js:1-19`）。

本模块由四个文件组成，分两层职责：

- **纯逻辑层** `lib/agentic.js`：工具循环本体、四个工具的 schema 与实现、开场提示词、JSON 参数解析。
  它消费 `{role, content}` 裸消息、只认 `ContentBlock`，不绑死任何 llm 服务，因此测试可完全离线
  （见 `lib/agentic.js:11-15`）。
- **宿主适配层** `lib/agentic-host.js`：把裸消息翻译成宿主 dsh-llm 的正式 `Message`，把一条多结果的
  tool 消息展开成多条 `ToolResultMessage`，并用 `BlockAssembler` 把 chunk 流收成 blocks；还提供
  `makeFsWorkspace` 这个 `readFile / listDir` 抽象（见 `lib/agentic-host.js:111-125`）。
- **执行器** `lib/articles-agentic.js`：把「模块任务清单」跑成文章，是单轮通道 `runRealtimeTasks`
  之外的第二条执行通道；负责落盘、子模块递归派发、写集闸门、并发双池、大档打标
  （见 `lib/articles-agentic.js:1-11`）。
- **闸门依赖** `lib/article-contract.js`：提供写集（`makeWriteSet` / `isWritable`）等纯函数，被
  agentic 通道的越界写入防护复用（见 `lib/article-contract.js:350-378`）。

核心契约是 `runAgenticArticle({ mission, workspace, streamFn, tools?, maxSteps })`
→ `{ article, steps, usedTools, stopReason, messages }`（见 `lib/agentic.js:425-431`，契约注释见 `17-19`）。

## Key Components

### lib/agentic.js（工具循环本体）

公开常量 / 函数（行号以源码前缀为准）：

- `TOOL_SCHEMAS`（27-87）：四个工具的 JSON-Schema 形态（对应宿主 `ToolSchema`）。依次是
  `read_code`（29-42，参数 `path`/`start_line`/`end_line`）、`list_files`（44-53，参数
  `path`/`depth`）、`edit_article`（55-71，参数 `command`/`old_str`/`new_str`/`line`/`text`）、
  `generate_sub_module`（73-86，参数 `module_name`/`components`/`description`）。`read_code` 与
  `edit_article` 的 `description` 直接成为开场提示词里的工作方式要求（见 `buildOpeningPrompt`）。
- `MAX_READ_LINES = 2000`（93）：`read_code` 单次返回行数上限。
- `MAX_READ_CHARS = 40000`（96）：`read_code` 单次返回字符上限，挡住「单行 20 万字符」这种压缩产物
  （见 `lib/agentic.js:94-96`）。
- `IGNORED_DIRS`（98）：`list_files` 一律不列出的目录（`node_modules/.git/dist/build/...`），避免模型
  把依赖目录当源码去读、白烧步数。
- `numberLines(text)`（101-106）：给每行加「`行号| `」前缀，模型据此引用行号。
- `makeReadCodeTool(workspace, { seen, getStep })`（115-177）：`read_code` 实现。在**读盘之前**做
  重复读抑制（同一个 `(path, start, end)` 再读只回「你已在第 N 步读过这段」，不再回吐正文，见
  115-135）；越界路径用 `safeRelPath` 兜底（120-121）；行数截断在 156-159、字符截断在 164-167。
- `makeListFilesTool(workspace)`（179-197）：`list_files` 实现，深度夹在 `[1,4]`
  （183），用 `IGNORED_DIRS` 过滤（191-192），并在末尾标注隐藏了几个目录（194）。
- `makeArticleEditor(initial)`（200-263）：文章编辑工具，状态在闭包里。返回 `{ edit, get article,
   set article }`。`edit`（202-257）支持三种 `command`：
  - `view`（204-207）：返回带行号的当前全文，空文章给说明。
  - `str_replace`（208-230）：行尾归一化（CRLF↔LF）后做唯一匹配；命中重写回原文风格（216-228）；
    多处匹配或非空 `old_str` 缺失都报错（211、220-226）。
  - `insert`（231-255）：负数行号必须报错（235-237）；`line=0` 插到最前（250-251）；空文章按零行处理
    （245）。
- `safeRelPath(rel)`（266-273）：路径越界防护，拒绝 `/` 开头、`C:/` 绝对路径、`../` 跳出去。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（279-315）：把四个工具
  聚成 `{ read_code, list_files, edit_article, generate_sub_module }`。`generate_sub_module`
  实现（285-313）在 `onSubModule` 为空时**必须说实话**：`subModuleBlocked === 'max-depth'` 报「嵌套上限」
  （294-300），否则报「当前模式不支持递归成文」（301-305），都返回 `isError: true`，绝不说谎「已记录 /
  已派发」（见 290-306 的注释）。
- `DEFAULT_MAX_STEPS = 30`（325）：单篇 agentic 写作默认步数上限，是 agentic 步数常量的**唯一定义点**
  （见 `lib/agentic.js:321-325`）。
- `runAgenticArticle(opts)`（331-432）：循环本体。参数解构见 332-345；缺 `streamFn` 直接抛错（347）；
  用 `buildToolset` 组工具（351），只把实际可用的 schema 声明给模型（354）；多轮 for 循环（367-423）
  每步刷 `stepRef.current`（368）、调 `streamFn`（373）、把 assistant 消息原样进历史（383）、执行工具
  调用并把结果回灌为 `tool` 消息（398-421）。`stopReason` 取值：`max-steps`（365 初值）、`aborted`
  （369）、`stream-error`（377）、`empty-response`（380）、`finished`（393）。无工具调用时若编辑器为空且
  文本像文章就收下正文（391）。
- `stripJsonFence(s)`（439-444）：剥 ```` ```json ```` 围栏。
- `sliceBalancedObject(s)`（447-473）：从任意位置截出第一个括号平衡的 JSON 对象，跳过字符串字面量里的括号。
- `parseToolArgs(raw, steps, step, toolName)`（476-500）：三级递进解析（原样→剥围栏→截平衡对象），
  坏 JSON 不中断、记 `warning` 并回 `{}`（498）。
- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（506-541）：开场提示词。列工具
  （507）、按 `schemas` 是否含 `generate_sub_module` 决定是否带「拆分」小节（508-533）、列出硬要求
  （535-538，含「不要用 markdown 围栏把整篇文章包起来」）。

### lib/agentic-host.js（宿主适配层）

- `SOURCE = { kind: 'plugin:codewiki' }`（15）：所有构造消息的 source 标记。
- `IDENTITY = new WeakMap()`（26）：裸消息对象 → 正式 Message 的缓存，跨表示边界保持 MessageId 稳定
  （见 `lib/agentic-host.js:19-26`）。
- `stableKeyFor(role, r, index)`（29-31）：tool 角色一拆多时，键里带结果序号。
- `toRequestMessages(messages, { provider, model })`（34-79）：裸消息 → 宿主 `RequestMessage[]`。
  user 用 `createUserMessage`（42），assistant 用 `createAssistantMessage`（带 provider/model，51-53，
  已有 `id` 透传 48），tool 角色**一条拆多条** `createToolResultMessage`（58-76）。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（83-108）：建一个
  `streamFn` 交给 `runAgenticArticle`。先用 `toRequestMessages` 转换（87），`temperature: 0`（94），
  用 `BlockAssembler` 收 chunk（86、97），`finish.kind` 为 `error`/`aborted` 时抛错（101-103），
  返回 `{ blocks, finish, usage }`（104）。缺 `llm.stream` 直接抛错（84）。
- `makeFsWorkspace(fs, path, cwd)`（111-135）：`readFile`/`listDir` 抽象，把相对路径解析成绝对路径并
  校验落在 `cwd` 内（112-118），越界抛「越界路径」（122、127）。

### lib/articles-agentic.js（执行器）

- `DEFAULT_MAX_STEPS`（21）：从 `./agentic.js` 再导出，保持既有导入路径可用。
- `runOneArticle(task, opts)`（33-179）：单篇跑一次 agentic 循环并落盘。返回
  `{ ok, stopReason, article, steps, usedTools, outputTokens, subModules }`。关键逻辑：
  - 旧文作为 `initialArticle` 交给编辑器增量改（60-63）；
  - `makeFsWorkspace`（64）、写集编译（67）、`streamFn` 可注入或走 `makeHostStream`（69）；
  - 子模块名全局唯一（`slugOf` 75、`taken` 集合 73、重名加父前缀 89-93）；
  - 深度封顶 `subDepth`（默认 2，53/82）：到顶时 `dispatchSub` 为 `null` 且 `subModuleBlocked='max-depth'`；
  - 递归 `dispatchSub`（83-128）把子任务落到 `modules/<父>/<子>.md`（96），并**只给子层它自己那一条
    写集路径**（112）、传 `onSubModule: null` 让子层重建深度判定（117-118）；
  - 空文章兜底为失败（147-149）；写集闸门 `isWritable` 越界不落盘（155-167）；`fixAnchors` 可选锚点修正
    （169-174）；最终 `mkdirSync`+`writeFileSync`（175-176）。
- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（185-203）：按 CJK=1、其余 `/3.5` 口径估 token，
  读不到的文件按 0 计。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（208-222）：任务自带 provider+model 时
  全覆盖（含 effort），否则回退默认档；缺 model 不算自带（209）。
- `runAgenticArticles(tasks, { concurrency, bigConcurrency, notes, signal, onTaskDone, onRequestStart, ...rest })`
  （231-312）：并发池，返回 `Map(customId → 结果)`。双池：带 `bigTier` 走 `bigConcurrency`，否则走
  `concurrency`（244-255）；单任务失败只记账不影响其它任务（300-303）。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（320-333）：按体量打大档标记（agentic 不装填源码，
  判据换成源文本量超过 `budget`），纯函数不改原对象（329-332）。

### lib/article-contract.js（写集闸门依赖）

agentic 通道只用到写集相关纯函数（不直接判文章契约）：

- `makeWriteSet(paths)`（352-355）：把路径数组规范化成 `Set`；非数组返回 `null`（= 调用方没设限）。
- `normalizeWritePath(p)`（357-361）：`\`→`/`、`path.posix.normalize`、空返回 `null`。
- `isWritable(target, writeSet, { cwd })`（365-378）：写集判定；`writeSet` 为空则放行（366）；相对路径以
  `cwd` 解析后比对，防止 `../` 越界（370-376）。

## Architecture

组件 ≥3 且流程非平凡，框图如下（箭头表示「调用 / 数据流」方向）：

```text
 调用方 / index.js
        │ runAgenticArticles(tasks)        ┌──────────────────────────┐
        ▼                                   │  articles-agentic.js     │
 ┌──────────────┐  runOneArticle(task)      │  runOneArticle / dispatchSub│
 │ 双池并发调度 │──────────────────────────►│  (子模块递归 / subDepth)   │
 └──────────────┘                           └────────────┬─────────────┘
                                                          │ runAgenticArticle
                                                          ▼
                                  ┌──────────────────────────────────────┐
                                  │  agentic.js 循环本体                   │
                                  │  buildToolset + streamFn 多轮          │
                                  └───┬───────────┬───────────┬───────────┘
                                      │           │           │
                         ┌────────────▼┐  ┌───────▼──────┐ ┌──▼─────────────┐
                         │ read_code   │  │ list_files   │ │ edit_article   │
                         │ makeReadCode│  │ makeListFiles│ │ makeArticleEd. │
                         │ Tool+seen   │  │ +IGNORED_DIRS│ │ (CRLF 归一)    │
                         └──────┬──────┘  └──────┬──────┘ └───────┬────────┘
                                │               │               │
                                ▼               ▼               ▼
                        workspace.readFile  workspace.listDir  editor.article
                                └───────────┬───────────────────┘
                                            ▼
                                  ┌────────────────────┐
                                  │  agentic-host.js   │
                                  │ makeFsWorkspace    │ (readFile/listDir)
                                  │ toRequestMessages  │ (裸消息→dsh Message)
                                  │ makeHostStream     │ (BlockAssembler)
                                  └─────────┬──────────┘
                                            │ llm.stream
                                            ▼
                                    宿主 dsh-llm 服务
```

- 纯逻辑层（`agentic.js`）与宿主适配层（`agentic-host.js`）只在 `runOneArticle` 里通过
  `makeHostStream` / `makeFsWorkspace` 接线（见 `lib/articles-agentic.js:64,69`），离线测试可注入假
  `streamFn` 与假 workspace 跳过这层（见 `test-agentic.mjs:29-52`）。
- 子模块递归是同一份 `runOneArticle` 自我调用：`dispatchSub`（83-128）构造子任务后再次调用
  `runOneArticle`（105），通过 `_depth` 实参（121）逐层递增深度、通过 `subModuleBlocked`（118）把封顶原因
  下传（见 `lib/articles-agentic.js:79-121`）。
- 写集闸门是 `agentic.js` 的工具自由 + `article-contract.js` 的 `isWritable` 双保险：父任务只准写自己那篇，
  子模块只准写调度器分配的 `<父目录>/<子 slug>.md`（见 `lib/articles-agentic.js:112,155-167`）。

## Data Flow

单次 `runOneArticle`（不含子模块递归）的完整数据流：

1. **任务入参**（33-56）：`task.mission` / `task.articlePath` / `task.sources` / `prevArticlePath`；
   `opts` 提供 `llm`、`provider`、`model`、`reasoningEffort`、`cwd`、`maxSteps`、`subDepth` 等。
2. **编辑器初始化**（59-63）：若 `task.prevArticlePath` 可读，旧文作为 `initialArticle` 交给
   `makeArticleEditor`，模型后续用 `str_replace` 增量改而非从零重写。
3. **Workspace 与 streamFn**（64-69）：`makeFsWorkspace(fsImpl, pathImpl, cwd)` 建 `readFile/listDir` 抽象；
   `streamFn` 默认由 `makeHostStream({ llm, provider, model, reasoningEffort })` 生成，否则用注入的假函数。
4. **进入循环** `runAgenticArticle`（130-142）：把 `editor`、`onSubModule`（`dispatchSub` 或外部注入）、
   `subModuleBlocked` 一并交给循环本体（331-432）。
5. **循环逐轮**（367-423）：
   - 刷新 `stepRef.current` 供 `read_code` 报「第 N 步读过」（368、351）；
   - `streamFn({ messages, tools, signal })` 拿到 `blocks`（373）；空 blocks → `empty-response` 退出（380）；
   - assistant 消息原样进历史（383）；提取 `tool-call` 与 `text`（385-387）；无调用 → 收正文并 `finished`（389-395）；
   - 逐个执行 tool 调用：`parseToolArgs` 解析参数（401、`parseToolArgs` 476-500）→ `impl(args)`（408）→
     结果包成 `tool-result` 回灌（413-420）；
   - 本轮 `steps`/`usedTools` 记账（422）。
6. **工具侧读写**（115-263）：
   - `read_code`：读盘前查 `seen` 去重（128-135），按 `MAX_READ_LINES`/`MAX_READ_CHARS` 截断（156-167），
     用 `numberLines` 加前缀（160）；
   - `list_files`：过滤 `IGNORED_DIRS`（191-192）；
   - `edit_article`：CRLF 归一后 `insert`/`str_replace`/`view`（202-257）。
7. **落盘闸门**（146-177）：`out.article` 为空 → `ok:false` 且 `empty-article`（147-149）；写集开启时
   `isWritable` 越界 → `stopReason:'write-set'` 不落盘（155-167）；通过则可选 `fixAnchors`（169-174）、
   `mkdirSync`+`writeFileSync`（175-176）。
8. **返回**（178）：`{ ...out, subModules, ok: true }`，`out.subModules` 由 `dispatchSub` 递归填充（122）。

**子模块递归流**：`dispatchSub`（83-128）在模型调用 `generate_sub_module` 时触发 → `runOneArticle(subTask)`
（105）→ 子层 `_depth+1`（121）、`onSubModule:null`（117）、仅含自身路径的写集（112）→ 子文落到
`modules/<父>/<子>.md`（96）。父任务 `subModules` 数组记录 `{ name, path, ok, stopReason }`（122）。

**并发双池流**：`runAgenticArticles`（231-312）把任务按 `bigTier` 拆成两个池（244-255），各自
`Promise.all` 限流（307-310），单任务失败只写 `notes`（300-303），最终返回 `Map(customId → 结果)`（284-291）。

## Connections

- [[articles-agentic]]：`lib/articles-agentic.js` 是本文执行器层的同模块入口，负责把任务清单跑成文章；
  本文 `agentic.js`/`agentic-host.js` 为其提供循环与宿主适配。
- [[article-contract]]：`lib/article-contract.js` 的 `makeWriteSet` / `isWritable` 被 agentic 通道的写集闸门
  复用（见 `lib/articles-agentic.js:17,67,155-167`），`inspectArticle` 是单轮通道的落盘闸门（本文不展开）。
- [[engine-client]]：同仓库的 Node↔Python 引擎适配层；本文 `agentic-host.js` 的 `makeHostStream` 是另一条
  llm 边界，二者都做「裸请求 → 正式消息 / 协议」的适配与失败归一。
- [[engine-llm-bridge]]：`lib/engine/llm-bridge.js` 提供引擎侧的模型通道，与本文宿主侧 `makeHostStream` 职责类比。
- [[incremental]] / [[change-set]]：agentic 通道产出的文章最终进入增量更新与变更集落盘流程。
- [[index]]（插件入口 `index.js`）：生产链路里 `agenticMaxSteps` 默认值必须与此文 `DEFAULT_MAX_STEPS`（30）
  一致（见 `lib/agentic.js:321-325`），`Config` 与本文共享同一常量语义。

## Known Issues

- **重复读抑制只在 `read_code` 侧记账**：`makeReadCodeTool` 的 `seen` Map 是 per-tool 实例的
  （`lib/agentic.js:279-299`），若 `buildToolset` 被重建（例如注入新 workspace）去重状态会丢。测试见
  `test-agentic.mjs:501-540` 验证了首个实例内的去重。
- **`outputTokens` 在并发池里是粗估**：`runAgenticArticles` 直接取 `out?.usage?.outputTokens`，注释明确说明
  chunk 里 `usage` 会出现多次、streamFn 侧收不到可靠值（见 `lib/articles-agentic.js:277-279`）。
- **`fixAnchors` 失败被静默吞**：`runOneArticle` 里 `fixAnchors` 抛错只走 `catch` 不阻断落盘
  （`lib/articles-agentic.js:169-174`），锚点修正失败时文章仍按原样写盘。
- **`temperature` 被硬编码为 0**：`makeHostStream` 写死 `temperature: 0`（`lib/agentic-host.js:83`），宿主侧
  无法为 agentic 通道单独调温度。
- **`parseToolArgs` 坏 JSON 只记 warning**：参数解析失败时回 `{}` 并记 `steps.warning`，工具拿空参数执行
  （`read_code` 报缺 path、`edit_article` 报缺 command），模型需自己从回灌结果里纠正（见
  `lib/agentic.js:434-500` 与 `test-agentic.mjs:293-305`）。
- **`onRequestStart` 钩子无 `onError` 兜底时静默**：`runAgenticArticles` 的 worker 在 `catch` 里调 `rec?.onError`
  （`lib/articles-agentic.js:303`），未注册时异常被吞、只写 notes（`lib/articles-agentic.js:300-303`）。
- **写集 `null` 与 `[]` 语义不同**：`allowedWritePaths` 不传 = 不设限（`undefined`→`writeSet=null` 放行一切），
  传 `[]` = 谁都不许写（有意收紧），二者都沿用旧调用方但行为相反（见 `lib/articles-agentic.js:51,67` 与
  `test-articles-agentic.mjs:433-447`）。
- **子模块名唯一性靠 `_takenNames` 共享**：重名时加父模块名前缀仍重则跳过（`lib/articles-agentic.js:89-93`），
  同一父任务内靠闭包 `taken` 保障，跨父任务不保证（依赖上游命名）。
