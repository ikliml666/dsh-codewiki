---
title: fsoft_engine_fixtures
type: module
source_files:
  - test-fixtures/fake-native-engine.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - test-engine-native-job.mjs
  - test-engine-native-incremental.mjs
  - test-graphdiff.mjs
  - lib/engine/native-run.js
  - lib/engine/client.js
  - index.js
tags: [fixtures, test, native-engine, fsoft, fake-engine]
---

## Overview

这个模块是 **FSoft 原生引擎（Python）的测试夹具集**，为「原生引擎生产接线」与「统一增量生产链」的端到端测试提供可重复、可断言的假实现。它不是被测代码的一部分，而是为了让 `lib/engine/native-run.js`、`lib/engine/client.js` 走**完全真实的进程路径**（真 spawn、真 stdin 一行 JSON、真 stdout JSON-lines、真进程树终止），同时把「算法」替换成一个只实现协议与产物、不实现任何聚类/图 diff/文章写作的进程。

核心文件有两个用途完全不同的夹具：

- `test-fixtures/fake-native-engine.mjs` —— 一个**真进程**假引擎。Node 进程把它当 Python 入口脚本跑（`nativeEnginePython` 设为 `process.execPath`、`nativeEngineEntry` 设为该文件），通过 `FAKE_ENGINE_MODE` 环境变量、仓库同级的 `.native-mode-<repo>` 模式文件、或仓库目录名里的 `__<mode>__` 段来切换行为（done / partial / fail / crash / stall / slow / empty-docs / bad-yaml / deps-bad / update-… 等）。它会被 `client.js` 的 `runEngine` 真正 spawn 起来，并自报产物与「调用足迹」，从而让测试断言「JobService → 引擎」这条接线确实成立、且质量门/落地器的裁决不被引擎自评绕过。
- `test-fixtures/gen-graphdiff-golden.py` + `test-fixtures/graphdiff-golden.json` —— 用 Python 原生 `difflib`/`hashlib` 生成 `lib/graph-diff.js` 移植版的**对拍基准**，由 `test-graphdiff.mjs` 消费，验证 Node 侧排序与上游逐位一致（与 native 通道无直接关系，但同属「FSoft 引擎相关夹具」）。

为什么要一个真进程而不是注入一个假函数？详见 `test-fixtures/fake-native-engine.mjs` 1-7 行注释：注入假 `runEngine` 会让 `client.js` 的 spawn/协议解析/进程树终止全部被绕开——那正是最容易悄悄坏掉的一段（真跑时才发现 ENOENT、编码、退出码）。

## Key Components

### test-fixtures/fake-native-engine.mjs

这是模块的主夹具。下面逐项列出其公开函数/常量/行为，行号以源码前缀为准。

**模块级常量与模式解析**

- `modeFileFor(repoPath)` —— `test-fixtures/fake-native-engine.mjs:27-30`。返回仓库同级的模式文件路径 `.native-mode-<basename>`，把模式文件放在仓库外是为了不污染被测仓库（避免 `uncommitted-input` 把测试脚本当成产品缺陷）。
- `modeOf(repoPath)` —— `:31-40`。解析当前用例模式：优先级为 `FAKE_ENGINE_MODE` 环境变量 > 同级模式文件 `.native-mode-<tag>` > 仓库目录名里的 `__<mode>__` 段（正则 `/__([a-z-]+)__/i`）。同一测试进程连续跑多个用例，子进程继承的是启动那一刻的 `process.env`，所以靠改 env 切换模式会与仍在收尾的上一个任务竞态。
- `MODE` —— `:41`。当前用例模式，模块级可变变量，在 `run()` 内由 `modeOf` 重新赋值。
- `VERSION` / `PYVER` —— `:42-43`。分别来自 `FAKE_ENGINE_VERSION`（默认 `9.9.9`）与 `FAKE_ENGINE_PYVERSION`（默认 `3.13.0`），写进 `doctor`/result 的 `engine` 字段，模拟真实 FSoft 版本指纹。
- `REAL_STDOUT` —— `:44`。缓存 `process.stdout`，因为 `crash` 模式要向协议流写人类日志行。

