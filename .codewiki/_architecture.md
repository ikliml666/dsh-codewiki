---
title: 系统总览
type: architecture
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/incremental.js
  - lib/update-planner.js
  - lib/change-set.js
  - lib/symbols.js
  - test-update-planner.mjs
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/update-record.js
  - lib/engine/client.js
  - lib/engine/manifest.js
  - lib/engine/process-tree.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-engine-manifest.mjs
  - test-engine-process-tree.mjs
  - test-engine-client.mjs
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - test-engine-contract.mjs
  - lib/article-contract.js
  - test-engine-apply-plan.mjs
  - test-engine-output.mjs
  - test-engine-output-real.mjs
  - lib/articles-agentic.js
  - test-batch.mjs
  - test-articles-agentic.mjs
  - test-engine-quality-gate.mjs
  - test-engine-python-entry.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-bridge.mjs
  - tools/fsoft-engine/probe-apply-real-cw.mjs
  - tools/fsoft-engine/probe-index-missing.mjs
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/probe-generate.result.json
  - tools/fsoft-engine/probe-no-llm-graph.result.json
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-cwd-paths.mjs
  - test-prune-orphans.mjs
  - test-sessions.mjs
  - test-worktree.mjs
  - lib/engine/openai-bridge.js
tags:
  - architecture
  - overview
  - system
  - modules
---

## Overview

CodeWiki 是把代码仓库编译成结构化 wiki 文档的插件系统，整体由「源码符号提取 → 变更/增量判定 → 模块聚类规划 → 引擎原生生成/适配 → 产物映射与质量门 → 落地写库 → 文章批量写作 → 终态记录」的流水线构成。系统包含纯 Node 库（graph-diff、cluster、change-set、update-planner、incremental、update-record、article_batch 编排）、跨语言引擎运行时（FSoft 原生 Python 引擎适配层与 LLM 桥）、以及完整的测试与探针套件。本文章为 zero-context 未来 agent 提供系统级地图，所有职责与连接均引用各模块横切文章中的源文件行号。

## System Overview

```text
┌──────────────────────────── 源码输入与符号提取 ────────────────────────────┐
│ lib/symbols.js (提取组件清单) │ lib/change-set.js (git四路采集)             │
└───────────────┬───────────────────────────────┬───────────────────────────┘
                │                                │
                ▼                                ▼
┌──────────────────────┐            ┌──────────────────────────┐
│ lib/cluster.js       │            │ lib/graph-diff.js         │
│ (模块聚类规划)        │            │ (符号级增量diff)           │
└──────────┬───────────┘            └──────────┬───────────────┘
           │                                   │
           ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ index.js (编排服务/batch/article_batch) + lib/update-planner.js   │
│ lib/articles-agentic.js (agentic通道)                             │
└───────────┬───────────────────────────────────────┬──────────────┘
            │                                        │
            ▼                                        ▼
┌──────────────────── engine_runtime (跨语言边界) ───────────────────────┐
│ lib/engine/client.js ─► spawn ─► lib/engine/python/entry.py           │
│   │ (协议 reader)                 │ (FSoft原生引擎适配)                │
│   ▼                               ▼                                   │
│ lib/engine/manifest.js      lib/engine/process-tree.js (终止进程树)   │
│ FSoft codewiki (依赖图/聚类/写作) ─► docs/ 树产出                     │
│ lib/engine/contract.js (契约) │ lib/engine/llm-bridge.js+openai-bridge│
└───────────┬───────────────────────────────────────────┬──────────────┘
            │                                           │
            ▼                                           ▼
┌──────────────────────── 产物处理管道 ────────────────────────────────┐
│ lib/engine/output.js ─► lib/engine/mapping.js (映射)                 │
│   ▼                                                                │
│ lib/engine/quality-gate.js (采用门) ─► lib/engine/apply-plan.js     │
│   (落地:写盘/index/基线/提交)                                       │
└───────────┬───────────────────────────────────────────┬──────────────┘
            ▼                                           ▼
┌───────────────────── 记录与测试 ───────────────────────────────────┐
│ lib/update-record.js │ 测试模块: graph_diff_tests, engine_*,       │
│                      │ orchestration_tests, wiki_tests, misc_tests,│
│                      │ engine_probes                              │
└──────────────────────────────────────────────────────────────────┘
```

