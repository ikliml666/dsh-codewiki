// 符号级增量 diff —— 移植自 FSoft-AI4Code/CodeWiki 的
// codewiki/src/be/updater/graph_diff.py（MIT，ACL 2026 论文实现）。
//
// 为什么移植而不是调用：上游那套最值钱的判断（哪些组件真的变了、变的是签名还是实现、
// 哪个删除对应哪个新增=改名）全部是纯标准库算法（hashlib/difflib/re），零 ML 依赖。
// 逐位移植后本插件保持纯 Node、零外部运行时，判定精度与上游一致。
//
// 组件 id 约定与上游相同：`<相对路径>#<符号名>`（上游是 path::name，用 # 是为了不与
// Windows 盘符里的 : 混淆）。Node 记录形状：
//   { id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }

import crypto from 'node:crypto'

export const CLASS_ADDED = 'added'
export const CLASS_DELETED = 'deleted'
export const CLASS_IFACE = 'interface'
export const CLASS_BODY = 'body'
export const CLASS_EDGE = 'edge'
export const CLASS_RENAMED = 'renamed'

export const DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'

const WS = /\s+/gu
// Python 的 \w 是 Unicode 感知的（中文算一个 token）；JS 的 \w 只有 [A-Za-z0-9_]，
// 直接用会让中文按字切碎、相似度整体偏高。用 Unicode 属性类还原 Python 语义。
const TOKEN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu

export function normalizeBody(text) {
  return String(text ?? '').trim().replace(WS, ' ')
}

// 组件源码＋文档注释：Rust 的 /// 在 sourceCode 之外，不带上就看不出「只改了文档」
export function documentedSource(node) {
  const code = node?.sourceCode || ''
  const doc = String(node?.docstring ?? '').trim()
  if (doc && !code.includes(doc)) return `${doc}\n${code}`
  return code
}

export function bodyHash(node) {
  // 快照回读的节点不带源码（.codewiki/ 要入库，不能存全文），哈希已随快照固化。
  // 只在「没有源码但是有固化哈希」时走这条，实时提取的节点行为完全不变。
  if (!node?.sourceCode && node?.bodyHash) return String(node.bodyHash)
  return crypto.createHash('sha1').update(normalizeBody(documentedSource(node)), 'utf8').digest('hex')
}

export function signature(node) {
  return {
    name: node?.name ?? null,
    parameters: [...(node?.parameters ?? [])],
    baseClasses: [...(node?.baseClasses ?? [])],
  }
}

export function signatureChanged(a, b) {
  const x = signature(a)
  const y = signature(b)
  if (x.name !== y.name) return true
  if (x.parameters.length !== y.parameters.length) return true
  for (let i = 0; i < x.parameters.length; i++) if (x.parameters[i] !== y.parameters[i]) return true
  if (x.baseClasses.length !== y.baseClasses.length) return true
  for (let i = 0; i < x.baseClasses.length; i++) if (x.baseClasses[i] !== y.baseClasses[i]) return true
  return false
}

function tokens(text) {
  return String(text ?? '').match(TOKEN) ?? []
}

// ---------------------------------------------------------------------------
// difflib.SequenceMatcher 移植（autojunk=False，无 junk 元素）
// 上游 body_similarity 用的是这个 ratio；不逐位对齐就无法对拍验证。
// ---------------------------------------------------------------------------

function buildB2J(b) {
  const b2j = new Map()
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j])
    if (arr) arr.push(j)
    else b2j.set(b[j], [j])
  }
  return b2j
}

function findLongestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo
  let bestj = blo
  let bestsize = 0
  let j2len = new Map()
  const nothing = []
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map()
    const candidates = b2j.get(a[i]) ?? nothing
    for (const j of candidates) {
      if (j < blo) continue
      if (j >= bhi) break
      const k = (j2len.get(j - 1) ?? 0) + 1
      newj2len.set(j, k)
      if (k > bestsize) {
        besti = i - k + 1
        bestj = j - k + 1
        bestsize = k
      }
    }
    j2len = newj2len
  }
  return [besti, bestj, bestsize]
}

