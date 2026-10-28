---
title: client
type: module
source_files:
  - test-engine-client.mjs
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/process-tree.js
tags: [test, fixtures, engine-fake, json-lines, protocol, subprocess, client-adapter]
---

## Overview

`client`（本文所写模块）是 `lib/engine/client.js` 这一**跨语言适配层**的专属测试护栏，代码全部集中在 `test-engine-client.mjs`。它不测业务，而是专钉适配层最危险的那条边界——Node 进程 ↔ 外部引擎进程（多为 Python）之间 JSON-lines 协议的正确性与健壮性。

测试设计哲学（`test-engine-client.mjs:1`–`test-engine-client.mjs:16`）：正常路径有 `test-engine-python-entry.mjs` 借用 `runEngine` 跑真实 venv 兜底，所以这里**优先钉「协议破坏时会发生什么」**而不是「正常能跑通」。理由写在文件头：协议破坏（引擎吐半行 JSON、带别人的 `requestId`、退出码 0 却报 `failed`）一旦被静默吞掉，表现就是「wiki 编译成功但文章没更新」——最坏的那类错。

为此本模块提供两套互锁的测试工具：

- **协议层假引擎（纯函数）**：用 `createProtocolReader` 自己构造的增量读取器逐行 `push`，无需 spawn 任何进程，就能把一个故意破坏的 JSON-lines 序列喂进去、再 `end()` 取结果（`test-engine-client.mjs:37`–`test-engine-client.mjs:155`）。覆盖非 JSON 行、半行截断、未知 `requestId`、缺 `result`、重复 `result`、CRLF、跨 chunk 的多字节中文、`line-too-long`、`ENGINE_PROTOCOL_VERSION` 契约常量等。
- **进程层假引擎（真 spawn）**：在临时目录写一个会按 `FAKE_MODE` 环境变量吐不同协议（含故意破坏）的 `fake_engine.py`（`test-engine-client.mjs:158`–`test-engine-client.mjs:218`），再用 `pyEngine(mode)` / `fakeEngine(mode)` 包装成 `runEngine` 接受的 `{command, args, env, cwd}` 描述（`test-engine-client.mjs:220`–`test-engine-client.mjs:237`），让真实子进程把协议破坏打到 `client.js` 的进程层（`test-engine-client.mjs:243`–`test-engine-client.mjs:360`）。

被测实现侧：`lib/engine/client.js` 的 `createProtocolReader`（行 39）与 `runEngine`（行 223），它们把引擎消息翻译成 `lib/engine/contract.js` 的 `engineResult` / `engineProgress` / `engineError`，并在超时 / 取消 / 崩溃 / 协议破坏时给出可机读失败（错误码来自 `contract.js` 的 `ENGINE_ERROR_CODES`，如 `engine-protocol` / `engine-crashed` / `engine-timeout` / `engine-missing`）。进程树终止依赖 `lib/engine/process-tree.js` 的 `terminateProcessTree`（行 61）。

## Key Components

本模块的全部对外可引用符号都在 `test-engine-client.mjs`，行号以 `read_code` 返回的「行号| 」前缀为准。

### 测试脚手架 / 工具函数

- `check(label, fn)`（行 29–32）—— 统一断言包裹：`try{await fn(); pass++}` 成功打印 `PASS`，失败把 `{label, err}` 压入 `fails` 并打印 `FAIL`，**不因一个用例失败中断整轮**。
- `sleep(ms)`（行 34）—— `new Promise(r=>setTimeout(r, ms))`，用于模拟取消时序。
- `line(obj)`（行 35）—— `JSON.stringify(obj) + '\n'`，构造一行合法协议帧的便捷器，几乎所有协议层用例都靠它拼 payload。
- `pass` / `fails`（行 27–28）—— 全局通过计数与失败收集，末尾 `console.log` 汇总（行 364）并按 `fails.length` 设 `process.exitCode`（行 365）。

### 假引擎：文件 + 包装器

