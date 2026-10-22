---
title: wiki-generation-flow
type: concept
source_files: [index.js, client.js]
tags: [wiki-generation, job-service, bailian-endpoint, pipeline, observability]
---

# Wiki 生成流程（wiki-generation-flow）

## Overview

`wiki-generation-flow` 是 dsh-codewiki 的核心概念：把一次「仓库 → 活 wiki」的编译拆成一条**可持久化、可中断、可续跑、可观测**的服务化流水线。它不是一次同步函数调用，而是一个跨多次事件循环、跨进程重启、甚至跨会话（当源码超出批量预算时降级为会话任务）推进的状态机。

三条设计主轴决定了整条流程的形状：

1. **阶段机与作业持久化**：作业（job）落盘在 `os.tmpdir()/dsh-codewiki-jobs.json`（index.js:2134），由 `setInterval` 心跳推进（index.js:2134、index.js:2134-2142）。进程中断后下一个进程凭磁盘状态续跑，同一仓库同时只允许一个非终态作业（index.js:2134-2191）。
2. **token 预算优先的分批**：所有模型调用都走单轮 `chat/completions`，为的是压进 ≤32k 的低价档（`BATCH_TOKEN_BUDGET = 28000`，index.js:364）。源码装不下就拆观察批、再合成，而不是硬塞（index.js:578-636）。
3. **确定性兜底**：行号锚点、frontmatter、旧文保留、索引重建、入口文件生成都由代码而非模型保证（index.js:390-473、index.js:1348-1364、index.js:1981-2004）。

触发入口有四个：`codewiki_generate`（三态 scope）、`codewiki_update`（固定 auto 的快捷入口）、`codewiki_progress`（只读查询）、面板上的「更新」按钮（走 `/api/codewiki/control`），外加自动更新调度器（index.js:2771-2793）。

## Key Components

### 1. Job Service 与阶段机

`createJobService(config, onSettled)`（index.js:1192 起）是全部编排状态的唯一持有者，对外暴露 `{submit, cancel, list, findActive, start, stop}`（index.js:1192）。

**状态机共六个推进阶段**（index.js:2007-2014 的 `STAGE_HANDLER` 映射）：`plan → articles → crosscut → compose → review → index`，另有 `submitting`（提交占位）与 `done / failed / cancelled` 三个终态（`JOB_TERMINAL`，index.js:1058）。`stale` 增量作业跳过 `plan` 与 `crosscut`，直接从 `articles` 起步（index.js:2007-2017 的编排注释、index.js:2007-2009 的 `setStage(kind==='full'?'plan':'articles')`）。

**提交（submit）**（index.js:226-283）的次序是刻意的：先做排除清单判定（`excludedItem` 命中即抛），再查同 `cwd` 是否已有非终态作业（命中直接返回 `{job, existed:true}`，实现幂等），然后才创建 `stage='submitting'` 的占位作业并落盘——这样即便后续凭证解析失败，也已经有一个可解释的作业记录（失败时 `fail` + `flush` + 抛出）。凭证解析分两支：配了 `batchProvider` 就校验 `batchModel` 与 `llmRef.stream`（记录 `source: llm(provider/model)`），否则走 `resolveBatchApiKey` 取阿里云百炼 key（index.js:226-246）。收尾 `persist + flush` 后 **`void tick()` 立即推进一步**，避免等下一个 10s 心跳。

**推进（tick）**（index.js:1198-1242）有两层互斥：模块内 `ticking` 重入守卫 + 跨进程文件锁 `acquireTickLock`（index.js:1196-1211，残留锁 60s 过期）。它按 `job.owner` 判定归属：owner 不是本实例且空闲时长未超 `ORPHAN_TAKEOVER_MS`（默认 5 分钟，index.js:1039）就让路，超时则接管并把 `owner` 改成本实例、同时 `resendSessionSteer` 重发会话指令（index.js:1196-1217）。取消走 `cancelRequested` 标记而非直接杀：tick 见到标记才 `setStage('cancelled')`、`batchAborters.abort()`、丢弃 `batchResults`。

