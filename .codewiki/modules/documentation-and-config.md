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

`documentation-and-config` 模块是 `@local/dsh-codewiki` 插件的核心基础设施层，负责管理项目元数据、配置补丁、变更日志以及面向用户的文档体系。该模块通过标准化的文件结构（`package.json`, `cordis.patch.yml`, `README.md`, `CodeWiki.md`, `client.js`, `index.js`）定义了插件的挂载方式、依赖关系和运行行为。

当前版本（v0.8.8）实现了**零子代理编译**：`codewiki_generate`、`codewiki_update`、`codewiki_progress` 与 `cw` 均为纯工具或提交制入口，由宿主常驻 JobService 驱动六个阶段（规划/写文章/横切/合成/审校/索引）全部经阿里云百炼普通入口完成。关键特性包括：
1. **实时唤醒机制**：编译完成后通过 `wakeCompileSession` 向发起会话发送通知，并注入「请提交改动」提醒。
2. **主模型优先规划**：规划阶段优先使用发起会话的主模型执行，避开百炼批量排队；失败时降级至百炼批量规划。
3. **超大源码处理**：当文章阶段源码超预算时，自动拆分为多个观察批 + 合成请求（Map-Reduce 模式），避免 32k token 三倍价。
4. **行号幻觉修复**：通过 `numberLines()` 函数给源码添加 `N| ` 前缀，解决弱模型自行数行导致的锚点偏移，校对 prompt 强制以前缀为准。
5. **排除清单增强**：报错信息中返回命中的具体排除条目。
6. **DSH 适配**：修复 source 形态以匹配宿主校验，LLM 注入修复解决了真实 Cordis 环境下 `hostCtxRef?.llm` 访问抛错问题。

## Key Components

### `package.json` (根目录)
- **描述**: 定义插件的元数据、导出路径及宿主识别标志。
- **关键字段**:
  - `name`: `@local/dsh-codewiki` (行 2)。
  - `version`: `0.8.8` (行 3)。
  - `exports`: 
    - `"."`: `./index.js` (行 9)。
    - `"./client"`: `./client.js` (行 10)。
  - `dsh.client.platform`: `"web"` (行 22)，驱动宿主扫描器加载 `client.js`。
  - `dsh.bundle.patch`: `"cordis.patch.yml"` (行 25)。
  - `dependencies`: `{ "@deepseek-ai/schemastery": "^3.18.4" }` (行 18)。
  - `engines`: `{ "dsh": ">=0.2.0-rc.0" }` (行 15)。

### `client.js` (根目录)
- **描述**: 浏览器端（Client）插件入口。注册两个挂载点：`plugins.item`（ID `codewiki`，用于设置表单卡片）和 `sidebar.panellist`/`main`（Key `codewiki`，用于侧边栏编译任务面板）。
- **关键常量**:
  - `NS = 'codewiki'` (行 17): 配置命名空间/插件 ID。
  - `KEY = 'codewiki'` (行 18): 侧边栏面板 Key。
  - `JOBS_PATH = '/api/codewiki/jobs'` (行 19), `CONTROL_PATH = '/api/codewiki/control'` (行 20): API 端点。
  - `PANEL_ORDER = 52` (行 21): 面板在列表中的排序权重。
  - `POLL_MS = 2000` (行 22): 任务轮询间隔。
  - `REPOS_POLL_MS = 10000` (行 24): 仓库总览轮询间隔。
  - `ACTIVE_STAGES` (行 25): 活跃阶段数组 `['plan', 'articles', 'crosscut', 'compose', 'review', 'index']`。
  - `STAGE_WEIGHTS` (行 684): 进度计算权重 `{ plan: 0.05, articles: 0.6, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }`。
