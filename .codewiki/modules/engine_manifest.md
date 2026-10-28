---
title: engine_manifest
type: module
source_files:
  - lib/engine/manifest.js
  - test-engine-manifest.mjs
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/python/stage_map.py
  - lib/engine/output.js
  - index.js
tags: [engine, manifest, environment-probe, lock, doctor, fsoft]
---

## Overview

`engine_manifest` 是 FSoft 外部引擎的**环境指纹与锁文件（lock）管理器**，位于 `lib/engine/manifest.js`（共 181 行）。它回答一个最关键也最难查的问题：**「现在跑的是哪个引擎、哪个环境、和上次比有没有漂」**。

为什么需要它（来自文件头注释 manifest.js:1-13）：FSoft 是**外部**引擎，版本与依赖都不由本仓库控制。没有清单的话，同一份 wiki 在不同机器 / 不同 pip 状态下会产出不同结果，而错误会表现为「模型不听话」而不是「环境漂了」——这是最难查的一类问题。本模块只做三件事：

1. **指纹（fingerprint）**：读引擎版本 + Python 版本，算一个稳定 hash（`fingerprintOf`，manifest.js:50-56）。
2. **比对（compare）**：把当前指纹与落盘的 lock 比，不一致就明确说哪一项不一致（`compareLock`，manifest.js:86-111）。
3. **落盘（write）**：把指纹写到 `.codewiki/engine-lock.json`，供下次比对与审计（`writeLock`，manifest.js:117-135）。

设计边界（manifest.js:12-13）：本模块**不装依赖、不修环境、不联网**。`doctor`（manifest.js:141-170）是**只读诊断**，它报告事实，由上层决定要不要重新 setup（那是 `tools/fsoft-engine/setup-env.sh` 的职责）。为了让这层可被单测、纯逻辑，探测动作被抽成调用方传入的 `probe` 函数（manifest.js:27-28、34-35），进程管理留在 `lib/engine/client.js` 的 `runEngine({ action: 'doctor' })`（client.js:212、227）。

关键不变量：**指纹只吃决定产物内容的因素（引擎版本 + Python 版本）**，`pipCheckOk` 不参与指纹（manifest.js:47-49）——依赖闭合是「能不能跑」的闸门，不是「产物会是什么」的输入；把 pip 状态算进指纹会让每次修依赖都像换了引擎。

## Key Components

`lib/engine/manifest.js` 全部公开导出（见默认导出 manifest.js:172-181）如下：

### 常量

- `MANIFEST_VERSION` (manifest.js:19) — 清单 schema 版本，当前为 `1`。参与指纹计算（`fingerprintOf` 在摘要里写 `manifest:${MANIFEST_VERSION}`）与落盘 `manifestVersion` 字段（writeLock, manifest.js:123）。
- `ENGINE_LOCK_REL` (manifest.js:20) — 锁文件相对仓库根的固定路径 `.codewiki/engine-lock.json`。`readLock` / `writeLock` 都基于此拼路径；`test-engine-manifest.mjs:121` 也据此断言 `writeLock` 返回值等于它。

### 辅助函数