**结果结算**由三个函数分工：`settleJob`（index.js:1320-1341）把一批 `runRealtimeTasks` 的结果收进来；`writeValidated`（index.js:1320-1336）在落盘前校验 frontmatter，不合法不写；`tally`（index.js:1320-1341）累计 `writtenCount / failedCount`。`applyTaskResult`（index.js:305-318）负责「内存 or 落盘」的分叉——规划、横切、校对这三类结果标 `keepInMemory`，只把最终文章写进磁盘。

### 2. Token 预算与源码装填

`estimateTokens`（index.js:247-255）是粗估器：CJK 按 1 token/字，其余按 3.5 字符/token。它的存在只为回答一个问题——这批源码装不装得下 28k。

`collectSources`（index.js:478-505）按预算整文件内联，返回 `{text, skipped, oversized}`；只要**首个文件**就超预算即置 `oversized=true`，用来区分「文件太多」与「单个文件太大」两种不同降级策略。

`numberLines`（index.js:379-381）给源码每行加 `N| ` 前缀后再喂给模型。这是对弱模型的工程妥协：让模型直接抄前缀里的行号，而不是自己数行——文章的 `文件:行号` 引用质量由此从「大概率漂移」变成「基本可用」。即便如此，落盘前还有一道 `fixAnchors`（index.js:390-473）：以 `source_files` 原文为准，把 `文件:NN(-MM)` 锚点里的行号数字确定性校正，**只改数字不改文字**。

`prepareArticleTasks`（index.js:578-636）是本概念最关键的决策点，三档降级：

- 装得下 → 直接单批出文章；
- 装不下但能按文件切成多批 → 每批一个 `_split/` **观察任务**（`keepInMemory`，带 `splitFor` 与 `composePlan`），后续由 `compose` 阶段合成整篇；
- 单文件就超预算、或切不出多批 → 转 `sessionTasks`，改用 200k 装填的**会话通道**（`BATCH_TOKEN_HARD_LIMIT = 200000`，index.js:1021），把任务写到 `SESSION_TASK_DIR`（index.js:1021）等会话领取，`SESSION_TASK_TIMEOUT_MS` 默认 30 分钟（index.js:1021），由 `classifySessionTask`（index.js:1021-1031）判 timeout / harvest / wait 三态。

### 3. Prompt 模板族

模板全是纯函数构造器，集中在一段（index.js:677-869），按阶段分工：

| 构造器 | 位置 | 产出 |
| --- | --- | --- |
| `batchPlannerPrompt` | index.js:675-694 | 纯 JSON 计划 `{project, modules[{name,summary,files}], concepts}` |
| `batchArticlePrompt` | index.js:509-536 | 单篇模块文章（源码内联 + 任务 + 可选旧文 + 格式段） |
| `batchObservePrompt` | index.js:775-792 | 横切 map 阶段的模块观察，**不带 frontmatter** |
| `batchArticleObservePrompt` | index.js:796-812 | 文章分割观察，要求保留全部函数/类/常量/行号 |
| `batchArticleComposePrompt` | index.js:816-844 | 多批观察 → 整篇文章 |
| `batchArchitecturePrompt` | index.js:749-755 | 三张 box-drawing 图，`type: architecture` |
| `batchPatternsPrompt` | index.js:757-763 | `type: pattern` |
| `batchConceptPrompt` | index.js:765-771 | `type: concept`，章节 Overview / Involved Modules / Flow / Implementation Map |
| `batchProofreadPrompt` | index.js:848-867 | `articleText + 源码 → 修正后整文`，四项核对 |

`articleFormatSection`（index.js:642-671）是模块文章的格式契约：frontmatter + 六章节（Overview / Key Components / Architecture / Data Flow / Connections / Known Issues），并明确要求「只输出文章本身」。`parsePlan`（index.js:642-662）容忍模型把 JSON 包在围栏里，同时校验 `modules` 存在；解析失败时 `localPlan`（index.js:642-655）按顶层目录分组兜底——流水线不因一次规划失败而空转。

### 4. 横切、校对与收尾

`crosscutTasks`（index.js:1778-1797）固定产出三组内存任务：`_architecture.md`（customId `arch`）、`_patterns.md`（`patterns`）、以及计划里每个概念一篇 `concepts/<slug>.md`（`concept${i}`）。`tickCrosscut`（index.js:1778-1840）判断输入体积用的是 `estimateTokens` 累加而非 `packArticles` 的体积——因为后者超预算只截头部，「永远装得下」，不能作为是否需要拆分的依据（这是注释里明确写下的坑）。超预算时每篇文章发一个 `_obs/<name>` 观察任务并置 `crosscutSplit=true`，进入 `compose` 阶段。

