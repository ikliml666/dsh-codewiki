---
title: test-suite
type: module
source_files:
  - index.js
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
tags: [testing, automation, orchestration, wiki-validation]
---

## Overview
`test-suite` 是 CodeWiki 项目的自动化测试集合，旨在验证核心功能、路径处理逻辑、服务编排流程及 Wiki 内容的完整性。该套件覆盖从底层工具函数（如 Token 估算、源码收集）到高层服务化编排（如 `codewiki_generate` 提交、阶段机推进、并发控制）的全链路测试。此外，它还包含针对 Wiki 文章行号锚点准确性的静态校验，以及入口文件生成的单元测试。

## Key Components

### 1. test-batch.mjs — 编译执行链自检
**用途**：验证纯函数逻辑、Mock 网络请求、本地规划及凭证解析。
**关键函数与逻辑**：
*   **`estimateTokens` (L27-L30)**：CJK 字符每字 1 token，ASCII 字符每 3.5 字 1 token。
*   **`collectSources` (L33-L46)**：收集源码并估算 Token 预算。处理缺失文件标注、超大文件兜底（`oversized`）及预算不足时的跳过（`skipped`）。
*   **`prepareArticleTasks` (L49-L86)**：装配编译任务 Prompt。处理普通任务、超大文件升档（200k）、以及旧文上下文注入。
*   **`runRealtimeTasks` (L89-L158)**：模拟百炼普通端点并发池。支持思考参数配置（`enable_thinking`, `thinking_budget`）、外部 Signal 中止、失败记账（`notes`）及磁盘/内存落盘。
*   **`localPlan` (L161-L169)**：顶层目录分组规划，用于兜底架构分析。
*   **`packArticles` (L172-L181)**：横切输入装填，超预算时仅保留头部并标注。
*   **`scanRepoFiles` (L184-L197)**：仓库勘探，过滤黑名单（node_modules, .git）、二进制、超大及空文件。
*   **`resolveBatchApiKey` (L200-L222)**：凭证解析链，优先级为显式配置 > 宿主凭据库。

### 2. test-cwd-paths.mjs — 工作目录路径修复验证
**用途**：验证 CW CLI 在 Windows 和 MSYS 路径下的兼容性及路径规范化。
**关键逻辑**：
*   **`cw.execute` (L35-L40)**：调用注册的 `cw` 工具，验证 `path` 和 `status` 命令在不同 CWD 形态下的行为。
*   **MSYS 路径处理 (L43-L53)**：将 Windows 路径转换为 MSYS 形式（`E:/x` → `/e/x`），验证归一化后能正确执行。
*   **Windows 路径状态 (L56-L63)**：验证 `cw status` 返回真实的三态结果，而非 "No wiki found"。
*   **错误处理 (L66-L71)**：验证不存在的路径抛出包含 "cwd 不存在" 的清晰错误。

### 3. test-orchestration.mjs — 服务化编排冒烟测试
**用途**：验证 `dsh-codewiki` 插件的服务化生命周期，包括提交、阶段机推进、并发控制、面板端点及持久化恢复。
**关键组件与流程**：
*   **`makeCtx` (L65-L105)**：构建模拟宿主上下文，捕获 `webServer`, `credentials`, `agents`, `tools` 等依赖。
*   **`makeBatchMock` (L135-L175)**：Mock 百炼普通端点（`chat/completions`），根据 Prompt 特征分发应答（勘探员、作者、审校员等角色）。
*   **`waitJob` (L178-L190)**：轮询 JOBS_FILE 等待 Job 终态。
*   **系统提示提醒 (L195-L225)**：验证 `.codewiki` 存在且根目录有 `CodeWiki.md` 时注入更新提醒，否则不注入。
*   **全量编译阶段机 (L230-L265)**：验证 `plan` → `articles` → `crosscut` → `review` → `index` 全流程，检查文件落盘及校对回写。
*   **大 Wiki 横切拆分 (L268-L296)**：验证模块文章超预算时，观察任务并发执行及合成批处理。
*   **Stale 逐篇更新 (L299-L323)**：验证代码变更触发特定文章过期并重新编译。
*   **`codewiki_progress` (L326-L365)**：验证进度查询工具的过滤、百分比计算及渲染输出。
*   **宿主重启恢复 (L368-L415)**：验证持久化的 Job 快照在服务重启后自动重跑至终态。
*   **并发提交占位 (L418-L450)**：验证多实例并发提交时的幂等性及 Flush 合并。
*   **面板端点与取消 (L453-L505)**：验证 `/api/codewiki/jobs` 和 `/api/codewiki/control` 端点，包括 Loopback 守卫、中间进度透出及取消操作。
*   **排除清单与总览 (L508-L545)**：验证 `excludePaths` 配置对 Compile 和直调的拦截，以及 Repos 总览的状态标记。
*   **KnownRepos 登记 (L548-L585)**：验证已知仓库独立于 Job 历史的登记机制及 Refresh 动作。
*   **工作区过滤 (L588-L625)**：验证 `workspaceOnly` 配置对 Jobs 和 Repos 端点的过滤效果。
*   **Registry 异常防御 (L628-L655)**：验证 `workspaceRegistry.list()` 抛错时端点降级不过滤。
*   **孤儿任务接管 (L658-L685)**：验证陈旧 Foreign Job 被新实例接管并取消。
*   **无凭证报错 (L688-L695)**：验证缺少 API Key 时诚实报错，无子代理回退。

