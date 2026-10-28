---
title: engine_process
type: module
source_files:
  - lib/engine/process-tree.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/mapping.js
  - test-engine-process-tree.mjs
  - docs/fsoft-native-engine.md
tags: [engine, process-tree, cancellation, worker, subprocess]
---

## Overview

`lib/engine/process-tree.js` 是 FSoft 原生引擎（Python 子进程）迁移里的一层**极薄、极专一的辅助模块**：只负责「终止一棵受管子进程树」，不做进程启动、不做协议、不碰 stdout（`lib/engine/process-tree.js:13`）。

它存在的理由写在文件头注释（`lib/engine/process-tree.js:1-14`）：FSoft 的 Python 进程自己也会派生子进程（flake8、find，以及某些后端会 fork claude/codex）。如果只 kill 直接子进程的 pid，孙进程会变成孤儿继续跑——在 DSH 里表现为「任务已取消，但机器上还挂着一个 python 在烧 token」（`lib/engine/process-tree.js:4-6`）。

它是阶段 1C 第 3 条「取消必须终止受管子进程树」的地基（`lib/engine/process-tree.js:61`），也是 `docs/fsoft-native-engine.md` 列出的 `cancel` 动作「终止受管子进程树（不是只 kill 父进程）」的实际执行者（`docs/fsoft-native-engine.md:89`）。代码库当前的引擎 worker spawner（真正 `spawn` 出 Python 引擎、持有 `child.pid` 的那一层）尚未并入本仓库，但取消语义调用方会拿到 `child.pid` 并把它传给本模块的 `terminateProcessTree`；测试用真实子/孙进程树验证「kill 打穿整棵树、不留孤儿」（`test-engine-process-tree.mjs:29-43`）。

模块保持小而可测是刻意的（`lib/engine/process-tree.js:14`）：任何取消语义的 bug 都应该集中在这里暴露，而不是散落在业务代码里。

平台差异（设计要点，`lib/engine/process-tree.js:8-12`）：

- **Windows**：没有进程组信号，可靠做法是 `taskkill /T /F`（`/T` 递归整棵树，`/F` 强制）。
- **POSIX**：用 `detached: true` 起的子进程自成一个进程组，`process.kill(-pid)` 一次性打整组；先 SIGTERM 让它有机会收尾，超时再 SIGKILL。

模块通过 `import { spawn } from 'node:child_process'`（`lib/engine/process-tree.js:18`）拿到 spawn，并用 `const IS_WINDOWS = process.platform === 'win32'`（`lib/engine/process-tree.js:18`）在加载期确定平台分支，之后所有终止逻辑按 `IS_WINDOWS` 分派（`lib/engine/process-tree.js:72`、`lib/engine/process-tree.js:82`）。

## Key Components

本模块没有 struct/model/class，全部为模块级函数。共 1 个内部常量、1 个内部辅助函数、2 个导出函数。

### `IS_WINDOWS`（模块级常量，`lib/engine/process-tree.js:18`）

```js
const IS_WINDOWS = process.platform === 'win32'
```

加载期一次性确定的平台标志。非 `win32`（即所有 POSIX 系：Linux / macOS）走进程组分支；`win32` 走 `taskkill` 分支。被 `terminateProcessTree` 在两处读取（`lib/engine/process-tree.js:61`、`lib/engine/process-tree.js:18`）。

### `run(command, args)`（内部辅助，非导出，`lib/engine/process-tree.js:20-32`）

用一个独立子进程执行一条外部命令（Windows 上 `windowsHide: true`、`stdio: 'ignore'`，`lib/engine/process-tree.js:24`），返回一个 Promise：

- 成功 exit → `{ code: code ?? -1 }`（`lib/engine/process-tree.js:30`）；
- `spawn` 抛错（同步失败）→ `{ code: -1, error: err }`（`lib/engine/process-tree.js:26`）；
- 子进程 `error` 事件（如 ENOENT）→ `{ code: -1, error: err }`（`lib/engine/process-tree.js:29`）。

目前唯一调用方是 `terminateProcessTree` 的 Windows 分支，用来跑 `taskkill /T /F /PID <pid>`（`lib/engine/process-tree.js:61`）。注意它**不**捕获 SIGTERM/SIGKILL 这类信号，那是 `process.kill` 直接做的事，不走 `run`。

### `isAlive(pid)`（导出，`lib/engine/process-tree.js:41-49`）

```js
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}
```

