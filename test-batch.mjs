// test-batch.mjs — 编译执行链自检：纯函数（源码装填/token 估算/任务装配/本地规划/
// 横切装填/仓库勘探）+ mock fetch（普通端点/并发池/取消/超大兜底）
// 跑法：node test-batch.mjs（Node ≥20，全局 fetch/FormData/Blob）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectSources, estimateTokens,
  prepareArticleTasks, runRealtimeTasks,
  localPlan, packArticles, scanRepoFiles, resolveBatchApiKey,
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
check(cs.text.includes('### a.ts') && cs.text.includes('export const A = 1'), '内容内联带相对路径标题')
check(cs.text.includes('missing.ts') && cs.text.includes('文件不存在'), '缺失文件在文内标注')
check(cs.skipped.length === 0 && cs.oversized === false, '预算充足时无跳过')
const tiny = collectSources(tmpRoot, ['a.ts', 'b.ts'], 10)
check(tiny.oversized === true && tiny.text.includes('export const A = 1'), '首文件即超预算 → oversized（原文返回转超大兜底）')
const firstBlock = '### a.ts\n\n```\nexport const A = 1\n```\n\n'
const small = collectSources(tmpRoot, ['a.ts', 'b.ts'], estimateTokens(firstBlock) + 1)
check(small.oversized === false && small.skipped.includes('b.ts'), '预算装不下第二文件 → skipped')

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
check(bigPrep.prepared.length === 1 && bigPrep.oversized.length === 0, '单文件超 28k 预算 → 升大档（200k）重装继续（分不出多批不拆分）')
check(bigPrep.prepared[0].batchPrompt.includes('xxx') && bigPrep.prepared[0].batchPrompt.length > 300 * 1024, '大档任务 prompt 内联完整源码')
const hugePrep = prepareArticleTasks([{ name: 'modules/huge.md', mission: '超大任务', sources: ['huge.ts'], articlePath: path.join(outDir, 'huge.md') }], { cwd: workRoot, language: '中文' })
check(hugePrep.prepared.length === 0 && hugePrep.oversized.length === 1, '单文件连 200k 大档都装不下 → oversized（转超大兜底）')

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
check(splitPrep.oversized.length === 0, '分割任务不进 oversized')
const obsTasks = splitPrep.prepared.filter((t) => t.name.endsWith('#obs0') || t.name.includes('#obs'))
check(obsTasks.length >= 2, `多文件超预算拆出 ≥2 个观察批（实际 ${obsTasks.length}）`)
check(obsTasks.every((t) => t.keepInMemory === true), '观察任务 keepInMemory（不直接落盘）')
check(obsTasks.every((t) => estimateTokens(t.batchPrompt) <= 28000), `观察批 prompt 全部 ≤28k token（最大 ${Math.max(...obsTasks.map((t) => estimateTokens(t.batchPrompt)))}）`)
check(obsTasks.every((t) => t.splitFor === 'modules/splitme.md'), '观察任务 splitFor 指向所属文章')
check(obsTasks.every((t) => t.composePlan?.articlePath === path.join(outDir, 'splitme.md') && t.composePlan?.mission === '分割任务'), 'composePlan 携带 articlePath 与 mission')
check(obsTasks.some((t) => t.batchPrompt.includes('第 1 批')) && obsTasks.some((t, i) => t.batchPrompt.includes(`第 ${i + 1} 批`)), '观察 prompt 标注批次序号')
const plainStill = prepareArticleTasks([{ name: 'modules/plain.md', mission: '普通任务', sources: ['src.ts'], articlePath: path.join(outDir, 'plain.md') }], { cwd: workRoot, language: '中文' })
check(plainStill.prepared.length === 1 && !plainStill.prepared[0].name.includes('#obs'), '预算内普通任务不分割')

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
