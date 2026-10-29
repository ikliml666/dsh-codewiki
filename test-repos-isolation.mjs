// test-repos-isolation.mjs — 已知仓库清单（REPOS_FILE）的落点必须跟随 JOBS_FILE 隔离。
//
// 起因（真机事故）：REPOS_FILE 原先固定推导为 `dirname(JOBS_FILE)/dsh-codewiki-repos.json`。
// 各测试套件都把 JOBS_FILE 指向 `dsh-codewiki-jobs-test-<pid>-<token>.json` 做隔离，dirname
// 仍是系统临时目录，于是推导出的清单路径与**真实宿主**的完全一致——跑一次测试就会把
// fixture 仓库路径（如 `%TEMP%/cw-orch-xxxxxx`）写进宿主的 dsh-codewiki-repos.json。
// 真机现场：宿主清单里躺着早已删除的 `CW-orch-txSQbO`，自动调度每轮仍把它扫一遍。
//
// 断言口径：JOBS_FILE 被改成非默认名时，REPOS_FILE 必须跟着改，且绝不等同于宿主默认路径；
// 生产默认形态必须保持（兼容旧清单）；显式 DSH_CODEWIKI_REPOS_FILE 最优先。
// 运行：node test-repos-isolation.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures += 1; console.error(`  ✗ ${msg}`) }
}

// 宿主真实清单：**绝不能**被本套件写到
const HOST_REPOS_FILE = path.join(os.tmpdir(), 'dsh-codewiki-repos.json')
const hostBefore = fs.existsSync(HOST_REPOS_FILE) ? fs.readFileSync(HOST_REPOS_FILE, 'utf8') : null

// 必须在 import index.js 之前设好：模块级常量在加载时求值
const token = crypto.randomBytes(4).toString('hex')
const ISOLATED_JOBS = path.join(os.tmpdir(), `dsh-codewiki-jobs-test-${process.pid}-${token}.json`)
process.env.DSH_CODEWIKI_JOBS_FILE = ISOLATED_JOBS
delete process.env.DSH_CODEWIKI_REPOS_FILE

const mod = await import('./index.js')
const { REPOS_FILE, apply, reposFileFor } = mod

console.log('== 清单落点 ==')
console.log(`  JOBS_FILE(隔离) = ${ISOLATED_JOBS}`)
console.log(`  REPOS_FILE      = ${REPOS_FILE}`)
console.log(`  宿主清单        = ${HOST_REPOS_FILE}`)

// 1) 隔离后的清单路径不能与宿主相同——真机事故的直接判据
check(
  typeof REPOS_FILE === 'string' && path.resolve(REPOS_FILE) !== path.resolve(HOST_REPOS_FILE),
  `隔离 JOBS_FILE 后 REPOS_FILE 必须换路径，不能仍是宿主清单（实际 ${REPOS_FILE}）`,
)

// 2) 生产默认形态必须保持不变：默认 JOBS_FILE → 宿主那份 repos 文件，
//    否则宿主升级后旧清单被当成不存在，自动调度一口气丢掉所有已知仓库
check(
  typeof reposFileFor === 'function' &&
    path.resolve(reposFileFor(path.join(os.tmpdir(), 'dsh-codewiki-jobs.json'))) === path.resolve(HOST_REPOS_FILE),
  `默认 JOBS_FILE 必须仍指向宿主清单以兼容旧登记（实际 ${typeof reposFileFor === 'function' ? reposFileFor(path.join(os.tmpdir(), 'dsh-codewiki-jobs.json')) : 'reposFileFor 未导出'}）`,
)

// 3) 显式 DSH_CODEWIKI_REPOS_FILE 最优先（测试/运维要能钉死路径）
{
  const pinned = path.join(os.tmpdir(), `cw-pinned-repos-${token}.json`)
  const got = typeof reposFileFor === 'function' ? reposFileFor(ISOLATED_JOBS, pinned) : ''
  check(path.resolve(got) === path.resolve(pinned), `显式 REPOS_FILE 必须最优先（实际 ${got}）`)
  fs.rmSync(pinned, { force: true })
}

// 4) 实证：apply 启动时会把作业历史里的仓库登记进清单——
//    这一步正是测试污染宿主的真实路径，必须落在隔离文件里、宿主文件逐字节不变
{
  const fixtureCwd = path.join(os.tmpdir(), `cw-repos-iso-${token}`)
  fs.mkdirSync(fixtureCwd, { recursive: true })
  fs.writeFileSync(path.join(fixtureCwd, 'main.js'), 'export const x = 1\n', 'utf8')
  fs.writeFileSync(
    ISOLATED_JOBS,
    JSON.stringify({
      jobs: [{
        id: 'job-repos-iso-0',
        cwd: fixtureCwd,
        stage: 'done',
        outcome: 'done',
        kind: 'full',
        scope: 'full',
        auto: false,
        writtenCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }],
    }),
    'utf8',
  )
  fs.rmSync(REPOS_FILE, { force: true })

  const disposers = []
  const ctx = {
    inject(_names, fn) { try { fn({}) } catch { /* 无对应服务：插件按缺省处理 */ } },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  }
  apply(ctx, { nativeEngine: false, autoUpdate: false })
  for (const d of disposers) { try { d() } catch { /* 收尾失败不影响断言 */ } }

  const isolated = fs.existsSync(REPOS_FILE)
    ? JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')).repos ?? []
    : []
  check(
    isolated.some((p) => String(p).replace(/[\\/]+$/, '').toLowerCase() === fixtureCwd.replace(/[\\/]+$/, '').toLowerCase()),
    `作业历史里的仓库必须登记进隔离清单（实际 ${JSON.stringify(isolated)}）`,
  )
  const hostNow = fs.existsSync(HOST_REPOS_FILE) ? fs.readFileSync(HOST_REPOS_FILE, 'utf8') : null
  check(hostNow === hostBefore, '宿主清单必须逐字节未变（测试不得污染真实宿主）')
  fs.rmSync(fixtureCwd, { recursive: true, force: true })
}

// 收尾：本套件自己产生的隔离文件不留在 tmp
for (const f of [ISOLATED_JOBS, REPOS_FILE]) {
  if (f && path.resolve(f) !== path.resolve(HOST_REPOS_FILE)) fs.rmSync(f, { force: true })
}

if (failures) {
  console.error(`\nFAIL：${failures} 项未通过`)
  process.exit(1)
}
console.log('\nPASS：仓库清单隔离全部通过')
