---
title: System Architecture Overview
type: architecture
source_files:
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/engine/process-tree.js
  - lib/articles-agentic.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/article-contract.js
  - lib/symbols.js
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/incremental.js
  - lib/change-set.js
  - lib/update-planner.js
  - lib/update-record.js
  - index.js
  - client.js
  - docs/fsoft-native-engine.md
  - test-engine-llm-bridge.mjs
  - test-engine-bridge.mjs
  - test-engine-contract.mjs
  - test-engine-process-tree.mjs
  - test-articles-agentic.mjs
  - test-symbols.mjs
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-change-set.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - test-cluster.mjs
  - test-semantic-plan.mjs
  - test-orchestration.mjs
  - test-batch.mjs
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - test-worktree.mjs
  - test-cwd-paths.mjs
  - test-sessions.mjs
  - test-prune-orphans.mjs
  - test-agentic-fallback.mjs
  - test-agentic.mjs
  - test-agentic-host.mjs
tags: [architecture, overview, system, modules, fsoft-migration, codewiki]
---

## Overview

dsh-codewiki 是一个 DSH（DeepSeek CodeWiki）插件，分为浏览器半侧（`client.js`）与 Node 半侧（`index.js`）两套入口，并在「FSoft 原生引擎迁移」背景下引入了跨进程适配层。系统核心职责是把仓库源码编译成 `.codewiki/` 文章树（含模块文章、横切文章、入口页），支持全量编译与增量编译，并提供两种文章写作通道：**单轮实时通道**（`runRealtimeTasks`，`index.js:591`）与 **agentic 通道**（`runAgenticArticles`，`lib/articles-agentic.js:231`）。迁移后，FSoft 原生引擎（Python）通过 loopback 桥（`lib/engine/llm-bridge.js` + `lib/engine/openai-bridge.js`）借用宿主凭证做模型调用，其产物经 `lib/engine/mapping.js` 映射落盘；取消语义由 `lib/engine/process-tree.js` 保证杀掉整棵子进程树。

本文档面向零上下文的未来 agent，汇总各模块文章（见 `source_files`）中的职责、数据流与依赖方向，并给出三张框图。

## System Overview

系统由五大子系统构成：客户端界面、Node 编排核心、引擎适配层、增量/规划层、测试与 mock 层。下方总框图展示组件边界与连接。

```text
┌────────────────────────────────────────────────────────────────────────┐
│                       dsh-codewiki 系统总览 (System Overview)           │
└────────────────────────────────────────────────────────────────────────┘
        ┌─────────────────────┐              ┌──────────────────────────┐
        │ client.js (浏览器)   │  HTTP 回环    │ index.js (Node 编排核心)  │
        │ CodewikiCard/Panel   │──/api/codewiki/*►│ apply(): 注册工具+JobService│
        └─────────────────────┘              └────────────┬─────────────┘
                                                          │ tickArticles 阶段机
                                                          ▼
                        ┌─────────────────────────────────────────────────┐
                        │ 规划与提取: symbols.js + cluster.js + change-set │
                        │ 增量与差异: incremental.js + graph-diff.js       │
                        │ 计划与记录: update-planner.js + update-record.js │
                        └─────────────────────────────────────────────────┘
                                                          │
                  ┌───────────────────┬──────────────────┴──────────────────┐
                  ▼                   ▼                    ▼                 │
        ┌─────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐│
        │ 单轮通道        │ │ agentic_core     │ │ engine_bridge (loopback)  ││
        │ runRealtimeTasks│ │ agentic.js +    │ │ llm-bridge+openai-bridge  ││
        │ index.js:591    │ │ articles-agentic│ │ + contract + mapping      ││
        └─────────────────┘ └──────────────────┘ └────────────┬─────────────┘│
                  │                   │                    ┌───▼───────────┐  │
                  │                   │                    │ FSoft 引擎    │  │
                  │                   │                    │ (Python子进程) │  │
                  └───────────────────┴────────────────────►│ process-tree  │  │
                                                           └───────────────┘  │
┌────────────────────────────────────────────────────────────────────────────┐
│ 测试/mock: test-batch.mjs, test-orchestration.mjs, agent_mocks 等钉住整链   │
└────────────────────────────────────────────────────────────────────────────┘
```

