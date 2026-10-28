---
title: engine_bridges
type: module
source_files:
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - lib/engine/native-run.js
  - lib/engine/python/entry.py
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
tags: [engine, llm, openai, bridge, loopback, protocol]
---

## Overview

`engine_bridges` 是 FSoft 原生引擎（只认 OpenAI-compatible 的 `base_url` + `api_key`）与 DSH 宿主 `llm` 服务之间的一组桥。它由两层组成：

- **`lib/engine/openai-bridge.js`**：纯函数转换层，**无 I/O、无网络、无密钥**。负责把 OpenAI `chat.completions` 请求体翻译成宿主的 `GenerateOptions`，再把宿主的 `StreamChunk` 流翻译回 OpenAI 的非流式 JSON / 流式 SSE。这一层最容易出错，因此被隔离出来单独用 TDD 钉死（见 `test-engine-bridge.mjs`）。
- **`lib/engine/llm-bridge.js`**：基于 `node:http` 的进程内 loopback HTTP 服务器（**阶段 1B 薄桥**）。它把上层的纯转换接上一个真实端口，暴露 `http://127.0.0.1:<随机端口>/v1`，让引擎以为自己连的是 OpenAI；实际每个请求都被转成 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider。服务器级行为（凭证边界、超时、断连、错误帧）由 `test-engine-llm-bridge.mjs` 覆盖。

**核心安全边界（整个迁移最不能破的一条，见 `lib/engine/llm-bridge.js` 第 6–17 行注释）**：桥**不读**任何凭证文件、**不接收**真实 `api_key`、**不转发** `Authorization` 头。引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个随机生成的占位 key（`dsh-bridge-...`），占位 key 的唯一作用是让引擎的 OpenAI 客户端肯发请求；真实凭证只存在于宿主 provider 内部，桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它。访问日志与错误日志只记 `method/path/状态/耗时/请求 id`，不记 `Authorization`（`lib/engine/llm-bridge.js` 第 12 行）。

为什么必须 loopback + 随机端口 + 占位 key 校验三者缺一不可（见 `lib/engine/llm-bridge.js` 第 14–17 行）：桥等于「用宿主凭证换任意模型调用」的开关——绑定 `127.0.0.1` 阻断外网、随机端口让同机其他进程猜不到、占位 key 校验挡住误连/端口扫描；缺一就等于把宿主凭证开放给本机任意进程。

## Key Components

### lib/engine/openai-bridge.js — 纯转换层（无 I/O）

文件 `lib/engine/openai-bridge.js`（共 318 行）只做纯转换。所有函数/常量如下：

- **`PLACEHOLDER_KEY_PATTERN`**（第 29 行，`export const`）：正则 `/^dsh-bridge-[a-z0-9-]+$/`。占位 key 的合法形态，桥只接受自己生成的这种串。
- **`isPlaceholderKey(value)`**（第 31 行）：返回 `value` 是否为合法占位 key 字符串。供测试与外部校验用。
- **`textBlock(text)`**（第 35 行，模块内私有）：把字符串包成 `{ type: 'text', text }` 的 DSH `ContentBlock`。
- **`contentToBlocks(content)`**（第 38 行，模块内私有）：把 OpenAI 的 `content`（string 或 parts 数组）摊平成 DSH `ContentBlock[]`。`text` 部分进 `textBlock`；`image_url` 等非文本部分显式跳过（引擎只发文本，见第 46 行注释）。
- **`toolsToSchemas(tools)`**（第 53 行，模块内私有）：把 OpenAI `tools[].function` 映射成 DSH `ToolSchema[]`（`{ name, description, parameters }`）；缺 `name` 的跳过；空数组返回 `undefined`。
- **`messageToDsh(msg, route)`**（第 76 行，模块内私有）：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。关键规则：
  - `system`/`developer` → 抽成 `system` 槽的 text（第 79 行）；
  - `user` → `user` 消息（第 84 行）；
  - `assistant` 带 `tool_calls` 时，`tool-call` 块的 `arguments` 保持**原始 JSON 字符串**（第 97 行，不能 parse，否则破坏增量拼接），且必须带 `source = { kind: 'model', provider, model }`（第 103 行——宿主 `LlmRuntime.forAdapter()` 会无条件读 `source.replayState`，缺 `source` 会抛 `Cannot read properties of undefined (reading 'replayState')`）；
  - `tool` → `{ role: 'tool', toolCallId, isError, content }`（第 112 行，`callId` 必须对上，否则工具循环断链）。
