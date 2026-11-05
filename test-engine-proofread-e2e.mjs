// 语义校对必须真的插在质量门之前（阶段 5 端到端用例）。
//
// 这个文件只测一件事：**有死链的产物在开校对后变成 done、关校对时是 partial**。
// 用假引擎造出「正文链到不存在的页」的产物（真机最常见的 partial 成因），
// 然后只替换 deps.chat 这一层（模型调用），其余全部走真实实现：
//   runEngine(真 spawn 假引擎) → gateNativeOutput(真实) → proofread(真实) → 再判门 → applyNativeOutput(真实)
//
// 为什么不用假 gate：校对的价值就在于「改完正文后门真的放行」。假 gate 测不出这一点。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

process.env.DSH_CODEWIKI_TICK_MS = '300'
const TEST_TOKEN = crypto.randomBytes(4).toString('hex')
process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `dsh-codewiki-jobs-proof-${process.pid}-${TEST_TOKEN}.json`)

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_ENGINE = path.join(here, 'test-fixtures', 'fake-native-engine.mjs')

const { runNativeJob } = await import('./lib/engine/native-run.js')

let checks = 0
let failures = 0
function check(cond, msg) {
  checks += 1
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

const madeDirs = []
function makeRepo(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proof-'))
  madeDirs.push(base)
  const repo = path.join(base, tag)
  fs.mkdirSync(path.join(repo, 'core'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'core', 'core.py'), 'def run():\n    return "core"\n')
  fs.mkdirSync(path.join(repo, 'util'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'util', 'util.py'), 'def fmt():\n    return "util"\n')
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  git('init')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@test')
  git('add', '.')
  git('commit', '-m', 'init')
  execFileSync('cw', ['init'], { cwd: repo, stdio: 'pipe' })
  fs.writeFileSync(path.join(repo, 'CodeWiki.md'), '# CodeWiki\n')
  git('add', '.codewiki')
  git('add', 'CodeWiki.md')
  git('commit', '-m', 'wiki init')
  fs.writeFileSync(path.join(base, `.native-mode-${tag}`), 'deadlink', 'utf8')
  return { base, repo }
}

// 假引擎的 deadlink 模式会写出 overview.md 链到 gone-module.md（模块树里没有这一页）。
const fakeLlm = {
  async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  listModels: () => [],
  resolveModel: () => null,
}

const baseDeps = (docs, chat) => ({
  config: { batchProvider: 'workbuddy', batchModel: 'hy3' },
  // 假引擎用 node 当「解释器」、夹具文件当「入口」：client.js 走完全真实的 spawn 路径，
  // 真把产物写进 docsDir——校对要读的正是那些文件。
  engineFor: () => ({ command: process.execPath, args: [FAKE_ENGINE], env: {} }),
  llm: fakeLlm,
  ...(chat ? { chat } : {}),
})

fs.mkdirSync(path.join(os.tmpdir(), 'cw-proof-unused'), { recursive: true })

// ── 用例 1：不开校对 → 门如实报 dead-link、终态 partial ──────────────────────
console.log('== 用例 1：没有校对通道时，产物里的死链如实判 partial ==')
let partialRes = null
{
  const { repo } = makeRepo('nodocs-chat')
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proof-docs1-'))
  madeDirs.push(docs)
  const res = await runNativeJob({ repoRoot: repo, scope: 'full', docsDir: docs, deps: baseDeps(docs, null) })
  partialRes = res
  check(res.gate?.outcome === 'partial', `质量门判 partial（实际 ${res.gate?.outcome}）`)
  check(
    (res.blockers ?? []).some((b) => /dead-link/.test(String(b.detail ?? ''))),
    `死链如实进 blockers（实际 ${JSON.stringify((res.blockers ?? []).map((b) => b.kind))}）`,
  )
  check(
    fs.readFileSync(path.join(docs, 'overview.md'), 'utf8').includes('gone-module.md'),
    '不开校对时，正文里的失效链接原样保留（不静默删除）',
  )
}

// ── 用例 2：开校对 → 失效链接被改对、重判门后不再报 dead-link ────────────────
console.log('== 用例 2：校对通道把失效链接改对后，门不再报 dead-link ==')
{
  const { repo } = makeRepo('withdocs-chat')
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proof-docs2-'))
  madeDirs.push(docs)
  let promptSeen = ''
  const stages = []
  const res = await runNativeJob({
    repoRoot: repo,
    scope: 'full',
    docsDir: docs,
    deps: baseDeps(docs, async (prompt) => {
      promptSeen = prompt
      // 模型：把 gone-module.md 改成真实存在的 core.md（页面清单里给的）
      return '<PAGE>\n# 项目概览\n\n演示项目的整体结构说明。\n\n## 组成\n\n见 [核心](core.md)。\n</PAGE>'
    }),
    onProgress: (f) => stages.push(f.stage),
  })
  check(promptSeen.includes('core.md'), '校对提示里给出了真实页名清单')
  check(promptSeen.includes('gone-module.md'), '校对提示里点出了失效目标')
  check(
    !(res.blockers ?? []).some((b) => /dead-link/.test(String(b.detail ?? ''))),
    `校对后不再有 dead-link（实际 ${JSON.stringify((res.blockers ?? []).map((b) => b.kind))}）`,
  )
  const overview = fs.readFileSync(path.join(docs, 'overview.md'), 'utf8')
  check(overview.includes('](core.md)'), '失效链接被改写成真实页')
  check(!overview.includes('gone-module.md'), '失效链接不再残留')
  check(
    (res.notes ?? []).some((n) => /语义校对改写了/.test(n)),
    `notes 记录校对改写了哪些页（实际 ${JSON.stringify((res.notes ?? []).filter((n) => n.includes('校对')))}）`,
  )
  // 契约阶段名写错时 engineProgress 会抛错；若调用方 catch 一吞，帧就静悄悄消失，
  // 面板上「校对」这一步永远不亮。这里直接断言帧真的送到了消费者手里。
  check(stages.includes('proofread'), `onProgress 收到 proofread 帧（实际 ${JSON.stringify([...new Set(stages)])}）`)
  check(stages.includes('validate'), 'onProgress 也收到 validate 帧（契约里两个阶段都在）')
}

// ── 用例 3：模型没修对 → 保留原文，门照旧判 partial（不许越修越坏）────────────
console.log('== 用例 3：模型没修对时保留原文，still partial ==')
{
  const { repo } = makeRepo('wrong-chat')
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proof-docs3-'))
  madeDirs.push(docs)
  const res = await runNativeJob({
    repoRoot: repo,
    scope: 'full',
    docsDir: docs,
    deps: baseDeps(docs, async () => '<PAGE>\n# 项目概览\n\n## 组成\n\n见 [核心](still-gone.md)。\n</PAGE>'),
  })
  check(
    (res.blockers ?? []).some((b) => /dead-link/.test(String(b.detail ?? ''))),
    `改不对就照旧报 dead-link（实际 ${JSON.stringify((res.blockers ?? []).map((b) => b.kind))}）`,
  )
  const overview = fs.readFileSync(path.join(docs, 'overview.md'), 'utf8')
  check(overview.includes('gone-module.md'), '未改对时保留原始正文（不写入更坏的版本）')
}

// ── 用例 4：`[[词条]]` 死链（契约层判出、被门改名）也能进校对 ────────────────
// 真机上 FSoft 产物很少写 `[文字](x.md)`，但常写 `[[词条]]`；后者由 article-contract
// 判定、被 quality-gate 压成 kind='article-contract'。校对若只认 kind==='dead-link'，
// 这条唯一能自救的路就被切断——用例锁住它。
console.log('== 用例 4：契约层判出的 [[词条]] 死链也能被校对接手 ==')
{
  const { base, repo } = makeRepo('wikilink-chat')
  // makeRepo 默认写 deadlink；这里换成 wikilink 模式（正文用 [[词条]] 形态链死页）。
  fs.writeFileSync(path.join(base, '.native-mode-wikilink-chat'), 'wikilink', 'utf8')
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proof-docs4-'))
  madeDirs.push(docs)
  let promptSeen = ''
  const res = await runNativeJob({
    repoRoot: repo,
    scope: 'full',
    docsDir: docs,
    deps: baseDeps(docs, async (prompt) => {
      promptSeen = prompt
      return '<PAGE>\n# 核心\n\n## 职责\n\n核心引擎负责构建依赖图并调度各阶段，细节见 [[core]]。\n</PAGE>'
    }),
  })
  check(promptSeen.includes('ghost-entry'), `校对提示里点出了 [[词条]] 形态的死链（seen=${promptSeen.slice(0, 80)}）`)
  const core = fs.readFileSync(path.join(docs, 'core.md'), 'utf8')
  check(core.includes('[[core]]'), `[[词条]] 死链被改写成真实词条（实际 ${JSON.stringify(core)}）`)
  check(!core.includes('ghost-entry'), '失效词条不再残留')
  check(
    (res.notes ?? []).some((n) => /语义校对改写了|校对改写了/.test(n)),
    `notes 记录校对改写了页（实际 ${JSON.stringify((res.notes ?? []).filter((n) => n.includes('校对')))}）`,
  )
  fs.rmSync(path.join(base, '.native-mode-wikilink-chat'), { force: true })
}

for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* Windows 占用留给系统 */ } }
try { fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true }) } catch { /* ignore */ }

console.log(`\n== 结果：${checks - failures}/${checks} 通过，${failures} 失败 ==`)
if (failures > 0) process.exit(1)
console.log('语义校对端到端测试全部通过')