- **客户端半侧**（`client.js`）：向宿主槽位注入设置卡片与编译面板，轮询 `webServer` 端点（`client.js:5-13`）。
- **Node 半侧**（`index.js`）：`apply(ctx,config)`（`index.js:4817`）启动 `createJobService`、注册 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` 工具，并 `installWebServer`（`index.js:4879`）。
- **引擎适配层**：`engine_llm_bridge` + `engine_openai_bridge` 提供凭证隔离的模型桥；`engine_contract` + `engine_mapping` 定义跨进程契约与产物映射；`engine_process` 负责取消时杀树。
- **增量/规划层**：`symbol_extraction` 提符号图，`graph_diff` 做组件级 diff，`incremental` 管快照，`change_set` 采 git 变更，`update_planner` 出计划，`update_record` 判终态。
- **写作通道**：`articles_agentic`/`agentic_core` 实现 agentic 循环；`batch_tests` 等测试保证单轮通道纯函数正确。

## Data Flow

一次典型增量编译（stale 模式）的数据流如下框图所示，涵盖从请求进入到基线推进的全过程。

```text
 用户/宿主 ──► client.js ──HTTP──► index.js: apply()
                                     │
                                     ▼
                          createJobService → submit(job) (index.js:3642)
                                     │
                                     ▼
                          buildPlan: scanRepoFiles (index.js:2121)
                                     │
                                     ├─► semanticPlan: extractRepoGraph (lib/symbols.js:785)
                                     │                   → resolveImportEdges (lib/symbols.js:810)
                                     │                   → clusterComponents (lib/cluster.js:291)
                                     └─► fallback localPlan (index.js:1300)
                                     ▼
                          tickArticles 双通道:
                     ┌──────────────────────┐    ┌────────────────────────┐
                     │ runRealtimeTasks      │    │ runAgenticArticles      │
                     │ (index.js:591)        │    │ (lib/articles-agentic.js:231)│
                     └──────────┬───────────┘    └───────────┬────────────┘
                                │ llm.stream                  │ makeHostStream
                                ▼                             ▼
                         宿主 llm 服务 ◄─ engine_llm_bridge ── FSoft 引擎 (POST /v1/chat/completions)
                                │                             (lib/engine/llm-bridge.js:90)
                                ▼
                          落盘 modules/*.md ── isWritable 闸门 (lib/article-contract.js:336)
                                │
                                ▼
                          incremental.snapshot (lib/incremental.js:37)
                          + update-planner.planUpdate (lib/update-planner.js:156)
                                │
                                ▼
                          update-record.judgeOutcome (lib/update-record.js:37)
                                │
                                ▼
                          canAdvanceBaseline? → cw meta update (index.js:3399)
```

关键数据流细节：
1. **变更采集**：`collectChangeSet`（`lib/change-set.js:102`）从 git 四路采变更，降级则 `fallback='full'`。
2. **符号图差异**：`filterStaleTasks`（`lib/incremental.js:140`）调 `diffGraphs`（`lib/graph-diff.js:447`），用 `codeHash` 做纯注释降级。
3. **引擎桥请求**：FSoft 引擎发 `POST /v1/chat/completions` 到 `127.0.0.1:随机端口`，`bearerOf` 校验占位 key（`lib/engine/llm-bridge.js:38`），`toLlmRequest` 转换无 apiKey（`lib/engine/openai-bridge.js:128`），`llm.stream` 返回 chunk 经 `chunksToSse` 回传。
4. **终态记录**：`buildUpdateRecord`（`lib/update-record.js:131`）落盘 `temp/update-record.json`，仅 `done` 推进基线。

## Dependency Graph

各模块间的依赖方向（A ──► B 表示 A 依赖于 B 或使用 B 的出口）如下图所示。

```text
┌────────────────────────── 依赖方向 (Dependency Graph) ──────────────────────────┐
│ index.js ──► 所有 lib/* 模块 (编排中枢, 调用 apply/tickArticles/submit)         │
│                                                                                 │
│ engine_llm_bridge.js ──► openai-bridge.js (纯转换 toLlmRequest/chunksToSse)     │
│ engine_llm_bridge.js ──► contract.js (经由 mapping 的 ENGINE_CONTRACT_VERSION)  │
│ engine_mapping.js ──► contract.js (ENGINE_CONTRACT_VERSION, mapping.js:217)     │
│                                                                                 │
│ agentic_core: agentic.js ──► article-contract.js (makeWriteSet/isWritable)      │
│ articles-agentic.js ──► agentic.js + agentic-host.js + article-contract.js     │
│ agentic-host.js ──► @deepseek-ai/dsh-llm (宿主 llm 适配)                        │
│                                                                                 │
│ symbols.js ──► graph-diff.js (节点形状契约 id#name, lib/symbols.js:13)          │
│ incremental.js ──► graph-diff.js (diffGraphs/codeHash, lib/incremental.js:17)   │
│ update-planner.js ──► graph-diff.js + symbols.js + incremental.js               │
│ update-record.js ──► update-planner.js + change-set.js (lib/update-record.js)  │
│ cluster.js ──► symbols.js (components 输入, lib/cluster.js 消费 extractRepoGraph)│
│                                                                                 │
│ lib/engine/process-tree.js (独立, 被 cancel 动作调用, 不依赖其他 lib)             │
│ client.js ──► index.js 端点 (webServer 回环, client.js:491)                     │
│ test-orchestration.mjs (agent_mocks) ──► index.js + agentic-host 协议          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

依赖要点：
- **纯函数内核** `graph-diff.js` 被 `incremental.js`、`update-planner.js`、`symbols.js` 共用，无反向依赖。
- **契约层** `contract.js` 只被 `mapping.js` 与引擎桥间接引用，自身无 I/O。
- **写作通道** 依赖 `article-contract.js` 做写集闸门，但不反向。
- **index.js** 是扇入中心，所有 `lib/` 模块均被其编排，但模块间尽量通过纯函数解耦。

## Module Roles

以下按模块文章顺序简述职责与关键行号，供未来 agent 快速定位。

### engine_llm_bridge（引擎 loopback 桥）
- 文件：`lib/engine/llm-bridge.js`、`lib/engine/openai-bridge.js`。
- 职责：把 FSoft 引擎的 OpenAI-compatible HTTP 请求翻译成宿主 `llm.stream`，再翻回 SSE/JSON。**凭证边界**是核心不变式——绑定 `127.0.0.1` 随机端口、随机占位 key、永不转发 Authorization（`lib/engine/llm-bridge.js:1-17,90,96,118`）。
- 路由：`GET /healthz`、`GET /v1/models`、`POST /v1/chat/completions`（`lib/engine/llm-bridge.js:112-225`）。

### engine_contract（跨进程契约）
- 文件：`lib/engine/contract.js`、`lib/engine/mapping.js`。
- 职责：定义并校验一次 generate/update 的完整结果（`engineResult`，`contract.js:97`），归一化终态 `done/partial/failed/cancelled`；`mapFsoftOutput`（`mapping.js:115`）把 FSoft 产物树映射为 `.codewiki/` 五类文章，硬规则“不臆造 source_files / 不静默丢弃”。

### engine_mapping（产物映射）
- 文件：`lib/engine/mapping.js`。
- 职责：纯函数翻译层，将 `overview.md`+模块页+`module_tree.json` 映射为 `CodeWiki.md`+`modules/<slug>.md`，复用 `ENGINE_CONTRACT_VERSION`（`mapping.js:256`）。

### articles_agentic（agentic 批量执行器）
- 文件：`lib/articles-agentic.js`。
- 职责：`runOneArticle`（`:33`）跑单篇并落盘，`runAgenticArticles`（`:231`）双池并发，子模块递归派发（`dispatchSub` 闭包，`:83-128`），写集闸门（`isWritable`，`:156`）。

### symbol_extraction（符号提取）
- 文件：`lib/symbols.js`。
- 职责：`extractRepoGraph`（`:785`）用 tree-sitter 提组件图，WASM 缺则正则降级（`regexExtract`，`:374`）；`resolveImportEdges`（`:810`）建文件级依赖边。

### engine_openai_bridge（纯协议转换）
- 文件：`lib/engine/openai-bridge.js`。
- 职责：无 I/O 无密钥的纯函数：`toLlmRequest`（`:128`）、`chunksToCompletion`（`:236`）、`chunksToSse`（`:265`）、`foldChunks`（`:192`）。返回值永不含 `apiKey`。

### agentic_core（agentic 内核）
- 文件：`lib/agentic.js`、`lib/articles-agentic.js`、`lib/agentic-host.js`、`lib/article-contract.js`。
- 职责：`runAgenticArticle`（agentic.js:331）工具循环；`makeHostStream`（agentic-host.js:83）适配宿主 llm；`makeWriteSet/isWritable`（article-contract.js:323/336）写集闸门。

### graph_diff（符号级 diff）
- 文件：`lib/graph-diff.js`。
- 职责：移植自 FSoft 的纯算法：`diffGraphs`（`:447`）分类 added/deleted/interface/body/edge/renamed；`bodySimilarity`（`:239`）与 `unifiedDiff`（`:327`）对拍 golden。

### engine_process（进程树终止）
- 文件：`lib/engine/process-tree.js`。
- 职责：`terminateProcessTree`（`:61`）跨平台杀子进程树（Windows `taskkill` / POSIX 进程组信号），`isAlive`（`:41`）探测，保证取消不留孤儿。

### change_set（变更采集）
- 文件：`lib/change-set.js`。
- 职责：`collectChangeSet`（`:102`）从 git 四路（committed/staged/unstaged/untracked）采变更，降级 `fallback='full'`，绝不假装 clean。

### update_planner（增量计划）
- 文件：`lib/update-planner.js`。
- 职责：`planUpdate`（`:156`）输出 `write/keep/delete/review` 动作，`realChangedIds`（`:57`）用 `codeHash` 做纯注释降级，`dependentsOf`（`:85`）反向依赖闭包。

### batch_tests（整链自检）
- 文件：`test-batch.mjs`。
- 职责：离线钉 `index.js` 纯函数链与 `runRealtimeTasks` 并发池，mock llm 验证大档分池/取消/失败记账。

### update_record（终态与记录）
- 文件：`lib/update-record.js`。
- 职责：`judgeOutcome`（`:37`）判 `done/partial/failed/cancelled` 并给 blockers；`buildUpdateRecord`（`:131`）落盘复盘；`canAdvanceBaseline` 仅 `done` 真。

### incremental（快照与 stale 判定）
- 文件：`lib/incremental.js`。
- 职责：`slimGraph`（`:37`）瘦身快照，`filterStaleTasks`（`:140`）折组件级 keep/dropped，`codeHash` 降级纯注释（`lib/incremental.js:162`）。

### cluster_planning（聚类规划）
- 文件：`lib/cluster.js`。
- 职责：`clusterComponents`（`:291`）三段式 LLM 聚类 + `heuristicCluster` 降级，保“组件零丢失”，`toPlanModules`（`:460`）输出文章任务。

### agent_mocks（测试桩）
- 文件：`test-orchestration.mjs`。
- 职责：提供 `makeBatchMock`/`fakeReq`/`fakeRes` 等离线 mock，驱动 `index.js` 服务化编排冒烟。

### app_client（入口工厂与顶层测试）
- 文件：`client.js`、`index.js` 及多个顶层 `test-*.mjs`。
- 职责：`client.js` 注入 UI 与轮询端点；`index.js` 的 `apply`（`:4817`）是 Node 入口；顶层测试覆盖 `estimateTokens`/`fixAnchors`/`pruneOrphanModules` 等横跨子模块的不变量。

各模块通过 `index.js` 编排成完整编译流水线，引擎适配层保证凭证隔离与取消可靠，增量层保证“变更不丢、伪变更不重写”，测试层保证行为可钉。
