---
title: update_record
type: module
source_files:
  - lib/update-record.js
  - test-update-record.mjs
  - lib/update-planner.js
  - lib/change-set.js
  - index.js
tags: [record, outcome, audit, baseline, partial]
---

## Overview

`update_record` 模块负责把**一次文档编译到底做了什么、为什么、是否完整**落成一个可机读的 JSON 记录（`temp/update-record.json`），并负责判定编译的**终态（outcome）**与**能否推进编译基线（canAdvanceBaseline）**。

背景缺陷（见 `lib/update-record.js:1-12` 的模块头注释，及 `test-update-record.mjs:1-6`）：旧实现编译结束只留 `writtenCount` / `failedCount` 两个数字，job 文件里塞的是整张图与任务快照。结果「为什么这篇没重写」「哪几个变更没人管」事后无法复盘，面板也只能显示一句「完成」——而实际上可能 1 篇成功、19 篇失败。

本模块解决三件事：

1. **收记录**：把 `ChangeSet`（来自 `lib/change-set.js`）+ `UpdatePlan`（来自 `lib/update-planner.js`）+ 逐篇落盘结果收成一份版本化记录（见 `buildUpdateRecord`，`lib/update-record.js:131`）。
2. **判定终态**：根据计划内必需文章、逐篇成功/失败、未映射变更、质量闸门、索引完整性等，算出 `done` / `partial` / `failed` / `cancelled`，把每种「完整性不成立」的情形写进 `blockers`（见 `judgeOutcome`，`lib/update-record.js:37`）。
3. **回答能不能推进基线**：只有完整成功（`outcome === 'done'` 且无 blocker）才允许 `canAdvanceBaseline = true`。partial 也允许文章入库，但**基线绝不前移**，否则等于宣布「未消化的变化已消化」，下次编译将永久失明。

模块设计成「纯函数 + 两个 IO 助手」，因此可单测：核心判定（`judgeOutcome` / `buildUpdateRecord` / `describeOutcome`）不碰文件系统，落盘/回读（`saveUpdateRecord` / `loadUpdateRecord` / `recordPath`）通过可注入的 `fsImpl`（默认 `node:fs`）访问磁盘。

测试驱动（见 `test-update-record.mjs:1-6`）把「部分失败仍成功」这条缺陷钉死：旧实现只有 `writtenCount === 0` 才失败，其余一律 `done`；本模块要求任何未消化项 ⇒ `partial` / `failed`，且 `partial` 绝不推进基线。

## Key Components

全部公开符号都在 `lib/update-record.js`，统一从 `lib/update-record.js` 导入（见 `index.js:30-33`、`test-update-record.mjs:11-14`）。

### 常量

- `UPDATE_RECORD_VERSION`（第 17 行）：记录格式版本号，当前为 `1`。`loadUpdateRecord`（第 233 行）会校验读回的 `rec.version` 必须等于它，否则返回 `null`（版本不符的旧格式拒绝当新格式读）。
- `UPDATE_RECORD_REL`（第 18 行）：记录相对 wiki 根的相对路径 `'temp/update-record.json'`。被 `recordPath`（第 213 行）与 `index.js:2511` 引用。
- `TERMINAL`（第 24 行）：终态集合 `Set(['done', 'partial', 'failed', 'cancelled'])`。注意 `cancelled` 也是终态之一（取消的任务不再转圈）。

### 函数

- `isTerminalStage(stage)`（第 26 行）：判断某 stage 是否在 `TERMINAL` 集合内。实现为 `TERMINAL.has(String(stage ?? ''))`，空值/未知值一律返回 `false`。
- `judgeOutcome({ plan, results, options })`（第 37 行）：终态判定核心纯函数。返回 `{ outcome, blockers, canAdvanceBaseline, writtenCount, failedCount }`。判定逻辑分七类（详见 `lib/update-record.js:37-110`）：
  1. **计划内必需文章缺页 / 失败**：从 `plan.requiredNames` 与 `plan.actions`（过滤出 `action === 'write'` 的）比对 `okNames` 与 `failed`，缺页记 `missing-article`（第 65、68 行），无 plan 的 full 编译通道用 `options.expectedNames` 判缺页（第 71-75 行）。
  2. **逐篇失败**：`failed` 数组里的每一项记 `article-failed`（第 78 行），错误信息截断到 300 字（第 44 行）。
  3. **未映射变更（unmapped）**：`plan.unmappedSourceChanges ?? plan.unmappedChanges` 过滤掉 `.md$`，记 `unmapped-changes`（第 83-91 行）。非源码文件（README/CodeWiki.md/CHANGELOG）不被引用是常态，混进来会让增量永远落 partial，因此只算源码变更。
  4. **缺 source_files**：`plan.missingSources` 记 `missing-sources`（第 92-97 行）。
  5. **质量闸门**：`options.qualityIssues` 记 `quality`（第 100-102 行）。
  6. **索引/入口完整性**：`options.indexOk === false` 记 `index`（第 105 行）。
  7. **调用方补充硬阻塞**：`options.extraBlockers`（如 git base 不可达导致 full 退化、执行器整体失败）记 `extra` 或调用方指定的 `kind`（第 108-110 行）。

  终态决策（第 112-118 行）：没有任何成果可交付（`writtenCount === 0` 且存在失败/缺页/阻塞）才 `failed`；只要写成一部分就是 `partial`；`blockers`、`failed`、`missing`、`requiredMissing` 全空才 `done`。`canAdvanceBaseline` 仅当 `outcome === 'done'` 且无 blocker（第 124 行）。`options.cancelled` 为 `true` 时直接短路返回 `outcome: 'cancelled'`、`canAdvanceBaseline: false`（第 46-54 行）。

