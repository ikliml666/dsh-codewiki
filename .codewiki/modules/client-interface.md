---
title: client-interface
type: module
source_files:
  - client.js
tags: [client, react, api-wrapper, plugin-system, sidebar-panel, config-forms]
---

## Overview

`client-interface` 是 CodeWiki 插件的前端核心逻辑（实现于仓库根 `client.js`，经 `cordis.patch.yml` 注入宿主），负责与宿主应用（DeepSeek Host）的深度集成：

1. **插件配置管理**：通过宿主 `configForms` 服务（命名空间 `'codewiki'`，client.js:6）读写插件设置，`configForms.whileServed` 热生效（client.js:378-379），无需重启宿主。
2. **侧边栏面板**：注册侧边栏面板，实时展示编译任务进度、状态与详情（`CodewikiPanel` client.js:918；仓库页 `ReposTab` client.js:773；托盘图标 `PanelIcon` client.js:1120）。
3. **API 封装**：`apiGet`（client.js:343）与 `apiPost`（client.js:349）封装 `/api/codewiki/jobs`、`/api/codewiki/control`、`/api/codewiki/repos` 端点。
4. **UI 组件**：React 组件树渲染设置卡片、任务列表、进度条、六阶段步骤条与统计徽标。

## Key Components

### 配置表单（`CodewikiCard`，client.js:402）

- 表单实例来自 `ctx.configForms.get(NS)`（client.js:367）。
- `snapshot` 状态取自 `form.getSnapshot()`（client.js:405），`draft` 为本地草稿（client.js:406）。
- 保存走 `form.mutate(ops, snapshot.revision)`（client.js:473），按返回值判定保存/冲突；放弃修改 `discard`（client.js:481）。

### 轮询与阶段进度

- 主轮询间隔 `POLL_MS = 2000`（client.js:22），仓库列表 `REPOS_POLL_MS = 10000`（client.js:24）。
- 阶段权重 `STAGE_WEIGHTS`（client.js:720）：plan 0.05 / articles 0.6 / crosscut 0.1 / compose 0.05 / review 0.15 / index 0.05。

## Connections

- [[core-logic]]：面板消费的 `/api/codewiki/*` 端点由 `index.js` 的 `installWebServer` 提供。
- [[configuration-management]]：配置读写链路详解。
