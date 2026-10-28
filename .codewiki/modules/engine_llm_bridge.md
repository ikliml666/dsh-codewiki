---
title: engine_llm_bridge
type: module
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - test-engine-llm-bridge.mjs
  - test-engine-bridge.mjs
tags: [engine, llm-bridge, loopback, openai-compatible, credential-boundary, http-server]
---

## Overview

`engine_llm_bridge` 是 DSH（CodeWiki 插件）与 FSoft 原生引擎之间的「宿主模型 loopback 桥」（阶段 1B 薄桥）。它的唯一职责是：把 FSoft 引擎发来的 **OpenAI-compatible HTTP 请求**，翻译成宿主的 `llm.stream(GenerateOptions)`，再把模型返回的 chunk 流翻译回 OpenAI 响应（非流式 JSON / 流式 SSE）。

模块拆成两层：

- `lib/engine/llm-bridge.js` —— HTTP 监听与请求调度。绑定 `127.0.0.1` 随机端口，校验占位 key，做 body 读取、超时、断连 abort、流式/非流式分发，并通过 `onLog` 回调产出**不含任何 Authorization/凭证**的结构化日志。
- `lib/engine/openai-bridge.js` —— 纯转换层（无 I/O、无网络、无密钥）。负责 OpenAI 请求体 ↔ DSH `GenerateOptions` 的映射，以及 DSH `StreamChunk` 流 ↔ OpenAI 响应体的映射（非流式 JSON / 流式 SSE）。与服务器的边界由 `toLlmRequest` 的入参 `{provider, model, reasoningEffort, body}` 固定——它永远不带 `apiKey` 字段。

### 凭证边界（最关键不变式）

这是整个迁移**最不能破的一条线**（见 `lib/engine/llm-bridge.js` 第 1–17 行注释）：

- 桥**不读**任何凭证文件、**不接收**真实 `api_key`、**不转发** `Authorization` 头；
- 引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个占位 key（`dsh-bridge-...`），占位 key 的唯一作用是让引擎的 OpenAI 客户端肯发请求；
- 真实凭证只存在于宿主 provider 内部——桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它；
- 访问日志与错误日志只记 `method/path/状态/耗时/请求 id`，**不记** `Authorization`。

为什么必须 loopback + 随机端口 + 占位 key 三者齐备：桥等于「用宿主凭证换任意模型调用」的开关。绑定 `127.0.0.1` 阻断外网；随机端口让同机其它进程猜不到；占位 key 校验挡住误连/端口扫描。任一缺失都等同把宿主凭证开放给本机任意进程。

### 协议面（只实现引擎真正用到的部分）

- `POST /v1/chat/completions` —— 非流式（`stream` 缺省/`false`）与流式（`stream: true`）；
- `GET  /v1/models` —— 引擎/探针的连通性检查；
- `GET  /healthz` —— 桥自身存活（不含任何模型信息，也不泄露凭证）。

## Key Components

### lib/engine/llm-bridge.js（HTTP 服务器）

常量：

- `DEFAULT_TIMEOUT_MS = 10 * 60 * 1000`（第 33 行）——单次模型调用默认超时，可被 `opts.timeoutMs` 覆盖。
- `MAX_BODY_BYTES = 32 * 1024 * 1024`（第 34 行）——请求体上限，超限回 `413`。

模块级函数：

- `bearerOf(req)`（第 38–43 行）——从 `Authorization` 头里取出 bearer token，**只用于校验占位 key**，取完即弃；绝不写入日志、绝不放进请求对象、绝不传给 `llm`。
- `sendJson(res, status, body, extraHeaders = {})`（第 45–54 行）——写 JSON 响应，带 `content-type: application/json`、`content-length`、`cache-control: no-store`。
- `readBody(req, limit = MAX_BODY_BYTES)`（第 56–72 行）——以 `Promise` 缓冲请求体，超限时 `reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))` 并 `req.destroy()`。
- `errorBody(message, type = 'bridge_error', code = null)`（第 75–77 行）——把上游异常翻译成 OpenAI 风格错误体 `{ error: { message, type, code } }`（引擎按 `status + error.message` 记账）。

