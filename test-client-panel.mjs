// 面板渲染冒烟：client.js 的侧边栏面板必须在 Node 桩环境里渲染一次不抛异常。
//
// 为什么需要这一层：面板的渲染函数多数定义在 CodewikiPanel 之外（模块作用域），
// 它们闭包里拿不到组件内 `const t = tBound`。0.17.2 就因此让整个面板白屏成
// `Panel error: ReferenceError: t is not defined`——纯语法检查与协议层测试都发现不了，
// 只有真的把组件渲染一遍才会炸。
//
// 这里用最小 React 桩代替浏览器：只做「调用函数组件 + 展开元素树」，不模拟协调器。
// 目标是捕获渲染期抛错和缺失的文案 key，不是验证 DOM 细节。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

const JOB = {
  id: 'job-panel-smoke',
  cwd: 'C:/repo/demo',
  kind: 'native',
  channel: 'native',
  stage: 'done',
  createdAt: '2026-11-02T00:00:00.000Z',
  finishedAt: '2026-11-02T00:02:00.000Z',
  updatedAt: '2026-11-02T00:02:00.000Z',
  writtenCount: 3,
  failedCount: 1,
  articles: [{ name: 'a.md', ok: true }],
  taskList: [{ name: 'a.md', state: 'done' }],
  blockers: [],
  notes: ['note one'],
  nativeStage: 'commit',
  nativePercent: 100,
  nativeLogs: [
    { at: '2026-11-02T00:01:00.000Z', phase: 'articles', kind: 'progress', detail: 'wrote a.md' },
    { at: '2026-11-02T00:01:10.000Z', kind: 'http', method: 'POST', path: '/v1/chat', status: 200, ms: 1200 },
  ],
  logFile: 'C:/logs/job-panel-smoke.ndjson',
  autoCommit: { committed: true, sha: 'abc12345', branch: 'codewiki/wiki-job-panel-smoke' },
  usage: { requests: 12, inputTokens: 3400, outputTokens: 900 },
  stageTimings: { articles: 60000, commit: 500 },
}

// ── 最小 React / 平台桩 ────────────────────────────────────────────────────
// 每个组件实例持有自己的 hook 槽位：按「组件 + 调用序号」分桶。共用一份数组会让
// 父组件与子组件互相覆盖 state（表现是会话页拿到别的组件的 state，报
// `(list ?? []).find is not a function`），那样测出来的结论是假的。
const makeReact = () => {
  const buckets = new Map()
  const cleanups = []
  let current = null
  let cursor = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(init) {
      const i = cursor++
      const bucket = buckets.get(current) ?? []
      buckets.set(current, bucket)
      if (!(i in bucket)) bucket[i] = typeof init === 'function' ? init() : init
      return [bucket[i], (v) => { bucket[i] = typeof v === 'function' ? v(bucket[i]) : v }]
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useEffect(fn) {
      cursor++
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    useRef(init) {
      const i = cursor++
      const bucket = buckets.get(current) ?? []
      buckets.set(current, bucket)
      if (!(i in bucket)) bucket[i] = { current: init }
      return bucket[i]
    },
  }
  // 渲染一个函数组件：切成它自己的槽位桶，返回时恢复父组件的游标
  const renderComponent = (comp, props) => {
    const parent = current
    const parentCursor = cursor
    current = comp
    cursor = 0
    try {
      return comp(props)
    } finally {
      current = parent
      cursor = parentCursor
    }
  }
  // render 需要能调回 renderComponent：挂在 React 上，避免每个调用点都多传一个参数
  React.renderComponent = renderComponent
  return { React, reset: () => { cursor = 0 }, cleanups }
}

// 会话端点的桩数据；用例可改写它来验证「有进行中任务但还没发请求」这类形态
let SESSIONS_PAYLOAD = { sessions: [], active: [] }
// 总览页数据；用例可改写它来验证仓库列表与空态
let REPOS_PAYLOAD = {
  scheduler: { enabled: true, intervalMin: 30, scanning: false, lastScan: '2026-11-02T00:00:00.000Z', lastScanRepos: 3 },
  repos: [
    { cwd: 'C:/repo/demo', state: 'stale', staleArticles: 2, changedFiles: 5, articleCount: 18, needsConfirm: false, excluded: false, lastJob: null },
    { cwd: 'C:/repo/fresh', state: 'uncompiled', articleCount: 0, needsConfirm: true, excluded: false, lastJob: null },
  ],
}

const platform = () => {
  globalThis.document = {
    createElement: () => ({ dataset: {}, set textContent(v) {}, appendChild() {}, remove() {} }),
    head: { appendChild() {}, querySelector: () => null },
  }
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      const u = String(url)
      if (u.endsWith('/api/codewiki/jobs')) return { jobs: [JOB] }
      if (u.endsWith('/api/codewiki/repos')) return REPOS_PAYLOAD
      if (u.includes('/api/codewiki/sessions')) return SESSIONS_PAYLOAD
      return {}
    },
  })
}

