// test-orchestration.mjs — dsh-codewiki 服务化编排冒烟：
// mock 百炼批量对话 API（Batch Chat 同步端点，按 prompt 特征应答）+ 真实 cw CLI + 真实服务 tick，
// 验证 codewiki_generate 提交制 + 服务阶段机（plan→articles→crosscut→review→index）、
// stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control）与取消、无凭证诚实报错。
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
// 独立 JOBS_FILE：与真实宿主服务实例（同机共享默认路径）隔离，避免互相洗写
process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `dsh-codewiki-jobs-test-${process.pid}.json`)
const { name, apply } = await import('./index.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE
const articleMd = (title, source, marker = 'Batch-written', type = 'module') =>
  `---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\n${marker} article.\n`

// mock 宿主上下文：按 inject 依赖路由；webServer/credentials/tools/agents 全部可捕获。
// inject 同时支持 cordis 两种风格：带回调（apply 注册）与 promise（await ctx.inject([...])）
function makeCtx({ apiKey = 'sk-cred-test', agents = [], slowCreds = false, workspaces = null, brokenRegistry = false } = {}) {
  const registered = new Map()
  const endpoints = []
  const listeners = []
  const disposers = []
  const services = {
    webServer: { register(def) { endpoints.push(def) } },
    credentials: {
      resolve: async (ref) => {
        if (slowCreds) await new Promise((r) => setTimeout(r, 50)) // 拉长 submit 的凭证窗口，测并发占位
        return ref === 'ALIYUN_BAILIAN_API_KEY' && apiKey ? { value: apiKey, source: 'file' } : undefined
      },
    },
    agents: { list: () => agents },
    tools: { register(def) { registered.set(def.name, def); return () => {} } },
  }
  if (workspaces !== null) {
    services.workspaceRegistry = { list: () => workspaces.map((p) => ({ path: p })) }
  } else if (brokenRegistry) {
    // 宿主注册表内部不一致形态：list() 抛（0.4.9c 真宿主 jobs/repos 400 的候选根因）
    services.workspaceRegistry = { list: () => { throw new Error("workspace registry order references missing workspace 'w-broken'") } }
  }
  const ctx = {
    inject(deps, fn) {
      // 宿主同构：带回调传「ctx 切片」（服务在切片同名属性上）——0.4.10 教训：直传实例
      // 会掩盖 cordis 严格语义（切片当实例用，属性访问才抛 without inject）。
      if (typeof fn === 'function') {
        const slice = {}
        for (const d of deps) slice[d] = services[d]
        return fn(slice)
      }
      const got = deps.map((d) => services[d])
      return Promise.resolve(got.length === 1 ? got[0] : got)
    },
    on(event, fn) { listeners.push([event, fn]) },
    // cordis 真实语义：立即执行 body，返回函数则收集为 disposer。
    // 防线：若回归「ctx.effect(() => service.stop())」错写法，stop 被当场调用、
    // tick 停摆，waitJob 挂死超时——整套编排测试直接失败。
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
  }
  return { ctx, registered, endpoints, listeners, disposers }
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

// mock 百炼批量对话 API（0.5.0 Batch Chat）：全部环节都是单轮 chat/completions——
// 批量通道打 batch.dashscope（同步排队，每请求一问一答），实时兜底打 dashscope.aliyuncs.com。
// 按 prompt 首行特征分发应答（与真实 prompt 模板的区分句一一对应）。
function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false } = {}) {
  const originalFetch = globalThis.fetch
  const fetchCalls = []
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200 })
  const answerFor = (prompt) => {
    if (prompt.includes('你是代码结构勘探员')) {
      return JSON.stringify({
        project: 'fixture',
        modules: modules.map((mn) => ({ name: mn, summary: `${mn} summary`, files: [`src/${mn}.py`] })),
        concepts: [{ name: 'config-load', files: [`src/${modules[0]}.py`] }],
      })
    }
    if (prompt.includes('你是 CodeWiki 文章作者')) {
      const mn = (prompt.match(/modules\/([a-z0-9-]+)\.md/) ?? [])[1] ?? modules[0]
      return articleMd(mn, `src/${mn}.py`, articleMarker)
    }
    if (prompt.includes('你是 CodeWiki 架构观察员')) {
      return '模块观察：职责一句话。\n\nsource_files:\n  - src/core.py\n'
    }
    if (prompt.includes('写系统总览')) return articleMd('Architecture', `src/${modules[0]}.py`, articleMarker, 'architecture')
    if (prompt.includes('总结仓库反复出现的模式')) return articleMd('Patterns', `src/${modules[1] ?? modules[0]}.py`, articleMarker, 'pattern')
    if (prompt.includes('写跨模块概念')) return articleMd('config-load', `src/${modules[0]}.py`, articleMarker, 'concept')
    if (prompt.includes('你是 CodeWiki 审校员')) {
      const fm = prompt.match(/---\ntitle:[\s\S]*?\n---/)
      return fm ? `${fm[0]}\n\nPROOFED article.\n` : articleMd('Proofed', `src/${modules[0]}.py`, 'PROOFED')
    }
    return '---\ntitle: unknown\n---\nunknown task'
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(init.body) : {}
    const prompt = String(body?.messages?.[0]?.content ?? '')
    fetchCalls.push({ url: u, prompt })
    if (!u.includes('/chat/completions')) return new Response('{}', { status: 404 })
    if (stall) {
      // 服务端排队不返回（Batch Chat 最长保持 1h）：挂起直到客户端断开（signal abort）
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('client aborted')), { once: true })
        init.signal?.addEventListener('abort', () => {}, { once: true })
      })
    }
    let content = answerFor(prompt)
    if (bigArticle && prompt.includes('你是 CodeWiki 文章作者')) content += `\n\n${'长'.repeat(30000)}`
    return json({ choices: [{ message: { content } }], usage: { output_tokens: 128 } })
  }
  const BATCH_URL = 'https://batch.dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  return {
    fetchCalls,
    batchPrompts: () => fetchCalls.filter((c) => c.url === BATCH_URL).map((c) => c.prompt),
    realtimePrompts: () => fetchCalls.filter((c) => c.url.includes('/chat/completions') && !c.url.startsWith('https://batch.')).map((c) => c.prompt),
    restore: () => { globalThis.fetch = originalFetch },
  }
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
  fs.writeFileSync(path.join(repoWith, 'CodeWiki.md'), '# CodeWiki\n') // 守护要求仓库根存在 CodeWiki.md
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
  // 守护收紧（139052c）：.codewiki 存在但仓库根无 CodeWiki.md 同样不注入
  const repoMdMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-remind-'))
  fs.mkdirSync(path.join(repoMdMissing, '.codewiki'))
  const a3 = makeMockAgent(repoMdMissing)
  for (const [, fn] of listeners) await fn({ agent: a3.agent })
  check((a3.sections[0]?.text?.() ?? 'x') === '', '有 .codewiki 但根无 CodeWiki.md 的会话提醒为空（守护收紧）')
  fs.rmSync(repoMdMissing, { recursive: true, force: true })
  reminderConfig.updateReminder = false
  check(sec.text() === '', 'updateReminder=false 后提醒文本为空（运行时开关生效）')
  fs.rmSync(repoWith, { recursive: true, force: true })
  fs.rmSync(repoWithout, { recursive: true, force: true })
}

