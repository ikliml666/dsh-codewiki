// test-engine-native-job.mjs — 阶段 4：原生引擎接入 JobService 的**生产接线**测试。
//
// 这个文件守的不是「某个函数算得对」，而是「codewiki_generate 提交的 job 真的走到了
// 原生通道，且终态由质量门 + 落地器裁决」。所以除了两个纯裁决用例，其余全部走真实链路：
//
//   codewiki_generate.execute → JobService.submit → tick(300ms) → tickNative
//     → runNativeJob → doctor/lock → runEngine(client.js 真 spawn) → 假引擎进程
//     → gateNativeOutput(真实) → applyNativeOutput(真实) → cw init/index/meta(真实)
//     → autoCommitWiki(真实 git) → finishJob
//
// 「假引擎」（test-fixtures/fake-native-engine.mjs）只实现协议与产物，不实现算法：
// 它是**真进程**，所以 client.js 的 spawn / stdin 一行 JSON / stdout JSON-lines /
// 进程树终止全部走真实代码——那正是最容易悄悄坏掉的一段。
//
// 覆盖：成功 / 首次编译不得伪 done / 引擎 done 被质量门拦下 / 引擎 failed /
// 协议破坏 / 环境缺失 / 锁漂移 / index 失败 / 基线失败 / 提交失败 / 取消（进程树终止）/
// 单项目串行 / 旧默认通道不受影响 / 裁决链短路分支。
//
// 运行：node test-engine-native-job.mjs（成功退出码 0）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 测试加速：tick 间隔压到下限（生产默认 10s）。
process.env.DSH_CODEWIKI_TICK_MS = '300'
// 独立 JOBS_FILE：与真实宿主服务实例隔离（同名文件会被互相洗写）。随机串防止 pid 复用
// 读到历史运行留下的 fixture 任务。
const TEST_TOKEN = crypto.randomBytes(4).toString('hex')
process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `dsh-codewiki-jobs-native-${process.pid}-${TEST_TOKEN}.json`)

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_ENGINE = path.join(here, 'test-fixtures', 'fake-native-engine.mjs')
const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE

const { apply } = await import('./index.js')
const { runNativeJob } = await import('./lib/engine/native-run.js')

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

// ── fixture：一个带 git 与（可选）预初始化 wiki 的临时仓库 ─────────────────────
// 目录布局：<base>/<tag> 是仓库，<base>/.native-mode-<tag> 是假引擎模式文件。
// 模式文件必须放**仓库外**：放进仓库会变成一次未提交源码改动，质量门的
// uncommitted-input 会把它判成产品缺陷——测试脚本自己污染被测对象。
const madeDirs = []
function makeRepo(tag, { mode = 'done', preInit = false, metaReadonly = false, noEmail = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-native-job-'))
  madeDirs.push(base)
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
  if (preInit) {
    // 预初始化：真实 cw init + 入口页提交。
    // 为什么需要：首次编译（无 wiki）时 `.codewiki/_meta.yaml` 是本次才出现的、
    // 未提交的文件，质量门会判 baseline-uncommitted → 终态 partial。那是阶段 5
    // 要补齐的真实限制，不该让「成功路径」用例被它连带失败。
    execFileSync('cw', ['init'], { cwd: repo, stdio: 'pipe' })
    fs.writeFileSync(path.join(repo, 'CodeWiki.md'), '# CodeWiki\n')
    git('add', '.codewiki')
    git('add', 'CodeWiki.md')
    git('commit', '-m', 'wiki init')
  }
  if (metaReadonly) {
    // 让 `cw meta update` 真实失败（实测：只读 → Error: Failed to write ..._meta.yaml /
    // Caused by: 拒绝访问。 (os error 5)），同时 `cw index` 仍成功——两条失败互不干扰。
    fs.chmodSync(path.join(repo, '.codewiki', '_meta.yaml'), 0o444)
  }
  if (noEmail) {
    // 清空 identity：autoCommitWiki 的守卫会返回 committed:false（安全边界，不猜身份）。
    git('config', 'user.email', '')
  }
  fs.writeFileSync(path.join(base, `.native-mode-${tag}`), mode, 'utf8')
  return { base, repo, calls: () => readCalls(base, tag) }
}

// 假引擎的调用足迹（引擎自己追加写，测试只读）。
function readCalls(base, tag) {
  const file = path.join(base, `.native-calls-${tag}.log`)
  if (!exists(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

// ── 宿主 ctx mock（与 test-orchestration.mjs 同构）─────────────────────────────
// 原生通道里模型请求由 Python 引擎经 llm-bridge 打进来，假引擎不访问桥，所以默认的
// fakeLlm 只需要「桥能建立」这一事实。旧通道用例（用例 13）要真的把文章写出来，
// 换成能按 prompt 应答的 legacyLlm——两类用例对 llm 的要求不同，不能共用一份。
const fakeLlm = {
  async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  listModels: () => [],
  resolveModel: () => null,
}

// 旧 Node 流水线的最小可用假 llm：按 prompt 首行特征分发，产出符合文章契约的 markdown。
// 只服务用例 13（证明「nativeEngine 默认关闭时旧通道照常完成」），不追求覆盖旧通道细节。
//
// 为什么按仓库真实文件算 source_files：旧通道的文章契约闸门会校验 source_files 指向的
// 文件**真实存在**，模块名却由 localPlan 现场生成（fixture 里会出现 root 之类不对应
// 任何目录的模块名）。写死 `core/core.py` 会让若干篇判 contract 失败、整任务落成
// partial——那测的是夹具编得对不对，不是「旧通道还活着」。
const articleMd = (title, source, type = 'module') =>
  `---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\nLegacy-written article.\n`

function realSources(repo) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= 8 || depth > 3) return
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (it.name === '.git' || it.name.startsWith('.')) continue
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) { walk(abs, depth + 1); continue }
      if (/\.(py|ts|js|mjs|go|rs|java)$/i.test(it.name)) out.push(path.relative(repo, abs).replace(/\\/g, '/'))
    }
  }
  walk(repo, 0)
  return out
}

