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

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`（行2）、`version: "0.10.4"`（行3）、`private: true`（行5）、`type: "module"`（行6），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（行8-11），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（行20-27），运行期依赖只有 `@deepseek-ai/schemastery`（行17-19）。

代码分成两半，职责严格分离：

- `index.js`（共 2935 行）是宿主半侧。它封装本地 `cw` CLI（`runCw` 见行125）、定义 `Config` 配置（行48）、实现 `createJobService` 阶段机（行1252），注册四个模型工具（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`），并通过 `installWebServer`（行2569）在回环地址上暴露查询与控制端点。
- `client.js`（共 1343 行）是浏览器半侧。经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（行10-12）注册，向宿主注入设置卡片（`plugins.item`）和侧边栏面板（`main` + `sidebar.panellist`），靠轮询而非推送更新界面。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `plan` 依次推进到 `articles` → `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `done`，`tick`（行1987）按 10 秒节拍每次推进一步（`TICK_MS` 见行1050），全部状态落在 `JOBS_FILE`（行1049），因此宿主重启、多实例并存都能靠磁盘快照接管续跑。模型通道唯一：宿主 `llm` 服务（`llmChat` 见行283），默认 `workbuddy/hy3`（192k 上下文，行26-27），单请求输入预算 110k（行369）；单文件超预算时改用大档 `volces-ark/glm-5.3-flash`（512k，行30-31，预算 420k，行33），仍装不下才转会话通道兜底（`dispatchSessionTasks` 见行1521）。

## Key Components

### index.js — 配置与基础层

- `PLUGIN_NAME`：行18，值为 `'dsh-codewiki'`，同时以 `export const name` 导出（行19）。
- `CW_SUBCOMMANDS`：行20，['init','status','index','meta','path','projects','setup','uninstall']，`cw` 工具据此做子命令白名单校验。
- `CONCURRENCY_HARD_CAP`：行22，值 `8`，编译请求并发硬顶。
- `DEFAULT_CONCURRENCY` 等：行24-33，默认并发2、默认批量/大档模型与预算常量。
- `Config`：行48-67，`@deepseek-ai/schemastery` schema，共 18 个字段且全部 `.volatile()`：`enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`articleLanguage`、`updateReminder`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`。
- `liveConfig(config)`：行73-97，把配置折算成运行时值：`maxConcurrency` 钳到 `[1, CONCURRENCY_HARD_CAP]`、`autoUpdateMin` 下限5、`workspaceOnly !== false` 归一布尔、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`。
- `normalizeCwd(input)`：行37-42，仅 win32 把 MSYS 盘符路径 `/e/...` 归一为 `E:/...`；非 win32 原样返回。
- `resolveBinary(cfg)`：行103-123，解析顺序为「配置 `binaryPath` → PATH 里的 `cw`（win32 用 `where`，其余用 `which`）→ 插件自带 `bin/cw(.exe)` → 裸 `'cw'`」。PATH 优先避免捆绑副本落后于源码。
- `runCw(binary, cwd, args, timeoutMs = 120000, signal)`：行125-150，`spawn` 子进程收集 stdout/stderr，超时 `SIGKILL`，`signal.abort` 同样 `SIGKILL`；返回 `{ exitCode, stdout, stderr, timedOut }`，**永不 reject**。
- `normalizeArticlePath(p)`：行162，把 `\` 换成 `/`。
- `normalizeIndexLinks(cwd)`：行166-174，`cw index` 直写的 `.codewiki/_index.md` 里，把 `[[link|title]]` 链接头中的 `\` 规范化为 `/`。
- `parseStatus(stdout)`：行176-189，把 `cw status` 文本解析成 `{ state, changedFiles, staleArticles }`。四关键字判定：`'No wiki found'`→`missing`、`'has not been compiled yet'`→`uncompiled`、`'Wiki is up to date'`→`clean`，其余按 `^\s+[M!]\s+(.+)$` 逐行归类（`M` 进 changedFiles、`!` 进 staleArticles），状态记 `stale`。
- `countWikiArticles(wikiPath)`：行192-204，递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），失败返回 `null`。
- `ensureWikiEntry(cwd, language = '中文')`：行209-242，仓库根缺 `CodeWiki.md` 时按语言写入口说明；**已存在绝不覆盖**，生成失败只影响入口存在性。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`：行247-259，排除清单按 `[\n;，,]+` 分隔，`cwd` 等于某项或位于其子树内即命中（归一化小写比较）。
- `estimateTokens(text)`：行267-275，CJK 字符按1 token/字，其余按3.5字符/token，只求把单请求输入压进模型上下文。

