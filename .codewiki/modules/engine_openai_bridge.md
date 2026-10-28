---
title: engine_openai_bridge
type: module
source_files:
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - lib/engine/contract.js
  - index.js
  - lib/agentic-host.js
  - lib/engine/mapping.js
tags: [engine, openai, sse, protocol, bridge, llm, loopback]
---

## Overview

`lib/engine/openai-bridge.js` 是 FSoft 原生引擎与 DSH LLM 之间的**纯协议转换层**（注释里称为「阶段 1B」）。它**没有任何 I/O、网络或密钥**——只做两件最容易悄然出错、且错了极难排查的纯函数转换，以便被 `test-engine-bridge.mjs` 用 TDD 钉死：

1. 请求方向：把 OpenAI `chat.completions` 请求体翻译成宿主的 `GenerateOptions`（`toLlmRequest`，定义在 `lib/engine/openai-bridge.js:128`）。
2. 响应方向：把 DSH 的 `StreamChunk` 流折叠成 OpenAI 非流式 JSON（`chunksToCompletion`，`lib/engine/openai-bridge.js:236`）或流式 SSE 帧数组（`chunksToSse`，`lib/engine/openai-bridge.js:265`）。

它存在的根本原因是**凭证边界**：FSoft 原生引擎只认 OpenAI-compatible 的 `base_url` + `api_key`（`lib/engine/openai-bridge.js:3`），而 DSH 的凭证在宿主 provider 配置里、插件从 0.10.1 起既不保存也不传递密钥（`lib/engine/openai-bridge.js:3`）。因此转换层本身不持有任何真实 key，只接受桥自己生成的占位 key，且 `toLlmRequest` 的返回值里**永远不出现 `apiKey` 字段**（`lib/engine/openai-bridge.js:27`、`test-engine-bridge.mjs:355`）。

本文件只负责「纯转换」；真正把转换接到网络、签发占位 key、校验准入、对接宿主 `llm.stream` 的薄 HTTP 层在 `lib/engine/llm-bridge.js`（`startLlmBridge`，`lib/engine/llm-bridge.js:90`）。两者分工：本模块 = 纯函数，llm-bridge = 进程内 server + 凭证看门人。流式与非流式两条响应路径共用 `foldChunks`（`lib/engine/openai-bridge.js:192`）这个中间折叠器，保证行为同源、不出现半截 `tool_calls`（`test-engine-bridge.mjs:13`）。

## Key Components

本模块（`lib/engine/openai-bridge.js`）导出 7 个符号，全部为纯函数 / 常量，无类、无状态。行号以源码前缀为准。

### 常量与校验

- `PLACEHOLDER_KEY_PATTERN`（常量，`lib/engine/openai-bridge.js:29`）：占位 key 的正则 `^dsh-bridge-[a-z0-9-]+$`。桥**只**接受自己生成、且每次启动随机的占位 key，真实 key 不应出现在引擎侧配置里（`lib/engine/openai-bridge.js:26`）。
- `isPlaceholderKey(value)`（`lib/engine/openai-bridge.js:31`）：纯函数，返回 `typeof value === 'string' && PLACEHOLDER_KEY_PATTERN.test(value)`。用于判断一个 bearer token 是否为桥自己签发的占位 key（`test-engine-bridge.mjs:340`）。注意它**只认格式**，不核对「是不是本次启动签发的那一串」——那一步由 `lib/engine/llm-bridge.js:120` 用全等比较补上。

### 内部辅助（未导出，但决定了转换语义）

