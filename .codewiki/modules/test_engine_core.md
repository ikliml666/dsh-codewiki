---
title: test_engine_core
type: module
source_files:
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-manifest.mjs
  - test-engine-process-tree.mjs
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/manifest.js
tags: [engine, contract, client, manifest, process-tree, tests, fsoft-native-engine]
---

## Overview

`test_engine_core` 是一个**测试模块**，由四个独立的 `*.mjs` 端到端测试文件组成，专门钉死 FSoft 原生引擎迁移的「核心边界」——即 Node 侧作为薄适配层与 Python 原生引擎之间唯一真相来源的那几条契约。对应任务要求覆盖四块：

- **引擎契约（contract）** — `test-engine-contract.mjs` 钉死 `lib/engine/contract.js` 的结果形状与 `lib/engine/mapping.js` 的产物映射；
- **客户端（client）** — `test-engine-client.mjs` 钉死 `lib/engine/client.js` 的协议层与进程层，重点是「协议破坏时的行为」；
- **清单（manifest）** — `test-engine-manifest.mjs` 钉死 `lib/engine/manifest.js` 的环境指纹、lock 比对与 doctor 诊断；
- **进程树（process tree）** — `test-engine-process-tree.mjs` 钉死 `lib/engine/process-tree.js` 的受管子进程树终止（取消必须打穿整棵树）。

这四个测试文件共同守护迁移里最重要、也最坏的失败模式——「wiki 编译成功但文章没更新 / 静默丢弃 / 把失败伪装成成功」。它们都采用统一的小框架：一个 `check(label, fn)` 帮助函数（见 `test-engine-contract.mjs:34-37`、`test-engine-client.mjs:29-32`、`test-engine-manifest.mjs:23-26`、`test-engine-process-tree.mjs:22-25`）记录 `pass` 与 `fails`，结尾打印通过数并在有失败时把 `process.exitCode = 1`。

> 注意：本模块只测纯逻辑 + 真实子进程，**不** mock 进程/网络（理由见各文件头注释）。协议层测试用 `createProtocolReader` 的纯函数逐字节喂（模拟管道任意切分），进程层测试则用真实 `spawn` + 一个会按 `FAKE_MODE` 环境变量吐不同协议串的假引擎（`test-engine-client.mjs:158-218`）。

## Key Components

下面按被测试覆盖的源文件逐一列出公开函数/常量、字段与方法（行号以 `read_code` 返回前缀为准）。

### `lib/engine/contract.js`（被 `test-engine-contract.mjs` 覆盖）

- `ENGINE_CONTRACT_VERSION` — `20|` 常量 `1`，契约版本号，结果归一化后强制带上。
- `ENGINE_STAGES` — `24-33` 阶段枚举数组（顺序即推进顺序）：`env / graph / cluster / articles / validate / index / baseline / commit`。
- `TERMINAL_OUTCOMES` — `35|` 终态冻结集合：`done / partial / failed / cancelled`。
- `BLOCKER_KINDS` — `42-53` 阻塞原因枚举（只许追加不许改名）。
- `ENGINE_ERROR_CODES` — `57-67` 可机读错误码枚举；其中 `RETRYABLE_CODES`（`71|`：`engine-timeout / engine-model / engine-unknown`）决定重试语义。
- `num(v)` — `73-76` 私有归一：非有限或 `≤0` 一律归 `0`。
- `normalizeUsage(usage)` — `78-86` 把 `usage` 归一为 `inputTokens / outputTokens / cachedTokens / requests` 四个非负数。
- `normalizeBlocker(b)` — `88-94` 把单条 blocker 归一：`kind` 不在 `BLOCKER_KINDS` 则降级成 `engine-error`，`detail` 截断 2000 字符。
- `engineResult(input)` — `97-147` 构造一次结果。**构造即校验**：非终态 outcome 抛错（`99-101`）；`done` 带 blockers 抛错（`103-105`）；`partial` 无 blockers 抛错（`106-108`）；`failed` 无 `error` 抛错（`110-112`）。返回对象字段：`contractVersion / outcome / stage / blockers / error / writtenCount / failedCount / keptCount / removedCount / unmappedCount / usage / engine{version,commit,python,deps{ok,summary}} / artifacts{docsDir,rawTreeDir,updateRecord} / startedAt / finishedAt`。其中 `engine.deps.ok` 只对严格 `true` 为真、摘要截断 2000、缺失给 `{ok:false,summary:''}`（`127-137`）。
- `engineProgress(input)` — `150-168` 构造推进快照：`stage` 必须在枚举内否则抛错（`152-154`），`percent` 夹到 0–100（`156`）。返回 `contractVersion / stage / percent / message / writtenCount / failedCount / totalCount / usage / at`。
- `engineError(input)` — `171-182` 构造可机读失败：`code` 不在 `ENGINE_ERROR_CODES` 归 `engine-unknown` 并把原文留 `rawCode`（`172-180`）；`retryable` 由 `RETRYABLE_CODES` 决定。返回 `code / message(截断4000) / stage / retryable / rawCode`。
- `validateEngineResult(value)` — `186-220` 反序列化边界校验，**不抛错**，返回 `{ok, errors}`：检查 `contractVersion`、outcome、`done` 带 blockers / `partial` 无 blockers、四个计数非负、blockers 形状与 kind、failed 缺 error（逐条 errors）。
- `describeEngineResult(result)` — `223-240` 四态中文文案（`完成 / 部分完成(带首个 blocker detail) / 失败(带 error.message) / 已取消`）。

