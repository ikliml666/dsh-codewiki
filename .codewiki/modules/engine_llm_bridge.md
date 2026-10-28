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
  - lib/engine/client.js
tags: [engine, llm, bridge, openai-compatible, credential-boundary, loopback]
---

## Overview

`engine_llm_bridge` 把宿主（DeepSeek Harness）的 LLM 服务暴露成 FSoft 原生引擎能消费的 OpenAI-compatible HTTP 后端。FSoft 引擎只认 `base_url` + `api_key` 这一套 OpenAI 协议，而 DSH 的真实凭证只存在于宿主 provider 配置里（插件既不保存也不传递密钥，0.10.1 起硬约束）。桥因此是一个进程内、绑定 `127.0.0.1` 随机端口的 HTTP 服务：引擎拿一个**每次启动随机生成**的占位 key 打过来，桥把请求翻译成宿主 `llm.stream(GenerateOptions)`，再把 chunk 流翻译回 OpenAI 响应。

模块由两层组成：

- `lib/engine/llm-bridge.js`（本模块主文件，阶段 1B 薄桥）：HTTP server、准入闸门（占位 key 校验）、请求体读取、流式/非流式响应拼装、超时与取消、结构化日志。**唯一入口** `startLlmBridge`（第 90 行）返回一个句柄 `{url, placeholderKey, port, stats, close}`。
- `lib/engine/openai-bridge.js`（纯转换层，无 I/O、无网络、无密钥）：被 [[engine_native_run]] 与 `test-engine-bridge.mjs` 直接复用，负责 OpenAI 请求体 ↔ DSH `GenerateOptions`、DSH `StreamChunk` 流 ↔ OpenAI 响应（非流式 JSON / 流式 SSE）。这一层可独立 TDD 钉死，是最容易悄悄出错、且错了极难查的部分。

核心安全不变量（桥的「最不能破的一条」，见 llm-bridge.js 第 6–17 行注释）：桥**不读**任何凭证文件、**不接收**真实 `api_key`、**不转发** `Authorization` 头。真实凭证只活在宿主 provider 内部，桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它。访问/错误日志只记 `method/path/status/ms/requestId`，绝不记 `Authorization`，也不记占位 key 本身。

## Key Components

### lib/engine/llm-bridge.js

- `DEFAULT_TIMEOUT_MS`（第 33 行）：`10 * 60 * 1000`，单次模型调用默认超时（可被 `opts.timeoutMs` 覆盖）。
- `MAX_BODY_BYTES`（第 34 行）：`32 * 1024 * 1024`，请求体上限；超了返回 413（`readBody` 第 63 行）。
- `bearerOf(req)`（第 38–43 行）：从 `Authorization` 头取出 bearer token。只用于**校验占位 key**，取完即弃——绝不写入日志、绝不放进请求对象、绝不传给 `llm`。
- `sendJson(res, status, body, extraHeaders)`（第 45–54 行）：写 JSON 响应，固定 `content-type: application/json; charset=utf-8`、`cache-control: no-store`，并带 `content-length`。
- `readBody(req, limit)`（第 56–72 行）：按字节累积请求体；超过 `limit`（默认 `MAX_BODY_BYTES`）则 `reject({statusCode: 413})` 并 `req.destroy()`。
- `errorBody(message, type, code)`（第 75–77 行）：把上游异常翻译成 OpenAI 风格错误体 `{error: {message, type, code}}`，引擎按 `status + error.message` 记账。
- `startLlmBridge({llm, provider, model, reasoningEffort, timeoutMs, onLog})`（第 90–241 行）：启动桥。校验 `llm.stream`、`provider`、`model` 必须存在（第 91–93 行），否则抛错，**不让桥以半配置状态监听端口**。启动后：
  - 随机生成 `placeholderKey = `dsh-bridge-${randomBytes(32).toString('hex')}``（第 96 行），不复用、不落盘、不进日志。
  - `stats` 计数：`requests / streamRequests / authRejected / failures / lastError`（第 97 行）。
  - `server.listen(0, '127.0.0.1', …)`（第 230 行），绑定 loopback + 随机端口。
  - 返回句柄（第 232–238 行）：`url`（`http://127.0.0.1:<port>/v1`）、`placeholderKey`、`port`、`stats()`（快照拷贝）、`close()`（关闭 server 的 Promise）。
  - 路由处理（第 100–226 行）：
    - `GET /healthz`：返回 `200 {ok, provider, model}`，**不需要 key**，且不泄露任何凭证信息（测试见 test-engine-llm-bridge.mjs 第 222 行）。
    - 所有 `/v1` 请求先校验占位 key（第 118–126 行）：`token` 必须匹配 `PLACEHOLDER_KEY_PATTERN` 且**等于**本次随机 key；否则 `authRejected++`、返回 `401 errorBody('invalid bridge key', 'invalid_request_error', 'invalid_api_key')`。错误体**不回显**收到的 key（第 123 行注释）。
    - `GET /v1/models`：返回 `200 {object:'list', data:[{id: model, object:'model', owned_by: provider}]}`（第 128–131 行）。
    - `POST /v1/chat/completions`（第 133–218 行）：非 `POST`/非该路径一律 `404`。`readBody` → `JSON.parse`（失败 400）→ `toLlmRequest`（失败 400，记录 `lastError`）。`wantsStream = body.stream === true`。
  - 流式行为（第 162–214 行）：用 `AbortController` 监听 `res.on('close')` 中断上游（省 token，让引擎取消语义生效），`setTimeout(timeoutMs)` 超时也 abort。逐帧边收边发 SSE（`chunksToSse`，每帧一个 chunk，`[DONE]` 留到收尾统一发，第 183–187 行）。流已开始后上游失败：发一个 `error` 事件帧 + `[DONE]` 收尾（第 193–200 行），否则引擎 SSE 读取会挂住；非流式失败则 `502 + errorBody('upstream_error')`（第 201–202 行）。客户端断连/超时正常收尾也以 `data: [DONE]\n\n` 结束（第 206–214 行）。非流式：用 `chunksToCompletion` 拼成完整响应体（第 216–218 行）。
  - 顶层兜底（第 219–225 行）：未预期异常记 `500 bridge_error`，头已发则直接 `res.end()`。

