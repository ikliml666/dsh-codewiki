---
title: engine_protocol
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-process-tree.mjs
  - lib/engine/native-run.js
  - lib/engine/llm-bridge.js
tags: [engine, protocol, contract, process-management, client]
---

## Overview

`engine_protocol` 是迁移目标（把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」）中唯一的跨进程 / 跨语言边界。它包含三块互相支撑的能力：

1. **契约（contract.js）** — 一次 `generate` / `update` 的结果长什么样、推进中的快照长什么样、失败事实长什么样。这是纯函数层，不参与文件 / 进程 / 模型，因此能被 TDD 钉死。背景见文件头注释（lib/engine/contract.js 1-19 行）：0.14.0 花了一整轮修掉的「1 篇成功 + 19 篇失败也报 done」缺陷，根源就是这条边界含糊，所以这里把 `EngineResult` / `EngineProgress` / `EngineError` 三件事固定下来，并施加语义硬不变量（lib/engine/contract.js 12-17 行）。

2. **客户端 / 协议层（client.js）** — Node ↔ Python 之间的薄适配层（进程 + 协议）。职责故意做窄（lib/engine/client.js 1-18 行）：起一个受管子进程、写一行请求 JSON、读回 JSON-lines、把引擎消息翻译成 contract 对象；超时 / 取消 / 崩溃 / 协议破坏时给出可机读失败，而不是抛模糊异常。

3. **受管子进程树终止（process-tree.js）** — 取消语义的地基（lib/engine/process-tree.js 1-14 行）。FSoft 的 Python 进程自己会派生子进程（flake8、find、甚至 fork claude/codex），只 kill 直接子进程会让孙进程变孤儿继续烧 token，所以要有整树终止能力。

协议不变量（client.js 13-20 行）与契约语义（contract.js 12-17 行）共同保证：退出码与语义分离、requestId 唯一关联、协议破坏即失败、取消是终态不可被迟到结果洗白。

## Key Components

### lib/engine/contract.js — 契约（纯函数，无副作用）

常量（全部 `Object.freeze` 或 `const`）：

- `ENGINE_CONTRACT_VERSION` (lib/engine/contract.js 20 行) — 结果为 `1`，与协议版本 `ENGINE_PROTOCOL_VERSION` 相互独立。
- `ENGINE_STAGES` (lib/engine/contract.js 24-33 行) — 阶段枚举（契约，非实现细节）：`['env','graph','cluster','articles','validate','index','baseline','commit']`。顺序即推进顺序；`env` 最前、`commit` 最后。
- `TERMINAL_OUTCOMES` (lib/engine/contract.js 35 行) — `['done','partial','failed','cancelled']`。
- `UPDATE_OUTCOMES` (lib/engine/contract.js 45-50 行) — 阶段 5 增量结局：`['incremental','no_change','full_fallback','detector_failure']`；`null` 表示非 update 编译。
- `CONSUMING_UPDATE_OUTCOMES` (lib/engine/contract.js 53 行) — `['incremental','no_change']`，只有这两个才算「增量真的成立、基线可推进」。
- `BLOCKER_KINDS` (lib/engine/contract.js 57-72 行) — 阻塞原因类别（可机读、只允许追加）：`article-failed / article-missing / unmapped-change / unmapped-page / quality-gate / index-failed / baseline-failed / commit-failed / engine-error / cancelled / incremental-fallback`。
- `ENGINE_ERROR_CODES` (lib/engine/contract.js 76-86 行) — `engine-missing / engine-deps / engine-timeout / engine-cancelled / engine-crashed / engine-protocol / engine-model / engine-output / engine-unknown`。
- `RETRYABLE_CODES` (lib/engine/contract.js 90 行) — `Set(['engine-timeout','engine-model','engine-unknown'])`，未登记码一律视为确定性失败。

内部辅助：

- `num(v)` (lib/engine/contract.js 92-95 行) — 把值归一为 `>0` 有限数，否则 `0`。
- `normalizeUsage(usage)` (lib/engine/contract.js 97-105 行) — 归一 `{inputTokens,outputTokens,cachedTokens,requests}`，每个都是非负数。
- `normalizeBlocker(b)` (lib/engine/contract.js 107-113 行) — 归一 blocker：`kind` 未在 `BLOCKER_KINDS` 中则降级为 `engine-error`；`detail` 截断 2000 字符；可选 `target` / `source`。