- `tmp`（行 158）—— `mkdtempSync(join(tmpdir(),'fsoft-client-'))`，整轮测试的公用临时目录，末尾 `rmSync(tmp,{recursive:true,force:true})`（行 362）清理。
- `fakePy`（行 159）—— `join(tmp,'fake_engine.py')`，假引擎脚本落盘路径。
- 假引擎脚本内容（行 162–218，用 `writeFileSync` 以 `String.raw` 写入）—— 一个读取环境变量 `FAKE_MODE`（`os.environ.get("FAKE_MODE","ok")`，行 165）的 Python 脚本。它先按行读 `sys.stdin` 取首个带 `action` 的请求、抽出 `requestId`（行 171–183），再按 `FAKE_MODE` 分派：
  - `ok`（行 185–188）：发 `progress`(graph/20%) + `result`(done, writtenCount=1)，`sys.exit(0)`。
  - `garbage`（行 189–192）：先向 stdout 写一行非 JSON 的 `INFO  not json at all\n`，再发合法 `result`，`sys.exit(0)`——专钓「非 JSON 行不污染结果」。
  - `noresult`（行 193–195）：只发 `progress` 后 `sys.exit(0)`，不吐 `result`——退出码 0 但协议破坏。
  - `failed-but-exit0`（行 196–198）：`result` 语义 `failed`(engine-model) 但 `sys.exit(0)`——钓「退出码只表达进程层」。
  - `done-but-exit3`（行 199–201）：`result` 语义 `done` 但 `sys.exit(3)`——钓「语义保留 + nonzero-exit」。
  - `crash`（行 202–204）：向 stderr 写 `Traceback` 后 `sys.exit(7)`，无 `result`——引擎崩溃。
  - `slow`（行 205–209）：发 `progress` 后 `time.sleep(30)`——钓超时。
  - `late`（行 210–214）：`time.sleep(0.6)` 后才发 `result`——钓「取消后 late result 不覆盖」。
  - `wrongid`（行 215–217）：`result` 带 `requestId:"not-my-id"`——未知 `requestId` 隔离。
- `fakeEngine(mode, extra={})`（行 220–233）—— 两层 node 包装：外层 node `-e` spawn 内层 `process.env.FSOFT_TEST_PY || 'python'` 跑 `fakePy`，注入 `env.FAKE_MODE`。注释（行 235–236）说明这是为了在 Windows 上可控地设 `FAKE_MODE`；`command: process.execPath`、`args:['-e', '<spawn 内部脚本>']`、`stdio:['pipe','pipe','pipe']`，并把子进程 stdin/stdout/stderr 透传到父进程，退出码透传（`p.on('exit',c=>process.exit(c??1))`）。
- `pyEngine(mode)`（行 237–241）—— 直接包装：`{ command: process.env.FSOFT_TEST_PY||'python', args:[fakePy], env:{FAKE_MODE:mode} }`。进程层绝大多数用例用它（少数字段如 `cwd` 在中文空格目录用例另行覆盖）。

### 被测实现（被本模块直接 import 与断言）

- `createProtocolReader`（行 39，`lib/engine/client.js`）—— 增量 JSON-lines 读取器。返回 `{ push, get progress, markCancelled, end }`；内部 `handleLine` 负责 `hello`/`progress`/`error`/`result` 分类与违规收集（`not-json`/`bad-shape`/`unknown-request`/`duplicate-result`/`late-result`/`line-too-long`/`protocol-version`/`bad-result`）。`end()` 返回 `{result, progress, errors, violations, cancelled, endedWithResult, ended}`（行 175–183）。
- `runEngine(options)`（行 223，`lib/engine/client.js`）—— 跑一次引擎动作归一成 `EngineResult`。返回对象含 `outcome`/`error`/`protocolViolations`/`exitCode`/`terminated`/`writtenCount` 等（行 258–271）。本模块进程层用例断言它的 `outcome` 与 `error.code`。
- `ENGINE_PROTOCOL_VERSION`（行 27，`lib/engine/client.js`）—— 契约常量 `1`，客户端必须核对引擎 `hello` 报的 `protocolVersion`（行 74–78）。
- `engineResult` / `engineProgress` / `engineError` / `ENGINE_CONTRACT_VERSION`（行 97/150/171/20，`lib/engine/contract.js`）—— 结果归一与语义校验，本模块断言的 `outcome`/`error.code` 都由它们保证。
- `terminateProcessTree`（行 61，`lib/engine/process-tree.js`）—— 超时/取消时打穿整棵进程树，本模块超时/取消用例间接依赖它把 `slow`/`late` 的子进程杀掉（返回 `terminated:true`）。

## Architecture

本模块分两层互不依赖的测试入口，都围绕同一个被测 `client.js`：纯函数协议层（`createProtocolReader` 离线喂流）与真实进程层（`runEngine` 派生 `fake_engine.py`）。

