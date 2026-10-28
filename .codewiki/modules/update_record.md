---
title: update_record
type: module
source_files:
  - lib/update-record.js
  - test-update-record.mjs
  - lib/change-set.js
  - lib/update-planner.js
  - index.js
tags: [update-record, judge-outcome, baseline, audit, terminal-state]
---

## Overview

`update_record` 模块（`lib/update-record.js`）负责把「一次 CodeWiki 编译到底做了什么、为什么」落成一份**可机读、可复盘**的 JSON 记录，并负责判定编译的终态（`done` / `partial` / `failed` / `cancelled`）以及「能不能推进编译基线」。

代码顶部的背景缺陷（审计确认，见 `lib/update-record.js:1-12`）：旧实现编译结束只留 `writtenCount` / `failedCount` 两个数字，job 文件里塞的是整张图与任务快照。于是「为什么这篇没重写」「哪几个变更没人管」事后无法复盘，面板也只能显示一句「完成」——而实际上可能 1 篇成功、19 篇失败。本模块就是为了把这条缺陷钉死：

- 把 `ChangeSet`（`lib/change-set.js`）+ `UpdatePlan`（`lib/update-planner.js`）+ 逐篇结果收成一份「版本化记录」；
- 判定终态，并把「完整性不成立」的每一种情形写进 `blockers`（缺页、逐篇失败、未映射变更、缺 source_files、质量闸门、索引、调用方硬阻塞）；
- 明确回答「能不能推进编译基线」——只有完整成功（`done`）才可以前移。

模块设计是**纯函数 + 两个 IO 助手**，便于单测（见 `test-update-record.mjs`）。核心判定逻辑 `judgeOutcome` 不碰文件系统，落盘/回读由 `saveUpdateRecord` / `loadUpdateRecord` 负责，且允许注入 `fsImpl` 便于测试。

关键语义（见 `lib/update-record.js:20-24`）：本次融合新增 `partial` 三态——
- `done`：完整成功——计划内必需文章全部写好、变更全部有归属、质量闸门全过；
- `partial`：部分完成——已成功的文章可以入库，但「全部已消化」不成立，**基线不得前移**；
- `failed`：失败——没有可交付的成果（0 篇成功，或硬性前置条件缺失）；
- `cancelled`：任务被取消，也是终态之一。

## Key Components

本模块全部导出成员如下，`lib/update-record.js`：

### 常量

- `UPDATE_RECORD_VERSION`（第 17 行）：记录格式版本号，当前为 `1`。`loadUpdateRecord` 用它做版本校验，版本不符直接返回 `null`。
- `UPDATE_RECORD_REL`（第 18 行）：记录相对 wiki 根的路径字符串 `'temp/update-record.json'`，配合 `recordPath` 拼出绝对路径。
- `TERMINAL`（第 24 行）：`Set(['done', 'partial', 'failed', 'cancelled'])`，终态集合（含 `cancelled`）。
- `isTerminalStage(stage)`（第 26-28 行）：判断某 `stage` 是否为终态，内部 `TERMINAL.has(String(stage ?? ''))`。注意 `null` / `undefined` 会归一为 `''`，因此返回 `false`。

### 终态判定

- `judgeOutcome({ plan = null, results = [], options = {} } = {})`（第 37-128 行）：纯函数，从逐篇结果与计划算出终态。入参：
  - `plan`：`planUpdate` 的产物（可为 `null`——full 编译没有增量计划）；
  - `results`：`[{ name, ok, error? }]` 逐篇落盘结果；
  - `options`：`{ expectedNames, qualityIssues: [{name, issue}], indexOk, cancelled, extraBlockers }`；其中 `expectedNames` 是 full 编译（无 plan）时判缺页的任务清单。
  - 返回 `{ outcome, blockers, canAdvanceBaseline, writtenCount, failedCount }`。
  - 内部判定顺序（第 41-117 行）：
    1. 先抽 `okNames` / `failed`（第 41-45 行），`failed` 中错误取 `error ?? stopReason ?? '未知原因'` 并截断 300 字；
    2. 若 `options.cancelled` 为真，直接返回 `outcome: 'cancelled'`、`canAdvanceBaseline: false`（第 46-54 行）；
    3. 计划内必需文章：从 `plan.requiredNames`（第 57 行）、`plan.actions` 中 `action==='write'` 的项（第 58 行）分别找**缺页**（`missing`，计划要求写但没成功也没失败记录）与**必需缺失**（`requiredMissing`，见第 64 行），各记 `missing-article` blocker（第 65-69 行）。无 plan 通道用 `options.expectedNames` 判缺页（第 71-75 行）；
    4. 逐篇失败记 `article-failed` blocker（第 78 行）；
    5. 未映射源码变更 `unmappedChanges`：只算源码变更——非源码文件（`.md` 结尾）不计入，否则正常增量会永远落 `partial`（第 83-91 行）；若 `plan.missingSources` 非空记 `missing-sources` blocker（第 92-97 行）；
    6. 质量闸门 `qualityIssues` 记 `quality` blocker（第 100-102 行）；
    7. 索引/入口完整性 `options.indexOk === false` 记 `index` blocker（第 105 行）；
    8. 调用方补充的硬阻塞 `options.extraBlockers` 记 `extra` 或原 `kind` blocker（第 108-110 行）。
  - 终态推导（第 112-118 行）：`writtenCount = okNames.size`；`nothingDelivered = writtenCount === 0 && (failed.length > 0 || missing.length > 0 || blockers.length > 0)`；`outcome = (无任何 blocker 且 failed/missing/requiredMissing 都为空) ? 'done' : (nothingDelivered ? 'failed' : 'partial')`。
  - 基线规则（第 124 行）：`canAdvanceBaseline = outcome === 'done' && blockers.length === 0`——任何 blocker 都意味着没消化完。

