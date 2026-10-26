// agentic 通道失败退回单轮通道的判定与可装填性测试。
//
// 退回链路有三段，本文件覆盖前两段（第三段「收割计入 tally」由 test-orchestration 的
// 旧通道断言与 tally 去重逻辑间接守护）：
//   ① shouldFallBackFromAgentic：本批失败是否过半；
//   ② 重排出的重试任务字段是否够 prepareArticleTasks 装填（少了 mission/articlePath
//      就会被静默跳过，退回等于没退）；
//   ③ 退回任务走旧通道后，结果按 name 收敛进 job.articles（同名不重复计数）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shouldFallBackFromAgentic, prepareArticleTasks } from './index.js'
import { runAgenticArticles } from './lib/articles-agentic.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const r = (ok) => ({ ok })
const rn = (name, ok) => ({ name, ok })

// ---------------------------- ① 判定 ----------------------------
await check('空结果不触发退回', async () => {
  assert.equal(shouldFallBackFromAgentic([]), false)
  assert.equal(shouldFallBackFromAgentic(null), false)
})

await check('全成功不触发退回', async () => {
  assert.equal(shouldFallBackFromAgentic([r(true), r(true), r(true)]), false)
})

await check('少数失败（1/4）不触发退回——单篇失败只记账', async () => {
  assert.equal(shouldFallBackFromAgentic([r(false), r(true), r(true), r(true)]), false)
})

await check('恰好一半失败不触发退回（严格过半）', async () => {
  assert.equal(shouldFallBackFromAgentic([r(false), r(false), r(true), r(true)]), false)
})

await check('过半失败（3/4）触发退回', async () => {
  assert.equal(shouldFallBackFromAgentic([r(false), r(false), r(false), r(true)]), true)
})

await check('全失败（1/1、3/3）触发退回', async () => {
  assert.equal(shouldFallBackFromAgentic([r(false)]), true)
  assert.equal(shouldFallBackFromAgentic([r(false), r(false), r(false)]), true)
})

// ---------------------------- ② 可装填性 ----------------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fb-'))
fs.mkdirSync(path.join(repo, 'core'))
fs.writeFileSync(path.join(repo, 'core', 'a.py'), 'def run():\n    return 1\n')
fs.writeFileSync(path.join(repo, 'core', 'b.py'), 'def fmt():\n    return 2\n')

await check('重排任务带 mission/articlePath 时可被旧通道装填', async () => {
  // 与 index.js 里重排出的字段同形（agentic 任务快照 -> 单轮任务）
  const retry = [{
    customId: 'a0r0', name: 'modules/core.md',
    mission: '为模块「core」撰写文章 modules/core.md',
    sources: ['core/a.py'], cwd: repo,
    articlePath: path.join(repo, '.codewiki', 'modules', 'core.md'),
    prevArticlePath: null,
  }]
  const { prepared, sessionTasks } = prepareArticleTasks(retry, { cwd: repo, language: '中文' })
  assert.equal(sessionTasks.length, 0, '小模块不该掉进会话通道')
  assert.equal(prepared.length, 1, '必须装填出 1 个单轮请求')
  assert.ok(String(prepared[0].batchPrompt ?? '').includes('run'), 'prompt 里应含源码正文')
  assert.equal(prepared[0].name, 'modules/core.md', '名字要保持一致，收割才能对上')
})

await check('缺 mission 的重试任务装填后仍保留（不静默丢篇）', async () => {
  // 缺 mission 时 prepareArticleTasks 照样会产 prompt（mission 为 undefined 也能拼），
  // 因此退回侧的责任是「不要把缺字段的任务塞进去」——这里断言的是装填侧的容错，
  // 避免另一处改动把它变成抛错而中断整批退回。
  const retry = [{
    customId: 'a1r0', name: 'modules/b.md', sources: ['core/b.py'], cwd: repo,
    articlePath: path.join(repo, '.codewiki', 'modules', 'b.md'),
  }]
  const { prepared } = prepareArticleTasks(retry, { cwd: repo, language: '中文' })
  assert.equal(prepared.length, 1)
})

await check('源码文件不存在时退回任务退化为可继续的空装填', async () => {
  // 退回发生在 agentic 跑完之后，源码可能已被并发改动删除；
  // collectSources 的容错必须让装填仍然成功（宁可写一篇缺源码的文章，也不要中断整批）。
  const retry = [{
    customId: 'a2r0', name: 'modules/gone.md',
    mission: '为模块「gone」撰写文章',
    sources: ['core/not-there.py'], cwd: repo,
    articlePath: path.join(repo, '.codewiki', 'modules', 'gone.md'),
  }]
  const { prepared, sessionTasks } = prepareArticleTasks(retry, { cwd: repo, language: '中文' })
  assert.equal(prepared.length + sessionTasks.length, 1, '仍要产出一个任务，不能整批消失')
})

// ---------------------------- ③ 失败结果与成功结果并存 ----------------------------
await check('runAgenticArticles 分批失败时结果逐篇可辨（退回只挑失败篇）', async () => {
  // 退回侧依赖 results 里的逐篇 ok 标记：若执行器把「单篇抛错」升级成整体异常，
  // 调用方就拿不到「哪几篇失败」，只能整批重跑。这里用 llm=null 让每篇都抛错来验证：
  // 执行器仍须返回 Map，逐篇 ok:false。
  const tasks = [
    { customId: 'a0', name: 'modules/a.md', mission: '写 a' },
    { customId: 'a1', name: 'modules/b.md', mission: '写 b' },
  ]
  const results = await runAgenticArticles(tasks, {
    concurrency: 1,
    llm: null, provider: 'p', model: 'm',
    writeArticle: false,
    cwd: repo,
  }).catch(() => null)
  assert.ok(results instanceof Map, '执行器必须返回 Map，不能整体抛错')
  assert.equal(results.size, 2, `两篇都要有结果（实际 ${results?.size}）`)
  for (const v of results.values()) assert.equal(v.ok, false, '无 llm 时每篇都记为失败')
  // 失败过半 → 触发退回
  assert.equal(shouldFallBackFromAgentic([...results.values()]), true)
})

fs.rmSync(repo, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
process.exit(fails.length ? 1 : 0)
