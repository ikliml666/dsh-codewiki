---
title: update_record
type: module
source_files:
  - lib/update-record.js
  - test-update-record.mjs
  - lib/update-planner.js
  - lib/change-set.js
  - index.js
tags: [update-record, outcome, persistence, baseline, audit]
---

## Overview

`update_record` 模块负责把「一次编译到底做了什么、为什么、哪些变化没人管、最终是否完整」落成一份**可机读、可复盘**的 JSON 记录，并给出编译的**终态判定**与「能不能推进编译基线」这一关键闸门。

它要解决的历史缺陷（见 `lib/update-record.js:1-11` 注释）：旧实现编译结束只留下 `writtenCount` / `failedCount` 两个数字，job 文件里塞的是整张符号图与任务快照。于是「为什么这篇没重写」「哪几个变更没人管」事后无法复盘，面板也只会显示一句「完成」——而实际上可能是 1 篇成功、19 篇失败。`tickIndex`（见 `index.js:3360-3462`）里旧实现的终态判定只数 `writtenCount`，1 成功 19 失败照样 `done` + `cw meta update`，未消化的变化从此永久失明。

本模块把上述不变量补回，职责分三层：

1. **收记录**：把 `ChangeSet` + `UpdatePlan` + 逐篇结果收成一份版本化记录 `buildUpdateRecord`（`lib/update-record.js:131-211`）。job 里只存路径与摘要，不把整图塞进 `update-record.json`（`index.js:2492-2517` 的 `saveRecord` 注释明确说明）。
2. **判终态**：`judgeOutcome`（`lib/update-record.js:37-128`）从计划与逐篇结果算出 `done` / `partial` / `failed` / `cancelled`，把「完整性不成立」的每种情形写进 `blockers`。
3. **定闸门**：终态由 `canAdvanceBaseline` 回答「能不能推进编译基线」——**只有完整成功（done）才可以**，partial/failed 不推进（`index.js:3396-3415` 据此决定要不要跑 `cw meta update`）。

模块本体是「纯函数 + 两个 IO 助手」（`lib/update-record.js:37`）：`judgeOutcome`、`buildUpdateRecord`、`describeOutcome` 都是无副作用的纯函数；`saveUpdateRecord` / `loadUpdateRecord` 是带 `fsImpl` 注入点的 IO 助手，便于单测（`test-update-record.mjs`）。

## Key Components

本模块全部为 `lib/update-record.js` 中的导出项（无 class / struct，记录本身是一个纯 JSON 对象，字段在 `buildUpdateRecord` 内逐项拼出）。

### 常量

- `UPDATE_RECORD_VERSION`（`lib/update-record.js:17`）— 记录格式版本，当前为 `1`。`loadUpdateRecord` 用它做版本守卫（`lib/update-record.js:229`）。
- `UPDATE_RECORD_REL`（`lib/update-record.js:18`）— 记录相对 wiki 根的路径 `temp/update-record.json`，同时也是 job 内存里 `updateRecord.path` 的存储值（`index.js:2511`）。
- `TERMINAL`（`lib/update-record.js:24`）— `Set(['done','partial','failed','cancelled'])`。终态集合，新增了 `partial`。

### 终态判定

- `judgeOutcome({ plan=null, results=[], options={} })`（`lib/update-record.js:37-128`）— 纯函数，核心判定器。
  - 入参：`plan` 为 `planUpdate` 产物（可为 `null`：full 编译没有增量计划）；`results` 是 `[{ name, ok, error? }]` 逐篇落盘结果；`options` 含 `expectedNames` / `qualityIssues` / `indexOk` / `cancelled` / `extraBlockers`（详见 `lib/update-record.js:33-34`）。
  - 返回 `{ outcome, blockers, canAdvanceBaseline, writtenCount, failedCount }`。
  - 关键分支：
    - 取消优先：`options.cancelled` 直接返 `cancelled` 且 `canAdvanceBaseline=false`（`lib/update-record.js:46-54`）。
    - 缺页：`plan.requiredNames` 或 `plan.actions` 中 `action==='write'` 但未成功也未失败的，记 `missing-article`（`lib/update-record.js:56-75`）。
    - 逐篇失败：记 `article-failed`（`lib/update-record.js:78`）。
    - 未映射变更：只算**源码变更**（`plan.unmappedSourceChanges` 或过滤掉 `.md$` 的 `unmappedChanges`），记 `unmapped-changes`（`lib/update-record.js:83-91`，原因见 `:80-82` 注释，非源码文件混入会让正常增量永远 partial）。
    - 缺 source_files：记 `missing-sources`（`lib/update-record.js:92-97`）。
    - 质量闸门：`options.qualityIssues` 记 `quality`（`lib/update-record.js:100-102`）。
    - 索引校验：`options.indexOk===false` 记 `index`（`lib/update-record.js:105`）。
    - 调用方硬阻塞：`options.extraBlockers` 记 `extra`/`kind`（`lib/update-record.js:108-110`）。
    - 终态公式：`blockers/failed/missing/requiredMissing` 全空 ⇒ `done`；`writtenCount===0` 且确有阻塞 ⇒ `failed`；否则 `partial`（`lib/update-record.js:115-118`）。`canAdvanceBaseline` 仅 `outcome==='done' && blockers.length===0` 为真（`lib/update-record.js:124`）。
