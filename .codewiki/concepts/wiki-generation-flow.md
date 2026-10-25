---
title: wiki-generation-flow
type: concept
source_files:
  - index.js
  - client.js
tags: [wiki-generation, job-service, host-llm-service, pipeline, observability, auto-commit]
---

## Overview

`wiki-generation-flow` 是 dsh-codewiki 的核心概念：把一次「仓库 → 活 wiki」的编译拆成一条**可持久化、可中断、可续跑、可观测**的服务化流水线。它不是一次同步函数调用，而是跨多次事件循环、跨宿主重启、必要时跨会话推进的状态机。

三条设计主轴决定了整条流程的形状：

1. **阶段机与作业持久化**：作业（job）落盘在 `os.tmpdir()/dsh-codewiki-jobs.json`（`JOBS_FILE`，index.js:1015，即 `1015| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || ...`）、由 `setInterval` 心跳（`TICK_MS` 默认 10000，index.js:1016，即 `1016| const TICK_MS = Math.max(250, ...)`）以 10s 节拍推进（`createJobService` 内 `start()` 调用 `tick`，`tick` 函数本体在 index.js:2069-2146）。进程中断后下一进程凭磁盘状态续跑；同一仓库同时只允许一个非终态作业（`submit` 中 `findActive` 检查，index.js:2227，即 `2227| const findActive = (cwd) => ...`；工具层幂等去重，index.js:2317-2325）；跨进程用 `acquireTickLock`（index.js:1133-1147）与 `owner` 归属判定互斥（实例身份 `instanceId` 在 index.js:1246，接管逻辑在 index.js:2086-2095）。
2. **token 预算优先的分批**：所有模型调用都是单轮文本生成，目的是把输入压进 ≤110k 普通档（`BATCH_TOKEN_BUDGET = 110000`，index.js:374，即 `374| const BATCH_TOKEN_BUDGET = 110000`）。超出的先改用大档（`bigProvider/bigModel`，默认 volces-ark/glm-5.3-flash，预算 `bigTokenBudget` 默认 420000，index.js:30-33、index.js:564-571）；装不下就拆观察批再合成（index.js:609-643），而不是硬塞；连大档都装不下时转「会话通道」交发起会话模型派子智能体（index.js:603、index.js:1537-1571）。
3. **确定性兜底**：行号锚点校正、frontmatter 校验、旧文保留、索引重建、入口文件生成、产物自动提交都由代码而非模型保证（index.js:401-484、index.js:1382-1398、index.js:2010-2040、index.js:214-247、index.js:2948-3030）。

触发入口有五个：`codewiki_generate`（三态 scope，定义于 index.js:2247 的 `generateToolDefinition`，execute 在 index.js:2247）、`codewiki_update`（固定 auto 的快捷入口，定义于 index.js:2407 的 `updateToolDefinition`，execute 在 index.js:2247）、`codewiki_progress`（只读查询，定义于 index.js:2478 的 `progressToolDefinition`，execute 在 index.js:2247）、面板「更新」按钮（走 `POST /api/codewiki/control` 的 compile 动作，服务端处理在 index.js:2247-2257，客户端在 client.js:1050-1058 调用），以及自动更新调度器（`autoScan`，index.js:3124-3146）。

当前版本（0.10.x）的结构性变化：**规划阶段已删除**（0.10.7 起，见 index.js:1615-1617 注释），全量编译提交后直接进 `articles`，模块清单由 `localPlan` 本地生成（index.js:685-698）；超预算不再降级旧版百炼大档（0.10.1 起删除内置百炼兼容入口，见 index.js:685-687 注释）、也不再同模型同步兜底，改为「写入任务文件 → steer 发起会话 → 轮询目标文件收割」（index.js:685-719 与 `SESSION_TASK_DIR` 定义于 index.js:1021 等），且唯一模型通道是宿主 llm 服务（`llmChat` 经 `llmRef`，index.js:288-307、index.js:1206），插件不保存任何密钥（index.js:685-687）。

## Key Components

### 1. Job Service 与阶段机

`createJobService(config, onSettled)`（index.js:1238，即 `1238| function createJobService(config, onSettled) {`）是全部编排状态的唯一持有者，返回 `{ submit, cancel, list, findActive, start, stop }`（index.js:1238）。

