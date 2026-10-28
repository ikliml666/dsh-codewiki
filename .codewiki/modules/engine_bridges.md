---
title: engine_bridges
type: module
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - lib/agentic-host.js
  - lib/engine/client.js
  - lib/engine/python/entry.py
tags: [engine, llm, openai-protocol, bridge, security, loopback]
---

## Overview

`engine_bridges` 是 dsh-codewiki 迁移里「FSoft 原生引擎 ↔ DeepSeek 宿主 LLM」的协议桥，由两个文件组成：

- `lib/engine/openai-bridge.js` — **纯转换层**（无 I/O、无网络、无密钥）。负责 OpenAI-compatible 请求体 ↔ DSH `GenerateOptions` 的双向翻译，以及 DSH `StreamChunk` 流 ↔ OpenAI 响应（非流式 JSON / 流式 SSE）的翻译。这一层是整座桥最容易悄悄出错、且错了极难查的部分，所以全部做成纯函数并用 `test-engine-bridge.mjs` 钉死。
- `lib/engine/llm-bridge.js` — **loopback HTTP 服务器**（阶段 1B 薄桥）。把 `openai-bridge.js` 的纯转换包在一个绑定 `127.0.0.1` 随机端口的 Node HTTP 服务里，让只认 `base_url + api_key` 的 FSoft 引擎能打着占位 key 打过来，桥再用宿主注入的 `llm.stream(...)` 真正去调模型。

为什么需要这座桥（背景，见 `lib/engine/openai-bridge.js` 第 1–27 行）：FSoft 原生引擎只认 OpenAI-compatible 的 `base_url` + `api_key`；DSH 的凭证在宿主 provider 配置里，插件**既不保存也不传递密钥**（0.10.1 起硬约束）。于是桥是一个跑在 `127.0.0.1` 上的进程内 HTTP 端点：引擎拿着占位 key 打过来，桥把它转成 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider。

**凭证边界（这是整个迁移最不能破的一条，见 `lib/engine/llm-bridge.js` 第 6–17 行）：**
- 桥**不读**任何凭证文件、**不接收**真实 api_key、**不转发** Authorization 头；
- 引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个占位 key（`dsh-bridge-...`），占位 key 的唯一作用是让引擎的 OpenAI 客户端肯发请求；
- 真实凭证只存在于宿主 provider 内部——桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它；
- 访问日志与错误日志只记 method/path/状态/耗时/请求 id，**不记** Authorization（见 `lib/engine/llm-bridge.js` 第 103–109 行的 `finish` 回调与第 232–247 行的日志断言）。

**协议面（只实现引擎真正用到的部分，不假装完整 OpenAI，见 `lib/engine/llm-bridge.js` 第 19–22 行）：**
- `POST /v1/chat/completions` — 非流式（`stream` 缺省/false）与流式（`stream: true`）；
- `GET /v1/models` — 引擎/探针的连通性检查；
- `GET /healthz` — 桥自身存活（不含任何模型信息，也不泄露 key/secret/token，见 `test-engine-llm-bridge.mjs` 第 222–230 行）。

## Key Components

### `lib/engine/openai-bridge.js`（纯转换层）

