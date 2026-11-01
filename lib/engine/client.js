// 阶段 2：Node ↔ Python 的薄适配层（进程 + 协议），迁移里唯一的跨语言边界。
//
// 职责边界（故意窄）：
//   · 起一个受管子进程，写一行请求 JSON，读回 JSON-lines；
//   · 把引擎消息翻译成 contract.js 的 EngineResult/EngineProgress/EngineError；
//   · 超时/取消/崩溃/协议破坏时给出**可机读**的失败，而不是抛一个模糊异常。
//
// 不做什么（写下来是为了防止这里长成第二个编译器）：
//   · 不实现聚类、图 diff、文章写作——那是引擎的活；
//   · 不读凭证、不连模型——模型通道由 llm-bridge.js 单独提供；
//   · 不写 .codewiki——产物落盘与映射在 output.js / mapping.js。
//
// 协议不变量（对应 test-engine-client.mjs 的断言）：
//   1. stdout **只**是 JSON-lines；任何非 JSON 行记 `not-json` 违规，但**不丢弃**已收结果。
//   2. 每条消息必须带匹配的 `requestId`；不匹配记 `unknown-request`，绝不参与本次结果。
//   3. 没有 `result` 消息 = 协议破坏，即使退出码是 0 也判失败。
//   4. 退出码只表达**进程层**结果。语义以 `result` 为准：退出码 0 + 语义 failed 是失败；
//      语义 done + 退出码非 0 保留 done 并记 `nonzero-exit` 违规（让人去看 stderr）。
//   5. 取消后到达的 result 记 `late-result` 并丢弃——取消是终态，不能被迟到的成功洗白。
//   6. 重复 result 先到的赢（后到的是引擎 bug，不是我们的）。

import { spawn } from 'node:child_process'
import { engineError, engineProgress, engineResult, ENGINE_CONTRACT_VERSION } from './contract.js'
import { terminateProcessTree } from './process-tree.js'

// 协议版本独立于结果契约版本：前者管「行怎么长」，后者管「结果字段」。
export const ENGINE_PROTOCOL_VERSION = 1

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
const DEFAULT_STDERR_TAIL = 4000
// 静默阈值：多久没收到任何协议帧就判定引擎卡死。必须显著大于 entry.py 的心跳
// 间隔（_HEARTBEAT_SEC = 60s），否则心跳自己会被当成卡死；留 10 倍余量，是因为
// 真机上「慢」的那一轮单模块模型调用实测 20 秒级、最长一条 22 秒，10 分钟足够
// 区分「慢」与「死」。可用 DSH_CODEWIKI_ENGINE_SILENCE_MS 覆盖（测试用）。
// 收到 result 之后给进程的自行收场窗口（毫秒）。正常引擎在一帧之内就退，这个
// 窗口只有「result 已到却卡住不退」的进程才会走到；超时即杀，绝不把已经确定的
// 语义结果改判成超时/卡死。
const DEFAULT_RESULT_GRACE_MS = 2000

const DEFAULT_SILENCE_MS = Math.max(
  30_000,
  Number(process.env.DSH_CODEWIKI_ENGINE_SILENCE_MS) || 10 * 60 * 1000,
)

/**
 * 增量式 JSON-lines 读取器。纯逻辑、不碰进程，所以能被逐字节喂（模拟管道任意切分）。
 *
 * @param {object} options
 * @param {string} options.requestId 只接受这个 id 的消息
 * @param {number} [options.maxLineBytes] 单行上限，防引擎失控吐超长行吃内存
 */
