---
title: orchestration_core
type: module
source_files:
  - lib/engine/client.js
  - test-orchestration.mjs
  - test-engine-client.mjs
  - lib/engine/contract.js
tags: [orchestration, test-helpers, client-factory, protocol, integration-test, mock, batch-mock]
---

## Overview

`orchestration_core` 把**引擎客户端工厂**与**核心编排集成测试辅助**放在同一视野下：一端是生产代码里唯一的跨语言客户端 `lib/engine/client.js`（薄适配层，起受管子进程、读 JSON-lines、归一成 `EngineResult`），另一端是守护「服务化编排」行为的测试套件 `test-orchestration.mjs` 的辅助函数集（mock 宿主 ctx、假 llm 服务、fixture 仓库、job 轮询、`fakeReq`/`fakeRes`），以及专门钉协议破坏的 `test-engine-client.mjs`。

两半的关系：客户端工厂 `runEngine`/`createProtocolReader`（`client.js`）是 `test-engine-client.mjs` 的**直接被测对象**（真 spawn 假 python 引擎）；而在 `test-orchestration.mjs` 里，编排链路（`codewiki_generate.execute` → `JobService` tick → 阶段机 → `client.js` 或旧通道 llm）被**整条拉起**，所以 `client.js` 在这里是「被集成调用」而非「被单测」。`test-orchestration.mjs` 的辅助函数正是让这条链路能在零真实模型、零真实宿主下可重复跑起来的关键。

深度协议不变量（stdout 只应是 JSON-lines、requestId 隔离、取消后 late-result、退出码只表达进程层等）已由 [[engine_client_protocol]] 完整钉死，本文只在「Client factory」小节给出符号级清单并链接过去，避免重复。

## Key Components

### 1. `lib/engine/client.js` — 客户端工厂（协议读取器 + 进程适配）

跨语言薄适配层，唯一 `spawn` 调用点（22、288 行）。协议不变量见 `client.js` 13–20 行注释与 [[engine_client_protocol]]。

**常量**

| 符号 | 行号 | 用途 |
|---|---|---|
| `ENGINE_PROTOCOL_VERSION` | 27 | 协议版本（独立于结果契约版本），当前 `1`；`hello` 消息的 `protocolVersion` 与之不符只记 `protocol-version` 违规（76–78 行）。 |
| `DEFAULT_MAX_LINE_BYTES` | 29 | 单行上限 `4*1024*1024`，防引擎失控吐超长行吃内存。 |
| `DEFAULT_STDERR_TAIL` | 30 | stderr 尾部保留上限 4000 字符。 |

**公开函数**

| 函数 | 行号 | 用途 |
|---|---|---|
| `createProtocolReader(options={})` | 39–186 | 增量式 JSON-lines 读取器（纯逻辑、不碰进程，可逐字节喂）。构造时校验 `requestId`（40–41）。返回对象见下。 |
| `spawnPlan(engine, cwd, env)` | 189–199 | 把引擎命令描述规范成 spawn 参数：要求 `engine.command` 非空（191–192），合并 `process.env` + `engine.env` + `env`（197）。 |
| `tail(text, max)` | 201–204 | 截断尾部文本（默认 4000 字符），超长加 `…` 前缀。 |
| `runEngine(options={})` | 223–422 | 跑一次引擎动作并归一成 `EngineResult`。详见 [[engine_client_protocol]] 的 Data Flow；失败时映射 `engine-missing`/`engine-timeout`/`engine-crashed`/`engine-protocol`（283、297、365、368–374、405–413）。 |
| `default` export | 424 | `{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`。 |

`createProtocolReader` 返回对象（`client.js` 128–185）：