### `lib/engine/mapping.js`（被 `test-engine-contract.mjs` 覆盖）

- `WIKI_ENTRY` — `30|` `'CodeWiki.md'`；`WIKI_DIR` — `31|` `'.codewiki'`；`WIKI_META_REL` — `32|` `'.codewiki/_meta.yaml'`；`WIKI_UPDATE_RECORD_REL` — `33|` `'.codewiki/temp/update-record.json'`；`WIKI_MODULES_REL` — `34|` `'.codewiki/modules'`。
- `moduleSlug(name)` — `38-44` ASCII 转 kebab-case、非 ASCII 折叠成 `-`、去首尾 `-`、转小写；全空白返回 `''`（`test-engine-contract.mjs:189-194` 验证 `Core_Engine`→`core-engine` 等）。
- `posix(p)` — `46|` 反斜杠转正斜杠。
- `normalizeSourceFiles(list)` — `48-58` 去重 + 去 `./` 前缀。
- `sourceFilesOf(components, componentFiles)` — `62-72` **不臆造**证据：组件 id `path::Symbol` 取 `::` 前部分；命中 `componentFiles` 取映射；纯符号名无映射则跳过。
- `indexModuleTree(moduleTree)` — `76-96` 把 FSoft 模块树拍平成 `name → {name,path,components,hasChildren,artifact,parent}`。
- `mapFsoftOutput({pages, moduleTree, componentFiles, metadata, updateRecord, overviewName})` — `115-268` 纯函数映射，返回 `{contractVersion, entry, articles, unmapped, meta, updateRecord, warnings}`。硬规则对应测试：overview→入口（`142`）；模块页落 `.codewiki/modules/<slug>.md`（`199`）；空模块树时仍进写集但 `attribution:'unattributed'`+空 `sourceFiles`（`153-188`）；不在树里→unmapped（`189-192`）；slug 冲突两页都进 unmapped 且回滚先到的（`165-174`、`200-211`）；`source_files` 只认真实证据（`213-217`）；`meta.lastCompiledCommit/layout/language` 来自 `metadata.generation_info`（`260-264`）；`updateRecord` 原样搬运到 `WIKI_UPDATE_RECORD_REL`（`244-253`）；无页时 `entry:null` 仍可序列化（`257`）。

### `lib/engine/client.js`（被 `test-engine-client.mjs` 覆盖）

