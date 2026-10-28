---
title: engine_core
type: module
source_files:
  - lib/engine/client.js
  - lib/engine/manifest.js
  - lib/engine/contract.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-client.mjs
  - test-engine-manifest.mjs
  - test-engine-contract.mjs
  - test-engine-process-tree.mjs
tags: [engine, contract, client, process-management, manifest, python-bridge, fsoft]
---

## Overview

`engine_core` 是迁移后 **Node ↔ Python (FSoft 原生引擎) 跨语言边界** 的核心适配层，位于 `lib/engine/`。它取代了「Node 自己重新实现 FSoft 算法」的旧方案，把依赖图构建、聚类、文章写作、增量 diff 全部交给 Python 引擎，Node 侧只负责四件事：

- **Engine client**（`lib/engine/client.js`）：起一个受管子进程、写一行请求 JSON、读回 JSON-lines，把引擎消息翻译成 `contract.js` 的 `EngineResult` / `EngineProgress` / `EngineError`；在超时/取消/崩溃/协议破坏时给出可机读失败，而不是抛一个模糊异常。
- **Process management**（`lib/engine/process-tree.js`）：受管子进程树的终止（取消时把整棵树——含孙进程——一起打掉，避免孤儿进程继续烧 token）。
- **Manifest**（`lib/engine/manifest.js`）：环境指纹（`version` + `pythonVersion` 的 sha256 前缀），与落盘的 `engine-lock.json` 比对，回答「现在跑的是哪个引擎、环境漂没漂、依赖闭不闭合」。
- **Contracts**（`lib/engine/contract.js`）：跨进程的契约定义（`EngineResult` / `EngineProgress` / `EngineError`）与硬不变量校验，是下游 JobService 终态判定、面板、自动提交、降级提醒唯一的对齐基准。

Python 侧配套一个**薄入口** `lib/engine/python/entry.py`（只把 stdin 一行 JSON 变成一次 FSoft 调用、把进度翻译成八段契约、把结果翻译成 `EngineResult`），以及共享枚举口径的 `lib/engine/python/stage_map.py`。

设计红线（见 `lib/engine/client.js:8-11` 与 `lib/engine/python/entry.py:9-10`）：

- client **不实现**聚类/图 diff/文章写作（那是引擎的活）；
- **不读凭证、不连模型**（模型通道由 `lib/engine/llm-bridge.js` 单独提供）；
- **不写 `.codewiki`**（产物落盘与映射在 `lib/engine/output.js` / `lib/engine/mapping.js` / `lib/engine/apply-plan.js`）；
- Python 入口**不读本机凭证库**、**不让 FSoft 的 print 污染协议流**。

## Key Components

### `lib/engine/contract.js`（契约 / 跨进程边界基准）

常量：

- `ENGINE_CONTRACT_VERSION = 1`（`contract.js:20`）——契约版本，独立于协议行格式。
- `ENGINE_STAGES`（`contract.js:24-33`）——八段阶段枚举（也是契约不是实现细节）：`env` → `graph` → `cluster` → `articles` → `validate` → `index` → `baseline` → `commit`。顺序即推进顺序，面板步骤条 / `job.stage` / 取消检查点都按它对齐。
- `TERMINAL_OUTCOMES`（`contract.js:35`）——冻结的四终态：`done` / `partial` / `failed` / `cancelled`。
- `BLOCKER_KINDS`（`contract.js:42-53`）——阻塞原因类别（机读、稳定、可追加不可改名）：`article-failed` / `article-missing` / `unmapped-change` / `unmapped-page` / `quality-gate` / `index-failed` / `baseline-failed` / `commit-failed` / `engine-error` / `cancelled`。
- `ENGINE_ERROR_CODES`（`contract.js:57-67`）——错误码枚举：`engine-missing` / `engine-deps` / `engine-timeout` / `engine-cancelled` / `engine-crashed` / `engine-protocol` / `engine-model` / `engine-output` / `engine-unknown`。
- `RETRYABLE_CODES`（`contract.js:71`）——仅 `engine-timeout` / `engine-model` / `engine-unknown` 可重试；其余视为确定性失败。

函数：