- `textBlock(text)`（`lib/engine/openai-bridge.js:35`）：构造 `{ type:'text', text }` 块，`null/undefined` 兜底为空串。
- `contentToBlocks(content)`（`lib/engine/openai-bridge.js:38`）：把 OpenAI 的 `content`（string 或 parts 数组）摊平成 DSH 的 `ContentBlock[]`。数组里只处理 `type:'text'` 部分，并**显式跳过** `image_url` 等非文本部分——因为引擎只发文本（`lib/engine/openai-bridge.js:46`）。
- `toolsToSchemas(tools)`（`lib/engine/openai-bridge.js:53`）：把 OpenAI `tools[].function` 映射成 DSH `ToolSchema`（`{name, description, parameters}`）。缺 `parameters` 时兜底为 `{type:'object', properties:{}}`（`lib/engine/openai-bridge.js:62`）。**这一映射至关重要**：漏掉它，agentic 工具循环会退化成「模型说要调工具但永远调不到」（`test-engine-bridge.mjs:10`）。
- `messageToDsh(msg, route)`（`lib/engine/openai-bridge.js:76`）：单条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。角色处理：
  - `system` / `developer`：抽成 text，由调用方合并到 system 槽（`lib/engine/openai-bridge.js:79`）；
  - `user`：直接转 `ContentBlock[]`（`lib/engine/openai-bridge.js:84`）；
  - `assistant`：保留 `content`，并把 `tool_calls` 还原成 `tool-call` 块——`arguments` 保持**原始 JSON 字符串**（不 parse，避免破坏增量拼接，`lib/engine/openai-bridge.js:97`），且 assistant 历史消息**必须带 `source`**（`{kind:'model', provider, model}`），否则宿主 `LlmRuntime.forAdapter()` 读 `source.replayState` 会抛 `Cannot read properties of undefined`（`lib/engine/openai-bridge.js:71-75`、`test-engine-bridge.mjs:368`）；
  - `tool`：转成 `tool` 结果，`tool_call_id` → `toolCallId`、`is_error` → `isError`（`lib/engine/openai-bridge.js:117`）。

### 公开转换函数

- `toLlmRequest({ provider, model, reasoningEffort, body })`（`lib/engine/openai-bridge.js:128`）：OpenAI 请求体 → DSH `GenerateOptions` 子集（**不含** `signal/sessionId`，那些由服务器层加）。
  - 入参校验：缺 `provider`/`model` 抛错（`lib/engine/openai-bridge.js:129-130`）；`body.messages` 必须是非空数组，否则抛错（`lib/engine/openai-bridge.js:132`）。
  - 行为：遍历 messages 经 `messageToDsh` 后，system 角色并入 `system`（多段以 `\n` 连接，`lib/engine/openai-bridge.js:152`），其余入 `messages`；若除 system 外无任何消息也抛错（`lib/engine/openai-bridge.js:131`）。
  - 字段映射表（来源 → 目标）：
    | OpenAI 字段 | DSH 字段 | 备注（行号） |
    |---|---|---|
    | `messages[].role=system` | `system`（顶层字符串） | `:152`，无 system 时为 `undefined`（不塞空串，`test-engine-bridge.mjs:61`） |
    | `messages[].role=assistant` + `tool_calls` | `content` 里的 `tool-call` 块 | `:93-100`，arguments 原样字符串 |
    | `messages[].role=tool` | `{role:'tool', toolCallId, isError, content}` | `:112-119` |
    | `tools[].function` | `tools`（ToolSchema[]） | `:155`，缺则不设 |
    | `temperature` | `temperature` | `:157` |
    | `max_tokens` | `maxTokens` | `:158` |
    | `stop`（数组） | `stop`（字符串数组） | `:159` |
    | `reasoningEffort`（调用参） | `reasoningEffort` | `:154` |
  - **安全边界**：`api_key`、未知字段（`response_format`、`seed` 等）一律不进返回对象（`test-engine-bridge.mjs:134`、`test-engine-bridge.mjs:348`）。

- `finishReasonToOpenAI(reason)`（`lib/engine/openai-bridge.js:164`）：DSH `FinishReason.kind` → OpenAI `finish_reason`。映射：
  | DSH kind | OpenAI |
  |---|---|
  | `tool-calls` | `tool_calls` |
  | `max-tokens` | `length` |
  | `error` / `aborted` | `error` |
  | `stop` / 默认 | `stop` |
  （`lib/engine/openai-bridge.js:165-172`，`test-engine-bridge.mjs:181`）

