// 阶段 2：manifest.js 的测试。
//
// 这一层判的是「环境可信吗」。它错的后果是：引擎悄悄换了版本而没人知道，
// 产物变化被误诊成模型问题。所以每条断言都盯一个具体的漂移场景。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANIFEST_VERSION,
  ENGINE_LOCK_REL,
  UPSTREAM_COMMIT,
  normalizeUpstreamCommit,
  probeEnvironment,
  fingerprintOf,
  readLock,
  compareLock,
  writeLock,
  doctor,
} from './lib/engine/manifest.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const root = mkdtempSync(join(tmpdir(), 'fsoft-manifest-'))
const fakeProbe = (over = {}) => async () => ({
  version: '2.0.0',
  pythonVersion: '3.12.10',
  pipCheck: { ok: true, output: 'No broken requirements found.' },
  ...over,
})

await check('probeEnvironment：收集版本/Python/pip check 并算出指纹', async () => {
  const env = await probeEnvironment({ probe: fakeProbe(), engineRoot: 'E:/x/src' })
  assert.equal(env.version, '2.0.0')
  assert.equal(env.pythonVersion, '3.12.10')
  assert.equal(env.pipCheckOk, true)
  assert.equal(env.engineRoot, 'E:/x/src')
  assert.match(env.fingerprint, /^[0-9a-f]{16}$/)
})

await check('probeEnvironment：没有 probe 函数直接报错（不静默返回空）', async () => {
  await assert.rejects(() => probeEnvironment({}), /需要 probe 函数/)
})

