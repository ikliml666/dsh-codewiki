// lib/cluster.js 测试：LLM 聚类三段式（顶层 / 下钻 / 超级分组）与全部降级路径。
// 用注入的 completer 模拟模型，不碰网络。
import assert from 'node:assert/strict'
import {
  clusterComponents, heuristicCluster, fillMissing, moduleFiles,
  formatComponents, clusterPrompt, subClusterPrompt, superGroupPrompt,
  parseJsonLoose, parseClusterResponse, parseSuperGroups,
  normalizeModuleName, toPlanModules,
} from './lib/cluster.js'

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

// 造一个像真仓库的组件集：src/ 下三个关注点 + 配置 + 一组大模块
function makeComponents() {
  const out = []
  const add = (file, name, kind = 'function') =>
    out.push({ id: `${file}#${name}`, name, kind, relativePath: file, parameters: ['a'], sourceCode: `function ${name}(){}`, dependsOn: [] })
  for (let i = 0; i < 6; i++) add('src/auth/login.js', `login${i}`)
  for (let i = 0; i < 5; i++) add('src/auth/token.js', `token${i}`)
  for (let i = 0; i < 7; i++) add('src/wiki/compile.js', `compile${i}`)
  for (let i = 0; i < 4; i++) add('src/panel/ui.js', `render${i}`)
  add('package.json', 'scripts', 'const')
  add('README.md', 'docs', 'const')
  // 一个大模块，用于触发下钻
  for (let i = 0; i < 70; i++) add('src/big/engine.js', `engine${i}`)
  return out
}

const components = makeComponents()
const allIds = components.map((c) => c.id)

// ---------------------------------------------------------------- 提示词
await check('clusterPrompt 含全部 id 与数量声明', async () => {
  const p = clusterPrompt(formatComponents(components), components.length)
  assert.match(p, /共 \d+ 个组件/)
  assert.ok(p.includes('src/auth/login.js#login0'))
  assert.match(p, /必须原样返回/)
})

await check('formatComponents 按文件分组并标 artifact', async () => {
  const text = formatComponents(components)
  assert.ok(text.includes('# src/auth/login.js'))
  assert.ok(text.includes('(artifact: config)'), 'package.json 未标 artifact')
})

await check('subClusterPrompt / superGroupPrompt 结构完整', async () => {
  assert.match(subClusterPrompt('big', 'x', 3), /模块「big」/)
  const sp = superGroupPrompt([{ name: 'a', path: 'x', components: [1], summary: 's' }])
  assert.ok(sp.includes('- a (path: x, 1 组件): s'))
  assert.match(sp, /架构子系统/)
})

// ---------------------------------------------------------------- JSON 抢救
await check('parseJsonLoose 剥围栏', async () => {
  const r = parseJsonLoose('```json\n{"a":1}\n```')
  assert.equal(r.a, 1)
})

await check('parseJsonLoose 取前后废话中的对象', async () => {
  const r = parseJsonLoose('好的，结果如下：\n{"a":2}\n以上。')
  assert.equal(r.a, 2)
})

await check('parseJsonLoose 修尾逗号', async () => {
  const r = parseJsonLoose('{"a":[1,2,],}')
  assert.deepEqual(r.a, [1, 2])
})

await check('parseJsonLoose 无 JSON 返回 null', async () => {
  assert.equal(parseJsonLoose('抱歉我不能'), null)
})

// ---------------------------------------------------------------- 响应解析
await check('parseClusterResponse 丢弃不存在的 id 并记警告', async () => {
  const warnings = []
  const r = parseClusterResponse(JSON.stringify({
    modules: [{ name: 'Auth', components: ['src/auth/login.js#login0', 'src/auth/login.js#ghost'] }],
  }), allIds, warnings)
  assert.equal(r.modules.length, 1)
  assert.deepEqual(r.modules[0].components, ['src/auth/login.js#login0'])
  assert.equal(r.modules[0].name, 'auth', '模块名未规范化')
  assert.ok(warnings.some((w) => w.includes('ghost')))
})

