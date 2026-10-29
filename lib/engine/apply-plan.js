// 阶段 3：原生产物的**落地器**（原子应用 → cw index → 基线 → 自动提交）。
//
// 位置：quality-gate.js 给出采用裁决（report）之后、产物真正进仓库之前。
// 为什么必须单独一层：裁决说「这批页可以入库」，和「入库这件事真的成立了」是两回事——
// 中间还有四步各会失败：写盘（路径越界/权限/磁盘满）、`cw index`（索引建不起来就是
// 坏库）、`cw meta update`（基线推进 = 宣布「这些变化已消化」，写不成就是记账错误）、
// 自动提交（产物没入库，别人拉下来看不到）。0.14.0 的教训正是把「写成几篇」当成
// 「成立」，于是 1 篇成功 + 19 篇失败也报 done。
//
// ── 三条硬不变量（本模块唯一的验收标准） ──────────────────────────────────────
//
//   1. **写集封闭**：只允许写 `.codewiki/` 之下与仓库根 `CodeWiki.md`。渲染结果里的
//      路径由引擎的 page 名映射而来，直接信它等于把「引擎能写仓库任意文件」写进契约。
//      绝对路径、盘符、`..` 上跳、白名单外路径一律整批拒写（不是跳过该条，是整批拒——
//      写集不完整时部分写入等于制造一份没人在意的半成品）。
//   2. **索引/基线失败即回滚**：文章写盘之后 `cw index` 或 `cw meta update` 失败，
//      磁盘必须回到应用前的样子（旧文章内容原样写回、新建的文件删掉、`_index.md` 与
//      `_meta.yaml` 恢复 pre-image）。否则库里留下「文章在、索引没有」或「文章在、
//      基线已推进」的结构，下次编译会在脏库上判「已消化」，而脏库永远不会自愈。
//   3. **提交失败不回滚**：自动提交是「产物入库」的最后一步，它失败时文章本身是好的、
//      有用的（与索引/基线相反——那两步失败说明这批产物还没被库接受）。所以只记
//      `commit-failed` 阻塞并如实返回，绝不因为提交失败把有价值的文章删掉。
//
// 依赖注入而不是 import：本模块**不 import index.js**（那里是插件主入口，加载它会连带
// 拉起宿主服务与 webServer，单测里就成了「为了测一个写盘函数启动整个插件」）。
// `runCw` / `commit` / `normalizeIndexLinks` 全部可由调用方注入：阶段 4 由 index.js 注入
// 自己的 `runCw` 与 `autoCommitWiki`（index.js:4655，分支合并式），测试注入桩。
//
// 但「可注入」不等于「默认什么都不做」：默认必须自带一个**同语义**的提交器
// （`commitWikiArtifacts`），否则阶段 3 自己跑起来产物只落盘不入库，而报告看起来仍是
// done——那正是「自动提交失败被改写成成功」的前身。所以默认走内置提交器，
// 它的安全边界逐条对齐 autoCommitWiki（只 add wiki 两个路径 / 不 amend 不 push /
// 合并冲突与无 HEAD 一律拒绝），差别只在实现大小（直接提交，不建主题分支；
// 分支合并式留给阶段 4 注入的 autoCommitWiki）。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { WIKI_DIR, WIKI_ENTRY, WIKI_META_REL } from './mapping.js'
import { BLOCKER_KINDS } from './contract.js'
import { parseFrontmatter } from '../article-contract.js'

export const APPLY_VERSION = 1

// 写集白名单：`.codewiki/` 整棵子树 + 仓库根入口文件。
export const APPLY_WRITE_ROOTS = Object.freeze([WIKI_DIR, WIKI_ENTRY])

// 落地阶段（面板步骤条与日志按它对齐；顺序即推进顺序）。
export const APPLY_STAGES = Object.freeze(['write', 'index', 'baseline', 'commit'])

// 写集校验的问题类别（机读；新增只允许追加）。
export const APPLY_PROBLEM_KINDS = Object.freeze([
  'empty-target',      // 渲染结果里出现空路径
  'absolute-target',   // 绝对路径 / 盘符
  'escaping-target',   // `..` 上跳
  'out-of-scope',      // 白名单之外
  'duplicate-target',  // 同一路径写两次（内容不一致时必然有一篇要丢）
  'bad-content',       // content 不是字符串
])

// 落地结果的问题类别。前三个直接对应契约的 BLOCKER_KINDS（见下面 toApplyBlockers）。
export const APPLY_RESULT_KINDS = Object.freeze([
  'write-failed',
  'index-failed',
  'baseline-failed',
  'commit-failed',
  'commit-scope',      // 提交成立但混进了 wiki 之外的路径
  'not-writable',      // 裁决本身不允许入库
  'wiki-missing',
  // 裁决自己是 partial（能力降级/存量未重编译等），但 writable=true 所以照样落盘。
  // 落地器不许把这个 partial 洗成 done：gate 说「这批没消化完」，落地只代表「文件到位了」。
  'gate-partial',
])

const toPosix = (p) => String(p ?? '').replace(/\\/g, '/')

/**
 * 写集校验（纯函数，不碰磁盘）。
 *
 * 为什么不「逐条跳过坏路径」：一份残缺的写集落盘之后，调用方拿到的报告会显得
 * 「大部分成功」，而缺的那几篇没人知道缺——这比整批拒写危险得多。
 *
 * @param {Array<{path:string, content?:string}>} items
 * @returns {{ok:boolean, targets:Array<{rel:string, content:string}>, problems:Array}}
 */