- `push(chunk)`（133–156）：喂一段 stdout（Buffer 或 string），按字节缓冲（多字节 UTF-8 跨 chunk 不切坏），按 `\n` 切行；单行超 `maxLineBytes` 记 `line-too-long` 并跳过（143–146）；无换行的残留超上限也丢弃（151–154）。返回本次新解析出的 progress 快照数组（148 行）。
- `get progress`（159–161）：只读取已解析的进度快照。
- `markCancelled()`（164–166）：声明进入取消态，此后到达的 result 一律记 `late-result`。
- `end()`（169–184）：收尾（幂等）。把残留半行当 `not-json` 违规（170–172）。返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`。

`runEngine` 由 `finish()`（253–272）幂等拼装最终对象：展开一份 `EngineResult` 后附加 `contractVersion` / `requestId` / `action` / `protocolViolations` / `exitCode` / `exitSignal` / `terminated` / `stderrTail`（截断 4000）/ `durationMs` / `startedAt` / `finishedAt`。

### 2. `test-orchestration.mjs` — 核心编排测试辅助

文件级测试加速与隔离（1–24 行）：`DSH_CODEWIKI_TICK_MS='300'`（15 行，压到生产默认 10s 的下限）；`TEST_JOB_TOKEN`（22 行，4 字节随机 hex）拼进 `DSH_CODEWIKI_JOBS_FILE`（23 行），避免 pid 复用读入历史 fixture 任务让「单项目串行」误判（19–21 行注释）；`name/apply/SESSIONS_DIR` 来自 `./index.js`（24 行）。

**顶层断言与配置基线**

| 符号 | 行号 | 用途 |
|---|---|---|
| `failures` | 26 | 失败累加器；末尾 `process.exit(failures ? 1 : 0)`（1551 行）。 |
| `check(cond, msg)` | 27–30 | 断言：`cond` 真打 `✓`，否则 `failures += 1` 打 `✗`。 |
| `JOBS_FILE` | 32 | 来自 `process.env.DSH_CODEWIKI_JOBS_FILE`。 |
| `articleMd(title, source, marker, type)` | 33–34 | 按 frontmatter 模板拼一份 markdown（默认 `type='module'`、`marker='Batch-written'`），供 llm 桩按目标位置回写。 |
| `LEGACY_CHANNEL` | 44 | `{ planMode:'dirs', agenticArticles:false, symbolIncremental:false }`——显式关掉 0.13.0 三档新通道，让本套测试继续守旧通道请求次数/装填/落盘时序。 |
| `batchCfg(extra)` | 45 | 基线配置 `{ batchProvider:'workbuddy', batchModel:'hy3', ...LEGACY_CHANNEL, ...extra }`。 |

**mock 宿主与生产 ctx（核心辅助）**

| 函数 | 行号 | 用途 |
|---|---|---|
| `makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})` | 51–91 | mock 宿主 ctx：`inject(deps, fn)` 按 cordis 两种风格（带回调传 ctx 切片 / promise，69–79 行）；`on(event, fn)` 收集监听（80 行）；`effect(fn)` 立即执行 body 并收集返回函数为 disposer（84–88 行）；`services` 含 `webServer.register` / `agents` / `tools.register` / `llm`（默认 `llmProxy`）。可选 `workspaces`（注入 `workspaceRegistry`，62–63 行）或 `brokenRegistry`（list 抛错，64–67 行）。返回 `{ ctx, registered, endpoints, listeners, disposers }`。 |
| `makeMockAgent(cwd)` | 94–108 | 真实 cordis 语义 mock：`agent.session.header.cwd` + `agent.ctx.inject` 提供 `systemPrompt.getSectionOrder/section`，用于 systemPrompt section 注册测试。返回 `{ agent, sections }`。 |
| `makeFixtureRepo()` | 110–127 | 造带 git 与 `.codewiki` 不入的临时仓库：`core/`、`util/` 两顶层目录（112–117 行，决定 0.10.7 后的 localPlan 模块清单）；`git init` + 配 `user.name/user.email`（120–123 行，0.10.9 自动提交需要）；首提交。 |
| `llmProxy` + `activeLlm` | 132–140 | `activeLlm` 是「当前生效的假 llm」；`llmProxy` 的 `stream/listModels/resolveModel` 全部转发给它。`makeBatchMock()` 只需换 `activeLlm` 一处接线（129–131 行注释）。 |
| `promptOf(opts)` | 141 | 取 `opts.messages[0].content[0].text` 首行 prompt，用于按特征分发应答。 |

**假 llm 服务（按 prompt 特征分发）**

`makeBatchMock({ modules=['core','util'], articleMarker='Batch-written', stall=false, bigArticle=false })`（145–227）：返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`。