// ============================ 注册与 cw 工具 ============================
console.log('== 注册 ==')
const mainRepo = makeFixtureRepo()
const main = makeCtx()
const mainConfig = {}
apply(main.ctx, mainConfig)
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
    check(mock.batchPrompts().some((p) => p.includes('勘探员')), '规划请求已走批量对话端点')
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

// ============================ 大 wiki：横切精准拆分 ============================
console.log('== 横切精准拆分：模块文章总量超预算 → 观察任务 map + 合成批 reduce ==')
{
  const bigRepo = makeFixtureRepo()
  const mock = makeBatchMock({ bigArticle: true })
  mainConfig.batchMinTokens = 30000 // 混合模式：文章/横切/校对 pack 超阈值，仍应走批量
  try {
    const r = await gen.execute({ cwd: bigRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '大 wiki 提交即返回')
    const job = await waitJob(r.cwd)
    console.log('  notes:', (job?.notes ?? []).join(' | '))
    const obsPrompts = mock.batchPrompts().filter((p) => p.includes('架构观察员'))
    check(obsPrompts.length === 2, `批量端点收到 2 个观察请求（实际 ${obsPrompts.length}）`)
    check(mock.realtimePrompts().some((p) => p.includes('勘探员')) && !mock.batchPrompts().some((p) => p.includes('勘探员')), '混合模式：小 plan 走实时（批量端点无 plan）')
    for (const p of obsPrompts) {
      check((p.match(/^### /gm) ?? []).length === 1, '观察请求输入只含一篇模块文章')
    }
    check(!mock.batchPrompts().some((p) => p.includes('写系统总览') && p.includes('长'.repeat(100))), '合成请求输入不含原文全文（只吃观察）')
    check(job?.stage === 'done', `服务 job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(fs.existsSync(path.join(job.wikiPath, '_architecture.md')), '_architecture.md 经合成批落盘')
    check(fs.existsSync(path.join(job.wikiPath, '_patterns.md')), '_patterns.md 经合成批落盘')
    check(fs.readFileSync(path.join(job.wikiPath, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '大 wiki 校对批次照常回写（动态预算）')
    check((job.notes ?? []).some((n) => n.includes('观察任务并发执行')), 'notes 记录拆分决策')
    check((job.notes ?? []).some((n) => n.includes('3 倍价')), '单篇 30k 超大档触发 3 倍价明示')
    check((job.notes ?? []).some((n) => n.includes('提交横切合成批次')), '观察批 settle 后进入合成批')
  } finally {
    delete mainConfig.batchMinTokens
    mock.restore()
    fs.rmSync(bigRepo, { recursive: true, force: true })
  }
}

// ============================ 阶段实时阈值（混合通道全实时） ============================
console.log('== batchMinTokens 混合：小仓库各阶段输入均低于阈值 → 全程实时、零批量 ==')
{
  const smallRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  mainConfig.batchMinTokens = 30000
  try {
    const r = await gen.execute({ cwd: smallRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '混合模式提交即返回')
    const job = await waitJob(r.cwd)
    console.log('  notes:', (job?.notes ?? []).join(' | '))
    check(job?.stage === 'done', `job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(job?.writtenCount >= 5 && job?.failedCount === 0, `实时通道编译 ${job?.writtenCount} 篇、失败 ${job?.failedCount} 篇`)
    check(mock.fetchCalls.every((c) => !String(c.url).startsWith('https://batch.')), '全程零批量端点（各阶段都走实时）')
    check(mock.realtimePrompts().length > 0, '实时 chat/completions 已调用')
    check((job.notes ?? []).some((n) => n.includes('走实时推理')), 'notes 记录实时分流决策')
    const jobsEp = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    const resJobs = fakeRes()
    jobsEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resJobs)
    const summary = JSON.parse(resJobs.out).jobs.find((j) => j.id === r.jobId)
    console.log('  DEBUG summary:', JSON.stringify(summary))
    const dbg = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    check(summary?.tps > 0, `实时通道 tps 采样聚合（summary.tps=${summary?.tps}）`)
    check(typeof summary?.stageStartedAt === 'string' && !!summary?.stageTimings
      && Object.keys(summary.stageTimings).length >= 1, 'summary 带阶段起始时刻与各阶段耗时')
    check(!!summary?.usage && summary.usage.outputTok > 0 && summary.usage.realtimeRequests > 0,
      `usage 输出实测/请求数累计（${JSON.stringify(summary?.usage)}）`)
    check(fs.existsSync(path.join(job.wikiPath, 'modules', 'core.md')), 'core.md 实时落盘')
    check(fs.existsSync(path.join(job.wikiPath, '_architecture.md')), '_architecture.md 实时落盘（keepInMemory 经 writeValidated）')
    check(fs.readFileSync(path.join(job.wikiPath, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '校对实时回写')
  } finally {
    delete mainConfig.batchMinTokens
    mock.restore()
    fs.rmSync(smallRepo, { recursive: true, force: true })
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

// ============================ 宿主重启重跑（Batch Chat 恢复路径） ============================
console.log('== 0.5.0：宿主重启后批量/实时任务按持久化 prompt 快照重跑 ==')
{
  // 场景 A：批量对话任务（batchchat-*）停在 articles，执行器随进程丢失
  const repoA = makeFixtureRepo()
  const mock = makeBatchMock({ articleMarker: 'Restarted-batch' })
  const staleAt = new Date(Date.now() - 6 * 60000).toISOString()
  const articlePath = path.join(repoA, '.codewiki', 'modules', 'core.md')
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [{
    id: 'job-restart-batch', cwd: repoA, kind: 'full', scope: 'full', language: 'zh',
    stage: 'articles', owner: 'svc-dead-instance', wikiPath: path.join(repoA, '.codewiki'),
    plan: { project: 'fixture', modules: [{ name: 'core', summary: 'core summary', files: ['src/core.py'] }], concepts: [] },
    batchRef: { batchId: 'batchchat-job-restart-batch' },
    tasks: [{ customId: 't0', name: 'modules/core.md', articlePath, keepInMemory: false,
      batchPrompt: '你是 CodeWiki 文章作者。目标：为模块「core」撰写文章 modules/core.md（重启恢复快照）' }],
    articles: [], writtenCount: 0, failedCount: 0, notes: [],
    createdAt: staleAt, updatedAt: staleAt,
  }] }), 'utf8')
  try {
    const wx = makeCtx({})
    apply(wx.ctx, {})
    const job = await waitJob(repoA)
    check(job?.stage === 'done', `批量任务重启后重跑至终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(mock.batchPrompts().some((p) => p.includes('modules/core.md')), '重跑请求走批量对话端点')
    check(fs.readFileSync(articlePath, 'utf8').includes('PROOFED'), '重跑文章落盘并经校对回写（restart 版为校对输入）')
    check((job.notes ?? []).some((n) => n.includes('自动重跑阶段')), 'notes 记录重跑决策')
  } finally {
    mock.restore()
    fs.rmSync(repoA, { recursive: true, force: true })
  }

  // 场景 B：就地实时任务（batchId=local）结果随进程丢失，同样按快照重跑（统一走批量端点）
  const repoB = makeFixtureRepo()
  const mockB = makeBatchMock()
  const staleAtB = new Date(Date.now() - 6 * 60000).toISOString()
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [{
    id: 'job-restart-local', cwd: repoB, kind: 'full', scope: 'full', language: 'zh',
    stage: 'plan', owner: 'svc-dead-instance-2', wikiPath: path.join(repoB, '.codewiki'),
    batchRef: { batchId: 'local' },
    tasks: [{ customId: 'plan', name: '_plan', keepInMemory: true,
      batchPrompt: '你是代码结构勘探员（重启恢复快照）' }],
    articles: [], writtenCount: 0, failedCount: 0, notes: [],
    createdAt: staleAtB, updatedAt: staleAtB,
  }] }), 'utf8')
  try {
    const wx = makeCtx({})
    apply(wx.ctx, {})
    const job = await waitJob(repoB)
    check(job?.stage === 'done', `实时任务重启后重跑至终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(mockB.batchPrompts().some((p) => p.includes('勘探员')), 'local 任务重跑统一走批量对话端点')
  } finally {
    mockB.restore()
    fs.rmSync(repoB, { recursive: true, force: true })
  }
  try { fs.unlinkSync(JOBS_FILE) } catch { /* 测试清理 */ }
}

// ============================ 并发提交占位 + 多实例合并 ============================
console.log('== 并发提交占位（凭证窗口）与 flush 磁盘合并 ==')
{
  // 预置「另一实例」的 job：flush 合并后不得丢失
  const externalJob = {
    id: 'job-external-1', cwd: 'C:/other-repo', kind: 'full', scope: 'full', stage: 'articles',
    plan: null, batchRef: null, tasks: [], articles: [], writtenCount: 0, failedCount: 0, notes: [],
    createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date(Date.now() - 60000).toISOString(),
  }
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [externalJob] }), 'utf8')

  const concRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-conc-'))
  fs.writeFileSync(path.join(concRepo, 'app.py'), 'print(1)\n', 'utf8')
  const gitc = (...a) => execFileSync('git', a, { cwd: concRepo })
  gitc('init'); gitc('add', '.'); gitc('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'init')
  const cc = makeCtx({ slowCreds: true })
  apply(cc.ctx, {})
  const gen2 = cc.registered.get('codewiki_generate')
  // 提交在占位窗口后走真实 submitBatchFor——mock 掉批量 API，让它快速失败即可
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'mock off' } }), { status: 500 })
  // 先串行走一次（cw init 建好 wiki 基线，提交因 mock 500 快速失败），
  // 避免并发对撞在 cw init 的 TOCTOU 上——本块只验证 submit 占位窗口
  try { await gen2.execute({ cwd: concRepo, scope: 'full' }, { agent: 'test-agent' }) } catch { /* mock 500 预期失败 */ }
  try {
    const [ra, rb] = await Promise.all([
      gen2.execute({ cwd: concRepo, scope: 'full' }, { agent: 'test-agent' }),
      gen2.execute({ cwd: concRepo, scope: 'full' }, { agent: 'test-agent' }),
    ])
    check(ra.jobId && ra.jobId === rb.jobId, `并发提交共享同一 job（${ra.jobId} vs ${rb.jobId}）`)
    await waitJob(concRepo)
    const after = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
    check((after.jobs ?? []).some((j) => j.id === 'job-external-1'), 'flush 合并后另一实例的 job 不丢失')
  } finally {
    globalThis.fetch = originalFetch
    try { fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows 句柄延迟释放：留 tmp 自清 */ }
  }
}

