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

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合，包含插件主入口 `index.js`、浏览器侧客户端 `client.js`、cordis 挂载补丁 `cordis.patch.yml`、包定义 `package.json` 与 git 忽略规则 `.gitignore`。`index.js` 提供了把 `mraza007/codewiki`（Rust CLI `cw`）接入 DeepSeek Harness 的全部能力：基础工具 `cw`（`1007|` 定义 `cwToolDefinition`，工具名 `cw`）、`codewiki_generate`（`2570|` 定义 `generateToolDefinition`）、只读进度工具 `codewiki_progress`（`2829|` 定义 `progressToolDefinition`）、更新快捷工具 `codewiki_update`（`2758|` 定义 `updateToolDefinition`），以及后台常驻编排服务（阶段机 `articles → crosscut → compose → review → index → commit`，见 `createJobService` `1509|`）、宿主 webServer 端点（`/api/codewiki/*`，`installWebServer` `3037|`）、会话系统提示提醒注入（`installUpdateReminder` `3493|`）与编译产物自动提交（`autoCommitWiki` `3365|`）。`client.js` 在浏览器半侧挂载「插件」设置页（`CodewikiCard` `516|`）与侧边栏编译任务面板（`CodewikiPanel` `1312|`），通过 `configForms` 读写配置、轮询 `/api/codewiki/jobs`（`3080|` 端点）与 `/api/codewiki/repos`（`3120|`）展示进度与总览。`cordis.patch.yml` 以 `insert` 方式将 `index.js` 注册为 id `codewiki` 的插件（`13|`）；`package.json` 声明包名 `@local/dsh-codewiki`、版本 `0.12.1`（`3|`）、入口与 exports（`7|`）；`.gitignore` 排除 `node_modules/`、`vendor/codewiki/target/`、日志与运行期产物。

## Key Components

### index.js 导出与核心常量

- `17| const pluginDir = path.dirname(fileURLToPath(import.meta.url))` — 插件目录绝对路径，用于定位捆绑 `bin/cw`。
- `18| const PLUGIN_NAME = 'dsh-codewiki'`、`19| export const name = PLUGIN_NAME` — 插件名导出。
- `20| const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']` — `cw` 工具允许的子命令白名单。
- `22| const CONCURRENCY_HARD_CAP = 8` — 并发硬顶；`24| const DEFAULT_CONCURRENCY = 2` — 默认并发（hy3 免费档）。
- `26| const DEFAULT_BATCH_PROVIDER = 'workbuddy'`、`27| const DEFAULT_BATCH_MODEL = 'hy3'` — 默认编译模型。
- `30| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`31| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`33| const DEFAULT_BIG_TOKEN_BUDGET = 420000` — 大档模型（超长输入）默认配置。
- `36| const WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` — 自动提交与状态判定唯二认径（不扩 `-A`）。
- `51| export const Config = z.object({` 至 `72| })` — 插件配置 schema（schemastery），字段含 `enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`parallelProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`，全部 `.volatile()`。
- `489| const BATCH_TOKEN_BUDGET = 110000`、`494| const BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与硬上限。
- `1130| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')`、`1131| const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)`、`1135| const SESSION_TASK_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.DSH_CODEWIKI_SESSION_TIMEOUT_MS) || 30 * 60 * 1000)`、`1136| const SESSION_TASK_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')` — 任务持久化文件、tick 间隔、会话通道超时与任务目录。
- `1147| export const SESSIONS_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-sessions')`、`1148| const SESSION_FLUSH_MS = 3000` — 会话内容记录目录与节流写间隔。
- `1323| const ORPHAN_TAKEOVER_MS = Math.max(60000, Number(process.env.DSH_CODEWIKI_ORPHAN_TAKEOVER_MS) || 5 * 60 * 1000)`、`1324| const MAX_JOBS_KEPT = 30` — 孤儿接管阈值与历史截断数。
- `1329| const REPOS_FILE = process.env.DSH_CODEWIKI_REPOS_FILE || path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')` — 已知仓库清单持久化。
- `1357| const SCAN_SKIP_DIRS = new Set([...])`、`1362| const SCAN_SKIP_EXT = new Set([...])`、`1368| const SCAN_MAX_FILE_BYTES = 256 * 1024`、`1369| const SCAN_MAX_FILES = 2000` — 仓库源码扫描黑名单。

