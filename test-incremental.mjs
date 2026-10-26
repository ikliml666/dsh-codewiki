// 符号级增量测试：快照存取 + 组件级变更折算 + 文章保留/跳过判定。
// 关键场景是「文件变了但模块接口没变 → 不重写文章」，这是上游 FSoft updater 的核心收益。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  slimGraph, graphFromSnapshot, snapshotPath, loadSnapshot, saveSnapshot,
  filterStaleTasks, describeChange, normRel, componentsByFile, SNAPSHOT_VERSION, sameSnapshotContent,
} from './lib/incremental.js'
import { extractRepoGraph } from './lib/symbols.js'
import { bodyHash } from './lib/graph-diff.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const A = `export function calcTax(amount, rate) {\n  return amount * rate\n}\n`
const A2 = `export function calcTax(amount, rate) {\n  // 只改了注释和实现细节，签名不变\n  const base = Number(amount) || 0\n  return base * rate\n}\n`
const A3 = `export function calcTax(amount, rate, currency) {\n  return amount * rate\n}\n`
const B = `export class Invoice {\n  constructor(id) { this.id = id }\n}\n`

async function graphOf(files) {
  const ex = await extractRepoGraph(Object.entries(files).map(([p, content]) => ({ path: p, content })), {})
  return ex.graph
}

await check('slimGraph 不含源码，但带固化 bodyHash', async () => {
  const g = await graphOf({ 'src/a.js': A })
  const snap = slimGraph(g)
  const json = JSON.stringify(snap)
  assert.equal(json.includes('amount * rate'), false, '快照不应含源码全文')
  for (const c of snap.components) {
    assert.ok(c.bodyHash && c.bodyHash.length === 40, `组件 ${c.id} 应带 sha1 bodyHash`)
  }
  assert.equal(snap.version, SNAPSHOT_VERSION)
})

await check('快照往返后 bodyHash 保持一致（不读源码也能判实现变更）', async () => {
  const g = await graphOf({ 'src/a.js': A })
  const back = graphFromSnapshot(slimGraph(g))
  const id = [...g.keys()][0]
  assert.equal(bodyHash(back.get(id)), bodyHash(g.get(id)))
})

await check('只有注释变更：实现 hash 变、签名不变 → 记为 body', async () => {
  const g1 = await graphOf({ 'src/a.js': A })
  const g2 = await graphOf({ 'src/a.js': A2 })
  const tasks = [{ name: 'modules/a.md', articlePath: '/x/a.md', sources: ['src/a.js'] }]
  const r = filterStaleTasks(tasks, g1, g2)
  assert.equal(r.dropped.length, 0, '实现变了应保留文章')
  assert.equal(r.keep.length, 1)
  assert.equal(r.counts.body, 1, `应记 1 个 body 变更，实际 ${JSON.stringify(r.counts)}`)
  assert.equal(r.counts.interface, 0, '签名没变不应记 interface')
  assert.ok(r.keep[0].changedComponents.length, '保留时该带出变更组件供写作者参考')
})

await check('签名变更记为 interface（架构描述必须重写）', async () => {
  const g1 = await graphOf({ 'src/a.js': A })
  const g2 = await graphOf({ 'src/a.js': A3 })
  const r = filterStaleTasks([{ name: 'a', articlePath: '/x/a.md', sources: ['src/a.js'] }], g1, g2)
  assert.equal(r.counts.interface, 1, `应记 interface，实际 ${JSON.stringify(r.counts)}`)
  assert.match(describeChange(r.counts), /接口变/)
})

await check('文件内容变了但符号完全没变 → 跳过该文章', async () => {
  const g1 = await graphOf({ 'src/a.js': A, 'src/b.js': B })
  // 只动 a.js 里的空白/末尾换行，符号与实现本体（normalizeBody 后）一致
  const g2 = await graphOf({ 'src/a.js': `${A}\n\n`, 'src/b.js': `${B}\n` })
  const tasks = [
    { name: 'modules/a.md', articlePath: '/x/a.md', sources: ['src/a.js'] },
    { name: 'modules/b.md', articlePath: '/x/b.md', sources: ['src/b.js'] },
  ]
  const r = filterStaleTasks(tasks, g1, g2)
  assert.equal(r.keep.length, 0, `无实质变更应全跳过，实际保留 ${r.keep.map((t) => t.name).join(',')}`)
  assert.equal(r.dropped.length, 2)
  assert.match(describeChange(r.counts), /无实质变更/)
})

await check('新增文件里的组件算 added → 覆盖它的文章保留', async () => {
  const g1 = await graphOf({ 'src/a.js': A })
  const g2 = await graphOf({ 'src/a.js': A, 'src/c.js': B })
  const r = filterStaleTasks([{ name: 'modules/c.md', articlePath: '/x/c.md', sources: ['src/c.js'] }], g1, g2)
  assert.equal(r.keep.length, 1, '新增文件的文章必须写')
  // 类会同时产出类本身与 constructor 两个组件，这里只断言「至少含该类」
  assert.ok(r.counts.added >= 1, `应记 added，实际 ${JSON.stringify(r.counts)}`)
  assert.ok(r.change.added.has('src/c.js#Invoice'), `added 应含 Invoice：${[...r.change.added]}`)
})

