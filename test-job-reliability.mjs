// test-job-reliability.mjs — JobService 的持久化 / 跨实例幂等 / 原生重启接管。
//
// 这个文件守的是 lib/job-store.js 与「两个实例共享一份 jobs.json」这条线：
//
//   1. 磁盘层：原子写、损坏隔离、读写失败显式化（不静默当空）。
//   2. 跨实例：同仓只允许一个活动任务；技能从磁盘吸收对方的现场；会话归属变更落盘。
//   3. 原生通道：宿主重启后按持久化快照重跑中断的 run；取消是终态，绝不被复活。
//   4. 所有权：queued/submitting 没有执行器可丢，不能被当孤儿接管。
//
// 为什么要自建两套「最小 JobService」而不是直接跑 index.js：index.js:2818-2824 的
// 旧行为（nativeStarted=true 且内存无执行器 → failed）正是本次要替换的语义，在它
// 被接线之前，只有绕过它才能验证「新语义是对的」。这两套 harness 就是建议主代理
// 采用的接线形状：submit 走 loadForIdempotency + mergeJobLists + findActiveJob，
// tick 走 classifyOwnership + planNativeReplay。
//
// 运行：node test-job-reliability.mjs（成功退出码 0）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const {
  JOBS_SCHEMA,
  JobsStoreError,
  createJobsStore,
  serializeJobs,
  normKey,
  isTerminalStage,
  findActiveJob,
  classifyOwnership,
  OWNERSHIP,
  adoptOrphan,
  heartbeat,
  lastSeenAt,
  mergeJobLists,
  reassignSession,
  snapshotNativeRun,
  planNativeReplay,
} = await import('./lib/job-store.js')

