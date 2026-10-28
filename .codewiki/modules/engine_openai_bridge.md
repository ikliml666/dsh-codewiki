---
title: engine_openai_bridge
type: module
source_files:
  - lib/engine/openai-bridge.js
  - test-engine-bridge.mjs
  - lib/engine/llm-bridge.js
  - test-engine-llm-bridge.mjs
  - lib/engine/contract.js
  - docs/fsoft-native-engine.md
  - lib/agentic-host.js
  - lib/engine/client.js
tags: [openai, bridge, streaming, llm, conversion, engine]
---

## Overview

`lib/engine/openai-bridge.js` 是 FSoft 原生引擎迁移（阶段 1B）里的**纯转换层**：把 OpenAI-compatible 的 `chat.completions` 请求/响应协议，与宿主 `llm.stream(GenerateOptions)` 的 DSH 内部协议互相翻译。它本身**无 I/O、无网络、无密钥**，所有 HTTP 监听、凭证校验、随机端口绑定都发生在宿主侧的 `lib/engine/llm-bridge.js`（见 [[engine_llm_bridge]]）。

为什么需要这层桥：FSoft 原生引擎只认 OpenAI-compatible 的 `base_url` + `api_key`（见 `docs/fsoft-native-engine.md:170-180`）。DSH 的凭证在宿主 provider 配置里，插件既不保存也不传递密钥（0.10.1 起的硬约束）。于是桥跑成一个监听 `127.0.0.1` 的进程内 HTTP 端点（loopback + 随机端口 + 占位 key 校验，见 [[engine_llm_bridge]]），引擎拿着占位 key 打过来，桥把它转成 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider。

本文件专注做最易错的纯转换，便于 TDD 钉死两条路径（对应 `test-engine-bridge.mjs` 的两组断言）：

- **请求方向**：OpenAI `chat.completion` 请求体 → DSH `GenerateOptions`（`toLlmRequest`）。要点：system 消息抽进 `system` 槽；`assistant.tool_calls` 还原成 `tool-call` 块（arguments 保持原始 JSON **字符串**）；`tool` 消息 → `ToolResultMessage` 形态（callId 必须对上）；`tools[].function` → `ToolSchema`（否则 agentic 工具循环退化成空谈）。
- **响应方向**：DSH `StreamChunk` 流 → OpenAI 响应（非流式 JSON / 流式 SSE）（`chunksToCompletion` / `chunksToSse`）。要点：tool-call-delta 必须按 `index` 拼成完整 arguments，且只产出带 `name` 的调用；reasoning-delta 不进 content；usage 字段名映射（`inputTokens` 不含缓存，故 `prompt_tokens = inputTokens + cacheRead + cacheWrite`）；流式与非流式共用 `foldChunks` 同一套拼接逻辑，避免行为分叉。

安全边界：占位 key 由桥每次启动随机生成（`lib/engine/llm-bridge.js:96`），本文件用 `PLACEHOLDER_KEY_PATTERN` / `isPlaceholderKey` 只负责识别它；`toLlmRequest` 的返回值里**永远没有 `apiKey` 字段**（见 `test-engine-bridge.mjs:348-356`）。

## Key Components

### 公开常量

- `PLACEHOLDER_KEY_PATTERN` — `lib/engine/openai-bridge.js:29`：正则 `/^dsh-bridge-[a-z0-9-]+$/`，匹配桥每次启动随机生成的占位 key 形态。被 `lib/engine/llm-bridge.js:27` 导入，用于 `/v1` 准入闸门校验。

### 公开函数

- `isPlaceholderKey(value)` — `lib/engine/openai-bridge.js:31-33`：当且仅当 `value` 是字符串且匹配 `PLACEHOLDER_KEY_PATTERN` 时返回 `true`。安全边界判定，真实 key 一律不认（测试见 `test-engine-bridge.mjs:340-346`）。

