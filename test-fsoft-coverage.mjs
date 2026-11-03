// FSoft 增量运行时适配：树里未收录的文件必须被补挂，否则每轮 Step 6.1 的
// validate_module_file_coverage 都会抛错且永不消失。
// 用真 venv + 真 module_scope/tree 工具；树与图都是构造的最小样本。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
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
  console.error('FAIL 找不到原生引擎解释器；请设置 DSH_CODEWIKI_ENGINE_PYTHON 或 DSH_CODEWIKI_VENDOR_ROOT')
  process.exit(1)
}

const sandbox = mkdtempSync(join(tmpdir(), 'cw-fsoft-coverage-'))
const script = join(sandbox, 'cases.py')
writeFileSync(script, String.raw`
import json
import logging
import os
import sys
import traceback

sys.path.insert(0, ${JSON.stringify(join(HERE, 'lib', 'engine', 'python'))})
import fsoft_runtime as R
from codewiki.src.be.dependency_analyzer.models.core import Node
from codewiki.src.be.module_scope import module_file_owners, validate_module_file_coverage

logging.basicConfig(level=logging.CRITICAL)
results = []

def check(name, fn):
    try:
        fn()
        results.append({'name': name, 'ok': True})
    except Exception as exc:
        results.append({'name': name, 'ok': False, 'error': f'{type(exc).__name__}: {exc}', 'trace': traceback.format_exc()})

def node(rel, name, ctype='class', depends_on=None):
    cid = f'{rel}::{name}'
    return cid, Node(
        id=cid,
        name=name,
        component_type=ctype,
        file_path=rel,
        relative_path=rel,
        start_line=1,
        end_line=2,
        source_code=f'class {name}: pass',
        depends_on=depends_on or [],
        language='python',
    )

def graph(*specs):
    return dict((cid, n) for cid, n in specs)

def tree_of(mapping):
    """mapping: {'a/b': ['x.py', 'y.py']} -> 一层树，每个叶子一个模块名。"""
    tree = {}
    for module, comps in mapping.items():
        tree[module] = {'components': list(comps), 'children': {}}
    return tree

# 树里有 a/x.py 的归属，但 b/y.py 的文件从未被收录（模拟历史遗留文件）。
X = dict([node('a/x.py', 'X')])
Y = dict([node('b/y.py', 'Y1'), node('b/y.py', 'Y2')])
G1 = {**X, **Y}
T1 = tree_of({'mod_x': list(X)})

def case_adopts_missing_file():
    tree = json.loads(json.dumps(T1))
    assert module_file_owners(tree, G1).keys() == {'a/x.py'}, module_file_owners(tree, G1)
    adopted = R.adopt_unowned_files(tree, G1)
    assert adopted == ['b/y.py'], adopted
    assert 'b/y.py' in module_file_owners(tree, G1), module_file_owners(tree, G1)
    # 补挂之后上游校验必须通过
    validate_module_file_coverage(tree, G1)
    # 原叶子仍然只保留自己的组件，新组件挂在同一叶子上
    assert 'mod_x' in tree
    assert R.file_owner(tree, G1, 'b/y.py') == 'mod_x', R.file_owner(tree, G1, 'b/y.py')

def case_no_missing_is_noop():
    tree = json.loads(json.dumps(T1))
    graph_x = dict(X)
    before = json.dumps(tree, sort_keys=True)
    adopted = R.adopt_unowned_files(tree, graph_x)
    assert adopted == [], adopted
    assert json.dumps(tree, sort_keys=True) == before
    validate_module_file_coverage(tree, graph_x)

def case_empty_tree_left_alone():
    """空树是上游整仓单页模式，没有叶子可挂，补挂必须原样放过。"""
    tree = {}
    assert R.adopt_unowned_files(tree, G1) == []
    assert tree == {}

def case_unrelated_leaf_fallback():
    """没有任何同文件/同目录/邻居线索时，挂到目录最接近的已有叶子，而不是放任缺失。"""
    g = {
        **dict([node('deep/nested/only.py', 'Only')]),
        **dict([node('other/place/lonely.py', 'Lonely')]),
    }
    tree = tree_of({'mod_only': ['deep/nested/only.py::Only']})
    adopted = R.adopt_unowned_files(tree, g)
    assert adopted == ['other/place/lonely.py'], adopted
    validate_module_file_coverage(tree, g)
    assert R.file_owner(tree, g, 'other/place/lonely.py') == 'mod_only'

def case_same_directory_preferred():
    """同目录已有叶子优先（route_by_rules 规则 2）。"""
    g = {
        **dict([node('p/one.py', 'One')]),
        **dict([node('p/two.py', 'Two')]),
        **dict([node('q/far.py', 'Far')]),
    }
    tree = tree_of({'mod_one': ['p/one.py::One'], 'mod_far': ['q/far.py::Far']})
    adopted = R.adopt_unowned_files(tree, g)
    assert 'p/two.py' in adopted, adopted
    assert R.file_owner(tree, g, 'p/two.py') == 'mod_one', R.file_owner(tree, g, 'p/two.py')
    validate_module_file_coverage(tree, g)
def case_exclusive_write_supersedes_subset():
    # 补挂算出的目标树是磁盘树的超集：直接合并会被叶子判据当成归属冲突。
    import tempfile
    from codewiki.src.utils import file_manager
    from full_parallel_runtime import install_full_runtime, write_tree_exclusive
    install_full_runtime(1)
    docs = tempfile.mkdtemp(prefix='cw-tree-lock-')
    tree_path = os.path.join(docs, 'module_tree.json')
    file_manager.save_json({'leaf': {'components': ['a/x.py::X'], 'children': {}}}, tree_path)
    try:
        file_manager.save_json({'leaf': {'components': ['a/x.py::X', 'b/y.py::Y'], 'children': {}}}, tree_path)
    except Exception as exc:
        assert 'module_tree' in str(exc), exc
    else:
        raise AssertionError('合并写入本应判定叶子归属不一致')
    seen = {}
    def mutate(tree):
        seen['components'] = list(tree['leaf']['components'])
        tree['leaf']['components'].append('b/y.py::Y')
        return tree
    out = write_tree_exclusive(tree_path, mutate)
    assert seen['components'] == ['a/x.py::X'], seen
    assert out['leaf']['components'] == ['a/x.py::X', 'b/y.py::Y'], out
    on_disk = json.load(open(tree_path, encoding='utf-8'))
    assert on_disk['leaf']['components'] == ['a/x.py::X', 'b/y.py::Y'], on_disk


for name, fn in [
    ('缺失文件被补挂到已有叶子，上游校验通过', case_adopts_missing_file),
    ('没有缺失时不改动树', case_no_missing_is_noop),
    ('空树（整仓单页模式）原样放过', case_empty_tree_left_alone),
    ('无同文件/同目录线索时挂到目录最近的叶子', case_unrelated_leaf_fallback),
    ('同目录已有叶子优先', case_same_directory_preferred),
    ('目标树是磁盘树的超集时独占写不被误判成冲突', case_exclusive_write_supersedes_subset),
]:
    check(name, fn)

print(json.dumps(results, ensure_ascii=False))
`)

const proc = spawnSync(PY, [script], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
if (proc.status !== 0) {
  console.error(proc.stderr || proc.stdout)
  process.exit(1)
}
const line = (proc.stdout || '').trim().split('\n').pop()
const results = JSON.parse(line)
let failed = 0
for (const r of results) {
  if (r.ok) console.log(`PASS  ${r.name}`)
  else { failed++; console.log(`FAIL  ${r.name}\n      ${r.error}\n${r.trace}`) }
}
console.log(`\n${results.length - failed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
