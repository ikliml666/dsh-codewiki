// test-batch.mjs — 编译执行链自检：纯函数（源码装填/token 估算/任务装配/本地规划/
// 横切装填/仓库勘探/会话通道收割）+ mock 宿主 llm 服务（并发池/取消/失败记账/思考档位下发）
// 跑法：node test-batch.mjs（Node ≥20）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines,
  buildSessionSteerText,
  prepareArticleTasks, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer,
  validateArticleEnvelope,
} from './index.js'

let passed = 0
const failures = []
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`) }
  else { failures.push(msg); console.log(`  ✗ ${msg}`) }
}
function section(name) { console.log(`\n== ${name} ==`) }
const mockJson = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) })

// ---------- 1. estimateTokens ----------
section('estimateTokens：CJK 与 ASCII 粗算')
check(estimateTokens('中文') === 2, 'CJK 每字 1 token')
check(estimateTokens('abcdefghij') === 3, 'ASCII 10 字符 → ceil(10/3.5)=3')
check(estimateTokens('') === 0, '空串为 0')
check(estimateTokens('中文abcdef') === 4, '混合计费（2 CJK + ceil(5/3.5)=2）')

// ---------- 2. collectSources（token 预算） ----------
section('collectSources：装填/缺失/token 预算')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-batch-test-'))
fs.writeFileSync(path.join(tmpRoot, 'a.ts'), 'export const A = 1\n')
fs.writeFileSync(path.join(tmpRoot, 'b.ts'), 'export const B = 2\n')
const cs = collectSources(tmpRoot, ['a.ts', 'missing.ts', 'b.ts'])
check(cs.text.includes('### a.ts') && cs.text.includes('1| export const A = 1'), '内容内联带相对路径标题与行号前缀')
check(cs.text.includes('missing.ts') && cs.text.includes('文件不存在'), '缺失文件在文内标注')
check(cs.skipped.length === 0 && cs.oversized === false, '预算充足时无跳过')
check(!/\n39\| \n/.test(cs.text) && !cs.text.includes('| \n```\n'), '尾换行只去一个：无 39| 空行、围栏前无空行')
const tiny = collectSources(tmpRoot, ['a.ts', 'b.ts'], 10)
check(tiny.oversized === true && tiny.text.includes('export const A = 1'), '首文件即超预算 → oversized（原文返回转超大兜底）')
const firstBlock = '### a.ts\n\n```\n1| export const A = 1\n```\n\n'
const small = collectSources(tmpRoot, ['a.ts', 'b.ts'], estimateTokens(firstBlock) + 1)
check(small.oversized === false && small.skipped.includes('b.ts'), '预算装不下第二文件 → skipped')

// ---------- 2b. numberLines：行号前缀与尾换行 ----------
section('numberLines：前缀标注与尾换行处理')
check(numberLines('a\nb\n').endsWith('2| b'), '单尾换行：末行 2| b，无多余空行')
check(numberLines('a\n\n').endsWith('2| '), '双尾换行：第二个空行是真实一行（2| 保留）')
check(numberLines('a\r\nb\r\n').endsWith('2| b'), 'CRLF：前缀正确、行尾 \\r 已剥离（末行）')
check(numberLines('').trim() === '1|', '空文件输出 1|（可接受）')

// ---------- 3. prepareArticleTasks ----------
section('prepareArticleTasks：prompt 装配与 oversized 拆分')
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-batch-work-'))
fs.writeFileSync(path.join(workRoot, 'src.ts'), 'export const S = 3\n')
fs.writeFileSync(path.join(workRoot, 'big.ts'), 'x'.repeat(420 * 1024))
fs.writeFileSync(path.join(workRoot, 'huge.ts'), 'x'.repeat(800 * 1024))
const outDir = path.join(workRoot, 'wiki', 'modules')
const plainTasks = ['t0', 't1', 't2'].map((_id, i) => ({
  name: `modules/m${i}.md`,
  mission: `任务t${i}`,
  sources: ['src.ts'],
  articlePath: path.join(outDir, `m${i}.md`),
}))
const prep = prepareArticleTasks(plainTasks, { cwd: workRoot, language: '中文' })
check(prep.prepared.length === 3 && prep.sessionTasks.length === 0, '普通任务全部进 prepared（无会话通道任务）')
check(prep.prepared[0].customId === 't0' && prep.prepared[2].customId === 't2', 'customId 按序分配')
check(prep.prepared[0].batchPrompt.includes('任务t0') && prep.prepared[0].batchPrompt.includes('中文'), 'prompt 含 mission 与语言')
check(prep.prepared[0].batchPrompt.includes('export const S = 3'), 'prompt 内联源码')
check(prep.prepared[0].batchPrompt.trimStart().startsWith('你') || prep.prepared[0].batchPrompt.includes('frontmatter'), 'prompt 含 frontmatter 规范')
const prevPath = path.join(outDir, 'm0.md')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(prevPath, '---\ntitle: 旧文\n---\n旧内容')
const withPrev = prepareArticleTasks([{ name: 'modules/m0.md', mission: '更新', sources: ['src.ts'], articlePath: prevPath, prevArticlePath: prevPath }], { cwd: workRoot, language: '中文' })
check(withPrev.prepared[0].batchPrompt.includes('旧内容'), '已有旧文作上下文进 prompt')
// 单文件超 110k 预算但在 128k 大档内：0.10.2 起不再误转会话通道，直接用大档单请求插件内写完
const bigPrep = prepareArticleTasks([{ name: 'modules/big.md', mission: '大任务', sources: ['big.ts'], articlePath: path.join(outDir, 'big.md') }], { cwd: workRoot, language: '中文' })
check(bigPrep.prepared.length === 1 && bigPrep.sessionTasks.length === 0, '单文件超 110k 但装得进 128k 大档 → 插件内大档单请求（不转会话通道）')
check(bigPrep.prepared[0].batchPrompt.includes('xxx') && bigPrep.prepared[0].batchPrompt.length > 300 * 1024, '大档单请求 prompt 内联完整源码（未被截断）')
check(!bigPrep.prepared[0].name.includes('#obs'), '大档单请求不拆观察批（单文件分不出多批）')
const hugePrep = prepareArticleTasks([{ name: 'modules/huge.md', mission: '超大任务', sources: ['huge.ts'], articlePath: path.join(outDir, 'huge.md') }], { cwd: workRoot, language: '中文' })
check(hugePrep.prepared.length === 0 && hugePrep.sessionTasks.length === 1, '单文件连 128k 大档都装不下 → 会话通道（唯一兜底）')
check(estimateTokens(hugePrep.sessionTasks[0].batchPrompt) > 128000, '连大档都装不下时 prompt 仍按原始全长装填（交会话模型自行处理）')

