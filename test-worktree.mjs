// test-worktree.mjs — worktree / 空壳目录闸门：0.12.0 的 detectLinkedWorktree 三态，
// 以及 0.12.1 的 isWorktreeCwd / hasCompilableSources / isDeadCompileTarget 统一判定。
// 用真实 git 命令建临时仓库 + linked worktree，保证判据来自 git 本身而不是目录命名。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `cw-wt-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`)
const { detectLinkedWorktree, isWorktreeCwd, hasCompilableSources, isDeadCompileTarget } = await import('./index.js')

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.error(`  ✗ ${msg}`) } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wt-'))
const main = path.join(root, 'main')
const linked = path.join(root, 'linked')
const git = (...args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true })
const setup = []
setup.push(git('init', '-q', main))
setup.push(git('-C', main, 'config', 'user.email', 't@t'))
setup.push(git('-C', main, 'config', 'user.name', 't'))
fs.writeFileSync(path.join(main, 'a.txt'), 'a\n')
setup.push(git('-C', main, 'add', 'a.txt'))
setup.push(git('-C', main, 'commit', '-qm', 'init'))
setup.push(git('-C', main, 'worktree', 'add', '-q', linked))
const bad = setup.find((r) => r.status !== 0)

if (bad) {
  // 环境没有可用 git（或 hooks 干扰）：跳过而不是误报成功
  console.log(`SKIP：无法搭建 git 测试环境 —— ${String(bad.stderr ?? '').slice(0, 200)}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
  process.exit(0)
}

check(detectLinkedWorktree(main) === null, '主工作区 → null（放行）')
const wt = detectLinkedWorktree(linked)
check(wt !== null, 'linked worktree → 命中')
check(!!wt && /worktrees/i.test(wt.gitDir), `命中时 gitDir 指向 .git/worktrees（${wt?.gitDir}）`)
check(!!wt && !/worktrees/i.test(wt.commonDir), `commonDir 指向主仓库 .git（${wt?.commonDir}）`)
check(detectLinkedWorktree(path.join(main, 'sub-missing')) !== null === false, '不存在路径 → null（不误报）')

// 子目录（在 worktree 里往下钻）同样命中
fs.mkdirSync(path.join(linked, 'sub'), { recursive: true })
check(detectLinkedWorktree(path.join(linked, 'sub')) !== null, 'worktree 子目录 → 命中')

// 非 git 目录 → null（不阻断普通文件夹）
const plain = path.join(root, 'plain')
fs.mkdirSync(plain, { recursive: true })
check(detectLinkedWorktree(plain) === null, '非 git 目录 → null（放行）')
check(detectLinkedWorktree('') === null && detectLinkedWorktree(null) === null, '空/空值输入 → null')

// ── 0.12.1：isWorktreeCwd 布尔封装（面板 2s 轮询用的带缓存版）与空壳目录判定 ──
check(isWorktreeCwd(main) === false, 'isWorktreeCwd(主工作区) === false')
check(isWorktreeCwd(linked) === true, 'isWorktreeCwd(linked worktree) === true')
check(isWorktreeCwd(path.join(linked, 'sub')) === true, 'isWorktreeCwd(worktree 子目录) === true')
check(isWorktreeCwd(plain) === false, 'isWorktreeCwd(非 git 目录) === false')
check(isWorktreeCwd('') === false && isWorktreeCwd(null) === false, 'isWorktreeCwd 空值 → false')
// 缓存：同一路径连查两次结果必须一致（第二次走缓存）
check(isWorktreeCwd(linked) === true && isWorktreeCwd(linked) === true, 'isWorktreeCwd 缓存命中后结果一致')

// 空壳目录：只有 .codewiki 骨架（. 开头目录本就进扫描黑名单）→ 无源码
const shell = path.join(root, 'shell')
fs.mkdirSync(path.join(shell, '.codewiki'), { recursive: true })
fs.writeFileSync(path.join(shell, '.codewiki', '_meta.yaml'), 'commit: x\n')
check(hasCompilableSources(main) === true, 'hasCompilableSources(有 a.txt 的仓库) === true')
check(hasCompilableSources(shell) === false, 'hasCompilableSources(只剩 .codewiki) === false')
check(hasCompilableSources(path.join(root, 'missing')) === false, 'hasCompilableSources(不存在路径) === false')

// isDeadCompileTarget：worktree 与空壳都算 dead；不存在的目录不算（保留历史记录）
check(isDeadCompileTarget(main) === false, 'isDeadCompileTarget(主工作区) === false')
check(isDeadCompileTarget(linked) === true, 'isDeadCompileTarget(linked worktree) === true')
check(isDeadCompileTarget(shell) === true, 'isDeadCompileTarget(空壳目录) === true')
check(isDeadCompileTarget(path.join(root, 'gone-dir')) === false, 'isDeadCompileTarget(目录不存在) === false（历史保留）')
check(isDeadCompileTarget('') === false && isDeadCompileTarget(null) === false, 'isDeadCompileTarget 空值 → false')

git('-C', main, 'worktree', 'remove', '--force', linked)
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
console.log(failures ? `FAIL：${failures} 项失败` : 'PASS：worktree 闸门检测全部通过')
process.exit(failures ? 1 : 0)
