---
title: fsoft_engine_fixtures
type: module
source_files:
  - test-fixtures/fake-native-engine.mjs
  - tools/fsoft-engine/fixtures/中文 空格 fixture/pyproject.toml
  - tools/fsoft-engine/fixtures/中文 空格 fixture/Dockerfile
  - tools/fsoft-engine/fixtures/中文 空格 fixture/scripts/run.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/core/engine.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/handler.py
  - tools/fsoft-engine/fixtures/中文 空格 fixture/src/web/task.ts
  - tools/fsoft-engine/fixtures/.gitignore
  - tools/fsoft-engine/probe-apply-real-cw.mjs
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
  - tools/fsoft-engine/probe-index-missing.mjs
  - tools/fsoft-engine/probe-no-llm-graph.py
  - tools/fsoft-engine/probe-generate.result.json
  - tools/fsoft-engine/probe-no-llm-graph.result.json
  - tools/fsoft-engine/setup-env.sh
  - tools/fsoft-engine/constraints.txt
  - tools/fsoft-engine/locked-requirements.txt
  - tools/fsoft-engine/.gitignore
  - tools/fsoft-engine/out-1a/temp/artifact_index.json
  - lib/engine/native-run.js
  - lib/engine/client.js
  - lib/engine/python/entry.py
  - docs/fsoft-native-engine.md
tags: [fsoft, fixtures, probes, native-engine, integration-testing]
---

## Overview

本模块是一组**为 fsoft-engine 集成测试而生的夹具（fixtures）与探针（probes）**，它们服务于把「Node 重新实现 FSoft 算法」替换为「FSoft 原生引擎 + 薄适配层」的迁移（冻结契约见 `docs/fsoft-native-engine.md`）。它本身**不是产品代码**，而是让 `lib/engine/*` 各层的生产接线能被端到端验证的「最小可信输入 + 一次性验收脚本」。

模块有两条来源线，且都刻意放在**插件仓库之外**或**只纳入可复现输入**：

1. **生产接线专用假引擎**：`test-fixtures/fake-native-engine.mjs`（208 行）。它是一个**只实现协议与产物、不实现任何算法**的 node 脚本，被 `lib/engine/client.js` 当真实入口进程 spawn，用于验证「JobService → 引擎」这条跨进程接线不被悄悄破坏。
2. **fsoft-engine 工具箱**：`tools/fsoft-engine/` 目录下的 fixture 源码、探针脚本、环境构建脚本与锁清单。其中：
   - `fixtures/中文 空格 fixture/`：一个路径含中文与空格的双语言小仓库，专供「无 LLM 依赖图」（阶段 1A）和「原生端到端」（阶段 1C）验收在真路径下跑通；
   - `probe-no-llm-graph.py`：阶段 1A 的引擎侧验收探针，参数化、可重跑；
   - `probe-apply-real-cw.mjs` / `probe-index-missing.mjs`：一次性探针，用**真 `cw`** 跑 `applyNativeOutput`，验证落地器在真 git 仓库 / 真索引下的行为；
   - `probe-generate-with-fake-model.mjs`：用**假模型服务器**（固定 429）驱动真 `lib/engine/python/entry.py`，验证协议桥接与 `engine-model` 错误分类；
   - `setup-env.sh` + `constraints.txt` + `locked-requirements.txt`：从零在仓库外造一个可信的 FSoft 原生引擎 venv 的三件套。

关键设计约束（散见于各文件注释）：

- 夹具产物必须引用**仓库里真实存在的文件**，否则质量门会把每页记成 `source-missing` 而永远 `partial`，把闸门缺陷伪装成夹具配置问题（见 `test-fixtures/fake-native-engine.mjs:62-85` 与 `:118-124`）。
- fixture 页**不带 frontmatter**，因为真实 FSoft 产物是纯 markdown，frontmatter 由渲染层 `renderArticle` 合成（见 `test-fixtures/fake-native-engine.mjs:108-111`）。
- 运行时产物（`.codewiki/`、`docs/`、`out-*/`）一律进 `.gitignore`，入库的只有可复现的源码/配置/锁清单（见 `tools/fsoft-engine/fixtures/.gitignore:1-7` 与 `tools/fsoft-engine/.gitignore:1-2`）。

## Key Components

## Architecture

## Data Flow

## Connections

## Known Issues
