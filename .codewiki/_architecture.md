---
title: architecture
type: architecture
source_files:
  - index.js
  - lib/symbols.js
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/change-set.js
  - lib/article-contract.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/native-run.js
  - lib/engine/python/entry.py
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/probe-no-llm-graph.py
  - docs/fsoft-native-engine.md
tags: [architecture, overview, pipeline, incremental, native-engine, codewiki]
---

## Overview

dsh-codewiki 是 DSH 宿主中的一个插件：把一个 git 代码仓库「编译」成一套 wiki——`.codewiki/modules/*.md` 模块文章、`_index.md` 索引、`_meta.yaml` 元数据（含 `last_compiled_commit` 编译基线）、`.codewiki/temp/` 下的符号快照与更新记录，外加仓库根的 `CodeWiki.md` 入口——并在源码演进后做**符号级增量更新**。文章类型按目录约定：`modules/`（模块）、`concepts/`（概念）、`learnings/`（经验），以及根级 `_architecture.md` / `_index.md` / `_patterns.md`（类型表见 `lib/article-contract.js` 的 `TYPE_BY_DIR` / `ROOT_TYPES`）。

给零上下文读者的术语表：

- **cw**：捆绑的 Rust CLI（`vendor/codewiki`），提供 `cw init / status / index / meta update` 等命令，由 `resolveBinary`（`index.js:163`）解析为 PATH 命中或 `bin/cw(.exe)`。
- **FSoft**：上游 FSoft-AI4Code/CodeWiki（Python 引擎），本仓库把它迁移成「原生通道」，Node 侧只保留薄适配层（`lib/engine/`）。
- **agentic**：文章写作的第二种形态——模型在工具调用循环里反复读源码、增量编辑文章（`lib/agentic.js`），与「单轮整包装填」通道（`runRealtimeTasks`，`index.js:662`）并列。
- **stale**：源码变更后按组件级 diff 判定「哪些文章真的需要重写」的增量编译（`runStaleUpdate`，`index.js:4132`）。

系统由**两条编译通道 + 一个共享增量层**组成：

1. **旧 Node 通道**：`index.js` 编排 `semanticPlan`（`index.js:1393`）——AST 符号提取 → 依赖边解析 → LLM 聚类 → 模块任务清单；文章由 agentic 工具循环或单轮通道生成，落盘前后过文章契约闸门。
2. **原生 FSoft 引擎通道**（仅全量编译）：`runNativeJob`（`lib/engine/native-run.js:68`）起模型桥、spawn Python 引擎、经质量门裁决后由落地器原子落库。
3. **共享增量层**：四路 git 变更采集（`lib/change-set.js`）+ 符号图 diff（`lib/graph-diff.js`）+ 增量规划（`lib/update-planner.js`）+ 终态判定（`lib/update-record.js`），两条通道共用作基线推进的闸门。

阶段推进顺序由跨语言契约固定（`ENGINE_STAGES`，`lib/engine/contract.js:24-33`）：`env → graph → cluster → articles → validate → index → baseline → commit`。旧 Node 通道的阶段机与之对应：articles → crosscut（`packArticles`，`index.js:1480`，跨模块概念打包）→ review → index → commit（0.10.7 已删独立 plan 阶段，模块规划由 `buildPlan`（`index.js:2986`）在 articles 阶段开头就地完成）。

四条横切不变量贯穿全部模块（未来 agent 改动任何一处都必须维持）：

1. **变化不能丢**：变更采集采不全就 `fallback='full'` 退全量（`lib/change-set.js:99-101`）；无文章认领的源码变更升级为 `unmappedSourceChanges` + `needsFull`（`lib/update-planner.js:391-392`），绝不静默刷新基线。
2. **终态必须诚实**：`engineResult` 的硬不变量——`done` 不许带 blockers、`partial` 必须带、`failed` 必须带 error（`lib/engine/contract.js:97-147`）；终态合成取最弱一环 `weakest`（`lib/engine/native-run.js:42`），`done` 带 blockers 自动降 `partial`。
3. **坏文章不入库**：`inspectArticle`（`lib/article-contract.js:213`）拦结构缺陷，`checkWriteTargets`（`lib/engine/apply-plan.js:86`）拦写集越界，质量门把缺陷机读分类（defect / degradation / stale）。
4. **基线只代表「所有变化已消化」**：`canAdvanceBaseline` 只有终态 `done` 且基线已入库才为真（`lib/judgeOutcome`，`lib/update-record.js:37`；`assessBaseline`，`lib/engine/quality-gate.js:188`），partial/failed 一律不推进。

