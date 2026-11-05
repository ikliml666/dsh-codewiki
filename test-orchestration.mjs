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
// 自动调度测试不真等一分钟：心跳压缩到 100ms，仍走 apply 里的真实 autoScan。
process.env.DSH_CODEWIKI_AUTO_SCAN_MS = '100'

const here = path.dirname(fileURLToPath(import.meta.url))
// 主工作区根：测试常在本仓库的 linked worktree 里跑，而 worktree 目录被编译对象闸门
// 有意排除（1.2.1），拿 here 当「正常仓库」会得到假失败。
const mainRepoRoot = (() => {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim()
    return path.dirname(common)
  } catch { return here }
})()
// 独立 JOBS_FILE：与真实宿主服务实例（同机共享默认路径）隔离，避免互相洗写。
// 0.10.10：文件名追加随机串——只用 pid 时，历史运行留在 tmp 里的同名文件会在 pid 复用时
// 被原样读入（旧文件里有 job-tmp-active 等 fixture 任务），让「单项目串行」误判为已有项目在编译、
// 后续提交全部 queued，表现为「偶发 20 项失败」。收尾统一删除，不留残留。
const TEST_JOB_TOKEN = crypto.randomBytes(4).toString('hex')
process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `dsh-codewiki-jobs-test-${process.pid}-${TEST_JOB_TOKEN}.json`)
const { name, apply, SESSIONS_DIR, reposFileFor } = await import('./index.js')

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
// 本套测试全部断言的是**兼容通道**（nativeEngine=false，插件内 Node 流水线）的请求次数、
// 装填方式与落盘时序（llm.stream 调用次数、单轮全文、core.md 直接落盘）。0.16.0 阶段 7
// 起 nativeEngine 默认 true，不在这里钉住 false 的话整条链路会走原生引擎（需要真 Python
// 环境），断言会因「通道换了」而不是「功能坏了」失败。原生通道的验证见
// test-engine-native-job.mjs 与 test-engine-native-incremental.mjs。
const LEGACY_CHANNEL = { nativeEngine: false }
const batchCfg = (extra = {}) => ({ batchProvider: 'workbuddy', batchModel: 'hy3', ...LEGACY_CHANNEL, ...extra })

// mock 宿主上下文：按 inject 依赖路由；webServer/tools/agents/llm 全部可捕获。
// inject 同时支持 cordis 两种风格：带回调（apply 注册）与 promise（await ctx.inject([...])）
// 0.10.1：插件不再解析任何凭证（无自带直连通道），llm 服务是唯一模型通道——
// 默认注入转发到 activeLlm 的 llmProxy，块内 makeBatchMock() 换掉 activeLlm 即可。
// 块间隔离：每个 makeCtx 都建出一个带 setInterval(tick) 的 JobService，共享同一个
// JOBS_FILE。块结束时 fixture 目录被删、实例却还在 tick，残留的未终态任务会占住单项目
// 串行闸门（serialProjects 默认 true → parallelLimit=1），让后续块的新任务永远 queued。
// 因此每个顶层块开始前把上一块建出的实例全部停掉（disposer 即 service.stop()，重复调用无害）。
// 主链路实例标记为 persistent，不参与清理。
const liveCtxs = []
let persistentCtx = null
async function cleanupServices() {
  // 先取消、再停实例：顺序反了就没救。取消只是写一个标记，得由**拥有该任务的、还活着的
  // 实例**在自己的 tick 里收尾；实例一旦停掉，它的任务就再没人推进，只能等
  // ORPHAN_TAKEOVER_MS（默认 5 分钟）被别的实例接管，这期间一直占着单项目串行闸门。
  const ctl = persistentCtx?.endpoints?.find((e) => e.path === '/api/codewiki/control')
  if (ctl) {
    const readJobs = async () => {
      let data = null
      for (let i = 0; i < 20 && !data; i += 1) {
        try { data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')) } catch { /* 写入中途：稍后重试 */ }
        if (!data) await new Promise((r) => setTimeout(r, 25))
      }
      return data?.jobs ?? []
    }
    const isLive = (j) => !['done', 'partial', 'failed', 'cancelled'].includes(j.stage)
    let left = (await readJobs()).filter(isLive)
    if (left.length) {
      for (const job of left) {
        if (job.cancelRequested) continue
        await ctl.handler(fakeReq({ action: 'cancel', jobId: job.id }), fakeRes())
      }
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
        left = (await readJobs()).filter(isLive)
        if (!left.length) break
      }
      // 仍然非终态 = 没有活着的实例会推进它（块内手写的外来任务 fixture、或实例已被停掉）。
      // 从作业文件里摘掉即可：主实例的 mergeFromDisk 会把这些磁盘上已不存在的他人任务当幽灵回收，
      // 闸门随之释放。真正「该跑完却卡住」的用例会先在 waitJob 里失败，不靠这里兜。
      if (left.length) {
        const drop = new Set(left.map((j) => j.id))
        const disk = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
        disk.jobs = (disk.jobs ?? []).filter((j) => !drop.has(j.id))
        fs.writeFileSync(JOBS_FILE, JSON.stringify(disk), 'utf8')
      }
    }
  }
  const keep = []
  for (const made of liveCtxs) {
    if (made === persistentCtx) { keep.push(made); continue }
    for (const dispose of made.disposers.splice(0)) dispose()
  }
  liveCtxs.length = 0
  liveCtxs.push(...keep)
}

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
  const made = { ctx, registered, endpoints, listeners, disposers }
  liveCtxs.push(made)
  return made
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
  resolveModelInfo: (...a) => (activeLlm ? activeLlm.resolveModelInfo(...a) : null),
}
const promptOf = (opts) => String(opts?.messages?.[0]?.content?.[0]?.text ?? '')

