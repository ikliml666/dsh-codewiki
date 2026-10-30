---
title: test_engine_native_job
type: module
source_files:
  - test-engine-native-job.mjs
  - lib/engine/native-run.js
  - test-fixtures/fake-native-engine.mjs
  - index.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/manifest.js
tags: [test, native-engine, job-lifecycle, quality-gate, production-wiring]
---

## Overview

`test-engine-native-job.mjs` 守的是 dsh-codewiki 插件「**原生引擎（FSoft Python）接入 `JobService` 的生产接线**」——即 `codewiki_generate` 提交的任务真的走到原生通道、且其终态由「质量门 + 落地器」严格裁决，而不是「引擎说 done 就算 done」。文件头注释（1–19）把链路画清楚了：

```
codewiki_generate.execute → JobService.submit → tick(300ms) → tickNative
  → runNativeJob → doctor/lock → runEngine(client.js 真 spawn) → 假引擎进程
  → gateNativeOutput(真实) → applyNativeOutput(真实) → cw init/index/meta(真实)
  → autoCommitWiki(真实 git) → finishJob
```

它刻意**不走注入桩**：除了用例 15/16 用假 `runEngine` 锁住「裁决链短路分支」，其余 14 个用例全部走真实链路——因为最易悄悄坏掉的那段正是 `client.js` 的 `spawn` / stdin 一行 JSON / stdout JSON-lines / 进程树终止（1–17 注释）。

测试加速手段（28–36）：
- `process.env.DSH_CODEWIKI_TICK_MS = '300'`：把 tick 间隔从生产默认 10s 压到下限。
- `process.env.DSH_CODEWIKI_JOBS_FILE`：指向按 `pid + 随机 token` 生成的独立 JOBS_FILE，与真实宿主实例隔离（同名文件会被互相洗写，行 29–32）。
- `FAKE_ENGINE`：`test-fixtures/fake-native-engine.mjs`（35），由 `nativeCfg()` 当作 `nativeEngineEntry` 注入（220）。

运行方式：`node test-engine-native-job.mjs`，成功退出码 0（19）。

覆盖的 16 个用例（15–17）：成功 / 首次编译不得伪 done / 引擎 done 被质量门拦下 / 引擎 failed / 协议破坏 / 环境缺失 / 锁漂移 / index 失败 / 基线失败 / 提交失败 / 取消（进程树终止）/ 单项目串行 / 旧默认通道不受影响 / stale 通道归属 / 假 runEngine + 真 gate/apply / 裁决链短路分支。
## Key Components

本模块是**测试脚本**，没有 class/struct 字段；下面列出它导出的顶层常量/函数以及被测目标（`runNativeJob`、`nativeChannelFor` 等）的真实签名与行号。

### 测试侧（test-engine-native-job.mjs）

- `TEST_TOKEN`（31）：`crypto.randomBytes(4).toString('hex')`，与 `pid` 拼成独立 JOBS_FILE，防 pid 复用读到历史 fixture。
- `FAKE_ENGINE`（35）：`path.join(here, 'test-fixtures', 'fake-native-engine.mjs')`，假引擎入口。
- `JOBS_FILE`（36）：从环境变量读，见 Overview。
- `apply`（38）/ `runNativeJob`（39）：动态 `import` 进来的被验证目标。
- `check(cond, msg)`（43–47）：断言累计器，`checks`/`failures` 由文件尾（628–629）统算，失败以 `✗` 打印、`failures++`。
- `norm(p)`（48）：路径 `\\`→`/` 归一化，用于 `cwd` 比较。
- `readJson(p)`（49）/ `exists(p)`（50）：读取 JOBS_FILE 与判断产物文件。
- `madeDirs`（56）+ `makeRepo(tag, opts)`（57–93）：在 `os.tmpdir()` 下造一个带 git 与（可选）预初始化 wiki 的临时仓库（`<base>/<tag>` 是仓库，`<base>/.native-mode-<tag>` 是**仓库外**的假引擎模式文件，理由见下）。返回的 `calls()` 读引擎调用足迹日志。`opts`：`{ mode='done', preInit=false, metaReadonly=false, noEmail=false }`。
  - `preInit`（71–81）：真跑 `cw init` + 写 `CodeWiki.md` 入口 + 提交。用例 2 注释（73–75）说明：首次编译时 `_meta.yaml` 是本次才出现的未提交文件，质量门 `baseline-uncommitted` 会让终态落 `partial`，所以「成功路径」用例必须预初始化以免被连带失败。
  - `metaReadonly`（82–86）：`chmodSync(_meta.yaml, 0o444)` 让 `cw meta update` 真失败（os error 5），同时 `cw index` 仍成功——两条失败互不干扰（用例 9）。
  - `noEmail`（87–90）：清空 `user.email`，让 `autoCommitWiki` 守卫返回 `committed:false`（用例 10）。
  - 模式文件放仓库外（91）：放进仓库会变成一次未提交源码改动，质量门 `uncommitted-input` 会把它判成产品缺陷（53–55）。