公开函数：

- `engineResult(input={})` (lib/engine/contract.js 116-180 行) — 构造一次 generate/update 结果。非法输入**抛错**而非静默归一。返回的字段与硬不变量：
  - `contractVersion` (144 行) = `ENGINE_CONTRACT_VERSION`
  - `outcome` (145 行) — 必须是终态之一，否则抛错（117-120 行）。
  - `stage` (147 行) — 引擎侧最后一个到达的 stage；不在 `ENGINE_STAGES` 则 `null`。
  - `blockers` (148 行) — 数组；`done` 带 blockers 抛错（122-124 行），`partial` 无 blockers 抛错（125-127 行）。
  - `error` (149 行) — `failed` 必须有 error 否则抛错（128-131 行）。
  - `writtenCount / failedCount / keptCount / removedCount / unmappedCount` (150-154 行) — 非负数字段。
  - `updateOutcome` (157 行) — 只接受登记过的枚举，否则抛错（134-142 行）；`null` 合法。
  - `usage` (158 行) — 来自 `normalizeUsage`。
  - `engine` (160-170 行) — `{version,commit,python,deps:{ok,summary}}`；`deps.ok` 仅严格 `=== true` 算通过，`summary` 截断 2000。
  - `artifacts` (172-176 行) — `{docsDir,rawTreeDir,updateRecord}`。
  - `startedAt / finishedAt` (177-178 行) — 字符串或 `null`。
- `engineProgress(input={})` (lib/engine/contract.js 183-201 行) — 推进中快照。`stage` 必须在枚举内否则抛错（184-187 行）；`percent` 夹到 0–100（188-189 行）。字段：`contractVersion, stage, percent, message, writtenCount, failedCount, totalCount, usage, at`。
- `engineError(input={})` (lib/engine/contract.js 204-215 行) — 可机读失败事实：`code`（未登记归 `engine-unknown`）、`message`（截断 4000）、`stage`、`retryable`（`RETRYABLE_CODES` 决定）、`rawCode`（仅当归到 `engine-unknown` 且原 code 非空时保留原样，截断 200）。
- `validateEngineResult(value)` (lib/engine/contract.js 219-260 行) — 反序列化边界的**非抛错**校验，返回 `{ok, errors}`。逐条检查：`contractVersion`、`outcome` 合法性与自相矛盾（done 带 blockers / partial 无 blockers）、数字字段非负有限、`blockers` 形状与 `kind` 登记、`failed` 必须有 `error`、`updateOutcome` 若为值须登记。
- `describeEngineResult(result)` (lib/engine/contract.js 263-280 行) — 终态文案，四态可一眼分清：done/partial/failed/cancelled。

### lib/engine/client.js — 客户端 / 协议层

常量：

- `ENGINE_PROTOCOL_VERSION` (lib/engine/client.js 27 行) — 协议版本 `1`，独立于结果契约版本。
- `DEFAULT_MAX_LINE_BYTES` (lib/engine/client.js 29 行) — `4 * 1024 * 1024`，单行上限防内存失控。
- `DEFAULT_STDERR_TAIL` (lib/engine/client.js 30 行) — `4000`，stderr 尾部保留长度。

函数 / 类：

