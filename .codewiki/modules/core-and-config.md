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

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合，包含插件主入口 `index.js`、浏览器侧客户端 `client.js`、cordis 挂载补丁 `cordis.patch.yml`、包定义 `package.json` 与 git 忽略规则 `.gitignore`。`index.js` 提供了把 `mraza007/codewiki`（Rust CLI `cw`）接入 DeepSeek Harness 的全部能力：基础工具 `cw` 与 `codewiki_generate`、只读进度工具 `codewiki_progress`、更新快捷工具 `codewiki_update`，以及后台常驻编排服务（阶段机 `articles → crosscut → compose → review → index → commit`）、宿主 webServer 端点（`/api/codewiki/*`）、会话系统提示提醒注入与编译产物自动提交（`autoCommitWiki`）。`client.js` 在浏览器半侧挂载「插件」设置页与侧边栏编译任务面板，通过 `configForms` 读写配置、轮询 `/api/codewiki/jobs` 与 `/api/codewiki/repos` 展示进度与总览。`cordis.patch.yml` 以 `insert` 方式将 `index.js` 注册为 id `codewiki` 的插件；`package.json` 声明包名 `@local/dsh-codewiki`、版本 `0.10.11`、入口与 exports；`.gitignore` 排除 `node_modules/`、`vendor/codewiki/target/`、日志与运行期产物。

## Key Components

### index.js 导出与核心常量

- `17| const pluginDir = path.dirname(fileURLToPath(import.meta.url))` — 插件目录绝对路径，用于定位捆绑 `bin/cw`。
- `18| const PLUGIN_NAME = 'dsh-codewiki'`、`19| export const name = PLUGIN_NAME` — 插件名导出。
- `20| const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']` — `cw` 工具允许的子命令白名单。
- `22| const CONCURRENCY_HARD_CAP = 8` — 并发硬顶；`24| const DEFAULT_CONCURRENCY = 2` — 默认并发（hy3 免费档）。
- `26| const DEFAULT_BATCH_PROVIDER = 'workbuddy'`、`27| const DEFAULT_BATCH_MODEL = 'hy3'` — 默认编译模型。
- `30| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`31| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`33| const DEFAULT_BIG_TOKEN_BUDGET = 420000` — 大档模型（超长输入）默认配置。
- `36| const WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` — 自动提交与状态判定唯二认径（不扩 `-A`）。
- `51| export const Config = z.object({` 至 `71| }` — 插件配置 schema（schemastery），字段含 `enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`，全部 `.volatile()`。
- `374| const BATCH_TOKEN_BUDGET = 110000`、`379| const BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与硬上限。
- `1015| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')`、`1016| const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)`、`1020| const SESSION_TASK_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.DSH_CODEWIKI_SESSION_TIMEOUT_MS) || 30 * 60 * 1000)`、`1021| const SESSION_TASK_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')` — 任务持久化文件、tick 间隔、会话通道超时与任务目录。
- `1070| const REPOS_FILE = process.env.DSH_CODEWIKI_REPOS_FILE || path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')` — 已知仓库清单持久化。
- `1064| const ORPHAN_TAKEOVER_MS = ...`、`1065| const MAX_JOBS_KEPT = 30` — 孤儿接管阈值与历史截断数。
- `1086| const SCAN_SKIP_DIRS = new Set([...])`、`1091| const SCAN_SKIP_EXT = new Set([...])`、`1097| const SCAN_MAX_FILE_BYTES = 256 * 1024`、`1098| const SCAN_MAX_FILES = 2000` — 仓库源码扫描黑名单。

### index.js 内部函数与工具定义

