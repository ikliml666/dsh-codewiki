---
title: engine_client_protocol
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-process-tree.mjs
tags: [engine, protocol, contract, client, process, cross-language, python]
---

## Overview

`engine_client_protocol` 是 FSoft 迁移后的**唯一跨语言边界**（Node ↔ Python），
位于 `lib/engine/`。它由三个源码文件构成，各司其职、边界故意收窄：

- `lib/engine/contract.js` —— 跨进程**数据契约**（阶段 0）。定义 `EngineResult` /
  `EngineProgress` / `EngineError` 三种纯数据结构，以及阶段枚举、阻塞原因类别、
  错误码、终态语义硬不变量。**只做纯数据校验，不碰文件、不碰进程、不碰模型**。
- `lib/engine/client.js` —— Node ↔ Python 的**薄适配层**（阶段 2）。负责：起一个
  受管子进程、写一行请求 JSON、读回 JSON-lines、把引擎消息翻译成 contract.js 的结构，
  并在超时/取消/崩溃/协议破坏时给出**可机读**失败，而不是抛一个模糊异常。
- `lib/engine/process-tree.js` —— 受管子进程树的**终止**（阶段 1C 第 3 条 /
  client.js 的地基）。只做「终止」一件事：取消时要整组（包括孙进程）打掉，
  不留孤儿进程。

为什么要这样切：迁移后 Node 不再自己算依赖图/聚类/增量，一切来自 Python 引擎的
一次返回。这条边界一旦含糊，后面每个消费方（JobService 终态判定、面板、cw 基线、
自动提交、降级提醒）都会各自猜「引擎到底成功了没有」——这正是 0.14.0 花一整轮修掉的
缺陷类型（1 篇成功 + 19 篇失败也报 done，见 `contract.js` 第 1–11 行注释）。所以就把
「三件事」用纯函数钉死在契约里，再用协议读取器在进程边界上强制执行。

测试策略（见 `test-engine-client.mjs` 第 1–16 行注释）：优先钉「协议破坏时会发生什么」，
而不是「正常路径能跑通」——因为正常路径有 1C 真实端到端兜底，而协议破坏（半行 JSON、
别人的 requestId、退出码 0 却报 failed）一旦被静默吞掉，表现是「wiki 编译成功但文章
没更新」，是最坏的错。

## Key Components

### 1. `lib/engine/contract.js` — 数据契约（阶段 0）

纯数据校验层，无副作用。所有公开符号见下。

**常量**

| 符号 | 行号 | 用途 |
|---|---|---|
| `ENGINE_CONTRACT_VERSION` | 20 | 结果契约版本号，当前固定为 `1`。`engineResult` / `engineProgress` / `validateEngineResult` 都会写入/校验它。 |
| `ENGINE_STAGES` | 24–33 | 阶段枚举（**契约不是实现细节**）：`env → graph → cluster → articles → validate → index → baseline → commit`。顺序即推进顺序，面板步骤条、`job.stage` 映射、取消检查点都按它对齐。`env` 在最前（解释器/依赖锁定校验），`commit` 在最后（自动提交）。 |
| `TERMINAL_OUTCOMES` | 35 | 终态集合 `['done','partial','failed','cancelled']`（frozen）。 |
| `BLOCKER_KINDS` | 42–53 | 阻塞原因类别（frozen，只追加不改名）：`article-failed` / `article-missing` / `unmapped-change` / `unmapped-page` / `quality-gate` / `index-failed` / `baseline-failed` / `commit-failed` / `engine-error` / `cancelled`。 |
| `ENGINE_ERROR_CODES` | 57–67 | 可机读错误码（frozen）：`engine-missing` / `engine-deps` / `engine-timeout` / `engine-cancelled` / `engine-crashed` / `engine-protocol` / `engine-model` / `engine-output` / `engine-unknown`。 |
| `RETRYABLE_CODES` | 71 | 可重试错误码集合：`engine-timeout` / `engine-model` / `engine-unknown`。其余一律视为确定性失败，重试只是浪费。 |

