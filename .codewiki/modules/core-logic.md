---
title: core-logic
type: module
source_files:
  - index.js
tags: [CodeWiki, CLI, Batch Inference, Job Service, DeepSeek Harness]
---

## Overview

`core-logic` (实现于 `index.js`) 是 dsh-codewiki 插件的核心业务逻辑层。它负责将 Rust CLI 工具 `cw` 封装为两个 DeepSeek Harness 工具：`cw`（薄封装，用于查询/初始化）和 `codewiki_generate`（服务化编译，用于触发后台批量流水线）。该模块管理从源码扫描、规划、文章生成、横切合成、校对到索引更新的完整状态机，并处理与阿里云百炼（DashScope）的批量推理及实时兜底交互。

## Key Components

### 配置与常量

- **Config Schema** (L29-L58): 使用 `@deepseek-ai/schemastery` 定义插件配置项，包括 `enabled`, `binaryPath`, `batchModel`, `batchApiKey`, `batchThinkingBudget`, `batchMinTokens`, `maxConcurrency`, `articleLanguage`, `excludePaths`, `autoUpdate`, `autoUpdateMin`, `workspaceOnly`, `updateReminder` 等。
- **liveConfig()** (L74-L103): 解析并规范化配置，提供默认值和安全边界（如并发硬顶 8）。
- **BATCH_TOKEN_BUDGET** (L186): 批量请求输入 token 预算 (28000)，以适配低价档。
- **BATCH_TOKEN_HARD_LIMIT** (L190): 最大输入 token 限制 (200000)，超此值需走实时兜底。
- **SCAN_SKIP_DIRS / SCAN_SKIP_EXT** (L432-L442): 扫描仓库时排除的目录和文件后缀黑名单。
- **JOBS_FILE / REPOS_FILE** (L452-L453): 持久化任务历史和已知工作区的路径。
- **ORPHAN_TAKEOVER_MS** (L456): 孤儿任务接管阈值 (5分钟)。

### cw CLI 封装

- **resolveBinary()** (L109-L133): 解析 `cw` 可执行文件路径，优先 PATH，其次插件自带 bin。
- **runCw()** (L135-L166): 异步执行 `cw` 子命令，支持超时和信号中断。
- **parseStatus()** (L169-L182): 解析 `cw status` 输出，返回状态 (`missing`, `uncompiled`, `clean`, `stale`) 及变更文件/过期文章列表。
- **ensureWikiEntry()** (L195-L232): 若仓库根缺失 `CodeWiki.md`，自动生成入口文件。
- **isExcluded()** (L235-L245): 检查路径是否在排除清单中。

### Token 估算与实时兜底

- **estimateTokens()** (L252-L260): 粗略估算文本 token 数（CJK 1字=1token，其他 3.5字符=1token）。
- **bailianChat()** (L263-L276): 同步调用百炼 chat/completions API，作为超大任务的实时兜底通道。
- **applyTaskResult()** (L279-L291): 统一处理任务结果，`keepInMemory` 任务返回内存对象，文章任务直接落盘。
- **runRealtimeTasks()** (L294-L318): 并发池执行实时兜底任务，支持 TPS 采样。

### 批量推理 (Batch Inference)

- **collectSources()** (L328-L352): 将源文件内联为 markdown 文本，按 token 预算装填，处理 oversized 情况。
- **batchArticlePrompt()** (L355-L377): 组装单篇模块文章的批量 prompt。
- **buildBatchJsonl()** (L380-L389): 将任务列表转换为 JSONL 格式，供百炼批量接口使用。
- **parseBatchResults()** (L392-L420): 解析百炼批量结果文件，兼容成功与错误行。
- **settleBatch()** (L423-L483): 轮询批次状态，下载结果，处理断点续查，清理状态文件。
- **submitBatch()** (L498-L524): 提交 JSONL 文件至百炼，创建批次任务，保存断点状态。
- **prepareArticleTasks()** (L532-L553): 预处理文章任务，处理 oversized 文件，分配 customId。
- **resolveBatchApiKey()** (L506-L530): 解析百炼 API Key，支持显式配置或宿主凭据库注入。

### Prompt 模板

- **articleFormatSection()** (L534-L557): 定义文章输出的严格 Markdown 格式和约束。
- **batchPlannerPrompt()** (L560-L582): 规划阶段 prompt，要求输出 JSON 模块分组。
- **localPlan()** (L585-L596): 本地兜底规划，按顶层目录分组。
- **packArticles()** (L599-L618): 打包多篇文章文本，处理预算截断。
- **crosscutIntro()** (L621-L633): 横切文章通用 prompt 头。
- **batchArchitecturePrompt()** (L636-L642): 系统总览 `_architecture.md` prompt。
- **batchPatternsPrompt()** (L645-L651): 模式总结 `_patterns.md` prompt。
- **batchConceptPrompt()** (L654-L662): 跨模块概念专文 prompt。
- **batchObservePrompt()** (L665-L682): 模块观察 prompt，用于横切拆分场景。
- **batchProofreadPrompt()** (L685-L707): 校对 prompt，核对文章与源码一致性。

### 编排服务 (Job Service)

