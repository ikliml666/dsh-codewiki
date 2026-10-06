// test-orchestration.mjs — dsh-codewiki 服务化编排冒烟：
// mock 百炼批量 API（按上传 JSONL 的任务类型应答）+ 真实 cw CLI + 真实服务 tick，
// 验证 codewiki_generate 提交制 + 服务阶段机（plan→articles→crosscut→review→index）、
// stale 逐篇更新、孤儿断点续查、面板端点（jobs/control）与取消、无凭证诚实报错。
// 运行：node test-orchestration.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 测试加速：tick 间隔压到下限（生产默认 10s）
process.env.DSH_CODEWIKI_TICK_MS = '300'

const here = path.dirname(fileURLToPath(import.meta.url))
const { name, apply } = await import('./index.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

const JOBS_FILE = path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')
const articleMd = (title, source, marker = 'Batch-written', type = 'module') =>
  `---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\n${marker} article.\n`

// mock 宿主上下文：按 inject 依赖路由；webServer/credentials/tools/agents 全部可捕获。
// inject 同时支持 cordis 两种风格：带回调（apply 注册）与 promise（await ctx.inject([...])）
function makeCtx({ apiKey = 'sk-cred-test', agents = [] } = {}) {
  const registered = new Map()
  const endpoints = []
  const listeners = []
  const services = {
    webServer: { register(def) { endpoints.push(def) } },
    credentials: { resolve: async (ref) => ref === 'ALIYUN_BAILIAN_API_KEY' && apiKey ? { value: apiKey, source: 'file' } : undefined },
    agents: { list: () => agents },
    tools: { register(def) { registered.set(def.name, def); return () => {} } },
  }
  const ctx = {
    inject(deps, fn) {
      const got = deps.map((d) => services[d])
      if (typeof fn === 'function') return fn(...got)
      return Promise.resolve(got.length === 1 ? got[0] : got)
    },
    on(event, fn) { listeners.push([event, fn]) },
  }
  return { ctx, registered, endpoints, listeners }
}

// 真实 cordis 语义 mock：agent.ctx 用于 systemPrompt section 注册
function makeMockAgent(cwd) {
  const sections = []
  const agent = {
    session: { header: { cwd } },
    ctx: {
      inject: (deps, fn) => fn({
        systemPrompt: {
          getSectionOrder: (n) => ({ TOOL_REPORT: 2900 }[n] ?? 0),
          section: (s) => { sections.push(s); return () => {} },
        },
      }),
    },
  }
  return { agent, sections }
}

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-orch-'))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'core.py'), 'def run():\n    return "core"\n')
  fs.writeFileSync(path.join(dir, 'src', 'util.py'), 'def fmt():\n    return "util"\n')
  const git = (...a) => execFileSync('git', a, { cwd: dir })
  git('init')
  git('add', '.')
  git('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'init')
  return dir
}

// mock 百炼批量 API：按上传 JSONL 的 custom_id 生成应答（plan/tN/arch/patterns/conceptN/proofN）
function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false } = {}) {
  const uploaded = []
  let batchSeq = 0
  const originalFetch = globalThis.fetch
  const fetchCalls = []
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200 })
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetchCalls.push(u)
    if (u.endsWith('/files') && init.method === 'POST') {
      const text = await init.body.get('file').text()
      uploaded.push(text.trim().split('\n').map((l) => JSON.parse(l)))
      return json({ id: `file-${batchSeq + 1}` })
    }
    if (u.endsWith('/batches') && init.method === 'POST') {
      batchSeq += 1
      return json({ id: `batch-${batchSeq}`, status: 'validating' })
    }
    const bm = u.match(/\/batches\/(batch-\d+)$/)
    if (bm) {
      if (stall) return json({ id: bm[1], status: 'in_progress' })
      return json({ id: bm[1], status: 'completed', output_file_id: `out-${bm[1]}`, error_file_id: `err-${bm[1]}` })
    }
    const om = u.match(/\/files\/out-(batch-\d+)\/content$/)
    if (om) {
      const lines = uploaded[Number(om[1].split('-')[1]) - 1] ?? []
      const out = lines.map((line) => {
        const cid = line.custom_id
        let content
        if (cid === 'plan') {
          content = JSON.stringify({
            project: 'fixture',
            modules: modules.map((mn) => ({ name: mn, summary: `${mn} summary`, files: [`src/${mn}.py`] })),
            concepts: [{ name: 'config-load', files: [`src/${modules[0]}.py`] }],
          })
        } else if (/^t\d+$/.test(cid)) {
          const mn = modules[Number(cid.slice(1))] ?? modules[0]
          content = articleMd(mn, `src/${mn}.py`, articleMarker)
        } else if (cid === 'arch') {
          content = articleMd('Architecture', `src/${modules[0]}.py`, articleMarker, 'architecture')
        } else if (cid === 'patterns') {
          content = articleMd('Patterns', `src/${modules[1] ?? modules[0]}.py`, articleMarker, 'pattern')
        } else if (cid.startsWith('concept')) {
          content = articleMd('config-load', `src/${modules[0]}.py`, articleMarker, 'concept')
        } else if (cid.startsWith('proof')) {
          // 校对应保留原文章 frontmatter（真实模型被要求原样输出）；从请求嵌入的文章里提取
          const fm = String(line?.body?.messages?.[0]?.content ?? '').match(/---\ntitle:[\s\S]*?\n---/)
          content = fm ? `${fm[0]}\n\nPROOFED article.\n` : articleMd('Proofed', `src/${modules[0]}.py`, 'PROOFED')
        } else {
          content = '---\ntitle: unknown\n---\nunknown task'
        }
        return JSON.stringify({ custom_id: cid, response: { status_code: 200, body: { choices: [{ message: { content } }] } } })
      }).join('\n') + '\n'
      return new Response(out, { status: 200 })
    }
    if (u.includes('/files/err-')) return new Response('', { status: 200 })
    return new Response('{}', { status: 404 })
  }
  return { fetchCalls, restore: () => { globalThis.fetch = originalFetch } }
}

