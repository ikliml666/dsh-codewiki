---
title: engine_protocol
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - lib/engine/native-run.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/manifest.js
  - lib/engine/llm-bridge.js
  - lib/engine/mapping.js
  - lib/update-record.js
  - test-engine-client.mjs
  - test-engine-contract.mjs
  - test-engine-python-entry.mjs
tags: [engine, protocol, contract, cross-process, fsoft, node-python]
---

## Overview

`engine_protocol` 是迁移后「FSoft 原生引擎（Python）↔ Node 侧消费方」之间的**唯一跨语言边界**，由三层职责切分而成：

- **结果/契约层**（`lib/engine/contract.js`）：纯数据契约，定义 `EngineResult` / `EngineProgress` / `EngineError` 的形状与语义硬不变量，并做白名单归一化与校验。它不碰文件、不碰进程、不碰模型——纯函数才能被 TDD 钉死（见 `lib/engine/contract.js` 第 1–18 行模块说明）。
- **协议/进程层**（`lib/engine/client.js`）：Node 侧薄适配器。起一个受管子进程、写一行请求 JSON、读回 JSON-lines；把引擎消息翻译成 contract 的三种类型；超时/取消/崩溃/协议破坏时给出可机读失败而不是模糊异常（见 `lib/engine/client.js` 第 1–21 行）。
- **生产编排层**（`lib/engine/native-run.js`）：把一次「完整编译」的裁决链固定成直线 `env(doctor+lock) → 引擎(graph/cluster/articles) → validate(质量门) → index/baseline/commit(落地器)`，每一步结论都不能被下一步洗白（见 `lib/engine/native-run.js` 第 1–20 行）。

这条边界之所以先被独立成文，是因为迁移后 Node 不再自己算依赖图/聚类/增量，一切真相来自 Python 引擎的一次返回。边界含糊会让 JobService 终态判定、面板、cw 基线、自动提交、降级提醒各自猜「引擎到底成功了没有」——这正是 0.14.0 花一整轮修掉的缺陷（1 篇成功 + 19 篇失败也报 done）。

配套的生产者端是 `lib/engine/python/entry.py`（Python JSON-lines 薄入口）与 `lib/engine/python/stage_map.py`（FSoft 五段 → 引擎八段契约的映射），由 `test-engine-python-entry.mjs` 反向断言两边枚举口径一致。受管子进程树的终止由 `lib/engine/process-tree.js` 单独承担（见 `lib/engine/process-tree.js` 第 1–14 行）。

## Key Components

### `lib/engine/contract.js` —— 纯数据契约（阶段 0）

**常量：**

- `ENGINE_CONTRACT_VERSION = 1`（第 20 行）：结果契约版本号，所有 `EngineResult`/`EngineProgress` 都带它，反序列化边界据此判版本。
- `ENGINE_STAGES`（第 24–33 行）：契约阶段枚举，顺序即推进顺序：`env → graph → cluster → articles → validate → index → baseline → commit`。它是面板步骤条、job.stage 映射、取消检查点的共同依据，**新增顺序不可乱**。
- `TERMINAL_OUTCOMES`（第 35 行，冻结）：`['done', 'partial', 'failed', 'cancelled']`——四个终态。
- `BLOCKER_KINDS`（第 42–53 行，冻结）：阻塞原因类别，机读、稳定、可被终态判定与面板文案共用。含 `article-failed`、`article-missing`、`unmapped-change`、`unmapped-page`、`quality-gate`、`index-failed`、`baseline-failed`、`commit-failed`、`engine-error`、`cancelled`。**新增只允许追加（消费者按 kind 分派），不允许改名**。
- `ENGINE_ERROR_CODES`（第 57–67 行，冻结）：可机读错误码：`engine-missing`、`engine-deps`、`engine-timeout`、`engine-cancelled`、`engine-crashed`、`engine-protocol`、`engine-model`、`engine-output`、`engine-unknown`。
- 模块内私有集合 `OUTCOME_SET`/`STAGE_SET`/`BLOCKER_SET`/`ERROR_CODE_SET`（第 37–69 行）；`RETRYABLE_CODES = new Set(['engine-timeout', 'engine-model', 'engine-unknown'])`（第 71 行）——决定重试语义，其余一律视为确定性失败。

**私有归一化函数：**

