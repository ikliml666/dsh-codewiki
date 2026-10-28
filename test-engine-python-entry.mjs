// 阶段 2：Python JSON-lines 薄入口的测试。
//
// 这个入口是整条迁移里唯一一处「我们写的 Python」。它的职责被刻意压到最小：
// 读一行请求 → 调 FSoft 公共 API → 把结果写成协议行。**不实现**任何依赖图、
// 聚类、增量算法（那是 FSoft 的活，重写它就是这次迁移要消灭的东西）。
//
// 所以测试钉的不是「生成质量」，而是这条边界的三个失败面：
//   · 协议面：非法请求/非法 action 必须回可机读失败，而不是崩栈或静默退出
//   · 环境面：doctor 必须真跑在真 venv 上，报真实版本与 pip check
//   · 凭证面：doctor 与错误信息**不得**把 api_key 之类凭证带进 stdout/stderr
//
// 真实模型生成不在这里测（1C 已用真模型验证过桥；这里用「缺模型通道」路径
// 证明入口不会自己去读 ~/.codewiki 的凭证库）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEngine } from './lib/engine/client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, 'lib', 'engine', 'python', 'entry.py')
const STAGE_MAP = join(HERE, 'lib', 'engine', 'python', 'stage_map.py')

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

// venv 位置：允许环境变量覆盖，默认用 1A 造的那个独立环境。
// 找不到就**明确报 SKIP**而不是假装通过——1A 的门禁证据在 docs 里，这里不重复造。
function findPython() {
  const fromEnv = process.env.DSH_CODEWIKI_ENGINE_PYTHON
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const candidates = [
    join(HERE, '..', '.probe-fsoft', 'venv', 'Scripts', 'python.exe'),
    join(HERE, '..', '.probe-fsoft', 'venv', 'bin', 'python'),
  ]
  for (const c of candidates) if (existsSync(c)) return resolve(c)
  return null
}

const PY = findPython()
if (!PY) {
  console.log('SKIP  找不到 1A 造的 venv（可用 DSH_CODEWIKI_ENGINE_PYTHON 指定），本套测试无法运行')
  console.log(`\n0 passed, 0 failed, SKIP`)
  process.exit(0)
}
console.log(`# 引擎 python: ${PY}`)

// 每次跑都用一个干净的临时仓库：入口会读 git commit，落在真实仓库上会污染基线
const sandbox = mkdtempSync(join(tmpdir(), 'cw-entry-'))
const repo = join(sandbox, '中文 空格 repo')
mkdirSync(repo, { recursive: true })
writeFileSync(join(repo, 'index.js'), 'export const a = 1\n')
spawnSync('git', ['init', '-q'], { cwd: repo })
spawnSync('git', ['add', '-A'], { cwd: repo })
spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo })

// 隔离 HOME：确保入口**不会**因为用户机器上真有 ~/.codewiki/config.json 而去读凭证库。
// 这也是「凭证面」测试的前提——如果入口偷偷 load 配置，这里会拿到空配置而暴露。
const fakeHome = join(sandbox, 'home')
mkdirSync(fakeHome, { recursive: true })
const isolatedEnv = { HOME: fakeHome, USERPROFILE: fakeHome, CODEWIKI_NO_KEYRING: '1' }

const engineOf = (extraEnv = {}) => ({
  command: PY,
  args: [ENTRY],
  env: { ...isolatedEnv, ...extraEnv },
})

const line = (obj) => JSON.stringify(obj) + '\n'

// ── 协议面 ────────────────────────────────────────────────────────────────