### index.js — Token 预算、模型通道与执行器

- `BATCH_TOKEN_BUDGET`：行369，`110000`，单请求输入预算（hy3 192k 上下文留余量）。
- `BATCH_TOKEN_HARD_LIMIT`：行374，`128000`，超预算兜底装填上限（旧值150k已越界）。
- `llmChat({ llm, provider, model, reasoningEffort, prompt, signal })`：行283-302，**唯一模型通道**，走宿主 llm 服务（`llm.stream` + `BlockAssembler`），`temperature: 0`，消息来源标记 `plugin:codewiki`；`finish.kind` 为 `error`/`aborted` 或缺 content 时抛错。
- `applyTaskResult(task, content, notes)`：行306-319，任务结果统一出口。`keepInMemory` 任务只回内存；其余任务先跑 `fixAnchors` 修锚点再 `writeFileSync` 落盘。
- `runRealtimeTasks(tasks, { model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider })`：行327-356，**唯一执行器**。按并发上限消费队列，每任务调 `llmChat`；单任务异常只 `notes.push` 并置该任务 `ok: false`；返回 `Map(customId → { ok, stopReason, content? })`。

### index.js — 行号锚点、源码装填与任务装配

- `numberLines(content)`：行385-387，给每行加 `N| ` 前缀，让模型引用行号以前缀为准。
- `fixAnchors(content, cwd)`：行396-479，**文章落盘前第四层兜底**。只处理 frontmatter 之后行；从反引号提取符号，锚点起点行不含符号时在全文找出现行：恰好一处→修正；多处→只认 `function`/`class`/`const`/`let` 声明形态（`defRe` 行457），仍歧义不动并记 `unresolved`；只改行号数字，`source_files` 外引用不碰。
- `collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)`：行484-511，把源文件内联成 markdown（每段 `### <rel>` + 带 `numberLines` 围栏），**只整文件装填、绝不半文件截断**。返回 `{ text, skipped, oversized }`。
- `batchArticlePrompt({ language, mission, sourcesText, prevArticle })`：行515-542，单轮文章 prompt 骨架；有旧文时附上并明确「行号可能已过期、不得沿用」。
- `prepareArticleTasks(tasks, { cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget })`：行555-669，任务装配与**三级降级**：普通档装填→大档（bigTier）装填→会话通道兜底。返回 `{ prepared, sessionTasks }`；大档任务标 `bigTier` 并记录 provider/model。
- `articleFormatSection()`：行675-704，文章格式条款唯一来源：frontmatter 含 `title`/`type`/`source_files`/`tags`，正文六章节 `Overview`/`Key Components`/`Architecture`/`Data Flow`/`Connections`/`Known Issues`；行号必须以前缀为准；`Connections` 用 `[[backlinks]]`。

### index.js — Prompt 模板

- `batchPlannerPrompt(fileLines)`：行708-727，规划 prompt，要求输出纯 JSON（`project`/`modules`/`concepts`）。
- `localPlan(files)`：行730-743，规划兜底：按顶层目录分组。
- `packArticles(articles, budget = BATCH_TOKEN_BUDGET)`：行747-766，横切输入装配；整篇装不下时只装头部并标「超预算，仅头部」。
- `crosscutIntro` / `batchArchitecturePrompt` / `batchPatternsPrompt` / `batchConceptPrompt`：行768-804，横切三个 prompt 公共骨架与具体实现。
- `batchObservePrompt`：行808-825，横切 map 阶段观察（不带 frontmatter）。
- `batchArticleObservePrompt`：行829-845，文章分割 map 阶段观察。
- `batchArticleComposePrompt`：行849-877，合并各批观察成整篇。
- `batchProofreadPrompt`：行881-900，校对 prompt：四项核对，输出修正后整文。

### index.js — 工具定义

