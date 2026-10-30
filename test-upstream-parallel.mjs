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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PY = join(HERE, '.probe-fsoft', 'venv', 'Scripts', 'python.exe')
const DOC_GEN = join(HERE, '.probe-fsoft', 'src', 'codewiki', 'src', 'be', 'documentation_generator.py')

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
sys.path.insert(0, os.path.join(REPO, '.probe-fsoft', 'src'))

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
            # 模拟复杂叶子的子模块递归：往自己的树副本里加 children
            if module_name.startswith('complex'):
                node.setdefault('children', {})[module_name + '_sub'] = {
                    'components': [], 'children': {}}
            file_manager.save_json(tree, tree_path)
            await asyncio.sleep(self.delay)
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


async def main():
    out = {}

    b = FakeBackend(delay=0.3)
    t0 = time.time()
    await drive(FLAT, 3, b)
    out['parallel'] = {'elapsed': time.time() - t0, 'max_inflight': b.max_inflight}

    b = FakeBackend(delay=0.2)
    t0 = time.time()
    await drive(FLAT, 1, b)
    out['serial'] = {'elapsed': time.time() - t0, 'max_inflight': b.max_inflight}

    b = FakeBackend(delay=0.15)
    await drive(NESTED, 4, b)
    out['nested_events'] = b.events

    b = FakeBackend(delay=0.1)
    final, _ = await drive(COMPLEX, 2, b)
    out['merged'] = {
        'a_sub': 'complex_a_sub' in final.get('complex_a', {}).get('children', {}),
        'b_sub': 'complex_b_sub' in final.get('complex_b', {}).get('children', {}),
    }

    b = FakeBackend(delay=0.05, fail=('beta',))
    _, written = await drive(FLAT, 3, b)
    out['after_failure'] = sorted(written)

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
  const r = spawnSync(PY, [probe, HERE, sandbox], { encoding: 'utf-8', timeout: 120000 })
  assert.equal(r.status, 0, `探针失败：${r.stderr?.slice(-1500)}`)
})

const got = JSON.parse(readFileSync(outFile, 'utf-8'))

await check('同层模块真的并行（不是串行换皮）', () => {
  assert.ok(got.parallel.max_inflight >= 2,
    `峰值并发必须 >=2，实际 ${got.parallel.max_inflight}`)
  assert.ok(got.parallel.elapsed < 0.85,
    `3 个 0.3s 模块并行应 <0.85s，实际 ${got.parallel.elapsed.toFixed(2)}s`)
})

await check('module_concurrency=1 退化为串行（向后兼容）', () => {
  assert.equal(got.serial.max_inflight, 1, '并发度 1 时峰值并发必须是 1')
  assert.ok(got.serial.elapsed >= 0.6,
    `3 个 0.2s 模块串行应 >=0.6s，实际 ${got.serial.elapsed.toFixed(2)}s`)
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

await check('单个模块失败不拖垮同批其它模块', () => {
  assert.ok(got.after_failure.includes('alpha.md'), 'alpha 应正常产出')
  assert.ok(got.after_failure.includes('gamma.md'), 'gamma 应正常产出')
  assert.ok(!got.after_failure.includes('beta.md'), 'beta 失败不该有产物')
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