- `readCalls(base, tag)`（96–100）：读 `<base>/.native-calls-<tag>.log` 的每行 JSON，是「环境失败/锁漂移时引擎根本没被生成调用」这类断言的唯一证据来源。
- `fakeLlm`（106–110）：`async *stream()` 只 yield 一个 `finish` 事件；`listModels`/`resolveModel` 返回空。旧通道用例（用例 13）不依赖它。
- `articleMd(title, source, type)`（119–120）：合成一篇符合文章契约的 markdown（含 frontmatter）。
- `realSources(repo)`（122–137）：真实扫仓库里源码文件，按真实路径算 `source_files`（避免合同闸门因路径不存在判 `source-missing` 整批失败，见 115–118）。
- `legacyLlmFor(repo)`（139–176）：旧 Node 流水线的最小可用假 llm，`stream()` 按 prompt 首行特征分发，产出符合文章契约的 markdown。特别处理 `root` 模块（144–146）：`localPlan` 把仓库根文件归成 `root` 模块（index.js:1372 的 `slugify(top === path ? 'root' : top)`），只挂根上文件，否则判 `contract` 失败、整任务落 `partial`。
- `makeCtx({ llm })`（178–206）：与 `test-orchestration.mjs` 同构的宿主 ctx mock，返回 `{ ctx, registered, endpoints, disposers }`。`ctx.inject`（189–197）按声明服务切片取实例；`ctx.effect`（199–203）收集 disposer；`services` 含 `webServer.register` / `agents.list` / `tools.register` / `llm`。
- `nativeCfg(extra)`（208–223）：构造生产接线配置：`planMode:'dirs'`、`agenticArticles:false`、`symbolIncremental:false`（避免语义规划/agentic/符号增量额外请求干扰原生通道），`nativeEngine:true`，`nativeEnginePython: process.execPath`、`nativeEngineEntry: FAKE_ENGINE`。
- `waitJob(cwd, { timeout=90000 })`（226–238）：轮询 JOBS_FILE 找到该 `cwd` 的最新 job，等其 `stage ∈ {done,partial,failed,cancelled}`（234）或超时。
- `runJob(repo, opts)`（241–252）：`makeCtx`→`apply(m.ctx, cfg)`→取 `registered.get('codewiki_generate')`→`gen.execute({cwd, scope}, {agent})`→`waitJob`。`finally` 里逐个调用 `disposers` 清理。
- `gitLog(repo, n)`（254）/ `gitShowFiles(repo, sha)`（255）：读取 git 历史与某次提交的文件清单（用于断言「落锁与产物同事务」「提交只含 wiki 路径」）。
- 16 个用例块（258–622）：每个 `console.log` 一个标题，内含若干 `check(...)`，细节见下「用例清单」。

### 被测目标（lib/engine/native-run.js）

- `runNativeJob({ repoRoot, scope, kind, requestId, signal, timeoutMs, requireCommittedInput, docsDir, rawTreeRoot, deps, onProgress, onLog })`（113–126）：跑一次原生编译并给出**严格**终态。内部 `settle(patch)`（144–178）统一出口，调用 `engineResult(base)`（164）强制不变量（done 不许带 blockers、partial 必须带 blockers、failed 必须有 error）。`RANK`/`weakest`（75–76）合成最弱终态。`RESOLUTION`（87）为 `{FULL:'full', UPDATE:'update'}`。导出常量 `DEFAULT_ENGINE_ENTRY`（58）、`DEFAULT_UPDATE_OPTIONS`（68，组件级增量 `rung:'3'`）、`DEFAULT_ENGINE_TIMEOUT_MS`（72，45 分钟）。
- 裁决链早退分支（180–279）：`signal.aborted`→cancelled（180–185）；`doctor`/`lock` 不一致→`engine-missing`/`engine-deps`（240–265）。
- 增量决议（294–390）：读 `collectChangeSet` + `nativeState`，决议 `full`/`update`，写进 `inc`。
- 引擎运行（420–468）：依 `resolution` 选 `generate`/`update` 动作交给 `runEngineImpl`，取消/失败早退。
- 质量门（544–555）：`gateImpl({docsDir, repoRoot, requireCommittedInput})`。
- 落地器（704–722）：`applyImpl({ repoRoot, report, docsDir, ... })`，失败自行回滚（`rolledBack`）。

