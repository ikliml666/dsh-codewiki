---
title: system-architecture-overview
type: architecture
source_files: []
tags: [architecture, overview, codewiki, dsh-plugin]
---

## Overview

`dsh-codewiki` 是一个基于 DeepSeek Harness (DSH) 的插件系统，旨在为代码仓库提供自动化的 Wiki 编译、维护与文档生成能力。该系统采用“提交-异步推进”的架构模式，通过后台常驻服务（JobService）驱动阶段机，利用阿里云百炼（DashScope）API 进行大模型推理，最终在 `.codewiki/` 目录下生成结构化的 Markdown 文档。

系统核心由后端宿主逻辑 (`index.js`)、前端交互面板 (`client.js`)、自动化测试套件及静态配置元数据组成。它支持全量编译、增量更新、横切文章合成及行号锚点校验，并通过 Web API 暴露实时状态供 UI 轮询。

## System Overview

系统整体分为三层：客户端层、宿主服务层和外部依赖层。

```text
┌─────────────────────────────────────────────────────────────────────┐
│                      Client Layer (Browser)                         │
│                                                                     │
│  ┌──────────────────┐   ┌──────────────────┐   ┌────────────────┐  │
│  │ CodewikiPanel    │   │ ReposTab         │   │ CodewikiCard   │  │
│  │ (Jobs/Overview)  │   │ (Workspace List) │   │ (Settings Form)│  │
│  └────────┬─────────┘   └────────┬─────────┘   └────────┬───────┘  │
│           │                     │                       │          │
│           └─────────────────────┴───────────────────────┤          │
│                                                         ▼          │
│                                             Polling / POST APIs  │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP (Loopback Only)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Host / Plugin Core (Node.js)                       │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                   apply(ctx, config)                          │  │
│  │  ├── createJobService()  (Tick Loop, Persistence)            │  │
│  │  ├── installWebServer()  (/api/codewiki/jobs, control)       │  │
│  │  ├── registerTools()     (cw, codewiki_generate, progress)   │  │
│  │  └── installUpdateReminder() (System Prompt Injection)       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                 Job Service (Stage Machine)                   │  │
│  │                                                               │  │
│  │  plan ► articles ► crosscut ► review ► index ► done           │  │
│  │      │        │           │           │           │           │  │
│  │      ▼        ▼           ▼           ▼           ▼           │  │
│  │  scanRepo  collectSrc  synthesize  validate  cw index/meta    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                 Shared Utilities & Config                     │  │
│  │  • estimateTokens / collectSources / packArticles             │  │
│  │  • resolveBatchApiKey / runRealtimeTasks                      │  │
│  │  • Config (schemastery) / cordis.patch.yml                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ API Calls / CLI Execution
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  External Dependencies                              │
│                                                                     │
│  ┌─────────────────────┐   ┌──────────────────────┐                │
│  │ DashScope API       │   │ Local CW Binary      │                │
│  │ (chat/completions)  │   │ (cli wrapper)        │                │
│  │ • Planning          │   │ • status             │                │
│  │ • Article Gen       │   │ • index              │                │
│  │ • Crosscut Review   │   │ • meta update        │                │
│  └─────────────────────┘   └──────────────────────┘                │
│                                                                     │
│  ┌─────────────────────┐                                           │
│  │ File System         │                                           │
│  │ • .codewiki/        │                                           │
│  │ • jobs.json (State) │                                           │
│  │ • CodeWiki.md       │                                           │
│  └─────────────────────┘                                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

数据流主要包含控制流（Job 状态变更）、内容流（源码到 Wiki 的转换）和反馈流（UI 状态同步）。

```text
[User/AI Agent] 
       │
       ▼ (Execute Tool)
[codewiki_generate] ──► [parseStatus] (Check Repo State)
       │
       ├─► [submit(job)] ──► Write to JOBS_FILE (Persistence)
       │                     Start Tick Loop
       │
       ▼
[JobService.tick()] (Polling Loop)
       │
       ├──► Stage: PLAN
       │      ├── scanRepoFiles (Filter Blacklist)
       │      ├── localPlan / MainModelPlan
       │      └── Submit LLM Request (chat/completions)
       │
       ├──► Stage: ARTICLES
       │      ├── collectSources (Token Budget Check)
       │      ├── prepareArticleTasks (Split if Oversized)
       │      ├── runRealtimeTasks (Concurrent Pool)
       │      └── Apply Task Result (Write .md files)
       │
       ├──► Stage: CROSSCUT
       │      ├── Synthesize Architecture/Patterns
       │      └── Handle Large Context (Map-Reduce Split)
       │
       ├──► Stage: REVIEW
       │      ├── Validate Frontmatter & Anchors
       │      └── LLM Correction
       │
       ├──► Stage: INDEX
       │      ├── Run `cw index` & `meta update`
       │      └── Ensure CodeWiki.md Entry
       │
       ▼
