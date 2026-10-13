---
title: wiki-generation-flow
type: concept
source_files:
  - index.js
  - client.js
tags: [wiki-generation, job-service, bailian-endpoint, pipeline, observability]
---

## Overview

`wiki-generation-flow` 描述了 CodeWiki 插件从触发编译到最终生成完整文档仓库的端到端自动化流程。该概念核心在于 `index.js` 模块中的 `createJobService` 所驱动的阶段机（Stage Machine），它将复杂的文档生成任务分解为规划、文章生成、横切合成、审校和索引五个主要阶段，全部模型环节走百炼普通入口（chat/completions，后台并发池，任务输入压在 ≤32k token 低价档）。整个流程由后台 Tick 循环异步推进，前端通过 `client.js` 提供的 API 进行状态轮询和可视化监控。

## Involved Modules

1.  **`core-logic`**: 流程的核心引擎。负责定义 `codewiki_generate` 工具、管理 `JobService` 实例、执行阶段转换逻辑（Tick Handlers）、调用百炼 API 以及协调 Rust CLI `cw`。
2.  **`client-interface`**: 用户交互层。提供侧边栏面板 (`CodewikiPanel`) 和设置表单 (`CodewikiCard`)，通过轮询后端 API 展示进度、控制任务并同步配置。
3.  **`documentation-and-config`**: 元数据与入口层。定义了 `CodeWiki.md` 的生成目标、插件配置结构以及变更日志历史，确保输出符合 `<repo>/.codewiki/` 约定。

## Flow

### 1. 触发与初始化 (Trigger & Init)
*   **入口**: 用户调用 `codewiki_generate` 工具或自动调度器 (`autoScan`) 触发。
*   **状态检查**: `core-logic` 执行 `cw status` 判断仓库状态（missing/uncompiled/clean/stale）。
*   **Job 创建**:
    *   若存在活跃任务，返回现有 Job ID。
    *   否则，创建新 Job，解析凭证（`resolveBatchApiKey`），初始状态设为 `plan` 或 `articles`，并持久化至 `JOBS_FILE`。

### 2. 阶段机推进 (Pipeline Execution)
后台 `tick()` 循环每 10 秒（`TICK_MS`）检查所有活跃 Job 的状态并推进：

*   **Phase 1: Plan (规划)**
    *   扫描源码文件 (`scanRepoFiles`)，应用黑名单。
    *   提交本地规划任务，解析 JSON 计划，确定模块分组。
    *   进入 `articles` 阶段。

*   **Phase 2: Articles (文章生成)**
    *   根据计划收集源文件内容 (`collectSources`)。
    *   **Token 预算检查**: 估算 Token 数，单文件超过 `BATCH_TOKEN_HARD_LIMIT` (200k) 装不进大档时转入超大兜底。
    *   **阶段提交**: `submitBatchFor` 启动 `startBatchChatRun` 后台并发池，打百炼普通入口（`dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`）。
    *   **超大兜底**: 装不进 200k 大档的单文件任务，使用 `runRealtimeTasks` 并发池原样内联该文件继续执行。
    *   **落盘**: 结果解析后写入 `.codewiki/modules/`。
    *   进入 `crosscut` 阶段。

*   **Phase 3: Crosscut (横切合成)**
    *   读取已生成的模块文章。
    *   打包文本 (`packArticles`)，若超预算则截断。
    *   提交横切任务（架构 `_architecture.md`、模式 `_patterns.md`、概念等）。
    *   同样走后台并发池执行。
    *   落盘至 `.codewiki/` 根目录。
    *   进入 `review` 阶段。

*   **Phase 4: Review (审校)**
    *   本地核对文件一致性。
    *   提交校对任务 (`batchProofreadPrompt`)，修正错误。
    *   落盘更新后的文章。
    *   进入 `index` 阶段。

*   **Phase 5: Index (索引与入口)**
    *   执行 `cw index` 重建索引。
    *   执行 `cw meta update` 更新元数据。
    *   若缺失，调用 `ensureWikiEntry` 自动生成 `CodeWiki.md`。
    *   Job 状态标记为 `done`。

### 3. 前端监控与控制 (Frontend Monitoring)
*   **轮询**: `client-interface` 中的 `CodewikiPanel` 每 2000ms 调用 `GET /api/codewiki/jobs`。
*   **渲染**: 解析 Job 数据，计算总进度权重 (`STAGE_WEIGHTS`)，渲染六阶段步骤条、吞吐量徽标和用量信息。
*   **控制**: 用户可通过 UI 发起取消 (`apiPost(CONTROL_PATH, { action: 'cancel' })`) 或刷新操作。

### 4. 异常与恢复 (Resilience)
*   **宿主重启重跑**: 请求随连接生死，无服务端持久批次。执行器丢失时按 `job.tasks` 持久化的 `batchPrompt` 快照自动重跑当前阶段（幂等：文章重写覆盖）。
*   **孤儿接管**: 若某 Job 长时间无心跳（>5分钟），其他实例可接管其任务。
*   **并发冲突**: 多实例提交同一仓库时，通过磁盘合并 (`mergeFromDisk`) 避免任务丢失。

## Implementation Map

| 功能组件 | 实现位置 | 说明 |
| :--- | :--- | :--- |
| **Job Service 工厂** | `index.js:899-1580` | `createJobService` 函数，包含所有阶段处理器和 Tick 循环逻辑。 |
| **Tick 主循环** | `index.js:1463-1580` | `tick()` 方法，驱动阶段机状态转换。 |
| **阶段处理器** | `index.js:1156-1461` | `tickPlan`(1156), `tickArticles`(1187), `tickCrosscut`(1272), `tickCompose`(1338), `tickReview`(1387), `tickIndex`(1430)。 |
| **阶段执行器** | `index.js:1095-1134` | `startBatchChatRun`，后台并发池打百炼普通入口，结果进 `batchResults` 等收割。 |
| **阶段提交** | `index.js:1136-1154` | `submitBatchFor`（阶段提交入口）。 |
| **阶段结算** | `index.js:1025-1088` | `settleJob`，收割 batchResults；宿主重启按 batchPrompt 快照重跑。 |
| **并发池执行** | `index.js:287-309` | `runRealtimeTasks`，唯一执行器，全部阶段请求走百炼普通入口。 |
| **凭证解析** | `index.js:404-424` | `resolveBatchApiKey`，支持显式配置和宿主凭据库。 |
| **面板后端 API** | `index.js:1872-2046` | `installWebServer`，注册 `/api/codewiki/jobs` 等端点。 |
| **前端面板组件** | `client.js:882-1098` | `CodewikiPanel` React 组件，负责 UI 渲染和轮询。 |
| **API 封装** | `client.js:331-348` | `apiGet` 和 `apiPost` 辅助函数，用于前后端通信。 |
| **轮询间隔常量** | `client.js:22` | `POLL_MS = 2000`，定义前端刷新频率。 |
| **阶段权重定义** | `client.js:684` | `STAGE_WEIGHTS` 对象，定义各阶段在总进度中的占比。 |
| **只读查进度工具** | `index.js:1753-1870` | `progressToolDefinition`，`codewiki_progress` 工具：按 cwd/jobId 过滤 + taskList 完成百分比。 |

行号基线：0c6017f（0.6.0，批量通道删除后；单值=函数/常量起始行，区间=函数体跨度）；后续大改动请重新核对。