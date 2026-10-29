---
title: 系统总览
type: architecture
source_files:
  - index.js
  - client.js
  - package.json
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - lib/change-set.js
  - lib/cluster.js
  - lib/git-paths.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/apply-plan.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/git-paths.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - lib/engine/quality-gate.js
  - test-agentic.mjs
  - test-agentic-fallback.mjs
  - test-agentic-host.mjs
  - test-article-contract.mjs
  - test-articles-agentic.mjs
  - test-batch.mjs
  - test-change-set.mjs
  - test-cluster.mjs
  - test-cwd-paths.mjs
  - test-engine-apply-plan.mjs
  - test-engine-bridge.mjs
  - test-engine-client.mjs
  - test-engine-contract.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-manifest.mjs
  - test-engine-native-incremental.mjs
  - test-engine-native-job.mjs
  - test-engine-output.mjs
  - test-engine-process-tree.mjs
  - test-engine-python-entry.mjs
  - test-engine-quality-gate.mjs
  - test-graphdiff.mjs
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-semantic-plan.mjs
  - test-sessions.mjs
  - test-symbols.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - tools/fsoft-engine/.gitignore
  - tools/fsoft-engine/constraints.txt
  - tools/fsoft-engine/locked-requirements.txt
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/probe-apply-real-cw.mjs
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
  - tools/fsoft-engine/probe-generate.result.json
  - tools/fsoft-engine/probe-index-missing.mjs
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/probe-no-llm-graph.result.json
  - tools/fsoft-engine/fixtures/.gitignore
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/pyproject.toml"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/Dockerfile"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/scripts/run.py"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/src/core/engine.py"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/handler.py"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/task.ts"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/summary.json"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/component_index.json"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/leaf_nodes.json"
  - "tools/fsoft-engine/fixtures/中文 空格 fixture/.codewiki/sessions/0ace1c6a91af/languages.json"
  - .probe-inc.mjs
  - .probe-idxfail.mjs
  - .probe-nochange.mjs
  - .probe-nochange-commit.mjs
  - .probe-posix.mjs
  - .probe-two-round.mjs
  - .probe3.mjs
  - docs/fsoft-native-engine.md
tags: [architecture, overview, orchestration, pipeline, incremental, native-engine]
---

## Overview

dsh-codewiki 是一个「仓库 → wiki」编译插件：宿主（agent）调用 `codewiki_generate` / `codewiki_update` 工具提交编译任务，插件把仓库源码规划成模块清单，经**宿主 LLM 服务**（0.10.1 起唯一模型通道，插件零直连）写出 `.codewiki/` 下的文章与 `CodeWiki.md` 入口，再建索引（`cw index`）、推进编译基线（`.codewiki/_meta.yaml:last_compiled_commit`）并自动提交。

系统由六块组成：

1. **编排层**（`index.js`）：`apply(ctx, config)`（index.js:4965）注册工具与面板端点，常驻 `JobService`（JOBS_FILE 持久化 + tick）推进 `articles → crosscut → review → index → commit` 阶段机（0.10.7 起无独立规划阶段）。
2. **规划层**：`scanRepoFiles`（index.js:2074）→ `lib/symbols.js` AST 符号图 → `lib/cluster.js` 三段 LLM 聚类（`semanticPlan`，index.js:1412），失败降级 `localPlan`（index.js:1372，顶层目录分组）。
3. **写作通道（三选一）**：单轮批量 `runRealtimeTasks`（index.js:671，大档/默认档双池）；agentic 工具循环（`lib/agentic.js` 三层）；FSoft 原生 Python 引擎（`lib/engine/*`，子进程 JSON-lines 协议）；另有会话通道兜底（`classifySessionTask`，index.js:1985）。
4. **增量层**：`lib/change-set.js` 四路 git 变更 + `lib/graph-diff.js` 符号级 diff → `lib/update-planner.js` 产出每篇文章 `write/keep/delete/review` → `lib/update-record.js` 裁决终态与基线可推进性。
5. **质量与落盘底座**：`lib/article-contract.js` 契约闸门（error 拒写 / warning 降 partial）+ `fixAnchors`（index.js:936）锚点校正 + 写集闸门；落盘后 `cw index`、`cw meta update`、`autoCommitWiki`。
6. **浏览器半侧**（`client.js`）：面板只读 7 个回环端点（`/api/codewiki/jobs|repos|control|sessions|sessions/item|models|model-efforts`），零凭证。

