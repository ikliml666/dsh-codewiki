// 增量计划器（吸收自 FSoft-AI4Code/CodeWiki 的 updater/ownership.py、
// routing.py、stale_scan.py、orchestrator.py，重写为纯函数）。
//
// 背景缺陷（审计确认，lib/incremental.js:140-193）：
//   旧实现只回答「这篇要不要重写」——从文章既有 source_files 里取组件，命中变更就写、
//   没命中就丢。三个后果：
//     1. 反向依赖看不见：util/strings.js 的签名变了，引用它的 billing 文章却不重写；
//     2. 新文件无归属：新加的模块文件不属于任何文章 source_files，被静默丢弃；
//     3. 未重写页不做 stale scan：正文里引用着已删除的符号、指向已不存在的文章，
//        文章就这样过期地留在 wiki 里。
//
// 本模块把「要不要重写」升级成「每篇该做什么、为什么」：write / keep / delete / review
// 四类显式 action，每个都带 reason；无法归属的变更单独列出（unmappedChanges），
// 由调用方决定退回全量编译或记 partial——绝不静默丢弃。
//
// 纯函数：不碰文件系统（moduleMap 的读写在同文件末尾的 IO 部分）。

import path from 'node:path'
import { diffGraphs, changedIds, graphDiffCounts, codeHash } from './graph-diff.js'
import { SUPPORTED_EXTS } from './symbols.js'
import { normRel } from './incremental.js'

export const UPDATE_PLAN_VERSION = 1
// 版本化单一状态文件：文章→源码/组件/模块关系。full compile 时从真实 plan 重建；
// 旧 wiki 没有它就从 frontmatter 保守迁移（见 migrateModuleMap）。
export const MODULE_MAP_VERSION = 1
export const MODULE_MAP_REL = 'temp/module-map.json'

// SUPPORTED_EXTS 是 Map<ext, lang>，取其 key 集合
const SOURCE_EXTS = new Set([...SUPPORTED_EXTS.keys()])
// 源码扩展名判断：只看扩展名，不看内容。非源码文件（.md/.json/.log…）无归属时
// 只记 warning，不触发全量重编——否则任何一篇随手写的笔记都会让增量永远退回 full。
export function isSourcePath(p) {
  const ext = path.posix.extname(String(p ?? '')).toLowerCase()
  return SOURCE_EXTS.has(ext)
}

function dirOf(p) {
  const d = path.posix.dirname(normRel(p))
  return d === '.' ? '' : d
}

// 最长公共目录（至少一级才算「同模块」）；不同目录返回 ''
function commonDir(a, b) {
  const A = dirOf(a).split('/').filter(Boolean)
  const B = dirOf(b).split('/').filter(Boolean)
  const out = []
  for (let i = 0; i < Math.min(A.length, B.length); i += 1) {
    if (A[i] !== B[i]) break
    out.push(A[i])
  }
  return out.join('/')
}

// 纯注释降级：与 lib/incremental.js 同一套判据（复用 codeHash，不另造哈希规则）。
// 只降级 body 类变更；interface/added/deleted/renamed/edge 一律视为实质变化。
export function realChangedIds(diff, oldGraph, newGraph, { ignoreCommentOnly = true } = {}) {
  const changed = new Set(changedIds(diff))
  const cosmetic = new Set()
  if (ignoreCommentOnly) {
    for (const cid of changed) {
      if (!diff.body.has(cid)) continue
      const o = oldGraph.get(cid)
      const n = newGraph.get(cid)
      if (!o || !n) continue
      const oh = o.sourceCode ? codeHash(o) : (o.codeHash ?? null)
      const nh = n.sourceCode ? codeHash(n) : (n.codeHash ?? null)
      if (!oh || !nh) continue
      const docChanged = String(o.docstring ?? '').trim() !== String(n.docstring ?? '').trim()
      if (oh === nh && !docChanged) cosmetic.add(cid)
    }
  }
  return {
    changed,
    cosmetic,
    real: new Set([...changed].filter((id) => !cosmetic.has(id))),
    structural: new Set([...changed].filter((id) => !cosmetic.has(id)
      && (diff.interface.has(id) || diff.added.has(id) || diff.deleted.has(id)
        || diff.renamed.has(id) || diff.edge.has(id)))),
  }
}