// 轮询 JOBS_FILE 等某 cwd 的最新 job 终态
async function waitJob(cwd, { timeout = 30000 } = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/')
  const start = Date.now()
  for (;;) {
    let job = null
    try {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
      job = (data.jobs ?? []).filter((x) => norm(x.cwd) === norm(cwd)).pop() ?? null
    } catch { /* 文件尚未落盘 */ }
    if (job && ['done', 'failed', 'cancelled'].includes(job.stage)) return job
    if (Date.now() - start > timeout) return job
    await new Promise((r) => setTimeout(r, 150))
  }
}

function fakeReq(body, addr = '127.0.0.1', method = 'POST') {
  return {
    method,
    socket: { remoteAddress: addr },
    on(ev, fn) {
      if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') fn()
    },
  }
}
function fakeRes() {
  return { code: 0, out: '', writeHead(c) { this.code = c }, end(b) { this.out = String(b ?? '') } }
}

// ============================ 系统提示提醒 ============================
console.log('== 系统提示 wiki 维护提醒 ==')
{
  const repoWith = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-remind-'))
  const repoWithout = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-remind-'))
  fs.mkdirSync(path.join(repoWith, '.codewiki'))
  const a1 = makeMockAgent(repoWith)
  const a2 = makeMockAgent(repoWithout)
  const reminderConfig = {}
  const { ctx, listeners } = makeCtx({ agents: [a1.agent, a2.agent] })
  apply(ctx, reminderConfig)
  check(listeners.some(([e]) => e === 'agent/created'), 'agent/created 监听已布线')
  for (const [, fn] of listeners) { await fn({ agent: a1.agent }); await fn({ agent: a2.agent }) }
  const sec = (a1.sections ?? [])[0]
  check(sec?.name === 'codewiki:update-reminder', `section 名 codewiki:update-reminder（实际 ${sec?.name}）`)
  check(typeof sec?.text === 'function' && sec.text().includes('codewiki_generate'), '有 .codewiki 的会话提醒文本非空且指向 codewiki_generate')
  check(typeof a2.sections[0]?.text === 'function' && a2.sections[0].text() === '', '无 .codewiki 的会话提醒文本为空（不注入噪音）')
  reminderConfig.updateReminder = false
  check(sec.text() === '', 'updateReminder=false 后提醒文本为空（运行时开关生效）')
  fs.rmSync(repoWith, { recursive: true, force: true })
  fs.rmSync(repoWithout, { recursive: true, force: true })
}

// ============================ 注册与 cw 工具 ============================
console.log('== 注册 ==')
const mainRepo = makeFixtureRepo()
const main = makeCtx()
apply(main.ctx, {})
check(name === 'dsh-codewiki', `插件名 ${name}`)
check(main.registered.get('cw') && main.registered.get('codewiki_generate'), 'cw 与 codewiki_generate 两个工具均已注册')
const gen = main.registered.get('codewiki_generate')
const cwTool = main.registered.get('cw')

console.log('== cw 工具 ==')
{
  const st = await cwTool.execute({ cwd: mainRepo, args: ['status'] })
  check(st.exitCode === 0 && /No wiki found/i.test(st.stdout), 'cw status 判定 missing 态')
}

