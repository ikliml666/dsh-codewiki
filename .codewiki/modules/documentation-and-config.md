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
  - test-orchestration.mjs
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块负责管理 `@local/dsh-codewiki` 插件的项目元数据、配置补丁、变更日志历史以及面向用户的文档体系。该模块通过标准化的文件结构（`package.json`, `cordis.patch.yml`, `README.md`, `CodeWiki.md`, `client.js`, `index.js`）定义了插件的挂载方式、依赖关系和运行行为，并通过 `CHANGELOG.md` 记录了从 v0.1.0 到 v0.8.7 的核心功能演进。当前版本（v0.8.7）实现了零子代理编译：`codewiki_generate`、`codewiki_update`、`codewiki_progress` 与 `cw` 均为纯工具或提交制入口，由宿主常驻 JobService 驱动六个阶段（规划/写文章/横切/合成/审校/索引）全部经阿里云百炼普通入口完成；同时支持在编译完成后向主模型注入「请提交改动」提醒，且通过 `wakeCompileSession` 机制实现实时唤醒发起会话。排除清单报错已增强为返回命中的具体条目。规划阶段改走主模型执行（避开百炼 32k 三倍价），主模型不可用时降级百炼批量规划。当文章阶段源码超预算时，自动拆分为多个观察批 + 合成请求（避开 32k 三倍价）。DSH 适配修复了 source 形态以匹配宿主校验。LLM 注入修复解决了真实 Cordis 环境下 `hostCtxRef?.llm` 访问抛错导致的规划降级问题，改为模块级 `llmRef` + `ctx.inject`。路由解析改为优先会话配置。**新增行号幻觉修复**：通过 `numberLines()` 函数给源码添加 `N| ` 前缀，解决弱模型自行数行导致的锚点偏移，校对 prompt 强制以前缀为准。

## Key Components

### `package.json` (根目录)
- **描述**: 定义插件的元数据、导出路径及宿主识别标志。
- **字段**:
  - `name`: `@local/dsh-codewiki`
  - `version`: `0.8.7`
  - `description`: CodeWiki for DeepSeek Harness: cw CLI + whole-repo wiki compilation pipeline (plain Bailian endpoint, zero subagents) with a sidebar panel.
  - `private`: `true`
  - `type`: `"module"`
  - `main`: `index.js`
  - `exports`: 
    - `"."`: `./index.js`
    - `"./client"`: `./client.js`
  - `license`: `MIT`
  - `engines`: `{ "node": ">=20", "dsh": ">=0.2.0-rc.0" }`
  - `dependencies`: `{ "@deepseek-ai/schemastery": "^3.18.4" }`
  - `dsh`: 
    - `client.platform`: `"web"` (指示宿主将 `client.js` 注入浏览器环境)
    - `bundle.patch`: `"cordis.patch.yml"` (指定 bundle 形式的挂载补丁)

### `client.js` (根目录)
- **描述**: 插件页设置卡片与侧边栏面板（浏览器半侧）。
- **关键常量**:
  - `NS = 'codewiki'`: 配置命名空间，必须与 `package.json` name 一致以通过校验 (client.js:20)。
  - `KEY = 'codewiki'`: 侧边栏面板 ID (client.js:21)。
  - `POLL_MS = 2000` / `REPOS_POLL_MS = 10000`: 轮询间隔 (client.js:25-26)。
  - `ACTIVE_STAGES`: `['plan', 'articles', 'crosscut', 'compose', 'review', 'index']` (client.js:29)。
  - `STAGE_WEIGHTS`: 进度权重 `{ plan: 0.05, articles: 0.6, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }` (client.js:468)。