export function checkWriteTargets(items) {
  const problems = []
  const targets = []
  const seen = new Map()
  for (const raw of items ?? []) {
    const original = String(raw?.path ?? '')
    const rel = toPosix(original).replace(/^\.\//, '')
    if (!rel) {
      problems.push({ kind: 'empty-target', detail: '写集里有空路径', target: original })
      continue
    }
    if (path.isAbsolute(original) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
      problems.push({ kind: 'absolute-target', detail: `写集不允许绝对路径：${original}`, target: original })
      continue
    }
    const norm = path.posix.normalize(rel)
    if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
      problems.push({ kind: 'escaping-target', detail: `写集不允许上跳：${original}`, target: original })
      continue
    }
    const inScope = APPLY_WRITE_ROOTS.some((root) => norm === root || norm.startsWith(`${root}/`))
    if (!inScope) {
      problems.push({
        kind: 'out-of-scope',
        detail: `写集只允许 ${APPLY_WRITE_ROOTS.join(' 与 ')}，拒绝 ${norm}`,
        target: norm,
      })
      continue
    }
    if (typeof raw?.content !== 'string') {
      problems.push({ kind: 'bad-content', detail: `${norm} 的 content 不是字符串`, target: norm })
      continue
    }
    if (seen.has(norm)) {
      const first = seen.get(norm)
      // 内容相同是重复投递（无害，去重即可）；内容不同才是真问题——保留哪一份都是猜。
      if (first.content !== raw.content) {
        problems.push({ kind: 'duplicate-target', detail: `${norm} 在写集里出现多次且内容不同`, target: norm })
      }
      continue
    }
    seen.set(norm, { rel: norm, content: raw.content })
    targets.push({ rel: norm, content: raw.content })
  }
  return { ok: problems.length === 0, targets, problems }
}

// ── pre-image 快照与回滚 ──────────────────────────────────────────────────
//
// 回滚的对象不只是「本次写的文件」：`cw index` 会重写 `_index.md`、`cw meta update`
// 会重写 `_meta.yaml`，这两份也是要恢复的（它们才是「库是否干净」的判据）。

function capturePre(repoRoot, rels) {
  const snap = []
  for (const rel of rels) {
    const abs = path.join(repoRoot, ...rel.split('/'))
    let exists = false
    let content = null
    try {
      content = fs.readFileSync(abs, 'utf8')
      exists = true
    } catch (err) {
      if (err?.code !== 'ENOENT') exists = false
    }
    snap.push({ rel, abs, exists, content })
  }
  return snap
}

function restorePre(snapshot) {
  const restored = []
  const failed = []
  // 逆序恢复：后写的先撤，语义上更接近「撤销这次事务」
  for (const item of [...snapshot].reverse()) {
    try {
      if (item.exists) {
        fs.mkdirSync(path.dirname(item.abs), { recursive: true })
        fs.writeFileSync(item.abs, item.content, 'utf8')
        restored.push(item.rel)
      } else {
        // pre-image 不存在 = 本次新建的，回滚就该删掉
        try { fs.unlinkSync(item.abs); restored.push(item.rel) } catch (err) {
          if (err?.code !== 'ENOENT') throw err
        }
      }
    } catch (err) {
      failed.push({ rel: item.rel, reason: String(err?.message ?? err).slice(0, 200) })
    }
  }
  return { restored, failed }
}

function writeAll(repoRoot, targets) {
  const written = []
  const unchanged = []
  for (const t of targets) {
    const abs = path.join(repoRoot, ...t.rel.split('/'))
    // 内容与磁盘逐字节相同的项不重写：无变化的一轮不该产生 mtime 抖动，更不该
    // 让「产物无改动」的自动提交因为一次空写而变成一次真实提交。
    try {
      if (fs.readFileSync(abs, 'utf8') === t.content) { unchanged.push(t.rel); continue }
    } catch { /* 不存在或读不了：照写 */ }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, t.content, 'utf8')
    written.push(t.rel)
  }
  return { written, unchanged }
}

// 默认 cw 通道：同步 spawn。阶段 4 注入 index.js 的 runCw（异步）即可，签名一致地返回
// {exitCode, stdout, stderr, timedOut}。
function defaultRunCw(binary, cwd, args, timeoutMs = 120000) {
  const r = spawnSync(binary, args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  })
  return {
    exitCode: r.status ?? -1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? (r.error ? String(r.error.message ?? r.error) : '')),
    timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
  }
}

