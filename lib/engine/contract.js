// FSoft 原生引擎的跨进程契约（阶段 0）。
//
// 为什么需要它：迁移后 Node 不再自己算依赖图/聚类/增量，一切都来自 Python 引擎的
// 一次返回。这条边界一旦含糊，后面每个消费方（JobService 终态判定、面板、cw 基线、
// 自动提交、降级提醒）都会各自猜「引擎到底成功了没有」，而这正是 0.14.0 花一整轮
// 修掉的缺陷类型（1 篇成功 + 19 篇失败也报 done）。所以这里把三件事固定下来：
//
//   EngineResult   — 一次 generate/update 的完整结果（版本化，可校验）
//   EngineProgress — 推进中的阶段/计数快照（面板与 tick 共用）
//   EngineError    — 可机读失败事实（code 决定重试语义，message 只给人看）
//
// 语义硬不变量（由 engineResult 与 validateEngineResult 双重保证）：
//   · done      = 完整成功，**不许**带 blockers（带了就是自相矛盾）
//   · partial   = 部分完成，**必须**带至少一条 blockers（否则等于伪装成功）
//   · failed    = 失败，必须带 error
//   · cancelled = 取消，可带 blockers 说明已写成的部分
//
// 这里只做纯数据校验，不碰文件、不碰进程、不碰模型——纯函数才能被 TDD 钉死。

export const ENGINE_CONTRACT_VERSION = 1

// 阶段枚举是**契约**不是实现细节：面板步骤条、job.stage 映射、取消检查点都按它对齐。
// 顺序即推进顺序；env 在最前（Python 解释器/venv/依赖锁定），commit 在最后（自动提交）。
export const ENGINE_STAGES = [
  'env',        // 解释器与依赖锁定校验（doctor）
  'graph',      // 依赖图构建（无 LLM）
  'cluster',    // 模块聚类（LLM）
  'articles',   // 模块文章写作（LLM，agentic 工具循环）
  'validate',   // 文章质量门（frontmatter/锚点/死链/source_files）
  'index',      // cw index
  'baseline',   // cw meta update（只有完整成功才推进）
  'commit',     // 自动提交 .codewiki/ 与 CodeWiki.md
]

export const TERMINAL_OUTCOMES = Object.freeze(['done', 'partial', 'failed', 'cancelled'])

const OUTCOME_SET = new Set(TERMINAL_OUTCOMES)
const STAGE_SET = new Set(ENGINE_STAGES)

// 阶段 5：引擎自报的**增量结局**（来自 FSoft 的 update_record.json:outcome）。
// 它不是终态，而是「这一轮到底是组件级增量、无变化、还是引擎自己退了全量」。
// 为什么必须过契约：`full_fallback` / `detector_failure` 意味着引擎**没有**真正做增量，
// 哪怕产物看着完整，基线也不能照推进——否则下一轮的起点被抬到「其实没消化」的位置，
// 这批变化就永久丢了。null 表示这轮不是 update（全量编译没有增量结局可言）。
export const UPDATE_OUTCOMES = Object.freeze([
  'incremental',       // 真的做了组件级更新（图 diff 命中，只重写受影响模块）
  'no_change',         // 图 diff 为空：源码没变，文档已最新（不重写任何页）
  'full_fallback',     // 想增量但阈值/可比性触发回退，引擎已整份重建
  'detector_failure',  // 连旧状态都读不到 → 回退全量（我们水合过却读不到 = 我们的错）
])
const UPDATE_OUTCOME_SET = new Set(UPDATE_OUTCOMES)
// 只有这两种结局算「增量真的成立」：基线推进、变化视为已消化。
export const CONSUMING_UPDATE_OUTCOMES = Object.freeze(['incremental', 'no_change'])

// 阻塞原因类别：机读、稳定、可被终态判定与面板文案共用。
// 新增类别只允许追加（消费者按 kind 分派），不允许改名。
export const BLOCKER_KINDS = Object.freeze([
  'article-failed',    // 计划内必需文章没写成/校验不过
  'article-missing',   // 计划内必需文章缺失
  'unmapped-change',   // 有变更没能归属到任何文章
  'unmapped-page',     // 引擎产出了无法映射进 wiki 的页
  'quality-gate',      // 质量闸门拦下
  'index-failed',      // cw index 失败
  'baseline-failed',   // cw meta update 失败
  'commit-failed',     // 自动提交失败（不算引擎失败，但产物未入库）
  'engine-error',      // 引擎自身错误（进程崩溃/协议破坏）
  'cancelled',         // 用户取消
  // 阶段 5：增量不可用而降级（缺持久化图/模块树、基线不可达、引擎版本不符、
  // 有变化没归属到任何文章）。它不是失败：产物照写、基线不推进，
  // 下一轮仍会从旧基线重新算出这批变化（不丢、不重复消费）。
  'incremental-fallback',
])

const BLOCKER_SET = new Set(BLOCKER_KINDS)