- **内容**:
  - **注册**: `apply(ctx)` 挂载入口。注册 locale。注入 `plugins.item` slot (`CodewikiCard`)。注入 `main` slot (`CodewikiPanel`) 和 `sidebar.panellist` slot (`PanelIcon`)。
  - **zh() / en()**: 国际化字典，定义所有 UI 文案（如 `stagePlan`, `kindFull`, `autoUpdateHint` 等）(client.js:37-135)。注意 `t()` 函数若遇到非字符串值会回退返回键名，因此字典值必须全为字符串。
  - **样式注入**: 动态创建 `<style>` 标签并挂载至 `head`，使用 `data-plugin` 属性避免 HMR 重复加载 (client.js:137-195)。定义了 `.dscw-p-*` 系列 CSS 类用于侧边栏面板布局。
  - **apiGet(p) / apiPost(p, data)**: 通用 HTTP 封装，处理 JSON 解析与错误抛出 (client.js:200-215)。
  - **CodewikiCard(props)**: 设置卡片组件 (client.js:225-330)。
    - 使用 `ctx.configForms.get(NS)` 获取配置实例。
    - `save()`: 执行 `form.mutate(ops, snapshot.revision)`，支持乐观更新与冲突检测。若冲突则提示 `t('conflict')` 并重置草稿 (client.js:260-285)。
    - 字段包括：`enabled`, `binaryPath`, `maxConcurrency` (1-8), `articleLanguage`, `updateReminder`, `workspaceOnly`, `batchModel`, `batchThinkingBudget`, `excludePaths`, `autoUpdate`, `autoUpdateMin`。
  - **CodewikiPanel()**: 侧边栏主面板 (client.js:335-560)。
    - 状态管理：`jobs` (当前任务列表), `err`, `busyId`, `tab` (overview/tasks/settings)。
    - `sparkRef` / `batchRateRef`: Refs 存储 TPS 历史数据（用于 Spark 图表）和批量完成速率（用于 ETA 计算）。
    - `pull()`: 每 2s 调用 `/api/codewiki/jobs`，更新 Refs 中的采样数据 (client.js:395-430)。
    - `cancel(jobId)`: 调用 `/api/codewiki/control` POST cancel。
    - **ReposTab()**: 子组件，轮询 `/api/codewiki/repos`，展示仓库状态、调度信息、排除操作 (client.js:335-400)。
  - **PanelIcon()**: 侧边栏图标 SVG。

