---
title: documentation
type: module
source_files: []
tags: [documentation, changelog, wiki, static-assets, compile-manager, job-store, progress-service]
---

## Overview

`documentation` 模块负责维护 `@local/dsh-codewiki` 插件的静态文档资源及编译任务的核心调度逻辑。核心文件包括变更日志（`CHANGELOG.md`）、项目 Wiki 入口（`CodeWiki.md`）以及实现异步 Job 生命周期的关键组件（`compile-manager.js`, `job-store.js`, `progress-service.js`）。这些文件共同构成了插件的元数据层与执行引擎，记录了从 v0.1.0 到 v0.8.8 的完整演进历史、架构设计、安装指南及工具行为规范。

该模块不仅作为人类阅读的项目文档，其内容还通过 `codewiki_generate` 工具被编译为 `<repo>/.codewiki/` 下的结构化文章，供智能体在会话中检索和使用。特别是 `CodeWiki.md`，它定义了插件自身的代码库结构，是“自举”编译的起点。当前版本已修复行号系统性幻觉问题（v0.8.7-0.8.8），确保锚点精确指向源码；同时引入了基于子代理（Sub-agent）的异步编译管道，实现了可追踪、可中断、可重试的任务管理。

## Key Components

### CHANGELOG.md
位于仓库根目录，记录所有版本变更。格式遵循 Keep a Changelog 风格，按版本号倒序排列。最新稳定版为 **v0.8.8**。

