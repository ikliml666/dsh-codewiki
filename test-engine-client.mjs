// 阶段 2：Node ↔ Python 薄适配器的测试（client.js 协议层 + 进程层）。
//
// 这一层是迁移的**唯一**跨语言边界，所以测试优先钉「协议破坏时会发生什么」，
// 而不是「正常路径能跑通」。理由：正常路径有 1C 的真实端到端兜底，
// 而协议破坏（引擎吐了半行 JSON、带了别人的 requestId、退出码 0 却报 failed）
// 一旦被静默吞掉，表现是「wiki 编译成功但文章没更新」——最坏的那种错。
//
// 覆盖（对应任务要求）：
//   · 非 JSON stdout 行      → engine-protocol，且**不**把半行当结果
//   · 未知 requestId         → 记 violation，不污染本次结果
//   · 缺 result 消息         → engine-protocol（退出码 0 也不能算成功）
//   · 退出码与语义 result 不一致 → 以 result 为准，退出码只表达进程层
//   · 中文/空格路径          → 真实 Python 子进程跑通
//   · 取消后 late result     → 取消后的 result 不覆盖已定的终态
//   · 重复调用               → 同一 client 连跑多次互不串结果
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProtocolReader,
  runEngine,
  ENGINE_PROTOCOL_VERSION,
} from './lib/engine/client.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (obj) => JSON.stringify(obj) + '\n'

// ── 协议层（纯函数，不 spawn）────────────────────────────────────────────

await check('协议：正常的 progress + result 序列被完整解析', async () => {
  const r = createProtocolReader({ requestId: 'req-1' })
  r.push(line({ type: 'progress', requestId: 'req-1', stage: 'graph', percent: 10 }))
  r.push(line({ type: 'progress', requestId: 'req-1', stage: 'articles', percent: 60 }))
  r.push(line({ type: 'result', requestId: 'req-1', result: { outcome: 'done', writtenCount: 2 } }))
  const out = r.end()
  assert.equal(out.violations.length, 0, `不应有违规：${JSON.stringify(out.violations)}`)
  assert.equal(out.progress.length, 2)
  assert.equal(out.result.outcome, 'done')
  assert.equal(out.result.writtenCount, 2)
  assert.equal(out.endedWithResult, true)
})

await check('协议：非 JSON 行记 engine-protocol，且不当成结果', async () => {
  const r = createProtocolReader({ requestId: 'req-2' })
  // 引擎自己的日志误写到 stdout —— 这是最容易发生的破坏
  r.push('INFO  loading tree-sitter grammar\n')
  r.push(line({ type: 'result', requestId: 'req-2', result: { outcome: 'done' } }))
  const out = r.end()
  assert.equal(out.violations.length, 1)
  assert.equal(out.violations[0].kind, 'not-json')
  // 关键：坏行不能让结果丢失，也不能被当成结果
  assert.equal(out.result.outcome, 'done')
})

await check('协议：半行 JSON（流被截断）在 end() 时被记为 not-json', async () => {
  const r = createProtocolReader({ requestId: 'req-3' })
  r.push('{"type":"result","requestId":"req-3","resu')   // 没有换行，进程就死了
  const out = r.end()
  assert.equal(out.result, null)
  assert.equal(out.endedWithResult, false)
  assert.ok(out.violations.some((v) => v.kind === 'not-json'))
})

await check('协议：未知 requestId 被隔离，不污染本次结果', async () => {
  const r = createProtocolReader({ requestId: 'mine' })
  r.push(line({ type: 'result', requestId: 'someone-else', result: { outcome: 'failed' } }))
  r.push(line({ type: 'result', requestId: 'mine', result: { outcome: 'done' } }))
  const out = r.end()
  assert.equal(out.result.outcome, 'done', '别人的 failed 不能覆盖我的 done')
  assert.equal(out.violations.length, 1)
  assert.equal(out.violations[0].kind, 'unknown-request')
  assert.match(out.violations[0].detail, /someone-else/)
})

