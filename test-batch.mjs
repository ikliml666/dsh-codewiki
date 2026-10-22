// test-batch.mjs — 编译执行链自检：纯函数（源码装填/token 估算/任务装配/本地规划/
// 横切装填/仓库勘探/会话通道收割）+ mock fetch（百炼普通端点/并发池/取消/失败记账）
// 跑法：node test-batch.mjs（Node ≥20，全局 fetch/FormData/Blob）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines,
  prepareArticleTasks, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, resolveBatchApiKey, listModelCatalog, installWebServer,
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
fs.writeFileSync(path.join(workRoot, 'big.ts'), 'x'.repeat(300 * 1024))
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
const bigPrep = prepareArticleTasks([{ name: 'modules/big.md', mission: '大任务', sources: ['big.ts'], articlePath: path.join(outDir, 'big.md') }], { cwd: workRoot, language: '中文' })
check(bigPrep.prepared.length === 0 && bigPrep.sessionTasks.length === 1, '单文件超 28k 预算且分不出多批 → 会话通道（不再升大档）')
check(bigPrep.sessionTasks[0].batchPrompt.includes('xxx') && bigPrep.sessionTasks[0].batchPrompt.length > 300 * 1024, '会话通道任务 prompt 按 200k 大档装填、内联完整源码')
const hugePrep = prepareArticleTasks([{ name: 'modules/huge.md', mission: '超大任务', sources: ['huge.ts'], articlePath: path.join(outDir, 'huge.md') }], { cwd: workRoot, language: '中文' })
check(hugePrep.prepared.length === 0 && hugePrep.sessionTasks.length === 1, '单文件连 200k 大档都装不下 → 会话通道（超大兜底已删除）')

