---
title: test_engine_bridge
type: module
source_files:
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - test-engine-contract.mjs
  - lib/engine/client.js
  - lib/engine/native-run.js
tags: [test, llm-bridge, openai-bridge, engine, security, loopback]
---

## Overview

`test_engine_bridge` 不是单个文件，而是**两个配套测试文件 + 它们共同钉死的桥实现**，主题是「FSoft 原生引擎 ↔ 宿主 LLM 的 loopback 桥」。

为什么需要桥（见 `lib/engine/openai-bridge.js` 第 1–27 行与 `lib/engine/llm-bridge.js` 第 1–22 行）：FSoft 原生引擎只认 OpenAI-compatible 的 `base_url` + `api_key`；而 DSH 的凭证在宿主 provider 配置里，插件**既不保存也不传递密钥**（0.10.1 起的硬约束）。于是桥必须是一个跑在 `127.0.0.1` 上的进程内 HTTP 端点：引擎拿着一个**占位 key** 打过来，桥把请求转成 `llm.stream(GenerateOptions)`，用宿主自己的凭证去调真实 provider，再把 chunk 流翻回 OpenAI 响应。

两个测试文件的分工（见 `test-engine-llm-bridge.mjs` 第 1–16 行）：

- `test-engine-bridge.mjs`（第 1–422 行）：测**纯转换**（无 I/O、无网络、无密钥）。把 `lib/engine/openai-bridge.js` 导出的纯函数逐个钉死——请求方向 `toLlmRequest`、响应方向 `finishReasonToOpenAI` / `chunksToCompletion` / `chunksToSse` / `sseFrame`，以及凭证边界 `isPlaceholderKey` / `PLACEHOLDER_KEY_PATTERN`。
- `test-engine-llm-bridge.mjs`（第 1–301 行）：测**边界行为**——桥作为宿主凭证看门人是否真的守住了。启动真实 `http.Server`（`startLlmBridge`），用假 `llm.stream` 模拟宿主，断言 loopback 绑定、占位 key 校验、日志不含密钥、上游失败映射、流式收尾、客户端断连/超时 abort 等。

两文件都用同一套 `check(label, fn)` 微型测试框架（见 `test-engine-bridge.mjs` 第 29–34 行与 `test-engine-llm-bridge.mjs` 第 20–25 行）：`try { await fn(); pass++ } catch { fails.push(...) }`，最后打印 `N passed, M failed` 并在失败时 `process.exitCode = 1`。这些不是 Node 内置 `node:test`，而是手写的零依赖 runner。

> 关键上下文：纯转换（第一个文件）和边界行为（第二个文件）故意分开，因为「桥把空请求转发出去」「工具调用退化成空谈」「流式拿到半截 tool_calls」这类错是悄悄发生的——错了不报错，只会让引擎写出来的文章全是空壳，或被耗尽重试。所以这些必须用断言钉死。

## Key Components

本模块没有生产代码，全部是测试。下列列出的「被测函数」来自 `lib/engine/openai-bridge.js` 与 `lib/engine/llm-bridge.js`，按测试文件分组给出它们被哪些断言钉死。

### 测试运行器（两文件共用）

- `check(label, fn)`（`test-engine-bridge.mjs` 第 31–34 行；`test-engine-llm-bridge.mjs` 第 22–25 行）：异步断言助手，成功 `pass++` 打印 `PASS`，失败把 `{label, err}` 推入 `fails` 并打印 `FAIL`。
- `pass` / `fails`（`test-engine-bridge.mjs` 第 29–30 行；`test-engine-llm-bridge.mjs` 第 20–21 行）：计数器与失败收集。
- 末尾汇总（`test-engine-bridge.mjs` 第 417–421 行；`test-engine-llm-bridge.mjs` 第 296–300 行）：打印 `passed/failed` 数量，失败时遍历 `fails` 打印 `label` 与堆栈并置 `process.exitCode = 1`。

### 被测：`lib/engine/openai-bridge.js`（纯转换层）

