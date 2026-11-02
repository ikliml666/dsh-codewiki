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
const makeReact = () => {
  const state = []
  const cleanups = []
  let cursor = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(init) {
      const i = cursor++
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
    },
    useEffect(fn) {
      cursor++
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    useRef(init) {
      const i = cursor++
      if (!(i in state)) state[i] = { current: init }
      return state[i]
    },
  }
  return { React, reset: () => { cursor = 0 }, cleanups }
}

const platform = () => {
  globalThis.document = {
    createElement: () => ({ dataset: {}, set textContent(v) {}, appendChild() {}, remove() {} }),
    head: { appendChild() {}, querySelector: () => null },
  }
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('/api/codewiki/jobs') ? { jobs: [JOB] } : {}),
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

// 把元素树摊平成 HTML 串；函数组件就地调用，闭包捕获的渲染异常会直接冒出来
const render = (node, react) => {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => render(n, react)).join('')
  if (node.type === react.Fragment) return render(node.children, react)
  if (typeof node.type === 'function') return render(node.type(node.props), react)
  const attrs = Object.entries(node.props ?? {})
    .filter(([k]) => k.startsWith('data-'))
    .map(([k, v]) => ` ${k}="${String(v)}"`)
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

const mountPanel = () => {
  const { React, reset, cleanups } = makeReact()
  platform()
  reset()
  const { plugin } = loadPlugin(React)
  let Panel = null
  const ctx = {
    // bind 返回可辨识的包装值：裸键名出现在输出里就说明某处没走 t()
    locale: { bind: () => (key) => `«${key}»`, register: () => () => {} },
    effect: (fn) => { fn(); return () => {} },
    configForms: {
      get: () => ({ getSnapshot: () => ({ values: {}, writable: true }), mutate: async () => ({}) }),
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
    html = render(Panel({}), React)
    if (/job-panel-smoke|data-dscw-p-logline/.test(html)) return html
    await new Promise((r) => setTimeout(r, 5))
  }
  return html
}

// 点「任务」Tab：面板默认停在总览，任务卡片（jobCard / engineLogBlock）只在任务页渲染。
// 这里直接调用 Tab 按钮的 onClick，等价于点一下，不模拟事件系统。
const gotoTaskTab = (Panel, React, reset) => {
  const findTab = (node) => {
    if (node == null || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(findTab).find(Boolean) ?? null
    if (node.type === React.Fragment) return findTab(node.children)
    if (typeof node.type === 'function') return findTab(node.type(node.props))
    if (node.type === 'button' && String(render(node.children, React)).includes('«tabTasks»')) return node
    return findTab(node.children)
  }
  reset() // hook 游标从头开始，否则 onClick 只改到错位的 state 槽
  const tab = findTab(Panel({}))
  assert.ok(tab, '未找到「任务」Tab 按钮')
  tab.props.onClick()
}

await check('面板：含引擎日志的已完成任务能渲染，不出现 Panel error', async () => {
  const { Panel, React, reset, cleanups } = mountPanel()
  try {
    await settle(Panel, React, reset)
    gotoTaskTab(Panel, React, reset)
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
    gotoTaskTab(Panel, React, reset)
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

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
