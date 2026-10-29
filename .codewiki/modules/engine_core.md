---
title: engine_core
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/native-run.js
  - lib/engine/manifest.js
  - lib/engine/native-state.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-process-tree.mjs
  - test-engine-manifest.mjs
  - test-engine-native-job.mjs
tags: [engine, contract, client-protocol, process-tree, native-run, manifest, fsoft]
---

## Overview

`engine_core` 是「FSoft 原生引擎 + Node 薄适配层」迁移的核心边界层。迁移后 Node 不再自己算依赖图 / 聚类 / 增量，一切都来自外部 Python 引擎（FSoft，`CLIDocumentationGenerator`）的一次返回。这条跨进程边界成了唯一的真相来源，因此本模块把「**引擎到底成功没成功**」这件事用一份版本化、可校验、可断言失败的契约钉死，并配齐收发这份契约的协议层、受管进程树、一次性编译编排与引擎环境清单。

模块覆盖五块职责：

- **Engine contract**（`lib/engine/contract.js`）：纯数据契约。`ENGINE_STAGES` 八段枚举、`ENGINE_CONTRACT_VERSION` 版本号，以及三个构造/校验函数 `engineResult` / `engineProgress` / `engineError`，加反序列化边界的 `validateEngineResult` 与面板文案 `describeEngineResult`。硬不变量：`done` 不许带 `blockers`、`partial` 必须带 `blockers`、`failed` 必须有 `error`，`updateOutcome` 必须是登记过的枚举。
- **Client protocol**（`lib/engine/client.js`）：Node ↔ Python 的唯一跨语言边界。`createProtocolReader` 是纯增量 JSON-lines 读取器，`runEngine` 负责 spawn 子进程、写一行请求 JSON、读回 JSON-lines、并在超时/取消/崩溃/协议破坏时给出可机读失败。
- **Process tree**（`lib/engine/process-tree.js`）：受管子进程树的终止。FSoft 会派生孙进程（flake8、find、个别后端 fork 的 claude/codex），只 kill 直接子进程会让孙进程变孤儿继续烧 token，所以这里要整棵打穿（Windows `taskkill /T /F`、POSIX `process.kill(-pid, ...)`）。
- **Native run**（`lib/engine/native-run.js`）：一次「完整编译」的生产编排。把 `env( doctor+lock ) → 增量决议 → 引擎(generate/update) → 质量门 → 落地器(index/baseline/commit)` 的裁决链固定成一条直线，每一步结论都不能被下一步洗白（`runNativeJob` 是唯一入口）。
- **Manifest**（`lib/engine/manifest.js`）：引擎清单。`doctor` 一次判出「引擎在不在、依赖闭不闭合、和上次比有没有漂」，产物是 `.codewiki/engine-lock.json`。依赖注入的持久化底座在 `lib/engine/native-state.js`（跨轮受管状态）。

引擎侧入口是 `lib/engine/python/entry.py`（JSON-lines 薄入口，非算法实现）与 `lib/engine/python/stage_map.py`（FSoft 五段进度 → 契约八段的唯一共享枚举口径）。生产接线由 `test-engine-native-job.mjs` 守门（走真实 `cw init/index/meta` 与真实 git 提交）。

> 注：本模块只写「协议、进程、编排、清单」四件事，不实现聚类/图 diff/文章写作（那是 FSoft），不读凭证/连模型（模型通道在 `lib/engine/llm-bridge.js`），不写 `.codewiki` 落盘（产物落盘与映射在 `lib/engine/output.js` / `lib/engine/mapping.js` / `lib/engine/apply-plan.js`）。

## Key Components

### lib/engine/contract.js — Engine contract（纯数据，不碰文件/进程/模型）

所有函数和常量都只做纯数据校验，因此可被 TDD 钉死（见 `test-engine-contract.mjs`）。

常量：

