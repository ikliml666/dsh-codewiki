// 阶段 2：用**真实 FSoft 产物**钉住两个真实缺陷。
//
// 这两个缺陷都是单测造的数据永远抓不到的，只有拿引擎真跑出来的 docs 树才暴露：
//
//   1. hierarchical 布局的页在**子目录**里（doc_layout.py:module_doc_relpath 返回
//      posixpath.join(*module_path[:-1], f"{module_path[-1]}.md")），只读 docs 根会
//      把整棵子树的页全漏掉 —— 漏页等于 wiki 少几篇且没人知道。
//
//   2. whole-repository 模式下 module_tree.json 是 `{}`（documentation_generator.py:241
//      原文 "stays {} in whole-repository mode"），但 agent 仍然写了自己的页。
//      这时「页名在模块树里找不到」不等于孤儿页 —— 静默全判 unmapped 会丢掉真页，
//      而硬给 source_files 又是臆造。正确做法：页进写集、source_files 空、带
//      attribution=unattributed 与可机读 problem，让上层判 partial。
//
// 真实产物取自 .probe-fsoft/wiki_out_1c/docs（1C 全量编译的真输出）。测试只读它，
// 复制到临时目录后再施加变形，绝不改动原产物。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateOutput, collectOutput, OUTPUT_PROBLEM_KINDS } from './lib/engine/output.js'
import { mapFsoftOutput } from './lib/engine/mapping.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const REAL = 'E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs'
if (!existsSync(REAL)) {
  console.log(`SKIP  真实产物不存在：${REAL}（阶段 1C 未跑过则跳过本套）`)
  process.exit(0)
}
const REAL_REPO = 'E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c'

const root = mkdtempSync(join(tmpdir(), 'fsoft-real-'))
const copyDocs = (name) => {
  const dir = join(root, name)
  cpSync(REAL, dir, { recursive: true })
  return dir
}

await check('真实产物：collectOutput 读到 overview + 两个模块页，module_tree 为空对象', async () => {
  const dir = copyDocs('as-is')
  const c = collectOutput({ docsDir: dir })
  assert.equal(c.exists, true)
  assert.deepEqual(c.pages, ['overview.md', 'wiki_out_1c_core_engine.md', 'wiki_out_1c_web_layer.md'])
  assert.deepEqual(c.json.moduleTree, {}, 'whole-repository 模式下 module_tree 就是 {}')
  assert.equal(c.json.metadata.generation_info.layout, 'hierarchical')
  assert.equal(c.json.metadata.generation_info.commit_id.length, 40)
  assert.equal(c.problems.length, 0, JSON.stringify(c.problems))
})

await check('真实产物：module_tree={} 而模块页存在 → 页仍进写集，source_files 为空（不丢、不臆造）', async () => {
  const dir = copyDocs('unattributed')
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  // 关键：两篇真页必须在写集里，不能因为模块树为空就被判 unmapped 丢掉
  const wikiPaths = v.mapped.articles.map((a) => a.wikiPath).sort()
  assert.deepEqual(wikiPaths, [
    '.codewiki/modules/wiki-out-1c-core-engine.md',
    '.codewiki/modules/wiki-out-1c-web-layer.md',
  ])
  // 关键：source_files 必须是空的（没有证据就不写），绝不按目录名猜
  for (const a of v.mapped.articles) {
    assert.deepEqual(a.sourceFiles, [], `${a.moduleName} 不该臆造 source_files`)
    assert.equal(a.attribution, 'unattributed')
    assert.ok(a.warnings.some((w) => /归属/.test(w)), JSON.stringify(a.warnings))
  }
  // unmapped 不该包含这两篇
  assert.deepEqual(v.mapped.unmapped, [])
})

await check('真实产物：空模块树本身要报可机读 problem（归属证据缺失，不是静默容忍）', async () => {
  const dir = copyDocs('empty-tree')
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  assert.ok(OUTPUT_PROBLEM_KINDS.includes('empty-module-tree'))
  const p = v.problems.find((x) => x.kind === 'empty-module-tree')
  assert.ok(p, JSON.stringify(v.problems.map((x) => x.kind)))
  // ok=false：归属不确定就不能宣称完整成功，让上层判 partial
  assert.equal(v.ok, false)
})

await check('真实产物：模块树非空但某页无对应模块 → 仍是 unmapped（孤儿页，不冒充有归属）', async () => {
  const dir = copyDocs('orphan')
  writeFileSync(join(dir, 'module_tree.json'), JSON.stringify({
    wiki_out_1c_core_engine: { path: 'src/core', components: [], children: {} },
  }), 'utf8')
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  const un = v.mapped.unmapped.map((u) => u.source)
  assert.deepEqual(un, ['wiki_out_1c_web_layer.md'], '模块树非空时，没归到模块的页必须进 unmapped')
  assert.deepEqual(v.mapped.articles.map((a) => a.moduleName), ['wiki_out_1c_core_engine'])
})

