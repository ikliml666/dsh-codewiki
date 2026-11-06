// FSoft 产物 → CodeWiki.md / .codewiki/ 的映射（阶段 0）。
//
// 这是迁移里唯一一处「格式翻译」，边界必须窄得能被完整读一遍：
// FSoft 原生引擎产出的是一棵 docs 树（overview.md + 模块页 + module_tree.json +
// metadata.json + update_record.json），而 cw 要的是仓库内 .codewiki/ 的五类文章 +
// 顶层 CodeWiki.md 入口。两边不是同一个模型：
//
//   FSoft overview.md          → CodeWiki.md（入口页，不是「文章」）
//   FSoft 模块页 {Name}.md      → .codewiki/modules/<slug>.md（type=module）
//   FSoft module_tree.json     → 只作 source_files 的证据来源，不落盘（.codewiki 无此类型）
//   FSoft metadata.json        → .codewiki/_meta.yaml 的 last_compiled_commit/layout
//   FSoft update_record.json   → .codewiki/temp/update-record.json（原样搬运）
//   FSoft artifact 页          → 明确 pageKind=artifact 的模块页（不冒充业务模块）
//   FSoft 父模块页             → pageKind=parent（有 children），仍 type=module
//
// 硬规则（迁移安全边界）：
//   1. **不臆造 source_files**。source_files 只能来自真实组件→文件证据
//      （componentFiles / module_tree.components），拿不到就是空数组 + warning，
//      绝不按目录名猜——0.14.0 的闸门正是靠 source_files 判定增量归属，
//      编造它会让未消化的变化被静默基线化。
//   2. **不静默丢弃**。任何没被映射的页都进 unmapped，带可机读原因，
//      由上层决定 partial。滑掉的页等于 wiki 少一篇而没人知道。
//   3. **不覆盖**。slug 冲突（A_B 与 A-B 都 → a-b）时两页都进 unmapped，
//      不许后到的赢——静默覆盖会丢内容且无法回溯。
//   4. **不改技术内容**。这里只搬路径与类型，正文一字不动；FSoft 原始树另存，
//      规范化（organize_docs 的链接重写）在引擎侧完成。

import { ENGINE_CONTRACT_VERSION } from './contract.js'
import { toPosix as posix } from '../git-paths.js'

export const WIKI_ENTRY = 'CodeWiki.md'
export const WIKI_DIR = '.codewiki'
export const WIKI_META_REL = '.codewiki/_meta.yaml'
export const WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'
export const WIKI_MODULES_REL = '.codewiki/modules'

// 页面布局与上游 config.py 同一个词汇表（0.17.12 起对齐）:
//   LAYOUT_HIERARCHICAL — 页落在 <父模块路径>/<模块名>.md（上游 DEFAULT_LAYOUT）
//   LAYOUT_FLAT         — 页都落在 docs 根部 <模块名>.md
// 缺省按上游默认值处理：docs 里没有 metadata.layout 时上游就是 hierarchical。
export const LAYOUT_HIERARCHICAL = 'hierarchical'
export const LAYOUT_FLAT = 'flat'
export const OVERVIEW_FILENAME = 'overview.md'
export const OVERVIEW_STEM = 'overview'

