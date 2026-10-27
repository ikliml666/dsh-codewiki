// 文章契约闸门：一篇 wiki 文章要满足的最低结构，统一在这里判。
//
// 背景缺陷（审计确认）：旧闸门 validateArticleEnvelope（index.js:1005）只查
// 「frontmatter 有没有开头、有没有闭合」，于是这些东西都能入库：
//   - concepts/wiki-generation-flow.md 从第 64 行起又贴了一份 frontmatter 与整段正文；
//   - 必需章节存在但正文是空的（只有标题）；
//   - source_files 列着不存在的文件、或列了目录；
//   - 正文里的 [[链接]] 指向早已删掉的文章；
//   - 代码围栏没闭合，后面整篇都被当成代码块。
//
// 本模块是纯函数（不碰文件系统），因此可以单测；真正的落盘闸门在 index.js 调用它。
// 判据按「文章类型 → 必需章节」配置，避免对 learning/pattern 类文章过度要求。

import path from 'node:path'

export const ARTICLE_CONTRACT_VERSION = 1

// 目录 → 允许的 type（type 与目录不匹配时 cw index 的分类会错乱）
export const TYPE_BY_DIR = {
  modules: 'module',
  concepts: 'concept',
  learnings: 'learning',
  decisions: 'decision',
  patterns: 'pattern',
  queries: 'query',
}
// 根目录下的特殊文章
export const ROOT_TYPES = {
  '_architecture.md': 'architecture',
  '_index.md': 'index',
  '_patterns.md': 'pattern',
}

// 各类型的必需章节（必须存在且非空）。只列真正不能空的：
// 所有类型都要有 Overview；module/architecture 必须有 Key Components。
export const REQUIRED_SECTIONS = {
  module: ['Overview', 'Key Components'],
  architecture: ['Overview', 'Key Components'],
  concept: ['Overview'],
  learning: ['Overview'],
  decision: ['Overview'],
  pattern: ['Overview'],
  query: ['Overview'],
  index: [],
}
export const REQUIRED_FIELDS = ['title', 'type', 'source_files']

// 问题分级。这个分级是**闸门行为**的分界，不是措辞差异：
//   error   —— 结构已破坏，落盘即污染 wiki，必须拒写（重复 frontmatter/正文、围栏未闭合、
//              source_files 不存在或不是证据、死链、缺必填字段、正文为空、必需章节空着）。
//   warning —— 内容不达标但结构完整（缺必需章节、非必需章节空着）。不拒写（旧通道的整包装填
//              产出天然是「一段正文」，硬拒会把存量文章全判死），但会让本次编译终态
//              降为 partial 并阻止基线前移——「装绿」是不允许的。
// 注：missing-section 与 empty-section 必须分开——「压根没写这一章」与「写了标题却空着」
// 是两种缺陷，前者旧通道常见，后者是明确的坏文章。
export const SEVERITY = {
  empty: 'error',
  'frontmatter-missing': 'error',
  'frontmatter-unclosed': 'error',
  'missing-field': 'error',
  'type-mismatch': 'error',
  'bad-source': 'error',
  'missing-source': 'error',
  'source-not-evidence': 'error',
  'empty-body': 'error',
  'duplicate-frontmatter': 'error',
  'duplicate-section': 'error',
  'unclosed-fence': 'error',
  'dead-link': 'error',
  'empty-section': 'error',
  'missing-section': 'warning',
  'empty-section-optional': 'warning',
}

// 解析 frontmatter：只认文首第一个 `---` 块。
// 返回 { fields, body, endLine, closed, raw }
export function parseFrontmatter(content) {
  const text = String(content ?? '')
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (!lines.length || lines[0].trim() !== '---') return { fields: null, body: normalized, endLine: 0, closed: false, raw: '' }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end === -1) return { fields: null, body: normalized, endLine: 0, closed: false, raw: '' }
  const raw = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')
  return { fields: parseYamlLite(raw), body, endLine: end + 1, closed: true, raw }
}

// 极简 YAML：只支持本仓库文章用到的形态（key: value、key: 后跟 `- item` 列表）。
// 不引依赖：frontmatter 只是元数据，不需要完整 YAML 语义。
export function parseYamlLite(raw) {
  const fields = {}
  let currentKey = null
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && currentKey) {
      if (!Array.isArray(fields[currentKey])) fields[currentKey] = []
      fields[currentKey].push(unquote(item[1].trim()))
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    currentKey = key
    if (!value) { fields[key] = []; continue }
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = value.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean)
      continue
    }
    fields[key] = unquote(value)
  }
  return fields
}

