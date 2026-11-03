// 阶段 3：原生产物**采用门**的测试（lib/engine/quality-gate.js）。
//
// 这一层判的是「这批产物能不能被 wiki 采用」——比阶段 2 的「产物自身自洽」更高一层：
// 阶段 2 说「页都在」，阶段 3 说「页写成 wiki 文章还成立吗、这批东西能不能推进基线」。
//
// 每条断言都对应一个真实可发生的故障，而不是形状好看：
//   · 缺页/空正文/死链被当完整成功 → wiki 少一篇/多一篇空壳，没人知道；
//   · 用别的通道的章节名去判原生正文 → 每条都是不可修复的 warning，闸门退化成噪声；
//   · 空 source_files 判成「成功」 → 增量归属不明的产物被记成已消化，下次编译失明；
//   · 未提交的工作区被当已提交基线 → 推进了一个 git 里不存在的状态；
//   · 危险 YAML 标题裸写 → serde_yaml 解析截断/失败，文章在 cw index 里消失。
//
// 真实产物取自 .probe-fsoft/wiki_out_1c/docs（1C 全量编译的真输出）。测试只读它，
// 复制到临时目录后再施加变形，绝不改动原产物。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { toPosix } from './lib/git-paths.js'
import { execFileSync } from 'node:child_process'
import {
  GATE_VERSION,
  GATE_DEFECT_KINDS,
  GATE_DEGRADATION_KINDS,
  GATE_STALE_KINDS,
  gateNativeOutput,
  renderArticle,
  titleOf,
  yamlScalar,
  readCommittedBaseline,
  uncommittedSourceChanges,
  assessBaseline,
  toContractBlockers,
  toQualityIssues,
} from './lib/engine/quality-gate.js'
import { parseFrontmatter } from './lib/article-contract.js'
import { judgeOutcome } from './lib/update-record.js'
import { BLOCKER_KINDS } from './lib/engine/contract.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const root = mkdtempSync(join(tmpdir(), 'fsoft-gate-'))
const SHA = 'a'.repeat(40)

// ── 合成 docs 树 ────────────────────────────────────────────────────────────
function makeDocs(name, overrides = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const files = {
    'overview.md': '# Demo\n\n这是一个演示项目的概览，说明整体结构与用途。\n\n见 [core](Core.md)。\n',
    'Core.md': '# Core\n\n核心引擎负责构建依赖图并调度各阶段。\n\n见 [web](Web.md)。\n',
    'Web.md': '# Web\n\nWeb 层把请求转成任务并回传进度。\n',
    'metadata.json': JSON.stringify({
      generation_info: { commit_id: SHA, layout: 'hierarchical', language: null },
      statistics: { total_components: 3, leaf_nodes: 2 },
      files_generated: ['overview.md', 'Core.md', 'Web.md'],
    }),
    'module_tree.json': JSON.stringify({
      Core: { path: 'src/core', components: ['src/core/engine.py::Engine'], children: {} },
      Web: { path: 'src/web', components: ['src/web/handler.py::Handler'], children: {} },
    }),
    'first_module_tree.json': '{}',
    'update_record.json': JSON.stringify({ outcome: 'incremental', pages_written: ['Core.md'], pages_removed: [] }),
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue
    writeFileSync(join(dir, rel), body, 'utf8')
  }
  return dir
}

// 一个真的 git 仓库（source_files 存在性 + 基线判定都要真 git）
function makeRepo(name) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'src/core'), { recursive: true })
  mkdirSync(join(dir, 'src/web'), { recursive: true })
  writeFileSync(join(dir, 'src/core/engine.py'), 'class Engine:\n    pass\n', 'utf8')
  writeFileSync(join(dir, 'src/web/handler.py'), 'class Handler:\n    pass\n', 'utf8')
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  g(['init', '-q', '.'])
  g(['config', 'user.email', 'probe@test.local'])
  g(['config', 'user.name', 'probe'])
  g(['config', 'commit.gpgsign', 'false'])
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'init'])
  return { dir, g, head: g(['rev-parse', 'HEAD']).trim() }
}

const componentFiles = {
  // componentFiles 的 key 是**组件 id**（`文件::符号`，映射在这里查证据），
  // 不是模块名——写成模块名会让 sourceFilesOf 回落到 `::` 前的文件，测试就测了个假。
  'src/core/engine.py::Engine': 'src/core/engine.py',
  'src/web/handler.py::Handler': 'src/web/handler.py',
}

// ── 1. 模块自洽性 ──────────────────────────────────────────────────────────

