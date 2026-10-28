---
title: engine_bridge
type: module
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/native-run.js
  - lib/engine/python/entry.py
  - index.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
tags: [engine, llm, openai-compatible, loopback-bridge, credential-boundary]
---

## Overview

`engine_bridge` 是宿主（DSH 插件）与「只认 OpenAI-compatible 协议」的 FSoft 原生引擎之间的翻译层。它把 FSoft 引擎发来的 OpenAI 风格请求（`POST /v1/chat/completions`、`GET /v1/models`、`GET /healthz`）翻译成宿主 `llm.stream(GenerateOptions)` 调用，再把宿主返回的 DSH `StreamChunk` 流翻译回 OpenAI 响应（非流式 JSON 或流式 SSE）。

模块由两个文件组成，职责分离刻意做得很窄：

- `lib/engine/openai-bridge.js`（第 1–318 行）是**纯转换层**：无 I/O、无网络、无密钥，只做「OpenAI 请求体 ↔ DSH GenerateOptions → StreamChunk ↔ OpenAI 响应」的映射。代码注释明确说「最容易出错的部分可被 TDD 钉死」（第 8 行），全部由 `test-engine-bridge.mjs` 覆盖。
- `lib/engine/llm-bridge.js`（第 1–242 行）是**进程内 loopback HTTP 服务端**：它把纯转换包进一个绑定 `127.0.0.1`、随机端口、`server.listen(0, '127.0.0.1', …)`（第 230 行）的 HTTP 服务器，负责凭证看门、超时、客户端断连 abort，以及流式/非流式响应下发。由 `test-engine-llm-bridge.mjs` 覆盖。

### 凭证边界（整个迁移最不能破的一条）
桥**不读**任何凭证文件、**不接收**真实 `api_key`、`不转发` `Authorization` 头。引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个每次启动随机生成的占位 key（`dsh-bridge-…`，`llm-bridge.js` 第 96 行）。真实凭证只存在于宿主 provider 内部——桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它。`openai-bridge.js` 第 27–28 行明确：`toLlmRequest` 的返回值里永远没有 `apiKey` 字段。访问与错误日志只记 method/path/状态/耗时/请求 id，`llm-bridge.js` 第 12 行与 `bearerOf`（第 38–43 行）取完 token 即弃，绝不写入日志。

### 为什么必须 loopback + 随机端口 + 占位 key
桥等于「用宿主凭证换任意模型调用」的开关。绑定 127.0.0.1 阻断外网；随机端口让同机其它进程猜不到；占位 key 校验挡住误连/端口扫描。三者缺一不可（`llm-bridge.js` 第 14–17 行）。

### 协议面（只实现引擎真正用到的部分，不假装完整 OpenAI）
- `POST /v1/chat/completions`：非流式（`stream` 缺省/`false`）与流式（`stream: true`）
- `GET /v1/models`：引擎/探针的连通性检查
- `GET /healthz`：桥自身存活（不含任何模型信息）

## Key Components

### `lib/engine/openai-bridge.js`（纯转换层，无 I/O）

**常量**

- `PLACEHOLDER_KEY_PATTERN`（第 29 行）：`/^dsh-bridge-[a-z0-9-]+$/` —— 占位 key 的正则，桥只认这个形态。
- `isPlaceholderKey(value)`（第 31–33 行）：判断字符串是否合法占位 key（类型 + 正则双检）。

**请求方向：OpenAI → DSH GenerateOptions**

- `toLlmRequest({ provider, model, reasoningEffort, body })`（第 128–161 行）：OpenAI chat.completion 请求体 → DSH GenerateOptions 子集。
  - 缺 `provider`/`model` 抛错（第 129–130 行）；`messages` 必须是非空数组否则抛错（第 132、146 行）。
  - `system`/`developer` 消息抽到 `system` 槽（第 79–83、134–153 行），其余按序进 `messages`。
  - `assistant` 消息的 `tool_calls` 还原成 `tool-call` 块，arguments 保持原始 JSON **字符串**（第 88–100 行）；并强制带上 `source`（第 103–110 行，回归见 `test-engine-bridge.mjs` 第 368–389 行）。
  - `tool` 消息 → `toolCallId`/`isError`/`content`（第 112–119 行）。
  - `tools[].function` → `ToolSchema`（第 53–66 行）；`temperature`/`max_tokens`/`stop` 映射（第 157–159 行）。**不**塞入 `response_format`/`seed` 等未知字段（返回值里没有这些键）。
  - 返回值里**永远没有 `apiKey`**。

