// 更新记录：一次编译到底做了什么、为什么，落成可机读的 JSON。
//
// 背景缺陷（审计确认）：编译结束只留 writtenCount/failedCount 两个数字，job 文件里
// 塞的是整张图与任务快照。于是「为什么这篇没重写」「哪几个变更没人管」事后无法复盘，
// 面板也只能显示一句「完成」——而实际上可能 1 篇成功、19 篇失败。
//
// 本模块负责：
//   1. 把 ChangeSet + UpdatePlan + 逐篇结果 收成一份版本化记录；
//   2. 判定终态（done / partial / failed），把「完整性不成立」的每种情形写进 blockers；
//   3. 明确回答「能不能推进编译基线」——只有完整成功才可以。
//
// 纯函数 + 两个 IO 助手，便于单测。

import fs from 'node:fs'
import path from 'node:path'

export const UPDATE_RECORD_VERSION = 1
export const UPDATE_RECORD_REL = 'temp/update-record.json'

// 终态语义（本次融合新增 partial）：
//   done     完整成功：计划内必需文章全部写好、变更全部有归属、质量闸门全过。
//   partial  部分完成：已成功的文章可以入库，但「全部已消化」不成立，基线不得前移。
//   failed   失败：没有可交付的成果（0 篇成功，或硬性前置条件缺失）。
export const TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled'])

export function isTerminalStage(stage) {
  return TERMINAL.has(String(stage ?? ''))
}

