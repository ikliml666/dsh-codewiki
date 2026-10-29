---
title: engine_llm_bridge
type: module
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - test-engine-llm-bridge.mjs
  - test-engine-bridge.mjs
  - lib/engine/native-run.js
  - lib/engine/python/entry.py
  - index.js
tags: [engine, llm, bridge, openai-compatible, loopback, security]
---

## Overview

`lib/engine/llm-bridge.js` 实现一条**宿主模型 loopback 桥**（阶段 1B 薄桥）。它的唯一职责是：把 FSoft 原生引擎发来的 OpenAI-compatible HTTP 请求，翻译成宿主的 `llm.stream(GenerateOptions)`，再把宿主的 chunk 流翻译回 OpenAI 响应（非流式 JSON / 流式 SSE）。

整个迁移最硬的约束在文件头注释（第 6–17 行）说得很清楚——**凭证边界**：

- 桥**不读**任何凭证文件、**不接收**真实 `api_key`、**不转发** `Authorization` 头；
- 引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个占位 key（`dsh-bridge-...`）；占位 key 的唯一作用是让引擎的 OpenAI 客户端肯发请求；
- 真实凭证只存在于宿主 provider 内部——桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它；
- 访问日志与错误日志只记 method/path/状态/耗时/请求 id，**不记** `Authorization`。

为什么必须 loopback + 随机端口 + 占位 key 三重保险（第 14–17 行）：桥等于"用宿主凭证换任意模型调用"的开关。绑定 127.0.0.1 阻断外网；随机端口让同机其它进程猜不到；占位 key 校验挡住误连/端口扫描。三者缺一都等于把宿主凭证开放给本机任意进程。

协议面只实现引擎真正用到的部分（第 19–22 行）：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/chat/completions` | POST | 非流式（`stream` 缺省/false）与流式（`stream: true`） |
| `/v1/models` | GET | 引擎/探针的连通性检查（**需要**占位 key） |
| `/healthz` | GET | 桥自身存活（**不需要** key，且不泄露任何凭证信息） |

纯请求/响应转换（无 I/O、无网络、无密钥）被抽到 `lib/engine/openai-bridge.js`，便于 TDD 钉死最容易悄悄错的映射逻辑（见 `test-engine-bridge.mjs`）；本文件只做 HTTP 壳、准入闸门与边界行为，它们错了不会报错、只会悄悄把凭证能力开放出去（见 `test-engine-llm-bridge.mjs`）。

## Key Components

### `lib/engine/llm-bridge.js`

**模块级常量**

- `DEFAULT_TIMEOUT_MS` — 第 33 行，`10 * 60 * 1000`（10 分钟），单次模型调用默认超时。
- `MAX_BODY_BYTES` — 第 34 行，`32 * 1024 * 1024`（32 MiB），请求体大小上限，超限返回 413。

**内部助手函数**

- `bearerOf(req)` — 第 38–43 行。从 `Authorization` 头里取出 bearer token，只用于**校验占位 key**，取完即弃；绝不写日志、绝不放进请求对象、绝不传给 `llm`。
- `sendJson(res, status, body, extraHeaders = {})` — 第 45–54 行。写 JSON 响应（`content-type: application/json; charset=utf-8`、`content-length`、`cache-control: no-store`）。
- `readBody(req, limit = MAX_BODY_BYTES)` — 第 56–72 行。按字节缓冲读请求体，超 `limit` 抛 `statusCode: 413` 并 `req.destroy()`。
- `errorBody(message, type = 'bridge_error', code = null)` — 第 75–77 行。把上游异常翻译成 OpenAI 风格的错误体 `{ error: { message, type, code } }`，引擎按 `status` + `error.message` 记账。

**对外唯一导出**

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs = DEFAULT_TIMEOUT_MS, onLog })` — 第 90–241 行。启动桥，返回 `Promise<{ url, placeholderKey, port, stats(), close() }>`。

  参数（第 82–89 行）：

  | 参数 | 类型 | 说明 |
  | --- | --- | --- |
  | `llm` | `{stream: Function}` | 宿主 llm 服务（**只用 `stream`，不碰凭证**） |
  | `provider` | string | 宿主 provider id（如 `workbuddy`） |
  | `model` | string | 模型 id（如 `hy3`） |
  | `reasoningEffort` | string（可选） | 思考档位 |
  | `timeoutMs` | number（可选） | 单次模型调用超时 |
  | `onLog` | `(entry)=>void`（可选） | 结构化日志回调（**不含** `Authorization`） |

  启动期校验（第 91–93 行）：缺 `llm`/`llm.stream`、缺 `provider`、缺 `model` 都直接抛错——不让桥以半配置状态监听端口。

  行为要点：

  - 第 96 行：占位 key 每次启动随机生成（`dsh-bridge-${randomBytes(32).toString('hex')}`），不复用、不落盘、不进日志。
  - 第 97 行：`stats` 计数器 `{ requests, streamRequests, authRejected, failures, lastError }`。
  - 第 100–226 行：请求处理器。路由顺序：第 112–115 行 `/healthz`（仅记状态，200）；第 118–126 行 所有 `/v1` 请求强制校验占位 key（第 120 行 `PLACEHOLDER_KEY_PATTERN.test(token) && token === placeholderKey`，不符则 401 且错误体**不回显**收到的 key）；第 128–131 行 `/v1/models` 返回 `{ object:'list', data:[{id:model, object:'model', owned_by:provider}] }`；第 133–136 行 非 `POST /v1/chat/completions` 一律 404。
  - 第 139–157 行：读 body → JSON 解析（失败 400）→ `toLlmRequest({ provider, model, reasoningEffort, body })`（失败 400，记录 `lastError`）。
  - 第 159–160 行：判 `body.stream === true`。
  - 第 163–167 行：客户端断连（`res.on('close')`）→ `ac.abort()`；超时 `setTimeout` → `ac.abort()`；`cleanup()` 清定时器与监听。
  - 第 169–188 行：迭代 `llm.stream({ ...options, signal: ac.signal })`，逐 chunk 边收边转——流式时首帧前 `writeHead` 200（`text/event-stream`），用 `chunksToSse` 逐帧下发，**跳过** `[DONE]`（留给收尾统一发）。
  - 第 189–203 行：上游失败。流已开始则写 `error` 帧 + `[DONE]` 收尾（200）；流未开始则 502 + `errorBody(..., 'upstream_error')`。
  - 第 206–214 行：流式收尾——补 `[DONE]` 帧、`res.end()`、记 200。
  - 第 216–218 行：非流式用 `chunksToCompletion` 折叠成完整 OpenAI 响应并 200 返回。
  - 第 219–225 行：最外层兜底 500（流未发头则 `sendJson`，已发头则 `res.end()`）。
  - 第 228–240 行：监听 `server.listen(0, '127.0.0.1', ...)`，返回 `{ url: http://127.0.0.1:${port}/v1, placeholderKey, port, stats: () => ({...stats}), close: () => new Promise(done => server.close(() => done())) }`。