- `num(v)`（第 73–76 行）：把任意值归一成「正数否则 0」。
- `normalizeUsage(usage)`（第 78–86 行）：归一化用量 `{ inputTokens, outputTokens, cachedTokens, requests }`，全部 `num()`。
- `normalizeBlocker(b)`（第 88–94 行）：归一化 blocker，`kind` 不在 `BLOCKER_KINDS` 时落到 `'engine-error'`；`detail` 截断 2000 字符；可选 `target`/`source`。

**公开函数：**

- `engineResult(input = {})`（第 97–147 行）：构造一次 generate/update 的终态结果。**非法输入抛错而不是静默归一**。语义硬不变量由这里 + `validateEngineResult` 双重保证：
  - `done` 不许带 `blockers`（第 103–105 行，带则抛）；
  - `partial` 必须带至少一条 `blockers`（第 106–108 行，否则抛）；
  - `failed` 必须带 `error`（第 110–112 行，否则抛）。
  - 返回字段（第 113–146 行）：`contractVersion`、`outcome`、`stage`（引擎侧最后一个到达的 stage，`STAGE_SET` 校验否则 `null`）、`blockers`、`error`、`writtenCount`/`failedCount`/`keptCount`/`removedCount`/`unmappedCount`（`num` 归一）、`usage`、`engine`（`version`/`commit`/`python` 字符串 + `deps`：`{ ok: 严格 boolean, summary: 截断2000 }`）、`artifacts`（`docsDir`/`rawTreeDir`/`updateRecord`）、`startedAt`/`finishedAt`（ISO 字符串或 `null`）。
- `engineProgress(input = {})`（第 150–168 行）：推进中的快照，`tick` 与面板共用，字段只增不减。校验 `stage` 必须枚举内（否则抛，第 151–154 行）；`percent` 夹到 0–100 并取整（第 155–156 行）。返回 `contractVersion`/`stage`/`percent`/`message`/`writtenCount`/`failedCount`/`totalCount`/`usage`/`at`。
- `engineError(input = {})`（第 171–182 行）：可机读失败事实。`code` 未登记时落到 `'engine-unknown'`（第 173 行）；`retryable` 取自 `RETRYABLE_CODES`（第 178 行）；未登记 code 的原样保留在 `rawCode`（第 180 行）。返回 `{ code, message(截断4000), stage, retryable, rawCode? }`。
- `validateEngineResult(value)`（第 186–220 行）：校验来自外部/旧版本/磁盘的结果对象。**不抛错，返回逐条 `errors`**（反序列化边界对象必须被检查而非信任）。检查：`contractVersion` 匹配（第 191–193 行）、`outcome` 合法及 done/partial 的自相矛盾（第 194–200 行）、计数非负（第 201–206 行）、`blockers` 是数组且 kind 已登记（第 207–215 行）、`failed` 必须带 `error`（第 216–218 行）。返回 `{ ok, errors }`。
- `describeEngineResult(result)`（第 223–240 行）：终态文案，与 `lib/update-record.js` 的 `describeOutcome` 同一口径（四态一眼可分）：`done` → `完成（写入 N 篇）`；`partial` → `部分完成（写入 N 篇，M 篇未完成）：首个blocker`；`failed` → `失败：message`；`cancelled` → `已取消（已写入 N 篇）`。

### `lib/engine/client.js` —— 协议/进程层（阶段 2）

