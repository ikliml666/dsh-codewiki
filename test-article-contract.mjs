// 文章契约测试（P0-4）：坏文章不能入库。
//
// 旧闸门只查「frontmatter 有没有开合」，所以下面这些都进了仓库：
//   .codewiki/concepts/wiki-generation-flow.md 从第 64 行起又贴了一份 frontmatter 与正文；
//   .codewiki/modules/client-interface.md 从第 227 行起重复整篇；
//   .codewiki/learnings/update-reminder-entry-gap.md frontmatter 根本没闭合；
//   多篇 source_files 指向早已不存在的 .tmp-test-*.log / .probe3.txt。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inspectArticle, parseFrontmatter, parseYamlLite, extractSections, fencesBalanced,
  collectWikiLinks, hasDuplicateFrontmatter, issueSummary, REQUIRED_SECTIONS, TYPE_BY_DIR,
  hasBlockingIssue, makeWriteSet, isWritable, normalizeWritePath, SEVERITY,
} from './lib/article-contract.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const GOOD = (over = {}) => {
  const fm = {
    title: 'Util Module', type: 'module',
    source_files: ['src/util/strings.js'], tags: ['util'],
    ...over,
  }
  const src = Array.isArray(fm.source_files) ? fm.source_files.map((s) => `  - ${s}`).join('\n') : ''
  return `---\ntitle: ${fm.title}\ntype: ${fm.type}\nsource_files:\n${src}\ntags: [util]\n---\n\n# ${fm.title}\n\n## Overview\n\n这是 util 模块的说明。\n\n## Key Components\n\n- slugify：把字符串转成 slug。\n`
}
const kinds = (issues) => issues.map((i) => i.kind)

await check('合格文章：无 issue', async () => {
  const issues = inspectArticle(GOOD(), { articlePath: 'modules/util.md' })
  assert.deepEqual(issues, [], JSON.stringify(issues))
  assert.equal(issueSummary(issues), null)
})

await check('缺 frontmatter → frontmatter-missing', async () => {
  const issues = inspectArticle('## Overview\n\n正文。\n', { articlePath: 'modules/x.md' })
  assert.ok(kinds(issues).includes('frontmatter-missing'))
})

await check('frontmatter 未闭合 → frontmatter-unclosed（真实仓库里就有这种文件）', async () => {
  const text = '---\ntitle: t\ntype: learning\nsource_files:\n  - index.js\ntags: [a]\n\n## Overview\n\n正文。\n'
  const issues = inspectArticle(text, { articlePath: 'learnings/x.md' })
  assert.ok(kinds(issues).includes('frontmatter-unclosed'), JSON.stringify(kinds(issues)))
})

await check('必填字段缺失（title/type/source_files）→ missing-field', async () => {
  const noSrc = GOOD().replace(/source_files:\n  - src\/util\/strings\.js\n/, '')
  assert.ok(kinds(inspectArticle(noSrc, { articlePath: 'modules/x.md' })).includes('missing-field'))
  const noType = GOOD().replace('type: module\n', '')
  assert.ok(kinds(inspectArticle(noType, { articlePath: 'modules/x.md' })).includes('missing-field'))
})

await check('type 与目录不匹配 → type-mismatch', async () => {
  const issues = inspectArticle(GOOD(), { articlePath: 'concepts/util.md' })
  assert.ok(kinds(issues).includes('type-mismatch'), JSON.stringify(kinds(issues)))
})

await check('正文里又出现一份 frontmatter → duplicate-frontmatter（真实缺陷）', async () => {
  const doubled = `${GOOD()}\n---\ntitle: Util Module\ntype: module\nsource_files:\n  - src/util/strings.js\n---\n\n## Overview\n\n第二份正文。\n`
  const issues = inspectArticle(doubled, { articlePath: 'modules/util.md' })
  assert.ok(kinds(issues).includes('duplicate-frontmatter'), JSON.stringify(kinds(issues)))
  assert.ok(kinds(issues).includes('duplicate-section'), '重复正文应同时报重复章节')
})

await check('重复章节 → duplicate-section', async () => {
  const text = GOOD().replace('## Key Components\n\n- slugify：把字符串转成 slug。', '## Overview\n\n又一份概览。\n\n## Key Components\n\n- slugify')
  assert.ok(kinds(inspectArticle(text, { articlePath: 'modules/util.md' })).includes('duplicate-section'))
})