function getMatchingBlocks(a, b) {
  const la = a.length
  const lb = b.length
  const b2j = buildB2J(b)
  const queue = [[0, la, 0, lb]]
  const blocks = []
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()
    const m = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)
    const [i, j, k] = m
    if (k) {
      blocks.push(m)
      if (alo < i && blo < j) queue.push([alo, i, blo, j])
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
    }
  }
  blocks.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]))
  // 合并相邻块（与 Python difflib 完全一致的归并逻辑）
  let i1 = 0
  let j1 = 0
  let k1 = 0
  const nonAdjacent = []
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1])
      i1 = i2
      j1 = j2
      k1 = k2
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1])
  nonAdjacent.push([la, lb, 0])
  return nonAdjacent
}

// difflib.SequenceMatcher.ratio()
export function sequenceRatio(aArr, bArr) {
  const total = aArr.length + bArr.length
  if (total === 0) return 1.0
  const blocks = getMatchingBlocks(aArr, bArr)
  let matches = 0
  for (const blk of blocks) matches += blk[2]
  return (2.0 * matches) / total
}

// 上游 body_similarity：token 序列的 difflib ratio，落在 [0,1]
export function bodySimilarity(a, b) {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.length && !tb.length) return 1.0
  if (!ta.length || !tb.length) return 0.0
  return sequenceRatio(ta, tb)
}

export function approxTokens(text) {
  return Math.floor(String(text ?? '').length / 4) + 1
}

export function truncateToTokens(text, maxTokens) {
  if (maxTokens <= 0 || approxTokens(text) <= maxTokens) return text
  const budget = maxTokens * 4
  const head = text.slice(0, Math.floor(budget / 2))
  const tail = text.slice(text.length - Math.floor(budget / 2))
  return `${head}\n${DIFF_TRUNCATED_MARKER}\n${tail}`
}

// ---------------------------------------------------------------------------
// difflib.unified_diff 移植（n 行上下文，keepends 语义）
// ---------------------------------------------------------------------------

function splitKeepEnds(text) {
  const s = String(text ?? '')
  if (!s) return []
  // Python 的 splitlines(keepends=True)：末尾无换行的最后一行也保留
  const out = s.match(/[^\n]*\n|[^\n]+$/g) ?? []
  return out
}

function getOpcodes(a, b) {
  const blocks = getMatchingBlocks(a, b)
  let i = 0
  let j = 0
  const codes = []
  for (const [ai, bj, size] of blocks) {
    let tag = ''
    if (i < ai && j < bj) tag = 'replace'
    else if (i < ai) tag = 'delete'
    else if (j < bj) tag = 'insert'
    if (tag) codes.push([tag, i, ai, j, bj])
    i = ai + size
    j = bj + size
    if (size) codes.push(['equal', ai, i, bj, j])
  }
  return codes
}

function getGroupedOpcodes(a, b, n) {
  let codes = getOpcodes(a, b)
  if (!codes.length) codes = [['equal', 0, 1, 0, 1]]
  if (codes[0][0] === 'equal') {
    const [, i1, i2, j1, j2] = codes[0]
    codes[0] = ['equal', Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]
  }
  const last = codes[codes.length - 1]
  if (last[0] === 'equal') {
    const [, i1, i2, j1, j2] = last
    codes[codes.length - 1] = ['equal', i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]
  }
  const nn = n + n
  const groups = []
  let group = []
  for (let code of codes) {
    let [tag, i1, i2, j1, j2] = code
    if (tag === 'equal' && i2 - i1 > nn) {
      group.push(['equal', i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)])
      groups.push(group)
      group = []
      i1 = Math.max(i1, i2 - n)
      j1 = Math.max(j1, j2 - n)
    }
    group.push([tag, i1, i2, j1, j2])
  }
  if (group.length && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group)
  return groups
}

function rangeUnified(start, stop) {
  const beginning = start + 1
  const length = stop - start
  if (length === 1) return String(beginning)
  if (!length) return `${beginning - 1},0`
  return `${beginning},${length}`
}

export function unifiedDiff(aLines, bLines, fromFile, toFile, n = 3, lineterm = '\n') {
  const out = []
  let started = false
  for (const group of getGroupedOpcodes(aLines, bLines, n)) {
    if (!group.length) continue
    const first = group[0]
    const last = group[group.length - 1]
    // 与 difflib 一致：header 只在第一个 group 输出一次，每个 group 都有 @@ 头
    if (!started) {
      started = true
      out.push(`--- ${fromFile}${lineterm}`)
      out.push(`+++ ${toFile}${lineterm}`)
    }
    out.push(`@@ -${rangeUnified(first[1], last[2])} +${rangeUnified(first[3], last[4])} @@${lineterm}`)
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === 'equal') {
        for (const line of aLines.slice(i1, i2)) out.push(` ${line}`)
        continue
      }
      if (tag === 'replace' || tag === 'delete') {
        for (const line of aLines.slice(i1, i2)) out.push(`-${line}`)
      }
      if (tag === 'replace' || tag === 'insert') {
        for (const line of bLines.slice(j1, j2)) out.push(`+${line}`)
      }
    }
  }
  return out.join('')
}