[Job Status Update] ──► Wake Compile Session (Steer Message)
       │
       ▼
[Client Polling] ◄── GET /api/codewiki/jobs
       │
       ▼
[UI Refresh] (Progress Bars, Logs, Spreads)
```

## Dependency Graph

模块间的依赖关系呈现为以 `core-application` 为核心，向上依赖配置与文档，向下依赖运行时产物与测试验证的结构。

```text
┌─────────────────────────────────────────────────────────────┐
│                   Configuration & Metadata                  │
│  (package.json, cordis.patch.yml, .gitignore)               │
│  Defines engines, dependencies (@deepseek-ai/schemastery),  │
│  and DSH plugin registration hooks.                         │
└──────────────┬──────────────────────────────────────────────┘
               │ Imports / Hooks
               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Documentation                             │
│  (CHANGELOG.md, CodeWiki.md, README.md)                     │
│  Static assets. CodeWiki.md serves as the bootstrap entry   │
│  for the wiki compilation process.                          │
└──────────────┬──────────────────────────────────────────────┘
               │ Referenced by Compiler
               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Core Application                          │
│  (index.js, client.js)                                      │
│  Contains JobService, Stage Handlers, Web Server,           │
│  and Browser UI components.                                 │
│                                                             │
│  Dependencies:                                              │
│  - @deepseek-ai/schemastery (Config Validation)             │
│  - node:fs, path, child_process (File/Process Ops)          │
│  - DashScope API (External LLM)                             │
│  - cw Binary (External CLI)                                 │
└──────────────┬──────────────────────────────────────────────┘
               │
               ├──► Runtime Artifacts (Logs, Probes, Watchers)
               │   (.probe3.txt, .tmp-test-*.log, watcher2.log)
               │
               └──► Test Suite (Validation & Mocking)
                   (test-batch.mjs, test-orchestration.mjs, etc.)
                   Verifies core logic, orchestration flow,
                   and wiki anchor integrity.
└─────────────────────────────────────────────────────────────┘
```

## Module Roles

### 1. Core Application (`modules/core-application.md`)
**职责**：系统的业务逻辑中枢。
*   **Host Side (`index.js`)**：实现 `createJobService`，管理 Job 的生命周期（提交、取消、列表）。包含完整的阶段机处理器（`tickPlan`, `tickArticles`, `tickCrosscut`, `tickReview`, `tickIndex`），负责调用 LLM API 和文件 I/O。提供 Web API 端点供前端查询。
*   **Client Side (`client.js`)**：React 组件库，提供侧边栏面板（CodewikiPanel）、仓库总览（ReposTab）和设置卡片（CodewikiCard）。通过轮询 API 展示进度、吞吐量和日志。

### 2. Configuration and Metadata (`modules/configuration-and-metadata.md`)
**职责**：定义插件的静态结构和加载行为。
*   **`package.json`**：声明 Node.js >=20 和 DSH >=0.2.0-rc.0 的环境要求，以及 `@deepseek-ai/schemastery` 依赖。
*   **`cordis.patch.yml`**：定义 DSH 插件注册信息（ID: `codewiki`），指定入口文件和默认配置项（如 `binaryPath`, `defaultProvider`, `maxConcurrency`）。
*   **`.gitignore`**：排除构建产物和临时日志。

### 3. Documentation (`modules/documentation.md`)
**职责**：提供人类可读的项目信息和自举文档。
*   **`CodeWiki.md`**：插件自身的 Wiki 入口，被编译器识别并生成为结构化文章。
*   **`CHANGELOG.md`**：记录版本演进，特别是关于 Token 预算策略、批量通道切换和面板 UI 的变更。

### 4. Runtime Artifacts (`modules/runtime-artifacts.md`)
**职责**：记录系统运行时的状态、日志和探针信息。
*   **Logs**：`.tmp-test-batch.log` 记录底层 AI 调用细节；`.tmp-test-orchestration.log` 记录高层工作流；`watcher2.log` 记录长任务心跳。
*   **Probes**：`.probe3.txt` 用于快速检测模块存活状态。
*   **Validation Logs**：`.tmp-test-wiki-anchors.log` 和 `.tmp-test-wiki-entry.log` 存储生成的 Wiki 文件的校验结果。

### 5. Test Suite (`modules/test-suite.md`)
**职责**：确保系统正确性的自动化测试集合。
*   **`test-batch.mjs`**：单元测试，验证 `estimateTokens`, `collectSources`, `runRealtimeTasks` 等核心函数。
*   **`test-orchestration.mjs`**：集成测试，模拟宿主上下文，验证 Job 从提交到终态的全流程，包括持久化恢复和并发控制。
*   **`test-wiki-anchors.mjs`**：静态校验，验证生成的 Markdown 文件中源码引用行号的准确性。
*   **`test-cwd-paths.mjs`**：路径兼容性测试，验证 Windows/MSYS 环境下的 CWD 处理。