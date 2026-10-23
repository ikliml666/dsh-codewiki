---
title: client-interface
type: module
source_files:
  - client.js
tags: [client, react, api-wrapper, plugin-system, sidebar-panel, config-forms]
---

## Overview

`client-interface` 是 CodeWiki 插件的前端核心逻辑（实现于仓库根 `client.js`，通过 `window.__ModuleLoader__.load` 由宿主插件系统加载，id 为 `@local/dsh-codewiki`，见第 10–12 行），负责与宿主应用（DeepSeek Host）深度集成：

1. **插件配置管理**：通过宿主 `configForms` 服务（命名空间 `'codewiki'`，第 17 行）读写插件设置，支持热生效，无需重启宿主。设置卡片 `CodewikiCard` 提供运行参数、编译模型（百炼/自定义提供商）、调度与排除等配置项（第 410–701 行）。
2. **侧边栏面板**：注册 `main` 与 `sidebar.panellist` 两个挂载点（第 393–404 行），渲染 `CodewikiPanel`（第 985–1185 行）展示编译任务进度、仓库总览（`ReposTab` 第 840–983 行）与设置卡片，并提供托盘图标 `PanelIcon`（第 1187–1198 行）。
3. **API 封装**：封装 `GET /api/codewiki/jobs`（第 19 行）、`POST /api/codewiki/control`（第 20 行）、`GET /api/codewiki/repos`（第 23 行）、`GET /api/codewiki/models`（第 24 行）端点，轮询获取任务状态、仓库状态与模型目录。
4. **UI 组件**：React 组件树渲染设置表单、任务卡片、六阶段步骤条、吞吐徽标、进度条与用量行等。

## Key Components

### 常量与配置

- `NS = 'codewiki'`（第 17 行）：插件命名空间，用于 `configForms` 与 locale 注册。
- `KEY = 'codewiki'`（第 18 行）：侧边栏面板 key，须与 `sidebar.panellist` 的 id 一致。
- `JOBS_PATH = '/api/codewiki/jobs'`（第 19 行）：编译任务列表 API 路径。
- `CONTROL_PATH = '/api/codewiki/control'`（第 20 行）：控制命令 API 路径（取消、编译、刷新等，仅回环）。
- `PANEL_ORDER = 52`（第 21 行）：侧边栏面板排序权重，排在 dsh-hindsight-on-demand（50）之后。
- `POLL_MS = 2000`（第 22 行）：任务列表轮询间隔（毫秒）。
- `REPOS_PATH = '/api/codewiki/repos'`（第 23 行）：仓库状态与调度信息 API 路径。
- `MODELS_PATH = '/api/codewiki/models'`（第 24 行）：模型目录 API 路径。
- `REPOS_POLL_MS = 10000`（第 25 行）：仓库列表轮询间隔（毫秒）。
- `ACTIVE_STAGES = ['plan', 'articles', 'crosscut', 'compose', 'review', 'index']`（第 26 行）：活跃阶段列表，用于步骤条与进度计算。
- `STAGE_WEIGHTS = { plan: 0.05, articles: 0.6, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }`（第 787 行）：各阶段在总体进度中的定权，用于 `overallPct`。

### 字典与国际化

- `zh()`（第 28–145 行）：返回中文字典对象，包含所有 UI 文本键值（title、summary、secRun、enabled 等）。
- `en()`（第 146–263 行）：返回英文字典对象，结构同 `zh()`。
- 注册方式：`ctx.locale.register(NS, { zh: zh(), en: en() })`（第 372 行），词典值必须为字符串（否则 `t()` 回退键名，见第 8 行注释）。

### API 函数

- `apiGet(p)`（第 351–356 行）：封装 `fetch` GET 请求，接收头 `accept: application/json`，解析 JSON，非 2xx 时抛错（带 `body.error` 或 `HTTP {status}`）。
- `apiPost(p, data)`（第 357–366 行）：封装 `fetch` POST 请求，发送 `content-type: application/json` 与 JSON body，同样检查状态码并抛错。

### React 组件

