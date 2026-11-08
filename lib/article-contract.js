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

import { scanPageLinks } from './engine/wiki-links.js'

// 目录 → 允许的 type（type 与目录不匹配时 cw index 的分类会错乱）
// learnings/decisions 本仓库 0.17.49 起不再产（手工维护通道下线），但 cw init 仍建这两个
// 目录、别的仓库里也可能有历史残留页，读取侧必须继续认它们。
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

// 原生引擎通道（FSoft）的固定检查口径。quality-gate 判「刚渲染出来的页」与
// apply-plan 判「库里躺着的存量页」必须是同一套，否则会出现「门说 defects=0、
// 存量体检说这篇坏了」这种自相矛盾同时挂在一个终态里。两处各写一遍时已经漂过一次，
// 所以放这里由两边共用（两边都已 import 本模块）。
//   · requiredSections: [] —— 原生正文的章节名由上游 prompt 决定（`## 1. Purpose`…），
//     用本仓库 agentic 通道的 Overview/Key Components 去判它，产出的全是不可修复的
//     warning（计划硬约束是「不改技术内容」），闸门会退化成噪声。
//   · allowEmptySourceFiles: true —— whole-repository 模式下 module_tree.json 就是 {}
//     （documentation_generator.py:241），空 source_files 是诚实记录，由上层降级成
//     partial 阻止基线推进，而不是在这里拒写。
//   · fsImpl: null —— source_files 的存在性由 output.js 的 source-missing 单独判，
//     这里再判一次只会把同一条缺陷翻倍上报。
export const NATIVE_ARTICLE_OPTS = Object.freeze({
  cwd: null,
  readableSources: null,
  fsImpl: null,
  requiredSections: Object.freeze([]),
  allowEmptySourceFiles: true,
})

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
  // 双引号标量在 YAML 里是**带转义序列**的形式（`"a\nb"`、`"C:\\src\\a.py"`），
  // 只切引号不还原转义会把值读成另一串字符——`title: "C:\\src\\a.py"` 读回成
  // `C:\\src\\a.py`（双反斜杠），与实际值不符。JSON 字符串字面量是合法 YAML 双引号
  // 标量（YAML 1.2 是 JSON 超集），所以能 JSON.parse 成功时就是权威解。失败则回退
  // 到旧的「切引号」——存量文章里可能有 YAML 专有转义（`\e`）JSON 不认，不能因此判坏。
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t) } catch { return t.slice(1, -1) }
  }
  if (t.startsWith("'") && t.endsWith("'")) {
    // 单引号标量里 `''` 是转义后的单引号（YAML 专有，JSON 没有）
    return t.slice(1, -1).replace(/''/g, "'")
  }
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
//
// 必须跳过代码：文章里写 `[[target]]`、`](xxx.md)` 往往是在**讲链接语法**，
// 它们是字面量而不是引用。不跳过就会得到「文档在解释契约、却被契约判违规」的荒谬
// 结论——真机 article_validation / plan_application / codewiki_vendor_binary 三篇都这
// 样被误判成 dead-link 拒写。这里先按行剥掉围栏块与行内代码，再收集链接。
export function collectWikiLinks(body) {
  const targets = new Set()
  const text = stripCode(String(body ?? ''))
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) targets.add(String(m[1]).trim())
  for (const m of scanPageLinks(text)) {
    const t = String(m.target).trim()
    if (!/^[a-z]+:/i.test(t)) targets.add(t)
  }
  return [...targets]
}

