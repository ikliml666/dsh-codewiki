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
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块负责管理 `@local/dsh-codewiki` 插件的项目元数据、配置补丁、变更日志历史以及面向用户的文档体系。该模块通过标准化的文件结构（`package.json`, `cordis.patch.yml`, `README.md`, `CodeWiki.md`, `client.js`, `index.js`）定义了插件的挂载方式、依赖关系和运行行为，并通过 `CHANGELOG.md` 记录了从 0.1.0 到 0.6.0 的核心功能演进，包括从子代理编排到全批量流水线、侧边栏面板集成、服务化任务调度、孤儿任务接管、面板信息密度改版、进度工具新增以及最终删除百炼专用批量通道（统一走普通入口）等重大架构变更。当前版本（0.6.0）实现了零子代理编译：`codewiki_generate` 为纯提交制，由宿主常驻 JobService 驱动六个阶段（规划/写文章/横切/合成/审校/索引）全部经阿里云百炼普通入口完成。

## Key Components

### `package.json` (根目录)
- **描述**: 定义插件的元数据、导出路径及宿主识别标志。
- **字段**:
  - `name`: `@local/dsh-codewiki`
  - `version`: `0.6.0`
  - `description`: CodeWiki for DeepSeek Harness: cw CLI + whole-repo wiki compilation pipeline (plain Bailian endpoint, zero subagents) with a sidebar panel.
  - `private`: `true`
  - `type`: `"module"`
  - `main`: `index.js`
  - `exports`: 
    - `"."`: `./index.js`
    - `"./client"`: `./client.js`
  - `license`: `MIT`
  - `engines`: `{ "node": ">=20" }`
  - `dependencies`: `{ "@deepseek-ai/schemastery": "^3.18.4" }`
  - `dsh`: 
    - `client.platform`: `"web"` (指示宿主将 `client.js` 注入浏览器环境)
    - `bundle.patch`: `"cordis.patch.yml"` (指定 bundle 形式的挂载补丁)

### `client.js` (根目录)
- **描述**: 插件页设置卡片与侧边栏面板（浏览器半侧）。
- **内容**:
  - **注册**: `__ModuleLoader__.load({id:'@local/dsh-codewiki'})` → `plugins.item`（order 30，设置表单）+ `main`/`sidebar.panellist` 双 slot（key/id='codewiki'，order 52，任务面板）。
  - **CodewikiCard**: 快照订阅（revision 变更才覆盖草稿）；表单：运行节（enabled/updateReminder/maxConcurrency/articleLanguage/binaryPath）+ 编译模型节（batchModel/batchThinkingBudget）；保存条 `form.mutate` 单层 op + revision CAS。注：批量编译节（secBatch）已在 0.6.0 中删除，仅保留编译模型设置。
  - **CodewikiPanel**: 2s 轮询 `GET /api/codewiki/jobs`，任务卡（仓库名/类型/阶段/已写篇数/notes/wiki 路径）+ 六阶段步骤条（各阶段耗时 `stageTimings`）+ 实时吞吐徽标（tok/s+spark）+ 用量行（`usage` 输入估算/输出实测/超 32k 档红字）+ 活动流与 `error` 渲染 + 加权总进度条 + 复制 wiki 路径，活动任务可取消（POST control）；总览行带 `articleCount`/上次编译相对时间，调度卡带下次扫描倒计时与扫描统计（`lastScanRepos/lastScanSubmitted`）；`PanelIcon` 内联 SVG。

### `index.js` (根目录)
- **描述**: 插件全部逻辑（单文件，Node ESM）。
- **关键类/函数**:
  - `Config`（index.js:36）— schemastery 设置：enabled / binaryPath / maxConcurrency（编译并发上限，1–8）/ articleLanguage / updateReminder / 编译模型两项（batchModel 默认 `qwen3.7-flash`、batchThinkingBudget 默认 0=关思考），全部 `.volatile()`，execute/tick 时热读取。注：`batchMinTokens` 等批量阈值配置已在 0.6.0 中删除。
  - `codewiki_progress` 工具（`progressToolDefinition`，index.js:1753）— 只读查编译进度：可选 cwd/jobId 过滤，返回 jobSummary 同源数据 + taskList 完成百分比，render 输出 stage=xx NN% 与任务明细；与 `codewiki_generate`（提交制）配套，让模型不必空等编译完成。
  - `installUpdateReminder` — `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库无 `.codewiki/` 返回空）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过。
  - `runCw` / `parseStatus` — cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）。
  - **模型执行模块** — `estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（文章+旧文上下文+customId，超预算拆任务）/ `settleJob`（终态收尾；keepInMemory 任务 content 进结果不落盘，由服务写盘）/ `runRealtimeTasks`（后台并发池，唯一执行器）/ `resolveBatchApiKey`（凭据库解析链 3s 超时）/ `bailianChat`（同步单轮）。注：0.6.0 起全部请求统一走百炼普通入口 `chat/completions`，无专用批量端点。
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
  - 提供 `cw`、`codewiki_generate` 和 `codewiki_progress` 工具的说明。
  - 列出所有 volatile 设置项（如 `binaryPath`, `defaultProvider`, `maxConcurrency` 等）。
  - 详细说明 file:/// 直挂的安装步骤和依赖解析（junction）。