### lib/engine/openai-bridge.js（纯转换层）

- `PLACEHOLDER_KEY_PATTERN`（第 29 行）：`/^dsh-bridge-[a-z0-9-]+$/`，占位 key 格式（被 llm-bridge.js 的 `bearerOf`/`startLlmBridge` 复用）。
- `isPlaceholderKey(value)`（第 31–33 行）：类型守卫，只认 `PLACEHOLDER_KEY_PATTERN` 通过的字符串。
- `contentToBlocks(content)`（第 38–51 行）：OpenAI `content`（string 或 parts 数组）统一摊平成 DSH `ContentBlock[]`；`image_url` 等非文本部分显式跳过（引擎只发文本）。
- `toolsToSchemas(tools)`（第 53–66 行）：`tools[].function` → DSH `ToolSchema`（`name/description/parameters` 原样）。**缺这一步会让 agentic 工具循环退化成模型空谈**。
- `messageToDsh(msg, route)`（第 76–122 行）：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。`system`/`developer` 抽成 text 便于合并；`assistant` 带 `tool_calls` 时还原成 `tool-call` 块（保留**原始 JSON 字符串** `arguments`，不提前 parse）；`tool` 角色 → `toolCallId + isError` 的 `ToolResultMessage`；`assistant` 历史消息必须带 `source: {kind:'model', provider, model}`（宿主 `forAdapter` 会读 `source.replayState`，缺 source 直接抛错，见第 71–75 行注释与 test-engine-bridge.mjs 第 359–400 行回归）。
- `toLlmRequest({provider, model, reasoningEffort, body})`（第 128–161 行）：OpenAI 请求体 → DSH `GenerateOptions` 子集（不含 `signal/sessionId`，由服务器层加）。校验 `provider/model` 非空、`messages` 为**非空数组**（否则抛错）。`system` 抽到 `system` 槽；`temperature/max_tokens/stop` 映射；未知字段（如 `response_format/seed`）不塞入。返回值**永远没有 `apiKey` 字段**（第 27 行 / test 第 348 行）。
- `finishReasonToOpenAI(reason)`（第 164–173 行）：DSH `FinishReason` → OpenAI `finish_reason`：`tool-calls→tool_calls`、`max-tokens→length`、`error/aborted→error`、`stop→stop`、默认 `stop`。
- `usageToOpenAI(usage)`（第 176–188 行）：DSH 的 `TokenUsage` 是**互斥**计数（`inputTokens` 不含缓存），OpenAI 的 `prompt_tokens` 含缓存，故 `prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`，缓存单列在 `prompt_tokens_details.cached_tokens`（test 第 104 行断言净输入 10 + 缓存读 6 = 16）。
- `foldChunks(chunks)`（第 192–233 行）：把 chunk 流折叠成 `{text, finish, usage, toolCalls}` 中间态。按 `index` 拼接 `tool-call-delta`，只保留**有 name** 的调用（无 name 的引擎无法执行）；`reasoning-delta` 不进正文。非流式与流式两条路径共用此折叠，保证同源。
- `chunksToCompletion({id, model, chunks})`（第 236–256 行）：折叠结果 → OpenAI 非流式响应体（`object:'chat.completion'`）。纯工具调用时 `content` 为 `null`（不是空串），否则空串（test 第 227、238 行）。
- `sseFrame(payload)`（第 259–262 行）：把 payload 序列化成 `data: <json>\n\n`；`[DONE]` 是独立帧。
- `chunksToSse({id, model, created, chunks})`（第 265–317 行）：chunk 流 → SSE 帧数组。首个帧带 `role: assistant`，文本增量逐帧，`usage` 单独成帧，末帧带 `finish_reason`，**必须**以 `data: [DONE]\n\n` 收尾（否则引擎流读取挂住）。流未给 `finish` 时也补一个终帧（第 311–314 行）。

