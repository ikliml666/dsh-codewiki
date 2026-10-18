---
title: test-suite
type: module
source_files:
  - modules/test-suite/index.js
  - modules/test-suite/test-batch.mjs
  - modules/test-suite/test-cwd-paths.mjs
  - modules/test-suite/test-orchestration.mjs
  - modules/test-suite/test-wiki-anchors.mjs
  - modules/test-suite/test-wiki-entry.mjs
tags: [testing, automation, orchestration, wiki-validation]
---

## Overview
`test-suite` 是 `dsh-codewiki` 插件的自动化测试集合，旨在验证核心功能、路径处理逻辑、服务编排流程及 Wiki 内容的完整性。该套件覆盖从底层工具函数（如 Token 估算、源码收集）到高层服务化编排（如 `codewiki_generate` 提交、阶段机推进、并发控制）的全链路测试。此外，它还包含针对 Wiki 文章行号锚点准确性的静态校验，以及入口文件生成的单元测试。

## Key Components

### 1. test-batch.mjs — 编译执行链自检
**用途**：验证纯函数逻辑、Mock 网络请求、本地规划及凭证解析。
**关键函数与逻辑**：
*   **`estimateTokens` (index.js:209-218)**：CJK 字符每字 1 token，ASCII 字符每 3.5 字 1 token。空串返回 0。
*   **`collectSources` (index.js:267-294)**：收集源码并估算 Token 预算。处理缺失文件标注、超大文件兜底（`oversized`）及预算不足时的跳过（`skipped`）。
    *   返回值结构：`{ text, skipped, oversized }`。
    *   预算不足时：若首文件即超预算，标记 `oversized=true`；否则跳过后续文件至 `skipped`。
*   **`prepareArticleTasks` (index.js:321-376)**：装配编译任务 Prompt。处理普通任务、超大文件升档（200k）、以及旧文上下文注入。
    *   **超大文件处理**：单文件 >28k token 升档至 200k（`big.ts` 测试 [test-batch.mjs:76]）；>200k 标记为 `oversized`（`huge.ts` 测试 [test-batch.mjs:82]）。
    *   **多文件分割**：多文件总超预算时，拆分为多个 `#obs` 观察任务，设置 `keepInMemory=true`，并携带 `composePlan` 指向目标文章 [test-batch.mjs:90-105]。
*   **`runRealtimeTasks` (index.js:239-264)**：模拟百炼普通端点并发池。支持思考参数配置（`enable_thinking`, `thinking_budget`）、外部 Signal 中止、失败记账（`notes`）及磁盘/内存落盘。
    *   入参 `concurrency` 控制并行度。
    *   支持 `signal` 中止 [test-batch.mjs:155]。
    *   失败不中断其他任务，错误记录进 `notes` [test-batch.mjs:170]。
    *   思考参数透传：`thinkingBudget=0` 时 `enable_thinking=false` 且无 `thinking_budget` 键；`budget>0` 时开启 [test-batch.mjs:135]。
*   **`localPlan` (index.js:405-416)**：顶层目录分组规划，用于兜底架构分析。
*   **`packArticles` (index.js:419-433)**：横切输入装填，超预算时仅保留头部并标注。
*   **`scanRepoFiles` (index.js:473-502)**：仓库勘探，过滤黑名单（node_modules, .git）、二进制、超大及空文件。
*   **`resolveBatchApiKey` (index.js:307-330)**：凭证解析链，优先级为显式配置 > 宿主凭据库。注入失败或无条目返回 `null`。

### 2. test-cwd-paths.mjs — 工作目录路径修复验证
**用途**：验证 CW CLI 在 Windows 和 MSYS 路径下的兼容性及路径规范化。
**关键逻辑**：
*   **`cw.execute` (index.js:441-462)**：调用注册的 `cw` 工具，验证 `path` 和 `status` 命令在不同 CWD 形态下的行为。
*   **MSYS 路径处理 (index.js:23-31)**：将 Windows 路径转换为 MSYS 形式（`E:/x` → `/e/x`），验证归一化后能正确执行。
*   **Windows 路径状态 (test-cwd-paths.mjs:54-62)**：验证 `cw status` 返回真实的三态结果，而非 "No wiki found"。
*   **错误处理 (index.js:447-448)**：验证不存在的路径抛出包含 "cwd 不存在" 的清晰错误。

### 3. test-orchestration.mjs — 服务化编排冒烟测试
**用途**：验证 `dsh-codewiki` 插件的服务化生命周期，包括提交、阶段机推进、并发控制、面板端点及持久化恢复。
**关键组件与流程**：
*   **`makeCtx` (test-orchestration.mjs:56-106)**：构建模拟宿主上下文，捕获 `webServer`, `credentials`, `agents`, `tools` 等依赖。
    *   支持 `inject` 回调模式、`effect` disposer 收集、`credentials` 解析、`agents` 列表等。
*   **`makeBatchMock` (test-orchestration.mjs:135-180)**：Mock 百炼普通端点（`chat/completions`），根据 Prompt 特征分发应答（勘探员、作者、审校员等角色）。
    *   Mock Fetch 结构：[test-batch.mjs:24] `mockJson(obj, status)` 构造符合 `ok/status/text()` 规范的 Response-like 对象。