**调用足迹与状态探测**

- `logCall(repoPath, action, extra)` —— `:52-57`。把「谁跑过、跑了哪个动作、收到什么增量参数、真的读到了哪些受管状态输入」以 JSON 行追加写进仓库同级的 `.native-calls-<tag>.log`。这是「环境失败/锁漂移时引擎根本没被生成调用」这类断言的唯一证据来源（被动方提供，调用方无法伪造）。
- `readStateInputs(docsDir, repoPath)` —— `:65-88`。引擎真的去 stat 上一轮水合进来的受管状态：逐项目检查 `module_tree.json`、`metadata.json`、按 FSoft sanitize 规则命名的依赖图 `<docs>/temp/dependency_graphs/<repoName>_dependency_graph.json`、`update_record.json`，并递归统计 `docs` 下的 `.md` 篇数。返回结果写进 `logCall` 的足迹，证明「水合进来的受管状态确实被引擎消费」——对照真实 FSoft `doc_generator.py:415-427` 的 `_update_options()` 靠这些文件存在与否决定走不走增量。

**产物写入**

- `realSourceFiles(repoPath, limit=4)` —— `:112-129`。真的扫描仓库里存在的源码文件（`*.py|ts|js|mjs|go|rs|java`，忽略 `.git` 与以 `.` 开头的目录，深度 ≤4），最多 `limit` 个。模块树与页面只能引用这些真实存在的文件，否则 `output.js` 的 `source-missing` 会把每篇都判成产品缺陷 → 永远 partial。
- `writeDocs(docsDir, repoPath, { action, commitId })` —— `:131-201`。写出一份「干净 docs」的心脏逻辑：
  - 建 `modules/` 目录，取 `commitId || head(repoPath)` 作为 `sha`（`:133`）。
  - 按 FSoft 规则重写依赖图 `<docs>/temp/dependency_graphs/<repo>_dependency_graph.json`（`:137-150`），**必须写**：下一轮组件级增量读的就是它，缺了它就 `isUpdateEligible()` 判缺图退全量。
  - 页内**不带 frontmatter**（`:151-154`）：真实 FSoft 产物是纯 markdown，frontmatter 由渲染层 `renderArticle` 合成；夹具自带会触发 `article-contract` 的 `duplicate-frontmatter`。
  - 增量（`action=update`）**不重写**已有页（`:158-162` 的 `keep` 闭包），否则「无变化不重写」不变量在测试里观察不到。
  - `partial` 模式：把 `web.md` 写成空正文（`:165-172`），正好落在质量门已有的 `empty-body` 判据上。
  - 写 `metadata.json`：`generation_info.commit_id` 即下一轮 updater 眼里的 `old_commit`（`:173-180`）；`bad-commit` 模式写 40 个 `b` 模拟坏 commit。
  - 写 `module_tree.json`：`components` 的 `path::Symbol` 指真实文件（`mapping.js` 的 `sourceFilesOf` 把 `::` 前一段当成 `source_files`，编不存在路径会判 `source-missing`）（`:184-187`）。
  - 写 `update_record.json`：`outcome` 在 update 时依 `MODE` 取 `full_fallback`/`no_change`/`incremental`（`:193-200`）。

**协议输出与 git 辅助**

- `emit(obj)` —— `:90-92`。向 `REAL_STDOUT` 写一行 JSON。
- `progress(requestId, stage, percent, message)` —— `:93-95`。发 `type:'progress'`。
- `result(requestId, body)` —— `:96-98`。发 `type:'result'`。
- `head(repoPath)` —— `:100-104`。`git rev-parse HEAD`，用于把当前 HEAD 记进 `metadata.json`。