### index.js 内部函数与工具定义

- `40| function normalizeCwd(input) {` 至 `45| }` — Windows/Git-Bash 盘符路径归一化为 `C:/...`。
- `74| function val(x) {` 至 `76| }` — 从 cordis 配置容器取值。
- `78| function liveConfig(config) {` 至 `108| }` — 将原始配置规范化为运行期可用的扁平对象（含并发钳制、大档预算兜底）。
- `114| function resolveBinary(cfg) {` 至 `134| }` — 解析 `cw` 可执行文件：优先 PATH，回退捆绑 `bin/cw(.exe)`。
- `136| function runCw(binary, cwd, args, timeoutMs = 120000, signal) {` 至 `161| }` — spawn `cw` 子进程并带超时/中止收集 stdout/stderr。
- `173| export function normalizeArticlePath(p) {` — 将路径内 `\` 规范为 `/`。
- `177| export function normalizeIndexLinks(cwd) {` 至 `185| }` — 修正 `_index.md` 链接头内的反斜杠。
- `187| export function parseStatus(stdout) {` 至 `200| }` — 解析 `cw status` 三态/变更/过期输出。
- `203| function countWikiArticles(wikiPath) {` 至 `215| }` — 递归统计 `.codewiki/` 下 `.md` 篇数。
- `220| export function ensureWikiEntry(cwd, language = '中文') {` 至 `253| }` — 仓库根缺失 `CodeWiki.md` 时自动生成入口（中/英），已有不覆盖。
- `258| function excludedItem(cwd, list) {` 至 `267| }`、`268| function isExcluded(cwd, list) {` 至 `270| }` — 排除清单命中判定（绝对路径子树）。
- `283| export function detectLinkedWorktree(cwd) {` 至 `299| }` — 用 `git rev-parse --git-dir/--git-common-dir` 检测 linked worktree，避免给 worktree 编译。
- `368| export function estimateTokens(text) {` 至 `376| }` — 粗算 token（CJK≈1/字，其余≈3.5字符/token）。
- `386| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta }) {` 至 `411| }` — 唯一模型通道：走宿主 `llm.stream`，返回 content 与 outputTokens，不支持的 effort 自动重试。
- `415| function applyTaskResult(task, content, notes) {` 至 `431| }` — 任务结果落盘或回内存（含 `fixAnchors` 校正）。
- `439| export async function runRealtimeTasks(tasks, {...}) {` 至 `476| }` — 并发池执行器，按 `maxConcurrency` 消费队列，支持 `onRequestStart` 挂会话记录。
- `498| function readJsonFile(p) {` 至 `500| }` — 安全读取 JSON。
- `505| export function numberLines(content) {` 至 `507| }` — 为源码每行加 `N| ` 前缀。
- `516| export function fixAnchors(content, cwd) {` 至 `600| }` — 行号锚点自动修正（第四层兜底），对照源码确定性校正 `file:NN` 引用。
- `604| export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET) {` 至 `631| }` — 按 token 预算整文件内联源码，返回 `{text, skipped, oversized}`。
- `635| function batchArticlePrompt({...}) {` 至 `662| }` — 单轮文章 prompt 组装。
- `675| export function prepareArticleTasks(tasks, {...}) {` 至 `760| }` — 将通用任务装配为批量/大档/观察/会话任务。
- `766| function articleFormatSection() {` 至 `795| }` — 文章格式条款模板。
- `800| export function localPlan(files) {` 至 `813| }` — 按顶层目录分组生成本地模块清单。
- `817| export function packArticles(articles, budget = BATCH_TOKEN_BUDGET) {` 至 `836| }` — 横切输入装配（超预算截头部）。
- `838| function crosscutIntro(language, what, requirements) {` 至 `850| }`、`852| function batchArchitecturePrompt(language, articlesText) {` 至 `858| }`、`860| function batchPatternsPrompt(language, articlesText) {` 至 `866| }`、`868| function batchConceptPrompt(language, concept, articlesText) {` 至 `874| }` — 横切 prompt 构造。
- `878| function batchObservePrompt(language, moduleName, articleText) {` 至 `895| }`、`899| function batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal) {` 至 `915| }` — 观察批 prompt。
- `919| function batchArticleComposePrompt({...}) {` 至 `947| }` — 文章分割合成 prompt。
- `951| function batchProofreadPrompt({...}) {` 至 `970| }`、`974| function batchProofreadBatchPrompt(language, items) {` 至 `1001| }` — 批量校对 prompt（单篇/合并分节）。
- `1007| function cwToolDefinition(cfg) {` 至 `1069| }` — 工具 `cw` 定义（封装 CLI）。
- `1078| function slugify(name) {` 至 `1080| }` — 模块名 slug（保留 CJK）。
- `1084| function parseSourceFiles(fm) {` 至 `1096| }`、`1098| function readSourceFiles(articlePath) {` 至 `1106| }` — frontmatter `source_files` 解析。
- `1108| async function wikiPathFor(cwd, binary, signal) {` 至 `1113| }` — 取 wiki 目录（默认 `<repo>/.codewiki`）。
- `1150| function sessionDirFor(jobId) {` 至 `1152| }`、`1153| function writeSessionMeta(jobId, meta) {` 至 `1159| }`、`1160| function writeSessionFull(jobId, n, full) {` 至 `1166| }`、`1168| export function listSessionRecords(jobId) {` 至 `1177| }`、`1178| export function readSessionRecord(jobId, n) {` 至 `1180| }` — 会话记录目录、轻量元数据与全文落盘函数。
- `1184| export function listAllSessionRecords({ limit = 200, jobIds = null } = {}) {` 至 `1204| }` — 跨任务聚合会话记录。
- `1206| export function pruneSessionRecords(nowMs = Date.now(), ttlMs = SESSION_TTL_MS) {` 至 `1226| }` — 过期清理（保留 24h）。
- `1229| function textDeltaOf(chunk) {` 至 `1236| }` — 从流式 chunk 提取文本增量。
- `1238| function beginSessionRecord(job, task) {` 至 `1280| }` — 开始记录一个请求（写 meta+full，返回句柄）。
- `1286| export function classifySessionTask(task, nowMs = Date.now()) {` 至 `1296| }` — 会话通道任务收割三态判定（纯函数）。
- `1303| export function buildSessionSteerText({ job, snapshots, tier = '', resend = false }) {` 至 `1321| }` — 会话通道 steer 文本（纯函数，档位钉死）。
- `1330| function loadKnownRepos() {` 至 `1332| }`、`1333| function rememberRepo(cwd) {` 至 `1341| }` — 已知仓库持久化。
- `1354| const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])` — 终态集合。
- `1371| export function scanRepoFiles(cwd) {` 至 `1394| }` — 仓库源码扫描（黑名单/大小/总数限制）。
- `1396| function loadJobs() {` 至 `1399| }`、`1401| const JOBS_LOCK_FILE = `${JOBS_FILE}.lock``、`1404| function acquireTickLock() {` 至 `1418| }`、`1419| function releaseTickLock() {` 至 `1419| }`、`1421| function saveJobs(jobs) {` 至 `1426| }` — 任务文件读写与跨进程锁。
- `1428| function jobSummary(job) {` 至 `1465| }` — 任务摘要（含 tps 聚合、autoCommit 字段）。
- `1472| let agentsRef = null`、`1477| let llmRef = null` — 代理与 llm 服务引用（apply 时注入）。
- `1485| export function autoCommitState(job) {` 至 `1490| }` — 自动提交三态（committed/no-changes/pending）判定，唤醒与提醒共用。
- `1492| export function wakeCompileSession(job, outcome, agents = agentsRef) {` 至 `1507| }` — 编译终态向发起会话 steer 唤醒（成功且已自动提交时不打扰）。
- `1509| function createJobService(config, onSettled) {` 至 `2563| }` — 核心编排服务：含 `submit`（`2451|`）、`cancel`（`2538|`）、`list`（`2549|`）、`findActive`（`2550|`）、`start`（`2552|`）、`stop`（`2557|`）及阶段处理 `tickArticles`（`1913|`）/`tickCrosscut`（`2058|`）/`tickCompose`（`2143|`）/`tickReview`（`2192|`）/`tickIndex`（`2304|`）/`tickCommit`（`2336|`）、执行器 `startBatchChatRun`（`1752|`）/`submitBatchFor`（`1795|`）、会话通道 `dispatchSessionTasks`（`1831|`）/`progressSessionTasks`（`1869|`）/`resendSessionSteer`（`1892|`）、内部辅助 `settleJob`（`1649|`）/`writeValidated`（`1675|`）/`tally`（`1694|`）/`settleProofread`（`1719|`）/`mergeFromDisk`（`1563|`）/`tick`（`2363|`）。
- `2570| function generateToolDefinition(cfg, svc) {` 至 `2748| }` — 工具 `codewiki_generate`（提交制，判态与提交）。
- `2758| function updateToolDefinition(cfg, generateDef) {` 至 `2810| }` — 工具 `codewiki_update`（scope=auto 快捷入口）。
- `2818| function samePath(a, b) {` 至 `2821| }`、`2823| function progressView(job) {` 至 `2827| }`、`2829| function progressToolDefinition(cfg, svc) {` 至 `2933| }` — 工具 `codewiki_progress`（只读查进度）与辅助。
- `2939| function isLoopbackRequest(req) {` 至 `2942| }`、`2944| function writeJson(res, code, obj) {` 至 `2948| }`、`2950| function readBodyJson(req) {` 至 `2968| }` — webServer 辅助。
- `2975| export async function listModelCatalog(llm) {` 至 `2996| }`、`3002| const resolveModelInfoOf = (llm) => {...}` 至 `3007| }`、`3013| export async function resolveModelEfforts(llm, provider, model) {` 至 `3035| }` — 模型目录与思考档位枚举。
- `3037| export function installWebServer(ctx, service, extra = {}) {` 至 `3332| }` — 挂载 `/api/codewiki/jobs`（`3080|`）、`/repos`（`3120|`）、`/sessions`（`3215|`）、`/sessions/item`（`3237|`）、`/models`（`3261|`）、`/model-efforts`（`3280|`）、`/control`（`3301|`）端点（仅回环）。
- `3365| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {` 至 `3447| }` — 编译产物自动提交（分支合并式：主题分支提交后合并回原分支，仅 add `.codewiki/` 与 `CodeWiki.md`，安全边界检查）。
- `3449| export function commitHintText(cwd, jobs = loadJobs()) {` 至 `3480| }` — 编译完成未提交提醒文本（60s 缓存）。
- `3482| function reminderText(cwd) {` 至 `3491| }` — 会话系统提示 wiki 维护提醒文本。
- `3493| function installUpdateReminder(ctx, config) {` 至 `3525| }` — 注入 systemPrompt section。
- `3527| export function apply(ctx, config) {` 至 `3592| }` — 插件入口：注入 `agents`/`llm`、启动服务、注册工具与面板、自动更新调度器。

### client.js 组件

- `10| window.__ModuleLoader__.load({` 至 `12|   factory(require) {` — 客户端模块加载入口，id `@local/dsh-codewiki`。
- `17| const NS = 'codewiki'`、`18| const KEY = 'codewiki'`、`19| const JOBS_PATH = '/api/codewiki/jobs'`、`20| const CONTROL_PATH = '/api/codewiki/control'`、`21| const PANEL_ORDER = 52`、`22| const POLL_MS = 2000`、`23| const REPOS_PATH = '/api/codewiki/repos'`、`24| const SESSIONS_PATH = '/api/codewiki/sessions'`、`25| const SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'`、`26| const MODELS_PATH = '/api/codewiki/models'`、`27| const EFFORTS_PATH = '/api/codewiki/model-efforts'`、`31| const REPOS_POLL_MS = 10000`、`33| const ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']` — 常量与端点（注意 ACTIVE_STAGES 含 commit）。
- `35| const zh = () => ({` 至 `193| })`、`194| const en = () => ({` 至 `352| })` — 中英文案词典。
- `354| const style = document.createElement('style')` 至 `356| style.textContent = [` 与 `451| if (!document.head.querySelector('style[data-plugin="@local/dsh-codewiki"]')) document.head.appendChild(style)` — 注入面板与设置页 CSS。
- `453| function el(tag, props, ...children) {` 至 `455| }`、`457| async function apiGet(p) {` 至 `462| }`、`463| async function apiPost(p, data) {` 至 `472| }` — React 元素构造与 fetch 封装。
- `474| return {` 至 `475| inject: ['slots', 'locale', 'configForms'],`、`476| apply(ctx) {` 至 `1573| },` — 客户端 apply：注册词典、设置页 `plugins.item`、侧边栏 `main`/`sidebar.panellist`。
- `516| function CodewikiCard(props) {` 至 `930| }` — 设置卡片组件（view='summary' 简介 / 'page' 完整表单），含 `modelTrio`（`626|` 定义）渲染提供商/模型/思考档位级联下拉、目录联动、保存/放弃逻辑，`useEfforts`（`588|`）拉取思考档位。
- `936| const stageLabel = (stage) => ...`、`937| const stateLabel = (st) => ...`、`938| const kindLabelOf = ...`、`939| const progressBar = ...`、`943| const repoName = ...`、`947| const fmtMs = ...`、`954| const fmtTok = ...`、`960| const fmtDur = ...`、`966| const fmtAgo = ...`、`971| const Spark = ...`、`987| const stepName = ...`、`990| const lastTimedStage = ...`、`994| const stageBar = ...`、`1018| const STAGE_WEIGHTS = {...}`、`1019| const overallPct = ...`、`1030| const throughputBadge = ...`、`1052| const usageLine = ...` — 展示辅助（步骤条/吞吐/用量渲染）。
- `1071| function ReposTab() {` 至 `1214| }` — 总览标签页：轮询 `/repos`，展示各仓库 wiki 状态、调度信息、排除切换、立即编译。
- `1220| function SessionView({ job, onClose }) {` 至 `1310| }` — 会话视图：某任务的 LLM 请求记录列表与全文查看。
- `1312| function CodewikiPanel() {` 至 `1557| }` — 侧边栏面板主组件：轮询 `/jobs`，分组展示任务卡、取消、复制路径、活动流、会话入口。
- `1559| function PanelIcon(props) {` 至 `1570| }` — 面板图标（摊开的书）。

### 配置文件

- `cordis.patch.yml`：`13| - insert:` 至 `16|       config: {}` — 以 `id: codewiki` 挂载 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`。
- `package.json`：`2|   "name": "@local/dsh-codewiki"`、`3|   "version": "0.12.1"`、`7|   "main": "index.js"`、`8|   "exports": {` 至 `11|   }`、`17|   "dependencies": {` 至 `19|   }`、`20|   "dsh": {` 至 `27|   }`。
- `.gitignore`：`1| node_modules/`、`2| vendor/codewiki/target/`、`3| *.log`、`6| bin/*.bak-*`、`8| .orch-test-out.txt`、`9| .probe3.txt`、`11| .dsh-ops/`。

## Architecture

```text
┌────────────────────────┐        ┌────────────────────────┐
│ client.js              │        │ cordis.patch.yml      │
│ (Settings+Panel UI)    │        │ (mount id=codewiki)   │
│ polls /api/codewiki/*  │        └───────────┬────────────┘
└───────────┬────────────┘                    │ loads
            │ GET/POST                        ▼
            │                        ┌────────────────────────┐
            │                        │ index.js (apply 3527)  │
            │                        │ Config + Tools + Svc   │
            └───────────────────────►│ createJobService 1509  │
                                     └───────────┬────────────┘
                                                 │ writes .codewiki/
                                                 ▼
                                     ┌────────────────────────┐
                                     │ package.json (meta)    │
                                     │ .gitignore (excluded)  │
                                     └────────────────────────┘
```

组件说明：
- `client.js` 不直接调用模型，仅通过宿主 webServer 回环端点与 `index.js` 通信（端点定义见 `installWebServer` `3037|`）。
- `index.js` 的 `apply`（`3527|`）经 `cordis.patch.yml` 挂载，启动时创建 `createJobService`（`1509|`）并 `service.start()` 以 `TICK_MS`（`1131|`）节拍推进。
- 模型通道唯一为宿主 `llm` 服务（`386| llmChat`），凭证由宿主按 provider 解析。

## Data Flow

1. 会话内调用 `codewiki_generate`（`2570|` 定义） → `execute`（`2614|`）运行 `cw status`（`2653|`）判态，调用 `svc.submit`（`2451|`）提交 job 并立即返回。
2. `createJobService` 的 `tick`（`2363|`）每 `TICK_MS`（`1131|`）被触发：依 `serialProjects` 闸门（`2377|`）与 `owner` 孤儿接管（`2389|`）逻辑，推进阶段机 `articles → crosscut → compose → review → index → commit`。
3. 文章阶段 `tickArticles`（`1913|`）调用 `prepareArticleTasks`（`675|`）装填源码，经 `submitBatchFor`（`1795|`）→ `startBatchChatRun`（`1752|`）→ `runRealtimeTasks`（`439|`）→ `llmChat`（`386|`）走宿主 llm。
4. 结果经 `settleJob`（`1649|`）收割，`applyTaskResult`（`415|`）/`writeValidated`（`1675|`）落盘 `.codewiki/`；`fixAnchors`（`516|`）校正行号。
5. `tickIndex`（`2304|`）跑 `cw index` 与 `ensureWikiEntry`（`220|`），随后若 `autoCommit` 开启进入 `tickCommit`（`2336|`）调用 `autoCommitWiki`（`3365|`）自动提交产物。
6. `client.js` 的 `CodewikiPanel`（`1312|`）每 `POLL_MS=2000`（`22|`）拉 `/api/codewiki/jobs`（`3080|` 端点）渲染进度；`ReposTab`（`1071|`）每 10s 拉 `/repos`（`3120|`）显示总览。
7. 编译终态经 `wakeCompileSession`（`1492|`）steer 唤醒发起会话；`commitHintText`（`3449|`）在系统提示注入提交提醒。

## Connections

本模块为插件唯一核心模块，暂无其他模块文章可链接。相关挂载点见 `cordis.patch.yml`（`13| - insert:`）与 `package.json` 的 `dsh.bundle.patch`（`25| "patch": "cordis.patch.yml"`）。

## Known Issues

- 旧版规划阶段任务残留：0.10.7 前任务可能卡在 `plan` 阶段（`2427| if (job.stage === 'plan')` 已做迁移到 `articles` 的处理），旧磁盘快照不可重跑。
- 会话通道兜底限制：`dispatchSessionTasks`（`1831|`）要求发起会话可用，面板/自动调度提交时若超预算且 `bigProvider` 留空会直接 `fail`（`1835|`），不降级回插件内通道。
- 跨实例并发：通过 `JOBS_LOCK_FILE`（`1401|`）与 `instanceId`（`1517|`）防止双提交，崩溃残留锁 60s 过期强删（`1410|`）。
- 配置竞态：`saveJobs`（`1421|`）只留最近 `MAX_JOBS_KEPT=30`（`1324|`），`mergeFromDisk`（`1563|`）防止活动 job 被过期快照覆盖。
- `client.js` 模型目录依赖 `/api/codewiki/models`（`3261|` 端点）：若宿主 llm 未注入则 `catalogError` 有值（`526|` 声明 / `533|` 渲染手填），设置页退回手填形态。
- 自动提交分支合并式（`3365| autoCommitWiki`）在 detached HEAD（`3412|`）或建分支失败（`3417|`）时降级 direct，合并冲突时保留主题分支等手动合并。
- `.gitignore` 未忽略 `bin/cw` 本身（仅忽略 `bin/*.bak-*` `6|`），捆绑二进制需手动管理。