本文面向零上下文的未来 agent：先用三张图（总框图 / 数据流 / 依赖方向）建立心智模型，再按 Module Roles 索引跳到对应模块文章（`[[...]]` 为 wiki 反链）。文中行号均引自各模块文章，对应当次成文时的源码版本。

## System Overview

分五层看：宿主提供 `llm.stream` / `webServer` / `agents` / `tools` 等服务；`index.js` 是唯一编排枢纽（工具注册、JobService、回环端点、落盘收尾）；规划层产出 `plan.modules`；三条写作通道把任务变成文章全文（原生引擎通道走子进程旁路）；所有通道共享契约闸门、增量判定与落盘提交底座；浏览器半侧只消费回环端点。

```text
┌───────────────────────────────────── 宿主（cordis ctx） ─────────────────────────────────────┐
│  agents · tools · llm.stream · webServer · workspaceRegistry · 配置: codewiki                │
└────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                         │ apply(ctx, config)
                                         ▼
┌─────────────────────────── index.js（插件主入口，宿主半侧） ─────────────────────────────────┐
│  工具: cw · codewiki_generate · codewiki_update · codewiki_progress                          │
│  JobService: submit ─► tick 阶段机 articles►crosscut►review►index►commit                     │
│  installWebServer: /jobs /repos /control /sessions /models /model-efforts（仅回环）          │
│  收尾: contractCheck · fixAnchors · pruneOrphanModules · autoCommitWiki · wakeCompileSession │
└───────┬────────────────────┬───────────────────────┬─────────────────────────────────────────┘
        │ 规划                │ 写作通道               │ 原生引擎通道
        ▼                    ▼                       ▼
┌──────────────────────┐ ┌────────────────────────────┐ ┌──────────────────────────┐
│ 规划层                │ │ 宿主 LLM 写作通道           │ │ lib/engine/*（Node 适配） │
│ scanRepoFiles        │ │ 单轮: runRealtimeTasks     │ │ runNativeJob 裁决链       │
│ symbols.js           │ │ agentic: 工具循环          │ │ env►增量►引擎►门►落地     │
│ cluster.js           │ │ 会话通道兜底               │ │ └► python entry.py(FSoft)│
│ semanticPlan/local   │ │                            │ │ llm-bridge 回环模型       │
└──────────────────────┘ └────────────────────────────┘ └──────────────────────────┘
           ▼ plan.modules          ▼ 文章全文                 ▼ report/engineResult
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  契约闸门: inspectArticle · fixAnchors · makeWriteSet/isWritable                               │
│  增量底座: change-set 四路采集 · graph-diff 组件diff · update-record 终态裁决                   │
│  落盘提交: cw index · cw meta update · autoCommitWiki · ensureWikiEntry                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                            │ GET/POST /api/codewiki/*（仅回环）
                            ▼
┌──────────────────────────── client.js（浏览器半侧，零凭证） ────────────────────────────────┐
│   CodewikiPanel 任务面板 · CodewikiCard 设置 · ReposTab · SessionView                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

读图要点：

- **提交制**：`gen.execute` 立即返回 `{ submitted, jobId, stage }`，不就地等待；job 落盘 JOBS_FILE，宿主重启后按持久化 prompt 快照重跑（`settleJob`，index.js:2399）。
- **通道选择**：`nativeEngine` 开且 scope 支持时走原生通道（`nativeChannelFor`，index.js:228）；`agenticArticles` 开走 agentic 通道；否则单轮批量。agentic 失败过半退回单轮（`shouldFallBackFromAgentic`，index.js:1390）。
- **原生引擎是子进程**：`lib/engine/client.js` spawn Python 入口（`lib/engine/python/entry.py`），模型经 `llm-bridge` 回环 HTTP 注入，凭证只活在进程环境。
- **client.js 不持任何凭证**，全部数据来自回环端点。

## Data Flow

一次全量编译的请求生命周期（编号对应图中 ①-⑥）：

1. **提交**：`codewiki_generate.execute({cwd, scope})` → `JobService.submit`（index.js:3722）写 JOBS_FILE 并触发 tick；项目默认串行（后到 `queued`）。
2. **plan**：`scanRepoFiles` → `extractRepoGraph`（lib/symbols.js:785）+ `resolveImportEdges`（:810）→ `clusterComponents`（lib/cluster.js:291，三段：顶层聚类 ► 下钻 ► 超级分组；无模型/失败降级 `heuristicCluster` 或 `localPlan`）。`plan.graph` 刻意不含 `sourceCode`，防 JOBS_FILE 膨胀。
3. **articles**：`prepareArticleTasks`（index.js:1245）按 `collectSources` 装填源码（预算 110k；超大模块打 `bigTier` 或拆观察批或转会话通道）→ `runRealtimeTasks`（index.js:671）双池并发，每任务一次 `llm.stream` → `applyTaskResult`（index.js:633）落盘前过 `contractCheck`（index.js:590，error 级拒写）与 `fixAnchors`。agentic 通道在此阶段由 `runAgenticArticles`（lib/articles-agentic.js:231）接管。
4. **crosscut**：`packArticles`（index.js:1399）把已写文章装填为上下文，产出 `_architecture.md` / `_patterns.md` / concepts；超预算拆 `#obsN` 观察批再合成。
5. **review**：审校员批量校对，按 `@@@article:` 标记逐篇回填。
6. **index/commit**：`pruneOrphanModules`（index.js:351，仅 full 且只删 `modules/*.md` 孤儿）、`ensureWikiEntry`（index.js:381）、`judgeOutcome` 定终态，`autoCommitWiki`（index.js:4801）通过安全边界守卫后提交，`wakeCompileSession` 按需 steer 唤醒。

