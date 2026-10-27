// 增量计划器测试（P0-3）：反向依赖影响、新文件归属、未重写页 stale scan、无归属变更。
//
// 这些正是旧 filterStaleTasks 做不到的三件事（lib/incremental.js:140-193）：
// 只从文章既有 sources 收组件，命中就写、没命中就丢——依赖方文章不会重写，
// 新文件被静默丢弃，未重写页从不检查是否已经过期。
import assert from 'node:assert/strict'
import {
  planUpdate, realChangedIds, dependentsOf, scanStaleArticle,
  buildModuleMap, migrateModuleMap, sameModuleMap, isSourcePath, MODULE_MAP_VERSION,
} from './lib/update-planner.js'
import { extractRepoGraph, resolveImportEdges } from './lib/symbols.js'
import { diffGraphs } from './lib/graph-diff.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

// 与真实链路一致：符号图必须带 import 边，反向依赖影响才可能生效。
async function graphOf(files) {
  const entries = Object.entries(files).map(([p, content]) => ({ path: p, content }))
  const ex = await extractRepoGraph(entries, {})
  const textByFile = new Map(entries.map((e) => [e.path, e.content]))
  resolveImportEdges(ex.graph, ex.byFile, textByFile)
  return ex.graph
}

const STRINGS_V1 = `export function slugify(s) {\n  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')\n}\n`
// 签名变更（加参数）= interface 类变更，使用方文章必须重写
const STRINGS_V2 = `export function slugify(s, sep) {\n  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, sep ?? '-')\n}\n`
// 只改注释 = 纯注释变更，必须仍然跳过。注释必须写在函数体内才会进组件的 sourceCode
// （tree-sitter 里函数前的注释是 sibling 节点，不在节点文本内）。
const STRINGS_COMMENT = `export function slugify(s) {\n  // 只补了一行注释，实现完全不变\n  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')\n}\n`
const INVOICE = `import { slugify } from '../util/strings.js'\n\nexport function invoiceSlug(id) {\n  return slugify(String(id))\n}\n`

const ARTICLES = [
  { name: 'modules/util.md', articlePath: '/w/modules/util.md', sources: ['src/util/strings.js'] },
  { name: 'modules/billing.md', articlePath: '/w/modules/billing.md', sources: ['src/billing/invoice.js'] },
]

const changeSetOf = (over = {}) => ({
  ok: true, state: 'ok', sourceChanges: [], all: [], deleted: [], renamed: [], untracked: [], ...over,
})

await check('接口变更 → 自身文章写；反向依赖文章也写（旧实现只写第一篇）', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const newGraph = await graphOf({ 'src/util/strings.js': STRINGS_V2, 'src/billing/invoice.js': INVOICE })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/util/strings.js'], all: ['src/util/strings.js'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  const byName = Object.fromEntries(plan.actions.map((a) => [a.name, a]))
  assert.equal(byName['modules/util.md'].action, 'write', '自身源文件接口变了必须重写')
  assert.equal(byName['modules/billing.md'].action, 'write',
    `反向依赖文章也应重写，实际 ${byName['modules/billing.md'].action}：${byName['modules/billing.md'].reason}`)
  assert.ok(byName['modules/billing.md'].impactedBy.length, '应记录被哪个变更组件影响')
  assert.equal(plan.summary.write, 2)
  assert.equal(plan.needsFull, false)
})

await check('纯注释变更 → 两篇都 keep（降级行为必须保留）', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const newGraph = await graphOf({ 'src/util/strings.js': STRINGS_COMMENT, 'src/billing/invoice.js': INVOICE })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/util/strings.js'], all: ['src/util/strings.js'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  assert.equal(plan.summary.write, 0, `纯注释不该触发重写：${JSON.stringify(plan.actions.map((a) => [a.name, a.action]))}`)
  assert.equal(plan.summary.keep, 2)
  assert.ok(plan.cosmeticComponents.length >= 1, '应记下被降级的组件')
})

await check('实现细节变更（非注释、签名不变）→ 只重写自身文章，不波及依赖方', async () => {
  const IMPL = `export function slugify(s) {\n  const t = String(s).toLowerCase()\n  return t.replace(/[^a-z0-9]+/g, '-')\n}\n`
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const newGraph = await graphOf({ 'src/util/strings.js': IMPL, 'src/billing/invoice.js': INVOICE })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/util/strings.js'], all: ['src/util/strings.js'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  const byName = Object.fromEntries(plan.actions.map((a) => [a.name, a]))
  assert.equal(byName['modules/util.md'].action, 'write')
  assert.equal(byName['modules/billing.md'].action, 'keep', '实现细节变了不该连带重写使用方文章')
})

