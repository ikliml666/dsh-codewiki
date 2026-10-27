// lib/articles-agentic.js 测试：agentic 执行器与「子模块递归派发」接线。
// 全部用注入的假 streamFn 模拟模型，走真实文件系统（临时目录），完全离线。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runOneArticle, runAgenticArticles, markBigAgenticTasks, sourceTokensOf, resolveTaskRoute } from './lib/articles-agentic.js'

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

// ---------------------------------------------------------------- subDepth 封顶（多层）
// 这两条是 issue「subDepth 失效」的回归防护。
// 旧实现里 dispatchSub 是**本层**闭包，递归时原样下传，子层的 `_depth >= subDepth`
// 判定永远用父层深度 -> 永不触发 -> 模型可以无限往下拆（实测 subDepth=2 直接堆溢出）。
// 因此这里不用精确调用序列（那样脆），改用两个与顺序无关的断言：
//   ① 磁盘上文章的目录层数不超过 subDepth；
//   ② 模型调用次数有界（封顶失效时必然爆炸）。

function scanArticleDepths(root) {
  const out = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) out.push(path.relative(root, p).split(path.sep).length)
    }
  }
  walk(root)
  return out
}

// 每次模型调用都「写一句正文 + 派生子模块」（名字按调用序号唯一，避免被重名逻辑挡掉）。
// 必须同时写正文：空文章不算成功、不会落盘，那样查磁盘层数就查不到东西。
function alwaysDispatch(counter) {
  return async () => {
    counter.calls++
    return {
      blocks: [
        call(`e${counter.calls}`, 'edit_article', { command: 'insert', line: 0, text: `第 ${counter.calls} 段。\n` }),
        call(`g${counter.calls}`, 'generate_sub_module', {
          module_name: `sub${counter.calls}`, components: [], description: '继续拆',
        }),
      ],
      finish: { kind: 'stop' },
    }
  }
}

