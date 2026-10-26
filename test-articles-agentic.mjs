// lib/articles-agentic.js 测试：agentic 执行器与「子模块递归派发」接线。
// 全部用注入的假 streamFn 模拟模型，走真实文件系统（临时目录），完全离线。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOneArticle, runAgenticArticles } from './lib/articles-agentic.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS  ${label}`)
  } catch (err) {
    fails.push({ label, err })
    console.log(`FAIL  ${label}\n      ${err.message}`)
  }
}

// 临时工作区
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscw-aa-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'cart.js'), 'export function addItem() {\n  return 1\n}\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'src', 'order.js'), 'export function placeOrder() {\n  return 2\n}\n', 'utf8')
  return dir
}

function call(id, name, args) {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
}
function text(t) { return { type: 'text', text: t } }

// 按脚本返回的假 streamFn
function scripted(responses) {
  let i = 0
  return async () => {
    if (i >= responses.length) return { blocks: [text('完成')], finish: { kind: 'stop' } }
    return { blocks: responses[i++], finish: { kind: 'stop' } }
  }
}

const FULL_ARTICLE = '---\ntitle: 模块\n---\n\n# 模块\n\n正文内容。\n'

// ---------------------------------------------------------------- 基本写作落盘
await check('写出文章并落盘到 articlePath', async () => {
  const cwd = makeTmp()
  const articlePath = path.join(cwd, '.codewiki', 'wiki', 'modules', 'cart.md')
  const stream = scripted([
    [call('t1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('已完成')],
  ])
  const out = await runOneArticle(
    { name: 'modules/cart.md', mission: '写 cart 模块', articlePath, sources: ['src/cart.js'] },
    { streamFn: stream, cwd, maxSteps: 5 },
  )
  assert.equal(out.ok, true)
  assert.equal(fs.readFileSync(articlePath, 'utf8'), FULL_ARTICLE)
  assert.deepEqual(out.subModules, [])
  fs.rmSync(cwd, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 子模块派发
await check('generate_sub_module 真的递归写出子模块文章', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const parentPath = path.join(modulesDir, 'commerce.md')
  // 第 1 轮：派生子模块；第 2 轮（父）：写父文章；第 3 轮：结束
  // 子任务自己会新起一个 streamFn（同一个假模型），所以脚本按调用顺序排列：
  //   调用1 = 父第1轮 -> 派发
  //   调用2 = 子第1轮 -> 写子文章
  //   调用3 = 子第2轮 -> 结束
  //   调用4 = 父第2轮 -> 写父文章
  //   调用5 = 父第3轮 -> 结束
  const stream = scripted([
    [call('s1', 'generate_sub_module', { module_name: 'cart', components: ['src/cart.js'], description: '购物车写入' })],
    [call('c1', 'edit_article', { command: 'insert', line: 0, text: '---\ntitle: 购物车\n---\n\n# 购物车\n\n子模块正文。\n' })],
    [text('子完成')],
    [call('p1', 'edit_article', { command: 'insert', line: 0, text: '---\ntitle: 电商\n---\n\n# 电商\n\n见 [购物车](commerce/cart.md)。\n' })],
    [text('父完成')],
  ])
  const out = await runOneArticle(
    { name: 'modules/commerce.md', mission: '写 commerce 模块', articlePath: parentPath, sources: ['src/cart.js', 'src/order.js'] },
    { streamFn: stream, cwd, maxSteps: 6 },
  )
  assert.equal(out.ok, true)
  assert.equal(out.subModules.length, 1)
  assert.equal(out.subModules[0].name, 'cart')
  assert.equal(out.subModules[0].ok, true)
  // 子文章落在 <modules>/commerce/cart.md
  const subPath = path.join(modulesDir, 'commerce', 'cart.md')
  assert.equal(out.subModules[0].path, subPath)
  assert.match(fs.readFileSync(subPath, 'utf8'), /子模块正文/)
  assert.match(fs.readFileSync(parentPath, 'utf8'), /commerce\/cart\.md/)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('子模块重名时加父前缀，不互相覆盖', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const parentPath = path.join(modulesDir, 'commerce.md')
  const stream = scripted([
    [call('s1', 'generate_sub_module', { module_name: 'core', components: ['src/cart.js'], description: '第一次' })],
    [call('c1', 'edit_article', { command: 'insert', line: 0, text: '---\ntitle: A\n---\n\n正文A\n' })],
    [text('ok')],
    // 父第 2 轮：再派一个同名 core
    [call('s2', 'generate_sub_module', { module_name: 'core', components: ['src/order.js'], description: '第二次' })],
    [call('c2', 'edit_article', { command: 'insert', line: 0, text: '---\ntitle: B\n---\n\n正文B\n' })],
    [text('ok')],
    [call('p1', 'edit_article', { command: 'insert', line: 0, text: '---\ntitle: P\n---\n\n父正文\n' })],
    [text('done')],
  ])
  const out = await runOneArticle(
    { name: 'modules/commerce.md', mission: '写 commerce', articlePath: parentPath, sources: ['src/cart.js'] },
    { streamFn: stream, cwd, maxSteps: 8 },
  )
  assert.equal(out.subModules.length, 2)
  const paths = out.subModules.map((s) => s.path)
  assert.equal(new Set(paths).size, 2, '两个子模块文章路径必须不同')
  for (const p of paths) assert.ok(fs.existsSync(p), `应存在 ${p}`)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('subDepth=0 时派发被禁用（不再递归）', async () => {
  const cwd = makeTmp()
  const articlePath = path.join(cwd, '.codewiki', 'wiki', 'modules', 'x.md')
  const stream = scripted([
    [call('s1', 'generate_sub_module', { module_name: 'sub', components: [], description: 'd' })],
    [call('a1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('done')],
  ])
  const out = await runOneArticle(
    { name: 'modules/x.md', mission: '写 x', articlePath, sources: [] },
    { streamFn: stream, cwd, maxSteps: 5, subDepth: 0 },
  )
  assert.equal(out.subModules.length, 0, '深度封顶后不应产生子文章')
  assert.equal(out.ok, true)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('子模块写作失败被记账，父文章仍算成功', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const parentPath = path.join(modulesDir, 'p.md')
  // 调用顺序：1=父派发子模块；2..N=子任务（全部抛错）；之后父继续写文章
  let calls = 0
  const stream = async () => {
    calls++
    // 子任务在父派发之后开始，它会连续调用；父的后续轮次也在同一计数流里
    // 用「子任务抛错一次就结束」的实现：子第 1 次调用抛错 -> 子拿不到文章，判失败并返回
    if (calls === 2) throw new Error('child upstream 500')
    if (calls === 1) {
      return { blocks: [call('s1', 'generate_sub_module', { module_name: 'bad', components: [], description: '写不出来' })], finish: { kind: 'stop' } }
    }
    if (calls === 3) {
      return { blocks: [call('p1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })], finish: { kind: 'stop' } }
    }
    return { blocks: [text('done')], finish: { kind: 'stop' } }
  }
  const out = await runOneArticle(
    { name: 'modules/p.md', mission: '写 p', articlePath: parentPath, sources: [] },
    { streamFn: stream, cwd, maxSteps: 4, onSubModuleHook: null },
  )
  // 父第一次调用派发子模块；子失败后父继续下一轮 -> 需要父能写文章，这里用兜底：
  assert.equal(out.ok, true, '父文章成功')
  assert.equal(out.subModules.length, 1)
  assert.equal(out.subModules[0].ok, false, '子模块应记为失败')
  fs.rmSync(cwd, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 池化
await check('runAgenticArticles 汇总 subModules 并记 note', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const stream = scripted([
    [call('s1', 'generate_sub_module', { module_name: 'part', components: ['src/a.js'], description: 'd' })],
    [call('c1', 'edit_article', { command: 'insert', line: 0, text: '---\ntitle: S\n---\n\n子正文\n' })],
    [text('ok')],
    [call('p1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('done')],
    [call('p2', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('done')],
  ])
  const notes = []
  const tasks = [
    { customId: 'a0', name: 'modules/m0.md', mission: '写 m0', articlePath: path.join(modulesDir, 'm0.md'), sources: [] },
    { customId: 'a1', name: 'modules/m1.md', mission: '写 m1', articlePath: path.join(modulesDir, 'm1.md'), sources: [] },
  ]
  const rs = await runAgenticArticles(tasks, { streamFn: stream, cwd, concurrency: 1, notes, maxSteps: 4 })
  assert.equal(rs.size, 2)
  assert.ok(rs.get('a0').subModules.length >= 0)
  assert.ok(notes.some((n) => /派生出 1 个子模块文章/.test(n)), `notes 应记录派生：${notes.join(' | ')}`)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('任务抛错不影响其它任务，计入 notes', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  let n = 0
  const stream = async () => {
    n++
    if (n === 1) throw new Error('upstream 503')
    return { blocks: [call('a', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })], finish: { kind: 'stop' } }
  }
  const notes = []
  const tasks = [
    { customId: 'x0', name: 'modules/x0.md', mission: 'm', articlePath: path.join(modulesDir, 'x0.md'), sources: [] },
    { customId: 'x1', name: 'modules/x1.md', mission: 'm', articlePath: path.join(modulesDir, 'x1.md'), sources: [] },
  ]
  const rs = await runAgenticArticles(tasks, { streamFn: stream, cwd, concurrency: 1, notes, maxSteps: 3 })
  const vals = [...rs.values()]
  assert.equal(vals.filter((v) => v.ok).length, 1, '应有一个成功')
  assert.equal(vals.filter((v) => !v.ok).length, 1, '应有一个失败')
  // 流抛错被 agentic 循环收敛为 stopReason='error'（不向外炸），落成「未产出正文」的 note
  assert.ok(notes.some((s) => /未产出正文|请求失败/.test(s)), `notes 应记录失败：${notes.join(' | ')}`)
  fs.rmSync(cwd, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 结果
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) process.exitCode = 1