- `PLACEHOLDER_KEY_PATTERN`（`openai-bridge.js` 第 29 行）：常量正则 `/^dsh-bridge-[a-z0-9-]+$/`，占位 key 必须满足此形状。
- `isPlaceholderKey(value)`（第 31–33 行）：仅当 `value` 为字符串且匹配 `PLACEHOLDER_KEY_PATTERN` 才返回 `true`。被 `test-engine-bridge.mjs` 第 340–346 行钉死：占位 key → `true`，真实 key / 空串 / `undefined` → `false`。
- `toLlmRequest({ provider, model, reasoningEffort, body })`（第 128–161 行）：OpenAI 请求体 → DSH `GenerateOptions` 子集。缺 `provider`/`model` 抛错（第 129–130 行），`messages` 非非空数组抛错（第 132 行），除 system 外无消息也抛错（第 146 行）。`test-engine-bridge.mjs` 第 40–175 行覆盖：system 抽到 `system` 槽（第 52–58 行）、无 system 时为 `undefined`（第 61–64 行）、assistant 的 `tool_calls` 还原成 `tool-call` 块含原始 JSON 串（第 66–91 行）、`tool` 角色映射成 `tool` 结果带 `toolCallId`/`isError`（第 93–109 行）、`tools` 映射成 `ToolSchema`（第 111–132 行）、`temperature`/`max_tokens`/`stop` 映射而 `response_format`/`seed` 丢弃（第 134–151 行）、多模态 content 摊平（第 153–165 行）、空 messages 与缺 provider/model 抛错（第 167–175 行）。
- `finishReasonToOpenAI(reason)`（第 164–173 行）：DSH `FinishReason` → OpenAI `finish_reason`。`tool-calls`→`tool_calls`、`max-tokens`→`length`、`error`/`aborted`→`error`、其余与 `undefined`→`stop`。被 `test-engine-bridge.mjs` 第 181–188 行钉死。
- `chunksToCompletion({ id, model, chunks })`（第 236–256 行）：chunk 流 → 非流式 OpenAI JSON。被 `test-engine-bridge.mjs` 第 192–268 行钉死：文本+工具调用+usage 组装、`usage` 互斥计数折算（`prompt_tokens = input + cacheRead + cacheWrite`，第 217–224 行）、纯工具调用时 `content` 为 `null`（第 227–236 行）、空流返回 `stop` + 空串（第 238–243 行）、无 `name` 的工具调用不产出半截工具（第 245–256 行）、`reasoning-delta` 不进 content（第 258–268 行）。
- `sseFrame(payload)`（第 259–262 行）：一帧 SSE，`data: <json>\n\n` 或 `[DONE]` 帧。被 `test-engine-bridge.mjs` 第 274–277 行钉死。
- `chunksToSse({ id, model, created, chunks })`（第 265–317 行）：chunk 流 → SSE 帧数组，首帧带 `role`，末帧 `[DONE]`。被 `test-engine-bridge.mjs` 第 279–334 行钉死：首帧带 role（第 279–298 行）、tool call 增量逐帧带片段（第 300–318 行）、usage 单独成帧（第 320–334 行）。
- 内部辅助（被间接覆盖，不在导出断言里显式 import）：`contentToBlocks`（第 38–51 行）、`toolsToSchemas`（第 53–66 行）、`messageToDsh`（第 76–122 行，含 `source.kind='model'` 注释）、`usageToOpenAI`（第 176–188 行）、`foldChunks`（第 192–233 行）。
- **回归断言（1C 真实模型暴露）**：`toLlmRequest` 生成的 assistant 历史消息必须带 `source`（第 368–389 行），其 `provider`/`model` 取自本次路由、`replayState` 为 `undefined`（第 391–400 行），`tool` 消息带 `toolCallId`（第 402–415 行）。这些是因为宿主 `LlmRuntime.forAdapter()` 会读 `source.replayState`，缺了就报 `Cannot read properties of undefined (reading 'replayState')`（见 `openai-bridge.js` 第 71–75 行注释）。

