// JobService 的持久化 / 跨实例协调层（从 index.js 抽出的可测部分）。
//
// 为什么单独一层：作业状态是**跨进程**的现场（同一台机器两个宿主窗口各跑一个
// JobService，共享一份 jobs.json），而 index.js 里的 createJobService 把它和
// tick 的业务推进缠在一起，任何一条语义都只能靠「起两个真宿主」来验证。
// 这里只保留三件事，并且全部做成纯函数/小类：
//
//   1. 磁盘层：原子读写、损坏检测、跨进程 tick 锁；读写失败一律显式（不吞）。
//   2. 现场合并：多实例的 job 列表合并、同仓幂等查找、所有权/心跳判定。
//   3. 原生通道重放：可序列化的执行配置快照，以及「宿主重启后该重跑还是该失败」的裁决。
//
// 硬不变量：
//   A. jobs.json 永远只由「写临时文件 + fsync + rename」替换，读到的内容要么是上一版
//      要么是新版，不存在半写状态。（旧实现直接 writeFileSync 覆盖，写一半崩溃就得到
//      一个截断的 JSON —— 而 loadJobs 的 catch 把它读成「没有任务」，于是同一仓库被
//      重复提交、两个引擎同时往同一个仓库写。）
//   B. 读不出来时**不允许**当成「没有活动任务」：调用方必须能区分 ok/missing/corrupt/
//      unreadable，幂等判定只在 ok|missing 上成立（fail-closed）。
//   C. 敏感凭证与函数值不得进 jobs.json。函数是这里真正的陷阱：JSON.stringify 对函数
//      值**静默丢弃**，于是 `llm` 这类执行期依赖会悄悄消失、而不是报错——所以序列化
//      时主动检测并抛错，让新宿主按当前配置重建执行器，而不是读取一个「看起来正常」
//      但缺字段的快照。
//   D. 取消是终态：任何重放裁决都必须先看 cancelRequested，绝不复活血。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const JOBS_SCHEMA = 2

export class JobsStoreError extends Error {
  constructor(message, { code, path: file = null, detail = null } = {}) {
    super(message)
    this.name = 'JobsStoreError'
    this.code = code ?? 'jobs-store'
    this.path = file
    this.detail = detail
  }
}

