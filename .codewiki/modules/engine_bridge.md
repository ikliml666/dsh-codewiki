---
title: engine_bridge
type: module
source_files:
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - index.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
tags: [engine, llm, openai-compatible, bridge, security]
---

## Overview

`engine_bridge` 是连接「FSoft 原生 Python 引擎」与「宿主 LLM 服务」的桥。FSoft 引擎只认 OpenAI-compatible 的 `base_url` + `api_key`（`lib/engine/openai-bridge.js:3`），而 DSH 的真实凭证只存在于宿主 provider 配置里——插件既不保存也不传递密钥（0.10.1 起的硬约束，见 `lib/engine/llm-bridge.js:6-12`）。

因此桥被实现为一个跑在 `127.0.0.1` 上的进程内 HTTP 端点（`lib/engine/llm-bridge.js:startLlmBridge`）：引擎拿着一个桥自己生成的占位 key（`dsh-bridge-...`）打这个 loopback 端点，桥把 OpenAI 请求翻译成宿主的 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider，再把 DSH 的 chunk 流翻译回 OpenAI 响应。

模块由两层组成：

- **纯转换层** `lib/engine/openai-bridge.js`：无 I/O、无网络、无密钥，只做 OpenAI chat.completion 请求体 ↔ DSH `GenerateOptions`、DSH `StreamChunk` 流 ↔ OpenAI 响应（非流式 JSON / 流式 SSE）的双向映射。最容易错的部分集中在这里，被 TDD 钉死（见 `test-engine-bridge.mjs`）。
- **loopback 服务器层** `lib/engine/llm-bridge.js`：启动 HTTP 端点、校验占位 key、读 body、调 `llm.stream`、按流式/非流式两路回写，并守住凭证边界（见 `test-engine-llm-bridge.mjs`）。

安全边界是整条迁移最不能破的一条（`lib/engine/llm-bridge.js:6-17`）：桥不读凭证文件、不接收真实 `api_key`、不转发 `Authorization` 头；引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个占位 key。绑定 127.0.0.1 阻断外网、随机端口让同机其它进程猜不到、占位 key 校验挡住误连/端口扫描——三者缺一都等于把宿主凭证开放给本机任意进程。

## Key Components

### 文件 `lib/engine/openai-bridge.js`（纯转换层，无 I/O / 无网络 / 无密钥）

常量与校验：

- `PLACEHOLDER_KEY_PATTERN`（第 29 行）：占位 key 的正则 `^dsh-bridge-[a-z0-9-]+$`，用于校验桥自己生成的 key 形态。
- `isPlaceholderKey(value)`（第 31-33 行）：判断字符串是不是合法占位 key（类型检查 + 正则匹配）。

请求方向（OpenAI → DSH）：

- `contentToBlocks(content)`（第 38-51 行）：把 OpenAI 的 `content`（`string` 或 parts 数组）摊平成 DSH 的 `ContentBlock[]`，非文本部分（如 `image_url`）显式跳过。
- `toolsToSchemas(tools)`（第 53-66 行）：把 `tools[].function` 映射成 DSH `ToolSchema`（`name` / `description` / `parameters`），缺 `name` 的项直接丢弃——这一步缺失会让 agentic 工具循环退化。
- `messageToDsh(msg, route)`（第 76-122 行）：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。`system`/`developer` 抽成 text 便于合并；`assistant` 带 `tool_calls` 时还原成 `tool-call` 块（保持原始 JSON **字符串**，不提前 parse）；`tool` 角色映射成 `ToolResultMessage`（`toolCallId` + `isError`，缺失 `tool_call_id` 直接丢弃）；`assistant` 历史消息**必须**带 `source.kind='model'`（`provider`/`model` 取自 `route`），否则宿主 `LlmRuntime.forAdapter()` 读 `source.replayState` 会抛错（见第 71-75 行注释与回归测试 `test-engine-bridge.mjs:368-399`）。
- `toLlmRequest({ provider, model, reasoningEffort, body })`（第 128-161 行）：OpenAI 请求体 → DSH `GenerateOptions` 子集。校验 `provider`/`model` 非空、`messages` 为非负组（否则抛错，第 129-132、146 行）；`system` 消息抽到 `system` 槽（无 system 时为 `undefined`，不塞空串污染请求，第 152 行）；透传 `temperature`/`max_tokens`(→`maxTokens`)/`stop`；不识别的字段（如 `response_format`/`seed`）一律不塞进请求（第 134-159 行）；**返回值里永远不含 `apiKey` 字段**（第 27 行安全边界，`test-engine-bridge.mjs:348-356` 断言）。

