---
title: fixtures
type: module
source_files:
  - test-fixtures/fake-native-engine.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - test-orchestration.mjs
  - test-change-set.mjs
  - test-engine-client.mjs
  - test-engine-apply-plan.mjs
  - test-prune-orphans.mjs
  - tools/fsoft-engine/fixtures/中文 空格 fixture/pyproject.toml
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/core/engine.py
  - tools/fsoft-engine/fixtures/.gitignore
  - tools/fsoft-engine/.gitignore
  - test-graphdiff.mjs
  - lib/graph-diff.js
  - lib/engine/client.js
  - index.js
tags: [test-fixtures, fake-engine, golden-tests, test-helpers, repo-fixture, jobs-store]
---

## Overview

本模块是 dsh-codewiki 仓库里**测试夹具（fixtures）与测试侧「造数/读档/等待」工具**的集合，服务于把插件代码（编译流水线、`lib/engine/*` 原生引擎适配层、增量/规划层）端到端验证。它本身不是产品代码，而是让被测逻辑能被确定性复现的「最小可信输入 + 一次性脚本 + 测试内 helper 工厂」。

模块里的实体分三条来源线，且都满足同一个硬约束——**夹具产物必须能对应仓库里真实存在的东西**，否则质量门/契约闸门会把每页记成 `source-missing`、终态永远 `partial`，把被测缺陷伪装成夹具配置问题：

1. **生产接线专用假引擎** `test-fixtures/fake-native-engine.mjs`（208 行）：一个**只实现协议与产物、不实现任何算法**的 node 脚本，被 `lib/engine/client.js` 当真实入口进程 spawn，用于验证「JobService → 引擎」这条跨进程接线不被悄悄破坏。它的产物用 `realSourceFiles` 真去扫仓库、只引用扫到的文件（见 `test-fixtures/fake-native-engine.mjs:62-85` 与 `:118-124`）。
2. **对拍黄金基准** `test-fixtures/gen-graphdiff-golden.py` + `test-fixtures/graphdiff-golden.json`：Python 上游原版算出 `lib/graph-diff.js` 的逐位一致期望值，Node 侧读 JSON 对拍。
3. **测试内 helper 工厂（job/repo 创建与等待）**：集中在 `test-orchestration.mjs`（`makeFixtureRepo` 造仓库、`waitJob` 轮询 `JOBS_FILE` 等终态、`makeCtx`/`makeBatchMock`/`fakeReq`/`fakeRes` 造宿主 ctx 与假 llm），并在 `test-change-set.mjs`（`makeRepo`）、`test-engine-apply-plan.mjs`（`makeRepo`/`writeFile`/`makeReport`/`makeDocs`）、`test-prune-orphans.mjs`（`makeWiki`）里各有本地造数工厂。
4. **fsoft-engine 真实路径 fixture 仓库** `tools/fsoft-engine/fixtures/中文 空格 fixture/`：一个路径含中文与空格的 Python 小仓库，供原生引擎在真路径下跑通（无 LLM 依赖图、端到端验收）。

## Key Components

### test-fixtures/fake-native-engine.mjs（生产接线假引擎）

用 node 当「解释器」、本文件当「入口脚本」，因此 `lib/engine/client.js` 走的是**完全真实**的 spawn/stdin JSON/stdout JSON-lines/进程退出路径（见文件头注释第 1-16 行）。行为由 `FAKE_ENGINE_MODE` 环境变量（或仓库外模式文件、目录名 `__mode__` 段）控制，一次只做一件事便于逐条断言（第 9-16 行）。

