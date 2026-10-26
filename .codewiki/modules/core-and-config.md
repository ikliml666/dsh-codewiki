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

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合，包含插件主入口 `index.js`、浏览器侧客户端 `client.js`、cordis 挂载补丁 `cordis.patch.yml`、包定义 `package.json` 与 git 忽略规则 `.gitignore`。0.13.0 起（`package.json` `3|`，描述见 `4|`；`cordis.patch.yml` `2|`）插件吸入了 FSoft-AI4Code/CodeWiki 的三层能力：AST 符号提取 + LLM 语义聚类（`semanticPlan` `884|`）、agentic 工具循环写作（`startAgenticRun` `2014|`）与符号级增量判定（`extractCurrentGraph` `1561|`），全部用 Node + tree-sitter WASM 实现，任一环节失败自动降级回目录分组 / 单轮装填 / 文件级增量，不会中断编译。

`index.js` 提供把 `mraza007/codewiki`（Rust CLI `cw`）接入 DeepSeek Harness 的全部能力：四个工具——基础 CLI 封装 `cw`（`cwToolDefinition` `1159|`）、编译提交 `codewiki_generate`（`generateToolDefinition` `2954|`）、日常维护 `codewiki_update`（`updateToolDefinition` `3176|`）、只读进度 `codewiki_progress`（`progressToolDefinition` `3247|`）；后台常驻编排服务（`createJobService` `1693|`，阶段机 `articles → crosscut → compose → review → index → commit`，见 `STAGE_HANDLER` `2738|`）；宿主 webServer 回环端点（`installWebServer` `3455|`，挂 `/api/codewiki/*` 七个端点）；会话系统提示提醒注入（`installUpdateReminder` `3911|`）；编译产物自动提交（`autoCommitWiki` `3783|`）。`client.js` 在浏览器半侧挂载「插件」设置页（`CodewikiCard` `548|`）与侧边栏编译任务面板（`CodewikiPanel` `1418|`，含总览 `ReposTab` `1177|` 与会话视图 `SessionView` `1326|`），经 `configForms` 读写配置、轮询 `/api/codewiki/jobs`（端点 `3496|` 起）与 `/api/codewiki/repos`（`3536|` 起）展示进度。`cordis.patch.yml` 以 `insert` 方式把 `index.js` 注册为 id `codewiki` 的插件（`19|-22|`）；`package.json` 声明包名 `@local/dsh-codewiki`、版本 `0.13.1`（`3|`）、入口与 exports（`7|-11|`）；`.gitignore` 排除 `node_modules/`、`vendor/codewiki/target/`、日志、cw 二进制备份与运行期产物。

## Key Components

### index.js 导出与核心常量