响应方向（DSH → OpenAI）：

- `finishReasonToOpenAI(reason)`（第 164-173 行）：`FinishReason` → OpenAI `finish_reason` 的映射：`tool-calls`→`tool_calls`、`max-tokens`→`length`、`error`/`aborted`→`error`、`stop`/`default`→`stop`。
- `usageToOpenAI(usage)`（第 176-188 行）：DSH 的互斥 token 计数（`inputTokens` 不含缓存）折成 OpenAI 形式：`prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`（OpenAI 的 `prompt_tokens` 含缓存），缓存单列在 `prompt_tokens_details.cached_tokens`，`total_tokens` 为二者之和。
- `foldChunks(chunks)`（第 192-233 行）：把 chunk 流折叠成中间态 `{text, finish, usage, toolCalls}`，是**非流式与流式两条路径共用的同源逻辑**。按 `index` 拼接 `tool-call-delta` 的 `arguments`，只保留**带 name** 的调用（无 name 的调用引擎无法执行，混进去只会制造噪音，第 222-231 行；`id` 缺失时随机补 `call_<random>`）；`reasoning-delta` / `block-start` / `block-end` 不进正文。
- `chunksToCompletion({ id, model, chunks })`（第 236-256 行）：chunk 流 → OpenAI 非流式响应体（`object: 'chat.completion'`）。纯工具调用时 `content` 为 `null`（不是空串，OpenAI 语义，第 248-249 行）；`finish_reason` 优先从 `finish` 折算，否则按是否含 `toolCalls` 落 `tool_calls`/`stop`。
- `sseFrame(payload)`（第 259-262 行）：把 payload 包成 `data: <json>\n\n` 帧；`[DONE]` 走 `sseFrame('[DONE]')` 当独立帧。
- `chunksToSse({ id, model, created, chunks })`（第 265-317 行）：chunk 流 → SSE 帧数组（每帧一个完整 chunk，末帧 `[DONE]`）。首帧带 `role: 'assistant'`；`text-delta` / `tool-call-delta` 逐帧输出，`usage` 单独成帧（带 `usage` 字段、`choices` 为空），`finish` 帧带 `finish_reason`（若 `finish` 时仍未见工具但已发过 `role` 则 delta 为空）；**若流没给 finish，补一个终帧**（否则引擎的流读取会挂住，第 310-314 行）。

### 文件 `lib/engine/llm-bridge.js`（loopback 服务器层）

常量：

- `DEFAULT_TIMEOUT_MS`（第 33 行）：单次模型调用默认超时 `10 * 60 * 1000`（10 分钟）。
- `MAX_BODY_BYTES`（第 34 行）：请求体上限 `32 * 1024 * 1024`（32MB），超限返回 413。

辅助函数：

- `bearerOf(req)`（第 38-43 行）：从 `Authorization` 头取 bearer token，**只用于校验占位 key**，取完即弃，绝不写日志/放进请求对象/传给 `llm`。
- `sendJson(res, status, body, extraHeaders)`（第 45-54 行）：写 JSON 响应，带 `cache-control: no-store`。
- `readBody(req, limit)`（第 56-72 行）：按 `limit` 累积请求体，超限 `reject({statusCode:413})` 并 `req.destroy()`。
- `errorBody(message, type, code)`（第 75-77 行）：把上游异常翻译成 OpenAI 风格错误体 `{error:{message,type,code}}`，引擎按 `status + error.message` 记账。

