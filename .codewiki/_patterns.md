---
title: patterns
type: pattern
source_files:
  - index.js
  - client.js
tags: [patterns, architecture, concurrency, error-handling, token-budget]
---

## Overview

`dsh-codewiki` 模块通过一套标准化的模式确保了代码的可维护性、测试的可靠性以及跨平台兼容性。核心架构分为后端编排（`index.js`）、前端面板（`client.js`）及全链路测试套件。关键模式包括：提交-异步推进的状态机、多层 Token 预算与降级策略、跨平台路径规范化、以及防御性的并发控制与孤儿任务接管机制。

## Key Components

### 后端核心 (`index.js`)

**常量与配置**
*   `CONCURRENCY_HARD_CAP = 8`: 写文章子代理并发上限硬顶，由配置项 `maxConcurrency` 控制，最大值为 8 [[index.js]]。
*   `ACTIVE_STAGES`: 活跃阶段列表 `['plan', 'articles', 'crosscut', 'compose', 'review', 'index']` [[client.js]]。
*   `STAGE_WEIGHTS`: 总进度权重映射 (`plan: 0.05`, `articles: 0.6`, `crosscut: 0.1`, `compose: 0.05`, `review: 0.15`, `index: 0.05`) [[client.js]]。

**公开函数/类**

| 函数名 | 行号范围 | 用途 |
| :--- | :--- | :--- |
| `apply(ctx, config)` | ~2712 | 插件入口，注册工具、服务及 HTTP 端点 [[index.js]]。 |
| `commitHintText(cwd, jobs)` | ~2640 | 检查最近一次成功编译的 `finishedAt` 是否晚于 `.codewiki/` 和 `CodeWiki.md` 的最后 git 提交时间。若是，返回「【CodeWiki 编译完成·请提交改动】」 [[index.js]]。 |
| `wakeCompileSession(job, outcome, agents?)` | ~1146 | 编译终态时，向发起会话发送消息，提醒其提交改动或查看失败原因 [[index.js]]。 |
| `progressView(job)` | ~2326 | 将 Job 状态转换为面板展示的进度视图，计算六阶段加权进度百分比 [[index.js]]。 |
| `renderProgress(job)` | ~2239 | 格式化输出进度信息：`stage=xx NN% + ✓/✗/· 任务明细 + 错误 + 最近 3 条 notes` [[index.js]]。 |
| `progressToolDefinition()` | ~2190 | 定义 `codewiki_progress` 工具，支持 `cwd` 和 `jobId` 过滤 [[index.js]]。 |
| `excludedItem(cwd, list)` | ~224 | 遍历 `excludePaths`，使用 `samePath` 进行归一化匹配，返回命中的条目或 `null` [[index.js]]。 |
| `isExcluded(cwd, list)` | ~234 | `excludedItem(...) !== null` 的布尔包装 [[index.js]]。 |
| `normalizeCwd(cwd)` | ~26 | Windows 路径规范化，将 MSYS 风格路径 `/x/...` 转换为 `X:/...` [[index.js]]。 |
| `ensureWikiEntry(repo, lang)` | ~186 | 缺失时生成中文或英文入口，包含 `.codewiki` 绝对路径和 `codewiki_generate` 指引 [[index.js]]。 |
| `normalizeArticlePath(path)` | ~139 | 将 Windows `\` 转换为 `/`，`undefined` 返回空串 [[index.js]]。 |
| `parseStatus(stdout)` | ~153 | 解析 `cw status` 输出，规范化 `changedFiles` 和 `staleArticles` 中的路径 [[index.js]]。 |
| `normalizeIndexLinks(repo)` | ~143 | 修复 `_index.md` 中双链链接头部的 `\` 为 `/`，幂等操作 [[index.js]]。 |

**数据结构**
*   **Job**: 包含 `sessionId`, `cwd`, `stage`, `stageTimings`, `usage`, `notes`, `batchProgress`, `taskList` 等字段。
*   **BatchProgress**: 包含 `at`, `completed`, `rate` (EWMA 速率用于 ETA 估算) [[client.js]]。
*   **SparkRef**: `Map<jobId, number[]>`，存储最近 30 个 tps 值用于绘制 Sparkline [[client.js]]。

### 前端 UI (`client.js`)

**组件**
*   **`CodewikiCard`**: 设置卡片，依赖 `ctx.configForms.get(NS)` 读写配置 [[client.js]]。
    *   `save()`: 校验 `maxConcurrency` (1-8) 和 `batchThinkingBudget` (0-32768)，使用乐观锁 `snapshot.revision` 防止冲突 [[client.js]]。
*   **`CodewikiPanel`**: 侧边栏面板，每 2s 轮询 `/api/codewiki/jobs` [[client.js]]。
    *   `ReposTab`: 轮询 `/api/codewiki/repos`，展示仓库状态，支持手动触发编译或排除路径 [[client.js]]。
    *   `jobCard`: 渲染单个 Job 详情，包含阶段条、进度条、吞吐徽标、用量信息、活动日志 [[client.js]]。
    *   `stageBar`: 六阶段步骤条，根据 `job.stage` 高亮当前/已完成/失败阶段 [[client.js]]。
    *   `Spark`: SVG 折线图组件，基于 `sparkRef` 数据绘制，仅当有至少 2 个有效 tps 点时绘制 [[client.js]]。

### 测试文件

*   **`test/test-batch.mjs`**: 单元测试脚本，验证纯函数逻辑（token 估算、任务装配、并发池执行、本地规划、横切装填、凭证解析） [[test-batch.mjs]]。
*   **`test/test-cwd-paths.mjs`**: 验证 `cw` 工具在不同操作系统路径格式下的兼容性修复 [[test-cwd-paths.mjs]]。
*   **`test/test-orchestration.mjs`**: 全功能冒烟测试，模拟宿主环境，验证完整生命周期 [[test-orchestration.mjs]]。
*   **`test/test-wiki-anchors.mjs`**: 校验 Wiki 文章中引用的源码行号锚点的真实性 [[test-wiki-anchors.mjs]]。
*   **`test/test-wiki-entry.mjs`**: 测试 `CodeWiki.md` 入口自动生成及 Windows 路径规范化 [[test-wiki-entry.mjs]]。

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                        Host Environment                       │
│  (Cordis Plugin System, Git CLI, File System)                │
└───────────────┬───────────────────────────────┬──────────────┘
                │                               │
                ▼                               ▼
┌─────────────────────────┐       ┌─────────────────────────┐
│      index.js           │       │      client.js          │
│  (Backend / Logic)      │       │  (Frontend / UI)        │
│                         │       │                         │
│  - apply(ctx, config)   │◄─────►│  - CodewikiCard         │
│  - createJobService     │  API  │  - CodewikiPanel        │
│  - tickArticles         │       │                         │
│  - wakeCompileSession   │       │  Polls:                 │
│  - progressView         │       │  GET /jobs (2s)         │
│  - excludedItem         │       │  GET /repos (10s)       │
│  - normalizeCwd         │       │                         │
└───────────────┬─────────┘       └─────────────────────────┘
                │
                ▼
┌─────────────────────────┐
│   LLM Providers         │
│  (DashScope/Bailian)    │
│                         │
│  - runRealtimeTasks     │
│  - localPlan            │
│  - packArticles         │
└─────────────────────────┘
```