## Architecture

桥只做「反向代理 + 协议翻译」，凭证在宿主侧，永不过桥：

```text
            FSoft engine (lib/engine/python/entry.py)
            reads CODEWIKI_BASE_URL / CODEWIKI_API_KEY
            from process env (set by index.js nativeEnginePlan)
                       │  HTTP POST /v1/chat/completions
                       │  Bearer <placeholderKey>
                       ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ startLlmBridge()   lib/engine/llm-bridge.js                   │
   │   · bind 127.0.0.1 : random port (server.listen(0,...))       │
   │   · every /v1 route: verify placeholderKey (401 otherwise)    │
   │   · GET /healthz | GET /v1/models | POST /v1/chat/completions│
   │   · readBody → toLlmRequest ──┐  (lib/engine/openai-bridge.js)│
   │   · llm.stream({...options, signal})                         │
   │   · chunksToCompletion / chunksToSse ─┘                       │
   │   · timeout + res 'close' → AbortController (cancel/abort)    │
   └───────────────────────────────┬──────────────────────────────┘
                                    │ llm.stream(GenerateOptions)
                                    ▼
                       Host llm service (real provider credentials)
                       (live here; bridge never sees the api_key)
```

## Data Flow

1. **建桥**：`[[engine_native_run]].runNativeJob` 在第 2 步调用 `startLlmBridge({llm, provider, model, reasoningEffort, timeoutMs, onLog})`（native-run.js 第 238–247 行），拿到 `{url, placeholderKey, port}`。
2. **注入引擎环境**：生产通道里 `index.js` 的 `nativeEnginePlan(channel, {bridge, model, clusterModel})`（index.js 第 252–268 行）把 `bridge.url → CODEWIKI_BASE_URL`、`bridge.placeholderKey → CODEWIKI_API_KEY`、`model → CODEWIKI_MAIN_MODEL/CODEWIKI_CLUSTER_MODEL` 写入子进程环境；同时设 `CODEWIKI_NO_KEYRING=1` 关掉引擎自身读 keyring。（注意：model 必须由调用方显式传，桥返回对象**不含** `model` 字段，读 `bridge.model` 会得到 `undefined`——这是个真实踩坑，见 index.js 第 247–251 行注释。）
3. **引擎调用**：`lib/engine/python/entry.py` 的 `_model_config()`（entry.py 第 243–275 行）从进程环境读这三个变量，构造 `provider:'openai-compatible'` 的 config 交给 FSoft adapter。FSoft 发出的每个 chat completion 请求打到 `127.0.0.1:<port>/v1`。
4. **请求翻译**：桥对每个 `/v1` 请求先校验 `Authorization` 里的占位 key（`llm-bridge.js` 第 118–126 行）；通过后 `readBody → toLlmRequest`（`openai-bridge.js` 第 128 行）把 OpenAI 体翻成 `GenerateOptions`，再 `llm.stream({...options, signal: ac.signal})`（第 171 行）。
5. **响应翻译**：流式逐帧 `chunksToSse` 以 `[DONE]` 收尾；非流式 `chunksToCompletion` 拼完整 JSON（第 216–218 行）。
6. **取消/超时**：`res.on('close')` 与 `setTimeout(timeoutMs)` 都触发 `ac.abort()`，使宿主上游调用中断（省 token，让引擎取消语义真正生效；test 第 249–272、274–288 行断言）。
7. **收桥**：引擎退出后 `runNativeJob` 在 `finally` 里 `await bridge.close()`（native-run.js 第 289–292 行）——必须先关桥再关引擎，否则正在读流的引擎会拿到 502。

