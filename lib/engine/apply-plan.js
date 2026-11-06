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
import { WIKI_DIR, WIKI_ENTRY, WIKI_META_REL, WIKI_MODULES_REL, moduleSlug } from './mapping.js'
import { BLOCKER_KINDS } from './contract.js'
import { parseFrontmatter, inspectArticle, NATIVE_ARTICLE_OPTS } from '../article-contract.js'
import { repairArticle } from '../article-repair.js'
import { decodeGitPaths, withQuotepathOff, toPosix } from '../git-paths.js'

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

/**
 * 写集 / 删除集共用的**同一把尺子**：把一个目标路径判成「规范化相对路径」或一条问题。
 *
 * 为什么收口成一个纯函数：这两处原本各自抄了四段同形 `if`（空 / 绝对路径 / `..` 上跳 /
 * 白名单），差别只在文案里的「写集」「删除集」两个词。同形复制最危险的后果不是重复，
 * 而是**不对称**——某一侧补了一条判据、另一侧没补，于是「写不许越界但删可以越界」
 * 这种缺陷靠肉眼是看不出来的。删错比写错更不可逆，两侧必须共用判据。
 *
 * 注意白名单查的是写集根（`.codewiki/` + 根 `CodeWiki.md`）：删除也受它约束，
 * 不允许删到仓库源码。
 *
 * @param {string} original 原始目标（未归一，报告里回显它，方便定位调用方传了什么）
 * @param {{scopeLabel: string}} options scopeLabel 用于问题文案（「写集」/「删除集」）
 * @returns {{ok: true, norm: string} | {ok: false, problem: object}}
 */
function checkTargetPath(original, { scopeLabel }) {
  const rel = toPosix(original).replace(/^\.\//, '')
  if (!rel) {
    return { ok: false, problem: { kind: 'empty-target', detail: `${scopeLabel}里有空路径`, target: original } }
  }
  if (path.isAbsolute(original) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
    return { ok: false, problem: { kind: 'absolute-target', detail: `${scopeLabel}不允许绝对路径：${original}`, target: original } }
  }
  const norm = path.posix.normalize(rel)
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
    return { ok: false, problem: { kind: 'escaping-target', detail: `${scopeLabel}不允许上跳：${original}`, target: original } }
  }
  const inScope = APPLY_WRITE_ROOTS.some((root) => norm === root || norm.startsWith(`${root}/`))
  if (!inScope) {
    return {
      ok: false,
      problem: {
        kind: 'out-of-scope',
        detail: `${scopeLabel}只允许 ${APPLY_WRITE_ROOTS.join(' 与 ')}，拒绝 ${norm}`,
        target: norm,
      },
    }
  }
  return { ok: true, norm }
}

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
    const verdict = checkTargetPath(original, { scopeLabel: '写集' })
    if (!verdict.ok) {
      problems.push(verdict.problem)
      continue
    }
    const norm = verdict.norm
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
      // 「读不到」必须与「不存在」分开：EBUSY/EPERM 若记成 exists=false，回滚时
      // restorePre 会 unlinkSync 删掉一份真实存在的文件。EISDIR 例外——那是目录，
      // restorePre 对目录的操作会失败并上报，不会静默删数据；抛错反而让整轮在写盘前崩掉。
      if (err?.code !== 'ENOENT' && err?.code !== 'EISDIR') throw err
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

// 内容等价比对：行尾不参与比较。
//
// 历史落地页的 CRLF/LF 是写入时机的产物（git core.autocrlf=true 时读出来就是 CRLF），
// 不是内容偏离。这个口径必须**同时**用在两处：
//   · findStaleLanded —— 判断哪些页真的需要按新渲染规则重写
//   · writeAll        —— 判断某个文件是否内容未变、可以跳过重写
// 早先只在比对侧做了归一，写入侧仍是逐字节比较，于是单篇真 stale 触发规范化时，
// 会把整批仅行尾不同的页一起翻成 LF，制造一批无意义的 diff（实测 written 里
// 混进了一篇只差 CRLF 的页）。
function sameContent(a, b) {
  return String(a).replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n')
}

// 落地页与本次渲染结果的偏离（「待规范化」的页）。
//
// 为什么不并进 noChanges：noChanges 说的是「引擎这一轮没消费到新变化」，不是「库里已有的
// 文章符合当前的渲染规则」。渲染规则（页名别名、跨页链接改写）改进后，同一份源页会渲染出
// 不同的正文——旧规则写下的落地页不重写就永远是错的，死链会一直留在库里。真机
// dsh-hindsight-on-demand 就是这么卡住的：质量门报 done、42 篇全可写，落地器却
// written=0，363 条跨页链接继续指向改名前的旧页名。
function findStaleLanded(repoRoot, rendered) {
  const stale = []
  for (const item of rendered ?? []) {
    const rel = toPosix(item?.wikiPath ?? '')
    if (!rel || typeof item?.content !== 'string') continue
    const abs = path.join(repoRoot, ...rel.split('/'))
    // 读不到就是「没有可比对的落地页」（首次编译），按偏离处理——该写。
    // 真写失败会在 writeAll/checkWriteTargets 显式报错，不在这里预判。
    let disk
    try {
      disk = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      disk = null
    }
    if (disk === null || !sameContent(disk, item.content)) stale.push(rel)
  }
  return stale
}