- `ENGINE_PROTOCOL_VERSION` — `27|` 常量 `1`（独立于结果契约版本）。
- `DEFAULT_MAX_LINE_BYTES` — `29|` `4MB`；`DEFAULT_STDERR_TAIL` — `30|` `4000`。
- `createProtocolReader(options)` — `39-186` 增量 JSON-lines 读取器（纯逻辑、不碰进程）。闭包字段：`buf / cancelled / result / resultSeen / progress / errors / violations`。方法：
  - `push(chunk)` — `133-156` 按字节缓冲，多字节 UTF-8 跨 chunk 不切坏（`test-engine-client.mjs:129-138`）；超长单行记 `line-too-long`（`143-146`、`151-154`）；返回本次新 progress 快照。
  - 内部 `handleLine(text)` — `56-126`：非 JSON→`not-json`（`62-66`）；坏形状→`bad-shape`（`67-70`）；`hello` 校验 `protocolVersion`（`74-80`）；`requestId` 不匹配→`unknown-request`（`83-86`）；`progress`/`error`/`result` 分派；`result` 在 `cancelled` 后→`late-result`（`105-109`）、重复 result→`duplicate-result`（先到赢，`110-113`）、`bad-result`（`114-122`）。
  - `markCancelled()` — `164-166` 进入取消态。
  - `end()` — `169-184` 收尾：残留半行记 `not-json`（`170-173`）；返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`。
- `spawnPlan(engine, cwd, env)` — `189-199` 规范 spawn 参数；`engine` 非法或 `command` 为空抛错（被 `runEngine` 捕获成 `engine-missing`）。
- `tail(text, max)` — `201-204` 截断尾部文本。
- `runEngine(options)` — `223-422` 跑一次引擎动作归一成 `EngineResult`。`action` 必为 `doctor/generate/update/cancel`（`227-229`）；`timeoutMs` 默认 600000；用 `Promise.race([exited, timeout, abort, spawnError])`（`359`）：`spawn-error`→`engine-missing`（`362-366`）；`timeout`→killTree + `engine-timeout`（`368-374`）；`abort`→`markCancelled` + killTree + `cancelled` 终态（`376-391`）；退出后若 `!endedWithResult` 则按 `exitCode` 判 `engine-crashed` 或 `engine-protocol`（`403-414`）；`exitCode!=0` 仍带 `nonzero-exit` 违规但保留语义（`416-419`）。返回的 `finish()`（`253-272`）附加 `protocolViolations / exitCode / exitSignal / terminated / stderrTail / durationMs / startedAt / finishedAt`。Windows 上 `detached:false`，POSIX 上 `detached:true` 自成进程组（`292-295`）。

### `lib/engine/process-tree.js`（被 `test-engine-process-tree.mjs` 覆盖）

- `IS_WINDOWS` — `18|` 平台判定。
- `run(command, args)` — `20-32` 内部 helper：spawn 一个命令并等结束，失败返回 `{code:-1}`。
- `isAlive(pid)` — `41-49` 用 `process.kill(pid, 0)` 探测：`pid` 非正整数返回 `false`；`ESRCH`→已退出返回 `false`；`EPERM`→仍算活着返回 `true`。
- `terminateProcessTree(pid, options)` — `61-103` 终止整棵受管进程树。非法 `pid`→`{ok:true, method:'noop'}`（`65-67`）；已退出→`{method:'already-exited'}`（`68-70`）；Windows `taskkill /T /F`（`72-80`）；POSIX 先 `SIGTERM -pid`（非 detached 退化打自己）、宽限 `graceMs`（默认 3000）未退再 `SIGKILL -pid`（`82-102`）。返回 `{ok, rootAlive, method}`。
- `waitForDeath(pid, timeoutMs)` — `105-113` 轮询 `isAlive` 直到死或超时。

### `lib/engine/manifest.js`（被 `test-engine-manifest.mjs` 覆盖）

- `MANIFEST_VERSION` — `19|` 常量 `1`；`ENGINE_LOCK_REL` — `20|` `'.codewiki/engine-lock.json'`。
- `posix(p)` — `22|` 路径归一。
- `probeEnvironment({probe, engineRoot})` — `34-45` 只读探测：缺 `probe` 函数直接抛（`35`）；收集 `version/pythonVersion/pipCheckOk/pipCheckOutput/engineRoot` 并算 `fingerprint`。
- `fingerprintOf(facts)` — `50-56` 只对 `version` + `pythonVersion` 算 sha256 取前 16 位（`pipCheckOk` **不**进指纹）。
- `readLock({repoRoot})` — `61-75` 读 lock：不存在/坏 JSON 都返回 `null`（首次运行不是错误）。
- `compareLock({current, lock})` — `86-111` 返回 `{status, diffs, current, locked}`：`lock` 为空→`absent`（`89`）；`version`/`pythonVersion` 变化→`drift` 并列出 `diffs`（`94-99`）；指纹算法变了→`fingerprint` diff（`100-103`）；`pipCheckOk!=true`→`unhealthy` 优先（`104-106`）；完全一致→`match`（`110`）。
- `writeLock({repoRoot, current})` — `117-135` 原子写（先写 `.tmp` 再 `renameSync`），缺 `repoRoot`/`fingerprint` 抛错（`118-119`）；写入含 `recordedAt`（`129`）。
- `doctor({probe, repoRoot, engineRoot})` — `141-170` 一次把「引擎在不在、环境闭不闭合、有没有漂」判出，**不抛**：`probe` 抛错→`status:'probe-failed'`（`145-153`）；否则走 `compareLock` 并给 `advice`；`ok` 仅当 `match` 或 `absent`。

### 测试文件自身骨架（四个 `*_test*.mjs` 不导出组件，仅执行断言）

每个文件顶部 `import assert from 'node:assert/strict'`，定义 `let pass = 0`、本地 `fails` 数组与 `check()` 帮助函数；文件末尾打印 `pass passed, fails.length failed` 并在有失败时把 `process.exitCode = 1`。断言标签与源函数一一对应（如 `test-engine-contract.mjs:43-156` 逐条钉 `engineResult`/`engineProgress`/`engineError`/`validateEngineResult`/`describeEngineResult` 与 `mapFsoftOutput` 的 13 条映射断言）。

## Architecture

四个测试文件分别钉死 `lib/engine/` 下五个源文件的不同横切面，整体构成「契约 → 客户端（协议/进程）→ 进程树地基 → 清单」的分层：

```text
┌ test-engine-contract.mjs ────────────────────────────────────────────┐
│ 钉 contract.js(EngineResult/Progress/Error) + mapping.js(FSoft→cw)   │
└──────┬──────────────────────────────┬───────────────────────────────┘
                │ 依赖                                          │ 依赖
                ▼                                              ▼
