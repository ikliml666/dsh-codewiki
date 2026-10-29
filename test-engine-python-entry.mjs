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

// ── 收尾 ──────────────────────────────────────────────────────────────────

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 上占用是常事，临时目录会自动回收 */ }

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n[${f.label}]\n${f.err.stack || f.err.message}`)
  process.exit(1)
}
