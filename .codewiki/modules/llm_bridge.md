---
title: llm_bridge
type: module
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - test-engine-llm-bridge.mjs
tags: [tests, llm-bridge, openai-bridge, fake, streaming, loopback, codewiki]
---

## Overview

`llm_bridge` 是一个聚焦的测试模块，专门给「宿主模型 loopback 桥」（`lib/engine/llm-bridge.js`）做**服务器级边界行为**测试。它只覆盖一个测试文件 `test-engine-llm-bridge.mjs`，并直接 import 被测桥 `startLlmBridge`，以及桥依赖的纯转换层 `lib/engine/openai-bridge.js`（只作为占位 key 形态的来源被引用）。

与 `test-engine-bridge.mjs`（纯转换契约测试，只测 `openai-bridge.js` 的无 I/O 函数）是职责分工关系：那边钉「请求/响应映射对不对」，这边钉「桥作为宿主凭证看门人是否真的守住」——这些行为错了不会报错，只会悄悄把凭证能力开放出去，所以必须有断言（`test-engine-llm-bridge.mjs:1-16` 头部注释）。

本模块的全部「test helpers」就是测试文件内自己定义的小工具，按任务主题分成三类：

- **fake（假宿主）**：`fakeLlm(script)`（`test-engine-llm-bridge.mjs:28`）——用一个假 `llm.stream` 模拟宿主 provider，按脚本产出 chunk 并记录收到的请求；另有两处内联假 llm 用于验证断连/超时 abort。不需要真实 provider、不涉及任何密钥。
- **payloads（请求体）**：`simpleBody`（`57`）、`post(bridge, body, {key, signal})`（`47`）打 `/chat/completions`、以及随各用例拼出的 tools/stream/空 messages 等变体。
- **streaming（流式断言）**：对 SSE 逐帧下发、`[DONE]` 收尾、上游中途失败先发错误帧再 `[DONE]` 的断言逻辑（`131`、`151`），以及对「客户端断连/超时触发上游 `signal` abort」的断言（`249`、`274`）。

## Key Components

下面列出本模块相关的被测导出与测试 helpers。行号以 `read_code` 返回的「行号| 」前缀为准。

### 被测源文件：`lib/engine/llm-bridge.js`（服务器层，阶段 1B 薄桥）

- `DEFAULT_TIMEOUT_MS = 10*60*1000`（`33`）；`MAX_BODY_BYTES = 32*1024*1024`（`34`）。
- `bearerOf(req)`（`38`）—— 内部：从 `Authorization` 头取 bearer token 用于校验，**取完即弃**，不写日志、不进请求、不传 llm。
- `sendJson(res, status, body, extraHeaders)`（`45`）；`readBody(req, limit)`（`56`，超 `limit` 抛 413）；`errorBody(message, type, code)`（`75`，OpenAI 风格错误体）。
- `startLlmBridge({llm, provider, model, reasoningEffort, timeoutMs, onLog})`（`90`）—— **核心被测导出**。返回 Promise 解析为 `{url, placeholderKey, port, stats(), close()}`：
  - 占位 key 每次启动随机生成 `dsh-bridge-${randomBytes(32).toString('hex')}`（`96`）；绑 `127.0.0.1` 随机端口（`230`）。
  - 所有 `/v1` 请求必须带占位 key 校验（`118-126`），失败 `stats.authRejected++` 并 401 且不回显收到的 key（`120-124`）。
  - `POST /v1/chat/completions` 走 `toLlmRequest`（`151`）→ `llm.stream({...options, signal})`（`171`）；流式边收边转 `chunksToSse`（`183`）、以 `[DONE]` 收尾（`210`）；上游抛错时非流式转 502（`202`）、流式先发错误帧再 `[DONE]`（`195-197`）。
  - 客户端断连 `res.on('close')`→`ac.abort()`（`164-165`），`timeoutMs` 到点也 abort（`166`）。
  - `GET /v1/models` 需占位 key 返回配置模型（`128-131`）；`GET /healthz` 不需 key 且不含凭证信息（`112-115`）。
  - `stats()` 返回 `{requests, streamRequests, authRejected, failures, lastError}`（`97`）。