// 路径身份 key：去尾分隔符 + 归一化；只在 win32 折叠大小写。
// （与 index.js 的 normPathKey 同语义，这里独立一份是为了让本模块不反向依赖 index.js。）
export function normKey(p) {
  const n = path.normalize(String(p ?? '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n.toLowerCase() : n
}

// ---------------------------------------------------------------------------
// 1. 序列化：凭证与函数值的闸门
// ---------------------------------------------------------------------------

// 键名命中即拒写。放宽到「包含」是因为真实事故里的键名是 CODEWIKI_API_KEY 这类
// 环境变量名（见 nativeEnginePlan），而不是干净的 `apiKey`。
// 不收 `maxTokens`/`outputTokens` 这类**计数**字段：它们不含凭证，且是面板要用的。
const SECRET_KEY_RE = /api[-_]?key|secret|passw|authorization|private[-_]?key|(^|[-_])token$/i

export function serializeJobs(payload) {
  return JSON.stringify(payload, function (key, value) {
    if (typeof value === 'function') {
      // JSON.stringify 对函数静默丢弃：不拦下来，job 里少一个执行器字段也没人知道。
      throw new JobsStoreError(
        `job 持久化遇到函数值（字段 ${JSON.stringify(key)}）：函数无法序列化，JSON 会静默丢弃它；执行期依赖应由新宿主按当前配置重建，不进快照`,
        { code: 'job-serialize-function', detail: String(key) },
      )
    }
    if (key && SECRET_KEY_RE.test(String(key))) {
      throw new JobsStoreError(
        `job 持久化遇到疑似凭证字段（${String(key)}）：凭证绝不入 jobs.json`,
        { code: 'job-secret-field', detail: String(key) },
      )
    }
    return value
  }, 2)
}

// ---------------------------------------------------------------------------
// 2. 磁盘层：原子写 + 显式失败
// ---------------------------------------------------------------------------

// rename 在 Windows 上会因目标被短暂占用（另一个实例正在 readFileSync）而 EPERM/EBUSY。
// 退避重试 4 次（10/30/60/100ms）即覆盖这个窗口；仍失败就抛，换调用方决策。
const RENAME_RETRY_MS = [10, 30, 60, 100]

export function createJobsStore({ file, maxKept = 30, instanceTag = 'svc' } = {}) {
  if (!file) throw new JobsStoreError('createJobsStore: 需要 file', { code: 'jobs-store-no-file' })
  const lockFile = `${file}.lock`
  // 隔离标记：损坏文件被改名后原路径就空了，后来者只会看到 ENOENT。若把 ENOENT 一律
  // 当 missing，隔离的那一刻起幂等判定就 fail-open（同一仓库会被重复执行）。所以改名
  // 必须留下「上一版是坏的」这条事实，直到一次成功写入证明现场已经恢复正常。
  const corruptMarkerFile = `${file}.corrupt`

  // ── 读 ────────────────────────────────────────────────────────────────
  // 返回 { jobs, state, error? }，state ∈ ok|missing|unreadable|corrupt。
  // 三种坏状态的区别是有意义的：missing 是「全新机器」，可以当空；corrupt 说明文件
  // 内容已经不是合法 JSON（外部破坏/旧版半写），unreadable 是权限或 I/O 问题——
  // 后两种必须让幂等判定 fail-closed，否则会重复执行同一仓库。
  function load() {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // 没有主文件不代表现场干净：先看有没有「上一次是坏的」这条标记。
        const prev = readCorruptMarker()
        if (prev) return { jobs: [], state: 'corrupt', error: `上一版 jobs 文件损坏已被隔离（${prev.detail ?? '原因未知'}）`, quarantinedAt: prev.quarantinedAt }
        return { jobs: [], state: 'missing' }
      }
      return { jobs: [], state: 'unreadable', error: describeError(err) }
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (err) {
      return { jobs: [], state: 'corrupt', error: describeError(err), quarantinedAt: quarantine(describeError(err)) }
    }
    if (!Array.isArray(data?.jobs)) {
      return { jobs: [], state: 'corrupt', error: 'jobs 字段缺失或不是数组', quarantinedAt: quarantine('jobs 字段缺失或不是数组') }
    }
    return { jobs: data.jobs, state: 'ok' }
  }

  // 幂等判定的前置闸门：只有「读到了完整现场」或「文件本来就不存在」这两种情况，
  // 才能断言「这个仓库当前没有活动任务」。corrupt/unreadable 时断言不了——把它当空
  // 就是重复执行（旧实现在这里静默返回 []）。
  //
  // 这是调用方必须自己接的一步，不是本模块能替它决定的：拒绝提交要报错给用户，
  // 而「报什么错」属于 JobService。
  function loadForIdempotency() {
    const snap = load()
    return { ...snap, safe: snap.state === 'ok' || snap.state === 'missing' }
  }

  // 损坏文件改名保留证据（而不是删掉）：面板/人需要能看到「上一版到底坏在哪」。
  // 改名失败只能放弃——此刻已经没有别的补救路径，主文件内容也不是我能修的。
  function quarantine(detail, now = Date.now()) {
    const dest = `${file}.corrupt-${now}`
    let renamed = dest
    try { fs.renameSync(file, dest) } catch { renamed = null }
    try {
      fs.writeFileSync(corruptMarkerFile, JSON.stringify({ quarantinedAt: renamed, detail: detail ?? null, at: new Date().toISOString() }), 'utf8')
    } catch { /* 标记都写不进去时 load 只能看到原文件的坏内容本身，next save 会修好 */ }
    return renamed
  }

  function readCorruptMarker() {
    try { return JSON.parse(fs.readFileSync(corruptMarkerFile, 'utf8')) } catch { return null }
  }

  function clearCorruptMarker() {
    try { fs.unlinkSync(corruptMarkerFile) } catch { /* 没有标记就是正常情况 */ }
  }

  // ── 写 ────────────────────────────────────────────────────────────────
  function save(jobs) {
    const kept = (Array.isArray(jobs) ? jobs : []).slice(-maxKept)
    const text = serializeJobs({ schema: JOBS_SCHEMA, savedAt: new Date().toISOString(), jobs: kept })
    writeAtomic(text)
  }

  function writeAtomic(text) {
    // 临时文件必须与目标同目录（同卷）：跨卷 rename 会退化成复制，失去原子性。
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
    let fd
    try {
      fd = fs.openSync(tmp, 'w')
      fs.writeFileSync(fd, text, 'utf8')
      // 先 fsync 再 rename：顺序反了的话断电后目标可能指向一个长度已知但内容空洞的文件。
      try { fs.fsyncSync(fd) } catch { /* 某些文件系统不支持 fsync 到 fd，rename 仍是原子的 */ }
    } catch (err) {
      try { fs.closeSync(fd) } catch { /* 已经失败，关不掉也不影响抛错 */ }
      try { fs.unlinkSync(tmp) } catch { /* 临时文件可能根本没建出来 */ }
      throw new JobsStoreError(`jobs 文件写入失败：${describeError(err)}`, { code: 'jobs-write', path: file, detail: describeError(err) })
    }
    try { fs.closeSync(fd) } catch { /* 同上 */ }

    let lastErr = null
    for (let i = 0; i <= RENAME_RETRY_MS.length; i += 1) {
      try {
        fs.renameSync(tmp, file)
        // 一次成功写入就把「上一版是坏的」这条事实清掉：现场已经恢复，幂等判定不必再 fail-closed。
        clearCorruptMarker()
        return
      } catch (err) {
        lastErr = err
        if (i === RENAME_RETRY_MS.length) break
        sleepSync(RENAME_RETRY_MS[i])
      }
    }
    try { fs.unlinkSync(tmp) } catch { /* 残留临时文件无害（不会被当成 jobs 读） */ }
    throw new JobsStoreError(`jobs 文件替换失败：${describeError(lastErr)}`, { code: 'jobs-rename', path: file, detail: describeError(lastErr) })
  }

  // ── 跨进程 tick 锁 ─────────────────────────────────────────────────────
  // 锁内容带 instanceTag：释放时校验归属，绝不会删掉「已经超时被别的实例接管」的锁
  // （旧实现无条件 unlink，两个实例交错时会把对方的锁删掉，于是两边同时推进同一 job）。
  //
  // 存活判定只用真实时钟：锁的年龄来自文件系统 mtime，拿一个调用方合成的 now 去减它
  // 就是两个时钟混用，负年龄会被读成「活的」，崩溃锁永远等不到接管。
  function acquireTickLock({ staleMs = 60000 } = {}) {
    const token = `${process.pid}|${instanceTag}|${Date.now()}`
    try {
      fs.writeFileSync(lockFile, token, { flag: 'wx' })
      return token
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw new JobsStoreError(`tick 锁获取失败：${describeError(err)}`, { code: 'jobs-lock', path: lockFile, detail: describeError(err) })
      }
      let st
      try { st = fs.statSync(lockFile) } catch { return null } // 刚被别的实例释放：本轮让路
      if (Date.now() - st.mtimeMs <= staleMs) return null // 活的：让路
      // 崩溃进程不会自己删锁。超时强删后重抢一次，抢不到说明别的实例已经抢到了。
      try { fs.unlinkSync(lockFile) } catch { return null }
      try { fs.writeFileSync(lockFile, token, { flag: 'wx' }); return token } catch { return null }
    }
  }

  function releaseTickLock(token) {
    if (!token) return false
    let cur
    try { cur = fs.readFileSync(lockFile, 'utf8') } catch { return false }
    if (cur !== token) return false
    try { fs.unlinkSync(lockFile); return true } catch { return false }
  }

  return { file, lockFile, instanceTag, load, loadForIdempotency, save, writeAtomic, acquireTickLock, releaseTickLock }
}

