// test-orchestration.mjs — dsh-codewiki 编排行为冒烟：
// mock 子代理服务 + 真实 cw CLI，验证 codewiki_generate 全量编译与 stale 逐篇更新两条路径
// （这两条路径都会触碰 subagents 接线——0.2.1 之前接线断裂，一进编译就 ReferenceError）。
// 运行：node test-orchestration.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { name, apply } = await import('./index.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

function articleMd(title, source, type = 'module') {
  return `---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\nTest article body.\n`
}

// mock 子代理服务：按 label 路由，写文章任务真实落盘（模拟子代理用自己的写文件工具）
// initialWikiPath：批量集成节无「codewiki:模块」子代理来设置 wikiPath，显式传入避免横切 mock 落盘到进程 cwd
function makeMockSubagents(initialWikiPath = '') {
  const calls = []
  const state = { wikiPath: initialWikiPath }
  return {
    calls,
    async start(_kind, payload) {
      calls.push(payload)
      const label = payload.label ?? ''
      const text = (payload.prompt ?? []).map((b) => b?.text ?? '').join('')
      let reply = ''
      if (label.includes('模块规划')) {
        reply = '```json\n' + JSON.stringify({
          project: 'fixture',
          modules: [
            { name: 'core', summary: '核心', files: ['src/core.py'] },
            { name: 'util', summary: '工具', files: ['src/util.py'] },
          ],
          concepts: [{ name: 'config-load', files: ['src/core.py'] }],
        }) + '\n```'
      } else if (label.includes('codewiki:更新 ')) {
        // label 可能带模型前缀（`[model] codewiki:更新 …`），按子串定位提取
        const rel = label.split('codewiki:更新 ')[1]
        const file = path.join(state.wikiPath, rel.replace(/\\/g, '/'))
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n<!-- updated by test -->\n')
        reply = `WROTE ${file}`
      } else if (label.includes('codewiki:模块 ')) {
        const m = text.match(/把文章写入：(\S+?\.md)/)
        if (!m) throw new Error('mock: 模块 prompt 里找不到写入路径')
        const file = m[1]
        state.wikiPath = path.dirname(path.dirname(file))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const modName = label.split('codewiki:模块 ')[1]
        fs.writeFileSync(file, articleMd(modName, `src/${modName}.py`))
        reply = `WROTE ${file}`
      } else if (label.includes('横切')) {
        const w = state.wikiPath
        fs.mkdirSync(path.join(w, 'concepts'), { recursive: true })
        fs.writeFileSync(path.join(w, '_architecture.md'), articleMd('Architecture', 'src/core.py', 'architecture'))
        fs.writeFileSync(path.join(w, '_patterns.md'), articleMd('Patterns', 'src/util.py', 'pattern'))
        fs.writeFileSync(path.join(w, 'concepts', 'config-load.md'), articleMd('config-load', 'src/core.py', 'concept'))
        reply = `WROTE ${path.join(w, '_architecture.md')}`
      } else if (label.includes('审校')) {
        reply = 'VERIFIED（修复 0 处）'
      } else {
        throw new Error(`mock: 未识别的任务 label：${label}`)
      }
      return {
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: reply }] }),
        dispose: async () => {},
      }
    },
  }
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

// ---- 注册捕获 ----
const mockSubagents = makeMockSubagents()
const registered = new Map()
const rc = {
  tools: { register(def) { registered.set(def.name, def); return () => {} } },
  subagents: mockSubagents,
}

// ---- 系统提示提醒捕获（agent/created 布线 + agent 作用域 section 注册） ----
const agentListeners = []
const promptSections = new Map() // mock agent -> 已注册 section 列表
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
  promptSections.set(agent, sections)
  return agent
}
// 轻量 fixture：临时目录 + 可选 .codewiki/，不做 git（提醒只看目录存在性）
function makeReminderRepo(withWiki) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-remind-'))
  if (withWiki) fs.mkdirSync(path.join(dir, '.codewiki'))
  return dir
}
const mockCtx = {
  inject: (deps, fn) => fn(rc),
  on: (event, fn) => { if (event === 'agent/created') agentListeners.push(fn) },
}
rc.agents = { list: () => [...promptSections.keys()] }