function legacyLlmFor(repo) {
  const files = realSources(repo)
  // localPlan 把仓库**根**上的文件单独归成 `root` 模块（index.js:1375 的 slugify(top === path ? 'root' : top)），
  // 而文章契约闸门要求 source_files 能对应模块自身的目录：root 模块只能挂根上的文件。
  // 给它挂 core/core.py 会被判 contract 失败、整个任务落 partial——那测的是夹具编得对不对。
  const pick = (mn) => (mn === 'root'
    ? 'CodeWiki.md'
    : (files.find((f) => f.startsWith(`${mn}/`)) ?? files[0] ?? 'core/core.py'))
  return {
    async *stream(opts) {
      const prompt = String(opts?.messages?.[0]?.content?.[0]?.text ?? '')
      let content = '---\ntitle: unknown\n---\nunknown task'
      if (prompt.includes('你是 CodeWiki 文章观察员')) {
        content = '观察：模块职责与关键实现（来自分批观察）。\n'
      } else if (prompt.includes('你是 CodeWiki 文章作者')) {
        const mn = (prompt.match(/modules\/([a-z0-9-]+)\.md/) ?? [])[1] ?? 'core'
        content = articleMd(mn, pick(mn))
      } else if (prompt.includes('你是 CodeWiki 架构观察员')) {
        content = `模块观察：职责一句话。\n\nsource_files:\n  - ${pick('core')}\n`
      } else if (prompt.includes('写系统总览')) {
        content = articleMd('Architecture', pick('core'), 'architecture')
      } else if (prompt.includes('总结仓库反复出现的模式')) {
        content = articleMd('Patterns', pick('util'), 'pattern')
      } else if (prompt.includes('写跨模块概念')) {
        content = articleMd('config-load', pick('core'), 'concept')
      } else if (prompt.includes('你是 CodeWiki 审校员')) {
        const fm = prompt.match(/---\ntitle:[\s\S]*?\n---/)
        content = fm ? `${fm[0]}\n\nPROOFED article.\n` : articleMd('Proofed', pick('core'))
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: content }
      yield { type: 'usage', usage: { outputTokens: 64 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listModels: () => [],
    resolveModel: () => null,
  }
}

function makeCtx({ llm = fakeLlm } = {}) {
  const registered = new Map()
  const endpoints = []
  const disposers = []
  const services = {
    webServer: { register(def) { endpoints.push(def) } },
    agents: { list: () => [] },
    tools: { register(def) { registered.set(def.name, def); return () => {} } },
    llm,
  }
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
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
  }
  return { ctx, registered, endpoints, disposers }
}

function nativeCfg(extra = {}) {
  return {
    batchProvider: 'workbuddy',
    batchModel: 'hy3',
    // 旧通道三档显式关闭：本文件测的是原生通道，不该被语义规划/agentic/符号增量
    // 的额外请求干扰（旧通道行为由 test-orchestration.mjs 等守护）。
    planMode: 'dirs',
    agenticArticles: false,
    symbolIncremental: false,
    nativeEngine: true,
    // 假引擎用 node 当「解释器」、本文件当「入口」：client.js 走完全真实的 spawn 路径。
    nativeEnginePython: process.execPath,
    nativeEngineEntry: FAKE_ENGINE,
    ...extra,
  }
}

// 等某个 cwd 的最新 job 到终态（done/partial/failed/cancelled）。
async function waitJob(cwd, { timeout = 90000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    let job = null
    try {
      const data = readJson(JOBS_FILE)
      job = (data.jobs ?? []).filter((x) => norm(x.cwd) === norm(cwd)).pop() ?? null
    } catch { /* 文件尚未落盘 */ }
    if (job && ['done', 'partial', 'failed', 'cancelled'].includes(job.stage)) return job
    if (Date.now() - t0 > timeout) return job
    await new Promise((r) => setTimeout(r, 120))
  }
}

// 起一套服务 + 提交一个仓库，返回终态 job。
async function runJob(repo, { cfg = nativeCfg(), scope = 'full', waitMs = 90000, llm = fakeLlm } = {}) {
  const m = makeCtx({ llm })
  apply(m.ctx, cfg)
  try {
    const gen = m.registered.get('codewiki_generate')
    const submitted = await gen.execute({ cwd: repo, scope }, { agent: { id: 'sess-native' } })
    const job = await waitJob(repo, { timeout: waitMs })
    return { job, submitted, m }
  } finally {
    for (const d of m.disposers) { try { d() } catch { /* 清理失败不影响断言 */ } }
  }
}

const gitLog = (repo, n = 3) => execFileSync('git', ['log', '--oneline', '-n', String(n)], { cwd: repo, encoding: 'utf8' }).trim()
const gitShowFiles = (repo, sha) => String(execFileSync('git', ['show', '--name-only', '--pretty=format:', sha], { cwd: repo, encoding: 'utf8' }))
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

// ============================ 用例 1：完整成功 ============================
console.log('== 用例 1：原生通道完整成功（done 只由 gate+apply 共同成立）==')
{
  const { repo, calls } = makeRepo('ok', { mode: 'done', preInit: true })
  const before = gitLog(repo, 1)
  const { job, submitted } = await runJob(repo)

  check(submitted.submitted === true && typeof submitted.jobId === 'string', `工具提交即返回（submitted=true，jobId=${submitted.jobId}）`)
  check(job?.channel === 'native', `job.channel=native（实际 ${job?.channel}）`)
  check(job?.stage === 'done', `终态 done（实际 ${job?.stage}）`)
  check(job?.outcome === 'done', `outcome=done（实际 ${job?.outcome}）`)
  check(job?.canAdvanceBaseline === true, 'canAdvanceBaseline=true（只有完整成功才推进）')
  check((job?.blockers ?? []).length === 0, 'blockers 为空（done 不许带阻塞原因）')
  check(job?.nativeResult?.gate?.outcome === 'done' && job?.nativeResult?.gate?.writable === true, '质量门 done 且 writable（不是引擎自报）')
  check(job?.nativeResult?.apply?.outcome === 'done' && job?.nativeResult?.apply?.applied === true, '落地器 done 且 applied')
  check(job?.nativeResult?.apply?.baseline?.advanced === true, '基线已推进（cw meta update 真实成功）')
  check(job?.nativeResult?.apply?.commit?.committed === true, '自动提交成立')
  check(exists(path.join(repo, 'CodeWiki.md')), '仓库根 CodeWiki.md 已生成')
  check(exists(path.join(repo, '.codewiki', 'engine-lock.json')), '引擎锁已落盘（首次成功后写入）')
  // 锁必须**进提交**，不能留在工作区当未跟踪文件：manifest 的契约是「落锁与产物同事务」。
  // 分两次写（先提交产物、再补写锁）会让每轮编译之后工作区都多一个脏文件，下一轮
  // 变化集因此永远不干净——真实仓库实测就是这么长出来的（engine-lock + update-record
  // 双双 `??`），而无变化轮被要求「零副作用」。
  {
    const sha = String(job?.nativeResult?.apply?.commit?.sha ?? '')
    const committedFiles = gitShowFiles(repo, sha)
    check(committedFiles.includes('.codewiki/engine-lock.json'),
      `引擎锁随产物进同一个提交（提交清单 ${committedFiles.length} 项：${committedFiles.slice(0, 6).join('、')}）`)
    // 提交里出现的必须是真实路径：中文/非 ASCII 页名在 git 默认输出里是八进制转义串，
    // 拿它去比对路径永远不相等（阶段 6 真实验收就栽在这里）。
    check(committedFiles.every((f) => !f.startsWith('"') && !f.includes('\\344')),
      `提交清单是真实路径而非 git 转义写法（${committedFiles.slice(0, 3).join('、')}）`)
    const dirty = String(execFileSync('git', ['status', '--porcelain', '--', '.codewiki'], { cwd: repo, encoding: 'utf8' })).trim()
    check(dirty === '', `落地后 .codewiki 工作区干净（没有遗留未跟踪的锁/记录）：${JSON.stringify(dirty)}`)
  }
  check(job?.nativeStage === 'commit' || job?.nativeStage === 'baseline' || job?.nativeStage === 'index', `引擎阶段挂在真实八段之一（实际 ${job?.nativeStage}）`)

  // 引擎确实被调用：doctor 一次 + generate 一次
  const actions = calls().map((c) => c.action)
  check(actions.includes('doctor'), `假引擎收到 doctor（足迹 ${JSON.stringify(actions)}）`)
  check(actions.filter((a) => a === 'generate').length === 1, '生成动作恰好一次（没有重复提交）')

  // 自动提交只落 wiki 路径
  const sha = String(job?.nativeResult?.apply?.commit?.sha ?? '')
  const files = gitShowFiles(repo, sha)
  check(files.length > 0 && files.every((f) => f === 'CodeWiki.md' || f.startsWith('.codewiki/')),
    `提交只含 wiki 路径（${files.slice(0, 6).join('、')}${files.length > 6 ? ' 等' : ''}）`)
  check(gitLog(repo, 1) !== before, 'HEAD 前进了（产物真的入库）')

  // 安全：模型桥占位 key 绝不落进 job 文件（job 会被持久化到磁盘）
  const jobsText = fs.readFileSync(JOBS_FILE, 'utf8')
  check(!jobsText.includes('dsh-bridge-'), '持久化 job 里没有模型桥占位 key')
  check(!JSON.stringify(job?.nativeLogs ?? []).includes('dsh-bridge-'), '引擎/桥日志里没有模型桥占位 key')
}

// ============================ 用例 2：首次编译不得伪 done ============================
console.log('== 用例 2：首次编译（无 wiki）引擎 done，但状态不得是 done ==')
{
  // 真实限制（阶段 5 补齐）：首次编译产生的 .codewiki/_meta.yaml 是本次才出现、
  // 尚未提交的文件，质量门判 baseline-uncommitted，因此终态只能 partial。
  // 这条断言的用意是**反向**的：宁可能被看见地「没完成」，也不许把未入库的基线
  // 记成已消化（否则下一轮编译以为这些变化处理过了）。
  const { repo } = makeRepo('fresh', { mode: 'done', preInit: false })
  const { job } = await runJob(repo)
  check(job?.stage === 'partial', `终态 partial 而不是 done（实际 ${job?.stage}）`)
  check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false（基线未推进）')
  check((job?.blockers ?? []).some((b) => b.kind === 'baseline-failed'), 'blockers 里有 baseline-failed')
  check(exists(path.join(repo, 'CodeWiki.md')), '文章仍然落地了（partial 是可交付的部分成功）')
  const meta = fs.readFileSync(path.join(repo, '.codewiki', '_meta.yaml'), 'utf8')
  check(/last_compiled_commit:\s*null/.test(meta), '_meta.yaml 的基线仍为 null（没有偷偷推进）')
}

// ============================ 用例 3：引擎 done 被质量门拦下 ============================
console.log('== 用例 3：引擎回 done 但没产物 → 质量门拦下，不得伪 done ==')
{
  const { repo, calls } = makeRepo('empty', { mode: 'empty-docs', preInit: true })
  const { job } = await runJob(repo)
  check(calls().some((c) => c.action === 'generate'), '引擎确实被调用了（不是没跑就判失败）')
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  check(job?.nativeResult?.gate?.outcome === 'failed', `质量门 failed（实际 ${job?.nativeResult?.gate?.outcome}）`)
  check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false')
  const shaBefore = gitLog(repo, 1)
  check(!exists(path.join(repo, '.codewiki', 'modules', 'web.md')), '没有把引擎产物当成功落地')
  check(shaBefore.length > 0, '仓库 HEAD 未被失败任务推动')
}

// ============================ 用例 4：引擎 failed ============================
console.log('== 用例 4：引擎回 failed → 终态 failed，不进 gate/apply ==')
{
  const { repo } = makeRepo('efail', { mode: 'fail', preInit: true })
  const { job } = await runJob(repo)
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  check(job?.error != null && String(job.error).length > 0, `job.error 非空（${String(job?.error).slice(0, 60)}）`)
  check(job?.nativeResult?.gate == null, '没有跑质量门（引擎失败后不继续）')
  check(job?.nativeResult?.apply == null, '没有跑落地器')
  check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false')
}

// ============================ 用例 5：协议破坏 ============================
console.log('== 用例 5：引擎只写人类日志、不写 result（协议破坏）→ failed ==')
{
  // client.js 不变量：没有 result 消息 = 协议破坏，退出码 0 也救不了它。
  const { repo } = makeRepo('crash', { mode: 'crash', preInit: true })
  const { job } = await runJob(repo)
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  check(/协议|result|异常退出/.test(String(job?.error ?? '')), `错误信息点明协议破坏或异常退出（${String(job?.error).slice(0, 80)}）`)
}

// ============================ 用例 6：环境缺失 → 不跑引擎 ============================
console.log('== 用例 6：解释器不存在 → failed engine-missing，且引擎 generate 从未被调用 ==')
{
  const { repo, calls } = makeRepo('noenv', { mode: 'done', preInit: true })
  const bogus = path.join(os.tmpdir(), `no-such-python-${TEST_TOKEN}`, 'python.exe')
  const { job } = await runJob(repo, { cfg: nativeCfg({ nativeEnginePython: bogus }) })
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  // 注：解释器不存在时 compareLock 会先判 absent（没有 lock 可比较），真正的失败判据是
  // native-run 收集到的 probeError（doctor 探测失败）。所以这里断言错误原因为「引擎不可用」，
  // 而不是断言 lock 状态——后者在有 lock 的仓库上才会是 probe-failed。
  check(/无法启动|不可用|探测失败|ENOENT/i.test(String(job?.error ?? '')),
    `环境缺失被如实判定（job.error=${String(job?.error).slice(0, 70)}）`)
  check(job?.nativeResult?.gate == null && job?.nativeResult?.apply == null, '没有跑质量门/落地器')
  check(!calls().some((c) => c.action === 'generate'), '引擎从未被要求生成（环境不过就不跑）')
  check(!exists(path.join(repo, '.codewiki', 'modules', 'core.md')), '没有产物落地')
}

// ============================ 用例 7：锁漂移 → 不跑引擎 ============================
console.log('== 用例 7：引擎锁漂移 → failed engine-deps，且不跑 generate ==')
{
  const { repo, calls } = makeRepo('drift', { mode: 'done', preInit: true })
  // 写一份「另一个引擎版本」的锁：doctor 会判 drift。
  fs.writeFileSync(path.join(repo, '.codewiki', 'engine-lock.json'), JSON.stringify({
    manifestVersion: 1, fingerprint: 'deadbeefdeadbeef', version: '0.0.1-old', pythonVersion: '3.8.0',
    engineRoot: '', pipCheckOk: true, recordedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  const shaBefore = gitLog(repo, 1)
  const { job } = await runJob(repo)
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  check(job?.nativeResult?.engineLock?.status === 'drift', `锁状态 drift（实际 ${job?.nativeResult?.engineLock?.status}）`)
  check(/不一致|版本/.test(String(job?.error ?? '')), `错误信息说明版本不一致（${String(job?.error).slice(0, 80)}）`)
  check(!calls().some((c) => c.action === 'generate'), '锁不一致时引擎未被要求生成')
  check(!exists(path.join(repo, 'CodeWiki.md')) || gitLog(repo, 1) === shaBefore, '产物未被改动、基线未动')
}

// ============================ 用例 8：index 失败 → 回滚 ============================
console.log('== 用例 8：cw index 失败 → failed + rolledBack，产物不留半截 ==')
{
  const { repo } = makeRepo('idxfail', { mode: 'done', preInit: true })
  // 实测稳的 index 失败手段：把 _index.md 建成目录 → cw index 报 os error 5（拒绝访问）。
  fs.rmSync(path.join(repo, '.codewiki', '_index.md'), { force: true })
  fs.mkdirSync(path.join(repo, '.codewiki', '_index.md'))
  const { job } = await runJob(repo)
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  check(job?.nativeResult?.apply?.rolledBack === true, `落地器 rolledBack=true（实际 ${job?.nativeResult?.apply?.rolledBack}）`)
  check((job?.blockers ?? []).some((b) => b.kind === 'index-failed'), `blockers 含 index-failed（${JSON.stringify((job?.blockers ?? []).map((b) => b.kind))}）`)
  check(!exists(path.join(repo, '.codewiki', 'modules', 'web.md')), '本次写入的文章已回滚（不留下与索引不一致的库）')
  check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false')
}

// ============================ 用例 9：基线失败 → 连文章一起回滚 ============================
console.log('== 用例 9：cw meta update 失败（_meta.yaml 只读）→ failed + 回滚 ==')
{
  const { repo } = makeRepo('basefail', { mode: 'done', preInit: true, metaReadonly: true })
  const { job } = await runJob(repo)
  check(job?.stage === 'failed', `终态 failed（实际 ${job?.stage}）`)
  check(job?.nativeResult?.apply?.baseline?.advanced === false, '基线未推进')
  check((job?.blockers ?? []).some((b) => b.kind === 'baseline-failed'), `blockers 含 baseline-failed（${JSON.stringify((job?.blockers ?? []).map((b) => b.kind))}）`)
  check(job?.nativeResult?.apply?.rolledBack === true, '整批回滚（基线失败不留「文章比基线新」的库）')
  check(!exists(path.join(repo, '.codewiki', 'modules', 'core.md')), '本次写的文章已回滚')
  check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false')
  try { fs.chmodSync(path.join(repo, '.codewiki', '_meta.yaml'), 0o666) } catch { /* 清理 */ }
}

// ============================ 用例 10：提交失败 → partial（不回滚） ============================
console.log('== 用例 10：自动提交不成立 → partial，产物保留、基线不推进 ==')
{
  const { repo } = makeRepo('commitfail', { mode: 'done', preInit: true, noEmail: true })
  const { job } = await runJob(repo)
  check(job?.stage === 'partial', `终态 partial（实际 ${job?.stage}）`)
  check(job?.nativeResult?.apply?.applied === true, '落地仍 applied=true（文章与索引/基线已生效）')
  check(job?.nativeResult?.apply?.commit?.committed === false, '提交未成立')
  check((job?.blockers ?? []).some((b) => b.kind === 'commit-failed'), `blockers 含 commit-failed（${JSON.stringify((job?.blockers ?? []).map((b) => b.kind))}）`)
  check(exists(path.join(repo, '.codewiki', 'modules', 'core.md')), '提交失败不回滚产物（不变量 3）')
  check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false（未入库就不算消化完）')
}

// ============================ 用例 11：取消 → 进程树终止 ============================
console.log('== 用例 11：取消 → cancelled 是终态，且引擎进程树被终止 ==')
{
  const { repo, calls } = makeRepo('stall', { mode: 'stall', preInit: true })
  const m = makeCtx()
  apply(m.ctx, nativeCfg())
  try {
    const gen = m.registered.get('codewiki_generate')
    const submitted = await gen.execute({ cwd: repo, scope: 'full' }, { agent: { id: 'sess-cancel' } })
    // 等引擎真的起来了（足迹里有 generate，说明进程已 spawn 并读到请求）
    let started = false
    for (let i = 0; i < 100 && !started; i += 1) {
      started = calls().some((c) => c.action === 'generate')
      if (!started) await new Promise((r) => setTimeout(r, 100))
    }
    check(started, '引擎已启动（stall 模式在跑）')
    const ctl = m.endpoints.find((e) => e.path === '/api/codewiki/control')
    check(!!ctl, '面板取消端点存在')
    const res = { code: 0, out: '', writeHead(c) { this.code = c }, end(b) { this.out = String(b ?? '') } }
    await ctl.handler({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, fn) { if (ev === 'data') fn(Buffer.from(JSON.stringify({ action: 'cancel', jobId: submitted.jobId }))); if (ev === 'end') fn() },
    }, res)
    const job = await waitJob(repo, { timeout: 30000 })
    check(job?.stage === 'cancelled', `终态 cancelled（实际 ${job?.stage}）`)
    check(job?.canAdvanceBaseline === false, 'canAdvanceBaseline=false（半成品基线绝不前移）')
    check((job?.notes ?? []).some((n) => n.includes('进程树已终止')), 'note 记录「进程树已终止」')
    // 仓库本来就带预初始化的 CodeWiki.md（preInit），所以判据不能是「入口页不存在」，
    // 而是「取消没有落下任何新文章」——stall 模式连 docs 都没写。
    check(!exists(path.join(repo, '.codewiki', 'modules', 'core.md')), '取消后没有新文章落地')
    // 再等两轮 tick：确认迟到的结果不会把 cancelled 覆盖成 done
    await new Promise((r) => setTimeout(r, 900))
    const after = (readJson(JOBS_FILE).jobs ?? []).find((j) => j.id === job?.id)
    check(after?.stage === 'cancelled', `迟到结果没有覆盖终态（仍为 ${after?.stage}）`)
  } finally {
    for (const d of m.disposers) { try { d() } catch { /* ignore */ } }
  }
}

// ============================ 用例 12：单项目串行 ============================
console.log('== 用例 12：单项目串行 —— 第二个仓库 queued，前一个收尾后自动轮到 ==')
{
  // slow 模式会自己跑完（约 2.5s），不用 stall：串行测试不该顺带验证取消。
  const a = makeRepo('serialA', { mode: 'slow', preInit: true })
  const b = makeRepo('serialB', { mode: 'done', preInit: true })
  const m = makeCtx()
  apply(m.ctx, nativeCfg())
  try {
    const gen = m.registered.get('codewiki_generate')
    const subA = await gen.execute({ cwd: a.repo, scope: 'full' }, { agent: { id: 'sess-serial' } })
    const subB = await gen.execute({ cwd: b.repo, scope: 'full' }, { agent: { id: 'sess-serial' } })
    check(subA.submitted === true && subB.submitted === true, '两个仓库都已提交')
    // 立刻读：B 应处于 queued（闸门上限 1，A 还在跑）
    const snap = readJson(JOBS_FILE).jobs ?? []
    const jobB0 = snap.find((j) => j.id === subB.jobId)
    check(jobB0?.stage === 'queued', `第二个仓库排队（实际 ${jobB0?.stage}）`)
    check((jobB0?.notes ?? []).some((n) => n.includes('编译通道已满')), 'note 说明通道已满在排队')
    const jobA = await waitJob(a.repo, { timeout: 90000 })
    check(jobA?.stage === 'done', `第一个仓库完成（实际 ${jobA?.stage}）`)
    const jobB = await waitJob(b.repo, { timeout: 90000 })
    check(jobB?.stage === 'done', `排队者随后完成（实际 ${jobB?.stage}）`)
    check(jobB?.channel === 'native', '排队者最终也走原生通道')
  } finally {
    for (const d of m.disposers) { try { d() } catch { /* ignore */ } }
  }
}

// ============================ 用例 13：旧默认通道不受影响 ============================
console.log('== 用例 13：nativeEngine 默认关闭时完全走旧通道，原生引擎一次都不跑 ==')
{
  const { repo, calls } = makeRepo('legacy', { mode: 'done', preInit: true })
  const { job } = await runJob(repo, { cfg: nativeCfg({ nativeEngine: false }), llm: legacyLlmFor(repo) })
  check(job?.stage === 'done', `旧通道照常完成（实际 ${job?.stage}；blockers=${JSON.stringify(job?.blockers ?? [])}）`)
  check((job?.channel ?? 'legacy') === 'legacy', `channel=legacy（实际 ${job?.channel}）`)
  check(job?.nativeResult == null, '没有 nativeResult（没走原生裁决）')
  check(calls().length === 0, `原生引擎一次都没被调用（足迹 ${JSON.stringify(calls().map((c) => c.action))}）`)
}

// ============================ 用例 14：stale 的通道归属（阶段 5 变更点） ============================
console.log('== 用例 14：stale 现在进原生通道，但无受管状态时决议为全量 ==')
{
  const { nativeChannelFor } = await import('./index.js')
  // 阶段 4 时 stale 恒不走原生（增量还没接）；阶段 5 把决议权交给 native-run，
  // 通道只负责「这个 scope 归不归我管」。所以断言从「返回 null」改成
  // 「返回通道快照且 scope 如实透出」——否则这条用例会锁住阶段 4 的旧边界。
  const ch = nativeChannelFor({ nativeEngine: true, nativeEnginePython: process.execPath, nativeEngineEntry: FAKE_ENGINE }, { kind: 'stale', scope: 'stale' })
  check(ch && ch.scope === 'stale', `nativeChannelFor(kind=stale) 返回通道且 scope=stale（实际 ${JSON.stringify(ch?.scope ?? ch)}）`)
  const chFull = nativeChannelFor({ nativeEngine: true, nativeEnginePython: process.execPath, nativeEngineEntry: FAKE_ENGINE }, { kind: 'full', scope: 'full' })
  check(chFull && typeof chFull.entry === 'string', 'nativeChannelFor(kind=full) 返回通道快照')
  const chOff = nativeChannelFor({ nativeEngine: false }, { kind: 'full', scope: 'full' })
  check(chOff === null, 'nativeEngine=false 时通道为 null（保守默认）')

  // 接线判据：scope=stale 但仓库还没有任何 wiki → 既有逻辑把 scope 升为 full，
  // 于是它**合法地**进了原生通道（引擎收到的仍是 generate，不是 update）。
  const { repo, calls } = makeRepo('stalebound', { mode: 'done', preInit: true })
  const { submitted } = await runJob(repo, { scope: 'stale' })
  check(submitted.submitted === true, 'stale 在无编译产物时被升为全量并提交（既有 scope 修正逻辑）')
  check(calls().every((c) => c.action !== 'update'), `引擎从未收到 update 动作（足迹 ${JSON.stringify(calls().map((c) => c.action))}）`)
}

// ============================ 用例 15：假 runEngine + 真 gate/apply ============================
console.log('== 用例 15：假 runEngine 报 done 但产物目录为空 → 真质量门拦下 ==')
{
  // 这条是「组合」用例：runEngine 被替换成假函数（不走进程），但 gateNativeOutput 与
  // applyNativeOutput 都是真实实现。它锁住的是最关键的一条不变量：**引擎的自我评价
  // 不能替代质量门**——哪怕引擎（假的）坚称 done、还给了计数。
  const { repo } = makeRepo('fakerun', { mode: 'done', preInit: true })
  const emptyDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-native-emptydocs-'))
  madeDirs.push(emptyDocs)
  const res = await runNativeJob({
    repoRoot: repo,
    scope: 'full',
    docsDir: emptyDocs,
    deps: {
      runEngine: async ({ action }) => (action === 'doctor'
        ? { outcome: 'done', stage: 'env', engine: { version: '9.9.9', python: '3.13.0', deps: { ok: true, summary: 'ok' } } }
        : {
          outcome: 'done',
          stage: 'articles',
          writtenCount: 2,
          failedCount: 0,
          engine: { version: '9.9.9', python: '3.13.0', deps: { ok: true, summary: 'ok' } },
          artifacts: { docsDir: emptyDocs, rawTreeDir: '', updateRecord: '' },
        }),
      config: { batchProvider: 'workbuddy', batchModel: 'hy3' },
      llm: fakeLlm,
    },
  })
  check(res.outcome === 'failed', `终态 failed（实际 ${res.outcome}）`)
  check(res.gate?.outcome === 'failed', `真质量门判 failed（实际 ${res.gate?.outcome}）`)
  check(res.apply == null || res.apply.outcome === 'failed', '落地器没有把空产物写进仓库')
  check(res.canAdvanceBaseline === false, 'canAdvanceBaseline=false')
  check(!exists(path.join(repo, '.codewiki', 'modules', 'core.md')), '空产物没有被写成文章（preInit 仓库本就有入口页，判据看文章）')
}

// ============================ 用例 16：裁决链短路分支 ============================
console.log('== 用例 16：假 runEngine 的 cancelled / failed 分支短路，不进 gate/apply ==')
{
  const { repo } = makeRepo('shortcircuit', { mode: 'done', preInit: true })
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-native-sc-'))
  madeDirs.push(docs)
  const base = {
    repoRoot: repo,
    scope: 'full',
    docsDir: docs,
    deps: { config: { batchProvider: 'workbuddy', batchModel: 'hy3' }, llm: fakeLlm },
  }
  // ① 引擎 cancelled
  const rc = await runNativeJob({
    ...base,
    deps: {
      ...base.deps,
      runEngine: async ({ action }) => (action === 'doctor'
        ? { outcome: 'done', stage: 'env', engine: { version: '9.9.9', python: '3.13.0', deps: { ok: true, summary: 'ok' } } }
        : { outcome: 'cancelled', stage: 'articles', writtenCount: 1, blockers: [{ kind: 'cancelled', detail: '引擎侧取消' }] }),
    },
  })
  check(rc.outcome === 'cancelled', `引擎取消 → 终态 cancelled（实际 ${rc.outcome}）`)
  check(rc.gate == null && rc.apply == null, '取消后不跑 gate/apply')

  // ② 引擎 failed
  const rf = await runNativeJob({
    ...base,
    deps: {
      ...base.deps,
      runEngine: async ({ action }) => (action === 'doctor'
        ? { outcome: 'done', stage: 'env', engine: { version: '9.9.9', python: '3.13.0', deps: { ok: true, summary: 'ok' } } }
        : { outcome: 'failed', stage: 'graph', error: { code: 'engine-crashed', message: '依赖图炸了' } }),
    },
  })
  check(rf.outcome === 'failed', `引擎失败 → 终态 failed（实际 ${rf.outcome}）`)
  check(/依赖图炸了/.test(String(rf.error?.message ?? '')), '引擎错误信息原样带出（不被兜底文案洗掉）')

  // ③ 提交前已取消
  const ac = new AbortController()
  ac.abort()
  const rp = await runNativeJob({ ...base, signal: ac.signal, deps: { ...base.deps, runEngine: async () => { throw new Error('不该被调用') } } })
  check(rp.outcome === 'cancelled', `提交前已 abort → cancelled（实际 ${rp.outcome}）`)
}

// ============================ 收尾 ============================
for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* Windows 上被占用的临时目录留给系统清理 */ } }
try { fs.rmSync(JOBS_FILE, { force: true }) } catch { /* ignore */ }

console.log(`\n== 结果：${checks - failures}/${checks} 通过，${failures} 失败 ==`)
if (failures > 0) process.exit(1)
console.log('原生引擎生产接线测试全部通过')
