// 语义校对（lib/engine/proofread.js）的测试。
//
// 这一层修的是一类真实故障：模型写作时编造页面名，正文里留下指向不存在页面的
// 跨页链接，质量门如实判 dead-link，仓库于是每轮停在「部分完成」。
//
// 每条断言都对应一个会真实发生的错误做法：
//   · 校对变成「把死链删掉」→ 正文措辞被破坏（这里必须只动链接、文字一字不动）；
//   · 校对结果不可信时照样写盘 → 越修越坏（失效数没减少就必须保留原文）；
//   · 把 frontmatter 吃掉 → 文章在 cw index 里消失；
//   · 校对顺手放宽判据 → 那是掩盖缺陷，不是修产物（本层只改正文，门照旧判）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

import {
  DEFAULT_MAX_PAGES,
  buildProofreadPrompt,
  deadLinkSources,
  listPageNames,
  missingLinksOf,
  parseProofreadReply,
  proofreadPages,
} from './lib/engine/proofread.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-proofread-'))
let pass = 0
const fails = []
const check = async (label, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`PASS  ${label}`)
  } catch (err) {
    fails.push({ label, err })
    console.log(`FAIL  ${label}`)
  }
}

const makeDocs = (name, files) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, text, 'utf8')
  }
  return dir
}

const page = (title, body, extra = '') => `---\ntitle: ${title}\ntype: module${extra}\n---\n\n# ${title}\n\n${body}\n`

// ── 1. 判据 ─────────────────────────────────────────────────────────────

await check('deadLinkSources：只挑 dead-link 的源页，去重且排序', async () => {
  const sources = deadLinkSources([
    { kind: 'dead-link', source: 'b.md', target: 'x.md' },
    { kind: 'dead-link', source: 'a.md', target: 'y.md' },
    { kind: 'dead-link', source: 'a.md', target: 'z.md' },
    { kind: 'article-missing', source: 'c.md' },
  ])
  assert.deepEqual(sources, ['a.md', 'b.md'])
})

await check('missingLinksOf：按源页目录解析相对路径，指向不存在的页才算失效', async () => {
  const known = new Set(['sub/a.md', 'sub/b.md', 'top.md'])
  const text = [
    '[兄弟](b.md)',        // sub/b.md — 存在
    '[父级](../top.md)',    // 以 ../ 开头，不在本层责任内
    '[编造](gone.md)',      // sub/gone.md — 失效
    '[外链](https://x/y.md)',
    '[根](top.md)',         // sub/top.md — 失效（相对解析，不是仓库根）
  ].join(' ')
  assert.deepEqual(missingLinksOf(text, 'sub/a.md', known), ['sub/gone.md', 'sub/top.md'])
})

await check('listPageNames：跳过隐藏目录与 temp/', async () => {
  const dir = makeDocs('list', {
    'overview.md': '# 概览',
    'sub/a.md': '# a',
    'temp/scratch.md': '# scratch',
    '.hidden/x.md': '# x',
  })
  assert.deepEqual(listPageNames(dir), ['overview.md', 'sub/a.md'])
})

// ── 2. 提示词与回复解析 ───────────────────────────────────────────────────

await check('buildProofreadPrompt：同时给出真实页名清单与失效目标', async () => {
  const prompt = buildProofreadPrompt({
    pageName: 'mod.md',
    pageText: '# mod\n',
    knownPages: ['mod.md', 'other.md'],
    missingTargets: ['gone.md'],
  })
  assert.match(prompt, /真实存在的页面清单/)
  assert.match(prompt, /- other\.md/)
  assert.match(prompt, /gone\.md/)
  // 只改链接这条约束必须在提示里，否则模型会顺手重写正文
  assert.match(prompt, /只改链接/)
})

await check('parseProofreadReply：取出 PAGE 段并剥掉 NO_CHANGE 尾巴', async () => {
  const ok = parseProofreadReply('<PAGE>\n# mod\n\n正文\n</PAGE>')
  assert.equal(ok.ok, true)
  assert.equal(ok.unchanged, false)
  assert.equal(ok.text, '# mod\n\n正文')
  const same = parseProofreadReply('<PAGE>\n# mod\nNO_CHANGE\n</PAGE>')
  assert.equal(same.unchanged, true)
  const bad = parseProofreadReply('抱歉我无法完成')
  assert.equal(bad.ok, false)
})

// ── 3. 校对主流程 ────────────────────────────────────────────────────────