### `index.js` (根目录)
- **描述**: 插件全部逻辑（单文件，Node ESM）。
- **关键类/函数**:
  - `Config`（index.js:36）— schemastery 设置：enabled / binaryPath / maxConcurrency（编译并发上限，1–8）/ articleLanguage / updateReminder / 编译模型两项（batchModel 默认 `qwen3.7-flash`、batchThinkingBudget 默认 0=关思考），全部 `.volatile()`，execute/tick 时热读取。注：`batchMinTokens` 等批量阈值配置已在 0.6.0 中删除。
  - `codewiki_progress` 工具（`progressToolDefinition`，index.js:1815-1911）— 只读查编译进度：可选 cwd/jobId 过滤，返回 jobSummary 同源数据 + taskList 完成百分比，render 输出 stage=xx NN% 与任务明细；与 `codewiki_generate`（提交制）配套，让模型不必空等编译完成。
  - `codewiki_update` 工具（`updateToolDefinition`，index.js:1778）— 日常维护入口：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「继续下一项、不要等待」；错误消息里的 `codewiki_generate` 字样改写为 `codewiki_update`；参数仅 cwd/language（scope=full/stale 仍走 `codewiki_generate`）；apply() 注册为第四个工具。
  - `installUpdateReminder` — `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库无 `.codewiki/` 返回空）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过。
  - `runCw` / `parseStatus` — cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）。
  - **模型执行模块** — `estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（文章+旧文上下文+customId，超预算拆任务）/ `settleJob`（终态收尾；keepInMemory 任务 content 进结果不落盘，由服务写盘）/ `runRealtimeTasks`（后台并发池，唯一执行器）/ `resolveBatchApiKey`（凭据库解析链 3s 超时）/ `bailianChat`（同步单轮）。注：0.6.0 起全部请求统一走百炼普通入口 `chat/completions`，无专用批量端点。
  - `createJobService` — 宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调，下限 250ms）推进阶段机 plan→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`（compose 仅当横切输入超 28k 预算：每篇模块文章一个观察任务并发跑，settle 后以观察 pack 提交合成批；总量装得下则单批直出）；校对按「预算−文章 token」动态装填源码，装不下升大档（200k）重装；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（只剥 apiKey；多实例安全：job 带 owner=创建实例、tick 只推进自家 job，flush 脏标记+mergeFromDisk 磁盘吸收防互相覆盖，tick 进程级 `JOBS_FILE.lock` 串行，cancel 标记每轮 tick 从磁盘跨实例拾取）；submit 占位先行（stage=submitting 挡住凭证窗口内的并发重复提交）；批次未终态保留断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`（0.4.3+ 记 stage/crosscutSplit，resume 按原阶段恢复），下次提交自动续查（resume job）；取消幂等（cancelRequested 跨 tick 存活，取消保留断点可续查）；`writeValidated` 校验 frontmatter 后直接写盘（keepInMemory 任务的唯一写盘点）。
  - `cwToolDefinition` — cw CLI 封装工具（子命令白名单）。
  - `generateToolDefinition` — 纯提交制：normalizeCwd → 凭证解析（无凭证诚实报错，不回退子代理）→ cw status 判态 → 孤儿断点并入（resume）→ 任务预构建（clean 短路 / stale 逐篇直达 articles / 全量走 plan）→ `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用。
  - webServer 端点 — `GET /api/codewiki/jobs`（任务列表，不含 apiKey）与 `POST /api/codewiki/control {action:'cancel',jobId}`，仅回环放行（403）。
  - `apply` — `ctx.inject(['tools','webServer','credentials'])` 注册四工具（`cw` / `codewiki_generate` / `codewiki_progress` / `codewiki_update`）+ 端点；`agent/created` 布提醒。
  - `commitHintText`（export 供测试）— 编译完成提交提醒：update-reminder 系统 prompt section 兼职——最近一次成功编译（stage=done 且 writtenCount>0）的 finishedAt 晚于 `.codewiki/`+`CodeWiki.md` 最后一次 git 提交 → 注入「【CodeWiki 编译完成·请提交改动】」提醒（只 add 这两个路径、docs(wiki) 前缀、禁 git add -A；模型自己提交，插件不代跑 git）。零持久状态：时间戳派生自 jobs 文件与 git log，提交后时间戳反超自动静默；非 git 仓库/无 .codewiki 提交史（log 空）/读 jobs 失败一律不提醒；60s TTL 缓存。受 updateReminder 开关与「仓库根存在 CodeWiki.md」门控约束。
  - `wakeCompileSession`（index.js，export 供测试）— 编译终态对发起会话 `steer(createUserMessage({...source:{kind:'plugin:codewiki'}}))`——done（writtenCount>0）发「【CodeWiki 编译完成·请提交改动】」、failed 发「【CodeWiki 编译失败】」；sessionId 缺失（面板/自动调度提交）、会话不在注册表（冷会话）、steer 异常一律静默跳过（系统提示 section 拉取兜底仍在）。
  - `excludedItem(cwd, list)` — 返回命中的排除清单条目原文（0.8.1 新增）；`isExcluded` 改为 `excludedItem(...) !== null` 的布尔包装。
  - `runMainModelPlan(job, prompt)`（index.js，0.8.3 新增，0.8.6 修复）— 取发起会话 agent（`agentsRef.get(job.sessionId)`）→ `agent.session.requestHeader()?.config` 拿主模型 {provider, model} → `ctx.llm.stream()`（hostCtxRef 属性 + inject(['llm']) 双取法，兼容 mock ctx 与真实 cordis，0.8.6 修复 hostCtxRef?.llm 抛错导致降级问题）+ `BlockAssembler` 收文本，`createUserMessage` 带 `source:{kind:'plugin:codewiki'}`；temperature 0；AbortController 入 batchAborters（取消编译可中断规划）；usage 按实测 outputTokens + estimateTokens(input) 记账（requests:1, realtime:true）。
  - `tickPlan`（改造）— 先主模型规划 → parsePlan 成功入库并 note「规划（主模型）」；主模型不可用（无 sessionId/路由/llm）或未产出可用 JSON → 降级百炼批量规划（原 submitBatchFor 路径与 batchRef 收割逻辑零改动）。
  - `batchArticleObservePrompt(language,moduleName,sourcesText,batchIndex,batchTotal)`（index.js，0.8.4 新增）— 分批观察 prompt，要求保留全部函数/类/导出名、常量默认值、行号、调用关系、文件清单；禁 frontmatter。
  - `batchArticleComposePrompt({language,mission,moduleName,observationsText,prevArticle})`（index.js，0.8.4 新增）— 观察包 → 完整文章，沿用观察中的「文件:行号」，汇总 source_files，articleFormatSection() 收尾。
  - `prepareArticleTasks`（index.js:441-497，0.8.4 改造）— 分割判定：collectSources 28k 装填后 prompt 估算 >BATCH_TOKEN_BUDGET **或存在装不下的溢出文件**（overflowFiles，堵静默 skip）→ 逐单文件重新分批，batches.length>1 → 每批一个观察任务 `{customId:'split{n}o{i}', name:'<article>#obs{i}', keepInMemory:true, splitFor, composePlan:{mission,articlePath,prevArticlePath,batchCount,files}}`；单文件占满分不出多批时落回 BATCH_TOKEN_HARD_LIMIT 大档（原行为）。
  - `tickArticles`（0.8.4 改造）— results 含 `#obs` → 按 articleName 分组（composedArticles Set 去重，每篇一条合成任务）→ 从持久化任务快照重建合成任务（customId `o\d+$`→`c`）→ submitBatchFor 合成轮 → 下一轮收割写盘；观察全失败该篇缺席并 note；部分失败合成基于剩余观察。
  - `submitBatchFor`（0.8.4 补带）— 持久化 job.tasks 补带 `splitFor/composePlan`（宿主重启后收割重建合成所需的元数据，原快照会丢）。
  - `numberLines(text)`（index.js，0.8.7 新增）— 行号幻觉修复。给源码添加 `N| ` 前缀，解决弱模型自行数行导致的锚点偏移。处理 CRLF 和双尾换行。

