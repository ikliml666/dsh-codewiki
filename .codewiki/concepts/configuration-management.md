---
title: configuration-management
type: concept
source_files:
  - index.js
  - client.js
  - cordis.patch.yml
tags: [configuration, settings, plugin-system, configForms, patch]
---

## Overview

`configuration-management` 是 dsh-codewiki 插件中负责定义、持久化、注入及动态同步配置数据的核心概念。它确立了从静态元数据到运行时动态设置的完整生命周期，确保插件行为（如模型选择、并发限制、排除路径）与宿主环境（DeepSeek Harness）及用户偏好保持一致。该概念贯穿了插件的挂载阶段、初始化阶段以及运行时的热更新阶段，实现了“声明式配置”与“命令式执行”的解耦。

## Key Components

### `index.js` (Core Logic & Schema)

**常量与全局状态**
*   `Config` (L39-L52): 使用 `@deepseek-ai/schemastery` 定义的 Zod-like 配置对象模式。定义了所有可配置字段的类型、默认值 (`default`)、易变性 (`volatile`) 及描述。
    *   `enabled`: boolean, default true.
    *   `binaryPath`: string, default ''.
    *   `batchModel`: string, default 'qwen3.7-flash'.
    *   `batchApiKey`: string, default ''.
    *   `batchThinkingBudget`: number, default 0.
    *   `maxConcurrency`: number, default 8.
    *   `articleLanguage`: string, default '中文'.
    *   `updateReminder`: boolean, default true.
    *   `excludePaths`: string, default ''.
    *   `autoUpdate`: boolean, default false.
    *   `autoUpdateMin`: number, default 30.
    *   `workspaceOnly`: boolean, default true.
*   `CONCURRENCY_HARD_CAP` (L19): 硬编码并发上限 8。
*   `hostCtxRef` (L406): 存储宿主上下文引用，用于凭证解析。
*   `agentsRef` (L913): 存储代理实例引用，用于编译完成后的唤醒。

**核心函数**
*   `liveConfig(config)` (L58-L76): 运行时配置解析器。接收原始配置对象，应用默认值，进行类型转换和安全边界检查（如 `maxConcurrency` 限制在 1-8 之间，`batchThinkingBudget` 限制在 0-32768 之间）。返回规范化后的配置对象。
*   `resolveBatchApiKey(hostCtx, cfg)` (L413-L433): 异步凭证解析链。优先级：显式 `batchApiKey` > 宿主凭据库 (`credentials` 服务) > 失败返回 null。支持超时保护 (3s)。
*   `installUpdateReminder(ctx, config)` (L2197-L2229): 安装会话系统提示中的 wiki 维护提醒。通过 `ctx.on('agent/created')` 和 `ctx.inject(['agents'])` 注入 section。仅在仓库根存在 `CodeWiki.md` 且 `updateReminder` 为 true 时生效。
*   `commitHintText(cwd, jobs)` (L2159-L2184): 生成编译完成后的提交提醒文本。比较最近一次成功编译时间与 `.codewiki/` 的最后 git 提交时间，若编译后未提交则生成提醒。包含 60s TTL 缓存。
*   `apply(ctx, config)` (L2231-L2284): 插件入口。初始化 Job Service，注册工具 (`cw`, `codewiki_generate`, `codewiki_update`, `codewiki_progress`)，启动自动更新调度器 (`autoScan`)，安装 Web Server 端点，安装更新提醒。
*   `createJobService(config, onSettled)` (L928-L1616): 创建后台编译任务编排服务。管理 Jobs 文件的读写、锁机制、阶段推进逻辑。
*   `scanRepoFiles(cwd)` (L816-L839): 扫描仓库源码文件，排除黑名单目录和二进制后缀，限制文件大小和总数。
*   `autoScan()` (L2245-L2267): 自动更新调度器的主循环。定时扫描已编译工作区，检测到变更自动提交增量编译。
*   `excludedItem(cwd, list)` / `isExcluded(cwd, list)` (L226-L238): 判断目录是否在排除清单中。

### `client.js` (Client Interface)

**组件**
*   `CodewikiCard` (L392): React 设置卡片组件。
    *   **Props**: `view` ('summary' | 'page'), `t` (翻译函数)。
    *   **State**: `snapshot` (来自 `configForms` 的只读快照), `draft` (本地编辑草稿), `notice` (操作反馈), `error` (错误信息)。
    *   **Methods**:
        *   `setPath(key, value)`: 更新 `draft` 状态。
        *   `save()`: 验证输入（如并发数范围），调用 `form.mutate(ops, snapshot.revision)` 提交更改。
        *   `discard()`: 重置 `draft` 为当前 `snapshot.value`。
*   `ReposTab` (L739): 侧边栏面板中的“总览”标签页。显示各仓库的 Wiki 状态、排除情况、自动更新调度信息。支持直接在此处排除/取消排除仓库（修改 `excludePaths`）。
*   `CodewikiPanel` (L884-L1100): 侧边栏主面板。包含“任务”、“总览”、“设置”三个标签页。轮询 `/api/codewiki/jobs` 获取实时进度。
*   `PanelIcon` (L1086): 侧边栏图标 SVG。

**辅助函数**
*   `zh()` / `en()` (L29 / L138): 中英文词典定义。
*   `apiGet(p)` / `apiPost(p, data)` (L333 / L339): 封装 Fetch 请求，处理 JSON 响应和错误。
*   `stageLabel(stage)` / `kindLabelOf(kind)`: 将内部阶段/类型代码映射为本地化字符串。