const reminderConfig = { defaultProvider: 'mock-prov', defaultModel: 'mock-model', defaultReasoningEffort: 'low' }
apply(mockCtx, reminderConfig)

console.log('== 系统提示 wiki 维护提醒 ==')
const agentWithWiki = makeMockAgent(makeReminderRepo(true))
const agentNoWiki = makeMockAgent(makeReminderRepo(false))
for (const fn of agentListeners) await fn({ agent: agentWithWiki })
for (const fn of agentListeners) await fn({ agent: agentNoWiki })
const secWithWiki = (promptSections.get(agentWithWiki) ?? [])[0]
const secNoWiki = (promptSections.get(agentNoWiki) ?? [])[0]
check(secWithWiki !== undefined, 'agent/created 后为会话 agent 注册了系统提示 section')
check(secWithWiki?.name === 'codewiki:update-reminder', `section 名 codewiki:update-reminder（实际 ${secWithWiki?.name}）`)
check(typeof secWithWiki?.text === 'function' && secWithWiki.text().includes('codewiki'), '有 .codewiki 的会话提醒文本非空且指向 codewiki')
check(typeof secNoWiki?.text === 'function' && secNoWiki.text() === '', '无 .codewiki 的会话提醒文本为空（不注入噪音）')
reminderConfig.updateReminder = false
check(typeof secWithWiki?.text === 'function' && secWithWiki.text() === '', 'updateReminder=false 后提醒文本为空（运行时开关生效）')

console.log('== 注册 ==')
check(name === 'dsh-codewiki', `插件名 ${name}`)
check(registered.get('cw') && registered.get('codewiki_generate'), 'cw 与 codewiki_generate 两个工具均已注册')

const gen = registered.get('codewiki_generate')
const cw = registered.get('cw')
const repo = makeFixtureRepo()