`localReview`（index.js:1892-1912）是校对前的本地体检：文件丢失记账并回退 `writtenCount`；不以 `---` 开头判「缺 frontmatter」并 `skipProofread`；`source_files` 里读到 0 个文件也跳过。`tickReview`（index.js:1892-1954）再把源码按 `articleTokens` 扣减后的剩余预算装填，仍 `oversized` 则升到硬上限，还不行就转会话通道（note 写「源码超批量预算，校对转会话通道」）。

`tickIndex`（index.js:1979-2002）是唯一「有副作用」的收尾：`cw index` 重建索引再 `cw meta update` 刷编译基线（120s 超时），`exitCode` 非 0 只记 note 不推翻作业；`normalizeIndexLinks`（index.js:145-153）修 `_index.md` 里的反斜杠链接；`ensureWikiEntry`（index.js:188-221）按语言生成 `CodeWiki.md` 入口（**已存在不覆盖**）。`writtenCount === 0` 时跳过全部收尾并 note 说明。

### 5. Web 端点、提醒注入与前端面板

`installWebServer`（index.js:2526-2722）注册四个 exact 端点，全部要求 loopback（否则 403 `loopback only`），并按 `workspaceOnly` 过滤工作区（注册表异常时退化为不过滤）：

- `GET /api/codewiki/jobs`（index.js:2803-2819）：`service.list()` + 工作区过滤，返回 `{now, jobs}`；
- `GET /api/codewiki/repos`（index.js:994-1073）：历史 `cwd` + 已知仓库，逐个现算 `cw status`（20s 超时）+ `wikiPathFor` + `countWikiArticles`，**30s 缓存**，附调度器状态；
- `GET /api/codewiki/models`（index.js:2503-2519）：`listModelCatalog`（index.js:2503-2524）产模型目录，单个 provider 抛错只记 `entry.error` 不影响整份目录，同样 30s 缓存；
- `POST /api/codewiki/control`（index.js:2118-2149）：`cancel`（作业不存在返回 404）/ `refresh`（清仓库缓存）/ `compile`（未初始化返回 501）。

系统提示侧的闭环由两段文案完成：`commitHintText`（index.js:2737-2762）拿最近一次 `stage==='done'` 且 `writtenCount>0` 的作业，与 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 的时间戳比对，产物晚于提交就注入「CodeWiki 编译完成·请提交改动」（60s TTL 缓存）；`installUpdateReminder`（index.js:2737-2769）在 `agent/created` 时注入 `codewiki:update-reminder` 段，order 取 `TOOL_REPORT` 之后一位，`text()` 实时求值（开关关闭或仓库根无 `CodeWiki.md` 时输出空串）。

浏览器半侧（client.js）是纯观测 + 配置面。`apply`（client.js:406-442）把 `CodewikiCard` 挂到 `plugins.item` 槽（配置表单，`configForms.whileServed([NS], mount)` 包裹）、把 `CodewikiPanel` 挂到 `main` 槽（`key=codewiki`）、`PanelIcon` 挂到 `sidebar.panellist`（order 52）。面板每 `POLL_MS = 2000` 拉 `/api/codewiki/jobs`（client.js:406-446），把 `tps` 推进 30 点 spark 窗口、并用 `completed` 差分算瞬时速率再做 EWMA（`0.6*prev + 0.4*inst`）供 ETA；进度用 `STAGE_WEIGHTS`（client.js:406，articles 独占 0.6）加当前阶段 `taskList` 完成比例折算（`overallPct`，client.js:777-785），封顶 99、`done` 才 100。配置表单（client.js:406-688）走 `form.mutate` 的 `{op:'set',path:[key],value}` 增量 + revision 冲突检测，前端侧先自校验 `maxConcurrency` 1–8 与 `batchThinkingBudget` 0–32768。

## Architecture

