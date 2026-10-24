---
title: core-application
type: module
source_files:
  - index.js
  - client.js
  - package.json
tags: [CodeWiki, 编译流水线, 阶段机, DeepSeek Harness, 侧边栏面板, React, 宿主llm服务, 大档模型]
---

## Overview

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.10.9"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。

代码分成两半，职责严格分离：

- `index.js`（共 3082 行）是宿主半侧。它封装本地 `cw` CLI（`runCw` 见行127）、定义 `Config` 配置（行48）、实现 `createJobService` 阶段机（行1218），注册四个模型工具（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`），并通过 `installWebServer`（行2646）在回环地址上暴露查询与控制端点。
- `client.js`（共 1354 行）是浏览器半侧。经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`plugins.item`）和侧边栏面板（`main` + `sidebar.panellist`），靠轮询而非推送更新界面。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `articles` 依次推进到 `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `done`，规划阶段已于 0.10.7 删除（旧 `plan` 阶段在 `tick` 里被迁移到 `articles`，见行2086-2094），提交后直接进 `articles`。`tick`（行2032）按 10 秒节拍每次推进一步（`TICK_MS` 见行1013），全部状态落在 `JOBS_FILE`（行1012），因此宿主重启、多实例并存都能靠磁盘快照接管续跑。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行285），默认 `workbuddy/hy3`（192k 上下文，行26-27），单请求输入预算 110k（行371）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行30-31，预算 420k，行33），仍装不下才转会话通道兜底（`dispatchSessionTasks` 见行1517）。

## Key Components

### index.js — 配置与基础层

- `PLUGIN_NAME`：行18，值为 `'dsh-codewiki'`，同时以 `export const name` 导出（行19）。
- `CW_SUBCOMMANDS`：行20，['init','status','index','meta','path','projects','setup','uninstall']，`cw` 工具据此做子命令白名单校验。
- `CONCURRENCY_HARD_CAP`：行22，值 `8`，编译请求并发硬顶。
- `DEFAULT_CONCURRENCY` 等：行24-33，默认并发2、默认批量/大档模型与预算常量。
- `Config`：行48-68，`@deepseek-ai/schemastery` schema，共 18 个字段且全部 `.volatile()`：`enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`articleLanguage`、`updateReminder`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`。
- `liveConfig(config)`：行74-99，把配置折算成运行时值：`maxConcurrency` 钳到 `[1, CONCURRENCY_HARD_CAP]`、`autoUpdateMin` 下限5、`workspaceOnly !== false` 归一布尔、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`。
- `normalizeCwd(input)`：行37-42，仅 win32 把 MSYS 盘符路径 `/e/...` 归一为 `E:/...`；非 win32 原样返回。
- `resolveBinary(cfg)`：行105-125，解析顺序为「配置 `binaryPath` → PATH 里的 `cw`（win32 用 `where`，其余用 `which`）→ 插件自带 `bin/cw(.exe)` → 裸 `'cw'`」。PATH 优先避免捆绑副本落后于源码。
- `runCw(binary, cwd, args, timeoutMs = 120000, signal)`：行127-152，`spawn` 子进程收集 stdout/stderr，超时 `SIGKILL`，`signal.abort` 同样 `SIGKILL`；返回 `{ exitCode, stdout, stderr, timedOut }`，**永不 reject**。
- `normalizeArticlePath(p)`：行164，把 `\` 换成 `/`。
- `normalizeIndexLinks(cwd)`：行168-176，`cw index` 直写的 `.codewiki/_index.md` 里，把 `[[link|title]]` 链接头中的 `\` 规范化为 `/`。
- `parseStatus(stdout)`：行178-191，把 `cw status` 文本解析成 `{ state, changedFiles, staleArticles }`。四关键字判定：`'No wiki found'`→`missing`、`'has not been compiled yet'`→`uncompiled`、`'Wiki is up to date'`→`clean`，其余按 `^\s+[M!]\s+(.+)$` 逐行归类（`M` 进 changedFiles、`!` 进 staleArticles），状态记 `stale`。
- `countWikiArticles(wikiPath)`：行194-206，递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），失败返回 `null`。
- `ensureWikiEntry(cwd, language = '中文')`：行211-244，仓库根缺 `CodeWiki.md` 时按语言写入口说明；**已存在绝不覆盖**，生成失败只影响入口存在性。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`：行249-261，排除清单按 `[\n;，,]+` 分隔，`cwd` 等于某项或位于其子树内即命中（归一化小写比较）。
- `estimateTokens(text)`：行269-277，CJK 字符按1 token/字，其余按3.5字符/token，只求把单请求输入压进模型上下文。