**主分发逻辑 `run(req)`**

- `run(req)` —— `:203-314`。读取 `req.requestId` / `req.action` / `req.repoPath` / `req.docsDir` / `req.updateOptions` / `req.commitId`，先发 `hello`（`:207`），把调用足迹 + 读到的受管状态写进 `.native-calls-*.log`（`:210-214`），再按 `action` 与 `MODE` 分发：
  - `doctor`（`:216-231`）：`deps-bad` 模式回 `deps.ok:false`，否则回 `ok:true`。
  - 未知动作（`:233-236`）：回 `failed` + `engine-protocol`。
  - `stall`（`:238-243`）：发一条 progress 后进 `setInterval` 永不退出，只能被取消（验证取消会终止进程树）。
  - `slow`（`:244-263`）：约 `FAKE_ENGINE_DELAY_MS`（默认 1200ms）后真的写完产物再回 `done`，用于验证「上一个仓库还在跑时后提交的进 queued 排队」（串行测试不该顺带验证取消）。
  - `fail`（`:264-272`）：回 `outcome:'failed'` + `engine-crashed`。
  - `crash`（`:273-277`）：协议破坏——只向协议流写人类日志行 `INFO loading tree-sitter grammar`、不写 result（退出码 0 也会被判失败）。
  - `empty-docs`（`:278-282`）：回 `done` 但不写任何产物（验证「引擎 done 不能替代质量门」）。
  - 默认全量/增量成功路径（`:284-314`）：发 graph/cluster/articles 三段 progress，调 `writeDocs`，回 `done` 并带 `artifacts`（含 `docsDir`、`updateRecord`、以及 `stateFiles` 清单——`native-run.js` 会与实际采集结果交叉核对，不一致记进 notes）。`updateOutcome` 在 update 时依 `MODE` 自报（`:294-296`），让「引擎说回退/无变化」这条裁决链在测试里真的被走过。

**stdin 读取入口（进程边界）**

- `process.stdin` 监听（`:316-324`）：累积 stdin，读到 EOF 时取第一行 JSON 解析后调 `run(req)`；任何异常都回一个 `engine-crashed` 的 `result`，保证进程退出码语义与契约一致。

> 注意：模块里**没有** class/struct、没有实例字段、没有 `__str__`/`save()`——它是一个纯函数的无状态 CLI 脚本（状态全靠 `MODE` 变量与文件系统上的模式/足迹/产物文件表达）。

### test-fixtures/gen-graphdiff-golden.py

这是 `lib/graph-diff.js` 移植版的对拍基准生成器（与 native 通道无直接关系，但同属 FSoft 引擎相关夹具）。所有函数均为模块级纯函数，无 class。

- `normalize_body(text)` —— `:19-21`。把空白压成单空格并 strip，对应 `lib/graph-diff.js` 的 `normalizeBody`。
- `documented_source(code, docstring)` —— `:23-27`。把 docstring 拼到 code 前（若未包含），对应 `documentedSource`。
- `body_hash(code, docstring)` —— `:30-32`。返回拼接后文本的 sha1 hex，对应 `bodyHash`（用 `hashlib.sha1` 而非 Node `crypto`）。
- `_tokens(text)` —— `:34-36`。正则 `\w+|[^\w\s]` 分词。
- `body_similarity(a, b)` —— `:38-44`。用 `difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()` 算相似度，对应 `bodySimilarity`。
- `unified_body_diff(old_lines, new_lines, label, n=2)` —— `:47-49`。`difflib.unified_diff` 包装。
- `main()` —— `:52-148`。用固定种子 `random.Random(20261027)` 构造：相似度用例（含空/完全相同/重复 token/中文等 13 个手写 + 30 个随机）、hash 用例（6 个手写）、unified diff 用例（9 个手写含无末尾换行/纯增删/多 hunk + 20 个随机）、随机 diff 用例（20 个）。每个用例带 `expected`，以 `json.dump(..., indent=1)` 输出到 stdout。

