---
title: engine_bridges
type: module
source_files:
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
tags: [engine, bridge, openai, llm, loopback, credential-boundary]
---

## Overview

`engine_bridges` 是 DSH（CodeWiki）迁移里的「阶段 1B 薄桥」：它把**只认 OpenAI-compatible 协议的 FSoft 原生引擎**对接到 DSH 宿主自己的 `llm` 服务，使原生引擎在不拿到任何真实密钥的前提下，用宿主 provider 的凭证去调模型。

整个模块拆成两个文件，职责边界刻意切分：

- `lib/engine/openai-bridge.js`：纯转换层（无 I/O、无网络、无密钥）。只做两件最容易悄悄错的事情，并可被 TDD 钉死：
  1. OpenAI `chat.completions` 请求体 → DSH `GenerateOptions`（`toLlmRequest`）；
  2. DSH `StreamChunk` 流 → OpenAI 响应（非流式 JSON / 流式 SSE，`chunksToCompletion` / `chunksToSse`）。
- `lib/engine/llm-bridge.js`：进程内 HTTP 服务器（`startLlmBridge`）。跑在 `127.0.0.1` 随机端口上，把引擎发来的 OpenAI 请求翻译成 `llm.stream(GenerateOptions)`，把 chunk 流翻回 OpenAI 响应，并承担「宿主凭证看门人」的安全边界（loopback + 随机端口 + 每次随机生成的占位 key 校验）。

**凭证边界（本模块最硬的约束，见 `lib/engine/llm-bridge.js` 第 6–17 行注释）**：桥不读任何凭证文件、不接收真实 `api_key`、不转发 `Authorization` 头；引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 与一个占位 key（形如 `dsh-bridge-...`）；真实凭证只存在于宿主 provider 内部，桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它；访问日志只记 method/path/状态/耗时/请求 id，**不记** `Authorization`。

**协议面（只实现引擎真正用到的部分，不假装完整 OpenAI，见 `lib/engine/llm-bridge.js` 第 19–22 行）**：

- `POST /v1/chat/completions`：非流式（`stream` 缺省/false）与流式（`stream: true`）
- `GET /v1/models`：引擎/探针的连通性检查（需占位 key）
- `GET /healthz`：桥自身存活（无需 key，不含任何模型/凭证信息）

生产通道里，桥由 `lib/engine/native-run.js` 的 `runNativeJob` 在阶段 2（模型桥）启动（`lib/engine/native-run.js` 第 381–407 行），把返回的 `{ url, placeholderKey }` 注入到引擎子进程的环境，引擎子进程据此把 HTTP 打到本机桥上。

## Key Components

### `lib/engine/openai-bridge.js`（纯转换层，无 I/O）

**常量与校验**

- `PLACEHOLDER_KEY_PATTERN`（第 29 行）：正则 `/^dsh-bridge-[a-z0-9-]+$/`，仅用于识别桥自己生成的占位 key。
- `isPlaceholderKey(value)`（第 31–33 行）：返回 `value` 是否为字符串且匹配 `PLACEHOLDER_KEY_PATTERN`。

**内部辅助（模块私有）**

- `textBlock(text)`（第 35 行）：构造 `{ type: 'text', text }` 内容块。
- `contentToBlocks(content)`（第 38–51 行）：把 OpenAI 的 string 或 parts 数组摊平成 DSH `ContentBlock[]`；`image_url` 等非文本部分被显式跳过（引擎只发文本）。
- `toolsToSchemas(tools)`（第 53–66 行）：把 `tools[].function` 映射成 DSH `ToolSchema[]`（`name`/`description`/`parameters` 原样）。无有效工具时返回 `undefined` 而非空数组。
- `messageToDsh(msg, route)`（第 76–122 行）：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。`system`/`developer` 抽成 text 便于合并；`assistant` 带 `tool_calls` 时还原成 `tool-call` 块（arguments 保持**原始 JSON 字符串**，不提前 parse）；`tool` 消息映射成带 `toolCallId` + `isError` 的工具结果；`assistant` 历史消息会带上 `source = { kind: 'model', provider, model }`（宿主 `forAdapter` 会读 `source.replayState`，缺 source 会抛错，见第 71–75 行注释）。

**公开转换函数**