### 记录组装

- `buildUpdateRecord({ jobId, scope, changeSet, plan, results, outcome, wikiPath, qualityIssues, notes, startedAt, finishedAt })`（第 131-211 行）：组装可序列化记录。**只存路径与摘要，不塞整图**（测试见 `test-update-record.mjs:179-185`：记录里不能有 `graph` / `tasks` 字段）。其中：
  - `outcome` 若未显式传入，则调 `judgeOutcome` 现判（第 144 行，`buildUpdateRecord` 接受 `outcome` 为已判定的对象或 `null`）；
  - `finishedAt` 默认 `new Date().toISOString()`（第 142 行），`startedAt` 默认 `null`；
  - `changeSet` 子结构（第 153-169 行）含 `state/ok/fallback/reason`、`counts`（committed/staged/unstaged/untracked/deleted/renamed/ignored 各计数）、`sourceChanges`、`ignored`；字段来源是 `lib/change-set.js` 的 `collectChangeSet` 产物；
  - `plan` 子结构（第 170-195 行）含 `version/fileLevel/needsFull/fullReason/summary/counts` 及 `changedComponents/cosmeticComponents/structuralComponents`、`actions`（每个 action 必带 `reason` 与 `sources/changedComponents/impactedBy/newFiles/staleIssues`，见第 181-190 行）、`unmappedChanges/routedTo/missingSources/warnings`；
  - `results` 子结构（第 196-201 行）含 `name/ok/stopReason/error`（`error` 截断 300 字）；
  - `qualityIssues`（第 202 行）`name/issue` 截断 300 字；`notes` 只保留最近 20 条（第 208 行）；
  - 末尾写 `outcome/blockers/canAdvanceBaseline/writtenCount/failedCount`（第 203-209 行），以及 `wikiPath`。

### IO 助手

- `recordPath(wikiPath)`（第 213-215 行）：`path.join(wikiPath, ...UPDATE_RECORD_REL.split('/'))`，拼出记录绝对路径。
- `saveUpdateRecord(wikiPath, record, fsImpl = fs)`（第 217-227 行）：落盘助手。无 `wikiPath` 返回 `{ ok: false, reason: '没有 wiki 路径' }`（第 218 行）；否则 `mkdirSync(..., { recursive: true })` 后 `writeFileSync` JSON（末尾带 `\n`），成功返回 `{ ok: true, path }`，失败捕获后返回 `{ ok: false, reason }`（截断 200 字）。`fsImpl` 可注入，便于测试。
- `loadUpdateRecord(wikiPath, fsImpl = fs)`（第 229-238 行）：回读助手。读文件、解析，若 `rec.version !== UPDATE_RECORD_VERSION` 返回 `null`（版本不符不认，见 `test-update-record.mjs:199-204`），否则返回记录对象；任何读/解析异常返回 `null`。

### 文案

- `describeOutcome(outcome, blockers = [])`（第 241-253 行）：面板/工具文案，三态（加 `cancelled`）一眼能分：`done` → `完成（所有变化已消化）`；`partial` → `部分完成（N 项未满足：首个 blocker 详情）`；`cancelled` → `已取消`；`failed` → `失败（首个 blocker 详情）`；其它返回原字符串或 `未知`。

## Architecture

本模块由「纯函数判定 + 序列化组装 + IO 落盘/回读 + 文案」四类组件构成，输入来自上游 `change-set`、`update-planner` 与 tick 流水线收集的逐篇结果。

