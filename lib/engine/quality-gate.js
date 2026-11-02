// 阶段 3：原生产物的**采用门**（quality gate）。
//
// 位置：引擎把 docs 树交回来之后、写进 .codewiki/ 与 CodeWiki.md 之前。
// 阶段 2 的 output.js 只判「产物自身是否自洽」（页在不在、正文空不空、链接指的东西
// 在不在计划内）；这一层判的是「这批产物能不能被 wiki 采用」——把三件事合成一个
// 可机读的裁决：
//
//   1. **产物自洽**：复用 output.js 的 validateOutput（不重写任何判定）；
//   2. **目标格式契约**：把映射结果渲染成真正的 wiki 文章（frontmatter + 正文），再走
//      article-contract.js 的 inspectArticle（frontmatter 唯一闭合 / 围栏 / 死链 /
//      source_files 证据 / 类型与位置匹配）；
//   3. **基线可推进性**：产物对应的 commit 必须是**已提交**的 HEAD，且 `.codewiki/_meta.yaml`
//      的基线本身已入库——未提交的工作区内容不得被当成已提交基线。
//
// ── 三类问题必须分开（这是本模块存在的核心理由） ───────────────────────────
//
// 0.14.0 的教训是「1 篇成功 + 19 篇失败也报 done」。但反过来把一切都塞进一个
// blockers 数组同样有害：**引擎会被归咎于不是它的问题**，或者**wiki 的陈旧状态被
// 当成产品缺陷**，两条路都会让运维在错的地方找原因。所以分类是机读的：
//
//   defect       产品缺陷：本次引擎产物自身的问题（缺入口/缺页/空正文/死链/
//                source_files 指向不存在的文件/frontmatter 坏了/围栏未闭合/
//                产物对应的 commit 不是 HEAD）。处置：不让它算完整成功。
//   degradation  能力降级：产物可用但证据不足（whole-repository 模式下
//                module_tree 为空 → 页没有归属与 source_files；有页映射不进 wiki）。
//                处置：可以入库，但**增量 ownership 不可信，因此不得推进基线**。
//                注意这与 defect 的差别：页是真的、内容是真的，只是没法归属。
//   stale        wiki 状态陈旧：不是本次产物的错（既有 wiki 的基线落后 HEAD、
//                基线只在工作区未提交）。处置：如实报告；只有「基线未入库」这一条
//                会阻止推进（把未提交状态固化成已提交基线是不可逆的记账错误）。
//
// 终态仍然严格：**只有三类皆空才是 done**。分类改变的是「谁来修、修什么」的定位，
// 不是放宽闸门——放宽正是迁移里最危险的方向。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateOutput, bodyLength } from './output.js'
import { inspectArticle, fencesBalanced, parseFrontmatter } from '../article-contract.js'
import { WIKI_ENTRY, WIKI_META_REL } from './mapping.js'
import { toPosix as posix } from '../git-paths.js'

export const GATE_VERSION = 1

// defect 类别。稳定、可机读；新增只允许追加（消费者按 kind 分派）。
export const GATE_DEFECT_KINDS = Object.freeze([
  'missing-docs-dir',    // 引擎根本没产出 docs（不可能采用）
  'missing-metadata',    // 缺 metadata.json → 无法确定产物对应哪个 commit
  'missing-module-tree', // 缺 module_tree.json
  'bad-json',            // JSON 存在但不可解析
  'entry-missing',       // 没有 overview.md → 没有 CodeWiki.md 入口，整批不可入库
  'empty-body',          // 页除标题外没有正文（写进 wiki 就是空壳）
  'article-missing',     // 模块树里有模块但没有对应页
  'unmapped-page',       // 页在 docs 里但映射不到 wiki 的任何位置
  'source-missing',      // source_files 指向仓库里不存在的文件
  'dead-link',           // 正文相对链接指向计划外的页
  'article-contract',    // 渲染后的文章未过 article-contract 的 error 级判据
  'commit-mismatch',     // 产物对应的 commit 不是当前 HEAD（对不上代码）
  'uncommitted-input',   // 工作区有未提交的源码改动 → 产物反映的不是任何 commit
])

export const GATE_DEGRADATION_KINDS = Object.freeze([
  'empty-module-tree',   // whole-repository 模式：归属证据整体缺失
  'no-source-evidence',  // 该页 source_files 为空（未臆造，但增量归属不可用）
  'missing-section',     // 原生通道：缺该通道要求的章节（warning 级）
  'empty-section-optional', // 章节存在但空（warning 级）
])

export const GATE_STALE_KINDS = Object.freeze([
  'baseline-behind-head', // 既有 wiki 的编译基线落后 HEAD（本次跑的目的，只报告）
  'baseline-uncommitted', // 基线只在工作区未提交 → 不得当作已提交基线推进
  'baseline-absent',      // 从没有过基线（首次编译）
])

const DEFECT_SET = new Set(GATE_DEFECT_KINDS)
const DEGRADATION_SET = new Set(GATE_DEGRADATION_KINDS)
const STALE_SET = new Set(GATE_STALE_KINDS)