// ============================ 全量编译（服务阶段机） ============================
console.log('== codewiki_generate 全量编译：提交即返回，服务推进阶段机 ==')
{
  const mock = makeBatchMock()
  try {
    const r1 = await gen.execute({ cwd: mainRepo }, { agent: 'test-agent' })
    console.log('  notes:', r1.notes.join(' | '))
    check(r1.submitted === true && typeof r1.jobId === 'string', '提交即返回（jobId 非空）')
    check(r1.stage === 'plan', `初始 stage=plan（实际 ${r1.stage}）`)
    check(r1.writtenCount === undefined, '返回值不含 writtenCount（编译交服务，不再就地等待）')
    const job = await waitJob(r1.cwd)
    check(mock.fetchCalls.some((u) => u.endsWith('/files')) && mock.fetchCalls.some((u) => u.endsWith('/batches')), '规划批次已上传百炼')
    check(job?.stage === 'done', `服务 job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(job?.writtenCount >= 5 && job?.failedCount === 0, `编译完成 ${job?.writtenCount} 篇、失败 ${job?.failedCount} 篇（2 模块+架构+模式+概念）`)
    const w = job.wikiPath
    check(fs.existsSync(path.join(w, 'modules', 'core.md')), 'modules/core.md 落盘')
    check(fs.existsSync(path.join(w, 'modules', 'util.md')), 'modules/util.md 落盘')
    check(fs.existsSync(path.join(w, '_architecture.md')), '_architecture.md 落盘')
    check(fs.existsSync(path.join(w, '_patterns.md')), '_patterns.md 落盘')
    check(fs.existsSync(path.join(w, 'concepts', 'config-load.md')), 'concepts/config-load.md 落盘')
    check(fs.readFileSync(path.join(w, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '校对批次已回写模块文章（review 阶段端到端）')
    check((job.notes ?? []).some((n) => n.includes('cw index')), '收尾 cw index/meta update 已执行')
    check(!(job.notes ?? []).some((n) => n.includes('子代理')), '全程零子代理（notes 无子代理字样）')
  } finally {
    mock.restore()
  }
}

// ============================ stale 逐篇更新 ============================
console.log('== codewiki_generate stale 逐篇更新（预构建任务直达 articles 阶段） ==')
{
  fs.writeFileSync(path.join(mainRepo, 'src', 'core.py'), 'def run():\n    return "core-v2"\n')
  execFileSync('git', ['add', '-A'], { cwd: mainRepo })
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'v2'], { cwd: mainRepo })
  const mock = makeBatchMock({ articleMarker: 'Stale-batch' })
  try {
    const r2 = await gen.execute({ cwd: mainRepo, scope: 'stale' }, { agent: 'test-agent' })
    console.log('  notes:', r2.notes.join(' | '))
    check(r2.submitted === true && r2.stage === 'articles', 'stale 提交直达 articles 阶段')
    const job = await waitJob(r2.cwd)
    check(job?.stage === 'done' && job?.kind === 'stale', `stale job 终态 done（kind=${job?.kind}，error ${job?.error ?? '-'}）`)
    // core.py 变更 → 声明它的文章过期：modules/core.md、_architecture.md、concepts/config-load.md
    check(job?.writtenCount === 3, `恰好更新声明了 core.py 的 3 篇（实际 ${job?.writtenCount}）`)
    const w = job.wikiPath
    check(fs.readFileSync(path.join(w, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '过期文章经批次重写并校对回写')
    check(!fs.readFileSync(path.join(w, 'modules', 'util.md'), 'utf8').includes('Stale-batch'), '未变更文章不动（util.md 保持全量版内容）')
  } finally {
    mock.restore()
  }
}

// ============================ 孤儿断点续查 ============================
console.log('== codewiki_generate 孤儿断点续查（0.3.x 遗留 checkpoint 自动并入） ==')
{
  const orphanPath = path.join(mainRepo, '.codewiki', 'modules', 'orphan.md')
  fs.mkdirSync(path.dirname(orphanPath), { recursive: true })
  const h = crypto.createHash('sha1').update(mainRepo).digest('hex').slice(0, 12)
  const checkpoint = path.join(os.tmpdir(), `dsh-codewiki-batch-${h}.json`)
  fs.writeFileSync(checkpoint, JSON.stringify({
    batchId: 'batch-orphan-1',
    model: 'qwen3.7-flash',
    tasks: [{ customId: 't0', name: 'modules/orphan.md', articlePath: orphanPath, keepInMemory: false }],
  }), 'utf8')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/batches/batch-orphan-1')) return new Response(JSON.stringify({ id: 'batch-orphan-1', status: 'completed', output_file_id: 'out-orphan' }), { status: 200 })
    if (u.includes('out-orphan')) {
      return new Response(JSON.stringify({ custom_id: 't0', response: { status_code: 200, body: { choices: [{ message: { content: articleMd('orphan', 'src/core.py', 'Orphan-resumed') } }] } } }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const r3 = await gen.execute({ cwd: mainRepo }, { agent: 'test-agent' })
    console.log('  notes:', r3.notes.join(' | '))
    check(r3.submitted === true && (r3.notes ?? []).some((n) => n.includes('batch-orphan-1')), '发现孤儿断点并入续查任务')
    const job = await waitJob(r3.cwd)
    check(job?.stage === 'done' && job?.kind === 'resume', `resume job 终态 done（kind=${job?.kind}）`)
    check(fs.readFileSync(orphanPath, 'utf8').includes('Orphan-resumed'), '孤儿批次文章已收尾落盘')
    check(!fs.existsSync(checkpoint), '续查收尾后断点文件删除')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ============================ 面板端点与取消 ============================
console.log('== 面板端点：GET /api/codewiki/jobs、POST /api/codewiki/control（loopback 守卫 + 取消） ==')
{
  const cancelRepo = makeFixtureRepo()
  const mock = makeBatchMock({ stall: true }) // 批次永远 in_progress，job 停在 plan 阶段
  try {
    const r4 = await gen.execute({ cwd: cancelRepo }, { agent: 'test-agent' })
    check(r4.submitted === true, '提交了一个将被取消的任务')
    const jobsEp = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    const ctlEp = main.endpoints.find((e) => e.path === '/api/codewiki/control')
    check(jobsEp && ctlEp, '两个端点均已注册')
    const res403 = fakeRes()
    jobsEp.handler(fakeReq(undefined, '10.1.2.3'), res403)
    check(res403.code === 403, '非回环地址 403')
    const resJobs = fakeRes()
    jobsEp.handler(fakeReq(), resJobs)
    const jobsPayload = JSON.parse(resJobs.out)
    check(Array.isArray(jobsPayload.jobs) && jobsPayload.jobs.some((j) => j.id === r4.jobId), 'jobs 列表包含活动任务')
    check(jobsPayload.jobs.every((j) => !('apiKey' in j)), 'jobs 列表不泄漏 apiKey')
    const resCancel = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'cancel', jobId: r4.jobId }), resCancel)
    check(resCancel.code === 200 && JSON.parse(resCancel.out).ok === true, '取消请求被接受')
    const job = await waitJob(cancelRepo)
    check(job?.stage === 'cancelled', `job 终态 cancelled（实际 ${job?.stage}）`)
    check((job?.notes ?? []).some((n) => n.includes('断点保留')), '取消保留批次断点（可续查）')
    const res404 = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'cancel', jobId: 'job-none' }), res404)
    check(res404.code === 404, '取消未知 jobId 404')
  } finally {
    mock.restore()
    fs.rmSync(cancelRepo, { recursive: true, force: true })
  }
}

// ============================ 无凭证诚实报错 ============================
console.log('== 无凭证：诚实报错（没有子代理回退） ==')
{
  const noCredRepo = makeFixtureRepo()
  const noCred = makeCtx({ apiKey: '' })
  apply(noCred.ctx, {})
  let err = null
  try { await noCred.registered.get('codewiki_generate').execute({ cwd: noCredRepo }, { agent: 'test-agent' }) } catch (e) { err = e }
  check(err && String(err.message).includes('未找到百炼 API Key'), `执行报错指向凭证（实际 ${err?.message?.slice(0, 40)}…）`)
  fs.rmSync(noCredRepo, { recursive: true, force: true })
}

// ============================ 严格 cordis 语义 ============================
console.log('== 严格 cordis 语义：未 inject 的服务属性访问即抛 ==')
{
  const strictRegistered = new Map()
  const strictListeners = []
  const strictCtx = {
    inject: (deps, fn) => {
      if (deps.includes('tools')) return fn({ tools: { register(def) { strictRegistered.set(def.name, def); return () => {} } } })
      if (deps.includes('agents')) return fn({ agents: { list: () => [] } })
      return fn({})
    },
    on: (event, fn) => { if (event === 'agent/created') strictListeners.push(fn) },
  }
  // 真实 cordis 抛错点在插件自身的 ctx（apply 收到的对象）
  Object.defineProperty(strictCtx, 'agents', {
    get() { throw new Error('cannot get property "agents" without inject') },
  })
  let applyThrew = null
  try { apply(strictCtx, {}) } catch (e) { applyThrew = e }
  check(applyThrew === null, `apply 在严格 cordis 语义下不抛错（实际 ${applyThrew?.message ?? applyThrew}）`)
  check(strictRegistered.get('cw') && strictRegistered.get('codewiki_generate'), '严格语义下两工具仍注册（fiber 不回滚）')
  check(strictListeners.length === 1, 'agent/created 监听已布线')
}

// 清理主 fixture（wiki 在仓库内 .codewiki/，随目录一起删）
fs.rmSync(mainRepo, { recursive: true, force: true })

console.log(failures ? `\nFAIL：${failures} 项未通过` : '\nPASS：编排冒烟全部通过')
process.exit(failures ? 1 : 0)
