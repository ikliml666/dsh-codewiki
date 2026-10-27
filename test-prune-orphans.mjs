// test-prune-orphans.mjs — pruneOrphanModules 的安全边界。
//
// 这条逻辑会**删文件**，所以测试重点不是「能不能删掉」，而是「会不会误删」：
// 增量编译、失败文章、非 modules 目录，都必须一个不动。
// 运行：node test-prune-orphans.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pruneOrphanModules } from './index.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) } catch (e) { fails.push({ label, err: e }); console.log(`FAIL  ${label}`) }
}

// 造一个 wiki 目录：modules 下 4 篇 + concepts 下 1 篇 + 根下 1 篇
function makeWiki() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'))
  const wiki = path.join(root, '.codewiki')
  fs.mkdirSync(path.join(wiki, 'modules'), { recursive: true })
  fs.mkdirSync(path.join(wiki, 'concepts'), { recursive: true })
  for (const n of ['keep.md', 'orphan-a.md', 'orphan-b.md', 'written-failed.md']) {
    fs.writeFileSync(path.join(wiki, 'modules', n), '# x\n')
  }
  fs.writeFileSync(path.join(wiki, 'concepts', 'stays.md'), '# c\n')
  fs.writeFileSync(path.join(wiki, '_architecture.md'), '# a\n')
  return { root, wiki }
}
const ls = (wiki, sub = 'modules') => fs.readdirSync(path.join(wiki, sub)).sort()

await check('全量编译：删掉规划外的孤儿，保留规划内的', async () => {
  const { wiki } = makeWiki()
  const r = pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: [{ name: 'keep' }] },
    articles: [{ name: 'modules/keep.md' }],
  })
  assert.deepEqual(r.removed.sort(), ['orphan-a.md', 'orphan-b.md', 'written-failed.md'])
  assert.deepEqual(ls(wiki), ['keep.md'], '只剩规划内的那篇')
})

await check('全量编译：本次写过但失败的文章要保留（不删证据）', async () => {
  const { wiki } = makeWiki()
  pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: [{ name: 'keep' }] },
    articles: [
      { name: 'modules/keep.md', ok: true },
      { name: 'modules/written-failed.md', ok: false },
    ],
  })
  assert.deepEqual(ls(wiki), ['keep.md', 'written-failed.md'], '失败的那篇不能删')
})

await check('增量编译（kind=stale）一律不动', async () => {
  const { wiki } = makeWiki()
  const before = ls(wiki)
  const r = pruneOrphanModules({
    kind: 'stale', wikiPath: wiki,
    plan: { modules: [{ name: 'keep' }] },
    articles: [],
  })
  assert.equal(r.removed.length, 0, '增量不能删任何文件')
  assert.deepEqual(ls(wiki), before, '目录内容完全不变')
  assert.match(r.skipped, /非全量/)
})

await check('无 plan.modules（规划失败退回目录分组）时不删', async () => {
  const { wiki } = makeWiki()
  const before = ls(wiki)
  const r = pruneOrphanModules({ kind: 'full', wikiPath: wiki, plan: null, articles: [] })
  assert.equal(r.removed.length, 0)
  assert.deepEqual(ls(wiki), before)
  assert.match(r.skipped, /无完整模块清单/)
})

await check('modules 清单为空数组时不删（防止规划异常清空整个 wiki）', async () => {
  const { wiki } = makeWiki()
  const before = ls(wiki)
  const r = pruneOrphanModules({ kind: 'full', wikiPath: wiki, plan: { modules: [] }, articles: [] })
  assert.equal(r.removed.length, 0)
  assert.deepEqual(ls(wiki), before, '空清单是最危险的输入，必须一个不动')
})

await check('concepts/ 与 _architecture.md 永不被碰', async () => {
  const { wiki } = makeWiki()
  pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: [{ name: 'keep' }] },
    articles: [],
  })
  assert(fs.existsSync(path.join(wiki, 'concepts', 'stays.md')), 'concepts 应保留')
  assert(fs.existsSync(path.join(wiki, '_architecture.md')), '_architecture.md 应保留')
})

await check('modules 目录不存在时安全返回', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-empty-'))
  const r = pruneOrphanModules({ kind: 'full', wikiPath: root, plan: { modules: [{ name: 'x' }] }, articles: [] })
  assert.equal(r.removed.length, 0)
})