// 3b. prepareArticleTasks：多文件超预算 → 观察→合成分割
section('prepareArticleTasks：多文件超预算 → 观察批分割')
for (let i = 0; i < 4; i += 1) {
  fs.writeFileSync(path.join(workRoot, `part${i}.ts`), 'y'.repeat(90 * 1024))
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
check(obsTasks.every((t) => estimateTokens(t.batchPrompt) <= 28000), `观察批 prompt 全部 ≤28k token（最大 ${Math.max(...obsTasks.map((t) => estimateTokens(t.batchPrompt)))}）`)
check(obsTasks.every((t) => t.splitFor === 'modules/splitme.md'), '观察任务 splitFor 指向所属文章')
check(obsTasks.every((t) => t.composePlan?.articlePath === path.join(outDir, 'splitme.md') && t.composePlan?.mission === '分割任务'), 'composePlan 携带 articlePath 与 mission')
check(obsTasks.some((t) => t.batchPrompt.includes('第 1 批')) && obsTasks.some((t, i) => t.batchPrompt.includes(`第 ${i + 1} 批`)), '观察 prompt 标注批次序号')
const plainStill = prepareArticleTasks([{ name: 'modules/plain.md', mission: '普通任务', sources: ['src.ts'], articlePath: path.join(outDir, 'plain.md') }], { cwd: workRoot, language: '中文' })
check(plainStill.prepared.length === 1 && !plainStill.prepared[0].name.includes('#obs'), '预算内普通任务不分割')

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

// ---------- 4. runRealtimeTasks：普通端点并发池 ----------
section('runRealtimeTasks：百炼普通端点与请求体')
const originalFetch = globalThis.fetch
let batchCalls = []
let handler = null // 可切换的 fetch 处理器（url, init）=> Response-like
globalThis.fetch = async (url, init = {}) => {
  const rec = { url: String(url), body: init.body ? JSON.parse(init.body) : null, signal: init.signal }
  batchCalls.push(rec)
  return handler(rec, init)
}
const kmTasks = [
  { customId: 'b0', name: 'modules/b0.md', articlePath: path.join(outDir, 'b0.md'), batchPrompt: '批量任务A' },
  { customId: 'b1', name: '_mem', keepInMemory: true, batchPrompt: '批量任务B' },
]
handler = () => mockJson({ choices: [{ message: { content: '---\ntitle: B\n---\n批量结果' } }], usage: { output_tokens: 64 } })
const batchNotes = []
const batchRes = await runRealtimeTasks(kmTasks, {
  apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0, concurrency: 2,
  notes: batchNotes,
})
check(batchCalls.length === 2, '每任务一个同步请求（2 任务 2 请求）')
check(batchCalls.every((c) => c.url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'), '请求打百炼普通端点（dashscope.aliyuncs.com）')
check(batchCalls[0].body.model === 'qwen3.7-flash' && batchCalls[0].body.enable_thinking === false, 'body 顶层 model + enable_thinking:false（budget=0）')
check(!('thinking_budget' in batchCalls[0].body), 'budget=0 不带 thinking_budget 键')
check(batchCalls[0].body.messages.length === 1 && batchCalls[0].body.messages[0].content === '批量任务A', '单条 user 消息承载 prompt')
check(batchRes.size === 2 && batchRes.get('b0').ok && fs.readFileSync(path.join(outDir, 'b0.md'), 'utf8').includes('批量结果'), '磁盘任务落盘成功')
check(batchRes.get('b1').ok && batchRes.get('b1').content.includes('批量结果'), 'keepInMemory 结果带 content')

section('runRealtimeTasks：思考参数与 tps 采样')
batchCalls = []
const tpsDone = []
handler = () => mockJson({ choices: [{ message: { content: 'ok' } }], usage: { output_tokens: 128 } })
await runRealtimeTasks(
  [{ customId: 'x', name: '_x', keepInMemory: true, batchPrompt: 'P' }],
  { apiKey: 'sk', model: 'm', thinkingBudget: 1024, concurrency: 1, notes: [], onTaskDone: (s) => tpsDone.push(s) },
)
check(batchCalls[0].body.enable_thinking === true && batchCalls[0].body.thinking_budget === 1024, 'budget=1024 → enable_thinking:true + thinking_budget:1024（body 顶层）')
check(!JSON.stringify(batchCalls[0].body.messages).includes('thinking'), '思考参数不进 messages')
check(tpsDone.length === 1 && tpsDone[0].outputTokens === 128 && tpsDone[0].durationMs >= 0, 'onTaskDone 上报 outputTokens/durationMs')

section('runRealtimeTasks：外部 signal 中止')
batchCalls = []
const abortAc = new AbortController()
handler = () => mockJson({ choices: [{ message: { content: 'late' } }] })
const abortPromise = runRealtimeTasks(
  ['a0', 'a1', 'a2'].map((id, i) => ({ customId: id, name: `modules/a${i}.md`, articlePath: path.join(outDir, `a${i}.md`), batchPrompt: `任务${i}` })),
  { apiKey: 'sk', model: 'm', thinkingBudget: 0, concurrency: 1, notes: [], signal: abortAc.signal },
)
abortAc.abort()
const abortedRes = await abortPromise
check(abortedRes.size < 3, `中止后不再消费剩余任务（结果 ${abortedRes.size}/3）`)

// ---------- 5. runRealtimeTasks：失败记账 ----------
section('runRealtimeTasks：并发池 + 失败记账')
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body)
    if (body.model !== 'qwen3.7-flash') throw new Error('model 透传缺失')
    const prompt = body.messages[0].content
    if (prompt.includes('boom')) throw new Error('simulated network error')
    return mockJson({ choices: [{ message: { content: prompt.includes('km') ? '内存结果' : '---\ntitle: R\n---\n实时结果' } }] })
  }
  throw new Error(`mock fetch 未路由：${u}`)
}
const rtNotes = []
const rtDisk = path.join(outDir, 'rt.md')
const rtTasks = [
  { customId: 'rt0', name: 'modules/rt.md', articlePath: rtDisk, batchPrompt: '写文章' },
  { customId: 'rt1', name: '_mem', keepInMemory: true, batchPrompt: 'km 任务' },
  { customId: 'rt2', name: 'modules/boom.md', articlePath: path.join(outDir, 'boom.md'), batchPrompt: 'boom 任务' },
]
const rt = await runRealtimeTasks(rtTasks, { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0, concurrency: 2, notes: rtNotes })
check(rt.size === 3, '返回 3 条结果（Map）')
check(rt.get('rt0').ok && fs.readFileSync(rtDisk, 'utf8').includes('实时结果'), '磁盘任务落盘成功')
check(rt.get('rt1').ok && rt.get('rt1').content === '内存结果', 'keepInMemory 结果带 content')
check(rt.get('rt2').ok === false && rtNotes.some((n) => n.includes('simulated network error')), '失败记账进 notes，不中断其他任务')
check(!fs.existsSync(path.join(outDir, 'boom.md')), '失败任务不落盘')

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