**辅助函数（请求映射）**

- `contentToBlocks(content)`（第 38–51 行）：把 OpenAI 的 string 或 parts 数组摊平成 DSH `ContentBlock[]`，非文本部分（如 `image_url`）显式跳过（第 46 行注释）。
- `toolsToSchemas(tools)`（第 53–66 行）：HTTP tools → DSH ToolSchema 数组。
- `messageToDsh(msg, route)`（第 76–122 行）：单条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`；`route={provider,model}` 用来给 assistant 消息填 `source.kind='model'`。

**响应方向：DSH StreamChunk → OpenAI 响应**

- `finishReasonToOpenAI(reason)`（第 164–173 行）：DSH `FinishReason.kind` → OpenAI `finish_reason`（`tool-calls`/`length`/`error`/`stop`，默认 `stop`）。
- `usageToOpenAI(usage)`（第 176–188 行，内部）：DSH 互斥计数 → OpenAI 字段。`inputTokens` 是**不含缓存**的净输入，故 `prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 `prompt_tokens_details.cached_tokens`。
- `foldChunks(chunks)`（第 192–233 行，内部）：把 chunk 流折叠成 `{text, finish, usage, toolCalls}` 中间态，**非流式与流式共用同一套拼接逻辑**（第 190–191 行注释）。tool-call-delta 按 `index` 拼接成完整 arguments，且**只保留带 `name` 的调用**（`v.name` 过滤，第 226 行）——无 name 的调用引擎无法执行，混进去只会制造噪音。reasoning-delta 不进正文（第 217 行）。
- `chunksToCompletion({ id, model, chunks })`（第 236–256 行）：chunk 流 → OpenAI 非流式响应体。纯工具调用时 `content` 为 `null`（第 249 行，OpenAI 语义不能是空串）。
- `sseFrame(payload)`（第 259–262 行）：一帧 SSE，`data: <body>\n\n`，`[DONE]` 是独立帧。
- `chunksToSse({ id, model, created, chunks })`（第 265–317 行）：chunk 流 → SSE 帧数组。首帧带 `role`，末帧固定补 `[DONE]`（第 311–315 行，否则引擎流读取会挂住）；流式 usage 单独成帧（第 297–300 行）。

### `lib/engine/llm-bridge.js`（loopback HTTP 服务端）

**常量**

- `DEFAULT_TIMEOUT_MS = 10 * 60 * 1000`（第 33 行），`MAX_BODY_BYTES = 32 * 1024 * 1024`（第 34 行）。

**内部函数**

- `bearerOf(req)`（第 38–43 行）：从 `Authorization` 头取 bearer token，取完即弃，绝不写日志/传给 llm。
- `sendJson(res, status, body, extraHeaders)`（第 45–54 行）：写 JSON 响应，带 `cache-control: no-store`。
- `readBody(req, limit)`（第 56–72 行）：读请求体，超 `limit` 抛 `statusCode: 413` 并 `req.destroy()`。
- `errorBody(message, type, code)`（第 75–77 行）：把上游异常翻译成 OpenAI 风格错误体 `{error:{message,type,code}}`。