// mock 宿主 llm 服务：全部环节都是单轮 chat 后台并发池。
// 按 prompt 首行特征分发应答（与真实 prompt 模板的区分句一一对应）。
function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false, efforts = [] } = {}) {
  const llmCalls = []
  const answerFor = (prompt) => {
    if (prompt.includes('你是 CodeWiki 文章观察员')) {
      // 文章分割观察批：应答一段观察文本（合成阶段凭它产文）
      return '观察：模块职责与关键实现（来自分批观察）。\n\n文件清单：见上文。\n'
    }
    // agentic 文章通道（0.17.5 起唯一通道）：首轮提示词是「任务：为模块「X」撰写文章 modules/x.md」，
    // 没有工具调用就视为写完，正文即文章。契约闸门要求 frontmatter 的 type 与 source_files 正确，
    // 所以这里和 stale 分支一样按目标位置给类型与真实 fixture 路径。
    if (prompt.includes('可用工具：')) {
      // stale 的 mission 形如「更新过期文章 modules/core.md：...」，全量的形如
      // 「为模块「core」撰写文章 modules/core.md：...」；目标是行首的路径，后面可能跟冒号。
      const mission = (prompt.match(/^任务：(.+)$/m) ?? [])[1] ?? ''
      // 全量 mission 是「为模块「core」撰写文章 modules/core.md」——路径里可能带全角冒号说明
      const target = (mission.match(/(?:更新过期文章|撰写文章)\s+((?:modules|concepts|learnings)\/[^\s：]+|_(?:architecture|patterns)\.md)/) ?? [])[1]
      if (target) {
        // 目标自带目录前缀（modules/、concepts/、learnings/），file 是裸文件名
        const file = target.split('/').pop().replace(/\.md$/, '')
        const type = target === '_architecture.md' ? 'architecture'
          : target === '_patterns.md' ? 'pattern'
            : target.startsWith('concepts/') ? 'concept'
              : target.startsWith('learnings/') ? 'learning' : 'module'
        const src = target === '_architecture.md' ? 'core/core.py'
          : target === '_patterns.md' ? 'util/util.py'
            : `${file}/${file}.py`
        // 大 wiki 用例靠「文章本身很长」把横切输入顶过预算，从而触发观察批拆分
        return articleMd(target, src, articleMarker, type) + (bigArticle ? `\n\n${'长'.repeat(70000)}` : '')
      }
    }
    if (prompt.includes('你是 CodeWiki 文章作者')) {
      // stale 逐篇更新：目标文章名写在任务 mission 里。文章契约闸门（0.14.0）会校验
      // type 与所在目录一致，所以 fixture 必须按目标位置给对类型——根目录 _architecture.md
      // 是 architecture、concepts/ 是 concept，其余按 module。
      const staleName = (prompt.match(/更新过期文章\s+(\S+?)：/) ?? [])[1]
      if (staleName) {
        const type = staleName === '_architecture.md' ? 'architecture'
          : staleName === '_patterns.md' ? 'pattern'
            : staleName.startsWith('concepts/') ? 'concept'
              : staleName.startsWith('learnings/') ? 'learning' : 'module'
        // 根级文章：_architecture.md 基于 core/core.py（随 core.py 变更过期），
        // _patterns.md 基于 util/util.py（不被 core.py 变更波及，用来验证「未变更文章不动」）。
        // 其余按 modules/<名>.md → <名>/<名>.py。契约闸门会校验 source_files 真实存在，
        // 所以这里必须造出 fixture 里确实有的路径，不能凭空拼。
        const src = staleName === '_architecture.md' ? 'core/core.py'
          : staleName === '_patterns.md' ? 'util/util.py'
            : staleName.replace(/^modules\//, '').replace(/\.md$/, '/') + `${staleName.replace(/^modules\//, '').replace(/\.md$/, '')}.py`
        return articleMd(staleName, src, articleMarker, type)
      }
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
          const fm = (body.match(/---\r?\ntitle:[\s\S]*?\r?\n---/) ?? [])[0]
          return `@@@article: ${n}\n${fm ?? `---\ntitle: ${n}\n---`}\n\nPROOFED article.\n@@@end`
        }).join('\n')
      }
      const fm = prompt.match(/---\r?\ntitle:[\s\S]*?\r?\n---/)
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
    // 模型目录里的思考档位：提交闸门要按它校验 reasoningEffort，空数组 = 未声明（闸门放行）
    resolveModelInfo: async () => ({ reasoning: { efforts } }),
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
    if (job && ['done', 'partial', 'failed', 'cancelled'].includes(job.stage)) return job
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
await cleanupServices()
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
await cleanupServices()
console.log('== 注册 ==')
const mainRepo = makeFixtureRepo()
const e2eSteers = [] // 编译终态 steer 唤醒捕获（sess-e2e 专属）
const main = makeCtx({ agentGet: (id) => (id === 'sess-e2e' ? { steer: (m) => e2eSteers.push({ id, m }) } : undefined) })
persistentCtx = main
const mainConfig = batchCfg()
apply(main.ctx, mainConfig)
check(name === 'dsh-codewiki', `插件名 ${name}`)
check(main.registered.get('cw') && main.registered.get('codewiki_generate'), 'cw 与 codewiki_generate 两个工具均已注册')
const gen = main.registered.get('codewiki_generate')
const cwTool = main.registered.get('cw')
const prog = main.registered.get('codewiki_progress')
check(!!prog, 'codewiki_progress 工具已注册')

await cleanupServices()
console.log('== cw 工具 ==')
{
  const st = await cwTool.execute({ cwd: mainRepo, args: ['status'] })
  check(st.exitCode === 0 && /No wiki found/i.test(st.stdout), 'cw status 判定 missing 态')
}

// ============================ codewiki_update 工具 + 提交提醒 ============================
await cleanupServices()
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
      // 0.10.10：自动提交成功/产物无改动的任务一律静默——不必再查 git log。
      // 用「没有 .codewiki 提交史」的全新仓库，确保静默不是 git 时间戳凑巧造成的。
      const repo5 = makeFixtureRepo()
      try {
        const fresh = new Date().toISOString()
        const h6 = commitHintText(repo5, [{ id: 'job-ac-ok', cwd: repo5, stage: 'done', writtenCount: 3, finishedAt: fresh, autoCommit: { committed: true, sha: 'feed123' } }])
        check(h6 === '', 'autoCommit.committed → 提示 section 静默（插件已提交，无需会话模型动手）')
        const h7 = commitHintText(repo5, [{ id: 'job-ac-none', cwd: repo5, stage: 'done', writtenCount: 3, finishedAt: fresh, autoCommit: { committed: false, noChanges: true } }])
        check(h7 === '', 'autoCommit.noChanges → 提示 section 也静默（无改动可提交，不催）')
      } finally { fs.rmSync(repo5, { recursive: true, force: true }) }
      // 提交被拒（pending）且编译晚于最后一次 wiki 提交 → 仍要提醒，且带上失败原因
      const repo6 = makeFixtureRepo()
      try {
        fs.mkdirSync(path.join(repo6, '.codewiki'))
        fs.writeFileSync(path.join(repo6, '.codewiki', 'a.md'), 'x\n')
        const g6 = (...a) => execFileSync('git', a, { cwd: repo6 })
        g6('add', '.')
        g6('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'wiki first')
        await new Promise((r) => setTimeout(r, 1100))
        const h8 = commitHintText(repo6, [{
          id: 'job-ac-fail', cwd: repo6, stage: 'done', writtenCount: 2,
          finishedAt: new Date().toISOString(), autoCommit: { committed: false, reason: '不是 git 仓库' },
        }])
        check(h8.includes('产物待提交') && h8.includes('不是 git 仓库'), '提交被拒（pending）→ 提醒且带自动提交失败原因')
      } finally { fs.rmSync(repo6, { recursive: true, force: true }) }
    } finally { fs.rmSync(repo2, { recursive: true, force: true }) }
  } finally { fs.rmSync(hintRepo, { recursive: true, force: true }) }
}

// ============================ autoCommitWiki：插件自己提交编译产物（0.10.11 分支合并式） ============================
await cleanupServices()
console.log('== autoCommitWiki：安全边界（主题分支提交→合并回原分支；可疑状态一律拒绝） ==')
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
    check(r.mode === 'branch' && String(r.branch).startsWith('codewiki/wiki-'), `走分支合并式（mode ${r.mode}，branch ${r.branch ?? '-'}）`)
    const leftTopics = execFileSync('git', ['-C', okRepo, 'branch', '--list', 'codewiki/*'], { encoding: 'utf8' }).trim()
    check(leftTopics === '', `合并后主题分支已删除（codewiki/* 剩余：${leftTopics || '无'}）`)
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

  // detached HEAD：没有「原分支」可回 → 降级直接提交（与 0.10.9 行为一致）
  const detRepo = makeFixtureRepo()
  try {
    execFileSync('git', ['-C', detRepo, 'checkout', '--detach'], { encoding: 'utf8' })
    fs.mkdirSync(path.join(detRepo, '.codewiki'))
    fs.writeFileSync(path.join(detRepo, '.codewiki', 'a.md'), '# a\n')
    const r = autoCommitWiki(detRepo, { jobId: 'job-det' })
    check(r.committed === true && r.mode === 'direct' && String(r.fallback).includes('detached'), `detached HEAD → 降级直接提交（mode ${r.mode}，fallback ${r.fallback ?? '-'}）`)
  } finally { fs.rmSync(detRepo, { recursive: true, force: true }) }

  // 主题分支名已被占用（上次编译异常退出留下的分支）→ switch -c 失败 → 降级为直接提交，
  // 且预占分支绝不被误删。同步流程内原分支不会再前进，merge 恒为 fast-forward，真正的
  // add/add 冲突（编译期间用户在原分支推进）在黑盒测试里构造不出来——index.js 里的
  // 「merge 失败 → abort + 保留主题分支」是防御性路径，不在单测覆盖内。
  const usedRepo = makeFixtureRepo()
  try {
    fs.mkdirSync(path.join(usedRepo, '.codewiki'))
    fs.writeFileSync(path.join(usedRepo, '.codewiki', 'a.md'), '# a\n')
    fs.writeFileSync(path.join(usedRepo, 'CodeWiki.md'), '# entry\n')
    execFileSync('git', ['-C', usedRepo, 'branch', 'codewiki/wiki-job-used'], { encoding: 'utf8' }) // 预占主题分支名
    const r = autoCommitWiki(usedRepo, { jobId: 'job-used' })
    check(r.committed === true && r.mode === 'direct' && String(r.fallback).includes('建主题分支失败'), `主题分支名被占用 → 降级直接提交（mode ${r.mode}，fallback ${r.fallback ?? '-'}）`)
    const kept = execFileSync('git', ['-C', usedRepo, 'branch', '--list', 'codewiki/*'], { encoding: 'utf8' }).trim()
    check(kept.includes('codewiki/wiki-job-used'), `预占分支未被误删（codewiki/*：${kept}）`)
  } finally { fs.rmSync(usedRepo, { recursive: true, force: true }) }
}

