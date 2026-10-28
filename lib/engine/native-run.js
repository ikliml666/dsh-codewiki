// 阶段 4：原生引擎的一次「完整编译」编排（生产通道）。
//
// 为什么单独一层：JobService（index.js）已有 4800+ 行，把 doctor/锁校验/模型桥/
// runEngine/gate/apply 全塞进 tick 里，会让「终态到底由谁裁决」再次含糊——而
// 0.14.0 花一整轮修掉的缺陷正是这一类（引擎说 done 就 done，产物没入库也报完成）。
// 所以这里只做一件事：把一次编译的**裁决链**固定成一条直线，每一步的结论都不能
// 被下一步洗白：
//
//   env(doctor + engine-lock) → graph/cluster/articles(引擎) → validate(质量门) → index/baseline/commit(落地器)
//
// 硬不变量（与 contract.js / quality-gate.js / apply-plan.js 不变量叠加）：
//   1. 锁不一致 / 依赖不闭合 → 直接 failed，**不跑引擎**（跑出来的产物不可信，
//      而且「先跑再发现环境漂了」会让用户看到一堆无意义的失败文章）。
//   2. 引擎 done **不能**替代质量门：gate 说 partial，终态就是 partial。
//   3. 落地器（apply）说 partial/failed，终态不许是 done：产物没入库就是没交付。
//   4. partial/failed 一律不推进基线（canAdvanceBaseline=false），交给上层决定。
//   5. 取消是终态：取消后不再 gate/apply，也不覆盖已写好的终态。
//
// 全部依赖注入：真实实现直接从 client/manifest/quality-gate/apply-plan 取，
// 测试可以换成假 runEngine + 真实 gate/apply，从而既覆盖接线又覆盖裁决。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { engineResult, engineError, engineProgress } from './contract.js'
import { runEngine as realRunEngine } from './client.js'
import { doctor as realDoctor, probeEnvironment, writeLock } from './manifest.js'
import { gateNativeOutput as realGate, toContractBlockers } from './quality-gate.js'
import { applyNativeOutput as realApply } from './apply-plan.js'
import { startLlmBridge as realBridge } from './llm-bridge.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ENGINE_ENTRY = path.join(here, 'python', 'entry.py')

// 一次原生编译的默认超时：FSoft 全量在真实仓库上按 10 分钟量级设计（阶段 1C 实测
// 小 fixture 约 1 分钟，真实仓库更久）。超时由引擎侧进程树终止兜底，不靠上层 tick。
export const DEFAULT_ENGINE_TIMEOUT_MS = 45 * 60 * 1000

// 终态强弱：合成终态只能取「最弱」的那一个，绝不允许被后续步骤提升。
const RANK = { cancelled: 0, failed: 1, partial: 2, done: 3 }
const weakest = (a, b) => (RANK[a] <= RANK[b] ? a : b)

function noop() {}

// 把 apply/gate 的结论翻成契约 blockers（kind 必须来自 contract.js 的 BLOCKER_KINDS）。
function applyBlockersOf(applyRes) {
  return (applyRes?.blockers ?? []).map((b) => ({
    kind: b.kind,
    detail: String(b.detail ?? '').slice(0, 2000),
    ...(b.target ? { target: String(b.target) } : {}),
  }))
}

/**
 * 跑一次原生编译并给出**严格**终态。
 *
 * @param {object} o
 * @param {string} o.repoRoot            仓库根（绝对路径）
 * @param {'full'|'stale'|'auto'} [o.scope]  full/stale 决定 generate/update；auto 按 kind
 * @param {string} [o.kind]              任务 kind（'full' | 'stale'）
 * @param {string} [o.requestId]         协议 requestId（缺省用时间戳生成）
 * @param {AbortSignal} [o.signal]       取消信号（→ 终止受管子进程树）
 * @param {number} [o.timeoutMs]         引擎单次超时
 * @param {object} [o.deps]              依赖注入（测试用；缺省走真实实现）
 * @returns {Promise<object>} 形如 EngineResult，附加 apply/gate/engine 现场证据
 */