export const ENGINE_ERROR_CODES = Object.freeze([
  'engine-missing',      // 解释器/入口/venv 不存在
  'engine-deps',         // 依赖锁定不一致（pip check / manifest 不符）
  'engine-timeout',      // 单阶段超时
  'engine-cancelled',    // 取消（不是失败）
  'engine-crashed',      // 非零退出/进程树异常
  'engine-protocol',     // stdout 协议破坏（非法 JSON / 缺字段）
  'engine-model',        // 模型通道失败（上游 provider 报错/限流/鉴权）
  'engine-output',       // 产物缺失或不可解析
  'engine-unknown',
])

const ERROR_CODE_SET = new Set(ENGINE_ERROR_CODES)
// 可重试（同一输入再来一次可能成功）的错误码。其余一律视为确定性失败，重试只是浪费。
const RETRYABLE_CODES = new Set(['engine-timeout', 'engine-model', 'engine-unknown'])

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cachedTokens: num(u.cachedTokens),
    requests: num(u.requests),
  }
}

function normalizeBlocker(b) {
  const kind = BLOCKER_SET.has(b?.kind) ? b.kind : 'engine-error'
  const out = { kind, detail: String(b?.detail ?? '').slice(0, 2000) }
  if (b?.target) out.target = String(b.target)
  if (b?.source) out.source = String(b.source)
  return out
}

// 一次 generate/update 的结果。非法输入抛错而不是静默归一——契约破坏必须响。
export function engineResult(input = {}) {
  const outcome = String(input?.outcome ?? '')
  if (!OUTCOME_SET.has(outcome)) {
    throw new Error(`engineResult: outcome 必须是 ${TERMINAL_OUTCOMES.join('/')} 之一，收到 ${JSON.stringify(input?.outcome)}`)
  }
  const blockers = Array.isArray(input?.blockers) ? input.blockers.map(normalizeBlocker) : []
  if (outcome === 'done' && blockers.length) {
    throw new Error('engineResult: outcome=done 不允许携带 blockers（done 表示完整成功，带阻塞原因即自相矛盾）')
  }
  if (outcome === 'partial' && !blockers.length) {
    throw new Error('engineResult: outcome=partial 必须携带至少一条 blockers（否则等于把失败伪装成部分成功）')
  }
  const error = input?.error ? engineError(input.error) : null
  if (outcome === 'failed' && !error) {
    throw new Error('engineResult: outcome=failed 必须携带 error')
  }
  // 增量结局：只接受登记过的值。写成别的字符串（比如引擎升级后改名）必须响，
  // 而不是被当成「不认识 → 忽略」——忽略它等于把「引擎其实退了全量」洗成增量成功。
  const rawUpdateOutcome = input?.updateOutcome
  let updateOutcome = null
  if (rawUpdateOutcome !== undefined && rawUpdateOutcome !== null && rawUpdateOutcome !== '') {
    const v = String(rawUpdateOutcome)
    if (!UPDATE_OUTCOME_SET.has(v)) {
      throw new Error(`engineResult: updateOutcome 必须是 ${UPDATE_OUTCOMES.join('/')} 之一，收到 ${JSON.stringify(rawUpdateOutcome)}`)
    }
    updateOutcome = v
  }
  return {
    contractVersion: ENGINE_CONTRACT_VERSION,
    outcome,
    // 引擎侧阶段终态（最后一个到达的 stage）；面板据此解释「停在哪一步」
    stage: STAGE_SET.has(input?.stage) ? input.stage : null,
    blockers,
    error,
    writtenCount: num(input?.writtenCount),
    failedCount: num(input?.failedCount),
    keptCount: num(input?.keptCount),
    removedCount: num(input?.removedCount),
    unmappedCount: num(input?.unmappedCount),
    // 增量结局（update 才有）。这是「基线能不能推进」的第二个证据源：
    // 质量门说产物完整，但引擎自己说它是 full_fallback —— 那这批变化不算消化。
    updateOutcome,
    usage: normalizeUsage(input?.usage),
    // 引擎自己的版本/锁定信息（doctor 的产物），用于面板展示与回滚取证
    engine: {
      version: String(input?.engine?.version ?? ''),
      commit: String(input?.engine?.commit ?? ''),
      python: String(input?.engine?.python ?? ''),
      // 依赖闭合结论。doctor 的价值在于**说出能不能信这个环境**，
      // 所以成功时也要带上证据（ok + pip check 摘要），而不是只说一句 done。
      deps: {
        ok: input?.engine?.deps?.ok === true,
        summary: String(input?.engine?.deps?.summary ?? '').slice(0, 2000),
      },
    },
    // 产物位置：文章写在哪、update_record 在哪、原始 FSoft 树在哪
    artifacts: {
      docsDir: String(input?.artifacts?.docsDir ?? ''),
      rawTreeDir: String(input?.artifacts?.rawTreeDir ?? ''),
      updateRecord: String(input?.artifacts?.updateRecord ?? ''),
    },
    startedAt: input?.startedAt ? String(input.startedAt) : null,
    finishedAt: input?.finishedAt ? String(input.finishedAt) : null,
  }
}