// ============================ autoCommitState：三态判定的唯一来源 ============================
await cleanupServices()
console.log('== autoCommitState：committed / no-changes / pending 三态（唤醒与提醒两条通道共用） ==')
{
  const { autoCommitState } = await import('./index.js')
  check(autoCommitState({ autoCommit: { committed: true, sha: 'abc1234' } }) === 'committed', 'committed=true → committed')
  check(autoCommitState({ autoCommit: { committed: false, noChanges: true } }) === 'no-changes', 'noChanges=true → no-changes（无需提交）')
  check(autoCommitState({ autoCommit: { committed: false, reason: '不是 git 仓库' } }) === 'pending', '提交被拒且有原因 → pending（要降级提醒）')
  check(autoCommitState({}) === 'pending', '旧 job 无 autoCommit 字段 → pending（与 0.10.9 之前行为一致）')
  check(autoCommitState(null) === 'pending' && autoCommitState(undefined) === 'pending', 'job 为空 → pending，不抛')
  check(autoCommitState({ autoCommit: { committed: true, noChanges: true } }) === 'committed', 'committed 优先于 noChanges（已提交就是终态）')
}

// ============================ wakeCompileSession：编译终态 steer 唤醒 ============================
await cleanupServices()
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
  // 0.10.10：产物本就无改动 → 同样零唤醒。旧实现只看 committed，此处会把「无需提交」
  // 当成失败去催会话模型提交一个不存在的东西（两轴评审 S1）。
  wakeCompileSession({ ...doneJob, autoCommit: { committed: false, noChanges: true } }, 'done', fakeAgents)
  check(steered.length === 0, 'noChanges（产物无改动）→ done 也完全不唤醒（不催提交不存在的东西）')
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
await cleanupServices()
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
    const r = await mmGen.execute({ cwd: mmRepo, confirmed: true }, { agent: { id: 'sess-mm' } })
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
    const r = await pGen.execute({ cwd: panelRepo, confirmed: true }, { agent: 'test-agent' })
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
await cleanupServices()
console.log('== codewiki_generate 全量编译：提交即返回，服务推进阶段机 ==')
{
  const mock = makeBatchMock()
  try {
    const r1 = await gen.execute({ cwd: mainRepo, confirmed: true }, { agent: { id: 'sess-e2e' } })
    console.log('  notes:', r1.notes.join(' | '))
    check(r1.submitted === true && typeof r1.jobId === 'string', '提交即返回（jobId 非空）')
    check(r1.stage === 'articles', `初始 stage=articles（实际 ${r1.stage}）`)
    check(r1.writtenCount === undefined, '返回值不含 writtenCount（编译交服务，不再就地等待）')
    const job = await waitJob(r1.cwd)
    check(!mock.batchPrompts().some((p) => p.includes('勘探员')), '零规划请求（宿主 llm 通道只跑文章/横切/校对）')
    check(job?.stage === 'done', `服务 job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    check(job?.writtenCount >= 3 && job?.failedCount === 0, `编译完成 ${job?.writtenCount} 篇、失败 ${job?.failedCount} 篇（2 模块+架构+模式）`)
    check(job?.autoCommit?.committed === true && /^[0-9a-f]{7,}$/.test(String(job.autoCommit.sha ?? '')), `编译产物由插件自动提交（sha ${job?.autoCommit?.sha ?? '-'}）`)
    check(!!job?.stageTimings?.commit, `任务走过了独立的 commit 阶段（阶段计时含：${Object.keys(job?.stageTimings ?? {}).join('/')}）`)
    check(job?.autoCommit?.mode === 'branch', `端到端走分支合并式（mode ${job?.autoCommit?.mode ?? '-'}，branch ${job?.autoCommit?.branch ?? '-'}）`)
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

// ============================ 大 wiki：横切输入超预算 → 大档单批直出 ============================
await cleanupServices()
console.log('== 大 wiki：模块文章总量超预算 → 横切按大档单批直出（不再拆观察批） ==')
{
  const bigRepo = makeFixtureRepo()
  const mock = makeBatchMock({ bigArticle: true })
  try {
    const r = await gen.execute({ cwd: bigRepo, confirmed: true }, { agent: 'test-agent' })
    check(r.submitted === true, '大 wiki 提交即返回')
    const job = await waitJob(r.cwd)
    check(job?.stage === 'done', `服务 job 终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)
    // 0.17.5 起横切没有「观察批 map + 合成批 reduce」这条路径：整篇装填（超预算只截头部）
    // 后单批直出，总量超普通预算就整批换大档模型。这里钉住的是这条唯一路径。
    check(!mock.batchPrompts().some((p) => p.includes('架构观察员')), '不再产生横切观察请求（拆分路径已删）')
    check(!mock.batchPrompts().some((p) => p.includes('文章观察员')), '不再产生文章观察批请求（拆分路径已删）')
    check((job.notes ?? []).some((n) => n.includes('横切批次已提交')), '横切输入超普通预算仍单批提交（截头部保装填，不拆批）')
    check(fs.existsSync(path.join(job.wikiPath, '_architecture.md')), '_architecture.md 落盘')
    check(fs.existsSync(path.join(job.wikiPath, '_patterns.md')), '_patterns.md 落盘')
    check(fs.readFileSync(path.join(job.wikiPath, 'modules', 'core.md'), 'utf8').includes('PROOFED'), '大 wiki 校对批次照常回写（动态预算）')
  } finally {
    mock.restore()
    fs.rmSync(bigRepo, { recursive: true, force: true })
  }
}

// ============================ 单项目串行（0.10.0） ============================
await cleanupServices()
console.log('== 单项目串行：已有项目在跑时新提交进 queued，前一个收尾后自动轮到 ==')
{
  const repoA = makeFixtureRepo()
  const repoB = makeFixtureRepo()
  const mockStall = makeBatchMock({ stall: true }) // A 的请求挂起不返回，A 长时间占住推进权
  try {
    const ra = await gen.execute({ cwd: repoA, confirmed: true }, { agent: 'test-agent' })
    check(ra.submitted === true, '项目 A 提交即返回')
    // 等 A 真正离开 submitting 进入 plan（首个批量请求已挂起）
    let jobA = null
    for (let i = 0; i < 40; i += 1) {
      jobA = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.id === ra.jobId)
      if (jobA?.stage === 'articles') break
      await new Promise((r) => setTimeout(r, 150))
    }
    check(jobA?.stage === 'articles', `A 进入 articles 占住推进权（实际 ${jobA?.stage}）`)
    const rb = await gen.execute({ cwd: repoB, confirmed: true }, { agent: 'test-agent' })
    check(rb.submitted === true, '项目 B 提交即返回')
    const jobB0 = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.id === rb.jobId)
    check(jobB0?.stage === 'queued', `B 进 queued 排队（实际 ${jobB0?.stage}）`)
    check((jobB0?.notes ?? []).some((n) => n.includes('单项目串行')), 'B 的 notes 说明单项目串行排队')
    check(jobB0?.pendingStage === 'articles', `B 预置 pendingStage=articles（实际 ${jobB0?.pendingStage}）`)
    // queueAhead（1.1.0）：queued 任务的 jobs 响应带「在等谁」（正在跑的 A）
    {
      const jobsEpQ = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
      const resQ = fakeRes()
      jobsEpQ.handler(fakeReq({}, '127.0.0.1', 'GET'), resQ)
      const sumB = JSON.parse(resQ.out).jobs.find((j) => j.id === rb.jobId)
      check(Array.isArray(sumB?.queueAhead) && sumB.queueAhead.length === 1 && sumB.queueAhead[0] === path.basename(repoA),
        `jobs 端点带 queueAhead 在等谁（实际 ${JSON.stringify(sumB?.queueAhead)}）`)
    }
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