- `toLlmRequest({ provider, model, reasoningEffort, body })`（第 128–161 行）：OpenAI 请求体 → DSH `GenerateOptions` 子集（不含 signal/sessionId）。校验 provider/model 必填、messages 为非空数组，否则抛错；system 抽到 `system` 字段；optional 字段 `temperature`/`max_tokens`/`stop` 映射为 `temperature`/`maxTokens`/`stop`；`tools`、`reasoningEffort` 有则带；**返回值里永远没有 apiKey 字段**（第 27 行安全边界）。
- `finishReasonToOpenAI(reason)`（第 164–173 行）：DSH `FinishReason` → OpenAI `finish_reason`。`{kind:'tool-calls'}→'tool_calls'`、`{kind:'max-tokens'}→'length'`、`{kind:'error'|'aborted'}→'error'`、`{kind:'stop'}|缺省→'stop'`。
- `chunksToCompletion({ id, model, chunks })`（第 236–256 行）：chunk 流 → OpenAI 非流式响应体。纯工具调用时 `content` 为 `null`（OpenAI 语义）；`finish_reason` 缺省按是否有 tool call 取 `tool_calls`/`stop`；usage 经 `usageToOpenAI` 折算。
- `sseFrame(payload)`（第 259–262 行）：把对象或字符串包成 `data: <json>\n\n` 一帧；`[DONE]` 是独立帧。
- `chunksToSse({ id, model, created, chunks })`（第 265–317 行）：chunk 流 → SSE 帧数组（每帧一个完整 chunk，末帧 `[DONE]`）。首帧带 `role`；`tool-call-delta` 逐帧带 `id`/`name`/`arguments` 片段；`usage` 单独成帧；`finish` 没出现也补一个终帧，否则引擎流读取会挂住。

**内部折叠/折算（模块私有）**

- `usageToOpenAI(usage)`（第 176–188 行）：DSH `TokenUsage` 是**互斥**计数（`inputTokens` 不含缓存），OpenAI 的 `prompt_tokens` 含缓存 → `prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列在 `prompt_tokens_details.cached_tokens`。
- `foldChunks(chunks)`（第 192–233 行）：把 chunk 流折叠成 `{ text, finish, usage, toolCalls }` 中间态；`tool-call-delta` 按 `index` 拼接 `arguments`，只保留**有 name** 的调用（无 name 的引擎无法执行）；非流式与流式两条路径都从它出发，保证行为同源。

### `lib/engine/llm-bridge.js`（进程内 HTTP 桥）

**常量**

- `DEFAULT_TIMEOUT_MS = 10 * 60 * 1000`（第 33 行）：单次模型调用默认超时。
- `MAX_BODY_BYTES = 32 * 1024 * 1024`（第 34 行）：请求体上限，超过返回 413。

**内部辅助（模块私有）**

- `bearerOf(req)`（第 38–43 行）：从 `Authorization` 头取 bearer token，只用于校验占位 key，取完即弃，**绝不**写日志/放进请求/传给 llm。
- `sendJson(res, status, body, extraHeaders)`（第 45–54 行）：写 JSON 响应（`cache-control: no-store`）。
- `readBody(req, limit)`（第 56–72 行）：异步读请求体，超限（默认 `MAX_BODY_BYTES`）抛 `statusCode:413` 并销毁连接。
- `errorBody(message, type, code)`（第 75–77 行）：构造 OpenAI 风格错误体 `{ error: { message, type, code } }`。

**公开函数**

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`（第 90–241 行）：启动桥，返回一个 Promise，resolve 出 `{ url, placeholderKey, port, stats(), close() }`：
  - 入参校验（第 91–93 行）：`llm.stream` 必须是函数、`provider`、`model` 必填，否则抛错（不让桥以半配置状态监听端口）。
  - 占位 key 每次随机生成：`dsh-bridge-${randomBytes(32).toString('hex')}`（第 96 行），不复用、不落盘、不进日志。
  - `stats`（第 97 行）：`{ requests, streamRequests, authRejected, failures, lastError }`，通过 `stats()` 只读暴露。
  - 路由（第 100–226 行）：`GET /healthz` 存活检查；所有 `/v1` 请求都必须带占位 key（`PLACEHOLDER_KEY_PATTERN` 匹配 **且** 等于本次生成的 `placeholderKey`，否则 401 且不回显收到的 key）；`GET /v1/models` 返回 `[{ id: model, object: 'model', owned_by: provider }]`；`POST /v1/chat/completions` 走 `toLlmRequest` 转换后调 `llm.stream`，非流式用 `chunksToCompletion`、流式用 `chunksToSse` 边收边发。
  - 取消与超时（第 163–167 行）：监听 `res` 的 `close` 与 `setTimeout(timeoutMs)` 来 `ac.abort()`，把信号透传给 `llm.stream`，使客户端断连/超时真正中止上游调用（省 token、取消语义生效）。
  - 失败处理（第 189–203 行）：流已开始时用「错误帧 + `[DONE]`」收尾（不挂住客户端）；未开始时返回 502 + OpenAI 错误体（引擎按 status 记账）。
  - 监听（第 228–240 行）：`server.listen(0, '127.0.0.1', ...)`，即随机端口 + 仅绑定 loopback，`url` 形如 `http://127.0.0.1:<port>/v1`。

