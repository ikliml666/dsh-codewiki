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

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合，包含插件主入口 `index.js`、浏览器侧客户端 `client.js`、cordis 挂载补丁 `cordis.patch.yml`、包定义 `package.json` 与 git 忽略规则 `.gitignore`。`index.js` 提供了把 `mraza007/codewiki`（Rust CLI `cw`）接入 DeepSeek Harness 的全部能力：两个基础工具 `cw` 与 `codewiki_generate`、只读进度工具 `codewiki_progress`、更新快捷工具 `codewiki_update`，以及后台常驻编排服务（阶段机 `articles → crosscut → compose → review → index`）、宿主 webServer 端点（`/api/codewiki/*`）、会话系统提示提醒注入与编译产物自动提交（`autoCommitWiki`）。`client.js` 在浏览器半侧挂载「插件」设置页与侧边栏编译任务面板，通过 `configForms` 读写配置、轮询 `/api/codewiki/jobs` 与 `/api/codewiki/repos` 展示进度与总览。`cordis.patch.yml` 以 `insert` 方式将 `index.js` 注册为 id `codewiki` 的插件；`package.json` 声明包名 `@local/dsh-codewiki`、版本 `0.10.9`、入口与 exports；`.gitignore` 排除 `node_modules/`、`vendor/codewiki/target/`、日志与运行期产物。

## Key Components

### index.js 导出与核心常量