// 模块名 → cw 惯用的 kebab-case 文件名（ASCII 保留，其它折叠成 '-'）。
// 与 cw 现有文章命名一致（core-application.md / git-and-ops-artifacts.md）。
export function moduleSlug(name) {
  return String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function normalizeSourceFiles(list) {
  const seen = new Set()
  const out = []
  for (const raw of list ?? []) {
    const p = posix(raw).replace(/^\.\//, '')
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

// 模块页的 source_files：只认组件→文件证据。组件 id 形如 `src/a.py::Class.method`，
// 取 `::` 前的文件部分；componentFiles 里没有该组件则不计入（宁缺勿造）。
//
// 从组件 id 推出来的路径还要过一遍 fileExists：module_tree 是引擎**增量合并**的产物
// （cluster_modules.py 把新子树并进旧树），删掉的文件不会从旧树里消失，组件 id 于是
// 可以长期指着已不存在的文件。照收就是让 source_files 带上死路径 → 每轮判
// source-missing → 终态恒 partial → 基线永不推进（真机上本仓库因此卡了 9 个提交）。
// componentFiles 的显式映射不受此限：那是调用方给的证据，指错了由 validateOutput
// 的 source-missing 如实报出来。
function sourceFilesOf(components, componentFiles, fileExists = null) {
  const files = []
  for (const cid of components ?? []) {
    const key = String(cid)
    const mapped = componentFiles?.[key]
    if (mapped) {
      files.push(mapped)
    } else if (key.includes('::')) {
      const rel = key.split('::')[0]
      if (fileExists && !fileExists(posix(rel))) continue
      files.push(rel)
    }
    // 无 :: 且无映射：不是文件级组件，跳过（不猜）
  }
  return normalizeSourceFiles(files)
}

// 页面 → 模块树节点。FSoft 的 module_tree 是 {name: {path, components, children}}，
// 顶层键即模块名；页名 {Name}.md 与顶层键同名。
function indexModuleTree(moduleTree) {
  const byName = new Map()
  const walk = (tree, parentChain) => {
    if (!tree || typeof tree !== 'object') return
    for (const [name, info] of Object.entries(tree)) {
      const node = info && typeof info === 'object' ? info : {}
      const children = node.children && typeof node.children === 'object' ? node.children : {}
      // modulePath 是**完整层级**（含自己），页的落地位置由它决定：上游
      // doc_layout.module_doc_relpath() 对 hierarchical 取 path[:-1] 作目录、
      // path[-1] 作文件名。只记名字会让「同一模块从上层搬到更深一层」看起来
      // 「页已存在」，把真实缺页漏掉（真机 dsh-git-worktree 就栽在这里）。
      const modulePath = [...parentChain, name]
      byName.set(name, {
        name,
        modulePath,
        path: posix(node.path ?? ''),
        components: Array.isArray(node.components) ? node.components : [],
        hasChildren: Object.keys(children).length > 0,
        artifact: Boolean(node.artifact) || /^artifacts?$/i.test(name),
        parent: parentChain.length ? parentChain[parentChain.length - 1] : null,
      })
      if (Object.keys(children).length) walk(children, modulePath)
    }
  }
  walk(moduleTree, [])
  return byName
}

// 把 FSoft 的 docs 树映射成 cw 的写集描述。纯函数：不读写文件、不 spawn。
//
// 入参：
//   pages          — 引擎产出的页相对路径列表（POSIX，相对 docs 根）
//   moduleTree     — FSoft module_tree.json 内容（可为空对象）
//   componentFiles — {组件id: 仓库相对文件}，source_files 的唯一证据来源
//   metadata       — FSoft metadata.json 内容（generation_info 取 commit/layout/language）
//   updateRecord   — 可选：FSoft update_record.json 内容
//   overviewName   — 可选：overview 页文件名（默认 overview.md）
//   fileExists     — 可选：仓库相对路径 → 是否存在。给了就丢掉组件 id 里指向
//                    已删除文件的路径（陈旧模块树的死组件），不给则全收。
//
// 出参（可 JSON 序列化，带 contractVersion）：
//   entry       — {path: CodeWiki.md, source} 或 null
//   articles    — [{source, wikiPath, type, pageKind, moduleName, sourceFiles, warnings}]
//   unmapped    — [{source, reason}]
//   meta        — {lastCompiledCommit, layout, language}
//   updateRecord— {path, outcome, pagesWritten, pagesRemoved, source} 或 null
//   warnings    — 全局告警（未映射页数等）
export function mapFsoftOutput({
  pages = [],
  moduleTree = {},
  componentFiles = {},
  metadata = {},
  updateRecord = null,
  overviewName = 'overview.md',
  fileExists = null,
} = {}) {
  const pageList = (Array.isArray(pages) ? pages : []).map(posix)
  const tree = indexModuleTree(moduleTree)
  const gen = metadata?.generation_info && typeof metadata.generation_info === 'object'
    ? metadata.generation_info
    : {}

  const articles = []
  const unmapped = []
  const warnings = []
  const usedSlug = new Map() // slug → 首个占用的页（冲突检测）
  let entry = null

  for (const page of pageList) {
    if (page === overviewName) {
      // 入口页只允许一个；重复出现（不同路径同名）时后到的进 unmapped
      if (entry) {
        unmapped.push({ source: page, reason: 'overview 页重复（入口只能一个）' })
        continue
      }
      entry = { path: WIKI_ENTRY, source: page }
      continue
    }

    const base = page.split('/').pop() ?? ''
    const stem = base.replace(/\.md$/i, '')
    if (!/\.md$/i.test(base)) {
      unmapped.push({ source: page, reason: '非 markdown 页，不属于文章' })
      continue
    }
    const node = tree.get(stem)
    if (!node && tree.size === 0) {
      // whole-repository 模式下 module_tree.json 就是 `{}`（documentation_generator.py:241
      // 原文 "stays {} in whole-repository mode"），而 agent 仍然写了自己的页。
      // 这时「页名不在模块树里」不等于孤儿页：页是真产物，必须进写集，
      // 但没有任何归属证据 → source_files 留空 + attribution=unattributed + warning。
      // 硬给 source_files 才是错的（会伪造增量 ownership）；丢掉页更错（wiki 少一篇）。
      const slug = moduleSlug(stem)
      if (!slug) {
        unmapped.push({ source: page, reason: '模块名无法规范化为文件名' })
        continue
      }
      const wikiPath = `${WIKI_MODULES_REL}/${slug}.md`
      if (usedSlug.has(wikiPath)) {
        unmapped.push({ source: page, reason: `文件名冲突：与 ${usedSlug.get(wikiPath)} 都规范化为 ${slug}.md` })
        const prev = usedSlug.get(wikiPath)
        const prevIdx = articles.findIndex((a) => a.source === prev)
        if (prevIdx >= 0) {
          unmapped.push({ source: articles[prevIdx].source, reason: `文件名冲突：与 ${page} 都规范化为 ${slug}.md` })
          articles.splice(prevIdx, 1)
          usedSlug.delete(wikiPath)
        }
        continue
      }
      usedSlug.set(wikiPath, page)
      articles.push({
        source: page,
        wikiPath,
        type: 'module',
        pageKind: 'leaf',
        moduleName: stem,
        sourceFiles: [],
        attribution: 'unattributed',
        warnings: ['模块树为空，无法确定该页的归属与 source_files（未臆造，按空处理）'],
      })
      continue
    }
    if (!node) {
      unmapped.push({ source: page, reason: '页名在模块树中不存在（无法确定归属与 source_files）' })
      continue
    }

    const slug = moduleSlug(stem)
    if (!slug) {
      unmapped.push({ source: page, reason: '模块名无法规范化为文件名' })
      continue
    }
    const wikiPath = `${WIKI_MODULES_REL}/${slug}.md`
    if (usedSlug.has(wikiPath)) {
      // 冲突：两个不同模块名规范化到同一文件名。两页都不写（否则会覆盖丢内容）
      unmapped.push({ source: page, reason: `文件名冲突：与 ${usedSlug.get(wikiPath)} 都规范化为 ${slug}.md` })
      const prev = usedSlug.get(wikiPath)
      const prevIdx = articles.findIndex((a) => a.source === prev)
      if (prevIdx >= 0) {
        unmapped.push({ source: articles[prevIdx].source, reason: `文件名冲突：与 ${page} 都规范化为 ${slug}.md` })
        articles.splice(prevIdx, 1)
        usedSlug.delete(wikiPath)
      }
      continue
    }

    const sourceFiles = sourceFilesOf(node.components, componentFiles, fileExists)
    const pageWarnings = []
    if (node.components.length && !sourceFiles.length) {
      pageWarnings.push('组件的 source_files 无真实映射证据（未臆造，按空处理）')
    }
    if (!node.components.length) {
      pageWarnings.push('模块无组件，source_files 为空')
    }
    usedSlug.set(wikiPath, page)
    articles.push({
      source: page,
      wikiPath,
      type: 'module',
      pageKind: node.artifact ? 'artifact' : (node.hasChildren ? 'parent' : 'leaf'),
      moduleName: stem,
      sourceFiles,
      attribution: 'attributed',
      warnings: pageWarnings,
    })
  }

  // 模块树里有、但引擎没产出页的模块 → 由上层决定 partial（这里只报事实）
  for (const [name] of tree) {
    const expected = `${name}.md`
    if (pageList.includes(expected)) continue
    // hierarchical 布局下页可能在子目录里：按 basename 再比一次
    if (pageList.some((p) => p.split('/').pop() === expected)) continue
    if (entry && entry.source === overviewName && name === 'overview') continue
    warnings.push(`模块树含 ${name}，但未产出 ${expected}（该模块文章缺失）`)
  }

  let record = null
  if (updateRecord && typeof updateRecord === 'object') {
    record = {
      path: WIKI_UPDATE_RECORD_REL,
      outcome: String(updateRecord.outcome ?? ''),
      pagesWritten: Array.isArray(updateRecord.pages_written) ? updateRecord.pages_written.map(posix) : [],
      pagesRemoved: Array.isArray(updateRecord.pages_removed) ? updateRecord.pages_removed.map(posix) : [],
      source: 'incremental',
    }
  }

  return {
    contractVersion: ENGINE_CONTRACT_VERSION,
    entry,
    articles,
    unmapped,
    meta: {
      lastCompiledCommit: String(gen.commit_id ?? ''),
      layout: String(gen.layout ?? ''),
      language: String(gen.language ?? ''),
    },
    updateRecord: record,
    warnings,
  }
}

// 页在 docs 里的应有相对路径（POSIX）。与上游 doc_layout.module_doc_relpath()
// 同一口径：hierarchical 是 <父路径...>/<模块名>.md，flat 是 <模块名>.md。
export function moduleDocRelPath(modulePath, layout = LAYOUT_HIERARCHICAL) {
  const parts = (Array.isArray(modulePath) ? modulePath : []).filter(Boolean)
  if (parts.length === 0) return OVERVIEW_FILENAME
  if (normalizeLayout(layout) === LAYOUT_FLAT) return `${parts[parts.length - 1]}.md`
  return [...parts.slice(0, -1), `${parts[parts.length - 1]}.md`].join('/')
}

function normalizeLayout(layout) {
  return String(layout ?? '').trim() === LAYOUT_FLAT ? LAYOUT_FLAT : LAYOUT_HIERARCHICAL
}

// 树里的模块在 docs 里有没有页。与上游 find_doc() 一样先看层级路径、
// 再看根部同名文件；但**不接受其它目录下的同名页**——那是模块搬家后遗留的
// 旧页，算缺页才是修复性全量要处理的事（放宽它等于把 partial 伪装成 done）。
function hasPageForModule(tree, name, pageSet) {
  const node = tree.get(name)
  const primary = moduleDocRelPath(node?.modulePath ?? [name])
  if (pageSet.has(primary)) return true
  return pageSet.has(`${name}.md`)
}

// 检查模块树中的模块是否都有对应页面（用于增量轮决议时判断是否需要修复）
export function findMissingModuleDocs({
  pages = [],
  moduleTree = {},
  overviewName = OVERVIEW_FILENAME,
} = {}) {
  const pageSet = new Set((Array.isArray(pages) ? pages : []).map(posix))
  const tree = indexModuleTree(moduleTree)
  const missing = []
  for (const [name] of tree) {
    if (name === OVERVIEW_STEM && pageSet.has(overviewName)) continue
    if (hasPageForModule(tree, name, pageSet)) continue
    missing.push(name)
  }
  return missing
}

// 产物目录里不属于当前模块树的页面（模块名改过、聚类重建后留下的旧页）。
// 修复性全量必须先把它们清掉：否则引擎写完全部新页，旧页仍在 docsDir 里被映射成
// `unmapped-page`，质量门每轮照样判 partial——这正是「缺页修好了但还是 partial」。
// 只删 docsDir（仓库外的临时产物目录），已提交的 wiki 页由落地器按写集处理。
export function staleDocPages({
  pages = [],
  moduleTree = {},
  overviewName = OVERVIEW_FILENAME,
} = {}) {
  const tree = indexModuleTree(moduleTree)
  if (tree.size === 0) return [] // whole-repository 模式没有权威模块名，不能凭名字删页
  const pageList = (Array.isArray(pages) ? pages : []).map(posix)
  const expected = new Set([overviewName])
  for (const [name] of tree) {
    const node = tree.get(name)
    expected.add(moduleDocRelPath(node?.modulePath ?? [name]))
    expected.add(`${name}.md`)
  }
  const out = []
  for (const page of pageList) {
    if (!/\.md$/i.test(page)) continue
    if (expected.has(page)) continue
    out.push(page)
  }
  return out
}
