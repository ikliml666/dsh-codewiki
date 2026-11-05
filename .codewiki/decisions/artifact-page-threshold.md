---
title: artifact 独立页不是未接入，是上游占比门槛未触发
type: decision
source_files:
  - lib/engine/mapping.js
tags: [artifact, audit, native-engine]
---

## Overview

审计里一度把「19 篇模块页里没有一篇独立的 artifact 页」判成 artifact 能力未接入，并在 README 与报告里按缺口记账。实测后结论相反：artifact 分析、依赖图节点、索引预算全都正常工作，没建独立页是上游算法的正常输出。

## 判定链条

- 依赖图里确实有 3 个 `component_type: "artifact"` 节点（`package.json`、`cordis.patch.yml`、`tools/fsoft-engine/setup-env.sh`）。
- `artifact_index.json` 记录了 `token_budget: 200000`、`tokens_used: 3083`、`with_prose: false`、3 节点 20 边。
- `ensure_artifact_module` 的门槛不是「有没有 artifact」，而是「聚类 LLM 漏掉的比例」：`ARTIFACT_MIN_SHARE = 0.8`，漏掉不足 20% 就直接原样返回。本仓库 3 个 artifact 节点全被 LLM 正确归入 `build_configuration_and_test_verification_tooling`，share = 100%，函数在第二行就 return 了。

## 为什么不能强行建独立页

补建逻辑在两个分岔上各有正确行为，强行改都会错：

1. 漏得够多（share < 0.8）且这些文件合计 token ≥ `DEFAULT_MIN_TOKEN_PER_MODULE`（1000）→ 插一个顶层模块 `Build, Deployment and Configuration`，artifact 独立成页。
2. 漏得够多但 token 不够 → 并进最近的叶子模块，不单独成页（三个小配置文件撑不起一篇文档）。

本仓库落在第二种情形的反面——根本没漏。要造出独立 artifact 页，得找一个 artifact 占比高且聚类会漏的仓库（大量 Dockerfile / CI / 打包脚本），而不是改插件。

## 处置

不改代码，把结论写进审计口径：artifact 能力「已接入且工作」，只是本仓库的形态不触发独立页分支。反例验证用 `ensure_artifact_module` 的三个分岔实跑过，一次不多一次不少。

