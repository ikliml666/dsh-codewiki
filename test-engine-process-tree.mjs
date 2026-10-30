// 受管子进程树终止的测试（阶段 1C 第 3 条：取消必须终止受管子进程树）。
//
// 这个测试用真实的子进程和孙进程，不 mock。原因：
//   「kill 只打到自己、孙进程变孤儿」这个 bug 只有在真实进程树里才会出现，
//   mock 掉的 process.kill 永远是对的。计划里 1C 明确要求验证进程树，
//   所以这里必须起真进程、真派生、真杀。
//
// 断言的是可观测事实：
//   · 根进程退出后，它派生的孙进程也必须退出（不是只死根）；
//   · 已经退出的 pid 重复终止不报错（幂等，取消路径会被重入）；
//   · 非法 pid 不炸（传 undefined/0/负数都要安全）；
//   · 返回值 ok/rootAlive 真实反映结果（不能假装取消成功）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAlive, terminateProcessTree } from './lib/engine/process-tree.js'

let pass = 0
const fails = []
async function check(label, fn) {
  try { await fn(); pass++; console.log(`PASS  ${label}`) }
  catch (err) { fails.push({ label, err }); console.log(`FAIL  ${label}\n      ${err.message}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 起一棵真实的两层进程树：
//   root(node) ──spawn──> grandchild(node，写 pid 文件并长驻)
// root 打印孙进程 pid 到 stdout 后自己 setInterval 长驻，等我们来杀。
function startTree(dir) {
  const script = `
    const { spawn } = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' })
    writeFileSync(${JSON.stringify(join(dir, 'grandchild.pid'))}, String(kid.pid))
    process.stdout.write(String(kid.pid) + '\\n')
    setInterval(() => {}, 1e6)
  `
  const root = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  return root
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const txt = readFileSync(path, 'utf8').trim()
      if (txt) return Number(txt)
    }
    await sleep(30)
  }
  throw new Error(`等待 ${path} 超时（孙进程未启动）`)
}

await check('isAlive：已退出进程返回 false，不存在 pid 返回 false', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((r) => child.on('exit', r))
  await sleep(100)
  assert.equal(isAlive(pid), false, `已退出的 ${pid} 不应算活着`)
  assert.equal(isAlive(999999), false, '不存在的 pid 不应算活着')
  assert.equal(isAlive(0), false, 'pid 0 不安全，应返回 false')
  assert.equal(isAlive(-1), false, '负 pid 不安全，应返回 false')
  assert.equal(isAlive(undefined), false, 'undefined 应返回 false')
})

await check('terminateProcessTree：非法 pid 是 noop，不抛错', async () => {
  for (const bad of [undefined, null, 0, -5, 1.5, 'abc']) {
    const r = await terminateProcessTree(bad)
    assert.equal(r.ok, true, `非法 pid ${String(bad)} 应视为已完成`)
    assert.equal(r.rootAlive, false)
    assert.equal(r.method, 'noop')
  }
})

await check('terminateProcessTree：根进程退出后，孙进程也必须死（不留孤儿）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tree-'))
  try {
    const root = startTree(dir)
    const grandPid = await waitForFile(join(dir, 'grandchild.pid'))
    assert.ok(isAlive(root.pid), '根进程应活着')
    assert.ok(isAlive(grandPid), '孙进程应活着')

    const result = await terminateProcessTree(root.pid, { graceMs: 2000 })
    assert.equal(result.ok, true, `终止应成功，实际 ${JSON.stringify(result)}`)
    assert.equal(result.rootAlive, false, '根进程应已退出')

    await sleep(150)
    assert.equal(isAlive(root.pid), false, `根进程 ${root.pid} 仍活着`)
    assert.equal(
      isAlive(grandPid),
      false,
      `孙进程 ${grandPid} 变成孤儿仍在运行——取消没有打穿进程树`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('terminateProcessTree：已退出的进程重复终止是幂等的', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((r) => child.on('exit', r))
  await sleep(100)
  const r1 = await terminateProcessTree(pid)
  assert.equal(r1.ok, true)
  assert.equal(r1.method, 'already-exited')
  const r2 = await terminateProcessTree(pid)
  assert.equal(r2.ok, true, '第二次终止也必须成功（取消路径会被重入）')
})

await check('terminateProcessTree：onLog 收到诊断信息且不含凭证字样', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tree-log-'))
  try {
    const root = startTree(dir)
    await waitForFile(join(dir, 'grandchild.pid'))
    const logs = []
    await terminateProcessTree(root.pid, { graceMs: 1000, onLog: (m) => logs.push(m) })
    assert.ok(logs.length > 0, '应至少记录一条终止方式')
    const joined = logs.join('\n')
    assert.match(joined, /taskkill|SIGTERM|SIGKILL/, '日志应写明终止手段')
    assert.doesNotMatch(joined, /api[-_]?key|authorization|token|bearer/i, '日志不得含凭证字样')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log(`\n--- ${f.label}\n${f.err.stack ?? f.err.message}`)
  process.exitCode = 1
}
