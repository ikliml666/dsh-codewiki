// test-sessions.mjs — 会话记录存储冒烟（1.1.0）：list/read/prune 三导出函数 + TTL 清理。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `cw-sess-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`)
const { SESSIONS_DIR, listSessionRecords, readSessionRecord, pruneSessionRecords } = await import('./index.js')

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.error(`  ✗ ${msg}`) } }

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

fs.rmSync(path.join(SESSIONS_DIR, 'job_manual'), { recursive: true, force: true })
fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
console.log(failures ? `FAIL：${failures} 项失败` : 'PASS：会话记录存储冒烟全部通过')
process.exit(failures ? 1 : 0)