- `MODE` / `VERSION` / `PYVER` / `REAL_STDOUT` — 第 41-44 行：模式与版本常量；`REAL_STDOUT` 缓存真 `process.stdout`，保证协议流与日志流分离。
- `modeFileFor(repoPath)` — 第 27-30 行：返回仓库同级目录下的 `.native-mode-<basename>` 模式文件（放在仓库外，避免污染被测对象，见第 21-26 行注释）。
- `modeOf(repoPath)` — 第 31-40 行：解析模式，优先级 环境变量 > 模式文件 > 目录名 `__mode__段`，默认 `'done'`。
- `emit(obj)` — 第 46-48 行：向 `REAL_STDOUT` 写一行 JSON。
- `progress(requestId, stage, percent, message)` — 第 49-51 行：发 `type:'progress'`。
- `result(requestId, body)` — 第 52-54 行：发 `type:'result'`。
- `head(repoPath)` — 第 56-60 行：调 `git rev-parse HEAD`，失败返回空串。
- `realSourceFiles(repoPath, limit=4)` — 第 68-85 行：真去扫仓库里存在的源码文件（相对仓库根、POSIX 分隔），跳过 `.git` 与点目录；**只列真实存在的文件**供模块树与页面引用，否则质量门全判 `source-missing`（见第 64-67 行注释）。
- `writeDocs(docsDir, repoPath)` — 第 87-127 行：写出干净 docs 产物：
  - 页**不带 frontmatter**（真实 FSoft 产物是纯 markdown，frontmatter 由渲染层合成；带 frontmatter 会让 article-contract 判 duplicate-frontmatter，见第 94-97 行注释）。
  - `overview.md` / `modules/core.md` 总是写出；`MODE==='partial'` 时 `modules/web.md` 正文被掏空（落到质量门 empty-body 判据，第 102-112 行）。
  - `metadata.json` / `module_tree.json`（components 指向 `realSourceFiles` 扫到的真实文件，第 118-124 行）/ `first_module_tree.json` / `update_record.json`。
- `run(req)` — 第 129-198 行：主处理。先发 `hello`（协议版本 1）。`action==='doctor'` 区分 `deps-bad` 与正常；非 generate/update 回 `engine-protocol`。各 MODE 分支：`stall`（不返回，验证取消杀进程树）、`fail`（回 engine-crashed）、`crash`（只写日志行不写 result，协议破坏）、`empty-docs`（回 done 但不写产物，验证「done 不能替代质量门」）、默认分支写真实 docs 后回 `done`。
- 入口 — 第 200-208 行：`process.stdin` 收完一行 JSON 后调 `run`，异常兜底发 failed。

### test-fixtures/gen-graphdiff-golden.py（黄金基准生成器）

用 Python 原生 `difflib` / `hashlib` 喂与 `lib/graph-diff.js` 同一批输入产出期望值（见第 1-7 行注释）。固定随机种子 `random.Random(20261027)`（第 53 行）保证可复现。

- `normalize_body(text)` — 第 19-20 行：`(text or "").strip()` 后把 `\s+` 替换为单空格；对应 `lib/graph-diff.js` 的 `normalizeBody`。
- `documented_source(code, docstring="")` — 第 23-27 行：doc 存在且不在 code 中时返回 `f"{doc}\n{code}"`，否则返回 code。
- `body_hash(code, docstring="")` — 第 30-31 行：`hashlib.sha1(normalize_body(documented_source(...)).encode("utf-8")).hexdigest()`。
- `_tokens(text)` — 第 34-35 行：`_TOKEN.findall(text or "")`，`_TOKEN = re.compile(r"\w+|[^\w\s]")`。
- `body_similarity(a, b)` — 第 38-44 行：转 token 后空序列特判（都空 1.0，单边空 0.0），否则 `difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()`。
- `unified_body_diff(old_lines, new_lines, label, n=2)` — 第 47-49 行：`difflib.unified_diff(..., fromfile=f"a/{label}", tofile=f"b/{label}", n=n)`。
- `main()` — 第 52-144 行：依次生成四类用例（similarity 13+30 组、hash 6 组、unified 9 组、随机 unified 20 组），最终 `json.dump(cases, sys.stdout, ensure_ascii=False, indent=1)`（第 144 行）。
- 入口 — 第 147-148 行：`__main__` 调 `main()`。

### test-fixtures/graphdiff-golden.json（数据文件）

纯 JSON 数组，共 499 行，即 `(13+30)+(6)+(9)+(20) = 78` 个用例。字段集合：
- similarity：`kind`, `a`, `b`, `expected`（浮点，如 `0.6666666666666666`）。
- hash：`kind`, `code`, `docstring`, `expected`（sha1 十六进制串）。
- unified：`kind`, `oldText`, `newText`, `label`, `expected`（完整 unified diff 文本）。