### 被测源文件：`lib/engine/openai-bridge.js`（纯转换层，仅被桥 import）

- `PLACEHOLDER_KEY_PATTERN`（`29`）—— 正则 `/^dsh-bridge-[a-z0-9-]+$/`，占位 key 形态约束。本测试文件通过 `test-engine-bridge.mjs` 间接覆盖，这里只作为桥的校验依据被 `llm-bridge.js` 引入（`24-31`）。
- `toLlmRequest`（`128`）、`chunksToCompletion`（`236`）、`chunksToSse`（`265`）、`sseFrame`（`259`）—— 纯转换函数；本测试文件不直测它们（那是 `test-engine-bridge.mjs` 的职责），但桥在运行时调用它们，测试通过端到端 HTTP 行为间接验证。

### 测试文件：`test-engine-llm-bridge.mjs`（服务器边界行为，阶段 1B）

统一入口 `check(label, fn)`（`22`）—— 包 try/catch 统计 `pass`/`fails`，失败进 `fails` 并在末尾（`296-300`）以 `process.exitCode=1` 退出。import 被测 `startLlmBridge`（`18`）。

**Test helpers（fakes / payloads / streaming）：**

- `fakeLlm(script)`（`28`）—— **fake 宿主**：返回 `{calls, async *stream(options)}`；`stream` 把 `options` 压入 `calls` 再 `yield* script(options)`。用例用闭包 `script` 控制产出哪些 chunk（text-delta / tool-call-delta / usage / finish / 抛错），从而断言「桥有没有正确转发」（`108-110`、`127`）。
- `withBridge(opts, fn)`（`42`）—— 启桥并 `try/finally` 调 `bridge.close()`，保证端口回收。
- `post(bridge, body, {key, signal})`（`47`）—— 打 `${bridge.url}/chat/completions`，默认带 `authorization: Bearer ${bridge.placeholderKey}`，`key` 为 `null` 时去掉头（用于缺 key 用例），`signal` 透传给 fetch（用于断连 abort 用例）。
- `simpleBody`（`57`）—— 基准请求体 `{messages:[{role:'user', content:'写一段话'}]}`。
- `sleep(ms)`（`40`）—— `setTimeout` 封装，给断连/超时用例留出时间窗口。

**测试单元（每个一行 `await check(...)`）：**

- 绑定 127.0.0.1 随机端口、url 指向 `/v1`、占位 key 形态（`59`）。
- 凭证闸门：缺 Authorization→401 且不触达 llm（`68`）、真实形态 key（`sk-live-...`）→401 且 key 不回显（`80`）、同格式但非本次生成的占位 key→401（`211`）。
- 非流式：返回 OpenAI 形状且 usage 从 DSH 互斥计数正确折算（`91`）、工具调用拼完整 arguments 并带 tool_calls（`114`）、上游失败→502+OpenAI 错误体（`165`）。
- 流式：SSE 逐帧下发并以 `[DONE]` 收尾（`131`）、上游中途失败→错误帧+`[DONE]` 不挂住（`151`）。
- 防御面：非法 JSON→400 不触达 llm（`176`）、空 messages→400（`189`）、`/v1/models` 需占位 key（`198`）、`/healthz` 不需 key 且不泄露凭证（`222`）、日志不含 Authorization 与占位 key 本身（`232`）。
- 取消语义：客户端断连→上游 signal abort（`249`，内联假 llm 监听 `abort`）、超时→上游 signal abort+非流式 502（`274`，内联假 llm 监听 `abort`）。
- 启动参数缺失→抛错（`290`，分别缺 `llm`/`provider`/`model`）。

## Architecture

本测试模块把「真宿主 provider」替换成内存里的假 `llm.stream`，再用 `fetch` 当引擎客户端打到 loopback 端口，从而在无密钥、无网络依赖下钉死桥的边界行为。框图如下（每个框标注组件与文件/行号）：