公开导出：

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS, onLog })`（第 90–241 行）——启动桥。返回 `Promise<{ url, placeholderKey, port, stats(), close() }>`。
  - 参数校验（第 91–93 行）：缺 `llm`/`llm.stream` 抛 `需要宿主 llm 服务`；缺 `provider` 抛 `需要 provider`；缺 `model` 抛 `需要 model`。**不让桥以半配置状态监听端口**。
  - 占位 key 每次启动随机生成（第 96 行）：`dsh-bridge-${randomBytes(32).toString('hex')}`，不复用、不落盘、不进日志。
  - `stats`（第 97 行）初始为 `{ requests, streamRequests, authRejected, failures, lastError }`。
  - 服务器回调（第 100–226 行）的路由顺序：
    1. `GET /healthz`（第 112–115 行）——`200 { ok, provider, model }`，**不需要 key**，不泄露凭证。
    2. 所有 `/v1` 请求必须带占位 key（第 118–126 行）：`bearerOf(req)` 取出后，`!PLACEHOLDER_KEY_PATTERN.test(token) || token !== placeholderKey` 即 `401`（含 `authRejected++`、错误体不回显收到的 key）。
    3. `GET /v1/models`（第 128–131 行）——`200 { object: 'list', data: [{ id: model, object: 'model', owned_by: provider }] }`。
    4. 非 `POST /v1/chat/completions`（第 133–136 行）——`404`。
    5. `POST /v1/chat/completions`（第 138–225 行）——读 body、解析 JSON（失败 `400`）、`toLlmRequest` 转换（失败 `400`）、按 `stream` 分发，调用 `llm.stream({ ...options, signal: ac.signal })`。
  - 客户端断连 → `AbortController.abort()`（第 163–167 行 `res.on('close', ...)`）；超时 → `setTimeout(() => ac.abort(), timeoutMs)`（第 166 行）；收尾 `cleanup()` 清定时并解绑。
  - 流式（第 159–214 行）：边收边转 `chunksToSse`，把 `[DONE]` 留到收尾统一发（第 183–187 行）；上游中途失败 → 发错误帧再 `[DONE]` 收尾（第 193–199 行），避免引擎 SSE 读取挂住。
  - 非流式（第 216–218 行）：`chunksToCompletion` 后 `sendJson(200, completion)`。
  - 顶层 `catch`（第 219–225 行）：未发头则 `500` JSON，已发头则 `res.end()`；均计入 `failures`/`lastError`。
  - 监听（第 228–240 行）：`server.listen(0, '127.0.0.1', ...)`，返回 `{ url: 'http://127.0.0.1:<port>/v1', placeholderKey, port, stats: () => ({...stats}), close: () => new Promise(done => server.close(() => done())) }`。

### lib/engine/openai-bridge.js（纯转换层）

常量/校验：

- `PLACEHOLDER_KEY_PATTERN = /^dsh-bridge-[a-z0-9-]+$/`(第 29 行)——占位 key 形态校验正则；与 `llm-bridge.js` 的 `bearerOf` 配合做准入闸门。
- `isPlaceholderKey(value)`（第 31–33 行）——返回 `typeof value === 'string' && PLACEHOLDER_KEY_PATTERN.test(value)`。

内部助手（模块私有，不导出）：

- `textBlock(text)`（第 35 行）——`{ type: 'text', text }`。
- `contentToBlocks(content)`（第 38–51 行）——把 OpenAI 的 `string | parts[]` 摊平成 DSH `ContentBlock[]`；非文本的 `image_url` 等显式跳过。
- `toolsToSchemas(tools)`（第 53–66 行）——`tools[].function` → DSH `ToolSchema`（`name`/`description`/`parameters`）；无有效工具返回 `undefined`。
- `messageToDsh(msg, route)`（第 76–122 行）——单条 OpenAI 消息 → 0..n 条 DSH `RequestMessage`：`system`/`developer` 抽文本由调用方合并；`assistant` 的 `tool_calls` 生成 `tool-call` 块（保留原始字符串 `arguments`）；`tool` 消息 → `toolCallId`/`isError`；assistant 历史消息**必须**带 `source.kind='model'`（见第 71–74 行注释，宿主 `forAdapter()` 会读 `message.source.replayState`）。
- `usageToOpenAI(usage)`（第 176–188 行）——DSH 互斥计数 → OpenAI usage：`prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`，`cached_tokens` 单列 `prompt_tokens_details`。
- `foldChunks(chunks)`（第 192–233 行）——把 chunk 流折叠成中间态 `{ text, finish, usage, toolCalls }`；`tool-call-delta` 按 index 拼接，只保留有 `name` 的调用，无 name 的调用过滤掉。

公开导出（转换契约，被 `test-engine-bridge.mjs` 直接 TDD 钉死）：

- `toLlmRequest({ provider, model, reasoningEffort, body })`（第 128–161 行）——OpenAI 请求体 → DSH `GenerateOptions` 子集（不含 `signal`/`sessionId`）。缺 `provider`/`model`/`messages` 抛错；`system` 消息抽到 `system` 槽；映射 `temperature`→`result.temperature`、`max_tokens`→`result.maxTokens`、`stop`→`result.stop`；返回值**永远没有 `apiKey`**。
- `finishReasonToOpenAI(reason)`（第 164–173 行）——DSH `FinishReason` → OpenAI `finish_reason`（`tool-calls`/`length`/`error`/`stop`）。
- `chunksToCompletion({ id, model, chunks })`（第 236–256 行）——chunk 流 → 非流式 OpenAI JSON；纯工具调用时 `content: null`；`finish_reason` 缺省 `tool_calls`/`stop`。
- `sseFrame(payload)`（第 259–262 行）——单帧 SSE：`data: <body>\n\n`。
- `chunksToSse({ id, model, created, chunks })`（第 265–317 行）——chunk 流 → SSE 帧数组（逐 chunk 一帧，末帧 `[DONE]`）；`text-delta`/`tool-call-delta`/`usage`/`finish` 各成帧；没给 `finish` 也补终帧防引擎挂住。

## Architecture

桥分两层：对外 HTTP 调度在 `llm-bridge.js`，纯转换在 `openai-bridge.js`。两张图分别画「对外请求路由」与「内外组件关系」。

```text
        FSoft 引擎 (OpenAI-compatible 客户端)
                 │  http://127.0.0.1:<port>/v1  + Bearer 占位key
                 ▼
        ┌─────────────────────────────────────────┐
        │ startLlmBridge (lib/engine/llm-bridge.js)│
        │  createServer @ 127.0.0.1:0              │
        └─────────────────────────────────────────┘
           │            │             │
    GET /healthz   GET /v1/models  POST /v1/chat/completions
      (无key)      (需占位key)        (需占位key)
           │            │             │ readBody→JSON→toLlmRequest
           ▼            ▼             ▼
       200 ok      models list   llm.stream({...opts, signal})
                                     │   ▲ AbortController (断连/超时)
                                     ▼
                              chunksToCompletion / chunksToSse
                                     │
                                     ▼
                          非流式 JSON 200  /  流式 SSE (…[DONE])