const loadPlugin = (react) => {
  let registered = null
  globalThis.window = { __ModuleLoader__: { load: (m) => { registered = m } } }
  const require = (name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      const passthrough = ({ children }) => children ?? null
      return { Switch: passthrough, Button: passthrough, Input: passthrough, Tag: passthrough }
    }
    throw new Error(`面板冒烟：未预期的 require(${name})`)
  }
  new Function('window', 'require', SOURCE)(globalThis.window, require)
  assert.ok(registered, 'client.js 未通过 __ModuleLoader__ 注册模块')
  return { plugin: registered.factory(require), require }
}

// 把元素树摊平成 HTML 串；函数组件就地调用，闭包捕获的渲染异常会直接冒出来。
// 组件调用必须走 renderComponent：它是唯一会切换到该组件自己的 hook 槽位桶的地方。
const render = (node, react) => {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => render(n, react)).join('')
  if (node.type === react.Fragment) return render(node.children, react)
  // 函数组件要拿到 children：createElement 把子节点放在第三个参数之后，桩若只透传 props，
  // 所有 Button/Tag/Switch 的子内容都会渲染成空——断言「按钮文案在」时会被误判成缺失。
  if (typeof node.type === 'function') {
    const props = node.children.length ? { ...node.props, children: node.children } : node.props
    return render(react.renderComponent(node.type, props), react)
  }
  const attrs = Object.entries(node.props ?? {})
    // style 也序列化：分段带的阶段色相只住在 style 里（--seg-hue），
    // 不输出就断言不到「各段颜色互不相同」。
    .filter(([k]) => k.startsWith('data-') || k === 'style')
    .map(([k, v]) => {
      if (k !== 'style') return ` ${k}="${String(v)}"`
      const css = Object.entries(v ?? {}).map(([p, val]) => `${p}: ${val}`).join('; ')
      return ` style="${css}"`
    })
    .join('')
  return `<${node.type ?? 'div'}${attrs}>${render(node.children, react)}</${node.type ?? 'div'}>`
}

// ── 用例 ───────────────────────────────────────────────────────────────────