### index.js — Token 预算、模型通道与执行器

- `BATCH_TOKEN_BUDGET`：行371，`110000`，单请求输入预算（hy3 192k 上下文留余量）。
- `BATCH_TOKEN_HARD_LIMIT`：行376，`128000`，超预算兜底装填上限（旧值150k已越界）。
- `llmChat({ llm, provider, model, reasoningEffort, prompt, signal })`：行285-304，**唯一模型通道**，走宿主 llm 服务（`llm.stream` + `BlockAssembler`），`temperature: 0`，消息来源标记 `plugin:codewiki`；`finish.kind` 为 `error`/`aborted` 或缺 content 时抛错。
- `applyTaskResult(task, content, notes)`：行308-321，任务结果统一出口。`keepInMemory` 任务只回内存；其余任务先跑 `fixAnchors` 修锚点再 `writeFileSync` 落盘。
- `runRealtimeTasks(tasks, { model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider })`：行329-358，**唯一执行器**。按并发上限消费队列，每任务调 `llmChat`；单任务异常只 `notes.push` 并置该任务 `ok: false`；返回 `Map(customId → { ok, stopReason, content? })`。

### index.js — 行号锚点、源码装填与任务装配

- `numberLines(content)`：行387-389，给每行加 `N| ` 前缀，让模型引用行号以前缀为准。
- `fixAnchors(content, cwd)`：行398-481，**文章落盘前第四层兜底**。只处理 frontmatter 之后行；从反引号提取符号，锚点起点行不含符号时在全文找出现行：恰好一处→修正；多处→只认 `function`/`class`/`const`/`let` 声明形态（`defRe` 行459），仍歧义不动并记 `unresolved`；只改行号数字，`source_files` 外引用不碰。
- `collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)`：行486-513，把源文件内联成 markdown（每段 `### <rel>` + 带 `numberLines` 围栏），**只整文件装填、绝不半文件截断**。返回 `{ text, skipped, oversized }`。
- `batchArticlePrompt({ language, mission, sourcesText, prevArticle })`：行517-544，单轮文章 prompt 骨架；有旧文时附上并明确「行号可能已过期、不得沿用」。
- `prepareArticleTasks(tasks, { cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget })`：行557-642，任务装配与**三级降级**：普通档装填→大档（bigTier）装填→会话通道兜底。返回 `{ prepared, sessionTasks }`；大档任务标 `bigTier` 并记录 provider/model。
- `articleFormatSection()`：行648-677，文章格式条款唯一来源：frontmatter 含 `title`/`type`/`source_files`/`tags`，正文六章节 `Overview`/`Key Components`/`Architecture`/`Data Flow`/`Connections`/`Known Issues`；行号必须以前缀为准；`Connections` 用 `[[backlinks]]`。

### index.js — Prompt 模板

- `localPlan(files)`：行682-695，本地规划兜底（0.10.7 起唯一规划路径）：按顶层目录分组生成模块清单，不再发独立规划请求。
- `packArticles(articles, budget = BATCH_TOKEN_BUDGET)`：行699-718，横切输入装配；整篇装不下时只装头部并标「超预算，仅头部」。
- `crosscutIntro` / `batchArchitecturePrompt` / `batchPatternsPrompt` / `batchConceptPrompt`：行720-756，横切公共骨架与三个具体实现（架构/模式/概念）。
- `batchObservePrompt`：行760-777，横切 map 阶段观察（不带 frontmatter）。
- `batchArticleObservePrompt`：行781-797，文章分割 map 阶段观察（观察对象是源码而非文章）。
- `batchArticleComposePrompt`：行801-829，合并各批观察成整篇。
- `batchProofreadPrompt`：行833-852，单篇校对 prompt：四项核对，输出修正后整文。
- `batchProofreadBatchPrompt`：行856-883，0.10.8 起多篇文章合并校对 prompt，按 `@@@article/@@@end` 标记分节，服务侧 `settleProofread`（行1406）拆回逐篇。

### index.js — 工具定义

