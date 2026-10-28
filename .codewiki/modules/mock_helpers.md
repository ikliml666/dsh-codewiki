---
title: mock_helpers
type: module
source_files:
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
  - test-orchestration.mjs
  - test-engine-client.mjs
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - test-cluster.mjs
  - test-fixtures/fake-native-engine.mjs
tags: [test, mock, fake, fixture, llm-proxy, agent]
---

## Overview

`mock_helpers` 不是一个独立的源文件，而是散布在仓库测试层的一组**离线测试替身（mock / fake / fixture）**的家庭聚合文档。它们共同的服务目标是：让 `lib/` 下的生产模块在**不连真实 LLM、不 spawn 真实引擎、不碰真实 git 仓库**的前提下被单元测试覆盖。

这个"模块"按职责分成四族替身：

- **Mock agents / 工具上下文**：`test-agentic.mjs` 的 `makeWorkspace`、`scripted`、`assistant`/`call`/`text`，以及 `test-articles-agentic.mjs` 的 `makeTmp`/`scripted`/`alwaysDispatch`。它们伪造 agentic 工具循环依赖的 `{ readFile, listDir }` workspace 与按脚本返回的 `streamFn`（假模型）。
- **Mock LLM 代理 / 流**：`test-agentic-host.mjs` 与 `test-engine-llm-bridge.mjs` 的 `fakeLlm`，以及 `test-orchestration.mjs` 的 `llmProxy` + `makeBatchMock`。前者按脚本吐 chunk，后者按 prompt 特征应答单轮文章，并以一个转发器 `llmProxy` 统一"当前生效的假 llm"。
- **Mock 宿主上下文 / 请求响应**：`test-orchestration.mjs` 的 `makeCtx`、`makeMockAgent`、`fakeReq`、`fakeRes`。它们伪造 cordis 宿主的 `inject`/`on`/`effect` 切片与 HTTP 请求/响应对象。
- **Fake 引擎与请求响应构造器**：`test-fixtures/fake-native-engine.mjs`（独立进程）、`test-engine-client.mjs` 的 `fakePy`/`fakeEngine`/`pyEngine`/`line`，以及 `test-cluster.mjs` 的 `makeComponents` 组件集构造器。

为什么没有抽出单一 `mock_helpers.js`：这些替身与各自测试文件强耦合（脚本内容即断言契约），抽出反而会让断言与替身分离、脆化。本文把它们按职责归类，给出每个函数的文件、行号、签名与用途，供未来 agent 在写新测试时直接复用或照抄。

## Key Components

### 1. Mock agents / 工具上下文（test-agentic.mjs）

`makeWorkspace(over = {})` — `test-agentic.mjs:29`
: 基于内存对象 `FILES`（`test-agentic.mjs:24`）造一个假 workspace，暴露 `readFile(rel)` 与 `listDir(rel)`。缺文件 `readFile` 抛 `ENOENT`；`listDir` 按 `rel` 前缀聚合出 `{ path, dir }` 列表。`...over` 可覆盖任一方法（如注入抛错 `async readFile() { throw new Error('disk on fire') }`，见 `test-agentic.mjs:32`）。

`assistant(blocks)` / `call(id, name, args)` / `text(t)` — `test-agentic.mjs:55-59`
: 三个纯构造器。`assistant` 包成 `{ role: 'assistant', content: blocks }`；`call` 造一个 `{ type: 'tool-call', id, name, arguments }`（参数对象序列化成 JSON 串）；`text` 造 `{ type: 'text', text }`。

`scripted(responses)` — `test-agentic.mjs:62`
: 返回一个 `{ fn, seen }`。`fn({ messages, tools })` 按数组 `responses` 顺序逐次返回 `{ blocks }`，超界后回 `{ blocks: [text('done')] }`；`seen` 记录每轮 `{ messageCount, toolNames }`，供断言"第二轮是否带上 tool-result"。是 agentic 循环离线测试的假模型入口。

`makeTmp()` / `call` / `text` / `scripted` / `alwaysDispatch` / `scanArticleDepths` — `test-articles-agentic.mjs:23-180`
: `makeTmp()`（`test-articles-agentic.mjs:23`）用 `fs.mkdtempSync` 建临时目录并写 `src/cart.js`、`src/order.js`。`call`/`text` 与 agentic 版同形（`test-articles-agentic.mjs:31-34`）。`scripted`（`:37`）与 agentic 版同形但每轮额外带 `finish: { kind: 'stop' }`。`alwaysDispatch(counter)`（`:167`）每次调用都"写一句正文 + 派生子模块"，用于 `subDepth` 封顶回归。`scanArticleDepths(root)`（`:151`）遍历磁盘统计 `.md` 相对目录层数。