- `buildUpdateRecord({ ... })`（第 131 行）：组装可序列化记录。若 `outcome` 未显式传入，则内部调用 `judgeOutcome({ plan, results, options: { qualityIssues } })`（第 144 行）。产出字段（第 145-210 行）包含 `version`、`jobId`、`scope`、`startedAt`、`finishedAt`、`baseCommit`/`headCommit`（取 `changeSet`）、`changeSet`（只存摘要计数，不塞整图）、`plan`（每个 action 都带 `reason`，保证可复盘、第 181 行）、`results`、`qualityIssues`、`outcome`、`blockers`、`canAdvanceBaseline`、`writtenCount`、`failedCount`、`notes`（截断末尾 20 条，第 208 行）、`wikiPath`。明确不写入整张符号图（`graph`）与任务快照（`tasks`）。
- `recordPath(wikiPath)`（第 213 行）：返回 `path.join(wikiPath, ...UPDATE_RECORD_REL.split('/'))`，即该 wiki 根下的 `temp/update-record.json` 绝对路径。
- `saveUpdateRecord(wikiPath, record, fsImpl = fs)`（第 217 行）：落盘 IO 助手。`wikiPath` 为空直接返回 `{ ok: false, reason: '没有 wiki 路径' }`；否则 `mkdirSync(..., { recursive: true })` 后 `writeFileSync` 写入带缩进的 JSON + 换行。成功返回 `{ ok: true, path: file }`，异常返回 `{ ok: false, reason }`（截断 200 字）。
- `loadUpdateRecord(wikiPath, fsImpl = fs)`（第 229 行）：回读 IO 助手。读不到 / 解析失败 / `version !== UPDATE_RECORD_VERSION` 一律返回 `null`（第 233 行）。
- `describeOutcome(outcome, blockers = [])`（第 241 行）：面板/工具文案。`done` → 「完成（所有变化已消化）」；`partial` → 「部分完成（N 项未满足：首个阻塞原因）」；`cancelled` → 「已取消」；`failed` → 「失败（首个阻塞原因 / 无可用成果）」；其余原样返回。三态文案一眼可区分，且带首个 blocker 的原因（截断 120/160 字）。

### 记录结构（buildUpdateRecord 产出的字段）

记录是普通 JSON 对象（无 class），关键字段及其来源：

| 字段 | 类型 | 来源 / 说明 |
| --- | --- | --- |
| `version` | number | `UPDATE_RECORD_VERSION`，恒为 `1` |
| `jobId` | string \| null | 编译任务 id |
| `scope` | string | `'auto'` / `'full'` / `'stale'` |
| `startedAt` / `finishedAt` | string (ISO) | `finishedAt` 默认 `new Date().toISOString()`（第 142 行） |
| `baseCommit` / `headCommit` | string \| null | 来自 `changeSet` |
| `changeSet` | object \| null | 含 `state`/`ok`/`fallback`/`reason`/`counts`/`sourceChanges`/`ignored`（第 153-169 行），只存摘要 |
| `plan` | object \| null | 含 `version`/`fileLevel`/`needsFull`/`actions`/`unmappedChanges`/`missingSources` 等（第 170-195 行） |
| `results` | array | 逐篇 `{ name, ok, stopReason, error }`，`error` 截断 300 字（第 196-201 行） |
| `qualityIssues` | array | 逐条 `{ name, issue }`（第 202 行） |
| `outcome` | string | `judged.outcome`（`'done'`/`'partial'`/`'failed'`/`'cancelled'`） |
| `blockers` | array | 各阻塞项 `{ kind, name?, detail, items? }` |
| `canAdvanceBaseline` | boolean | 仅 `done` 且无 blocker 时为 `true` |
| `writtenCount` / `failedCount` | number | 来自判定结果 |
| `notes` | array | 截断末尾 20 条 |
| `wikiPath` | string \| null | wiki 根路径 |