- **核心组件**:
  - **`CodewikiCard`** (行 390-598): 设置卡片组件。
    - 状态管理：`snapshot` (来自 `form.getSnapshot`) 和 `draft`。使用 `structuredClone` 深拷贝避免引用污染 (行 409, 424)。
    - 保存逻辑 `save()` (行 435-462): 校验 `maxConcurrency` (1-8整数) 和 `batchThinkingBudget` (0-32768整数) (行 437-446)。构建差异操作 `ops` 调用 `form.mutate(ops, snapshot.revision)` (行 456)，处理乐观更新与冲突检测 (`accepted ? saved : conflict`)。
  - **`CodewikiPanel`** (行 882-1082): 侧边栏主面板。
    - 数据流：`apiGet(JOBS_PATH)` 每 2s 拉取 (行 898-935)。
    - 采样缓存：`sparkRef` (Map<jobId, tps[]>) 存储最近 30 个 TPS 值用于绘制 Sparkline (行 908-911)；`batchRateRef` (Map<jobId, {at, completed, rate}>) 计算 EWMA 平滑后的完成速率 (行 915-922)。
    - 任务分组：按 `cwd` 分组，区分“焦点任务”（活动优先，最新在前）和“历史任务”折叠区 (行 962-974)。
    - 进度计算 `overallPct()` (行 685-693): 基于 `STAGE_WEIGHTS` 和当前阶段内 `taskList` 完成比例线性插值，封顶 99%。
    - 吞吐徽标 `throughputBadge()` (行 696-716): 实时通道显示 `tok/s` + Spark；批量通道显示 `篇/min` + ETA。
  - **`ReposTab`** (行 737-880): 总览标签页。
    - 轮询 `REPOS_PATH` 获取仓库状态 (行 750)。
    - 排除逻辑 `toggleExclude()` (行 667-785): 修改 `excludePaths` 配置，成功后调用 `apiPost(CONTROL_PATH, { action: 'refresh' })` 刷新服务端缓存并重新拉取 (行 778-779)。
    - 编译触发 `compile()` (行 787-795): 调用 `apiPost(CONTROL_PATH, { action: 'compile', cwd })`。
- **辅助函数**:
  - **`apiGet/p`** (行 331-346): 封装 fetch，自动解析 JSON，非 2xx 抛出错误。
  - **`Spark`** (行 639-651): SVG 折线图组件，基于传入的数值数组绘制。
  - **`stageBar`** (行 660-682): 六阶段步骤条，显示各阶段耗时及当前运行状态。
  - **`fmtMs/fmtTok/fmtDur/fmtAgo`** (行 615-637): 时间/数字格式化。

