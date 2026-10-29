---
title: mock_utils
type: module
source_files:
  - test-orchestration.mjs
  - test-agentic.mjs
  - test-articles-agentic.mjs
  - test-engine-native-job.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-engine-llm-bridge.mjs
  - test-agentic-host.mjs
  - test-cluster.mjs
  - test-engine-manifest.mjs
  - test-fixtures/gen-graphdiff-golden.py
tags: [testing, mock, fixtures, test-support]
---

## Overview

`mock_utils` 不是一个独立发布的源码文件，而是**散落在各 `test-*.mjs` 与 `test-fixtures/` 里的共享测试支撑层**：它用一组「模拟物」把整个 dsh-codewiki 插件在完全离线、零密钥、零真实 provider 的情况下跑起来，从而守护「编译执行链 / agentic 写作 / 原生引擎接线 / 协议桥」的真实行为。

为什么需要它：插件 0.10.1 起唯一的模型通道是宿主 llm 服务（插件自己不保存也不传递任何密钥），且编译要跑真实 `cw` CLI、真实 git 提交、真实子进程。要把这套东西放进单测，就必须提供：

- **Mock agents（模拟宿主 agent）**：`makeMockAgent`（`test-orchestration.mjs:94`）造一个带 `session.header.cwd` 和 `ctx.inject(systemPrompt.section)` 的假 agent，专用于验证 system-prompt 提醒的注入/不注入。
- **Mock HTTP requests/responses（模拟面板端点请求/响应）**：`fakeReq`（`test-orchestration.mjs:245`）与 `fakeRes`（`test-orchestration.mjs:255`）造出可喂给 `webServer.register` 出来的端点的请求/响应对象，让 `/api/codewiki/jobs`、`/control`、`/repos`、`/sessions` 等面板端点能被直接 handler 调用并断言状态码与 JSON 体。
- **Mock prompts（模拟模型应答 / prompt 路由）**：`makeBatchMock`（`test-orchestration.mjs:145`）是一个按 prompt 首行特征分发应答的假 `llm.stream` 服务——它同时是「批量请求池 / 取消 / 失败记账 / 思考档位下发」的 mock 上下文；`scripted`（`test-agentic.mjs:62`、复制于 `test-articles-agentic.mjs:37`）按脚本依次返回 tool-call/text 块的假 `streamFn`；`fakeLlm`（`test-engine-llm-bridge.mjs:28`、`test-agentic-host.mjs:67`、`test-engine-native-job.mjs:106`）按 chunk 脚本或默认空完成产出 chunk 流。
- **Batch test contexts（批量编译测试上下文）**：`makeCtx`（`test-orchestration.mjs:51`、同构版在 `test-engine-native-job.mjs:178`）、`makeFixtureRepo`（`test-orchestration.mjs:110`）、`makeRepo`（`test-engine-native-job.mjs:57`）、`waitJob`（`test-orchestration.mjs:230`、`test-engine-native-job.mjs:226`）、`runJob`（`test-engine-native-job.mjs:241`）、`makeWorkspace`（`test-agentic.mjs:29`）、`makeTmp`（`test-articles-agentic.mjs:23`）、`makeComponents`（`test-cluster.mjs:25`）、`fakeProbe`（`test-engine-manifest.mjs:29`）等，构成了可独立成篇的 fixture/编排骨架。
- **Mock engine（模拟原生引擎真进程）**：`test-fixtures/fake-native-engine.mjs` 是一个**真的 node 进程**，只实现协议与产物、不实现算法——用它替换真实 FSoft Python 引擎后，`client.js` 的 spawn / stdin 一行 JSON / stdout JSON-lines / 进程树终止全部走真实代码，避免接线被「注入假函数」悄悄绕过。
- **Mock golden generator（对拍基准生成器）**：`test-fixtures/gen-graphdiff-golden.py` 用 Python 原版 `difflib` 喂同一批输入产出期望 JSON，让 `lib/graph-diff.js` 的移植可逐位比对。

这些工具没有跨文件导出接口——每个测试文件各自复制一套（最常见的 `makeBatchMock`、`makeCtx`、`scripted`、`makeWorkspace`、`check`、`call`、`text` 都被重复实现），它们之间靠「行为约定」保持一致，而非 import。本模块文档因此按**职责 + 出现文件:行号**逐项列出，方便未来 agent 直接照搬。

## Key Components

## Key Components

## Architecture

## Data Flow

## Connections

## Known Issues