| 符号 | 行号 | 类型 | 用途 |
|------|------|------|------|
| `PLACEHOLDER_KEY_PATTERN` | 29 | `RegExp` 常量 | 占位 key 校验正则 `/^dsh-bridge-[a-z0-9-]+$/`，桥只接受自己生成的串 |
| `isPlaceholderKey(value)` | 31–33 | 函数 | 仅当 `value` 是字符串且匹配 `PLACEHOLDER_KEY_PATTERN` 才返回 `true`（真实 key 一律 `false`） |
| `textBlock(text)` | 35 | 内部工厂 | 返回 `{ type: 'text', text: String(text ?? '') }`，摊平 OpenAI content 用 |
| `contentToBlocks(content)` | 38–51 | 内部函数 | 把 OpenAI 的 `string` 或 `parts[]` content 摊平成 DSH `ContentBlock[]`；`image_url` 等非文本部分显式跳过（引擎只发文本） |
| `toolsToSchemas(tools)` | 53–66 | 内部函数 | 把 `tools[].function` 映射成 DSH `ToolSchema`（`name/description/parameters`），缺参数字段时补 `{type:'object',properties:{}}`；无有效工具返回 `undefined` |
| `messageToDsh(msg, route)` | 76–122 | 内部函数 | 一条 OpenAI 消息 → 一条/多条 DSH `RequestMessage`：`system`/`developer` 抽到 text、`user` 摊平、`assistant` 的 `tool_calls` 还原成 `tool-call` 块（保留**原始 JSON 字符串** arguments）、`tool` 映射成带 `toolCallId` 的 `ToolResultMessage`；**assistant 历史消息必须带 `source`**（`kind:'model'` + provider/model），否则宿主 `forAdapter()` 会读 `source.replayState` 抛错 |
| `toLlmRequest({provider,model,reasoningEffort,body})` | 128–161 | 导出函数 | OpenAI 请求体 → DSH `GenerateOptions` 子集：校验 provider/model 非空、messages 非空数组；抽出 system、转发 tools/temperature/max_tokens/stop；**绝不**带 `apiKey` 字段。`response_format`/`seed` 等未知字段不塞进请求 |
| `finishReasonToOpenAI(reason)` | 164–173 | 导出函数 | DSH `FinishReason` → OpenAI `finish_reason`：`tool-calls`→`tool_calls`、`max-tokens`→`length`、`error`/`aborted`→`error`、`stop`→`stop`、默认 `stop` |
| `usageToOpenAI(usage)` | 176–188 | 内部函数 | DSH **互斥** TokenUsage 计数 → OpenAI usage：`prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`，缓存单列 `prompt_tokens_details.cached_tokens` |
| `foldChunks(chunks)` | 192–233 | 内部函数 | 把 chunk 流折叠成中间态 `{text, finish, usage, toolCalls}`：按 `index` 拼接 `tool-call-delta` 的 arguments，**只保留带 name 的调用**（无 name 的引擎无法执行），按 index 排序 |
| `chunksToCompletion({id,model,chunks})` | 236–256 | 导出函数 | chunk 流 → OpenAI 非流式响应体；纯工具调用时 `content` 为 `null`（非空串）；`finish_reason` 缺省时按 `hasCalls` 取 `tool_calls`/`stop` |
| `sseFrame(payload)` | 259–262 | 导出函数 | 一帧 SSE：`data: <json>\n\n`（字符串原样、对象 JSON.stringify） |
| `chunksToSse({id,model,created,chunks})` | 265–317 | 导出函数 | chunk 流 → SSE 帧数组，首帧带 `role:assistant`，末帧 `[DONE]`（即使上游没给 finish 也补一个终帧，否则引擎流读取挂住）；`usage` 单独成帧 |

所有导出符号都被 `test-engine-bridge.mjs` 第 19–27 行直接 import 并覆盖断言（system 抽取、tool_calls 还原、tools→ToolSchema、空 messages 抛错、usage 折算、SSE 帧、占位 key、assistant source 必带等）。

### `lib/engine/llm-bridge.js`（loopback HTTP 服务器）

