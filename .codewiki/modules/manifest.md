---
title: manifest
type: module
source_files:
  - lib/engine/manifest.js
  - test-engine-manifest.mjs
  - lib/engine/client.js
  - lib/engine/python/entry.py
  - tools/fsoft-engine/probe-generate-with-fake-model.mjs
tags: [manifest, engine-lock, fingerprint, doctor, testing, fake-probe]
---

## Overview

`manifest` 模块是引擎（FSoft）环境可信性的**只读诊断层**，回答「现在跑的是哪个引擎、哪个环境」。
它对应 `lib/engine/manifest.js`，核心职责只有三件（见文件头注释 1–13 行）：

1. **指纹（fingerprint）**：读引擎版本 + Python 版本，算一个稳定的短 hash；
2. **比对（compare）**：把当前指纹与落盘的 lock 比，不一致就明确说哪一项不一致；
3. **落盘（writeLock）**：把指纹写到 `.codewiki/engine-lock.json`，供下次比对与审计。

模块刻意**不**装依赖、不修环境、不联网——`doctor` 是只读诊断，报告事实，由上层决定要不要重新 `setup`（那是 `tools/fsoft-engine/setup-env.sh` 的职责）。

本模块的设计关键点是**依赖注入式探测**：`probeEnvironment` 不在这里 spawn 进程，而是由调用方传入一个 `probe` 函数（manifest.js 27–29 行）。这层因此保持纯函数、可单测，进程管理留给 `lib/engine/client.js` 与 `lib/engine/python/entry.py`。测试侧要验证各种漂移场景，就靠**假的 probe（fake probe）**——也就是本文的重点：一组返回预设 `{version, pythonVersion, pipCheck}` 的工厂函数，让 manifest 逻辑在完全不启动 Python 的情况下被穷尽测试。

模块对外的 8 个公开符号（含两个常量）全部在 manifest.js 172–181 行的 default 导出里列出，测试文件 `test-engine-manifest.mjs` 从 10–19 行把它们全部 import 进来逐条断言。

## Key Components

### 公开常量（manifest.js）

- `MANIFEST_VERSION` — 19 行，清单 schema 版本号，目前恒为 `1`。指纹与落盘内容都把它写进前缀/字段（`manifest:${MANIFEST_VERSION}` 见 fingerprintOf 52 行；`manifestVersion` 见 writeLock 123 行）。
- `ENGINE_LOCK_REL` — 20 行，lock 文件的相对路径常量，值为 `.codewiki/engine-lock.json`。`readLock`、`writeLock` 都据此拼绝对路径，测试在 74、121 行也用它断言返回值。

### 公开函数（manifest.js）

- `probeEnvironment({ probe, engineRoot })` — 34–45 行。调用 `probe()` 拿原始事实 `{version, pythonVersion, pipCheck:{ok,output}}`，归一化成 `facts`（`version`、`pythonVersion`、`pipCheckOk`、`pipCheckOutput`、`engineRoot`），并附上 `fingerprint`（由 `fingerprintOf(facts)` 算出）。`probe` 不是函数直接抛 `需要 probe 函数`（35 行）。`engineRoot` 仅记录用于审计，会用 `posix()` 归一化（22、42 行）。
- `fingerprintOf(facts)` — 50–56 行。对 `manifest:<ver>\nversion:<v>\npython:<py>\n` 三段做 sha256，取前 16 位 hex。注意 **pip check 状态不进指纹**（47–49 行注释）：依赖闭合是「能不能跑」的闸门，不是「产物会是什么」的输入，把它算进指纹会让每次修依赖都像换了引擎。
- `readLock({ repoRoot })` — 61–75 行。读 `.codewiki/engine-lock.json`。**不存在 / 坏 JSON / 解析出来不是对象都返回 `null`**（不是错误，首次运行本来没有 lock）。会先去掉可能的 BOM（`\uFEFF`，70 行）。
- `compareLock({ current, lock })` — 86–111 行。比对当前指纹与 lock，返回**可机读的差异项**（不抛错、不返回布尔）。`current` 缺失直接抛 `需要 current 指纹`（87 行）。`status` 取值与含义见下；`diffs` 是 `{field, locked, current}` 数组。
- `writeLock({ repoRoot, current })` — 117–135 行。把当前环境事实写成 lock，**原子写**（先写 `*.${pid}.tmp` 再 `renameSync`，避免半截文件，131–133 行）。`repoRoot` 或带 `fingerprint` 的 `current` 缺失直接抛（118–119 行）。落盘 body 字段见下。
- `doctor({ probe, repoRoot, engineRoot })` — 141–170 行。一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出来，**不抛**（probe 抛错变成 `ok:false, status:'probe-failed'`，144–153 行）。返回 `{ok, status, current, diffs, advice}`。