### 被测：`lib/engine/llm-bridge.js`（loopback 服务器桥）

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`（第 90–241 行）：启动 HTTP 桥，返回 `{ url, placeholderKey, port, stats(), close() }`。缺 `llm.stream`→抛 `/llm/`（第 91 行），缺 `provider`/`model`→抛 `/provider/`/`/model/`（第 92–93 行）。占位 key 每次 `randomBytes(32)` 随机生成（第 96 行），绑定 `127.0.0.1:0`（第 230 行）。被 `test-engine-llm-bridge.mjs` 第 59–294 行钉死。
- 内部辅助：`bearerOf`（第 38–43 行，取 Authorization 头且不写日志）、`sendJson`（第 45–54 行）、`readBody`（第 56–72 行，默认 32MB 上限，超限 413）、`errorBody`（第 75–77 行，OpenAI 风格错误体）、`DEFAULT_TIMEOUT_MS = 10*60*1000`（第 33 行）、`MAX_BODY_BYTES = 32*1024*1024`（第 34 行）。
- `bridge.stats()` 字段（`llm-bridge.js` 第 97 行）：`{ requests, streamRequests, authRejected, failures, lastError }`，被断言 `authRejected`（第 76 行）、`streamRequests`（第 147 行）、`failures`（第 161 行）、`lastError`（第 172 行）。

### `test-engine-llm-bridge.mjs` 的测试夹具

- `fakeLlm(script)`（第 28–38 行）：假宿主 llm，按脚本产出 chunk 并记录 `calls`（供断言「桥有没有正确转发 provider/model/tools」）。
- `sleep(ms)`（第 40 行）、`withBridge(opts, fn)`（第 42–45 行，启动并在 finally 里 `close`）、`post(bridge, body, {key, signal})`（第 47–55 行，默认带 `bridge.placeholderKey` 打 `/chat/completions`）。
- `simpleBody`（第 57 行）：`{ messages: [{ role: 'user', content: '写一段话' }] }`。

### `test-engine-llm-bridge.mjs` 覆盖的边界断言（按行）

- 绑定 `127.0.0.1` 随机端口、`url` 指 `/v1`、`placeholderKey` 形状（第 59–66 行）。
- 缺 Authorization → 401 且错误体不回显 key、`stats.authRejected=1`（第 68–78 行）。
- 真实形态 key → 401 且不出现在响应里（第 80–89 行）。
- 非流式返回 OpenAI 形状 + usage 折算、`llm.calls[0]` 带 provider/model（第 91–112 行）。
- 工具调用拼成完整 arguments 并转发 `tools` 给宿主（第 114–129 行）。
- 流式 SSE 逐帧下发、以 `[DONE]` 收尾、`content-type: text/event-stream`（第 131–149 行）。
- 流式上游中途失败 → 错误帧 + `[DONE]`（第 151–163 行）。
- 非流式上游失败 → 502 + OpenAI 错误体（第 165–174 行）。
- 非法 JSON → 400、不触达宿主（第 176–187 行）。
- 空 messages → 400、不转发（第 189–196 行）。
- `/v1/models` 需要占位 key、返回配置模型（第 198–209 行）。
- 同格式但非本次生成的占位 key → 401（第 211–220 行）。
- `/healthz` 不需要 key 且不泄露凭证（第 222–230 行）。
- 日志不含 Authorization 也不含占位 key 本身（第 232–247 行）。
- 客户端断连 → 上游 signal 被 abort（第 249–272 行）。
- 超时 → 上游 signal 被 abort、非流式 502（第 274–288 行）。
- 启动参数缺失 → 抛错（第 290–294 行）。

## Architecture

两个测试文件分别钉死桥的两个层面，共享同一份生产实现（`openai-bridge.js` 纯转换 + `llm-bridge.js` 服务器）。框图如下：

```text
┌──────────────────────────┐        ┌──────────────────────────────┐
│ test-engine-bridge.mjs    │        │ test-engine-llm-bridge.mjs    │
│ (纯转换单测, 无 I/O)       │        │ (loopback 服务器边界单测)       │
│ check()×~41 断言           │        │ fakeLlm() + post() 打真 HTTP    │
└───────────┬──────────────┘        └──────────────┬───────────────┘
            │ import                        │ startLlmBridge({llm,provider,model})
            ▼                                        ▼