```text
  FSoft 引擎 (OpenAI-compatible client)
        │  POST /v1/chat/completions (fetch, test:post 47)
        ▼
┌────────────────────────────────────────────────────┐
│  llm-bridge.js  startLlmBridge (server层, 90)       │
│  127.0.0.1:随机端口 /v1 + 占位key校验 (118-126)      │
│  401/400/502 错误体 · [DONE] 收尾 · abort (164-166)  │
│  调用 openai-bridge.js 纯转换 (toLlmRequest 151)    │
└───────────────────┬────────────────────────────────┘
                    │  llm.stream({...options, signal}) (171)
                    ▼
┌────────────────────────────────────────────────────┐
│  fakeLlm(script)  TEST HELPER (28)                  │
│  calls[] 记录转发 · script(options) 产出 chunk 流   │
│  （无真实 provider，无密钥）                          │
└────────────────────────────────────────────────────┘
        ▲  断言：stats / 不触达 llm / 日志无 key
        │  test-engine-llm-bridge.mjs check() (22)
```

对应关系：测试文件 `test-engine-llm-bridge.mjs` 用 `withBridge`（`42`）启桥 → 用 `post`（`47`）模拟引擎 → 用 `fakeLlm`（`28`）模拟宿主；断言全部集中在 `check(label, fn)`（`22`）里，覆盖路由、凭证闸门、流式帧、断连/超时 abort、启动校验五类边界。

## Data Flow

### 一次测试请求的完整回路（引擎客户端 → 桥 → 假宿主）

1. 测试用 `withBridge(opts, fn)`（`42`）启动 `startLlmBridge`，得到 `{url, placeholderKey, port, stats, close}`；`placeholderKey` 形如 `dsh-bridge-<64 hex>`（`96`）。
2. `post(bridge, body, {key})`（`47`）用 `fetch` 打 `${bridge.url}/chat/completions`，默认带 `authorization: Bearer <placeholderKey>`；`key:null` 时不带头（缺 key 用例）。
3. 桥侧 `bearerOf(req)`（`38`）只取 token 校验：`PLACEHOLDER_KEY_PATTERN.test(token) && token===placeholderKey`（`120`），不符则 `stats.authRejected++` 并 401（错误体不回显收到的 key，`124`）。
4. 合法 POST 经 `toLlmRequest({provider, model, reasoningEffort, body})`（`128`，由桥在 `151` 调用）转成 DSH `GenerateOptions`，再 `llm.stream({...options, signal})`（`171`）交给假宿主。
5. `fakeLlm` 的 `stream`（`28`）把 `options` 压入 `calls`，再 `yield* script(options)` 产出 chunk；测试随后断言 `calls[0].provider/model/tools`（`108-110`、`127`），证明桥真的转发了路由与 tools。

### 非流式响应回路

- 桥收集全部 chunk → `chunksToCompletion({id, model, chunks})`（`236`）折叠成 `chat.completion` JSON（usage 由 `usageToOpenAI` 把 DSH 互斥计数折算成 OpenAI `prompt_tokens`=`inputTokens+cacheRead+cacheWrite`，`176`）→ `sendJson` 200（`216-218`）。
- 上游抛错（非流式）：转 502 + OpenAI 错误体（`202`），`stats.failures++`/`lastError`（`192`）。测试断言 `status 502` 与 `body.error.message`（`165-172`）。

### 流式响应回路（streaming）

- 测试发 `{...simpleBody, stream:true}`（`138`），桥边收边用 `chunksToSse`（`265`）逐帧发（`183-187`），末帧统一发 `data: [DONE]\n\n`（`210`）。
- 断言：content-type 含 `text/event-stream`（`140`）、文本以 `data: [DONE]\n\n` 结尾（`142`）、逐帧拼接出的 content 正确（`143-146`）、`stats.streamRequests===1`（`147`）。
- 上游中途失败：假 llm 先 yield 半截再 `throw`，桥先发错误帧再 `[DONE]`（`195-197`），断言仍以 `[DONE]` 收尾且含错误码（`151-162`），防止引擎 SSE 读取挂住。

### 取消语义回路（abort）