export async function runNativeJob({
  repoRoot,
  scope = 'full',
  kind = null,
  requestId = null,
  signal = null,
  timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS,
  requireCommittedInput = true,
  docsDir = null,
  deps = {},
  onProgress = noop,
  onLog = noop,
} = {}) {
  const startedAt = new Date().toISOString()
  const root = repoRoot ? path.resolve(String(repoRoot)) : null
  if (!root) throw new Error('runNativeJob: 需要 repoRoot')
  const rid = String(requestId ?? `native-${Date.now().toString(36)}`)

  const doctorImpl = deps.doctor ?? realDoctor
  const runEngineImpl = deps.runEngine ?? realRunEngine
  const gateImpl = deps.gate ?? realGate
  const applyImpl = deps.apply ?? realApply
  const bridgeImpl = deps.bridge ?? realBridge
  const writeLockImpl = deps.writeLock ?? writeLock
  const probeImpl = deps.probe ?? null
  const engineFor = deps.engineFor ?? null
  const cfg = deps.config ?? {}

  // 统一出口：所有分支都必须经过这里，保证 outcome 合法且带上现场证据。
  const settle = (patch) => {
    const outcome = patch.outcome
    const base = {
      outcome,
      stage: patch.stage ?? null,
      blockers: patch.blockers ?? [],
      error: patch.error ?? null,
      writtenCount: patch.writtenCount ?? 0,
      failedCount: patch.failedCount ?? 0,
      engine: patch.engine ?? { version: '', commit: '', python: '', deps: { ok: false, summary: '' } },
      usage: patch.usage ?? undefined,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
    // engineResult 的硬不变量在这里生效：done 不许带 blockers、partial 必须带 blockers、
    // failed 必须有 error。构造不合法会抛错 —— 那是接线 bug，必须响。
    const normalized = engineResult(base)
    return {
      ...normalized,
      requestId: rid,
      canAdvanceBaseline: normalized.outcome === 'done',
      artifacts: patch.artifacts ?? { docsDir: '', rawTreeDir: '', updateRecord: '' },
      gate: patch.gate ?? null,
      apply: patch.apply ?? null,
      engineLock: patch.engineLock ?? null,
      notes: patch.notes ?? [],
    }
  }

  if (signal?.aborted) {
    return settle({
      outcome: 'cancelled',
      blockers: [{ kind: 'cancelled', detail: '提交前已取消' }],
    })
  }

  // ── 1) 环境与锁：不一致就不跑引擎 ────────────────────────────────────────
  const progress = (stage, percent, message, extra = {}) => {
    try {
      onProgress(engineProgress({ stage, percent, message, ...extra }))
    } catch { /* 进度消费者异常不影响编译 */ }
  }
  progress('env', 3, '校验引擎环境与依赖锁定')

  // probe 失败原因（解释器缺失/入口崩）在这里收集，供下面判「环境缺失」用。
  // 不放进 manifest 的 facts：facts 描述的是环境事实，不是本次调用的事故。
  let probeError = null
  const probe = probeImpl ?? (async () => {
    // 真实探测：跑一次 doctor 动作，把它的 engine 现场翻成 manifest 需要的事实。
    const res = await runEngineImpl({
      requestId: `${rid}-doctor`,
      action: 'doctor',
      engine: engineFor ? engineFor({ requestId: `${rid}-doctor` }) : cfg.engine,
      cwd: root,
      timeoutMs: Math.min(timeoutMs, 120000),
      onLog: (e) => onLog({ ...e, phase: 'doctor' }),
    })
    const eng = res?.engine ?? {}
    // 探测本身失败（解释器缺失/entry 崩）必须带出去：否则 manifest 只看到一个空指纹，
    // doctor 会把它当成「版本不明」，上层就分不清「引擎没装」和「装了但坏了」。
    // probeError 只存本条消息的文本，不碰 manifest 的对外形状（那里只有 facts）。
    if (res?.outcome === 'failed') {
      probeError = String(res?.error?.message ?? '引擎 doctor 探测失败')
    }
    return {
      version: eng.version ?? '',
      pythonVersion: eng.python ?? '',
      pipCheck: { ok: eng.deps?.ok === true, output: eng.deps?.summary ?? '' },
    }
  })

  let doc
  try {
    doc = await doctorImpl({ probe, repoRoot: root, engineRoot: cfg.engineRoot ?? null })
  } catch (err) {
    return settle({
      outcome: 'failed',
      stage: 'env',
      error: engineError({ code: 'engine-missing', message: `环境探测异常：${err?.message ?? err}`, stage: 'env' }),
    })
  }
  const lockStatus = doc?.status ?? 'probe-failed'
  if (lockStatus === 'probe-failed' || probeError) {
    // 解释器/入口不可用属于环境缺失：如实 fail，不降级去跑旧实现（那会让「原生通道坏了」
    // 表现为「编译结果忽然变成另一种样子」）。
    return settle({
      outcome: 'failed',
      stage: 'env',
      error: engineError({
        code: 'engine-missing',
        message: probeError || doc?.advice || '引擎不可用',
        stage: 'env',
      }),
      engineLock: { status: lockStatus, diffs: doc?.diffs ?? [] },
    })
  }
  if (lockStatus === 'drift') {
    return settle({
      outcome: 'failed',
      stage: 'env',
      error: engineError({
        code: 'engine-deps',
        message: `引擎或 Python 版本与锁定不一致（${(doc.diffs ?? []).map((d) => `${d.field}: ${d.locked} → ${d.current}`).join('；') || 'fingerprint 变化'}）：${doc.advice ?? ''}`,
        stage: 'env',
      }),
      engineLock: { status: lockStatus, diffs: doc.diffs ?? [] },
    })
  }
  if (lockStatus === 'unhealthy') {
    // doctor 绝不绕过 pip check：依赖不闭合就是不可信环境。这里不重试、不装包、
    // 不「先跑起来再说」——那是把环境问题伪装成模型问题。
    return settle({
      outcome: 'failed',
      stage: 'env',
      error: engineError({
        code: 'engine-deps',
        message: `依赖不闭合（pip check 未通过，不自动绕过）：${String(doc.current?.pipCheckOutput ?? '').slice(0, 800) || doc.advice || ''}`,
        stage: 'env',
      }),
      engineLock: { status: lockStatus, diffs: doc.diffs ?? [] },
    })
  }
  // 首次运行要落锁，但**不能在这里写**：写 `.codewiki/engine-lock.json` 会让
  // `.codewiki/` 目录在 `cw init` 之前就存在，而落地器把「.codewiki 存在却没有
  // _meta.yaml」判成人工破坏的半截库并拒绝自动初始化（apply-plan.js 的
  // wiki-missing 分支）——首次编译会因此在最后一步整批失败、还回滚掉所有文章。
  // 所以只记「待落锁」，真正写盘推迟到落地器跑完（见第 5 步之后）。
  let lockNote = null
  if (lockStatus === 'absent') lockNote = '首次运行，编译成功后将写入引擎锁'
  progress('env', 8, lockNote ?? '环境与锁定一致', {})
  const notes = []

  if (signal?.aborted) {
    return settle({ outcome: 'cancelled', blockers: [{ kind: 'cancelled', detail: '环境校验后取消' }], notes })
  }

  // ── 2) 模型桥：占位 key 每次随机、只在进程环境里传、不进日志 ──────────────
  const llm = deps.llm ?? null
  const provider = String(cfg.batchProvider ?? '')
  const model = String(cfg.batchModel ?? '')
  let bridge = null
  try {
    bridge = await bridgeImpl({
      llm,
      provider,
      model,
      reasoningEffort: cfg.batchReasoningEffort || undefined,
      timeoutMs: Math.min(timeoutMs, 10 * 60 * 1000),
      // 日志只记方法与状态码，绝不记请求头/body/占位 key
      onLog: (e) => onLog({ ...e, phase: 'bridge' }),
    })
  } catch (err) {
    return settle({
      outcome: 'failed',
      stage: 'cluster',
      error: engineError({
        code: 'engine-model',
        message: `模型通道无法建立：${err?.message ?? err}`,
        stage: 'cluster',
      }),
      notes,
    })
  }

  let result = null
  try {
    const action = scope === 'stale' || kind === 'stale' ? 'update' : 'generate'
    progress('graph', 12, `原生引擎启动（${action}）`)
    const engine = engineFor
      ? engineFor({ requestId: rid, bridge })
      : cfg.engine
    result = await runEngineImpl({
      requestId: rid,
      action,
      payload: { repoPath: root, docsDir: docsDir ?? null },
      engine,
      cwd: root,
      signal,
      timeoutMs,
      onProgress: (p) => {
        // 引擎进度直接透出（契约阶段名），上层只做映射与记录，不改语义。
        try { onProgress(p) } catch { /* ignore */ }
      },
      onLog: (e) => onLog({ ...e, phase: 'engine' }),
    })
  } catch (err) {
    return settle({
      outcome: 'failed',
      stage: 'articles',
      error: engineError({ code: 'engine-crashed', message: String(err?.message ?? err), stage: 'articles' }),
      notes,
    })
  } finally {
    // 桥必须在引擎退出后关闭：先关桥会让还在读流的引擎拿到 502。
    try { await bridge?.close?.() } catch { /* 关闭失败不影响裁决 */ }
  }

  const engineOutcome = result?.outcome ?? 'failed'
  const engineEvidence = {
    version: result?.engine?.version ?? '',
    commit: result?.engine?.commit ?? '',
    python: result?.engine?.python ?? '',
    deps: {
      ok: result?.engine?.deps?.ok === true,
      summary: String(result?.engine?.deps?.summary ?? '').slice(0, 500),
    },
  }
  if (engineOutcome === 'cancelled') {
    return settle({
      outcome: 'cancelled',
      stage: result?.stage ?? null,
      blockers: [{ kind: 'cancelled', detail: '已终止引擎进程树' }],
      writtenCount: result?.writtenCount ?? 0,
      engine: engineEvidence,
      notes,
    })
  }
  if (engineOutcome === 'failed') {
    return settle({
      outcome: 'failed',
      stage: result?.stage ?? null,
      error: result?.error ?? engineError({ code: 'engine-unknown', message: '引擎失败但没有错误信息' }),
      writtenCount: result?.writtenCount ?? 0,
      engine: engineEvidence,
      notes,
    })
  }

  const outDocsDir = result?.artifacts?.docsDir || docsDir || null
  if (!outDocsDir) {
    return settle({
      outcome: 'failed',
      stage: 'validate',
      error: engineError({ code: 'engine-output', message: '引擎没有给出产物目录', stage: 'validate' }),
      engine: engineEvidence,
      notes,
    })
  }
  progress('validate', 92, '质量门校验产物')

  // ── 3) 质量门：引擎 done 不能替代这里 ────────────────────────────────────
  let report
  try {
    report = gateImpl({ docsDir: outDocsDir, repoRoot: root, requireCommittedInput })
  } catch (err) {
    return settle({
      outcome: 'failed',
      stage: 'validate',
      error: engineError({ code: 'engine-output', message: `质量门异常：${err?.message ?? err}`, stage: 'validate' }),
      engine: engineEvidence,
      notes,
    })
  }

  if (signal?.aborted) {
    return settle({
      outcome: 'cancelled',
      stage: 'validate',
      blockers: [{ kind: 'cancelled', detail: '质量门后取消（未落盘）' }],
      engine: engineEvidence,
      gate: { outcome: report?.outcome ?? null, writable: report?.writable === true },
      notes,
    })
  }

  // ── 4) 落地器：写盘 → index → 基线 → 提交，失败自行回滚 ────────────────
  progress('index', 95, '写入 wiki、建索引、推进基线、自动提交')
  let applyRes = null
  try {
    applyRes = await applyImpl({
      repoRoot: root,
      report,
      docsDir: outDocsDir,
      // 基线只由「裁决是否完整」决定，不接受调用方硬开：partial 一律不推进。
      advanceBaseline: null,
      deps: deps.applyDeps ?? {},
    })
  } catch (err) {
    return settle({
      outcome: 'failed',
      stage: 'index',
      error: engineError({ code: 'engine-output', message: `落地器异常：${err?.message ?? err}`, stage: 'index' }),
      engine: engineEvidence,
      gate: { outcome: report?.outcome ?? null, writable: report?.writable === true },
      notes,
    })
  }

  // ── 5) 严格合成终态：最弱的一环说了算 ───────────────────────────────────
  // 取消是终态：apply 期间被 abort 时，cw 子进程被杀会让 index/基线失败回滚，
  // 那是一次「因取消而失败」，如实报 cancelled 而不是把用户的取消写成编译失败。
  if (signal?.aborted) {
    return settle({
      outcome: 'cancelled',
      stage: 'index',
      blockers: [{ kind: 'cancelled', detail: '落盘期间取消（已回滚未完成部分）' }],
      engine: engineEvidence,
      gate: { outcome: report?.outcome ?? null, writable: report?.writable === true },
      apply: { outcome: applyRes?.outcome ?? null, applied: applyRes?.applied === true, rolledBack: applyRes?.rolledBack === true },
      notes,
    })
  }
  const gateOutcome = report?.outcome ?? 'failed'
  const applyOutcome = applyRes?.outcome ?? 'failed'
  let finalOutcome = weakest(weakest(engineOutcome, gateOutcome), applyOutcome)
  const blockers = [
    ...(result?.blockers ?? []),
    // gate 的阻塞原因必须一律进终态：不论真实实现还是注入实现，都用同一个公开转换器
    // 翻成契约 kind。曾写成「只有注入的 gate 才带 blockers」，等于真实 gate 拦下的
    // 死链/空正文在终态里消失——那正是「引擎 done 就 done」的老缺陷换个位置复发。
    ...toContractBlockers(report),
    ...applyBlockersOf(applyRes),
  ]
  // done 不许带 blockers：若三者都说 done 却还有 blockers，说明某处判定自相矛盾
  let finalBlockers = blockers
  if (finalOutcome === 'done' && blockers.length) {
    // 宁可降级也不掩盖：有阻塞原因就不许报完整成功
    finalOutcome = 'partial'
  }
  if (finalOutcome === 'partial' && !finalBlockers.length) {
    finalBlockers = [{ kind: 'quality-gate', detail: `终态为 partial（引擎 ${engineOutcome}／质量门 ${gateOutcome}／落地 ${applyOutcome}）` }]
  }

  const written = Array.isArray(applyRes?.written) ? applyRes.written.length : 0
  if (applyRes?.applied) progress(applyRes?.baseline?.advanced ? 'commit' : 'baseline', 99, '收尾')

  // 待落锁在这里真正写盘：此刻 `.codewiki/` 要么本来就初始化过、要么刚被落地器的
  // `cw init` 建出了 `_meta.yaml`。仍要再核一次 `_meta.yaml`——落地器可能早退（not-writable
  // / 写盘失败回滚），那时候往空目录里塞 engine-lock.json 会让下一轮判成半截库。
  if (lockNote) {
    const metaFile = path.join(root, '.codewiki', '_meta.yaml')
    if (fs.existsSync(metaFile)) {
      try {
        const rel = await writeLockImpl({ repoRoot: root, current: doc.current })
        notes.push(`首次运行，已写入引擎锁 ${rel}`)
      } catch (err) {
        notes.push(`引擎锁写入失败（不阻断本次编译）：${err?.message ?? err}`)
      }
    } else {
      notes.push('引擎锁未写入：wiki 尚未初始化（本次未落地），下次成功编译时再落锁')
    }
  }

  return settle({
    outcome: finalOutcome,
    stage: applyRes?.baseline?.advanced ? 'commit' : 'index',
    blockers: finalBlockers,
    writtenCount: written || (result?.writtenCount ?? 0),
    failedCount: result?.failedCount ?? 0,
    error: finalOutcome === 'failed'
      ? (applyRes?.blockers?.[0]
        ? engineError({ code: 'engine-output', message: String(applyRes.blockers[0].detail ?? ''), stage: 'index' })
        : engineError({ code: 'engine-unknown', message: '编译未成立', stage: 'index' }))
      : null,
    engine: engineEvidence,
    usage: result?.usage ?? undefined,
    artifacts: {
      docsDir: outDocsDir,
      rawTreeDir: String(result?.artifacts?.rawTreeDir ?? ''),
      updateRecord: String(result?.artifacts?.updateRecord ?? ''),
    },
    gate: {
      outcome: gateOutcome,
      writable: report?.writable === true,
      canAdvanceBaseline: report?.canAdvanceBaseline === true,
      counts: report?.counts ?? null,
      // 逐篇明细必须带出去：面板的「已写/失败」要么来自质量门的真实产物清单，
      // 要么只能靠引擎自报计数去猜（那会把「门拦下的页」显示成成功）。
      articles: Array.isArray(report?.articles)
        ? report.articles.map((a) => ({
          wikiPath: a.wikiPath ?? null,
          source: a.source ?? null,
          type: a.type ?? null,
          action: a.action ?? null,
          defects: Number(a.defects ?? 0) || 0,
          degradations: Number(a.degradations ?? 0) || 0,
        }))
        : [],
    },
    apply: {
      outcome: applyOutcome,
      applied: applyRes?.applied === true,
      rolledBack: applyRes?.rolledBack === true,
      written,
      index: applyRes?.index ?? null,
      baseline: applyRes?.baseline ?? null,
      commit: applyRes?.commit ?? null,
    },
    engineLock: { status: lockStatus, diffs: doc?.diffs ?? [] },
    notes,
  })
}

export default {
  DEFAULT_ENGINE_ENTRY,
  DEFAULT_ENGINE_TIMEOUT_MS,
  runNativeJob,
}