await check('源文件被删 → deleted 计入变更', async () => {
  const g1 = await graphOf({ 'src/a.js': A, 'src/c.js': B })
  const g2 = await graphOf({ 'src/a.js': A })
  const r = filterStaleTasks([{ name: 'modules/c.md', articlePath: '/x/c.md', sources: ['src/c.js'] }], g1, g2)
  assert.ok(r.counts.deleted >= 1, `应记 deleted，实际 ${JSON.stringify(r.counts)}`)
  assert.ok(r.change.deleted.has('src/c.js#Invoice'), `deleted 应含 Invoice：${[...r.change.deleted]}`)
})

await check('source_files 无符号（配置文件）→ 保守保留并标 symbolFallback', async () => {
  const r = filterStaleTasks(
    [{ name: 'modules/conf.md', articlePath: '/x/conf.md', sources: ['package.json'] }],
    new Map(), new Map(),
  )
  assert.equal(r.keep.length, 1, '无法判定的文章必须保留')
  assert.equal(r.keep[0].symbolFallback, true)
})

await check('路径分隔符与 ./ 前缀都能归一', async () => {
  assert.equal(normRel('.\\src\\a.js'), 'src/a.js')
  assert.equal(normRel('./src/a.js'), 'src/a.js')
  const g1 = await graphOf({ 'src/a.js': A })
  const g2 = await graphOf({ 'src/a.js': A2 })
  const r = filterStaleTasks([{ name: 'a', articlePath: '/x/a.md', sources: ['.\\src\\a.js'] }], g1, g2)
  assert.equal(r.keep.length, 1, '反斜杠路径也应命中组件')
})

await check('多源文件的文章：任一源变动即保留，且带出全部命中组件', async () => {
  const g1 = await graphOf({ 'src/a.js': A, 'src/b.js': B })
  const g2 = await graphOf({ 'src/a.js': A, 'src/b.js': `${B}\nexport function extra() { return 1 }\n` })
  const r = filterStaleTasks([{ name: 'ab', articlePath: '/x/ab.md', sources: ['src/a.js', 'src/b.js'] }], g1, g2)
  assert.equal(r.keep.length, 1)
  assert.ok(r.keep[0].changedComponents.includes('src/b.js#extra'), `应带出新组件：${r.keep[0].changedComponents}`)
})

await check('componentsByFile 按文件聚合组件 id', async () => {
  const g = await graphOf({ 'src/a.js': A, 'src/b.js': B })
  const m = componentsByFile(g)
  assert.deepEqual([...m.keys()].sort(), ['src/a.js', 'src/b.js'])
  assert.ok(m.get('src/a.js').includes('src/a.js#calcTax'))
})

await check('快照落盘与回读（含目录自动创建）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwinc-'))
  const wiki = path.join(tmp, '.codewiki')
  const g = await graphOf({ 'src/a.js': A })
  const r = saveSnapshot(wiki, slimGraph(g, { commit: 'abc123' }))
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(snapshotPath(wiki)))
  const back = loadSnapshot(wiki)
  assert.equal(back.commit, 'abc123')
  assert.equal(back.components.length, 1)
  assert.equal(back.components[0].id, 'src/a.js#calcTax')
})

await check('快照版本不符/坏 JSON → 视作没有（退化成全量）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwinc2-'))
  const p = snapshotPath(tmp)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ version: 999, components: [] }), 'utf8')
  assert.equal(loadSnapshot(tmp), null)
  fs.writeFileSync(p, '{not json', 'utf8')
  assert.equal(loadSnapshot(tmp), null)
})

await check('改名（删除+新增近似）归到 renamed 而非增删两条', async () => {
  const long = `export function processEverything(input, options) {\n  const a = input.map((x) => x * 2)\n  const b = a.filter((x) => x > 0)\n  return { a, b, options }\n}\n`
  const g1 = await graphOf({ 'src/old.js': long })
  const g2 = await graphOf({ 'src/new.js': long })
  const r = filterStaleTasks([{ name: 'n', articlePath: '/x/n.md', sources: ['src/new.js'] }], g1, g2)
  assert.equal(r.counts.renamed, 1, `应识别为改名，实际 ${JSON.stringify(r.counts)}`)
  assert.equal(r.counts.added, 0)
  assert.equal(r.counts.deleted, 0)
  assert.equal(r.keep.length, 1, '改名后的文章必须重写')
})

await check('快照内容比较忽略 generatedAt/commit（避免空转提交）', async () => {
  const comps = [{ id: 'src/a.js#f', name: 'f', relativePath: 'src/a.js', bodyHash: 'h1' }]
  const a = { version: 1, generatedAt: '2026-01-01T00:00:00Z', commit: 'aaa', components: comps }
  const b = { version: 1, generatedAt: '2026-10-27T00:00:00Z', commit: 'bbb', components: [...comps].reverse() }
  assert.equal(sameSnapshotContent(a, b), true, '仅元数据与顺序不同 → 视为没变')
  const c = { version: 1, components: [{ ...comps[0], bodyHash: 'h2' }] }
  assert.equal(sameSnapshotContent(a, c), false, 'bodyHash 变了 → 视为变了')
  const d = { version: 1, components: [{ ...comps[0], dependsOn: ['src/x.js#g'] }] }
  assert.equal(sameSnapshotContent(a, d), false, '依赖边变了 → 视为变了')
  assert.equal(sameSnapshotContent(null, a), false)
})

console.log(`\n${pass} passed, ${fails.length} failed`)

if (fails.length) { for (const f of fails) console.log(f.err?.stack ?? ''); process.exitCode = 1 }