```

```text
┌─────────────┐   占位key校验    ┌──────────────────────┐   toLlmRequest    ┌──────────────────────┐
│ FSoft 引擎  │ ───────────────► │ llm-bridge.js        │ ────────────────► │ openai-bridge.js     │
│ (OpenAI SDK)│                  │ startLlmBridge()     │                   │ toLlmRequest()       │
└─────────────┘ ◄─────────────── └──────────────────────┘ ◄──────────────── └──────────────────────┘
       ▲                          │ 200 JSON / SSE        chunksToCompletion    │
       │ chunksToSse 翻译回 OpenAI │ 随机端口+占位key闸门    / chunksToSse            ▼
       │                          │ onLog(无Authorization) ▲ foldChunks/usageTo  宿主 llm.stream()
       │                          └──────────────────────┘  OpenAI                (真实凭证在宿主内部)
       └──────────────────────────────────────────────────────────────────────────────►
```

## Data Flow

以下以一次 `POST /v1/chat/completions`（带工具、流式）为例，标注真实函数与行号：

1. **引擎发请求**：引擎用 `bridge.url`（`http://127.0.0.1:<port>/v1`，第 233 行）+ `Bearer <placeholderKey>`（`startLlmBridge` 第 96 行随机生成）打到 `POST /v1/chat/completions`。
2. **准入闸门**：服务器回调（第 118–126 行）对 `/v1` 前缀请求取 `bearerOf(req)`（第 119 行），用 `PLACEHOLDER_KEY_PATTERN`（`openai-bridge.js` 第 29 行）校验形态，并比对 `token !== placeholderKey`。不符则 `authRejected++`、`401` 且不回显收到的 key。
3. **读体与解析**：`readBody(req)`（第 139/56 行）缓冲 body，`JSON.parse` 失败 → `stats.failures++`、`400`（第 143–147 行）。
4. **请求转换**：`toLlmRequest({ provider, model, reasoningEffort, body })`（第 151 行 → `openai-bridge.js` 第 128 行）。`system`/`developer` 抽入 `system` 槽，`messages` 转 DSH `RequestMessage[]`，`tools[].function` → `ToolSchema`，`assistant.tool_calls` → `tool-call` 块（保留原始字符串 `arguments`），`temperature`/`max_tokens`/`stop` 映射。返回值无 `apiKey`。转换抛错 → `400`（第 152–157 行）。
5. **调用宿主**：`wantsStream = body.stream === true`（第 159 行）；`AbortController`（第 163 行）绑定 `res.on('close')`（断连 abort）与 `setTimeout(timeoutMs)`（超时 abort）。循环 `for await (chunk of llm.stream({ ...options, signal: ac.signal }))`（第 171 行），`chunks.push(chunk)`。
6. **流式发帧**：`wantsStream && !res.headersSent` 时先写 `text/event-stream` 头（第 174–181 行）；随后对每帧 `chunksToSse({ id, model, chunks: [chunk] })`（`openai-bridge.js` 第 265 行）取帧，**跳过 `[DONE]`**（第 185 行），把 `[DONE]` 留到收尾统一发。
7. **正常收尾**：非流式 → `chunksToCompletion`（`openai-bridge.js` 第 236 行）后 `sendJson(200)`（第 216–218 行）；流式 → 写 `data: [DONE]\n\n` 后 `res.end()`（第 206–213 行）。
8. **上游失败**：`catch` 中若流已开 → 写错误帧（`upstream_error` 类型）再 `[DONE]` 收尾（第 193–200 行）；若未开 → `sendJson(502, errorBody('upstream_error'))`（第 201–202 行）。
9. **日志**：每次响应经 `finish(status)`（第 103–109 行）回调 `onLog`，字段仅 `at/method/path/status/ms`，**绝不出现 `Authorization` 或占位 key**（由 `test-engine-llm-bridge.mjs` 第 232–247 行断言）。
10. **统计**：`stats()` 暴露 `requests/streamRequests/authRejected/failures/lastError`，供健康检查与排障。