内部工具：`num(v)`（73–76，归一为非负有限数，否则 0）、`normalizeUsage(usage)`（78–86，
归一出 `{inputTokens,outputTokens,cachedTokens,requests}`）、`normalizeBlocker(b)`（88–94，
`kind` 不在 `BLOCKER_SET` 时降级为 `engine-error`，`detail` 截断 2000 字符，可选 `target`/`source`）。

**数据结构（字段全清单）**

`EngineResult`（由 `engineResult` 返回，113–146）：

- `contractVersion: number` — 恒为 `ENGINE_CONTRACT_VERSION`。
- `outcome: string` — 必为 `done/partial/failed/cancelled` 之一。
- `stage: string|null` — 引擎侧阶段终态（最后一个到达的 stage），非法时 `null`。
- `blockers: Blocker[]` — 阻塞原因数组（已归一化）。
- `error: EngineError|null` — `failed` 时必带。
- `writtenCount` / `failedCount` / `keptCount` / `removedCount` / `unmappedCount: number` — 计数，缺失即 0，负数归一为 0。
- `usage: {inputTokens,outputTokens,cachedTokens,requests}` — 归一化后的 token 用量。
- `engine: {version, commit, python, deps:{ok:boolean, summary:string}}` — 引擎版本/锁定信息。`deps.ok` 只有严格 `=== true` 才算通过（字符串 `"yes"` 也不行，见 `contract.js` 134 行 `ok: input?.engine?.deps?.ok === true`，及 `test-engine-contract.mjs` 99–100 行断言），`deps.summary` 截断 2000 字符；缺失时给 `{ok:false, summary:''}` 而非 `undefined`，避免序列化掉键。
- `artifacts: {docsDir, rawTreeDir, updateRecord}` — 产物位置（字符串）。
- `startedAt: string|null` / `finishedAt: string|null` — ISO 时间戳。

`Blocker`（由 `normalizeBlocker` 返回，88–94）：`kind`（必填，已校验）、`detail`（≤2000 字符）、可选 `target`、`source`。

`EngineProgress`（由 `engineProgress` 返回，150–168）：`contractVersion`、`stage`（必在枚举内，否则抛错）、`percent`（夹到 0–100 并取整）、`message`、`writtenCount`/`failedCount`/`totalCount`、`usage`、`at`（时间戳或 `null`）。字段只增不减，旧 job 缺字段按 0/null 解释。

`EngineError`（由 `engineError` 返回，171–182）：`code`（未登记码归为 `engine-unknown`）、`message`（≤4000 字符）、`stage`、`retryable`（布尔，来自 `RETRYABLE_CODES`）、可选 `rawCode`（仅当 `code==='engine-unknown'` 且原码非空，保留原文前 200 字符，便于排障而不改机读语义）。

**公开函数**

| 函数 | 行号 | 用途 |
|---|---|---|
| `engineResult(input={})` | 97–147 | 构造一次 generate/update 结果。**非法输入抛错而非静默归一**：`outcome` 非终态抛错（99–101）；`done` 带 blockers 抛错（103–105，自相矛盾）；`partial` 无 blockers 抛错（106–108，伪造成功）；`failed` 无 error 抛错（110–112）。 |
| `engineProgress(input={})` | 150–168 | 构造推进中快照；`stage` 非法抛错，`percent` 夹到 0–100。 |
| `engineError(input={})` | 171–182 | 构造可机读失败事实；未登记 `code` 落到 `engine-unknown`。 |
| `validateEngineResult(value)` | 186–220 | **不抛错**的边界校验，返回 `{ok, errors:[...]}`。检查 `contractVersion`、终态自相矛盾（done+blockers / partial-无blockers）、各计数非负有限、blockers 数组形状与 kind 登记、failed 必带 error。用于反序列化（磁盘残留/旧版本）边界，对象必须被检查而非被信任。 |
| `describeEngineResult(result)` | 223–240 | 终态文案（与 `lib/update-record.js` 的 `describeOutcome` 同一口径）：`done`→完成、`partial`→部分完成(带首个 blocker)、`failed`→失败(带 error.message)、`cancelled`→已取消。`null`/非对象返回「引擎结果不可读」。 |