// ============================ 并行项目上限（1.1.0） ============================
await cleanupServices()
console.log('== 并行项目上限：关闭单项目串行后多仓库同时推进，不再互相排队 ==')
{
  const repoA = makeFixtureRepo()
  const repoB = makeFixtureRepo()
  const mock = makeBatchMock()
  try {
    const cc2 = makeCtx({})
    apply(cc2.ctx, batchCfg({ serialProjects: false, parallelProjects: 3 }))
    const gen2 = cc2.registered.get('codewiki_generate')
    const ra = await gen2.execute({ cwd: repoA, confirmed: true }, { agent: 'test-agent' })
    const rb = await gen2.execute({ cwd: repoB, confirmed: true }, { agent: 'test-agent' })
    check(ra.submitted === true && rb.submitted === true, 'A/B 相继提交即返回')
    // B 不应停留 queued：并行上限 3 下两个项目各自推进
    let jobB = null
    for (let i = 0; i < 60; i += 1) {
      jobB = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.id === rb.jobId)
      if (jobB?.stage !== 'queued' && jobB?.stage !== 'submitting') break
      await new Promise((r) => setTimeout(r, 150))
    }
    check(jobB?.stage !== 'queued' && jobB?.stage !== 'submitting', `B 不排队直接推进（实际 ${jobB?.stage}）`)
    const jobA = await waitJob(repoA, { timeout: 45000 })
    const jobB2 = await waitJob(repoB, { timeout: 45000 })
    check(jobA?.stage === 'done' && jobB2?.stage === 'done', `A/B 并行各自跑完（A=${jobA?.stage} B=${jobB2?.stage}）`)
  } finally {
    mock.restore()
    fs.rmSync(repoA, { recursive: true, force: true })
    fs.rmSync(repoB, { recursive: true, force: true })
  }
}