export function createProtocolReader(options = {}) {
  const requestId = String(options.requestId ?? '')
  if (!requestId) throw new Error('createProtocolReader: 需要 requestId')
  const maxLineBytes = Number.isFinite(options.maxLineBytes) ? options.maxLineBytes : DEFAULT_MAX_LINE_BYTES

  let buf = Buffer.alloc(0)
  let cancelled = false
  let result = null
  let resultSeen = false
  const progress = []
  const errors = []
  const violations = []
  let ended = false

  const violate = (kind, detail) => violations.push({ kind, detail: String(detail ?? '').slice(0, 500) })

  // 返回本条消息归入的类别，便于调用方按需实时推送进度
  function handleLine(text) {
    const raw = text.trim()
    if (!raw) return null
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      // 引擎日志误写到 stdout 是最常见的破坏；记下来但不影响后续解析
      violate('not-json', raw.slice(0, 200))
      return 'violation'
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      violate('bad-shape', raw.slice(0, 200))
      return 'violation'
    }
    const type = String(msg.type ?? '')
    const id = String(msg.requestId ?? '')

    if (type === 'hello') {
      const v = Number(msg.protocolVersion)
      if (v !== ENGINE_PROTOCOL_VERSION) {
        violate('protocol-version', `引擎报协议 ${msg.protocolVersion}，本端 ${ENGINE_PROTOCOL_VERSION}`)
      }
      return 'hello'
    }

    // requestId 是唯一的关联键。缺失也算不匹配——不能靠「只有一条消息」蒙对。
    if (id !== requestId) {
      violate('unknown-request', `收到 ${type || '未知类型'} 的 requestId=${JSON.stringify(id)}，期望 ${requestId}`)
      return 'violation'
    }

    if (type === 'progress') {
      try {
        progress.push(engineProgress(msg))
        return 'progress'
      } catch (err) {
        violate('bad-shape', err.message)
        return 'violation'
      }
    }

    if (type === 'error') {
      // 引擎主动报错：不是协议破坏，是语义失败（可能后面还有 result）
      errors.push(engineError(msg.error ?? msg))
      return 'error'
    }

    if (type === 'result') {
      if (cancelled) {
        // 取消之后迟到的成功不能洗白终态
        violate('late-result', `取消后收到 outcome=${JSON.stringify(msg.result?.outcome)}`)
        return 'violation'
      }
      if (resultSeen) {
        violate('duplicate-result', `重复 result：先到 ${result?.outcome}，后到 ${msg.result?.outcome}`)
        return 'violation'
      }
      try {
        result = engineResult(msg.result ?? {})
        resultSeen = true
        return 'result'
      } catch (err) {
        violate('bad-result', err.message)
        return 'violation'
      }
    }

    violate('bad-shape', `未登记的消息类型 ${JSON.stringify(type)}`)
    return 'violation'
  }

  return {
    /**
     * 喂一段 stdout（Buffer 或 string）。按字节缓冲，多字节 UTF-8 跨 chunk 不会切坏。
     * @returns {Array<object>} 本次新解析出的 progress 快照（供实时回调）
     */
    push(chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      buf = buf.length ? Buffer.concat([buf, b]) : b
      const fresh = []
      for (;;) {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) break
        const lineBuf = buf.subarray(0, nl)
        buf = buf.subarray(nl + 1)
        // 单行本身超限也要拦：引擎失控吐一行 8MB 时，解析它同样会吃内存
        if (lineBuf.length > maxLineBytes) {
          violate('line-too-long', `单行 ${lineBuf.length} 字节超过 ${maxLineBytes}，已跳过`)
          continue
        }
        const kind = handleLine(lineBuf.toString('utf8'))
        if (kind === 'progress') fresh.push(progress[progress.length - 1])
      }
      // 无换行的残留超限：说明这一行永远等不到结尾，丢弃防内存涨
      if (buf.length > maxLineBytes) {
        violate('line-too-long', `未终结单行超过 ${maxLineBytes} 字节，已丢弃缓冲`)
        buf = Buffer.alloc(0)
      }
      return fresh
    },

    /** 已解析的进度快照（只读消费；调用方按索引增量推送）。 */
    get progress() {
      return progress
    },

    /** 是否已收到本次 requestId 的 result（只读；用于「结果已到但进程不退」的判定）。 */
    get hasResult() {
      return resultSeen
    },

    /** 声明进入取消态：此后到达的 result 一律记为 late-result。 */
    markCancelled() {
      cancelled = true
    },

    /** 收尾：把残留在缓冲里的半行当成违规（截断的 JSON 不能当结果）。幂等。 */
    end() {
      if (buf.length) {
        violate('not-json', buf.toString('utf8').slice(0, 200))
        buf = Buffer.alloc(0)
      }
      ended = true
      return {
        result,
        progress,
        errors,
        violations,
        cancelled,
        endedWithResult: Boolean(resultSeen),
        ended,
      }
    },
  }
}

