// test-engine-native-incremental.mjs — 阶段 5：统一增量的**生产链**测试。
//
// 这个文件守的不是「某个纯函数算得对」，而是三件在真实仓库里才会暴露的事：
//
//   1. 第二轮真的走 FSoft 的 update（不是假装增量、实际全量）：
//      引擎必须收到 action=update + updateOptions.rung，且**真的读到了**上一轮
//      持久化进 `.codewiki/_native-state/` 的图/模块树/metadata/update_record
//      （证据来自假引擎进程自己 stat 的足迹，不是调用方的自述）。
//   2. 变化不能丢、也不能重复消费：四路（committed/staged/unstaged/untracked）+
//      delete/rename 都要被看见；未提交的部分由 state.json 的 unconsumed 携带，
//      直到它真的进了 commit 才移出。
//   3. 增量不可用时**显式**退全量而不是 clean：缺图 / base 不可达 / 版本不兼容
//      一律 full + 可见原因，基线只在「完整成功且引擎自报增量成立」时推进。
//
// 失败路径（index/baseline/commit/取消）也走真实链路：真 cw index/meta、真 git 提交，
// 通过注入 runCw/commit 让它们在**真实的调用点**失败，从而验证「图/模块树/文章与
// 基线一并回滚」「提交失败不回滚」这两条不变量在阶段 5 的写集里仍然成立。
//
// 运行：node test-engine-native-incremental.mjs（成功退出码 0）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// tick 压到下限（生产默认 10s）；独立 JOBS_FILE 与宿主实例隔离。
process.env.DSH_CODEWIKI_TICK_MS = '300'
const TEST_TOKEN = crypto.randomBytes(4).toString('hex')
process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `dsh-codewiki-jobs-inc-${process.pid}-${TEST_TOKEN}.json`)
const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_ENGINE = path.join(here, 'test-fixtures', 'fake-native-engine.mjs')

const { apply } = await import('./index.js')
const { runNativeJob } = await import('./lib/engine/native-run.js')
const nativeState = await import('./lib/engine/native-state.js')

let failures = 0
let checks = 0
function check(cond, msg) {
  checks += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}
const norm = (p) => String(p).replace(/\\/g, '/')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const exists = (p) => fs.existsSync(p)
const STATE_DIR = '.codewiki/_native-state'

const madeDirs = []
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  madeDirs.push(d)
  return d
}
// 原始树留档根（S6）：index.js 的 nativeRawTreeDir() 读这个环境变量，
// 不指走的话留档会落进系统临时目录，测试既找不到也清不掉。
const RAW_TREE_ROOT = mkTmp('cw-inc-raw-')
process.env.DSH_CODEWIKI_NATIVE_RAW_TREE_DIR = RAW_TREE_ROOT