- `ENGINE_CONTRACT_VERSION` (L20)：结果契约版本，当前 `1`。
- `ENGINE_STAGES` (L24-33)：八段阶段枚举（也是面板步骤条、`job.stage` 与取消检查点的共同依据），顺序即推进顺序：`env → graph → cluster → articles → validate → index → baseline → commit`。
- `TERMINAL_OUTCOMES` (L35)：终态四态 `['done','partial','failed','cancelled']`（冻结）。
- `UPDATE_OUTCOMES` (L45-50)：增量结局枚举 `incremental / no_change / full_fallback / detector_failure`；`null` 表示非 update 编译没有增量结局。
- `CONSUMING_UPDATE_OUTCOMES` (L53)：只有 `incremental` 与 `no_change` 算「增量真的成立」。
- `BLOCKER_KINDS` (L57-72)：可机读阻塞原因类别（`article-failed`/`article-missing`/`unmapped-change`/`unmapped-page`/`quality-gate`/`index-failed`/`baseline-failed`/`commit-failed`/`engine-error`/`cancelled`/`incremental-fallback`）。新增只允许追加，不允许改名。
- `ENGINE_ERROR_CODES` (L76-86)：可机读错误码（`engine-missing`/`engine-deps`/`engine-timeout`/`engine-cancelled`/`engine-crashed`/`engine-protocol`/`engine-model`/`engine-output`/`engine-unknown`）。
- `RETRYABLE_CODES` (L90)：`engine-timeout` / `engine-model` / `engine-unknown` 可重试；其余一律确定性失败。

内部纯函数：`num` (L92-95，非负归一)、`normalizeUsage` (L97-105，usage 四字段归一)、`normalizeBlocker` (L107-113，blocker 归一，未知 `kind` 归到 `engine-error`)。

公开函数：

- `engineResult(input = {})` (L116-185)：构造一次 generate/update 的结果。非法 `outcome` 抛错；`done` 带 `blockers` 抛错（L122-124）；`partial` 无 `blockers` 抛错（L125-127）；`failed` 无 `error` 抛错（L129-131）；`updateOutcome` 只接受登记枚举（L134-142）。返回对象字段：`contractVersion`、`outcome`、`stage`(STAGE_SET 过滤，否则 null)、`blockers`、`error`、`writtenCount`/`failedCount`/`keptCount`/`removedCount`/`unmappedCount`(非负)、`updateOutcome`、`usage`、`engine`(`version`/`commit`/`python`/`deps`{`ok`,`summary`})、`artifacts`(`docsDir`/`rawTreeDir`/`updateRecord`)、`startedAt`/`finishedAt`(ISO 字符串或 null)。
- `engineProgress(input = {})` (L188-206)：推进中快照，`stage` 必须枚举内，否则抛错；`percent` 夹到 0–100。字段：`contractVersion`、`stage`、`percent`、`message`、`writtenCount`/`failedCount`/`totalCount`、`usage`、`at`。
- `engineError(input = {})` (L209-220)：可机读失败事实；未知 `code` 落到 `engine-unknown` 并保留 `rawCode`；`retryable` 来自 `RETRYABLE_CODES`。
- `validateEngineResult(value)` (L224-265)：反序列化边界检查，不抛错，返回 `{ ok, errors }`。查 `contractVersion`、`outcome`、done/partial 不变量、计数非负、`blockers` 形状与 `kind` 登记、`failed` 必须有 `error`、`updateOutcome` 若给必须是登记枚举。
- `describeEngineResult(result)` (L268-285)：面板四态文案，与 `lib/update-record.js` 的 `describeOutcome` 同一口径。

### lib/engine/client.js — Client protocol（唯一跨语言边界）

- `ENGINE_PROTOCOL_VERSION` (L27)：协议版本（独立于结果契约版本），当前 `1`。
- 常量 `DEFAULT_MAX_LINE_BYTES = 4*1024*1024` (L29)、`DEFAULT_STDERR_TAIL = 4000` (L30)。
- `createProtocolReader(options = {})` (L39-186)：纯增量 JSON-lines 读取器，不碰进程。返回对象带：
  - `push(chunk)` (L133-156)：按字节缓冲、按 `\n` 切行；多字节 UTF-8 跨 chunk 不切坏；单行超 `maxLineBytes` 记 `line-too-long` 并跳过；末尾超长残留也清空。返回本次新解析的 progress 快照。
  - `handleLine` (L56-126)：分发消息类型。`hello` 比对协议版本（不符记 `protocol-version`）；`progress` 归一后入列；`error` 入 `errors`（语义失败，非协议破坏）；`result` 在取消后到达记 `late-result`、重复先到赢记 `duplicate-result`、否则归一为 `engineResult`（`bad-result` 记违规）；非登记类型记 `bad-shape`。
  - `get progress()` (L159-161)：只读进度快照。
  - `markCancelled()` (L164-166)：声明取消态，此后 `result` 记 `late-result`。
  - `end()` (L169-184)：收尾，缓冲里的半行记 `not-json`；返回 `{ result, progress, errors, violations, cancelled, endedWithResult, ended }`。已解析字段：`result`(L46)、`resultSeen`(L47)、`progress`(L48)、`errors`(L49)、`violations`(L50)。