// 把引擎命令描述规范成 spawn 参数。允许 {command, args, env, cwd}。
function spawnPlan(engine, cwd, env) {
  if (!engine || typeof engine !== 'object') throw new Error('runEngine: 需要 engine 描述')
  const command = String(engine.command ?? '')
  if (!command) throw new Error('runEngine: engine.command 不能为空')
  return {
    command,
    args: Array.isArray(engine.args) ? engine.args.map(String) : [],
    cwd: engine.cwd ?? cwd,
    env: { ...process.env, ...(engine.env ?? {}), ...(env ?? {}) },
  }
}

function tail(text, max = DEFAULT_STDERR_TAIL) {
  const s = String(text ?? '')
  return s.length <= max ? s : `…${s.slice(-max)}`
}

/**
 * 跑一次引擎动作并归一成 EngineResult。
 *
 * @param {object} options
 * @param {{command:string,args?:string[],env?:object,cwd?:string}} options.engine
 * @param {string} options.requestId
 * @param {'doctor'|'generate'|'update'|'cancel'} options.action
 * @param {object} [options.payload] 动作附加字段（scope/language/model/compareTo…）
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {number} [options.timeoutMs=600000]
 * @param {AbortSignal} [options.signal]
 * @param {(p:object)=>void} [options.onProgress]
 * @param {(e:object)=>void} [options.onLog]
 * @param {number} [options.maxLineBytes]
 * @param {number} [options.graceMs] 终止进程树时的宽限
 * @param {number} [options.resultGraceMs] result 到达后等进程自行退出的宽限（默认 2000ms）
 */