await check('parseClusterResponse 去重复分配（全空的模块被丢弃）', async () => {
  const warnings = []
  const r = parseClusterResponse(JSON.stringify({
    modules: [
      { name: 'a', components: ['src/auth/login.js#login0'] },
      { name: 'b', components: ['src/auth/login.js#login0'] },
    ],
  }), allIds, warnings)
  assert.equal(r.modules.length, 1, '重复分配后 b 变空，应被丢弃')
  assert.deepEqual(r.modules[0].components, ['src/auth/login.js#login0'])
  assert.ok(warnings.some((w) => w.includes('重复')))
})

await check('parseClusterResponse 缺 modules 返回 null', async () => {
  assert.equal(parseClusterResponse('{"foo":1}', allIds, []), null)
})

await check('normalizeModuleName 处理空格与特殊字符', async () => {
  assert.equal(normalizeModuleName('Wiki Compile'), 'wiki_compile')
  assert.equal(normalizeModuleName('a/b:c'), 'a_b_c')
  assert.equal(normalizeModuleName(''), 'module')
  assert.equal(normalizeModuleName('架构层'), '架构层')
})

// ---------------------------------------------------------------- 启发式聚类
await check('heuristicCluster 按顶层目录分组', async () => {
  const mods = heuristicCluster(components)
  const names = mods.map((m) => m.name).sort()
  assert.ok(names.includes('src'))
  assert.ok(names.includes('root'), `根文件未归组：${names}`)
  const src = mods.find((m) => m.name === 'src')
  assert.equal(src.components.length, allIds.length - 2)
})

await check('fillMissing 把漏掉的组件挂到同目录模块', async () => {
  const mods = [{ name: 'auth', path: 'src/auth', components: ['src/auth/login.js#login0'] }]
  const byId = new Map(components.map((c) => [c.id, c]))
  const missing = ['src/auth/token.js#token0']
  fillMissing(mods, components, missing)
  assert.ok(mods[0].components.includes('src/auth/token.js#token0'))
})

await check('fillMissing 无处归属时建 misc', async () => {
  const mods = [{ name: 'auth', path: 'src/auth', components: [] }]
  fillMissing(mods, components, ['README.md#docs'])
  const misc = mods.find((m) => m.name === 'misc')
  assert.ok(misc, '未创建 misc 模块')
  assert.deepEqual(misc.components, ['README.md#docs'])
})

await check('moduleFiles 汇总去重源文件', async () => {
  const byId = new Map(components.map((c) => [c.id, c]))
  const files = moduleFiles(['src/auth/login.js#login0', 'src/auth/login.js#login1', 'src/auth/token.js#token0'], byId)
  assert.deepEqual(files, ['src/auth/login.js', 'src/auth/token.js'])
})

// ---------------------------------------------------------------- 无 LLM 降级
await check('无 llmCall 时走目录启发式，组件不丢', async () => {
  const r = await clusterComponents({ components })
  assert.ok(!r.stats.llm)
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length, `组件丢失：${components.length - got.size}`)
  assert.ok(r.modules.every((m) => m.files.length > 0))
})

await check('空组件集返回空结果不抛错', async () => {
  const r = await clusterComponents({ components: [] })
  assert.deepEqual(r.modules, [])
  assert.ok(r.warnings.length)
})

