// FSoft 增量运行时适配：真实并行与叶子级断点续跑。
// 用真 venv + 真 UpdateRecord/UpdateOptions；runner 是假的，以便精确制造写冲突和进程中断。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// worktree 里没有 gitignored 的 .probe-fsoft；解析主仓库的 vendor 路径
function findVendorRoot() {
  const candidates = [
    process.env.DSH_CODEWIKI_VENDOR_ROOT,
    join(HERE, '.probe-fsoft'),
    resolve(HERE, '..', '..', '..', '..', '.probe-fsoft'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const py = join(dir, 'venv', 'Scripts', 'python.exe')
    if (existsSync(py)) return dir
  }
  return null
}
const VENDOR = findVendorRoot()
const PY = process.env.DSH_CODEWIKI_ENGINE_PYTHON || (VENDOR ? join(VENDOR, 'venv', 'Scripts', 'python.exe') : null)
if (!PY || !existsSync(PY)) {
  console.error(`FAIL 找不到原生引擎解释器；请设置 DSH_CODEWIKI_ENGINE_PYTHON 或 DSH_CODEWIKI_VENDOR_ROOT`)
  process.exit(1)
}
const sandbox = mkdtempSync(join(tmpdir(), 'cw-fsoft-runtime-'))
const script = join(sandbox, 'cases.py')
writeFileSync(script, String.raw`
import asyncio
import copy
import hashlib
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, ${JSON.stringify(join(HERE, 'lib', 'engine', 'python'))})
import fsoft_runtime as R
from codewiki.src.be.dependency_analyzer.models.core import Node
from codewiki.src.be.updater.options import UpdateOptions
from codewiki.src.be.updater.record import UpdateRecord

logging.basicConfig(level=logging.CRITICAL)
results = []

def check(name, fn):
    try:
        fn()
        results.append({'name': name, 'ok': True})
    except Exception as exc:
        results.append({'name': name, 'ok': False, 'error': f'{type(exc).__name__}: {exc}', 'trace': traceback.format_exc()})

class Report:
    def __init__(self, path, roles, mode='edit'):
        self.leaf_path = tuple(path)
        self.page = path[-1]
        self.mode = mode
        self.roles = roles

class Updater:
    def __init__(self, docs, concurrency=3, resume=False):
        self.docs_dir = str(docs)
        self.config = SimpleNamespace(docs_dir=str(docs), repo_path=str(docs), get_prompt_addition=lambda: '')
        self.backend = object()
        self.opts = UpdateOptions(extra={'moduleConcurrency': concurrency, 'resume': resume})
        self.record = UpdateRecord(options=self.opts.to_dict(), revision={'new': 'rev1'})
        self.record.diff = {'counts': {'changed': 1}}
        self.whole_repo = False
        self._deleted_nodes = []
    def _write_roles(self, report, new_tree, dep, inv):
        return dict(report.roles)

class FakeRunner:
    active = 0
    max_active = 0
    attempts = {}
    conflict = set()
    crash_on = None
    delay = 0.08

    def __init__(self, config, backend, docs_dir, graph, tree, diff, opts, record):
        self.docs_dir = docs_dir
        self.record = record

    async def run(self, report, roles, component_ids):
        name = report.page
        self.record.write_sets[name] = sorted(roles)
        type(self).attempts[name] = type(self).attempts.get(name, 0) + 1
        type(self).active += 1
        type(self).max_active = max(type(self).max_active, type(self).active)
        try:
            await asyncio.sleep(type(self).delay)
            if type(self).crash_on == name and type(self).attempts[name] == 1:
                raise KeyboardInterrupt('simulated host loss')
            path = Path(self.docs_dir) / f'{name}.md'
            prior = path.read_text(encoding='utf-8') if path.exists() else ''
            path.write_text(prior + name, encoding='utf-8')
            self.record.pages_written.append(name)
            if name in type(self).conflict:
                overview = Path(self.docs_dir) / 'overview.md'
                old = overview.read_text(encoding='utf-8') if overview.exists() else ''
                overview.write_text(old + name, encoding='utf-8')
                self.record.pages_written.append('overview')
        finally:
            type(self).active -= 1

R.LeafAgentRunner = FakeRunner

def install_case():
    R.install_incremental_runtime()
    assert getattr(R.IncrementalUpdater._run, '__dsh_runtime__', False), 'Step 5 适配没有安装'
check('生产安装锚点匹配真实 FSoft 源码', install_case)

def graph():
    return {k: Node(id=k, name=k, component_type='function', file_path=f'{k}.py', relative_path=f'{k}.py', source_code=k) for k in ('a', 'b', 'c')}

def tree():
    return {'name': 'root', 'components': [], 'children': {k: {'name': k, 'components': [k], 'children': {}} for k in ('a', 'b', 'c')}}

def reports(conflict=()):
    return {(k,): Report((k,), {k: ['leaf'], 'overview': ['ancestor']}) for k in ('a', 'b', 'c')}

def docs_fixture():
    root = Path(tempfile.mkdtemp(prefix='cw-runtime-case-'))
    (root / 'overview.md').write_text('base', encoding='utf-8')
    for k in ('a', 'b', 'c'):
        (root / f'{k}.md').write_text('base', encoding='utf-8')
    return root

async def run_once(updater, reps):
    await R.run_leaf_order(updater, list(reps), reps, tree(), graph(), list(graph()))

def reset():
    FakeRunner.active = 0
    FakeRunner.max_active = 0
    FakeRunner.attempts = {}
    FakeRunner.conflict = set()
    FakeRunner.crash_on = None

def parallel_case():
    reset()
    root = docs_fixture()
    try:
        u = Updater(root, concurrency=3)
        asyncio.run(run_once(u, reports()))
        assert FakeRunner.max_active >= 2, f'没有发生并行：{FakeRunner.max_active}'
        assert not R.checkpoint_path(root).exists(), '成功后必须清 checkpoint'
        assert set(u.record.pages_written) == {'a', 'b', 'c'}
    finally:
        shutil.rmtree(root)
check('独立叶子真实并行，成功后清理 checkpoint', parallel_case)

def cross_batch_case():
    reset()
    root = docs_fixture()
    try:
        u = Updater(root, concurrency=2)
        reps = reports()
        reps[('d',)] = Report(('d',), {'d': ['leaf']})
        asyncio.run(run_once(u, reps))
        assert FakeRunner.attempts == {'a': 1, 'b': 1, 'c': 1, 'd': 1}, f'前一批页面被误判为冲突并重跑：{FakeRunner.attempts}'
        assert not u.record.errors, f'独立叶子不应串行重跑：{u.record.errors}'
        for name in ('a', 'b', 'c'):
            assert (root / f'{name}.md').read_text(encoding='utf-8') == f'base{name}'
    finally:
        shutil.rmtree(root)
check('后续批次只检测本叶子真实写页，不误判历史页面', cross_batch_case)

def conflict_case():
    reset()
    FakeRunner.conflict = {'a', 'b'}
    root = docs_fixture()
    try:
        u = Updater(root, concurrency=3)
        asyncio.run(run_once(u, reports()))
        assert FakeRunner.attempts['a'] == 1
        assert FakeRunner.attempts['b'] == 2, f'冲突叶子必须在合并后的现场重跑：{FakeRunner.attempts}'
        text = (root / 'overview.md').read_text(encoding='utf-8')
        assert text.endswith('ab'), f'后序冲突叶子必须看到前序写入：{text}'
    finally:
        shutil.rmtree(root)
check('真实写冲突按原顺序重跑，不丢失共享页更新', conflict_case)

def resume_case():
    reset()
    FakeRunner.crash_on = 'b'
    root = docs_fixture()
    try:
        u1 = Updater(root, concurrency=1)
        try:
            asyncio.run(run_once(u1, reports()))
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError('模拟宿主中断没有发生')
        assert R.checkpoint_path(root).exists(), '中断后必须留下 checkpoint'
        assert FakeRunner.attempts['a'] == 1
        reset()
        u2 = Updater(root, concurrency=1, resume=True)
        asyncio.run(run_once(u2, reports()))
        assert FakeRunner.attempts == {'b': 1, 'c': 1}, f'已完成叶子被重跑：{FakeRunner.attempts}'
        assert u2.record.pages_written.count('a') == 1, '恢复的记录必须合并且不能重复'
        assert not R.checkpoint_path(root).exists()
    finally:
        shutil.rmtree(root)
check('宿主中断后只跑未完成叶子，并恢复记录', resume_case)

def drift_case():
    reset()
    root = docs_fixture()
    try:
        R.write_checkpoint(root, 'old-signature', {'a': {'calls': [], 'verdicts': [], 'pages_written': ['a'], 'pages_removed': [], 'write_set_violations': [], 'detector_notes': [], 'errors': [], 'write_sets': {'a': ['a']}}})
        (root / 'a.md').write_text('interrupted partial edit', encoding='utf-8')
        baseline = Path(tempfile.mkdtemp(prefix='cw-runtime-baseline-'))
        try:
            (baseline / 'overview.md').write_text('base', encoding='utf-8')
            for name in ('a', 'b', 'c'):
                (baseline / f'{name}.md').write_text('base', encoding='utf-8')
            u2 = Updater(root, concurrency=1, resume=True)
            u2.opts.extra['resumeBaselineDocsDir'] = str(baseline)
            asyncio.run(run_once(u2, reports()))
            assert FakeRunner.attempts == {'a': 1, 'b': 1, 'c': 1}, '签名漂移时不得复用旧 checkpoint'
            assert (root / 'a.md').read_text(encoding='utf-8') == 'basea', '签名漂移后必须先恢复受管基线，不能保留半截页面'
        finally:
            shutil.rmtree(baseline)
    finally:
        shutil.rmtree(root)
check('签名漂移拒绝复用旧 checkpoint', drift_case)

print(json.dumps(results, ensure_ascii=False))
`, 'utf8')

const proc = spawnSync(PY, [script], { encoding: 'utf8', timeout: 120000 })
try {
  if (proc.status !== 0) throw new Error(`Python 退出 ${proc.status}\n${proc.stdout}\n${proc.stderr}`)
  const results = JSON.parse(String(proc.stdout).trim().split('\n').at(-1))
  let failed = 0
  for (const r of results) {
    if (r.ok) console.log(`PASS  ${r.name}`)
    else { failed++; console.log(`FAIL  ${r.name}\n      ${r.error}\n${r.trace}`) }
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
