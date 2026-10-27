---
title: wiki-generation-flow
type: concept
source_files:
  - index.js
  - client.js
tags: [wiki-generation, job-service, host-llm-service, pipeline, observability, auto-commit]
---

## Overview

`wiki-generation-flow` 是 dsh-codewiki 的核心概念：把一次「仓库 → 活 wiki」的编译拆成一条**可持久化、可中断、可续跑、可观测**的服务化流水线。它不是一次同步函数调用，而是跨多次事件循环、跨宿主重启、必要时跨会话推进的状态机。插件对外暴露四个工具：`cw`（CLI 薄封装，`1161| function cwToolDefinition(cfg) {`）、`codewiki_generate`（服务化编译提交，`2978| function generateToolDefinition(cfg, svc) {`）、`codewiki_update`（固定 scope=auto 的日常维护入口，`3200| function updateToolDefinition(cfg, generateDef) {`）与 `codewiki_progress`（只读查进度，`3271| function progressToolDefinition(cfg, svc) {`）。编译的全部模型环节在插件内完成，默认模型 `workbuddy/hy3`（免费、192k 上下文，单请求输入预算 110k），零子代理（`5| //                       服务按 写文章 → 横切 → 审校 → 索引 推进，全部环节在插件内完成`）。默认并发 2（`33| const DEFAULT_CONCURRENCY = 2`，硬顶 `31| const CONCURRENCY_HARD_CAP = 8`），文章语言默认中文（`75|   articleLanguage: z.string().default('中文')...`）。

四条设计主轴决定整条流程的形状：

1. **阶段机与作业持久化**：作业（job）落盘在 `os.tmpdir()/dsh-codewiki-jobs.json`（`1294| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')`），由 `setInterval` 心跳（`1295| const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)`，默认 10s）推进 `tick`（`2771| async function tick() {`）。进程中断后下一进程凭磁盘状态续跑；同一仓库同时只允许一个非终态作业（`2958|   const findActive = (cwd) => jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage)) ?? null`）；跨进程用文件锁 `acquireTickLock`（`1590| function acquireTickLock() {`）与 `owner` 归属判定互斥（实例身份见 `1703|   const instanceId = ...`，孤儿接管阈值 `1487| const ORPHAN_TAKEOVER_MS = ...` 默认 5 分钟）。
2. **token 预算优先的三档装填**：所有模型调用都是单轮文本生成，目标是把输入压进 110k 普通预算（`541| const BATCH_TOKEN_BUDGET = 110000`）。超出的先整任务改用大档（`bigProvider/bigModel`，默认 volces-ark/glm-5.3-flash，预算 `42| const DEFAULT_BIG_TOKEN_BUDGET = 420000`）；单文件连大档都装不下才转「会话通道」交发起会话模型派子智能体（`770|     if (tooBig) { emitSession(text); continue }`、`2141|   function dispatchSessionTasks(job, tasks) {`）；超大模块还有「观察→合成」分割（`790|     if (batches.length > 1) {`）。大档与默认档在并发池里各自独立限流（`474|   const bigTasks = []` 与 `475|   const normalTasks = []` 分池，`480|   const pools = []`）。
3. **双写作通道**：文章写作默认走 agentic 工具循环（`77|   agenticArticles: z.boolean().default(true)...模型自己 read_code/list_files 读源码、edit_article 增量写...`）——模型自己读源码、增量写，不再把源码整包内联进 prompt；执行器是 `startAgenticRun`（`2023|   function startAgenticRun(job, tasks) {`），单批失败过半才退回单轮整包通道重跑一次（`855| export function shouldFallBackFromAgentic(results) {`、`1932|   function shouldFallBackHere(job, results, tasks) {`）。单轮整包装填（`727| export function prepareArticleTasks(tasks, { cwd, language, bigProvider = '', bigModel = '', bigReasoningEffort = '', bigBudget = DEFAULT_BIG_TOKEN_BUDGET } = {}) {`）是退路，也是装填决策的公共底座。
4. **确定性兜底**：行号锚点校正（`568| export function fixAnchors(content, cwd) {`）、frontmatter 校验（`1870|   function writeValidated(job, task, content) {`）、索引重建（`2691|         const idx = await runCw(binary, job.cwd, ['index'], 120000)`）、入口文件生成（`246| export function ensureWikiEntry(cwd, language = '中文') {`）、产物自动提交（`3807| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {`，由独立 `commit` 阶段的 `2744|   async function tickCommit(job) {` 调用）都由代码而非模型保证。