| 符号 | 行号 | 类型 | 用途 |
|------|------|------|------|
| `DEFAULT_TIMEOUT_MS` | 33 | `const` | 单次模型调用默认超时 `10 * 60 * 1000`（10 分钟） |
| `MAX_BODY_BYTES` | 34 | `const` | 请求体上限 `32 * 1024 * 1024`（32 MB），超限回 413 |
| `bearerOf(req)` | 38–43 | 内部函数 | 从 Authorization 头取 bearer token，取完即弃；**绝不**写入日志、不放进请求对象、绝不传给 llm |
| `sendJson(res,status,body,extraHeaders)` | 45–54 | 内部函数 | 写 `application/json; charset=utf-8` + `content-length` + `cache-control:no-store` 并 `end` |
| `readBody(req,limit)` | 56–72 | 内部函数 | 异步读请求体，超过 `limit` 抛 `{statusCode:413}` 并 `req.destroy()` |
| `errorBody(message,type,code)` | 75–77 | 内部函数 | 把异常翻成 OpenAI 风格错误体 `{error:{message,type,code}}` |
| `startLlmBridge({llm,provider,model,reasoningEffort,timeoutMs,onLog})` | 90–241 | 导出函数 | 启动桥，返回 `Promise<{url, placeholderKey, port, stats(), close()}>`。详见下方「方法」 |

`startLlmBridge` 的契约束（第 90–93 行）：`llm` 必须有 `llm.stream` 函数、必须给 `provider` 和 `model`，否则立即 `throw`（不让桥以半配置状态监听端口，见 `test-engine-llm-bridge.mjs` 第 290–294 行）。

`startLlmBridge` 内部行为（逐段）：
- 第 96 行：每次启动随机生成占位 key `dsh-bridge-${randomBytes(32).toString('hex')}`——不复用、不落盘、不进日志；
- 第 97–98 行：`stats` 计数器 `{requests, streamRequests, authRejected, failures, lastError}` 与结构化日志 `log`（失败不影响请求）；
- 第 100–126 行：HTTP 处理器。`/healthz` 免 key 返回 `{ok,provider,model}`；所有 `/v1` 路由都必须带占位 key（第 118–126 行），否则 `authRejected++` 回 401 且错误体**不回显收到 key**（避免把误配的真实 key 写进日志）；
- 第 128–131 行：`GET /v1/models` 带 key 才放行，返回 `[{id:model,object:'model',owned_by:provider}]`；
- 第 133–147 行：非 `POST /v1/chat/completions` 回 404；非法 JSON 回 400 且不触达宿主 llm；
- 第 149–157 行：调用 `toLlmRequest` 转 `GenerateOptions`，失败回 400；
- 第 159–214 行：非流式/流式分支。流式边收边转（`chunksToSse` 逐帧发，把 `[DONE]` 留给收尾统一发，见第 183–187 行）；上游失败：流已开 → 发错误帧 + `[DONE]`（第 193–200 行），未开 → 回 502（第 201–202 行）；
- 第 163–167 行：客户端断连（`res.on('close')`）→ `ac.abort()`；超时 `timeoutMs` → `ac.abort()`；
- 第 228–240 行：`server.listen(0,'127.0.0.1',...)` 随机端口，resolve 出 `{url, placeholderKey, port, stats, close}`。

返回的 `close()`（第 237 行）是 `() => new Promise(...)` 包装的 `server.close()`。

## Architecture

两个文件是一薄一厚的上下层关系：`openai-bridge.js` 是纯转换内核，`llm-bridge.js` 把内核包进一个 loopback HTTP 端点。

```text
FSoft 原生引擎
   │  OpenAI-compatible: base_url=http://127.0.0.1:<port>/v1  + 占位 key
   ▼
┌──────────────────────────────────────────────────────────────┐
│ llm-bridge.js  startLlmBridge()  (lib/engine/llm-bridge.js)   │
│  · 绑定 127.0.0.1 + 随机端口（server.listen(0,'127.0.0.1')）  │
│  · 占位 key 校验（bearerOf + PLACEHOLDER_KEY_PATTERN）         │
│  · 路由 /healthz /v1/models /v1/chat/completions              │
│  · 读 body → toLlmRequest → llm.stream(GenerateOptions)       │
│  · 客户端断连/超时 → AbortController.abort()                   │
└───────────────┬──────────────────────────┬──────────────────┘
                │ 调用                        │ 纯转换
                ▼                            ▼
        宿主 llm.stream()          openai-bridge.js  (lib/engine/openai-bridge.js)
        （真实凭证在 provider 内部）  · toLlmRequest(): OpenAI→GenerateOptions
                                      · chunksToCompletion()/chunksToSse(): chunk流→OpenAI
                                      · finishReasonToOpenAI / usageToOpenAI
                                      · 无 I/O / 无网络 / 无密钥
```

