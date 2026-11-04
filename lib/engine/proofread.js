// 校对：把文章里指向「不存在页面」的跨页链接当场改掉。
//
// 为什么需要这一层：原生引擎写作时，模型会照着旧版聚类的记忆**编造页面名**
// （真机 dsh-git-worktree 里 `client_review_console/status_readouts.md`、
// hindsight 里漏写 `_ui` 后缀的 `settings_and_logs.md`），而模块树里根本没有那些页。
// 质量门如实判 dead-link，于是这些仓库每轮都停在「部分完成」——判据没错，是产物真的错。
//
// 这一层的立场必须说清楚：**它修的是正文，不是判据**。校对后的正文仍要重新过一遍
// 质量门，改不掉就照旧判 partial；绝不在渲染期或终态里豁免缺页/死链。
//
// 只管一类问题：跨页链接目标不存在。这是模型幻觉里唯一可以**只看本页+页名清单**
// 就修对的问题（改成真实页名、或把链接降级成纯文字）。正文事实错误需要读源码，
// 那属于重写文章，不在校对范围。

import fs from 'node:fs'
import path from 'node:path'

import { toPosix as posix } from '../git-paths.js'

// 单轮校对最多处理几篇：每篇一次模型请求。默认 6 篇已经能盖住真机上「一批页同时
// 引用了同一个被合并掉的模块」的形态，再多就变成整轮重跑。
export const DEFAULT_MAX_PAGES = 6

// 模型原样返回正文时用的标记：省一次 diff，也让「改了哪些页」有据可查。
const NO_CHANGE = 'NO_CHANGE'

/** 从 validateOutput 的 problems 里挑出「正文链到不存在的页」的那些源页。 */
export function deadLinkSources(problems) {
  const sources = new Set()
  for (const p of Array.isArray(problems) ? problems : []) {
    if (p?.kind !== 'dead-link') continue
    const src = String(p.source ?? '').trim()
    if (src) sources.add(posix(src))
  }
  return [...sources].sort()
}

/** docs 内所有页的路径（POSIX、已排序），供模型选真实页名。 */
export function listPageNames(docsDir) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = fs.readdirSync(path.join(String(docsDir), rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        // temp/ 是引擎工作文件目录，不是页；隐藏目录同理
        if (e.name.startsWith('.') || e.name === 'temp') continue
        walk(childRel)
        continue
      }
      if (e.isFile() && /\.md$/i.test(e.name)) out.push(childRel)
    }
  }
  walk('')
  return out.sort()
}

/**
 * 校对提示词。刻意给足两侧事实：本页原文、真实页名清单、以及门报出的失效目标——
 * 只给其中一侧，模型只能靠猜（那正是它当初写错的方式）。
 */
export function buildProofreadPrompt({ pageName, pageText, knownPages, missingTargets }) {
  return [
    '你在校对一篇代码 wiki 文章里的跨页链接。',
    '',
    `当前文章：${pageName}`,
    '',
    '这篇文章里有若干链接指向了**不存在的页面**。真实存在的页面清单如下（只能从这里选）：',
    ...(knownPages.length ? knownPages.map((p) => `- ${p}`) : ['- （空）']),
    '',
    '失效的链接目标：',
    ...(missingTargets.length ? missingTargets.map((p) => `- ${p}`) : ['- （无）']),
    '',
    '要求：',
    '1. 只改链接，不改任何叙述、标题、代码块、表格结构、行号锚点文字与 frontmatter；',
    '2. 失效目标的真实页若在清单里（包括后缀差异、父模块前缀差异），改成清单里的相对路径；',
    '3. 清单里找不到对应页时，把该链接降级为纯文字（保留原文措辞，去掉 []() 语法）；',
    '4. 若这篇没有任何需要改的链接，原样输出内容并在末尾单独一行写 ' + NO_CHANGE + '。',
    '',
    '严格按下面格式返回，不要解释：',
    '<PAGE>',
    '（完整文章正文，含原有 frontmatter）',
    '</PAGE>',
    '',
    '原文：',
    '<PAGE>',
    pageText,
    '</PAGE>',
  ].join('\n')
}