### `index.js` (根目录)
- **描述**: 插件全部逻辑（单文件，Node ESM）。
- **关键类/函数**:
  - **`estimateTokens(text)`** (行 8): Token 粗算器。CJK 每字 1 token，ASCII 每 3.5 字符 1 token（向上取整）。空串返回 0；混合字符串分别计算后求和。
  - **`collectSources(root, files, budget?)`** (行 8): 源码装填器。输入根目录、文件列表、可选 token 预算。输出对象 `{ text: string, skipped: string[], oversized: boolean }`。格式：内联源码带相对路径标题 `### a.ts` 和行号前缀 `1| ...`。缺失处理标注“文件不存在”。尾换行清理仅去除最后一个换行。预算控制：首文件即超预算 `oversized=true`；后续文件超预算加入 `skipped` 列表。
  - **`numberLines(content)`** (行 8): 行号注入器。处理 CRLF/LF，保留真实空行作为独立行。为源码添加 `N| ` 前缀，防止弱模型幻觉数行。
  - **`prepareArticleTasks(tasks, options)`** (行 9): 任务装配器。输入原始任务数组、配置 `{ cwd, language }`。输出 `{ prepared: Task[], oversized: Task[] }`。字段分配：为每个 prepared 任务分配 `customId`。Prompt 装配：合并 mission、语言、源码内容、旧文章上下文。超大文件处理：单文件超 28k 但小于 200k 升级为“大档”继续尝试；连 200k 都装不下进入 `oversized` 列表。多文件分割：当多文件总大小超预算时，拆分为多个 `#obs` 后缀的观察任务。观察任务特征：`keepInMemory=true`, `splitFor` 指向主文章, `composePlan` 携带合成信息。
  - **`runRealtimeTasks(tasks, config)`** (行 9): 实时 LLM 执行器。入参：任务数组，配置 `{ apiKey, model, thinkingBudget, concurrency, notes, signal, onTaskDone }`。行为：并发池执行，支持 AbortController 中止。请求体构造：`enable_thinking` 由 `thinkingBudget` 决定 (0=false, >0=true)；`thinking_budget` 仅在 enabled 时作为顶层键传入。消息结构：单条 user 消息承载 prompt。结果处理：磁盘任务写入 `articlePath`；内存任务返回 `content`。失败处理：记录到 `notes`，不中断其他任务，不落盘。回调：`onTaskDone` 上报 `outputTokens` 和 `durationMs`。
  - **`localPlan(files)`** (行 9): 本地兜底规划。输出 `{ modules: [{name, files}], concepts: [] }`。分组逻辑：按顶层目录分组。
  - **`packArticles(articles, budget)`** (行 9): 横切装填器。行为：按 token 预算截断。首篇整篇装入，后续文章只装头部并标注“仅头部”。
  - **`scanRepoFiles(root)`** (行 9): 仓库勘探器。过滤：跳过 `node_modules`, `.git`, 二进制文件, 超大文件 (>300KB), 空文件。输出：`[{ path, bytes }]`。
  - **`resolveBatchApiKey(inject, config)`** (行 10): 凭证解析链。优先级：显式 `batchApiKey` > 宿主凭据库 (`inject` 提供的 credentials service)。容错：`inject` 非函数或抛错返回 `null`。
  - **`fixAnchors(text, root)`** (行 10): 行号锚点修正器。输入含 Markdown 锚点（如 `` `a.js:1` ``）的文章文本、根目录。输出 `{ fixed: number, unresolved: string[], text: string }`。逻辑：基于 `source_files` frontmatter 解析符号所在文件的实际行号。唯一声明目标：修正行号。起点行已含符号：视为正确，不动。符号未找到：记入 `unresolved`，不动。多处声明（歧义）：不动，记入 `unresolved`。区间修正：起点对齐符号，尾部钳制到文件尾。Basename 匹配：支持子目录 basename 唯一匹配。非清单文件：不处理。CRLF 保真：保留原文换行符。无 frontmatter：原样返回。
  - **`apply(ctx, config)`** (行 20): 插件应用入口。注册 `cw`, `codewiki_generate`, `codewiki_update`, `codewiki_progress` 工具。设置系统提示提醒。
  - **`wakeCompileSession(job, stage, agentsRef)`**: 编译终态唤醒。在 job done/failed 时，通过 `agent.steer` 发送通知消息。
  - **`commitHintText(cwd, jobs)`**: 提交提醒生成。比较编译完成时间与 .codewiki 最后提交时间，决定是否注入提醒。
  - **`runMainModelPlan(job, prompt)`** (0.8.3 新增, 0.8.6 修复): 取发起会话 agent → `agent.session.requestHeader()?.config` 拿主模型 → `ctx.llm.stream()`（hostCtxRef 属性 + inject(['llm']) 双取法，兼容 mock ctx 与真实 cordis，0.8.6 修复 hostCtxRef?.llm 抛错导致降级问题）+ `BlockAssembler` 收文本，`createUserMessage` 带 `source:{kind:'plugin:codewiki'}`；temperature 0；AbortController 入 batchAborters（取消编译可中断规划）；usage 按实测 outputTokens + estimateTokens(input) 记账（requests:1, realtime:true）。
  - **`tickPlan`** (改造): 先主模型规划 → parsePlan 成功入库并 note「规划（主模型）」；主模型不可用（无 sessionId/路由/llm）或未产出可用 JSON → 降级百炼批量规划（原 submitBatchFor 路径与 batchRef 收割逻辑零改动）。
  - **`batchArticleObservePrompt(language,moduleName,sourcesText,batchIndex,batchTotal)`** (0.8.4 新增): 分批观察 prompt，要求保留全部函数/类/导出名、常量默认值、行号、调用关系、文件清单；禁 frontmatter。
  - **`batchArticleComposePrompt({language,mission,moduleName,observationsText,prevArticle})`** (0.8.4 新增): 观察包 → 完整文章，沿用观察中的「文件:行号」，汇总 source_files，articleFormatSection() 收尾。
  - **`prepareArticleTasks`** (0.8.4 改造): 分割判定：collectSources 28k 装填后 prompt 估算 >BATCH_TOKEN_BUDGET **或存在装不下的溢出文件**（overflowFiles，堵静默 skip）→ 逐单文件重新分批，batches.length>1 → 每批一个观察任务 `{customId:'split{n}o{i}', name:'<article>#obs{i}', keepInMemory:true, splitFor, composePlan:{mission,articlePath,prevArticlePath,batchCount,files}}`；单文件占满分不出多批时落回 BATCH_TOKEN_HARD_LIMIT 大档（原行为）。
  - **`tickArticles`** (0.8.4 改造): results 含 `#obs` → 按 articleName 分组（composedArticles Set 去重，每篇一条合成任务）→ 从持久化任务快照重建合成任务（customId `o\d+$`→`c`）→ submitBatchFor 合成轮 → 下一轮收割写盘；观察全失败该篇缺席并 note；部分失败合成基于剩余观察。
  - **`submitBatchFor`** (0.8.4 补带): 持久化 job.tasks 补带 `splitFor/composePlan`（宿主重启后收割重建合成所需的元数据，原快照会丢）。
  - **`excludedItem(cwd, list)`**: 返回命中的排除清单条目原文（0.8.1 新增）；`isExcluded` 改为 `excludedItem(...) !== null` 的布尔包装。
  - **`installUpdateReminder`**: `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库无 `.codewiki/` 返回空）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过。
  - **`runCw` / `parseStatus`**: cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）。
  - **`createJobService`**: 宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调，下限 250ms）推进阶段机 plan→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`（compose 仅当横切输入超 28k 预算：每篇模块文章一个观察任务并发跑，settle 后以观察 pack 提交合成批；总量装得下则单批直出）；校对按「预算−文章 token」动态装填源码，装不下升大档（200k）重装；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（只剥 apiKey；多实例安全：job 带 owner=创建实例、tick 只推进自家 job，flush 脏标记+mergeFromDisk 磁盘吸收防互相覆盖，tick 进程级 `JOBS_FILE.lock` 串行，cancel 标记每轮 tick 从磁盘跨实例拾取）；submit 占位先行（stage=submitting 挡住凭证窗口内的并发重复提交）；批次未终态保留断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`（0.4.3+ 记 stage/crosscutSplit，resume 按原阶段恢复），下次提交自动续查（resume job）；取消幂等（cancelRequested 跨 tick 存活，取消保留断点可续查）；`writeValidated` 校验 frontmatter 后直接写盘（keepInMemory 任务的唯一写盘点）。
  - **`cwToolDefinition`**: cw CLI 封装工具（子命令白名单）。
  - **`generateToolDefinition`**: 纯提交制：normalizeCwd → 凭证解析（无凭证诚实报错，不回退子代理）→ cw status 判态 → 孤儿断点并入（resume）→ 任务预构建（clean 短路 / stale 逐篇直达 articles / 全量走 plan）→ `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用。
  - **`progressToolDefinition`** (0.5.0.6 新增): 只读查编译进度：可选 cwd/jobId 过滤，返回 jobSummary 同源数据 + taskList 完成百分比，render 输出 stage=xx NN% 与任务明细；与 `codewiki_generate`（提交制）配套，让模型不必空等编译完成。
  - **`updateToolDefinition`** (0.7.0 新增): 日常维护入口：固定 scope=auto 的提交制更新请求，调用即返回并明确告知「继续下一项、不要等待」；错误消息里的 `codewiki_generate` 字样改写为 `codewiki_update`；参数仅 cwd/language（scope=full/stale 仍走 `codewiki_generate`）；apply() 注册为第四个工具。
  - **WebServer 端点**: `GET /api/codewiki/jobs`（任务列表，不含 apiKey）与 `POST /api/codewiki/control {action:'cancel',jobId}`，仅回环放行（403）。