await check('真实产物：嵌套子目录的页必须被收集（hierarchical 布局）', async () => {
  const dir = copyDocs('nested')
  mkdirSync(join(dir, 'core'), { recursive: true })
  writeFileSync(join(dir, 'core', 'engine.md'), '# Engine\n\n引擎子模块的正文。\n', 'utf8')
  writeFileSync(join(dir, 'module_tree.json'), JSON.stringify({
    Core: {
      path: 'src/core',
      components: ['src\\core\\engine.py::Engine'],
      children: { engine: { path: 'src/core/engine.py', components: [], children: {} } },
    },
  }), 'utf8')
  const c = collectOutput({ docsDir: dir })
  assert.ok(c.pages.includes('core/engine.md'), `嵌套页漏收集：${JSON.stringify(c.pages)}`)
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  const nested = v.mapped.articles.find((a) => a.moduleName === 'engine')
  assert.ok(nested, '嵌套页应被映射成文章')
  assert.equal(nested.wikiPath, '.codewiki/modules/engine.md')
})

await check('真实产物：temp/ 里的 md 不算页（那是工作文件，不是文章）', async () => {
  const dir = copyDocs('temp-md')
  writeFileSync(join(dir, 'temp', 'scratch.md'), '# 草稿\n\n这是索引工作文件。\n', 'utf8')
  const c = collectOutput({ docsDir: dir })
  assert.equal(c.pages.includes('temp/scratch.md'), false)
  assert.equal(c.pages.some((p) => p.startsWith('temp/')), false)
})

await check('真实产物：update_record 被原样读出，pages_written/pages_removed 可机读', async () => {
  const dir = copyDocs('record')
  const c = collectOutput({ docsDir: dir })
  assert.equal(c.json.updateRecord.outcome, 'incremental')
  assert.equal(c.json.updateRecord.revision.new_commit.length, 40)
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  assert.equal(v.mapped.updateRecord.outcome, 'incremental')
  assert.equal(v.mapped.updateRecord.source, 'incremental')
})

await check('真实产物：metadata 的 commit 进 meta.lastCompiledCommit（增量基线来源）', async () => {
  const dir = copyDocs('meta')
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  assert.equal(v.mapped.meta.lastCompiledCommit.length, 40)
  assert.equal(v.mapped.meta.layout, 'hierarchical')
})

await check('真实产物：正文里的真实页间链接不误判为死链', async () => {
  const dir = copyDocs('links')
  const v = validateOutput({ docsDir: dir, repoRoot: REAL_REPO })
  assert.equal(v.problems.some((p) => p.kind === 'dead-link'), false,
    JSON.stringify(v.problems.filter((p) => p.kind === 'dead-link')))
})

await check('真实产物：componentFiles 有证据时，unattributed 页仍不臆造（证据缺失就空）', async () => {
  const dir = copyDocs('evidence')
  const v = validateOutput({
    docsDir: dir,
    repoRoot: REAL_REPO,
    componentFiles: { 'src\\core\\engine.py::Engine': 'src/core/engine.py' },
  })
  // 模块树为空 → 没有 components 列表 → 即便给了证据也用不上（不猜哪个页拥有它）
  for (const a of v.mapped.articles) assert.deepEqual(a.sourceFiles, [])
})

await check('mapping 纯函数：空模块树 + 页 → unattributed，非空模块树 + 无此页 → unmapped', async () => {
  const empty = mapFsoftOutput({
    pages: ['overview.md', 'A.md'],
    moduleTree: {},
    metadata: { generation_info: { commit_id: 'x', layout: 'hierarchical' } },
  })
  assert.equal(empty.articles.length, 1)
  assert.equal(empty.articles[0].attribution, 'unattributed')
  assert.deepEqual(empty.unmapped, [])

  const nonEmpty = mapFsoftOutput({
    pages: ['overview.md', 'A.md', 'B.md'],
    moduleTree: { A: { path: 'a', components: [], children: {} } },
    metadata: { generation_info: { commit_id: 'x', layout: 'hierarchical' } },
  })
  assert.deepEqual(nonEmpty.articles.map((a) => a.moduleName), ['A'])
  assert.equal(nonEmpty.articles[0].attribution, 'attributed')
  assert.deepEqual(nonEmpty.unmapped.map((u) => u.source), ['B.md'])
})

rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
