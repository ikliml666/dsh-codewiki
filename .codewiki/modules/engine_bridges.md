---
title: engine_bridges
type: module
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - test-engine-llm-bridge.mjs
  - test-engine-bridge.mjs
tags: [engine, llm, openai-compatible, protocol-translation, loopback, security]
---

## Overview

`engine_bridges` 是 dsh-codewiki 迁移里的「LLM 通道」层。它解决一个硬约束：FSoft 原生引擎
（`lib/engine/python/entry.py`）只认 OpenAI-compatible 的 `base_url` + `api_key`，而 DSH 的模型
凭证只存在于宿主 provider 配置里——插件既不保存、也不传递真实密钥（0.10.1 起硬约束）。

于是这一层做成两个文件：

- `lib/engine/openai-bridge.js`：纯转换层（无 I/O、无网络、无密钥）。把 OpenAI 的
  `chat/completions` 请求体翻译成 DSH 的 `GenerateOptions`，再把 DSH 的 `StreamChunk` 流翻译回
  OpenAI 响应（非流式 JSON 与流式 SSE 共用同一套拼接逻辑）。
- `lib/engine/llm-bridge.js`：进程内 HTTP 端点（`node:http` 的 `createServer`），跑在
  `127.0.0.1` 随机端口上。引擎拿着**占位 key**打过来，桥把它转成宿主 `llm.stream(GenerateOptions)`，
  用宿主自己的凭证去调真实 provider。

关键安全边界（整个迁移最不能破的一条，见 `llm-bridge.js:6-17`）：

- 桥**不读**任何凭证文件、**不接收**真实 `api_key`、**不转发** `Authorization` 头；
- 引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和一个占位 key（`dsh-bridge-...`）；
- 真实凭证只存在于宿主 provider 内部——桥通过传入的 `llm` 对象间接触发，自己从头到尾看不见它；
- 访问日志与错误日志只记 method/path/状态/耗时/请求 id，**不记** `Authorization`。

为什么必须 loopback + 随机端口 + 占位 key 三者齐备：桥等于「用宿主凭证换任意模型调用」的开关。
绑定 127.0.0.1 阻断外网；随机端口让同机其它进程猜不到；占位 key 校验挡住误连/端口扫描。三者缺
一都等于把宿主凭证开放给本机任意进程（`llm-bridge.js:14-17`）。

协议面（只实现引擎真正用到的部分，不假装完整 OpenAI，见 `llm-bridge.js:19-22`）：

- `POST /v1/chat/completions`：非流式（`stream` 缺省/`false`）与流式（`stream: true`）；
- `GET  /v1/models`：引擎/探针的连通性检查；
- `GET  /healthz`：桥自身存活（不含任何模型信息）。

## Key Components

本模块没有 class，`openai-bridge.js` 导出纯函数、`llm-bridge.js` 导出 `startLlmBridge`。下面按文件列出全部公开导出与关键内部常量/函数（行号以源码前缀为准）。

### lib/engine/openai-bridge.js（纯转换层）

常量：

- `PLACEHOLDER_KEY_PATTERN`（29|）：`/^dsh-bridge-[a-z0-9-]+$/`。桥只认自己生成的占位 key；
  任何真实 key 都不该出现在引擎侧配置里。

公开函数：

- `isPlaceholderKey(value)`（31|）：判断字符串是否匹配 `PLACEHOLDER_KEY_PATTERN`。
  测试断言真实 key（如 `sk-real-secret-1234`）一律返回 `false`
  （`test-engine-bridge.mjs:340-346`）。
- `contentToBlocks(content)`（38|）：把 OpenAI 的 `content`（string 或 parts 数组）摊平成
  DSH 的 `ContentBlock[]`。非文本部分（如 `image_url`）显式跳过。
- `toolsToSchemas(tools)`（53|）：`OpenAI tools[].function → ToolSchema`，字段
  `name` / `description` / `parameters` 原样映射；缺 `name` 的项被丢弃。这正是
  agentic 工具循环不退化成空谈的前提。
- `messageToDsh(msg, route)`（76|）：一条 OpenAI 消息 → 一条或多条 DSH `RequestMessage`。
  - `system`/`developer` → 抽到 system 槽（`text`）；
  - `user` → `{role:'user', content}`；
  - `assistant` 带 `tool_calls` → `content` 里追加 `tool-call` 块，`arguments` **保持原始 JSON 字符串**
    （DSH 的 `ToolCallBlock` 定义如此，提前 parse 会破坏增量拼接），且必须带 `source`
    （`{kind:'model', provider, model}`），否则宿主 `forAdapter()` 读 `source.replayState` 会抛错；
  - `tool` → `{role:'tool', toolCallId, isError, content}`，`toolCallId` 必须对上，否则工具循环断链。