编译触发入口有四个：会话内 `codewiki_generate` / `codewiki_update`；面板「更新」按钮（走 `POST /api/codewiki/control` 的 compile 动作，服务端 `3759|         if (body?.action === 'compile' && body?.cwd) {`，经 `4031|   installWebServer(ctx, service, { config, schedState, compile: (args, exec) => generateDef.execute(args, exec) })` 接到 generateDef）；自动更新调度器（`3983|   const autoScan = async () => {`，60s 心跳 `4011|   const scanTimer = setInterval(() => { void autoScan() }, 60000)`）。`codewiki_progress` 是只读查询，不触发编译。

当前版本的结构性事实（与早期实现差异）：

- **唯一模型通道是宿主 llm 服务**（`412| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta }) {`，服务引用经 `1663| let llmRef = null` 与 `3971|   if (typeof ctx.inject === 'function') ctx.inject(['llm'], (rc) => { llmRef = rc?.llm ?? rc })` 注入），插件零密钥（`1609|   // 0.10.1 起插件不存任何密钥，job 里也不再出现 apiKey 字段。`）；提交时只校验 provider/model 非空与 `llmRef.stream` 存在（`2913|       if (!c.batchProvider) throw ...` 至 `2915|       if (!llmRef || typeof llmRef.stream !== 'function') throw ...`）。
- **没有独立规划阶段**：全量编译提交后直接进 `articles`，模块清单在 `tickArticles` 开头就地构建（`2336|         if (!job.plan) {` → `2339|           job.plan = await buildPlan(job, files)`；规划阶段已删的说明见 `2219|   // 规划阶段已删（0.10.7）...`）。`planMode=auto`（默认，`76|   planMode: z.string().default('auto')...`）走 `semanticPlan`（`884| export async function semanticPlan(files, { cwd, llm, provider, model, reasoningEffort, signal, notes = [] } = {}) {`）——tree-sitter AST 符号提取 + LLM 语义聚类（吸收自 FSoft CodeWiki），任一环节失败降级 `localPlan`（`862| export function localPlan(files) {`）顶层目录分组。
- **agentic 写作是默认通道**（`2358|       if (c0.agenticArticles && tasks.length) {`），单轮整包为退路。
- **大档并发独立限流**：`72|   bigConcurrency: z.number().default(0)...留空或 0 = 跟随默认档并发...`，折算见 `111|     bigConcurrency: Number.isFinite(bigConcurrency) && bigConcurrency >= 1`。
- **产物提交是独立阶段**：`tickIndex` 写成功且 `autoCommit` 开启时转 `commit`（`2735|     if (job.writtenCount > 0 && liveConfig(config).autoCommit) {`、`2736|       setStage(job, 'commit')`），`autoCommitWiki` 走「主题分支提交 → 合并回原分支」。
- **自动更新调度默认关**（`83|   autoUpdate: z.boolean().default(false)...`，间隔 `84|` 默认 30 分钟最小 5）。

客户端（client.js）提供侧边栏面板与设置页：`CodewikiPanel`（`client.js 1418|         function CodewikiPanel() {`）每 2s 轮询 jobs 端点（`client.js 22|     const POLL_MS = 2000`）渲染阶段步骤条与吞吐徽标；`ReposTab`（`client.js 1177|         function ReposTab() {`）轮询仓库总览（`client.js 31|     const REPOS_POLL_MS = 10000`）；`SessionView`（`client.js 1326|         function SessionView({ job, onClose }) {`）展示并发池每个 LLM 请求的 prompt/输出记录（保留 24h：`1310| const SESSION_TTL_MS = 24 * 60 * 60 * 1000`，目录 `1311| export const SESSIONS_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-sessions')`）；设置卡片 `CodewikiCard`（`client.js 548|         function CodewikiCard(props) {`）读写插件配置。

