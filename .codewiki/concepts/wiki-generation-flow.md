---
title: wiki-generation-flow
type: concept
source_files:
  - index.js
  - client.js
tags: [wiki-generation, job-service, host-llm-service, pipeline, observability, auto-commit]
---

## Overview

`wiki-generation-flow` 是 dsh-codewiki 的核心概念：把一次「仓库 → 活 wiki」的编译拆成一条**可持久化、可中断、可续跑、可观测**的服务化流水线。它不是一次同步函数调用，而是跨多次事件循环、跨宿主重启、必要时跨会话推进的状态机。插件对外暴露三个工具——`cw`（CLI 薄封装）、`codewiki_generate`（服务化编译）、`codewiki_progress`（只读查进度，`1| // dsh-codewiki — 把 mraza007/codewiki（Rust CLI `cw`）接入 DeepSeek Harness。` 起的头部注释，`index.js:1-7`）；编译的全部模型环节在插件内完成，默认模型 `workbuddy/hy3`（免费、192k 上下文，单请求输入预算 110k），零子代理（`6| //                       服务按 写文章 → 横切 → 审校 → 索引 推进，全部环节在插件内完成`）。

四条设计主轴决定了整条流程的形状：

1. **阶段机与作业持久化**：作业（job）落盘在 `os.tmpdir()/dsh-codewiki-jobs.json`（`1292| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')`），由 `setInterval` 心跳（`1293| const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)`，默认 10s）推进 `tick`（`index.js:2747-2833`）。进程中断后下一进程凭磁盘状态续跑；同一仓库同时只允许一个非终态作业（`2934| const findActive = (cwd) => jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage)) ?? null`；工具层幂等去重 `index.js:2747-2755`）；跨进程用 `acquireTickLock`（`index.js:1588-1602`）与 `owner` 归属判定互斥（实例身份 `1701| const instanceId = \`svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}\``，孤儿接管 `index.js:2773-2782`）。
2. **token 预算优先的三档装填**：所有模型调用都是单轮文本生成，目的是把输入压进 ≤110k 普通档（`541| const BATCH_TOKEN_BUDGET = 110000`）。超出的先改用大档（`bigProvider/bigModel`，默认 volces-ark/glm-5.3-flash，预算 `bigTokenBudget` 默认 420000，`39| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`40| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`42| const DEFAULT_BIG_TOKEN_BUDGET = 420000`）；装不下就拆观察批再合成（`index.js:776-788`），而不是硬塞；连大档都装不下时转「会话通道」交发起会话模型派子智能体（`770| if (tooBig) { emitSession(text); continue }`、`index.js:2131-2165`）。大档与默认档在并发池里各自独立限流（`469| export async function runRealtimeTasks(tasks, {` 内的 `474| const bigTasks = []` 与 `475| const normalTasks = []` 分池，`index.js:480-489`）。
3. **双写作通道**：文章写作默认走 agentic 工具循环（`77| agenticArticles: z.boolean().default(true)...`）——模型自己 `read_code`/`list_files` 读源码、`edit_article` 增量写，不再把源码整包内联进 prompt；执行器是 `startAgenticRun`（`index.js:2014-2060`），失败过半才退回单轮整包通道重跑一次（`855| export function shouldFallBackFromAgentic(results) {`）。单轮整包装填（`prepareArticleTasks`，`index.js:727-812`）是退路与「装填决策」的公共底座。
4. **确定性兜底**：行号锚点校正（`568| export function fixAnchors(content, cwd) {`）、frontmatter 校验（`writeValidated`，`index.js:1868-1884`）、旧文保留、索引重建（`index.js:1868-1923`）、入口文件生成（`246| export function ensureWikiEntry(cwd, language = '中文') {`）、产物自动提交（`3783| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {`，由独立 `commit` 阶段的 `tickCommit`（`index.js:2720-2736`）调用）都由代码而非模型保证。

触发入口有五个：`codewiki_generate`（三态 scope，定义于 `2954| function generateToolDefinition(cfg, svc) {`）、`codewiki_update`（固定 auto 的快捷入口，定义于 `3176| function updateToolDefinition(cfg, generateDef) {`）、`codewiki_progress`（只读查询，定义于 `3247| function progressToolDefinition(cfg, svc) {`）、面板「更新」按钮（走 `POST /api/codewiki/control` 的 compile 动作，服务端 `index.js:3736-3745`、客户端 `1227| const compile = async (cwd) => {`），以及自动更新调度器（`3959| const autoScan = async () => {`，60s 心跳 `3987| const scanTimer = setInterval(() => { void autoScan() }, 60000)`）。

