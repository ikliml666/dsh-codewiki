// 生产接线测试用的「假引擎」：**只实现协议与产物，不实现任何算法**。
//
// 为什么需要一个真进程而不是注入一个假函数：阶段 4 要验的是「JobService 到引擎」
// 这条**接线**。注入假 runEngine 会让 client.js 的 spawn/协议解析/进程树终止全部
// 被绕开——那正是最容易悄悄坏掉的一段（真跑的时候才发现 EN OENT、编码、退出码）。
// 这里用 node 直接当「解释器」、本文件当「入口脚本」，所以 client.js 走的是**完全
// 真实**的路径：真 spawn、真 stdin 一行 JSON、真 stdout JSON-lines、真进程退出。
//
// 行为由 FAKE_ENGINE_MODE 控制（一次只做一件事，便于逐条断言）：
//   done        正常：写一份干净 docs 并回 done
//   partial     产物缺一篇模块页（module_tree 里有、docs 里没有）→ 质量门判 partial
//   fail        引擎自己回 failed（带可机读 error）
//   crash       协议破坏：只写日志行，不写 result（退出码 0）
//   stall       不返回，等被取消（验证取消会终止进程树）
//   bad-yaml    文章 title 写成裸值 `核心: 引擎`（serde_yaml 会把 index 收录静默跳过）
//   empty-docs  不写任何产物就回 done（验证「引擎 done 不能替代质量门」）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// 用例模式：优先环境变量，其次「仓库同级」的模式文件，最后从仓库目录名的 `__mode__` 段解析。
//
// 为什么不只用环境变量：同一测试进程会连续跑多个用例，而子进程继承的是**启动那一刻**
// 的 process.env；靠改 env 切换模式会与仍在收尾的上一个任务竞态（它可能还没 spawn）。
// 为什么模式文件要放在**仓库外**（同级目录）：放进仓库里会变成一次未提交源码改动，
// 质量门的 `uncommitted-input` 会把它判成产品缺陷——测试脚本自己污染被测对象。
function modeFileFor(repoPath) {
  const abs = path.resolve(String(repoPath ?? ''))
  return path.join(path.dirname(abs), `.native-mode-${path.basename(abs)}`)
}
function modeOf(repoPath) {
  const fromEnv = String(process.env.FAKE_ENGINE_MODE ?? '').trim()
  if (fromEnv) return fromEnv
  try {
    const fromFile = fs.readFileSync(modeFileFor(repoPath), 'utf8').trim()
    if (fromFile) return fromFile
  } catch { /* 没有模式文件 */ }
  const m = /__([a-z-]+)__/i.exec(String(repoPath ?? '').replace(/\\/g, '/'))
  return m ? m[1].toLowerCase() : 'done'
}
let MODE = 'done'
const VERSION = String(process.env.FAKE_ENGINE_VERSION ?? '9.9.9')
const PYVER = String(process.env.FAKE_ENGINE_PYVERSION ?? '3.13.0')
const REAL_STDOUT = process.stdout

// 调用足迹：把「谁跑过、跑了哪个动作」写到仓库**同级**的日志里。
//
// 为什么必须在引擎侧记而不是在测试侧记：接线测试要断言的不只是结果，还有
// 「环境失败/锁漂移时引擎根本没被生成调用」——那类断言只能由被动方提供证据。
// 放仓库外与模式文件同理：写进仓库会变成一次未提交源码改动，质量门的
// uncommitted-input 会把它判成产品缺陷。
function logCall(repoPath, action) {
  try {
    const line = `${JSON.stringify({ action, at: new Date().toISOString(), mode: MODE })}\n`
    fs.appendFileSync(path.join(path.dirname(path.resolve(String(repoPath ?? '.'))), `.native-calls-${path.basename(path.resolve(String(repoPath ?? '.')))}.log`), line, 'utf8')
  } catch { /* 足迹写不进去不影响引擎行为 */ }
}

function emit(obj) {
  REAL_STDOUT.write(`${JSON.stringify(obj)}\n`)
}
function progress(requestId, stage, percent, message = '') {
  emit({ type: 'progress', requestId, stage, percent, message })
}
function result(requestId, body) {
  emit({ type: 'result', requestId, result: body })
}

function head(repoPath) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
  } catch { return '' }
}