// 原生通道的章节要求：**不沿用** cw agentic 通道的 Overview/Key Components。
// FSoft 的正文由上游 prompt 决定（`## Introduction and Purpose`、`## 1. Purpose`…），
// 而计划硬约束是「不改技术内容」——用别的通道的章节名去判它，产出的每一条都是
// **不可修复**的 warning，闸门会退化成噪声，真实产物永远 partial。
// 所以这里传 [] 只查结构（frontmatter/围栏/正文/死链/来源），章节的非空性由
// renderArticle 的 inspection 单独判「至少一个非空二级标题」（见 checkRendered）。
const NATIVE_REQUIRED_SECTIONS = Object.freeze([])

// ── git 只读助手 ──────────────────────────────────────────────────────────

function git(repoRoot, args, { timeout = 15000 } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

function parseMetaCommit(text) {
  const m = String(text ?? '').match(/^last_compiled_commit:\s*(\S+)\s*$/m)
  if (!m) return null
  const value = m[1].replace(/^['"]|['"]$/g, '')
  // cw init 写的是 `last_compiled_commit: null`（YAML null）。不归一就会得到一个
  // 字面量字符串 "null"，被当成一个真实基线 commit。
  if (value === '' || value === 'null' || value === '~') return null
  return value
}

const SHA_RE = /^[0-9a-f]{40}$/i

// 读**已提交**的编译基线：`git show HEAD:.codewiki/_meta.yaml`，不是工作区文件。
//
// 为什么不能用工作区：工作区的 _meta.yaml 随时可能是上一轮编译刚写、还没提交的内容
// （本仓库的自动提交是插件侧异步做的，中间存在「已写入、未提交」窗口）。把它当基线
// 等于把一堆未提交的产物宣布成「已消化」，而 git 里根本没有它们的记录——下次编译
// 的 base 会指向一个不存在的状态，变化要么重复消费要么永久失明。
export function readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL } = {}) {
  const root = String(repoRoot ?? '')
  const rel = posix(relPath)
  const out = {
    ok: false, source: 'absent', commit: null,
    worktreeCommit: null, dirty: false, reason: '',
  }
  if (!root || !rel) { out.reason = '未提供 repoRoot'; return out }

  const committedText = git(root, ['show', `HEAD:${rel}`])
  let worktreeText = null
  try { worktreeText = fs.readFileSync(path.join(root, rel), 'utf8') } catch { /* 工作区没有 */ }
  out.worktreeCommit = worktreeText === null ? null : parseMetaCommit(worktreeText)

  if (committedText !== null) {
    const head = parseMetaCommit(committedText)
    out.source = 'git-head'
    out.commit = head
    out.ok = Boolean(head)
    if (worktreeText !== null && out.worktreeCommit !== head) out.dirty = true
    if (!head) out.reason = `${rel} 在 HEAD 里没有 last_compiled_commit 行`
    return out
  }
  if (worktreeText !== null) {
    // 工作区有、HEAD 没有：这份基线从未入库，不能算「已提交基线」。
    out.source = 'worktree-only'
    out.commit = null
    out.ok = false
    out.dirty = true
    out.reason = `${rel} 只存在于工作区、未提交：不能当作已提交基线（推进它会把未提交状态记成已消化）`
    return out
  }
  out.reason = `${rel} 不存在（首次编译）`
  return out
}

// 工作区是否有「非 wiki」的未提交改动。
// wiki 自身的产物（.codewiki/ 与 CodeWiki.md）不算——它们正是本轮要写的东西；
// 其余任何改动都意味着引擎读到的源码不在任何 commit 里，产物对不上可追溯的状态。
const WIKI_PATHS = Object.freeze(['.codewiki/', 'CodeWiki.md'])

export function uncommittedSourceChanges({ repoRoot } = {}) {
  const root = String(repoRoot ?? '')
  if (!root) return { ok: false, paths: [], reason: '未提供 repoRoot' }
  const raw = git(root, ['status', '--porcelain', '--untracked-files=all'])
  if (raw === null) return { ok: false, paths: [], reason: 'git status 失败（不是 git 仓库？）' }
  const paths = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    // porcelain v1：XY<space>path（重命名是 `orig -> new`，取 new 一侧）
    const rest = line.slice(3).trim()
    const p = posix(rest.includes(' -> ') ? rest.split(' -> ').pop() : rest).replace(/^"|"$/g, '')
    if (!p) continue
    if (WIKI_PATHS.some((w) => p === w || p.startsWith(w))) continue
    paths.push(p)
  }
  return { ok: true, paths, reason: '' }
}

// ── 基线裁决 ──────────────────────────────────────────────────────────────