### `cordis.patch.yml` (Mounting Configuration)

*   **内容**: 定义插件 ID `codewiki`，指定源文件路径 `file:///.../index.js`，初始配置 `config: {}`。
*   **作用**: 供 Bundle 形式安装使用，告知 Cordis 插件系统如何加载本插件。

### `package.json` (Metadata)

*   **字段**:
    *   `name`: `@local/dsh-codewiki`
    *   `dsh.bundle.patch`: `cordis.patch.yml` (指向补丁文件)。
    *   `main`: `index.js`
    *   `exports`: 导出 `.` 和 `./client`。

## Architecture

```text
┌──────────────────────┐       ┌──────────────────────┐
│   Host Environment   │       │   DeepSeek Harness   │
│   (Cordis/Config)    │◄─────►│   Plugin System      │
└──────────┬───────────┘       └──────────┬───────────┘
           │                              │
           │ 1. Mount via                 │
           │    cordis.patch.yml          │
           ▼                              ▼
┌──────────────────────┐       ┌──────────────────────┐
│   Static Config      │       │   Core Logic         │
│   (patch.yml)        │──────►│   (index.js)         │
└──────────────────────┘       │  - liveConfig()      │
                               │  - resolveBatchApi() │
                               └──────────┬───────────┘
                                          │ 2. Runtime Resolution
                                          ▼
┌──────────────────────┐       ┌──────────────────────┐
│   Client UI          │◄─────►│   Job Service        │
│   (client.js)        │       │   (index.js)         │
│  - CodewikiCard      │       │  - createJobService  │
│  - ReposTab          │       │  - autoScan          │
└──────────────────────┘       └──────────────────────┘
```

1.  **Static Config**: `cordis.patch.yml` 和 `package.json` 提供初始挂载信息和空配置。
2.  **Core Logic**: `index.js` 中的 `apply` 函数被 Cordis 调用，传入初始 `config: {}`。`liveConfig` 在此阶段应用默认值。
3.  **Runtime Resolution**: 工具执行时，`liveConfig` 再次被调用以获取最新配置。`resolveBatchApiKey` 动态获取凭证。
4.  **Client UI**: `client.js` 通过 `ctx.configForms.get(NS)` 订阅配置变化。`CodewikiCard` 允许用户修改配置，并通过 `form.mutate` 写回宿主。
5.  **Job Service**: 配置项（如 `excludePaths`, `autoUpdate`）直接影响 `scanRepoFiles` 和 `autoScan` 的行为。

## Data Flow

1.  **Initialization**:
    *   Cordis 读取 `cordis.patch.yml`，加载 `index.js`。
    *   `apply(ctx, {})` 被调用。
    *   `createJobService({}, ...)` 初始化，此时配置均为默认值。
    *   `installUpdateReminder` 注册系统提示 Section。
    *   `installWebServer` 注册 API 端点。

2.  **User Modification**:
    *   用户在侧边栏或插件页打开 `CodewikiCard`。
    *   `CodewikiCard` 订阅 `form.getSnapshot()`，获取当前配置。
    *   用户修改 `draft` 状态（例如更改 `batchModel`）。
    *   用户点击 "Save"。
    *   `save()` 调用 `form.mutate([{ op: 'set', path: ['batchModel'], value: 'new-model' }], revision)`。
    *   宿主更新全局配置存储。
    *   `CodewikiCard` 收到新的 `snapshot`，更新 `draft`。
    *   后台 `Job Service` 在下一次 `liveConfig` 调用时获取新值。

3.  **Runtime Usage**:
    *   用户触发 `codewiki_generate`。
    *   `execute` 方法调用 `liveConfig(cfg)` 获取最新配置。
    *   `resolveBatchApiKey` 解析 API Key。
    *   `submit` 创建 Job，开始流水线。
    *   流水线各阶段（Plan, Articles, Crosscut, Review, Index）根据配置（如 `maxConcurrency`, `batchModel`）执行。

4.  **Auto Update**:
    *   `autoScan` 定时器触发。
    *   遍历已知仓库，调用 `generateDef.execute({ scope: 'auto' })`。
    *   若仓库有变更，提交增量编译任务。

## Connections

*   [[job-service]]: Configuration directly controls the behavior of the Job Service (e.g., concurrency, model selection).
*   [[credential-resolution]]: `resolveBatchApiKey` is a key part of configuration management for sensitive data.
*   [[ui-settings]]: `CodewikiCard` is the primary UI component for configuration management.

## Known Issues

*   **Credential Source Persistence**: The `credentialSource` is stored in the Job object but not persisted to disk in a way that survives host restarts if the job is cancelled/fails early. However, the `apiKey` itself is also not persisted, so it must be re-resolved. This is by design for security, but means re-resolution happens on every tick/job start.
*   **Config Race Conditions**: If multiple instances of the plugin are running (e.g., during testing or rapid reloads), they might read stale configs. The `configForms` mechanism aims to handle this via revisions, but race conditions in `liveConfig` calls between instances could theoretically lead to inconsistent states if not careful. The `dirtyIds` and `mergeFromDisk` logic in `Job Service` helps mitigate state loss, but config sync relies on the host's `configForms` service consistency.
*   **Exclude Paths Regex**: The exclusion logic uses simple string matching and normalization. Complex path patterns or symbolic links might not be handled perfectly.