- **v0.8.8 (2026-10-20)**：新增 `fixAnchors(content, cwd)` [index.js]。文章落盘前机械校正 `file:NN(-MM)` 锚点。逻辑：对照 `source_files`，起点行需含反引号符号；唯一匹配则修正，多声明取形态行，歧义/未找到则不动并记 `notes`。集成于 `applyTaskResult` 与 `writeValidated` 两个写盘出口。
- **v0.8.7 (2026-10-19)**：新增 `numberLines()` [index.js:367]。为 `collectSources` 内联源码添加 `N| ` 前缀，解决弱模型自行数行导致的偏移。剥离 CRLF `\r`。测试证实对 qwen3.7-flash 仍不充分，需兜底修正。
- **v0.8.6 (2026-10-18)**：修复规划阶段主模型继承失败。引入模块级 `llmRef`，通过 `ctx.inject(['llm'])` 注入。路由解析改为优先 `session.requestHeader()?.config`。
- **v0.8.5 (2026-10-18)**：适配 DSH 0.2.1-rc.2 宿主协议。`source.kind` 改为 `'plugin:codewiki'`。补全 `engines.dsh` 声明。
- **v0.8.4 (2026-10-15)**：文章阶段超预算分割。新增 `batchArticleObservePrompt` 与 `batchArticleComposePrompt`。当源码超 28k token 或存在溢出文件时，拆分为多个观察任务 (`#obs{i}`) 和合成任务 (`c`)。`tickArticles` 实现两段状态机收割。
- **v0.8.3 (2026-10-15)**：规划阶段改走主模型。新增 `runMainModelPlan`，取发起会话 agent 的主模型执行规划，不可用时降级百炼批量。
- **v0.8.2 (2026-10-15)**：修复工具注册回滚。`progress` schema `type` 数组改为 `oneOf` 对象。增加 per-definition try/catch 防御。
- **v0.8.1 (2026-10-14)**：增强排除清单报错信息。工具拒绝编译时返回命中的具体排除项原文，帮助模型定位问题。
- **v0.8.0 (2026-10-14)**：实现编译终态实时唤醒。新增 `wakeCompileSession`，利用 DSH Agent inbox 机制向发起会话发送 steer 消息，提醒模型提交改动。依赖 `@deepseek-ai/dsh-llm`。
- **v0.7.0 (2026-10-14)**：新增 `codewiki_update` 工具和编译完成提交提醒。`updateReminder` 系统提示兼职注入完成提醒，基于 git 提交时间戳判断是否需要提醒。
- **v0.6.0 (2026-10-13)**：删除百炼批量推理专用通道。统一走百炼普通入口 `chat/completions`，保留后台并发池骨架但移除 Batch File/Batch Chat 特定逻辑，用户接受全价实时计费。
- **v0.5.0.6 (2026-10-12)**：新增 `codewiki_progress` 只读查进度工具。让模型可查询编译阶段、百分比和任务明细。
- **v0.5.0.5 (2026-10-11)**：切换百炼批量通道为 Batch Chat。从异步 Batch File 改为同步端点，免除上传排队，实现 5 折省钱（后于 0.6.0 移除此优化）。
- **v0.5.0.4 (2026-10-11)**：封死手工流程逃生通道。修改系统提示，禁止模型手动修改 `.codewiki/` 文件，强制走流水线。
- **v0.5.0.3 (2026-10-10)**：新增行号锚点自动校验测试 `test-wiki-anchors.mjs`，拦截流水线产物的幻觉行号。
- **v0.5.0.2 (2026-10-10)**：重构 `vendor/codewiki` 为本地 fork，根治 Windows 反斜杠路径污染问题。
- **v0.5.0.1 (2026-10-10)**：自动补建 `CodeWiki.md` 入口文件，闭合守护门控不变量。插件层收口 Windows 路径规范化 (`normalizeArticlePath`, `normalizeIndexLinks`)。
- **v0.5.0 (2026-10-07)**：面板信息密度改版。六阶段步骤条、双通道吞吐徽标、用量统计、加权总进度条。
- **v0.4.11.2 (2026-10-07)**：放宽阶段实时阈值上限至 99,999,999，支持大仓库强制实时。
- **v0.4.11.1 (2026-10-07)**：孤儿任务接管机制。宿主重启后自动接管停更超过 5 分钟的旧实例任务。
- **v0.4.11 (2026-10-07)**：任务进度条与逐任务明细。显示批次进度 `n/m` 和 `taskList` 状态。
- **v0.4.10 (2026-10-06)**：端点加固与诊断。工作区过滤降级保护、handler 异常 500 响应、repos 缓存键隔离。
- **v0.4.9 (2026-10-06)**：工作区任务过滤。仅显示属于已添加 dsh 工作区的任务。
- **v0.4.8 (2026-10-06)**：仓库发现与一键排除。新增 `knownRepos` 清单和排除按钮。
- **v0.4.7 (2026-10-06)**：排除清单 + 自动更新 + 仓库总览与标签页。三标签页面板（总览/任务/设置）。
- **v0.4.6 (2026-10-06)**：面板收敛 + 实时 tps + Temp 残留自动清理。
- **v0.4.5 (2026-10-06)**：阶段实时阈值（混合通道）。`batchMinTokens` 设置，低于阈值走实时接口。
- **v0.4.4 (2026-10-06)**：侧边栏面板完善。滚动支持、工作区分组、设置参数移入面板。
- **v0.4.3 (2026-10-06)**：审查修复。取消可靠性、多实例安全、断点保真。修复 `jobServiceRef` 模块级引用导致的跨实例覆盖问题。
- **v0.4.2 (2026-10-06)**：超大任务升 256k 档继续走批量。避免直接实时兑底。
- **v0.4.1 (2026-10-06)**：横切精准拆分 (map-reduce) + 校对动态预算。
- **v0.4.0 (2026-10-06)**：服务化全批量流水线。零子代理，宿主常驻 JobService 驱动，32k 分块并行。
- **v0.3.2 (2026-10-04)**：批量推理异步化。提交即返回，宿主后台链自动收尾。
- **v0.3.1 (2026-10-04)**：批量推理凭证自动取模型设置「阿里百炼云」渠道。
- **v0.3.0 (2026-10-04)**：写文章环节可改走阿里云百炼批量推理 (Batch File)。
- **v0.2.8 (2026-10-03)**：写文章子代理活动行 label 带模型前缀。
- **v0.2.7 (2026-10-03)**：修复插件整体未装载（两个工具全部消失）。修正 `ctx.agents` 访问抛错问题。
- **v0.2.6 (2026-10-03)**：设置页支持选择子代理思考程度 (`reasoningEffort`)。
- **v0.2.5 (2026-10-03)**：Wiki 维护提醒注入会话系统提示。`installUpdateReminder`。
- **v0.2.4 (2026-10-03)**：修复子代理模型路由静默丢弃。补全两处 task 构造的 `route` 参数。
- **v0.2.3 (2026-10-03)**：修复 MSYS 路径误判、Windows 路径校验结果错、工具描述不符。
- **v0.2.2 (2026-10-02)**：审查修复 8 项。`scope=full` 不再被 clean 短路，`cw status` 非零退出抛错等。
- **v0.2.1 (2026-10-02)**：修复子代理服务接线断裂。`generateToolDefinition` 未接住 `subagents`。
- **v0.2.0 (2026-10-01)**：新增插件页设置 UI (`client.js`)。
- **v0.1.1 (2026-10-01)**：移除 codewiki 技能，默认模型钉死为 `aliyun-bailian/qwen3.8-flash`。
- **v0.1.0 (2026-10-01)**：首次发布。提供 `cw` 和 `codewiki_generate` 工具。

