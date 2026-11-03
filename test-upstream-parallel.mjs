// 上游模块并行（0.16.14）的行为测试。
//
// 背景：`.probe-fsoft/src/codewiki/src/be/documentation_generator.py` 的
// `_generate_modules_in_order` 原本是严格串行的
// `for module_path, module_name in processing_order: await ...`。
// 真机 job-mvuf1c5b-5 因此跑满 180 分钟预算只写出 18 篇被判失败
// （单篇约 12 分钟 = 15–20 次 LLM 请求，含 3–4 次 3–5 分钟长思考）。
//
// 改成按拓扑层并行后，这里钉的是**正确性**而不是速度：
//   · 同层模块必须真的并发（否则只是串行换皮）
//   · 父模块必须等子模块全部完成（拓扑序不能被并行破坏）
//   · 并行分支各自新增的子模块必须都合并回主树（共享状态不互相覆盖）
//   · module_concurrency=1 必须退化为串行（向后兼容）
//   · 单个模块失败不能拖垮同批其它模块
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// worktree 里没有 gitignored 的 .probe-fsoft：向上找主仓库的 vendor
function vendorRoot() {
  const candidates = [process.env.DSH_CODEWIKI_VENDOR_ROOT, join(HERE, '.probe-fsoft')]
  let dir = HERE
  for (let i = 0; i < 5; i++) {
    dir = resolve(dir, '..')
    candidates.push(join(dir, '.probe-fsoft'))
  }
  return candidates.find((d) => d && existsSync(join(d, 'venv', 'Scripts', 'python.exe'))) || ''
}
const VENDOR = vendorRoot()
const PY = process.env.DSH_CODEWIKI_ENGINE_PYTHON || join(VENDOR, 'venv', 'Scripts', 'python.exe')
if (!existsSync(PY)) {
  console.error(`FAIL 找不到原生引擎解释器；请设置 DSH_CODEWIKI_ENGINE_PYTHON 或 DSH_CODEWIKI_VENDOR_ROOT`)
  process.exit(1)
}

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const sandbox = mkdtempSync(join(tmpdir(), 'cw-upstream-parallel-'))
const probe = join(sandbox, 'probe.py')
const outFile = join(sandbox, 'result.json')

