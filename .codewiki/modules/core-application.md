---
title: core-application
type: module
source_files:
  - index.js
  - client.js
tags: [CodeWiki, CLI, Pipeline, React, DeepSeek Harness]
---

## Overview

`core-application` 模块是 CodeWiki 项目的核心业务逻辑入口与客户端实现。它由两个主要文件组成：`index.js` 负责后端/宿主侧的逻辑，包括 CodeWiki CLI (`cw`) 的封装、阿里云百炼（DashScope）普通入口编译流水线的编排、以及提供 Web API 接口；`client.js` 负责浏览器端的 UI 实现，提供设置表单和侧边栏面板以监控编译任务进度。该模块实现了“提交-异步推进”的模式，用户调用 `codewiki_generate` 后，后台服务自动规划、写文章、横切、审校并建立索引，全程无需子代理干预。

## Key Components

### index.js (Host Side Logic)

**常量与配置**
- `Config`: 行 37-56，使用 `@deepseek-ai/schemastery` 定义的插件配置对象，包含 `enabled`, `binaryPath`, `batchModel`, `maxConcurrency`, `excludePaths` 等字段。
- `liveConfig()`: 行 68-92，解析配置对象，应用默认值并验证范围（如并发上限硬顶为 8）。
- `CONCURRENCY_HARD_CAP`: 行 21，编译请求并发上限，值为 8。
- `BATCH_TOKEN_BUDGET`: 行 207，单请求输入 token 预算，28000。
- `BATCH_TOKEN_HARD_LIMIT`: 行 211，超大任务兜底预算，200000。
- `JOBS_FILE`: 行 268，持久化 Job 状态的文件路径。
- `SCAN_SKIP_DIRS` / `SCAN_SKIP_EXT`: 行 286-299，源码扫描时跳过的目录和文件后缀黑名单。

**工具定义**
- `cwToolDefinition(cfg)`: 行 436-488，定义 `cw` 工具，用于运行本地 CodeWiki CLI 子命令（init/status/index/meta/path/projects/setup/uninstall）。
- `generateToolDefinition(cfg, svc)`: 行 736-836，定义 `codewiki_generate` 工具，触发编译流水线。
- `progressToolDefinition(cfg, svc)`: 行 842-906，定义 `codewiki_progress` 工具，只读查询编译进度。

**核心服务**
- `createJobService(config)`: 行 273-733，工厂函数，创建编译任务管理服务实例。返回 `{ submit, cancel, list, findActive, start, stop }`。
  - `submit(...)`: 行 656-704，提交新编译任务。判态（status），确定 scope（full/stale/auto），预构建任务或标记为 full，分配凭证，启动 tick 循环。
  - `cancel(jobId)`: 行 706-716，取消指定任务。
  - `list()`: 行 718，列出所有任务摘要。
  - `findActive(cwd)`: 行 719，查找指定仓库的活动任务。
  - `start()` / `stop()`: 行 721-726，控制后台 tick 定时器。
  - `tick()`: 行 578-654，每轮执行的核心循环。获取锁，同步取消标志，遍历非终态 job，根据当前 stage 调用对应的 handler（tickPlan, tickArticles, tickCrosscut, tickCompose, tickReview, tickIndex）。处理孤儿接管（orphan takeover）。

**阶段处理器**
- `tickPlan(job)`: 行 526-553，规划阶段。扫描仓库文件，生成 JSON 计划，提交编译请求。
- `tickArticles(job)`: 行 555-609，文章撰写阶段。组装源文件内联文本，构建 prompt，提交编译请求。处理 oversized 任务的兜底逻辑。
- `tickCrosscut(job)`: 行 611-652，横切阶段。合成系统总览、模式总结、概念文章。支持拆分观察批再合成。
- `tickCompose(job)`: 行 654-662，合成收尾阶段。处理观察批结果后的合成提交。
- `tickReview(job)`: 行 664-702，校对阶段。本地核对 frontmatter 和 source_files 存在性，提交编译校对请求。
- `tickIndex(job)`: 行 704-722，索引阶段。运行 `cw index` 和 `meta update`，确保入口文件存在。

