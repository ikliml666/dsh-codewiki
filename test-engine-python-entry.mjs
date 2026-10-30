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

// ── 收尾 ──────────────────────────────────────────────────────────────────

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 上占用是常事，临时目录会自动回收 */ }

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n[${f.label}]\n${f.err.stack || f.err.message}`)
  process.exit(1)
}