## Key Components

### 1. Job Service 与阶段机

`createJobService(config, onSettled)`（`1695| function createJobService(config, onSettled) {`）是全部编排状态的唯一持有者，返回 `{ submit, cancel, list, findActive, start, stop }`（`2970|   return { submit, cancel, list, findActive, start, stop }`）。

**阶段全集**见 `STAGE_HANDLER`（`2762|   const STAGE_HANDLER = {`）：

| 阶段 | 处理函数 | 职责 |
|---|---|---|
| submitting | submit 内占位（`2891|       stage: 'submitting',`） | 凭证/llm 服务校验期间的落盘占位 |
| queued | tick 唤醒（`2820|         if (job.stage === 'queued') {`） | 项目闸门排队，轮到后落地寄存任务 |
| articles | `2223|   async function tickArticles(job) {` | 规划 + 模块文章（agentic / 单轮 / 观察合成） |
| crosscut | `2439|   async function tickCrosscut(job) {` | `_architecture.md` / `_patterns.md` / concepts |
| compose | `2525|   async function tickCompose(job) {` | 横切拆分后的合成批收割 |
| review | `2574|   async function tickReview(job) {` | 本地核对 + 批量校对 |
| index | `2687|   async function tickIndex(job) {` | cw index/meta、符号快照、入口生成 |
| commit | `2744|   async function tickCommit(job) {` | autoCommitWiki 自动提交 |

另有三个终态 `1518| const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])`。`stale` 增量作业从 `articles` 起步、完成直接进 `review`（`2414|     setStage(job, job.kind === 'full' ? 'crosscut' : 'review')`）；全量走完全部阶段。

**提交 `submit`**（`2859|   async function submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId }) {`）的闸门次序是刻意的：排除清单判定（`2861|     const exHit = excludedItem(cwd, c0.excludePaths)`，实现 `284| function excludedItem(cwd, list) {`，命中即抛错并附命中项）→ worktree 闸门（`2867|     const wt = detectLinkedWorktree(cwd)`，判定 `309| export function detectLinkedWorktree(cwd) {`，auto 调度静默跳过 `2870|       return { skipped: 'worktree', reason: msg }`）→ 空壳目录闸门（`2878|     if (!hasCompilableSources(cwd)) {`，探测 `352| export function hasCompilableSources(cwd) {` 带 10 分钟缓存 `350| const SOURCE_PROBE_TTL_MS = 10 * 60 * 1000`，手动路径先清缓存 `2877|     if (!auto) clearSourceProbeCache(cwd)`）→ 登记已知仓库（`2883|     rememberRepo(cwd)`，清单 `1493| const REPOS_FILE = ...`、写入 `1497| function rememberRepo(cwd) {`）→ 幂等检查（`2884|     const existing = jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage))`）→ 才创建 `stage='submitting'` 占位并落盘（`2887|     const job = {`）。凭证校验仅三项（`2911`–`2915`），通过后记录 `credentialSource`（`2921|     job.credentialSource = ...`）。项目闸门（`2928|     const busyOthers = jobs.filter(...)` 满额时）进 `queued` 并把预置任务寄存到 `pendingTasks`（`2931|       job.pendingStage = 'articles'`、`2932|       job.pendingTasks = ...`），否则直接 `2937|       setStage(job, 'articles')`。收尾 `2941|     flush()` 后 **`2942|     void tick() // 立即推进一步，不等首个 tick 间隔`**。