**辅助函数**
- `resolveBinary(cfg)`: 行 100-126，解析 cw 可执行文件路径（优先 PATH，其次 bundled）。
- `runCw(binary, cwd, args, timeoutMs, signal)`: 行 128-156，异步执行 cw 进程，支持超时和信号中断。
- `parseStatus(stdout)`: 行 176-193，解析 cw status 输出，返回 { state, changedFiles, staleArticles }。
- `scanRepoFiles(cwd)`: 行 281-312，递归扫描仓库源码文件，过滤黑名单。
- `collectSources(cwd, files, budget)`: 行 213-238，将源文件内联为 markdown 文本，按 token 预算装填。
- `prepareArticleTasks(tasks, { cwd, language })`: 行 254-270，装配文章任务，处理 oversized 情况。
- `runRealtimeTasks(tasks, config)`: 行 195-211，后台并发池执行编译请求（统一走百炼普通入口）。
- `applyTaskResult(task, content, notes)`: 行 183-193，应用任务结果，落盘或保留内存。
- `writeValidated(job, task, content)`: 行 453-466，校验并写入 keepInMemory 任务的结果（需含 frontmatter）。
- `tally(job, results, tasks)`: 行 468-488，结果记账，更新 job.articles 计数。
- `ensureWikiEntry(cwd, language)`: 行 195-233，若缺失则自动生成仓库根 CodeWiki.md 入口文件。
- `normalizeArticlePath(p)`: 行 173-174，规范化路径分隔符。
- `estimateTokens(text)`: 行 160-171，粗略估算 token 数。
- `localPlan(files)`: 行 336-346，本地规划兜底，按顶层目录分组。
- `readSourceFiles(articlePath)`: 行 356-378，读取文章 frontmatter 中的 source_files。
- `wikiPathFor(cwd, binary, signal)`: 行 380-386，获取 wiki 目录路径。
- `installWebServer(ctx, service, extra)`: 行 908-1036，安装回环地址的 Web API 端点（/api/codewiki/jobs, /repos, /control）。
- `installUpdateReminder(ctx, config)`: 行 1038-1066，注入会话系统提示中的 wiki 维护提醒。
- `apply(ctx, config)`: 行 1068-1116，插件入口。初始化服务，注册工具，安装 Web Server 和提醒。

### client.js (Browser Side UI)

**组件**
- `CodewikiCard(props)`: 行 136-236，设置卡片组件。渲染开关、输入框，管理草稿状态，处理保存/放弃操作。
- `CodewikiPanel()`: 行 336-506，侧边栏主面板。包含 Tabs（Overview, Jobs, Settings）。轮询 `/api/codewiki/jobs` 获取任务列表，展示进度条、阶段步骤条、吞吐徽标、日志等。
- `ReposTab()`: 行 238-334，总览标签页。轮询 `/api/codewiki/repos`，展示各工作区状态、排除按钮、编译按钮。
- `PanelIcon(props)`: 行 508-518，侧边栏图标组件。
- `Spark({ values, width, height })`: 行 276-296，SVG 绘制的吞吐趋势微图表。
- `stageBar(job)`: 行 298-334，六阶段步骤条可视化。
- `throughputBadge(job, sparkOf, rateOf)`: 行 336-356，显示实时吞吐或批次 ETA 的徽标。
- `usageLine(job)`: 行 358-376，显示 Token 用量统计。

**样式与字典**
- `zh()` / `en()`: 行 26-134，中英文词典定义。
- `style`: 行 136-236，CSS 样式字符串，通过 `<style>` 标签注入 DOM。

**API 交互**
- `apiGet(p)`: 行 238-242，封装 GET 请求。
- `apiPost(p, data)`: 行 243-251，封装 POST 请求。

## Architecture

```text
┌─────────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│   Browser Client    │       │   Host/Plugin Core   │       │   External Services │
│   (client.js)       │       │   (index.js)         │       │                     │
│                     │       │                      │       │                     │
│  CodewikiPanel      │◄────►│   createJobService   │──────►│   DashScope API     │
│  ReposTab           │       │   (Tick Loop)        │       │   (chat/completions)│
│  CodewikiCard       │       │                      │       │                     │
│                     │       │  submit/cancel/list  │       │   Local cw Binary   │
│  Polls:             │       │                      │       │   (CLI wrapper)     │
│  - /api/codewiki/   │       │  Stage Handlers:     │       │                     │
│    jobs             │       │  - plan              │       │                     │
│  - /api/codewiki/   │       │  - articles          │       │                     │
│    repos            │       │  - crosscut          │       │                     │
│                     │       │  - review            │       │                     │
│                     │       │  - index             │       │                     │
│                     │       │                      │       │                     │
│                     │       │  Persistence:        │       │                     │
│                     │       │  - JOBS_FILE         │       │                     │
│                     │       │  - REPOS_FILE        │       │                     │
└─────────────────────┘       └──────────────────────┘       └─────────────────────┘
```