// ---------------------------------------------------------------------------
// 3. 现场合并 / 幂等 / 所有权
// ---------------------------------------------------------------------------

export const TERMINAL_STAGES = Object.freeze(['done', 'partial', 'failed', 'cancelled'])
// 「没有执行器可丢」的阶段：排队中/提交中不持有任何在飞请求，超时只意味着没人替它推进，
// 绝不意味着「原生引擎执行器丢失」。旧实现把这类 job 也按孤儿接管，会把一条正常的
// 排队任务写成「原实例停更 X 分钟，本实例接管推进」，并在原生通道上直接判失败。
export const NO_EXECUTOR_STAGES = Object.freeze(['queued', 'submitting'])

export const isTerminalStage = (stage) => TERMINAL_STAGES.includes(String(stage ?? ''))

export const OWNERSHIP = Object.freeze({
  MINE: 'mine',
  LEGACY: 'legacy',
  LIVE_OTHER: 'live-other',
  IDLE_NO_EXECUTOR: 'idle-no-executor',
  ORPHAN: 'orphan',
})

export const FOREIGN_ACTION = Object.freeze({
  LEAVE: 'leave',
  ADOPT: 'adopt',
  VOID: 'void',
})

// tick 遇到「别的实例拥有的非终态任务」时的处置。
//
// 排队/占位阶段没有执行器可丢，超时只说明没人替它推进（旧实现此时直接 continue，
// 于是宿主重启前提交的排队项永久卡在 queued：既占着闸门窗口，又让同仓幂等一直返回它，
// 用户连重新提交都做不到）。分两种结局：
//   · 直接作废——自动调度遗留的排队项。它和下一轮扫描重复，几小时前的旧请求没有继续
//     排队的价值；作废后该仓库的幂等记录随之释放。
//   · 接管——用户手动提交的排队项，接管后按 FIFO 继续排队。
// 提交中断（submitting）没有可续状态（job 还没过凭证校验），任何来源都作废。
export function planForeignJob(job, { instanceId, now = Date.now(), orphanTakeoverMs }) {
  const ownership = classifyOwnership(job, { instanceId, now, orphanTakeoverMs })
  if (ownership === OWNERSHIP.MINE || ownership === OWNERSHIP.LIVE_OTHER) {
    return { ownership, action: FOREIGN_ACTION.LEAVE }
  }
  const stage = String(job?.stage ?? '')
  if (stage === 'submitting') {
    return { ownership, action: FOREIGN_ACTION.VOID, reason: '提交未完成（原实例在此阶段停更），没有可续状态' }
  }
  if (stage === 'queued' && job?.auto === true) {
    return { ownership, action: FOREIGN_ACTION.VOID, reason: '自动调度遗留的排队项（原实例停更），下一轮扫描会重新提交' }
  }
  return { ownership, action: FOREIGN_ACTION.ADOPT }
}