### 被测目标（index.js，导出函数）

- `apply(ctx, config)`（5178–5242）：插件入口，起 `createJobService`、注册工具、装 webServer。
- `nativeChannelFor(cfg, { kind, scope })`（238–252）：返回 `{python, entry, timeoutMs, scope}` 或 `null`（开关没开/不支持的 scope）。
- `resolveNativePython(cfg)`（256–262）/ `nativeEnginePlan(channel, ...)`（271–287）：解释器解析与引擎子进程描述（模型 key 由调用方显式传，桥只转发）。
- `tickNative(job, channel)`（2839–2924）/ `startNativeRun(job, channel)`（2761–2835）：原生阶段的推进与执行器（`nativeRuns`/`nativeResults`/`nativeAborters`，2747–2749）。
- `submit({ kind, cwd, wikiPath, scope, ... })`（3917–4018）：任务提交，含项目闸门（默认串行→`queued`，4000–4013）。

### 被测目标（lib/engine/quality-gate.js / apply-plan.js / manifest.js）

- `gateNativeOutput({ docsDir, repoRoot, requireCommittedInput })`：质量门，返回 `{ outcome, writable, articles, baseline, counts, canAdvanceBaseline }`。`assessBaseline`（187–243）决定 `baseline-uncommitted` 等判据（用例 2、9）。
- `applyNativeOutput({ repoRoot, report, docsDir, extraFiles, deleteFiles, ... })`：落地器，返回 `{ outcome, applied, rolledBack, baseline:{advanced}, commit:{committed,sha}, deleted, pruned, index }`（用例 8/9/10 断言）。
- `doctor`/`probeEnvironment`/`buildLockBody`/`ENGINE_LOCK_REL`（`manifest.js`）：锁校验与落锁正文（用例 6/7）。

### 被测目标（lib/engine/client.js / process-tree.js）

- `runEngine`（即 `client.js` 的导出 `runEngine`，`native-run.js:47` 注入为 `realRunEngine`）：起受管子进程，喂一行请求 JSON、读 JSON-lines；协议不变量见 client.js 注释（13–20）：没有 `result` 消息=协议破坏（即使退出码 0），取消后迟到 result 记 `late-result`（用例 5、11、16）。
- `terminateProcessTree(pid, { graceMs, onLog })`（`process-tree.js`）：POSIX 用 `detached` 进程组 + `process.kill(-pid)`（SIGTERM→超时 SIGKILL），Windows 用 `taskkill /T /F`；保证取消时孙进程（flake8/find 等）也被杀掉（用例 11 的「进程树已终止」）。

### 用例清单（test-engine-native-job.mjs 行号）