function defaultVerifyCommit(repoRoot, sha) {
  const r = spawnSync('git', ['show', '--name-only', '--pretty=format:', sha], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  if (r.status !== 0) return { ok: false, files: [], reason: `git show 失败：${String(r.stderr ?? '').trim().slice(0, 200)}` }
  const files = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return { ok: true, files }
}

/**
 * 校验一次提交是否**只**动了 wiki 产物（自动提交的验收判据）。
 *
 * 自动提交的安全边界写在 `git add -- .codewiki CodeWiki.md` 的 pathspec 里，但「命令
 * 带了 pathspec」和「提交里真的只有这两个路径」是两件事（仓库钩子、并发暂存、`.gitignore`
 * 变化都可能让它跑偏）。这里用 `git show --name-only` 反查实际提交内容，把边界变成可断言的事实。
 *
 * @param {string} repoRoot
 * @param {string} sha
 * @param {{allowExtra?:string[], files?:string[]}} [o] files 可直接传入已取到的清单，省一次 git
 * @returns {{ok:boolean, files:string[], unexpected:string[], reason?:string}}
 */
export function verifyCommitScope(repoRoot, sha, { allowExtra = [], files = null } = {}) {
  const got = files ? { ok: true, files } : defaultVerifyCommit(repoRoot, sha)
  if (!got.ok) return { ok: false, files: [], unexpected: [], reason: got.reason }
  const allowed = new Set([...APPLY_WRITE_ROOTS, ...allowExtra.map(toPosix)])
  const unexpected = got.files
    .map(toPosix)
    .filter((f) => ![...allowed].some((root) => f === root || f.startsWith(`${root}/`)))
  return {
    ok: unexpected.length === 0,
    files: got.files,
    unexpected,
    ...(unexpected.length ? { reason: `提交里混进了 wiki 之外的路径：${unexpected.slice(0, 5).join('、')}` } : {}),
  }
}

/**
 * 阶段 3 自带的小提交器：只把 wiki 产物入库。
 *
 * 为什么另写一份而不是 import index.js 的 autoCommitWiki：见文件头（会连锁加载宿主服务）。
 * 安全边界逐条**照抄**，一条都不放宽——这份代码在阶段 4 会被 autoCommitWiki 替换，
 * 两边的判据必须能对齐，否则「阶段 3 能提交、阶段 4 不能」会变成没人能解释的行为差异。
 *
 * @param {string} cwd 仓库根
 * @param {{jobId?:string|null, writtenCount?:number}} [o]
 * @returns {{committed:boolean, sha?:string, message?:string, noChanges?:boolean, reason?:string, files?:string[]}}
 */
export function commitWikiArtifacts(cwd, { jobId = null, writtenCount = 0 } = {}) {
  const opts = { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true }
  const run = (...args) => spawnSync('git', args, opts)
  const out = (r) => String(r?.stdout ?? '').trim()
  // 只对磁盘上存在的路径操作：固定 pathspec 在文件不存在时会让 git add 直接 fatal
  const paths = APPLY_WRITE_ROOTS.filter((p) => fs.existsSync(path.join(cwd, p)))
  if (!paths.length) {
    return { committed: false, noChanges: true, reason: `没有可提交的产物（${APPLY_WRITE_ROOTS.join(' 与 ')} 均不存在）` }
  }
  try {
    const inside = run('rev-parse', '--is-inside-work-tree')
    if (inside.status !== 0 || out(inside) !== 'true') return { committed: false, reason: '不是 git 仓库' }
    if (run('rev-parse', '--verify', '-q', 'HEAD').status !== 0) return { committed: false, reason: '仓库还没有首次提交（无 HEAD）' }
    // merge/rebase/cherry-pick 进行中：此时 commit 会把 wiki 产物夹进别人的合并提交
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (run('rev-parse', '--verify', '-q', marker).status === 0) return { committed: false, reason: `仓库正在合并/变基中（${marker}）` }
    }
    if (out(run('ls-files', '-u', '--', ...paths))) return { committed: false, reason: '目标路径存在未解决冲突' }
    // .codewiki/ 常被 .gitignore 忽略：必须显式认出来，否则会误报「无改动」并静默丢产物
    const ignored = paths.filter((p) => fs.existsSync(path.join(cwd, p))
      && !out(run('ls-files', '--', p))
      && run('check-ignore', '-q', '--', p).status === 0)
    if (ignored.length) return { committed: false, reason: `${ignored.join('、')} 被 .gitignore 忽略，无法自动提交` }
    if (!out(run('status', '--porcelain', '--', ...paths))) {
      return { committed: false, noChanges: true, reason: '产物无未提交改动' }
    }
    if (!out(run('config', 'user.email')) || !out(run('config', 'user.name'))) {
      return { committed: false, reason: '仓库未配置 git user.name/user.email' }
    }
    const tail = [jobId ? `任务 ${jobId}` : '', writtenCount ? `${writtenCount} 篇文章` : ''].filter(Boolean).join('，')
    const message = `docs(wiki): 更新 CodeWiki 编译产物${tail ? `（${tail}）` : ''}`
    // pathspec 形式：改动被限定在 wiki 两个路径内，与 -A/--all 无关
    const add = run('add', '--', ...paths)
    if (add.status !== 0) return { committed: false, reason: `git add 失败：${(add.stderr || add.stdout || '').trim().slice(0, 200)}` }
    if (!out(run('diff', '--cached', '--name-only', '--', ...paths))) {
      return { committed: false, reason: '目标路径被 .gitignore 忽略，无内容可提交' }
    }
    const files = out(run('diff', '--cached', '--name-only', '--', ...paths)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    // --no-verify：不跑仓库钩子——自动提交不该被 husky/lint-staged 卡住或改写
    const commit = run('commit', '--no-verify', '-m', message, '--', ...paths)
    if (commit.status !== 0) return { committed: false, reason: `git commit 失败：${(commit.stderr || commit.stdout || '').trim().slice(0, 200)}` }
    return { committed: true, sha: out(run('rev-parse', '--short', 'HEAD')), message, files }
  } catch (err) {
    return { committed: false, reason: `自动提交异常：${String(err?.message ?? err).slice(0, 200)}` }
  }
}

// 落地问题 → 契约 BLOCKER_KINDS（面板/终态判定共用一套词表）。
const TO_CONTRACT_KIND = {
  'write-failed': 'quality-gate',
  'index-failed': 'index-failed',
  'baseline-failed': 'baseline-failed',
  'commit-failed': 'commit-failed',
  'commit-scope': 'commit-failed',
  'not-writable': 'quality-gate',
  'wiki-missing': 'index-failed',
  'gate-partial': 'quality-gate',
}

export function toApplyBlockers(problems) {
  return (problems ?? []).map((p) => {
    const kind = TO_CONTRACT_KIND[p.kind] ?? 'quality-gate'
    // kind 必须落在契约枚举里：契约测试会枚举全表，写错的 kind 会让面板与终态判定同时失明
    if (!BLOCKER_KINDS.includes(kind)) throw new Error(`apply-plan: 未登记的 blocker kind ${kind}`)
    return {
      kind,
      detail: `[${p.kind}] ${String(p.detail ?? '').slice(0, 2000)}`,
      ...(p.target ? { target: p.target } : {}),
    }
  })
}

/**
 * 找出「已写盘但没进 `_index.md`」的文章。
 *
 * 为什么需要这一步：`cw index` 的退出码只表示「索引文件写成功了」，不表示「文章被收录」。
 * vendor/codewiki/src/main.rs:236-256 的实现是逐篇 `frontmatter::parse`，**解析失败就 continue**
 * （`if let Ok(Some(fm))`），最后照样写索引并返回 0。于是 frontmatter 写坏的文章会静默缺席，
 * 而落地器拿到 exit 0 会判 done——这就是「缺页静默成功」。
 *
 * 比对口径：索引里的链接是「相对 `.codewiki/` 的路径去掉 `.md`」（main.rs 的
 * `strip_prefix(wiki)` + `trim_end_matches(".md")`），与 title 无关，所以按路径比是稳定的。
 * 跳过 `_` 开头的文件：那是 cw 自己排除的（`rel_str.starts_with('_')`），不算缺页。
 *
 * @param {string} repoRoot
 * @param {Array<{rel:string}>} written
 * @returns {string[]} 缺失文章的 rel 列表（按写集顺序）
 */
function findArticlesMissingFromIndex(repoRoot, written) {
  const wikiPrefix = `${WIKI_DIR}/`
  const expected = (written ?? [])
    .map((w) => String(typeof w === 'string' ? w : (w?.rel ?? '')))
    .filter((rel) => rel.startsWith(wikiPrefix))
    .map((rel) => rel.slice(wikiPrefix.length))
    .filter((rel) => rel.endsWith('.md') && !rel.split('/').some((seg) => seg.startsWith('_')))
  if (!expected.length) return []
  const indexAbs = path.join(repoRoot, ...path.posix.join(WIKI_DIR, '_index.md').split('/'))
  let text
  try {
    text = fs.readFileSync(indexAbs, 'utf8')
  } catch {
    // 索引文件读不到 → 全都没收录（cw index 刚跑成功却读不到，本身就是索引失败）
    return expected
  }
  const linked = new Set()
  for (const m of text.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) {
    linked.add(m[1].replace(/\\/g, '/').trim())
  }
  return expected.filter((rel) => !linked.has(rel.slice(0, -'.md'.length)))
}

// 递归列出目录下所有文件（相对**仓库根**的 POSIX 路径）。目录不存在返回 []。
function listFilesUnder(repoRoot, relRoot) {
  const absRoot = path.join(repoRoot, ...toPosix(relRoot).split('/'))
  const out = []
  const walk = (cur, prefix) => {
    let items
    try { items = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const rel = `${prefix}/${it.name}`
      const abs = path.join(cur, it.name)
      if (it.isDirectory()) { walk(abs, rel); continue }
      if (it.isFile()) out.push(rel)
    }
  }
  walk(absRoot, toPosix(relRoot).replace(/\/+$/, ''))
  return out
}

/**
 * 受管状态目录的裁剪清单：这些根下「本次写集里没有」的文件都是过期状态。
 *
 * 为什么必须删而不是「留着不动」：受管状态目录是**下一轮引擎的输入**。上一轮有、
 * 本轮引擎删掉了的文章若留在状态里，下一轮水合会把它原样搬回 docs —— 已删的页复活、
 * 已合并的页重新出现、旧依赖图覆盖新图。增量的正确性依赖「状态目录 == 上一轮引擎的
 * 最终产物」，这份等价关系只能靠裁剪维持。
 *
 * @param {string} repoRoot
 * @param {string[]} pruneRoots 相对仓库根的目录
 * @param {Set<string>} keepRels 本次写集里的仓库相对路径
 * @returns {string[]} 待删除的仓库相对路径（排序）
 */
function collectPruneTargets(repoRoot, pruneRoots, keepRels) {
  const out = []
  for (const relRoot of pruneRoots ?? []) {
    const norm = toPosix(relRoot).replace(/^\.\//, '').replace(/\/+$/, '')
    if (!norm) continue
    // 安全边界：裁剪根必须落在写集白名单内（否则会删用户源码）
    const inScope = APPLY_WRITE_ROOTS.some((r) => norm === r || norm.startsWith(`${r}/`))
    if (!inScope) continue
    for (const rel of listFilesUnder(repoRoot, norm)) {
      if (keepRels.has(rel)) continue
      out.push(rel)
    }
  }
  return [...new Set(out)].sort()
}

// 删掉因裁剪而变空的目录（自底向上）。目录不进 pre-image：回滚时 restorePre 会
// 按文件路径重建父目录，空目录本身没有内容可恢复。
function pruneEmptyDirs(repoRoot, relRoot) {
  const absRoot = path.join(repoRoot, ...toPosix(relRoot).split('/'))
  const dirs = []
  const walk = (cur) => {
    let items
    try { items = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const it of items) if (it.isDirectory()) walk(path.join(cur, it.name))
    dirs.push(cur)
  }
  walk(absRoot)
  for (const d of dirs) {
    if (d === absRoot) continue
    try { fs.rmdirSync(d) } catch { /* 非空或删不掉：留着无害 */ }
  }
}

/**
 * 把 `_index.md` 里 `[[link|title]]` 链接头的 `\` 规范成 `/`。
 *
 * 为什么落地器必须自己带一份：`cw index` 在 Windows 上写出的链接可能是 `[[modules\a|x]]`，
 * 而 stale 判定、链接校验、下一次增量比较用的都是 `/` 形式——同一篇文章两种写法，等于
 * 索引不可信。index.js 里有同语义的 `normalizeIndexLinks`（index.js:213），但本模块
 * 刻意不 import index.js（见文件头），否则单测会被拉去启动宿主服务。
 *
 * 与 index.js 版本的**唯一差别**：那边把读失败一律当「文件不存在」返回 false（探测式用法）；
 * 这里把 ENOENT 当「没有索引可规范化」返回 false，其余读写错误**抛出**——落地器不能
 * 把「索引文件坏到读不出来」当成「不需要规范化」然后判成功。
 *
 * @param {string} repoRoot
 * @returns {boolean} 是否真的改动了文件
 */
function normalizeIndexLinksIn(repoRoot) {
  const abs = path.join(repoRoot, ...path.posix.join(WIKI_DIR, '_index.md').split('/'))
  let text
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
  // 只动链接头（`[[` 到 `|` 之间），不碰标题与正文
  const fixed = text.replace(/\[\[([^\]|\n]*?)\|/g, (m, link) => `[[${link.replace(/\\/g, '/')}|`)
  if (fixed === text) return false
  fs.writeFileSync(abs, fixed, 'utf8')
  return true
}

// 入口正文：剥掉产物可能自带的 frontmatter。CodeWiki.md 是仓库级入口，不参与 cw 索引
// （index 只扫 .codewiki/ 下的 md），带一层 frontmatter 只是噪音；而保留它会让「手写入口」
// 与「产物入口」看起来不是同一类文件。
function entryBody(text) {
  const fm = parseFrontmatter(text)
  return fm.fields ? fm.body : text
}

/**
 * 把一次采用裁决落地：写盘 → cw index → 基线 → 自动提交，失败按不变量回滚。
 *
 * @param {object} o
 * @param {string} o.repoRoot              仓库根（绝对路径）
 * @param {object} o.report                gateNativeOutput 的返回值
 * @param {string} o.docsDir               引擎产出的 docs 目录（读入口页正文用）
 * @param {string} [o.wikiPath]            wiki 目录，默认 <repoRoot>/.codewiki
 * @param {boolean} [o.advanceBaseline]    覆盖 report.canAdvanceBaseline（测试/预览用）
 * @param {'keep'|'overwrite'|'skip'} [o.entryMode='keep'] 仓库根已有入口时的处置
 * @param {boolean} [o.dryRun=false]       只算写集与判定，不写盘、不跑 cw、不提交
 * @param {Array<{rel:string, content:string}>} [o.extraFiles=[]]
 *        附加写集：引擎原始状态（模块树/元数据/依赖图/增量凭据），相对**仓库根**。
 *        它们与文章共用同一份 pre-image、同一次回滚、同一个自动提交——这正是
 *        「原始图/模块树/metadata/update_record 与文章同事务」的实现方式。
 *        内容与磁盘完全相同的项会跳过重写（无变化不产生 mtime 抖动与假提交）。
 * @param {object} [o.deps]                { runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary, gitCommitMessage }
 * @param {string[]} [o.pruneRoots=[]]
 *        受管状态目录（相对**仓库根**）。写盘之后，这些根下「本次写集里没有」的文件会被删除：
 *        上一轮存在、本轮引擎删掉了的文章/图必须跟着消失，否则下一轮水合会把它们原样
 *        搬回 docs（旧页复活、旧图复活 → 增量 diff 读到一个已经不存在的世界）。
 *        删除同样纳入 pre-image（回滚会把它们恢复），因此仍然是一次原子事务。
 * @returns {object} ApplyResult（可 JSON 序列化）
 */
export async function applyNativeOutput({
  repoRoot,
  report,
  docsDir = null,
  wikiPath = null,
  advanceBaseline = null,
  entryMode = 'keep',
  dryRun = false,
  noChanges = false,
  extraFiles = [],
  pruneRoots = [],
  beforeCommit = null,
  deps = {},
} = {}) {
  const startedAt = new Date().toISOString()
  const root = repoRoot ? path.resolve(String(repoRoot)) : null
  const problems = []
  const notes = []
  const pushProblem = (kind, detail, extra = {}) => {
    if (!APPLY_RESULT_KINDS.includes(kind)) throw new Error(`applyNativeOutput: 未登记的问题类别 ${kind}`)
    problems.push({ kind, detail, ...extra })
  }

  const base = {
    version: APPLY_VERSION,
    startedAt,
    repoRoot: root,
    applied: false,
    outcome: 'failed',
    written: [],
    pruned: [],
    entry: null,
    index: null,
    baseline: null,
    commit: null,
    rolledBack: false,
    problems,
    blockers: [],
    notes,
    canAdvanceBaseline: false,
  }
  const done = (patch = {}) => {
    const merged = { ...base, ...patch }
    merged.blockers = toApplyBlockers(problems)
    if (merged.outcome === 'done' && merged.blockers.length) merged.outcome = 'partial'
    merged.ok = merged.outcome === 'done'
    merged.canAdvanceBaseline = merged.applied === true
      && merged.baseline?.advanced === true
      && merged.problems.length === 0
    merged.finishedAt = new Date().toISOString()
    return merged
  }

  if (!root) {
    pushProblem('not-writable', '没有仓库根，无法落地')
    return done({ outcome: 'failed' })
  }
  if (noChanges) {
    if (!dryRun && report?.writable !== true) {
      pushProblem('not-writable', '无变化短路必须基于已通过的完整产物裁决')
      return done({ outcome: 'failed' })
    }
    notes.push('引擎与四路变化集均无变化：跳过写盘、索引、基线和自动提交')
    return done({
      outcome: 'done', applied: true, written: [],
      index: { ok: true, skipped: true, reason: 'no-changes' },
      baseline: { advanced: false, ok: true, reason: 'no-changes' },
      commit: { committed: false, noChanges: true, reason: '无变化轮，无需提交' },
    })
  }
  // 1) 裁决本身不允许入库：一个字都不写。这里不重复 gate 的判定，只认它的结论。
  if (report?.writable !== true) {
    pushProblem('not-writable', `采用裁决为 ${report?.outcome ?? 'unknown'}（writable=false），不落盘`)
    return done({ outcome: 'failed' })
  }
  // 裁决是 partial 但 writable=true：这恰恰是「能写一部分」的合法状态（能力降级、存量
  // 未重编译、部分页 skip 等），照写——但落地器**不许**把这个 partial 洗成 done。
  // 写进去的是「没消化完的那部分里能用的那部分」，终态必须继续报 partial，基线不推进，
  // 否则下一次编译会以为这些变化已经消化过。
  const gateOutcome = report?.outcome ?? 'unknown'
  if (gateOutcome !== 'done') {
    pushProblem('gate-partial', `采用裁决为 ${gateOutcome}（writable=true，照写但不算消化完）`)
  }

  // 2) 收集写集：文章（gate 已保证 rendered 只含无缺陷页）+ 仓库根入口 + 引擎原始状态
  const items = []
  for (const r of report.rendered ?? []) items.push({ path: r.wikiPath, content: r.content })
  // 引擎原始状态（模块树/元数据/依赖图/增量凭据）：与文章同批写、同批回滚、同批提交。
  // 它们不是文章，因此不参与下面的「索引必须收录」校验（那是 .md 的判据）。
  for (const f of extraFiles ?? []) {
    const rel = toPosix(f?.rel ?? '')
    if (!rel || typeof f?.content !== 'string') {
      pushProblem('write-failed', `[bad-extra] 附加写集项缺 rel 或 content：${rel || '(空)'}`)
      continue
    }
    items.push({ path: rel, content: f.content })
  }
  const entrySrc = report.entry?.source ? toPosix(report.entry.source) : null
  let entryTarget = null
  const entryAbs = path.join(root, WIKI_ENTRY)
  const entryExists = fs.existsSync(entryAbs)
  if (entrySrc) {
    if (entryExists && entryMode === 'keep') {
      notes.push('仓库根已有 CodeWiki.md，按 entryMode=keep 保留人工入口，不覆盖')
      entryTarget = { rel: WIKI_ENTRY, action: 'keep' }
    } else if (entryMode === 'skip') {
      notes.push('entryMode=skip：不写仓库根入口')
      entryTarget = { rel: WIKI_ENTRY, action: 'skip' }
    } else {
      let text = null
      try {
        text = fs.readFileSync(path.join(String(docsDir ?? ''), ...entrySrc.split('/')), 'utf8')
      } catch (err) {
        pushProblem('write-failed', `入口页 ${entrySrc} 不可读：${err?.code ?? err?.message ?? err}`)
        return done({ outcome: 'failed' })
      }
      const body = entryBody(text)
      if (!body.trim()) {
        pushProblem('write-failed', `入口页 ${entrySrc} 除 frontmatter 外没有正文`)
        return done({ outcome: 'failed' })
      }
      items.push({ path: WIKI_ENTRY, content: body })
      entryTarget = { rel: WIKI_ENTRY, action: entryExists ? 'overwrite' : 'write' }
    }
  } else {
    pushProblem('not-writable', '产物里没有入口页（overview），拒绝生成只有文章的 wiki')
    return done({ outcome: 'failed' })
  }

  const check = checkWriteTargets(items)
  if (!check.ok) {
    // 写集问题（APPLY_PROBLEM_KINDS）是「落地失败」的子类，不单独进落地结果词表：
    // 统一记 write-failed，并把原子类别保留在 detail 前缀里（机读靠前缀，人读靠 detail）。
    for (const p of check.problems) pushProblem('write-failed', `[${p.kind}] ${p.detail}`, { target: p.target })
    // 写集不完整 → 整批拒写（见文件头不变量 1）
    return done({ outcome: 'failed', entry: entryTarget })
  }
  const targets = check.targets

  if (dryRun) {
    notes.push(`dryRun：将写 ${targets.length} 个文件（${targets.map((t) => t.rel).slice(0, 5).join('、')}${targets.length > 5 ? ' 等' : ''}），未落盘、未跑 cw、未提交`)
    // dryRun 的 outcome 只表示「裁决可采纳」，不代表已交付：applied=false 与 dryRun=true
    // 是调用方必须看的两个字段（别把预览当成完成）。
    return done({ applied: false, outcome: report.outcome === 'done' ? 'done' : 'partial', entry: entryTarget, written: [], dryRun: true })
  }

  const runCw = typeof deps.runCw === 'function' ? deps.runCw : defaultRunCw
  const cwBinary = deps.cwBinary ?? process.env.DSH_CODEWIKI_CW ?? 'cw'
  // 默认走内置提交器（同安全边界），而不是「没有注入就不提交」：不提交还能报 done
  // 就是把「产物没入库」写成成功。
  const doCommit = typeof deps.commit === 'function' ? deps.commit : (o, opts) => commitWikiArtifacts(o, opts)
  const verifyCommit = typeof deps.verifyCommit === 'function' ? deps.verifyCommit : null

  // 3) pre-image：本次写集 + 索引 + 基线 + 受管状态的裁剪对象。索引/基线即使不是本次
  //    要写的，也要能恢复；裁剪（删除过期状态文件）同样必须可回滚——否则「索引失败回滚」
  //    只恢复文章、不恢复被删的状态文件，磁盘就停在半个状态上。
  const keepRels = new Set(targets.map((t) => t.rel))
  const pruneTargets = dryRun ? [] : collectPruneTargets(root, pruneRoots, keepRels)
  const watch = [
    ...targets.map((t) => t.rel),
    ...pruneTargets,
    path.posix.normalize(path.posix.join(WIKI_DIR, '_index.md')),
    WIKI_META_REL,
  ]
  const pre = capturePre(root, [...new Set(watch)])
  const wikiAbs = path.join(root, WIKI_DIR)
  const wikiExisted = fs.existsSync(wikiAbs)
  // 回滚 = 恢复 pre-image；若整个 `.codewiki/` 是本次才出现的，连目录一起删掉
  // （否则回滚后会留下一个 `cw init` 建的空壳目录，看着像「有 wiki 但没有文章」）。
  const rollback = () => {
    const rb = restorePre(pre)
    if (!wikiExisted) {
      try { fs.rmSync(wikiAbs, { recursive: true, force: true }) } catch { /* 删不掉时下面的 failed 会报 */ }
    }
    return rb
  }

  // 3b) wiki 必须已初始化：`cw meta update` 要读 `.codewiki/_meta.yaml`，文件不在就是
  //     exit 1（实测：`Failed to read ...\_meta.yaml`，os error 2）。生产路径在
  //     index.js:4021 遇到 state=missing 时先跑 `cw init`——落地器必须同样如此，
  //     否则「第一次给新仓库编译」必然在最后一步基线失败、整批回滚。
  const metaAbs = path.join(root, ...WIKI_META_REL.split('/'))
  if (!fs.existsSync(metaAbs)) {
    if (wikiExisted) {
      // 有 .codewiki 却没有 _meta.yaml：`cw init` 在这里也会失败（它要 load meta 才能
      // 说「已存在」）。这是人工破坏的半截状态，不猜、不手写配置文件、更不搬目录。
      pushProblem('wiki-missing', '.codewiki/ 存在但缺 _meta.yaml（人工删改过？），拒绝自动初始化；请跑 cw init 或删除该目录后重试')
      return done({ outcome: 'failed', entry: entryTarget })
    }
    let initRes = null
    try { initRes = await runCw(cwBinary, root, ['init'], 120000) } catch (err) {
      initRes = { exitCode: -1, stdout: '', stderr: String(err?.message ?? err) }
    }
    if (Number(initRes?.exitCode) !== 0) {
      const rb = rollback()
      pushProblem('wiki-missing', `cw init exit ${initRes?.exitCode ?? -1}：${String(initRes?.stderr || initRes?.stdout || '').trim().slice(0, 300)}`)
      if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
      return done({ outcome: 'failed', entry: entryTarget })
    }
    notes.push('仓库还没有 wiki，已先 cw init 建出库骨架（之后再 index/基线）')
  }

  // 4) 写盘
  let written
  let unchangedFiles = []
  let pruned = []
  try {
    const w = writeAll(root, targets)
    written = w.written
    unchangedFiles = w.unchanged
    // 4b) 裁剪过期状态：写集已经落盘（新的模块树/图/文章都到位了），此时删掉
    //     「上一轮有、本轮没有」的状态文件才是安全的——顺序反了会让下一轮水合
    //     读到「新图 + 旧文章」这种从未存在过的组合。
    for (const rel of pruneTargets) {
      try {
        fs.unlinkSync(path.join(root, ...rel.split('/')))
        pruned.push(rel)
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err
      }
    }
    for (const relRoot of pruneRoots ?? []) pruneEmptyDirs(root, relRoot)
  } catch (err) {
    const rb = rollback()
    pushProblem('write-failed', `写盘失败：${String(err?.message ?? err).slice(0, 300)}`)
    if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
    return done({ applied: false, outcome: 'failed', written: [], rolledBack: rb.restored.length > 0, entry: entryTarget })
  }
  if (unchangedFiles.length) notes.push(`${unchangedFiles.length} 个文件内容未变，跳过重写`)
  if (pruned.length) notes.push(`裁剪 ${pruned.length} 个过期状态文件（本轮产物里没有它们）`)
  notes.push(`已写 ${written.length} 个文件${unchangedFiles.length ? `（另 ${unchangedFiles.length} 个内容未变）` : ''}`)

  // 5) cw index：索引建不起来 = 库是坏的（文章在、索引没有）。回滚一切。
  let indexRes = null
  try {
    indexRes = await runCw(cwBinary, root, ['index'], 120000)
  } catch (err) {
    indexRes = { exitCode: -1, stdout: '', stderr: String(err?.message ?? err) }
  }
  const indexOk = Number(indexRes?.exitCode) === 0
  if (!indexOk) {
    const rb = rollback()
    pushProblem('index-failed', `cw index exit ${indexRes?.exitCode ?? -1}：${String(indexRes?.stderr || indexRes?.stdout || '').trim().slice(0, 300)}`)
    if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
    notes.push('索引失败，本次写入已回滚（磁盘回到应用前）')
    return done({
      applied: false, outcome: 'failed', written: [], rolledBack: true, entry: entryTarget,
      index: { ok: false, exitCode: indexRes?.exitCode ?? -1, rolledBack: true },
    })
  }
  // 索引链接规范化：cw 在 Windows 分支上可能写出 `\` 分隔的链接，不规范化会让下次
  // stale 判定与链接校验按不同字符串比较同一篇文章。这一步**不是可选美化**：它失败意味着
  // 刚落盘的索引不可信（同一篇文章两种路径写法），按索引失败同等处置——记 index-failed
  // 并整体回滚，绝不「吞掉错误继续往下走」。
  let normalized = false
  try {
    normalized = (typeof deps.normalizeIndexLinks === 'function'
      ? deps.normalizeIndexLinks(root) === true
      : normalizeIndexLinksIn(root)) === true
  } catch (err) {
    const rb = rollback()
    pushProblem('index-failed', `_index.md 链接规范化失败：${String(err?.message ?? err).slice(0, 300)}`)
    if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
    notes.push('索引规范化失败，本次写入已回滚（不做半个索引）')
    return done({
      applied: false, outcome: 'failed', written: [], rolledBack: true, entry: entryTarget,
      index: { ok: false, exitCode: 0, normalized: false, rolledBack: true },
    })
  }
  notes.push(`cw index 成功${normalized ? '（_index.md 链接已规范化）' : ''}`)

  // 5b) 索引必须真的收录本次写的文章。cw index 只在「frontmatter 解析成功」时收录一篇
  //     （vendor/codewiki/src/main.rs:236-256 → frontmatter::parse），解析失败是**静默跳过**、
  //     exitCode 依然 0。实测证据：一篇文章的 title 写成裸值 `title: 核心: 引擎`，serde_yaml
  //     把 `引擎` 当成嵌套映射，`cw index` 打印 "Index updated: 0 articles" 而索引里只剩
  //     "_No articles yet. Wiki needs compilation._"——退出码 0。若不在这里比对，落地结果会
  //     报 done，而库里的文章从未进索引（缺页静默成功，正是本阶段要消灭的那类失败）。
  const missingFromIndex = findArticlesMissingFromIndex(root, written)
  if (missingFromIndex.length) {
    const rb = rollback()
    pushProblem(
      'index-failed',
      `cw index 退出码 0 但索引里缺 ${missingFromIndex.length} 篇（frontmatter 多半没被 serde_yaml 接受）：${missingFromIndex.slice(0, 5).join('、')}`,
    )
    if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
    notes.push('索引缺页，本次写入已回滚（索引与文章不一致的库不允许落地）')
    return done({
      applied: false, outcome: 'failed', written: [], rolledBack: true, entry: entryTarget,
      index: { ok: false, exitCode: 0, normalized, rolledBack: true, missing: missingFromIndex },
    })
  }

  // 6) 基线：只有「所有变化都被消化」才推进。失败 → 连文章一起回滚。
  //    为什么连文章也回滚：索引成功说明库结构没问题，失败的是「记账」。此时把文章留下、
  //    基线不动，库里就会出现「文章比基线新」的状态——下一轮编译会把它当成变化重新消化
  //    一次（重复消费）。整体回滚是唯一干净的选择：要么这批算数，要么一步都没动。
  const shouldAdvance = advanceBaseline === null
    ? report.canAdvanceBaseline === true
    : advanceBaseline === true
  let baselineRes = null
  if (!shouldAdvance) {
    notes.push(`基线未推进（${advanceBaseline === false ? '调用方指定不推进' : '裁决判定未消化完所有变化'}）`)
    baselineRes = { advanced: false, reason: advanceBaseline === false ? 'caller' : 'gate', ok: true }
  } else {
    try {
      baselineRes = await runCw(cwBinary, root, ['meta', 'update'], 120000)
    } catch (err) {
      baselineRes = { exitCode: -1, stdout: '', stderr: String(err?.message ?? err) }
    }
    if (Number(baselineRes?.exitCode) !== 0) {
      const rb = rollback()
      pushProblem('baseline-failed', `cw meta update exit ${baselineRes?.exitCode ?? -1}：${String(baselineRes?.stderr || baselineRes?.stdout || '').trim().slice(0, 300)}`)
      if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
      notes.push('基线推进失败，本次写入已回滚（基线绝不推进到未成立的编译上）')
      return done({
        applied: false, outcome: 'failed', written: [], rolledBack: true, entry: entryTarget,
        index: { ok: true, exitCode: 0 }, baseline: { advanced: false, ok: false, exitCode: baselineRes?.exitCode ?? -1 },
      })
    }
    baselineRes = { advanced: true, ok: true, exitCode: 0, stdout: String(baselineRes?.stdout ?? '').trim().slice(0, 200) }
    notes.push('基线已推进')
  }

  // 7) 自动提交：失败不回滚（不变量 3）。提交成立后反查实际提交内容，把安全边界变成事实。
  //    「未提交」在任何分支下都不许是 done：commit-failed 会进 problems，终态至少 partial。
  let commitRes = null
  try {
    commitRes = await doCommit(root, { jobId: deps.jobId ?? null, writtenCount: written.length })
  } catch (err) {
    commitRes = { committed: false, reason: `提交异常：${String(err?.message ?? err).slice(0, 300)}` }
  }
  if (commitRes?.committed) {
    const sha = commitRes.sha ?? 'HEAD'
    const scope = (verifyCommit ? await verifyCommit(root, sha) : null)
      ?? verifyCommitScope(root, sha, { files: commitRes.files ?? null })
    commitRes = { ...commitRes, scope }
    if (scope?.ok === false && Array.isArray(scope.unexpected) && scope.unexpected.length) {
      // 提交成立但混了别的路径：不回滚（文章与提交都真的存在），如实报出来让人处理
      pushProblem('commit-scope', scope.reason ?? '提交内容超出 wiki 产物范围', { target: scope.unexpected.slice(0, 5).join('、') })
    }
    notes.push(`已自动提交 ${commitRes.sha ?? ''}（${scope?.files?.length ?? 0} 个路径）`)
  } else if (commitRes?.noChanges) {
    // 产物无改动 = 提交这件事没有对象，不是失败；但也不能据此宣称「已入库」，
    // 所以只记 note，终态由其余问题决定。
    notes.push(`产物无未提交改动（${commitRes.reason ?? 'noChanges'}）`)
  } else {
    pushProblem('commit-failed', commitRes?.reason ?? '自动提交未成立')
    notes.push('自动提交未成立，但文章与索引/基线已生效（提交失败不回滚产物）')
  }

  // 终态：提交没成立（且不是无改动可提交）时绝不 done——产物没入库就是没交付。
  const committedOrNothingToDo = commitRes?.committed === true || commitRes?.noChanges === true
  if (!problems.length && !committedOrNothingToDo) {
    // 兜底：即使上面漏了 push，也不许在「未提交」状态下留一个干净的 done
    pushProblem('commit-failed', '产物未入库（提交通道未成立）')
  }
  const outcome = problems.length === 0 ? 'done' : 'partial'
  return done({
    applied: true,
    outcome,
    written,
    unchangedFiles,
    pruned,
    entry: entryTarget,
    index: { ok: true, exitCode: 0, normalized },
    baseline: baselineRes,
    commit: commitRes,
  })
}

export default {
  APPLY_VERSION,
  APPLY_WRITE_ROOTS,
  APPLY_STAGES,
  APPLY_PROBLEM_KINDS,
  APPLY_RESULT_KINDS,
  checkWriteTargets,
  verifyCommitScope,
  commitWikiArtifacts,
  toApplyBlockers,
  applyNativeOutput,
}