await check('必需章节缺失 → missing-section', async () => {
  const text = GOOD().replace(/## Key Components\n\n- slugify：把字符串转成 slug。\n/, '')
  assert.ok(kinds(inspectArticle(text, { articlePath: 'modules/util.md' })).includes('missing-section'))
})

await check('必需章节是空的 → empty-section', async () => {
  const text = GOOD().replace('## Key Components\n\n- slugify：把字符串转成 slug。', '## Key Components\n\n')
  const issues = inspectArticle(text, { articlePath: 'modules/util.md' })
  assert.ok(kinds(issues).includes('empty-section'), JSON.stringify(kinds(issues)))
})

await check('非必需章节空着也报，但只算 warning（真实仓库大量空章节，不该拒写）', async () => {
  const text = `${GOOD()}\n## Architecture\n\n## Data Flow\n\n`
  const issues = inspectArticle(text, { articlePath: 'modules/util.md' })
  const empties = issues.filter((i) => i.kind === 'empty-section-optional')
  assert.ok(empties.length >= 2, JSON.stringify(kinds(issues)))
  assert.ok(empties.every((i) => i.severity === 'warning'), '非必需空章节必须放行')
  // 必需章节空着才是 error 级拒写
  assert.ok(!hasBlockingIssue(issues), JSON.stringify(issues.filter((i) => i.severity === 'error')))
})

await check('代码围栏未闭合 → unclosed-fence', async () => {
  const text = `${GOOD()}\n## 示例\n\n\`\`\`js\nconst a = 1\n`
  assert.ok(kinds(inspectArticle(text, { articlePath: 'modules/util.md' })).includes('unclosed-fence'))
})

await check('source_files 指向目录/绝对路径/越界 → bad-source', async () => {
  for (const bad of ['src/util/', '/etc/passwd', '../outside.js', 'C:/x/y.js']) {
    const issues = inspectArticle(GOOD({ source_files: [bad] }), { articlePath: 'modules/util.md' })
    assert.ok(kinds(issues).includes('bad-source'), `${bad} 应判 bad-source，实际 ${JSON.stringify(kinds(issues))}`)
  }
})

await check('source_files 指向不存在的文件 → missing-source（真实缺陷：.tmp-test-*.log）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwac-'))
  fs.mkdirSync(path.join(dir, 'src', 'util'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/util/strings.js'), 'x\n')
  const fsImpl = { exists: (p) => fs.existsSync(p) }
  const okIssues = inspectArticle(GOOD(), { cwd: dir, articlePath: 'modules/util.md', fsImpl })
  assert.deepEqual(okIssues, [], JSON.stringify(okIssues))
  const bad = inspectArticle(GOOD({ source_files: ['src/util/strings.js', '.tmp-test-batch.log'] }), { cwd: dir, articlePath: 'modules/util.md', fsImpl })
  assert.ok(kinds(bad).includes('missing-source'), JSON.stringify(kinds(bad)))
})

await check('source_files 不在本次读取的证据里 → source-not-evidence', async () => {
  const issues = inspectArticle(GOOD({ source_files: ['src/util/strings.js', 'src/never-read.js'] }), {
    articlePath: 'modules/util.md', readableSources: ['src/util/strings.js'],
  })
  assert.ok(kinds(issues).includes('source-not-evidence'), JSON.stringify(kinds(issues)))
})

await check('内部链接目标不存在 → dead-link', async () => {
  const text = `${GOOD()}\n## Connections\n\n见 [[modules/gone|已删模块]]。\n`
  const issues = inspectArticle(text, { articlePath: 'modules/util.md', allowedLinks: ['modules/util.md'] })
  assert.ok(kinds(issues).includes('dead-link'), JSON.stringify(kinds(issues)))
  const fine = inspectArticle(`${GOOD()}\n## Connections\n\n见 [[modules/util|本模块]]。\n`, { articlePath: 'modules/util.md', allowedLinks: ['modules/util.md'] })
  assert.equal(kinds(fine).includes('dead-link'), false)
})