// ============================ 面板端点与取消 ============================
console.log('== 面板端点：GET /api/codewiki/jobs、POST /api/codewiki/control（loopback 守卫 + 取消） ==')
{
  const cancelRepo = makeFixtureRepo()
  const mock = makeBatchMock({ stall: true }) // 批量请求挂起不返回，job 停在 plan 阶段等取消
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
    // 0.4.11：批量中间进度与逐任务明细透出（stall 挂起：进度在、完成数为 0）
    await new Promise((r) => setTimeout(r, 900)) // 等一拍 tick：submitBatchFor 落盘 batchProgress
    const resProg = fakeRes()
    jobsEp.handler(fakeReq(), resProg)
    const progJob = JSON.parse(resProg.out).jobs.find((j) => j.id === r4.jobId)
    check(!!progJob?.batchProgress && progJob.batchProgress.total >= 1 && progJob.batchProgress.completed === 0,
      `批量中间进度透出且无完成数（实际 ${JSON.stringify(progJob?.batchProgress)}）`)
    check(Array.isArray(progJob?.taskList) && progJob.taskList.length >= 1 && progJob.taskList.every((x) => x.state === 'pending'),
      `taskList 活动期为待办明细（实际 ${JSON.stringify(progJob?.taskList)?.slice(0, 120)}）`)
    const reposEp = main.endpoints.find((e) => e.path === '/api/codewiki/repos')
    const resRepos11 = fakeRes()
    await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resRepos11)
    const repoRow11 = (JSON.parse(resRepos11.out).repos ?? []).find((x) => x.cwd === cancelRepo)
    check(repoRow11?.lastJob?.taskList?.length >= 1 && repoRow11.lastJob.tps !== undefined && repoRow11.lastJob.batchProgress !== undefined,
      'repos 总览活动任务带 taskList/batchProgress/tps')
    check(typeof repoRow11?.lastJob?.batchSubmittedAt === 'string',
      `repos lastJob 带批量排队起始时刻（batchSubmittedAt=${repoRow11?.lastJob?.batchSubmittedAt}）`)
    check(typeof repoRow11?.articleCount === 'number', `repos 带 wiki 篇数（${repoRow11?.articleCount}）`)
    const sched11 = JSON.parse(resRepos11.out).scheduler
    check(sched11 && 'lastScanRepos' in sched11 && 'lastScanSubmitted' in sched11, 'scheduler 序列化带扫描统计字段')
    const resCancel = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'cancel', jobId: r4.jobId }), resCancel)
    check(resCancel.code === 200 && JSON.parse(resCancel.out).ok === true, '取消请求被接受')
    const job = await waitJob(cancelRepo)
    check(job?.stage === 'cancelled', `job 终态 cancelled（实际 ${job?.stage}）`)
    check((job?.notes ?? []).some((n) => n.includes('在途请求已中断')), '取消中断批量在途请求（未完成不计费语义）')
    const res404 = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'cancel', jobId: 'job-none' }), res404)
    check(res404.code === 404, '取消未知 jobId 404')
  } finally {
    mock.restore()
    fs.rmSync(cancelRepo, { recursive: true, force: true })
  }
}