// 组件 → 依赖它的组件（反向边）。dependsOn 里可能是组件 id，也可能是文件路径；
// 两种都认，保证「被依赖方变了 → 使用方文章要重写」这条能生效。
export function dependentsOf(graph, ids) {
  const want = new Set(ids)
  const byId = new Map()
  for (const [id, node] of graph) {
    for (const dep of node?.dependsOn ?? []) {
      const key = String(dep)
      if (!byId.has(key)) byId.set(key, [])
      byId.get(key).push(id)
    }
  }
  const out = new Map()
  for (const cid of want) {
    const users = byId.get(cid)
    if (users?.length) out.set(cid, users.slice().sort())
  }
  return out
}

// 单篇文章的 stale scan：正文里还引用着已删除/已改名的符号，或指向不存在的文章。
// 纯函数：linkExists(target) 由调用方注入（wiki 里是否有这篇）。
// 返回 { issues: [{kind, detail}], needsRewrite: bool }
export function scanStaleArticle(article, { deletedComponents = [], renamedComponents = [], linkExists = null } = {}) {
  const text = String(article?.content ?? '')
  const issues = []
  if (!text.trim()) return { issues, needsRewrite: false }
  // 已删除符号：正文出现「名字」或「id 尾巴」都算引用（文章里通常写名字而非完整 id）
  const hitDeleted = []
  for (const id of deletedComponents) {
    const name = String(id).includes('#') ? String(id).split('#').pop() : String(id)
    if (!name) continue
    if (new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(text)) hitDeleted.push(name)
  }
  if (hitDeleted.length) issues.push({ kind: 'deleted-symbol', detail: hitDeleted.slice(0, 5).join('、') })
  const hitRenamed = []
  for (const r of renamedComponents) {
    const name = String(r?.from ?? '').includes('#') ? String(r.from).split('#').pop() : String(r?.from ?? '')
    if (!name) continue
    if (new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(text)) hitRenamed.push(`${name}→${String(r.to ?? '').split('#').pop()}`)
  }
  if (hitRenamed.length) issues.push({ kind: 'renamed-symbol', detail: hitRenamed.slice(0, 5).join('、') })
  // 内部 wiki 链接死链：[[name]] 与 markdown 相对链接两种形态
  if (typeof linkExists === 'function') {
    const targets = new Set()
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) targets.add(String(m[1]).trim())
    for (const m of text.matchAll(/\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g)) {
      const t = String(m[1]).trim()
      if (!/^[a-z]+:/i.test(t)) targets.add(t)
    }
    const dead = []
    for (const t of targets) {
      try { if (!linkExists(t)) dead.push(t) } catch { /* 判定不可用：不误报 */ }
    }
    if (dead.length) issues.push({ kind: 'dead-link', detail: dead.slice(0, 5).join('、') })
  }
  return {
    issues,
    // 引用已删/改名符号 = 内容已错，必须重写；死链只要求人工复核（review），
    // 因为链接目标可能只是被改名成等价标题（同篇内重定向不该触发重写）。
    needsRewrite: issues.some((i) => i.kind === 'deleted-symbol' || i.kind === 'renamed-symbol'),
  }
}