await check('gate：类别表互不重叠，且全是字符串（消费者按 kind 分派）', async () => {
  assert.equal(GATE_VERSION, 1)
  const all = [...GATE_DEFECT_KINDS, ...GATE_DEGRADATION_KINDS, ...GATE_STALE_KINDS]
  assert.equal(new Set(all).size, all.length, '三个类别表不允许重名')
  for (const k of all) assert.equal(typeof k, 'string')
})

// ── 2. 正常路径：能写成 done ──────────────────────────────────────────────

await check('gate：产物干净 + 已提交 HEAD + 基线一致 → done，可推进基线', async () => {
  const { dir, g, head } = makeRepo('ok-repo')
  // 基线 = HEAD，且已提交 → 没有陈旧
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `project: p\nlast_compiled_commit: ${head}\n`)
  writeFileSync(join(dir, 'CodeWiki.md'), '# W\n\n## Overview\n\nx\n')
  g(['add', '-A']); g(['commit', '-q', '-m', 'wiki'])
  const head2 = g(['rev-parse', 'HEAD']).trim()

  const docs = makeDocs('ok-docs', {
    'metadata.json': JSON.stringify({ generation_info: { commit_id: head2, layout: 'hierarchical' } }),
  })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles })
  assert.equal(r.outcome, 'done', JSON.stringify({ defects: r.defects, degr: r.degradations, stale: r.stale }))
  assert.equal(r.writable, true)
  assert.equal(r.canAdvanceBaseline, true)
  assert.equal(r.defects.length, 0)
  assert.equal(r.degradations.length, 0)
  assert.equal(r.entry.ok, true)
  assert.equal(r.articles.length, 2)
  assert.ok(r.articles.every((a) => a.action === 'write'))
})

// ── 3. 产品缺陷：缺页 / 空正文 / 死链 / 编造来源 ──────────────────────────

await check('gate：缺入口页 → failed 且不可写（没有 CodeWiki.md 就整批不能入库）', async () => {
  const { dir } = makeRepo('no-entry-repo')
  const docs = makeDocs('no-entry', { 'overview.md': null })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.writable, false)
  assert.ok(r.defects.some((d) => d.kind === 'entry-missing'), JSON.stringify(r.defects))
})

await check('gate：模块页只有标题（空壳）→ partial，且那篇 action=skip', async () => {
  const { dir } = makeRepo('empty-page-repo')
  const docs = makeDocs('empty-page', { 'Web.md': '# Web\n\n' })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.defects.some((d) => d.kind === 'empty-body'), JSON.stringify(r.defects))
  const web = r.articles.find((a) => a.source === 'Web.md')
  assert.equal(web.action, 'skip', '空壳页不许写进 wiki')
  assert.equal(r.rendered.some((x) => x.source === 'Web.md'), false, '有缺陷的页不进 rendered（否则上游会绕过 skip 整篇落盘）')
})

await check('gate：source_files 指向不存在的文件 → partial（编造会让增量归属静默错位）', async () => {
  const { dir } = makeRepo('bad-source-repo')
  const docs = makeDocs('bad-source')
  const r = gateNativeOutput({
    docsDir: docs, repoRoot: dir, requireCommittedInput: false,
    componentFiles: { 'src/core/engine.py::Engine': 'src/core/engine.py', 'src/web/handler.py::Handler': 'src/web/missing.py' },
  })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.defects.some((d) => d.kind === 'source-missing'), JSON.stringify(r.defects))
})

await check('gate：死链（链接到本次没有的页）→ partial', async () => {
  const { dir } = makeRepo('dead-link-repo')
  const docs = makeDocs('dead-link', { 'Web.md': '# Web\n\n见 [gone](Gone.md)。\n' })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.defects.some((d) => d.kind === 'dead-link'), JSON.stringify(r.defects))
})

await check('gate：坏 JSON（metadata 不可解析）→ partial 且带 bad-json', async () => {
  const { dir } = makeRepo('bad-json-repo')
  const docs = makeDocs('bad-json', { 'metadata.json': '{ not json' })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.defects.some((d) => d.kind === 'bad-json'), JSON.stringify(r.defects))
})

await check('gate：未登记的产物问题不会被吞（未来 output.js 加类别时逼这里补映射）', async () => {
  const { dir } = makeRepo('unknown-kind-repo')
  const docs = makeDocs('unknown-kind')
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  // 所有 defects 的 kind 必须在登记表里——这条守住「不许静默吞掉未知类别」
  for (const d of r.defects) assert.ok(GATE_DEFECT_KINDS.includes(d.kind), `未登记 ${d.kind}`)
  for (const d of r.degradations) assert.ok(GATE_DEGRADATION_KINDS.includes(d.kind), `未登记 ${d.kind}`)
  for (const s of r.stale) assert.ok(GATE_STALE_KINDS.includes(s.kind), `未登记 ${s.kind}`)
})

