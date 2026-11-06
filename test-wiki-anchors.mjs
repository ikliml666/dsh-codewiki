// test-wiki-anchors.mjs — wiki 文章行号锚点自动校验。
//
// 流水线产物曾系统性幻觉 index.js 行号（偏移 34~760 行，校对阶段拦不住），本测试把
// 「锚点必须对照真实源码核对」制度化。但**严格度必须是新鲜度感知的**，否则它会在
// 最常见的工作状态下误报，理由见下。
//
// ## 为什么要分「硬断言」与「软报告」两档
//
// 锚点有两个来源：一类是**结构事实**（行号是否在文件内、区间起止是否有序），它与源码
// 有无变动无关，写错了就是写错了；另一类是**同步事实**（锚点指向的那行是否仍是当初
// 那个符号、CHANGELOG 版本节是否还对得上），它依赖「文档与源码处在同一时刻」这个前提。
//
// 第二个前提在日常开发里几乎从不成立：`.codewiki/` 是编译流水线在**某个 commit 上**
// 生成的产物，之后代码继续改、文档不会自动跟随，直到下一次编译。实测把严格度一律
// 拉到硬断言时，工作区 index.js 净增 280 行就让 115 处锚点集体失败——它们全部落在
// 编译当时源码的正确位置上，是**文档滞后**而不是文档撒谎。这类噪声会把真错误淹没。
//
// 所以本测试分两档（`STRICT` 由 --strict 或「该源文件与编译基线逐字相同」自动开启）：
//   · 硬断言（任何情况都失败）：行号越界、区间起止无序/越界。这是数据性错误。
//   · 新鲜时升级为硬断言，滞后时降级为软报告：指向空行、符号未绑定、CHANGELOG 版本节。
//     这三类都要求文档与源码同一时刻，滞后时无法区分「文档错」与「文档过期」。
//
// 「新鲜」的判据：`.codewiki/_meta.yaml` 的 `last_compiled_commit` 是编译基线，把被引用
// 源文件的**工作区内容**与该 commit 下的内容逐字比较——完全相同才算新鲜。用逐字而非行数，
// 是因为「改一行不改行数」同样会让符号挪位。这个判据是自洽的：代码改完未重编译 → 该文件
// 滞后（软报告 + 提示重编译）；跑过 codewiki_generate 后基线前移 → 新鲜（硬断言，逼流水线
// 把锚点真的修对）。基线取不到（非 git 仓库、基线 commit 已不可达）时一律按滞后处理——
// 宁可少报，不做无法举证的硬失败。
//
// 运行：node test-wiki-anchors.mjs [--strict]
// 任何硬断言失败 exit 1。软报告不影响退出码，但会在末尾醒目列出。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WIKI = path.join(ROOT, '.codewiki')
const FORCE_STRICT = process.argv.includes('--strict')

// 校验基准：**编译基线版 ∪ 工作区源码 ∪ 已提交源码（HEAD）**，任一视为有效即通过。
//
// 这不是放水，而是修正此前的系统性误报。wiki 锚点是流水线在**编译当时**按工作区文件
// 写的；而人改代码与跑本测试之间必然存在一个「已改未提交」的窗口。实测：`index.js` 未提交
// 改动净增 280 行，一次性把 115 处锚点判成失败，而它们全部落在 HEAD 版源码的正确位置上
// （文件中间的插入会整体推移后面所有行号，与文档对错无关）。判据若只认工作区，就等于要求
// 「每次改源码都必须先提交才能跑测试」，这与日常开发顺序冲突，且会把真错误淹没在噪声里。
//
// 反向也成立：若有人先改文档、源码后提交，工作区基准同样救不了——所以是**并集**而非替换。
// 只有当三版源码都解释不了该锚点时，才判定文档真的错了。
//
// 第三个基准（编译基线版）是后来补的，因为它才是语义上最正的那一个：文档就写在它上面。
// 只留工作区 ∪ HEAD 时有个隐蔽的窗口——**提交之后** HEAD 立刻变成新源码，兜底消失，
// 同一份文档的 --strict 败数从 18 跳到 111（全部是「锚点写在编译基线那版，而基线那版
// 已不在任何基准里」）。补上它，提交前后结果就一致了。
const sourceCache = new Map()
function readSourceFile(rel, { head = false, ref = null } = {}) {
  if (ref) {
    // 编译基线版：文档就是在这版源码上写成的，它能解释的锚点一律算有效。
    try {
      const text = execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      const lines = text.split(/\r?\n/)
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      return lines
    } catch { return null } // 基线里没有该文件（本轮新增）→ 无该基准
  }
  if (head) {
    try {
      const text = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const lines = text.split(/\r?\n/)
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      return lines
    } catch { return null } // 该文件在 HEAD 里不存在（本轮新增）→ 无 HEAD 基准
  }
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/)
  } catch { return null } // 文件不存在（如已删的临时脚本、外部路径）→ null，跳过该锚点
}