### `cordis.patch.yml` (根目录)
- **描述**: Bundle 安装方式的 Cordis 补丁文件。定义插件 ID `codewiki`，指向本地 `index.js`，初始配置为空 `{}`。
- **关键结构**:
  - `insert` -> `id: codewiki`, `name: file:///.../index.js` (行 13-14)。
  - 注释中列出了配置项说明：`binaryPath`, `defaultProvider`, `defaultModel`, `defaultReasoningEffort`, `maxConcurrency`, `articleLanguage`, `updateReminder` (行 5-11)。

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
  - `node_modules/` (行 1)：标准依赖目录忽略。
  - `vendor/codewiki/target/` (行 2)：Rust 构建产物忽略。
  - `*.log` (行 3)：所有日志文件忽略。
  - `bin/*.bak-*` (行 6)：cw 二进制备份，安全网机制，防止上游更新或清理后无法恢复已知工作版本，见 CHANGELOG 0.5.0.2。
  - `.orch-test-out.txt` (行 8)。
  - `.probe3.txt` (行 9)。

### `CHANGELOG.md` (根目录)
- **描述**: 详细的版本变更历史，记录了架构重构、性能优化和 bug 修复。
- **关键版本**:
  - **0.8.8**: 新增 `fixAnchors(content, cwd)` 函数（index.js），用于文章落盘前机械校正 `file:NN(-MM)` 行号锚点。逻辑：对照 `source_files` 源码，锚点起点行应包含同行反引号符号；若歧义则退试首段或声明形态；区间尾越界钳到文件尾。集成点：`applyTaskResult` (index.js) 与 `writeValidated` (index.js) 统一调用修正。数据流：`parseSourceFiles(fm)` 共用解析逻辑；`full/stale` 任务补 `cwd` 字段。
  - **0.8.7**: 新增 `numberLines()` (index.js:346)，为 collectSources 内联源码添加 `N| ` 前缀，防止弱模型幻觉数行。Prompt 修正：校对 prompt 明确“以源码『行号| 』前缀为准”。Stale 禁用：旧文行号一律不得沿用。
  - **0.8.6**: 修复规划阶段主模型路由失效问题。新增模块级 `llmRef`，通过 `ctx.inject(['llm'], ...)` 注入；`runMainModelPlan` 改为读取 `llmRef` 而非直接访问 `hostCtxRef.llm`（后者在未注入时抛错）。路由：优先 `session.requestHeader()?.config`，其次 `agent.options`。
  - **0.8.5**: 适配 DSH 0.2.1-rc.2：`source` 形态从 `{kind:'plugin',plugin:'codewiki'}` 改为 `{kind:'plugin:codewiki'}`。Engines：package.json 增加 `"engines": {"dsh": ">=0.2.0-rc.0"}`。
  - **0.8.4**: 超预算分割：当模块源码超 28k token 时，拆分多个观察批。新 Prompt：`batchArticleObservePrompt` 和 `batchArticleComposePrompt`。状态机：`tickArticles` 处理 `#obs` 批次，分组后提交合成任务 (`composePlan`)。持久化：`submitBatchFor` 补存 `splitFor/composePlan` 元数据。
  - **0.8.3**: 主模型规划：新增 `runMainModelPlan(job, prompt)` (index.js)，使用发起会话的主模型执行规划，避免百炼批量排队。降级策略：主模型不可用时降级回百炼批量规划。
  - **0.8.2**: Schema 修复：`progress` 工具输出 schema 中 `type: ['object','null']` 改为 `{ oneOf: [{type:'object'},{type:'null'}] }`，兼容新宿主 JSON Schema 子集限制。防御性编程：工具注册循环增加 per-definition try/catch。
  - **0.8.1**: 排除项报错：`excludedItem(cwd, list)` 返回命中排除项原文，报错信息中包含具体排除条目。
  - **0.8.0**: 实时唤醒：新增 `wakeCompileSession(job, outcome, agents?)` (index.js)，编译终态通过 `agent.steer()` 向发起会话发送消息。依赖：引入 `@deepseek-ai/dsh-llm` 等宿主包（junction 模式）。Bug 修复：`submitComposeBatch` 同步调用修复 `undefined.then` 错误。
  - **0.7.0**: 新工具：`codewiki_update` (updateToolDefinition, index.js)，固定 scope=auto 的提交制更新。提醒机制：`commitHintText`，基于 git log 时间戳判断是否需要提醒提交改动。
  - **0.6.0**: 删除批量通道：移除百炼专用批量端点，全部走普通入口 `chat/completions`。保留骨架：后台执行器逻辑保留，仅端点变更。UI 清理：client.js 删除批量设置页节。
  - **0.5.0.6**: 进度工具：新增 `codewiki_progress` (progressToolDefinition, index.js:1815-1911)，只读查询编译进度。
  - **0.5.0.5**: 批量通道切换：从 Batch File 切换为 Batch Chat (batch.dashscope.aliyuncs.com)。配置：`batchMinTokens` 调整为 30000 以启用批量折扣。
  - **0.5.0.4**: 收尾封死：reminderText 禁止手工流程，强制调用 `codewiki_generate`。
  - **0.5.0.3**: 锚点校验：新增 `test-wiki-anchors.mjs`，三重断言校验行号锚点。
  - **0.5.0.2**: Rust 层修复：vendor/codewiki 重构，修复 Windows 反斜杠路径问题。
  - **0.5.0.1**: 自动补建入口：流水线自动检查并生成 `CodeWiki.md`。路径规范化：`normalizeArticlePath` / `normalizeIndexLinks` 处理 Windows 路径。
  - **0.5.0**: 面板改版：六阶段步骤条、双通道吞吐徽标、用量统计、加权总进度条。
  - **0.4.11.2**: 阈值放宽：`batchMinTokens` 上限提升至 99,999,999。
  - **0.4.11.1**: 孤儿任务接管：`owner !== instanceId` 且停更 >5min 的任务由本实例接管。
  - **0.4.11**: 进度透出：`jobSummary` 新增 `taskList` 和 `batchProgress`。
  - **0.4.10**: 端点加固：workspaceRegistry 异常降级、诊断 try/catch、环境变量隔离 repos 文件。
  - **0.4.9**: 工作区过滤：任务页/总览页仅显示属于已添加 dsh 工作区的任务。
  - **0.4.8**: 仓库发现：knownRepos 清单、一键排除按钮、refresh 动作。
  - **0.4.7**: 排除清单与自动更新：excludePaths、autoUpdate 开关、三标签页面板。
  - **0.4.6**: 面板收敛：焦点卡片、历史折叠、Temp 残留清理。
  - **0.4.5**: 混合通道：`batchMinTokens` 阈值决定实时/批量。
  - **0.4.4**: 面板完善：滚动、分组、实时 tps、设置移入面板。
  - **0.4.3**: 审查修复：取消标记跨实例丢失（service 注入）、生命周期、多实例写盘安全（lock/mergeFromDisk）、断点保真。
  - **0.4.2**: 超大任务升档：单文件超 28k 升 200k 大档继续批量。
  - **0.4.1**: 横切 Map-Reduce：超预算横切拆分为观察+合成。
  - **0.4.0**: 服务化全批量：JobService 常驻、零子代理、32k 分块并行。
  - **0.3.2**: 异步化：`batchAsync` 模式，提交即返回，后台链收尾。
  - **0.3.1**: 凭证自动获取：`resolveBatchApiKey` 从凭据库解析。
  - **0.3.0**: 批量推理接入：写文章环节走百炼 Batch File，并发上限放宽至 8。
  - **0.2.8**: 活动行 Label：加 `[<model>]` 前缀。
  - **0.2.7**: 插件未装载修复：`agents` 服务正确 inject。
  - **0.2.6**: 思考程度设置：`defaultReasoningEffort` 支持。
  - **0.2.5**: 提醒注入：`installUpdateReminder` 系统提示 section。
  - **0.2.4**: 路由丢弃修复：stale/auto 逐篇及全量模块 task 补传 route。
  - **0.2.3**: 路径缺陷修复：MSYS 路径归一化、binaryPath 探测顺序。
  - **0.2.2**: 审查修复：scope=full 短路、cw status 非零退出、signal 响应等。
  - **0.2.1**: 子代理接线断裂：subagents 注入修复。
  - **0.2.0**: 插件页设置 UI：client.js 实现设置卡片。
  - **0.1.1**: 移除技能：纯工具面，默认模型指向阿里百炼。
  - **0.1.0**: 首次发布：cw 封装、codewiki_generate 编排、skill 注册。

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