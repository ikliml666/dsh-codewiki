---
title: agentic_host
type: module
source_files:
  - lib/agentic-host.js
  - test-agentic-host.mjs
  - lib/agentic.js
  - lib/articles-agentic.js
  - index.js
tags: [agentic, llm-stream, workspace, filesystem, adapter]
---

## Overview

`lib/agentic-host.js` 是 **agentic 工具循环 ↔ 宿主 llm 服务** 的适配层（host adapter）。它的存在是为了让 `lib/agentic.js` 里「纯逻辑、不绑死任何 llm 服务」的工具循环（`runAgenticArticle`）能够跑在宿主（`@deepseek-ai/dsh-llm`）的 `llm.stream` 上。

模块做三件事（见文件头注释，`lib/agentic-host.js:1`–`lib/agentic-host.js:9`）：

1. **裸消息 ↔ 宿主正式消息的互转**（`toRequestMessages`，`lib/agentic-host.js:34`）。agentic 循环消费的是 `{role, content}` 裸消息、只认 blocks；而宿主 `llm.stream` 要的是带 `id` + `source` 的正式 `Message`（`createUserMessage` / `createAssistantMessage` / `createToolResultMessage`），且**一条 tool 消息只能装一个结果**。工具循环里「一轮多个调用」是一条消息装多条结果，这里负责展开成多条。
2. **包一个 streamFn 交给工具循环**（`makeHostStream`，`lib/agentic-host.js:83`）。它把宿主 `llm.stream` 的 chunk 流用 `BlockAssembler` 收成 blocks，并把 `finish.kind === 'error' | 'aborted'` 转成抛错。
3. **仓库 workspace 抽象**（`makeFsWorkspace`，`lib/agentic-host.js:111`）。把 `fs` / `path` / `cwd` 封装成工具循环只认的 `{ readFile, listDir }`，并做路径越界防护（不允许 `../` 逃逸出 `cwd`）。

模块与 `lib/agentic.js` 的边界（契约）：`agentic.js` 是纯逻辑，`runAgenticArticle` 只消费 `{ blocks, finish, usage }` 这种 streamFn 返回值；「streamFn 长什么样、消息怎么构造、工具怎么读盘」全部由本模块（及其上游 `lib/articles-agentic.js`）适配。因此本模块可以完全离线测试——测试里用一个假的 `llm.stream` 即可，不需要真实宿主（`test-agentic-host.mjs:66`–`test-agentic-host.mjs:77`）。

模块没有任何会被全局禁用的代码段；所有导出函数都是活跃实现（无注释掉的禁用分支）。
## Key Components

模块只导出三个函数，外加一个模块级常量。所有行号以 `lib/agentic-host.js` 为准。

### `SOURCE`（模块级常量，`lib/agentic-host.js:15`）

```js
const SOURCE = { kind: 'plugin:codewiki' }
```

所有由本插件构造的 UserMessage 统一打的 `source` 标记。仅用于 `createUserMessage` 的 `source` 入参（`lib/agentic-host.js:42`）；assistant / tool 消息另有各自来源（见下）。

### `IDENTITY`（模块级 WeakMap，`lib/agentic-host.js:26`）

```js
const IDENTITY = new WeakMap()
```

裸消息对象 → 已构造的正式 `Message` 缓存。键是「裸消息对象」本身（不是 role/content），因此**天然跟随工具循环的消息生命周期**：循环结束对象被回收，缓存自动释放，不会内存泄漏。

为何要缓存（见 `lib/agentic-host.js:19`–`lib/agentic-host.js:34`）：宿主 `MessageId` 的契约是 "Stable identity preserved across every representation boundary"。工具循环每一轮都会把同一份 `messages` 重新丢进 `toRequestMessages`，若每次都 `create*Message`，同一轮里的同一条消息每步都会换一个新 UUID——语义上违约。本插件走一次性 `llm.stream`、没有 Session/replay，所以不会崩，但下游一旦按 id 去重或做游标就会失真。`WeakMap` 以裸对象为键，保证同一次循环里同一对象始终映射到同一个已构造 `Message`。