- `answerFor(prompt)`（147–195）：按 prompt 首行特征分发 ——「文章观察员」回观察文本（148–151）、「文章作者」按 `modules/([a-z0-9-]+).md` 或 stale 任务名 `更新过期文章\s+(\S+?)` 造对应 `articleMd`（152–173）、「架构观察员」/「写系统总览」/「总结模式」/「写跨模块概念」/「审校员」各自回格式（174–193）。
- `llm.stream(opts)`（197–216）：yield `block-start` →（stall 时挂起直到 `opts.signal` abort，202–209 行）→ `text-delta`（`bigArticle` 时追加 `长` ×70000，211 行）→ `usage` → `finish`。每次调用把 `{provider, model, reasoningEffort, prompt, signal}` 推入 `llmCalls`（200 行）。
- `restore()`（225 行）：恢复上一个 `activeLlm`，用于块间嵌套。

**轮询与 HTTP 桩**

| 函数 | 行号 | 用途 |
|---|---|---|
| `waitJob(cwd, {timeout=30000})` | 230–243 | 轮询 `JOBS_FILE` 直到该 cwd 最新 job 到终态（`done/failed/cancelled`，239 行）；文件尚未落盘时静默重试。 |
| `fakeReq(body, addr='127.0.0.1', method='POST')` | 245–254 | 假 HTTP 请求：`socket.remoteAddress=addr`，`on('data')` 推 JSON、`on('end')` 触发。 |
| `fakeRes()` | 255–257 | 假 HTTP 响应：`writeHead(c)` 记 `code`、`end(b)` 记 `out`；通过 `JSON.parse(res.out)` 读端点返回。 |

**被本测试直接 import 并用例化的生产函数**（定义于 `./index.js`，非本文件导出，列于此以说明测试覆盖面，详见其所在模块）：