- `cwToolDefinition(cfg)`：行906-969，`cw` 工具。校验启用、cwd 存在、args 非空、子命令白名单，随后 `runCw`。
- `slugify(name)`：行975-977，小写化非 `[a-z0-9-_]` 折成 `-`。
- `parsePlan(text)`：行979-999，剥围栏取 JSON，校验 modules 非空。
- `parseSourceFiles(fm)`：行1003-1015，解析 frontmatter 的 `source_files`（行内/块状两式）。
- `readSourceFiles(articlePath)`：行1017-1025，读文章文件并调 `parseSourceFiles` 取源文件清单，供 stale/校对流程使用。
- `wikiPathFor(cwd, binary, signal)`：行1027-1032，跑 `cw path` 取最后一个非空行，失败回落 `<repo>/.codewiki`。
- `generateToolDefinition(cfg, svc)`：行2153-2303，`codewiki_generate` 总入口。`execute`（行2197起）校验启用/svc/cwd/排除清单，`cw status` 判态，分支：同仓库活动任务直接返回、stale 升全量、clean 只报告、stale 有过期文章构造预建任务、missing 先 `cw init` 再提交 full。
- `updateToolDefinition(cfg, generateDef)`：行2312-2364，`codewiki_update` 固定 `scope: 'auto'` 快捷入口。
- `samePath` / `progressView`：行2372-2381，路径比较与进度百分比补算。
- `progressToolDefinition(cfg, svc)`：行2383-2465，`codewiki_progress` 只读工具，按 jobId 或 cwd 过滤。

### index.js — createJobService（阶段机核心）

`createJobService(config, onSettled)`：行1252-2146，返回 `{ submit, cancel, list, findActive, start, stop }`（行2145）。

- `instanceId`：行1260，tick 只推进本实例创建的 job，防双提交。
- `dirty`/`dirtyIds`/`flush()`/`mergeFromDisk()`：行1263-1309，只有状态变更才整写 `JOBS_FILE`；本实例动过的 job 不允许被磁盘快照反向覆盖。
- `note`/`touch`/`setStage`/`addUsage`：行1310-1342，状态变更统一入口，记阶段耗时与 token 用量。
- `syncCancelFlags()`：行1346-1357，每轮 tick 从磁盘拾取别实例取消标记。
- `fail(job, msg)`：行1359-1367，置 failed、写 error/finishedAt。
- `settleJob(job)`：行1370-1391，收割阶段结果；执行器丢失（宿主重启）则按 `job.tasks` 的 `batchPrompt` 快照重跑本阶段。
- `writeValidated(job, task, content)`：行1396-1412，**闸门：去前导空白后必须以 `---` 开头**，缺 frontmatter 不落盘。
- `tally(job, results, tasks, { replace })`：行1415-1436，结果记账；`replace:true`（校对）覆盖同名条目且失败不推翻原文。
- `batchRuns`/`batchResults`/`batchAborters`：行1442-1444，解耦 tick 与长请求。
- `startBatchChatRun(job, prepared)`：行1445-1485，启动后台并发池，调 `llmRef.stream`。
- `submitBatchFor(job, prepared)`：行1487-1513，提交前预记账输入 token，快照化 `prepared` 进 `job.tasks`（batchPrompt 为重跑依据）。
- `dispatchSessionTasks(job, tasks)`：行1521-1555，会话通道派发：写任务文件 + `agent.steer`；发起会话不可用直接 fail。
- `progressSessionTasks(job)`：行1559-1578，收割会话任务（timeout/harvest/wait）。
- `resendSessionSteer(job)`：行1582-1595，宿主重启接管后重发 steer，不重置 dispatchedAt。
- `tickPlan`：行1599-1629；`tickArticles`：行1634-1749（含 `#obs` 观察批归并与合成）；`crosscutTasks`：行1752-1771；`tickCrosscut`：行1773-1836；`tickCompose`：行1839-1851；`submitComposeBatch`：行1853-1863；`localReview`：行1866-1886；`tickReview`：行1888-1951；`tickIndex`：行1953-1976；`STAGE_HANDLER`：行1978-1985；`tick()`：行1987-2052（孤儿接管、取消、串行推进）。
- `submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId })`：行2054-2119，先落 `submitting` 占位，校验 llm 通道，置 stage，立即 `tick()`。
- `cancel(jobId)`：行2121-2130；`list`/`findActive`/`start`/`stop`：行2132-2145。

