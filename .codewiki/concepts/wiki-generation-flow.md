---
title: wiki-generation-flow
type: concept
source_files:
  - index.js
  - client.js
tags: [wiki-generation, job-service, host-llm-service, pipeline, observability, auto-commit]
---

## Overview

`wiki-generation-flow` 是 dsh-codewiki 的核心概念：把一次「仓库 → 活 wiki」的编译拆成一条**可持久化、可中断、可续跑、可观测**的服务化流水线。它不是一次同步函数调用，而是跨多次事件循环、跨宿主重启、必要时跨会话推进的状态机。

三条设计主轴决定了整条流程的形状：

1. **阶段机与作业持久化**：作业（job）落盘在 `os.tmpdir()/dsh-codewiki-jobs.json`（`JOBS_FILE`，`1040| const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE || path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')`）、由 `setInterval` 心跳（`TICK_MS` 默认 10000，`1041| const TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)`）以 10s 节拍推进（`createJobService` 内 `start()` 调用 `tick`，`tick` 函数本体在 `2215| async function tick() {`）。进程中断后下一进程凭磁盘状态续跑；同一仓库同时只允许一个非终态作业（`submit` 中 `findActive` 检查，`2384| const findActive = (cwd) => jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage)) ?? null`；工具层幂等去重，`2474| const active = svc.findActive(cwd)`）；跨进程用 `acquireTickLock`（`1278| function acquireTickLock() {`）与 `owner` 归属判定互斥（实例身份 `instanceId` 在 `1391| const instanceId = \`svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}\``，接管逻辑在 `2241| if (job.owner && job.owner !== instanceId) {`）。
2. **token 预算优先的分批**：所有模型调用都是单轮文本生成，目的是把输入压进 ≤110k 普通档（`BATCH_TOKEN_BUDGET = 110000`，`399| const BATCH_TOKEN_BUDGET = 110000`）。超出的先改用大档（`bigProvider/bigModel`，默认 volces-ark/glm-5.3-flash，预算 `bigTokenBudget` 默认 420000，`30| const DEFAULT_BIG_PROVIDER = 'volces-ark'`、`31| const DEFAULT_BIG_MODEL = 'glm-5.3-flash'`、`33| const DEFAULT_BIG_TOKEN_BUDGET = 420000`）；装不下就拆观察批再合成（`636| for (const rel of t.sources) {` 处的切分逻辑），而不是硬塞；连大档都装不下时转「会话通道」交发起会话模型派子智能体（`628| if (tooBig) { emitSession(text); continue }`、`1683| function dispatchSessionTasks(job, tasks) {`）。
3. **确定性兜底**：行号锚点校正、frontmatter 校验、旧文保留、索引重建、入口文件生成、产物自动提交都由代码而非模型保证（`426| export function fixAnchors(content, cwd) {`、`1527| function writeValidated(job, task, content) {`、`2056| async function tickIndex(job) {`、`220| export function ensureWikiEntry(cwd, language = '中文') {`、`3155| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {`，其中 `tickCommit`（`2188| async function tickCommit(job) {`）在写成功后调用 `autoCommitWiki` 走主题分支合并式提交）。

触发入口有五个：`codewiki_generate`（三态 scope，定义于 `2404| function generateToolDefinition(cfg, svc) {`）、`codewiki_update`（固定 auto 的快捷入口，定义于 `2564| function updateToolDefinition(cfg, generateDef) {`）、`codewiki_progress`（只读查询，定义于 `2635| function progressToolDefinition(cfg, svc) {`）、面板「更新」按钮（走 `POST /api/codewiki/control` 的 compile 动作，服务端处理在 `3107| if (body?.action === 'compile' && body?.cwd) {`、客户端在 `1113| const compile = async (cwd) => {` 调用），以及自动更新调度器（`autoScan`，`3331| const autoScan = async () => {`）。

当前版本（0.10.x）的结构性变化：**规划阶段已删除**（0.10.7 起，见 `1761| // 规划阶段已删（0.10.7）：全量编译提交后直接进 articles` 注释），全量编译提交后直接进 `articles`，模块清单由 `localPlan` 本地生成（`710| export function localPlan(files) {`）；超预算不再降级旧版百炼大档（0.10.1 起删除内置百炼兼容入口，见 `288| // 宿主 llm 服务通道：唯一通道` 注释）、也不再同模型同步兜底，改为「写入任务文件 → steer 发起会话 → 轮询目标文件收割」（会话通道，`1683| function dispatchSessionTasks(job, tasks) {` 与 `SESSION_TASK_DIR` 定义于 `1046| const SESSION_TASK_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')`），且唯一模型通道是宿主 llm 服务（`llmChat` 经 `llmRef`，`296| async function llmChat({ llm, provider, model, reasoningEffort, prompt, signal, onDelta }) {`、`1351| let llmRef = null`），插件不保存任何密钥（见 `1297| // 0.10.1 起插件不存任何密钥`）。