## Data Flow

1.  **用户触发**: 用户调用 `codewiki_generate` 或 `cw compile`。
2.  **前置检查**:
    *   `normalizeCwd` 处理 Windows/MSYS 路径差异 [[index.js]]。
    *   `isExcluded` 检查排除清单，若命中则报错并返回命中项原文 [[index.js]]。
    *   `ensureWikiEntry` 确保入口文件存在 [[index.js]]。
3.  **Job 创建与持久化**:
    *   创建 Job 对象，写入 `JOBS_FILE`。
    *   高并发场景下，共享同一 `jobId`，通过 `flush` 合并状态 [[test-orchestration.mjs]]。
4.  **阶段机推进 (Tick Loop)**:
    *   `plan`: 主模型路由。若有 `sessionId` 且 `ctx.llm.stream` 可用，走主模型；否则降级至百炼批量通道 [[test-orchestration.mjs]]。
    *   `articles`: `prepareArticleTasks` 装配 Prompt。若单文件超预算，升档至 200k；若连 200k 都无法装下，标记为 `oversized` 或拆分为观察批 [[test-batch.mjs]]。
    *   `crosscut`: `packArticles` 处理横切输入，若超预算则拆分为观察任务 map + 合成批 reduce [[test-orchestration.mjs]]。
    *   `review`: 审校员校对，标记 `PROOFED` [[test-orchestration.mjs]]。
    *   `index`: 生成 `_index.md`，修复链接路径 [[test-wiki-entry.mjs]]。
5.  **终态处理**:
    *   `onSettled` 回调触发 `wakeCompileSession`，静默跳过无 `sessionId` 或 `steer` 抛错场景 [[index.js]]。
    *   `commitHintText` 比较编译时间与 git 提交时间，决定是否注入提醒 [[index.js]]。
    *   `knownRepos` 登记成功编译的仓库 [[test-orchestration.mjs]]。
6.  **前端反馈**:
    *   `client.js` 轮询 `/api/codewiki/jobs`，获取 `tps`, `stageTimings`, `usage` [[client.js]]。
    *   计算 EWMA 速率估算 ETA，绘制 Sparkline [[client.js]]。

## Connections

*   本模块与 [[core-application]] 紧密相关，后者提供底层工具函数。
*   本模块与 [[test-suite]] 共享测试基础设施和 Mock 逻辑。
*   本模块与 [[configuration-and-metadata]] 通过 `package.json` 和 `cordis.patch.yml` 进行元数据交换。
*   本模块与 [[runtime-artifacts]] 通过日志文件交互，用于调试和分析。

## Known Issues

1.  **`wakeCompileSession` 静默失败**: 如果 `sessionId` 缺失、会话不在注册表或 `steer` 抛错，函数静默跳过，不抛出异常。这是设计使然，避免阻塞主流程 [[index.js]]。
2.  **`commitHintText` 的时间戳派生**: 依赖 `git log` 和 `jobs.json` 的时间戳，而非持久化状态。如果 `git log` 为空或读 `jobs` 失败，则不提醒 [[index.js]]。
3.  **`excludedItem` 的路径归一化**: 使用 `samePath` 进行归一化，确保跨平台兼容性。子目录场景下，父目录的排除项也会命中 [[index.js]]。
4.  **大文件分割的幂等性**: `prepareArticleTasks` 在分割时，如果单文件占满分则落回硬限制大档，确保行为一致性。合成任务的重建依赖于持久化的 `splitFor` 和 `composePlan` 元数据 [[test-orchestration.mjs]]。
5.  **主模型路由降级**: 若 `ctx.llm.stream` 不可用（严格语义未 inject 抛错）或输出非法 JSON，自动降级回百炼批量通道。无 `sessionId` 时跳过主模型，直接走批量 [[test-orchestration.mjs]]。
6.  **Registry 异常防御**: `workspaceRegistry.list()` 抛错时，Jobs/Repos 端点降级为不过滤，保证 API 可用性，而非 500 错误 [[test-orchestration.mjs]]。