### `cordis.patch.yml` (根目录)
- **描述**: Cordis 插件系统的 YAML 挂载补丁，用于本地开发和 Bundle 安装。
- **操作**: `- insert`
- **条目**:
  - `id`: `codewiki`
  - `name`: `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js` (指向主逻辑文件，cordis.patch.yml:12)
  - `config`: `{}` (空对象，设置项通过运行时注入或 UI 表单修改)

### `README.md` (根目录)
- **描述**: 用户级文档，介绍插件功能、工具接口、设置选项及安装方法。
- **内容**:
  - 提供 `cw`、`codewiki_generate`、`codewiki_progress` 和 `codewiki_update` 工具的说明。
  - 列出所有 volatile 设置项（如 `binaryPath`, `maxConcurrency` 等）。
  - 详细说明 file:/// 直挂的安装步骤和依赖解析（junction）。
  - **`codewiki_generate` 行为**:
    - `scope=auto`: 智能判态（无 wiki->全量，有变更->增量，最新->跳过）。
    - `scope=full`: 强制全量。
    - 降级策略：规划 agent 失败降级为单 agent 全量；单篇失败不中断；全部失败不刷新基线。
    - 并发硬顶 2 (README: 写文章并发上限硬顶 2，但 client.js 设置允许 1-8，需确认 index.js 中是否对 articles 阶段有特殊限制，client.js 仅做 UI 校验 1-8)。

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
  - `bin/*.bak-*` (cw 二进制备份，安全网机制，防止上游更新或清理后无法恢复已知工作版本，见 CHANGELOG 0.5.0.2)
  - `.orch-test-out.txt`
  - `.probe3.txt`

### `CHANGELOG.md` (根目录)
- **描述**: 详细的版本变更历史，记录了架构重构、性能优化和 bug 修复。
- **关键版本**:
  - **0.8.7**: 行号幻觉修复。新增 `numberLines()` 函数，给源码加 `N| ` 前缀，解决弱模型自行数行导致的锚点偏移。校对 prompt 强制以前缀为准。
  - **0.8.6**: LLM 注入修复：`runMainModelPlan` 中 `hostCtxRef?.llm` 访问在真实 Cordis 下抛错导致规划降级。修复为模块级 `llmRef` + `ctx.inject`。路由解析改为优先会话配置。
  - **0.8.5**: DSH 适配修复：source 形态从 `{kind:'plugin', plugin:'codewiki'}` 调整为 `{kind:'plugin:codewiki'}` 以匹配宿主 0.2.1-rc.2 校验；补充 `engines.dsh` 声明。
  - **0.8.4**: 文章阶段超预算分割：观察批 map + 合成请求 reduce（避开 32k 三倍价，用户需求）。新增 `batchArticleObservePrompt` 与 `batchArticleComposePrompt`；`prepareArticleTasks` 分割判定与 `tickArticles` 两段状态机；`submitBatchFor` 补带 `splitFor/composePlan`；测试基建突破。
  - **0.8.3**: 规划阶段改走主模型（避开百炼 32k 三倍价，用户需求）。新增 `runMainModelPlan`，`tickPlan` 改造为先主模型规划后降级百炼。
  - **0.8.2**: 修复 4 个 cw 工具在新宿主全部消失（根因：progress schema type 数组）。4 处 type 数组改子集合法的 nullable 表达 `{ oneOf: [{type:'object'},{type:'null'}] }` 等价形态；工具注册循环加 per-definition try/catch。
  - **0.8.1**: 工具拒绝编译时报错同时返回命中的排除项。新增 `excludedItem` 函数，报错信息携带命中排除项原文。
  - **0.8.0**: 编译终态实时唤醒发起会话。新增 `wakeCompileSession`，编译终态对发起会话 steer 直达，与子代理消息同机制。
  - **0.7.0**: 新增 codewiki_update 日常维护工具 + 编译完成提交提醒。
  - **0.6.0**: 删除百炼批量推理通道：编译全部改走普通入口。删 BATCH_CHAT_BASE/BATCH_CHAT_TIMEOUT_MS、bailianChat 的 batch 参数与 1h 超时/重试包装、linkedSignal、submitOrRun 阈值分流整函数与 localResults 就地实时路径；6 个提交点统一 `submitBatchFor`；startBatchChatRun/settleJob 文案与记账改「阶段执行器」措辞；Config schema 删 batchMinTokens；client.js 设置页删「批量编译（百炼）」节；测试重写。
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
[JobService] (index.js:920)
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