| 用例 | 行号 | 验证点 |
|---|---|---|
| 1 完整成功 | 258–311 | `done` 只由 gate+apply 共同成立；落锁与产物同提交；提交只含 wiki 路径；模型桥占位 key 不落盘 |
| 2 首次编译不得伪 done | 313–328 | `partial` 而非 `done`；`_meta.yaml` 基线仍 `null` |
| 3 引擎 done 被质量门拦下 | 330–342 | `empty-docs` 模式：引擎回 done 但无产物→`failed` |
| 4 引擎 failed | 344–354 | `failed` 且不进 gate/apply |
| 5 协议破坏 | 356–364 | `crash` 模式只写人类日志、无 result→`failed` |
| 6 环境缺失 | 366–381 | 解释器不存在→`engine-missing`，从不调 generate |
| 7 锁漂移 | 383–399 | 写旧锁→`engine-deps`/`drift`，不跑 generate |
| 8 index 失败 | 401–414 | `_index.md` 建成目录→`failed`+`rolledBack` |
| 9 基线失败 | 416–428 | `_meta.yaml` 只读→`baseline-failed`+整批回滚 |
| 10 提交失败 | 430–441 | 无 email→`partial`，产物保留、基线不推进 |
| 11 取消 | 443–481 | 调 `/api/codewiki/control` cancel→`cancelled`+进程树终止；迟到结果不覆盖终态 |
| 12 单项目串行 | 483–509 | 第二仓库 `queued`，前者收尾后自动轮到 |
| 13 旧默认通道 | 511–520 | `nativeEngine:false`→`channel=legacy`，原生引擎 0 次调用 |
| 14 stale 通道归属 | 522–542 | 阶段 5 后 `nativeChannelFor(kind=stale)` 返回通道快照、scope 透出 |
| 15 假 runEngine+真 gate/apply | 544–577 | 假 runEngine 报 done 但空产物→真质量门 `failed` |
| 16 裁决链短路 | 579–622 | 假 runEngine 的 cancelled/failed 分支短路不进 gate/apply；提前 abort→cancelled |
## Architecture

测试把「生产接线」端到端跑了一遍。组件 ≥3 且流程非平凡，框图如下（文件名/类标注）：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ test-engine-native-job.mjs（用例 1–16）                                │
│  makeCtx (178) → apply(ctx,cfg) (index.js:5178) → gen.execute (4096)  │
│  waitJob (226) 轮询 JOBS_FILE                                          │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ submit (index.js:3917)            │ register tool
                ▼                                   ▼