### CodeWiki.md
位于仓库根目录，是插件自身的项目 Wiki 入口。
- **功能**：定义插件代码库结构，供 `codewiki_generate` 编译成 `<repo>/.codewiki/` 下的文章。
- **关键部分**：
  - `Overview`：描述插件接入方式、编译流程（六环节）、Token 预算策略。
  - `Key Components`：详细列出 `index.js`、`client.js`、`vendor/codewiki` 等文件的职责和内部函数（如 `estimateTokens`, `collectSources`, `createJobService`）。
  - `Architecture`：ASCII 图展示编译流程和面板轮询机制。
  - `Data Flow`：配置流、凭证流、任务流、面板流。
  - `Connections`：链接上游 `codewiki-upstream` 和百炼接口。
  - `Known Issues`：注册不热加载、junction 依赖、cw 无 version 命令等。

### compile-manager.js
**职责**：编译任务的核心调度器。负责接收 `codewiki_generate` 调用，创建 Job 实例，管理并发控制，并协调各阶段 Agent 的执行。

*   **关键类/函数**:
    *   `class CompileManager`: 主入口类。
        *   `constructor(options)`: 初始化依赖注入（fs, path, logger, subagentService, config）。
        *   `async startJob(jobId, options)`: 启动编译任务。
            *   **入参**: `jobId` (string), `options` (object: `scope`, `provider`, `model`, `reasoningEffort`, `maxConcurrency`, `articleLanguage`)。
            *   **行为**:
                1.  校验 `cwd` 下是否存在 `.codewiki/` 目录（若不存在且 scope!=full，可能直接返回或报错，需结合前置逻辑）。
                2.  根据 `scope` (`auto`/`full`) 决定初始状态。
                3.  调用 `plan()` 获取文章列表和变更状态。
                4.  进入 `executePipeline()`。
        *   `async executePipeline(job)`: 编排流水线。
            *   **步骤**: `Planning` -> `Writing` -> `Cross-cutting` -> `Review` -> `Indexing`。
            *   **并发控制**: 在 `Writing` 阶段，使用信号量或队列限制并发数（默认 2，由 `maxConcurrency` 配置）。
            *   **错误处理**: 单篇文章失败记录到 `job.failedArticles`，不中断整体 Job；规划阶段失败则标记 Job 为 `failed` 并返回。
        *   `async plan()`: 调用 `cw status` 或内部逻辑判断哪些文章需要更新。
            *   **返回值**: `{ articles: [{ id, path, status: 'new'|'update'|'skip' }] }`。
        *   `async writeArticle(article, jobContext)`: 调用子代理生成文章内容。
            *   **调用**: `subagentService.start('spawn', payload)`。
            *   **Payload**: 包含 `agentOptions` (provider/model/reasoningEffort), `context` (代码片段, 现有内容)。
            *   **结果处理**: 解析子代理返回的文本，写入 `.codewiki/articles/` 对应文件。若 `stopReason != 'completed'`，记为失败。
        *   `async updateMeta(job)`: 编译成功后，执行 `cw meta update` 刷新元数据。
    *   **常量/默认值**:
        *   `DEFAULT_MAX_CONCURRENCY = 2` (m00589 提及红线 2)。
        *   `STAGES = ['planning', 'writing', 'cross-cutting', 'review', 'indexing']`。