// ============================ 唯一通道：宿主 llm 服务 ============================
await cleanupServices()
console.log('== 全程走宿主 llm 服务：各阶段请求都经同一个 provider/model，插件零直连 ==')
{
  const smallRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  try {
    const r = await gen.execute({ cwd: smallRepo, confirmed: true }, { agent: 'test-agent' })
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
await cleanupServices()
console.log('== codewiki_generate stale 逐篇更新（预构建任务直达 articles 阶段） ==')
{
  fs.writeFileSync(path.join(mainRepo, 'core', 'core.py'), 'def run():\n    return "core-v2"\n')
  execFileSync('git', ['add', '-A'], { cwd: mainRepo })
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'v2'], { cwd: mainRepo })
  const mock = makeBatchMock({ articleMarker: 'Stale-batch' })
  try {
    const r2 = await gen.execute({ cwd: mainRepo, scope: 'stale', confirmed: true }, { agent: 'test-agent' })
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
await cleanupServices()
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
    const r = await gen.execute({ cwd: midRepo, confirmed: true }, { agent: 'test-agent' })
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
await cleanupServices()
console.log('== 0.6.0：宿主重启后任务按持久化 prompt 快照重跑 ==')
{
  // 场景 A：阶段任务（stage-*）停在 articles，执行器随进程丢失
  const repoA = makeFixtureRepo()
  // 真实重启的任务都来自一次 submit：codewiki_generate 在 state=missing 时已 cw init，
  // 库骨架（_meta.yaml）因此一定存在。手写快照要还原同样的现场，否则基线一步必然失败。
  execFileSync('cw', ['init'], { cwd: repoA, stdio: 'ignore' })
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
  execFileSync('cw', ['init'], { cwd: repoB, stdio: 'ignore' })
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
await cleanupServices()
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
  // 模型通道一律挂起（stall）：任务停在 articles 阶段、不会自己进终态。
  // 这是本块稳定性的关键——旧版用「模型失败」当 mock，任务会在几百毫秒内 failed（终态），
  // 第二次 execute 的 await 还没走完就到 submit，查不到活动任务 → 新建第二个 job，
  // 偶发报「并发提交共享同一 job」失败（与占位逻辑无关，纯测试竞态）。
  const mock = makeBatchMock({ stall: true })
  // 先串行走一次（cw init 建好 wiki 基线），避免并发对撞在 cw init 的 TOCTOU 上；
  // 该任务挂起在 articles，随后由 control 取消，不污染并发断言。
  const cancelOne = async (jobId) => {
    const ctl = cc.endpoints.find((e) => e.path === '/api/codewiki/control')
    const res = fakeRes()
    await ctl.handler(fakeReq({ action: 'cancel', jobId }), res)
    return res
  }
  try {
    const first = await gen2.execute({ cwd: concRepo, scope: 'full', confirmed: true }, { agent: 'test-agent' })
    await cancelOne(first.jobId)
    await waitJob(concRepo)
    const [ra, rb] = await Promise.all([
      gen2.execute({ cwd: concRepo, scope: 'full', confirmed: true }, { agent: 'test-agent' }),
      gen2.execute({ cwd: concRepo, scope: 'full', confirmed: true }, { agent: 'test-agent' }),
    ])
    check(ra.jobId && ra.jobId === rb.jobId, `并发提交共享同一 job（${ra.jobId} vs ${rb.jobId}）`)
    await cancelOne(ra.jobId) // 挂起任务收尾，让 flush 落盘
    await waitJob(concRepo)
    const after = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
    check((after.jobs ?? []).some((j) => j.id === 'job-external-1'), 'flush 合并后另一实例的 job 不丢失')
  } finally {
    mock.restore()
    try { fs.rmSync(concRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows 句柄延迟释放：留 tmp 自清 */ }
  }
}

// ============================ 面板端点与取消 ============================
await cleanupServices()
console.log('== 面板端点：GET /api/codewiki/jobs、POST /api/codewiki/control（loopback 守卫 + 取消） ==')
{
  const cancelRepo = makeFixtureRepo()
  const mock = makeBatchMock({ stall: true }) // 请求挂起不返回，job 停在 articles 阶段等取消
  try {
    const r4 = await gen.execute({ cwd: cancelRepo, confirmed: true }, { agent: 'test-agent' })
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

// 面板总览每个仓库显示的「上次编译」必须是**真正最新的那个任务**。
// 真机缺陷（0.17.10 期间）：putCwd 用「先到者胜」，而 service.list() 按提交顺序返回，
// 于是同仓有多个任务时永远显示最旧的那个——五个仓库明明有任务在跑，总览却全标「失败」。
// 面板总览每个仓库显示的「上次编译」必须是**真正最新的那个任务**。
// 真机缺陷（0.17.10 期间）：putCwd 用「先到者胜」，而 service.list() 按提交顺序返回，
// 于是同仓有多个任务时永远显示最旧的那个——五个仓库明明刚被拉起在跑，总览却齐刷刷
// 标着「失败」（三小时前那批 env 阶段失败的旧任务）。
const { pickOverviewJob } = await import('./index.js')

async function repoOverviewPicksLatestJob() {
  const mk = (id, stage, updatedAt) => ({ id, stage, updatedAt })
  // 1) 有活动任务时必须优先显示它，哪怕旧的更新时间更晚（时钟漂移/收尾补写）
  const withActive = [mk('a', 'failed', '2026-11-02T10:00:00.000Z'), mk('b', 'queued', '2026-11-01T00:00:00.000Z')]
  check(pickOverviewJob(withActive)?.id === 'b', `活动任务优先于旧的失败任务（实际 ${pickOverviewJob(withActive)?.id}）`)
  // 2) 都是终态时取更新时间最新的
  const allTerminal = [mk('c', 'failed', '2026-11-01T00:00:00.000Z'), mk('d', 'done', '2026-11-02T00:00:00.000Z')]
  check(pickOverviewJob(allTerminal)?.id === 'd', `终态之间取最新（实际 ${pickOverviewJob(allTerminal)?.id}）`)
  // 3) 多个活动任务取最新的那个
  const twoActive = [mk('e', 'articles', '2026-11-02T01:00:00.000Z'), mk('f', 'queued', '2026-11-02T02:00:00.000Z')]
  check(pickOverviewJob(twoActive)?.id === 'f', `多个活动任务取最新（实际 ${pickOverviewJob(twoActive)?.id}）`)
  // 4) 空输入与脏输入不炸
  check(pickOverviewJob([]) === null && pickOverviewJob(null) === null && pickOverviewJob([null, {}]) === null,
    '空/脏输入返回 null')
  // 5) finishedAt 兜底：老 job 没有 updatedAt 时也要能比较
  const legacy = [{ id: 'g', stage: 'done', finishedAt: '2026-11-01T00:00:00.000Z' }, { id: 'h', stage: 'done', finishedAt: '2026-11-02T00:00:00.000Z' }]
  check(pickOverviewJob(legacy)?.id === 'h', `回退到 finishedAt 比较（实际 ${pickOverviewJob(legacy)?.id}）`)
}

await check('repos 总览：同仓多次编译时取最新任务，不显示被取代的旧失败', repoOverviewPicksLatestJob)
// ============================ 排除清单 / repos 总览 / compile 动作（0.4.7） ============================
await cleanupServices()
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
    const rAuto = await gen.execute({ cwd: exRepo, scope: 'auto', auto: true, confirmed: true }, { agent: 'test-agent' })
    check(rAuto.submitted === false && rAuto.jobId === cOut.jobId, 'auto 直调幂等：返回现有活动任务')

    // 3) 任务跑完
    const job = await waitJob(exRepo)
    check(job?.stage === 'done', `compile 提交的任务终态 done（实际 ${job?.stage}，error ${job?.error ?? '-'}）`)

    // 4) 排除清单（0.17.48）：排除不是错误，是用户在面板上的表态。compile 与直调都要
    //    返回明确的终态 state=excluded 并说明「此仓库不编译 CodeWiki」，而不是抛错——
    //    抛错会被模型读成「编译失败」，然后去重试、排障，白烧一轮推理。
    mainConfig.excludePaths = exRepo
    const resC2 = fakeRes()
    await ctlEp.handler(fakeReq({ action: 'compile', cwd: exRepo }, '127.0.0.1', 'POST'), resC2)
    const c2 = JSON.parse(resC2.out)
    check(resC2.code === 200 && c2.ok === true && c2.state === 'excluded' && c2.submitted === false,
      `compile 对排除仓库返回 200 + state=excluded（${resC2.code} state=${c2.state}）`)
    check((c2.notes ?? []).some((n) => String(n).includes('此仓库不编译 CodeWiki')) && (c2.notes ?? []).some((n) => String(n).includes(exRepo)),
      'compile 的 notes 明说「此仓库不编译 CodeWiki」并点名命中的排除条目')
    const rEx = await gen.execute({ cwd: exRepo }, { agent: 'test-agent' })
    check(rEx.state === 'excluded' && rEx.submitted === false, `直调对排除仓库返回 excluded（state=${rEx.state}）`)
    check((rEx.notes ?? []).some((n) => String(n).includes('不是编译失败')), '直调 notes 明确否掉「编译失败」的读法')
    const sub = path.join(exRepo, 'packages', 'app')
    fs.mkdirSync(sub, { recursive: true })
    const rSub = await gen.execute({ cwd: sub }, { agent: 'test-agent' })
    check(rSub.state === 'excluded' && (rSub.notes ?? []).some((n) => String(n).includes(exRepo)),
      '子目录同样被排除（notes 点名父目录条目）')
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
await cleanupServices()
console.log('== 0.4.8：knownRepos 登记独立于 job 历史、refresh 动作 ==')
{
  const krRepo = makeFixtureRepo()
  const mock = makeBatchMock()
  // 与产品同源推导：写死 dirname 会落到真实宿主的清单文件（0.16.6 修复）
  const reposFile = reposFileFor(JOBS_FILE)
  try {
    const r = await gen.execute({ cwd: krRepo, confirmed: true }, { agent: 'test-agent' })
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

// ============================ 首次编译必须用户确认（0.17.27） ============================
await cleanupServices()
console.log('== 自动调度：从未编译过 wiki 的仓库只登记待确认，不替用户提交 ==')
{
  // 用户口径：原来没有编译过 codewiki 的项目，要不要生成 wiki 得由用户点确认；
  // 不想要就加入排除。自动调度只负责把这类仓库挑出来，不负责替用户决定。
  const freshRepo = makeFixtureRepo()
  const mockFresh = makeBatchMock()
  const repoFile = process.env.DSH_CODEWIKI_REPOS_FILE || reposFileFor(JOBS_FILE)
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }), 'utf8')
  // 仓库在已知清单里（用户加过工作区/见过它），但从没有过任何编译任务
  fs.writeFileSync(repoFile, JSON.stringify({ repos: [freshRepo] }), 'utf8')
  const ctxFresh = makeCtx()
  try {
    apply(ctxFresh.ctx, batchCfg({ autoUpdate: true, autoUpdateMin: 0 }))
    const ctl = ctxFresh.endpoints.find((e) => e.path === '/api/codewiki/control')
    const reposEp = ctxFresh.endpoints.find((e) => e.path === '/api/codewiki/repos')
    // 心跳间隔默认为 60s，测试里靠 DSH_CODEWIKI_AUTO_SCAN_MS 缩短；等它扫到该仓库
    let pending = []
    let scanned = 0
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      const res = fakeRes()
      await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), res)
      const data = JSON.parse(res.out)
      pending = data?.scheduler?.pendingConfirm ?? []
      scanned = data?.scheduler?.lastScanRepos ?? 0
      if (pending.length) break
    }
    check(pending.some((p) => p.toLowerCase() === freshRepo.toLowerCase()),
      `从没编译过的仓库进入待确认清单（实际 ${JSON.stringify(pending)}，扫到 ${scanned} 仓）`)
    const jobsNow = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []
    check(jobsNow.filter((j) => j.cwd.toLowerCase() === freshRepo.toLowerCase()).length === 0,
      `待确认期间不得为它提交任何编译任务（实际 ${JSON.stringify(jobsNow.map((j) => ({ kind: j.kind, stage: j.stage })))}）`)
    check(mockFresh.llmCalls.length === 0, '待确认期间不得发起任何模型请求')

    // 总览卡片要能显示「需要确认」，面板据此给按钮
    const resR = fakeRes()
    await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resR)
    const row = (JSON.parse(resR.out).repos ?? []).find((x) => x.cwd.toLowerCase() === freshRepo.toLowerCase())
    check(row?.needsConfirm === true, `总览行标记 needsConfirm（实际 ${JSON.stringify(row && { state: row.state, needsConfirm: row.needsConfirm })}）`)

    // 确认 → 立即编译，且确认清单里摘掉它
    const resC = fakeRes()
    await ctl.handler(fakeReq({ action: 'confirm', cwd: freshRepo }, '127.0.0.1', 'POST'), resC)
    const confirmed = JSON.parse(resC.out)
    check(resC.code === 200 && confirmed.ok === true, `confirm 动作被接受（实际 ${resC.code} ${resC.out?.slice(0, 120)}）`)
    check(confirmed.submitted === true, `确认后立即提交编译（实际 ${JSON.stringify(confirmed).slice(0, 160)}）`)
    await waitJob(freshRepo)
    const resAfter = fakeRes()
    await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resAfter)
    const after = JSON.parse(resAfter.out)
    check((after?.scheduler?.pendingConfirm ?? []).every((p) => p.toLowerCase() !== freshRepo.toLowerCase()),
      '确认之后不再留在待确认清单里')
    const rowAfter = (after.repos ?? []).find((x) => x.cwd.toLowerCase() === freshRepo.toLowerCase())
    check(rowAfter?.needsConfirm === false, '已确认的仓库不再显示 needsConfirm')
  } finally {
    for (const dispose of ctxFresh.disposers) dispose()
    mockFresh.restore()
    fs.rmSync(freshRepo, { recursive: true, force: true })
    try { fs.unlinkSync(repoFile) } catch { /* 测试清理 */ }
  }
}

