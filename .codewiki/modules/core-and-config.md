---
title: core-and-config
type: module
source_files:
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
tags: [core, config, plugin-entry, client-ui, dsh-codewiki]
---

## Overview

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合，包含插件主入口 `index.js`、浏览器侧客户端 `client.js`、cordis 挂载补丁 `cordis.patch.yml`、包定义 `package.json` 与 git 忽略规则 `.gitignore`。当前版本 0.13.4（`package.json` `3|`）。0.13.0 起插件吸入了 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力——AST 符号提取 + LLM 语义聚类（`semanticPlan` `884|`）、agentic 工具循环写作（`startAgenticRun` `2023|`）与符号级增量判定（`extractCurrentGraph` `1563|`）——全部用 Node + tree-sitter WASM 实现，不需要 Python 运行时；任一环节失败都自动降级回顶层目录分组 / 单轮整包装填 / 文件级增量，不会中断编译（`cordis.patch.yml` `2|`、`package.json` `4|`）。

`index.js` 把 `mraza007/codewiki`（Rust CLI `cw`）接入 DeepSeek Harness（`1|`）。它注册四个工具（`apply` `3969|`）：基础 CLI 封装 `cw`（`cwToolDefinition` `1161|`）、编译提交 `codewiki_generate`（`generateToolDefinition` `2978|`）、固定 scope=auto 的日常维护快捷入口 `codewiki_update`（`updateToolDefinition` `3200|`）、只读进度查询 `codewiki_progress`（`progressToolDefinition` `3271|`）；外加后台常驻编排服务（`createJobService` `1695|`，阶段机 `articles → crosscut → compose → review → index → commit`，见 `STAGE_HANDLER` `2762|-2769|`）、宿主 webServer 回环端点（`installWebServer` `3479|`，挂 `/api/codewiki/*` 七个端点）、编译产物自动提交（`autoCommitWiki` `3807|`）与会话系统提示维护提醒注入（`installUpdateReminder` `3935|`）。全部模型环节在插件内完成：唯一模型通道是宿主 `llm` 服务（`llmChat` `412|`），默认 `workbuddy/hy3`（免费 192k 上下文，单请求输入预算 110k），超大输入改走大档 `volces-ark/glm-5.3-flash`（512k 上下文），零子代理（头注释 `2|-7|`）。

`client.js` 是浏览器半侧（`1|-8|`）：挂载「插件」页设置表单 `CodewikiCard`（`548|`）与侧边栏编译面板 `CodewikiPanel`（`1418|`，含仓库总览 `ReposTab` `1177|`、跨任务会话视图 `SessionView` `1326|`），经 `configForms` 命名空间 `codewiki` 读写配置（`17|`、`513|`），轮询宿主回环端点展示进度。`cordis.patch.yml` 以 `insert` 把 `index.js` 注册为 id `codewiki` 的插件（`19|-24|`）；`package.json` 声明包名 `@local/dsh-codewiki`、`exports` 双入口（`8|-11|`）与 `dsh.bundle.patch`（`24|-26|`）；`.gitignore` 排除依赖目录、cw fork 构建产物、cw 二进制备份与 DSH 运行期产物（`1|-12|`）。

## Key Components

### index.js 导出清单（按主题）

- 插件标识与配置：`name`（`28|`）、`Config`（`60|`）。
- cw 状态与 wiki 维护：`normalizeArticlePath`（`199|`）、`normalizeIndexLinks`（`203|`）、`parseStatus`（`213|`）、`ensureWikiEntry`（`246|`）、`currentCommit`（`1263|`）。
- 编译对象闸门：`detectLinkedWorktree`（`309|`）、`isWorktreeCwd`（`333|`）、`hasCompilableSources`（`352|`）、`clearSourceProbeCache`（`368|`）、`isDeadCompileTarget`（`378|`）。
- Token 估算与装填：`estimateTokens`（`394|`）、`numberLines`（`557|`）、`fixAnchors`（`568|`）、`collectSources`（`656|`）、`prepareArticleTasks`（`727|`）、`packArticles`（`971|`）。
- 规划：`localPlan`（`862|`）、`semanticPlan`（`884|`）、`scanRepoFiles`（`1535|`）、`extractCurrentGraph`（`1563|`）。
- 执行与退回判定：`runRealtimeTasks`（`469|`）、`shouldFallBackFromAgentic`（`855|`）。
- 会话内容记录 / 会话通道：`SESSIONS_DIR`（`1311|`）、`listSessionRecords`（`1332|`）、`readSessionRecord`（`1342|`）、`listAllSessionRecords`（`1348|`）、`pruneSessionRecords`（`1370|`）、`classifySessionTask`（`1450|`）、`buildSessionSteerText`（`1467|`）。
- 仓库登记：`forgetRepo`（`1508|`）。
- 终态唤醒：`autoCommitState`（`1671|`）、`wakeCompileSession`（`1678|`）。
- 面板数据源：`listModelCatalog`（`3417|`）、`resolveModelEfforts`（`3455|`）。
- 自动提交与提醒：`autoCommitWiki`（`3807|`）、`commitHintText`（`3891|`）。
- 装配入口：`installWebServer`（`3479|`）、`apply`（`3969|`）。

