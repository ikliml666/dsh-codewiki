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
//
// ## 阶段 5：统一增量
//
// 上面那条直线多了一步「增量决议」，它排在 env 之后、引擎之前，因为「这一轮到底
// 是全量还是增量」必须由**证据**决定，而不是由调用方的 kind 字面量决定：
//
//   env → 增量决议(change-set + 受管状态) → 水合 docs → 引擎(full|update) → gate → apply
//
// 决议要回答三个问题，每个都用可查的事实而不是猜测：
//   1. 变化是什么？   四路（committed/staged/unstaged/untracked）+ 上轮未消费的携带；
//   2. 能不能增量？   受管状态是否齐全（图/模块树/metadata/文章）、版本是否兼容、
//                     基线是否可达。任一不成立 → 显式 full，并记 incremental-fallback；
//   3. 消费成立吗？   只有「引擎真的做了组件级增量（update_record.outcome=incremental）
//                     且 gate/apply 全部 done」才推进基线。引擎自己退全量（full_fallback）、
//                     检测器失败（detector_failure）、或产物被 gate 判 partial，一律
//                     不推进基线 —— 下一轮 change-set 仍从旧基线算起，变化不会丢。
//
// 未提交改动的账由 native-state.js 的 `unconsumed` 携带：它们被引擎真实读到
// （引擎读的是工作区文件，不是 git 对象），但 cw 基线只能推进到 HEAD，所以它们
// 在 `git diff base..HEAD` 里出现之前一直留在变化集里，不会被「基线前移」洗掉。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { engineResult, engineError, engineProgress } from './contract.js'
import { runEngine as realRunEngine } from './client.js'
import { doctor as realDoctor, probeEnvironment, writeLock } from './manifest.js'
import { gateNativeOutput as realGate, toContractBlockers, readCommittedBaseline } from './quality-gate.js'
import { applyNativeOutput as realApply } from './apply-plan.js'
import { startLlmBridge as realBridge } from './llm-bridge.js'
import { collectChangeSet as realCollectChangeSet } from '../change-set.js'
import * as nativeState from './native-state.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ENGINE_ENTRY = path.join(here, 'python', 'entry.py')

// 增量参数默认值（传给 FSoft `_update_options()`）。
//
// rung 是 FSoft 增量的**算法档位**：3 = 组件级方法（图 diff 决定哪些模块要重写），
// 0 = 旧的按文件失效。这里必须显式给 3 而不是留空：
//   · 留空时 FSoft 自己也会默认 3，但「默认」是引擎内部的实现细节，哪天上游改默认值，
//     我们的增量语义就跟着变了而没人知道；
//   · 显式给出后，引擎足迹（测试里 fake engine 的 logCall）能断言「调用方确实要求了
//     组件级增量」，而不是「碰巧默认成了增量」。
export const DEFAULT_UPDATE_OPTIONS = Object.freeze({ rung: '3' })

// 一次原生编译的默认超时：FSoft 全量在真实仓库上按 10 分钟量级设计（阶段 1C 实测
// 小 fixture 约 1 分钟，真实仓库更久）。超时由引擎侧进程树终止兜底，不靠上层 tick。
export const DEFAULT_ENGINE_TIMEOUT_MS = 45 * 60 * 1000

// 终态强弱：合成终态只能取「最弱」的那一个，绝不允许被后续步骤提升。
const RANK = { cancelled: 0, failed: 1, partial: 2, done: 3 }
const weakest = (a, b) => (RANK[a] <= RANK[b] ? a : b)

function noop() {}

