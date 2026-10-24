---
title: wiki-generation-flow
type: concept
source_files: [index.js, client.js]
tags: [wiki-generation, job-service, bailian-endpoint, pipeline, observability]
---

# Wiki 生成流程（wiki-generation-flow）

## Overview

`wiki-generation-flow` 是 dsh-codewiki 的核心概念：把一次「仓库 → 活 wiki」的编译拆成一条**可持久化、可中断、可续跑、可观测**的服务化流水线。它不是一次同步函数调用，而是跨多次事件循环、跨宿主重启、必要时跨会话推进的状态机。

三条设计主轴决定了整条流程的形状：

1. **阶段机与作业持久化**：作业（job）落盘在 `os.tmpdir()/dsh-codewiki-jobs.json`（`JOBS_FILE`，index.js:1012），由 `setInterval` 心跳（`TICK_MS` 默认 10000，index.js:1013）以 10s 节拍推进（`createJobService` 里 `start()` 调用 `tick`，`tick` 函数本体在 index.js:2032-2109）。进程中断后下一进程凭磁盘状态续跑；同一仓库同时只允许一个非终态作业（`submit` 中 `findActive` 检查，index.js:1012、index.js:2190）；跨进程用 `acquireTickLock`（index.js:1130-1144）与 `owner` 归属判定互斥（index.js:1012、index.js:2049-2058）。
2. **token 预算优先的分批**：所有模型调用都是单轮文本生成，目的是把输入压进 ≤110k 普通档（`BATCH_TOKEN_BUDGET = 110000`，index.js:371），超出的先改用大档（`bigProvider/bigModel`，默认 volces-ark/glm-5.3-flash，预算 `bigTokenBudget` 默认 420000，index.js:30-33、index.js:561-568）。装不下就拆观察批再合成（index.js:557-642），而不是硬塞；连大档都装不下时转「会话通道」交发起会话模型派子智能体（index.js:1517-1551）。
3. **确定性兜底**：行号锚点校正、frontmatter 校验、旧文保留、索引重建、入口文件生成都由代码而非模型保证（index.js:398-481、index.js:1362-1378、index.js:1990-2006、index.js:211-244）。

触发入口有五个：`codewiki_generate`（三态 scope，index.js:3037，execute 在 index.js:3037-3082）、`codewiki_update`（固定 auto 的快捷入口，index.js:3037）、`codewiki_progress`（只读查询，index.js:3037）、面板「更新」按钮（走 `POST /api/codewiki/control` 的 compile 动作，index.js:3037-3065），以及自动更新调度器（`autoScan`，index.js:3037-3059）。

当前版本（0.10.x）的结构性变化：**规划阶段已删除**（0.10.7 起），全量编译提交后直接进 `articles`，模块清单由 `localPlan` 本地生成（index.js:682-695、index.js:1595-1597）；超预算不再降级旧版百炼大档、也不再同模型同步兜底，改为「写入任务文件 → steer 发起会话 → 轮询目标文件收割」（index.js:682-700、index.js:682-716），且唯一模型通道是宿主 llm 服务（index.js:682-701），插件不保存任何密钥。

## Key Components

### 1. Job Service 与阶段机

`createJobService(config, onSettled)`（index.js:1218 起）是全部编排状态的唯一持有者，返回 `{ submit, cancel, list, findActive, start, stop }`（index.js:1218）。

**五阶段推进**见 `STAGE_HANDLER`（index.js:2024-2030）：`articles → crosscut → compose → review → index`，另有 `submitting` 占位与 `done / failed / cancelled` 三个终态（`JOB_TERMINAL`，index.js:1080）。`stale` 增量作业跳过 `crosscut` 与 `compose`，从 `articles` 起步直接进 `review`（tickArticles 末尾 `setStage(job, job.kind === 'full' ? 'crosscut' : 'review')`，index.js:1719）；单项目串行开启时后提交的任务先进 `queued` 排队（index.js:2167），tick 里轮到才转 `articles`（index.js:2072-2082）。

**提交 `submit`**（index.js:2111-2176）次序是刻意的：先做排除清单判定（`excludedItem` 命中即抛出带命中项的错，index.js:2113-2116）→ `rememberRepo` 登记已知仓库（index.js:1071、index.js:2117）→ 查同 `cwd` 是否已有非终态作业（命中直接返回 `{job, existed:true}`，index.js:2118-2119）→ 才创建 `stage='submitting'` 占位并落盘（index.js:2111-2132），这样即便凭证解析失败也留下可解释记录。凭证校验仅检查 `batchProvider` 非空、`batchModel` 非空与 `llmRef.stream` 存在（记录 `credentialSource`，index.js:2111-2119）。收尾 `persist + flush` 后 **`void tick()` 立即推进一步**，不等首个心跳（index.js:2111-2112）。