// 从逐篇结果与计划算出终态。
//   plan     planUpdate 的产物（可为 null：full 编译没有增量计划）
//   results  [{ name, ok, error? }] 逐篇落盘结果
//   options  { expectedNames, qualityIssues: [{name, issue}], indexOk, cancelled, extraBlockers }
//            expectedNames = 本阶段的任务清单（full 编译没有 plan，用它判缺页）
//
// 返回 { outcome, blockers, canAdvanceBaseline, writtenCount, failedCount }
export function judgeOutcome({ plan = null, results = [], options = {} } = {}) {
  const blockers = []
  const okNames = new Set()
  const failed = []
  for (const r of results ?? []) {
    if (!r?.name) continue
    if (r.ok) okNames.add(r.name)
    else failed.push({ name: r.name, error: String(r.error ?? r.stopReason ?? '未知原因').slice(0, 300) })
  }
  if (options.cancelled) {
    return {
      outcome: 'cancelled',
      blockers: [{ kind: 'cancelled', detail: '任务被取消' }],
      canAdvanceBaseline: false,
      writtenCount: okNames.size,
      failedCount: failed.length,
    }
  }

  // 1) 计划内必需文章：缺页（计划要求写但没写）与失败分开记——两者的处置不同。
  const required = (plan?.requiredNames ?? []).map(String)
  const planned = (plan?.actions ?? []).filter((a) => a.action === 'write' || a.action === 'review')
  const missing = []
  for (const a of planned) {
    if (a.action !== 'write') continue
    if (!okNames.has(a.name) && !failed.some((f) => f.name === a.name)) missing.push({ name: a.name, reason: a.reason })
  }
  const requiredMissing = required.filter((n) => !okNames.has(n) && !failed.some((f) => f.name === n))
  for (const m of missing) blockers.push({ kind: 'missing-article', name: m.name, detail: m.reason })
  for (const n of requiredMissing) {
    if (missing.some((m) => m.name === n)) continue
    blockers.push({ kind: 'missing-article', name: n, detail: '计划内必需文章没有产出' })
  }
  // 无 plan 的通道（full 编译）：任务清单本身就是「应该产出什么」。
  for (const n of (options.expectedNames ?? []).map(String)) {
    if (okNames.has(n) || failed.some((f) => f.name === n)) continue
    if (missing.some((m) => m.name === n) || requiredMissing.includes(n)) continue
    blockers.push({ kind: 'missing-article', name: n, detail: '任务清单里有这篇，但既没成功也没失败记录' })
  }

  // 2) 逐篇失败
  for (const f of failed) blockers.push({ kind: 'article-failed', name: f.name, detail: f.error })

  // 3) 变更没有被任何文章消化（unmapped）——旧实现正是这里静默放行并推进基线。
  // 只算源码变更：非源码文件（README/CodeWiki.md/CHANGELOG）没有被任何文章引用是常态，
  // 它们混进来会让正常增量永远落 partial，等于把「诚实终态」退化成「永远不完整」。
  const unmapped = plan?.unmappedSourceChanges
    ?? (plan?.unmappedChanges ?? []).filter((f) => !/\.md$/i.test(String(f)))
  if (unmapped.length) {
    blockers.push({
      kind: 'unmapped-changes',
      detail: `${unmapped.length} 个源码变更没有任何文章归属：${unmapped.slice(0, 5).join('、')}`,
      items: unmapped,
    })
  }
  if (plan?.missingSources?.length) {
    blockers.push({
      kind: 'missing-sources',
      detail: `${plan.missingSources.length} 篇文章缺 source_files：${plan.missingSources.map((m) => m.name).slice(0, 5).join('、')}`,
    })
  }

  // 4) 质量闸门
  for (const q of options.qualityIssues ?? []) {
    blockers.push({ kind: 'quality', name: q.name ?? null, detail: String(q.issue ?? q.detail ?? '文章质量闸门未通过').slice(0, 300) })
  }

  // 5) 索引/入口完整性
  if (options.indexOk === false) blockers.push({ kind: 'index', detail: '索引重建或入口文件校验未通过' })

  // 6) 调用方补充的硬阻塞（例如 git base 不可达导致的 full 退化、执行器整体失败）
  for (const b of options.extraBlockers ?? []) {
    blockers.push(typeof b === 'string' ? { kind: 'extra', detail: b } : { kind: b.kind ?? 'extra', detail: String(b.detail ?? '').slice(0, 300) })
  }

  const writtenCount = okNames.size
  // 没有任何成果可交付（0 篇成功，且有失败/缺页/阻塞）才是 failed；
  // 只要写成了一部分，就是 partial——「部分完成」不等于失败，但也不等于 done。
  const nothingDelivered = writtenCount === 0 && (failed.length > 0 || missing.length > 0 || blockers.length > 0)
  const outcome = blockers.length === 0 && failed.length === 0 && missing.length === 0 && requiredMissing.length === 0
    ? 'done'
    : (nothingDelivered ? 'failed' : 'partial')

  return {
    outcome,
    blockers,
    // 基线只代表「所有变化都已被消化」。任何 blocker 都意味着没消化完。
    canAdvanceBaseline: outcome === 'done' && blockers.length === 0,
    writtenCount,
    failedCount: failed.length,
  }
}

