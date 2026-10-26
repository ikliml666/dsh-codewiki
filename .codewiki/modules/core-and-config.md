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

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合，包含插件主入口 `index.js`、浏览器侧客户端 `client.js`、cordis 挂载补丁 `cordis.patch.yml`、包定义 `package.json` 与 git 忽略规则 `.gitignore`。`index.js` 提供了把 `mraza007/codewiki`（Rust CLI `cw`）接入 DeepSeek Harness 的全部能力：基础工具 `cw`（`1039|` 定义 `cwToolDefinition`，工具名 `cw`）、`codewiki_generate`（`2611|` 定义 `generateToolDefinition`）、只读进度工具 `codewiki_progress`（`2870|` 定义 `progressToolDefinition`）、更新快捷工具 `codewiki_update`（`2799|` 定义 `updateToolDefinition`），以及后台常驻编排服务（阶段机 `articles → crosscut → compose → review → index → commit`，见 `createJobService` `1541|`）、宿主 webServer 端点（`/api/codewiki/*`，`installWebServer` `3078|`）、会话系统提示提醒注入（`installUpdateReminder` `3534|`）与编译产物自动提交（`autoCommitWiki` `3406|`）。`client.js` 在浏览器半侧挂载「插件」设置页（`CodewikiCard` `520|`）与侧边栏编译任务面板（`CodewikiPanel` `1332|`），通过 `configForms` 读写配置、轮询 `/api/codewiki/jobs`（端点定义见 `3119|` 起的 `ws.register`）与 `/api/codewiki/repos`（`3159|` 起）展示进度与总览。`cordis.patch.yml` 以 `insert` 方式将 `index.js` 注册为 id `codewiki` 的插件（`14|`）；`package.json` 声明包名 `@local/dsh-codewiki`、版本 `0.12.2`（`3|`）、入口与 exports（`7|`）；`.gitignore` 排除 `node_modules/`、`vendor/codewiki/target/`、日志与运行期产物。

## Key Components

### index.js 导出与核心常量

- `17| const pluginDir = path.dirname(fileURLToPath(import.meta.url))` — 插件目录绝对路径，用于定位捆绑 `bin/cw`。
- `18| const PLUGIN_NAME = 'dsh-codewiki'`、`19| export const name = PLUGIN_NAME` — 插件名导出。
- `20| const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']` — `cw` 工具允许的子命令白名单。
- `22| const CONCURRENCY_HARD_CAP = 8` — 并发硬顶；`24| const DEFAULT_CONCURRENCY = 2` — 默认并发（hy3 免费档）。
- `26| const DEFAULT_BATCH_PROVIDER = 'workbuddy'`、`27| const DEFAULT_BATCH_MODEL = 'hy3'` — 默认编译模型。
- `30| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`31| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`33| const DEFAULT_BIG_TOKEN_BUDGET = 420000` — 大档模型（超长输入）默认配置。
- `36| const WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` — 自动提交与状态判定唯二认径（不扩 `-A`）。
- `51| export const Config = z.object({` 至 `73| })` — 插件配置 schema（schemastery），字段含 `enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`parallelProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`，全部 `.volatile()`。
- `521| const BATCH_TOKEN_BUDGET = 110000`、`526| const BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与硬上限。
- `1162| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')`、`1163| const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)`、`1167| const SESSION_TASK_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.DSH_CODEWIKI_SESSION_TIMEOUT_MS) || 30 * 60 * 1000)`、`1168| const SESSION_TASK_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')` — 任务持久化文件、tick 间隔、会话通道超时与任务目录。
- `1179| export const SESSIONS_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-sessions')`、`1180| const SESSION_FLUSH_MS = 3000` — 会话内容记录目录与节流写间隔。
- `1355| const ORPHAN_TAKEOVER_MS = Math.max(60000, Number(process.env.DSH_CODEWIKI_ORPHAN_TAKEOVER_MS) || 5 * 60 * 1000)`、`1356| const MAX_JOBS_KEPT = 30` — 孤儿接管阈值与历史截断数。
- `1361| const REPOS_FILE = process.env.DSH_CODEWIKI_REPOS_FILE || path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')` — 已知仓库清单持久化。
- `1389| const SCAN_SKIP_DIRS = new Set([...])`、`1394| const SCAN_SKIP_EXT = new Set([...])`、`1400| const SCAN_MAX_FILE_BYTES = 256 * 1024`、`1401| const SCAN_MAX_FILES = 2000` — 仓库源码扫描黑名单。