```text
                 codewiki_generate / codewiki_update / 面板 compile / autoScan
                                        │
                                runCw status ──► parseStatus（四态）
                            missing│uncompiled  clean  │  stale
                                   │            │     └─► 预构建 tasks
                                   ▼            ▼
                          cw init        直接报告 § submit()
                                   └────────────┤
                                                ▼
   ┌──────────────────────── createJobService ────────────────────────┐
   │  JOBS_FILE 落盘 ── tick(锁+重入守卫+孤儿接管) ── STAGE_HANDLER    │
   │                                                                  │
   │  plan ─► articles ─► crosscut ─► compose ─► review ─► index ─► done
   │           │            │          │          │         │         │
   │           │            │          │          │         │         └ cw index + cw meta update
   │           │            │          │          │         └ 校对批（预算不足→会话通道）
   │           │            │          │          └ 多批观察合成的唯一入口
   │           │            │          └ 超 28k 才出现（crosscutSplit）
   │           │            └ 三图/模式/概念（keepInMemory）
   │           └ prepareArticleTasks：装得下→单批；装不下→拆批；单文件超大→会话通道
   │                                                                  │
   │  runRealtimeTasks（并发池 ≤ maxConcurrency ≤ 8）                 │
   │      ├─ batchProvider 非空 → llmChat（宿主 llm 流）
   │      └─ 否则 → bailianChat（dashscope compatible-mode）
   └──────────────────────────────────────────────────────────────────┘
                          │                        │
              /api/codewiki/*（loopback）    systemPrompt 提醒
                          │                        │
                CodewikiPanel（2s 轮询）    【编译完成·请提交改动】
```

## Data Flow

1. **提交（Submission）**：入口先跑 `cw status`（120s 超时）判四态并在 `stale` 命中 `missing/uncompiled` 时自动升级为 `full`，`clean` 且非强制 `full` 直接回报「Wiki is up to date」；随后 `wikiPathFor` 定位 wiki 目录、`findActive` 做幂等去重（命中就把 `active.sessionId` 改成本次会话，抢回唤醒权），最后 `svc.submit`。`submit` 里先落一个 `submitting` 占位作业，再解析凭证、`setStage` 到 `plan`（full）或 `articles`（stale），写盘后立刻 `tick()` 一步。
2. **规划（Plan，仅 full）**：`tickPlan`（index.js:1565-1607）先读 `scanRepoFiles`（index.js:1565-1588：跳过目录/扩展名、单文件 256KB、总数 2000）的文件清单；能在单批内塞下就走 `runMainModelPlan`（index.js:1565-1614），否则 `localPlan` 本地分组兜底。`parsePlan` 成功后 `modules` 即后续文章清单。
3. **文章（Articles）**：`tickArticles`（index.js:1665-1774）把 `plan.modules` 映射成 `name=modules/<slug>.md`、`sources=mod.files`、`articlePath`，并**把已有旧文作为 `prevArticlePath` 一并喂入**（index.js:1665-1675）以保证增量改写的连贯性；`prepareArticleTasks` 分流出批量任务与会话任务，`submitBatchFor` / `dispatchSessionTasks` 各自提交。这一阶段还有一条内嵌回路：若结果里出现 `#obs` 观察批（`_split/` 拆分产物），按文章名聚批、用 `composedArticles` 集合去重后，每篇只建一条**合成任务**再提交，形成「观察 → 合成」的两段式。`writtenCount === 0` 直接 `fail('全部文章任务失败（wiki 基线不变，可重新提交）')`。
4. **横切（Crosscut）→ 合成（Compose）**：`settleJob` 收结果后，`tickCrosscut` 先 `tally` 再进 `review`；若 `crosscutSplit` 为真则**不 tally**（观察结果不落盘），拼成 `#### name\n\ntext` 的包交给 `submitComposeBatch`（index.js:1320-1330，0.6.0 起 `submitBatchFor` 同步化，故用 try/catch，失败只进 `review` 并记 note，不推翻作业）。
5. **校对（Review）**：`localReview` 逐篇体检 → `tickReview` 以 `articleTokens` 扣减后的剩余预算装填源码 → 批量校对或转会话通道 → 无论成败都 `setStage('index')`（单篇校对失败只影响该篇，不阻塞收尾）。
6. **收尾与通知（Index / Done）**：`tickIndex` 执行 `cw index` + `cw meta update`、修链接、补入口文件，然后 `setStage('done')`、记 `finishedAt`，`writtenCount>0` 时回调 `onSettled` → `wakeCompileSession`（index.js:1979-1990）向发起会话 steer 一条「编译完成请提交改动」。
7. **观测（始终并行）**：任何阶段推进都 `touch / setStage / addUsage / note`（index.js:1131-1163），`jobSummary`（index.js:1131-1165）把 `taskList / batchProgress / stageTimings / usage / tps` 整理成面板视图；`list()` 只保留最近 `MAX_JOBS_KEPT = 30` 个作业并在落盘时剥离 `apiKey`（index.js:1131-1135）。