- `posix(p)` (manifest.js:22) — 把 `\` 替换成 `/`，仅用于把 `engineRoot` 归一化为 POSIX 风格（仅记录、用于审计），写入 fact 时调用（manifest.js:42）。

### 公开函数

- `probeEnvironment({ probe, engineRoot })` (manifest.js:34-45) — 探测引擎环境的只读事实。
  - 入参：`probe` 必须是函数（`() => Promise<{ version, pythonVersion, pipCheck:{ok,output} }>`），否则抛 `需要 probe 函数`（manifest.js:35，对应测试 test-engine-manifest.mjs:45-47）；`engineRoot` 仅记录，用于审计（manifest.js:32）。
  - 行为：调用 `probe()`，把原始结果归一化为 `{ version, pythonVersion, pipCheckOk, pipCheckOutput, engineRoot, fingerprint }`（manifest.js:37-44）。`pipCheckOk` 取 `raw.pipCheck.ok === true`，`pipCheckOutput` 取 `raw.pipCheck.output` 并 trim。`fingerprint` 由 `fingerprintOf(facts)` 算出。
  - 测试覆盖：version / pythonVersion / pipCheckOk / engineRoot 取值，fingerprint 为 16 位 hex（test-engine-manifest.mjs:36-43）。

- `fingerprintOf(facts)` (manifest.js:50-56) — 计算稳定 hash。
  - 算法：对 `manifest:${MANIFEST_VERSION}\n` + `version:${version}\n` + `python:${pythonVersion}\n` 做 sha256，取前 16 位 hex。
  - 关键性质：只吃 `version` 与 `pythonVersion`，**不**吃 `pipCheckOk`（manifest.js:47-49）。测试证明版本相同指纹相同、任一变化指纹变化，且 `pipCheckOk` 不影响指纹（test-engine-manifest.mjs:49-63）。

- `readLock({ repoRoot })` (manifest.js:61-75) — 读已落盘的 lock。
  - 不存在 / 坏 JSON 都返回 `null`（**不是错误**：首次运行本来没有 lock，manifest.js:59）。
  - 行为：拼 `.codewiki/engine-lock.json`，`readFileSync` 失败 catch 返回 null（manifest.js:64-68）；`JSON.parse` 前先 `text.replace(/^\uFEFF/, '')` 去 BOM（manifest.js:70），解析失败也返回 null（manifest.js:72-74）；非对象解析结果同样返回 null。
  - 测试覆盖：无 lock → null（test-engine-manifest.mjs:65-69）；坏 JSON → null 而非抛（test-engine-manifest.mjs:71-76）。

- `compareLock({ current, lock })` (manifest.js:86-111) — 比对当前指纹与 lock，返回**可机读的差异项**（不是抛错、不是布尔）。
  - `current` 缺省抛 `需要 current 指纹`（manifest.js:87）。
  - 五种 status（manifest.js:80-84 注释 + 实现）：
    - `absent`：lock 为空（首次运行，需要写一份）→ manifest.js:88-90。
    - `match`：完全一致 → manifest.js:110。
    - `drift`：引擎版本或 Python 版本变了（产物可能不同，必须让上层知道）→ manifest.js:107-108。
    - `unhealthy`：指纹一致但环境不闭合（pip check 失败）：能跑但不可信 → manifest.js:104-106（**pip check 失败优先于任何字段 diff**，即使版本一致也判 unhealthy）。
    - `fingerprint`：当 version / pythonVersion 两项都一致但指纹不一致时，说明**指纹算法变了**（manifest.js:100-103，仅在 `!diffs.length` 时补一条 `fingerprint` diff）。
  - 返回对象字段：`{ status, diffs, current, locked }`。`diffs` 是 `{ field, locked, current }` 数组（manifest.js:95、98、102），`field` 取值为 `'version'` / `'pythonVersion'` / `'fingerprint'`。
  - 测试覆盖：absent / match / drift(version) / drift(pythonVersion) / unhealthy（test-engine-manifest.mjs:78-112），且 drift 能指出具体哪个 field 及其 locked / current 值。

- `writeLock({ repoRoot, current })` (manifest.js:117-135) — 把当前环境事实写成 lock。
  - 缺 `repoRoot` 抛 `需要 repoRoot`；缺 `current.fingerprint` 抛 `需要带 fingerprint 的 current`（manifest.js:118-119，测试 test-engine-manifest.mjs:130-133）。
  - **原子写**：先写 `${file}.${process.pid}.tmp` 再 `fs.renameSync` 到目标，避免半截文件（manifest.js:131-133，注释 manifest.js:121）。目录用 `fs.mkdirSync(path.dirname(file), { recursive: true })` 自动创建（manifest.js:121，测试 test-engine-manifest.mjs:114-128）。
  - 落盘 body 字段（全部，manifest.js:122-130）：
    - `manifestVersion` — 取 `MANIFEST_VERSION`（整数，自动生成）。
    - `fingerprint` — 当前指纹（必填）。
    - `version` — 字符串。
    - `pythonVersion` — 字符串。
    - `engineRoot` — 字符串（审计用）。
    - `pipCheckOk` — 布尔（`current.pipCheckOk === true`）。
    - `recordedAt` — **自动生成字段**，`new Date().toISOString()` 写入时刻（manifest.js:129）。
  - 返回值：写入的相对路径 `ENGINE_LOCK_REL`（manifest.js:134）。
  - 测试覆盖：落盘内容完整、可被 `readLock` 读回、`recordedAt` 存在（test-engine-manifest.mjs:114-128）；二次写入覆盖旧值且不留 `.tmp`（test-engine-manifest.mjs:135-142）。

- `doctor({ probe, repoRoot, engineRoot })` (manifest.js:141-170) — 一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出来。**不抛**（probe 抛错变成 `ok:false`）。
  - 流程：先 `probeEnvironment`（manifest.js:144），失败则捕获并返回 `{ ok:false, status:'probe-failed', current:null, diffs:[], advice: '引擎探测失败：…' }`（manifest.js:145-153，测试 test-engine-manifest.mjs:185-190）。
  - 成功则 `readLock` + `compareLock`（manifest.js:154-155），按 `cmp.status` 查表生成 `advice` 文案（manifest.js:156-162）：
    - `absent` → 首次运行：确认后写入 engine-lock.json
    - `match` → 环境与上次一致
    - `drift` → 引擎或 Python 版本变化，产物可能不同；确认后重写 lock
    - `unhealthy` → 依赖不闭合（pip check 失败）：先用 `tools/fsoft-engine/setup-env.sh` 修复环境
    - `probe-failed` → 引擎不可用：检查 Python 路径与 FSoft 源码根
  - 返回 `{ ok, status, current, diffs, advice }`：`ok` 仅当 `status === 'match' || status === 'absent'` 为真（manifest.js:164）。
  - 测试覆盖：首次 absent 且 ok=true（test-engine-manifest.mjs:144-151）；写 lock 后再 doctor → match、ok=true（test-engine-manifest.mjs:153-160）；换版本 → drift、ok=false、diffs 有证据（test-engine-manifest.mjs:162-170）；依赖不闭合 → unhealthy、ok=false、建议指向 setup-env.sh（test-engine-manifest.mjs:172-183）。

### 默认导出

- `default` 对象 (manifest.js:172-181) — 聚合导出 `MANIFEST_VERSION` / `ENGINE_LOCK_REL` / `probeEnvironment` / `fingerprintOf` / `readLock` / `compareLock` / `writeLock` / `doctor`。

## Architecture

本模块是 `lib/engine/` 下最小、最纯粹的叶子节点（只依赖 Node 内置 `fs` / `path` / `crypto`，无跨模块依赖）。它对外被 `lib/engine/client.js` 的 `runEngine({ action: 'doctor' })` 间接调用（client.js:212、227 把 `doctor` 列为合法动作），也被上层在 `engine/stages` 的 `env` 阶段（`lib/engine/contract.js:24-25` 注释明确 `env` 阶段「解释器与依赖锁定校验（doctor）」）所参照。

```text
         调用方 probe()  (进程管理在 client.js:runEngine)
                  │  返回 {version, pythonVersion, pipCheck}
                  ▼
   ┌──────────────────────────────┐  lib/engine/manifest.js
   │  probeEnvironment (34-45)     │
   │     └─ fingerprintOf (50-56)  │  sha256(version+python+MANIFEST_VERSION)[:16]
   └──────────────┬───────────────┘
                  │ facts+ fingerprint
                  ▼
   ┌──────────────────────────────┐
   │  doctor (141-170)            │  只读诊断：不抛错
   │     readLock(61-75) ◄─┐      │  .codewiki/engine-lock.json
   │     compareLock(86-111)       │  status: absent/match/drift/
   │     writeLock(117-135) ──┘    │          unhealthy/probe-failed
   └──────────────┬───────────────┘
                  │ {ok, status, current, diffs, advice}
                  ▼
         上层（client.js 的 doctor 动作 / 面板 env 阶段）