- `toLlmRequest({ provider, model, reasoningEffort, body })` — `lib/engine/openai-bridge.js:128-161`：OpenAI 请求体 → DSH `GenerateOptions`（纯转换，provider/model 由桥路由决定，不在此填 `signal`/`sessionId`）。
  - 校验：`provider`/`model` 必须为非空字符串，缺则分别抛 `/provider|`/`/model|`（`lib/engine/openai-bridge.js:129-130`）；`body.messages` 必须是非空数组，否则抛 `/messages|`（`lib/engine/openai-bridge.js:131-132`）；除 system 外至少有一条消息，否则抛错（`lib/engine/openai-bridge.js:146`）。
  - 产出：`messages`（非 system 消息，由 `messageToDsh` 翻译，`lib/engine/openai-bridge.js:137-145`）、`system`（所有 system/developer 文本用 `\n` 拼起来，无则 `undefined`，`lib/engine/openai-bridge.js:131,152`）、`reasoningEffort`（仅当传入，`:154`）、`tools`（`toolsToSchemas` 结果，`:155-156`）、`temperature`（`body.temperature`，`:157`）、`maxTokens`（`body.max_tokens`，`:158`）、`stop`（`body.stop` 数组 `.map(String)`，`:159`）。**返回值永远不含 `apiKey`**（`test-engine-bridge.mjs:348-356`）；未知字段（如 `response_format`、`seed`）被静默丢弃（`:134-159` 只挑选白名单字段）。

- `finishReasonToOpenAI(reason)` — `lib/engine/openai-bridge.js:164-173`：DSH `FinishReason` → OpenAI `finish_reason`。映射：`{kind:'tool-calls'}→'tool_calls'`、`{kind:'max-tokens'}→'length'`、`{kind:'error'}|{kind:'aborted'}→'error'`、`{kind:'stop'}→'stop'`、缺省/未知→`'stop'`。

- `chunksToCompletion({ id, model, chunks })` — `lib/engine/openai-bridge.js:236-256`：chunk 流 → OpenAI **非流式**响应体。先调 `foldChunks` 折叠，再包成 `{object:'chat.completion', choices:[{index:0, message:{role:'assistant', content, tool_calls?}, finish_reason}], usage}`。`content` 语义：有文本用文本；纯工具调用时 `content` 为 `null`（不是空串，`lib/engine/openai-bridge.js:249`，测试 `test-engine-bridge.mjs:227-236`）；`finish_reason` 缺省时按「有 toolCalls 则 `'tool_calls'` 否则 `'stop'`」兜底（`lib/engine/openai-bridge.js:252`）。`id`/`created` 缺省时自动生成（`lib/engine/openai-bridge.js:240-242`）。

- `sseFrame(payload)` — `lib/engine/openai-bridge.js:259-262`：把单帧 payload 序列化为 `data: <json>\n\n`；若传入字符串（如 `'[DONE]'`）直接用。`chunksToSse` 与 `lib/engine/llm-bridge.js:183-185,195-197` 都依赖它收尾 `[DONE]`。

- `chunksToSse({ id, model, created, chunks })` — `lib/engine/openai-bridge.js:265-317`：chunk 流 → SSE 帧数组（每帧一个 chunk，末帧 `data: [DONE]\n\n`）。逐帧发射：`text-delta` 首帧带 `role:'assistant'`（`:274-279`）；`tool-call-delta` 逐帧带 `index`/`id?`/`name?`/`arguments` 片段（`:280-296`）；`usage` 单独成帧（`choices:[]` + `usage`，`:297-301`）；`finish` 帧计算 `finish_reason`，且若流里没出现过 finish 就补一个终帧（`:310-314`）防止引擎流读取挂住。`created` 缺省取 `Math.floor(Date.now()/1000)`（`:267`）。

### 私有的关键转换辅助（请求侧）