- `runEngine(options = {})` (L223-422)：跑一次引擎动作并归一为 `EngineResult`。`action` 限 `doctor`/`generate`/`update`/`cancel`（L227-229）；`timeoutMs` 默认 600000（L230）。内部 `spawnPlan` (L189-199) 规范化 spawn 参数；`tail` (L201-204) 截断 stderr；`finish` (L253-272) 统一出口，附 `protocolViolations`/`exitCode`/`exitSignal`/`terminated`/`stderrTail`/`durationMs`/`startedAt`/`finishedAt`；`fail` (L274-277) 包裹失败终态；`killTree` (L331-344) 经 `terminateProcessTree` 终止进程树。`Promise.race` (L359) 在 `exited`/`timeout`/`abort`/`spawnError` 间取先到者：超时→`engine-timeout`+终止(L368-374)；abort→`cancelled`+终止(L376-391)；正常退出但无 `result`→协议破坏（退出码 0 也救不了，L403-414）；退出码非 0 记 `nonzero-exit` 违规但保留语义(L416-421)。
- `default` 导出 (L424)：`{ ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }`。

协议不变量（断言见 `test-engine-client.mjs`）：stdout 只准 JSON-lines；每条消息须带匹配的 `requestId`；没有 `result` = 协议破坏（退出码 0 也失败）；退出码只表达进程层、语义以 `result` 为准；取消后到达的 `result` 记 `late-result` 并丢弃；重复 `result` 先到赢。

### lib/engine/process-tree.js — Process tree termination

- `isAlive(pid)` (L41-49)：用 `process.kill(pid, 0)` 探测；`pid` 非正整数返回 false；`ESRCH`→false，`EPERM`→仍算活着。
- `terminateProcessTree(pid, options = {})` (L61-103)：终止受管子进程树。非法 pid/未活→`{ ok:true, rootAlive:false, method:'noop'|'already-exited' }`。Windows：`taskkill /T /F /PID`(L75) + 短回收窗口。`rootAlive` 如实反映结果，调用方据以报错而非假装取消成功。POSIX：先 `SIGTERM -pid`(L85)，宽限 `graceMs`(默认 3000)后未退则 `SIGKILL -pid`(L96)；非 detached 进程组时退化只打自己 pid；返回 `{ ok, rootAlive, method:'sigterm'|'sigkill' }`。
- 内部 `run` (L20-32)：spawn 一个诊断子进程并解析退出码；`waitForDeath` (L105-113)：25ms 步长轮询直到 pid 死亡或超时。
- 测试用真实孙进程断言「不留孤儿」「重复终止幂等」「非法 pid 是 noop」（`test-engine-process-tree.mjs`）。

### lib/engine/manifest.js — Engine manifest（环境与锁）

- `MANIFEST_VERSION` (L20)：当前 `1`。
- `ENGINE_LOCK_REL` (L21)：`'.codewiki/engine-lock.json'`。
- `probeEnvironment({ probe, engineRoot, upstreamCommit })` (L52-64)：调用注入的 `probe()`（不在这里 spawn，保持纯可测），产出 `facts` 含 `version`/`pythonVersion`/`pipCheckOk`/`pipCheckOutput`/`engineRoot`，并算 `fingerprint`。
- `fingerprintOf(facts)` (L76-83)：只吃 `version` + `pythonVersion` 的 sha256 前 16 位；`pipCheckOk` 不进指纹（修依赖不算换引擎）。
- `readLock({ repoRoot })` (L88-102)：读落盘 lock；不存在/坏 JSON 返回 `null`（首次运行不是错误）。
- `compareLock({ current, lock })` (L113-150)：返回 `{ status, diffs, current, locked }`。`status` 取值：`absent`（无 lock）、`match`（一致）、`drift`（引擎/Python 版本变）、`unhealthy`（指纹一致但 `pipCheckOk` 非 true，优先于 drift 判）。`diffs` 是 `{field, locked, current}` 列表。
- `buildLockBody(current)` (L164-179)：构造落盘正文（不写盘）；单独拆出是因为「落锁时机必须与产物同批」（见 native-run 3.6 段）；`MANIFEST_VERSION`/`fingerprint`/`version`/`pythonVersion`/`engineRoot`/`pipCheckOk`/`recordedAt`。无 `fingerprint` 抛错。
- `writeLock({ repoRoot, current })` (L185-193)：原子写（先临时文件再 rename）。
- `doctor({ probe, repoRoot, engineRoot, upstreamCommit })` (L199-231)：一次判出 `{ok, status, current, diffs, advice}`；`ok` 仅当 `match` 或 `absent`；`probe` 抛错变成 `status:'probe-failed'`（不抛给调用方）。
- `default` 导出 (L233-245)。