- `chunksToCompletion({ id, model, chunks })`（`lib/engine/openai-bridge.js:236`）：chunk 流 → 非流式 OpenAI 响应体。
  - 经 `foldChunks` 折叠后组装：`object:'chat.completion'`、`choices[0].message`（`role:'assistant'`）；
  - **纯工具调用时 `content` 为 `null`** 而非空串（`lib/engine/openai-bridge.js:249`、`test-engine-bridge.mjs:227`）；
  - `finish_reason`：有 finish 用 `finishReasonToOpenAI`，否则有 toolCalls 取 `tool_calls`、否则 `stop`（`lib/engine/openai-bridge.js:252`）；
  - `usage` 经 `usageToOpenAI` 折算（`lib/engine/openai-bridge.js:254`）。

- `sseFrame(payload)`（`lib/engine/openai-bridge.js:259`）：把对象（或字符串）包成 `data: <json>\n\n` 或 `data: [DONE]\n\n`（`lib/engine/openai-bridge.js:261`、`test-engine-bridge.mjs:274`）。

- `chunksToSse({ id, model, created, chunks })`（`lib/engine/openai-bridge.js:265`）：chunk 流 → SSE 帧数组（每帧一个完整 chunk，末帧 `[DONE]`）。
  - 首帧带 `role:'assistant'`（`lib/engine/openai-bridge.js:195`）；`text-delta` 逐帧、`tool-call-delta` 逐帧带 `id/name/arguments` 片段（`lib/engine/openai-bridge.js:280`）；`usage` 单独成帧（`lib/engine/openai-bridge.js:297`）；
  - **流没给 finish 也要补终帧**，否则引擎的流读取会挂住（`lib/engine/openai-bridge.js:310-314`、`test-engine-llm-bridge.mjs:142`）。

### 内部折叠 / 用量折算

- `foldChunks(chunks)`（`lib/engine/openai-bridge.js:192`）：把 chunk 流折叠成 `{ text, finish, usage, toolCalls }` 中间态。按 `index` 把 `tool-call-delta` 拼成完整 `arguments`（`lib/engine/openai-bridge.js:202-210`），**只保留有 `name` 的调用**（无 name 引擎无法执行，混进去只会制造噪音，`lib/engine/openai-bridge.js:222-226`），缺 id 时随机补一个（`lib/engine/openai-bridge.js:228`）。`reasoning-delta`/`block-start`/`block-end` 不进正文（`lib/engine/openai-bridge.js:217`）。
- `usageToOpenAI(usage)`（`lib/engine/openai-bridge.js:176`）：DSH `TokenUsage` 是**互斥计数**（`inputTokens` 不含缓存），OpenAI 的 `prompt_tokens` 含缓存，故 `prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列进 `prompt_tokens_details.cached_tokens`（`lib/engine/openai-bridge.js:181-187`、`test-engine-bridge.mjs:223`）。公式：
  - `prompt_tokens = input + cacheRead + cacheWrite`
  - `completion_tokens = output`
  - `total_tokens = prompt + output`
  - `prompt_tokens_details.cached_tokens = cacheRead`

## Architecture

本模块是「纯转换」内核，被 `lib/engine/llm-bridge.js` 的 HTTP server 包裹。框图只画与转换相关的组件与边界（≤20 行）：

```text
 FSoft 引擎 (OpenAI client)
     │  POST /v1/chat/completions
     │  Bearer: dsh-bridge-<random>
     ▼
┌─────────────────────────────────────────┐
│ lib/engine/llm-bridge.js  startLlmBridge │  ← 凭证看门人：127.0.0.1 + 随机端口 + 占位 key 校验
│  readBody → toLlmRequest ───────────────┐│
└─────────────────────────────────────────┘│
                                           ▼
┌──────────────────────────────────────────────────────────┐
│ lib/engine/openai-bridge.js  (纯函数, 无 I/O 无密钥)        │
│  toLlmRequest(): OAI request ─► GenerateOptions  :128     │
│  foldChunks():   chunk 流 ─► {text,toolCalls,usage} :192  │
│  chunksToCompletion(): ─► OAI JSON              :236      │
│  chunksToSse():        ─► SSE 帧数组 + [DONE]   :265      │
│  finishReasonToOpenAI / usageToOpenAI / sseFrame          │
└──────────────────────────────────────────────────────────┘
     │ toLlmRequest 结果 (GenerateOptions, 无 apiKey)        │
     ▼                                                     │
