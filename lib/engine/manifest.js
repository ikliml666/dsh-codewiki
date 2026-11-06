// 阶段 2：引擎清单（manifest）——回答「现在跑的是哪个引擎、哪个环境」。
//
// 为什么需要它：FSoft 是**外部**引擎，版本与依赖都不由本仓库控制。没有清单的话，
// 同一份 wiki 在不同机器/不同 pip 状态下会产出不同结果，而错误会表现为
// 「模型不听话」而不是「环境漂了」——最难查的一类问题。
//
// 这里只做三件事：
//   1. **指纹**：读引擎版本 + 依赖闭合状态，算一个稳定 hash；
//   2. **比对**：把当前指纹与落盘的 lock 比，不一致就明确说哪一项不一致；
//   3. **落盘**：把指纹写到 .codewiki/engine-lock.json，供下次比对与审计。
//
// 不做的：不装依赖、不修环境、不联网。doctor 是**只读诊断**，
// 它报告事实，由上层决定要不要重新 setup（那是 1A 的 setup-env.sh 的职责）。

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { toPosix as posix } from '../git-paths.js'

export const MANIFEST_VERSION = 1
export const ENGINE_LOCK_REL = '.codewiki/engine-lock.json'

// 上游锁定的 FSoft 源码 commit（阶段 2 契约：升级上游必须走「改这个常量 + 跑契约测试」，
// 而不是「pip install 到最新版然后祈祷」）。
//
// 为什么必须是**显式常量**而不是从运行时探测：引擎的 doctor/generate 都会自报一个
// `engine.commit`，但那个值取自 `_git_commit(repo_path)`——它是**被编译仓库的 HEAD**，
// 不是 FSoft 源码自己的 commit。把它当上游锁会让「换了上游源码」这件事永远不进指纹，
// 而「本仓库提交了一次」反而像换了引擎。两个概念必须分开记：
//   · upstreamCommit —— 本仓库声明的上游源码锁（审计与漂移判据的唯一来源）
//   · engine.commit  —— 引擎自报的运行现场（只作证据，不参与判定）
//
// a1b9f4a（2026-11-05）：上游并入 PR #155，新增 Backstage TechDocs 导出
// （`codewiki/cli/techdocs_generator.py` + `commands/techdocs.py`，无 LLM 调用）。
// 升到它是为了接那份能力（entry.py 传给 adapter，native-run 段 3.8 读回写集）。上游内部模块
// （updater / orchestrator / leaf_agent / call_graph_analyzer）在这两个提交里一行未动，
// 已用 install_full_runtime / install_incremental_runtime 的源码锚点校验过。
export const UPSTREAM_COMMIT = 'a1b9f4acac4d3e1925c9d49e258b618741410540'

// 上游 commit 的规范形：40 位小写十六进制。认不出来就返回 ''（= 未知），
// 而不是把半截/大写的串当合法值写进锁——那是「锁了但锁错了」。
export function normalizeUpstreamCommit(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(s) ? s : ''
}

/**
 * 探测引擎环境的只读事实。
 *
 * 调用方传进来 `probe`（一个返回 {ok, version, pythonVersion, pipCheck, ...} 的函数）
 * 而不是在这里 spawn —— 这样这层是纯的、可单测，进程管理留在 client.js。
 *
 * @param {object} options
 * @param {Function} options.probe  () => Promise<{version, pythonVersion, pipCheck:{ok,output}}>
 * @param {string} [options.engineRoot] 引擎源码根（仅记录，用于审计）
 * @param {string} [options.upstreamCommit] 上游源码锁定 commit（缺省用 UPSTREAM_COMMIT）
 */
export async function probeEnvironment({ probe, engineRoot, upstreamCommit = UPSTREAM_COMMIT } = {}) {
  if (typeof probe !== 'function') throw new Error('probeEnvironment: 需要 probe 函数')
  const raw = await probe()
  const facts = {
    version: String(raw?.version ?? '').trim(),
    pythonVersion: String(raw?.pythonVersion ?? '').trim(),
    upstreamCommit: normalizeUpstreamCommit(upstreamCommit),
    pipCheckOk: raw?.pipCheck?.ok === true,
    pipCheckOutput: String(raw?.pipCheck?.output ?? '').trim(),
    engineRoot: engineRoot ? posix(engineRoot) : '',
  }
  return { ...facts, fingerprint: fingerprintOf(facts) }
}