**六阶段推进**见 `STAGE_HANDLER`（index.js:2060-2067，即 `2060| const STAGE_HANDLER = {`）：`articles → crosscut → compose → review → index → commit`，另有 `submitting` 占位（index.js:2060-2080）与 `done / failed / cancelled` 三个终态（`JOB_TERMINAL`，index.js:1083）。`stale` 增量作业从 `articles` 起步直接进 `review`（tickArticles 末尾 `setStage(job, job.kind === 'full' ? 'crosscut' : 'review')`，index.js:1739）；单项目串行开启时后提交的任务先进 `queued` 排队（index.js:2204，即 `setStage(job, 'queued')`），tick 里轮到才转 `articles`（index.js:2109-2119）。

**提交 `submit`**（index.js:2148-2213）次序是刻意的：先做排除清单判定（`excludedItem` 命中即抛出带命中项的错，index.js:2150、index.js:252-264）→ `rememberRepo` 登记已知仓库（index.js:2154、index.js:1074-1082）→ 查同 `cwd` 是否已有非终态作业（命中直接返回现有任务，index.js:2155-2156、index.js:2227）→ 才创建 `stage='submitting'` 占位并落盘（index.js:2148-2169），这样即便凭证解析失败也留下可解释记录。凭证校验仅检查 `batchProvider` 非空、`batchModel` 非空与 `llmRef.stream` 存在（记录 `credentialSource`，index.js:2148-2157）。收尾 `persist + flush` 后 **`void tick()` 立即推进一步**，不等首个心跳（index.js:2148）。

**推进 `tick`**（index.js:2069-2146）有三层互斥：模块内 `ticking` 重入守卫（index.js:2070、index.js:2069）、跨进程文件锁 `acquireTickLock`（残留锁 60s 过期强删，index.js:1133-1147）、以及 `job.owner` 归属判定：另一实例的 job 若停更未超 `ORPHAN_TAKEOVER_MS`（默认 5 分钟，index.js:1064）就让路，超时则本实例接管、改 `owner`、并在途会话任务 `resendSessionSteer` 重发（index.js:2086-2095）。取消不是杀进程而是标记：tick 见到 `cancelRequested` 才 `setStage('cancelled')`、`batchAborters.abort()`、`batchResults.delete`（index.js:2097-2106）；`syncCancelFlags` 每轮从磁盘拾取另一实例写入的取消标记（index.js:1332-1343）。

**结果结算**三件套：`settleJob`（index.js:1356-1377）收割执行器结果，执行器丢失（宿主重启）时按 `job.tasks` 持久化的 `batchPrompt` 快照重跑本阶段——这是唯一恢复路径；`writeValidated`（index.js:1382-1398）落盘前校验 frontmatter（不以 `---` 开头即拒绝并 note），再跑 `fixAnchors`；`tally`（index.js:1401-1422）累计 `writtenCount / failedCount`，`replace=true` 用于校对结果覆盖同名条目且「校对失败不推翻已写成功的原文」。普通文章走 `applyTaskResult`（index.js:311-324），它按 `keepInMemory` 分叉：内存结果只回内容，文章结果直接落盘。

其他编排辅助：`setStage` 累计各阶段耗时进 `stageTimings`（index.js:1307-1317）；`addUsage` 累计 `inputTok/outputTok/requests/batchRequests/realtimeRequests/overTier2`（index.js:1319-1328）；`touch` 标脏并登记 `dirtyIds`（index.js:1302-1304）；`flush` 先 `mergeFromDisk` 再 `saveJobs`（index.js:1292-1295、index.js:1270-1291），`saveJobs` 只留最近 `MAX_JOBS_KEPT = 30` 个（index.js:1150-1155）。阶段处理函数分别为 `tickArticles`（index.js:1619-1740）、`tickCrosscut`（index.js:1764-1846）、`tickCompose`（index.js:1849-1861）、`tickReview`（index.js:1898-2008）、`tickIndex`（index.js:2010-2040）、`tickCommit`（index.js:2042-2058）。

### 2. Token 预算与源码装填

`estimateTokens`（index.js:272-280）：CJK 记 1 token/字，其余按 3.5 字符/token。它只回答一个问题——这批源码装不装得进 110k 普通档。

`collectSources`（index.js:489-516）按预算**整文件**内联（不做半文件截断，因为半截代码会误导行号），返回 `{text, skipped, oversized}`；连首个文件都超预算即 `oversized=true`（index.js:489，即 `503| if (first) return { text: body, skipped: [], oversized: true }`），用来区分「文件太多」与「单文件太大」两种不同的降级路径。

