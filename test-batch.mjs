// test-batch.mjs — 批量推理流水线自检：纯函数（JSONL 构建/结果解析/源码装填/token 估算/
// 任务装配/本地规划/横切装填/仓库勘探）+ mock fetch（提交/收尾/实时兜底）全流程
// 跑法：node test-batch.mjs（Node ≥20，全局 fetch/FormData/Blob）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildBatchJsonl, parseBatchResults, collectSources, estimateTokens,
  prepareArticleTasks, submitBatch, settleBatch, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, resolveBatchApiKey,
} from './index.js'

let passed = 0
const failures = []
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`) }
  else { failures.push(msg); console.log(`  ✗ ${msg}`) }
}
function section(name) { console.log(`\n== ${name} ==`) }

// ---------- 1. estimateTokens ----------
section('estimateTokens：CJK 与 ASCII 粗算')
check(estimateTokens('中文') === 2, 'CJK 每字 1 token')
check(estimateTokens('abcdefghij') === 3, 'ASCII 10 字符 → ceil(10/3.5)=3')
check(estimateTokens('') === 0, '空串为 0')
check(estimateTokens('中文abcdef') === 4, '混合计费（2 CJK + ceil(5/3.5)=2）')

// ---------- 2. buildBatchJsonl ----------
section('buildBatchJsonl：思考参数位置与取值')
const tasks = [
  { customId: 't0', batchPrompt: 'PROMPT-A' },
  { customId: 't1', batchPrompt: 'PROMPT-B' },
]
const off = buildBatchJsonl(tasks, { model: 'qwen3.7-flash', thinkingBudget: 0 })
check(off.endsWith('\n'), '尾随换行（JSONL 文件规范）')
const offLines = off.trim().split('\n')
check(offLines.length === 2, '两任务两行')
const off0 = JSON.parse(offLines[0])
check(off0.custom_id === 't0' && off0.method === 'POST' && off0.url === '/v1/chat/completions', '行结构 custom_id/method/url')
check(off0.body.model === 'qwen3.7-flash', 'model 在 body 顶层')
check(off0.body.enable_thinking === false, 'budget=0 → enable_thinking:false')
check(!('thinking_budget' in off0.body), 'budget=0 不带 thinking_budget 键')
check(off0.body.messages.length === 1 && off0.body.messages[0].content === 'PROMPT-A', '单条 user 消息承载 prompt')
const on0 = JSON.parse(buildBatchJsonl([{ customId: 'x', batchPrompt: 'P' }], { model: 'm', thinkingBudget: 1024 }).trim())
check(on0.body.enable_thinking === true && on0.body.thinking_budget === 1024, 'budget=1024 → enable_thinking:true + thinking_budget:1024（body 顶层）')
check(!JSON.stringify(on0.body.messages).includes('thinking'), '思考参数不进 messages')

// ---------- 3. parseBatchResults ----------
section('parseBatchResults：结果行/错误行/坏行')
const output = [
  JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { choices: [{ message: { content: '# 文章A' } }], usage: { output_tokens: 128 } } } }),
  JSON.stringify({ custom_id: 'b', response: { status_code: 400, body: {} } }),
  'not-json-garbage',
].join('\n')
const errors = [JSON.stringify({ custom_id: 'c', error: { message: 'quota exceeded' } })].join('\n')
const parsed = parseBatchResults(output, errors)
check(parsed.get('a')?.ok === true && parsed.get('a').content === '# 文章A', '200 行 → ok + content')
check(parsed.get('a')?.outputTokens === 128, 'usage.output_tokens 提取为 outputTokens（用量累计入口）')
check(parsed.get('b')?.ok === false && parsed.get('b').error.includes('400'), '非 200 行 → 失败，error 带 HTTP 码')
check(parsed.get('c')?.ok === false && parsed.get('c').error === 'quota exceeded', '错误文件行 → 失败 + message')
check(parsed.size === 3, '坏行跳过不占位（size=3）')

// ---------- 4. collectSources（token 预算） ----------
section('collectSources：装填/缺失/token 预算')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-batch-test-'))
fs.writeFileSync(path.join(tmpRoot, 'a.ts'), 'export const A = 1\n')
fs.writeFileSync(path.join(tmpRoot, 'b.ts'), 'export const B = 2\n')
const cs = collectSources(tmpRoot, ['a.ts', 'missing.ts', 'b.ts'])
check(cs.text.includes('### a.ts') && cs.text.includes('export const A = 1'), '内容内联带相对路径标题')
check(cs.text.includes('missing.ts') && cs.text.includes('文件不存在'), '缺失文件在文内标注')
check(cs.skipped.length === 0 && cs.oversized === false, '预算充足时无跳过')
const tiny = collectSources(tmpRoot, ['a.ts', 'b.ts'], 10)
check(tiny.oversized === true && tiny.text.includes('export const A = 1'), '首文件即超预算 → oversized（原文返回转实时兜底）')
const firstBlock = '### a.ts\n\n```\nexport const A = 1\n```\n\n'
const small = collectSources(tmpRoot, ['a.ts', 'b.ts'], estimateTokens(firstBlock) + 1)
check(small.oversized === false && small.skipped.includes('b.ts'), '预算装不下第二文件 → skipped')

// ---------- 5. prepareArticleTasks ----------
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
check(prep.prepared.length === 3 && prep.oversized.length === 0, '普通任务全部进 prepared')
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
check(bigPrep.prepared.length === 1 && bigPrep.oversized.length === 0, '单文件超 28k 预算 → 升大档（200k）重装仍走批量')
check(bigPrep.prepared[0].batchPrompt.includes('xxx') && bigPrep.prepared[0].batchPrompt.length > 300 * 1024, '大档任务 prompt 内联完整源码')
const hugePrep = prepareArticleTasks([{ name: 'modules/huge.md', mission: '超大任务', sources: ['huge.ts'], articlePath: path.join(outDir, 'huge.md') }], { cwd: workRoot, language: '中文' })
check(hugePrep.prepared.length === 0 && hugePrep.oversized.length === 1, '单文件连 200k 大档都装不下 → oversized（转实时兜底）')

// ---------- 6. submitBatch：mock fetch 提交 + 断点 ----------
section('submitBatch：mock fetch 提交与断点落盘')
let uploadedJsonl = ''
const mockJson = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) })
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.endsWith('/files') && init.method === 'POST') {
    uploadedJsonl = await init.body.get('file').text()
    return mockJson({ id: 'file-1' })
  }
  if (u.endsWith('/batches') && init.method === 'POST') {
    const body = JSON.parse(init.body)
    check(body.input_file_id === 'file-1' && body.endpoint === '/v1/chat/completions' && body.completion_window === '24h', '批次创建参数（input_file_id/endpoint/completion_window）')
    return mockJson({ id: 'batch-1', status: 'validating' })
  }
  throw new Error(`mock fetch 未路由：${u}`)
}
const stateFile = path.join(workRoot, 'state.json')
const notes = []
const batchId = await submitBatch(prep.prepared, {
  apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0, stateFile, notes,
})
check(batchId === 'batch-1', '返回批次 id')
check(uploadedJsonl.trim().split('\n').length === 3, '上传 JSONL 3 行（3 任务）')
check(JSON.parse(uploadedJsonl.trim().split('\n')[0]).body.enable_thinking === false, '上传 JSONL 思考参数按预算生成')
const bp1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
check(bp1.batchId === 'batch-1' && bp1.tasks.length === 3, '断点含 batchId 与任务清单')
check(bp1.tasks[0].customId === 't0' && bp1.tasks[0].articlePath.endsWith('m0.md') && bp1.tasks[0].keepInMemory === false, '断点任务含 customId/articlePath/keepInMemory')
check(notes.some((n) => n.includes('batch-1')), 'notes 记录批次 id')

// ---------- 7. settleBatch：收尾落盘 ----------
section('settleBatch：批次完成 → 解析 → 落盘 → 清断点')
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/batches/batch-1')) {
    return mockJson({ id: 'batch-1', status: 'completed', output_file_id: 'out-1', error_file_id: 'err-1' })
  }
  if (u.includes('/files/out-1/content')) {
    return { ok: true, status: 200, text: async () => [
      JSON.stringify({ custom_id: 't0', response: { status_code: 200, body: { choices: [{ message: { content: '---\ntitle: A\n---\n文章A' } }] } } }),
      JSON.stringify({ custom_id: 't1', response: { status_code: 200, body: { choices: [{ message: { content: '---\ntitle: B\n---\n文章B' } }] } } }),
      JSON.stringify({ custom_id: 't2', response: { status_code: 500, body: {} } }),
    ].join('\n') }
  }
  if (u.includes('/files/err-1/content')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: 't2', error: { message: 'internal error' } }) }
  }
  throw new Error(`mock fetch 未路由：${u}`)
}
const settleNotes = []
const settled = await settleBatch({ batchId: 'batch-1', tasks: bp1.tasks, apiKey: 'sk-test', stateFile, notes: settleNotes })
check(Array.isArray(settled) && settled.length === 3, '收尾返回 3 条结果')
check(settled[0].ok && settled[1].ok && !settled[2].ok, 't0/t1 成功、t2 失败')
check(settleNotes.some((n) => n.includes('internal error')), 'notes 记行级错误')
check(fs.readFileSync(path.join(outDir, 'm0.md'), 'utf8').includes('文章A'), '成功文章已落盘 m0.md')
check(fs.readFileSync(path.join(outDir, 'm1.md'), 'utf8').includes('文章B'), '成功文章已落盘 m1.md')
check(!fs.existsSync(path.join(outDir, 'm2.md')), '失败文章不落盘')
check(!fs.existsSync(stateFile), '收尾后断点文件已删除')

// ---------- 8. keepInMemory 任务：不落盘，content 进结果 ----------
section('settleBatch：keepInMemory 结果留在内存')
const kmState = path.join(workRoot, 'state-km.json')
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.endsWith('/files') && init.method === 'POST') return mockJson({ id: 'file-km' })
  if (u.endsWith('/batches') && init.method === 'POST') return mockJson({ id: 'batch-km', status: 'validating' })
  if (u.includes('/batches/batch-km')) return mockJson({ id: 'batch-km', status: 'completed', output_file_id: 'out-km' })
  if (u.includes('/files/out-km/content')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: 'plan', response: { status_code: 200, body: { choices: [{ message: { content: '{"project":"x","modules":[],"concepts":[]}' } }] } } }) }
  }
  throw new Error(`mock fetch 未路由：${u}`)
}
const kmTask = [{ customId: 'plan', name: '_plan', keepInMemory: true, batchPrompt: '规划' }]
const kmId = await submitBatch(kmTask, { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0, stateFile: kmState, notes: [] })
const kmRes = await settleBatch({ batchId: kmId, tasks: kmTask, apiKey: 'sk-test', stateFile: kmState, notes: [] })
check(kmRes.length === 1 && kmRes[0].ok && kmRes[0].content.includes('"modules"'), 'keepInMemory 结果带 content')
check(!fs.existsSync(path.join(workRoot, '_plan')), 'keepInMemory 不落盘（规划结果由服务侧消费）')
check(!fs.existsSync(kmState), 'keepInMemory 收尾同样清断点')

// ---------- 9. runRealtimeTasks：oversized 实时兜底 ----------
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
check(rt.size === 3, '实时兜底返回 3 条结果（Map）')
check(rt.get('rt0').ok && fs.readFileSync(rtDisk, 'utf8').includes('实时结果'), '磁盘任务落盘成功')
check(rt.get('rt1').ok && rt.get('rt1').content === '内存结果', 'keepInMemory 结果带 content')
check(rt.get('rt2').ok === false && rtNotes.some((n) => n.includes('simulated network error')), '失败记账进 notes，不中断其他任务')
check(!fs.existsSync(path.join(outDir, 'boom.md')), '失败任务不落盘')

// ---------- 10. 断点续查收尾（孤儿批次） ----------
section('settleBatch：断点续查收尾')
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.endsWith('/files') && init.method === 'POST') return mockJson({ id: 'file-2' })
  if (u.endsWith('/batches') && init.method === 'POST') return mockJson({ id: 'batch-2', status: 'validating' })
  if (u.includes('/batches/batch-2')) return mockJson({ id: 'batch-2', status: 'completed', output_file_id: 'out-2' })
  if (u.includes('/files/out-2/content')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: 't0', response: { status_code: 200, body: { choices: [{ message: { content: '---\ntitle: S\n---\n慢任务完成' } }] } } }) }
  }
  throw new Error(`mock fetch 未路由：${u}`)
}
const slowTasks = prepareArticleTasks([{ name: 'modules/slow.md', mission: '慢任务', sources: ['src.ts'], articlePath: path.join(outDir, 'slow.md') }], { cwd: workRoot, language: '中文' })
const slowId = await submitBatch(slowTasks.prepared, { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0, stateFile, notes: [] })
check(slowId === 'batch-2' && fs.existsSync(stateFile), '提交后断点保留（收尾前任意时刻可续查）')
const bp = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const resumed = await settleBatch({ batchId: bp.batchId, tasks: bp.tasks.map((t) => ({ ...t })), apiKey: 'sk-test', stateFile, notes: [] })
check(Array.isArray(resumed) && resumed.length === 1 && resumed[0].ok, '续查收尾返回成功结果')
check(fs.readFileSync(path.join(outDir, 'slow.md'), 'utf8').includes('慢任务完成'), '续查文章落盘 slow.md')
check(!fs.existsSync(stateFile), '续查收尾后断点文件删除')

// ---------- 11. 本地规划兜底 ----------
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

// ---------- 12. packArticles：横切输入装填 ----------
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

// ---------- 13. scanRepoFiles：勘探黑名单 ----------
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

console.log(`\n${failures.length ? 'FAIL' : 'ALL PASS'}：${passed} 通过，${failures.length} 失败`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