- `cwToolDefinition(cfg)`：行889-952，`cw` 工具。校验启用、cwd 存在、args 非空、子命令白名单，随后 `runCw`。
- `slugify(name)`：行960-962，小写化非 `[a-z0-9-_]` 折成 `-`，CJK 字符保留。
- `parseSourceFiles(fm)`：行966-978，解析 frontmatter 的 `source_files`（行内/块状两式）。
- `readSourceFiles(articlePath)`：行980-988，读文章文件并调 `parseSourceFiles` 取源文件清单，供 stale/校对流程使用。
- `wikiPathFor(cwd, binary, signal)`：行990-995，跑 `cw path` 取最后一个非空行，失败回落 `<repo>/.codewiki`。
- `generateToolDefinition(cfg, svc)`：行2210-2360，`codewiki_generate` 总入口。`execute`（行2254起）校验启用/svc/cwd/排除清单，`cw status` 判态，分支：同仓库活动任务直接返回、stale 升全量、clean 只报告、stale 有过期文章构造预建任务、missing 先 `cw init` 再提交 full。
- `updateToolDefinition(cfg, generateDef)`：行2370-2422，`codewiki_update` 固定 `scope: 'auto'` 快捷入口。
- `samePath` / `progressView`：行2430-2439，路径比较与进度百分比补算。
- `progressToolDefinition(cfg, svc)`：行2441-2542，`codewiki_progress` 只读工具，按 jobId 或 cwd 过滤。

### index.js — createJobService（阶段机核心）

`createJobService(config, onSettled)`：行1218-2203，返回 `{ submit, cancel, list, findActive, start, stop }`（行2202）。

- `instanceId`：行1226，tick 只推进本实例创建的 job，防双提交。
- `dirty`/`dirtyIds`/`flush()`/`mergeFromDisk()`：行1229-1275，只有状态变更才整写 `JOBS_FILE`；本实例动过的 job 不允许被磁盘快照反向覆盖。
- `note`/`touch`/`setStage`/`addUsage`：行1276-1308，状态变更统一入口，记阶段耗时与 token 用量。
- `syncCancelFlags()`：行1312-1323，每轮 tick 从磁盘拾取别实例取消标记。
- `fail(job, msg)`：行1325-1333，置 failed、写 error/finishedAt。
- `settleJob(job)`：行1336-1357，收割阶段结果；执行器丢失（宿主重启）则按 `job.tasks` 的 `batchPrompt` 快照重跑本阶段。
- `writeValidated(job, task, content)`：行1362-1378，**闸门：去前导空白后必须以 `---` 开头**，缺 frontmatter 不落盘。
- `tally(job, results, tasks, { replace })`：行1381-1402，结果记账；`replace:true`（校对）覆盖同名条目且失败不推翻原文。
- `settleProofread(job, results, tasks)`：行1406-1430，按 `@@@article/@@@end` 标记拆回逐篇，校验通过才覆写。
- `batchRuns`/`batchResults`/`batchAborters`：行1436-1438，解耦 tick 与长请求。
- `startBatchChatRun(job, prepared)`：行1439-1479，启动后台并发池，调 `llmRef.stream`。
- `submitBatchFor(job, prepared)`：行1481-1509，提交前预记账输入 token，快照化 `prepared` 进 `job.tasks`（batchPrompt 为重跑依据）。
- `dispatchSessionTasks(job, tasks)`：行1517-1551，会话通道派发：写任务文件 + `agent.steer`；发起会话不可用直接 fail。
- `progressSessionTasks(job)`：行1555-1574，收割会话任务（timeout/harvest/wait）。
- `resendSessionSteer(job)`：行1578-1591，宿主重启接管后重发 steer，不重置 dispatchedAt。
- `tickArticles`：行1599-1720（含 `#obs` 观察批归并与合成，本地规划在行1672-1677 就地生成）；`crosscutTasks`：行1723-1742；`tickCrosscut`：行1744-1826；`tickCompose`：行1829-1841；`submitComposeBatch`：行1843-1853；`localReview`：行1856-1876；`tickReview`：行1878-1988（含批量校对合并）；`tickIndex`：行1990-2022（含 `autoCommitWiki` 自动提交）；`STAGE_HANDLER`：行2024-2030；`tick()`：行2032-2109（孤儿接管、取消、串行推进）。
- `submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId })`：行2111-2176，先落 `submitting` 占位，校验 llm 通道，置 stage，立即 `tick()`。job 对象字段在行2121-2140 构造：`id`、`cwd`、`wikiPath`、`scope`、`language`、`kind`、`owner`、`stage`、`auto`、`sessionId`、`plan`、`batchRef`、`tasks`、`articles`、`writtenCount`、`failedCount`、`usage`、`stageTimings`、`stageStartedAt`、`notes`、`createdAt`、`updatedAt`；运行期追加 `batchProgress`、`batchSubmittedAt`、`tpsSamples`、`sessionTasks`、`cancelRequested`、`crosscutSplit`、`error`、`finishedAt` 等。
- `cancel(jobId)`：行2178-2187；`list`/`findActive`/`start`/`stop`：行2189-2200。

