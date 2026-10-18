---
title: runtime-artifacts
type: module
source_files:
  - .probe3.txt
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [runtime, artifacts, logging, test-output, orchestration]
---

## Overview

`runtime-artifacts` 模块负责管理 CodeWiki 在运行时生成的临时测试日志、探针标记及大规模 watcher 运行日志。该模块不直接包含业务逻辑代码，而是作为**运行时状态的持久化与验证层**。它通过一系列隐式文件（以 `.` 开头）和显式日志文件，记录了从源码扫描、Token 估算、任务规划、批量执行到最终 Wiki 生成的全链路状态。

核心职责包括：
1. **探针标记**：`.probe3.txt` 用于快速检测模块是否处于活跃或“存活”状态。
2. **批处理与调度日志**：`.tmp-test-batch.log` 记录了底层 AI 模型调用（百炼 DashScope）、Token 预算控制、并发池管理及失败记账的详细行为。
3. **编排与上下文日志**：`.tmp-test-orchestration.log` 记录了高级别的工作流，如 `codewiki_generate` 提交、阶段路由（主模型 vs 批量端点）、Stale 更新及面板 API 交互。
4. **路径与环境校验**：`.tmp-test-cwd-paths.log` 验证了跨平台（MSYS/Windows）下的工作目录解析及 `.codewiki` 状态判定。
5. **Wiki 内容完整性校验**：`.tmp-test-wiki-anchors.log` 和 `.tmp-test-wiki-entry.log` 记录了生成的 Markdown 文章中的行号锚点有效性及入口文件生成逻辑。
6. **Watcher 心跳日志**：`watcher2.log` 展示了长时间运行的文件监听器对 Job 状态更新的实时反馈。

## Key Components

本模块由以下关键文件和其内部记录的行为组成：

### 1. `.probe3.txt`
*   **用途**：轻量级探针文件，用于确认模块存在性。
*   **内容**：仅包含字符串 `probe`。
*   **位置**：仓库根目录。

### 2. `.tmp-test-batch.log` (批处理核心日志)
此文件是理解底层执行引擎的关键，记录了 59 个通过的测试用例，涵盖了以下功能：

*   **Token 估算 (`estimateTokens`)**
    *   **逻辑**：CJK 每字 1 token；ASCII 每 3.5 字符 ceil 为 1 token；空串为 0；混合计费。
    *   **来源**：`.tmp-test-batch.log` 第 2-6 行。
*   **源码收集 (`collectSources`)**
    *   **逻辑**：内联带相对路径标题；缺失文件标注；预算充足不跳过；首文件超预算触发 `oversized` 兜底；第二文件超预算则 `skipped`。
    *   **来源**：`.tmp-test-batch.log` 第 8-14 行。
*   **任务装配 (`prepareArticleTasks`)**
    *   **普通任务**：分配 `customId`，Prompt 含 mission、语言、内联源码、frontmatter 规范。
    *   **超大文件处理**：单文件超 28k 预算 → 升大档（200k）重装；连 200k 都装不下 → `oversized` 转超大兜底。
    *   **多文件分割**：超预算拆分为 ≥2 个观察批（实际 4 批），保持 `keepInMemory`，Prompt ≤28k token，标注批次序号。
    *   **来源**：`.tmp-test-batch.log` 第 16-42 行。
*   **实时任务执行 (`runRealtimeTasks`)**
    *   **端点**：`dashscope.aliyuncs.com`。
    *   **请求体**：顶层 `model` + `enable_thinking:false` (budget=0)；若 `budget=1024` 则 `enable_thinking:true` + `thinking_budget:1024`。
    *   **机制**：同步请求，磁盘任务落盘，`keepInMemory` 结果带 content。
    *   **容错**：外部 signal 中止后不再消费剩余任务；并发池中失败记账进 `notes`，不中断其他任务。
    *   **来源**：`.tmp-test-batch.log` 第 44-72 行。
