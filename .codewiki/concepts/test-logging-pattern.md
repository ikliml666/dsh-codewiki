---
title: test-logging-pattern
type: concept
source_files: []
tags: [logging, testing, runtime, artifacts]
---

## Overview

`test-logging-pattern` 是 CodeWiki 项目中用于记录运行时状态、测试执行结果及探针信息的隐式日志模式。该模式不依赖传统的结构化日志库，而是通过生成一系列以 `.` 开头的临时文件（如 `.tmp-test-batch.log`）或显式日志文件（如 `watcher2.log`），将底层引擎行为、高层编排流程及环境校验结果持久化到磁盘。这些文件构成了“运行时状态的持久化与验证层”，为自动化测试断言、故障排查及长时间运行任务的监控提供了数据基础。

核心特征包括：
1. **隐式标记**：使用 `.probe3.txt` 等轻量级文件确认模块存活。
2. **分层记录**：区分底层批处理逻辑（Batch）、高层服务编排（Orchestration）及路径/内容校验（CWD/Wiki）。
3. **实时反馈**：通过 `watcher2.log` 记录长任务的心跳与状态变更。
4. **无侵入性**：日志文件通常被 `.gitignore` 忽略，仅作为调试和 CI/CD 验证的辅助产物。

## Involved Modules

*   **runtime-artifacts**: 定义并维护所有运行时日志文件，包含探针、测试日志及 Watcher 心跳。
*   **test-suite**: 生成上述日志文件的核心执行者，通过 Node.js 脚本触发各子模块的逻辑并输出结果。
*   **core-application**: 提供被测试的核心业务逻辑（如 `index.js` 中的工具函数），其执行过程被记录在日志中。
*   **configuration-and-metadata**: 通过 `.gitignore` 规则排除这些日志文件，防止污染版本控制。

## Flow

1.  **初始化与探针**:
    *   系统启动或测试加载时，检查 `.probe3.txt` 是否存在，内容为 `probe`，用于快速确认模块环境正常。
    *   `watcher2.log` 开始初始化，准备接收来自后台服务的状态更新。

2.  **底层执行记录 (Batch Logging)**:
    *   `test-batch.mjs` 调用 `estimateTokens`, `collectSources`, `runRealtimeTasks` 等函数。
    *   执行细节（Token 估算值、源码收集状态、API 请求体结构、并发池行为）被写入 `.tmp-test-batch.log`。
    *   例如：记录 CJK/ASCII 字符的 Token 换算比例、超大文件的 `oversized` 标记、百炼端点的 `enable_thinking` 参数配置。

3.  **高层编排记录 (Orchestration Logging)**:
    *   `test-orchestration.mjs` 模拟宿主上下文，触发 `codewiki_generate` 等工具。
    *   工作流事件（提交 Job、阶段推进、面板 API 交互、孤儿接管、会话唤醒）被写入 `.tmp-test-orchestration.log`。
    *   记录包含：阶段路由决策（主模型 vs 批量端点）、横切拆分策略、Stale 更新逻辑、以及面板端点的 Loopback 守卫检查结果。

4.  **环境与内容校验记录**:
    *   `test-cwd-paths.mjs` 验证路径兼容性，结果写入 `.tmp-test-cwd-paths.log`。
    *   `test-wiki-anchors.mjs` 扫描生成的 Markdown 文章，校验行号锚点准确性，结果写入 `.tmp-test-wiki-anchors.log`。
    *   `test-wiki-entry.mjs` 验证入口文件生成逻辑，结果写入 `.tmp-test-wiki-entry.log`。

5.  **实时监控记录 (Watcher Logging)**:
    *   在长时间运行的测试或服务实例中，后台监听器持续监控 Job 状态。
    *   时间戳、Job ID、计划状态 (`plan`)、取消请求 (`cancelReq`) 及笔记计数 (`notes`) 被追加写入 `watcher2.log`。
    *   格式示例：`<duration>ms mtime=<timestamp> job=<jobId> plan=<status> cancelReq=<value> upd=<updateTime> notes=<count>`。

6.  **清理与忽略**:
    *   测试结束后，临时目录和日志文件可能被清理。
    *   若未被清理，`.gitignore` 确保 `*.log` 及 `.tmp-*` 文件不被提交到版本库。

## Implementation Map

| 日志文件 | 来源模块 | 关键内容/功能 | 关联代码/逻辑位置 |
| :--- | :--- | :--- | :--- |
| `.probe3.txt` | runtime-artifacts | 探针标记，确认模块存在性 | 仓库根目录，内容固定为 `probe` |
| `.tmp-test-batch.log` | test-suite (batch) | 底层函数测试结果：Token 估算、源码收集、任务装配、实时任务执行、本地规划、API Key 解析 | `index.js`: `estimateTokens` (L178), `collectSources` (L236), `runRealtimeTasks` (L206), `resolveBatchApiKey` (L268) |
| `.tmp-test-cwd-paths.log` | test-suite (cwd) | 路径规范化、MSYS/Windows 兼容性及错误处理结果 | `test-cwd-paths.mjs`: L43-51; `index.js`: `cw.execute` (L404) |
| `.tmp-test-orchestration.log` | test-suite (orch) | 服务化编排全流程：提交、阶段机、横切拆分、面板 API、孤儿接管、会话唤醒 | `test-orchestration.mjs`: `makeCtx` (L34), `waitJob` (L166), `tickPlan`/`tickArticles` 等阶段处理器逻辑 |
| `.tmp-test-wiki-anchors.log` | test-suite (wiki) | Wiki 文章行号锚点校验结果：起始行范围、非空代码行、符号绑定 | `test-wiki-anchors.mjs`: `walk` (L35), `symbolsOnLine` (L45), 锚点断言 (L65) |
| `.tmp-test-wiki-entry.log` | test-suite (wiki) | 入口文件生成逻辑：幂等性、路径规范化、状态解析 | `test-wiki-entry.mjs`; `index.js`: `ensureWikiEntry` (L139), `normalizeArticlePath` (L106) |
| `watcher2.log` | runtime-artifacts | 长时间运行任务的实时心跳：Job 状态、mtime、更新时间、笔记计数 | 后台 Watcher 进程，持续追加写入 |