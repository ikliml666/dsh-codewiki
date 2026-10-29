---
title: engine_contract_client
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-process-tree.mjs
tags: [engine, contract, protocol, client, process-tree, cross-language]
---

## Overview

本模块是迁移到 FSoft 原生引擎（Python）之后，**唯一**的跨进程真相来源边界，由三个职责互不重叠的小文件组成：

- `lib/engine/contract.js` —— 阶段 0 的纯数据契约。定义一次 `generate`/`update` 的完整结果（`EngineResult`）、进行中的快照（`EngineProgress`）、可机读失败（`EngineError`），以及阶段枚举、终态枚举、阻塞原因类别、错误码等常量。它**只做纯数据校验**，不碰文件/进程/模型，因此能被 TDD 钉死（见 `test-engine-contract.mjs`）。
- `lib/engine/client.js` —— 阶段 2 的薄适配层（进程 + 协议）。起一个受管子进程，写一行请求 JSON、读回 JSON-lines，把引擎消息翻译成 `contract.js` 的类型；超时/取消/崩溃/协议破坏时给出可机读失败。它不实现聚类/图 diff/文章写作，也不读凭证、不连模型、不写 `.codewiki`。
- `lib/engine/process-tree.js` —— 阶段 1C 的地基：受管子进程树的终止。解决「只 kill 直接子进程、孙进程变孤儿继续烧 token」的问题，是 `client.js` 取消语义能打穿整棵进程树的保证。

三者的依赖方向是单向的：`process-tree.js` 无内部依赖；`client.js` 依赖 `contract.js` 与 `process-tree.js`；`contract.js` 不依赖本模块其它文件。为什么需要这条边界：迁移后 Node 不再自己算依赖图/聚类/增量，一切来自 Python 引擎一次返回。边界一旦含糊，JobService 终态判定、面板、cw 基线、自动提交、降级提醒都会各自猜「引擎到底成功了没有」，而这正是 0.14.0 花一整轮修掉的缺陷类型（1 篇成功 + 19 篇失败也报 done）。

## Key Components

### lib/engine/contract.js — 跨进程结果契约（阶段 0）

契约的语义硬不变量由 `engineResult`（构建时）与 `validateEngineResult`（反序列化时）双重保证（`lib/engine/contract.js:12-18`）：

- `done` = 完整成功，**不许**带 blockers（带了即自相矛盾）。
- `partial` = 部分完成，**必须**带至少一条 blockers（否则等于伪装成功）。
- `failed` = 失败，必须带 error。
- `cancelled` = 取消，可带 blockers 说明已写成的部分。

常量（全部 `Object.freeze`，新增只允许追加、不允许改名/删）：

- `ENGINE_CONTRACT_VERSION`（20|）——当前契约版本号，值为 `1`。结果对象与产物映射都带它，用于版本漂移检测。
- `ENGINE_STAGES`（24-33|）——阶段枚举数组，顺序即推进顺序：`env` → `graph` → `cluster` → `articles` → `validate` → `index` → `baseline` → `commit`。面板步骤条、`job.stage` 映射、取消检查点都按它对齐。
- `TERMINAL_OUTCOMES`（35|）——终态枚举：`['done','partial','failed','cancelled']`（冻结）。
- `UPDATE_OUTCOMES`（45-50|）——增量结局枚举：`incremental`（真做了组件级更新）、`no_change`（图 diff 为空，不重写任何页）、`full_fallback`（想增量但回退全量）、`detector_failure`（连旧状态都读不到）。注意：它不是终态，而是「这一轮到底增量没」的第二个证据源。
- `CONSUMING_UPDATE_OUTCOMES`（53|）——只有 `['incremental','no_change']` 算「增量真的成立」，基线才推进。
- `BLOCKER_KINDS`（57-72|）——阻塞原因类别枚举：`article-failed`/`article-missing`/`unmapped-change`/`unmapped-page`/`quality-gate`/`index-failed`/`baseline-failed`/`commit-failed`/`engine-error`/`cancelled`/`incremental-fallback`。
- `ENGINE_ERROR_CODES`（76-86|）——错误码枚举：`engine-missing`/`engine-deps`/`engine-timeout`/`engine-cancelled`/`engine-crashed`/`engine-protocol`/`engine-model`/`engine-output`/`engine-unknown`。
- `RETRYABLE_CODES`（90|，未导出）——可重试错误码集合：`engine-timeout`/`engine-model`/`engine-unknown`（见 `engineError` 的 `retryable` 推导）。其余一律视为确定性失败。

导出函数：