*   **本地规划 (`localPlan`)**
    *   **逻辑**：按顶层目录分组（src/root/docs），兜底规划不造概念。
    *   **来源**：`.tmp-test-batch.log` 第 74-78 行。
*   **文章打包 (`packArticles`)**
    *   **逻辑**：预算内整篇装填；超预算只装头部（含 frontmatter 与 Overview）并标注。
    *   **来源**：`.tmp-test-batch.log` 第 80-84 行。
*   **文件扫描 (`scanRepoFiles`)**
    *   **逻辑**：跳过 `node_modules/.git`、二进制、超大、空文件；记录 `bytes` 大小。
    *   **来源**：`.tmp-test-batch.log` 第 86-88 行。
*   **API Key 解析 (`resolveBatchApiKey`)**
    *   **优先级**：显式 `batchApiKey` > 宿主凭据库注入。
    *   **异常处理**：无宿主上下文返回 null；注入非函数返回 null；凭据库无条目返回 null；注入抛错返回 null。
    *   **来源**：`.tmp-test-batch.log` 第 90-98 行。

### 3. `.tmp-test-cwd-paths.log` (路径与环境)
*   **MSYS 路径归一化**：将 `/e/ik/...` 转换为 Windows 风格 `E:\ik\...`，并指向 `<repo>/.codewiki`。
*   **Windows 路径状态**：返回真实三态（Not "No wiki found"）。
*   **错误处理**：不存在的路径干净报错。
*   **来源**：`.tmp-test-cwd-paths.log` 全文。

### 4. `.tmp-test-orchestration.log` (高层编排)
记录了复杂的工作流场景，包括：

*   **Wiki 维护提醒**：
    *   监听 `agent/created`。
    *   有 `.codewiki` 且根有 `CodeWiki.md` 时注入提醒文本，指向 `codewiki_generate`。
    *   无 `.codewiki` 或无根入口时不注入噪音。
    *   **来源**：`.tmp-test-orchestration.log` 第 2-8 行。
*   **工具注册**：
    *   注册 `dsh-codewiki` 插件，包含 `cw`, `codewiki_generate`, `codewiki_progress` 等工具。
    *   **来源**：`.tmp-test-orchestration.log` 第 10-20 行。
*   **`codewiki_update` 逻辑**：
    *   Scope 强制为 `auto`。
    *   透传生成结果（submitted/jobId）。
    *   根据编译完成时间与 `.codewiki` 最后提交时间的对比，决定是否注入“继续下一项”引导 note。
    *   **来源**：`.tmp-test-orchestration.log` 第 22-50 行。
*   **会话唤醒 (`wakeCompileSession`)**：
    *   Done/Fail 消息含标题、任务 ID、提交指引。
    *   Source 标记为 `plugin/codewiki`。
    *   静默处理 `registry.get` 或 `steer` 抛出的异常。
    *   **来源**：`.tmp-test-orchestration.log` 第 52-64 行。
*   **规划阶段路由**：
    *   **主模型规划**：使用 `ctx.llm.stream`，避开 32k 低价档限制，JSON 计划被解析入库。
    *   **降级路径**：回退至百炼端点。
    *   **面板提交**：无发起会话时不碰 `ctx.llm`，走百炼批量。
    *   **来源**：`.tmp-test-orchestration.log` 第 66-100 行。
*   **全量编译 (`codewiki_generate`)**：
    *   提交即返回 jobId，初始 stage=`plan`。
    *   服务推进阶段机（规划→模块→横切→校对→索引）。
    *   终态唤醒发起会话，所有文件落盘并经校对回写。
    *   **来源**：`.tmp-test-orchestration.log` 第 102-130 行。
*   **横切精准拆分**：
    *   当模块文章总量超预算时，拆分为观察任务（Map）+ 合成批（Reduce）。
    *   合成请求输入不含原文全文，只吃观察结果。
    *   **来源**：`.tmp-test-orchestration.log` 第 132-160 行。
*   **文章阶段分割**：
    *   模块源码超预算时，拆分为 4 个观察批 + 2 个合成请求。
    *   零请求超 32k 档（无 3 倍价明示）。
    *   **来源**：`.tmp-test-orchestration.log` 第 162-190 行。