### index.js 内部函数与工具定义

- `40| function normalizeCwd(input) {` 至 `45| }` — Windows/Git-Bash 盘符路径归一化为 `C:/...`。
- `75| function val(x) {` 至 `77| }` — 从 cordis 配置容器取值。
- `79| function liveConfig(config) {` 至 `114| }` — 将原始配置规范化为运行期可用的扁平对象（含并发钳制、大档预算兜底）。
- `120| function resolveBinary(cfg) {` 至 `140| }` — 解析 `cw` 可执行文件：优先 PATH，回退捆绑 `bin/cw(.exe)`。
- `142| function runCw(binary, cwd, args, timeoutMs = 120000, signal) {` 至 `167| }` — spawn `cw` 子进程并带超时/中止收集 stdout/stderr。
- `179| export function normalizeArticlePath(p) {` — 将路径内 `\` 规范为 `/`。
- `183| export function normalizeIndexLinks(cwd) {` 至 `191| }` — 修正 `_index.md` 链接头内的反斜杠。
- `193| export function parseStatus(stdout) {` 至 `206| }` — 解析 `cw status` 三态/变更/过期输出。
- `209| function countWikiArticles(wikiPath) {` 至 `221| }` — 递归统计 `.codewiki/` 下 `.md` 篇数。
- `226| export function ensureWikiEntry(cwd, language = '中文') {` 至 `259| }` — 仓库根缺失 `CodeWiki.md` 时自动生成入口（中/英），已有不覆盖。
- `264| function excludedItem(cwd, list) {` 至 `273| }`、`274| function isExcluded(cwd, list) {` 至 `276| }` — 排除清单命中判定（绝对路径子树）。
- `289| export function detectLinkedWorktree(cwd) {` 至 `305| }` — 用 `git rev-parse --git-dir/--git-common-dir` 检测 linked worktree，避免给 worktree 编译。
- `313| export function isWorktreeCwd(cwd) {` 至 `324| }` — 带 60s 缓存的 worktree 判定（面板轮询用）。
- `332| export function hasCompilableSources(cwd) {` 至 `346| }` — 目录是否还有可编译源码（带 10 分钟缓存）。
- `348| export function clearSourceProbeCache(cwd) {` 至 `351| }` — 清探测缓存。
- `358| export function isDeadCompileTarget(cwd) {` 至 `366| }` — 统一判定「非有效编译对象」（worktree 或空壳）。
- `374| export function estimateTokens(text) {` 至 `382| }` — 粗算 token（CJK≈1/字，其余≈3.5字符/token）。
- `392| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta }) {` 至 `417| }` — 唯一模型通道：走宿主 `llm.stream`，返回 content 与 outputTokens，不支持的 effort 自动重试。
- `421| function applyTaskResult(task, content, notes) {` 至 `434| }` — 任务结果落盘或回内存（含 `fixAnchors` 校正）。
- `449| export async function runRealtimeTasks(tasks, {...}) {` 至 `508| }` — 并发池执行器，按 `maxConcurrency`/`bigConcurrency` 分池消费队列，支持 `onRequestStart` 挂会话记录。
- `530| function readJsonFile(p) {` 至 `532| }` — 安全读取 JSON。
- `537| export function numberLines(content) {` 至 `539| }` — 为源码每行加 `N| ` 前缀。
- `548| export function fixAnchors(content, cwd) {` 至 `631| }` — 行号锚点自动修正（第四层兜底），对照源码确定性校正 `file:NN` 引用。
- `636| export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET) {` 至 `663| }` — 按 token 预算整文件内联源码，返回 `{text, skipped, oversized}`。
- `667| function batchArticlePrompt({...}) {` 至 `694| }` — 单轮文章 prompt 组装。
- `707| export function prepareArticleTasks(tasks, {...}) {` 至 `792| }` — 将通用任务装配为批量/大档/观察/会话任务。
- `798| function articleFormatSection() {` 至 `827| }` — 文章格式条款模板。
- `832| export function localPlan(files) {` 至 `845| }` — 按顶层目录分组生成本地模块清单。
- `849| export function packArticles(articles, budget = BATCH_TOKEN_BUDGET) {` 至 `868| }` — 横切输入装配（超预算截头部）。
- `870| function crosscutIntro(language, what, requirements) {` 至 `882| }`、`884| function batchArchitecturePrompt(language, articlesText) {` 至 `890| }`、`892| function batchPatternsPrompt(language, articlesText) {` 至 `898| }`、`900| function batchConceptPrompt(language, concept, articlesText) {` 至 `906| }` — 横切 prompt 构造。
- `910| function batchObservePrompt(language, moduleName, articleText) {` 至 `927| }`、`931| function batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal) {` 至 `947| }` — 观察批 prompt。
- `951| function batchArticleComposePrompt({...}) {` 至 `979| }` — 文章分割合成 prompt。
- `983| function batchProofreadPrompt({...}) {` 至 `1002| }`、`1006| function batchProofreadBatchPrompt(language, items) {` 至 `1033| }` — 批量校对 prompt（单篇/合并分节）。
- `1039| function cwToolDefinition(cfg) {` 至 `1102| }` — 工具 `cw` 定义（封装 CLI）。
- `1110| function slugify(name) {` 至 `1112| }` — 模块名 slug（保留 CJK）。
- `1116| function parseSourceFiles(fm) {` 至 `1128| }`、`1130| function readSourceFiles(articlePath) {` 至 `1138| }` — frontmatter `source_files` 解析。
- `1140| async function wikiPathFor(cwd, binary, signal) {` 至 `1145| }` — 取 wiki 目录（默认 `<repo>/.codewiki`）。
- `1182| function sessionDirFor(jobId) {` 至 `1184| }`、`1185| function writeSessionMeta(jobId, meta) {` 至 `1191| }`、`1192| function writeSessionFull(jobId, n, full) {` 至 `1198| }`、`1200| export function listSessionRecords(jobId) {` 至 `1209| }`、`1210| export function readSessionRecord(jobId, n) {` 至 `1212| }` — 会话记录目录、轻量元数据与全文落盘函数。
- `1216| export function listAllSessionRecords({ limit = 200, jobIds = null } = {}) {` 至 `1236| }` — 跨任务聚合会话记录。
- `1238| export function pruneSessionRecords(nowMs = Date.now(), ttlMs = SESSION_TTL_MS) {` 至 `1258| }` — 过期清理（保留 24h）。
- `1261| function textDeltaOf(chunk) {` 至 `1268| }` — 从流式 chunk 提取文本增量。
- `1270| function beginSessionRecord(job, task) {` 至 `1312| }` — 开始记录一个请求（写 meta+full，返回句柄）。
- `1318| export function classifySessionTask(task, nowMs = Date.now()) {` 至 `1328| }` — 会话通道任务收割三态判定（纯函数）。
- `1335| export function buildSessionSteerText({ job, snapshots, tier = '', resend = false }) {` 至 `1353| }` — 会话通道 steer 文本（纯函数，档位钉死）。
- `1362| function loadKnownRepos() {` 至 `1364| }`、`1365| function rememberRepo(cwd) {` 至 `1373| }`、`1376| export function forgetRepo(cwd) {` 至 `1385| }` — 已知仓库持久化与反登记。
- `1386| const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])` — 终态集合。
- `1403| export function scanRepoFiles(cwd) {` 至 `1426| }` — 仓库源码扫描（黑名单/大小/总数限制）。
- `1428| function loadJobs() {` 至 `1431| }`、`1433| const JOBS_LOCK_FILE = \`${JOBS_FILE}.lock\``、`1436| function acquireTickLock() {` 至 `1450| }`、`1451| function releaseTickLock() {` 至 `1451| }`、`1453| function saveJobs(jobs) {` 至 `1458| }` — 任务文件读写与跨进程锁。
- `1460| function jobSummary(job) {` 至 `1497| }` — 任务摘要（含 tps 聚合、autoCommit 字段）。
- `1504| let agentsRef = null`、`1509| let llmRef = null` — 代理与 llm 服务引用（apply 时注入）。
- `1517| export function autoCommitState(job) {` 至 `1522| }` — 自动提交三态（committed/no-changes/pending）判定，唤醒与提醒共用。
- `1524| export function wakeCompileSession(job, outcome, agents = agentsRef) {` 至 `1539| }` — 编译终态向发起会话 steer 唤醒（成功且已自动提交时不打扰）。
- `1541| function createJobService(config, onSettled) {` 至 `2606| }` — 核心编排服务：含 `submit`（`2492|`）、`cancel`（`2579|`）、`list`（`2590|`）、`findActive`（`2591|`）、`start`（`2593|`）、`stop`（`2598|`）及阶段处理 `tickArticles`（`1952|`）/`tickCrosscut`（`2097|`）/`tickCompose`（`2183|`）/`tickReview`（`2232|`）/`tickIndex`（`2345|`）/`tickCommit`（`2377|`）、执行器 `startBatchChatRun`（`1784|`）/`submitBatchFor`（`1828|`）/`settleJob`（`1681|`）/`writeValidated`（`1707|`）/`tally`（`1726|`）/`settleProofread`（`1751|`）/`dispatchSessionTasks`（`1870|`）/`progressSessionTasks`（`1908|`）/`resendSessionSteer`（`1931|`）/`mergeFromDisk`（`1595|`）/`tick`（`2404|`）。
- `2611| function generateToolDefinition(cfg, svc) {` 至 `2789| }` — 工具 `codewiki_generate`（提交制，判态与提交）。
- `2799| function updateToolDefinition(cfg, generateDef) {` 至 `2851| }` — 工具 `codewiki_update`（scope=auto 快捷入口）。
- `2859| function samePath(a, b) {` 至 `2862| }`、`2864| function progressView(job) {` 至 `2868| }`、`2870| function progressToolDefinition(cfg, svc) {` 至 `2974| }` — 工具 `codewiki_progress`（只读查进度）与辅助。
- `2980| function isLoopbackRequest(req) {` 至 `2983| }`、`2985| function writeJson(res, code, obj) {` 至 `2989| }`、`2991| function readBodyJson(req) {` 至 `3009| }` — webServer 辅助。
- `3016| export async function listModelCatalog(llm) {` 至 `3037| }`、`3043| const resolveModelInfoOf = (llm) => {...}` 至 `3048| }`、`3054| export async function resolveModelEfforts(llm, provider, model) {` 至 `3076| }` — 模型目录与思考档位枚举。
- `3078| export function installWebServer(ctx, service, extra = {}) {` 至 `3373| }` — 挂载 `/api/codewiki/jobs`（`3119|` 起）、`/repos`（`3159|` 起）、`/sessions`（`3254|` 起）、`/sessions/item`（`3276|` 起）、`/models`（`3300|` 起）、`/model-efforts`（`3319|` 起）、`/control`（`3340|` 起）端点（仅回环）。
- `3406| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {` 至 `3488| }` — 编译产物自动提交（分支合并式：主题分支提交后合并回原分支，仅 add `.codewiki/` 与 `CodeWiki.md`，安全边界检查）。
- `3490| export function commitHintText(cwd, jobs = loadJobs()) {` 至 `3521| }` — 编译完成未提交提醒文本（60s 缓存）。
- `3523| function reminderText(cwd) {` 至 `3532| }` — 会话系统提示 wiki 维护提醒文本。
- `3534| function installUpdateReminder(ctx, config) {` 至 `3566| }` — 注入 systemPrompt section。
- `3568| export function apply(ctx, config) {` 至 `3632| }` — 插件入口：注入 `agents`/`llm`、启动服务、注册工具与面板、自动更新调度器。