当前版本的结构性事实（与旧版文章的差异）：

- **唯一模型通道是宿主 llm 服务**（`412| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta }) {` 经 `1661| let llmRef = null` 注入，`3947| if (typeof ctx.inject === 'function') ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })`），插件零密钥（`1607| // 0.10.1 起插件不存任何密钥，job 里也不再出现 apiKey 字段。`）；提交时只校验 provider/model 非空与 `llmRef.stream` 存在（`index.js:1661-1663`）。
- **没有独立规划阶段**：全量编译提交后直接进 `articles`，模块清单在 `tickArticles` 开头就地构建（`2325| if (!job.plan) {` → `2064| async function buildPlan(job, files) {`）。`planMode=auto`（默认，`76| planMode: z.string().default('auto')...`）走 `semanticPlan`（`884| export async function semanticPlan(files, { ... } = {}) {`）——tree-sitter AST 符号提取 + LLM 语义聚类（吸收自 FSoft CodeWiki），任一环节失败降级 `localPlan`（`862| export function localPlan(files) {`）顶层目录分组。
- **agentic 写作是默认通道**（`2348| if (c0.agenticArticles && tasks.length) {`），单轮整包为退路。
- **大档并发独立限流**：`bigConcurrency`（`72| bigConcurrency: z.number().default(0)...`，0=跟随默认档，`index.js:111-113`）。
- **产物提交是独立阶段**：`tickIndex` 写成功后转 `commit`（`index.js:2663-2666`），`autoCommitWiki` 走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支」（`index.js:2663-2697`）。

客户端（client.js）提供侧边栏面板与设置页：`CodewikiPanel`（`1418| function CodewikiPanel() {`）每 2s 轮询 `JOBS_PATH`（`19| const JOBS_PATH = '/api/codewiki/jobs'`，`22| const POLL_MS = 2000`）渲染七档步骤条与吞吐；`ReposTab`（`1177| function ReposTab() {`）轮询 `REPOS_PATH`（`23| const REPOS_PATH = '/api/codewiki/repos'`，间隔 `31| const REPOS_POLL_MS = 10000`）展示仓库 wiki 状态；`SessionView`（`1326| function SessionView({ job, onClose }) {`）展示并发池每个 LLM 请求的 prompt/输出记录（保留 24h：`1308| const SESSION_TTL_MS = 24 * 60 * 60 * 1000`，`1309| export const SESSIONS_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-sessions')`）。

## Key Components

### 1. Job Service 与阶段机

`createJobService(config, onSettled)`（`index.js:1693-2947`）是全部编排状态的唯一持有者，返回 `{ submit, cancel, list, findActive, start, stop }`（`2946| return { submit, cancel, list, findActive, start, stop }`）。

**阶段全集**见 `STAGE_HANDLER`（`index.js:2738-2745`）：`articles / crosscut / compose / review / index / commit` 六个处理函数，另有 `submitting` 占位（`2867| stage: 'submitting',`，submit 正在校验凭证）、`queued` 排队（`2911| setStage(job, 'queued')`）与三个终态 `done / failed / cancelled`（`1516| const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])`）。`stale` 增量作业从 `articles` 起步、完成直接进 `review`（`2390| setStage(job, job.kind === 'full' ? 'crosscut' : 'review')`）；全量走完六阶段。