// 把围栏块与行内代码替换成**等长**占位，避免它们参与任何「正文语义」扫描。
// 等长是硬契约：rewritePageLinks 用它的匹配偏移回原文做替换，长度一变就会错位。
export function stripCode(text) {
  const src = String(text ?? '')
  const out = []
  const blank = (line) => ' '.repeat(line.length)
  let inFence = false
  let fenceMark = ''
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (!inFence && m) { inFence = true; fenceMark = m[1][0]; out.push(blank(line)); continue }
    if (inFence) {
      if (m && m[1][0] === fenceMark && line.trim().replace(/`|~/g, '').length === 0) inFence = false
      out.push(blank(line))
      continue
    }
    // 行内代码：`...` 成对出现时整段视为代码
    out.push(line.replace(/`[^`\n]*`/g, (seg) => ' '.repeat(seg.length)))
  }
  return out.join('\n')
}

// 正文里是否又出现了一份 frontmatter（重复正文/重复贴头的特征）
//
// 必须跳过代码围栏：文章里用 ```yaml 演示 frontmatter 契约是常见写法（真机上
// codewiki_vendor_binary.md 就是这样），围栏里的 --- / title: 是**示例**，不是文档自己的头。
// 不跳过会把刚写好的文章判成「重复贴头」，整轮编译凭空 partial。
export function hasDuplicateFrontmatter(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  let inFence = false
  let probe = null // 围栏外遇到的第一个 --- 的下标；遇到第二个 --- 时用它配对
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (line.trim() !== '---') continue
    if (probe == null) { probe = i; continue }
    // 后面 40 行内闭合成对，且中间出现 title:/type:/source_files 字段 → 又贴了一份头
    if (i - probe > 40) { probe = i; continue }
    const inner = lines.slice(probe + 1, i).join('\n')
    if (/^\s*(title|type|source_files)\s*:/m.test(inner)) return true
    probe = i
  }
  return false
}

// source_files 项的**格式**判据：只看字符串形态，不碰磁盘。
// 是否真的存在、是否是目录，由调用方传 fsImpl 时才判（见 missing-source / bad-source）。
function isRepoRelativeFile(p) {
  const s = String(p ?? '').trim()
  if (!s) return false
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false
  if (s.startsWith('../') || s.includes('/../')) return false
  // 尾斜杠是「这是目录」的显式写法。不能反过来用「有无扩展名」判文件：
  // Dockerfile / Makefile / LICENSE 是合法文件名，按扩展名判会把它们全判成 bad-source。
  if (s.endsWith('/')) return false
  return true
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
    // 章节要求覆盖：原生引擎通道（FSoft）的正文由上游 prompt 决定，章节名是它自己的
    // （`## Introduction and Purpose` / `## 1. Purpose` …），不是本仓库 agentic 通道
    // 的 `## Overview` / `## Key Components`。用默认表去判它，等于给一个我们**被禁止
    // 手改**的正文判死刑（计划硬约束「不改技术内容」），每条都是不可修复的 warning，
    // 于是真实产物永远 partial —— 闸门退化成噪声。所以允许调用方显式给出该通道的
    // 章节要求；传 [] 表示只查「结构完整」不查章节名（原生通道自己另判非空章节数）。
    // 默认仍是 REQUIRED_SECTIONS，既有通道行为一字不变。
    requiredSections = null,
    // 空 source_files 是否合法：默认不合法（0.14.0 语义——文章没有代码依据必须拒）。
    // 原生 whole-repository 通道是唯一例外：FSoft 在该模式下 module_tree.json 就是 {}
    // （documentation_generator.py:241），页没有任何归属证据可查，空 source_files 是
    // **诚实记录**而不是编造。若按默认判 error 拒写，整棵真实产物一篇都进不了 wiki，
    // 结果只会逼后来的人绕过闸门。调用方显式开启后，空 source_files 由上层判 partial
    // （证据降级，阻止基线推进）而不是在这里拒写。
    allowEmptySourceFiles = false,
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
    // allowEmptySourceFiles 只对 source_files 这一项放行空列表；其余必填字段照拒。
    const emptyOk = f === 'source_files' && allowEmptySourceFiles
    const isEmpty = v === undefined || v === null || (Array.isArray(v) && v.length === 0) || String(v).trim() === ''
    if (isEmpty && !emptyOk) {
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
    const base = String(cwd).replace(/\\/g, '/')
    const missing = []
    const dirs = []
    for (const s of sources) {
      const abs = path.posix.join(base, s)
      if (!fsImpl.exists(abs)) { missing.push(s); continue }
      // 只有 exists 判不出 `src/util` 这种不带尾斜杠的目录——它在格式上完全合法。
      // isDirectory 由调用方按能力提供（不提供就只做存在性判定）。
      if (typeof fsImpl.isDirectory === 'function' && fsImpl.isDirectory(abs)) dirs.push(s)
    }
    if (dirs.length) push('bad-source', `source_files 指向目录：${dirs.slice(0, 5).join('、')}`)
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
  const required = requiredSections ?? (REQUIRED_SECTIONS[wantType] ?? [])
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