// 「空骨架」= 那份 _meta.yaml 还没有 last_compiled_commit（cw init 的初值就是 null）。
// 这种文件没有任何历史进度，因此不存在「把未提交状态记成已消化」的风险。
// 两种来源都算：cw init 之后未提交（worktree-only）、以及 init 产物已入库（git-head）。
function isEmptyBaseline(base) {
  if (!base || base.commit || base.worktreeCommit) return false
  return base.source === 'worktree-only' || base.source === 'git-head'
}

/**
 * 判「这批产物的基线能不能被推进」。
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {string|null} o.artifactCommit 产物 metadata.generation_info.commit_id
 * @param {object|null} o.baseline        readCommittedBaseline 的结果（不给则现读）
 * @param {boolean} [o.requireCommittedInput=true] 是否要求产物对应已提交且干净的 HEAD
 * @param {string|null} [o.consumedInputCommit=null] 本轮合成的工作区快照 commit（产物对它的即为「对得上」）
 * @returns {{ok:boolean, headCommit:string|null, artifactCommit:string|null, defects:object[], stale:object[], writable:boolean}}
 */
export function assessBaseline({ repoRoot, artifactCommit = null, baseline = null, requireCommittedInput = true, consumedInputCommit = null } = {}) {
  const defects = []
  const stale = []
  const root = String(repoRoot ?? '')
  const headCommit = root ? String(git(root, ['rev-parse', 'HEAD']) ?? '').trim() || null : null
  const base = baseline ?? (root ? readCommittedBaseline({ repoRoot: root }) : null)
  const art = artifactCommit ? String(artifactCommit).trim() : null

  if (!requireCommittedInput) {
    return { ok: true, headCommit, artifactCommit: art, defects, stale, writable: true }
  }

  if (!root) {
    defects.push({ kind: 'commit-mismatch', scope: 'product', detail: '未提供 repoRoot，无法确认产物对应的 commit' })
  } else if (!headCommit) {
    defects.push({ kind: 'commit-mismatch', scope: 'product', detail: 'git rev-parse HEAD 失败：仓库没有可追溯的 HEAD' })
  } else {
    // 本轮若已把工作区改动合成临时 commit（native-run 的 1.9 段），产物对应的
    // 就是那棵**含工作区内容**的树。它当然不等于 HEAD，但这不是「对不上代码」，
    // 而是「对上了比 HEAD 更完整的代码」——再报 commit-mismatch 只会把准确的
    // 事实说成错误。基线推进仍由下面的 uncommitted-input 拦住：快照不挂 ref，
    // 把它记成已提交基线就是不可逆的「变化悄悄丢」。
    const consumed = consumedInputCommit ? String(consumedInputCommit).trim() : null
    if (!art) {
      defects.push({ kind: 'missing-metadata', scope: 'product', detail: '产物 metadata 没有 generation_info.commit_id，无法确认它对哪个 commit 生成' })
    } else if (!SHA_RE.test(art)) {
      defects.push({ kind: 'commit-mismatch', scope: 'product', detail: `commit_id 不是 40 位 sha：${art}` })
    } else if (art !== headCommit && art !== consumed) {
      defects.push({
        kind: 'commit-mismatch', scope: 'product',
        detail: `产物对应 ${art.slice(0, 12)}，当前 HEAD 是 ${headCommit.slice(0, 12)}——产物对不上当前代码`,
      })
    }
    const dirty = uncommittedSourceChanges({ repoRoot: root })
    if (dirty.ok && dirty.paths.length) {
      defects.push({
        kind: 'uncommitted-input', scope: 'product',
        detail: `工作区有 ${dirty.paths.length} 个未提交源码改动（${dirty.paths.slice(0, 5).join('、')}${dirty.paths.length > 5 ? ' 等' : ''}）：产物反映的内容不在任何 commit 里，不能作为已提交基线`,
      })
    } else if (!dirty.ok) {
      defects.push({ kind: 'commit-mismatch', scope: 'product', detail: `无法确认工作区状态：${dirty.reason}` })
    }
  }

  // 基线自身的陈旧：报告但不归咎引擎
  if (base) {
    if (base.source === 'absent') {
      stale.push({ kind: 'baseline-absent', scope: 'wiki', detail: base.reason || '从未编译过' })
    } else if (isEmptyBaseline(base)) {
      // 工作区里只有一份**空骨架**（本轮 cw init 刚建出来，last_compiled_commit 为 null）：
      // 它没有任何历史进度可吞，推进它不会把未提交状态记成已消化。若照 worktree-only
      // 判成未入库基线，首次编译就永远推进不了基线，而 apply 事实上又推进并提交了它。
      stale.push({
        kind: 'baseline-absent', scope: 'wiki',
        detail: `${WIKI_META_REL} 是本轮初始化的空骨架（没有 last_compiled_commit）：属于首次编译，没有历史进度可吞`,
      })
    } else if (!base.ok || base.source !== 'git-head' || base.dirty) {
      stale.push({ kind: 'baseline-uncommitted', scope: 'wiki', detail: base.reason || '编译基线未入库或与工作区不一致' })
    } else if (headCommit && base.commit && base.commit !== headCommit) {
      stale.push({
        kind: 'baseline-behind-head', scope: 'wiki',
        detail: `既有基线 ${base.commit.slice(0, 12)} 落后 HEAD ${headCommit.slice(0, 12)}（本轮编译正是为了消化它）`,
      })
    }
  }

  // 只有「基线未入库」这一条陈旧会阻止推进：把工作区的未提交状态记成已消化是不可逆的。
  const blockingStale = stale.filter((s) => s.kind === 'baseline-uncommitted')
  const ok = defects.length === 0 && blockingStale.length === 0
  return { ok, headCommit, artifactCommit: art, defects, stale, writable: true }
}

