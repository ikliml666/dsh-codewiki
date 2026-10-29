---
title: engine_openai_bridge
type: module
source_files:
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - lib/engine/native-run.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - lib/engine/contract.js
  - lib/engine/client.js
tags: [openai, bridge, sse, llm, conversion, agentic]
---

## Overview

`lib/engine/openai-bridge.js` 是「OpenAI-compatible ↔ DSH LLM」的**纯转换层**（阶段 1B）。它没有任何 I/O、网络或密钥处理，只做两类转换：

- **请求方向**：把引擎发来的 OpenAI `chat.completions` 请求体翻译成 DSH 的 `GenerateOptions`（`toLlmRequest`，`lib/engine/openai-bridge.js:128`）。
- **响应方向**：把 DSH 的 `StreamChunk` 流折叠成 OpenAI 响应，支持非流式 JSON（`chunksToCompletion`，`lib/engine/openai-bridge.js:236`）和流式 SSE（`chunksToSse`，`lib/engine/openai-bridge.js:265`）。

它存在的根本原因写在文件头注释里（`lib/engine/openai-bridge.js:1-27`）：FSoft 原生引擎只认 OpenAI-compatible 的 `base_url` + `api_key`，而 DSH 的凭证在宿主 provider 配置里，插件既不保存也不传递密钥（0.10.1 起的硬约束）。因此桥是一个跑在 `127.0.0.1` 上的进程内 HTTP 端点（见 [[engine_llm_bridge]] 的 `startLlmBridge`），引擎拿着占位 key 打过来，桥把它转成 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider。

把这部分抽成纯转换、不碰网络与密钥，是为了让最容易出错、且错了极难查的点能被 TDD 钉死。配套测试 `test-engine-bridge.mjs` 只测纯转换，不下服务器；服务器边界行为由 `test-engine-llm-bridge.mjs` 覆盖。

安全边界（`lib/engine/openai-bridge.js:26-27`）：占位 key 是桥自己生成的固定串（`dsh-bridge-[a-z0-9-]+`，`lib/engine/openai-bridge.js:27`），桥只接受它；`toLlmRequest` 的返回值里永远没有 `apiKey` 字段。

## Key Components

本模块对外导出一组纯函数与常量，全部位于 `lib/engine/openai-bridge.js`。以下是完整清单（行号以源码前缀为准）：

### 常量与校验

- `PLACEHOLDER_KEY_PATTERN`（行 `29`，导出）：`/^dsh-bridge-[a-z0-9-]+$/` 正则，用于校验桥自己生成的占位 key 格式。
- `isPlaceholderKey(value)`（行 `31-33`，导出）：若 `value` 为字符串且匹配 `PLACEHOLDER_KEY_PATTERN` 返回 `true`，否则 `false`。空串、`undefined`、真实 key（`sk-...`）一律返回 `false`（测试见 `test-engine-bridge.mjs:340-346`）。

### 请求方向（OpenAI → DSH）

- `toLlmRequest({ provider, model, reasoningEffort, body })`（行 `128-161`，导出）：OpenAI 请求体 → DSH `GenerateOptions` 子集（不含 `signal`/`sessionId`，那些由服务器层加）。
  - 缺 `provider`/`model` → 抛错（行 `129-130`）；
  - `body.messages` 必须非空数组，否则抛 `messages` 错误（行 `131-132`）；
  - 逐条消息经 `messageToDsh` 拆成 `RequestMessage`，`system`/`developer` 角色的文本被抽到 `system` 槽（多段用 `\n` 合并，行 `148-152`），其余进 `messages`（行 `134-145`）；
  - 除 system 外没有任何消息 → 抛错（行 `146`）；
  - `tools` 经 `toolsToSchemas` 映射（行 `155-156`）；`temperature`/`max_tokens`(→`maxTokens`)/`stop` 条件映射（行 `157-159`）；`reasoningEffort` 透传（行 `154`）；
  - **返回值里永远不含 `apiKey` 字段**（安全边界，测试见 `test-engine-bridge.mjs:348-356`）。
