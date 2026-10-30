// 更新记录与终态判定测试（P0-2）：把「部分失败仍成功」这条缺陷钉死。
//
// 旧实现（index.js:2775-2776）只有 `writtenCount === 0` 才失败，其余一律 done。
// 于是 1 篇成功、19 篇失败也是「完成」，而且会照常推进编译基线——
// 没写成的 19 篇再也不会被安排重写。本文件要求：任何未消化项 ⇒ partial/failed，
// 且 partial 绝不推进基线。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  judgeOutcome, buildUpdateRecord, saveUpdateRecord, loadUpdateRecord, recordPath,
  describeOutcome, isTerminalStage, TERMINAL, UPDATE_RECORD_VERSION,
} from './lib/update-record.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const planOf = (over = {}) => ({
  version: 1,
  fileLevel: false,
  needsFull: false,
  hasChanges: true,
  summary: { write: 2, keep: 0, delete: 0, review: 0 },
  counts: { interface: 1, added: 0, deleted: 0, renamed: 0, body: 0, edge: 0 },
  changedComponents: ['src/a.js#f'],
  cosmeticComponents: [],
  structuralComponents: ['src/a.js#f'],
  actions: [
    { name: 'modules/a.md', action: 'write', reason: '自身源文件变更组件 1 个', sources: ['src/a.js'], changedComponents: ['src/a.js#f'] },
    { name: 'modules/b.md', action: 'write', reason: '被依赖组件变更影响', sources: ['src/b.js'], changedComponents: ['src/a.js#f'], impactedBy: ['src/a.js#f'] },
  ],
  unmappedChanges: [],
  routedTo: [],
  missingSources: [],
  requiredNames: ['modules/a.md', 'modules/b.md'],
  warnings: [],
  ...over,
})

const resultsOf = (names, ok = true) => names.map((name) => ({ name, ok }))

await check('TERMINAL 含 partial；isTerminalStage 认它', async () => {
  assert.ok(TERMINAL.has('partial'), 'partial 必须是终态，否则服务会一直转圈')
  assert.equal(isTerminalStage('partial'), true)
  assert.equal(isTerminalStage('done'), true)
  assert.equal(isTerminalStage('articles'), false)
})

await check('全部成功 → done，可推进基线', async () => {
  const r = judgeOutcome({ plan: planOf(), results: resultsOf(['modules/a.md', 'modules/b.md']) })
  assert.equal(r.outcome, 'done')
  assert.deepEqual(r.blockers, [])
  assert.equal(r.canAdvanceBaseline, true)
  assert.equal(r.writtenCount, 2)
})

await check('1 成功 19 失败 → partial，不得推进基线（旧实现是 done）', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `modules/m${i}.md`)
  const plan = planOf({
    actions: names.map((n) => ({ name: n, action: 'write', reason: '变更命中', sources: ['src/x.js'] })),
    requiredNames: names,
    summary: { write: 20, keep: 0, delete: 0, review: 0 },
  })
  const results = [{ name: names[0], ok: true }, ...names.slice(1).map((name) => ({ name, ok: false, error: '模型输出缺 frontmatter' }))]
  const r = judgeOutcome({ plan, results })
  assert.equal(r.outcome, 'partial', `1 成功 19 失败不能 done，实际 ${r.outcome}`)
  assert.equal(r.canAdvanceBaseline, false, 'partial 绝不能推进「全部已消化」基线')
  assert.equal(r.writtenCount, 1)
  assert.equal(r.failedCount, 19)
  assert.equal(r.blockers.filter((b) => b.kind === 'article-failed').length, 19)
})

await check('全部失败 → failed（没有可交付成果）', async () => {
  const r = judgeOutcome({ plan: planOf(), results: resultsOf(['modules/a.md', 'modules/b.md'], false) })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.canAdvanceBaseline, false)
})

await check('缺页（计划要写但既没成功也没失败记录）→ partial + missing-article', async () => {
  const r = judgeOutcome({ plan: planOf(), results: [{ name: 'modules/a.md', ok: true }] })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.blockers.some((b) => b.kind === 'missing-article' && b.name === 'modules/b.md'))
  assert.equal(r.canAdvanceBaseline, false)
})

await check('未映射变更 → partial + unmapped-changes（基线不前移）', async () => {
  const r = judgeOutcome({
    plan: planOf({ unmappedChanges: ['src/util/new.js'] }),
    results: resultsOf(['modules/a.md', 'modules/b.md']),
  })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.blockers.some((b) => b.kind === 'unmapped-changes'))
  assert.equal(r.canAdvanceBaseline, false)
})

await check('文章缺 source_files → partial + missing-sources', async () => {
  const r = judgeOutcome({
    plan: planOf({ missingSources: [{ name: 'modules/orphan.md', reason: 'frontmatter 缺 source_files' }] }),
    results: resultsOf(['modules/a.md', 'modules/b.md']),
  })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.blockers.some((b) => b.kind === 'missing-sources'))
})

await check('质量闸门失败 → partial + quality blocker', async () => {
  const r = judgeOutcome({
    plan: planOf(),
    results: resultsOf(['modules/a.md', 'modules/b.md']),
    options: { qualityIssues: [{ name: 'modules/a.md', issue: '重复 frontmatter' }] },
  })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.blockers.some((b) => b.kind === 'quality' && b.name === 'modules/a.md'))
  assert.equal(r.canAdvanceBaseline, false)
})

await check('索引校验失败 → partial + index blocker', async () => {
  const r = judgeOutcome({
    plan: planOf(), results: resultsOf(['modules/a.md', 'modules/b.md']), options: { indexOk: false },
  })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.blockers.some((b) => b.kind === 'index'))
})