// ── fixture：带 git、已 cw init 并提交过 wiki 的临时仓库 ──────────────────────
// 模式文件必须放**仓库外**：放进仓库会变成一次未提交源码改动，质量门的
// uncommitted-input 会把它判成产品缺陷——测试脚本自己污染被测对象。
function makeRepo(tag, { mode = 'done' } = {}) {
  const base = mkTmp('cw-inc-')
  const repo = path.join(base, tag)
  fs.mkdirSync(path.join(repo, 'core'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "core"\n')
  fs.mkdirSync(path.join(repo, 'util'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'util', 'util.py'), 'def fmt():\n    return "util"\n')
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  git('init')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@test')
  git('add', '.')
  git('commit', '-m', 'init')
  execFileSync('cw', ['init'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(path.join(repo, 'CodeWiki.md'), '# CodeWiki\n')
  git('add', '.codewiki')
  git('add', 'CodeWiki.md')
  git('commit', '-m', 'wiki init')
  setMode(base, tag, mode)
  return { base, repo, git, calls: () => readCalls(base, tag) }
}
function setMode(base, tag, mode) {
  fs.writeFileSync(path.join(base, `.native-mode-${tag}`), mode, 'utf8')
}
function readCalls(base, tag) {
  const file = path.join(base, `.native-calls-${tag}.log`)
  if (!exists(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

const fakeLlm = {
  async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  listModels: () => [],
  resolveModel: () => null,
}

// 原生编译的公共注入：假引擎用 node 当「解释器」、本仓库夹具当「入口」，
// client.js 走完全真实的 spawn/协议/进程树路径。
function baseDeps(extra = {}) {
  return {
    config: { batchProvider: 'workbuddy', batchModel: 'hy3' },
    llm: fakeLlm,
    engineFor: () => ({ command: process.execPath, args: [FAKE_ENGINE], env: {} }),
    ...extra,
  }
}
const freshDocs = (tag) => mkTmp(`cw-inc-docs-${tag}-`)

function nativeCfg(extra = {}) {
  return {
    batchProvider: 'workbuddy',
    batchModel: 'hy3',
    nativeEngine: true,
    nativeEnginePython: process.execPath,
    nativeEngineEntry: FAKE_ENGINE,
    ...extra,
  }
}

// 宿主 ctx mock（与 test-engine-native-job.mjs 同构）
function makeCtx({ llm = fakeLlm } = {}) {
  const registered = new Map()
  const endpoints = []
  const disposers = []
  const services = { webServer: { register(def) { endpoints.push(def) } }, agents: { list: () => [] }, tools: { register(def) { registered.set(def.name, def); return () => {} } }, llm }
  const ctx = {
    inject(deps, fn) {
      if (typeof fn === 'function') {
        const slice = {}
        for (const d of deps) slice[d] = services[d]
        return fn(slice)
      }
      const got = deps.map((d) => services[d])
      return Promise.resolve(got.length === 1 ? got[0] : got)
    },
    on() {},
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  }
  return { ctx, registered, endpoints, disposers }
}

async function waitJob(cwd, { timeout = 120000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    let job = null
    try {
      const data = readJson(JOBS_FILE)
      job = (data.jobs ?? []).filter((x) => norm(x.cwd) === norm(cwd)).pop() ?? null
    } catch { /* 尚未落盘 */ }
    if (job && ['done', 'partial', 'failed', 'cancelled'].includes(job.stage)) return job
    if (Date.now() - t0 > timeout) {
      // 超时不是「返回 null 让断言自己猜」：把现场带出去，否则失败信息只剩 undefined。
      let seen = []
      let last = null
      try {
        const data = readJson(JOBS_FILE)
        seen = (data.jobs ?? []).map((x) => `${x.id}:${x.stage}:${norm(x.cwd)}`)
        last = (data.jobs ?? []).filter((x) => norm(x.cwd) === norm(cwd)).pop() ?? null
      } catch { /* ignore */ }
      if (last) console.error(`  [timeout] last=${last.id} stage=${last.stage} channel=${last.channel} nativeStage=${last.nativeStage} err=${String(last.error ?? '')} notes=${JSON.stringify((last.notes ?? []).slice(-6))}`)
      return { __timedOut: true, stage: '__timeout__', seen, cwd }
    }
    await new Promise((r) => setTimeout(r, 120))
  }
}

// 用例过滤：默认全跑；ONLY_CASES=2,5 只跑指定编号，便于定位单条失败（不影响生产语义）。
const ONLY = String(process.env.ONLY_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const want = (n) => ONLY.length === 0 || ONLY.includes(String(n))
const skip = (n, title) => { if (!want(n)) console.log(`== 用例 ${n}：${title}（ONLY_CASES 未选中，跳过）==`) }

async function runJob(repo, { cfg = nativeCfg(), scope = 'stale' } = {}) {
  const m = makeCtx()
  apply(m.ctx, cfg)
  try {
    const gen = m.registered.get('codewiki_generate')
    const submitted = await gen.execute({ cwd: repo, scope }, { agent: { id: 'sess-inc' } })
    const job = await waitJob(repo)
    return { job, submitted, m }
  } finally {
    for (const d of m.disposers) { try { d() } catch { /* 清理失败不影响断言 */ } }
  }
}

const gitOut = (repo, ...args) => String(execFileSync('git', args, { cwd: repo, encoding: 'utf8' })).trim()
const gitShowFiles = (repo, sha) => String(execFileSync('git', ['show', '--name-only', '--pretty=format:', sha], { cwd: repo, encoding: 'utf8' }))
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

// ============================ 用例 1：生产链两轮 ============================
// 第一轮 full 建库并持久化状态；第二轮 stale 必须真的走 update，且引擎读到状态。
if (want(1)) { console.log('== 用例 1：生产链两轮（full → stale update），状态在仓库内持久化并被引擎读到 ==')
  const { base, repo, git, calls } = makeRepo('tworound', { mode: 'done' })

  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `第一轮 done（实际 ${first.job?.stage}；blockers=${JSON.stringify(first.job?.blockers ?? [])}）`)
  check(first.job?.channel === 'native', `第一轮走原生通道（实际 ${first.job?.channel}）`)
  check(exists(path.join(repo, STATE_DIR, 'state.json')), '受管状态 state.json 落进仓库（.codewiki/_native-state/state.json）')
  check(exists(path.join(repo, STATE_DIR, 'docs', 'module_tree.json')), '原始模块树被持久化（_native-state/docs/module_tree.json）')
  check(exists(path.join(repo, STATE_DIR, 'docs', 'metadata.json')), '原始 metadata 被持久化')
  check(exists(path.join(repo, STATE_DIR, 'docs', 'update_record.json')), 'update_record 被持久化')
  const graphDir = path.join(repo, STATE_DIR, 'docs', 'temp', 'dependency_graphs')
  check(exists(graphDir) && fs.readdirSync(graphDir).some((f) => f.endsWith('_dependency_graph.json')), '依赖图被持久化（temp/dependency_graphs/*_dependency_graph.json）')
  check(fs.readdirSync(path.join(repo, STATE_DIR, 'docs')).some((f) => f.endsWith('.md')), '上一轮文章副本被持久化（增量要原地 patch）')

  // 状态必须与文章进同一个提交（同事务），且提交只含 wiki 路径
  const sha1 = String(first.job?.nativeResult?.apply?.commit?.sha ?? '')
  const files1 = gitShowFiles(repo, sha1)
  check(files1.some((f) => f.startsWith(`${STATE_DIR}/`)), `状态与文章同批提交（提交里含 ${STATE_DIR}/）`)
  check(files1.every((f) => f === 'CodeWiki.md' || f.startsWith('.codewiki/')), `提交只含 wiki 路径（${files1.length} 个）`)
  check(files1.every((f) => !f.startsWith('core/') && !f.startsWith('util/')), '提交不含用户源码（core/、util/ 都不在）')
  check(first.job?.nativeResult?.apply?.baseline?.advanced === true, '第一轮基线已推进')
  check((first.job?.nativeResult?.incremental?.resolution ?? '') === 'full', `第一轮决议 full（实际 ${first.job?.nativeResult?.incremental?.resolution}）`)

  // 索引不该把受管状态的文章副本当成本库文章：`_` 开头目录被 cw index 跳过。
  const indexText = fs.readFileSync(path.join(repo, '.codewiki', '_index.md'), 'utf8')
  check(!indexText.includes('_native-state'), 'cw index 未把 _native-state 下的文章副本收进索引')

  // 原始树留档（S6）：引擎产出的那棵树在被映射/改写/裁剪之前必须留一份。
  // 这条断言守的是「事实来源」这条设计约束——没有它，「这一轮的差异是引擎给的
  // 还是我们落地时加工出来的」永远回答不了。
  const rawDir = String(first.job?.nativeResult?.artifacts?.rawTree ?? '')
  const rawFiles = Number(first.job?.nativeResult?.artifacts?.rawTreeFiles ?? 0)
  check(rawDir !== '', `原始树已留档并随结果出去（rawTree=${rawDir || '（空）'}）`)
  check(rawDir !== '' && norm(rawDir).startsWith(norm(RAW_TREE_ROOT)), '留档落在仓库外（不污染 git、不被 cw index 收成第二套文章）')
  check(rawDir !== '' && !norm(rawDir).startsWith(norm(repo)), '留档目录不在被测仓库内')
  check(rawFiles > 0, `留档文件数 > 0（实际 ${rawFiles}）`)
  check(rawDir !== '' && exists(path.join(rawDir, 'module_tree.json')), '留档里有 module_tree.json（引擎原始产物）')
  check(rawDir !== '' && exists(path.join(rawDir, 'metadata.json')), '留档里有 metadata.json')
  check(rawDir !== '' && fs.readdirSync(rawDir).some((f) => f.endsWith('.md')),
    '留档里有引擎写的模块页正文（不是只有一份清单）')
  // 留档是「消费之前」的快照：它必须与落地后的 .codewiki/modules 分开两份，不是同一个目录。
  check(norm(rawDir) !== norm(path.join(repo, '.codewiki', 'modules')), '留档与落地产物是两个目录')

  // 第二轮：提交一次源码改动，然后 stale
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "core-v2"\n')
  git('add', '.')
  git('commit', '-m', 'change core')
  const headBefore2 = gitOut(repo, 'rev-parse', 'HEAD')

  const second = await runJob(repo, { scope: 'stale' })
  const inc2 = second.job?.nativeResult?.incremental ?? {}
  check(second.job?.stage === 'done', `第二轮 done（实际 ${second.job?.stage}；blockers=${JSON.stringify(second.job?.blockers ?? [])}）`)
  check(inc2.resolution === 'update', `第二轮决议 update（实际 ${inc2.resolution}；fallback=${inc2.fallbackReason}）`)
  check(inc2.baseCommit && inc2.baseCommit !== headBefore2, `增量基线是上一轮基线而不是 HEAD（base=${String(inc2.baseCommit).slice(0, 7)}，HEAD=${headBefore2.slice(0, 7)}）`)
  check(inc2.changeCount >= 1, `变化集非空（${inc2.changeCount} 项）`)

  // 引擎侧硬证据：动作是 update、带了 rung、真的读到了四份状态
  const upd = calls().filter((c) => c.action === 'update')
  check(upd.length === 1, `假引擎收到 update 恰好一次（实际 ${upd.length}；足迹 ${JSON.stringify(calls().map((c) => c.action))}）`)
  check(String(upd[0]?.updateOptions?.rung ?? '') === '3', `updateOptions.rung=3 被传到引擎（实际 ${JSON.stringify(upd[0]?.updateOptions)}）`)
  check(upd[0]?.readState?.module_tree === true, '引擎真的读到了 module_tree.json')
  check(upd[0]?.readState?.metadata === true, '引擎真的读到了 metadata.json')
  check(upd[0]?.readState?.dependency_graph === true, '引擎真的读到了依赖图')
  check(upd[0]?.readState?.update_record === true, '引擎真的读到了 update_record.json')
  check(Number(upd[0]?.readState?.docs_markdown ?? 0) > 0, `引擎读到了上一轮文章（${upd[0]?.readState?.docs_markdown} 篇）`)
  check(inc2.updateOutcome === 'incremental', `引擎自报增量成立（updateOutcome=${inc2.updateOutcome}）`)
  check(second.job?.nativeResult?.apply?.baseline?.advanced === true, '第二轮基线推进（增量完整成立）')
  check(gitOut(repo, 'rev-parse', 'HEAD') !== headBefore2, '第二轮产生了新提交（产物真的入库）')
  check(Number(inc2.statePersisted ?? 0) > 0, `第二轮重新持久化状态（${inc2.statePersisted} 个文件）`)
}
// ============================ 用例 2：无变化不重写不提交 ============================
if (want(2)) { console.log('== 用例 2：连续两轮之间没有变化 → 引擎 no_change，不产生多余提交 ==')
  const { base, repo, git } = makeRepo('nochange', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  const headAfter1 = gitOut(repo, 'rev-parse', 'HEAD')

  setMode(base, 'nochange', 'update-nochange')
  const r2 = await runJob(repo, { scope: 'stale' })
  check(r2.job?.stage === 'done', `无变化轮 done（实际 ${r2.job?.stage}；blockers=${JSON.stringify(r2.job?.blockers ?? [])}）`)
  check((r2.job?.nativeResult?.incremental?.resolution ?? '') === 'update', `仍然走 update（决议 ${r2.job?.nativeResult?.incremental?.resolution}）`)
  check(r2.job?.nativeResult?.incremental?.updateOutcome === 'no_change', `引擎自报 no_change（实际 ${r2.job?.nativeResult?.incremental?.updateOutcome}）`)
  check(gitOut(repo, 'rev-parse', 'HEAD') === headAfter1,
    `无变化轮没有产生新提交（HEAD ${headAfter1.slice(0, 7)} → ${gitOut(repo, 'rev-parse', 'HEAD').slice(0, 7)}；files=${JSON.stringify(gitShowFiles(repo, gitOut(repo, 'rev-parse', 'HEAD')))}；commit=${JSON.stringify(r2.job?.nativeResult?.apply?.commit)}）`)
  check(r2.job?.nativeResult?.apply?.commit?.noChanges === true || r2.job?.nativeResult?.apply?.commit?.committed === false,
    `提交层如实报「无改动可提交」（实际 ${JSON.stringify(r2.job?.nativeResult?.apply?.commit && { committed: r2.job.nativeResult.apply.commit.committed, noChanges: r2.job.nativeResult.apply.commit.noChanges })}）`)
}
// ============================ 用例 3：四路 + delete/rename ============================
if (want(3)) { console.log('== 用例 3：四路变化与 delete/rename 都被 change-set 看见 ==')
  const { base, repo, git } = makeRepo('fourway', { mode: 'done' })
  await runJob(repo, { scope: 'full' })

  // committed：删除一个文件 + 改名另一个（都进 commit）
  fs.rmSync(path.join(repo, 'util', 'util.py'))
  fs.writeFileSync(path.join(repo, 'core', 'renamed.py'), 'def run():\n    return "core"\n')
  fs.rmSync(path.join(repo, 'core', 'core.py'))
  git('add', '-A')
  git('commit', '-m', 'delete util, rename core')
  // staged：新增并 add，不提交
  fs.writeFileSync(path.join(repo, 'staged.py'), 'x = 1\n')
  git('add', 'staged.py')
  // unstaged：改一个已跟踪文件不 add
  fs.writeFileSync(path.join(repo, 'core', 'renamed.py'), 'def run():\n    return "core-v3"\n')
  // untracked：新建不 add
  fs.writeFileSync(path.join(repo, 'brand-new.py'), 'y = 2\n')

  const r = await runJob(repo, { scope: 'stale' })
  const inc = r.job?.nativeResult?.incremental ?? {}
  const changes = Array.isArray(inc.changes) ? inc.changes : []
  check(inc.resolution === 'update', `决议 update（实际 ${inc.resolution}；fallback=${inc.fallbackReason}）`)
  check(changes.some((p) => p === 'brand-new.py'), `untracked 被看见（changes 含 brand-new.py：${changes.slice(0, 8).join('、')}）`)
  check(changes.some((p) => p === 'staged.py'), 'staged 被看见')
  check(changes.some((p) => p === 'core/renamed.py'), 'rename 的新路径被看见')
  check(changes.some((p) => p === 'core/core.py') || changes.some((p) => p === 'util/util.py'), '删除/改名的旧路径被看见')
  // 未提交的三路必须被携带成「未消费凭据」，而不是被基线前移洗掉
  const st = readJson(path.join(repo, STATE_DIR, 'state.json'))
  const unconsumed = Array.isArray(st.unconsumed) ? st.unconsumed : []
  check(unconsumed.includes('brand-new.py') && unconsumed.includes('staged.py'), `未提交变化进 unconsumed（${unconsumed.slice(0, 6).join('、')}）`)
  // 未提交源码改动**已经随快照进了这批文章**（产物 commit_id === 快照 sha），
  // 所以它不是「变化被悄悄丢掉」，而是「变化被权威地吞下」：轮次可以 done、
  // 基线可以推进。真正的防丢机制是上面那条 unconsumed 携带 —— 改动没进 commit
  // 之前一直留在账本里，下一轮继续消费。
  check(r.job?.stage === 'done', `未提交改动被快照覆盖时可以 done（实际 ${r.job?.stage}；blockers=${JSON.stringify(r.job?.blockers ?? [])}）`)
  check(r.job?.nativeResult?.apply?.baseline?.advanced === true, '基线推进（产物对得上快照，变化已被吞下）')
  const blockersText = JSON.stringify(r.job?.blockers ?? [])
  check(!/uncommitted-input/.test(blockersText), `不再把「已吞下」误报成未提交输入（${blockersText.slice(0, 160)}）`)
  // 吞下了什么必须可见：这是「基线推进条件放宽」的代价，必须在任务记录里说清楚。
  const noteText = [...(r.job?.notes ?? []), ...(r.job?.nativeResult?.notes ?? [])].join(' | ')
  check(/本轮把 \d+ 个未提交源码改动一并写进产物/.test(noteText), `notes 明示吞下了哪些未提交改动（${noteText.slice(0, 300)}）`)
  // ── S4：未提交的三路不止「记账」，而是被合成成一棵真实的树交给引擎 ──
  //
  // 规格 L82 的症结是 FSoft 只从 `<old>..<new>` 取 diff：Node 侧若只把工作区路径
  // 记进 unconsumed、却仍让引擎按 HEAD 记账，产物反映的内容就永远不在账本里。
  // 这四条断言钉住的正是「内容与账本对齐」这件事本身，而不是中间的实现手段。
  const snap = inc.workspaceSnapshot
  check(snap && /^[0-9a-f]{40}$/.test(String(snap.sha)), `工作区改动合成 40 位快照（实际 ${JSON.stringify(snap)}）`)
  // parent 必须是本轮产物提交之前的那次 HEAD：apply 阶段会提交 wiki 产物，
  // 所以「等于现在的 HEAD」是错断言，只能问「是不是当前历史的祖先」。
  const isAncestorOfHead = (sha) => {
    try { gitOut(repo, 'merge-base', '--is-ancestor', sha, 'HEAD'); return true } catch { return false }
  }
  check(Boolean(snap?.parent) && isAncestorOfHead(snap.parent),
    `快照挂在 HEAD 之上（parent=${String(snap?.parent).slice(0, 12)} 是当前历史祖先）`)
  check(snap?.sha !== gitOut(repo, 'rev-parse', 'HEAD'),
    `快照本身不被提交、不进 HEAD（HEAD=${gitOut(repo, 'rev-parse', 'HEAD').slice(0, 12)}，快照 ${String(snap?.sha).slice(0, 12)}）`)
  const engineCall = readCalls(base, 'fourway').filter((c) => c.action === 'update').pop()
  check(engineCall?.commitId === snap?.sha,
    `引擎收到的 commitId 就是快照（实际 ${String(engineCall?.commitId).slice(0, 12)}，快照 ${String(snap?.sha).slice(0, 12)}）`)
  check(!/commit-mismatch/.test(blockersText),
    `产物对得上快照后不再报 commit-mismatch（${blockersText.slice(0, 200)}）`)
  check(Array.isArray(snap?.skipped) && snap.skipped.length === 0, `快照没有跳过的文件（${JSON.stringify(snap?.skipped ?? [])}）`)
}
// ============================ 用例 4：未提交变化两轮不丢 ============================
if (want(4)) { console.log('== 用例 4：未提交改动连续两轮不丢（第三轮提交后消费成立才移出） ==')
  const { base, repo, git } = makeRepo('carry', { mode: 'done' })
  await runJob(repo, { scope: 'full' })

  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "dirty"\n')
  const r2 = await runJob(repo, { scope: 'stale' })
  const st2 = readJson(path.join(repo, STATE_DIR, 'state.json'))
  check((st2.unconsumed ?? []).includes('core/core.py'), `第二轮把未提交改动记进 unconsumed（${JSON.stringify(st2.unconsumed)}）`)
  const upd2 = readCalls(base, 'carry').filter((c) => c.action === 'update')
  check(upd2.length >= 1, '第二轮真的调了 update（未提交改动被引擎读取）')

  // 第二轮再来一次（仍不提交）：携带必须继续，不能因为「上轮编译过」就丢
  const r3 = await runJob(repo, { scope: 'stale' })
  const st3 = readJson(path.join(repo, STATE_DIR, 'state.json'))
  check((st3.unconsumed ?? []).includes('core/core.py'), `第三轮继续携带未消费改动（${JSON.stringify(st3.unconsumed)}）`)
  check((r3.job?.nativeResult?.incremental?.carried ?? 0) >= 1, `携带计数可见（carried=${r3.job?.nativeResult?.incremental?.carried}）`)

  // 提交后再跑：出现在 committed 里 → 消费成立 → 移出 unconsumed
  git('add', '.')
  git('commit', '-m', 'commit dirty')
  const r4 = await runJob(repo, { scope: 'stale' })
  const st4 = readJson(path.join(repo, STATE_DIR, 'state.json'))
  check(!(st4.unconsumed ?? []).includes('core/core.py'), `提交后消费成立并移出 unconsumed（${JSON.stringify(st4.unconsumed)}）`)
  check(r4.job?.nativeResult?.incremental?.consumedNow?.includes?.('core/core.py') === true
    || (r4.job?.nativeResult?.incremental?.consumedNow ?? []).includes('core/core.py'),
  `consumedNow 记下这次消费（${JSON.stringify(r4.job?.nativeResult?.incremental?.consumedNow)}）`)
}
// ============================ 用例 5：缺图 → 显式全量 ============================
if (want(5)) { console.log('== 用例 5：持久化状态缺依赖图 → 显式 full，不 clean，基线只在完整成功后推进 ==')
  const { base, repo } = makeRepo('nograh', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  const graphDir = path.join(repo, STATE_DIR, 'docs', 'temp', 'dependency_graphs')
  for (const f of fs.readdirSync(graphDir)) fs.rmSync(path.join(graphDir, f))

  const r = await runJob(repo, { scope: 'stale' })
  const inc = r.job?.nativeResult?.incremental ?? {}
  check(inc.resolution === 'full', `缺图时决议 full（实际 ${inc.resolution}）`)
  check(/依赖图|dependency_graph/.test(String(inc.fallbackReason ?? '')), `降级原因点名缺图（${String(inc.fallbackReason).slice(0, 120)}）`)
  check(r.job?.stage === 'done', `全量重建仍可 done（实际 ${r.job?.stage}；blockers=${JSON.stringify(r.job?.blockers ?? [])}）`)
  check((r.job?.blockers ?? []).every((b) => b.kind !== 'incremental-fallback'), '产物完整时降级只进 notes，不硬判 partial')
  check((r.job?.nativeResult?.apply?.baseline?.advanced ?? false) === true, '全量完整成功仍推进基线（覆盖了当前全部源码）')
  check(readCalls(base, 'nograh').filter((c) => c.action === 'update').length === 0, '缺图时引擎没有收到 update 动作')
}
// ============================ 用例 6：base 不可达 / 版本不兼容 → 显式全量 ============================
if (want(6)) { console.log('== 用例 6：变化集不可信 / 引擎版本不兼容 → 显式 full ==')
  const { repo } = makeRepo('badbase', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  const r = await runNativeJob({
    repoRoot: repo, scope: 'stale', docsDir: freshDocs('badbase'),
    deps: baseDeps({
      collectChangeSet: () => ({ ok: false, state: 'unreachable-base', fallback: 'full', reason: '基线 commit 已不在历史里（模拟）', sourceChanges: [], committed: [], staged: [], unstaged: [], untracked: [], deleted: [], renamed: [], headCommit: gitOut(repo, 'rev-parse', 'HEAD') }),
    }),
  })
  check(r.incremental?.resolution === 'full', `变化集不可信时决议 full（实际 ${r.incremental?.resolution}）`)
  check(/unreachable-base|基线/.test(String(r.incremental?.fallbackReason ?? '')), `原因可见（${String(r.incremental?.fallbackReason).slice(0, 120)}）`)
  check(r.outcome !== 'failed' || r.error != null, '降级本身不是失败（全量照跑）')
}
if (want(6)) {
  const { repo } = makeRepo('badver', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  // 把记录的引擎版本改成另一个版本：旧图/旧树不可比，必须退全量
  const stPath = path.join(repo, STATE_DIR, 'state.json')
  const st = readJson(stPath)
  st.engineVersion = '0.0.1-not-compatible'
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2), 'utf8')
  execFileSync('git', ['add', STATE_DIR], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'forge version'], { cwd: repo, stdio: 'pipe' })

  const r = await runNativeJob({ repoRoot: repo, scope: 'stale', docsDir: freshDocs('badver'), deps: baseDeps() })
  check(r.incremental?.resolution === 'full', `版本不兼容时决议 full（实际 ${r.incremental?.resolution}）`)
  check(/版本/.test(String(r.incremental?.fallbackReason ?? '')), `原因点名版本（${String(r.incremental?.fallbackReason).slice(0, 140)}）`)
}
// ============================ 用例 7：index / baseline / commit 失败 ============================
if (want(7)) { console.log('== 用例 7：index 失败回滚状态、baseline 失败回滚状态、commit 失败不回滚 ==')
  // index 失败：runCw 在 index 上返回非零。文章与受管状态必须一起回到 pre-image。
  const { repo } = makeRepo('idxfail', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  const stateBefore = fs.readFileSync(path.join(repo, STATE_DIR, 'state.json'), 'utf8')
  const treeBefore = fs.readFileSync(path.join(repo, STATE_DIR, 'docs', 'module_tree.json'), 'utf8')
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "v2"\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'v2'], { cwd: repo, stdio: 'pipe' })
  // HEAD 必须在「用户提交 v2 之后」取样：之前取会把 v2 这次提交本身算成编译产生的提交。
  const headBefore = gitOut(repo, 'rev-parse', 'HEAD')

  const rIdx = await runNativeJob({
    repoRoot: repo, scope: 'stale', docsDir: freshDocs('idxfail'),
    deps: baseDeps({
      applyDeps: {
        runCw: async (bin, cwd, args, t) => {
          if (args[0] === 'index') return { exitCode: 1, stdout: '', stderr: '模拟：cw index 失败' }
          return execFileSync(bin, args, { cwd, stdio: 'pipe' }) && { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    }),
  })
  check(rIdx.outcome === 'failed', `index 失败 → 终态 failed（实际 ${rIdx.outcome}）`)
  check(rIdx.apply?.rolledBack === true, 'index 失败已回滚')
  check(fs.readFileSync(path.join(repo, STATE_DIR, 'state.json'), 'utf8') === stateBefore, '受管 state.json 随文章一起回到 pre-image')
  check(fs.readFileSync(path.join(repo, STATE_DIR, 'docs', 'module_tree.json'), 'utf8') === treeBefore, '持久化模块树随文章一起回滚')
  check(gitOut(repo, 'rev-parse', 'HEAD') === headBefore,
    `index 失败没有产生提交（${headBefore.slice(0, 7)} → ${gitOut(repo, 'rev-parse', 'HEAD').slice(0, 7)}；commit=${JSON.stringify(rIdx.apply?.commit)}）`)
}
if (want(7)) {
  // baseline 失败：cw meta update 返回非零 → 文章与状态一并回滚（基线绝不推进到未成立的编译上）
  const { repo } = makeRepo('basefail', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  const stateBefore = fs.readFileSync(path.join(repo, STATE_DIR, 'state.json'), 'utf8')
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "v3"\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'v3'], { cwd: repo, stdio: 'pipe' })

  const rBase = await runNativeJob({
    repoRoot: repo, scope: 'stale', docsDir: freshDocs('basefail'),
    deps: baseDeps({
      applyDeps: {
        runCw: async (bin, cwd, args, t) => {
          if (args[0] === 'meta') return { exitCode: 1, stdout: '', stderr: '模拟：cw meta update 失败' }
          const r = execFileSync(bin, args, { cwd, stdio: 'pipe' })
          return { exitCode: 0, stdout: String(r ?? ''), stderr: '' }
        },
      },
    }),
  })
  check(rBase.outcome === 'failed', `baseline 失败 → 终态 failed（实际 ${rBase.outcome}）`)
  check(rBase.apply?.rolledBack === true, 'baseline 失败已回滚')
  check(fs.readFileSync(path.join(repo, STATE_DIR, 'state.json'), 'utf8') === stateBefore, '受管 state.json 随文章一起回滚（基线失败）')
  check(rBase.blockers.some((b) => b.kind === 'baseline-failed'), `阻塞原因 baseline-failed（${JSON.stringify(rBase.blockers.map((b) => b.kind))}）`)
}
if (want(7)) {
  // commit 失败：文章/索引/基线都已生效，产物**不回滚**，终态 partial
  const { repo } = makeRepo('commitfail', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "v4"\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'v4'], { cwd: repo, stdio: 'pipe' })

  const rCommit = await runNativeJob({
    repoRoot: repo, scope: 'stale', docsDir: freshDocs('commitfail'),
    deps: baseDeps({ applyDeps: { commit: async () => ({ committed: false, reason: '模拟：提交通道未成立' }) } }),
  })
  check(rCommit.outcome === 'partial', `commit 失败 → 终态 partial（实际 ${rCommit.outcome}）`)
  check(rCommit.apply?.applied === true && rCommit.apply?.rolledBack !== true, '提交失败不回滚（产物已生效）')
  check(rCommit.blockers.some((b) => b.kind === 'commit-failed'), `阻塞原因 commit-failed（${JSON.stringify(rCommit.blockers.map((b) => b.kind))}）`)
  check(exists(path.join(repo, STATE_DIR, 'state.json')), '受管状态仍在（提交失败不回滚）')
}
// ============================ 用例 8：取消 ============================
if (want(8)) { console.log('== 用例 8：增量轮取消 → cancelled，基线不推进 ==')
  const { repo } = makeRepo('cancelinc', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "v5"\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'v5'], { cwd: repo, stdio: 'pipe' })
  const headBefore = gitOut(repo, 'rev-parse', 'HEAD')
  const metaBefore = fs.readFileSync(path.join(repo, '.codewiki', '_meta.yaml'), 'utf8')

  const ac = new AbortController()
  ac.abort()
  const r = await runNativeJob({ repoRoot: repo, scope: 'stale', docsDir: freshDocs('cancelinc'), signal: ac.signal, deps: baseDeps() })
  check(r.outcome === 'cancelled', `取消 → 终态 cancelled（实际 ${r.outcome}）`)
  check(r.canAdvanceBaseline === false, '取消后 canAdvanceBaseline=false')
  check(gitOut(repo, 'rev-parse', 'HEAD') === headBefore, '取消没有产生提交')
  check(fs.readFileSync(path.join(repo, '.codewiki', '_meta.yaml'), 'utf8') === metaBefore, '取消没有推进基线')
}
// ============================ 用例 9：旧通道不受影响 ============================
if (want(9)) { console.log('== 用例 9：nativeEngine=false 时旧通道照常，原生引擎一次都不跑 ==')
  const { repo, calls } = makeRepo('legacy', { mode: 'done' })
  const m = makeCtx()
  apply(m.ctx, { batchProvider: 'workbuddy', batchModel: 'hy3', nativeEngine: false })
  try {
    const gen = m.registered.get('codewiki_generate')
    const submitted = await gen.execute({ cwd: repo, scope: 'full' }, { agent: { id: 'sess-legacy' } })
    const job = await waitJob(repo)
    check(submitted.submitted === true, '旧通道提交即返回')
    check((job?.channel ?? 'legacy') === 'legacy', `channel=legacy（实际 ${job?.channel}）`)
    check(job?.nativeResult == null, '没有 nativeResult（没走原生裁决）')
    check(calls().length === 0, `原生引擎一次都没被调用（足迹 ${JSON.stringify(calls().map((c) => c.action))}）`)
    check(!exists(path.join(repo, STATE_DIR, 'state.json')), '旧通道不产生受管状态目录')
  } finally {
    for (const d of m.disposers) { try { d() } catch { /* ignore */ } }
  }
}
// ============================ 用例 10：本轮没有产出增量凭据 ============================
if (want(10)) { console.log('== 用例 10：本轮缺依赖图（受管状态不完整）→ 不裁旧状态、不推进基线、不 done ==')
  const { base, repo } = makeRepo('dropgraph', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `首轮 done（实际 ${first.job?.stage}）`)
  const graphDir = path.join(repo, STATE_DIR, 'docs', 'temp', 'dependency_graphs')
  const graphsBefore = fs.readdirSync(graphDir).filter((f) => f.endsWith('.json'))
  check(graphsBefore.length > 0, '首轮持久化了依赖图（下一轮增量就靠它）')

  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "v6"\n')
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'v6'], { cwd: repo, stdio: 'pipe' })
  setMode(base, 'dropgraph', 'drop-graph')

  const r = await runNativeJob({ repoRoot: repo, scope: 'stale', docsDir: freshDocs('dropgraph'), deps: baseDeps() })
  // 缺图 = 这一轮的产状态不完整。它不影响文章本身（门照过、文章照写），
  // 但**下一轮唯一的增量凭据**没了：此时裁掉旧状态就是把凭据删掉，
  // 推进基线就是把「没消化完的变化」记成已消化。两件都不能做。
  check(r.outcome === 'partial', `缺图轮不得完整 done（实际 ${r.outcome}）`)
  check(r.blockers.some((b) => b.kind === 'quality-gate' && String(b.detail).includes('[native-state]')),
    `状态不完整必须成为机读 blocker（${JSON.stringify(r.blockers.map((b) => b.kind))}）`)
  check(r.apply?.baseline?.advanced === false, '状态不完整时基线不推进')
  check(r.apply?.applied === true, '文章照写（不完整的是状态，不是产物）')
  check((r.incremental?.stateMissing ?? []).length > 0, `现场证据里能看出缺了什么（${JSON.stringify(r.incremental?.stateMissing)}）`)
  const graphsAfter = exists(graphDir) ? fs.readdirSync(graphDir).filter((f) => f.endsWith('.json')) : []
  check(graphsAfter.length === graphsBefore.length, `旧依赖图没被裁掉（${graphsBefore.length} → ${graphsAfter.length}）`)
}

// ============================ 用例 12：no_change + 历史缺页必须自动补写 ============================
// 真实事故：早期某轮全量没写全模块页，之后源码长期无变化 → 增量轮 diff 为空，
// 上游直接 `OUTCOME_NO_CHANGE` 返回（不执行 Step 5/6.1），而质量门每轮仍按整棵
// module_tree 判 article-missing，形成永久 partial。修法不是豁免缺页，而是在
// 水合后发现产物不完整时转全量修复（复用已有页面，只补缺的那几页）。
if (want(12)) { console.log('== 用例 12：源码无变化但产物缺页 → 自动转全量补写，而不是永久 partial ==')
  const { base, repo } = makeRepo('missingpage', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `建库轮 done（实际 ${first.job?.stage}）`)
  const stateDocs = path.join(repo, STATE_DIR, 'docs')
  const missingRel = 'web.md'
  check(exists(path.join(stateDocs, missingRel)), '前置：首轮确实写出了 web.md')
  // 模拟历史缺口：受管状态里少一页（module_tree 仍声明 web 模块），源码不动。
  fs.rmSync(path.join(stateDocs, missingRel))
  check(!exists(path.join(stateDocs, missingRel)), '前置：受管状态已缺 web.md')

  // 同时放一个「不属于当前模块树」的旧页：模块重聚类后留下的旧页名必须被清退，
  // 否则引擎补齐新页后，旧页仍被映射成 unmapped-page → 质量门照样 partial。
  fs.writeFileSync(path.join(stateDocs, 'legacy-ancient.md'), '# legacy page', 'utf8')

  const before = readCalls(base, 'missingpage').length
  const r = await runJob(repo, { scope: 'stale' })
  const inc = r.job?.nativeResult?.incremental ?? {}
  // 修复理由记在 nativeResult.notes（引擎轮次证据），不是 service 的阶段日志
  const notes = [...(r.job?.notes ?? []), ...(r.job?.nativeResult?.notes ?? [])].join(' | ')
  const fresh = readCalls(base, 'missingpage').slice(before)
  check(inc.resolution === 'full', `缺页时决议必须转 full（实际 ${inc.resolution}；fallback=${inc.fallbackReason ?? ''}）`)
  check(/产物缺页/.test(notes) && /转全量修复/.test(notes), `notes 说明为什么转全量（实际 ${notes.slice(-200)}）`)
  check(fresh.some((c) => c.action === 'generate'), `确实以全量方式重跑引擎（足迹 ${JSON.stringify(fresh.map((c) => c.action))}）`)
  check(r.job?.stage === 'done', `补齐后终态 done（实际 ${r.job?.stage}；blockers=${JSON.stringify((r.job?.blockers ?? []).slice(0, 3))}）`)
  check(exists(path.join(repo, '.codewiki', 'modules', 'web.md')), '缺失的模块页被补写并落地')
  check(!exists(path.join(stateDocs, 'legacy-ancient.md')), '不属于当前模块树的旧页在修复前被清退（否则仍是 unmapped-page）')
  check(/清理 \d+ 个不属于当前模块树的旧页/.test(notes), `notes 记录旧页清退（实际 ${notes.slice(-200)}）`)
}

// ============================ 用例 13：陈页必须在没有缺页时也被清退 ============================
// 真实事故（Wxxy-CampusLogin，job-mw089jcq-2）：某轮引擎把页写进了 `docs/docs/`
// 这层嵌套目录，留下与正常页同名的 5 份副本，而模块树本身并不缺页。
// 原先只有「产物缺页」时才顺带清退陈页，于是没有缺页的仓库永远带着这批副本，
// 每轮都被映射成 unmapped-page「文件名冲突」→ 永久 partial。
if (want(13)) { console.log('== 用例 13：没有缺页、只有陈页 → 也要清退，不再被同名副本拖成 unmapped-page ==')
  const { base, repo } = makeRepo('staleDocs', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `建库轮 done（实际 ${first.job?.stage}）`)
  const stateDocs = path.join(repo, STATE_DIR, 'docs')
  // 嵌套目录里的同名副本：不在模块树的预期路径上，但 basename 与正常页相同
  fs.mkdirSync(path.join(stateDocs, 'docs', 'modules'), { recursive: true })
  fs.writeFileSync(path.join(stateDocs, 'docs', 'modules', 'core.md'), '# 核心（历史遗留副本）\n', 'utf8')
  fs.writeFileSync(path.join(stateDocs, 'docs', 'overview.md'), '# 概览（历史遗留副本）\n', 'utf8')

  const before = readCalls(base, 'staleDocs').length
  const r = await runJob(repo, { scope: 'stale' })
  const inc = r.job?.nativeResult?.incremental ?? {}
  const notes = [...(r.job?.notes ?? []), ...(r.job?.nativeResult?.notes ?? [])].join(' | ')
  const fresh = readCalls(base, 'staleDocs').slice(before)
  check(!exists(path.join(stateDocs, 'docs', 'modules', 'core.md')),
    '嵌套目录里的同名副本被清退（否则每轮都判 unmapped-page 文件名冲突）')
  check(!exists(path.join(stateDocs, 'docs', 'overview.md')), '嵌套目录里的 overview 副本同样被清退')
  check(/清理 \d+ 个不属于当前模块树的旧页/.test(notes), `notes 记录旧页清退（实际 ${notes.slice(-200)}）`)
  check(inc.resolution === 'update',
    `只有陈页、不缺页时不该被迫转全量（实际 ${inc.resolution}；足迹 ${JSON.stringify(fresh.map((c) => c.action))}）`)
  check(r.job?.stage === 'done', `清退后终态 done（实际 ${r.job?.stage}；blockers=${JSON.stringify((r.job?.blockers ?? []).slice(0, 3))}）`)
}

// ============================ 用例 14：同样的缺页不许每轮重跑全量 ============================
// 真实事故（dsh-git-worktree，job-mw0e3vl8-9 连续 4 轮）：缺页 → 转全量 → 全量仍然写不齐
// → 下一轮又缺页 → 又转全量。引擎在 resume 语义下对已有页短路，所以浪费只落在缺口上，
// 但只要缺口补不上（模型空响应 / 模块树与产物不符），这就成了一个永不收敛的循环：
// 每轮都白跑一次全量，用户等几十分钟却始终 partial。
// 收敛不等于豁免：本轮仍然如实报 partial（缺页一条不少），只是不再重复那次注定失败的全量。
if (want(14)) { console.log('== 用例 14：同样的缺页不再每轮重跑全量，且终态仍如实 partial ==')
  const { base, repo } = makeRepo('missingloop', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `建库轮 done（实际 ${first.job?.stage}）`)
  const stateDocs = path.join(repo, STATE_DIR, 'docs')
  check(exists(path.join(stateDocs, 'web.md')), '前置：首轮写出了 web.md')
  // 制造「补不上的缺口」：删掉页面，并让引擎此后一律不写这一页。
  fs.rmSync(path.join(stateDocs, 'web.md'))
  setMode(base, 'missingloop', 'missing-page')

  const before1 = readCalls(base, 'missingloop').length
  const r1 = await runJob(repo, { scope: 'stale' })
  const inc1 = r1.job?.nativeResult?.incremental ?? {}
  const notes1 = [...(r1.job?.notes ?? []), ...(r1.job?.nativeResult?.notes ?? [])].join(' | ')
  const fresh1 = readCalls(base, 'missingloop').slice(before1)
  check(inc1.resolution === 'full', `首次发现缺页必须转全量修复（实际 ${inc1.resolution}）`)
  check(/转全量修复/.test(notes1), `notes 说明转全量（实际 ${notes1.slice(-200)}）`)
  check(fresh1.some((c) => c.action === 'generate'), `这一轮确实跑了全量（足迹 ${JSON.stringify(fresh1.map((c) => c.action))}）`)
  check(r1.job?.stage === 'partial', `补不齐时终态必须如实 partial（实际 ${r1.job?.stage}）`)
  const missing1 = (r1.job?.blockers ?? []).filter((b) => b.kind === 'article-missing')
  check(missing1.length > 0, `缺页要以 article-missing 出现在 blockers（实际 ${JSON.stringify((r1.job?.blockers ?? []).map((b) => b.kind))}）`)
  // 第二轮的现场必须和第一轮一致（仍缺同一页），否则「是否重复」无从谈起。
  check(!exists(path.join(stateDocs, 'web.md')), '前置：全量修复后这一页仍然缺失（模拟补不上）')

  const before2 = readCalls(base, 'missingloop').length
  const r2 = await runJob(repo, { scope: 'stale' })
  const inc2 = r2.job?.nativeResult?.incremental ?? {}
  const notes2 = [...(r2.job?.notes ?? []), ...(r2.job?.nativeResult?.notes ?? [])].join(' | ')
  const fresh2 = readCalls(base, 'missingloop').slice(before2)
  check(inc2.resolution !== 'full', `同样的缺口不再重复转全量（实际 ${inc2.resolution}）`)
  check(!fresh2.some((c) => c.action === 'generate'), `这一轮不再跑全量（足迹 ${JSON.stringify(fresh2.map((c) => c.action))}）`)
  check(/不再重复全量|上一轮已尝试全量修复/.test(notes2), `notes 解释为什么不重复（实际 ${notes2.slice(-240)}）`)
  check(r2.job?.stage === 'partial', `收敛不等于豁免：终态仍是 partial（实际 ${r2.job?.stage}）`)
  const missing2 = (r2.job?.blockers ?? []).filter((b) => b.kind === 'article-missing')
  check(missing2.length > 0, '缺页仍如实计入 blockers，没有因为不重跑就被放过')
}

// ============================ 用例 15：overview 陈链必须触发重建 ============================
// 真实事故（dsh-git-worktree，job-mw0ijla0-2）：overview.md 里的 6 条链接指向当前
// 38 节点模块树的树外（build_and_configuration.md 等）。Git 史证明那些页在上一版聚类
// 里真实存在过，聚类重构后模块改名、页消失，而上游 reusable_overview() 只判「空页 /
// 未完成的 preamble」，链接正确性不在判据里 → 引擎每轮都判它可复用而跳过重建，
// 这批死链就成了永不消失的 partial 来源。
// 修法与缺页一致：发现陈链就删掉旧 overview 并转全量，让引擎按当前树重建。
if (want(15)) { console.log('== 用例 15：overview 链接指向已消失的页 → 删除并重建，而不是永远复用 ==')
  const { base, repo } = makeRepo('staleoverview', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `建库轮 done（实际 ${first.job?.stage}）`)
  const stateDocs = path.join(repo, STATE_DIR, 'docs')
  // 模拟历史遗留：overview 是上一版聚类写的，链接指向现已不存在的模块页。
  fs.writeFileSync(
    path.join(stateDocs, 'overview.md'),
    '# 项目概览\n\n## 组成\n\n见 [已消失的模块](gone-module.md)。\n',
    'utf8',
  )

  const before = readCalls(base, 'staleoverview').length
  const r = await runJob(repo, { scope: 'stale' })
  const inc = r.job?.nativeResult?.incremental ?? {}
  const notes = [...(r.job?.notes ?? []), ...(r.job?.nativeResult?.notes ?? [])].join(' | ')
  const fresh = readCalls(base, 'staleoverview').slice(before)
  check(inc.resolution === 'full', `overview 有陈链时必须转全量（实际 ${inc.resolution}；fallback=${inc.fallbackReason ?? ''}）`)
  check(/overview 有 \d+ 条指向已消失页面的链接/.test(notes), `notes 说明陈链（实际 ${notes.slice(-240)}）`)
  check(fresh.some((c) => c.action === 'generate'), `确实以全量方式重跑引擎（足迹 ${JSON.stringify(fresh.map((c) => c.action))}）`)
  check(r.job?.stage === 'done', `重建后终态 done（实际 ${r.job?.stage}；blockers=${JSON.stringify((r.job?.blockers ?? []).slice(0, 2))}）`)
  const rebuilt = fs.readFileSync(path.join(stateDocs, 'overview.md'), 'utf8')
  check(!/gone-module\.md/.test(rebuilt), `旧 overview 被删掉后由引擎重建（现存内容：${rebuilt.slice(0, 120)}）`)
}

// ============================ 用例 16：残留页随本轮编译一并清理 ============================
// 真实事故（dsh-codewiki，2026-11-03）：落地 92 页而当前树只有 20 个模块，其余 72 页
// 是历次聚类重构的残骸——它们的 source_files 指向的源码都还在（只是不再归属任何模块），
// 所以 findOrphanPages 一个都命中不了，永久挂在 _index.md 上、正文链接大量 404。
// 修法：拿本轮产物的 module_tree.json 当权威名单，页名对不上的原生页进本轮删除集。
if (want(16)) { console.log('== 用例 16：页名不属于当前模块树的残留页，随本轮编译一并删除 ==')
  const { base, repo } = makeRepo('staleleaf', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `建库轮 done（实际 ${first.job?.stage}）`)
  const mods = path.join(repo, '.codewiki', 'modules')
  // 模拟历史遗留：上一版聚类写下的页，页名在当前树里已经不存在了。
  fs.mkdirSync(mods, { recursive: true })
  fs.writeFileSync(path.join(mods, 'agent-runtime.md'),
    '---\ntitle: agent-runtime\ntype: module\nsource_files:\n  - core/core.py\ntags: []\nfsoft_page: agent_runtime.md\n---\n\n# agent-runtime\n\n旧聚类的残骸。\n', 'utf8')
  // 同一目录下的其它页也一并清：`modules/` 是引擎专属产物目录，判据只有「页名对不对得上
  // 当前树」。要保留手写内容请放 learnings/ 或 decisions/，那两处不在扫描范围。
  fs.mkdirSync(path.join(repo, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'notes', 'handbook.md'), '# 手册\n\n非源码文件。\n')
  fs.writeFileSync(path.join(mods, 'human-notes.md'),
    '---\ntitle: 手工概览\ntype: module\nsource_files:\n  - notes/handbook.md\ntags: []\n---\n\n# 手工概览\n\n人工维护，别删。\n', 'utf8')
  fs.writeFileSync(path.join(mods, 'draft.md'),
    '---\ntitle: draft\ntype: module\nsource_files: []\ntags: []\n---\n\n# draft\n\n草稿。\n', 'utf8')
  // learnings/ 下有同样的页：人工维护，不在扫描范围，必须原样保留。
  const learned = path.join(repo, '.codewiki', 'learnings')
  fs.mkdirSync(learned, { recursive: true })
  fs.writeFileSync(path.join(learned, 'keep-me.md'),
    '---\ntitle: keep-me\ntype: learning\nsource_files: []\ntags: []\n---\n\n## Overview\n\n人工记录。\n', 'utf8')
  // 源码真变了，这一轮才会真正落地（no_change 轮不清理存量页）
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "core-v2"\n')

  const r = await runJob(repo, { scope: 'stale' })
  const notes = [...(r.job?.notes ?? []), ...(r.job?.nativeResult?.notes ?? [])].join(' | ')
  check(/发现 3 个残留页/.test(notes), `notes 点名残留页数量（实际 ${notes.slice(-240)}）`)
  check(!fs.existsSync(path.join(mods, 'agent-runtime.md')), '残留页被删除')
  check(!fs.existsSync(path.join(mods, 'human-notes.md')), 'modules/ 下页名对不上树的页一律删（不兼容旧产物）')
  check(!fs.existsSync(path.join(mods, 'draft.md')), 'source_files 为空也删：判据只看页名')
  check(fs.existsSync(path.join(learned, 'keep-me.md')), 'learnings/ 不在扫描范围，人工页保留')
}

// ============================ 用例 17：无变化轮也要清残留页 ============================
// 真机事故（2026-11-03 五仓验证）：dsh-git-worktree / hindsight / CampusLogin /
// auto-router 四仓的残留页一个都没被清，因为它们本轮全都是 updateOutcome=no_change。
// idleRound 让落地器以 noChanges=true 短路，连 deleteFiles 都不看——于是「源文件没变
// 但库里有残骸」这种状态永远等不到清理。清理残骸与「写文章」是两件事：前者必须能在
// 无变化轮执行，后者不能。
if (want(17)) { console.log('== 用例 17：无变化轮也要清残留页（否则残骸永远等不到清理） ==')
  const { base, repo, git } = makeRepo('stalenoop', { mode: 'done' })
  const first = await runJob(repo, { scope: 'full' })
  check(first.job?.stage === 'done', `建库轮 done（实际 ${first.job?.stage}）`)
  const mods = path.join(repo, '.codewiki', 'modules')
  fs.mkdirSync(mods, { recursive: true })
  fs.writeFileSync(path.join(mods, 'agent-runtime.md'),
    '---\ntitle: agent-runtime\ntype: module\nsource_files:\n  - core/core.py\ntags: []\nfsoft_page: agent_runtime.md\n---\n\n# agent-runtime\n\n旧聚类的残骸。\n', 'utf8')
  // 残骸必须是**已入库**的：真实场景里它是历史某轮编译提交进 git 的页。写成未跟踪
  // 文件再删掉，对 git 而言净变化为零（"无内容可提交"），就把用例测成了假命题。
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-q', '-m', '旧聚类残骸'], { cwd: repo, stdio: 'pipe' })
  const headBefore = gitOut(repo, 'rev-parse', 'HEAD')

  // 源码一个字都不改：这一轮引擎必然报 no_change。
  setMode(base, 'stalenoop', 'update-nochange')
  const r = await runJob(repo, { scope: 'stale' })
  const notes = [...(r.job?.notes ?? []), ...(r.job?.nativeResult?.notes ?? [])].join(' | ')
  check(r.job?.nativeResult?.incremental?.updateOutcome === 'no_change',
    `本轮确实是无变化轮（实际 ${r.job?.nativeResult?.incremental?.updateOutcome}）`)
  check(!fs.existsSync(path.join(mods, 'agent-runtime.md')), `无变化轮也要清掉残留页（notes: ${notes.slice(-200)}）`)
  check(gitOut(repo, 'rev-parse', 'HEAD') !== headBefore, '清理必须产生一次真实提交（不是只改工作区）')
  const files = gitShowFiles(repo, gitOut(repo, 'rev-parse', 'HEAD'))
  check(files.includes('.codewiki/modules/agent-runtime.md'), `删除进同一个 commit（实际 ${JSON.stringify(files)}）`)
}

// ============================ 用例 11：宿主重放保留断点现场 ============================
if (want(11)) { console.log('== 用例 11：resume 水合不覆盖崩溃现场，并显式下发续跑参数 ==')
  const { base, repo } = makeRepo('resume', { mode: 'done' })
  await runJob(repo, { scope: 'full' })
  const docs = freshDocs('resume')
  fs.cpSync(path.join(repo, STATE_DIR, 'docs'), docs, { recursive: true })
  fs.writeFileSync(path.join(docs, 'dsh_leaf_checkpoint.json'), '{"completed":"sentinel"}', 'utf8')
  fs.writeFileSync(path.join(docs, 'module_tree.json'), '{truncated', 'utf8')
  fs.writeFileSync(path.join(docs, 'overview.md'), 'interrupted partial article', 'utf8')
  const hydrated = nativeState.hydrateDocsDir({ stateDir: STATE_DIR, repoRoot: repo, docsDir: docs, overwrite: false })
  check(hydrated.hydrated.includes('module_tree.json'), '水合阶段实际修复了半截核心 JSON，而不是靠假引擎重写')
  check(fs.readFileSync(path.join(docs, 'module_tree.json'), 'utf8') === fs.readFileSync(path.join(repo, STATE_DIR, 'docs', 'module_tree.json'), 'utf8'), '修复后的核心 JSON 与受管基线逐字节一致')
  check(hydrated.retained.includes('overview.md'), '有效同名文章现场被保留且有显式记录')
  fs.writeFileSync(path.join(docs, 'dsh_leaf_checkpoint.json.tmp'), 'partial', 'utf8')
  const captureDocs = freshDocs('resume-capture')
  fs.cpSync(docs, captureDocs, { recursive: true })
  const captured = nativeState.captureDocsDir({ docsDir: captureDocs, stateDir: STATE_DIR })
  check(captured.captured.includes('module_tree.json') && captured.captured.includes('overview.md'), '正向对照：采集确实读到了核心状态和文章')
  check(!captured.captured.includes('dsh_leaf_checkpoint.json') && !captured.captured.includes('dsh_leaf_checkpoint.json.tmp'), '崩溃续跑凭据及其临时文件不得进入受管 wiki 状态')
  const r = await runNativeJob({ repoRoot: repo, scope: 'stale', docsDir: docs, resume: true, moduleConcurrency: 4, deps: baseDeps() })
  check(r.incremental?.resolution === 'update', `保留现场时仍走增量（实际 ${r.incremental?.resolution}；${r.incremental?.fallbackReason ?? ''}）`)
  check(fs.readFileSync(path.join(docs, 'dsh_leaf_checkpoint.json'), 'utf8').includes('sentinel'), '受管状态水合没有覆盖崩溃时留下的 checkpoint')
  const update = readCalls(base, 'resume').filter((c) => c.action === 'update').at(-1)
  check(update?.updateOptions?.extra?.resume === true, `引擎收到 resume=true（实际 ${JSON.stringify(update?.updateOptions)}）`)
  check(update?.updateOptions?.extra?.moduleConcurrency === 4, '引擎收到增量叶子并行度')
}

// ============================ 用例 18：rung=0 在本机就判成全量 ============================
// 上游 _update_options()（doc_generator.py:421-422）见到 rung="0" 直接返回 None，
// 整条增量分支被跳过、退回全量生成。若插件照发 action=update，引擎会走进全量路径，
// 而 updateOutcome 拿不到 incremental/no_change —— 一次正常的全量会被误报成
// incremental-fallback，终态被拖成 partial。所以决议必须在本机先判全量。
if (want(18)) { console.log('== 用例 18：增量档位 rung=0 → 本机判全量，不误报增量降级 ==')
  const { base, repo } = makeRepo('rungzero', { mode: 'done' })
  await runJob(repo, { scope: 'full' })

  // 造一个真实的源码改动，确保「本来会走增量」
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), '# rung0 change\n' + fs.readFileSync(path.join(repo, 'core', 'core.py'), 'utf8'), 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-q', '-m', '源码改动'], { cwd: repo, stdio: 'pipe' })

  const r = await runNativeJob({
    repoRoot: repo, scope: 'stale', docsDir: freshDocs('rungzero'),
    deps: baseDeps({ updateOptions: { rung: '0' } }),
  })
  check(r.incremental?.resolution === 'full', `rung=0 时决议 full（实际 ${r.incremental?.resolution}）`)
  const notes = [...(r.notes ?? []), ...(r.incremental?.notes ?? [])].join(' | ')
  check(/rung=0/.test(notes), `notes 点名档位（${notes.slice(0, 160)}）`)
  const calls = readCalls(base, 'rungzero').filter((c) => c.action === 'update')
  check(calls.length === 0, `引擎没有收到 update 动作（实际 ${calls.length} 次）`)
  check((r.blockers ?? []).every((b) => b.kind !== 'incremental-fallback'),
    `用户显式选的档位不挂增量降级 blocker（${JSON.stringify((r.blockers ?? []).map((b) => b.kind))}）`)
}

// ============================ 收尾 ============================
for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* Windows 占用留给系统清理 */ } }
try { fs.rmSync(JOBS_FILE, { force: true }) } catch { /* ignore */ }

console.log(`\n== 结果：${checks - failures}/${checks} 通过，${failures} 失败 ==`)
if (failures > 0) process.exit(1)
console.log('阶段 5 统一增量测试全部通过')