要点：
- **安全边界在 `llm-bridge.js` 的 HTTP 层**：loopback + 随机端口 + 占位 key 三者缺一不可（见 `lib/engine/llm-bridge.js` 第 14–17 行）。`openai-bridge.js` 自身没有网络，也不持有任何 key。
- **流式/非流式同源**：两条路径都从 `foldChunks`（`lib/engine/openai-bridge.js` 第 192–233 行）出发，分别由 `chunksToCompletion`（第 236 行）和 `chunksToSse`（第 265 行）组装，避免行为分叉（见测试约定 `test-engine-bridge.mjs` 第 13–15 行）。
- **测试分两层**：`test-engine-bridge.mjs` 只测纯转换（不启服务器）；`test-engine-llm-bridge.mjs` 用假 `llm.stream` 测边界行为（绑定地址、401、日志无 key、502、SSE 收尾、断连/超时 abort）。

## Data Flow

**请求方向（引擎 → 宿主）：**
1. FSoft 引擎向 `http://127.0.0.1:<port>/v1/chat/completions` 发 `POST`，带 `Authorization: Bearer <占位key>`（`lib/engine/llm-bridge.js` 第 47–55 行 `post()` 模拟）。
2. 桥在 `lib/engine/llm-bridge.js` 第 118–126 行校验占位 key（401 且不回显 key）。
3. 读 body（`readBody`，第 56–72 行）→ JSON 解析（失败 400）→ `toLlmRequest`（`lib/engine/openai-bridge.js` 第 128–161 行）：
   - `messages` 经 `messageToDsh` 逐条转 DSH 消息，system/developer 抽到 `system` 槽（`lib/engine/openai-bridge.js` 第 76–122 行）；
   - `tools` 经 `toolsToSchemas` 转 `ToolSchema`（第 53–66 行）；
   - `temperature/max_tokens/stop` 映射；`api_key` 等**不入** `GenerateOptions`（第 348–356 行断言）；
   - assistant 历史消息带 `source.kind='model'`（`lib/engine/openai-bridge.js` 第 103–105 行）。
4. 桥用 `llm.stream({...options, signal: ac.signal})` 真正调模型（`lib/engine/llm-bridge.js` 第 171 行）。

**响应方向（宿主 → 引擎）：**
- 非流式：collect 所有 chunk → `chunksToCompletion`（`lib/engine/openai-bridge.js` 第 236 行）折叠成 `{choices:[{message:{role,content,tool_calls},finish_reason}], usage}`；`usage` 经 `usageToOpenAI` 折算（第 176–188 行）；回 200 JSON（第 218 行）。
- 流式：每收到一个 chunk 立即 `chunksToSse` 逐帧写 `text/event-stream`（`lib/engine/llm-bridge.js` 第 183–187 行；`chunksToSse` 见 `lib/engine/openai-bridge.js` 第 265–317 行），收尾统一写 `data: [DONE]\n\n`（第 210 行）。
- 工具调用：按 `index` 拼接 `tool-call-delta.argumentsDelta` 成完整 JSON 字符串，无 `name` 的调用被丢弃（`lib/engine/openai-bridge.js` 第 222–231 行）。
- 上游失败：流已开 → 错误帧 + `[DONE]`（不挂住客户端，`lib/engine/llm-bridge.js` 第 193–200 行）；未开 → 502（`errorBody` 风格错误体，引擎按 status 记账，见第 201–203 行）。