function unquote(s) {
  const t = String(s ?? '')
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

// 正文里的 `## 标题` 章节：返回 [{ title, content, line }]
export function extractSections(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const out = []
  let cur = null
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence) {
      const m = line.match(/^##\s+(.+?)\s*$/)
      if (m) {
        if (cur) out.push(cur)
        cur = { title: m[1].trim(), lines: [], line: i + 1 }
        continue
      }
    }
    if (cur) cur.lines.push(line)
  }
  if (cur) out.push(cur)
  return out.map((s) => ({ title: s.title, content: s.lines.join('\n').trim(), line: s.line }))
}

// 代码围栏是否成对
export function fencesBalanced(body) {
  const fences = String(body ?? '').split(/\r?\n/).filter((l) => /^\s*(```|~~~)/.test(l))
  return { balanced: fences.length % 2 === 0, count: fences.length }
}

// 文章里的 wiki 链接目标
export function collectWikiLinks(body) {
  const targets = new Set()
  const text = String(body ?? '')
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) targets.add(String(m[1]).trim())
  for (const m of text.matchAll(/\]\(([^)\s]+?\.md)(?:#[^)\s]*)?\)/g)) {
    const t = String(m[1]).trim()
    if (!/^[a-z]+:/i.test(t)) targets.add(t)
  }
  return [...targets]
}

// 正文里是否又出现了一份 frontmatter（重复正文/重复贴头的特征）
export function hasDuplicateFrontmatter(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '---') continue
    // 后面 30 行内出现第二个 --- 且中间有 title:/type: 之类的字段，就算重复 frontmatter
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
      if (lines[j].trim() === '---') {
        const inner = lines.slice(i + 1, j).join('\n')
        if (/^\s*(title|type|source_files)\s*:/m.test(inner)) return true
        break
      }
    }
  }
  return false
}

function isRepoRelativeFile(p) {
  const s = String(p ?? '').trim()
  if (!s) return false
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false
  if (s.startsWith('../') || s.includes('/../')) return false
  if (s.endsWith('/')) return false
  // 目录形态（没有扩展名）不是合法 source_files 条目
  return path.posix.basename(s).includes('.')
}

// 主入口：返回 issues[]（空数组 = 通过）。
//   content          文章全文
//   cwd              仓库根（用于 source_files 存在性判定，可选）
//   articlePath      文章在 wiki 里的相对路径（modules/x.md），用于 type 与目录匹配
//   expectedType     调用方期望的 type（可选，覆盖目录推断）
//   readableSources  本次实际读取/提供给模型的文件清单（source_files 必须是它的子集）
//   allowedLinks     允许的 wiki 链接目标集合（文章名/相对路径）；null 表示不检查
//   fsImpl           提供 exists(relPath) 的文件系统适配（可选）
export function inspectArticle(content, opts = {}) {
  const {
    cwd = null, articlePath = null, expectedType = null,
    readableSources = null, allowedLinks = null, fsImpl = null,
  } = opts
  const issues = []
  const push = (kind, detail) => issues.push({ kind, detail, severity: SEVERITY[kind] ?? 'error' })
  const text = String(content ?? '')
  if (!text.trim()) {
    push('empty', '文章内容为空')
    return issues
  }

  const fm = parseFrontmatter(text)
  if (!fm.fields) {
    push(text.trimStart().startsWith('---') ? 'frontmatter-unclosed' : 'frontmatter-missing',
      text.trimStart().startsWith('---') ? 'frontmatter 未闭合（缺结束 ---）' : '模型输出缺 frontmatter')
    return issues
  }

  // 必填字段
  for (const f of REQUIRED_FIELDS) {
    const v = fm.fields[f]
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || String(v).trim() === '') {
      push('missing-field', `frontmatter 缺必填字段 ${f}`)
    }
  }
  // tags 是必填**字段**但允许为空列表（很多模块文章确实没有标签，空 tags 是合法形态）；
  // 与 source_files 不同——source_files 空列表意味着文章没有任何代码依据，必须拒。
  if (!Object.prototype.hasOwnProperty.call(fm.fields, 'tags')) {
    push('missing-field', 'frontmatter 缺必填字段 tags（没有标签也要写成 tags: []）')
  }

  // type 与目录匹配
  const dirType = articlePath
    ? (ROOT_TYPES[path.posix.basename(String(articlePath))] ?? TYPE_BY_DIR[String(articlePath).split('/')[0]] ?? null)
    : null
  const wantType = expectedType ?? dirType
  const gotType = fm.fields.type ? String(fm.fields.type).trim() : null
  if (wantType && gotType && gotType !== wantType) {
    push('type-mismatch', `type=${gotType} 与位置不符（应为 ${wantType}）`)
  }
  if (wantType && !gotType) push('type-mismatch', `缺 type（位置要求 ${wantType}）`)

  // source_files：格式 + 存在性 + 证据来源
  const sources = Array.isArray(fm.fields.source_files)
    ? fm.fields.source_files.map((s) => String(s).trim()).filter(Boolean)
    : (fm.fields.source_files ? [String(fm.fields.source_files).trim()] : [])
  for (const s of sources) {
    if (!isRepoRelativeFile(s)) push('bad-source', `source_files 不是仓库相对文件路径：${s}`)
  }
  if (Array.isArray(readableSources) && sources.length) {
    const readable = new Set(readableSources.map((s) => String(s).replace(/\\/g, '/')))
    const notEvidence = sources.filter((s) => !readable.has(s))
    if (notEvidence.length) {
      push('source-not-evidence', `source_files 有 ${notEvidence.length} 个不在本次读取的证据里：${notEvidence.slice(0, 5).join('、')}`)
    }
  }
  if (typeof fsImpl?.exists === 'function' && cwd) {
    const missing = sources.filter((s) => !fsImpl.exists(path.posix.join(String(cwd).replace(/\\/g, '/'), s)))
    if (missing.length) push('missing-source', `source_files 指向不存在的文件：${missing.slice(0, 5).join('、')}`)
  }

  // 正文
  const body = fm.body ?? ''
  if (!body.trim()) push('empty-body', 'frontmatter 之后没有正文')
  if (hasDuplicateFrontmatter(body)) push('duplicate-frontmatter', '正文里又出现了一份 frontmatter（疑似重复贴头）')
  const fences = fencesBalanced(body)
  if (!fences.balanced) push('unclosed-fence', `代码围栏未闭合（${fences.count} 个围栏标记）`)

  // 章节：必需章节存在且非空；任何出现的章节都不能是空的
  const sections = extractSections(body)
  const byTitle = new Map()
  const dupSections = []
  for (const s of sections) {
    if (byTitle.has(s.title)) dupSections.push(s.title)
    byTitle.set(s.title, s)
  }
  if (dupSections.length) push('duplicate-section', `重复章节：${[...new Set(dupSections)].slice(0, 5).join('、')}`)
  const required = REQUIRED_SECTIONS[wantType] ?? []
  for (const title of required) {
    const s = byTitle.get(title)
    if (!s) { push('missing-section', `缺必需章节 ${title}`); continue }
    if (!s.content.trim()) push('empty-section', `必需章节 ${title} 是空的`)
  }
  for (const s of sections) {
    if (s.content.trim()) continue
    if (required.includes(s.title)) continue // 已单独报过
    push('empty-section-optional', `章节 ${s.title} 是空的`)
  }

  // 内部链接：目标必须存在
  if (Array.isArray(allowedLinks)) {
    const allowed = new Set(allowedLinks.map((s) => String(s).replace(/\\/g, '/')))
    const baseDir = articlePath ? path.posix.dirname(String(articlePath).replace(/\\/g, '/')) : '.'
    const dead = []
    for (const t of collectWikiLinks(body)) {
      const candidates = [t, `${t}.md`, path.posix.normalize(path.posix.join(baseDir, t)), path.posix.normalize(path.posix.join(baseDir, `${t}.md`))]
      if (!candidates.some((c) => allowed.has(c))) dead.push(t)
    }
    if (dead.length) push('dead-link', `内部链接目标不存在：${dead.slice(0, 5).join('、')}`)
  }

  return issues
}

// 便捷包装：把 issues 压成一行人类可读文案（null 表示通过）
export function issueSummary(issues) {
  if (!issues?.length) return null
  const first = issues[0]
  const more = issues.length > 1 ? `（共 ${issues.length} 项）` : ''
  return `文章契约未通过：${first.detail}${more}`
}

// 硬拒写判据：只有 error 级才拦落盘。warning 级放行但记账，由终态判定降为 partial。
export function hasBlockingIssue(issues) {
  return (issues ?? []).some((i) => (i.severity ?? 'error') === 'error')
}

// 允许写入的路径集合（agentic 工具的 allowedWritePaths 闸门）。
// 返回 null 表示调用方没设限（不检查）；返回 Set 表示只允许这些路径。
export function makeWriteSet(paths) {
  if (!Array.isArray(paths)) return null
  return new Set(paths.map((p) => normalizeWritePath(p)).filter(Boolean))
}

export function normalizeWritePath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').trim()
  if (!s) return null
  return path.posix.normalize(s)
}

// 判定某个写入目标是否在写集内。写集按「规范化后的 POSIX 路径」比对；
// 相对路径以 cwd 为基准解析后比对，避免 `../` 越界写到别的仓库。
export function isWritable(target, writeSet, { cwd = null } = {}) {
  if (!writeSet) return true
  const norm = normalizeWritePath(target)
  if (!norm) return false
  if (writeSet.has(norm)) return true
  if (cwd) {
    const absTarget = normalizeWritePath(path.resolve(cwd, norm))
    for (const w of writeSet) {
      const absW = normalizeWritePath(path.resolve(cwd, w))
      if (absTarget === absW) return true
    }
  }
  return false
}