```text
 codewiki_generate / codewiki_update（agent 工具调用）
        │  提交制：立即返回 { submitted, jobId, stage:'articles' }，不就地等待
        ▼
┌────────────── JobService（JOBS_FILE 持久化 · tick 驱动 · 项目串行闸门）──────────────┐
│                                                                                      │
│  ①plan      scanRepoFiles ──► extractRepoGraph(symbols.js) ──► resolveImportEdges    │
│                     │                       graph: Map<id,node>                      │
│                     ▼                                                               │
│             semanticPlan(cluster.js 三段聚类) ──失败/降级──► localPlan(顶层目录)     │
│                     │ plan.modules + plan.graph(无 sourceCode)                       │
│  ②articles  prepareArticleTasks ──► runRealtimeTasks(大档/默认档双池)                │
│                     │       每任务一次 llm.stream ◄── 宿主 LLM 服务（零直连）         │
│                     ▼                                                               │
│             applyTaskResult ──► contractCheck ──► fixAnchors ──► 写盘 .codewiki/    │
│  ③crosscut  packArticles ──► _architecture / _patterns / concepts(观察批►合成)      │
│  ④review    审校员批量校对（@@@article: 逐篇回填）                                   │
│  ⑤index     pruneOrphanModules · ensureWikiEntry · judgeOutcome(canAdvanceBaseline) │
│  ⑥commit    autoCommitWiki(安全边界守卫) ──► wakeCompileSession / commitHintText    │
└──────────────────────────────────────────────────────────────────────────────────────┘
        │
        ├── scope=stale：collectChangeSet(四路 git 变更) ──► planUpdate(write/keep/delete/review)
        │            └─ symbolIncremental：快照图 vs 新图 ──► diffGraphs(纯注释降级)
        ├── nativeEngine=true：tickNative ──► runNativeJob
        │        env(doctor+lock) ──► 增量决议 ──► runEngine(JSON-lines 子进程)
        │        ──► gateNativeOutput(质量门) ──► applyNativeOutput(写►index►基线►提交)
        ▼
   /api/codewiki/jobs ◄── client.js 面板 2s 轮询；cancel ──► /control ──► 终止进程树
```