// 上游 unified_body_diff：整文件相对路径作 label，上下文固定 2 行
export function unifiedBodyDiff(oldNode, newNode, label) {
  const oldLines = oldNode ? splitKeepEnds(documentedSource(oldNode)) : []
  const newLines = newNode ? splitKeepEnds(documentedSource(newNode)) : []
  return unifiedDiff(oldLines, newLines, `a/${label}`, `b/${label}`, 2)
}

// ---------------------------------------------------------------------------
// 改名配对：按 body 相似度贪心最佳匹配
// ---------------------------------------------------------------------------

export const DEFAULT_TAU_REN = 0.8
export const DEFAULT_MAX_DIFF_TOKENS = 2000

export function pairRenames(deleted, added, oldGraph, newGraph, tauRen = DEFAULT_TAU_REN) {
  if (!deleted.size || !added.size) return []
  const addedByKind = new Map()
  for (const cid of added) {
    const kind = newGraph.get(cid)?.kind ?? ''
    if (!addedByKind.has(kind)) addedByKind.set(kind, [])
    addedByKind.get(kind).push(cid)
  }
  const candidates = []
  for (const oldId of deleted) {
    const o = oldGraph.get(oldId)
    const oBody = normalizeBody(o?.sourceCode)
    if (!oBody) continue
    for (const newId of addedByKind.get(o?.kind ?? '') ?? []) {
      const n = newGraph.get(newId)
      const nBody = normalizeBody(n?.sourceCode)
      if (!nBody) continue
      const ratio = nBody.length >= oBody.length
        ? oBody.length / nBody.length
        : nBody.length / oBody.length
      if (ratio < tauRen * 0.9) continue // 长度差太大，够不到 tauRen
      const sim = bodySimilarity(o?.sourceCode, n?.sourceCode)
      if (sim >= tauRen) candidates.push([sim, oldId, newId])
    }
  }
  candidates.sort((x, y) => y[0] - x[0])
  const usedOld = new Set()
  const usedNew = new Set()
  const pairs = []
  for (const [sim, oldId, newId] of candidates) {
    if (usedOld.has(oldId) || usedNew.has(newId)) continue
    usedOld.add(oldId)
    usedNew.add(newId)
    pairs.push([oldId, newId, sim])
  }
  return pairs
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function emptyGraphDiff() {
  return {
    added: new Set(),
    deleted: new Set(),
    interface: new Set(),
    body: new Set(),
    edge: new Set(),
    renamed: new Map(), // oldId -> newId
    records: new Map(),
  }
}

export function graphDiffCounts(d) {
  return {
    added: d.added.size,
    deleted: d.deleted.size,
    interface: d.interface.size,
    body: d.body.size,
    edge: d.edge.size,
    renamed: d.renamed.size,
  }
}

export function changedIds(d) {
  const s = new Set([...d.added, ...d.deleted, ...d.interface, ...d.body, ...d.edge])
  for (const v of d.renamed.values()) s.add(v)
  return s
}

export function isDiffEmpty(d) {
  return changedIds(d).size === 0
}

// 组件级变更集：签名变=interface、实现变=body、仅依赖变=edge，删除+新增近似=renamed
export function diffGraphs(oldGraph, newGraph, opts = {}) {
  const tauRen = opts.tauRen ?? DEFAULT_TAU_REN
  const maxDiffTokens = opts.maxDiffTokens ?? DEFAULT_MAX_DIFF_TOKENS
  const result = emptyGraphDiff()
  const oldIds = new Set(oldGraph.keys())
  const newIds = new Set(newGraph.keys())

  for (const id of newIds) if (!oldIds.has(id)) result.added.add(id)
  for (const id of oldIds) if (!newIds.has(id)) result.deleted.add(id)

  for (const cid of oldIds) {
    if (!newIds.has(cid)) continue
    const o = oldGraph.get(cid)
    const n = newGraph.get(cid)
    const sigChanged = signatureChanged(o, n)
    const hashChanged = bodyHash(o) !== bodyHash(n)
    const oEdges = new Set(o?.dependsOn ?? [])
    const nEdges = new Set(n?.dependsOn ?? [])
    const edgesChanged = oEdges.size !== nEdges.size || [...oEdges].some((x) => !nEdges.has(x))
    if (!sigChanged && !hashChanged && !edgesChanged) continue
    let klass
    if (sigChanged) {
      klass = CLASS_IFACE
      result.interface.add(cid)
    } else if (hashChanged) {
      klass = CLASS_BODY
      result.body.add(cid)
    } else {
      klass = CLASS_EDGE
      result.edge.add(cid)
    }
    const edgesAdded = [...nEdges].filter((x) => !oEdges.has(x)).sort()
    const edgesRemoved = [...oEdges].filter((x) => !nEdges.has(x)).sort()
    const rec = {
      componentId: cid,
      changeClass: klass,
      oldId: cid,
      newId: cid,
      relativePath: n?.relativePath ?? null,
      componentType: n?.kind ?? null,
      oldSignature: signature(o),
      newSignature: signature(n),
      similarity: null,
      signatureChanged: sigChanged,
      edgesAdded,
      edgesRemoved,
      diff: '',
    }
    if (hashChanged) rec.diff = truncateToTokens(unifiedBodyDiff(o, n, cid), maxDiffTokens)
    result.records.set(cid, rec)
  }

  for (const [oldId, newId, sim] of pairRenames(result.deleted, result.added, oldGraph, newGraph, tauRen)) {
    result.deleted.delete(oldId)
    result.added.delete(newId)
    result.renamed.set(oldId, newId)
    const o = oldGraph.get(oldId)
    const n = newGraph.get(newId)
    const sigChanged = signatureChanged(o, n)
    const rec = {
      componentId: newId,
      changeClass: CLASS_RENAMED,
      oldId,
      newId,
      relativePath: n?.relativePath ?? null,
      componentType: n?.kind ?? null,
      oldSignature: signature(o),
      newSignature: signature(n),
      similarity: Math.round(sim * 10000) / 10000,
      signatureChanged: sigChanged,
      edgesAdded: [],
      edgesRemoved: [],
      diff: '',
    }
    if (bodyHash(o) !== bodyHash(n)) rec.diff = truncateToTokens(unifiedBodyDiff(o, n, newId), maxDiffTokens)
    result.records.set(newId, rec)
    if (sigChanged) result.interface.add(newId)
  }

  for (const cid of result.added) {
    const n = newGraph.get(cid)
    result.records.set(cid, {
      componentId: cid,
      changeClass: CLASS_ADDED,
      oldId: null,
      newId: cid,
      relativePath: n?.relativePath ?? null,
      componentType: n?.kind ?? null,
      oldSignature: null,
      newSignature: signature(n),
      similarity: null,
      signatureChanged: false,
      edgesAdded: [...new Set(n?.dependsOn ?? [])].sort(),
      edgesRemoved: [],
      diff: truncateToTokens(unifiedBodyDiff(null, n, cid), maxDiffTokens),
    })
  }
  for (const cid of result.deleted) {
    const o = oldGraph.get(cid)
    result.records.set(cid, {
      componentId: cid,
      changeClass: CLASS_DELETED,
      oldId: cid,
      newId: null,
      relativePath: o?.relativePath ?? null,
      componentType: o?.kind ?? null,
      oldSignature: signature(o),
      newSignature: null,
      similarity: null,
      signatureChanged: false,
      edgesAdded: [],
      edgesRemoved: [...new Set(o?.dependsOn ?? [])].sort(),
      diff: truncateToTokens(unifiedBodyDiff(o, null, cid), maxDiffTokens),
    })
  }

  return result
}

// 序列化用：Set/Map 转数组，便于落盘与对拍
export function serializeDiff(d) {
  return {
    counts: graphDiffCounts(d),
    added: [...d.added].sort(),
    deleted: [...d.deleted].sort(),
    interface: [...d.interface].sort(),
    body: [...d.body].sort(),
    edge: [...d.edge].sort(),
    renamed: Object.fromEntries([...d.renamed.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))),
    records: Object.fromEntries([...d.records.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))),
  }
}