该文件是 `test-graphdiff.mjs` 的**必需输入**（缺失即退出），本身不导出任何符号。它是 `gen-graphdiff-golden.py` 的离线产物，连接 Python 侧与 Node 侧对拍，属只读基准，测试侧只 `readFileSync` + `JSON.parse`。

### tools/fsoft-engine/fixtures/中文 空格 fixture/（真实路径仓库夹具）

一个路径含中文与空格的 Python 小仓库，专供原生引擎在真路径下跑通（见 `fsoft_engine_fixtures.md` Overview）。本模块实际读过的文件：

- `pyproject.toml`（8 行）：`[project]` 名 `fixture-cn-space`，`requires-python = ">=3.12"`（第 5-8 行）。
- `src/core/engine.py`（25 行）：`Engine` 类（`__init__`/`run`/`calls` 属性/`build_engine` 工厂），注释标明「阶段 1A 依赖图 fixture」（第 1、6-25 行）。
- `fixtures/.gitignore`（7 行）：忽略 `.codewiki/` / `docs/` / `docs2/`，只入库源码与配置（第 1-7 行注释：「可复现的输入，而非结果快照」）。
- `tools/fsoft-engine/.gitignore`（2 行）：忽略 `out-*/`（可复现探针生成的临时依赖图与文档，第 1-2 行）。

### test-orchestration.mjs 中的 job/repo 创建与等待 helper

这些是「job/repo 数据创建 + 读档等待」的核心工厂（其余 helper 见 [[orchestration_tests]]）：

- `articleMd(title, source, marker, type)` — 第 33-34 行：造一篇最小 frontmatter 文章的工厂（用于 mock llm 应答与 fixture 落盘）。
- `makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — 第 51-91 行：mock 宿主 ctx，返回 `{ ctx, registered, endpoints, listeners, disposers }`；`ctx.inject`（第 69-79 行，兼容 cordis 两种风格）、`ctx.on`（第 80 行）、`ctx.effect`（第 84-88 行，防错写 `ctx.effect(() => service.stop())` 当场停摆 tick）、`webServer.register` / `agents.list/.get` / `tools.register` / `workspaceRegistry.list`（第 56-67 行，可捕获；`brokenRegistry` 时 `list()` 抛错）。
- `makeMockAgent(cwd)` — 第 94-108 行：mock `agent.ctx` 用于 systemPrompt section 注册，`TOOL_REPORT: 2900` 排序（第 101 行）。
- `makeFixtureRepo()` — 第 110-127 行：**造 `core/` + `util/` 两个目录的 git 仓库 fixture**（0.10.7 起模块清单由 localPlan 按顶层目录分组生成，目录结构决定模块名）；带 git identity（第 122-123 行，0.10.9 起 autoCommit 缺 identity 拒绝）。返回仓库 `dir`。
- `makeBatchMock({ modules, articleMarker, stall, bigArticle })` — 第 145-227 行：mock 宿主 llm 服务，按 prompt 首行特征分发应答。`answerFor(prompt)`（第 147-195 行）覆盖文章观察/文章作者/stale 更新/架构观察/系统总览/模式/概念/审校；`llm.stream(opts)`（第 198-215 行）按宿主 block 协议吐块，`stall=true` 挂起直到 `opts.signal` abort（第 202-209 行）；返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`（第 219-226 行）。
- `waitJob(cwd, { timeout = 30000 })` — 第 230-243 行：**轮询 `JOBS_FILE` 等某 cwd 的最新 job 终态**。每次 `JSON.parse(fs.readFileSync(JOBS_FILE))`，取 `jobs` 中 `norm(cwd)` 匹配的最后一条，命中 `done`/`failed`/`cancelled` 即返回，超时返回当前 job，期间 `setTimeout(150)` 轮询。
- `fakeReq(body, addr, method)` / `fakeRes()` — 第 245-257 行：模拟 HTTP 请求/响应对象，供面板端点 handler 调用（`remoteAddress` 默认 `127.0.0.1`，非回环地址被端点守卫拒绝，见 [[webserver]]）。