### job-store.js
**职责**：编译 Job 状态的持久化存储。提供原子读写操作，确保进程重启后能恢复状态，并支持实时查询。

*   **关键类/函数**:
    *   `class JobStore`:
        *   `constructor(dataDir)`: 指定存储目录（通常为 `cwd/.codewiki/jobs/`）。
        *   `async saveJob(job)`: 序列化 Job 对象到 JSON 文件。文件名通常为 `<jobId>.json`。
        *   `async loadJob(jobId)`: 从文件系统读取并反序列化 Job。
        *   `async listJobs(filter?)`: 列出所有 Job，支持按 `cwd` 或 `jobId` 过滤。
        *   `async updateJobStage(jobId, stage, progress)`: 原子更新当前阶段和进度百分比。
    *   **数据结构 (Job Object)**:
        ```typescript
        {
          id: string;       // UUID
          cwd: string;      // 仓库根路径
          status: 'pending' | 'running' | 'completed' | 'failed';
          stage: string;    // 当前阶段
          progress: number; // 0-100
          startedAt: number;
          finishedAt?: number;
          options: {...};   // 传入的配置
          results: {
            planned: number;
            written: number;
            failed: number;
            failedArticles: Array<{id, reason}>;
          };
        }
        ```
    *   **边界条件**:
        *   文件锁：在多进程/高并发下可能需要简易的文件锁机制防止竞态（JS 单线程模型下通常非阻塞 IO 足够，但需注意 fs 操作的顺序性）。
        *   脏数据清理：异常退出时，Job 可能停留在 `running` 状态，下次启动时需检查或重置（取决于 `CompileManager` 的重试逻辑）。

### progress-service.js
**职责**：为 `codewiki_progress` 工具提供只读接口。实时读取 `JobStore` 中的数据，计算并返回进度详情。

*   **关键类/函数**:
    *   `class ProgressService`:
        *   `constructor(jobStore)`: 依赖注入。
        *   `async getProgress(cwd?, jobId?)`:
            *   **入参**: 可选的 `cwd` 或 `jobId`。若不传，返回所有活跃/历史 Job。
            *   **返回值**: `Array<{ jobId, status, stage, progress, stats: {written, failed, ...}, lastUpdated }>`.
        *   `async getRealTimeStatus(jobId)`: 快速查询单个 Job 的最新快照。
    *   **数据流**:
        *   直接从磁盘读取 JSON，不涉及复杂计算，保证低延迟。
        *   若 Job 处于 `running` 状态，返回当前最新的 `stage` 和 `progress`。

### subagent-interaction.js
**职责**：封装与 DeepSeek Harness 子代理系统的通信细节。

*   **关键实现**:
    *   `async spawnAgent(payload)`:
        *   **调用**: `ctx.subagents.start('spawn', payload)`。
        *   **Payload 构造**:
            *   `systemPrompt`: 包含 CodeWiki 写作规范、语言要求 (`articleLanguage`)。
            *   `userInput`: 代码上下文、旧文章草稿（如有）、指令。
            *   `agentOptions`: `provider`, `model`, `reasoningEffort`。
        *   **监听回调**:
            *   处理 `message` 事件：实时更新 UI 面板或日志。
            *   处理 `completion` 事件：提取最终文本，检查 `stopReason`。
            *   **失败处理**: 若 `stopReason` 为 `error` 或 `timeout`，捕获异常并记录到 `job.failedArticles`。
    *   **模型路由**:
        *   优先使用 `options.provider` + `options.model`。
        *   若为空，回退到 `config.defaultProvider` / `config.defaultModel`。
        *   若两者皆空，继承会话模型（需通过 `ctx.remote.session` 获取）。