- `ENGINE_PROTOCOL_VERSION = 1`（第 27 行）：协议版本，**独立于**结果契约版本（前者管「行怎么长」，后者管「结果字段」）。
- `DEFAULT_MAX_LINE_BYTES = 4*1024*1024`（第 29 行）、`DEFAULT_STDERR_TAIL = 4000`（第 30 行）：单行上限与 stderr 尾部截取上限。
- `createProtocolReader(options)`（第 39–186 行）：增量式 JSON-lines 读取器，纯逻辑不碰进程，可被逐字节喂（模拟管道任意切分）。
  - 构造函数接受 `{ requestId, maxLineBytes }`（第 40–42 行），`requestId` 缺失即抛。
  - 闭包状态：`buf`、`cancelled`、`result`/`resultSeen`、`progress[]`、`errors[]`、`violations[]`（第 44–51 行）。
  - `violate(kind, detail)`（第 53 行）：记一条违规，`detail` 截断 500 字符。
  - `handleLine(text)`（第 56–126 行）：解析单条消息并返回归类（`'hello'`/`'progress'`/`'error'`/`'result'`/`'violation'`）。逻辑：非 JSON → `not-json`（第 64 行）；坏形状 → `bad-shape`（第 68 行）；`hello` 校验协议版本，不符记 `protocol-version`（第 74–80 行）；`requestId` 不匹配 → `unknown-request`（第 83–86 行，**缺失也算不匹配**）；`progress` → `engineProgress()` 入队（第 88–96 行）；`error` → `engineError()` 入 `errors`（第 98–102 行，是语义失败不是协议破坏）；`result` 在取消后 → `late-result` 丢弃（第 105–109 行），重复 result → `duplicate-result`（先到赢，第 110–113 行），否则 `engineResult()`（第 114–121 行，构造失败记 `bad-result`）；未知 type → `bad-shape`（第 124 行）。
  - 返回对象（第 128–185 行）：`push(chunk)`（第 133–156 行，按字节缓冲，多字节 UTF-8 跨 chunk 不切坏；遇换行拆行，`lineBuf > maxLineBytes` 记 `line-too-long`（第 143–146 行），无换行残留超限也记 `line-too-long` 并丢弃缓冲防内存涨（第 151–154 行），返回本次新增的 progress 快照）；`get progress`（第 159–161 行，只读）；`markCancelled()`（第 164–166 行）；`end()`（第 169–184 行，把残留半行记 `not-json`，幂等，返回 `{ result, progress, errors, violations, cancelled, endedWithResult, ended }`）。
- `spawnPlan(engine, cwd, env)`（第 189–199 行）：把引擎命令描述规范成 spawn 参数，要求 `engine.command` 非空。
- `tail(text, max)`（第 201–204 行）：截断 stderr 尾部。
- `runEngine(options)`（第 223–422 行）：跑一次引擎动作并归一成 `EngineResult`。参数（第 209–222 行）：`engine`、`requestId`、`action`（`doctor`/`generate`/`update`/`cancel` 其一，否则抛，第 227–229 行）、`payload`、`cwd`、`env`、`timeoutMs`（默认 600000）、`signal`、`onProgress`、`onLog`、`maxLineBytes`、`graceMs`。
  - 起进程用 `spawn`（第 288–295 行），POSIX 上 `detached: true` 以便按进程组整组打掉，Windows 走 `taskkill /T`。
  - 请求行：写一行 JSON + 换行后关 stdin（第 324–329 行）。
  - `finish`/`fail`（第 253–277 行）：统一出口，附加 `contractVersion`/`requestId`/`action`/`protocolViolations`/`exitCode`/`exitSignal`/`terminated`/`stderrTail`/`durationMs`/`startedAt`/`finishedAt`（第 258–271 行）。
  - 竞速 `exited`/`timeout`/`abort`/`spawnError`（第 311–359 行）。
  - 协议不变量（第 13–20 行 + 实现）：① stdout 只 JSON-lines，非 JSON 记 `not-json` 不丢结果；② `requestId` 必须匹配，否则 `unknown-request`；③ 没有 `result` 消息 = 协议破坏，退出码 0 也判失败（第 403–414 行，`engine-crashed`/`engine-protocol`，stderr 进 message）；④ 退出码只表达进程层，语义以 `result` 为准（第 416–421 行，非零退出记 `nonzero-exit` 违规但保留语义）；⑤ 取消后到达 result 记 `late-result`（第 376–391 行，`cancelled` 终态）；⑥ 重复 result 先到赢。
  - 超时（第 368–374 行）：`engine-timeout` + 终止进程树；spawn 失败 ENOENT → `engine-missing`（第 362–366 行）。
- 默认导出 `{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`（第 424 行）。

### `lib/engine/process-tree.js` —— 受管子进程树终止（阶段 1C）

- `IS_WINDOWS`（第 18 行）。
- `run(command, args)`（第 20–32 行）：内部 helper，跑一个终止命令（taskkill / 探测），统一返回 `{ code, error? }`。
- `isAlive(pid)`（第 41–49 行）：用 `process.kill(pid, 0)` 探测存活，EPERM 也算活着。
- `terminateProcessTree(pid, options)`（第 61–103 行）：终止一棵受管子进程树。Windows 走 `taskkill /T /F`（第 72–80 行）；POSIX 先 `SIGTERM` 整组（负 pid，第 85 行，退化只打自己），宽限 `graceMs`（默认 3000）后 `SIGKILL`（第 94–102 行）。返回 `{ ok, rootAlive, method }`，`ok=false` 表示根进程超时仍活着。

