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
import { mapFsoftOutput, moduleSlug, WIKI_ENTRY } from './mapping.js'
import { stripCode } from '../article-contract.js'
import { toPosix as posix } from '../git-paths.js'

// 校验能报出的问题类别。稳定、可机读，上层按 kind 分派（不要靠 message 文本匹配）。
// 根页在文章正文里的历史别名：上游把入口页写成 README.md / overview.md，本仓库叫 CodeWiki.md。
// 只用于「链接是否指向根页」的判定，不改变产出文件名。
const ROOT_PAGE_ALIASES = new Set(['README.md', 'overview.md'])
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
  // 代码里的 `[文字](x.md)` 是语法示例，不是引用。本仓库自己的文章就在讲链接形态，
  // 真机 job-mw32wsci-h 因此把 `[文字](x.md)` 判成死链、整轮从 done 掉成 partial。
  // stripCode 做等长替换，所以匹配偏移仍与原文一一对应。
  const src = stripCode(String(text ?? ''))
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
 * @param {string} [options.repoRoot] 给了才校验组件 id 推导出的路径是否还存在
 */
export function buildWritePlan({ docsDir, componentFiles = {}, overviewName = 'overview.md', repoRoot = null } = {}) {
  const collected = collectOutput({ docsDir })
  const mapped = mapFsoftOutput({
    pages: collected.pages,
    moduleTree: collected.json.moduleTree ?? {},
    componentFiles,
    metadata: collected.json.metadata ?? {},
    updateRecord: collected.json.updateRecord,
    overviewName,
    fileExists: repoRoot ? (rel) => fs.existsSync(path.join(repoRoot, rel)) : null,
  })
  return { collected, mapped }
}

/**
 * 引擎页名的别名表：正文里可能写的页名 → 真实页（docs 内相对路径）。
 *
 * 引擎给自己的页文件命名用的是三条固定约定，而正文里的跨页链接写的是「模块名」，
 * 两者对不上时链接看起来像死链，其实是同一页：
 *   1. 模块名带扩展名时页名保留扩展名：`X.ts.md`，正文常写成 `X.md`；
 *   2. 子模块页会加上父模块前缀：`<dir>/<dir>_Y.md`，正文常写成 `<dir>/Y.md`。
 *   3. 落地文件名是模块名的 kebab-case：`llama_and_llm_management.md` 落地成
 *      `llama-and-llm-management.md`（mapping.js 的 moduleSlug），正文常写下划线原名。
 *
 * 只在**唯一**命中时给出别名：同一目录里同时有 `X.ts.md` 与 `X.js.md` 时无法判定
 * `X.md` 指哪一篇，猜一个会把「链接断了」静默改写成「连接到另一篇」，比报死链更糟。
 * 名字只是相近（如 `client_interface_layer.md` 与 `worktree_client_interface_layer.md`）
 * 不构成别名——那是上游真的写了不存在的页，必须如实报出来。
 *
 * @param {string[]} pages docs 内相对路径（POSIX）
 * @returns {Map<string,string>}
 */
export function pageAliases(pages) {
  const list = (Array.isArray(pages) ? pages : []).map((p) => posix(p)).filter(Boolean)
  const real = new Set(list)
  const candidates = new Map()
  const add = (alias, page) => {
    // 别名与真实页同名时以真实页为准，不必也不该覆盖
    if (real.has(alias)) return
    if (!candidates.has(alias)) candidates.set(alias, new Set())
    candidates.get(alias).add(page)
  }
  for (const page of list) {
    const dirName = posix(path.posix.dirname(page))
    const dir = dirName === '.' ? '' : dirName
    const base = posix(path.posix.basename(page))
    const stem = base.replace(/\.md$/i, '')
    const inDir = (name) => (dir ? `${dir}/${name}` : name)
    const dot = stem.lastIndexOf('.')
    if (dot > 0) add(inDir(`${stem.slice(0, dot)}.md`), page)
    const slug = moduleSlug(stem)
    if (slug && slug !== stem) add(inDir(`${slug}.md`), page)
    if (dir) {
      const parent = posix(path.posix.basename(dir))
      if (parent && stem.startsWith(`${parent}_`) && stem.length > parent.length + 1) {
        add(`${dir}/${stem.slice(parent.length + 1)}.md`, page)
      }
    }
  }
  const out = new Map()
  for (const [alias, pages2] of candidates) {
    if (pages2.size === 1) out.set(alias, [...pages2][0])
  }
  return out
}