- `CodewikiCard(props)`（第 410–701 行）：设置卡片组件，用于 `plugins.item` 注入（第 378–390 行）与面板 Settings 标签（第 1156 行）。
  - 状态：`snapshot`（第 413 行，来自 `form.getSnapshot()`）、`draft`（第 414 行，本地草稿）、`notice`（第 415 行）、`error`（第 416 行）、`catalog`（第 419 行，模型目录）、`catalogError`（第 420 行）。
  - `useEffect` 拉取模型目录（第 422–433 行），失败则 `catalogError` 有值，UI 退回手填。
  - `useEffect` 订阅配置快照（第 436–453 行），仅在 `revision` 变化时覆盖 `draft`。
  - `props.view === 'summary'` 时返回一行简介（第 456 行）。
  - `setPath(key, value)`（第 458–465 行）：不可变更新 `draft`。
  - `dirty` memo（第 467–470 行）：比较 draft 与 snapshot。
  - `selectedProvider` memo（第 473–477 行）：从 catalog 匹配当前 `batchProvider`。
  - `save()` 异步（第 479–506 行）：校验 `maxConcurrency` 为 1–8 整数（第 482 行）、`batchThinkingBudget` 为 0–32768 整数（第 487 行，注：校验使用 `t('invalidBatchThinking')` 但字典中无此键，会回退键名）；构建 ops 列表（含 `enabled`, `binaryPath`, `maxConcurrency`, `articleLanguage`, `updateReminder`, `workspaceOnly`, `batchApiKey`, `batchProvider`, `batchModel`, `batchThinkingBudget`, `sessionTier`, `excludePaths`, `autoUpdate`, `autoUpdateMin`，第 493 行），调用 `form.mutate(ops, snapshot.revision)`。
  - `discard()`（第 508–512 行）：重置草稿。
  - 渲染分三块：`secRun`（第 521–576 行，含 enabled/updateReminder/workspaceOnly/maxConcurrency/articleLanguage/binaryPath）、`secCompile`（第 578–657 行，含 batchProvider 下拉/手填、batchModel、batchThinkingBudget、sessionTier）、`secSchedule`（第 659–691 行，含 autoUpdate、autoUpdateMin、excludePaths 文本域），底部保存条（第 693–699 行）。
- `ReposTab()`（第 840–983 行）：仓库总览标签页组件，由 `CodewikiPanel` 在 `tab === 'overview'` 时渲染（第 1155 行）。
  - 状态：`data`（第 842 行）、`err`（第 843 行）、`busyCwd`（第 844 行）、`mountedRef`（第 845 行）、`inFlightRef`（第 848 行）、`exclBusy`（第 869 行）。
  - `pull()`（第 849–860 行）：轮询 `REPOS_PATH`，每 `REPOS_POLL_MS` 触发（第 861–865 行）。
  - `toggleExclude(r)`（第 870–888 行）：修改 `excludePaths` 配置（经 `form.mutate`）并 POST `control` 刷新（第 881 行）。
  - `compile(cwd)`（第 890–898 行）：POST `control` 触发编译。
  - 渲染调度信息（第 900–932 行）与仓库列表（第 934–978 行），每个仓库显示状态、排除标签、更新/排除按钮及进度。
- `CodewikiPanel()`（第 985–1185 行）：侧边栏主面板组件，挂载于 `main` slot（第 395 行）。
  - 状态：`jobs`（第 987 行）、`err`（第 988 行）、`busyId`（第 989 行）、`tab`（第 990 行，默认 `'overview'`）、`copiedPath`（第 991 行）、`sparkRef`（第 993 行，tps 滚动窗口 Map）、`batchRateRef`（第 994 行，批量速率 EWMA Map）、`mountedRef`（第 1041 行）。
  - `useEffect` 轮询 `JOBS_PATH`（第 998–1038 行），更新 `sparkRef`/`batchRateRef` 并 `setJobs`。
  - `cancel(jobId)`（第 1043–1051 行）：POST `control` 取消任务。
  - `copyPath(p)`（第 1052–1058 行）：剪贴板复制 wiki 路径。
  - `kindLabel`（第 1060 行）、`isActive`（第 1062 行，判断阶段是否在 `ACTIVE_STAGES`）。
  - 分组与焦点逻辑（第 1065–1077 行）：按 `cwd` 分组，焦点取活动最新或最近更新任务。
  - `jobCard(job)`（第 1079–1137 行）：渲染单任务卡片，含标签、阶段、吞吐徽标、步骤条、进度、用量、活动流、任务列表、wiki 路径复制。
  - 顶部标题与标签栏（第 1141–1154 行），根据 `tab` 切换 `ReposTab`/`CodewikiCard`/任务列表（第 1155–1178 行）。
- `PanelIcon(props)`（第 1187–1198 行）：侧边栏托盘图标，SVG 绘制摊开的书本（wiki 页），接受 `size` 属性。
- `Spark({ values, width, height })`（第 742–754 行）：纯 SVG polyline 微趋势线，用于 tps 历史（数据来自 `sparkRef`）。

### 辅助函数