主入口：

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`（第 90-241 行）：启动桥，返回 `{url, placeholderKey, port, stats(), close()}`。
  - 前置校验（第 91-93 行）：`llm.stream` 必须是函数、`provider`/`model` 必填，否则抛错（不让桥以半配置状态监听端口，`test-engine-llm-bridge.mjs:290-294`）。
  - 占位 key（第 96 行）：每次启动用 `randomBytes(32).toString('hex')` 随机生成，**不复用、不落盘、不进日志**。
  - `stats`（第 97 行）：`{requests, streamRequests, authRejected, failures, lastError}`。
  - 路由（第 100-226 行）：`GET /healthz` 存活检查、所有 `/v1` 请求必须带匹配 `placeholderKey` 的占位 key（否则 401 且不回显收到的 key，第 118-125 行）、`GET /v1/models` 返回配置的模型、`POST /v1/chat/completions` 处理非流式/流式。
  - 流式边收边发：首个 chunk 落地后才 `writeHead(200, text/event-stream...)`，逐帧调用 `chunksToSse` 发单帧并跳过 `[DONE]`（统一在收尾发，第 169-188 行）。
  - 取消/超时：`res.on('close')` 触发 `ac.abort()`，`setTimeout` 到 `timeoutMs` 触发 `ac.abort()`，把 `signal` 透传给 `llm.stream`（第 162-167 行）；上游失败：流式已发头则发错误帧 + `[DONE]`，非流式返回 502（第 189-203 行）。
  - 监听（第 228-240 行）：`server.listen(0, '127.0.0.1', ...)` 随机端口，resolve 出 `url: http://127.0.0.1:${port}/v1` 等。

## Architecture

```
              FSoft 原生引擎（只认 OpenAI-compatible）
                         │  POST /v1/chat/completions (+ Bearer 占位key)
                         ▼
        ┌─────────────────────────────────────────────┐
        │  llm-bridge.js: startLlmBridge (127.0.0.1)  │
        │   · 占位 key 校验（/v1 全路由闸门）          │
        │   · /v1/models · /healthz                    │
        │   · 读 body → toLlmRequest                   │
        │   · 流式边收边发 / 非流式攒完发             │
        └───────────────────┬─────────────────────────┘
                            │  GenerateOptions (无 apiKey)
                            ▼
        ┌─────────────────────────────────────────────┐
        │  openai-bridge.js: 纯转换层 (无 I/O/无密钥)  │
        │   toLlmRequest · messageToDsh · foldChunks   │
        │   chunksToCompletion · chunksToSse           │
        └───────────────────┬─────────────────────────┘
                            │  llm.stream({...options, signal})  ← 宿主凭证在内部
                            ▼
                 宿主 llm 服务 (provider/model 凭证)
                            │  DSH StreamChunk[] 流
                            ▼
        ┌─────────────────────────────────────────────┐
        │  openai-bridge.js: 响应转换                   │
        │   foldChunks → chunksToCompletion(非流式)    │
        │             → chunksToSse(流式 SSE)          │
        └───────────────────┬─────────────────────────┘
                            │  OpenAI JSON / SSE 帧
                            ▼
                        FSoft 引擎
```

框内组件：`startLlmBridge`（`lib/engine/llm-bridge.js:90`）负责监听与安全闸门；`toLlmRequest`/`messageToDsh`/`foldChunks`/`chunksToCompletion`/`chunksToSse`（`lib/engine/openai-bridge.js`）负责双向纯转换；`llm.stream` 由调用方（宿主）注入，桥只通过它间接触发真实 provider，自己全程不接触密钥。

## Data Flow

### 请求方向（引擎 → 宿主）