客户端（`client.js`）提供侧边栏面板与设置页：`CodewikiPanel`（`1296| function CodewikiPanel() {`）每 2s 轮询 `JOBS_PATH`（`19| const JOBS_PATH = '/api/codewiki/jobs'`）渲染阶段条与吞吐；`ReposTab`（`1063| function ReposTab() {`）轮询 `/api/codewiki/repos` 展示仓库 wiki 状态；`SessionView`（`1209| function SessionView({ job, onClose }) {`）展示并发池每个 LLM 请求的 prompt/输出记录（保留 24h）。

## Key Components

### 1. Job Service 与阶段机

`createJobService(config, onSettled)`（`1383| function createJobService(config, onSettled) {`）是全部编排状态的唯一持有者，返回 `{ submit, cancel, list, findActive, start, stop }`（`2396| return { submit, cancel, list, findActive, start, stop }`）。

**六阶段推进**见 `STAGE_HANDLER`（`2206| const STAGE_HANDLER = {`）：`articles → crosscut → compose → review → index → commit`，另有 `submitting` 占位（`2317| stage: 'submitting',`）与 `done / failed / cancelled` 三个终态（`JOB_TERMINAL`，`1228| const JOB_TERMINAL = new Set(['done', 'failed', 'cancelled'])`）。`stale` 增量作业从 `articles` 起步直接进 `review`（tickArticles 末尾 `1885| setStage(job, job.kind === 'full' ? 'crosscut' : 'review')`）；单项目串行开启时后提交的任务先进 `queued` 排队（`2361| setStage(job, 'queued')`），tick 里轮到才转 `articles`（`2264| if (job.stage === 'queued') {`）。

**提交 `submit`**（`2303| async function submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId }) {`）次序是刻意的：先做排除清单判定（`excludedItem` 命中即抛出带命中项的错，`2305| const exHit = excludedItem(cwd, c0.excludePaths)`）→ `rememberRepo` 登记已知仓库（`2309| rememberRepo(cwd)`、`1219| function rememberRepo(cwd) {`）→ 查同 `cwd` 是否已有非终态作业（命中直接返回现有任务，`2310| const existing = jobs.find((j) => j.cwd === cwd && !JOB_TERMINAL.has(j.stage))`）→ 才创建 `stage='submitting'` 占位并落盘（`2313| const job = {`），这样即便凭证解析失败也留下可解释记录。凭证校验仅检查 `batchProvider` 非空、`batchModel` 非空与 `llmRef.stream` 存在（记录 `credentialSource`，`2339| if (!c.batchProvider) throw new Error('编译模型提供商为空...` 与 `2347| job.credentialSource = \`llm(${liveConfig(config).batchProvider}/${liveConfig(config).batchModel})\``）。收尾 `persist + flush` 后 **`void tick()` 立即推进一步**，不等首个心跳（`2368| void tick() // 立即推进一步，不等首个 tick 间隔`）。

**推进 `tick`**（`2215| async function tick() {`）有三层互斥：模块内 `ticking` 重入守卫（`2216| if (ticking) return`、`2218| ticking = true`）、跨进程文件锁 `acquireTickLock`（残留锁 60s 过期强删，`1278| function acquireTickLock() {`）、以及 `job.owner` 归属判定：另一实例的 job 若停更未超 `ORPHAN_TAKEOVER_MS`（默认 5 分钟，`1209| const ORPHAN_TAKEOVER_MS = Math.max(60000, Number(process.env.DSH_CODEWIKI_ORPHAN_TAKEOVER_MS) || 5 * 60 * 1000)`）就让路，超时则本实例接管、改 `owner`、并在途会话任务 `resendSessionSteer` 重发（`2241| if (job.owner && job.owner !== instanceId) {`）。取消不是杀进程而是标记：tick 见到 `cancelRequested` 才 `setStage('cancelled')`、`batchAborters.abort()`、`batchResults.delete`（`2252| if (job.cancelRequested) {`）；`syncCancelFlags` 每轮从磁盘拾取另一实例写入的取消标记（`1477| function syncCancelFlags() {`）。

