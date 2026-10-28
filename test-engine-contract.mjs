// FSoft 原生引擎契约测试（阶段 0）。
//
// 背景：迁移目标是把「Node 重新实现 FSoft 算法」换成「FSoft 原生引擎 + 薄适配层」。
// 一旦 Node 侧不再自己算依赖图/聚类/增量，跨进程边界就成了唯一的真相来源——
// 于是这个边界必须先有**版本化、可校验、可断言失败**的契约，否则后面所有阶段
// （桥、JobService、cw 索引、自动提交）都会在「引擎返回了什么」上各猜一套。
//
// 本文件钉死两件事：
//   1. 引擎结果的形状与语义（EngineResult / EngineProgress / EngineError）——
//      尤其是「done 不许带阻塞原因」「partial 必须带阻塞原因」「失败必须可机读」；
//   2. FSoft 产物到 CodeWiki.md / .codewiki/ 的映射——父页、artifact、未映射页
//      各有明确去处，绝不允许「静默丢弃」或「强塞进四类文章」。
import assert from 'node:assert/strict'
import {
  ENGINE_CONTRACT_VERSION,
  ENGINE_STAGES,
  TERMINAL_OUTCOMES,
  engineError,
  engineProgress,
  engineResult,
  validateEngineResult,
  describeEngineResult,
} from './lib/engine/contract.js'
import {
  mapFsoftOutput,
  moduleSlug,
  WIKI_ENTRY,
  WIKI_UPDATE_RECORD_REL,
  WIKI_META_REL,
} from './lib/engine/mapping.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

// ---------------------------------------------------------------------------
// 契约形状
// ---------------------------------------------------------------------------

await check('契约版本是显式数字，阶段顺序固定且覆盖流水线全链', async () => {
  assert.equal(ENGINE_CONTRACT_VERSION, 1)
  assert.deepEqual(ENGINE_STAGES, ['env', 'graph', 'cluster', 'articles', 'validate', 'index', 'baseline', 'commit'])
  assert.deepEqual([...TERMINAL_OUTCOMES].sort(), ['cancelled', 'done', 'failed', 'partial'])
})

await check('engineResult：非终态 outcome 直接抛错（不做静默归一）', async () => {
  assert.throws(() => engineResult({ outcome: 'running' }), /outcome/)
  assert.throws(() => engineResult({}), /outcome/)
})

await check('engineResult：done 带阻塞原因是非法的——done 表示完整成功', async () => {
  assert.throws(
    () => engineResult({ outcome: 'done', blockers: [{ kind: 'article-failed', detail: '缺 frontmatter' }] }),
    /done/,
  )
})

await check('engineResult：partial 必须有可机读阻塞原因，否则等于把失败伪装成部分成功', async () => {
  assert.throws(() => engineResult({ outcome: 'partial' }), /partial/)
  const r = engineResult({
    outcome: 'partial',
    blockers: [{ kind: 'article-failed', detail: '缺 frontmatter', target: 'modules/a.md' }],
  })
  assert.equal(r.outcome, 'partial')
  assert.equal(r.blockers.length, 1)
  assert.equal(r.blockers[0].kind, 'article-failed')
  assert.equal(r.contractVersion, ENGINE_CONTRACT_VERSION)
})

await check('engineResult：数字字段归一为非负数，缺失即 0（面板与终态判定共用同一份数）', async () => {
  const r = engineResult({ outcome: 'done', writtenCount: 3 })
  assert.equal(r.writtenCount, 3)
  assert.equal(r.failedCount, 0)
  assert.equal(r.keptCount, 0)
  assert.equal(r.removedCount, 0)
  assert.equal(r.usage.inputTokens, 0)
  const bad = engineResult({ outcome: 'done', writtenCount: -1 })
  assert.equal(bad.writtenCount, 0)
})

await check('engineProgress：阶段必须在枚举内，百分比夹到 0–100', async () => {
  assert.throws(() => engineProgress({ stage: 'planning' }), /stage/)
  const p = engineProgress({ stage: 'articles', percent: 250, writtenCount: 2 })
  assert.equal(p.stage, 'articles')
  assert.equal(p.percent, 100)
  assert.equal(p.writtenCount, 2)
  assert.equal(engineProgress({ stage: 'graph', percent: -5 }).percent, 0)
})

await check('engineError：code 未知时落到 engine-unknown，不把异常文本当 code', async () => {
  const e = engineError({ code: 'engine-missing', message: 'python 入口不存在', stage: 'env' })
  assert.equal(e.code, 'engine-missing')
  assert.equal(e.stage, 'env')
  assert.equal(e.retryable, false)
  const unknown = engineError({ code: 'Traceback (most recent call last)', message: 'x' })
  assert.equal(unknown.code, 'engine-unknown')
  assert.equal(unknown.retryable, true)
  const fatal = engineError({ code: 'engine-crashed', message: 'x', stage: 'articles' })
  assert.equal(fatal.code, 'engine-crashed')
  assert.equal(fatal.retryable, false)
})