**job 对象字段**（行2064-2083）：`id`、`cwd`、`wikiPath`、`scope`、`language`、`kind`、`owner`、`stage`、`auto`、`sessionId`、`plan`、`batchRef`、`tasks`、`articles`、`writtenCount`、`failedCount`、`usage`、`stageTimings`、`stageStartedAt`、`notes`、`createdAt`、`updatedAt`；运行期追加 `batchProgress`、`batchSubmittedAt`、`tpsSamples`、`sessionTasks`、`cancelRequested`、`crosscutSplit`、`error`、`finishedAt` 等。

### index.js — 持久化与常量

- `JOBS_FILE`：行1049，`DSH_CODEWIKI_JOBS_FILE` 或 `os.tmpdir()/dsh-codewiki-jobs.json`。
- `TICK_MS`：行1050，默认10000、下限250。
- `SESSION_TASK_TIMEOUT_MS`：行1054，默认30分钟；`SESSION_TASK_DIR`：行1055。
- `classifySessionTask(task, nowMs)`：行1061-1071，纯函数三态：timeout/wait/harvest。
- `buildSessionSteerText({ job, snapshots, tier, resend })`：行1078-1096，会话通道 steer 文本，tier 非空时要求显式传 tier。
- `ORPHAN_TAKEOVER_MS`：行1098，默认5分钟；`MAX_JOBS_KEPT`：行1099，30。
- `REPOS_FILE`：行1104；`loadKnownRepos`/`rememberRepo`：行1105-1116。
- `JOB_TERMINAL`：行1117，终态集合（`done`/`failed`/`cancelled`）。
- `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES`：行1120-1133；`scanRepoFiles(cwd)`：行1134-1157。
- `loadJobs`：行1159；`JOBS_LOCK_FILE`/`acquireTickLock`/`releaseTickLock`：行1164-1182；`saveJobs`：行1184-1189。
- `jobSummary(job)`：行1191-1225，面板与工具共用投影，含 tps 计算。
- `agentsRef`/`llmRef`：行1232-1237，经 `ctx.inject` 获取。
- `wakeCompileSession(job, outcome, agents)`：行1239-1250，对 sessionId 对应会话 steer 唤醒。
- `listModelCatalog(llm)`：行2507-2528，枚举 provider/model；`resolveModelInfoOf`：行2534-2539，兼容 `resolveModelInfo`/`resolveModel`；`resolveModelEfforts`：行2545-2567，读思考档位。
- `installWebServer(ctx, service, extra)`：行2569-2789，端点：`GET /api/codewiki/jobs`、`/repos`、`/models`、`/model-efforts`，`POST /api/codewiki/control`（cancel/refresh/compile），均回环限制（`isLoopbackRequest` 行2471、`writeJson` 行2476、`readBodyJson` 行2482）。
- `commitHintText(cwd, jobs)`：行2804-2829，60s TTL，git 日志比对提醒提交。
- `reminderText(cwd)`：行2831-2840，系统提示维护纪律。
- `installUpdateReminder(ctx, config)`：行2842-2874，注入 `systemPrompt.section`。
- `apply(ctx, config)`：行2876-2935，插件入口：注入 agents/llm、建服务、起自动更新调度器、注册工具、装 Web 与提醒。

### client.js — 浏览器半侧

