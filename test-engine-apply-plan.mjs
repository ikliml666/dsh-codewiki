// 阶段 3：apply-plan.js（原子应用 → cw index → 基线 → 自动提交）的测试。
//
// 全部用临时目录 + 注入桩，不碰真仓库、不跑真 cw：这一层的验收对象是**不变量**
// （写集封闭 / 索引基线失败回滚 / 提交失败不回滚），不是 cw 自己的行为（那由
// test-engine-quality-gate.mjs 与真实编译覆盖）。真实 git 只用于 verifyCommitScope
// 那一条——它判的就是「提交里到底有什么」，桩不出真值。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  APPLY_STAGES,
  APPLY_PROBLEM_KINDS,
  APPLY_RESULT_KINDS,
  APPLY_WRITE_ROOTS,
  applyNativeOutput,
  checkWriteTargets,
  toApplyBlockers,
  verifyCommitScope,
} from './lib/engine/apply-plan.js'
import { BLOCKER_KINDS } from './lib/engine/contract.js'
import { WIKI_ENTRY } from './lib/engine/mapping.js'

let passed = 0
let failed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    failures.push({ name, message: String(err?.message ?? err) })
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
  } catch (err) {
    failed++
    failures.push({ name, message: String(err?.message ?? err) })
  }
}

const tmpRoots = []
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-apply-plan-'))
  tmpRoots.push(root)
  return root
}
function writeFile(root, rel, text) {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
}
function readFile(root, rel) {
  return readFileSync(join(root, ...rel.split('/')), 'utf8')
}
function exists(root, rel) {
  return existsSync(join(root, ...rel.split('/')))
}

// 造一份「能过门」的裁决：两篇文章 + 入口
function makeReport({ pages = null, canAdvanceBaseline = true, writable = true, outcome = 'done' } = {}) {
  const list = pages ?? [
    { source: 'overview.md', wikiPath: WIKI_ENTRY, type: 'overview', content: '# 项目\n\n入口正文。\n' },
    { source: 'core.md', wikiPath: '.codewiki/modules/core.md', type: 'module', content: '# core\n\n模块正文。\n' },
  ]
  return {
    version: 1,
    ok: outcome === 'done',
    outcome,
    writable,
    canAdvanceBaseline,
    entry: { source: 'overview.md', path: WIKI_ENTRY, ok: true },
    articles: list.filter((p) => p.wikiPath !== WIKI_ENTRY).map((p) => ({ source: p.source, wikiPath: p.wikiPath, action: 'write' })),
    rendered: list.filter((p) => p.wikiPath !== WIKI_ENTRY),
    defects: [],
    degradations: [],
    stale: [],
    blockers: [],
  }
}

// docs 目录里放一份入口页（applyNativeOutput 会从 docsDir 读它）
function makeDocs(dir = null) {
  const docs = dir ?? mkdtempSync(join(tmpdir(), 'dsh-apply-docs-'))
  if (!dir) tmpRoots.push(docs)
  writeFile(docs, 'overview.md', '---\ntitle: 项目\ntype: overview\n---\n\n# 项目\n\n入口正文。\n')
  writeFile(docs, 'core.md', '# core\n\n模块正文。\n')
  return docs
}

// cw 调用序列里去掉 init：init 是「仓库本来没有 wiki」的前置步骤（apply-plan.js 3b），
// 与 index/meta 的先后语义无关，单独用 cwSequenceWithInit 断言。
function seq(calls) {
  return calls.map((c) => c.args).filter((a) => a !== 'init')
}

