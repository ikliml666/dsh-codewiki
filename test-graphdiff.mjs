// 对拍测试：lib/graph-diff.js 与 FSoft 上游 Python 原版逐位一致。
// 基准由 test-fixtures/gen-graphdiff-golden.py 用 Python 原生 difflib/hashlib 生成
// （python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bodySimilarity, bodyHash, unifiedDiff, diffGraphs, serializeDiff,
  sequenceRatio, normalizeBody, documentedSource, truncateToTokens,
} from './lib/graph-diff.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const goldenPath = path.join(here, 'test-fixtures', 'graphdiff-golden.json')
if (!fs.existsSync(goldenPath)) {
  console.error('缺少基准文件 test-fixtures/graphdiff-golden.json，先跑：python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json')
  process.exit(1)
}
const cases = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))

let pass = 0
const fails = []

function splitKeepEnds(s) {
  if (!s) return []
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

for (const c of cases) {
  if (c.kind === 'similarity') {
    const got = bodySimilarity(c.a, c.b)
    if (Math.abs(got - c.expected) < 1e-12) pass++
    else fails.push({ ...c, got, why: 'similarity' })
  } else if (c.kind === 'hash') {
    const got = bodyHash({ sourceCode: c.code, docstring: c.docstring })
    if (got === c.expected) pass++
    else fails.push({ ...c, got, why: 'hash' })
  } else if (c.kind === 'unified') {
    const got = unifiedDiff(splitKeepEnds(c.oldText), splitKeepEnds(c.newText), `a/${c.label}`, `b/${c.label}`, 2)
    if (got === c.expected) pass++
    else fails.push({ ...c, got, why: 'unified' })
  }
}

console.log(`对拍用例：${cases.length}，通过 ${pass}，失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails.slice(0, 5)) {
    console.log('--- FAIL:', f.why)
    console.log('  input:', JSON.stringify(f.a ?? f.code ?? f.oldText))
    console.log('  expect:', JSON.stringify(f.expected))
    console.log('  got   :', JSON.stringify(f.got))
  }
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 组件级 diff：改名配对、interface/body/edge 分类
// ---------------------------------------------------------------------------
const mk = (id, name, src, opts = {}) => ({
  id, name, kind: opts.kind ?? 'function',
  relativePath: opts.relativePath ?? 'src/a.js',
  sourceCode: src,
  docstring: opts.docstring ?? '',
  parameters: opts.parameters ?? [],
  baseClasses: opts.baseClasses ?? [],
  dependsOn: opts.dependsOn ?? [],
})

const oldG = new Map([
  ['a.js#foo', mk('a.js#foo', 'foo', 'function foo(x){ return x + 1 }')],
  ['a.js#bar', mk('a.js#bar', 'bar', 'function bar(){ return 1 }')],
  ['a.js#baz', mk('a.js#baz', 'baz', 'function baz(){ return 2 }')],
  ['a.js#gone', mk('a.js#gone', 'gone', 'function gone(){ let q = 9; return q * 3 }')],
  ['a.js#sig', mk('a.js#sig', 'sig', 'function sig(a){ return a }')],
])
const newG = new Map([
  ['a.js#foo', mk('a.js#foo', 'foo', 'function foo(x){ return x + 1 }')], // 未变
  ['a.js#bar', mk('a.js#bar', 'bar', 'function bar(){ return 42 }')], // body
  ['a.js#baz', mk('a.js#baz', 'baz', 'function baz(){ return 2 }', { dependsOn: ['a.js#foo'] })], // edge
  ['a.js#sig', mk('a.js#sig', 'sig', 'function sig(a, b){ return a }', { parameters: ['a', 'b'] })], // interface
  ['a.js#renamed', mk('a.js#renamed', 'renamed', 'function gone(){ let q = 9; return q * 3 }')], // renamed
  ['a.js#fresh', mk('a.js#fresh', 'fresh', 'function fresh(){ return 7 }')], // added
])
const d = diffGraphs(oldG, newG)
const s = serializeDiff(d)

const checks = []
checks.push(['body 分类', s.body.includes('a.js#bar')])
checks.push(['edge 分类', s.edge.includes('a.js#baz')])
checks.push(['interface 分类', s.interface.includes('a.js#sig')])
checks.push(['未变不登记', !s.body.includes('a.js#foo') && !s.interface.includes('a.js#foo') && !s.edge.includes('a.js#foo')])
checks.push(['改名配对', s.renamed['a.js#gone'] === 'a.js#renamed'])
checks.push(['改名后不算 deleted/added', !s.deleted.includes('a.js#gone') && !s.added.includes('a.js#renamed')])
checks.push(['新增登记', s.added.includes('a.js#fresh')])
checks.push(['counts 自洽', s.counts.body === d.body.size && s.counts.renamed === d.renamed.size])

let ok = true
for (const [labelText, cond] of checks) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${labelText}`)
  if (!cond) ok = false
}

// 序列化往返：Set/Map 转数组后字段齐全
const round = JSON.parse(JSON.stringify(s))
ok = ok && round.counts && Array.isArray(round.added) && typeof round.renamed === 'object'

console.log(ok ? '\nALL PASS' : '\nHAS FAILURES')
process.exit(ok ? 0 : 1)