// ── 4. 能力降级：whole-repository 的空归属 ────────────────────────────────

await check('gate：module_tree 为空（whole-repository）→ degradation，不是 defect，但仍不 done', async () => {
  const { dir } = makeRepo('empty-tree-repo')
  const docs = makeDocs('empty-tree', { 'module_tree.json': '{}' })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, requireCommittedInput: false })
  assert.equal(r.outcome, 'partial')
  assert.equal(r.defects.length, 0, '页是真的，不是产品缺陷')
  assert.ok(r.degradations.some((d) => d.kind === 'empty-module-tree'))
  assert.ok(r.degradations.some((d) => d.kind === 'no-source-evidence'))
  // 页照写（可用），但基线不得推进（增量归属不可用）
  assert.equal(r.writable, true)
  assert.equal(r.canAdvanceBaseline, false)
  assert.ok(r.articles.every((a) => a.action === 'write'))
})

await check('gate：空 source_files 的页不会被 judgeOutcome 默默算成功（toQualityIssues 必须喂进去）', async () => {
  const { dir } = makeRepo('empty-source-judge-repo')
  const docs = makeDocs('empty-source-judge', { 'module_tree.json': '{}' })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, requireCommittedInput: false })
  const results = r.articles.map((a) => ({ name: a.wikiPath, ok: true }))
  // 不喂 qualityIssues：judgeOutcome 只看「写成了没有」→ 会判 done。这正是要防的盲区。
  const blind = judgeOutcome({ results, options: { expectedNames: results.map((x) => x.name) } })
  assert.equal(blind.outcome, 'done', '前提：judgeOutcome 自己看不见来源证据缺失（这条解释了为什么必须有 toQualityIssues）')
  assert.equal(blind.canAdvanceBaseline, true)
  // 喂进去之后必须落 partial
  const aware = judgeOutcome({ results, options: { expectedNames: results.map((x) => x.name), qualityIssues: toQualityIssues(r) } })
  assert.equal(aware.outcome, 'partial', JSON.stringify(aware.blockers))
  assert.equal(aware.canAdvanceBaseline, false)
})

// ── 5. 基线：未提交工作区不得当已提交基线 ────────────────────────────────

await check('readCommittedBaseline：只有工作区有 _meta.yaml（未提交）→ ok=false, dirty=true', async () => {
  const { dir } = makeRepo('meta-worktree-only-repo')
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `last_compiled_commit: ${SHA}\n`)
  const b = readCommittedBaseline({ repoRoot: dir })
  assert.equal(b.ok, false, '未提交的基线不能算已提交基线')
  assert.equal(b.source, 'worktree-only')
  assert.equal(b.dirty, true)
  assert.equal(b.worktreeCommit, SHA)
})

await check('readCommittedBaseline：HEAD 里有基线、工作区改了它 → 用 HEAD 的值并标 dirty', async () => {
  const { dir, g, head } = makeRepo('meta-dirty-repo')
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `last_compiled_commit: ${head}\n`)
  g(['add', '-A']); g(['commit', '-q', '-m', 'meta'])
  // 工作区改成另一个值但不提交
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `last_compiled_commit: ${SHA}\n`)
  const b = readCommittedBaseline({ repoRoot: dir })
  assert.equal(b.ok, true)
  assert.equal(b.source, 'git-head')
  assert.equal(b.commit, head, '必须用 git HEAD 的值，不是工作区的')
  assert.equal(b.worktreeCommit, SHA)
  assert.equal(b.dirty, true)
})

await check('assessBaseline：工作区 _meta.yaml 的 last_compiled_commit 为空（本轮刚 cw init）→ baseline-absent，不算未入库基线', async () => {
  const { dir, head } = makeRepo('meta-fresh-init-repo')
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  // `cw init` 的真实产物：last_compiled_commit: null。它没有任何历史进度可吞，
  // 若照 worktree-only 判 baseline-uncommitted，首次编译就永远推进不了基线。
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), 'project: p\nlast_compiled_commit: null\n')
  const r = assessBaseline({ repoRoot: dir, artifactCommit: head })
  assert.equal(r.stale.length, 1, JSON.stringify(r.stale))
  assert.equal(r.stale[0].kind, 'baseline-absent', '空基线属于首次编译，不是「未提交的历史基线」')
  assert.equal(r.ok, true, '没有历史进度可吞，不许阻塞')
})

