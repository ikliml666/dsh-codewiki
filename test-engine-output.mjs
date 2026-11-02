// 阶段 2：FSoft 产物解析/校验的测试（output.js）。
//
// 这一层判的是「引擎交回来的东西能不能用」。它错了的后果很具体：
// 缺页被吞 → wiki 少一篇没人知道；空壳页被放行 → 文章只有标题；
// source_files 编造 → 增量 ownership 静默错位，未消化的变化被基线化。
// 所以每条断言都指向一个真实可发生的故障，而不是形状好看。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OUTPUT_PROBLEM_KINDS,
  bodyLength,
  relativeLinks,
  collectOutput,
  buildWritePlan,
  validateOutput,
} from './lib/engine/output.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const root = mkdtempSync(join(tmpdir(), 'fsoft-output-'))

// 造一个「正常」的 FSoft docs 树：入口 + 两个模块页 + 四个 JSON
function makeDocs(name, overrides = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const files = {
    'overview.md': '# Demo\n\n这是一个演示项目的概览，说明整体结构与用途。\n\n见 [core](Core.md)。\n',
    'Core.md': '# Core\n\n核心引擎负责构建依赖图并调度各阶段。\n\n见 [web](Web.md)。\n',
    'Web.md': '# Web\n\nWeb 层把请求转成任务并回传进度。\n',
    'metadata.json': JSON.stringify({
      generation_info: { commit_id: 'abc123', layout: 'hierarchical', language: null },
      statistics: { total_components: 3, leaf_nodes: 2 },
      files_generated: ['overview.md', 'Core.md', 'Web.md'],
    }),
    'module_tree.json': JSON.stringify({
      Core: { path: 'src/core', components: ['src/core/engine.py::Engine'], children: {} },
      Web: { path: 'src/web', components: ['src/web/handler.py::Handler'], children: {} },
    }),
    'first_module_tree.json': '{}',
    'update_record.json': JSON.stringify({ outcome: 'incremental', pages_written: ['Core.md'], pages_removed: [] }),
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue
    writeFileSync(join(dir, rel), body, 'utf8')
  }
  return dir
}

// 造一个仓库，让 source_files 能对上
const repoRoot = join(root, 'repo')
mkdirSync(join(repoRoot, 'src/core'), { recursive: true })
mkdirSync(join(repoRoot, 'src/web'), { recursive: true })
writeFileSync(join(repoRoot, 'src/core/engine.py'), 'class Engine:\n    pass\n', 'utf8')
writeFileSync(join(repoRoot, 'src/web/handler.py'), 'class Handler:\n    pass\n', 'utf8')

await check('bodyLength：只有标题算空壳，带正文算非空', async () => {
  assert.equal(bodyLength('# Title\n\n'), 0)
  assert.equal(bodyLength('# Title\n'), 0)
  assert.equal(bodyLength('# Title\n\n一句话正文。\n'), 6)
  assert.equal(bodyLength('没有标题但有正文'), 8)
})

await check('relativeLinks：抽相对链接，跳过外链/锚点/图片 data URI', async () => {
  const links = relativeLinks(
    '见 [a](A.md) 与 [b](../src/x.py) 还有 [c](https://x.test/y) [d](#anchor) ![i](data:image/png;base64,xx)',
  )
  assert.deepEqual(links, ['A.md', '../src/x.py'])
})

await check('collectOutput：正常 docs 树被完整读出，无 problems', async () => {
  const dir = makeDocs('ok')
  const c = collectOutput({ docsDir: dir })
  assert.equal(c.exists, true)
  assert.deepEqual(c.pages, ['Core.md', 'Web.md', 'overview.md'])
  assert.equal(c.json.metadata.generation_info.commit_id, 'abc123')
  assert.equal(Object.keys(c.json.moduleTree).length, 2)
  assert.equal(c.problems.length, 0, JSON.stringify(c.problems))
})

await check('collectOutput：docs 目录不存在 → missing-docs-dir，不抛', async () => {
  const c = collectOutput({ docsDir: join(root, 'no-such-dir') })
  assert.equal(c.exists, false)
  assert.ok(c.problems.some((p) => p.kind === 'missing-docs-dir'))
})

await check('collectOutput：metadata.json 缺失 → missing-metadata', async () => {
  const dir = makeDocs('no-meta', { 'metadata.json': null })
  const c = collectOutput({ docsDir: dir })
  assert.ok(c.problems.some((p) => p.kind === 'missing-metadata'))
})

await check('collectOutput：metadata.json 坏掉 → bad-json（存在但坏了必须报）', async () => {
  const dir = makeDocs('bad-meta', { 'metadata.json': '{ not json' })
  const c = collectOutput({ docsDir: dir })
  assert.ok(c.problems.some((p) => p.kind === 'bad-json'))
  assert.equal(c.json.metadata, null)
})

await check('collectOutput：update_record 缺失不算问题（全量首轮本来没有）', async () => {
  const dir = makeDocs('no-record', { 'update_record.json': null })
  const c = collectOutput({ docsDir: dir })
  assert.equal(c.problems.length, 0, JSON.stringify(c.problems))
  assert.equal(c.json.updateRecord, null)
})

await check('collectOutput：update_record 存在但坏掉 → 仍要报 bad-json', async () => {
  const dir = makeDocs('bad-record', { 'update_record.json': 'nope' })
  const c = collectOutput({ docsDir: dir })
  assert.ok(c.problems.some((p) => p.kind === 'bad-json'))
})