### `lib/engine/python/entry.py` —— Python 薄入口（生产者端）

- `PROTOCOL_VERSION = 1`（第 94 行）、`ACTIONS`（第 95 行）、模型通道环境变量名 `CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`/`CODEWIKI_MAIN_MODEL`/`CODEWIKI_CLUSTER_MODEL`（第 98–101 行）。
- **协议流守卫 `_ProtocolOnly`**（第 59–92 行）：在 import codewiki 之前替换 `sys.stdout`，普通 write/flush 全部改道 stderr，只有 `emit` 走真 stdout（`_REAL_STDOUT`，第 48 行）。防止 FSoft 的 `print`/click 缓存污染协议流。
- `emit(obj)`（第 104–108 行）：写一行协议 JSON 到真 stdout。
- `emit_hello()`（第 111–112 行）、`emit_progress(...)`（第 115–128 行，阶段名走契约枚举）、`emit_result(request_id, result)`（第 131–132 行）、`failure(code, message, stage, request_id)`（第 135–153 行，构造 failed 终态，message 绝不拼凭证）。
- `action_doctor`（第 198–237 行）：环境可信性，跑 `pip check`（`_pip_check`，第 176–195 行），不闭合报 `engine-deps`。
- `_model_config()`（第 243–275 行）：从进程环境读模型通道，缺项报 `engine-model`；错误信息只说「环境变量」不打印值（防密钥进日志）。
- `bridge_progress(adapter, request_id, on_stage)`（第 281–332 行）：替换 FSoft `ProgressTracker` 的三个方法，把五段进度旁路成协议行，`on_stage` 记录最后一个真实到达阶段。
- `action_generate`（第 384–472 行）：跑 FSoft generate/update，异常翻成契约终态；`SystemExit(0)`（无变更）视为正常 done；`_count_docs`（第 338–363 行）递归清点产物页数（排除 `temp/` 与 `.` 开头目录）。
- `_done_result`/`_classify_exception`/`_cancelled_result`（第 475–546 行）：构造 done/按异常类型分类（不按文本）/cancelled 终态。
- `handle_request`（第 552–574 行）/`main`（第 577–590 行）：读 stdin 一行请求 → 派发 action → `emit_result`；非法 action/JSON 回 `engine-protocol` 失败。

### `lib/engine/python/stage_map.py` —— 五段→八段映射

- `ENGINE_STAGES`（第 20–29 行）：必须与 `contract.js` 的 `ENGINE_STAGES` 完全一致（测试双向对账）。
- `FSOFT_STAGE_NAMES`/`FSOFT_STAGE_WEIGHTS`（第 33–46 行）：FSoft 五段镜像。
- `FSOFT_TO_ENGINE`（第 50–56 行）：五段→四段（4/5 都落 `validate`）。
- `FSOFT_PROGRESS_CEILING = 90`（第 63 行）：引擎内部进度只占到 90%，剩 10% 留给 Node 侧收尾。
- `map_stage(fsoft_stage)`（第 66–72 行）、`percent_of(fsoft_stage, stage_progress)`（第 75–97 行）：纯函数映射。

### `lib/engine/native-run.js` —— 生产编排（消费端 + 裁决）

- `DEFAULT_ENGINE_ENTRY`（第 34 行）、`DEFAULT_ENGINE_TIMEOUT_MS = 45*60*1000`（第 38 行）。
- `RANK`/`weakest`（第 41–42 行）：终态强弱排序 `cancelled(0) < failed(1) < partial(2) < done(3)`，**合成终态只能取最弱**，绝不允许被后续步骤提升。
- `runNativeJob({ repoRoot, scope, kind, requestId, signal, timeoutMs, ... })`（第 68–488 行）：编排一次完整编译。`settle(patch)`（第 97–124 行）统一出口，必过 `engineResult()` 保证不变量；`canAdvanceBaseline` 仅 `done` 为真。硬不变量（第 1–18 行）：① 锁不一致/依赖不闭合 → 直接 failed 不跑引擎；② 引擎 done 不能替代质量门；③ 落地器说 partial/failed 终态不许 done；④ partial/failed 不推进基线；⑤ 取消是终态。

### `lib/update-record.js` —— 终态文案同口径（相邻模块）

- `TERMINAL`（第 24 行）、`judgeOutcome(...)`（第 37 行起）：从逐篇结果与计划算终态（Node 旧路径）。
- `describeOutcome(outcome, blockers)`（第 241–253 行）：面板文案，与 contract 的 `describeEngineResult` 同一口径。

