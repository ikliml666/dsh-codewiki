---
title: plugin-core
type: module
source_files:
  - index.js
  - client.js
  - package.json
  - cordis.patch.yml
tags: [codewiki, dsh-plugin, wiki-pipeline, job-service, llm-batch, web-panel]
---

## Overview

`plugin-core` 是 dsh-codewiki 插件的全部核心代码：把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`）接入 DeepSeek Harness（DSH），并提供一条**插件内全批量 wiki 编译流水线**（规划 → 写文章 → 横切 → 合成 → 审校 → 索引），全程零子代理（不使用 DSH 的 delegate/subagent），默认编译模型 `workbuddy/hy3`（192k 上下文，index.js:369-370），大档模型 `volces-ark/glm-5.3-flash`（512k 上下文，index.js:369-370），单请求输入预算 110k token（index.js:369 `BATCH_TOKEN_BUDGET`），硬上限 128k（index.js:374 `BATCH_TOKEN_HARD_LIMIT`），大档预算 420k（index.js:33 `DEFAULT_BIG_TOKEN_BUDGET`）。

代码分两半：

| 文件 | 运行位置 | 职责 | 行数 |
| --- | --- | --- | --- |
| `index.js` | DSH 宿主（Node ≥20，ESM） | 4 个 agent 工具、后台编译作业服务（阶段机 + 双执行通道）、HTTP API、系统提示提醒注入 | 2935 |
| `client.js` | 浏览器（DSH Web） | 设置卡片（plugins.item 挂载点）+ 侧边栏编译面板（main / sidebar.panellist 挂载点） | 1343 |
| `package.json` | — | 插件清单：`@local/dsh-codewiki` v0.10.4、exports、bundle patch 声明 | 28 |
| `cordis.patch.yml` | — | bundle 形式安装的 cordis 插件 patch（本地开发走 profiles 直挂） | 19 |

核心设计点（写给零上下文读者的速览）：

1. **两个世界一条流水线**：`codewiki_generate` 工具（index.js:1252）只做「判态 + 提交」，真正的编译由 `createJobService`（index.js:1252）的后台阶段机推进；宿主每 10s 一次 tick（`TICK_MS`，index.js:1050），每个阶段把任务装填成 prompt 后走两条执行通道之一。
2. **双执行通道**：① 实时并发池 `runRealtimeTasks`（index.js:327，默认并发 2，硬顶 8）直接 `llm.stream`；② 会话兜底通道 `dispatchSessionTasks`（index.js:1521）——单文件连 128k 硬限都装不下且未配置大档时，把完整任务写成 prompt 文件放进 `SESSION_TASK_DIR`（index.js:1055），`agent.steer` 派给发起会话的子智能体（零子代理原则的例外）。
3. **大档通道**：配置了 `bigProvider` 时（index.js:555-574 的 Config 默认即为 `volces-ark`），单文件超普通预算先按大档预算（默认 420k）重装，仍装不下才转会话兜底（index.js:555-664 `prepareArticleTasks` 中 `markBig` / `forceSession` 逻辑）。
4. **零落盘信任链**：批量通道的 LLM 输出只在内存流转，统一经 `writeValidated`（index.js:1396）校验 frontmatter（必须以 `---` 开头）+ `fixAnchors`（index.js:396，行号锚点修正）后才写文件；校验失败不落盘。
5. **断点续跑**：任务提交时把 prompt 快照持久化进 jobs 文件（`saveJobs`，index.js:1184），宿主重启后 `settleJob`（index.js:1370）按快照重跑在飞批次；会话通道靠 Temp 任务文件 + `resendSessionSteer`（index.js:1582）接管。
6. **浏览器半侧纯只读轮询**：面板每 2s 拉一次 `/api/codewiki/jobs`（client.js:22 `POLL_MS`），总览页每 10s 拉一次 `/api/codewiki/repos`（client.js:26 `REPOS_POLL_MS`）；写操作只有「保存设置（configForms）」与 `/api/codewiki/control`（取消/刷新/编译）。

## Key Components

### 插件元数据与配置（index.js:17-97）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `pluginDir` | index.js:17 | 插件目录（`dirname(fileURLToPath(import.meta.url))`），用于定位自带 `bin/cw.exe` |
| `PLUGIN_NAME` | index.js:18 | `'dsh-codewiki'` |
| `export const name` | index.js:19 | 插件导出名 = `PLUGIN_NAME` |
| `CW_SUBCOMMANDS` | index.js:20 | `cw` 工具子命令白名单：`['init','status','index','meta','path','projects','setup','uninstall']` |
| `CONCURRENCY_HARD_CAP` | index.js:22 | `8`，并发上限硬顶 |
| `DEFAULT_CONCURRENCY` | index.js:24 | `2` |
| `DEFAULT_BATCH_PROVIDER` / `DEFAULT_BATCH_MODEL` | index.js:26-27 | `'workbuddy'` / `'hy3'` |
| `DEFAULT_BIG_PROVIDER` / `DEFAULT_BIG_MODEL` | index.js:30-31 | `'volces-ark'` / `'glm-5.3-flash'` |
| `DEFAULT_BIG_TOKEN_BUDGET` | index.js:33 | `420000` |
| `normalizeCwd(input)` | index.js:37-42 | win32 下把 MSYS 风格 `/e/...` 转成 `E:/...` |
| `export const Config` | index.js:48-67 | schemastery `z.object`，18 个配置项全部 `volatile`（改后热生效）：`enabled`(true)、`binaryPath`('')、`batchProvider`('workbuddy')、`batchModel`('hy3')、`batchReasoningEffort`('')、`bigProvider`('volces-ark')、`bigModel`('glm-5.3-flash')、`bigReasoningEffort`('')、`bigTokenBudget`(420000)、`sessionTier`('')、`maxConcurrency`(2)、`serialProjects`(true)、`articleLanguage`(中文)、`updateReminder`(true)、`excludePaths`('')、`autoUpdate`(false)、`autoUpdateMin`(30)、`workspaceOnly`(true) |
| `val(x)` | index.js:69-71 | 解开 schemastery 包装（`.get()`） |
| `liveConfig(config)` | index.js:73-97 | 运行时归一化：`maxConcurrency` clamp 到 1–8；`autoUpdateMin` 下限 5 分钟；`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET` |
| `resolveBinary(cfg)` | index.js:103-123 | `binaryPath` 优先 → win32 `where cw` / POSIX `which cw` 探测 PATH → 插件自带 `bin/cw.exe\|cw` → 兜底 `'cw'` |

### cw CLI 执行与状态解析（index.js:125-259）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `runCw(binary, cwd, args, timeoutMs=120000, signal)` | index.js:125-150 | `spawn`（`windowsHide`），超时/abort 时 SIGKILL，resolve `{exitCode, stdout, stderr, timedOut}` |
| `export function normalizeArticlePath(p)` | index.js:162 | 单行：`\\` → `/` |
| `export function normalizeIndexLinks(cwd)` | index.js:166-174 | `cw index` 之后把 `.codewiki/_index.md` 里 `[[link\|...]]` 段内的 `\` 规范化为 `/`；文件缺失静默跳过 |
| `export function parseStatus(stdout)` | index.js:1881-1894 | 解析 `cw status` 输出 → `{state, changedFiles, staleArticles}`：`No wiki found`→`missing`；`has not been compiled yet`→`uncompiled`；`Wiki is up to date`→`clean`；逐行 `^\s+[M!]\s+(.+)$`，`M` 行进 `changedFiles`、`!` 行进 `staleArticles`（非空 → `stale`） |
| `countWikiArticles(wikiPath)` | index.js:192-204 | 递归统计 `.codewiki` 下 `.md` 篇数 |
| `ensureWikiEntry(cwd, language='中文')` | index.js:209-242 | 仓库根缺 `CodeWiki.md` 时生成中/英入口文件；已存在绝不覆盖 |
| `excludedItem(cwd, list)` / `isExcluded(cwd, list)` | index.js:247-256 / 257-259 | 排除清单按 `[\n;，,]+` 分隔；`normKey`（normalize + 小写 + 去尾斜杠）后做前缀子树匹配（`n===m \|\| n.startsWith(m+'\\') \|\| n.startsWith(m+'/')`），返回命中的排除项 / 布尔 |
| `estimateTokens(text)` | index.js:267-275 | 估算 token：CJK 区（U+4E00–9FFF、U+3000–303F、U+FF00–FFEF）每字 1 token，其余每 3.5 字符 1 token |

### LLM 调用与实时并发池（index.js:283-387）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `llmChat({llm, provider, model, reasoningEffort, prompt, signal})` | index.js:283-302 | 走宿主 `llm.stream` + `BlockAssembler`，`temperature 0`，`source {kind:'plugin:codewiki'}`；`finish.kind` 为 `error`/`aborted` 时抛错；返回 `{content, outputTokens}` |
| `applyTaskResult(task, content, notes)` | index.js:306-319 | `keepInMemory` 任务回内存（交 `tally`）；否则 `fixAnchors` + 写 `articlePath` |
| `runRealtimeTasks(tasks, {model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider})` | index.js:327-356 | 并发池：worker 循环按共享 cursor 消费任务，`llmChat(t.batchPrompt)`，成功回调 `onTaskDone({outputTokens, durationMs})`，结果聚合为 `Map(customId → applyTaskResult(...))`；单任务失败记 `notes` 不中断整批 |
| `BATCH_TOKEN_BUDGET` / `BATCH_TOKEN_HARD_LIMIT` | index.js:369 / 374 | `110000` / `128000`，单请求输入预算与硬限 |
| `sleep` / `readJsonFile(p)` | index.js:376 / 378-380 | 小工具 |
| `numberLines(content)` | index.js:385-387 | 每行加 `${i+1}\| ` 前缀——**全文行号引用体系的源头**，模型看到的行号由此而来 |

### fixAnchors：行号锚点修正（index.js:396-479）

`export function fixAnchors(content, cwd)`（index.js:396-479）。文章由 LLM 生成，行号常偏移；该函数在落盘前把 `path:12` / `path:12-30` 形式的锚点重新对准真实源码行：

- 范围限定：只处理 frontmatter `source_files` 列出的文件（index.js:399-401）。
- 符号提取 `symbolsOnLine`：反引号内符号须匹配 `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$` 且长度 ≥3（index.js:416-425）。
- 锚点正则：`/([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g`（index.js:431）。
- 修正策略：锚点起点行已含符号 → 认为正确不动；否则全文找该符号——唯一命中 → 修正；多处命中 → 仅当存在唯一「声明形态」（`function`/`class` 直接跟符号；`const`/`let` 须后跟 `=`）才修正；歧义/找不到 → 标记 unresolved 不动（index.js:443-468）。
- 只改行号数字；区间尾 `Math.min(R+(end2-start), src.length)` 钳到文件尾；混合行尾按整文主风格处理（index.js:469-477）。

### 源码装填与任务装填（index.js:484-664）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `collectSources(cwd, files, budget=BATCH_TOKEN_BUDGET)` | index.js:484-511 | 把文件内联成 `### 相对路径` + 带 `numberLines` 行号前缀的代码围栏；缺文件标注「（文件不存在或读取失败）」；单文件超 budget 且是第一个 → 返回 `oversized:true`；因预算被跳过的文件附警告「（以下文件因单请求输入预算未内联，行号相关描述不得涉及它们：…）」 |
| `batchArticlePrompt({language, mission, sourcesText, prevArticle})` | index.js:515-542 | 单轮写文章 prompt：`mission` + `sourcesText` + 格式条款（`articleFormatSection()`）；有 `prevArticle` 时提示行号体系是本文件独立的、不得沿用；禁止用围栏整体包裹输出 |
| `prepareArticleTasks(tasks, {cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget})` | index.js:555-664 | 装填调度核心：先按 `BATCH_TOKEN_BUDGET` 装填，超了再用 `BATCH_TOKEN_HARD_LIMIT` 或 bigTier 预算重装；分割判定 = `overflowFiles>0` 或 prompt 估算 >110k → 按文件分批；单文件连单文件上限都装不下 → 转大档（`markBig`）或 `forceSession` 转会话兜底通道。分批（batches>1）→ 产出观察任务组（`name` 加 `#obs${i}` 后缀、`keepInMemory`、`splitFor`、`composePlan`）；不分批 → 直接赋 `batchPrompt`，大档/会话任务进 `sessionTasks`，否则 `customId=t{n}` 进 `prepared`。返回 `{prepared, sessionTasks}` |

### prompt 构造器族（index.js:676-900）

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `articleFormatSection()` | index.js:675-704 | 文章格式条款（所有写文章类 prompt 共用）：`---` frontmatter（title/type/source_files/tags）+ `## Overview / Key Components / Architecture / Data Flow / Connections / Known Issues`；Key Components 须列全部公开函数/类/常量+行号；行号以「行号\| 」前缀为准禁止自数；≥3 组件画 UTF-8 box-drawing 框图（≤20 行）；Connections 用 `[[other-module]]`；写给零上下文 agent |
| `batchPlannerPrompt(fileLines)` | index.js:708-726 | 结构勘探员：输入 `path+bytes` 清单，输出纯 JSON 计划（`project`/`concepts`/`modules[{name,files}]`） |
| `localPlan(files)` | index.js:730-741 | 规划降级：`parsePlan` 失败时按目录结构直接生成计划 |
| `packArticles(articles, budget=BATCH_TOKEN_BUDGET)` | index.js:747-765 | 横切单批打包：拼各文章全文，装不下截头部并标注 |
| `crosscutIntro(language, what, requirements)` | index.js:768-786 | 横切 prompt 公共头 |
| `batchArchitecturePrompt(language, articlesText)` | index.js:782-791 | 产出 `_architecture.md` |
| `batchPatternsPrompt(language, articlesText)` | index.js:790-795 | 产出 `_patterns.md` |
| `batchConceptPrompt(language, concept, articlesText)` | index.js:798-809 | 产出 `concepts/<slug>.md` |
| `batchObservePrompt(language, moduleName, articleText)` | index.js:808-814 | 横切观察员（输入=单篇文章）：输出 5 项（职责/对外接口/依赖方向/模式风险/source_files 原样），禁 frontmatter |
| `batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal)` | index.js:829-847 | 文章分割观察（输入=一批源码）：4 项（每文件职责+导出名+常量+行号 / 调用关系 / 错误处理 / 文件清单），宁全勿简 |
| `batchArticleComposePrompt({language, mission, moduleName, observationsText, prevArticle})` | index.js:849-872 | 观察 → 完整文章（分批写文章的合成阶段），`source_files` 汇总各批观察 |
| `batchProofreadPrompt({language, articleText, sourcesText})` | index.js:881-905 | 审校员：4 项核对（frontmatter 必填 / 函数类名行号抽查 / 补 source_files / 与源码不符改写）；一致时也输出全文 |

### cw 工具与解析辅助（index.js:907-1032）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `cwToolDefinition(cfg)` | index.js:906-951 | 工具 `cw`：参数 `cwd`+`args`（必填）；execute：enabled 检查 → `normalizeCwd` → `existsSync` → 子命令白名单校验 → `runCw`（120s，超时抛错）；output render 首行 `cw ${command}（exit ${exitCode}…）` |
| `slugify(name)` | index.js:975-977 | 非 `[a-z0-9-_]+` → `-`；空 → `'module'` |
| `parsePlan(text)` | index.js:979-997 | 剥 fence → 首尾大括号 → `JSON.parse`；校验 `modules[{name,files}]`、`concepts`、`project`；失败返回 null |
| `parseSourceFiles(fm)` / `readSourceFiles(articlePath)` | index.js:1002-1015 / 1017-1025 | 解析 frontmatter `source_files`（inline `[a, b]` 与 block `- a` 两式）/ 读文章文件并解析 |
| `wikiPathFor(cwd, binary, signal)` | index.js:1027-1032 | `cw path`（30s）取 stdout 末行；失败回退 `cwd/.codewiki` |

### 作业服务基础设施（index.js:1049-1238）

常量（全部可用环境变量覆盖）：

| 常量 | 行号 | 值 |
| --- | --- | --- |
| `JOBS_FILE` | index.js:1049 | `DSH_CODEWIKI_JOBS_FILE` \|\| `<tmpdir>/dsh-codewiki-jobs.json` |
| `TICK_MS` | index.js:1050 | `max(250, DSH_CODEWIKI_TICK_MS \|\| 10000)` |
| `SESSION_TASK_TIMEOUT_MS` | index.js:1054 | `max(5min, DSH_CODEWIKI_SESSION_TIMEOUT_MS \|\| 30min)` |
| `SESSION_TASK_DIR` | index.js:1055 | `dirname(JOBS_FILE)/dsh-codewiki-session-tasks` |
| `ORPHAN_TAKEOVER_MS` | index.js:1098 | `max(60s, DSH_CODEWIKI_ORPHAN_TAKEOVER_MS \|\| 5min)` |
| `MAX_JOBS_KEPT` | index.js:1099 | `30`（jobs 文件滚动上限） |
| `REPOS_FILE` | index.js:1104 | `DSH_CODEWIKI_REPOS_FILE` \|\| `dirname(JOBS_FILE)/dsh-codewiki-repos.json` |
| `JOB_TERMINAL` | index.js:1117 | `Set(['done','failed','cancelled'])` |
| `SCAN_SKIP_DIRS` / `SCAN_SKIP_EXT` | index.js:1120-1125 / 1126-1130 | 扫描跳过的目录/扩展名黑名单 |
| `SCAN_MAX_FILE_BYTES` / `SCAN_MAX_FILES` | index.js:1131 / 1132 | `256*1024` / `2000` |

函数：

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `classifySessionTask(task, nowMs=Date.now())` | index.js:1061-1071 | 会话通道任务三态：`timeout`（派发后超 `SESSION_TASK_TIMEOUT_MS`）/ `harvest`（结果文件存在且 mtime ≥ dispatchedAt 且以 `---` 开头）/ `wait` |
| `buildSessionSteerText({job, snapshots, tier='', resend=false})` | index.js:1078-1096 | 构造 steer 给子智能体的文案；review 阶段用校对文案；`tier` 非空时要求 delegate 显式传 tier（0.9.2 起档位钉死：自动选路实测恒判 default，用户自建 codewiki 档轮不到）；`resend` 时加前缀【CodeWiki 超预算任务·重新派发】 |
| `loadKnownRepos` / `rememberRepo(cwd)` | index.js:1105-1107 / 1108-1116 | 已知仓库登记表（`REPOS_FILE`）读写；normKey 去重，写盘失败静默放弃 |
| `scanRepoFiles(cwd)` | index.js:1134-1157 | 递归扫源码文件：跳 `SCAN_SKIP_DIRS`、`.` 开头目录、`SCAN_SKIP_EXT`；只收 `0 < size ≤ 256KB`，上限 2000 个；返回 `[{path, bytes}]` |
| `loadJobs` | index.js:1159-1162 | 读 `JOBS_FILE`（损坏按空处理） |
| `acquireTickLock` / `releaseTickLock` | index.js:1167-1182 / 1183-1187 | `JOBS_FILE.lock` 互斥：`wx` 写入 pid；已有锁且 mtime 超 60s 视为陈锁强删重写 |
| `saveJobs(jobs)` | index.js:1184-1189 | 整写 `{jobs}`，`slice(-MAX_JOBS_KEPT)` 滚动保留 |
| `jobSummary(job)` | index.js:1191-1225 | 给 HTTP API 的任务快照：`tps = ΣoutputTok / ΣgenMs`（`tpsSamples` 聚合）、`taskList`（已结算在前 pending 在后）、`batchProgress`、`stageTimings`、`usage`、`notes`（尾部 8 条）等 |
| `agentsRef` / `llmRef` | index.js:1232 / 1237 | module-level 引用，`apply` 时经 `ctx.inject(['agents'/'llm'])` 赋值 |
| `wakeCompileSession(job, outcome, agents=agentsRef)` | index.js:1239-1250 | 编译终态回唤发起会话：`agent.steer(createUserMessage(...))`；done → 「【CodeWiki 编译完成·请提交改动】」（建议 `docs(wiki)` 前缀、只 add `.codewiki/` 与 `CodeWiki.md`、不要 `git add -A`）；failed → 「【CodeWiki 编译失败】…」 |

### createJobService：作业服务与阶段机（index.js:1252-2145）

`function createJobService(config, onSettled)`（index.js:1252-2145）是全插件的中枢，返回 `{submit, cancel, list, findActive, start, stop}`（index.js:2145）。内部按序：

**服务状态与持久化**

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `instanceId` | index.js:1260 | `svc-<ts36>-<rand36>`，多宿主实例同盘共存时区分 owner |
| Temp 沙箱清理 | index.js:1270-1281 | 启动时清理 `cwd` 位于系统临时目录的终态任务（调试/测试期产物） |
| `mergeFromDisk()` | index.js:1284-1304 | 读盘合并：磁盘同 id 且 `updatedAt` 更新且不在 `dirtyIds` → 吸收；新 id → 加入；按 `createdAt` 排序 |
| `flush()` | index.js:1306-1309 | dirty 才 `mergeFromDisk + saveJobs` |
| `note(job, msg)` | index.js:1310-1313 | 追加 `job.notes`（上限 50） |
| `touch(job)` | index.js:1316-1318 | `updatedAt` + dirty 标记的统一入口 |
| `setStage(job, stage)` | index.js:1321-1331 | 阶段切换 + `stageTimings` 累计 |
| `addUsage(job, ...)` | index.js:1333-1342 | 用量累计：`inputTok/outputTok/requests/batchRequests/realtimeRequests/overTier2` |
| `syncCancelFlags()` | index.js:1346-1357 | 每次 tick 开头从磁盘拾取跨实例的 `cancelRequested` |
| `fail(job, msg)` | index.js:1359-1367 | 置失败；`submitting` 期失败不回唤会话 |

**批量执行与落盘**

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `settleJob(job)` | index.js:1370-1391 | 批次结算：`batchResults` 有 → 收割返回；`batchRuns` 在跑 → null（继续等）；执行器丢失（宿主重启）→ 按 `job.tasks` 里的 `batchPrompt` 快照重跑 `startBatchChatRun`；无快照 → fail「请求因宿主重启丢失且无法重跑（任务缺少 prompt 快照），请重新提交」 |
| `writeValidated(job, task, content)` | index.js:1396-1412 | **keepInMemory 任务的唯一写盘点**：content 非 string 或不以 `---` 开头 → 不落盘；通过 → `fixAnchors` + 写 `articlePath` |
| `tally(job, results, tasks, {replace=false})` | index.js:1415-1436 | 结算入账：`keepInMemory` 任务逐个 `writeValidated`；`replace=true`（review 阶段）覆盖同名条目（校对失败不推翻已写成功的原文）；新条目 ok → `writtenCount++` 否则 `failedCount++` |
| `batchRuns/batchResults/batchAborters` | index.js:1442-1444 | 三个 Map：在飞批次 / 已完成结果 / 中断控制器 |
| `startBatchChatRun(job, prepared)` | index.js:1445-1484 | 包装 `runRealtimeTasks`：`onTaskDone` 更新 `batchProgress` + `tpsSamples`（保留 20 个）+ `addUsage`；整批异常 → `batchResults=null` + 非终态时 `fail`；finally 清理 |
| `submitBatchFor(job, prepared)` | index.js:1487-1513 | 提交一批：超预算任务计数 `overTier2`（>110k 提示依据）；`batchRef={batchId:'stage-'+job.id}`；**`job.tasks` = 任务快照（含 `batchPrompt`）随 jobs 文件持久化**——断点续跑的根基 |

**会话兜底通道**

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `dispatchSessionTasks(job, tasks)` | index.js:1521-1555 | `agentsRef.get(sessionId)` 无 steer → fail「发起会话不可用…请从会话内重新提交编译」；任务文件写 `SESSION_TASK_DIR/<job.id>--<safe>.prompt.txt`；`snapshots{name, articlePath, promptFile, dispatchedAt}` 持久化；`agent.steer(buildSessionSteerText(...))` |
| `progressSessionTasks(job)` | index.js:1559-1578 | 逐任务 `classifySessionTask` 三态：`timeout` → 记失败；`harvest` → 读结果文件走 `writeValidated`（review 阶段 `replace:true`）；返回是否全部终态 |
| `resendSessionSteer(job)` | index.js:1582-1595 | 宿主重启接管时重发 steer（不重置 `dispatchedAt`） |

**阶段机 handler**（由 `STAGE_HANDLER`（index.js:1978-1985）分发：`plan/articles/crosscut/compose/review/index`）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `tickPlan(job)` | index.js:1599-1629 | 批次在 → `settleJob`；`parsePlan` 失败 → 降级 `localPlan(scanRepoFiles(...))`；无批次 → `scanRepoFiles`（无文件 → fail「仓库没有可编译的源码文件」）→ `batchPlannerPrompt` → `planTask`（`_plan`，keepInMemory）→ `submitBatchFor`；完成后 `setStage('articles')`。注释（index.js:1599-1600）：主模型规划已于 0.10.0 移除，全部环节统一插件内并发池 |
| `tickArticles(job)` | index.js:1634-1749 | 最重的阶段：批次在 → `settleJob` 收割；`#obs` 观察任务按文章聚合 → 合成任务（`customId` 去掉 `oN` 后缀加 `c`）→ `submitBatchFor`；观察全失败且无会话任务 → 跳过；无批次 → 组装文章任务：stale 用 `job.tasks` 预构建、full 用 `plan.modules` → `slugify` → `{name:'modules/<slug>.md', mission, sources, articlePath, prevArticlePath}` → `prepareArticleTasks` → 双通道分发（`dispatchSessionTasks` + `submitBatchFor`）；会话通道全部终态才推进；`writtenCount===0` → fail「全部文章任务失败（wiki 基线不变，可重新提交）」；→ `setStage(full?'crosscut':'review')` |
| `crosscutTasks(job, pack)` | index.js:1752-1771 | 横切任务组：`_architecture.md` / `_patterns.md` / `concepts/<slug>.md`，全部 keepInMemory |
| `tickCrosscut(job)` | index.js:1773-1836 | 批次在 → 收割；`crosscutSplit` 模式 → 收观察拼包 → `setStage('compose')` + `submitComposeBatch`；观察全失败 → 跳过横切；无批次 → 读成功文章全文，总 token ≤ 预算 → 单批直出（`packArticles`，装不下截头部并标注）；否则拆观察任务（`obs{i}`，name `_obs/<article>`）进合成 |
| `tickCompose(job)` | index.js:1839-1851 | 合成批次结算 + `tally`；断点丢失 → note「合成批次未落盘（上次进程中断于提交后落盘前），跳过横切进校对」；→ review |
| `submitComposeBatch(job, observationsText)` | index.js:1853-1863 | 提交合成批；失败降级 `setStage('review')`（文章已成功，横切合成失败不回滚） |
| `localReview(job)` | index.js:1866-1886 | 本地核对：文章文件丢失 → `ok=false` + `writtenCount--`；frontmatter 缺失 → `skipProofread`；`source_files` 缺失只记账；`skipProofread = srcs.length===0` |
| `tickReview(job)` | index.js:1888-1951 | 批次在 → `settleJob + tally(replace:true)`；无批次 → `localReview` 后对每篇 ok 文章装填源码（先 `BUDGET-articleTokens`，不够再 `HARD_LIMIT-articleTokens`，仍 oversized → 会话通道校对）→ `proof{i}` 任务；提交失败 → note「校对批次提交失败（跳过校对）」；全部终态 → index |
| `tickIndex(job)` | index.js:1953-1976 | `writtenCount>0` → `cw index` + `cw meta update`（120s）+ `normalizeIndexLinks` + `ensureWikiEntry`（任一非 0 退出只记 note 不失败）；否则 note「没有文章写成功，跳过 index/meta update（wiki 基线不变，可重新提交）」；→ `done` + `onSettled(job,'done')` |
| `tick()` | index.js:1987-2052 | 每 `TICK_MS` 一次的总驱动：重入守卫 + `acquireTickLock`；`syncCancelFlags`；`serialProjects` 闸门（活动任务优先、queued 轮转推进）；job owner 是异实例且停更超 `ORPHAN_TAKEOVER_MS` → 接管 + `resendSessionSteer`；`cancelRequested` → abort 中断在飞批次 + `setStage('cancelled')`；queued 任务轮到才按 `pendingStage` 入场（stale 恢复预构建任务）；handler 异常 → `fail`；终态持久化 |
| `submit({kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId})` | index.js:2054-2119 | 提交入口：`excludedItem` 命中直接 throw；`rememberRepo`；已有活动任务 → 返回 `{existed:true}`（幂等）；job id `job-<ts36>-<seq36>`、stage `submitting`；凭证校验（provider/model 为空 throw；`llmRef.stream` 非函数 → 「请重启宿主后重试」）；`credentialSource = llm(<provider>/<model>)`；`serialProjects` 且有其他活动 → `queued`；否则直接入场；persist + flush + `void tick()` |
| `cancel(jobId)` | index.js:2121-2130 | `mergeFromDisk` → 置 `cancelRequested` → flush（实际中断由下轮 tick 执行） |
| `list` / `findActive` | index.js:2132-2133 | 只读访问 |
| `start` / `stop` | index.js:2135-2143 | `setInterval(tick, TICK_MS)`（unref）/ 清定时器 |

### 三个编译侧工具定义（index.js:2153-2465）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `generateToolDefinition(cfg, svc)` | index.js:2153-2303 | 工具 `codewiki_generate`：参数 `cwd`（必填）+ `scope`（`auto/full/stale`）+ `language`。execute：enabled → `normalizeCwd` → `existsSync` → `excludedItem` throw → scope 白名单（默认 `auto`）→ `auto=args.auto`（内部自动扫描直调标记，不进 schema）→ `runCw status`（120s）→ `parseStatus` → `wikiPathFor` → 幂等检查 `findActive`（已存在则转移 sessionId 并直接返回）。判态分派：`stale` + wiki 不存在 → 升 full（note「scope=stale 但尚无 wiki，自动升为全量编译」）；`clean` 且非 full → 「Wiki is up to date —— 无需编译」；`stale` + `staleArticles` → 读每篇 `source_files` 预构建更新任务（mission 要求保留章节结构与 title/type/tags）→ `submit kind:'stale'`；`stale` 无 stale 但有 `changedFiles` → 只 `cw meta update`；`missing` → 先 `cw init`；否则 `submit kind:'full'` |
| `updateToolDefinition(cfg, generateDef)` | index.js:2312-2364 | 工具 `codewiki_update`：固定 `scope:'auto'` 复用 `generateDef.execute`，错误消息 `replaceAll('codewiki_generate','codewiki_update')` |
| `samePath(a, b)` | index.js:2372-2375 | 路径相等判断 |
| `progressView(job)` | index.js:2377-2381 | `taskList` done 占比 → `progress` |
| `progressToolDefinition(cfg, svc)` | index.js:2383-2465 | 工具 `codewiki_progress`：只读；`cwd`/`jobId` 可选过滤；output 为 `{jobs:[...]}` 数组；render 用 `✓ ✗ ·` 标记逐任务展示 + error + notes（尾部 3 条） |

### HTTP API（index.js:2471-2789）

`installWebServer(ctx, service, extra={config, schedState, compile})`（index.js:2569-2789）注册 5 个端点，全部先过 `isLoopbackRequest`（index.js:2471-2474，仅允许 127.0.0.1/::1/::ffff:127.0.0.1）；请求体经 `readBodyJson`（index.js:2482-2500，1MB 上限）；响应经 `writeJson`（index.js:2476-2480）。

| 端点 | 行号 | 说明 |
| --- | --- | --- |
| `GET /api/codewiki/jobs` | index.js:2879-2895 | loopback guard → `service.list` → 工作区过滤（见下）→ 200 `{now, jobs}`；错误 500 带 stack 前 8 行 |
| `GET /api/codewiki/repos` | index.js:2628-2707 | 30s 缓存（`reposCache` + 工作区签名 `wsSig`，工作区变化即失效）；cwd 去重合并（job 历史形态优先、`knownRepos` 补缺）；`workspaceOnly` 过滤；每 repo 跑 `cw status`（20s）+ `wikiPathFor` → `{cwd, excluded, lastJob, state, staleArticles, changedFiles, wikiPath, articleCount}`；附自动扫描调度器快照 `scheduler{enabled, intervalMin, lastScan, scanning, lastError, lastScanRepos, lastScanSubmitted}` |
| `GET /api/codewiki/models` | index.js:2507-2522 | 30s 缓存的 `listModelCatalog` |
| `GET /api/codewiki/model-efforts` | index.js:2742-2762 | `provider`+`model` query 必须；60s 缓存（key `provider\0model`）的 `resolveModelEfforts` |
| `POST /api/codewiki/control` | index.js:2121-2152 | 仅 POST；`action:'cancel'+jobId` → `service.cancel`；`'refresh'` → 清 repos 缓存；`'compile'+cwd` → `extra.compile({cwd, scope})`（即直调 `generateDef.execute`）；未知 action → 400 |

工作区过滤：`ctx.inject(['workspaceRegistry'])`（index.js:2578-2581，cordis 切片语义 `rc?.workspaceRegistry ?? rc`）+ `wsFilterPaths`（index.js:2585-2600，`workspaceOnly:false` → 不过滤；list 抛错降级为不过滤）。

模型目录导出：`export async function listModelCatalog(llm)`（index.js:2534-2555，`llm.listProviders` → `[{id,name,models}]`，单 provider 查询失败保留条目并附 `error`；llm 不可用 → `ok:false`）与 `export async function resolveModelEfforts(llm, provider, model)`（index.js:2545-2567，`resolveModelInfoOf` 优先 `llm.resolveModelInfo` 否则 `llm.resolveModel` → `reasoning.efforts` + `defaultEffort` + 上下文 token 数）。

### 提交提醒注入（index.js:2803-2874）

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `commitHintCache` | index.js:2803 | cwd → `{at, text}`，60s TTL |
| `commitHintText(cwd, jobs=loadJobs())` | index.js:2804-2829 | 找最近一个 `stage==='done'` 且 `writtenCount>0` 且 `samePath` 的任务的 `finishedAt`，与 `git log -1 --format=%ct -- .codewiki CodeWiki.md`（5s 超时）比较；编译晚于提交 → 返回提醒文本（编译完成 N 分钟前 / 任务 id / 写入 N 篇 / 只 add 两个路径、`docs(wiki)` 前缀 / 不要 `git add -A` / 提交后自动消失） |
| `reminderText(cwd)` | index.js:2831-2840 | 【CodeWiki 维护】固定 5 条（收尾必须调 `codewiki_generate` / 后台编译不要等待 / 绝对路径 / 随代码提交 / 未调用视为任务未完成） |
| `installUpdateReminder(ctx, config)` | index.js:2842-2874 | 给每个 agent 注入系统提示 section：`agent.ctx.inject(['systemPrompt'])` → `sp.section({name:'codewiki:update-reminder', order:getSectionOrder('TOOL_REPORT')+1, text})`——仅当该会话 cwd 存在 `CodeWiki.md` 且 `updateReminder` 开；`commitHintText` 有内容时拼在 `reminderText` 之后。`WeakSet` 防重复；对存量 agent 逐个补装 + `ctx.on('agent/created')` 监听新建 |

### apply 入口（index.js:2876-2935）

`export function apply(ctx, config)`（index.js:2876-2935）——插件唯一挂载点，装配顺序：

1. `ctx.inject(['agents','llm'])` → 赋 `agentsRef`/`llmRef`（index.js:2877-2878）。
2. `createJobService(config, wakeCompileSession)` + `service.start()`（index.js:2879-2880）；disposer 用 `ctx.effect(() => () => service.stop())`——**必须返回 disposer 本体**，写成 `ctx.effect(() => service.stop())` 会在装配当场把服务停掉（index.js:1252-1253 注释明确警告）。
3. `autoScan`（index.js:2890-2912）：`c.autoUpdate` 开且到点（`autoUpdateMin*60000`）时，对 `service.list` 去重的 cwd 逐个 `isExcluded` 跳过后调 `generateDef.execute({cwd, scope:'auto', auto:true}, {})`；失败截 200 字符记 `schedState.lastError`。
4. `scanTimer = setInterval(autoScan, 60000)`（unref，index.js:2913-2914）。
5. 注册 4 个工具 `[cwToolDefinition, generateDef, updateDef, progressDef]`（index.js:2917-2933）：逐个 `tools.register`，单工具 schema 违规只丢该工具（per-definition try/catch），disposer 经 `ctx.effect` 或 `ctx.on('dispose')`。
6. `installWebServer(ctx, service, {config, schedState, compile: (args, exec) => generateDef.execute(args, exec)})`（index.js:2933）。
7. `installUpdateReminder(ctx, config)`（index.js:2934）。

### client.js：浏览器半侧（client.js:1-1343）

加载方式 `window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory(require)})`（client.js:10），require `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（Switch/Button/Input/Tag，client.js:13-15）。导出 `{inject:['slots','locale','configForms'], apply(ctx)}`（client.js:13-15）。头部注释（client.js:13-20）明确三条纪律：设置读写走 `configForms` 命名空间 `'codewiki'`；挂载 id 必须等于 `package.json` 的 `name`；词典值必须是字符串（函数会导致 `t()` 回退键名）。

**常量**（client.js:23-34）：`NS='codewiki'`、`KEY='codewiki'`、`JOBS_PATH='/api/codewiki/jobs'`、`CONTROL_PATH='/api/codewiki/control'`、`PANEL_ORDER=52`（排在 dsh-hindsight-on-demand 的 50 之后）、`POLL_MS=2000`、`REPOS_PATH`/`MODELS_PATH`/`EFFORTS_PATH`（client.js:23-25）、`REPOS_POLL_MS=10000`、`ACTIVE_STAGES=['queued','plan','articles','crosscut','compose','review','index']`（queued 单列最前）。

**基础层**：`zh()`（client.js:307-444）/`en()`（client.js:307-444）完整词典；CSS 注入 `style`（client.js:307-387，`[data-dscw-*]` 选择器族：设置页 grid/hint、面板卡片、六阶段步骤条 `p-steps/p-dot`、吞吐徽标 `p-badge`、用量 `p-usage`、活动流），HMR 防重复（client.js:387，`querySelector('style[data-plugin="@local/dsh-codewiki"]')`）；`el(tag, props, ...children)`（client.js:307-309，`React.createElement` 薄包装）；`apiGet`/`apiPost`（client.js:393-408，fetch + JSON + 错误 `throw body.error || HTTP <status>`）；词典注册与 `tBound = ctx.locale.bind(NS)`（client.js:307-308）。

**挂载**（`apply` 内）：`form = ctx.configForms.get(NS)`（client.js:417）；设置卡挂 `plugins.item`（client.js:420-432，`register({name:'plugins.item', id:NS, order:30, ...}, CodewikiCard)`；宿主提供 `configForms.whileServed([NS], mount)` 时用它，命名空间停用即自动卸载）；面板挂 `slots.inject('main', ...)` + `slots.inject('sidebar.panellist', ...)`（client.js:435-446）。

**`CodewikiCard`（设置卡，client.js:452-842）**

- 视图状态：`view==='summary'` 时只渲染一行简介（client.js:498）；否则渲染完整设置表单。
- 数据层：`catalog` 拉取 `MODELS_PATH`（client.js:24-35，失败 `catalogError` 退化为手填输入框）；订阅 `form.getSnapshot()+subscribe`（client.js:24-41，`revision` 变化 → `setDraft(structuredClone(...))`）；`setPath`（client.js:500-507）；`dirty` 用 useMemo JSON 比对（client.js:509-512）；`selectedProvider`（client.js:515-519）；`effortsState` 拉 `EFFORTS_PATH?provider=&model=`（client.js:24-57）。
- `save`（client.js:663-685）：`maxConcurrency` 1–8 整数校验（`invalidConcurrency`）→ 18 个配置 key 逐一 diff → `form.mutate(ops, snapshot.revision)`（返回 false → 提示冲突）；`discard`（client.js:687-691）。
- 表单分四段：运行（client.js:700-764：enabled / updateReminder / workspaceOnly 三个 Switch + maxConcurrency Input + serialProjects Switch + articleLanguage Input + binaryPath Input）；编译模型（client.js:766-781：`batchProvider` 下拉（catalogError 时手填；切换 provider 清 `batchModel` 取第一模型并清 `batchReasoningEffort`；目录里没有的已配置 provider 保留 `__custom` 选项，client.js:588-593）+ `batchModel` 下拉/手填（本地自建模型常不在目录）+ `batchReasoningEffort` 档位下拉（有 efforts 时列档位并标注 `defaultEffort`，无 efforts 时仅「模型默认」并清值）+ `sessionTier` Input（placeholder `'default'`））；大档模型（client.js:783-798：`bigProvider`/`bigModel`/`bigReasoningEffort` 三件套 + `bigTokenBudget` Input）；调度与排除（client.js:800-832：autoUpdate Switch + autoUpdateMin Input + excludePaths textarea）。
- 保存条（client.js:834-840）：discard/save 按钮（save 在 `!dirty || !snapshot.writable` 时禁用）+ 错误横幅或成功 notice Tag。

**面板公共渲染函数**（client.js:848-978）：`stageLabel`/`stateLabel`/`kindLabelOf`（client.js:848-851，键名驼峰拼接）；`progressBar`（client.js:851-854）；`repoName`（client.js:855-858，取 cwd 末两段「父目录/目录名」，Temp 沙箱残留一眼可辨）；`fmtMs`/`fmtTok`/`fmtDur`/`fmtAgo`（client.js:859-881）；`Spark`（client.js:883-895，纯 SVG polyline 微趋势线）；`stepName`（client.js:899）；`stageBar`（client.js:904-926，六阶段步骤条：已完成绿点带阶段耗时、当前实心点 + `stageStartedAt` 实时计时、失败/取消在最后计时段标红/黄——`lastTimedStage` 取 `stageTimings` 最后一个键）；`STAGE_WEIGHTS` + `overallPct`（client.js:928-937，阶段定权 `{queued:0, plan:0.05, articles:0.6, crosscut:0.1, compose:0.05, review:0.15, index:0.05}`，阶段内按 taskList 完成数折算，封顶 99、done 才 100）；`throughputBadge`（client.js:940-960：实时通道 tok/s + Spark；批量通道篇/分（EWMA）+ ETA；无样本显示执行时长）；`usageLine`（client.js:962-978：输入为提交时估算、输出为响应实测、批量/实时通道拆分、`overTier2` 红字）。

**`ReposTab`（总览标签页，client.js:981-1124）**：轮询 `REPOS_PATH`（10s，`inFlightRef` 防重叠，client.js:989-1006）；`toggleExclude`（client.js:1011-1029：直接改 `excludePaths` 配置——`form.mutate` 与设置卡同链路持久化热生效，成功后 `apiPost control refresh` 失效服务端缓存并重拉）；`compile(cwd)`（client.js:1031-1039：`apiPost control {action:'compile', cwd}`）；调度器卡片（client.js:981-1008：enabled/间隔/scanning/lastScan/lastError/下次扫描 ≈ lastScan+interval + scanned/submitted 统计）；每 repo 一行（client.js:981-1023）：名称、excluded Tag、状态徽标（clean→done 色、stale→stale 色、error→failed 色、其余→cancelled 色）、stale 时「立即编译」按钮、排除/取消排除按钮、lastJob 摘要（kind/stage/auto 标记/上次编译相对时间/batchProgress n/n/tps）+ 进度条。

**`CodewikiPanel`（侧边栏面板，client.js:1126-1326）**：轮询 `JOBS_PATH`（2s，client.js:1126-1166）同时做**面板侧差分采样**——`tps>0` 推进滚动窗口（30 点上限，画 Spark）；`batchProgress.completed` 增加时算瞬时速率并 EWMA 平滑 `rate = prev.rate*0.6 + inst*0.4`（client.js:1126-1135）；`mountedRef` 防卸载后 setState（client.js:1182-1183）；`cancel`（client.js:1184-1192）；`copyPath`（client.js:1193-1199，剪贴板 + 1.5s 恢复）。任务列表按 cwd 分组（client.js:1126-1132，保持首现顺序、组内最新在前）；焦点任务 = 活动优先（新→旧）否则最近更新（client.js:1126-1129），其余收进「历史任务」折叠区。`jobCard`（client.js:1220-1278）组装：kind Tag、stage 徽标、吞吐徽标、取消按钮（`cancelRequested` 时显示「已请求取消」并禁用）、`stageBar`、meta 行（写入 n/m、失败数、批次 n/n、已耗时/总耗时）、总进度条、用量行、最后一条 note、活动流折叠（notes>1）、error、活动期任务清单（`✓ ✗ ·` + 文件名）、wikiPath 展示 + 复制按钮。渲染分三个 tab（client.js:1126-1157）：`overview` → ReposTab、`tasks` → 任务列表、`settings` → 内嵌 `CodewikiCard`；渲染构建期异常直接 `catch` 显形为「Panel error: <stack>」避免整块白屏（client.js:1321-1325）。

**`PanelIcon`**（client.js:1328-1339）：16×16「摊开的书」SVG 图标。

### package.json 与 cordis.patch.yml

`package.json`（1-28）：`name: "@local/dsh-codewiki"`、`version: "0.10.4"`、`private: true`、`type: "module"`、`main: "index.js"`、`exports: {".": "./index.js", "./client": "./client.js"}`、`engines: {node: ">=20", dsh: ">=0.2.0-rc.0"}`、唯一运行依赖 `@deepseek-ai/schemastery ^3.18.4`、`dsh.client.platform = "web"`（声明存在浏览器半侧）、`dsh.bundle.patch = "cordis.patch.yml"`。

`cordis.patch.yml`（1-19）：bundle 形式安装用 `- insert: [{id: codewiki, name: file:///E:/..., config:{}}]`；头部注释（cordis.patch.yml:1-13）说明本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂（URL 空格写 `%20`），两者 id 必须一致为 `codewiki`；注释同时是 18 个配置项的权威说明（`batchProvider` 必须是模型设置里已注册的 provider、留空=提交失败；`batchModel` 默认 hy3 免费 192k；`serialProjects` 单项目串行等）。注意 insert 里的 `file:///E:/...` 是**硬编码的本机路径**，bundle 分发时由安装器改写。

## Architecture

```text
┌─────────────────────────────── index.js（DSH 宿主，Node） ────────────────────────────────┐
│                                                                                          │
│  apply(ctx) 2876 ──注册──► 4 工具(cw/codewiki_generate/_update/_progress)                │
│      │                 ──► installWebServer 2569 (loopback HTTP ×5)                      │
│      │                 ──► installUpdateReminder 2842 (systemPrompt 注入)                │
│      ▼                                                                                   │
│  createJobService 1252 ══ tick 每 10s (TICK_MS 1050, 文件锁 1167) ══► STAGE_HANDLER 1978 │
│      │ submit 2054                                    plan→articles→crosscut→compose     │
│      ▼                                                →review→index→done/failed          │
│  ┌────────────────────┐   ┌─────────────────────┐   ┌──────────────────────────────┐    │
│  │ 实时通道：并发池     │   │ 会话兜底/大档通道      │   │ cw CLI（Rust，spawn）          │    │
│  │ runRealtimeTasks    │   │ dispatchSessionTasks │   │ runCw 125                    │    │
│  │ 327 ← llmChat 283   │   │ 1521 → steer 子智能体 │   │ status/init/index/meta/path  │    │
│  └─────────┬──────────┘   └──────────┬──────────┘   └──────────────┬───────────────┘    │
│            ▼                         ▼                             ▼                    │
│   writeValidated 1396 ◄── harvest 任务文件       .codewiki/（cw index 落盘 +             │
│   (fixAnchors 396 → 写文件)                      normalizeIndexLinks 166）               │
└──────────────────────────────────┬───────────────────────────────────────────────────────┘
                                   │ HTTP /api/codewiki/*（仅 127.0.0.1）
┌──────────────────────────────────▼───────────────────────────────────────────────────────┐
│ client.js（DSH Web 浏览器）                                                                │
│  CodewikiCard 452（plugins.item 设置卡，configForms 'codewiki'）                           │
│  CodewikiPanel 1126（侧边栏：ReposTab 981 总览 / 任务列表 / 内嵌设置）                       │
│  轮询 jobs 2s（差分采样 tps/EWMA）· repos 10s · control（取消/刷新/编译）                    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

层次关系：`apply` 装配一切 → `createJobService` 持有全部编译状态与阶段机 → 阶段 handler 只做「装填 + 提交 + 结算」，真正的 LLM 执行收敛到两条通道，CLI 操作收敛到 `runCw`。浏览器半侧与宿主之间只通过 5 个 loopback HTTP 端点通信，无直接进程耦合。

## Data Flow

以一次 `codewiki_generate({cwd, scope:'full'})` 为例（增量 stale 流程在括号内注明差异）：

1. **判态与提交**（index.js:176-265）：`cw status` → `parseStatus` → 无活动任务（幂等）→ `svc.submit({kind:'full', cwd, sessionId})`（index.js:2054）。stale 时由工具预构建文章更新任务作为 `prebuiltTasks` 传入，跳过规划。
2. **入场**（index.js:1999-2064）：排除检查 → 幂等 → 建 job（`submitting`）→ 凭证校验 → `serialProjects` 决定立即入场或 `queued` → persist + `void tick()`。
3. **plan**（index.js:1134-1164）：`scanRepoFiles`（≤2000 文件、≤256KB）→ `batchPlannerPrompt` → 并发池单请求产出 JSON 计划 → `parsePlan` 校验（失败降级 `localPlan`）→ `setStage('articles')`。
4. **articles**（index.js:555-670）：按 `plan.modules` 组装任务 → `prepareArticleTasks`（index.js:555-664）按 token 预算装填/分批：
   - 正常批 → `submitBatchFor` → 并发池（默认 2 路并发）`batchArticlePrompt` 直出文章；
   - 超预算批 → 先拆观察任务（`batchArticleObservePrompt`，`#obs` 后缀）→ 收齐后合成（`batchArticleComposePrompt`，customId 加 `c` 后缀）；
   - 单文件连 128k 硬限都装不下 → 若配置了 `bigProvider` 则走大档通道（`markBig`，用 `volces-ark/glm-5.3-flash` 在插件内写完）；否则 `dispatchSessionTasks` 写 Temp 任务文件 → `agent.steer` 派给发起会话的子智能体，结果文件由 `progressSessionTasks` 按 `classifySessionTask` 三态收割。
   - 所有 keepInMemory 产出统一经 `writeValidated`（校验 `---` frontmatter + `fixAnchors` 修行号）落盘到 `<wikiPath>/modules/<slug>.md`。`writtenCount===0` → 整个 job 失败（wiki 基线不变）。
5. **crosscut**（index.js:1773-1836）：读成功文章全文；总 token ≤ 预算 → 单批直出 `_architecture.md`/`_patterns.md`/`concepts/*.md`；否则拆观察 → **compose**（index.js:1839-1851）合成。合成批断点丢失只记 note 不回滚。
6. **review**（index.js:1866-1929）：`localReview` 本地核对（文件存在性、frontmatter、source_files 记账）→ 每篇 ok 文章重装源码 → `batchProofreadPrompt` 审校批 → `tally(replace:true)` 覆盖（审校失败不推翻已写原文）。
7. **index**（index.js:166-189）：`cw index` → `cw meta update`（记录编译基线 commit）→ `normalizeIndexLinks` → `ensureWikiEntry` → `setStage('done')` → `wakeCompileSession` 回唤发起会话「【CodeWiki 编译完成·请提交改动】」（只 add `.codewiki/` 与 `CodeWiki.md`，`docs(wiki)` 前缀提交）。
8. **收尾提醒闭环**：此后任意会话在该仓库工作时，`installUpdateReminder` 注入的系统提示 section 会用 `commitHintText`（index.js:2804-2829）对比「编译完成时间 vs 最后一次 wiki 提交时间」，未提交就在系统提示里持续提醒，提交后自动消失。

**可靠性机制贯穿全程**：任务 prompt 快照随 jobs 文件持久化（`submitBatchFor`，index.js:1487）→ 宿主重启后 `settleJob` 按快照重跑在飞批次、异实例 owner 超 5 分钟停更被接管（`ORPHAN_TAKEOVER_MS` + `resendSessionSteer`）；取消经 `cancelRequested` 标志位由下一轮 tick 统一执行（abort 在飞批次 + 清结果）。

## Connections

- 宿主服务依赖（非 wiki 链接，属于 DSH 运行时）：`ctx.inject(['agents'])`（子智能体注册表，会话通道 steer 与回唤）、`ctx.inject(['llm'])`（模型调用与模型目录）、`ctx.inject(['configForms'])`（client.js 设置持久化，命名空间 `codewiki`）、`ctx.inject(['slots'])`/`locale`（client.js 挂载与国际化）、`ctx.inject(['workspaceRegistry'])`（index.js:2578，workspaceOnly 过滤）、`ctx.inject(['systemPrompt'])`（提醒注入）。
- 外部 CLI：`cw`（mraza007/codewiki，Rust）——所有 wiki 元操作（`init/status/index/meta/path`）都经 `runCw`（index.js:125-150）完成，wiki 产物目录由 `cw path` 决定（`wikiPathFor`，index.js:1027-1032）。
- 同一 wiki 的其他文章：本文是全部模块的宿主与调度者；横切文章固定产出 [[_architecture]] 与 [[_patterns]]，概念文章落在 `concepts/`（`crosscutTasks`，index.js:1752-1771）；各代码模块文章见 [[CodeWiki]]（仓库根入口）。

## Known Issues

1. **`ctx.effect` disposer 写法陷阱**：`apply` 中必须写 `ctx.effect(() => () => service.stop())`（index.js:2882-2883）；若写成 `ctx.effect(() => service.stop())`，箭头函数返回值是 `stop()` 的返回值而非 disposer，服务会在装配当场被停掉。源码注释明确警告了这一点。
2. **cordis.patch.yml 硬编码本机路径**：insert 的 `name` 是 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`（cordis.patch.yml:15），仅对本机 bundle 安装有效；换机器需改写，或走本地 profiles 直挂。
3. **`estimateTokens` 是启发式**（index.js:267-275）：CJK 每字 1 token、其余 3.5 字符/token 的粗估；分批/分割判定与 `overTier2` 计数都基于它，与真实 tokenizer 有偏差，故界面把「输入 token」明确标注为估算、仅「输出 token」是实测（client.js:977-993）。
4. **`fixAnchors` 保守放弃**：符号全文多处命中且声明形态不唯一、或根本找不到符号时，锚点保持 LLM 原样（unresolved，index.js:396-479）——文章里因此可能残留偏移行号；这属于设计取舍（宁可不改也不改错）。
5. **规划已无主模型参与**：0.10.0 起主模型规划被移除（index.js:1631-1632 注释），全部环节走插件内并发池——若上游 prompt 质量不足，计划质量完全取决于 `batchProvider/batchModel` 所配模型。
6. **会话兜底通道依赖发起会话存活**：`dispatchSessionTasks` 要求 `agentsRef.get(job.sessionId)` 的 agent 有 `steer`，否则直接 fail「发起会话不可用…请从会话内重新提交编译」（index.js:1521-1555）；会话关闭后挂起的会话通道任务只能等 `SESSION_TASK_TIMEOUT_MS`（默认 30 分钟）超时记失败。
7. **jobs 文件是单点共享状态**：多宿主实例靠 `JOBS_FILE.lock`（60s 陈锁强删，index.js:1049-1064）+ `instanceId` owner 检查协调（index.js:1049-1849）；锁目录在 `os.tmpdir()`，极端情况下（tmp 清理竞争）可能出现双 tick，靠 tick 内 `ticking` 重入守卫兜底。
8. **HTTP 端点仅限 loopback**：`isLoopbackRequest`（index.js:2471-2474）拒绝非 127.0.0.1/::1 请求——面板在远程浏览器场景不可用，这是有意为之的安全边界，不是 bug。
9. **大档通道需显式配置**：`bigProvider` 默认已为 `volces-ark`（index.js:369-388），若用户清空则超大文件直接走会话兜底而非插件内大档；`bigTokenBudget` 须大于 `BATCH_TOKEN_BUDGET`（110000）且不超过模型上下文窗口扣除输出后的空间（index.js:555-664 装填逻辑）。