```text
┌──────────────────────────────────────────────────────────────┐
│ 上游输入                                                        │
│  ChangeSet        UpdatePlan        results[]       options    │
│  (change-set.js)  (update-planner)  (逐篇落盘)      (期望页/质量)│
└───────┬──────────────────┬───────────────┬──────────────┬────┘
        │                  │               │              │
        ▼                  ▼               ▼              ▼
┌───────────────┐  ┌──────────────────────────────────────────┐
│ judgeOutcome  │  │ buildUpdateRecord                        │
│ (lib/update-   │  │  (version/jobId/scope/changeSet/plan/    │
│  record.js:37) │  │   results/qualityIssues/notes)          │
│ 纯函数判定     │  │  → 版本化 JSON（不含整图）               │
│ blockers/终态  │  └──────────────────┬───────────────────────┘
└───────┬───────┘                     │
        │ outcome 复用        ┌────────▼────────┐
        └──────────────────► │ saveUpdateRecord │ (fsImpl 可注入)
                             └────────┬────────┘
                                      ▼
                      .codewiki/temp/update-record.json
                                      │
                             ┌────────▼────────┐
                             │ loadUpdateRecord │ (版本校验≠版本→null)
                             └─────────────────┘

   describeOutcome(outcome, blockers) ──► 面板/工具文案
```

- `judgeOutcome`（第 37 行）是纯判定核心，被 `buildUpdateRecord` 在 `outcome` 未显式传入时复用（第 144 行），也在 `index.js` 的 `tickIndex` 里单独调用（见 `index.js:3614-3623`）做基线闸门判定。
- `buildUpdateRecord` 的输出不含整图/任务快照（测试 `test-update-record.mjs:179-185` 断言记录里没有 `graph` / `tasks`），避免 job 文件膨胀。
- 落盘/回读（第 217-238 行）通过 `fsImpl` 注入实现 IO 可测。

## Data Flow

一次增量编译的终态判定与记录落盘，数据流如下（以 `index.js` 的 `tickIndex` 为主干）：

1. **准备输入**：`tickIndex` 在索引/基线推进前，先用 `judgeOutcome` 问一句「这次编译是否把所有变化都消化了」（见 `index.js:3611-3623`）。其入参为：
   - `plan: job.updatePlan ?? null`（`slimPlanForJob` 精简过的 `UpdatePlan`）；
   - `results: job.articles ?? []`（逐篇落盘结果，`tally` 累积的 `name/ok/stopReason`）；
   - `options.expectedNames: job.expectedNames ?? []`（full 编译的分母清单，固化于 `index.js:3264`）；
   - `options.qualityIssues: job.qualityIssues ?? []`（含 `tickReview` 之前的 `localReview` 体检、`tickIndex` 开头的存量坏文章体检 `auditExistingArticles`）；
   - `options.extraBlockers: job.hardBlockers ?? []`（如 `cw index` / `cw meta update` 失败追加的 `index`/`meta` blocker）。
2. **得到 judged**：`{ outcome, blockers, canAdvanceBaseline }` 存入 `job.judged`（第 3623 行）。`outcome !== 'done'` 时记一条 `describeOutcome` 文案 note（第 3624-3627 行）。
3. **基线闸门**：`advance = job.judged?.canAdvanceBaseline === true`（第 3650 行）。仅当 `advance` 为真才跑 `cw meta update` 推进基线（第 3658-3666 行）；否则只建索引不推进——「未完成的部分下次编译仍会被看见」。
4. **落记录**：`tickIndex` 收尾调 `saveRecord(job, judged)`（第 3708 行；原生通道则在 `tickNative` 收割处调 `saveRecord(job, judged)`，见 `index.js:2574`）。`saveRecord`（第 2574-2596 行）是 `index.js` 内部的薄封装，它把 `job` 各字段喂给 `buildUpdateRecord`（第 2576-2587 行，注入 `jobId/scope/changeSet/plan/results/outcome: judged/qualityIssues/notes/startedAt: job.createdAt`），再调 `saveUpdateRecord(job.wikiPath, rec)`（第 2588 行）落到 `.codewiki/temp/update-record.json`，并把 `{ path: UPDATE_RECORD_REL, outcome, blockers, canAdvanceBaseline }` 摘要写回 `job.updateRecord`。
5. **终态**：`finished`（第 3713 行）或 `tickCommit` 完成后（第 3730 行）调 `finishJob(job, judged.outcome, judged.blockers)`（第 2522-2536 行），`finishJob` 内部复用 `describeOutcome` 写终态文案，并把 `canAdvanceBaseline` 与 judged 对齐（`stage === 'done' && blockers.length === 0`）。
6. **回读**：若面板/工具需要从磁盘读回记录，调 `loadUpdateRecord(wikiPath)`（第 229 行），版本不符返回 `null`。

单测覆盖（`test-update-record.mjs`）的关键数据流断言：