- `messageToDsh(msg, route)`（行 `76-122`，模块内私有）：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。
  - `system`/`developer`（行 `79-83`）：抽成纯文本，交给调用方合并进 system 槽；
  - `user`（行 `84-87`）：经 `contentToBlocks` 摊平；
  - `assistant`（行 `88-111`）：`content` 可能为 `null`，但消息必须保留（否则工具循环断链，行 `69-70`）；`tool_calls` 还原成 `tool-call` 块，`arguments` 保持**原始 JSON 字符串**（行 `90-100`）；`source` 字段按 `route.{provider,model}` 填上 `{ kind: 'model', provider, model }`（行 `103-110`，缺 source 宿主 `forAdapter` 会读 `source.replayState` 抛错，见 Known Issues）；
  - `tool`（行 `112-120`）：映射成 `tool` 角色消息，`toolCallId` 取自 `msg.tool_call_id`，`isError` 仅当 `msg.is_error === true`（行 `117`）。
- `contentToBlocks(content)`（行 `38-51`，私有）：OpenAI 的 `content`（string 或 parts 数组）统一摊平成 DSH `ContentBlock[]`；非文本部分（如 `image_url`）显式跳过（行 `46`）。空/非对象返回 `[]`。
- `toolsToSchemas(tools)`（行 `53-66`，私有）：`tools[].function` → `{ name, description, parameters }` 的 `ToolSchema`；`parameters` 缺失时兜底为 `{ type: 'object', properties: {} }`（行 `62`）。无有效工具返回 `undefined`（让 agentic 工具循环不会退化）。
- `textBlock(text)`（行 `35`，私有）：构造 `{ type: 'text', text }` 文本块，空值兜底为 `''`。

### 响应方向（DSH chunk 流 → OpenAI）

- `finishReasonToOpenAI(reason)`（行 `164-173`，导出）：`FinishReason` → OpenAI `finish_reason`。映射：`tool-calls`→`tool_calls`、`max-tokens`→`length`、`error`/`aborted`→`error`、`stop`→`stop`、未知→`stop`（行 `165-172`）。
- `usageToOpenAI(usage)`（行 `176-188`，私有）：把 DSH **互斥** token 计数折算成 OpenAI 字段。关键：OpenAI 的 `prompt_tokens` **含缓存**，故 `prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`（行 `181`）；`cached_tokens` 单列在 `prompt_tokens_details`（行 `186`）；`total_tokens = prompt + output`（行 `185`）。
- `foldChunks(chunks)`（行 `192-233`，私有）：把 chunk 流折叠成「文本 + 按 index 拼接的工具调用 + usage + finish」中间态。这是非流式与流式两条路径的共同起点（行 `190-191`）。
  - `text-delta`（行 `199-201`）：累加进 `text`；
  - `tool-call-delta`（行 `202-210`）：按 `index` 存入 `calls` Map，`argumentsDelta` 逐段拼接（行 `207`）；
  - `usage`/`finish`（行 `211-216`）：覆盖式记录；
  - `reasoning-delta`/`block-start`/`block-end` 一律忽略（行 `217-219`，思考不进正文）；
  - 产出时只保留**有 name** 的调用（无 name 引擎无法执行，行 `222-226`）；`id` 缺失时随机生成 `call_<rand>`（行 `228`）；`arguments` 空兜底 `'{}'`（行 `230`）。
- `chunksToCompletion({ id, model, chunks })`（行 `236-256`，导出）：chunk 流 → 非流式 OpenAI 响应体。
  - `id` 缺省 `chatcmpl-${Date.now()}`，`created = Math.floor(Date.now()/1000)`（行 `240-242`）；
  - `message.content`：有文本用文本，纯工具调用时 `null`（不是空串，OpenAI 语义，行 `249`）；
  - `finish_reason`：有 finish 用映射结果，否则按「有工具调用→`tool_calls`/否则 `stop`」兜底（行 `252`）；
  - `usage` 经 `usageToOpenAI` 折算（行 `254`）。