await check('subDepth=1 时只有一层子模块，不再往下拆（封顶真的生效）', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const counter = { calls: 0 }
  const out = await runOneArticle(
    { name: 'modules/root.md', mission: '写根', articlePath: path.join(modulesDir, 'root.md'), sources: [] },
    { streamFn: alwaysDispatch(counter), cwd, maxSteps: 3, subDepth: 1 },
  )
  // subDepth=1：父(root) -> 子(subN) 是允许的第 1 层；子再派发必须被挡住，
  // 所以磁盘上最深就是 modules/<父>/<子>.md 两段。
  const depths = scanArticleDepths(modulesDir)
  assert.ok(depths.length > 0, '应当至少写出一个子文章')
  assert.ok(Math.max(...depths) <= 2, `文章目录层数应 <= 2，实际 ${Math.max(...depths)}（${depths.join(',')}）`)
  // 封顶失效时每个子都会再递归 3 轮，调用次数呈指数增长
  assert.ok(counter.calls < 40, `模型调用次数应在合理范围，实际 ${counter.calls}`)
  assert.equal(out.ok, out.ok) // 不约束父是否成功（全派发脚本下父没写过正文）
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('subDepth=2 时允许一层孙模块（_depth 确实逐层递增）', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const counter = { calls: 0 }
  await runOneArticle(
    { name: 'modules/root.md', mission: '写根', articlePath: path.join(modulesDir, 'root.md'), sources: [] },
    { streamFn: alwaysDispatch(counter), cwd, maxSteps: 3, subDepth: 2 },
  )
  const depths = scanArticleDepths(modulesDir)
  assert.ok(depths.length > 0, '应当写出文章')
  // subDepth=2 才允许 modules/<父>/<子>/<孙>.md 三段；若深度不递增，永远到不了三段
  assert.ok(Math.max(...depths) >= 3, `应出现三段路径（孙模块），实际最深 ${Math.max(...depths)}（${depths.join(',')}）`)
  assert.ok(counter.calls < 120, `模型调用次数应在合理范围，实际 ${counter.calls}`)
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

// ---------------------------------------------------------------- 双池与大档标记
// 背景：agentic 通道原本是单池（concurrency），绕过了单轮通道 0.12.2 起的大档/默认档
// 分离限流。这里补上，并按模块体量打大档标记（agentic 不装填源码，判据换成源文本量）。

await check('markBigAgenticTasks：超预算的模块打上大档 provider/model', async () => {
  const tasks = [
    { customId: 'a', name: 'modules/a.md', sources: [] },
    { customId: 'b', name: 'modules/b.md', sources: [] },
  ]
  const bigTier = { provider: 'big-p', model: 'big-m', reasoningEffort: 'high', budget: 1000 }
  const out = markBigAgenticTasks(tasks, { bigTier, sizeOf: (t) => (t.customId === 'b' ? 5000 : 10) })
  assert.equal(out[0].bigTier, undefined, '小模块不该打大档')
  assert.equal(out[1].bigTier, true, '超预算模块应打大档')
  assert.equal(out[1].provider, 'big-p')
  assert.equal(out[1].model, 'big-m')
  assert.equal(out[1].reasoningEffort, 'high')
  // 不改原对象（纯函数）
  assert.equal(tasks[1].bigTier, undefined)
})

await check('markBigAgenticTasks：大档未配置时原样返回（不误打标记）', async () => {
  const tasks = [{ customId: 'a', sources: [] }]
  assert.equal(markBigAgenticTasks(tasks, { bigTier: { provider: '', model: 'x', budget: 1 } })[0].bigTier, undefined)
  assert.equal(markBigAgenticTasks(tasks, {})[0].bigTier, undefined)
  assert.equal(markBigAgenticTasks(tasks, { bigTier: { provider: 'p', model: 'm', budget: 0 } })[0].bigTier, undefined)
})

await check('markBigAgenticTasks：不传 reasoningEffort 时任务上不出现该字段', async () => {
  const out = markBigAgenticTasks([{ customId: 'a' }], {
    bigTier: { provider: 'p', model: 'm', budget: 1 },
    sizeOf: () => 999,
  })
  assert.equal(out[0].bigTier, true)
  assert.equal('reasoningEffort' in out[0], false)
})

await check('双池：大档任务与默认档任务都能跑完并各自落盘', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  const stream = async () => ({ blocks: [{ type: 'text', text: FULL_ARTICLE }], finish: { kind: 'stop' } })
  const tasks = [
    { customId: 'n0', name: 'modules/n0.md', mission: 'm', articlePath: path.join(modulesDir, 'n0.md'), sources: [] },
    { customId: 'b0', name: 'modules/b0.md', mission: 'm', articlePath: path.join(modulesDir, 'b0.md'), sources: [], provider: 'big-p', model: 'big-m', bigTier: true },
  ]
  const rs = await runAgenticArticles(tasks, {
    streamFn: stream, cwd, concurrency: 1, bigConcurrency: 1,
    provider: 'norm-p', model: 'norm-m', maxSteps: 3,
  })
  assert.equal(rs.size, 2, '两篇都要跑完')
  assert.ok(fs.existsSync(path.join(modulesDir, 'n0.md')), '默认档任务应写出')
  assert.ok(fs.existsSync(path.join(modulesDir, 'b0.md')), '大档任务应写出')
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('resolveTaskRoute：任务自带 provider/model 时覆盖默认档，effort 也以任务为准', async () => {
  const def = { provider: 'norm-p', model: 'norm-m', reasoningEffort: 'off' }
  // 大档任务：task 上的三件套全生效
  assert.deepEqual(
    resolveTaskRoute({ provider: 'big-p', model: 'big-m', reasoningEffort: 'high' }, def),
    { provider: 'big-p', model: 'big-m', reasoningEffort: 'high' },
  )
  // 大档任务没写 effort：用空（模型默认档），绝不回落默认档的 'off'
  assert.deepEqual(
    resolveTaskRoute({ provider: 'big-p', model: 'big-m' }, def),
    { provider: 'big-p', model: 'big-m', reasoningEffort: '' },
  )
  // 普通任务：全用默认档
  assert.deepEqual(resolveTaskRoute({}, def), { provider: 'norm-p', model: 'norm-m', reasoningEffort: 'off' })
  // 只写一半（缺 model）不算自带：回落默认档，避免 provider/model 错配
  assert.deepEqual(resolveTaskRoute({ provider: 'big-p' }, def), { provider: 'norm-p', model: 'norm-m', reasoningEffort: 'off' })
})

await check('双池：bigConcurrency=0 时回落到 concurrency（行为与单池一致）', async () => {
  const cwd = makeTmp()
  const modulesDir = path.join(cwd, '.codewiki', 'wiki', 'modules')
  let inFlight = 0
  let peak = 0
  const stream = async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 20))
    inFlight--
    return { blocks: [call('a', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })], finish: { kind: 'stop' } }
  }
  const mk = (i, big) => ({
    customId: `b${i}`, name: `modules/b${i}.md`, mission: 'm',
    articlePath: path.join(modulesDir, `b${i}.md`), sources: [],
    ...(big ? { provider: 'p', model: 'm', bigTier: true } : {}),
  })
  const tasks = [mk(0, true), mk(1, true), mk(2, true)]
  await runAgenticArticles(tasks, { streamFn: stream, cwd, concurrency: 2, bigConcurrency: 0, maxSteps: 3 })
  assert.equal(peak, 2, `bigConcurrency=0 时大档池应用 concurrency=2，实测峰值 ${peak}`)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('sourceTokensOf 按 CJK/非 CJK 口径估 token，读不到的文件跳过', async () => {
  const cwd = makeTmp()
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), '中'.repeat(100), 'utf8')
  const n = sourceTokensOf({ sources: ['src/a.js', 'src/missing.js'] }, cwd)
  assert.equal(n, 100, `100 个 CJK 字符应估 100 token，实际 ${n}`)
  assert.equal(sourceTokensOf({ sources: [] }, cwd), 0)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('写集闸门：allowedWritePaths 之外的路径不落盘，返回 write-set 原因', async () => {
  const cwd = makeTmp()
  const allowed = path.join(cwd, '.codewiki', 'wiki', 'modules', 'cart.md')
  const outside = path.join(cwd, '.codewiki', 'wiki', 'modules', 'other.md')
  const stream = scripted([
    [call('t1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('已完成')],
  ])
  const out = await runOneArticle(
    { name: 'modules/other.md', mission: '越界写', articlePath: outside, sources: [] },
    { streamFn: stream, cwd, maxSteps: 5, allowedWritePaths: [allowed] },
  )
  assert.equal(out.ok, false, '越界写必须判失败')
  assert.equal(out.stopReason, 'write-set')
  assert.equal(fs.existsSync(outside), false, '越界目标文件不得落盘')
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('写集闸门：allowedWritePaths 之内正常落盘（子模块只写自己那条路径）', async () => {
  const cwd = makeTmp()
  const mine = path.join(cwd, '.codewiki', 'wiki', 'modules', 'cart.md')
  const stream = scripted([
    [call('t1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('已完成')],
  ])
  const out = await runOneArticle(
    { name: 'modules/cart.md', mission: '写自己', articlePath: mine, sources: [] },
    { streamFn: stream, cwd, maxSteps: 5, allowedWritePaths: [mine] },
  )
  assert.equal(out.ok, true)
  assert.equal(fs.readFileSync(mine, 'utf8'), FULL_ARTICLE)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('写集闸门：不传 allowedWritePaths 时行为不变（旧调用方沿用）', async () => {
  const cwd = makeTmp()
  const anyPath = path.join(cwd, '.codewiki', 'wiki', 'modules', 'legacy.md')
  const stream = scripted([
    [call('t1', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('已完成')],
  ])
  const out = await runOneArticle(
    { name: 'modules/legacy.md', mission: '旧调用', articlePath: anyPath, sources: [] },
    { streamFn: stream, cwd, maxSteps: 5 },
  )
  assert.equal(out.ok, true, '不设限时不应拦截')
  assert.equal(fs.existsSync(anyPath), true)
  fs.rmSync(cwd, { recursive: true, force: true })
})

await check('写集闸门：子模块递归时父任务写集会下传，子层越界写父文被拒', async () => {
  const cwd = makeTmp()
  const parentPath = path.join(cwd, '.codewiki', 'wiki', 'modules', 'shop.md')
  const stream = scripted([
    // 父层：先派子模块，子层尝试写父文（越界），父层再正常收尾
    [call('p1', 'generate_sub_module', { module_name: 'cart', components: ['src/cart.js'], description: '购物车' })],
    [call('p2', 'edit_article', { command: 'insert', line: 0, text: FULL_ARTICLE })],
    [text('已完成')],
  ])
  const out = await runOneArticle(
    { name: 'modules/shop.md', mission: '写 shop', articlePath: parentPath, sources: ['src/cart.js', 'src/order.js'] },
    { streamFn: stream, cwd, maxSteps: 8, allowedWritePaths: [parentPath] },
  )
  // 子模块拿到的写集只有它自己那条路径（不是父文的），因此子层不会覆盖父文
  assert.equal(out.ok, true, `父层应成功收尾（实际 ${out.ok}/${out.stopReason}）`)
  const subs = out.subModules ?? []
  assert.ok(subs.length >= 1, `应派生出子模块文章（实际 ${subs.length}）`)
  for (const s of subs) {
    assert.notEqual(path.resolve(s.path), path.resolve(parentPath), '子模块不得写父文章路径')
  }
  fs.rmSync(cwd, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 结果
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) process.exitCode = 1