### 2. Mock LLM 代理 / 流

`fakeLlm(script)` — `test-engine-llm-bridge.mjs:28`
: 造一个带 `calls` 数组的假宿主 llm：`stream(options)` 把 `options` 压入 `calls` 并按 `script(options)` 异步产出 chunk（生成器）。用于测 `startLlmBridge` 的边界（401/502/SSE/abort/超时），不碰任何真实 provider、不含密钥。

`fakeLlm(chunkScripts)` — `test-agentic-host.mjs:67`
: 与上面的同名但形态不同：按 `chunkScripts` 数组依次吐 chunk，`lastReq` 记录最后一次请求；支持 `req.__capture` 钩子。用于测 `makeHostStream` 把 chunk 收成 blocks 的适配层。

`llmProxy` + `activeLlm` + `makeBatchMock(...)` — `test-orchestration.mjs:133-227`
: `llmProxy`（`:133`）是一个**转发器**：`stream`/`listModels`/`resolveModel` 全部转发给 `activeLlm`，未接线时抛"测试未接线"。`activeLlm` 模块级变量（`:132`）。`makeBatchMock`（`test-orchestration.mjs:145`）按 prompt 首行特征分发应答（`answerFor`，`:147`），覆盖"文章观察员/作者/架构观察员/审校员"等模板关键词，造出带 frontmatter 的文章；其 `stream`（`:198`）按宿主 block 协议吐 `block-start`/`text-delta`/`usage`/`finish`；支持 `stall`（挂起等 abort）、`bigArticle`（补 7 万字符）。返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`，`restore`（`:225`）恢复上一个生效的假 llm（块间嵌套）。

`articleMd(...)` — `test-orchestration.mjs:33`
: 纯函数，拼一篇带 frontmatter 的假文章：`---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\n${marker} article.\n`。`answerFor` 用它造出契合 `article-contract` 闸门（type 与目录一致）的 fixture。

### 3. Mock 宿主上下文 / 请求响应（test-orchestration.mjs）

`makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — `test-orchestration.mjs:51`
: 伪造 cordis 宿主上下文。内部 `services` 提供 `webServer`/`agents`/`tools`/`llm`/`workspaceRegistry`；`ctx` 实现 `inject(deps, fn)`（带回调时按 deps 名建切片传给 fn，promise 形式则逐名 resolve）、`on(event, fn)`（收集 listeners）、`effect(fn)`（立即执行，返回函数为 disposer）。`brokenRegistry`（`:64`）让 `workspaceRegistry.list()` 抛错，复现宿主 0.4.9c jobs/repos 400。`workspaces`（`:62`）注入已挂载路径清单。返回 `{ ctx, registered, endpoints, listeners, disposers }`。

`makeMockAgent(cwd)` — `test-orchestration.mjs:94`
: 伪造一个 agent：`session.header.cwd` + `ctx.inject` 返回带 `systemPrompt.getSectionOrder`/`section` 的切片，收集注册到的 `sections`。用于测"wiki 维护提醒"section 注册。

`fakeReq(body, addr, method)` / `fakeRes()` — `test-orchestration.mjs:245-257`
: 伪造 HTTP `req`/`res`。`fakeReq` 的 `on('data'|'end')` 同步回放 `JSON.stringify(body)`；`fakeRes` 实现 `writeHead(c)` / `end(b)` 并记录 `code`/`out`。用于直接驱动工具的 `execute({ cwd, args })` 之外的 HTTP 入口路径。

### 4. Fake 引擎与请求响应构造器

`test-fixtures/fake-native-engine.mjs`（独立进程，208 行）
: 生产接线测试的"假引擎"：只实现协议与产物，不实现算法。行为由 `FAKE_ENGINE_MODE` 环境变量（或同级模式文件、仓库名 `__mode__` 段）控制（`modeOf`，`test-fixtures/fake-native-engine.mjs:31`），模式含 `done/partial/fail/crash/stall/bad-yaml/empty-docs/doctor` 等。`realSourceFiles`（`:68`）真实扫仓库避免 `source-missing`；`writeDocs`（`:87`）写出纯 markdown（不带 frontmatter）以匹配 `article-contract`。通过 stdin 读一行 JSON、stdout 写 JSON-lines。

