// 阶段 2：FSoft 产物 → cw 写集的解析、校验与转换。
//
// 这一层刻意只做三件事，且三件事都必须可被测试逐条钉死：
//   1. **读**：把 docs 目录读成结构化事实（页清单 + 四个 JSON），坏文件变成 problem 而不是异常；
//   2. **映射**：交给 mapping.js（阶段 0 已冻结的四条硬规则），这里不重复实现任何规则；
//   3. **校验**：把「能不能算成功」判成可机读的 problems 列表。
//
// 绝不在这里做的事（这是迁移的安全边界，写下来防止它长成第二个引擎）：
//   · 不重新聚类、不做图 diff、不改写文章正文——FSoft 已经算完了；
//   · 不臆造 source_files（沿用 mapping.js 的证据规则）；
//   · 不因为「产物看起来差不多」就把 problem 降级成 warning。缺页就是缺页，
//     上层据此判 partial；把缺失静默吞掉会让 wiki 少一篇而没人知道。
//
// 与阶段 3 的分界：这里只判「产物自身是否自洽」（页在不在、正文空不空、链接指向的
// 东西在不在计划内）。frontmatter/锚点/写集冲突这类**目标格式**的闸门属于阶段 3。

import fs from 'node:fs'
import path from 'node:path'
import { mapFsoftOutput } from './mapping.js'

// 校验能报出的问题类别。稳定、可机读，上层按 kind 分派（不要靠 message 文本匹配）。
export const OUTPUT_PROBLEM_KINDS = Object.freeze([
  'missing-docs-dir',   // 引擎没产出 docs 目录
  'missing-metadata',   // 缺 metadata.json（无法确定 commit/layout）
  'missing-module-tree',// 缺 module_tree.json（无法确定归属与 source_files）
  'empty-module-tree',  // module_tree.json 是 {}：归属证据缺失，写集只能算 unattributed
  'bad-json',           // JSON 存在但不可解析
  'entry-missing',      // 没有 overview.md，即没有 CodeWiki.md 入口
  'empty-body',         // 页面除标题外没有正文
  'article-missing',    // 模块树里有模块，但没有对应页
  'unmapped-page',      // 页在 docs 里，但映射不到 wiki 的任何位置
  'source-missing',     // source_files 指向的文件在仓库里不存在
  'dead-link',          // 正文里的相对链接指向计划外的文件
])

const PROBLEM_SET = new Set(OUTPUT_PROBLEM_KINDS)

const posix = (p) => String(p ?? '').replace(/\\/g, '/')
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

// docs 下所有 markdown 页（递归，POSIX 相对路径，已排序）。
// 跳过 temp/（工作文件：依赖图、引用索引、artifact 索引）与隐藏目录。
const TEMP_DIR = 'temp'
function listMarkdownPages(rootDir, rel = '') {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(path.join(rootDir, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === TEMP_DIR) continue
      out.push(...listMarkdownPages(rootDir, childRel))
      continue
    }
    if (e.isFile() && /\.md$/i.test(e.name)) out.push(childRel)
  }
  return out.sort()
}

function readJsonIfExists(file, problems, kind, { optional = false } = {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    // 可选文件缺失不是问题（全量首轮本来就没有 update_record）；必需文件缺失才报
    if (err.code !== 'ENOENT' || !optional) {
      problems.push({ kind, detail: `${path.basename(file)} ${err.code === 'ENOENT' ? '缺失' : `不可读：${err.message}`}` })
    }
    return null
  }
  try {
    return JSON.parse(stripBom(text))
  } catch (err) {
    // 存在但坏了永远要报：引擎写坏了东西，不能因为「文件可选」就吞掉
    problems.push({ kind: 'bad-json', detail: `${path.basename(file)} 不是合法 JSON：${err.message}` })
    return null
  }
}

/**
 * 读 docs 目录，产出结构化事实。只读、不抛（坏输入变成 problems）。
 *
 * @param {object} options
 * @param {string} options.docsDir 引擎产出的 docs 目录
 * @returns {{docsDir:string, exists:boolean, pages:string[], json:object, problems:object[]}}
 */