- `isTerminalStage(stage)`（`lib/update-record.js:26-28`）— `TERMINAL.has(String(stage ?? ''))`，服务侧用来判断 job 是否到终态（配合 `JOB_TERMINAL`）。

### 记录组装

- `buildUpdateRecord({ jobId, scope, changeSet, plan, results, outcome, wikiPath, qualityIssues, notes, startedAt, finishedAt })`（`lib/update-record.js:131-211`）— 纯函数，拼出可序列化记录。
  - 若 `outcome` 未传，则用 `judgeOutcome({ plan, results, options:{ qualityIssues } })` 现场判定（`:144`）。
  - 记录顶层字段：`version` / `jobId` / `scope` / `startedAt` / `finishedAt` / `baseCommit` / `headCommit`（取自 `changeSet.baseCommit/headCommit`，`:151-152`）/ `changeSet`（摘要，含 `counts`、`sourceChanges`、`ignored`，`:153-169`）/ `plan`（摘要，每个 action 带 `reason`，`:170-195`）/ `results`（`:196-201`）/ `qualityIssues` / `outcome` / `blockers` / `canAdvanceBaseline` / `writtenCount` / `failedCount` / `notes`（只留最后 20 条，`:208`）/ `wikiPath`。
  - 故意**不含**整张符号图（`graph`）与任务快照（`tasks`）——`test-update-record.mjs:179-185` 用 `'graph' in rec === false` 与 `'tasks' in rec === false` 钉死这条约束。

### IO 助手（带 `fsImpl` 注入点）

- `recordPath(wikiPath)`（`lib/update-record.js:213-215`）— 返回 `<wikiPath>/temp/update-record.json`（`UPDATE_RECORD_REL` 按 `/` 拆后 `path.join`）。
- `saveUpdateRecord(wikiPath, record, fsImpl=fs)`（`lib/update-record.js:217-227`）— 自动建目录并 `writeFileSync`；失败返回 `{ ok:false, reason }` 而不抛错。是 `index.js:2509` `saveRecord` 的落盘出口。
- `loadUpdateRecord(wikiPath, fsImpl=fs)`（`lib/update-record.js:229-238`）— 读回 JSON；版本不符（`rec.version !== UPDATE_RECORD_VERSION`）或读取异常一律返回 `null`（不把旧格式当新格式读，`test-update-record.mjs:199-204`）。

### 文案

- `describeOutcome(outcome, blockers=[])`（`lib/update-record.js:241-253`）— 把三态（含 `cancelled`）转成面板/日志文案：`done`→「完成（所有变化已消化）」、`partial`→「部分完成（N 项未满足：首个原因）」、`failed`→「失败（首个原因）」。`finishJob`（`index.js:2443`）与 `tickIndex`（`index.js:3346`）都调它渲染终态 note。

## Architecture

本模块是编译收尾阶段的「终态判定 + 记录持久化」薄层，上游由 [[update-planner]]（`planUpdate`）产出 `plan`、[[change-set]] 产出 `changeSet`、执行器产出逐篇 `results`，本模块把它们收成记录并给出闸门结论。组件关系如下：

```text
┌──────────────────────────────────────────────────────────────────┐
│  index.js  tickIndex (index.js:3363-3462)                         │
│  ├─ judgeOutcome(plan, results, options)  ── 判终态 + blockers    │
│  │     ▲ 纯函数 (lib/update-record.js:37-128)                      │
│  │     ├── plan:  [[update-planner]] planUpdate 产物 (可 null)    │
│  │     ├── results: job.articles 逐篇落盘结果                     │
│  │     └── options: qualityIssues / indexOk / extraBlockers ...   │
│  ├─ saveRecord(job, judged)  (index.js:2495-2517)                 │
│  │     └─ buildUpdateRecord(...)  ── 纯函数 (lib/update-record.js:131-211)│
│  │            ├─ changeSet: [[change-set]] collectChangeSet 产物  │
│  │            └─ describeOutcome(outcome, blockers)  (面板文案)   │
│  └─ saveUpdateRecord(wikiPath, rec) / loadUpdateRecord ── IO 助手 │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
            .codewiki/temp/update-record.json (UPDATE_RECORD_REL)
                           ▲
            recordPath(wikiPath) = <wiki>/temp/update-record.json
```