注意 tool 角色一拆多（`lib/agentic-host.js:26`–`lib/agentic-host.js:75`），所以 `IDENTITY` 对 tool 消息存的不是单个 `Message` 而是 `Map<stableKey, Message>`（`lib/agentic-host.js:62`–`lib/agentic-host.js:63`）。

### `stableKeyFor(role, r, index)`（`lib/agentic-host.js:29`）

```js
function stableKeyFor(role, r, index) {
  return `${role}#${index ?? ''}#${r?.toolCallId ?? ''}`
}
```

为 tool 消息里「一条结果」生成稳定缓存键：`tool#<index>#<toolCallId>`。因为一条 tool 消息会被展开成多条 `ToolResultMessage`，缓存键必须带上 `toolCallId`（以及 `index`）才能区分同一消息内的不同结果。当前调用处（`lib/agentic-host.js:64`）只用了 `role` 和 `r`，未传 `index`（即 `index` 始终为 `undefined`、键里该段为空），实际区分靠 `toolCallId`。

### `toRequestMessages(messages, { provider, model } = {})`（`lib/agentic-host.js:34`）

裸消息数组 → 宿主 `RequestMessage[]`。逐条处理：

- **`role === 'user'`**（`lib/agentic-host.js:26`–`lib/agentic-host.js:45`）：`IDENTITY` 命中则复用缓存，否则 `createUserMessage({ content, source: SOURCE })` 并写入缓存。
- **`role === 'assistant'`**（`lib/agentic-host.js:46`–`lib/agentic-host.js:57`）：
  - 若 `m.id` 已存在（已是正式消息），**直接透传**不重造（`lib/agentic-host.js:48`），避免重复造身份。
  - 否则 `createAssistantMessage({ content, source: { provider: String(provider ?? ''), model: String(model ?? '') } })`，并以裸对象为键缓存。`source.kind` 由宿主填 `model`（测试断言 `out[0].source.kind === 'model'`，见 `test-agentic-host.mjs:32`）。
- **`role === 'tool'`**（`lib/agentic-host.js:38`–`lib/agentic-host.js:70`）：遍历 `content`，跳过 `type !== 'tool-result'` 的项；其余每条 `tool-result` 展开成一个 `createToolResultMessage({ callId: r.toolCallId, content: <文本化>, isError: !!r.isError })`（`lib/agentic-host.js:67`–`lib/agentic-host.js:71`）。`content` 形如 `[{type:'text', text}]` 则原样传；否则包成 `[{ type: 'text', text: String(r.content ?? '') }]`。`isError` 经 `!!` 归一。
- **未知 role**（如 `'weird'`）：被忽略、不进结果（`test-agentic-host.mjs:61`–`test-agentic-host.mjs:64`）。

返回值 `out` 是 `RequestMessage[]`，顺序与输入裸消息顺序一致（tool 一条拆多后连续排列）。

### `makeHostStream({ llm, provider, model, reasoningEffort = '', onDelta = null, onFinish = null })`（`lib/agentic-host.js:83`）

返回一个 streamFn：`async ({ messages, tools = [], signal }) => { blocks, finish, usage }`，直接喂给 `runAgenticArticle` 的 `streamFn` 形参（`agentic.js:331`）。

行为：