await check('协议：缺 requestId 的消息也算未知请求（不能靠默认值蒙对）', async () => {
  const r = createProtocolReader({ requestId: 'mine' })
  r.push(line({ type: 'result', result: { outcome: 'done' } }))
  const out = r.end()
  assert.equal(out.result, null)
  assert.ok(out.violations.some((v) => v.kind === 'unknown-request'))
})

await check('协议：重复 result 记 duplicate-result，先到的赢', async () => {
  const r = createProtocolReader({ requestId: 'dup' })
  r.push(line({ type: 'result', requestId: 'dup', result: { outcome: 'partial', blockers: [{ kind: 'article-failed' }] } }))
  r.push(line({ type: 'result', requestId: 'dup', result: { outcome: 'done' } }))
  const out = r.end()
  assert.equal(out.result.outcome, 'partial', '后到的 done 不能把 partial 洗成成功')
  assert.ok(out.violations.some((v) => v.kind === 'duplicate-result'))
})

await check('协议：未登记的 type 记 bad-shape', async () => {
  const r = createProtocolReader({ requestId: 'x' })
  r.push(line({ type: 'telemetry', requestId: 'x', foo: 1 }))
  const out = r.end()
  assert.ok(out.violations.some((v) => v.kind === 'bad-shape'))
})

await check('协议：cancel 后到达的 result 记 late-result 且不覆盖终态', async () => {
  const r = createProtocolReader({ requestId: 'c' })
  r.markCancelled()
  r.push(line({ type: 'result', requestId: 'c', result: { outcome: 'done' } }))
  const out = r.end()
  assert.equal(out.result, null, '取消后不该产生可用结果')
  assert.ok(out.violations.some((v) => v.kind === 'late-result'))
  assert.equal(out.cancelled, true)
})

await check('协议：CRLF 换行与空行不影响解析', async () => {
  const r = createProtocolReader({ requestId: 'crlf' })
  r.push('{"type":"progress","requestId":"crlf","stage":"graph","percent":1}\r\n')
  r.push('\r\n')
  r.push('{"type":"result","requestId":"crlf","result":{"outcome":"done"}}\r\n')
  const out = r.end()
  assert.equal(out.violations.length, 0)
  assert.equal(out.progress.length, 1)
  assert.equal(out.result.outcome, 'done')
})

await check('协议：多字节 UTF-8 跨 chunk 边界时不切坏中文', async () => {
  const r = createProtocolReader({ requestId: 'u' })
  const text = line({ type: 'progress', requestId: 'u', stage: 'articles', message: '正在写「中文模块」页' })
  const buf = Buffer.from(text, 'utf8')
  // 逐字节喂，模拟 stdout 被 TCP/管道任意切分
  for (const byte of buf) r.push(Buffer.from([byte]))
  const out = r.end()
  assert.equal(out.violations.length, 0)
  assert.equal(out.progress[0].message, '正在写「中文模块」页')
})

await check('协议：超大单行有上限，不会无限吃内存', async () => {
  const r = createProtocolReader({ requestId: 'big', maxLineBytes: 1024 })
  r.push('{"type":"result","requestId":"big","pad":"' + 'x'.repeat(4096) + '"}\n')
  const out = r.end()
  assert.ok(out.violations.some((v) => v.kind === 'line-too-long'))
  assert.equal(out.result, null)
})

await check('协议：ENGINE_PROTOCOL_VERSION 是契约常量，未登记版本要报错', async () => {
  assert.equal(typeof ENGINE_PROTOCOL_VERSION, 'number')
  const r = createProtocolReader({ requestId: 'v' })
  r.push(line({ type: 'hello', requestId: 'v', protocolVersion: 999 }))
  const out = r.end()
  assert.ok(out.violations.some((v) => v.kind === 'bad-shape' || v.kind === 'protocol-version'))
})