// ============================ 工作区任务过滤（0.4.9） ============================
await cleanupServices()
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

    const rA = await gen2.execute({ cwd: wsRepo, confirmed: true }, { agent: 'test-agent' })
    await waitJob(rA.cwd)
    const rB = await gen2.execute({ cwd: outsideRepo, confirmed: true }, { agent: 'test-agent' })
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
    const rC = await gen2.execute({ cwd: outsideRepo, scope: 'full', confirmed: true }, { agent: 'test-agent' })
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
await cleanupServices()
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
    const rB = await gen2.execute({ cwd: outsideRepo, confirmed: true }, { agent: 'test-agent' })
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
await cleanupServices()
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
    const r1 = await def.execute({ cwd: repo, confirmed: true }, { agent: 'test-agent' })
    await waitJob(r1.cwd)
    check(validateOut(schema, r1).length === 0, `首次提交返回过 schema（${validateOut(schema, r1).join('; ')}）`)

    const r2 = await def.execute({ cwd: repo, confirmed: true }, { agent: 'test-agent' })
    check(validateOut(schema, r2).length === 0, `二次调用（state ${r2.state}）返回过 schema（${validateOut(schema, r2).join('; ')}）`)
  } finally {
    mock.restore()
    fs.rmSync(repo, { recursive: true, force: true })
  }
}

// ============================ 孤儿任务接管（0.4.11.2） ============================
await cleanupServices()
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

// ============================ 会话全局 Tab + worktree 闸门（1.2.0） ============================
await cleanupServices()
console.log('== 全局会话 Tab 的聚合接口 + worktree 闸门 ==')
{
  // a) 全局会话接口：不带 jobId → 跨任务聚合（带 jobId/cwd）；带 jobId → 单任务列表
  {
    const ep = main.endpoints.find((e) => e.path === '/api/codewiki/sessions')
    check(!!ep, 'sessions 端点已注册')
    const rAll = fakeRes()
    ep.handler(fakeReq({}, '127.0.0.1', 'GET'), rAll)
    check(rAll.code === 200, `不带 jobId 返回 200（实际 ${rAll.code}）`)
    const all = JSON.parse(rAll.out).sessions ?? []
    check(Array.isArray(all) && all.length > 0, `跨任务聚合有记录（${all.length} 条）`)
    check(all.every((s) => typeof s.jobId === 'string' && s.jobId.length), '每条带 jobId')
    check(all.some((s) => typeof s.cwd === 'string'), '聚合结果带 cwd（面板行显示仓库名）')
    const lim = Number(new URLSearchParams('limit=1').get('limit'))
    const rLim = fakeRes()
    ep.handler(fakeReq({}, '127.0.0.1', 'GET'), rLim)
    check(lim === 1 && rLim.code === 200, 'limit 参数被接受')
    const rOne = fakeRes()
    // 单任务路径：取聚合结果里的第一条 jobId
    const someJob = all[0]?.jobId
    if (someJob) {
      ep.handler({ method: 'GET', url: `/api/codewiki/sessions?jobId=${encodeURIComponent(someJob)}`, socket: { remoteAddress: '127.0.0.1' } }, rOne)
      const one = JSON.parse(rOne.out).sessions ?? []
      check(rOne.code === 200 && one.length > 0 && one.every((s) => s.jobId === someJob),
        `带 jobId 只返回该任务记录（${one.length} 条，jobId ${someJob}）`)
    }
    // 非回环地址一律拒绝
    const rRemote = fakeRes()
    ep.handler(fakeReq({}, '10.0.0.9', 'GET'), rRemote)
    check(rRemote.code === 403, `非回环地址被拒（实际 ${rRemote.code}）`)
  }

  // b) worktree 闸门：linked worktree 目录提交 → 直接报错；主仓库不受影响
  {
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wt-gate-'))
    const wtMain = path.join(wtRoot, 'main')
    const wtLinked = path.join(wtRoot, 'linked')
    const g = (...a) => execFileSync('git', a, { cwd: wtMain })
    try {
      fs.mkdirSync(path.join(wtMain, 'core'), { recursive: true })
      fs.writeFileSync(path.join(wtMain, 'core', 'core.py'), 'def run():\n    return 1\n')
      // mock 生成的 _patterns.md 声明 util/util.py 为 source_files；契约闸门会校验它真实存在，
      // 缺了这个文件整轮会因「存量文章 source_files 指向不存在的文件」降为 partial。
      fs.mkdirSync(path.join(wtMain, 'util'), { recursive: true })
      fs.writeFileSync(path.join(wtMain, 'util', 'util.py'), 'def fmt():\n    return "util"\n')
      execFileSync('git', ['init', '-q', wtMain])
      g('config', 'user.name', 'test')
      g('config', 'user.email', 'test@test')
      g('add', '.')
      g('commit', '-qm', 'init')
      g('worktree', 'add', '-q', wtLinked)
      const mockWt = makeBatchMock()
      try {
        let wtErr = null
        try { await gen.execute({ cwd: wtLinked, confirmed: true }, { agent: 'test-agent' }) } catch (e) { wtErr = e }
        check(String(wtErr?.message ?? '').includes('worktree'), `worktree 目录提交 → 报错（${String(wtErr?.message ?? '未报错').slice(0, 60)}…）`)
        check(String(wtErr?.message ?? '').includes('合并回主仓库'), '报错文案说明「等合并回主仓库后再编译」')
        // 主工作区对照：同一个仓库的主目录照常接受
        const rMain = await gen.execute({ cwd: wtMain, confirmed: true }, { agent: 'test-agent' })
        check(rMain.submitted === true, `主工作区照常提交（jobId ${rMain.jobId}）`)
        const jobMain = await waitJob(wtMain)
        check(jobMain?.stage === 'done', `主工作区任务跑完（${jobMain?.stage}）`)
        // auto 调度路径：静默跳过，不产生任务、不报错
        const autoR = await gen.execute({ cwd: wtLinked, scope: 'auto', auto: true, confirmed: true }, {})
        check(autoR.submitted !== true && (autoR.notes ?? []).some((n) => String(n).includes('worktree')), 'auto 调度扫到 worktree → 不提交并记 note')
      } finally {
        mockWt.restore()
        g('worktree', 'remove', '--force', wtLinked)
      }
    } finally {
      fs.rmSync(wtRoot, { recursive: true, force: true })
    }
  }
  try { fs.rmSync(SESSIONS_DIR, { recursive: true, force: true }) } catch { /* tmp 句柄延迟释放 */ }
}

// ==================== 空壳目录闸门 + 面板过滤（0.12.1） ====================
await cleanupServices()
console.log('== 空壳目录（扫不出源码）拒绝编译 + 面板任务列表/仓库总览不显示 ==')
{
  // 造一个「只剩 .codewiki 骨架」的空壳目录：真实的残留形态——worktree 被删掉后留下的目录
  const shellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shell-'))
  const shell = path.join(shellRoot, 'shell-repo')
  fs.mkdirSync(path.join(shell, '.codewiki'), { recursive: true })
  fs.writeFileSync(path.join(shell, '.codewiki', '_meta.yaml'), 'commit: abc\n')
  try {
    // a) 提交闸门：手动路径报错、auto 路径静默跳过（不产生 job）
    let shErr = null
    try { await gen.execute({ cwd: shell, confirmed: true }, { agent: 'test-agent' }) } catch (e) { shErr = e }
    check(String(shErr?.message ?? '').includes('没有可编译的源码文件'), `空壳目录提交 → 报错（${String(shErr?.message ?? '未报错').slice(0, 50)}…）`)
    const shAuto = await gen.execute({ cwd: shell, scope: 'auto', auto: true, confirmed: true }, {})
    check(shAuto.submitted !== true, 'auto 调度扫到空壳目录 → 不提交')

    // b) 面板过滤：往 jobs 文件里塞一条空壳目录任务 + 一条正常任务，新实例读取后
    //    jobs 端点不得返回前者、必须返回后者，仓库总览同理。
    //    正常任务的 cwd 用仓库自身（here）而不是 tmp 里的 fixture——tmp 目录的终态任务
    //    会被 0.4.6 的「Temp 残留清理」先一步移走，那样就测不到本次的过滤逻辑了。
    const iso = new Date().toISOString()
    const mkJob = (id, cwd) => ({ id, cwd, kind: 'full', scope: 'auto', stage: 'failed', notes: [], articles: [], tasks: [], createdAt: iso, updatedAt: iso })
    const prev = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
    prev.jobs = [...(prev.jobs ?? []), mkJob('job-shell-dead', shell), mkJob('job-ws-live', mainRepoRoot)]
    fs.writeFileSync(JOBS_FILE, JSON.stringify(prev), 'utf8')

    const cc2 = makeCtx()
    apply(cc2.ctx, batchCfg())
    await new Promise((r) => setTimeout(r, 300))
    const jobsEp = cc2.endpoints.find((e) => e.path === '/api/codewiki/jobs')
    check(!!jobsEp, 'jobs 端点已注册')
    const rJ = fakeRes()
    await jobsEp.handler(fakeReq({}, '127.0.0.1', 'GET'), rJ)
    check(rJ.code === 200, `jobs 端点返回 200（实际 ${rJ.code}）`)
    const ids2 = (JSON.parse(rJ.out).jobs ?? []).map((j) => j.id)
    check(!ids2.includes('job-shell-dead'), '空壳目录任务被面板过滤掉')
    check(ids2.includes('job-ws-live'), '正常仓库任务仍在面板上')

    const reposEp = cc2.endpoints.find((e) => e.path === '/api/codewiki/repos')
    if (reposEp) {
      const rR = fakeRes()
      await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), rR)
      const repoCwds = (JSON.parse(rR.out).repos ?? []).map((x) => String(x.cwd ?? '')).map((p) => p.replace(/[\\/]+$/, '').toLowerCase())
      const shellKey = shell.replace(/[\\/]+$/, '').toLowerCase()
      check(!repoCwds.includes(shellKey), '空壳目录不进仓库总览')
    }
  } finally {
    fs.rmSync(shellRoot, { recursive: true, force: true })
  }
}