- `toLlmRequest({ provider, model, reasoningEffort, body })`（128|）：OpenAI 请求体 → DSH
  `GenerateOptions` 的子集。校验 `provider`/`model` 非空、`messages` 是非空数组、除 system 外至少
  有一条消息；把 system 合并进 `system` 字段，`tools` 映射成 schema，`temperature`/`max_tokens`/`stop`
  分别映射成 `temperature`/`maxTokens`/`stop`；返回里**永远没有** `apiKey` 字段。可见
  `test-engine-bridge.mjs:40-175`。
- `finishReasonToOpenAI(reason)`（164|）：DSH `FinishReason → OpenAI finish_reason`
  （`tool-calls`→`tool_calls`、`max-tokens`→`length`、`error`/`aborted`→`error`、其余→`stop`）。
- `chunksToCompletion({ id, model, chunks })`（236|）：DSH chunk 流 → OpenAI 非流式响应体。
  纯工具调用时 `content` 为 `null`（OpenAI 语义，不是空串）。
- `sseFrame(payload)`（259|）：把对象（或字符串）包成 `data: <json>\n\n`；`[DONE]` 是独立帧。
- `chunksToSse({ id, model, created, chunks })`（265|）：chunk 流 → SSE 帧数组，每帧一个完整 chunk，
  末帧必为 `[DONE]`；流式 usage 单独成帧；流没给 finish 也要补一个终帧，否则引擎的 SSE 读取会挂住。

关键内部函数（非导出，但决定转换正确性）：

- `usageToOpenAI(usage)`（176|）：DSH `TokenUsage` 是**互斥**计数（`inputTokens` 不含缓存），
  OpenAI 的 `prompt_tokens` 含缓存，故 `prompt_tokens = inputTokens + cacheRead + cacheWrite`，
  缓存单列进 `prompt_tokens_details.cached_tokens`（`openai-bridge.js:175-188`、
  `test-engine-bridge.mjs:217-224`、`test-engine-llm-bridge.mjs:104-106`）。
- `foldChunks(chunks)`（192|）：把 chunk 流折叠成 `{text, finish, usage, toolCalls}` 的中间态。
  `tool-call-delta` 按 `index` 拼接成完整 `arguments`，且只产出有 `name` 的调用（无 name 的调用
  引擎无法执行，混进去只会制造噪音）；`reasoning-delta` 不进正文。非流式与流式两条路径都从这里出发。

### lib/engine/llm-bridge.js（HTTP 端点层）

常量：

- `DEFAULT_TIMEOUT_MS`（33|）：`10 * 60 * 1000`，单次模型调用默认超时。
- `MAX_BODY_BYTES`（34|）：`32 * 1024 * 1024`，请求体上限，超出回 413。

内部辅助：

- `bearerOf(req)`（38|）：从 `Authorization` 头取出 bearer token，**只用于校验占位 key**，
  取完即弃，绝不写日志、绝不进请求对象、绝不传给 `llm`。
- `sendJson(res, status, body, extraHeaders)`（45|）：写 JSON 响应，`cache-control: no-store`。
- `readBody(req, limit)`（56|）：读请求体，超限 reject `statusCode:413` 并 `req.destroy()`。
- `errorBody(message, type, code)`（75|）：把上游异常翻译成 OpenAI 风格错误体。

公开函数：

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`（90|）：启动桥，
  返回 Promise 解析为 `{ url, placeholderKey, port, close(), stats() }`。
  - 入参校验：`llm.stream` 必须是函数、`provider`、`model` 必填（缺则同步抛错，
    不让桥以半配置状态监听端口，`llm-bridge.js:91-93`、`test-engine-llm-bridge.mjs:290-294`）；
  - 每次启动随机生成 `placeholderKey`（`dsh-bridge-${randomBytes(32).toString('hex')}`），
    不复用、不落盘、不进日志（`llm-bridge.js:96`）；
  - `stats()` 返回 `{requests, streamRequests, authRejected, failures, lastError}`（`llm-bridge.js:97`）；
  - `close()` 关闭服务器并返回 Promise；
  - 监听 `127.0.0.1` 随机端口（`server.listen(0, '127.0.0.1', ...)`，`llm-bridge.js:230`），
    `url` 形如 `http://127.0.0.1:<port>/v1`；
  - 请求处理：所有 `/v1` 请求必须带合法占位 key（闸门在 `llm-bridge.js:118-126`，校验不过
    则 `authRejected++` 并回 401，**错误体不回显收到的 key**）；`/healthz` 无需 key 且不泄露
    任何凭证信息；`/v1/models` 返回配置的模型；`/v1/chat/completions` 调 `toLlmRequest` 转换后
    用 `llm.stream({...options, signal})` 取 chunk，非流式攒完用 `chunksToCompletion` 回 JSON、
    流式逐帧 `chunksToSse` 下发；客户端断连或超时都通过 `AbortController` 中止上游调用
    （`llm-bridge.js:163-167`）；上游失败非流式回 502、流式在已开流时先发错误帧再发 `[DONE]`
    （`llm-bridge.js:189-203`、`206-214`）；结构化日志 `onLog` 只记
    method/path/status/ms，不记 `Authorization`（`llm-bridge.js:103-109`、`232-247`）。