/**
 * overview 正文里指向 docs 内不存在页面的链接。
 *
 * 上游 `reusable_overview()` 只判「空页 / 未完成的 reading preamble」，链接正确性不在
 * 判据里；聚类重构后模块改名，旧 overview 的链接会指向已经消失的页，引擎却每轮都
 * 判它「可复用」而跳过重建。真机 dsh-git-worktree 的 overview 有 6 条指向树外模块的
 * 链接，Git 史证明那些页在上一版聚类里真实存在过，此后再没被重建。
 *
 * 判据可证伪：每个 .md 链接目标都要落在当前页集合里（含 pageAliases 认的命名别名）。
 */
export function overviewStaleLinks({ overviewText = '', pages = [], moduleTree = {} } = {}) {
  const tree = moduleTree && typeof moduleTree === 'object' ? moduleTree : {}
  // whole-repository 模式没有权威模块名，判不出对错，不能凭猜测删页
  if (Object.keys(tree).length === 0) return []
  const pageSet = new Set((Array.isArray(pages) ? pages : []).map(posix))
  const aliases = pageAliases([...pageSet])
  const out = []
  for (const target of relativeLinks(overviewText)) {
    if (!/\.md$/i.test(target)) continue
    const resolved = posix(path.posix.normalize(target.replace(/^\.\//, '')))
    if (resolved.startsWith('../')) continue
    if (pageSet.has(resolved)) continue
    if (aliases.has(resolved)) continue
    out.push(resolved)
  }
  return out
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
  const { collected, mapped } = buildWritePlan({ docsDir, componentFiles, overviewName, repoRoot })
  const problems = [...collected.problems]
  const push = (kind, detail, extra = {}) => {
    if (!PROBLEM_SET.has(kind)) throw new Error(`validateOutput: 未登记的问题类别 ${kind}`)
    problems.push({ kind, detail, ...extra })
  }

  if (!collected.exists) {
    return { ok: false, problems, mapped, collected, stats: emptyStats() }
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
  // 链接命中判定：只认「本次真的会落地」的页。两种写法都合法——
  //   a) 引擎原始页名（正文原样写法，渲染期会被 rewritePageLinks 改成落地名）；
  //   b) 落地页名（正文里已经写成 slug 之后的名字）。
  // 落地目录是扁平的（.codewiki/modules/*.md 与根 CodeWiki.md），所以落地名按 basename 认。
  //
  // 这里曾经额外认 collected.pages（原始 docs 里存在的页名），于是「页在产物里、但没被
  // 映射进落地方案」被当成命中放过——那正是真死链：页面不会出现在 wiki 里。
  const plannedPages = new Set()
  if (mapped.entry) plannedPages.add(posix(mapped.entry.source))
  for (const a of mapped.articles) plannedPages.add(posix(a.source))
  const landedPages = new Set()
  if (mapped.entry) landedPages.add(posix(path.posix.basename(posix(mapped.entry.wikiPath))))
  for (const a of mapped.articles) landedPages.add(posix(path.posix.basename(posix(a.wikiPath))))
  // 引擎页名与正文写法不一致时（见 pageAliases），链接目标要按别名解析到真实页再判。
  const aliases = pageAliases(collected.pages)

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
      // 根页别名：上游 FSoft 把入口页叫 README.md / overview.md，本仓库的 wiki 入口是
      // CodeWiki.md。文章里写 [x](./README.md) 指的是同一个根页，不是死链——真机
      // job-mvzbcw87-0 就因为这条误报判了 partial。只豁免根目录下的这两个名字，
      // 子目录里的 README.md 仍然按真实目标校验。
      const rootAlias = ROOT_PAGE_ALIASES.has(resolved) ? WIKI_ENTRY : null
      const resolvedName = posix(path.posix.basename(resolved))
      // 别名只在「这个目标真的会有一页」时成立：命中后仍要按计划页/落地页判一次，
      // 否则会把「别名指向一篇没进落地方案的页」也放过，而那正是真死链。
      const aliased = aliases.get(resolved)
      const aliasHit = aliased != null && (plannedPages.has(aliased) || landedPages.has(posix(path.posix.basename(aliased))))
      // 根页别名（README.md / overview.md）指向的就是 wiki 入口，天然存在：入口缺页由
      // 单独的 entry-missing 缺陷负责，不该在这里再报一次死链——真机 testing_fixtures.md
      // 引用同属父模块的 ./README.md 就是这样被误判的。只认根目录下这两个名字，
      // sub/README.md 仍按真实目标校验。
      const hit = rootAlias != null
        || aliasHit
        || plannedPages.has(resolved)
        || landedPages.has(resolvedName)
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
    // collected 原样带出：上层（阶段 3 质量门）要读 metadata.generation_info.commit_id
    // 判「产物对应哪个 commit」。让它自己再读一遍 docs 目录，等于把「一次读」变成
    // 「两次读」，两次之间目录可能被改，判据就漂移了。新增字段不改既有语义。
    collected,
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