┌─────────────────────── lib/engine/contract.js ───────────────────────┐   ┌── mapping.js ──┐
│ ENGINE_STAGES / TERMINAL_OUTCOMES / engineResult / engineProgress …  │   │ mapFsoftOutput │
└───────────────┬──────────────────────────────────────────────────────┘   └────────────────┘
                │ 归一化引用 ENGINE_CONTRACT_VERSION
                ▼
┌──────────────────── test-engine-client.mjs ────► lib/engine/client.js ────────────┐
│ 协议层(纯函数 createProtocolReader) + 进程层(真实 runEngine)                       │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ 取消/超时 → killTree
                ▼
┌──────── test-engine-process-tree.mjs ─► lib/engine/process-tree.js ───────────────┐
│ terminateProcessTree / isAlive （POSIX SIGTERM→SIGKILL 进程组 / Win taskkill /T /F）│
└────────────────────────────────────────────────────────────────────────────────────┘

┌──────── test-engine-manifest.mjs ───► lib/engine/manifest.js ──────────────────────┐
│ probeEnvironment / fingerprintOf / readLock / compareLock / writeLock / doctor       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

要点：

- `client.js` 是唯一的跨语言边界，它**既**用 `contract.js` 做结果归一化，**又**在取消/超时时机调用 `process-tree.js` 的 `terminateProcessTree`（`client.js:331-344`）——所以两个测试天然联动（取消终态测试见 `test-engine-client.mjs:309-324`，进程树必须打穿见 `test-engine-process-tree.mjs:78-100`）。
- `contract.js` 与 `mapping.js` 共享 `ENGINE_CONTRACT_VERSION`（`mapping.js:28` 导入），二者被同一测试文件 `test-engine-contract.mjs` 覆盖，因为它们的边界同属「阶段 0 契约冻结」。
- `manifest.js` 相对独立，只回答「环境可信吗」，被 `test-engine-manifest.mjs` 单独覆盖；它把进程探测交给调用方传入的 `probe` 函数（`manifest.js:34-35`），因此测试里用 `fakeProbe`（`test-engine-manifest.mjs:29-34`）注入假数据。