*   **`waitJob` (test-orchestration.mjs:183-196)**：轮询 JOBS_FILE 等待 Job 终态 (`done/failed/cancelled`)。
*   **系统提示提醒 (test-orchestration.mjs:200-240)**：验证 `.codewiki` 存在且根目录有 `CodeWiki.md` 时注入更新提醒，否则不注入。
*   **全量编译阶段机 (test-orchestration.mjs:322-355)**：验证 `plan` → `articles` → `crosscut` → `review` → `index` 全流程，检查文件落盘及校对回写。
*   **大 Wiki 横切拆分 (test-orchestration.mjs:358-384)**：验证模块文章超预算时，观察任务并发执行及合成批处理。
*   **Stale 逐篇更新 (test-orchestration.mjs:387-408)**：验证代码变更触发特定文章过期并重新编译。
*   **`codewiki_progress` (test-orchestration.mjs:411-438)**：验证进度查询工具的过滤、百分比计算及渲染输出。
*   **宿主重启恢复 (test-orchestration.mjs:441-486)**：验证持久化的 Job 快照在服务重启后自动重跑至终态。
*   **并发提交占位 (test-orchestration.mjs:489-522)**：验证多实例并发提交时的幂等性及 Flush 合并。
*   **面板端点与取消 (test-orchestration.mjs:525-564)**：验证 `/api/codewiki/jobs` 和 `/api/codewiki/control` 端点，包括 Loopback 守卫、中间进度透出及取消操作。
*   **排除清单与总览 (test-orchestration.mjs:567-603)**：验证 `excludePaths` 配置对 Compile 和直调的拦截，以及 Repos 总览的状态标记。
*   **KnownRepos 登记 (test-orchestration.mjs:606-636)**：验证已知仓库独立于 Job 历史的登记机制及 Refresh 动作。
*   **工作区过滤 (test-orchestration.mjs:639-666)**：验证 `workspaceOnly` 配置对 Jobs 和 Repos 端点的过滤效果。
*   **Registry 异常防御 (test-orchestration.mjs:669-690)**：验证 `workspaceRegistry.list()` 抛错时端点降级不过滤。
*   **孤儿任务接管 (test-orchestration.mjs:693-722)**：验证陈旧 Foreign Job 被新实例接管并取消。
*   **无凭证报错 (test-orchestration.mjs:725-734)**：验证缺少 API Key 时诚实报错，无子代理回退。

### 4. test-wiki-anchors.mjs — Wiki 文章行号锚点校验
**用途**：静态扫描 `.codewiki` 下的 Markdown 文件，验证源码引用行号的准确性。
**关键逻辑**：
*   **`walk` (test-wiki-anchors.mjs:53-60)**：递归读取所有 `.md` 文章。
*   **`symbolsOnLine` (test-wiki-anchors.mjs:38-49)**：提取行内反引号中的代码标识符（支持点分命名空间）。
*   **锚点断言 (test-wiki-anchors.mjs:63-91)**：
    *   验证 `index.js:NN` 或 `client.js:NN` 的行号在文件范围内。
    *   验证指向的代码行非空。
    *   验证区间起止有序。
    *   验证符号绑定：源文件对应行必须包含标识符或其尾部名称。

### 5. test-wiki-entry.mjs — 入口自动生成测试
**用途**：验证 `ensureWikiEntry` 生成逻辑及路径规范化函数。
**关键函数与逻辑**：
*   **`ensureWikiEntry` (index.js:139-180)**：若 `CodeWiki.md` 缺失则生成（含绝对路径指引、双语文案），已有则不覆盖。
    *   中文文案特征：包含 `.codewiki` 绝对路径、`codewiki_generate`、`.codewiki/_architecture.md`、`不会覆盖` [test-wiki-entry.mjs:27-30]。
    *   英文文案特征：包含 `living wiki`，不包含 `活 wiki` [test-wiki-entry.mjs:45-46]。
*   **`normalizeArticlePath` (index.js:106)**：将 Windows `\` 分隔路径统一为 POSIX `/`。
*   **`parseStatus` (index.js:113-128)**：解析 `cw status` 输出，规范化 `changedFiles` 和 `staleArticles`。
    *   `staleArticles` 中的 `\` 应被规范化为 `/` [test-wiki-entry.mjs:65]。
*   **`normalizeIndexLinks` (index.js:109-118)**：修正 `_index.md` 中的链接路径分隔符，不影响正文内容。
    *   核心难点在于区分“Markdown 链接语法中的路径”与“正文文本中的普通路径”。测试明确验证：`[[...\\...|...]]` 中的 `\` 被替换，但正文里的 `E:\ik\repo` 保持不变 [test-wiki-entry.mjs:74]。

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

## Known Issues
*   **Test Isolation**: Tests rely on environment variables (`DSH_CODEWIKI_*`) to isolate jobs files. If these are not set correctly, tests might interfere with real service instances running on the same machine.
*   **Mock Fidelity**: `makeBatchMock` simulates API responses based on prompt keywords. If prompt templates change significantly, mocks may need updates to ensure accurate behavior simulation.
*   **Timing Dependencies**: Some tests use `setTimeout` to wait for background processes (e.g., `waitJob`). While generally robust, extremely slow systems might cause timeouts if thresholds are too tight.