### test-change-set.mjs — makeRepo（git 仓库夹具）

- `makeRepo()` — 第 23-42 行：`tmpdir` 下建独立临时仓库，`git init` + 设 identity + 写 `src/a.js`/`src/b.js`/`README.md`/`.codewiki/_meta.yaml` 后基线提交；返回 `{ dir, base, write }`（`write(rel, content)` 在第 29-33 行，基线 commit 在第 39 行）。
- `git(cwd, args)` — 第 20 行：`execFileSync('git', args, { cwd, ... })` 封装。
- `allPaths(cs)` / `names(list)` — 第 44-45 行：从 changeSet 取排序后的路径/名字列表，用于断言。

### test-engine-apply-plan.mjs — makeRepo / writeFile / makeReport / makeDocs

- `makeRepo()` — 第 50-54 行：`mkdtempSync` 建 `dsh-apply-plan-` 根并登记到 `tmpRoots` 供清理。
- `writeFile(root, rel, text)` / `readFile(root, rel)` / `exists(root, rel)` — 第 55-65 行：基于 `join(root, ...rel.split('/'))` 的读写/存在判定封装。
- `makeReport({ pages, canAdvanceBaseline, writable, outcome })` — 第 68-87 行：造一份「能过门」的裁决（两篇文章 + 入口），返回供 `applyNativeOutput` 消费的对象。
- `makeDocs(dir)` — 第 89 行起：在 docs 目录放入口页（内容在第 90 行 onward，被 `applyNativeOutput` 读取）。

### test-prune-orphans.mjs — makeWiki（wiki 目录夹具）

- `makeWiki()` — 第 19-30 行：造 `.codewiki` 目录——`modules/` 下 4 篇（keep/orphan-a/orphan-b/written-failed）+ `concepts/stays.md` + 根 `_architecture.md`，返回 `{ root, wiki }`。
- `ls(wiki, sub='modules')` — 第 31 行：读目录并排序，用于断言删剩的篇目。
- `check(label, fn)` — 第 14-16 行：收 `pass`/`fails` 的断言宏（与 `test-orchestration.mjs` 同名但作用域独立）。

## Architecture

本模块横跨「离线基准生成 → 在线对拍」「生产接线假引擎」「测试内造数与轮询」三块。框图如下（文件/类用 `()` 标出）：

```text
┌── 离线基准生成 ─────────────┐      generates        ┌── 基准载体 ──────────┐
│ gen-graphdiff-golden.py     │ ──python > json──────► │ graphdiff-golden.json│
│ (Python upstream oracle)    │                       │ (78 golden cases)    │
└────────────────────────────┘                       └──────────┬──────────┘
                                                               │ read + parse
                                                               ▼
┌── test-graphdiff.mjs ────────┐   import   ┌── lib/graph-diff.js ──┐
│ (Node harness, 见 graph_diff)│ ──────────► │ (ported difflib)      │
└──────────────────────────────┘            └──────────────────────┘

┌── 生产接线假引擎 ────────────┐   spawn    ┌── lib/engine/client.js ──┐
│ fake-native-engine.mjs       │ ──────────► │ (真协议/进程树路径)       │
│ (node 当入口脚本, 协议+产物)  │ ◄─stdin/stdout JSON-lines─┤
└──────────────────────────────┘             └─────────────────────────┘

┌── 测试内造数 + 轮询 (orchestration/change-set/apply-plan/prune) ──┐
│ makeFixtureRepo()/makeRepo()/makeWiki() ──造仓库/wiki fixture      │
│ makeCtx()+makeBatchMock() ──mock 宿主 ctx + 假 llm                 │
│ gen.execute(cwd) ──写入 JOBS_FILE(stage=articles)                  │
│   ▼                                                               │
│ waitJob(cwd) ◄──每150ms轮询── JOBS_FILE(jobs[].stage 终态)        │
└───────────────────────────────────────────────────────────────────┘
```

职责划分：

