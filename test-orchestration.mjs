// test-orchestration.mjs — dsh-codewiki 服务化编排冒烟：
// mock 宿主 llm 服务（llm.stream 按 prompt 特征应答，插件零直连）+ 真实 cw CLI + 真实服务 tick，
// 验证 codewiki_generate 提交制 + 服务阶段机（articles→crosscut→review→index，0.10.7 起无规划阶段）、
// stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control）与取消、编译模型缺失诚实报错、
// 单项目串行排队（0.10.0）、编译终态 steer 实时唤醒发起会话（0.8.0）。
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

// 测试配置基线：0.10.1 起编译模型必须显式指向模型设置里的 provider/model
// （插件已无自带直连通道与任何密钥，provider 留空即提交失败）。
const batchCfg = (extra = {}) => ({ batchProvider: 'workbuddy', batchModel: 'hy3', ...extra })

// mock 宿主上下文：按 inject 依赖路由；webServer/tools/agents/llm 全部可捕获。
// inject 同时支持 cordis 两种风格：带回调（apply 注册）与 promise（await ctx.inject([...])）
// 0.10.1：插件不再解析任何凭证（无自带直连通道），llm 服务是唯一模型通道——
// 默认注入转发到 activeLlm 的 llmProxy，块内 makeBatchMock() 换掉 activeLlm 即可。
function makeCtx({ agents = [], workspaces = null, brokenRegistry = false, agentGet = null, llm = null } = {}) {
  const registered = new Map()
  const endpoints = []
  const listeners = []
  const disposers = []
  const services = {
    webServer: { register(def) { endpoints.push(def) } },
    agents: agentGet ? { list: () => agents, get: agentGet } : { list: () => agents },
    tools: { register(def) { registered.set(def.name, def); return () => {} } },
    llm: llm ?? llmProxy,
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
  // 顶层 core/、util/ 两个目录：0.10.7 删规划阶段后模块清单由 localPlan 按顶层目录
  // 分组生成，fixture 结构直接决定模块名（原勘探员应答固定 core/util 的时代结束了）
  fs.mkdirSync(path.join(dir, 'core'))
  fs.mkdirSync(path.join(dir, 'util'))
  fs.writeFileSync(path.join(dir, 'core', 'core.py'), 'def run():\n    return "core"\n')
  fs.writeFileSync(path.join(dir, 'util', 'util.py'), 'def fmt():\n    return "util"\n')
  const git = (...a) => execFileSync('git', a, { cwd: dir })
  git('init')
  // 0.10.9：fixture 必须自带 git identity——autoCommitWiki 在缺 user.name/user.email 时
  // 会拒绝自动提交（安全边界），否则 e2e 永远只能走「降级提醒」分支。
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@test')
  git('add', '.')
  git('commit', '-m', 'init')
  return dir
}

// 0.10.1 起唯一通道是宿主 llm 服务（模型设置里已注册的 provider/model），插件不再直连任何端点。
// activeLlm 是「当前生效的假 llm」：makeCtx 注册的 llmProxy 恒转发给它，因此每个测试块
// 只需 makeBatchMock() 一处接线，不必给每个 apply 的 ctx 补 llm。
let activeLlm = null
const llmProxy = {
  async *stream(opts) {
    if (!activeLlm) throw new Error('测试未接线：先 makeBatchMock() 再提交任务')
    yield* activeLlm.stream(opts)
  },
  listModels: (...a) => (activeLlm ? activeLlm.listModels(...a) : []),
  resolveModel: (...a) => (activeLlm ? activeLlm.resolveModel(...a) : null),
}
const promptOf = (opts) => String(opts?.messages?.[0]?.content?.[0]?.text ?? '')

// mock 宿主 llm 服务：全部环节都是单轮 chat 后台并发池。
// 按 prompt 首行特征分发应答（与真实 prompt 模板的区分句一一对应）。
function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false } = {}) {
  const llmCalls = []
  const answerFor = (prompt) => {
    if (prompt.includes('你是 CodeWiki 文章观察员')) {
      // 文章分割观察批：应答一段观察文本（合成阶段凭它产文）
      return '观察：模块职责与关键实现（来自分批观察）。\n\n文件清单：见上文。\n'
    }
    if (prompt.includes('你是 CodeWiki 文章作者')) {
      const mn = (prompt.match(/modules\/([a-z0-9-]+)\.md/) ?? [])[1] ?? modules[0]
      return articleMd(mn, `${mn}/${mn}.py`, articleMarker)
    }
    if (prompt.includes('你是 CodeWiki 架构观察员')) {
      return '模块观察：职责一句话。\n\nsource_files:\n  - core/core.py\n'
    }
    if (prompt.includes('写系统总览')) return articleMd('Architecture', 'core/core.py', articleMarker, 'architecture')
    if (prompt.includes('总结仓库反复出现的模式')) return articleMd('Patterns', 'util/util.py', articleMarker, 'pattern')
    if (prompt.includes('写跨模块概念')) return articleMd('config-load', 'core/core.py', articleMarker, 'concept')
    if (prompt.includes('你是 CodeWiki 审校员')) {
      // 0.10.8 批量校对：按输入的 @@@article 标记逐篇回标记格式（settleProofread 按标记拆回）
      const names = [...prompt.matchAll(/@@@article: (.*)/g)].map((m) => m[1].trim())
      if (names.length) {
        return names.map((n) => {
          const seg = prompt.slice(Math.max(0, prompt.indexOf(`@@@article: ${n}`)))
          const body = seg.slice(0, seg.indexOf('==== 该篇 source_files') >= 0 ? seg.indexOf('==== 该篇 source_files') : undefined)
          const fm = (body.match(/---\ntitle:[\s\S]*?\n---/) ?? [])[0]
          return `@@@article: ${n}\n${fm ?? `---\ntitle: ${n}\n---`}\n\nPROOFED article.\n@@@end`
        }).join('\n')
      }
      const fm = prompt.match(/---\ntitle:[\s\S]*?\n---/)
      return fm ? `${fm[0]}\n\nPROOFED article.\n` : articleMd('Proofed', 'core/core.py', 'PROOFED')
    }
    return '---\ntitle: unknown\n---\nunknown task'
  }
  // 假 llm 服务的 stream：把 answerFor 的结果按宿主 block 协议吐出来
  const llm = {
    async *stream(opts) {
      const prompt = promptOf(opts)
      llmCalls.push({ provider: opts.provider, model: opts.model, reasoningEffort: opts.reasoningEffort, prompt, signal: opts.signal })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (stall) {
        // 端点不返回：挂起直到客户端 abort（取消语义）
        await new Promise((_resolve, reject) => {
          if (opts.signal?.aborted) return reject(new Error('client aborted'))
          opts.signal?.addEventListener('abort', () => reject(new Error('client aborted')), { once: true })
        })
        return
      }
      let content = answerFor(prompt)
      if (bigArticle && prompt.includes('你是 CodeWiki 文章作者')) content += `\n\n${'长'.repeat(70000)}`
      yield { type: 'text-delta', index: 0, text: content }
      yield { type: 'usage', usage: { outputTokens: 128 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const prevLlm = activeLlm
  activeLlm = llm
  return {
    llm,
    llmCalls,
    batchPrompts: () => llmCalls.map((c) => c.prompt),
    realtimePrompts: () => llmCalls.map((c) => c.prompt),
    // 恢复上一个生效的假 llm（块间嵌套时用）
    restore: () => { activeLlm = prevLlm },
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
const e2eSteers = [] // 编译终态 steer 唤醒捕获（sess-e2e 专属）
const main = makeCtx({ agentGet: (id) => (id === 'sess-e2e' ? { steer: (m) => e2eSteers.push({ id, m }) } : undefined) })
const mainConfig = batchCfg()
apply(main.ctx, mainConfig)
check(name === 'dsh-codewiki', `插件名 ${name}`)
check(main.registered.get('cw') && main.registered.get('codewiki_generate'), 'cw 与 codewiki_generate 两个工具均已注册')
const gen = main.registered.get('codewiki_generate')
const cwTool = main.registered.get('cw')
const prog = main.registered.get('codewiki_progress')
check(!!prog, 'codewiki_progress 工具已注册')

console.log('== cw 工具 ==')
{
  const st = await cwTool.execute({ cwd: mainRepo, args: ['status'] })
  check(st.exitCode === 0 && /No wiki found/i.test(st.stdout), 'cw status 判定 missing 态')
}

// ============================ codewiki_update 工具 + 提交提醒 ============================
console.log('== codewiki_update：固定 scope=auto 的更新请求 + commitHintText ==')
{
  // wrapper 单测：mock generateDef（临时替换注册的 gen.execute，测完还原），验证 scope 强制、note 追加、错误前缀改写
  const captured = []
  const fakeGen = {
    execute: async (args) => {
      captured.push(args)
      if (args.cwd === 'boom') throw new Error('codewiki_generate：cwd 不存在')
      return { cwd: args.cwd, scope: args.scope, wikiPath: 'w', state: 'stale', jobId: 'job-x', stage: 'articles', submitted: true, notes: [] }
    },
  }
  const { commitHintText } = await import('./index.js')
  const origGenExecute = gen.execute
  gen.execute = fakeGen.execute
  const upd = main.registered.get('codewiki_update')
  check(!!upd, 'codewiki_update 工具已注册')
  try {
    const r = await upd.execute({ cwd: mainRepo, scope: 'full' })
    check(captured[0]?.scope === 'auto', 'scope 强制为 auto（调用方传 full 也被覆盖）')
    check(r.submitted === true && r.jobId === 'job-x', '透传 generate 结果（submitted/jobId）')
    check((r.notes ?? []).some((n) => n.includes('继续下一项')), '提交后追加「继续下一项」引导 note')
    await upd.execute({ cwd: 'boom' }).then(() => check(false, '错误应向上抛'), (e) => {
      check(String(e?.message).includes('codewiki_update'), '错误消息前缀改写为 codewiki_update')
    })
  } finally { gen.execute = origGenExecute }

  // commitHintText 单测：git fixture 仓库 + 合成 jobs
  // （cwd 带 CodeWiki.md 才有意义，但本函数不做入口检查——门控在 section 回调）
  const hintRepo = makeFixtureRepo()
  try {
    const fin = new Date(Date.now() - 60_000).toISOString()
    const jobs = [{ id: 'job-h1', cwd: hintRepo, stage: 'done', writtenCount: 3, finishedAt: fin }]
    // fixture 仓库没有 .codewiki/：git log 空 → commitSec=NaN → 提醒必现
    const h1 = commitHintText(hintRepo, jobs)
    check(h1.includes('CodeWiki 产物待提交') && h1.includes('job-h1'), '无 .codewiki 提交史 → 注入「产物待提交」提醒')
    check(h1.includes('git add') || h1.includes('.codewiki'), '提醒含提交动作指引')
    check(h1.includes('不要为了本提醒中断当前任务'), '提醒明确不中断当前任务、不轮询')
    // 编译时间早于最近一次 .codewiki 提交 → 静默（构造：先提交一次带 .codewiki 的 commit）
    fs.mkdirSync(path.join(hintRepo, '.codewiki'))
    fs.writeFileSync(path.join(hintRepo, '.codewiki', 'a.md'), 'x\n')
    const git2 = (...a) => execFileSync('git', a, { cwd: hintRepo })
    git2('add', '.')
    git2('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'wiki')
    const h2 = commitHintText(path.join(hintRepo, 'subdir-nope'), jobs) // 不同 cwd：绕开 60s 缓存
    check(h2 === '', '不同仓库无匹配 job → 空')
    const oldJob = [{ id: 'job-h2', cwd: hintRepo, stage: 'done', writtenCount: 1, finishedAt: '2020-01-01T00:00:00.000Z' }]
    // 缓存键是 cwd：hintRepo 刚才已缓存「提醒」文本——用大小写/尾斜杠变体绕开不可靠，
    // 直接换一个全新 fixture 仓库验证「已提交 → 静默」
    const repo2 = makeFixtureRepo()
    try {
      fs.mkdirSync(path.join(repo2, '.codewiki'))
      fs.writeFileSync(path.join(repo2, '.codewiki', 'a.md'), 'x\n')
      const g3 = (...a) => execFileSync('git', a, { cwd: repo2 })
      g3('add', '.')
      g3('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'wiki first')
      const h3 = commitHintText(repo2, oldJob) // 编译(2020) 早于 wiki 提交(刚刚) → 静默（此空结果会进 60s 缓存）
      check(h3 === '', '编译完成时间早于 .codewiki 最后提交 → 不提醒')
      // 缓存键是 cwd：repo2 已缓存空文本，h4/h5 换全新仓库绕开缓存，验证「编译晚于提交 → 提醒」
      const repo3 = makeFixtureRepo()
      try {
        fs.mkdirSync(path.join(repo3, '.codewiki'))
        fs.writeFileSync(path.join(repo3, '.codewiki', 'a.md'), 'x\n')
        const g4 = (...a) => execFileSync('git', a, { cwd: repo3 })
        g4('add', '.')
        g4('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'wiki first')
        await new Promise((r) => setTimeout(r, 1100)) // jobSec > commitSec 严格大于：隔开同一秒的提交与编译竞态
        const h4 = commitHintText(repo3, [{ id: 'job-h3', cwd: repo3, stage: 'done', writtenCount: 2, finishedAt: new Date().toISOString() }])
        check(h4.includes('CodeWiki 产物待提交'), '编译完成时间晚于 .codewiki 最后提交 → 提醒')
        // 0.10.9：自动提交失败原因写进提醒，让会话模型知道为什么需要它来提交
        const repo3b = makeFixtureRepo()
        try {
          fs.mkdirSync(path.join(repo3b, '.codewiki'))
          fs.writeFileSync(path.join(repo3b, '.codewiki', 'a.md'), 'x\n')
          const g5 = (...a) => execFileSync('git', a, { cwd: repo3b })
          g5('add', '.')
          g5('commit', '-m', 'wiki first')
          await new Promise((r) => setTimeout(r, 1100))
          const h4b = commitHintText(repo3b, [{
            id: 'job-h3b', cwd: repo3b, stage: 'done', writtenCount: 2, finishedAt: new Date().toISOString(),
            autoCommit: { committed: false, reason: '不是 git 仓库' },
          }])
          check(h4b.includes('插件自动提交未执行') && h4b.includes('不是 git 仓库'), '提醒带出自动提交失败原因')
        } finally { fs.rmSync(repo3b, { recursive: true, force: true }) }
      } finally { fs.rmSync(repo3, { recursive: true, force: true }) }
      // h4 的「提醒」文本已进 repo3 缓存——h5 换新仓库验证 writtenCount=0 → 静默
      const repo4 = makeFixtureRepo()
      try {
        const h5 = commitHintText(repo4, [{ id: 'job-h4', cwd: repo4, stage: 'done', writtenCount: 0, finishedAt: new Date().toISOString() }])
        check(h5 === '', 'writtenCount=0（没有文章写成功）→ 不提醒')
      } finally { fs.rmSync(repo4, { recursive: true, force: true }) }
    } finally { fs.rmSync(repo2, { recursive: true, force: true }) }
  } finally { fs.rmSync(hintRepo, { recursive: true, force: true }) }
}

// ============================ autoCommitWiki：插件自己提交编译产物（0.10.9） ============================
console.log('== autoCommitWiki：安全边界（只提交 .codewiki/ 与 CodeWiki.md，任何可疑状态一律拒绝） ==')
{
  const { autoCommitWiki } = await import('./index.js')
  // 正常路径：先写产物再提交
  const okRepo = makeFixtureRepo()
  try {
    fs.mkdirSync(path.join(okRepo, '.codewiki'))
    fs.writeFileSync(path.join(okRepo, '.codewiki', 'a.md'), '# a\n')
    fs.writeFileSync(path.join(okRepo, 'CodeWiki.md'), '# entry\n')
    fs.writeFileSync(path.join(okRepo, 'core', 'core.py'), 'def changed():\n    pass\n') // 未 staged 的源码改动
    const r = autoCommitWiki(okRepo, { jobId: 'job-ac1', writtenCount: 2 })
    check(r.committed === true && /^[0-9a-f]{7,}$/.test(String(r.sha)), `正常仓库提交成功（sha ${r.sha}）`)
    check(String(r.message).startsWith('docs(wiki):') && String(r.message).includes('job-ac1'), '提交信息带 docs(wiki) 前缀与任务 id')
    const files = execFileSync('git', ['-C', okRepo, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    check(files.sort().join(',') === '.codewiki/a.md,CodeWiki.md', `只提交两个目标路径（实际：${files.join(',')}）`)
    const status = execFileSync('git', ['-C', okRepo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    check(status.includes('core/core.py'), '源码改动留在工作区（不被卷进自动提交，也不被丢弃）')
    // 无改动 → noChanges（不产出空提交）
    const r2 = autoCommitWiki(okRepo, { jobId: 'job-ac1' })
    check(r2.committed === false && r2.noChanges === true, '产物已入库 → noChanges，不产空提交')
  } finally { fs.rmSync(okRepo, { recursive: true, force: true }) }

  // 非 git 目录
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-plain-'))
  try {
    fs.writeFileSync(path.join(plain, '.codewiki'), 'x')
    const r = autoCommitWiki(plain)
    check(r.committed === false && r.reason.includes('不是 git 仓库'), '非 git 目录 → 拒绝并给出原因')
  } finally { fs.rmSync(plain, { recursive: true, force: true }) }

  // 路径被 .gitignore 忽略
  const ignRepo = makeFixtureRepo()
  try {
    fs.writeFileSync(path.join(ignRepo, '.gitignore'), '.codewiki/\n')
    fs.mkdirSync(path.join(ignRepo, '.codewiki'))
    fs.writeFileSync(path.join(ignRepo, '.codewiki', 'a.md'), '# a\n')
    const r = autoCommitWiki(ignRepo)
    check(r.committed === false && r.reason.includes('.gitignore'), '产物被忽略 → 拒绝并说明（不会静默丢产物）')
  } finally { fs.rmSync(ignRepo, { recursive: true, force: true }) }

  // 合并进行中
  const mergeRepo = makeFixtureRepo()
  try {
    fs.mkdirSync(path.join(mergeRepo, '.codewiki'))
    fs.writeFileSync(path.join(mergeRepo, '.codewiki', 'a.md'), '# a\n')
    fs.writeFileSync(path.join(mergeRepo, '.git', 'MERGE_HEAD'), execFileSync('git', ['-C', mergeRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }))
    const r = autoCommitWiki(mergeRepo)
    check(r.committed === false && r.reason.includes('合并'), 'merge 进行中 → 拒绝（不把 wiki 夹进别人的合并提交）')
  } finally { fs.rmSync(mergeRepo, { recursive: true, force: true }) }

  // 未配置 git identity（把全局配置指向空文件，模拟裸环境）
  const idRepo = makeFixtureRepo()
  const emptyCfg = path.join(os.tmpdir(), `cw-gitcfg-${process.pid}`)
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL
  try {
    fs.writeFileSync(emptyCfg, '')
    fs.mkdirSync(path.join(idRepo, '.codewiki'))
    fs.writeFileSync(path.join(idRepo, '.codewiki', 'a.md'), '# a\n')
    const g = (...a) => execFileSync('git', ['-C', idRepo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_NOSYSTEM: '1' } })
    g('config', '--unset', 'user.name')
    g('config', '--unset', 'user.email')
    process.env.GIT_CONFIG_GLOBAL = emptyCfg
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    const r = autoCommitWiki(idRepo)
    check(r.committed === false && r.reason.includes('user.name'), '缺 git identity → 拒绝并指出该配什么')
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal
    delete process.env.GIT_CONFIG_NOSYSTEM
    fs.rmSync(idRepo, { recursive: true, force: true })
    fs.rmSync(emptyCfg, { force: true })
  }
}

// ============================ wakeCompileSession：编译终态 steer 唤醒 ============================
console.log('== wakeCompileSession：终态实时唤醒（插件已自动提交时完全不打扰会话） ==')
{
  const { wakeCompileSession } = await import('./index.js')
  const steered = []
  const fakeAgent = { steer: (m) => steered.push(m) }
  const fakeAgents = { get: (id) => (id === 'sess-1' ? fakeAgent : undefined) }
  const doneJob = { id: 'job-w1', cwd: 'C:/r', sessionId: 'sess-1', writtenCount: 4 }
  // 0.10.9 核心行为：插件已自动提交 → 成功终态零唤醒（这正是「会话模型干等编译」的根治点）
  wakeCompileSession({ ...doneJob, autoCommit: { committed: true, sha: 'abc123' } }, 'done', fakeAgents)
  check(steered.length === 0, 'autoCommit 成功 → done 完全不唤醒会话（无需会话模型提交）')
  // 自动提交没成功 → 提醒一次（降级路径）
  wakeCompileSession({ ...doneJob, autoCommit: { committed: false, reason: '不是 git 仓库' } }, 'done', fakeAgents)
  check(steered.length === 1, 'autoCommit 失败 → done 仍唤醒一次（降级提醒）')
  const t1 = String(steered[0]?.content?.[0]?.text ?? '')
  check(t1.includes('CodeWiki 产物待提交') && t1.includes('job-w1'), '降级文案含标题与任务 id')
  check(t1.includes('不是 git 仓库'), '降级文案带上自动提交失败原因')
  check(t1.includes('.codewiki') && t1.includes('docs(wiki)'), '降级文案含提交动作指引')
  check(t1.includes('不要为此中断或轮询'), '降级文案明确要求不中断、不轮询')
  check(steered[0]?.source?.kind === 'plugin:codewiki', 'source 标记 plugin:codewiki (v4)')
  wakeCompileSession({ ...doneJob, error: '编译模型不可用', autoCommit: { committed: true } }, 'failed', fakeAgents)
  const t2 = String(steered[1]?.content?.[0]?.text ?? '')
  check(t2.includes('CodeWiki 编译失败') && t2.includes('编译模型不可用'), 'failed 消息含失败原因（自动提交成功也不吞失败）')
  wakeCompileSession({ ...doneJob, sessionId: null }, 'done', fakeAgents)
  wakeCompileSession(doneJob, 'done', { get: () => undefined }) // 冷会话：注册表查不到
  check(steered.length === 2, '无 sessionId / 冷会话 → 不唤醒')
  wakeCompileSession(doneJob, 'done', { get: () => { throw new Error('registry gone') } })
  check(steered.length === 2, 'registry.get 抛异常 → 静默不抛')
  wakeCompileSession(doneJob, 'done', { get: () => ({ steer: () => { throw new Error('steer boom') } }) })
  check(steered.length === 2, 'steer 抛异常 → 静默不抛')
  wakeCompileSession(doneJob, 'done') // 缺省 agentsRef：测试进程内为 main ctx 的 agents（无 get）→ 静默
  check(steered.length === 2, '缺省 agents（宿主未注入或无 get）→ 静默')
}

// ============================ 本地规划（0.10.7：规划阶段已删，articles 开头就地 localPlan） ============================
console.log('== 本地规划：零规划请求，模块清单由 localPlan 顶层目录分组生成 ==')
{
  // 0.10.1：唯一通道是宿主 llm 服务。此块的意图不再是「不碰 ctx.llm」，
  // 而是「不沿用发起会话的主模型身份」——请求必须按配置的 provider/model 发出。
  // 场景 1：agent 带会话路由 deepseek-official/main-model-x → 仍按 workbuddy/hy3 调用 llm
  const mmRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  const mmCtx = makeCtx({
    agentGet: (id) => (id === 'sess-mm' ? {
      steer: () => {},
      session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'main-model-x' } }) },
    } : undefined),
  })
  apply(mmCtx.ctx, batchCfg())
  const mmGen = mmCtx.registered.get('codewiki_generate')
  try {
    const r = await mmGen.execute({ cwd: mmRepo }, { agent: { id: 'sess-mm' } })
    check(r.submitted === true, '带会话路由：提交即返回')
    const job = await waitJob(r.cwd)
    console.log('  notes:', (job?.notes ?? []).join(' | '))
    check(mock.llmCalls.length > 0 && mock.llmCalls.every((c) => c.provider === 'workbuddy' && c.model === 'hy3'),
      `全部请求按设置的编译模型发出（${mock.llmCalls.length} 次，provider/model 全为 workbuddy/hy3）`)
    check(!mock.llmCalls.some((c) => c.provider === 'deepseek-official' || c.model === 'main-model-x'),
      '不沿用会话主模型身份（零 deepseek-official/main-model-x 调用）')
    check(!mock.llmCalls.some((c) => c.prompt.includes('勘探员')), '全程无独立规划请求（0.10.7 删规划阶段）')
    check(job?.stage === 'done', `任务终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(job?.plan?.project === '（本地规划：按顶层目录分组）' && job?.plan?.modules?.length === 2, 'localPlan 入库（顶层目录分组 2 模块）')
    check(job?.plan?.modules?.every((m) => Array.isArray(m.files) && m.files.length === 1), '每模块文件清单来自本地扫描（各 1 文件）')
    check((job?.notes ?? []).some((n) => n.includes('规划：2 个模块')), 'notes 记录本地规划结果')
    check(job?.plan?.concepts?.length === 0, 'concepts 为空数组（本地规划不产概念，crosscut 兼容）')
    check((job?.notes ?? []).some((n) => n.includes('阶段已启动')), 'notes 记录批量阶段启动与模型/并发')
  } finally {
    mock.restore()
    fs.rmSync(mmRepo, { recursive: true, force: true })
  }

  // （0.10.7 删掉了「规划应答非 JSON → 降级本地分组」场景：本地分组已是唯一路径）

  // 场景 3：无 sessionId（面板提交）→ 同一条批量路径
  const panelRepo = makeFixtureRepo()
  const mock3 = makeBatchMock()
  const pCtx = makeCtx({})
  apply(pCtx.ctx, batchCfg())
  const pGen = pCtx.registered.get('codewiki_generate')
  try {
    const r = await pGen.execute({ cwd: panelRepo }, { agent: 'test-agent' })
    const job = await waitJob(r.cwd)
    check(job?.stage === 'done', `面板提交任务终态 done（实际 ${job?.stage}）`)
    check(mock3.llmCalls.every((c) => c.provider === 'workbuddy' && c.model === 'hy3'), '面板提交按设置的编译模型发出')
    check(!mock3.batchPrompts().some((p) => p.includes('勘探员')), '面板提交同样零规划请求')
  } finally {
    mock3.restore()
    fs.rmSync(panelRepo, { recursive: true, force: true })
  }
  // 本块 apply 过新 ctx，恢复 main 的 agentsRef，避免污染后续 e2e 唤醒断言
  apply(main.ctx, mainConfig)
}

// ============================ 全量编译（服务阶段机） ============================
console.log('== codewiki_generate 全量编译：提交即返回，服务推进阶段机 ==')
{
  const mock = makeBatchMock()
  try {
    const r1 = await gen.execute({ cwd: mainRepo }, { agent: { id: 'sess-e2e' } })
    console.log('  notes:', r1.notes.join(' | '))
    check(r1.submitted === true && typeof r1.jobId === 'string', '提交即返回（jobId 非空）')
    check(r1.stage === 'articles', `初始 stage=articles（实际 ${r1.stage}）`)
    check(r1.writtenCount === undefined, '返回值不含 writtenCount（编译交服务，不再就地等待）')
    const job = await waitJob(r1.cwd)
    check(!mock.batchPrompts().some((p) => p.includes('勘探员')), '零规划请求（宿主 llm 通道只跑文章/横切/校对）')
    check(job?.stage === 'done', `服务 job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(job?.writtenCount >= 3 && job?.failedCount === 0, `编译完成 ${job?.writtenCount} 篇、失败 ${job?.failedCount} 篇（2 模块+架构+模式）`)
    check(job?.autoCommit?.committed === true && /^[0-9a-f]{7,}$/.test(String(job.autoCommit.sha ?? '')), `编译产物由插件自动提交（sha ${job?.autoCommit?.sha ?? '-'}）`)
    {
      // 落库核查：HEAD 提交里必须只有 .codewiki/ 与 CodeWiki.md
      const files = execFileSync('git', ['-C', mainRepo, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      check(files.every((f) => f.startsWith('.codewiki/') || f === 'CodeWiki.md'), `自动提交只含 wiki 产物（实际：${files.slice(0, 4).join(', ')}…）`)
      check(files.some((f) => f.startsWith('.codewiki/')), '自动提交含 .codewiki/ 文章')
      const msg = execFileSync('git', ['-C', mainRepo, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()
      check(msg.startsWith('docs(wiki):'), `自动提交信息带 docs(wiki) 前缀（实际：${msg}）`)
      // 工作区干净：插件没有把 fixture 的源码改动卷进去（core.py 保持未改）
      const status = execFileSync('git', ['-C', mainRepo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
      check(status === '', `自动提交后工作区干净（实际：${status || 'empty'}）`)
    }
    check(e2eSteers.length === 0, '插件已自动提交 → 编译完成不唤醒会话（会话模型无需等待、无需提交）')
    const w = job.wikiPath
    check(fs.existsSync(path.join(w, 'modules', 'core.md')), 'modules/core.md 落盘')
    check(fs.existsSync(path.join(w, 'modules', 'util.md')), 'modules/util.md 落盘')
    check(fs.existsSync(path.join(w, '_architecture.md')), '_architecture.md 落盘')
    check(fs.existsSync(path.join(w, '_patterns.md')), '_patterns.md 落盘')
    check(!fs.existsSync(path.join(w, 'concepts')) || fs.readdirSync(path.join(w, 'concepts')).length === 0, '无概念文章（localPlan concepts 为空，crosscut 兼容）')
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
  try {
    const r = await gen.execute({ cwd: bigRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '大 wiki 提交即返回')
    const job = await waitJob(r.cwd)
    console.log('  notes:', (job?.notes ?? []).join(' | '))
    const obsPrompts = mock.batchPrompts().filter((p) => p.includes('架构观察员'))
    check(obsPrompts.length === 2, `端点收到 2 个观察请求（实际 ${obsPrompts.length}）`)
    check(!mock.realtimePrompts().some((p) => p.includes('勘探员')) && !mock.batchPrompts().some((p) => p.includes('勘探员')), '全程无规划请求（0.10.7 删规划阶段）')
    for (const p of obsPrompts) {
      check((p.match(/^### /gm) ?? []).length === 1, '观察请求输入只含一篇模块文章')
    }
    check(!mock.batchPrompts().some((p) => p.includes('写系统总览') && p.includes('长'.repeat(100))), '合成请求输入不含原文全文（只吃观察）')
    check(job?.stage === 'done', `服务 job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(fs.existsSync(path.join(job.wikiPath, '_architecture.md')), '_architecture.md 经合成批落盘')
    check(fs.existsSync(path.join(job.wikiPath, '_patterns.md')), '_patterns.md 经合成批落盘')
    check(fs.readFileSync(path.join(job.wikiPath, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '大 wiki 校对批次照常回写（动态预算）')
    check((job.notes ?? []).some((n) => n.includes('观察任务并发执行')), 'notes 记录拆分决策')
    check((job.notes ?? []).some((n) => n.includes('超单请求预算')), '单请求输入超预算时 notes 明示按大档装填')
    check((job.notes ?? []).some((n) => n.includes('提交横切合成批次')), '观察批 settle 后进入合成批')
  } finally {
    mock.restore()
    fs.rmSync(bigRepo, { recursive: true, force: true })
  }
}

// ============================ 大模块：文章观察→合成分割 ============================
console.log('== 文章阶段分割：模块源码超预算 → 观察批 map + 合成请求 reduce ==')
{
  const splitRepo = makeFixtureRepo()
  // 每模块 15 个 100KB 源文件（扫描层上限 256KB/文件）：合计 ≈439k token，超 420k 大档
  // 预算才触发观察批分割（0.10.8 起 110k–420k 区间直接大档单请求写完，不再分割）
  for (const mn of ['core', 'util']) {
    for (let i = 0; i < 15; i += 1) {
      fs.writeFileSync(path.join(splitRepo, mn, `${mn}${i}.py`), `${String(i).padStart(2, '0')}:` + 'y'.repeat(100 * 1024))
    }
  }
  execFileSync('git', ['add', '-A'], { cwd: splitRepo })
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'big'], { cwd: splitRepo })
  const mock = makeBatchMock()
  try {
    const r = await gen.execute({ cwd: splitRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '分割仓库提交即返回')
    const job = await waitJob(r.cwd, { timeout: 45000 })
    console.log('  notes:', (job?.notes ?? []).join(' | '))
    const obsPrompts = mock.batchPrompts().filter((p) => p.includes('你是 CodeWiki 文章观察员'))
    const composePrompts = mock.batchPrompts().filter((p) => p.includes('多个观察员分批通读'))
    check(obsPrompts.length === 10, `10 个观察批请求（2 模块 × 5 批，实际 ${obsPrompts.length}）`)
    check(obsPrompts.every((p) => !p.includes('你是 CodeWiki 文章作者')), '观察请求不是文章请求')
    check(composePrompts.length === 2, `2 个合成请求（每模块 1 个，实际 ${composePrompts.length}）`)
    check(composePrompts.every((p) => p.includes('分批观察')), '合成请求吃观察包')
    check(job?.stage === 'done', `job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(fs.existsSync(path.join(job.wikiPath, 'modules', 'core.md')), 'modules/core.md 经合成落盘')
    check(fs.existsSync(path.join(job.wikiPath, 'modules', 'util.md')), 'modules/util.md 经合成落盘')
    check(fs.readFileSync(path.join(job.wikiPath, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '分割文章照常进校对回写')
    check(!(job.notes ?? []).some((n) => n.includes('超单请求预算')), '文章阶段观察批全部装进单请求预算（无超档明示）')
  } finally {
    mock.restore()
    fs.rmSync(splitRepo, { recursive: true, force: true })
  }
}

// ============================ 单项目串行（0.10.0） ============================
console.log('== 单项目串行：已有项目在跑时新提交进 queued，前一个收尾后自动轮到 ==')
{
  const repoA = makeFixtureRepo()
  const repoB = makeFixtureRepo()
  const mockStall = makeBatchMock({ stall: true }) // A 的请求挂起不返回，A 长时间占住推进权
  try {
    const ra = await gen.execute({ cwd: repoA }, { agent: 'test-agent' })
    check(ra.submitted === true, '项目 A 提交即返回')
    // 等 A 真正离开 submitting 进入 plan（首个批量请求已挂起）
    let jobA = null
    for (let i = 0; i < 40; i += 1) {
      jobA = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.id === ra.jobId)
      if (jobA?.stage === 'articles') break
      await new Promise((r) => setTimeout(r, 150))
    }
    check(jobA?.stage === 'articles', `A 进入 articles 占住推进权（实际 ${jobA?.stage}）`)
    const rb = await gen.execute({ cwd: repoB }, { agent: 'test-agent' })
    check(rb.submitted === true, '项目 B 提交即返回')
    const jobB0 = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.id === rb.jobId)
    check(jobB0?.stage === 'queued', `B 进 queued 排队（实际 ${jobB0?.stage}）`)
    check((jobB0?.notes ?? []).some((n) => n.includes('单项目串行')), 'B 的 notes 说明单项目串行排队')
    check(jobB0?.pendingStage === 'articles', `B 预置 pendingStage=articles（实际 ${jobB0?.pendingStage}）`)
    // 排队期间 B 不发任何请求：A 之外的批量请求数不增长
    const before = mockStall.batchPrompts().length
    await new Promise((r) => setTimeout(r, 900))
    check(mockStall.batchPrompts().length === before, `B 排队期间零请求（${before} → ${mockStall.batchPrompts().length}）`)
    // 取消 A → B 自动轮到并跑完
    const ctlEp = main.endpoints.find((e) => e.path === '/api/codewiki/control')
    const resC = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'cancel', jobId: ra.jobId }), resC)
    check(resC.code === 200, '取消 A 被接受')
    mockStall.restore()
    const mock2 = makeBatchMock()
    try {
      const jobB = await waitJob(repoB, { timeout: 45000 })
      check(jobB?.stage === 'done', `A 收尾后 B 自动轮到并跑完（实际 ${jobB?.stage}，error ${jobB?.error ?? '-'}）`)
      check((jobB?.notes ?? []).some((n) => n.includes('排队结束，开始编译')), 'B 的 notes 记录排队结束')
      const jobA2 = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.id === ra.jobId)
      check(jobA2?.stage === 'cancelled', `A 终态 cancelled（实际 ${jobA2?.stage}）`)
    } finally {
      mock2.restore()
    }
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true })
    fs.rmSync(repoB, { recursive: true, force: true })
  }
}

// ============================ 唯一通道：宿主 llm 服务 ============================
console.log('== 全程走宿主 llm 服务：各阶段请求都经同一个 provider/model，插件零直连 ==')
{
  const smallRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  try {
    const r = await gen.execute({ cwd: smallRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '提交即返回')
    const job = await waitJob(r.cwd)
    console.log('  notes:', (job?.notes ?? []).join(' | '))
    check(job?.stage === 'done', `job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(job?.writtenCount >= 4 && job?.failedCount === 0, `编译 ${job?.writtenCount} 篇、失败 ${job?.failedCount} 篇`)
    check(mock.llmCalls.length > 0 && mock.llmCalls.every((c) => c.provider === 'workbuddy' && c.model === 'hy3'),
      '所有请求都经设置里的编译模型（workbuddy/hy3）')
    check(mock.llmCalls.every((c) => c.reasoningEffort === undefined), '未配置思考程度 → 不下发 reasoningEffort（用模型默认档）')
    check(mock.realtimePrompts().length > 0, 'llm.stream 已调用')
    const jobsEp = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    const resJobs = fakeRes()
    jobsEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resJobs)
    const summary = JSON.parse(resJobs.out).jobs.find((j) => j.id === r.jobId)
    check(summary?.tps > 0, `tps 采样聚合（summary.tps=${summary?.tps}）`)
    check(typeof summary?.stageStartedAt === 'string' && !!summary?.stageTimings
      && Object.keys(summary.stageTimings).length >= 1, 'summary 带阶段起始时刻与各阶段耗时')
    check(!!summary?.usage && summary.usage.outputTok > 0 && summary.usage.realtimeRequests > 0,
      `usage 输出实测/请求数累计（${JSON.stringify(summary?.usage)}）`)
    check(fs.existsSync(path.join(job.wikiPath, 'modules', 'core.md')), 'core.md 落盘')
    check(fs.existsSync(path.join(job.wikiPath, '_architecture.md')), '_architecture.md 落盘（keepInMemory 经 writeValidated）')
    check(fs.readFileSync(path.join(job.wikiPath, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '校对回写')
  } finally {
    mock.restore()
    fs.rmSync(smallRepo, { recursive: true, force: true })
  }
}

// ============================ stale 逐篇更新 ============================
console.log('== codewiki_generate stale 逐篇更新（预构建任务直达 articles 阶段） ==')
{
  fs.writeFileSync(path.join(mainRepo, 'core', 'core.py'), 'def run():\n    return "core-v2"\n')
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
    check(job?.writtenCount === 2, `恰好更新声明了 core.py 的 2 篇（实际 ${job?.writtenCount}，0.10.7 起无概念文章）`)
    const w = job.wikiPath
    check(fs.readFileSync(path.join(w, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '过期文章经批次重写并校对回写')
    check(!fs.readFileSync(path.join(w, 'modules', 'util.md'), 'utf8').includes('Stale-batch'), '未变更文章不动（util.md 保持全量版内容）')
  } finally {
    mock.restore()
  }
}

// ============================ codewiki_progress 只读查进度 ============================
console.log('== codewiki_progress：注册、cwd/jobId 过滤、百分比与明细 ==')
{
  // 终态 job：taskList 全 done，progress=100
  const doneRows = await prog.execute({ cwd: mainRepo }, { agent: 'test-agent' })
  check(doneRows.jobs.length >= 1 && doneRows.jobs.every((j) => j.cwd === mainRepo), '按 cwd 过滤返回该仓库任务（含大小写/斜杠归一化）')
  const last = doneRows.jobs[doneRows.jobs.length - 1]
  check(last?.stage === 'done' && last.progress === 100, `终态 job stage=done 且 progress=100（实际 ${last?.stage}/${last?.progress}）`)
  check((last?.taskList ?? []).length > 0 && last.taskList.every((t) => t.state === 'done'), 'progress 输出带全 done 的 taskList')
  check(typeof last?.usage === 'object' && last.usage !== null, 'progress 输出带 usage 用量块')
  // jobId 过滤 + 无匹配
  const byId = await prog.execute({ jobId: last.id }, { agent: 'test-agent' })
  check(byId.jobs.length === 1 && byId.jobs[0].id === last.id, '按 jobId 过滤返回单条')
  const none = await prog.execute({ jobId: 'job-does-not-exist' }, { agent: 'test-agent' })
  check(none.jobs.length === 0, 'jobId 无匹配时返回空列表')
  const other = await prog.execute({ cwd: 'C:/definitely-not-a-compiled-repo' }, { agent: 'test-agent' })
  check(other.jobs.length === 0, '其他仓库 cwd 无任务')
  // render：不抛错且含 stage 字样
  const text = prog.output.render({ cwd: mainRepo }, { jobs: doneRows.jobs }).map((x) => x.text).join('\n')
  check(/codewiki_progress/.test(text) && /stage=/.test(text) && /✓/.test(text), 'render 输出含任务头/stage/完成标记')
  // 进行中 job：百分比 = done/总数
  const midRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  try {
    const r = await gen.execute({ cwd: midRepo }, { agent: 'test-agent' })
    check(r.submitted === true, '进度查询用仓库已提交编译')
    const mid = (await prog.execute({ cwd: midRepo }, { agent: 'test-agent' })).jobs.find((j) => j.id === r.jobId)
    check(mid?.stage === 'articles' && (mid?.progress === null || (mid.progress >= 0 && mid.progress <= 100)),
      `进行中 job stage 正确且百分比合法（stage=${mid?.stage}，progress=${mid?.progress}）`)
    await waitJob(midRepo)
    const fin = (await prog.execute({ jobId: r.jobId }, { agent: 'test-agent' })).jobs[0]
    check(fin?.stage === 'done' && fin.progress === 100, `完成后 progress=100（实际 ${fin?.stage}/${fin?.progress}）`)
  } finally {
    mock.restore()
    fs.rmSync(midRepo, { recursive: true, force: true })
  }
}
console.log('== 0.6.0：宿主重启后任务按持久化 prompt 快照重跑 ==')
{
  // 场景 A：阶段任务（stage-*）停在 articles，执行器随进程丢失
  const repoA = makeFixtureRepo()
  const mock = makeBatchMock({ articleMarker: 'Restarted-batch' })
  const staleAt = new Date(Date.now() - 6 * 60000).toISOString()
  const articlePath = path.join(repoA, '.codewiki', 'modules', 'core.md')
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [{
    id: 'job-restart-batch', cwd: repoA, kind: 'full', scope: 'full', language: 'zh',
    stage: 'articles', owner: 'svc-dead-instance', wikiPath: path.join(repoA, '.codewiki'),
    plan: { project: 'fixture', modules: [{ name: 'core', summary: 'core summary', files: ['core/core.py'] }], concepts: [] },
    batchRef: { batchId: 'stage-job-restart-batch' },
    tasks: [{ customId: 't0', name: 'modules/core.md', articlePath, keepInMemory: false,
      batchPrompt: '你是 CodeWiki 文章作者。目标：为模块「core」撰写文章 modules/core.md（重启恢复快照）' }],
    articles: [], writtenCount: 0, failedCount: 0, notes: [],
    createdAt: staleAt, updatedAt: staleAt,
  }] }), 'utf8')
  try {
    const wx = makeCtx({})
    apply(wx.ctx, batchCfg())
    const job = await waitJob(repoA)
    check(job?.stage === 'done', `任务重启后重跑至终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(mock.batchPrompts().some((p) => p.includes('modules/core.md')), '重跑请求走普通端点')
    check(fs.readFileSync(articlePath, 'utf8').includes('PROOFED'), '重跑文章落盘并经校对回写（restart 版为校对输入）')
    check((job.notes ?? []).some((n) => n.includes('自动重跑阶段')), 'notes 记录重跑决策')
  } finally {
    mock.restore()
    fs.rmSync(repoA, { recursive: true, force: true })
  }

  // 场景 B：0.10.6 及更早的 plan 阶段任务（勘探员快照）——宿主升级后迁移到 articles，
  // 旧勘探员任务作废，按 localPlan 本地重建清单继续编译
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
    apply(wx.ctx, batchCfg())
    const job = await waitJob(repoB)
    check(job?.stage === 'done', `旧 plan 任务迁移后编译至终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(!mockB.batchPrompts().some((p) => p.includes('勘探员')), '旧勘探员快照作废（零勘探员请求）')
    check((job.notes ?? []).some((n) => n.includes('迁移到 articles')), 'notes 记录旧任务迁移决策')
    check((job.notes ?? []).some((n) => n.includes('规划：2 个模块')), '迁移后按 localPlan 重建模块清单')
  } finally {
    mockB.restore()
    fs.rmSync(repoB, { recursive: true, force: true })
  }
  try { fs.unlinkSync(JOBS_FILE) } catch { /* 测试清理 */ }
}

// ============================ 并发提交占位 + 多实例合并 ============================
console.log('== 并发提交占位（首个 tick 窗口）与 flush 磁盘合并 ==')
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
  const cc = makeCtx({})
  apply(cc.ctx, batchCfg({ serialProjects: false })) // 本块只验证提交占位与 flush 合并，不掺串行
  const gen2 = cc.registered.get('codewiki_generate')
  // 模型通道全部失败：本块不关心编译质量，只验证提交占位窗口不产生两个 job
  const mock = makeBatchMock()
  const failLlm = { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MOCK_OFF', message: 'mock off' } } } } }
  activeLlm = failLlm
  // 先串行走一次（cw init 建好 wiki 基线，提交因模型通道失败快速失败），
  // 避免并发对撞在 cw init 的 TOCTOU 上——本块只验证 submit 占位窗口
  try { await gen2.execute({ cwd: concRepo, scope: 'full' }, { agent: 'test-agent' }) } catch { /* mock 失败预期 */ }
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
    mock.restore()
    try { fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows 句柄延迟释放：留 tmp 自清 */ }
  }
}

// ============================ 面板端点与取消 ============================
console.log('== 面板端点：GET /api/codewiki/jobs、POST /api/codewiki/control（loopback 守卫 + 取消） ==')
{
  const cancelRepo = makeFixtureRepo()
  const mock = makeBatchMock({ stall: true }) // 请求挂起不返回，job 停在 articles 阶段等取消
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
    check(jobsPayload.jobs.every((j) => !('apiKey' in j)), 'jobs 列表无 apiKey 字段（插件不存密钥）')
    // 0.4.11：阶段中间进度与逐任务明细透出（stall 挂起：进度在、完成数为 0）
    await new Promise((r) => setTimeout(r, 900)) // 等一拍 tick：submitBatchFor 落盘 batchProgress
    const resProg = fakeRes()
    jobsEp.handler(fakeReq(), resProg)
    const progJob = JSON.parse(resProg.out).jobs.find((j) => j.id === r4.jobId)
    check(!!progJob?.batchProgress && progJob.batchProgress.total >= 1 && progJob.batchProgress.completed === 0,
      `阶段中间进度透出且无完成数（实际 ${JSON.stringify(progJob?.batchProgress)}）`)
    check(Array.isArray(progJob?.taskList) && progJob.taskList.length >= 1 && progJob.taskList.every((x) => x.state === 'pending'),
      `taskList 活动期为待办明细（实际 ${JSON.stringify(progJob?.taskList)?.slice(0, 120)}）`)
    const reposEp = main.endpoints.find((e) => e.path === '/api/codewiki/repos')
    const resRepos11 = fakeRes()
    await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resRepos11)
    const repoRow11 = (JSON.parse(resRepos11.out).repos ?? []).find((x) => x.cwd === cancelRepo)
    check(repoRow11?.lastJob?.taskList?.length >= 1 && repoRow11.lastJob.tps !== undefined && repoRow11.lastJob.batchProgress !== undefined,
      'repos 总览活动任务带 taskList/batchProgress/tps')
    check(typeof repoRow11?.lastJob?.batchSubmittedAt === 'string',
      `repos lastJob 带执行起始时刻（batchSubmittedAt=${repoRow11?.lastJob?.batchSubmittedAt}）`)
    check(typeof repoRow11?.articleCount === 'number', `repos 带 wiki 篇数（${repoRow11?.articleCount}）`)
    const sched11 = JSON.parse(resRepos11.out).scheduler
    check(sched11 && 'lastScanRepos' in sched11 && 'lastScanSubmitted' in sched11, 'scheduler 序列化带扫描统计字段')
    const resCancel = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'cancel', jobId: r4.jobId }), resCancel)
    check(resCancel.code === 200 && JSON.parse(resCancel.out).ok === true, '取消请求被接受')
    const job = await waitJob(cancelRepo)
    check(job?.stage === 'cancelled', `job 终态 cancelled（实际 ${job?.stage}）`)
    check((job?.notes ?? []).some((n) => n.includes('在途请求已中断')), '取消中断在途请求（未完成不计费语义）')
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

    // 4) 排除清单：compile 与直调都拒绝，报错同时返回命中的排除项（0.8.1）
    mainConfig.excludePaths = exRepo
    const resC2 = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'compile', cwd: exRepo }, '127.0.0.1', 'POST'), resC2)
    const c2 = JSON.parse(resC2.out)
    check(resC2.code === 400 && c2.ok === false && String(c2.error).includes('排除清单') && String(c2.error).includes('命中排除项') && String(c2.error).includes(exRepo), 'compile 对排除仓库 400 拒绝（报错含命中排除项）')
    let err = null
    try { await gen.execute({ cwd: exRepo }, { agent: 'test-agent' }) } catch (e) { err = e }
    check(err && String(err.message).includes('命中排除项') && String(err.message).includes(exRepo), '直调对排除仓库抛错（报错含命中排除项）')
    const sub = path.join(exRepo, 'packages', 'app')
    fs.mkdirSync(sub, { recursive: true })
    let err2 = null
    try { await gen.execute({ cwd: sub }, { agent: 'test-agent' }) } catch (e) { err2 = e }
    check(err2 && String(err2.message).includes('命中排除项') && String(err2.message).includes(exRepo), '子目录同样被排除（报错排除项为父目录条目）')
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
  const cfg2 = batchCfg()
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
    // 0.10.5：工作区外的**非终态**任务不受 workspaceOnly 过滤——单项目串行下
    // 闸门可能被一个不在工作区清单里的项目（如 worktree）占住，藏掉它用户
    // 既看不到谁在编译也无法取消。stall 占住 rC 在 articles 阶段，断言后取消：
    const stalledC = makeBatchMock({ stall: true })
    // scope=full：rB 编译后 outsideRepo 的 wiki 已最新，auto 会被 "Wiki is up to date" 短路不提交
    const rC = await gen2.execute({ cwd: outsideRepo, scope: 'full' }, { agent: 'test-agent' })
    check((await readJobs()).some((j) => j.cwd === outsideRepo && !['done', 'failed', 'cancelled'].includes(j.stage)),
      '工作区外非终态任务仍显示（排队/编译中不被 workspaceOnly 藏掉）')
    const resRC = fakeRes()
    await epRepos.handler(fakeReq({}, '127.0.0.1', 'GET'), resRC)
    check((JSON.parse(resRC.out).repos ?? []).some((r) => r.cwd === outsideRepo),
      '总览放行工作区外非终态任务（编译中仓库可见）')
    const ctlEp2 = wx.endpoints.find((e) => e.path === '/api/codewiki/control')
    await ctlEp2.handler(fakeReq({ action: 'cancel', jobId: rC.jobId }, '127.0.0.1', 'POST'), fakeRes())
    await waitJob(rC.cwd)
    stalledC.restore()
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
  const cfg2 = batchCfg()
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
  const cfg2 = batchCfg()
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
  const cfg2 = batchCfg()
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

// ============================ 编译模型缺失诚实报错（0.10.1） ============================
console.log('== 编译模型/provider 缺失：诚实报错，不降级子代理、不静默跑空 ==')
{
  const noCfgRepo = makeFixtureRepo()
  const noCfg = makeCtx({})
  apply(noCfg.ctx, { batchProvider: '', batchModel: '' })
  let err = null
  try { await noCfg.registered.get('codewiki_generate').execute({ cwd: noCfgRepo }, { agent: 'test-agent' }) } catch (e) { err = e }
  check(err && String(err.message).includes('编译模型提供商为空'), `provider 留空 → 报错指向设置项（实际 ${err?.message?.slice(0, 40)}…）`)
  // 失败必须落成 job 的 failed 态（可观测，而不是凭空消失）
  const failedJob = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.cwd === noCfgRepo)
  check(failedJob?.stage === 'failed' && String(failedJob?.error ?? '').includes('编译模型'), `失败留痕在 job（stage=${failedJob?.stage}）`)
  fs.rmSync(noCfgRepo, { recursive: true, force: true })
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
  apply(cc.ctx, batchCfg())
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