export function collectOutput({ docsDir } = {}) {
  const dir = String(docsDir ?? '')
  const problems = []
  const out = {
    docsDir: dir,
    exists: false,
    pages: [],
    json: { metadata: null, moduleTree: null, firstModuleTree: null, updateRecord: null },
    problems,
  }
  if (!dir) {
    problems.push({ kind: 'missing-docs-dir', detail: '未提供 docsDir' })
    return out
  }
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    problems.push({ kind: 'missing-docs-dir', detail: `${dir} 不可读：${err.code ?? err.message}` })
    return out
  }
  out.exists = true
  // 页 = docs 下的 markdown，**递归**收集：hierarchical 布局把子模块页放在
  // 子目录里（doc_layout.py:module_doc_relpath → posixpath.join(*path[:-1], name.md)），
  // 只扫根目录会把整棵子树的页漏掉。temp/ 是工作目录（依赖图/索引），不算页。
  out.pages = listMarkdownPages(dir)

  out.json.metadata = readJsonIfExists(path.join(dir, 'metadata.json'), problems, 'missing-metadata')
  out.json.moduleTree = readJsonIfExists(path.join(dir, 'module_tree.json'), problems, 'missing-module-tree')
  // 这两个是可选产物：全量首轮没有 update_record，first_module_tree 只在增量里有意义
  out.json.firstModuleTree = readJsonIfExists(path.join(dir, 'first_module_tree.json'), problems, 'bad-json', { optional: true })
  out.json.updateRecord = readJsonIfExists(path.join(dir, 'update_record.json'), problems, 'bad-json', { optional: true })
  return out
}