globalThis.fetch = originalFetch
fs.rmSync(tmpRoot, { recursive: true, force: true })
fs.rmSync(workRoot, { recursive: true, force: true })
fs.rmSync(scanRoot, { recursive: true, force: true })

// ---- runRealtimeTasks：宿主 llm 通道（batchProvider 非空时不打百炼）----
section('runRealtimeTasks：宿主 llm 通道')
{
  // 假 llm 服务：记录调用，按 stream 协议吐 block-start/text-delta/usage/finish
  const llmCalls = []
  const fakeLlm = {
    async *stream(opts) {
      llmCalls.push({ provider: opts.provider, model: opts.model, text: opts.messages?.[0]?.content?.[0]?.text })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '---\ntitle: L\n---\nllm 通道结果' }
      yield { type: 'usage', usage: { outputTokens: 77 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const before = batchCalls.length
  const llmRes = await runRealtimeTasks(
    [{ customId: 'l0', name: '_l0', keepInMemory: true, batchPrompt: 'llm 任务' }],
    { provider: 'local-9b', llm: fakeLlm, model: 'qwen-9b', concurrency: 1, notes: [] },
  )
  check(batchCalls.length === before, 'provider 非空时不打百炼 fetch')
  check(llmCalls.length === 1 && llmCalls[0].provider === 'local-9b' && llmCalls[0].model === 'qwen-9b', '经宿主 llm 服务按所选 provider/model 调用')
  check(llmCalls[0].text === 'llm 任务', 'prompt 原样进 messages')
  check(llmRes.get('l0')?.ok === true && llmRes.get('l0').content.includes('llm 通道结果'), 'llm 通道结果入账')
}

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

// ---- resolveBatchApiKey：凭证解析链（显式配置 > 宿主凭据库）----
console.log('\n== resolveBatchApiKey ==')
const credSvc = {
  resolve: async (ref) => ref === 'ALIYUN_BAILIAN_API_KEY'
    ? { value: 'sk-cred-1', source: 'file' }
    : undefined,
}
check((await resolveBatchApiKey(null, { batchApiKey: 'sk-explicit' })).key === 'sk-explicit', '显式 batchApiKey 最优先（source=config）')
check((await resolveBatchApiKey(null, {})) === null, '无宿主上下文返回 null')
check((await resolveBatchApiKey({}, {})) === null, 'inject 不是函数返回 null')
const viaCred = await resolveBatchApiKey(
  { inject: async (deps) => deps.includes('credentials') ? { credentials: credSvc } : undefined },
  {},
)
check(viaCred?.key === 'sk-cred-1' && viaCred.source === 'credentials(file)', '经宿主凭据库取到模型渠道凭证并记录来源')
const viaArray = await resolveBatchApiKey(
  { inject: async () => [credSvc] },
  {},
)
check(viaArray?.key === 'sk-cred-1' && viaArray.source === 'credentials(file)', 'inject 返回数组形态同样可用')
check((await resolveBatchApiKey({ inject: async () => ({ credentials: { resolve: async () => undefined } }) }, {})) === null, '凭据库无该条目返回 null')
check((await resolveBatchApiKey({ inject: async () => { throw new Error('no service') } }, {})) === null, 'inject 抛错（服务缺失）返回 null')

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
  fs.rmSync(faRoot, { recursive: true, force: true })
}

console.log(`\n${failures.length ? 'FAIL' : 'ALL PASS'}：${passed} 通过，${failures.length} 失败`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