### lib/engine/native-state.js — Cross-run managed state（持久化底座）

常量与白名单：`NATIVE_STATE_VERSION`(L46)、`NATIVE_STATE_DIR='.codewiki/_native-state'`(L48，首段 `_` 开头以便 `cw index` 跳过)、`NATIVE_STATE_FILE='state.json'`(L49)、`STATE_REQUIRED_DOCS=['module_tree.json','metadata.json']`(L53)、`STATE_TEMP_FILES`(L57-60)、`STATE_TEMP_DIRS=['temp/dependency_graphs']`(L61)。

函数：

- `graphFileName(repoRoot)` (L146-150)：依赖图文件名，用 `\p{L}\p{N}` 对齐 Python `sanitize_repo_name`（中文仓库名不能判缺失）。
- `stateDocsDir(stateDir)` (L153-155)、`isStateDocPath(rel)` (L170-179，白名单判据)、`stateDocFiles(stateDir)` (L187-192)。
- `readState(stateDir, repoRoot)` (L204-231)：读 `state.json`，坏掉返回 `{ok:false, code, reason}`，`code` 取值 `absent`/`unreadable`/`corrupt`/`version`。
- `readStateText(stateDir, repoRoot)` (L234-240)：读原始文本（用于「内容未变就不重写」字节比较）。
- `isUpdateEligible({stateDir, repoRoot, baseCommit, engineVersion, headCommit})` (L256-303)：判「能不能走真实增量」。硬依赖 `module_tree.json`/`metadata.json` 缺失→全量；依赖图缺失→全量；引擎版本不符→全量；持久化基线与本轮 cw 基线不一致→仍 eligible 但给 reason。返回 `{eligible, reason, state, missing}`。
- `hydrateDocsDir({stateDir, repoRoot, docsDir})` (L334-352)：把受管状态**复制**进引擎 docs 目录（复制非移动，源在仓库受 git 管理、目标在临时目录）。返回 `{hydrated, skipped}`。
- `captureDocsDir({docsDir, stateDir})` (L369-402)：把引擎 docs 目录里的状态**采集**成写集 `{rel, content}`（rel 相对仓库根），返回 `{files, captured, missing}`；非 utf8/二进制跳过并记 missing。
- `buildStatePayload({...})` (L421-475)：组装 `state.json` 内容（下一轮凭据）。含 `stateVersion`/`repoRoot`/`consumedRange`/`pendingChanges`(四路)/`unconsumed`/`engineVersion`/`scope`/`effectiveScope`/`updateOutcome`/`fallbackReason`/`notes`/`updatedAt`。本文件**不记本轮结局**，只记「本轮开始时已消费范围」与「本轮看见的变化」。
- `stateFileItem(payload, stateDir)` (L478-483)：返回一条写集项 `{rel, content}`。
- `stateFingerprint(text)` (L494-504)：去掉 `updatedAt`/`notes` 的实质内容指纹，避免无变化轮产生真实提交。
- `mergeUnconsumed({changeSet, prevUnconsumed})` (L524-566)：跨轮未消化变化合并（纯函数）。`staged`/`unstaged`/`untracked` 算未消费；上一轮携带项只有出现在本轮 `committed` 里才算消化（`consumedNow`）；`effectiveChanges` = 本轮四路 ∪ 上一轮携带（去重排序）。返回 `{unconsumed, consumedNow, effectiveChanges, carried}`。

### lib/engine/native-run.js — Native run（生产编排）

常量：`DEFAULT_ENGINE_ENTRY`(L58，python/entry.py)、`DEFAULT_UPDATE_OPTIONS={rung:'3'}`(L68，显式组件级增量)、`DEFAULT_ENGINE_TIMEOUT_MS=45*60*1000`(L72)、`RANK`/`weakest`(L75-76，终态强弱，取最弱)、`RESOLUTION={FULL:'full', UPDATE:'update'}`(L87)。