// 推进中的快照：tick 与面板共用，字段只增不减（旧 job 缺字段按 0/null 解释）。
export function engineProgress(input = {}) {
  const stage = String(input?.stage ?? '')
  if (!STAGE_SET.has(stage)) {
    throw new Error(`engineProgress: stage 必须是 ${ENGINE_STAGES.join('/')} 之一，收到 ${JSON.stringify(input?.stage)}`)
  }
  const raw = Number(input?.percent)
  const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.round(raw))) : 0
  return {
    contractVersion: ENGINE_CONTRACT_VERSION,
    stage,
    percent,
    message: String(input?.message ?? ''),
    writtenCount: num(input?.writtenCount),
    failedCount: num(input?.failedCount),
    totalCount: num(input?.totalCount),
    usage: normalizeUsage(input?.usage),
    at: input?.at ? String(input.at) : null,
  }
}

// 可机读失败事实。code 决定重试语义；未登记的 code 归到 engine-unknown 并保留原文在 detail。
export function engineError(input = {}) {
  const rawCode = String(input?.code ?? '')
  const code = ERROR_CODE_SET.has(rawCode) ? rawCode : 'engine-unknown'
  return {
    code,
    message: String(input?.message ?? '').slice(0, 4000),
    stage: STAGE_SET.has(input?.stage) ? input.stage : null,
    retryable: RETRYABLE_CODES.has(code),
    // 未登记 code 的原样保留，便于排障（不改 code 本身的机读语义）
    rawCode: code === 'engine-unknown' && rawCode ? rawCode.slice(0, 200) : undefined,
  }
}

// 校验一个「可能来自外部/旧版本/磁盘」的结果对象。不抛错，返回逐条 errors——
// 反序列化边界上的对象必须被检查而不是被信任（磁盘残留、版本不匹配都走这里）。
export function validateEngineResult(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['结果不是对象'] }
  }
  if (value.contractVersion !== ENGINE_CONTRACT_VERSION) {
    errors.push(`contractVersion 必须是 ${ENGINE_CONTRACT_VERSION}，收到 ${JSON.stringify(value.contractVersion)}`)
  }
  if (!OUTCOME_SET.has(value.outcome)) {
    errors.push(`outcome 非法：${JSON.stringify(value.outcome)}`)
  } else if (value.outcome === 'done' && Array.isArray(value.blockers) && value.blockers.length) {
    errors.push('outcome=done 却带 blockers')
  } else if (value.outcome === 'partial' && (!Array.isArray(value.blockers) || !value.blockers.length)) {
    errors.push('outcome=partial 却没有 blockers')
  }
  for (const field of ['writtenCount', 'failedCount', 'keptCount', 'removedCount', 'unmappedCount']) {
    const v = value[field]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      errors.push(`${field} 必须是非负数，收到 ${JSON.stringify(v)}`)
    }
  }
  if (value.blockers !== undefined) {
    if (!Array.isArray(value.blockers)) errors.push('blockers 必须是数组')
    else {
      for (const [i, b] of value.blockers.entries()) {
        if (!b || typeof b !== 'object') errors.push(`blockers[${i}] 不是对象`)
        else if (!BLOCKER_SET.has(b.kind)) errors.push(`blockers[${i}].kind 未登记：${JSON.stringify(b.kind)}`)
      }
    }
  }
  if (value.outcome === 'failed' && (!value.error || typeof value.error !== 'object')) {
    errors.push('outcome=failed 却缺 error')
  }
  // updateOutcome 为 null/缺省是合法的（非 update 编译没有增量结局）；
  // 一旦给了值就必须是登记过的枚举，否则「引擎退全量」会被洗成增量成功。
  if (value.updateOutcome !== undefined && value.updateOutcome !== null) {
    if (!UPDATE_OUTCOME_SET.has(value.updateOutcome)) {
      errors.push(`updateOutcome 未登记：${JSON.stringify(value.updateOutcome)}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

// 终态文案：与 lib/update-record.js 的 describeOutcome 同一口径（四态可一眼分清）。
export function describeEngineResult(result) {
  if (!result || typeof result !== 'object') return '引擎结果不可读'
  const first = Array.isArray(result.blockers) && result.blockers.length
    ? String(result.blockers[0].detail || result.blockers[0].kind || '')
    : ''
  switch (result.outcome) {
    case 'done':
      return `完成（写入 ${num(result.writtenCount)} 篇）`
    case 'partial':
      return `部分完成（写入 ${num(result.writtenCount)} 篇，${num(result.failedCount)} 篇未完成）：${first || '存在未消化项'}`
    case 'failed':
      return `失败：${result.error?.message || '未知原因'}`
    case 'cancelled':
      return `已取消（已写入 ${num(result.writtenCount)} 篇）`
    default:
      return `未知终态：${String(result.outcome)}`
  }
}