- `engineResult(input)`（116-180|）——构建一次 `generate`/`update` 的结果。非法输入**抛错**而非静默归一：未知 outcome（118-120|）；`done` 带 blockers（122-124|）；`partial` 无 blockers（125-127|）；`failed` 无 error（129-131|）；未知 `updateOutcome`（138-139|）。返回对象字段：
  - `contractVersion`（144|）、`outcome`（145|）、`stage`（147|，最后一个到达的 stage，面板据此解释「停在哪」）。
  - `blockers`（148|）：经 `normalizeBlocker`（107-113|）归一，每条 `{kind, detail(≤2000), target?, source?}`，未知 kind 回落到 `engine-error`。
  - `error`（128|）：经 `engineError` 归一，无则 `null`。
  - 计数：`writtenCount`/`failedCount`/`keptCount`/`removedCount`/`unmappedCount`（150-154|），经 `num`（92-95|）归一为非负、缺失即 0。
  - `updateOutcome`（157|）：增量结局，非 update 编译为 `null`。
  - `usage`（158|）：经 `normalizeUsage`（97-105|），`inputTokens`/`outputTokens`/`cachedTokens`/`requests`。
  - `engine`（160-170|）：`version`/`commit`/`python` 字符串 + `deps:{ok, summary(≤2000)}`；`deps.ok` 只对严格 `true` 生效（测试见 `test-engine-contract.mjs:99-104`）。
  - `artifacts`（172-176|）：`docsDir`/`rawTreeDir`/`updateRecord` 路径字符串。
  - `startedAt`/`finishedAt`（177-178|）：字符串或 `null`。
- `engineProgress(input)`（183-201|）——推进中快照。要求 `stage` 在枚举内（否则抛错，185-187|），`percent` 夹到 0–100（188-189|）。字段：`contractVersion`/`stage`/`percent`/`message`/`writtenCount`/`failedCount`/`totalCount`/`usage`/`at`。
- `engineError(input)`（204-215|）——可机读失败事实。未登记 code 回落到 `engine-unknown`（206|），`retryable` 由 `RETRYABLE_CODES` 决定（211|），未知 code 原文保留在 `rawCode`（213|）。返回 `{code, message(≤4000), stage, retryable, rawCode?}`。
- `validateEngineResult(value)`（219-260|）——校验「可能来自外部/旧版本/磁盘」的对象，**不抛错**，返回 `{ok, errors}`。检查：非对象（221-223|）、`contractVersion` 不符（224-226|）、`outcome` 非法或自相矛盾（227-233|）、计数非负（234-239|）、`blockers` 形态与 kind 登记（240-248|）、`failed` 缺 error（249-251|）、`updateOutcome` 若给值必须登记（254-258|）。
- `describeEngineResult(result)`（263-280|）——四态终态文案（与 `lib/update-record.js` 的 `describeOutcome` 同口径）：`done`/`partial`（带首个 blocker 的 detail）/`failed`（带 error.message）/`cancelled`，含缺省与未知分支。

### lib/engine/client.js — Node↔Python 薄适配层（阶段 2）

协议不变量（对应 `test-engine-client.mjs` 断言，`lib/engine/client.js:13-20`）：stdout 只接受 JSON-lines（非 JSON 记 `not-json` 但不丢已收结果）；每条消息必须带匹配 `requestId`（不匹配记 `unknown-request`，不参与本次结果）；没有 `result` 消息 = 协议破坏（即使退出码 0 也判失败）；退出码只表达进程层结果，语义以 `result` 为准；取消后到达的 result 记 `late-result` 并丢弃；重复 result 先到的赢。

常量与辅助：

- `ENGINE_PROTOCOL_VERSION`（27|）——协议版本（独立于结果契约版本，值为 `1`）。
- `DEFAULT_MAX_LINE_BYTES`（29|，`4*1024*1024`）、`DEFAULT_STDERR_TAIL`（30|，`4000`）——默认单行字节上限与 stderr 尾部截取长度。
- `spawnPlan(engine, cwd, env)`（189-199|，未导出）——规范成 spawn 参数，要求 `engine.command` 非空，合并 `process.env` + `engine.env` + 调用方 `env`。
- `tail(text, max)`（201-204|，未导出）——截断 stderr 尾部。

`createProtocolReader(options)`（39-186|）——增量式 JSON-lines 读取器，**纯逻辑、不碰进程**，可被逐字节喂（用于模拟管道任意切分，测试见 `test-engine-client.mjs:129-138`）。构造要求 `requestId`（40-41|）。内部状态：`buf`/`cancelled`/`result`/`resultSeen`/`progress`/`errors`/`violations`/`ended`（44-51|）。导出方法：

