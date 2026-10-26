// test-worktree.mjs — linked worktree 闸门（1.2.0）：detectLinkedWorktree 三态。
// 用真实 git 命令建临时仓库 + linked worktree，保证判据来自 git 本身而不是目录命名。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), `cw-wt-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`)
const { detectLinkedWorktree } = await import('./index.js')

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

git('-C', main, 'worktree', 'remove', '--force', linked)
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(process.env.DSH_CODEWIKI_JOBS_FILE, { force: true })
console.log(failures ? `FAIL：${failures} 项失败` : 'PASS：worktree 闸门检测全部通过')
process.exit(failures ? 1 : 0)