- `fake-native-engine.mjs` / `gen-graphdiff-golden.py`：离线可独立运行的「oracle」，前者验证跨进程接线、后者提供逐位一致的权威期望值。
- `graphdiff-golden.json`：连接两侧的可复现基准载体，测试侧只读。
- 测试内 helper（`makeFixtureRepo`/`makeRepo`/`makeWiki`/`waitJob`/`makeCtx`/`makeBatchMock`）：把插件当整体或白盒跑起来所需的最小造数与读档设施，核心是「创建 job/repo 数据 → 推进 → 轮询读 `JOBS_FILE` 等终态」。

## Data Flow

### 假引擎接线验证流（test-engine-client.mjs 驱动）

1. 测试调 `runEngine({ engine: pyEngine('<mode>'), requestId, action, timeoutMs })`（`lib/engine/client.js` 封装），后者真 spawn `node fake-native-engine.mjs`。
2. 假引擎从 `stdin` 读一行 JSON，按 `modeOf` 决定行为，向 `stdout` 写 `hello` / `progress` / `result` 行（或直接崩溃、或只写日志行）。
3. `client.js` 的协议读取器逐行解析、隔离 unknown-request、把非 JSON 行记 `not-json`；`waitJob`-等价语义由 `client.js` 的 `runEngine` 内部的 `AbortController` + 超时（`engine-timeout`）+ 进程树终止兜底完成。
4. 测试断言 `outcome`/`error.code`/`protocolViolations`（如 `not-json`、`engine-protocol`、`engine-crashed`、`engine-timeout`、`nonzero-exit`），确保协议破坏不会被静默吞掉（详见 [[engine_runtime]]）。

### 黄金对拍流（test-graphdiff.mjs 驱动，详见 [[graph_diff_tests]]）

1. 离线：`python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`。
2. 在线：`test-graphdiff.mjs` `fs.existsSync` 缺则 `process.exit(1)` → `JSON.parse` → 按 `kind` 把 `a/b`、`code/docstring`、`oldText/newText` 喂给 `lib/graph-diff.js` 函数，与 `expected` 比对。

### 端到端造数 + 轮询终态流（test-orchestration.mjs）

1. **初始化**：设 `DSH_CODEWIKI_TICK_MS=300`（第 15 行）、随机 token 的 `DSH_CODEWIKI_JOBS_FILE`（第 22-23 行，与同机宿主隔离）；`makeFixtureRepo()` 造 `core/`+`util/` 仓库（第 110-127 行）；`makeCtx` + `apply(ctx, batchCfg())` 挂载插件（第 295-296 行）。
2. **创建 job**：`gen.execute({ cwd }, { agent })` 判态后把任务写入 `JOBS_FILE`（stage=articles），立即返回 `{ submitted, jobId }`（第 647-651 行断言「提交即返回、不含 writtenCount」）。
3. **推进**：真实服务 tick 读 `JOBS_FILE`，按阶段机跑 `articles→crosscut→review→index`，每个阶段向 `makeBatchMock` 的 `activeLlm.stream()` 发请求，`answerFor` 按 prompt 首行应答。
4. **读档等待**：`waitJob(cwd)`（第 230-243 行）一直 `readFileSync(JOBS_FILE)` 轮询，取到 `done`/`failed`/`cancelled` 或超时为止（150ms 步进）。
5. **落盘核查**：job 终态后校验 `writtenCount`/`failedCount`/`notes`/磁盘文件（如 `modules/core.md`、`_architecture.md`）。

### 单元造数流（test-change-set / test-engine-apply-plan / test-prune-orphans）

- `test-change-set.mjs`：`makeRepo()` 造带基线的临时仓库（第 23-42 行），喂 `collectChangeSet(dir, base)` 四路采集断言（见 [[lib-change-set]]）。
- `test-engine-apply-plan.mjs`：`makeRepo()` + `writeFile`/`makeReport`/`makeDocs` 造「能过门」的裁决与 docs 目录，喂 `applyNativeOutput` 断言写集封闭/索引回滚/提交失败不回滚（见 [[engine_plan_apply]]）。
- `test-prune-orphans.mjs`：`makeWiki()` 造 `.codewiki` 目录（第 19-30 行），喂 `pruneOrphanModules(job)` 断言只删孤儿、保留增量/失败/concepts（见 [[index]] 的 `pruneOrphanModules`）。