- **createJobService()** (L712-L950): 核心工厂函数，创建任务管理服务实例。
  - **scanRepoFiles()** (L445-L470): 递归扫描仓库源码文件，应用黑名单和大小限制。
  - **acquireTickLock() / releaseTickLock()** (L483-L496): 跨进程 tick 锁，防止双实例冲突。
  - **loadJobs() / saveJobs()** (L473-L480): 持久化任务历史，保留最近 30 个任务。
  - **mergeFromDisk() / flush()** (L745-L762): 合并磁盘状态与内存状态，处理脏标记。
  - **tick()** (L835-L883): 主循环，每 TICK_MS 执行一次，推进所有活跃 job 的阶段。
  - **submit()** (L786-L833): 提交新任务，处理幂等性、孤儿断点续查、凭证解析。
  - **cancel()** (L835-L844): 取消任务。
  - **list() / findActive()** (L846-L848): 查询任务列表和活跃任务。
  - **Stage Handlers**: `tickPlan`, `tickArticles`, `tickCrosscut`, `tickCompose`, `tickReview`, `tickIndex` 分别对应各阶段的推进逻辑。
    - **tickPlan**: 扫描文件，提交规划任务，解析 JSON 计划。
    - **tickArticles**: 根据计划或预构建任务，提交文章生成任务，处理 oversized 实时兜底。
    - **tickCrosscut**: 基于模块文章，提交横切（架构/模式/概念）任务，支持拆分合成。
    - **tickReview**: 本地核对 + 批量校对任务。
    - **tickIndex**: 运行 `cw index` 和 `cw meta update`，生成入口文件。

### 工具定义

- **cwToolDefinition()** (L710-L760): 定义 `cw` 工具，封装 CLI 调用。
- **generateToolDefinition()** (L953-L1033): 定义 `codewiki_generate` 工具，判态后提交后台任务。

### 面板后端

- **installWebServer()** (L1036-L1153): 注册 `/api/codewiki/jobs`, `/api/codewiki/repos`, `/api/codewiki/control` 端点，仅允许回环访问。
- **isLoopbackRequest()** (L1039-L1042): 检查是否为回环请求。
- **writeJson() / readBodyJson()** (L1044-L1063): JSON 响应辅助函数。

### 插件入口

- **apply()** (L1163-L1225): 插件加载入口，初始化服务，注册工具，启动自动更新调度器，安装会话提醒。
- **reminderText()** (L1156-L1162): 生成 CodeWiki 维护提醒文本。
- **installUpdateReminder()** (L1165-L1196): 在会话系统提示中注入维护提醒。
- **autoScan()** (L1206-L1225): 自动更新调度器，定期扫描已编译工作区并提交增量编译。

## Architecture

```text
┌─────────────────────┐       ┌──────────────────────────┐       ┌─────────────────────┐
│   DeepSeek Harness   │       │      core-logic          │       │  Alibaba Bailian     │
│                      │       │                          │       │  (DashScope)         │
│  - Tools: cw         │◄─────►│  - Job Service           │──────►│  - Batch File        │
│  - Tools:            │       │    (createJobService)    │       │  - Chat Completions  │
│    codewiki_generate │       │    - Tick Loop           │       │  (Realtime Fallback) │
│                      │       │    - Stage Machine       │       │                      │
│  - Web Server        │       │    - Persistence         │       │                      │
│    (Loopback Only)   │       │                          │       │                      │
└─────────────────────┘       └──────────┬───────────────┘       └─────────────────────┘
                                        │
                                        ▼
                               ┌──────────────────────┐
                               │      Rust CLI cw     │
                               │                      │
                               │  - init/status/index │
                               │  - meta/path/projects│
                               └──────────────────────┘
```

## Data Flow

1. **Trigger**: 用户调用 `codewiki_generate` 或自动调度器触发。
2. **Status Check**: 执行 `cw status` 判断仓库状态 (missing/uncompiled/clean/stale)。
3. **Job Submission**:
   - 若已有活跃任务，返回现有任务 ID。
   - 若有孤儿断点，续查恢复。
   - 否则，创建新 Job，解析凭证，进入第一阶段 (`plan` 或 `articles`)。
4. **Pipeline Execution (Tick Loop)**:
   - **Plan**: 扫描源码 → 提交规划任务 → 解析 JSON 计划 → 进入 Articles。
   - **Articles**: 根据计划/预构建任务 → 收集源码 → 提交文章生成任务 (批量/实时) → 落盘 → 进入 Crosscut。
   - **Crosscut**: 读取成功文章 → 打包文本 → 提交横切任务 (架构/模式/概念) → 落盘 → 进入 Review。
   - **Review**: 本地核对 → 提交校对任务 → 落盘 → 进入 Index。
   - **Index**: 执行 `cw index` 和 `cw meta update` → 生成入口文件 → 标记 Done。
5. **Persistence**: Job 状态、批次数、进度等信息定期持久化到 `JOBS_FILE` 和 `REPOS_FILE`。
6. **Cancellation**: 通过控制面板或 API 取消任务，设置 `cancelRequested` 标志，Tick 循环检测到后终止。

## Connections

- [[tools]]: `cw` 和 `codewiki_generate` 工具的定义和使用。
- [[web-server]]: 面板后端 API 的实现。
- [[auto-update]]: 自动更新调度器的逻辑。

## Known Issues

- **Token 估算误差**: `estimateTokens` 为粗略估算，可能导致少量任务超出预期档位，但通过 `BATCH_TOKEN_HARD_LIMIT` 和实时兜底机制缓解。
- **跨进程冲突**: 依赖文件锁 (`JOBS_LOCK_FILE`) 防止多实例同时推进同一 Job，崩溃残留锁有 60s 超时清理机制。
- **凭证解析延迟**: `resolveBatchApiKey` 可能等待宿主凭据库就绪，最长等待 3s，期间 Job 处于 `submitting` 状态。
- **孤儿任务接管**: 另一实例停更超过 5 分钟后，本实例会接管其任务，需确保实例间时钟同步。