- `17| const pluginDir = path.dirname(fileURLToPath(import.meta.url))` — 插件目录绝对路径，用于定位捆绑 `bin/cw`。
- `18| const PLUGIN_NAME = 'dsh-codewiki'`、`19| export const name = PLUGIN_NAME` — 插件名导出。
- `20| const CW_SUBCOMMANDS = ['init', 'status', 'index', 'meta', 'path', 'projects', 'setup', 'uninstall']` — `cw` 工具允许的子命令白名单。
- `22| const CONCURRENCY_HARD_CAP = 8` — 并发硬顶；`24| const DEFAULT_CONCURRENCY = 2` — 默认并发（hy3 免费档）。
- `26| const DEFAULT_BATCH_PROVIDER = 'workbuddy'`、`27| const DEFAULT_BATCH_MODEL = 'hy3'` — 默认编译模型。
- `30| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`31| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`33| const DEFAULT_BIG_TOKEN_BUDGET = 420000` — 大档模型（超长输入）默认配置。
- `48| export const Config = z.object({` 至 `68| })` — 插件配置 schema（schemastery），字段含 `enabled`、`binaryPath`、`batchProvider`、`batchModel`、`batchReasoningEffort`、`bigProvider`、`bigModel`、`bigReasoningEffort`、`bigTokenBudget`、`sessionTier`、`maxConcurrency`、`serialProjects`、`articleLanguage`、`updateReminder`、`autoCommit`、`excludePaths`、`autoUpdate`、`autoUpdateMin`、`workspaceOnly`，全部 `.volatile()`。
- `371| const BATCH_TOKEN_BUDGET = 110000`、`376| const BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与硬上限。
- `1012| const JOBS_FILE = ...'dsh-codewiki-jobs.json'`、`1013| const TICK_MS = ... 10000`、`1017| const SESSION_TASK_TIMEOUT_MS = ... 30 * 60 * 1000`、`1018| const SESSION_TASK_DIR = ...` — 任务持久化文件、tick 间隔、会话通道超时与任务目录。
- `1067| const REPOS_FILE = ...'dsh-codewiki-repos.json'` — 已知仓库清单持久化。
- `1083| const SCAN_SKIP_DIRS = new Set([...])`、`1088| const SCAN_SKIP_EXT = new Set([...])`、`1094| const SCAN_MAX_FILE_BYTES = 256 * 1024`、`1095| const SCAN_MAX_FILES = 2000` — 仓库源码扫描黑名单。

### index.js 内部函数与工具定义

- `37| function normalizeCwd(input)` 至 `42| }` — Windows/Git-Bash 盘符路径归一化为 `C:/...`。
- `70| function val(x)` 至 `72| }` — 从 cordis 配置容器取值。
- `74| function liveConfig(config)` 至 `99| }` — 将原始配置规范化为运行期可用的扁平对象（含并发钳制、大档预算兜底）。
- `105| function resolveBinary(cfg)` 至 `125| }` — 解析 `cw` 可执行文件：优先 PATH，回退捆绑 `bin/cw(.exe)`。
- `127| function runCw(binary, cwd, args, timeoutMs = 120000, signal)` 至 `152| }` — spawn `cw` 子进程并带超时/中止收集 stdout/stderr。
- `164| export function normalizeArticlePath(p)` — 将路径内 `\` 规范为 `/`。
- `168| export function normalizeIndexLinks(cwd)` 至 `176| }` — 修正 `_index.md` 链接头内的反斜杠。
- `178| export function parseStatus(stdout)` 至 `191| }` — 解析 `cw status` 三态/变更/过期输出。
- `194| function countWikiArticles(wikiPath)` 至 `206| }` — 递归统计 `.codewiki/` 下 `.md` 篇数。
- `211| export function ensureWikiEntry(cwd, language = '中文')` 至 `244| }` — 仓库根缺失 `CodeWiki.md` 时自动生成入口（中/英），已有不覆盖。
- `249| function excludedItem(cwd, list)` 至 `258| }`、`259| function isExcluded(cwd, list)` 至 `261| }` — 排除清单命中判定（绝对路径子树）。
- `269| export function estimateTokens(text)` 至 `277| }` — 粗算 token（CJK≈1/字，其余≈3.5字符/token）。
- `285| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal })` 至 `304| }` — 唯一模型通道：走宿主 `llm.stream`，返回 content 与 outputTokens。
- `308| function applyTaskResult(task, content, notes)` 至 `321| }` — 任务结果落盘或回内存（含 `fixAnchors` 校正）。
- `329| export async function runRealtimeTasks(tasks, {...})` 至 `358| }` — 并发池执行器，按 `maxConcurrency` 消费队列。
- `380| function readJsonFile(p)` 至 `382| }` — 安全读取 JSON。
- `387| export function numberLines(content)` 至 `389| }` — 为源码每行加 `N| ` 前缀。
- `398| export function fixAnchors(content, cwd)` 至 `481| }` — 行号锚点自动修正（第四层兜底），对照源码确定性校正 `file:NN` 引用。
- `486| export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)` 至 `513| }` — 按 token 预算整文件内联源码，返回 `{text, skipped, oversized}`。
- `517| function batchArticlePrompt({...})` 至 `544| }` — 单轮文章 prompt 组装。
- `557| export function prepareArticleTasks(tasks, {...})` 至 `642| }` — 将通用任务装配为批量/大档/观察/会话任务。
- `648| function articleFormatSection()` 至 `677| }` — 文章格式条款模板。
- `682| export function localPlan(files)` 至 `695| }` — 按顶层目录分组生成本地模块清单。
- `699| export function packArticles(articles, budget)` 至 `718| }` — 横切输入装配（超预算截头部）。
- `720| function crosscutIntro(...)`、`734| function batchArchitecturePrompt(...)`、`742| function batchPatternsPrompt(...)`、`750| function batchConceptPrompt(...)` — 横切 prompt 构造。
- `760| function batchObservePrompt(...)`、`781| function batchArticleObservePrompt(...)` — 观察批 prompt。
- `801| function batchArticleComposePrompt({...})` 至 `829| }` — 文章分割合成 prompt。
- `833| function batchProofreadPrompt({...})` 至 `852| }`、`856| function batchProofreadBatchPrompt(language, items)` 至 `883| }` — 批量校对 prompt（单篇/合并分节）。
- `889| function cwToolDefinition(cfg)` 至 `952| }` — 工具 `cw` 定义（封装 CLI）。
- `960| function slugify(name)` 至 `962| }` — 模块名 slug（保留 CJK）。
- `966| function parseSourceFiles(fm)` 至 `978| }`、`980| function readSourceFiles(articlePath)` 至 `988| }` — frontmatter `source_files` 解析。
- `990| async function wikiPathFor(cwd, binary, signal)` 至 `995| }` — 取 wiki 目录（默认 `<repo>/.codewiki`）。
- `1024| export function classifySessionTask(task, nowMs)` 至 `1034| }` — 会话通道任务收割三态判定（纯函数）。
- `1041| export function buildSessionSteerText({ job, snapshots, tier, resend })` 至 `1059| }` — 会话通道 steer 文本（纯函数）。
- `1068| function loadKnownRepos()`、`1071| function rememberRepo(cwd)` 至 `1079| }` — 已知仓库持久化。
- `1097| export function scanRepoFiles(cwd)` 至 `1120| }` — 仓库源码扫描（黑名单/大小/总数限制）。
- `1122| function loadJobs()`、`1127| const JOBS_LOCK_FILE`、`1130| function acquireTickLock()` 至 `1144| }`、`1145| function releaseTickLock()`、`1147| function saveJobs(jobs)` 至 `1152| }` — 任务文件读写与跨进程锁。
- `1154| function jobSummary(job)` 至 `1188| }` — 任务摘要（含 tps 聚合）。
- `1202| export function wakeCompileSession(job, outcome, agents)` 至 `1216| }` — 编译终态向发起会话 steer 唤醒（成功且已自动提交时不打扰）。
- `1218| function createJobService(config, onSettled)` 至 `2203| }` — 核心编排服务：含 `submit`、`cancel`、`list`、`findActive`、`start`、`stop` 及阶段处理 `tickArticles`/`tickCrosscut`/`tickCompose`/`tickReview`/`tickIndex`、执行器 `startBatchChatRun`/`submitBatchFor`、会话通道 `dispatchSessionTasks`/`progressSessionTasks`/`resendSessionSteer`。
- `2210| function generateToolDefinition(cfg, svc)` 至 `2360| }` — 工具 `codewiki_generate`（提交制）。
- `2370| function updateToolDefinition(cfg, generateDef)` 至 `2422| }` — 工具 `codewiki_update`（scope=auto 快捷入口）。
- `2430| function samePath(a, b)`、`2435| function progressView(job)`、`2441| function progressToolDefinition(cfg, svc)` 至 `2542| }` — 工具 `codewiki_progress`（只读查进度）与辅助。
- `2548| function isLoopbackRequest(req)`、`2553| function writeJson(res, code, obj)`、`2559| function readBodyJson(req)` — webServer 辅助。
- `2584| export async function listModelCatalog(llm)` 至 `2605| }`、`2611| const resolveModelInfoOf = (llm) => {...}`、`2622| export async function resolveModelEfforts(llm, provider, model)` 至 `2644| }` — 模型目录与思考档位枚举。
- `2646| export function installWebServer(ctx, service, extra)` 至 `2875| }` — 挂载 `/api/codewiki/jobs`、`/repos`、`/models`、`/model-efforts`、`/control` 端点（仅回环）。
- `2904| export function autoCommitWiki(cwd, { jobId, writtenCount })` 至 `2945| }` — 编译产物自动提交（仅 add `.codewiki/` 与 `CodeWiki.md`，安全边界检查）。
- `2947| export function commitHintText(cwd, jobs)` 至 `2976| }` — 编译完成未提交提醒文本（60s 缓存）。
- `2978| function reminderText(cwd)` 至 `2987| }` — 会话系统提示 wiki 维护提醒文本。
- `2989| function installUpdateReminder(ctx, config)` 至 `3021| }` — 注入 systemPrompt section。
- `3023| export function apply(ctx, config)` 至 `3082| }` — 插件入口：注入 `agents`/`llm`、启动服务、注册工具与面板、自动更新调度器。

### client.js 组件

- `10| window.__ModuleLoader__.load({` 至 `12|   factory(require) {` — 客户端模块加载入口，id `@local/dsh-codewiki`。
- `17| const NS = 'codewiki'`、`18| const KEY = 'codewiki'`、`19| const JOBS_PATH = '/api/codewiki/jobs'`、`20| const CONTROL_PATH = '/api/codewiki/control'`、`21| const PANEL_ORDER = 52`、`22| const POLL_MS = 2000`、`23| const REPOS_PATH = '/api/codewiki/repos'`、`24| const MODELS_PATH = '/api/codewiki/models'`、`25| const EFFORTS_PATH = '/api/codewiki/model-efforts'`、`26| const REPOS_POLL_MS = 10000`、`28| const ACTIVE_STAGES = ['queued', 'articles', 'crosscut', 'compose', 'review', 'index']` — 常量与端点。
- `30| const zh = () => ({...})` 至 `167| })`、`168| const en = () => ({...})` 至 `305| })` — 中英文案词典。
- `307| const style = document.createElement('style')` 至 `387| if (!document.head.querySelector('style[data-plugin="@local/dsh-codewiki"]')) document.head.appendChild(style)` — 注入面板与设置页 CSS。
- `389| function el(tag, props, ...children)`、`393| async function apiGet(p)`、`399| async function apiPost(p, data)` — React 元素构造与 fetch 封装。
- `412|       apply(ctx) {` 至 `451| },` — 客户端 apply：注册词典、设置页 `plugins.item`、侧边栏 `main`/`sidebar.panellist`。
- `452|         function CodewikiCard(props) {` 至 `851| }` — 设置卡片组件（view='summary' 简介 / 'page' 完整表单），含 `modelTrio`（`562|`）渲染提供商/模型/思考档位级联下拉、目录联动、保存/放弃逻辑。
- `857|         const stageLabel = (stage) => ...`、`858|         const stateLabel = (st) => ...`、`859|         const kindLabelOf = ...`、`860|         const progressBar = ...`、`864|         const repoName = ...`、`868|         const fmtMs = ...`、`875|         const fmtTok = ...`、`881|         const fmtDur = ...`、`887|         const fmtAgo = ...`、`892|         const Spark = ({ values, width, height }) => ...` — 展示辅助。
- `908|         const stepName = (s) => ...`、`911|         const lastTimedStage = (job) => ...`、`915|         const stageBar = (job) => ...`、`939|         const STAGE_WEIGHTS = {...}`、`940|         const overallPct = (job) => ...`、`951|         const throughputBadge = ...`、`973|         const usageLine = (job) => ...` — 步骤条/吞吐/用量渲染。
- `992|         function ReposTab() {` 至 `1135| }` — 总览标签页：轮询 `/repos`，展示各仓库 wiki 状态、调度信息、排除切换、立即编译。
- `1137|         function CodewikiPanel() {` 至 `1337| }` — 侧边栏面板主组件：轮询 `/jobs`，分组展示任务卡、取消、复制路径、活动流。
- `1339|         function PanelIcon(props) {` 至 `1350| }` — 面板图标（摊开的书）。

### 配置文件

- `cordis.patch.yml`：`13| - insert:` 至 `16|       config: {}` — 以 `id: codewiki` 挂载 `file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`。
- `package.json`：`2|   "name": "@local/dsh-codewiki"`、`3|   "version": "0.10.9"`、`7|   "main": "index.js"`、`8|   "exports": {` 至 `11|   }`、`17|   "dependencies": {` 至 `19|   }`、`20|   "dsh": {` 至 `27|   }`。
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
            │                        │ index.js (apply)       │
            │                        │ Config + Tools + Svc   │
            └───────────────────────►│ createJobService       │
                                     └───────────┬────────────┘
                                                 │ writes .codewiki/
                                                 ▼
                                     ┌────────────────────────┐
                                     │ package.json (meta)    │
                                     │ .gitignore (excluded)  │
                                     └────────────────────────┘
```