function recordingDeps(overrides = {}) {
  const calls = []
  const deps = {
    cwBinary: 'cw-stub',
    runCw: async (bin, cwd, args) => {
      calls.push({ args: args.join(' ') })
      if (overrides.failOn && args[0] === overrides.failOn) {
        return { exitCode: 7, stdout: '', stderr: `${args[0]} 炸了` }
      }
      if (args[0] === 'init') {
        // 真 cw init 会建目录骨架并写 _meta.yaml（meta.rs:save）；桩照做，
        // 否则后面的 meta update 会因为「读不到 _meta.yaml」失败（真 cw 实测 exit 1）
        mkdirSync(join(cwd, '.codewiki', 'modules'), { recursive: true })
        writeFileSync(join(cwd, '.codewiki', '_meta.yaml'), 'last_compiled_commit: null\n', 'utf8')
      }
      if (args[0] === 'index') {
        // 真 cw index 会写 _index.md：桩也写，才能验证回滚会把它复原
        writeFileSync(join(cwd, '.codewiki', '_index.md'), '# Wiki Index\n\n- [[modules/core|core]]\n', 'utf8')
      }
      if (args[0] === 'meta') {
        writeFileSync(join(cwd, '.codewiki', '_meta.yaml'), 'last_compiled_commit: deadbeef\n', 'utf8')
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
    commit: async () => ({ committed: true, sha: 'abc1234', message: 'docs(wiki): x' }),
    verifyCommit: async () => ({ ok: true, files: [WIKI_ENTRY, '.codewiki/modules/core.md'], unexpected: [] }),
    ...overrides,
  }
  return { deps, calls }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 模块自洽
// ─────────────────────────────────────────────────────────────────────────────

check('APPLY_STAGES 顺序即推进顺序', () => {
  assert.deepEqual([...APPLY_STAGES], ['write', 'index', 'baseline', 'commit'])
})

check('写集白名单只含 .codewiki 与 CodeWiki.md', () => {
  assert.deepEqual([...APPLY_WRITE_ROOTS], ['.codewiki', 'CodeWiki.md'])
})

check('每个落地问题都能翻成契约 BLOCKER_KINDS', () => {
  const probes = APPLY_RESULT_KINDS.map((k) => ({ kind: k, detail: k }))
  const blockers = toApplyBlockers(probes)
  assert.equal(blockers.length, APPLY_RESULT_KINDS.length)
  for (const b of blockers) {
    assert.ok(BLOCKER_KINDS.includes(b.kind), `未登记的 blocker kind：${b.kind}`)
    assert.ok(b.detail.startsWith('['), 'detail 必须带原类别，便于定位')
  }
})

check('APPLY_PROBLEM_KINDS 覆盖写集校验的全部输出类别', () => {
  const r = checkWriteTargets([
    { path: '', content: 'x' },
    { path: '/etc/passwd', content: 'x' },
    { path: '../out.md', content: 'x' },
    { path: 'lib/x.md', content: 'x' },
    { path: '.codewiki/a.md', content: 1 },
  ])
  assert.equal(r.ok, false)
  for (const p of r.problems) assert.ok(APPLY_PROBLEM_KINDS.includes(p.kind), `未登记：${p.kind}`)
  const kinds = new Set(r.problems.map((p) => p.kind))
  for (const k of ['empty-target', 'absolute-target', 'escaping-target', 'out-of-scope', 'bad-content']) {
    assert.ok(kinds.has(k), `缺少 ${k}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) 写集校验（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

check('checkWriteTargets：合法写集通过并规范化 ./ 前缀与反斜杠', () => {
  const r = checkWriteTargets([
    { path: './.codewiki/modules/a.md', content: 'A' },
    { path: '.codewiki\\concepts\\b.md', content: 'B' },
    { path: 'CodeWiki.md', content: 'C' },
  ])
  assert.equal(r.ok, true)
  assert.deepEqual(r.targets.map((t) => t.rel), ['.codewiki/modules/a.md', '.codewiki/concepts/b.md', 'CodeWiki.md'])
})

check('checkWriteTargets：同一路径内容相同 → 去重（不算问题）', () => {
  const r = checkWriteTargets([
    { path: '.codewiki/a.md', content: 'same' },
    { path: '.codewiki/a.md', content: 'same' },
  ])
  assert.equal(r.ok, true)
  assert.equal(r.targets.length, 1)
})

check('checkWriteTargets：同一路径内容不同 → duplicate-target', () => {
  const r = checkWriteTargets([
    { path: '.codewiki/a.md', content: 'one' },
    { path: '.codewiki/a.md', content: 'two' },
  ])
  assert.equal(r.ok, false)
  assert.equal(r.problems[0].kind, 'duplicate-target')
})

check('checkWriteTargets：盘符路径按绝对路径拒', () => {
  const r = checkWriteTargets([{ path: 'C:/repo/x.md', content: 'x' }])
  assert.equal(r.ok, false)
  assert.equal(r.problems[0].kind, 'absolute-target')
})

check('checkWriteTargets：.codewikix 前缀不被当成 .codewiki 子路径', () => {
  const r = checkWriteTargets([{ path: '.codewikix/a.md', content: 'x' }])
  assert.equal(r.ok, false)
  assert.equal(r.problems[0].kind, 'out-of-scope')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 正常路径
// ─────────────────────────────────────────────────────────────────────────────

await checkAsync('正常路径：写盘 + index + baseline + commit → done', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'done', JSON.stringify(r.problems))
  assert.equal(r.applied, true)
  assert.equal(r.canAdvanceBaseline, true)
  assert.ok(exists(root, '.codewiki/modules/core.md'), '文章应写盘')
  assert.ok(exists(root, 'CodeWiki.md'), '入口应写盘')
  assert.ok(exists(root, '.codewiki/_index.md'), '索引应存在')
  assert.ok(exists(root, '.codewiki/_meta.yaml'), '基线应推进')
  assert.deepEqual(seq(calls), ['index', 'meta update'], '必须先 index 后 meta')
  assert.equal(r.commit.committed, true)
  assert.equal(r.commit.scope.ok, true)
})

await checkAsync('入口写的是 docs 里那份的正文（frontmatter 被剥掉）', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'done', JSON.stringify(r.problems))
  const text = readFile(root, 'CodeWiki.md')
  assert.ok(!text.startsWith('---'), '入口不该带 frontmatter')
  assert.ok(text.includes('入口正文。'), '入口正文应保留')
})

await checkAsync('dryRun：不写盘、不跑 cw、不提交', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps, dryRun: true })
  assert.equal(calls.length, 0, 'dryRun 不该调 cw')
  assert.equal(r.applied, false)
  assert.equal(exists(root, '.codewiki/modules/core.md'), false, 'dryRun 不该写盘')
  assert.equal(exists(root, 'CodeWiki.md'), false)
})

await checkAsync('裁决 writable=false → 一个字都不写', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport({ writable: false, outcome: 'failed' }), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(calls.length, 0)
  assert.equal(exists(root, '.codewiki/modules/core.md'), false)
  assert.equal(r.blockers[0].kind, 'quality-gate')
})

await checkAsync('产物没有入口页 → failed，连文章都不写', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const report = makeReport()
  report.entry = null
  const r = await applyNativeOutput({ repoRoot: root, report, docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(calls.length, 0)
  assert.equal(exists(root, '.codewiki/modules/core.md'), false, '缺入口时不该写半批')
})

await checkAsync('渲染结果里有越界路径 → 整批拒写（不是跳过该条）', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const pages = [
    { source: 'overview.md', wikiPath: WIKI_ENTRY, type: 'overview', content: '# 项目\n\n正文\n' },
    { source: 'core.md', wikiPath: '.codewiki/modules/core.md', type: 'module', content: '# core\n\n正文\n' },
    { source: 'evil.md', wikiPath: 'package.json', type: 'module', content: '{}' },
  ]
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport({ pages }), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(calls.length, 0, '越界即整批拒，不该跑 cw')
  // 落地结果词表只有「哪一步坏了」，写集问题统一记 write-failed，原子类别留在 detail 前缀
  assert.ok(r.problems.some((p) => p.kind === 'write-failed' && p.detail.includes('[out-of-scope]')), JSON.stringify(r.problems))
  assert.ok(r.blockers.some((b) => b.detail.includes('[out-of-scope]')))
  assert.equal(exists(root, '.codewiki/modules/core.md'), false, '合法页也不该写（写集不完整）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4) 索引/基线失败 → 回滚
// ─────────────────────────────────────────────────────────────────────────────

await checkAsync('cw index 失败 → 回滚：新文件删除、旧内容复原、索引复原', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  // 应用前库里已有一篇文章与一份索引，验证「旧内容原样写回」而不只是「删掉」
  // 有 wiki 就必然有 _meta.yaml（真 cw init 会写，apply-plan.js 3b 依赖它），夹具照真值摆
  writeFile(root, '.codewiki/_meta.yaml', 'last_compiled_commit: cafe\n')
  writeFile(root, '.codewiki/modules/core.md', '# core\n\n旧正文。\n')
  writeFile(root, '.codewiki/_index.md', '# Wiki Index\n\n- [[modules/core|core]]\n')
  const { deps, calls } = recordingDeps({ failOn: 'index' })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.rolledBack, true)
  assert.equal(readFile(root, '.codewiki/modules/core.md'), '# core\n\n旧正文。\n', '旧文章必须原样复原')
  assert.equal(exists(root, 'CodeWiki.md'), false, '本次新建的入口必须删掉')
  assert.equal(readFile(root, '.codewiki/_index.md'), '# Wiki Index\n\n- [[modules/core|core]]\n')
  assert.equal(readFile(root, '.codewiki/_meta.yaml'), 'last_compiled_commit: cafe\n', '基线不该被改动')
  assert.deepEqual(seq(calls), ['index'], '基线不该被调用')
  assert.ok(r.blockers.some((b) => b.kind === 'index-failed'))
})

await checkAsync('cw meta update 失败 → 回滚：文章与索引都撤回', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  writeFile(root, '.codewiki/_meta.yaml', 'last_compiled_commit: cafe\n')
  const { deps, calls } = recordingDeps({ failOn: 'meta' })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.rolledBack, true)
  assert.deepEqual(seq(calls), ['index', 'meta update'])
  assert.equal(exists(root, '.codewiki/modules/core.md'), false, '文章必须撤回（文章比基线新 = 重复消费）')
  assert.equal(exists(root, 'CodeWiki.md'), false)
  assert.equal(readFile(root, '.codewiki/_meta.yaml'), 'last_compiled_commit: cafe\n', '基线必须复原')
  assert.ok(r.blockers.some((b) => b.kind === 'baseline-failed'))
})

await checkAsync('裁决 canAdvanceBaseline=false → 不跑 meta update，文章保留', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const r = await applyNativeOutput({
    repoRoot: root, report: makeReport({ canAdvanceBaseline: false, outcome: 'partial' }), docsDir: docs, deps,
  })
  assert.deepEqual(seq(calls), ['index'], '不推进基线时不该跑 meta update')
  assert.ok(exists(root, '.codewiki/modules/core.md'), '文章仍应入库')
  assert.equal(r.baseline.advanced, false)
  assert.equal(r.canAdvanceBaseline, false, '没推进基线就不能宣称可推进')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5) 提交失败 → 不回滚
// ─────────────────────────────────────────────────────────────────────────────

await checkAsync('自动提交失败 → 不回滚，记 commit-failed 且终态 partial', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps({ commit: async () => ({ committed: false, reason: '仓库未配置 git user.name' }) })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'partial')
  assert.equal(r.rolledBack, false)
  assert.ok(exists(root, '.codewiki/modules/core.md'), '提交失败不该删掉文章')
  assert.ok(exists(root, '.codewiki/_meta.yaml'), '提交失败不该撤回基线')
  assert.ok(r.blockers.some((b) => b.kind === 'commit-failed'))
  assert.ok(r.applied, 'applied 表示「写盘成立」，与提交成立是两件事')
})

await checkAsync('产物无改动（noChanges）不算失败', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps({ commit: async () => ({ committed: false, noChanges: true, reason: '产物无未提交改动' }) })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'done', JSON.stringify(r.problems))
  assert.equal(r.commit.noChanges, true)
})

await checkAsync('未注入提交通道时走内置提交器：非 git 仓库 → 记 commit-failed，绝不 done', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps({ commit: undefined })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  // 默认提交器对「不是 git 仓库」如实拒绝 → 产物落盘但未入库，终态不能是 done
  assert.equal(r.commit.committed, false)
  assert.equal(r.outcome, 'partial', '未提交不许 done')
  assert.ok(r.blockers.some((b) => b.kind === 'commit-failed'))
  assert.ok(r.notes.some((n) => n.includes('提交失败不回滚产物')))
})

await checkAsync('提交成立但混进 wiki 外路径 → 记 commit-scope（不回滚）', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps({
    verifyCommit: async () => ({ ok: false, files: [WIKI_ENTRY, 'src/app.js'], unexpected: ['src/app.js'], reason: '提交里混进了 wiki 之外的路径：src/app.js' }),
  })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'partial')
  assert.ok(r.problems.some((p) => p.kind === 'commit-scope'))
  assert.ok(exists(root, '.codewiki/modules/core.md'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 6) 入口策略
// ─────────────────────────────────────────────────────────────────────────────

await checkAsync('entryMode=keep：已有入口不覆盖', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  writeFile(root, 'CodeWiki.md', '# 我手写的入口\n')
  const { deps } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.entry.action, 'keep')
  assert.equal(readFile(root, 'CodeWiki.md'), '# 我手写的入口\n')
  assert.ok(r.notes.some((n) => n.includes('保留人工入口')))
})

await checkAsync('entryMode=overwrite：覆盖已有入口', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  writeFile(root, 'CodeWiki.md', '# 旧入口\n')
  const { deps } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps, entryMode: 'overwrite' })
  assert.equal(r.entry.action, 'overwrite')
  assert.ok(readFile(root, 'CodeWiki.md').includes('入口正文。'))
})

await checkAsync('入口页除 frontmatter 外空正文 → failed，不写半批', async () => {
  const root = makeRepo()
  const docs = mkdtempSync(join(tmpdir(), 'dsh-apply-docs-'))
  tmpRoots.push(docs)
  writeFile(docs, 'overview.md', '---\ntitle: 只有头\n---\n\n')
  const { deps, calls } = recordingDeps()
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(calls.length, 0)
  assert.equal(exists(root, '.codewiki/modules/core.md'), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 6b) 裁决 partial（能写但没消化完）+ 索引规范化失败
// ─────────────────────────────────────────────────────────────────────────────

await checkAsync('裁决 partial 且 writable=true → 照写，但终态保持 partial 且基线不推进', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps, calls } = recordingDeps()
  const r = await applyNativeOutput({
    repoRoot: root,
    report: makeReport({ outcome: 'partial', canAdvanceBaseline: false }),
    docsDir: docs,
    deps,
  })
  // 产物确实落盘了（writable=true 的语义就是「能写」）
  assert.equal(r.applied, true)
  assert.ok(exists(root, '.codewiki/modules/core.md'))
  assert.ok(exists(root, 'CodeWiki.md'))
  // 但裁决没消化完 → 落地器不许洗成 done，也不许推进基线
  assert.equal(r.outcome, 'partial')
  assert.equal(r.ok, false)
  assert.equal(r.canAdvanceBaseline, false)
  assert.ok(r.blockers.every((b) => typeof b.kind === 'string'))
  assert.ok(r.blockers.some((b) => b.detail.includes('[gate-partial]')), '要把「裁决没消化完」记成机读问题')
  assert.ok(r.notes.some((n) => n.includes('基线未推进')), '基线必须明说不推进')
  assert.deepEqual(seq(calls), ['index'], '不做 meta update')
  assert.equal(r.commit.committed, true, '产物该提交还是提交（不是 failed）')
})

await checkAsync('裁决 unknown outcome + writable=true → 同样不洗成 done', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps()
  const r = await applyNativeOutput({
    repoRoot: root,
    report: makeReport({ outcome: 'unknown', canAdvanceBaseline: false }),
    docsDir: docs,
    deps,
  })
  assert.equal(r.outcome, 'partial')
  assert.equal(r.canAdvanceBaseline, false)
})

await checkAsync('内置索引规范化：cw 写出的 `\\` 链接会被改成 `/`', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps()
  // 模拟 Windows 上 cw 写出的反斜杠链接（桩 runCw 的默认 index 输出是 `/`，这里覆盖它）
  const rawRunCw = deps.runCw
  deps.runCw = async (bin, cwd, args) => {
    const res = await rawRunCw(bin, cwd, args)
    if (args[0] === 'index') {
      writeFileSync(join(cwd, '.codewiki', '_index.md'), '# Wiki Index\n\n- [[modules\\core|core]]\n- [[modules/core|core]]\n', 'utf8')
    }
    return res
  }
  delete deps.normalizeIndexLinks // 走内置实现，确保默认路径被测到
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'done', JSON.stringify(r.problems))
  assert.equal(r.index.normalized, true)
  const idx = readFile(root, '.codewiki/_index.md')
  assert.ok(!idx.includes('modules\\core'), `索引里不该残留反斜杠：${idx}`)
  assert.ok(idx.includes('[[modules/core|core]]'))
})

await checkAsync('写集里没有 .codewiki 文章 + cw 没写 _index.md → 无需规范化，不报错', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps()
  // 故意不写 _index.md。这里只写入口（写集里没有 .codewiki/ 下的文章），
  // 所以「索引缺页」校验没有可比对的对象——它不该把「空库无索引」误报成缺页。
  deps.runCw = async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })
  delete deps.normalizeIndexLinks
  const r = await applyNativeOutput({
    repoRoot: root, report: makeReport({ pages: [] }), docsDir: docs, deps,
  })
  assert.equal(r.index.normalized, false)
  assert.equal(r.outcome, 'done', JSON.stringify(r.problems))
})

await checkAsync('索引规范化失败 → 记 index-failed 并整体回滚（不留半个索引）', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  // 预置旧文章，用于验证回滚把它恢复（有 wiki 就必然有 _meta.yaml，见 apply-plan.js 3b）
  writeFile(root, '.codewiki/_meta.yaml', 'last_compiled_commit: cafe\n')
  writeFile(root, '.codewiki/modules/core.md', '# 旧 core\n')
  const { deps } = recordingDeps({
    normalizeIndexLinks: () => { throw new Error('_index.md 写入被拒（模拟只读）') },
  })
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.rolledBack, true)
  assert.ok(r.problems.some((p) => p.kind === 'index-failed'), JSON.stringify(r.problems))
  assert.ok(r.blockers.some((b) => b.kind === 'index-failed'))
  // 磁盘退回应用前：旧文章原样、新入口不存在、索引/基线不残留
  assert.equal(readFile(root, '.codewiki/modules/core.md'), '# 旧 core\n')
  assert.equal(exists(root, 'CodeWiki.md'), false)
  assert.equal(exists(root, '.codewiki/_index.md'), false)
  assert.equal(readFile(root, '.codewiki/_meta.yaml'), 'last_compiled_commit: cafe\n')
})

await checkAsync('cw index 退出 0 但文章没进索引 → 同样是 index-failed 并回滚（缺页不许静默成功）', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  writeFile(root, '.codewiki/_meta.yaml', 'last_compiled_commit: cafe\n')
  const { deps } = recordingDeps()
  // 模拟真 cw 的行为：frontmatter 解析失败的文章被 `continue` 掉，索引照写、退出码 0
  // （vendor/codewiki/src/main.rs:236-256：`if let Ok(Some(fm))` 失败即跳过，最后仍 println 并返回 Ok）
  const rawRunCw = deps.runCw
  deps.runCw = async (bin, cwd, args) => {
    const res = await rawRunCw(bin, cwd, args)
    if (args[0] === 'index') {
      writeFileSync(join(cwd, '.codewiki', '_index.md'), '# Wiki Index\n\n_No articles yet. Wiki needs compilation._\n', 'utf8')
    }
    return res
  }
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps })
  assert.equal(r.outcome, 'failed')
  assert.equal(r.rolledBack, true)
  const p = r.problems.find((x) => x.kind === 'index-failed')
  assert.ok(p, JSON.stringify(r.problems))
  assert.ok(p.detail.includes('模块') || p.detail.includes('core'), `detail 要点名缺哪几篇：${p.detail}`)
  assert.deepEqual(r.index.missing, ['modules/core.md'])
  // 回滚：文章与入口都不留，索引回到应用前（不存在）
  assert.equal(exists(root, '.codewiki/modules/core.md'), false)
  assert.equal(exists(root, 'CodeWiki.md'), false)
  assert.equal(exists(root, '.codewiki/_index.md'), false)
  assert.equal(readFile(root, '.codewiki/_meta.yaml'), 'last_compiled_commit: cafe\n')
})

await checkAsync('零注入（只给 runCw）也能跑完：内置提交器 + 内置规范化', async () => {
  const root = makeRepo()
  const docs = makeDocs()
  const { deps } = recordingDeps()
  // 只保留 runCw / cwBinary，提交回退到内置 commitWikiArtifacts（临时目录不是 git 仓库）
  const bare = { cwBinary: deps.cwBinary, runCw: deps.runCw }
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps: bare })
  assert.ok(exists(root, '.codewiki/modules/core.md'), '产物仍应落盘')
  assert.equal(r.commit.committed, false)
  assert.equal(r.outcome, 'partial', '非 git 仓库不许 done')
  assert.ok(r.blockers.some((b) => b.kind === 'commit-failed'))
})

await checkAsync('零注入 + 真 git 仓库 → 内置提交器真的能提交并且只含 wiki 产物', async () => {
  const { root } = gitRepo()
  const docs = makeDocs()
  writeFile(root, '.codewiki/_meta.yaml', 'last_compiled_commit: cafe\n')
  writeFile(root, '.codewiki/_index.md', '') // 占位让 .codewiki 存在（否则 paths 过滤后可能只剩入口）
  const { deps } = recordingDeps()
  const bare = { cwBinary: deps.cwBinary, runCw: deps.runCw }
  const r = await applyNativeOutput({ repoRoot: root, report: makeReport(), docsDir: docs, deps: bare })
  assert.equal(r.outcome, 'done', JSON.stringify(r.problems))
  assert.equal(r.commit.committed, true, JSON.stringify(r.commit))
  assert.equal(r.commit.scope.ok, true, JSON.stringify(r.commit.scope))
  assert.deepEqual([...r.commit.scope.unexpected], [])
})

// ─────────────────────────────────────────────────────────────────────────────
// 7) verifyCommitScope（真 git）
// ─────────────────────────────────────────────────────────────────────────────
function gitRepo() {
  const root = makeRepo()
  const run = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  run('init', '-q')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 'T')
  writeFile(root, 'src/app.js', 'console.log(1)\n')
  run('add', '--', 'src/app.js')
  run('commit', '-q', '-m', 'init', '--no-verify')
  return { root, run }
}

check('verifyCommitScope：只含 wiki 产物的提交判 ok', () => {
  const { root, run } = gitRepo()
  writeFile(root, '.codewiki/modules/a.md', '# a\n')
  writeFile(root, 'CodeWiki.md', '# CodeWiki\n')
  run('add', '--', '.codewiki', 'CodeWiki.md')
  run('commit', '-q', '-m', 'docs(wiki)：测试', '--no-verify')
  const r = verifyCommitScope(root, 'HEAD')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.unexpected, [])
  assert.equal(r.files.length, 2)
})

check('verifyCommitScope：混进源码的提交被判失败并列出越界文件', () => {
  const { root, run } = gitRepo()
  writeFile(root, '.codewiki/modules/a.md', '# a\n')
  writeFile(root, 'src/app.js', 'console.log(2)\n')
  run('add', '-A')
  run('commit', '-q', '-m', '混提交', '--no-verify')
  const r = verifyCommitScope(root, 'HEAD')
  assert.equal(r.ok, false)
  assert.deepEqual(r.unexpected, ['src/app.js'])
  assert.ok(r.reason.includes('src/app.js'))
})

check('verifyCommitScope：files 可直接传入，省一次 git', () => {
  const { root } = gitRepo()
  const r = verifyCommitScope(root, 'HEAD', { files: ['.codewiki/_index.md'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.files, ['.codewiki/_index.md'])
})

check('verifyCommitScope：allowExtra 里的路径不算越界', () => {
  const { root } = gitRepo()
  const r = verifyCommitScope(root, 'HEAD', { files: ['src/app.js', '.codewiki/_index.md'], allowExtra: ['src'] })
  assert.equal(r.ok, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 收尾
// ─────────────────────────────────────────────────────────────────────────────

for (const root of tmpRoots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length) {
  for (const f of failures) console.error(`\nFAIL ${f.name}\n  ${f.message}`)
  process.exit(1)
}