数据流：
1. **Client**: 通过 React 组件渲染 UI，定时轮询 `GET /api/codewiki/jobs` 和 `GET /api/codewiki/repos`。用户操作（如取消、编译、修改设置）通过 `POST /api/codewiki/control` 或 `configForms` 发送。
2. **Host**: `index.js` 暴露 Web API 端点供 Client 访问。核心是 `createJobService`，它维护一个基于文件的 Job 状态机。`tick()` 函数定期执行，推动 Job 从 `plan` -> `articles` -> `crosscut` -> `review` -> `index` -> `done`。
3. **External**: 编译过程涉及调用本地 `cw` 二进制文件进行状态检查和索引构建，以及调用阿里云百炼 API 进行大模型文本生成（规划、写文章、横切、校对）。

## Data Flow

1. **初始化**: `apply()` 被调用，创建 `JobService` 实例，启动 `tick()` 定时器，注册三个工具（`cw`, `codewiki_generate`, `codewiki_progress`），安装 Web Server 和系统提示提醒。
2. **提交编译**: 用户或自动化流程调用 `codewiki_generate`。
   - 执行 `cw status` 判断仓库状态（missing/uncompiled/stale/clean）。
   - 根据 scope（auto/full/stale）决定是全量重编还是增量更新。
   - 创建 Job 对象，存入内存和磁盘文件（`JOBS_FILE`）。
   - 解析 API Key，进入对应阶段（plan 或 articles）。
3. **后台推进 (Tick)**:
   - 获取分布式锁（防止多实例冲突）。
   - 检查是否有其他实例的任务需要接管（孤儿检测）。
   - 遍历非终态 Job，调用对应阶段的 Handler。
   - **Plan**: 扫描文件，生成 JSON 结构，提交 LLM 请求（百炼普通入口）。
   - **Articles**: 收集源文件内容，拼接 Prompt，提交 LLM 请求。支持超大文件升档兜底策略。
   - **Crosscut**: 汇总已生成的文章，生成架构、模式、概念文档。若内容过大，先拆分为“观察”任务，再合成。
   - **Review**: 本地校验 + LLM 校对，修正文章一致性。
   - **Index**: 运行 `cw index` 和 `meta update`，生成入口文件。
4. **结果反馈**: Job 状态更新后，Client 轮询到最新数据，刷新 UI 上的进度条、步骤条和日志。
5. **取消**: 用户点击取消，Host 设置 `cancelRequested=true`，并在下一个 tick 中断正在进行的 LLM 请求（AbortController），标记 Job 为 cancelled。

## Connections

- 依赖 `@deepseek-ai/schemastery` 用于配置验证。
- 依赖 `node:fs`, `node:path`, `node:child_process` 等 Node.js 内置模块。
- 与 `dsh-hindsight-on-demand` 类似，通过 `sidebar.panellist` 和 `main` slot 集成到宿主界面。
- 通过 `configForms` 与宿主的配置系统交互。
- 调用外部服务：阿里云百炼 DashScope API。
- 调用本地工具：`cw` CLI。

## Known Issues

- **Token 估算误差**: `estimateTokens` 使用简单规则（CJK 1 token/字，ASCII 3.5 chars/token），可能与实际分词器有偏差，导致预算溢出或浪费。代码中预留了 ~4k 余量并提供了超大档兜底机制。
- **并发竞争**: 虽然使用了文件锁（`JOBS_LOCK_FILE`），但在极端情况下（如进程崩溃残留锁），可能存在短暂的竞态条件。锁有过期机制（60s）。
- **Windows 路径兼容**: `normalizeCwd` 尝试处理 MSYS/Git-Bash 的路径格式，但复杂场景下可能仍有遗漏。
- **凭证解析延迟**: `resolveBatchApiKey` 在首次提交时可能需要等待凭据库就绪（最长 3s），期间会阻塞 Job 创建。
- **UI 白屏风险**: `client.js` 中的异常捕获仅覆盖部分渲染逻辑，若 CSS 或核心依赖加载失败可能导致面板空白。