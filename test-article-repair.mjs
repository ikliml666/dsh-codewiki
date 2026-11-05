// lib/article-repair.js 的单元测试。
//
// 修复器的存在理由：真机六个仓库里都躺着「格式坏了但内容还在」的文章，它们让
// `existing-bad-article` 永久成立 → 基线永不推进。把整批删掉是浪费（多数只是缺
// 一个 `---`），所以先修；只有正文本身是模型提示泄漏时才删。
//
// 这个文件的核心不变量：**修完之后必须过得了同一套契约**。修不好的"修复"比不修更糟
// —— 它把一篇明显坏掉的文章变成一篇看着正常、实际错掉的页。
import assert from 'node:assert/strict'
import { repairArticle } from './lib/article-repair.js'
import { inspectArticle, NATIVE_ARTICLE_OPTS, hasBlockingIssue } from './lib/article-contract.js'

let passed = 0
let failed = 0
function check(ok, label, detail) {
  if (ok) { passed += 1; console.log(`  ✓ ${label}`) } else { failed += 1; console.log(`  ✗ ${label}`, detail === undefined ? '' : `\n    ${detail}`) }
}

function issuesOf(text, rel) {
  return inspectArticle(text, { ...NATIVE_ARTICLE_OPTS, articlePath: rel })
}

console.log('== repairArticle：纯正文补 frontmatter ==')
{
  const src = '# 安卓动效升级\n\n- 状态：accepted\n\n## 决策\n\n正文。\n'
  const r = repairArticle(src, 'decisions/android-motion.md')
  check(r.action === 'repair', '无 frontmatter 的正文要修，不删')
  check(r.text.startsWith('---\n'), '修完以 --- 开头')
  check(/^type: decision$/m.test(r.text), 'type 由目录推出')
  check(r.text.includes('title: "安卓动效升级"'), 'title 取首个 H1')
  check(r.text.includes('source_files: []'), '空 source_files 显式写 []')
  check(r.text.includes('tags: []'), '空 tags 显式写 []')
  check(r.text.includes('- 状态：accepted'), '正文原样保留')
  check(!hasBlockingIssue(issuesOf(r.text, 'decisions/android-motion.md')), '修完过契约')
}

console.log('\n== repairArticle：frontmatter 未闭合 ==')
{
  const src = '---\ntitle: x\ntype: learning\nsource_files: []\ntags: []\n\n# 标题\n\n正文。\n'
  const r = repairArticle(src, 'learnings/x.md')
  check(r.action === 'repair', '缺结尾 --- 要修')
  check(/^---\n[\s\S]*\n---\n/.test(r.text), '补上闭合分隔符')
  check(r.text.includes('# 标题'), '正文保留')
  check(!hasBlockingIssue(issuesOf(r.text, 'learnings/x.md')), '修完过契约')
}

console.log('\n== repairArticle：`--- frontmatter` 这种带词的分隔符 ==')
{
  const src = '--- frontmatter\ntitle: y\ntype: concept\nsource_files: []\ntags: []\n\n# 标题\n\n正文。\n'
  const r = repairArticle(src, 'concepts/y.md')
  check(r.action === 'repair', '带词分隔符也要认成 frontmatter 头')
  check(!r.text.includes('--- frontmatter'), '不能把原头留在正文里')
  check(!hasBlockingIssue(issuesOf(r.text, 'concepts/y.md')), '修完过契约')
}

console.log('\n== repairArticle：嵌套 frontmatter: 块 ==')
{
  const src = '---\nfrontmatter:\n  type: concept\n  title: 嵌套页\n  source_files: []\n  tags: []\n---\n\n# 正文\n'
  const r = repairArticle(src, 'concepts/nested.md')
  check(r.action === 'repair', '嵌套结��要展开')
  check(!/^\s+type:/m.test(r.text), '展开后不再有缩进字段')
  check(/^type: concept$/m.test(r.text), 'type 保留')
  check(!hasBlockingIssue(issuesOf(r.text, 'concepts/nested.md')), '修完过契约')
}

console.log('\n== repairArticle：type 与目录不符 ==')
{
  const src = '---\ntitle: x\ntype: module\nsource_files: []\ntags: []\n---\n\n## Overview\n\n正文。\n'
  const r = repairArticle(src, 'learnings/x.md')
  check(r.action === 'repair', 'type 写错要改成目录对应的类型')
  check(/^type: learning$/m.test(r.text), 'learnings/ 下的页改成 learning')
  check(!hasBlockingIssue(issuesOf(r.text, 'learnings/x.md')), '修完过契约')
}