- 全部成功 → `done` 且 `canAdvanceBaseline: true`（第 54-60 行）；
- 1 成功 19 失败 → `partial`、`canAdvanceBaseline: false`、`failedCount: 19`（旧实现是 `done`，第 62-76 行）；
- 全部失败 → `failed`（第 78-82 行）；
- 缺页 / 未映射变更 / 缺 source_files / 质量闸门 / 索引失败 / 取消 / extraBlockers → 各自对应 blocker kind 且 `canAdvanceBaseline: false`（第 84-162 行）；
- full 编译无 plan：`expectedNames` 里的缺页同样拦基线（第 142-152 行）。

## Connections

- [[change-set]]：本模块消费的 `changeSet`（`baseCommit`/`headCommit`/`state`/`ok`/`sourceChanges`/`counts` 等）由 `lib/change-set.js` 的 `collectChangeSet` 产出；`buildUpdateRecord` 第 153-169 行直接读这些字段。
- [[update-planner]]：本模块消费的 `plan`（`requiredNames`、`actions`、`unmappedChanges`、`missingSources`、`fileLevel` 等）由 `lib/update-planner.js` 的 `planUpdate` 产出；`judgeOutcome` 第 57-97 行判定 `missing-article` / `unmapped-changes` / `missing-sources` blocker 时直接读这些字段。
- [[index]]（编排服务 `index.js`）：`judgeOutcome` / `buildUpdateRecord` / `saveUpdateRecord` / `loadUpdateRecord` / `describeOutcome` / `isTerminalStage` 由 `index.js` 第 30-33 行导入；`tickIndex`（第 3597-3714 行）与 `tickNative`（第 2805-2864 行）是主要调用点，`saveRecord`（第 2574-2596 行）、`finishJob`（第 2522-2536 行）是内部封装。
- [[article-contract]]：`auditExistingArticles` / `localReview` 产出的质量阻塞会进入 `job.qualityIssues`，最终被 `judgeOutcome` 的 `quality` blocker 收录（`lib/update-record.js:100-102`）。
- [[engine-quality-gate]]：原生通道（阶段 4）的质量门结果经 `tickNative` 的 `res.gate.articles` 落到 `job.articles`，再经 `judgeOutcome` 判终态（`index.js:2831-2847`）。

## Known Issues

- **旧实现的「部分失败仍成功」缺陷**：在 `update_record` 模块出现之前，`index.js:2775-2776`（旧实现，已废弃）只有 `writtenCount === 0` 才失败，其余一律 `done`，于是 1 篇成功 19 篇失败也报「已完成」并照常推进基线。本模块用 `judgeOutcome` 的三态 + `canAdvanceBaseline` 把这个缺陷钉死，测试见 `test-update-record.mjs:1-6` 与第 62-76 行。
- **未映射变更只算源码**：`judgeOutcome` 第 83-84 行显式把 `.md` 等非源码文件从 `unmappedChanges` 里滤掉——否则 README/CodeWiki.md/CHANGELOG 这类文档类变更会让正常增量永远落 `partial`，把「诚实终态」退化成「永远不完整」。这是有意的设计取舍，不是 bug，但若未来引入「文档变更也需归属」的诉求，这里需要调整。
- **`buildUpdateRecord` 的 `finishedAt` 默认调用时生成**：第 142 行 `finishedAt = new Date().toISOString()` 在组装时取当前时间，而非编译真正收尾的时间；调用方 `saveRecord`（第 2586 行）传的是 `startedAt: job.createdAt`，但 `finishedAt` 走默认值，两者时钟口径不完全一致（通常差几秒到几分钟）。
- **`loadUpdateRecord` 版本校验较硬**：第 233 行只认 `version === UPDATE_RECORD_VERSION`，任何旧格式 / 手改记录都返回 `null`，不会被当新格式读——这是有意的防错（测试第 199-204 行），但意味着跨版本记录无法向前兼容。
- **`judgeOutcome` 对 `options.cancelled` 优先级最高**：第 46-54 行一旦 `cancelled` 为真立即返回，不会再去算 `missing` / `unmapped` 等 blocker；因此取消态的 `blockers` 只有 `[{ kind: 'cancelled', detail: '任务被取消' }]`，不反映其它可能的未消化项（与上游 `tickNative` 第 2849-2858 行对 cancelled 的单独处理一致）。
- **记录不含整图/任务快照是硬约束**：`buildUpdateRecord` 不写 `graph` / `tasks`（测试第 179-185 行断言），所以严重依赖上游 `job.updatePlan`（已是 `slimPlanForJob` 精简结果）与 `job.changeSet` 摘要；若上游精简过头丢了复盘所需字段，记录本身无法补回。