┌───────────────────────────┐            ┌──────────────────────────────┐
│ createJobService tick(300) │            │ register('codewiki_generate')│
│ (index.js:3788 tick)       │            │ register('/api/codewiki/     │
│  ├ serial 闸门→queued      │            │   control' cancel 端点)      │
│  └ nativeChannelFor(238)   │            └──────────────┬───────────────┘
│        ↓ channel 锁定       │                           │ cancel(jobId)
└───────────────┬────────────┘                           │
                │ tickNative (index.js:2839)             │
                ▼ startNativeRun (2761)                   │
┌─────────────────────────────────────────────────────┐ │
│ runNativeJob (native-run.js:113) 裁决链一条直线：    │ │
│  env(doctor+lock) → 增量决议 → runEngine →          │ │
│  gateNativeOutput(quality-gate.js) →                 │ │
│  applyNativeOutput(apply-plan.js) → cw index/meta   │ │
│  → autoCommitWiki（真实 git）                         │ │
└───────────────┬─────────────────────────────────────┘ │
                │ realRunEngine = client.js runEngine (223)│
                ▼                                          │
┌──────────────────────────┐  spawn (真进程)   ┌────────────────────────┐
│ client.js runEngine (223) │ ───────────────► │ 假引擎 fake-native-     │
│ terminateProcessTree      │   stdin 一行 JSON │ engine.mjs (真 node 进程) │
│ (process-tree.js)         │ ◄─────────────── │ 模式文件在仓库外(91)    │
│                           │   stdout JSON-lines│ 足迹写 .native-calls    │
└──────────────────────────┘                   └────────────────────────┘
                │                                   ▲ abort 信号
                └───────────────────────────────────┘ (cancel→进程树终止)
```

关键接线不变量（native-run.js:11–17 与 contract 叠加）：
1. 锁不一致/依赖不闭合→直接 `failed`，**不跑引擎**（用例 6/7）。
2. 引擎 `done` 不能替代质量门（用例 3/15）。
3. 落地器 `partial/failed`→终态不许 `done`（用例 8/9）。
4. `partial/failed` 一律不推进基线 `canAdvanceBaseline=false`（用例 2/9/10）。
5. 取消是终态，不再 gate/apply，迟到结果不覆盖（用例 11/16）。

用例 15/16 用**依赖注入**把 `runEngine` 换成假函数（`runNativeJob` 的 `deps.runEngine`，`native-run.js:114`），但 `gateNativeOutput`/`applyNativeOutput` 仍走真实实现——既覆盖接线又覆盖裁决（544–622）。其余用例全部走真实 `client.js` spawn 真进程（注释 1–17）。
## Data Flow

以用例 1（完整成功，258–311）为代表的端到端数据流：

1. **提交**：`makeRepo('ok', {mode:'done', preInit:true})`（261）造仓库并预初始化 wiki；`runJob(repo)`（263）→`apply(m.ctx, nativeCfg())`（243）→`gen.execute({cwd:repo, scope:'full'}, {agent})`（246）→`submit`（index.js:3722）写一条 `submitting` 占位 job，立即 `void tick()`（4016）。
2. **tick 接通道**：`tick`（3788）在原生闸门段（3871–3899）调 `nativeChannelFor`（3877）拿到 `{python, entry, timeoutMs, scope}`，写 `job.channel='native'`、`job.nativeChannel`（3879–3881），再 `tickNative`（3893）。
3. **启动原生运行**：`tickNative`（2839）首轮 `startNativeRun`（2761）：`docsDir` 放仓库外 `os.tmpdir()/dsh-codewiki-native-<id>`（2771，避免产物污染工作区触发 wiki-missing），注入 `engineFor`/`llm`/`applyDeps`（2787–2800），调 `runNativeJob`（2773）。结果进 `nativeResults`（2817）。
4. **裁决链**：`runNativeJob`（native-run.js:114）内部 `doctor` 校验锁（219–269）→ 增量决议（284–380）→ `runEngine`（真实 `client.js` 起假引擎进程，医生一次 doctor + 一次 generate，足迹见 `calls()`）→ `gateNativeOutput`（505）→ `applyNativeOutput`（663）→ `cw index/meta` + `autoCommitWiki`（注入的 `applyDeps.commit`，2799）。`settle`（144）合成 `outcome` 并经 `engineResult`（164）强制不变量。
5. **收割**：下一轮 `tickNative`（2841）从 `nativeResults` 取结果，写 `job.writtenCount/failedCount/blockers/error/nativeResult`（2853–2874）；`finishJob`（2908）把 `done/partial/failed` 落为终态，`canAdvanceBaseline` 由 `res.canAdvanceBaseline`（2889–2891）决定。取消分支（2895–2904）单独置 `cancelled`。
6. **断言**：`waitJob` 等到 `done`（234）后，用例 1 校验 `job.channel==='native'`、`outcome==='done'`、`canAdvanceBaseline===true`、`gate.outcome==='done' && writable`、`apply.outcome==='done' && applied`、`apply.baseline.advanced`、`apply.commit.committed`（266–274）；并断言引擎锁随产物进同一提交（`gitShowFiles` 含 `.codewiki/engine-lock.json`，284–285）、提交只含 wiki 路径（303）、模型桥占位 key 不落 JOBS_FILE（309）、引擎确实被调用且 generate 恰好一次（296–298）。

失败路径数据流差异：
- 用例 2（313–328）：`preInit:false`→`_meta.yaml` 未提交→`gateNativeOutput` 的 `assessBaseline` 报 `baseline-uncommitted`→`outcome==='partial'`、`canAdvanceBaseline===false`、blockers 含 `baseline-failed`，但文章仍落地（`partial` 是可交付的部分成功）。
- 用例 8/9（401–428）：`applyNativeOutput` 在 `cw index` 或 `cw meta update` 失败时把写入回滚（`rolledBack===true`），终态 `failed`。
- 用例 10（430–441）：`autoCommitWiki` 因无 email 守卫返回 `committed:false`→终态 `partial`、产物保留、基线不推进（提交失败不回滚不变量）。
- 用例 11（443–481）：`/api/codewiki/control` 的 cancel → `service.cancel`（4020）置 `cancelRequested`；下一轮 `tick` 取消段（3825–3845）abort `nativeAborters`（3840），`client.js` 经 `terminateProcessTree` 杀掉假引擎进程树；`runNativeJob` 内部的 `signal.aborted` 早退分支（180）出 `cancelled`，迟到结果被 `late-result` 丢弃（client.js:1517）。

产物目录（documentsDir）位置约定：`startNativeRun` 强制仓库外临时目录（2771），与 `runNativeJob` 参数 `docsDir`（native-run.js:114）一致；落地器 `applyNativeOutput` 的 `extraFiles` 在 3.6 段把引擎锁写进同一写集（native-run.js:52–667），保证「落锁与产物同事务」（用例 1 的 277–292 注释）。
## Connections
## Known Issues
