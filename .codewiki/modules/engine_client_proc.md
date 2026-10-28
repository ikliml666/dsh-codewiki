---
title: engine_client_proc
type: module
source_files:
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/contract.js
  - test-engine-client.mjs
  - test-engine-process-tree.mjs
tags: [engine, process, spawn, json-lines, cancellation, subprocess-tree]
---

## Overview

`engine_client_proc` 是迁移到 FSoft 原生引擎（外部进程，多为 Python）时唯一跨语言边界的实现层，由两块协同组成：

- `lib/engine/client.js` —— Node 侧薄适配层：起一个受管子进程、写一行请求 JSON、读回 JSON-lines，把引擎消息翻译成 `contract.js` 的 `EngineResult`/`EngineProgress`/`EngineError`；在超时 / 取消 / 崩溃 / 协议破坏时给出**可机读**的失败，而不是抛一个模糊异常。
- `lib/engine/process-tree.js` —— 受管子进程树的终止层：引擎自己还会派生子进程（flake8、find、某些后端 fork 的 claude/codex），只 kill 直接子进程的 pid 会让孙进程变孤儿继续跑（DSH 里表现为「任务已取消但机器上还挂着 python 在烧 token」），这一层负责把整棵树打穿。

职责边界被刻意收窄（`client.js:1`–`client.js:21`）：不实现聚类 / 图 diff / 文章写作（那是引擎的活）；不读凭证、不连模型（模型通道由 `llm-bridge.js` / `openai-bridge.js` 提供）；不写 `.codewiki`（产物落盘与映射在 `output.js` / `mapping.js`）。

协议不变量（`client.js:13`–`client.js:21`）是这一层的正确性核心，全部被 `test-engine-client.mjs` 钉死：
1. stdout **只**是 JSON-lines；非 JSON 行记 `not-json` 违规但不丢弃已收结果（`client.js:14`）。
2. 每条消息必须带匹配的 `requestId`；不匹配记 `unknown-request`，绝不参与本次结果（`client.js:15`）。
3. 没有 `result` 消息 = 协议破坏，即使退出码 0 也判失败（`client.js:16`）。
4. 退出码只表达**进程层**结果；语义以 `result` 为准：退出码 0 + 语义 failed 仍是失败；语义 done + 退出码非 0 保留 done 并记 `nonzero-exit`（`client.js:17`）。
5. 取消后到达的 result 记 `late-result` 并丢弃——取消是终态，不能被迟到的成功洗白（`client.js:19`）。
6. 重复 result 先到的赢（后到的是引擎 bug，非本端问题）（`client.js:20`）。

## Key Components

### lib/engine/client.js

**常量**
- `ENGINE_PROTOCOL_VERSION`（行 27）—— 协议版本常量 `1`。独立于结果契约版本 `ENGINE_CONTRACT_VERSION`：前者管「行怎么长」，后者管「结果字段」（`client.js:26`）。
- `DEFAULT_MAX_LINE_BYTES`（行 29）—— `4 * 1024 * 1024`（4 MiB），单行字节上限，防引擎失控吐超长行吃内存。
- `DEFAULT_STDERR_TAIL`（行 30）—— `4000`，最终结果里保留的 stderr 尾部字符数。

**公开函数 / 类**