// ── 文章渲染（格式翻译，不改正文） ────────────────────────────────────────

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim()
}

// YAML 标量的安全序列化。
//
// 为什么必须做：`cw` 用 serde_yaml 解析 frontmatter（vendor/codewiki 的 `parse_frontmatter`）。
// 真实的 FSoft 页标题里确实会出现这些字符——`# Core Engine (src/core/engine.py)`、
// `Support: batch & stream`、带反斜杠的 Windows 路径。plain scalar 一旦含 `: `（冒号+空格）
// 或 ` #`，serde_yaml 会把整行解析成「键 + 嵌套映射」或截断成注释，parse_frontmatter 直接
// 判坏头、整篇文章被判不合法（cw index 里缺这篇）——而这是我们合成的头，不是模型写的，
// 我们没有理由让它成为唯一不可修的一类失败。
//
// 做法：只在**确实不安全**时才加双引号。JSON 字符串字面量是合法 YAML 双引号标量
// （YAML 1.2 是 JSON 的超集），所以 `JSON.stringify` 就是正确转义——不用自己造转义表。
// 安全形态保持裸值，是为了与既有文章的 frontmatter 观感一致（`title: change_set`）。
const YAML_UNSAFE_HEAD = /^[-?:,[\]{}#&*!|>'"%@`~]/
// serde_yaml 会把裸值按类型解析（YAML 1.1/1.2 的隐式类型），这些值裸写会变成非字符串。
const YAML_RESERVED = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', ''])
const YAML_NUMBER = /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

export function yamlScalar(value) {
  const s = String(value ?? '')
  // 控制字符无法用双引号以外的形式表达，JSON.stringify 会转成 \u0001 —— serde_yaml 认。
  const hasControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)
  const plainUnsafe =
    s.trim() !== s                    // 首尾空格会被 YAML 吃掉
    || hasControl
    || s.includes('\n') || s.includes('\r')
    // 反斜杠一律引号化：YAML plain scalar 里反斜杠不转义，但本仓库真实出现这种形态
    // （Windows 路径、'src\core\engine.py'）。裸写与双引号写法看起来
    // 一模一样，语义差别却要靠读者记住「plain 里反斜杠不转义」——这种一眼分不出的值
    // 不值得省两个引号。引号化后有唯一确定的 JSON 语义，可被逐字反解验证。
    || s.includes('\\')
    || s.includes(': ') || s.endsWith(':')
    || s.includes(' #') || s.startsWith('#')
    || YAML_UNSAFE_HEAD.test(s)
    || YAML_RESERVED.has(s.toLowerCase())
    || YAML_NUMBER.test(s)
  return plainUnsafe ? JSON.stringify(s) : s
}

// 从正文提取 H1 文本作为 frontmatter title（提不到就用模块名）。
export function titleOf(bodyText, fallback) {
  for (const line of String(bodyText ?? '').split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/)
    if (m) return oneLine(m[1])
  }
  return oneLine(fallback)
}

/**
 * 跨页链接重写：把正文里指向**引擎原始页名**的链接换成落地后的 wiki 路径。
 *
 * 为什么必须做：引擎产物页名是 agent_runtime.md，落地时按 slug 规则改名成
 * agent-runtime.md，而正文里的跨页链接仍写着原名。不改写的话，wiki 里每一条
 * 跨页链接点开都是 404 —— 真机测得本仓 420 条内部链接有 412 条失效。
 *
 * 只改「路径」，不动正文措辞：非 .md 链接（源码引用）与外链一律原样保留。
 * pageMap 为空时整篇原样返回，保证「没有映射时正文一字不动」这条不变量。
 *
 * @param {string} text 正文
 * @param {Map<string,string>|null} pageMap 原始页名 → 落地 wiki 相对路径
 * @param {string} articleWikiPath 当前文章落地后的 wiki 相对路径（算相对地址用）
 * @returns {string}
 */