// 增量决议的可能结论。写进结果里，让上层与测试都能看到「为什么走了这条路」。
//   full   —— 显式全量（调用方要全量，或增量不可用）
//   update —— 组件级增量（引擎会读上一轮的图/树/文章做图 diff）
//
// 注意「变化集为空」**不是**跳过引擎的理由：FSoft 的「有没有变」是**图 diff**说的，
// 不是 git 路径集合说的（重命名/跨文件重构能让路径集非空而图不变，反过来也会）。
// 我们只用 change-set 决定「增量可不可信」，把「变没变」留给引擎自己的 update_record。
const RESOLUTION = Object.freeze({ FULL: 'full', UPDATE: 'update' })

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
  // `inc` 由下面的增量决议段赋值；settle 在**调用时**读它，所以早退分支也能带上。
  let inc = null
  const settle = (patch) => {
    const outcome = patch.outcome
    const base = {
      outcome,
      stage: patch.stage ?? null,
      blockers: patch.blockers ?? [],
      error: patch.error ?? null,
      writtenCount: patch.writtenCount ?? 0,
      failedCount: patch.failedCount ?? 0,
      // 增量结局必须随终态出去：调用方（JobService/面板）靠它区分
      // 「组件级增量真的成立」与「引擎自己退了全量」。缺了它，full_fallback
      // 会在上层被当成普通 done —— 那正是「基线悄悄前移、变化悄悄丢」的入口。
      updateOutcome: patch.updateOutcome ?? (inc ? inc.updateOutcome : null),
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
      // 增量现场证据（决议/变化集/水合/受管状态）。所有分支都带，失败时也能看出
      // 「这一轮本来打算增量、卡在哪一步」。
      incremental: patch.incremental ?? inc,
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

  // ── 1.5) 增量决议：全量还是组件级增量，由证据决定 ────────────────────────
  //
  // 这里排三个事实：变化是什么（四路 + 上轮未消费）、能不能增量（受管状态/版本/基线）、
  // 上一轮留下的账要不要继续携带。三者都失败可查，绝不猜。
  const changeSetImpl = deps.collectChangeSet ?? realCollectChangeSet
  const stateDir = deps.stateDir ?? nativeState.NATIVE_STATE_DIR
  const explicitFull = scope === 'full' || kind === 'full'
  const wantsIncremental = !explicitFull && (scope === 'stale' || scope === 'auto' || kind === 'stale' || kind === 'auto')

  const baseline = readCommittedBaseline({ repoRoot: root })
  const baseCommit = String(baseline?.ok ? baseline.commit : '') || ''

  let changeSet = null
  try {
    changeSet = changeSetImpl(root, baseCommit)
  } catch (err) {
    changeSet = { ok: false, state: 'git-error', reason: String(err?.message ?? err), fallback: 'full', sourceChanges: [], committed: [], staged: [], unstaged: [], untracked: [], deleted: [], renamed: [] }
  }

  const prevState = nativeState.readState(stateDir, root)
  const prevUnconsumed = Array.isArray(prevState?.state?.unconsumed) ? prevState.state.unconsumed : []
  const merged = nativeState.mergeUnconsumed({ changeSet, prevUnconsumed })

  // 决议结果（写进结果与 state.json，都是可查证据）
  let resolution = RESOLUTION.FULL
  let fallbackReason = ''
  if (wantsIncremental) {
    if (!changeSet?.ok) {
      fallbackReason = `变化集不可信（${changeSet?.state ?? 'unknown'}）：${String(changeSet?.reason ?? '').slice(0, 300)}`
    } else if (!baseCommit) {
      fallbackReason = String(baseline?.reason || '没有已提交的编译基线（_meta.yaml 不在 HEAD 里），无法确定增量起点')
    } else if (!docsDir) {
      // 增量必须水合进**独立**的 docs 目录：把上一轮状态水合进仓库里的 .codewiki/ 会
      // 污染用户库（引擎会就地改写文章），且 apply 的 pre-image 会覆盖掉自己的输入。
      fallbackReason = '调用方没有给独立的 docsDir，无法水合上一轮状态（增量需要隔离的产物目录）'
    } else {
      const elig = nativeState.isUpdateEligible({
        stateDir,
        repoRoot: root,
        baseCommit,
        engineVersion: String(doc?.current?.version ?? ''),
        headCommit: changeSet.headCommit,
      })
      if (elig.eligible) {
        resolution = RESOLUTION.UPDATE
        if (elig.reason) notes.push(elig.reason)
      } else {
        fallbackReason = elig.reason
      }
    }
  } else if (!explicitFull) {
    fallbackReason = `scope=${scope} 不是增量语义（auto/stale 才走增量）`
  }

  let hydrated = { hydrated: [], skipped: [] }
  if (resolution === RESOLUTION.UPDATE) {
    try {
      hydrated = nativeState.hydrateDocsDir({ stateDir, repoRoot: root, docsDir })
      if (!hydrated.hydrated.length) {
        // 状态目录存在但一个文件都没复制过去：等同于缺图，退全量而不是让引擎拿空目录跑。
        resolution = RESOLUTION.FULL
        fallbackReason = '受管状态目录为空（水合不到任何文件），改走全量'
      } else if (hydrated.skipped.length) {
        notes.push(`水合跳过 ${hydrated.skipped.length} 项：${hydrated.skipped.slice(0, 5).join('；')}`)
      }
    } catch (err) {
      resolution = RESOLUTION.FULL
      fallbackReason = `水合上一轮状态失败：${String(err?.message ?? err).slice(0, 300)}`
    }
  }

  if (fallbackReason) notes.push(`增量不可用，改走全量：${fallbackReason}`)
  if (resolution === RESOLUTION.UPDATE) {
    progress('graph', 10, `增量决议：组件级更新（基线 ${baseCommit.slice(0, 7)}，变化 ${merged.effectiveChanges.length} 项）`)
  } else {
    progress('graph', 10, '增量决议：全量编译')
  }
  // 决议现场：无论后面走哪条分支，这一段事实都随结果出去（面板/测试/排障共用）。
  inc = {
    resolution,
    requestedScope: scope,
    explicitFull,
    baseCommit,
    headCommit: String(changeSet?.headCommit ?? ''),
    changeSetState: String(changeSet?.state ?? 'unknown'),
    changeSetOk: changeSet?.ok === true,
    changes: merged.effectiveChanges.slice(0, 500),
    changeCount: merged.effectiveChanges.length,
    unconsumed: merged.unconsumed.slice(0, 500),
    consumedNow: merged.consumedNow.slice(0, 500),
    carried: merged.carried,
    hydrated: hydrated.hydrated.slice(0, 500),
    stateMissing: [],
    fallbackReason,
    updateOutcome: null,
    stateDir,
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
    // 增量时用 `update`：它读 docsDir 里水合进来的旧图/旧树做图 diff。
    // 全量时用 `generate`：它从零建图。**两者不能互换** —— 增量动作在空 docsDir 上
    // 会走 missing_page 全量重建（比 generate 还慢），而全量动作在带旧状态的 docsDir
    // 上会覆盖旧图却仍按全量记账，让下一轮的「可比性」变成假象。
    const action = resolution === RESOLUTION.UPDATE ? 'update' : 'generate'
    progress('graph', 12, `原生引擎启动（${action}）`)
    const engine = engineFor
      ? engineFor({ requestId: rid, bridge })
      : cfg.engine
    result = await runEngineImpl({
      requestId: rid,
      action,
      payload: {
        repoPath: root,
        docsDir: docsDir ?? null,
        // 引擎侧的增量参数（rung 等）。默认给组件级（rung 3）而不是留空：
        // 留空靠引擎内部默认值，上游改默认就等于我们的增量语义静默漂移。
        ...(resolution === RESOLUTION.UPDATE
          ? { updateOptions: { ...DEFAULT_UPDATE_OPTIONS, ...(deps.updateOptions ?? {}) } }
          : {}),
        // 本轮记账：commit_id 会落进 metadata.json 的 generation_info.commit_id，
        // 也就是**下一轮** updater 眼里的 old_commit。用当前 HEAD —— 引擎实际读到的
        // 是工作区文件，HEAD 是「这一轮消费到哪个提交」的下界（未提交部分由
        // state.json 的 unconsumed 携带，不会被这次记账洗掉）。
        ...(changeSet?.headCommit ? { commitId: changeSet.headCommit } : {}),
      },
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
  if (inc) inc.updateOutcome = result?.updateOutcome ?? null
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

  // ── 3.5) 采集跨轮受管状态：与文章同批写、同批回滚、同批提交 ──────────────
  //
  // 采集点是「gate 之后、apply 之前」：此时引擎已写完 docsDir，而 apply 还没动
  // 仓库。放进 apply 的 extraFiles 意味着这些文件与文章共享同一份 pre-image ——
  // index/基线失败时它们随文章一起回滚，提交时随文章一起进同一个 commit。
  // 这正是需求里「图/模块树/metadata/update_record 与文章同事务」的结构保证。
  let stateFiles = []
  let statePayload = null
  let stateCapture = { captured: [], missing: [] }
  // 「无变化轮」不重写受管状态：引擎在 no_change 时仍会把 metadata/graph/update_record
  // 里的 commit_id 刷成本轮 HEAD，若照采就是**每次无变化都产生一次纯记账提交**，
  // 而「无变化路径不错误重写/提交」是本阶段的硬要求。
  // 判据取「引擎报 no_change + 变化集空 + 没有跨轮未消费路径」三者同时成立：只要还有
  // 一项未消化的账（哪怕是未提交的源码改动），本轮就必须照常采集——那份状态是下一轮
  // 唯一能把它算进变化集的凭据，跳过等于丢变化。
  const idleRound = resolution === RESOLUTION.UPDATE
    && result?.updateOutcome === 'no_change'
    && merged.effectiveChanges.length === 0
    && merged.unconsumed.length === 0
  try {
    if (idleRound) {
      notes.push('无变化轮：沿用上一轮受管状态（不重写图/树/metadata/update_record/state.json）')
    } else {
      const cap = nativeState.captureDocsDir({ docsDir: outDocsDir, stateDir })
      stateCapture = cap
      // 引擎自报的产物清单（entry.py 的 artifacts.stateFiles）与实际采集结果交叉核对：
      // 引擎说产出了图、我们却没采集到，说明文件名/布局与我们的判据不一致 —— 记下来
      // 让它可见，而不是悄悄当成「已持久化」。
      const reported = Array.isArray(result?.artifacts?.stateFiles) ? result.artifacts.stateFiles : []
      const capturedSet = new Set(cap.captured)
      const disagree = reported.filter((r) => !capturedSet.has(String(r)))
      if (disagree.length) {
        notes.push(`引擎自报状态文件有 ${disagree.length} 项未纳入受管状态：${disagree.slice(0, 5).join('、')}`)
      }
      statePayload = nativeState.buildStatePayload({
        repoRoot: root,
        consumedRange: baseCommit && changeSet?.headCommit
          ? { baseCommit, headCommit: changeSet.headCommit }
          : null,
        pendingChanges: changeSet?.ok
          ? {
            state: changeSet.state,
            baseCommit: changeSet.baseCommit,
            headCommit: changeSet.headCommit,
            committed: changeSet.committed,
            staged: changeSet.staged,
            unstaged: changeSet.unstaged,
            untracked: changeSet.untracked,
            deleted: changeSet.deleted,
            renamed: changeSet.renamed,
            reason: '',
          }
          : null,
        unconsumed: merged.unconsumed,
        previous: prevState?.state ?? null,
        engineVersion: String(doc?.current?.version ?? ''),
        scope,
        effectiveScope: resolution === RESOLUTION.UPDATE ? 'stale' : 'full',
        updateOutcome: result?.updateOutcome ?? null,
        fallbackReason,
        notes,
      })
      const item = nativeState.stateFileItem(statePayload, stateDir)
      // 「实质内容没变就不重写」：state.json 里的 updatedAt 每轮都变，照写会让
      // 无变化的一轮也产生一次真实提交。指纹相同就沿用旧文本（不动 updatedAt）。
      const prevText = nativeState.readStateText(stateDir, root)
      const same = prevText !== null && nativeState.stateFingerprint(prevText) === nativeState.stateFingerprint(item.content)
      stateFiles = [...cap.files, same ? { rel: item.rel, content: prevText } : item]
      if (stateCapture.missing.length) {
        notes.push(`受管状态有 ${stateCapture.missing.length} 项缺失：${stateCapture.missing.slice(0, 5).join('；')}`)
      }
    }
  } catch (err) {
    // 状态采集失败不能悄悄退化成「不持久化」：那会让下一轮白退全量而无人知道。
    notes.push(`受管状态采集失败（本轮仍按裁决落地）：${String(err?.message ?? err).slice(0, 300)}`)
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
      // 完整无变化轮连基线/提交也不能碰：否则每次状态查询都会制造 wiki 提交。
      noChanges: idleRound,
      // 受管状态：与文章同批写、同批回滚、同批提交。
      extraFiles: stateFiles,
      // 上一轮有、本轮没产出的状态文件要删掉（否则水合时会把过期图/旧页当成有效输入）。
      // 只在真的走增量时裁：全量的 docs 是干净重建，本来就不会留旧文件。
      // 无变化轮**绝不能裁**：那轮不写状态，裁剪会按「写集里没有它们」把上一轮的
      // 图/树/文章副本整批删掉，等于用一次空写把增量输入清空。
      pruneRoots: idleRound ? [] : [path.posix.join(stateDir, 'docs')],
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
  const updateOutcome = result?.updateOutcome ?? null
  let finalOutcome = weakest(weakest(engineOutcome, gateOutcome), applyOutcome)
  const blockers = [
    ...(result?.blockers ?? []),
    // gate 的阻塞原因必须一律进终态：不论真实实现还是注入实现，都用同一个公开转换器
    // 翻成契约 kind。曾写成「只有注入的 gate 才带 blockers」，等于真实 gate 拦下的
    // 死链/空正文在终态里消失——那正是「引擎 done 就 done」的老缺陷换个位置复发。
    ...toContractBlockers(report),
    ...applyBlockersOf(applyRes),
  ]
  // 增量降级的可见性：想要增量却没走成（缺图/缺树/版本不符/基线不可达/引擎自己回退），
  // 必须在终态里说出来。**只在产物已经不完整时**加这条 blocker —— 产物完整（gate/apply
  // 都 done）时它只进 notes：那种情况下全量重建确实覆盖了当前全部源码，变化是消化掉的，
  // 强行降 partial 会让「每次都 full_fallback」的仓库永远绿不了，而基线也跟着永远不推进，
  // 那才是真正的重复消费。
  const degradedToFull = wantsIncremental && resolution === RESOLUTION.FULL && Boolean(fallbackReason)
  const engineRolledBack = resolution === RESOLUTION.UPDATE && updateOutcome && updateOutcome !== 'incremental' && updateOutcome !== 'no_change'
  if ((degradedToFull || engineRolledBack) && finalOutcome !== 'done') {
    blockers.push({
      kind: 'incremental-fallback',
      detail: engineRolledBack
        ? `引擎自报增量回退（updateOutcome=${updateOutcome}），本轮按全量产物裁决`
        : `增量不可用，本轮显式全量：${fallbackReason.slice(0, 500)}`,
    })
  }
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
  if (inc) {
    inc.stateMissing = stateCapture?.missing ?? []
    inc.stateCaptured = (stateCapture?.captured ?? []).slice(0, 500)
    inc.statePersisted = stateFiles.length
  }

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
