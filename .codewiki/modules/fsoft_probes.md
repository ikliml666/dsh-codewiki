---
title: fsoft_probes
type: module
source_files:
  - .probe-idxfail.mjs
  - .probe-inc.mjs
  - .probe-nochange-commit.mjs
  - .probe-nochange.mjs
  - .probe-run-all-tests.mjs
  - .probe-two-round.mjs
  - .probe3.mjs
  - test-fixtures/fake-native-engine.mjs
  - lib/engine/client.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
  - lib/engine/contract.js
  - lib/engine/process-tree.js
  - index.js
tags: [engine, probes, native-pipeline, client-factory, fsoft]
---

## Overview

`fsoft_probes` 不是仓库里一个长期保留的目录，而是一组**临时探针脚本**（仓库根目录下文件名以 `.probe-` 开头）外加它们依赖的「客户端工厂」与「假引擎」契约装置。它们服务于同一个目标：在把 dsh-codewiki 的编译流水线迁移到 FSoft 原生 Python 引擎（阶段 4/阶段 5）时，用最小成本**现场验证生产接线**，而不是靠单元测试覆盖不到的链路去猜。

这些探针脚本的共同套路是：

- 在 `os.tmpdir()` 下 `mkdtempSync` 一个临时仓库，写入真实的 `core/core.py`、`util/util.py`，跑 `git init` + 两到三个提交，再用 `cw init` 建立 `.codewiki/` 骨架；
- 通过环境变量 `DSH_CODEWIKI_TICK_MS`（压到 `'300'`）和独立的 `DSH_CODEWIKI_JOBS_FILE` 把真实的 `JobService`（来自 `index.js` 的 `apply`）启动起来，使 `codewiki_generate` 工具真的走 `tick → tickNative → runNativeJob` 这条生产通道；
- 或者更直接地 `import('./lib/engine/native-run.js')` 拿到 `runNativeJob`，绕过 JobService 单跑一次编译；
- 用 `test-fixtures/fake-native-engine.mjs` 当「引擎」——它是一个**真进程**（node 当解释器、该文件当入口），只实现协议与产物、不实现算法，所以 `lib/engine/client.js` 的 spawn / stdin 一行 JSON / stdout JSON-lines / 进程树终止全部走真实代码路径。

探针只 `console.log` 事实、不做断言，跑完即删（文件头注释都写「跑完即删」）。它们与本模块的「客户端工厂」`nativeEnginePlan`（`index.js:268`）与 `engineFor` 注入点（`index.js:2769`）是一体两面：探针验证工厂产出的 `{ command, args, env }` 真能驱动引擎走完 `doctor → generate/update → gate → apply`。

注意：`.probe-fsoft/probe-home/` 目录当前为空，是阶段 1C 实测时遗留的空壳（`.probe-fsoft/wiki_out_1c` 采集产物已不在仓库中），不要把它当成有内容的模块目录。

## Key Components

本模块由 7 个探针脚本 + 1 个假引擎契约夹具 + 1 个客户端工厂（及若干被验证的引擎库）组成。

### 探针脚本（仓库根，文件名以 `.probe-` 开头，跑完即删）

#### `.probe-idxfail.mjs`（57 行）
验证「index 失败后 HEAD 为何前移」的怀疑。直接 `import { runNativeJob } from './lib/engine/native-run.js'`（`.probe-idxfail.mjs:6`），在临时仓库里：
- 第一轮 `runNativeJob({ repoRoot, scope: 'full', docsDir: d1 })`（`.probe-idxfail.mjs:31`）；
- 改 `core.py` 提交 → `git('rev-parse', 'HEAD')` 记 `headV2`（`.probe-idxfail.mjs:34-37`）；
- 第二轮 `scope: 'stale'`，但通过 `deps.runCw` 把 `args[0]==='index'` 的调用**伪造失败**（exit 1、stderr `模拟：cw index 失败`）（`.probe-idxfail.mjs:43-48`）；
- 打印 `HEAD` 前后是否变化、必要时 `git('show', '--name-only', ...)` 看新提交到底提交了什么（`.probe-idxfail.mjs:52-56`）。
结论性证据：落地器 `apply-plan.js` 的「索引失败即回滚」硬不变量（`lib/engine/apply-plan.js:16-19`）意味着 index 失败时不应产生新提交，`headV2 === head2` 应当为真。

