---
title: test-logging
type: concept
source_files:
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [测试, 日志, 临时文件, 集成验证, 监听, 排查]
---

## Overview

`test-logging` 是跨模块概念，覆盖 `dsh-codewiki` 插件的测试执行（由 `test-scripts` 模块驱动）、核心逻辑验证（针对 `core-and-config` 模块的 `index.js`）以及运行期日志产出（落盘于 `logs-and-temp` 模块）。该概念描述了端到端测试套件如何通过断言函数 `check` 验证核心导出函数与编排服务，并将分组测试结果写入对应的 `.tmp-test-*.log`，同时由外部 watcher 进程轮询 `index.js` 生成的编译 job 状态并追加到 `watcher2.log`，从而形成一套用于排查错误与记录运行时输出的测试日志闭环。

## Involved Modules

1. **test-scripts**：包含 `test-batch.mjs`、`test-cwd-paths.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs`、`test-wiki-entry.mjs` 五个独立脚本，直接 `import` 或 `await import('./index.js')` 以加载被测插件主体，利用 `check` 断言辅助（如 `test-batch.mjs:16`）输出 `✓`/`✗` 结果。
2. **core-and-config**：提供插件核心 `index.js`（如 `index.js:2928` 的 `apply` 与 `index.js:1213` 的 `createJobService`），导出待验证的纯函数与服务化阶段机，并通过 `JOBS_FILE`（`index.js:1010`）与 `TICK_MS`（`index.js:1011`）驱动任务持久化与轮询。
3. **logs-and-temp**：纯日志数据模块，由 `.tmp-test-batch.log`、`.tmp-test-cwd-paths.log`、`.tmp-test-orchestration.log`、`.tmp-test-wiki-anchors.log`、`.tmp-test-wiki-entry.log` 及 `watcher2.log` 组成，承接测试断言输出与 watcher 监听输出。

## Flow

1. **加载与执行**：测试脚本启动即通过 `import { ... } from './index.js'`（`test-batch.mjs:7`）或 `await import('./index.js')`（`test-orchestration.mjs:20`）加载 `core-and-config` 的插件主体。
2. **断言与逻辑验证**：脚本利用 `fs.mkdtempSync` 构造临时仓库，调用纯函数（如 `fixAnchors`、`ensureWikiEntry`）或通过 `makeCtx`（`test-orchestration.mjs:40`）注入模拟服务执行 `apply(ctx, cfg)`，触发 `gen.execute`（`test-orchestration.mjs:448`）。测试侧以 `waitJob`（`test-orchestration.mjs:197`）轮询 `JOBS_FILE` 获取 `index.js` 阶段机推进的终态。
3. **测试日志落盘**：测试执行器将分组断言结果按固定文本格式写入对应的 `.tmp-test-*.log`（如 `test-batch.mjs` 的 `check` 结果由 `.tmp-test-batch.log:2` 起记录分组，`.tmp-test-batch.log:85` 汇总 `ALL PASS：59 通过，0 失败`；`.tmp-test-orchestration.log:573` 汇总 `FAIL：2 项未通过`）。
4. **Watcher 监听记录**：独立的 watcher 进程以约 30ms 间隔轮询由 `core-and-config` 产生的活动 job（其阶段如 `plan`、`articles` 等由 `createJobService` 定义），将单行状态（含 `job`、`stage`、`cancelReq`、`upd` 等字段）追加到 `watcher2.log`（如 `watcher2.log:1` 记录 `job-muwdk1pk-2 plan`）。
5. **事后审查**：开发者读取日志获知失败总数（`.tmp-test-orchestration.log:573`）、锚点失误（`.tmp-test-wiki-anchors.log:161`）及 job 卡留阶段（`watcher2.log:1-304` 的 `plan` 停滞）。

## Implementation Map

- **测试脚本入口与断言**：`test-batch.mjs:16`（加载 `index.js`）、`test-batch.mjs:16`（`check` 断言）、`test-orchestration.mjs:23`（动态加载）、`test-orchestration.mjs:40`（`makeCtx` 构造）、`test-orchestration.mjs:197`（`waitJob` 轮询）、`test-orchestration.mjs:448`（`gen.execute` 触发）。
- **核心被测实现**：`index.js:2928`（`apply` 插件入口）、`index.js:1213`（`createJobService` 核心编排）、`index.js:1010`（`JOBS_FILE` 任务持久化文件）、`index.js:1011`（`TICK_MS` 节拍）、`index.js:396`（`fixAnchors` 行号修正，被 `test-batch.mjs:469` 验证）、`index.js:209`（`ensureWikiEntry`，被 `test-wiki-entry.mjs:27` 验证）。
- **日志文件实现位置**：
  - `.tmp-test-batch.log:76-85`：记录 `test-batch.mjs` 的纯函数与端点单测结果（含历史 `resolveBatchApiKey` 用例，源码现改为删除校验）。
  - `.tmp-test-cwd-paths.log:1-8`：记录 `test-cwd-paths.mjs` 的 cwd 路径归一化测试结果。
  - `.tmp-test-orchestration.log:1-573`：记录 `test-orchestration.mjs` 编排冒烟测试结果及 `source` 标记失败项（行 114、195）。
  - `.tmp-test-wiki-anchors.log:1-161`：记录 `test-wiki-anchors.mjs` 的符号绑定校验结果（行 161 汇总 `122 过 / 36 败`）。
  - `.tmp-test-wiki-entry.log:1-25`：记录 `test-wiki-entry.mjs` 入口生成测试结果（行 25 `全部断言通过`）。
  - `watcher2.log:1-1397`：watcher 轮询 `core-and-config` job 的状态日志（行 1 起记录 `job-muwdk1pk-2 plan` 等多任务监听）。