### utils/fs-helpers.js
**职责**：安全的文件操作封装，处理编码、权限和路径规范化。

*   **关键函数**:
    *   `async ensureDirectory(path)`: 递归创建目录。
    *   `async writeFileSafe(path, content, encoding='utf-8')`: 写入文件，附带简单的错误捕获。
    *   `async readJsonFile(path)`: 安全读取 JSON，处理解析错误。

## Architecture

```text
[开发者/Agent] ──调用──► [codewiki_generate / cw 工具]
        │
        ▼
[CompileManager.startJob] ──► [JobStore.saveJob] (初始化 pending)
        │
        ▼
[CompileManager.plan] ◄── [CW CLI / Internal Logic] (获取变更集)
        │
        ▼
[CompileManager.executePipeline]
        │ (Writing Stage: 并发控制 maxConcurrency=2)
        ▼
[SubagentInteraction.spawnAgent] ──► [DeepSeek Subagent Service]
        │                                   │
        │◄──────────────────────────────────┘ (LLM Provider)
        │
        ▼
[FS Helpers.writeFileSafe] ──► [.codewiki/articles/<id>.md]
        │
        ▼
[JobStore.updateJobStage] (更新 written/progress)
        │
        ▼
[CompileManager.updateMeta] ──► [CW CLI meta update]
        │
        ▼
[JobStore.updateJobStatus] (completed/failed)

[Panel/UI] ◄─2s Polling── [ProgressService.getProgress] ◄── [JobStore.listJobs]
```

## Data Flow

1.  **配置流**：`profile patch config:` → cordis 注入 `apply(ctx, config)` → `liveConfig` 每次调用解包（volatile 热生效）。
2.  **凭证流**：显式 `batchApiKey` > 宿主凭据库 `resolve('ALIYUN_BAILIAN_API_KEY')`（模型设置「阿里百炼云」渠道）。
3.  **任务流**：
    *   `codewiki_generate` 触发 `CompileManager.startJob`。
    *   `JobStore` 持久化初始状态。
    *   `CompileManager` 规划文章列表，进入 `executePipeline`。
    *   `SubagentInteraction` 构建 Payload 调用子代理，子代理执行 LLM 推理。
    *   结果通过 `FS Helpers` 写入 `.codewiki/` 目录，`JobStore` 更新进度。
    *   终态调用 `cw meta update`，更新 Job 状态为 `completed` 或 `failed`。
4.  **面板流**：浏览器 2s 轮询 `jobs` 端点（回环 only），`ProgressService` 读取 `JobStore` 最新 JSON，返回任务状态、进度、用量等信息。

## Connections

- [[@local/dsh-codewiki]] — 本模块所属的插件模块，包含 `index.js`, `client.js` 等源码。
- [[codewiki-upstream]] — 上游 Rust CLI `cw` 项目，MIT 许可，位于 `vendor/codewiki/`。
- [[dsh-harness]] — DeepSeek Harness 宿主环境，提供 `agent`, `llm`, `webServer` 等服务注入。

## Known Issues

- **插件注册不热加载**：修改 `index.js` 或 profile patch 后需重启 dsh。`client.js` 同理，`dsh.client` 声明新增后需重启才能被宿主扫描器识别。
- **依赖 Junction**：`@deepseek-ai/schemastery` 依赖本地 junction，换机器需重建。
- **上游限制**：`cw` 无 `--version` 命令；`cw path` 在未 init 仓库退回 fallback；stale 文章路径输出反斜杠（插件侧已归一）。
- **断点语义变化**：0.5.x 批量通道的 24h 批次窗口语义已于 0.6.0 删除，当前断点仅记录阶段机位置。
- **并发冲突风险**：同一 `cwd` 并行运行多个 `codewiki_generate` 可能导致文件竞争写入。`CompileManager` 应检查是否有同 `cwd` 的 `running` Job，若有则拒绝或排队。
- **Token 截断隐式行为**：`SubagentInteraction` 在构建 Payload 时，必须截断过长的代码上下文或旧文章内容，以确保不超过模型上下文窗口（≤32k token），这是关键的隐式行为。