await check('空文章 → empty', async () => {
  assert.ok(kinds(inspectArticle('', { articlePath: 'modules/x.md' })).includes('empty'))
  assert.ok(kinds(inspectArticle('   \n\n', { articlePath: 'modules/x.md' })).includes('empty'))
})

await check('frontmatter 有内容但正文为空 → empty-body', async () => {
  const text = '---\ntitle: t\ntype: concept\nsource_files:\n  - a.js\ntags: []\n---\n\n'
  assert.ok(kinds(inspectArticle(text, { articlePath: 'concepts/x.md' })).includes('empty-body'))
})

await check('expectedType 覆盖目录推断', async () => {
  const issues = inspectArticle(GOOD(), { articlePath: 'modules/util.md', expectedType: 'concept' })
  assert.ok(kinds(issues).includes('type-mismatch'))
})

await check('parseFrontmatter：块列表、行内列表、引号值、CRLF', async () => {
  const fm = parseFrontmatter('---\r\ntitle: "含: 冒号"\r\nsource_files:\r\n  - a.js\r\n  - b.js\r\ntags: [x, y]\r\n---\r\n\r\n正文\r\n')
  assert.equal(fm.closed, true)
  assert.equal(fm.fields.title, '含: 冒号')
  assert.deepEqual(fm.fields.source_files, ['a.js', 'b.js'])
  assert.deepEqual(fm.fields.tags, ['x', 'y'])
  assert.match(fm.body, /正文/)
})

await check('parseYamlLite：注释行与空行不影响解析', async () => {
  const f = parseYamlLite('title: t\n# 注释\n\ntype: module\n')
  assert.equal(f.title, 't')
  assert.equal(f.type, 'module')
})

await check('extractSections：围栏内的 ## 不算章节', async () => {
  const body = '## Overview\n\n```sh\n## 这不是章节\n```\n\n## Key Components\n\n- a\n'
  const secs = extractSections(body)
  assert.deepEqual(secs.map((s) => s.title), ['Overview', 'Key Components'])
})

await check('fencesBalanced：成对/单数', async () => {
  assert.equal(fencesBalanced('```js\na\n```\n').balanced, true)
  assert.equal(fencesBalanced('```js\na\n').balanced, false)
})

await check('collectWikiLinks：[[名]] 与 markdown 相对链接都收，外链不收', async () => {
  const links = collectWikiLinks('[[modules/a|A]] [b](modules/b.md) [外](https://x/y.md)')
  assert.ok(links.includes('modules/a'))
  assert.ok(links.includes('modules/b.md'))
  assert.equal(links.some((l) => l.includes('x/y')), false)
})

await check('hasDuplicateFrontmatter：单份正文不误报', async () => {
  assert.equal(hasDuplicateFrontmatter('\n## Overview\n\n正文\n'), false)
  assert.equal(hasDuplicateFrontmatter('\n---\ntitle: t\n---\n'), true)
})

// 真机 partial（job-mvzbcw87-0）暴露的误报：正文用 ```yaml 代码块演示 frontmatter 契约时，
// 围栏里的 --- / title: 被当成「又贴了一份头」，于是刚写好的文章被判不合格、整轮 partial。
// 围栏内的内容是**示例**，不是文档自身的头——判定必须跳过代码块。
// 行内代码里的链接写法是**语法示例**，不是真链接。真机 article_validation /
// plan_application / codewiki_vendor_binary 都因为正文里写了 `[[target]]`、`](xxx.md)`
// 这类示例，被判成「内部链接目标不存在」拒写——文档在讲契约，却被契约判违规。
await check('collectWikiLinks：行内代码与代码块里的链接写法不算真链接', async () => {
  const body = [
    '正文里演示语法：`[[target]]`、`[[target|text]]`、`](xxx.md)` 都是字面量。',
    '',
    '```md',
    '[链接](nowhere.md)',
    '[[also-not-a-link]]',
    '```',
    '',
    '真链接在这里：[quality_gates](quality_gates.md)。',
  ].join('\n')
  const links = collectWikiLinks(body)
  assert.deepEqual(links, ['quality_gates.md'], `只应收集真链接，实际 ${JSON.stringify(links)}`)
})
await check('hasDuplicateFrontmatter：代码块里的 frontmatter 示例不算重复贴头', async () => {
  const fenced = [
    '# 模块页',
    '',
    '元数据形如：',
    '',
    '```yaml',
    '---',
    'title: "模块标题"',
    'type: module',
    '---',
    '```',
    '',
    '## Overview',
    '',
    '正文。',
  ].join('\n')
  assert.equal(hasDuplicateFrontmatter(fenced), false, '围栏内的示例被误判为重复贴头')
  // ~~~ 围栏同样要跳过
  const tilde = ['# T', '', '~~~yaml', '---', 'title: x', '---', '~~~', '', '## Overview', '正文'].join('\n')
  assert.equal(hasDuplicateFrontmatter(tilde), false, '~~~ 围栏内的示例被误判')
  // 围栏之外的真重复仍必须判出：跳过围栏不能顺手把闸门关掉
  const outside = ['# T', '', '```yaml', '---', 'title: x', '---', '```', '', '---', 'title: dup', '---', '正文'].join('\n')
  assert.equal(hasDuplicateFrontmatter(outside), true, '围栏外的真重复漏判')
})

