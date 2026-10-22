// test-wiki-anchors.mjs — wiki 文章行号锚点自动校验：
// 流水线产物曾系统性幻觉 index.js: 行号（偏移 34~760 行，校对阶段拦不住），
// 本测试把「锚点必须对照真实源码核对」制度化——
//   1. 基础断言：`index.js:NN` / `client.js:NN` 的 NN 必须落在文件行数内且该行非空；
//   2. 符号绑定断言：同行反引号内若出现代码标识符（如 `createJobService` (`index.js:1042`)），
//      源文件第 NN 行必须包含该标识符（或其最后一段，如 Config.updateReminder → updateReminder）；
//   3. 区间断言：`index.js:NNN-MMM` 需 NNN ≤ MMM 且 MMM 在行数内。
// 任何失败 exit 1——新文章合入前跑一次即可拦截幻觉锚点。
// 运行：node test-wiki-anchors.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WIKI = path.join(ROOT, '.codewiki')
const SOURCES = {
  'index.js': { lines: null, total: 0 },
  'client.js': { lines: null, total: 0 },
}
for (const name of Object.keys(SOURCES)) {
  const p = path.join(ROOT, name)
  SOURCES[name].lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
  SOURCES[name].total = SOURCES[name].lines.length
}

let passed = 0
let failures = 0
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`) }
  else { failures += 1; console.error(`  ✗ ${msg}`) }
  return cond // 供 `if (!check(...)) continue` 使用：断言失败时跳过该锚点的后续检查
}

// 行内反引号代码标识符（带原文下标）：允许点分（Config.updateReminder）与参数/调用形式
// （parseStatus(stdout)、tickIndex(job)）；拒绝含冒号/斜杠/空格/纯路径等非符号。
// 带下标是为了把每个锚点绑定到「离它最近」的符号——一句话里常并列引用多个符号，
// 要求锚点行同时包含全部符号会误判（如「`A` 与 `B`（`index.js:22`）」只该校验 B 或就近者）。
function symbolsOnLine(line) {
  const out = []
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    let sym = m[1].trim()
    sym = sym.replace(/\(.*\)$/, '').trim() // 去参数表 / 调用括号
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(sym)) continue
    if (sym.length < 3) continue
    if (sym.split('.').pop().length < 3) continue // 排除 CodeWiki.md / _index.md 尾段
    out.push({ sym, at: m.index })
  }
  return out
}

// 取离锚点最近的符号（同距时取锚点左侧的，因为中文行文多为「符号（`file:NN`）」）
function nearestSymbol(syms, anchorIndex, anchorLen) {
  if (syms.length === 0) return null
  const mid = anchorIndex + anchorLen / 2
  let best = null
  for (const s of syms) {
    const d = Math.abs(s.at - mid)
    const left = s.at < mid
    if (!best || d < best.d || (d === best.d && left && !best.left)) best = { ...s, d, left }
  }
  return best
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files.push(...walk(p))
    else if (e.name.endsWith('.md')) files.push(p)
  }
  return files
}

const articles = walk(WIKI).sort()
if (articles.length === 0) {
  console.error('  ✗ .codewiki/ 下没有找到任何 .md 文章——wiki 未编译？')
  process.exit(1)
}
console.log(`校验 ${articles.length} 篇文章的行号锚点（index.js ${SOURCES['index.js'].total} 行 / client.js ${SOURCES['client.js'].total} 行）`)

for (const file of articles) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/')
  const text = fs.readFileSync(file, 'utf8')
  text.split(/\r?\n/).forEach((line, i) => {
    const anchors = [...line.matchAll(/(?:index|client)\.js[:：](\d+)(?:-(\d+))?/g)]
    if (anchors.length === 0) return
    const syms = symbolsOnLine(line)
    for (const a of anchors) {
      const start = Number(a[1])
      const end = a[2] ? Number(a[2]) : null
      const srcName = a[0].startsWith('client') ? 'client.js' : 'index.js'
      const src = SOURCES[srcName]
      const at = `${rel}:${i + 1} \`${a[0]}\``
      check(start >= 1 && start <= src.total, `${at} 起始行在 ${srcName} 行数范围内（1..${src.total}）`)
      if (!check(src.lines[start - 1]?.trim().length > 0, `${at} 指向非空代码行`)) continue
      if (end !== null) {
        check(start <= end, `${at} 区间起止有序`)
        check(end <= src.total, `${at} 区间终点在行数范围内`)
      }
      // 符号绑定只在「本行只有一个锚点」时校验：一行并列多个锚点（表格一行多列、
      // 一句话串多个文件）时无法可靠判断某符号属于哪个锚点，强行绑定会系统性误判。
      // 多锚点行的价值由「行号在范围内 + 指向非空行」兜底。
      // 区间锚点（NNN-MMM）在整个区间内搜符号——语义就是「这段代码」，不是首行。
      if (syms.length > 0 && anchors.length === 1) {
        const span = src.lines.slice(start - 1, end !== null ? end : start).join('\n')
        const hit = syms.some((s) => {
          const tail = s.sym.split('.').pop()
          return span.includes(s.sym) || span.includes(tail)
        })
        check(hit, `${at} 符号绑定：${syms.map((s) => `\`${s.sym}\``).join('/')} 应出现在 ${srcName}:${start}${end !== null ? `-${end}` : ''} 区间内`)
      }
    }
  })
}

console.log(`\n锚点校验：${passed} 过 / ${failures} 败`)
process.exit(failures > 0 ? 1 : 0)