- `sseFrame(payload)`（行 `259-262`，导出）：把 payload 序列化并包成 `data: <json>\n\n`；`payload` 为字符串时原样（用于 `[DONE]`）。测试断言格式见 `test-engine-bridge.mjs:274-277`。
- `chunksToSse({ id, model, created, chunks })`（行 `265-317`，导出）：chunk 流 → SSE 帧数组（末帧 `[DONE]`）。
  - `text-delta`：首帧带 `role: 'assistant'`（行 `269`,`276`），逐帧 `content` 增量（行 `274-279`）；
  - `tool-call-delta`：逐帧 `tool_calls[].function.arguments` 片段，带 `id`/`name` 片段（行 `280-296`）；
  - `usage`：单独成帧（`choices: []` + `usage`，行 `297-300`）；
  - `finish`：终帧带 `finish_reason`；若整轮是工具调用但 `finish` 标 `stop`，纠正为 `tool_calls`（行 `302-308`）；
  - 流没给 `finish` 也要补一个终帧，否则引擎的流读取会挂住（行 `310-314`）；最后推 `[DONE]`（行 `315`）。

### 类型/契约约定（模块消费方）

本模块不直接定义 class，但强依赖于 DSH 侧的几个数据结构（其形状由 `lib/engine/contract.js` 与宿主 `llm` 约定的 `GenerateOptions`/`StreamChunk` 决定）：

- `GenerateOptions`（入参子集）：`{ provider, model, system?, messages, tools?, temperature?, maxTokens?, stop?, reasoningEffort? }`，其中 `messages` 元素为 `RequestMessage`（`{ role, content: ContentBlock[], source? }`）。
- `ContentBlock`：文本为 `{ type: 'text', text }`，工具调用为 `{ type: 'tool-call', id, name, arguments }`（**arguments 为原始 JSON 字符串**），工具结果为 `{ role: 'tool', toolCallId, isError, content }`。
- `StreamChunk`：`{ type: 'text-delta'|'tool-call-delta'|'usage'|'finish'|'reasoning-delta'|..., ... }`，`tool-call-delta` 含 `index`/`id`/`name`/`argumentsDelta`，`usage` 含 `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`，`finish` 含 `reason: { kind }`。

> 注：桥本身没有"被禁用/注释掉"的代码——整个文件都是阶段 1B 的活跃转换逻辑，无 `disabled` 标记。

## Architecture

桥是「纯转换」核心（`openai-bridge.js`），被服务器层 `llm-bridge.js` 的 `startLlmBridge`（[[engine_llm_bridge]]）包裹成 127.0.0.1 端点，再由 `native-run.js` 的 `runNativeJob`（[[engine_native_run]]）在每次编译里启动并关闭。框图如下：

```text
 FSoft 原生引擎 (OpenAI 客户端)
        │  POST /v1/chat/completions (占位 key)
        ▼
┌─────────────────────────────────────────────────────┐
│ llm-bridge.js: startLlmBridge (createServer)         │
│   · 校验 PLACEHOLDER_KEY_PATTERN + 随机 key          │
│   · 读 body → 调 toLlmRequest                        │
└───────────────────────┬─────────────────────────────┘
                         │  GenerateOptions (无 apiKey)
                         ▼
┌─────────────────────────────────────────────────────┐
│ openai-bridge.js (纯转换, 无 I/O/无密钥)             │
│   request:  toLlmRequest / messageToDsh /            │
│             contentToBlocks / toolsToSchemas         │
│   response: foldChunks ─┬─ chunksToCompletion       │
│                         └─ chunksToSse / sseFrame    │
│             finishReasonToOpenAI / usageToOpenAI     │
└───────────────────────┬─────────────────────────────┘
                         │  llm.stream(GenerateOptions)
                         ▼
             宿主 llm 服务 (真实凭证, 插件不可见)
                         │  StreamChunk 流
                         ▼
           回写 SSE 帧 / 非流式 JSON → 引擎
```

组件关系要点：

