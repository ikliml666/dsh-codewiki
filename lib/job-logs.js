// 引擎事件日志（NDJSON，一个任务一个文件）。
//
// 为什么必须落盘：引擎日志此前只留在 `job.nativeLogs` 的最近 20 条里——纯内存、
// 不序列化、不进 jobSummary。真机上一次 99 分钟的编译结束后，能查到的日志只有最后
// 3 分钟（20 条桥请求），前面 96 分钟里引擎在干什么完全无从追查；宿主重启或任务被
// 截断（MAX_JOBS_KEPT）时更是全部消失。日志是事后解释「为什么慢、为什么 partial」
// 的唯一依据，它必须在进程死掉之后还活着。
//
// 放在仓库外：和原生更新记录同源理由——.codewiki/ 里多一个日志文件就会变成「提交
// 之后产生的未跟踪文件」，每轮都脏工作区。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG_ROOT = process.env.DSH_CODEWIKI_LOG_DIR || path.join(os.tmpdir(), 'dsh-codewiki-logs')
// 单任务日志上限：超过就丢掉前一半（保留最近的现场）。一次 28 篇文章的编译大约产生
// 数百到数千条（桥请求 + stderr + 阶段切换），2MB 足够覆盖，同时不会让临时目录失控。
const MAX_LOG_BYTES = Math.max(64 * 1024, Number(process.env.DSH_CODEWIKI_LOG_MAX_BYTES) || 2 * 1024 * 1024)

export function logFileOf(jobId) {
  return path.join(LOG_ROOT, `${String(jobId).replace(/[^\w.-]/g, '_')}.ndjson`)
}

// 一条事件压成一行。字段固定，避免同一个文件里出现多种形状后无人能解析。
function serialize(jobId, entry) {
  const e = {
    at: entry?.at || new Date().toISOString(),
    jobId,
    phase: entry?.phase ?? null,
    kind: entry?.kind ?? null,
    ...entry,
  }
  delete e.jobId
  return `${JSON.stringify({ jobId, ...e })}\n`
}

// 追加一条。写失败返回 false 而不抛：日志是观测，不能因为它把编译打断——
// 但调用方要能把失败如实报出去（job.logError），不许静默。
export function appendLog(jobId, entry) {
  try {
    fs.mkdirSync(LOG_ROOT, { recursive: true })
    const file = logFileOf(jobId)
    fs.appendFileSync(file, serialize(jobId, entry), 'utf8')
    trimIfNeeded(file)
    return true
  } catch {
    return false
  }
}

function trimIfNeeded(file) {
  let st
  try { st = fs.statSync(file) } catch { return }
  if (st.size <= MAX_LOG_BYTES) return
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    fs.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, 'utf8')
  } catch { /* 截断失败的后果只是文件继续变大，不值得打断编译 */ }
}

// 读回最近 N 条（面板/端点用）。坏行跳过：日志文件被外部改动或不完整写入时，
// 能读多少给多少比抛错更有用。
export function readLogTail(jobId, limit = 200) {
  const n = Math.max(1, Math.min(5000, Number(limit) || 200))
  let text
  try { text = fs.readFileSync(logFileOf(jobId), 'utf8') } catch { return [] }
  const lines = text.split('\n').filter(Boolean)
  const out = []
  for (const line of lines.slice(-n)) {
    try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return out
}

export function logStats(jobId) {
  try {
    const st = fs.statSync(logFileOf(jobId))
    return { path: logFileOf(jobId), bytes: st.size, updatedAt: st.mtime.toISOString() }
  } catch {
    return { path: logFileOf(jobId), bytes: 0, updatedAt: null }
  }
}
