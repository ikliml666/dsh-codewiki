---
title: testing-suite
type: module
source_files: []
tags: [测试, 批量处理, 编排, 路径处理]
---

## Overview

`testing-suite` 是 CodeWiki 项目的核心验证层，由三个主要的 ESM 模块组成。它覆盖了从底层原子函数（Token 估算、源码装填）到高层服务化编排（阶段机、断点续查、并发控制）的全链路测试。该套件旨在确保在 Node.js ≥20 环境下，百炼普通入口编译流水线、工作目录路径规范化、以及 Wiki 入口生成的正确性。

## Key Components

### `test-batch.mjs`
**文件**: `modules/testing-suite/test-batch.mjs`
**用途**: 编译流水线自检，覆盖纯函数逻辑与 mock fetch 全流程。

| 组件/函数 | 行号区间 | 描述 |
| :--- | :--- | :--- |
| `check` | 15-18 | 断言助手，统计 `passed` 和 `failures` 计数。 |
| `mockJson` | 20 | 生成符合 Fetch API 规范的 Response 对象。 |
| `estimateTokens` | 24-27 | CJK 与 ASCII 粗算 Token 数。验证：CJK 每字 1 token，ASCII ceil(字符数/3.5)。 |
| `collectSources` | 30-43 | 源码装填与 Token 预算检查。验证：内联源码带标题、缺失文件标注、oversized 标志、skipped 列表。 |
| `prepareArticleTasks` | 53-101 | 任务装配。验证：prompt 含 mission/language/源码/旧文上下文、超大文件拆分（28k vs 200k）、oversized 转超大兜底。 |
| `classifySessionTask` | 104-118 | 会话任务三态判定：timeout/harvest/wait。 |
| `runRealtimeTasks` | 121-198 | 后台并发池（唯一执行器）。验证：并发执行、失败记账进 notes、keepInMemory 结果返回、失败不落盘。 |
| `localPlan` | 201-211 | 本地规划兜底。验证：按顶层目录分组（src/root/docs）。 |
| `packArticles` | 214-224 | 横切输入装填。验证：预算内整篇、超预算截断头部并标注、frontmatter 保留。 |
| `scanRepoFiles` | 227-240 | 仓库勘探黑名单。验证：跳过 node_modules/.git/二进制/超大/空文件。 |
| `resolveBatchApiKey` | 248-268 | 凭证解析链。验证：显式配置优先 > 宿主凭据库 > null 回退。 |
| `fixAnchors` | 271-312 | 锚点修正。基于 source_files 清单修正代码块引用行号，处理唯一性与歧义边界。 |

### `test-cwd-paths.mjs`
**文件**: `modules/testing-suite/test-cwd-paths.mjs`
**用途**: 验证 0.2.3 路径修复，覆盖 MSYS 和 Windows 路径形态。

| 组件/函数 | 行号区间 | 描述 |
| :--- | :--- | :--- |
| `plugin.apply` | 14-22 | 注册 `cw` 工具，通过 `ctx.inject` 捕获 tool 定义。 |
| `cw.execute` (MSYS) | 30-45 | 验证 MSYS 路径（如 `/e/x`）归一化后能正确执行 `cw path`。 |
| `cw.execute` (Windows) | 47-57 | 验证 Windows 路径（如 `E:/x`）下 `cw status` 返回真实三态而非 "No wiki found"。 |
| `cw.execute` (Invalid) | 61-69 | 验证不存在的路径干净报错（`cwd 不存在`）。 |

### `test-orchestration.mjs`
**文件**: `modules/testing-suite/test-orchestration.mjs`
**用途**: 服务化编排冒烟测试，验证阶段机、断点续查、面板端点及并发控制。