/** 解析模型回复：取 <PAGE> 段；末尾的 NO_CHANGE 表示「无需改动」。 */
export function parseProofreadReply(reply) {
  const text = String(reply ?? '')
  const m = text.match(/<PAGE>\r?\n?([\s\S]*?)\r?\n?<\/PAGE>/)
  if (!m) return { ok: false, unchanged: false, text: '' }
  const raw = m[1]
  const unchanged = new RegExp(`(^|\\n)\\s*${NO_CHANGE}\\s*$`).test(raw)
  const cleaned = raw.replace(new RegExp(`\\n?\\s*${NO_CHANGE}\\s*$`), '').trimEnd()
  return { ok: cleaned.length > 0, unchanged, text: cleaned }
}

/**
 * 校对若干篇文章。
 *
 * @param {object} o
 * @param {string} o.docsDir          引擎产物目录
 * @param {string[]} o.sources        要校对的页（docs 内相对路径）
 * @param {(prompt:string, signal:AbortSignal|null) => Promise<string>} o.chat 单轮文本生成
 * @param {number} [o.maxPages]
 * @param {AbortSignal|null} [o.signal]
 * @returns {Promise<{checked:string[], changed:string[], failed:{source:string,error:string}[], notes:string[]}>}
 */
export async function proofreadPages({
  docsDir, sources, chat, maxPages = DEFAULT_MAX_PAGES, signal = null,
} = {}) {
  const result = { checked: [], changed: [], failed: [], notes: [] }
  if (typeof chat !== 'function') return result
  const knownPages = listPageNames(docsDir)
  if (!knownPages.length) return result
  // 要改的目标 = 该页里所有指向不存在页面的链接（用同一套页名清单判，不另立判据）
  const knownSet = new Set(knownPages.map(posix))
  const queue = [...new Set((Array.isArray(sources) ? sources : []).map(posix))]
    .filter((s) => knownSet.has(s))
    .slice(0, maxPages)

  for (const source of queue) {
    if (signal?.aborted) break
    const file = path.join(String(docsDir), source)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      result.failed.push({ source, error: `不可读：${err.code ?? err.message}` })
      continue
    }
    const missing = missingLinksOf(text, source, knownSet)
    if (!missing.length) continue
    result.checked.push(source)
    const prompt = buildProofreadPrompt({ pageName: source, pageText: text, knownPages, missingTargets: missing })
    let reply
    try {
      reply = await chat(prompt, signal)
    } catch (err) {
      result.failed.push({ source, error: String(err?.message ?? err).slice(0, 300) })
      continue
    }
    const parsed = parseProofreadReply(reply)
    if (!parsed.ok || parsed.unchanged) continue
    // 正文一字不动是硬约束，但校对**本来就要动正文**——所以这里只保证不丢 frontmatter：
    // 模型若把 frontmatter 吃掉或改坏，这篇宁可不动（原样保留，问题留给质量门如实上报）。
    if (!/^---\r?\n/.test(parsed.text) && /^---\r?\n/.test(text)) {
      result.notes.push(`${source}：校对结果缺 frontmatter，保留原文`)
      continue
    }
    const after = missingLinksOf(parsed.text, source, knownSet)
    if (after.length >= missing.length) {
      result.notes.push(`${source}：校对后仍有 ${after.length} 处失效链接，保留原文`)
      continue
    }
    fs.writeFileSync(file, parsed.text, 'utf8')
    result.changed.push(source)
    result.notes.push(`${source}：校对改写 ${missing.length} 处失效链接（剩余 ${after.length} 处）`)
  }
  return result
}

/** 该页正文里指向 docs 内不存在页面的链接目标（POSIX 解析后去重）。 */
export function missingLinksOf(text, source, knownSet) {
  const base = posix(path.posix.dirname(posix(source)))
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/\[[^\]\n]*\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/g)) {
    const target = m[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const resolved = posix(path.posix.normalize(path.posix.join(base === '.' ? '' : base, target)))
    if (resolved.startsWith('../')) continue
    if (!knownSet.has(resolved)) out.add(resolved)
  }
  return [...out].sort()
}