### `compareLock` 的状态机（`status` 取值）

| status | 触发条件 | 含义 |
| --- | --- | --- |
| `absent` | `lock` 为 null（无 lock） | 首次运行，需要写一份 |
| `match` | 版本/Python 全一致且 pip 健康 | 环境与上次一致 |
| `drift` | `version` 或 `pythonVersion` 变了 | 产物可能不同，必须让上层知道 |
| `unhealthy` | 指纹一致但 `pipCheckOk !== true` | 能跑但不可信（依赖未闭合） |
| `fingerprint` 异项 | 前两项一致但指纹不同 | 说明指纹算法变了（仅在 `diffs` 里追加，102 行） |

注意优先级：`unhealthy` 优先于 `drift`——即使版本一致，只要 `pipCheckOk !== true` 就先判 `unhealthy`（104–106 行）；`doctor` 的 `ok` 只在 `match` / `absent` 时为 `true`（164 行）。

### `writeLock` 落盘 body 字段（122–130 行）

- `manifestVersion`：常量 `MANIFEST_VERSION`；
- `fingerprint`：`current.fingerprint`；
- `version` / `pythonVersion` / `engineRoot`：字符串化；
- `pipCheckOk`：布尔（`current.pipCheckOk === true`）；
- `recordedAt`：**自动生成字段**，写入时刻的 `new Date().toISOString()`（129 行）。

### `doctor` 返回的 `advice` 映射（156–162 行）

按 `cmp.status` 取建议文案：`absent`→「首次运行…」，`match`→「环境与上次一致」，`drift`→「引擎或 Python 版本变化…」，`unhealthy`→「依赖不闭合…先用 tools/fsoft-engine/setup-env.sh 修复环境」，`probe-failed`→「引擎不可用…」。测试在 182 行断言 unhealthy 的 advice 必须匹配 `setup-env\.sh`。

### 测试辅助：fake probe（`test-engine-manifest.mjs`）

- `fakeProbe(over = {})` — 29–34 行。返回一个 `async () => ({...})`，默认产出 `{version:'2.0.0', pythonVersion:'3.12.10', pipCheck:{ok:true, output:'No broken requirements found.'}}`，再用 `over` 覆盖。这是整个测试套件唯一用的 `probe` 来源，所有 `probeEnvironment` / `doctor` 用例都通过它注入预设事实，无需启动 Python：
  - 30–32 行默认三件套；
  - 166 行 `fakeProbe({ version: '2.1.0' })` 制造版本漂移；
  - 177 行 `fakeProbe({ pipCheck: { ok:false, output:'codewiki 2.0.0 requires mermaid-parser-py' } })` 制造依赖不闭合；
  - 186 行直接传 `async () => { throw new Error('ENOENT python') }` 制造 probe 失败（不经过 `fakeProbe` 工厂）。
- `check(label, fn)` — 23–26 行。测试运行器：try/catch 包住每个用例，`pass++` 或把失败收集进 `fails`，并打印 `PASS/FAIL`。
- `root` — 28 行。用 `mkdtempSync(join(tmpdir(),'fsoft-manifest-'))` 建的临时根，每个用例在它下面建子目录（如 `no-lock`、`bad-lock`、`doc-drift` 等），最后 192 行 `rmSync(root,{recursive:true,force:true})` 清理。

## Architecture

## Data Flow

## Connections

## Known Issues