- **入参校验**（`lib/agentic-host.js:84`）：`llm` 缺失或 `llm.stream` 不是函数 → 抛 `Error('makeHostStream 需要宿主 llm 服务')`（`test-agentic-host.mjs:124`–`test-agentic-host.mjs:126`）。
- 内部 `new BlockAssembler()` 收流（`lib/agentic-host.js:34`），`toRequestMessages` 把裸消息转成请求体（`lib/agentic-host.js:87`）。
- 调 `llm.stream({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}), messages: reqMessages, tools: <映射后的工具>, temperature: 0, ...(signal ? { signal } : {}) })`（`lib/agentic-host.js:88`–`lib/agentic-host.js:96`）。
  - `tools` 映射成 `{ name, description, parameters: t.parameters ?? { type:'object', properties:{} } }`，**仅当 `tools.length` 为真时才带 `tools` 字段**（`lib/agentic-host.js:93`、`test-agentic-host.mjs:101`–`test-agentic-host.mjs:112`）。
  - `temperature` 固定为 `0`（`lib/agentic-host.js:94`）。
  - `reasoningEffort` 仅在非空时透传（`lib/agentic-host.js:91`、`test-agentic-host.mjs:128`–`test-agentic-host.mjs:134`）。
- 每个 `chunk` 先 `assembler.push(chunk)`，再（可选）`onDelta(chunk)`；`onDelta` 抛错被吞掉（`/* 记录失败不影响写作 */`，`lib/agentic-host.js:98`）。
- 收尾（`lib/agentic-host.js:100`–`lib/agentic-host.js:106`）：
  - `finish = assembler.finish`；若 `finish.kind === 'error' || 'aborted'` → 抛 `Error('agentic llm 失败（<kind>，<code>）：<message>）')`（`test-agentic-host.mjs:114`–`test-agentic-host.mjs:122`）。
  - 返回 `{ blocks: assembler.blocks(), finish, usage: assembler.usage }`；随后（可选）`onFinish(out)`，抛错忽略（`lib/agentic-host.js:105`）。

### `makeFsWorkspace(fs, path, cwd)`（`lib/agentic-host.js:111`）

把 `fs` / `path` / `cwd` 包成 `{ readFile, listDir }` 的 workspace，供工具循环（`agentic.js` 的 `makeReadCodeTool` / `makeListFilesTool`，`agentic.js:179` / `agentic.js:115`）访问真实仓库。

- `rootAbs = path.resolve(cwd)`（仓库绝对根，`lib/agentic-host.js:112`）。
- `absOf(rel)`（`lib/agentic-host.js:114`–`lib/agentic-host.js:112`）：把相对路径解析成绝对路径并校 「是否落在 `rootAbs` 内」——`abs === rootAbs` 或 `abs.startsWith(rootAbs + path.sep)` 才放行，否则返回 `null`（越界）。符号链接逃逸由 `safeRelPath`（`agentic.js:266`）先兜一层、这里 `absOf` 用真实路径再兜一层。
- `readFile(rel)`（`lib/agentic-host.js:120`–`lib/agentic-host.js:114`）：`absOf` 返回 `null` → 抛 `Error('越界路径：<rel>')`；否则 `fs.readFileSync(abs, 'utf8')`。注意是**同步** `readFileSync`（工具侧 `makeReadCodeTool` 用 `await` 等它，见 `agentic.js:139`）。
- `listDir(rel)`（`lib/agentic-host.js:125`–`lib/agentic-host.js:128`）：`rel` 缺省为 `'.'`；越界抛错；`fs.readdirSync(abs, { withFileTypes: true })` 后把每个 `Dirent` 映射成 `{ path, dir: e.isDirectory() }`。`path` 字段：传 `.` 时用 `e.name`，否则用 `<rel 去尾斜杠>/<e.name>`——即**列出的是相对 `cwd` 的完整相对路径**（`test-agentic-host.mjs:154`–`test-agentic-host.mjs:158` 验证子目录返回 `'src/a.js'`）。

### 与 `agentic.js` 的契约（消费方视角）

本模块不定义工具实现本身，只提供「streamFn 与 workspace 两块拼图」。真正被 `runAgenticArticle` 用的是：

- `streamFn`（`makeHostStream` 产物）喂给循环；
- `workspace`（`makeFsWorkspace` 产物）喂给 `buildToolset`（见 `agentic.js:279`）里的 `read_code` / `list_files` 工具。

工具集的其它部分（`edit_article` / `generate_sub_module`）由 `agentic.js` 自己实现，不依赖本模块。