**推进 `tick`**（`2771`）的多层互斥：模块内重入守卫（`2772|     if (ticking) return`）；跨进程文件锁（`2773|     if (!acquireTickLock()) return`，锁文件 `1587| const JOBS_LOCK_FILE = ...`，残留锁 60s 过期强删 `1596|       if (Date.now() - fs.statSync(JOBS_LOCK_FILE).mtimeMs > 60000) {`）；会话记录清理每 10 分钟一轮（`2777|       if (!tick.lastPruneAt || ...`）；跨实例取消标记拾取 `syncCancelFlags`（`2781|       syncCancelFlags()`，实现 `1811|   function syncCancelFlags() {`）；项目并行闸门（`2785|       const parallelLimit = Math.max(1, liveConfig(config).parallelLimit ?? 1)`——`serialProjects` 默认串行=上限 1，折算见 `115|     parallelLimit: (() => {` 至 `119|     })(),`）；`owner` 归属判定：另一实例的 job 停更未超 `ORPHAN_TAKEOVER_MS` 就让路，超时则接管并重发在途会话任务（`2797|         if (job.owner && job.owner !== instanceId) {` 至 `2805|           if (job.sessionTasks?.length) resendSessionSteer(job)`）。取消是标记制：tick 见 `2809|         if (job.cancelRequested) {` 才置 `cancelled`、中断在飞请求（`2815|           const ac = batchAborters.get(job.id)`、`2816|           if (ac) ac.abort()`）并丢弃未收割结果。旧版卡在 `plan` 阶段的残留任务迁移到 `articles`（`2835|         if (job.stage === 'plan') {`）。

**持久化**：`saveJobs`（`1607| function saveJobs(jobs) {`）只留最近 30 个（`1610|   const kept = jobs.slice(-MAX_JOBS_KEPT)`，常量 `1488| const MAX_JOBS_KEPT = 30`）；`mergeFromDisk`（`1749|   function mergeFromDisk() {`）吸收另一实例的新增/更新 job；脏标记 `dirty`/`dirtyIds`（`1706`–`1709`）保证只有状态变更过才整写文件（`touch` 统一入口 `1781|   const touch = (job) => {`）。阶段切换统一走 `setStage`（`1786|   const setStage = (job, stage) => {`），累计 `stageTimings` 供面板展示；用量累计 `addUsage`（`1798|   const addUsage = (job, { inputTok = 0, outputTok = 0, requests = 0, batch = false, realtime = false, overTier2 = 0 } = {}) => {`）。启动时还做两类残留清理：Temp 沙箱终态任务移除（`1713`–`1724`）、worktree/空壳目录的历史任务连同已知仓库登记一起摘除（`1731`–`1746`，反登记 `1508| export function forgetRepo(cwd) {`）。

**结果结算三件套**：`settleJob`（`1835|   async function settleJob(job) {`）从 `batchResults`（`1974|   const batchResults = new Map()`）收割执行器结果；执行器丢失（宿主重启）时，agentic 任务按任务本体整批重跑（`1846|     const agenticTasks = (job.tasks ?? []).filter((t) => t.agentic === true && t.mission && t.articlePath)`，其余按 `job.tasks` 持久化的 `batchPrompt` 快照重跑本阶段（`1856|     const runnable = tasks.filter((t) => typeof t.batchPrompt === 'string' && t.batchPrompt.length)`）——这是唯一恢复路径，快照缺失则 fail（`1863|     fail(job, '请求因宿主重启丢失且无法重跑（任务缺少 prompt 快照），请重新提交')`）。`writeValidated`（`1870`）是 keepInMemory 结果的落盘闸门：输出不以 `---` 开头即拒绝（`1871|     if (typeof content !== 'string' || !content.trimStart().startsWith('---')) {`），通过后跑 `fixAnchors` 才写盘。`tally`（`1897|   function tally(job, results, tasks, { replace = false, mergeByName = false } = {}) {`）按名字合并累计 `writtenCount/failedCount`，`replace=true`（校对）与 `mergeByName=true`（重跑路径）都不让「曾经的成就被后续失败抹掉」（`1913|         if (!rec.ok && wasOk) rec.ok = true // 曾经的成就不被后续失败抹掉`）。取消入口 `cancel`（`2946|   function cancel(jobId) {`）只置 `cancelRequested` 标记。

### 2. 提交入口与三态判定（codewiki_generate）