## Data Flow

四类测试的数据流各有侧重：

**1. 契约形状校验（contract.js，`test-engine-contract.mjs:43-156`）**
`check(label, fn)` → 直接调用 `engineResult/engineProgress/engineError/validateEngineResult/describeEngineResult` 纯函数 → 用 `assert` 断言归一化结果（如 `done`+blockers 抛错、`partial` 必带 blockers、数字归 0、`engine.deps` 严格布尔）→ 通过则 `pass++`，否则入 `fails`。

**2. 产物映射（mapping.js，`test-engine-contract.mjs:196-334`）**
构造 `moduleTree / componentFiles / metadata / updateRecord` 输入 → 调 `mapFsoftOutput` → 断言 `mapped.entry.path===WIKI_ENTRY`、`mapped.articles[].wikiPath/sourceFiles/pageKind`、`mapped.unmapped[].reason`、`mapped.meta.lastCompiledCommit`、`mapped.updateRecord.path===WIKI_UPDATE_RECORD_REL`。关键证据分支：
- 组件 id `path::Symbol` 取 `::` 前文件（`test-engine-contract.mjs:237-258`）；
- 纯符号名无证据 → 空 `sourceFiles` + warning（绝不臆造）；
- slug 冲突两页都进 unmapped（`292-305`）。

**3. 协议/进程层（client.js，`test-engine-client.mjs`）**
- 协议层（纯函数，`39-154`）：`createProtocolReader({requestId})` → 逐个 `push(JSON 行或脏数据)` → `end()` 取 `{result, progress, violations, endedWithResult}`；逐字节喂模拟管道切分（`129-138`）。
- 进程层（真实 spawn，`243-361`）：`writeFileSync` 一个按 `FAKE_MODE` 吐不同协议的假 `fake_engine.py`（`162-218`）→ `runEngine({engine, requestId, action, timeoutMs, signal})` → 取归一化 `EngineResult`（含 `protocolViolations/exitCode/terminated`）。`check` 覆盖：non-JSON 行、`wrongid`、缺 result（退出码 0 仍判 `engine-protocol`）、退出码与语义不一致、`crash`、`timeout`（`terminated:true`）、`late` 取消、`cwd` 含中文空格。

**4. 进程树终止（process-tree.js，`test-engine-process-tree.mjs:32-128`）**
`startTree(dir)` 起真实两层树（root node → spawn grandchild node 长驻并写 pid 文件，`32-43`）→ `waitForFile` 等孙进程 pid（`45-55`）→ `terminateProcessTree(root.pid, {graceMs})` → `sleep` 后用 `isAlive` 验证 root 与 grandchild 都死（不留孤儿，`78-100`）；并验证非法 pid noop（`69-76`）、重复终止幂等（`102-112`）、`onLog` 记录终止手段且不含凭证字样（`114-128`）。

**5. 清单/doctor（manifest.js，`test-engine-manifest.mjs:36-190`）**
`fakeProbe()` 注入 `{version, pythonVersion, pipCheck}`（`29-34`）→ `probeEnvironment` 算指纹 → `readLock/compareLock/writeLock` 比对落盘 → `doctor` 综合出 `{ok, status, diffs, advice}`。覆盖：指纹随 version/python 变而变（`49-57`）、pipCheck 不进指纹（`59-63`）、`absent/match/drift/unhealthy/probe-failed` 五种 status（`78-189`），以及坏 lock JSON 返回 null（`71-76`）、二次写入不留 `.tmp`（`135-142`）。