- `openai-bridge.js` 与 `llm-bridge.js` 是依赖关系：`llm-bridge.js:26-31` 从 `openai-bridge.js` 引入 `PLACEHOLDER_KEY_PATTERN`/`chunksToCompletion`/`chunksToSse`/`toLlmRequest`。
- 纯转换层不持有 `llm`、不碰网络；`llm-bridge.js` 才负责 `createServer`、占位 key 随机生成（`llm-bridge.js:100`）、`/healthz`、`/v1/models`、流式中途失败的终止帧处理（`llm-bridge.js:189-203`）等边界行为。
- `native-run.js:381-407` 在「模型桥」一步里 `await bridgeImpl({ llm, provider, model, reasoningEffort })` 启动桥，并把 `bridge` 注入引擎描述（`engineFor({ requestId, bridge })`），`finally` 块确保引擎退出后关闭桥（`native-run.js:454-457`）。

## Data Flow

### 请求方向（引擎 → 宿主）

1. 引擎向 `http://127.0.0.1:<port>/v1/chat/completions` 发 OpenAI 请求体，带 `Bearer <placeholderKey>`（请求侧示例见 `test-engine-llm-bridge.mjs:47-55` 的 `post` 工具；桥侧取 bearer 与校验在 `llm-bridge.js:38-43` 与 `llm-bridge.js:118-126`）。
2. `llm-bridge.js` 先校验占位 key（行 `118-126`），再 `JSON.parse` body（行 `139-147`），调用 `toLlmRequest({ provider, model, reasoningEffort, body })`（行 `151`）。
3. `toLlmRequest`（`openai-bridge.js:128`）遍历 `body.messages`，经 `messageToDsh` 拆成 `RequestMessage`：`system`/`developer` 文本进 `system` 槽，`user`/`assistant`/`tool` 进 `messages`，`assistant.tool_calls` 还原成 `tool-call` 块（arguments 保持原始 JSON 字符串），`tool` 消息映射成 `toolCallId` 配对的工具结果；`tools` 经 `toolsToSchemas` 转成 `ToolSchema`（行 `155`）。
4. 得到的 `GenerateOptions`（**无 apiKey**）加上 `signal` 后交给 `llm.stream`（行 `171`），触发宿主用真实凭证调 provider。

### 响应方向（宿主 → 引擎）

两条路径共用 `foldChunks`（`openai-bridge.js:192`）折叠逻辑，避免行为分叉（注释见行 `23-24`、`190-191`）：