- `createProtocolReader(options={})` (lib/engine/client.js 39-186 行) — 增量式 JSON-lines 读取器，纯逻辑、不碰进程（可被逐字节喂以模拟管道任意切分）。
  - 构造参数：`requestId`（必填，只接受此 id 的消息）、`maxLineBytes`。
  - 内部闭包 `handleLine(text)` (56-126 行) — 解析单条消息并按类别返回：
    - `hello` (74-80 行) — 校验 `protocolVersion` 与 `ENGINE_PROTOCOL_VERSION` 一致，不一致记 `protocol-version` 违规。
    - 非 JSON / 非对象 / 数组 → `violation`（`bad-shape` / `not-json`，64-69 行）。
    - `requestId` 不匹配 → `violation`（`unknown-request`，83-86 行）。
    - `progress` → 经 `engineProgress` 归一后入 `progress` 数组（88-96 行）。
    - `error` → 经 `engineError` 入 `errors`（语义失败，非协议破坏，98-102 行）。
    - `result` → 经 `engineResult` 归一；`cancelled` 后到达记 `late-result` 并丢弃（104-109 行）；重复 result 先到赢、后到记 `duplicate-result`（110-113 行）；解析失败记 `bad-result`（114-121 行）。
  - 返回对象方法：
    - `push(chunk)` (133-156 行) — 喂一段 stdout（Buffer 或 string）；按字节缓冲，跨 chunk 的 UTF-8 不会切坏；遇到换行切行调用 `handleLine`；单行超 `maxLineBytes` 记 `line-too-long` 并跳过；无换行的残留超上限直接丢弃缓冲。返回本次新解析出的 progress 快照数组。
    - `progress` getter (159-161 行) — 只读进度快照数组。
    - `markCancelled()` (164-166 行) — 声明进入取消态，此后到达的 result 一律记 `late-result`。
    - `end()` (169-184 行) — 收尾：半行残留记 `not-json`；返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`。幂等。
- `spawnPlan(engine, cwd, env)` (lib/engine/client.js 189-199 行) — 把引擎描述规范成 spawn 参数：`command`（必填，空则抛错）、`args`、`cwd`、`env`（合并 `process.env` 与传入 env）。
- `tail(text, max)` (lib/engine/client.js 201-204 行) — 截断尾部文本，保留最后 `max` 字符并加 `…` 前缀。
- `runEngine(options={})` (lib/engine/client.js 223-422 行) — 跑一次引擎动作并归一成 `EngineResult`。参数：`engine`、`requestId`（必填）、`action`（`doctor/generate/update/cancel` 之一，否则抛错，226-229 行）、`payload`、`cwd`、`env`、`timeoutMs`（默认 600000）、`signal`、`onProgress`、`onLog`、`maxLineBytes`、`graceMs`。关键行为：
  - 以 `createProtocolReader` 解析 stdout；stderr 累积尾部（304-309 行）。
  - `killTree(reason)` (331-344 行) — 取消 / 超时后调用 `terminateProcessTree` 终止整棵树。
  - 竞争 `exited / timeout / abort / spawnError`（359 行）：`spawn-error` → `engine-missing`（362-366 行）；`timeout` → `killTree` + `engine-timeout`（368-374 行）；`abort` → `markCancelled` + `killTree` + 终态 `cancelled`（376-391 行）。
  - 进程退出后等 stdout `end`，再 `reader.end()`（393-401 行）。无 `result` = 协议破坏：`exitCode !== 0` → `engine-crashed`，否则 `engine-protocol`，且 stderr 尾部进 message（403-414 行）。
  - `exitCode !== 0` 但语义 done → 保留 done 并加 `nonzero-exit` 违规（416-419 行）。
  - `finish(result, extraViolations)` (253-272 行) — 统一出口，附加 `contractVersion, requestId, action, protocolViolations, exitCode, exitSignal, terminated, stderrTail, durationMs, startedAt, finishedAt`。
- `default` 导出 (lib/engine/client.js 424 行) — `{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`。

### lib/engine/process-tree.js — 受管子进程树终止

- `isAlive(pid)` (lib/engine/process-tree.js 41-49 行) — 用 `process.kill(pid, 0)` 做存在性探测：不抛错→活着（含僵尸）；`ESRCH`→已退出；`EPERM`→存在无权限仍算活着；非整数 / `<=0` / 非数返回 `false`。
- `terminateProcessTree(pid, options={})` (lib/engine/process-tree.js 61-103 行) — 终止整棵受管进程树。
  - 参数：`pid`、`graceMs`（默认 3000）、`onLog`。
  - 非整数 / `<=0` → `{ok:true, rootAlive:false, method:'noop'}`（65-67 行）；`!isAlive` → `{ok:true, rootAlive:false, method:'already-exited'}`（68-70 行，幂等）。
  - Windows：`taskkill /T /F /PID <pid>`，再 `waitForDeath(pid, 1000)`（72-80 行）。
  - POSIX：`process.kill(-pid, 'SIGTERM')`（负 pid = 整个进程组；若非 detached 起则退化只打自己，84-89 行）；等 `graceMs`；未死则 `process.kill(-pid, 'SIGKILL')` + 再等 1000ms（91-102 行）。
  - 返回 `{ok, rootAlive, method}`，`ok=false` 表示根进程超时仍活着。
- `waitForDeath(pid, timeoutMs)` (lib/engine/process-tree.js 105-113 行) — 每 25ms 轮询 `isAlive`，直至死亡或超时。
- `run(command, args)` (lib/engine/process-tree.js 20-32 行) — 内部：spawn 一个子进程并仅等其退出（用于 taskkill）。

### 消费方相关（用于理解边界，详见 [[engine_native_run]]）

- `runNativeJob` (lib/engine/native-run.js 109-743 行) — 一次完整编译的裁决链编排，调用 `runEngine`（import 自 client.js，47 行）与 `engineResult/engineError/engineProgress`（46 行），并通过 `settle`（140-174 行）强制终态经 `engineResult` 归一，使契约硬不变量在产出边界生效。
- `startLlmBridge` (lib/engine/llm-bridge.js，import 于 native-run.js 51 行) — 宿主模型 loopback 桥，凭证边界见 lib/engine/llm-bridge.js 1-23 行，桥不读凭证、只给引擎 `127.0.0.1:<随机端口>` 与占位 key。

## Architecture

```text
        Node 侧 (宿主)                                    Python 侧 (FSoft 引擎)
 ┌──────────────────────────────┐                    ┌──────────────────────────┐
 │ runNativeJob (native-run.js) │                    │ python/entry.py          │
 │  env→决议→引擎→gate→apply     │   requestId + 动作   │  doctor/generate/update  │
 └──────────────┬───────────────┘   ─── 1 行 JSON ──► │                          │
                │                                     │   stdout JSON-lines:     │
                │           runEngine (client.js)     │    hello/progress/        │
                │           ┌─────────────────────┐   │    error/result          │
                │           │ createProtocolReader │ ◄─┼─── 2 行 JSON-lines ─────│
                │           │ push()→handleLine()  │   │                          │
                │           │  requestId 隔离/违规  │   │   派生子进程(孙):        │
                │           └─────────┬───────────┘   │   flake8/find/claude      │
                │                     │ 归一            └────────────┬─────────────┘
                │                     ▼                              │ 取消/超时
                │           engineResult / engineProgress           │ kill 整组
                │           engineError (contract.js)              ▼
                │                                     ┌──────────────────────────┐
                │           终止进程树                 │ terminateProcessTree     │
                │           (process-tree.js) ◄────── │ Windows taskkill /T /F    │
                │           SIGTERM→SIGKILL (POSIX)  │ POSIX process.kill(-pid) │
                └─────────────────────────────────────└──────────────────────────┘
```

组件职责边界（client.js 1-18 行的显式约束）：

- `contract.js` 只做纯数据校验，不碰文件 / 进程 / 模型。
- `client.js` 只做「起进程 + 翻译协议 + 给出可机读失败」；不做聚类 / 图 diff / 文章写作（那是引擎的活），不读凭证 / 连模型（llm-bridge.js 单独提供），不写 `.codewiki`（output.js / mapping.js 负责）。
- `process-tree.js` 只做「终止」，不做启动 / 协议 / stdout。

## Data Flow

一次 `generate` 端到端（以 `runNativeJob` 为入口，native-run.js 109 行）：

1. **请求**：`runEngine`（client.js 223 行）写一行 JSON `{requestId, action, ...payload}` 到 stdin 并 `end()`（324-329 行），引擎读到 EOF 后开始干活。
2. **协议解析**：stdout 数据经 `child.stdout.on('data')` 喂给 `reader.push(chunk)`（300-303 行），按 `\n` 切行、跨 chunk 保 UTF-8；每行走 `handleLine`（56 行），按 `requestId` 隔离（83 行），分别累积 `progress` / `errors` / `result`，违规记 `violations`。
3. **语义归一**：`result` 行经 `engineResult`（contract.js 116 行）归一，触发契约硬不变量；`hello` 校验协议版本（74-80 行）。
4. **终态裁决**：`runEngine` 的 `finish`（253 行）把 `result` 加上 `protocolViolations / exitCode / stderrTail / durationMs` 等现场证据返回；`runNativeJob.settle`（140 行）再经 `engineResult` 强制归一，并把 gate/apply 结论与 `updateOutcome` 合并成严格终态。
5. **取消 / 超时**：`signal` abort → `reader.markCancelled()`（377 行）+ `killTree` 调 `terminateProcessTree`（336 行）；超时同理（369 行）。取消后到达的 `result` 记 `late-result` 并被 `reader.end()` 丢弃（381 行、104-109 行），终态取已确认进度而非迟到结果。
6. **退出码语义**：进程退出后若 `endedWithResult` 为 `false`（缺 result 消息）→ 协议破坏（403-414 行）；`exitCode !== 0` 但语义 done → 保留 done 加 `nonzero-exit` 违规（416-419 行）。

`update`（增量）路径额外携带 `updateOutcome`（contract.js 45-53 行）：`incremental` / `no_change` 才被 `CONSUMING_UPDATE_OUTCOMES` 认定为「增量真的成立、基线可推进」；`full_fallback` / `detector_failure` 表示引擎没真做增量，基线绝不能推进（native-run.js 33-36 行、651-659 行）。

## Connections

- [[engine_native_run]] — `runNativeJob` 是 contract/client 的生产消费方，调用 `runEngine` 并借 `settle` 强制终态经 `engineResult` 归一（native-run.js 46-47、109-743 行）。
- [[engine_manifest]] — `doctor` / 锁校验在 native-run.js 第 1 步先于引擎运行；锁不一致 / 依赖不闭合直接 `failed` 而不跑引擎（native-run.js 183-268 行）。
- [[engine_quality_gate]] — `gateNativeOutput` 在 native-run.js 第 3 步校验产物，引擎 done 不能替代质量门（native-run.js 503-515 行、636-668 行）。
- [[engine_apply_plan]] — `applyNativeOutput` 在 native-run.js 第 4 步落盘 / 建索引 / 推进基线 / 提交，失败回滚（native-run.js 591-617 行）。
- [[engine_llm_bridge]] — `startLlmBridge` 提供模型通道，凭证边界由 llm-bridge.js 1-23 行约束，桥不读真实凭证（native-run.js 386-407 行）。
- [[engine_native_state]] — `nativeState` 负责增量决议 / 水合 / 受管状态采集，决定 `updateOutcome` 与基线能否推进（native-run.js 287-352、528-589 行）。
- [[engine_contract]]（本文 contract.js 的同名关注）/ [[engine_client]] / [[engine_process_tree]] — 若模块细拆，可分别指向本模块的三文件。

## Known Issues

- **契约耦合映射**：`test-engine-contract.mjs` 同时 import 了 `lib/engine/mapping.js`（`mapFsoftOutput` / `moduleSlug` 等，测试 24-30、189-334 行），但 `mapping.js` 不在本文 source_files 中（它是产物落盘映射，属 [[engine_apply_plan]] / 输出范畴）。本文未读 mapping.js，相关断言（source_files 证据、artifact 页、slug 冲突）仅作交叉引用，不展开细节。
- **`done` 但有 blockers 的收口点**：contract.js 的 `engineResult`（122-124 行）在构造时抛错；但 native-run.js 在合成终态时（661-665 行）选择「宁可降级为 partial 也不掩盖」，两处策略一致（构造期硬失败 vs 合成期降级），均禁止「done + blockers」。
- **协议违规不阻断结果**：`not-json` / `unknown-request` / `duplicate-result` 等违规只进 `protocolViolations`，已从收到的结果中剥离（client.js 53、83-86、110-113 行）；`line-too-long` 会跳过整行（client.js 143-146 行），但已收的合法 progress / result 不受影响。
- **`incremental-fallback` blocker 仅在不完整时加**：native-run.js 650-659 行只在 `finalOutcome !== 'done'` 时加入该 blocker；产物完整（gate/apply 都 done）时只进 `notes`，避免「每次 full_fallback 都红、基线永不推进」的假死。
- **首次运行锁延迟写盘**：`.codewiki/engine-lock.json` 不能在 env 校验阶段写，否则会让落地器把目录判成半截库；真正写盘推迟到落地器跑完且 `_meta.yaml` 已存在之后（native-run.js 269-275、678-693 行）。