- `engineResult(input)`（`contract.js:97-147`）——一次 generate/update 的结果。非法 outcome 直接抛错；`done` 不许带 blockers（`contract.js:103-105`），`partial` 必须带至少一条 blockers（`contract.js:106-108`），`failed` 必须带 `error`（`contract.js:110-112`）。返回字段：`contractVersion`、`outcome`、`stage`（实测最后到达阶段，落在 `STAGE_SET` 内否则 `null`）、`blockers`、`error`、`writtenCount` / `failedCount` / `keptCount` / `removedCount` / `unmappedCount`（非负归一）、`usage`（`inputTokens`/`outputTokens`/`cachedTokens`/`requests`）、`engine`（`version`/`commit`/`python`/`deps.ok`/`deps.summary`）、`artifacts`（`docsDir`/`rawTreeDir`/`updateRecord`）、`startedAt`/`finishedAt`。
- `engineProgress(input)`（`contract.js:150-168`）——推进中快照，`stage` 必须在枚举内，percent 夹到 0–100。字段：`contractVersion`/`stage`/`percent`/`message`/`writtenCount`/`failedCount`/`totalCount`/`usage`/`at`。
- `engineError(input)`（`contract.js:171-182`）——可机读失败事实。未知 `code` 归到 `engine-unknown` 并保留原 `rawCode`；`retryable` 由 `RETRYABLE_CODES` 决定；`stage` 落在枚举内否则 `null`。
- `validateEngineResult(value)`（`contract.js:186-220`）——反序列化边界上的校验（不抛，返回 `{ok, errors}`），逐条检查 `contractVersion`、outcome、done/partial 语义、计数非负、`blockers` 数组与 kind 登记、`failed` 必须带 `error`。
- `describeEngineResult(result)`（`contract.js:223-240`）——四态文案（完成 / 部分完成 / 失败 / 已取消），与 `lib/update-record.js` 的 `describeOutcome` 同一口径。

### `lib/engine/client.js`（引擎客户端 / 进程 + 协议层）

常量与默认值：

- `ENGINE_PROTOCOL_VERSION = 1`（`client.js:27`）——协议版本，独立于结果契约版本（前者管「行怎么长」，后者管「结果字段」）。
- `DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024`（`client.js:29`）、`DEFAULT_STDERR_TAIL = 4000`（`client.js:30`）。

函数 / 工厂：