// 探针驱动真实上游类，只把 backend 换成记录事件的可控实现。
// 结果写文件而不是 print：entry.py 式的 stdout 协议替身不在这里，
// 但写文件能避开 Windows 控制台 cp936 的中文/emoji 编码坑。
writeFileSync(probe, String.raw`
import asyncio, json, os, sys, time
from pathlib import Path

REPO = sys.argv[1]
OUT = sys.argv[2]
sys.path.insert(0, os.path.join(os.environ["DSH_CODEWIKI_VENDOR_ROOT"], 'src'))
sys.path.insert(0, os.path.join(REPO, 'lib', 'engine', 'python'))
import full_parallel_runtime as PAR
PAR.install_full_runtime(2)

from codewiki.src.be.documentation_generator import DocumentationGenerator
from codewiki.src.utils import file_manager

WORK = Path(OUT) / 'work'
WORK.mkdir(parents=True, exist_ok=True)


class FakeBackend:
    def __init__(self, delay=0.2, fail=()):
        self.delay = delay
        self.fail = set(fail)
        self.events = []
        self.inflight = 0
        self.max_inflight = 0

    async def run_module_agent(self, module_name, components, core_component_ids,
                               module_path, working_dir):
        key = '/'.join(module_path)
        if module_name in self.fail:
            raise RuntimeError('boom:' + module_name)
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        self.events.append(['start', key, time.time()])
        try:
            tree_path = os.path.join(working_dir, 'module_tree.json')
            tree = file_manager.load_json(tree_path)
            node = tree
            for part in module_path:
                node = node[part]
                if part != module_path[-1]:
                    node = node.get('children', {})
            # 真实 agent 的读与写在 LLM 调用两侧，中间有 await：两个并行分支
            # 会双双读到同一份旧树，再各自写回，后写者覆盖先写者。这里必须
            # 复现这个间隔，否则「共享树合并」根本没被测到。
            await asyncio.sleep(self.delay / 2)
            if module_name.startswith('complex'):
                node.setdefault('children', {})[module_name + '_sub'] = {
                    'components': [], 'children': {}}
            file_manager.save_json(tree, tree_path)
            await asyncio.sleep(self.delay / 2)
            Path(working_dir, module_name + '.md').write_text('# ' + key, encoding='utf-8')
            self.events.append(['end', key, time.time()])
            return tree
        finally:
            self.inflight -= 1


async def drive(tree, concurrency, backend):
    work = WORK / ('c%d-%d' % (concurrency, time.time_ns()))
    work.mkdir(parents=True, exist_ok=True)
    file_manager.save_json(tree, str(work / 'module_tree.json'))
    gen = DocumentationGenerator.__new__(DocumentationGenerator)
    gen.config = type('C', (), {'module_concurrency': concurrency,
                                'repo_path': REPO, 'layout': 'hierarchical'})()
    gen.backend = backend
    gen.commit_id = 'test'

    global LAST_WORK
    LAST_WORK = work

    async def fake_parent(module_path, working_dir, components=None):
        key = '/'.join(module_path) or 'ROOT'
        backend.events.append(['start', 'PARENT:' + key, time.time()])
        await asyncio.sleep(0.02)
        backend.events.append(['end', 'PARENT:' + key, time.time()])
        return file_manager.load_json(os.path.join(working_dir, 'module_tree.json'))
    gen.generate_parent_module_docs = fake_parent

    order = gen.get_processing_order(tree)
    await gen._generate_modules_in_order(
        components={}, leaf_nodes=[], working_dir=str(work),
        module_tree_path=os.path.join(str(work), 'module_tree.json'),
        module_tree=tree, processing_order=order)
    return file_manager.load_json(os.path.join(str(work), 'module_tree.json')), [
        p.name for p in work.glob('*.md')]


FLAT = {
    'alpha': {'components': [], 'children': {}},
    'beta': {'components': [], 'children': {}},
    'gamma': {'components': [], 'children': {}},
}
NESTED = {'parent': {'components': [], 'children': {
    'kid_a': {'components': [], 'children': {}},
    'kid_b': {'components': [], 'children': {}},
}}}
COMPLEX = {
    'complex_a': {'components': [], 'children': {}},
    'complex_b': {'components': [], 'children': {}},
}


LAST_WORK = None


def work_dir_after_failure():
    return LAST_WORK if LAST_WORK is not None else Path(OUT)


async def main():
    out = {}

    b = FakeBackend(delay=0.3)
    t0 = time.time()
    PAR.configure_full_runtime(3)
    await drive(FLAT, 3, b)
    out['parallel'] = {'elapsed': time.time() - t0, 'max_inflight': b.max_inflight}

    b = FakeBackend(delay=0.2)
    t0 = time.time()
    PAR.configure_full_runtime(1)
    await drive(FLAT, 1, b)
    out['serial'] = {'elapsed': time.time() - t0, 'max_inflight': b.max_inflight}
    PAR.configure_full_runtime(2)

    b = FakeBackend(delay=0.15)
    await drive(NESTED, 4, b)
    out['nested_events'] = b.events

    b = FakeBackend(delay=0.1)
    final, _ = await drive(COMPLEX, 2, b)
    out['merged'] = {
        'a_sub': 'complex_a_sub' in final.get('complex_a', {}).get('children', {}),
        'b_sub': 'complex_b_sub' in final.get('complex_b', {}).get('children', {}),
    }

    # 上游 1b4af43 起：有模块失败就 raise（过去只 logger.error 后继续，
    # 终态看起来是成功）。探针要同时拿到「抛了什么」与「已写的页面还在不在」。
    b = FakeBackend(delay=0.05, fail=('beta',))
    failure_error = None
    try:
        _, written = await drive(FLAT, 3, b)
    except RuntimeError as exc:
        failure_error = str(exc)
        written = [p.name for p in work_dir_after_failure().glob('*.md')]
    out['after_failure'] = {'written': sorted(written), 'error': failure_error}

    # 空模块树 = 仓库小到能整个塞进上下文，上游必须走 else 分支，
    # 把整仓当一个模块来写（否则一篇文章都不会产出）。
    b = FakeBackend(delay=0.05)
    _, empty_written = await drive({}, 2, b)
    out['empty_tree'] = {'events': len(b.events), 'written': sorted(empty_written)}

    Path(OUT, 'result.json').write_text(
        json.dumps(out, ensure_ascii=False), encoding='utf-8')


asyncio.run(main())
`, 'utf-8')

await check('并行探针能在真 venv 上跑完', () => {
  const r = spawnSync(PY, [probe, HERE, sandbox], { encoding: 'utf-8', timeout: 120000, env: { ...process.env, DSH_CODEWIKI_VENDOR_ROOT: VENDOR } })
  if (r.status !== 0) console.error(r.stderr?.slice(-2000) || r.error)
  assert.equal(r.status, 0, `探针失败：${r.stderr?.slice(-1500)}`)
})
if (!existsSync(outFile)) { console.error('探针没有写出结果，终止'); process.exit(1) }

