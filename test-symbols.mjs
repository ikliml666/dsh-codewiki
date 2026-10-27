// lib/symbols.js 测试：多语言 AST 符号提取 + import 依赖边。
// 覆盖：函数/方法/类归属、参数去默认值与类型、基类、箭头函数、多语言节点类型、
// import 解析（相对路径/Python 点号/Rust use/头文件）、降级（语法缺失不抛错）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import {
  SymbolExtractor, extractRepoGraph, resolveImportEdges,
  extractImportSpecs, resolveSpec, LANG_RULES, SUPPORTED_EXTS,
  regexExtract,
} from './lib/symbols.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
function check(label, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${label}`)
  } catch (err) {
    fails.push({ label, err })
    console.log(`FAIL  ${label}\n      ${err.message}`)
  }
}
async function checkAsync(label, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS  ${label}`)
  } catch (err) {
    fails.push({ label, err })
    console.log(`FAIL  ${label}\n      ${err.message}`)
  }
}

const ex = new SymbolExtractor()
const ready = await ex.init()
console.log(ready ? '· web-tree-sitter 可用' : `· web-tree-sitter 不可用：${ex.initError}`)

if (!ready) {
  console.log('\nSKIP：web-tree-sitter 未安装，AST 相关用例无法执行')
  process.exit(0)
}

// ---------------------------------------------------------------- JS/TS
const jsSrc = `
import { a } from './dep.js'
import './side.js'

export class Widget extends Base {
  constructor(x) { this.x = x }
  render(count, opts = {}) { return count }
  static helper() {}
}

function standalone(a, b = 2, ...rest) { return a }

const arrowFn = (p, q) => p + q
export default function defaulted() {}
`
await checkAsync('JS：类 + 方法 + 函数 + 箭头函数全部提取', async () => {
  const recs = await ex.extractFile('src/widget.js', jsSrc)
  const names = recs.map((r) => r.name).sort()
  assert.deepEqual(names, ['Widget', 'Widget.constructor', 'Widget.helper', 'Widget.render', 'arrowFn', 'defaulted', 'standalone'].sort())
  const cls = recs.find((r) => r.name === 'Widget')
  assert.equal(cls.kind, 'class')
  const m = recs.find((r) => r.name === 'Widget.render')
  assert.equal(m.kind, 'method')
  assert.equal(m.relativePath, 'src/widget.js')
  assert.equal(m.id, 'src/widget.js#Widget.render')
})

await checkAsync('JS：参数剥离默认值与 rest', async () => {
  const recs = await ex.extractFile('src/widget.js', jsSrc)
  const fn = recs.find((r) => r.name === 'standalone')
  assert.deepEqual(fn.parameters, ['a', 'b', 'rest'])
  const m = recs.find((r) => r.name === 'Widget.render')
  assert.deepEqual(m.parameters, ['count', 'opts'])
})

await checkAsync('JS：方法源码切片包含完整函数体', async () => {
  const recs = await ex.extractFile('src/widget.js', jsSrc)
  const m = recs.find((r) => r.name === 'Widget.render')
  assert.match(m.sourceCode, /render\(count, opts = \{\}\) \{ return count \}/)
})

// ---------------------------------------------------------------- Python
const pySrc = `
import os
from pkg.mod import helper

class Service(Base, Mixin):
    """Service docs."""
    def __init__(self, cfg):
        pass
    def run(self, *args, **kwargs):
        return helper(args)
    async def arun(self):
        pass

def top(a, b=1):
    """Top docs."""
    return a
`
await checkAsync('Python：类/方法/函数 + docstring', async () => {
  const recs = await ex.extractFile('app/service.py', pySrc)
  const cls = recs.find((r) => r.name === 'Service')
  assert.ok(cls, '缺少 Service 类')
  assert.equal(cls.docstring, 'Service docs.')
  assert.deepEqual(cls.baseClasses.sort(), ['Base', 'Mixin'])
  const run = recs.find((r) => r.name === 'Service.run')
  assert.equal(run.kind, 'method')
  const top = recs.find((r) => r.name === 'top')
  assert.equal(top.docstring, 'Top docs.')
  assert.ok(recs.some((r) => r.name === 'Service.arun'), '异步方法未提取')
})

// ---------------------------------------------------------------- Go
const goSrc = `
package main

import "fmt"

type Server struct { name string }

func New(name string) *Server { return &Server{name: name} }

func (s *Server) Start(port int) error {
	fmt.Println(port)
	return nil
}
`
await checkAsync('Go：函数 + 方法', async () => {
  const recs = await ex.extractFile('internal/server.go', goSrc)
  const names = recs.map((r) => r.name)
  assert.ok(names.includes('New'), `缺少 New：${names}`)
  assert.ok(names.includes('Server.Start'), `缺少 Server.Start：${names}`)
  const start = recs.find((r) => r.name === 'Server.Start')
  assert.equal(start.kind, 'method')
})

