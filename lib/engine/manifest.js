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

export const MANIFEST_VERSION = 1
export const ENGINE_LOCK_REL = '.codewiki/engine-lock.json'

const posix = (p) => String(p ?? '').replace(/\\/g, '/')

/**
 * 探测引擎环境的只读事实。
 *
 * 调用方传进来 `probe`（一个返回 {ok, version, pythonVersion, pipCheck, ...} 的函数）
 * 而不是在这里 spawn —— 这样这层是纯的、可单测，进程管理留在 client.js。
 *
 * @param {object} options
 * @param {Function} options.probe  () => Promise<{version, pythonVersion, pipCheck:{ok,output}}>
 * @param {string} [options.engineRoot] 引擎源码根（仅记录，用于审计）
 */
export async function probeEnvironment({ probe, engineRoot } = {}) {
  if (typeof probe !== 'function') throw new Error('probeEnvironment: 需要 probe 函数')
  const raw = await probe()
  const facts = {
    version: String(raw?.version ?? '').trim(),
    pythonVersion: String(raw?.pythonVersion ?? '').trim(),
    pipCheckOk: raw?.pipCheck?.ok === true,
    pipCheckOutput: String(raw?.pipCheck?.output ?? '').trim(),
    engineRoot: engineRoot ? posix(engineRoot) : '',
  }
  return { ...facts, fingerprint: fingerprintOf(facts) }
}

// 指纹只吃**决定产物内容**的因素：引擎版本 + Python 版本。
// pip check 的 ok 不参与指纹——依赖闭合是「能不能跑」的闸门，
// 不是「产物会是什么」的输入；把它算进指纹会让每次修依赖都像换了引擎。
export function fingerprintOf(facts) {
  const h = createHash('sha256')
  h.update(`manifest:${MANIFEST_VERSION}\n`)
  h.update(`version:${String(facts?.version ?? '')}\n`)
  h.update(`python:${String(facts?.pythonVersion ?? '')}\n`)
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
  if (!lock) {
    return { status: 'absent', diffs: [], current: current.fingerprint ?? '', locked: '' }
  }
  const diffs = []
  const c = current
  const l = lock
  if (String(l.version ?? '') !== String(c.version ?? '')) {
    diffs.push({ field: 'version', locked: String(l.version ?? ''), current: String(c.version ?? '') })
  }
  if (String(l.pythonVersion ?? '') !== String(c.pythonVersion ?? '')) {
    diffs.push({ field: 'pythonVersion', locked: String(l.pythonVersion ?? ''), current: String(c.pythonVersion ?? '') })
  }
  if (String(l.fingerprint ?? '') !== String(c.fingerprint ?? '')) {
    // fingerprint 由上面两项算出：两项都一致但指纹不一致，说明指纹算法变了
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
export function writeLock({ repoRoot, current } = {}) {
  if (!repoRoot) throw new Error('writeLock: 需要 repoRoot')
  if (!current?.fingerprint) throw new Error('writeLock: 需要带 fingerprint 的 current')
  const file = path.join(String(repoRoot), ENGINE_LOCK_REL)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = {
    manifestVersion: MANIFEST_VERSION,
    fingerprint: current.fingerprint,
    version: String(current.version ?? ''),
    pythonVersion: String(current.pythonVersion ?? ''),
    engineRoot: String(current.engineRoot ?? ''),
    pipCheckOk: current.pipCheckOk === true,
    recordedAt: new Date().toISOString(),
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return ENGINE_LOCK_REL
}

/**
 * doctor：一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出来。
 * 返回 {ok, status, current, diffs, advice}——**不抛**（probe 抛错变成 ok:false）。
 */
export async function doctor({ probe, repoRoot, engineRoot } = {}) {
  let current
  try {
    current = await probeEnvironment({ probe, engineRoot })
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
  const advice = {
    absent: '首次运行：确认后写入 engine-lock.json',
    match: '环境与上次一致',
    drift: '引擎或 Python 版本变化，产物可能不同；确认后重写 lock',
    unhealthy: '依赖不闭合（pip check 失败）：先用 tools/fsoft-engine/setup-env.sh 修复环境',
    'probe-failed': '引擎不可用：检查 Python 路径与 FSoft 源码根',
  }[cmp.status] ?? ''
  return {
    ok: cmp.status === 'match' || cmp.status === 'absent',
    status: cmp.status,
    current,
    diffs: cmp.diffs,
    advice,
  }
}

export default {
  MANIFEST_VERSION,
  ENGINE_LOCK_REL,
  probeEnvironment,
  fingerprintOf,
  readLock,
  compareLock,
  writeLock,
  doctor,
}