- `createProtocolReader(options)`（`client.js:39-186`）——纯逻辑、不碰进程的增量式 JSON-lines 读取器，可被逐字节喂（模拟管道任意切分）。`options.requestId` 是唯一的关联键；`options.maxLineBytes` 防单行失控。返回对象：
  - `push(chunk)`（`client.js:133-156`）——按字节缓冲，多字节 UTF-8 跨 chunk 不切坏；按换行切行；单行超 `maxLineBytes` 记 `line-too-long`；返回本次新解析出的 progress 快照数组。
  - `get progress`（`client.js:159-161`）——只读进度快照数组。
  - `markCancelled()`（`client.js:164-166`）——进入取消态，此后到达的 `result` 一律记 `late-result`。
  - `end()`（`client.js:169-184`）——收尾，把残留半行当违规（截断的 JSON 不能当结果），幂等，返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`。
  - 内部 `handleLine`（`client.js:56-126`）——识别 `hello` / `progress` / `error` / `result` / 未登记类型；`hello` 时校验协议版本（`client.js:74-80`）；`requestId` 不匹配记 `unknown-request`（`client.js:83-86`）；`result` 在取消后到记 `late-result`（`client.js:105-109`），重复 result 先到赢（`client.js:110-113`）。
- `runEngine(options)`（`client.js:223-422`）——跑一次引擎动作并归一成 `EngineResult`。`options`：`engine`（`{command,args?,env?,cwd?}`）、`requestId`、`action`（`doctor`/`generate`/`update`/`cancel`，`client.js:1488`）、`payload`、`cwd`、`env`、`timeoutMs`（默认 600000）、`signal`（`AbortSignal`）、`onProgress`、`onLog`、`maxLineBytes`、`graceMs`。流程：校验 → `spawnPlan`（`client.js:189-199`）→ `spawn`（`client.js:288`，POSIX 上 `detached:true` 独立进程组）→ 写一行 JSON 请求并关 stdin（`client.js:325-326`）→ 用 `Promise.race` 等 `[exited, timeout, abort, spawnError]`（`client.js:267`）→ 超时走 `killTree` 返回 `engine-timeout`（`client.js:368-374`），取消走 `markCancelled` + `killTree` 返回 `cancelled`（`client.js:376-391`），正常退出后等 stdout `end` 再判定（`client.js:394-401`）。无 `result` 即协议破坏（退出码 0 也失败，`client.js:403-414`）；`exitCode !== 0` 但语义 done 时保留 done 并记 `nonzero-exit`（`client.js:417-419`）。返回对象额外带 `contractVersion`/`requestId`/`action`/`protocolViolations`/`exitCode`/`exitSignal`/`terminated`/`stderrTail`/`durationMs`/`startedAt`/`finishedAt`（`client.js:253-272`）。
- `spawnPlan(engine, cwd, env)`（`client.js:189-199`）——把引擎命令描述规范成 spawn 参数（私有）。
- `tail(text, max)`（`client.js:201-204`）——截断 stderr 尾部（私有）。
- `terminateProcessTree`（来自 `process-tree.js`，`client.js:24` 导入）——见下。

### `lib/engine/process-tree.js`（受管子进程树终止）

- `isAlive(pid)`（`process-tree.js:41-49`）——用 `process.kill(pid, 0)` 做存在性探测：活着返回 `true`，`ESRCH` 返回 `false`，`EPERM` 返回 `true`（存在但无权限仍算占用）；非整数 pid 返回 `false`。
- `terminateProcessTree(pid, options)`（`process-tree.js:61-103`）——终止整棵进程树。非法 pid 返回 `{ok:true, method:'noop'}`（`process-tree.js:65-67`）；已退出返回 `{ok:true, method:'already-exited'}`。Windows 走 `taskkill /T /F /PID`（递归整棵树，`process-tree.js:72-80`）；POSIX 先 `SIGTERM -pid`（整进程组），等 `graceMs`（默认 3000）未退再 `SIGKILL -pid`（`process-tree.js:82-102`）。返回 `{ok, rootAlive, method}`（`method` ∈ `noop`/`already-exited`/`sigterm`/`sigkill`/`taskkill`）。
- `waitForDeath(pid, timeoutMs)`（`process-tree.js:105-113`）——轮询 `isAlive`，步长 25ms（私有）。
- `run(command, args)`（`process-tree.js:20-32`）——spawn 帮助函数，忽略 stdio（私有）。

### `lib/engine/manifest.js`（引擎清单 / 环境指纹）

常量：

- `MANIFEST_VERSION = 1`（`manifest.js:19`）、`ENGINE_LOCK_REL = '.codewiki/engine-lock.json'`（`manifest.js:20`）。

函数：

- `probeEnvironment({ probe, engineRoot })`（`manifest.js:34-45`）——调用方传 `probe` 函数（返回 `{version, pythonVersion, pipCheck:{ok,output}}`）而不是在这里 spawn，使这层纯可单测。返回 facts + `fingerprint`。
- `fingerprintOf(facts)`（`manifest.js:50-56`）——只吃 `version` + `pythonVersion` 算 sha256 前缀 16 位；**`pipCheck` 不参与指纹**（依赖闭合是「能不能跑」的闸门不是「产物是什么」的输入，`manifest.js:47-49`）。
- `readLock({ repoRoot })`（`manifest.js:61-75`）——读落盘的 lock，不存在/坏 JSON/坏 BOM 都返回 `null`（首次运行本来没有 lock）。
- `compareLock({ current, lock })`（`manifest.js:86-111`）——返回可机读差异：
  - `status: 'absent'`——无 lock；
  - `'match'`——完全一致；
  - `'drift'`——`version` 或 `pythonVersion` 变了（产物可能不同）；
  - `'unhealthy'`——指纹一致但 `pipCheckOk !== true`（能跑但不可信）。
  - 字段级 `diffs` 指出是哪个字段变了（`version` / `pythonVersion` / `fingerprint`，`manifest.js:94-103`）；`unhealthy` 优先于 `drift` 判定（`manifest.js:104-106`）。
- `writeLock({ repoRoot, current })`（`manifest.js:117-135`）——原子写（先写 `*.tmp` 再 `renameSync`），落盘 `{manifestVersion, fingerprint, version, pythonVersion, engineRoot, pipCheckOk, recordedAt}`（`recordedAt` 为 `new Date().toISOString()`，自动生成字段）。缺 `fingerprint` 或 `repoRoot` 直接报错。
- `doctor({ probe, repoRoot, engineRoot })`（`manifest.js:141-170`）——一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出来；**不抛**（probe 抛错变成 `ok:false, status:'probe-failed'`）。返回 `{ok, status, current, diffs, advice}`，`advice` 按 status 给中文建议（含指向 `tools/fsoft-engine/setup-env.sh` 的提示，`manifest.js:156-162`）。

### `lib/engine/python/entry.py`（Python 薄入口）

- `emit`（`entry.py:104-108`）——写一行协议 JSON 到真 stdout（所有协议消息必经）。
- `action_doctor`（`entry.py:198-237`）——探测 `codewiki` 版本（`_engine_version`，`entry.py:159-173`）+ 跑 `pip check`（`_pip_check`，`entry.py:176-195`）；缺包返回 `engine-deps`，否则 `done` 并带 `engine.deps`。
- `action_generate`（`entry.py:384-472`，`is_update` 决定 update/generate）——准备 config → 跑 `CLIDocumentationGenerator` → 把异常翻成契约终态；`SystemExit(0)`（FSoft「无变更」路径）按正常 `done` 处理（`entry.py:432-438`）；缺页 `IncompleteGenerationError/IncompleteDocumentationError` 翻成 `partial` + `article-missing` blockers（`entry.py:508-517`）。
- `_model_config`（`entry.py:243-275`）——从进程环境读模型通道（`CODEWIKI_BASE_URL` / `CODEWIKI_API_KEY` / `CODEWIKI_MAIN_MODEL` / `CODEWIKI_CLUSTER_MODEL`，`entry.py:98-101`），缺任何一项返回 `engine-model`。
- `bridge_progress`（`entry.py:281-332`）——替换 `ProgressTracker` 的三个阶段方法，把 FSoft 五段事件转成八段协议行（不改 FSoft 行为）。
- `_ProtocolOnly`（`entry.py:59-91`）——`sys.stdout` 替身，必须在 import codewiki 之前装好（`entry.py:92`），保证 FSoft 的 print 改道 stderr 而不污染协议流。
- `failure` / `_done_result` / `_cancelled_result` / `_classify_exception` / `_count_docs` / `_git_commit` / `handle_request` / `main`（分别见 `entry.py:135-153`、`475-496`、`499-526`、`338-363`、`366-381`、`552-574`、`577-603`）——终态构造与异常分类。

### `lib/engine/python/stage_map.py`（共享枚举口径）

- `ENGINE_STAGES`（`stage_map.py:20-29`）——与 `contract.js:24-33` 完全一致（测试双向对账）。
- `FSOFT_STAGE_NAMES` / `FSOFT_STAGE_WEIGHTS`（`stage_map.py:33-46`）——FSoft 五段镜像。
- `FSOFT_TO_ENGINE`（1→graph / 2→cluster / 3→articles / 4→validate / 5→validate，`stage_map.py:50-56`）——五段→四段；进度上限 `FSOFT_PROGRESS_CEILING = 90`（`stage_map.py:63`）留给 Node 侧收尾。
- `map_stage`（`stage_map.py:66-72`）/`percent_of`（`stage_map.py:75-97`）——阶段号与整体百分数换算（纯函数）。

### 测试文件（钉住协议破坏行为）

- `test-engine-client.mjs`——协议层（纯函数）+ 进程层（真实 spawn fake engine），覆盖非 JSON 行、未知 requestId、缺 result、退出码/语义不一致、中文/空格路径、取消后 late result、重复调用互不串。
- `test-engine-manifest.mjs`——`probeEnvironment` / `fingerprintOf` / `readLock` / `compareLock` / `writeLock` / `doctor` 各漂移场景。
- `test-engine-contract.mjs`——契约形状与语义（done/partial 不变量、err retryable、`validateEngineResult`），以及产物映射（见 `lib/engine/mapping.js`）。
- `test-engine-process-tree.mjs`——真实根/孙两层进程树，断言 `terminateProcessTree` 不留孤儿、非法 pid 幂等 noop、日志不含凭证。

## Architecture

`engine_core` 是迁移里唯一的跨语言边界，组件职责刻意做窄。协议不变量（对应 `test-engine-client.mjs`）见 `client.js:13-20`：stdout 只许 JSON-lines、每条消息带匹配 `requestId`、无 result = 协议破坏、退出码只表达进程层、取消后 result 记 `late-result`、重复 result 先到赢。

```text
  Node 侧 (lib/engine/)                    Python 侧 (lib/engine/python/)
 ┌────────────────────────┐  stdin:1行JSON  ┌──────────────────────────┐
 │ runEngine (client.js)  │ ──────────────► │ entry.py: main()         │
 │  spawn + ProtocolReader │ ◄───────────── │  emit hello/progress/     │
 │  (JSON-lines 解析)      │  stdout:JSON-lines │  result (协议守卫 stdout)│
 └───────────┬────────────┘                 └────────────┬─────────────┘
             │                                          │
   ┌─────────▼──────────┐                  ┌────────────▼────────────┐
   │ process-tree.js    │  SIGTERM/SIGKILL │  CLIDocumentationGenerator│
   │ terminateProcessTree│ ◄── 取消/超时 ─── │  (FSoft 原生算法)         │
   │  (整棵树 含孙进程)   │  taskkill /T /F  │  stage_map.py: 五段→八段  │
   └─────────┬──────────┘                  └──────────────────────────┘
             │
   ┌─────────▼──────────┐
   │ contract.js        │  EngineResult/EngineProgress/EngineError
   │  (语义不变量)        │  done↔无blockers / partial↔有blockers / failed↔error
   └─────────┬──────────┘
             │
   ┌─────────▼──────────┐
   │ manifest.js        │  doctor → 指纹比对 → .codewiki/engine-lock.json
   │  (环境可信性)        │
   └────────────────────┘

 模型通道（旁路，不在本模块）：llm-bridge.js ──loopback──► entry.py 经 CODEWIKI_* 环境变量
 落盘/映射（下游，不在本模块）：apply-plan.js / output.js / mapping.js
