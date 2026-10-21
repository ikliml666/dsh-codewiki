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

## Key Components

### 1. Job Service & Stage Machine (`index.js`)
负责管理编译任务的整个生命周期，包括创建、状态推进、结果结算和持久化。

*   **`createJobService(config, onSettled)`** (行 1159-2096): 工厂函数，返回包含 `submit`, `cancel`, `list`, `findActive`, `start`, `stop` 方法的对象。内部维护 `jobs` 数组、`batchRuns`/`batchResults`/`batchAborters` 映射表以及锁机制。
*   **`tick()`** (行 1974-2018): 主循环逻辑。每 `TICK_MS` (默认 10s) 执行一次。负责获取锁、同步取消标志、遍历活跃 Job 并调用对应的 `STAGE_HANDLER`。处理孤儿接管（Orphan Takeover）和脏标记合并（Dirty Merge）。
*   **`STAGE_HANDLER`** (行 1965-1972): 阶段处理器映射表，将阶段名映射到具体的处理函数：
    *   `plan`: `tickPlan` (行 1526-1569)
    *   `articles`: `tickArticles` (行 1626-1736)
    *   `crosscut`: `tickCrosscut` (行 1760-1823)
    *   `compose`: `tickCompose` (行 1826-1838)
    *   `review`: `tickReview` (行 1875-1938)
    *   `index`: `tickIndex` (行 1940-1963)
*   **`settleJob(job)`** (行 1287-1308): 阶段收割统一入口。检查 `batchResults` 是否有结果；若执行器丢失（宿主重启），则根据持久化的 `job.tasks` 中的 `batchPrompt` 快照自动重跑当前阶段。
*   **`startBatchChatRun(job, prepared)`** (行 1360-1399): 启动后台并发池执行批量请求。使用 `runRealtimeTasks` 打百炼普通入口，结果存入 `batchResults`，更新 `batchProgress` 和 TPS 采样。
*   **`submitBatchFor(job, prepared)`** (行 1401-1421): 阶段提交入口。计算用量，设置 `batchRef` 和 `tasks` 快照，调用 `startBatchChatRun`。
*   **`localReview(job)`** (行 1853-1873): 本地核对。检查 frontmatter 必填字段及 source_files 存在性。

### 2. Token Budgeting & Source Collection (`index.js`)
负责将源码内容装入 LLM 请求，严格控制 Token 预算以优化成本。

*   **`estimateTokens(text)`** (行 245-253): 粗略估算 Token 数。CJK 字符 ≈ 1 token，其余 ≈ 3.5 字符/token。
*   **`collectSources(cwd, files, budget)`** (行 445-472): 同步收集源文件。按 `BATCH_TOKEN_BUDGET` (28k) 装填，超出则跳过或升档至 `BATCH_TOKEN_HARD_LIMIT` (200k)。返回 `{ text, skipped, oversized }`。
*   **`prepareArticleTasks(tasks, { cwd, language })`** (行 545-603): 装配文章任务。处理分割逻辑：若单请求预算不足，拆分为多个观察批（_split/ 任务），后续再合成。
*   **`packArticles(articles, budget)`** (行 681-700): 横切输入装配。将多篇模块文章打包，超预算时截断头部。

### 3. Prompt Templates (`index.js`)
定义各阶段的系统提示词，确保模型输出格式一致。

*   **`batchPlannerPrompt(fileLines)`** (行 642-661): 规划 prompt，要求输出 JSON 模块分组。
*   **`batchArticlePrompt(...)`** (行 476-503): 文章生成 prompt，包含 `articleFormatSection`。
*   **`batchArchitecturePrompt(...)`** (行 716-722): 架构总览 prompt。
*   **`batchProofreadPrompt(...)`** (行 815-834): 校对 prompt，要求核对源码一致性。
*   **`articleFormatSection()`** (行 609-638): 文章格式规范，强制要求 frontmatter 和特定章节结构。

### 4. Web Server & API (`index.js`)
提供后端 API 供前端面板查询和控制。

*   **`installWebServer(ctx, service, extra)`** (行 2451-2625): 注册回环地址 API 端点。
    *   `GET /api/codewiki/jobs`: 返回所有 Job 摘要 (`jobSummary`)，支持工作区过滤。
    *   `POST /api/codewiki/control`: 处理 `cancel`, `refresh`, `compile` 动作。
    *   `GET /api/codewiki/repos`: 返回已编译仓库的状态总览，含自动调度信息。

