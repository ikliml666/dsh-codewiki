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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
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

await check('用量：partial 终态也必须回带本轮 usage，不能恒为 0', async () => {
  // 真机 job-mw0aep74-7：40 次桥请求、16 个模块失败，任务 usage 四字段全 0。
  // 根因是 partial 分支提前 return，跳过了后面的采集段。用量是成本核算与
  // 「这一轮到底花了多少」的唯一来源，任何出口都不能丢——所以断言的是
  // action_generate 里「每个 return result 前面都配了 usage 赋值」，而非只测函数本身。
  const py = `import sys, json
import ast
src = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)
fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "action_generate")
body = list(ast.walk(fn))
uses = [n for n in body if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name)
                and t.value.id == "result" for t in n.targets)
        and any(isinstance(v, ast.Call) and getattr(v.func, "id", "") == "_usage_of"
                for v in [n.value])]
returns = [n for n in body if isinstance(n, ast.Return)
           and isinstance(n.value, ast.Name) and n.value.id == "result"]
report = {"usageAssignments": len(uses), "resultReturns": len(returns)}
out = None
import importlib.util as u
spec = u.spec_from_file_location("entry", sys.argv[1])
mod = u.module_from_spec(spec)
spec.loader.exec_module(mod)
totals = {"input_tokens": 1234, "output_tokens": 56, "cache_read_tokens": 78, "requests": 9}
import types
job = types.SimpleNamespace(statistics=types.SimpleNamespace(usage_totals=totals))
report["mapped"] = mod._usage_of(job)
report["mappedEmpty"] = mod._usage_of(types.SimpleNamespace(statistics=None))
mod._REAL_STDOUT.write(json.dumps(report) + chr(10))
mod._REAL_STDOUT.flush()`
  const raw = spawnSync(PY, ['-c', py, ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    encoding: 'utf8',
    timeout: 60000,
  })
  const line = String(raw.stdout || '').trim().split('\n').filter(Boolean).pop()
  assert.ok(line, `探针无输出：${raw.stdout}${raw.stderr}`)
  const got = JSON.parse(line)
  assert.ok(got.resultReturns >= 1, `应有多条 result 出口，实际 ${got.resultReturns}`)
  assert.equal(
    got.usageAssignments,
    got.resultReturns,
    `每条 result 出口都要带 usage（出口 ${got.resultReturns} 条，usage 赋值只有 ${got.usageAssignments} 条）`,
  )
  assert.deepEqual(got.mapped, { inputTokens: 1234, outputTokens: 56, cachedTokens: 78, requests: 9 })
  assert.deepEqual(got.mappedEmpty, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 })
})
await check('引擎记账的失败必须进 blockers：agent 空返回不能被读成「这页无需改动」', async () => {
  // 真机 job-mw0cn6cv-4：引擎 update_record 里 2 个叶子 calls.error 是
  // UnexpectedModelBehavior: Exceeded maximum output retries (3)，而同一批
  // verdicts 却是 24 条 verdict="no-op" + reason="no verdict returned by agent"
  // （上游 leaf_agent.py:142-176 把异常吞进 calls 后按 no-op 记账）。插件只读
  // outcome/verdicts 时，整轮报 done、blockers 为空 —— 模型压根没写任何东西，
  // 任务却显示「变化已全部消化」。
  //
  // 同一类账本还有 Step 6.1：orchestrator.py:432-438 把缺页生成异常只写进
  // rec.errors 与 calls（kind=missing_pages），outcome 同样不变。两处都要读，
  // 否则「缺页补写失败」照样能报 done。
  const py = `import sys, json, types
import importlib.util as u
spec = u.spec_from_file_location("entry", sys.argv[1])
mod = u.module_from_spec(spec)
spec.loader.exec_module(mod)
calls = [
    {"kind": "leaf_agent", "target": "quality_gates", "error": "UnexpectedModelBehavior: Exceeded maximum output retries (3)"},
    {"kind": "leaf_agent", "target": "quality_gates", "error": "UnexpectedModelBehavior: Exceeded maximum output retries (3)"},
    {"kind": "leaf_agent", "target": "build_deployment_config", "error": "UnexpectedModelBehavior: Exceeded maximum output retries (3)"},
    {"kind": "leaf_agent", "target": "clean_leaf", "error": None},
    {"kind": "missing_pages", "target": "-", "error": "RuntimeError: Invalid module file coverage"},
    {"kind": "routing", "target": "ignored", "error": "not a write failure"},
]
record = types.SimpleNamespace(calls=calls, errors=["missing pages: RuntimeError: Invalid module file coverage"])
adapter = types.SimpleNamespace(_last_update_record=record)
src = open(sys.argv[1], encoding="utf-8").read()
import ast
fn = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.FunctionDef) and n.name == "action_generate")
fn_src = ast.get_source_segment(src, fn)
blockers = mod._failed_blockers(mod._failed_calls_of(adapter))
report = {
    "failed": mod._failed_calls_of(adapter),
    "noRecord": mod._failed_calls_of(types.SimpleNamespace(_last_update_record=None)),
    "blockers": blockers,
    "callSites": fn_src.count("_failed_calls_of("),
    "blockerCallSites": fn_src.count("_failed_blockers("),
    "namedFailedKind": "article-failed" in src,
}
mod._REAL_STDOUT.write(json.dumps(report, ensure_ascii=False) + chr(10))
mod._REAL_STDOUT.flush()`
  const raw = spawnSync(PY, ['-c', py, ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    encoding: 'utf8',
    timeout: 60000,
  })
  const line = String(raw.stdout || '').trim().split('\n').filter(Boolean).pop()
  assert.ok(line, `探针无输出：${raw.stdout}${raw.stderr}`)
  const got = JSON.parse(line)
  assert.deepEqual(
    got.failed,
    [
      ['leaf_agent', 'quality_gates', 'UnexpectedModelBehavior: Exceeded maximum output retries (3)'],
      ['leaf_agent', 'build_deployment_config', 'UnexpectedModelBehavior: Exceeded maximum output retries (3)'],
      ['missing_pages', '-', 'RuntimeError: Invalid module file coverage'],
    ],
    `失败调用要按 (kind,target) 去重并保留错误原文，实际 ${JSON.stringify(got.failed)}`,
  )
  assert.deepEqual(got.noRecord, [], '没有 record 时返回空，不许编造失败')
  assert.equal(got.blockers.length, 3, `每条失败调用都要有 blocker，实际 ${got.blockers.length}`)
  assert.ok(
    got.blockers.every((b) => b.kind === 'article-failed'),
    `失败调用都落成 article-failed，实际 ${JSON.stringify(got.blockers.map((b) => b.kind))}`,
  )
  const details = got.blockers.map((b) => b.detail).join(' | ')
  assert.match(details, /叶子写作失败：quality_gates/, `叶子失败要点名，实际 ${details}`)
  assert.match(details, /缺页生成失败：-/, `缺页生成失败也要出现，实际 ${details}`)
  assert.ok(got.callSites >= 1, 'action_generate 必须真的用失败调用判终态')
  assert.ok(got.namedFailedKind, '失败调用要落成 article-failed，不能塞进别的类别')
  assert.ok(got.blockerCallSites >= 1, 'action_generate 必须调 _failed_blockers 造 blocker', )
})
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