### index.js — 持久化与常量

- `JOBS_FILE`：行1012，`DSH_CODEWIKI_JOBS_FILE` 或 `os.tmpdir()/dsh-codewiki-jobs.json`。
- `TICK_MS`：行1013，默认10000、下限250。
- `SESSION_TASK_TIMEOUT_MS`：行1017，默认30分钟；`SESSION_TASK_DIR`：行1018。
- `classifySessionTask(task, nowMs)`：行1024-1034，纯函数三态：timeout/wait/harvest。
- `buildSessionSteerText({ job, snapshots, tier, resend })`：行1041-1059，会话通道 steer 文本，tier 非空时要求显式传 tier。
- `ORPHAN_TAKEOVER_MS`：行1061，默认5分钟；`MAX_JOBS_KEPT`：行1062，30。
- `REPOS_FILE`：行1067；`loadKnownRepos`/`rememberRepo`：行1068-1079。
- `JOB_TERMINAL`：行1080，终态集合（`done`/`failed`/`cancelled`）。
- `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES`：行1083-1095；`scanRepoFiles(cwd)`：行1097-1120。
- `loadJobs`：行1122；`JOBS_LOCK_FILE`/`acquireTickLock`/`releaseTickLock`：行1127-1145；`saveJobs`：行1147-1152。
- `jobSummary(job)`：行1154-1188，面板与工具共用投影，含 tps 计算。
- `agentsRef`/`llmRef`：行1195-1200，经 `ctx.inject` 获取。
- `wakeCompileSession(job, outcome, agents)`：行1202-1216，对 sessionId 对应会话 steer 唤醒；0.10.9 起自动提交成功不打扰会话。
- `listModelCatalog(llm)`：行2584-2605，枚举 provider/model；`resolveModelInfoOf`：行2611-2616，兼容 `resolveModelInfo`/`resolveModel`；`resolveModelEfforts`：行2622-2644，读思考档位。
- `installWebServer(ctx, service, extra)`：行2646-2875，端点：`GET /api/codewiki/jobs`、`/repos`、`/models`、`/model-efforts`，`POST /api/codewiki/control`（cancel/refresh/compile），均回环限制（`isLoopbackRequest` 行2548、`writeJson` 行2553、`readBodyJson` 行2559）。
- `autoCommitWiki(cwd, ...)`：行2904-2945，编译产物自动提交（只 add `.codewiki` 与 `CodeWiki.md`），失败降级提醒。
- `commitHintText(cwd, jobs)`：行2947-2976，60s TTL，git 日志比对提醒提交。
- `reminderText(cwd)`：行2978-2987，系统提示维护纪律。
- `installUpdateReminder(ctx, config)`：行2989-3021，注入 `systemPrompt.section`。
- `apply(ctx, config)`：行3023-3082，插件入口：注入 agents/llm、建服务、起自动更新调度器、注册工具、装 Web 与提醒。

### client.js — 浏览器半侧

- 文件头注释（行1-8）记录硬约束：`id` 等于 `package.json` 的 `name`、词典值必须字符串。
- `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) {...} })`：行10-12；`require` 取 `Switch`/`Button`/`Input`/`Tag`（行13-15）。
- 常量：`NS = 'codewiki'`（行17）、`KEY = 'codewiki'`（行18）、`JOBS_PATH`（行19）、`CONTROL_PATH`（行20）、`PANEL_ORDER = 52`（行21）、`POLL_MS = 2000`（行22）、`REPOS_PATH`（行23）、`MODELS_PATH`（行24）、`EFFORTS_PATH`（行25）、`REPOS_POLL_MS = 10000`（行26）、`ACTIVE_STAGES`（行28）。
- `zh()`/`en()`：行30-305，完整词典。
- `style`：行307-387，注入 CSS 并查重。
- `el`/`apiGet`/`apiPost`：行389-408。
- `apply(ctx)`：行412-1341，`inject: ['slots','locale','configForms']`；注册设置卡与面板。
- `CodewikiCard(props)`：行452-851，设置卡片，拉 `/api/codewiki/models` 填级联下拉，保存时只对变了的 key 生成 op（key 清单行672）；内部 `useEfforts`（行524）与 `modelTrio`（行562）处理提供商/模型/思考档位联动。
- `ReposTab()`：行992-1135，总览标签，轮询 `/api/codewiki/repos`，可排除/编译。
- `CodewikiPanel()`：行1137-1337，侧边栏主面板（总览/任务/设置三标签），轮询 `/jobs` 并采样 tps/速率；`stageBar`（行915）、`overallPct`（行940）、`STAGE_WEIGHTS`（行939）驱动步骤条与进度。
- `PanelIcon(props)`：行1339-1350，摊开的书 SVG 图标。