### client.js 组件

- `10| window.__ModuleLoader__.load({` 至 `12|   factory(require) {` — 客户端模块加载入口，id `@local/dsh-codewiki`。
- `17| const NS = 'codewiki'`、`18| const KEY = 'codewiki'`、`19| const JOBS_PATH = '/api/codewiki/jobs'`、`20| const CONTROL_PATH = '/api/codewiki/control'`、`21| const PANEL_ORDER = 52`、`22| const POLL_MS = 2000`、`23| const REPOS_PATH = '/api/codewiki/repos'`、`24| const SESSIONS_PATH = '/api/codewiki/sessions'`、`25| const SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'`、`26| const MODELS_PATH = '/api/codewiki/models'`、`27| const EFFORTS_PATH = '/api/codewiki/model-efforts'`、`31| const REPOS_POLL_MS = 10000`、`33| const ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index', 'commit']` — 常量与端点（注意 ACTIVE_STAGES 含 commit）。
- `35| const zh = () => ({` 至 `193| })`、`194| const en = () => ({` 至 `352| })` — 中英文案词典。
- `358| const style = document.createElement('style')` 至 `360| style.textContent = [` 与 `455| if (!document.head.querySelector('style[data-plugin="@local/dsh-codewiki"]')) document.head.appendChild(style)` — 注入面板与设置页 CSS。
- `457| function el(tag, props, ...children) {` 至 `459| }`、`461| async function apiGet(p) {` 至 `466| }`、`467| async function apiPost(p, data) {` 至 `476| }` — React 元素构造与 fetch 封装。
- `478| return {` 至 `479| inject: ['slots', 'locale', 'configForms'],`、`480| apply(ctx) {` 至 `1593| },` — 客户端 apply：注册词典、设置页 `plugins.item`、侧边栏 `main`/`sidebar.panellist`。
- `520| function CodewikiCard(props) {` 至 `950| }` — 设置卡片组件（view='summary' 简介 / 'page' 完整表单），含 `modelTrio`（`630|` 定义）渲染提供商/模型/思考档位级联下拉、目录联动、保存/放弃逻辑，`useEfforts`（`592|`）拉取思考档位。
- `956| const stageLabel = (stage) => ...`、`957| const stateLabel = (st) => ...`、`958| const kindLabelOf = ...`、`959| const progressBar = ...`、`963| const repoName = ...`、`967| const fmtMs = ...`、`974| const fmtTok = ...`、`980| const fmtDur = ...`、`986| const fmtAgo = ...`、`991| const Spark = ...`、`1007| const stepName = ...`、`1010| const lastTimedStage = ...`、`1014| const stageBar = ...`、`1038| const STAGE_WEIGHTS = {...}`、`1039| const overallPct = ...`、`1050| const throughputBadge = ...`、`1072| const usageLine = ...` — 展示辅助（步骤条/吞吐/用量渲染）。
- `1091| function ReposTab() {` 至 `1234| }` — 总览标签页：轮询 `/repos`，展示各仓库 wiki 状态、调度信息、排除切换、立即编译。
- `1240| function SessionView({ job, onClose }) {` 至 `1330| }` — 会话视图：某任务（或全局）的 LLM 请求记录列表与全文查看。
- `1332| function CodewikiPanel() {` 至 `1577| }` — 侧边栏面板主组件：轮询 `/jobs`，分组展示任务卡、取消、复制路径、活动流、会话入口。
- `1579| function PanelIcon(props) {` 至 `1590| }` — 面板图标（摊开的书）。