try {
  console.log('== cw 工具 ==')
  const st = await cw.execute({ cwd: repo, args: ['status'] })
  check(st.exitCode === 0 && /No wiki found/i.test(st.stdout), 'cw status 判定 missing 态')

  console.log('== codewiki_generate 全量编译 ==')
  const callsBeforeFull = mockSubagents.calls.length
  const r1 = await gen.execute({ cwd: repo }, { agent: 'test-agent' })
  console.log('  notes:', r1.notes.join(' | '))
  const planner = mockSubagents.calls[0]
  check(planner?.agentOptions?.provider === 'mock-prov' && planner?.agentOptions?.model === 'mock-model', '规划 agent 携带插件默认模型路由 agentOptions')
  const fullCalls = mockSubagents.calls.slice(callsBeforeFull)
  const moduleCalls = fullCalls.filter((p) => String(p.label ?? '').includes('codewiki:模块 '))
  check(moduleCalls.length >= 2 && moduleCalls.every((p) => p.agentOptions?.provider === 'mock-prov' && p.agentOptions?.model === 'mock-model'), `模块文章 agent（${moduleCalls.length} 个）携带插件默认模型路由 agentOptions`)
  check(fullCalls.every((p) => p.agentOptions?.provider === 'mock-prov' && p.agentOptions?.model === 'mock-model'), '全量路径全部 spawn 调用均携带 agentOptions')
  check(fullCalls.every((p) => p.agentOptions?.reasoningEffort === 'low'), '全量路径全部 spawn 携带插件默认思考程度 low')
  check(r1.writtenCount >= 3 && r1.failedCount === 0, `全量编译完成 ${r1.writtenCount} 篇、失败 ${r1.failedCount} 篇`)
  check(r1.verified === true, '审校 agent 已执行')
  check(fs.existsSync(path.join(r1.wikiPath, 'modules', 'core.md')), 'modules/core.md 落盘')
  check(fs.existsSync(path.join(r1.wikiPath, '_architecture.md')), '_architecture.md 落盘')
  check(r1.notes.some((n) => n.includes('cw index')), `收尾 index/meta update 已执行（${r1.notes.find((n) => n.includes('cw index'))}）`)

  console.log('== codewiki_generate clean + scope=full（强制全量） ==')
  const r1b = await gen.execute({ cwd: repo, scope: 'full' }, { agent: 'test-agent' })
  console.log('  notes:', r1b.notes.join(' | '))
  check(r1b.scope === 'full' && r1b.writtenCount >= 3, `clean 态 scope=full 强制全量重编（${r1b.writtenCount} 篇）`)
  check(!r1b.notes.some((n) => n.includes('无需编译')), 'scope=full 不被 clean 短路')

  console.log('== codewiki_generate stale 逐篇更新 ==')
  fs.writeFileSync(path.join(repo, 'src', 'core.py'), 'def run():\n    return "core-v2"\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'v2'], { cwd: repo })
  const callsBeforeStale = mockSubagents.calls.length
  const r2 = await gen.execute({ cwd: repo, scope: 'stale', reasoningEffort: 'max' }, { agent: 'test-agent' })
  console.log('  notes:', r2.notes.join(' | '))
  const staleCalls = mockSubagents.calls.slice(callsBeforeStale)
  check(staleCalls.length >= 1 && staleCalls.every((p) => String(p.label ?? '').includes('codewiki:更新 ') && p.agentOptions?.provider === 'mock-prov' && p.agentOptions?.model === 'mock-model'), `逐篇更新 agent（${staleCalls.length} 个）携带插件默认模型路由 agentOptions`)
  check(fullCalls.every((p) => String(p.label ?? '').startsWith('[mock-model] ')), `活动行 label 带模型前缀（${fullCalls.filter((p) => String(p.label ?? '').startsWith('[mock-model] ')).length}/${fullCalls.length} 个）`)
  check(staleCalls.every((p) => p.agentOptions?.reasoningEffort === 'max'), '调用参数 reasoningEffort=max 覆盖插件默认 low')
  check(r2.writtenCount >= 1 && r2.failedCount === 0, `stale 更新完成 ${r2.writtenCount} 篇、失败 ${r2.failedCount} 篇`)
  check(fs.readFileSync(path.join(r1.wikiPath, 'modules', 'core.md'), 'utf8').includes('updated by test'), '过期文章已被重写')
} finally {
  fs.rmSync(repo, { recursive: true, force: true })
  try { fs.rmSync(path.join(os.homedir(), '.codewiki', path.basename(repo)), { recursive: true, force: true }) } catch { /* wikiPath 已删 */ }
}

console.log('== codewiki_generate 批量推理集成（batchEnabled → 写文章走百炼 Batch，不再派写文章子代理） ==')
{
  const batchRepo = makeFixtureRepo()
  const originalFetch = globalThis.fetch
  const fetchCalls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    fetchCalls.push(u)
    if (u.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-it-1' }), { status: 200 })
    if (u.endsWith('/batches') || u.includes('/batches/batch-it-1')) {
      return new Response(JSON.stringify({ id: 'batch-it-1', status: 'completed', output_file_id: 'out-it-1', error_file_id: 'err-it-1' }), { status: 200 })
    }
    if (u.includes('out-it-1')) {
      const article = (title, src) => `---\ntitle: ${title}\ntype: module\nsource_files:\n  - ${src}\ntags: []\n---\n\n# ${title}\n\nBatch-written article.\n`
      const lines = [
        { custom_id: 't0', response: { status_code: 200, body: { choices: [{ message: { content: article('core', 'src/core.py') } }] } } },
        { custom_id: 't1', response: { status_code: 200, body: { choices: [{ message: { content: article('util', 'src/util.py') } }] } } },
      ]
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 })
    }
    if (u.includes('err-it-1')) return new Response('', { status: 200 })
    return new Response('{}', { status: 404 })
  }
  try {
    const batchRegistered = new Map()
    const batchRc = {
      tools: { register(def) { batchRegistered.set(def.name, def); return () => {} } },
      subagents: makeMockSubagents(path.join(batchRepo, '.codewiki')),
    }
    apply({ inject: (deps, fn) => fn(deps.includes('agents') ? { agents: { list: () => [] } } : batchRc), on: () => {} }, { enabled: true, batchEnabled: true, batchApiKey: 'sk-test' })
    const callsBeforeBatch = batchRc.subagents.calls.length
    const rb = await batchRegistered.get('codewiki_generate').execute({ cwd: batchRepo }, { agent: 'test-agent' })
    console.log('  notes:', rb.notes.join(' | '))
    const batchPathCalls = batchRc.subagents.calls.slice(callsBeforeBatch)
    check(fetchCalls.some((u) => u.endsWith('/files')) && fetchCalls.some((u) => u.endsWith('/batches')), `百炼 API 已被调用（/files 与 /batches，共 ${fetchCalls.length} 次）`)
    check(batchPathCalls.every((p) => !String(p.label ?? '').includes('codewiki:模块 ')), `写文章子代理 spawn 数为 0（本路径共 spawn ${batchPathCalls.length} 个）`)
    check(batchPathCalls.some((p) => String(p.label ?? '').includes('模块规划')) && batchPathCalls.some((p) => String(p.label ?? '').includes('横切')), '规划与横切仍走智能体子代理')
    check(fs.existsSync(path.join(rb.wikiPath, 'modules', 'core.md')) && fs.readFileSync(path.join(rb.wikiPath, 'modules', 'core.md'), 'utf8').includes('Batch-written'), '批量结果文章已由插件落盘')
    check(rb.writtenCount >= 2 && rb.failedCount === 0, `批量路径完成 ${rb.writtenCount} 篇、失败 ${rb.failedCount} 篇`)
    check(rb.notes.some((n) => n.includes('qwen3.7-flash')), 'notes 记录批量模型')
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(batchRepo, { recursive: true, force: true })
    try { fs.rmSync(path.join(os.homedir(), '.codewiki', path.basename(batchRepo)), { recursive: true, force: true }) } catch { /* wikiPath 已删 */ }
  }
}