## Architecture

```text
┌──────────────────────────────┐         ┌───────────────────────────────────────┐
│ 浏览器半侧 client.js          │         │ 宿主半侧 index.js                      │
│                              │         │                                       │
│ CodewikiCard 452 ────────┐   │ config  │  apply 3023 ── Config 48               │
│   (plugins.item)         │   ├────────►│    ├─ cw 889 / generate 2210           │
│ CodewikiPanel 1137 ──────┤   │         │    ├─ update 2370 / progress 2441      │
│   main + panellist       │◄──┼─ HTTP ──┤    ├─ installWebServer 2646            │
│ ReposTab 992 / Icon 1339 │   │ 回环    │    └─ installUpdateReminder 2989       │
│ stageBar 915 / pct 940   │   │         │                                       │
└──────────────────────────┘         │    │  createJobService 1218                │
                                     │    │   tick 2032 ── 每 10s ──┐             │
                                     │    │   STAGE_HANDLER 2024     │             │
                                     │    │   settleJob 1336 ◄───────┘             │
                                     │    │   batchRuns/Results/Aborters 1436      │
                                     │    └──────────┬────────────────────────────┘
                                     ▼               ▼
                    ┌────────────────────────┐  ┌──────────────────────────────┐
                    │ 本地 cw CLI            │  │ 宿主 llm 服务 (llmChat 285)    │
                    │ resolveBinary 105      │  │ 默认 workbuddy/hy3 (192k)      │
                    │ runCw 127（120s 超时）  │  │ 大档 volces-ark/glm-5.3-flash   │
                    │ 判态/索引/meta         │  │ 会话通道 dispatch 1517 兜底      │
                    └────────────────────────┘  └──────────────────────────────┘

持久化（同目录）：JOBS_FILE 1012 · REPOS_FILE 1067 · JOBS_LOCK_FILE 1127 · SESSION_TASK_DIR 1018
```

三条执行通道的取舍：批量通道（宿主 llm 服务）承接 ≤110k 单请求与多批观察；大档通道在单文件超 110k 但 ≤420k 时改用 glm-5.3-flash 在插件内写完；会话通道仅在连大档都装不下且配置了 bigProvider 时才兜底，把写作/校对交给发起会话的子智能体；`cw` CLI 只负责判态、建索引、刷基线，不参与文本生成。

## Data Flow

1. **初始化**：`apply()`（行3023）建服务、`service.start()` 起 10s tick（行2192）、注册四个工具、装 Web 端点与系统提示提醒；`client.js` 的 `apply()`（行412）注册词典、样式、设置卡片与侧边栏面板。
2. **提交判态**：调用方（模型工具 / 面板编译按钮 / 自动调度）→ `codewiki_generate.execute`（行2254）→ `cw status` → `parseStatus`（行178）得四态之一。
3. **建 job**：`svc.submit`（行2111）先落 `submitting` 占位、校验 llm 通道（行2146-2154）、再置 `articles`（full 或 stale 预置任务），`persist()`+`flush()` 后立即 `void tick()`（行2174）。
4. **本地规划（在 articles 阶段内）**：`tickArticles`（行1599）若 `!job.plan` 则 `scanRepoFiles`（行1097）→ `localPlan`（行682）按顶层目录分组生成 `job.plan.modules`（行1672-1677）；旧磁盘任务残留 `plan` 阶段在 `tick` 里被迁移到 `articles`（行2086-2094）。
5. **写文章** `tickArticles`（行1599）：`job.plan.modules` → 任务（`name: modules/<slug>.md`）→ `prepareArticleTasks`（行557）分流：
   - `prepared` 普通/大档 → `submitBatchFor`（行1481）→ `startBatchChatRun`（行1439）→ `runRealtimeTasks`（行329）并发打模型；
   - `#obs` 观察批 → 收割后用 `batchArticleComposePrompt`（行801）合成；
   - `sessionTasks` → `dispatchSessionTasks`（行1517）写任务文件 + steer 发起会话。
   结果回 `batchResults`，下一轮 `settleJob`（行1336）收割 → `tally`（行1381）→ `writeValidated`（行1362，frontmatter 闸门 + `fixAnchors` 修锚点）落盘。