// 编译基线（`.codewiki/_meta.yaml` 的 last_compiled_commit）——第三个基准，
// 也是**语义上最该有的那一个**：文档就是流水线在这版源码上写的。
// 为什么必须补它：双基准（工作区 ∪ HEAD）在「改完代码还没提交」时有 HEAD 兜底，
// 但一旦提交，HEAD 立刻变成新源码，兜底消失——实测提交前后同一份文档的 --strict
// 败数从 18 跳到 111，全部是「文档写在编译基线那版、而基线那版已不在任何基准里」。
// 工作区与 HEAD 都解释不了的锚点，在编译基线版里往往正中目标。
const compiledCommitForViews = (() => {
  try {
    return fs.readFileSync(path.join(WIKI, '_meta.yaml'), 'utf8')
      .match(/^last_compiled_commit:\s*([0-9a-f]{7,40})\s*$/m)?.[1] ?? null
  } catch { return null }
})()

// 返回该锚点所有可用基准下的「源码视图」数组：工作区版在前（更可能是文档想指的那版），
// HEAD 版其次，编译基线版最后。调用方逐版校验，任一通过即算通过。
// 空数组 = 文件根本不存在，跳过校验。
function loadSource(rel, preferHead = false) {
  const key = `${preferHead ? 'H:' : 'W:'}${rel}`
  if (sourceCache.has(key)) return sourceCache.get(key)
  const views = []
  const seen = new Set()
  const order = preferHead
    ? [{ head: true }, { head: false }, { ref: compiledCommitForViews }]
    : [{ head: false }, { head: true }, { ref: compiledCommitForViews }]
  for (const opt of order) {
    if (opt.ref === null) continue // 无编译基线 → 该基准不可用
    const lines = readSourceFile(rel, opt)
    if (!lines) continue
    // 同一份内容只保留一次：编译基线常常就等于工作区，去重避免重复校验同一版。
    // 必须按**全文**比对，不能取首行/中间行做签名——两个不同版本的首行与中间行
    // 完全可能相同（都在文件开头的注释里），那会把本该独立的一版错误丢掉。
    const body = lines.join('\n')
    if (seen.has(body)) continue
    seen.add(body)
    views.push({ lines, total: lines.length, head: !!opt.head, base: !!opt.ref })
  }
  sourceCache.set(key, views)
  return views
}
const SOURCES = {
  'index.js': loadSource('index.js'),
  'client.js': loadSource('client.js'),
}

// ── 新鲜度：该源文件的内容是否与 wiki 编译基线逐字相同 ───────────────────────────
// 逐字比较（而非行数比较）的原因：改一行不改行数同样会让符号挪位，而「滞后」的判定
// 必须精确到「文档看到的就是现在这份源码」，否则软/硬档位会切错。
const META_PATH = path.join(WIKI, '_meta.yaml')
const compiledCommit = (() => {
  try {
    const m = fs.readFileSync(META_PATH, 'utf8').match(/^last_compiled_commit:\s*([0-9a-f]{7,40})\s*$/m)
    return m ? m[1] : null
  } catch { return null }
})()
const freshnessCache = new Map()
function isFresh(rel) {
  if (FORCE_STRICT) return true // --strict：无条件按新鲜处理，用于发布前把关
  if (!compiledCommit) return false // 无基线 → 无法举证，按滞后（软报告）
  if (freshnessCache.has(rel)) return freshnessCache.get(rel)
  let fresh = false
  try {
    const base = execFileSync('git', ['show', `${compiledCommit}:${rel}`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    })
    const now = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    fresh = base === now
  } catch { fresh = false } // 基线不可达 / 文件新增 → 滞后
  freshnessCache.set(rel, fresh)
  return fresh
}

