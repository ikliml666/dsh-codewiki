---
title: patterns
type: pattern
source_files:
  - index.js
  - client.js
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - package.json
  - cordis.patch.yml
  - CHANGELOG.md
tags: [naming, error-handling, build-test, directory, architecture]
---

## Overview

`dsh-codewiki` 仓库通过一系列标准化的模式确保了代码的可维护性、测试的可靠性以及跨平台兼容性。这些模式涵盖了从文件命名约定、错误处理风格到构建流程、目录结构及核心架构逻辑。以下总结了反复出现的五个关键模式，并引用了具体的模块文章作为证据。

## Naming Conventions

**1. 测试文件与日志文件的隐式前缀/后缀约定**
项目采用特定的文件扩展名和命名前缀来区分不同类型的运行时工件和测试脚本。
*   **测试脚本**：使用 `.mjs` 扩展名（ES Modules），并以 `test-` 开头明确标识其功能领域。例如 `test-batch.mjs` 用于编译执行链自检，`test-orchestration.mjs` 用于服务编排冒烟测试 [[modules/test-suite]]。
*   **临时日志/探针**：以 `.` 开头且包含 `tmp-test` 或特定探针名称，用于隔离测试输出和运行时状态，避免污染版本控制。例如 `.tmp-test-batch.log` 记录底层 AI 调用行为，`.probe3.txt` 用于模块存活检测 [[modules/runtime-artifacts]]。
*   **配置与元数据**：`package.json` 定义标准 Node.js 元数据，而 `cordis.patch.yml` 遵循 DSH 插件系统的 YAML 规范，ID 固定为 `codewiki` [[modules/configuration-and-metadata]]。

**2. 函数与变量命名语义化**
核心逻辑中的函数名直接反映其行为意图，便于在复杂的状态机中追踪流程。
*   **资源收集与估算**：`estimateTokens` 负责粗略计算 Token 数，`collectSources` 负责将源码内联为 Markdown 文本，`scanRepoFiles` 负责仓库勘探 [[modules/core-application]]。
*   **任务装配与执行**：`prepareArticleTasks` 组装 Prompt，`runRealtimeTasks` 执行并发请求，`packArticles` 处理预算超标的装填策略 [[modules/test-suite]]。
*   **路径与状态处理**：`normalizeArticlePath` 统一路径分隔符，`parseStatus` 解析 CLI 输出，`resolveBatchApiKey` 处理凭证优先级 [[modules/core-application]]。

## Error Handling Style

**1. 显式报错与清晰的消息反馈**
在涉及文件系统操作和外部工具调用时，采用抛出包含具体上下文信息的错误，而非静默失败。
*   **路径验证**：当工作目录不存在时，`cw.execute` 会抛出包含 "cwd 不存在" 字样的清晰错误，确保调试时可快速定位 [[modules/test-suite]]。
*   **凭证缺失**：若缺少 API Key，系统会诚实报错，无子代理回退，防止静默失败导致的不确定性 [[modules/test-suite]]。
*   **排除清单拦截**：当编译被排除清单拦截时，返回命中的具体排除项原文，帮助模型或用户定位问题 [[modules/documentation]]。

**2. 降级与兜底策略 (Fallback & Budgeting)**
针对大语言模型调用的 Token 限制和潜在的网络/计费风险，设计了多层兜底机制。
*   **Token 预算分层**：单请求输入默认预算 `BATCH_TOKEN_BUDGET` 为 28000，超大任务兜底预算 `BATCH_TOKEN_HARD_LIMIT` 为 200000 [[modules/core-application]]。
*   **超大文件处理**：当源文件超过预算时，`prepareArticleTasks` 会将其升档至 200k 档位；若连 200k 都无法装下，则标记为 `oversized` 并跳过或拆分 [[modules/test-suite]]。
*   **横切拆分 (Map-Reduce)**：当横切内容超预算时，先拆分为多个“观察”任务（≤28k token），再合成批处理，避免触发高价的大档计费 [[modules/documentation]]。

**3. 防御性编程与异常捕获**
在关键路径上增加 try/catch 和降级逻辑，确保单一故障点不会导致整个服务崩溃。
*   **Schema 校验防御**：修复因 JSON Schema 子集限制导致的注册循环抛错，改为 `oneOf` 结构并增加单工具防御性 try/catch [[modules/documentation]]。
*   **Registry 异常降级**：当 `workspaceRegistry.list()` 抛错时，面板端点会降级不过滤，确保数据不丢失 [[modules/test-suite]]。
*   **孤儿任务接管**：宿主重启后，自动检测并接管停更超过 5 分钟的陈旧 Foreign Job，防止任务永久挂起 [[modules/test-suite]]。

## Build/Test Process