判定一个 pid 是否还活着。`process.kill(pid, 0)` 不发送任何信号，只做存在性探测（`lib/engine/process-tree.js:34-40`）：

- 不抛错 → 活着（或僵尸，仍需视为占用）→ 返回 `true`；
- 抛 `ESRCH` → 进程已退出 → 进入 catch，但 `code` 不是 `'EPERM'`，返回 `false`；
- 抛 `EPERM` → 进程存在但无权限 → 仍算活着，返回 `true`。

入参守卫：`pid` 不是正整数（非整数、`<= 0`、小数、`undefined`、`null`）一律返回 `false`（`lib/engine/process-tree.js:42`）。这是取消路径会被重入时的安全网——非法 pid 不会让上层炸。

### `terminateProcessTree(pid, options)`（导出，主入口，`lib/engine/process-tree.js:61-103`）

```js
export async function terminateProcessTree(pid, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 3000
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}
  ...
}
```

终止一棵以 `pid` 为根的受管子进程树。参数：

- `pid`（number）：根进程 pid（通常是 `spawn` 返回的 `child.pid`）。
- `options.graceMs`（number，默认 `3000`）：POSIX 路径下 SIGTERM 后等待根进程退出的宽限毫秒数（`lib/engine/process-tree.js:56`、`lib/engine/process-tree.js:62`）。
- `options.onLog`（fn，默认空函数）：诊断日志回调（`lib/engine/process-tree.js:57`、`lib/engine/process-tree.js:63`）。

返回值（Promise）：`{ ok: boolean, rootAlive: boolean, method: string }`（`lib/engine/process-tree.js:58-59`）。`ok=false` 表示根进程在超时后仍活着——**调用方应当据此报错，而不是假装取消成功**（`lib/engine/process-tree.js:59`）。`method` 字段取值见下。

执行流程：

1. **非法 pid 短路**：`pid` 非正整数直接返回 `{ ok: true, rootAlive: false, method: 'noop' }`（`lib/engine/process-tree.js:65-67`）。
2. **已退出短路**：`isAlive(pid)` 为 false 返回 `{ ok: true, rootAlive: false, method: 'already-exited' }`（`lib/engine/process-tree.js:68-70`）。
3. **Windows 分支**（`lib/engine/process-tree.js:72-80`）：`onLog` 记 `taskkill /T /F /PID <pid>`，跑 `run('taskkill', ['/T', '/F', '/PID', String(pid)])`（`lib/engine/process-tree.js:74-75`）。`taskkill` 是同步语义，返回后给 1000ms 回收窗口再判定（`waitForDeath(pid, 1000)`，`lib/engine/process-tree.js:77`），最终 `method: 'taskkill'`、根仍活则 `ok:false`。
4. **POSIX 分支**（`lib/engine/process-tree.js:82-102`）：先 `process.kill(-pid, 'SIGTERM')`（`lib/engine/process-tree.js:105`，负 pid = 整个进程组）；若抛错（说明子进程不是 `detached` 起的、没有独立进程组）则退化成 `process.kill(pid, 'SIGTERM')` 只打自己（`lib/engine/process-tree.js:87-89`）。`waitForDeath(pid, graceMs)` 后若死则返回 `{ ok: true, rootAlive: false, method: 'sigterm' }`（`lib/engine/process-tree.js:91-92`）；否则 `process.kill(-pid, 'SIGKILL')`（`lib/engine/process-tree.js:96`，同样带非 detached 退化，`lib/engine/process-tree.js:97-99`），再 `waitForDeath(pid, 1000)`，最终 `method: 'sigkill'`、根仍活则 `ok:false`。

### `waitForDeath(pid, timeoutMs)`（内部辅助，非导出，`lib/engine/process-tree.js:105-113`）

```js
async function waitForDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const step = 25
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return !isAlive(pid)
}
```

以 25ms 步长轮询 `isAlive(pid)`，直到超时或确认死亡；超时后仍做一次最终判定（`lib/engine/process-tree.js:112`）。被 `terminateProcessTree` 在 3 个时机调用：Windows 回收窗口（`lib/engine/process-tree.js:61`）、POSIX SIGTERM 宽限（`lib/engine/process-tree.js:91`）、POSIX SIGKILL 后（`lib/engine/process-tree.js:100`）。

## Architecture

本模块只有 3 个内部实体 + 2 个导出函数，但取消了跨平台的两条分派路径（Windows `taskkill` / POSIX 信号组），属于「流程非平凡」的情形，用框图表达：