// 3b. prepareArticleTasks：多文件超预算 → 观察→合成分割
section('prepareArticleTasks：多文件超预算 → 观察批分割')
for (let i = 0; i < 4; i += 1) {
  fs.writeFileSync(path.join(workRoot, `part${i}.ts`), 'y'.repeat(140 * 1024))
}
const splitPrep = prepareArticleTasks([{
  name: 'modules/splitme.md', mission: '分割任务',
  sources: ['part0.ts', 'part1.ts', 'part2.ts', 'part3.ts'],
  articlePath: path.join(outDir, 'splitme.md'),
}], { cwd: workRoot, language: '中文' })
check(splitPrep.sessionTasks.length === 0, '分割任务不进会话通道（仍走观察批）')
const obsTasks = splitPrep.prepared.filter((t) => t.name.endsWith('#obs0') || t.name.includes('#obs'))
check(obsTasks.length >= 2, `多文件超预算拆出 ≥2 个观察批（实际 ${obsTasks.length}）`)
check(obsTasks.every((t) => t.keepInMemory === true), '观察任务 keepInMemory（不直接落盘）')
check(obsTasks.every((t) => estimateTokens(t.batchPrompt) <= 110000), `观察批 prompt 全部 ≤110k token（最大 ${Math.max(...obsTasks.map((t) => estimateTokens(t.batchPrompt)))}）`)
check(obsTasks.every((t) => t.splitFor === 'modules/splitme.md'), '观察任务 splitFor 指向所属文章')
check(obsTasks.every((t) => t.composePlan?.articlePath === path.join(outDir, 'splitme.md') && t.composePlan?.mission === '分割任务'), 'composePlan 携带 articlePath 与 mission')
check(obsTasks.some((t) => t.batchPrompt.includes('第 1 批')) && obsTasks.some((t, i) => t.batchPrompt.includes(`第 ${i + 1} 批`)), '观察 prompt 标注批次序号')
const plainStill = prepareArticleTasks([{ name: 'modules/plain.md', mission: '普通任务', sources: ['src.ts'], articlePath: path.join(outDir, 'plain.md') }], { cwd: workRoot, language: '中文' })
check(plainStill.prepared.length === 1 && !plainStill.prepared[0].name.includes('#obs'), '预算内普通任务不分割')

// 3d. 大档模型（0.10.4）：超 128k 也不交会话模型，改用 bigProvider/bigModel 在插件内写完
section('prepareArticleTasks：大档模型接管超长输入（不再交会话模型）')
const BIG = { bigProvider: 'volces-ark', bigModel: 'glm-5.3-flash', bigReasoningEffort: 'high', bigBudget: 420000 }
// huge.ts 是 800KB 文本（≈200k+ token）：hy3 的 128k 装不下，但 420k 大档装得下
const bigTierPrep = prepareArticleTasks([
  { name: 'modules/huge.md', mission: '超大任务', sources: ['huge.ts'], articlePath: path.join(outDir, 'huge.md') },
], { cwd: workRoot, language: '中文', ...BIG })
check(bigTierPrep.sessionTasks.length === 0, '开了大档：超 128k 的单文件不再进会话通道')
check(bigTierPrep.prepared.length === 1, `超长文件改由大档单请求（实际 prepared=${bigTierPrep.prepared.length}）`)
const bt = bigTierPrep.prepared[0]
check(bt.bigTier === true, '大档任务带 bigTier 标记（submitBatchFor 据此持久化模型）')
check(bt.provider === 'volces-ark' && bt.model === 'glm-5.3-flash', `大档任务自带 provider/model（实际 ${bt.provider}/${bt.model}）`)
check(bt.reasoningEffort === 'high', '大档任务自带思考档位')
check(estimateTokens(bt.batchPrompt) > 128000 && estimateTokens(bt.batchPrompt) <= 420000, `大档 prompt 介于 128k–420k（实际 ${estimateTokens(bt.batchPrompt)}）`)
// 关掉大档（留空 provider）：退回旧行为——超 128k 仍走会话通道
const noBigPrep = prepareArticleTasks([
  { name: 'modules/huge.md', mission: '超大任务', sources: ['huge.ts'], articlePath: path.join(outDir, 'huge.md') },
], { cwd: workRoot, language: '中文', bigProvider: '' })
check(noBigPrep.sessionTasks.length === 1, '大档关闭时超 128k 仍走会话通道（保持既有兜底）')
// 普通任务在开大档时仍走普通档（不被误标）
const normalPrep = prepareArticleTasks([
  { name: 'modules/plain.md', mission: '普通任务', sources: ['src.ts'], articlePath: path.join(outDir, 'plain.md') },
], { cwd: workRoot, language: '中文', ...BIG })
check(normalPrep.prepared.length === 1 && normalPrep.prepared[0].bigTier !== true, '普通任务不被标成大档')
check(normalPrep.prepared[0].provider === undefined && normalPrep.prepared[0].model === undefined, '普通任务不带 provider/model（沿用设置里的普通档）')