`generateToolDefinition`（`2978`）的 `execute`（`3022|     execute: async (args, exec) => {`）流程：cwd 归一化（`3026`，`normalizeCwd` 在 `49| function normalizeCwd(input) {` 处理 MSYS 盘符）→ 排除清单（`3028`）→ 内部直调标记 `auto0`（`3030|       const auto0 = args.auto === true`）→ worktree 闸门（`3033|       const wtHit = detectLinkedWorktree(cwd)`）→ 空壳闸门（`3048|       if (!hasCompilableSources(cwd)) {`）→ `cw status`（`3061|       const statusRes = await runCw(binary, cwd, ['status'], 120000, exec?.signal)`）→ 三态解析 `parseStatus`（`3066|       const status = parseStatus(statusRes.stdout)`，实现 `213| export function parseStatus(stdout) {`：missing/uncompiled/clean/stale 四态）→ wiki 路径（`3067|       const wikiPath = await wikiPathFor(cwd, binary, exec?.signal)`，实现 `1272| async function wikiPathFor(cwd, binary, signal) {`）。

后续分支：幂等（`3073|       const active = svc.findActive(cwd)`，活动任务直接返回并把唤醒权交给最近会话 `3074|         if (sessionId) active.sessionId = sessionId`）；scope 修正——stale 遇无 wiki 升全量（`3084|       if (scope === 'stale' && (status.state === 'missing' || status.state === 'uncompiled')) {`）；clean 短路（`3091|       if (status.state === 'clean' && effectiveScope !== 'full') {`）。

**stale 逐篇更新**（`3097|       if (!needsFullCompile && status.state === 'stale' && status.staleArticles.length) {`）：任务在提交时预构建（`3098|         let tasks = status.staleArticles.map((articleRel) => {`），mission 固定为「更新过期文章：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（`3107|`），无 source_files 的文章跳过（`3102|             notes.push(\`文章 ${articleRel} 无 source_files frontmatter，跳过...\`)`）。随后符号级过滤（`3120|         if (cInf.symbolIncremental && tasks.length) {`）：读上次编译的符号快照（`3121|           const snap = loadSnapshot(wikiPath)`），提取当前符号图（`3125|             const cur = await extractCurrentGraph(cwd)`），组件级比对只留真受影响的文章（`3130|               const r = filterStaleTasks(tasks, oldGraph, cur.graph)`）；全部被滤掉时刷新编译基线而不提交空任务（`3154|           const meta = await runCw(binary, cwd, ['meta', 'update'], 120000, exec?.signal)`）。提交 `3142|           const sub = await svc.submit({ kind: 'stale', ... })`。stale 但解析不出过期文章时：有 changedFiles 就刷基线（`3164`），否则转全量（`3168`）。missing 先 `cw init`（`3173|         const init = await runCw(binary, cwd, ['init'], 120000, exec?.signal)`），最后全量提交 `3180|       const sub2 = await svc.submit({ kind: 'full', ... })`。

`codewiki_update`（`3200`）是固定 scope=auto 的语义包装：`3242|         const result = await generateDef.execute({ ...args, scope: 'auto' }, exec)`，提交成功时追加「不要等待/轮询」引导（`3244`），错误文案改名（`3248|         throw new Error(String(err?.message ?? err).replaceAll('codewiki_generate', 'codewiki_update'))`）。`codewiki_progress`（`3271`）把 `jobSummary` 暴露成只读查询：进度百分比由 `progressView`（`3265| function progressView(job) {`）按 taskList 折算，支持按 cwd（`3370|         if (cwd) list = list.filter((j) => samePath(j.cwd, cwd))`）或 jobId 过滤。

### 3. Token 预算与输入装填