┌──────────────┐    llm.stream(chunk…)    ┌─────────────────┐
│ 宿主 llm 服务 │ ◄───────────────────────│ (真实 provider, │
│ (凭证在此)    │   AbortController signal │  桥不持 key)    │
└──────────────┘                          └─────────────────┘
     │ chunk 流 (text-delta / tool-call-delta / usage / finish)
     ▼
 chunksToCompletion / chunksToSse  ──►  引擎收到的 OAI 响应 / SSE
```

关键边界：桥进程内运行（`127.0.0.1`，随机端口，`lib/engine/llm-bridge.js:230`），引擎只拿一个占位 key；真实凭证只在宿主 provider 内部，`toLlmRequest` 返回值里永远没有 `apiKey`（`lib/engine/openai-bridge.js:27`）。流式与非流式共用 `foldChunks`，保证两条路径行为同源（`lib/engine/openai-bridge.js:192`）。

## Data Flow

### 请求方向（引擎 → 宿主）

1. 引擎发 `POST /v1/chat/completions`，body 为 OpenAI 请求体；`llm-bridge.js:139` 读体，`llm-bridge.js:151` 调 `toLlmRequest({ provider, model, reasoningEffort, body })`。
2. `toLlmRequest`（`lib/engine/openai-bridge.js:128`）做入参校验，遍历 `body.messages`，逐条经 `messageToDsh`（`lib/engine/openai-bridge.js:76`）：
   - system/developer 文本并入 `system` 字符串；
   - user → `ContentBlock[]`；
   - assistant（可能带 `tool_calls`）→ `tool-call` 块 + 必要的 `source`；
   - tool → `toolCallId/isError` 结果消息。
   - `tools[].function` → `ToolSchema[]`（`toolsToSchemas`，`lib/engine/openai-bridge.js:53`）。
   - `temperature/max_tokens/stop` 做字段名映射（`lib/engine/openai-bridge.js:157-159`）。
3. 返回 `GenerateOptions` 子集（**无 `apiKey`、无未知字段**），`llm-bridge.js:4` 调 `llm.stream({ ...options, signal })`。

### 响应方向（宿主 → 引擎）

非流式与流式都从同一个 `llm.stream` 产出的 chunk 数组出发：

- 非流式：`llm-bridge.js:216` 调 `chunksToCompletion`，内部 `foldChunks`（`lib/engine/openai-bridge.js:192`）折叠 → 装成 `chat.completion` JSON，`sendJson` 回 200（`llm-bridge.js:218`）。
- 流式：`llm-bridge.js:183` 边收边调 `chunksToSse`，逐帧 `sseFrame` 写 `text/event-stream`；收尾补 `data: [DONE]\n\n`（`llm-bridge.js:210`）。上游中途失败 → 先写一个 error 事件帧再 `[DONE]`，避免客户端挂住（`llm-bridge.js:195-197`）。

### chunk 类型到 OpenAI 字段的折叠规则

`foldChunks`（`lib/engine/openai-bridge.js:192-214`）按 chunk `type` 分派：

| 输入 chunk | 折叠动作 | 目标 |
|---|---|---|
| `text-delta` | 累加 `text` | `message.content` |
| `tool-call-delta` | 按 `index` 拼 `arguments`，记 `id/name` | `message.tool_calls[]` |
| `usage` | 记录 `usage` | `usage` 字段 |
| `finish` | 记录 `reason` | `finish_reason` |
| `reasoning-delta` / `block-start` / `block-end` | 忽略 | 不进正文 |

## Connections

- [[engine_llm_bridge]]（`lib/engine/llm-bridge.js`）：本模块的唯一消费者。HTTP server 绑定 `127.0.0.1` 随机端口（`startLlmBridge`，`lib/engine/llm-bridge.js:90`/`230`），负责占位 key 签发（`lib/engine/llm-bridge.js:96`）、Bearer 校验通过后调 `toLlmRequest`（`lib/engine/llm-bridge.js:151`）、把 chunk 流转成 `chunksToCompletion`/`chunksToSse`（`lib/engine/llm-bridge.js:216`/`183`）。本模块的所有公开函数都从这里 import（`lib/engine/llm-bridge.js:26-31`）。
- [[engine_contract]]（`lib/engine/contract.js`）：定义跨进程契约（`ENGINE_CONTRACT_VERSION`/`ENGINE_STAGES` 等）；`lib/engine/mapping.js:256` 直接 import 了 `ENGINE_CONTRACT_VERSION`，但本模块不直接依赖 contract——两者同属 `lib/engine/` 的迁移适配层。
- [[agentic_host]]（`lib/agentic-host.js`）：宿主 `llm.stream` 的**另一**适配层（裸消息 → 正式 `Message`、工具循环一拆多）。本模块的 `toLlmRequest` 走的是**单轮整包**路径（引擎一次性把所有历史消息塞进 OpenAI 请求体），而 agentic-host 走的是插件内 agentic 工具循环（`lib/agentic-host.js:34`/`83`）；两者共享同一个宿主 `llm.stream` 入口语义。
- [[engine_mapping]]（`lib/engine/mapping.js`）：FSoft 产物 → `.codewiki/` 的映射层，与本模块同属 `lib/engine/`；本模块负责「引擎 ↔ 宿主 LLM」协议面，mapping 负责「引擎产物 ↔ CodeWiki 文章」格式面。
- [[index]]（`index.js`）：插件主入口。`llmRef`（`index.js:2263`）即本模块调用链末端的宿主 `llm` 服务；非流式/流式/会话通道都最终落到同一个 `llm.stream`。本模块当前在 `index.js` 里**未被生产路径 import**（搜索 `openai-bridge`/`startLlmBridge` 无命中于 `index.js`），属于「阶段 1B 已写完、待接线」的适配层，由 `test-engine-bridge.mjs` / `test-engine-llm-bridge.mjs` 覆盖契约与边界行为。

## Known Issues

- **未接入生产路径**：`lib/engine/openai-bridge.js` 的全部公开函数只在 `lib/engine/llm-bridge.js` 与两个测试文件里被 import，`index.js` 主流程尚未接线。若 FSoft 引擎上线，需把 `startLlmBridge` 的返回（`url`+`placeholderKey`）注入到引擎配置，并在 `index.js` 里随 `createJobService` 生命周期启停。
- **占位 key 只校验格式 vs 实例**：`isPlaceholderKey`（`lib/engine/openai-bridge.js:31`）只认 `PLACEHOLDER_KEY_PATTERN` 格式，真正「是不是本次启动签发的那一串」由 `lib/engine/llm-bridge.js:120` 的全等比较兜底。两处必须同时过，否则格式正确但非本实例签发的 key 会被放行。
- **`text-delta` 无 `index` 归并**：`foldChunks` 对 `text-delta` 直接字符串拼接（`lib/engine/openai-bridge.js:192-193`），未做按 index 的增量对齐——假设引擎发来的文本 chunk 顺序即最终顺序。若下游出现乱序文本 chunk，本模块不会纠正。
- **`tool-call-delta` 的 `arguments` 是字符串拼接**：`lib/engine/openai-bridge.js:207` 把每个 delta 的 `argumentsDelta` 直接字符串相加，依赖上游按 index 顺序、连续地吐片段；不做 JSON 合法性校验（完整 JSON 由引擎侧保证，`lib/engine/openai-bridge.js:13` 注释已说明不提前 parse）。无 `name` 的调用会被整体丢弃（`lib/engine/openai-bridge.js:226`）。
- **`source.replayState` 不伪造**：桥只填 `source.kind/provider/model`，**不伪造** `replayState`（`lib/engine/openai-bridge.js:75`/`test-engine-bridge.mjs:399`）。若未来宿主对 assistant 历史消息要求 `replayState` 字段，桥需补一份，否则 `forAdapter` 仍可能抛错。
