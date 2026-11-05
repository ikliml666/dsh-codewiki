// learnings / decisions 写入路径（lib/wiki-notes.js）的契约测试。
//
// 这个模块的风险不在于「拼字符串拼错」，而在于它产出的页能不能过落盘闸门：
// 少写 tags、source_files 写成目录、正文缺 `## Overview`、内部链接指向不存在的页——
// 每一种都会让 `codewiki_note` 在真机上直接失败，或者在库里留下一篇坏文章，
// 而下一轮编译的存量体检（apply-plan 的 auditExistingArticles）会把它算成
// existing-bad-article，把基线永久钉住。所以这里逐条压。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { NOTE_KINDS, noteSlug, buildNote, checkNote, listWikiPages } from './lib/wiki-notes.js'

let passed = 0
let failed = 0
function check(ok, label, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`) }
}

function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cw-notes-${tag}-`))
}

function mkRepo(tag) {
  const root = mkTmp(tag)
  fs.mkdirSync(path.join(root, '.codewiki', 'modules'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'lib.js'), 'export const b = 2\n')
  fs.writeFileSync(path.join(root, '.codewiki', 'modules', 'engine-core.md'), '# 引擎核心\n')
  return root
}

console.log('\n=== wiki-notes ===')

// --- slug ---
check(noteSlug('CW 二进制源码丢失') === 'cw-二进制源码丢失', 'slug 保留 CJK 与空格转连字符', noteSlug('CW 二进制源码丢失'))
check(noteSlug('Fix: path/separator bug!') === 'fix-path-separator-bug', 'slug 把标点与斜杠压成连字符', noteSlug('Fix: path/separator bug!'))
check(noteSlug('  --  -- ') === '', 'slug 全空时返回空串（由 buildNote 报错）', JSON.stringify(noteSlug('  --  -- ')))
check(NOTE_KINDS.learning === 'learnings' && NOTE_KINDS.decision === 'decisions', 'kind 到目录的映射与 cw 约定一致')

// --- buildNote ---
const built = buildNote({
  kind: 'learning',
  title: '基线死锁',
  sourceFiles: ['index.js', 'lib.js'],
  tags: ['baseline', 'bugfix'],
  body: '## Overview\n\n质量门不认快照，基线永不推进。\n',
})
check(built.rel === 'learnings/基线死锁.md', 'rel 落在 learnings/ 且用 title 转 slug', built.rel)
const fm = built.text.split('---')[1]
check(/^title: 基线死锁$/m.test(fm), 'frontmatter 写着 title')
check(/^type: learning$/m.test(fm), 'frontmatter 写着 type', fm)
check(/source_files:\n  - index\.js\n  - lib\.js/.test(fm), 'source_files 逐条列出')
check(/^tags: \[baseline, bugfix\]$/m.test(fm), 'tags 写成行内数组')

// 空 tags / 空 source_files 必须显式写出，否则契约判 missing-field
const bare = buildNote({ kind: 'decision', title: '选 A 不选 B', body: '## Overview\n\nA 更快。\n' })
check(/^source_files: \[\]$/m.test(bare.text), '无 source_files 时写成空数组而非省略', bare.text.split('---')[1])
check(/^tags: \[\]$/m.test(bare.text), '无 tags 时写成空数组而非省略')

// 明显非法输入
let threw = ''
try { buildNote({ kind: 'concept', title: 'x', body: '## Overview\n\ny\n' }) } catch (err) { threw = String(err.message) }
check(threw.includes('learning / decision'), 'kind 非法时报错并列出可选值', threw)
threw = ''
try { buildNote({ kind: 'learning', title: '', slug: '  ', body: 'x' }) } catch (err) { threw = String(err.message) }
check(threw.includes('无法确定文件名'), 'title 与 slug 都空时报错', threw)

// --- checkNote：必须过得了 article-contract ---
{
  const root = mkRepo('ok')
  const { rel, text } = built
  const blocking = checkNote({ text, rel, repoRoot: root, wikiDir: path.join(root, '.codewiki') })
  check(blocking.length === 0, '合规文章零 error', blocking.map((i) => i.kind).join(','))
}

// 缺 Overview 章节 —— warning 级的 missing-section 不拦，所以这里改用空 Overview：
// REQUIRED_SECTIONS.learning 是 ['Overview']，存在但为空属 empty-section（error）。
{
  const root = mkRepo('empty-overview')
  const { rel, text } = buildNote({ kind: 'learning', title: '空章节', body: '## Overview\n\n## Details\n\n正文在别的节。\n' })
  const blocking = checkNote({ text, rel, repoRoot: root, wikiDir: path.join(root, '.codewiki') })
  check(blocking.some((i) => i.kind === 'empty-section'), 'Overview 空着被判 empty-section', blocking.map((i) => i.kind).join(','))
}

// source_files 指向不存在的文件
{
  const root = mkRepo('bad-source')
  const { rel, text } = buildNote({
    kind: 'learning', title: '坏源', sourceFiles: ['index.js', 'nope.js'],
    body: '## Overview\n\n正文。\n',
  })
  const blocking = checkNote({ text, rel, repoRoot: root, wikiDir: path.join(root, '.codewiki') })
  check(blocking.some((i) => i.kind === 'missing-source'), 'source_files 含不存在文件被判 missing-source', blocking.map((i) => i.kind).join(','))
}

// 内部链接：指向已有页 → 通过；指向不存在的页 → dead-link
{
  const root = mkRepo('links')
  const wikiDir = path.join(root, '.codewiki')
  const good = buildNote({
    kind: 'decision', title: '链到模块页',
    body: '## Overview\n\n见 [[modules/engine-core|引擎核心]]。\n',
  })
  const goodBlocking = checkNote({ text: good.text, rel: good.rel, repoRoot: root, wikiDir })
  check(goodBlocking.length === 0, '指向已有模块页的内部链接通过', goodBlocking.map((i) => i.kind).join(','))

  const bad = buildNote({
    kind: 'decision', title: '链到不存在的页',
    body: '## Overview\n\n见 [[modules/no-such-page]]。\n',
  })
  const badBlocking = checkNote({ text: bad.text, rel: bad.rel, repoRoot: root, wikiDir })
  check(badBlocking.some((i) => i.kind === 'dead-link'), '指向不存在页的内部链接被判 dead-link', badBlocking.map((i) => i.kind).join(','))
}

// 目录与 type 必须匹配（pages 落在 learnings/ 却写 type: decision 会被 cw index 分错类）
{
  const root = mkRepo('type-mismatch')
  const text = buildNote({ kind: 'learning', title: '类型错位', body: '## Overview\n\n正文。\n' })
    .text.replace('type: learning', 'type: decision')
  const blocking = checkNote({ text, rel: 'learnings/类型错位.md', repoRoot: root, wikiDir: path.join(root, '.codewiki') })
  check(blocking.some((i) => i.kind === 'type-mismatch'), 'type 与目录不符被判 type-mismatch', blocking.map((i) => i.kind).join(','))
}

// listWikiPages 只列 .md，且带上目录前缀
{
  const root = mkRepo('list')
  fs.mkdirSync(path.join(root, '.codewiki', 'learnings'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codewiki', 'learnings', 'a.md'), '# a\n')
  fs.writeFileSync(path.join(root, '.codewiki', 'learnings', 'b.txt'), 'b\n')
  const pages = listWikiPages(path.join(root, '.codewiki'))
  check(pages.includes('modules/engine-core.md') && pages.includes('learnings/a.md'), 'listWikiPages 递归列出 .md', pages.join(','))
  check(!pages.includes('learnings/b.txt'), 'listWikiPages 不列非 .md')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
