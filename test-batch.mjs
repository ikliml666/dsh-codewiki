// test-batch.mjs — 批量推理模块自检：纯函数（JSONL 构建/结果解析/源码装填）+ mock fetch 全流程
// 跑法：node test-batch.mjs（Node ≥20，全局 fetch/FormData/Blob）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildBatchJsonl, parseBatchResults, collectSources, runBatchTasks, settleBatch, resolveBatchApiKey } from './index.js'

let passed = 0
const failures = []
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`) }
  else { failures.push(msg); console.log(`  ✗ ${msg}`) }
}
function section(name) { console.log(`\n== ${name} ==`) }

// ---------- 1. buildBatchJsonl ----------
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

// ---------- 2. parseBatchResults ----------
section('parseBatchResults：结果行/错误行/坏行')
const output = [
  JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { choices: [{ message: { content: '# 文章A' } }] } } }),
  JSON.stringify({ custom_id: 'b', response: { status_code: 400, body: {} } }),
  'not-json-garbage',
].join('\n')
const errors = [JSON.stringify({ custom_id: 'c', error: { message: 'quota exceeded' } })].join('\n')
const parsed = parseBatchResults(output, errors)
check(parsed.get('a')?.ok === true && parsed.get('a').content === '# 文章A', '200 行 → ok + content')
check(parsed.get('b')?.ok === false && parsed.get('b').error.includes('400'), '非 200 行 → 失败，error 带 HTTP 码')
check(parsed.get('c')?.ok === false && parsed.get('c').error === 'quota exceeded', '错误文件行 → 失败 + message')
check(parsed.size === 3, '坏行跳过不占位（size=3）')

// ---------- 3. collectSources ----------
section('collectSources：装填/缺失/预算')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-batch-test-'))
fs.writeFileSync(path.join(tmpRoot, 'a.ts'), 'export const A = 1\n')
fs.writeFileSync(path.join(tmpRoot, 'b.ts'), 'export const B = 2\n')
const cs = collectSources(tmpRoot, ['a.ts', 'missing.ts', 'b.ts'])
check(cs.text.includes('### a.ts') && cs.text.includes('export const A = 1'), '内容内联带相对路径标题')
check(cs.text.includes('missing.ts') && cs.text.includes('文件不存在'), '缺失文件在文内标注')
check(cs.skipped.length === 0 && cs.oversized === false, '预算充足时无跳过')
const tiny = collectSources(tmpRoot, ['a.ts', 'b.ts'], 10)
check(tiny.oversized === true, '首文件即超预算 → oversized（整任务回退）')
const firstBlock = '### a.ts\n\n```\nexport const A = 1\n```\n\n'
const small = collectSources(tmpRoot, ['a.ts', 'b.ts'], Buffer.byteLength(firstBlock, 'utf8') + 1)
check(small.oversized === false && small.skipped.includes('b.ts'), '预算装不下第二文件 → skipped')

// ---------- 4. runBatchTasks：mock fetch 提交→轮询→收尾 ----------
section('runBatchTasks：mock fetch 全流程')
let batchPolls = 0
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
  if (u.includes('/batches/batch-1')) {
    batchPolls += 1
    return batchPolls < 2 ? mockJson({ id: 'batch-1', status: 'in_progress' }) : mockJson({ id: 'batch-1', status: 'completed', output_file_id: 'out-1', error_file_id: 'err-1' })
  }
  if (u.includes('/files/out-1/content')) {
    return { ok: true, status: 200, text: async () => [
      JSON.stringify({ custom_id: 't0', response: { status_code: 200, body: { choices: [{ message: { content: '---\ntitle: A\n---\n文章A' } }] } } }),
      JSON.stringify({ custom_id: 't1', response: { status_code: 200, body: { choices: [{ message: { content: '文章B' } }] } } }),
      JSON.stringify({ custom_id: 't2', response: { status_code: 500, body: {} } }),
    ].join('\n') }
  }
  if (u.includes('/files/err-1/content')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: 't2', error: { message: 'internal error' } }) }
  }
  throw new Error(`mock fetch 未路由：${u}`)
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-batch-work-'))
fs.writeFileSync(path.join(workRoot, 'src.ts'), 'export const S = 3\n')
const outDir = path.join(workRoot, 'wiki', 'modules')
const stateFile = path.join(workRoot, 'state.json')
const exec = {}
const notes = []
const batchTasks = ['t0', 't1', 't2'].map((_id, i) => ({
  name: `modules/m${i}.md`,
  mission: `任务t${i}`,
  sources: ['src.ts'],
  articlePath: path.join(outDir, `m${i}.md`),
}))
const batchRes = await runBatchTasks({
  exec,
  batchCfg: { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0 },
  tasks: batchTasks,
  cwd: workRoot,
  language: '中文',
  waitMs: 60000,
  stateFile,
  notes,
})
check(uploadedJsonl.trim().split('\n').length === 3, '上传 JSONL 3 行（3 任务）')
check(batchRes.results.length === 3 && batchRes.oversized.length === 0, '返回 3 条结果、无 oversized')
check(batchRes.results[0].ok && batchRes.results[1].ok, 't0/t1 成功')
check(batchRes.results[2].ok === false && notes.some((n) => n.includes('internal error')), 't2 失败且 notes 记行级错误')
check(fs.readFileSync(path.join(outDir, 'm0.md'), 'utf8').includes('文章A'), '成功文章已落盘 m0.md')
check(fs.readFileSync(path.join(outDir, 'm1.md'), 'utf8').includes('文章B'), '成功文章已落盘 m1.md')
check(!fs.existsSync(path.join(outDir, 'm2.md')), '失败文章不落盘')
check(!fs.existsSync(stateFile), '收尾后断点文件已删除')
check(JSON.parse(uploadedJsonl.trim().split('\n')[0]).body.enable_thinking === false, '上传 JSONL 思考参数按预算生成')

// ---------- 4b. background 模式：提交即返回 ----------
section('runBatchTasks：background 提交即返回（轮询交宿主后台链）')
{
  const bgState = path.join(workRoot, 'state-bg.json')
  const bgNotes = []
  const bgCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    bgCalls.push(u)
    if (u.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-bg-1' }), { status: 200 })
    if (u.endsWith('/batches')) return new Response(JSON.stringify({ id: 'batch-bg-1' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }
  try {
    const bgRes = await runBatchTasks({
      exec,
      batchCfg: { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0 },
      tasks: batchTasks.map((t) => ({ ...t, articlePath: path.join(outDir, `bg-${t.name}`) })),
      cwd: workRoot,
      language: '中文',
      waitMs: 60000,
      stateFile: bgState,
      notes: bgNotes,
      background: true,
    })
    check(bgRes.submitted === 'batch-bg-1' && Array.isArray(bgRes.prepared) && bgRes.prepared.length === 3, '提交后立即返回 submitted 批次 id 与 prepared 任务集')
    check(bgRes.prepared.every((t) => t.customId && typeof t.batchPrompt === 'string' && t.batchPrompt.length > 0), 'prepared 任务带 customId 与 batchPrompt（供后台 settleBatch 收尾）')
    check(bgCalls.length === 2 && bgCalls.some((u) => u.endsWith('/files')) && bgCalls.some((u) => u.endsWith('/batches')), `提交后不再轮询（fetch 共 ${bgCalls.length} 次：/files 与 /batches）`)
    check(fs.existsSync(bgState) && JSON.parse(fs.readFileSync(bgState, 'utf8')).batchId === 'batch-bg-1', '断点已写入（后台链据此收尾）')
    check(bgNotes.some((n) => n.includes('batch-bg-1')), 'notes 记录批次 id')
    fs.rmSync(bgState, { force: true })
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---------- 5. 超预算任务回退 ----------
section('runBatchTasks：超预算任务 oversized 回退')
fs.writeFileSync(path.join(workRoot, 'big.ts'), 'x'.repeat(900 * 1024))
const bigRes = await runBatchTasks({
  exec,
  batchCfg: { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0 },
  tasks: [{ name: 'modules/big.md', mission: '大任务', sources: ['big.ts'], articlePath: path.join(outDir, 'big.md') }],
  cwd: workRoot,
  language: '中文',
  waitMs: 60000,
  stateFile,
  notes,
})
check(bigRes.results.length === 0 && bigRes.oversized.length === 1, '全 oversized → 不提交批次，回退列表返回')

// ---------- 6. 超时保留断点 ----------
section('runBatchTasks：超时保留断点')
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.endsWith('/files') && init.method === 'POST') return mockJson({ id: 'file-2' })
  if (u.endsWith('/batches') && init.method === 'POST') return mockJson({ id: 'batch-2', status: 'validating' })
  if (u.includes('/batches/batch-2')) return mockJson({ id: 'batch-2', status: 'in_progress' })
  throw new Error(`mock fetch 未路由：${u}`)
}
let timeoutErr = null
try {
  await runBatchTasks({
    exec,
    batchCfg: { apiKey: 'sk-test', model: 'qwen3.7-flash', thinkingBudget: 0 },
    tasks: [{ name: 'modules/slow.md', mission: '慢任务', sources: ['src.ts'], articlePath: path.join(outDir, 'slow.md') }],
    cwd: workRoot,
    language: '中文',
    waitMs: 300,
    stateFile,
    notes,
  })
} catch (err) { timeoutErr = err }
check(timeoutErr && String(timeoutErr.message).includes('batch-2') && String(timeoutErr.message).includes('断点'), '超时抛错并提示断点保留')
check(fs.existsSync(stateFile), '断点文件保留')
const bp = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
check(bp.batchId === 'batch-2' && bp.tasks.length === 1 && bp.tasks[0].articlePath.endsWith('slow.md'), '断点内容含 batchId 与任务清单')

// ---------- 7. 断点续查收尾 ----------
section('settleBatch：断点续查收尾')
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('/batches/batch-2')) return mockJson({ id: 'batch-2', status: 'completed', output_file_id: 'out-2' })
  if (u.includes('/files/out-2/content')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: 't0', response: { status_code: 200, body: { choices: [{ message: { content: '慢任务完成' } }] } } }) }
  }
  throw new Error(`mock fetch 未路由：${u}`)
}
const settleNotes = []
const settled = await settleBatch({
  batchId: 'batch-2',
  tasks: bp.tasks.map((t) => ({ ...t })),
  apiKey: 'sk-test',
  stateFile,
  notes: settleNotes,
})
check(Array.isArray(settled) && settled.length === 1 && settled[0].ok, '续查收尾返回成功结果')
check(fs.readFileSync(path.join(outDir, 'slow.md'), 'utf8').includes('慢任务完成'), '续查文章落盘 slow.md')
check(!fs.existsSync(stateFile), '续查收尾后断点文件删除')

globalThis.fetch = originalFetch
fs.rmSync(tmpRoot, { recursive: true, force: true })
fs.rmSync(workRoot, { recursive: true, force: true })

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
