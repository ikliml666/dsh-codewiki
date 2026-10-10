---
title: patterns
type: pattern
source_files: []
tags: [patterns, conventions, architecture, testing]
---

## Overview

本仓库通过 `index.js`、`client.js` 及测试套件等核心文件，确立了严格的工程规范。主要模式包括：基于 Cordis 插件系统的配置与挂载约定、六阶段状态机驱动的异步流水线、前后端分离的 API 轮询机制、以及针对批量推理（Batch Inference）和路径兼容性的特定处理逻辑。

## Patterns

### 1. 插件配置与挂载约定 (Plugin Configuration & Mounting)

仓库遵循 DeepSeek Harness (DSH) 的 Cordis 插件系统标准，通过声明式 YAML 和 JSON 定义插件行为。

*   **挂载补丁**: 使用 `cordis.patch.yml` 进行本地开发和 Bundle 安装的挂载配置，指定 `id` 为 `codewiki` 并指向主逻辑文件 `index.js`。
*   **元数据定义**: `package.json` 中必须包含 `dsh.client.platform: "web"` 以指示客户端模块注入浏览器，并通过 `exports` 字段暴露 `"./client"` 入口。
*   **配置 Schema**: 后端逻辑通过 `@deepseek-ai/schemastery` 定义配置项（如 `batchApiKey`, `maxConcurrency`），前端通过宿主的 `configForms` 服务进行热更新读写，无需重启宿主。

### 2. 六阶段状态机流水线 (Six-Stage State Machine Pipeline)

核心业务逻辑采用明确定义的六阶段状态机驱动后台任务，确保编译流程的可预测性和断点续查能力。

*   **阶段定义**: 活跃阶段严格定义为 `['plan', 'articles', 'crosscut', 'compose', 'review', 'index']`。
*   **状态推进**: `JobService` 在 `tick()` 循环中依次执行各阶段处理器（`tickPlan`, `tickArticles`, `tickCrosscut`, `tickCompose`, `tickReview`, `tickIndex`），每个阶段完成后自动进入下一阶段。
*   **断点续查**: 系统支持从任意阶段恢复，例如在 `review` 阶段中断后，可检测孤儿任务并从该阶段继续执行。

### 3. 批量推理与实时兜底策略 (Batch Inference & Realtime Fallback)

为平衡成本与性能，仓库采用了“优先批量，超时兜底”的混合推理模式。

*   **Token 预算控制**: 设定 `BATCH_TOKEN_BUDGET` (28k) 和 `BATCH_TOKEN_HARD_LIMIT` (200k)，超过硬限制的任务直接转入实时通道。
*   **JSONL 构建**: 使用 `buildBatchJsonl` 将任务组装为标准 JSONL 格式提交至阿里云百炼（DashScope）。
*   **实时兜底**: 对于 oversized 文件或批量失败的情况，使用 `bailianChat` 或 `runRealtimeTasks` 进行并发实时调用作为 fallback。

### 4. 前后端分离与轮询架构 (Frontend-Backend Separation & Polling)

前端面板与后端服务通过 RESTful API 解耦，采用定时轮询机制同步状态。

*   **API 端点**: 后端暴露 `/api/codewiki/jobs` (任务列表), `/api/codewiki/control` (控制操作), `/api/codewiki/repos` (仓库状态) 三个核心端点，且仅限回环访问。
*   **轮询间隔**: 前端 `CodewikiPanel` 每 2000ms 轮询任务状态，`ReposTab` 每 10000ms 轮询仓库状态。
*   **UI 渲染**: 前端使用 React 组件树渲染进度条、步骤条（Step Bar）和吞吐量徽标，所有标签均通过 `zh/en` 字典进行国际化处理。

### 5. 文件系统观测与日志规范 (File System Observability & Logging)

通过专用的日志文件和文件监听器提供运行时可见性，便于诊断长尾延迟和处理异常。

*   **日志结构**: 仓库根 `watcher2.log` 记录了作业的耗时、mtime、job ID 和 notes 标志，用于分析处理队列中的并发和阻塞情况。
*   **关键指标**: 重点关注长时间运行作业（如 `job-muwdn4lx-2` 持续 43 秒）和静态 `upd` 时间戳，以识别潜在的 IO 瓶颈或逻辑死锁。
*   **事件触发**: 文件系统变更触发 Job 创建，监听器捕获 mtime 更新并分配唯一 Job ID。

### 6. 路径兼容性与 CLI 封装 (Path Compatibility & CLI Wrapping)

针对 Windows 和 MSYS 环境的路径差异，进行了专门的规范化处理和测试覆盖。

*   **路径归一化**: 在 `cw.execute` 调用前，对 MSYS 路径（如 `/e/x`）和 Windows 路径（如 `E:/x`）进行归一化，确保 Rust CLI `cw` 能正确解析 `.codewiki` 目录。
*   **CLI 封装**: `index.js` 中的 `runCw()` 函数统一处理子进程执行、超时控制和信号中断，并封装了 `parseStatus()` 来解析 `cw status` 的输出状态。

### 7. 测试套件分层验证 (Layered Testing Suite)

测试代码按原子功能、编排逻辑和集成场景分层，确保核心链路的稳定性。

*   **原子测试**: `test-batch.mjs` 单独验证 Token 估算、JSONL 构建和结果解析等纯函数逻辑。
*   **编排测试**: `test-orchestration.mjs` 使用 Mock Agent 和 Fetch，模拟完整的六阶段流水线、断点续查和并发冲突场景。
*   **入口生成测试**: `test-wiki-entry.mjs` 专门验证 `ensureWikiEntry` 函数的幂等性和跨语言生成能力。