`fakePy` / `fakeEngine(mode, extra)` / `pyEngine(mode)` / `line(obj)` — `test-engine-client.mjs:35,159-241`
: `line(obj)`（`:35`）把对象序列化成 `"<json>\n"`。`fakePy`（`:159`）是个 Python 脚本字符串，按 `FAKE_MODE` 环境变量吐含故意破坏的协议（`ok/garbage/noresult/failed-but-exit0/done-but-exit3/crash/slow/late/wrongid`）。`pyEngine(mode)`（`:237`）返回 `{ command, args:[fakePy], env:{FAKE_MODE:mode} }`。`fakeEngine(mode, extra)`（`:220`）用 node 包装 `spawn` 以在 Windows 上可控地注入 `FAKE_MODE`（透过 `FSOFT_TEST_PY` 选 python 解释器）。

`makeComponents()` — `test-cluster.mjs:25`
: 造一个"像真仓库"的组件集：`src/auth/login.js`、`src/auth/token.js`、`src/wiki/compile.js`、`src/panel/ui.js` 各若干函数，加 `package.json`/`README.md` 两个 artifact，及一个 70 组件的 `src/big/engine.js`（触发下钻）。每个组件形如 `{ id, name, kind, relativePath, parameters, sourceCode, dependsOn }`。用于 LLM 聚类测试，配注入的 `completer` 假模型。

## Architecture

四族替身各自服务于 `lib/` 的一个生产面，统一通过"注入而非直连"接入。下表给出组件→生产目标→接入点的映射（≤20 行）。

```text
┌─────────────────────── test-agentic.mjs ───────────────────────┐
│ makeWorkspace (假 readFile/listDir)      ──► lib/agentic.js      │
│ scripted / assistant / call / text (假  ──► runAgenticArticle    │
│   streamFn 模型 + tool-call 构造器)         (工具循环纯逻辑)       │
└────────────────────────────────────────────────────────────────┘
        │ 复用同类替身
┌────────────────── test-articles-agentic.mjs ────────────────────┐
│ makeTmp / scripted / alwaysDispatch  ──► lib/articles-agentic.js │
│   (多文章池 + 子模块递归派发)            (runOneArticle/Pool)     │
└────────────────────────────────────────────────────────────────┘

  lib/agentic-host.js               lib/engine/openai-bridge.js
  ▲ toRequestMessages                ▲ toLlmRequest / chunksToSse
  │ makeHostStream                    │ chunksToCompletion
  │                                   │
 fakeLlm (test-agentic-host:67)   fakeLlm (test-engine-llm-bridge:28)
  ▲                                   ▲
  │ chunk 脚本                          │ chunk 脚本
 makeHostStream 适配层                startLlmBridge 桥 (127.0.0.1 + 占位 key)

┌──────────────── test-orchestration.mjs ────────────────────────┐
│ makeCtx (假 inject/on/effect)  ──► index.js apply(ctx, cfg)      │
│ makeMockAgent / fakeReq / fakeRes ──► 工具 execute / HTTP 入口    │
│ llmProxy + makeBatchMock (假 llm) ──► 宿主 llm 服务 (唯一模型通道)│
└────────────────────────────────────────────────────────────────┘

  test-engine-client.mjs            test-fixtures/fake-native-engine.mjs
  ▲ fakePy / pyEngine / fakeEngine  ▲ 独立进程：FAKE_ENGINE_MODE
  │ 协议破坏 + 进程层                 │ 真 spawn 走 client.js 全真实路径
  └──────────► lib/engine/client.js (createProtocolReader/runEngine)
```

## Data Flow

以"agentic 离线写作"与"引擎接线"两条链路说明替身如何注入：

1. **agentic 离线链**：测试构造 `makeWorkspace()` 得到假 workspace → 连同 `scripted(responses)` 返回的 `streamFn` 一并传给 `runAgenticArticle`（`test-agentic.mjs:62`）。循环每轮调 `streamFn`，模型用 `call()` 发 tool-call，工具实现（来自 `buildToolset` + `makeReadCodeTool` 等）对假 workspace 操作，结果以 `tool` 消息回灌。`scripted` 的 `seen` 用于断言回灌是否发生。

2. **host stream 适配链**：`makeHostStream({ llm: fakeLlm(...) })` 把宿主 chunk 流收成 `{ blocks }`（`test-agentic-host.mjs:79`），再交给同一个 `runAgenticArticle`。`toRequestMessages` 负裸消息 ↔ 宿主正式 Message 转换。

