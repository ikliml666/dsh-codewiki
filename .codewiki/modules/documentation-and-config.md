I will now generate the updated `modules/documentation-and-config.md` article based on the provided source code. I have analyzed all the files including `.gitignore`, `CHANGELOG.md`, `CodeWiki.md`, `client.js` (structure only), `cordis.patch.yml`, `package.json`, and `README.md`.

Key updates from the old version:
1.  **Version**: Updated to `0.5.0.3`.
2.  **Architecture**: The pipeline is fully batch-driven with a host-resident JobService. No subagents for compilation.
3.  **Components**:
    *   `index.js`: Contains `Config`, `installUpdateReminder`, `runCw`, `parseStatus`, Batch Inference modules (`estimateTokens`, `collectSources`, `prepareArticleTasks`, `buildBatchJsonl`, `parseBatchResults`, `settleBatch`, `runRealtimeTasks`, `resolveBatchApiKey`, `bailianChat`), `createJobService`, `cwToolDefinition`, `generateToolDefinition`, webServer endpoints, and `apply`.
    *   `client.js`: Contains `CodewikiCard` (settings) and `CodewikiPanel` (sidebar panel with 6-stage progress, dual-channel throughput, usage stats).
    *   `vendor/codewiki/`: Local fork of upstream, with `config.rs` modified for wiki path and `main.rs` for Windows path normalization.
4.  **Data Flow**: Detailed flow for config, credentials, tasks (with job persistence and orphan takeover), and panel polling.
5.  **Known Issues**: Hot reload limits, junction dependency, cw version detection, path compatibility, batch inference restrictions.

I will now write the full article.