// 计划主入口（纯函数）。
//   changeSet   collectChangeSet 的产物（可为 null：调用方拿不到变更集时会显式要求 full）
//   oldGraph/newGraph  Map<id,node>；两者任一为 null 时退化为文件级判定
//   articles    [{ name, articlePath, sources:[file], content? , type? }]
//   moduleMap   { version, articles: { [name]: { sources, components, module } } } 或 null
//   options     { fileLevel, linkExists, articleExists }
//
// 返回 UpdatePlan：每篇一个 action + reason，外加 unmappedChanges / missingSources /
// needsFull。needsFull=true 时调用方应走全量编译（保守），不得当作 keep 处理。
export function planUpdate({
  changeSet = null,
  oldGraph = null,
  newGraph = null,
  articles = [],
  moduleMap = null,
  options = {},
} = {}) {
  const linkExists = options.linkExists ?? null
  const warnings = []
  const unmappedChanges = []
  const missingSources = []
  const actions = []
  const summary = { write: 0, keep: 0, delete: 0, review: 0 }

  const cs = changeSet ?? { ok: false, sourceChanges: [], deleted: [], renamed: [], untracked: [], all: [] }
  const sourceChanges = new Set((cs.sourceChanges ?? cs.all ?? []).map(normRel))
  const deleted = new Set((cs.deleted ?? []).map(normRel))
  const renamed = (cs.renamed ?? []).map((r) => ({ from: normRel(r.from), to: normRel(r.path ?? r.to) }))
  const untracked = new Set((cs.untracked ?? []).map(normRel))

  // 文件级降级（symbolIncremental=false / 快照缺失 / 符号提取不可用）：
  // 仍然按文件判定，但**不再**只认 source_files 命中——删除、改名、新文件都照常处理。
  const fileLevel = options.fileLevel === true || !oldGraph || !newGraph
  let diff = null
  let real = new Set()
  let structural = new Set()
  let cosmetic = new Set()
  let counts = { interface: 0, added: 0, deleted: 0, renamed: 0, body: 0, edge: 0 }
  if (!fileLevel) {
    diff = diffGraphs(oldGraph, newGraph)
    const r = realChangedIds(diff, oldGraph, newGraph, options)
    real = r.real
    structural = r.structural
    cosmetic = r.cosmetic
    counts = graphDiffCounts(diff)
  }

  // 组件 → 文件索引（新图侧：新增文件也要能算进去）
  const componentsByFile = new Map()
  for (const [id, node] of newGraph ?? []) {
    const f = normRel(node?.relativePath)
    if (!f) continue
    if (!componentsByFile.has(f)) componentsByFile.set(f, [])
    componentsByFile.get(f).push(id)
  }
  const fileOfComponent = new Map()
  for (const [f, ids] of componentsByFile) for (const id of ids) fileOfComponent.set(id, f)

  // 反向依赖闭包：structural 变更的组件 → 使用方组件 → 使用方文件。
  // 只对 structural 做（interface/added/deleted/renamed/edge）：实现细节变了不该
  // 连带重写所有引用方的文章。
  const impactByFile = new Map() // file → 触发它的变更组件清单
  if (!fileLevel && structural.size) {
    const dependents = dependentsOf(newGraph, structural)
    for (const [changedId, users] of dependents) {
      for (const uid of users) {
        const f = fileOfComponent.get(uid)
        if (!f) continue
        if (!impactByFile.has(f)) impactByFile.set(f, [])
        impactByFile.get(f).push(changedId)
      }
    }
  }

  // 文章集合与 ownership：以 source_files 为初始所有权，moduleMap 作补充证据。
  const claimedFiles = new Set()
  const articleNames = new Set()
  for (const a of articles) {
    if (!a?.name) continue
    articleNames.add(normRel(a.name))
    for (const f of a.sources ?? []) claimedFiles.add(normRel(f))
    const mm = moduleMap?.articles?.[normRel(a.name)]
    for (const f of mm?.sources ?? []) claimedFiles.add(normRel(f))
  }
  // 组件所在文件也视为已被某篇文章「占住」（否则会把有主的源码算成无归属）
  for (const f of componentsByFile.keys()) {
    for (const a of articles) {
      if ((a.sources ?? []).some((s) => normRel(s) === f)) { claimedFiles.add(f); break }
    }
  }

  for (const a of articles) {
    const name = normRel(a?.name)
    if (!name) continue
    const sources = (a.sources ?? []).map(normRel)
    const mm = moduleMap?.articles?.[name]
    const base = {
      name,
      articlePath: a.articlePath ?? null,
      sources,
      changedComponents: [],
      impactedBy: [],
      reasons: [],
    }
    // 缺 source_files：没有 ownership 就无法判定这篇是否还准确。显式 review + 要求全量，
    // 不再像旧实现那样只记一条 note 就跳过。
    if (!sources.length) {
      missingSources.push({ name, file: null, reason: 'frontmatter 缺 source_files' })
      actions.push({ ...base, action: 'review', reason: 'frontmatter 缺 source_files，无法判定归属', needsFull: true })
      summary.review += 1
      continue
    }
    const gone = sources.filter((f) => deleted.has(f))
    const renamedSrc = sources.map((f) => renamed.find((r) => r.from === f)).filter(Boolean)
    const present = sources.filter((f) => !deleted.has(f))

    const ids = new Set()
    for (const f of present) for (const id of componentsByFile.get(f) ?? []) ids.add(id)

    const ownHit = [...ids].filter((id) => real.has(id)).sort()
    const depHit = []
    for (const f of present) for (const c of impactByFile.get(f) ?? []) if (!depHit.includes(c)) depHit.push(c)

    if (gone.length) {
      actions.push({
        ...base,
        action: 'write',
        reason: `source_files 有 ${gone.length} 个文件已被删除：${gone.slice(0, 3).join('、')}`,
        changedComponents: ownHit,
      })
      summary.write += 1
      continue
    }
    if (renamedSrc.length) {
      actions.push({
        ...base,
        action: 'write',
        reason: `source_files 有文件被改名：${renamedSrc.map((r) => `${r.from}→${r.to}`).slice(0, 3).join('、')}`,
        changedComponents: ownHit,
      })
      summary.write += 1
      continue
    }
    if (!ids.size) {
      // 无符号可判（配置/模板/无语法支持的扩展名）：文件级降级——文件真变了就重写，
      // 没变就 keep。这条分支保留旧实现的「符号手段对它无效」语义，但不静默。
      const fileHit = present.filter((f) => sourceChanges.has(f))
      if (fileHit.length) {
        actions.push({
          ...base, action: 'write', reason: `无符号可判，文件级判定命中：${fileHit.slice(0, 3).join('、')}`, fileLevel: true,
        })
        summary.write += 1
      } else {
        actions.push({ ...base, action: 'keep', reason: '无符号可判且 source_files 未变', fileLevel: true })
        summary.keep += 1
      }
      continue
    }
    if (ownHit.length || depHit.length) {
      const reasons = []
      if (ownHit.length) reasons.push(`自身源文件变更组件 ${ownHit.length} 个`)
      if (depHit.length) reasons.push(`被依赖组件变更影响（${depHit.slice(0, 3).join('、')}${depHit.length > 3 ? ' 等' : ''}）`)
      actions.push({
        ...base,
        action: 'write',
        reason: reasons.join('；'),
        changedComponents: [...new Set([...ownHit, ...depHit])].sort(),
        impactedBy: depHit.sort(),
      })
      summary.write += 1
      continue
    }
    // 未命中：先做 stale scan（未重写页也要检查），再决定 keep/review。
    // diff.renamed 是 Map<oldId,newId>；git 侧的改名是文件级 {from,to}，两者都要喂给 stale scan
    const renamedComponents = [
      ...[...(diff?.renamed?.entries?.() ?? [])].map(([from, to]) => ({ from, to })),
      ...renamed.map((r) => ({ from: r.from, to: r.to })),
    ]
    const scan = scanStaleArticle(a, {
      deletedComponents: [...(diff?.deleted ?? [])],
      renamedComponents,
      linkExists,
    })
    if (scan.needsRewrite) {
      actions.push({
        ...base,
        action: 'write',
        reason: `stale scan：正文仍引用${scan.issues.filter((i) => i.kind !== 'dead-link').map((i) => i.detail).join('；')}`,
        staleIssues: scan.issues,
      })
      summary.write += 1
      continue
    }
    if (scan.issues.length) {
      actions.push({ ...base, action: 'review', reason: `stale scan：${scan.issues.map((i) => `${i.kind} ${i.detail}`).join('；')}`, staleIssues: scan.issues })
      summary.review += 1
      continue
    }
    actions.push({ ...base, action: 'keep', reason: '组件与依赖边均无实质变更，stale scan 无命中' })
    summary.keep += 1
  }

  // 无归属变更：源码文件变了，但没有任何文章认领它（也没被改名映射覆盖）。
  // 这是「变化不能丢」的兜底：列出来并**要求全量重编**（保守），不再静默刷新基线。
  const routedTo = new Map() // file → article name（新文件按模块目录保守路由）
  for (const f of [...sourceChanges].sort()) {
    if (claimedFiles.has(f)) continue
    if (renamed.some((r) => r.from === f || r.to === f)) {
      // 改名：旧路径的认领文章已在上面的 renamedSrc 分支处理；新路径若仍无主则照常归类
      const target = renamed.find((r) => r.to === f)
      if (target && claimedFiles.has(target.from)) continue
    }
    // 新文件路由：与某篇文章的 source_files 共享目录前缀 → 归给它（保守重写该篇）
    const candidates = articles.filter((a) => (a.sources ?? []).some((s) => commonDir(normRel(s), f) !== ''))
    if (candidates.length) {
      const best = candidates
        .map((a) => ({ a, depth: Math.max(...(a.sources ?? []).map((s) => commonDir(normRel(s), f).split('/').filter(Boolean).length)) }))
        .sort((x, y) => y.depth - x.depth)[0].a
      routedTo.set(f, normRel(best.name))
      const idx = actions.findIndex((x) => x.name === normRel(best.name))
      if (idx >= 0 && actions[idx].action === 'keep') {
        actions[idx] = {
          ...actions[idx],
          action: 'write',
          reason: `${actions[idx].reason}；另有同模块新文件 ${f} 需要并入`,
          newFiles: [f],
        }
        summary.keep -= 1
        summary.write += 1
      } else if (idx >= 0) {
        actions[idx] = { ...actions[idx], newFiles: [...(actions[idx].newFiles ?? []), f] }
      }
      continue
    }
    unmappedChanges.push(f)
  }
  for (const f of unmappedChanges) {
    const untrackedTag = untracked.has(f) ? '（未跟踪新文件）' : ''
    if (isSourcePath(f)) {
      warnings.push(`源码变更无文章归属：${f}${untrackedTag}（将退回全量编译）`)
    } else {
      warnings.push(`非源码文件无文章引用：${f}${untrackedTag}（仅记账，不触发全量）`)
    }
  }
  const unmappedSource = unmappedChanges.filter((f) => isSourcePath(f))
  const needsFull = unmappedSource.length > 0
    || actions.some((a) => a.needsFull === true)  // 反向依赖闭包依赖图里的 dependsOn 边。旧链路（extractCurrentGraph）曾经不建边，
  // 那时「接口变了但依赖方文章不重写」是必然的——这里如实记账，不假装做到了。
  if (!fileLevel && ![...(newGraph ?? [])].some(([, n]) => (n?.dependsOn ?? []).length)) {
    warnings.push('符号图没有任何依赖边，反向依赖影响不可用（只能按 source_files 自身判定）')
  }

  // 计划内必需文章：full 编译的模块清单与 stale 的过期文章都算必需。
  // 调用方据此判定「缺页/失败 ⇒ 不得 done」。
  // 只有 write 动作才是「本次必须产出」；keep（无需重写）与 review（待人工）不是产出目标，
  // 把它们算进必需清单会让正常增量永远缺页——踩过：stale 判 write 2/keep 2，
  // 两篇 keep 被当成 missing-article，任务明明是完整成功却落了 partial。
  const writeNames = actions.filter((a) => a.action === 'write').map((a) => a.name)
  const requiredNames = options.requiredNames
    ? [...options.requiredNames].map(normRel)
    : writeNames
  const missingRequired = requiredNames.filter((n) => !articleNames.has(n) && !actions.some((a) => a.name === n))

  return {
    version: UPDATE_PLAN_VERSION,
    fileLevel,
    changedComponents: [...real].sort(),
    cosmeticComponents: [...cosmetic].sort(),
    structuralComponents: [...structural].sort(),
    counts,
    actions,
    summary,
    unmappedChanges,
    // 源码变更没人认领才算「未消化」（阻断基线前移）；
    // 非源码文件（README/CodeWiki.md 等文档）无文章引用是常态，只进 warnings，
    // 混进 unmappedChanges 会让每次正常增量都落 partial——踩过：stale 判 write 2/keep 2
    // 全成功，却因 CodeWiki.md 无归属被记 unmapped-changes 而判 partial。
    unmappedSourceChanges: unmappedSource,
    routedTo: [...routedTo.entries()].map(([file, name]) => ({ file, name })),
    missingSources,
    missingRequired,
    requiredNames,
    warnings,
    needsFull,
    fullReason: needsFull
      ? (unmappedSource.length ? `有 ${unmappedSource.length} 个源码变更无文章归属` : '有文章缺 source_files 无法判定归属')
      : '',
    hasChanges: sourceChanges.size > 0 || (cs.all ?? []).length > 0,
  }
}