// 仓库里真实存在的源码文件（相对仓库根、POSIX 分隔）。
//
// 为什么要真的去扫：`source_files` 的唯一合法证据是「组件 id 指向的文件在仓库里存在」
// （output.js 的 source-missing 就按这个判）。早先夹具硬编码 `src/core/engine.py`，
// 而测试仓库里根本没有那个文件，于是质量门对每篇页都记一条 source-missing → 永远
// partial，这个「假 done」会让人把闸门缺陷当成夹具配置问题忽略掉。
function realSourceFiles(repoPath, limit = 4) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 4) return
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (out.length >= limit) return
      if (it.name === '.git' || it.name.startsWith('.')) continue
      const abs = path.join(dir, it.name)
      if (it.isDirectory()) { walk(abs, depth + 1); continue }
      if (!/\.(py|ts|js|mjs|go|rs|java)$/i.test(it.name)) continue
      out.push(path.relative(repoPath, abs).replace(/\\/g, '/'))
    }
  }
  walk(repoPath, 0)
  return out
}

function writeDocs(docsDir, repoPath) {
  fs.mkdirSync(path.join(docsDir, 'modules'), { recursive: true })
  const sha = head(repoPath)
  // 先扫出仓库里真实存在的源码文件：模块树与页面都只能引用它们。
  const files = realSourceFiles(repoPath)
  const core = files[0] ?? ''
  const web = files[1] ?? ''
  // 页内**不带 frontmatter**：真实 FSoft 产物就是纯 markdown（`.probe-fsoft/wiki_out_1c/docs`
  // 的页头是 `# 标题`）。frontmatter 由渲染层 renderArticle 合成——夹具若自带一份，
  // 正文里就会出现第二份头，article-contract 判 duplicate-frontmatter，done 用例永远 partial，
  // 测的就不再是接线而是夹具自己的格式错误。
  fs.writeFileSync(path.join(docsDir, 'overview.md'),
    '# 项目概览\n\n演示项目的整体结构说明。\n\n## 组成\n\n见 [核心](modules/core.md)。\n', 'utf8')
  fs.writeFileSync(path.join(docsDir, 'modules', 'core.md'),
    '# 核心\n\n## 职责\n\n核心引擎负责构建依赖图并调度各阶段。\n', 'utf8')
  if (MODE !== 'partial') {
    if (web) {
      fs.writeFileSync(path.join(docsDir, 'modules', 'web.md'),
        '# Web 层\n\n## 职责\n\nWeb 层把请求转成任务并回传进度。\n', 'utf8')
    }
  } else if (web) {
    // partial：这一页**有文件但正文被掏空**。这比「整个文件不写」更接近真实的降级路径
    // （引擎写完标题就被截断），也正好落在质量门已有的 empty-body 判据上：
    // 该页 skip、其余照写、终态 partial、基线不许推进。
    fs.writeFileSync(path.join(docsDir, 'modules', 'web.md'), '# Web 层\n\n', 'utf8')
  }
  fs.writeFileSync(path.join(docsDir, 'metadata.json'), JSON.stringify({
    generation_info: { commit_id: MODE === 'bad-commit' ? 'b'.repeat(40) : sha, layout: 'hierarchical' },
    statistics: { total_components: 2, leaf_nodes: 2 },
    files_generated: ['overview.md', 'modules/core.md'],
  }), 'utf8')
  // module_tree 的 components 必须指向**仓库里真的存在**的文件：映射层把
  // `path::Symbol` 的 `::` 前一段当成 source_files（mapping.js sourceFilesOf），
  // 编一个不存在的路径就会在 output.js 的 source-missing 处被判产品缺陷。
  const tree = {}
  if (core) tree.core = { path: path.posix.dirname(core), components: [`${core}::Engine`], children: {} }
  if (web) tree.web = { path: path.posix.dirname(web), components: [`${web}::Handler`], children: {} }
  fs.writeFileSync(path.join(docsDir, 'module_tree.json'), JSON.stringify(tree), 'utf8')
  fs.writeFileSync(path.join(docsDir, 'first_module_tree.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(docsDir, 'update_record.json'), JSON.stringify({ outcome: 'full', pages_written: ['modules/core.md'], pages_removed: [] }), 'utf8')
}

function run(req) {
  const requestId = String(req?.requestId ?? '')
  const action = String(req?.action ?? '')
  MODE = modeOf(req?.repoPath ?? process.cwd())
  emit({ type: 'hello', protocolVersion: 1, engine: 'fake-native' })
  logCall(req?.repoPath ?? process.cwd(), action)

  if (action === 'doctor') {
    if (MODE === 'deps-bad') {
      result(requestId, {
        outcome: 'done',
        stage: 'env',
        engine: { version: VERSION, python: PYVER, deps: { ok: false, summary: 'pip check: engine requires click 9, found 8.0' } },
      })
      return
    }
    result(requestId, {
      outcome: 'done',
      stage: 'env',
      engine: { version: VERSION, python: PYVER, deps: { ok: true, summary: 'pip check ok' } },
    })
    return
  }

  if (action !== 'generate' && action !== 'update') {
    result(requestId, { outcome: 'failed', error: { code: 'engine-protocol', message: `未知动作 ${action}` } })
    return
  }

  if (MODE === 'stall') {
    progress(requestId, 'articles', 40, '假装在写文章')
    // 不返回、不退出：只能被杀掉。取消语义靠进程树终止证明。
    setInterval(() => {}, 1000)
    return
  }
  if (MODE === 'slow') {
    // 慢但会自己跑完：用来验证「上一个仓库还在跑时，后提交的仓库进 queued 排队」。
    // 不用 stall，是因为 stall 只能靠取消收场，串行测试不该顺带验证取消。
    progress(requestId, 'articles', 40, '慢慢写')
    setTimeout(() => {
      try {
        const d = String(req?.docsDir ?? '')
        if (d) writeDocs(d, String(req?.repoPath ?? process.cwd()))
        result(requestId, {
          outcome: 'done', stage: 'articles', writtenCount: 2, failedCount: 0,
          engine: { version: VERSION, python: PYVER, deps: { ok: true, summary: 'pip check ok' } },
          artifacts: { docsDir: d, rawTreeDir: '', updateRecord: path.join(d, 'update_record.json') },
        })
      } catch (err) {
        result(requestId, { outcome: 'failed', error: { code: 'engine-crashed', message: String(err?.message ?? err) } })
      }
    }, Number(process.env.FAKE_ENGINE_DELAY_MS ?? 1200))
    return
  }
  if (MODE === 'fail') {
    progress(requestId, 'graph', 12, '开始')
    result(requestId, {
      outcome: 'failed',
      stage: 'graph',
      error: { code: 'engine-crashed', message: '假引擎：依赖图构建失败（按用例构造）' },
    })
    return
  }
  if (MODE === 'crash') {
    // 协议破坏：人类日志写到协议流、且没有 result
    REAL_STDOUT.write('INFO loading tree-sitter grammar\n')
    return
  }
  if (MODE === 'empty-docs') {
    progress(requestId, 'articles', 80, '假装写完了')
    result(requestId, { outcome: 'done', stage: 'articles', writtenCount: 2, engine: { version: VERSION, python: PYVER, deps: { ok: true, summary: '' } } })
    return
  }

  const docsDir = String(req?.docsDir ?? '')
  const repoPath = String(req?.repoPath ?? process.cwd())
  progress(requestId, 'graph', 10, '构建依赖图')
  progress(requestId, 'cluster', 30, '聚类')
  progress(requestId, 'articles', 60, '写文章')
  writeDocs(docsDir, repoPath)
  progress(requestId, 'articles', 90, '产物已写出')
  result(requestId, {
    outcome: 'done',
    stage: 'articles',
    writtenCount: MODE === 'partial' ? 1 : 2,
    failedCount: MODE === 'partial' ? 1 : 0,
    engine: { version: VERSION, python: PYVER, deps: { ok: true, summary: 'pip check ok' } },
    artifacts: { docsDir, rawTreeDir: '', updateRecord: path.join(docsDir, 'update_record.json') },
  })
}

let buf = ''
process.stdin.on('data', (c) => { buf += c.toString('utf8') })
process.stdin.on('end', () => {
  let req = null
  try { req = JSON.parse(buf.split('\n')[0] ?? '{}') } catch { req = null }
  try { run(req) } catch (err) {
    emit({ type: 'result', requestId: String(req?.requestId ?? ''), result: { outcome: 'failed', error: { code: 'engine-crashed', message: String(err?.message ?? err) } } })
  }
})