## Architecture

两个桥文件的依赖方向是单向的：`llm-bridge.js` 导入并消费 `openai-bridge.js` 的纯转换函数，自己只负责 HTTP 与凭证边界；`openai-bridge.js` 零依赖、零 I/O，可独立单测。

```text
 FSoft 原生引擎 (Python 子进程)
        │  OpenAI-compatible HTTP
        │  POST /v1/chat/completions (+占位 key Bearer)
        ▼
┌─────────────────────────────────────┐
│ startLlmBridge (llm-bridge.js)       │  127.0.0.1:随机端口
│  · 占位 key 校验 (401 不回显key)      │
│  · 限流/超时/断连 → Ac.abort()       │
│  · 读体/日志(无Authorization)         │
└───────────────┬─────────────────────┘
                │ toLlmRequest → llm.stream(GenerateOptions)
                ▼
┌─────────────────────────────────────┐
│ openai-bridge.js (纯转换, 无 I/O)     │
│  toLlmRequest / foldChunks           │
│  chunksToCompletion / chunksToSse    │
│  finishReasonToOpenAI / usageToOpenAI│
└───────────────┬─────────────────────┘
                │ DSH StreamChunk 流
                ▼
         宿主 llm 服务 (llm.stream, 持有真实凭证)
                │
                ▼ (回程: chunk → OpenAI 响应)
┌─────────────────────────────────────┐
│ 响应返回引擎: JSON / SSE ([DONE])     │
└─────────────────────────────────────┘
```

生产接线：`runNativeJob`（`lib/engine/native-run.js`，阶段 2「模型桥」`第 381–407 行`）调用 `bridgeImpl`（`deps.bridge ?? realBridge`，即 `startLlmBridge`），把 `cfg.batchProvider`/`cfg.batchModel` 路由进去，再把返回的 `bridge`（含 `url`/`placeholderKey`）通过 `engineFor({ requestId, bridge })` 注入到引擎子进程环境。桥必须在引擎退出后关闭（第 454–457 行 `finally { await bridge?.close?.() }`，先关桥会让还在读流的引擎拿到 502）。

## Data Flow

**请求方向（引擎 → 宿主）**

1. 引擎 POST `http://127.0.0.1:<port>/v1/chat/completions`，带 `Authorization: Bearer <占位key>` 与 OpenAI 请求 JSON。
2. `startLlmBridge` 服务器层校验占位 key（`第 118–126 行`）：不匹配 → 401，错误体**不回显**收到的 key（避免把误配的真实 key 写进日志）。
3. `readBody` 读体，超限 413；非法 JSON → 400（`第 139–147 行`）。
4. `toLlmRequest` 把请求体转成 `GenerateOptions`：system 抽槽、`assistant.tool_calls` → `tool-call` 块（arguments 保持原始 JSON 字符串）、`tool` 消息 → `ToolResultMessage`（`callId` 必须配对）、`tools[]` → `ToolSchema`（`第 149–157 行`）。缺 provider/model/空 messages 抛错，错误体不触达 `llm`。
5. 带 `AbortController.signal` 调 `llm.stream(options)`（`第 171 行`）；`res` 的 `close` 与 `timeoutMs` 定时器都会 `ac.abort()`（`第 163–167 行`）。

**响应方向（宿主 → 引擎）**

- 非流式：攒齐所有 chunk → `chunksToCompletion` 生成单个 JSON（`第 216–218 行`）。
- 流式：边收边发 —— 首包前先 `writeHead(200, text/event-stream)`（`第 174–181 行`），对 Dedicated 帧调 `chunksToSse` 逐帧 `res.write`，但跳过单帧自带的 `[DONE]`（收尾统一发，`第 182–187 行`）；流结束后统一 `data: [DONE]\n\n` + `end`（`第 206–214 行`）。
- `foldChunks` 折叠时：`text-delta` 累加正文、`tool-call-delta` 按 `index` 拼接 `arguments`（只保留有 name 的调用）、`reasoning-delta` 不进正文、`usage`/`finish` 记录（`openai-bridge.js` 第 192–233 行）。
- usage 折算：`prompt_tokens = inputTokens + cacheRead + cacheWrite`，`prompt_tokens_details.cached_tokens = cacheRead`（`openai-bridge.js` 第 176–188 行）。

**失败回程**

- 流已开始出错：写错误帧（OpenAI `error` 事件风格）+ `[DONE]` + `end`（`第 193–200 行`），让引擎 SSE 读取不挂住。
- 流未开始出错：502 + `errorBody`（`第 201–202 行`）。
- 顶层异常：500（`第 219–225 行`）。