**推进 `tick`**（index.js:2032-2109）有三层互斥：模块内 `ticking` 重入守卫（index.js:2033）、跨进程文件锁 `acquireTickLock`（残留锁 60s 过期强删，index.js:1130-1144）、以及 `job.owner` 归属判定：另一实例的 job 若停更未超 `ORPHAN_TAKEOVER_MS`（默认 5 分钟，index.js:1061）就让路，超时则本实例接管、改 `owner`、并在途会话任务 `resendSessionSteer` 重发（index.js:2049-2058）。取消不是杀进程而是标记：tick 见到 `cancelRequested` 才 `setStage('cancelled')`、`batchAborters.abort()`、`batchResults.delete`（index.js:2060-2069）；`syncCancelFlags` 每轮从磁盘拾取另一实例写入的取消标记（index.js:1312-1323）。

**结果结算**三件套：`settleJob`（index.js:1336-1357）收割执行器结果，执行器丢失（宿主重启）时按 `job.tasks` 持久化的 `batchPrompt` 快照重跑本阶段——这是唯一恢复路径；`writeValidated`（index.js:1362-1378）落盘前校验 frontmatter（不以 `---` 开头即拒绝并 note），再跑 `fixAnchors`；`tally`（index.js:1381-1402）累计 `writtenCount / failedCount`，`replace=true` 用于校对结果覆盖同名条目且「校对失败不推翻已写成功的原文」。普通文章走 `applyTaskResult`（index.js:308-321），它按 `keepInMemory` 分叉：内存结果只回内容，文章结果直接落盘。

其他编排辅助：`setStage` 累计各阶段耗时进 `stageTimings`（index.js:1287-1297）；`addUsage` 累计 `inputTok/outputTok/requests/batchRequests/realtimeRequests/overTier2`（index.js:1299-1308）；`touch` 标脏并登记 `dirtyIds`（index.js:1282-1284）；`flush` 先 `mergeFromDisk` 再 `saveJobs`（index.js:1272-1275、index.js:1250-1271），`saveJobs` 只留最近 `MAX_JOBS_KEPT = 30` 个（index.js:1287、index.js:1147-1152）。

### 2. Token 预算与源码装填

`estimateTokens`（index.js:269-277）：CJK 记 1 token/字，其余按 3.5 字符/token。它只回答一个问题——这批源码装不装得进 110k 普通档。

`collectSources`（index.js:486-513）按预算**整文件**内联（不做半文件截断，因为半截代码会误导行号），返回 `{text, skipped, oversized}`；连首个文件都超预算即 `oversized=true`，用来区分「文件太多」与「单文件太大」两种不同的降级路径。

`numberLines`（index.js:387-389）给每行加 `N| ` 前缀再喂模型，让模型直接抄前缀行号而不是自己数行。落盘前还有 `fixAnchors`（index.js:398-481）：以 `source_files` 原文为准，按「行内反引号符号应出现在该行」的语义校正 `file:NN(-MM)` 锚点，**只改数字不动文字**，多处命中时只认 `function/class/const/let` 的声明形态，仍歧义则记为 `unresolved` 不动。

`prepareArticleTasks`（index.js:557-642）是最关键的决策点，三档降级：

- 装得下 → 单批出文章；
- 装不下但能按文件切多批 → 每批一个观察任务（`keepInMemory`，带 `splitFor` 与 `composePlan`，index.js:621-636），后续由 compose 阶段合成整篇；
- 单文件超单请求预算、或切不出多批 → 先试大档（`bigTier`，默认 volces-ark/glm-5.3-flash，预算 420k，index.js:569-577、index.js:582-591），大档装不下才转 `sessionTasks` 会话通道（index.js:600）。

值得注意的是「横切先例」被复用到文章层：模块源码超预算时不是把源码硬塞给一个请求，而是「观察 → 合成」两段（index.js:546-551 注释）。

### 3. 会话通道（超预算任务的兜底出口）

超预算任务不再降级旧版百炼大档，而是：

