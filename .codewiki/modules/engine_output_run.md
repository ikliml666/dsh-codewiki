---
title: engine_output_run
type: module
source_files:
  - lib/engine/output.js
  - lib/engine/native-run.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/native-state.js
  - lib/engine/client.js
  - test-engine-output.mjs
  - test-engine-output-real.mjs
  - test-engine-native-job.mjs
tags: [engine, output, validation, native-run, orchestration, incremental]
---

## Overview

`engine_output_run` 是 CodeWiki 原生引擎（FSoft / `lib/engine/`）的「产物处置 + 原生编译编排」模块，横跨两个源文件：

- `lib/engine/output.js` —— 阶段 2：**产物解析、校验与写集映射**。把引擎吐出的 `docs/` 目录读成结构化事实（页清单 + 四个 JSON），交给 `mapping.js` 翻成 cw 的写集，再逐条判定「产物自身是否自洽」（页在不在、正文空不空、链接指的东西在不在计划内、source_files 是不是真文件）。坏输入变成可机读的 `problems`，绝不抛异常、绝不静默吞掉缺页。
- `lib/engine/native-run.js` —— 阶段 4/5：**一次原生编译的「完整编译」编排（生产通道）**。把一次编译的裁决链固定成一条直线，每一步结论都不能被下一步洗白：`env(doctor + engine-lock) → 增量决议(change-set + 受管状态) → 水合 docs → 引擎(generate|update) → 质量门 → 落地器(index/baseline/commit)`。

这个模块刻意**只做这几件事**，且每件事都被测试逐条钉死（见 `test-engine-output.mjs`、`test-engine-native-job.mjs`、`test-engine-output-real.mjs`）：

1. 读产物 / 校验 / 映射 —— `output.js` 只判「产物自身是否自洽」，不重写文章正文、不重新聚类、不改写 frontmatter（那属于阶段 3 的质量门 `quality-gate.js`）。
2. 编排原生编译 —— `native-run.js` 只做裁决链接线与终态合成，所有具体能力（环境探测、引擎进程、质量门、落地器、增量决议）全部依赖注入；缺一项就由真实实现补齐。

硬不变量（与 `contract.js` / `quality-gate.js` / `apply-plan.js` 叠加）：

- 锁不一致 / 依赖不闭合 → 直接 `failed`，**不跑引擎**（跑出来的产物不可信）。
- 引擎 `done` **不能**替代质量门：`gate` 说 `partial`，终态就是 `partial`。
- 落地器（apply）说 `partial/failed`，终态不许是 `done`：产物没入库就是没交付。
- `partial/failed/cancelled` 一律不推进基线（`canAdvanceBaseline=false`）。
- 取消是终态：取消后不再 gate/apply，也不覆盖已写好的终态。

## Key Components

### `lib/engine/output.js`

| 导出 | 行号 | 用途 |
| --- | --- | --- |
| `OUTPUT_PROBLEM_KINDS` | `22|` | 冻结的问题类别枚举：`missing-docs-dir` / `missing-metadata` / `missing-module-tree` / `empty-module-tree` / `bad-json` / `entry-missing` / `empty-body` / `article-missing` / `unmapped-page` / `source-missing` / `dead-link`。上层按 `kind` 分派，不靠 message 文本匹配。 |
| `collectOutput({ docsDir })` | `91|` | **只读、不抛**。读 `docs/` 目录，产出结构化事实 `{ docsDir, exists, pages, json, problems }`（`json` 含 `metadata` / `moduleTree` / `firstModuleTree` / `updateRecord`）。坏文件变成 `problems` 而非异常。 |
| `bodyLength(text)` | `127|` | 去掉标题行与空白后剩余正文字符数，用来判「这页其实只有个标题」。 |
| `relativeLinks(text)` | `140|` | 收集正文里的相对 markdown 链接目标，跳过外链（`http:`/`mailto:`/`data:`…）、锚点（`#`）、图片 data URI。 |
| `buildWritePlan({ docsDir, componentFiles, overviewName })` | `162|` | 读 docs → 交给 `mapFsoftOutput`（来自 `mapping.js`）建写集计划，返回 `{ collected, mapped }`。 |
| `validateOutput({ docsDir, repoRoot, componentFiles, overviewName })` | `184|` | **校验产物自洽性，不抛、不修任何东西**。返回 `{ ok, problems, mapped, collected, stats }`。`stats = { pages, articles, unmapped, problems }`。 |
| `listMarkdownPages(rootDir, rel)` | `44|` | 递归收集 docs 下所有 markdown 页（POSIX 相对路径、已排序），跳过 `temp/` 与隐藏目录。 |
| `readJsonIfExists(file, problems, kind, { optional })` | `64|` | 读 JSON，存在但坏了永远报 `bad-json`；可选文件（`update_record.json` / `first_module_tree.json`）缺失不算问题。 |
| `emptyStats()` | `284|` | 返回 `{ pages:0, articles:0, unmapped:0, problems:0 }`。 |
| `posix` / `stripBom` | `38|` / `39|` | 路径归一化与去 BOM 工具函数。 |