- `createProtocolReader(options = {})`（行 39）—— 增量式 JSON-lines 读取器。纯逻辑、不碰进程，所以能被逐字节喂（模拟管道任意切分）（`client.js:33`）。`options.requestId` 必填（行 40-41）；`options.maxLineBytes` 可选（默认 `DEFAULT_MAX_LINE_BYTES`，行 42）。内部状态：`buf`/`cancelled`/`result`/`resultSeen`/`progress`/`errors`/`violations`/`ended`（行 44-51）。返回对象：
  - `push(chunk)`（行 133）—— 喂入 stdout（`Buffer` 或 string）。按字节缓冲，多字节 UTF-8 跨 chunk 不会切坏（行 130）。按 `\n`(0x0a) 切行（行 138）；单行超过 `maxLineBytes` 记 `line-too-long` 并跳过（行 143-146）；无换行的残留超限也丢弃缓冲（行 151-154）。返回本次新解析出的 progress 快照数组（行 148、155）。
  - `get progress`（行 159）—— 只读，返回已解析进度快照数组。
  - `markCancelled()`（行 164）—— 声明进入取消态；此后到达的 `result` 一律记为 `late-result`（行 106-109）。
  - `end()`（行 169）—— 收尾：把残留在缓冲里的半行当成 `not-json` 违规（截断的 JSON 不能当结果），幂等。返回 `{ result, progress, errors, violations, cancelled, endedWithResult, ended }`（行 175-183）。
  - 内部 `handleLine(text)`（行 56）—— 解析单行并归类：`hello`（行 74-80，核对 `protocolVersion`）、`progress`（行 88-96）、`error`（行 98-102，引擎主动报错，非协议破坏）、`result`（行 104-122，含取消 / 重复 / 解析校验）、未登记 type 记 `bad-shape`（行 124-125）。
  - 内部 `violate(kind, detail)`（行 53）—— 追加违规，detail 截断到 500 字符。
- `spawnPlan(engine, cwd, env)`（行 189，内部）—— 把引擎描述 `{command, args, env, cwd}` 规范成 spawn 参数；`command` 必填（行 191-192）；合并 `process.env` + `engine.env` + `env`（行 197）。
- `tail(text, max = DEFAULT_STDERR_TAIL)`（行 201，内部）—— 截断 stderr 到尾部 `max` 字符，超长加前导省略号。
- `runEngine(options = {})`（行 223）—— 跑一次引擎动作并归一成 `EngineResult`。`options` 关键字段：`engine`（行 210）、`requestId`（行 211，必填）、`action`（行 212，限 `'doctor'|'generate'|'update'|'cancel'`）、`payload`（行 213）、`cwd`/`env`（行 214-215）、`timeoutMs`（行 216，默认 600000）、`signal`（行 217，`AbortSignal`）、`onProgress`（行 218）、`onLog`（行 219）、`maxLineBytes`/`graceMs`（行 220-221）。流程：
  - 参数校验与 `spawnPlan`（行 224-284）。
  - `spawn` 子进程，POSIX 上 `detached: true` 独立进程组以便取消时整组打掉（行 288-295）。
  - stdout → `reader.push` 并 `flushProgress`；stderr → 累积 `stderrBuf` 并回调 `onLog`（行 300-309）。
  - 写请求行 `{requestId, action, ...payload} + '\n'` 后关 stdin（引擎遇 EOF 开始干活）（行 324-329）。
  - 竞争 `exited` / `timeout` / `abort` / `spawnError` 四种终态（行 311-359）。
  - 超时 → `killTree('timeout')` 并失败（行 368-374）；取消 → `markCancelled()` + `killTree('abort')` 返回 `cancelled` 终态（行 376-391）；spawn 失败（ENOENT 等）→ `engine-missing`（行 362-366）。
  - 正常退出后等 stdout `end`，再 `reader.end()`；无 `result` 记 `engine-crashed`/`engine-protocol`（行 393-414）；退出码非 0 追加 `nonzero-exit` 违规（行 416-419）。
  - 内部 `flushProgress()`（行 246）、`finish(result, extraViolations)`（行 253，附 `contractVersion/requestId/action/protocolViolations/exitCode/exitSignal/terminated/stderrTail/durationMs/startedAt/finishedAt`）、`fail(code, message, extraViolations)`（行 274，构造 `outcome:'failed'`）、`killTree(reason)`（行 331，调用 `terminateProcessTree`，`graceMs` 默认 3000）。
- `default` 导出（行 424）—— `{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`。

`client.js` 依赖 `contract.js` 的 `engineError` / `engineProgress` / `engineResult` / `ENGINE_CONTRACT_VERSION`（行 23）与 `process-tree.js` 的 `terminateProcessTree`（行 24）。

### lib/engine/process-tree.js

**常量**
- `IS_WINDOWS`（行 18）—— `process.platform === 'win32'`。