## Connections

- **上游编排**：`[[engine_native_run]]`（`lib/engine/native-run.js`）在「环境与锁」之后、跑引擎之前建立桥，并把 `bridge` 通过 `engineFor`（`index.js` 第 2753 行的 `nativeEnginePlan`）注入到 Python 引擎子进程的环境变量里。
- **引擎进程协议**：`[[engine_client]]`（`lib/engine/client.js`）负责起 Python 子进程、读 JSON-lines；桥与本模块共享「不读凭证、密钥只活进程环境」的边界约定（client.js 第 10 行注释）。
- **结果契约**：`[[engine_contract]]`（`lib/engine/contract.js`）定义 `engine-model` 等错误码；桥/原生通道把模型通道建立失败映射成 `engine-model`（native-run.js 第 253 行），上游 APIError 由 entry.py 的 `_classify_exception` 翻成 `engine-model`（entry.py 第 519–521 行）。
- **宿主 LLM 适配**：桥调用的 `llm.stream` 是宿主 provider 服务（与 `[[agentic-host]].makeHostStream` 同一套宿主接口），但桥不依赖 `agentic-host` 的 BlockAssembler。
- **Python 入口**：`lib/engine/python/entry.py` 是本桥的**唯一生产消费者**，凭证通过 `CODEWIKI_*` 环境变量单向流入引擎，密钥永不过桥。

## Known Issues

- **model 不能从 bridge 读**：`startLlmBridge` 的返回对象只有 `{url, placeholderKey, port, stats, close}`，**不含** `model` 字段（llm-bridge.js 第 232–238 行；index.js 第 247–251 行注释）。曾经写成 `bridge.model` 得到 `undefined` → `CODEWIKI_MAIN_MODEL` 空串 → entry.py `_model_config` 判「缺少模型通道」→ 每次原生编译都在 `cluster` 阶段以 `engine-model` 失败，且失败原因看着像环境没配好。正确写法：`model` 由 `index.js` 从编译模型配置 `c.batchModel` 显式传入（index.js 第 2757 行）。
- **桥必须后于引擎关闭**：`runNativeJob` 在 `finally` 关闭桥（native-run.js 第 289–292 行）。先关桥会让还在读 SSE 流的引擎立刻拿到 502；测试与编排都依赖「引擎先退出、桥后收」。
- **占位 key 只认本次随机值**：`token !== placeholderKey` 即拒（llm-bridge.js 第 120 行）。即使伪造一个符合 `dsh-bridge-<64hex>` 形态的 key 也会被 401（test-engine-llm-bridge.mjs 第 211–220 行）；真实 `sk-...` key 同样 401 且绝不回显（第 80–89 行）。
- **assistant 历史消息必须带 source**：`toLlmRequest` 生成的 `assistant` 消息若无 `source`，宿主 `forAdapter()` 会读 `source.replayState` 抛 `Cannot read properties of undefined`，整轮调用被判 `finish=error`（openai-bridge.js 第 71–75 行；test-engine-bridge.mjs 第 359–400 行）。桥不伪造 `replayState`（始终 `undefined`），只填 `provider/model`。
- **流式必须 `[DONE]` 收尾**：任何路径（正常、上游中途失败、客户端断连）都必须在 SSE 末尾发 `data: [DONE]\n\n`，否则引擎端的流读取会挂住（llm-bridge.js 第 183–187、206–214 行；test 第 131–163 行）。
- **usage 字段名映射是互斥计数**：DSH `inputTokens` 不含缓存，OpenAI `prompt_tokens` 含缓存，桥在 `usageToOpenAI` 里做 `inputTokens + cacheRead + cacheWrite` 合并（openai-bridge.js 第 176–188 行）。若引擎侧用量账本显示 0，优先怀疑流式 `usage` 帧没带出去（test-engine-bridge.mjs 第 320–334 行）。
- **日志副作用约束**：`onLog` 回调只收到 `{at, method, path, status, ms}`（llm-bridge.js 第 103–109 行），且 `bearerOf` 取到的 key 绝不进日志；`errorBody` 也不回显收到的 key。测试强制断言日志里无 `authorization/bearer` 且无占位 key 本身（test 第 232–247 行）。