**导出函数**

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`（第 90–241 行）：启动桥，返回 `{ url, placeholderKey, port, stats(), close() }`。
  - 入参校验：缺 `llm.stream`/`provider`/`model` 直接抛错（第 91–93 行，对应测试 `test-engine-llm-bridge.mjs` 第 290–294 行）。
  - 占位 key 每次随机：`dsh-bridge-${randomBytes(32).toString('hex')}`（第 96 行），不复用、不落盘、不进日志。
  - `stats` 对象（第 97 行）：`{ requests, streamRequests, authRejected, failures, lastError }`。
  - 路由（第 100–226 行）：`/healthz`（200，不带任何凭证信息）→ `/v1` 一律验占位 key（第 118–126 行，先验即拒，错误体不回显收到的 key）→ `/v1/models`（返回配置的 model/owned_by）→ `POST /v1/chat/completions`（核心）。
  - 客户端断连 → `AbortController` 中止上游（第 163–167 行）；超时 → `setTimeout` 中止（第 166 行，默认 `timeoutMs`）。
  - 流式：边收边发（第 173–188 行），逐帧 `chunksToSse`；上游中途失败 → 错误帧 + `[DONE]` 收尾（第 189–203 行，否则客户端挂住）。
  - 返回 `Promise<{url, placeholderKey, port, stats, close}>`（第 228–240 行），`server.listen(0, '127.0.0.1', …)`。

### 调用侧集成点（非本模块文件，但属于桥的接线）

- `lib/engine/native-run.js`：
  - `runNativeJob`（第 68–488 行）第 2 步「模型桥」用 `bridgeImpl`（默认 `realBridge = startLlmBridge`，第 31、90、239 行）建立桥，注入 `cfg.batchProvider/batchModel/batchReasoningEffort`，并把 `bridge` 传给 `engineFor({ requestId, bridge })`（第 239–267 行）供引擎描述使用。
  - 桥在引擎退出后关闭（第 289–292 行）：`finally { await bridge?.close?.() }`，先关桥会让还在读流的引擎拿到 502。
- `index.js`：
  - `nativeEnginePlan(channel, { requestId, bridge, model, clusterModel })`（第 252–268 行）：把 `bridge.url` 放进环境变量 `CODEWIKI_BASE_URL`、`bridge.placeholderKey` 放进 `CODEWIKI_API_KEY`、`model` 放进 `CODEWIKI_MAIN_MODEL`/`CODEWIKI_CLUSTER_MODEL`（第 262–265 行）。注意第 261 行注释：桥返回对象**不含** `model` 字段，必须显式传入 `model`（曾经写成 `bridge.model` 导致 `CODEWIKI_MAIN_MODEL` 为空 → 引擎判「缺少模型通道」）。
  - `startNativeRun`（第 2727–2801 行）通过 `deps.engineFor = ({ bridge }) => nativeEnginePlan(channel, { bridge, model: c.batchModel, clusterModel: c.batchModel })`（第 2753–2759 行）把桥注入引擎子进程环境。
- `lib/engine/python/entry.py`：
  - `_model_config()`（第 243–275 行）：从进程环境读 `CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`/`CODEWIKI_MAIN_MODEL`/`CODEWIKI_CLUSTER_MODEL`（第 98–101、249–272 行），构造 FSoft 的 OpenAI-compatible config；缺任何一项返回 `(None, 原因)` 并让引擎以 `engine-model` 失败（第 397–398 行）。错误信息只说「环境变量」不打印值（第 245–248 行）。

## Architecture

桥是「宿主凭证 ↔ OpenAI-compatible 引擎」之间唯一需要守住的边界，组件关系如下（≤20 行框图）：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 宿主 provider（真实凭证，桥看不见）                                    │
│   ▲ llm.stream(GenerateOptions)                                       │
│   │                                                                   │
│   ▼                                                                   │
┌────────────────────────────────────────────────────────────────────┐ │
│ lib/engine/llm-bridge.js  startLlmBridge()  (loopback HTTP @127.0.0.1)│ │
│   ├─ 占位 key 校验（bearerOf + PLACEHOLDER_KEY_PATTERN）             │ │
│   ├─ 超时 / 客户端断连 → AbortController                             │ │
│   └─ 路由: /healthz · /v1/models · POST /v1/chat/completions         │ │
└────────────────────────────────────────────────────────────────────┘ │
        │ 调 toLlmRequest / chunksToCompletion / chunksToSse            │
        ▼                                                               │
┌────────────────────────────────────────────────────────────────────┐ │
│ lib/engine/openai-bridge.js  (纯转换，无 I/O 无密钥)                 │ │
│   OpenAI 请求体 ⇄ DSH GenerateOptions；DSH StreamChunk ⇄ OpenAI 响应 │ │
└────────────────────────────────────────────────────────────────────┘ │
        │ HTTP (loopback URL + 占位 key)                                │
        ▼                                                               │
┌────────────────────────────────────────────────────────────────────┐ │
│ FSoft 原生引擎 (lib/engine/python/entry.py)                          │ │
│   _model_config() 读 CODEWIKI_BASE_URL/API_KEY/MAIN_MODEL 环境变量    │ │
│   通过 OpenAI-compatible 客户端打桥，拿到模型调用结果                 │ │
└────────────────────────────────────────────────────────────────────┘
```