### `CodeWiki.md` (根目录)
- **描述**: 插件自身的 CodeWiki 入口文件，遵循 `<repo>/CodeWiki.md` 公约。
- **状态**: 在 v0.5.0.1 之前需手动维护；v0.5.0.1 起由流水线自动生成或补建。
- **内容**:
  - `Overview`: 简述插件核心能力（零子代理、百炼普通入口推理、侧边栏面板）。
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
  - **0.6.0**: 删除百炼批量推理通道：编译全部改走普通入口（用户决策）。删 BATCH_CHAT_BASE/BATCH_CHAT_TIMEOUT_MS、bailianChat 的 batch 参数与 1h 超时/重试包装、linkedSignal、submitOrRun 阈值分流整函数与 localResults 就地实时路径；6 个提交点统一 `submitBatchFor`；startBatchChatRun/settleJob 文案与记账改「阶段执行器」措辞；Config schema 删 batchMinTokens；client.js 设置页删「批量编译（百炼）」节；测试重写。
  - **0.5.0.6**: 新增 codewiki_progress 只读查进度工具（后台编译语义对模型显式化）。
  - **0.5.0.5**: 百炼批量通道从 Batch File 切换为 Batch Chat（省钱需求落地）。
  - **0.5.0.4**: 收尾提醒封死「手工流程」逃生通道。
  - **0.5.0.3**: wiki 行号锚点自动校验（审核教训制度化）。
  - **0.5.0.2**: cw 真源码本地重建（vendor/codewiki 成为可维护 fork）+ 反斜杠 Rust 层根治。
  - **0.5.0.1**: 编译收尾自动补建 CodeWiki.md 入口（守护门控不变量闭合）。
  - **0.5.0**: 面板信息密度改版（阶段步骤条 + 双通道吞吐 + 用量统计）。
  - **0.4.0**: 服务化全批量流水线：零子代理 + 侧边栏面板 + 32k 分块并行。
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
[JobService] (index.js:899)
    │ tick (10s) → plan → articles → crosscut → compose → review → index
    │           └─ Bailian Plain Endpoint (后台并发池，超大任务升 200k 大档装填)
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
2. **凭证流**: 显式 `batchApiKey`（存量字段，设置页不再渲染）> 宿主凭据库 `resolve('ALIYUN_BAILIAN_API_KEY')` (来自模型设置“阿里百炼云”渠道)。取不到凭证诚实报错，不回退子代理。
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
- [[bailian-inference]] — 阿里云百炼 OpenAI 兼容接口（普通入口），提供 Token 生成，支持 `qwen3.7-flash` 等模型。

## Known Issues

1. **插件注册不热加载**: 修改 `index.js` 或 `profile patch` 后需重启 dsh。`client.js` 因被判定为“非 client 包”（按 Loader 条目缓存），新增 `dsh.client` 声明后也需重启才能进入浏览器。
2. **Junction 依赖**: `@deepseek-ai/schemastery` 依赖本地 junction (`node_modules/@deepseek-ai/schemastery` → `/e/software/deepseek-harness/vendor/schemastery`)，换机器需重建。
3. **上游版本探测**: 上游 `cw` 无 `--version` 命令；`cw path` 在未 init 仓库退回插件侧 fallback (`<cwd>/.codewiki`)。
4. **路径兼容**: 上游 stale 文章路径输出反斜杠 (`modules\app.md`)，插件消费侧已归一化为 `/`。
5. **批次窗口历史遗留**: 0.5.x 批量通道的 24h 断点语义已随 0.6.0 删除；现断点文件仅记录阶段机位置（stage/crosscutSplit），重跑走普通入口同步请求。