生成方式：`python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`（`test-graphdiff.mjs:3`、`:15`）。`test-graphdiff.mjs` 读 `graphdiff-golden.json` 后逐条比对 `bodySimilarity` / `bodyHash` / `unifiedDiff` 与上游逐位一致（`:28-42`），再独立验证组件级 `diffGraphs` 的改名配对/interface/body/edge 分类（`:55-104`）。

> 注意：`graphdiff-golden.json` 是生成产物（非手写），不在本次源码阅读范围内展开逐行，但其存在是 `test-graphdiff.mjs` 的前置依赖。

## Architecture

`fake-native-engine.mjs` 只在「被当作 Python 入口 spawn」的语境里才有意义，它与 `lib/engine/client.js`（薄适配层）和 `lib/engine/native-run.js`（裁决链）构成一个真实的跨语言接线。框图如下：

```text
┌──────────────────────── 测试进程 (test-engine-native-*.mjs) ────────────────────────┐
│  makeRepo(tag, mode) → 写 .native-mode-<tag> 模式文件                               │
│  runJob(repo) → apply(ctx, nativeCfg{ nativeEnginePython=node,                       │
│                   nativeEngineEntry=FAKE_ENGINE }) → codewiki_generate.execute        │
└───────────────┬────────────────────────────────────────────────────┬───────────────┘
                │ 提交 job（channel 待定）                             │ tick()
                ▼                                                      ▼
┌─────────────────────── JobService (index.js) ──────────────────────────────────────┐
│  tickNative() → runNativeJob()  (lib/engine/native-run.js)                          │
│    env→增量决议→runEngine→gate→apply  每一步结论不可被下一步洗白                      │
└───────────────┬────────────────────────────────────────────────────┬───────────────┘
                │ deps.runEngine = client.js realRunEngine             │ doctor / generate / update
                ▼                                                      ▼
┌─────────────────────── lib/engine/client.js ───────────────────────────────────────┐
│  spawn(plan.command, [FAKE_ENGINE])  ← 真进程！                                    │
│  write 一行 JSON + EOF(stdin)  →  read stdout JSON-lines  →  解析 hello/progress/    │
│  result；超时/取消→terminateProcessTree                                            │
└───────────────┬────────────────────────────────────────────────────┬───────────────┘
                │ 真 spawn 一个 node 进程把下面脚本当入口                           │
                ▼                                                              ▼
┌───────────── test-fixtures/fake-native-engine.mjs ──────────────────────────────────┐
│  stdin.on('end') → run(req)                                                       │
│   modeOf(repoPath) 读 FAKE_ENGINE_MODE / .native-mode-<tag> / __mode__ 段           │
│   logCall(...) → 写 .native-calls-<tag>.log（动作 + updateOptions + readState）     │
│   writeDocs(...) → 写 modules/*.md + metadata.json + module_tree.json +             │
│                   temp/dependency_graphs/*_dependency_graph.json + update_record.json│
│   依 MODE 回 hello/progress/result（done|partial|fail|crash|stall|slow|empty-docs）  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

关键设计点（均来自源码注释）：

- 假引擎是**真进程**，所以 `client.js:288-298` 的 `spawn`、`client.js:300-303` 的 stdout 行解析、`client.js:331-344` 的进程树终止全部走真实代码——这是测试真正要守护的「接线」。
- 模式文件与调用足迹都写在**仓库同级目录**（`:27-30`、`:52-57`），避免污染被测仓库触发 `uncommitted-input` 质量门。
- 模式切换三优先级（`FAKE_ENGINE_MODE` > 模式文件 > `__mode__段`）解决「同一进程连续跑多用例」的竞态（`:31-40` 注释）。

## Data Flow

以 `test-engine-native-job.mjs` 用例 1（完整成功）为例，端到端数据流如下：

1. **测试搭建**：`makeRepo('ok', { mode:'done', preInit:true })`（`test-engine-native-job.mjs:57-93`）建一个带 git 与预初始化 wiki 的临时仓库，并在仓库同级写 `.native-mode-ok` 文件（内容 `done`）。
2. **配置接线**：`nativeCfg()`（`:208-223`）把 `nativeEngine:true`、`nativeEnginePython: process.execPath`、`nativeEngineEntry: FAKE_ENGINE` 注入插件配置，使 `nativeChannelFor` 锁定原生通道、`tickNative` 走 `runNativeJob`。
3. **提交 job**：`codewiki_generate.execute`（`index.js:4076`）→ `svc.submit` → 任务进 `queued`/`articles` 阶段，立即返回。
4. **tick 推进**：`index.js:3851-3879` 锁定 `job.channel='native'` 并调 `tickNative`，最终落到 `runNativeJob`（`lib/engine/native-run.js:109`）。
5. **doctor**：`runNativeJob` 先 `runEngine({action:'doctor'})`，client.js 真 spawn 假引擎，假引擎 `run()` 在 `:216` 回 `outcome:'done'` + `engine.{version,python,deps}`；足迹记一条 `action:'doctor'`。
6. **增量决议**：`explicitFull`（scope=full/kind=full）为真 → `resolution=FULL`（`native-run.js:289-307`）。
7. **generate**：`action='generate'`，client.js spawn 假引擎，`run()` 在 `:284-314` 发三段 progress 并调 `writeDocs(docsDir, repoPath, {action:'generate'})`，写出 `overview.md` / `modules/core.md` / `modules/web.md`（partial 模式除外）/ `metadata.json` / `module_tree.json` / 依赖图 / `update_record.json`；足迹记一条 `action:'generate'` + `readState` 输入证据。
8. **质量门**：`gateImpl({docsDir})`（真实 `gateNativeOutput`）裁决——例如 `empty-docs` 模式（不写产物）→ `gateOutcome='failed'`，`native-run.js:503-515`。
9. **落地器**：`applyImpl`（真实 `applyNativeOutput`）写盘 → `cw index` → `cw meta update`（推进基线）→ `autoCommitWiki`（`index.js:4994` 之后在 `tickCommit` 调）；假引擎的 `stateFiles` 清单与实际采集结果在 `native-run.js:556-561` 交叉核对。
10. **终态合成**：`settle()`（`native-run.js:140-174`）取「engine/gate/apply」三者的**最弱**终态（`weakest` 在 `:73-74`），并把 `incremental` / `gate` / `apply` / `engineLock` 现场证据、调用足迹结论一并带出。done 不许带 blockers（`:680-683`）。
11. **测试断言**：`waitJob()` 等到终态后，测试读 `job.nativeResult` 与 `.native-calls-<tag>.log`（`:96-100`）反向验证：引擎确实被调用、质量门/落地器是真实实现、产物真的入库（`gitShowFiles` 只含 `.codewiki/`/`CodeWiki.md`）。

增量轮（`test-engine-native-incremental.mjs` 用例 1）的额外数据流：第二轮 `scope='stale'` → `runNativeJob` 决议 `resolution='update'`（`native-run.js:109`）→ `hydrateDocsDir` 把上一轮 `.codewiki/_native-state/docs/` 复制到独立 `docsDir`（`native-run.js:338-352`）→ 假引擎收到 `action='update'` + `updateOptions.rung='3'`（`native-run.js:340-342`）、`readStateInputs` 真的 stat 到四份受管状态（脚步 `__38__` 段 / `.native-calls` 足迹 `readState`），并自报 `updateOutcome='incremental'`（`fake-native-engine.mjs:65-67` 的 `recordOutcome` 变量，与 `writeDocs` 的 `recordOutcome` `:193-195` 一致）。

## Connections

## Known Issues