// ==================== 首次编译必须用户点头（0.17.48） ====================
await cleanupServices()
console.log('== 仓库里还没有 CodeWiki：工具不得替用户决定建 wiki，先问 ==')
{
  const fresh = makeFixtureRepo() // 全新仓库：没有 .codewiki，cw status 判 missing
  const mock = makeBatchMock()
  try {
    // 1) 默认 scope=auto：拦下，不提交
    const r = await gen.execute({ cwd: fresh }, { agent: 'test-agent' })
    check(r.submitted === false && r.jobId === undefined, `首次编译未确认 → 不提交（submitted=${r.submitted}）`)
    check(r.state === 'missing' || r.state === 'uncompiled', `返回值如实报出仓库状态（state=${r.state}）`)
    check((r.notes ?? []).some((n) => String(n).includes('尚无 CodeWiki')), 'notes 说明「此仓库尚无 CodeWiki」')
    check((r.notes ?? []).some((n) => String(n).includes('先问用户')), 'notes 指示模型先问用户，而不是自己决定')
    check(mock.llmCalls.length === 0, `拦在提交前，一次模型请求都没发出（实际 ${mock.llmCalls.length}）`)

    // 2) scope=stale 同样被拦（这类仓库本来就会被升成全量，等于首次编译）
    const rStale = await gen.execute({ cwd: fresh, scope: 'stale' }, { agent: 'test-agent' })
    check(rStale.submitted === false, `scope=stale 遇到无 wiki 的仓库同样不提交（submitted=${rStale.submitted}）`)

    // 3) 用户同意后显式 scope=full：放行
    const rFull = await gen.execute({ cwd: fresh, scope: 'full' }, { agent: 'test-agent' })
    check(rFull.submitted === true, `用户显式要求全量 → 放行提交（submitted=${rFull.submitted} state=${rFull.state}）`)
    const job = await waitJob(fresh)
    check(job?.stage === 'done', `显式全量编译跑完（stage=${job?.stage}）`)
  } finally {
    mock.restore()
    fs.rmSync(fresh, { recursive: true, force: true })
  }
}

// ============================ 编译模型缺失诚实报错（0.10.1） ============================
await cleanupServices()
console.log('== 编译模型/provider 缺失：诚实报错，不降级子代理、不静默跑空 ==')
{
  const noCfgRepo = makeFixtureRepo()
  const noCfg = makeCtx({})
  apply(noCfg.ctx, { batchProvider: '', batchModel: '' })
  let err = null
  try { await noCfg.registered.get('codewiki_generate').execute({ cwd: noCfgRepo, confirmed: true }, { agent: 'test-agent' }) } catch (e) { err = e }
  check(err && String(err.message).includes('编译模型提供商为空'), `provider 留空 → 报错指向设置项（实际 ${err?.message?.slice(0, 40)}…）`)
  // 失败必须落成 job 的 failed 态（可观测，而不是凭空消失）
  const failedJob = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.cwd === noCfgRepo)
  check(failedJob?.stage === 'failed' && String(failedJob?.error ?? '').includes('编译模型'), `失败留痕在 job（stage=${failedJob?.stage}）`)
  fs.rmSync(noCfgRepo, { recursive: true, force: true })
}

// ============================ 思考档位不在模型目录 → 提交即拦（0.17.24） ============================
// 真机事故：编译模型配成 trae/deepseek-v4.1-flash + off，而该模型只有 low/high/xhigh。
// provider 不报错，回 200 + 空内容，桥只剩一个 finish chunk、引擎记 Tokens used: 0，
// 40 次调用全部空跑、一篇文章都没写，任务看起来还正常走完。所以档位必须在提交入口校验。
await cleanupServices()
console.log('== 思考档位不在模型目录里：提交时拦下并列出真实档位 ==')
{
  const repo = makeFixtureRepo()
  const mock = makeBatchMock({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] })
  const ctx = makeCtx({})
  apply(ctx.ctx, batchCfg({ batchReasoningEffort: 'off' }))
  let err = null
  try { await ctx.registered.get('codewiki_generate').execute({ cwd: repo, confirmed: true }, { agent: 'test-agent' }) } catch (e) { err = e }
  check(err && String(err.message).includes('思考档位'), `档位不在目录 → 提交报错（实际 ${err?.message?.slice(0, 60)}…）`)
  check(err && String(err.message).includes('low/high'), '报错里列出该模型真实可用的档位')
  check(mock.llmCalls.length === 0, `拦在提交时，一次模型请求都没发出（实际 ${mock.llmCalls.length}）`)
  const failed = (JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).find((j) => j.cwd === repo)
  check(failed?.stage === 'failed', `失败留痕在 job（stage=${failed?.stage}）`)
  fs.rmSync(repo, { recursive: true, force: true })
  mock.restore()
}

await cleanupServices()
console.log('== 档位在目录里（或模型未声明档位）：照常提交 ==')
{
  const repo = makeFixtureRepo()
  const mock = makeBatchMock({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] })
  const ctx = makeCtx({})
  apply(ctx.ctx, batchCfg({ batchReasoningEffort: 'low' }))
  let err = null
  try { await ctx.registered.get('codewiki_generate').execute({ cwd: repo, confirmed: true }, { agent: 'test-agent' }) } catch (e) { err = e }
  check(err === null, `合法档位不拦（实际 ${err?.message?.slice(0, 40) ?? '无错'}）`)
  fs.rmSync(repo, { recursive: true, force: true })
  mock.restore()
}

// ============================ 严格 cordis 语义 ============================
await cleanupServices()
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
await cleanupServices()
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