**结构化日志（凭证不泄露）**：`onLog` 回调只收到 `{ at, method, path, status, ms }`（`第 103–109 行`），测试断言日志里永不出现 `authorization|bearer|占位key`（`test-engine-llm-bridge.mjs` 第 232–247 行）。

## Connections

- [[engine-native-run]]（`lib/engine/native-run.js`）：生产通道。阶段 2「模型桥」调用 `startLlmBridge`，把 `url`/`placeholderKey` 注入引擎子进程环境；桥在引擎退出后才 `close()`。
- [[engine-client]]（`lib/engine/client.js`）：同属 engine 模块。注意 `client.js` 自己**不读凭证、不连模型**（第 10 行注释），模型通道单独由本桥提供；两者都服务于 FSoft 原生引擎，但职责正交（跨进程协议 vs 模型 loopback）。
- [[engine-contract]]（`lib/engine/contract.js`）：桥产出的 `finish_reason`/`usage` 映射语义与契约阶段枚举（无 LLM 的 graph/cluster/articles）对齐；`runNativeJob` 终态判定（`engine-missing`/`engine-model`/`engine-crashed` 等 code）在桥失败时接入。
- [[engine-quality-gate]]（`lib/engine/quality-gate.js`）：桥产出的文章经引擎写出后由质量门校验；引擎 done 不能替代质量门（见 `lib/engine/native-run.js` 第 503 行注释）。
- [[engine-apply-plan]]（`lib/engine/apply-plan.js`）：落地器。桥关闭时机与 apply 的 pre-image 互斥（先关桥会让引擎拿 502）。
- [[agentic-host]]（`lib/agentic-host.js`）：宿主 `llm.stream` 的另一种调用方（agentic 工具循环）。本桥是「宿主 llm 服务」的又一个消费方——桥通过 `opts.llm.stream` 间接触发宿主真实凭证，自身不持有密钥。

## Known Issues

- **占位 key 不防「本机已拿到正确 key 的任意进程」**：loopback + 随机端口 + 占位 key 的组合只挡外网、防端口扫描、防误连，但同一台机器上**已经拿到 `url` 与 `placeholderKey` 的进程**（即引擎子进程本身，或在 `close()` 之前泄漏了返回值的进程）可任意用宿主凭证调模型。这是设计取舍而非缺陷：`lib/engine/llm-bridge.js` 第 14–17 行注释明确三者缺一等于把凭证开放给本机任意进程，因此端口与 key 都随机且只在进程内传递（见 `lib/engine/native-run.js` 第 381–407 行）。
- **流式逐帧下发时，`chunksToSse` 单帧自带的 `[DONE]` 被手动跳过**：`startLlmBridge` 第 184–186 行注释说明，为防止逐帧发时把 `[DONE]` 提前发掉，帧级 `[DONE]` 被忽略，只在收尾统一发。若未来直接把 `chunksToSse` 整段输出（不加这个过滤），会出现两个 `[DONE]`，但引擎一般容忍重复终止帧，目前未触发问题。
- **`tool-call-delta` 缺 name 时调用直接丢弃**：`openai-bridge.js` 第 222–231 行（`foldChunks`）只保留 `v.name` 非空的工具调用，无 name 的半截调用不会出现在结果里。这避免了「引擎无法执行的假调用」，但也意味着若上游真的先发无 name 的增量后补 name，早期帧会被丢掉——当前约定是 `name` 随首帧给出，测试见 `test-engine-bridge.mjs` 第 245–256 行。
- **`assistant` 历史消息必须带 `source` 否则宿主 `forAdapter` 抛错**：`openai-bridge.js` 第 71–75 行注释记录，缺 `source` 会抛 `Cannot read properties of undefined (reading 'replayState')`，整轮被判 error，引擎侧表现为「Please return text or call a tool.」后耗尽重试。这是 1C 真模型才暴露的回归点，纯单测抓不到（见 `test-engine-bridge.mjs` 第 359–399 行）。
- **非流式与流式共用 `foldChunks` 同源逻辑**：设计上有意为之（`openai-bridge.js` 第 23–24 行），但好处也带来约束——任何对 `foldChunks` 的修改必须同时跑 `chunksToCompletion` 与 `chunksToSse` 两套断言，否则两条路径会行为分叉（引擎在流式路径上拿到半截 tool_calls）。
- **无禁用/注释掉的功能**：本模块两个文件中的函数、路由、字段目前均处于可用状态，没有出现被注释禁用（disabled）的协议面或转换分支；`/v1/models` 与 `/healthz` 虽默认实现简单，但都是生产路径在用的（连通性检查 / 存活探针）。