**结果结算**三件套：`settleJob`（`1501| async function settleJob(job) {`）收割执行器结果，执行器丢失（宿主重启）时按 `job.tasks` 持久化的 `batchPrompt` 快照重跑本阶段——这是唯一恢复路径（`1512| const tasks = job.tasks ?? []`）；`writeValidated`（`1527| function writeValidated(job, task, content) {`）落盘前校验 frontmatter（不以 `---` 开头即拒绝并 note），再跑 `fixAnchors`；`tally`（`1546| function tally(job, results, tasks, { replace = false } = {}) {`）累计 `writtenCount / failedCount`，`replace=true` 用于校对结果覆盖同名条目且「校对失败不推翻已写成功的原文」。普通文章走 `applyTaskResult`（`325| function applyTaskResult(task, content, notes) {`），它按 `keepInMemory` 分叉：内存结果只回内容，文章结果直接落盘。

其他编排辅助：`setStage` 累计各阶段耗时进 `stageTimings`（`1452| const setStage = (job, stage) => {`）；`addUsage` 累计 `inputTok/outputTok/requests/batchRequests/realtimeRequests/overTier2`（`1464| const addUsage = (job, { inputTok = 0, outputTok = 0, requests = 0, batch = false, realtime = false, overTier2 = 0 } = {}) => {`）；`touch` 标脏并登记 `dirtyIds`（`1447| const touch = (job) => {`）；`flush` 先 `mergeFromDisk` 再 `saveJobs`（`1437| const flush = () => {`、`1415| function mergeFromDisk() {`），`saveJobs` 只留最近 `MAX_JOBS_KEPT = 30` 个（`1210| const MAX_JOBS_KEPT = 30`）。阶段处理函数分别为 `tickArticles`（`1765| async function tickArticles(job) {`）、`tickCrosscut`（`1910| async function tickCrosscut(job) {`）、`tickCompose`（`1995| async function tickCompose(job) {`）、`tickReview`（`2044| async function tickReview(job) {`）、`tickIndex`（`2056| async function tickIndex(job) {`）、`tickCommit`（`2188| async function tickCommit(job) {`）。`tickCommit` 调用 `autoCommitWiki`（`3155| export function autoCommitWiki(cwd, { jobId = null, writtenCount = 0 } = {}) {`）执行主题分支提交后合并回原分支，失败不改变终态只记录原因。

### 2. Token 预算与源码装填

`estimateTokens`（`278| export function estimateTokens(text) {`）：CJK 记 1 token/字，其余按 3.5 字符/token。它只回答一个问题——这批源码装不装得进 110k 普通档。

`collectSources`（`514| export function collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET) {`）按预算**整文件**内联（不做半文件截断，因为半截代码会误导行号），返回 `{text, skipped, oversized}`；连首个文件都超预算即 `oversized=true`（`528| if (first) return { text: body, skipped: [], oversized: true }`），用来区分「文件太多」与「单文件太大」两种不同的降级路径。

`numberLines`（`415| export function numberLines(content) {`）给每行加 `N| ` 前缀再喂模型，让模型直接抄前缀行号而不是自己数行。落盘前还有 `fixAnchors`（`426| export function fixAnchors(content, cwd) {`）：以 `source_files` 原文为准，按「行内反引号符号应出现在该行」的语义校正 `file:NN(-MM)` 锚点，**只改数字不动文字**，多处命中时只认 `function/class/const/let` 的声明形态（`487| const defRe = new RegExp(...)`），仍歧义则记为 `unresolved` 不动。

`prepareArticleTasks`（`585| export function prepareArticleTasks(tasks, { cwd, language, bigProvider = '', bigModel = '', bigReasoningEffort = '', bigBudget = DEFAULT_BIG_TOKEN_BUDGET } = {}) {`）是最关键的决策点，三档降级：

- 装得下 → 单批出文章（`631| if (!skipped.length && pt <= singleLimit) { emitSingle(text); continue }`）；
- 装不下但能按文件切多批 → 每批一个观察任务（`keepInMemory`，带 `splitFor` 与 `composePlan`，`650| batches.forEach((b, i) => {` 附近），后续由 compose 阶段合成整篇；
- 单文件超单请求预算、或切不出多批 → 先试大档（`bigTier`，默认 volces-ark/glm-5.3-flash，预算 420k，`597| const markBig = (t) => {`、`610| const singleLimit = bigTier ? bigTier.budget : BATCH_TOKEN_HARD_LIMIT`），大档装不下才转 `sessionTasks` 会话通道（`623| const emitSession = (sourcesText) => {`、`628| if (tooBig) { emitSession(text); continue }`）。

值得注意的是「横切先例」被复用到文章层：模块源码超预算时不是把源码硬塞给一个请求，而是「观察 → 合成」两段（`576| // 分割（观察→合成，复用横切先例）` 注释）。

