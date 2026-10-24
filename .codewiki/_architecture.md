---
title: System Architecture Overview
type: architecture
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接]
---

## Overview

本文件为 `@local/dsh-codewiki` 插件（版本 0.10.8，见 `package.json:3`）的系统总览，专为零上下文的未来 agent 编写。插件将 Rust CLI `cw`（来自 `mraza007/codewiki`）接入 DeepSeek Harness，提供代码维基自动生成、更新与进度查询能力。系统由核心代码与配置（`index.js`/`client.js` 等）、文档与元信息（`README.md`/`CodeWiki.md` 等）、测试脚本（`test-*.mjs`）以及运行/测试日志（`logs-and-temp` 模块）四大逻辑部分构成。整体以 cordis 插件机制挂载，依赖宿主 `llm` 服务进行模型推理，通过后台阶段机编排将仓库源码编译为结构化 wiki 文章。

## System Overview

系统组件与职责连接的总框图如下：

```text
┌───────────────────────┐     ┌───────────────────────┐
│ docs-and-meta         │     │ logs-and-temp         │
│ (README.md等)         │◄────│ (.tmp-test-*.log)     │
└───────────┬───────────┘     └───────────┬───────────┘
            │ 描述/配置约定 ►              │ 产出日志
            ▼                             ▼
┌───────────────────────┐     ┌───────────────────────┐
│ core-and-config       │◄────│ test-scripts          │
│ (index.js/client.js)  │ 验证│ (test-*.mjs)          │
└───────────┬───────────┘     └───────────────────────┘
            │ 经 cordis.patch.yml 挂载
            ▼
┌───────────────────────┐
│ DeepSeek Harness 宿主 │
│ (llm/webServer)       │
└───────────────────────┘
```

`core-and-config` 模块（`index.js:2928` 的 `apply`）是系统运转中枢；`docs-and-meta` 为其提供人机接口说明与配置约定；`test-scripts` 直接导入 `./index.js`（`test-batch.mjs:7`）验证契约；`logs-and-temp` 收集测试与 watcher 输出以供排查。

## Data Flow

请求与数据在模块间的流动路径如下：

```text
┌──────────┐  codewiki_generate ┌──────────────┐  cw status ┌──────────┐
│ Agent/UI │───────────────────►│ index.js     │──────────►│ cw CLI   │
│ (会话/   │◄───────────────────│ (JobService) │◄─────────│ (bin/cw) │
│ client)  │  进度/steer 唤醒    │              │  源码/状态 └──────────┘
└────┬─────┘                    └──────┬───────┘
     │ GET /api/codewiki/jobs          │ 阶段机
     ▼                                 ▼
┌──────────┐  submitBatchFor    ┌──────────────┐  llmChat  ┌──────────┐
│client.js │───────────────────►│ runRealtime  │─────────►│ 宿主 llm │
│ (面板)   │◄───────────────────│ Tasks        │◄─────────│ 服务     │
└──────────┘  轮询渲染           └──────┬───────┘  结果     └──────────┘
                                         │ 落盘
                                         ▼
                                   ┌──────────────┐
                                   │ .codewiki/   │
                                   │ (文章+锚点)  │
                                   └──────────────┘
```

1. 会话内调用 `codewiki_generate`（`index.js:2097` 定义）触发 `svc.submit`（`index.js:2097`）创建 job，立即返回。
2. 后台 `tick`（`index.js:2018`）每 10s（`index.js:2018`）推进阶段机 `articles→crosscut→compose→review→index`（`index.js:2018` 起）。
3. 文章阶段调用 `prepareArticleTasks`（`index.js:555`）并经由 `llmChat`（`index.js:283`）走宿主 `llm` 服务；结果通过 `fixAnchors`（`index.js:396`）校正行号后写入 `.codewiki/`。
4. `client.js` 的 `CodewikiPanel`（`client.js:1124`）每 2s（`client.js:1124`）轮询 `/api/codewiki/jobs`（`index.js:2656`）渲染进度。
5. 测试脚本（`test-scripts`）在 CI 中导入 `index.js` 驱动相同流程，将断言结果写入 `logs-and-temp` 的 `.tmp-test-*.log`。

## Dependency Graph

各模块间的依赖方向（箭头表示“依赖于”或“被描述/验证于”）：