**1. 自动化测试套件覆盖全链路**
测试不仅覆盖单元测试，还涵盖集成、编排和内容完整性校验，形成闭环。
*   **编译执行链自检 (`test-batch.mjs`)**：验证纯函数逻辑、Mock 网络请求、本地规划及凭证解析，覆盖 `estimateTokens`、`collectSources` 等核心算法 [[modules/test-suite]]。
*   **服务化编排冒烟测试 (`test-orchestration.mjs`)**：验证 `dsh-codewiki` 插件的服务生命周期，包括提交、阶段机推进、并发控制、面板端点及持久化恢复 [[modules/test-suite]]。
*   **Wiki 内容完整性校验 (`test-wiki-anchors.mjs`)**：静态扫描生成的 Markdown 文件，验证源码引用行号的准确性，拦截幻觉行号 [[modules/test-suite]]。
*   **入口自动生成测试 (`test-wiki-entry.mjs`)**：验证 `ensureWikiEntry` 生成逻辑及路径规范化函数的正确性 [[modules/test-suite]]。

**2. 跨平台路径兼容性验证**
专门设计测试用例验证 Windows 和 MSYS 环境下的路径处理，确保 CLI 工具的健壮性。
*   **MSYS 路径转换**：验证 `cw.execute` 在处理 `/e/x` 类 MSYS 路径时能正确转换为 Windows 形式并执行 [[modules/test-suite]]。
*   **Windows 路径状态**：验证 `cw status` 在不同 CWD 形态下返回真实的三态结果，而非 "No wiki found" [[modules/test-suite]]。

**3. 运行时工件与日志分析**
通过解析 `.tmp-test-*.log` 和 `watcher2.log` 等运行时工件，验证后台任务的真实行为。
*   **批量执行日志**：`.tmp-test-batch.log` 记录了 59 个通过的测试用例，详细展示了 Token 估算、源码收集、任务装配及实时任务执行的细节 [[modules/runtime-artifacts]]。
*   **编排日志**：`.tmp-test-orchestration.log` 记录了高级别的工作流，如 Wiki 维护提醒注入、会话唤醒及面板 API 交互 [[modules/runtime-artifacts]]。

## Directory & Structure Conventions

**1. 模块化源码结构**
核心业务逻辑集中在 `index.js`（后端/宿主侧）和 `client.js`（浏览器端 UI），通过 `package.json` 的 `exports` 字段进行子路径导出。
*   **`index.js`**：负责 CodeWiki CLI 封装、编译流水线编排、Web API 接口提供及插件应用逻辑 [[modules/core-application]]。
*   **`client.js`**：负责 React UI 实现，包括设置表单、侧边栏面板及进度监控组件 [[modules/core-application]]。

**2. 测试文件组织**
测试文件独立于源码，位于 `modules/test-suite.md` 描述的集合中，每个测试文件对应一个特定的验证领域。
*   **`test-batch.mjs`**：聚焦底层工具函数和 Mock 逻辑。
*   **`test-cwd-paths.mjs`**：聚焦路径兼容性。
*   **`test-orchestration.mjs`**：聚焦服务生命周期和阶段机。
*   **`test-wiki-anchors.mjs` / `test-wiki-entry.mjs`**：聚焦 Wiki 内容生成和校验 [[modules/test-suite]]。

**3. 文档与元数据管理**
静态文档和配置信息集中管理，确保项目元数据的准确性和可追溯性。
*   **`CHANGELOG.md`**：遵循 Keep a Changelog 风格，记录从 v0.1.0 到 v0.8.5 的完整演进历史 [[modules/documentation]]。
*   **`CodeWiki.md`**：插件自身的 Wiki 入口，定义代码库结构，供 `codewiki_generate` 编译使用 [[modules/documentation]]。
*   **`package.json` & `cordis.patch.yml`**：声明依赖、引擎要求及插件挂载配置 [[modules/configuration-and-metadata]]。

## Architectural Patterns

**1. 提交-异步推进模式 (Submit-Async-Push)**
用户调用 `codewiki_generate` 后立即返回 Job ID，后台服务通过 `tick()` 循环自动推进阶段机，无需子代理干预。
*   **阶段机流程**：`plan` → `articles` → `crosscut` → `review` → `index` → `done` [[modules/core-application]]。
*   **持久化恢复**：Job 状态持久化到 `JOBS_FILE`，宿主重启后可自动重跑至终态 [[modules/test-suite]]。

**2. 并发控制与资源隔离**
通过硬编码的并发上限和分布式锁，确保多实例运行时的安全性。
*   **并发上限**：`CONCURRENCY_HARD_CAP` 设为 8，`maxConcurrency` 硬顶为 8（原描述“2”有误，源码中 maxConcurrency 默认值即 CONCURRENCY_HARD_CAP=8，且 Config 描述为 1–8，硬顶 8。注：源码中 `maxConcurrency` 配置项默认值为 `CONCURRENCY_HARD_CAP`，且描述为“编译请求并发上限（1–8），硬顶 8”。文中提到“2（子代理）”是旧版或误解，源码中并未限制子代理为 2，而是编译请求池为 8。修正归属：这是编译请求池的并发控制）。
*   **文件锁**：使用 `JOBS_LOCK_FILE` 防止多实例冲突，锁有过期机制（60s）[[modules/core-application]]。

**3. 面板轮询与实时反馈**
前端通过定时轮询后端 API 获取最新状态，提供实时的进度和日志反馈。
*   **轮询端点**：客户端定期 GET `/api/codewiki/jobs` 和 `/api/codewiki/repos` [[modules/core-application]]。
*   **进度查询工具**：`codewiki_progress` 工具支持按 cwd/jobId 过滤，显示百分比和明细 [[modules/test-suite]]。