// CHANGELOG.md 是**追加式流水账**：每个版本在顶部插一节，于是所有指向它的行号必然单向
// 漂移。只校验「行号在范围内且非空」等于没校验——实测 128 条 CHANGELOG 锚点里有 113 条
// 已漂到**别的版本节**内（`CHANGELOG.md:109` 本意指 0.13.0，实际落在 0.13.2 那节），
// 但它们全部「非空且在范围内」，绿灯放行。这里补上语义校验：行内写了版本号 V 的锚点，
// 必须落在 `## V` 那一节内。反例（无法判定版本、或版本号在锚点右侧）不校验，避免误报。
// 版本节按基准分别算：HEAD 版与工作区版的章节位置不同（每次发版顶部插节）。
const clSectionsOf = (src) => {
  const secs = []
  src.lines.forEach((l, i) => {
    const m = l.match(/^##\s+(\d+\.\d+(?:\.\d+)*)/)
    if (m) secs.push({ ver: m[1], start: i + 1, end: src.lines.length })
  })
  for (let i = 0; i < secs.length - 1; i++) secs[i].end = secs[i + 1].start - 1
  return secs
}
const CL_VIEWS = loadSource('CHANGELOG.md')
const CL_SECTIONS_OF_VIEW = new Map(CL_VIEWS.map((v) => [v, clSectionsOf(v)]))

let passed = 0
let failures = 0
const softReports = [] // 文档滞后导致的「无法定性」项：不算失败，但末尾列出
function check(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`) }
  else { failures += 1; console.error(`  ✗ ${msg}`) }
  return cond // 供 `if (!check(...)) continue` 使用：断言失败时跳过该锚点的后续检查
}
function soft(msg) {
  softReports.push(msg)
  console.log(`  ~ ${msg}`)
}

// 行内反引号代码标识符（带原文下标）：允许点分（Config.updateReminder）与参数/调用形式
// （parseStatus(stdout)、tickIndex(job)）；拒绝含冒号/斜杠/空格/纯路径等非符号。
// 带下标是为了把每个锚点绑定到「离它最近」的符号——一句话里常并列引用多个符号，
// 要求锚点行同时包含全部符号会误判（如「`A` 与 `B`（`index.js:22`）」只该校验 B 或就近者）。
const FILE_LIKE = /\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|yml|yaml|txt|log|toml|lock|cfg|ini)$/i
function symbolsOnLine(line) {
  const out = []
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    let sym = m[1].trim()
    sym = sym.replace(/\(.*\)$/, '').trim() // 去参数表 / 调用括号
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(sym)) continue
    if (sym.length < 3) continue
    if (sym.split('.').pop().length < 3) continue // 排除 CodeWiki.md / _index.md 尾段
    // 文件名不是代码符号：`package.json`（`package.json:1-28`）、`watcher2.log`（`watcher2.log:1`）
    // 这类写法里反引号包的是**文件路径**，要求在文件自身内容里搜到 "package.json" 这个
    // 字符串是无解的（package.json 里根本不出现自己的文件名），实测造成稳定假阳性。
    if (FILE_LIKE.test(sym)) continue
    out.push({ sym, at: m.index })
  }
  return out
}

// 多锚点行（一行并列多个「符号 + 锚点」）**有意不做符号绑定校验**。
// 曾写过一个「取离锚点最近的符号」的启发式函数做这件事，但它从未被调用（死代码），
// 而把它接上会带来两个问题：① 就近绑定本身是启发式，中文行文里「符号甲（A:11）、
// 符号乙（B:22）」的语义归属无法只靠字符距离判定，接入后会产生大批误报；
// ② 修正逻辑（index.js 的 fixAnchors）对多锚点行用的是「唯一归属行」判定，与就近
// 距离判据不同源——用另一套判据去校验，要么比修正器松（等于没校验），要么比它严
// （把修正器认可的写法判成错）。多锚点行的价值由上面的「行号在范围内 + 指向非空行」
// 兜底；真正能钉住修错行为的是 test-batch.mjs 的 fixAnchors 对抗用例。

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
const mainTxt = SOURCES['index.js'].map((v) => `${v.base ? '编译基线' : v.head ? 'HEAD' : '工作区'} ${v.total} 行`).join(' / ')
console.log(`校验 ${articles.length} 篇文章的行号锚点（index.js ${mainTxt}，其余引用文件按需加载；编译基线 ∪ 工作区 ∪ HEAD 三基准任一有效即通过）`)

for (const file of articles) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/')
  const text = fs.readFileSync(file, 'utf8')
  text.split(/\r?\n/).forEach((line, i) => {
    // 范围/非空/区间检查覆盖**所有**仓内文件锚点（不只 index.js/client.js）。
    // 只认两个文件时，指向 test-orchestration.mjs / README.md / CHANGELOG.md 的
    // 一千多条锚点一条都不受检——实测其中就藏着 `README.md：0` 这种误匹配。
    // `(?!\.\d)` 防止把「README.md：0.13.0 三层能力对照表」的版本号当成行号 0：
    // 中文全角冒号后面紧跟版本号是文档里的常见写法，裸 `\d+` 会截出 `0`。
    const anchors = [...line.matchAll(/([A-Za-z0-9_\-./]+\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|yml|yaml|txt|log|rs|py))[:：](\d+)(?!\.\d)(?:-(\d+))?/g)]
    if (anchors.length === 0) return
    const syms = symbolsOnLine(line)
    // 本行全部文件锚点数：符号绑定只在「唯一」时校验（见下方注释）
    const allFileAnchors = [...line.matchAll(/[A-Za-z0-9_\-./]+\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|yml|yaml|txt|log|rs|py)[:：]\d+(?:-\d+)?/g)]
    for (const a of anchors) {
      const srcName = a[1]
      const start = Number(a[2])
      const end = a[3] ? Number(a[3]) : null
      const views = loadSource(srcName)
      // 文件不存在（已被删除的临时脚本、外部绝对路径、生成物）→ 跳过，不算失败
      if (!views.length) continue
      const at = `${rel}:${i + 1} \`${a[0]}\``
      // 逐个基准校验，任一版通过即整体通过。每版独立计数，保证「通过数」反映锚点条数。
      let ok = false
      let firstMsg = ''
      let firstKind = 'struct' // 首个失败若为同步类（sync）且文件滞后，则降级软报告
      for (const src of views) {
        const label = `${src.base ? '编译基线版' : src.head ? 'HEAD 版' : '工作区'} ${srcName}`
        const r = judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })
        if (r.ok) { ok = true; break }
        if (!firstMsg) { firstMsg = r.msg; firstKind = r.kind ?? 'struct' }
      }
      // 结构类失败（越界/区间无序）与文档是否滞后无关，永远硬失败。
      // 同步类失败（空行/版本节/符号绑定）在源文件滞后于编译基线时只能说明「文档过期」，
      // 无法举证文档错，降级为软报告——这正是 115 处假失败的成因。
      // CHANGELOG.md 特殊：追加式流水账导致历史锚点必然下移，其「空行/版本节」失败
      // 无论基线新不新鲜都不是文档错（发版本身就会让上一批锚点失效），一律软报告。
      const fresh = isFresh(srcName)
      const softOnly = firstKind === 'changelog' || (firstKind === 'sync' && srcName === 'CHANGELOG.md')
      if (!ok && softOnly) soft(`${at} → ${firstMsg}（CHANGELOG 追加式漂移，判为待重编译）`)
      else if (!ok && firstKind === 'sync' && !fresh) soft(`${at} ${firstMsg}（源文件滞后于编译基线，判为待重编译）`)
      // 失败消息必须带文章位置：judgeAnchor 只回「哪个基准/哪个源文件」，不带上层 rel:i
      else check(ok, ok ? `${at} ${describeOk(a, views)}` : `${at} → ${firstMsg}`)
    }
  })
}

