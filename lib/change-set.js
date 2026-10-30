// 变更采集：一次编译要「看见」的全部改动，四路合一。
//
// 背景缺陷（审计确认）：cw status 只跑 `git diff <last_compiled_commit>..HEAD`，
// 于是三类改动对它完全隐形——
//   1. 改完代码**还没提交**（工作区修改）；
//   2. 只 `git add` 到暂存区没提交；
//   3. 新建文件还没被跟踪。
// 结果：「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节
// 却一路绿到底。这是本次融合要修的第一条——变更不能丢。
//
// 本模块的职责只有一件事：把 committed / staged / unstaged / untracked 四路改动
// 收成一个规范化、可序列化的 ChangeSet，并把「采不全」的情形明确暴露出来
// （state + fallback='full'），让调用方退回全量编译——绝不假装 clean。
//
// 依赖注入 execFile 是为了离线单测：真实链路用 execFileSync，测试给假执行器。

import { execFileSync } from 'node:child_process'
import { decodeGitPath, decodeGitPaths } from './git-paths.js'

export const CHANGE_SET_VERSION = 1

// wiki 自身产物目录：每次编译都会被重写，把它算成「源码变更」会让增量永远处于
// dirty 状态，还会让「未映射变更」永远无法清零。README/CHANGELOG/CodeWiki.md 这类
// 被文章 source_files 引用的文档仍是合法源码，不在此列。
const WIKI_PRODUCT_PREFIX = '.codewiki/'

export function isWikiProduct(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/')
  return p === '.codewiki' || p.startsWith(WIKI_PRODUCT_PREFIX)
}