**控制流（取消/超时）：**
- 客户端断连：`res.on('close')` → `ac.abort()`（`lib/engine/llm-bridge.js` 第 164–165 行）→ 宿主 `llm.stream` 收到 signal 中止，省 token（`test-engine-llm-bridge.mjs` 第 249–272 行）。
- 超时：`setTimeout(() => ac.abort(), timeoutMs)`（第 166 行），非流式返回 502（第 274–288 行）。

## Connections

- [[engine-client]] — `lib/engine/client.js` 第 11 行明确写明「模型通道由 llm-bridge.js 单独提供」：引擎进程（Python 入口）与模型通道是两条独立的子进程/端口。本桥给 Python 引擎通过 `CODEWIKI_BASE_URL` + 占位 `CODEWIKI_API_KEY` 注入 `127.0.0.1:<port>/v1`（见 [[engine-python-entry]]）。
- [[engine-python-entry]] — `lib/engine/python/entry.py` 第 23–29 行说明迁移后模型通道由 Node 侧 loopback 桥注入，密钥只活在进程环境变量（`CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`/`CODEWIKI_MAIN_MODEL`，第 98–101 行），不读 `~/.codewiki/config.json` 或 keyring。
- [[agentic-host]] — `lib/agentic-host.js` 第 83–108 行的 `makeHostStream` 同样消费宿主 `llm.stream`，但走的是「裸消息→正式 Message」的适配，不经过 OpenAI 协议；本桥代表了「把同一套 `llm.stream` 暴露成 OpenAI 协议」的另一条路。
- [[engine-contract]] — `lib/engine/contract.js` 定义 `EngineResult`/`EngineProgress`/`EngineError`，是 Python 引擎与 Node 之间的结果契约；与本桥无关但同属 `lib/engine/` 迁移层。
- 测试层：`test-engine-bridge.mjs`（纯转换契约）与 `test-engine-llm-bridge.mjs`（loopback 边界行为）是本模块的直接保障文件。

## Known Issues

- **`assistant.source` 是回归雷区（1C 真实模型才炸）**：`lib/engine/openai-bridge.js` 第 68–75 行的注释指出，宿主 `LlmRuntime.forAdapter()` 会无条件读 `message.source.replayState`；桥生成的 assistant 消息若没有 `source`，真实工具循环第二轮起会抛 `Cannot read properties of undefined (reading 'replayState')`，整轮被判 `finish=error`，引擎侧表现为 "Please return text or call a tool." 耗尽重试。纯单测抓不到，只有真跑一次工具往返才暴露（`test-engine-bridge.mjs` 第 358–400 行专门补的回归用例）。桥没有 replay 能力，所以只填 `provider/model`、**不伪造** `replayState`（`lib/engine/openai-bridge.js` 第 75 行、第 399 行断言）。
- **`[DONE]` 收尾不可省**：流式路径若上游没给 `finish` chunk，`chunksToSse` 必须补一个终帧（`lib/engine/openai-bridge.js` 第 310–314 行），否则引擎的 SSE 读取会挂住（`test-engine-bridge.mjs` 第 297 行、第 159 行断言）。
- **无 name 的 tool-call-delta 必须丢弃**：折叠时只保留带 `name` 的调用（`lib/engine/openai-bridge.js` 第 222–231 行），无 name 的调用引擎无法执行，混进去会制造噪音（`test-engine-bridge.mjs` 第 245–256 行）。
- **错误响应不回显 key**：401 错误体只回 `invalid bridge key`，绝不 echo 收到的 key（`lib/engine/llm-bridge.js` 第 123–124 行；`test-engine-llm-bridge.mjs` 第 80–89 行断言），避免把用户误配的真实 key 写进日志。
- **多模态 content 只吃 text**：`contentToBlocks`（`lib/engine/openai-bridge.js` 第 38–51 行）显式跳过 `image_url` 等非文本 parts，因为引擎只发文本；若将来引擎开始发图像，这里是第一个要改的点。
- **无「禁用/注释」代码**：本模块两个文件均无被注释掉或功能关闭的逻辑；占位 key 校验是唯一准入闸门，始终是开启状态。