6. **横切** `tickCrosscut`（行1744）：读回成功文章全文 → ≤大档预算单批直出 `_architecture.md`/`_patterns.md`/概念文章；超预算改「每篇一个观察」→ `tickCompose`（行1829）合成。
7. **校对** `tickReview`（行1878）：`localReview`（行1856）先本地核对 frontmatter/文件存在性/`source_files`，再按「文章 + source_files 源码」装填 `batchProofreadBatchPrompt`（行856）合并多篇；结果 `settleProofread`（行1406）拆回逐篇，`tally(..., { replace: true })` 覆盖同名条目，校对失败不推翻原文。
8. **索引** `tickIndex`（行1990）：`cw index` → `cw meta update` → `normalizeIndexLinks` → `ensureWikiEntry` → 若 `autoCommit` 开则 `autoCommitWiki`（行2904）自提交 → `done` + `finishedAt` + `onSettled(job, 'done')` → `wakeCompileSession`（行1202）仅在自动提交失败时对会话 steer 提醒。
9. **进度回流**：面板 `CodewikiPanel` 内 effect（行1150起）每 2s 拉 `/api/codewiki/jobs`、`ReposTab` 内 pull（行1001起）每 10s 拉 `/api/codewiki/repos`；`jobSummary`（行1154）的 `taskList` 决定进度条分母，`STAGE_WEIGHTS`（行939）决定权重，tps/速率由面板侧采样计算。
10. **取消**：`cancel()` 置 `cancelRequested` 并 `flush`（行2178-2187）；下一轮 `tick` 读到后 `abort` 在飞请求、丢未收割结果、置 `cancelled`（行2060-2069）。
11. **重启接管**：进程重启后新 `instanceId` 与原 `owner` 不符，`tick` 在 `idleMs > ORPHAN_TAKEOVER_MS` 时改 owner 接管（行2050-2057）；在途会话任务补发 steer（`resendSessionSteer`），批量任务靠 `job.tasks` 的 `batchPrompt` 快照重跑（行1336-1357）。

## Connections

- 上游 CLI：`[[cw-cli-wrapper]]`（本模块经 `runCw` 行127、`parseStatus` 行178、`wikiPathFor` 行990 与 `cw` 交互）。
- 提示词工程：`[[prompt-templates]]`（`articleFormatSection` 行648 与各 `batch*Prompt` 家族是文章产出格式与判据来源）。
- 持久化与并发：`[[job-store-and-locking]]`（`JOBS_FILE`/`JOBS_LOCK_FILE`/`REPOS_FILE`、`mergeFromDisk` 行1250 语义在此展开）。
- 面板与宿主 UI：`[[sidebar-panel-ui]]`（client.js 的 slot 挂载、词典、样式、组件树）。
- 外部依赖：宿主 `llm` 服务（`llmChat` 行285）、`agents` 服务（`wakeCompileSession` 行1202）、`webServer` 服务（`installWebServer` 行2646）、`workspaceRegistry` 服务（行2655）、`systemPrompt` 服务（`installUpdateReminder` 行2989）、`tools` 服务（行3063）、模型目录 `listModelCatalog` 行2584 与档位 `resolveModelEfforts` 行2622（`/api/codewiki/model-efforts` 端点行2821）。
- 参考实现：侧边栏面板挂载方式与 `dsh-hindsight-on-demand` 同款，`PANEL_ORDER = 52` 排在它的 50 之后（client.js 行21）。

## Known Issues