- `estimateTokens`（`394| export function estimateTokens(text) {`）：粗算——CJK ≈ 1 token/字，其余 ≈ 3.5 字符/token（`392|` 注释），只求装得进上下文。
- `numberLines`（`557| export function numberLines(content) {`）：每行加「N| 」前缀，模型引用行号以前缀为准。
- 预算常量：`541| const BATCH_TOKEN_BUDGET = 110000`（hy3 192k 窗口反推）、`546| const BATCH_TOKEN_HARD_LIMIT = 128000`（无大档时的硬上限，推导注释 `539`–`546`）。
- `collectSources`（`656| export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET) {`）：整文件装填、不做半文件截断；第一个文件都装不下时 `oversized=true`（`670|       if (first) return { text: body, skipped: [], oversized: true }`），装不下的文件列入 skipped 并在文末标注（`680|     text += \`\\n（以下文件因单请求输入预算未内联...\``）。
- `batchArticlePrompt`（`687| function batchArticlePrompt({ language, mission, sourcesText, prevArticle }) {`）：内联源码 + 旧文上下文（`697|   if (prevArticle) {`，声明旧文行号不得沿用）+ `articleFormatSection()`（`818| function articleFormatSection() {`，章节/行号/框图/Obsidian 链接等格式条款）。
- `prepareArticleTasks`（`727`）装填决策：大档可用性由 bigProvider 是否配置决定（`731|   const bigTier = String(bigProvider ?? '').trim() ? {...} : null`）；单文件上限 `752|     const singleLimit = bigTier ? bigTier.budget : BATCH_TOKEN_HARD_LIMIT`。整任务一个请求装得下就单发（`773|     if (!skipped.length && pt <= singleLimit) { emitSingle(text); continue }`，装填结果超 110k 普通预算时打大档标记 `761|       if (estimateTokens(t.batchPrompt) > BATCH_TOKEN_BUDGET) markBig(t)`）；单文件连大档都超 → 会话通道（`770`）；其余按普通预算逐文件贪心拆观察批（`776`–`788`），多批时发观察任务（`793|         prepared.push({`，`keepInMemory: true`，prompt 由 `1053| function batchArticleObservePrompt(...)` 生成，`composePlan` 携带合成重建元数据 `799|           composePlan: {`）；重排后只剩一批则按普通预算单发（`809|     emitSingle(batches[0]?.text ?? text)`）。
- `packArticles`（`971| export function packArticles(articles, budget = BATCH_TOKEN_BUDGET) {`）：横切输入装配，装不下的文章只保留 frontmatter+Overview 头部（`978|       const head = text.slice(0, Math.max(0, text.indexOf('## Key Components')))`）。

### 4. 双写作通道：agentic 与单轮整包

agentic 通道（默认）：`tickArticles` 在任务组装后判定（`2358|       if (c0.agenticArticles && tasks.length) {`），先按模块源码体量打大档标记（`2362|         const agenticTasks = markBigAgenticTasks(`，体量函数 `sourceTokensOf` 来自 `23| import { runAgenticArticles, markBigAgenticTasks, sourceTokensOf } from './lib/articles-agentic.js'`），任务持久化时带 `agentic: true`（`2378|           agentic: true, // 宿主重启重跑时按 agentic 通道重跑，而不是找 batchPrompt`），再启动执行器（`2383|         startAgenticRun(job, agenticTasks)`）。`startAgenticRun`（`2023`）调用 `runAgenticArticles`（`2029|       .then(() => runAgenticArticles(tasks, {`），传入格式条款（`2038|         articleFormat: articleFormatSection(),`）、步数上限（`2039|         maxSteps: c.agenticMaxSteps`，配置 `78|   agenticMaxSteps: z.number().default(30)...硬顶 100...`）与 `fixAnchors`（`2040|         fixAnchors,`）。

退回判定：单批失败过半才算系统性失败（`859|   return failed * 2 > relevant.length`）；服务侧守 `job.agenticRetried` 只退一次（`1933|     if (job.agenticRetried) return false`）。退回路径在 `tickArticles`（`2288|       } else if (shouldFallBackHere(job, results, tasks)) {`）：只重排失败篇（`2295|         const retryTasks = tasks`），重新装填（`2303|         const { prepared, sessionTasks } = prepareArticleTasks(retryTasks, {...})`），置 `2308|         job.agenticRetried = true`，已写成功的文章不重写。

单轮通道的文章落盘在执行器侧完成：`applyTaskResult`（`441| function applyTaskResult(task, content, notes) {`）对非 keepInMemory 任务先 `fixAnchors`（`445|     const fx = fixAnchors(content, task.cwd ?? null)`）再 `448|     fs.writeFileSync(task.articlePath, fx.text, 'utf8')`。

