// semanticPlan 端到端测试：AST 提取 -> 聚类 -> 模块清单。
// 三个场景：① 有模型（走 LLM 聚类）② 无模型（降级目录聚类）③ tree-sitter 不可用（退回 localPlan）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { semanticPlan, localPlan, scanRepoFiles } from './index.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

// 造一个「目录划分与职责划分不一致」的仓库：
//   src/billing/  里混了一个 HTTP 路由
//   src/api/      里混了一个数据库事务
// 语义聚类应把 billing 逻辑归到 billing、HTTP 归到 api，而不是照搬目录。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwplan-'))
const files = {
  'src/billing/invoice.js': `export function calcTax(amount, rate) {\n  return amount * rate\n}\n\nexport class Invoice {\n  constructor(id) { this.id = id }\n  total(items) { return items.reduce((s, i) => s + i.price, 0) }\n}\n`,
  'src/billing/routes.js': `import { calcTax } from './invoice.js'\n\nexport function registerBillingRoutes(app) {\n  app.get('/invoices', (req, res) => res.json([]))\n}\n`,
  'src/api/tx.js': `export async function withTransaction(db, fn) {\n  await db.begin()\n  try { return await fn() } finally { await db.commit() }\n}\n`,
  'src/api/handlers.js': `export function getUsers(req, res) {\n  return res.json([])\n}\n`,
  'src/util/strings.js': `export function slugify(s) {\n  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')\n}\n`,
  'README.md': '# demo\n',
}
for (const [rel, content] of Object.entries(files)) {
  const abs = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

const scanned = scanRepoFiles(tmp)
console.log(`扫描到 ${scanned.length} 个文件：${scanned.map((f) => f.path).join(', ')}`)

await check('无模型时仍能出模块清单（降级为目录聚类）', async () => {
  const notes = []
  const r = await semanticPlan(scanned, { cwd: tmp, llm: null, provider: '', model: '', notes })
  assert.equal(r.fallback, false, '不该整体失败')
  assert.ok(r.plan, '应产出 plan')
  assert.ok(r.plan.modules.length >= 2, `模块数应 >=2，实际 ${r.plan.modules.length}`)
  // 没有 llmCall 时 stats.llm=false，project 文案要说清已降级
  assert.equal(r.plan.stats.llm, false)
  assert.match(r.plan.project, /降级/, `project 文案应标注降级，实际：${r.plan.project}`)
  // 组件数应大于 0（说明确实是 AST 提取，不是文件级分组）
  assert.ok(r.plan.stats.components > 0, '应有组件')
  console.log(`      组件 ${r.plan.stats.components} 个，模块 ${r.plan.modules.length} 个：${r.plan.modules.map((m) => m.name).join(', ')}`)
})

await check('每个模块都带非空 source_files', async () => {
  const r = await semanticPlan(scanned, { cwd: tmp, llm: null, provider: '', model: '' })
  for (const m of r.plan.modules) {
    assert.ok(Array.isArray(m.files) && m.files.length, `模块「${m.name}」缺 files`)
    for (const f of m.files) assert.ok(fs.existsSync(path.join(tmp, f)), `模块「${m.name}」的文件不存在：${f}`)
  }
})

await check('模块文件并集 = 全部有符号的源文件（不丢文件）', async () => {
  const r = await semanticPlan(scanned, { cwd: tmp, llm: null, provider: '', model: '' })
  const inModules = new Set(r.plan.modules.flatMap((m) => m.files))
  // README.md 没有符号，不该出现；源码文件应全部出现
  assert.ok(!inModules.has('README.md'), 'README 不该进任何模块')
  for (const f of Object.keys(files)) {
    if (f.endsWith('.md')) continue
    assert.ok(inModules.has(f), `源文件 ${f} 没被任何模块覆盖`)
  }
})

await check('有模型时走 LLM 聚类并按返回结果分组', async () => {
  const notes = []
  // 假模型：从 formatComponents 的 TAB 行里抽 id，按路径前缀切两组
  const parseIds = (prompt) => {
    const ids = []
    for (const line of String(prompt).split('\n')) {
      if (!line.startsWith('\t')) continue
      const id = line.slice(1).split('\t')[0]
      if (id) ids.push(id)
    }
    return ids
  }
  const fakeLlm = {
    lastPrompt: '',
    async *stream(req) {
      fakeLlm.lastPrompt = req.messages.map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n')
      const ids = parseIds(fakeLlm.lastPrompt)
      const billing = ids.filter((id) => id.startsWith('src/billing/'))
      const rest = ids.filter((id) => !id.startsWith('src/billing/'))
      const text = JSON.stringify({
        modules: [
          { name: 'Billing', path: 'billing', summary: '账务与发票', components: billing },
          { name: 'ApiRuntime', path: 'api-runtime', summary: 'HTTP 与事务', components: rest },
        ],
        concepts: ['请求生命周期'],
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const r = await semanticPlan(scanned, { cwd: tmp, llm: fakeLlm, provider: 'p', model: 'm', notes })
  assert.equal(r.fallback, false)
  assert.equal(r.plan.stats.llm, true, '应走 LLM 聚类')
  const names = r.plan.modules.map((m) => m.name)
  console.log(`      模块：${names.join(', ')}；请求 ${r.plan.stats.requests} 次`)
  assert.ok(names.includes('billing'), `应含 billing（normalizeModuleName 会小写），实际 ${names.join(',')}`)
  assert.ok(names.includes('apiruntime'), `应含 apiruntime，实际 ${names.join(',')}`)
  const billing = r.plan.modules.find((m) => m.name === 'billing')
  assert.ok(billing.files.every((f) => f.startsWith('src/billing/')), `Billing 的文件应都在 src/billing/：${billing.files.join(',')}`)
})

await check('模型返回坏 JSON 时降级到目录聚类而非崩溃', async () => {
  const notes = []
  const fakeLlm = {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '这不是 JSON，抱歉' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '这不是 JSON，抱歉' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const r = await semanticPlan(scanned, { cwd: tmp, llm: fakeLlm, provider: 'p', model: 'm', notes })
  assert.equal(r.fallback, false, '不该整体失败')
  assert.ok(r.plan.modules.length >= 2, '应仍有模块（降级聚类）')
  assert.ok(r.plan.stats.fallbacks >= 1, '应记降级次数')
})

await check('模型请求抛错时降级而非失败', async () => {
  const notes = []
  const fakeLlm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'upstream 500' } } }
    },
  }
  const r = await semanticPlan(scanned, { cwd: tmp, llm: fakeLlm, provider: 'p', model: 'm', notes })
  assert.equal(r.fallback, false)
  assert.ok(r.plan.modules.length >= 2)
})

await check('空仓库返回 fallback', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cwplan-empty-'))
  const notes = []
  const r = await semanticPlan([], { cwd: empty, llm: null, notes })
  assert.equal(r.fallback, true)
  console.log(`      reason=${r.reason}，note=${notes.at(-1)}`)
  fs.rmSync(empty, { recursive: true, force: true })
})

await check('plan.graph 可序列化且含组件与边', async () => {
  const r = await semanticPlan(scanned, { cwd: tmp, llm: null })
  const g = r.plan.graph
  assert.ok(Array.isArray(g.components) && g.components.length, '应有组件')
  assert.ok(Array.isArray(g.edges), '应有 edges 数组')
  // JSON 往返不丢信息（plan 要随 job 持久化）
  const round = JSON.parse(JSON.stringify(r.plan))
  assert.equal(round.modules.length, r.plan.modules.length)
  assert.equal(round.graph.components.length, g.components.length)
})

await check('localPlan 对同一批文件仍可用（降级路径保活）', async () => {
  const plan = localPlan(scanned)
  assert.ok(plan.modules.length >= 2)
  assert.match(plan.project, /顶层目录分组/)
})

await check('plan 的模块名 slugify 后不冲突', async () => {
  const r = await semanticPlan(scanned, { cwd: tmp, llm: null })
  const slugs = r.plan.modules.map((m) => m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  assert.equal(new Set(slugs).size, slugs.length, `模块名 slug 重复：${slugs.join(',')}`)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
process.exit(fails.length ? 1 : 0)
