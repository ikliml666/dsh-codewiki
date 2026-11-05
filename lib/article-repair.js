// 存量文章修复：把「格式坏了但内容还在」的页修回合规，只有内容本身是污染时才判删。
//
// 为什么需要这一层：`auditExistingArticles` 只用 `inspectArticle` 判对错，判出问题后
// 只有两种处置——留着不管（基线被永久否决），或者删掉。真机五个仓库的统计说明这两种
// 都不对：61 篇被判坏的页里，真正内容有问题的只有 11 篇，其余是四类**纯格式**缺陷：
//   · 缺 frontmatter（20 篇）—— 手写的 `# 标题` 正文，从没人往里写 YAML 头；
//   · 前言污染（8 篇）—— 正文前面粘了一句「以下是基于当前源码重写的文章。」或把整篇
//     包进 ```markdown 围栏，frontmatter 本身是好的；
//   · frontmatter 未闭合（9 篇）—— 有 `title/type/source_files/tags`，只是少了结尾的 `---`，
//     于是 `parseFrontmatter` 把整个文件当成没有 frontmatter，连正文都读不出来；
//   · type 与目录不符（9 篇）—— `learnings/` 下的页写成 `type: module`。
// 这些页删掉等于用格式问题销毁内容，留着等于让基线永远推不动。所以先修，修不动才删。
//
// 判删的唯一依据是「正文里混进了模型的思考/提示原文」：那种页的内容本身就是错的，
// 修掉开头也改变不了它描述的是一段不存在的对话。
//
// 纯函数，不碰文件系统：修复结果由调用方决定写回还是丢弃。

import path from 'node:path'

import { TYPE_BY_DIR, parseFrontmatter, stripCode } from './article-contract.js'

// 模型输出泄漏的指纹。只判**文首第一个块**（frontmatter 之前或正文头几行）：
// 正文中间出现 "I will now" 可能是在引用日志，不该据此删整篇。
const LEAK_MARKERS = [
  /^I will now (update|rewrite|create|generate)/im,
  /^Here is the (updated|rewritten|complete)/im,
  /^Sure[,.]?\s/im,
  /^以下是(基于|更新|重写)/m,
  /^(基于|根据)提供的?源码/m,
  /^压缩\s*m\d+/m,
  /^m\d{5}\s*[–\-]\s*m\d{5}/m,
  /^TASK AS OF THIS BLOCK/m,
  /^The article has been (updated|rewritten)/im,
  /^你是\s*CodeWiki\s*文章作者/m,
  // 压缩/思考原文的两种开头。真机上以 `### Compression of Compressed Context` 起头、
  // 紧跟 `The user wants to update an existing CodeWiki article ...` 的页有整批：
  // 它们没有自己的 frontmatter，中间靠 ```markdown 围栏夹着一段 frontmatter，
  // 修复器会把围栏前的内容当「前言」剥掉、把围栏内容当正文留下来 —— 于是产出一篇
  // 看着像文章、实际是别人写给我的施工说明的页，比直接删更糟。
  /^#{1,3}\s*Compression of Compressed Context/im,
  /^The user wants to\b/im,
  // 中文元话语：模型在跟「你」对话（「你提供的源码」「你的任务要求」），不是在写文档。
  // 这些句子只可能来自提示回显，正文里不会有作者这样称呼读者。
  /^我注意到你提供/m,
  /^你的任务要求/m,
  /^根据你提供的(指令|源码)/m,
  /^为了(准确|正确)?(重写|更新|生成)这?篇/m,
]