// ── 进程层（真实 spawn）──────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'fsoft-client-'))
const fakePy = join(tmp, 'fake_engine.py')

// 假引擎：按 FAKE_MODE 环境变量吐不同的（含故意破坏的）协议。
writeFileSync(fakePy, String.raw`
import json, os, sys, time

mode = os.environ.get("FAKE_MODE", "ok")

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

req = None
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        msg = json.loads(raw)
    except Exception:
        continue
    if msg.get("action"):
        req = msg.get("requestId") or "req-0"
        action = msg["action"]
        break

if mode == "ok":
    emit({"type": "progress", "requestId": req, "stage": "graph", "percent": 20})
    emit({"type": "result", "requestId": req, "result": {"outcome": "done", "writtenCount": 1}})
    sys.exit(0)
elif mode == "garbage":
    sys.stdout.write("INFO  not json at all\n")
    emit({"type": "result", "requestId": req, "result": {"outcome": "done", "writtenCount": 1}})
    sys.exit(0)
elif mode == "noresult":
    emit({"type": "progress", "requestId": req, "stage": "graph", "percent": 20})
    sys.exit(0)
elif mode == "failed-but-exit0":
    emit({"type": "result", "requestId": req, "result": {"outcome": "failed", "error": {"code": "engine-model", "message": "upstream 429"}}})
    sys.exit(0)
elif mode == "done-but-exit3":
    emit({"type": "result", "requestId": req, "result": {"outcome": "done", "writtenCount": 2}})
    sys.exit(3)
elif mode == "crash":
    sys.stderr.write("Traceback (most recent call last):\n  boom\n")
    sys.exit(7)
elif mode == "slow":
    emit({"type": "progress", "requestId": req, "stage": "articles", "percent": 50})
    time.sleep(30)
    emit({"type": "result", "requestId": req, "result": {"outcome": "done"}})
    sys.exit(0)
elif mode == "slow-with-progress":
    # 真机事故形态：引擎写出一批文章后卡住直到超时。进度帧带真实 writtenCount。
    emit({"type": "progress", "requestId": req, "stage": "articles", "percent": 54, "writtenCount": 0})
    emit({"type": "progress", "requestId": req, "stage": "articles", "percent": 60, "writtenCount": 17})
    time.sleep(30)
    emit({"type": "result", "requestId": req, "result": {"outcome": "done", "writtenCount": 17}})
    sys.exit(0)
elif mode == "slow-zero-written":
    # 反向对照：同样卡住超时，但一篇都没写出来（writtenCount 恒 0）。
    emit({"type": "progress", "requestId": req, "stage": "articles", "percent": 54, "writtenCount": 0})
    time.sleep(30)
    sys.exit(0)
elif mode == "late":
    emit({"type": "progress", "requestId": req, "stage": "articles", "percent": 50})
    time.sleep(0.6)
    emit({"type": "result", "requestId": req, "result": {"outcome": "done", "writtenCount": 9}})
    sys.exit(0)
elif mode == "wrongid":
    emit({"type": "result", "requestId": "not-my-id", "result": {"outcome": "done"}})
    sys.exit(0)
`, 'utf8')

const fakeEngine = (mode, extra = {}) => ({
  command: process.execPath,
  args: ['-e', `
    const { spawn } = require('node:child_process')
    const p = spawn(${JSON.stringify(process.env.FSOFT_TEST_PY || 'python')}, [${JSON.stringify(fakePy)}], {
      stdio: ['pipe','pipe','pipe'], env: { ...process.env, FAKE_MODE: ${JSON.stringify(mode)} },
    })
    process.stdin.pipe(p.stdin)
    p.stdout.pipe(process.stdout)
    p.stderr.pipe(process.stderr)
    p.on('exit', (c) => process.exit(c ?? 1))
  `],
  ...extra,
})