- `40| function normalizeCwd(input)` 至 `45| }` — Windows/Git-Bash 盘符路径归一化为 `C:/...`。
- `73| function val(x)` 至 `75| }` — 从 cordis 配置容器取值。
- `77| function liveConfig(config)` 至 `102| }` — 将原始配置规范化为运行期可用的扁平对象（含并发钳制、大档预算兜底）。
- `108| function resolveBinary(cfg)` 至 `128| }` — 解析 `cw` 可执行文件：优先 PATH，回退捆绑 `bin/cw(.exe)`。
- `130| function runCw(binary, cwd, args, timeoutMs = 120000, signal)` 至 `155| }` — spawn `cw` 子进程并带超时/中止收集 stdout/stderr。
- `167| export function normalizeArticlePath(p)` — 将路径内 `\` 规范为 `/`。
- `171| export function normalizeIndexLinks(cwd)` 至 `179| }` — 修正 `_index.md` 链接头内的反斜杠。
- `181| export function parseStatus(stdout)` 至 `194| }` — 解析 `cw status` 三态/变更/过期输出。
- `197| function countWikiArticles(wikiPath)` 至 `209| }` — 递归统计 `.codewiki/` 下 `.md` 篇数。
- `214| export function ensureWikiEntry(cwd, language = '中文')` 至 `247| }` — 仓库根缺失 `CodeWiki.md` 时自动生成入口（中/英），已有不覆盖。
- `252| function excludedItem(cwd, list)` 至 `261| }`、`262| function isExcluded(cwd, list)` 至 `264| }` — 排除清单命中判定（绝对路径子树）。
- `272| export function estimateTokens(text)` 至 `280| }` — 粗算 token（CJK≈1/字，其余≈3.5字符/token）。
- `288| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal })` 至 `307| }` — 唯一模型通道：走宿主 `llm.stream`，返回 content 与 outputTokens。
- `311| function applyTaskResult(task, content, notes)` 至 `324| }` — 任务结果落盘或回内存（含 `fixAnchors` 校正）。
- `332| export async function runRealtimeTasks(tasks, {...})` 至 `361| }` — 并发池执行器，按 `maxConcurrency` 消费队列。
- `383| function readJsonFile(p)` 至 `385| }` — 安全读取 JSON。
- `390| export function numberLines(content)` 至 `392| }` — 为源码每行加 `N| ` 前缀。
- `401| export function fixAnchors(content, cwd)` 至 `484| }` — 行号锚点自动修正（第四层兜底），对照源码确定性校正 `file:NN` 引用。
- `489| export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)` 至 `516| }` — 按 token 预算整文件内联源码，返回 `{text, skipped, oversized}`。
- `520| function batchArticlePrompt({...})` 至 `547| }` — 单轮文章 prompt 组装。
- `560| export function prepareArticleTasks(tasks, {...})` 至 `645| }` — 将通用任务装配为批量/大档/观察/会话任务。
- `651| function articleFormatSection()` 至 `680| }` — 文章格式条款模板。
- `685| export function localPlan(files)` 至 `698| }` — 按顶层目录分组生成本地模块清单。
- `702| export function packArticles(articles, budget)` 至 `721| }` — 横切输入装配（超预算截头部）。
- `723| function crosscutIntro(...)` 至 `735| }`、`737| function batchArchitecturePrompt(...)` 至 `743| }`、`745| function batchPatternsPrompt(...)` 至 `751| }`、`753| function batchConceptPrompt(...)` 至 `759| }` — 横切 prompt 构造。
- `763| function batchObservePrompt(...)` 至 `780| }`、`784| function batchArticleObservePrompt(...)` 至 `800| }` — 观察批 prompt。
- `804| function batchArticleComposePrompt({...})` 至 `832| }` — 文章分割合成 prompt。
- `836| function batchProofreadPrompt({...})` 至 `855| }`、`859| function batchProofreadBatchPrompt(language, items)` 至 `886| }` — 批量校对 prompt（单篇/合并分节）。
- `892| function cwToolDefinition(cfg)` 至 `955| }` — 工具 `cw` 定义（封装 CLI）。
- `963| function slugify(name)` 至 `965| }` — 模块名 slug（保留 CJK）。
- `969| function parseSourceFiles(fm)` 至 `981| }`、`983| function readSourceFiles(articlePath)` 至 `991| }` — frontmatter `source_files` 解析。
- `993| async function wikiPathFor(cwd, binary, signal)` 至 `998| }` — 取 wiki 目录（默认 `<repo>/.codewiki`）。
- `1027| export function classifySessionTask(task, nowMs = Date.now())` 至 `1037| }` — 会话通道任务收割三态判定（纯函数）。
- `1044| export function buildSessionSteerText({ job, snapshots, tier = '', resend = false })` 至 `1062| }` — 会话通道 steer 文本（纯函数）。
- `1071| function loadKnownRepos()` 至 `1073| }`、`1074| function rememberRepo(cwd)` 至 `1082| }` — 已知仓库持久化。
- `1100| export function scanRepoFiles(cwd)` 至 `1123| }` — 仓库源码扫描（黑名单/大小/总数限制）。
- `1125| function loadJobs()` 至 `1128| }`、`1130| const JOBS_LOCK_FILE = ...`、`1133| function acquireTickLock()` 至 `1147| }`、`1148| function releaseTickLock()` 至 `1148| } 末尾`、`1150| function saveJobs(jobs)` 至 `1155| }` — 任务文件读写与跨进程锁。
- `1157| function jobSummary(job)` 至 `1194| }` — 任务摘要（含 tps 聚合）。
- `1214| export function autoCommitState(job)` 至 `1219| }` — 自动提交三态（committed/no-changes/pending）判定，唤醒与提醒共用。
- `1221| export function wakeCompileSession(job, outcome, agents = agentsRef)` 至 `1236| }` — 编译终态向发起会话 steer 唤醒（成功且已自动提交时不打扰）。
- `1238| function createJobService(config, onSettled)` 至 `2240| }` — 核心编排服务：含 `submit`（`2148|`）、`cancel`（`2215|`）、`list`（`2226|`）、`findActive`（`2227|`）、`start`（`2229|`）、`stop`（`2234|`）及阶段处理 `tickArticles`（`1619|`）/`tickCrosscut`（`1764|`）/`tickCompose`（`1849|`）/`tickReview`（`1898|`）/`tickIndex`（`2010|`）/`tickCommit`（`2042|`）、执行器 `startBatchChatRun`（`1459|`）/`submitBatchFor`（`1501|`）、会话通道 `dispatchSessionTasks`（`1537|`）/`progressSessionTasks`（`1575|`）/`resendSessionSteer`（`1598|`）。
- `2247| function generateToolDefinition(cfg, svc)` 至 `2397| }` — 工具 `codewiki_generate`（提交制）。
- `2407| function updateToolDefinition(cfg, generateDef)` 至 `2459| }` — 工具 `codewiki_update`（scope=auto 快捷入口）。
- `2467| function samePath(a, b)` 至 `2470| }`、`2472| function progressView(job)` 至 `2476| }`、`2478| function progressToolDefinition(cfg, svc)` 至 `2582| }` — 工具 `codewiki_progress`（只读查进度）与辅助。
- `2588| function isLoopbackRequest(req)` 至 `2591| }`、`2593| function writeJson(res, code, obj)` 至 `2597| }`、`2599| function readBodyJson(req)` 至 `2617| }` — webServer 辅助。
- `2624| export async function listModelCatalog(llm)` 至 `2645| }`、`2651| const resolveModelInfoOf = (llm) => {...}` 至 `2656| }`、`2658| export async function resolveModelEfforts(llm, provider, model)` 至 `2684| }` — 模型目录与思考档位枚举。
- `2686| export function installWebServer(ctx, service, extra = {})` 至 `2915| }` — 挂载 `/api/codewiki/jobs`（`2727|`）、`/repos`（`2749|`）、`/models`（`2842|`）、`/model-efforts`（`2861|`）、`/control`（`2882|`）端点（仅回环）。
- `2948| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {})` 至 `3030| }` — 编译产物自动提交（分支合并式，仅 add `.codewiki/` 与 `CodeWiki.md`，安全边界检查）。
- `3032| export function commitHintText(cwd, jobs = loadJobs())` 至 `3063| }` — 编译完成未提交提醒文本（60s 缓存）。
- `3065| function reminderText(cwd)` 至 `3074| }` — 会话系统提示 wiki 维护提醒文本。
- `3076| function installUpdateReminder(ctx, config)` 至 `3108| }` — 注入 systemPrompt section。
- `3110| export function apply(ctx, config)` 至 `3169| }` — 插件入口：注入 `agents`/`llm`、启动服务、注册工具与面板、自动更新调度器。

### client.js 组件

- `10| window.__ModuleLoader__.load({` 至 `12|   factory(require) {` — 客户端模块加载入口，id `@local/dsh-codewiki`。
- `17| const NS = 'codewiki'`、`18| const KEY = 'codewiki'`、`19| const JOBS_PATH = '/api/codewiki/jobs'`、`20| const CONTROL_PATH = '/api/codewiki/control'`、`21| const PANEL_ORDER = 52`、`22| const POLL_MS = 2000`、`23| const REPOS_PATH = '/api/codewiki/repos'`、`24| const MODELS_PATH = '/api/codewiki/models'`、`25| const EFFORTS_PATH = '/api/codewiki/model-efforts'`、`26| const REPOS_POLL_MS = 10000`、`28| const ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']` — 常量与端点（注意 ACTIVE_STAGES 含 commit）。
- `30| const zh = () => ({...})` 至 `171| })`、`172| const en = () => ({...})` 至 `313| })` — 中英文案词典。
- `315| const style = document.createElement('style')` 至 `395| if (!document.head.querySelector('style[data-plugin="@local/dsh-codewiki"]')) document.head.appendChild(style)` — 注入面板与设置页 CSS。
- `397| function el(tag, props, ...children)` 至 `399| }`、`401| async function apiGet(p)` 至 `406| }`、`407| async function apiPost(p, data)` 至 `416| }` — React 元素构造与 fetch 封装。
- `418| return {` 至 `419| inject: ['slots', 'locale', 'configForms'],`、`420| apply(ctx) {` 至 `1372| },` — 客户端 apply：注册词典、设置页 `plugins.item`、侧边栏 `main`/`sidebar.panellist`。
- `460| function CodewikiCard(props) {` 至 `859| }` — 设置卡片组件（view='summary' 简介 / 'page' 完整表单），含 `modelTrio`（`570|` 定义）渲染提供商/模型/思考档位级联下拉、目录联动、保存/放弃逻辑。
- `865| const stageLabel = (stage) => ...`、`866| const stateLabel = (st) => ...`、`867| const kindLabelOf = ...`、`868| const progressBar = ...`、`872| const repoName = ...`、`876| const fmtMs = ...`、`883| const fmtTok = ...`、`889| const fmtDur = ...`、`895| const fmtAgo = ...`、`900| const Spark = ({ values, width, height }) => ...` — 展示辅助。
- `914| const stepName = (s) => ...`、`916| const lastTimedStage = (job) => ...`、`923| const stageBar = (job) => ...`、`947| const STAGE_WEIGHTS = {...}`、`948| const overallPct = (job) => ...`、`959| const throughputBadge = ...`、`981| const usageLine = (job) => ...` — 步骤条/吞吐/用量渲染。
- `1000| function ReposTab() {` 至 `1143| }` — 总览标签页：轮询 `/repos`，展示各仓库 wiki 状态、调度信息、排除切换、立即编译。
- `1145| function CodewikiPanel() {` 至 `1358| }` — 侧边栏面板主组件：轮询 `/jobs`，分组展示任务卡、取消、复制路径、活动流。
- `1360| function PanelIcon(props) {` 至 `1371| }` — 面板图标（摊开的书）。

### 配置文件

- `cordis.patch.yml`：`13| - insert:` 至 `16|       config: {}` — 以 `id: codewiki` 挂载 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`。
- `package.json`：`2|   "name": "@local/dsh-codewiki"`、`3|   "version": "0.10.11"`、`7|   "main": "index.js"`、`8|   "exports": {` 至 `11|   }`、`17|   "dependencies": {` 至 `19|   }`、`20|   "dsh": {` 至 `27|   }`。
- `.gitignore`：`1| node_modules/`、`2| vendor/codewiki/target/`、`3| *.log`、`6| bin/*.bak-*`、`8| .orch-test-out.txt`、`9| .probe3.txt`、`12| .dsh-ops/`。

## Architecture

```text
┌────────────────────────┐        ┌────────────────────────┐
│ client.js              │        │ cordis.patch.yml      │
│ (Settings+Panel UI)    │        │ (mount id=codewiki)   │
│ polls /api/codewiki/*  │        └───────────┬────────────┘
└───────────┬────────────┘                    │ loads
            │ GET/POST                        ▼
            │                        ┌────────────────────────┐
            │                        │ index.js (apply 3110)  │
            │                        │ Config + Tools + Svc   │
            └───────────────────────►│ createJobService 1238 │
                                     └───────────┬────────────┘
                                                 │ writes .codewiki/
                                                 ▼
                                     ┌────────────────────────┐
                                     │ package.json (meta)    │
                                     │ .gitignore (excluded)  │
                                     └────────────────────────┘
```

组件说明：
- `client.js` 不直接调用模型，仅通过宿主 webServer 回环端点与 `index.js` 通信（端点定义见 `installWebServer` `2686|`）。
- `index.js` 的 `apply`（`3110|`）经 `cordis.patch.yml` 挂载，启动时创建 `createJobService`（`1238|`）并 `service.start()` 以 `TICK_MS`（`1016|`）节拍推进。
- 模型通道唯一为宿主 `llm` 服务（`288| llmChat`），凭证由宿主按 provider 解析。

## Data Flow

1. 会话内调用 `codewiki_generate`（`2247|` 定义） → `execute`（`2291|`）运行 `cw status`（`2306|`）判态，调用 `svc.submit`（`2360|` / `2389|`）提交 job 并立即返回。
2. `createJobService` 的 `tick`（`2069|`）每 `TICK_MS`（`1016|`）被触发：依 `serialProjects` 闸门（`2079|`）与 `owner` 孤儿接管（`2086|`）逻辑，推进阶段机 `articles → crosscut → compose → review → index → commit`。
3. 文章阶段 `tickArticles`（`1619|`）调用 `prepareArticleTasks`（`560|`）装填源码，经 `submitBatchFor`（`1501|`）→ `startBatchChatRun`（`1459|`）→ `runRealtimeTasks`（`332|`）→ `llmChat`（`288|`）走宿主 llm。
4. 结果经 `settleJob`（`1356|`）收割，`applyTaskResult`（`311|`）/`writeValidated`（`1382|`）落盘 `.codewiki/`；`fixAnchors`（`401|`）校正行号。
5. `tickIndex`（`2010|`）跑 `cw index` 与 `ensureWikiEntry`（`214|`），随后若 `autoCommit` 开启进入 `tickCommit`（`2042|`）调用 `autoCommitWiki`（`2948|`）自动提交产物。
6. `client.js` 的 `CodewikiPanel`（`1145|`）每 `POLL_MS=2000`（`22|`）拉 `/api/codewiki/jobs`（`2727|` 端点）渲染进度；`ReposTab`（`1000|`）每 10s 拉 `/repos`（`2749|`）显示总览。
7. 编译终态经 `wakeCompileSession`（`1221|`）steer 唤醒发起会话；`commitHintText`（`3032|`）在系统提示注入提交提醒。

## Connections

本模块为插件唯一核心模块，暂无其他模块文章可链接。相关挂载点见 `cordis.patch.yml`（`13| - insert:`）与 `package.json` 的 `dsh.bundle.patch`（`25| "patch": "cordis.patch.yml"`）。

## Known Issues

- 旧版规划阶段任务残留：0.10.7 前任务可能卡在 `plan` 阶段（`2124| if (job.stage === 'plan')` 已做迁移到 `articles` 的处理），旧磁盘快照不可重跑。
- 会话通道兜底限制：`dispatchSessionTasks`（`1537|`）要求发起会话可用，面板/自动调度提交时若超预算且 `bigProvider` 留空会直接 `fail`（`1541|`），不降级回插件内通道。
- 跨实例并发：通过 `JOBS_LOCK_FILE`（`1130|`）与 `instanceId`（`1246|`）防止双提交，崩溃残留锁 60s 过期强删（`1139|`）。
- 配置竞态：`saveJobs`（`1150|`）只留最近 `MAX_JOBS_KEPT=30`（`1065|`），`mergeFromDisk`（`1270|`）防止活动 job 被过期快照覆盖。
- `client.js` 模型目录依赖 `/api/codewiki/models`（`2842|` 端点）：若宿主 llm 未注入则 `catalogError` 有值（`474|` 拉取失败 / `578|` 渲染手填），设置页退回手填形态。
- 自动提交分支合并式（`2948| autoCommitWiki`）在 detached HEAD（`2995|`）或建分支失败（`3001|`）时降级 direct，合并冲突时保留主题分支等手动合并。
- `.gitignore` 未忽略 `bin/cw` 本身（仅忽略 `bin/*.bak-*` `6|`），捆绑二进制需手动管理。