### 5. Frontend Panel (`client.js`)
浏览器侧 React 组件，负责 UI 渲染和数据交互。

*   **`CodewikiPanel`** (行 882-1098): 主面板组件。包含“总览”、“任务”、“设置”三个标签页。
    *   **轮询逻辑**: `React.useEffect` 中每 `POLL_MS` (2000ms) 调用 `apiGet(JOBS_PATH)`。
    *   **状态解析**: 计算整体进度 (`overallPct`)，基于 `STAGE_WEIGHTS`。
    *   **渲染**: 步骤条 (`stageBar`)、吞吐量徽标 (`throughputBadge`)、任务列表、错误提示。
*   **`ReposTab`** (行 737-880): 总览标签页组件。展示仓库列表、排除状态、自动调度器状态。
*   **`CodewikiCard`** (行 390-598): 设置表单组件。读写 `configForms`，支持保存/放弃更改。
*   **`apiGet` / `apiPost`** (行 331-346): 封装 Fetch 请求，处理 JSON 响应和错误。

## Architecture

```text
┌─────────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│  Trigger (Tool/     │       │  Core Logic           │       │  Persistence        │
│  AutoScan)          │──────▶│  createJobService     │──────▶│  JOBS_FILE          │
│                     │       │  - tick()             │       │  REPOS_FILE         │
│  codewiki_generate  │       │  - STAGE_HANDLER      │       │  Lock File          │
│  codewiki_update    │       │  - submitBatchFor     │       └─────────────────────┘
│                     │       │  - settleJob          │                 │
└─────────────────────┘       │  - runMainModelPlan   │       ┌─────────────────────┐
                              └──────────────────────┘       │  Bailian Endpoint   │
                              │                             │  (dashscope)        │
                              │  startBatchChatRun          │  chat/completions   │
                              ▼                             └─────────────────────┘
┌─────────────────────┐       ┌──────────────────────┐
│  Frontend Panel     │◀──────│  Web Server API     │
│  (client.js)        │       │  installWebServer   │
│  CodewikiPanel      │       │  - GET /jobs        │
│  ReposTab           │       │  - POST /control    │
│  CodewikiCard       │       └──────────────────────┘
└─────────────────────┘
```

## Data Flow

1.  **Submission**:
    *   User calls `codewiki_generate`.
    *   `generateToolDefinition.execute` checks `cw status`.
    *   If valid, creates a new Job in `createJobService.submit`.
    *   Job is persisted to `JOBS_FILE` with initial stage (`plan` or `articles`).

2.  **Processing (Tick Loop)**:
    *   `tick()` acquires lock and iterates active Jobs.
    *   For each stage (e.g., `plan`), the corresponding handler (e.g., `tickPlan`) is called.
    *   Handler prepares tasks (prompts + sources).
    *   `submitBatchFor` starts `startBatchChatRun`.
    *   `runRealtimeTasks` executes requests against Bailian API concurrently.
    *   Results are stored in `batchResults`.

3.  **Settlement**:
    *   Next `tick()`, `settleJob` retrieves results from `batchResults`.
    *   Results are tallied (`tally`) and written to disk if valid.
    *   Job stage advances to the next phase.
    *   If execution fails (e.g., host restart), `settleJob` detects missing results and retries using saved `batchPrompt` snapshots.

4.  **Completion**:
    *   Final stage `index` runs `cw index` and `cw meta update`.
    *   Ensures `CodeWiki.md` entry exists.
    *   Job marked as `done`.
    *   Session wake-up message sent via `wakeCompileSession`.

## Connections

*   Relies on [[cw-cli-wrapper]] for local repository status checks and index management.
*   Integrates with [[credential-resolver]] for secure API key retrieval.
*   Provides data to [[panel-ui]] for real-time visualization.

## Known Issues

*   **Token Estimation**: `estimateTokens` is approximate; actual usage may vary slightly, potentially causing minor overages in strict tiers.
*   **Host Restart Recovery**: While automatic retry exists, it relies on the persistence of `batchPrompt` in the job file. If the file is corrupted or manually edited, recovery may fail.
*   **Concurrency Limits**: Hard cap of 8 concurrent requests per instance. High load may lead to queuing delays.
*   **Large Files**: Files exceeding 200k tokens are dropped or handled via fallback mechanisms that may not preserve full context.