```

下游消费方（JobService 终态判定、面板、cw 索引、自动提交、降级提醒）都按 `contract.js` 的同一份 `EngineResult` 对齐，避免各猜一套——这正是 0.14.0「1 篇成功 + 19 篇失败也报 done」那类缺陷的根因（见 `contract.js:3-6` 与 `apply-plan.js:1-8`）。

## Data Flow

一次 `generate`/`update` 动作的端到端数据流：

1. **发起**——调用方（阶段 4 的 `index.js`）构造 `engine` 描述与 `requestId`，调用 `runEngine({ engine, requestId, action, payload, timeoutMs, signal, onProgress, onLog })`（`client.js:223`）。
2. **起进程**——`spawnPlan` 规范化成 spawn 参数（`client.js:189`），POSIX 上 `detached:true` 起独立进程组（`client.js:294`），异步 `spawn`（`client.js:288`）。
3. **请求行**——写一行 `JSON.stringify({requestId, action, ...payload}) + '\n'` 到 stdin 后关闭（`client.js:325-326`）；Python 侧 `entry.py:main` 读这一行（`entry.py:577-590`）。
4. **进度流**——引擎按 `stage_map.py` 把 FSoft 五段翻成八段契约（上限 90%），每条 `progress` 经 `createProtocolReader.push` 解析，`client.js:246-251` 的 `flushProgress` 实时回调 `onProgress`（`client.js:300-303`）。stdout 任何非 JSON 行被记 `not-json` 违规但不丢弃已收结果（`client.js:63-66`）。
5. **终态**——引擎发 `result` 行，`reader.end()` 返回 `{result, progress, errors, violations, endedWithResult}`（`client.js:169-184`）。`runEngine` 用 `finish` 归一成带 `contractVersion`/`exitCode`/`stderrTail`/`durationMs` 的 `EngineResult`（`client.js:253-272`）。
6. **取消 / 超时**——`AbortSignal` 触发或 `timeoutMs` 到期时，`killTree` 调 `terminateProcessTree` 打掉整棵树（`client.js:331-344` + `process-tree.js:61`），取消后到达的 `result` 记 `late-result` 且不覆盖已定终态（`client.js:376-391`）。
7. **doctor 旁路**——`action:'doctor'` 时引擎只跑 `action_doctor`（`entry.py:198`）返回环境事实；Node 侧 `manifest.js` 的 `doctor`/`compareLock`/`writeLock` 据此比对并落盘 `engine-lock.json`（`manifest.js:117-170`），指纹由 `version`+`pythonVersion` 算（`manifest.js:50-56`）。
8. **下游消费**——`EngineResult` 交给 `apply-plan.js` 的 `applyNativeOutput` 做写盘→cw index→基线→自动提交（`apply-plan.js:414`），其 `toApplyBlockers` 把落地问题翻回 `contract.js` 的 `BLOCKER_KINDS`（`apply-plan.js:298-320`）。

## Connections

- [[engine_apply_plan]]（`lib/engine/apply-plan.js`）：本模块的 `EngineResult` 在这里被落地（写盘→cw index→基线→自动提交），`toApplyBlockers` 复用 `contract.js` 的 `BLOCKER_KINDS`。
- [[engine_mapping]]（`lib/engine/mapping.js`）：FSoft 产物 → CodeWiki.md / `.codewiki/` 的映射；契约测试 `test-engine-contract.mjs` 同时钉契约形状与映射。
- [[engine_llm_bridge]]（`lib/engine/llm-bridge.js` + `openai-bridge.js`）：宿主模型 loopback 桥，经 `CODEWIKI_*` 环境变量注入模型通道，是本模块之外独立的一块，但对 `entry.py` 的 `_model_config` 是前置依赖。
- [[engine_output]]（`lib/engine/output.js`）：产物落盘与规范化（本模块不写 `.codewiki`，那里写）。
- [[engine_quality_gate]]（`lib/engine/quality-gate.js`）：给出「采用裁决」，本模块的 `EngineResult` 经它裁决后才交给 `apply-plan.js`。
- [[article_contract]]（`lib/engine/../article-contract.js`）：`apply-plan.js` 用其 `parseFrontmatter` 剥入口页 frontmatter（`apply-plan.js:41`、`395-398`）。
- [[update_record]]（`lib/update-record.js`）：`describeEngineResult` 与 `update-record.js` 的 `describeOutcome` 同一四态口径（`contract.js:222`）。
- 宿主入口 `index.js`（`index.js:172` / `4021` 等）：注入 `runCw` 与 `autoCommitWiki` 到 `apply-plan.js`；生产 `runEngine` 的调用方。

## Known Issues

- **Python 入口依赖未打包本仓库**——`lib/engine/python/entry.py` 需要 `codewiki`（FSoft）与 `stage_map` 在运行环境里可 import；`compute_python_entry` / `FSOFT_TEST_PY` 等如何定位入口由调用方（阶段 4）负责，本模块只约定「`engine.command` 指向可执行的 Python 解释器 + 入口脚本」（`client.js:189-199`、`test-engine-client.mjs:237-241`）。目前仓库内对真实 FSoft 的端到端调用在 `test-engine-python-entry.mjs`（未在本模块阅读范围，仅作连接提示）。
- **`doctor` 的 `probe` 必须由调用方提供**——`manifest.js:34` 故意不在这里 spawn，因此 `probeEnvironment` 不会自己探测 Python；若调用方传的 `probe` 抛错，`doctor` 返回 `status:'probe-failed'`（`manifest.js:141-146`，测试 `test-engine-manifest.mjs:185-190`），不会冒泡。
- **指纹只吃 `version` + `pythonVersion`**——依赖变动（`pipCheckOk` 翻转）不进指纹（`manifest.js:47-49`），所以单纯修依赖不会触发 `drift`，只触发 `unhealthy`；这是有意设计，但意味着「依赖变了产物可能不同」只能靠 `unhealthy` 告警，不能靠指纹比对拦下。
- **取消的语义终态靠 `late-result` 隔离**——取消后到达的 `result` 一律丢弃（`client.js:105-109`、`376-391`）；若引擎在 `killTree` 宽限期内仍未退出，`runEngine` 最多再等 5s 就返回 `cancelled`（`client.js:370`、`379`），此时 `writtenCount` 只取已确认进度。
- **Windows 进程树终止依赖 `taskkill`**——POSIX 走 `detached` 进程组 + `SIGTERM`/`SIGKILL`（`process-tree.js:82-102`），Windows 走 `taskkill /T /F`（`process-tree.js:72-80`）；若 `taskkill` 不可用或超时，返回 `ok:false, rootAlive:true`，调用方应据此报错而非假装取消成功（`process-tree.js:58-59`）。
- **`hello` 协议版本不匹配只记违规不中断**——`createProtocolReader` 对 `protocolVersion != ENGINE_PROTOCOL_VERSION` 记 `protocol-version` 违规（`client.js:74-80`），协议仍继续解析；版本协商的硬失败由上层决定。
- **stdout 残半行被丢弃**——进程崩溃导致最后一行 JSON 没写完，`end()` 把残留缓冲当 `not-json` 违规（`client.js:169-173`），不会把它误当结果；这也意味着「退出码 0 但缺完整 result」会判 `engine-protocol` 而非成功（`client.js:403-414`，测试 `test-engine-client.mjs:265-269`）。