## Architecture

两个文件分工：HTTP 传输在 `llm-bridge.js`，协议翻译在 `openai-bridge.js`（被 `llm-bridge.js`
import，见 `llm-bridge.js:26-31`）。框图（组件 ≥3，画边界与数据方向）：

```text
┌─────────────────────────┐         loopback URL + 占位 key
│ FSoft 引擎 (python/entry) │ ───────────────────────────────┐
│ 只读 env: CODEWIKI_BASE_* │                                  │
└─────────────────────────┘                                  ▼
                                             ┌──────────────────────────────┐
                                             │ llm-bridge.js  startLlmBridge │
                                             │  127.0.0.1:随机端口 /v1       │
                                             │  · 占位 key 准入闸门           │
                                             │  · /healthz /v1/models        │
                                             │  · 流式边收边发 + [DONE] 收尾   │
                                             └──────────┬───────────────────┘
                                                        │ 请求方向: toLlmRequest()
                                                        │ 响应方向: chunksToCompletion/Sse()
                                                        ▼
                                             ┌──────────────────────────────┐
                                             │ openai-bridge.js (纯转换,无IO) │
                                             │  OpenAI req ↔ DSH GenerateOpts │
                                             │  chunk 流 ↔ OpenAI 响应(SSE)    │
                                             └──────────┬───────────────────┘
                                                        │ llm.stream(GenerateOptions)
                                                        ▼
                                             ┌──────────────────────────────┐
                                             │ 宿主 llm 服务 (provider/model) │
                                             │  真实凭证只在这里, 桥看不到      │
                                             └──────────────────────────────┘
```

组件与文件/函数对照：

- `llm-bridge.js::startLlmBridge`（HTTP 端点、安全闸门、流式/SSE、超时/断连 abort、日志脱敏）；
- `openai-bridge.js::toLlmRequest` / `chunksToCompletion` / `chunksToSse`（协议两面翻译）；
- `openai-bridge.js::foldChunks` / `usageToOpenAI`（共用折叠与 token 折算，保证流式与非流式同源）；
- 宿主 `llm.stream` 是桥唯一向下触达真实模型的入口。

## Data Flow

请求方向（引擎 → 桥 → 宿主）：

1. 引擎把 `CODEWIKI_BASE_URL=http://127.0.0.1:<port>/v1` 与 `CODEWIKI_API_KEY=<占位key>` 注入进程环境
   （`lib/engine/python/entry.py:98-99`、`_model_config` 在 `entry.py:243-275` 读取并拼成
   `provider:"openai-compatible"` 的 adapter config）。
2. 引擎发 `POST /v1/chat/completions`，`Authorization: Bearer <占位key>`。
3. `llm-bridge.js` 的 `bearerOf` 取 token，`PLACEHOLDER_KEY_PATTERN` + 等值比较双重校验
   （`llm-bridge.js:118-126`）；不过则 `401` 且不回显 key。
4. `readBody` 读体、JSON 解析失败回 400 且不触达 `llm`（`llm-bridge.js:139-147`、
   `test-engine-llm-bridge.mjs:176-187`）。
5. `toLlmRequest` 把 OpenAI 请求体转 `GenerateOptions`：system 抽到 system 槽、`assistant.tool_calls`
   还原成 `tool-call` 块（保留原始 JSON 字符串）、`tool` 消息映射成 `ToolResultMessage`、
   `tools` 映射成 `ToolSchema`、`temperature/max_tokens/stop` 映射；返回里无 `apiKey`
   （`openai-bridge.js:128-161`、`llm-bridge.js:149-157`）。
6. `llm.stream({...options, signal})` 被调用，信号来自「客户端断连」与「超时」两个 `AbortController`
   （`llm-bridge.js:163-167`、`171`）。

响应方向（宿主 chunk → 桥 → 引擎）：