// 最后活跃时刻：心跳优先，其次 updatedAt/createdAt。取 max 而不是「第一个存在的」，
// 是因为 mergeFromDisk 会用磁盘版本整体替换内存版本，两组时间戳可能不同步。
export function lastSeenAt(job) {
  const stamps = [job?.heartbeatAt, job?.updatedAt, job?.createdAt]
    .map((v) => Date.parse(String(v ?? '')))
    .filter((n) => Number.isFinite(n))
  return stamps.length ? Math.max(...stamps) : NaN
}

export function classifyOwnership(job, { instanceId, now = Date.now(), orphanTakeoverMs }) {
  const owner = String(job?.owner ?? '')
  if (!owner) return OWNERSHIP.LEGACY // 0.4.2 之前的残留：任何实例都可接手续查
  if (owner === instanceId) return OWNERSHIP.MINE
  const last = lastSeenAt(job)
  // 时间戳损坏（手工编辑/旧格式）时无法证明对方还活着，按可接管处理。
  if (!Number.isFinite(last)) return OWNERSHIP.LEGACY
  if (now - last <= orphanTakeoverMs) return OWNERSHIP.LIVE_OTHER
  return NO_EXECUTOR_STAGES.includes(String(job.stage ?? '')) ? OWNERSHIP.IDLE_NO_EXECUTOR : OWNERSHIP.ORPHAN
}