await check('gate：历史基线只存在于工作区（未提交）→ baselineEligible=false，兼容字段 canAdvanceBaseline 同步 false', async () => {
  const { dir, g } = makeRepo('gate-baseline-uncommitted-repo')
  const head = g(['rev-parse', 'HEAD']).trim()
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  // 工作区里有一份**已有进度**的基线却没入库：推进它等于把未提交状态记成已消化。
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `last_compiled_commit: ${head}\n`)
  const docs = makeDocs('gate-baseline-uncommitted', {
    'metadata.json': JSON.stringify({ generation_info: { commit_id: head, layout: 'hierarchical' } }),
  })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles })
  assert.ok(r.stale.some((s) => s.kind === 'baseline-uncommitted'), JSON.stringify(r.stale))
  assert.equal(r.baselineEligible, false, '基线未入库时门不许许可推进')
  assert.equal(r.canAdvanceBaseline, false, '兼容字段不能与 baselineEligible 打架')
})

await check('assessBaseline：产物 commit ≠ HEAD → defect commit-mismatch（产物对不上当前代码）', async () => {
  const { dir } = makeRepo('commit-mismatch-repo')
  const r = assessBaseline({ repoRoot: dir, artifactCommit: SHA })
  assert.equal(r.ok, false)
  assert.ok(r.defects.some((d) => d.kind === 'commit-mismatch'), JSON.stringify(r.defects))
})

await check('assessBaseline：工作区有未提交源码改动 → defect uncommitted-input', async () => {
  const { dir, g } = makeRepo('dirty-input-repo')
  const head = g(['rev-parse', 'HEAD']).trim()
  writeFileSync(join(dir, 'src/core/engine.py'), 'class Engine:\n    pass\n# tweak\n', 'utf8')
  const r = assessBaseline({ repoRoot: dir, artifactCommit: head })
  assert.equal(r.ok, false)
  assert.ok(r.defects.some((d) => d.kind === 'uncommitted-input'), JSON.stringify(r.defects))
})

await check('assessBaseline：只有 wiki 自身的未提交改动不算脏（那正是本轮要写的东西）', async () => {
  const { dir, g } = makeRepo('wiki-dirty-repo')
  const head = g(['rev-parse', 'HEAD']).trim()
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  writeFileSync(join(dir, '.codewiki', 'x.md'), '# x\n')
  writeFileSync(join(dir, 'CodeWiki.md'), '# W\n')
  const changes = uncommittedSourceChanges({ repoRoot: dir })
  assert.deepEqual(changes.paths, [], 'wiki 产物不算源码改动')
  assert.equal(changes.ok, true)
  // 基线不存在 → stale baseline-absent，但不阻塞推进（首次编译）
  const r = assessBaseline({ repoRoot: dir, artifactCommit: head })
  assert.equal(r.ok, true, JSON.stringify(r.defects))
  assert.ok(r.stale.some((s) => s.kind === 'baseline-absent'))
})

await check('assessBaseline：基线未入库（只在工作区）→ stale 且阻塞推进', async () => {
  const { dir, g } = makeRepo('meta-uncommitted-blocking-repo')
  const head = g(['rev-parse', 'HEAD']).trim()
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `last_compiled_commit: ${head}\n`)
  writeFileSync(join(dir, 'CodeWiki.md'), '# W\n')
  const r = assessBaseline({ repoRoot: dir, artifactCommit: head })
  assert.equal(r.ok, false, '把未提交状态记成已消化是不可逆的记账错误')
  assert.ok(r.stale.some((s) => s.kind === 'baseline-uncommitted'), JSON.stringify(r.stale))
})

await check('assessBaseline：基线落后 HEAD 只是 stale（本轮编译正是为了消化它），不阻塞', async () => {
  const { dir, g, head } = makeRepo('meta-behind-repo')
  mkdirSync(join(dir, '.codewiki'), { recursive: true })
  writeFileSync(join(dir, '.codewiki', '_meta.yaml'), `last_compiled_commit: ${head}\n`)
  g(['add', '-A']); g(['commit', '-q', '-m', 'meta'])
  writeFileSync(join(dir, 'src/core/engine.py'), 'class Engine:\n    pass  # 2\n', 'utf8')
  g(['add', '-A']); g(['commit', '-q', '-m', 'code'])
  const newHead = g(['rev-parse', 'HEAD']).trim()
  // 产物对应新 HEAD，工作区干净，基线停在旧 commit
  const r = assessBaseline({ repoRoot: dir, artifactCommit: newHead })
  assert.equal(r.ok, true, JSON.stringify(r.defects))
  const behind = r.stale.find((s) => s.kind === 'baseline-behind-head')
  assert.ok(behind, JSON.stringify(r.stale))
  assert.ok(behind.detail.includes(head.slice(0, 12)))
})