1. `dispatchSessionTasks`（index.js:1517-1551）把 `t.batchPrompt` 写入 `SESSION_TASK_DIR`（`path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')`，index.js:1018）下的 `<jobId>--<safeName>.prompt.txt`，再 `agent.steer` 一条指令消息；发起会话不可用（面板/自动调度提交、会话已关）直接 `fail` 并给出「请从会话内重新提交编译」（index.js:1517-1520）。
2. `buildSessionSteerText`（index.js:1041-1059）产出 steer 文本，按 `job.stage === 'review'` 区分「校对」与「文章」两种要求；`sessionTier` 非空时在文本里要求 `delegate` **显式传 `tier`**（index.js:1043-1044），因为编译主链不走子智能体档位路由，自动选路实测常被判给 `default`（index.js:1036-1040 注释）。
3. `classifySessionTask`（index.js:1024-1034）判三态：超时 `SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，index.js:1017）→ `timeout`；文件 `mtime` ≥ 派发时间且以 `---` 开头 → `harvest`；其余 `wait`。
4. `progressSessionTasks`（index.js:1555-1574）收割：`harvest` 走 `writeValidated` 闸门落盘，`timeout` 记失败（不降级插件内通道），全部终态才推进阶段；review 阶段用 `replace` 语义覆盖同名条目。
5. `resendSessionSteer`（index.js:1578-1591）在宿主重启接管后重发一次且**不重置 `dispatchedAt`**，超时计时保持原起点，子智能体重写同一文件因而幂等。

### 4. Prompt 模板族

模板全是纯函数构造器，集中在 index.js：

| 构造器 | 位置 | 产出 |
| --- | --- | --- |
| `localPlan` | index.js:682-695 | 本地规划（按顶层目录分组，无模型请求）`{project, modules[{name,summary,files}], concepts}` |
| `batchArticlePrompt` | index.js:517-544 | 单篇模块文章（源码内联 + mission + 可选旧文 + 格式段） |
| `batchObservePrompt` | index.js:760-777 | 横切 map 阶段的模块观察，**刻意不带 frontmatter** |
| `batchArticleObservePrompt` | index.js:781-797 | 文章分割观察，要求保留全部函数/类/常量/行号 |
| `batchArticleComposePrompt` | index.js:801-829 | 多批观察 → 整篇模块文章 |
| `batchArchitecturePrompt` | index.js:734-740 | 三张 box-drawing 图，`type: architecture` |
| `batchPatternsPrompt` | index.js:742-748 | `type: pattern` |
| `batchConceptPrompt` | index.js:750-756 | `type: concept`，章节 Overview / Involved Modules / Flow / Implementation Map |
| `batchProofreadPrompt` | index.js:833-852 | `articleText + 源码 → 修正后整文`，四项核对 |
| `batchProofreadBatchPrompt` | index.js:856-883 | 多篇文章合并请求，按 `@@@article/@@@end` 标记分节 |

`articleFormatSection`（index.js:648-677）是模块文章的格式契约：frontmatter + 六章节（Overview / Key Components / Architecture / Data Flow / Connections / Known Issues），并明确「只输出文章本身」。`crosscutIntro`（index.js:720-732）是三篇横切共用的开场白。

`parseSourceFiles`（index.js:966-978）从 frontmatter 解析 `source_files` 清单（供 stale 流程与 localReview 使用），`localPlan` 在 full 编译时直接生成模块清单，流水线不因一次规划失败而空转（规划阶段已删，index.js:1595-1597）。

### 5. 横切、合成、校对与收尾

`crosscutTasks`（index.js:1723-1742）固定产出：`_architecture.md`（customId `arch`）、`_patterns.md`（`patterns`）、计划里每个概念一篇 `concepts/<slug>.md`（`concept${i}`），全部 `keepInMemory`。

`tickCrosscut`（index.js:1744-1826）用 `estimateTokens` 累加**原始总量**判定是否拆分（index.js:1794）——不能用 `packArticles` 的体积，因为它超预算只截头部、永远装得下（index.js:1782-1783 注释写明了这个坑）。超预算时每篇文章发一个 `_obs/<name>` 观察任务并置 `crosscutSplit=true`，收割后拼包进 `compose`（index.js:1744-1747）。`tickCompose`（index.js:1829-1841）收合成批并 `tally`；`submitComposeBatch`（index.js:1843-1853）提交失败只降级跳过横切、`setStage('review')`，不推翻整个作业。

`localReview`（index.js:1856-1876）是校对前的本地体检：文件丢失记 `missing` 并回退 `writtenCount`；不以 `---` 开头判「缺 frontmatter」并 `skipProofread`；`source_files` 解析为 0 个也跳过；`source_files` 指向不存在的文件只记 note。`tickReview`（index.js:1878-1988）按 `articleTokens` 扣减后的剩余预算装填源码（index.js:1909-1910），仍 `oversized` 则该篇转会话通道校对（note「源码超批量预算，校对转会话通道」，index.js:1911-1918）。

`tickIndex`（index.js:1990-2022）是唯一有磁盘副作用的收尾：`cw index` 重建索引、`cw meta update` 刷编译基线（各 120s 超时）、`normalizeIndexLinks` 修 `_index.md` 反斜杠链接（index.js:1998）、`ensureWikiEntry` 按语言补 `CodeWiki.md` 入口（已存在不覆盖，index.js:2003）。`writtenCount === 0` 则跳过全部收尾并 note（index.js:1990）。结束时 `setStage('done')` + 记 `finishedAt`，并在 `autoCommit` 开启时调用 `autoCommitWiki`（index.js:2904）自动提交；`writtenCount > 0` 才回调 `onSettled` → `wakeCompileSession`（index.js:1202-1216），且自动提交成功时不唤醒会话（index.js:1205）。

### 6. 工具层与 Web 端点

`generateToolDefinition`（index.js:2210-2360）的 `execute`（index.js:2254-2358）是判态入口：`cw status`（120s，index.js:2210）→ `parseStatus`（四态 `missing/uncompiled/clean/stale`，index.js:178-191）→ `wikiPathFor`（`cw path`，兜底 `<cwd>/.codewiki`，index.js:990-995）→ `findActive` 幂等（命中即把 `active.sessionId` 改成当前会话抢回唤醒权，index.js:2280-2287）→ `scope` 修正（stale 遇无 wiki 自动升 full，index.js:2292-2295）→ stale 预构建 tasks（读旧文 `source_files`，index.js:2210-2226）→ `missing` 先 `cw init`（index.js:2344-2349）→ `svc.submit`。`sessionId` 取自 `exec?.agent?.id`（index.js:2266）。

`installWebServer`（index.js:2646-2875）注册五个 exact 端点，全部要求 loopback（否则 403 `loopback only`，index.js:2646-2649），并按 `workspaceOnly` 过滤工作区（注册表抛错时降级不过滤，index.js:2646-2661、index.js:2646-2647）：

- `GET /api/codewiki/jobs`（index.js:3026-3044）：`service.list()` + 工作区过滤，返回 `{now, jobs}`；
- `GET /api/codewiki/repos`（index.js:1068-1154）：job 历史 `cwd` + `loadKnownRepos`（index.js:1068-1080），逐个现算 `cw status`（20s）+ `wikiPathFor` + `countWikiArticles`（index.js:194-206），**30s 缓存**，附调度器状态；
- `GET /api/codewiki/models`（index.js:2584-2599）：`listModelCatalog`（index.js:2584-2605），单个 provider `listModels` 抛错只记 `entry.error` 不影响整份目录，同样 30s 缓存；
- `GET /api/codewiki/model-efforts`（index.js:2622-2642）：`resolveModelEfforts` 取思考档位（index.js:2622-2644）；
- `POST /api/codewiki/control`（index.js:2178-2209）：`cancel`（不存在返回 404）/`refresh`（清仓库缓存）/`compile`（未初始化返回 501）。

系统提示侧的闭环由两段文案完成：`commitHintText`（index.js:2947-2976）取最近一次 `stage==='done'` 且 `writtenCount>0` 的作业，与 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 比对时间戳，产物晚于提交才注入「CodeWiki 产物待提交」（60s TTL 缓存，index.js:2974）；`installUpdateReminder`（index.js:2989-3021）在 `agent/created` 与已存在 agent 上注入 `codewiki:update-reminder` 段（order 取 `TOOL_REPORT` 后一位），`text()` 每次组装实时求值（开关关闭或仓库根无 `CodeWiki.md` 时返回空串，index.js:2947-2952）。

浏览器半侧（client.js）是纯观测 + 配置面：`apply`（client.js:412）把 `CodewikiCard` 挂 `plugins.item`（配置表单，`configForms.whileServed([NS], mount)` 包裹，client.js:428-432）、`CodewikiPanel` 挂 `main`（`key=codewiki`，client.js:437）、`PanelIcon` 挂 `sidebar.panellist`（order 52，client.js:438-443）。面板每 `POLL_MS = 2000`（client.js:452）拉 jobs，把 `tps` 推进 30 点 spark 窗口、用 `completed` 差分算速率再做 EWMA `0.6*prev + 0.4*inst`（client.js:452-491）；进度用 `STAGE_WEIGHTS`（articles 独占 0.65，client.js:939）加当前阶段 `taskList` 完成比例折算（`overallPct`，client.js:940-948），封顶 99、`done` 才 100。`ReposTab`（client.js:992）覆盖总览与排除开关，`CodewikiPanel`（client.js:1137）负责任务页。

## Architecture

```text
      codewiki_generate / codewiki_update / 面板 compile / autoScan
                              │
                     runCw status ──► parseStatus（四态）
          missing│uncompiled   clean   │   stale
                 │              │      └─► 预构建 tasks（读旧文 source_files）
                 ▼              ▼
            cw init        直接报告 ────► submit()
                 └──────────────┤
                                ▼
 ┌──────────────────── createJobService ────────────────────────┐
 │ JOBS_FILE 落盘 ── tick（锁 + 重入守卫 + owner / 孤儿接管）    │
 │                                                              │
 │ articles ─► crosscut ─► compose ─► review ─► index           │
 │    │          │           │          │         │            │
 │    │          │           │          │         └ cw index + cw meta update
 │    │          │           │          └ 校对批 / 会话通道校对  │
 │    │          │           └ 多批观察合成的唯一入口            │
 │    │          └ 超 110k 才出现（crosscutSplit）              │
 │    └ prepareArticleTasks：单批 / 拆观察批 / 大档 / 会话通道   │
 │                                                              │
 │ runRealtimeTasks（并发池 ≤ maxConcurrency ≤ 8）              │
 │    └─ 唯一通道：llmChat（宿主 llm 服务，provider/model 配置） │
 └──────────────────────────────────────────────────────────────┘
            │                                   │
   /api/codewiki/*（loopback）        systemPrompt 提醒 / steer 唤醒
            │                                   │
   CodewikiPanel（2s 轮询）        【编译完成·产物待提交】
```

## Data Flow

1. **提交（Submission）**：入口先跑 `cw status`（120s 超时，index.js:2190）判四态（index.js:2190-2203），`stale` 遇 `missing/uncompiled` 自动升 `full`（index.js:2292-2295），`clean` 且非强制 full 直接回报「Wiki is up to date」（index.js:2299-2301）；`findActive` 幂等去重（index.js:2280-2287）；`submit` 先落 `submitting` 占位、解析凭证、`setStage` 到 `articles`（排队则先 `queued`，index.js:2167-2171）、写盘后立刻 `tick()` 一步（index.js:2111-2174，其中 `void tick()` 在 index.js:2174）。
2. **文章（Articles）**：`tickArticles`（index.js:1599-1720）把 `localPlan` 生成的模块清单（full，index.js:1599-1617）或预构建 tasks（stale）映射成任务；`prepareArticleTasks` 分流批量任务、大档任务与会话任务（index.js:1693-1702）。内嵌一条回路：结果里出现 `#obs` 观察批时按文章名聚批、`composedArticles` 去重后每篇只建一条合成任务再提交（index.js:1599-1650）。`writtenCount === 0` 直接 `fail('全部文章任务失败（wiki 基线不变，可重新提交）')`（index.js:1718）。
3. **横切（Crosscut）→ 合成（Compose）**：`tickCrosscut` 单批路径 `tally` 后进 `review`；拆分路径不 `tally`（观察不落盘），拼包后 `submitComposeBatch` 进 `compose` 阶段（index.js:1744-1747、index.js:1843-1853）。合成输入是观察而非原文，天然不超单请求预算。
4. **校对（Review）**：`localReview` 逐篇体检（index.js:1856-1876）→ `tickReview` 按剩余预算装填源码 → 批量校对或转会话通道 → 单篇成败都不阻塞，统一推进到 `index`（index.js:1987）。
5. **收尾与通知（Index / Done）**：`tickIndex` 执行 `cw index` + `cw meta update`、修链接、补入口，`setStage('done')` 并记 `finishedAt`，`autoCommitWiki` 自动提交产物（index.js:1990-1996），`writtenCount>0` 时 `onSettled` → `wakeCompileSession`（index.js:1202-1216）向发起会话 steer「产物待提交」（自动提交成功时不唤醒）。
6. **观测（始终并行）**：任何状态变化都经 `touch / setStage / addUsage / note` 记账；`jobSummary`（index.js:1154-1188）把 `taskList / batchProgress / stageTimings / usage / tps` 整理成面板视图（`tps` 由最近 20 个样本 `tok/ms` 现算，index.js:1186）。`batchProgress` 在 `startBatchChatRun` 的 `onTaskDone` 回调里推进（index.js:1453-1458）。

## Connections

- [[cw-cli-wrapper]] —— 所有磁盘侧的确定性动作（`init/status/index/meta update/path`）都经 `runCw`（index.js:127-152）调 `cw` 可执行文件；`resolveBinary`（index.js:105-125）优先 PATH 里的 `cw`、兜底捆绑 `bin/cw(.exe)`；`normalizeCwd`（index.js:37-42）只在 win32 上把 `/e/...` 归一为 `E:/...`。
- [[credential-resolver]] —— 批量通道凭证完全来自宿主 llm 服务的 provider/model 配置（index.js:285-304、index.js:2146-2154），插件不保存密钥；`batchProvider` 为空则提交失败，不再有内置百炼兼容入口（index.js:279-281）。
- [[panel-ui]] —— `client.js` 的 `CodewikiPanel` / `ReposTab` / `CodewikiCard` 消费本节端点与 `jobSummary` 字段，是流程唯一的图形化观测面；面板按钮又经 `/api/codewiki/control` 反向驱动流程。
- [[article-format-contract]] —— `articleFormatSection`（index.js:648-677）与 `writeValidated` / `fixAnchors`（index.js:1362-1378、index.js:398-481）共同构成「模型写作、代码守门」的契约边界：模型只负责文字，结构、行号、落盘资格由代码裁决。
- [[session-channel]] —— 超预算任务的唯一出口，涉及任务文件落盘、steer 文本、三态收割与重启重发（index.js:1517-1591）。

## Known Issues

1. **会话通道强依赖发起会话活着**：`dispatchSessionTasks` 拿不到 agent（面板/自动调度提交、会话已关）就直接 `fail`，无法回落到批量通道（index.js:1517-1520）；会话通道超时也按失败处理、不降级插件内通道回写（index.js:1517-1520），因此一个从面板发起的超大模块编译注定失败。
2. **跨进程推进有最长 5 分钟空窗**：`ORPHAN_TAKEOVER_MS` 内的让路意味着另一实例崩溃后，最长 5 分钟内没有任何进程推进该作业（index.js:1061）；`acquireTickLock` 靠 60s 残留过期兜底（index.js:1130-1144）。
3. **`compose` 阶段失败被刻意吞掉**：`submitComposeBatch` 提交失败只 `setStage('review')` + note（index.js:1843-1847），`tickCompose` 在无 `batchRef` 时也只 note「合成批次未落盘」就进校对（index.js:1843-1845）。结果是横切文章（`_architecture.md` / `_patterns.md` / `concepts/*`）静默缺失而作业仍 `done`。
4. **观察批全失败时该篇静默缺席**：`tickArticles` 里 `slot.failed >= slot.batches.length` 只 note「观察全部失败，该篇缺席本轮编译」并 `continue`（index.js:1599-1602），作业不失败；`tickCrosscut` 同样只 note「该模块缺席横切合成」（index.js:1599）。
5. **`tickIndex` 的 `cw index` / `cw meta update` 失败只记 note**（index.js:1990-1992）：基线未刷新意味着下次 `cw status` 仍报 stale，同一批文件被反复重编——「编译完成但每次都说有变更」的典型成因。
6. **`estimateTokens` 的 3.5 字符/token 对非 CJK 源码偏乐观**：它服务 110k 装填判定（index.js:269-277），并非真实分词；短标识符多、缩进深的源码可能实测超档，只能由 `submitBatchFor` 的 `overTier2` 事后按「超单请求预算」提示（index.js:1484-1486），装填阶段不会自动再拆。
7. **自动更新调度器错误只留一行**：`autoScan` 按 `autoUpdateMin` 节流、单仓库异常只写 `schedState.lastError`（截断 200 字符，index.js:3055），不重试计数、不上报，仓库可长期处于「每次扫描都失败、每次只留一行」的静默状态；`scanTimer` 固定 60s 心跳（index.js:3060）。
8. **`fixAnchors` 与生成时源码可能不同代**：它以落盘时刻的 `source_files` 原文重算锚点（index.js:398-417 定义并在 `loadSource` 里读取缓存），编译期间用户若改了代码，校正只能在「改动后的文件」上自洽，无法察觉文章内容已与生成时不同。