#### `.probe-inc.mjs`（78 行）
验证「两轮 native 增量在生产链上的真实行为」。它是**最贴近生产**的探针：
- `const { apply } = await import('./index.js')` 拿到真实 `apply`（`.probe-inc.mjs:14`）；
- 自己造一个最小 cordis 风格的 `ctx`（含 `webServer.register`、`agents.list`、`tools.register`、`llm`、`inject`、`on`、`effect`），调 `apply(m.ctx, cfg)` 把真实 `JobService` 启动（`.probe-inc.mjs:32-57`）；
- `cfg` 里有 `nativeEngine: true`、`nativeEnginePython: process.execPath`、`nativeEngineEntry: FAKE_ENGINE`，且 `FAKE_ENGINE` 指向真实 `test-fixtures/fake-native-engine.mjs`（`.probe-inc.mjs:15,45`）；
- `run(scope)` 拿到注册表里的 `codewiki_generate`，`gen.execute({ cwd: repo, scope }, { agent: { id: 'probe' } })`，再 `waitJob(repo)` 轮询独立 `JOBS_FILE`（`.probe-inc.mjs:56-63`）；
- 第一轮 `full`、第二轮改 `core.py` 后 `stale`（`.probe-inc.mjs:66-75`），分别打印 `nativeResult.incremental`、`nativeResult.apply`、`state.json` 是否生成、`blockers`（`.probe-inc.mjs:67-77`）。

#### `.probe-nochange-commit.mjs`（44 行）
验证「无变化轮到底提交了什么内容」。直接 `runNativeJob`（`.probe-nochange-commit.mjs:30`）两连跑：第一轮 `full`、第二轮用模式文件 `.native-mode-nochange`（`update-nochange`）做 `stale`（`.probe-nochange-commit.mjs:34-35`），打印 `r.incremental.resolution`、`r.incremental.updateOutcome`、`r.apply.commit.files`、`HEAD` 是否前移（`.probe-nochange-commit.mjs:31-43`）。这是本模块里直接观察「无变化轮不制造提交」的探针（仅打印 HEAD 与提交文件，不做断言，与 Overview 中“探针只 console.log 事实、不做断言”一致）。

#### `.probe-nochange.mjs`（83 行）
「用例 2（update-nochange）为什么卡住」。与 `.probe-inc.mjs` 同构：造 `ctx`、`apply`、`submit(scope)`、`poll(tag)`（`.probe-nochange.mjs:32-69`），第一轮 `full`、第二轮写 `.native-mode-repo = update-nochange` 再 `stale`（`.probe-nochange.mjs:78-79`）。与第一版不同点在于它把 `jobs` 文件里 `blockers` / `nativeStage` / `notes`（`.probe-nochange.mjs:81`）和引擎足迹 `.native-calls-repo.log`（`.probe-nochange.mjs:58`）全部 dump 出来，用来定位「卡住」的位置（env / graph / articles / validate / index / baseline / commit）。

#### `.probe-run-all-tests.mjs`（22 行）
不是引擎探针，而是一个**批量跑测试**的驱动脚本：`readdirSync(process.cwd())` 过滤 `test-*.mjs`（排除 `test-wiki-anchors.mjs`），逐个 `spawn(process.execPath, [file])`，`stdio: 'ignore'`，累计 failures（`.probe-run-all-tests.mjs:1-21`）。输出写入 `C:/Users/ik/AppData/Local/Temp/codewiki-native-full-tests.log`（`.probe-run-all-tests.mjs:5`），最后 `process.exitCode = failures ? 1 : 0`。它属于本模块是因为它是阶段 4 全量回归的「一键跑全套 native 测试」工具。

#### `.probe-two-round.mjs`（70 行）
「两轮原生编译（第一轮 full → 第二轮 stale 走 update）现状验证」。直接 `import { runNativeJob }`（` .probe-two-round.mjs:50`），第一轮 `full`、第二轮改 `core.py` 提交后 `stale`（`.probe-two-round.mjs:38,60`）。打印 `r.incremental.resolution / baseCommit / headCommit / changeCount / updateOutcome / hydrated / fallback`、以及 `stateDir` 下的文件名清单（`walk`）、还有引擎足迹 `.native-calls-repo.log`（`.probe-two-round.mjs:53-54`）。它验证「stage5 接线是否真的让第二轮进了 update 分支」。

#### `.probe3.mjs`（61 行）
最轻量的「提交制」探针：`import { apply }`、造 `ctx`（更小，没有 `webServer` 的 register 实现细节，用空函数）、`apply(m, { nativeEngine, nativeEnginePython, nativeEngineEntry })`（`.probe3.mjs:8,30-34`）。第一轮 `full`、第二轮既 `git add staged.py` 又改 `core.py` 再 `stale`（`.probe3.mjs:54-56`），重点打印 `r2.kind / scope / channel` 与 `nativeResult.incremental / notes`（`.probe3.mjs:50-52`），用来确认「提交制任务真的走了 native 通道、scope 如实透传」。

### 假引擎契约夹具 `test-fixtures/fake-native-engine.mjs`（324 行）

所有探针的 `nativeEngineEntry` 都指向它。它通过**模式文件**（`modeFileFor` / `modeOf`）或环境变量 `FAKE_ENGINE_MODE` 决定行为（`.probe-fake` 即 `test-fixtures/fake-native-engine.mjs:27-40`）：`done / partial / fail / crash / stall / bad-yaml / empty-docs / update-fallback / update-nochange / deps-bad / slow` 等。关键契约装置：