await check('fingerprintOf：版本相同指纹相同，版本变化指纹变化', async () => {
  const a = fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10' })
  const b = fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10' })
  const c = fingerprintOf({ version: '2.0.1', pythonVersion: '3.12.10' })
  const d = fingerprintOf({ version: '2.0.0', pythonVersion: '3.11.9' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
})

await check('fingerprintOf：pip check 状态不进指纹（修依赖不算换引擎）', async () => {
  const ok = fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10', pipCheckOk: true })
  const bad = fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10', pipCheckOk: false })
  assert.equal(ok, bad)
})

// ── 上游源码锁（规格 L221/L266：上游锁定 commit，经契约测试升级）──────────────
//
// 这一组的失败后果很具体：`codewiki 2.0.0` 是从上游源码 git 安装的，版本号写在
// pyproject 里、换了 commit 也不变。指纹若只看版本，「上游悄悄换了源码」就会报
// match，产物差异被误诊成模型问题，而那是最难查的一类。

await check('UPSTREAM_COMMIT：仓库声明的上游锁是合法 40 位十六进制', async () => {
  assert.match(UPSTREAM_COMMIT, /^[0-9a-f]{40}$/)
  assert.equal(normalizeUpstreamCommit(UPSTREAM_COMMIT), UPSTREAM_COMMIT)
})

await check('normalizeUpstreamCommit：38 位/大写/空白都不构成有效锁', async () => {
  // 38 位就是这次 code-review 抓到的那个抄错值（少了 d58）
  assert.equal(normalizeUpstreamCommit('03d0a294adf3c878bd8aeb0ef5e95a2ff8c3ca'), '')
  assert.equal(normalizeUpstreamCommit(`  ${UPSTREAM_COMMIT.toUpperCase()}  `), UPSTREAM_COMMIT)
  assert.equal(normalizeUpstreamCommit(''), '')
  assert.equal(normalizeUpstreamCommit(null), '')
})

await check('fingerprintOf：上游 commit 变化 → 指纹变化（版本号不动也算换引擎）', async () => {
  const a = fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10', upstreamCommit: UPSTREAM_COMMIT })
  const b = fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10', upstreamCommit: 'a'.repeat(40) })
  assert.notEqual(a, b)
  // 同一份声明重复算必须稳定
  assert.equal(a, fingerprintOf({ version: '2.0.0', pythonVersion: '3.12.10', upstreamCommit: UPSTREAM_COMMIT }))
})

await check('probeEnvironment：缺省带上游锁，并把上游锁写进 facts（不是只进指纹）', async () => {
  const env = await probeEnvironment({ probe: fakeProbe() })
  assert.equal(env.upstreamCommit, UPSTREAM_COMMIT)
  const custom = await probeEnvironment({ probe: fakeProbe(), upstreamCommit: 'b'.repeat(40) })
  assert.equal(custom.upstreamCommit, 'b'.repeat(40))
  assert.notEqual(custom.fingerprint, env.fingerprint)
})

await check('writeLock：上游 commit 落进 lock，可读回（文档锁 ≠ 机器可查的锁）', async () => {
  const repo = join(root, 'lock-upstream')
  const env = await probeEnvironment({ probe: fakeProbe() })
  writeLock({ repoRoot: repo, current: env })
  const back = readLock({ repoRoot: repo })
  assert.equal(back.upstreamCommit, UPSTREAM_COMMIT)
})

await check('compareLock：只有上游 commit 变了 → drift，字段是 upstreamCommit', async () => {
  const env = await probeEnvironment({ probe: fakeProbe() })
  const lock = { ...env, upstreamCommit: 'c'.repeat(40) }
  const r = compareLock({ current: env, lock })
  assert.equal(r.status, 'drift')
  assert.deepEqual(r.diffs.map((d) => d.field), ['upstreamCommit'])
  assert.equal(r.diffs[0].locked, 'c'.repeat(40))
  assert.equal(r.diffs[0].current, UPSTREAM_COMMIT)
})

await check('doctor：改了上游声明 → drift（升级上游必须被看见，而不是静默 match）', async () => {
  const repo = join(root, 'doc-upstream-drift')
  const first = await doctor({ probe: fakeProbe(), repoRoot: repo })
  writeLock({ repoRoot: repo, current: first.current })
  const r = await doctor({ probe: fakeProbe(), repoRoot: repo, upstreamCommit: 'd'.repeat(40) })
  assert.equal(r.status, 'drift')
  assert.equal(r.ok, false)
  assert.equal(r.diffs[0].field, 'upstreamCommit')
})

await check('doctor：上游声明不合法 → advice 里明确说「本轮不构成有效锁定」', async () => {
  const repo = join(root, 'doc-upstream-bad')
  const r = await doctor({ probe: fakeProbe(), repoRoot: repo, upstreamCommit: 'not-a-sha' })
  assert.match(r.advice, /不构成有效锁定/)
})

await check('readLock：没有 lock 文件返回 null（首次运行不是错误）', async () => {
  const repo = join(root, 'no-lock')
  mkdirSync(repo, { recursive: true })
  assert.equal(readLock({ repoRoot: repo }), null)
})

await check('readLock：坏 JSON 返回 null 而不是抛', async () => {
  const repo = join(root, 'bad-lock')
  mkdirSync(join(repo, '.codewiki'), { recursive: true })
  writeFileSync(join(repo, ENGINE_LOCK_REL), '{ not json', 'utf8')
  assert.equal(readLock({ repoRoot: repo }), null)
})

await check('compareLock：无 lock → absent', async () => {
  const current = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'abc', pipCheckOk: true }
  assert.equal(compareLock({ current, lock: null }).status, 'absent')
})

await check('compareLock：完全一致 → match', async () => {
  const current = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'abc', pipCheckOk: true }
  const lock = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'abc' }
  assert.equal(compareLock({ current, lock }).status, 'match')
})

await check('compareLock：引擎版本变了 → drift，且指出是哪个字段', async () => {
  const current = { version: '2.0.1', pythonVersion: '3.12.10', fingerprint: 'new', pipCheckOk: true }
  const lock = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'old' }
  const r = compareLock({ current, lock })
  assert.equal(r.status, 'drift')
  assert.deepEqual(r.diffs.map((d) => d.field), ['version'])
  assert.equal(r.diffs[0].locked, '2.0.0')
  assert.equal(r.diffs[0].current, '2.0.1')
})

await check('compareLock：Python 版本变了 → drift，字段是 pythonVersion', async () => {
  const current = { version: '2.0.0', pythonVersion: '3.11.9', fingerprint: 'new', pipCheckOk: true }
  const lock = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'old' }
  const r = compareLock({ current, lock })
  assert.equal(r.status, 'drift')
  assert.deepEqual(r.diffs.map((d) => d.field), ['pythonVersion'])
})