```text
┌──────────────────────────────┐  无进程 · 逐字节 push   ┌────────────────────────────┐
│  协议层用例                   │ ───────────────────────►│  createProtocolReader        │ client.js:39
│  test-engine-client.mjs:37-155│   line(obj)=JSON+'\n'   │  push→handleLine→分类/违规   │
│  （not-json / 半行 / 未知id / │                         │  end()→{result,violations} │
│   dup / crlf / 中文 / 超限）  │                         └────────────────────────────┘
└──────────────────────────────┘

┌──────────────────────────────┐  spawn(python, fakePy)  ┌────────────────────────────┐
│  进程层用例                   │ ───────────────────────►│  fake_engine.py             │ test-engine-client.mjs:162
│  pyEngine(mode)/fakeEngine   │   FAKE_MODE=...          │  按 mode 吐破坏/正常协议    │
│  test-engine-client.mjs:220-241                           │  stdout=JSON-lines          │
└──────────────────────────────┘ ◄── stdout ──────────────└──────────────┬─────────────┘
                                                                          │ 喂给
                                                                          ▼
                                                               ┌────────────────────────────┐
                                                               │  runEngine()               │ client.js:223
                                                               │  spawn + 协议 + 超时/取消   │
                                                               │  → EngineResult(outcome,   │
                                                               │    error.code, violations) │
                                                               └──────────────┬─────────────┘
                                                                              │ 超时/取消
                                                                              ▼
                                                               ┌────────────────────────────┐
                                                               │  terminateProcessTree(pid) │ process-tree.js:61
                                                               │  SIGTERM→SIGKILL / taskkill│
                                                               └────────────────────────────┘
```

## Data Flow

**协议层（纯函数，不 spawn）：**

1. 取 reader：`createProtocolReader({requestId:'req-1'})`（行 40，对应 `client.js:39`），`requestId` 必填。
2. 逐行喂入：用 `line(obj)`（行 35）拼出合法帧，或手敲破坏行（如 `r.push('INFO  loading tree-sitter grammar\n')`，行 55），或直接喂未换行的半截 JSON（行 66）。`push` 按 `\n`(0x0a) 切行、按字节缓冲，UTF-8 跨 chunk 不切坏（行 133–156）。
3. 收尾取结果：`out = r.end()`（行 44），断言 `out.violations` / `out.progress` / `out.result` / `out.endedWithResult` / `out.cancelled`（行 175–183）。
4. 关键断言：非 JSON 行→`violations[0].kind==='not-json'` 且 `result.outcome==='done'` 不丢（行 52–62）；半行截断→`end()` 把残行记 `not-json`、`result===null`（行 64–71）；未知 `requestId`→`unknown-request` 不污染（行 73–90）；缺 `requestId` 也判未知（行 84–90）；重复 `result`→`duplicate-result` 且先到赢（行 92–99）；未登记 type→`bad-shape`（行 101–106）；取消后 result→`late-result`（行 108–116）；CRLF/空行忽略（行 118–127）；多字节中文逐字节喂不切坏（行 129–138）；`maxLineBytes:1024` 下超长行→`line-too-long`（行 140–146）；未登记 `protocolVersion`→`protocol-version`/`bad-shape`（行 148–154）。

**进程层（真 spawn 假引擎）：**

1. 落盘假引擎：`writeFileSync(fakePy, ...String.raw...)`（行 162–218）写出 `fake_engine.py`，读 `FAKE_MODE`。
2. 包装引擎描述：`pyEngine(mode)` → `{command, args:[fakePy], env:{FAKE_MODE:mode}}`（行 237–241）；个别用例用 `fakeEngine` 两层 node 包装（行 220–233）或手拼 `{command, args}` 测命令不存在（行 337–346）。
3. 调 `runEngine({engine: pyEngine(mode), requestId, action, onProgress, timeoutMs})`（行 245 起，对应 `client.js:223`）：
   - `ok`→`outcome:'done'`、`writtenCount:1`、`protocolViolations.length===0`、`onProgress` 收到 1 条 `graph`（行 243–257）。
   - `garbage`→`outcome:'done'` 且 `protocolViolations` 含 `not-json`（行 259–263）。
   - `noresult`→`outcome:'failed'`、`error.code:'engine-protocol'`（退出码 0 也判失败，行 265–269）。
   - `failed-but-exit0`→`outcome:'failed'`、`error.code:'engine-model'`、`exitCode===0`（语义优先，行 271–276）。
   - `done-but-exit3`→`outcome:'done'`、`exitCode===3`、`protocolViolations` 含 `nonzero-exit`（行 278–283）。
   - `crash`→`outcome:'failed'`、`error.code:'engine-crashed'`、`error.message` 匹配 `boom|Traceback`（行 285–290）。
   - `wrongid`→`outcome:'failed'`、`error.code:'engine-protocol'` 且违规含 `unknown-request`（行 292–297）。
   - `slow`→超时 `engine-timeout`、进程树 `terminated:true`、总耗时 < 10s（行 299–307）。
   - `late`→`AbortController` 300ms 后 `abort()`，`outcome:'cancelled'`、`writtenCount===0`、违规含 `late-result`/`engine-cancelled`（行 309–324）。
   - 连续调用 `ok`/`failed-but-exit0`/`ok` 互不串结果（行 326–335）。
   - 命令不存在→`engine-missing`（行 337–346）。
   - `cwd` 含中文与空格→仍 `outcome:'done'`（行 348–360）。
