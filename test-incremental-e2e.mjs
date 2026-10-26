// 端到端：stale 的符号级判定链路（快照落盘 -> 代码改动 -> 判定 -> 是否重写）。
// 用真实仓库目录与真实 cw 子命令外的全部环节，验证「只改实现细节不重写文章」这条主收益。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractCurrentGraph, currentCommit } from './index.js'
import { slimGraph, loadSnapshot, saveSnapshot, filterStaleTasks, describeChange } from './lib/incremental.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwe2e-'))
const wiki = path.join(tmp, '.codewiki')
const write = (rel, content) => {
  const abs = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

const V1 = `import { slugify } from '../util/strings.js'

export function calcTax(amount, rate) {
  return amount * rate
}

export class Invoice {
  constructor(id) { this.id = id }
  total(items) { return items.reduce((s, i) => s + i.price, 0) }
}
`
const STRINGS = `export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
`
write('src/billing/invoice.js', V1)
write('src/util/strings.js', STRINGS)

await check('提取当前符号图（真实目录）', async () => {
  const cur = await extractCurrentGraph(tmp)
  assert.equal(cur.ready, true, `应就绪，原因：${cur.reason}`)
  assert.ok(cur.graph.size >= 4, `组件数应 >=4，实际 ${cur.graph.size}：${[...cur.graph.keys()].join(',')}`)
  assert.ok(cur.graph.has('src/billing/invoice.js#calcTax'))
  assert.ok(cur.graph.has('src/billing/invoice.js#Invoice'))
  console.log(`      ${cur.graph.size} 个组件：${[...cur.graph.keys()].join(', ')}`)
})

await check('快照落盘到 .codewiki/temp/symbol-graph.json', async () => {
  const cur = await extractCurrentGraph(tmp)
  const r = saveSnapshot(wiki, slimGraph(cur.graph, { commit: currentCommit(tmp) }))
  assert.equal(r.ok, true, r.reason)
  assert.ok(fs.existsSync(path.join(wiki, 'temp', 'symbol-graph.json')))
  const snap = loadSnapshot(wiki)
  assert.equal(snap.components.length, cur.graph.size)
})

await check('只改函数体实现（签名不变）→ 该文章要重写，记 body', async () => {
  write('src/billing/invoice.js', V1.replace('  return amount * rate', '  const base = Number(amount) || 0\n  return base * rate'))
  const snap = loadSnapshot(wiki)
  const cur = await extractCurrentGraph(tmp)
  const tasks = [
    { name: 'modules/billing.md', articlePath: path.join(wiki, 'modules/billing.md'), sources: ['src/billing/invoice.js'] },
    { name: 'modules/util.md', articlePath: path.join(wiki, 'modules/util.md'), sources: ['src/util/strings.js'] },
  ]
  const { graphFromSnapshot } = await import('./lib/incremental.js')
  const r = filterStaleTasks(tasks, graphFromSnapshot(snap), cur.graph)
  assert.equal(r.keep.length, 1, `只有 billing 该重写，实际保留 ${r.keep.map((t) => t.name).join(',')}`)
  assert.equal(r.keep[0].name, 'modules/billing.md')
  assert.equal(r.dropped.length, 1, 'util 未变，应跳过')
  assert.equal(r.dropped[0].name, 'modules/util.md')
  console.log(`      变更摘要：${describeChange(r.counts)}`)
})

await check('只改空白/注释 → 两篇都跳过（这是省钱的场景）', async () => {
  // 回到 V1，然后只加空行与纯注释行
  write('src/billing/invoice.js', V1)
  saveSnapshot(wiki, slimGraph((await extractCurrentGraph(tmp)).graph))
  write('src/billing/invoice.js', `// 文件头注释\n\n${V1}\n\n`)
  write('src/util/strings.js', `${STRINGS}\n`)
  const snap = loadSnapshot(wiki)
  const cur = await extractCurrentGraph(tmp)
  const { graphFromSnapshot } = await import('./lib/incremental.js')
  const tasks = [
    { name: 'modules/billing.md', articlePath: '/x/b.md', sources: ['src/billing/invoice.js'] },
    { name: 'modules/util.md', articlePath: '/x/u.md', sources: ['src/util/strings.js'] },
  ]
  const r = filterStaleTasks(tasks, graphFromSnapshot(snap), cur.graph)
  assert.equal(r.keep.length, 0, `空白/注释变更应全部跳过，实际保留 ${r.keep.map((t) => t.name).join(',')}`)
  assert.equal(r.dropped.length, 2)
  assert.match(describeChange(r.counts), /无实质变更/)
})

await check('签名加参数 → interface 变更，文章必重写', async () => {
  write('src/billing/invoice.js', V1)
  saveSnapshot(wiki, slimGraph((await extractCurrentGraph(tmp)).graph))
  write('src/billing/invoice.js', V1.replace('calcTax(amount, rate)', 'calcTax(amount, rate, currency = \'CNY\')'))
  const snap = loadSnapshot(wiki)
  const cur = await extractCurrentGraph(tmp)
  const { graphFromSnapshot } = await import('./lib/incremental.js')
  const r = filterStaleTasks(
    [{ name: 'modules/billing.md', articlePath: '/x/b.md', sources: ['src/billing/invoice.js'] }],
    graphFromSnapshot(snap), cur.graph,
  )
  assert.equal(r.keep.length, 1)
  assert.ok(r.counts.interface >= 1, `应记 interface，实际 ${JSON.stringify(r.counts)}`)
})

await check('新增源文件 → 新文章必须写', async () => {
  write('src/api/routes.js', `export function registerRoutes(app) {\n  app.get('/x', (req, res) => res.json({}))\n}\n`)
  const snap = loadSnapshot(wiki)
  const cur = await extractCurrentGraph(tmp)
  const { graphFromSnapshot } = await import('./lib/incremental.js')
  const r = filterStaleTasks(
    [{ name: 'modules/api.md', articlePath: '/x/a.md', sources: ['src/api/routes.js'] }],
    graphFromSnapshot(snap), cur.graph,
  )
  assert.equal(r.keep.length, 1)
  assert.ok(r.counts.added >= 1)
})

await check('删掉整个源文件 → deleted 计入，旧文章要更新', async () => {
  write('src/billing/invoice.js', V1)
  saveSnapshot(wiki, slimGraph((await extractCurrentGraph(tmp)).graph))
  fs.rmSync(path.join(tmp, 'src/util/strings.js'))
  const snap = loadSnapshot(wiki)
  const cur = await extractCurrentGraph(tmp)
  const { graphFromSnapshot } = await import('./lib/incremental.js')
  const r = filterStaleTasks(
    [{ name: 'modules/util.md', articlePath: '/x/u.md', sources: ['src/util/strings.js'] }],
    graphFromSnapshot(snap), cur.graph,
  )
  assert.ok(r.counts.deleted >= 1, `应记 deleted，实际 ${JSON.stringify(r.counts)}`)
})

await check('无 .codewiki 目录时 loadSnapshot 安静返回 null', async () => {
  assert.equal(loadSnapshot(path.join(tmp, 'nope')), null)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) { for (const f of fails) console.log(f.err?.stack ?? ''); process.exitCode = 1 }