// ---------------------------------------------------------------------------
// module-map：文章 → 源码/组件/模块关系的版本化状态文件
// ---------------------------------------------------------------------------

export function buildModuleMap({ articles = [], graph = null, plan = null, now = new Date().toISOString() } = {}) {
  const byFile = new Map()
  for (const [id, node] of graph ?? []) {
    const f = normRel(node?.relativePath)
    if (!f) continue
    if (!byFile.has(f)) byFile.set(f, [])
    byFile.get(f).push(id)
  }
  const entries = {}
  for (const a of articles) {
    const name = normRel(a?.name)
    if (!name) continue
    const sources = [...new Set((a.sources ?? []).map(normRel).filter(Boolean))].sort()
    const components = []
    for (const f of sources) for (const id of byFile.get(f) ?? []) components.push(id)
    // 模块归属：优先取 full 编译 plan 里的模块名，其次用 source_files 的公共目录
    let module = null
    const planned = (plan?.modules ?? []).find((m) => (m.files ?? []).some((f) => sources.includes(normRel(f))))
    if (planned?.name) module = String(planned.name)
    else if (sources.length) {
      const dirs = sources.map(dirOf).filter(Boolean)
      module = dirs.length && dirs.every((d) => d === dirs[0]) ? dirs[0] : null
    }
    entries[name] = { sources, components: components.sort(), module }
  }
  return { version: MODULE_MAP_VERSION, generatedAt: now, articles: entries }
}

// 旧 wiki 没有 module-map 时从 frontmatter 保守迁移：只记 sources，组件留空
// （下次编译成功后会由真实 plan 重建）。绝不因为缺文件就当成「没有归属」。
export function migrateModuleMap({ articles = [], now = new Date().toISOString() } = {}) {
  const entries = {}
  for (const a of articles) {
    const name = normRel(a?.name)
    if (!name) continue
    const sources = [...new Set((a.sources ?? []).map(normRel).filter(Boolean))].sort()
    entries[name] = { sources, components: [], module: sources.length ? (dirOf(sources[0]) || null) : null, migrated: true }
  }
  return { version: MODULE_MAP_VERSION, generatedAt: now, articles: entries, migratedFromFrontmatter: true }
}

// 两份 module-map 的实质内容是否相同（忽略 generatedAt）：避免为空转提交写文件。
export function sameModuleMap(a, b) {
  if (!a || !b) return false
  const norm = (m) => JSON.stringify(
    Object.entries(m.articles ?? {})
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => [k, [...(v.sources ?? [])].sort(), [...(v.components ?? [])].sort(), v.module ?? null]),
  )
  return norm(a) === norm(b)
}