await check('必需章节表按类型配置（concept 不要求 Key Components）', async () => {
  assert.deepEqual(REQUIRED_SECTIONS.concept, ['Overview'])
  assert.ok(REQUIRED_SECTIONS.module.includes('Key Components'))
  assert.equal(TYPE_BY_DIR.modules, 'module')
  assert.equal(TYPE_BY_DIR.learnings, 'learning')
})

await check('_index.md 这类 cw 自产索引：调用方用 expectedType 放宽（无 frontmatter 也允许）', async () => {
  const text = '# Wiki Index\n\n## Module\n\n- [[modules/a|A]]\n'
  const strict = inspectArticle(text, { articlePath: '_index.md' })
  assert.ok(kinds(strict).includes('frontmatter-missing'))
  // 闸门对 cw 自产文件豁免（index.js 里不校验 _index.md），此处只验证「缺 frontmatter 会被识别」
})

await check('issueSummary 汇总条数与首因', async () => {
  const issues = inspectArticle('## Overview\n\n正文\n', { articlePath: 'modules/x.md' })
  const s = issueSummary(issues)
  assert.match(s, /文章契约未通过/)
  assert.match(s, /frontmatter/)
})

await check('分级：结构破坏是 error（拒写），章节缺失是 warning（放行但降 partial）', async () => {
  assert.equal(hasBlockingIssue(inspectArticle('## Overview\n\n正文\n', { articlePath: 'modules/x.md' })), true)
  const noSection = GOOD().replace(/## Key Components\n\n- slugify：把字符串转成 slug。\n/, '')
  const issues = inspectArticle(noSection, { articlePath: 'modules/util.md' })
  assert.equal(hasBlockingIssue(issues), false, '缺章节不该拦落盘')
  assert.ok(issues.every((i) => i.severity === 'warning'), JSON.stringify(issues))
  const dup = `${GOOD()}\n---\ntitle: X\ntype: module\n---\n\n## Overview\n\n二份\n`
  assert.equal(hasBlockingIssue(inspectArticle(dup, { articlePath: 'modules/util.md' })), true, '重复 frontmatter 必须拒写')
})

await check('写集闸门：允许自身目标路径，拒绝越界路径（agentic allowedWritePaths）', async () => {
  const ws = makeWriteSet(['.codewiki/modules/a.md'])
  assert.equal(isWritable('.codewiki/modules/a.md', ws), true)
  assert.equal(isWritable('.codewiki/modules/b.md', ws), false)
  assert.equal(isWritable('.codewiki/modules/../../etc/passwd', ws), false)
  assert.equal(isWritable('/abs/other.md', ws), false)
  assert.equal(isWritable('anything', null), true, '未设限时放行')
  // 绝对路径与相对路径互通（cwd 归一）
  const cwd = path.join(os.tmpdir(), 'cwx')
  const abs = path.join(cwd, '.codewiki/modules/a.md')
  assert.equal(isWritable(abs, makeWriteSet(['.codewiki/modules/a.md']), { cwd }), true)
  assert.equal(isWritable(path.join(cwd, '.codewiki/modules/z.md'), makeWriteSet(['.codewiki/modules/a.md']), { cwd }), false)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