- **`toLlmRequest({ provider, model, reasoningEffort, body })`**（第 128 行）：OpenAI 请求体 → DSH `GenerateOptions` 子集（不含 `signal/sessionId`）。校验 `provider`/`model` 非空、`messages` 为非空数组（第 129–132、146 行），把 `system` 抽到 `system` 槽、`temperature`/`max_tokens`/`stop` 映射到 `temperature`/`maxTokens`/`stop`（第 157–159 行），**绝不**回带任何 `apiKey` 字段（第 27 行注释，由 `test-engine-bridge.mjs` 第 348 行断言）。
- **`finishReasonToOpenAI(reason)`**（第 164 行）：DSH `FinishReason` → OpenAI `finish_reason`（`tool-calls`/`length`/`error`/默认 `stop`）。
- **`usageToOpenAI(usage)`**（第 176 行，模块内私有）：DSH `TokenUsage`（inputTokens 互斥、不含缓存）→ OpenAI `prompt_tokens`（= `inputTokens + cacheReadTokens + cacheWriteTokens`，缓存单列 `prompt_tokens_details.cached_tokens`）。
- **`foldChunks(chunks)`**（第 192 行，模块内私有）：把 chunk 流折叠成 `{ text, finish, usage, toolCalls }` 中间态。按 `index` 拼接 `tool-call-delta` 的 `arguments`，`reasoning-delta` 不进正文，只保留**有 name** 的调用（无 name 的引擎无法执行，见第 222 行注释）。非流式与流式两条路径都从这里出发，保证行为同源。
- **`chunksToCompletion({ id, model, chunks })`**（第 236 行）：chunk 流 → OpenAI 非流式响应体 `chat.completion`。纯工具调用时 `content` 为 `null`（第 249 行，OpenAI 语义不能是空串）。
- **`sseFrame(payload)`**（第 259 行）：一帧 SSE，`data: <json|'[DONE]'>\n\n`。
- **`chunksToSse({ id, model, created, chunks })`**（第 265 行）：chunk 流 → SSE 帧数组（末帧 `[DONE]`）。首帧带 `role`；`tool-call-delta` 逐帧带 `id/name/arguments` 片段；`usage` 单独成帧；即使流没给 finish 也补一个终帧（第 311 行，否则引擎的 SSE 读取会挂住）。

### lib/engine/llm-bridge.js — loopback HTTP 桥（进程内服务器）

文件 `lib/engine/llm-bridge.js`（共 242 行）是带 I/O 的服务器层。

常量：

- **`DEFAULT_TIMEOUT_MS`**（第 33 行，`10 * 60 * 1000`）：单次模型调用默认超时。
- **`MAX_BODY_BYTES`**（第 34 行，`32 * 1024 * 1024`）：请求体上限。

模块内私有辅助：

- **`bearerOf(req)`**（第 38 行）：从 `Authorization` 头取 bearer token；**只用于校验占位 key**，取完即弃，不写日志、不传 `llm`。
- **`sendJson(res, status, body, extraHeaders)`**（第 45 行）：写 JSON 响应（`cache-control: no-store`）。
- **`readBody(req, limit)`**（第 56 行）：读请求体，超限抛 `{ statusCode: 413 }`。
- **`errorBody(message, type, code)`**（第 75 行）：把异常包成 OpenAI 风格错误体 `{ error: { message, type, code } }`。

公开函数：