// 路径归一：git 在 Windows 上也可能吐反斜杠（core.quotePath 等），统一成 POSIX 相对路径。
// 越界路径（绝对路径 / ../ 跳出）一律判为不安全，直接丢弃——它们不该出现在变更集里。
export function normChangePath(p) {
  const raw = String(p ?? '').replace(/\\/g, '/').trim()
  if (!raw) return null
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const norm = raw.replace(/^\.\//, '')
  if (norm.startsWith('../') || norm.includes('/../') || norm === '..') return null
  return norm
}

function defaultExecFile(cwd) {
  return (cmd, args) => execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
}

// `git diff --name-status` 输出解析。R/C 两列路径（from→to），D 记删除，其余记修改。
//
// 每条路径都过 `decodeGitPath`：git 默认 core.quotepath=true，会把非 ASCII 路径输出成
// `"a/\344\270\255.md"`（八进制字节转义 + 双引号）。不还原的话 `isWikiProduct` 匹配不上
// `.codewiki/`，中文名的 wiki 产物会被当成源码变更塞进 sourceChanges——增量 planner
// 于是每轮都以为产物是新源码。调用方已关 quotepath 时解码是幂等的，两边不冲突。
export function parseNameStatus(out) {
  const entries = []
  for (const rawLine of String(out ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split('\t')
    const code = String(parts[0] ?? '').trim()
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = normChangePath(decodeGitPath(parts[1]))
      const to = normChangePath(decodeGitPath(parts[2]))
      if (!from || !to) continue
      entries.push({ kind: code.startsWith('R') ? 'renamed' : 'copied', from, path: to, status: code })
      continue
    }
    const p = normChangePath(decodeGitPath(parts[1]))
    if (!p) continue
    entries.push({ kind: code.startsWith('D') ? 'deleted' : 'modified', path: p, status: code })
  }
  return entries
}

function emptyChangeSet(baseCommit, overrides = {}) {
  return {
    version: CHANGE_SET_VERSION,
    ok: false,
    state: 'unknown',
    fallback: null,
    reason: '',
    baseCommit: String(baseCommit ?? ''),
    headCommit: '',
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
    deleted: [],
    renamed: [],
    all: [],
    sourceChanges: [],
    ignored: [],
    ...overrides,
  }
}

// 采集变更集。
//   cwd        仓库工作目录
//   baseCommit 上次成功编译的基线 commit（cw 的 _meta.yaml:last_compiled_commit）
//   opts.execFile(cmd, args) -> stdout；抛错表示该命令失败
//
// 返回 ChangeSet。ok=false 时一定带 state 与 reason，且 fallback='full'——
// 调用方据此退回全量编译；不许把「采不到」当成「没变化」。
export function collectChangeSet(cwd, baseCommit, opts = {}) {
  const base = String(baseCommit ?? '').trim()
  if (!base) {
    return emptyChangeSet('', { state: 'missing-base', fallback: 'full', reason: '没有编译基线 commit，无法计算增量' })
  }
  const run = opts.execFile ?? defaultExecFile(cwd)
  const git = (args) => String(run('git', args) ?? '')

  // 1) HEAD 与仓库有效性：rev-parse HEAD 失败时再问一句「这里是不是 git 仓库」，
  //    以便区分「非 git 目录」和「git 仓库但命令出错」——两者的降级原因不同。
  let headCommit = ''
  try {
    headCommit = git(['rev-parse', 'HEAD']).trim()
  } catch (err) {
    let inside = ''
    try { inside = git(['rev-parse', '--is-inside-work-tree']).trim() } catch { inside = '' }
    if (inside !== 'true') {
      return emptyChangeSet(base, { state: 'no-git', fallback: 'full', reason: `不是 git 仓库或无法读取 HEAD：${String(err?.message ?? err).slice(0, 200)}` })
    }
    return emptyChangeSet(base, { state: 'git-error', fallback: 'full', reason: `git rev-parse HEAD 失败：${String(err?.message ?? err).slice(0, 200)}` })
  }
  if (!headCommit) {
    return emptyChangeSet(base, { state: 'git-error', fallback: 'full', reason: 'git rev-parse HEAD 没有输出' })
  }

  // 2) 基线可达性：编译基线被 rebase/GC 掉时 diff 无从谈起，必须退回全量而不是当成干净。
  try {
    git(['cat-file', '-e', `${base}^{commit}`])
  } catch (err) {
    return emptyChangeSet(base, {
      state: 'unreachable-base',
      fallback: 'full',
      headCommit,
      reason: `编译基线 ${base.slice(0, 7)} 已不在历史里（${String(err?.message ?? err).slice(0, 120)}），建议全量重编`,
    })
  }

  // 3) 四路采集。-M 打开改名检测：否则改名会被拆成「删一个 + 加一个」，
  //    下游 planner 就看不出「同一份内容换了位置」。
  const collect = (label, args) => {
    try { return parseNameStatus(git(args)) } catch (err) {
      throw new Error(`${label} 采集失败：${String(err?.message ?? err).slice(0, 200)}`)
    }
  }
  let committed = []
  let staged = []
  let unstaged = []
  let untracked = []
  try {
    committed = collect('committed', ['diff', '--name-status', '-M', `${base}..${headCommit}`])
    staged = collect('staged', ['diff', '--name-status', '-M', '--cached', 'HEAD'])
    unstaged = collect('unstaged', ['diff', '--name-status', '-M'])
    untracked = decodeGitPaths(String(git(['ls-files', '--others', '--exclude-standard']) ?? '').split(/\r?\n/))
      .map(normChangePath)
      .filter(Boolean)
  } catch (err) {
    return emptyChangeSet(base, { state: 'git-error', fallback: 'full', headCommit, reason: String(err?.message ?? err) })
  }

  // 4) 分类 + 去重。all 必须含改名两端（旧路径从「被谁引用」角度同样是变化）。
  const allSet = new Set()
  const deletedSet = new Set()
  const renamed = []
  const buckets = { committed, staged, unstaged }
  for (const [bucket, list] of Object.entries(buckets)) {
    for (const e of list) {
      allSet.add(e.path)
      if (e.kind === 'deleted') deletedSet.add(e.path)
      if (e.kind === 'renamed') {
        allSet.add(e.from)
        renamed.push({ from: e.from, path: e.path, bucket })
      }
      e.bucket = bucket
    }
  }
  for (const p of untracked) allSet.add(p)
  // 同一路径既删又重建（删了又新建同名文件）：当前存在就不是删除，
  // 否则 planner 会为一篇还在的文件安排 delete action。
  for (const p of [...deletedSet]) if (untracked.includes(p)) deletedSet.delete(p)

  const all = [...allSet].sort()
  const sourceChanges = all.filter((p) => !isWikiProduct(p))
  const ignored = all.filter(isWikiProduct)

  return {
    version: CHANGE_SET_VERSION,
    ok: true,
    state: 'ok',
    fallback: null,
    reason: '',
    baseCommit: base,
    headCommit,
    committed: committed.filter((e) => !isWikiProduct(e.path)),
    staged: staged.filter((e) => !isWikiProduct(e.path)),
    unstaged: unstaged.filter((e) => !isWikiProduct(e.path)),
    untracked: untracked.filter((p) => !isWikiProduct(p)),
    deleted: [...deletedSet].filter((p) => !isWikiProduct(p)).sort(),
    renamed: renamed.filter((r) => !isWikiProduct(r.path)),
    all,
    sourceChanges,
    ignored: ignored.sort(),
  }
}