## Architecture

```text
                  Node 侧 (lib/engine/client.js + contract.js)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  runEngine() ── spawn 受管进程树 ──┐                                 │
 │      │                              ▼                                │
 │      │                     createProtocolReader()                    │
 │      │                       push(stdout bytes)                      │
 │      │                          │                                    │
 │      │            ┌─────────────┴─────────────┐                     │
 │      │            ▼             ▼              ▼                     │
 │      │      engineProgress  engineError   engineResult              │
 │      │      (contract.js)  (contract.js)  (contract.js)             │
 │      └── timeout/abort/signal ─► terminateProcessTree()            │
 │                  (process-tree.js, 整组 SIGTERM→SIGKILL)            │
 │                                                                        │
 │  runNativeJob() (native-run.js): doctor+lock → 引擎 → 质量门 → 落地器 │
 └──────────────────────────────│ stdin / stdout (JSON-lines) ─────────┘
                                │
                Python 侧 (lib/engine/python/entry.py)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  _ProtocolOnly 守卫 sys.stdout（防 FSoft print 污染协议流）            │
 │      │                                                                │
 │      ▼                                                                │
 │  emit_hello / emit_progress / emit_result  ──► 真 stdout             │
 │      ▲                                                                │
 │      │ bridge_progress() 替换 ProgressTracker 三方法                 │
 │      │ stage_map.py: FSoft 5段 ──► 引擎 8段（ceil 90%）              │
 │      ▼                                                                │
 │  CLIDocumentationGenerator.generate() (FSoft 原生引擎)              │
 └──────────────────────────────────────────────────────────────────────┘
```

## Data Flow

一次 `generate` 的完整数据流（行号指向关键实现）：

1. **请求发出**：`runEngine` 写一行 `{ requestId, action, ...payload }` + 换行并关 stdin（`lib/engine/client.js` 第 324–329 行）；Python 侧 `main()` 读 stdin 一行 → `handle_request` 派发（`lib/engine/python/entry.py` 第 577–590 行）。
2. **握手**：Python 先 `emit_hello()`（第 111–112 行），`createProtocolReader.handleLine` 校验 `protocolVersion`，不符记 `protocol-version`（`lib/engine/client.js` 第 74–80 行）。
3. **进度流**：FSoft `ProgressTracker` 被 `bridge_progress` 替换（第 281–332 行），经 `stage_map.py` 把五段翻成八段契约（`map_stage`/`percent_of`，`stage_map.py` 第 66–97 行），通过 `emit_progress` 逐条 `engineProgress()` 入 `reader.progress`（`lib/engine/client.js` 第 88–96 行），`runEngine` 通过 `onProgress` 实时回调（第 246–251 行、第 276–281 行）。
4. **终态流**：FSoft 跑完或异常 → `action_generate` 构造 `_done_result` / `_classify_exception`（按**异常类型**分类，第 499–526 行）/ `_cancelled_result`，经 `emit_result` 发出（第 131–132 行）。`reader` 收到 `result` 调 `engineResult()` 归一成终态（第 114–121 行）。
5. **收尾与归一**：`runEngine` 等 stdout `end` → `reader.end()`（第 401 行）；无 `result` → 判 `engine-crashed`/`engine-protocol` 并把 stderr 尾部塞进 message（第 403–414 行）；非零退出记 `nonzero-exit` 但不改语义（第 416–421 行）。最终 `finish()` 附加 `exitCode`/`stderrTail`/`protocolViolations` 等（第 253–272 行）。
6. **裁决（生产通道）**：`runNativeJob` 把 `runEngine` 的 `EngineResult` 与质量门（quality-gate.js）、落地器（apply-plan.js）结论用 `weakest()` 合成最弱终态（第 401–418 行），`settle()` 再过 `engineResult()` 强制不变量（第 113 行）。

**取消路径**：`AbortSignal` 触发 → `reader.markCancelled()`（第 377 行）→ `killTree()` 终止进程树（`lib/engine/process-tree.js`）→ 取消后到达的 `result` 记 `late-result` 并丢弃（第 105–109 行）→ 终态 `cancelled`，写入数只取已确认进度（第 382–390 行）。

## Connections