- `runNativeJob({repoRoot, scope, kind, requestId, signal, timeoutMs, requireCommittedInput, docsDir, deps, onProgress, onLog})` (L113-860)：一次原生编译的统一出口。依赖注入（L129-136）：`doctor`/`runEngine`/`gate`/`apply`/`bridge`/`probe`/`engineFor`/`config`/`collectChangeSet`/`stateDir`/`llm`/`updateOptions`/`applyDeps`。内部 `settle` (L144-178) 统一归一成 `engineResult` 并附加 `requestId`/`canAdvanceBaseline`/`artifacts`/`incremental`/`gate`/`apply`/`engineLock`/`notes`。编排顺序：
  1. 环境与锁（L187-287）：`doctor` 探测，状态 `probe-failed`/`drift`/`unhealthy` 直接 `failed` 不跑引擎；首次 `absent` 仅记 note，真正落锁在 3.6 段进写集。
  1.5 增量决议（L294-390）：`changeSet` + `prevUnconsumed` 合并（`mergeUnconsumed`），`isUpdateEligible` 判能不能增量；决议写入 `inc`。
  2. 模型桥（L392-418）：`startLlmBridge`，失败→`engine-model`。
  3. 跑引擎（L420-468）：`resolution===UPDATE` 用 `update` 动作、否则 `generate`；payload 带 `repoPath`/`docsDir`/`updateOptions`(rung 3)/`commitId`。
  3) 质量门（L543-555）：`gateNativeOutput`，引擎 `done` 不能替代门。
  3.5 采集跨轮受管状态（L568-643）：`captureDocsDir`+`buildStatePayload`+`stateFileItem`，与文章同批写；`idleRound`(L583-586) 不重写状态。
  3.6 首次落锁（L645-667）：`buildLockBody` 进 `stateFiles` 写集。
  3.7 孤儿页清理（L669-698）：`findOrphanPages` 算 `deleteFiles`。
  4) 落地器（L700-732）：`applyNativeOutput`，含 `advanceBaseline:null`/`noChanges:idleRound`/`extraFiles:stateFiles`/`deleteFiles`/`pruneRoots`。
  5) 严格合成终态（L734-859）：`finalOutcome=weakest(weakest(engineOutcome,gateOutcome),applyOutcome)`；`toContractBlockers(report)` 与 `applyBlockersOf` 注入 blockers；`degradedToFull`/`engineRolledBack` 时在非 done 终态加 `incremental-fallback` blocker；`done` 带 blockers 则降级为 `partial`；`partial` 无 blockers 补一条 `quality-gate`。
- `default` 导出 (L862-866)。

### lib/engine/python/entry.py — FSoft JSON-lines 入口（非算法实现）

- `PROTOCOL_VERSION=1`(L133)、`ACTIONS=("doctor","generate","update","cancel")`(L134)。
- 协议流守卫 `_ProtocolOnly`(L98-131)：导入 codewiki 之前就把 `sys.stdout` 换成只放行协议写出、其余改道 stderr 的替身，避免 FSoft 的 print 污染协议流。三条流钉 UTF-8（L62-70），并给 `subprocess.Popen.__init__` 打 UTF-8 补丁（L82-95，修 Windows gbk 子进程解码 bug）。
- `emit`(L143-147)/`emit_hello`(L150-151)/`emit_progress`(L154-167)/`emit_result`(L170-171)/`failure`(L174-192)：协议行构造。
- `action_doctor`(L237-276)：跑 `pip check`(`_pip_check` L215-234)，缺 codewiki→`engine-missing`，pip 失败→`engine-deps`。
- `_model_config`(L297-329)：从进程环境读 `CODEWIKI_BASE_URL`/`CODEWIKI_API_KEY`/`CODEWIKI_MAIN_MODEL`/`CODEWIKI_CLUSTER_MODEL`，**不读本机凭证库/ConfigManager**。
- `bridge_progress`(L335-386)：替换 `adapter.progress_tracker` 三方法，把 FSoft 五段翻成契约八段。
- `action_generate`(L438-563)：准备 config→跑 `CLIDocumentationGenerator`→异常翻成契约终态。`_count_docs`(L392-417) 递归清点页数；`_update_outcome_of`(L566-580) 取引擎自报增量结局；`_state_files`(L583-612) 列真实产出状态文件；`_done_result`(L615-646) 构造 done；`_classify_exception`(L649-676) 按异常**类型**（非文本）分类错误码；`_cancelled_result`(L679-696)。
- `handle_request`(L702-735)：平铺 `{requestId, action, ...payload}` 优先、嵌套 `payload` 兜底；`cancel` 由 Node 侧杀进程树，入口只回 `cancelled`。
- `main`(L738-751)：emit hello→读一行请求→handle→emit result。

