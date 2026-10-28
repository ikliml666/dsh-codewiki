---
title: test_core
type: module
source_files:
  - test-batch.mjs
  - test-orchestration.mjs
  - test-agentic.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-sessions.mjs
  - test-prune-orphans.mjs
  - test-cwd-paths.mjs
  - test-worktree.mjs
  - test-engine-output-real.mjs
  - test-graphdiff.mjs
  - test-engine-quality-gate.mjs
  - test-article-contract.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-engine-apply-plan.mjs
  - test-symbols.mjs
  - test-wiki-entry.mjs
tags: [test-infrastructure, assertions, validation, context-wrapping, fixtures, integration-tests]
---

## Overview

`test_core` 不是一个独立的文件，而是本仓库整套 Node 端测试所共享的**核心测试基础设施**：所有以 `test-*.mjs` 命名的冒烟/集成测试，以及 `test-fixtures/` 下的协议夹具，都在反复复用同一套「断言 → 校验 → 上下文包裹 → 入口搭建」的最小积木。读懂这一层，等于读懂了本仓库 30+ 个测试脚本是怎么跑起来的。

这套基础设施由四块能力构成（标题里的四个关键词）：

- **Assertions（断言）** — 几乎每个测试文件都自带一个 `check(label, fn)` 计数器（`test-batch.mjs:17-20`、`test-orchestration.mjs:27-30`、`test-agentic.mjs:12-21`、`test-engine-quality-gate.mjs:42-45`、`test-article-contract.mjs:20-23` 等），既支持同步断言也普遍配一个 `checkAsync`（见 `test-engine-apply-plan.mjs:39-44`、`test-symbols.mjs:27-36`）。失败收进 `fails` 数组，结尾按失败数决定 `process.exit(fails ? 1 : 0)`。少数脚本走「同步 `check` + 末尾 `process.exit(1)」`（如 `test-wiki-entry.mjs:13-16`、`test-sessions.mjs:11`）。
- **Validation（校验/夹具构造）** — 被测对象本身的契约校验函数（`validateArticleEnvelope`、`inspectArticle`、`validateOutput`、`validateEngineResult`、`gateNativeOutput` 等）在测试里被当作「坏输出闸门」逐条钉死；同时测试侧用本地 `makeDocs(name, overrides)` / `makeRepo(name)` / `makeWiki()` 等构造函数造出**真实可写入 git 的**临时目录与 docs 树（见 `test-engine-quality-gate.mjs:51-90`、`test-prune-orphans.mjs:19-30`）。
- **Context wrapping（上下文包裹）** — `test-orchestration.mjs:51-91` 的 `makeCtx()` 是整条编排测试链的「假宿主」：它模拟 cordis 的 `inject(deps, fn)`（带回调传 ctx 切片、不带回调返回 Promise 两种语义都支持，第 69-79 行）、`on(event, fn)`、`effect(fn)`（第 80-88 行），并预置 `webServer`/`agents`/`tools`/`llm`/`workspaceRegistry` 五类服务。配套的 `makeMockAgent(cwd)`（第 94-108 行）包裹 `systemPrompt.section` 注册。`test-cwd-paths.mjs:13-18` 则是更轻量的 `ctx` 变体，只挂 `tools.register` + `subagents`。
- **Entry（入口搭建）** — 每个测试文件开头的「环境隔离与导入」即入口：用 `process.env.DSH_CODEWIKI_JOBS_FILE` 指向随机路径隔离后台 JobService 状态（`test-orchestration.mjs:22-23`、`test-sessions.mjs:7`、`test-worktree.mjs:10`），用 `process.env.DSH_CODEWIKI_TICK_MS` 把 tick 压到下限加速（`test-orchestration.mjs:15`），最后 `await import('./index.js')` 拿到被测导出（`test-orchestration.mjs:24`）。`test-fixtures/fake-native-engine.mjs` 是「假引擎」进程夹具，用 node 当解释器、本文件当入口脚本，让 `lib/engine/client.js` 走**完全真实**的 spawn/stdin/stdout/exit 路径（见文件头注释 `test-fixtures/fake-native-engine.mjs:1-17`）。

黄金基准这类特殊夹具单独成篇（见 [[graph_diff_tests]] 的 `gen-graphdiff-golden.py`/`graphdiff-golden.json`），本模块只覆盖通用基础设施。

## Key Components

## Architecture

## Data Flow

## Connections

## Known Issues