接线方：`lib/engine/native-run.js` 的 `runNativeJob` 第 2 步起桥（第 238–239 行），把 `bridge` 传给 `engineFor`；`index.js` 的 `nativeEnginePlan`（第 252 行）把 `bridge.url`/`bridge.placeholderKey`/`model` 写进引擎子进程环境变量；`entry.py` 的 `_model_config`（第 243 行）从环境读出后交给 FSoft adapter。

## Data Flow

一次原生编译里，桥参与的数据流如下（以一条带 tool-call 的流式生成为例）：

1. `runNativeJob`（`native-run.js` 第 238 行）调用 `startLlmBridge`，得到 `{url, placeholderKey, port}`。占位 key 由 `randomBytes(32)` 生成（`llm-bridge.js` 第 96 行），只活在内存。
2. `index.js#nativeEnginePlan`（第 262–265 行）把这个 url + 占位 key + 模型名写进引擎子进程环境变量：`CODEWIKI_BASE_URL=bridge.url`、`CODEWIKI_API_KEY=bridge.placeholderKey`、`CODEWIKI_MAIN_MODEL=model`。注意 key 用的是 `bridge.placeholderKey` 而不是 `bridge.model`（第 261 行注释的回归坑）。
3. 引擎 `entry.py#_model_config`（第 249–272 行）从这些环境变量构造 FSoft 的 OpenAI-compatible config（`base_url`/`api_key`/`main_model`/`cluster_model`/`provider:"openai-compatible"`）。
4. 引擎每要生成一段，就向 `bridge.url`（即 `http://127.0.0.1:<port>/v1`）发 `POST /v1/chat/completions`，`Authorization: Bearer <占位key>`，`stream: true`。
5. 桥服务端（`llm-bridge.js` 第 100 行起的回调）：
   - `bearerOf(req)` 取出 token，校验 `PLACEHOLDER_KEY_PATTERN.test(token) && token === placeholderKey`（`llm-bridge.js` 第 120 行）；不match → 401 + `authRejected++`（第 121–124 行）。
   - `readBody(req)` 读体（第 139 行），`JSON.parse` 失败 → 400（第 142–147 行）。
   - `toLlmRequest({provider, model, reasoningEffort, body})`（`openai-bridge.js` 第 128 行）翻译成 `GenerateOptions`：`system` 抽到 system 槽、`assistant.tool_calls`→tool-call 块、`tool`→tool 结果、`tools`→ToolSchema、`temperature/max_tokens/stop` 映射（第 149–161 行）。
   - `llm.stream({ ...options, signal: ac.signal })`（第 171 行）调宿主，按 chunk 流消费。
   - 流式逐帧：`chunksToSse({id, model, chunks:[chunk]})`（`openai-bridge.js` 第 265 行）产出 SSE 帧，`res.write(head)` 后逐帧 `res.write(frame)`（第 174–188 行）；`[DONE]` 由 `chunksToSse` 统一收尾（`openai-bridge.js` 第 311–315 行）。
   - 非流式：攒完所有 chunk 后 `chunksToCompletion`（第 216 行）出整体 JSON，`sendJson(res, 200, completion)`（第 218 行）。