// ---------- 3c. 会话通道任务收割判定 ----------
section('classifySessionTask：会话通道收割三态')
const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-sess-'))
const sessFile = path.join(sessDir, 'mod.md')
const staleIso = new Date(Date.now() - 31 * 60 * 1000).toISOString()
const freshIso = new Date(Date.now() - 60 * 1000).toISOString()
check(classifySessionTask({ articlePath: sessFile, dispatchedAt: staleIso }) === 'timeout', '超过 30 分钟未见产出 → timeout')
fs.writeFileSync(sessFile, '---\ntitle: t\n---\n正文')
check(classifySessionTask({ articlePath: sessFile, dispatchedAt: staleIso }) === 'timeout', '超时判定优先：即使文章已产出也按 timeout（不收割）')
check(classifySessionTask({ articlePath: sessFile, dispatchedAt: freshIso }) === 'harvest', '派发后产出且以 frontmatter 开头 → harvest')
fs.writeFileSync(sessFile, '正在思考…')
check(classifySessionTask({ articlePath: sessFile, dispatchedAt: freshIso }) === 'wait', '产出中（无 frontmatter，写一半）→ wait')
fs.writeFileSync(sessFile, '---\ntitle: t\n---\n正文')
const old = new Date(Date.now() - 10 * 60 * 1000)
fs.utimesSync(sessFile, old, old)
check(classifySessionTask({ articlePath: sessFile, dispatchedAt: new Date().toISOString() }) === 'wait', '目标文件早于派发时间（旧文未更新）→ wait')
fs.rmSync(sessDir, { recursive: true, force: true })

// ---------- 3d. 会话通道 steer 文本：档位钉死 ----------
section('buildSessionSteerText：sessionTier 是否写进 steer 文本')
const steerSnaps = [{ name: 'modules/a.md', articlePath: 'X:/w/modules/a.md', promptFile: 'X:/t/a.prompt.txt' }]
const steerArt = buildSessionSteerText({ job: { id: 'job-t', cwd: 'X:/w', stage: 'articles' }, snapshots: steerSnaps, tier: '' })
check(!steerArt.includes('tier:'), '未填 sessionTier → 不提档位（保持自动选路旧行为）')
const steerTier = buildSessionSteerText({ job: { id: 'job-t', cwd: 'X:/w', stage: 'articles' }, snapshots: steerSnaps, tier: 'codeiwiki' })
check(steerTier.includes('tier: "codeiwiki"'), '填了 sessionTier → 文本要求显式传 tier')
check(steerTier.includes('不要依赖自动选路'), '填了 sessionTier → 明确禁止依赖自动选路')
check(steerTier.includes('X:/t/a.prompt.txt') && steerTier.includes('X:/w/modules/a.md'), '任务文件与目标路径都写进文本')
check(steerTier.includes('{') === false || !steerTier.includes('${'), '无未替换的模板占位符')
const steerReview = buildSessionSteerText({ job: { id: 'job-r', cwd: 'X:/w', stage: 'review' }, snapshots: steerSnaps, tier: 'codeiwiki' })
check(steerReview.includes('超预算校对任务') && steerReview.includes('校对指令'), 'review 阶段文案按校对措辞')
check(steerReview.includes('tier: "codeiwiki"'), 'review 阶段同样钉死档位')
const steerResend = buildSessionSteerText({ job: { id: 'job-r', cwd: 'X:/w', stage: 'review' }, snapshots: steerSnaps, tier: 'codeiwiki', resend: true })
check(steerResend.includes('重新派发') && steerResend.includes('tier: "codeiwiki"'), '重发文案带「重新派发」并仍钉死档位')
const steerNoTierResend = buildSessionSteerText({ job: { id: 'job-r', cwd: 'X:/w', stage: 'articles' }, snapshots: steerSnaps, tier: '', resend: true })
check(!steerNoTierResend.includes('tier:'), '重发且未填档位 → 不提档位')