await check('协议：入参字段按契约平铺在请求行顶层，入口必须认', async () => {
  // 契约（docs/fsoft-native-engine.md「接口面」表）与 client.js 都按
  // `{requestId, action, ...payload}` 平铺发送；入口若只读 `msg.payload`，
  // 顶层字段全部丢失：真实引擎拿不到 docsDir 就回退写进 repo/.codewiki，
  // 增量轮再把水合过的状态目录写回去，长出
  // `_native-state/docs/_native-state/docs/...` 自嵌套与重复页。
  // 假引擎（test-fixtures/fake-native-engine.mjs）按平铺读，所以这处不一致
  // 假引擎测试永远碰不到，只有真引擎才暴露。
  //
  // 判别用一条 repoPath 指向不存在目录的请求：入口若真读了顶层 repoPath，
  // 必须回 engine-missing「仓库路径不存在」；若没读，它会拿 cwd（存在的 repo）
  // 继续走，最后倒在「缺模型通道」上。—— 两种失败码不同，判别是干净的。
  const ghost = join(sandbox, '不存在的仓库目录')
  const flat = line({ requestId: 'r-flat', action: 'generate', repoPath: ghost })
  const raw = spawnSync(PY, [ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    input: flat,
    encoding: 'utf8',
    timeout: 120000,
  })
  const msgs = String(raw.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const result = msgs.find((m) => m.type === 'result')
  assert.ok(result, '必须回 result')
  assert.equal(result.result.outcome, 'failed')
  assert.equal(
    result.result.error.code, 'engine-missing',
    `入口没把请求顶层的 repoPath 读进来（回的是 ${result.result.error.code}）`
    + '——它会拿 cwd 顶替真实入参，docsDir/commitId 同理丢失',
  )
})

await check('协议：非 ASCII 路径的请求行按 UTF-8 读入，不被 locale 误解码', async () => {
  // 真机上踩到的：Windows 的 Python stdin 默认按 locale（cp936）解码，Node 按
  // UTF-8 写请求行，于是中文 repoPath 过管道变成「涓?鏂? 绌烘牸 repo」，入口
  // 报「仓库路径不存在（engine-missing）」。ASCII 路径永远复现不出来，所以
  // 这条用「存在的中文路径仓库」做判别：
  //   · stdin 编码对 → 读得到仓库 → 继续走到「缺模型通道」（engine-model）
  //   · stdin 编码错 → 路径乱码 → 「仓库路径不存在」（engine-missing）
  // 不依赖 PYTHONUTF8/PYTHONIOENCODING：入口必须自己把 stdin 钉成 UTF-8，
  // 否则任何直接调入口的调用方都会踩到（nativeEnginePlan 的 env 只覆盖它自己
  // 派生的进程）。
  const requestId = 'r-utf8-path'
  const raw = spawnSync(PY, [ENTRY], {
    cwd: repo,
    env: { ...process.env, ...isolatedEnv },
    input: line({ requestId, action: 'generate', repoPath: repo, docsDir: join(repo, '.codewiki') }),
    encoding: 'utf8',
    timeout: 120000,
  })
  const msgs = String(raw.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const result = msgs.find((m) => m.type === 'result')
  assert.ok(result, '必须回 result')
  assert.equal(result.result.outcome, 'failed')
  assert.equal(
    result.result.error.code, 'engine-model',
    `中文仓库路径请求被入口判成「${result.result.error.code}：${result.result.error.message}」`
    + '——说明 stdin 没按 UTF-8 解码，非 ASCII 路径会变成乱码路径',
  )
})

await check('协议：cancel 出参是 {cancelled:boolean}，不是一份 EngineResult', async () => {
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
  // 契约（docs/fsoft-native-engine.md「接口面」表）：cancel -> {cancelled:boolean}。
  // cancel 是控制面动作，不是一次编译的结果；回整份 EngineResult 会让下游把它当成
  // 「这轮编译结束了」，进而把一次取消记成一次带产物的终态。
  assert.equal(result.result.cancelled, true, `实际出参 ${JSON.stringify(result.result)}`)
  assert.equal(result.result.outcome, undefined, 'cancel 不允许回 EngineResult.outcome')
  assert.equal(result.result.blockers, undefined, 'cancel 不允许回 EngineResult.blockers')
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

await check('doctor：出参必须带 checks（不看明细就无法判断环境可信性）', async () => {
  const res = await runEngine({
    engine: engineOf(),
    requestId: 'r-doctor-checks',
    action: 'doctor',
    payload: {},
    cwd: repo,
    timeoutMs: 120000,
  })
  // 契约（docs/fsoft-native-engine.md「接口面」表）：doctor 出参含
  // checks:[{name,ok,detail}]。以前只回 EngineResult 形状，上层拿到 outcome=done
  // 也不知道「过的是哪几项检查」，环境坏了只能靠猜。
  assert.equal(res.outcome, 'done', `doctor 应 done：${res.error?.message ?? ''}`)
  assert.ok(Array.isArray(res.checks), `checks 必须是数组，实际 ${typeof res.checks}`)
  assert.ok(res.checks.length >= 3, `checks 至少三项（import/python/pip），实际 ${JSON.stringify(res.checks)}`)
  const names = res.checks.map((c) => c.name)
  for (const need of ['import', 'python', 'pip']) {
    assert.ok(names.includes(need), `checks 必须含 ${need}，实际 ${JSON.stringify(names)}`)
  }
  for (const c of res.checks) {
    assert.equal(typeof c.name, 'string', 'checks[].name 必须是字符串')
    assert.equal(typeof c.ok, 'boolean', `checks[${c.name}].ok 必须是布尔，实际 ${typeof c.ok}`)
    assert.equal(typeof c.detail, 'string', `checks[${c.name}].detail 必须是字符串`)
  }
  const pip = res.checks.find((c) => c.name === 'pip')
  assert.ok(pip.detail.length > 0, 'pip 检查必须给出证据（不是只说 ok）')
})

await check('doctor：checks 缺项/类型不对时归一而不是崩（诊断信息不能拖垮 doctor）', async () => {
  // 直接测归一函数：非数组 → []；缺 name 的项丢弃；ok 只认布尔 true。
  const { engineResult } = await import('./lib/engine/contract.js')
  const r = engineResult({ outcome: 'done', checks: 'not-an-array' })
  assert.deepEqual(r.checks, [], 'checks 非数组必须归一成空数组')
  const r2 = engineResult({
    outcome: 'done',
    checks: [{ name: 'pip', ok: 'true', detail: 'x' }, { ok: true }, null, { name: '' }],
  })
  assert.deepEqual(r2.checks, [{ name: 'pip', ok: false, detail: 'x' }],
    `字符串 'true' 不算通过、无 name 的项必须丢弃，实际 ${JSON.stringify(r2.checks)}`)
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
from stage_map import articles_ceiling, articles_percent, is_incremental, map_stage, percent_of
out = {
  "stages": [map_stage(n) for n in (1, 2, 3, 4, 5)],
  "unknown": map_stage(99),
  "p0": percent_of(0, 0.0),
  "p1": percent_of(1, 0.5),
  "p3": percent_of(3, 1.0),
  "incr": [is_incremental("Incremental Update"), is_incremental("Documentation Generation"), is_incremental(None)],
  "articles": [articles_percent(w, 28) for w in (0, 7, 14, 28, 40)],
  "ceiling": articles_ceiling(),
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
  // 增量轮：FSoft 借「模块聚类」槽位跑整轮文章写作（doc_generator.py:441），
  // 按阶段号会把它打成 cluster 并把进度钉在 36%。description 才是它给的语义。
  assert.deepEqual(out.incr, [true, false, false], '增量轮只认 description 标记')
  assert.ok(out.articles[1] > out.articles[0], `写文章阶段必须随篇数推进：${out.articles}`)
  assert.ok(out.articles[3] === out.ceiling, `写到全部篇数时到达 articles 区段上限：${out.articles[3]} != ${out.ceiling}`)
  assert.ok(out.articles[4] <= out.ceiling, `超出预期篇数不得越过区段上限：${out.articles[4]}`)
  assert.ok(out.articles[0] > out.p1, 'articles 区段必须晚于聚类区段（否则面板会把写作显示成聚类）')
})

// ── 源码面 ────────────────────────────────────────────────────────────────

await check('源码面：引擎不把本插件自己的 wiki 产物当成源码（否则每轮都判成有变化）', async () => {
  // 真实现场（阶段 6.8）：真实引擎在「源码零改动」的一轮里自报 outcome=incremental，
  // 图 diff 恒有 body:1 命中 `.codewiki/_meta.yaml::_meta.yaml`。根因是它把仓库里的
  // `.codewiki/` 与 `CodeWiki.md` 当成源码文件分析 —— 而这两处正是**我们自己每轮都会
  // 改写的产物**，于是「无变化」永远不成立、无变化轮必然产出一笔纯记账提交。
  // 这里钉的是行为：用入口给出的排除清单建 RepoAnalyzer，wiki 产物不得进文件树，
  // 而常规源码必须仍在（排除不许过宽）。
  const wikiRepo = join(sandbox, '排除 wiki 的仓库')
  mkdirSync(join(wikiRepo, 'src'), { recursive: true })
  mkdirSync(join(wikiRepo, '.codewiki', 'modules'), { recursive: true })
  writeFileSync(join(wikiRepo, 'src', 'app.py'), 'def main():' + '\n' + '    return 1' + '\n')
  writeFileSync(join(wikiRepo, '.codewiki', '_meta.yaml'), 'last_compiled_commit: abc' + '\n')
  writeFileSync(join(wikiRepo, '.codewiki', 'modules', 'app.md'), '# app' + '\n')
  writeFileSync(join(wikiRepo, 'CodeWiki.md'), '# CodeWiki' + '\n')
  spawnSync('git', ['init', '-q'], { cwd: wikiRepo })
  spawnSync('git', ['add', '-A'], { cwd: wikiRepo })

  const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry
from pathlib import Path
from codewiki.src.be.dependency_analyzer.analysis.repo_analyzer import RepoAnalyzer

patterns = entry.source_exclude_patterns()
def walk(tree, acc):
    if tree is None:
        return acc
    if tree.get("type") == "file":
        acc.append(tree["path"].replace("\\\\", "/"))
    for child in tree.get("children") or []:
        walk(child, acc)
    return acc
structure = RepoAnalyzer(None, patterns, True).analyze_repository_structure(${JSON.stringify(wikiRepo)})
files = walk(structure["file_tree"], [])
sys.__stdout__.write(json.dumps({"patterns": patterns, "files": files}))
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 120000 })
  assert.equal(raw.status, 0, `probe 失败：${raw.stderr}`)
  const out = JSON.parse(String(raw.stdout).trim())
  const wikiFiles = out.files.filter((f) => f === 'CodeWiki.md' || f.startsWith('.codewiki/'))
  assert.deepEqual(wikiFiles, [], `wiki 产物不得进源码分析面，实际命中：${JSON.stringify(wikiFiles)}`)
  assert.ok(out.files.includes('src/app.py'), `常规源码必须仍在分析面里：${JSON.stringify(out.files)}`)
})

await check('源码面：孤立 gitlink（无 .gitmodules 的嵌套仓库）必须排除出源码分析面', async () => {
  // 真实现场（0.16.3）：本仓库的 `.probe-fsoft/src` 是一次探针克隆误提交进来的
  // gitlink（mode 160000），没有 .gitmodules。它是 **tracked** 的，所以
  // use_gitignore=True 拦不住它（gitignore 只管未跟踪文件），引擎把那个 18MB /
  // 186 文件的无关子仓库当成源码建图、聚类，stderr 刷出成片
  // `Skipping invalid leaf node '.probe-fsoft/src/...' - not found in components`，
  // 最终撞上 45 分钟引擎超时被进程树终止 —— 整轮编译零产出。
  // 这里钉的是行为：入口给出的排除清单必须含该 gitlink 路径，且 RepoAnalyzer
  // 真的不再往里走；而正规 submodule（.gitmodules 有登记）**不得**被排除。
  const linkRepo = join(sandbox, '排除孤立 gitlink 的仓库')
  mkdirSync(join(linkRepo, 'src'), { recursive: true })
  mkdirSync(join(linkRepo, '嵌套仓库'), { recursive: true })
  writeFileSync(join(linkRepo, 'src', 'app.py'), 'def main():' + '\\n' + '    return 1' + '\\n')
  writeFileSync(join(linkRepo, '嵌套仓库', 'deep.py'), 'X = 1' + '\\n')
  spawnSync('git', ['init', '-q'], { cwd: linkRepo })
  // 把子目录做成独立仓库再 add：git 会把它记成 mode 160000 的 gitlink
  spawnSync('git', ['init', '-q'], { cwd: join(linkRepo, '嵌套仓库') })
  spawnSync('git', ['add', '-A'], { cwd: join(linkRepo, '嵌套仓库') })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'sub'], { cwd: join(linkRepo, '嵌套仓库') })
  spawnSync('git', ['add', '-A'], { cwd: linkRepo })

  const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry
from codewiki.src.be.dependency_analyzer.analysis.repo_analyzer import RepoAnalyzer

repo = ${JSON.stringify(linkRepo)}
pat = entry.source_exclude_patterns(repo)
def walk(tree, acc):
    if tree is None:
        return acc
    if tree.get("type") == "file":
        acc.append(tree["path"].replace("\\\\", "/"))
    for child in tree.get("children") or []:
        walk(child, acc)
    return acc
files = walk(RepoAnalyzer(None, pat, True).analyze_repository_structure(repo)["file_tree"], [])
sys.__stdout__.write(json.dumps({
    "patterns": pat,
    "files": files,
    "no_arg": entry.source_exclude_patterns(),
}))
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 120000 })
  assert.equal(raw.status, 0, `probe 失败：${raw.stderr}`)
  const out = JSON.parse(String(raw.stdout).trim())
  assert.ok(out.patterns.includes('嵌套仓库'), `孤立 gitlink 必须在排除清单里：${JSON.stringify(out.patterns)}`)
  const leaked = out.files.filter((f) => f.startsWith('嵌套仓库/'))
  assert.deepEqual(leaked, [], `gitlink 内部文件不得进源码分析面，实际命中：${JSON.stringify(leaked)}`)
  assert.ok(out.files.includes('src/app.py'), `常规源码必须仍在分析面里：${JSON.stringify(out.files)}`)
  // 兼容面：不给 repo_path 时保持旧语义，只返回 wiki 产物模式
  assert.deepEqual(out.no_arg, ['.codewiki', 'CodeWiki.md'], `省略 repo_path 时不得引入 git 探测：${JSON.stringify(out.no_arg)}`)

  // 正规 submodule（.gitmodules 有登记）不在排除之列：那种内容是项目架构的一部分
  writeFileSync(join(linkRepo, '.gitmodules'), '[submodule "嵌套仓库"]\n\tpath = 嵌套仓库\n\turl = https://example.com/x.git\n')
  const probe2 = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry
sys.__stdout__.write(json.dumps(entry.source_exclude_patterns(${JSON.stringify(linkRepo)})))
`
  const raw2 = spawnSync(PY, ['-c', probe2], { encoding: 'utf8', timeout: 120000 })
  assert.equal(raw2.status, 0, `probe2 失败：${raw2.stderr}`)
  assert.deepEqual(JSON.parse(String(raw2.stdout).trim()), ['.codewiki', 'CodeWiki.md'],
    '在 .gitmodules 登记过的 submodule 不得被排除')
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

// ── 进度桥接 ──────────────────────────────────────────────────────────────

await check('进度帧：writtenCount 必须是本轮真实改动篇数（超时全靠它判 partial）', async () => {
  // 真机事故（0.16.4 及以前）：bridge_progress 三处 emit 都不带 written，
  // 进度帧恒为 0；而 client.js 判「超时但有进度 → partial」的唯一依据就是最后
  // 一条 progress 的 writtenCount。于是「已写 20 篇后超时」被当成「一篇没写」
  // 判成 failed —— 0.16.1 为打破死循环加的 partial 自救在真机上从未生效，
  // 六次 job 全部 45 分钟超时、writtenCount=0、状态不落盘、下一轮又退全量。
  //
  // 另两条同样致命的语义：
  //   · 不能报 docs 目录**绝对篇数**——增量轮进场时 docsDir 已被灌入上一轮的文章
  //     （Node 侧 hydrateDocsDir 在启动解释器之前就做完了），绝对篇数会让「一篇
  //     没写的一轮」报出几十篇，把零进展的超时误判成 partial 并推进基线，比不报更坏；
  //   · 也不能只报**篇数净差**——增量轮通常不改篇数（原地重写同一批路径），
  //     净差会把真实改动记成零进展，partial 自救同样失效。
  const docs = join(sandbox, 'probe-docs')
  mkdirSync(join(docs, 'modules'), { recursive: true })
  // 进场基线：2 篇「上一轮留下的」文章
  writeFileSync(join(docs, 'modules', 'old-a.md'), '# old a\n')
  writeFileSync(join(docs, 'modules', 'old-b.md'), '# old b\n')
  const outFile = join(sandbox, 'probe-progress.json')
  const probe = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry

docs = pathlib.Path(${JSON.stringify(docs)})

class Tracker:
    def __init__(self):
        self.current_stage = 3
        self.stage_progress = 0.0
    def start_stage(self, stage, description=None):
        self.current_stage = stage
        self.stage_progress = 0.0
    def update_stage(self, progress, message=None):
        self.stage_progress = progress
    def complete_stage(self, message=None):
        self.stage_progress = 1.0

class Adapter:
    def __init__(self):
        self.progress_tracker = Tracker()

frames = []
def spy(request_id, stage, percent, message="", written=0, failed=0, total=0):
    frames.append({"stage": stage, "percent": percent, "written": written})
entry.emit_progress = spy

ad = Adapter()
entry.bridge_progress(ad, "req-probe", docs_dir=str(docs))
mods = docs / "modules"
# start_stage / complete_stage 是 force 帧：必须按当前真实产物重算，不吃节流缓存。
ad.progress_tracker.start_stage(3, "Documentation Generation")

# ① 原地改写一篇（篇数净差 = 0，但确实改动了）
import time
time.sleep(0.01)
(mods / "old-a.md").write_text("# old a rewritten in place", encoding="utf-8")
# 普通 update 走节流（_WRITTEN_RECOUNT_SEC 内复用上次结果），所以这里用
# 阶段完成（force 帧）来验真实改动数；节流本身的行为由下面的帧数断言覆盖。
ad.progress_tracker.complete_stage("改完一篇")

# ② 再新增两篇，再来一个 force 帧
(mods / "new-1.md").write_text("# new 1", encoding="utf-8")
(mods / "new-2.md").write_text("# new 2", encoding="utf-8")
ad.progress_tracker.start_stage(4, "Validation")

# ③ 记账文件不是文章，不能算进 written
(docs / "temp").mkdir(exist_ok=True)
(docs / "temp" / "update-record.json").write_text("{}", encoding="utf-8")
(docs / "temp" / "scratch.md").write_text("# 记账不是文章", encoding="utf-8")
ad.progress_tracker.complete_stage("完成")

pathlib.Path(${JSON.stringify(outFile)}).write_text(json.dumps({"frames": frames}, ensure_ascii=False), encoding="utf-8")
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `进度桥接探针失败：${raw.stderr}${raw.stdout}`)
  const frames = JSON.parse(readFileSync(outFile, 'utf8')).frames
  assert.ok(frames.length >= 4, `三个阶段方法都必须发进度帧：${JSON.stringify(frames)}`)
  assert.equal(frames[0].written, 0, `进场时那 2 篇都是上一轮的旧文章，本轮改动数必须是 0：${JSON.stringify(frames[0])}`)
  assert.equal(frames[1].written, 1, `原地改写 1 篇必须报 1（篇数净差为 0 也要认出来）：${JSON.stringify(frames[1])}`)
  assert.equal(frames[2].written, 3, `累计改写 1 篇 + 新增 2 篇 = 3，不是 docs 绝对篇数 4：${JSON.stringify(frames[2])}`)
  assert.equal(frames[3].written, 3, `记账文件不是文章，不能计入 written：${JSON.stringify(frames[3])}`)
})

await check('进度帧：普通 update 帧节流（不能让每帧都全树遍历拖慢编译）', async () => {
  // 节流的存在理由：writtenCount 靠递归遍历 docsDir，而 FSoft 进度条一秒能调好几次
  // update_stage。真机 45 分钟预算里若每帧都遍历数百篇，会把编译时间啃掉一块。
  // 但**不能**节流掉 force 帧（start/complete）——那是超时判 partial 的关键帧。
  const docs = join(sandbox, 'probe-throttle')
  mkdirSync(join(docs, 'modules'), { recursive: true })
  const outFile = join(sandbox, 'probe-throttle.json')
  const probe = `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry

docs = pathlib.Path(${JSON.stringify(docs)})

class Tracker:
    current_stage = 3
    stage_progress = 0.0
    def start_stage(self, stage, description=None):
        self.current_stage = stage
        self.stage_progress = 0.0
    def update_stage(self, progress, message=None):
        self.stage_progress = progress
    def complete_stage(self, message=None):
        self.stage_progress = 1.0

class Adapter:
    def __init__(self):
        self.progress_tracker = Tracker()

calls = {"fingerprints": 0}
real_fp = entry._doc_fingerprints
def counting_fp(p):
    calls["fingerprints"] += 1
    return real_fp(p)
entry._doc_fingerprints = counting_fp

frames = []
def spy(request_id, stage, percent, message="", written=0, failed=0, total=0):
    frames.append({"written": written})
entry.emit_progress = spy

ad = Adapter()
entry.bridge_progress(ad, "req-throttle", docs_dir=str(docs))
# 12 次紧凑的普通 update：节流生效时只该真正遍历少数几次
for i in range(12):
    ad.progress_tracker.update_stage(i / 12.0, "tick")
pathlib.Path(${JSON.stringify(outFile)}).write_text(
    json.dumps({"frames": len(frames), "traversals": calls["fingerprints"]}, ensure_ascii=False),
    encoding="utf-8",
)
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `节流探针失败：${raw.stderr}${raw.stdout}`)
  const got = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(got.frames, 12, `进度帧本身一篇都不能少（节流只影响计数，不影响上报）：${got.frames}`)
  assert.ok(got.traversals < got.frames, `紧凑 update 必须节流掉遍历：${got.traversals} 次遍历 / ${got.frames} 帧`)
})