┌──────────────────────────┐        ┌──────────────────────────────┐
│ lib/engine/openai-bridge  │        │ lib/engine/llm-bridge.js      │
│ .js (纯函数)               │        │ startLlmBridge()              │
│ toLlmRequest             │◄───────│  校验占位 key (bearerOf)       │
│ finishReasonToOpenAI     │        │  127.0.0.1:0 + /v1/*          │
│ chunksToCompletion      │        │  POST /v1/chat/completions ──►│
│ chunksToSse / sseFrame  │        │  GET  /v1/models /healthz      │
│ isPlaceholderKey        │        └──────────────┬───────────────┘
└──────────────────────────┘                       │ llm.stream(GenerateOptions+signal)
                                                   ▼
                                          ┌────────────────────┐
                                          │ 宿主 provider 凭证   │
                                          │ (插件从头到尾看不见)  │
                                          └────────────────────┘
```

测试与生产代码的对应关系：

- `test-engine-bridge.mjs` 直接 `import` `openai-bridge.js` 的 7 个导出（`test-engine-bridge.mjs` 第 18–27 行），逐函数断言，不创建服务器、不连 provider。
- `test-engine-llm-bridge.mjs` 只 `import startLlmBridge`（`test-engine-llm-bridge.mjs` 第 18 行），启动真实 `http.Server`，用 `fakeLlm` 模拟宿主 `llm`，再用 `fetch` 打真实 HTTP 请求（第 47–55 行）。它间接复用了 `openai-bridge.js` 的 `toLlmRequest` / `chunksToCompletion` / `chunksToSse`（`llm-bridge.js` 第 26–31 行 import）。
- 凭证边界是两条测试共同的核心：`openai-bridge.js` 保证 `toLlmRequest` 返回值里永远没有 `apiKey`（第 27 行注释；`test-engine-bridge.mjs` 第 348–356 行断言）；`llm-bridge.js` 保证只有本次随机生成的占位 key 能进门（第 117–126 行；`test-engine-llm-bridge.mjs` 第 68–220 行断言）。

## Data Flow

以 `test-engine-llm-bridge.mjs` 的「非流式工具调用」用例（第 114–129 行）为纵切，展示一次完整请求的端到端数据流向：

1. 测试用 `post(bridge, {...simpleBody, tools:[...]})`（`post` 见第 47–55 行）向 `http://127.0.0.1:<port>/v1/chat/completions` 发 `POST`，带 `authorization: Bearer <placeholderKey>`。
2. 服务器在 `llm-bridge.js` 第 118–126 行校验 `bearerOf` 取出的 token 既匹配 `PLACEHOLDER_KEY_PATTERN` 又等于本次 `placeholderKey`，否则 `stats.authRejected++` 返回 401。
3. `readBody` 读请求体（第 139 行），非法 JSON 直接 400（第 142–147 行）。
4. `toLlmRequest({ provider, model, reasoningEffort, body })`（第 151 行，`openai-bridge.js` 第 128–161 行）把 OpenAI 请求体翻成 DSH `GenerateOptions`：`system` 抽到 `system` 槽、`tools[].function` → `ToolSchema`、assistant 的 `tool_calls` → `tool-call` 块。缺字段在此抛错并转成 400（第 152–157 行）。
5. 由于是工具调用，`tools` 必须出现在 `llm.calls[0]` 里被转发给宿主（`test-engine-llm-bridge.mjs` 第 127 行断言 `llm.calls[0].tools.length === 1`）。
6. 服务器建 `AbortController`，`res.on('close', ...)` 监听客户端断连，`setTimeout(timeoutMs)` 兜底超时（第 163–167 行），然后把 `{ ...options, signal: ac.signal }` 喂给 `llm.stream`（`llm-bridge.js` 第 171 行）。
7. `fakeLlm` 逐 chunk `yield`（如 `tool-call-delta` 分两片 `{...'{"pa'}` 与 `{...'th":"x.py"}'}`），服务器把每块 `push` 进 `chunks`（第 169–172 行）。
8. 非流式路径下，循环结束后用 `chunksToCompletion({ id, model, chunks })`（第 216 行，`openai-bridge.js` 第 236–256 行）折叠成 OpenAI JSON；`foldChunks`（第 192–233 行）按 `index` 把 `argumentsDelta` 拼成完整 `'{"path":"x.py"}'`，只保留有 `name` 的调用。
9. 服务器 `sendJson(res, 200, completion)`（第 218 行）返回；测试断言 `call.function.arguments === '{"path":"x.py"}'`、`finish_reason === 'tool_calls'`、`llm.calls[0].tools.length === 1`（`test-engine-llm-bridge.mjs` 第 123–127 行）。
10. 若 `llm.stream` 抛错：流式已发头则写 error 帧 + `[DONE]` 后 `res.end()` 并 `finish(200)`（第 193–200 行）；非流式则 `finish(502)` + OpenAI 错误体（第 201–202 行）；`stats.failures++` 且记 `lastError`。
11. 若 `body.stream === true`：`llm-bridge.js` 第 174–187 行**边收边发** SSE（`content-type: text/event-stream`），每帧用 `chunksToSse` 生成但跳过 `[DONE]`，最后统一发 `data: [DONE]\n\n`（第 210–211 行），保证引擎的 SSE 读取不会挂住。

纯转换单测（`test-engine-bridge.mjs`）走的是上面对应的第 4 步与第 8 步的「离线」变体：它不启服务器，直接把构造好的 `body`/`chunks` 喂给 `toLlmRequest` / `chunksToCompletion` / `chunksToSse` 并断言产物形状，因此能在毫秒级覆盖 `usage` 互斥计数折算、`reasoning-delta` 排除、assistant `source` 注入等易错点。

## Connections

- [[test_engine_contract]]：`test-engine-contract.mjs` 钉死引擎结果的契约形状（`EngineResult`/`EngineProgress`/`EngineError`），本桥的 `finishReasonToOpenAI` 与 `usageToOpenAI` 折算出的 `finish_reason`/`usage` 最终要被引擎侧按此契约消费；桥和契约同属「跨进程边界必须先有可校验契约」这条主线（见 `test-engine-contract.mjs` 第 1–12 行）。
- [[engine_client]]：`lib/engine/client.js` 是 Node↔Python 的薄适配层，其文件头注释（`client.js` 第 8–11 行）明确写「不读凭证、不连模型——模型通道由 llm-bridge.js 单独提供」；`client.js` 跑引擎，`llm-bridge.js` 跑模型，二者被 `native-run.js` 编排在同一轮编译里。
- [[native_run]]：`lib/engine/native-run.js` 是桥的生产消费者。`runNativeJob` 在第 233–259 行用 `bridgeImpl({ llm, provider, model, ... })` 建桥（provider/model 来自 `cfg.batchProvider`/`cfg.batchModel`），把桥句柄传给引擎（`engineFor({ requestId, bridge })`，第 265–267 行），并在 `finally` 里 `bridge?.close?.()`（第 289–292 行，注释强调「先关桥会让还在读流的引擎拿到 502」）。它 `import startLlmBridge as realBridge`（第 31 行）且 `deps.bridge` 可注入，测试可换假桥。
- [[openai_bridge]] / [[llm_bridge]]：本模块测试的两份生产实现分别对应 `lib/engine/openai-bridge.js`（纯转换）与 `lib/engine/llm-bridge.js`（loopback 服务器），本文不重复其实现细节，详见各自的模块文章。
- [[engine_manifest]] / [[quality_gate]] / [[apply_plan]]：与 `native-run.js` 同属一次原生编译的「环境→引擎→质量门→落地器」裁决链（`native-run.js` 第 9 行），桥是其中「模型通道」这一环。

## Known Issues

- **`messageToDsh` 的 `source` 缺省即丢 assistant 消息风险**：`openai-bridge.js` 第 103–105 行，仅当 `route.provider && route.model` 都为真才填 `source`，否则 `source = null`；第 106–110 行把 `{ source }` 用 `...(source ? { source } : {})` 展开。若桥将来被误配成缺 provider/model（理论上 `toLlmRequest` 第 129–130 行已先抛错拦截），assistant 消息会缺失 `source` 而触发宿主 `forAdapter` 的 `replayState` 崩溃。该崩溃无法被纯单测抓到，仅 1C 真实模型跑一次工具往返才会暴露（见 `test-engine-bridge.mjs` 第 358–366 行注释）。
- **流式与非流式路径分叉隐患已被刻意规避但脆弱**：`openai-bridge.js` 第 23–24 行注释强调两条路径共用 `foldChunks` 同源逻辑，`chunksToSse` 第 311–314 行在流未给 `finish` 时也会补终帧。测试只覆盖了典型输入；若上游 never yields finish，第 311 行补帧逻辑依赖 `sawToolCall` 标记，未显式断言「无 finish + 无内容」的兜底帧（仅 `chunksToCompletion` 第 238–243 行覆盖了空流非流式场景）。
- **`sseFrame` 不校验 payload 大小**：`openai-bridge.js` 第 259–262 行直接 `JSON.stringify` 后拼接，超大 chunk（如超长 `argumentsDelta`）不会在桥层被截断；桥层 `readBody` 的 32MB 上限（第 34 行）只管入站请求，不管出站 SSE 单帧。
- **超时/断连 abort 后 chunk 可能仍被 `chunksToCompletion` 折叠**：`llm-bridge.js` 第 170–172 行把已 yield 的 chunk 持续 `push` 进 `chunks`；若 `signal` abort 发生在生成中途，非流式分支仍会在第 216 行用「已收集到的半截 chunks」调 `chunksToCompletion`。非流式下 abort 走第 201–202 行 502 分支，故真正可见的半截折叠仅发生于「yield 出部分 chunk 后、循环被 `res.on('close')` 之外的异常打断」等边缘情况——测试用 `fakeLlm` 的逐步 `yield` + 中途 `throw` 覆盖了流式错误帧（第 151–163 行），但未覆盖非流式「部分 chunk 后抛错」的折叠产物。