**语义硬不变量**（由 `engineResult` 与 `validateEngineResult` 双重保证，见 12–17 行注释）：
`done`=完整成功不许带 blockers；`partial`=部分完成必须带至少一条 blockers；`failed`=失败必须带 error；`cancelled`=取消可带 blockers 说明已写成部分。

### 2. `lib/engine/client.js` — 协议读取器 + 进程适配（阶段 2）

跨语言薄适配层，唯一的 `spawn` 调用点（22、288 行）。

**常量/内部**

| 符号 | 行号 | 用途 |
|---|---|---|
| `ENGINE_PROTOCOL_VERSION` | 27 | 协议版本（独立于结果契约版本）：前者管「行怎么长」，后者管「结果字段」。当前 `1`。 |
| `DEFAULT_MAX_LINE_BYTES` | 29 | 单行上限 `4*1024*1024`，防引擎失控吐超长行吃内存。 |
| `DEFAULT_STDERR_TAIL` | 30 | stderr 尾部保留上限 4000 字符。 |

**公开函数/类**

| 函数 | 行号 | 用途 |
|---|---|---|
| `createProtocolReader(options={})` | 39–186 | 增量式 JSON-lines 读取器（纯逻辑、不碰进程，可逐字节喂）。构造时校验 `requestId`（40–41）。返回对象见下。 |
| `spawnPlan(engine, cwd, env)` | 189–199 | 把引擎命令描述规范成 spawn 参数：要求 `engine.command` 非空（191–192），合并 `process.env` + `engine.env` + `env`（197）。 |
| `tail(text, max)` | 201–204 | 截断尾部文本（默认 4000 字符），超长加 `…` 前缀。 |
| `runEngine(options={})` | 223–422 | 跑一次引擎动作并归一成 EngineResult。详见「Data Flow」。 |
| `default` export | 424 | `{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`。 |

`createProtocolReader` 返回对象（128–185）：