// 上面那层 node 包装是为了在 Windows 上可控地设 FAKE_MODE；直接用 python 也行，
// 但需要 env 注入点，所以统一走 engineCommand 的 env 参数。
const pyEngine = (mode) => ({
  command: process.env.FSOFT_TEST_PY || 'python',
  args: [fakePy],
  env: { FAKE_MODE: mode },
})

await check('进程：正常引擎返回契约结果（含 progress 计数）', async () => {
  const seen = []
  const res = await runEngine({
    engine: pyEngine('ok'),
    requestId: 'p-ok',
    action: 'doctor',
    onProgress: (p) => seen.push(p),
    timeoutMs: 20000,
  })
  assert.equal(res.outcome, 'done')
  assert.equal(res.writtenCount, 1)
  assert.equal(res.protocolViolations.length, 0, JSON.stringify(res.protocolViolations))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].stage, 'graph')
})

await check('进程：stdout 混入非 JSON → 结果仍可取，但带 engine-protocol 违规', async () => {
  const res = await runEngine({ engine: pyEngine('garbage'), requestId: 'p-g', action: 'doctor', timeoutMs: 20000 })
  assert.equal(res.outcome, 'done')
  assert.ok(res.protocolViolations.some((v) => v.kind === 'not-json'))
})

await check('进程：缺 result 消息（退出码 0）→ 判 engine-protocol，绝不报成功', async () => {
  const res = await runEngine({ engine: pyEngine('noresult'), requestId: 'p-n', action: 'doctor', timeoutMs: 20000 })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.error.code, 'engine-protocol')
})

await check('进程：退出码 0 但语义 failed → 以语义为准（退出码只表达进程层）', async () => {
  const res = await runEngine({ engine: pyEngine('failed-but-exit0'), requestId: 'p-f', action: 'doctor', timeoutMs: 20000 })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.error.code, 'engine-model')
  assert.equal(res.exitCode, 0)
})

await check('进程：语义 done 但退出码 3 → 语义保留，退出码如实记录并报警', async () => {
  const res = await runEngine({ engine: pyEngine('done-but-exit3'), requestId: 'p-d', action: 'doctor', timeoutMs: 20000 })
  assert.equal(res.outcome, 'done')
  assert.equal(res.exitCode, 3)
  assert.ok(res.protocolViolations.some((v) => v.kind === 'nonzero-exit'))
})

await check('进程：崩溃（无 result + 非零退出）→ engine-crashed 且带 stderr 摘要', async () => {
  const res = await runEngine({ engine: pyEngine('crash'), requestId: 'p-c', action: 'doctor', timeoutMs: 20000 })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.error.code, 'engine-crashed')
  assert.match(res.error.message, /boom|Traceback/)
})

await check('进程：未知 requestId 的 result 不算本次结果', async () => {
  const res = await runEngine({ engine: pyEngine('wrongid'), requestId: 'p-w', action: 'doctor', timeoutMs: 20000 })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.error.code, 'engine-protocol')
  assert.ok(res.protocolViolations.some((v) => v.kind === 'unknown-request'))
})

await check('进程：超时但有进度 → partial（已写的文章要救回来，不能判 failed）', async () => {
  // 0.16.1 起 client.js 就有这条自救逻辑，但真机上从未生效过：引擎入口
  // bridge_progress 三处 emit 都不带 written，进度帧恒为 0，于是「已写 17 篇后
  // 超时」被当成「一篇没写」判成 failed，状态不落盘 → 下一轮又退全量 → 死循环。
  // 这条用例钉的是 client 侧的契约：只要进度帧带了 written，就必须判 partial
  // 并把篇数与阶段如实带出来（上层靠它决定是否推进基线）。
  const seen = []
  const res = await runEngine({
    engine: pyEngine('slow-with-progress'),
    requestId: 'p-tp',
    action: 'generate',
    timeoutMs: 1200,
    onProgress: (p) => seen.push(p),
  })
  assert.equal(res.outcome, 'partial', `超时但有进度必须判 partial，实际 ${res.outcome}`)
  assert.equal(res.writtenCount, 17, `必须如实带出已写篇数，实际 ${res.writtenCount}`)
  assert.equal(res.stage, 'articles')
  assert.equal(res.error.code, 'engine-timeout')
  assert.ok(String(res.error.message).includes('17'), `错误信息要说明救回了几篇：${res.error.message}`)
  assert.ok(seen.some((p) => Number(p.writtenCount) === 17), '进度帧必须原样透传给 onProgress')
})