// ---------------------------------------------------------------- Rust
const rsSrc = `
use crate::core::Thing;

pub struct Config { pub n: u32 }

impl Config {
    pub fn new() -> Self { Config { n: 0 } }
    pub fn load(&self, path: &str) -> bool { true }
}

pub fn parse(input: &str) -> u32 { 0 }
`
await checkAsync('Rust：impl 块内方法 + 顶层函数', async () => {
  const recs = await ex.extractFile('src/config.rs', rsSrc)
  const names = recs.map((r) => r.name)
  assert.ok(names.includes('parse'), `缺少 parse：${names}`)
  assert.ok(names.includes('Config.load'), `缺少 Config.load：${names}`)
  const load = recs.find((r) => r.name === 'Config.load')
  assert.equal(load.kind, 'method')
})

// ---------------------------------------------------------------- Java / C# / C
const javaSrc = `
package com.acme;

import java.util.List;

public class Repo extends Base implements Api {
    public Repo(String url) {}
    public List<String> list(int page) { return null; }
}
`
await checkAsync('Java：类/方法/构造器', async () => {
  const recs = await ex.extractFile('src/Repo.java', javaSrc)
  const names = recs.map((r) => r.name)
  assert.ok(names.includes('Repo'), `缺少 Repo：${names}`)
  assert.ok(names.includes('Repo.list'), `缺少 Repo.list：${names}`)
})

const csSrc = `
using System;
namespace Acme {
  public class Client {
    public Client(string key) {}
    public void Send(string body) {}
  }
}
`
await checkAsync('C#：namespace 内类与方法', async () => {
  const recs = await ex.extractFile('src/Client.cs', csSrc)
  const names = recs.map((r) => r.name)
  assert.ok(names.includes('Client.Send'), `缺少 Client.Send：${names}`)
})

const cSrc = `
#include "util.h"

struct Point { int x; int y; };

int add(int a, int b) { return a + b; }
`
await checkAsync('C：struct + 函数', async () => {
  const recs = await ex.extractFile('src/math.c', cSrc)
  const names = recs.map((r) => r.name)
  assert.ok(names.includes('Point'), `缺少 Point：${names}`)
  assert.ok(names.includes('add'), `缺少 add：${names}`)
})

// ---------------------------------------------------------------- 边界
await checkAsync('未知扩展名返回空数组，不抛错', async () => {
  const recs = await ex.extractFile('README.md', '# hi')
  assert.deepEqual(recs, [])
})

await checkAsync('语法错误不抛错，正常符号仍提取', async () => {
  const recs = await ex.extractFile('src/broken.js', 'function ok() { return 1 }\nfunction (')
  assert.ok(recs.some((r) => r.name === 'ok'))
})

await checkAsync('空文件返回空数组', async () => {
  assert.deepEqual(await ex.extractFile('src/empty.py', ''), [])
})

// ---------------------------------------------------------------- import 边
check('extractImportSpecs 覆盖多种语句', () => {
  const specs = extractImportSpecs('a.js', `
import x from './b.js'
import './c.css'
const y = require('./d')
`)
  assert.ok(specs.includes('./b.js'))
  assert.ok(specs.includes('./c.css'))
  assert.ok(specs.includes('./d'))
})

check('resolveSpec 相对路径带补全', () => {
  const known = new Set(['src/b.js', 'src/sub/index.ts', 'app/pkg/mod.py'])
  assert.equal(resolveSpec('src/a.js', './b', known), 'src/b.js')
  assert.equal(resolveSpec('src/a.js', './b.js', known), 'src/b.js')
  assert.equal(resolveSpec('src/a.js', './sub', known), 'src/sub/index.ts')
})

check('resolveSpec Python 点号模块', () => {
  const known = new Set(['app/pkg/mod.py'])
  assert.equal(resolveSpec('app/main.py', 'app.pkg.mod', known), 'app/pkg/mod.py')
})

check('resolveSpec 找不到返回 null', () => {
  assert.equal(resolveSpec('src/a.js', 'lodash', new Set(['src/a.js'])), null)
})

await checkAsync('resolveImportEdges 连线到目标文件组件', async () => {
  const files = new Map([
    ['src/a.js', "import { b } from './b.js'\nexport function fa() { return b() }"],
    ['src/b.js', 'export function fb() { return 1 }'],
  ])
  const list = [...files.entries()].map(([p, content]) => ({ path: p, content }))
  const { graph, byFile } = await extractRepoGraph(list, { extractor: ex })
  const edges = resolveImportEdges(graph, byFile, files)
  assert.equal(edges.length, 1, `边数应为 1，实际 ${edges.length}`)
  assert.equal(edges[0].from, 'src/a.js')
  assert.equal(edges[0].to, 'src/b.js')
  const fa = graph.get('src/a.js#fa')
  assert.ok(fa.dependsOn.includes('src/b.js#fb'), 'dependsOn 未连到目标组件')
})