export function rewritePageLinks(text, pageMap, articleWikiPath) {
  const src = String(text ?? '')
  if (!(pageMap instanceof Map) || pageMap.size === 0) return src
  const baseDir = posix(path.posix.dirname(String(articleWikiPath ?? '')))
  return src.replace(/\]\(([^)\s]+\.md)(#[^)\s]*)?\)/g, (whole, rawTarget, anchorPart) => {
    if (/^[a-z]+:/i.test(rawTarget)) return whole
    const stripped = String(rawTarget).replace(/^\.\//, '')
    const landed = pageMap.get(stripped)
    if (!landed) return whole
    const rel = posix(path.posix.relative(baseDir || '.', landed))
    // 同目录（没有斜杠）直接写文件名：与引擎原文风格一致，避免无谓的 ./ 前缀 diff；
    // 跨目录时补齐 ./，否则 dsh-xxx.md 与 ../y/z.md 混在一处容易看错层级。
    const href = rel.includes('/') && !rel.startsWith('.') ? './' + rel : rel
    return '](' + href + (anchorPart || '') + ')'
    return '](' + rel + (anchorPart || '') + ')'
  })
}
/**
 * 把映射出的一篇文章渲染成 wiki 文章的**完整文本**：合成的 frontmatter + FSoft 原文。
 *
 * 三条硬约束（都在测试里钉死）：
 *   1. **正文一字不动**。不删 H1、不改标题、不重写链接、不补章节。产物规范化只处理
 *      格式与路径（计划明文），正文一旦被本层改写，「模型写了什么」就无法逐字复核。
 *      H1 与 frontmatter title 重复是纯观感问题，由消费方决定，不在这里裁剪内容。
 *   2. **frontmatter 只填有证据的字段**。source_files 原样来自映射（空就是空），
 *      绝不按目录名猜；type 由映射给；tags 空列表（允许）。
 *   3. **可回溯**。`fsoft_page` 记住这篇的正文来自 FSoft 原始树的哪个文件，
 *      于是「wiki 里的这篇 ≠ 引擎产出的那篇」永远可以逐字比对。
 *
 * @param {object} o
 * @param {object} o.article  mapping 产出的一篇 {wikiPath, type, moduleName, sourceFiles, source}
 * @param {string} o.body     FSoft 原文
 * @returns {string}
 */
export function renderArticle({ article, body, pageMap = null } = {}) {
  const a = article ?? {}
  // 正文只做两类规范化：剥 BOM、把跨页链接改成落地路径。措辞与结构一律不动。
  const raw = String(body ?? '').replace(/^\uFEFF/, '')
  const text = rewritePageLinks(raw, pageMap, a.wikiPath ?? '')
  const title = titleOf(text, a.moduleName ?? a.source ?? 'untitled')
  const type = String(a.type ?? 'module')
  const sources = Array.isArray(a.sourceFiles) ? a.sourceFiles.map(posix).filter(Boolean) : []
  const lines = ['---', `title: ${yamlScalar(title)}`, `type: ${yamlScalar(type)}`]
  if (sources.length) {
    lines.push('source_files:')
    for (const s of sources) lines.push(`  - ${yamlScalar(s)}`)
  } else {
    // 空列表要显式写出来：省略这个字段会让 downstream 以为「没声明」而不是「声明为空」。
    lines.push('source_files: []')
  }
  // 列表形态与 `[a, b]` 形态都要能过 serde_yaml；用空列表最不易出错。
  lines.push('tags: []')
  lines.push('generated_by: fsoft-native')
  if (a.source) lines.push(`fsoft_page: ${yamlScalar(posix(a.source))}`)
  // 结束标记后**不插空行**：parseFrontmatter 会把空行算进 body，于是「正文一字不动」
  // 就变成「正文 = 原文，但前面多一个换行」——逐字比对永远对不上，而这条正是
  // 「wiki 里这篇 = 引擎产出的那篇」唯一可验证的形式。frontmatter 紧接正文是合法
  // markdown（Jekyll/Hugo 同样接受，serde_yaml 的 parse_frontmatter 也按行切）。
  lines.push('---')
  return `${lines.join('\n')}\n${text}`
}