// 指纹只吃**决定产物内容**的因素：引擎版本 + Python 版本 + 上游源码 commit。
//
// 为什么上游 commit 必须进指纹：FSoft 的产物由它的算法决定，而 `codewiki 2.0.0`
// 这个版本号在源码从 git 直接安装时**根本不跟着变**（版本是 pyproject 里写死的）。
// 上游换了一个 commit 而版本号不动，指纹若只看版本就会报 match，于是「换了引擎」
// 被静默当成「环境没变」，产物差异再被误诊成模型不听话——这正是设计文档 L221/L266
// 要求锁定 commit、且经契约测试才允许升级的原因。
//
// pip check 的 ok 仍然不参与指纹——依赖闭合是「能不能跑」的闸门，
// 不是「产物会是什么」的输入；把它算进指纹会让每次修依赖都像换了引擎。
export function fingerprintOf(facts) {
  const h = createHash('sha256')
  h.update(`manifest:${MANIFEST_VERSION}\n`)
  h.update(`version:${String(facts?.version ?? '')}\n`)
  h.update(`python:${String(facts?.pythonVersion ?? '')}\n`)
  h.update(`upstream:${normalizeUpstreamCommit(facts?.upstreamCommit)}\n`)
  return h.digest('hex').slice(0, 16)
}

/**
 * 读已落盘的 lock。不存在/坏了都返回 null（不是错误：首次运行本来没有 lock）。
 */
export function readLock({ repoRoot } = {}) {
  const file = path.join(String(repoRoot ?? ''), ENGINE_LOCK_REL)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 比对当前指纹与 lock。返回可机读的差异项（不是抛错、不是布尔）。
 *
 * status:
 *   'absent'     — 没有 lock（首次运行，需要写一份）
 *   'match'      — 完全一致
 *   'drift'      — 引擎版本或 Python 版本变了（产物可能不同，必须让上层知道）
 *   'unhealthy'  — 指纹一致但环境不闭合（pip check 失败）：能跑但不可信
 */
export function compareLock({ current, lock } = {}) {
  if (!current) throw new Error('compareLock: 需要 current 指纹')
  const diffs = []
  const c = current
  const l = lock
  if (!lock) {
    // 「没有 lock」不等于「环境健康」：pip check 失败时引擎能跑但依赖不闭合，
    // 产物不可信。曾在比对任何字段之前就 return 'absent'，于是这条事实被
    // 整个吞掉——调用方看到 absent 只会以为「首次运行」，照跑不误。
    if (c.pipCheckOk !== true) {
      return { status: 'unhealthy', diffs, current: c.fingerprint ?? '', locked: '' }
    }
    return { status: 'absent', diffs, current: c.fingerprint ?? '', locked: '' }
  }
  if (String(l.version ?? '') !== String(c.version ?? '')) {
    diffs.push({ field: 'version', locked: String(l.version ?? ''), current: String(c.version ?? '') })
  }
  if (String(l.pythonVersion ?? '') !== String(c.pythonVersion ?? '')) {
    diffs.push({ field: 'pythonVersion', locked: String(l.pythonVersion ?? ''), current: String(c.pythonVersion ?? '') })
  }
  // 上游源码 commit 单独作为一条 diff：它变了就等于换了引擎（算法可能整段重写），
  // 但版本号（`codewiki 2.0.0`，pyproject 里写死的）不会跟着变。只报 version 会让人
  // 以为「版本一样啊」，而真正变的是那份源码。
  const lockedUpstream = normalizeUpstreamCommit(l.upstreamCommit)
  const currentUpstream = normalizeUpstreamCommit(c.upstreamCommit)
  if (lockedUpstream !== currentUpstream) {
    diffs.push({
      field: 'upstreamCommit',
      locked: lockedUpstream || String(l.upstreamCommit ?? ''),
      current: currentUpstream || String(c.upstreamCommit ?? ''),
    })
  }
  if (String(l.fingerprint ?? '') !== String(c.fingerprint ?? '')) {
    // fingerprint 由上面几项算出：各项都一致但指纹不一致，说明指纹算法变了
    if (!diffs.length) diffs.push({ field: 'fingerprint', locked: String(l.fingerprint ?? ''), current: String(c.fingerprint ?? '') })
  }
  if (c.pipCheckOk !== true) {
    return { status: 'unhealthy', diffs, current: c.fingerprint ?? '', locked: String(l.fingerprint ?? '') }
  }
  if (diffs.length) {
    return { status: 'drift', diffs, current: c.fingerprint ?? '', locked: String(l.fingerprint ?? '') }
  }
  return { status: 'match', diffs, current: c.fingerprint ?? '', locked: String(l.fingerprint ?? '') }
}

/**
 * 把当前环境事实写成 lock（原子写：先写临时文件再 rename，避免半截文件）。
 * 返回写入的相对路径。
 */
/**
 * 构造 lock 的落盘正文（不写盘）。
 *
 * 单独拆出来是因为「落锁」的时机必须与产物同批：`native-run` 把这份正文当成
 * apply 写集里的一项，与文章/状态共享同一份 pre-image——写入与提交都跟着产物走，
 * 失败一起回滚。若仍由 `writeLock` 在 apply 之后直接写盘，那份文件就落在提交之外，
 * 下一轮会被当成「有未提交改动」再提交一次，无变化的一轮也会因此凭空产生一个 commit。
 */
export function buildLockBody(current) {
  if (!current?.fingerprint) throw new Error('buildLockBody: 需要带 fingerprint 的 current')
  return `${JSON.stringify({
    manifestVersion: MANIFEST_VERSION,
    fingerprint: current.fingerprint,
    version: String(current.version ?? ''),
    pythonVersion: String(current.pythonVersion ?? ''),
    // 上游源码锁落盘：这是「上次跑的是哪份 FSoft 源码」的唯一机器可读记录。
    // 不写它的话，「上游锁了 commit」只存在于文档里——文档不会在下一次 doctor
    // 时参与比对，锁了等于没锁。
    upstreamCommit: normalizeUpstreamCommit(current.upstreamCommit) || String(current.upstreamCommit ?? ''),
    engineRoot: String(current.engineRoot ?? ''),
    pipCheckOk: current.pipCheckOk === true,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`
}

/**
 * 把当前环境事实写成 lock（原子写：先写临时文件再 rename，避免半截文件）。
 * 返回写入的相对路径。
 */
export function writeLock({ repoRoot, current } = {}) {
  if (!repoRoot) throw new Error('writeLock: 需要 repoRoot')
  const file = path.join(String(repoRoot), ENGINE_LOCK_REL)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, buildLockBody(current), 'utf8')
  fs.renameSync(tmp, file)
  return ENGINE_LOCK_REL
}