await check('validateEngineResult：合法结果 ok；越界/自相矛盾的结果给逐条 errors', async () => {
  const good = engineResult({ outcome: 'done', writtenCount: 2 })
  assert.deepEqual(validateEngineResult(good).errors, [])
  assert.equal(validateEngineResult(good).ok, true)

  const bad = { contractVersion: 999, outcome: 'partial', blockers: [], writtenCount: 'two' }
  const v = validateEngineResult(bad)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /contractVersion/.test(e)), v.errors.join(';'))
  assert.ok(v.errors.some((e) => /partial/.test(e)), v.errors.join(';'))
  assert.ok(v.errors.some((e) => /writtenCount/.test(e)), v.errors.join(';'))

  const notObject = validateEngineResult(null)
  assert.equal(notObject.ok, false)
})

await check('describeEngineResult：四态文案可分，partial 带首个阻塞原因', async () => {
  assert.match(describeEngineResult(engineResult({ outcome: 'done' })), /完成/)
  assert.match(
    describeEngineResult(engineResult({
      outcome: 'partial',
      blockers: [{ kind: 'article-failed', detail: '缺 frontmatter' }],
    })),
    /部分完成.*缺 frontmatter/,
  )
  assert.match(describeEngineResult(engineResult({ outcome: 'failed', error: { message: '引擎崩溃' } })), /失败.*引擎崩溃/)
  assert.match(describeEngineResult(engineResult({ outcome: 'cancelled' })), /取消/)
})

// ---------------------------------------------------------------------------
// 产物映射
// ---------------------------------------------------------------------------

const moduleTree = {
  overview: {
    name: 'Overview',
    children: {
      Core_Engine: {
        path: 'src/core',
        components: ['src/core/engine.py::Engine'],
        children: {},
      },
      Web_Handler: {
        path: 'src/web',
        components: ['src/web/handler.py::Handler', 'src/web/task.ts::TaskQueue'],
        children: {},
      },
    },
  },
}
const componentFiles = {
  'src/core/engine.py::Engine': 'src/core/engine.py',
  'src/web/handler.py::Handler': 'src/web/handler.py',
  'src/web/task.ts::TaskQueue': 'src/web/task.ts',
}
const metadata = {
  generation_info: { commit_id: 'abc1234', timestamp: '2026-10-28T00:00:00+00:00', layout: 'hierarchical', language: 'zh' },
  statistics: { total_components: 3, leaf_nodes: 2 },
}

await check('moduleSlug：ASCII 模块名转 cw 惯用 kebab-case，非 ASCII 保留并折叠分隔符', async () => {
  assert.equal(moduleSlug('Core_Engine'), 'core-engine')
  assert.equal(moduleSlug('Web Handler'), 'web-handler')
  assert.equal(moduleSlug('a/b::c'), 'a-b-c')
  assert.equal(moduleSlug('  '), '')
})

await check('mapFsoftOutput：overview 映射到 CodeWiki.md 入口，模块页落到 .codewiki/modules/', async () => {
  const mapped = mapFsoftOutput({
    pages: ['overview.md', 'Core_Engine.md', 'Web_Handler.md'],
    moduleTree,
    componentFiles,
    metadata,
  })
  assert.equal(mapped.entry.path, WIKI_ENTRY)
  assert.equal(mapped.entry.source, 'overview.md')
  const byPath = Object.fromEntries(mapped.articles.map((a) => [a.wikiPath, a]))
  assert.ok(byPath['.codewiki/modules/core-engine.md'], Object.keys(byPath).join(','))
  assert.equal(byPath['.codewiki/modules/core-engine.md'].type, 'module')
  assert.deepEqual(byPath['.codewiki/modules/core-engine.md'].sourceFiles, ['src/core/engine.py'])
  assert.equal(byPath['.codewiki/modules/web-handler.md'].pageKind, 'leaf')
  assert.equal(mapped.meta.lastCompiledCommit, 'abc1234')
  assert.equal(mapped.meta.layout, 'hierarchical')
})

await check('mapFsoftOutput：有 children 的模块页标 parent，不平铺成叶页（父页不塞进四类文章语义）', async () => {
  const mapped = mapFsoftOutput({
    pages: ['overview.md', 'Core.md', 'Core_Engine.md'],
    moduleTree: {
      Core: {
        path: 'src/core',
        components: ['src/core/engine.py::Engine'],
        children: {
          Core_Engine: { path: 'src/core', components: ['src/core/engine.py::Engine'], children: {} },
        },
      },
    },
    componentFiles,
    metadata,
  })
  const parent = mapped.articles.find((a) => a.source === 'Core.md')
  assert.ok(parent, '父页必须出现在文章列表里')
  assert.equal(parent.pageKind, 'parent')
  assert.equal(parent.type, 'module')
  const leaf = mapped.articles.find((a) => a.source === 'Core_Engine.md')
  assert.equal(leaf.pageKind, 'leaf')
})