## Architecture

本模块是纯函数 + 两个 IO 助手，组件少但职责清晰。核心判定与组装不碰磁盘，落盘/回读可注入 `fsImpl`：

```text
   ChangeSet             UpdatePlan            逐篇 results
   (lib/change-set)      (lib/update-planner)  (job.articles)
        │                    │                       │
        └─────────┬──────────┴───────────┬───────────┘
                  ▼                      ▼
          ┌───────────────────────────────────────┐
          │  judgeOutcome()  (lib/update-record.js:37)│ 纯函数：算 outcome/blockers/
          │   七类 blocker + cancelled 短路          │          canAdvanceBaseline
          └───────────────────┬───────────────────┘
                              │ outcome 可显式传入或被 judge
                              ▼
          ┌───────────────────────────────────────┐
          │ buildUpdateRecord() (lib/update-record.js:131)│ 纯函数：组装可序列化 JSON
          │   不塞整图/任务快照，每 action 带 reason │
          └───────────────┬───────────────────────┘
                          │ record
            ┌─────────────┴──────────────┐
            ▼                            ▼
  ┌──────────────────┐          ┌─────────────────────┐
  │ saveUpdateRecord │          │ describeOutcome()   │ 面板/工具文案
  │ (fsImpl 可注入)  │          └─────────────────────┘
  └────────┬─────────┘
           ▼
  temp/update-record.json
           │
           ▼
  ┌──────────────────┐
  │ loadUpdateRecord │  (version 校验，不符返回 null)
  └──────────────────┘
```

调用方 `index.js` 集成位置：

- `tickIndex`（第 3363 行）在索引/基线**之前**调用 `judgeOutcome`，把结果存 `job.judged`；
- `saveRecord`（第 2495-2517 行）在编译收尾时调用 `buildUpdateRecord` 再 `saveUpdateRecord`，落盘结果记到 `job.updateRecord`；
- `finishJob`（第 2443 行）用 `judged.outcome` 设置 `job` 终态 stage 并调用 `describeOutcome` 写 note。

## Data Flow

一次编译的终态判定与记录落盘，在 `index.js` 的流水线里是这样流动的：

1. **采集输入**：`submit`（第 3579 行）把 `changeSet` 摘要与 `updatePlan`（`slimPlanForJob` 精简后）挂到 `job` 上（第 3622-3634 行），供后续判定使用。
2. **逐篇结果累积**：`tickArticles` / `tickCrosscut` / `tickReview` 等阶段通过 `tally`（第 2550 行）把每篇文章的 `{ name, ok, stopReason, path }` 累计进 `job.articles`，并维护 `job.writtenCount` / `job.failedCount`。
3. **存量体检**：`tickIndex`（第 3352 行）调用 `auditExistingArticles`，把未过契约的存量坏文章并入 `job.qualityIssues`——即使本次全成功，库里有坏文章也会导致 partial 且不推进基线。
4. **判定终态**：`tickIndex` 第 3363 行调用 `judgeOutcome({ plan: job.updatePlan, results: job.articles, options: { expectedNames, qualityIssues, extraBlockers: job.hardBlockers } })`，结果存 `job.judged = { outcome, blockers, canAdvanceBaseline }`（第 3372 行）。
5. **闸门**：`tickIndex` 第 3399 行读 `job.judged.canAdvanceBaseline`，仅当 `true` 才 `cw meta update` 推进基线；否则只建索引、不推进（第 3413-3415 行）。
6. **落盘记录**：`saveRecord(job, judged)`（第 2495 行）在 `tickIndex` 末尾被调用（第 3457 行），内部 `buildUpdateRecord` 组装记录后 `saveUpdateRecord` 写入 `temp/update-record.json`；落盘结果（成功路径含 `outcome`/`blockers` 计数/`canAdvanceBaseline`）记到 `job.updateRecord`（第 2510-2512 行）。
7. **终态收尾**：`finishJob`（第 2443 行）用 `judged.outcome` 把 `job.stage` 置为 `done` / `partial` / `failed`，并把 `canAdvanceBaseline` 再算一遍（第 2448 行）。

回读方向：面板或其他工具可用 `loadUpdateRecord(wikiPath)`（第 229 行）把记录读回，配合 `describeOutcome` 渲染终态文案；版本号不符（如旧 wiki 残留记录）会被拒绝（第 233 行）。

## Connections

## Known Issues