- 文件头注释（行1-8）记录硬约束：`id` 等于 `package.json` 的 `name`、词典值必须字符串。
- `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) {...} })`：行10-12；`require` 取 `Switch`/`Button`/`Input`/`Tag`（行14-15）。
- 常量：`NS = 'codewiki'`（行17）、`KEY = 'codewiki'`（行18）、`JOBS_PATH`（行19）、`CONTROL_PATH`（行20）、`PANEL_ORDER = 52`（行21）、`POLL_MS = 2000`（行22）、`REPOS_PATH`（行23）、`MODELS_PATH`（行24）、`EFFORTS_PATH`（行25）、`REPOS_POLL_MS = 10000`（行26）、`ACTIVE_STAGES`（行28）。
- `zh()`/`en()`：行30-305，完整词典。
- `style`：行307-387，注入 CSS 并查重。
- `el`/`apiGet`/`apiPost`：行389-408。
- `apply(ctx)`：行412-1341，`inject: ['slots','locale','configForms']`；注册设置卡与面板。
- `CodewikiCard(props)`：行452-842，设置卡片，拉 `/api/codewiki/models` 填级联下拉，保存时只对变了的 key 生成 op（key 清单行672）；内部 `useEfforts`（行524）与 `modelTrio`（行562）处理提供商/模型/思考档位联动。
- `ReposTab()`：行981-1124，总览标签，轮询 `/api/codewiki/repos`，可排除/编译。
- `CodewikiPanel()`：行1126-1326，侧边栏主面板（总览/任务/设置三标签），轮询 `/jobs` 并采样 tps/速率；`stageBar`（行904）、`overallPct`（行929）、`STAGE_WEIGHTS`（行928）驱动步骤条与进度。
- `PanelIcon(props)`：行1328-1339，摊开的书 SVG 图标。

## Architecture

```text
┌──────────────────────────────┐         ┌───────────────────────────────────────┐
│ 浏览器半侧 client.js          │         │ 宿主半侧 index.js                      │
│                              │         │                                       │
│ CodewikiCard 452 ────────┐   │ config  │  apply 2876 ── Config 48               │
│   (plugins.item)         │   ├────────►│    ├─ cw 906 / generate 2153           │
│ CodewikiPanel 1126 ──────┤   │         │    ├─ update 2312 / progress 2383      │
│   main + panellist       │◄──┼─ HTTP ──┤    ├─ installWebServer 2569            │
│ ReposTab 981 / Icon 1328 │   │ 回环    │    └─ installUpdateReminder 2842       │
│ stageBar 904 / pct 929   │   │         │                                       │
└──────────────────────────┘         │    │  createJobService 1252                 │
                                     │    │   tick 1987 ── 每 10s ──┐             │
                                     │    │   STAGE_HANDLER 1978     │             │
                                     │    │   settleJob 1370 ◄───────┘             │
                                     │    │   batchRuns/Results/Aborters 1442      │
                                     │    └──────────┬────────────────────────────┘
                                     ▼               ▼
                    ┌────────────────────────┐  ┌──────────────────────────────┐
                    │ 本地 cw CLI            │  │ 宿主 llm 服务 (llmChat 283)    │
                    │ resolveBinary 103      │  │ 默认 workbuddy/hy3 (192k)      │
                    │ runCw 125（120s 超时）  │  │ 大档 volces-ark/glm-5.3-flash   │
                    │ 判态/索引/meta         │  │ 会话通道 dispatch 1521 兜底      │
                    └────────────────────────┘  └──────────────────────────────┘

持久化（同目录）：JOBS_FILE 1049 · REPOS_FILE 1104 · JOBS_LOCK_FILE 1164 · SESSION_TASK_DIR 1055
```

三条执行通道的取舍：批量通道（宿主 llm 服务）承接 ≤110k 单请求与多批观察；大档通道在单文件超 110k 但 ≤420k 时改用 glm-5.3-flash 在插件内写完；会话通道仅在连大档都装不下且配置了 bigProvider 时才兜底，把写作/校对交给发起会话的子智能体；`cw` CLI 只负责判态、建索引、刷基线，不参与文本生成。

## Data Flow

1. **初始化**：`apply()`（行2876）建服务、`service.start()` 起 10s tick（行2139）、注册四个工具、装 Web 端点与系统提示提醒；`client.js` 的 `apply()`（行412）注册词典、样式、设置卡片与侧边栏面板。
2. **提交判态**：调用方（模型工具 / 面板编译按钮 / 自动调度）→ `codewiki_generate.execute`（行2197）→ `cw status` → `parseStatus`（行176）得四态之一。
3. **建 job**：`svc.submit`（行2054）先落 `submitting` 占位、校验 llm 通道（行2088-2097）、再置 `plan`（full）或 `articles`（stale），`persist()`+`flush()` 后立即 `void tick()`（行2117）。
4. **规划** `tickPlan`（行1599）：`scanRepoFiles` → `batchPlannerPrompt` → `llmChat` 批量规划 → `parsePlan`；失败降级 `localPlan`（行730）。产出 `job.plan = { project, modules[], concepts[] }`。
5. **写文章** `tickArticles`（行1634）：`job.plan.modules` → 任务（`name: modules/<slug>.md`）→ `prepareArticleTasks`（行555）分流：
   - `prepared` 普通/大档 → `submitBatchFor`（行1487）→ `startBatchChatRun`（行1445）→ `runRealtimeTasks`（行327）并发打模型；
   - `#obs` 观察批 → 收割后用 `batchArticleComposePrompt`（行849）合成；
   - `sessionTasks` → `dispatchSessionTasks`（行1521）写任务文件 + steer 发起会话。
   结果回 `batchResults`，下一轮 `settleJob`（行1370）收割 → `tally`（行1415）→ `writeValidated`（行1396，frontmatter 闸门 + `fixAnchors` 修锚点）落盘。