6. 上游失败：流式已发头时写 error 帧 + `[DONE]`（`llm-bridge.js` 第 193–200 行）；未发头时 502 + `errorBody`（`llm-bridge.js` 第 201–202 行）。
7. `usage` 折算：`usageToOpenAI`（`openai-bridge.js` 第 176 行）把 DSH 互斥计数（`inputTokens` 不含缓存）翻成 `prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 `prompt_tokens_details.cached_tokens`。
8. 引擎退出后 `runNativeJob` 的 `finally` 调 `bridge.close()`（第 291 行），关掉 loopback 监听。

凭证数据流的关键不变式：**真实 api_key 从不进入子进程环境、从不进日志、从不出现在 `toLlmRequest` 返回值**（`openai-bridge.js` 第 27 行；`test-engine-bridge.mjs` 第 348–356 行断言；`test-engine-llm-bridge.mjs` 第 232–247 行断言日志不含 `authorization`/占位 key）。

## Connections

- [[engine_native_run]]（`lib/engine/native-run.js`）：`runNativeJob` 的第 2 步「模型桥」是桥的生产接线点（第 233–259 行），桥通过 `engineFor` 注入引擎子进程环境，并在引擎退出后关闭（`finally`，第 289–292 行）。
- [[engine_python_entry]]（`lib/engine/python/entry.py`）：引擎入口的 `_model_config`（第 243–275 行）从 `CODEWIKI_*` 环境变量读桥的 url/占位 key/模型名，构造 OpenAI-compatible config 交给 FSoft adapter。
- [[engine_client]]（`lib/engine/client.js`）：跨语言适配层，另有 `runEngine` 负责 spawn 引擎子进程并翻译进度；与桥正交（桥只管模型通道，client 管进程/协议）。
- [[engine_contract]]（`lib/engine/contract.js`）：桥产出/消费的 `StreamChunk`/`GenerateOptions`/`FinishReason` 类型语义源。
- [[engine_index|index.js 原生通道]]（`index.js`）：`nativeChannelFor`/`resolveNativePython`/`nativeEnginePlan`（`index.js` 第 223–268 行）决定何时走原生通道，并把桥的 `url`/`placeholderKey`/`model` 写进引擎子进程环境。

## Known Issues

- **`bridge.model` 不存在（已踩坑，代码注释保留为防御）**：`startLlmBridge` 的返回对象只有 `{url, placeholderKey, port, stats, close}`，**不含** `model` 字段（`llm-bridge.js` 第 232–238 行）。`index.js` 第 261 行曾有 `bridge.model` 写法，实测得到 `undefined` → `CODEWIKI_MAIN_MODEL` 变空串 → `entry.py#_model_config` 判「缺少模型通道」→ 每次原生编译都在 cluster 阶段以 `engine-model` 失败且原因像环境没配好。`nativeEnginePlan` 现在显式传 `model`（第 264 行）。
- **assistant 历史消息必须带 `source`（回归，纯单测抓不到）**：`messageToDsh`（`openai-bridge.js` 第 103–110 行）给 assistant 历史消息填 `source.kind='model'`；宿主 `LlmRuntime.forAdapter()` 会读 `message.source.replayState`（缺 source 抛 `Cannot read properties of undefined (reading 'replayState')`），整轮调用被判 error，引擎侧表现为「Please return text or call a tool.」并耗尽重试。桥**不伪造** `replayState`，只填 provider/model（`test-engine-bridge.mjs` 第 368–400 行）。
- **占位 key 校验与错误回显边界**：`/v1` 路由先验 key，错误体**不回显**收到的 key（`llm-bridge.js` 第 123–124 行），避免把用户误配的真实 key 写进日志；同格式但非本次生成的占位 key 也一律 401（`test-engine-llm-bridge.mjs` 第 211–220 行）。
- **流式必须 `[DONE]` 收尾**：`chunksToSse` 在流没给 `finish` 时也补终帧（`openai-bridge.js` 第 311–315 行），否则引擎 SSE 读取挂住；上游中途失败也要先写 error 帧再 `[DONE]`（`llm-bridge.js` 第 189–200 行）。
- **无 name 的 tool-call-delta 丢弃**：`foldChunks` 只保留 `v.name` 非空的调用（第 226 行），无 name 的调用引擎无法执行，混进去只会制造噪音（`test-engine-bridge.mjs` 第 245–256 行）。
- **`cacheRead` 必须单列**：DSH 的 `inputTokens` 不含缓存，OpenAI 的 `prompt_tokens` 含缓存，故 `prompt_tokens = input + cacheRead + cacheWrite`，缓存单列 `prompt_tokens_details.cached_tokens`（第 176–188 行）；若漏算会让引擎用量账本与宿主不一致。
- **桥关闭时序**：必须先关引擎再关桥（`native-run.js` 第 289–292 行注释）：先关桥会让还在读流的引擎拿到 502。