await check('mapFsoftOutput：source_files 只来自真实证据——组件 id 的 :: 前文件部分算证据，无证据的组件不猜', async () => {
  const mapped = mapFsoftOutput({
    pages: ['Core_Engine.md', 'Ghost_Module.md'],
    moduleTree: {
      ...moduleTree,
      // 组件 id 自带文件路径（FSoft 的 `path::Symbol` 格式）→ 这是真实证据
      Ghost_Module: { path: 'x', components: ['x/ghost.py::Ghost'], children: {} },
      // 纯符号名、既无 :: 也无 componentFiles 映射 → 无任何证据，不得猜
      Opaque_Module: { path: 'y', components: ['OpaqueThing'], children: {} },
    },
    componentFiles,
    metadata,
    pages: ['Core_Engine.md', 'Ghost_Module.md', 'Opaque_Module.md'],
  })
  const core = mapped.articles.find((a) => a.source === 'Core_Engine.md')
  assert.deepEqual(core.sourceFiles, ['src/core/engine.py'])
  const ghost = mapped.articles.find((a) => a.source === 'Ghost_Module.md')
  assert.deepEqual(ghost.sourceFiles, ['x/ghost.py'], '组件 id 里的文件路径是真实证据，应被采用')
  const opaque = mapped.articles.find((a) => a.source === 'Opaque_Module.md')
  assert.deepEqual(opaque.sourceFiles, [], '没有任何文件证据时不得臆造')
  assert.ok(opaque.warnings.some((w) => /source_files/.test(w)), opaque.warnings.join(';'))
})

await check('mapFsoftOutput：没被映射的页进 unmapped（带原因），绝不静默丢弃', async () => {
  const mapped = mapFsoftOutput({
    pages: ['overview.md', 'Core_Engine.md', 'artifact_Dockerfile.md', 'random/notes.md'],
    moduleTree,
    componentFiles,
    metadata,
  })
  const unmapped = mapped.unmapped.map((u) => u.source)
  assert.ok(unmapped.includes('random/notes.md'), unmapped.join(','))
  const reason = mapped.unmapped.find((u) => u.source === 'random/notes.md').reason
  assert.match(reason, /模块树/)
})

await check('mapFsoftOutput：artifact 页有明确 pageKind，不冒充业务模块文章', async () => {
  const mapped = mapFsoftOutput({
    pages: ['overview.md', 'Artifacts.md'],
    moduleTree: {
      Artifacts: {
        path: '',
        components: ['Dockerfile::Dockerfile'],
        children: {},
        artifact: true,
      },
    },
    componentFiles: { 'Dockerfile::Dockerfile': 'Dockerfile' },
    metadata,
  })
  const art = mapped.articles.find((a) => a.source === 'Artifacts.md')
  assert.equal(art.pageKind, 'artifact')
  assert.deepEqual(art.sourceFiles, ['Dockerfile'])
})

await check('mapFsoftOutput：slug 冲突不覆盖，两页都进 unmapped 并给出冲突原因', async () => {
  const mapped = mapFsoftOutput({
    pages: ['A_B.md', 'A-B.md'],
    moduleTree: {
      A_B: { path: '', components: [], children: {} },
      'A-B': { path: '', components: [], children: {} },
    },
    componentFiles: {},
    metadata,
  })
  assert.equal(mapped.articles.length, 0)
  assert.equal(mapped.unmapped.length, 2)
  assert.ok(mapped.unmapped.every((u) => /冲突|conflict/.test(u.reason)), JSON.stringify(mapped.unmapped))
})

await check('mapFsoftOutput：update_record 映射到 .codewiki/temp/，只搬运不改技术内容', async () => {
  const updateRecord = {
    outcome: 'incremental',
    revision: { old_commit: 'old111', new_commit: 'new222' },
    pages_written: ['Core_Engine.md'],
    pages_removed: [],
    errors: [],
  }
  const mapped = mapFsoftOutput({
    pages: ['overview.md', 'Core_Engine.md'],
    moduleTree,
    componentFiles,
    metadata,
    updateRecord,
  })
  assert.equal(mapped.updateRecord.path, WIKI_UPDATE_RECORD_REL)
  assert.equal(mapped.updateRecord.outcome, 'incremental')
  assert.equal(mapped.updateRecord.source, 'incremental')
  assert.deepEqual(mapped.updateRecord.pagesWritten, ['Core_Engine.md'])
  assert.equal(WIKI_META_REL, '.codewiki/_meta.yaml')
})

await check('mapFsoftOutput：没有任何页时 entry 为空但结果仍可序列化（供 partial 记账）', async () => {
  const mapped = mapFsoftOutput({ pages: [], moduleTree: {}, componentFiles: {}, metadata: {} })
  assert.equal(mapped.entry, null)
  assert.deepEqual(mapped.articles, [])
  assert.equal(JSON.parse(JSON.stringify(mapped)).contractVersion, ENGINE_CONTRACT_VERSION)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