await check('取消 → cancelled，不推进基线', async () => {
  const r = judgeOutcome({ plan: planOf(), results: [], options: { cancelled: true } })
  assert.equal(r.outcome, 'cancelled')
  assert.equal(r.canAdvanceBaseline, false)
})

await check('无变更且无失败 → done（不该因为「没写文章」就失败）', async () => {
  const plan = planOf({ hasChanges: false, actions: [{ name: 'modules/a.md', action: 'keep', reason: '无实质变更', sources: ['src/a.js'] }], requiredNames: [] })
  const r = judgeOutcome({ plan, results: [] })
  assert.equal(r.outcome, 'done')
  assert.equal(r.canAdvanceBaseline, true)
})

await check('full 编译没有 plan：任务清单里的缺页同样拦基线', async () => {
  const r = judgeOutcome({
    plan: null,
    results: [{ name: 'modules/a.md', ok: true }, { name: 'modules/b.md', ok: false, stopReason: 'error' }],
    options: { expectedNames: ['modules/a.md', 'modules/b.md', 'modules/c.md'] },
  })
  assert.equal(r.outcome, 'partial', JSON.stringify(r.blockers))
  assert.ok(r.blockers.some((b) => b.kind === 'missing-article' && b.name === 'modules/c.md'), '计划外任务清单缺页必须记 missing-article')
  assert.ok(r.blockers.some((b) => b.kind === 'article-failed' && b.name === 'modules/b.md'))
  assert.equal(r.canAdvanceBaseline, false)
})

await check('extraBlockers：调用方补充的硬阻塞同样降 partial', async () => {
  const plan = planOf({ actions: [{ name: 'modules/a.md', action: 'write', reason: '源码变了', sources: ['src/a.js'] }], requiredNames: ['modules/a.md'] })
  const clean = judgeOutcome({ plan, results: [{ name: 'modules/a.md', ok: true }] })
  assert.equal(clean.outcome, 'done')
  const blocked = judgeOutcome({ plan, results: [{ name: 'modules/a.md', ok: true }], options: { extraBlockers: [{ kind: 'git-base', detail: '编译基线不可达，本次退回全量' }] } })
  assert.equal(blocked.outcome, 'partial')
  assert.equal(blocked.canAdvanceBaseline, false)
  assert.ok(blocked.blockers.some((b) => b.kind === 'git-base'))
})

await check('buildUpdateRecord：每个 action 都带原因、可 JSON 往返', async () => {
  const rec = buildUpdateRecord({
    jobId: 'job-1', scope: 'auto', plan: planOf(),
    results: resultsOf(['modules/a.md', 'modules/b.md']),
    changeSet: { baseCommit: 'abc', headCommit: 'def', state: 'ok', ok: true, sourceChanges: ['src/a.js'], committed: [{ path: 'src/a.js' }], staged: [], unstaged: [], untracked: [], deleted: [], renamed: [], ignored: [] },
  })
  assert.equal(rec.version, UPDATE_RECORD_VERSION)
  assert.equal(rec.outcome, 'done')
  for (const a of rec.plan.actions) assert.ok(a.reason, `${a.name} 缺原因`)
  assert.equal(rec.changeSet.counts.committed, 1)
  const round = JSON.parse(JSON.stringify(rec))
  assert.equal(round.outcome, rec.outcome)
  assert.equal(round.plan.actions.length, 2)
})

await check('buildUpdateRecord：job 只存摘要，不把整图塞进记录', async () => {
  const plan = planOf({ changedComponents: Array.from({ length: 500 }, (_, i) => `src/big.js#f${i}`) })
  const rec = buildUpdateRecord({ plan, results: resultsOf(['modules/a.md', 'modules/b.md']) })
  assert.equal(rec.plan.changedComponents.length, 500, '组件 id 清单保留（可复盘）')
  assert.equal('graph' in rec, false, '记录里不该有整张符号图')
  assert.equal('tasks' in rec, false, '记录里不该有任务快照')
})

await check('落盘与回读：.codewiki/temp/update-record.json', async () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-'))
  const rec = buildUpdateRecord({ jobId: 'job-2', plan: planOf(), results: resultsOf(['modules/a.md', 'modules/b.md']) })
  const w = saveUpdateRecord(wiki, rec)
  assert.equal(w.ok, true, w.reason)
  assert.ok(fs.existsSync(path.join(wiki, 'temp', 'update-record.json')))
  assert.equal(recordPath(wiki).endsWith(path.join('temp', 'update-record.json')), true)
  const back = loadUpdateRecord(wiki)
  assert.equal(back.outcome, 'done')
  assert.equal(back.jobId, 'job-2')
})

await check('版本不符的记录不认（避免旧格式被当新格式读）', async () => {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr2-'))
  fs.mkdirSync(path.join(wiki, 'temp'), { recursive: true })
  fs.writeFileSync(path.join(wiki, 'temp', 'update-record.json'), JSON.stringify({ version: 999, outcome: 'done' }), 'utf8')
  assert.equal(loadUpdateRecord(wiki), null)
})

await check('describeOutcome：三态文案一眼可分，且带首个阻塞原因', async () => {
  assert.match(describeOutcome('done'), /完成/)
  assert.match(describeOutcome('partial', [{ kind: 'article-failed', detail: '缺 frontmatter' }]), /部分完成/)
  assert.match(describeOutcome('partial', [{ kind: 'article-failed', detail: '缺 frontmatter' }]), /缺 frontmatter/)
  assert.match(describeOutcome('failed', [{ kind: 'x', detail: '模型不可用' }]), /失败/)
  assert.match(describeOutcome('cancelled'), /取消/)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
