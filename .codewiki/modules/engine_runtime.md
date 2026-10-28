---
title: engine_runtime
type: module
source_files:
  - lib/engine/client.js
  - lib/engine/manifest.js
  - lib/engine/process-tree.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-manifest.mjs
  - test-engine-process-tree.mjs
  - test-engine-client.mjs
tags: [engine, process, manifest, process-tree, protocol, python-bridge]
---

## Overview

`engine_runtime` 是 CodeWiki 阶段 2 迁移里**唯一的跨语言边界**所在地，负责三件事：

1. **Engine process spawning（进程拉起）**：把 FSoft 原生 Python 引擎作为受管子进程拉起，
   写一行请求 JSON 到它的 stdin，从它的 stdout 读回 JSON-lines 协议（见
   `lib/engine/client.js` 的 `runEngine`，第 223 行起）。
2. **Environment manifest（环境清单）**：探测引擎版本、Python 版本、依赖闭合状态，
   算出稳定指纹，与落盘的 `.codewiki/engine-lock.json` 比对，报告「环境有没有漂」
   （见 `lib/engine/manifest.js` 的 `doctor` / `probeEnvironment` / `compareLock` /
   `writeLock`）。FSoft 是外部引擎，版本与依赖不由本仓库控制；没有清单的话，
   产物变化会被误诊成「模型不听话」而不是「环境漂了」。
3. **Process tree control（进程树管控）**：取消/超时/崩溃时杀掉整棵受管子进程树
   （包括引擎自己派生的 flake8 / find / claude / codex 等孙进程），而不是只杀直接子进程
   —— 否则孙进程变孤儿，在机器上继续烧 token（见 `lib/engine/process-tree.js`
   的 `terminateProcessTree` / `isAlive`）。

这三者通过 `lib/engine/client.js` 串起来：`runEngine` 用 `spawn`（`lib/engine/client.js:288`）
拉起 Python 入口 `lib/engine/python/entry.py`，通过 `spawnPlan`（`lib/engine/client.js:189`）
把 `{command, args, env, cwd}` 规范成 spawn 参数；取消/超时路径调用 `terminateProcessTree`
（`lib/engine/client.js:336`）；`doctor` 动作则把进程内的 `probe` 结果交给 `manifest.js`
做指纹与比对。协议本身由 `lib/engine/contract.js` 定义（`EngineResult` / `EngineProgress` /
`EngineError`），Python 侧的进度翻译由 `lib/engine/python/stage_map.py` 与 `entry.py` 的
`bridge_progress` 完成。模型通道由 `lib/engine/llm-bridge.js` 以 loopback 桥注入，密钥只活在
进程环境变量里。

## Key Components

### lib/engine/client.js — Node↔Python 薄适配层