1. 非流式：`for await` 把 chunk 全攒进 `chunks`，再 `chunksToCompletion` 折叠成单个 OpenAI JSON
   （`foldChunks` 把 `tool-call-delta` 按 `index` 拼成完整 `arguments`，只留有 name 的调用；
   `usage` 折算成 `prompt_tokens = inputTokens + cacheRead + cacheWrite`；`reasoning-delta` 不进正文）
   后 `sendJson` 回 200（`llm-bridge.js:169-218`、`openai-bridge.js:192-256`）。
2. 流式：`headersSent` 前先 `writeHead(200, text/event-stream, x-accel-buffering:no)`，
   每收到一帧立即 `chunksToSse` 转换并 `write`，流尾补 `data: [DONE]\n\n`
   （`llm-bridge.js:173-214`、`openai-bridge.js:265-317`、`test-engine-llm-bridge.mjs:131-149`）。
3. 上游失败：非流式回 502 + OpenAI 错误体（`llm-bridge.js:200-203`、
   `test-engine-llm-bridge.mjs:165-174`）；流式已在发头的情况下先写错误帧再写 `[DONE]`，
   避免引擎 SSE 读取挂住（`llm-bridge.js:193-199`、`test-engine-llm-bridge.mjs:151-163`）。

## Connections

- [[engine-client]]：`lib/engine/client.js` 负责把引擎命令（stdin 一行 JSON）交给 Python 子进程
  （`lib/engine/python/entry.py`）。本桥为那个子进程提供模型通道——`client.js` 的 `env`/进程启动
  与桥的 loopback 端点共同构成「FSoft 引擎跑在本机的唯一跨语言边界」的两端。
- [[engine-python-entry]]：`lib/engine/python/entry.py` 从 `CODEWIKI_BASE_URL` /
  `CODEWIKI_API_KEY`（`entry.py:98-99`）读模型通道，正是本桥 `startLlmBridge` 注入的回环地址与
  占位 key；它把 FSoft 的 LLM 调用全部导向本桥。
- [[agentic-host]]：`lib/agentic-host.js` 是宿主 `llm.stream` 的另一类消费者（agentic 工具循环），
  桥把 OpenAI 形态的调用最终也收口到同一个宿主 `llm` 服务——两条路径共享「凭证只在宿主」的约束。
- [[engine-quality-gate]] / [[engine-apply-plan]]：桥只在模块内做协议翻译，不读凭证、不落盘、
  不写 `.codewiki`；真正把模型产物落地的是 apply-plan 与 quality-gate，二者与本桥无直接调用关系，
  但都属于 `lib/engine/` 下的「阶段化」子模块。
- 宿主 `llm` 服务：桥通过 `startLlmBridge` 的 `opts.llm`（只需 `llm.stream`）间接触达，真实 provider
  配置与密钥完全在宿主侧解析。

## Known Issues

- 占位 key 仅防误连/端口扫描，不防本机同用户进程：桥接受「格式对 + 值与本次启动生成的 key 相等」
  的请求（`llm-bridge.js:120`），但**每次启动 key 不同且随机生成**（`llm-bridge.js:96`），且绑定
  127.0.0.1，因此同机其它进程猜不到端口、也拿不到 key。已知边界：若本机被同用户恶意进程读取到
  `url` 与 `placeholderKey`（二者都在同一进程内存里），则可冒用本机凭证调用模型——这是 loopback 桥
  的固有信任模型，不靠本模块单独解决。
- 日志脱敏靠约定而非强制：`onLog` 只记录 `{at, method, path, status, ms}`（`llm-bridge.js:103-109`），
  且 `bearerOf` 取完 token 即弃（`llm-bridge.js:38-43`）。但代码本身不拦截调用方在 `onLog` 里自行
  打印 `req.headers`——`test-engine-llm-bridge.mjs:232-247` 正是断言日志里不出现 `authorization/bearer`
  与占位 key 本身，靠测试守住这条线。
- 错误体不回显 key：401 时回 `errorBody('invalid bridge key', ...)`，且显式注释「错误体里不回显收到的
  key」（`llm-bridge.js:123-124`），防止把用户误配的真实 key 写进日志。对应测试见
  `test-engine-llm-bridge.mjs:80-89`。
- 流没给 `finish` 也要补终帧：`chunksToSse` 在循环结束后若 `!sawFinish` 会补一个终帧
  （`openai-bridge.js:310-314`），否则引擎的 SSE 读取会挂住——这是曾被踩过的卡死点。
- 上游中途失败在流式路径必须发 `[DONE]`：`llm-bridge.js:193-199` 已处理；若漏掉会导致引擎端卡死，
  相关回归见 `test-engine-llm-bridge.mjs:151-163`。