// 崩溃抢救：中途失败时已写出的文章必须交付，不能整轮判 failed。
//
// 真机现场（job-mvu2lmd1-a）：引擎跑到阶段 3 的中途遇到
// `LLM returned empty content for dsh-codewiki overview (possible output
// truncation at max_tokens)`，那一轮 docsDir 里已经有成果，但旧的
// _classify_exception 一律走 failure()，writtenCount=0、artifacts 全空；
// native-run.js 对 failed 又是直接 settle 短路，不做原始树留档、不采集受管
// 状态 —— 于是下一轮增量因为没有持久化状态又退回全量，再跑一遍 174 分钟、
// 再撞同样的墙。这条用例钉的就是「别再扔了」。
await check('异常分类：中途崩溃时已写文章降 partial 交付，产物目录要带出去', async () => {
  const docs = mkdtempSync(join(tmpdir(), 'cw-salvage-'))
  const outFile = join(docs, 'salvage.json')
  const modules = join(docs, 'modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(join(modules, 'a.md'), '# A', 'utf8')
  writeFileSync(join(modules, 'b.md'), '# B', 'utf8')
  mkdirSync(join(docs, 'temp'), { recursive: true })
  writeFileSync(join(docs, 'temp', 'update-record.json'), '{}', 'utf8')

  const probe = [
    'import json, pathlib, sys',
    `sys.path.insert(0, ${JSON.stringify(join(HERE, 'lib', 'engine', 'python'))})`,
    'import entry',
    'exc = RuntimeError("LLM returned empty content for dsh-codewiki overview (possible output truncation at max_tokens)")',
    `res = entry._classify_exception(exc, "req-salvage", ${JSON.stringify(docs)}, ${JSON.stringify(docs)}, "2026-10-30T00:00:00Z", stage="articles")`,
    `pathlib.Path(${JSON.stringify(outFile)}).write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")`,
  ].join('\n')
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `抢救探针失败：${raw.stderr}${raw.stdout}`)
  const res = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(res.outcome, 'partial', `已写出文章时必须是 partial，实际 ${res.outcome}`)
  assert.equal(res.writtenCount, 2, `已写篇数必须如实上报（temp/ 下记账文件不算文章），实际 ${res.writtenCount}`)
  assert.ok(res.artifacts?.docsDir, '产物目录必须带出去，否则上层无处留档、也无法采集受管状态')
  assert.equal(res.error?.code, 'engine-crashed', `错误码仍要保留原始结局，实际 ${res.error?.code}`)
  assert.ok((res.blockers ?? []).length > 0, 'partial 必须带 blockers（契约不变量）')
  assert.equal(res.blockers[0].kind, 'article-failed', `blocker 要说明是文章阶段中断，实际 ${res.blockers[0].kind}`)
  rmSync(docs, { recursive: true, force: true })
})