- `textBlock(text)` — `lib/engine/openai-bridge.js:35`：包成 `{ type:'text', text: String(text ?? '') }`。
- `contentToBlocks(content)` — `lib/engine/openai-bridge.js:38-51`：把 OpenAI 的 `content`（string 或 parts 数组）摊平成 DSH `ContentBlock[]`；数组里只接受 `type==='text'` 的 part，`image_url` 等显式跳过（引擎只发文本，`lib/engine/openai-bridge.js:46`）。
- `toolsToSchemas(tools)` — `lib/engine/openai-bridge.js:53-66`：把 `tools[].function`（或裸函数对象）映射成 `ToolSchema[]`（`{name, description, parameters}`），`parameters` 缺省补 `{type:'object',properties:{}}`；无合法条目返回 `undefined`（避免空 tool 数组污染请求）。
- `messageToDsh(msg, route)` — `lib/engine/openai-bridge.js:76-122`：单条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`：
  - `system`/`developer` → 文本抽进后续 `system` 槽（`lib/engine/openai-bridge.js:79-83`）；
  - `user` → `{role:'user', content}`（`lib/engine/openai-bridge.js:84-87`）；
  - `assistant` → `{role:'assistant', content, source?}`，content 里追加 `type:'tool-call'` 块（`id`/`name`/`arguments` 原始字符串，`lib/engine/openai-bridge.js:88-100`），且**必须带 `source:{kind:'model',provider,model}`**（当 `route` 有 provider+model 时，`lib/engine/openai-bridge.js:103-110`）——缺 source 会让宿主 `LlmRuntime.forAdapter()` 读 `source.replayState` 抛错（回归见 `test-engine-bridge.mjs:368-400`）；
  - `tool` → `{role:'tool', toolCallId, isError: msg.is_error===true, content}`（`lib/engine/openai-bridge.js:112-120`），`toolCallId` 必须与上游 `tool_calls.id` 对上。

### 私有的关键转换辅助（响应侧）

- `usageToOpenAI(usage)` — `lib/engine/openai-bridge.js:176-188`：DSH `TokenUsage`（互斥计数，`inputTokens` 不含缓存）→ OpenAI usage。`prompt_tokens = input + cacheRead + cacheWrite`，`completion_tokens = output`，`total_tokens = prompt+output`，`prompt_tokens_details.cached_tokens = cacheRead`。
- `foldChunks(chunks)` — `lib/engine/openai-bridge.js:192-233`：把 chunk 流折叠成中间态 `{text, finish, usage, toolCalls}`。text-delta 累加文本；tool-call-delta 按 `index` 落到 `Map`（`{id,name,args}`，args 增量拼接，`lib/engine/openai-bridge.js:202-210`）；usage/finish 取末值；`reasoning-delta`/`block-start`/`block-end` 显式跳过（`lib/engine/openai-bridge.js:196`）。最后 toolCalls 按 index 排序、**过滤掉无 `name` 的调用**（`lib/engine/openai-bridge.js:223-226`），`id` 缺失则随机补、`arguments` 缺省 `'{}'`（`lib/engine/openai-bridge.js:227-231`）。`chunksToCompletion` 与 `chunksToSse` 都从这里出发，保证两条路径同源。

## Architecture

本模块是纯转换核心；它的上游（`lib/engine/llm-bridge.js`，宿主 HTTP 看门人）与下游（宿主 `llm.stream`，真实 provider）都不在本文件。框图聚焦 openai-bridge.js 内部的组件依赖，以及它与 llm-bridge 的边界：

```text
  OpenAI 请求体 (body)                DSH StreamChunk 流 (llm.stream)
        │                                      ▲
        ▼                                      │
 ┌──────────────────────────────────────────────────────┐
 │  lib/engine/openai-bridge.js  (纯转换，无 I/O/密钥)    │
 │                                                        │
 │  toLlmRequest (128) ──► messageToDsh (76)              │
 │        │                    ├─ contentToBlocks (38)     │
 │        │                    ├─ toolsToSchemas (53)      │
 │        │                    └─ source{model} 注入 (103) │
 │        └─ PLACEHOLDER_KEY_PATTERN (29) / isPlaceholderKey(31)
 │                                                        │
 │  chunksToCompletion (236) ──┐                          │
 │  chunksToSse (265) ─────────┼─► foldChunks (192)       │
 │                              ├─ usageToOpenAI (176)     │
 │                              ├─ finishReasonToOpenAI(164)
 │                              └─ sseFrame (259)         │
 └──────────────────────────────────────────────────────┘
        │                                      ▲
        ▼                                      │
  GenerateOptions                       OpenAI 响应 (JSON/SSE)
  (llm.stream 入参)                     (回给 FSoft 引擎)
        │
        ▼
  lib/engine/llm-bridge.js:startLlmBridge (90)  ── 校验占位 key、转发 signal、收尾 [DONE]
        │
        ▼
  宿主 Provider (真实凭证，桥不可见)
