// 变更集测试（P0-1）：一次改动到底动了哪些文件，必须一次拿全。
//
// 背景缺陷：cw status 只跑 `git diff <last>..HEAD`，未提交源码修改、暂存区、未跟踪
// 新文件全部看不见。于是「改完代码还没提交就编译」会把未消化的变化当成已消化——
// 这正是审计确认的「增量漏检」。本文件钉住 collectChangeSet 的四路采集与降级语义。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectChangeSet } from './lib/change-set.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// 每个场景一个独立临时仓库：git init + 一次基线提交（含 .codewiki/_meta.yaml）
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwcs-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  const write = (rel, content = 'x\n') => {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  write('src/a.js', 'export const a = 1\n')
  write('src/b.js', 'export const b = 1\n')
  write('README.md', '# repo\n')
  write('.codewiki/_meta.yaml', 'project: x\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  const base = git(dir, ['rev-parse', 'HEAD']).trim()
  return { dir, base, write }
}

const allPaths = (cs) => (cs.all ?? []).slice().sort()
const names = (list) => (list ?? []).map((e) => (typeof e === 'string' ? e : e.path)).sort()

await check('非 git 目录：明确 no-git，不假装 clean', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwcs-nogit-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n')
  const cs = collectChangeSet(dir, 'deadbeef')
  assert.equal(cs.state, 'no-git')
  assert.equal(cs.ok, false)
  assert.deepEqual(cs.all, [])
  assert.ok(cs.reason, '降级必须带原因')
})

await check('缺 baseCommit：state=missing-base，ok=false', async () => {
  const { dir } = makeRepo()
  const cs = collectChangeSet(dir, '')
  assert.equal(cs.state, 'missing-base')
  assert.equal(cs.ok, false)
  assert.equal(cs.fallback, 'full')
})

await check('base 不可达（历史里没有这个 commit）：state=unreachable-base，退回 full', async () => {
  const { dir } = makeRepo()
  const cs = collectChangeSet(dir, '0'.repeat(40))
  assert.equal(cs.state, 'unreachable-base')
  assert.equal(cs.ok, false)
  assert.equal(cs.fallback, 'full')
  assert.ok(String(cs.reason).includes('0'.repeat(7)))
})

await check('干净仓库（base==HEAD）：all 为空、ok=true', async () => {
  const { dir, base } = makeRepo()
  const cs = collectChangeSet(dir, base)
  assert.equal(cs.ok, true)
  assert.equal(cs.state, 'ok')
  assert.deepEqual(cs.all, [])
  assert.equal(cs.headCommit, base)
  assert.equal(cs.baseCommit, base)
})

await check('仅未提交修改（unstaged）：进 all，且归类到 unstaged', async () => {
  const { dir, base, write } = makeRepo()
  write('src/a.js', 'export const a = 2\n')
  const cs = collectChangeSet(dir, base)
  assert.equal(cs.ok, true)
  assert.deepEqual(allPaths(cs), ['src/a.js'])
  assert.deepEqual(names(cs.unstaged), ['src/a.js'])
  assert.deepEqual(names(cs.staged), [])
  assert.deepEqual(cs.untracked, [])
})

await check('仅 staged 改动：进 all 并归 staged（不是 unstaged）', async () => {
  const { dir, base, write } = makeRepo()
  write('src/a.js', 'export const a = 3\n')
  git(dir, ['add', 'src/a.js'])
  const cs = collectChangeSet(dir, base)
  assert.deepEqual(allPaths(cs), ['src/a.js'])
  assert.deepEqual(names(cs.staged), ['src/a.js'])
  assert.deepEqual(names(cs.unstaged), [])
})

await check('untracked 新文件：进 all 并归 untracked', async () => {
  const { dir, base, write } = makeRepo()
  write('src/new.js', 'export const n = 1\n')
  const cs = collectChangeSet(dir, base)
  assert.deepEqual(allPaths(cs), ['src/new.js'])
  assert.deepEqual(cs.untracked, ['src/new.js'])
})

await check('删除文件：进 deleted 与 all', async () => {
  const { dir, base } = makeRepo()
  fs.rmSync(path.join(dir, 'src/b.js'))
  const cs = collectChangeSet(dir, base)
  assert.deepEqual(allPaths(cs), ['src/b.js'])
  assert.deepEqual(names(cs.deleted), ['src/b.js'])
})