export async function runEngine(options = {}) {
  const requestId = String(options.requestId ?? '')
  if (!requestId) throw new Error('runEngine: 需要 requestId')
  const action = String(options.action ?? '')
  if (!['doctor', 'generate', 'update', 'cancel'].includes(action)) {
    throw new Error(`runEngine: action 必须是 doctor/generate/update/cancel 之一，收到 ${JSON.stringify(action)}`)
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 600000
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}

  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const reader = createProtocolReader({ requestId, maxLineBytes: options.maxLineBytes })
  const reported = { count: 0 }
  let stderrBuf = ''
  let terminated = false
  let timedOut = false
  let aborted = false
  let exitCode = null
  let exitSignal = null
  let finished = false

  const flushProgress = () => {
    for (const p of reader.progress.slice(reported.count)) {
      reported.count++
      try { onProgress(p) } catch { /* 消费者异常不影响结果 */ }
    }
  }

  const finish = (result, extraViolations = []) => {
    if (finished) return result
    finished = true
    flushProgress()
    const seen = reader.end()
    return {
      ...result,
      contractVersion: ENGINE_CONTRACT_VERSION,
      requestId,
      action,
      protocolViolations: [...seen.violations, ...extraViolations],
      exitCode,
      exitSignal,
      terminated,
      stderrTail: tail(stderrBuf),
      durationMs: Date.now() - t0,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  }

  const fail = (code, message, extraViolations = []) => finish(
    engineResult({ outcome: 'failed', error: engineError({ code, message }) }),
    extraViolations,
  )

  let plan
  try {
    plan = spawnPlan(options.engine, options.cwd, options.env)
  } catch (err) {
    return fail('engine-missing', err.message)
  }

  let child
  try {
    child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX 上独立进程组，取消时能整组打掉；Windows 走 taskkill /T
      detached: process.platform !== 'win32',
    })
  } catch (err) {
    return fail('engine-missing', `无法启动引擎：${err.message}`)
  }

  // 最近一次收到协议帧的时刻。静默检测与进度上报共用这个时间戳，
  // 必须在挂 stdout 监听之前就绪（监听是异步的，但读代码的人不该为此心算 TDZ）。
  let lastFrameAt = Date.now()
  const markFrame = () => { lastFrameAt = Date.now() }

  // ── 结果宽限：result 已到就别再等进程自己退 ─────────────────────────────
  //
  // 协议不变量 4 说「语义以 result 为准」，但退出检测过去只等 'exit'：引擎把
  // result(done) 发出来之后如果卡在收尾（僵死的线程、没关的 pipe、忘了 return 的
  // 事件循环），这轮已经**确定成功**的编译会被 10 分钟静默或 180 分钟超时改判成
  // 卡死/超时——明明产物早写完了，却按 partial 交付、基线不推进，下一轮再跑一遍。
  // 所以：result 到达后给进程一个短暂的自行收场窗口，超时就杀掉按已有 result 收尾。
  let resolveResultGrace = null
  let resultGraceTimer = null
  const resultGraceMs = Number.isFinite(options.resultGraceMs) && options.resultGraceMs >= 0
    ? options.resultGraceMs
    : DEFAULT_RESULT_GRACE_MS
  const resultGrace = new Promise((resolve) => {
    resolveResultGrace = () => resolve({ kind: 'result-grace' })
  })
  const armResultGrace = () => {
    if (resultGraceTimer) return
    resultGraceTimer = setTimeout(() => { resolveResultGrace() }, resultGraceMs)
    if (typeof resultGraceTimer.unref === 'function') resultGraceTimer.unref()
  }

  child.stdout.on('data', (chunk) => {
    markFrame()
    reader.push(chunk)
    flushProgress()
    if (reader.hasResult) armResultGrace()
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    stderrBuf += text
    if (stderrBuf.length > DEFAULT_STDERR_TAIL * 4) stderrBuf = stderrBuf.slice(-DEFAULT_STDERR_TAIL * 2)
    try { onLog({ kind: 'stderr', text }) } catch { /* ignore */ }
  })

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitCode = code
      exitSignal = signal
      resolve({ kind: 'exit', code, signal })
    })
  })
  // spawn 失败（ENOENT 等）时 'exit' 不会触发，只有 'error'
  const spawnError = new Promise((resolve) => {
    child.on('error', (err) => resolve({ kind: 'spawn-error', err }))
  })

  // 请求行：一行 JSON + 换行，然后关 stdin（引擎读到 EOF 就该开始干活）
  try {
    child.stdin.write(JSON.stringify({ requestId, action, ...(options.payload ?? {}) }) + '\n')
    child.stdin.end()
  } catch (err) {
    onLog({ kind: 'stdin', error: err.message })
  }

  const killTree = async (reason) => {
    if (terminated) return
    terminated = true
    onLog({ kind: 'terminate', reason, pid: child.pid })
    try {
      const r = await terminateProcessTree(child.pid, {
        graceMs: options.graceMs ?? 3000,
        onLog: (m) => onLog({ kind: 'terminate', message: m }),
      })
      if (!r.ok) onLog({ kind: 'terminate', error: '根进程仍存活', result: r })
    } catch (err) {
      onLog({ kind: 'terminate', error: err.message })
    }
  }

  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve({ kind: 'timeout' }) }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })

  // ── 静默检测：超时只兜「跑太久」，兜不住「已经卡死」 ──────────────────
  //
  // 为什么单靠 timeoutMs 不够（0.16.9 真机事故）：默认超时是 180 分钟，而僵死的
  // 引擎会把这 180 分钟全占满——同一时刻调度闸门（parallelLimit 默认 1）被它
  // 锁死，其它仓库一条都推不动。真机上 job-mvubmj6v-1 就是这样：引擎进程 PID
  // 30284 的 CPU 在 52 分钟里只涨 14 秒，py-spy 主线程停在
  // `_poll (asyncio\windows_events.py)` 空转，产物 md 三次采样恒为 3 篇，
  // 而 job 还老老实实挂着「写文章中 54%」，谁也不知道它已经死了。
  //
  // 判据是「多久没收到任何协议帧」。引擎在长阶段会由 entry.py 的心跳线程按
  // _HEARTBEAT_SEC（60s）补帧，所以正常在跑的引擎绝不会静默这么久；真静默了
  // 就是卡死或半死。静默超限时按**已写篇数**决定口径，与 timeout 分支一致：
  // 有产物 → partial 交付（保住已写的文章与推进基线的可能），无产物 → failed。
  const silenceMs = Number.isFinite(options.silenceMs) && options.silenceMs > 0
    ? options.silenceMs
    : DEFAULT_SILENCE_MS

  let silenceTimer = null
  const silence = new Promise((resolve) => {
    silenceTimer = setInterval(() => {
      if (Date.now() - lastFrameAt < silenceMs) return
      // 只在**引擎仍存活**时判静默：进程退出走 exited，走不到这里。
      if (child.exitCode !== null) return
      resolve({ kind: 'silence' })
    }, Math.max(1000, Math.min(30000, Math.floor(silenceMs / 4))))
    if (typeof silenceTimer.unref === 'function') silenceTimer.unref()
  })

  const abort = new Promise((resolve) => {
    const sig = options.signal
    if (!sig) return
    if (sig.aborted) { aborted = true; resolve({ kind: 'abort' }); return }
    sig.addEventListener('abort', () => { aborted = true; resolve({ kind: 'abort' }) }, { once: true })
  })

  const first = await Promise.race([exited, timeout, silence, abort, spawnError, resultGrace])
  if (timer) clearTimeout(timer)
  if (silenceTimer) clearInterval(silenceTimer)
  if (resultGraceTimer) clearTimeout(resultGraceTimer)

  if (first.kind === 'spawn-error') {
    // ENOENT = 解释器/入口不存在（环境问题）；其它 spawn 失败同样是启动失败，不是引擎崩溃
    const code = first.err?.code === 'ENOENT' ? 'engine-missing' : 'engine-missing'
    return fail(code, `无法启动引擎：${first.err?.message ?? '未知错误'}`)
  }

  if (first.kind === 'timeout') {
    await killTree('timeout')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    // 0.16.1 起：超时但有进度（已写文章）→ partial，允许基线推进打破死循环
    const lastProgress = reader.progress.at(-1)
    const writtenCount = Number(lastProgress?.writtenCount ?? 0)
    if (writtenCount > 0) {
      return finish(
        engineResult({
          outcome: 'partial',
          stage: lastProgress?.stage ?? 'articles',
          writtenCount,
          error: engineError({ code: 'engine-timeout', message: `引擎在 ${timeoutMs}ms 内未完成（已写 ${writtenCount} 篇，进程树已终止）` }),
          blockers: [{ kind: 'engine-timeout', detail: `${timeoutMs}ms，已写 ${writtenCount} 篇` }],
        }),
        [{ kind: 'engine-timeout', detail: `${timeoutMs}ms` }],
      )
    }
    return fail('engine-timeout', `引擎在 ${timeoutMs}ms 内未完成（进程树已终止）`, [
      { kind: 'engine-timeout', detail: `${timeoutMs}ms` },
    ])
  }

  if (first.kind === 'silence') {
    const silentFor = Date.now() - lastFrameAt
    await killTree('silence')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    // 口径与 timeout 分支一致：已写文章就 partial 交付（别把十几分钟的成果丢掉），
    // 一篇没写才 failed。区别只在错误码与文案——「被判定卡死」是比「跑太久」
    // 更明确的事实，直接重跑通常就能过，不需要人工去读 180 分钟的空转日志。
    const lastProgress = reader.progress.at(-1)
    const writtenCount = Number(lastProgress?.writtenCount ?? 0)
    const detail = `${Math.round(silentFor / 1000)}s 未收到任何协议帧（心跳也停了），判定引擎卡死`
    if (writtenCount > 0) {
      return finish(
        engineResult({
          outcome: 'partial',
          stage: lastProgress?.stage ?? 'articles',
          writtenCount,
          error: engineError({ code: 'engine-timeout', message: `${detail}；已写 ${writtenCount} 篇，进程树已终止` }),
          blockers: [{ kind: 'engine-timeout', detail: `${detail}，已写 ${writtenCount} 篇` }],
        }),
        [{ kind: 'engine-timeout', detail }],
      )
    }
    return fail('engine-timeout', `${detail}（进程树已终止）`, [
      { kind: 'engine-timeout', detail },
    ])
  }

  if (first.kind === 'abort') {
    reader.markCancelled()
    await killTree('abort')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    // 取消是终态：写入数只能取已确认的进度，不能取迟到 result
    const partial = reader.end()
    return finish(
      engineResult({
        outcome: 'cancelled',
        stage: partial.progress.at(-1)?.stage ?? null,
        writtenCount: Number(partial.progress.at(-1)?.writtenCount ?? 0),
        blockers: [{ kind: 'cancelled', detail: '用户取消' }],
      }),
      [{ kind: 'engine-cancelled', detail: 'signal' }],
    )
  }

  if (first.kind === 'result-grace') {
    onLog({ kind: 'result-grace', detail: `${resultGraceMs}ms 内进程未自行退出，按已收到的 result 收尾` })
    await killTree('result-grace')
  }

  // 进程已退出（或因结果宽限被终止）：等 stdout 的 end，确保管道里剩余的行都读到了
  await new Promise((resolve) => {
    if (child.stdout.readableEnded) return resolve()
    child.stdout.once('end', resolve)
    // 有些平台 stdout 已 close 但 end 事件不再触发，加一个短保险
    setTimeout(resolve, 2000)
  })

  const seen = reader.end()

  if (!seen.endedWithResult) {
    // 没有 result = 协议破坏。退出码 0 也救不了它。
    const crashed = exitCode !== 0
    const code = crashed ? 'engine-crashed' : 'engine-protocol'
    // stderr 尾部必须进 message：崩溃的现场只有引擎自己吐得出来，
    // 让人再去翻日志才能知道原因，等于把可机读的失败变成需要人工排查的失败。
    const stderrHint = stderrBuf.trim() ? `：${tail(stderrBuf, 1200)}` : ''
    const detail = crashed
      ? `引擎异常退出（code=${exitCode}${exitSignal ? ` signal=${exitSignal}` : ''}）${stderrHint}`
      : `引擎正常退出但没有 result 消息（协议破坏）${stderrHint}`
    return fail(code, detail)
  }

  const extraViolations = []
  // 我们主动终止过的进程（结果宽限/静默/超时/取消）退出码是终止方式的产物，
  // 不是引擎自己的语义，不能记成 nonzero-exit 去污染一个已经明确的结果。
  if (!terminated && exitCode !== null && exitCode !== 0) {
    extraViolations.push({ kind: 'nonzero-exit', detail: `语义 ${seen.result.outcome} 但退出码 ${exitCode}` })
  }

  return finish(seen.result, extraViolations)
}

export default { ENGINE_PROTOCOL_VERSION, createProtocolReader, runEngine }