// 上游 1b4af43 起：`_generate_modules_in_order` 在有模块失败时会 raise
// RuntimeError("Documentation failed for modules: a/b: boom; c: boom")。
// 这条分支的语义是「计划内文章没写成」，和「进程崩了」不是一回事：
// 已写的文章必须照样交付，blockers 还要点名缺哪些模块——否则面板只显示
// 一句笼统的「编译在 articles 阶段中断」，用户不知道该重跑哪一块。
await check('异常分类：上游模块失败异常要降 partial 并点名失败模块', async () => {
  const docs = mkdtempSync(join(tmpdir(), 'cw-modfail-'))
  const outFile = join(docs, 'modfail.json')
  mkdirSync(join(docs, 'modules'), { recursive: true })
  writeFileSync(join(docs, 'modules', 'ok.md'), '# ok', 'utf8')

  const probe = [
    'import json, pathlib, sys',
    `sys.path.insert(0, ${JSON.stringify(join(HERE, 'lib', 'engine', 'python'))})`,
    'import entry',
    'exc = RuntimeError("Documentation failed for modules: parent/kid: boom:kid; other: boom:other")',
    `res = entry._classify_exception(exc, "req-modfail", ${JSON.stringify(docs)}, ${JSON.stringify(docs)}, "2026-11-02T00:00:00Z", stage="articles")`,
    `pathlib.Path(${JSON.stringify(outFile)}).write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")`,
  ].join('\n')
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `模块失败探针失败：${raw.stderr}${raw.stdout}`)
  const res = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(res.outcome, 'partial', `已写文章时必须是 partial，实际 ${res.outcome}`)
  assert.equal(res.writtenCount, 1, `已写篇数要如实上报，实际 ${res.writtenCount}`)
  const kinds = (res.blockers ?? []).map((b) => b.kind)
  assert.ok(kinds.includes('article-missing'), `blockers 要标成文章缺失，实际 ${JSON.stringify(kinds)}`)
  const detail = (res.blockers ?? []).map((b) => String(b.detail ?? '')).join(' ')
  assert.match(detail, /parent\/kid/, `blockers 要点名失败模块，实际 ${detail}`)
  assert.match(detail, /other/, `blockers 要点名失败模块，实际 ${detail}`)
  rmSync(docs, { recursive: true, force: true })
})
await check('异常分类：一篇没写出来时仍是 failed，不许用空产物冒充 partial', async () => {
  const docs = mkdtempSync(join(tmpdir(), 'cw-salvage-empty-'))
  const outFile = join(docs, 'salvage-empty.json')
  const probe = [
    'import json, pathlib, sys',
    `sys.path.insert(0, ${JSON.stringify(join(HERE, 'lib', 'engine', 'python'))})`,
    'import entry',
    `res = entry._classify_exception(RuntimeError("boom"), "req-empty", ${JSON.stringify(docs)}, ${JSON.stringify(docs)}, "2026-10-30T00:00:00Z", stage="articles")`,
    `pathlib.Path(${JSON.stringify(outFile)}).write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")`,
  ].join('\n')
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `空产物探针失败：${raw.stderr}${raw.stdout}`)
  const res = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(res.outcome, 'failed', `零成果必须是 failed，实际 ${res.outcome}`)
  assert.equal(res.writtenCount, 0, `零成果不许报出篇数，实际 ${res.writtenCount}`)
  rmSync(docs, { recursive: true, force: true })
})

