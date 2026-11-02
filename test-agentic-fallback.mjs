// agentic 通道失败可辨性（0.17.5 起是唯一写作通道）。
//
// 旧版这里测的是「失败过半 → 退回单轮通道重跑」，而单轮通道（整包内联 → 观察批 → 合成）
// 已在 0.17.5 删除。现在唯一要守的性质只剩一条：执行器对单篇失败必须**收敛**成逐篇
// ok:false 的结果，而不是整体抛错——否则调用方拿不到「哪几篇失败」，tally 也就无从记账。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAgenticArticles } from './lib/articles-agentic.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-agentic-fail-'))

await check('无 llm 时每篇都收敛为 ok:false，不整体抛错', async () => {
  const tasks = [
    { customId: 'a0', name: 'modules/a.md', mission: '写 a' },
    { customId: 'a1', name: 'modules/b.md', mission: '写 b' },
  ]
  const results = await runAgenticArticles(tasks, {
    concurrency: 1,
    llm: null, provider: 'p', model: 'm',
    writeArticle: false,
    cwd: repo,
  })
  assert.ok(results instanceof Map, '执行器必须返回 Map，不能整体抛错')
  assert.equal(results.size, 2, `两篇都要有结果（实际 ${results.size}）`)
  for (const v of results.values()) assert.equal(v.ok, false, '无 llm 时每篇都记为失败')
})

await check('单篇失败不牵连同批其它篇（逐篇可辨）', async () => {
  let n = 0
  const stream = async () => {
    n++
    if (n === 1) throw new Error('upstream 503')
    return {
      blocks: [{ type: 'tool-call', id: 'c1', name: 'edit_article', arguments: { command: 'insert', line: 0, text: '# t\n\n## Overview\n\n正文\n' } }],
      finish: { kind: 'stop' },
    }
  }
  const tasks = [
    { customId: 'b0', name: 'modules/b0.md', mission: '写 b0' },
    { customId: 'b1', name: 'modules/b1.md', mission: '写 b1' },
  ]
  const notes = []
  const results = await runAgenticArticles(tasks, {
    streamFn: stream, cwd: repo, concurrency: 1, notes, maxSteps: 3,
  })
  const vals = [...results.values()]
  assert.equal(vals.filter((v) => v.ok).length, 1, '应有一篇成功')
  assert.equal(vals.filter((v) => !v.ok).length, 1, '应有一篇失败')
})

fs.rmSync(repo, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
process.exit(fails.length ? 1 : 0)