本文结构：[System Overview](#system-overview) 给总框图与各块职责；[Data Flow](#data-flow) 给一次编译请求的端到端数据流；[Dependency Graph](#dependency-graph) 给模块间依赖方向与契约点；[Module Roles](#module-roles) 逐模块列职责与连接。行号均引自各模块文章（`文件:行号`）。

## System Overview

```text
┌────────────────────────────────── dsh-codewiki 系统总览 ─────────────────────────────────┐
│                                                                                         │
│  宿主 DSH ──► index.js（JobService · Config · Web 面板 · codewiki_generate/update 工具）  │
│                     │                                                                   │
│                     ▼  nativeChannelFor(kind)：原生通道只接 full；stale 走 Node 增量     │
│        ┌────────────────────┴─────────────────────┐                                     │
│        ▼                                          ▼                                     │
│ ┌──────────────────────────────┐   ┌─────────────────────────────────────────────┐     │
│ │ 旧 Node 通道                  │   │ 原生 FSoft 引擎通道（仅 full）                │     │
│ │ semanticPlan (index.js:1393) │   │ runNativeJob (native-run.js:68)             │     │
│ │  ├ scanRepoFiles   (:2192)   │   │  ├ doctor   (manifest.js:141) 环境指纹与锁  │     │
│ │  ├ extractRepoGraph          │   │  ├ startLlmBridge (llm-bridge.js:90)        │     │
│ │  │  (lib/symbols.js:785)     │   │  │  127.0.0.1 loopback 桥，凭证不出宿主      │     │
│ │  ├ resolveImportEdges (:1429)│   │  ├ runEngine (client.js:223)                │     │
│ │  ├ clusterComponents         │   │  │  └─ spawn lib/engine/python/entry.py     │     │
│ │  │  (lib/cluster.js:291)     │   │  ├ gateNativeOutput (quality-gate.js:390)   │     │
│ │  └ job.plan.modules          │   │  └ applyNativeOutput (apply-plan.js:414)    │     │
│ │ tickArticles (index.js:3135) │   │     写盘 ► cw index ► 基线 ► git 提交        │     │
│ │  ├ agentic 工具循环写作       │   │  终态 = weakest(engine, gate, apply) (:41)  │     │
│ │  └ 失败过半退回单轮通道       │   └────────────────────────┬────────────────────┘     │
│ └───────────────┬──────────────┘                            │                          │
│                 ▼                                           ▼                          │
│ ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│ │ 共享增量层（两通道共用的变更判定与记账）                                              │  │
│ │  collectChangeSet (change-set.js:102)：committed/staged/unstaged/untracked 四路    │  │
│ │  旧图 = 快照回读 (incremental.js:94)；新图 = 当前符号图 (lib/symbols.js)             │  │
│ │  diffGraphs (graph-diff.js:447) ► planUpdate (update-planner.js:156)               │  │
│ │  judgeOutcome (update-record.js:37) ► canAdvanceBaseline（基线推进闸门）             │  │
│ └──────────────────────────────────────────┬────────────────────────────────────────┘  │
│                                            ▼                                           │
│   .codewiki/（modules/*.md · _index.md · _meta.yaml · temp/符号快照与更新记录）          │
│   + CodeWiki.md 入口；autoCommitWiki (index.js:4952) 分支合并式提交入库                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

各块职责与相互连接：

- **index.js（编排层）**：唯一 import 全部模块的层。JobService 阶段机（`submit`/`tick`）、双通道选择（`nativeChannelFor`，`index.js:223`）、Web 面板端点（`/api/codewiki/jobs`、`/api/codewiki/repos`）、模型目录端点、git 与仓库辅助（见 [Module Roles](#module-roles)）。
- **旧 Node 通道**：语义规划产出 `job.plan.modules`（组件 → 模块任务），`tickArticles`（`index.js:3135`）按 `agenticArticles` 开关分发到 agentic 通道（`startAgenticRun`，`index.js:2932`）或单轮通道（`runRealtimeTasks`，`index.js:662`）；agentic 批次失败过半时退回单轮重跑（`shouldFallBackFromAgentic`，`index.js:1364`，只退一次）。
- **原生通道**：环境不闭合/锁漂移直接 `failed` 不跑引擎；引擎 `done` 不能替代质量门；落地器带回滚点；终态由 `weakest(engine, gate, apply)` 合成。落地器刻意不 `import index.js`，全部外部副作用（跑 cw、git 提交）走 `deps` 注入。
- **共享增量层**：`collectChangeSet` 是增量入口（采不全 → 全量）；符号图 diff 决定「哪些组件真的变了」；`planUpdate` 产出每篇文章的 `write/keep/review` 动作；`judgeOutcome` 决定终态与基线能否前移。
- **产物**：`.codewiki/` 与 `CodeWiki.md` 是唯一的写集白名单（`APPLY_WRITE_ROOTS`，`lib/engine/apply-plan.js:46`；`WIKI_PATHS`，`index.js:58`），提交只动这两个路径。

## Data Flow

```text
  请求来源：面板 / codewiki_generate 工具 / autoScan（60s 心跳调度）
        │
        ▼
  ┌─ 编译前闸门（index.js）────────────────────────────────────────────┐
  │ detectLinkedWorktree(:435) / hasCompilableSources(:478)            │
  │   linked worktree 或空壳目录 ► 拒绝（auto 调度则静默跳过）            │
  └────────────────────────────┬──────────────────────────────────────┘
                               ▼
  ┌─ 变更采集（stale/auto 更新入口 runStaleUpdate index.js:4132）────────┐
  │ collectChangeSet (change-set.js:102)：committed/staged/unstaged/    │
  │ untracked 四路 ► ChangeSet；任一路采不全 ► ok=false + fallback='full'│
  │       └──────────► 退回全量编译（变化不能丢）                         │
  └──────────────┬─────────────────────────────────────────────────────┘
                 │ changeSet.ok
                 ▼
  ┌─ 符号图构建 ────────────────────────────────────────────────────────┐
  │ extractCurrentGraph (index.js:2220) ► newGraph                      │
  │   = extractRepoGraph (symbols.js:785) + resolveImportEdges (:810)   │
  │ loadSnapshot (incremental.js:94) ► oldGraph（temp/符号快照，无源码）  │
  └──────────────┬─────────────────────────────────────────────────────┘
                 ▼
  ┌─ 全量：语义规划 ──────────┐   ┌─ 增量：符号级规划 ────────────────────┐
  │ clusterComponents        │   │ diffGraphs (graph-diff.js:447)       │
  │ (cluster.js:291)         │   │ realChangedIds (update-planner.js:57)│
  │ ► job.plan.modules       │   │ planUpdate (update-planner.js:156)   │
  └────────────┬─────────────┘   │ ► write/keep/review + unmappedSource │
               │                 │       Changes ► needsFull ◄ 退全量    │
               ▼                 └────────────┬─────────────────────────┘
               └──────────────┬────────────────┘
                              ▼
  ┌─ 文章生成（按通道）─────────────────────────────────────────────────┐
  │ 旧通道：runAgenticArticles (articles-agentic.js:231) ► runOneArticle│
  │   ► runAgenticArticle (agentic.js:331) 工具循环（read_code/         │
  │   list_files/edit_article），streamFn = makeHostStream (:83)        │
  │ 原生通道：runEngine (client.js:223) ► entry.py 产 docs/ 树          │
  └──────────────┬─────────────────────────────────────────────────────┘
                 ▼
  ┌─ 质量闸门 ──────────────────────────────────────────────────────────┐
  │ 旧通道：inspectArticle (article-contract.js:213) + fixAnchors       │
  │         （error 拒写 / warning 放行降 partial）                      │
  │ 原生通道：gateNativeOutput (quality-gate.js:390) defect/degradation/│
  │           stale 三类分流 ► applyNativeOutput (apply-plan.js:414)    │
  │           写集封闭 ► cw index ► 基线 ► 提交（索引/基线失败即回滚）     │
  └──────────────┬─────────────────────────────────────────────────────┘
                 ▼
  ┌─ 终态与基线（tickIndex index.js:3602）──────────────────────────────┐
  │ judgeOutcome (update-record.js:37) ► blockers / 终态                │
  │   done ◄─ 无 blockers；partial/failed ◄─ canAdvanceBaseline=false   │
  │ buildUpdateRecord+saveUpdateRecord (:131/:217) ► temp/update-record │
  │ slimGraph+saveSnapshot (incremental.js:37/:106) ► temp/符号快照      │
  │ autoCommitWiki (index.js:4952) ► 只提交 .codewiki/ 与 CodeWiki.md   │
  └─────────────────────────────────────────────────────────────────────┘
```

### 全量编译（旧 Node 通道）

1. **规划**：`buildPlan`（`index.js:2986`）按 `planMode` 选择 `semanticPlan`（`index.js:1393`）或 `localPlan`（`index.js:1371`，纯目录分组兜底）。`semanticPlan` 读正文 → `extractRepoGraph`（`lib/symbols.js:785`）→ `resolveImportEdges`（`index.js:1429` 补边）→ `clusterComponents`（`lib/cluster.js:291`）→ `toPlanModules`（`lib/cluster.js:460`）得 `job.plan.modules`；`plan.graph`/`plan.tree`（不含 `sourceCode`）随 job 持久化供增量。
2. **写作**：`tickArticles`（`index.js:3135`）组装任务并 `markBigAgenticTasks`（`index.js:3277`）打大档标记；agentic 通道 `runOneArticle`（`lib/articles-agentic.js:33`）落盘前过写集闸门（`isWritable`）与 `fixAnchors`；单轮通道经 `applyTaskResult`/`writeValidated`（`index.js:2601`/`:2601`）闸门。
3. **横切与收尾**：crosscut 阶段 `packArticles`（`index.js:1480`）打包已有文章产概念/模式页；review 阶段 `localReview` 记账结构问题；`tickIndex` 跑 `cw index` 并写符号快照；`tickCommit` 调 `autoCommitWiki`。

### 全量编译（原生通道）

1. `startNativeRun`（`index.js:2727`）→ `runNativeJob`（`lib/engine/native-run.js:68`）：环境探测与锁（`doctor`/`compareLock`，漂移即 `failed`，`:133-218`）。
2. `startLlmBridge`（`lib/engine/llm-bridge.js:90`）建 loopback 桥；`nativeEnginePlan`（`index.js:252`）把 `bridge.url`/占位 key/模型名写进子进程环境变量，`entry.py` 的 `_model_config`（`lib/engine/python/entry.py:243`）读取（注意：桥返回对象不含 `model`，必须显式传）。
3. `runEngine`（`lib/engine/client.js:223`）spawn 引擎，JSON-lines 协议收 result/progress；协议破坏（无 result/未知 requestId/迟到结果）判 `engine-crashed`/`engine-protocol`。
4. 质量门 `gateNativeOutput`（`:340` 调用）→ 落地器 `applyNativeOutput`（`:366` 调用，固定 `advanceBaseline:null`）→ `weakest` 合成终态（`:399-418`）→ 首跑成功后落锁 `writeLock`（`:423-438`）。

### 增量更新（stale）

1. `runStaleUpdate`（`index.js:4132`）读编译基线 `last_compiled_commit` → `collectChangeSet`（`index.js:4143`）；`ok=false` 直接 `needFull`。
2. `planUpdate`（`index.js:4173` 调用）：符号级判定用 `diffGraphs`（`lib/graph-diff.js:447`）+ `dependentsOf`（`lib/update-planner.js:85`，反向依赖闭包）+ `scanStaleArticle`（死链/已删符号引用）；`moduleMap` 缺失时 `migrateModuleMap`（`lib/update-planner.js:472`）保守迁移。
3. `plan.actions` 里 `write` 映射为 `prebuiltTasks` 提交（`index.js:4181-4191`）；`needsFull` 或 `unmappedSourceChanges` 非空则整轮退全量（`index.js:4177-4179`）。
4. 收尾：`tickIndex` 调 `judgeOutcome`（`index.js:3619`），`saveRecord`（`index.js:2574`）落 `update-record.json`；`canAdvanceBaseline === true` 才 `cw meta update` 前移基线（`index.js:3602-3618`）。

## Dependency Graph

```text
（A ─► B = A 依赖 B：A import/调用 B；◈ = 仅消费数据契约，无 import。箭头向下指被依赖方）

┌─────────────────────────────────────────────────────────────────────────────┐
│ 层 4 总编排   index.js ─► 下面全部模块（semanticPlan · runStaleUpdate ·       │
│               tickArticles · startNativeRun · tickIndex · autoCommitWiki）   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 层 3 通道编排                                                                 │
│  lib/engine/native-run.js ─► manifest.js / llm-bridge.js / client.js /       │
│                              quality-gate.js / apply-plan.js / contract.js   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 层 2 执行器 / 规划器 / 门与落地                                                │
│  lib/cluster.js ─◈ lib/symbols.js（组件形状契约，无 import）                   │
│  lib/articles-agentic.js ─► agentic.js + agentic-host.js +                   │
│                              article-contract.js                             │
│  lib/update-planner.js ─► graph-diff.js + incremental.js + symbols.js +      │
│                            change-set.js（ChangeSet ◈ 数据契约）               │
│  lib/engine/quality-gate.js ─► output.js + mapping.js +                      │
│                                  article-contract.js + contract.js           │
│  lib/engine/apply-plan.js ─► mapping.js + contract.js + article-contract.js  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 层 1 组合                                                                     │
│  lib/incremental.js ─► lib/graph-diff.js                                     │
│  lib/engine/mapping.js ─► lib/engine/contract.js                             │
│  lib/engine/output.js ─► mapping.js                                          │
│  lib/engine/client.js ─► contract.js + process-tree.js                       │
│  lib/engine/llm-bridge.js ─► openai-bridge.js                                │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 层 0 叶子（不 import 任何 lib 内模块）                                         │
│  lib/symbols.js · lib/graph-diff.js · lib/change-set.js ·                    │
│  lib/update-record.js · lib/article-contract.js · lib/agentic.js ·           │
│  lib/agentic-host.js · lib/engine/contract.js · lib/engine/manifest.js ·     │
│  lib/engine/process-tree.js · lib/engine/openai-bridge.js ·                  │
│  lib/engine/python/entry.py                                                  │
└─────────────────────────────────────────────────────────────────────────────┘

横切消费方（多对一共用，箭头指向被依赖方）：
  lib/article-contract.js ◄─ lib/articles-agentic.js / lib/engine/quality-gate.js
                            / lib/engine/apply-plan.js / index.js
  lib/engine/contract.js  ◄─ engine/client / engine/mapping / engine/quality-gate
                            / engine/apply-plan / engine/native-run
  lib/symbols.js（SUPPORTED_EXTS）◄─ lib/update-planner.js
```

依赖规则与契约点（未来 agent 改动前必读）：

- **分层不可倒置**：叶子层不得 import 组合层；`index.js` 是唯一允许 import 全部模块的层。例外是**依赖注入边界**：`lib/engine/apply-plan.js` 刻意不 import `index.js`（避免拉起宿主服务），`runCw`/`commit`/`normalizeIndexLinks`/`verifyCommit` 全部由调用方经 `deps` 注入，未注入时回落内置同语义提交器 `commitWikiArtifacts`（`lib/engine/apply-plan.js:250`）。
- **Node 记录契约**：`{id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn}`，由 `lib/symbols.js:13-14` 与 `lib/graph-diff.js:447-448` 共同约定。`lib/symbols.js` 是图的生产者，`diffGraphs`/`clusterComponents`/增量判定都是消费者。
- **组件 id 约定**：`<相对路径>#<符号名>`，方法为 `#<类名>.<方法名>`（`lib/symbols.js:10-11`）；用 `#` 而非 `::` 以避免与 Windows 盘符混淆。
- **跨语言契约**：`ENGINE_CONTRACT_VERSION`（`lib/engine/contract.js:20`）与 `ENGINE_PROTOCOL_VERSION`（`lib/engine/client.js:27`）独立演进——前者管结果字段，后者管行协议；`mapping.js` 的 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`（`lib/engine/mapping.js:30-32`）被 `apply-plan.js:46` 复用为写集白名单。
- **模型通道与进程通道正交**：`client.js` 管进程与 JSON-lines 协议、不连模型；`llm-bridge.js` 管模型通道、不 spawn 引擎；两者由 `native-run.js` 在同一轮编译里编排。引擎与桥之间是 OpenAI-compatible HTTP（loopback + 占位 key），凭证永不出宿主。
- **数据-only 依赖**：`lib/cluster.js` 与 `lib/symbols.js` 之间、`lib/graph-diff.js` 与 `lib/symbols.js` 之间、`lib/change-set.js` → `lib/update-planner.js` 之间只有数据契约（组件形状/Node 形状/ChangeSet），无 import——改任一侧形状必须同步另一侧。

## Module Roles

### 编排与宿主集成（index.js）

- **`index.js`** — 插件主入口（约 5000 行单文件）：JobService 阶段机、Config、工具定义（`codewiki_generate`/`codewiki_update`）、Web 面板端点、两条通道的调度与收割。关键入口：`semanticPlan`(:1393)、`localPlan`(:1371)、`buildPlan`(:2986)、`tickArticles`(:3135)、`startAgenticRun`(:2932)、`runRealtimeTasks`(:662)、`prepareArticleTasks`(:1236)、`startNativeRun`(:2727)、`runStaleUpdate`(:4132)、`tickIndex`(:3602)、`saveRecord`(:2574)。
- **git 辅助（git_helpers）** — `detectLinkedWorktree`(:435)、`isWorktreeCwd`(:459，60s 缓存)、`hasCompilableSources`(:478，10 分钟缓存)、`isDeadCompileTarget`(:504)、`scanRepoFiles`(:2192，黑名单+上限 2000 文件/256KB)、`autoCommitWiki`(:4952，主题分支合并式提交，只 add `.codewiki` 与 `CodeWiki.md`)、`commitHintText`(:5036)、`currentCommit`(:1916)、`normalizeCwd`(:62)。被工具执行、面板、autoScan、落地器注入（`deps.applyDeps.commit`）四方共用。
- **仓库面板助手（repo_helpers）** — `parseStatus`(:294，cw status 三态解析)、`normalizeArticlePath`(:280)、`normalizeIndexLinks`(:284)、`excludedItem`/`isExcluded`(:410/:420)、`loadKnownRepos`/`rememberRepo`/`forgetRepo`(:2147-2170，`dsh-codewiki-repos.json`)、`countWikiArticles`(:310)、`/api/codewiki/repos` handler(:4707，30s 缓存 + wsSig 失效)。
- **单轮写作与锚点** — `collectSources`(:1165)、`packArticles`(:1480)、`applyTaskResult`(:624)、`writeValidated`(:2601)、`validateArticleEnvelope`(:1153，旧闸门)、`fixAnchors`(:927)/`fixChangelogAnchors`(:780)（与 `test-wiki-anchors.mjs` 校验器同源对侧）、`slugify`(:1741，保留 CJK，与 `normalizeModuleName` 是两套策略不可混用)。

### 符号与聚类

- **`lib/symbols.js`** — AST 符号提取：表驱动 17 语言（`LANG_RULES`，:36-271），web-tree-sitter + WASM（装在独立 `vendor/tree-sitter`），不可用时正则兜底 `regexExtract`(:374) 产出同形状记录。`extractRepoGraph`(:785) 只产组件不建边，`resolveImportEdges`(:810) 显式补边。连接：graph-diff（Node 契约）、cluster（组件形状）、update-planner（`SUPPORTED_EXTS`）、index.js 两条链路（:1412/:2238）。
- **`lib/cluster.js`** — LLM 组件聚类三段式：顶层 `clusterPrompt`(:57) → 超大模块下钻 `subdivide`(:396) → 顶层过多超级分组 `superGroupPrompt`(:106)；主入口 `clusterComponents`(:291) 返回 `{modules, tree, concepts, warnings, stats, byId}`；无 LLM 走 `heuristicCluster`(:219)，`fillMissing`(:247) 保证组件零丢失；`toPlanModules`(:460) 转 `job.plan.modules`。注意 `concepts` 恒为 `[]`，概念抽取由横切阶段负责。

### 增量与变更

- **`lib/change-set.js`** — 四路 git 变更采集 `collectChangeSet`(:102)（committed/staged/unstaged/untracked + deleted/renamed，`-M` 改名检测），`parseNameStatus`(:52)，`isWikiProduct`(:26) 排除 `.codewiki/` 自产物，任何采不全都 `fallback='full'`。可 JSON 序列化（要进 update-record）。
- **`lib/graph-diff.js`** — 符号级 diff 核心算法库（逐位移植 FSoft `graph_diff.py`，golden 对拍）：`diffGraphs`(:447) 归类 added/deleted/interface/body/edge/renamed 并产 records（含截断统一 diff）；`changedIds`(:436)、`graphDiffCounts`(:425)、`pairRenames`(:371，贪心改名配对)、`codeHash`(:108，剥注释)/`bodyHash`(:121) 拉开「纯注释」与「实质变更」粒度差。
- **`lib/incremental.js`** — 符号快照存取（`SNAPSHOT_REL`:22 = `temp/symbol-graph.json`，`SLIM_FIELDS`:26 不存源码、固化哈希）：`slimGraph`(:37)/`loadSnapshot`(:94，坏 JSON/版本不符安静返 null)/`saveSnapshot`(:106)/`graphFromSnapshot`(:69)；`filterStaleTasks`(:140) 是朴素判定（已被 `planUpdate` 取代为主链路，保留为最小可验证单元）；`normRel`(:118) 被 update-planner 复用。
- **`lib/update-planner.js`** — 增量规划主入口 `planUpdate`(:156)：`changeSet` + 新旧符号图 + articles + moduleMap → 每篇 `write/keep/review` 动作（含 reasons）；`realChangedIds`(:57) 区分 real/cosmetic/structural；`dependentsOf`(:85) 反向依赖闭包；`buildModuleMap`(:442)/`migrateModuleMap`(:472)；无归属源码变更 → `unmappedSourceChanges` + `needsFull`。已知：`delete` action 从未产出（孤儿文章由 `pruneOrphanModules`，`index.js:342` 清理）。
- **`lib/update-record.js`** — 终态判定与复盘：`judgeOutcome`(:37) 按 blockers 合成 `done/partial/failed/cancelled` 与 `canAdvanceBaseline`；`buildUpdateRecord`(:131)/`saveUpdateRecord`(:217) 落 `temp/update-record.json`（只存摘要不塞符号图）；`loadUpdateRecord`(:229) 版本不符返 null。

### 文章生成（旧通道）

- **`lib/agentic.js`** — 纯逻辑工具循环 `runAgenticArticle`(:331)（无工具调用即写完，`stopReason` 五态）；四工具 `read_code`(:115，重复读抑制+行/字符上限)/`list_files`(:179)/`edit_article`(:200，CRLF 归一+负行号报错)/`generate_sub_module`(:285，无递归支持时必须说实话防死链) 由 `buildToolset`(:279) 组装；`parseToolArgs`(:476) 三级 JSON 抢救；`DEFAULT_MAX_STEPS`(:325)=30 是唯一定义点。
- **`lib/agentic-host.js`** — 宿主适配：`toRequestMessages`(:34，裸消息↔宿主 Message，tool 一拆多、身份稳定)、`makeHostStream`(:83，chunk 收流、error/abort 抛错)、`makeFsWorkspace`(:111，真实 fs 再兜一层 cwd 越界防护)。
- **`lib/articles-agentic.js`** — 执行器：`runOneArticle`(:33，编辑器+workspace+写集闸门+落盘)、`runAgenticArticles`(:231，bigTier/默认双池并发，返回 `Map(customId→结果)`)、`markBigAgenticTasks`(:320)、`sourceTokensOf`(:185)、`resolveTaskRoute`(:208)；`dispatchSub` 递归派生子模块文章且深度封顶。
- **`lib/article-contract.js`** — 文章契约闸门：`inspectArticle`(:213) 判 frontmatter 闭合/必填字段/type-目录匹配/重复 frontmatter/重复章节/必需章节空/围栏未闭合/`source_files` 存在性与证据/死链；error 拒写、warning 放行（`hasBlockingIssue`）；`makeWriteSet`/`isWritable` 写集闸门。消费方：旧通道落盘、原生质量门、落地器。

### 原生 FSoft 引擎通道（lib/engine/）

- **`lib/engine/contract.js`**（阶段 0，叶子）— 跨语言数据契约：`ENGINE_STAGES`(:24-33)、`TERMINAL_OUTCOMES`(:35)、`BLOCKER_KINDS`(:42-53)、`ENGINE_ERROR_CODES`(:57-67)、`RETRYABLE_CODES`(:71)；`engineResult`(:97)/`engineProgress`(:150)/`engineError`(:171) 构造器施加终态硬不变量；`validateEngineResult`(:186) 反序列化边界不抛错校验。
- **`lib/engine/client.js`**（阶段 2）— 唯一 spawn 点：`runEngine`(:223) 按协议不变量收 JSON-lines（requestId 隔离、违规记录、取消后迟到 result 丢弃、退出码 0 无 result 仍判失败）；`createProtocolReader`(:39) 纯逻辑可逐字节喂；失败码映射 engine-missing/timeout/crashed/protocol。
- **`lib/engine/process-tree.js`** — 取消地基：`terminateProcessTree`(:61)（POSIX `detached` 进程组 SIGTERM→SIGKILL；Windows `taskkill /T /F`），`isAlive`(:41)；不整组打掉孙进程会变孤儿继续烧 token。
- **`lib/engine/manifest.js`** — 环境指纹锁：`probeEnvironment`(:34)、`fingerprintOf`(:50，只吃影响产物的因素)、`readLock`(:61)/`compareLock`(:86，absent/match/drift/unhealthy)/`writeLock`(:117，原子写 `.codewiki/engine-lock.json`)、`doctor`(:141，只读诊断不修环境)。
- **`lib/engine/mapping.js`** — 产物格式翻译：`mapFsoftOutput`(:115) 把 FSoft docs 树翻成 wiki 写集，四条硬规则（不臆造 `source_files`/不静默丢弃/不覆盖/不改技术内容）；whole-repository 空树模式页照写但 `attribution:'unattributed'`。
- **`lib/engine/output.js`**（阶段 2）— 产物自洽校验：`collectOutput`(:91)、`buildWritePlan`(:162)、`validateOutput`(:184，entry-missing/empty-body/unmapped-page/article-missing/source-missing/dead-link 等 11 类问题)。
- **`lib/engine/quality-gate.js`**（阶段 3 采用门）— `gateNativeOutput`(:390) 复用 `validateOutput` 不重写判定，叠加 `renderArticle`(:316，正文一字不动+安全 YAML frontmatter)/`checkRendered`(:346)/`assessBaseline`(:188，产物 commit 必须是已提交 HEAD)；defect/degradation/stale 三类机读分流，只有三类皆空才 `done`；`toContractBlockers`(:589)/`toQualityIssues`(:610) 是两条下游判定路径口径一致的关键接线。
- **`lib/engine/apply-plan.js`**（阶段 3 落地器）— `applyNativeOutput`(:414) 四步流水（写盘→`cw index`→基线→提交，`APPLY_STAGES`:49）+ 三条硬不变量：写集封闭（`checkWriteTargets`:86 + `APPLY_WRITE_ROOTS`:46）、索引/基线失败即回滚（`capturePre`/`restorePre`）、提交失败不回滚；`gate-partial` 照写但不洗成 done；`findArticlesMissingFromIndex`(:338) 补 cw index 静默缺页探测。
- **`lib/engine/llm-bridge.js` + `lib/engine/openai-bridge.js`** — 模型通道桥：`startLlmBridge`(:90) 在 `127.0.0.1` 随机端口起 loopback HTTP（`/healthz`、`/v1/models`、`POST /v1/chat/completions`），占位 key 每次随机、错误体不回显、日志不含凭证；`openai-bridge.js` 纯转换 `toLlmRequest`(:128)/`chunksToCompletion`(:236)/`chunksToSse`(:265，`[DONE]` 必收尾)，流式与非流式共用 `foldChunks` 同源拼接。
- **`lib/engine/native-run.js`**（阶段 4 编排）— `runNativeJob`(:68)：环境/锁 → 桥(:233-259) → 引擎(:261-323) → 门(:340) → 落地(:366，`advanceBaseline` 固定 null) → `weakest`(:41) 最弱终态合成(:399-418) → 首跑落锁(:423-438，故意推迟到落地之后防「半截库」误判)；`settle`(:97) 统一出口施加契约硬不变量。
- **`lib/engine/python/entry.py`** — 引擎入口：`_model_config`(:243) 从 `CODEWIKI_BASE_URL/API_KEY/MAIN_MODEL/CLUSTER_MODEL` 环境变量构造 OpenAI-compatible 配置；与桥之间是唯一的跨语言运行时边界。

### 工具与验收

- **`tools/fsoft-engine/setup-env.sh`** — 独立 venv 构建：`--no-deps` 落盘 `locked-requirements.txt` + `constraints.txt` 防依赖跑偏，editable 装 FSoft 本体，`pip check` + import 冒烟收口。
- **`tools/fsoft-engine/probe-no-llm-graph.py`** — 无 LLM 依赖图验收探针（R1–R5：session/组件/依赖边/artifact/workspace 落盘），fixture `tools/fsoft-engine/fixtures/中文 空格 fixture/` 刻意用中文+空格路径压测解析器；模型链路验收由 1B/1C 其它探针覆盖。

### 测试基础设施

全部为独立脚本（`node test-*.mjs` 直接运行），零第三方断言库，共用微型 `check()` 计数器并以 `process.exit(fails ? 1 : 0)` 收尾；优先用「临时目录 + 注入桩」钉不变量，而非重放真实引擎：

- 纯逻辑单测：`test-symbols.mjs`、`test-cluster.mjs`、`test-semantic-plan.mjs`（目录≠职责端到端）、`test-graphdiff.mjs`（与 `test-fixtures/gen-graphdiff-golden.py` 逐位对拍）、`test-incremental.mjs`/`test-incremental-e2e.mjs`、`test-change-set.mjs`、`test-article-contract.mjs`、`test-update-planner.mjs`、`test-update-record.mjs`。
- 引擎侧：`test-engine-contract/client/process-tree/manifest/output/apply-plan/quality-gate/bridge/llm-bridge.mjs`，以及 `test-engine-native-job.mjs`（16 个端到端接线用例）+ `test-fixtures/fake-native-engine.mjs`（**真进程**假引擎，协议与产物真实、算法为桩）。
- agentic 侧：`test-agentic.mjs`、`test-agentic-host.mjs`、`test-articles-agentic.mjs`、`test-agentic-fallback.mjs`（退回链路）。
- wiki 集成：`test-wiki-anchors.mjs`（`file:行号` 锚点对照三基准源码视图）、`test-wiki-entry.mjs`、`test-worktree.mjs`（无 git 环境 SKIP）、`test-prune-orphans.mjs`（删文件安全边界）、`test-batch.mjs`、`test-orchestration.mjs`、`test-cwd-paths.mjs`。

### 关键契约速查

| 契约 | 定义处 | 主要消费方 |
|---|---|---|
| Node 记录形状（8 字段 + dependsOn） | `lib/symbols.js:13-14` ↔ `lib/graph-diff.js:9-10` | graph-diff、cluster、incremental、update-planner |
| 组件 id `<相对路径>#<符号名>` | `lib/symbols.js:10-11` | cluster 提示词、图 diff、module-map |
| ChangeSet（version/ok/state/四路/`sourceChanges`） | `lib/change-set.js:73-93` | planUpdate、judgeOutcome、job 面板 |
| UpdatePlan（actions/summary/unmapped/needsFull） | `lib/update-planner.js:154-179` | `job.updatePlan`（index.js:3931）、judgeOutcome |
| ModuleMap（articles→sources/components/module） | `lib/update-planner.js:442` | planUpdate 增量归属 |
| 符号快照（SLIM_FIELDS，无源码） | `lib/incremental.js:22`/:26 | `diffGraphs` 的旧图来源 |
| EngineResult / EngineProgress / EngineError | `lib/engine/contract.js` | client.js 翻译、native-run 终态、面板 |
| GateReport（defect/degradation/stale 三类分流） | `gateNativeOutput`（`lib/engine/quality-gate.js:390`） | apply-plan、native-run blockers |
| ApplyResult（applied/outcome/rolledBack/blockers） | `lib/engine/apply-plan.js:414` | native-run `apply` 子对象、面板 |
| UpdateRecord（outcome/blockers/canAdvanceBaseline） | `lib/update-record.js:131-211` | `temp/update-record.json`、面板复盘 |
| OpenAI-compatible loopback 协议（占位 key） | `llm-bridge.js:90` 路由 ↔ `entry.py:243` | 引擎模型通道（凭证不出宿主） |

改任何一处契约前，先读对应模块文章的 Known Issues（如：agentic 通道落盘不过二次契约闸门、`filterStaleTasks` 已非生产主链路、桥返回对象不含 `model` 字段、`_meta.yaml` 基线未入库会阻塞推进等），这些是历史上真实踩过的坑。