### 配置文件

- `cordis.patch.yml`：`14| - insert:` 至 `17|       config: {}` — 以 `id: codewiki` 挂载 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`。
- `package.json`：`2|   "name": "@local/dsh-codewiki"`、`3|   "version": "0.12.2"`、`7|   "main": "index.js"`、`8|   "exports": {` 至 `11|   }`、`17|   "dependencies": {` 至 `19|   }`、`20|   "dsh": {` 至 `27|   }`（其中 `25| "patch": "cordis.patch.yml"`）。
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
            │                        │ index.js (apply 3568)  │
            │                        │ Config + Tools + Svc   │
            └───────────────────────►│ createJobService 1541  │
                                     └───────────┬────────────┘
                                                 │ writes .codewiki/
                                                 ▼
                                     ┌────────────────────────┐
                                     │ package.json (meta)    │
                                     │ .gitignore (excluded)  │
                                     └────────────────────────┘
```

组件说明：
- `client.js` 不直接调用模型，仅通过宿主 webServer 回环端点与 `index.js` 通信（端点定义见 `installWebServer` `3078|`）。
- `index.js` 的 `apply`（`3568|`）经 `cordis.patch.yml` 挂载，启动时创建 `createJobService`（`1541|`）并 `service.start()` 以 `TICK_MS`（`1163|`）节拍推进。
- 模型通道唯一为宿主 `llm` 服务（`392| llmChat`），凭证由宿主按 provider 解析。