- `push(chunk)`（133–156）：喂一段 stdout（Buffer 或 string），按字节缓冲（多字节 UTF-8 跨 chunk 不切坏），按 `\n` 切行；单行超 `maxLineBytes` 记 `line-too-long` 并跳过（143–146）；无换行的残留超上限也丢弃（151–154）。返回本次新解析出的 progress 快照数组（供实时回调，148 行）。
- `get progress`（159–161）：只读取已解析的进度快照。
- `markCancelled()`（164–166）：声明进入取消态，此后到达的 result 一律记 `late-result`。
- `end()`（169–184）：收尾（幂等）。把残留半行当 `not-json` 违规（170–172）。返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`。

`runEngine` 返回对象（由 `finish`，253–272 拼装）：展开一份 `EngineResult` 后附加 `contractVersion` / `requestId` / `action` / `protocolViolations` / `exitCode` / `exitSignal` / `terminated` / `stderrTail` / `durationMs` / `startedAt` / `finishedAt`。

协议不变量（对应 `test-engine-client.mjs` 断言，见 `client.js` 13–20 行注释）：
1. stdout 只应是 JSON-lines；非 JSON 行记 `not-json` 违规但**不丢弃**已收结果。
2. 每条消息必须有匹配 `requestId`；不匹配记 `unknown-request`，绝不参与本次结果。
3. 没有 `result` 消息 = 协议破坏，即使退出码 0 也判失败。
4. 退出码只表达进程层；语义以 `result` 为准：退出码 0 + 语义 failed 是失败；语义 done + 退出码非 0 保留 done 并记 `nonzero-exit` 违规。
5. 取消后到达的 result 记 `late-result` 并丢弃（取消是终态，不能被迟到成功洗白）。
6. 重复 result 先到的赢（后到的是引擎 bug）。

`runEngine` 失败码映射：`engine-missing`（spawn 计划构造失败 283 / spawn 失败 297 / ENOENT 365 / 命令不存在 345）、`engine-timeout`（368–374）、`engine-crashed`（退出码非零 406）、`engine-protocol`（缺 result 且退出码 0 412 / 未知 requestId 295 / 命令不存在后无 result）。

### 3. `lib/engine/process-tree.js` — 受管进程树终止（阶段 1C）

只做「终止」一件事，不做启动、不做协议、不碰 stdout。保持小而可测。

| 函数 | 行号 | 用途 |
|---|---|---|
| `isAlive(pid)` | 41–49 | 用 `process.kill(pid, 0)` 做存在性探测：不抛=活着（含僵尸），抛 `ESRCH`=退出，抛 `EPERM`=存在但无权限（仍算活着）。非法 pid（非整数/≤0）返回 `false`。 |
| `terminateProcessTree(pid, options={})` | 61–103 | 终止一棵受管子进程树。非法/未启动 pid 返回 `{ok:true, rootAlive:false, method:'noop'/'already-exited'}`（65–70）。Windows 走 `taskkill /T /F`（72–80）；POSIX 先 `process.kill(-pid,'SIGTERM')`，宽限 `graceMs`（默认 3000）后未退则 `SIGKILL`（82–102）。返回 `{ok, rootAlive, method}`（`sigterm`/`sigkill`/`taskkill`）。 |
| `run(command, args)` | 20–32 | 内部：spawn 一个一次性命令并等待退出，用于执行 `taskkill`。 |
| `waitForDeath(pid, timeoutMs)` | 105–113 | 内部：轮询 `isAlive` 直到进程死或超时（步长 25ms）。 |

平台差异：Windows 无进程组信号，可靠做法是 `taskkill /T /F`；POSIX 用 `detached:true` 起的子进程自成一个进程组，`process.kill(-pid)` 一次性打整组（见 `client.js` 293–294 行注释）。孙进程（flake8/find/后端 fork 的 claude/codex）若不整组打掉会变成孤儿继续烧 token（注释 1–7 行）。

## Architecture

三个文件构成「契约 → 读取/翻译 → 终止」三层，跨语言边界上职责互不重叠。

```text
   Node (job/orchestration)
        │ spawn({command,args,cwd,env})
        ▼
┌─────────────────────────┐   JSON-line over stdin ┌──────────────────┐
│ lib/engine/client.js     │ ────────────────────► │  Python 引擎进程   │
│ runEngine()             │ ◄──────────────────── │  (python entry)   │
│  + createProtocolReader │   stdout = JSON-lines │  child + 孙进程树  │
└───────────┬─────────────┘                        └────────┬─────────┘
            │ 翻译每条消息                                    │
            │ result/progress/error ──► contract.js          │ kill / SIGTERM / SIGKILL
            ▼                                                ▼
