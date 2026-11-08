// 工作区快照：把**未提交**的四路改动合成一个真实 commit 交给引擎。
//
// 为什么需要它（规格 L82 / 阶段 5 的已知缺口）：
//
// FSoft 只从 `<old_commit>..<new_commit>` 取 diff，未提交改动不进它的 update_record。
// 插件侧 `lib/change-set.js` 能采到 committed/staged/unstaged/untracked 四路，但采到
// 之后只是**记账**（state.json 的 unconsumed），引擎并没有一个「本轮消费到哪」的对象
// 可以对齐——它读的是工作区文件（内容是对的），可 metadata.json 的 commit_id 只能写
// HEAD。于是出现两个后果：
//
//   1. 工作区脏时，产物与 HEAD 之间的对应关系是假的：文章写的是工作区的内容，
//      记账却指向 HEAD，下一轮增量拿这个 commit 当 old_commit 就会漏掉这些改动；
//   2. 质量门只能报一句「工作区有 N 个未提交源码改动」——如实，但无法回答
//      「那产物到底对应哪个状态」。
//
// 这里解掉第 1 条，第 2 条交给质量门自己表述（它仍然判 partial，因为快照不是
// 仓库历史里的提交，不能当前移的基线——那是对的）。
//
// 做法：用**独立 index 文件**（GIT_INDEX_FILE）走 read-tree → add -A → write-tree
// → commit-tree，得到一个含全部工作区改动的树对象，parent 指向 HEAD，**不写任何
// ref**。所以：
//   · 用户的分支、HEAD、工作区、真实 index 一个字节都不动；
//   · 得到的 sha 是真实可达 commit（对象在 .git/objects 里，可被 rev-parse 校验），
//     引擎写进 metadata.generation_info.commit_id 后，下一轮能拿它做 old_commit；
//   · 它不挂在任何 ref 上，因此**不能**作为已提交基线推进（gc 后自然消失）。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { toPosix } from '../git-paths.js'

function gitWith(cwd, env, args) {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  }) ?? '')
}

/**
 * 造一个「含工作区改动」的临时 commit（不写 ref）。
 *
 * @param {object} o
 * @param {string} o.repoRoot   仓库根
 * @param {object} [o.changeSet] collectChangeSet 的结果（只用来判「有没有东西要快照」）
 * @returns {{ok:boolean, sha:string, parent:string, files:number, skipped:string[], error?:string}}
 *          快照失败一律 ok:false + error：调用方退回「用 HEAD 记账」的旧行为并记 note，
 *          绝不因为造不出快照就让一次编译失败。
 */
export function createWorkspaceSnapshot({ repoRoot, changeSet = null } = {}) {
  const root = repoRoot ? path.resolve(String(repoRoot)) : ''
  const fail = (error) => ({ ok: false, sha: '', parent: '', files: 0, skipped: [], error })
  if (!root) return fail('createWorkspaceSnapshot: 需要 repoRoot')

  // 没有任何「未提交」的改动时不造快照：HEAD 本身就是准确的对应关系，
  // 多造一个内容相同的 commit 只会让 metadata 指向一个没人认识的 sha。
  const dirtyCount = ['staged', 'unstaged', 'untracked']
    .reduce((n, k) => n + (Array.isArray(changeSet?.[k]) ? changeSet[k].length : 0), 0)
  if (changeSet && dirtyCount === 0) {
    return { ok: false, sha: '', parent: '', files: 0, skipped: [], error: '工作区没有未提交改动，无需快照' }
  }

  let parent = ''
  try { parent = gitWith(root, {}, ['rev-parse', 'HEAD']).trim() } catch (err) {
    return fail(`读 HEAD 失败：${String(err?.message ?? err).slice(0, 200)}`)
  }
  if (!parent) return fail('git rev-parse HEAD 没有输出')

  // 独立 index：与用户的真实 index 完全隔离，所以 `add -A` 不会把用户已 staged
  // 的东西顺手提交、也不会清掉他的暂存区。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-snapshot-'))
  const indexFile = path.join(tmpDir, 'index')
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    gitWith(root, env, ['read-tree', parent])
    // -A 让「新增/删除/改名」都进快照。用 `-- .` 限定在当前目录，
    // 避免未来有人把 CWD 设到子目录时快照漏掉别的路径。
    gitWith(root, env, ['add', '-A', '--', '.'])
    const tree = gitWith(root, env, ['write-tree']).trim()
    if (!tree) return fail('git write-tree 没有输出')
    const sha = gitWith(root, env, [
      '-c', 'user.name=dsh-codewiki',
      '-c', 'user.email=dsh-codewiki@localhost',
      'commit-tree', tree, '-p', parent,
      '-m', `chore: 工作区快照（未提交改动的临时消费基线，不挂 ref）\n\n由 dsh-codewiki 原生引擎通道生成：引擎只认 committed diff，\n未提交改动需要用一棵真实的树交给它记账。此提交不写任何 ref，\ngc 后自然消失，不可作为已提交基线推进。`,
    ]).trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) return fail(`commit-tree 返回的不是 40 位 sha：${sha.slice(0, 60)}`)
    // 变更文件数：与 HEAD 树的差异条数（人读的证据，不是判据）。
    let files = 0
    try {
      files = gitWith(root, {}, ['diff', '--name-only', '-M', `${parent}..${sha}`])
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length
    } catch { /* 统计失败不影响快照成立 */ }
    return { ok: true, sha, parent, files, skipped: [], error: '' }
  } catch (err) {
    return fail(`造快照失败：${String(err?.message ?? err).slice(0, 300)}`)
  } finally {
    // index 文件只是中间产物（tree 与 commit 对象已落进 .git/objects）。
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结果 */ }
  }
}

/** 快照是否可被 git 识别（给测试与排障用；不参与裁决）。 */
export function snapshotExists({ repoRoot, sha } = {}) {
  const root = repoRoot ? path.resolve(String(repoRoot)) : ''
  const target = String(sha ?? '').trim()
  if (!root || !/^[0-9a-f]{40}$/.test(target)) return false
  try {
    return gitWith(root, {}, ['cat-file', '-t', target]).trim() === 'commit'
  } catch { return false }
}

/** 把快照 sha 当前缀显示（日志/note 用）。 */
export const shortSha = (sha) => toPosix(String(sha ?? '')).slice(0, 12)