## Connections

- [[orchestration_tests]] — `test-orchestration.mjs` 在本模块只取「造数 + 轮询」一段（`makeFixtureRepo`/`waitJob`/`makeCtx`/`makeBatchMock` 等），其余端到端断言在该模块详述。
- [[graph_diff_tests]] — `gen-graphdiff-golden.py` / `graphdiff-golden.json` 与 `test-graphdiff.mjs` 的黄金对拍关系在其文档展开。
- [[fsoft_engine_fixtures]] — `tools/fsoft-engine/fixtures/中文 空格 fixture/` 与探针脚本的整体由该模块覆盖；本文只取实际读过的 `pyproject.toml`/`engine.py`/两个 `.gitignore` 与造数语义。
- [[index]] — `pruneOrphanModules`/`slugify`/`makeFixtureRepo` 配套的删除与命名逻辑落点；`waitJob` 轮询的 `JOBS_FILE` 即 index.js 的 jobs 存储（见 [[jobs-service]]）。
- [[engine_runtime]] / [[engine_client]] — `fake-native-engine.mjs` 是 `lib/engine/client.js` 的接线靶子，协议破坏/进程树终止的断言在 `test-engine-client.mjs`。
- [[lib-graph-diff]] — `gen-graphdiff-golden.py` 对拍的目标函数族（bodySimilarity/bodyHash/unifiedDiff/diffGraphs）。
- [[webserver]] — `fakeReq`/`fakeRes` 驱动的 `/api/codewiki/jobs`/`control`/`repos`/`sessions` 端点回环守卫（403）与 loopback 过滤。

## Known Issues

- **`waitJob` 依赖 `JOBS_FILE` 落盘节奏**：`test-orchestration.mjs` 第 230-243 行的轮询固定 150ms 步进、默认 30s 超时；若真实服务 tick（即便压到 300ms）偶发慢于超时或 `JOBS_FILE` 未刷新，会返回非终态 job 让后续断言失败。第 22-23 行已用随机 token 隔离 `JOBS_FILE` 避免 pid 复用读到旧 fixture（见 [[orchestration_tests]] Known Issues）。
- **`fake-native-engine.mjs` 的「假 done」风险**：早期夹具硬编码 `src/core/engine.py` 等不存在路径，会让质量门对每页记 `source-missing` → 永远 `partial`，把闸门缺陷伪装成夹具问题；`realSourceFiles` 已改为真扫仓库（第 64-85 行），但还是要保证测试仓库真的含这些文件。
- **夹具产物不带 frontmatter 是约定而非校验**：`writeDocs` 故意不写 frontmatter（第 94-97 行注释），依赖渲染层 `renderArticle` 合成；若未来渲染层改规则，假引擎产物会整批落到契约闸门。
- **`graphdiff-golden.json` 必须离线预生成**：`test-graphdiff.mjs` 在文件缺失时直接 `process.exit(1)`，无「按需调 Python 生成」回退；CI 必须把它作为构建产物纳入，否则对拍无法启动。且无「基准是否过期」的自检——若 `lib/graph-diff.js` 被有意改而基准未重生成，会全量失败（详见 [[graph_diff_tests]] Known Issues）。
- **fsoft fixture 仓库路径含中文与空格**：`tools/fsoft-engine/fixtures/中文 空格 fixture/` 这种路径专门用来验证原生引擎在真中文/空格路径下跑通；一旦测试环境对中文文件名支持不全（如某些 zip 解压丢弃），整条验收链会静默跳过而非报错。
- **各测试的 `makeRepo`/`makeWiki` 互不共享**：`test-change-set.mjs`/`test-engine-apply-plan.mjs`/`test-prune-orphans.mjs` 各自有同名（作用域独立）的造数工厂，签名与返回结构不同（一个返回 `{dir,base,write}`，一个返回 `root`，一个返回 `{root,wiki}`），跨文件迁移用例时易误用，无统一 fixture 库约束。