await check('proofreadPages：模型改对后写盘，文字部分一字不动', async () => {
  const dir = makeDocs('apply', {
    'mod.md': page('mod', '见 [子模块](gone.md) 与 [真实页](real.md)。'),
    'real.md': page('real', '正文。'),
  })
  const seen = []
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['mod.md'],
    chat: async (prompt) => {
      seen.push(prompt)
      return '<PAGE>\n' + page('mod', '见 [子模块](real.md) 与 [真实页](real.md)。') + '</PAGE>'
    },
  })
  assert.deepEqual(out.changed, ['mod.md'], JSON.stringify(out))
  assert.deepEqual(out.checked, ['mod.md'])
  assert.equal(seen.length, 1)
  const after = readFileSync(join(dir, 'mod.md'), 'utf8')
  assert.match(after, /\[子模块\]\(real\.md\)/)
  // 正文措辞必须原样保留（校对只改链接）
  assert.match(after, /见 \[子模块\]\(real\.md\) 与 \[真实页\]\(real\.md\)。/)
  assert.match(out.notes.join('\n'), /校对改写 1 处失效链接/)
})

await check('proofreadPages：模型没修对就保留原文（不许越修越坏）', async () => {
  const dir = makeDocs('regress', {
    'mod.md': page('mod', '见 [子模块](gone.md)。'),
  })
  const before = readFileSync(join(dir, 'mod.md'), 'utf8')
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['mod.md'],
    // 模型返回同样的失效链接
    chat: async () => '<PAGE>\n' + before + '</PAGE>',
  })
  assert.deepEqual(out.changed, [])
  assert.equal(readFileSync(join(dir, 'mod.md'), 'utf8'), before)
  assert.match(out.notes.join('\n'), /保留原文/)
})

await check('proofreadPages：模型吃掉 frontmatter 时保留原文', async () => {
  const dir = makeDocs('fm', {
    'mod.md': page('mod', '见 [子模块](gone.md)。'),
  })
  const before = readFileSync(join(dir, 'mod.md'), 'utf8')
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['mod.md'],
    chat: async () => '<PAGE>\n# mod\n\n见 [子模块](real.md)。\n</PAGE>',
  })
  assert.deepEqual(out.changed, [])
  assert.equal(readFileSync(join(dir, 'mod.md'), 'utf8'), before)
  assert.match(out.notes.join('\n'), /缺 frontmatter/)
})

await check('proofreadPages：模型报 NO_CHANGE 时不写盘', async () => {
  const dir = makeDocs('nochange', {
    'mod.md': page('mod', '见 [子模块](gone.md)。'),
  })
  const before = readFileSync(join(dir, 'mod.md'), 'utf8')
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['mod.md'],
    chat: async () => '<PAGE>\n' + before + '\nNO_CHANGE\n</PAGE>',
  })
  assert.deepEqual(out.changed, [])
  assert.equal(readFileSync(join(dir, 'mod.md'), 'utf8'), before)
})

await check('proofreadPages：没有失效链接的页不发请求（不白烧预算）', async () => {
  const dir = makeDocs('clean', {
    'mod.md': page('mod', '见 [真实页](real.md)。'),
    'real.md': page('real', '正文。'),
  })
  let calls = 0
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['mod.md'],
    chat: async () => { calls += 1; return '<PAGE>x</PAGE>' },
  })
  assert.equal(calls, 0)
  assert.deepEqual(out.checked, [])
  assert.deepEqual(out.changed, [])
})

await check('proofreadPages：请求数受 maxPages 限制', async () => {
  const files = {}
  const sources = []
  for (let i = 0; i < 4; i += 1) {
    files[`p${i}.md`] = page(`p${i}`, `见 [编造](gone${i}.md)。`)
    sources.push(`p${i}.md`)
  }
  const dir = makeDocs('cap', files)
  let calls = 0
  await proofreadPages({
    docsDir: dir,
    sources,
    maxPages: 2,
    chat: async () => { calls += 1; return '<PAGE>x</PAGE>' },
  })
  assert.equal(calls, 2)
  assert.equal(DEFAULT_MAX_PAGES, 6)
})

await check('proofreadPages：chat 抛错记进 failed，不中断其余页', async () => {
  const dir = makeDocs('failsoft', {
    'a.md': page('a', '见 [编造](gone.md)。'),
    'b.md': page('b', '见 [编造](gone2.md)。'),
  })
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['a.md', 'b.md'],
    chat: async (prompt) => {
      if (prompt.includes('当前文章：a.md')) throw new Error('通道失败')
      return '<PAGE>\n' + page('b', '见 [编造](gone2.md)。').replace('gone2.md', 'a.md') + '</PAGE>'
    },
  })
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].source, 'a.md')
  assert.match(out.failed[0].error, /通道失败/)
})

await check('proofreadPages：sources 里不存在于 docs 的路径被忽略', async () => {
  const dir = makeDocs('virtual', {
    'mod.md': page('mod', '见 [编造](gone.md)。'),
  })
  let calls = 0
  const out = await proofreadPages({
    docsDir: dir,
    sources: ['not-there.md'],
    chat: async () => { calls += 1; return '<PAGE>x</PAGE>' },
  })
  assert.equal(calls, 0)
  assert.deepEqual(out.checked, [])
})

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack}`)
  process.exit(1)
}