const got = JSON.parse(readFileSync(outFile, 'utf-8'))

await check('同层叶子模块真的并行（max_inflight > 1）', () => {
  // 只断言峰值并发，不用墙钟：CI 机器慢时墙钟断言会变成假失败。
  assert.ok(got.parallel.max_inflight >= 2,
    `并发度 3 时峰值并发至少 2，实际 ${got.parallel.max_inflight}`)
})

await check('module_concurrency=1 仍是严格串行（向后兼容）', () => {
  assert.equal(got.serial.max_inflight, 1, '并发度 1 时峰值并发必须是 1')
})

await check('父模块必须等全部子模块完成（拓扑序不被并行破坏）', () => {
  const kidEnds = got.nested_events
    .filter(([k, n]) => k === 'end' && n.startsWith('parent/kid')).map(([, , t]) => t)
  const parentStarts = got.nested_events
    .filter(([k, n]) => k === 'start' && n === 'PARENT:parent').map(([, , t]) => t)
  assert.ok(kidEnds.length >= 2, `两个子模块都要跑完：${JSON.stringify(got.nested_events)}`)
  assert.equal(parentStarts.length, 1, '父模块必须跑一次')
  assert.ok(Math.min(...parentStarts) >= Math.max(...kidEnds),
    '父模块开始时刻必须晚于最后一个子模块结束时刻')
})

await check('并行分支新增的子模块都合并回主树（不互相覆盖）', () => {
  assert.equal(got.merged.a_sub, true, 'complex_a 的子模块丢失')
  assert.equal(got.merged.b_sub, true, 'complex_b 的子模块丢失')
})

await check('空模块树时必须走 else 分支写整仓总览（不能被并行改造吞掉）', () => {
  assert.ok(got.empty_tree.events > 0,
    '空模块树时 backend 一次都没被调用 —— else 分支丢了，这类仓库将一篇文章都写不出来')
  assert.ok(got.empty_tree.written.includes('overview.md'),
    `空模块树时必须产出 overview.md，实际只写了 ${JSON.stringify(got.empty_tree.written)}`)
})

await check('单个模块失败：已写页面保留，失败模块进异常消息', () => {
  assert.ok(got.after_failure.written.includes('alpha.md'), 'alpha 应正常产出')
  assert.ok(got.after_failure.written.includes('gamma.md'), 'gamma 应正常产出')
  assert.ok(!got.after_failure.written.includes('beta.md'), 'beta 失败不该有产物')
  // 上游 1b4af43 起有模块失败就 raise；并行补丁必须把 gather 里的 err 也
  // 记进 failures，否则并行化会把这条判据悄悄吃掉。
  assert.match(String(got.after_failure.error), /Documentation failed for modules/,
    `应抛出上游的失败异常，实际 ${got.after_failure.error}`)
  assert.match(String(got.after_failure.error), /beta/, '异常消息应点名失败模块')
})

// 并行度必须有自己的设置项，默认 1。
// 0.16.14 初版把它写成 `moduleConcurrency: c.maxConcurrency`，而 maxConcurrency
// 是 LLM 请求并发、默认 2 —— 于是「默认等于上游串行」的承诺当场落空，
// 所有既有用户升级后立刻变并行。这条钉住那个语义边界。
await check('并行度是独立设置项（0=跟随默认档并发，1=上游串行）', () => {
  const src = readFileSync(join(HERE, 'index.js'), 'utf8')
  const decl = src.match(/moduleConcurrency:\s*z\.number\(\)\.default\((\d+)\)/)
  assert.ok(decl, 'index.js 里找不到 moduleConcurrency 的设置项声明')
  assert.equal(Number(decl[1]), 0,
    `moduleConcurrency 默认值必须是 0（跟随默认档并发，与 bigConcurrency 同约定），实际 ${decl[1]}`)
  // 必须是独立配置键：0 时才回落到 maxConcurrency，显式填 1 必须能真的退化成串行。
  assert.ok(/moduleConcurrency:\s*c\.moduleConcurrency\s*\|\|\s*c\.maxConcurrency/.test(src),
    'moduleConcurrency 必须读自己的配置键、为 0 时才回落到 maxConcurrency —— 直接写 c.maxConcurrency 会让「填 1 = 串行」失效')
})

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) process.exitCode = 1