// ---------- 4. runRealtimeTasks：宿主 llm 通道（0.10.1 起唯一通道） ----------
section('runRealtimeTasks：宿主 llm 通道与请求体')
let llmCalls = []
// fake llm 服务：按 stream 协议吐块；reply 可为字符串、函数（拿到 opts 返回文本）或 Error
function makeLlm(reply) {
  return {
    async *stream(opts) {
      llmCalls.push(opts)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const r = typeof reply === 'function' ? reply(opts) : reply
      if (r instanceof Error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MOCK_FAIL', message: r.message } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: r }
      yield { type: 'usage', usage: { outputTokens: 64 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
const promptOf = (opts) => String(opts?.messages?.[0]?.content?.[0]?.text ?? '')
const kmTasks = [
  { customId: 'b0', name: 'modules/b0.md', articlePath: path.join(outDir, 'b0.md'), batchPrompt: '批量任务A' },
  { customId: 'b1', name: '_mem', keepInMemory: true, batchPrompt: '批量任务B' },
]
const batchNotes = []
const batchRes = await runRealtimeTasks(kmTasks, {
  provider: 'workbuddy', llm: makeLlm('---\ntitle: B\ntype: module\ntags: []\nsource_files:\n  - src.ts\n---\n\n## Overview\n\n批量结果'),
  model: 'hy3', reasoningEffort: 'high', concurrency: 2, notes: batchNotes,
})
check(llmCalls.length === 2, '每任务一次流式调用（2 任务 2 次）')
check(llmCalls.every((o) => o.provider === 'workbuddy' && o.model === 'hy3'), '按所选 provider/model 路由')
check(llmCalls.every((o) => o.reasoningEffort === 'high'), '思考程度档位原样下发')
check(llmCalls[0].temperature === 0, 'temperature 固定 0')
check(llmCalls.some((o) => promptOf(o) === '批量任务A'), '单条 user 消息承载 prompt')
check(batchRes.size === 2 && batchRes.get('b0').ok && fs.readFileSync(path.join(outDir, 'b0.md'), 'utf8').includes('批量结果'), '磁盘任务落盘成功')
check(batchRes.get('b1').ok && batchRes.get('b1').content.includes('批量结果'), 'keepInMemory 结果带 content')

// 混合档分派（0.10.4）：同一池里大档任务按自带 provider/model/档位路由，普通任务走默认档
section('runRealtimeTasks：大档任务按自带模型分派（混合池）')
llmCalls = []
const mixedTasks = [
  { customId: 'n0', name: '_n0', keepInMemory: true, batchPrompt: '普通任务' },
  { customId: 'g0', name: '_g0', keepInMemory: true, batchPrompt: '大档任务', provider: 'volces-ark', model: 'glm-5.3-flash', reasoningEffort: 'max', bigTier: true },
  { customId: 'g1', name: '_g1', keepInMemory: true, batchPrompt: '大档任务2', provider: 'volces-ark', model: 'glm-5.3-flash' },
]
await runRealtimeTasks(mixedTasks, {
  provider: 'workbuddy', llm: makeLlm('---\ntitle: M\n---\n结果'),
  model: 'hy3', reasoningEffort: 'high', concurrency: 2, notes: [],
})
const callFor = (label) => llmCalls.find((o) => promptOf(o) === label)
const normalCall = callFor('普通任务')
const bigCall = callFor('大档任务')
const bigCall2 = callFor('大档任务2')
check(normalCall?.provider === 'workbuddy' && normalCall?.model === 'hy3', '普通任务沿用参数里的普通档')
check(normalCall?.reasoningEffort === 'high', '普通任务沿用参数里的思考档位')
check(bigCall?.provider === 'volces-ark' && bigCall?.model === 'glm-5.3-flash', '大档任务覆盖 provider/model')
check(bigCall?.reasoningEffort === 'max', '大档任务带自己的思考档位')
check(bigCall2?.reasoningEffort === undefined, '大档任务未指定档位时不回落普通档（用模型默认）')

// 分池限流（0.12.2）：大档任务与默认档任务各自独立计数、同时推进。
// 用带延迟的 mock llm 统计「同时在飞」的峰值——只有真正分开限流才能观测到两池各自打满。
section('runRealtimeTasks：大档与默认档并发分池')
function makeSlowLlm(reply, delayMs = 30) {
  return {
    async *stream(opts) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise((r) => setTimeout(r, delayMs))
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'usage', usage: { outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
function poolProbe() {
  const st = { normal: 0, big: 0, peakNormal: 0, peakBig: 0, total: 0, peakTotal: 0 }
  return {
    st,
    onTaskStart(t) {
      if (t.bigTier) { st.big += 1; st.peakBig = Math.max(st.peakBig, st.big) }
      else { st.normal += 1; st.peakNormal = Math.max(st.peakNormal, st.normal) }
      st.total += 1
      st.peakTotal = Math.max(st.peakTotal, st.normal + st.big)
    },
    onTaskEnd(t) {
      if (t.bigTier) st.big -= 1
      else st.normal -= 1
    },
  }
}
const mk = (id, big) => ({
  customId: id, name: `_${id}`, keepInMemory: true, batchPrompt: `任务${id}`,
  ...(big ? { provider: 'volces-ark', model: 'glm-5.3-flash', bigTier: true } : {}),
})
{
  // concurrency=2 / bigConcurrency=1：默认档被打满 2，大档单独限 1，两池并行 → 总峰值 3
  const probe = poolProbe()
  const timedTasks = [
    mk('n0'), mk('n1'), mk('n2'), mk('n3'),
    mk('g0', true), mk('g1', true), mk('g2', true),
  ]
  const res = await runRealtimeTasks(timedTasks, {
    provider: 'workbuddy', llm: makeSlowLlm('---\ntitle: P\n---\n结果'),
    model: 'hy3', concurrency: 2, bigConcurrency: 1, notes: [],
    onRequestStart: (t) => {
      probe.onTaskStart(t)
      return { onDone: () => probe.onTaskEnd(t), onError: () => probe.onTaskEnd(t) }
    },
  })
  check(res.size === 7 && [...res.values()].every((r) => r.ok), '分池后 7 个任务全部完成')
  check(probe.st.peakNormal === 2, `默认档并发打满 2（实测 ${probe.st.peakNormal}）`)
  check(probe.st.peakBig === 1, `大档并发独立限到 1（实测 ${probe.st.peakBig}）`)
  check(probe.st.peakTotal >= 2, `两池同时推进（总峰值 ${probe.st.peakTotal} ≥ 2）`)
}
{
  // bigConcurrency 不传/为 0 → 跟随默认档（等价 0.12.1 的单一池行为）
  const probe = poolProbe()
  const followTasks = [mk('g0', true), mk('g1', true), mk('g2', true), mk('g3', true)]
  await runRealtimeTasks(followTasks, {
    provider: 'workbuddy', llm: makeSlowLlm('---\ntitle: F\n---\n结果'),
    model: 'hy3', concurrency: 2, notes: [],
    onRequestStart: (t) => {
      probe.onTaskStart(t)
      return { onDone: () => probe.onTaskEnd(t), onError: () => probe.onTaskEnd(t) }
    },
  })
  check(probe.st.peakBig === 2, `bigConcurrency 缺省=跟随默认档 2（实测 ${probe.st.peakBig}）`)
}

section('runRealtimeTasks：tps 采样与取消信号')
{
  llmCalls = []
  const tpsDone = []
  await runRealtimeTasks(
    [{ customId: 'x', name: '_x', keepInMemory: true, batchPrompt: 'P' }],
    { provider: 'workbuddy', llm: makeLlm('ok'), model: 'hy3', concurrency: 1, notes: [], onTaskDone: (s) => tpsDone.push(s) },
  )
  check(tpsDone.length === 1 && tpsDone[0].outputTokens === 64 && tpsDone[0].durationMs >= 0, 'onTaskDone 上报 outputTokens/durationMs')
  check(!('reasoningEffort' in llmCalls[0]), '未配置思考程度 → 不下发 reasoningEffort（用模型默认档）')
}

section('runRealtimeTasks：外部 signal 中止')
{
  const abortAc = new AbortController()
  // 已 abort 的 signal：池子一开始就不消费任务
  abortAc.abort()
  const abortedRes = await runRealtimeTasks(
    ['a0', 'a1', 'a2'].map((id, i) => ({ customId: id, name: `modules/a${i}.md`, articlePath: path.join(outDir, `a${i}.md`), batchPrompt: `任务${i}` })),
    { provider: 'workbuddy', llm: makeLlm('late'), model: 'hy3', concurrency: 1, notes: [], signal: abortAc.signal },
  )
  check(abortedRes.size < 3, `中止后不再消费剩余任务（结果 ${abortedRes.size}/3）`)
}

// ---------- 5. runRealtimeTasks：失败记账 ----------
section('runRealtimeTasks：并发池 + 失败记账')
{
  const rtNotes = []
  const rtDisk = path.join(outDir, 'rt.md')
  const rtTasks = [
    { customId: 'rt0', name: 'modules/rt.md', articlePath: rtDisk, batchPrompt: '写文章' },
    { customId: 'rt1', name: '_mem', keepInMemory: true, batchPrompt: 'km 任务' },
    { customId: 'rt2', name: 'modules/boom.md', articlePath: path.join(outDir, 'boom.md'), batchPrompt: 'boom 任务' },
  ]
  const rt = await runRealtimeTasks(rtTasks, {
    provider: 'workbuddy',
    llm: makeLlm((opts) => promptOf(opts).includes('boom')
      ? new Error('simulated network error')
      : (promptOf(opts).includes('km') ? '内存结果' : '---\ntitle: R\ntype: module\ntags: []\nsource_files:\n  - src.ts\n---\n\n## Overview\n\n实时结果')),
    model: 'hy3', concurrency: 2, notes: rtNotes,
  })
  check(rt.size === 3, '返回 3 条结果（Map）')
  check(rt.get('rt0').ok && fs.readFileSync(rtDisk, 'utf8').includes('实时结果'), '磁盘任务落盘成功')
  check(rt.get('rt1').ok && rt.get('rt1').content === '内存结果', 'keepInMemory 结果带 content')
  check(rt.get('rt2').ok === false && rtNotes.some((n) => n.includes('simulated network error')), '失败记账进 notes，不中断其他任务')
  check(!fs.existsSync(path.join(outDir, 'boom.md')), '失败任务不落盘')
}

// ---------- 6. 本地规划兜底 ----------
section('localPlan：顶层目录分组')
const lp = localPlan([
  { path: 'src/a.ts', bytes: 10 },
  { path: 'src/b.ts', bytes: 10 },
  { path: 'README.md', bytes: 10 },
  { path: 'docs/guide/c1.md', bytes: 10 },
])
check(lp.modules.length === 3, '按顶层目录分组（src/root/docs）')
check(lp.modules.find((m) => m.name === 'src')?.files.length === 2, 'src 组收 2 个文件')
check(lp.modules.find((m) => m.name === 'root')?.files.includes('README.md'), '根文件归 root 组')
check(lp.concepts.length === 0, '兜底规划不造概念')

// ---------- 7. packArticles：横切输入装填 ----------
section('packArticles：整篇装填与头部截断')
const longText = `---\ntitle: X\n---\n\n## Overview\n\n${'概'.repeat(200)}\n\n## Key Components\n\n${'件'.repeat(200)}`
const packed = packArticles([
  { name: 'a.md', text: '短文一' },
  { name: 'b.md', text: longText },
], 250)
check(packed.includes('#### a.md') && packed.includes('短文一'), '预算内首篇整篇装填')
check(packed.includes('仅头部') && !packed.includes('## Key Components'), '后续超预算文章只装头部并标注')
check(packed.includes('## Overview'), '头部含 frontmatter 与 Overview')
const packedFit = packArticles([{ name: 'a.md', text: '短文' }], 100)
check(packedFit.includes('#### a.md') && packedFit.includes('短文'), '预算内整篇装填')

// ---------- 8. scanRepoFiles：勘探黑名单 ----------
section('scanRepoFiles：黑名单/后缀/大小上限')
const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-scan-'))
fs.mkdirSync(path.join(scanRoot, 'src'))
fs.mkdirSync(path.join(scanRoot, 'node_modules'))
fs.mkdirSync(path.join(scanRoot, '.git'))
fs.writeFileSync(path.join(scanRoot, 'src', 'good.ts'), 'export const G = 1\n')
fs.writeFileSync(path.join(scanRoot, 'node_modules', 'dep.ts'), 'export const D = 1\n')
fs.writeFileSync(path.join(scanRoot, '.git', 'config'), 'gitconfig')
fs.writeFileSync(path.join(scanRoot, 'logo.png'), 'binary')
fs.writeFileSync(path.join(scanRoot, 'huge.ts'), 'x'.repeat(300 * 1024))
fs.writeFileSync(path.join(scanRoot, 'empty.ts'), '')
const scanned = scanRepoFiles(scanRoot)
check(scanned.length === 1 && scanned[0].path === 'src/good.ts', '只收有效源码（跳过 node_modules/.git/二进制/超大/空文件）')
check(scanned[0].bytes === 'export const G = 1\n'.length, 'bytes 为文件大小')

fs.rmSync(tmpRoot, { recursive: true, force: true })
fs.rmSync(workRoot, { recursive: true, force: true })
fs.rmSync(scanRoot, { recursive: true, force: true })

// ---- runRealtimeTasks：失败通道的错误码透传 ----
section('runRealtimeTasks：宿主 llm 通道失败记账')
{
  const failLlm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'provider 未注册' } } }
    },
  }
  const notes = []
  const res = await runRealtimeTasks(
    [{ customId: 'f0', name: 'modules/f0.md', articlePath: path.join(outDir, 'f0.md'), batchPrompt: 'x' }],
    { provider: 'missing', llm: failLlm, model: 'm', concurrency: 1, notes },
  )
  check(res.get('f0')?.ok === false, 'finish kind=error → 任务失败')
  check(notes.some((n) => n.includes('NO_ADAPTER')), `失败原因进 notes（含错误码）`)
}

// ---- listModelCatalog：设置页级联下拉的数据源 ----
section('listModelCatalog：宿主 provider/model 目录')
{
  const fakeLlm = {
    listProviders: () => [
      { id: 'aliyun-bailian', displayName: '阿里百炼云' },
      { provider: 'local-9b', name: '本地 9B' }, // 兼容 provider/name 写法
      { id: '', displayName: '无 id 应被跳过' },
    ],
    listModels: async (id) => {
      if (id === 'local-9b') throw new Error('MISSING_CREDENTIAL')
      return [{ id: 'qwen3.7-flash', name: 'qwen3.7-flash' }, { id: 'qwen3-max', name: 'Qwen3 Max' }]
    },
  }
  const cat = await listModelCatalog(fakeLlm)
  check(cat.ok === true && cat.providers.length === 2, '跳过无 id 的 provider（2 个有效）')
  check(cat.providers[0].id === 'aliyun-bailian' && cat.providers[0].name === '阿里百炼云', '取 displayName 作展示名')
  check(cat.providers[0].models.length === 2 && cat.providers[0].models[1].name === 'Qwen3 Max', 'listModels 结果映射为 {id,name}')
  check(cat.providers[1].id === 'local-9b' && cat.providers[1].name === '本地 9B', '兼容 provider/name 字段写法')
  check(cat.providers[1].models.length === 0 && String(cat.providers[1].error).includes('MISSING_CREDENTIAL'), '单个 provider 失败不影响其它，条目保留并附 error')
  const none = await listModelCatalog(null)
  check(none.ok === false && none.providers.length === 0, 'llm 未注入 → ok:false 且空目录（设置页降级手填）')
}

// ---- /api/codewiki/models 端点：handler 真实跑通（模拟 ctx/res）----
section('GET /api/codewiki/models 端点')
{
  const routes = new Map()
  const fakeCtx = {
    inject: (deps, cb) => {
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => routes.set(r.path, r.handler) } })
    },
  }
  const fakeLlmSvc = {
    listProviders: () => [{ id: 'local-9b', displayName: '本地 9B' }],
    listModels: async () => [{ id: 'qwen-9b', name: 'Qwen 9B' }],
  }
  installWebServer(fakeCtx, { list: () => [], cancel: () => false }, { llm: fakeLlmSvc })
  const handler = routes.get('/api/codewiki/models')
  check(typeof handler === 'function', '端点已注册')
  const res = {
    code: null, body: null,
    writeHead(c) { this.code = c },
    end(b) { this.body = JSON.parse(b) },
  }
  await handler({ socket: { remoteAddress: '127.0.0.1' } }, res)
  check(res.code === 200 && res.body.ok === true, '回环请求 → 200 + ok:true')
  check(res.body.providers.length === 1 && res.body.providers[0].id === 'local-9b' && res.body.providers[0].models[0].id === 'qwen-9b', '目录内容为宿主 provider/model')
  // 非回环拒绝
  const res2 = { code: null, body: null, writeHead(c) { this.code = c }, end(b) { this.body = JSON.parse(b) } }
  await handler({ socket: { remoteAddress: '10.0.0.5' } }, res2)
  check(res2.code === 403 && res2.body.error === 'loopback only', '非回环请求被拒（403）')
}

// ---- resolveModelEfforts + /api/codewiki/model-efforts：思考程度从模型目录读取 ----
section('resolveModelEfforts / GET /api/codewiki/model-efforts')
{
  const effortsLlm = {
    resolveModel: async (provider, model) => {
      if (provider !== 'workbuddy' || model !== 'hy3') throw new Error('model not found')
      return {
        context: { tokens: 192000 },
        reasoning: {
          defaultEffort: 'high',
          efforts: [
            { id: 'off', name: '关闭' },
            { id: 'low', name: '低' },
            { id: 'high', name: '高', description: '默认档' },
          ],
        },
      }
    },
  }
  const okRes = await resolveModelEfforts(effortsLlm, 'workbuddy', 'hy3')
  check(okRes.ok === true && okRes.efforts.length === 3, `解析出 3 个档位（实际 ${JSON.stringify(okRes.efforts?.map((e) => e.id))}）`)
  check(okRes.defaultEffort === 'high', `带出模型默认档（实际 ${okRes.defaultEffort}）`)
  check(okRes.efforts[2].description === '默认档', '档位描述透出')
  check(okRes.context === 192000, `上下文长度透出（实际 ${okRes.context}）`)
  const badRes = await resolveModelEfforts(effortsLlm, 'workbuddy', 'nope')
  check(badRes.ok === false && badRes.efforts.length === 0 && badRes.error.includes('model not found'), '未知模型 → ok:false + 空档位 + 原因')
  const noSvc = await resolveModelEfforts(null, 'workbuddy', 'hy3')
  check(noSvc.ok === false && noSvc.error.includes('resolveModel'), 'llm 未注入 → 诚实报错（不抛）')
  const emptyEfforts = await resolveModelEfforts({ resolveModel: async () => ({}) }, 'p', 'm')
  check(emptyEfforts.ok === true && emptyEfforts.efforts.length === 0 && emptyEfforts.defaultEffort === null,
    '模型未声明档位 → ok:true + 空列表（设置页可据此提示）')

  // 端点：回环 200 + 参数校验 400 + 非回环 403
  const routes2 = new Map()
  const fakeCtx2 = {
    inject: (deps, cb) => {
      if (deps.includes('webServer')) cb({ webServer: { register: (r) => routes2.set(r.path, r.handler) } })
    },
  }
  installWebServer(fakeCtx2, { list: () => [], cancel: () => false }, { llm: effortsLlm })
  const ep = routes2.get('/api/codewiki/model-efforts')
  check(typeof ep === 'function', '端点已注册')
  const mkRes = () => ({ code: null, body: null, writeHead(c) { this.code = c }, end(b) { this.body = JSON.parse(b) } })
  const resOk = mkRes()
  await ep({ url: '/api/codewiki/model-efforts?provider=workbuddy&model=hy3', socket: { remoteAddress: '127.0.0.1' } }, resOk)
  check(resOk.code === 200 && resOk.body.ok === true && resOk.body.efforts.length === 3, '回环 + 完整参数 → 200 带档位')
  const resMissing = mkRes()
  await ep({ url: '/api/codewiki/model-efforts?provider=workbuddy', socket: { remoteAddress: '127.0.0.1' } }, resMissing)
  check(resMissing.code === 400 && resMissing.body.ok === false, '缺 model 参数 → 400')
  const res403b = mkRes()
  await ep({ url: '/api/codewiki/model-efforts?provider=workbuddy&model=hy3', socket: { remoteAddress: '10.0.0.5' } }, res403b)
  check(res403b.code === 403, '非回环请求被拒（403）')
}

// ---- 0.10.1：内置百炼直连通道的整体移除（不再导出凭证解析链）----
console.log('\n== 0.10.1 删除内置百炼直连通道 ==')
const mod = await import('./index.js')
check(mod.resolveBatchApiKey === undefined, '不再导出 resolveBatchApiKey（插件不碰任何密钥）')

// ---- fixAnchors：行号锚点确定性修正 ----
console.log('\n== fixAnchors ==')
const faRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fa-'))
fs.mkdirSync(path.join(faRoot, 'src'), { recursive: true })
fs.writeFileSync(path.join(faRoot, 'a.js'), [
  'const alpha = 1',
  'function beta() { return alpha }',
  'const gamma = beta()',
  '',
  'function delta() { return gamma }',
].join('\n'))
fs.writeFileSync(path.join(faRoot, 'src', 'b.js'), 'export function omega() {\n  return 42\n}\n')
fs.writeFileSync(path.join(faRoot, 'dup2.js'), 'function helper() { return 1 }\nfunction helper() { return 2 }\n')
const faFm = '---\ntitle: t\ntype: module\ntags: []\nsource_files: [a.js, src/b.js, dup2.js]\n---\n\n'
const fa = (body) => faFm + body
{
  const r = fixAnchors(fa('见 `delta` (`a.js:1`)。'), faRoot)
  check(r.fixed === 1 && r.text.includes('`a.js:5`'), '错行号唯一符号 → 修正')
  check(fixAnchors(fa('见 `beta` (`a.js:3`)。'), faRoot).fixed === 0, '起点行含符号（含调用出现）→ 视为已正确不动')
  check(fixAnchors(fa('见 `nope` (`a.js:9`)。'), faRoot).fixed === 0 && fixAnchors(fa('见 `nope` (`a.js:9`)。'), faRoot).unresolved.length === 1, '符号未找到 → 不动并记 unresolved')
  const amb = fixAnchors(fa('见 `helper` (`dup2.js:99`)。'), faRoot)
  check(amb.fixed === 0 && amb.unresolved.length === 1 && amb.unresolved[0].includes('歧义'), '多个声明目标 → 歧义不动')
  const def = fixAnchors(fa('见 `beta` (`a.js:1`)。'), faRoot)
  check(def.fixed === 1 && def.text.includes('`a.js:2`'), '多处出现但恰一处声明形态 → 取声明行')
  const rg = fixAnchors(fa('`delta`（`a.js:1-3`）整体。'), faRoot)
  check(rg.fixed === 1 && rg.text.includes('`a.js:5-5`'), '区间锚点 → 起点对齐符号、尾部钳到文件尾（delta 在文件末行）')
  const clamp = fixAnchors(fa('`gamma`（`a.js:1-99`）钳制。'), faRoot)
  check(clamp.fixed === 1 && clamp.text.includes('`a.js:3-5`'), '区间修正尾越界 → 钳到文件尾')
  // 倒序区间：原文 `a.js:9-7`（起点大于终点）。旧实现按 end2-start 平移尾行会算出
  // R + (7-9) = R-2，产出 `5-3` 这种起点大于终点的区间，校验永远报「区间起止有序」失败。
  // 实测 .codewiki/concepts/test-log-pairing.md 里就有一条 `index.js:902-901` 卡了很多轮编译。
  const rev = fixAnchors(fa('`delta`（`a.js:9-7`）倒序。'), faRoot)
  check(rev.fixed === 1 && /`a\.js:5-5`/.test(rev.text), '倒序区间 → 尾行按跨度翻正，起点不大于终点')
  const rev2 = fixAnchors(fa('`gamma`（`a.js:8-2`）倒序且跨多行。'), faRoot)
  check(rev2.fixed === 1 && /`a\.js:3-5`/.test(rev2.text), '倒序多行区间 → 跨度取绝对值后不越界（a.js 仅 5 行，尾钳到 5）')
  const bb = fixAnchors(fa('见 `omega` (`b.js:1`)。'), faRoot)
  check(bb.fixed === 0, 'basename 多段路径匹配（src/b.js 唯一）→ 不动因已正确')
  const bbFix = fixAnchors(fa('见 `omega` (`b.js:9`)。'), faRoot)
  check(bbFix.fixed === 1 && bbFix.text.includes('`b.js:1`'), 'basename 唯一解析 → 修正并保留原文写法')
  check(fixAnchors(fa('见 `x` (`c.js:1`)。'), faRoot).fixed === 0, '不在 source_files 清单 → 不碰')
  const crlfArt = faFm.replace('\n', '\r\n').replace(/\n/g, '\r\n') + '见 `delta` (`a.js:1`)。'
  check(fixAnchors(crlfArt, faRoot).text.includes('\r\n'), 'CRLF 文章行尾保真')
  check(fixAnchors('无 frontmatter 的 `delta` (`a.js:1`)。', faRoot).fixed === 0, '无 frontmatter → 原样')
  fs.writeFileSync(path.join(faRoot, 'dup.js'), 'x')
  fs.mkdirSync(path.join(faRoot, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(faRoot, 'sub', 'dup.js'), 'y')
  const amb2 = fixAnchors('---\nsource_files: [dup.js, sub/dup.js]\n---\n\n见 `y` (`dup.js:1`)。', faRoot)
  check(amb2.fixed === 0, 'basename 歧义（根与子目录同名）→ 不碰')
  // 一行并列多个「符号 + 锚点」：每个锚点必须各自绑定离它最近的符号，绝不能把整行拉平成
  // 同一个行号。旧实现从 syms[0] 起找第一个能解析的符号，命中后整行锚点全用它，于是
  // `alpha (a.js:1)、delta (a.js:99)` 会被改写成两处 `a.js:1`——锚点看起来都指向非空代码行，
  // 能骗过校验器，却是比原文更坏的数据（本仓 _patterns.md 曾出现同行 15 处 index.js:49）。
  const multi = fixAnchors(fa('`alpha` (`a.js:99`)、`delta` (`a.js:98`)。'), faRoot)
  check(multi.text.includes('`alpha` (`a.js:1`)') && multi.text.includes('`delta` (`a.js:5`)'),
    '一行两个锚点 → 各自绑定离自己最近的符号，不拉平成同一个行号')
  const multiOk = fixAnchors(fa('`alpha` (`a.js:1`)、`delta` (`a.js:5`)。'), faRoot)
  check(multiOk.fixed === 0 && /`alpha` \(`a\.js:1`\)、`delta` \(`a\.js:5`\)/.test(multiOk.text),
    '一行两个已正确的锚点 → 互不干扰原样保留')

  // 多锚点行的「已正确」判定必须用**已被占用**的符号来挡：同一行两个锚点不能认领同一个
  // 符号，否则第二个锚点会被改到第一个符号的行上。
  //
  // 注意这里**不能**要求「起始行含该符号就必须改成它的声明行」——单锚点行一直采用宽松
  // 判定（起始行提到该符号即认可，见上一条用例），多锚点行若改用严格判定，就会出现
  // 同一份文档单锚点行保留、多锚点行被改的不一致。真正的护栏是 used 占用 + 就近排序：
  // 第 3 行 `const gamma = beta()` 同时含两个符号，`beta` 认领第 3 行后，`gamma` 仍能
  // 各自改到它自己的位置——两个符号不会被同一个锚点抢走。
  const swap = fixAnchors(fa('`beta` (`a.js:3`)、`gamma` (`a.js:99`)。'), faRoot)
  check(swap.fixed === 1 && swap.text.includes('`gamma` (`a.js:3`)'),
    '多锚点行：认领过 beta 的第 3 行仍能被 gamma 用，gamma 锚点照常修正')
  const oneWrong = fixAnchors(fa('`alpha` (`a.js:1`)、`delta` (`a.js:99`)。'), faRoot)
  check(oneWrong.fixed === 1 && oneWrong.text.includes('`alpha` (`a.js:1`)') && oneWrong.text.includes('`delta` (`a.js:5`)'),
    '一对其一错 → 只改错的那个，不因第一个已正确就放过第二个')
  const reversed = fixAnchors(fa('`delta` (`a.js:99`)、`alpha` (`a.js:1`)。'), faRoot)
  check(reversed.fixed === 1 && reversed.text.includes('`delta` (`a.js:5`)') && reversed.text.includes('`alpha` (`a.js:1`)'),
    '锚点顺序颠倒 → 仍各按自己的符号修正')
  // 单锚点行保持宽松判定（起始行提到该符号即认可），这条钉住「不为了严格而改写全仓既有锚点」
  check(fixAnchors(fa('见 `beta` (`a.js:3`)。'), faRoot).fixed === 0,
    '单锚点行保持宽松：起始行是该符号的调用处也视为已正确')
  fs.rmSync(faRoot, { recursive: true, force: true })
}

// ---- validateArticleEnvelope：frontmatter 信封校验 ----
// 这条闸门挡的是「半截 frontmatter 文章能落盘、但整篇锚点永远不会被校正」这类静默失效，
// 光看编译成功发现不了，必须逐种坏输出各钉一条。
console.log('\n== validateArticleEnvelope ==')
{
  const C = (s) => s.join('\n')
  check(validateArticleEnvelope(C(['---', 'title: t', '---', '', '正文'])) === null,
    '正常闭合 → 合格')
  check(validateArticleEnvelope(C(['', '  ', '---', 'title: t', '---', '', '正文'])) === null,
    '前置空行/空白缩进 → 仍合格（trimStart 后判断）')
  check(validateArticleEnvelope(C(['---', 'title: t', '---'])) === null,
    '只有 frontmatter 没有正文 → 合格（信封完整即可）')
  check(validateArticleEnvelope(C(['---\r', 'title: t\r', '---\r', '', '正文'])) === null,
    'CRLF 行尾 → 合格')
  check(/缺 frontmatter/.test(validateArticleEnvelope('正文直接开始，没有 frontmatter')),
    '缺开头 --- → 判为缺 frontmatter')
  check(/缺 frontmatter/.test(validateArticleEnvelope('')),
    '空串 → 判为缺 frontmatter')
  check(/缺 frontmatter/.test(validateArticleEnvelope(null)),
    'null → 判为缺 frontmatter（不能抛错）')
  check(/缺 frontmatter/.test(validateArticleEnvelope(42)),
    '非字符串 → 判为缺 frontmatter（不能抛错）')
  check(/未闭合/.test(validateArticleEnvelope(C(['---', 'title: t', '', '正文']))),
    '缺结束 --- → 判为未闭合')
  check(/未闭合/.test(validateArticleEnvelope(C(['---', 'title: t']))),
    'frontmatter 只有开头 → 判为未闭合')
  check(/未闭合/.test(validateArticleEnvelope(C(['---', '', '正文', '--- 出现在正文里']))),
    '结束 --- 后没有换行收尾且非独占行 → 判为未闭合')
  // 正文里的 --- 不能被误当成 frontmatter 结尾：只有紧随首个 --- 段落后那一个才算
  check(validateArticleEnvelope(C(['---', 'title: t', '---', '', '正文', '', '---', '', '分隔线'])) === null,
    '正文里的 --- 分隔线不影响信封判定')
}

console.log(`\n${failures.length ? 'FAIL' : 'ALL PASS'}：${passed} 通过，${failures.length} 失败`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