// ---------------------------------------------------------------- 真实仓库自检
await checkAsync('本插件自身源码可被完整提取', async () => {
  const targets = ['index.js', 'lib/symbols.js', 'lib/graph-diff.js', 'client.js']
  const list = targets.filter((t) => fs.existsSync(path.join(here, t)))
    .map((t) => ({ path: t, content: fs.readFileSync(path.join(here, t), 'utf8') }))
  assert.ok(list.length >= 3, '样本文件不足')
  const { graph, stats } = await extractRepoGraph(list, { extractor: ex })
  assert.ok(graph.size > 30, `提取到的组件过少：${graph.size}`)
  assert.equal(stats.failed, 0, '出现解析失败文件')
  // id 格式统一
  for (const [id, node] of graph) {
    assert.equal(id, `${node.relativePath}#${node.name}`)
    assert.ok(node.sourceCode.length > 0, `${id} 源码为空`)
  }
  console.log(`      · 提取 ${graph.size} 个组件，语言 ${JSON.stringify(stats.languages)}`)
})

// ---------------------------------------------------------------- 正则降级
// AST 不可用时（WASM 没装/ABI 不匹配/语法细则没覆盖）必须退到正则兜底，
// 不能静默返回空 —— 那会让整块语言的模块凭空消失，且日志上只看到 skipped +N。

check('regexExtract：JS 认出函数/类/箭头函数', () => {
  const src = [
    '// 注释里的 function fake() 不该被认成定义',
    'export function addItem(a, b) {',
    '  return a + b',
    '}',
    'export class Cart {',
    '  checkout() {}',
    '}',
    'const helper = (x) => x * 2',
  ].join('\n')
  const recs = regexExtract('src/a.js', src, 'javascript')
  const names = recs.map((r) => r.name).sort()
  assert.ok(names.includes('addItem'), `未认出 addItem：${names}`)
  assert.ok(names.includes('Cart'), `未认出 Cart：${names}`)
  assert.ok(names.includes('helper'), `未认出箭头函数 helper：${names}`)
  assert.ok(!names.includes('fake'), '注释里的假函数不该被认出')
  // 记录形状必须与 AST 路径一致（同一个 consumer：graph-diff / cluster）
  const add = recs.find((r) => r.name === 'addItem')
  assert.equal(add.id, 'src/a.js#addItem')
  assert.equal(add.kind, 'function')
  assert.deepEqual(add.parameters, ['a', 'b'])
  assert.ok(add.sourceCode.includes('return a + b'), '源码区间应覆盖实现')
  assert.deepEqual(add.dependsOn, [])
  assert.deepEqual(add.baseClasses, [])
})

check('regexExtract：Python/Go/Rust 各自认出定义', () => {
  const py = regexExtract('a.py', 'class Store:\n    pass\n\nasync def load_items(limit):\n    pass\n', 'python')
  assert.deepEqual(py.map((r) => r.name).sort(), ['Store', 'load_items'])
  const go = regexExtract('a.go', 'func (s *Server) Start(addr string) {\n}\n', 'go')
  assert.ok(go.some((r) => r.name === 'Start'), `Go 方法未认出：${go.map((r) => r.name)}`)
  const rs = regexExtract('a.rs', 'pub async fn fetch_all(ids: Vec<u32>) {\n}\n', 'rust')
  assert.ok(rs.some((r) => r.name === 'fetch_all'), `Rust fn 未认出：${rs.map((r) => r.name)}`)
})

check('regexExtract：无规则的语言返回空且不抛错', () => {
  assert.deepEqual(regexExtract('a.xyz', 'foo()', 'unknown-lang'), [])
  assert.deepEqual(regexExtract('a.js', '', 'javascript'), [])
})

await checkAsync('WASM 不可用时 extractFile 自动走正则（不再静默丢符号）', async () => {
  // 指向一个不存在的 vendor 目录，逼 getParser 全部失败
  const broken = new SymbolExtractor({ vendorDir: path.join(here, '.no-such-vendor') })
  const src = 'export function addItem(a) {\n  return a\n}\n'
  const recs = await broken.extractFile('src/a.js', src)
  assert.ok(recs.length >= 1, 'WASM 不可用时应当由正则兜底出符号')
  assert.equal(recs[0].name, 'addItem')
  assert.equal(broken.stats.regex, 1, '降级次数应被记账')
  assert.equal(broken.stats.regexLanguages.javascript, 1)
})

await checkAsync('WASM 可用时不走正则（stats.regex 为 0）', async () => {
  const ext = new SymbolExtractor()
  await ext.init()
  if (!(await ext.getParser('javascript'))) return // 环境里没有语法，跳过
  await ext.extractFile('src/a.js', 'export function addItem(a) {\n  return a\n}\n')
  assert.ok(!ext.stats.regex, `AST 正常时不该记降级，实际 ${ext.stats.regex}`)
  assert.ok(ext.stats.parsed >= 1)
})

check('语言表覆盖常见扩展名', () => {
  for (const ext of ['.js', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.cs', '.c', '.cpp', '.rb', '.php', '.kt', '.scala', '.dart', '.sh', '.lua']) {
    assert.ok(SUPPORTED_EXTS.has(ext), `缺少扩展名 ${ext}`)
  }
  assert.equal(SUPPORTED_EXTS.get('.tsx'), 'typescript')
  assert.ok(Object.keys(LANG_RULES).length >= 15)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