*   **全程百炼普通端点**：
    *   所有请求打 `chat/completions`，零专用批量端点。
    *   TPS 采样聚合，Usage 输出实测/请求数累计。
    *   **来源**：`.tmp-test-orchestration.log` 第 192-220 行。
*   **Stale 逐篇更新**：
    *   预构建任务直达 articles 阶段。
    *   恰好更新声明了变更的源文件对应的文章，未变更文章不动。
    *   **来源**：`.tmp-test-orchestration.log` 第 222-240 行。
*   **进度查询 (`codewiki_progress`)**：
    *   按 cwd/jobId 过滤，支持百分比与明细，渲染输出含任务头/stage/完成标记。
    *   **来源**：`.tmp-test-orchestration.log` 第 242-260 行。
*   **宿主重启恢复 (0.6.0)**：
    *   任务按持久化 prompt 快照重跑至终态。
    *   旧格式任务重跑走普通端点。
    *   **来源**：`.tmp-test-orchestration.log` 第 262-280 行。
*   **并发提交与 Flush**：
    *   共享同一 job，flush 合并后另一实例 job 不丢失。
    *   **来源**：`.tmp-test-orchestration.log` 第 282-290 行。
*   **面板端点 (GET/POST)**：
    *   Loopback 守卫（非回环 403）。
    *   Jobs 列表含活动任务、batchProgress、tps，不泄漏 apiKey。
    *   取消请求接受，终态 cancelled，中断在途请求（不计费）。
    *   **来源**：`.tmp-test-orchestration.log` 第 292-320 行。
*   **版本演进特性**：
    *   **0.4.7**: 排除清单、仓库总览、compile 动作幂等。
    *   **0.4.8**: knownRepos 登记独立于 job 历史，refresh 清缓存。
    *   **0.4.9**: jobs/repos 端点按 workspaceOnly 过滤。
    *   **0.4.10**: registry 抛错时过滤降级停用，不过滤数据；generate 输出过 schema 校验。
    *   **0.4.11.2**: foreign 孤儿任务按停更超时接管。
    *   **来源**：`.tmp-test-orchestration.log` 第 322-400+ 行。

### 5. `.tmp-test-wiki-anchors.log` (锚点校验)
*   **校验范围**：15 篇文章，涉及 `index.js` (2508 行) 和 `client.js` (1100 行)。
*   **校验项**：
    *   起始行在行数范围内。
    *   指向非空代码行。
    *   **符号绑定**：指定的函数/变量应出现在指定行。
*   **结果**：122 过 / 36 败。失败案例多为符号绑定不准确（如 `parseStatus` 不在预期行）。
*   **来源**：`.tmp-test-wiki-anchors.log` 全文。