### lib/engine/python/stage_map.py — 五段→八段映射（共享枚举口径）

- `ENGINE_STAGES`(L20-29)：必须与 `contract.js` 的 `ENGINE_STAGES` 完全一致（测试双向对账）。
- `FSOFT_STAGE_NAMES`(L33-39)/`FSOFT_STAGE_WEIGHTS`(L40-46)：FSoft 五段名与权重。
- `FSOFT_TO_ENGINE`(L50-56)：`1:graph, 2:cluster, 3:articles, 4:validate, 5:validate`；`DEFAULT_ENGINE_STAGE='articles'`(L60)。
- `FSOFT_PROGRESS_CEILING=90`(L63)：引擎内部进度只到 90%，剩 10% 留给 Node 侧收尾。
- `map_stage(fsoft_stage)`(L66-72)/`percent_of(fsoft_stage, stage_progress)`(L75-97)：阶段号→契约阶段名；(阶段号, 阶段内进度)→0..90 百分数。

## Architecture

`engine_core` 是一条「薄适配 + 直线裁决」的管道。Node 侧只负责起进程、收协议、判终态，真正的图/聚类/文章由 FSoft 在 Python 进程里做。关键设计是：每一段的结论都不能被下一段洗白——尤其 `done` 不能替代质量门、`partial`/`failed` 不许推进基线。

```text
  codewiki_generate (index.js)
        │ submit job → tick → tickNative
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ runNativeJob            (lib/engine/native-run.js)            │
 │   裁决链：env → 增量决议 → 引擎 → gate → apply                │
 │                                                             │
 │  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐  │
 │  │ doctor   │  │ collectChange│  │ gateNativeOutput       │  │
 │  │ (manifest│─▶│ Set + native-│─▶│ (quality-gate.js)      │  │
 │  │ .js)     │  │ state.js)    │  │                        │  │
 │  └──────────┘  └──────────────┘  └───────────────────────┘  │
 │        │               │                  │                 │
 │        ▼               ▼                  ▼                 │
 │  ┌───────────────────────────┐   ┌───────────────────────┐  │
 │  │ runEngine                 │   │ applyNativeOutput      │  │
 │  │ (client.js)               │   │ (apply-plan.js)        │  │
 │  │   spawn → JSON-lines      │   │ index/baseline/commit  │  │
 │  └───────┬───────────────────┘   └───────────────────────┘  │
 └──────────┼──────────────────────────────────────────────────┘
            │ spawn + 一行请求 JSON + stdout JSON-lines
            ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ FSoft 进程 (python/entry.py) ──派生──▶ 孙进程(flake8/find/..)│
 │   emit_hello → emit_progress(八段,stage_map.py) → emit_result│
 └──────────┬──────────────────────────────────────────────────┘
            │ terminateProcessTree (process-tree.js)
            │   POSIX: kill(-pid,SIGTERM)→SIGKILL / Win: taskkill /T /F
            ▼
     引擎进程树被整棵打穿（不留孤儿）
```

契约层（`contract.js`）横切全部：request/response 都是经 `engineResult`/`engineProgress`/`engineError` 归一后的对象，反序列化边界用 `validateEngineResult` 复核。`manifest.js` 的 `doctor` 在 env 段先于引擎判定「能不能跑」；`native-state.js` 在增量决议段提供跨轮受管状态（持久化于 `.codewiki/_native-state/`，首段 `_` 开头使 `cw index` 跳过）。

依赖关系：`native-run.js` 注入 `doctor`←`manifest.js`、`runEngine`←`client.js`、`collectChangeSet`←`../change-set.js`、`gate`←`quality-gate.js`、`apply`←`apply-plan.js`、`bridge`←`llm-bridge.js`、`native-state`←`native-state.js`。全部依赖注入，测试可换 fake `runEngine` + 真 gate/真 apply（见 `test-engine-native-job.mjs` 用例 15/16）。

## Data Flow