```text
调用方（JobService / cancel 动作）
        │  持 child.pid，传 options{graceMs,onLog}
        ▼
┌─────────────────────────────────────────┐
│ terminateProcessTree(pid, options)       │  process-tree.js:61
│  · 非法/已退出pid → 短路 noop/already-   │
│    exited（幂等，不抛错）                 │
└───────────────┬─────────────────────────┘
                │ IS_WINDOWS ?  (process-tree.js:18)
       ┌────────┴────────┐
       ▼                 ▼
┌──────────────┐  ┌──────────────────────────────────────┐
│ Windows 分支  │  │ POSIX 分支                            │
│ taskkill /T  │  │ process.kill(-pid, SIGTERM)  (整组)   │
│ /F /PID pid  │  │  抛错则退化 process.kill(pid,SIGTERM) │
│ run()        │  │  宽限 graceMs 后还没死 →              │
│ process-     │  │  process.kill(-pid, SIGKILL)          │
│ tree.js:72   │  │ process-tree.js:82                    │
└──────┬───────┘  └───────────────┬──────────────────────┘
       │  waitForDeath(pid,1000)   │  waitForDeath(pid,graceMs/1000)
       ▼  process-tree.js:77       ▼
┌─────────────────────────────────────────────────────┐
│ waitForDeath(pid, timeoutMs)  —  25ms 轮询 isAlive    │  process-tree.js:105
│   isAlive(pid) → process.kill(pid,0) 探测存活         │  process-tree.js:41
└───────────────────────────┬─────────────────────────┘
                            ▼
              返回 {ok, rootAlive, method}
              method∈{noop,already-exited,taskkill,sigterm,sigkill}
```

关键设计点：

- `run()`（`process-tree.js:20`）只在 Windows 分支被 `terminateProcessTree` 调用一次（`process-tree.js:61`），用来执行 `taskkill`。
- `isAlive()` 是 `waitForDeath` 与 `terminateProcessTree` 前置判定的共同依赖（`process-tree.js:61`、`process-tree.js:105`、`process-tree.js:101`、`process-tree.js:109`）。
- `onLog` 仅用于诊断；测试断言它**不得含凭证字样**（api_key/authorization/token/bearer，`test-engine-process-tree.mjs:124`）。
- `method` 字段让调用方精确知道实际走了哪条终止路径，便于取消失败时的排障。

## Data Flow

一次取消的完整数据流向（结合 `test-engine-process-tree.mjs` 的真实进程树验证）：

1. **输入**：调用方持有一个真实引擎 worker 的 `child.pid`（例如 `docs/fsoft-native-engine.md:111-113` 描述的场景：模型调用进行到一半，桥请求计数 196→197 的那一瞬触发取消），带上 `{ graceMs, onLog }` 调 `terminateProcessTree(pid, options)`。
2. **前置判定**（`process-tree.js:65-70`）：非法 pid → 立即 `{ok:true, rootAlive:false, method:'noop'}`；`isAlive(pid)` 为 false → `{ok:true, rootAlive:false, method:'already-exited'}`。这两步保证取消路径被重入（多次取消同一任务的同一 pid）时永远幂等、不抛错（测试 `test-engine-process-tree.mjs:102-112` 验证）。
3. **平台分派**：
   - Windows：`run('taskkill', ['/T','/F','/PID',String(pid)])` 同步杀整棵树 → `waitForDeath(pid, 1000)` → `{ok:!rootAlive, rootAlive, method:'taskkill'}`。
   - POSIX：`process.kill(-pid, 'SIGTERM')`（整进程组；非 detached 退化打自己）→ `waitForDeath(pid, graceMs)`；若 1000ms 级窗口后仍活，再 `process.kill(-pid, 'SIGKILL')` → `waitForDeath(pid, 1000)` → `{ok:!rootAlive, rootAlive, method:'sigkill'}`。
4. **存活探测循环**：`waitForDeath`（25ms 步长）每轮调 `isAlive(pid)`，后者用 `process.kill(pid, 0)` 做零信号探测（`process-tree.js:44`）。孙进程同属进程组，因此 `-pid` 信号一次打穿；`taskkill /T` 同理递归子树。
5. **输出**：`{ ok, rootAlive, method }`。`ok=false` 仅当根进程在所有宽限后**仍**活着（`process-tree.js:79`、`process-tree.js:102`），这是调用方必须据此报错而非假装取消成功的信号（`process-tree.js:59`）。