- **`startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`**（第 90 行）：启动桥，返回 `Promise<{ url, placeholderKey, port, stats(), close() }>`。
  - 校验 `llm.stream` 存在、`provider`、`model` 非空（第 91–93 行），否则抛错（避免半配置状态下监听端口，`test-engine-llm-bridge.mjs` 第 290 行断言）。
  - 每次启动随机生成 `placeholderKey = dsh-bridge-${randomBytes(32).toString('hex')}`（第 96 行），**不复用、不落盘、不进日志**。
  - 内部 `stats` 计数器：`requests / streamRequests / authRejected / failures / lastError`（第 97 行），由 `stats()` 只读导出。
  - 路由表（见第 112–218 行）：`GET /healthz` 存活检查（不泄露任何凭证信息，见 `test-engine-llm-bridge.mjs` 第 222 行）；所有 `/v1` 请求先校验占位 key（第 118–126 行，失败 401 且**不回显**收到的 key）；`GET /v1/models` 连通性检查（第 128 行）；`POST /v1/chat/completions`（第 133 行）做非流式/流式转换。
  - 客户端断连 → `AbortController.abort()`（第 163–165 行）；超时 → `ac.abort()`（第 166 行）；上游失败：流式已发头时发错误帧 + `[DONE]`（第 193–200 行），否则 502（第 201 行）；顶层异常 500（第 219 行）。
  - 绑定 `127.0.0.1`、随机端口（`server.listen(0, '127.0.0.1', ...)`，第 230 行），`url = http://127.0.0.1:${port}/v1`，`close()` 关闭服务器。

## Architecture

```
                宿主凭证（provider 配置，桥永远看不见）
                          │  llm.stream(GenerateOptions)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  lib/engine/llm-bridge.js  (startLlmBridge，监听 127.0.0.1:*随机*) │
│  GET /healthz │ GET /v1/models │ POST /v1/chat/completions      │
│  占位 key 校验 (line 118) → 401 不回显 key                      │
│  客户端断连/超时 → AbortController (line 163-166)               │
└───────────────┬───────────────────────────┬────────────────────┘
                │ 转 OpenAI 请求体           │ 转 SSE/JSON 响应
                ▼                            ▲
┌───────────────────────────────┐   ┌──────────────────────────────┐
│ openai-bridge.js 纯转换（无 I/O）│   │ openai-bridge.js 纯转换（无 I/O）│
│ toLlmRequest (line 128)        │   │ chunksToCompletion (236)      │
│  messageToDsh / toolsToSchemas  │   │ chunksToSse (265) / foldChunks │
└───────────────┬───────────────┘   └──────────────────────────────┘
                │
                ▼
   FSoft 原生引擎（entry.py：CODEWIKI_BASE_URL + CODEWIKI_API_KEY 占位 key 打回流）
```

- 左侧「请求方向」：`llm-bridge.js` 校验占位 key 后调用 `toLlmRequest`（`lib/engine/openai-bridge.js` 第 151 行），把 OpenAI 请求体翻成 `GenerateOptions` 交给 `llm.stream`。
- 右侧「响应方向」：`llm.stream` 产出的 `StreamChunk` 经 `foldChunks`/`chunksToCompletion`/`chunksToSse` 翻回 OpenAI 形状。流式边收边发（第 174–187 行），以 `[DONE]` 收尾（第 210 行）。
- 占位 key 由 `llm-bridge.js` 运行时随机生成，经 `engineFor({ bridge })` 注入引擎进程环境（见 `Data Flow`），Python 侧 `entry.py` 的 `_model_config` 读取 `CODEWIKI_BASE_URL` / `CODEWIKI_API_KEY`（第 243–275 行），但**不落盘、不读本机凭证库**（第 23–29 行注释）。

## Data Flow

一次原生编译里，桥的接入点链路如下（以 `lib/engine/native-run.js` 的 `runNativeJob` 为主线）：

