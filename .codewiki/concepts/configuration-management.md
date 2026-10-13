---
title: configuration-management
type: concept
source_files:
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
tags: [configuration, settings, plugin-system, configForms, patch]
---

## Overview

`configuration-management` 是 dsh-codewiki 插件中负责定义、持久化、注入及动态同步配置数据的核心概念。它确立了从静态元数据到运行时动态设置的完整生命周期，确保插件行为（如模型选择、并发限制、排除路径）与宿主环境（DeepSeek Harness）及用户偏好保持一致。该概念贯穿了插件的挂载阶段、初始化阶段以及运行时的热更新阶段，实现了“声明式配置”与“命令式执行”的解耦。

## Involved Modules

1.  **documentation-and-config**:
    *   负责配置的**静态定义**与**元数据**。
    *   通过 `package.json` 中的 `dsh.bundle.patch` 字段指定补丁文件。
    *   通过 `cordis.patch.yml` 定义插件的基础挂载结构及初始空配置对象 `{}`。
    *   通过 `README.md` 向用户文档化所有 volatile（易变）设置项及其含义。

2.  **core-logic**:
    *   负责配置的**解析**、**校验**与**运行时应用**。
    *   使用 `@deepseek-ai/schemastery` 在 `index.js` 中定义严格的配置 Schema。
    *   提供 `liveConfig()` 函数，在每次工具执行时解包并规范化配置。
    *   处理配置中的敏感信息（如 `batchApiKey`）解析逻辑。

3.  **client-interface**:
    *   负责配置的**用户交互**、**视图渲染**与**双向同步**。
    *   通过 `CodewikiCard` 组件提供可视化表单，允许用户在 UI 层修改配置。
    *   利用宿主的 `configForms` 服务实现配置的读写与热加载（无需重启宿主）。
    *   维护前端状态（`snapshot`, `draft`）以支持撤销/重做和即时反馈。

## Flow

配置数据的流动遵循“定义 -> 注入 -> 解析 -> 交互 -> 回写”的闭环：

1.  **静态定义与挂载 (Static Definition & Mounting)**:
    *   **源**: `package.json` 声明 `dsh.bundle.patch: "cordis.patch.yml"`。
    *   **动作**: Cordis 插件系统读取 `cordis.patch.yml`，将插件注册为 `codewiki` ID，并传入初始 `config: {}`。
    *   **位置**: 插件根目录 (`package.json`, `cordis.patch.yml`)。

2.  **Schema 校验与默认值 (Schema Validation & Defaults)**:
    *   **源**: `core-logic` 模块。
    *   **动作**: 当插件加载或配置变更时，`core-logic` 依据 Schema 对传入的配置进行校验。若缺少字段，则应用 `liveConfig()` 中定义的默认值（如 `maxConcurrency: 8`, `enabled: true`）。
    *   **位置**: `core-logic` 模块源码 (`index.js`)。

3.  **运行时解析 (Runtime Resolution)**:
    *   **源**: `core-logic` 的 `execute` 方法。
    *   **动作**: 在 `codewiki_generate` 或 `cw` 工具执行前，调用 `liveConfig(ctx)`。此过程不仅应用本地默认值，还解析凭证链（显式 Key > 宿主凭据库 > 子代理回退）。
    *   **位置**: `core-logic` 模块源码 (`resolveBatchApiKey`, `liveConfig`)。

4.  **UI 交互与热更新 (UI Interaction & Hot Reload)**:
    *   **源**: `client-interface` 模块。
    *   **动作**:
        *   **读取**: `CodewikiCard` 订阅 `form.getSnapshot()`，从宿主配置服务获取当前配置快照。
        *   **编辑**: 用户在 React 表单中修改 `draft` 状态。
        *   **写入**: 点击保存时，调用 `form.mutate()` 发送 Patch 操作至宿主。
        *   **同步**: 宿主更新全局配置，其他实例（包括后台 Worker）下次读取时自动生效。
    *   **位置**: `client-interface` 模块源码 (`CodewikiCard`, `form.mutate`)。

5.  **配置驱动的行为控制 (Configuration-Driven Behavior)**:
    *   **源**: `core-logic` 的各个 Tick 处理器。
    *   **动作**: 配置项直接决定流水线行为。例如：
        *   `excludePaths`: 在 `scanRepoFiles` 中过滤文件。
        *   `batchModel` / `batchThinkingBudget`: 决定编译模型与思考预算（全部模型环节共用，走百炼普通入口）。
        *   `autoUpdate`: 控制 `autoScan` 调度器是否启动。
    *   **位置**: `core-logic` 模块源码 (`tickPlan`, `scanRepoFiles`, `autoScan`)。

## Implementation Map

| 功能点 | 模块 | 文件 | 行号/位置 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| **配置 Schema 定义** | core-logic | `index.js` | L36-L48 | 使用 schemastery 定义所有可配置字段的类型、默认值和约束。 |
| **配置解析与规范化** | core-logic | `index.js` | L51-L77 | `val()`/`liveConfig()` 函数，合并默认值与安全边界（如硬顶并发数）。 |
| **凭证解析链** | core-logic | `index.js` | L404-L424 | `resolveBatchApiKey()`，处理 API Key 的优先级逻辑。 |
| **挂载补丁定义** | documentation-and-config | `cordis.patch.yml` | Root | 定义插件 ID 和初始空配置 `{}`。 |
| **插件入口依赖** | documentation-and-config | `package.json` | Root | 声明 `dsh.bundle.patch` 指向补丁文件。 |
| **配置表单组件** | client-interface | `client.js` | L390-L520 | `CodewikiCard` 组件：`snapshot`/`draft` 状态、`form.mutate` 保存（L456）、`discard`。 |
| **配置读写接口** | client-interface | `client.js` | L355-L371 | `ctx.configForms.get(NS)` 取表单、`whileServed` 热生效挂载；写回走 `form.mutate(ops, revision)`。 |
| **排除路径过滤** | core-logic | `index.js` | L807-L830 | `scanRepoFiles()` 中使用 `excludePaths` 配置过滤源码。 |
| **自动更新开关** | core-logic | `index.js` | L2112-L2140 | `autoScan()` 根据 `autoUpdate` 配置决定是否启动调度器。 |