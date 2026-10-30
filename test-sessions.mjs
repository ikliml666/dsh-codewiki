// test-sessions.mjs — 会话记录存储冒烟（1.1.0）：list/read/prune 三导出函数 + TTL 清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `cw-sess-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`)
const { SESSIONS_DIR, listSessionRecords, readSessionRecord, pruneSessionRecords, listAllSessionRecords } = await import('./index.js')

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.error(`  ✗ ${msg}`) } }
// 上一轮中断可能留下残留目录，先把会话根清干净，断言才稳定
fs.rmSync(SESSIONS_DIR, { recursive: true, force: true })

check(Array.isArray(listSessionRecords('job-none')) && listSessionRecords('job-none').length === 0, '不存在的 job → 空列表')

// 手工构造记录（beginSessionRecord 是私有，经文件形态验证三导出函数）
const dir = path.join(SESSIONS_DIR, 'job_manual')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, '001.meta.json'), JSON.stringify({ n: 1, name: 'a.md', status: 'done' }))
fs.writeFileSync(path.join(dir, '001.full.json'), JSON.stringify({ n: 1, prompt: 'PROMPT', output: 'OUTPUT' }))
fs.writeFileSync(path.join(dir, '002.meta.json'), JSON.stringify({ n: 2, name: 'b.md', status: 'running' }))

const list = listSessionRecords('job_manual')
check(list.length === 2 && list[0].n === 2 && list[0].status === 'running', '列表按 n 倒序（最新在前）')

const item = readSessionRecord('job_manual', 1)
check(item?.prompt === 'PROMPT' && item?.output === 'OUTPUT', '单条全文读取（prompt/output）')
check(readSessionRecord('job_manual', 99) == null, '不存在的 n → null')

// 全局聚合（1.2.0）：跨任务汇总，最新在前，带 jobId
const dirB = path.join(SESSIONS_DIR, 'job_second')
fs.mkdirSync(dirB, { recursive: true })
fs.writeFileSync(path.join(dirB, '001.meta.json'), JSON.stringify({ n: 1, name: 'c.md', status: 'done', startedAt: '2026-10-26T10:00:00.000Z' }))
fs.writeFileSync(path.join(dir, '002.meta.json'), JSON.stringify({ n: 2, name: 'b.md', status: 'running', startedAt: '2026-10-26T11:00:00.000Z' }))
const all = listAllSessionRecords()
check(all.length === 3, '全局列表跨任务聚合（job_manual 2 条 + job_second 1 条）')
check(all[0].jobId === 'job_manual' && all[0].n === 2, 'startedAt 最新的排最前')
check(all.every((x) => typeof x.jobId === 'string'), '全局列表每条带 jobId')
check(listAllSessionRecords({ limit: 1 }).length === 1, 'limit 生效')
check(listAllSessionRecords({ jobIds: new Set(['job_second']) }).length === 1, 'jobIds 过滤生效')
check(listAllSessionRecords({ jobIds: new Set(['nope']) }).length === 0, 'jobIds 无匹配 → 空')
fs.rmSync(dirB, { recursive: true, force: true })

// TTL 清理：把 001 两个文件 mtime 改到 25h 前
const old = new Date(Date.now() - 25 * 3600e3)
fs.utimesSync(path.join(dir, '001.meta.json'), old, old)
fs.utimesSync(path.join(dir, '001.full.json'), old, old)
const rm = pruneSessionRecords(Date.now())
const after = listSessionRecords('job_manual')
check(rm === 2, `过期文件被删（rm=${rm}）`)
check(after.length === 1 && after[0].n === 2, '未过期记录保留')
check(!fs.existsSync(dir) || fs.readdirSync(dir).length === 1 || after.length === 1, '目录状态一致')
pruneSessionRecords(Date.now()) // 再跑一轮无过期：幂等
check(listSessionRecords('job_manual').length === 1, 'prune 幂等')

// 全过期 → job 目录被清空移除
const dir2 = path.join(SESSIONS_DIR, 'job_gone')
fs.mkdirSync(dir2, { recursive: true })
fs.writeFileSync(path.join(dir2, '001.meta.json'), JSON.stringify({ n: 1 }))
fs.utimesSync(path.join(dir2, '001.meta.json'), old, old)
pruneSessionRecords(Date.now())
check(!fs.existsSync(dir2), 'job 目录全空后移除')

// ── beginSessionRecord：桥与并发池共用的记录句柄（0.16.16）──────────────
// 原生通道的会话由 llm-bridge 钩子喂进来，task 形状为 {name, model, provider, batchPrompt}；
// 并发池喂的是 {name, model, provider, batchPrompt}。两条路径必须落成同一套字段。
const { beginSessionRecord } = await import('./index.js')
{
  const job = { id: 'job_hook' }
  const h = beginSessionRecord(job, { name: '原生请求 · hy3', model: 'hy3', provider: 'workbuddy', batchPrompt: '[user]\n写一段话' })
  check(job.sessionSeq === 1, `sessionSeq 自增到 1（实际 ${job.sessionSeq}）`)
  const m1 = listSessionRecords('job_hook')
  check(m1.length === 1 && m1[0].status === 'running' && m1[0].n === 1, '开始时立刻落 meta（status=running）')
  check(m1[0].name === '原生请求 · hy3' && m1[0].model === 'hy3' && m1[0].provider === 'workbuddy', '任务名/模型/provider 原样入库')
  check(m1[0].inputTokens > 0, '输入 token 有估算值（面板要显示 in Nk tok）')
  check(readSessionRecord('job_hook', 1).prompt === '[user]\n写一段话', 'prompt 全文可读（会话详情靠它）')

  // 流式增量：text-delta chunk 的形状与宿主 chunk 一致
  h.onDelta({ type: 'text-delta', text: '你好' })
  h.onDelta({ type: 'text-delta', text: '，世界' })
  h.onDelta({ type: 'usage', usage: { outputTokens: 99 } }) // 非文本 chunk 不该污染正文
  h.onDone('你好，世界', 7)
  const done = listSessionRecords('job_hook')[0]
  check(done.status === 'done' && done.outputChars === 5 && done.outputTokens === 7, `收尾写 done（chars=${done.outputChars} tok=${done.outputTokens}）`)
  check(readSessionRecord('job_hook', 1).output === '你好，世界', '输出全文落盘')
  check(Boolean(done.finishedAt), '收尾写 finishedAt')

  // 失败路径：错误信息截断 300 字，且 status=error
  const job2 = { id: 'job_hook_err' }
  const h2 = beginSessionRecord(job2, { name: 'x', model: 'm', provider: 'p', batchPrompt: 'p' })
  h2.onError(new Error('上游 429 '.repeat(80)))
  const e = listSessionRecords('job_hook_err')[0]
  check(e.status === 'error' && e.error.length === 300, `失败记 error 且截断 300 字（实际 ${e.error.length}）`)

  fs.rmSync(path.join(SESSIONS_DIR, 'job_hook'), { recursive: true, force: true })
  fs.rmSync(path.join(SESSIONS_DIR, 'job_hook_err'), { recursive: true, force: true })
}

fs.rmSync(path.join(SESSIONS_DIR, 'job_manual'), { recursive: true, force: true })
fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
console.log(failures ? `FAIL：${failures} 项失败` : 'PASS：会话记录存储冒烟全部通过')
process.exit(failures ? 1 : 0)