```markdown
---
title: documentation-and-config
type: module
source_files:
  - .gitignore
  - CHANGELOG.md
  - CodeWiki.md
  - client.js
  - cordis.patch.yml
  - index.js
  - package.json
  - README.md
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块负责管理 `@local/dsh-codewiki` 插件的项目元数据、配置补丁、变更日志历史以及面向用户的文档体系。该模块通过标准化的文件结构（`package.json`, `cordis.patch.yml`, `README.md`, `CodeWiki.md`, `client.js`, `index.js`）定义了插件的挂载方式、依赖关系和运行行为，并通过 `CHANGELOG.md` 记录了从 0.1.0 到 0.5.0.3 的核心功能演进，包括从子代理编排到全批量流水线、侧边栏面板集成、服务化任务调度、孤儿任务接管、面板信息密度改版以及 vendor/codewiki 本地化重构等重大架构变更。当前版本（0.5.0.3）实现了零子代理编译：`codewiki_generate` 为纯提交制，由宿主常驻 JobService 驱动六个阶段（规划/写文章/横切/合成/审校/索引）全部经阿里云百炼批量推理完成。

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

### `client.js` (根目录)
- **描述**: 插件页设置卡片与侧边栏面板（浏览器半侧）。
- **内容**:
  - **注册**: `__ModuleLoader__.load({id:'@local/dsh-codewiki'})` → `plugins.item`（order 30，设置表单）+ `main`/`sidebar.panellist` 双 slot（key/id='codewiki'，order 52，任务面板）。
  - **CodewikiCard**: 快照订阅（revision 变更才覆盖草稿）；表单：运行节（enabled/updateReminder/maxConcurrency/articleLanguage/binaryPath）+ 批量节（batchApiKey/batchModel/batchThinkingBudget）；保存条 `form.mutate` 单层 op + revision CAS。
  - **CodewikiPanel**: 2s 轮询 `GET /api/codewiki/jobs`，任务卡（仓库名/类型/阶段/已写篇数/notes/wiki 路径）+ 六阶段步骤条（各阶段耗时 `stageTimings`）+ 双通道吞吐徽标（实时 tok/s+spark；批量 篇/分+ETA，`batchSubmittedAt` 起算）+ 用量行（`usage` 输入估算/输出实测/超 32k 档红字）+ 活动流与 `error` 渲染 + 加权总进度条 + 复制 wiki 路径，活动任务可取消（POST control）；总览行带 `articleCount`/上次编译相对时间，调度卡带下次扫描倒计时与扫描统计（`lastScanRepos/lastScanSubmitted`）；`PanelIcon` 内联 SVG。

### `index.js` (根目录)
- **描述**: 插件全部逻辑（单文件，Node ESM）。
- **关键类/函数**:
  - `Config`（index.js:37）— schemastery 设置：enabled / binaryPath / maxConcurrency（实时兑底并发，1–8）/ articleLanguage / updateReminder / 批量三项（batchApiKey 留空自动取模型设置「阿里百炼云」渠道凭证、batchModel 默认 `qwen3.7-flash`、batchThinkingBudget 默认 0=关思考），全部 `.volatile()`，execute/tick 时热读取。
  - `codewiki_progress` 工具（`progressToolDefinition`，index.js:1826）— 只读查编译进度：可选 cwd/jobId 过滤，返回 jobSummary 同源数据 + taskList 完成百分比，render 输出 stage=xx NN% 与任务明细；与 `codewiki_generate`（提交制）配套，让模型不必空等编译完成。
  - `installUpdateReminder` — `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库无 `.codewiki/` 返回空）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过。
  - `runCw` / `parseStatus` — cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）。
  - **批量推理模块** — `estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（文章+旧文上下文+customId，超预算拆任务）/ `buildBatchJsonl`（enable_thinking+thinking_budget 在 body 顶层）/ `parseBatchResults`（结果+错误文件行合并）/ `settleBatch`（终态收尾；keepInMemory 任务 content 进结果不落盘，由服务写盘）/ `runRealtimeTasks`（实时兑底并发池，结果与批量同构）/ `resolveBatchApiKey`（凭据库解析链 3s 超时）/ `bailianChat`（兑底单轮）。
  - `createJobService` — 宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调，下限 250ms）推进阶段机 plan→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`（compose 仅当横切输入超 28k 预算：每篇模块文章一个观察任务并发跑，settle 后以观察 pack 提交合成批；总量装得下则单批直出）；校对按「预算−文章 token」动态装填源码，装不下升大档（200k）重装；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（只剥 apiKey；多实例安全：job 带 owner=创建实例、tick 只推进自家 job，flush 脏标记+mergeFromDisk 磁盘吸收防互相覆盖，tick 进程级 `JOBS_FILE.lock` 串行，cancel 标记每轮 tick 从磁盘跨实例拾取）；submit 占位先行（stage=submitting 挡住凭证窗口内的并发重复提交）；批次未终态保留断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`（0.4.3+ 记 stage/crosscutSplit，resume 按原阶段恢复），下次提交自动续查（resume job）；取消幂等（cancelRequested 跨 tick 存活，取消保留断点可续查）；`writeValidated` 校验 frontmatter 后直接写盘（keepInMemory 任务的唯一写盘点）。
  - `cwToolDefinition` — cw CLI 封装工具（子命令白名单）。
  - `generateToolDefinition` — 纯提交制：normalizeCwd → 凭证解析（无凭证诚实报错，不回退子代理）→ cw status 判态 → 孤儿断点并入（resume）→ 任务预构建（clean 短路 / stale 逐篇直达 articles / 全量走 plan）→ `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用。
  - webServer 端点 — `GET /api/codewiki/jobs`（任务列表，不含 apiKey）与 `POST /api/codewiki/control {action:'cancel',jobId}`，仅回环放行（403）。
  - `apply` — `ctx.inject(['tools','webServer','credentials'])` 注册三工具（`cw` / `codewiki_generate` / `codewiki_progress`）+ 端点；`agent/created` 布提醒。

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
  - `bin/*.bak-*` (cw 二进制备份)

### `CHANGELOG.md` (根目录)
- **描述**: 详细的版本变更历史，记录了架构重构、性能优化和 bug 修复。
- **关键版本**:
  - **0.5.0.3**: 新增 test-wiki-anchors.mjs 自动校验锚点，记录 cargo dead_code 警告为已知可忽略。
  - **0.5.0.2**: vendor/codewiki 真源码本地重建，反斜杠 Rust 层根治，取证收敛。
  - **0.5.0.1**: 自动补建 `CodeWiki.md` 入口，修复编译收尾门控不变量，Windows 路径规范化收口。
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
[JobService] (index.js:1042)
    │ tick (10s) → plan → articles → crosscut → compose → review → index
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
   - 后台 `tick` 推进阶段机：规划 → 写文章 → 横切 → 合成（可选）→ 审校 → 索引。
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
```