验证要点（`test-engine-process-tree.mjs:29-43`、`test-engine-process-tree.mjs:78-100`）：测试起一棵两层真实进程树（root node spawn 一个长驻 grandchild node），杀掉 root 后必须断言 `isAlive(grandPid)` 为 false——若只 kill 根、孙进程变孤儿，该断言会失败并报告「取消没有打穿进程树」。这正是对 `process-tree.js:41-43` 所述历史缺陷的逆向钉死。

## Connections

- [[fsoft-native-engine]] — 本模块是 `docs/fsoft-native-engine.md` 冻结契约里 `cancel` 动作（「终止受管子进程树，不是只 kill 父进程」）的实际执行者；该文档在「取消与异常退出」一节直接点名 `lib/engine/process-tree.js` 的 `terminateProcessTree`（`docs/fsoft-native-engine.md:202-204`）。
- [[engine-contract]] — `lib/engine/contract.js` 定义了取消产生的 `cancelled` outcome 与 `engine-cancelled` / `engine-crashed` 错误码；取消失败（本模块返回 `ok:false`，根进程未死）时调用方据此把结果归为失败语义而非成功。
- [[engine-bridge]] — `lib/engine/llm-bridge.js` 提供宿主模型 loopback 桥；桥的客户端断连与超时通过 `AbortController` 中止上游调用（`lib/engine/llm-bridge.js:163-167`），与本模块的进程树终止共同构成「取消语义真正生效」的两端（桥侧中断 token 流 + 进程侧杀掉仍在烧 token 的引擎子树）。
- [[engine-mapping]] — `lib/engine/mapping.js` 负责 FSoft 产物落盘；取消可能在文章写作中途发生，mapping 侧对 partial/cancelled 的基线不变量（不改 `_meta.yaml` 的 `last_compiled_commit`）与本模块「干净杀树、不留孤儿」互为前提。

> 注：本仓库当前 commit 尚未并入真正 `spawn` 出 Python 引擎、持有 `child.pid` 的 worker spawner 层（即调用 `terminateProcessTree` 的直接入口）。该层是阶段 5 的接入目标。本模块的契约（入参 `pid` + `options`、返回 `{ok,rootAlive,method}`）已稳定，可被该 spawner 直接对接。

## Known Issues

- **Windows 分支回收窗口固定 1000ms**（`lib/engine/process-tree.js:77`）：`waitForDeath(pid, 1000)` 的 1000ms 是硬编码，不受 `options.graceMs` 影响（POSIX 分支的 SIGTERM 宽限才用 `graceMs`）。若 Windows 上孙进程（如 python 派生的 flake8）回收慢于 1 秒，可能出现 `isAlive(pid)` 仍 true、`ok=false` 的假失败。当前尚无 issue 跟踪，属已知紧耦合。
- **`onLog` 资安约束靠约定而非强制**：文件头与测试都要求日志不含 api_key/token（`test-engine-process-tree.mjs:124`），但代码层只在消息里拼接了 `taskkill`/`SIGTERM`/`SIGKILL` 命令文本（`lib/engine/process-tree.js:63`、`lib/engine/process-tree.js:83`、`lib/engine/process-tree.js:94`），不触碰凭证——依赖调用方不往 `onLog` 里塞敏感串。本模块自身不读任何凭证（`lib/engine/process-tree.js:13`）。
- **非 detached POSIX 子进程的退化路径**：若未来被接入的引擎 worker 不是以 `detached: true` 起的，`process.kill(-pid, ...)` 会因「没有进程组」抛错，然后退化成只打自己 pid（`lib/engine/process-tree.js:87-89`、`lib/engine/process-tree.js:97-99`）。此时孙进程仍可能变孤儿——这正是 `lib/engine/process-tree.js:4-6` 警示的场景，要求调用方保证引擎 worker 必须以 detached 方式启动。
- **`run()` 仅用于 taskkill，无超时**：`run`（`lib/engine/process-tree.js:20-32`）的 Promise 只在子进程 exit/error 时 resolve，没有超时保护。正常 `taskkill /T /F` 几乎瞬时返回，但若系统命令异常挂起，调用方会一直 await。当前无防护，也未在测试中覆盖。
- **无单测覆盖 `isAlive` 的 EPERM 分支**：`isAlive` 对 `EPERM`（无权限但仍存活）返回 true（`lib/engine/process-tree.js:47`），这是有意为之（视为占用），但测试只覆盖了「存在/已退出/非法/不存在 pid」（`test-engine-process-tree.mjs:57-67`），未构造 EPERM 场景。