await check('协议：非法 action 回可机读失败，不是崩栈', async () => {
  const res = await runEngine({
    engine: engineOf(),
    requestId: 'r-bad-action',
    action: 'doctor',
    payload: {},
    cwd: repo,
    timeoutMs: 60000,
  })
  // client 只允许四动作，所以这里直接用「合法 action + 入口不认识」的方式测不了；
  // 改成绕过 client 直接喂一行非法 action 给入口，看它自己的行为。
  assert.equal(res.outcome, 'done', `doctor 应成功，实际 ${res.outcome}: ${res.error?.message ?? ''}`)

  const raw = spawnSync(PY, [ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    input: line({ requestId: 'r2', action: 'nope' }),
    encoding: 'utf8',
    timeout: 60000,
  })
  const msgs = String(raw.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const hello = msgs.find((m) => m.type === 'hello')
  const result = msgs.find((m) => m.type === 'result')
  assert.ok(hello, '入口必须先发 hello')
  assert.equal(hello.protocolVersion, 1)
  assert.ok(result, '非法 action 也必须发 result（不能只是退出）')
  assert.equal(result.result.outcome, 'failed')
  assert.equal(result.result.error.code, 'engine-protocol')
  assert.equal(result.requestId, 'r2', 'result 必须带原 requestId')
})

await check('协议：非 JSON 请求行回 engine-protocol 失败', async () => {
  const raw = spawnSync(PY, [ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    input: 'this is not json\n',
    encoding: 'utf8',
    timeout: 60000,
  })
  const msgs = String(raw.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const result = msgs.find((m) => m.type === 'result')
  assert.ok(result, '必须回 result')
  assert.equal(result.result.outcome, 'failed')
  assert.equal(result.result.error.code, 'engine-protocol')
})

await check('协议：cancel 动作立即回 cancelled 终态', async () => {
  const raw = spawnSync(PY, [ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    input: line({ requestId: 'r3', action: 'cancel' }),
    encoding: 'utf8',
    timeout: 60000,
  })
  const msgs = String(raw.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const result = msgs.find((m) => m.type === 'result')
  assert.ok(result, '必须回 result')
  assert.equal(result.result.outcome, 'cancelled')
  assert.equal(result.result.error, null, 'cancelled 不是失败，不许带 error')
  assert.ok(result.result.blockers.length >= 1, 'cancelled 应说明是取消')
  assert.equal(result.result.blockers[0].kind, 'cancelled')
})

// ── 环境面（真 venv、真 pip check）─────────────────────────────────────────

await check('doctor：真 venv 上报真实版本与闭合依赖', async () => {
  const res = await runEngine({
    engine: engineOf(),
    requestId: 'r-doctor',
    action: 'doctor',
    payload: {},
    cwd: repo,
    timeoutMs: 120000,
  })
  assert.equal(res.outcome, 'done', `doctor 应 done，实际 ${res.outcome}: ${res.error?.message ?? ''} / ${res.stderrTail}`)
  assert.deepEqual(res.protocolViolations, [], `不应有协议违规：${JSON.stringify(res.protocolViolations)}`)
  assert.equal(res.engine.version, '2.0.0', `引擎版本应为 2.0.0，实际 ${JSON.stringify(res.engine.version)}`)
  assert.match(res.engine.python, /^3\.12\./, `python 版本应为 3.12.x，实际 ${res.engine.python}`)
})

await check('doctor：pip check 闭合状态被如实上报（不闭合要能看出来）', async () => {
  const res = await runEngine({
    engine: engineOf(),
    requestId: 'r-doctor2',
    action: 'doctor',
    payload: {},
    cwd: repo,
    timeoutMs: 120000,
  })
  // 这里不断言「一定 ok」（那是 1A 的事），而断言**它把结论报出来了**：
  // doctor 的价值是让上层知道能不能信这个环境，而不是永远说 ok。
  assert.equal(res.outcome, 'done')
  const text = JSON.stringify(res)
  assert.ok(/broken requirements|deps|pip/i.test(text), `doctor 结果里应能看到 pip 检查结论：${text.slice(0, 400)}`)
})

// ── 凭证面 ────────────────────────────────────────────────────────────────

await check('凭证：doctor 输出不含任何 api_key/凭证字样', async () => {
  const res = await runEngine({
    engine: engineOf(),
    requestId: 'r-doctor3',
    action: 'doctor',
    payload: {},
    cwd: repo,
    timeoutMs: 120000,
  })
  const blob = JSON.stringify(res) + res.stderrTail
  for (const needle of ['api_key', 'apiKey', 'sk-', 'credentials.json', 'keyring']) {
    assert.ok(!blob.includes(needle), `doctor 输出不得包含 ${needle}：${blob.slice(0, 600)}`)
  }
})

await check('凭证：缺模型通道的 generate 直接失败，不去读本机配置/凭证库', async () => {
  const res = await runEngine({
    engine: engineOf(),
    requestId: 'r-gen-nomodel',
    action: 'generate',
    payload: { repoPath: repo, docsDir: join(repo, '.codewiki') },
    cwd: repo,
    timeoutMs: 120000,
  })
  assert.equal(res.outcome, 'failed', `缺模型通道应失败，实际 ${res.outcome}`)
  assert.equal(res.error.code, 'engine-model', `错误码应为 engine-model，实际 ${res.error.code}`)
  assert.match(res.error.message, /模型通道|llm|apiKey/i, `错误信息应指明缺模型通道：${res.error.message}`)
  const blob = JSON.stringify(res) + res.stderrTail
  for (const needle of ['api_key', 'sk-', 'credentials.json']) {
    assert.ok(!blob.includes(needle), `失败路径不得泄漏凭证字样 ${needle}：${blob.slice(0, 600)}`)
  }
})

// ── 阶段映射（纯逻辑，单独模块便于逐条钉死）───────────────────────────────

await check('阶段映射：FSoft 五段映射到引擎八段契约，且百分数单调', async () => {
  const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(STAGE_MAP))})
from stage_map import map_stage, percent_of
out = {
  "stages": [map_stage(n) for n in (1, 2, 3, 4, 5)],
  "unknown": map_stage(99),
  "p0": percent_of(0, 0.0),
  "p1": percent_of(1, 0.5),
  "p3": percent_of(3, 1.0),
}
print(json.dumps(out))
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `stage_map 自检失败：${raw.stderr}`)
  const out = JSON.parse(String(raw.stdout).trim())
  assert.deepEqual(out.stages, ['graph', 'cluster', 'articles', 'validate', 'validate'])
  assert.equal(out.unknown, 'articles', '未知阶段归到最接近的默认段，不能抛')
  assert.equal(out.p0, 0)
  assert.ok(out.p1 > out.p0 && out.p3 > out.p1, `百分数必须单调递增：${out.p0}/${out.p1}/${out.p3}`)
  assert.ok(out.p3 <= 100, `百分数不得超过 100：${out.p3}`)
})

await check('阶段映射：与契约里的 ENGINE_STAGES 同集合（改一边必须改另一边）', async () => {
  const { ENGINE_STAGES } = await import('./lib/engine/contract.js')
  const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(STAGE_MAP))})
from stage_map import ENGINE_STAGES as P
print(json.dumps(P))
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `读取 stage_map.ENGINE_STAGES 失败：${raw.stderr}`)
  assert.deepEqual(JSON.parse(String(raw.stdout).trim()), ENGINE_STAGES)
})

// ── 收尾 ──────────────────────────────────────────────────────────────────

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 上占用是常事，临时目录会自动回收 */ }

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n[${f.label}]\n${f.err.stack || f.err.message}`)
  process.exit(1)
}