组件说明：
- `client.js` 不直接调用模型，仅通过宿主 webServer 回环端点与 `index.js` 通信。
- `index.js` 的 `apply`（`3023|`）经 `cordis.patch.yml` 挂载，启动时创建 `createJobService`（`1218|`）并 `service.start()` 以 `TICK_MS`（`1013|`）节拍推进。
- 模型通道唯一为宿主 `llm` 服务（`285| llmChat`），凭证由宿主按 provider 解析。

## Data Flow

1. 会话内调用 `codewiki_generate`（`2210|` 定义） → `execute`（`2254|`）运行 `cw status`（`2269|`）判态，调用 `svc.submit`（`2111|`）提交 job 并立即返回。
2. `createJobService` 的 `tick`（`2032|`）每 10s 被触发：依 `serialProjects` 闸门与 `owner` 孤儿接管逻辑，推进阶段机 `articles → crosscut → compose → review → index`。
3. 文章阶段 `tickArticles`（`1599|`）调用 `prepareArticleTasks`（`557|`）装填源码，经 `submitBatchFor`（`1481|`）→ `startBatchChatRun`（`1439|`）→ `runRealtimeTasks`（`329|`）→ `llmChat`（`285|`）走宿主 llm。
4. 结果经 `settleJob`（`1336|`）收割，`applyTaskResult`（`308|`）/`writeValidated`（`1362|`）落盘 `.codewiki/`；`fixAnchors`（`398|`）校正行号。
5. `tickIndex`（`1990|`）跑 `cw index` 与 `ensureWikiEntry`（`211|`），随后 `autoCommitWiki`（`2904|`）自动提交产物。
6. `client.js` 的 `CodewikiPanel`（`1137|`）每 `POLL_MS=2000` 拉 `/api/codewiki/jobs`（`2689|` 端点）渲染进度；`ReposTab`（`992|`）每 10s 拉 `/repos`（`2709|`）显示总览。
7. 编译终态经 `wakeCompileSession`（`1202|`）steer 唤醒发起会话；`commitHintText`（`2947|`）在系统提示注入提交提醒。