// ── 6. 渲染：正文一字不动 + frontmatter 安全 ──────────────────────────────

await check('renderArticle：除跨页链接外正文一字不动（不删 H1、不补章节）', async () => {
  const body = '# Core Engine\n\n## Purpose\n\n见 [web](Web.md) 与 [src](../src/core/engine.py)。\n\n```python\nx = 1\n```\n'
  const out = renderArticle({
    article: { wikiPath: '.codewiki/modules/core.md', type: 'module', sourceFiles: ['src/core/engine.py'], source: 'Core.md' },
    body,
    // 不给 pageMap：没有可重写的目标，正文应当逐字保留
    pageMap: null,
  })
  const fm = parseFrontmatter(out)
  assert.ok(fm.fields, '合成的 frontmatter 必须能被自己的解析器读回')
  assert.equal(fm.fields.title, 'Core Engine')
  assert.equal(fm.fields.type, 'module')
  assert.deepEqual(fm.fields.source_files, ['src/core/engine.py'])
  assert.equal(fm.body, body, '没有 pageMap 时正文必须与原产物逐字相同')
  assert.equal(fm.fields.fsoft_page, 'Core.md', '可回溯到 FSoft 原始页')
})

// 真机 partial（job-mvzcxmxg-0）暴露的缺陷：上游页名是 agent_runtime.md，落地后被
// slug 化成 agent-runtime.md，而正文里的跨页链接仍写下划线原名 —— 全仓 412/420 条
// wiki 内部链接点开就是 404。链接是**路径**，不是正文内容，必须跟着改名一起走。
await check('renderArticle：跨页链接按落地路径重写（原始页名 → slug 后的 wikiPath）', async () => {
  const body = '# Router\n\n## Purpose\n\n见 [设置面板](dsh-subagent-auto-router_settings-panel.md) 与 [概览](./overview.md)。\n'
  const pageMap = new Map([
    ['dsh-subagent-auto-router_settings-panel.md', '.codewiki/modules/dsh-subagent-auto-router-settings-panel.md'],
    ['overview.md', 'CodeWiki.md'],
  ])
  const out = renderArticle({
    article: { wikiPath: '.codewiki/modules/dsh-subagent-auto-router-decision-dispatch.md', type: 'module', sourceFiles: ['index.js'], source: 'dsh-subagent-auto-router_decision-dispatch.md' },
    body,
    pageMap,
  })
  const fm = parseFrontmatter(out)
  assert.ok(fm.body.includes('](dsh-subagent-auto-router-settings-panel.md)'), `同目录链接应改写为落地名：${fm.body.slice(0, 200)}`)
  assert.ok(!fm.body.includes('dsh-subagent-auto-router_settings-panel.md'), '下划线原名不应再出现在链接里')
  assert.ok(fm.body.includes('](../../CodeWiki.md)'), `根页链接应指向 CodeWiki.md：${fm.body.slice(0, 200)}`)
  // 非 .md 的相对链接（源码引用）不动
  const body2 = '# X\n\n见 [src](../src/core/engine.py)。\n'
  const out2 = renderArticle({ article: { wikiPath: '.codewiki/modules/x.md', source: 'X.md' }, body: body2, pageMap })
  assert.equal(parseFrontmatter(out2).body, body2, '非 .md 链接必须原样保留')
})