// ============================ 排除清单 / repos 总览 / compile 动作（0.4.7） ============================
console.log('== 0.4.7：排除清单、仓库总览端点、compile 动作 ==')
{
  const exRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  try {
    const reposEp = main.endpoints.find((e) => e.path === '/api/codewiki/repos')
    const ctlEp = main.endpoints.find((e) => e.path === '/api/codewiki/control')

    // 1) compile 动作提交成功
    const resC = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'compile', cwd: exRepo }, '127.0.0.1', 'POST'), resC)
    const cOut = JSON.parse(resC.out)
    check(resC.code === 200 && cOut.ok === true && cOut.submitted === true, `compile 动作提交成功（${resC.code} submitted=${cOut.submitted}）`)

    // 2) auto 直调命中幂等（同仓库活动任务直接返回）
    const rAuto = await gen.execute({ cwd: exRepo, scope: 'auto', auto: true }, { agent: 'test-agent' })
    check(rAuto.submitted === false && rAuto.jobId === cOut.jobId, 'auto 直调幂等：返回现有活动任务')

    // 3) 任务跑完
    const job = await waitJob(exRepo)
    check(job?.stage === 'done', `compile 提交的任务终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)

    // 4) 排除清单：compile 与直调都拒绝
    mainConfig.excludePaths = exRepo
    const resC2 = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'compile', cwd: exRepo }, '127.0.0.1', 'POST'), resC2)
    const c2 = JSON.parse(resC2.out)
    check(resC2.code === 400 && c2.ok === false && String(c2.error).includes('排除清单'), 'compile 对排除仓库 400 拒绝')
    let err = null
    try { await gen.execute({ cwd: exRepo }, { agent: 'test-agent' }) } catch (e) { err = e }
    check(err && String(err.message).includes('排除清单'), '直调对排除仓库抛错')
    const sub = path.join(exRepo, 'packages', 'app')
    fs.mkdirSync(sub, { recursive: true })
    let err2 = null
    try { await gen.execute({ cwd: sub }, { agent: 'test-agent' }) } catch (e) { err2 = e }
    check(err2 && String(err2.message).includes('排除清单'), '子目录同样被排除')
    delete mainConfig.excludePaths

    // 5) repos 总览：排除标记 + 状态 + scheduler 块
    const resR = fakeRes()
    await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resR)
    const payload = JSON.parse(resR.out)
    const repoRow = (payload.repos ?? []).find((x) => x.cwd === exRepo)
    check(!!repoRow, 'repos 总览含已编译仓库')
    check(repoRow?.excluded === false, '移出清单后 excluded=false')
    check(['clean', 'stale'].includes(repoRow?.state), `repos 状态可解析（${repoRow?.state}）`)
    check(payload.scheduler && payload.scheduler.enabled === false && payload.scheduler.intervalMin === 30, 'repos 总览含 scheduler 块（默认关/30min）')
  } finally {
    delete mainConfig.excludePaths
    mock.restore()
    fs.rmSync(exRepo, { recursive: true, force: true })
  }
}

// ============================ 已知仓库登记 / refresh（0.4.8） ============================
console.log('== 0.4.8：knownRepos 登记独立于 job 历史、refresh 动作 ==')
{
  const krRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  const reposFile = path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-repos.json')
  try {
    const r = await gen.execute({ cwd: krRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '0.4.8 编译提交成功')
    await waitJob(r.cwd)
    // 0.4.11：终态任务明细全结算、中间进度清空
    const jobsEp11 = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    const resDone11 = fakeRes()
    jobsEp11.handler(fakeReq(), resDone11)
    const doneJob = JSON.parse(resDone11.out).jobs.find((j) => j.id === r.jobId)
    check(Array.isArray(doneJob?.taskList) && doneJob.taskList.length >= 2 && doneJob.taskList.every((x) => x.state === 'done'),
      `终态 taskList 全部 done（实际 ${JSON.stringify(doneJob?.taskList)?.slice(0, 120)}）`)
    check(doneJob?.batchProgress === null, '终态 batchProgress 已清空')
    const listed = JSON.parse(fs.readFileSync(reposFile, 'utf8')).repos.map((p) => p.toLowerCase())
    check(listed.includes(krRepo.toLowerCase()), '提交即登记 knownRepos（持久化清单）')

    // 模拟 job 历史丢失（MAX_JOBS_KEPT 截断/清理）：knownRepos 仍让总览发现该仓
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }), 'utf8')
    const ctlEp8 = main.endpoints.find((e) => e.path === '/api/codewiki/control')
    const resR = fakeRes()
    await ctlEp8.handler(fakeReq({ action: 'refresh' }, '127.0.0.1', 'POST'), resR)
    check(resR.code === 200 && JSON.parse(resR.out).ok === true, 'refresh 动作清总览缓存')
    const jobsEp2 = main.endpoints.find((e) => e.path === '/api/codewiki/repos')
    const res2 = fakeRes()
    await jobsEp2.handler(fakeReq({}, '127.0.0.1', 'GET'), res2)
    const payload2 = JSON.parse(res2.out)
    const row2 = (payload2.repos ?? []).find((x) => x.cwd.toLowerCase() === krRepo.toLowerCase())
    check(!!row2, 'job 历史清空后 repos 总览仍发现已编译仓库（knownRepos）')
  } finally {
    mock.restore()
    fs.rmSync(krRepo, { recursive: true, force: true })
    try { fs.unlinkSync(reposFile) } catch { /* 测试清理 */ }
  }
}

// ============================ 工作区任务过滤（0.4.9） ============================
console.log('== 0.4.9：jobs 端点按宿主工作区过滤（workspaceOnly） ==')
{
  const wsRepo = makeFixtureRepo()
  const outsideRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  // 注册 workspaceRegistry：只有 wsRepo 是已添加工作区（宿主 WorkspaceRegistry 同构）
  const wx = makeCtx({ workspaces: [wsRepo] })
  const cfg2 = {}
  try {
    apply(wx.ctx, cfg2)
    const gen2 = wx.registered.get('codewiki_generate')
    const ep2 = wx.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    const epRepos = wx.endpoints.find((e) => e.path === '/api/codewiki/repos')

    const rA = await gen2.execute({ cwd: wsRepo }, { agent: 'test-agent' })
    await waitJob(rA.cwd)
    const rB = await gen2.execute({ cwd: outsideRepo }, { agent: 'test-agent' })
    await waitJob(rB.cwd)

    const readJobs = async () => {
      const res = fakeRes()
      await ep2.handler(fakeReq({}, '127.0.0.1', 'GET'), res)
      return JSON.parse(res.out).jobs
    }
    check((await readJobs()).some((j) => j.cwd === wsRepo), '工作区内任务显示')
    check(!(await readJobs()).some((j) => j.cwd === outsideRepo), `工作区外任务被过滤（${outsideRepo}）`)

    const readRepos = async () => {
      const res = fakeRes()
      await epRepos.handler(fakeReq({}, '127.0.0.1', 'GET'), res)
      return JSON.parse(res.out).repos
    }
    check((await readRepos()).some((r) => r.cwd === wsRepo), '总览含工作区内仓库')
    check(!(await readRepos()).some((r) => r.cwd === outsideRepo), '总览不含工作区外仓库（Temp 沙箱行消失）')

    cfg2.workspaceOnly = false
    check((await readJobs()).some((j) => j.cwd === outsideRepo), 'workspaceOnly=false 后任务不过滤')
    check((await readRepos()).some((r) => r.cwd === outsideRepo), 'workspaceOnly=false 后总览不过滤')
  } finally {
    delete cfg2.workspaceOnly
    mock.restore()
    fs.rmSync(wsRepo, { recursive: true, force: true })
    fs.rmSync(outsideRepo, { recursive: true, force: true })
  }
}

// ============================ registry 异常防御（0.4.10） ============================
console.log('== 0.4.10：workspaceRegistry.list() 抛错时 jobs/repos 降级不过滤 ==')
{
  const outsideRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  const wx = makeCtx({ brokenRegistry: true })
  const cfg2 = {}
  try {
    apply(wx.ctx, cfg2)
    const gen2 = wx.registered.get('codewiki_generate')
    const ep2 = wx.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    const epRepos = wx.endpoints.find((e) => e.path === '/api/codewiki/repos')
    const rB = await gen2.execute({ cwd: outsideRepo }, { agent: 'test-agent' })
    await waitJob(rB.cwd)

    const res = fakeRes()
    await ep2.handler(fakeReq({}, '127.0.0.1', 'GET'), res)
    check(res.code === 200, `registry 抛错时 jobs 仍 200（实际 ${res.code}）`)
    check(JSON.parse(res.out).jobs.some((j) => j.cwd === outsideRepo), 'registry 抛错时 jobs 不过滤（降级）')

    const resR = fakeRes()
    await epRepos.handler(fakeReq({}, '127.0.0.1', 'GET'), resR)
    check(resR.code === 200, `registry 抛错时 repos 仍 200（实际 ${resR.code}）`)
    check(JSON.parse(resR.out).repos.some((r) => r.cwd === outsideRepo), 'registry 抛错时总览不过滤（降级）')
  } finally {
    mock.restore()
    fs.rmSync(outsideRepo, { recursive: true, force: true })
  }
}

// ============================ 工具输出 schema 形态（0.4.10b） ============================
console.log('== 0.4.10：codewiki_generate 输出过 output schema 校验（null 占位回归） ==')
{
  // 与宿主校验器同构：属性存在时类型必须匹配（null/undefined 都不是 string，不算缺失）
  const validateOut = (schema, v) => {
    const errs = []
    for (const [k, t] of Object.entries(schema.properties)) {
      if (!(k in v)) continue
      const types = Array.isArray(t.type) ? t.type : [t.type]
      const val = v[k]
      const ok = types.some((ty) =>
        ty === 'string' ? typeof val === 'string' :
        ty === 'number' ? typeof val === 'number' :
        ty === 'boolean' ? typeof val === 'boolean' :
        ty === 'array' ? Array.isArray(val) : false)
      if (!ok) errs.push(`${k}=${JSON.stringify(val)}`)
    }
    for (const k of schema.required) if (!(k in v)) errs.push(`missing ${k}`)
    return errs
  }
  const repo = makeFixtureRepo()
  const mock = makeBatchMock()
  const wx = makeCtx({})
  const cfg2 = {}
  try {
    apply(wx.ctx, cfg2)
    const def = wx.registered.get('codewiki_generate')
    const schema = def.output.schema
    const r1 = await def.execute({ cwd: repo }, { agent: 'test-agent' })
    await waitJob(r1.cwd)
    check(validateOut(schema, r1).length === 0, `首次提交返回过 schema（${validateOut(schema, r1).join('; ')}）`)

    const r2 = await def.execute({ cwd: repo }, { agent: 'test-agent' })
    check(validateOut(schema, r2).length === 0, `二次调用（state ${r2.state}）返回过 schema（${validateOut(schema, r2).join('; ')}）`)
  } finally {
    mock.restore()
    fs.rmSync(repo, { recursive: true, force: true })
  }
}

// ============================ 孤儿任务接管（0.4.11.2） ============================
console.log('== 0.4.11.2：宿主重启后 foreign 孤儿任务按停更超时接管 ==')
{
  const staleAt = new Date(Date.now() - 6 * 60000).toISOString()
  const freshAt = new Date().toISOString()
  const mkForeign = (id, updatedAt, extra = {}) => ({
    id, cwd: 'E:/somewhere/foreign-' + id, kind: 'stale', scope: 'auto', language: 'zh',
    stage: 'articles', owner: 'svc-foreign-instance',
    plan: null, batchRef: null, tasks: [], articles: [], writtenCount: 0, failedCount: 0,
    notes: [], createdAt: staleAt, updatedAt, ...extra,
  })
  // apply 前写入 JOBS_FILE，start() 的 loadJobs 直接吸收
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [
    mkForeign('job-orphan-stale', staleAt, { cancelRequested: true }),
    mkForeign('job-orphan-fresh', freshAt),
  ] }), 'utf8')
  const wx = makeCtx({})
  const cfg2 = {}
  apply(wx.ctx, cfg2)
  // 等 2 个 tick：接管（陈旧）在下一轮 tick 生效；新鲜的继续让路
  await new Promise((r) => setTimeout(r, 800))
  const epJ = wx.endpoints.find((e) => e.path === '/api/codewiki/jobs')
  const res = fakeRes()
  await epJ.handler(fakeReq({}, '127.0.0.1', 'GET'), res)
  const got = JSON.parse(res.out).jobs
  const st = got.find((j) => j.id === 'job-orphan-stale')
  const fr = got.find((j) => j.id === 'job-orphan-fresh')
  check(st?.stage === 'cancelled', `停更 6 分钟的 foreign 任务被接管并响应取消（实际 stage=${st?.stage}）`)
  check((st?.notes ?? []).some((m) => String(m).includes('接管')), '接管时写了 note 留痕')
  check(fr?.stage === 'articles' && (fr?.notes ?? []).every((m) => !String(m).includes('接管')),
    `新鲜 foreign 任务不被抢（实际 stage=${fr?.stage} 接管note=${(fr?.notes ?? []).some((m) => String(m).includes('接管'))}）`)
  try { fs.unlinkSync(JOBS_FILE) } catch { /* 测试清理 */ }
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

// ============================ Temp 残留清理（0.4.6） ============================
console.log('== 服务启动清理：Temp 目录终态任务自动移除，活动任务与工作区任务保留 ==')
{
  const iso = new Date().toISOString()
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [
    { id: 'job-tmp-done', cwd: path.join(os.tmpdir(), 'cw-orch-deadbeef'), kind: 'full', scope: 'auto', stage: 'done', notes: [], articles: [], tasks: [], createdAt: iso, updatedAt: iso, writtenCount: 3 },
    { id: 'job-tmp-active', cwd: path.join(os.tmpdir(), 'cw-orch-alive'), kind: 'full', scope: 'auto', stage: 'articles', owner: 'svc-foreign-instance', notes: [], articles: [], tasks: [], createdAt: iso, updatedAt: iso },
    { id: 'job-ws-done', cwd: 'E:/some/real/workspace', kind: 'full', scope: 'auto', stage: 'done', notes: [], articles: [], tasks: [], createdAt: iso, updatedAt: iso, writtenCount: 2 },
  ] }), 'utf8')
  const cc = makeCtx()
  apply(cc.ctx, {})
  await new Promise((r) => setTimeout(r, 1200)) // 等 tick flush 落盘
  const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
  const ids = (data.jobs ?? []).map((j) => j.id)
  check(!ids.includes('job-tmp-done'), 'Temp 目录终态任务已被启动清理移除')
  check(ids.includes('job-tmp-active'), 'Temp 目录活动任务保留')
  check(ids.includes('job-ws-done'), '工作区终态任务保留')
}

// 清理主 fixture（wiki 在仓库内 .codewiki/，随目录一起删）
fs.rmSync(mainRepo, { recursive: true, force: true })

console.log(failures ? `\nFAIL：${failures} 项未通过` : '\nPASS：编排冒烟全部通过')
process.exit(failures ? 1 : 0)