### 5. 横切与合成

横切任务集 `crosscutTasks`（`2418|   function crosscutTasks(job, pack) {`）：`_architecture.md`（`2421|`，prompt `1006| function batchArchitecturePrompt(language, articlesText) {`，要求三张 box-drawing 图）、`_patterns.md`（`2426|`，prompt `1014| function batchPatternsPrompt(...)`）、概念文（`2431|       ...job.plan.concepts.map((c, i) => ({`，prompt `1022| function batchConceptPrompt(...)`；文件名 slug 用保留 CJK 的 `1232| function slugify(name) {`）。全部 `keepInMemory: true`，输出经 `writeValidated` 校验才落盘。

`tickCrosscut`（`2439`）：输入取成功模块文章全文（`2470`–`2475`）；总量 ≤ 大档上限则单批直出（`2490|     if (totalTokens <= bigLimit) {`，超 110k 时任务打大档标记进大档池 `2494|         if (bigTier && totalTokens > BATCH_TOKEN_BUDGET) {`）；否则拆成每模块一个观察任务并发跑（`2510|     const tasks = texts.map((a, i) => ({`，prompt `1032| function batchObservePrompt(...)`），`2514|     job.crosscutSplit = true`。观察收割后进 `compose` 阶段（`2461|         setStage(job, 'compose')`）提交合成批（`2539|   function submitComposeBatch(job, observationsText) {`）。`tickCompose`（`2525`）收割合成结果并入 tally；断点丢失（stage 落盘与提交落盘之间进程中断）时留痕降级跳过横切（`2534|       note(job, '合成批次未落盘...')`）。

文章分割的合成在 `tickArticles` 收割观察批后重建：`2231|       const splitObs = results.filter((r) => r.name.includes('#obs'))` → 按文章聚合观察（`2233|         const byArticle = new Map()`）→ 每篇提交一个合成请求（`2264|             batchPrompt: batchArticleComposePrompt({`，模板 `1073| function batchArticleComposePrompt({ language, mission, moduleName, observationsText, prevArticle }) {`）；观察全部失败时该篇缺席但不 fail 整个 job（`2283|` 注释、`2285|           setStage(job, job.kind === 'full' ? 'crosscut' : 'review')`）。

### 6. 本地核对与批量校对

`localReview`（`2552|   function localReview(job) {`）：文件存在性（`2558|         if (text === null) {` 记 missing 并回退计数）、frontmatter 必有（`2565|       if (!text.trimStart().startsWith('---')) {`，缺失则 `skipProofread`）、source_files 存在性（`2566|       const srcs = readSourceFiles(a.path)` → `2567|       const missing = srcs.filter(...)`）——只记账不删文。

`tickReview`（`2574`）的批量校对：逐篇装配「文章+源码」（`2600|       for (const a of job.articles) {`；源码预算 = 普通预算 − 文章体量 `2605|         let srcs = collectSources(job.cwd, readSourceFiles(a.path), BATCH_TOKEN_BUDGET - articleTokens)`，装不下再按大档 `2606`，连大档都装不下转会话通道 `2607|         if (srcs.oversized) {`）；按普通预算贪心合并成批量请求（`2637|       let group = []` 循环，头部余量 `2618|       const HEADER_ALLOWANCE = 1000`，成组提交 `2627|       const submitGroup = (group) => {`，单篇超预算时独立成组或转会话 `2645|         if (size > BATCH_TOKEN_BUDGET) {`；整组超预算打大档 `2634|         if (estimateTokens(t.batchPrompt) > BATCH_TOKEN_BUDGET) markBigTask(t)`）。多篇合并的输出按固定标记分节（模板 `1128| function batchProofreadBatchPrompt(language, items) {`，标记格式 `1139`），收割由 `settleProofread`（`1943|   function settleProofread(job, results, tasks) {`）按 `1951|       const re = /@@@article:[ \\t]*(.+?)[ \\t]*\\r?\\n([\\s\\S]*?)