### 3. 会话通道（超预算任务的兜底出口）

超预算任务不再降级旧版百炼大档，而是：

1. `dispatchSessionTasks`（`1683| function dispatchSessionTasks(job, tasks) {`）把 `t.batchPrompt` 写入 `SESSION_TASK_DIR`（`1046| const SESSION_TASK_DIR = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-session-tasks')`）下的 `<jobId>--<safeName>.prompt.txt`（`1696| const promptFile = path.join(SESSION_TASK_DIR, \`${job.id}--${safe}.prompt.txt\`)`），再 `agent.steer` 一条指令消息（`1710| agent.steer(createUserMessage(...))`）；发起会话不可用（面板/自动调度提交、会话已关）直接 `fail` 并给出「请从会话内重新提交编译」（`1687| fail(job, \`${tasks.length} 个任务超批量预算需走会话通道...\`)`）。
2. `buildSessionSteerText`（`1189| export function buildSessionSteerText({ job, snapshots, tier = '', resend = false }) {`）产出 steer 文本，按 `job.stage === 'review'` 区分「校对」与「文章」两种要求（`1190| const proofread = job.stage === 'review'`）；`sessionTier` 非空时在文本里要求 `delegate` **显式传 `tier`**（`1192| ? [\`派单要求：调用 delegate 时必须显式传 tier: "${tier}"...\`]`），因为编译主链不走子智能体档位路由，自动选路实测常被判给 `default`（`1184| // 会话通道 steer 文本（0.9.2...` 注释）。
3. `classifySessionTask`（`1172| export function classifySessionTask(task, nowMs = Date.now()) {`）判三态：超时 `SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，`1045| const SESSION_TASK_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.DSH_CODEWIKI_SESSION_TIMEOUT_MS) || 30 * 60 * 1000)`）→ `timeout`；文件 `mtime` ≥ 派发时间且以 `---` 开头 → `harvest`（`1180| if (!content.trimStart().startsWith('---')) return 'wait'`）；其余 `wait`。
4. `progressSessionTasks`（`1721| function progressSessionTasks(job) {`）收割：`harvest` 走 `writeValidated` 闸门落盘（`1730| results.push(writeValidated(job, t, fs.readFileSync(t.articlePath, 'utf8')))`），`timeout` 记失败（不降级插件内通道），全部终态才推进阶段；review 阶段用 `replace` 语义覆盖同名条目（`1738| if (results.length) tally(job, results, before, { replace: job.stage === 'review' })`）。
5. `resendSessionSteer`（`1744| function resendSessionSteer(job) {`）在宿主重启接管后重发一次且**不重置 `dispatchedAt`**（`1743| // 超时计时保持原起点；子智能体重写同一文件，幂等。`），超时计时保持原起点，子智能体重写同一文件因而幂等。

### 4. Prompt 模板族

模板全是纯函数构造器，集中在 index.js：

| 构造器 | 位置 | 产出 |
| --- | --- | --- |
| `localPlan` | `710| export function localPlan(files) {` | 本地规划（按顶层目录分组，无模型请求）`{project, modules[{name,summary,files}], concepts}` |
| `batchArticlePrompt` | `545| function batchArticlePrompt({ language, mission, sourcesText, prevArticle }) {` | 单篇模块文章（源码内联 + mission + 可选旧文 + 格式段） |
| `batchObservePrompt` | `788| function batchObservePrompt(language, moduleName, articleText) {` | 横切 map 阶段的模块观察，**刻意不带 frontmatter** |
| `batchArticleObservePrompt` | `809| function batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal) {` | 文章分割观察，要求保留全部函数/类/常量/行号 |
| `batchArticleComposePrompt` | `829| function batchArticleComposePrompt({ language, mission, moduleName, observationsText, prevArticle }) {` | 多批观察 → 整篇模块文章 |
| `batchArchitecturePrompt` | `762| function batchArchitecturePrompt(language, articlesText) {` | 三张 box-drawing 图，`type: architecture` |
| `batchPatternsPrompt` | `770| function batchPatternsPrompt(language, articlesText) {` | `type: pattern` |
| `batchConceptPrompt` | `778| function batchConceptPrompt(language, concept, articlesText) {` | `type: concept`，章节 Overview / Involved Modules / Flow / Implementation Map |
| `batchProofreadPrompt` | `861| function batchProofreadPrompt({ language, articleText, sourcesText }) {` | `articleText + 源码 → 修正后整文`，四项核对 |
| `batchProofreadBatchPrompt` | `884| function batchProofreadBatchPrompt(language, items) {` | 多篇文章合并请求，按 `@@@article`/`