// ============================ 自动调度：历史任务截断后仍扫描已知仓库 ============================
await cleanupServices()
console.log('== 自动调度：过期检测触发真实心跳提交，历史外已知仓库不丢 ==')
{
  // 回归现场：REPOS_FILE 已有编译过的工作区，但 JOBS_FILE 为空（历史被 MAX_JOBS_KEPT
  // 截断）。自动扫描必须仍对它执行 scope=auto，而不是把调度器变成只扫任务历史的摆设。
  const scanRepo = makeFixtureRepo()
  const mockScan = makeBatchMock()
  // 落点必须与产品一致（跟随 JOBS_FILE 名字，而非只跟随目录）：写死 dirname 推导会落到
  // 真实宿主的 dsh-codewiki-repos.json，跑一次测试就把 fixture 路径塞进宿主清单。
  const repoFile = process.env.DSH_CODEWIKI_REPOS_FILE || reposFileFor(JOBS_FILE)
  // 干净现场：前序用例会往同一个 JOBS_FILE 里留 fixture 任务（如「Temp 目录活动任务保留」
  // 的 job-tmp-active 仍是活动态），单项目串行闸门会被它永久占住——本仓库的初始化任务只会
  // 一直 queued，根本没编译出 wiki，后面的 stale 判定自然退化成 missing/full。
  // 因此必须在 apply 之前就把历史清空，而不是等初始化跑完再清。
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }), 'utf8')
  fs.writeFileSync(repoFile, JSON.stringify({ repos: [] }), 'utf8')
  const initCtx = makeCtx()
  apply(initCtx.ctx, batchCfg({ autoUpdate: false }))
  const initGen = initCtx.registered.get('codewiki_generate')
  const submit = await initGen.execute({ cwd: scanRepo, scope: 'auto', confirmed: true }, {})
  check(submit.submitted === true, '自动调度前置：新仓库可提交全量初始化')
  const initJob = await waitJob(scanRepo)
  check(initJob?.stage === 'done', `自动调度前置：初始化编译至终态 done（实际 ${initJob?.stage}）`)
  check(JSON.parse(fs.readFileSync(repoFile, 'utf8')).repos.includes(scanRepo), '已编译仓库进入独立持久清单')
  for (const dispose of initCtx.disposers) dispose()
  // 先停掉持有旧任务内存的服务，再清空磁盘历史；否则 mergeFromDisk 只增不删，
  // 会把内存里的终态任务带回来，根本没测到「只剩 knownRepos」这个现场。
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }), 'utf8')
  const scanCtx = makeCtx()
  apply(scanCtx.ctx, batchCfg({ autoUpdate: true, autoUpdateMin: 5 }))
  // 让判态从 missing 变成 stale；真实 cw CLI 给出过期清单，不经 mock generate。
  fs.writeFileSync(path.join(scanRepo, 'core', 'core.py'), 'def run():\n    return "changed"\n')
  const scanCw = scanCtx.registered.get('cw')
  // 判定必须真的走到 stale：cw status 看到 core/core.py 变更，自动调度才会走增量而非全量。
  const preStatus = await scanCw.execute({ cwd: scanRepo, args: ['status'] }, {})
  check(/Changed since last compile|Stale articles/.test(String(preStatus?.stdout ?? '')), `自动调度前置：心跳前判态已是过期（实际 ${String(preStatus?.stdout ?? '').split('\n')[0]}）`)
  let autoJob = null
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
    autoJob = (data.jobs ?? []).find((j) => j.cwd === scanRepo && j.auto === true && j.kind === 'stale') ?? null
    if (autoJob) break
  }
  check(autoJob !== null, `历史清空后，真实心跳仍扫描已知仓库并自动提交过期编译（现场 ${JSON.stringify((JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []).filter((j) => j.cwd === scanRepo).map((j) => ({ scope: j.scope, kind: j.kind, stage: j.stage, notes: j.notes }))) }）`)
  if (autoJob) check(autoJob.scope === 'auto' && autoJob.kind === 'stale', `自动提交保留 scope=auto 与增量 kind（实际 ${autoJob.scope}/${autoJob.kind}）`)
  for (const dispose of scanCtx.disposers) dispose()
  mockScan.restore()
  fs.rmSync(scanRepo, { recursive: true, force: true })
}

// ============================ 幂等：同一仓库的不同路径写法 ============================
await cleanupServices()
console.log('== 幂等：同一仓库以不同路径写法提交只允许一条活动任务 ==')
{
  // 已知仓库清单与工具入参走的是两套路径形态：REPOS_FILE 用归一化 key 去重，
  // 而 submit/findActive 曾用严格字符串相等，尾分隔符或盘符大小写一变就认不出同一仓库，
  // 于是同仓库并发两条任务，直接破坏单项目串行与自动调度幂等的前提。
  const idemRepo = makeFixtureRepo()
  const mockIdem = makeBatchMock()
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }), 'utf8')
  const idemCtx = makeCtx()
  apply(idemCtx.ctx, batchCfg({ autoUpdate: false }))
  try {
    const idemGen = idemCtx.registered.get('codewiki_generate')
    const r1 = await idemGen.execute({ cwd: idemRepo, scope: 'auto', confirmed: true }, {})
    check(r1.submitted === true, `幂等前置：首次提交成功（submitted=${r1.submitted}）`)
    const variants = [
      ['尾分隔符', idemRepo + path.sep],
      ['盘符大小写不同', idemRepo.toLowerCase()],
    ]
    for (const [label, variant] of variants) {
      const r = await idemGen.execute({ cwd: variant, scope: 'auto', confirmed: true }, {})
      check(
        r.submitted === false && r.jobId === r1.jobId,
        `幂等命中：cwd ${label} 仍返回同一任务（实际 submitted=${r.submitted} jobId=${r.jobId}，期望 ${r1.jobId}）`,
      )
    }
  } finally {
    for (const dispose of idemCtx.disposers) dispose()
    mockIdem.restore()
    fs.rmSync(idemRepo, { recursive: true, force: true })
  }
}

// ============================ 自动调度遵守 workspaceOnly ============================
await cleanupServices()
console.log('== 自动调度遵守 workspaceOnly：工作区外仓库不被后台编译 ==')
{
  // 现场：knownRepos 里有一个「已移出 dsh 工作区」的仓库，且 autoUpdate 开着。
  // 若只有面板过滤遵守 workspaceOnly，这个仓库会被后台定时编译、产物悄悄写进它的
  // .codewiki/，而面板上根本看不到这条任务——用户既不知道它在编译，也取消不了。
  const outsideRepo = makeFixtureRepo()
  const wsOnlyRepo = makeFixtureRepo()
  const mockWs = makeBatchMock()
  // 落点必须与产品一致（跟随 JOBS_FILE 名字，而非只跟随目录）：写死 dirname 推导会落到
  // 真实宿主的 dsh-codewiki-repos.json，跑一次测试就把 fixture 路径塞进宿主清单。
  const repoFile = process.env.DSH_CODEWIKI_REPOS_FILE || reposFileFor(JOBS_FILE)
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: [] }), 'utf8')
  fs.writeFileSync(repoFile, JSON.stringify({ repos: [outsideRepo] }), 'utf8')
  // 只把 wsOnlyRepo 登记为已添加工作区；outsideRepo 不在清单里（含子目录判定见 isExcluded）
  const wsCtx = makeCtx({ workspaces: [wsOnlyRepo] })
  apply(wsCtx.ctx, batchCfg({ autoUpdate: true, autoUpdateMin: 5 }))
  try {
    // 心跳压到 100ms（见文件顶部），但 autoUpdateMin 闸门只看首轮：lastScan=0 立即放行
    await new Promise((r) => setTimeout(r, 1200))
    const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs ?? []
    const outsideJobs = jobs.filter((j) => j.cwd === outsideRepo)
    check(outsideJobs.length === 0, `工作区外仓库未被自动提交（实际 ${outsideJobs.length} 条：${JSON.stringify(outsideJobs.map((j) => ({ kind: j.kind, stage: j.stage })))}）`)
    const reposEp = wsCtx.endpoints.find((e) => e.path === '/api/codewiki/repos')
    const res = fakeRes()
    await reposEp.handler(fakeReq({}, '127.0.0.1', 'GET'), res)
    const sched = JSON.parse(res.out)?.scheduler
    // 面板必须能解释「清单里有 N 个仓库、扫到 M 个」的缺口，否则用户以为调度器丢了仓库
    check(sched?.lastScanSkipped >= 1, `面板可见工作区外跳过计数（实际 ${sched?.lastScanSkipped}）`)
  } finally {
    for (const dispose of wsCtx.disposers) dispose()
    mockWs.restore()
    fs.rmSync(outsideRepo, { recursive: true, force: true })
    fs.rmSync(wsOnlyRepo, { recursive: true, force: true })
  }
}

// 清理主 fixture（wiki 在仓库内 .codewiki/，随目录一起删）
fs.rmSync(mainRepo, { recursive: true, force: true })
// 清理本次运行的 jobs 文件（随机 token 命名的临时文件，不留给下次运行与 tmp 目录）
try { fs.rmSync(JOBS_FILE, { force: true }) } catch { /* Windows 句柄延迟释放：留 tmp 自清 */ }

console.log(failures ? `\nFAIL：${failures} 项未通过` : '\nPASS：编排冒烟全部通过')
process.exit(failures ? 1 : 0)