6. **横切** `tickCrosscut`（行1773）：读回成功文章全文 → ≤110k 单批直出 `_architecture.md`/`_patterns.md`/概念文章；超预算改「每篇一个观察」→ `tickCompose`（行1839）合成。
7. **校对** `tickReview`（行1888）：`localReview`（行1866）先本地核对 frontmatter/文件存在性/`source_files`，再按「文章 + source_files 源码」装填 `batchProofreadPrompt`（行881）；结果 `tally(..., { replace: true })` 覆盖同名条目，校对失败不推翻原文。
8. **索引** `tickIndex`（行1953）：`cw index` → `cw meta update` → `normalizeIndexLinks` → `ensureWikiEntry` → `done` + `finishedAt` + `onSettled(job, 'done')` → `wakeCompileSession`（行1239）steer 发起会话「请提交改动」。
9. **进度回流**：面板 `CodewikiPanel` 内 effect（行1139起）每 2s 拉 `/api/codewiki/jobs`、`ReposTab` 内 pull（行990起）每 10s 拉 `/api/codewiki/repos`；`jobSummary`（行1191）的 `taskList` 决定进度条分母，`STAGE_WEIGHTS`（行928）决定权重，tps/速率由面板侧采样计算。
10. **取消**：`cancel()` 置 `cancelRequested` 并 `flush`（行2121-2130）；下一轮 `tick` 读到后 `abort` 在飞请求、丢未收割结果、置 `cancelled`（行2015-2024）。
11. **重启接管**：进程重启后新 `instanceId` 与原 `owner` 不符，`tick` 在 `idleMs > ORPHAN_TAKEOVER_MS` 时改 owner 接管（行2007-2012）；在途会话任务补发 steer（`resendSessionSteer`），批量任务靠 `job.tasks` 的 `batchPrompt` 快照重跑（行1370-1391）。

## Connections

- 上游 CLI：`[[cw-cli-wrapper]]`（本模块经 `runCw` 行125、`parseStatus` 行176、`wikiPathFor` 行1027 与 `cw` 交互）。
- 提示词工程：`[[prompt-templates]]`（`articleFormatSection` 行675 与各 `batch*Prompt` 家族是文章产出格式与判据来源）。
- 持久化与并发：`[[job-store-and-locking]]`（`JOBS_FILE`/`JOBS_LOCK_FILE`/`REPOS_FILE`、`mergeFromDisk` 行1284 语义在此展开）。
- 面板与宿主 UI：`[[sidebar-panel-ui]]`（client.js 的 slot 挂载、词典、样式、组件树）。
- 外部依赖：宿主 `llm` 服务（`llmChat` 行283）、`agents` 服务（`wakeCompileSession` 行1239）、`webServer` 服务（`installWebServer` 行2569）、`workspaceRegistry` 服务（行2578）、`systemPrompt` 服务（`installUpdateReminder` 行2842）、`tools` 服务（行2916）、模型目录 `listModelCatalog` 行2507 与档位 `resolveModelEfforts` 行2545（`/api/codewiki/model-efforts` 端点行2735）。
- 参考实现：侧边栏面板挂载方式与 `dsh-hindsight-on-demand` 同款，`PANEL_ORDER = 52` 排在它的 50 之后（client.js:21）。

## Known Issues

