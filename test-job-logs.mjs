// lib/job-logs.js：引擎事件日志落盘。
//
// 这里守的是「黑匣子必须比进程活得久」：日志此前只存在 job.nativeLogs 的
// 最近 20 条内存数组里，一次 99 分钟的编译结束后只剩最后 3 分钟可查。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-logs-test-'))
process.env.DSH_CODEWIKI_LOG_DIR = dir
process.env.DSH_CODEWIKI_LOG_MAX_BYTES = '65536'

const { appendLog, readLogTail, logStats, logFileOf, removeLog } = await import('./lib/job-logs.js')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${label}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ── 落盘与读回 ────────────────────────────────────────────────────────────
{
  const jobId = 'job-log-a'
  assert.equal(appendLog(jobId, { kind: 'progress', phase: 'engine', detail: 'articles 54%' }), true)
  assert.equal(appendLog(jobId, { kind: 'bridge', method: 'POST', path: '/v1/chat/completions', status: 200, ms: 1234 }), true)
  assert.equal(appendLog(jobId, { kind: 'stderr', text: 'boom' }), true)

  const tail = readLogTail(jobId, 10)
  check('日志：写入的事件按顺序读回', tail.length === 3 && tail[0].kind === 'progress' && tail[2].text === 'boom')
  check('日志：每条都带 jobId 与时间戳', tail.every((e) => e.jobId === jobId && typeof e.at === 'string' && e.at.length >= 19))
  check('日志：文件落在仓库外的独立目录', logFileOf(jobId).startsWith(dir) && logFileOf(jobId).endsWith('.ndjson'))

  const st = logStats(jobId)
  check('日志：统计能给出字节数与更新时间', st.bytes > 0 && typeof st.updatedAt === 'string')

  // limit 必须真的截断，否则「最近 N 条」在面板上等于全量下载。
  const one = readLogTail(jobId, 1)
  check('日志：limit 只返回最近 N 条', one.length === 1 && one[0].text === 'boom')
}

// ── 坏行与缺失文件 ────────────────────────────────────────────────────────
{
  const jobId = 'job-log-b'
  appendLog(jobId, { kind: 'progress', detail: 'ok-1' })
  fs.appendFileSync(logFileOf(jobId), '{ this is not json\n', 'utf8')
  appendLog(jobId, { kind: 'progress', detail: 'ok-2' })
  const tail = readLogTail(jobId, 10)
  check('日志：坏行跳过，不拖垮整份日志', tail.length === 2 && tail[1].detail === 'ok-2')

  const missing = readLogTail('job-never-existed', 10)
  check('日志：没有日志文件时返回空数组而不是抛错', Array.isArray(missing) && missing.length === 0)
  const emptyStats = logStats('job-never-existed')
  check('日志：缺失文件的统计是 0 字节而非异常', emptyStats.bytes === 0 && emptyStats.updatedAt === null)
}

// ── 体积上限 ──────────────────────────────────────────────────────────────
{
  const jobId = 'job-log-c'
  // 下限 64KB 是有意的（误配成 1 字节会让日志自己变成噪音），所以这里按 64KB 打。
  const LIMIT = 65536
  for (let i = 0; i < 3000; i += 1) {
    appendLog(jobId, { kind: 'stderr', text: `line-${i}-${'x'.repeat(40)}` })
  }
  const size = fs.statSync(logFileOf(jobId)).size
  check('日志：超过上限后截断，文件不会无限增长', size <= LIMIT, `实际 ${size} 字节`)
  const tail = readLogTail(jobId, 5000)
  check('日志：截断保留最近的现场（最后一条在）', tail.length > 0 && String(tail.at(-1).text).includes('line-2999'))
}

// ── 删除 ──────────────────────────────────────────────────────────────────
{
  const jobId = 'job-log-d'
  appendLog(jobId, { kind: 'progress', detail: 'x' })
  removeLog(jobId)
  check('日志：removeLog 之后文件不再存在', !fs.existsSync(logFileOf(jobId)))
  // 删两次不抛：任务被清理路径重复调用时必须幂等。
  removeLog(jobId)
  check('日志：removeLog 幂等', !fs.existsSync(logFileOf(jobId)))
}

console.log(`\n${pass} passed, ${fail} failed`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