## Connections

- [[cw-cli-wrapper]] —— 所有磁盘侧的确定性动作（`init/status/index/meta update`）都经 `runCw`（index.js:104-129）调 `cw` 可执行文件；`resolveBinary`（index.js:82-102）优先 PATH 里的 `cw`，兜底捆绑 `bin/cw(.exe)`；`normalizeCwd`（index.js:26-31）只在 win32 上把 `/e/...` 转成 `E:/...`。
- [[credential-resolver]] —— 批量通道凭证的两条来源（显式 `batchApiKey` 与注入 `credentials` 解析 `ALIYUN_BAILIAN_API_KEY`，3s 超时）决定了 `submit` 能否进入 `plan`；配置模型（index.js:2060-2074）与 `liveConfig`（index.js:57-76）是这条链的上游。
- [[panel-ui]] —— `client.js` 的 `CodewikiPanel` / `ReposTab` / `CodewikiCard` 消费本节描述的端点与 `jobSummary` 字段，是流程唯一的图形化观测面；面板按钮又经 `/api/codewiki/control` 反向驱动流程。
- [[article-format-contract]] —— `articleFormatSection`（index.js:642-671）与 `writeValidated` / `fixAnchors`（index.js:642-658、index.js:390-473）共同构成「模型写作、代码守门」的契约边界：模型只负责文字，结构、行号、落盘资格由代码裁决。

## Known Issues

1. **`numberLines` 前缀行号与 `fixAnchors` 校正不是同一套坐标系**：前者是喂给模型时的行号（源码原文 1-based），后者以 `source_files` 原文重算。两者一致，但只要 `readSourceFiles`（index.js:379-387）在某次运行里读到的是被修改过的文件（编译期间用户改了代码），锚点校正就只能在「改动后的文件」上自洽，无法察觉内容已经和生成时不同。
2. **跨进程推进依赖一把文件锁 + 全局共享的 `JOBS_FILE`**：`acquireTickLock`（index.js:1015-1030）靠 60s 残留过期兜底，`mergeFromDisk`（index.js:1015-1036）在每轮 tick 前合并磁盘态。多实例同时激活时，`ORPHAN_TAKEOVER_MS`（5 分钟）内的让路窗口意味着**最长 5 分钟没有任何进程推进该作业**，期间面板显示的是停滞的进度。
3. **`compose` 阶段的失败被刻意吞掉**：`submitComposeBatch` 提交失败只 `setStage('review')` + note（index.js:1879-1889），`tickCompose` 在无 `batchRef` 时也只 note 一句「合成批次未落盘」就进校对。结果是横切文章（`_architecture.md` / `_patterns.md` / `concepts/*`）**静默缺失**，作业仍然 `done` —— 只有 `writtenCount` 与 `taskList` 好一点的读者才能发现。
4. **`tickIndex` 的 `cw index` / `cw meta update` 失败只记 note**（index.js:1979-2002）：基线未刷新意味着下一次 `cw status` 仍报 `stale`，于是同一批文件被反复重编——这是「编译完成但每次都说有变更」的典型成因。
5. **`estimateTokens` 的 3.5 字符/token 对非 CJK 源码是乐观估计**：它服务于 28k 批次装填（index.js:247-255、index.js:247），并非真实分词；压缩率更差的源码（大量短标识符、深缩进）会实测超出预算，触发 `startBatchChatRun`（index.js:247-290）侧的降级，而非在装填阶段就被拆开。
6. **自动更新调度器按 `autoUpdateMin`（默认 30，最小 5，index.js:2822-2836）节流且单仓库异常只写 `schedState.lastError`**（index.js:2822-2844）：错误不上报、不重试计数，仓库可以长期处于「每次扫描都失败、每次只留一行错误」的静默状态。