// 组装记录（可序列化；job 里只存路径与摘要，不塞整图）。
export function buildUpdateRecord({
  jobId = null,
  scope = 'auto',
  changeSet = null,
  plan = null,
  results = [],
  outcome = null,
  wikiPath = null,
  qualityIssues = [],
  notes = [],
  startedAt = null,
  finishedAt = new Date().toISOString(),
} = {}) {
  const judged = outcome ?? judgeOutcome({ plan, results, options: { qualityIssues } })
  return {
    version: UPDATE_RECORD_VERSION,
    jobId,
    scope,
    startedAt,
    finishedAt,
    baseCommit: changeSet?.baseCommit ?? null,
    headCommit: changeSet?.headCommit ?? null,
    changeSet: changeSet ? {
      state: changeSet.state,
      ok: changeSet.ok,
      fallback: changeSet.fallback ?? null,
      reason: changeSet.reason ?? '',
      counts: {
        committed: (changeSet.committed ?? []).length,
        staged: (changeSet.staged ?? []).length,
        unstaged: (changeSet.unstaged ?? []).length,
        untracked: (changeSet.untracked ?? []).length,
        deleted: (changeSet.deleted ?? []).length,
        renamed: (changeSet.renamed ?? []).length,
        ignored: (changeSet.ignored ?? []).length,
      },
      sourceChanges: [...(changeSet.sourceChanges ?? [])],
      ignored: [...(changeSet.ignored ?? [])],
    } : null,
    plan: plan ? {
      version: plan.version,
      fileLevel: plan.fileLevel === true,
      needsFull: plan.needsFull === true,
      fullReason: plan.fullReason ?? '',
      summary: plan.summary ?? null,
      counts: plan.counts ?? null,
      changedComponents: [...(plan.changedComponents ?? [])],
      cosmeticComponents: [...(plan.cosmeticComponents ?? [])],
      structuralComponents: [...(plan.structuralComponents ?? [])],
      // 每个 action 都要有原因：这是「可复盘」的最低要求
      actions: (plan.actions ?? []).map((a) => ({
        name: a.name,
        action: a.action,
        reason: a.reason ?? '',
        sources: [...(a.sources ?? [])],
        changedComponents: [...(a.changedComponents ?? [])],
        impactedBy: [...(a.impactedBy ?? [])],
        newFiles: [...(a.newFiles ?? [])],
        staleIssues: (a.staleIssues ?? []).map((i) => ({ kind: i.kind, detail: i.detail })),
      })),
      unmappedChanges: [...(plan.unmappedChanges ?? [])],
      routedTo: (plan.routedTo ?? []).map((r) => ({ file: r.file, name: r.name })),
      missingSources: (plan.missingSources ?? []).map((m) => ({ name: m.name, reason: m.reason })),
      warnings: [...(plan.warnings ?? [])],
    } : null,
    results: (results ?? []).map((r) => ({
      name: r.name,
      ok: r.ok === true,
      stopReason: r.stopReason ?? null,
      error: r.error ? String(r.error).slice(0, 300) : null,
    })),
    qualityIssues: (qualityIssues ?? []).map((q) => ({ name: q.name ?? null, issue: String(q.issue ?? q.detail ?? '').slice(0, 300) })),
    outcome: judged.outcome,
    blockers: judged.blockers,
    canAdvanceBaseline: judged.canAdvanceBaseline,
    writtenCount: judged.writtenCount,
    failedCount: judged.failedCount,
    notes: (notes ?? []).slice(-20),
    wikiPath: wikiPath ?? null,
  }
}

export function recordPath(wikiPath) {
  return path.join(wikiPath, ...UPDATE_RECORD_REL.split('/'))
}

export function saveUpdateRecord(wikiPath, record, fsImpl = fs) {
  if (!wikiPath) return { ok: false, reason: '没有 wiki 路径' }
  try {
    const file = recordPath(wikiPath)
    fsImpl.mkdirSync(path.dirname(file), { recursive: true })
    fsImpl.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 200) }
  }
}

export function loadUpdateRecord(wikiPath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(recordPath(wikiPath), 'utf8')
    const rec = JSON.parse(raw)
    if (rec?.version !== UPDATE_RECORD_VERSION) return null
    return rec
  } catch {
    return null
  }
}

// 面板/工具文案：done / partial / failed 三态必须一眼能分。
export function describeOutcome(outcome, blockers = []) {
  if (outcome === 'done') return '完成（所有变化已消化）'
  if (outcome === 'partial') {
    const first = blockers[0]
    return `部分完成（${blockers.length} 项未满足${first ? `：${String(first.detail ?? first.kind).slice(0, 120)}` : ''}）`
  }
  if (outcome === 'cancelled') return '已取消'
  if (outcome === 'failed') {
    const first = blockers[0]
    return `失败（${first ? String(first.detail ?? first.kind).slice(0, 160) : '无可用成果'}）`
  }
  return String(outcome ?? '未知')
}