await check('只删 .md，不碰同目录其他文件', async () => {
  const { wiki } = makeWiki()
  fs.writeFileSync(path.join(wiki, 'modules', 'notes.txt'), 'keep me')
  pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: [{ name: 'keep' }] },
    articles: [],
  })
  assert(fs.existsSync(path.join(wiki, 'modules', 'notes.txt')), '非 .md 文件不该动')
})

await check('slugify 规则与文件名一致：带空格/中文的模块名能匹配上自己的文章', async () => {
  const { wiki } = makeWiki()
  fs.writeFileSync(path.join(wiki, 'modules', 'core-application.md'), '# y\n')
  const r = pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: [{ name: 'Core Application' }, { name: 'keep' }] },
    articles: [],
  })
  // 'Core Application' -> 'core-application'，应被认定为本模块产物而不删
  assert(!r.removed.includes('core-application.md'), 'slug 匹配上的不能删')
  assert(fs.existsSync(path.join(wiki, 'modules', 'core-application.md')))
})

// 中文/斜杠/括号这些真会被规划产出的模块名，必须与任务组装侧算出同一个文件名。
// 造文件名时**不能**照抄 slugify 的规则来凭空造（那样测试只是自证），而要用
// 「规划名 -> 期望文件名」的显式对照断言，两边规则一旦漂移就会红。
await check('中文/斜杠/括号模块名能匹配上自己的文章（不误删）', async () => {
  const { wiki } = makeWiki()
  const cases = [
    ['核心应用', '核心应用.md'],
    ['模块/子模块', '模块-子模块.md'],
    ['日志与追踪 (logging)', '日志与追踪-logging.md'],
  ]
  for (const [, file] of cases) fs.writeFileSync(path.join(wiki, 'modules', file), '# y\n')
  const r = pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: cases.map(([name]) => ({ name })) },
    articles: [],
  })
  const left = ls(wiki)
  for (const [, file] of cases) {
    assert(left.includes(file), `规划内文章 ${file} 被误删（实际剩下 ${left.join('、')}）`)
    assert(!r.removed.includes(file), `${file} 不该出现在 removed 里`)
  }
})

// 删除失败必须记账且不中断：一处删不掉不能拖垮整轮清理，也不能静默吞掉。
// 用 chmod 造一个真删不掉的目标（Windows 上 chmod 无效，改用 mock fs.rmSync）。
await check('删除失败：记账进 failed、其他孤儿照删、不抛错', async () => {
  const { wiki } = makeWiki()
  // orphan-a 删不掉，orphan-b 正常删
  const fsMod = await import('node:fs')
  const origRm = fsMod.default.rmSync
  fsMod.default.rmSync = (p, opt) => {
    if (String(p).endsWith('orphan-a.md')) {
      const e = new Error('EBUSY: resource busy or locked')
      e.code = 'EBUSY'
      throw e
    }
    return origRm(p, opt)
  }
  let r
  try {
    r = pruneOrphanModules({
      kind: 'full', wikiPath: wiki,
      plan: { modules: [{ name: 'keep' }] },
      articles: [],
    })
  } finally {
    fsMod.default.rmSync = origRm
  }
  assert(fs.existsSync(path.join(wiki, 'modules', 'orphan-a.md')), '删不掉的必须还在')
  assert(!fs.existsSync(path.join(wiki, 'modules', 'orphan-b.md')), '能删的照删，不被失败拖住')
  assert.deepEqual(r.removed.sort(), ['orphan-b.md', 'written-failed.md'].sort(), 'removed 只报真删掉的')
  assert.equal(r.failed.length, 1, 'failed 必须恰好一条')
  assert(/orphan-a\.md/.test(r.failed[0]) && /EBUSY/.test(r.failed[0]), `failed 要带文件名与原因，实际 ${r.failed[0]}`)
})

// plan.modules 非空但残缺（目录里有规划外文章）时，当前实现会按它当全集删。
// 这条钉住「谁负责完整性」：清理器只认非空数组，完整性由编排侧保证。
// 若将来给 plan 加 completeness 标志，这条要跟着改——先把它写成显式契约断言。
await check('非空但残缺的 plan：按非空数组当全集（完整性由编排侧保证）', async () => {
  const { wiki } = makeWiki()
  const r = pruneOrphanModules({
    kind: 'full', wikiPath: wiki,
    plan: { modules: [{ name: 'keep' }] },
    articles: [],
  })
  // 当前契约：只要 modules 非空就当真，三条孤儿全删
  assert.deepEqual(r.removed.sort(), ['orphan-a.md', 'orphan-b.md', 'written-failed.md'].sort())
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
process.exit(fails.length ? 1 : 0)