// 真机 partial（job-mw0byomb-1，Wxxy-CampusLogin）暴露的缺陷：hierarchical 布局下引擎
// 页名是层级路径 `android_frontend_hooks/x.md`，正文里同目录兄弟写 `x_sibling.md`、
// 父级写 `../parent.md` —— 都相对**引擎页所在目录**。落地时页被拍平到 .codewiki/modules/
// 单层，若仍按落地目录解析这些相对链接，pageMap 一条都命不中，25 条链接全成死链。
// 解析基准必须是引擎源页目录，落地后按目标页的落地目录重算相对路径。
await check('renderArticle：层级布局下的相对链接按引擎源目录解析，再写成落地路径', async () => {
  const body = '# Stores\n\n见 [启动编排](android_frontend_hooks_startup_orchestration.md) 与 [认证](../android_frontend_auth.md)。\n'
  const pageMap = new Map([
    ['android_frontend_hooks/android_frontend_hooks_startup_orchestration.md', '.codewiki/modules/android-frontend-hooks-startup-orchestration.md'],
    ['android_frontend_auth.md', '.codewiki/modules/android-frontend-auth.md'],
  ])
  const out = renderArticle({
    article: {
      wikiPath: '.codewiki/modules/android-frontend-hooks-state-stores.md',
      type: 'module',
      sourceFiles: ['android/frontend/src/hooks/state.ts'],
      source: 'android_frontend_hooks/android_frontend_hooks_state_stores.md',
    },
    body,
    pageMap,
  })
  const fm = parseFrontmatter(out)
  assert.ok(
    fm.body.includes('](android-frontend-hooks-startup-orchestration.md)'),
    `同目录兄弟链接应按引擎源目录解析后写成落地名：${fm.body.slice(0, 300)}`,
  )
  assert.ok(
    fm.body.includes('](android-frontend-auth.md)'),
    `父目录链接（../）同样应命中：${fm.body.slice(0, 300)}`,
  )
  assert.ok(!fm.body.includes('android_frontend_hooks_startup_orchestration.md'), '下划线原名不应残留')
})

await check('renderArticle：空 source_files 显式写成 []（省略会被误读为「没声明」）', async () => {
  const out = renderArticle({
    article: { wikiPath: '.codewiki/modules/x.md', type: 'module', sourceFiles: [], source: 'X.md' },
    body: '# X\n\n正文。\n',
  })
  assert.ok(out.includes('source_files: []'), out.slice(0, 200))
  assert.deepEqual(parseFrontmatter(out).fields.source_files, [])
})

await check('yamlScalar：危险值写成 frontmatter 后能被读回原字符串', async () => {
  const dangerous = [
    'Support: batch & stream', // 冒号+空格 → 会被读成嵌套映射
    'Hash # tag here',          // ` #` → 会被当成注释截断
    'Paths C:\\src\\a.py',      // 反斜杠（YAML plain 里不转义，引号里是转义序列）
    'C:\\Users\\ik\\x',         // 绝对 Windows 路径
    '12345',                    // 裸数字会变 int
    'true',                     // 裸布尔
    'yes',                      // YAML 1.1 布尔
    '~',                        // null
    '- leading dash',
    'it\'s "quoted" ok',
    '  leading space',
    '',                          // 空串
    'a\tb',                      // 控制字符
    '#starts with hash',
    'ends with colon:',
  ]
  for (const v of dangerous) {
    const raw = yamlScalar(v)
    // ① 本仓库自己的读者（parseYamlLite，经 parseFrontmatter）必须读回原值。
    const back = parseFrontmatter(`---\nk: ${raw}\n---\n`).fields.k
    assert.equal(back, v, `yamlScalar(${JSON.stringify(v)}) = ${raw} → 读回 ${JSON.stringify(back)}`)
    // ② 双引号形态还必须是合法 JSON 字符串（serde_yaml 对双引号标量按 JSON 转义解析），
    //    否则 cw 那边会解析失败——两套读者语义一致才是「安全」。
    if (raw.startsWith('"')) {
      assert.equal(JSON.parse(raw), v, `双引号标量的转义不合法：${raw}`)
    }
  }
  // 安全值保持裸写（与既有文章观感一致）
  assert.equal(yamlScalar('change_set'), 'change_set')
  assert.equal(yamlScalar('Core Engine'), 'Core Engine')
  assert.equal(yamlScalar('src/core/engine.py'), 'src/core/engine.py')
})

await check('renderArticle：真实危险标题渲染后，parseFrontmatter 的 title 必须还是整条标题', async () => {
  const cases = [
    ['# Support: batch & stream\n\n正文。\n', 'Support: batch & stream'],
    ['# Hash # tag\n\n正文。\n', 'Hash # tag'],
    ['# Paths C:\\src\\a.py\n\n正文。\n', 'Paths C:\\src\\a.py'],
    ['# 12345\n\n正文。\n', '12345'],
  ]
  for (const [body, want] of cases) {
    const out = renderArticle({
      article: { wikiPath: '.codewiki/modules/t.md', type: 'module', sourceFiles: ['src/x.py'], source: 'T.md' },
      body,
    })
    assert.equal(parseFrontmatter(out).fields.title, want, `标题被 YAML 吃掉：${want}`)
  }
})