await check('改名：记 renamed（from→to），all 同时含两端', async () => {
  const { dir, base } = makeRepo()
  git(dir, ['mv', 'src/b.js', 'src/b2.js'])
  const cs = collectChangeSet(dir, base)
  assert.equal(cs.renamed.length, 1, `应记 1 条改名，实际 ${JSON.stringify(cs.renamed)}`)
  assert.equal(cs.renamed[0].from, 'src/b.js')
  assert.equal(cs.renamed[0].path, 'src/b2.js')
  assert.deepEqual(allPaths(cs), ['src/b.js', 'src/b2.js'])
})

await check('committed 变更（base..HEAD）：进 committed 与 all', async () => {
  const { dir, base, write } = makeRepo()
  write('src/a.js', 'export const a = 4\n')
  git(dir, ['commit', '-qam', 'change a'])
  const cs = collectChangeSet(dir, base)
  assert.deepEqual(names(cs.committed), ['src/a.js'])
  assert.deepEqual(allPaths(cs), ['src/a.js'])
  assert.notEqual(cs.headCommit, base)
})

await check('四路合并去重：同一文件既在 committed 又在 unstaged 时 all 只出现一次', async () => {
  const { dir, base, write } = makeRepo()
  write('src/a.js', 'export const a = 5\n')
  git(dir, ['commit', '-qam', 'committed a'])
  write('src/a.js', 'export const a = 6\n')
  const cs = collectChangeSet(dir, base)
  assert.deepEqual(allPaths(cs), ['src/a.js'], `all 应去重，实际 ${JSON.stringify(cs.all)}`)
  assert.deepEqual(names(cs.committed), ['src/a.js'])
  assert.deepEqual(names(cs.unstaged), ['src/a.js'])
})

await check('.codewiki/ 自身产物不计入源码变更（sourceChanges 排除、ignored 记账）', async () => {
  const { dir, base, write } = makeRepo()
  write('.codewiki/modules/x.md', '---\ntitle: x\n---\n')
  write('.codewiki/_meta.yaml', 'project: x\ncompiled: 1\n')
  write('README.md', '# changed\n')
  const cs = collectChangeSet(dir, base)
  assert.deepEqual(allPaths(cs), ['.codewiki/_meta.yaml', '.codewiki/modules/x.md', 'README.md'])
  assert.deepEqual((cs.sourceChanges ?? []).slice().sort(), ['README.md'],
    `sourceChanges 只该剩真实源码/文档，实际 ${JSON.stringify(cs.sourceChanges)}`)
  assert.deepEqual((cs.ignored ?? []).slice().sort(), ['.codewiki/_meta.yaml', '.codewiki/modules/x.md'])
  // README/CHANGELOG 等被文章引用的文档仍是合法 source
  assert.equal(cs.ignored.includes('README.md'), false)
})

await check('路径一律规范化为 POSIX（无反斜杠、无 ./ 前缀）', async () => {
  const { dir, base, write } = makeRepo()
  write('src/deep/nested/c.js', 'export const c = 1\n')
  const cs = collectChangeSet(dir, base)
  for (const p of cs.all) {
    assert.equal(p.includes('\\'), false, `路径应无反斜杠：${p}`)
    assert.equal(p.startsWith('./'), false, `路径不应带 ./ 前缀：${p}`)
  }
  assert.deepEqual(allPaths(cs), ['src/deep/nested/c.js'])
})

await check('可注入 execFile（离线单测路径，不依赖真实 git）', async () => {
  const calls = []
  const fake = (cmd, args) => {
    calls.push([cmd, ...args])
    const joined = args.join(' ')
    if (joined.includes('rev-parse HEAD')) return 'head123\n'
    if (joined.includes('cat-file')) return 'base123\n'
    if (joined.includes('name-status') && joined.includes('base123..')) return 'M\tsrc/a.js\n'
    if (joined.includes('--cached')) return ''
    if (joined.includes('ls-files')) return 'src/new.js\n'
    return ''
  }
  const cs = collectChangeSet('/fake', 'base123', { execFile: fake })
  assert.equal(cs.ok, true, cs.reason)
  assert.deepEqual(names(cs.committed), ['src/a.js'])
  assert.deepEqual(cs.untracked, ['src/new.js'])
  assert.ok(calls.some((c) => c.includes('rev-parse')), '应通过注入的执行器调用 git')
})

await check('ChangeSet 可 JSON 序列化（要写进 update-record）', async () => {
  const { dir, base, write } = makeRepo()
  write('src/a.js', 'export const a = 7\n')
  const cs = collectChangeSet(dir, base)
  const round = JSON.parse(JSON.stringify(cs))
  assert.deepEqual(round.all, cs.all)
  assert.equal(round.version, cs.version)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