1. **建桥**：`runNativeJob` 通过 `bridgeImpl`（`deps.bridge ?? realBridge`，`lib/engine/native-run.js` 第 131 行）调用 `startLlmBridge`，传入 `llm`（宿主服务）、`provider`（`cfg.batchProvider`）、`model`（`cfg.batchModel`）、`reasoningEffort`、`timeoutMs`（上限 `10 * 60 * 1000`，第 392 行）。`onLog` 只透传 `{...e, phase: 'bridge'}`，绝不记请求头/body/占位 key（第 394 行）。桥启动后拿到 `{ url, placeholderKey, port, ... }`（第 232–238 行）。

2. **把桥交给引擎**：`engineFor({ requestId, bridge })` 拿到引擎描述（第 417 行）。`engineFor` 由上层（如 `index.js` / 测试）注入，其职责是把 `bridge.url` / `bridge.placeholderKey` 塞进引擎子进程的**环境变量**（对应 `entry.py` 的 `CODEWIKI_BASE_URL` 与 `CODEWIKI_API_KEY`，`ENV_BASE_URL = "CODEWIKI_BASE_URL"`、`ENV_API_KEY = "CODEWIKI_API_KEY"`，`lib/engine/python/entry.py` 第 98–99 行）。密钥只活在进程环境里，不落盘（`entry.py` 第 23–29 行）。

3. **引擎打回路**：FSoft 在 `action_generate` 里经 `_model_config()`（`entry.py` 第 243 行）读出 `base_url` / `api_key`（= 占位 key）/ `main_model`，构造 `CLIDocumentationGenerator`（`entry.py` 第 434 行）。agentic 工具循环每遇到一次模型调用，就向 `http://127.0.0.1:<随机端口>/v1/chat/completions` 发 OpenAI 风格请求，带 `Authorization: Bearer <占位 key>`。

4. **桥翻译请求**：`llm-bridge.js` 收到请求 → 校验占位 key（第 118–126 行）→ `toLlmRequest({ provider, model, reasoningEffort, body })`（`openai-bridge.js` 第 151 行被 `llm-bridge.js` 第 151 行调用）→ 调 `llm.stream({ ...options, signal })`（第 171 行）。真实凭证只存在于宿主 provider，桥全程只碰 `llm` 对象。

5. **桥翻译响应**：
   - 非流式：`llm.stream` 收完后经 `chunksToCompletion`（第 216 行）拼成 `chat.completion` JSON 返回。
   - 流式：`llm.stream` 每收到一个 chunk 立即经 `chunksToSse`（第 183 行）边发边转，流尾补 `[DONE]`（第 210 行）。上游中途失败也发错误帧 + `[DONE]`（第 193–200 行），避免引擎 SSE 读取挂住。

6. **关桥**：引擎 `result` 回来后，在 `finally` 里 `await bridge?.close?.()`（第 456 行注释：先关桥会让还在读流的引擎拿到 502）。

7. **失败记账**：上游失败 → 流式已发头时发错误帧（第 195 行），否则 502（第 202 行）；空 messages / 非法 JSON → 400 且不触达宿主 `llm`（`test-engine-llm-bridge.mjs` 第 176、189 行断言）；缺占位 key / 伪造 key → 401 且 `llm.calls` 为空（第 68、211 行断言）。

## Connections

- [[engine-native-run]]（`lib/engine/native-run.js`）：桥的生产调用方。`runNativeJob` 在「模型桥」步骤（第 381 行注释起）调用 `startLlmBridge`，并通过 `engineFor({ bridge })` 把桥 URL/占位 key 注入引擎子进程环境，最后在 `finally` 里关桥。
- [[engine-client]]（`lib/engine/client.js`）：桥与 `client.js` 是引擎边界上**正交**的两块——`client.js` 负责 Node↔Python 的 JSON-lines 进程协议（不碰模型），桥负责模型通道（`client.js` 第 10 行注释明确「模型通道由 llm-bridge.js 单独提供」）。
- [[engine-contract]]（`lib/engine/contract.js`）：桥的上游失败经 OpenAI 错误体表达（502/`upstream_error`），最终被引擎侧翻译成 `engineResult` 的 `engine-model` 错误码（`native-run.js` 第 400 行与 `contract.js` 第 83 行）。
- [[engine-python-entry]]（`lib/engine/python/entry.py`）：FSoft 薄入口，消费桥注入的 `CODEWIKI_BASE_URL` / `CODEWIKI_API_KEY`（`_model_config`，第 243 行），并刻意只读环境变量、不回退本机凭证库。
- [[agentic-host]]（`lib/agentic-host.js`）：宿主 `llm.stream` 的另一种消费方式（直接给 agentic 文章写作用），与桥共用同一个 `llm` 服务形态（都只认 `stream`），但桥走 OpenAI 协议、agentic-host 走裸 blocks。
- [[engine-quality-gate]] / [[engine-apply-plan]]：桥产出后由 `runNativeJob` 的「质量门 → 落地器」裁决链收口（见 `native-run.js` 第 503、591 行注释）。