`numberLines`（index.js:390-392）给每行加 `N| ` 前缀再喂模型，让模型直接抄前缀行号而不是自己数行。落盘前还有 `fixAnchors`（index.js:401-484）：以 `source_files` 原文为准，按「行内反引号符号应出现在该行」的语义校正 `file:NN(-MM)` 锚点，**只改数字不动文字**，多处命中时只认 `function/class/const/let` 的声明形态，仍歧义则记为 `unresolved` 不动（index.js:401-484）。

`prepareArticleTasks`（index.js:560-645）是最关键的决策点，三档降级：

- 装得下 → 单批出文章（index.js:606，即 `606| if (!skipped.length && pt <= singleLimit) { emitSingle(text); continue }`）；
- 装不下但能按文件切多批 → 每批一个观察任务（`keepInMemory`，带 `splitFor` 与 `composePlan`，index.js:624-638），后续由 compose 阶段合成整篇；
- 单文件超单请求预算、或切不出多批 → 先试大档（`bigTier`，默认 volces-ark/glm-5.3-flash，预算 420k，index.js:572-580、index.js:585），大档装不下才转 `sessionTasks` 会话通道（index.js:598-602、index.js:603，即 `603| if (tooBig) { emitSession(text); continue }`）。

值得注意的是「横切先例」被复用到文章层：模块源码超预算时不是把源码硬塞给一个请求，而是「观察 → 合成」两段（index.js:551-556 注释）。

### 3. 会话通道（超预算任务的兜底出口）

超预算任务不再降级旧版百炼大档，而是：

1. `dispatchSessionTasks`（index.js:1537-1571）把 `t.batchPrompt` 写入 `SESSION_TASK_DIR`（`path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')`，index.js:1021，即 `1021| const SESSION_TASK_DIR = path.join(...)`）下的 `<jobId>--<safeName>.prompt.txt`，再 `agent.steer` 一条指令消息；发起会话不可用（面板/自动调度提交、会话已关）直接 `fail` 并给出「请从会话内重新提交编译」（index.js:1540-1542）。
2. `buildSessionSteerText`（index.js:1044-1062）产出 steer 文本，按 `job.stage === 'review'` 区分「校对」与「文章」两种要求；`sessionTier` 非空时在文本里要求 `delegate` **显式传 `tier`**（index.js:1046-1048），因为编译主链不走子智能体档位路由，自动选路实测常被判给 `default`（index.js:1039-1043 注释）。
3. `classifySessionTask`（index.js:1027-1037）判三态：超时 `SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，index.js:1020）→ `timeout`；文件 `mtime` ≥ 派发时间且以 `---` 开头 → `harvest`；其余 `wait`。
4. `progressSessionTasks`（index.js:1575-1594）收割：`harvest` 走 `writeValidated` 闸门落盘，`timeout` 记失败（不降级插件内通道），全部终态才推进阶段；review 阶段用 `replace` 语义覆盖同名条目（index.js:1592）。
5. `resendSessionSteer`（index.js:1598-1611）在宿主重启接管后重发一次且**不重置 `dispatchedAt`**，超时计时保持原起点，子智能体重写同一文件因而幂等。

### 4. Prompt 模板族

模板全是纯函数构造器，集中在 index.js：

| 构造器 | 位置 | 产出 |
| --- | --- | --- |
| `localPlan` | index.js:685-698 | 本地规划（按顶层目录分组，无模型请求）`{project, modules[{name,summary,files}], concepts}` |
| `batchArticlePrompt` | index.js:520-547 | 单篇模块文章（源码内联 + mission + 可选旧文 + 格式段） |
| `batchObservePrompt` | index.js:763-780 | 横切 map 阶段的模块观察，**刻意不带 frontmatter** |
| `batchArticleObservePrompt` | index.js:784-800 | 文章分割观察，要求保留全部函数/类/常量/行号 |
| `batchArticleComposePrompt` | index.js:804-832 | 多批观察 → 整篇模块文章 |
| `batchArchitecturePrompt` | index.js:737-743 | 三张 box-drawing 图，`type: architecture` |
| `batchPatternsPrompt` | index.js:745-751 | `type: pattern` |
| `batchConceptPrompt` | index.js:753-759 | `type: concept`，章节 Overview / Involved Modules / Flow / Implementation Map |
| `batchProofreadPrompt` | index.js:836-855 | `articleText + 源码 → 修正后整文`，四项核对 |
| `batchProofreadBatchPrompt` | index.js:859-886 | 多篇文章合并请求，按 `@@@article/