await check('titleOf：有 H1 用 H1，没有则退回模块名', async () => {
  assert.equal(titleOf('# A: b\n\nx\n', 'fallback'), 'A: b')
  assert.equal(titleOf('没有标题\n', 'Core'), 'Core')
  assert.equal(titleOf('# 换行\n标题\n', 'Core'), '换行')
})

// ── 7. 契约：blockers 能被 contract.js 接受 ──────────────────────────────

await check('toContractBlockers：产出的 kind 全部在 contract.js 的 BLOCKER_KINDS 里', async () => {
  const { dir } = makeRepo('contract-kind-repo')
  const docs = makeDocs('contract-kind', { 'Web.md': '# Web\n\n' })
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  const blockers = toContractBlockers(r)
  assert.ok(blockers.length > 0)
  for (const b of blockers) {
    assert.ok(BLOCKER_KINDS.includes(b.kind), `${b.kind} 不在 BLOCKER_KINDS 里`)
    assert.equal(typeof b.detail, 'string')
    assert.ok(b.detail.includes('['), 'detail 里保留原 kind，便于定位')
  }
})

await check('toQualityIssues：只把阻塞性陈旧算进去，基线落后 HEAD 不算', async () => {
  const { dir } = makeRepo('quality-issues-repo')
  const docs = makeDocs('quality-issues')
  const r = gateNativeOutput({ docsDir: docs, repoRoot: dir, componentFiles, requireCommittedInput: false })
  // 人为塞一条 baseline-behind-head（非阻塞）与 baseline-uncommitted（阻塞）
  const fake = {
    ...r,
    degradations: [{ kind: 'no-source-evidence', detail: 'x', target: '.codewiki/modules/x.md' }],
    defects: [],
    stale: [
      { kind: 'baseline-behind-head', detail: '落后' },
      { kind: 'baseline-uncommitted', detail: '未入库' },
    ],
  }
  const issues = toQualityIssues(fake)
  assert.equal(issues.length, 2, JSON.stringify(issues))
  assert.ok(issues.some((i) => i.issue.includes('no-source-evidence')))
  assert.ok(issues.some((i) => i.issue.includes('baseline-uncommitted')))
  assert.equal(issues.some((i) => i.issue.includes('baseline-behind-head')), false)
})

// ── 8. 真实产物（1C 全量编译的真输出） ──────────────────────────────────

const REAL = 'E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs'
const REAL_REPO = 'E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c'