```

调用关系要点：
- 请求链：`toLlmRequest` 是入口，每条消息经 `messageToDsh` 拆出系统文本（送 `system` 槽）与正文消息；工具定义走 `toolsToSchemas`，assistant 历史消息必须带 `source`（`:103-110`）。
- 响应链：`chunksToCompletion` 与 `chunksToSse` 都先经过 `foldChunks`（`:192`）折叠成同一中间态 `{text, finish, usage, toolCalls}`，再分别格式化——保证非流与流式行为同源（`lib/engine/openai-bridge.js:23-24` 注释）。
- `lib/engine/llm-bridge.js` 只从本文件导入 `PLACEHOLDER_KEY_PATTERN`、`chunksToCompletion`、`chunksToSse`、`toLlmRequest` 四个符号（`lib/engine/llm-bridge.js:26-31`）。

## Data Flow

### 请求方向（OpenAI chat.completion → GenerateOptions）

1. `lib/engine/llm-bridge.js:139-157` 收到 HTTP 体后调 `toLlmRequest({provider, model, reasoningEffort, body})`。
2. `toLlmRequest` 校验 `provider`/`model`/`messages`（`lib/engine/openai-bridge.js:129-132`），逐条消息过 `messageToDsh`（`lib/engine/openai-bridge.js:137-145`）：
   - `system`/`developer` 文本累加进 `systemParts`，最终 `system` 槽用 `\n` 拼接（`:152`）；
   - `user`/`assistant`/`tool` 转成 DSH `RequestMessage` 进 `out`；assistant 的 `tool_calls` 还原成 `tool-call` 块，且带 `source`（`:103-110`）；
   - 若除 system 外无消息则抛错（`:146`）。
3. 可选字段映射：`reasoningEffort`、`tools`（`toolsToSchemas`）、`temperature`、`max_tokens→maxTokens`、`stop`（`:154-159`）。
4. 产出的 `GenerateOptions` 在 `lib/engine/llm-bridge.js:4` 被补上 `signal: ac.signal` 后交给 `llm.stream`，**不含任何 apiKey**。

### 响应方向（DSH StreamChunk → OpenAI JSON/SSE）

非流式（`lib/engine/openai-bridge.js:216`、`lib/engine/llm-bridge.js:216`）：
1. 宿主 `llm.stream` 产出的全部 chunk 攒入 `chunks` 数组；
2. `chunksToCompletion` → `foldChunks` 折叠成 `{text, finish, usage, toolCalls}`；
3. 包成 `{object:'chat.completion', choices:[{message:{role:'assistant', content, tool_calls?}, finish_reason}], usage}`，`usage` 经 `usageToOpenAI` 折算（`:254`）；
4. `lib/engine/llm-bridge.js:217-218` 以 `application/json` 送回。

流式（`lib/engine/openai-bridge.js:265`、`lib/engine/llm-bridge.js:182-187`）：
1. 边收边转：每收到一个 chunk 立即 `chunksToSse({chunks:[chunk]})` 逐帧下发，**但跳过 `data: [DONE]\n\n`**（`:184-185`），把终止帧留给统一收尾；
2. `chunksToSse` 内部：首个 `text-delta`/`tool-call-delta` 帧带 `role:'assistant'`，`usage` 单独成帧，`finish` 帧带 `finish_reason`；
3. 若上游从未 emit `finish`，补一个终帧（`:310-314`）；最后 `lib/engine/llm-bridge.js:103` 写 `data: [DONE]\n\n` 收尾。缺 `[DONE]` 会让引擎 SSE 读取挂住（回归见 `test-engine-llm-bridge.mjs:131-149`）。
4. 上游中途失败：`lib/engine/llm-bridge.js:193-199` 流已开始则先写 `errorBody` 帧再 `[DONE]`，否则非流式走 502（`test-engine-llm-bridge.mjs:151-174`）。

### usage 折算对照

| DSH TokenUsage 字段 | OpenAI 字段 | 说明 |
| --- | --- | --- |
| `inputTokens`（净输入，不含缓存） | 并入 `prompt_tokens` | `prompt_tokens = input + cacheRead + cacheWrite`（`lib/engine/openai-bridge.js:181`） |
| `cacheReadTokens` | `prompt_tokens_details.cached_tokens` | 缓存单列，不重复计费语义（`:186`） |
| `cacheWriteTokens` | 并入 `prompt_tokens` | `:180` |
| `outputTokens` | `completion_tokens` / `total_tokens` 的一部分 | `:178,185` |

## Connections

- [[engine_llm_bridge]]（`lib/engine/llm-bridge.js`）：本模块的宿主 HTTP 看门人。`startLlmBridge` 起 `127.0.0.1` 随机端口服务、生成占位 key、`/v1` 准入校验，再调用本文件的 `toLlmRequest`/`chunksToCompletion`/`chunksToSse`。本模块所有安全边界（loopback、随机端口、key 校验、日志不记 Authorization）都在那里实现。
- [[engine_contract]]（`lib/engine/contract.js`）：阶段 0 的引擎跨进程契约（EngineResult/EngineProgress/EngineError）。本模块不直接产出契约对象，但 `docs/fsoft-native-engine.md:170-180` 把本模块定位为「宿主模型桥」的纯转换内核。
- [[engine_client]]（`lib/engine/client.js`）：Node ↔ Python 引擎的进程+协议薄适配层；与模型通道解耦——client 不读凭证、不连模型，模型通道由 llm-bridge/openai-bridge 单独提供（`lib/engine/client.js:8-11`）。
- [[agentic_host]]（`lib/agentic-host.js`）：宿主 `llm.stream` 正式 `Message`（带 id/source）的构造层。openai-bridge 产出的 DSH `RequestMessage` 里 assistant 必须带 `source:{kind:'model',provider,model}`，正是为了匹配宿主 `createAssistantMessage` 对 source 的要求（`lib/agentic-host.js:50-56` 与 `lib/engine/openai-bridge.js:68-75` 呼应）。

## Known Issues

- **assistant 历史消息缺 `source` 会导致工具循环断链（已在 1C 实测暴露）**：宿主 `LlmRuntime.forAdapter()` 会无条件读 `message.source.replayState`（`lib/engine/openai-bridge.js:71-75` 注释）。若 bridge 不注入 `source`，第二轮工具往返起模型就看不见上一轮调用，宿主把整轮判为 `finish=error`，引擎侧表现为「Please return text or call a tool.」并耗尽重试。纯单测抓不到，只有真跑工具往返才会炸；回归测试见 `test-engine-bridge.mjs:368-400`。桥**不伪造** `replayState`（`undefined`，`test-engine-bridge.mjs:391-400`）。
- **无 `name` 的 tool-call-delta 会被静默丢弃**：`foldChunks`（`:223-226`）只保留带 `name` 的调用，引擎无法执行无 name 的调用。`index` 排序保证多调用顺序稳定（`:224`）。
- **reasoning-delta 不进入正文**：`foldChunks` 显式跳过 `reasoning-delta`/`block-start`/`block-end`（`:217`），思考内容不会污染文章正文。
- **流式缺终帧会挂住引擎**：`chunksToSse`（`:310-314`）和 `lib/engine/llm-bridge.js:210` 都强制补 `data: [DONE]\n\n`，否则引擎 SSE 读取挂住（测试 `test-engine-bridge.mjs:274-298`、`:131-149`）。
- **本模块无禁用/注释掉的代码**：`lib/engine/openai-bridge.js` 全部导出均在生产路径使用（被 `lib/engine/llm-bridge.js:26-31` 引用或经测试覆盖），无 `#disabled`、`// TODO 关闭` 之类的功能开关。
- **占位 key 形态校验与本模块只读不判**：`PLACEHOLDER_KEY_PATTERN` 只描述形态；真正的「本次启动生成的 key 才放行」相等判断在 `lib/engine/llm-bridge.js:120`（`token !== placeholderKey`），本模块不持有具体 key 值，避免密钥泄漏面扩大。