### 子模块拆分判断

本模块只有 3 个导出组件（互转 / streamFn / workspace），职责边界单一（一个适配器层），不值得再拆成独立子文章，故全部在本文件内写完。
## Architecture

组件数 ≥ 3、且数据经过「裸消息 → 宿主消息 → 收流 → 工具读写盘」多步，故画框图。

```text
                  runAgenticArticle (lib/agentic.js:331)
                   │  纯逻辑工具循环，消费 blocks
                   │
        streamFn   │   workspace
        ┌──────────┴──────────┐
        ▼                     ▼
 makeHostStream            makeFsWorkspace
 (lib/agentic-host.js:83)  (lib/agentic-host.js:111)
        │                     │
        │ llm.stream(...)     │ readFileSync / readdirSync
        ▼                     ▼
   @deepseek-ai/dsh-llm   cwd 内真实文件 (rootAbs)
   llm.stream + BlockAssembler
        │  chunk 流
        ▼
   toRequestMessages ◄── 裸消息 {role, content}
   (lib/agentic-host.js:34)   │
        │  RequestMessage[]    │  id/source 稳定（IDENTITY WeakMap）
        ▼                     │
   createUser/Assistant/      │
   ToolResultMessage          │
   (dsh-llm)                  │
                              ▼
                    safeRelPath 越界防护 (agentic.js:266)
                    + absOf 真实路径二次兜底
```

要点：

- **消息身份稳定**：`toRequestMessages` 通过 `IDENTITY` WeakMap（`lib/agentic-host.js:26`）把裸对象映射到正式 `Message`，保证循环多次重跑同一对象时 `id` 不变（测试见 `test-agentic-host.mjs:171`–`test-agentic-host.mjs:184`）。
- **tool 一拆多**：一条 `tool` 裸消息在 `lib/agentic-host.js:58`–`lib/agentic-host.js:29` 展开成 N 条 `ToolResultMessage`，靠 `stableKeyFor` 区分（`lib/agentic-host.js:29`）。
- **workspace 越界双重防护**：`safeRelPath`（`agentic.js:266`）先拦 `../`，`absOf`（`lib/agentic-host.js:114`）再用真实绝对路径确认不逃出 `cwd`。
- **streamFn 与 workspace 是两块独立拼图**：`makeHostStream` 只管 llm 那侧，`makeFsWorkspace` 只管文件系统那侧，二者在 `runAgenticArticle` 与 `buildToolset` 处汇合，由上游 `lib/articles-agentic.js` 注入。
## Data Flow

以一次正常 agentic 写作为例（串联 `lib/articles-agentic.js` → `lib/agentic-host.js` → 宿主 `llm`）：

1. **装配**（`articles-agentic.js:33`–`articles-agentic.js:64`）：`runOneArticle` 先 `makeFsWorkspace(fsImpl, pathImpl, cwd)` 得到 workspace，再 `makeHostStream({ llm, provider, model, reasoningEffort, onDelta })` 得到 `streamFn`（未注入 `injectedStreamFn` 时）。
2. **进入循环**（`agentic.js:331`）：`runAgenticArticle({ mission, streamFn, workspace, editor, onSubModule, maxSteps, ... })`。首轮构造 user 消息（含开场提示词 `buildOpeningPrompt`，`agentic.js:506`）。
3. **单步请求**（`agentic.js:373`）：`streamFn({ messages, tools: schemas, signal })` 即 `makeHostStream` 返回的闭包被调用。
4. **裸消息 → 宿主消息**（`agentic-host.js:87`）：`toRequestMessages(messages, { provider, model })` 把循环里累积的 `{role, content}` 裸消息转成 `RequestMessage[]`（带 `id`/`source`，tool 一拆多）。
5. **调宿主**（`agentic-host.js:88`）：`llm.stream({ provider, model, messages: reqMessages, tools, temperature: 0, ... })` 拿到 `asyncIterator<chunk>`。
6. **收流**（`agentic-host.js:86`–`agentic-host.js:98`）：`BlockAssembler.push(chunk)` 逐块收；`onDelta(chunk)` 可选回调。
7. **收尾**（`agentic-host.js:100`–`agentic-host.js:106`）：`finish = assembler.finish`；error/aborted 抛错，否则返回 `{ blocks, finish, usage }`。
8. **工具执行**（`agentic.js:385`–`agentic.js:423`）：模型 `blocks` 里的 `tool-call` 被取出执行。其中 `read_code` / `list_files` 走 `workspace`：
   - `read_code` → `makeReadCodeTool`（`agentic.js:115`）`await workspace.readFile(safe)`（`agentic.js:139`）→ `makeFsWorkspace.readFile`（`agentic-host.js:120`）走 `absOf` 越界校验 + `fs.readFileSync`。
   - `list_files` → `makeListFilesTool`（`agentic.js:179`）`await workspace.listDir(rel, depth)`（`agentic.js:186`）→ `makeFsWorkspace.listDir`（`agentic-host.js:125`）。
   - 工具结果作为 `tool-result` 消息回灌进 `messages`（`agentic.js:421`）。