if (!existsSync(REAL)) {
  console.log(`SKIP  真实产物不存在：${REAL}（阶段 1C 未跑过则跳过本组）`)
} else {
  const copyDocs = (name) => {
    const dir = join(root, name)
    cpSync(REAL, dir, { recursive: true })
    return dir
  }

  await check('真实产物：3 页全部可写，但 module_tree={} → partial（不许当完整成功）', async () => {
    const docs = copyDocs('real-as-is')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: false })
    assert.equal(r.counts.pages, 3)
    assert.equal(r.articles.length, 2)
    assert.ok(r.articles.every((a) => a.action === 'write'), JSON.stringify(r.articles))
    assert.equal(r.defects.length, 0, JSON.stringify(r.defects))
    assert.ok(r.degradations.some((d) => d.kind === 'empty-module-tree'))
    assert.equal(r.outcome, 'partial')
    assert.equal(r.canAdvanceBaseline, false)
  })

  await check('真实产物：每篇渲染后都能过 article-contract（原生章节名不被误判）', async () => {
    const docs = copyDocs('real-render')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: false, includeContent: true })
    assert.equal(r.rendered.length, 2, '两篇可写页都要有渲染结果')
    for (const page of r.rendered) {
      const fm = parseFrontmatter(page.content)
      assert.ok(fm.fields, `${page.wikiPath} frontmatter 读不回`)
      assert.ok(page.content.includes('generated_by: fsoft-native'))
      assert.ok(fm.body.length > 100, `${page.wikiPath} 正文过短`)
      // 原生通道不要求 Overview/Key Components；真实产物里也确实没有
      const pageIssues = r.defects.filter((d) => d.target === page.wikiPath)
      assert.equal(pageIssues.length, 0, `${page.wikiPath} 不应有缺陷：${JSON.stringify(pageIssues)}`)
    }
  })

  await check('真实产物 + 掏空一篇正文 → 该篇 skip、partial（成功结果不会被当完整完成）', async () => {
    const docs = copyDocs('real-empty-one')
    fs.writeFileSync(join(docs, 'wiki_out_1c_web_layer.md'), '# Web Layer\n\n', 'utf8')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: false, includeContent: true })
    assert.equal(r.outcome, 'partial')
    assert.ok(r.defects.some((d) => d.kind === 'empty-body' && /web_layer/.test(d.source ?? '')), JSON.stringify(r.defects))
    const web = r.articles.find((a) => /web_layer/.test(a.source))
    assert.equal(web.action, 'skip')
    assert.equal(r.rendered.some((p) => /web_layer/.test(p.source)), false)
  })

  // 真机 job-mvzcxmxg-0 的截图暴露的缺陷：引擎页名 agent_runtime.md 落地改名成
  // agent-runtime.md，而正文链接仍写原名 —— 本仓 420 条内部链接 412 条点开 404。
  // 这条用例不看单一函数，而是盯**整份产物渲染后的结果**：每一页里的每个 .md 链接
  // 目标都必须真实存在于落地页集合里。
  // 行内代码里的链接写法是语法示例（真机 article_validation.md 用 `](xxx.md)` 讲死链
  // 规则）。收集与重写都必须跳过它，否则文档会因为「解释了契约」而被契约判违规。
  await check('真实产物：行内代码里的链接写法不计入真实链接', async () => {
    const docs = copyDocs('real-code-links')
    // 主动注入一段「讲链接语法」的正文：真机 article_validation.md 就是这样用
    // `](xxx.md)` 解释死链规则的，结果被自己的规则判成死链拒写。
    const target = join(docs, 'wiki_out_1c_core_engine.md')
    const withExample = readFileSync(target, 'utf8') + '\n死链判据会收集 `](xxx.md)` 这类写法（示例，非真实链接）。\n'
    writeFileSync(target, withExample, 'utf8')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: false, includeContent: true })
    // 这个夹具的 module_tree 是空对象，本来就该 partial（empty-module-tree）；
    // 这里只盯「代码示例有没有被当成真链接」这一件事。
    const linkDefects = (r.defects ?? []).filter((d) => d.kind === 'dead-link')
    assert.deepEqual(linkDefects, [], `代码示例被当成死链：${JSON.stringify(linkDefects)}`)
    const rendered = r.rendered.map((x) => x.content).join('\n')
    assert.ok(rendered.includes('](xxx.md)'), '示例文本应原样保留（不重写、不删除）')
  })
  await check('真实产物：渲染后每个跨页链接都指向落地页（消除 412/420 失效链接）', async () => {
    const docs = copyDocs('real-link-targets')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: false, includeContent: true })
    const landed = new Set(r.rendered.map((p) => toPosix(p.wikiPath)))
    landed.add('CodeWiki.md')
    const missing = []
    for (const page of r.rendered) {
      const baseDir = path.posix.dirname(toPosix(page.wikiPath))
      for (const m of page.content.matchAll(/\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g)) {
        const target = m[1]
        if (/^[a-z]+:/i.test(target)) continue
        const abs = path.posix.normalize(path.posix.join(baseDir, target))
        if (!landed.has(abs)) missing.push(`${page.wikiPath} -> ${target}`)
      }
    }
    assert.deepEqual(missing, [], `存在指向不存在页面的链接：${missing.slice(0, 5).join('、')}`)
    assert.equal(r.rendered.length, 2, '夹具应有 2 篇落地页')
  })
  await check('真实产物 + 断开一个跨页链接 → dead-link defect', async () => {
    const docs = copyDocs('real-dead-link')
    const p = join(docs, 'wiki_out_1c_core_engine.md')
    const text = readFileSync(p, 'utf8').replace('](wiki_out_1c_web_layer.md)', '](gone_page.md)')
    fs.writeFileSync(p, text, 'utf8')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: false })
    assert.equal(r.outcome, 'partial')
    assert.ok(r.defects.some((d) => d.kind === 'dead-link'), JSON.stringify(r.defects))
  })

  await check('真实产物 + 改坏 metadata 的 commit_id → commit-mismatch（产物对不上代码）', async () => {
    const docs = copyDocs('real-commit-mismatch')
    const meta = JSON.parse(readFileSync(join(docs, 'metadata.json'), 'utf8'))
    meta.generation_info.commit_id = 'b'.repeat(40)
    writeFileSync(join(docs, 'metadata.json'), JSON.stringify(meta), 'utf8')
    const r = gateNativeOutput({ docsDir: docs, repoRoot: REAL_REPO, requireCommittedInput: true })
    assert.equal(r.outcome, 'partial')
    assert.ok(r.defects.some((d) => d.kind === 'commit-mismatch'), JSON.stringify(r.defects))
  })
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack}`)
  process.exit(1)
}