## Data Flow

1. 会话内调用 `codewiki_generate`（`2611|` 定义） → `execute`（`2655|`）运行 `cw status`（`2694|`）判态，调用 `svc.submit`（`2492|`）提交 job 并立即返回。
2. `createJobService` 的 `tick`（`2404|`）每 `TICK_MS`（`1163|`）被触发：依 `serialProjects` 闸门（`2415|` 起的 `parallelLimit` 逻辑）与 `owner` 孤儿接管（`2430|` 起）逻辑，推进阶段机 `articles → crosscut → compose → review → index → commit`。
3. 文章阶段 `tickArticles`（`1952|`）调用 `prepareArticleTasks`（`707|`）装填源码，经 `submitBatchFor`（`1828|`）→ `startBatchChatRun`（`1784|`）→ `runRealtimeTasks`（`449|`）→ `llmChat`（`392|`）走宿主 llm。
4. 结果经 `settleJob`（`1681|`）收割，`applyTaskResult`（`421|`）/`writeValidated`（`1707|`）落盘 `.codewiki/`；`fixAnchors`（`548|`）校正行号。
5. `tickIndex`（`2345|`）跑 `cw index` 与 `ensureWikiEntry`（`226|`），随后若 `autoCommit` 开启进入 `tickCommit`（`2377|`）调用 `autoCommitWiki`（`3406|`）自动提交产物。
6. `client.js` 的 `CodewikiPanel`（`1332|`）每 `POLL_MS=2000`（`22|`）拉 `/api/codewiki/jobs`（`3119|` 起端点）渲染进度；`ReposTab`（`1091|`）每 10s 拉 `/repos`（`3159|` 起）显示总览。
7. 编译终态经 `wakeCompileSession`（`1524|`）steer 唤醒发起会话；`commitHintText`（`3490|`）在系统提示注入提交提醒。