4. 末尾 `rmSync(tmp,{recursive:true,force:true})` 清理（行 362），`console.log` 汇总并通过 `process.exitCode` 报失败（行 364–365）。

## Connections

- [[engine_client_proc]] —— 本文所测的被测实现就是它：`lib/engine/client.js` 的 `createProtocolReader`（行 39）与 `runEngine`（行 223），以及 `lib/engine/process-tree.js` 的 `terminateProcessTree`（行 61）。`engine_client_proc.md` 从实现视角写职责边界与协议不变量，本文从测试护栏视角写「怎么钉住这些不变量」。
- [[engine_contract]] —— 被测 `client.js` 直接消费 `contract.js` 的 `engineResult`/`engineProgress`/`engineError`/`ENGINE_CONTRACT_VERSION`（行 23）；本模块断言的 `outcome`/`error.code`（如 `engine-protocol`/`engine-crashed`/`engine-timeout`/`engine-missing`/`engine-model`）都是 `contract.js` 的 `ENGINE_ERROR_CODES`（行 57–67）与 `TERMINAL_OUTCOMES`（行 35）。
- [[engine_fixtures]] —— 同一类「围绕引擎的固定基准 + 探针」资产；其中 `test-engine-python-entry.mjs` 也经 `runEngine` 跑真 venv 的 `doctor`，与本模块的假引擎互为补充（真引擎正常路径 vs 假引擎破坏路径）。本文假引擎的 `fake_engine.py` + `FAKE_MODE` 模式与该模块的真产物探针是两条不同测试线。
- [[engine_python_entry]] —— `fake_engine.py` 模拟的正是 `lib/engine/python/entry.py` 的 JSON-lines 协议（`hello`/`progress`/`result`），只是刻意制造各 `FAKE_MODE` 的破坏分支；真实入口的行为由 `engine_python_entry.md` 覆盖。
- [[test-engine-process-tree]] —— `terminateProcessTree` 的专属测试；本模块的超时/取消用例（`slow`/`late`）间接依赖它把子进程树杀掉，二者共同保证「取消/超时后无孤儿进程」。

## Known Issues

- **假引擎只覆盖协议面，不覆盖真实环境面**：`fake_engine.py`（行 162–218）是手搓的极简 Python，不读 `engine.py` 的任何凭证/venv/模型通道，只验证 `client.js` 对 stdout 协议的解析与进程层判定。真实 `doctor` 上报的版本/锁定信息、凭证不泄露等环境面由 `test-engine-python-entry.mjs` 覆盖——两套测试若不同步，可能出现「假引擎过了但真引擎协议变了」漏测。
- **`fakeEngine` 两层 node 包装未被进程层用例实际使用**：`fakeEngine(mode, extra)`（行 220–233）注释声称用于 Windows 注入 `FAKE_MODE`，但进程层所有断言都直接调 `pyEngine(mode)`（行 237 起），`fakeEngine` 在文件里构造出来却**零调用**（未被 `await check` 引用）。属于冗余/预留代码，可能误导读者以为它被用到。
- **`FAKE_MODE` 崩溃未发 `error` 帧**：`crash`（行 202–204）只向 stderr 写 `Traceback` 并 `sys.exit(7)`，不发任何 `result`/`error` json 行。因此 `client.js` 据此判 `engine-crashed`（行 285–290）。这是有意模拟「引擎崩了连错误帧都没来得及发」，但如果有人误以为引擎崩溃都会发 `error` 帧，会误解 `error` 类型（行 98–102）的触发路径。
- **超时判定依赖 10s 兜底但不是硬失败边界**：`slow` 用例断言 `ms < 10000`（行 305），`runEngine` 超时后还会 `Promise.race([exited, setTimeout(5000)])` 等进程树退出（行 370）。若机器极慢，5s 宽限内 `slow` 的 `time.sleep(30)` 没被树杀掉，该用例可能误报失败——而非测试逻辑问题。
- **`late` 用例时序脆弱**：`late` 模式 `sleep(0.6)` 后发 result（行 212–213），测试在 300ms 后 `abort()`（行 318–319）。若宿主调度把 `sleep` 提前或 `abort` 延迟到 result 之后，会误判 `late-result` 未生效。时序断言本身脆弱，CI 抖动时偶发不稳定。
- **功能禁用 / 注释**：本模块无被禁用或注释掉的功能分支；9 个 `FAKE_MODE`（`ok`/`garbage`/`noresult`/`failed-but-exit0`/`done-but-exit3`/`crash`/`slow`/`late`/`wrongid`）均被进程层 `await check` 各用一次（行 243–360）。`maxLineBytes` 上限、`ENGINE_PROTOCOL_VERSION` 契约常量校验等也在协议层显式断言（行 140–154）。