await check('新文件无归属 → 同模块路由给已有文章（保守重写）', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const newGraph = await graphOf({
    'src/util/strings.js': STRINGS_V1,
    'src/util/dates.js': 'export function fmtDate(d) { return String(d) }\n',
    'src/billing/invoice.js': INVOICE,
  })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/util/dates.js'], all: ['src/util/dates.js'], untracked: ['src/util/dates.js'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  const byName = Object.fromEntries(plan.actions.map((a) => [a.name, a]))
  assert.equal(plan.unmappedChanges.length, 0, `同模块新文件应被路由，不该算无归属：${JSON.stringify(plan.unmappedChanges)}`)
  assert.equal(byName['modules/util.md'].action, 'write')
  assert.deepEqual(byName['modules/util.md'].newFiles, ['src/util/dates.js'])
  assert.equal(plan.routedTo.length, 1)
})

await check('新文件完全无归属 → unmappedChanges + needsFull（绝不静默丢弃）', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const newGraph = await graphOf({
    'src/util/strings.js': STRINGS_V1,
    'tools/build.rs': 'fn main() {}\n',
  })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['tools/build.rs'], all: ['tools/build.rs'], untracked: ['tools/build.rs'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  assert.deepEqual(plan.unmappedChanges, ['tools/build.rs'])
  assert.equal(plan.needsFull, true)
  assert.match(plan.fullReason, /无文章归属/)
  assert.ok(plan.warnings.some((w) => w.includes('tools/build.rs')))
})

await check('非源码文件无归属：只记账 warning，不触发全量', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const newGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['notes/scratch.md'], all: ['notes/scratch.md'], untracked: ['notes/scratch.md'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  assert.deepEqual(plan.unmappedChanges, ['notes/scratch.md'])
  assert.equal(plan.needsFull, false, '笔记类文件不该让增量永远退回全量')
  assert.ok(plan.warnings.some((w) => w.includes('非源码文件')))
  assert.equal(isSourcePath('notes/scratch.md'), false)
  assert.equal(isSourcePath('src/util/strings.js'), true)
})

await check('source_files 有文件被删除 → write，理由点名被删文件', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const newGraph = await graphOf({ 'src/billing/invoice.js': INVOICE })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/util/strings.js'], all: ['src/util/strings.js'], deleted: ['src/util/strings.js'] }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  const a = plan.actions.find((x) => x.name === 'modules/util.md')
  assert.equal(a.action, 'write')
  assert.match(a.reason, /已被删除/)
})

await check('source_files 有文件被改名 → write，理由含 from→to', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const newGraph = await graphOf({ 'src/util/str.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const plan = planUpdate({
    changeSet: changeSetOf({
      sourceChanges: ['src/util/strings.js', 'src/util/str.js'],
      all: ['src/util/strings.js', 'src/util/str.js'],
      renamed: [{ from: 'src/util/strings.js', path: 'src/util/str.js' }],
    }),
    oldGraph, newGraph, articles: ARTICLES,
  })
  const a = plan.actions.find((x) => x.name === 'modules/util.md')
  assert.equal(a.action, 'write')
  assert.match(a.reason, /改名/)
})

await check('文章缺 source_files → review + needsFull（旧实现只记一条 note）', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/util/strings.js'], all: ['src/util/strings.js'] }),
    oldGraph: g, newGraph: g,
    articles: [...ARTICLES, { name: 'modules/orphan.md', articlePath: '/w/modules/orphan.md', sources: [] }],
  })
  const a = plan.actions.find((x) => x.name === 'modules/orphan.md')
  assert.equal(a.action, 'review')
  assert.equal(plan.needsFull, true)
  assert.equal(plan.missingSources.length, 1)
})

await check('stale scan：未重写页正文仍引用已删除符号 → 升级为 write', async () => {
  const oldGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/legacy/old.js': 'export function legacyOnly() { return 1 }\n' })
  const newGraph = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const articles = [
    ...ARTICLES,
    {
      name: 'modules/legacy.md', articlePath: '/w/modules/legacy.md',
      sources: ['src/util/strings.js'], // 注意：它的 source_files 没有 legacy.js，但正文提到 legacyOnly
      content: '---\ntitle: legacy\n---\n\n## 用法\n\n调用 legacyOnly() 完成迁移。\n',
    },
  ]
  const plan = planUpdate({
    changeSet: changeSetOf({ sourceChanges: ['src/legacy/old.js'], all: ['src/legacy/old.js'], deleted: ['src/legacy/old.js'] }),
    oldGraph, newGraph, articles,
  })
  const a = plan.actions.find((x) => x.name === 'modules/legacy.md')
  assert.equal(a.action, 'write', `正文引用已删符号应升级为 write，实际 ${a.action}：${a.reason}`)
  assert.match(a.reason, /stale scan/)
})