## Known Issues

- **`assistant` 历史消息必须带 `source`，否则真跑工具往返会炸**（回归点，见 `lib/engine/openai-bridge.js` 第 71–75 行注释与 `test-engine-bridge.mjs` 第 358–400 行）。宿主 `LlmRuntime.forAdapter()` 会无条件读 `message.source.replayState`；桥生成的 `assistant` 若缺 `source` 会抛 `Cannot read properties of undefined (reading 'replayState')`，宿主把整轮判 `finish=error`，引擎侧表现为 "Please return text or call a tool." 并耗尽重试。**纯单测抓不到，只有真跑一次工具往返才暴露**——桥正确做法是只填 `provider/model`、不伪造 `replayState`。
- **`assistant` 的 `tool_calls` 必须保留（content 可为 null）**（第 69 行注释）。引擎/工具循环要求调用链完整，丢一条 `tool-call` 块工具循环就断链。
- **`tool` 消息的 `toolCallId` 必须与上一步 `tool_calls[].id` 对上**（第 14 行注释、`test-engine-bridge.mjs` 第 402 行）。callId 不匹配工具循环断链。
- **`tools[].function` 必须映射成 `ToolSchema`**（第 15 行注释）。缺这一步，agentic 工具循环退化成「模型说自己要调工具但永远调不到」，写出来的文章全是空壳。
- **流式与非流式必须同源**（`foldChunks` 共用，`openai-bridge.js` 第 23 行注释）。两条路径分叉会导致流式拿到半截 `tool_calls`。
- **`reasoning-delta` 不进 `content`**（第 20 行、第 217 行注释）。思考内容不该出现在文章正文里。
- **`usage` 字段映射语义**：DSH 的 `inputTokens` 是**不含缓存**的净输入，OpenAI 的 `prompt_tokens` 含缓存，故 `prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`，缓存单列 `prompt_tokens_details.cached_tokens`（`openai-bridge.js` 第 21–22、176–188 行，`test-engine-bridge.mjs` 第 217 行注释）。
- **错误响应不回显任何 key**（`llm-bridge.js` 第 123 行）。即使客户端发了真实 key，401 错误体也只说 "invalid bridge key"，避免把用户误配的真实 key 写进日志。
- **桥必须在引擎退出后关闭**（`native-run.js` 第 455 行注释）。先关桥会让还在读流的引擎拿到 502。
- **协议未实现完整的 OpenAI 面**：桥只实现引擎真正用到的 `POST /v1/chat/completions`、`GET /v1/models`、`GET /healthz`（第 19–22 行注释），不假装完整 OpenAI。

## 内部模块边界（无独立子模块拆分）

`engine_bridges` 由两个文件构成，职责清晰且互相依赖（服务器层 `llm-bridge.js` 依赖纯转换层 `openai-bridge.js` 的四个导出：`PLACEHOLDER_KEY_PATTERN` / `chunksToCompletion` / `chunksToSse` / `toLlmRequest`，见 `llm-bridge.js` 第 26–31 行）。两者合计 6 个公开函数、规模适中，没有可独立成篇的子能力块，故未启用 `generate_sub_module` 拆分。