### `lib/engine/openai-bridge.js`（桥委托的纯转换层）

本文件无 I/O、无网络、无密钥，是 `llm-bridge.js` 第 26–31 行 `import` 的来源。被桥直接使用的导出：

- `PLACEHOLDER_KEY_PATTERN` — 第 29 行，正则 `/^dsh-bridge-[a-z0-9-]+$/`，桥用来做占位 key 的格式预检。
- `toLlmRequest({ provider, model, reasoningEffort, body })` — 第 128–161 行。OpenAI 请求体 → DSH `GenerateOptions` 子集：`system` 消息抽到 `system` 槽；`assistant.tool_calls` → `tool-call` 块（arguments 保持原始 JSON 字符串）；`tool` 消息 → `ToolResultMessage`；`tools[].function` → `ToolSchema`。返回对象永不含 `apiKey`。空 `messages` 抛错（第 132、146 行）。导出测试见 `test-engine-bridge.mjs`。
- `chunksToCompletion({ id, model, chunks })` — 第 236–256 行。DSH chunk 流 → 非流式 OpenAI 响应体（经 `foldChunks` 折叠）。
- `chunksToSse({ id, model, created, chunks })` — 第 265–317 行。DSH chunk 流 → SSE 帧数组（末帧 `[DONE]`）。

同文件内被上述函数复用的非导出助手：`contentToBlocks`（第 38–51 行）、`toolsToSchemas`（第 53–66 行）、`messageToDsh`（第 76–122 行，含 `assistant` 历史消息必须带 `source.kind='model'` 的硬约束）、`finishReasonToOpenAI`（第 164–173 行）、`usageToOpenAI`（第 176–188 行，互斥计数 `inputTokens` 不含缓存，故 `prompt_tokens = inputTokens + cacheRead + cacheWrite`）、`foldChunks`（第 192–233 行）、`sseFrame`（第 259–262 行）。`isPlaceholderKey` 也在此导出（第 31–33 行），桥本身未用，但被测试与校验逻辑消费。

## Architecture

## Data Flow

## Connections

## Known Issues
