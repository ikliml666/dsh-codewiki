---
title: documentation-and-config
type: module
source_files:
  - .gitignore
  - CHANGELOG.md
  - CodeWiki.md
  - cordis.patch.yml
  - package.json
  - README.md
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块负责管理 `@local/dsh-codewiki` 插件的项目元数据、配置补丁、变更日志历史以及面向用户的文档体系。该模块通过标准化的文件结构（`package.json`, `cordis.patch.yml`, `README.md`, `CodeWiki.md`）定义了插件的挂载方式、依赖关系和运行行为，并通过 `CHANGELOG.md` 记录了从 0.1.0 到 0.5.0.1 的核心功能演进，包括从子代理编排到全批量流水线、侧边栏面板集成以及 CodeWiki 入口自动生成的重大架构变更。

## Key Components

### `package.json` (根目录)
- **描述**: 定义插件的元数据、导出路径及宿主识别标志。
- **字段**:
  - `name`: `@local/dsh-codewiki`
  - `version`: `0.5.0`
  - `main`: `index.js`
  - `exports`: 包含 `"."` (`./index.js`) 和 `"./client"` (`./client.js`)，允许宿主扫描器发现客户端模块。
  - `dsh.client.platform`: `"web"`，指示宿主将 `client.js` 注入浏览器环境。
  - `dsh.bundle.patch`: `"cordis.patch.yml"`，指定 bundle 形式的挂载补丁。
  - `dependencies`: 依赖 `@deepseek-ai/schemastery` (^3.18.4)。

### `cordis.patch.yml` (根目录)
- **描述**: Cordis 插件系统的 YAML 挂载补丁，用于本地开发和 Bundle 安装。
- **操作**: `- insert`
- **条目**:
  - `id`: `codewiki`
  - `name`: `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (指向主逻辑文件)
  - `config`: `{}` (空对象，设置项通过运行时注入或 UI 表单修改)

### `README.md` (根目录)
- **描述**: 用户级文档，介绍插件功能、工具接口、设置选项及安装方法。
- **内容**:
  - 提供 `cw` 和 `codewiki_generate` 工具的说明。
  - 列出所有 volatile 设置项（如 `binaryPath`, `defaultProvider`, `maxConcurrency` 等）。
  - 详细说明 file:/// 直挂的安装步骤和依赖解析（junction）。

### `CodeWiki.md` (根目录)
- **描述**: 插件自身的 CodeWiki 入口文件，遵循 `<repo>/CodeWiki.md` 公约。
- **状态**: 在 v0.5.0.1 之前需手动维护；v0.5.0.1 起由流水线自动生成或补建。
- **内容**:
  - `Overview`: 简述插件核心能力（零子代理、百炼批量推理、侧边栏面板）。
  - `Key Components`: 详细列出 `index.js` 中的类、函数、常量及其行号用途；`client.js` 的组件注册；`vendor/codewiki/` 的上游来源。
  - `Architecture`: ASCII/UTF-8 框图展示任务流。
  - `Data Flow`: 配置流、凭证流、任务流、面板流的描述。
  - `Connections`: 链接上游 `[[codewiki-upstream]]`。
  - `Known Issues`: 记录热加载限制、junction 依赖、版本探测问题等。

### `.gitignore` (根目录)
- **描述**: Git 忽略规则。
- **规则**:
  - `node_modules/`
  - `vendor/codewiki/target/` (Rust 构建产物)
  - `*.log`

### `CHANGELOG.md` (根目录)
- **描述**: 详细的版本变更历史，记录了架构重构、性能优化和 bug 修复。
- **关键版本**:
  - **0.5.0.1**: 自动补建 `CodeWiki.md` 入口，修复编译收尾门控不变量。
  - **0.5.0**: 面板信息密度改版，六阶段步骤条，双通道吞吐，用量统计。
  - **0.4.0**: 服务化全批量流水线，零子代理，侧边栏面板，32k 分块并行。
  - **0.3.0**: 引入阿里云百炼批量推理（Batch File），写文章环节降本。
  - **0.2.x**: 修复子代理路由、路径兼容性、设置页 UI 接入等问题。

## Architecture

```text
[模型调用] 
    │
    ▼
[codewiki_generate Tool] (index.js)
    │ normalizeCwd → cw status → JobService.submit
    ▼
[JobService] (index.js:~36+)
    │ tick (10s) → plan → articles → crosscut → review → index
    │           ├─ Batch Inference (Bailian)
    │           └─ Realtime Fallback (if oversized)
    ▼
[Cw CLI Wrapper] (runCw / parseStatus)
    │ cw index + cw meta update
    ▼
[Wiki Output] (<repo>/.codewiki/)
    │
    ├──► [Side Panel] (client.js)
    │     2s poll GET /api/codewiki/jobs
    │     Display: Stage, Progress, Usage, Notes
    │
    └──► [Config Forms] (client.js)
          Hot-reload via configForms.mutate
```

## Data Flow

1. **配置流**: `profiles/web/cordis.patch.yml` 或 `package.json` 定义初始挂载 → Cordis 注入 `apply(ctx, config)` → `liveConfig` 在每次执行时解包 volatile 设置项。
2. **凭证流**: 显式 `batchApiKey` > 宿主凭据库 `resolve('ALIYUN_BAILIAN_API_KEY')` (来自模型设置“阿里百炼云”渠道) > 回退智能体子代理 (若未启用批量)。
3. **任务流**: 
   - `execute` 预构建任务（含 token 预算分块）。
   - `JobService.submit` 立即返回 `{submitted, jobId, stage}`。
   - 后台 `tick` 推进阶段机：规划 → 写文章 → 横切 → 审校 → 索引。
   - 批次未终态保留断点 (`os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`)，跨会话续查。
   - 成功文章落盘，校对结果回写，最终调用 `cw index` + `cw meta update`。
4. **面板流**: 浏览器端 `CodewikiPanel` 每 2 秒轮询 `GET /api/codewiki/jobs`，渲染任务进度、吞吐量、用量统计和错误信息。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki` (MIT)，提供 Rust CLI `cw`，布局约定 `<repo>/.codewiki/`。
- [[dsh-harness]] — DeepSeek Harness 宿主，提供 Cordis 插件系统、子代理服务、凭据库、模型目录等基础设施。
- [[bailian-inference]] — 阿里云百炼批量推理服务，提供低成本批量 Token 生成，支持 `qwen3.7-flash` 等模型。

## Known Issues

1. **插件注册不热加载**: 修改 `index.js` 或 `profile patch` 后需重启 dsh。`client.js` 因被判定为“非 client 包”（按 Loader 条目缓存），新增 `dsh.client` 声明后也需重启才能进入浏览器。
2. **Junction 依赖**: `@deepseek-ai/schemastery` 依赖本地 junction (`node_modules/@deepseek-ai/schemastery` → `/e/software/deepseek-harness/vendor/schemastery`)，换机器需重建。
3. **上游版本探测**: 上游 `cw` 无 `--version` 命令；`cw path` 在未 init 仓库退回插件侧 fallback (`<cwd>/.codewiki`)。
4. **路径兼容**: 上游 stale 文章路径输出反斜杠 (`modules\app.md`)，插件消费侧已归一化为 `/`。
5. **批量推理限制**: 仅北京地域独立计费，不支持缓存/免费额度；断点最长 24h（百炼批次窗口），过期作废。