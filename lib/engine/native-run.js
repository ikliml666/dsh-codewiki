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
//   4. failed/cancelled/partial 一律不推进基线：未完整消化的变化必须留到下一轮。
//      已写出的合格文章可以保留，但不能据此把整批变化记为已消费。
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
import {
  doctor as realDoctor, probeEnvironment, buildLockBody, ENGINE_LOCK_REL,
} from './manifest.js'
import { gateNativeOutput as realGate, toContractBlockers, readCommittedBaseline } from './quality-gate.js'
import { applyNativeOutput as realApply, findOrphanPages as realFindOrphanPages, findStaleModulePages as realFindStaleModulePages } from './apply-plan.js'
import { startLlmBridge as realBridge } from './llm-bridge.js'
import { collectChangeSet as realCollectChangeSet } from '../change-set.js'
import { createWorkspaceSnapshot as realSnapshot } from './workspace-snapshot.js'
import * as nativeState from './native-state.js'
import { findMissingModuleDocs, staleDocPages } from './mapping.js'
import { overviewStaleLinks } from './output.js'
import { deadLinkSources, proofreadPages as realProofreadPages } from './proofread.js'

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

// 一次原生编译的默认超时。超时由引擎侧进程树终止兜底，不靠上层 tick。
//
// 45 分钟是阶段 1C 按小 fixture（约 1 分钟）估的，真机上根本不成立：
// `job-mvt1mrvu-6` 是本仓库唯一一次真正跑完的编译，分阶段耗时
// articles 66.0min + crosscut 10.0min + review 68.9min + queued 29.2min
// ≈ **174 分钟**。按 45 分钟给预算，任何中等规模仓库都会在「阶段 3
// Documentation Generation」刚开头（percent 54）被砍掉，连一篇都写不出来
// ——那不是编译失败，是预算低于物理耗时，重试多少次都一样。
//
// 因此默认给 3 小时（180 分钟），留出比实测 174 分钟更宽的余量。这仍是**上限**
// 而非预期耗时：真跑得快就早结束；超时后靠 client.js 的 partial 抢救路径把
// 已写出的文章救回来（见 writtenCount > 0 分支），不会白跑。
export const DEFAULT_ENGINE_TIMEOUT_MS = 180 * 60 * 1000

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
 * @param {string} [o.docsDir]           引擎产物目录（缺省放到临时目录）
 * @param {string} [o.language]          文章书写语言（缺省不指定，引擎按英文）
 * @param {string} [o.rawTreeRoot]       原始树留档根（仓库外；缺省不留档）
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
  language = '',
  // 同层模块并行度（0.16.14）：1 = 上游原始的严格串行。
  // 由调用方按插件设置 maxConcurrency 下发；父模块仍等子模块完成后才跑。
  moduleConcurrency = 1,
  // 单模块写作的 LLM 请求上限：由插件设置下发（默认 300），不传时引擎退回自身默认 100。
  requestLimit = 0,
  resume = false,
  rawTreeRoot = null,
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
      // 保留/删除/未映射三计数：契约（docs/fsoft-native-engine.md:44）要求它们随
      // 终态出去。缺了这三项，engineResult 会按 0 归一，上层与面板就无法区分
      // 「本轮一页没动」与「本轮评估了 30 页但都判 no-op」。
      //
      // 只认调用方显式给的值：settle 定义在 `let result` 声明之前，早退分支
      // （取消、环境校验失败等）调用它时 result 还在 TDZ 里，读它必抛
      // ReferenceError。最终成功路径的 settle 会显式传这三项。
      keptCount: patch.keptCount ?? 0,
      removedCount: patch.removedCount ?? 0,
      unmappedCount: patch.unmappedCount ?? 0,
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
      // 三个事实分开记，不互相冒充：
      //   baselineEligible 质量门许可（「这一轮的变化都消化完了，可以推进」）；
      //   baselineAdvanced 落地器事实（cw meta update 真的成功）；
      //   deliveryComplete 由外层按 stage+blockers 判（本模块不产出）。
      // 曾经这里写成「outcome==='partial' 且 rawTreeFiles>0 就当可推进」——那是拿
      // 产物数量猜基线许可，与门和落地器的判断各说各话。
      baselineEligible: patch.baselineEligible === true,
      baselineAdvanced: patch.baselineAdvanced === true,
      // 兼容字段：老调用方（JobService 的 judged）只认这个名字，语义取落地事实。
      canAdvanceBaseline: patch.baselineAdvanced === true,
      artifacts: patch.artifacts ?? { docsDir: '', rawTreeDir: '', updateRecord: '', rawTree: '', rawTreeFiles: 0 },
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
  // 进度帧不吞异常：engineProgress 会校验 stage 必须属于 ENGINE_STAGES，
  // 传了契约外的阶段名是编程错误，必须当场响。
  // 这里曾用 try/catch 包住，于是 0.17.32 把校对帧写成 'proofread'（当时不在契约里）
  // 之后，那一帧被静默丢弃、面板「校对」格永不点亮，而全套测试依然全绿——
  // 因为没有任何一条用例给 runNativeJob 传 onProgress。
  const progress = (stage, percent, message, extra = {}) => {
    onProgress(engineProgress({ stage, percent, message, ...extra }))
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
    // upstreamCommit 由 config 覆盖（缺省回落到 manifest 的显式常量）：上游锁是
    // **声明**而不是探测结果，所以只允许从这里换，不允许从引擎自报里"学到"。
    doc = await doctorImpl({
      probe,
      repoRoot: root,
      engineRoot: cfg.engineRoot ?? null,
      ...(cfg.upstreamCommit ? { upstreamCommit: cfg.upstreamCommit } : {}),
    })
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
  // 所以这里只报状态，真正落盘在 3.6 段进写集、由落地器与产物同事务写入并提交。
  let lockNote = null
  if (lockStatus === 'absent') lockNote = '首次运行，引擎锁将在本轮落地时与产物一并写入'
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
  // 写进 state.json 的「缺页修复凭据」：undefined = 沿用上一轮，null = 清除。
  let pendingMissingRepair
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

  let hydrated = { hydrated: [], retained: [], skipped: [] }
  if (resolution === RESOLUTION.UPDATE) {
    try {
      hydrated = nativeState.hydrateDocsDir({ stateDir, repoRoot: root, docsDir, overwrite: !resume })
      if (!hydrated.hydrated.length && !(resume && fs.existsSync(path.join(docsDir, 'module_tree.json')))) {
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

    // 水合后检查模块树与页面完整性：如果模块树里有从未写过页面的模块，
    // 即使源码没有变化（no_change），也必须转全量修复——否则增量轮会永远
    // 跳过这些模块，质量门每轮都报缺页，形成永久 partial。
    if (resolution === RESOLUTION.UPDATE) {
      try {
        const treePath = path.join(docsDir, 'module_tree.json')
        if (fs.existsSync(treePath)) {
          const moduleTree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
          const pages = []
          const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              const rel = path.relative(docsDir, path.join(dir, ent.name)).replace(/\\/g, '/')
              if (ent.isDirectory()) walk(path.join(dir, ent.name))
              else if (ent.name.endsWith('.md')) pages.push(rel)
            }
          }
          walk(docsDir)
          // 陈页清退与缺页判定独立：模块重聚类或引擎把页写进过嵌套目录后，旧路径上的
          // 同名副本仍在 docsDir 里，即便模块树一页不缺，它们也会被判 unmapped-page
          // 文件名冲突，把一整轮拖成 partial。这里只动仓库外的临时产物目录；已提交的
          // wiki 页仍由落地器按写集与孤儿判定处理。
          const stale = staleDocPages({ pages, moduleTree })
          if (stale.length) {
            for (const rel of stale) {
              try { fs.rmSync(path.join(docsDir, ...rel.split('/')), { force: true }) } catch { /* 单页删不掉不影响修复 */ }
            }
            notes.push(`清理 ${stale.length} 个不属于当前模块树的旧页（${stale.slice(0, 3).join('、')}${stale.length > 3 ? ' 等' : ''}）`)
            // 清退后重新收集页面，缺页判定必须基于清退后的现场，否则刚删掉的副本
            // 会被算作「已有页面」而漏补。
            pages.length = 0
            walk(docsDir)
          }
          const missing = findMissingModuleDocs({ pages, moduleTree })
          // overview 陈链：上游 reusable_overview() 只判「空页 / 未完成的 preamble」，
          // 链接正确性不在判据里。聚类重构后模块改名，旧 overview 的链接指向已消失的页，
          // 引擎每轮都判它可复用而跳过重建（真机 dsh-git-worktree 6 条，Git 史证明那些
          // 页在上一版聚类里真实存在过）。处置与缺页一致：转全量，并把陈页删掉——
          // 留着它，全量与增量都会因为「可复用」而跳过重建。
          const overviewPath = path.join(docsDir, 'overview.md')
          const overviewText = fs.existsSync(overviewPath) ? fs.readFileSync(overviewPath, 'utf8') : ''
          const overviewStale = overviewText
            ? overviewStaleLinks({ overviewText, pages, moduleTree })
            : []
          if (missing.length > 0 || overviewStale.length > 0) {
            const prevRepair = prevState?.state?.missingRepair ?? null
            // 判据用「已提交的编译基线」而不是 HEAD：partial 轮仍可能产生一次 wiki
            // 提交，HEAD 每轮都变，拿它比对等于永远不收敛。基线只有 done 才推进，
            // 所以基线没变 + 缺口清单没变 = 同一棵树上的同一批缺口。
            const baseNow = String(baseCommit ?? '')
            const prevModules = Array.isArray(prevRepair?.modules) ? prevRepair.modules : null
            const prevLinks = Array.isArray(prevRepair?.overviewLinks) ? prevRepair.overviewLinks : []
            const sortedMissing = [...missing].sort()
            const sortedLinks = [...overviewStale].sort()
            const sameMissingAsBefore = Boolean(prevRepair)
              && baseNow !== ''
              && String(prevRepair.baseCommit ?? '') === baseNow
              && prevModules !== null
              && prevModules.length === sortedMissing.length
              && sortedMissing.every((m, i) => m === prevModules[i])
              && prevLinks.length === sortedLinks.length
              && sortedLinks.every((l, i) => l === prevLinks[i])
              // 真有源码变化时再给一次机会：新变化可能正是补齐缺口所需的内容。
              && merged.effectiveChanges.length === 0
            const names = `${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}`
            const linkNames = `${overviewStale.slice(0, 3).join('、')}${overviewStale.length > 3 ? ' 等' : ''}`
            if (sameMissingAsBefore) {
              // 收敛：同一棵树、同一批缺口，上一轮已经试过一次全量修复仍补不上。
              // 再跑一遍只会再浪费几十分钟并再次 partial。这里只跳过「重复的全量」，
              // 缺页与陈链一条都不会被豁免——质量门照旧判，终态照旧 partial。
              const what = missing.length > 0
                ? `产物缺页 ${missing.length} 个模块（${names}）${overviewStale.length ? `、overview 有 ${overviewStale.length} 条陈链（${linkNames}）` : ''}`
                : `overview 有 ${overviewStale.length} 条指向已消失页面的链接（${linkNames}）`
              notes.push(`${what} 与上一轮完全相同，上一轮已尝试全量修复仍补不上；本轮不再重复全量（仍如实计入终态，如需强制重试请用 scope=full）`)
              pendingMissingRepair = {
                baseCommit: baseNow,
                modules: sortedMissing,
                overviewLinks: sortedLinks,
                attempts: Number(prevRepair.attempts ?? 1) + 1,
                at: new Date().toISOString(),
              }
            } else {
              if (missing.length > 0) notes.push(`产物缺页 ${missing.length} 个模块（${names}），转全量修复（复用已有页面）`)
              if (overviewStale.length > 0) {
                notes.push(`overview 有 ${overviewStale.length} 条指向已消失页面的链接（${linkNames}），删除后转全量重建`)
                fs.rmSync(overviewPath, { force: true })
              }
              resolution = RESOLUTION.FULL
              pendingMissingRepair = {
                baseCommit: baseNow,
                modules: sortedMissing,
                overviewLinks: sortedLinks,
                attempts: 1,
                at: new Date().toISOString(),
              }
            }
          } else if (prevState?.state?.missingRepair) {
            // 缺口已补齐：清掉凭据，避免下次出现同样缺口时被误判成「已经试过」。
            pendingMissingRepair = null
          }
        }
      } catch (err) {
        // 模块树读不出来 ≠ 检查没做完：拿一棵解析不出来的树去判缺页，判定结果必然不可信，
        // 而这一轮的增量决议正是建立在它上面。同文件另一处（3.7 段孤儿页扫描）对同一个
        // module_tree.json 规定「ENOENT 才吞，JSON 损坏必须抛」，两处口径必须一致。
        if (err instanceof SyntaxError) {
          return settle({
            outcome: 'failed',
            stage: 'graph',
            error: engineError({
              code: 'engine-output',
              message: `module_tree.json 损坏（不是合法 JSON）：${String(err?.message ?? err).slice(0, 300)}`,
              stage: 'graph',
            }),
            notes,
          })
        }
        // 目录读不到、文件刚被别的进程挪走这类环境问题不阻塞增量——但**不能假装检查过**。
        // 「检查失败」与「没做检查」是两件事，后者必须让下游知道这一轮的增量决议少了
        // 一道证据，所以文案写「未执行」而不是「失败」，并带上原始 errno。
        const code = String(err?.code ?? 'unknown')
        notes.push(`产物完整性检查未执行（${code}）：本轮增量决议未经缺页/陈页校验，原因：${String(err?.message ?? err).slice(0, 100)}`)
      }
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
    retained: hydrated.retained.slice(0, 500),
    stateMissing: [],
    fallbackReason,
    updateOutcome: null,
    stateDir,
  }

  // ── 1.9) 工作区快照：把未提交改动合成一棵真实的树交给引擎 ─────────────────
  //
  // FSoft 只从 `<old_commit>..<new_commit>` 取 diff（规格 L82 的既有缺陷）。它读的
  // 是工作区文件——内容是对的，可记账只能写 HEAD，于是「文章反映了工作区、账却指向
  // HEAD」：下一轮拿 HEAD 当 old_commit 就把这些改动当成已消化，正好是「变化悄悄丢」
  // 的入口。这里在引擎启动前造一个含全部未提交改动的临时 commit（不写任何 ref），
  // 让本轮 commitId 指向它 —— 内容与账本这才对齐。
  //
  // 造不出快照不算失败：退回用 HEAD 记账（旧行为）并记 note。快照是**对齐精度**的
  // 改进，不是编译成立的前提；把「git 太旧/对象只读」升级成编译失败是本末倒置。
  let snapshot = null
  if (deps.snapshot !== false) {
    const dirty = ['staged', 'unstaged', 'untracked']
      .reduce((n, k) => n + (Array.isArray(changeSet?.[k]) ? changeSet[k].length : 0), 0)
    if (changeSet?.ok && dirty > 0) {
      try {
        snapshot = (deps.snapshot ?? realSnapshot)({ repoRoot: root, changeSet })
        if (snapshot?.ok) {
          notes.push(`工作区未提交改动已合成临时 commit ${String(snapshot.sha).slice(0, 12)}（${snapshot.files} 个文件，不挂 ref）：本轮记账指向它，下一轮增量据此对齐`)
        } else {
          notes.push(`工作区快照未成立，本轮退回用 HEAD 记账：${snapshot?.error ?? '未知原因'}`)
        }
      } catch (err) {
        snapshot = null
        notes.push(`工作区快照异常，本轮退回用 HEAD 记账：${String(err?.message ?? err).slice(0, 200)}`)
      }
    }
  }
  // 本轮「消费到哪个提交」：有快照用快照，否则用 HEAD。
  // 单独命名而不是原地改 baseCommit —— base 是**增量起点**（cw 基线），
  // 这里是**本轮产物对应的内容状态**，两者不能混成一个变量。
  const consumedCommit = String(snapshot?.ok ? snapshot.sha : (changeSet?.headCommit ?? ''))
  if (inc) {
    inc.workspaceSnapshot = snapshot?.ok
      ? { sha: snapshot.sha, parent: snapshot.parent, files: snapshot.files, skipped: Array.isArray(snapshot.skipped) ? snapshot.skipped.slice() : [] }
      : null
    inc.consumedCommit = consumedCommit
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
      // 会话记录钩子（面板「会话」视图）：原生通道的模型请求只经过这里，
      // 不接这个钩子面板就永远是空列表。回调契约与 batch 通道一致。
      onRequestStart: deps.onRequestStart ?? null,
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
  let bridgeStats = null
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
        // 文章书写语言必须一路带到引擎：上游只从 agent_instructions.language 读，
        // 不传就等于静默按英文写（插件设置 articleLanguage 形同虚设）。
        ...(String(language ?? '').trim() ? { language: String(language).trim() } : {}),
        // 同层模块并行度：引擎默认 1（串行），只有显式给 >1 才开并行。
        moduleConcurrency: Math.max(1, Number(moduleConcurrency) || 1),
        // 单模块写作请求上限：>0 才下发，让引擎自己在缺省时用它的默认值（0 不是合法预算）。
        ...(Number(requestLimit) > 0 ? { requestLimit: Math.round(Number(requestLimit)) } : {}),
        // 引擎侧的增量参数（rung 等）。默认给组件级（rung 3）而不是留空：
        // 留空靠引擎内部默认值，上游改默认就等于我们的增量语义静默漂移。
        ...(resolution === RESOLUTION.UPDATE
          ? { updateOptions: { ...DEFAULT_UPDATE_OPTIONS, ...(deps.updateOptions ?? {}), extra: { ...(deps.updateOptions?.extra ?? {}), moduleConcurrency: Math.max(1, Number(moduleConcurrency) || 1), resume, ...(resume ? { resumeBaselineDocsDir: nativeState.stateDocsDir(path.join(root, ...stateDir.split('/'))) } : {}) } } }
          : {}),
        // 本轮记账：commit_id 会落进 metadata.json 的 generation_info.commit_id，
        // 也就是**下一轮** updater 眼里的 old_commit。
        //
        // 有工作区快照时给它（内容与账本才对得上）；没有时给 HEAD —— 引擎实际读到的
        // 是工作区文件，HEAD 是「这一轮消费到哪个提交」的下界（未提交部分由
        // state.json 的 unconsumed 携带，不会被这次记账洗掉）。
        ...(consumedCommit ? { commitId: consumedCommit } : {}),
      },
      engine,
      cwd: root,
      signal,
      timeoutMs,
      onProgress: (p) => {
        // 引擎进度直接透出（契约阶段名），上层只做映射与记录，不改语义。
        // 不吞异常：这里抛出的都是「契约阶段名对不上」，属于必须当场看见的编程错误。
        onProgress(p)
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
    // 关桥前把统计取走：emptyResponses 是「上游 200 却什么也没产出」的次数，
    // 这类调用在引擎账本里会被记成「这一页无需改动」，是假 done 的来源之一。
    // stats()/close() 由 llm-bridge.js 的返回契约保证（{url,placeholderKey,port,close(),stats()}），
    // 走到这里 bridge 一定非 null。取不到统计或关不掉就大声失败——吞掉只会让「空产出」
    // 这类假 done 的成因永远不可见。
    bridgeStats = bridge.stats()
    await bridge.close()
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

  // ── 2.9) 原始树留档：事实来源必须在被消费之前留一份 ──────────────────────
  //
  // 之后每一步都在**同一棵 docs 树**上动手（采集受管状态会读它、落地器按映射改写
  // 它、裁剪会删它）。设计文档 L20 要求「保留 FSoft 输出原始树作为事实来源」，
  // 而引擎自报的 `artifacts.rawTreeDir` 只指向 `module_tree.json` 一个文件
  // （entry.py:_done_result），那不是「整棵原始树」——没有它就无法回答
  // 「这一轮的产物差异是引擎给的，还是我们在落地时加工出来的」。
  //
  // 留档目录由调用方给（index.js 放在仓库外的临时目录，按 jobId 分目录 + TTL 清理）：
  // 放进 `.codewiki/` 会被 cw index 收成第二份文章，放进仓库还会污染 git 状态。
  // 留档失败只记 note，绝不让一次编译失败——它是证据，不是产物。
  let rawArchive = null
  const archiveRoot = rawTreeRoot ?? deps.rawTreeRoot ?? null
  if (archiveRoot) {
    try {
      const dest = path.join(String(archiveRoot), String(rid).replace(/[^\w.-]/g, '_'))
      rawArchive = nativeState.archiveDocsTree({ docsDir: outDocsDir, destDir: dest })
      if (rawArchive.ok) {
        notes.push(`引擎原始树已留档：${rawArchive.dir}（${rawArchive.files} 个文件${rawArchive.error ? `，${rawArchive.error}` : ''}）`)
      } else {
        notes.push(`引擎原始树留档失败（不影响本轮终态）：${rawArchive.error}`)
      }
    } catch (err) {
      rawArchive = { ok: false, dir: '', files: 0, bytes: 0, error: String(err?.message ?? err) }
      notes.push(`引擎原始树留档异常（不影响本轮终态）：${String(err?.message ?? err).slice(0, 300)}`)
    }
  }

  // ── 2.6) 校对：先把「链到不存在页面」的正文改对，再判门 ─────────────────
  //
  // 模型写作时会编造页面名（真机：`client_review_console/status_readouts.md`、
  // 漏 `_ui` 后缀的 `settings_and_logs.md`），门如实判 dead-link，于是这些仓库
  // 每轮都停在 partial。这一层**修正文而不是放宽判据**：改完仍要重新判门，
  // 改不掉就照旧判 partial。
  //
  // 先跑一次门只为拿到「哪几篇有失效链接」——门是纯读 docsDir 的，跑两次没有副作用。
  const runGate = () => gateImpl({
    docsDir: outDocsDir,
    repoRoot: root,
    requireCommittedInput,
    // 只有真的造出了快照，产物指向快照才是「对得上代码」；否则不传，让
    // commit-mismatch 照旧按 HEAD 判（不能用一个不存在的对齐去掩盖不一致）。
    ...(snapshot?.ok ? { consumedInputCommit: snapshot.sha } : {}),
  })

  const chatForProofread = deps.chat
  let report
  try {
    report = runGate()
  } catch (err) {
    return settle({
      outcome: 'failed',
      stage: 'validate',
      error: engineError({ code: 'engine-output', message: `质量门异常：${err?.message ?? err}`, stage: 'validate' }),
      engine: engineEvidence,
      notes,
    })
  }
  if (!signal?.aborted) {
    // 校对只针对门报出的死链源页：门没报错就是「这轮产物没有问题」，不烧模型预算去
    // 逐页复查。校对是修死链的一步，不是每轮都要走一遍的例行检查。
    // 质量门只在 defects 里留 dead-link（problems 是 validateOutput 的中间产物，
    // gate 的返回值不含它）；两处形态一致，取到哪个都能用。
    const sources = deadLinkSources(report?.defects ?? report?.problems)
    if (sources.length) {
      progress('proofread', 88, `语义校对（${sources.length} 篇有失效跨页链接）`)
      const proofreadImpl = deps.proofreadPages ?? realProofreadPages
      let proof
      try {
        proof = await proofreadImpl({
          docsDir: outDocsDir,
          sources,
          chat: chatForProofread,
          maxPages: deps.proofreadMaxPages,
          signal,
        })
      } catch (err) {
        proof = null
        notes.push(`语义校对异常（不影响本轮终态，门会如实上报死链）：${String(err?.message ?? err).slice(0, 300)}`)
      }
      if (proof) {
        for (const n of proof.notes ?? []) notes.push(n)
        for (const f of proof.failed ?? []) notes.push(`语义校对未完成：${f.source}（${f.error}）`)
        if (proof.changed?.length) {
          notes.push(`语义校对改写了 ${proof.changed.length} 篇（${proof.changed.slice(0, 5).join('、')}${proof.changed.length > 5 ? ' 等' : ''}），改后重新判门`)
          try {
            report = runGate()
          } catch (err) {
            return settle({
              outcome: 'failed',
              stage: 'validate',
              error: engineError({ code: 'engine-output', message: `质量门异常（校对后）：${err?.message ?? err}`, stage: 'validate' }),
              engine: engineEvidence,
              notes,
            })
          }
        }
      }
    }
  }

  progress('validate', 92, '质量门校验产物')

  // 「这轮把工作区未提交改动也写进了文章」必须可见：基线推进过去是靠「工作区必须
  // 干净」把关的，现在改为认产物 commit 与合成快照一致——那就得让人看得见吞了什么。
  const consumedInput = report?.baseline?.consumedInput
  if (consumedInput?.paths?.length) {
    const p = consumedInput.paths
    notes.push(`本轮把 ${p.length} 个未提交源码改动一并写进产物（快照 ${String(consumedInput.commit).slice(0, 12)}）：${p.slice(0, 5).join('、')}${p.length > 5 ? ' 等' : ''}`)
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
  // 受管状态是否完整：下一轮的增量**只**靠这份状态（图/树/metadata/update_record）。
  // 它一旦不完整，本轮就没有资格替下一轮记账 —— 后面的 prune、基线推进、终态
  // 都以这个标志为准，而不是只写一条 notes 了事。
  let stateIncomplete = false
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
        missingRepair: pendingMissingRepair,
        notes,
      })
      const item = nativeState.stateFileItem(statePayload, stateDir)
      // 「实质内容没变就不重写」：state.json 里的 updatedAt 每轮都变，照写会让
      // 无变化的一轮也产生一次真实提交。指纹相同就沿用旧文本（不动 updatedAt）。
      const prevText = nativeState.readStateText(stateDir, root)
      const same = prevText !== null && nativeState.stateFingerprint(prevText) === nativeState.stateFingerprint(item.content)
      if (stateCapture.missing.length) {
        // 缺图/树/metadata 时不能裁掉上一轮仍完整的状态，也不能宣称完整交付。
        // 文章可以保留；下一轮会显式回退全量，而不是水合一棵被本轮清空的图。
        stateFiles = []
        notes.push('受管状态不完整：保留上一轮状态，不裁剪，不推进基线')
      } else {
        stateFiles = [...cap.files, same ? { rel: item.rel, content: prevText } : item]
      }
      if (stateCapture.missing.length) {
        // 缺 module_tree/metadata/依赖图 = 下一轮无法增量：这是 blocker 级的缺陷
        // （见下面 5) 的合成），notes 只是给人看的同一事实。
        stateIncomplete = true
        notes.push(`受管状态有 ${stateCapture.missing.length} 项缺失：${stateCapture.missing.slice(0, 5).join('；')}`)
      }
    }
  } catch (err) {
    // 状态采集失败不能悄悄退化成「不持久化」：那会让下一轮白退全量而无人知道，
    // 更糟的是照旧裁掉旧状态、照旧推进基线——等于把唯一的增量凭据删掉再宣布已消化。
    stateIncomplete = true
    stateCapture = { captured: [], missing: [`状态采集异常：${String(err?.message ?? err).slice(0, 300)}`] }
    stateFiles = []
    notes.push(`受管状态采集失败（保留旧状态，终态不得为 done）：${String(err?.message ?? err).slice(0, 300)}`)
  }

  // ── 3.6) 首次落锁：也进写集，与产物同事务 ─────────────────────────────
  //
  // 锁的落盘时机必须与产物同批（manifest.js:117-124 buildLockBody 的注释）。旧实现
  // 在 apply 之后调 writeLock 直接写盘，结果是：产物提交里没有 engine-lock.json，
  // 文件留在工作区当未跟踪脏文件——下一轮的变化集因此永远不干净，真实仓库实测就是
  // 这么长出 `?? .codewiki/engine-lock.json` 的（阶段 6 真实验收证据）。
  //
  // 现在把它当成 extraFiles 的一项：与文章共享 pre-image → 索引/基线失败时一起回滚
  // → 提交时一起进同一个 commit。仍然不能在 doctor 阶段写（那会让 `.codewiki/` 早于
  // `cw init` 存在，落地器判成半截库 wiki-missing），所以只在**真正要落地**的这一轮
  // 才进写集：无变化轮（idleRound）与提前返回的分支都不会碰它。
  if (lockStatus === 'absent' && !idleRound && doc?.current?.fingerprint) {
    try {
      stateFiles = [...stateFiles, {
        rel: ENGINE_LOCK_REL,
        content: buildLockBody(doc.current),
      }]
      notes.push('首次运行：引擎锁随本轮产物一并写入并提交')
    } catch (err) {
      // 落锁正文构造失败不该拖垮编译（它只是清单），但必须可见。
      notes.push(`引擎锁正文构造失败（本轮不落锁）：${String(err?.message ?? err).slice(0, 300)}`)
    }
  }

  // ── 3.7) 孤儿页与残留页：存量模块页里不该继续存在的那批 ──────────────────
  //
  // 两类判据都要跑，它们覆盖的是不同原因下消失的页：
  //   · 孤儿页（findOrphanPages）：模块被删 → source_files 指向的文件全没了；
  //   · 残留页（findStaleModulePages）：聚类重构让模块改名/合并 → 文件全在，但页名
  //     已对不上当前树里任何模块。真机 dsh-codewiki 落地 92 页、树里只有 20 个模块，
  //     其余 72 页是历次重构的残骸，仍挂在 _index.md 上、正文链接大量 404。
  //
  // 清理必须走落地器写集（deleteFiles），不能在这里 rm：索引/基线失败时要能一起回滚，
  // 提交时才会把它记进同一个 commit（否则工作区多一条 delete 脏改动）。
  let deleteFiles = []
  {
    try {
      const findOrphans = deps.findOrphanPages ?? realFindOrphanPages
      // 本轮产物里的页一律不算孤儿：它们正是这轮要重写的内容来源，哪怕 source_files
      // 暂时指向还没落地的文件（重命名时新路径可能本轮才写进来）。
      const keepPages = [
        ...(report?.articles ?? []).map((a) => a.wikiPath),
        ...(report?.rendered ?? []).map((a) => a.wikiPath),
        ...(report?.entry?.path ? [report.entry.path] : []),
      ].filter(Boolean)
      const orphans = findOrphans({ repoRoot: root, keepPages })
      if (orphans.length) {
        deleteFiles = orphans.map((o) => o.rel)
        notes.push(`发现 ${orphans.length} 个孤儿页（source_files 全部已失效），本轮一并清理：${orphans.slice(0, 5).map((o) => o.rel).join('、')}${orphans.length > 5 ? ' 等' : ''}`)
      }
      // 残留页判据要读**本轮产物的** module_tree.json：它是这轮聚类的权威结果。
      // 读不到（整仓模式没有树、或写盘失败）就跳过——凭名字猜会删掉全部正文。
      let liveTree = null
      const treePath = path.join(outDocsDir, 'module_tree.json')
      try {
        liveTree = JSON.parse(fs.readFileSync(treePath, 'utf8'))
      } catch (err) {
        // 整仓模式本来就没有树（ENOENT）：跳过残留页判定，凭名字猜会删掉全部正文。
        // 其余情况（JSON 损坏）必须抛——那是产物坏了，不是「没有树」。
        if (err?.code !== 'ENOENT') throw err
        liveTree = null
      }
      if (liveTree) {
        const findStale = deps.findStaleModulePages ?? realFindStaleModulePages
        const stalePages = findStale({ repoRoot: root, moduleTree: liveTree, keepPages })
        if (stalePages.length) {
          deleteFiles = [...deleteFiles, ...stalePages.map((o) => o.rel)]
          notes.push(`发现 ${stalePages.length} 个残留页（页名已不属于当前模块树的旧模块），本轮一并清理：${stalePages.slice(0, 5).map((o) => o.rel).join('、')}${stalePages.length > 5 ? ' 等' : ''}`)
        }
      }
    } catch (err) {
      // 扫不出来不该拖垮编译，但必须可见：沉默会让孤儿页永久堆积。
      notes.push(`孤儿页扫描失败（本轮不清理）：${String(err?.message ?? err).slice(0, 300)}`)
    }
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
      // 引擎自报 partial 同样是「没消化完」，必须在这里一并否决 —— 质量门只看产物
      // 质量（baselineEligible = outcome === 'done' 只对已落地页成立），它不知道引擎
      // 有一批叶子失败了。曾只传 stateIncomplete，于是引擎 partial + 门 done 时基线
      // 照常前移，终态却是 partial：下一轮从新基线算变化集，那批没写完的变化永久失明。
      // 状态不完整时额外一票否决：下一轮已经无法增量了，再推进基线就是把
      // 「没消化完的变化」记成已消化（旧状态已被裁掉，凭据也没了）。
      advanceBaseline: (stateIncomplete || engineOutcome !== 'done') ? false : null,
      // 完整无变化轮连基线/提交也不能碰：否则每次状态查询都会制造 wiki 提交。
      noChanges: idleRound,
      // 受管状态：与文章同批写、同批回滚、同批提交。
      extraFiles: stateFiles,
      // 孤儿页：与文章同批删、同批回滚（索引/基线失败会把它们恢复回来）、同批提交。
      deleteFiles,
      // 上一轮有、本轮没产出的状态文件要删掉（否则水合时会把过期图/旧页当成有效输入）。
      // 只在真的走增量时裁：全量的 docs 是干净重建，本来就不会留旧文件。
      // 无变化轮**绝不能裁**：那轮不写状态，裁剪会按「写集里没有它们」把上一轮的
      // 图/树/文章副本整批删掉，等于用一次空写把增量输入清空。
      // 状态不完整时同样不能裁：这一轮本来就没产出该有的文件，裁剪只会把上一轮
      // 那批（可能是完好的）凭据按「本轮没写」删掉——恰好把唯一的增量输入毁掉。
      pruneRoots: (idleRound || stateIncomplete) ? [] : [path.posix.join(stateDir, 'docs')],
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

  // 模型通道的空产出必须如实报出来：上游 200、只有 usage+finish、既没正文也没工具调用。
  // 引擎会把这类调用记成「这一页无需改动」，于是整轮看起来 done 却一篇文章没写
  // （0.17.21 已能靠引擎账本把失败叶子翻成 partial，但账本本身是引擎给的，
  // 这一条是插件侧独立可观测的证据，不参与裁决、只进 notes）。
  const bridgeRequests = Number(bridgeStats?.requests ?? 0)
  const emptyResponses = Number(bridgeStats?.emptyResponses ?? 0)
  if (emptyResponses > 0) {
    notes.push(`模型通道空产出 ${emptyResponses}/${bridgeRequests} 次（上游 200 但无正文、无工具调用）；引擎会把这类调用记成「无需改动」，请检查编译模型是否可用`)
  }

  // ── 5) 严格合成终态：最弱的一环说了算 ───────────────────────────────────
  // 取消是终态，但取消不得抹掉已经发生的事实：落地器不接 signal，走到这里说明
  // 落地事务已经跑完并给出了结论。此时若产物真的落地了，就按真实结果收尾，只把
  // 「取消来晚了」记进 notes —— 曾无条件报 cancelled，于是已提交、已推进基线的那一轮
  // 在终态里变成「产物未落地、基线未推进」，下一轮从旧基线重新消费一批已消化的变化。
  // 真正没落地（回滚或失败）时，取消才是那个该被报出来的事实。
  if (signal?.aborted && applyRes?.applied !== true) {
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
  let gateOutcome = report?.outcome ?? 'failed'
  if (stateCapture?.missing?.length) stateIncomplete = true
  if (stateIncomplete && gateOutcome === 'done') gateOutcome = 'partial'
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
  // 受管状态不完整是**明确**的阻塞原因：文章可以照写，但这一轮没有为下一轮留下
  // 增量凭据，不能算「变化已消化」。旧实现只把它写成 notes，终态照报 done，
  // 于是下一轮白退全量、并且已经裁掉了上一轮的图——一条无人知晓的退化。
  if (stateIncomplete) {
    const missing = (stateCapture?.missing ?? []).slice(0, 5).join('；')
    blockers.push({
      kind: 'quality-gate',
      detail: `[native-state] 受管状态不完整${missing ? `（${missing}）` : '（采集失败）'}：下一轮无法增量，本轮不裁旧状态、不推进基线`,
    })
  }
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

  // 首次落锁不在这里补写：锁已经是写集的一项（见上面 3.6），apply 没落地时它自然
  // 不存在（`.codewiki/` 也不会被凭空建出来），落地后它随产物一起提交。
  // 这里只把「锁到底有没有进这一轮」讲清楚，避免调用方以为 done 就等于锁已入库。
  if (lockStatus === 'absent') {
    const lockWritten = Array.isArray(applyRes?.written) && applyRes.written.includes(ENGINE_LOCK_REL)
    if (lockWritten) notes.push(`首次运行的引擎锁已随产物入库：${ENGINE_LOCK_REL}`)
    else notes.push('引擎锁未写入：本轮未落地（wiki 尚未初始化或落地失败），下次成功编译时再落锁')
  }

  return settle({
    outcome: finalOutcome,
    stage: applyRes?.baseline?.advanced ? 'commit' : 'index',
    blockers: finalBlockers,
    // 三个基线事实分开记、各有来源：许可（门）、事实（落地器）。此前只在 gate 里
    // 带 canAdvanceBaseline，settle 的兼容字段读 patch.baselineAdvanced，而没有任何
    // 一条业务分支传过它 —— 于是 JobService 落账的 canAdvanceBaseline 恒为 false，
    // 与「基线其实已经推进了」的事实相反。
    baselineEligible: report?.baselineEligible === true && !stateIncomplete,
    baselineAdvanced: applyRes?.baseline?.advanced === true,
    // 只认落地器的实际写入数（0 就是 0）。曾写成 `written || 引擎自报值`，
    // 于是整批回滚的一轮在账上仍是「写入了 N 篇」——取消/失败的结果被引擎的
    // 意图数洗白，用户在面板上看到「写入 N 篇」而库一个字没变。
    writtenCount: written,
    failedCount: result?.failedCount ?? 0,
    // 三计数直接取引擎自报值（entry.py:_counts_of 由 update_record 算出）；
    // 不在这里重新推导：落地器删的页（applyRes.deleted）与引擎判定的
    // removedCount 语义不同，混用会让面板「删除 N 页」对不上真实产物。
    keptCount: result?.keptCount ?? 0,
    removedCount: result?.removedCount ?? 0,
    unmappedCount: result?.unmappedCount ?? 0,
    error: finalOutcome === 'failed'
      ? (applyRes?.blockers?.[0]
        ? engineError({ code: 'engine-output', message: String(applyRes.blockers[0].detail ?? ''), stage: 'index' })
        : engineError({ code: 'engine-unknown', message: '编译未成立', stage: 'index' }))
      : null,
    engine: engineEvidence,
    usage: result?.usage ?? undefined,
    artifacts: {
      docsDir: outDocsDir,
      // 引擎自报的「原始树」指针（FSoft 只给了 module_tree.json 一个文件）。
      // 保留原语义不改：它是引擎协议的一部分，改指向会让契约读者误以为引擎变了。
      rawTreeDir: String(result?.artifacts?.rawTreeDir ?? ''),
      updateRecord: String(result?.artifacts?.updateRecord ?? ''),
      // 我们自己的整棵原始树留档（设计文档 L20 的「事实来源」）。与 rawTreeDir
      // 分开是因为两者语义不同：前者是引擎说的、后者是被消费之前的完整快照。
      rawTree: rawArchive?.ok ? rawArchive.dir : '',
      rawTreeFiles: rawArchive?.ok ? rawArchive.files : 0,
    },
    gate: {
      outcome: gateOutcome,
      writable: report?.writable === true,
      canAdvanceBaseline: report?.canAdvanceBaseline === true && !stateIncomplete,
      baselineEligible: report?.baselineEligible === true && !stateIncomplete,
      stateCaptured: stateCapture?.captured ?? [],
      stateMissing: stateCapture?.missing ?? [],
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
      // 删掉/裁剪了哪些文件也是交付证据：孤儿页清理与状态裁剪都发生在落地事务里，
      // 只在 notes 里写一句话没法审计（面板与 codewiki_progress 都看不到）。
      deleted: Array.isArray(applyRes?.deleted) ? applyRes.deleted : [],
      pruned: Array.isArray(applyRes?.pruned) ? applyRes.pruned : [],
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
