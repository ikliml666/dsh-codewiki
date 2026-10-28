// 受管子进程树的终止（阶段 1C 第 3 条 / 阶段 2 client.js 的地基）。
//
// 为什么需要单独一层：
//   FSoft 的 Python 进程自己也会派生子进程（flake8、find、以及某些后端会 fork
//   claude/codex）。只 kill 直接子进程的 pid，孙进程会变成孤儿继续跑——
//   在 DSH 里表现为「任务已取消，但机器上还挂着一个 python 在烧 token」。
//
// 平台差异：
//   · Windows 没有进程组信号，可靠做法是 `taskkill /T /F`（/T 递归整棵树）。
//   · POSIX 用 `detached: true` 起的子进程自成一个进程组，`process.kill(-pid)`
//     一次性打整组；先 SIGTERM 让它有机会收尾，超时再 SIGKILL。
//
// 这个模块只做「终止」一件事，不做进程启动、不做协议、不碰 stdout。
// 保持它小而可测：任何取消语义的 bug 都会在这里暴露，而不是散落在业务里。

import { spawn } from 'node:child_process'

const IS_WINDOWS = process.platform === 'win32'

function run(command, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      resolve({ code: -1, error: err })
      return
    }
    child.on('error', (err) => resolve({ code: -1, error: err }))
    child.on('exit', (code) => resolve({ code: code ?? -1 }))
  })
}

/**
 * 判断一个 pid 是否还活着。
 * `process.kill(pid, 0)` 不发送信号、只做存在性探测：
 *   · 不抛错 → 活着（或僵尸，仍需视为占用）
 *   · 抛 ESRCH → 已退出
 *   · 抛 EPERM → 存在但无权限（仍算活着）
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 终止一棵受管子进程树。
 *
 * @param {number} pid 根进程 pid（spawn 返回的 child.pid）
 * @param {object} [options]
 * @param {number} [options.graceMs=3000] SIGTERM 后等待的宽限（POSIX 有效）
 * @param {(msg: string) => void} [options.onLog] 诊断日志回调
 * @returns {Promise<{ ok: boolean, rootAlive: boolean, method: string }>}
 *   ok=false 表示根进程在超时后仍活着（调用方应当据此报错，而不是假装取消成功）。
 */
export async function terminateProcessTree(pid, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 3000
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}

  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: true, rootAlive: false, method: 'noop' }
  }
  if (!isAlive(pid)) {
    return { ok: true, rootAlive: false, method: 'already-exited' }
  }

  if (IS_WINDOWS) {
    // /T = 整棵树，/F = 强制。不加 /F 时 GUI 进程常常收不到、无控制台进程也不响应。
    onLog(`terminateProcessTree: taskkill /T /F /PID ${pid}`)
    await run('taskkill', ['/T', '/F', '/PID', String(pid)])
    // taskkill 是同步语义的，返回后树应已消失；给一个极短的回收窗口再判定。
    await waitForDeath(pid, 1000)
    const rootAlive = isAlive(pid)
    return { ok: !rootAlive, rootAlive, method: 'taskkill' }
  }

  // POSIX：先温和后强杀。负 pid 表示「整个进程组」。
  onLog(`terminateProcessTree: SIGTERM -${pid}`)
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 子进程若不是用 detached 起的，就没有独立进程组；退化成只打自己。
    try { process.kill(pid, 'SIGTERM') } catch {}
  }

  const died = await waitForDeath(pid, graceMs)
  if (died) return { ok: true, rootAlive: false, method: 'sigterm' }

  onLog(`terminateProcessTree: SIGKILL -${pid}（SIGTERM 宽限 ${graceMs}ms 未退）`)
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  await waitForDeath(pid, 1000)
  const rootAlive = isAlive(pid)
  return { ok: !rootAlive, rootAlive, method: 'sigkill' }
}

async function waitForDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const step = 25
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return !isAlive(pid)
}