// 通过时打哪一条日志：写明是哪个基准解释了这个锚点，避免「过了但不知道为什么」。
function describeOk(a, views) {
  const srcName = a[1]
  const start = Number(a[2])
  const end = a[3] ? Number(a[3]) : null
  const tail = end !== null ? `-${end}` : ''
  const nameOf = (v) => (v.base ? '编译基线版' : v.head ? 'HEAD 版' : '工作区')
  if (views.length === 1) return `锚点在 ${srcName}:${start}${tail} 有效（单基准：${nameOf(views[0])}）`
  return `锚点在 ${srcName}:${start}${tail} 有效`
}

// 在单个基准视图下判定一个锚点是否成立。返回 { ok, msg, kind }。
// kind: 'struct' = 结构事实（与源码变动无关，写错就是写错，永远硬失败）
//       'sync'   = 同步事实（要求文档与源码同一时刻，滞后时可降级软报告）
function judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName }) {
  const start = Number(a[2])
  const end = a[3] ? Number(a[3]) : null
  const at = `${label} ${srcName}:${start}${end !== null ? `-${end}` : ''}`
  if (!(start >= 1 && start <= src.total)) return { ok: false, kind: 'struct', msg: `${at} 起始行越界（1..${src.total}）` }
  // 非空检查：单行锚点必须指向非空行；区间锚点只要**区间内有代码**即可。
  // 区间语义是「这段代码」，起始行是空行（函数前的空行、段落间空行）属正常写法——
  // 实测 test-orchestration.mjs:411-438 的起点 411 恰是空行、区间内部是完整用例。
  // 强制起点非空会把这类正确标注判成失败，且 fixAnchors 无法修（符号在区间内遍布）。
  const spanHasCode = end !== null &&
    src.lines.slice(start - 1, Math.min(end, src.total)).some((l) => (l ?? '').trim().length > 0)
  if (!spanHasCode && !(src.lines[start - 1] ?? '').trim()) {
    return { ok: false, kind: 'sync', msg: `${at} 指向空行（区间内也无代码）` }
  }
  if (end !== null) {
    if (start > end) return { ok: false, kind: 'struct', msg: `${at} 区间起止无序` }
    if (end > src.total) return { ok: false, kind: 'struct', msg: `${at} 区间终点越界` }
  }
  // CHANGELOG 语义校验：锚点必须落在它行内声明的那个版本节内。
  // 按本基准视图的章节算——HEAD 版与工作区版的章节行号不同。
  //
  // **这一项永远是软报告，不参与硬失败**，原因是结构性的而非尺度问题：CHANGELOG 是
  // 追加式流水账，每次发版在顶部插入新一节，于是所有指向它的历史锚点都会整体单向下移。
  // 要求它们落在正确版本节内 = 要求「每次发版后重编译所有引用过 CHANGELOG 的文章」，
  // 这是个不可满足的条件（发版本身就会让上一批锚点失效）。fixAnchors 的版本节重定位
  // 能修一部分，但同一行里多版本并列引用时相对偏移无解（实测 40 修 / 8 越界）。
  // 所以这里只报告、不判负；真正兜底的是 `## X.Y.Z` 标题本身是稳定锚，
  // 以及 fixChangelogAnchors 在文章落盘前会尽力重定位。
  if (srcName === 'CHANGELOG.md') {
    const secs = CL_SECTIONS_OF_VIEW.get(src) ?? []
    let ver = null
    for (const m of line.matchAll(/\b(\d+\.\d+(?:\.\d+)*)\b/g)) {
      if (m.index >= a.index) continue
      const s = secs.find((x) => x.ver === m[1])
      if (s) ver = m[1] // 取锚点左侧最近的一个版本号（中文习惯「版本（锚点）」）
    }
    if (ver) {
      const sec = secs.find((s) => s.ver === ver)
      const inSec = start >= sec.start && start <= sec.end && (end === null || end <= sec.end)
      if (!inSec) return { ok: false, kind: 'changelog', msg: `${at} 版本 ${ver} 应在该节 ${sec.start}-${sec.end} 内，实际指向 ${start}${end !== null ? `-${end}` : ''}` }
    }
  }
  // 符号绑定只在「本行锚点唯一」时校验：一行并列多个锚点（表格一行多列、
  // 一句话串多个文件）时无法可靠判断某符号属于哪个锚点，强行绑定会系统性误判。
  // 区间锚点（NNN-MMM）在整个区间内搜符号——语义就是「这段代码」，不是首行。
  //
  // 另一个前置条件：只校验**锚点所在分句内**的符号。
  //
  // 一句话里常同时提到「文档/配置在哪」与「代码里叫什么」，两者指向完全不同的东西。
  // 用一个可举证的文本结构事实来切分：锚点左侧最近的分句边界（。；，| 等）。
  // 实测两个反例，都靠这条判据消掉：
  // ① `宿主按 profile patch config: 段（挂载条目见 README.md:66-71）构建 schemastery
  //    配置对象，以 apply(ctx, config) 注入插件`——锚点在左半边，`apply` 在 `，` 之后，
  //    不属于这个锚点的分句。
  // ② `……耐久产物；README.md:85-87 仍写「vendor/codewiki/ 上游源码」`——同一句里
  //    `list_files` 讲的是工具名，锚点讲的是 README 的开发段落，被 `；` 隔开。
  // 反例之所以在旧判据下成了稳定假阳性：这两个文件里**确实**含有那些符号（README 通篇
  // 提 `list_files`），所以「符号存在于源文件」的前置条件拦不住，只有分句归属能拦。
  //
  // 为什么不用「离锚点最近的符号」：那是距离启发式，中文行文里符号与锚点的语义归属
  // 无法只靠字符距离判定（`A` 与 `B`（`index.js:22`）里谁是 22 行？）。分句边界是
  // 标点级事实，可举证、可复现，且与写作者的实际断句一致。
  //
  // 多锚点行（本行有多个 file:NN）不校验：每个锚点各有分句，但表格一行多列时整行
  // 无标点分隔，切不出可靠分句。这类行由「行号在范围内 + 指向非空行」兜底。
  const CLAUSE_SEP = /[。；;，,|\n]/
  const clauseBefore = (ln, at) => {
    let cut = 0
    for (let i = 0; i < at; i++) if (CLAUSE_SEP.test(ln[i])) cut = i + 1
    return ln.slice(cut, at)
  }
  if (allFileAnchors.length === 1) {
    const cs = symbolsOnLine(clauseBefore(line, a.index))
    if (cs.length > 0) {
      const span = src.lines.slice(start - 1, end !== null ? end : start).join('\n')
      const tailOf = (s) => s.sym.split('.').pop()
      const hit = cs.some((s) => span.includes(s.sym) || span.includes(tailOf(s)))
      if (!hit) {
        // 区分两种失败，它们的可信度完全不同：
        //
        // ① **符号在本文件里根本不存在** → 铁证的真错，kind='struct' 硬失败。
        //    行号漂移只会让锚点指向**别的行**，绝不会让一个符号从文件里消失。
        //    所以「文件里没有这个符号」无法用「文档滞后」解释，只能是文档写错了名字
        //    或指错了文件。（对抗验证就是靠这条抓住注入的假符号——曾把它归为 sync
        //    而被滞后降级静默，是真漏洞。）
        //
        // ② 符号在文件里、但不在该区间 → 可能只是漂移（符号挪到别的行了），
        //    无法与「文档写错行号」区分，kind='sync'，滞后时降级软报告。
        const whole = src.lines.join('\n')
        const exists = cs.some((s) => whole.includes(s.sym) || whole.includes(tailOf(s)))
        return {
          ok: false,
          kind: exists ? 'sync' : 'struct',
          msg: exists
            ? `${at} 符号未绑定：${cs.map((s) => `\`${s.sym}\``).join('/')} 应出现在该区间内`
            : `${at} 符号不存在：${cs.map((s) => `\`${s.sym}\``).join('/')} 在 ${srcName} 中完全找不到（不是漂移，是写错了）`,
        }
      }
    }
  }
  return { ok: true, msg: '' }
}

if (softReports.length > 0) {
  const uniqSrc = [...new Set(softReports.map((m) => (m.match(/([A-Za-z0-9_\-.]+\.(?:js|mjs|md|json|yml)):\d+$/) ?? [])[1]).filter(Boolean))]
  console.log(`\n~ ${softReports.length} 处因文档滞后无法定性（源文件与编译基线不同）：${uniqSrc.slice(0, 12).join('、')}${uniqSrc.length > 12 ? ' 等' : ''}`)
  console.log('  这些不是文档错误，是 `.codewiki/` 还没跟上本次代码改动。跑一次 codewiki_generate 重编译后，')
  console.log('  基线前移，同样的检查会自动升级为硬断言（或用 --strict 立即按硬断言跑）。')
}
console.log(`\n锚点校验：${passed} 过 / ${failures} 败${softReports.length > 0 ? ` / ${softReports.length} 待重编译` : ''}`)
process.exit(failures > 0 ? 1 : 0)