// ---------------------------------------------------------------- LLM 正常路径
await check('LLM 返回合法分组时按职责成模块', async () => {
  const llmCall = async () => JSON.stringify({
    modules: [
      { name: 'auth', path: 'src/auth', summary: '认证', components: allIds.filter((i) => i.includes('/auth/')) },
      { name: 'wiki_compile', path: 'src/wiki', summary: '编译', components: allIds.filter((i) => i.includes('/wiki/')) },
      { name: 'panel_ui', path: 'src/panel', summary: '面板', components: allIds.filter((i) => i.includes('/panel/')) },
      { name: 'big', path: 'src/big', summary: '大引擎', components: allIds.filter((i) => i.includes('/big/')) },
      { name: 'build', path: '', summary: '构建配置', components: ['package.json#scripts', 'README.md#docs'] },
    ],
  })
  const r = await clusterComponents({ components, llmCall, splitThreshold: 1000 })
  assert.equal(r.stats.llm, true)
  const names = r.modules.map((m) => m.name).sort()
  assert.deepEqual(names, ['auth', 'big', 'build', 'panel_ui', 'wiki_compile'])
  const auth = r.modules.find((m) => m.name === 'auth')
  assert.deepEqual(auth.files, ['src/auth/login.js', 'src/auth/token.js'])
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length)
})

await check('LLM 漏组件的部分由 fillMissing 补齐', async () => {
  const llmCall = async () => JSON.stringify({
    modules: [
      { name: 'auth', path: 'src/auth', components: allIds.filter((i) => i.includes('/auth/')) },
      { name: 'wiki_compile', path: 'src/wiki', components: allIds.filter((i) => i.includes('/wiki/')) },
      // 故意漏 panel / big / 配置
    ],
  })
  const r = await clusterComponents({ components, llmCall, splitThreshold: 1000 })
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length, `补齐后仍缺 ${components.length - got.size} 个`)
})

await check('LLM 抛错时整体降级为目录分组', async () => {
  const llmCall = async () => { throw new Error('quota exceeded') }
  const r = await clusterComponents({ components, llmCall })
  assert.ok(r.stats.fallbacks >= 1)
  assert.ok(r.warnings.some((w) => w.includes('quota exceeded')))
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length, '降级后组件不应丢失')
})

await check('LLM 返回垃圾文本时降级', async () => {
  const llmCall = async () => 'I cannot help with that'
  const r = await clusterComponents({ components, llmCall })
  assert.ok(r.stats.fallbacks >= 1)
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length)
})

// ---------------------------------------------------------------- 下钻
await check('大模块超阈值时下钻成子模块，父节点不单独成文', async () => {
  const llmCall = async (prompt) => {
    if (prompt.includes('模块「big」')) {
      const ids = allIds.filter((i) => i.includes('/big/'))
      return JSON.stringify({
        modules: [
          { name: 'big_core', path: 'src/big', summary: '核心', components: ids.slice(0, 35) },
          { name: 'big_ext', path: 'src/big', summary: '扩展', components: ids.slice(35) },
        ],
      })
    }
    return JSON.stringify({
      modules: [
        { name: 'auth', path: 'src/auth', components: allIds.filter((i) => i.includes('/auth/')) },
        { name: 'wiki_compile', path: 'src/wiki', components: allIds.filter((i) => i.includes('/wiki/')) },
        { name: 'panel_ui', path: 'src/panel', components: allIds.filter((i) => i.includes('/panel/')) },
        { name: 'big', path: 'src/big', components: allIds.filter((i) => i.includes('/big/')) },
        { name: 'build', path: '', components: ['package.json#scripts', 'README.md#docs'] },
      ],
    })
  }
  const r = await clusterComponents({ components, llmCall, splitThreshold: 60 })
  assert.equal(r.stats.levels, 2, '未进入第二层')
  const names = r.modules.map((m) => m.name).sort()
  assert.ok(names.includes('big_core'), `缺少子模块：${names}`)
  assert.ok(names.includes('big_ext'), `缺少子模块：${names}`)
  assert.ok(!names.includes('big'), '父节点不应成为文章')
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length)
  const parent = r.tree.find((m) => m.name === 'big')
  assert.ok(parent.children.length === 2)
})

