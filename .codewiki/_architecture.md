---
title: _architecture
type: architecture
source_files: []
tags: [system, architecture, overview, flow, dependency]
---

## Overview

`dsh-codewiki` 是一个基于 DeepSeek Harness (DSH) 插件系统的自动化文档生成与管理系统。它通过封装 Rust CLI `cw`，利用阿里云百炼（Bailian）的批量推理能力，实现从源码扫描、规划、文章生成、横切合成到索引更新的全自动流水线。系统采用前后端分离架构：后端由 `core-logic` 驱动状态机与 API 服务，前端由 `client-interface` 提供侧边栏可视化与控制；基础设施层由 `documentation-and-config` 管理元数据，`observability` 提供运行时诊断日志，`testing-suite` 保障全链路正确性。

## System Overview

系统整体由五个核心模块组成，围绕“任务提交 -> 后台处理 -> 状态反馈”闭环运行。

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        SYSTEM OVERVIEW                               │
├─────────────────┬──────────────────────┬────────────────────────────┤
│   Client Layer  │   Core Logic Layer   │    Infrastructure          │
│                 │                      │                            │
│ ┌─────────────┐ │ ┌──────────────────┐ │ ┌────────────────────────┐ │
│ │ client-     │ │ │ core-logic       │ │ │ documentation-and-     │ │
│ │ interface   │ │ │ (index.js)       │ │ │ config                 │ │
│ │             │ │ │                  │ │ │                        │ │
│ │ Codewiki    │ │ │ JobService       │ │ │ • package.json         │ │
│ │ Panel       │ │ │ • Tick Loop      │ │ │ • cordis.patch.yml     │ │
│ │ ReposTab    │ │ │ • Stage Machine  │ │ │ • CHANGELOG.md         │ │
│ │ ConfigForm  │ │ │ • Batch/Realtime │ │ │ • CodeWiki.md          │ │
│ └─────────────┘ │ │   Inference      │ │ └────────────────────────┘ │
│                 │ │                  │ │                            │
│ ┌─────────────┐ │ └───────┬──────────┘ │ ┌────────────────────────┐ │
│ │ observ-     │ │         │            │ │ testing-suite          │ │
│ │ ability     │ │         ▼            │ │                        │ │
│ │             │ │ ┌──────────────────┐ │ │ • test-batch.mjs       │ │
│ │ watcher2.   │ │ │ Bailian (API)    │ │ │ • test-orch.mjs        │ │
│ │ log         │ │ │ • Batch File     │ │ │ • test-cwd-paths.mjs   │ │
│ └─────────────┘ │ │ • Chat Fallback  │ │ │ • test-wiki-entry.mjs  │ │
└─────────────────┴──────────────────────┴────────────────────────────┘
```

## Data Flow

数据流展示了请求从用户触发到最终落盘及面板更新的完整生命周期。

```text
[User Action] 
    │
    ▼
[CodewikiPanel / CodewikiCard] (client-interface)
    │ apiPost(CONTROL_PATH) / form.mutate()
    ▼
[Web Server API] (core-logic: installWebServer)
    │ GET /api/codewiki/jobs / POST /api/codewiki/control
    ▼
[JobService.submit / cancel] (core-logic)
    │ createJob → persist to JOBS_FILE
    ▼
[Tick Loop & Stage Machine] (core-logic)
    │ plan → articles → crosscut → review → index
    │
    ├─► [Batch Inference] (Bailian API)
    │     buildJsonl → submitBatch → settleBatch
    │     (Checkpoint persistence in os.tmpdir/)
    │
    └─► [Realtime Fallback] (bailianChat)
          (For oversized tasks > BATCH_TOKEN_HARD_LIMIT)
    ▼
[Wikification Output] (<repo>/.codewiki/)
    │ Articles (.md), Patterns, Architecture
    │ cw index + cw meta update
    ▼
[File Watcher] (observability)
    │ Detects mtime changes
    │ Logs to watcher2.log (elapsed_time, job_id, notes)
    ▼
[Client Polling] (client-interface)
    │ setInterval(2000ms) GET /api/codewiki/jobs
    │ Updates UI: Progress Bar, Sparkline, Stage Steps