- `push(chunk)`（133-156|）——喂一段 stdout（Buffer 或 string）。按字节缓冲（多字节 UTF-8 跨 chunk 不切坏，135-140|），按 `0x0a` 切行；单行超 `maxLineBytes` 记 `line-too-long`（143-146|）；无换行的残留超限也丢弃缓冲（151-154|）。返回本次新解析出的 progress 快照数组供实时回调（148|）。
- `get progress()`（159-161|）——已解析进度快照（只读）。
- `markCancelled()`（164-166|）——声明进入取消态，此后到达的 result 一律记 `late-result`。
- `end()`（169-184|）——收尾：半行残留在缓冲里记为 `not-json`（170-173|），幂等；返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`。

内部 `handleLine(text)`（56-126|）按消息 `type` 分派：`hello`（校验协议版本，74-80|）、`unknown-request`/`bad-shape` 违规（82-86|、124-125|）、`progress`（归一后 push，88-96|）、`error`（引擎主动报错，push `engineError`，98-102|）、`result`（取消态记 `late-result`；`resultSeen` 后记 `duplicate-result`；否则归一 `engineResult`，104-122|）。

`runEngine(options)`（223-422|）——跑一次引擎动作并归一成 `EngineResult`。参数：`engine`（`{command,args?,env?,cwd?}`）、`requestId`、`action`（`'doctor'|'generate'|'update'|'cancel'`，校验在 226-229|）、`payload`、`cwd`、`env`、`timeoutMs`（默认 600000）、`signal`、`onProgress`、`onLog`、`maxLineBytes`、`graceMs`。流程：

- 起 `spawnPlan` → `spawn`（288-298|，POSIX 上 `detached` 起独立进程组，294|），写一行请求 JSON 后关 stdin（324-329|）。
- 监听 stdout/stderr（300-309|）、`exit`/`spawn-error`（311-321|）、`timeout`/`abort`（347-357|）。
- `finish(result, extraViolations)`（253-272|）——幂等收尾，附加 `contractVersion`/`requestId`/`action`/`protocolViolations`/`exitCode`/`exitSignal`/`terminated`/`stderrTail`/`durationMs`/`startedAt`/`finishedAt`。
- `fail(code, message, extraViolations)`（274-277|）——产出 `outcome:'failed'` 的 `EngineResult`。
- `killTree(reason)`（331-344|）——经 `terminateProcessTree` 打穿整棵进程树（graceMs 默认 3000）。
- 分支裁决：`spawn-error`（ENOENT → `engine-missing`，362-366|）；`timeout`（kill 后 `engine-timeout`，368-374|）；`abort`（标记取消 → 终态 `cancelled` + `cancelled` blocker，380-391|）；正常退出后若 `!endedWithResult` 则协议破坏（崩溃 → `engine-crashed`，否则 `engine-protocol`，403-414|）；退出码非 0 记 `nonzero-exit` 违规但保留语义（416-421|）。

默认导出（424|）：`{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`。

### lib/engine/process-tree.js — 受管子进程树终止（阶段 1C）

本模块只做「终止」一件事（不启动进程、不碰协议、不碰 stdout），保持小而可测（`lib/engine/process-tree.js:18-19`）。平台差异：`IS_WINDOWS`（18|）决定走 `taskkill /T /F` 还是 POSIX 进程组信号。

- `run(command, args)`（20-32|，未导出）——轻量 spawn 封装，忽略 stdio，只回报 `{code, error?}`；启动失败返回 `{code:-1, error}`。
- `isAlive(pid)`（41-49|）——用 `process.kill(pid, 0)` 做存在性探测：活着（或被 EPERM 卡住）返回 `true`；非整数/`<=0` 返回 `false`；ESRCH 返回 `false`。
- `terminateProcessTree(pid, options)`（61-103|）——终止一棵受管子进程树。参数 `graceMs`（默认 3000）、`onLog`。返回 `Promise<{ok, rootAlive, method}>`：
  - 非法 pid（65-67|）→ `{ok:true, rootAlive:false, method:'noop'}`。
  - 已退出（68-70|）→ `{ok:true, rootAlive:false, method:'already-exited'}`（幂等，取消路径重入安全）。
  - Windows：`taskkill /T /F /PID`（75|），等待回收 1000ms 后判定（76-79|），`method:'taskkill'`。
  - POSIX：先 `process.kill(-pid,'SIGTERM')`（进程组，85|），非 detached 时退化成打自己（87-89|）；`waitForDeath(graceMs)` 到了就 `method:'sigterm'`（91-92|）；否则 `process.kill(-pid,'SIGKILL')`（96-99|），`method:'sigkill'`。
- `waitForDeath(pid, timeoutMs)`（105-113|，未导出）——每 25ms 探测一次，超时前消失返回 `true`。

测试要点见 `test-engine-process-tree.mjs`：孙进程必须随之死（78-100|）、非法 pid 是 noop（69-76|）、已退出幂等（102-112|）、`onLog` 含终止手段但无凭证字样（114-128|）。

## Architecture

三个组件职责互不重叠，`client.js` 把另两个粘合起来。依赖方向单向：`process-tree` 零内部依赖 → `contract` 零内部依赖 → `client` 依赖二者。

```text
┌─────────────────────────────────────────────────────────────┐
│  client.js  (runEngine / createProtocolReader)  阶段 2       │
│  · spawn 受管子进程（POSIX detached 进程组）                  │
│  · JSON-lines 解析 → contract 类型                          │
│  · 超时/取消/崩溃/协议破坏 → 可机读失败                     │
└───────┬───────────────────────────┬────────────────────────┘
        │ 翻译消息                   │ 取消/超时时打穿整棵树
        ▼                           ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ contract.js 阶段 0    │   │ process-tree.js 阶段 1C           │
│ engineResult/Progress │   │ terminateProcessTree(pid)         │
│ engineError/validate  │   │ isAlive(pid)                     │
│ 常量：STAGES/OUTCOMES │   │ SIGTERM→SIGKILL / taskkill /T /F  │
│ BLOCKERS/ERROR_CODES  │   └──────────────────────────────────┘
└──────────────────────┘
        ▲
        │ 被上层消费
        └── native-run.js(阶段4编排) / quality-gate / apply-plan / mapping / JobService

        ┌──────────── 外部 Python 引擎(FSoft) ────────────┐
        │  stdout: JSON-lines{requestId,type,result,...}   │
        │  stdin : 一行请求 JSON（requestId+action+payload）│
        └──────────────────────────────────────────────────┘
```

## Data Flow

一次 `runEngine` 调用的端到端数据流（`lib/engine/client.js:223-422`）：

1. 调用方（阶段 4 编排 `lib/engine/native-run.js`）传入 `engine`（命令描述）、`requestId`、`action`（`doctor`/`generate`/`update`/`cancel`）、`payload`、`signal` 等。
2. `spawnPlan`（189-199|）规范 spawn 参数 → `spawn`（288-298|）起受管子进程（POSIX 上 `detached` 独立进程组）。
3. 写一行请求 JSON（`requestId`+`action`+`payload`）到 stdin 后关闭（324-329|）。
4. 引擎 stdout 逐块进入 `createProtocolReader.push`（133-156|）：按 `0x0a` 切行，逐行 `handleLine`（56-126|）分派：
   - `hello` → 校验 `protocolVersion`（74-80|）；
   - 匹配 `requestId` 的 `progress` → `engineProgress` 归一并实时 `onProgress` 回调（88-96|、246-251|）；
   - `error` → `engineError` 入 `errors`（98-102|）；
   - `result` → `engineResult` 归一（104-122|，取消态记 `late-result`、重复记 `duplicate-result`）。
   - 非 JSON / 未知 id / 未登记 type → 记 `violations` 但不丢已收结果（64-86|、124-125|）。
5. 终态由「第一个到达的事件」裁决（`Promise.race`，359-391|）：
   - `spawn-error`（ENOENT）→ `engine-missing`（362-366|）；
   - `timeout` → `killTree` + `engine-timeout`（368-374|）；
   - `abort` → `markCancelled` + `killTree` + 终态 `cancelled`（376-391|）；
   - 正常 `exit` → 等 stdout `end`（394-399|），若 `!endedWithResult` 则协议破坏（崩溃 `engine-crashed` / 否则 `engine-protocol`，403-414|）；退出码非 0 记 `nonzero-exit` 但保留语义（416-421|）。
6. `finish`（253-272|）把 `result` 加上 `contractVersion`/`requestId`/`action`/`protocolViolations`/`exitCode`/`exitSignal`/`terminated`/`stderrTail`/`durationMs`/`startedAt`/`finishedAt` 后返回。
7. 返回的 `EngineResult` 上抛给 `native-run.js` 的裁决链（env → 引擎 → 质量门 → 落地器），其 `outcome`/`blockers`/`updateOutcome` 直接决定终态与基线能否推进（见 `lib/engine/contract.js:12-18` 与 `UPDATE_OUTCOMES` 的语义）。

反序列化边界：`validateEngineResult`（219-260|）负责校验磁盘残留/旧版本/外部注入的结果对象，返回逐条 `errors` 而非抛错，是 `contract.js` 与 `client.js` 之外的第三道防护（不在进程流里，而在加载既有 `EngineResult` 时）。

## Connections

- [[engine_native_run]] —— `lib/engine/native-run.js` 是阶段 4 的生产编排，直接 `import` 本模块的 `runEngine`（`native-run.js:47`）、`engineResult`/`engineError`/`engineProgress`（`native-run.js:46`），把引擎结果纳入「env → 增量决议 → 引擎 → 质量门 → 落地器」裁决链。
- [[engine_quality_gate]] —— `lib/engine/quality-gate.js` 消费 `contract.js` 的 `BLOCKER_KINDS`（见 `apply-plan.js:40` 的 import 路径）并产出 `toContractBlockers`，与 `engineResult` 的 blockers 同口径。
- [[engine_apply_plan]] —— `lib/engine/apply-plan.js`（阶段 3 落地器）`import { BLOCKER_KINDS } from './contract.js'`（40|），把写集封闭/索引/基线失败映射成阻塞原因类别。
- [[engine_mapping]] —— `lib/engine/mapping.js` 是阶段 0 的「格式翻译」层，产出 `mapFsoftOutput` 并带 `ENGINE_CONTRACT_VERSION`（见 `mapping.js:28`），其 product 落盘后由 apply-plan 消费。
- [[engine_manifest]] —— `lib/engine/manifest.js` 提供 `doctor`/环境探测/锁校验；`client.js` 的 `runEngine` 不直接调用它，但 `native-run.js` 在引擎之前先跑 manifest 的 env 校验，失败直接 `failed` 不跑引擎。
- [[engine_llm_bridge]] —— `lib/engine/llm-bridge.js` 提供模型通道；`client.js` 刻意不连模型（契约注释 `client.js:10`），桥由 `native-run.js` 单独注入引擎。
- [[change_set]] —— `lib/change-set.js` 收集四路变更，是 `native-run.js` 增量决议的「变化是什么」证据源；其结论经 `contract.js` 的 `updateOutcome`/`incremental-fallback` 语义判定基线能否推进。
- [[update_record]] —— `lib/update-record.js` 的 `describeOutcome` 与本模块 `describeEngineResult`（`contract.js:263-280`）同口径，共享四态文案。

## Known Issues

- **Windows 取消只走 `taskkill`，无 SIGTERM 宽限语义**：`terminateProcessTree` 在 `IS_WINDOWS` 分支直接 `taskkill /T /F`（75|），跳过了 POSIX 的「先 SIGTERM 再 SIGKILL」优雅收尾（91-99|）。引擎若依赖 SIGTERM 做清理（如 flush、解锁），在 Windows 上会被强制中断。这是平台实现差异，非缺陷但需在引擎侧注意。
- **协议版本不匹配仅记 `violations` 不阻塞结果**：`createProtocolReader` 在 `hello` 阶段发现 `protocolVersion` ≠ `ENGINE_PROTOCOL_VERSION` 只记 `protocol-version` 违规（`client.js:76-78`），仍继续解析后续消息。若引擎与本端协议分歧严重，结果可能部分可用——调用方需主动检查 `protocolViolations`。
- **`engine-protocol` 与 `engine-crashed` 的分界依赖退出码**：`runEngine` 仅在 `exitCode !== 0` 时才判 `engine-crashed`，否则 `engine-protocol`（`client.js:405-406`）。若引擎「退出码 0 但没 result」或「非零退出但其实是 cancel」，分类可能与真实原因错位，但 stderr 摘要（409|）会带现场文本供排障。
- **`done` + 非零退出码的语义保留**：当前设计保留语义 `done` 并记 `nonzero-exit` 违规（`client.js:1140-1145`），不把结果推翻为失败。这是一个有意的不变量（退出码只表达进程层），但若上层错误地信任 `exitCode` 而非 `outcome` 仍可能误判。
- **无源码中被禁用/注释的功能**：本模块三个文件均无禁用或注释掉的公开函数/常量（全部导出项均被 `test-engine-contract.mjs`/`test-engine-client.mjs`/`test-engine-process-tree.mjs` 覆盖）。
- **`client.js` 的 `fail`/`finish` 幂等靠 `finished` 标记**：`finish` 用 `finished` 标志防重入（254|），但 `progress` 数组在 `end()` 后仍可被 `flushProgress` 追加（246-251|）——正常退出路径会先 `reader.end()`（401|）再 `finish`（421|），重复 flush 风险仅存在于异常分支，目前测试未覆盖竞态。