await check('进程：超时且零进展 → 仍判 failed（不能把空轮伪装成 partial）', async () => {
  // partial 的另一面：零进展轮必须老实判失败。判成 partial 会推进基线，
  // 把「什么都没编译出来」记成「已消化」，从此那一轮的变化永久丢失。
  const res = await runEngine({
    engine: pyEngine('slow-zero-written'),
    requestId: 'p-tz',
    action: 'generate',
    timeoutMs: 1200,
  })
  assert.equal(res.outcome, 'failed', `零进展超时必须判 failed，实际 ${res.outcome}`)
  assert.equal(res.error.code, 'engine-timeout')
})

await check('进程：超时 → engine-timeout，且进程树被终止', async () => {
  const t0 = Date.now()
  const res = await runEngine({ engine: pyEngine('slow'), requestId: 'p-t', action: 'generate', timeoutMs: 800 })
  const ms = Date.now() - t0
  assert.equal(res.outcome, 'failed')
  assert.equal(res.error.code, 'engine-timeout')
  assert.ok(ms < 10000, `超时未及时返回：${ms}ms`)
  assert.equal(res.terminated, true)
})

await check('进程：取消 → 终态 cancelled，late result 不覆盖', async () => {
  const ctrl = new AbortController()
  const p = runEngine({
    engine: pyEngine('late'),
    requestId: 'p-l',
    action: 'generate',
    timeoutMs: 20000,
    signal: ctrl.signal,
  })
  await sleep(300)
  ctrl.abort()
  const res = await p
  assert.equal(res.outcome, 'cancelled')
  assert.equal(res.writtenCount, 0, '取消后到达的 result 不能把写入数写进终态')
  assert.ok(res.protocolViolations.some((v) => v.kind === 'late-result' || v.kind === 'engine-cancelled'))
})

await check('进程：同一 client 连续调用互不串结果（requestId 隔离）', async () => {
  const r1 = await runEngine({ engine: pyEngine('ok'), requestId: 'a1', action: 'doctor', timeoutMs: 20000 })
  const r2 = await runEngine({ engine: pyEngine('failed-but-exit0'), requestId: 'a2', action: 'doctor', timeoutMs: 20000 })
  const r3 = await runEngine({ engine: pyEngine('ok'), requestId: 'a3', action: 'doctor', timeoutMs: 20000 })
  assert.equal(r1.outcome, 'done')
  assert.equal(r2.outcome, 'failed')
  assert.equal(r3.outcome, 'done')
  assert.equal(r1.writtenCount, 1)
  assert.equal(r3.writtenCount, 1)
})

await check('进程：引擎命令不存在 → engine-missing（不是崩溃）', async () => {
  const res = await runEngine({
    engine: { command: join(tmp, 'definitely-not-here.exe'), args: [] },
    requestId: 'p-m',
    action: 'doctor',
    timeoutMs: 5000,
  })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.error.code, 'engine-missing')
})

await check('进程：cwd 含中文与空格时也能跑通（Windows 路径）', async () => {
  const weird = join(tmp, '中文 空格 目录')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(weird, { recursive: true })
  const res = await runEngine({
    engine: pyEngine('ok'),
    requestId: 'p-u8',
    action: 'doctor',
    cwd: weird,
    timeoutMs: 20000,
  })
  assert.equal(res.outcome, 'done')
})

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) process.exitCode = 1
