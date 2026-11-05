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
import { dirname, join } from 'node:path'
import {
  OUTPUT_PROBLEM_KINDS,
  bodyLength,
  relativeLinks,
  collectOutput,
  buildWritePlan,
  validateOutput,
  overviewStaleLinks,
  pageAliases,
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
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
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

await check('relativeLinks：代码里的链接形态是示例，不算引用', async () => {
  // 真机 job-mw32wsci-h：文章讲「扫两种链接形态」时把 `[文字](x.md)` 写在行内代码里，
  // 被当成死链判了 partial。围栏和行内代码都要掩蔽。
  assert.deepEqual(relativeLinks('扫 `[文字](x.md)` 这种形态'), [])
  assert.deepEqual(relativeLinks('扫 `[[裸名]]` 这种形态'), [])
  assert.deepEqual(relativeLinks('```md\n[示例](gone.md)\n```\n真链接 [a](A.md)'), ['A.md'])
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

// 引擎把自己的命名约定用在页文件名上，正文里的链接却还按「模块名」写：
//   · 模块名带扩展名（src_session-checkout-module.ts）→ 页名 src_session-checkout-module.ts.md，
//     但兄弟页里写的是去掉扩展名的 src_session-checkout-module.md；
//   · 子模块页会被加上父模块前缀（client_review_console_review_surfaces.md），
//     父页里写的却是短名 review_surfaces.md。
// 这两类不是死链，是同一页的两种写法。真机 dsh-git-worktree 19 条死链全属此类。
await check('validateOutput：同目录 X.md 指向唯一 X.<ext>.md 不算死链（引擎页名带扩展名）', async () => {
  // 树里模块名是 mod.ts，引擎据此把页命名成 mod.ts.md；兄弟页的正文写 mod.md。
  const dir = makeDocs('alias-ext', {
    'Core.md': '# Core\n\n见 [mod](mod.md)。\n',
    'mod.ts.md': '# mod\n\n模块页。\n',
    'module_tree.json': JSON.stringify({
      Core: { path: 'src/core', components: ['src/core/engine.py::Engine'], children: {} },
      Web: { path: 'src/web', components: ['src/web/handler.py::Handler'], children: {} },
      'mod.ts': { path: 'src/mod.ts', components: [], children: {} },
    }),
  })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.problems.some((p) => p.kind === 'dead-link'), false, JSON.stringify(v.problems))
})

await check('validateOutput：同目录 sub/Y.md 指向唯一 sub/sub_Y.md 不算死链（子模块页带父前缀）', async () => {
  // 子模块页被引擎命名成 sub_sub_surfaces.md，父页正文写的是子模块的短名。
  const dir = makeDocs('alias-prefix', {
    'Core.md': '# Core\n\n见 [surfaces](sub/surfaces.md)。\n',
    'sub.md': '# sub\n\n见 [surfaces](sub/sub_surfaces.md)。\n',
    'sub/sub_surfaces.md': '# surfaces\n\n子模块页。\n',
    'module_tree.json': JSON.stringify({
      Core: { path: 'src/core', components: ['src/core/engine.py::Engine'], children: {} },
      Web: { path: 'src/web', components: ['src/web/handler.py::Handler'], children: {} },
      sub: {
        path: 'src/sub',
        components: [],
        children: { sub_surfaces: { path: 'src/sub/surfaces.ts', components: [], children: {} } },
      },
    }),
  })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.equal(v.problems.some((p) => p.kind === 'dead-link'), false, JSON.stringify(v.problems))
})

// 别名只在**唯一**命中时成立：同目录同时有 X.ts.md 与 X.js.md 时无法判定指的是哪一篇，
// 猜一个就是把「链接断了」静默变成「链接指向另一篇」，比报死链更糟。
await check('validateOutput：候选不唯一时仍判死链（不猜）', async () => {
  const dir = makeDocs('alias-ambiguous', {
    'Core.md': '# Core\n\n见 [mod](mod.md)。\n',
    'mod.ts.md': '# mod ts\n\nts 模块页。\n',
    'mod.js.md': '# mod js\n\njs 模块页。\n',
  })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.ok(v.problems.some((p) => p.kind === 'dead-link'), JSON.stringify(v.problems))
})

// 别名不能吃成「模糊匹配」：目标只是与某页名字相近，仍是死链（真机 overview.md
// 写 build_and_configuration.md，而树里根本没有这个模块）。
await check('validateOutput：只是名字相近（非命名约定）仍判死链', async () => {
  const dir = makeDocs('alias-fuzzy', {
    'Core.md': '# Core\n\n见 [x](client_interface_layer.md)。\n',
    'worktree_client_interface_layer.md': '# layer\n\n客户端层。\n',
  })
  const v = validateOutput({ docsDir: dir, repoRoot })
  assert.ok(v.problems.some((p) => p.kind === 'dead-link'), JSON.stringify(v.problems))
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


// ===== 缺页/旧页判定：修复性全量的依据（native-run 决议用）=====
//
// 判据必须与上游 doc_layout.module_doc_relpath() 同一口径：hierarchical 布局的页
// 落在 <父模块路径>/<模块名>.md，flat 布局落在根部。真机 dsh-git-worktree 就栽在
// 「只按名字比」——workspace_provider_lifecycle 从 worktree_lifecycle_management_core/
// 搬到了 …/session_checkout_runtime/ 下，旧路径还留着同名页，按名字比就认为「页在」，
// 结果真实缺页被漏掉，每轮都判 partial。
const layoutMod = await import('./lib/engine/mapping.js')
const { findMissingModuleDocs, staleDocPages, moduleDocRelPath } = layoutMod

await check('moduleDocRelPath：层级布局取父路径作目录，flat 布局落在根部', async () => {
  assert.equal(moduleDocRelPath(['a', 'b', 'c']), 'a/b/c.md')
  assert.equal(moduleDocRelPath(['a', 'b', 'c'], 'flat'), 'c.md')
  assert.equal(moduleDocRelPath([]), 'overview.md')
})

await check('findMissingModuleDocs：按层级路径判定，缺的模块被点名', async () => {
  const moduleTree = {
    core: { path: 'src/core', components: ['a'], children: {} },
    api: { path: 'src/api', components: ['b'], children: {
      v2: { path: 'src/api/v2', components: ['c'], children: {} },
    } },
  }
  // 层级布局：core 在根部、api.v2 在 api/ 下；父模块 api 自己也要有 api.md
  const pages = ['overview.md', 'core.md', 'api.md', 'api/v2.md']
  assert.deepEqual(findMissingModuleDocs({ pages, moduleTree }), [])
  // api 父模块的页缺了（api/v2.md 不能顶替 api.md）
  assert.deepEqual(findMissingModuleDocs({ pages: ['overview.md', 'core.md'], moduleTree }), ['api', 'v2'])
  // 空树：没有权威模块名，不点任何页
  assert.deepEqual(findMissingModuleDocs({ pages: [], moduleTree: {} }), [])
})

await check('findMissingModuleDocs：模块搬家后旧路径的同名页不算已存在（真机场景）', async () => {
  // 新树把该模块挂到了更深一层，而 docs 里只有旧位置的同名页。
  const moduleTree = {
    core: { path: 'src', components: ['a'], children: {
      runtime: { path: 'src/runtime', components: ['b'], children: {
        workspace_provider_lifecycle: { path: 'src/runtime/wpl', components: ['c'], children: {} },
      } },
    } },
  }
  // 旧页在 core/workspace_provider_lifecycle.md，新位置是 core/runtime/workspace_provider_lifecycle.md
  const pages = ['overview.md', 'core.md', 'core/runtime.md', 'core/workspace_provider_lifecycle.md']
  assert.deepEqual(findMissingModuleDocs({ pages, moduleTree }), ['workspace_provider_lifecycle'])
  // 但落到新位置后就齐了
  const fixed = [...pages, 'core/runtime/workspace_provider_lifecycle.md']
  assert.deepEqual(findMissingModuleDocs({ pages: fixed, moduleTree }), [])
})

await check('staleDocPages：不属于当前模块树的旧页被点名清退，overview 与非 md 不受影响', async () => {
  const moduleTree = { core: { path: 'src', components: ['a'], children: {
    runtime: { path: 'src/runtime', components: ['b'], children: {} },
  } } }
  const pages = ['overview.md', 'core.md', 'core/runtime.md', 'modules/renamed-old.md', 'module_tree.json']
  assert.deepEqual(staleDocPages({ pages, moduleTree }), ['modules/renamed-old.md'])
  // 旧路径同名页属于陈页：它指向的位置已经不是该模块的落地位置
  const moved = ['overview.md', 'core.md', 'core/runtime.md', 'core/workspace_provider_lifecycle.md']
  assert.deepEqual(staleDocPages({ pages: moved, moduleTree }), ['core/workspace_provider_lifecycle.md'])
  // 空树：whole-repository 模式没有权威模块名，不能凭名字删页
  assert.deepEqual(staleDocPages({ pages, moduleTree: {} }), [])
})
// 落地页名是模块名的 kebab-case（mapping.js 的 moduleSlug），正文里却常写下划线原名：
// 认不出这条别名，存量页的每一处跨页链接都会一直是死链。
await check('pageAliases：下划线页名 → 连字符落地页名，唯一命中才给别名', async () => {
  const aliases = pageAliases(['overview.md', 'Core/llama_and_llm_management.md', 'Core/web_api.md'])
  assert.equal(aliases.get('Core/llama-and-llm-management.md'), 'Core/llama_and_llm_management.md')
  assert.equal(aliases.get('Core/web-api.md'), 'Core/web_api.md')
  // 本来就叫这个名字的页不产生别名（real 优先），也不跨目录猜
  assert.equal(aliases.has('overview.md'), false)
  assert.equal(aliases.has('llama-and-llm-management.md'), false)
  // 两个同名模块的 slug 撞到一起时判不出指向哪一篇，宁可不给别名
  const ambiguous = pageAliases(['a/x_y.md', 'b/x_y.md'])
  assert.equal(ambiguous.has('a/x-y.md'), true)
  assert.equal(ambiguous.has('x-y.md'), false)
})

// overview 的链接集合必须与当前模块树对齐：上游 reusable_overview 只判「空页/preamble」，
// 聚类改名后 overview 里的旧模块链接会一直留着，永远点不开。
await check('overviewStaleLinks：指向已消失页面的链接被点名，命中页与别名不算', async () => {
  const moduleTree = { core: { path: 'src', components: ['a'], children: {} } }
  const pages = ['overview.md', 'core.md', 'mod.ts.md']
  const text = [
    '# 概览',
    '',
    '- [core](core.md)',
    '- [带扩展名的页](mod.md)',
    '- [已消失](gone-module.md)',
    '- [外部](https://example.com/x.md)',
    '- [源码](../src/core.ts)',
  ].join('\n')
  assert.deepEqual(overviewStaleLinks({ overviewText: text, pages, moduleTree }), ['gone-module.md'])
  // 空树：whole-repository 模式没有权威模块名，不能凭猜测判陈
  assert.deepEqual(overviewStaleLinks({ overviewText: text, pages, moduleTree: {} }), [])
  // 没有 overview 正文时什么都不报
  assert.deepEqual(overviewStaleLinks({ overviewText: '', pages, moduleTree }), [])
})

rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