### 一次 generate（全量）的请求/响应流

1. **请求行**（Node→Python，client.js L324-329）：`runEngine` 向子进程 stdin 写一行 `JSON.stringify({requestId, action, ...payload}) + '\n'` 后 `end()`。Python 侧 `main`(entry.py L738) 读一行、`handle_request`(L702) 平铺解析 `requestId`/`action`/`payload`。
2. **hello**（Python→Node，entry.py L150）：`{type:'hello', protocolVersion:1, engine:'fsoft-native'}`；reader(L74-80) 若版本不符记 `protocol-version` 违规。
3. **progress + result**（Python→Node）：`action_doctor`/`action_generate` 经 `bridge_progress`(L335) 把 FSoft 五段翻八段（stage_map.py）逐条 `emit_progress`(L154)；终态经 `emit_result`(L170)。`createProtocolReader.push`(client.js L133) 按字节缓冲切行，多字节 UTF-8 跨 chunk 不切坏，`progress` 快照实时回调 `onProgress`。
4. **归一与终态**：`result` 消息经 `engineResult`(contract.js L116) 归一；`runEngine.finish`(client.js L253) 附加 `protocolViolations`/`exitCode`/`terminated`/`stderrTail`/`durationMs`。无 `result`→协议破坏（退出码 0 也失败，L403-414）。

### 一次 runNativeJob 的裁决流（native-run.js L113）

```text
doctor(manifest) ──probe+compareLock──▶ lockStatus
   drift/unhealthy/probe-failed ──▶ settle(failed, engine-deps/engine-missing)   （不跑引擎）
   match/absent ──▶ 增量决议(changeSet + isUpdateEligible + mergeUnconsumed)
                       ├─ eligible ─▶ RESOLUTION.UPDATE → action='update'
                       └─ 否则    ─▶ RESOLUTION.FULL   → action='generate'
   ──▶ startLlmBridge(bridge)
   ──▶ runEngineImpl({action, payload:{repoPath,docsDir,updateOptions:{rung:3},commitId}})
          engineOutcome=cancelled/failed ─▶ settle(对应终态，不进 gate/apply)
          done ─▶ gateNativeOutput(report)                （done 不能替代门）
                  ─▶ captureDocsDir + buildStatePayload + 首次落锁(buildLockBody)
                  ─▶ findOrphanPages → deleteFiles
                  ─▶ applyNativeOutput(extraFiles=stateFiles, deleteFiles, pruneRoots)
          finalOutcome = weakest(engineOutcome, gateOutcome, applyOutcome)
          done+blockers → partial；partial 无 blockers → 补 quality-gate
          基线推进严格由 finalOutcome==='done' 决定（canAdvanceBaseline）
```

关键数据流凭据：

- **增量结局 `updateOutcome`** 必须随终态出去（native-run.js L153，inc 段）。`incremental`/`no_change` 才算「增量真的成立」；`full_fallback`/`detector_failure` 意味着引擎没真做增量，基线**不许推进**（contract.js L45-53）。
- **`unconsumed`（未提交改动账）**：由 `native-state.js` 的 `mergeUnconsumed` 携带。引擎读的是工作区文件、cw 基线只推进到 HEAD，所以未提交改动在 `git diff base..HEAD` 出现前一直留在变化集（native-run.js L38-40）。
- **`idleRound`**（native-run.js L583-586）：`UPDATE` + `no_change` + 变化集空 + 无未消费账，三者同时成立才不重写受管状态、不裁 state、不落锁——避免「无变化轮却产生提交」。
- **写集同事务**：受管状态文件（`captureDocsDir` 产物）、首次引擎锁（`buildLockBody`）、孤儿页（`deleteFiles`）全部作为 `applyNativeOutput` 的 `extraFiles`/`deleteFiles`/`pruneRoots` 与文章共享同一 pre-image（native-run.js L645-667），因此「图/模块树/metadata/update_record 与文章同事务」是结构保证而非约定。

## Connections

