---
title: wiki-generation-flow
type: concept
source_files:
  - index.js
  - client.js
tags: [wiki-generation, job-service, batch-inference, pipeline, observability]
---

## Overview

`wiki-generation-flow` 描述了 CodeWiki 插件从触发编译到最终生成完整文档仓库的端到端自动化流程。该概念核心在于 `index.js` 模块中的 `createJobService` 所驱动的阶段机（Stage Machine），它将复杂的文档生成任务分解为规划、文章生成、横切合成、审校和索引五个主要阶段，并通过阿里云百炼批量推理与实时兜底相结合的策略处理大并发任务。整个流程由后台 Tick 循环异步推进，前端通过 `client.js` 提供的 API 进行状态轮询和可视化监控。

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
    *   若存在孤儿断点（Orphan Checkpoint），尝试接管并恢复。
    *   否则，创建新 Job，解析凭证（`resolveBatchApiKey`），初始状态设为 `plan` 或 `articles`，并持久化至 `JOBS_FILE`。

### 2. 阶段机推进 (Pipeline Execution)
后台 `tick()` 循环每 10 秒（`TICK_MS`）检查所有活跃 Job 的状态并推进：

*   **Phase 1: Plan (规划)**
    *   扫描源码文件 (`scanRepoFiles`)，应用黑名单。
    *   提交本地规划任务，解析 JSON 计划，确定模块分组。
    *   进入 `articles` 阶段。

*   **Phase 2: Articles (文章生成)**
    *   根据计划收集源文件内容 (`collectSources`)。
    *   **Token 预算检查**: 估算 Token 数，若超过 `BATCH_TOKEN_HARD_LIMIT` (200k)，转入实时兜底；否则构建 JSONL。
    *   **批量推理**: 调用 `submitBatch` 上传至百炼，保存断点 (`os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`)。
    *   **实时兜底**: 若超大或批量失败，使用 `runRealtimeTasks` 并发池调用 `bailianChat`。
    *   **落盘**: 结果解析后写入 `.codewiki/modules/`。
    *   进入 `crosscut` 阶段。

*   **Phase 3: Crosscut (横切合成)**
    *   读取已生成的模块文章。
    *   打包文本 (`packArticles`)，若超预算则截断。
    *   提交横切任务（架构 `_architecture.md`、模式 `_patterns.md`、概念等）。
    *   同样采用批量/实时混合策略。
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

### 4. 异常与断点 (Resilience)
*   **断点续查**: 批量任务中途失败时，保留断点文件。下次 Tick 检测到断点，重新加载状态并继续后续阶段。
*   **孤儿接管**: 若某 Job 长时间无心跳（>5分钟），其他实例可接管其任务。
*   **并发冲突**: 多实例提交同一仓库时，通过磁盘合并 (`mergeFromDisk`) 避免任务丢失。

## Implementation Map

| 功能组件 | 实现位置 | 说明 |
| :--- | :--- | :--- |
| **Job Service 工厂** | `index.js:1042-1737` | `createJobService` 函数，包含所有阶段处理器和 Tick 循环逻辑。 |
| **Tick 主循环** | `index.js:1612-1651` | `tick()` 方法，驱动阶段机状态转换。 |
| **阶段处理器** | `index.js:1305-1610` | `tickPlan`(1305), `tickArticles`(1336), `tickCrosscut`(1421), `tickCompose`(1487), `tickReview`(1536), `tickIndex`(1579)。 |
| **批量提交** | `index.js:563-588` | `submitBatch`，处理 JSONL 构建和百炼 API 调用。 |
| **批量结算** | `index.js:448-499` | `settleBatch`，处理断点续查和结果落盘。 |
| **实时兜底** | `index.js:284-305` | `runRealtimeTasks`，处理超大任务的并发聊天请求。 |
| **凭证解析** | `index.js:517-537` | `resolveBatchApiKey`，支持显式配置和宿主凭据库。 |
| **面板后端 API** | `index.js:1937-2111` | `installWebServer`，注册 `/api/codewiki/jobs` 等端点。 |
| **前端面板组件** | `client.js:918-1133` | `CodewikiPanel` React 组件，负责 UI 渲染和轮询。 |
| **API 封装** | `client.js:343-355` | `apiGet` 和 `apiPost` 辅助函数，用于前后端通信。 |
| **轮询间隔常量** | `client.js:22` | `POLL_MS = 2000`，定义前端刷新频率。 |
| **阶段权重定义** | `client.js:720` | `STAGE_WEIGHTS` 对象，定义各阶段在总进度中的占比。 |

行号基线：main `7a61424`（单值=函数/常量起始行，区间=函数体跨度）；后续大改动请重新核对。