- `ENGINE_PROTOCOL_VERSION` — 常量，第 27 行；协议（行格式）版本，独立于结果契约版本 `ENGINE_CONTRACT_VERSION`。
- `DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024` — 第 29 行；单行字节上限，防引擎失控吐超长行吃内存。
- `DEFAULT_STDERR_TAIL = 4000` — 第 30 行；stderr 尾部截取长度。
- `createProtocolReader(options)` — 第 39 行；增量式 JSON-lines 读取器（纯逻辑，不碰进程），可被逐字节喂以模拟管道任意切分。返回对象含：
  - `push(chunk)`（第 133 行）— 按字节缓冲 stdout，多字节 UTF-8 跨 chunk 不切坏；返回本次新解析出的 progress 快照（供实时回调）；单行超过 `maxLineBytes` 记 `line-too-long` 违规（第 143、151 行）。
  - `get progress`（第 159 行）— 已解析进度快照（只读）。
  - `markCancelled()`（第 164 行）— 声明进入取消态，此后到达的 `result` 一律记 `late-result`（第 107 行）。
  - `end()`（第 169 行）— 收尾，把残留半行当 `not-json` 违规；返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`（第 175-183 行）。
  - 内部 `handleLine`（第 56 行）对每条消息分类：校验 `protocolVersion`（第 76 行 `hello`）、按 `requestId` 关联（第 83 行，不匹配记 `unknown-request`）、`progress`（第 88 行）、`error`（第 98 行，语义失败）、`result`（第 104 行，迟到/重复分别记 `late-result` / `duplicate-result`）。
- `spawnPlan(engine, cwd, env)` — 第 189 行；把 `{command, args, env, cwd}` 规范成 spawn 参数，合并 `process.env` + `engine.env` + `env`（第 197 行）。缺 `command` 抛错（第 192 行）。
- `tail(text, max)` — 第 201 行；截取 stderr 尾部。
- `runEngine(options)` — 第 223 行；跑一次引擎动作并归一成 `EngineResult`。关键参数：
  - `options.engine`（`{command, args?, env?, cwd?}`）、`requestId`、`action`（`'doctor'|'generate'|'update'|'cancel'`，第 227 行校验）、`payload`、`cwd`、`env`、`timeoutMs`（默认 600000，第 230 行）、`signal`（`AbortSignal`）、`onProgress`、`onLog`、`maxLineBytes`、`graceMs`。
  - 进程拉起用 `spawn`，POSIX 上 `detached: true` 自建进程组（第 288-295 行）。
  - `killTree`（第 331 行）调用 `terminateProcessTree(child.pid, ...)`（第 336 行），根进程仍存活则记日志错误（第 340 行）。
  - 终态判定：超时走 `killTree('timeout')` 并回 `engine-timeout`（第 368-374 行）；abort 走 `reader.markCancelled()` + `killTree('abort')` 回 `cancelled`（第 376-391 行）；正常退出后若无 `result` 则按 退出码 0/非0 分回 `engine-protocol` / `engine-crashed`（第 403-414 行）；退出码非 0 但语义 done 记 `nonzero-exit` 违规（第 417-419 行）。
  - 返回值统一经 `finish`/`fail`（第 253、274 行）补上 `contractVersion` / `requestId` / `action` / `protocolViolations` / `exitCode` / `exitSignal` / `terminated` / `stderrTail` / `durationMs` / `startedAt` / `finishedAt`。
- 默认导出对象：`{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`（第 424 行）。

### lib/engine/manifest.js — 环境指纹与比对

- `MANIFEST_VERSION = 1` — 第 19 行；写入 lock 的清单版本。
- `ENGINE_LOCK_REL = '.codewiki/engine-lock.json'` — 第 20 行；lock 相对仓库根的路径。
- `probeEnvironment({ probe, engineRoot })` — 第 34 行；调用传入的 `probe()`（纯函数注入，进程管理留在 `client.js`）收集 `{version, pythonVersion, pipCheckOk, pipCheckOutput, engineRoot}` 并算 `fingerprint`（第 44 行）。缺 `probe` 函数直接抛错（第 35 行）。
- `fingerprintOf(facts)` — 第 50 行；SHA-256 取前 16 位。只吃 `manifest:<v>` + `version` + `python` 三项；**pip check 的 ok 不进指纹**（第 47-49 行，修依赖不算换引擎）。
- `readLock({ repoRoot })` — 第 61 行；读落盘 lock，不存在/坏 JSON 返回 `null`（第 66、72 行，首次运行本就没有 lock）。
- `compareLock({ current, lock })` — 第 86 行；返回 `{status, diffs, current, locked}`。`status` 取值：
  - `'absent'` 无 lock（第 89 行）；`'match'` 完全一致（第 110 行）；
  - `'drift'` 引擎或 Python 版本变了（第 94-99 行；仅两者都一致但指纹不一致时记 `fingerprint` diff，暗示算法变了，第 100-103 行）；
  - `'unhealthy'` 指纹一致但 `pipCheckOk !== true`（第 104-106 行，能跑但不可信）。
- `writeLock({ repoRoot, current })` — 第 117 行；原子写（先 `${file}.${pid}.tmp` 再 `renameSync`，第 131-133 行）。写入字段：`manifestVersion` / `fingerprint` / `version` / `pythonVersion` / `engineRoot` / `pipCheckOk` / `recordedAt`（ISO 时间戳，第 122-130 行）。缺 `repoRoot` 或 `fingerprint` 抛错（第 118-119 行）。
- `doctor({ probe, repoRoot, engineRoot })` — 第 141 行；一次调用判出「引擎在不在、环境闭不闭合、和上次比有没有漂」。返回 `{ok, status, current, diffs, advice}` 且**不抛**（probe 抛错变 `ok:false, status:'probe-failed'`，第 142-153 行）。`ok` 仅在 `match` / `absent` 时为 true（第 164 行）；`advice` 文案按 status 映射（第 156-162 行，unhealthy 建议指向 `tools/fsoft-engine/setup-env.sh`）。
- 默认导出：`{ MANIFEST_VERSION, ENGINE_LOCK_REL, probeEnvironment, fingerprintOf, readLock, compareLock, writeLock, doctor }`（第 172 行）。

### lib/engine/process-tree.js — 受管进程树终止

- `IS_WINDOWS = process.platform === 'win32'` — 第 18 行。
- `run(command, args)` — 第 20 行；内部用 `spawn(..., {windowsHide:true, stdio:'ignore'})` 跑 `taskkill`，返回 `{code, error}`（成功/失败都 resolve，不 reject）。
- `isAlive(pid)` — 第 41 行；用 `process.kill(pid, 0)` 做存在性探测：活着或 `EPERM`（无权限但存在）返回 true，非整数/≤0/已退出返回 false。
- `terminateProcessTree(pid, options)` — 第 61 行；终止整棵树。返回 `{ok, rootAlive, method}`。
  - 非法 pid 是 `noop`（第 65-67 行）；已退出是 `already-exited`（第 68-70 行）。
  - Windows：`taskkill /T /F /PID <pid>` 递归整棵（第 72-80 行）。
  - POSIX：先 `process.kill(-pid, 'SIGTERM')` 打整进程组，宽限 `graceMs`（默认 3000，第 62 行）后若仍活则 `process.kill(-pid, 'SIGKILL')`（第 82-102 行）；非 detached 起的进程退化成只打自己 pid（第 86-88、97-99 行）。
- `waitForDeath(pid, timeoutMs)` — 第 105 行；每 25ms 探测一次，超时返回最终 `!isAlive(pid)`。

### lib/engine/contract.js — 跨进程结果契约

- `ENGINE_CONTRACT_VERSION = 1` — 第 20 行；结果契约版本。
- `ENGINE_STAGES` — 第 24 行；八段阶段枚举（`env/graph/cluster/articles/validate/index/baseline/commit`），顺序即推进顺序，是面板步骤条、job.stage、取消检查点共同依据。
- `TERMINAL_OUTCOMES = ['done','partial','failed','cancelled']` — 第 35 行。
- `BLOCKER_KINDS` — 第 42 行；阻塞原因类别（机读、可追加不可改名）。
- `ENGINE_ERROR_CODES` — 第 57 行；错误码（`engine-missing` / `engine-deps` / `engine-timeout` / `engine-cancelled` / `engine-crashed` / `engine-protocol` / `engine-model` / `engine-output` / `engine-unknown`），`RETRYABLE_CODES` 仅含 timeout/model/unknown（第 71 行）。
- `engineResult(input)` — 第 97 行；构造一次结果，硬不变量：`done` 不许带 blockers、`partial` 必须带 blockers、`failed` 必须带 error（第 103-112 行）；返回对象含 `engine`（version/commit/python/deps）与 `artifacts`（docsDir/rawTreeDir/updateRecord）等字段（第 113-146 行）。
- `engineProgress(input)` — 第 150 行；推进快照（stage/percent/message/writtenCount/...），`at` 时间戳。
- `engineError(input)` — 第 171 行；可机读失败事实，`retryable` 由 code 决定，未登记 code 归 `engine-unknown` 并保留 `rawCode`。
- `validateEngineResult(value)` — 第 186 行；反序列化边界上的不信任校验，返回 `{ok, errors}` 不抛。
- `describeEngineResult(result)` — 第 223 行；四态中文文案。

### lib/engine/llm-bridge.js — 模型 loopback 桥（与进程 env 注入相关）

- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })` — 第 90 行；启动 `127.0.0.1` + 随机端口 + 占位 key（`dsh-bridge-${randomBytes(32).toString('hex')}`，第 96 行）的 HTTP 桥，把引擎的 OpenAI-compatible 请求翻译成宿主 `llm.stream`。所有 `/v1` 请求必须带占位 key 校验（第 118-125 行）。日志只记 method/path/status/耗时，**不记** Authorization（第 103-109 行）。返回 `{url, placeholderKey, port, close(), stats()}`。
- `bearerOf(req)` — 第 38 行；只取 bearer token 用于校验，取完即弃。
- 凭证边界：桥不读凭证文件、不收真实 api_key、不转发 Authorization；引擎只拿到 `http://127.0.0.1:<port>/v1` 与占位 key（见 `entry.py` 的 `ENV_BASE_URL` / `ENV_API_KEY` / `ENV_MAIN_MODEL` / `ENV_CLUSTER_MODEL`，第 98-101 行）。

### lib/engine/python/entry.py — FSoft 原生引擎 JSON-lines 入口

- `_REAL_STDOUT = sys.stdout`（第 48 行）+ `_ProtocolOnly`（第 59 行）：在 import codewiki 之前把 `sys.stdout` 换成只放行协议写的守卫，**其余一律改道 stderr**（第 92 行），防止 FSoft 的 `print`/`click.secho` 污染协议流（click 缓存了 stdout 包装器，事后替换来不及）。
- 常量：`PROTOCOL_VERSION = 1`（第 94 行）、`ACTIONS = ("doctor","generate","update","cancel")`（第 95 行）、`ENV_BASE_URL/ENV_API_KEY/ENV_MAIN_MODEL/ENV_CLUSTER_MODEL`（第 98-101 行）。
- `emit/emit_hello/emit_progress/emit_result/failure` — 第 104-153 行；协议写出与 `failed` 终态构造（`failure` 的 message 不拼凭证内容，第 136 行）。
- `_engine_version()`（第 159 行）、`_pip_check(timeout=120)`（第 176 行，跑 `pip check` 作为依赖闭合门禁）。
- `action_doctor(request_id, payload)` — 第 198 行；探测版本 + `pip check`，失败回 `engine-missing`/`engine-deps`，成功回 `done` 且带 `engine.deps` 证据（第 209-234 行）。
- `_model_config()` — 第 243 行；从进程环境读模型通道，缺任一项回 `(None, 原因)`；显式给 `fallback_model` 否则 FSoft 会在 graph 阶段 `AttributeError`（第 263-275 行）。错误信息只说「环境变量」不打印值。
- `bridge_progress(adapter, request_id, on_stage)` — 第 281 行；**替换** `adapter.progress_tracker` 的 `start_stage/update_stage/complete_stage`，把事件转成协议行并记「最后一个真实到达的阶段」（第 301-332 行）。用替换而非继承，因为 FSoft 在 `__init__` 里直接 `ProgressTracker(total_stages=5)` 没有注入点。
- `action_generate(request_id, payload, is_update=False)` — 第 384 行；准备 config → 跑 `CLIDocumentationGenerator` → 把异常翻成契约终态。`_count_docs`（第 338 行，递归清点、排除 `temp/` 与 `.` 目录）、`_git_commit`（第 366 行）、`_done_result`（第 475 行）、`_classify_exception`（第 499 行，按异常**类型**分码而非消息文本）、`_cancelled_result`（第 529 行）。
- `handle_request(msg)`（第 552 行）、`main()`（第 577 行，读 stdin 一行 JSON、回 `result`、退出码只表达进程层）。

### lib/engine/python/stage_map.py — 五段→八段映射

- `ENGINE_STAGES`（第 20 行，必须与 `contract.js` 一致）、`FSOFT_STAGE_NAMES`/`FSOFT_STAGE_WEIGHTS`（第 33-46 行）、`FSOFT_TO_ENGINE`（第 50 行，1→graph / 2→cluster / 3→articles / 4-5→validate）、`DEFAULT_ENGINE_STAGE = 'articles'`（第 60 行）、`FSOFT_PROGRESS_CEILING = 90`（第 63 行，引擎内部进度只到 90%，剩 10% 留给 Node 侧收尾）。
- `map_stage(fsoft_stage)`（第 66 行）、`percent_of(fsoft_stage, stage_progress)`（第 75 行，权重同构于 FSoft 的 `get_overall_progress`，夹到 [0,100]）。

## Architecture

```
┌─────────────────────────── Node 宿主 (lib/engine/client.js) ───────────────────────────┐
│  runEngine() 第223行                                                                   │
│   spawnPlan() 第189行 ──► spawn(python entry, detached, env) 第288行                    │
│        │                          │   stdin: 1行请求JSON                               │
│        │                          ▼                                                      │
│        │            ┌──────────── Python entry.py 第1行 ────────────┐                   │
│        │            │ _ProtocolOnly 守卫stdout(第92行)              │                   │
│        │            │ action_doctor / action_generate 第198/384行   │                   │
│        │            │ bridge_progress 第281行 → stage_map.py        │                   │
│        │            │ emit() → 真stdout (JSON-lines)                │                   │
│        │            └───────────────────┬──────────────────────────┘                   │
│        │  stdout(JSON-lines)            │ llm-bridge 模型调用 loopback                   │
│        ▼                                ▼                                                │
│  createProtocolReader() 第39行    startLlmBridge() 第90行 (127.0.0.1:随机端口+占位key)    │
│        │                          env: CODEWIKI_BASE_URL/API_KEY/MAIN_MODEL 第98-101行   │
│  doctor / manifest.js 第141行 ◄── probe(probeEnvironment 第34行)                         │
│        │                                                                               │
│  terminateProcessTree() 第61行 ◄── killTree() 第331行 (超时/abort/crash)                  │
└────────┼───────────────────────────────────────────────────────────────────────────────┘
         ▼
  process-tree.js: SIGTERM(-pid) → SIGKILL(-pid) [POSIX] / taskkill /T /F [Win]
```

组件职责边界（故意窄）：

- **`client.js`**：进程 + 协议，唯一跨语言边界；不实现聚类/图 diff/文章写作，不读凭证、不连模型、不写 `.codewiki`。
- **`manifest.js`**：只读诊断（指纹/比对/落盘）；不装依赖、不修环境、不联网。
- **`process-tree.js`**：只做「终止」一件事，不做进程启动、不做协议、不碰 stdout。
- **`contract.js`**：纯数据校验，不碰文件/进程/模型。
- **`entry.py`**：只做请求解析/进度翻译/终态翻译/守住凭证红线；不实现引擎算法本身（依赖图/聚类/写作都在 FSoft 内部）。
- **`stage_map.py`**：Node 与 Python 唯一共享的枚举口径（八段集合与 `contract.js` 双向对账）。

## Data Flow

**一次 `runEngine({action:'generate'})` 的生命周期：**

1. `runEngine` 校验 `requestId` 与 `action`（第 224-229 行），构造 `createProtocolReader`（第 236 行）。
2. `spawnPlan` 把 `engine` 描述规范成 spawn 参数，合并环境变量（第 281、189 行）。`spawn` 拉起 Python 入口，POSIX 上 `detached:true`（第 288-295 行）。
3. 写一行请求 JSON 到 stdin 后 `end()`（第 325-326 行）：`{requestId, action, ...payload}`。
4. Python 侧 `main()` 读 stdin 第一行 → `handle_request` → `action_generate`；`bridge_progress` 把 FSoft 五段进度翻译成八段契约经 `emit` 写真 stdout（第 577-589、281 行）。
5. Node 侧 `child.stdout.on('data')` 喂给 `reader.push`，实时 `flushProgress` 回调 `onProgress`（第 300-303 行）。
6. 终态由 `Promise.race([exited, timeout, abort, spawnError])` 决定（第 359 行）：
   - 正常退出 → 等 stdout `end` → `reader.end()`；有 `result` 则 `finish(seen.result)`（第 401-421 行）；无 `result` 则回 `engine-protocol`/`engine-crashed`（第 403-414 行）。
   - 超时 → `killTree('timeout')` + `engine-timeout`（第 368 行）。
   - abort → `markCancelled()` + `killTree('abort')` + `cancelled`（第 376 行）。
7. `finish`/`fail` 补上 `contractVersion`/`exitCode`/`stderrTail`/`durationMs` 等元信息（第 253-277 行）。

**`doctor` 流程（环境可信性）：**

1. Node 侧 `runEngine({action:'doctor'})` 或独立 `doctor({probe, repoRoot})`。
2. Python 侧 `action_doctor` → `_engine_version()` + `_pip_check()`（第 198-237 行），回带 `engine.deps` 的 `done` 或 `engine-deps` 失败。
3. `probeEnvironment` 把结果算成 `fingerprint`（第 44 行）；`readLock` 读落盘 lock；`compareLock` 返回 `absent/match/drift/unhealthy`（第 86 行）；`writeLock` 原子落盘（第 117 行）。

**取消/超时如何贯穿进程树：**

`killTree`（第 331 行）调用 `terminateProcessTree(child.pid)`，POSIX 上因 `detached:true` 起的进程自成一个进程组，`process.kill(-pid, ...)` 一次打整组（第 85、96 行）；宽限 `graceMs` 后仍活则 SIGKILL，并最终以 `rootAlive` 真实性回报（第 100-102 行）。Windows 用 `taskkill /T /F` 递归（第 75 行）。

## Connections

- [[engine_contract]] — `lib/engine/contract.js` 定义的结果/进度/错误契约，是 `client.js` 翻译与终态判定的依据（`engineResult`/`engineProgress`/`engineError`）。
- [[engine_bridge]] / [[llm_bridge]] — `lib/engine/llm-bridge.js` 把模型通道以 loopback + 占位 key 注入，`entry.py` 通过 `CODEWIKI_*` 环境变量消费；凭证只活在进程环境。
- [[engine_output]] — 产物落盘与映射（`output.js` / `mapping.js`）消费 `runEngine` 返回的 `EngineResult.artifacts`。
- [[engine_quality_gate]] — `validate` 阶段（契约八段之一）的质量门，由上游在引擎退出后或引擎内执行；`engine-error`/`quality-gate` 阻塞类别在 `contract.js` 定义。
- [[engine_apply_plan]] — 上层把 `doctor`/`generate`/`update` 动作编排进 apply-plan 流程，调用本模块的 `runEngine`。
- [[cluster]] / [[graph-diff]] / [[incremental]] — 引擎内部真正做聚类、图 diff、增量差异的能力在 FSoft（Python）侧，`entry.py` 只做薄适配。
- [[update-record]] — `entry.py` 产出/消费 `update_record.json`（`artifacts.updateRecord`），与 `lib/update-record.js` 的 `describeOutcome` 同一终态口径。

## Known Issues

- **stdout 协议流污染风险（结构性）**：FSoft 内部大量 `print`/`click.secho`，且 click 缓存 stdout 包装器，因此 `entry.py` 必须在 import codewiki 之前换掉 `sys.stdout`（第 19-92 行）。任何「事后才装守卫」的改法都会让日志混进协议流，触发 `not-json` 违规。这是已知脆弱点，不是 bug，但改 `entry.py` 顶部加载顺序时必须谨慎。
- **`fallback_model` 必须显式给**：`entry.py:_model_config` 若让 `fallback_model` 缺省为 None，FSoft 的 `create_fallback_models` 会在 `model_name.lower()` 上 `AttributeError`，崩在 graph 阶段开头，表现为 `engine-crashed` 而非可理解的模型错误（第 263-267 行）。已在 `_model_config` 用 `model` 兜底，但若上游改了默认值需注意。
- **进程组假设**：POSIX 上 `terminateProcessTree` 依赖 `client.js` 用 `detached:true` 起进程（第 294 行）；若未来把 `detached` 改掉，进程组信号会失效，代码已退化成单 pid 强杀（第 86-88 行），但孙进程隔离保障随之消失——这是行为依赖而非 bug。
- **`pipCheckOk` 不进指纹**：`fingerprintOf` 故意只吃版本 + Python（第 47-49 行）。后果是「依赖修好了但版本没变」会判 `match` 而非 `drift`，而「指纹一致但 pip 失败」才会被 `compareLock` 单独判成 `unhealthy`（第 104 行）。设计取舍，不是遗漏；上层若想让依赖变化也触发重写 lock，需改 `fingerprintOf`。
- **Windows 无进程组信号**：只能靠 `taskkill /T /F`（第 72-80 行），`/F` 不可省（GUI/无控制台进程不响应）。taskkill 返回后给 1s 回收窗口再判定 `rootAlive`（第 77 行），极端并发下仍可能误报 ok。
- **取消非终态竞态**：`markCancelled`（第 164 行）后再到的 `result` 记 `late-result` 并丢弃（第 107 行），但 `finish` 在 abort 分支用 `reader.end()` 重新收尾（第 381 行），存在「abort 与正常 exit 几乎同时」的极窄窗口，测试靠真实进程树覆盖（见 `test-engine-process-tree.mjs` 与 `test-engine-client.mjs`）。
- **`engine-lock.json` 不校验仓库隔离**：`readLock`/`writeLock` 按 `repoRoot` 定位 `.codewiki/engine-lock.json`（第 61、120 行）；若同一 `repoRoot` 下多个并发 doctor 写同文件，靠 `.${pid}.tmp` + `rename` 保证原子性（第 131-133 行），但并发读旧 lock 与写新 lock 之间没有更强的锁。