- 客户端断连：`post` 传 `signal` 的 `AbortController`（`264-268`），桥 `res.on('close')`→`ac.abort()`（`164-165`）；假 llm 监听 `signal.abort` 置 `aborted`（`253`），断言 `aborted!==null`（`249-271`）。
- 超时：`startLlmBridge` 传 `timeoutMs:150`（`284`），桥 `setTimeout(()=>ac.abort(), timeoutMs)`（`166`）；假 llm 监听 `abort` 后 `throw`，桥转 502（`274-288`）。

## Connections

- [[lib/engine/llm-bridge]] — 服务器层薄桥，本模块的唯一被测源。
- [[lib/engine/openai-bridge]] — 纯转换层，被桥 import 并在运行时调用（`llm-bridge.js:24-31`）；其纯函数由 [[test-engine-bridge]] 直接钉死，本模块只端到端间接覆盖。
- [[test-engine-bridge]] — 同属阶段 1B 的纯转换契约测试，与本模块是「映射对不对 vs 凭证守没守住」的职责分工，互补而非重叠。
- [[engine-bridge]] — 桥在整体引擎迁移中的定位（[[lib/engine/llm-bridge]] 的父模块视角）。
- [[test_engine_bridge_io]] — 更宽的聚合测试模块，把 `test-engine-bridge.mjs` / `test-engine-llm-bridge.mjs` / `test-engine-output.mjs` / `test-engine-output-real.mjs` 一并收录；本模块相当于把它里面对 `llm-bridge` 的那一块抽出来独立成篇。
- [[docs-fsoft-native-engine]] — 阶段 1B 验收证据（`docs/fsoft-native-engine.md:170-180`）记录桥的真机实测（流式/非流式/工具往返）；本模块覆盖的是用 fake 宿主复现这些行为的可复现测试。

## Known Issues

- 桥的安全边界依赖「真实凭证只存在于宿主 provider 内部」这一外部前提（`llm-bridge.js:6-17` 注释）。测试用 `fakeLlm`（`28`）模拟宿主，因此**不验证真实 provider 凭证是否真的没经桥泄露**——`test-engine-llm-bridge.mjs:28` 那组断言只覆盖「桥自身不读/不转发/不记录密钥」，不覆盖宿主侧。
- 流式断言对「逐帧下发」只做了终点与拼接校验：`test-engine-llm-bridge.mjs:131` 验证 `text.endsWith('data: [DONE]\n\n')` 与逐帧 content 拼接成 `'AB'`，但没有断言「首包是否真的在 `res.headersSent` 之前就写出去了」（桥在 `174-181` 边收边转，靠单测点不易稳定复现首包时机）。
- 内联假 llm（断连/超时用例，`251` 与 `275`）与 `fakeLlm` 工厂（`28`）是两套不同形态：前者手写 `async *stream` 监听 `signal.abort`，后者由 `script` 闭包控制产出。两者行为不统一，新增用例时容易混用导致「忘记监听 abort」。
- `timeoutMs` 默认 `10*60*1000`（`33`）；`test-engine-llm-bridge.mjs:284` 用 `timeoutMs:150` 验证超时 abort，但对「超时后上游确实被中断」只靠 502 间接证明，没有专门断言 `stats.failures` 或日志计时。
- 启动参数校验用例（`290`）只断言 `startLlmBridge({})` 抛 `/llm/`、`{llm:{stream(){}}}` 抛 `/provider/`、`{llm,provider}` 抛 `/model/`；没有覆盖 `reasoningEffort`/`onLog` 这类可选参数被错误类型传入时的行为（桥本身对这些未做类型守卫，见 `90-93` 只对必填项 `throw`）。
- 工具调用断言（`114`）依赖 `fakeLlm` 产出两个 `tool-call-delta` 把 `argumentsDelta` 拼成 `'{"path":"x.py"}'`；若宿主 chunk 协议改了 `argumentsDelta` 的增量粒度，测试脚本需同步改，但没有任何集成测试提醒这里与 `openai-bridge.js:202-210` 的 `foldChunks` 拼接逻辑需要保持同源（该同源保证写在 `openai-bridge.js:192` 注释里，本模块不直测）。