增量与原生分支的关键语义：

- **增量**：`collectChangeSet`（lib/change-set.js:108）收 committed/staged/unstaged/untracked 四路；`planUpdate`（lib/update-planner.js:156）按「签名/实现/依赖边/改名」分类（`diffGraphs`，lib/graph-diff.js:447），纯注释变更降级不重写；无归属的源码变更强制 `needsFull`，**变更从不静默丢弃**。终态只有 `done` 才允许 `canAdvanceBaseline`，partial/failed 冻结基线让下轮重见未消费变更（`lib/update-record.js:173` judgeOutcome）。
- **原生通道**：`runNativeJob`（lib/engine/native-run.js:114）裁决链每一步结论不可被下一步洗白——引擎 `done` 不能替代质量门（`gateNativeOutput`，lib/engine/quality-gate.js:397）；跨轮受管状态存 `.codewiki/_native-state/`（`state.json` + docs 副本），未提交改动经 `mergeUnconsumed` 跨轮携带；终态取引擎/质量门/落地器三者的**最弱**。
- **取消是终态**：abort 后杀整棵进程树（POSIX `kill(-pid)` / Windows `taskkill /T /F`），迟到 result 记 `late-result` 丢弃。

## Dependency Graph

约定：`A ──► B` 表示 A 依赖（import / 注入调用）B。全图单向无环：`index.js` 是唯一编排层，`lib/` 不反向 import 它；`lib/engine/` 内部用依赖注入（native-run 注入 doctor/runEngine/gate/apply/bridge），便于测试换桩；唯一的跨进程边界是 Node ↔ Python 子进程协议，不是 import。