┌─────────────────────────┐   terminateProcessTree(pid) ┌──────────────────┐
│ lib/engine/contract.js   │ ◄───────────────────────── │ lib/engine/       │
│ engineResult/Progress/   │   整组打掉(含孙进程)        │ process-tree.js   │
│ Error + validate         │                            │ isAlive + waitFor │
└─────────────────────────┘                            └──────────────────┘
```

- `client.js` 是唯一 `spawn` 点（client.js:288），它只消费 `contract.js` 的纯函数
  （23 行 import）与 `process-tree.js` 的 `terminateProcessTree`（24 行 import）。
- `contract.js` 不 import 任何其他模块，是叶子层（纯数据校验）。
- `process-tree.js` 也不 import 业务模块，只服务 `client.js` 的取消/超时终止。
- 三者都不读凭证、不连模型、不写 `.codewiki`——写入与映射在 `output.js` / `mapping.js`。

## Data Flow

以 `runEngine()`（`client.js` 223–422）一次调用为例，端到端时序：

1. **入参校验**（224–232）：需要 `requestId`（225 抛错）；`action` 必须是
   `doctor/generate/update/cancel` 之一（227–229 抛错）；`timeoutMs` 默认 600000ms；
   `onProgress` / `onLog` 缺省为空函数。
2. **组装读取器与计时**（234–244）：`createProtocolReader({requestId, maxLineBytes})`
   按 requestId 隔离消息；`startedAt` 取 ISO；`t0` 记毫秒。
3. **spawn 计划与进程**（279–298）：`spawnPlan` 规范命令（失败 → `engine-missing` 283）；
   `spawn()` 用 `detached`（POSIX 独立进程组，`windowsHide:true`，stdio pipe）。
4. **管道接线**（300–329）：`stdout.on('data')` → `reader.push` + `flushProgress`；
   `stderr.on('data')` → 累积 `stderrBuf`（超 `DEFAULT_STDERR_TAIL*4` 滑窗裁剪 307）并
   `onLog`；写一行请求 JSON `{requestId, action, ...payload}` 后 `stdin.end()`（325–326）。
5. **race 收口**（311–359）：`Promise.race([exited, timeout, abort, spawnError])`。
   - `spawn-error`（ENOENT 等 `'error'` 事件）：`engine-missing`（362–366）。
   - `timeout`：`killTree('timeout')` + 等 5s → `engine-timeout`（368–374）。
   - `abort`（AbortSignal）：`reader.markCancelled()` + `killTree('abort')` + 等 5s →
     `cancelled`（带 `cancelled` blocker，`writtenCount` 只取已确认进度，不取迟到 result）（376–391）。
   - 正常退出：等 stdout `end`/2s 保险（394–399），`reader.end()`（401）。
6. **终态判定**（403–421）：若无 `endedWithResult` → 协议破坏：退出码非零判
   `engine-crashed`、退出码为零判 `engine-protocol`，`stderr` 尾部必进 `message`（405–413）。
   若退出码非零但已有 result → 追加 `nonzero-exit` 违规（417–419），语义仍保留。
   最后 `finish(seen.result, extraViolations)`（421）。

`createProtocolReader.handleLine`（`client.js` 56–126）逐消息分派：
`hello`（校验协议版本 74–80）、`unknown-request`（id 不匹配 83–86）、`progress`
（`engineProgress` 归一 88–96）、`error`（引擎主动报错，push `engineError` 100）、
`result`（取消中记 `late-result` 105–109；重复记 `duplicate-result` 110–113；
首条 `engineResult` 归一 114–121）、其余记 `bad-shape`（124）。非 JSON 记 `not-json`（64），
坏形状记 `bad-shape`（68）。

`finish()`（253–272）幂等拼装最终对象：展开 `EngineResult` + `contractVersion` /
`requestId` / `action` / `protocolViolations` / `exitCode` / `exitSignal` / `terminated` /
`stderrTail`（截断 4000）/ `durationMs` / `startedAt` / `finishedAt`。

`killTree`（`client.js` 331–344）：调用 `terminateProcessTree(child.pid, {graceMs=3000})`，
失败则 `onLog` 报警「根进程仍存活」——不让取消路径假装成功。

## Connections

本模块是引擎边界契约，被多个上层与下层模块引用：

- [[engine-orchestration]] / `lib/engine/native-run.js`（`runNativeJob`）—— 生产通道编排，
  直接 `import { runEngine as realRunEngine } from './client.js'`（`native-run.js` 27 行）与
  contract.js 的 `engineResult/engineError/engineProgress`（26 行）。它是本模块唯一的真实
  生产消费方：每步结论（`engineOutcome`/`gateOutcome`/`applyOutcome`）通过
  `weakest()`（41–42 行）取最弱终态，再交给 `engineResult` 的硬不变量再次校验（113 行）。
- [[engine-manifest]] / `lib/engine/manifest.js`（`doctor`/`probeEnvironment`/`writeLock`）——
  提供 `engine` 命令描述与 `engine.deps` 证据，被 client.js 的 `spawnPlan` 与 contract.js 的
  `engine.deps` 字段消费。
- [[engine-quality-gate]] / `lib/engine/quality-gate.js`（`gateNativeOutput`/`toContractBlockers`）
  —— 把质量门结论翻成 `contract.js` 的 `BLOCKER_KINDS`，注入 `native-run.js` 的严格终态。
- [[engine-apply-plan]] / `lib/engine/apply-plan.js`（`applyNativeOutput`）—— 落地器，其
  `partial/failed` 结论（产物没入库）会强制把终态拉低，不能洗白成 done。
- [[engine-llm-bridge]] / `lib/engine/llm-bridge.js`（`startLlmBridge`）—— 模型通道，
  由 `native-run.js` 在引擎启动前建立；client.js 明确不连模型（注释 10 行）。
- [[engine-output-mapping]] / `lib/engine/mapping.js`（`mapFsoftOutput` 等）—— 产物映射，
  虽由 `test-engine-contract.mjs` 同文件测试，但 `client.js` 注释明确不在此层做映射（11 行）。
- [[update-record]] / `lib/update-record.js`（`describeOutcome`）—— 与 contract.js 的
  `describeEngineResult`（223 行）同一口径，四态文案一致。

## Known Issues

- **`client.js` 与 `contract.js` 无禁用/注释掉的代码**：本模块三文件目前全部功能启用，
  没有注释掉的函数或常量（已逐行核对 `contract.js` 1–241、`client.js` 1–425、
  `process-tree.js` 1–114）。唯一「降级」是运行时行为：未登记的错误码归到
  `engine-unknown`（`contract.js` 173 行）、非登记 blocker kind 降级为 `engine-error`
  （`contract.js` 89 行），均为协议容错而非禁用。
- **协议版本与结果契约版本独立**：`ENGINE_PROTOCOL_VERSION`（client.js 27 行）与
  `ENGINE_CONTRACT_VERSION`（contract.js 20 行）分开演进。若只升其一，版本不一致不会
  被双方同时检出——`client.js` 的 `hello` 校验只记 `protocol-version` 违规（76–78 行），
  不产生失败终态；`contractVersion` 不匹配则靠 `validateEngineResult`（191–193 行）。
  两条检查路径不一致，需运维时同时关注。
- **stdout 残留半行在 end() 才报违规**：`createProtocolReader` 在 `end()`（170–172 行）才把
  未终结的缓冲记为 `not-json`。若进程在写 result 行途中崩溃且没换行，这条 result 会丢失且
  只表现为违规，不会被当结果——这是有意为之（截断的 JSON 绝不能当结果），但调用方需知道
  此刻 `endedWithResult=false` → client.js 判 `engine-crashed`/`engine-protocol`（405–413 行）。
- **Windows 取消依赖 `taskkill /T /F`**：`process-tree.js` 72–80 行在 Windows 上只能用
  `taskkill`，若 `taskkill` 不可用或被策略禁用，`terminateProcessTree` 仍会返回
  `rootAlive=true`、`ok=false`（79 行），client.js 仅 `onLog` 报「根进程仍存活」（340 行），
  不会因此把终态改成功——但它**不会自愈**，需上层据此重试/告警。
- **POSIX 仅当 `detached:true` 才能整组打掉**：client.js 294 行注释说明，非 detached 起的
  子进程没有独立进程组，`process-tree.js` 85–88 行会退化成只打 `pid` 自己，孙进程可能变孤儿。
  当前 `spawn` 已固定 `detached: process.platform !== 'win32'`（294 行），但若未来改 spawn 选项，
  此约束会失效。
- **`RETRYABLE_CODES` 与 `engine-cancelled` 的语义冲突**：`engine-cancelled` 不入
  `RETRYABLE_CODES`（71 行），但 `runEngine` 的 abort 分支（376–391 行）产出的是
  `outcome: 'cancelled'` 而非 error，所以重试语义实际由上层按 `cancelled` 终态判定，而非
  看 `error.retryable`。`engine-error` 的 `retryable` 字段只在 failed 终态时有意义。