const FENCE_WRAP = /^\s*```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/

function posix(p) {
  return String(p ?? '').split('\\').join('/')
}

/** 目录 → 该目录下的文章类型（`modules/a.md` → `module`）。 */
function dirTypeOf(rel) {
  const dir = posix(rel).split('/')[0]
  return TYPE_BY_DIR[dir] ?? null
}

/** 从正文里取一级标题当文章标题（`# 引擎核心` → `引擎核心`）。 */
function headingOf(body) {
  const m = String(body ?? '').match(/^\s*#\s+(.+?)\s*$/m)
  return m ? m[1].replace(/\s+#+\s*$/, '').trim() : null
}

/** 从文件名推一个标题（`android-settings-ia-reorg.md` → `android settings ia reorg`）。 */
function titleFromRel(rel) {
  return path.posix.basename(posix(rel), '.md').replace(/[-_]+/g, ' ').trim()
}

function looksLikeLeak(text) {
  return LEAK_MARKERS.some((re) => re.test(text))
}

/**
 * 找正文里的第一行标题（`# ` 或 `## `）。返回行号，没有则 -1。
 *
 * 用它来定位「frontmatter 到哪里结束」：未闭合的 frontmatter 没有结束标记，
 * 但它的后面一定跟着正文标题，两者之间只隔空行。
 */
function firstHeadingLine(lines) {
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (!t) continue
    if (/^#{1,2}\s+\S/.test(t)) return i
    // 先遇到非标题正文：frontmatter 区里不会有这种行，说明 fm 已经结束了
    if (!/^[A-Za-z0-9_.-]+\s*:/.test(t) && !/^\s*-\s+/.test(lines[i]) && !/^\s{2,}\S/.test(lines[i])) return i
  }
  return -1
}

// frontmatter 起始行。除了标准的 `---`，真机还见过 `--- frontmatter`（分隔符后跟了
// 一个词）：语义上仍是分隔符，只是多了个手误的尾词，不该因此把整篇当成没有 frontmatter。
const FM_OPEN = /^---(\s+frontmatter)?\s*$/i

/** 把 `frontmatter:\n  type: x\n  ...` 展开成顶层字段，同时保留同级未缩进的行。 */
function unwrapNestedFm(fmLines) {
  const out = []
  let inNested = false
  for (const line of fmLines) {
    const t = line.trim()
    if (!t) { out.push(''); continue }
    if (/^frontmatter\s*:\s*$/.test(t)) { inNested = true; continue }
    if (!inNested) { out.push(line); continue }
    // 嵌套块里的行都缩进两格；一旦遇到顶格行，嵌套块就结束了
    if (/^\s{2,}\S/.test(line)) { out.push(line.replace(/^\s{2}/, '')); continue }
    inNested = false
    out.push(line)
  }
  return out
}

/** 补上缺失的必填字段；已有字段一律不覆盖。 */
function fillFields(fmText, { rel, body }) {
  const lines = fmText ? fmText.split(/\r?\n/) : []
  const has = (key) => new RegExp(`^${key}\\s*:`, 'm').test(lines.join('\n'))
  const add = []
  if (!has('title')) add.push(`title: ${JSON.stringify(headingOf(body) || titleFromRel(rel))}`)
  if (!has('type')) {
    const want = dirTypeOf(rel)
    if (want) add.push(`type: ${want}`)
  }
  if (!has('source_files')) add.push('source_files: []')
  if (!has('tags')) add.push('tags: []')
  return [...add, ...lines].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim()
}

function assemble(fmText, body) {
  const fm = String(fmText ?? '').trim()
  const b = String(body ?? '').replace(/^\s*\n/, '').trimEnd()
  return `---\n${fm}\n---\n\n${b}\n`
}

/**
 * 判一篇存量页该「留」「修」还是「删」。
 *
 * @param {string} text 磁盘上的原文
 * @param {string} rel  相对 wiki 根的路径（`modules/foo.md`），用于推 type 与标题
 * @returns {{action:'keep'|'repair'|'drop', text:string, reasons:string[]}}
 *   keep：不用动；repair：text 是修好的正文；drop：内容本身不可救
 */
export function repairArticle(text, rel) {
  const raw = String(text ?? '')
  const reasons = []
  if (!raw.trim()) return { action: 'drop', text: raw, reasons: ['正文为空'] }

  // 先剥 ```markdown 围栏：整篇被包进围栏时，围栏本身不是内容。
  let src = raw
  const fenced = raw.match(FENCE_WRAP)
  if (fenced) {
    src = fenced[1]
    reasons.push('剥掉外层 markdown 围栏')
  } else {
    // 围栏没闭合（真机上有整篇被包进 ```markdown、末尾 ```` 丢了 的页）。这时整体
    // 不吃 FENCE_WRAP，得单独剥开头那一行，否则首个 `---` 会被算进正文里。
    const fLines = raw.split(/\r?\n/)
    if (/^\s*```(?:markdown|md)?\s*$/.test(fLines[0] ?? '')) {
      const lastIdx = fLines.reduce((acc, l, i) => (l.trim() ? i : acc), -1)
      const closed = lastIdx > 0 && /^\s*```\s*$/.test(fLines[lastIdx])
      src = fLines.slice(1, closed ? lastIdx : undefined).join('\n')
      reasons.push('剥掉未闭合的外层 markdown 围栏')
    }
  }

  const fm = parseFrontmatter(src)
  if (fm.fields) {
    // 有 frontmatter：只需要判 type 与必填字段，其余不动（正文由作者负责）。
    const lines = src.split(/\r?\n/)
    const fmLines = lines.slice(1, fm.endLine - 1)
    const nested = fmLines.some((l) => /^frontmatter\s*:\s*$/.test(l.trim()))
    let fmText = fmLines.join('\n')
    if (nested) { fmText = unwrapNestedFm(fmLines); reasons.push('展开嵌套的 frontmatter: 块') }
    const filled = fillFields(Array.isArray(fmText) ? fmText.join('\n') : fmText, { rel, body: fm.body })
    if (filled !== (Array.isArray(fmText) ? fmText.join('\n') : fmText).trim()) reasons.push('补齐必填字段')
    const want = dirTypeOf(rel)
    const got = (fm.fields.type ? String(fm.fields.type).trim() : '')
    if (want && got && got !== want) {
      const fixed = filled.split('\n').map((l) => (l.startsWith('type:') ? `type: ${want}` : l)).join('\n')
      reasons.push(`type 改成 ${want}（原 ${got}）`)
      return { action: 'repair', text: assemble(fixed, fm.body), reasons }
    }
    if (!reasons.length) return { action: 'keep', text: src, reasons }
    return { action: 'repair', text: assemble(filled, fm.body), reasons }
  }

  // 没有 frontmatter。先定位正文：找到 `---` 起点或首个标题。
  const lines = src.split(/\r?\n/)
  const fmStart = lines.findIndex((l, i) => i > 0 && FM_OPEN.test(l.trim()))
  // `---` 可能落在代码围栏内部（真机上整篇文章被 ```markdown 包住、前面又粘了一段
  // 前言）。这时从 `---` 切会把围栏的开头留在前言里，切剩的正文只剩一个孤零零的
  // 结尾 ```，围栏从此不配对 —— 修完的文章反而过不了契约。所以往前找到围栏起点。
  const fenceOpeningAt = (idx) => {
    let open = -1
    const upto = Math.min(idx, lines.length - 1)
    for (let i = 0; i <= upto; i += 1) {
      if (/^\s*```/.test(lines[i])) open = open === -1 ? i : -1
    }
    return open
  }
  const bodyStart = fmStart > 0 ? (() => { const f = fenceOpeningAt(fmStart); return f >= 0 ? f : fmStart })() : fmStart

  // 情形一优先于污染判定：`以下是基于当前源码重写的文章。` 这种单句前言是可剥的，
  // 后面跟着合法的 frontmatter 时它只是「模型在说话」，剥掉就干净了。顺序反了会
  // 把整批只是粘了一句话的页判成不可救 —— 真机上这类有 8 篇。
  // `--- frontmatter` 这类开头不会被误当成前言：它不满足 i > 0，且已在上面单独处理。
  if (bodyStart > 0 && src.trimStart().startsWith('---') === false) {
    const rest = lines.slice(bodyStart).join('\n')
    const afterFence = fenceOpeningAt(fmStart) >= 0 ? rest.match(FENCE_WRAP) : null
    const candidate = afterFence ? afterFence[1] : rest
    const re = parseFrontmatter(candidate)
    if (re.fields) {
      reasons.push('剥掉 frontmatter 之前的前言')
      const sub = repairArticle(candidate, rel)
      if (sub.action !== 'drop') {
        return { action: 'repair', text: sub.text, reasons: [...reasons, ...sub.reasons] }
      }
    }
  }

  // 内容污染判定只看文首这一块，且要剥掉代码：文章里贴一段日志、引用一句对话是
  // 正常写法，只有正文前的元话语才算泄漏。
  const head = stripCode(lines.slice(0, 24).join('\n'))
  if (looksLikeLeak(head)) {
    return { action: 'drop', text: raw, reasons: ['文首混进模型输出（提示/思考原文），内容不可救'] }
  }

  // 情形二：frontmatter 未闭合（有字段但没有结束标记）。
  if (FM_OPEN.test(lines[0].trim())) {
    const bodyAt = firstHeadingLine(lines)
    if (bodyAt > 0) {
      const fmLines = lines.slice(1, bodyAt).filter((l) => l.trim() !== '')
      const nested = fmLines.some((l) => /^frontmatter\s*:\s*$/.test(l.trim()))
      let fmText = nested ? unwrapNestedFm(fmLines).join('\n') : fmLines.join('\n')
      if (nested) reasons.push('展开嵌套的 frontmatter: 块')
      const body = lines.slice(bodyAt).join('\n')
      fmText = fillFields(fmText, { rel, body })
      reasons.push('补上缺失的 frontmatter 结束标记 ---')
      return { action: 'repair', text: assemble(fmText, body), reasons }
    }
  }

  // 情形三：纯正文（手写的 markdown），按目录补一份 frontmatter。
  const body = src.replace(/^\s*\n/, '')
  if (!body.trim()) return { action: 'drop', text: raw, reasons: ['正文为空'] }
  const want = dirTypeOf(rel)
  if (!want) return { action: 'keep', text: src, reasons }
  reasons.push('补一份 frontmatter（原文只有正文）')
  return { action: 'repair', text: assemble(fillFields('', { rel, body }), body), reasons }
}