let pass = 0
const fails = []
const check = async (label, fn) => {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const mountPanel = (tFactory = null) => {
  const { React, reset, cleanups } = makeReact()
  platform()
  reset()
  const { plugin } = loadPlugin(React)
  let Panel = null
  const ctx = {
    // bind 返回可辨识的包装值：裸键名出现在输出里就说明某处没走 t()。
    // tFactory 只给「必须看到插值结果」的用例用（例如分组条数 {n}）。
    locale: { bind: () => tFactory ?? ((key) => `«${key}»`), register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
    configForms: {
      // subscribe 必须存在：设置页的 CodewikiCard 会订阅 snapshot 变化，缺了它
      // 整个设置 Tab 会在渲染期抛 TypeError（此前没有任何用例渲染过设置页）。
      get: () => ({
        getSnapshot: () => ({ status: 'ready', revision: 1, value: {}, writable: true, subscribe: () => () => {} }),
        subscribe: () => () => {},
        mutate: async () => ({}),
      }),
      whileServed: () => () => {},
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (def, comp) => { if (def?.name === 'main') Panel = comp; return () => {} },
    },
  }
  plugin.apply(ctx)
  assert.ok(Panel, '未注册侧边栏 main 面板组件')
  return { Panel, React, reset, cleanups }
}

// 面板首帧只有 loading，轮询回包需要一次微任务；渲染若干轮直到出现任务标题或超时
const settle = async (Panel, React, reset) => {
  let html = ''
  for (let i = 0; i < 12; i++) {
    reset()
    html = render(React.renderComponent(Panel, {}), React)
    if (/job-panel-smoke|data-dscw-p-logline/.test(html)) return html
    await new Promise((r) => setTimeout(r, 5))
  }
  return html
}

// 点某个 Tab：面板默认停在总览，任务卡片（jobCard / engineLogBlock）只在任务页渲染，
// 会话列表只在会话页渲染。这里直接调用 Tab 按钮的 onClick，等价于点一下，不模拟事件系统。
const gotoTab = (Panel, React, reset, key = 'tabTasks') => {
  const findTab = (node) => {
    if (node == null || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(findTab).find(Boolean) ?? null
    if (node.type === React.Fragment) return findTab(node.children)
    // 只遍历元素节点：函数组件重入会推进 hook 游标，让 onClick 改到错位的 state 槽。
    // 面板把 Tab 按钮直接放在顶层元素树里，不需要下钻组件。
    if (node.type === 'button' && String(render(node.children, React)).includes(`«${key}»`)) return node
    return findTab(node.children)
  }
  reset()
  const tree = React.renderComponent(Panel, {})   // 唯一一次渲染：hook 游标从这里开始
  reset()
  const tab = findTab(tree)   // 遍历复用的是这份树，不再重入组件
  assert.ok(tab, `未找到「${key}」Tab 按钮`)
  tab.props.onClick()
}

// settle 的退出条件是「出现任务标识就返回」——点进会话视图后任务页内容仍在 DOM 里，
// 它会立刻交出上一帧。需要等特定结构出现时用这个版本。
const settleUntil = async (Panel, React, reset, want, rounds = 20) => {
  let html = ''
  for (let i = 0; i < rounds; i++) {
    reset()
    html = render(React.renderComponent(Panel, {}), React)
    if (want.test(html)) return html
    await new Promise((r) => setTimeout(r, 5))
  }
  return html
}

// 按文案点任意「带 onClick 的节点」：任务卡里的「会话」按钮是宿主 Button 组件，
// 桩环境里被 passthrough 掉，不会渲染成 <button>，gotoTab 的判据在这里不适用。
const clickByLabel = (Panel, React, reset, key) => {
  const find = (node) => {
    if (node == null || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null
    if (node.type === React.Fragment) return find(node.children)
    const text = String(render(node.children, React))
    if (typeof node.props?.onClick === 'function' && text.includes(`«${key}»`)) return node
    return find(node.children)
  }
  reset()
  const tree = React.renderComponent(Panel, {})   // 展开当前 Tab 的元素树
  reset()
  const hit = find(tree)
  assert.ok(hit, `未找到「${key}」按钮`)
  hit.props.onClick()
}

// 步骤条每个阶段都必须有字典项：漏一个就在面板上显示裸键名。真机截图里第 7 项就这样
// 显示了 stepCommit —— 0.17.5 把「提交」接进步骤条，却没有补对应文案。
// 0.17.31 起步骤条对齐真实流程：排队／准备／文章／校对／校验／索引／提交，
// 「横切」（crosscut）在原生通道里永远不会发生，已从步骤条移除。
const STEP_KEYS = [
  'stepQueued', 'stepPrepare', 'stepArticles', 'stepReview', 'stepValidate', 'stepIndex', 'stepCommit',
]

await check('面板：步骤条每个阶段都有中英文文案（防裸键名）', async () => {
  let dicts = null
  const react = makeReact()
  platform()
  const { plugin } = loadPlugin(react.React)
  plugin.apply({
    locale: { bind: () => (k) => k, register: (_ns, d) => { dicts = d; return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ status: 'ready', revision: 1, value: {}, writable: true, subscribe: () => () => {} }), mutate: async () => ({}) }),
      whileServed: () => () => {},
    },
    slots: { inject: (_n, fn) => fn(), register: () => () => {} },
  })
  assert.ok(dicts?.zh && dicts?.en, '插件没有注册中英文字典')
  for (const locale of ['zh', 'en']) {
    for (const key of STEP_KEYS) {
      assert.equal(typeof dicts[locale][key], 'string', `${locale} 字典缺步骤键 ${key}`)
      assert.ok(dicts[locale][key].length > 0, `${locale} 字典的 ${key} 是空串`)
    }
  }
})

await check('面板：含引擎日志的已完成任务能渲染，不出现 Panel error', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `面板渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-engine-log/.test(html), '缺少引擎日志块')
    assert.ok(/data-dscw-p-logline/.test(html), '缺少引擎日志行')
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 清理失败不影响用例结论 */ } })
  }
})

await check('面板：模块级渲染辅助函数都能解析到文案函数（回归 t is not defined）', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(/«panelTitle»/.test(html), '基准文案未经过 t()，桩环境有问题')
    // 未翻译的裸键名（如 engineLogLabel）漏进输出，说明该处没调用 t()
    const raw = [...html.matchAll(/>\s*([a-z][A-Za-z0-9]{3,})\s*(?:\(\d+\))?\s*</g)]
      .map((m) => m[1])
      .filter((key) => /^(engineLog|nativeStage|autoCommit|writtenLabel|panelTitle|tabTasks)/.test(key))
    assert.deepEqual(raw, [], `文案键被原样输出，说明该处没调用 t()：${raw.join(', ')}`)
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

await check('会话页：任务正在跑但还没发出请求时，也要列出这个任务（回归「会话页看不到进行中任务」）', async () => {
  SESSIONS_PAYLOAD = {
    sessions: [],
    active: [{
      jobId: 'job-running-1', cwd: 'C:/repo/running', stage: 'articles',
      nativeStage: 'cluster', nativePercent: 36, kind: 'stale', auto: false,
      startedAt: '2026-11-02T00:00:00.000Z', writtenCount: 3, batchProgress: null, requests: 0,
    }],
  }
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset, 'tabSessions')
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `会话页渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-activerow/.test(html), '没有渲染进行中任务行')
    assert.ok(/running-1/.test(html), '进行中任务行缺少任务标识（jobTag 去掉 job- 前缀）')
    assert.ok(!/«sessEmpty»/.test(html), '有进行中任务时仍显示「暂无会话记录」')
    assert.ok(/«sessActiveNoRequest»/.test(html), '零请求的进行中任务未标注「尚未发出请求」')
  } finally {
    SESSIONS_PAYLOAD = { sessions: [], active: [] }
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

await check('会话页：已有请求记录时进行中任务标注请求数', async () => {
  SESSIONS_PAYLOAD = {
    sessions: [{ n: 1, jobId: 'job-running-2', name: 'a.md', status: 'running', startedAt: '2026-11-02T00:00:00.000Z' }],
    active: [{
      jobId: 'job-running-2', cwd: 'C:/repo/r2', stage: 'articles', nativeStage: 'articles',
      nativePercent: 40, kind: 'stale', auto: false, startedAt: '2026-11-02T00:00:00.000Z',
      writtenCount: 5, batchProgress: null, requests: 1,
    }],
  }
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset, 'tabSessions')
    const html = await settle(Panel, React, reset)
    assert.ok(/data-dscw-p-activerow/.test(html) && /data-dscw-p-sessrow/.test(html), '进行中任务与请求行应同时出现')
    assert.ok(/«sessActiveRequests»/.test(html), '有请求时应显示「已发 N 个请求」')
  } finally {
    SESSIONS_PAYLOAD = { sessions: [], active: [] }
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 总览页从「每个仓库一个描边盒子」改成「列表 + 行级分隔线」之后，仓库行必须仍然渲染。
// 这条用例挡的是「改样式时把 map 包错一层，仓库整块消失」——探针期间就发生过一次。
await check('总览页：仓库列表渲染在 repolist 容器里，待确认仓库带确认按钮', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `总览页渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-repolist=/.test(html), '缺少仓库列表容器')
    assert.equal((html.match(/data-dscw-p-repo=/g) ?? []).length, REPOS_PAYLOAD.repos.length, '仓库行数与数据不符')
    assert.ok(/«confirmCompile»/.test(html), '待确认仓库没有渲染确认按钮')
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 空态：一句灰字看不出「是空还是没加载完」。空态块必须带一个标题（<strong>），
// 而不是只有一个 span —— 这是 redesign 里补的 empty state 的验收点。
await check('空态：任务页没有任务时给出带标题的引导块', async () => {
  const prev = globalThis.fetch
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).endsWith('/api/codewiki/jobs') ? { jobs: [] } : REPOS_PAYLOAD),
    })
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `空态渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-empty=""><strong[^>]*>[^<]+</.test(html), '空态块缺少标题')
    assert.ok(/«emptyTasksTitle»/.test(html), '空态标题没有走文案字典')
  } finally {
    globalThis.fetch = prev
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 设置页：分组必须有 data-dscw-sec（样式挂了分隔线），保存条要 sticky。
// 这条同时是「设置 Tab 能在桩环境里渲染」的唯一护栏——之前它根本没人渲染过。
await check('设置页：分组容器与粘底保存条就位', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset, 'tabSettings')
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `设置页渲染抛错：${html.slice(0, 400)}`)
    assert.ok((html.match(/data-dscw-sec=/g) ?? []).length >= 5, '设置页分组数不足')
    assert.ok(/data-dscw-bar=/.test(html), '缺少保存条')
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 总览的第一件事是回答「有多少仓要处理、现在在跑什么」，不是把仓库列表再抄一遍。
// 统计条是这一步的验收点：五格数字必须都渲染，且待确认/有变更非零时要点成 warn。
await check('总览页：统计条渲染五格数字，待确认非零时标成 warn', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `总览页渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-stats=/.test(html), '缺少统计条')
    const cells = html.match(/data-dscw-p-stat=/g) ?? []
    assert.equal(cells.length, 5, `统计条格数应为 5，实际 ${cells.length}`)
    // REPOS_PAYLOAD 里有一个 needsConfirm 仓库 → 待确认格必须是 warn
    assert.ok(/data-dscw-p-stat="" data-tone="warn"><b>1<\/b>/.test(html), '待确认非零时该格应标 warn')
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 待办优先：需要人动手的两档（待确认 0 / 有变更 1）必须排在「干净的」前面。
// 这条挡的是「排序被写成按 cwd 字典序」——那样每天最该点的几行会被推来推去。
await check('总览页：待确认与有变更排在干净的前面', async () => {
  REPOS_PAYLOAD = {
    scheduler: { enabled: true, intervalMin: 30, scanning: false, lastScan: '2026-11-02T00:00:00.000Z' },
    repos: [
      { cwd: 'C:/repo/aaa-clean', state: 'clean', articleCount: 9, needsConfirm: false, excluded: false, lastJob: null },
      { cwd: 'C:/repo/zzz-stale', state: 'stale', staleArticles: 1, changedFiles: 2, articleCount: 9, needsConfirm: false, excluded: false, lastJob: null },
    ],
  }
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    const order = [...html.matchAll(/data-dscw-p-repo="" data-rank="(\d)"[^>]*>(.*?)<\/div>/gs)]
    assert.ok(order.length >= 2, '仓库行没渲染出来')
    const firstRank = Number(order[0][1])
    assert.ok(firstRank <= 1, `排第一的行 rank=${firstRank}，应是最需要动手的那档`)
    assert.ok(/zzz-stale/.test(order[0][2]), '有变更的仓库没有排在最前')
  } finally {
    REPOS_PAYLOAD = {
      scheduler: { enabled: true, intervalMin: 30, scanning: false, lastScan: '2026-11-02T00:00:00.000Z', lastScanRepos: 3 },
      repos: [
        { cwd: 'C:/repo/demo', state: 'stale', staleArticles: 2, changedFiles: 5, articleCount: 18, needsConfirm: false, excluded: false, lastJob: null },
        { cwd: 'C:/repo/fresh', state: 'uncompiled', articleCount: 0, needsConfirm: true, excluded: false, lastJob: null },
      ],
    }
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 全局会话里几十条请求分属多个仓库，平铺时「这条属于哪个仓」只能靠行尾目录名去认。
// 分组头是唯一的仓库上下文，所以必须真的按 cwd 分组、且条数写对。
await check('会话页：全局视图按工作区分组，条数与仓库名对得上', async () => {
  SESSIONS_PAYLOAD = {
    sessions: [
      { n: 1, jobId: 'job-a', cwd: 'C:/repo/alpha', name: 'a.md', status: 'done', startedAt: '2026-11-02T00:02:00.000Z' },
      { n: 2, jobId: 'job-a', cwd: 'C:/repo/alpha', name: 'b.md', status: 'done', startedAt: '2026-11-02T00:01:00.000Z' },
      { n: 3, jobId: 'job-b', cwd: 'C:/repo/beta', name: 'c.md', status: 'done', startedAt: '2026-11-02T00:03:00.000Z' },
    ],
    active: [],
  }
  // {n} 必须能看出被替换成了真实条数，否则「2 条请求写成一坨」也照样通过
  const t = (key) => (key === 'sessGroupCount' ? '{n} 条请求' : `«${key}»`)
  const { Panel, React, reset, cleanups } = mountPanel(t)
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset, 'tabSessions')
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `会话页渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-sessgroups=/.test(html), '缺少工作区分组容器')
    assert.equal((html.match(/data-dscw-p-sessgroup=/g) ?? []).length, 2, '应按 2 个仓库分成两组')
    assert.ok(/alpha/.test(html) && /beta/.test(html), '分组头缺少仓库名')
    assert.equal((html.match(/data-dscw-p-sessrow=/g) ?? []).length, 3, '分组里的请求行总数应为 3')
    // beta 的最新一条（00:03）比 alpha（00:02）晚，所以 beta 组排在前面
    const firstGroup = html.slice(html.indexOf('data-dscw-p-sessgroup='), html.indexOf('data-dscw-p-sessgroup=', html.indexOf('data-dscw-p-sessgroup=') + 1))
    assert.ok(/beta/.test(firstGroup), '最近活动的工作区应排在第一组')
    assert.ok(/2 条请求/.test(html) && /1 条请求/.test(html), '分组头的条数不对')
    assert.ok(!/\{n\}/.test(html), '分组条数的 {n} 占位符没被替换')
  } finally {
    SESSIONS_PAYLOAD = { sessions: [], active: [] }
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 单任务视图只有一个仓，再套一层分组容器就是纯粹的多余嵌套。
// 这条真的点进单任务视图（任务卡的「会话」按钮）再断言，而不是在全局视图下凑数。
await check('会话页：单任务视图不再分组', async () => {
  SESSIONS_PAYLOAD = {
    sessions: [{ n: 1, jobId: 'job-panel-smoke', cwd: 'C:/repo/demo', name: 'a.md', status: 'done', startedAt: '2026-11-02T00:01:00.000Z' }],
    active: [],
  }
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)                       // 先到任务页
    await settle(Panel, React, reset)
    clickByLabel(Panel, React, reset, 'sessBtn')       // 点「会话」进单任务视图
    const html = await settleUntil(Panel, React, reset, /data-dscw-p-sessrow=|data-dscw-p-empty=/)
    assert.ok(!/Panel error:/.test(html), `单任务会话视图渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-sessrow=/.test(html), '单任务视图里没有请求行')
    assert.ok(!/data-dscw-p-sessgroups=/.test(html), '单任务视图不该出现工作区分组容器')
    assert.ok(!/data-dscw-p-sessgroup=/.test(html), '单任务视图不该出现分组头')
  } finally {
    SESSIONS_PAYLOAD = { sessions: [], active: [] }
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 设置页从「一列到底」改成分类卡片：卡片容器存在、每张卡片是 data-dscw-sec。
await check('设置页：分组包在 cards 容器里，每张卡是独立 section', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset, 'tabSettings')
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `设置页渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-cards=/.test(html), '缺少卡片容器')
    assert.ok((html.match(/data-dscw-sec=/g) ?? []).length >= 5, '卡片数不足 5 张')
    // 卡片容器必须包住所有 section，而不是和它们平级
    assert.ok(/data-dscw-cards=""><section data-dscw-sec=/.test(html), 'section 没有被 cards 容器包住')
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 自动保存：没有保存按钮了，改为状态行。状态行的存在本身就是「改动会自动落盘」的凭据，
// 而 data-state 让用户能看出当前是保存中、已保存还是失败。
await check('设置页：保存按钮换成自动保存状态行', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset, 'tabSettings')
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `设置页渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-bar="" data-state=/.test(html), '缺少带状态的自动保存行')
    assert.ok(/data-dscw-savestate=/.test(html), '缺少保存状态文案')
    assert.ok(!/«save»/.test(html) && !/«discard»/.test(html), '保存/放弃按钮应已移除')
  } finally {
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 终态只显示一条绿色满格进度条，等于把「时间花在哪」整个丢掉了——而 stageTimings
// 从 0.5.0 起就一直落盘。这条用例锁住：任务结束后分段带的段宽改成真实耗时，
// 图例直接写耗时读数，且排队不计入（排队是等别人，真机上常比整个编译还长）。
await check('任务页：已完成任务的分段带按真实耗时给出各阶段读数', async () => {
  const prev = globalThis.fetch
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).endsWith('/api/codewiki/jobs')
        ? { jobs: [{ ...JOB, stageTimings: { queued: 300000, prepare: 5000, articles: 60000, validate: 41, index: 8879, commit: 500 } }] }
        : REPOS_PAYLOAD),
    })
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `终态渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-legend/.test(html), '终态缺少阶段图例')
    assert.ok(/«stepArticles» 01:00/.test(html), `文章阶段应显示 01:00：${html.slice(0, 600)}`)
    assert.ok(/«stepCommit» 500ms/.test(html), '亚秒阶段应显示毫秒而不是 00:00')
    assert.ok(!/«stepQueued»/.test(html), '排队不该进耗时带（它是等别人，不是编译做了什么）')
    // 段数 = 有耗时的阶段数（prepare/articles/validate/index/commit 五项）
    assert.equal((html.match(/data-dscw-p-seg=""/g) ?? []).length, 5, '分段数应等于有耗时的阶段数')
    // 0.17.46：整张卡只有一条条子。分段带就是进度条本体，不能再并出第二条纯色填充条。
    assert.equal((html.match(/data-dscw-p-progress=""/g) ?? []).length <= 1, true, '进度行最多一条')
    assert.equal((html.match(/data-dscw-p-bar=""/g) ?? []).length, 0, '有分段信息时不该再画纯色填充条')
    // 各段按阶段身份着色：色相必须互不相同，否则「时间花在哪」在图上分不出来。
    // 分段带与图例各引用一次色相（同序），所以去重后应恰等于阶段数。
    const hues = [...html.matchAll(/--seg-hue:\s*(\d+)/g)].map((m) => m[1])
    assert.ok(hues.length >= 5, `分段应带 --seg-hue：${hues.join(',')}`)
    assert.equal(new Set(hues).size, 5, `五个阶段的色相必须互不相同：${hues.join(',')}`)
    assert.equal(hues.slice(0, 5).join(','), hues.slice(5, 10).join(','), '图例色相必须与分段带同序一致')
  } finally {
    globalThis.fetch = prev
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 0.5.0 之前的任务没有 stageTimings，终态画一条全是 0 的空白带只是噪声。
await check('任务页：没有 stageTimings 的老任务不画耗时带', async () => {
  const prev = globalThis.fetch
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).endsWith('/api/codewiki/jobs') ? { jobs: [{ ...JOB, stageTimings: null }] } : REPOS_PAYLOAD),
    })
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `渲染抛错：${html.slice(0, 400)}`)
    assert.ok(!/data-dscw-p-segbar/.test(html), '无耗时的老任务不该出现空的分段带')
    assert.ok(!/data-dscw-p-legend/.test(html), '无耗时的老任务不该出现空图例')
  } finally {
    globalThis.fetch = prev
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

// 进行中的带子仍是进度语义：段宽=权重、读数=百分比。改终态不能把这条带偏。
await check('任务页：进行中的分段带仍按进度百分比读数', async () => {
  const prev = globalThis.fetch
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).endsWith('/api/codewiki/jobs')
        ? {
          jobs: [{
            ...JOB, stage: 'articles', finishedAt: null, nativeStage: 'articles', nativePercent: 40,
            stageStartedAt: '2026-11-02T00:01:00.000Z', notes: [],
          }],
        }
        : REPOS_PAYLOAD),
    })
    await settle(Panel, React, reset)
    gotoTab(Panel, React, reset)
    const html = await settle(Panel, React, reset)
    assert.ok(!/Panel error:/.test(html), `进行中渲染抛错：${html.slice(0, 400)}`)
    assert.ok(/data-dscw-p-legend/.test(html), '进行中缺少阶段图例')
    assert.ok(/«stepArticles» \d+%/.test(html), '进行中的读数应为百分比')
  } finally {
    globalThis.fetch = prev
    cleanups.forEach((fn) => { try { fn() } catch { /* 同上 */ } })
  }
})

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