await check('compareLock：pip check 失败优先判 unhealthy（即使版本一致）', async () => {
  const current = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'abc', pipCheckOk: false }
  const lock = { version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'abc' }
  const r = compareLock({ current, lock })
  assert.equal(r.status, 'unhealthy')
})

await check('writeLock：落盘内容完整、可被 readLock 读回、目录自动创建', async () => {
  const repo = join(root, 'write')
  const current = {
    version: '2.0.0', pythonVersion: '3.12.10', fingerprint: 'f'.repeat(16),
    engineRoot: 'E:/x/src', pipCheckOk: true,
  }
  const rel = writeLock({ repoRoot: repo, current })
  assert.equal(rel, ENGINE_LOCK_REL)
  const back = readLock({ repoRoot: repo })
  assert.equal(back.manifestVersion, MANIFEST_VERSION)
  assert.equal(back.fingerprint, 'f'.repeat(16))
  assert.equal(back.version, '2.0.0')
  assert.equal(back.pipCheckOk, true)
  assert.ok(back.recordedAt)
})

await check('writeLock：缺 fingerprint 或 repoRoot 直接报错（不写半截文件）', async () => {
  assert.throws(() => writeLock({ repoRoot: root, current: {} }), /fingerprint/)
  assert.throws(() => writeLock({ current: { fingerprint: 'x' } }), /repoRoot/)
})

await check('writeLock：二次写入覆盖旧值且不留临时文件', async () => {
  const repo = join(root, 'rewrite')
  writeLock({ repoRoot: repo, current: { version: '1', pythonVersion: '3', fingerprint: 'aaa', pipCheckOk: true } })
  writeLock({ repoRoot: repo, current: { version: '2', pythonVersion: '3', fingerprint: 'bbb', pipCheckOk: true } })
  assert.equal(readLock({ repoRoot: repo }).version, '2')
  const files = fs.readdirSync(join(repo, '.codewiki'))
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [])
})

await check('doctor：首次（无 lock）ok=true、status=absent、给建议', async () => {
  const repo = join(root, 'doc-absent')
  mkdirSync(repo, { recursive: true })
  const r = await doctor({ probe: fakeProbe(), repoRoot: repo })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'absent')
  assert.ok(r.advice.length > 0)
})

await check('doctor：写 lock 后再 doctor → match', async () => {
  const repo = join(root, 'doc-match')
  const first = await doctor({ probe: fakeProbe(), repoRoot: repo })
  writeLock({ repoRoot: repo, current: first.current })
  const second = await doctor({ probe: fakeProbe(), repoRoot: repo })
  assert.equal(second.status, 'match')
  assert.equal(second.ok, true)
})

await check('doctor：引擎换版本后 → drift，ok=false，diffs 有证据', async () => {
  const repo = join(root, 'doc-drift')
  const first = await doctor({ probe: fakeProbe(), repoRoot: repo })
  writeLock({ repoRoot: repo, current: first.current })
  const r = await doctor({ probe: fakeProbe({ version: '2.1.0' }), repoRoot: repo })
  assert.equal(r.status, 'drift')
  assert.equal(r.ok, false)
  assert.equal(r.diffs[0].field, 'version')
})

await check('doctor：依赖不闭合 → unhealthy，ok=false，建议指向 setup-env.sh', async () => {
  const repo = join(root, 'doc-unhealthy')
  const first = await doctor({ probe: fakeProbe(), repoRoot: repo })
  writeLock({ repoRoot: repo, current: first.current })
  const r = await doctor({
    probe: fakeProbe({ pipCheck: { ok: false, output: 'codewiki 2.0.0 requires mermaid-parser-py' } }),
    repoRoot: repo,
  })
  assert.equal(r.status, 'unhealthy')
  assert.equal(r.ok, false)
  assert.match(r.advice, /setup-env\.sh/)
})

await check('doctor：probe 抛错 → probe-failed，不抛给调用方', async () => {
  const r = await doctor({ probe: async () => { throw new Error('ENOENT python') }, repoRoot: root })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'probe-failed')
  assert.match(r.advice, /ENOENT python/)
})

rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