**提交 `submit`**（`index.js:2835-2920`）次序是刻意的：排除清单判定（`2837| const exHit = excludedItem(cwd, c0.excludePaths)`，`excludedItem` 在 `index.js:284-293`，命中即抛错并附命中项）→ `detectLinkedWorktree` 闸门拦截 git worktree（`2843| const wt = detectLinkedWorktree(cwd)`，判定函数 `index.js:309-325`，auto 调度静默跳过 `2846-2848`）→ `hasCompilableSources` 空壳目录闸门（`2854| if (!hasCompilableSources(cwd)) {`，探测函数 `index.js:352-366` 带 10 分钟缓存，手动路径先清缓存 `2853| if (!auto) clearSourceProbeCache(cwd)`）→ `rememberRepo` 登记已知仓库（`2859| rememberRepo(cwd)`，登记表 `REPOS_FILE` 见 `1491| const REPOS_FILE = ...`、写入 `index.js:1495-1503`）→ 查同 `cwd` 非终态作业（`2860| const existing = jobs.find(...)`，命中直接返回）→ 才创建 `stage='submitting'` 占位并落盘（`2863| const job = {`），即便凭证校验失败也留下可解释记录。凭证校验仅检查 `batchProvider` 非空、`batchModel` 非空与 `llmRef.stream` 存在（`2891| if (!llmRef || typeof llmRef.stream !== 'function') throw new Error(...)`），记录 `credentialSource`（`2897| job.credentialSource = ...`）。项目闸门（`2904| const busyOthers = jobs.filter(...)`）满额时进 `queued` 并把预置任务寄存到 `pendingTasks`（`2907-2908`），否则直接 `setStage(job, 'articles')`（`2913`）。收尾 `persist + flush` 后 **`void tick()` 立即推进一步**，不等首个心跳（`2918| void tick() // 立即推进一步，不等首个 tick 间隔`）。

**推进 `tick`**（`index.js:2747-2833`）有多层互斥与闸门：模块内 `ticking` 重入守卫（`2748| if (ticking) return`）；跨进程文件锁 `acquireTickLock`（`2749| if (!acquireTickLock()) return`，残留锁 60s 过期强删 `1594| if (Date.now() - fs.statSync(JOBS_LOCK_FILE).mtimeMs > 60000) {`）；会话记录过期清理每 10 分钟一轮（`2752-2756`）；跨实例取消标记拾取 `syncCancelFlags`（`2757| syncCancelFlags()`，实现在 `index.js:1809-1820`）；项目并行闸门（`2761| const parallelLimit = Math.max(1, liveConfig(config).parallelLimit ?? 1)`——`serialProjects` 默认串行=上限 1，`liveConfig` 里 `index.js:115-119` 把它折算成 `parallelLimit`，关闭串行后按 `parallelProjects`（1–4）并行）；`owner` 归属判定：另一实例的 job 停更未超 `ORPHAN_TAKEOVER_MS`（`1485| const ORPHAN_TAKEOVER_MS = Math.max(60000, ...)`，默认 5 分钟）就让路，超时则本实例接管并重发在途会话任务（`2773-2782`，`2781| if (job.sessionTasks?.length) resendSessionSteer(job)`）。取消不是杀进程而是标记：tick 见到 `cancelRequested`（`2784| if (job.cancelRequested) {`）才置终态、`batchAborters.abort()` 中断在飞请求、丢弃未收割结果（`2788-2791`）。排队唤醒（`2796-2806`）把 `queued` 转 `articles` 并落地寄存任务；旧版卡在 `plan` 阶段的残留任务迁移到 `articles`（`2810-2818`）。

**结果结算三件套**：`settleJob`（`index.js:1833-1863`）收割执行器结果；执行器丢失（宿主重启）时，agentic 任务按任务本体整批重跑（`1844-1850`），其余按 `job.tasks` 持久化的 `batchPrompt` 快照重跑本阶段——这是唯一恢复路径（`1855| if (runnable.length && runnable.length === tasks.length) {`），快照缺失则 fail（`1861| fail(job, '请求因宿主重启丢失且无法重跑（任务缺少 prompt 快照），请重新提交')`）。`writeValidated`（`index.js:1868-1884`）是 keepInMemory 结果的落盘闸门：输出不以 `---` 开头即拒绝（`1869| if (typeof content !== 'string' || !content.trimStart().startsWith('---')) {`），通过后再跑 `fixAnchors` 才写盘。`tally`（`index.js:1887-1919`）按名字去重累计 `writtenCount / failedCount`（`1902| const prev = job.articles.find((a) => a.name === rec.name) ?? null`），`replace=true` 用于校对结果覆盖同名条目且「曾经的成就不被后续失败抹掉」（`1905| if (!rec.ok && wasOk) rec.ok = true`）。批量校对收割由 `settleProofread`（`index.js:1934-1958`）按 `@@@article: 名 /