3. **桥转换链**：`startLlmBridge({ llm: fakeLlm(...) })` 起 127.0.0.1 随机端口 → 引擎侧拿 URL + 占位 key → 发 OpenAI 请求 → `toLlmRequest` 转成宿主 `GenerateOptions` → `fakeLlm.stream` 吐 chunk → `chunksToCompletion`/`chunksToSse` 翻回 OpenAI 响应。全程不接触真实密钥。

4. **编排接线链**：`makeBatchMock()` 把 `activeLlm` 指向按 prompt 特征应答的假 llm；`makeCtx` 造出 `ctx` 切片交给 `apply(ctx, cfg)`，插件注册工具；`fakeReq/fakeRes` 可直接驱动 HTTP 入口。

5. **引擎接线链**：`runEngine({ engine: pyEngine(mode) })` 真 spawn node/python，读 fake-native-engine 的 stdout JSON-lines；`createProtocolReader` 解析 progress/result 并记 `violations`（未知 requestId、半行 JSON、late-result 等）。假引擎用 FAKE_ENGINE_MODE 一次只做一件事，便于逐条断言接线而非算法。

## Connections

- [[agentic]] — `lib/agentic.js` 的生产工具循环，被 `test-agentic.mjs` 的 `makeWorkspace`/`scripted` 离线驱动。
- [[articles-agentic]] — `lib/articles-agentic.js` 的多文池与子模块递归派发，被 `test-articles-agentic.mjs` 的 `makeTmp`/`scripted`/`alwaysDispatch` 驱动。
- [[agentic-host]] — `lib/agentic-host.js` 适配层，被 `test-agentic-host.mjs` 的 `fakeLlm`/`toRequestMessages` 测试。
- [[engine-llm-bridge]] — `lib/engine/llm-bridge.js`（与 `openai-bridge.js`）的转换契约，被 `test-engine-llm-bridge.mjs` 的 `fakeLlm` 与 `test-engine-bridge.mjs` 的 `chunksToCompletion`/`chunksToSse` 驱动。
- [[engine-client]] — `lib/engine/client.js` 协议/进程层，被 `test-engine-client.mjs` 的 `fakePy`/`pyEngine`/`line` 与 `test-fixtures/fake-native-engine.mjs` 驱动。
- [[orchestration]] — `index.js` 的 `apply`/服务阶段机，被 `test-orchestration.mjs` 的 `makeCtx`/`makeBatchMock`/`makeMockAgent` 驱动。
- [[cluster]] — `lib/cluster.js` 的 LLM 聚类，被 `test-cluster.mjs` 的 `makeComponents` + 注入 `completer` 驱动。
- [[incremental]]、[[quality-gate]]、[[output]] — 由 `test-fixtures/fake-native-engine.mjs` 写出契合 `article-contract` 的假产物后做端到端校验。

## Known Issues

- **替身与测试文件强耦合**：没有统一 `mock_helpers.js`，每个测试文件都自带一份 `call`/`text`/`scripted` 构造器（agentic 与 articles-agentic 两套同名但手写重复）。新增测试时通常照抄，存在语义漂移风险（如 `scripted` 在 `test-articles-agentic.mjs:37` 额外带 `finish`，而 `test-agentic.mjs:62` 不带）。
- **`test-orchestration.mjs` 的 `makeBatchMock` 用 prompt 首行字符串特征路由**（`test-orchestration.mjs:145-191`），与真实 prompt 模板强绑定。若 `lib/` 侧 prompt 文案微调（如"你是 CodeWiki 文章作者"改措辞），假 llm 会落入默认分支返回 `---\ntitle: unknown`，导致编排断言集体失败——这类失败不是功能坏了，而是 fixture 关键词失配。
- **`fake-native-engine.mjs` 的 `realSourceFiles` 依赖真实仓库**（`:68`）：当被测仓库没有 `.py/.ts/.js/.mjs/.go/.rs/.java` 文件时，`core`/`web` 为空，质量门会判 `source-missing` 而永远 `partial`——它是刻意让夹具"只含真实存在的文件"，但要求测试仓库必须带源码。
- **`fakeLlm` 在两个文件里同名形态不同**：`test-engine-llm-bridge.mjs:28` 的版本记录 `calls` 并 `yield` 自 `script(options)` 生成器；`test-agentic-host.mjs:71` 的版本按 `chunkScripts` 数组吐 chunk 且支持 `req.__capture`。复用时要确认是哪个。