`validateOutput` 的校验步骤（按 `output.js` 顺序）：

1. 入口缺失 → `entry-missing`（`197|`）；`empty-module-tree` 当 `module_tree.json` 为空对象且有 >1 页时上报（`204|`）。
2. 每篇文章正文非空，否则 `empty-body`（带 `source`，`224|`）。
3. `mapped.unmapped` 每条 → `unmapped-page`（带 `source`，`228|`）。
4. `mapped.warnings` 中匹配「未产出」的 → 升级为 `article-missing`（`232|`）。
5. `repoRoot` 给定时，逐条核对 `source_files` 真实存在，否则 `source-missing`（带 `source`/`target`，`241|`）。
6. 死链：只查指向 docs 内的相对 `.md` 链接，目标既不在计划内也不在 docs 里 → `dead-link`（带 `source`/`target`，`262|`）。指向 `../` 仓库源文件的链接不在此层判（交给阶段 3）。

注意：`validateOutput` 的 `push` 在 `188|` 处强制 `kind ∈ OUTPUT_PROBLEM_KINDS`，未登记的类别会抛错（防止自由发挥）。

### `lib/engine/native-run.js`

| 导出 / 常量 | 行号 | 用途 |
| --- | --- | --- |
| `DEFAULT_ENGINE_ENTRY` | `56|` | 引擎 Python 入口：`lib/engine/python/entry.py`。 |
| `DEFAULT_UPDATE_OPTIONS` | `66|` | 冻结的增量参数 `{ rung: '3' }`（组件级方法，图 diff 决定哪些模块重写）。必须显式给 3 而不是留空，避免引擎内部默认值被静默改变语义。 |
| `DEFAULT_ENGINE_TIMEOUT_MS` | `70|` | 单次引擎超时 `45 * 60 * 1000`（45 分钟）。超时由引擎侧进程树终止兜底。 |
| `runNativeJob({ repoRoot, scope, kind, requestId, signal, timeoutMs, requireCommittedInput, docsDir, deps, onProgress, onLog })` | `109|` | **核心导出**：跑一次原生编译并给出**严格**终态。详见下文架构。 |

`runNativeJob` 内部关键成员：

- `RANK` / `weakest(a, b)`（`73|` / `74|`）：终态强弱排序 `cancelled < failed < partial < done`，合成终态只取最弱一环。
- `settle(patch)`（`140|`）：统一出口，所有分支都必须经过。调用 `engineResult` 做硬不变量校验（done 不许带 blockers、partial 必须带、failed 必须带 error），并附加 `requestId` / `canAdvanceBaseline` / `artifacts` / `incremental` / `gate` / `apply` / `engineLock` / `notes` 等现场证据。
- `applyBlockersOf(applyRes)`（`88|`）：把 apply/gate 结论翻成契约 blockers（`kind` 必须来自 `contract.js` 的 `BLOCKER_KINDS`）。
- `RESOLUTION`（`85|`）：增量决议结论枚举 `FULL`/`UPDATE`，写进结果让上层与测试都能看到「为什么走了这条路」。
- `inc`（`139|`）：增量现场证据对象（决议 / 变化集 / 水合 / 受管状态），所有分支都带，失败时也能看出「这一轮本来打算增量、卡在哪一步」。

`runNativeJob` 依赖注入清单（全部经 `deps` 传入，缺省走真实实现）：