// 去掉标题行与空白后剩余的正文字符数。用来判「这页其实只有个标题」。
export function bodyLength(text) {
  const lines = stripBom(String(text ?? '')).split(/\r?\n/)
  let seenHeading = false
  const body = []
  for (const line of lines) {
    const t = line.trim()
    if (!seenHeading && /^#{1,6}\s/.test(t)) { seenHeading = true; continue }
    body.push(line)
  }
  return body.join('\n').replace(/\s+/g, '').length
}

// 收集页面正文里的相对 markdown 链接目标（跳过外链、锚点、图片 data URI）。
export function relativeLinks(text) {
  const out = []
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m
  const src = String(text ?? '')
  while ((m = re.exec(src))) {
    const target = m[1]
    if (!target || target.startsWith('#')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http: mailto: data: …
    out.push(target.replace(/\\/g, '/'))
  }
  return out
}

/**
 * 建写集计划：读 docs → 交给 mapping.js。纯函数之外只多一次目录读。
 *
 * @param {object} options
 * @param {string} options.docsDir
 * @param {object} [options.componentFiles] 组件 id → 仓库相对文件（source_files 的证据）
 * @param {string} [options.overviewName]
 */
export function buildWritePlan({ docsDir, componentFiles = {}, overviewName = 'overview.md' } = {}) {
  const collected = collectOutput({ docsDir })
  const mapped = mapFsoftOutput({
    pages: collected.pages,
    moduleTree: collected.json.moduleTree ?? {},
    componentFiles,
    metadata: collected.json.metadata ?? {},
    updateRecord: collected.json.updateRecord,
    overviewName,
  })
  return { collected, mapped }
}

/**
 * 校验产物自洽性。返回 {ok, problems, mapped, stats}——**不抛**，也不修任何东西。
 *
 * @param {object} options
 * @param {string} options.docsDir
 * @param {string} [options.repoRoot] 用于 source_files 存在性检查（不给则跳过该项）
 * @param {object} [options.componentFiles]
 * @param {string} [options.overviewName]
 */
export function validateOutput({ docsDir, repoRoot, componentFiles = {}, overviewName = 'overview.md' } = {}) {
  const { collected, mapped } = buildWritePlan({ docsDir, componentFiles, overviewName })
  const problems = [...collected.problems]
  const push = (kind, detail, extra = {}) => {
    if (!PROBLEM_SET.has(kind)) throw new Error(`validateOutput: 未登记的问题类别 ${kind}`)
    problems.push({ kind, detail, ...extra })
  }

  if (!collected.exists) {
    return { ok: false, problems, mapped, stats: emptyStats() }
  }

  // 1. 入口：没有 overview 就没有 CodeWiki.md，等于这次产出不能用
  if (!mapped.entry) push('entry-missing', `docs 下没有 ${overviewName}`)

  // 1b. 空模块树：whole-repository 模式下这是引擎的正常行为，但它意味着**归属证据
  //     整体缺失**——写集里的页没有 source_files，增量 ownership 无从判定。
  //     这不是致命错（页是真的，照写），但也不能算「完整成功」，必须让上层看见。
  const treeObj = collected.json.moduleTree
  const treeIsEmpty = treeObj && typeof treeObj === 'object' && Object.keys(treeObj).length === 0
  if (treeIsEmpty && collected.pages.length > 1) {
    push('empty-module-tree',
      'module_tree.json 为空对象：模块页无归属证据，source_files 全部为空（whole-repository 模式的正常产物，但增量归属不可用）')
  }

  // 2. 每篇文章：正文非空（只有标题的页写进 wiki 就是空壳）
  const plannedPages = new Set()
  if (mapped.entry) plannedPages.add(posix(mapped.entry.source))
  for (const a of mapped.articles) plannedPages.add(posix(a.source))

  const bodies = new Map()
  for (const rel of collected.pages) {
    let text
    try {
      text = fs.readFileSync(path.join(docsDir, rel), 'utf8')
    } catch (err) {
      push('bad-json', `${rel} 不可读：${err.code ?? err.message}`)
      continue
    }
    bodies.set(rel, text)
    if (bodyLength(text) === 0) push('empty-body', `${rel} 除标题外没有正文`, { source: rel })
  }

  // 3. 未映射页：映射不到就是 wiki 少一篇，必须报
  for (const u of mapped.unmapped) push('unmapped-page', u.reason, { source: u.source })

  // 4. 模块树里有、但没产出页：mapping 已经在 warnings 里报了事实，这里升级成 problem
  for (const w of mapped.warnings) {
    if (/未产出/.test(w)) push('article-missing', w)
  }

  // 5. source_files 必须真实存在（编造会让增量 ownership 静默错位）
  if (repoRoot) {
    for (const a of mapped.articles) {
      for (const rel of a.sourceFiles) {
        const abs = path.resolve(repoRoot, rel)
        if (!fs.existsSync(abs)) {
          push('source-missing', `${a.moduleName} 的 source_files 指向不存在的文件：${rel}`, {
            source: a.source,
            target: rel,
          })
        }
      }
    }
  }

  // 6. 死链：只查「指向 docs 内相对路径」的链接——目标既不在计划内、也不在 docs 里就是死链。
  //    不查 http 外链（网络不是本层的责任）。
  for (const [rel, text] of bodies) {
    for (const target of relativeLinks(text)) {
      const base = posix(path.posix.dirname(posix(rel)))
      const resolved = posix(path.posix.normalize(path.posix.join(base === '.' ? '' : base, target))).replace(/^\.\//, '')
      if (!resolved) continue
      // 链接到仓库源文件（../src/x.py）不在 docs 内，交给阶段 3 的 source 校验；这里只查 docs 内的
      if (resolved.startsWith('../')) continue
      const hit = plannedPages.has(resolved) || collected.pages.includes(resolved)
      if (!hit && !collected.json.metadata && !/\.md$/i.test(resolved)) continue
      if (!hit && /\.md$/i.test(resolved)) {
        push('dead-link', `${rel} 链接到 ${resolved}，但该页不在本次产出里`, { source: rel, target: resolved })
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    mapped,
    stats: {
      pages: collected.pages.length,
      articles: mapped.articles.length,
      unmapped: mapped.unmapped.length,
      problems: problems.length,
    },
  }
}

function emptyStats() {
  return { pages: 0, articles: 0, unmapped: 0, problems: 0 }
}

export default { OUTPUT_PROBLEM_KINDS, collectOutput, buildWritePlan, validateOutput, bodyLength, relativeLinks }