- **Token 估算只是近似**：`estimateTokens`（行269）用「CJK 1 token/字 + 其余 3.5 字符/token」，与真实分词器有偏差。预算靠 `BATCH_TOKEN_BUDGET`（行371）留余量吸收，但边界请求仍可能超预算；`submitBatchFor` 会统计并在 `overTier2` 与 note 里显式提示（行1484-1486）。
- **锁是单文件 + 60 秒过期**：`acquireTickLock`（行1130）靠 `wx` 独占创建 + mtime 判断，进程崩溃残留的锁要等 60 秒才强删；这段时间内所有实例都让路，任务原地停摆。
- **执行器随连接生死**：`runRealtimeTasks`（行329）的请求没有服务端批次可续查，宿主一重启就只剩「按 `batchPrompt` 快照全阶段重跑」这一条路（`settleJob` 行1336-1357）。快照缺失时直接 `fail`（行1355），已写成的文章不回滚但本阶段作废。
- **会话通道依赖发起会话存活**：`dispatchSessionTasks`（行1517）在无 agent 或无 `steer` 时直接 fail（行1520-1522）。面板、自动调度这类无会话提交一旦触发超预算任务就必然失败，只能「从会话内重新提交编译」。会话通道也不降级回批量，超时（默认 30 分钟，行1017）即按失败处理。
- **会话通道的收割判据偏松**：`classifySessionTask`（行1024）只要求 `mtime >= dispatchedAt` 且去前导空白后以 `---` 开头。子智能体写到一半时这两个条件都可能同时满足，`writeValidated` 的闸门同样只看开头三横线（行1363），存在把半成品当成品收割的窗口。
- **`fixAnchors` 明示的盲区**：符号在文内出现多处且都不是唯一声明形态时，它选择「不动」并记 `unresolved`（行467-468）；点分符号歧义时退试首段（行450），仍可能命中错误行；`source_files` 之外的文件引用一律不碰（行404-408），所以 frontmatter 漏列文件时锚点不会被校验。
- **tick 是串行推进**：`tick()`（行2032）对 `jobs` 逐个 `await handler`，一个 job 的 `settleJob`/`runCw`（最长 120s）会拖住同实例里其他 job 的推进；`ticking` 重入锁与 `TICK_MS` 让节拍可能被显著拉长。
- **`cw status` 解析强依赖文本**：`parseStatus`（行178）匹配的是 `'No wiki found'`、`'has not been compiled yet'`、`'Wiki is up to date'` 三个英文字面量与 `^\s+[M!]\s+` 行格式。上游 `cw` 改一句文案，三态判定就会整体落到「无法解析 → 改走全量编译」（行2340），代价是白跑一次全量。
- **Windows 路径兼容是启发式**：`normalizeCwd`（行37）只处理 `/e/...` 这一类 MSYS 盘符写法；`excludedItem`（行249）、`rememberRepo`（行1071）、`samePath`（行2430）各自做归一与大小写处理，三处规则不完全一致，混合大小写与尾斜杠组合时可能出现「排除了但仍出现在总览」这类不一致。
- **面板的速率/进度是客户端估算**：`overallPct`（行940）用固定 `STAGE_WEIGHTS`（行939），与实际耗时无关；`batchRateRef` 的 EWMA 只在面板轮询跨度内有效，刷新页面或切换工作区后 tps 曲线与 ETA 会从零重建，不反映真实剩余时间。
- **UI 兜底只覆盖渲染期异常**：`ReposTab`（行992）与 `CodewikiPanel`（行1137）用 try/catch 把渲染异常显示成 `<...> error: <stack>`，但样式表或 `@deepseek-ai/dsh-client-ui-primitives` 加载失败发生在更外层，仍可能整块不渲染。
- **面板轮询无退避**：`CodewikiPanel` 固定 2s（POLL_MS 行22）、`ReposTab` 固定 10s（REPOS_POLL_MS 行26），只做「不重叠」没做指数退避；Web 服务卡顿时前端仍按原频率发请求。
- **客户端设置 key 清单是硬编码**：`save()` 行663 起只遍历行672 硬编码列出的 key 生成 diff op，后端 Config 新增字段时若忘了同步这份清单，该字段在设置页改不动（不报错、仍提示已保存，但值未变）。
- **大档启用条件严格**：仅当配置 `bigProvider` 非空才启用大档（行560-568），否则超预算直接转会话通道；`bigTokenBudget` 须大于 110k（行86），否则被钳回默认。
- **自动提交安全边界**：`autoCommitWiki`（行2904）只在非合并中、有 HEAD、未被 ignore、无冲突、配了 user 时才提交，否则返回 `{committed:false, reason}` 降级为提醒（行2904-2945）；非 git 仓库或读取失败一律不提醒（行2973）。