上图给出主干：左侧源码经 `lib/symbols.js` 与 `lib/change-set.js` 采集；`lib/cluster.js` 做模块规划，`lib/graph-diff.js` 做组件级增量 diff；中部 `index.js` 编排批处理与 `lib/update-planner.js` 生成文章级计划；下侧 `engine_runtime` 拉起 FSoft 原生引擎产出 `docs/` 树，经 `output.js`+`mapping.js` 映射、`quality-gate.js` 采用门裁决、`apply-plan.js` 落地写库；底部由 `lib/update-record.js` 记录终态，各测试模块守护对应产品代码。

## Data Flow

```text
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ git repo     │  │ source code  │  │ baseCommit   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────────────────────────────────────────────┐
│ collectChangeSet (lib/change-set.js:102)             │
│   └─► ChangeSet{sourceChanges,...}                  │
│ extractRepoGraph (lib/symbols.js) ─► components      │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│ diffGraphs (lib/graph-diff.js:447) + pairRenames     │
│   └─► GraphDiff{added,deleted,interface,body,edge,   │
│        renamed,records}                              │
│ planUpdate (lib/update-planner.js:156)              │
│   └─► actions: write/keep/delete/review             │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│ clusterComponents (lib/cluster.js:291) ─► modules     │
│   └─► job.plan.modules                               │
│ runEngine (lib/engine/client.js:223) ─► entry.py     │
│   ─► FSoft generate ─► docs/                         │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│ collectOutput (lib/engine/output.js:91)              │
│ mapFsoftOutput (lib/engine/mapping.js:115)           │
│ gateNativeOutput (lib/engine/quality-gate.js)        │
│ applyNativeOutput (lib/engine/apply-plan.js)         │
│   └─► .codewiki/ + CodeWiki.md + git commit          │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│ update-record.json (lib/update-record.js) + JOBS_FILE │
│ article_batch (index.js tickArticles) 写文章          │
└──────────────────────────────────────────────────────┘
```

数据流起点是 git 仓库与基线 commit：`lib/change-set.js:102` 的 `collectChangeSet` 合四路改动，`lib/symbols.js` 提取组件；接着 `lib/graph-diff.js:447` 的 `diffGraphs` 与 `lib/update-planner.js:186` 的 `planUpdate` 算出组件/文章级变更；`lib/cluster.js:291` 聚类出模块树；`lib/engine/client.js:223` 的 `runEngine` 驱动 Python 入口产生 `docs/`；产物经 `lib/engine/output.js:91` → `lib/engine/mapping.js:115` → `lib/engine/quality-gate.js` → `lib/engine/apply-plan.js` 完成映射、采用裁决与落地；最终由 `lib/update-record.js` 记录，并由 `index.js` 的 `tickArticles` 驱动文章写作。

## Dependency Graph

```text
┌─────────────────────────── 底层纯函数/契约 ───────────────────────────┐
│ lib/engine/contract.js │ lib/article-contract.js │ lib/symbols.js     │
└───────────┬───────────────────────┬──────────────────────┬────────────┘
            │                        │                      │
            ▼                        ▼                      ▼
┌────────────────┐ ┌──────────────────────┐ ┌──────────────────────────┐
│ lib/graph-diff │ │ lib/engine/mapping.js │ │ lib/cluster.js           │
│ .js            │ │ lib/engine/output.js  │ │ lib/change-set.js        │
└───────┬───────┘ └───────────┬───────────┘ └────────────┬─────────────┘
        │                     │                        │
        ▼                     ▼                        ▼
┌──────────────────────────────────────────────────────────────────┐
│ lib/update-planner.js │ lib/incremental.js │ lib/update-record.js  │
└───────────┬───────────────────────┬──────────────────────┬────────┘
            │                        │                      │
            ▼                        ▼                      ▼
┌──────────────────┐ ┌──────────────────────────┐ ┌────────────────────┐
│ lib/engine/      │ │ lib/engine/quality-gate  │ │ index.js           │
│ client.js +      │ │ .js                     │ │ (orchestration)    │
│ python/entry.py  │ └───────────┬────────────┘ └─────────┬──────────┘
│ + bridges        │             ▼                      │
└──────────────────┘ ┌──────────────────────────┐       │
                     │ lib/engine/apply-plan.js │◄──────┘
                     └──────────────────────────┘
            ▲                                        │
            │ 测试模块依赖上述所有产品模块            ▼
┌──────────────────────────────────────────────────────────────────┐
│ graph_diff_tests, engine_*, orchestration_tests, wiki_tests,     │
│ misc_tests, engine_probes                                        │
└──────────────────────────────────────────────────────────────────┘
```