```

## Dependency Graph

依赖方向图展示了模块间的调用关系与外部依赖。箭头 `►` 表示依赖或数据流向。

```text
┌─────────────────────┐     ┌──────────────────────────┐
│   External Services  │     │   DeepSeek Harness Host  │
│                      │     │                          │
│  Alibaba Bailian     │◄────│  - Cordis Plugin System  │
│  (Batch/Chat API)    │     │  - ConfigForms Service   │
│                      │     │  - Credential Store      │
└─────────────────────┘     └──────────┬───────────────┘
                                      │ inject
                                      ▼
┌──────────────────────────────────────────────────────────────┐
│                     dsh-codewiki Plugin                      │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ documentation-   │    │      core-logic              │   │
│  │ and-config       │    │                              │   │
│  │                  │    │  - index.js                  │   │
│  │ • metadata       │    │  - JobService                │   │
│  │ • patch.yml      │    │  - WebServer                 │   │
│  └──────────────────┘    └──────────┬───────────────────┘   │
│                                     │                       │
│  ┌──────────────────┐    ┌──────────▼───────────────────┐   │
│  │ client-interface │    │      testing-suite           │   │
│  │                  │    │                              │   │
│  │ • client.js      │    │  • test-batch.mjs            │   │
│  │ • React Components│   │  • test-orch.mjs             │   │
│  │ • Polling        │    │  • test-cwd-paths.mjs        │   │
│  └──────────────────┘    │  • test-wiki-entry.mjs       │   │
│                           └──────────────────────────────┘   │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ observability    │    │      dependencies            │   │
│  │                  │    │                              │   │
│  │ • watcher2.log   │    │  - @deepseek-ai/schemastery  │   │
│  │ • File Watcher   │    │  - Rust CLI 'cw'             │   │
│  └──────────────────┘    └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## Module Roles

各模块在系统中的具体职责如下：

### `core-logic` (`index.js`)
**角色**: 系统的大脑与心脏。
**职责**:
- **编排引擎**: 维护 `JobService`，执行 `tick` 循环驱动六阶段状态机（Plan -> Articles -> Crosscut -> Compose -> Review -> Index）。
- **推理调度**: 根据 Token 预算动态选择阿里云百炼的 Batch File（低成本）或 Chat Completions（实时兜底）。
- **CLI 封装**: 封装 Rust `cw` 工具，处理路径归一化、状态查询及索引更新。
- **API 服务**: 提供回环保护的 RESTful 接口供前端轮询任务状态和控制任务。
- **持久化**: 将任务进度、断点信息写入 `JOBS_FILE` 和 `REPOS_FILE`，支持跨会话恢复。

### `client-interface` (`client.js`)
**角色**: 用户的眼睛与手。
**职责**:
- **UI 渲染**: 在 DSH 侧边栏注册 `CodewikiPanel`，展示任务进度条、六阶段步骤条、吞吐量微趋势图（Sparkline）及用量统计。
- **配置管理**: 通过 `configForms` 集成设置卡片，支持热更新插件参数（如并发数、排除路径）。
- **状态同步**: 每 2 秒轮询 `/api/codewiki/jobs`，计算 ETA 并刷新 UI；每 10 秒轮询仓库状态。
- **交互控制**: 处理用户取消任务、切换仓库排除状态等操作。

### `documentation-and-config` (Root Files)
**角色**: 系统的说明书与身份证。
**职责**:
- **元数据定义**: 通过 `package.json` 定义插件入口、导出路径及宿主识别标志。
- **挂载配置**: 提供 `cordis.patch.yml` 用于本地开发和 Bundle 安装时的插件注入。
- **文档体系**: 维护 `README.md` 用户指南及 `CodeWiki.md` 插件自述文件（v0.5.0.1 后自动生成）。
- **版本追踪**: 通过 `CHANGELOG.md` 记录架构演进与功能变更。

### `observability` (Logs)
**角色**: 系统的黑匣子。
**职责**:
- **运行时诊断**: 通过文件监听器捕获文件系统事件，输出结构化日志至仓库根 `watcher2.log`。
- **性能分析**: 记录作业耗时、mtime、Job ID 及 Notes 状态，用于诊断长尾延迟和处理阻塞。

### `testing-suite` (Test Scripts)
**角色**: 系统的质检员。
**职责**:
- **全链路验证**: 覆盖原子函数（Token 估算、JSONL 构建）、路径兼容性（MSYS/Windows）及服务编排（阶段机、断点续查、并发控制）。
- **Mock 环境**: 提供 Mock Fetch 和 Context 构造器，确保在无真实网络和宿主环境下可独立运行测试。