**公开函数 / 类**
- `run(command, args)`（行 20，内部）—— 派生一个忽略 stdio 的辅助进程（如 `taskkill`），返回 `{ code, error? }`，用于平台终止命令。
- `isAlive(pid)`（行 41）—— `process.kill(pid, 0)` 存在性探测：不抛错→活着（含僵尸）；`ESRCH`→已退出；`EPERM`→存在但无权限仍算活着（行 42-49）。非整数 / ≤0 直接返回 false。
- `terminateProcessTree(pid, options = {})`（行 61）—— 终止一棵受管子进程树。返回 `{ ok, rootAlive, method }`，`ok=false` 表示根进程超时后仍活着（调用方应据此报错，而不是假装取消成功）。`options.graceMs` 默认 3000（行 62），`options.onLog` 为诊断日志回调（行 63）。行为：
  - 非法 / 已退出 pid → `{ ok:true, rootAlive:false, method:'noop' | 'already-exited' }`（行 65-70）。
  - Windows：`taskkill /T /F /PID <pid>` 递归整棵树（行 72-79）。
  - POSIX：先 `process.kill(-pid, 'SIGTERM')`（负 pid = 整个进程组），失败退化成 `process.kill(pid, 'SIGTERM')`（行 82-89）；等 `graceMs` 未退则 `process.kill(-pid, 'SIGKILL')`（行 94-102）。
- `waitForDeath(pid, timeoutMs)`（行 105，内部）—— 以 25ms 步长轮询 `isAlive` 直到死亡或超时（行 105-113）。

## Architecture

两个文件之间：`runEngine` 在超时 / 取消时调用 `terminateProcessTree` 打穿整棵进程树；`createProtocolReader` 只负责把 stdout 字节流解析成结构化的 `EngineResult/EngineProgress`。协议版本与结果契约版本分离。

```text
┌──────────────────────────────┐
│        runEngine()           │  lib/engine/client.js:223
│  spawn + 协议 + 超时/取消     │
└───────────────┬──────────────┘
                │ spawn(command, args, { detached })
                ▼
┌──────────────────────────────┐   stdout (JSON-lines)   ┌─────────────────────────────┐
│   managed child process       │────────────────────────►│   createProtocolReader        │  client.js:39
│   (Python / 任意外部引擎)      │                          │   push→handleLine→           │
│   pid = child.pid             │◄────── stderr / onLog ──│   EngineProgress / EngineResult│
└───────────────┬──────────────┘                          └─────────────────────────────┘
                │ on timeout / abort → killTree(reason)
                ▼
┌──────────────────────────────┐
│   terminateProcessTree(pid)   │  lib/engine/process-tree.js:61
│  SIGTERM→SIGKILL (POSIX)     │
│  taskkill /T /F (Windows)    │
└──────────────────────────────┘
                │ 返回 { ok, rootAlive, method }
                ▼
        finish() 写入 EngineResult
        (contractVersion / protocolViolations / exitCode / terminated …)
```

## Data Flow

1. 调用方传入 `engine` 描述 + `requestId` + `action` + `payload`（`runEngine`，`client.js:223`）。
2. `spawnPlan` 归一化参数，`spawn` 出子进程（POSIX `detached` 自成一进程组）（`client.js:189`、`:288`）。
3. 写一行请求 JSON 后关 stdin（`client.js:324-329`）。
4. 子进程 stdout 字节流逐段喂给 `createProtocolReader.push`（`client.js:300-303`、`client.js:133`）：按 `\n` 切行 → `handleLine` 解析 → `hello`/`progress`/`error`/`result` 分类，违规进 `violations`（如 `not-json`/`unknown-request`/`duplicate-result`/`late-result`）/`progress` 实时经 `onProgress` 回调（`client.js:56`、`client.js:246`）。
5. 终态由 `Promise.race` 决定（`client.js:267`）：
   - 超时 → `killTree` 调用 `terminateProcessTree`（POSIX `SIGTERM`→`SIGKILL`，Windows `taskkill /T /F`），失败码 `engine-timeout`（`client.js:368`、`process-tree.js:61`）。
   - 取消 → `reader.markCancelled()` + `killTree`，返回 `cancelled` 终态，迟到 `result` 记 `late-result`（`client.js:376`、`client.js:108`）。
   - 正常退出 → 等 stdout `end` 后 `reader.end()`；无 `result` → `engine-crashed`/`engine-protocol`；有 `result` → 以语义为准，退出码非 0 仅追加 `nonzero-exit`（`client.js:401-421`）。