- **Token 估算只是近似**：`estimateTokens`（行267）用「CJK 1 token/字 + 其余 3.5 字符/token」，与真实分词器有偏差。预算靠 `BATCH_TOKEN_BUDGET`（行369）留余量吸收，但边界请求仍可能超预算；`submitBatchFor` 会统计并在 `overTier2` 与 note 里显式提示（行1490）。
- **锁是单文件 + 60 秒过期**：`acquireTickLock`（行1167）靠 `wx` 独占创建 + mtime 判断，进程崩溃残留的锁要等 60 秒才强删；这段时间内所有实例都让路，任务原地停摆。
- **执行器随连接生死**：`runRealtimeTasks`（行327）的请求没有服务端批次可续查，宿主一重启就只剩「按 `batchPrompt` 快照全阶段重跑」这一条路（`settleJob` 行1370-1391）。快照缺失时直接 `fail`，已写成的文章不回滚但本阶段作废。
- **会话通道依赖发起会话存活**：`dispatchSessionTasks`（行1521）在无 agent 或无 `steer` 时直接 fail（行1524-1527）。面板、自动调度这类无会话提交一旦触发超预算任务就必然失败，只能「从会话内重新提交编译」。会话通道也不降级回批量，超时（默认 30 分钟，行1054）即按失败处理。
- **会话通道的收割判据偏松**：`classifySessionTask`（行1061）只要求 `mtime >= dispatchedAt` 且去前导空白后以 `---` 开头。子智能体写到一半时这两个条件都可能同时满足，`writeValidated` 的闸门同样只看开头三横线（行1397），存在把半成品当成品收割的窗口。
- **`fixAnchors` 明示的盲区**：符号在文内出现多处且都不是唯一声明形态时，它选择「不动」并记 `unresolved`（行465-466）；点分符号歧义时退试首段（行448），仍可能命中错误行；`source_files` 之外的文件引用一律不碰（行402-406），所以 frontmatter 漏列文件时锚点不会被校验。
- **tick 是串行推进**：`tick()`（行1987）对 `jobs` 逐个 `await handler`，一个 job 的 `settleJob`/`runCw`（最长 120s）会拖住同实例里其他 job 的推进；`ticking` 重入锁与 `TICK_MS` 让节拍可能被显著拉长。
- **`cw status` 解析强依赖文本**：`parseStatus`（行176）匹配的是 `'No wiki found'`、`'has not been compiled yet'`、`'Wiki is up to date'` 三个英文字面量与 `^\s+[M!]\s+` 行格式。上游 `cw` 改一句文案，三态判定就会整体落到「无法解析 → 改走全量编译」（行2277-2284），代价是白跑一次全量。
- **Windows 路径兼容是启发式**：`normalizeCwd`（行37）只处理 `/e/...` 这一类 MSYS 盘符写法；`excludedItem`（行247）、`rememberRepo`（行1108）、`samePath`（行2372）各自做归一与大小写处理，三处规则不完全一致，混合大小写与尾斜杠组合时可能出现「排除了但仍出现在总览」这类不一致。
- **面板的速率/进度是客户端估算**：`overallPct`（行929）用固定 `STAGE_WEIGHTS`（行928），与实际耗时无关；`batchRateRef` 的 EWMA 只在面板轮询跨度内有效，刷新页面或切换工作区后 tps 曲线与 ETA 会从零重建，不反映真实剩余时间。
- **UI 兜底只覆盖渲染期异常**：`ReposTab`（行981）与 `CodewikiPanel`（行1126）用 try/catch 把渲染异常显示成 `<...> error: <stack>`，但样式表或 `@deepseek-ai/dsh-client-ui-primitives` 加载失败发生在更外层，仍可能整块不渲染。
- **面板轮询无退避**：`CodewikiPanel` 固定 2s（POLL_MS 行22）、`ReposTab` 固定 10s（REPOS_POLL_MS 行26），只做「不重叠」没做指数退避；Web 服务卡顿时前端仍按原频率发请求。
- **客户端设置 key 清单是硬编码**：`save()` 行663 起只遍历行672 硬编码列出的 key 生成 diff op，后端 Config 新增字段时若忘了同步这份清单，该字段在设置页改不动（不报错、仍提示已保存，但值未变）。
- **大档启用条件严格**：仅当配置 `bigProvider` 非空才启用大档（行558-566），否则超预算直接转会话通道；`bigTokenBudget` 须大于 110k（行85），否则被钳回默认。