await check('下钻只返回一个子模块时视为不可再分', async () => {
  const llmCall = async (prompt) => {
    if (prompt.includes('模块「big」')) {
      return JSON.stringify({ modules: [{ name: 'big', components: allIds.filter((i) => i.includes('/big/')) }] })
    }
    return JSON.stringify({
      modules: [
        { name: 'auth', path: 'src/auth', components: allIds.filter((i) => i.includes('/auth/')) },
        { name: 'big', path: 'src/big', components: allIds.filter((i) => i.includes('/big/')) },
        { name: 'other', path: 'src', components: allIds.filter((i) => !i.includes('/auth/') && !i.includes('/big/')) },
      ],
    })
  }
  const r = await clusterComponents({ components, llmCall, splitThreshold: 30 })
  assert.ok(r.modules.some((m) => m.name === 'big'), '单子模块时不应拆开')
})

await check('下钻抛错不影响整体结果', async () => {
  const llmCall = async (prompt) => {
    if (prompt.includes('模块「big」')) throw new Error('boom')
    return JSON.stringify({
      modules: [
        { name: 'big', path: 'src/big', components: allIds.filter((i) => i.includes('/big/')) },
        { name: 'rest', path: 'src', components: allIds.filter((i) => !i.includes('/big/')) },
      ],
    })
  }
  const r = await clusterComponents({ components, llmCall, splitThreshold: 30 })
  assert.ok(r.modules.some((m) => m.name === 'big'))
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length)
})

// ---------------------------------------------------------------- 超级分组
await check('顶层模块过多时归成子系统', async () => {
  const llmCall = async (prompt) => {
    if (prompt.includes('架构子系统')) {
      return JSON.stringify({
        subsystems: [
          { name: 'core', modules: ['auth', 'wiki_compile'] },
          { name: 'ui', modules: ['panel_ui', 'build'] },
        ],
      })
    }
    return JSON.stringify({
      modules: [
        { name: 'auth', path: 'src/auth', components: allIds.filter((i) => i.includes('/auth/')) },
        { name: 'wiki_compile', path: 'src/wiki', components: allIds.filter((i) => i.includes('/wiki/')) },
        { name: 'panel_ui', path: 'src/panel', components: allIds.filter((i) => i.includes('/panel/')) },
        { name: 'big', path: 'src/big', components: allIds.filter((i) => i.includes('/big/')) },
        { name: 'build', path: '', components: ['package.json#scripts', 'README.md#docs'] },
      ],
    })
  }
  const r = await clusterComponents({ components, llmCall, splitThreshold: 1000, topFanout: 3 })
  const parents = r.tree.filter((m) => m.children?.length).map((m) => m.name).sort()
  assert.deepEqual(parents, ['core', 'ui'], `未生成子系统：${parents}`)
  const got = new Set(r.modules.flatMap((m) => m.components))
  assert.equal(got.size, components.length)
})

await check('parseSuperGroups 对未归类模块保留在顶层', async () => {
  const mods = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  const out = parseSuperGroups(JSON.stringify({ subsystems: [{ name: 'x', modules: ['a', 'b'] }] }), mods, [])
  assert.equal(out.length, 2)
  assert.equal(out[0].children.length, 2)
  assert.equal(out[1].name, 'c')
})

await check('parseSuperGroups 忽略不存在模块名', async () => {
  const warnings = []
  const out = parseSuperGroups(JSON.stringify({ subsystems: [{ name: 'x', modules: ['a', 'ghost'] }] }), [{ name: 'a' }], warnings)
  assert.equal(out[0].children.length, 1)
  assert.ok(warnings.some((w) => w.includes('ghost')))
})

// ---------------------------------------------------------------- plan 转换
await check('toPlanModules 输出插件任务清单形状', async () => {
  const r = await clusterComponents({ components })
  const plan = toPlanModules(r)
  assert.ok(plan.length)
  for (const m of plan) {
    assert.equal(typeof m.name, 'string')
    assert.ok(Array.isArray(m.files) && m.files.length > 0)
    assert.equal(typeof m.summary, 'string')
  }
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label} ---\n${f.err.stack}`)
}
process.exit(fails.length ? 1 : 0)