- [[index]] — `codewiki_generate` 工具、`JobService` 的 `tick`/`tickNative`、`finishJob` 是 `runNativeJob` 的调用方与生产接线者（见 `test-engine-native-job.mjs` 用例 1/2/11）。
- [[engine_quality_gate]] — `gateNativeOutput`（`quality-gate.js`）与 `readCommittedBaseline` 是裁决链第 3 段的终态闸门；`toContractBlockers` 把门的 blockers 翻成契约 kind。
- [[engine_apply_plan]] — `applyNativeOutput`（`apply-plan.js`）是落地器，负责 index/baseline/commit 与回滚；`findOrphanPages` 提供孤儿页清理清单。
- [[engine_llm_bridge]] — `startLlmBridge`（`llm-bridge.js`）在跑引擎前建立模型通道；占位 key 只存活在进程环境、不进日志/不进结果（native-run.js L382-408）。
- [[change_set]] — `collectChangeSet`（`../change-set.js`）提供四路变化集（committed/staged/unstaged/untracked），是增量决议的「变化是什么」事实源。
- [[engine_mapping]] — `mapFsoftOutput`（`mapping.js`）把 FSoft 产物翻成 CodeWiki.md / `.codewiki/` 文章，本模块契约测试 `test-engine-contract.mjs` 也钉死其映射不变量。
- [[engine_output]] — `output.js` 与 `apply-plan.js` 负责产物落盘（本模块不写盘，只把状态文件交进写集）。
- [[update_record]] — `update_record.json:outcome` 是 `engineOutcome`/`CONSUMING_UPDATE_OUTCOMES` 的来源；`describeEngineResult`（contract.js L268）与 `update-record.js` 的 `describeOutcome` 同口径。
- [[engine_python_entry]] / [[fsoft_engine]] — `lib/engine/python/entry.py` 与 `stage_map.py` 是 Python 侧入口与五段→八段映射；FSoft 本体是外部引擎，本仓库只持有薄适配层。

## Known Issues

- **首次编译不可判 done（真实限制，非 bug）**：无 wiki 时 `.codewiki/_meta.yaml` 是本轮才出现、尚未提交的文件，质量门判 `baseline-uncommitted` → 终态只能 `partial`（native-run.js 终态合成段 + `test-engine-native-job.mjs` 用例 2）。这是阶段 5 补齐的限制，宁可被看见地「没完成」也不许把未入库基线记成已消化。
- **「无变化轮」的副作用边界**：`idleRound`（native-run.js L583-586）必须 `UPDATE + no_change + 变化集空 + 无未消费账` 四者同时成立才跳过状态重写/裁剪/落锁；否则会「每次无变化都产生记账提交」或「用一次空写把增量输入清空」（native-run.js L577-586 注释）。这是易错分支，测试靠 fake engine 的 no_change 模式覆盖。
- **NON-ASCII 仓库名/路径是历史重灾区**：依赖图文件名必须按 `\p{L}\p{N}` 对齐 Python `sanitize_repo_name`（native-state.js L146-150），否则中文仓库名的图被误判缺失→每轮白退全量；Python 入口还要把三条流钉 UTF-8、给 `subprocess.Popen` 打 UTF-8 补丁（entry.py L62-95）修 Windows gbk 子进程解码 bug。
- **协议流污染防护是防御性的**：FSoft 内部大量 `print`/`click.secho`（且 click 缓存 stdout 包装器），因此 entry.py 在 import codewiki 之前就换掉 `sys.stdout`（entry.py L19-131）。若上游改到连缓冲 flush 都直写真实 stdout，仍可能把半行日志挤进协议流——reader 侧记 `not-json` 违规但不丢已收结果（client.js L63-66）。
- **落锁时机曾被改坏过**：旧实现在 apply 之后直接 `writeLock` 写盘，导致 `.codewiki/engine-lock.json` 留在工作区当未跟踪脏文件，下一轮变化集永远不干净（阶段 6 真实验收）。现在落锁正文（`buildLockBody`）只作为 `applyNativeOutput` 写集的一项（native-run.js L645-667），与产物同事务提交。
- **「done 不许带 blockers」是接线的硬约束**：若三者都说 done 却还有 blockers，native-run.js L775-780 宁可降级为 `partial` 也不掩盖——这是 0.14.0 花一整轮修掉的「1 篇成功 + 19 篇失败也报 done」缺陷类（contract.js L12-18 不变量）。
- **取消是终态且需打穿进程树**：`AbortSignal` 触发后 `killTree` 经 `terminateProcessTree` 杀整棵（POSIX `kill(-pid)`，非 detached 时退化只打自己 pid）。若只 kill 直接子进程，孙进程（flake8/find/fork 出的 claude）会成孤儿继续烧 token（process-tree.js L1-14；`test-engine-process-tree.mjs` 用真实孙进程验证不留孤儿）。