await check('stale scan：死链 → review（要求人工复核，不硬重写）', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const articles = [{
    name: 'modules/util.md', articlePath: '/w/modules/util.md', sources: ['src/util/strings.js'],
    content: '---\ntitle: util\n---\n\n见 [[modules/gone|已删模块]] 与 [旧文](modules/gone.md)。\n',
  }]
  const plan = planUpdate({
    changeSet: changeSetOf(), oldGraph: g, newGraph: g, articles,
    options: { linkExists: (t) => !String(t).includes('gone') },
  })
  const a = plan.actions[0]
  assert.equal(a.action, 'review', `死链应进 review，实际 ${a.action}：${a.reason}`)
  assert.ok(a.staleIssues.some((i) => i.kind === 'dead-link'))
})

await check('文件级降级（无图/关闭符号增量）：删除/新文件仍被处理', async () => {
  const plan = planUpdate({
    changeSet: changeSetOf({
      sourceChanges: ['src/util/strings.js', 'src/util/new.js'],
      all: ['src/util/strings.js', 'src/util/new.js'],
      untracked: ['src/util/new.js'],
    }),
    oldGraph: null, newGraph: null, articles: ARTICLES, options: { fileLevel: true },
  })
  assert.equal(plan.fileLevel, true)
  const byName = Object.fromEntries(plan.actions.map((a) => [a.name, a]))
  assert.equal(byName['modules/util.md'].action, 'write', '文件级降级也必须看见自身源文件变化')
})

await check('无变更 → 全部 keep，needsFull=false', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const plan = planUpdate({ changeSet: changeSetOf(), oldGraph: g, newGraph: g, articles: ARTICLES })
  assert.equal(plan.summary.keep, 2)
  assert.equal(plan.summary.write, 0)
  assert.equal(plan.needsFull, false)
})

await check('计划可 JSON 序列化（要落 update-record）', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const plan = planUpdate({ changeSet: changeSetOf(), oldGraph: g, newGraph: g, articles: ARTICLES })
  const round = JSON.parse(JSON.stringify(plan))
  assert.equal(round.version, plan.version)
  assert.equal(round.actions.length, plan.actions.length)
})

await check('dependentsOf：反向边索引（id 与文件路径两种依赖写法都认）', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1, 'src/billing/invoice.js': INVOICE })
  const ids = [...g.keys()].filter((id) => id.includes('slugify'))
  const dep = dependentsOf(g, ids)
  assert.ok([...dep.values()].flat().some((id) => id.includes('invoiceSlug')),
    `应找到依赖 slugify 的组件，实际 ${JSON.stringify([...dep])}`)
})

await check('scanStaleArticle 空内容：无 issue、不重写', async () => {
  const r = scanStaleArticle({ content: '' })
  assert.deepEqual(r.issues, [])
  assert.equal(r.needsRewrite, false)
})

await check('buildModuleMap：记录文章→sources/components/module，可往返', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const mm = buildModuleMap({ articles: ARTICLES, graph: g })
  assert.equal(mm.version, MODULE_MAP_VERSION)
  const entry = mm.articles['modules/util.md']
  assert.deepEqual(entry.sources, ['src/util/strings.js'])
  assert.ok(entry.components.length >= 1, '应记下该文件里的组件 id')
  assert.equal(JSON.parse(JSON.stringify(mm)).version, MODULE_MAP_VERSION)
})

await check('migrateModuleMap：旧 wiki 无 module-map 时从 frontmatter 保守迁移', async () => {
  const mm = migrateModuleMap({ articles: ARTICLES })
  assert.equal(mm.migratedFromFrontmatter, true)
  assert.deepEqual(mm.articles['modules/billing.md'].sources, ['src/billing/invoice.js'])
  assert.deepEqual(mm.articles['modules/billing.md'].components, [], '迁移不臆造组件')
})

await check('sameModuleMap：忽略 generatedAt 只比实质内容', async () => {
  const g = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const a = buildModuleMap({ articles: ARTICLES, graph: g, now: '2020-01-01T00:00:00.000Z' })
  const b = buildModuleMap({ articles: ARTICLES, graph: g, now: '2026-01-01T00:00:00.000Z' })
  assert.equal(sameModuleMap(a, b), true)
  const c = buildModuleMap({ articles: [ARTICLES[0]], graph: g })
  assert.equal(sameModuleMap(a, c), false)
})

await check('realChangedIds：interface 进 structural、纯注释进 cosmetic', async () => {
  const g1 = await graphOf({ 'src/util/strings.js': STRINGS_V1 })
  const g2 = await graphOf({ 'src/util/strings.js': STRINGS_V2 })
  const r = realChangedIds(diffGraphs(g1, g2), g1, g2)
  assert.equal(r.real.size, 1)
  assert.equal(r.structural.size, 1)
  assert.equal(r.cosmetic.size, 0)
  const g3 = await graphOf({ 'src/util/strings.js': STRINGS_COMMENT })
  const r2 = realChangedIds(diffGraphs(g1, g3), g1, g3)
  assert.equal(r2.cosmetic.size, 1)
  assert.equal(r2.real.size, 0)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
