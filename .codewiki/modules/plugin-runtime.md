---
title: dsh-codewiki
type: module
source_files:
  - index.js
  - client.js
  - package.json
tags: [codewiki, plugin, pipeline, llm, job-service, web-ui]
---

## Overview

dsh-codewiki 是一个 DeepSeek Harness（DSH）插件（`@local/dsh-codewiki` v0.10.4，package.json:2-3），把 mraza007/codewiki 的 Rust CLI `cw` 接入宿主，并在其上叠加一条自研的「零子代理、服务化、分批 LLM」全仓库 wiki 编译流水线。模块由两个半侧组成：

- **index.js（2935 行，宿主侧入口）**：配置 schema（18 键，index.js:48-67）、`cw` CLI 进程包装（index.js:103-259）、四个工具注册（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`，index.js:906-969、2153-2303、2312-2364、2383-2465）、六阶段编译任务服务（规划 plan → 文章 articles → 横切 crosscut → 合成 compose → 校对 review → 索引 index，index.js:1252-2146）、loopback HTTP API（5 端点，index.js:2569-2789）、系统提示级 wiki 维护提醒（index.js:2842-2874）。
- **client.js（1343 行，Web 客户端）**：插件页设置卡（18 项配置的可视编辑，经宿主 configForms 持久化，client.js:452-842）+ 侧边栏面板（编译任务进度、取消、仓库总览、吞吐徽标与趋势线，client.js:1126-1326）。
- **package.json**：ESM（`"type": "module"`，package.json:8），`"main": "index.js"`，`exports` 暴露 `./index.js` 与 `./client.js`（package.json:8-12），engines `node>=20` / `dsh>=0.2.0-rc.0`（package.json:8-11），唯一运行时依赖 `@deepseek-ai/schemastery ^3.18.4`（package.json:8-10），`dsh.client.platform: "web"`、`dsh.bundle.patch: "cordis.patch.yml"`（package.json:8-15）。

默认批量编译模型 `workbuddy/hy3`（192k 上下文，index.js:26-27），单请求输入预算 `BATCH_TOKEN_BUDGET = 110000` token（index.js:369），硬上限 `BATCH_TOKEN_HARD_LIMIT = 128000`（index.js:374）；大档模型默认 `volces-ark/glm-5.3-flash`（512k 上下文，index.js:30-31），大档输入预算 `DEFAULT_BIG_TOKEN_BUDGET = 420000`（index.js:33）。LLM 并发默认 2、硬上限 8（index.js:22-24）；同一项目同时只推进一个编译任务（`serialProjects` 默认 true，index.js:60）。整个流水线**零子代理**：批量阶段直接调 LLM（宿主 llm 服务通道，由 `batchProvider`/`batchModel` 指定，index.js:283-302），仅当单文件/单文章连大档预算都装不下时才回落到「会话通道」——steer 发起编译的会话，由该会话自行 delegate 处理（index.js:1521-1555）。

## Key Components

### 常量与配置（index.js:17-97）

| 名称 | 行号 | 用途 |
|---|---|---|
| `pluginDir` | index.js:17 | `path.dirname(fileURLToPath(import.meta.url))`，插件目录绝对路径（定位捆绑的 `bin/cw(.exe)`） |
| `PLUGIN_NAME = 'dsh-codewiki'` | index.js:18 | 插件名常量 |
| `export const name = PLUGIN_NAME` | index.js:19 | 宿主注册名；客户端加载 id 与之保持一致（client.js:11） |
| `CW_SUBCOMMANDS` | index.js:20 | `cw` 工具允许的子命令白名单：`init` / `status` / `index` / `meta` / `path` / `projects` / `setup` / `uninstall` |
| `CONCURRENCY_HARD_CAP = 8` | index.js:22 | LLM 并发硬上限 |
| `DEFAULT_CONCURRENCY = 2` | index.js:24 | LLM 并发默认值 |
| `DEFAULT_BATCH_PROVIDER = 'workbuddy'` | index.js:26 | 默认批量 provider（走宿主 llm 服务） |
| `DEFAULT_BATCH_MODEL = 'hy3'` | index.js:27 | 默认批量模型 |
| `DEFAULT_BIG_PROVIDER = 'volces-ark'` | index.js:30 | 默认大档 provider |
| `DEFAULT_BIG_MODEL = 'glm-5.3-flash'` | index.js:31 | 默认大档模型（512k 上下文） |
| `DEFAULT_BIG_TOKEN_BUDGET = 420000` | index.js:33 | 大档单请求输入预算 |
| `normalizeCwd(cwd)` | index.js:37-42 | 仅 win32 把 `/e/...`（MSYS/Git-Bash 风格盘符）规整为 `E:/...`；POSIX 原样返回 |
| `Config` | index.js:48-67 | z.object 18 键，全部 `.volatile()`（改后热生效） |
| `val(x)` | index.js:69-71 | 兼容 schemastery 对象与裸值：有 `.get()` 就调用，否则原样返回 |
| `liveConfig(config)` | index.js:73-97 | 每次调用都重读取值并钳制：`maxConcurrency` 有效且 ≥1 时钳到 1..8 否则回落 2（index.js:87-89）、`autoUpdateMin` ≥5（index.js:94）、`batchModel`/`articleLanguage` 空值回落默认 |

`Config` 的 18 个键（index.js:48-67，括号内为默认值）：`enabled`（true）、`binaryPath`（''）、`batchProvider`（workbuddy）、`batchModel`（hy3）、`batchReasoningEffort`（''）、`bigProvider`（volces-ark）、`bigModel`（glm-5.3-flash）、`bigReasoningEffort`（''）、`bigTokenBudget`（420000）、`sessionTier`（''）、`maxConcurrency`（2）、`serialProjects`（true）、`articleLanguage`（中文）、`updateReminder`（true）、`excludePaths`（''）、`autoUpdate`（false）、`autoUpdateMin`（30）、`workspaceOnly`（true）。键语义：`batchProvider` 留空 = 提交时直接报错（不再有百炼兼容直连通道，index.js:48-57）；非空 = 走宿主 llm 服务（batchModel 填该 provider 的模型 id）；`bigProvider` 留空 = 关闭大档，超大输入退回会话通道兜底；`sessionTier` 是会话兜底通道的 delegate 档位 id（index.js:58、1078-1096）。

### cw CLI 包装（index.js:103-259）

- `resolveBinary(cfg)`（index.js:103-123）：优先 `binaryPath` → win32 `where cw` / POSIX `which cw` 探测 PATH → 捆绑 `pluginDir/bin/cw(.exe)` → 兜底返回 `'cw'`（让后续 spawn 报错）。
- `runCw(binary, cwd, args, timeoutMs=120000, signal)`（index.js:125-150）：spawn 执行，超时/abort 用 SIGKILL；resolve `{exitCode, stdout, stderr, timedOut}`——不抛错，退出码语义由调用方处理。
- `normalizeArticlePath(p)`（index.js:162）：反斜杠统一为斜杠。
- `normalizeIndexLinks(cwd)`（index.js:166-174）：读 `.codewiki/_index.md`，只把 Obsidian 链接头部 `[[link|` 中的 `\` 规范为 `/` 后写回；文件不存在静默跳过。
- `parseStatus(stdout)`（index.js:176-189）：解析 `cw status` 输出——`'No wiki found'`→`missing`；`'has not been compiled yet'`→`uncompiled`；`'Wiki is up to date'`→`clean`；否则按 `/\s+[M!]\s+(.+)/gm` 逐行收集：`M` 行→`changedFiles`、`!` 行→`staleArticles`，非空即→`stale`。
- `countWikiArticles(wikiPath)`（index.js:192-204）：递归数 wiki 目录下 `.md` 文章数，异常返回 null。
- `ensureWikiEntry(cwd, language='中文')`（index.js:209-242）：仓库根缺 `CodeWiki.md` 时按语言生成入门模板（中/英两版文案），已有入口不覆盖；返回是否创建。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`（index.js:247-259）：`excludePaths` 按换行/分号/逗号（含中文逗号）拆分为绝对路径清单，normalize+小写+去尾斜杠比对；`cwd` 等于某项或位于其子树 → 返回命中项原文（用于报错提示），否则 null；布尔包装为 `isExcluded`。

### LLM 通道（index.js:267-356）

- `estimateTokens(text)`（index.js:267-275）：CJK（0x4e00-0x9fff、0x3000-0x303f、0xff00-0xffef 三个区段）每字 1 token，其余按 3.5 字符/token——`cjk + Math.ceil((len - cjk) / 3.5)`。所有 prompt 预算判断都用它。
- `llmChat({llm, provider, model, reasoningEffort, prompt, signal})`（index.js:283-302）：走宿主 `llm.stream()`，BlockAssembler 收流式增量；`finish.kind` 为 `error`/`aborted` 抛错；返回 `{content, outputTokens}`。`batchProvider` 非空时的唯一通道。
- `applyTaskResult(task, content, notes)`（index.js:306-319）：`keepInMemory` 任务把结果留在内存（交由 `tally` 经落盘闸门处理）；否则 mkdir + `fixAnchors` 修正行号锚点（fixed/unresolved 记入 notes）后 `writeFileSync(articlePath)`。
- `runRealtimeTasks(tasks, {model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider})`（index.js:327-356）：固定并发池 worker 循环（`cursor++` 领任务）；走 `llmChat`；成功 `applyTaskResult`，失败记入 notes 与结果（不重试）；每任务完成回调 `onTaskDone({outputTokens, durationMs})`；返回 `Map(customId → result)`。

### 装填预算与行号锚点修正（index.js:369-511）

- `BATCH_TOKEN_BUDGET = 110000`（index.js:369，hy3 192k 上下文按输入侧预算再扣余量）、`BATCH_TOKEN_HARD_LIMIT = 128000`（index.js:374，普通档硬上限，旧版 150k 已修正）。
- `readJsonFile(p)`（index.js:378-380，JSON.parse 失败返回 null）。
- `numberLines(content)`（index.js:385-387，每行加 `N| ` 前缀——任务文件里的源码行号标注就是它生成的；文章行号引用一律以此为准）。
- `fixAnchors(content, cwd)`（index.js:396-479）：文章落盘前的**行号锚点自动修正**。解析 frontmatter `source_files`；`resolveFile` 支持相对路径与唯一 basename 匹配；`symbolsOnLine` 从反引号行内代码提取符号（点分名、长度 ≥3）；锚点正则 `/([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g`。对每个锚点：起点行已含该符号则不动；否则全文找符号——恰好一处→修正行号；多处→defRe（`function`/`class` 直接跟符号、`const`/`let` 后跟 `=`）唯一→修正；歧义或找不到→记 unresolved 不动；区间尾越界钳到文件尾；只改行号数字，不动文件名。
- `collectSources(cwd, files, budget=BATCH_TOKEN_BUDGET)`（index.js:484-511）：整文件装填（`### rel` 标题 + 围栏内 `numberLines` 行号源码）；装不下的文件记入 skipped 并在文末显式标注「不得涉及」；第一个文件就超 budget → `oversized: true`。

### Prompt 构建（index.js:515-900）

- `batchArticlePrompt({language, mission, sourcesText, prevArticle})`（index.js:515-542）：模块文章任务——指令 + 内联源码 + 可选旧文（要求沿用结构但行号一律重标）+「只输出文章本身」+ `articleFormatSection()`。
- `prepareArticleTasks(tasks, {cwd, language, bigProvider, bigModel, bigReasoningEffort, bigBudget})`（index.js:555-669）：文章任务的装填管线——`collectSources` 标准装填；超预算的 tooBig 任务先按大档预算（若启用）再装一次，否则按 HARD_LIMIT 装；prompt 估算仍超预算或有 skipped → 拆成**观察批**（单文件按 singleLimit 上限装填、批内按 BATCH_TOKEN_BUDGET 合并）生成 `#obs` 任务（`keepInMemory`，带 `splitFor` 与 `composePlan`）；单文件连大档都装不下 → 转会话兜底通道；其余直接生成 `batchPrompt`，`customId` 分配。
- `articleFormatSection()`（index.js:675-704）：文章格式规范——frontmatter(title/type:module/source_files/tags) + `## Overview / Key Components / Architecture / Data Flow / Connections / Known Issues`；Key Components 列全部公开函数/类/常量行号用途；行号以源码「行号| 」前缀为准；Architecture ≥3 组件画 UTF-8 box-drawing 框图（≤20 行）；Connections 用 Obsidian [[backlinks]]；写给零上下文的未来 agent。（本篇文章即由它规定。）
- `batchPlannerPrompt(fileLines)`（index.js:708-727）：规划输出纯 JSON `{project, modules:[{name, summary, files}], concepts:[{name, files}]}`；模块 3-8 文件；kebab-case。
- `localPlan(files)`（index.js:730-743）：LLM 规划失败时的本地兜底——按顶层目录分组。
- `packArticles(articles, budget)`（index.js:747-766）：横切输入装填；超预算截头部（到 `## Key Components` 前）并标注「超预算，仅头部」。
- `crosscutIntro(...)` + `batchArchitecturePrompt` / `batchPatternsPrompt` / `batchConceptPrompt`（index.js:768-804）：三篇横切产物——`_architecture.md`（type:architecture，三张 box-drawing 图）、`_patterns.md`（type:pattern，每模式一节给出处）、`concepts/<name>.md`（type:concept）。
- `batchObservePrompt(language, moduleName, articleText)`（index.js:808-825）：横切 map 阶段的模块观察（职责/接口/依赖方向/模式风险）——刻意不带 frontmatter。
- `batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal)`（index.js:829-845）：文章分割观察——保留全部函数/类/导出名、常量默认值、关键行号，「宁全勿简」，禁止贴大段源码。
- `batchArticleComposePrompt({language, mission, moduleName, observationsText, prevArticle})`（index.js:849-877）：把观察批合成为完整文章——沿用观察中的 `文件:行号`，source_files 汇总各批观察。
- `batchProofreadPrompt({language, articleText, sourcesText})`（index.js:881-900）：校对——核对 frontmatter、抽查函数/类名与行号、补 source_files、改写不符段落；一致时原样输出全文。

### 工具定义（index.js:906-969、2153-2465）

- `cwToolDefinition(cfg)`（index.js:906-969）：工具 `cw`——参数 `{cwd, args[]}`（均 required），`args` 子命令白名单校验（CW_SUBCOMMANDS）；output schema `{cwd, command, exitCode, stdout, stderr, timedOut}`；execute：enabled → normalizeCwd → existsSync → 非空 argv → 白名单 → resolveBinary → `runCw`（120s）。只透传 CLI，不涉及流水线。
- `generateToolDefinition(cfg, svc)`（index.js:2153-2303）：工具 `codewiki_generate`——**提交制**（调用即入队、立即返回）；parameters `{cwd(required), scope: auto|full|stale, language}`；output `{cwd, scope, wikiPath, state, jobId, stage, submitted, notes}`。execute 流程：enabled/svc/cwd/excluded 检查 → `runCw status` → `parseStatus` → `wikiPathFor` → 幂等（`svc.findActive(cwd)` 命中返回现有任务，并把 `sessionId` 更新为当前会话以拿唤醒权）→ scope 修正（stale 但 wiki missing/uncompiled 升级为 full）→ `clean` 且非 full 直接返回「无需编译」→ stale + staleArticles 逐篇预构建任务（`readSourceFiles` 为空则跳过记 note）`submit(kind='stale', prebuiltTasks)` → stale 无 staleArticles 但 changedFiles 有 → 只 `cw meta update` 刷新基线后返回 → missing → `cw init` → `submit(kind='full')`。`args.auto === true` 是内部直调标记（自动巡检调度器使用），schema 不暴露。
- `updateToolDefinition(cfg, generateDef)`（index.js:2312-2364）：工具 `codewiki_update`——固定 `scope=auto` 语义的快捷入口，execute 直接转调 `generateDef.execute({...args, scope:'auto'}, exec)`；错误消息里 `codewiki_generate` 字样替换为 `codewiki_update`。
- `samePath(a, b)`（index.js:2372-2375，normalize+去尾斜杠+lowercase 相等）、`progressView(job)`（index.js:2377-2381，taskList 完成比 → progress%）、`progressToolDefinition(cfg, svc)`（index.js:2383-2465）：工具 `codewiki_progress`——只读查询，参数 `{cwd?, jobId?}` 可选过滤。

### 规划解析与文章读取辅助（index.js:975-1032）

- `slugify(name)`（index.js:975-977）：小写 + 非 `[a-z0-9-_]`→`-` + 去首尾；空 → `'module'`。
- `parsePlan(text)`（index.js:979-999）：剥 ```json 围栏、`indexOf('{')..lastIndexOf('}')` 截取、JSON.parse；modules 过滤（name 为 string 且 files 数组非空）；concepts 默认 []。
- `parseSourceFiles(fm)`（index.js:1003-1015）：frontmatter `source_files` 解析，支持 inline `[a, b]` 与 block 列表两式。
- `readSourceFiles(articlePath)`（index.js:1017-1025）：读文章 frontmatter 的 source_files。
- `wikiPathFor(cwd, binary, signal)`（index.js:1027-1032）：`cw path` 输出最后一行；失败 → `path.join(cwd, '.codewiki')`。

### 任务持久化与会话通道（index.js:1049-1117）

- 环境常量：`JOBS_FILE = env DSH_CODEWIKI_JOBS_FILE || os.tmpdir()/dsh-codewiki-jobs.json`（index.js:1055）；`TICK_MS = max(250, env DSH_CODEWIKI_TICK_MS || 10000)`（index.js:1055）；`SESSION_TASK_TIMEOUT_MS = max(5min, env || 30min)`（index.js:1055）；`SESSION_TASK_DIR`（index.js:1055，与 JOBS_FILE 同目录的 `dsh-codewiki-session-tasks`）。
- `classifySessionTask(task, nowMs)`（index.js:1061-1071）：会话通道任务三态——`'timeout'`（超 SESSION_TASK_TIMEOUT_MS）；`'harvest'`（articlePath mtime ≥ dispatchedAt 且内容以 `---` 开头）；`'wait'`。
- `buildSessionSteerText({job, snapshots, tier='', resend})`（index.js:1078-1096）：会话通道 steer 文本——review 阶段 = 校对任务；`tier` 非空时要求 delegate 显式传 `tier` 与 `mode spec`（不传 tier 时自动选路会把任务判给 default 档）。
- `ORPHAN_TAKEOVER_MS = max(60s, env || 5min)`（index.js:1098）：他实例孤儿任务接管阈值；`MAX_JOBS_KEPT = 30`（index.js:1099）：落盘任务数上限。
- `REPOS_FILE`（index.js:1104）+ `loadKnownRepos()` / `rememberRepo(cwd)`：已知仓库持久登记（normalize+lowercase 去重），任务历史被截断后总览仍可见。
- `JOB_TERMINAL = new Set(['done','failed','cancelled'])`（index.js:1117）。

### 仓库扫描与任务存储（index.js:1120-1225）

- 扫描黑名单（index.js:1120-1132）：`SCAN_SKIP_DIRS`（.git / .codewiki / node_modules / vendor / dist / build / out / target / .next / __pycache__ / .venv / venv / .idea / .vscode / bin / obj / .gradle / Pods / coverage / .nyc_output / tmp / logs）、`SCAN_SKIP_EXT`（图片/压缩/二进制/媒体/db/wasm 等）、`SCAN_MAX_FILE_BYTES = 256KB`（index.js:1120）、`SCAN_MAX_FILES = 2000`（index.js:1120）。
- `scanRepoFiles(cwd)`（index.js:1134-1157）：递归 walk，跳黑名单目录/点开头目录/黑名单后缀/0 字节与超 256KB 文件；返回 `[{path, bytes}]`。
- `loadJobs()`（index.js:1159-1162）+ `JOBS_LOCK_FILE` + `acquireTickLock()` / `releaseTickLock()`（index.js:1164-1182）：tick 跨进程互斥——wx 独占写 pid，60s 过期强删。
- `saveJobs(jobs)`（index.js:1184-1189）：截最近 30 个落盘（`cancelRequested` 必须落盘，跨进程取消才生效）。
- `jobSummary(job)`（index.js:1191-1225）：面板视图投影——taskList（已结算在前 pending 在后）、batchProgress、stageTimings、usage、notes（截尾 8 条）、error、时间戳、`tps`（总 token / 总 ms ×10，四舍五入 1 位）。

### 任务服务 createJobService（index.js:1252-2146）

模块级引用（index.js:1232-1250）：`agentsRef` / `llmRef` 在 `apply` 时经 `ctx.inject` 赋值——cordis 语义下直接访问 `ctx.llm` 会抛错，必须 inject。`wakeCompileSession(job, outcome)`（index.js:1239-1250）：任务终态时 steer 发起会话（完成「CodeWiki 编译完成·请提交改动」/ 失败提示；无 agent 静默跳过）。

服务闭包内部方法：

- 状态与记账：`instanceId = svc-<Date.now(36)>-<rand(36)>`（tick 只推进本实例 owner 的任务，index.js:1284）；Temp 沙箱终态任务启动即移除（index.js:1284-1295）；`mergeFromDisk()` 吸收他实例新增/磁盘更新的任务（index.js:1284-1305）；`dirty`/`persist`/`touch`/`note(≤50 条)`（index.js:1307-1318）；`setStage(job, stage)` 累计 `stageTimings` 与 `stageStartedAt`（index.js:1321-1331）；`addUsage(...)` 累计 inputTok/outputTok/requests/batch/realtime/overTier2（index.js:1333-1342）；`syncCancelFlags()` 每 tick 从磁盘拾取他实例的取消请求（index.js:1346-1357）；`fail(job, msg)`（非 submitting 才回调 onSettled，index.js:1359-1367）。
- `settleJob(job)`（index.js:1370-1391）：批量结果结算——`batchResults` 有 → 返回结果；`batchRuns` 在跑 → null；执行器丢失（宿主重启）→ 按 `job.tasks` 持久化的 `batchPrompt` 快照重跑本阶段（幂等恢复）；缺快照 → fail。
- `writeValidated(job, task, content)`（index.js:1396-1412）：落盘闸门——内容必须以 `---` frontmatter 开头，否则记 `invalid` 不落盘；通过后 `fixAnchors` + mkdir + `writeFileSync`。
- `tally(job, results, tasks, {replace})`（index.js:1415-1436）：keepInMemory + ok → writeValidated；`replace`（review 阶段）覆盖同名条目且校对失败不推翻原文；否则 push，ok→writtenCount++ / 否则 failedCount++。
- 批量执行器（index.js:1442-1485）：`batchRuns` / `batchResults` / `batchAborters` 三个 Map；`startBatchChatRun(job, prepared)` 用 AbortController 跑 `runRealtimeTasks`（走 llmChat；`onTaskDone` 更新 batchProgress / tpsSamples 截尾 20 / addUsage）；`submitBatchFor(job, prepared)` 统计 tier2 请求数（估算超 110k 的任务数）、记账、写 `job.tasks` 快照（宿主重启恢复的唯一依据，观察/合成任务带 `splitFor`/`composePlan`、大档任务带 provider/model，index.js:1487-1513）并启动执行。
- 会话通道（index.js:1521-1595）：`dispatchSessionTasks(job, tasks)` 写任务文件（`SESSION_TASK_DIR/${job.id}--${safe}.prompt.txt`，name 经 `[^\w.-]` 消毒）+ `agent.steer(buildSessionSteerText(...))`；`progressSessionTasks(job)` 逐任务 `classifySessionTask`（timeout 记失败 / harvest `writeValidated` 落盘 / wait 留守），结果交 `tally`（replace 仅 review 阶段）；`resendSessionSteer(job)` 宿主重启接管后幂等重发 steer（不重置 dispatchedAt）。
- 六阶段处理器：`tickPlan`（index.js:1599-1629，scanRepoFiles → batchPlannerPrompt → parsePlan，失败降级 localPlan）、`tickArticles`（index.js:1634-1749，组装/装填/批量执行/观察批聚合合成，writtenCount===0 → fail）、`crosscutTasks`（index.js:1752-1771，构造 _architecture/_patterns/concepts 任务）+ `tickCrosscut`（index.js:1773-1836，全文 ≤110k 单批直出否则逐篇观察再合成）、`tickCompose`（index.js:1839-1851，合成批结算；中断恢复时记 note 跳过横切进 review；`submitComposeBatch` 失败降级 review）、`localReview`（index.js:1866-1886）+ `tickReview`（index.js:1888-1951，静态检查 + 逐文章装填源码校对，装不下转会话通道）、`tickIndex`（index.js:1953-1976，`runCw ['index']` + `['meta','update']` + normalizeIndexLinks + ensureWikiEntry → done）。`STAGE_HANDLER` 映射（index.js:1978-1985）。
- `tick()`（index.js:1987-2052）：重入保护 + `acquireTickLock` + `syncCancelFlags`；`serialProjects` 串行闸门（同一时刻只推进一个活动任务，其余 queued 排队）；他实例 owner 停更 ≤ ORPHAN_TAKEOVER_MS 跳过、超时接管（owner 改写 + sessionTasks 重发 steer）；`cancelRequested` → 终态 cancelled + abort 在飞请求 + 丢弃结果；`queued` 且轮到 → `pendingStage` 落地（stale 任务还原 pendingTasks）；handler 异常 → fail；终态 persist。
- 对外接口（index.js:2054-2119）：`submit({kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId})`——excluded 抛错、rememberRepo、同 cwd 活动任务幂等返回 `{job, existed:true}`、占位 `submitting` 挡并发提交、凭证校验（`batchProvider` 非空 → 校验 batchModel + `llmRef.stream` 存在，llm 未注入报「请重启宿主」；否则抛「编译模型提供商为空」，index.js:2054-2063）、serialProjects 且有活动任务时排队 queued（full→plan / stale→articles 作为 pendingStage），否则直接进阶段、`persist + flush + void tick()` 立即推进一步；`cancel(jobId)`（mergeFromDisk 后置 cancelRequested，index.js:2121-2130）；`list()`（index.js:2132）；`findActive(cwd)`（index.js:2133）；`start()`（setInterval tick，TICK_MS，unref，index.js:2135）；`stop()`（index.js:2140）。

### Web API 与系统提醒（index.js:2471-2874）

- `isLoopbackRequest(req)`（index.js:2471-2474）：仅允许 127.0.0.1 / ::1 / ::ffff:127.0.0.1；`writeJson` / `readBodyJson`（index.js:2476-2500，body >1MB 拒绝）。
- `listModelCatalog(llm)`（index.js:2507-2528）：`llm.listProviders()` → `providers[{id, name, models, error?}]`（单 provider listModels 抛错保留条目、models 置空）；llm 服务缺失 → `ok:false`。`resolveModelEfforts(llm, provider, model)`（index.js:2545-2567，`resolveModelInfoOf` 兼容 `resolveModelInfo`/`resolveModel`，index.js:2534-2539）：返回 `reasoning.efforts [{id, name, description}]` + defaultEffort + context tokens。
- `installWebServer(ctx, service, {config, schedState, compile})`（index.js:2569-2789）：先 `ctx.inject(['workspaceRegistry'])`（注册表失败时过滤降级为不过滤，index.js:2578-2581），注册 5 个端点（全部 loopback guard）：
  - `GET /api/codewiki/jobs`：`service.list()` → workspaceOnly 过滤（isExcluded 命中 = 在工作区内才显示，index.js:2879-2881）→ `{now, jobs}`；异常 500 带 stack 前 8 行。
  - `GET /api/codewiki/repos`：30s 缓存 + 工作区签名（wsSig 变化即失效）；jobs 历史 cwd + `loadKnownRepos()` 去重；逐仓库 `runCw status`(20s) → state/staleArticles/changedFiles/wikiPath/articleCount；附调度器状态（index.js:1105-1179）。
  - `GET /api/codewiki/models`：30s 缓存模型目录。
  - `GET /api/codewiki/model-efforts?provider=&model=`：60s 缓存（effortsCache，key=`provider\0model`）。
  - `POST /api/codewiki/control`：action=`cancel`（service.cancel）/ `refresh`（清 repos 缓存）/ `compile`（`compile({cwd, scope})`，编译入口未初始化返回 501）；未知 action 400。
- `commitHintText(cwd, jobs)`（index.js:2804-2830）：60s TTL 缓存；比较最近成功编译任务（stage=done 且 writtenCount>0 且 samePath）的 finishedAt 与 `git log -1 --format=%ct -- .codewiki CodeWiki.md`（5s 超时），编译更新 →「【CodeWiki 编译完成·请提交改动】」提示文本；非 git/异常返回空。
- `reminderText(cwd)`（index.js:2831-2840）：wiki 维护提醒五条（收尾调 codewiki_generate 更新受影响文章 / 不手工修改 .codewiki 文章 / 本目录外用绝对路径 / .codewiki 与代码一起提交 / 收尾未调用视为任务未完成）。
- `installUpdateReminder(ctx, config)`（index.js:2842-2874）：`systemPrompt.section({name:'codewiki:update-reminder', order: TOOL_REPORT+1})`，仅当 `updateReminder !== false` 且 cwd 存在 `CodeWiki.md` 时注入（text 是惰性求值函数，含 commitHint）；存量代理经 `inject(['agents'])` 遍历补装，新会话经 `ctx.on('agent/created')` 监听；WeakSet 防重复安装。

### 插件入口 apply（index.js:2876-2935）

`apply(ctx, config)` 的装配顺序：

1. `ctx.inject(['agents'])`→agentsRef、`inject(['llm'])`→llmRef（index.js:2877-2878）。
2. `createJobService(config, wakeCompileSession)` + `service.start()`；`ctx.effect(() => () => service.stop())`——**双箭头**：cordis effect 立即执行 body 并以返回值为 disposer，写成 `() => service.stop()` 会在插件加载当场停掉服务（index.js:2883）。
3. 构建四个工具定义；自动巡检调度器：`schedState{lastScan, scanning, lastError, lastScanRepos, lastScanSubmitted}`；`autoScan()`——autoUpdate 开且非 scanning 且距 lastScan ≥ autoUpdateMin 分钟 → 对 `service.list()` 的 cwd 去重（排除 excluded）逐个 `generateDef.execute({cwd, scope:'auto', auto:true})`，单仓库失败只记 lastError（200 字）；60s 心跳 setInterval unref（index.js:2890-2915）。
4. `ctx.inject(['tools'])` 逐个 register 四工具（`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`）——单工具 schema 违规 try/catch 只丢该工具（cordis 会把回调失败视为 fiber FAILED 回滚全部注册），disposer 负责注销（index.js:2916-2932）。
5. `installWebServer(ctx, service, {config, schedState, compile: generateDef.execute})`（index.js:2933）；`installUpdateReminder(ctx, config)`（index.js:2934）。

### client.js 客户端（Web 半侧，client.js:10-1339）

- 加载与常量（client.js:10-28）：`window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})`——加载 id 必须等于 package.json name（client-modules 按 nearestPackage 校验注册者）；React + primitives（Switch/Button/Input/Tag）；`NS='codewiki'`、`KEY='codewiki'`、`JOBS_PATH`/`CONTROL_PATH`/`REPOS_PATH`/`MODELS_PATH`/`EFFORTS_PATH`、`PANEL_ORDER=52`（侧边栏图标排序）、`POLL_MS=2000`、`REPOS_POLL_MS=10000`、`ACTIVE_STAGES=['queued','plan','articles','crosscut','compose','review','index']`。
- i18n（client.js:30-305）：`zh()` / `en()` 两套词典（设置项 hint、阶段/状态/类型标签、调度文案）；词典值必须是字符串（函数会被 `t()` 回退为键名）。
- 样式（client.js:307-387）：`data-dscw-*` 属性选择器 CSS（设置页 grid、任务卡、六阶段步骤条 p-steps/p-step/p-dot、吞吐徽标 badge、用量行 usage、活动流 activity、任务列表 tasklist）；HMR 时先 querySelector 移除旧 style 再 append 防堆叠。
- 基础设施（client.js:393-408）：`el(tag, props, ...children)` = React.createElement 封装；`apiGet(p)` / `apiPost(p, data)`——fetch + JSON，`!ok` 抛 `Error(body.error || HTTP status)`。
- `apply(ctx)`（client.js:412-1341）：inject `['slots','locale','configForms']`；`tBound = ctx.locale.bind(NS)`；`ctx.effect(locale.register(NS, {zh, en}))`；`form = ctx.configForms.get(NS)` 拿配置表单句柄。三个挂载点：①`slots.inject('plugins.item', ...)`（设置卡，存在 `ctx.configForms.whileServed([NS], mount)` 则用它——宿主服务该命名空间期间才出现）；②`slots.inject('main', ...)`（面板主体）+ ③`slots.inject('sidebar.panellist', ...)`（面板图标）；effect 返回清理函数。
- `CodewikiCard`（client.js:452-842）：设置表单组件。`form.subscribe(pull)` 订阅快照（`status==='ready'` 且 revision 变化 → `setDraft(structuredClone(snap.value))`，client.js:452-469）；`dirty` 用 JSON 序列化深比较（client.js:509-512）；`save()`（client.js:663-685）校验并发 1-8 整数，diff 18 键生成 `{op:'set', path:[key], value}` ops，`form.mutate(ops, snapshot.revision)`——accepted→saved / 否则 conflict（乐观并发拒绝）。模型目录拉 `MODELS_PATH`（失败 catalogError → provider 回退手填 Input）；`EFFORTS_PATH` 按 provider/model 拉 reasoning efforts（client.js:452-483）；`modelTrio`（client.js:562-661）渲染提供商/模型/思考程度三联字段，换 provider 清空 batchModel 取首个；已配置但目录中不存在的 provider/model 保留 `__custom` 选项防静默丢失；表单分四段：运行（enabled/updateReminder/workspaceOnly/serialProjects Switch + maxConcurrency/articleLanguage/binaryPath Input）、编译模型（batchProvider/batchModel/batchReasoningEffort/sessionTier）、大档模型（bigProvider/bigModel/bigReasoningEffort/bigTokenBudget）、调度与排除（autoUpdate/autoUpdateMin/excludePaths textarea）+ 保存条。
- 面板辅助（client.js:848-978）：`stageLabel`/`stateLabel`/`kindLabelOf`（词典键拼接，client.js:848-850）；`progressBar(done, total)`（client.js:851-854）；`repoName(cwd)`（父目录/目录名两段，Temp 沙箱残留一眼可辨，client.js:855-858）；`fmtMs`（h:mm:ss / mm:ss）、`fmtTok`（1.2M / 1.2k）、`fmtDur`、`fmtAgo`（client.js:859-881）；`Spark({values, width=56, height=16})` 纯 SVG polyline 微趋势线（≥2 有效值才画，client.js:883-895）；`stageBar(job)` 六阶段步骤条（终止态失败标在 lastTimedStage = stageTimings 最后键；每步 data-done/running/failed/cancelled + live 计时，client.js:904-926）；`overallPct(job)`（client.js:848-857）——`STAGE_WEIGHTS = {queued:0, plan:0.05, articles:0.6, crosscut:0.1, compose:0.05, review:0.15, index:0.05}`，已过阶段权重和 + 当前权重 × taskList 完成比，封顶 99（done 才 100）；`throughputBadge(job, sparkOf, rateOf)`（client.js:940-960）——活动阶段 tps>0 显示 tok/s+Spark，batchSubmittedAt 有 EWMA 速率 + 篇/分 + ETA，否则显示执行时长；`usageLine(job)`（client.js:962-978）——input/output tok、requests 拆 batch/realtime 通道，overTier2>0 红字「N 个超单请求预算（按大档装填）」。
- `ReposTab()`（client.js:981-1124）：仓库总览标签页——10s 轮询 `REPOS_PATH`（inFlightRef 防重叠，client.js:981-998）；调度器状态行（下次扫描 ≈ lastScan + intervalMin×60000，client.js:981-996）；每仓库一行：名称（title 为完整 cwd）、excluded 标签、状态标签（clean/stale/error 映射 done/stale/failed 色系）、stale →「更新」按钮（`POST control {action:'compile', cwd}`，client.js:981-989）、排除/取消排除按钮（client.js:981-999）——直接改 `excludePaths` 配置（`form.mutate`，与设置卡保存同链路），成功后 `POST control {action:'refresh'}` 失效服务端缓存并重拉；stale 附 `staleArticles N · changedFiles M`；最近任务附 kind·stage·auto 标签、batch 进度、tps 与进度条（client.js:981-1023）。
- `CodewikiPanel()`（client.js:1126-1326）：侧边栏主面板——2s 轮询 `JOBS_PATH`（inFlight 防重叠，client.js:1126-1159）；面板侧差分采样：`sparkRef`（jobId→tps 滚动窗口 ≤30 点）+ `batchRateRef`（EWMA `rate = prev.rate*0.6 + inst*0.4`，client.js:1134-1167）；`cancel(jobId)` → `POST control {action:'cancel'}`（client.js:1184-1192）；`copyPath` 剪贴板复制（1.5s 回显 copiedLabel，client.js:1193-1199）；任务按 cwd 分组、活动优先选焦点任务、其余收「历史任务」折叠区（client.js:1126-1138）；`jobCard`——类型/阶段标签、吞吐徽标、取消按钮（cancelRequested 时置灰显「取消中」）、stageBar、进度条（overallPct）、meta（written/failed/batch/耗时）、usageLine、notes（最新一条 + 活动流折叠）、error、任务列表（✓/✗/· 标记）、wikiPath 复制（client.js:1220-1278）；三个 tab：overview(ReposTab) / tasks / settings(复用 CodewikiCard)（client.js:1126-1135）；渲染构建期异常直接显形为 `Panel error: ...` 防白屏（client.js:1126-1130）。
- `PanelIcon(props)`（client.js:1328-1339）：16×16「摊开的书」SVG 图标。

## Architecture

```text
┌──────────────────────────── DSH 宿主（Node ≥20）────────────────────────────┐
│                                                                            │
│  工具层（index.js 注册，4 个）                                               │
│  ┌─────────┐ ┌───────────────────┐ ┌─────────────────┐ ┌──────────────────┐ │
│  │   cw    │ │ codewiki_generate │ │ codewiki_update │ │codewiki_progress │ │
│  │ :906-969│ │     :2153-2303    │ │    :2312-2364   │ │    :2383-2465    │ │
│  └────┬────┘ └────────┬──────────┘ └────────┬────────┘ └────────┬─────────┘ │
│       │ runCw         │ submit()            │ 转发 scope=auto    │ list()    │
│       ▼               ▼                     ▼                   ▼           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │        createJobService（index.js:1252-2146）六阶段任务状态机           │  │
│  │  queued → plan → articles → crosscut → compose → review → index → done │  │
│  └──────┬──────────────────┬───────────────────────────┬─────────────────┘  │
│         │ 批量通道          │ 会话兜底通道               │ 落盘               │
│         ▼                  ▼                           ▼                    │
│  ┌──────────────┐  ┌────────────────────┐    fixAnchors + writeFileSync     │
│  │ llmChat       │  │ agent.steer 发起会 │    → <repo>/.codewiki/**.md       │
│  │ (宿主 llm)    │  │ 话自行 delegate    │    runCw index + meta update      │
│  └──────────────┘  └────────────────────┘                                   │
│  ┌──────────────────────────┐   ┌─────────────────────────────────────────┐ │
│  │ HTTP API（:2569-2789）    │◄──│ jobs / repos / models / efforts / control│ │
│  └────────────▲─────────────┘   └─────────────────────────────────────────┘ │
└───────────────┼──────────────────────────────────────────────────────────────┘
                │ fetch 轮询（2s 任务 / 10s 总览）
┌───────────────┴──────────────────────────────────────────────────────────────┐
│  client.js 浏览器侧：CodewikiCard（设置）· CodewikiPanel（面板）· ReposTab      │
└───────────────────────────────────────────────────────────────────────────────┘
```

外围关系：`cw`（Rust CLI，外部捆绑二进制）负责 wiki 的初始化/状态/索引/元数据；LLM 通道（llmChat，index.js:283-302）负责规划与全部文章生成；client.js 只通过 HTTP API 与宿主交互，不经任何宿主内部 API。

## Data Flow

一次 `codewiki_generate {cwd, scope:'auto'}` 的完整生命周期（宿主侧）：

1. **探测**（index.js:176-1032）：`runCw status` → `parseStatus` → `wikiPathFor`。clean 直接返回；stale+staleArticles 逐篇预构建任务；missing 先 `cw init`。
2. **提交** `submit()`（index.js:2054-2119）：凭证校验（provider 通道校验 `llmRef.stream`；空 provider 直接报错，index.js:2054-2063）—— 占位 submitting 挡并发 → serialProjects 排队或直接进阶段 → `void tick()` 立即推进一步。
3. **规划** `tickPlan`（index.js:1599-1629）：`scanRepoFiles` → `batchPlannerPrompt` → LLM 输出 JSON → `parsePlan`（失败降级 `localPlan`）→ 进 articles。
4. **文章** `tickArticles`（index.js:1634-1749）：`prepareArticleTasks` 装填（预算内直出 / 观察批 `#obs`+composePlan / 单文件超限转会话通道或走大档，index.js:555-669）→ `runRealtimeTasks` 并发执行 → 观察按文章聚合 → `batchArticleComposePrompt` 合成 → `tally` → `writeValidated`（frontmatter 闸门 + fixAnchors）落盘 `modules/*.md`；writtenCount===0 → fail。
5. **横切** `tickCrosscut`（index.js:1773-1836）：全部成功文章全文 ≤110k → 单批直出三篇（`_architecture.md` / `_patterns.md` / `concepts/*`）；否则逐篇 `batchObservePrompt` 观察再 `submitComposeBatch` 合成。
6. **校对** `tickReview`（index.js:1888-1951）：`localReview` 静态检查（文件丢失 / 缺 frontmatter / source_files 缺失）→ 逐文章装填源码 → `batchProofreadPrompt` 批次（`tally {replace:true}`——校对失败不推翻已写原文）。
7. **索引** `tickIndex`（index.js:1953-1976）：`runCw ['index']` + `runCw ['meta','update']` → `normalizeIndexLinks` → `ensureWikiEntry` → done。
8. **唤醒** `wakeCompileSession`（index.js:1239-1250）：steer 发起会话「CodeWiki 编译完成·请提交改动」。

并行反馈流：client.js 每 2s 轮询 `GET /api/codewiki/jobs` → 面板 stageBar / overallPct / throughputBadge；每 10s 轮询 `GET /api/codewiki/repos` → 总览；`POST /api/codewiki/control {action:'cancel'}` → 服务端 `syncCancelFlags` 在下个 tick 生效并 abort 在飞请求。

预算流：每任务 prompt 先 `estimateTokens` 估算；>110k → 拆观察批（单文件 ≤大档预算装填、批内合并 ≤110k）后合成；单文件 >大档预算 → 会话兜底通道或仍由大档模型在插件内写完（取决于 bigProvider 是否配置，index.js:267-381）；用量全部记入 `usage`（inputTok/outputTok/requests/batch/realtime/overTier2）。

## Connections

- [[client-interface]]：client.js 客户端半侧的组件细节与挂载点约定（本文是宿主半侧）。
- [[configuration-and-metadata]] / [[configuration-management]]：18 项配置的语义、volatile 热生效与钳制规则。
- [[wiki-generation-flow]]：六阶段编译流水线的过程性描述（本文是代码级映射）。
- [[batch-tests]] / [[orchestration-tests]] / [[wiki-tests]] / [[cwd-path-tests]]：分别对应装填预算、任务编排、cw 包装与文章产物、路径规整的测试。
- [[cw-binary-source-lost]]：捆绑 `cw` 二进制的来源与缺失教训。
- [[update-reminder-entry-gap]]：更新提醒入口的历史缺口。
- [[runtime-artifacts]] / [[git-and-ops-artifacts]]：JOBS_FILE / SESSION_TASK_DIR 等运行时产物位置与 git 收尾运维（commitHint 机制）。
- [[observability]] / [[testing-suite]] / [[documentation-and-config]]：日志与进度观测、测试套件总览、文档与配置面。

## Known Issues

- **无子代理回退**：`batchProvider` 为空且未配置时，`submit` 直接抛错「编译模型提供商为空」（index.js:2054-2063）——这是设计决策，不是缺陷；插件不保存密钥、无自带直连通道（index.js:2054-2079）。
- **fixAnchors 静默不完美**：符号歧义或找不到时锚点记 unresolved 不修改（index.js:396-479），文章行号可能失准；修正只改行号数字，不改文件名。
- **合成批中断语义**：进程在「提交合成批后、落盘前」中断，重启后 `tickCompose` 无 batchRef → 记 note「跳过横切进校对」（index.js:1839-1851），横切文章该次不产出。
- **会话通道超时**：会话兜底任务默认 30 分钟超时（SESSION_TASK_TIMEOUT_MS，index.js:1054），超时按失败记账。
- **任务历史截断**：`MAX_JOBS_KEPT=30`（index.js:1099），更早的任务从磁盘消失；仅 REPOS_FILE 登记保留仓库清单。
- **跨进程 tick 锁残留**：pid 锁 60s 过期强删（index.js:1164-1182），宿主强杀后可能留下最长 60s 的锁残留，期间新 tick 拿不到锁。
- **cordis effect 双箭头陷阱**：必须 `ctx.effect(() => () => service.stop())`（index.js:2883）；写成单箭头会在插件加载当场停掉服务。
- **工具注册隔离**：四工具逐个 try/catch register（index.js:2916-2932），单个 schema 违规只丢该工具，否则 cordis 回滚全部注册。
- **estimateTokens 是估算**：CJK 1 token/字、其余 3.5 字符/token（index.js:267-275），与真实 tokenizer 有偏差；预算边界任务可能被多拆或少拆一批。
- **workspaceOnly 过滤降级**：HTTP jobs/repos 端点按 `isExcluded` 过滤（index.js:257-269、2617-2619），workspaceRegistry.list() 抛错时降级不过滤——UI 可能短暂显示工作区外任务（index.js:257-260）。
- **大档默认开启**：默认 `bigProvider='volces-ark'`（index.js:30），单文件超 110k 但 ≤420k 时由大档模型在插件内写完，不再交会话模型；仅当 bigProvider 留空且单文件超硬上限才走会话兜底（index.js:555-669）。