- `el(tag, props, ...children)`（第 347–349 行）：React.createElement 包装。
- `stageLabel(stage)`（第 707 行）：拼接 `stage${Capitalize}` 取翻译。
- `stateLabel(st)`（第 708 行）：拼接 `state${Capitalize}` 取翻译。
- `kindLabelOf(t, kind)`（第 709 行）：拼接 `kind${Capitalize}` 取翻译（带 locale 绑定）。
- `progressBar(done, total)`（第 710–713 行）：返回进度条 div，total<=0 时 null。
- `repoName(cwd)`（第 714–717 行）：取路径末两段（父目录/目录名）。
- `fmtMs(ms)`（第 718–724 行）：格式化毫秒为 `HH:MM:SS` 或 `MM:SS`。
- `fmtTok(n)`（第 725–730 行）：格式化 token 数为 k/M。
- `fmtDur(ms)`（第 731–736 行）：格式化为 `X min` 或 `X h Y min`。
- `fmtAgo(iso)`（第 737–740 行）：相对当前时间后缀 `agoSuffix`。
- `stepName(s)`（第 758 行）：拼接 `step${Capitalize}` 取翻译。
- `lastTimedStage(job)`（第 759–762 行）：返回 `stageTimings` 最后一个键。
- `stageBar(job)`（第 763–785 行）：六阶段步骤条，根据 `job.stage` 与 `stageTimings` 标记完成/运行/失败/取消。
- `overallPct(job)`（第 788–796 行）：基于 `STAGE_WEIGHTS` 与 `taskList` 完成数计算总进度（封顶 99，done 为 100）。
- `throughputBadge(job, sparkOf, rateOf)`（第 799–819 行）：实时通道显示 `tok/s` + Spark；批量通道显示 `篇/分` + ETA 或执行时长。
- `usageLine(job)`（第 821–837 行）：用量行，显示输入/输出 token、请求数（批量/实时拆分），超 32k 档红字提示。

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                       CodewikiPanel (client.js:985)           │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│ │ ReposTab     │  │ Tasks Tab    │  │ Settings Tab         │  │
│ │ (client.js:840)│  │ (jobCard:1079)│  │ (CodewikiCard:410)   │  │
│ │ Poll REPOS   │  │ Poll JOBS    │  │ ConfigForms NS=codewiki│ │
│ └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│        │                 │                     │              │
│        ▼                 ▼                     ▼              │
│ ┌────────────────────────────────────────────────────────┐   │
│ │ apiGet/apiPost (client.js:351/357)                      │   │
│ └───────────────────────────┬────────────────────────────┘   │
│                             ▼                                │
│              ┌──────────────────────────────┐                │
│              │ Host WebServer /api/codewiki/*│                │
│              └──────────────────────────────┘                │
└──────────────────────────────────────────────────────────────┘
        │
        ▼ 挂载点
┌──────────────────────────┐   ┌──────────────────────────────┐
│ plugins.item (order 30)  │   │ sidebar.panellist (order 52)  │
│ CodewikiCard (client.js:378)│ │ PanelIcon (client.js:1187)    │
└──────────────────────────┘   └──────────────────────────────┘
```

## Data Flow

1. **初始化**：`apply(ctx)`（第 370 行）注入 `slots`、`locale`、`configForms`；注册字典（第 372 行）；`configForms.whileServed` 期间挂载 `plugins.item` 的 `CodewikiCard`（第 386–390 行）；注入 `main` 与 `sidebar.panellist` 渲染面板（第 393–404 行）。
2. **配置读取**：`CodewikiCard` 通过 `form.getSnapshot()` 与 `form.subscribe`（第 375、436–453 行）同步宿主配置到 `draft`；用户编辑后 `save()` 调用 `form.mutate`（第 500 行）写回并热生效。
3. **任务轮询**：`CodewikiPanel` 每 `POLL_MS`（2000ms）调用 `apiGet(JOBS_PATH)`（第 1005 行），更新 `sparkRef`/`batchRateRef`（第 1009–1026 行）。
4. **仓库轮询**：`ReposTab` 每 `REPOS_POLL_MS`（10000ms）调用 `apiGet(REPOS_PATH)`（第 853 行），刷新调度与仓库状态。
5. **控制命令**：用户操作（取消任务 `cancel` 第 1046 行、编译仓库 `compile` 第 893 行、切换排除 `toggleExclude` 第 879 行、刷新 `refresh` 第 881 行）均通过 `apiPost(CONTROL_PATH, { action, ... })` 发送。
6. **模型目录**：设置卡挂载时 `apiGet(MODELS_PATH)`（第 424 行）拉取提供商/模型列表，失败则手填（第 584–609 行）。

## Connections

- [[core-logic]]：面板消费的 `/api/codewiki/*` 端点由后端服务提供（见 `JOBS_PATH`、`CONTROL_PATH`、`REPOS_PATH`、`MODELS_PATH` 第 19–24 行）。
- [[configuration-management]]：配置读写链路详解，涉及 `configForms` 服务命名空间 `'codewiki'`（第 17、375 行）与 `form.mutate`/`getSnapshot`/`subscribe`。

## Known Issues

- 无已知问题。需注意：`save()` 中思考预算校验报错键 `invalidBatchThinking`（第 488 行）在 `zh()`/`en()` 字典中未定义（仅 `invalidConcurrency` 存在，第 64/182 行），校验失败时会显示原始键名而非本地化文本。