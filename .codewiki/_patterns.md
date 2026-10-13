---
title: patterns
type: pattern
source_files: []
tags: [patterns, conventions, architecture, testing]
---

## Overview

CodeWiki 项目（`@local/dsh-codewiki`）在架构设计、代码组织、测试策略及运维规范上呈现出一套高度一致的模式。核心特征包括：**单文件模块化逻辑**（Single-file Module Logic）、**基于文件的持久化状态机**（File-based Persistent State Machine）、**异步提交与后台轮询分离**（Async Submit & Polling Decoupling）、以及**严格的 Git 边界管理**。这些模式确保了复杂的全批量编译流水线能够在宿主环境中稳定运行，同时保持客户端 UI 的响应性和可观测性。

## Patterns

### 1. 单文件模块化逻辑 (Single-File Modular Logic)

模块的核心业务逻辑倾向于收敛于单个入口文件中，将配置、服务工厂、工具定义和辅助函数统一组织。这种模式简化了依赖追踪，并便于宿主系统通过单一路径加载插件。

*   **证据**: `modules/core-application.md` 指出 `index.js` 负责后端/宿主侧的所有逻辑，包括 CLI 封装、流水线编排和 Web API。`modules/documentation-and-config.md` 同样强调 `index.js` 是“插件全部逻辑（单文件，Node ESM）”，包含 `Config`、`createJobService`、`apply` 等所有关键组件。
*   **出处**:
    *   `modules/core-application.md`: Key Components -> index.js (Host Side Logic)
    *   `modules/documentation-and-config.md`: Key Components -> `index.js` (根目录)

### 2. 基于文件的持久化状态机 (File-based Persistent State Machine)

任务状态不依赖于内存驻留，而是通过 JSON 文件持久化到磁盘（如 `JOBS_FILE`）。这支持了服务重启恢复、多实例并发隔离（通过锁机制）以及孤儿任务接管。状态推进由后台定时循环驱动。

*   **证据**: `modules/core-application.md` 描述了 `createJobService` 维护基于文件的 Job 状态机，`tick()` 函数定期执行推动 Job 从 `plan` 到 `done`。`modules/documentation-and-config.md` 进一步说明 job 状态持久化在 `os.tmpdir()/dsh-codewiki-jobs.json`，并通过 `JOBS_FILE.lock` 实现进程级串行，防止多实例覆盖。
*   **出处**:
    *   `modules/core-application.md`: Data Flow -> 后台推进 (Tick)
    *   `modules/documentation-and-config.md`: Key Components -> `createJobService`

### 3. 异步提交与后台轮询分离 (Async Submit & Polling Decoupling)

用户或自动化流程调用生成命令后，立即返回提交确认（`{submitted, jobId, stage}`），而非等待编译完成。前端客户端通过轮询 REST API 获取进度。这种模式解耦了控制平面和数据平面，提升了用户体验和系统吞吐量。

*   **证据**: `modules/core-application.md` 提到 `generateToolDefinition` 触发编译流水线，`submit` 即返回结果。`modules/documentation-and-config.md` 明确指出 `codewiki_generate` 为纯提交制。`client.js` 中的 `CodewikiPanel` 每 2 秒轮询 `GET /api/codewiki/jobs` 以刷新 UI。
*   **出处**:
    *   `modules/core-application.md`: Key Components -> generateToolDefinition; client.js -> CodewikiPanel
    *   `modules/documentation-and-config.md`: Key Components -> `codewiki_generate`; `client.js`

### 4. Git 边界与产物管理规范 (Git Boundary & Artifact Management)

通过 `.gitignore` 严格定义版本库边界，排除构建依赖、日志、二进制备份及特定 vendor 目录。同时，内部探针状态和测试异常输出被显式记录在非跟踪文件或特定日志文件中，用于诊断环境稳定性。

*   **证据**: `modules/git-and-ops-artifacts.md` 定义了 `.gitignore` 规则，排除 `node_modules/`, `vendor/codewiki/target/`, `*.log`, `bin/*.bak-*`。`modules/documentation-and-config.md` 在 `package.json` 和 `.gitignore` 部分也列出了相同的忽略规则，确保仓库纯净。
*   **出处**:
    *   `modules/git-and-ops-artifacts.md`: Key Components -> 1. Git Ignore Rules (.gitignore)
    *   `modules/documentation-and-config.md`: Key Components -> `.gitignore`

### 5. 分层测试策略 (Layered Testing Strategy)

测试套件分为三个层次：底层纯函数逻辑测试（Batch）、高层服务编排冒烟测试（Orchestration）以及静态内容完整性校验（Wiki Validation）。Mock 网络请求和本地文件系统操作是测试基础设施的核心。

*   **证据**: `modules/test-suite.md` 将测试分为 `test-batch.mjs`（验证纯函数如 `estimateTokens`, `collectSources`）、`test-orchestration.mjs`（验证服务生命周期、阶段机推进、持久化恢复）和 `test-wiki-anchors.mjs`（静态扫描 Markdown 文件验证行号锚点）。`modules/core-application.md` 提到的 `estimateTokens` 和 `collectSources` 也在测试中被独立验证。
*   **出处**:
    *   `modules/test-suite.md`: Key Components -> 1. test-batch.mjs; 3. test-orchestration.mjs; 4. test-wiki-anchors.mjs
    *   `modules/core-application.md`: Known Issues -> Token 估算误差 (提及 `estimateTokens`)