---
title: client-interface
type: module
source_files:
  - client.js
tags: [client, react, api-wrapper, plugin-system, sidebar-panel, config-forms]
---

## Overview

`client-interface` 是 CodeWiki 插件的前端核心逻辑（实现于仓库根 `client.js`，经宿主插件系统加载），负责与宿主应用（DeepSeek Host）的深度集成：

1. **插件配置管理**：通过宿主 `configForms` 服务（命名空间 `'codewiki'`）读写插件设置，支持热生效，无需重启宿主。提供运行参数、编译模型（百炼）、调度与排除等配置项。
2. **侧边栏面板**：注册侧边栏面板，实时展示编译任务进度、状态与详情（`CodewikiPanel`），并提供仓库总览（`ReposTab`）与托盘图标（`PanelIcon`）。
3. **API 封装**：封装 `/api/codewiki/jobs`、`/api/codewiki/control`、`/api/codewiki/repos` 端点，支持轮询获取任务状态与仓库状态。
4. **UI 组件**：React 组件树渲染设置卡片、任务列表、进度条、六阶段步骤条与统计徽标。

## Key Components

### 常量与配置

- `NS = 'codewiki'` (line 17): 插件命名空间，用于 `configForms` 和 locale 注册。
- `KEY = 'codewiki'` (line 18): 侧边栏面板 key，需与 `sidebar.panellist` 的 id 一致。
- `JOBS_PATH = '/api/codewiki/jobs'` (line 19): 任务列表 API 路径。
- `CONTROL_PATH = '/api/codewiki/control'` (line 20): 控制命令 API 路径（取消、编译等）。
- `PANEL_ORDER = 52` (line 21): 侧边栏面板排序权重。
- `POLL_MS = 2000` (line 22): 任务列表轮询间隔（毫秒）。
- `REPOS_PATH = '/api/codewiki/repos'` (line 23): 仓库状态 API 路径。
- `MODELS_PATH = '/api/codewiki/models'` (line 24): 模型目录 API 路径。
- `REPOS_POLL_MS = 10000` (line 25): 仓库列表轮询间隔（毫秒）。
- `ACTIVE_STAGES = ['plan', 'articles', 'crosscut', 'compose', 'review', 'index']` (line 26): 活跃阶段列表。
- `STAGE_WEIGHTS` (line 774): 各阶段在总体进度中的权重：`{ plan: 0.05, articles: 0.6, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }`。

### 字典与国际化

- `zh()` (line 28) / `en()` (line 144): 返回中英文字典对象，包含所有 UI 文本键值对。通过 `ctx.locale.register(NS, ...)` 注册。

### API 函数

- `apiGet(p)` (line 347): 封装 GET 请求，自动解析 JSON，检查 HTTP 状态码。
- `apiPost(p, data)` (line 353): 封装 POST 请求，发送 JSON body，自动解析响应。

### React 组件

- `CodewikiCard(props)` (line 406): 设置卡片组件。
  - 使用 `ctx.configForms.get(NS)` 获取表单实例。
  - 维护 `snapshot`（服务器快照）、`draft`（本地草稿）、`notice`、`error` 状态。
  - `save()`: 验证并发数（1-8）和思考预算（0-32768），调用 `form.mutate` 保存。
  - `discard()`: 重置草稿为最新快照。
  - 包含“运行”、“编译模型”、“调度与排除”三个配置区域。
- `CodewikiPanel()` (line 972): 侧边栏主面板组件。
  - 维护 `jobs`（任务列表）、`err`、`busyId`、`tab`（当前标签页）、`copiedPath` 状态。
  - 维护 `sparkRef`（tps 滚动窗口）和 `batchRateRef`（批量完成速率 EWMA）。
  - 轮询 `JOBS_PATH`，更新任务状态及侧边统计数据。
  - 将任务按 `cwd` 分组，区分焦点任务（活动或最新）和历史任务。
  - 渲染三个标签页：Overview (`ReposTab`)、Tasks（任务列表）、Settings (`CodewikiCard`)。