## Connections

- [[fsoft-native-engine]] — `docs/fsoft-native-engine.md` 是阶段 0 冻结契约文档，明确把 `contract.js`/`mapping.js` 的常量与不变量的行号写进了契约（`docs/fsoft-native-engine.md:29` 引用 `lib/engine/contract.js:23-96` 与 `:160-220`；`:101` 指明映射测试在 `test-engine-contract.mjs`）。本测试模块就是对这份契约的可执行断言。
- [[engine-client]] / `lib/engine/client.js` — 测试直接依赖；`test-engine-client.mjs` 覆盖其协议层与进程层。
- [[engine-contract]] / `lib/engine/contract.js` — 结果/进度/错误形状的唯一来源，`test-engine-contract.mjs` 覆盖。
- [[engine-mapping]] / `lib/engine/mapping.js` — FSoft 产物→CodeWiki 映射，`test-engine-contract.mjs` 覆盖。
- [[engine-manifest]] / `lib/engine/manifest.js` — 环境指纹/lock/doctor，`test-engine-manifest.mjs` 覆盖。
- [[engine-process-tree]] / `lib/engine/process-tree.js` — 受管进程树终止，`test-engine-process-tree.mjs` 覆盖；被 `client.js` 的 `killTree` 调用。
- [[engine-bridge]] / `test-engine-bridge.mjs`、`[[engine-llm-bridge]]` / `lib/engine/llm-bridge.js`、`[[engine-output]]` / `test-engine-output.mjs` 与 `lib/engine/output.js`、`[[engine-python-entry]]` / `lib/engine/python/entry.py` 都是同一迁移在「桥接 / 模型通道 / 落盘 / Python 入口」侧的相关测试与实现，本模块只测其中最内核的契约+客户端+清单+进程树四条边界。

## Known Issues

- **进程层测试依赖 `python` 可用**：`test-engine-client.mjs:238` 用 `process.env.FSOFT_TEST_PY || 'python'` 选解释器，且 `FAKE_MODE` 假引擎需要真 Python 子进程（`162-218`）。在没有 Python 的 CI 上，标着「进程：」前缀的用例会失败，只有纯函数「协议：」前缀用例能跑；这与任务注释里「正常路径有 1C 真实端到端兜底」的设计意图一致，但本身不 mock。
- **`mapFsoftOutput` 在 whole-repository 模式下对 agent 自写页的处理**：当 `moduleTree === {}` 时（`mapping.js:115-150`），不在树里的页仍进写集但 `attribution:'unattributed'` 且 `source_files:[]`，只留 warning 不臆造——这是有意为之的硬规则（`test-engine-contract.mjs` 未直接覆盖分支 `153-188` 的 `unattributed` 路径，仅覆盖了非空树下的 `Ghost/Opaque` 证据分支 `237-258`）。若未来 agent 在空模块树模式产生大量页，需确认 `unattributed` 分支被补测。
- **`engineResult` 的 `engine.deps` 摘要截断 2000、`blocker.detail` 截断 2000、`error.message` 截断 4000**：都是硬上限，测试已验证 `deps.summary` 截断（`test-engine-contract.mjs:102-104`），但 `detail`/`message` 截断未被本模块显式断言（仅在 `contract.js` 源码层面 `90`、`176` 实现）。
- **Windows 进程树路径未被本模块在 CI 跑过**：`process-tree.js:72-80` 走 `taskkill /T /F`，但 `test-engine-process-tree.mjs` 在 POSIX 上起的是 node 子进程；`taskkill` 分支仅逻辑存在、`onLog` 测试（`114-128`）断言日志出现 `taskkill|SIGTERM|SIGKILL` 之一，在 Windows 上才会真正命中 `taskkill` 字样。
- **`runEngine` 默认超时 600000ms**：`test-engine-client.mjs` 里所有进程用例都显式传 `timeoutMs`（多为 20000 或 800），避免误触默认长超时（`client.js:230`）。