### 4. test-wiki-anchors.mjs — Wiki 文章行号锚点校验
**用途**：静态扫描 `.codewiki` 下的 Markdown 文件，验证源码引用行号的准确性。
**关键逻辑**：
*   **`walk` (L35-L42)**：递归读取所有 `.md` 文章。
*   **`symbolsOnLine` (L45-L56)**：提取行内反引号中的代码标识符。
*   **锚点断言 (L65-L95)**：
    *   验证 `index.js:NN` 或 `client.js:NN` 的行号在文件范围内。
    *   验证指向的代码行非空。
    *   验证区间起止有序。
    *   验证符号绑定：源文件对应行必须包含标识符或其尾部名称。

### 5. test-wiki-entry.mjs — 入口自动生成测试
**用途**：验证 `ensureWikiEntry` 生成逻辑及路径规范化函数。
**关键函数与逻辑**：
*   **`ensureWikiEntry` (L10-L20)**：若 `CodeWiki.md` 缺失则生成（含绝对路径指引、双语文案），已有则不覆盖。
*   **`normalizeArticlePath` (L25-L27)**：将 Windows `\` 分隔路径统一为 POSIX `/`。
*   **`parseStatus` (L28-L30)**：解析 `cw status` 输出，规范化 `changedFiles` 和 `staleArticles`。
*   **`normalizeIndexLinks` (L33-L38)**：修正 `_index.md` 中的链接路径分隔符，不影响正文内容。

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                      Test Suite (Node.js)                   │
├──────────────┬──────────────────┬──────────────────────────┤
│ Core Tests   │ Orchestration    │ Wiki Validation          │
│ (test-batch) │ (test-orch)      │ (test-wiki-*)            │
├──────────────┼──────────────────┼──────────────────────────┤
│ • estimateTokens │ • makeCtx (Host Mock) │ • walk (File Scan) │
│ • collectSources │ • makeBatchMock (API) │ • anchor Check     │
│ • runRealtimeTasks│ • waitJob (Polling)   │ • symbol Bind      │
│ • localPlan      │ • Stage Machine Flow  │                  │
│ • scanRepoFiles  │ • Endpoint Handlers   │                  │
│ • resolveApiKey  │ • Persistence Recovery│                  │
└──────────────┴──────────────────┴──────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│              Shared Infrastructure                          │
├─────────────────────────────────────────────────────────────┤
│ • index.js (Core Logic & Exports)                           │
│ • CW CLI (External Binary for Path/Status)                  │
│ • DashScope API (Mocked via globalThis.fetch)               │
│ • File System (fs, os, path for Temp Repos)                 │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

1.  **Initialization**: Test scripts import functions from `index.js`. Environment variables like `DSH_CODEWIKI_TICK_MS` and `DSH_CODEWIKI_JOBS_FILE` are set to isolate tests.
2.  **Mocking**: `globalThis.fetch` is replaced with custom handlers in `test-batch.mjs` and `test-orchestration.mjs` to simulate API responses without network calls.
3.  **Execution**:
    *   **Unit**: Functions are called directly with temporary file system setups (`fs.mkdtempSync`). Results are checked against expected values.
    *   **Orchestration**: A mock host context (`makeCtx`) is created. The plugin `apply` function registers tools. `codewiki_generate` is executed, submitting a Job to the persistent JSON file. A polling loop (`waitJob`) monitors the Job's progress through stages until completion.
    *   **Wiki Validation**: Articles are read from disk. Regex matches extract anchor references. Source files are parsed line-by-line to verify existence and content correctness.
4.  **Cleanup**: Temporary directories and modified files are removed using `fs.rmSync` or specific cleanup logic within the test blocks.

## Connections
*   [[modules/test-batch]]: Core functional tests.
*   [[modules/test-orchestration]]: Service lifecycle tests.
*   [[modules/test-wiki-anchors]]: Content integrity checks.
*   [[modules/test-wiki-entry]]: Entry point generation logic.
*   [[modules/index]]: The main module under test, providing all exported utilities and plugin logic.