// 渲染后的逐篇检查：先走 article-contract（复用，不重写），再补两条原生通道专属判据。
//   · 原生页必须有**至少一个非空二级标题**——FSoft 的正文结构是它自己的章节体系，
//     一篇通篇没有 ## 的页在 wiki 里读起来就是一坨段落（真实产物里不会出现，但
//     引擎的降级/截断路径可能产出来）。
function checkRendered({ content, article, cwd, fsoftPage, allowedLinks = null }) {
  const issues = inspectArticle(content, {
    cwd: cwd ?? null,
    articlePath: posix(article.wikiPath),
    expectedType: article.type,
    readableSources: null, // 原生通道的证据判定在 output.js 的 source-missing 里做
    // 死链由 output.js 的 dead-link 判（docs 内相对路径）；这里带「落地后」的页路径，
    // 让契约层的链接检查认得 slug 之后的真实文件名，而不是引擎的原始页名。
    allowedLinks,
    // 不传 fsImpl：source_files 的存在性已经在 output.js 的 source-missing 里判过一次，
    // 这里再判一遍只会把同一条缺陷翻倍上报（同一处缺失被两个模块各记一次）。
    fsImpl: null,
    requiredSections: NATIVE_REQUIRED_SECTIONS,
    // whole-repository 通道的空 source_files 是诚实记录（见 article-contract.js 的开关注释）；
    // 它在这里被降级成 degradation，而不是 error 拒写。
    allowEmptySourceFiles: true,
  })
  const extra = []
  // 判「有没有正文」必须剥掉我们**自己合成**的 frontmatter 再算：bodyLength 只跳过第一个
  // 标题行，直接喂全文会把 8 行 frontmatter 当成正文，于是 `# Web` 这种只有标题的空壳页
  // bodyLength 反而 ≈ 100，永远判不出空。而 inspectArticle 的 empty-body 判的是
  // `body.trim()`，H1 在就非空 —— 两条路都放过空壳页。这里用剥头后的正文兜住。
  const fm = parseFrontmatter(content)
  const pageBody = fm.fields ? fm.body : content
  if (bodyLength(pageBody) === 0) {
    const detail = fm.fields ? '渲染后的文章除标题外没有正文' : '渲染后的文章没有正文'
    extra.push({ kind: 'empty-body', severity: 'error', detail })
  }
  return { issues: [...issues, ...extra], fsoftPage }
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 对一批原生产物做采用裁决。纯组合：读产物（output.js）→ 渲染 → 契约 → 基线。
 *
 * @param {object} o
 * @param {string} o.docsDir            引擎产出的 docs 目录
 * @param {string} [o.repoRoot]         仓库根（source_files 存在性、git 基线判定用）
 * @param {object} [o.componentFiles]   组件 id → 仓库相对文件（source_files 的唯一证据）
 * @param {string} [o.overviewName]     overview 页文件名
 * @param {object} [o.baseline]         readCommittedBaseline 的结果（不给则现读）
 * @param {boolean} [o.requireCommittedInput=true] 是否要求产物对应干净的已提交 HEAD
 * @param {string|null} [o.consumedInputCommit=null] 本轮合成的工作区快照 commit（产物对它的即为「对得上」）
 * @param {boolean} [o.includeContent=true]        是否在返回值里带上渲染后的正文
 * @returns {object} GateReport（可 JSON 序列化）
 */
export function gateNativeOutput({
  docsDir,
  repoRoot = null,
  componentFiles = {},
  overviewName = 'overview.md',
  baseline = null,
  requireCommittedInput = true,
  consumedInputCommit = null,
  includeContent = true,
} = {}) {
  const root = repoRoot ? String(repoRoot) : null
  const validation = validateOutput({ docsDir, repoRoot: root ?? undefined, componentFiles, overviewName })
  const { collected, mapped } = validation

  const defects = []
  const degradations = []
  const pushDefect = (kind, detail, extra = {}) => {
    if (!DEFECT_SET.has(kind)) throw new Error(`gateNativeOutput: 未登记的 defect 类别 ${kind}`)
    defects.push({ kind, scope: 'product', detail, ...extra })
  }
  const pushDegradation = (kind, detail, extra = {}) => {
    if (!DEGRADATION_SET.has(kind)) throw new Error(`gateNativeOutput: 未登记的 degradation 类别 ${kind}`)
    degradations.push({ kind, scope: 'product', detail, ...extra })
  }

  // 1) 产物自洽 → defect / degradation 分流。
  //    empty-module-tree 在 output.js 里是 problem，但它的性质是「证据缺失」而不是
  //    「产物坏了」：whole-repository 模式下 FSoft 本来就把 module_tree 留成 {}。
  //    所以映射成 degradation —— 页照写，但增量归属不可用，基线不得推进。
  for (const p of validation.problems) {
    if (p.kind === 'empty-module-tree') {
      pushDegradation('empty-module-tree', p.detail, { source: p.source })
      continue
    }
    if (p.kind === 'article-missing') {
      pushDefect('article-missing', p.detail, { source: p.source })
      continue
    }
    if (p.kind === 'unmapped-page') {
      pushDefect('unmapped-page', p.detail, { source: p.source })
      continue
    }
    if (DEFECT_SET.has(p.kind)) {
      pushDefect(p.kind, p.detail, { source: p.source, target: p.target })
      continue
    }
    // 未来 output.js 新增类别时不许静默吞掉：当成 defect 报出来，逼这里补映射。
    pushDefect('article-contract', `未映射的产物问题 ${p.kind}：${p.detail}`, { source: p.source })
  }

  // 2) 入口：没有 overview 就没有 CodeWiki.md，整批不可入库。
  const entry = mapped.entry
    ? { source: posix(mapped.entry.source), path: WIKI_ENTRY, ok: true }
    : null
  let entryContent = null
  if (entry) {
    try {
      entryContent = fs.readFileSync(path.join(String(docsDir ?? ''), entry.source), 'utf8')
    } catch (err) {
      entry.ok = false
      pushDefect('entry-missing', `入口页 ${entry.source} 不可读：${err.code ?? err.message}`)
    }
    if (entryContent !== null) {
      if (bodyLength(entryContent) === 0) {
        entry.ok = false
        pushDefect('empty-body', `入口页 ${entry.source} 除标题外没有正文`, { source: entry.source })
      }
      const fences = fencesBalanced(entryContent)
      if (!fences.balanced) {
        entry.ok = false
        pushDefect('article-contract', `入口页 ${entry.source} 代码围栏未闭合（${fences.count} 个围栏标记）`, { source: entry.source })
      }
    }
  }

  // 3) 逐篇渲染 + 契约
  //
  // 跨页链接必须按**落地后**的页名重写：引擎原文写的是 agent_runtime.md，落地时被
  // slug 成 agent-runtime.md。不重写就是「每一条跨页链接点开 404」——真机实测本仓
  // 420 条内部链接有 412 条失效。pageMap 由映射结果构造，根页统一指向 CodeWiki.md。
  const pageMap = new Map()
  for (const a of mapped.articles) {
    const from = posix(a.source)
    const to = posix(a.wikiPath)
    if (from && to) pageMap.set(from, to)
  }
  if (entry?.source && entry?.wikiPath) pageMap.set(posix(entry.source), posix(entry.wikiPath))
  // 契约层只需要「允许的目标集合」：落地路径 + 根页入口名
  const allowedLinks = [...new Set([...pageMap.values(), WIKI_ENTRY])]
  const rendered = []
  const articles = []
  for (const a of mapped.articles) {
    const wikiPath = posix(a.wikiPath)
    let body = ''
    try {
      body = fs.readFileSync(path.join(String(docsDir ?? ''), posix(a.source)), 'utf8')
    } catch (err) {
      pushDefect('empty-body', `${a.source} 不可读：${err.code ?? err.message}`, { source: a.source })
      articles.push({ source: posix(a.source), wikiPath, type: a.type, action: 'skip', defects: 1, degradations: 0 })
      continue
    }
    const content = renderArticle({ article: a, body, pageMap })
    const { issues } = checkRendered({
      content, article: a, cwd: root, fsoftPage: posix(a.source), allowedLinks,
    })
    const pageDefects = []
    const pageDegradations = []
    for (const issue of issues) {
      const severity = issue.severity ?? 'error'
      if (severity === 'error') pageDefects.push(issue)
      else pageDegradations.push(issue)
    }
    for (const d of pageDefects) {
      pushDefect('article-contract', `${wikiPath}：${d.detail}`, { source: posix(a.source), target: wikiPath, issue: d.kind })
    }
    for (const d of pageDegradations) {
      // article-contract 的 warning 级（缺章节/空章节）在这里是「原生通道未要求该章节」，
      // 但既然它报了，就是该通道的正文有结构缺口 —— 记成 degradation 而不是丢掉。
      pushDegradation(DEGRADATION_SET.has(d.kind) ? d.kind : 'missing-section', `${wikiPath}：${d.detail}`, {
        source: posix(a.source), target: wikiPath, issue: d.kind,
      })
    }
    // 4) 空 source_files：证据降级（页照写，增量归属不可用）
    if (!Array.isArray(a.sourceFiles) || a.sourceFiles.length === 0) {
      pushDegradation('no-source-evidence',
        `${wikiPath} 的 source_files 为空（${a.attribution === 'unattributed' ? 'whole-repository 模式无归属证据' : '组件无文件级映射'}）：文章可用，但该页的增量归属不可用`,
        { source: posix(a.source), target: wikiPath })
    }
    articles.push({
      source: posix(a.source),
      wikiPath,
      type: a.type,
      pageKind: a.pageKind ?? null,
      moduleName: a.moduleName ?? null,
      sourceFiles: Array.isArray(a.sourceFiles) ? a.sourceFiles.slice() : [],
      attribution: a.attribution ?? null,
      action: pageDefects.length ? 'skip' : 'write',
      defects: pageDefects.length,
      degradations: pageDegradations.length,
    })
    if (includeContent && pageDefects.length === 0) rendered.push({ source: posix(a.source), wikiPath, type: a.type, content })
  }

  // 5) 基线
  const treeCommit = collected.json.metadata?.generation_info?.commit_id ?? null
  const baselineReport = assessBaseline({
    repoRoot: root, artifactCommit: treeCommit, baseline, requireCommittedInput, consumedInputCommit,
  })
  defects.push(...baselineReport.defects)
  const stale = baselineReport.stale

  // 6) 终态合成（严格：三类皆空才 done）
  const writable = Boolean(entry && entry.ok)
  const blocking = [
    ...defects.map((d) => ({ kind: d.kind, scope: d.scope, detail: d.detail, source: d.source, target: d.target })),
    ...degradations.map((d) => ({ kind: d.kind, scope: d.scope, detail: d.detail, source: d.source, target: d.target })),
    ...stale.filter((s) => s.kind === 'baseline-uncommitted').map((s) => ({ kind: s.kind, scope: s.scope, detail: s.detail })),
  ]

  let outcome
  if (!writable) outcome = 'failed'
  else if (blocking.length) outcome = 'partial'
  else outcome = 'done'

  // 基线许可（baselineEligible）只有一种来源：本轮三类问题**全空**（outcome=done）。
  // 0.16.1 曾允许 partial 也许可推进，用来打破「永远 partial ⇒ 基线永不推进 ⇒ 下一轮
  // 又重复消费」的死循环；但那条例外把「没消化完」直接记成已消化，且与落地器的
  // 「partial 不推基线」互相矛盾（门说可推、落地器照写、终态却报 partial）。
  // 死循环的正确解法是让**首次编译**能走成 done（空骨架不算未入库基线），
  // 而不是让 partial 偷偷推进。
  const baselineEligible = outcome === 'done'
  return {
    version: GATE_VERSION,
    ok: outcome === 'done',
    outcome,
    writable,
    baselineEligible,
    // 兼容字段：老调用方/旧 job 记录只认这个名字，语义与 baselineEligible 完全一致。
    canAdvanceBaseline: baselineEligible,
    entry,
    articles,
    rendered,
    defects,
    degradations,
    stale,
    blockers: blocking,
    counts: {
      pages: collected.pages.length,
      articles: mapped.articles.length,
      writable: articles.filter((a) => a.action === 'write').length,
      skipped: articles.filter((a) => a.action === 'skip').length,
      unmapped: mapped.unmapped.length,
      defects: defects.length,
      degradations: degradations.length,
      stale: stale.length,
    },
    baseline: {
      headCommit: baselineReport.headCommit,
      artifactCommit: baselineReport.artifactCommit,
      source: baseline?.source ?? (root ? readCommittedBaseline({ repoRoot: root }).source : 'absent'),
    },
  }
}

// 供上层写 update-record 用：把 gate 的 blockers 翻成 contract.js 的 BLOCKER_KINDS。
// 一一对应不了的一律归 'quality-gate'（宁可粗也不能漏），并保留原 kind 在 detail 里。
const TO_CONTRACT_KIND = {
  'entry-missing': 'article-missing',
  'article-missing': 'article-missing',
  'empty-body': 'quality-gate',
  'dead-link': 'quality-gate',
  'source-missing': 'quality-gate',
  'article-contract': 'quality-gate',
  'unmapped-page': 'unmapped-page',
  'missing-docs-dir': 'engine-error',
  'bad-json': 'engine-error',
  'commit-mismatch': 'quality-gate',
  'uncommitted-input': 'quality-gate',
  'empty-module-tree': 'quality-gate',
  'no-source-evidence': 'quality-gate',
  'baseline-uncommitted': 'baseline-failed',
}

export function toContractBlockers(report) {
  return (report?.blockers ?? []).map((b) => ({
    kind: TO_CONTRACT_KIND[b.kind] ?? 'quality-gate',
    detail: `[${b.kind}/${b.scope}] ${b.detail}`.slice(0, 2000),
    ...(b.source ? { source: b.source } : {}),
    ...(b.target ? { target: b.target } : {}),
  }))
}

/**
 * 把 gate 的结论翻成 update-record 的 `qualityIssues`（judgeOutcome 的输入之一）。
 *
 * 为什么必须有这一条：`judgeOutcome` 只按「计划内文章写成了没有」判 done——一篇
 * **可写但 source_files 为空**的页在它眼里就是「成功」，于是 outcome 会被判成 done
 * 并推进基线。而空 source_files 正是「增量归属不可用」的证据降级，推进基线等于
 * 把一份归属不明的产物记成「已消化」。gate 已经把它算成 blocking，但阶段 4 接线时
 * 走的是 judgeOutcome 那条路，所以这里必须显式喂进去——两条判定路径不能一个严一个松。
 *
 * @param {object} report gateNativeOutput 的返回值
 * @returns {Array<{name:string|null, issue:string}>}
 */
export function toQualityIssues(report) {
  const out = []
  for (const d of report?.degradations ?? []) {
    out.push({ name: d.target ?? null, issue: `[${d.kind}] ${d.detail}`.slice(0, 300) })
  }
  for (const d of report?.defects ?? []) {
    out.push({ name: d.target ?? null, issue: `[${d.kind}] ${d.detail}`.slice(0, 300) })
  }
  for (const s of report?.stale ?? []) {
    // 只有「基线未入库」这一条属于阻塞；其余陈旧（基线落后 HEAD）正是本轮要消化的对象，
    // 混进去会让每次增量都落 partial，等于把诚实终态退化成永远不完整。
    if (s.kind === 'baseline-uncommitted') out.push({ name: null, issue: `[${s.kind}] ${s.detail}`.slice(0, 300) })
  }
  return out
}

export default {
  GATE_VERSION,
  GATE_DEFECT_KINDS,
  GATE_DEGRADATION_KINDS,
  GATE_STALE_KINDS,
  gateNativeOutput,
  renderArticle,
  titleOf,
  readCommittedBaseline,
  uncommittedSourceChanges,
  assessBaseline,
  toContractBlockers,
  toQualityIssues,
}