- `judgeOutcome` 与 `buildUpdateRecord` 是纯函数，不碰文件系统，可在单测里直接喂结构化数据（`test-update-record.mjs`）。
- `saveUpdateRecord` / `loadUpdateRecord` 是唯一的 IO 边界，第二个参数 `fsImpl` 默认 `node:fs`，测试可注入假实现；两者都内部吞错、返回 `{ ok, reason }` 或 `null`，不向上抛。
- 版本守卫：`UPDATE_RECORD_VERSION` 不匹配的旧记录被 `loadUpdateRecord` 直接丢弃（`:233`），避免把旧格式误当新格式读。

## Data Flow

一次编译从「判不完整」到「记录落盘」的完整数据流（以 `scope=auto/stale` 增量路径为主，full 编译 `plan` 为 `null`）：

1. **准备输入**：`tickIndex`（`index.js:3346`）前，存量坏文章体检已把不合格的库内文章并入 `job.qualityIssues`（`index.js:3351-3359`）；`job.articles` 是逐篇落盘结果（`{ name, ok, stopReason }`），`job.updatePlan` 是 [[update-planner]] 的 `planUpdate` 产物，`job.changeSet` 来自 [[change-set]]，`job.hardBlockers` 是执行器整体失败等硬阻塞。
2. **判终态**：`tickIndex` 调 `judgeOutcome({ plan, results, options:{ expectedNames, qualityIssues, extraBlockers } })`（`index.js:3363-3371`），结果存 `job.judged = { outcome, blockers, canAdvanceBaseline }`（`:3372`）。非 `done` 时记一条 `describeOutcome` 文案 note（`:3373-3376`）。
3. **闸门决策**：仅当 `job.judged.canAdvanceBaseline===true` 才跑 `cw meta update` 推进基线（`index.js:3399-3415`）；partial/failed 时索引照建（`cw index`）但基线绝不前移——前移等于宣布「变化已被消化」，未消化的部分下次编译将永久失明（`:3396-3398` 注释）。
4. **组装记录**：`saveRecord(job, judged)`（`index.js:2495-2517`）调 `buildUpdateRecord`，把 `job.id / scope / changeSet / updatePlan / articles / qualityIssues / notes / createdAt` 收成记录（`:2497-2508`）。注意 `outcome` 直接传 `judged`（已判定结果），不再让 `buildUpdateRecord` 重复判（`:2503`）。
5. **落盘与摘要**：`saveUpdateRecord(job.wikiPath, rec)` 写入 `.codewiki/temp/update-record.json`（`:2509`）。job 内存只留摘要 `job.updateRecord = { path: UPDATE_RECORD_REL, outcome, blockers, canAdvanceBaseline }`（`:2511`），不把整图塞进 jobs 文件（`:2494` 注释）。失败则 `job.updateRecord = { path:null, outcome, reason }`（`:2512`）。
6. **终态收尾**：`finishJob(job, judged.outcome, judged.blockers)`（`index.js:2443-2448`）把 `outcome` 映射成 stage（`done`/`partial`/`failed`）、写 `canAdvanceBaseline`、记 `describeOutcome` 文案并唤醒会话（partial 也允许入库，但 stage 仍是 partial、基线不推进，见 `:3456` 注释）。
7. **读取侧**：面板 `GET /api/codewiki/jobs`（`index.js:2206-2237`）与 `codewiki_progress`（`index.js:2206-2219`）共用 `jobSummary`（`index.js:2206-2251`），其中 `outcome` / `blockers` / `canAdvanceBaseline` / `updateRecord` 字段直接来自本模块产物。`loadUpdateRecord` 当前在单测外没有热路径读取（记录是「事后复盘用」的落盘物，读它的是人/审计，而非运行期代码）。

### blocker 种类速查

`judgeOutcome` 可能产出的 `blockers[].kind` 与触发条件：

| kind | 触发位置 | 含义 |
|------|----------|------|
| `cancelled` | `lib/update-record.js:49` | `options.cancelled=true`，任务被取消 |
| `missing-article` | `:65`、`:68`、`:74` | 计划要求写 / 任务清单里有，但既没成功也没失败记录 |
| `article-failed` | `:78` | 逐篇落盘失败（含 `error` 截断到 300 字符） |
| `unmapped-changes` | `:86` | 源码变更没有任何文章归属（`items` 列出具体文件） |
| `missing-sources` | `:93` | 文章缺 `source_files` 无法判定归属 |
| `quality` | `:101` | 文章质量闸门未过（来自 `job.qualityIssues` 或存量体检） |
| `index` | `:105` | 索引重建 / 入口文件校验未通过 |
| `extra` / 自定义 | `:109` | 调用方补充的硬阻塞（如 `git-base`、`meta`） |

## Connections

## Known Issues