| 组件/函数 | 行号区间 | 描述 |
| :--- | :--- | :--- |
| `makeCtx` | 34-80 | 构造宿主上下文 Mock。支持 inject 两种风格、credentials 模拟、workspaceRegistry 异常模拟。 |
| `makeMockAgent` | 83-97 | 构造 Agent Mock。捕获 systemPrompt section 注册。 |
| `makeFixtureRepo` | 99-109 | 创建 Git 仓库 Fixture。 |
| `makeBatchMock` | 113-168 | Mock 百炼模型 API。按 custom_id 分发 plan/article/arch/patterns/concept/proof 应答。 |
| `waitJob` | 171-184 | 轮询 JOBS_FILE 等待 Job 终态。 |
| `fakeReq` / `fakeRes` | 186-198 | HTTP 请求/响应 Fake 对象构造器。 |
| `apply` (System Prompt) | 201-229 | 验证 `.codewiki` 存在且根有 `CodeWiki.md` 时才注入提醒，否则为空。 |
| `apply` (Tool Reg) | 232-248 | 验证 `cw`, `codewiki_generate`, `codewiki_progress` 注册成功。 |
| `commitHintText` | 252-328 | 包装器验证：scope 强制 auto，比较编译时间与提交时间决定是否注入提醒。 |
| `wakeCompileSession` | 331-356 | 终态实时唤醒发起会话（steer），含 source 标记 `plugin:codewiki`。 |
| `codewiki_generate` (Main Model Plan) | 358-507 | 主模型规划场景：Agent 带路由走 stream，非法 JSON 降级百炼，无 sessionId 走批量。 |
| `codewiki_generate` (Full Compile) | 509-539 | 全量编译验证：plan→articles→crosscut→review→index，校对回写，子代理零使用。 |
| `codewiki_generate` (Big Wiki) | 541-569 | 大 Wiki 横切拆分：观察任务 map + 合成批 reduce，避免单次 prompt 超限。 |
| `codewiki_generate` (Big Module) | 571-603 | 大模块文章分割：源文件超预算 → 观察批 map + 合成请求 reduce。 |
| `codewiki_generate` (Stale) | 638-659 | Stale 逐篇更新：仅更新声明了变更文件的关联文章。 |
| `codewiki_progress` | 661-697 | 进度验证：cwd/jobId 过滤，百分比计算，render 输出格式。 |
| `codewiki_generate` (Restart) | 698-752 | 宿主重启重跑：按快照恢复 stage-* 任务和旧格式 local 任务。 |
| `Concurrent Submit` | 754-791 | 并发提交占位与 flush 磁盘合并：多实例共享同一 job，不丢失外部 job。 |
| `Panel Endpoints` | 793-845 | 面板端点验证：`GET /api/codewiki/jobs` (回环守卫、进度透出)、`POST /api/codewiki/control` (取消、404)。 |
| `Exclude Paths` | 847-900 | 排除清单验证：compile 与直调均拒绝排除路径。 |
| `Known Repos` | 902-940 | 已知仓库登记：独立于 job 历史，refresh 动作清缓存。 |
| `Workspace Only` | 942-987 | 工作区任务过滤：jobs/repos 端点按 workspaceOnly 配置过滤。 |
| `Registry Exception` | 989-1017 | Registry 异常防御：list() 抛错时降级不过滤。 |
| `Output Schema` | 1019-1057 | 工具输出 schema 校验：null/undefined 类型匹配。 |
| `Foreign Orphan` | 1059-1091 | 孤儿任务接管：停更超时 foreign 任务被接管并 cancel。 |
| `No Credentials` | 1093-1103 | 无凭证诚实报错：不尝试子代理回退。 |
| `Strict Cordis` | 1105-1127 | 严格 cordis 语义：未 inject 服务属性访问即抛。 |
| `Temp Cleanup` | 1129-1146 | Temp 残留清理：启动时移除 Temp 目录终态任务，保留活动与工作区任务。 |

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                     Testing Suite                           │
├──────────────┬──────────────┬──────────────┬────────────────┤
│ test-batch   │ test-cwd     │ test-orch    │ Shared Infra   │
│ (Atomic &    │ (Path Fix)   │ (Orchestration│ • fs/os/path   │
│  Batch Proc) │              │  & Service)  │ • DSH_JOBS_... │
├──────────────┼──────────────┼──────────────┼────────────────┤
│ • estimate   │ • cw.execute │ • makeCtx    │ • globalThis   │
│   Tokens     │   (MSYS/Win) │ • makeBatch  │   fetch (Mock) │
│ • buildJsonl │ • Path Norm  │   Mock       │                │
│ • parseRes   │              │ • waitJob    │                │
│ • collectSrc │              │ • apply      │                │
│ • submitSett │              │   (StageMch) │                │
└──────┬───────┘              └──────┬───────┘                ▼
       │                            │               ┌─────────────────┐
       ▼                            ▼               │  dsh-codewiki   │
┌──────────────────────────────────────────────────┤ ├─────────────────┤
│                   Shared Infrastructure           │  • apply          │
│  • globalThis.fetch (Mocked for API calls)        │  • tools          │
│  • fs/os/path (Node Standard Lib)                 │  • endpoints      │
│  • DSH_CODEWIKI_JOBS_FILE (Shared State)          └─────────────────┘
└──────────────────────────────────────────────────┘
```

## Data Flow

1.  **Batch Processing (`test-batch.mjs`)**:
    *   `prepareArticleTasks` 收集源码 → `collectSources` 进行 Token 预算检查。
    *   预算充足的任务经 Mock Fetch 打百炼普通入口 `chat/completions`（`runRealtimeTasks` 后台并发池）。
    *   若预算不足（Oversized），升 200k 大档装填，仍装不下才转超大兜底通道。
    *   `fixAnchors` 基于 `source_files` 清单修正 Markdown 中的代码块引用行号。

2.  **Orchestration (`test-orchestration.mjs`)**:
    *   `codewiki_generate` 提交任务 → 创建 Job 记录至 `DSH_CODEWIKI_JOBS_FILE`。
    *   后台 Tick 循环驱动阶段机：`plan` → `articles` → `crosscut` → `review` → `index`。
    *   全部阶段请求走同一普通端点（零专用批量端点）。
    *   面板端点暴露 Job 状态、Task List 及 Batch Progress，支持 Cancel 操作。

3.  **Path Handling (`test-cwd-paths.mjs`)**:
    *   验证 `cw` CLI 工具在不同 OS 路径格式（MSYS vs Windows）下的兼容性，确保 `.codewiki` 路径解析正确。

## Connections

*   [[dsh-codewiki]]: `testing-suite` 直接测试 `dsh-codewiki` 插件的 `apply`、`codewiki_generate` 工具及 `cw` 工具。
*   [[batch-processing]]: `test-batch.mjs` 覆盖编译请求装配与并发池执行的核心验证（0.6.0 起走百炼普通入口）。

## Known Issues

*   **Mock Fetch 依赖**: 所有网络交互测试均依赖 `globalThis.fetch` 的 Mock，需确保测试运行时 Node.js 版本支持全局 Fetch API (≥18, 推荐 ≥20)。
*   **Temp 目录清理**: `test-orchestration.mjs` 中涉及 Temp 目录任务清理的逻辑依赖于文件系统权限，在 Windows 上可能因句柄延迟释放导致清理失败（代码中已包含重试机制）。
*   **并发竞争**: `test-orchestration.mjs` 中的并发提交测试依赖于 `flush` 磁盘合并机制，若 IO 延迟过高可能导致竞态条件误判。