## Connections

- [[engine-contract]]（`lib/engine/contract.js`）——同一 `lib/engine/` 目录下的跨进程契约。引擎终态语义（`engine-model` 错误码、重试语义）决定桥把上游失败翻译成 `502 upstream_error` 时引擎侧的记账方式；`ENGINE_STAGES` 中的 `articles` 阶段正是走本桥的 agentic 工具循环。
- [[engine-mapping]]（`lib/engine/mapping.js`）——同目录的映射工具，与本桥的 `openai-bridge.js` 转换职责相邻。
- [[engine-process-tree]]（`lib/engine/process-tree.js`）——同目录的引擎进程树，桥本身不负责拉起引擎进程，只接受引擎作为 HTTP 客户端打来的请求。
- 宿主 `llm` 服务——桥的唯一外部依赖，通过 `opts.llm.stream` 间接触发真实 provider 凭证；真实密钥永不出 `llm` 边界。
- FSoft 原生引擎（Python）——桥的下游 HTTP 消费者，只认 OpenAI-compatible `base_url + api_key`。

## Known Issues

- **占位 key 校验依赖 `token !== placeholderKey` 精确比对**（第 120 行），形态正则 `PLACEHOLDER_KEY_PATTERN`（`openai-bridge.js` 第 29 行）只能挡污请求，不能代替随机性——一旦 `randomBytes(32)` 未来被改成低熵来源，网关就不再安全。测试在 `test-engine-llm-bridge.mjs` 第 211–220 行断言「同格式但非本次生成的 key → 401」。
- **日志字段白名单靠约定**（第 103–109 行 `finish` 只序列化 `{at, method, path, status, ms}`）：没有强制 redaction 中间件，若将来在 `finish` 里多塞了 `req.headers` 之类的字段，凭证可能意外泄露。`test-engine-llm-bridge.mjs` 第 232–247 行用正则 `/authorization|bearer/i` 与 key 字串反向钉住这一约束。
- **`/v1/models` 返回的 `data` 只有配置的一个模型**（第 130 行），不支持多模型列表；引擎若按多模型协商会拿到单点结果。
- **流式错误帧用 `data: {error}` 表达失败**（`llm-bridge.js` 第 195 行），是 OpenAI 约定做法，但引擎必须正确解析 `error` 事件而非当作普通 chunk——否则半截流会被误读为内容。
- **`max_body` 上限 32MB**（第 34 行）对超长对话历史可能是硬约束；超限直接 `413` 并 `req.destroy()`（第 63–64 行），不回 JSON 错误体。