/**
 * doctor：一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出来。
 * 返回 {ok, status, current, diffs, advice}——**不抛**（probe 抛错变成 ok:false）。
 */
export async function doctor({ probe, repoRoot, engineRoot, upstreamCommit = UPSTREAM_COMMIT } = {}) {
  let current
  try {
    current = await probeEnvironment({ probe, engineRoot, upstreamCommit })
  } catch (err) {
    return {
      ok: false,
      status: 'probe-failed',
      current: null,
      diffs: [],
      advice: `引擎探测失败：${err?.message ?? err}`,
    }
  }
  const lock = readLock({ repoRoot })
  const cmp = compareLock({ current, lock })
  const upstreamNote = !normalizeUpstreamCommit(upstreamCommit)
    ? '上游 commit 未声明或格式不合法（需 40 位十六进制）：本轮不构成有效锁定'
    : ''
  const advice = {
    absent: '首次运行：确认后写入 engine-lock.json',
    match: '环境与上次一致',
    drift: '引擎版本 / Python 版本 / 上游源码 commit 变化，产物可能不同；确认后重写 lock',
    unhealthy: '依赖不闭合（pip check 失败）：先用 tools/fsoft-engine/setup-env.sh 修复环境',
    'probe-failed': '引擎不可用：检查 Python 路径与 FSoft 源码根',
  }[cmp.status] ?? ''
  return {
    ok: cmp.status === 'match' || cmp.status === 'absent',
    status: cmp.status,
    current,
    diffs: cmp.diffs,
    advice: [advice, upstreamNote].filter(Boolean).join('；'),
  }
}

export default {
  MANIFEST_VERSION,
  ENGINE_LOCK_REL,
  UPSTREAM_COMMIT,
  normalizeUpstreamCommit,
  probeEnvironment,
  fingerprintOf,
  readLock,
  compareLock,
  buildLockBody,
  writeLock,
  doctor,
}