```text
┌──────────────────┐       ┌──────────────────┐
│ docs-and-meta    │◄──────│ core-and-config  │
│ (描述契约)        │ 说明   │ (实现插件)        │
└──────────────────┘       └────────┬─────────┘
                                    │ 被导入
                                    ▼
                          ┌──────────────────┐
                          │ test-scripts      │
                          │ (import ./index)  │
                          └─────────┬─────────┘
                                    │ 产出日志 ─►
                                    ▼
                          ┌──────────────────┐
                          │ logs-and-temp    │
                          │ (日志存储)        │
                          └──────────────────┘
```

- `core-and-config` 依赖 `docs-and-meta` 定义的配置字段语义（如 `Config` schema 见 `index.js:48`，对应 `README.md:55-66`）。
- `test-scripts` 强依赖 `core-and-config` 的 `./index.js` 导出（`test-batch.mjs:7`、`test-orchestration.mjs:20`）。
- `logs-and-temp` 被动依赖 `test-scripts` 与运行期 watcher 产生内容（如 `.tmp-test-orchestration.log:1` 来自编排测试）。
- `cordis.patch.yml`（`core-and-config`）将 `index.js` 挂载为 `id: codewiki`（`cordis.patch.yml:2`），由宿主环境加载。

## Module Roles

各模块在系统中的具体职责与关键连接点：

### docs-and-meta（`README.md`, `CodeWiki.md`, `CHANGELOG.md`, `.probe3.txt`）
- **职责**：提供插件安装、工具列表、配置模型字段定义（`README.md:24-39`）、架构细化（`CodeWiki.md:30-48`）、版本演进（`CHANGELOG.md:3-627`）及内部探针标记（`.probe3.txt:1`）。
- **连接**：以纯文本形式描述 `core-and-config` 的行为；`CodeWiki.md:56` 通过 `[[codewiki-upstream]]` 关联 `vendor/codewiki` 上游布局。

### core-and-config（`index.js`, `client.js`, `cordis.patch.yml`, `package.json`, `.gitignore`）
- **职责**：插件唯一核心实现。`index.js` 导出 `name='dsh-codewiki'`（`index.js:1213`）、配置 schema（`index.js:1213`）、工具 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`（分别见 `index.js:1213`, `2196`, `2355`, `2426`）、后台 `createJobService`（`index.js:1213`）及 webServer 端点（`index.js:1213`）。`client.js` 提供设置页与侧边栏面板（`client.js:7` 起）。`cordis.patch.yml` 负责挂载，`package.json` 声明包元信息（`package.json:25`）。
- **连接**：经 `cordis.patch.yml` 由宿主加载；调用宿主 `llm` 服务（`index.js:283`）；通过 `/api/codewiki/*` 与 `client.js` 通信；写盘 `.codewiki/` 目录。

### test-scripts（`test-batch.mjs`, `test-cwd-paths.mjs`, `test-orchestration.mjs`, `test-wiki-anchors.mjs`, `test-wiki-entry.mjs`）
- **职责**：端到端测试套件。`test-batch.mjs` 验纯函数与端点（`test-batch.mjs:16` 起）；`test-cwd-paths.mjs` 验路径归一化（`test-cwd-paths.mjs:34`）；`test-orchestration.mjs` 验服务编排与重启恢复（编排见 `test-orchestration.mjs:443`，重启恢复见 `test-orchestration.mjs:684`）；`test-wiki-anchors.mjs` 校验行号锚点符号绑定（`test-wiki-anchors.mjs:82`）；`test-wiki-entry.mjs` 验入口生成（`test-wiki-entry.mjs:26`）。
- **连接**：直接 `import './index.js'` 驱动 `core-and-config`；与 `docs-and-meta` 中记录的契约（如 0.10.1 移除内置直连，`test-batch.mjs:451` 断言）互验。

### logs-and-temp（`.tmp-test-batch.log`, `.tmp-test-cwd-paths.log`, `.tmp-test-orchestration.log`, `.tmp-test-wiki-anchors.log`, `.tmp-test-wiki-entry.log`, `watcher2.log`）
- **职责**：保存测试运行输出与 watcher 监听日志（如 `watcher2.log:1` 记录 job 轮询），供错误排查与运行时审查（见 `logs-and-temp` 模块 `Overview`）。
- **连接**：由 `test-scripts` 执行与 watcher 进程生成；反映 `core-and-config` 运行态与 `docs-and-meta` 已知问题（如 `.tmp-test-orchestration.log:573` 记录 `source` 标记失败）。

以上即为系统全貌，未来 agent 可依据模块角色与行号锚点快速定位代码、文档与测试。