function writeAll(repoRoot, targets) {
  const written = []
  const unchanged = []
  for (const t of targets) {
    const abs = path.join(repoRoot, ...t.rel.split('/'))
    // 内容与磁盘等价（行尾不计）的项不重写：无变化的一轮不该产生 mtime 抖动，更不该
    // 让「产物无改动」的自动提交因为一次空写而变成一次真实提交。
    let disk
    try {
      disk = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      disk = null
    }
    if (disk !== null && sameContent(disk, t.content)) { unchanged.push(t.rel); continue }
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
  // `-c core.quotepath=false` + 逐项解码：两个都要（见 lib/git-paths.js 的注释）。
  // 少了前者，中文模块名的合法产物会被这里的白名单判成「混进 wiki 之外的路径」，
  // 整轮编译被拉成 partial——真实中文仓库必然踩到，纯 ASCII 的测试数据永远碰不到。
  // `--first-parent`：自动提交走「主题分支提交 → merge 回原分支」，编译期间用户在原分支
  // 有过提交时会合成真 merge commit，而 `git show --name-only` 对 merge commit 默认不输出
  // 与父提交的 diff ——空清单会被当成「没有越界路径」，越界检查被洗白成 ok。实测：
  // merge commit 下不加该参数输出为空，加了才有 `.codewiki/x.md`。
  const r = spawnSync('git', withQuotepathOff(['show', '--name-only', '--pretty=format:', '--first-parent', sha]), {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  if (r.status !== 0) return { ok: false, files: [], reason: `git show 失败：${String(r.stderr ?? '').trim().slice(0, 200)}` }
  const files = decodeGitPaths(String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
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
  // 所有读路径的调用统一关掉 quotepath：中文页名在默认设置下会被输出成八进制转义，
  // 下面按 pathspec 传回的清单就会是「带引号的转义串」（见 lib/git-paths.js）。
  const run = (...args) => spawnSync('git', withQuotepathOff(args), opts)
  const out = (r) => String(r?.stdout ?? '').trim()
  // git 把大量无关警告写进 stderr（CRLF/LF 转换提示），直接截前 200 字会把真正的
  // error 挤到看不见的地方。优先取 error/fatal 行，取不到才退回原文。
  // 由来：真实仓库上 `git add` 因 Windows ACL 拒绝读 CodeWiki.md 而 exit 128，
  // 报错却只显示两条 CRLF 警告，排查被迫绕一圈。
  const errText = (r) => {
    const raw = `${r?.stderr ?? ''}\n${r?.stdout ?? ''}`.trim()
    const errs = raw.split(/\r?\n/).filter((l) => /^(error|fatal):/i.test(l.trim()))
    return (errs.length ? errs.join('\n') : raw).slice(0, 400)
  }
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
    if (add.status !== 0) return { committed: false, reason: `git add 失败：${errText(add)}` }
    if (!out(run('diff', '--cached', '--name-only', '--', ...paths))) {
      return { committed: false, reason: '目标路径被 .gitignore 忽略，无内容可提交' }
    }
    // 清单要能当真实路径用（审计/索引都按它走）：先关掉 quotepath，再兜一层解码
    const files = decodeGitPaths(out(run('diff', '--cached', '--name-only', '--', ...paths)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    // --no-verify：不跑仓库钩子——自动提交不该被 husky/lint-staged 卡住或改写
    const commit = run('commit', '--no-verify', '-m', message, '--', ...paths)
    if (commit.status !== 0) return { committed: false, reason: `git commit 失败：${errText(commit)}` }
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
  // 只取 `[[` 之后到 `|`（或 `]`、行尾）的那一段——即目标路径本身。
  // 不能拿整条链接去正则匹配：cw 写的 title 是原文照搬（main.rs 的 `format!("- [[{}|{}]]")`），
  // 标题里出现 `]`（`数组下标 [i] 详解`）时任何「title 部分不含 ]」的模式都会整条漏掉，
  // 于是一篇合法文章被判缺页 → 整批回滚，且标题不改就每次重试都失败。路径段不含 `]`/`|`，是稳定的。
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('[[')
    if (at < 0) continue
    const rest = line.slice(at + 2)
    const stop = rest.search(/[\]|]/)
    const target = (stop < 0 ? rest : rest.slice(0, stop)).replace(/\\/g, '/').trim()
    if (target) linked.add(target)
  }
  return expected.filter((rel) => !linked.has(rel.slice(0, -'.md'.length)))
}

/**
 * 体检**存量**文章：库里躺着的、不是本轮写出来的坏页。
 *
 * 为什么落地层必须扫存量：`cw index` 会把 `.codewiki/` 下所有非 `_` 开头的 `.md`
 * 收进索引（vendor/codewiki/src/main.rs:236-256 是递归 walk），包括历史遗留的坏页。
 * 落地器已有的那道闸（findArticlesMissingFromIndex）只比对**本轮写集**，历史坏页
 * 从没被重写过就永远照不到——它们照样进索引、照样被人读。Node 通道的 tickIndex
 * 早已有 auditExistingArticles 做这件事（index.js:1600），原生通道缺这一段。
 *
 * 判定口径必须**逐字对齐 quality-gate 的 checkRendered**（quality-gate.js:446-461）：
 *   · requiredSections: []    原生页正文由上游 prompt 决定，不按章节名判；
 *   · allowEmptySourceFiles   whole-repository 模式的空 source_files 是诚实记录；
 *   · fsImpl: null            source 存在性由 output.js 的 source-missing 单独判，
 *                             这里再判一遍会把整库 10+ 篇"引用了已删文件"的页全算
 *                             error，闸门退化成噪声、终态永远 partial、基线永不推进。
 * 只取 error 级：warning（缺非必需章节）不列，否则历史文章把所有编译都拖成 partial。
 *
 * @param {string} repoRoot
 * @param {string[]} [skipRels] 本轮裁决里出现过的页（相对仓库根）：它们刚被 gate 判过，
 *   同一个缺陷在门里已经记过一次账，这里再报一遍只是把同一条翻倍，还会让
 *   「gate 说 defects=0、存量体检说坏」这种自相矛盾同时出现在一个终态里。
 * @returns {Array<{rel:string, detail:string}>}
 */
export function auditExistingArticles(repoRoot, skipRels = []) {
  const skip = new Set((skipRels ?? []).map((r) => toPosix(r)))
  const out = []
  for (const rel of listFilesUnder(repoRoot, WIKI_DIR)) {
    if (!rel.endsWith('.md')) continue
    const inner = rel.slice(WIKI_DIR.length + 1)
    // 与 cw index 的跳过规则逐字一致（main.rs:246 `rel_str.starts_with('_')`）：
    // 判的是相对 `.codewiki/` 的**完整路径前缀**，不是每一段。多跳一层会把
    // `modules/_draft.md` 这类真会被收进索引的页漏掉。
    if (inner.startsWith('_')) continue
    if (skip.has(rel)) continue
    const abs = path.join(repoRoot, ...rel.split('/'))
    let content
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') continue
      throw err
    }
    // 与 quality-gate 判「刚渲染出来的页」用同一套口径：两处各写一遍时已经漂过一次，
    // 会出现「门说 defects=0、存量体检说这篇坏了」同时挂在一个终态里。
    const issues = inspectArticle(content, { ...NATIVE_ARTICLE_OPTS, articlePath: inner })
    const blocking = issues.filter((i) => (i.severity ?? 'error') === 'error')
    if (!blocking.length) continue
    out.push({ rel, detail: blocking.slice(0, 2).map((i) => `[${i.kind}] ${i.detail}`).join('；') })
  }
  return out
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
 * 扫描存量模块页，找出**孤儿页**：`source_files` 非空、且其中每一个在仓库里都已不存在。
 *
 * 为什么必须由落地层来扫（阶段 6.5 的真实现场）：
 *   gate 只体检**本次产物**里的页（quality-gate.js 遍历 mapped.articles），
 *   而删除一个模块时 FSoft 可能回 `full_fallback` + `pages_removed: []`——它不告诉
 *   我们「哪篇该消失」，于是 `.codewiki/modules/` 里那篇 source_files 全部失效的页
 *   就永久留在库里，还挂在 `_index.md` 上。读者点进去看到的是一份描述已删代码的文档，
 *   没有任何一处报错。这类页只能靠「拿存量页的 source_files 去仓库里核对」发现。
 *
 * 判据刻意保守，宁可漏删不可误删：
 *   · `source_files` 为空 = whole-repository 模式没有归属证据（不是孤儿证据），跳过；
 *   · 只要还有**一个**文件存在，就不是孤儿（部分失效由 gate 的 source-missing 报）；
 *   · frontmatter 缺失/坏掉的页不动（那可能是人工写的页，删了就找不回来）。
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {string[]} [o.keepPages]  本轮产物要写的页（相对仓库根）——它们不是孤儿
 * @param {string} [o.modulesDir]   默认 `.codewiki/modules`
 * @returns {Array<{rel:string, sourceFiles:string[], missing:string[]}>}
 */
export function findOrphanPages({ repoRoot, keepPages = [], modulesDir = `${WIKI_DIR}/modules` } = {}) {
  const root = repoRoot ? path.resolve(String(repoRoot)) : null
  if (!root) return []
  const keep = new Set((keepPages ?? []).map((p) => toPosix(p).replace(/^\.\//, '')))
  const out = []
  for (const rel of listFilesUnder(root, modulesDir)) {
    if (!rel.endsWith('.md')) continue
    if (keep.has(rel)) continue
    let text
    try { text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8') } catch { continue }
    const { fields } = parseFrontmatter(text)
    const sources = Array.isArray(fields?.source_files)
      ? fields.source_files.map((s) => toPosix(String(s ?? '')).trim()).filter(Boolean)
      : []
    // 空 source_files 不是「全部失效」，是「没有归属证据」——两者含义相反。
    if (!sources.length) continue
    const missing = sources.filter((s) => !fs.existsSync(path.join(root, ...s.split('/'))))
    if (missing.length !== sources.length) continue
    out.push({ rel, sourceFiles: sources, missing })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 旧页声明的 source_files 里，第一个已被当前树模块认领的那个（归一成 / 分隔）。
 *
 * 判据取「任一命中」而不是「全部」：模块拆分/合并后，旧页往往留着几个新树不收录的
 * 附属文件（NOTICE、LICENSE、live 测试），要求全部覆盖等于要求新树一字不差地重现
 * 旧划分——那不成立，就永远扫不到这类页。
 *
 * 返回文件名而不是布尔值：命中哪一个是「这篇被谁接手了」的证据，报告里要能说出来。
 */
function findCoveredSource(sourceFiles, coveringSet) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) return null
  for (const raw of sourceFiles) {
    const p = String(raw ?? '').split('\\').join('/').replace(/^\.\//, '')
    if (p && coveringSet.has(p)) return p
  }
  return null
}

/**
 * 存量模块页里**不属于当前模块树**的那批原生页（聚类重构后被抛弃的旧模块）。
 *
 * 与 findOrphanPages 的区别：那个按「source_files 全部失效」判，判据只覆盖「代码被删」；
 * 而聚类重构会让模块改名/合并——旧页的 source_files 指向的文件**全都还在**，只是不再
 * 归属任何模块。于是旧实现永远扫不出它们：真机实测 dsh-codewiki 落地 92 页、树里只有
 * 20 个模块，其余 72 页是历次重构的残骸，仍挂在 _index.md 上、且正文链接大量 404
 * （dsh-codewiki 128 条、dsh-git-worktree 129 条、dsh-hindsight-on-demand 508 条）。
 *
 * 判据刻意保守，只认「能证明是引擎产出的页」：
 *   · 有 `fsoft_page`（renderArticle 每篇原生页都会写）→ 直接按原生规则判；
 *   · 页名必须等于某个**不在当前树里**的模块名 slug。反过来说：只要 slug 对得上
 *     当前树任一模块，就不是残留（模块还在、只是这页写坏了 → 归文章契约管）。
 *   · 嵌套目录里的页即便 slug 与 live 模块同名也算残留：原生页永远是 flat。
 *
 * 判据刻意只有这一条。每多一条可证特征，就多一类旧页能绕过它 —— 真机上先后漏过
 * 三批：描述性 title（`apply_plan（阶段 3 落地器）`）、平铺在 modules/ 根下
 * （Wxxy-CampusHub 11 篇）、source_files 部分幸存（只有全部失效才算孤儿）。
 * 现在不再逐条证明「它像旧页」，而是反过来：不是本轮写的就删。
 * `modules/` 是引擎的专属产物目录，不承载人工内容。
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {object} o.moduleTree  当前 module_tree.json（空对象=整仓模式，不适用，返回 []）
 * @param {string[]} [o.keepPages] 本轮写集里的页（写优先，不当删除目标）
 * @param {string} [o.modulesDir]
 * @returns {Array<{rel:string, moduleName:string}>}
 */
export function findStaleModulePages({
  repoRoot,
  moduleTree = {},
  keepPages = [],
  modulesDir = WIKI_MODULES_REL,
} = {}) {
  const root = repoRoot ? path.resolve(String(repoRoot)) : null
  if (!root) return []
  const tree = moduleTree && typeof moduleTree === 'object' ? moduleTree : {}
  // 整仓模式（module_tree={}）没有权威模块名，判不出对错——凭名字删页会删掉全部正文。
  if (Object.keys(tree).length === 0) return []
  const liveSlugs = new Set()
  // 当前树里所有模块认领的源文件（归一成 / 分隔）。旧页判别式的第三条要用它：
  // 「这篇旧页描述的源码已经被别的模块接手」是它该退场的直接证据。
  const coveringSet = new Set()
  const normalizeSource = (s) => String(s ?? '').split('\\').join('/').replace(/^\.\//, '')
  const walk = (nodes) => {
    for (const [name, node] of Object.entries(nodes ?? {})) {
      liveSlugs.add(moduleSlug(name))
      for (const c of node?.components ?? []) {
        // 组件形如 `相对路径::符号`，取 `::` 前的路径部分。
        const p = normalizeSource(String(c).split('::')[0])
        if (p) coveringSet.add(p)
      }
      walk(node?.children)
    }
  }
  walk(tree)
  const keep = new Set((keepPages ?? []).map((p) => toPosix(p).replace(/^\.\//, '')))
  const out = []
  for (const rel of listFilesUnder(root, modulesDir)) {
    if (!rel.endsWith('.md')) continue
    if (keep.has(rel)) continue
    let text
    try { text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8') } catch { continue }
    const { fields } = parseFrontmatter(text)
    const slug = path.posix.basename(toPosix(rel), '.md')
    // 原生页永远是 flat（modules/<slug>.md），落在子目录里只可能来自旧通道。
    // 嵌套页不能靠 slug 与 live 模块同名而豁免：旧树按子模块命名目录，重构后
    // 那篇页的 basename 很可能与新模块的 slug 撞上（真机上就这么漏掉过一篇）。
    const relPosix = toPosix(rel)
    const modsBase = toPosix(modulesDir).replace(/\/+$/, '')
    const nested = relPosix.slice(modsBase.length + 1).includes('/')
    // 页名对得上当前树任一模块 → 不是残留（模块还在，只是这页可能写坏了，归文章契约管）。
    if (!nested && liveSlugs.has(slug)) continue
    // 剩下的一律是旧产物。`modules/` 是引擎的专属产物目录，不承载人工维护内容：
    // 库里的模块页只要页名对不上当前树，就是上一版聚类或上一代通道的残骸，全部进删除集。
    //
    // 「不兼容旧产物」是有意的：判据每多一条可证特征，就多一类旧页能绕过它。真机上
    // 先后漏掉过三批 —— 描述性 title（`apply_plan（阶段 3 落地器）`）、平铺在 modules/
    // 根下（Wxxy-CampusHub 11 篇）、source_files 部分幸存（只有全部失效才算孤儿）。
    // 现在不再逐条证明「它像旧页」，而是反过来：不是本轮写的就删。
    // 人工补过的内容这里一律不留。
    out.push({ rel, moduleName: slug, legacy: true })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 源码已被当前模块树接手、页名却对不上任何模块的旧页（进删除集）。
 *
 * 判据：页名不在当前树里 + 没有 `fsoft_page` + 至少一个 source_file 已被当前树的
 * 某个模块认领。命中它说明「这篇页描述的代码已经归别人了」——模块拆分/合并之后，
 * 旧页描述的那部分代码必然出现在新模块里，只是文件清单不会一字不差重现旧划分
 * （所以判据取「任一命中」，见 findCoveredSource）。
 *
 * 这是三类旧页里最宽的一条判据，也是唯一能覆盖「title 是描述性名字、还平铺在
 * modules/ 根下」那批页的：真机 Wxxy-CampusHub 的 11 篇旧页（`CAS 协议核心（campus-auth）`、
 * `接线层（campus-hub src-tauri）`…）三条窄判据全不中，而它们确实已被新树接手。
 *
 * 自动删除是用户明确要求的（「不要让我手动删除」）。这意味着这些页里人工补过的内容
 * （迁移警告、行号更正、`[[decisions/...]]` 交叉链接）只剩 git 历史一份——删之前
 * 每个被删页都在 notes 里点名，并带上接手它的源码路径，事后可以按路径从历史里捞。
 * concepts 与已下线的手工页目录不在扫描范围（只看 modulesDir）。
 *
 * @param {object} o
 * @param {string} o.repoRoot
 * @param {object} o.moduleTree  当前 module_tree.json（空对象=整仓模式，返回 []）
 * @param {string[]} [o.keepPages]
 * @param {string} [o.modulesDir]
 * @returns {Array<{rel:string, moduleName:string, coveredSource:string}>}
 */
export function findSupersededLegacyPages({
  repoRoot,
  moduleTree = {},
  keepPages = [],
  modulesDir = WIKI_MODULES_REL,
} = {}) {
  const root = repoRoot ? path.resolve(String(repoRoot)) : null
  if (!root) return []
  const tree = moduleTree && typeof moduleTree === 'object' ? moduleTree : {}
  if (Object.keys(tree).length === 0) return []
  const coveringSet = new Set()
  const norm = (s) => String(s ?? '').split('\\').join('/').replace(/^\.\//, '')
  const walk = (nodes) => {
    for (const node of Object.values(nodes ?? {})) {
      for (const c of node?.components ?? []) {
        const p = norm(String(c).split('::')[0])
        if (p) coveringSet.add(p)
      }
      walk(node?.children)
    }
  }
  walk(tree)
  const liveSlugs = new Set()
  const walkNames = (nodes) => {
    for (const [name, node] of Object.entries(nodes ?? {})) {
      liveSlugs.add(moduleSlug(name))
      walkNames(node?.children)
    }
  }
  walkNames(tree)
  const keep = new Set((keepPages ?? []).map((p) => toPosix(p).replace(/^\.\//, '')))
  const out = []
  for (const rel of listFilesUnder(root, modulesDir)) {
    if (!rel.endsWith('.md') || keep.has(rel)) continue
    const slug = path.posix.basename(toPosix(rel), '.md')
    if (liveSlugs.has(slug)) continue
    let text
    try { text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8') } catch { continue }
    const { fields } = parseFrontmatter(text)
    if (fields?.fsoft_page) continue
    if (String(fields?.type ?? '') !== 'module') continue
    const covered = findCoveredSource(fields?.source_files, coveringSet)
    if (!covered) continue
    out.push({ rel, moduleName: slug, coveredSource: covered })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 删除目标的白名单校验（与写集同一把尺子：只许 `.codewiki/` 与根 `CodeWiki.md`）。
 *
 * 删除比写入更危险——写错只是内容不对，删错是源码没了。所以这里单独做一遍，
 * 不复用 checkWriteTargets（那个要求 content 是字符串，语义是「写」），
 * 但路径判据与它共用 `checkTargetPath`，两侧不允许各自走样。
 */
export function checkDeleteTargets(rels, { repoRoot = null } = {}) {
  const problems = []
  const targets = []
  const seen = new Set()
  for (const raw of rels ?? []) {
    const original = String(raw ?? '')
    const verdict = checkTargetPath(original, { scopeLabel: '删除集' })
    if (!verdict.ok) {
      problems.push(verdict.problem)
      continue
    }
    const norm = verdict.norm
    // 目录本身不许当删除目标：unlink 会抛 EPERM/EISDIR，而「删一个目录」的语义
    // （连里面所有文件一起）必须由调用方显式列出文件，否则回滚粒度就丢了。
    if (repoRoot) {
      const abs = path.join(path.resolve(String(repoRoot)), ...norm.split('/'))
      try {
        if (fs.statSync(abs).isDirectory()) {
          problems.push({ kind: 'out-of-scope', detail: `删除目标是目录，请列出其中的文件：${norm}`, target: norm })
          continue
        }
      } catch {
        // 目标本来就不存在：幂等删，不报错也不进 targets
        continue
      }
    }
    if (seen.has(norm)) continue
    seen.add(norm)
    targets.push(norm)
  }
  return { ok: problems.length === 0, targets, problems }
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
function collectPruneTargets(repoRoot, pruneRoots, keepRels, problems = null) {
  const out = []
  for (const relRoot of pruneRoots ?? []) {
    // 判据必须与写集/删除集同源（checkTargetPath 的 normalize + 上跳判定）。
    // 曾经这里只做字符串前缀比：`.codewiki/../src` 的前缀是 `.codewiki/`，
    // 白名单放行，path.join 之后解析成 <repo>/src，于是整棵源码目录被当成
    // 「本轮没写到的多余状态文件」删掉。删除通道绕过了写集边界，是最贵的一种走样。
    const verdict = checkTargetPath(relRoot, { scopeLabel: '裁剪根' })
    if (!verdict.ok) {
      // 拒绝必须可见：调用方给了一个非法裁剪根，说明它对世界的认知已经错了。
      // 静默 continue 会让「本来该裁剪的目录没裁」与「裁了但没报」长得一样。
      if (problems) problems.push(verdict.problem)
      continue
    }
    const norm = verdict.norm.replace(/\/+$/, '')
    if (!norm) {
      if (problems) problems.push({ kind: 'empty-target', detail: '裁剪根规范化后是空路径', target: relRoot })
      continue
    }
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
 * 废弃目录里的页：`concepts/` 整体下线。
 *
 * 原生通道只产 `modules/` 与根 `CodeWiki.md`，从不写 `concepts/`。该目录里的页全部是
 * Node 通道遗留（横切层：从模块页全文再蒸馏一遍「概念」），内容与模块页大面积重复，
 * 而且它们的 source_files 指的还是已删掉的 lib 模块，正文描述的规划层早已不存在。
 * 用户明确要求不兼容旧产物，所以整目录清理，不做逐页判断。
 *
 * `learnings/` 与 `decisions/` 不在自动清理范围内（删别人的手写内容是数据损失，需人工决定）。
 *
 * @param {string} repoRoot
 * @param {string[]} [keepPages] 本轮写集里的页（写优先）
 * @returns {Array<{rel:string, moduleName:string, legacy:true}>}
 */
export function findDeprecatedConceptPages(repoRoot, keepPages = []) {
  const root = repoRoot ? path.resolve(String(repoRoot)) : null
  if (!root) return []
  const keep = new Set((keepPages ?? []).map((p) => toPosix(p).replace(/^\.\//, '')))
  const out = []
  for (const rel of listFilesUnder(root, `${WIKI_DIR}/concepts`)) {
    if (!rel.endsWith('.md')) continue
    if (keep.has(rel)) continue
    out.push({ rel, moduleName: path.posix.basename(toPosix(rel), '.md'), legacy: true })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 存量坏页的第三方处置：能修的修，修不动的删。
 *
 * 为什么不再是「只记账」：`existing-bad-article` 原本只进 problems，代价是**基线永久
 * 不推进**——下一轮 change-set 从同一个旧基线算起，同一批文件被反复判成未消化。真机
 * 五个仓库里六个都卡在这个状态，其中最长的落后 71 个提交。而这些页绝大多数只是格式
 * 坏了：缺 frontmatter、frontmatter 少一个 `---`、type 写错目录、正文前粘了一句模型
 * 前言。用格式问题否掉整条增量链显然不划算。
 *
 * 处置顺序必须是「先修再删」：修复器（lib/article-repair.js）保证改写后可过同一套契约，
 * 只有它明确判 drop（正文本身是模型输出泄漏）时才真删。删掉的内容仍在 git 历史里。
 *
 * @param {string} repoRoot
 * @param {string[]} skipRels 本轮裁决里出现过的页（刚被 gate 判过，不重复处置）
 * @returns {{repairs:Array<{rel:string,text:string,reasons:string[]}>, drops:Array<{rel:string,detail:string}>}}
 */
export function healExistingArticles(repoRoot, skipRels = []) {
  const repairs = []
  const drops = []
  for (const bad of auditExistingArticles(repoRoot, skipRels)) {
    const abs = path.join(repoRoot, ...bad.rel.split('/'))
    let text
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') continue
      throw err
    }
    // 修复器吃**相对 wiki 根**的路径（`modules/foo.md`）：它要靠首段目录推 type。
    const inner = toPosix(bad.rel).slice(WIKI_DIR.length + 1)
    const verdict = repairArticle(text, inner)
    if (verdict.action === 'repair') repairs.push({ rel: bad.rel, text: verdict.text, reasons: verdict.reasons })
    else if (verdict.action === 'drop') drops.push({ rel: bad.rel, detail: verdict.reasons.join('；') || bad.detail })
  }
  return { repairs, drops }
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
  deleteFiles = [],
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
    deleted: [],
    entry: null,
    index: null,
    baseline: null,
    commit: null,
    rolledBack: false,
    problems,
    blockers: [],
    notes,
    // 基线有没有**真的**推进（cw meta update 成功）：这是落地事实，不是许可。
    baselineAdvanced: false,
    // 兼容字段：老调用方只看这一个名字。
    canAdvanceBaseline: false,
  }
  const done = (patch = {}) => {
    const merged = { ...base, ...patch }
    merged.blockers = toApplyBlockers(problems)
    if (merged.outcome === 'done' && merged.blockers.length) merged.outcome = 'partial'
    merged.ok = merged.outcome === 'done'
    merged.baselineAdvanced = merged.baseline?.advanced === true
    merged.canAdvanceBaseline = merged.applied === true && merged.baselineAdvanced
    merged.finishedAt = new Date().toISOString()
    return merged
  }

  if (!root) {
    pushProblem('not-writable', '没有仓库根，无法落地')
    return done({ outcome: 'failed' })
  }
  // 无变化短路：引擎与四路变化集都没变化时，不写文章、不写状态、不推进基线。
  // 但「有残留页待删」必须例外——源码没有变化不等于库里没有残骸，而残骸只有落地器
  // 能删（要能回滚、要与索引同事务、要进同一个 commit）。真机五仓验证里四个仓库
  // 全是 no_change 轮，残留页一个都没清掉，正是因为这里无条件短路。
  // 例外分支只允许删除：不写任何文章、不写受管状态、不推进基线。
  // 第二类例外：待规范化的落地页。引擎报 no_change 只说明源码自基线以来没变，不说明
  // 库里的文章符合当前渲染规则；渲染规则改进后（页名别名、跨页链接改写），旧落地页不重写
  // 就永远错下去，而死链只存在于库里、不在源页里，下一轮 no_change 又会短路回去。
  // 这一类同样只能写文章，不推进基线：引擎确实没消化任何新变化。
  const staleLanded = noChanges ? findStaleLanded(root, report?.rendered ?? []) : []
  // 存量体检放在轮次判定之前：判 drop 的页要进删除集，而删除集决定轮次
  // （idle → delete-only）。放在轮次之后的话，库里只剩泄漏页的仓库会永远停在 idle，
  // 每次都只记一笔阻塞、一页都不删。真机 Wxxy-CampusLogin 就是这样：58 篇修好了，
  // 3 篇泄漏页留着，基线一直推不动。
  // 本轮要删的页不参与修复：给 orphan 页补 frontmatter 只会让它重新成为合法页、
  // 从删除集里被摘出去（写集优先），残骸就永远清不掉。
  const healKnown = (report?.rendered ?? []).map((r) => toPosix(r?.wikiPath ?? '')).filter(Boolean)
  const healSkip = [
    ...healKnown,
    ...deleteFiles.map((f) => toPosix(String(f ?? ''))).filter(Boolean),
  ]
  const heal = healExistingArticles(root, healSkip)
  const dropRels = heal.drops.map((d) => toPosix(d.rel)).filter(Boolean)
  if (dropRels.length) {
    deleteFiles = [...deleteFiles, ...dropRels]
    notes.push(
      `存量体检：${dropRels.length} 篇正文是模型输出泄漏（改写没有意义），连同残骸一并删除，原文见 git 历史：${dropRels
        .slice(0, 5)
        .join('、')}${dropRels.length > 5 ? ' 等' : ''}`,
    )
  }
  // 本轮生命周期状态，四个互斥取值。早先这里是三个布尔（noChanges / deleteOnly /
  // normalizeOnly）散在五处组合判断，每加一种例外都得改五处，且组合本身存在非法态
  // （两者同真时行为取决于书写顺序）。收成枚举后，每个分支只读一次这个值。
  //   normal      — 有变化，照常写文章、推进基线
  //   normalize   — 无变化，但有落地页与当前渲染规则不一致：重写文章，不推进基线
  //   delete-only — 无变化，只剩残留页要清：一件都不写，只删 + 索引，不推进基线
  //   idle        — 无变化也无事可做：整轮短路
  const roundKind = !noChanges
    ? 'normal'
    : staleLanded.length > 0
      ? 'normalize'
      : (Array.isArray(deleteFiles) && deleteFiles.length > 0) ? 'delete-only' : 'idle'
  if (roundKind === 'idle') {
    if (!dryRun && report?.writable !== true) {
      pushProblem('not-writable', '无变化短路必须基于已通过的完整产物裁决')
      return done({ outcome: 'failed' })
    }
    notes.push('引擎与四路变化集均无变化：跳过写盘、索引、基线和自动提交')
    // 无变化 ≠ 库是干净的。Node 通道在 tickIndex 开头无条件跑同一体检，这里若随
    // 短路一起跳过，库里躺着的坏文章永远不会被发现，终态还报 done —— 假绿。
    // 体检结论已在上面算过：判 drop 的那批已进删除集（roundKind 因此变成 delete-only，
    // 走不到这里），剩下能走 idle 的只有「全是可修页」或「库里干净」两种。
    // 格式坏了但内容还在的那批不在这里修：修完必须重跑 cw index，而 idle 轮刻意不碰索引
    // （每次状态查询都跑一次 cw index 会制造无意义的 wiki 提交）。留给下一轮写盘时并进去。
    if (heal.repairs.length) notes.push(`另有 ${heal.repairs.length} 篇只是格式坏了，等下一轮写盘时一并修好：${heal.repairs.slice(0, 5).map((r) => r.rel).join('、')}${heal.repairs.length > 5 ? ' 等' : ''}`)
    return done({
      // idle 轮同样受 dryRun 约束：预览不落盘，「无需动作」不等于「已交付」。
      // 曾经这里无条件 applied:true，于是 `{noChanges:true, dryRun:true}` 的预览
      // 返回了「已应用」，与同一个函数里 dryRun 分支的契约（applied 恒 false）相反。
      outcome: 'done', applied: !dryRun, written: [],
      index: { ok: true, skipped: true, reason: 'no-changes' },
      baseline: { advanced: false, ok: true, reason: 'no-changes' },
      commit: { committed: false, noChanges: true, reason: '无变化轮，无需提交' },
    })
  }
  if (roundKind === 'delete-only') {
    notes.push(`无变化轮，但有 ${deleteFiles.length} 个残留页待清理：只执行删除与索引，不写文章、不推进基线`)
  }
  if (roundKind === 'normalize') {
    notes.push(`无变化轮，但有 ${staleLanded.length} 个落地页与当前渲染规则不一致：重写这些页并与索引同事务提交，不推进基线`)
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

  // 2) 收集写集：文章 + 仓库根入口 + 引擎原始状态
  // delete-only 例外分支一件都不写：这一轮的全部意义是删掉残骸。
  // 文章按轮次取法不同：
  //   · 正常轮只写 defects === 0 的页 —— 有缺陷的页由门如实上报，不许把坏内容落进库里；
  //   · 规范化轮全写 —— 这一轮的职责是让库与当前渲染规则对齐，坏页同样是旧规则的产物，
  //     留在库里只会继续错下去（缺陷本身仍由 gate 报，不会因为写盘而消失）。
  const items = []
  // 存量体检里修好的那批：已并进 items，这里只留账（notes 要报修了哪几篇）。
  const repaired = []
  let entryTarget = null
  let targets = []
  if (roundKind !== 'delete-only') {
    for (const r of report.rendered ?? []) {
      // rendered 项由 quality-gate 生成，defects 是它的必填字段。
      if (roundKind !== 'normalize' && Number(r.defects) > 0) continue
      items.push({ path: r.wikiPath, content: r.content })
    }
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

    // 存量坏页里「格式坏了但内容还在」的那批，与文章同批写入：它们必须进同一次
    // `cw index`，否则修好的正文会以「索引里没有它」的形态留在库中。判 drop 的那批
    // 已在轮次判定前并进 deleteFiles，这里不再处理。
    for (const r of heal.repairs) {
      items.push({ path: r.rel, content: r.text })
      repaired.push({ rel: r.rel, reasons: r.reasons })
    }

    const check = checkWriteTargets(items)
    if (!check.ok) {
      // 写集问题（APPLY_PROBLEM_KINDS）是「落地失败」的子类，不单独进落地结果词表：
      // 统一记 write-failed，并把原子类别保留在 detail 前缀里（机读靠前缀，人读靠 detail）。
      for (const p of check.problems) pushProblem('write-failed', `[${p.kind}] ${p.detail}`, { target: p.target })
      // 写集不完整 → 整批拒写（见文件头不变量 1）
      return done({ outcome: 'failed', entry: entryTarget })
    }
    targets = check.targets
  }

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
  const pruneProblems = []
  const pruneTargets = dryRun ? [] : collectPruneTargets(root, pruneRoots, keepRels, pruneProblems)
  for (const p of pruneProblems) {
    // 裁剪根非法是调用方的认知错误：拒绝必须进终态，不能只让「该删的没删」安静发生。
    pushProblem('write-failed', `[prune-${p.kind}] ${p.detail}`, { target: p.target })
  }
  // 显式删除（孤儿页）：与裁剪用同一套 pre-image 与回滚语义。裁剪是「状态目录里本轮
  // 没产出的」，删除是「wiki 正文里证据已失效的存量页」——两者都会被索引/基线失败
  // 回滚恢复，否则一次失败的落地会把页删掉、索引仍指着它。
  // 本轮写集里的页不许同时进删除集：那等于自相矛盾（写一遍再删掉），直接拒。
  const deleteCheck = checkDeleteTargets(dryRun ? [] : deleteFiles, { repoRoot: root })
  if (!deleteCheck.ok) {
    for (const p of deleteCheck.problems) pushProblem('write-failed', `[${p.kind}] ${p.detail}`, { target: p.target })
    return done({ outcome: 'failed', entry: entryTarget })
  }
  const deleteTargets = deleteCheck.targets.filter((rel) => !keepRels.has(rel))
  if (deleteCheck.targets.length !== deleteTargets.length) {
    notes.push(`删除集里有 ${deleteCheck.targets.length - deleteTargets.length} 个路径同时在本轮写集里，已忽略（写优先）`)
  }
  const watch = [
    ...targets.map((t) => t.rel),
    ...pruneTargets,
    ...deleteTargets,
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
  const deleted = []
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
    // 4c) 删孤儿页：与裁剪同批（写盘之后），同属一个事务。
    for (const rel of deleteTargets) {
      try {
        fs.unlinkSync(path.join(root, ...rel.split('/')))
        deleted.push(rel)
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err
      }
    }
    for (const relRoot of pruneRoots ?? []) pruneEmptyDirs(root, relRoot)
    // 删空的模块目录也要收掉，否则库里留一串空目录（wiki 看起来像有页但打开是空的）。
    for (const rel of deleted) {
      const dir = path.posix.dirname(rel)
      if (dir && dir !== '.') pruneEmptyDirs(root, dir)
    }
  } catch (err) {
    const rb = rollback()
    pushProblem('write-failed', `写盘失败：${String(err?.message ?? err).slice(0, 300)}`)
    if (rb.failed.length) notes.push(`回滚时有 ${rb.failed.length} 个文件恢复失败：${rb.failed.map((f) => f.rel).join('、')}`)
    return done({ applied: false, outcome: 'failed', written: [], rolledBack: rb.restored.length > 0, entry: entryTarget })
  }
  if (unchangedFiles.length) notes.push(`${unchangedFiles.length} 个文件内容未变，跳过重写`)
  if (pruned.length) notes.push(`裁剪 ${pruned.length} 个过期状态文件（本轮产物里没有它们）`)
  if (deleted.length) notes.push(`删除 ${deleted.length} 个孤儿页（source_files 全部已失效）：${deleted.slice(0, 5).join('、')}${deleted.length > 5 ? ' 等' : ''}`)
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
  //     比对的基准是**本轮写集**（targets），不是**实际落盘的**（written）：writeAll 会把
  //     与磁盘仅行尾不同或完全相同的项归入 unchanged 而不重写，若拿 written 比，这些页
  //     恰好逃过校验——而「此前 frontmatter 已坏、所以在索引里缺席」正是它们最常见的状态，
  //     于是缺页换个入口复现：本轮该被校验的页没被校验，落地器照报 done。
  const missingFromIndex = findArticlesMissingFromIndex(root, targets)
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

  // 5c) 存量体检的结论**已经在轮次判定时算过**（healExistingArticles 只跑一次：
  //     两次读盘判同一批文件既慢又可能读到不同快照）。这里只落修好那批的账：
  //     它们已并进 items 走正常写盘路径；判 drop 的那批已进删除集，不占基线也不阻塞终态。
  if (repaired.length) {
    notes.push(
      `存量体检：修好 ${repaired.length} 篇格式坏掉的文章（缺 frontmatter / 未闭合 / type 不符）：${repaired
        .slice(0, 5)
        .map((r) => r.rel)
        .join('、')}${repaired.length > 5 ? ' 等' : ''}`,
    )
  }

  // 6) 基线：只有「所有变化都被消化」才推进。失败 → 连文章一起回滚。
  //    为什么连文章也回滚：索引成功说明库结构没问题，失败的是「记账」。此时把文章留下、
  //    基线不动，库里就会出现「文章比基线新」的状态——下一轮编译会把它当成变化重新消化
  //    一次（重复消费）。整体回滚是唯一干净的选择：要么这批算数，要么一步都没动。
  // delete-only / normalize 两轮都不推进基线：删残骸与重写旧规则留下的落地页都不涉及
  // 任何源码变化的消费，推进基线等于凭空记一笔「这些变化已消化」。
  // 存量坏页不再是额外否决项：能修的已并进写集、修不动的（泄漏页）已进删除集，
  // 轮次结束后库里不再有它们，没有理由再拿它们压住基线。
  const shouldAdvance = roundKind === 'normal'
    ? (advanceBaseline === null
      ? report.canAdvanceBaseline === true
      : advanceBaseline === true)
    : false
  let baselineRes = null
  if (!shouldAdvance) {
    const why = roundKind === 'delete-only'
      ? '无变化轮只删残骸'
      : (roundKind === 'normalize'
        ? '无变化轮只重写待规范化的落地页'
        : (advanceBaseline === false ? '调用方指定不推进' : '裁决判定未消化完所有变化'))
    notes.push(`基线未推进（${why}）`)
    baselineRes = {
      advanced: false,
      reason: roundKind === 'normal' ? (advanceBaseline === false ? 'caller' : 'gate') : 'no-changes',
      ok: true,
    }
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
    deleted,
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
