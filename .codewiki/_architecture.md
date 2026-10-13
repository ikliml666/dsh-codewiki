---
title: architecture
type: architecture
source_files: []
tags: [architecture, system-design, flow, dependencies]
---

## Overview

CodeWiki 是一个基于 Node.js 和 DeepSeek Harness (Cordis) 插件系统的自动化文档生成与管理系统。其核心目标是通过“零子代理”的批量流水线模式，对代码仓库进行全量扫描、规划、文章撰写、横切总结、校对及索引构建。系统采用宿主常驻服务（JobService）驱动异步任务，通过 Web API 向浏览器端侧边栏面板提供实时状态反馈。

本架构文档旨在为未来 Agent 提供系统级视角，涵盖总框图、数据流向、依赖关系及各模块职责。

## System Overview

系统由四个主要逻辑域组成：核心应用层（Host）、客户端交互层（Client）、运维与制品管理层（Ops），以及测试验证层（Test）。

```text
┌───────────────────────────────────────────────────────────────────────┐
│                        CodeWiki System Architecture                   │
├──────────────────────┬──────────────────────────────┬─────────────────┤
│   Host / Plugin Core │   Browser Client             │   Ops & Artifacts │
│   (index.js)         │   (client.js)                │                 │
│                      │                              │ • .gitignore    │
│  ┌────────────────┐  │  ┌────────────────────────┐  │ • .probe3.txt   │
│  │  JobService    │◄─┼──│  CodewikiPanel         │  │ • .orch-test-out│
│  │  (Tick Loop)   │  │  │  (Polling UI)          │  │                 │
│  │                │  │  │                        │  │                 │
│  │  Stage Machine │  │  │  ReposTab              │  │                 │
│  │  Plan/Article/ │  │  │  CodewikiCard          │  │                 │
│  │  Crosscut/     │  │  │                        │  │                 │
│  │  Review/Index  │  │  │  Polls:                │  │                 │
│  └────────────────┘  │  │  - Jobs Status         │  │                 │
│         ▲            │  │  - Repo State          │  │                 │
│         │            │  └────────────────────────┘  │                 │
│         ▼            │                              │                 │
│  ┌────────────────┐  │                              │                 │
│  │  Inference     │  │                              │                 │
│  │  Layer         │  │                              │                 │
│  │  (Bailian API) │  │                              │                 │
│  └────────────────┘  │                              │                 │
├──────────────────────┴──────────────────────────────┴─────────────────┤
│                        External Dependencies                          │
│  • DashScope API (Plain Endpoint)                                    │
│  • CW CLI (Rust Binary for Index/Meta)                               │
│  • File System (Persistence, Locking)                                │
└───────────────────────────────────────────────────────────────────────┘
```

**核心职责说明：**
1.  **Host Core**: 管理编译生命周期，执行阶段机状态转换，协调 LLM 推理与本地文件操作。
2.  **Browser Client**: 提供可视化界面，轮询后端状态，允许用户干预（取消、配置修改）。
3.  **Ops & Artifacts**: 定义版本控制边界，记录运行时探针状态及异常日志，确保环境可诊断性。

## Data Flow

数据流描述了从用户触发到最终 Wiki 落盘的完整路径，包括控制流和数据流。

```text
[User/Automation] 
       │
       ▼ POST /api/codewiki/control or Tool Call
[codewiki_generate Tool]
       │
       ├──► Normalize CWD & Resolve Credentials
       ├──► Run `cw status` (Check Repo State)
       └──► Submit Job to JobService (Persist to Disk)
               │
               ▼ (Async Tick Loop, e.g., every 10s)
        [JobService Tick]
               │
               ├──► Acquire Distributed Lock
               ├──► Orphan Takeover Check
               │
               ▼ (Stage Handlers)
        [Plan Stage] 
               │ Scan Repo Files → Local Plan JSON
               ▼
        [Articles Stage]
               │ Collect Sources → Batch Request (DashScope)
               ▼ (Result Write-back)
        [Crosscut Stage]
               │ Synthesize Architecture/Patterns (Split if oversized)
               ▼
        [Review Stage]
               │ Local Validation + Batch Proofreading
               ▼
        [Index Stage]
               │ Run `cw index` & `meta update`
               ▼
        [Done/Cancelled]
               │
               ├───────────────────────────────────────────────┐
               │                                               │
               ▼                                               ▼
        [File System Updates]                       [Web API Response]
        (.codewiki/*.md)                            GET /api/codewiki/jobs
               │                                   (JSON Summary)
               ▼                                   │
        [Wiki Entry Generated]                    ▼
        (CodeWiki.md)                     [Browser Client Refresh]
                                        (UI Update: Progress/Logs)
```

