// 符号级增量：判断「这次改动到底要不要重写某篇文章」。
//
// 背景：cw status 只能给到文件级（哪些文件的 mtime/内容变了）。但一次改动的绝大多数
// 情况是「只改了注释/空行/局部实现」，模块的对外接口与职责没变——文章没必要重写。
// FSoft-AI4Code/CodeWiki 的 updater 用组件级 hash + 签名比对把这些过滤掉，只留
// interface/added/deleted/renamed 这类真正改变架构描述的变更。
//
// 本文件负责三件事：
//   1. 图快照的瘦身存取（只存判定需要的字段，不存源码全文——.codewiki/ 会进仓库）；
//   2. 把「文件级变更」折算成「组件级变更」（复用 lib/graph-diff.js）；
//   3. 按文章 frontmatter 的 source_files 决定哪些文章保留、哪些跳过。
//
// 纯逻辑（filterStaleTasks）不碰文件系统，方便单测；IO 部分集中在末尾。

import fs from 'node:fs'
import path from 'node:path'
import { diffGraphs, changedIds, graphDiffCounts, bodyHash, codeHash } from './graph-diff.js'

export const SNAPSHOT_VERSION = 1
// 放在 .codewiki/temp/ 下，与上游 wiki_out/temp/ 同思路；该目录随 wiki 一起入库，
// 避免换机器/换会话后因为拿不到旧图而退化成全量重写。
export const SNAPSHOT_REL = path.posix.join('temp', 'symbol-graph.json')

// 快照字段：判定只需要这些。sourceCode 一律不存（体积），bodyHash 直接固化下来，
// 让 graph-diff 的 bodyHash() 走缓存分支，避免把源码读回来重算。
const SLIM_FIELDS = ['id', 'name', 'kind', 'relativePath', 'parameters', 'baseClasses', 'dependsOn', 'bodyHash', 'codeHash']

export function slimComponent(node) {
  const out = {}
  for (const k of SLIM_FIELDS) if (node?.[k] !== undefined) out[k] = node[k]
  out.id = String(node?.id ?? '')
  out.relativePath = String(node?.relativePath ?? '')
  return out
}

// graph: Map<id, node>（node 需带 bodyHash）→ 可 JSON 化的快照对象
export function slimGraph(graph, { commit = null, now = new Date().toISOString() } = {}) {
  const components = [...graph.values()]
    // 现场节点没缓存哈希，这里算一次固化进快照——之后回读不再需要源码
    .map((n) => slimComponent({
      ...n,
      bodyHash: n?.bodyHash ?? bodyHash(n),
      // 注释无关的「代码本体」哈希：判定纯注释改动时用它（见 filterStaleTasks 的降级）
      codeHash: n?.codeHash ?? codeHash(n),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { version: SNAPSHOT_VERSION, generatedAt: now, commit, components }
}

// 两份快照的「实质内容」是否相同（忽略 generatedAt / commit 这类每次都会变的元数据）。
// 用途：编译收尾写快照前先比一次——代码没变时不要覆盖，否则 autoCommit 会为
// 「只改了一个时间戳」生成一个空转提交，把用户的历史搞脏。
export function sameSnapshotContent(a, b) {
  if (!a || !b) return false
  const norm = (s) => JSON.stringify(
    [...(s?.components ?? [])]
      .filter((c) => c?.id)
      .map((c) => {
        const o = {}
        for (const k of SLIM_FIELDS) if (c[k] !== undefined) o[k] = c[k]
        return o
      })
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
  )
  return norm(a) === norm(b)
}

// 快照对象 → Map<id, node>（graph-diff 的直接输入）
export function graphFromSnapshot(snap) {
  const g = new Map()
  for (const c of snap?.components ?? []) {
    if (!c?.id) continue
    g.set(c.id, {
      id: c.id,
      name: c.name ?? null,
      kind: c.kind ?? null,
      relativePath: c.relativePath ?? '',
      parameters: Array.isArray(c.parameters) ? c.parameters : [],
      baseClasses: Array.isArray(c.baseClasses) ? c.baseClasses : [],
      dependsOn: Array.isArray(c.dependsOn) ? c.dependsOn : [],
      bodyHash: c.bodyHash ?? null,
      codeHash: c.codeHash ?? null,
      sourceCode: '',
      docstring: '',
    })
  }
  return g
}

export function snapshotPath(wikiPath) {
  return path.join(wikiPath, ...SNAPSHOT_REL.split('/'))
}

export function loadSnapshot(wikiPath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(snapshotPath(wikiPath), 'utf8')
    const snap = JSON.parse(raw)
    if (snap?.version !== SNAPSHOT_VERSION) return null // 版本不符当没有：宁可重写也不误判
    if (!Array.isArray(snap.components)) return null
    return snap
  } catch {
    return null
  }
}

export function saveSnapshot(wikiPath, snap, fsImpl = fs, pathImpl = path) {
  try {
    const p = snapshotPath(wikiPath)
    fsImpl.mkdirSync(pathImpl.dirname(p), { recursive: true })
    fsImpl.writeFileSync(p, JSON.stringify(snap), 'utf8')
    return { ok: true, path: p }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) }
  }
}