- `ReposTab()` (line 827): 仓库总览标签页组件。
  - 轮询 `REPOS_PATH` 获取仓库状态和调度信息。
  - 支持手动触发编译（`compile`）和切换排除状态（`toggleExclude`）。
- `PanelIcon(props)` (line 1174): 侧边栏托盘图标，SVG 绘制摊开的书本。
- `Spark({ values, width, height })` (line 729): 吞吐微趋势线 SVG 组件。
- `stageBar(job)` (line 750): 六阶段步骤条组件，显示各阶段完成状态、耗时及当前阶段实时计时。
- `throughputBadge(job, sparkOf, rateOf)` (line 786): 吞吐徽标组件，显示 tok/s 或篇/分 + ETA。
- `usageLine(job)` (line 808): 用量行组件，显示输入/输出 token 数及请求数。

### 辅助函数

- `stageLabel(stage)` (line 694): 根据阶段名获取翻译后的标签。
- `stateLabel(st)` (line 695): 根据状态获取翻译后的标签。
- `kindLabelOf(t, kind)` (line 696): 根据类型获取翻译后的标签。
- `progressBar(done, total)` (line 697): 渲染进度条。
- `repoName(cwd)` (line 701): 从工作目录路径提取短名称。
- `fmtMs(ms)` (line 705): 格式化毫秒为 HH:MM:SS 或 MM:SS。
- `fmtTok(n)` (line 712): 格式化 token 数量（k/M）。
- `fmtDur(ms)` (line 718): 格式化时长为 min 或 h min。
- `fmtAgo(iso)` (line 724): 格式化相对时间（如 "5 min ago"）。
- `overallPct(job)` (line 775): 计算任务总体进度百分比。
- `stepName(s)` (line 745): 获取步骤名称的翻译。
- `lastTimedStage(job)` (line 746): 获取最后有计时的阶段。

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                        CodewikiPanel                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ ReposTab     │  │ Tasks Tab    │  │ Settings Tab     │   │
│  │ (Repos List) │  │ (Job Cards)  │  │ (CodewikiCard)   │   │
│  │ Poll: REPOS  │  │ Poll: JOBS   │  │ ConfigForms      │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
│         ▼                 ▼                    ▼             │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                  apiGet / apiPost                     │    │
│  └──────────────────────────┬───────────────────────────┘    │
│                             │                                │
│                             ▼                                │
│              ┌──────────────────────────┐                    │
│              │   Host WebServer API      │                    │
│              │  /api/codewiki/*          │                    │
│              └──────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **初始化**: `apply(ctx)` 中注册 locale、注入 `plugins.item`（`CodewikiCard`）和 `main`/`sidebar.panellist`（`CodewikiPanel`）。
2. **配置读取**: `CodewikiCard` 订阅 `form.subscribe`，当 `snapshot` 变化时更新 `draft`。用户修改后点击保存，调用 `form.mutate` 写回宿主配置服务。
3. **任务轮询**: `CodewikiPanel` 启动定时器，每 `POLL_MS` 调用 `apiGet(JOBS_PATH)` 获取任务列表。
4. **数据更新**: 收到新任务数据后，更新 `sparkRef`（tps 历史）和 `batchRateRef`（批量速率），并触发重渲染。
5. **仓库轮询**: `ReposTab` 启动定时器，每 `REPOS_POLL_MS` 调用 `apiGet(REPOS_PATH)` 获取仓库状态。
6. **控制命令**: 用户操作（取消任务、编译仓库、切换排除）通过 `apiPost(CONTROL_PATH, { action, ... })` 发送给宿主。

## Connections

- [[core-logic]]：面板消费的 `/api/codewiki/*` 端点由后端服务提供。
- [[configuration-management]]：配置读写链路详解，涉及 `configForms` 服务。

## Known Issues

- 无已知问题。