1. FSoft 引擎向 `http://127.0.0.1:<port>/v1/chat/completions` 发 POST，带 `Authorization: Bearer <占位key>` 与 OpenAI 形状的 JSON body（`messages` / `tools` / `temperature` / `max_tokens` / `stop` / `stream`）。
2. `startLlmBridge` 的 handler 先校验占位 key（`lib/engine/llm-bridge.js:90-98`）：不匹配 `PLACEHOLDER_KEY_PATTERN` 或不是本次生成的 `placeholderKey` 一律 401，且错误体不回显收到的 key。
3. `readBody` 累积 body（超限 413），`JSON.parse` 失败返回 400（`lib/engine/llm-bridge.js:139-147`）。
4. `toLlmRequest`（`lib/engine/openai-bridge.js:128`）把 body 转成 DSH `GenerateOptions`：`messageToDsh` 逐条消息转换并合并 system 到 `system` 槽，`toolsToSchemas` 映射工具 schema，参数名 `max_tokens`→`maxTokens` 等。结果**不含 `apiKey`**。
5. 桥把 `{...options, signal: ac.signal}` 传给注入的 `llm.stream`，`signal` 来自客户端断连 / 超时 abort（`lib/engine/llm-bridge.js:162-171`）。

### 响应方向（宿主 → 引擎）

- **非流式**（`stream !== true`）：桥收集全部 chunk，循环结束后调 `chunksToCompletion`（`lib/engine/llm-bridge.js:216`）。`foldChunks` 折叠出 `{text, finish, usage, toolCalls}`，再包成 `chat.completion` JSON（`content` 纯工具调用时为 `null`，`usage` 按 `inputTokens + cacheRead + cacheWrite` 折算）。
- **流式**（`stream === true`）：桥边收边转，每个 chunk 用 `chunksToSse` 逐帧发（跳过 `[DONE]`，统一在收尾发，第 183-187 行）；上游中途失败则发一个错误帧 + `[DONE]` 收尾（第 191-200 行）；流自然结束或超时后补 `[DONE]`（第 206-214 行）。
- 两条路径共用 `foldChunks` 同源逻辑，保证流式与非流式行为一致（避免引擎在流式路径上拿到半截 `tool_calls`，见 `test-engine-bridge.mjs:13-15`）。

### 关键不变量

- token 计数：DSH `inputTokens` 是互斥净输入，OpenAI `prompt_tokens` 含缓存；`usageToOpenAI` 做 `prompt_tokens = inputTokens + cacheRead + cacheWrite`（`openai-bridge.js:176`）。
- `tool-call-delta` 按 `index` 拼接 `arguments`，只产出带 `name` 的调用；无 `name` 的调用被丢弃（`openai-bridge.js:222-231`）。
- `reasoning-delta` 不进正文（`openai-bridge.js:217`）。
- assistant 历史消息必须带 `source`（1C 真实模型暴露的回归）：宿主 `LlmRuntime.forAdapter()` 会无条件读 `message.source.replayState`，缺 `source` 会抛 `"Cannot read properties of undefined (reading 'replayState')"`，宿主把整轮调用判为 `finish=error`，引擎侧表现为 "Please return text or call a tool." 并耗尽重试。纯单测抓不到，只有真跑一次工具往返才会炸。已在 `openai-bridge.js:71-75` 用注释固定，并由 `test-engine-bridge.mjs:368-399` 三则回归测试钉死（`source.kind` 必须是 `model`、`provider`/`model` 取自本次路由、桥不伪造 `replayState`）。

## Connections