9. **迭代**：回到第 3 步，直到模型不再发 `tool-call`（写完了，stopReason=`finished`，`agentic.js:393`–`agentic.js:369`）或触顶（`maxSteps`/`stream-error`/`aborted`/`empty-response`）。
10. **落盘**（`articles-agentic.js:33`–`articles-agentic.js:146`）：`runOneArticle` 拿到 `out.article`，经 `fixAnchors` 后写 `task.articlePath`，且受 `allowedWritePaths` 写集闸门约束（`isWritable`，`articles-agentic.js:96,155-167`）。

**失败数据流**：`llm.stream` 中途 `finish.kind === 'error'|'aborted'` → `makeHostStream` 抛错（`agentic-host.js:83`–`agentic-host.js:103`）→ `runAgenticArticle` 的 `try/catch` 把它记进 `steps` 并置 `stopReason='stream-error'`（`agentic.js:363`–`agentic.js:331`）→ `runOneArticle` 返回 `{ ok:false, stopReason }`（`articles-agentic.js:33`–`articles-agentic.js:69`）。顶层 `index.js` 在 `tickArticles` 里若失败率过半则退回单轮通道重跑失败篇。
## Connections

- **[[agentic]]**（核心上游，`lib/agentic.js`）：本模块是 `runAgenticArticle`（`agentic.js:331`）的宿主适配层。它消费的 `streamFn` 由 `makeHostStream` 提供，`workspace` 由 `makeFsWorkspace` 提供；工具实现（`read_code`/`list_files`/`edit_article`/`generate_sub_module`）则在 `agentic.js` 里用 `buildToolset`（`agentic.js:279`）组装，其中 `read_code`/`list_files` 内部引用 `workspace` 的 `readFile`/`listDir`。路径越界的第一道闸 `safeRelPath`（`agentic.js:266`）也归 `agentic.js`。
- **[[articles-agentic]]**（`lib/articles-agentic.js`）：唯一的生产入口装配本模块。`runOneArticle`（`articles-agentic.js:33`）在 `articles-agentic.js:64`–`articles-agentic.js:69` 同步构造 `workspace` 与 `streamFn`；`runAgenticArticles`（`articles-agentic.js:231`）是并发池，把任务批量交给 `runAgenticArticle`。子模块派发（`dispatchSub`，`articles-agentic.js:83`）递归调用 `runOneArticle`，每层重建自己的 `workspace` + `streamFn`。
- **[[index]]**（`index.js`）：编排服务一侧。`startAgenticRun`（index.js）调 `runAgenticArticles` 并把结果写进 `batchResults` 交由 `settleJob` 收割；`tickArticles`（index.js）在 agentic 通道大面积失败时（`shouldFallBackHere`，index.js）把失败篇退回单轮通道（`prepareArticleTasks` + `submitBatchFor`）。agentic 通道的开关于 `c0.agenticArticles` 配置（index.js）决定。
- **宿主 llm 服务（`@deepseek-ai/dsh-llm`）**：本模块直接依赖其导出 `BlockAssembler` / `createUserMessage` / `createAssistantMessage` / `createToolResultMessage`（`agentic-host.js:11`–`agentic-host.js:13`）。`llm.stream` 的入参形态（`provider`/`model`/`messages`/`tools`/`temperature`/`signal`/`reasoningEffort`）即本模块 `makeHostStream` 拼的请求体形态。
- **[[article-contract]]**（`lib/article-contract.js`）：间接。本模块不管写盘；`runOneArticle` 用 `makeWriteSet`/`isWritable`（`articles-agentic.js:67`、`:155`）做写集闸门，与 workspace 的越界防护构成「读 / 写」两道边界。