```text
┌──────────────────────── Dependency Graph（A ──► B = A import B）────────────────────────┐
│                                                                                          │
│  index.js ──► lib/cluster.js           （llmCall 由宿主注入，库零内部依赖）               │
│  index.js ──► lib/symbols.js           （vendor/tree-sitter WASM 为可选依赖）             │
│  index.js ──► lib/articles-agentic.js ──► lib/agentic.js（工具循环）                     │
│      │                                ──► lib/agentic-host.js（宿主 llm/FS 适配）        │
│      │                                ──► lib/article-contract.js（写集闸门）            │
│  index.js ──► lib/change-set.js ──► lib/git-paths.js（quotepath 字节级解码）             │
│  index.js ──► lib/incremental.js ──► lib/graph-diff.js（diffGraphs/codeHash/bodyHash）   │
│  index.js ──► lib/update-planner.js ──► lib/graph-diff.js + lib/symbols.js               │
│      │                               ──► lib/incremental.js（normRel/快照口径）          │
│  index.js ──► lib/update-record.js     （judgeOutcome / buildUpdateRecord）              │
│  index.js ──► lib/engine/native-run.js ──► engine/contract · client · process-tree      │
│      │                                  ──► engine/manifest · native-state               │
│      │                                  ──► engine/quality-gate ──► output · mapping     │
│      │                                  ──► engine/apply-plan ──► mapping · git-paths    │
│      │                                  ──► engine/llm-bridge ──► openai-bridge(纯转换)  │
│  engine/client.js ──(子进程 JSON-lines 协议)──► python/entry.py ──► python/stage_map.py  │
│                                                                                          │
│  复用底座（被多方 import）: article-contract · graph-diff · git-paths · engine/contract   │
│  唯一跨进程边界: engine/client.js ◄──协议──► python/entry.py（子进程，非 import）         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

结构不变量：

- **底座被复用而非重写**：`article-contract.js` 同时服务单轮（`contractCheck`）、agentic（写集 `isWritable`）、原生（quality-gate 经 `inspectArticle` 判目标格式）三个写盘点；`graph-diff.js` 同时被 `incremental.js` 与 `update-planner.js` 消费，两处的「纯注释降级」必须同源（`codeHash`）。
- **契约是唯一出口形状**：引擎终态一律经 `engineResult`（lib/engine/contract.js:116）归一，硬不变量——`done` 不带 blockers、`partial` 必带 blockers、`failed` 必有 error；落地问题经 `toContractBlockers`/`toApplyBlockers` 落进同一份 `BLOCKER_KINDS`。
- **测试侧依赖与生产同向**：`test-*.mjs` 只 import 生产模块（或经 `apply` 注入 mock ctx），生产代码不依赖任何测试文件；`test-fixtures/fake-native-engine.mjs` 是「真进程、假算法」的协议替身，模式文件必须放仓库外以免污染变更集。

## Module Roles

**运行时主体（无独立模块文章，由测试文章交叉钉死）**

- **index.js（宿主半侧编排）** — `apply`（index.js:4965）注册工具（`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`）与 7 个回环端点；JobService tick 推进阶段机；单轮写作（`runRealtimeTasks`:681、`prepareArticleTasks`:1255）、规划入口（`buildPlan`:3043）、落盘收尾（`autoCommitWiki`:5030、`pruneOrphanModules`:361、`ensureWikiEntry`:391）、原生通道接线（`tickNative`:2851）与会话记录（`SESSIONS_DIR`:1994）都在这里。
- **client.js（浏览器半侧）** — `CodewikiCard`（client.js:570，设置页/模型目录/思考档位）、`CodewikiPanel`（:1455，2s 轮询 jobs/cancel）、`ReposTab`（:1213）、`SessionView`（:1363）；只读回环端点，不持凭证。

**规划**

- [[clustering]] — `lib/cluster.js` 三段 LLM 聚类（`clusterComponents`:291）+ 启发式兜底（`heuristicCluster`:219）+ `fillMissing` 保证组件不丢；容器父节点不单独成文；产出经 `toPlanModules`:460 变成 articles 阶段任务。
- [[symbol_extraction]] — `lib/symbols.js` 表驱动 16 语言 AST 提取（`extractRepoGraph`:785）+ import 依赖边（`resolveImportEdges`:810）+ 正则兜底（`regexExtract`:374，绝不让整块语言静默消失）；组件 id 约定 `<相对路径>#<符号名>`。

**写作通道**

- [[agentic_writing]] — 三层：`lib/agentic.js` 工具循环（`runAgenticArticle`:331，4 工具 + 坏 JSON 三级抢救）；`lib/agentic-host.js` 宿主适配（`makeHostStream`:83、`makeFsWorkspace`:111）；`lib/articles-agentic.js` 编排（`runOneArticle`:33、双池 `runAgenticArticles`:231、子模块递归 `subDepth` 封顶）。
- 单轮/会话通道（在 index.js，见 [[test_batch]]）：双池并发 + 大档接管 + 会话通道 `timeout/harvest/wait` 三态兜底。

**增量**

- [[change_set]] — `lib/change-set.js` 四路 git 变更收成规范化 ChangeSet（`collectChangeSet`:108，采不全显式 `fallback:'full'`）；`lib/git-paths.js` 字节级解码 quotepath 转义（`decodeGitPath`:37）。
- [[graph_diff]] — `lib/graph-diff.js` 组件级 diff（`diffGraphs`:447），difflib 逐位移植 + Python golden 对拍；`codeHash`/`bodyHash` 支撑纯注释降级与改名配对（`pairRenames`:371）。
- [[incremental_update]] — 四文件管线：快照存取（`lib/incremental.js`，`.codewiki/temp/symbol-graph.json`）→ `planUpdate`（lib/update-planner.js:156，write/keep/delete/review + 反向依赖传播 + `unmappedChanges` 强制 needsFull）→ `judgeOutcome`/`buildUpdateRecord`（lib/update-record.js:131/:131，终态与 `.codewiki/temp/update-record.json`）。

**质量契约**