await check('validateOutput：正常产物 ok=true，写集包含入口与两篇模块页', async () => {
  const dir = makeDocs('ok2')
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, true, JSON.stringify(v.problems))
  assert.equal(v.mapped.entry.path, 'CodeWiki.md')
  assert.deepEqual(v.mapped.articles.map((a) => a.wikiPath).sort(), [
    '.codewiki/modules/core.md',
    '.codewiki/modules/web.md',
  ])
  assert.equal(v.stats.pages, 3)
  assert.equal(v.stats.articles, 2)
})

await check('validateOutput：缺 overview → entry-missing（没有入口等于不能用）', async () => {
  const dir = makeDocs('no-overview', { 'overview.md': null })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.kind === 'entry-missing'))
})

await check('validateOutput：空壳页 → empty-body，带 source', async () => {
  const dir = makeDocs('shell', { 'Web.md': '# Web\n\n' })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, false)
  const p = v.problems.find((x) => x.kind === 'empty-body')
  assert.ok(p, JSON.stringify(v.problems))
  assert.equal(p.source, 'Web.md')
})

await check('validateOutput：模块树有模块但没产页 → article-missing', async () => {
  const dir = makeDocs('missing-page', { 'Web.md': null })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.kind === 'article-missing'), JSON.stringify(v.problems))
})

await check('validateOutput：页不在模块树 → unmapped-page（不静默丢弃）', async () => {
  const dir = makeDocs('unmapped', { 'Orphan.md': '# Orphan\n\n这一页没有归属。\n' })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, false)
  const p = v.problems.find((x) => x.kind === 'unmapped-page')
  assert.ok(p, JSON.stringify(v.problems))
  assert.equal(p.source, 'Orphan.md')
})

await check('validateOutput：source_files 指向不存在的文件 → source-missing', async () => {
  const dir = makeDocs('bad-source', {
    'module_tree.json': JSON.stringify({
      Core: { path: 'src/core', components: ['src/core/nope.py::Ghost'], children: {} },
      Web: { path: 'src/web', components: ['src/web/handler.py::Handler'], children: {} },
    }),
  })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, false)
  const p = v.problems.find((x) => x.kind === 'source-missing')
  assert.ok(p, JSON.stringify(v.problems))
  assert.equal(p.target, 'src/core/nope.py')
})

await check('validateOutput：不给 repoRoot 时跳过 source_files 存在性检查（阶段 2 可选）', async () => {
  const dir = makeDocs('bad-source2', {
    'module_tree.json': JSON.stringify({
      Core: { path: 'src/core', components: ['src/core/nope.py::Ghost'], children: {} },
      Web: { path: 'src/web', components: ['src/web/handler.py::Handler'], children: {} },
    }),
  })
  const v = validateOutput({ docsDir: dir })
  assert.equal(v.problems.some((p) => p.kind === 'source-missing'), false)
})

await check('validateOutput：链接指向计划外的 md → dead-link', async () => {
  const dir = makeDocs('deadlink', { 'Core.md': '# Core\n\n见 [gone](Gone.md)。\n' })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.ok, false)
  const p = v.problems.find((x) => x.kind === 'dead-link')
  assert.ok(p, JSON.stringify(v.problems))
  assert.equal(p.target, 'Gone.md')
})

// 真机 partial（job-mvzbcw87-0）暴露的误报：testing_fixtures.md 里写
// [Testing___Probing_Tooling](./README.md)，被当成「该页不在本次产出里」。上游把根页
// 叫 README.md，而本仓库的 wiki 入口是 CodeWiki.md —— 同一个页的两个名字，不是死链。
await check('validateOutput：指向根页的 README.md 链接不算死链（本 wiki 入口是 CodeWiki.md）', async () => {
  const dir = makeDocs('rootlink', { 'CodeWiki.md': '# 入口\n\n根页。\n', 'Core.md': '# Core\n\n见 [入口](./README.md)。\n' })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.problems.some((p) => p.kind === 'dead-link'), false, JSON.stringify(v.problems))
})

// 但指向不存在的子目录 README 仍是死链：别名只豁免根页这一种写法
await check('validateOutput：sub/README.md 这类非根页链接仍判死链', async () => {
  const dir = makeDocs('sublink', { 'Core.md': '# Core\n\n见 [x](sub/README.md)。\n' })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.ok(v.problems.some((p) => p.kind === 'dead-link'), JSON.stringify(v.problems))
})
await check('validateOutput：链接到仓库源文件（../src/...）不算死链', async () => {
  const dir = makeDocs('srclink', { 'Core.md': '# Core\n\n见 [engine](../src/core/engine.py)。\n' })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.problems.some((p) => p.kind === 'dead-link'), false, JSON.stringify(v.problems))
})

await check('validateOutput：同一输入两次调用结果稳定（无隐藏状态）', async () => {
  const dir = makeDocs('stable')
  const a = validateOutput({ docsDir: dir, repoRoot })
  const b = validateOutput({ docsDir: dir, repoRoot })
  assert.deepEqual(a.problems, b.problems)
  assert.deepEqual(a.stats, b.stats)
})

await check('validateOutput：未登记的 problem kind 会被拒（防止自由发挥）', async () => {
  assert.ok(OUTPUT_PROBLEM_KINDS.includes('dead-link'))
  assert.ok(OUTPUT_PROBLEM_KINDS.includes('source-missing'))
})

await check('buildWritePlan：componentFiles 作为 source_files 证据被采用', async () => {
  const dir = makeDocs('evid')
  const { mapped } = buildWritePlan({
    docsDir: dir,
    componentFiles: { 'src/core/engine.py::Engine': 'src/core/engine.py' },
  })
  const core = mapped.articles.find((a) => a.moduleName === 'Core')
  assert.deepEqual(core.sourceFiles, ['src/core/engine.py'])
})

rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