依赖方向自上而下：底层契约与符号定义（`lib/engine/contract.js:20`、`lib/symbols.js:13-14`）被中间层 diff/映射/聚类消费；中间层（`lib/graph-diff.js`、`lib/engine/output.js`、`lib/cluster.js`）被 planner/record/engine 门面依赖；引擎运行时（`lib/engine/client.js`、`lib/engine/python/entry.py`、`lib/engine/llm-bridge.js`）与质量门/`apply-plan` 构成执行终端；`index.js` 编排一切。所有测试模块（如 `test-graphdiff.mjs`、`test-engine-quality-gate.mjs`、`test-orchestration.mjs`）仅依赖产品代码，不反向被依赖。

## Module Roles

- **graph_diff** (见 modules/graph_diff.md)：符号级增量 diff 引擎，纯函数。`diffGraphs` 主入口在 `lib/graph-diff.js:447`，依 id 差分、分类 interface/body/edge、pairRenames 改名配对（`lib/graph-diff.js:371`）。被 `lib/incremental.js` 与 `lib/update-planner.js` 复用，契约节点形状来自 `lib/symbols.js:13-14`。
- **update_planner** (见 modules/update_planner.md)：消费 diff 与 changeSet 生成文章级计划，`planUpdate` 在 `lib/update-planner.js:156`，结合 moduleMap/dependentsOf 算反向依赖闭包产出 write/keep/delete/review。
- **cluster** (见 modules/cluster.md)：模块聚类规划，`clusterComponents` (`lib/cluster.js:291`) 将组件按职责聚成模块树（LLM 或 heuristic 降级），输出供文章写作的任务清单。
- **change_set** (见 modules/change_set.md)：git 改动采集，`collectChangeSet` (`lib/change-set.js:102`) 合一 committed/staged/unstaged/untracked，输出 ChangeSet，失败一律 fallback='full'。
- **engine_runtime** (见 modules/engine_runtime.md)：跨语言运行时容器，含 `client.js`(`runEngine` `lib/engine/client.js:223`)、`manifest.js`(环境指纹)、`process-tree.js`(终止进程树)、`contract.js`(契约)、`llm-bridge.js`(loopback 模型桥)。
- **engine_contract** (见 modules/engine_contract.md)：契约与映射层，`engineResult`(`lib/engine/contract.js:97`) 强制四态不变量；`mapFsoftOutput`(`lib/engine/mapping.js:115`) 将 FSoft docs 树翻成 cw 写集，四条硬规则防静默丢弃。
- **engine_plan_apply** (见 modules/engine_plan_apply.md)：阶段3落地器，`applyNativeOutput`(`lib/engine/apply-plan.js`) 写盘→cw index→基线→提交，三条硬不变量（写集封闭/索引基线失败回滚/提交失败不回滚）。
- **engine_output** (见 modules/engine_output.md)：产物读与映射，`collectOutput`(`lib/engine/output.js:91`) 读 docs 树，`validateOutput` 判自洽，交由 mapping 翻译。
- **article_batch** (见 modules/article_batch.md)：文章批处理与编排，`prepareArticleTasks`(`index.js`) 装配 prompt，`runRealtimeTasks`(`index.js`) 并发执行，agentic 通道在 `lib/articles-agentic.js`。
- **engine_quality_gate** (见 modules/engine_quality_gate.md)：采用门，`gateNativeOutput`(`lib/engine/quality-gate.js`) 复用 output 校验+article-contract+git基线，分流 defect/degradation/stale，仅三类皆空才 done。
- **engine_python** (见 modules/engine_python.md)：Python 入口 `entry.py`(`lib/engine/python/entry.py`) 接管 stdout 守卫、桥接 FSoft 五段进度到契约八段(`stage_map.py:20`)，异常分类成契约终态。
- **engine_bridges** (见 modules/engine_bridges.md)：LLM 协议翻译，`startLlmBridge`(`lib/engine/llm-bridge.js:90`) 提供 127.0.0.1 随机端口+占位 key，`openai-bridge.js` 做 OpenAI↔DSH 转换，凭证不落盘。
- **graph_diff_tests / engine_probes / orchestration_tests / wiki_tests / misc_tests** (见对应模块文章)：覆盖黄金对拍、真实环境验收、端到端编排、锚点/入口校验、路径/孤儿/会话/worktree 边界，均依赖产品模块且经退出码门禁。
- **update_record** (贯穿各文)：`lib/update-record.js` 的 `judgeOutcome`/`buildUpdateRecord` 消费 changeSet 与 gate 结论，记录终态并决定是否推进基线。