- `doctor`（→ `manifest.js` 的 `realDoctor`）、`runEngine`（→ `client.js` 的 `realRunEngine`）、`gate`（→ `quality-gate.js` 的 `realGate`）、`apply`（→ `apply-plan.js` 的 `realApply`）、`bridge`（→ `llm-bridge.js` 的 `realBridge`）、`writeLock`（→ `manifest.js` 的 `writeLock`）、`probe`、`engineFor`、`collectChangeSet`（→ `change-set.js` 的 `realCollectChangeSet`）、`config`、`llm`。

返回对象形状（经 `settle` 归一后）：`{ ...engineResult 字段, requestId, canAdvanceBaseline, artifacts, incremental, gate, apply, engineLock, notes }`，其中：

- `incremental`（`168|`）：含 `resolution` / `requestedScope` / `explicitFull` / `baseCommit` / `headCommit` / `changeSetState` / `changeSetOk` / `changes` / `changeCount` / `unconsumed` / `consumedNow` / `carried` / `hydrated` / `stateMissing` / `fallbackReason` / `updateOutcome` / `stateDir`。
- `gate`（`713|`）：含 `outcome` / `writable` / `canAdvanceBaseline` / `counts` / `articles[]`（逐篇明细 `wikiPath`/`source`/`type`/`action`/`defects`/`degradations`）。
- `apply`（`731|`）：含 `outcome` / `applied` / `rolledBack` / `written` / `index` / `baseline` / `commit`。

## Architecture

`engine_output_run` 是「产物处置」与「编译编排」两段，前者是纯函数层（可被单测逐条钉），后者是依赖注入的编排层（生产接线由 `index.js` 注入真实实现）。框图只画生产主链路与裁决短路：

```text
                ┌──────────────────────────── runNativeJob (native-run.js:109) ───────────────────────────┐
                │                                                                                            │
   deps.config  │  1) env       doctor+lock (manifest.js)                                                    │
   ┌────────┐   │       │ probeError / lockStatus : probe-failed│drift│unhealthy│absent                     │
   │ change │   │       ▼ 任一非一致 → settle(failed)，不跑引擎                                   ▲         │
   │ -set.js│──►│  1.5) 增量决议  native-state.js: readState/mergeUnconsumed/isUpdateEligible            │
   └────────┘   │       │  eligible → UPDATE(hydrateDocsDir) │ 否则 FULL + fallbackReason                  │
                │       ▼                                                                                   │
   deps.llm     │  2) 模型桥   llm-bridge.js: startLlmBridge (占位 key 不进日志)                            │
   ┌────────┐   │       ▼                                                                                   │
   │output  │   │  引擎        runEngine(client.js) → doctor|generate|update                               │
   │ .js    │──►│       outcome: cancelled/failed → settle 短路 (不进 gate/apply)                          │
   │mapping │   │       ▼ outcome=done 且给出 docsDir                                                      │
   │ .js    │   │  3) 质量门   quality-gate.js: gateNativeOutput（复用 validateOutput）                   │
   │        │   │       ▼                                                                                   │
   │        │   │  3.5) 受管状态  native-state.js: captureDocsDir/buildStatePayload（与文章同批）          │
   │        │   │       ▼                                                                                   │
   │        │   │  4) 落地器   apply-plan.js: applyNativeOutput（写盘→index→baseline→commit，失败回滚） │
   │        │   │       ▼                                                                                   │
   │        │   │  5) 合成终态  weakest(engine, gate, apply) → done/partial/failed/cancelled              │
   └────────┘   │       └→ canAdvanceBaseline = (outcome==='done')；partial/failed 不推进基线              │
                └────────────────────────────────────────────────────────────────────────────────────────┘

  output.js（阶段2）独立入口： collectOutput → buildWritePlan → validateOutput
        validateOutput 把可机读 problems 交给 quality-gate.js（阶段3）复用
```

要点（对应 `native-run.js` 文件头注释）：

- 裁决链是直线，每步结论不能被下一步洗白：env 失败不让引擎跑；引擎 done 不能替代质量门；apply 说 partial/failed 终态不许 done。
- 取消是终态：在 env/validate/index 各检查点（176、279、517、622 行）遇 `signal?.aborted` 立即 `settle({ outcome:'cancelled' })`，且迟到结果不能覆盖已写终态。
- 增量决议排在 env 之后、引擎之前（283| 起）：由证据（四路变化 + 受管状态 + 基线可达性）决定 FULL/UPDATE，而不是由调用方的 `kind` 字面量决定。

## Data Flow

## Connections

## Known Issues