### index.js 核心常量

- `26| const pluginDir` — 插件目录绝对路径，用于定位捆绑二进制 `bin/cw(.exe)`（`157|`）。
- `27|-28|` `PLUGIN_NAME = 'dsh-codewiki'` 与 `export const name` — 插件名。
- `29| CW_SUBCOMMANDS = ['init','status','index','meta','path','projects','setup','uninstall']` — `cw` 工具子命令白名单。
- `31| CONCURRENCY_HARD_CAP = 8`、`33| DEFAULT_CONCURRENCY = 2` — 并发硬顶与默认值（hy3 免费档）。
- `35|-36| DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'` — 默认编译模型（免费、192k 上下文、宿主 llm 服务通道）。
- `39|-42| DEFAULT_BIG_PROVIDER='volces-ark'`、`DEFAULT_BIG_MODEL='glm-5.3-flash'`、`DEFAULT_BIG_TOKEN_BUDGET=420000` — 大档模型：单批输入超普通预算 110k 时改用 512k 上下文模型，仍在插件内跑完（`37|-38|` 注释）。
- `45| WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` — 自动提交、忽略检测、待提交提醒共用的唯二 pathspec；刻意不扩成 `-A`（`43|-44|` 注释）。
- `541| BATCH_TOKEN_BUDGET = 110000`、`546| BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与兜底装填上限：hy3 窗口 192k 为输入+输出共享、单请求输出上限 64k，故输入必须 ≤128k（旧值 150k 已越界，`539|-545|` 注释）。
- `548| sleep`、`550|-552| readJsonFile`、`1587| JOBS_LOCK_FILE` — 小工具与推进锁路径。
- `1294| JOBS_FILE`（`%TEMP%/dsh-codewiki-jobs.json`，测试可用 `DSH_CODEWIKI_JOBS_FILE` 隔离，`1292|-1293|` 注释）、`1295| TICK_MS`（默认 10000，`DSH_CODEWIKI_TICK_MS` 可调）、`1299| SESSION_TASK_TIMEOUT_MS`（默认 30 分钟）、`1300| SESSION_TASK_DIR` — 任务持久化与 tick 节拍、会话通道。
- `1310|-1312| SESSION_TTL_MS`（24h）、`SESSIONS_DIR`、`SESSION_FLUSH_MS=3000` — 会话内容记录保留期与流式节流写间隔。
- `1487|-1488| ORPHAN_TAKEOVER_MS`（默认 5 分钟）、`MAX_JOBS_KEPT=30`；`1493| REPOS_FILE` — 孤儿接管阈值、job 历史截断数与已知仓库清单。
- `1518| JOB_TERMINAL = new Set(['done','failed','cancelled'])` — 终态集合。
- `1521|-1533| SCAN_SKIP_DIRS / SCAN_SKIP_EXT / SCAN_MAX_FILE_BYTES=256*1024 / SCAN_MAX_FILES=2000` — 仓库扫描黑名单与上限。
- `330| WORKTREE_CACHE_TTL_MS=60000`、`350| SOURCE_PROBE_TTL_MS=10*60*1000`、`1658| agentsRef`、`1663| llmRef`、`1973|-1975| batchRuns/batchResults/batchAborters`、`3789| commitHintCache` — 各处缓存、服务引用与执行器注册表。

### 配置 schema 与规范化

- `60|-86| export const Config = z.object({...})` — 25 个字段全部 `.volatile()`（热生效）：`enabled`(61)、`binaryPath`(62)、`batchProvider`(63)、`batchModel`(64)、`batchReasoningEffort`(65)、`bigProvider`(66)、`bigModel`(67)、`bigReasoningEffort`(68)、`bigTokenBudget`(69)、`sessionTier`(70)、`maxConcurrency`(71)、`bigConcurrency`(72)、`serialProjects`(73)、`parallelProjects`(74)、`articleLanguage`(75)、`planMode`(76)、`agenticArticles`(77)、`agenticMaxSteps`(78)、`symbolIncremental`(79)、`updateReminder`(80)、`autoCommit`(81)、`excludePaths`(82)、`autoUpdate`(83)、`autoUpdateMin`(84)、`workspaceOnly`(85)。
- `88|-90| val(x)` — 从 cordis 配置容器取值。
- `92|-134| liveConfig(config)` — 配置规范化：大档预算下限钳到 `BATCH_TOKEN_BUDGET`（`105|`）、默认档并发钳 1–8（`107|-109|`）、大档并发 0=跟随默认档（`110|-113|`）、并行仓库上限 1–4 且串行时强制 1（`115|-119|`）、`planMode` 白名单 `auto|dirs`（`121|`）、agentic 步数 1–100（`123|-126|`）、`autoUpdateMin` 最小 5（`130|`）。

### 路径 / 进程 / 状态判定

- `49|-54| normalizeCwd(input)` — Windows/Git-Bash MSYS 盘符（`/e/...`）归一化为 `E:/...`，仅 win32 转换。
- `140|-160| resolveBinary(cfg)` — `binaryPath` 优先；其次 PATH 探测（win32 `where` `145|-149|` / POSIX `which` `150|-156|`——PATH 里的 cw 与 codewiki 源码同步演进，捆绑副本只兜底，`142|-143|` 注释）；最后回退插件自带 `bin/cw(.exe)`（`157|-159|`）。
- `162|-187| runCw(...)` — spawn `cw` 子进程：超时 SIGKILL（`168|-171|`）、abort 中止（`172|-173|`），收集 stdout/stderr 与 `timedOut`。
- `199| normalizeArticlePath(p)` — 路径 `\` → `/`。0.5.0.2 起 Rust 层已输出 `/`，本层仅作纵深防御（`189|-198|` 注释记录了 0.5.0.1 fork 源码丢失、0.5.0.2 重建的历史）。
- `203|-211| normalizeIndexLinks(cwd)` — 直接改写 `.codewiki/_index.md`，把 `[[link|` 链接头内的 `\` 规范化；文件不存在静默跳过。
- `213|-226| parseStatus(stdout)` — `cw status` 三态文本解析：`missing`（`215|`）/`uncompiled`（`216|`）/`clean`（`217|`）/`stale`（`225|`），逐行收集 `M` 变更文件与 `!` 过期文章。
- `229|-241| countWikiArticles(wikiPath)` — 递归统计 `.codewiki/` 下 `.md` 篇数（仓库总览卡用）。
- `246|-279| ensureWikiEntry(cwd, language)` — 仓库根缺 `CodeWiki.md` 时按语言自动生成入口；已有入口（人工/模型速查手册）绝不覆盖（`243|-245|` 注释：修复「编译过但无入口→永远收不到收尾提醒」的不变量缺口）。
- `284|-296| excludedItem/isExcluded` — 排除清单（`[\n;，,]+` 分隔绝对路径）命中判定：cwd 等于某项或位于其子树内即排除，Windows 大小写不敏感；`excludedItem` 返回命中项原文供报错（`281|-283|` 注释）。
- `309|-325| detectLinkedWorktree(cwd)` — 只用 git 判定 linked worktree：`git rev-parse --git-dir` 与 `--git-common-dir` resolve 后不同即 worktree；submodule/主工作区两者相同不误判，非 git 仓库放行（`298|-308|` 注释）。
- `333|-344| isWorktreeCwd(cwd)` — 带 60s 缓存的 worktree 判定：2s 轮询端点逐任务 spawnSync git 会拖住宿主事件循环（`327|-329|` 注释）。
- `352|-371| hasCompilableSources/clearSourceProbeCache` — 目录能否扫出可编译源码（10 分钟缓存）；手动编译/内容变化后清缓存，避免旧空判定挡住真实提交（`367|` 注释）。
- `378|-386| isDeadCompileTarget(cwd)` — 统一判定「非有效编译对象」：linked worktree（1.2.0 起拒绝）或扫不出源码的空壳（1.2.1 起拒绝）；目录已不存在不算 dead，历史任务保留可查（`373|-377|` 注释）。
- `394|-402| estimateTokens(text)` — 粗算 token：CJK ≈ 1 token/字，其余 ≈ 3.5 字符/token（`392|-393|` 注释：只为装填上下文，不需要精确分词器）。

### 模型通道与并发池

- `412|-437| llmChat({llm, provider, model, reasoningEffort, prompt, signal, onDelta})` — 唯一模型通道：宿主 `llm.stream` 流式调用（`414|-424|`），provider/model 取自插件设置里选中的模型设置条目，凭证由宿主按该 provider 解析，插件不碰密钥、0.10.1 起删除内置直连通道（`404|-411|` 注释）；模型不支持所配思考档位（`UNSUPPORTED_REASONING_EFFORT`）时剥档用默认档重试一次（`426|-430|`）；失败统一抛错由并发池按单任务记账。
- `441|-454| applyTaskResult(task, content, notes)` — 任务结果统一出口：`keepInMemory` 任务（横切/校对）把 content 带回内存由服务侧消费，文章任务先 `fixAnchors` 再落盘。
- `469|-528| runRealtimeTasks(tasks, {...})` — 并发池唯一执行器：按任务装填时打的 `bigTier` 标记分池（`474|-479|`，不按 provider 猜——用户可能把默认档也配成同一 provider，`471|-473|` 注释），默认档与大档两个池各自独立限流、同时推进（0.12.2；大档 0=跟随默认档 `485|-488|`）；任务可自带 `provider/model/reasoningEffort`（`501|-513|`）；`onRequestStart` 挂会话记录、`onTaskDone` 上报 `{outputTokens, durationMs}` 供 tps 采样。

### 行号锚点与源码装填

- `554|-559| numberLines(content)` — 源码行号前缀 `N| `：模型引用行号以前缀为准而不是自己数行（弱模型中段系统性错位，`554|-556|` 注释）。
- `562|-651| fixAnchors(content, cwd)` — 行号锚点自动修正（第四层兜底）：解析文章 frontmatter 的 `source_files`（`570|-573|`），对正文里 `file:NN(-MM)` 锚点对照源码确定性校正——起点行已含反引号内符号则不动（`615|`），否则全文找符号唯一出现行，多处时取唯一声明形态（`628|-631|` defRe：`function/class` 直接跟符号、`const/let` 要求后跟 `=`），点分符号歧义时退试首段（`620|`）；歧义/找不到一律不改并记入 `unresolved`（`637|-640|`）；区间尾越界钳到文件尾（`644|`）；只改行号数字，混合行尾按整文主风格规范化（`649|`）。符号提取规则与 `test-wiki-anchors.mjs` 同源（`563|-567|` 注释）。
- `653|-683| collectSources(cwd, files, budget)` — 把源文件按 token 预算整文件内联为 markdown（不做半文件截断——半截代码误导行号，`653|` 注释）；返回 `{text, skipped, oversized}`，首个文件即超限 → `oversized`（`670|`），预算装不下的文件在文末标注（`679|-681|`）。

### Prompt 模板

- `687|-714| batchArticlePrompt` — 批量单轮文章 prompt：带旧文时声明「行号可能已过期，一律不得沿用，必须按源码行号前缀重新标注」（`697|-704|`）；要求只输出文章本身（`707|-712|`）。
- `716|-812| prepareArticleTasks(tasks, {...})` — 装填决策：`bigTier` 定义（`731|-738|`，配置了 `bigProvider` 才启用）与 `markBig` 标记（`739|-747|`）；整任务 ≤ 单请求预算直出（`773|`，110k–大档预算走大档/硬上限）；超预算按普通预算逐文件重排拆观察批（`776|-807|`，`_split/` 观察任务 `keepInMemory` + `composePlan`）；拆完只剩一批按普通预算单请求写完（`809|`）；单文件连大档预算都装不下 → 会话通道兜底（`770|`、`789|`，仅 `bigProvider` 留空时允许，`719|-723|` 注释）。
- `818|-847| articleFormatSection()` — 文章格式条款：frontmatter 字段、六个固定章节（Overview/Key Components/Architecture/Data Flow/Connections/Known Issues）、行号以前缀为准、box-drawing 框图（≤20 行）、Obsidian `[[backlinks]]`、写给零上下文的未来 agent。
- `992|-1028|` 横切 prompt：`crosscutIntro`（`992|`）+ `batchArchitecturePrompt`（`1006|`，`_architecture.md` 必含 System Overview / Data Flow / Dependency Graph 三张图）、`batchPatternsPrompt`（`1014|`，`_patterns.md`）、`batchConceptPrompt`（`1022|`，跨模块概念专文）。
- `1032|-1049| batchObservePrompt` — 横切观察（每篇模块文章一份紧凑架构观察，输出不带 frontmatter）。
- `1053|-1069| batchArticleObservePrompt` — 文章分割观察（源码批 → 技术观察，要求「宁全勿简」：被省略的细节合成阶段将永远缺失）。
- `1073|-1101| batchArticleComposePrompt` — 分割合成（全部批次观察 + 可选旧文 → 完整文章；观察引用的 `文件:行号` 直接沿用，不得发明）。
- `1105|-1124| batchProofreadPrompt` — 单篇校对 prompt（核对 frontmatter、行号抽查、source_files 补全、改写不符描述）。
- `1126|-1155| batchProofreadBatchPrompt` — 批量校对（hy3 适配 0.10.8）：多篇文章+各自源码合并为一个请求，输出按 `@@@article: 名`/`