let failures = 0
let checks = 0
function check(cond, msg) {
  checks += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

const madeDirs = []
function makeWorkspace(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cw-job-rel-${tag}-`))
  madeDirs.push(dir)
  return { dir, file: path.join(dir, 'jobs.json') }
}
const readRaw = (file) => fs.readFileSync(file, 'utf8')
const readJobs = (file) => JSON.parse(readRaw(file)).jobs
const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))

// ── 最小 JobService（两实例共享磁盘现场）──────────────────────────────────────
// 只实现被本文件验证的语义：提交幂等、所有权接管、原生重放、取消。
// runNative 注入，签名 (job) => Promise<{outcome, writtenCount}>；返回永不落地的
// promise 即模拟「宿主在引擎跑到一半时被杀」——那正是真实的中断形态。
const NATIVE_DONE = { outcome: 'done', writtenCount: 3, blockers: [] }

function makeService({ store, instanceId, orphanTakeoverMs = 60000, runNative = async () => NATIVE_DONE }) {
  let jobs = store.load().jobs
  let seq = 0
  const inflight = new Map() // jobId → Promise（本实例进程内的执行器）
  const acceptTerminal = new Set(['done', 'partial', 'failed', 'cancelled'])

  const flush = () => {
    jobs = [...jobs].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    store.save(jobs)
  }
  const absorb = () => {
    const snap = store.load()
    const merged = mergeJobLists({ mine: jobs, disk: snap.jobs })
    jobs = merged.jobs
    return merged
  }
  const nowIso = () => new Date().toISOString()
  const touch = (job) => { job.updatedAt = nowIso() }

  function submit({ cwd, sessionId = null, scope = 'full', language = '中文', channel = null } = {}) {
    const snap = store.loadForIdempotency()
    if (!snap.safe) {
      // 幂等闸门 fail-closed：现场读不全时无法断言「这个仓库没有活动任务」，
      // 提交出去就可能与另一个实例同时跑同一个仓库。
      throw new JobsStoreError(`jobs 现场不可读（${snap.state}），拒绝提交以避免重复执行：${snap.error ?? ''}`, {
        code: 'jobs-idempotency-unverified',
        path: store.file,
      })
    }
    jobs = mergeJobLists({ mine: jobs, disk: snap.jobs }).jobs
    const existing = findActiveJob(jobs, cwd)
    if (existing) {
      reassignSession(existing, sessionId)
      if (sessionId) { touch(existing); flush() }
      return { job: existing, existed: true }
    }
    const ts = nowIso()
    const job = {
      id: `job-${Date.now().toString(36)}-${(seq++).toString(36)}`,
      owner: instanceId,
      cwd,
      scope,
      language,
      kind: null,
      stage: 'articles',
      channel,
      sessionId,
      notes: [],
      createdAt: ts,
      updatedAt: ts,
    }
    if (channel === 'native') {
      job.nativeChannel = { python: 'node', entry: 'fake-engine.mjs', timeoutMs: 600000, scope }
    }
    jobs.push(job)
    flush()
    return { job, existed: false }
  }

  function cancel(jobId) {
    absorb()
    const job = jobs.find((j) => j.id === jobId)
    if (!job || isTerminalStage(job.stage)) return false
    job.cancelRequested = true
    touch(job)
    flush()
    return true
  }

  // 单轮 tick：接管判定 → 取消 → 原生通道重放/启动。
  // now 参数化：真实时间要等 5 分钟才构成孤儿，测试必须能在毫秒内走完同一条分支。
  async function tick({ now = Date.now(), heartbeatMs = 30000 } = {}) {
    absorb()
    for (const job of jobs) {
      if (isTerminalStage(job.stage)) continue
      const own = classifyOwnership(job, { instanceId, now, orphanTakeoverMs })
      if (own === OWNERSHIP.LIVE_OTHER) continue
      if (own === OWNERSHIP.ORPHAN || own === OWNERSHIP.IDLE_NO_EXECUTOR) {
        job.notes = [...(job.notes ?? []), `原实例 ${job.owner} 停更，本实例接管推进`].slice(-50)
        adoptOrphan(job, { instanceId, now })
      }
      heartbeat(job, { instanceId, now, everyMs: heartbeatMs })

      if (job.cancelRequested) {
        job.stage = 'cancelled'
        job.outcome = 'cancelled'
        job.finishedAt = nowIso()
        job.notes = [...(job.notes ?? []), '已取消：原生引擎进程树已终止'].slice(-50)
        touch(job)
        continue
      }
      if (job.channel !== 'native') {
        job.stage = 'done'
        job.outcome = 'done'
        job.finishedAt = nowIso()
        touch(job)
        continue
      }
      // 原生通道：内存里有在跑的执行器就不重启（重启才是真正的重复执行）。
      if (inflight.has(job.id)) continue
      if (job.nativeStarted === true) {
        const plan = planNativeReplay(job)
        if (!plan.replayable) {
          if (plan.exhausted) {
            job.stage = 'failed'
            job.outcome = 'failed'
            job.error = plan.reason
            job.finishedAt = nowIso()
            job.notes = [...(job.notes ?? []), plan.reason].slice(-50)
            touch(job)
          }
          continue
        }
        job.nativeSnapshot = snapshotNativeRun(job, {
          channel: job.nativeChannel,
          attempt: plan.attempt,
          docsDir: path.join(os.tmpdir(), `cw-rel-docs-${job.id}-${plan.attempt}`),
        })
        job.notes = [...(job.notes ?? []), plan.reason].slice(-50)
      }
      job.nativeStarted = true
      job.nativeSnapshot = snapshotNativeRun(job, {
        channel: job.nativeChannel,
        attempt: Math.max(1, Number(job.nativeSnapshot?.attempt ?? 1)),
      })
      job.notes = [...(job.notes ?? []), `原生通道启动（第 ${job.nativeSnapshot.attempt} 次）`].slice(-50)
      touch(job)
      flush()
      const run = Promise.resolve()
        .then(() => runNative(job))
        .then((res) => {
          if (isTerminalStage(job.stage)) return
          job.stage = acceptTerminal.has(res.outcome) ? res.outcome : 'failed'
          job.outcome = job.stage
          job.writtenCount = Number(res.writtenCount ?? 0) || 0
          job.blockers = res.blockers ?? []
          job.finishedAt = nowIso()
          touch(job)
          flush()
        })
        .finally(() => { inflight.delete(job.id); touch(job) })
      inflight.set(job.id, run)
    }
    flush()
  }

  const findActive = (cwd) => findActiveJob(absorb().jobs, cwd)
  return { instanceId, submit, cancel, tick, findActive, snapshot: () => jobs, settle: () => Promise.all([...inflight.values()]) }
}

// ============================ 用例 1：序列化闸门 ============================
console.log('== 用例 1：凭证与函数值绝不进 jobs.json ==')
{
  const ok = { schema: JOBS_SCHEMA, jobs: [{ id: 'j1', cwd: 'C:/repo', scope: 'full', model: 'hy3', provider: 'workbuddy', language: '中文' }] }
  const text = serializeJobs(ok)
  const back = JSON.parse(text)
  check(back.schema === JOBS_SCHEMA, 'schema 落盘')
  check(back.jobs[0].model === 'hy3' && back.jobs[0].provider === 'workbuddy', 'model/provider/scope/language 这类非敏感配置可持久化')

  let funcErr = null
  try { serializeJobs({ jobs: [{ id: 'j2', llm: { stream: async function () {} } }] }) } catch (e) { funcErr = e }
  check(funcErr instanceof JobsStoreError, '函数值被拒（不是静默丢弃）')
  check(funcErr?.code === 'job-serialize-function', `错误码 job-serialize-function（实际 ${funcErr?.code}）`)
  check(String(funcErr?.message ?? '').includes('按当前配置重建'), '错误信息说明执行期依赖应由新宿主重建')

  for (const key of ['apiKey', 'CODEWIKI_API_KEY', 'secret', 'authorization', 'privateKey', 'refresh_token']) {
    let err = null
    try { serializeJobs({ jobs: [{ id: 'j3', [key]: 'x' }] }) } catch (e) { err = e }
    check(err?.code === 'job-secret-field', `疑似凭证字段 ${key} 被拒（实际 ${err?.code ?? '未抛错'}）`)
  }
  for (const key of ['maxTokens', 'outputTokens', 'moduleConcurrency']) {
    let err = null
    try { serializeJobs({ jobs: [{ id: 'j4', [key]: 1 }] }) } catch (e) { err = e }
    check(err === null, `计数/并发字段 ${key} 不被误判为凭证`)
  }
}

// ============================ 用例 2：原子写与损坏隔离 ============================
console.log('== 用例 2：原子写（临时文件 + rename）与损坏现场隔离 ==')
{
  const { dir, file } = makeWorkspace('atomic')
  const store = createJobsStore({ file, instanceTag: 'svc-atomic' })
  const base = Array.from({ length: 40 }, (_, i) => ({ id: `j${i}`, cwd: `C:/r${i}`, stage: 'done', createdAt: new Date(1000 + i).toISOString(), updatedAt: new Date(1000 + i).toISOString() }))
  store.save(base)
  check(fs.existsSync(file), 'jobs.json 已落盘')
  check(tmpLeftovers(dir).length === 0, `没有残留临时文件（实际 ${JSON.stringify(tmpLeftovers(dir))}）`)
  check(readJobs(file).length === 30, `只保留最近 30 条（实际 ${readJobs(file).length}）`)
  check(store.load().state === 'ok', 'load 返回 ok')

  // 半写现场：旧实现会把它读成「没有任务」，于是同仓被重复提交。
  fs.writeFileSync(file, readRaw(file).slice(0, 40), 'utf8')
  const snap = store.load()
  check(snap.state === 'corrupt', `截断的 JSON 被判 corrupt（实际 ${snap.state}）`)
  check(snap.jobs.length === 0, 'corrupt 时不返回部分 jobs（部分现场比没有现场更危险）')
  check(!!snap.quarantinedAt && fs.existsSync(snap.quarantinedAt), '损坏文件被改名隔离（保留证据）')
  check(fs.existsSync(file) === false, '原路径已空出（下一次 save 是干净重写）')
  check(store.loadForIdempotency().safe === false, 'loadForIdempotency.safe=false（幂等判定 fail-closed）')
  check(store.load().state === 'corrupt', '隔离后原路径读不到文件，仍判 corrupt（标记不让它退化成 missing）')

  const fresh = makeWorkspace('atomic2')
  const s2 = createJobsStore({ file: fresh.file, instanceTag: 'svc-atomic2' })
  check(s2.load().state === 'missing', '文件不存在 → missing')
  check(s2.loadForIdempotency().safe === true, 'missing 允许幂等判定（全新机器上没有活动任务）')

  // 一次成功写入即恢复：坏现场被重写后不该永久 fail-closed（否则一次事故会让插件永远拒绝提交）。
  store.save([{ id: 'recovered', cwd: 'C:/r', stage: 'done', createdAt: new Date(1).toISOString(), updatedAt: new Date(1).toISOString() }])
  check(store.load().state === 'ok', '重写后 load 回到 ok')
  check(store.loadForIdempotency().safe === true, '重写后幂等判定恢复 safe')

  // 写入失败必须抛（旧实现 catch 后静默放弃持久化）。
  const bad = createJobsStore({ file: path.join(fresh.dir, 'no-such-dir', 'jobs.json'), instanceTag: 'svc-bad' })
  let writeErr = null
  try { bad.save([{ id: 'x' }]) } catch (e) { writeErr = e }
  check(writeErr instanceof JobsStoreError, '不可写路径的 save 抛错而不是吞掉')
  check(writeErr?.code === 'jobs-write', `错误码 jobs-write（实际 ${writeErr?.code}）`)

  // 非法 JSON 载荷（循环引用无法 JSON 化）也要显式失败。
  const cyc = { id: 'cyc' }
  cyc.self = cyc
  let cycErr = null
  try { store.save([cyc]) } catch (e) { cycErr = e }
  check(cycErr != null && !(cycErr instanceof JobsStoreError), `循环引用按原生 TypeError 抛出（实际 ${cycErr?.name}）`)
}

// ============================ 用例 3：跨进程 tick 锁 ============================
console.log('== 用例 3：tick 锁按归属释放，超时可接管 ==')
{
  const { file } = makeWorkspace('lock')
  const a = createJobsStore({ file, instanceTag: 'svc-a' })
  const b = createJobsStore({ file, instanceTag: 'svc-b' })
  const tA = a.acquireTickLock()
  check(typeof tA === 'string' && tA.includes('svc-a'), 'A 拿到锁（token 带 instanceTag 归属）')
  check(b.acquireTickLock() === null, 'B 在锁有效期内让路')
  check(a.releaseTickLock('someone-else') === false, '非归属 token 不删锁')
  check(fs.existsSync(a.lockFile), '锁仍在（别人的锁不能被删）')
  // 过期锁：崩溃进程不会自己清理，超时后必须能接管。把 mtime 拨老 61 秒模拟。
  check(b.acquireTickLock({ staleMs: 600000 }) === null, '锁未超时（staleMs 600s）时不抢')
  const past = new Date(Date.now() - 61000)
  fs.utimesSync(a.lockFile, past, past)
  const tB = b.acquireTickLock()
  check(typeof tB === 'string' && tB.includes('svc-b'), `超时后 B 接管锁（实际 ${tB}）`)
  check(a.releaseTickLock(tA) === false, 'A 释放自己已失效的 token 不会删掉 B 的锁')
  check(fs.existsSync(b.lockFile), 'B 的锁仍在')
  check(b.releaseTickLock(tB) === true, 'B 释放自己的锁')
  check(!fs.existsSync(b.lockFile), '锁文件已删除')
}

// ============================ 用例 4：同仓幂等（两实例共享磁盘）============================
console.log('== 用例 4：两个实例共享 jobs.json，同一仓库只允许一个活动任务 ==')
{
  const { file } = makeWorkspace('idem')
  const storeA = createJobsStore({ file, instanceTag: 'svc-A' })
  const storeB = createJobsStore({ file, instanceTag: 'svc-B' })
  const a = makeService({ store: storeA, instanceId: 'svc-A' })
  const b = makeService({ store: storeB, instanceId: 'svc-B' })

  const repo = 'C:/work/Repo'
  const first = a.submit({ cwd: repo, sessionId: 'sess-1', channel: 'native' })
  check(first.existed === false, 'A 首次提交创建任务')
  const second = b.submit({ cwd: 'c:/work/repo/', sessionId: 'sess-2', channel: 'native' })
  check(second.existed === true, 'B 的提交被吸收为同一条活动任务（盘符大小写 + 尾斜杠差异不产生第二条）')
  check(second.job.id === first.job.id, `B 返回 A 的那条任务（${second.job.id}）`)
  check(readJobs(file).length === 1, `磁盘上只有一条任务（实际 ${readJobs(file).length}）`)
  check(second.job.sessionId === 'sess-2', `会话归属已切到新会话（实际 ${second.job.sessionId}）`)
  check((second.job.sessionOwnerHistory ?? []).some((h) => h.from === 'sess-1' && h.to === 'sess-2'), '归属变更历史落盘（面板能解释唤醒去了谁）')
  check(JSON.parse(readRaw(file)).jobs[0].sessionId === 'sess-2', '磁盘版本也是新会话（不是只在内存里改）')
  check(b.findActive(repo)?.id === first.job.id, 'B 的 findActive 从磁盘吸收到 A 的任务')
  check(a.findActive('C:/work/other') === null, '别的仓库没有活动任务')

  // 半写现场时 B 拒绝提交：这才是「半写文件不得造成重复执行」的真正闸门。
  const intact = readRaw(file)
  fs.writeFileSync(file, intact.slice(0, 30), 'utf8')
  let err = null
  try { b.submit({ cwd: repo }) } catch (e) { err = e }
  check(err?.code === 'jobs-idempotency-unverified', `现场损坏时拒绝提交（实际 ${err?.code ?? '未抛错'}）`)
  check(!fs.existsSync(file), '损坏现场被隔离改名（原路径已空出，等待一次干净重写）')
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('jobs.json.corrupt-'))
  check(leftovers.length === 1, `保留了 1 份损坏现场作证据（实际 ${leftovers.length} 份）`)

  // 终态后可以再次提交：幂等只挡活动任务。
  const c = makeService({ store: createJobsStore({ file, instanceTag: 'svc-C' }), instanceId: 'svc-C' })
  const doneJob = { ...first.job, stage: 'done', finishedAt: new Date().toISOString() }
  createJobsStore({ file, instanceTag: 'svc-C' }).save([doneJob])
  const again = c.submit({ cwd: repo })
  check(again.existed === false && again.job.id !== first.job.id, '上一个任务终结后同一仓库可再次提交')
}

// ============================ 用例 5：原生中断 → 新宿主重跑至完成 ============================
console.log('== 用例 5：宿主在原生引擎跑到一半被杀 → 新实例按快照重跑至 done ==')
{
  const { file } = makeWorkspace('replay')
  const repo = 'C:/work/native-replay'
  let crashCalls = 0
  let replayCalls = 0

  // A：引擎启动后永不返回 —— 宿主被杀时进程里的 promise 就是这个形态。
  const a = makeService({
    store: createJobsStore({ file, instanceTag: 'svc-A' }),
    instanceId: 'svc-A',
    runNative: () => { crashCalls += 1; return new Promise(() => {}) },
  })
  const submitted = a.submit({ cwd: repo, sessionId: 'sess-native', channel: 'native' })
  await a.tick()
  check(crashCalls === 1, 'A 启动了原生执行器')
  const mid = readJobs(file).find((j) => j.id === submitted.job.id)
  check(mid?.nativeStarted === true, 'nativeStarted 已落盘（旧实现据此直接判 failed）')
  check(mid?.nativeSnapshot?.attempt === 1, `快照记录第 1 次尝试（实际 ${JSON.stringify(mid?.nativeSnapshot?.attempt)}）`)
  check(JSON.stringify(mid).includes('"python":"node"') && JSON.stringify(mid).includes('fake-engine.mjs'), '引擎入口/解释器在快照里（重启后可重建执行器）')
  check(!JSON.stringify(mid).includes('placeholderKey') && !JSON.stringify(mid).includes('CODEWIKI_API_KEY'), 'placeholder key / API key 不入 jobs.json')
  check(isTerminalStage(mid.stage) === false, '任务停在非终态（宿主机被杀，没有机会写终态）')

  // B：新宿主进程（A 的内存现场全部消失，只剩磁盘上的快照）。
  const b = makeService({
    store: createJobsStore({ file, instanceTag: 'svc-B' }),
    instanceId: 'svc-B',
    runNative: async (job) => { replayCalls += 1; check(job.nativeSnapshot?.attempt === 2, `重跑用的是第 2 次尝试快照（实际 ${job.nativeSnapshot?.attempt}）`); return NATIVE_DONE },
  })
  const later = Date.now() + 10 * 60 * 1000 // 越过 5 分钟孤儿阈值
  await b.tick({ now: later })
  await b.settle()
  check(replayCalls === 1, `B 按快照重跑了一次（实际 ${replayCalls}）`)
  const after = readJobs(file).find((j) => j.id === submitted.job.id)
  check(after?.stage === 'done', `重跑至 done（实际 ${after?.stage}，error=${after?.error ?? 'null'}）`)
  check(after?.writtenCount === 3, `结果被收割（writtenCount=${after?.writtenCount}）`)
  check(after?.owner === 'svc-B', '所有权已转给新实例')
  check((after?.notes ?? []).some((n) => n.includes('按快照重跑')), 'note 说明是「执行器丢失后按快照重跑」而不是失败')
  check(crashCalls === 1, 'A 的执行器没有被复用（跨进程不可能复用）')

  // 同一实例重复 tick 不得重启已在跑的执行器（否则就是重复执行）。
  const { file: file2 } = makeWorkspace('replay-dup')
  let dupCalls = 0
  const d = makeService({
    store: createJobsStore({ file: file2, instanceTag: 'svc-D' }),
    instanceId: 'svc-D',
    runNative: () => { dupCalls += 1; return new Promise(() => {}) },
  })
  const sub2 = d.submit({ cwd: 'C:/work/dup', channel: 'native' })
  await d.tick({ now: 1000 })
  await d.tick({ now: 2000 })
  await d.tick({ now: 3000 })
  check(dupCalls === 1, `同一实例多轮 tick 只启动一次执行器（实际 ${dupCalls}）`)
  check(readJobs(file2).find((j) => j.id === sub2.job.id)?.nativeSnapshot?.attempt === 1, '多次 tick 不虚增尝试次数')

  // 尝试次数到顶：崩溃循环不能无限重烧全量编译。
  const exhaustedJob = { ...mid, nativeStarted: true, stage: 'articles', owner: 'svc-gone', nativeSnapshot: { ...mid.nativeSnapshot, attempt: 3 } }
  const plan3 = planNativeReplay(exhaustedJob)
  check(plan3.replayable === false && plan3.exhausted === true, `连续中断到上限后不再重跑（${plan3.reason}）`)
  const resumable = planNativeReplay(mid, { exists: () => true })
  check(resumable.resumeDocsDir === mid.nativeSnapshot.docsDir && !('staleDocsDir' in resumable), '重放保留崩溃现场供叶子断点恢复，不再标成待删除目录')
  const missing = planNativeReplay(mid, { exists: () => false })
  check(missing.replayable === true && missing.resumeDocsDir === null, '现场已丢仍可重放，但不声称能续跑')

  // 没有引擎快照的旧 job 真的不可续：必须显式失败，而不是假装能跑。
  const noChannel = { ...mid, nativeChannel: null }
  const planNo = planNativeReplay(noChannel)
  check(planNo.replayable === false && planNo.exhausted === false, '缺少 nativeChannel 时判不可重放')
  check(String(planNo.reason).includes('请重新提交'), `原因可读（${planNo.reason}）`)
}

// ============================ 用例 6：取消不被复活 ============================
console.log('== 用例 6：取消是终态 —— 重启后的新实例不得复活它 ==')
{
  const { file } = makeWorkspace('cancel')
  const repo = 'C:/work/cancel-me'
  let calls = 0
  const a = makeService({
    store: createJobsStore({ file, instanceTag: 'svc-A' }),
    instanceId: 'svc-A',
    runNative: () => { calls += 1; return new Promise(() => {}) },
  })
  const { job } = a.submit({ cwd: repo, channel: 'native' })
  await a.tick()
  check(calls === 1, '执行器已启动（stall 中）')
  check(a.cancel(job.id) === true, '取消请求已落盘')
  check(readJobs(file).find((j) => j.id === job.id)?.cancelRequested === true, '磁盘版本带 cancelRequested')

  // 全新宿主：内存里没有执行器，磁盘上的 job 既「中断」又「已请求取消」。
  let bCalls = 0
  const b = makeService({
    store: createJobsStore({ file, instanceTag: 'svc-B' }),
    instanceId: 'svc-B',
    runNative: async () => { bCalls += 1; return NATIVE_DONE },
  })
  const plan = planNativeReplay(readJobs(file).find((j) => j.id === job.id))
  check(plan.replayable === false && plan.cancelled === true, `重放裁决看到取消即拒绝（${plan.reason}）`)
  await b.tick({ now: Date.now() + 10 * 60 * 1000 })
  await b.settle()
  const after = readJobs(file).find((j) => j.id === job.id)
  check(bCalls === 0, `新实例一次都没重跑（实际 ${bCalls}）`)
  check(after?.stage === 'cancelled', `终态仍是 cancelled（实际 ${after?.stage}）`)
  check(after?.finishedAt != null, '终态带 finishedAt')
  // 再 tick 若干轮，确认迟到的结果 / 后续实例不会把它改回 done
  await b.tick({ now: Date.now() + 20 * 60 * 1000 })
  await b.tick({ now: Date.now() + 30 * 60 * 1000 })
  const finalState = readJobs(file).find((j) => j.id === job.id)
  check(finalState?.stage === 'cancelled', `多轮 tick 后仍为 cancelled（实际 ${finalState?.stage}）`)
  check(finalState?.writtenCount == null, '取消没有产生写入计数（没有半成品被当成成果）')
}

// ============================ 用例 7：queued 不是孤儿 ============================
console.log('== 用例 7：queued/submitting 没有执行器可丢，不得被当孤儿接管 ==')
{
  const now = 10_000_000
  const base = { id: 'jq', owner: 'svc-dead', heartbeats: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
  const queued = { ...base, stage: 'queued' }
  const submitting = { ...base, stage: 'submitting' }
  const running = { ...base, stage: 'articles' }
  const opts = { instanceId: 'svc-live', now, orphanTakeoverMs: 60000 }

  check(classifyOwnership(queued, opts) === OWNERSHIP.IDLE_NO_EXECUTOR, `queued → idle-no-executor（实际 ${classifyOwnership(queued, opts)}）`)
  check(classifyOwnership(submitting, opts) === OWNERSHIP.IDLE_NO_EXECUTOR, 'submitting → idle-no-executor')
  check(classifyOwnership(running, opts) === OWNERSHIP.ORPHAN, `运行中且停更 → orphan（实际 ${classifyOwnership(running, opts)}）`)
  check(classifyOwnership({ ...running, owner: 'svc-live' }, opts) === OWNERSHIP.MINE, '自己的任务 → mine')
  check(classifyOwnership({ ...running, updatedAt: new Date(now - 1000).toISOString() }, opts) === OWNERSHIP.LIVE_OTHER, '对方刚更新过 → live-other（不接管）')
  check(classifyOwnership({ ...running, owner: undefined }, opts) === OWNERSHIP.LEGACY, '无 owner 的历史任务 → legacy（可接手续查）')

  // 心跳让「慢但活着」的实例不被误判：updatedAt 冻结 4 分钟后仍靠 heartbeatAt 判活。
  const slow = { ...running, updatedAt: new Date(now - 4 * 60000).toISOString(), heartbeatAt: new Date(now - 5000).toISOString() }
  check(lastSeenAt(slow) === Date.parse(slow.heartbeatAt), 'lastSeenAt 取心跳（比 updatedAt 新）')
  check(classifyOwnership(slow, opts) === OWNERSHIP.LIVE_OTHER, '有心跳的慢任务是 live-other，不被接管')

  // 心跳按 interval 节流，避免每 tick 都重写整份 jobs.json。
  const j = { ...running, owner: 'svc-live', heartbeatAt: new Date(now - 1000).toISOString() }
  check(heartbeat(j, { instanceId: 'svc-live', now }) === false, '距上次心跳不足间隔时不写')
  check(heartbeat(j, { instanceId: 'svc-live', now: now + 31000 }) === true, '超过间隔后写一次心跳')
  check(heartbeat(j, { instanceId: 'svc-other', now: now + 99000 }) === false, '不是自己的任务不写心跳')

  // 排队任务被接管时只换所有权，不产生「执行器丢失」这类事实。
  const adopted = adoptOrphan({ ...queued }, { instanceId: 'svc-live', now })
  check(adopted.owner === 'svc-live' && adopted.ownerAdoptedAt != null, '接管写入 ownerAdoptedAt')
  check(adopted.stage === 'queued', '接管不改阶段（queued 继续排队，不会被拉起来跑）')
}

// ============================ 用例 8：合并与终态 ============================
console.log('== 用例 8：磁盘现场合并、终态判定 ==')
{
  const older = { id: 'x', stage: 'articles', updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }
  const newer = { ...older, updatedAt: '2026-01-02T00:00:00.000Z', notes: ['from-disk'] }
  const m1 = mergeJobLists({ mine: [older], disk: [newer] })
  check(m1.changed === true && m1.jobs[0].notes?.[0] === 'from-disk', '磁盘更新且本实例没改过 → 取磁盘版本')
  const m2 = mergeJobLists({ mine: [older], disk: [newer], dirtyIds: new Set(['x']) })
  check(m2.changed === false, '本实例改过（dirtyIds）→ 不用磁盘版本覆盖')
  const m3 = mergeJobLists({ mine: [older], disk: [{ id: 'y', stage: 'queued', createdAt: '2026-01-03T00:00:00.000Z' }] })
  check(m3.changed === true && m3.jobs.length === 2, '对方新增的任务被吸收进内存')
  check(m3.jobs.map((j) => j.id).join(',') === 'x,y', '合并后按 createdAt 排序')

  for (const s of ['done', 'partial', 'failed', 'cancelled']) check(isTerminalStage(s) === true, `${s} 是终态`)
  for (const s of ['articles', 'review', 'index', 'commit', 'queued', 'submitting']) check(isTerminalStage(s) === false, `${s} 不是终态`)
  check(normKey('C:/A/b/') === normKey('c:/a/B'), 'normKey 折叠盘符大小写与尾斜杠（仅 win32）')
}

// ============================ 收尾 ============================
for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* Windows 占用留给系统清理 */ } }

console.log(`\n== 结果：${checks - failures}/${checks} 通过，${failures} 失败 ==`)
if (failures > 0) process.exit(1)
console.log('JobService 持久化与跨实例可靠性测试全部通过')