console.log('== 严格 cordis 语义：未 inject 的服务属性访问即抛 ==')
{
  const strictRegistered = new Map()
  const strictListeners = []
  const strictRc = {
    tools: { register(def) { strictRegistered.set(def.name, def); return () => {} } },
    subagents: makeMockSubagents(),
  }
  // 真实 cordis：对未声明 inject 的服务属性，访问本身抛异常（typeof 守卫救不了）
  Object.defineProperty(strictRc, 'agents', {
    get() { throw new Error('cannot get property "agents" without inject') },
  })
  const strictCtx = {
    inject: (deps, fn) => fn(deps.includes('agents') ? { agents: { list: () => [] } } : strictRc),
    on: (event, fn) => { if (event === 'agent/created') strictListeners.push(fn) },
  }
  // 真实 cordis 抛错点在插件自身的 ctx（apply 收到的对象），不在注入的 rc
  Object.defineProperty(strictCtx, 'agents', {
    get() { throw new Error('cannot get property "agents" without inject') },
  })
  let applyThrew = null
  try { apply(strictCtx, {}) } catch (e) { applyThrew = e }
  check(applyThrew === null, `apply 在严格 cordis 语义下不抛错（实际 ${applyThrew?.message ?? applyThrew}）`)
  check(strictRegistered.get('cw') && strictRegistered.get('codewiki_generate'), '严格语义下 cw 与 codewiki_generate 仍注册（fiber 不回滚）')
  check(strictListeners.length === 1, 'agent/created 监听已布线')
}

console.log(failures ? `\nFAIL：${failures} 项未通过` : '\nPASS：编排冒烟全部通过')
process.exit(failures ? 1 : 0)