**关键数据点：**
*   **Job State**: 持久化在磁盘 JSON 文件中，包含 stage, articles, usage, notes 等。
*   **Stage Requests**: 包含源文件内联文本、Prompt 模板及 Token 预算信息。
*   **API Keys**: 通过凭据库解析，不存储在 Job 状态中（脱敏处理）。

## Dependency Graph

展示了模块间的静态依赖方向。箭头表示“依赖于”或“调用”。

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         Dependency Direction                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   @deepseek-ai/schemastery                                          │
│           ▲                                                         │
│           │                                                         │
│   core-application (index.js)                                       │
│           │                                                         │
│           ├──► client.js (Browser UI)                               │
│           │                                                         │
│           ├──► test-batch.mjs (Unit Tests)                         │
│           │                                                         │
│           ├──► test-orchestration.mjs (Integration Tests)           │
│           │                                                         │
│           └──► test-wiki-*.mjs (Validation Tests)                   │
│                                                                     │
│   git-and-ops-artifacts                                             │
│           ▲                                                         │
│           │ (Consumes Runtime Artifacts)                            │
│           │                                                         │
│   Test Suite & Core Application                                     │
│           │                                                         │
│           ▼                                                         │
│   External Services:                                                │
│   • DashScope API (Inference)                                       │
│   • CW CLI (Local Execution)                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**连接规则：**
1.  `core-application` 是核心枢纽，依赖 `schemastery` 进行配置验证。
2.  `test-suite` 直接依赖 `core-application` 的内部函数进行单元测试和集成测试。
3.  `git-and-ops-artifacts` 不产生代码依赖，而是消费运行时产生的文件（`.log`, `.txt`），用于运维监控。
4.  所有模块均间接依赖外部基础设施（文件系统、网络 API）。

## Module Roles

### 1. Core Application (`modules/core-application.md`)
*   **角色**: 系统大脑。
*   **职责**:
    *   实现 `JobService`，负责任务的提交、状态机推进（Plan -> Articles -> Crosscut -> Review -> Index）及持久化。
    *   提供 Web API 端点 (`/api/codewiki/jobs`, `/control`)。
    *   封装 `cw` CLI 调用，处理路径规范化及状态解析。
    *   管理 LLM 请求的后台并发池、Token 预算装填及结果处理（统一走百炼普通入口，无专用批量端点）。
    *   注册 Cordis 工具 (`cw`, `codewiki_generate`, `codewiki_progress`)。

### 2. Browser Client (`modules/core-application.md` - `client.js`)
*   **角色**: 用户交互界面。
*   **职责**:
    *   渲染侧边栏面板，展示任务进度、吞吐量徽标、错误日志。
    *   轮询后端 API 获取最新 Job 状态。
    *   提供设置卡片，允许用户修改配置（如启用/禁用、并发数、模型选择）。
    *   支持任务取消操作。

### 3. Git & Ops Artifacts (`modules/git-and-ops-artifacts.md`)
*   **角色**: 运维边界与诊断层。
*   **职责**:
    *   通过 `.gitignore` 排除敏感数据、构建产物及日志，保持仓库清洁。
    *   记录探针状态 (`.probe3.txt`) 和编排测试异常 (`.orch-test-out.txt`)，用于环境稳定性诊断。
    *   定义二进制备份策略 (`bin/*.bak-*`)。

### 4. Test Suite (`modules/test-suite.md`)
*   **角色**: 质量保障层。
*   **职责**:
    *   `test-batch`: 验证底层纯函数逻辑（Token 估算、源码收集、凭证解析）。
    *   `test-orchestration`: 验证端到端服务化流程（提交、阶段推进、持久化恢复、孤儿接管）。
    *   `test-cwd-paths`: 验证跨平台路径兼容性（Windows/MSYS）。
    *   `test-wiki-*`: 验证 Wiki 内容完整性（行号锚点、入口文件生成）。

### 5. Documentation & Config (`modules/documentation-and-config.md`)
*   **角色**: 元数据与配置层。
*   **职责**:
    *   定义插件元数据 (`package.json`) 及挂载补丁 (`cordis.patch.yml`)。
    *   维护变更日志 (`CHANGELOG.md`) 和用户文档 (`README.md`)。
    *   管理插件自身的 Wiki 入口 (`CodeWiki.md`)。