// 心跳：长阶段必须持续发帧，否则「慢」与「僵死」在面板上无法区分。
//
// 真机事故（0.16.9）：FSoft 阶段 3 内所有 update_stage 都在 `if self.verbose:`
// 里，而 entry.py 传的是 verbose=False —— 于是从 start_stage(3) 到
// complete_stage() 之间**一帧进度都不发**。真机上这一段能跑 40 分钟以上，
// Node 侧看不到任何 stdout，进度永远停在 percent_of(3, 0.0) = 54%，
// job.updatedAt 冻结，跟「进程已经挂了」长得一模一样；而调度闸门
// （parallelLimit 默认 1）又被它占着，后续仓库永远轮不到。
await check('心跳：长阶段无进度事件时也要持续发帧（否则「慢」与「僵死」无法区分）', async () => {
  const docs = join(sandbox, 'probe-heartbeat')
  mkdirSync(join(docs, 'modules'), { recursive: true })
  writeFileSync(join(docs, 'modules', 'a.md'), '# a\n')
  const outFile = join(sandbox, 'probe-heartbeat.json')
  const probe = `
import json, sys, pathlib, time
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry

# 把心跳间隔压到 0.08s，测试才不用真等 60 秒。心跳读模块级常量，改属性对线程可见。
entry._HEARTBEAT_SEC = 0.08

docs = pathlib.Path(${JSON.stringify(docs)})

class Tracker:
    current_stage = 0        # 还没进第一个阶段：此时不该发帧（map_stage 只认 1..5）
    stage_progress = 0.0
    def start_stage(self, stage, description=None):
        self.current_stage = stage
        self.stage_progress = 0.0
    def update_stage(self, progress, message=None):
        self.stage_progress = progress
    def complete_stage(self, message=None):
        self.stage_progress = 1.0

class Adapter:
    def __init__(self):
        self.progress_tracker = Tracker()
    def generate(self):
        # 模拟阶段 3：进入之后长时间什么都不上报（verbose=False 的真实形态）。
        # 中途真实写出一篇文章——心跳必须如实把这个进展带出去，否则上层看到的
        # 是「引擎活着但一篇没写」，无法判断它是不是在推进。
        self.progress_tracker.start_stage(3, "Documentation Generation")
        time.sleep(0.25)
        (docs / "modules" / "written-during-hang.md").write_text("# 心跳期间写出", encoding="utf-8")
        time.sleep(0.25)
        return "job"

frames = []
def spy(request_id, stage, percent, message="", written=0, failed=0, total=0):
    frames.append({"stage": stage, "percent": percent, "written": written, "message": message})
entry.emit_progress = spy

ad = Adapter()
entry.bridge_progress(ad, "req-hb", docs_dir=str(docs))
result = ad.generate()

pathlib.Path(${JSON.stringify(outFile)}).write_text(
    json.dumps({"frames": frames, "result": result}, ensure_ascii=False), encoding="utf-8"
)
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `心跳探针失败：${raw.stderr}${raw.stdout}`)
  const got = JSON.parse(readFileSync(outFile, 'utf8'))
  assert.equal(got.result, 'job', '包了心跳之后 generate 的返回值必须原样透出')
  const beats = got.frames.filter((f) => String(f.message).includes('引擎仍在运行'))
  assert.ok(beats.length >= 2, `0.5s 内按 0.08s 心跳必须有帧：${JSON.stringify(got.frames)}`)
  assert.ok(beats.every((f) => f.stage === 'articles'), `心跳必须报当前阶段（3 → articles）：${JSON.stringify(beats)}`)
  // 心跳期间真实写了一篇：帧里的篇数必须跟着变，不能恒 0（恒 0 等于「什么都没写」）
  assert.ok(beats.some((f) => f.written === 1), `心跳必须如实带出已写篇数：${JSON.stringify(beats)}`)
})

// 细节探针：把「已写 3 篇」补成「正在写 lib/engine/client.js」。
//
// FSoft 以 verbose=False 运行时把 `codewiki.src.be` 压到 WARNING，逐模块日志
// （documentation_generator.py:293 的 "Processing leaf module: X"）全被吞掉，
// 于是阶段 3 里桥接层只知道「已写 N 篇」，不知道「在写哪一篇」。真机上一轮
// 编译能卡在单个模块上几十分钟，这个信息量不足以区分「在推进」与「死了」。
await check('细节探针：逐模块日志要变成进度帧里的模块名（否则面板只有「已写 0 篇」）', async () => {
  const outFile = join(sandbox, 'probe-detail.json')
  const probe = `
import json, sys, pathlib, logging
sys.path.insert(0, ${JSON.stringify(dirname(ENTRY))})
import entry

# 复刻 FSoft 在 doc_generator.py:96-125 的配置：verbose=False 的形态
backend = logging.getLogger("codewiki.src.be")
backend.handlers.clear()
backend.setLevel(logging.WARNING)
stderr_handler = logging.StreamHandler(sys.stderr)
stderr_handler.setLevel(logging.WARNING)
backend.addHandler(stderr_handler)
backend.propagate = False

child = logging.getLogger("codewiki.src.be.documentation_generator")
steps = []

# 挂 tap 之前的 INFO 必须被吞掉（否则等于我们凭空改了日志级别）
child.info("Processing leaf module: should-not-appear")
steps.append({"phase": "before-tap", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

tap = entry.attach_detail_tap()
child.info("\\U0001f4c4 Processing leaf module: lib/engine/client.js")
steps.append({"phase": "leaf", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

child.info("\\U0001f4c1 Processing parent module: lib/engine")
steps.append({"phase": "parent", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

child.info("\\U0001f4da Generating repository overview")
steps.append({"phase": "overview", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

# 超长模块名不能在面板上挤爆
child.info("Processing leaf module: " + "x" * 200)
long_len = len(entry.detail_suffix())

# 阶段 2（cluster_modules.py）不逐模块打印，而是围绕当前子树发消息，
# label 就是子树名。真机阶段 2 能跑十几分钟，只报「阶段 2」等于没信息。
# 阶段 1（call_graph_analyzer.py:118）：每约十分之一文件打一条，是 graph 段
# 唯一真实可计数的进度。该段 update_stage 全在 verbose 门控里，不数这里就只能报 0%。
child.info("\U0001f4ca Parsing 36 source files (this may take a few minutes)...")
steps.append({"phase": "parse-start", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})
child.info("  [12/36] lib/engine/client.js (4.2s elapsed, ~8.1s remaining)")
steps.append({"phase": "parse-mid", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix(), "parsed": entry._DETAIL["parsed"], "total": entry._DETAIL["parsed_total"]})
child.info("  [35/36] lib/index.js (12.0s elapsed, ~0.3s remaining)")
steps.append({"phase": "parse-late", "suffix": entry.detail_suffix(), "parsed": entry._DETAIL["parsed"]})

child.info("Requesting LLM module clustering for lib/engine because 12000 tokens exceed the 8000-token threshold.")
steps.append({"phase": "cluster", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

child.info("Requesting super-grouping of 7 top-level modules into architectural subsystems.")
steps.append({"phase": "super-group", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

# 摘掉之后必须还原：level 回到 WARNING，INFO 重新被吞
entry.release_detail_tap(tap)
restored_level = logging.getLogger("codewiki.src.be").level
child.info("Processing leaf module: after-release")
steps.append({"phase": "after-release", "module": entry._DETAIL["module"], "suffix": entry.detail_suffix()})

pathlib.Path(${JSON.stringify(outFile)}).write_text(
    json.dumps({"steps": steps, "long_len": long_len, "restored_level": restored_level}, ensure_ascii=False),
    encoding="utf-8"
)
`
  const raw = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  assert.equal(raw.status, 0, `细节探针失败：${raw.stderr}${raw.stdout}`)
  const got = JSON.parse(readFileSync(outFile, 'utf8'))
  const by = (phase) => got.steps.find((s) => s.phase === phase)

  assert.equal(by('before-tap').module, '', `挂 tap 之前的 INFO 必须被吞掉：${JSON.stringify(by('before-tap'))}`)
  assert.equal(by('leaf').module, 'lib/engine/client.js', `叶子模块名必须解析出来：${JSON.stringify(by('leaf'))}`)
  assert.ok(by('leaf').suffix.includes('lib/engine/client.js'), `进度帧后缀必须带模块名：${by('leaf').suffix}`)
  assert.equal(by('parent').module, 'lib/engine', `父模块名必须解析出来：${JSON.stringify(by('parent'))}`)
  assert.ok(by('overview').suffix.includes('总览'), `总览阶段没有模块名，也必须能看见：${JSON.stringify(by('overview'))}`)
  assert.ok(got.long_len <= 90, `超长模块名必须截断，实际 ${got.long_len}`)
  assert.equal(by('cluster').module, 'lib/engine', `阶段 2 的子树名必须抽出来：${JSON.stringify(by('cluster'))}`)
  assert.ok(by('cluster').suffix.includes('聚类'), `阶段 2 措辞必须是「正在聚类」（不是「正在写」）：${by('cluster').suffix}`)
  assert.ok(by('super-group').suffix.includes('归并'), `子系统归并阶段必须能看见：${JSON.stringify(by('super-group'))}`)
  // 只知道总数、还不知道进度：如实报 0/N，不编造比例，也不能沿用上一阶段的模块名
  assert.equal(by('parse-start').module, '', `进入解析阶段必须清掉上一阶段的模块名：${JSON.stringify(by('parse-start'))}`)
  assert.ok(by('parse-start').suffix.includes('0/36'), `只知总数时应报 0/36：${by('parse-start').suffix}`)
  assert.equal(by('parse-mid').parsed, 12, `必须从 [12/36] 抽出已解析数：${JSON.stringify(by('parse-mid'))}`)
  assert.equal(by('parse-mid').total, 36, `必须从 [12/36] 抽出总数：${JSON.stringify(by('parse-mid'))}`)
  assert.ok(by('parse-mid').suffix.includes('12/36'), `进度帧必须带「已解析 12/36」：${by('parse-mid').suffix}`)
  assert.equal(by('parse-late').parsed, 35, `尾部一条应当覆盖前一条：${JSON.stringify(by('parse-late'))}`)
  assert.equal(got.restored_level, 30, `摘掉 tap 必须把 level 还原成 WARNING，实际 ${got.restored_level}`)
  assert.equal(by('after-release').module, '', `摘掉 tap 之后不能再改状态：${JSON.stringify(by('after-release'))}`)
})

// ── 收尾 ──────────────────────────────────────────────────────────────────

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 上占用是常事，临时目录会自动回收 */ }

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n[${f.label}]\n${f.err.stack || f.err.message}`)
  process.exit(1)
}