- [[engine-client]]：桥与 `lib/engine/client.js` 同属 `lib/engine/`，但职责分属两个边界——`client.js` 是 Node↔Python 的进程+协议适配（写一行请求 JSON、读 JSON-lines 回 `EngineResult`，不含模型通道）；桥只负责「模型通道」一侧。两者都被 `index.js` 的编译流水线编排。
- [[engine-contract]]：桥的 `messageToDsh` 产出的 `RequestMessage`/`ToolSchema`/`ContentBlock` 与 `lib/engine/contract.js` 同在 `lib/engine/` 的纯类型口径；`client.js` 与桥都不依赖对方的运行时，只在纯类型与 DSH chunk 流语义上对齐。
- [[agentic]] / [[agentic-host]]：agentic 工具循环（`lib/agentic.js`）与宿主 llm 适配层（`lib/agentic-host.js`）是桥的上游消费形态之一——它们同样通过宿主 `llm.stream` 走真实 provider，但不经过本桥（agentic 走 `makeHostStream` 直连宿主，不经过 OpenAI loopback）。桥专门服务「只认 OpenAI-compatible、由 FSoft 引擎发起」的路径。
- [[engine-manifest]]：环境指纹/doctor 由 `lib/engine/manifest.js` 只读诊断，与桥一样属于 `lib/engine/`，但互不依赖；桥的 `provider`/`model` 来自流水线配置而非 manifest。
- [[index]]（编译流水线入口）：`index.js` 提供唯一的宿主 `llm` 服务通道并持有凭证；桥通过 `startLlmBridge` 的 `llm` 参数被注入该通道，是「插件不碰密钥」硬约束的执行点（占位 key + loopback 随机端口）。

## Known Issues

- **assistant 历史消息必须带 `source`（1C 真实模型暴露的回归）**：宿主 `LlmRuntime.forAdapter()` 会无条件读 `message.source.replayState`，缺 `source` 会抛 `"Cannot read properties of undefined (reading 'replayState')"`，宿主把整轮调用判为 `finish=error`，引擎侧表现为 "Please return text or call a tool." 并耗尽重试。纯单测抓不到，只有真跑一次工具往返才会炸。已在 `openai-bridge.js:71-75` 用注释固定，并由 `test-engine-bridge.mjs:368-399` 三则回归测试钉死（`source.kind` 必须是 `model`、`provider`/`model` 取自本次路由、桥不伪造 `replayState`）。
- **`foldChunks` 对缺 `name` 的 tool-call 调用**：无 `name` 的调用引擎无法执行，桥会丢弃它们（第 222-231 行）；若上游某 provider 先发带 `name` 的 delta 又补发无 `name` 的 delta，拼接结果以「见过 name」为准保留。这是设计取舍而非缺陷，但意味着桥依赖上游 `tool-call-delta` 至少出现一次 `name`。
- **`id` 缺失兜底**：`foldChunks` 在 `id` 缺失时用 `Math.random()` 生成 `call_<随机>`（`openai-bridge.js:228`）。随机 id 不利于问题复现/对账，上游理想情况下应始终带 `id`；测试 `test-engine-bridge.mjs:245-256` 仅断言「不崩、不被产入结果」，未对随机 id 稳定性做约束。
- **非流式 `usage` 为空时的兜底**：空流 `chunksToCompletion` 返回 `usage.prompt_tokens: 0`（`openai-bridge.js:236-240` 与测试 `test-engine-bridge.mjs:238-243`）；若真实 provider 偶发不回 usage，引擎侧用量账本会记成 0，桥本身不补算。
- **流式逐帧转发对单 chunk 调 `chunksToSse`**：`lib/engine/llm-bridge.js:183-187` 对每个到达的 chunk 单独跑 `chunksToSse`，再手动跳过 `[DONE]`，避免攒完再发；其正确性依赖「`chunksToSse` 对单帧产出的 `[DONE]` 与收尾统一 `[DONE]` 不重复」这一约定，改动 `chunksToSse` 时必须同步核对这段调用方。
- **无可见的功能禁用/注释失效分支**：本模块两个文件均没有 `disabled` / 被注释掉的函数；占位 key 校验、流式/非流式路径、超时与取消都是生效中的逻辑，不是预留开关。