console.log('\n== repairArticle：整篇包在 ```markdown 围栏里 ==')
{
  const src = '```markdown\n---\ntitle: z\ntype: decision\nsource_files: []\ntags: []\n---\n\n## 决策\n\n正文。\n```\n'
  const r = repairArticle(src, 'decisions/z.md')
  check(r.action === 'repair', '剥外层围栏')
  check(r.text.startsWith('---\n'), '围栏剥掉后以 frontmatter 开头')
  check(!hasBlockingIssue(issuesOf(r.text, 'decisions/z.md')), '修完过契约')
}

console.log('\n== repairArticle：外层围栏没闭合（末尾 ``` 丢了） ==')
{
  // 真机（Wxxy-CampusLogin decisions/quality-history-persistence.md）：整篇被包进
  // ```markdown，但收尾的 ``` 丢了。整体吃不掉 FENCE_WRAP，必须单独剥首行，
  // 否则首个 `---` 会被算进正文，修完的页围栏不配对。
  const src = '```markdown\n---\ntitle: q\ntype: decision\nsource_files: []\ntags: []\n---\n\n## 决策\n\n正文。\n'
  const r = repairArticle(src, 'decisions/q.md')
  check(r.action === 'repair', '未闭合外层围栏也要剥')
  check(r.text.startsWith('---\n'), '剥完以 frontmatter 开头')
  check(!r.text.includes('```markdown'), '围栏行不该留在正文里')
  check(!hasBlockingIssue(issuesOf(r.text, 'decisions/q.md')), '修完过契约（围栏配对）')
}

console.log('\n== repairArticle：正文是模型提示泄漏 → 删 ==')
{
  const leaks = [
    ['m00270–m00270 Cargo lock lesson\n\nThe user wants to update an existing CodeWiki article ...\n', '会话 ref 摘要'],
    ['### Compression of Compressed Context\n\nThe user wants to update an existing CodeWiki article.\n', '压缩块标题'],
    ['你是 CodeWiki 文章作者。文章全文用中文书写。\n\n## Overview\n\n...\n', '提示词首句'],
    ['我注意到你提供的“当前内容”是基于旧版代码的。\n\n## Overview\n', '中文元话语'],
    ['I will now update the article based on the provided source.\n', '英文施工说明'],
    ['TASK AS OF THIS BLOCK: ...\n', '任务块标记'],
  ]
  for (const [src, label] of leaks) {
    const r = repairArticle(src, 'learnings/leak.md')
    check(r.action === 'drop', `${label} → drop`)
  }
}

console.log('\n== repairArticle：正文中间引用日志不算泄漏 ==')
{
  // 文章里贴一段日志/对话是正常写法，只有文首的元话语才判泄漏。
  const src = '# 排查记录\n\n## 现象\n\n我复现时看到：\n\n```\nI will now update the article\n```\n\n## 结论\n\n是解析器的 bug。\n'
  const r = repairArticle(src, 'learnings/log.md')
  check(r.action === 'repair', '代码块里的施工文本不判泄漏（要修成正常页）')
  check(!r.reasons.some((x) => /提示/.test(x)), '理由里不该有提示泄漏')
  check(r.text.includes('I will now update the article'), '代码块内容原样保留')
}

console.log('\n== repairArticle：前言在前、真 frontmatter 在后 ==')
{
  const src = '以下是基于当前源码重写的文章。\n\n---\ntitle: p\ntype: decision\nsource_files: []\ntags: []\n---\n\n## 决策\n\n正文。\n'
  const r = repairArticle(src, 'decisions/p.md')
  check(r.action === 'repair', '剥掉前言')
  check(r.text.startsWith('---\n'), '从 frontmatter 开始')
  check(!r.text.includes('以下是基于当前源码重写'), '前言不见了')
  check(r.text.includes('## 决策'), '正文还在')
  check(!hasBlockingIssue(issuesOf(r.text, 'decisions/p.md')), '修完过契约')
}

console.log('\n== repairArticle：已合规的页保持不动 ==')
{
  const src = '---\ntitle: ok\ntype: learning\nsource_files:\n  - index.js\ntags: []\n---\n\n## Overview\n\n正文。\n'
  const r = repairArticle(src, 'learnings/ok.md')
  check(r.action === 'keep', '合规页 keep')
  check(r.text === src, 'keep 时原文一字不改')
}

console.log('\n== repairArticle：空内容 → 删 ==')
{
  check(repairArticle('', 'learnings/x.md').action === 'drop', '空串 drop')
  check(repairArticle('   \n\n', 'learnings/x.md').action === 'drop', '纯空白 drop')
}

console.log('\n== repairArticle：不认识的目录不瞎猜 ==')
{
  const src = '# 标题\n\n正文。\n'
  const r = repairArticle(src, 'unknown/x.md')
  check(r.action === 'keep', '目录推不出 type 时不动它（宁可留给人工）')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