## Connections

本模块为插件唯一核心模块，暂无其他模块文章可链接。相关挂载点见 `cordis.patch.yml`（`13| - insert:`）与 `package.json` 的 `dsh.bundle.patch`（`25| "patch": "cordis.patch.yml"`）。

## Known Issues

- 旧版规划阶段任务残留：0.10.7 前任务可能卡在 `plan` 阶段（`2087| if (job.stage === 'plan')` 已做迁移到 `articles` 的处理），旧磁盘快照不可重跑。
- 会话通道兜底限制：`dispatchSessionTasks`（`1517|`）要求发起会话可用，面板/自动调度提交时若超预算且 `bigProvider` 留空会直接 `fail`（`1521|`），不降级回插件内通道。
- 跨实例并发：通过 `JOBS_LOCK_FILE`（`1127|`）与 `instanceId`（`1226|`）防止双提交，崩溃残留锁 60s 过期强删（`1136|`）。
- 配置竞态：`saveJobs`（`1147|`）只留最近 `MAX_JOBS_KEPT=30`（`1062|`），`mergeFromDisk`（`1250|`）防止活动 job 被过期快照覆盖。
- `client.js` 模型目录依赖 `/api/codewiki/models`（`2804|` 端点）：若宿主 llm 未注入则 `catalogError` 有值，设置页退回手填（`466|`/`592|`）。
- `.gitignore` 未忽略 `bin/cw` 本身（仅忽略 `bin/*.bak-*` `6|`），捆绑二进制需手动管理。