```

组件清单（来自 `manifest.js`）：`probeEnvironment`(34-45) → 依赖 `fingerprintOf`(50-56)；`doctor`(141-170) 编排 `probeEnvironment` + `readLock`(61-75) + `compareLock`(86-111)；`writeLock`(117-135) 独立负责落盘（原子写）；五个 status 仅在 `compareLock` 内判定。

## Data Flow

一次典型的「首次运行 → 写锁 → 后续比对」数据流（均可在 `test-engine-manifest.mjs` 找到对应断言）：

1. **探测**：调用方传入 `probe` 函数，`probeEnvironment` 调它拿 `{version, pythonVersion, pipCheck}`，归一化为 fact，并调用 `fingerprintOf` 生成 16 位 hex 指纹（manifest.js:34-45）。`probe` 这层抽象让本模块保持纯逻辑、可单测（进程 spawn 留在 `client.js`）。

2. **读锁**：`doctor` 调用 `readLock({ repoRoot })`。仓库无 `.codewiki/engine-lock.json` 时返回 `null`（manifest.js:61-75）。

3. **比对**：`compareLock({ current, lock:null })` 返回 `{ status:'absent', diffs:[], current:<fp>, locked:'' }`（manifest.js:86-88）。`doctor` 据此设 `ok:true`（absent/match 视为健康，manifest.js:141）并给 advice「首次运行：确认后写入 engine-lock.json」（manifest.js:157）。

4. **落锁**：上层确认后调 `writeLock({ repoRoot, current })`，以 `manifestVersion / fingerprint / version / pythonVersion / engineRoot / pipCheckOk / recordedAt` 七个字段原子写盘（manifest.js:117-135），返回相对路径 `ENGINE_LOCK_REL`。

5. **复比**：下次 `doctor` 时 `readLock` 读回旧 lock，`compareLock` 逐项比对（manifest.js:86-95）。三分支：
   - 完全一致 → `match`（`ok:true`）。
   - 版本 / Python 变化 → `drift`（`ok:false`，`diffs` 指出具体字段与 locked/current 值）。
   - 指纹一致但 `pipCheckOk !== true` → `unhealthy`（`ok:false`，优先于任何字段 diff，advice 指向 `tools/fsoft-engine/setup-env.sh`）。
   - `probe` 抛错 → `probe-failed`（`ok:false`，advice 含原始错误信息，不向上抛）。

6. **漂移处置**：`status` 为 `drift` / `unhealthy` 时，上层负责决定是否重跑 `setup-env.sh` 并再次 `writeLock` 覆盖；本模块不做修复、不联网（manifest.js:117-118）。

## Connections

- [[engine_contract]] — `lib/engine/contract.js` 定义 `ENGINE_STAGES`（contract.js:24-33），其中 `env` 阶段即「解释器与依赖锁定校验（doctor）」，与本模块的 `doctor` 一一对应；`EngineResult.engine` 字段（contract.js:127-131）承载 doctor 产物供面板展示与回滚取证。
- [[engine_client]] — `lib/engine/client.js` 的 `runEngine({ action })`（client.js:223-229）把 `'doctor'` 列为四种合法动作之一，是本模块 `probe`/`doctor` 在跨进程边界（spawn FSoft 子进程）上的实际触发点；进程管理与 `probe` 注入由这一层完成。
- [[engine_python_stage_map]] — `lib/engine/python/stage_map.py` 注释明确 FSoft 五段进度里 `env` 由 doctor 动作承担（stage_map.py:13），且 `ENGINE_STAGES`（stage_map.py:20-29）必须与 contract.js 完全一致。
- [[engine_output]] — `lib/engine/output.js` 负责 FSoft 产物解析与校验（client 跑完 generate/update 后），与本模块负责的「入口前环境可信性」互补：本模块在 `env` 阶段挡住不可信环境，output 在产物落盘后判自洽。
- `tools/fsoft-engine/setup-env.sh` — `doctor` 在 `unhealthy` 状态给出的修复建议指向此脚本（manifest.js:160）；本模块只读诊断、不修复，修复动作在 1A 阶段脚本里。
- `test-engine-manifest.mjs` — 本模块对应测试，钉死 9 类漂移场景（首次 / 换版本 / 换 Python / 依赖不闭合 / probe 失败 / 坏锁等）。

## Known Issues

- **`fingerprint` 算法变更无法被自动识别为 drift**：`compareLock` 仅在 `version` 与 `pythonVersion` 两项都一致时才补一条 `'fingerprint'` diff（manifest.js:100-103）。若算法调整导致指纹变化但两个输入版本没变，会被正确判成 `fingerprint` diff；但若算法调整恰好让不同输入碰撞，则无法被发现（指纹本质是 sha256 截断 16 位，碰撞概率极低但非零）。

- **`unhealthy` 不携带 version/python 的 diff 证据**：当 `pipCheckOk !== true` 时 `compareLock` 直接 `return { status:'unhealthy', diffs, ... }`（manifest.js:104-106），即使此时 `diffs` 里已有 version/python 的变更也不会改 status。这意味着 `unhealthy` 状态下 `diffs` 可能非空但 status 不反映版本漂移——调用方若只看 `status` 会漏掉版本也变了的事实（测试 test-engine-manifest.mjs:107-112 只验证了 unhealthy 优先，未交叉验证 diffs）。

- **`engineRoot` 仅记录、不参与比对**：`engineRoot` 写进 lock 用于审计（manifest.js:42、127），但 `compareLock` 完全不看它（manifest.js:86-111）。换句话说，引擎源码根换了但版本号相同，会被判 `match`——审计字段不具约束力。

- **`doctor` 的 `probe` 抛错信息直接内联进 advice**：`advice: '引擎探测失败：${err?.message}'`（manifest.js:141）会把底层错误原样暴露给上层/面板，未脱敏，也未归一到契约错误码（对比 contract.js 的 `ENGINE_ERROR_CODES`，engine-manifest 不产出任何 `engine-*` 机读码，只给 status `probe-failed`）。

- **无跨实例锁**：`writeLock` 用 `fs.renameSync` 保证单进程原子写（manifest.js:133），但多个 dsh 实例同时对同一仓库写 lock 时，无文件锁保护（index.js 的 JobService 有 `JOBS_FILE.lock` 串行机制，但 manifest 没有对应机制）；正常 `doctor` 流程下少见并发写，但理论上存在后写覆盖先写的可能。

- **`recordedAt` 每次写都刷新、不保留历史**：lock 文件只存最新一份（manifest.js:129），无法回看历史环境的漂移轨迹，只能与「上一次」比。若需要多版本审计，需另建机制。