- `commitHintText(repo, jobs)` — 由 `codewiki_update` 提交提醒 section 调用，按「编译完成时间 vs 最近 `.codewiki` 提交时间」决定注入「产物待提交」提醒（import 于 322 行，用例 337–428 行）。
- `autoCommitWiki(repo, {jobId, writtenCount})` — 插件自动提交编译产物（分支合并式/直降降级，0.10.11），用例 430–531 行守安全边界（非 git/被 gitignore/merge 进行中/缺 identity/detached/分支名被占用）。
- `autoCommitState(job)` — 三态判定（`committed`/`no-changes`/`pending`），唤醒与提醒共用（import 536 行，用例 533–543 行）。
- `wakeCompileSession(job, stage, agentsRef)` — 编译终态 steer 唤醒（import 548 行，用例 545–581 行）：`autoCommit` 成功/无改动→零唤醒，`pending`→降级提醒一次，失败/冷会话/异常→静默。
- `name` / `apply` / `SESSIONS_DIR` — 来自 `./index.js`（24 行），`apply(ctx, cfg)` 是注册 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` 工具与面板端点的入口（296、597、626、816 等行）。

### 3. `test-engine-client.mjs` — client.js 的协议/进程层测试

优先钉「协议破坏时会发生什么」而非正常路径（1–16 行注释）。`check(label, fn)`（29–32）用 `assert` 累加 `pass`/`fails`，与 `test-orchestration.mjs` 的 `check` 风格不同（后者自计数）。

**假引擎与驱动（进程层）**

| 符号 | 行号 | 用途 |
|---|---|---|
| `fakePy` | 158–218 | 真 Python 假引擎脚本（`writeFileSync` 写出）：按 `FAKE_MODE` 环境变量吐不同协议——`ok`/`garbage`/`noresult`/`failed-but-exit0`/`done-but-exit3`/`crash`/`slow`/`late`/`wrongid`（185–217 行）。 |
| `fakeEngine(mode, extra)` | 220–233 | node 包装层，用于在 Windows 上可控地设 `FAKE_MODE` 后 spawn `fakePy`。 |
| `pyEngine(mode)` | 237–241 | 直接 `{ command: 'python', args:[fakePy], env:{FAKE_MODE:mode} }`，交给 `runEngine` 真 spawn。 |

**测试分组**

- 协议层（纯函数，不 spawn，39–154 行）：正常序列解析、`not-json` 半行、未知 requestId 隔离、缺 requestId、重复 result 先到赢、`bad-shape`、cancel 后 late-result、CRLF/空行、多字节 UTF-8 跨 chunk、超大单行、未登记协议版本。
- 进程层（真 spawn，243–360 行）：正常返回、`garbage` 仍可取结果但带违规、缺 result→`engine-protocol`、退出码 0 但语义 failed→以语义为准、语义 done 但退出码 3→保留并记 `nonzero-exit`、崩溃→`engine-crashed` 带 stderr、未知 requestId、超时→`engine-timeout` 且终止进程树、取消→`cancelled` 且 late result 不覆盖、同 client 连跑不串结果、引擎命令不存在→`engine-missing`、cwd 含中文空格跑通。

## Architecture

```text
┌──────────────────────────┐         ┌────────────────────────┐
│ test-orchestration.mjs    │         │ test-engine-client.mjs  │
│ makeCtx/makeBatchMock/    │         │ fake_engine.py +       │
│ makeFixtureRepo/waitJob/  │         │ pyEngine/fakeEngine    │
│ fakeReq/fakeRes           │         │                        │
└───────────┬──────────────┘         └───────────┬────────────┘
            │ apply(ctx,cfg)+execute              │ 直调
            │ → JobService tick(300ms)            ▼
            │                                     createProtocolReader()
            ▼                                     runEngine({engine:pyEngine})
┌──────────────────────────┐
│ lib/engine/client.js      │◄── spawn(python fake_engine.py)
│ createProtocolReader()    │──► engineResult/Progress/Error
│ runEngine()               │    (lib/engine/contract.js)
└───────────┬──────────────┘
            │ llmProxy→activeLlm（makeBatchMock 接线）
            ▼
┌──────────────────────────┐
│ 假宿主 llm 服务            │
│ 按 prompt 首行特征分发应答  │
└──────────────────────────┘
```

- `test-orchestration.mjs` 走**集成**路径：`makeCtx` 造 ctx → `apply(ctx, batchCfg())` 注册工具（296 行）→ `gen.execute` 提交 job 到真实 `JobService` → tick 推进阶段机 → 旧通道经 `llmProxy` 调 `activeLlm`，原生通道经 `client.js` 的 `runEngine` spawn python。`waitJob` 轮询 `JOBS_FILE` 等终态。
- `test-engine-client.mjs` 走**单测**路径：直接 `createProtocolReader`/`runEngine`，配 `pyEngine('...')` 真 spawn `fake_engine.py`，零 JobService、零 llm。
- 两测试都消费 `client.js`，但前者测「编排接线下的客户端行为」，后者测「协议边界破坏时的客户端行为」——分工见 [[engine_client_protocol]]。

## Data Flow

**集成路径（test-orchestration.mjs）**

1. 加速与隔离（15、22–23 行）：tick 300ms、`JOBS_FILE` 加随机 token，与真实宿主实例隔离。
2. `makeCtx` 造 ctx（51–91 行）+ `apply(ctx, batchCfg())` 注册 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` 与 `/api/codewiki/jobs|control|repos|sessions` 端点（296 行）。
3. `makeBatchMock()` 把 `activeLlm` 换成按 prompt 特征应答的假 llm（145–227 行）；`gen.execute({cwd}, {agent})` 提交 job 后即返回（`submitted:true` + `jobId`，647–651 行）。
4. 真实 `JobService` 按 300ms tick 推进阶段机（articles→crosscut→review→index，0.10.7 起无规划阶段）；旧通道请求经 `llmProxy`→`activeLlm.stream` 按 `workbuddy/hy3` 发出（604–607 行断言不沿用会话主模型）。
5. `waitJob(cwd)` 轮询 `JOBS_FILE`（230–243 行），等 job `stage` 到 `done/failed/cancelled` 后做落盘/内容/自动提交断言。