// 目录相对路径归一：快照里存的是 posix 相对路径，文章 frontmatter 里可能是 \ 或 ./ 开头
export function normRel(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

// 文件 → 该文件里的组件 id 清单（newGraph 侧，因为新增文件也要算进去）
export function componentsByFile(graph) {
  const m = new Map()
  for (const c of graph.values()) {
    const f = normRel(c.relativePath)
    if (!f) continue
    if (!m.has(f)) m.set(f, [])
    m.get(f).push(c.id)
  }
  return m
}

// 核心判定（纯函数）。
// tasks: [{ name, articlePath, sources: [file...] }]
// oldGraph/newGraph: Map<id, node>
// 返回 { keep, dropped, change, counts }
//   keep[i].changedComponents = 该文章覆盖到的、本次真的变了的组件 id（喂给写作者当重点）
//   没有任何符号可判的文章一律 keep（宁可多写一篇，不留下过期文章）
export function filterStaleTasks(tasks, oldGraph, newGraph, opts = {}) {
  const diff = diffGraphs(oldGraph, newGraph, opts)
  const changed = changedIds(diff)
  const counts = graphDiffCounts(diff)
  const byFile = componentsByFile(newGraph)

  // 纯注释/排版改动降级：bodyHash 变了但 codeHash 没变的组件，视为「描述不变」。
  // 背景：bodyHash 覆盖整段源码文本，注释被改一下它就变，于是文章无条件重写；
  // 实测上游 Python 的 normalize_body 也只做空白归一，所以这不是移植错，是这套
  // 哈希本身的粒度不区分注释。这里在**判定层**加一道降级，不动 diffGraphs
  // （那个函数与上游逐位对齐，有 golden 对拍）。
  //
  // 只降级 body 类：interface（签名变了）/ added / deleted / renamed 一律不放行，
  // 那些是真改动了对外描述，必须重写。
  const cosmeticOnly = new Set()
  if (opts.ignoreCommentOnly !== false) {
    for (const cid of changed) {
      if (!diff.body.has(cid)) continue
      const o = oldGraph.get(cid)
      const n = newGraph.get(cid)
      if (!o || !n) continue
      // 现场节点（有源码）按需算；快照回读节点直接用固化值，算不出来就是 null
      const oh = o.sourceCode ? codeHash(o) : (o.codeHash ?? null)
      const nh = n.sourceCode ? codeHash(n) : (n.codeHash ?? null)
      if (!oh || !nh) continue
      // docstring 变化单独检查：文档注释改了应当重写（它不是噪音）
      const docChanged = String(o.docstring ?? '').trim() !== String(n.docstring ?? '').trim()
      if (oh === nh && !docChanged) cosmeticOnly.add(cid)
    }
  }
  const realChanged = new Set([...changed].filter((id) => !cosmeticOnly.has(id)))

  const keep = []
  const dropped = []
  for (const t of tasks ?? []) {
    const ids = new Set()
    for (const f of t?.sources ?? []) {
      for (const id of byFile.get(normRel(f)) ?? []) ids.add(id)
    }
    if (!ids.size) {
      // 这篇文章的 source_files 里没有可解析的符号（配置文件、模板、无语法支持的扩展名）：
      // 符号级手段对它无效，保守保留——交回文件级判定。
      keep.push({ ...t, changedComponents: [], symbolFallback: true })
      continue
    }
    const hit = [...ids].filter((id) => realChanged.has(id))
    if (hit.length) keep.push({ ...t, changedComponents: hit.sort() })
    else {
      // 只命中纯注释改动时记一下原因，便于面板/日志解释「为什么这篇没重写」
      const cosmeticHit = [...ids].filter((id) => cosmeticOnly.has(id))
      dropped.push(cosmeticHit.length ? { ...t, cosmeticOnlyComponents: cosmeticHit.sort() } : t)
    }
  }
  return { keep, dropped, change: diff, counts, cosmeticOnly: [...cosmeticOnly].sort() }
}

// 变更摘要（写进 job note，让人一眼看出「改了几处、为什么少写了 N 篇」）
export function describeChange(counts) {
  const parts = []
  if (counts.interface) parts.push(`接口变 ${counts.interface}`)
  if (counts.added) parts.push(`新增 ${counts.added}`)
  if (counts.deleted) parts.push(`删除 ${counts.deleted}`)
  if (counts.renamed) parts.push(`改名 ${counts.renamed}`)
  if (counts.body) parts.push(`实现变 ${counts.body}`)
  if (counts.edge) parts.push(`依赖变 ${counts.edge}`)
  return parts.length ? parts.join('、') : '无实质变更'
}