## Connections

本模块为插件唯一核心模块，暂无其他模块文章可链接。相关挂载点见 `cordis.patch.yml`（`14| - insert:`）与 `package.json` 的 `dsh.bundle.patch`（`25| "patch": "cordis.patch.yml"`）。

## Known Issues

- 旧版规划阶段任务残留：0.10.7 前任务可能卡在 `plan` 阶段（`2468| if (job.stage === 'plan')` 已做迁移到 `articles` 的处理），旧磁盘快照不可重跑。
- 会话通道兜底限制：`dispatchSessionTasks`（`1870|`）要求发起会话可用，面板/自动调度提交时若超预算且 `bigProvider` 留空会直接 `fail`（`1874|` 附近），不降级回插件内通道。
- 跨实例并发：通过 `JOBS_LOCK_FILE`（`1433|`）与 `instanceId`（`1549|`）防止双提交，崩溃残留锁 60s 过期强删（`1442|` 附近）。
- 配置竞态：`saveJobs`（`1453|`）只留最近 `MAX_JOBS_KEPT=30`（`1356|`），`mergeFromDisk`（`1595|`）防止活动 job 被过期快照覆盖。
- `client.js` 模型目录依赖 `/api/codewiki/models`（`3300|` 起端点）：若宿主 llm 未注入则 `catalogError` 有值（`530|` 声明 / `638|` 渲染手填），设置页退回手填形态。
- 自动提交分支合并式（`3406| autoCommitWiki`）在 detached HEAD（`3453|` 判断 `if (!cur)`）或建分支失败（`3458|`）时降级 direct，合并冲突时保留主题分支等手动合并。
- `.gitignore` 未忽略 `bin/cw` 本身（仅忽略 `bin/*.bak-*` `6|`），捆绑二进制需手动管理。