- `26| const pluginDir = path.dirname(fileURLToPath(import.meta.url))` — 插件目录绝对路径，定位捆绑二进制 `bin/cw(.exe)`（`157|`）。
- `27| const PLUGIN_NAME = 'dsh-codewiki'`、`28| export const name = PLUGIN_NAME` — 插件名导出。
- `29| const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']` — `cw` 工具子命令白名单。
- `31| const CONCURRENCY_HARD_CAP = 8` — 并发硬顶；`33| const DEFAULT_CONCURRENCY = 2` — 默认并发（hy3 免费档）。
- `35| const DEFAULT_BATCH_PROVIDER = 'workbuddy'`、`36| const DEFAULT_BATCH_MODEL = 'hy3'` — 默认编译模型（免费 192k 上下文）。
- `39| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`40| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`42| const DEFAULT_BIG_TOKEN_BUDGET = 420000` — 大档模型（512k 上下文，超长输入在插件内一次写完）。
- `45| const WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` — 自动提交、忽略检测、待提交提醒共用的唯二 pathspec（不扩 `-A`）。
- `60| export const Config = z.object({` 至 `86| })` — 配置 schema（schemastery），25 个字段全部 `.volatile()`：`enabled`(61)、`binaryPath`(62)、`batchProvider`(63)、`batchModel`(64)、`batchReasoningEffort`(65)、`bigProvider`(66)、`bigModel`(67)、`bigReasoningEffort`(68)、`bigTokenBudget`(69)、`sessionTier`(70)、`maxConcurrency`(71)、`bigConcurrency`(72)、`serialProjects`(73)、`parallelProjects`(74)、`articleLanguage`(75)、`planMode`(76)、`agenticArticles`(77)、`agenticMaxSteps`(78)、`symbolIncremental`(79)、`updateReminder`(80)、`autoCommit`(81)、`excludePaths`(82)、`autoUpdate`(83)、`autoUpdateMin`(84)、`workspaceOnly`(85)。
- `92| function liveConfig(config) {` 至 `134| }` — 配置规范化（并发钳制 `107|-113|`、并行上限 1–4 `115|-119|`、planMode 白名单 `121|`、agentic 步数 1–100 钳制 `123|-126|`、大档预算下限 `105|`）。
- `541| const BATCH_TOKEN_BUDGET = 110000`、`546| const BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与兜底装填上限（由 hy3 192k 窗口 − 64k 输出反推）。
- `1292| const JOBS_FILE`（可被 `DSH_CODEWIKI_JOBS_FILE` 覆盖）、`1293| const TICK_MS`（默认 10000）、`1297| const SESSION_TASK_TIMEOUT_MS`（默认 30 分钟）、`1298| const SESSION_TASK_DIR` — 任务持久化、tick 间隔与会话通道。
- `1308| const SESSION_TTL_MS`、`1309| export const SESSIONS_DIR`、`1310| const SESSION_FLUSH_MS = 3000` — 会话内容记录（保留 24h、3s 节流写）。
- `1485| const ORPHAN_TAKEOVER_MS`（默认 5 分钟）、`1486| const MAX_JOBS_KEPT = 30`、`1491| const REPOS_FILE` — 孤儿接管阈值、历史截断数与已知仓库清单。
- `1516| const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])` — 终态集合。
- `1519|-1523| SCAN_SKIP_DIRS`、`1524|-1529| SCAN_SKIP_EXT`、`1530| SCAN_MAX_FILE_BYTES = 256*1024`、`1531| SCAN_MAX_FILES = 2000` — 仓库扫描黑名单与上限。
- `330| WORKTREE_CACHE_TTL_MS = 60000`、`350| SOURCE_PROBE_TTL_MS = 10*60*1000`、`1585| JOBS_LOCK_FILE` — 三处缓存/锁常量。

### index.js 内部函数与工具定义

**路径 / 进程 / 状态判定**

- `49|-54| normalizeCwd(input)` — Windows/Git-Bash MSYS 盘符（`/e/...`）归一化为 `E:/...`，仅 win32。
- `88|-90| val(x)` — 从 cordis 配置容器取值。
- `140|-160| resolveBinary(cfg)` — `binaryPath` 优先，其次 PATH 探测（`where`/`which`，`145|-155|`），回退捆绑 `bin/cw(.exe)`。
- `162|-187| runCw(...)` — spawn `cw` 子进程，超时 SIGKILL + abort 中止，收集 stdout/stderr。
- `199| normalizeArticlePath(p)` — 路径 `\` → `/`（纵深防御，0.5.0.2 起 Rust 层已输出 `/`）。
- `203|-211| normalizeIndexLinks(cwd)` — `_index.md` 链接头（`[[` 到 `|`）内 `\` 规范化，文件不存在静默跳过。
- `213|-226| parseStatus(stdout)` — `cw status` 三态解析：`missing`/`uncompiled`/`clean`/`stale` + `changedFiles`（`M`）/`staleArticles`（`!`）。
- `229|-241| countWikiArticles(wikiPath)` — 递归统计 `.codewiki/` 下 `.md` 篇数（总览卡用）。
- `246|-279| ensureWikiEntry(cwd, language)` — 仓库根缺 `CodeWiki.md` 时按语言自动生成入口；已有（人工/模型手册）绝不覆盖。
- `284|-296| excludedItem/isExcluded` — 排除清单命中（换行/分号/逗号分隔绝对路径，子树匹配、Windows 大小写不敏感）；`excludedItem` 返回命中项原文供报错。
- `309|-325| detectLinkedWorktree(cwd)` — `git rev-parse --git-dir/--git-common-dir` 判 linked worktree（两者 resolve 后不同即 worktree；submodule/主工作区相同不误判）。
- `333|-344| isWorktreeCwd(cwd)` — 带 60s 缓存的 worktree 判定（2s 轮询端点用）。
- `352|-371| hasCompilableSources/clearSourceProbeCache` — 目录是否扫得出可编译源码（10 分钟缓存；手动编译/内容变化后清缓存防误挡）。
- `378|-386| isDeadCompileTarget(cwd)` — 统一判定非有效编译对象（worktree 或空壳；目录不存在不算 dead，历史记录保留）。
- `394|-402| estimateTokens(text)` — 粗算 token：CJK ≈ 1/字，其余 ≈ 3.5 字符/token。

**模型通道与装填**

- `412|-437| llmChat({...})` — 唯一模型通道：宿主 `llm.stream`（provider/model 取自模型设置，凭证宿主解析，插件零密钥）；`onDelta` 流式回调；`UNSUPPORTED_REASONING_EFFORT` 时剥档用默认档重试（`426|-430|`）；失败统一抛错。
- `441|-454| applyTaskResult(task, content, notes)` — 任务结果统一出口：`keepInMemory` 回内存，否则落盘（先 `fixAnchors` 校正）。
- `469|-528| runRealtimeTasks(tasks, {...})` — 并发池唯一执行器：按任务 `bigTier` 标记分池（`476|-479|`），默认档 `concurrency` 与大档 `bigConcurrency` 独立限流同时推进（0=跟随默认档）；`onRequestStart` 挂会话记录、`onTaskDone` 上报 tps 样本。
- `548| sleep`、`550|-552| readJsonFile(p)` — 小工具。
- `557|-559| numberLines(content)` — 源码行号前缀 `N| `（模型引用行号以前缀为准，不自行数行）。
- `568|-651| fixAnchors(content, cwd)` — 行号锚点自动修正（第四层兜底）：`file:NN(-MM)` 对照源码确定性校正——起点行已含符号不动，否则全文找符号唯一出现行或唯一声明形态（`629|` defRe），歧义/找不到不动；只改行号数字，区间尾越界钳到文件尾（`644|`）。
- `656|-683| collectSources(cwd, files, budget)` — 按 token 预算整文件内联源码（不做半文件截断），返回 `{text, skipped, oversized}`。

**Prompt 模板与规划**

- `687|-714| batchArticlePrompt(...)` — 批量单轮文章 prompt（含旧文时声明行号一律不得沿用）。
- `727|-812| prepareArticleTasks(tasks, {...})` — 装填决策：整任务 ≤ 单请求预算直出（`773|`）；超预算按普通预算逐文件拆观察批（`776|-807|`，`#obs` 任务 keepInMemory）待合成；单文件连大档都装不下转会话通道（`770|`）；超普通预算标 `markBig`（`739|-747|`）走大档。
- `818|-847| articleFormatSection()` — 文章格式条款（frontmatter/章节/box-drawing 图/Obsidian 链接/行号纪律）。
- `855|-860| shouldFallBackFromAgentic(results)` — agentic 结果失败过半才算系统性失败（纯函数，可单测）。
- `862|-875| localPlan(files)` — 按顶层目录分组生成模块清单（配合 `slugify`）。
- `884|-965| semanticPlan(files, {...})` — 语义规划：`extractRepoGraph` AST 符号提取（`903|`）→ `resolveImportEdges` 依赖边（`920|`）→ `clusterComponents` LLM 聚类（`931|`）；plan 携带模块树与符号图（`946|-957|`）供 stale 增量做组件级判定；任何失败返回 `fallback: true` 退回 localPlan。
- `969|-988| packArticles(articles, budget)` — 横切输入装配（超预算截 frontmatter+Overview 头部并标注）。
- `990|-1026| crosscutIntro/batchArchitecturePrompt/batchPatternsPrompt/batchConceptPrompt` — 横切 prompt（`_architecture.md` 三张 box-drawing 图 / `_patterns.md` / 概念专文）。
- `1030|-1047| batchObservePrompt` — 横切观察（每模块文章一份紧凑架构观察）。
- `1051|-1067| batchArticleObservePrompt` — 文章分割观察（源码批 → 技术观察，宁全勿简）。
- `1071|-1099| batchArticleComposePrompt` — 分割合成（观察包 → 完整文章）。
- `1103|-1122| batchProofreadPrompt`、`1126|-1153| batchProofreadBatchPrompt` — 校对 prompt（单篇 / 多篇合并按 `@@@article:`/`