- [[article_contract]] — `lib/article-contract.js` 结构契约闸门：`inspectArticle`:213（SEVERITY 分 error 拒写 / warning 放行降 partial）+ 写集闸门（`makeWriteSet`:352 / `isWritable`:365）；是所有写盘点的统一判据基座。

**原生引擎（FSoft Python，子进程通道）**

- [[engine_core]] — 边界层总装：`contract.js`（八段枚举/终态不变量）、`client.js`（JSON-lines 协议 `runEngine`:223）、`process-tree.js`（整树终止:61）、`manifest.js`（doctor + `.codewiki/engine-lock.json`）、`native-run.js`（`runNativeJob`:111 直线裁决链）。
- [[engine_state]] — `lib/engine/native-state.js` 跨轮受管状态（`.codewiki/_native-state/`）：`isUpdateEligible`:187 判增量资格、`hydrateDocsDir`/`captureDocsDir` 复制式水合/采集、`mergeUnconsumed`:455 未消费变更跨轮携带、状态文件与文章同 pre-image 同回滚。
- [[engine_output_quality]] — `output.js` 只读收集校验（11 类 problem）+ `quality-gate.js` 采用门（`gateNativeOutput`:390，defect/degradation/stale 三分类，三类皆空才 done）。
- [[engine_apply]] — `lib/engine/apply-plan.js` 落地器（`applyNativeOutput`:602）：写集封闭 ► pre-image ► 写盘 ► `cw index` ► 基线 ► 提交；索引/基线失败即回滚、提交失败不回滚；孤儿页探测（`findOrphanPages`:413）。
- [[engine_python]] — `lib/engine/python/entry.py` 协议薄入口（stdout 守卫 + UTF-8 三流 + 不读凭证库）与 `stage_map.py` 五段►八段映射（与 `contract.js` 双向对账，进度封顶 90%）。

**测试（零框架，`node test-*.mjs`，failures 计数定退出码）**

- [[test_batch]] — 批量流水线纯函数自检 + 假流式 llm（`makeLlm`:174），钉装填/装配/分池/会话收割/锚点/信封/模型目录。
- [[test_orchestration_api]] / [[test_orchestration_setup]] — 服务化编排冒烟：提交制、阶段机、面板端点 JSON、取消/串行/并行/重启重跑/steer 唤醒/自动提交；setup 文章是其 `makeCtx`/`makeBatchMock`/`waitJob`/`fakeReq` 脚手架说明。
- [[test_wiki]] — 四份产物测试：锚点三基准对抗校验、入口生成、linked worktree 判据、会话记录 TTL。
- [[test_clustering]] — `test-cluster.mjs`（三段聚类/降级/maxDepth/超级分组）+ `test-semantic-plan.mjs`（临时仓库端到端 semanticPlan→plan.modules）。
- [[test_graph_symbols]] — graphdiff golden 对拍、symbols AST+正则兜底、cwd 路径归一化（`test-cwd-paths.mjs`）。
- [[test_incremental_update]] — 快照/`filterStaleTasks`/`planUpdate`/`judgeOutcome` 四份单测 + e2e，钉死「1 成 19 败不再判 done」。
- [[test_engine_protocol]] / [[test_engine_output]] / [[test_engine_apply]] / [[test_engine_native_job]] / [[test_engine_native_inc]] — 引擎侧测试网：契约与客户端、产物与质量门、落地器与孤儿清理、16 用例生产接线、九用例原生增量生产链（真子进程 + `.native-calls` 足迹证据）。

**夹具与探针**

- [[fsoft_fixtures]] — `tools/fsoft-engine/` 下中文空格 fixture（跨 Python/TS 的可复现输入）与验收探针（R1–R5 无 LLM 依赖图、假模型 429 协议桥、真 cw 落地）+ 冻结依赖环境 `setup-env.sh`。
- [[probes_root]] — 仓库根 `.probe-*.mjs` 临时集成探针（跑完即删的排查残留）+ `test-fixtures/fake-native-engine.mjs`（真进程假引擎，模式文件与调用足迹放仓库外）。