// 运行中的心跳：让宿主慢一点（长批次/等引擎）也不会被别的实例判成孤儿。
// 按 everyMs 节流——jobs.json 是整文件重写，每 tick 都写一遍没必要。
export const HEARTBEAT_MS = 30000

export function heartbeat(job, { instanceId, now = Date.now(), everyMs = HEARTBEAT_MS } = {}) {
  if (String(job?.owner ?? '') !== instanceId) return false
  const last = Date.parse(String(job?.heartbeatAt ?? ''))
  if (Number.isFinite(last) && now - last < everyMs) return false
  const iso = new Date(now).toISOString()
  job.heartbeatAt = iso
  job.updatedAt = iso
  return true
}

export function adoptOrphan(job, { instanceId, now = Date.now() }) {
  const iso = new Date(now).toISOString()
  job.owner = instanceId
  job.ownerAdoptedAt = iso
  job.heartbeatAt = iso
  job.updatedAt = iso
  return job
}

// 同仓只需一个活动任务：返回**最新**那条。取最新而非最早，是因为历史遗留可能让同一
// 仓库挂着多条活动记录（旧版幂等只看内存），该恢复的是最近那次提交。
export function findActiveJob(jobs, cwd, { keyOf = normKey } = {}) {
  const key = keyOf(cwd)
  let best = null
  for (const j of jobs) {
    if (isTerminalStage(j.stage)) continue
    if (keyOf(j.cwd) !== key) continue
    if (!best || String(j.createdAt ?? '').localeCompare(String(best.createdAt ?? '')) > 0) best = j
  }
  return best
}

// 发起会话变更：同一仓库被另一个会话再次提交时，完成唤醒必须发到**新的**会话
// （旧会话可能早已关闭，steer 会石沉大海）。归属历史保留下来，面板能解释唤醒去了谁。
export function reassignSession(job, sessionId, { now = Date.now() } = {}) {
  const next = String(sessionId ?? '').trim()
  if (!next || next === job.sessionId) return false
  const history = Array.isArray(job.sessionOwnerHistory) ? job.sessionOwnerHistory : []
  job.sessionOwnerHistory = [...history, { from: job.sessionId ?? null, to: next, at: new Date(now).toISOString() }].slice(-10)
  job.sessionId = next
  return true
}