6. `finish` 把 `contractVersion`/`requestId`/`action`/`protocolViolations`/`exitCode`/`exitSignal`/`terminated`/`stderrTail`/`durationMs`/`startedAt`/`finishedAt` 附到 `engineResult(...)` 上返回（`client.js:253-272`）。

## Connections

- [[engine-contract]] —— `client.js` 直接消费 `contract.js` 的 `engineResult`/`engineProgress`/`engineError`/`ENGINE_CONTRACT_VERSION`（行 23）；协议破坏 / 超时 / 崩溃失败的可机读语义（`engine-crashed`/`engine-protocol`/`engine-timeout`/`engine-missing`）全部是 `contract.js` 里登记的 `ENGINE_ERROR_CODES`（`contract.js:57-67`）。
- [[engine-llm-bridge]] / [[engine-openai-bridge]] —— 模型通道由 `llm-bridge.js` / `openai-bridge.js` 单独提供；本模块明确**不**读凭证、不连模型（`client.js:9-10`）。
- [[engine-output]] / [[engine-mapping]] —— 产物落盘与 FSoft 输出 → CodeWiki 映射在 `output.js` / `mapping.js`，本模块**不**写 `.codewiki`（`client.js:11`）。
- [[engine-manifest]] —— doctor 动作的引擎版本 / 锁定信息经 `engineResult(...)` 的 `engine` 字段（`contract.js:127-131`）回传，供面板展示与回滚取证。
- [[test-engine-client]] / [[test-engine-process-tree]] —— 本模块的断言护栏：协议破坏、超时、取消、进程树孤儿全部由这两个测试钉死（见下 Known Issues）。

## Known Issues

- **尚未接入主服务路径**：本模块（`runEngine` / `terminateProcessTree`）是「FSoft 原生引擎 + 薄适配层」迁移路径的跨语言边界，目前主要由 `test-engine-client.mjs` 与 `test-engine-process-tree.mjs` 验证；宿主主流程 `index.js` 的编译用的是另一条路径（`runCw` 调本地 `cw` 二进制 + `runRealtimeTasks` 走宿主 llm 服务），并未 `import` 本模块。因此本模块的失败码（如 `engine-missing`/`engine-timeout`）尚未被 `index.js` 的 JobService 终态判定消费——接入前需明确谁负责调用 `runEngine` 并把返回的 `EngineResult` 转成 `job.outcome`/`blockers`。
- **POSIX 非 detached 退化**：若子进程不是用 `detached:true` 起的（行 294 仅在非 win32 设 detached），`process.kill(-pid)` 会失败，退化成只杀直接子进程（`process-tree.js:86-89`），孙进程仍可能变孤儿。引擎描述依赖的 spawn 行为需保证 `detached`。
- **`hello` 的 `protocol-version` 违规不阻断结果**：`handleLine` 在 `hello` 阶段比对 `protocolVersion`，不一致只记 `protocol-version` 违规（`client.js:74-78`），但 reader 仍继续解析——协议版本不被当终态失败，仅作诊断。
- **stderr 缓冲上限**：stderr 累积到 `DEFAULT_STDERR_TAIL*4` 时只保留尾部 `DEFAULT_STDERR_TAIL*2`（`client.js:307`），最终返回的 `stderrTail` 仍截断到 `DEFAULT_STDERR_TAIL`（行 267），超长崩溃日志尾部会丢失中间内容。
- **`spawn-error` 一律归 `engine-missing`**：ENOENT 与其它 spawn 失败都映射成 `engine-missing`（`client.js:362-366`），调用方无法从 code 区分「解释器不存在」与「未知 spawn 失败」。