### 相关测试

- `test-agentic-host.mjs`：本模块专属测试，覆盖 `toRequestMessages`（user/assistant/tool 展开/身份稳定/未知 role）、`makeHostStream`（收流、tools 透传、无 tools、error 抛错、缺 llm、reasoningEffort）、`makeFsWorkspace`（读、列目录、子目录相对路径、越界读/列）。
- `test-agentic.mjs`、`test-articles-agentic.mjs`、`test-articles-agentic` 相关用例从上层消费本模块（通过 `articles-agentic.js` 的 `runOneArticle`）。
## Known Issues

- **`stableKeyFor` 的 `index` 参数实际从未传入**。`lib/agentic-host.js:29` 定义了 `index` 形参并拼进键（`${role}#${index ?? ''}#...`），但唯一调用点（`lib/agentic-host.js:64`）只传 `(role, r)`，未传 `index`，因此键里 `index` 段恒为空。目前靠 `toolCallId` 区分同一 tool 消息内的多条结果，尚未出问题；若未来同一 `toolCallId` 出现多次结果会撞键。属潜在脆弱点，非当前 bug。
- **tool `content` 的「文本化」会吞掉结构化内容**。`lib/agentic-host.js:69` 把非 `{type:'text'}` 的 `content` 直接 `String(r.content ?? '')` 包成单个 text 块。若工具回的是 `{type:'json'}` 之类结构化块，这里会丢类型信息、只留字符串化结果。当前 `agentic.js` 的工具实现（`makeReadCodeTool` 等，`agentic.js:115`–`agentic.js:197`）回的都是 `{type:'text', text}`，所以无影响。
- **`readFile` 用同步 `readFileSync`**（`lib/agentic-host.js:123`）。工具侧 `makeReadCodeTool` 用 `await` 等它（`agentic.js:139`），但底层并不真正异步。大文件读取会阻塞事件循环；`agentic.js` 侧已有 `MAX_READ_LINES`（2000）/ `MAX_READ_CHARS`（40000）上限（`agentic.js:96`–`agentic.js:93`）缓解，但超大单行文件仍会一次性读进内存（只被字符上限截断，仍先读全文）。
- **listDir 的深度参数 `depth` 被忽略**。`makeFsWorkspace.listDir`（`lib/agentic-host.js:125`）签名为 `(rel)`，但上游 `makeListFilesTool` 调用时传了 `depth`（`agentic.js:186`）。本模块 `listDir` 只 `readdirSync(abs)` 列**单层**，不递归；递归/忽略目录的逻辑全在 `agentic.js` 的 `makeListFilesTool`（`agentic.js:179`–`agentic.js:186`，含 `IGNORED_DIRS` 过滤）里。这点与 `agentic.js` 的接口约定一致，但调用方传 `depth` 在此是个 no-op，阅读时容易误以为会递归。
- **无显式禁用 / 注释掉的死代码**：经通读 `lib/agentic-host.js` 全文，本模块没有功能被禁用、注释屏蔽或保留的 stub；所有导出均为活跃实现。