// 内存现场 + 磁盘现场的合并。disk 覆盖内存的条件只有两条：本实例没改过它（dirtyIds），
// 且磁盘版本更新。否则慢 tick 会用过期快照把对方的 note/batchRef 洗掉。
export function mergeJobLists({ mine, disk, dirtyIds = new Set() }) {
  const byId = new Map(mine.map((j) => [j.id, j]))
  let changed = false
  for (const theirs of disk) {
    const cur = byId.get(theirs.id)
    if (!cur) { byId.set(theirs.id, theirs); changed = true; continue }
    if (dirtyIds.has(theirs.id)) continue
    if (String(theirs.updatedAt ?? '') > String(cur.updatedAt ?? '')) {
      byId.set(theirs.id, theirs)
      changed = true
    }
  }
  if (!changed) return { jobs: mine, changed: false }
  const jobs = [...byId.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  return { jobs, changed: true }
}

// ---------------------------------------------------------------------------
// 4. 原生通道：可重放快照与重放裁决
// ---------------------------------------------------------------------------

export const NATIVE_SNAPSHOT_VERSION = 1
export const NATIVE_MAX_ATTEMPTS_DEFAULT = 3

// 只收「下次还能原样再下发的执行配置」：仓库/scope/kind/语言/并发度/引擎入口与超时。
// 明确**不收**的：llm 服务、bridge（随机端口 + 占位 key）、onProgress/onLog 回调、
// 任何 provider 凭证——它们属于「当前宿主」，重启后必须由新宿主重建，持久化只会
// 留下过期指针（桥端口已死）或泄密面。
export function snapshotNativeRun(job, { channel, attempt = 1, docsDir = null, moduleConcurrency = 1, rawTreeRoot = null, now = new Date() } = {}) {
  return {
    version: NATIVE_SNAPSHOT_VERSION,
    channel: {
      python: String(channel?.python ?? ''),
      entry: String(channel?.entry ?? ''),
      timeoutMs: Number(channel?.timeoutMs ?? 0) || null,
      scope: String(channel?.scope ?? job?.scope ?? 'full'),
    },
    scope: String(job?.scope ?? 'full'),
    kind: job?.kind ?? null,
    language: String(job?.language ?? ''),
    moduleConcurrency: Math.max(1, Number(moduleConcurrency) || 1),
    rawTreeRoot: rawTreeRoot ? String(rawTreeRoot) : null,
    docsDir: docsDir ? String(docsDir) : null,
    attempt: Math.max(1, Number(attempt) || 1),
    capturedAt: now.toISOString(),
  }
}

// 宿主重启后该不该重跑这一轮原生编译。
//
// 旧行为（job.nativeStarted === true 且内存里没有执行器 → 直接 failed）把「执行器丢了」
// 误当成「这轮编译不可续」：原生通道的全部输入（scope/kind/language/引擎入口/超时）
// 本来就在 job 上，重启后完全可重放。代价是重跑一次编译，收益是用户不必手工重新提交；
// 而 failed 是纯损失（一个已经跑了一半的仓库被标成没有成果）。
//
// 三条刹车：取消（终态，绝不复活血）、已有快照里记录的尝试次数到顶（宿主崩溃循环时
// 不能无限烧全量编译）、终态。
export function planNativeReplay(job, { maxAttempts = NATIVE_MAX_ATTEMPTS_DEFAULT, exists = (p) => fs.existsSync(p) } = {}) {
  if (isTerminalStage(job?.stage)) return { replayable: false, reason: '任务已是终态', cancelled: false, exhausted: false }
  if (job?.cancelRequested === true) return { replayable: false, reason: '任务已请求取消（取消是终态，不复活）', cancelled: true, exhausted: false }
  const channel = job?.nativeChannel
  if (!channel || !String(channel.python ?? '').trim() || !String(channel.entry ?? '').trim()) {
    // 没有引擎快照就无法重建执行器：这是**真的**不可续，必须显式失败（旧 job 可能只有
    // nativeStarted 而没有 nativeChannel）。
    return { replayable: false, reason: '原生通道缺少引擎快照（job 文件里没有 nativeChannel），无法续跑；请重新提交编译', cancelled: false, exhausted: false }
  }
  const attempt = Math.max(0, Number(job?.nativeSnapshot?.attempt ?? 0) || 0)
  if (attempt >= maxAttempts) {
    return { replayable: false, reason: `原生引擎已连续中断 ${attempt} 次（上限 ${maxAttempts}），停止重跑；请检查宿主稳定性后重新提交`, cancelled: false, exhausted: true }
  }
  const prevDocsDir = String(job?.nativeSnapshot?.docsDir ?? '')
  return {
    replayable: true,
    attempt: attempt + 1,
    // 宿主强杀不会执行 startNativeRun 的 finally，临时目录里保留的是引擎已提交的
    // 叶子终态。重放时只补水缺失状态，不覆盖它；Python 适配器按签名决定能否续用。
    resumeDocsDir: prevDocsDir && exists(prevDocsDir) ? prevDocsDir : null,
    reason: attempt === 0
      ? '原生引擎执行器丢失（宿主重启），按快照重跑本轮'
      : `原生引擎执行器丢失（宿主重启），按快照重跑本轮（第 ${attempt + 1} 次）`,
    cancelled: false,
    exhausted: false,
  }
}

// ---------------------------------------------------------------------------

function describeError(err) {
  if (!err) return '未知错误'
  const code = err.code ? `${err.code}: ` : ''
  return `${code}${String(err.message ?? err)}`
}

// 同步退避：写盘路径上不能 await（save 是同步 API，tick 的 finally 也要能同步落盘）。
// Windows 的 rename 竞争窗口是毫秒级，用 Atomics.wait 精确睡眠而不是忙等。
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}