- [[engine_native_run]] / `lib/engine/native-run.js`：本模块最高层消费方。`runNativeJob` 调 `runEngine` 拿 `EngineResult`，再与质量门、落地器合成最弱终态（第 68–488 行）。
- [[engine_process_tree]] / `lib/engine/process-tree.js`：`runEngine` 在超时/取消时调 `terminateProcessTree` 整组杀掉 Python 子进程树（`lib/engine/client.js` 第 331–344 行）。
- [[engine_quality_gate]] / `lib/engine/quality-gate.js`：`runNativeJob` 把引擎产物送进 `gateNativeOutput`，其 `toContractBlockers` 把门拦下的页翻成契约 `BLOCKER_KINDS`（native-run.js 第 29、407 行）。
- [[engine_apply_plan]] / `lib/engine/apply-plan.js`：落地器（写盘→index→基线→提交）结论进终态 `apply` 字段，partial/failed 一律不推进基线（native-run.js 第 30、365–373 行）。
- [[engine_manifest]] / `lib/engine/manifest.js`：doctor 与引擎锁校验在 `runNativeJob` 第 1 步做，锁不一致直接 failed 不跑引擎（native-run.js 第 28、169–218 行）。
- [[engine_llm_bridge]] / `lib/engine/llm-bridge.js`：`runNativeJob` 第 2 步起模型桥，给 Python 入口注入 `CODEWIKI_*` 模型通道环境变量（entry.py 第 98–101、243–275 行；native-run.js 第 31、239–248 行）。
- [[update_record]] / `lib/update-record.js`：旧（非原生）通道的终态判定与文案，`describeOutcome` 与 `describeEngineResult` 同一口径（update-record.js 第 241–253 行；contract.js 第 223–240 行）。
- [[engine_mapping]] / `lib/engine/mapping.js`：产物（pages/moduleTree）到 CodeWiki.md / .codewiki/ 的映射，由 `test-engine-contract.mjs` 与契约一起钉死（test-engine-contract.mjs 第 196–334 行）。

## Known Issues

- **Windows 路径/编码**：`entry.py` 在 import codewiki 前把 stdout/stderr 重设成 UTF-8（`entry.py` 第 52–56 行），否则中文错误过管道是乱码；`test-engine-client.mjs` 第 348–360 行专门测了 cwd 含中文与空格路径。POSIX 依赖 `detached: true` 才能整组 kill（`client.js` 第 294 行），非 detached 起的进程会退化成只打自己（`process-tree.js` 第 87–88 行）。
- **协议破坏必须响而非静默**：半行 JSON（进程中途死）在 `end()` 时被记 `not-json` 且 `result=null`（`client.js` 第 64–71、169–174 行）；缺 `result` 消息即使退出码 0 也判 `engine-protocol`（`client.js` 第 403–414 行，`test-engine-client.mjs` 第 265–269 行）。
- **语义 vs 退出码**：退出码只表达进程层，语义以 `result` 为准。退出码 0 + 语义 failed 仍是失败，语义 done + 退出码非 0 保留 done 并记 `nonzero-exit`（`client.js` 第 16–18、416–421 行；`test-engine-client.mjs` 第 271–283 行）。Python 侧协议破坏特意用「0 退出 + failed result」表达（`entry.py` 第 31–36 行）。
- **取消终态不可被洗白**：取消后到达的 `result` 记 `late-result` 并丢弃（`client.js` 第 105–109 行）；`runNativeJob` 在 apply 期间被 abort 时，cw 子进程被杀会让 index/基线失败回滚，仍如实报 `cancelled` 而非编译失败（`native-run.js` 第 388–398 行）。
- **进度上限刻意 90%**：`stage_map.FSOFT_PROGRESS_CEILING = 90`（`stage_map.py` 第 63 行），引擎内部进度只报到 90%，避免「引擎说 100% 但 wiki 还没索引/没提交」的假完成；`index/baseline/commit` 三段由 Node 侧 `runNativeJob` 在进度 92→95→99 推进（`native-run.js` 第 335、363、421 行）。
- **依赖不闭合即失败**：`runNativeJob` 在 `doctor`/`pip check` 不闭合时直接 failed（code `engine-deps`），绝不降级跑旧实现或先跑再发现环境漂了（`native-run.js` 第 205–218 行；`entry.py` 第 198–216 行）。
- **无「被禁用/注释」代码**：本模块全部为活跃实现；`entry.py` 的 `cancel` action 仅处理「请求已受理但未开始跑」的场景，真实取消由 Node 侧 `terminateProcessTree` 完成（`entry.py` 第 567–571 行）。