- `logCall(repoPath, action, extra)`（`.probe-fake:52-57`）：把「谁跑过、跑了哪个动作、收到了哪些 `updateOptions`、真的读到了哪些受管状态输入」写到仓库**同级**的 `.native-calls-<repo>.log`，这是「引擎真的消费了水合进来的旧图/旧树」的唯一硬证据（`.probe-fake:65-88` 的 `readStateInputs` 逐项 stat）。
- `writeDocs(docsDir, repoPath, { action, commitId })`（`.probe-fake:131-201`）：**只写真实存在的源码文件**（`realSourceFiles`，`.probe-fake:112-129`），页面**不带 frontmatter**（落盘层合成），`action==='update'` 时**不重写**已有页（`.probe-fake:158-162`）。同时写出 `metadata.json`、`module_tree.json`、`update_record.json`，其中 `update_record.json` 的 `outcome` 由 `action` 与 `MODE` 推导（`.probe-fake:193-200`）。
- `run(req)`（`.probe-fake:203-314`）：读 stdin 一行 JSON，按 `action`（`doctor` / `generate` / `update`）分支，发出 `hello` / `progress` / `result` 的 JSON-lines。`result` 里带 `updateOutcome` 与 `stateFiles`（`.probe-fake:294-313`），供 `native-run.js` 与「实际采集结果」交叉核对（见 `lib/engine/native-run.js:556-561`）。

### 客户端工厂（生产代码，被探针验证）

#### `nativeEnginePlan(channel, { requestId, bridge, model, clusterModel })` — `index.js:268`
构造引擎子进程描述 `{ command, args, env }`。注意 `env` 强制 `PYTHONIOENCODING: 'utf-8'`、`PYTHONUTF8: '1'`、`CODEWIKI_NO_KEYRING: '1'`（`.probe-index:269-275`，即 `index.js:269-275`）；当 `bridge` 存在时把 **占位 key**（`bridge.placeholderKey`）和模型名写进 `CODEWIKI_BASE_URL / CODEWIKI_API_KEY / CODEWIKI_MAIN_MODEL / CODEWIKI_CLUSTER_MODEL`（`.probe-index:276-283`，即 `index.js:276-283`）。**关键缺陷警示**写在 `index.js:263-267`：模型名必须由调用方显式传入，曾经写成 `bridge.model` 会得到 `undefined`，导致 `CODEWIKI_MAIN_MODEL` 空串、引擎在 cluster 阶段以 `engine-model` 失败。

#### `engineFor` 注入点 — `index.js:2769`
在 `startNativeRun` 里以 `deps.engineFor: ({ bridge }) => nativeEnginePlan(channel, { requestId, bridge, model: c.batchModel, clusterModel: c.batchModel })` 形式注入 `runNativeJob`（`.probe-index:2769-2775`，即 `index.js:2743-2749`）。这就是「客户端工厂」的接线点：同一个 `{ python, entry, timeoutMs }` 通道，每次 runNativeJob 需要时由它按需生成带最新 `bridge` 的引擎描述。

#### `nativeChannelFor(cfg, { kind, scope })` — `index.js:235`
决定原生通道是否接管本次任务（返回 `null` 走旧流水线）。阶段 5 起 `stale` / `auto` 也接管，由 `native-run.js` 自己决定 `update` 还是 `full`（`.probe-index:235-249`，即 `index.js:235-249`）。

#### 被验证的引擎库（属于 [[fsoft_engine]] 模块，但本模块直接消费）

- `createProtocolReader({ requestId, maxLineBytes })` — `lib/engine/client.js:39-186`：增量式 JSON-lines 读取器，纯逻辑不碰进程，可被逐字节喂；产出 `progress / errors / violations / result` 与 `cancelled / endedWithResult` 状态。
- `runEngine({ engine, requestId, action, payload, cwd, env, timeoutMs, signal, onProgress, onLog, maxLineBytes, graceMs })` — `lib/engine/client.js:223-422`：起一个受管子进程、写一行请求 JSON、读回 JSON-lines，超时/取消/崩溃/协议破坏都给可机读失败。
- `runNativeJob({ repoRoot, scope, kind, requestId, signal, timeoutMs, requireCommittedInput, docsDir, deps, onProgress, onLog })` — `lib/engine/native-run.js:109-761`：一次原生编译的完整裁决链（env → 增量决议 → 水合 → 引擎 → gate → apply）。
- `engineResult / engineProgress / engineError / ENGINE_CONTRACT_VERSION / ENGINE_STAGES / UPDATE_OUTCOMES / BLOCKER_KINDS / ENGINE_ERROR_CODES` — `lib/engine/contract.js:20-215`：跨进程契约与硬不变量。
- `terminateProcessTree(pid, { graceMs, onLog })` / `isAlive(pid)` — `lib/engine/process-tree.js:41-113`：取消语义的地基（整棵杀死 python 派生的孙进程）。

## Architecture

## Data Flow

## Connections

## Known Issues