- **非流式**：`llm-bridge.js:216` 调 `chunksToCompletion({ id, model, chunks })`，得到完整 `chat.completion` JSON，`sendJson` 返回（行 `218`）。
- **流式**：`llm-bridge.js:183` 在收到每个 chunk 时调 `chunksToSse({ id, model, chunks: [chunk] })` 逐帧下发（边收边转，行 `182-187`），收尾统一发 `[DONE]`（行 `210`）。注意 `chunksToSse` 本身会补 `[DONE]`，逐帧发时要把该终帧留给收尾（行 `184`）。
- `usage` 在流式里单独成帧（`chunksToSse` 行 `297-300`），非流式里并进最终 `usage` 字段（`chunksToCompletion` 行 `254`）。token 折算：`prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 `prompt_tokens_details.cached_tokens`（`usageToOpenAI` 行 `181-186`）。

### 关键数据形态对照

| DSH 侧 | OpenAI 侧 | 转换位置 |
|---|---|---|
| `message.content=[]`（仅 tool-call） | `message.content: null` | `chunksToCompletion` 行 `249` |
| `tool-call` 块（arguments 原始字符串） | `tool_calls[].function.arguments`（拼接后完整 JSON） | `foldChunks` 行 `202-231` |
| `FinishReason.kind` | `finish_reason` 字符串 | `finishReasonToOpenAI` 行 `164` |
| `inputTokens/cacheRead/cacheWrite` | `prompt_tokens`/details | `usageToOpenAI` 行 `181-186` |
| `reasoning-delta` | （不出现） | `foldChunks` 行 `217-219` |

## Connections

- [[engine_llm_bridge]] — `lib/engine/llm-bridge.js` 的 `startLlmBridge` 是桥的服务器外壳：绑定 127.0.0.1 随机端口、生成并校验占位 key、调用本模块的 `toLlmRequest`/`chunksToCompletion`/`chunksToSse`，并处理流式中断/超时等边界行为。
- [[engine_native_run]] — `lib/engine/native-run.js` 的 `runNativeJob` 在「模型桥」一步（`native-run.js:109-135`）启动桥，把 `bridge.url`/`placeholderKey` 注入引擎描述，并在引擎退出后关闭桥（`native-run.js:55-58`）。
- [[engine_contract]] — `lib/engine/contract.js` 定义了 `engine-model` 错误码与 `BLOCKER_KINDS`，桥建立失败会映射成 `engine-model`（`native-run.js:87-98`）；`GenerateOptions`/`StreamChunk` 的语义与上游 provider 约定相关。
- [[engine_client]] — `lib/engine/client.js` 的 `runEngine` 是跨进程跑 Python 引擎的适配层；桥通过 `engineFor` 拿到的引擎描述间接服务于该通道。
- 测试契约：[[engine_bridge_tests]] 不在独立模块，本模块的直接测试为 `test-engine-bridge.mjs`（纯转换）与 `test-engine-llm-bridge.mjs`（服务器边界）。

## Known Issues

- **`assistant` 历史消息必须带 `source`（阶段 1C 真实模型暴露的回归，行 `71-75`、`368-389` 的测试）**：宿主 `LlmRuntime.forAdapter()` 会无条件读 `message.source.replayState` 来决定是否丢弃跨适配器的 replay 数据；桥生成的 assistant 消息若没有 `source`，就抛 `Cannot read properties of undefined (reading 'replayState')`，宿主把整轮调用判为 finish=error，引擎侧表现为 "Please return text or call a tool." 然后耗尽重试。**纯单测抓不到，只有真跑一次工具往返才会炸**。桥没有 replay 能力，所以只在 `route.{provider,model}` 都齐时填 `{ kind: 'model', provider, model }`（行 `103-110`），并**不伪造** `replayState`（测试 `test-engine-bridge.mjs:391-400` 断言 `source.replayState === undefined`）。

- **`tool` 消息必须带 `toolCallId`（行 `112-119`、`402-415`）**：宿主按 callId 配对工具结果与工具调用，缺了就断链。桥从 `msg.tool_call_id` 取（行 `116`）。

- **无 name 的 tool-call-delta 必须丢弃（行 `222-226`、`245-256`）**：DSH 增量拼接出的工具调用若没有 `name`，引擎无法执行，混进去只会制造噪音让引擎报莫名其妙的错误。`foldChunks` 过滤掉 `!v.name` 的调用；`id` 缺失时随机兜底（行 `228`）。

- **流式与非流式必须同源（行 `23-24`、`190-191`）**：两条响应路径都从 `foldChunks` 出发，否则引擎在流式路径上会拿到半截 tool_calls。这是 `test-engine-bridge.mjs:13-15` 明确钉死的不变量。

- **流式必须以 `[DONE]` 收尾（行 `310-315`、`llm-bridge.js:103`）**：`chunksToSse` 在流没给 `finish` 时补终帧，否则引擎的 SSE 读取会挂住。流式中途失败也用「错误帧 + `[DONE]`」收尾（`llm-bridge.js:193-199`），不挂住客户端（测试 `test-engine-llm-bridge.mjs:151-163`）。

- **`usage` 字段名不是简单透传（行 `176-188`）**：DSH 的 `inputTokens` 是**不含缓存**的净输入，而 OpenAI 的 `prompt_tokens` 含缓存，故 `prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 `prompt_tokens_details.cached_tokens`。错配会让引擎的用量账本对不上（测试 `test-engine-bridge.mjs:217-224`）。

- **`toLlmRequest` 绝不携带 api key（行 `26-27`、`348-356`）**：桥不保存、不转发、不接收真实密钥是 0.10.1 起的硬约束。占位 key 由 `llm-bridge.js:96` 随机生成，桥只认它自己这一次的 key（`llm-bridge.js:118-126`），错误响应不回显收到的 key（避免把用户误配的真实 key 写进日志，行 `123-124`）。

- **多模态 content 数组只取文本部分（行 `46`）**：`image_url` 等非文本 part 当前不参与引擎写作（引擎只发文本），被显式跳过而不是造块。若将来要支持图，这里是改动点。