**单测路径（test-engine-client.mjs）**

直接 `runEngine({engine:pyEngine(mode), requestId, action, timeoutMs})`：进程层 `Promise.race([exited, timeout, abort, spawnError])`（对应 `client.js` 311–359 行），`fake_engine.py` 按 `FAKE_MODE` 吐协议，`createProtocolReader.push` 逐行解析，断言 `outcome`/`protocolViolations`/`exitCode`/`terminated` 等。协议层用例则只 `createProtocolReader` + `push` + `end`，不 spawn（39–154 行）。

## Connections

本模块横跨生产客户端与两套测试，相关模块：

- [[engine_client_protocol]] —— `lib/engine/client.js` 的协议不变量、失败码映射、进程树终止、`contract.js` 数据结构的**完整**深度说明；本文的「Client factory」小节是其符号级索引，详细行为请回看该文。
- [[test_engine_native]] —— 另一套生产接线测试（`test-engine-native-job.mjs` + `fake-native-engine.mjs`），同样走 `client.js` 的 `runEngine` 真 spawn 但聚焦原生通道 + 质量门裁决；与本文编排测试互补（一个盯原生接线、一个盯服务阶段机与面板/取消/重启恢复）。
- [[engine_apply]] / [[engine_runtime]] —— `runNativeJob` 等生产编排器，是 `client.js` `runEngine` 的真实消费方（经 `native-run.js` 的 `import { runEngine }`）。
- `lib/engine/contract.js`（见 [[engine_client_protocol]]）—— `client.js` 的 `engineResult`/`engineProgress`/`engineError` 来源，本模块 `source_files` 已列入。

## Known Issues

- **与 `engine_client_protocol.md` 存在功能重叠**：该文已完整覆盖 `lib/engine/client.js` + `lib/engine/contract.js` + `lib/engine/process-tree.js` + `test-engine-client.mjs` 的协议细节。本文刻意把 client 部分收敛为「符号清单 + 链接」，主要价值在 `test-orchestration.mjs` 的**测试辅助函数**本身（mock ctx / 假 llm / fixture / 轮询 / HTTP 桩），那部分是现有模块未覆盖的。
- **`test-orchestration.mjs` 依赖共享可变全局状态**：`activeLlm`（132 行）与 `main` ctx（294 行）是模块级单例，`makeBatchMock` 在块间用 `restore()` 还原、切换 ctx 后用 `apply(main.ctx, mainConfig)` 复位（639 行），否则会污染后续用例的 llm 调用计数与 agentsRef（注释 638 行明确点出）。
- **`JOBS_FILE` 必须随机化**：用随机 `TEST_JOB_TOKEN` 命名（22–23 行），否则 pid 复用时历史 fixture 任务（如 `job-tmp-active`）会被读入，让「单项目串行」误判为已有项目在编译、后续提交全 `queued`（19–21 行注释）。收尾统一 `fs.rmSync(JOBS_FILE)`（1548 行）。
- **`makeBatchMock` 必须按目标位置给对文章类型**：stale 逐篇更新时 `articleMd` 按目标文件名推断 `type`（root 的 `_architecture.md` 为 `architecture`、`concepts/` 为 `concept` 等，158–168 行），否则 0.14.0 文章契约闸门会把 `type` 与目录不一致的页面降为 partial。
- **本模块无禁用/注释掉代码**：`client.js`（1–425）、`test-orchestration.mjs`（1–1552）、`test-engine-client.mjs`（1–366）全部功能启用；`test-engine-client.mjs` 的 `pyEngine`/`fakeEngine` 两条路径并存只是平台适配（Windows 走 node 包装层设 `FAKE_MODE`，235–236 行注释），非降级。