### 6. `.tmp-test-wiki-entry.log` (入口文件)
*   **生成逻辑**：缺失入口时返回 true 并生成文件，正文含 `.codewiki` 绝对路径、收尾工具名 `codewiki_generate`、架构总览指引。
*   **幂等性**：已有入口时返回 false，不覆盖内容。
*   **路径规范化**：`\` → `/`，undefined 安全返回空串。
*   **状态解析**：`changedFiles` 保留并规范化，`staleArticles` 路径规范化。
*   **链接规范化**：`normalizeIndexLinks` 处理链接头 `\` → `/`，幂等。
*   **来源**：`.tmp-test-wiki-entry.log` 全文。

### 7. `watcher2.log` (Watcher 运行日志)
*   **格式**：`<duration>ms mtime=<timestamp> job=<jobId> plan=<status> cancelReq=<value> upd=<updateTime> notes=<count>`
*   **行为**：
    *   持续监控多个 Job ID (`job-muwdk1pk-2`, `job-muwdmx5z-0`, `job-muwdn4lx-2`)。
    *   记录时间戳变化（mtime）和更新时间（upd）。
    *   显示大量的 `plan` 状态更新，间隔从几十毫秒到几秒不等。
    *   `cancelReq` 始终为 `undefined`，表示未被取消。
    *   `notes` 计数通常为 1，偶尔为 0。
*   **来源**：`watcher2.log` 全文。

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        Runtime Artifacts                             │
│                                                                      │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────────┐  │
│  │ .probe3.txt │    │ .tmp-test-*.log  │    │ watcher2.log       │  │
│  │ (Probe)     │    │ (Test/Batch Log) │    │ (Watcher Heartbeat)│  │
│  └─────────────┘    └──────────────────┘    └────────────────────┘  │
│           ▲                  ▲                      ▲                │
│           │                  │                      │                │
│  ┌────────▼──────────────────▼──────────────────────▼──────────┐     │
│  │              Core Orchestration & Batch Engine               │     │
│  │                                                              │     │
│  │  • estimateTokens / collectSources                           │     │
│  │  • prepareArticleTasks (Splitting/Mapping)                   │     │
│  │  • runRealtimeTasks (DashScope/Budget/Thinking)              │     │
│  │  • localPlan / packArticles                                  │     │
│  │  • resolveBatchApiKey                                        │     │
│  └──────────────────────────────────────────────────────────────┘     │
│           ▲                                                          │
│           │                                                          │
│  ┌────────▼────────────────────────────────────────────────────────┐ │
│  │                     High-Level Workflow                         │ │
│  │                                                                 │ │
│  │  • codewiki_generate (Submit/Stage/Finish)                      │ │
│  │  • codewiki_update (Auto Scope/Hint Text)                       │ │
│  │  • wakeCompileSession (Steer/Notify)                            │ │
│  │  • Panel APIs (Jobs/Control/Loopback Guard)                     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow

1.  **初始化与探针**：
    *   系统启动时检查 `.probe3.txt` 是否存在，确认模块环境正常。
    *   `watcher2.log` 开始轮询或监听文件变更，记录 Job 状态更新。

2.  **任务准备**：
    *   `scanRepoFiles` 扫描源码，过滤黑名单。
    *   `estimateTokens` 计算 Token 用量。
    *   `prepareArticleTasks` 根据预算（28k/200k）决定是直接装入 Prompt、拆分观察批还是标记 oversized。
    *   `resolveBatchApiKey` 获取百炼 API Key。

3.  **执行与编排**：
    *   **规划阶段**：可选走主模型 (`ctx.llm.stream`) 或百炼端点。
    *   **文章阶段**：通过 `runRealtimeTasks` 发送同步请求至 `dashscope.aliyuncs.com`。
        *   若 `budget=0`，禁用思考；若 `budget>0`，启用思考并设置 `thinking_budget`。
        *   结果落盘或保留在内存 (`keepInMemory`)。
    *   **横切/合成**：若超预算，Map 出观察任务，Reduce 出合成任务。

4.  **输出与校验**：
    *   生成的 Markdown 文件进入 `.codewiki/` 目录。
    *   `normalizeIndexLinks` 和 `normalizeArticlePath` 确保路径一致性。
    *   `.tmp-test-wiki-anchors.log` 校验生成的锚点是否指向正确的源码行和符号。
    *   `.tmp-test-wiki-entry.log` 确保入口文件 `CodeWiki.md` 正确生成且幂等。

5.  **状态反馈**：
    *   `codewiki_progress` 提供实时进度查询。
    *   `wakeCompileSession` 将终态结果通知给发起会话。
    *   `watcher2.log` 持续记录长任务的中间状态。

## Connections

*   [[code-generation]]: `runtime-artifacts` 依赖于代码生成模块输出的 Markdown 文件进行锚点校验。
*   [[llm-integration]]: `runRealtimeTasks` 直接对接百炼 LLM 端点，受 Token 预算控制。
*   [[file-system]]: `scanRepoFiles` 和 `packArticles` 深度依赖文件系统操作，处理路径规范化。
*   [[panel-api]]: `codewiki_progress` 和面板端点暴露运行时状态供外部查询。