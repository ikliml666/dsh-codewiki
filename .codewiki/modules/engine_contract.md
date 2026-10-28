---
title: engine_contract
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - test-engine-contract.mjs
  - lib/update-record.js
tags: [engine, contract, validation, normalization, fsoft-migration]
---

## Overview

`engine_contract` 是 FSoft 原生引擎迁移（阶段 0）的跨进程契约层，位于 `lib/engine/contract.js`。它的唯一职责是**定义、归一化、校验一次 `generate`/`update` 调用的完整结果**，让引擎侧（Python 进程）与 Node 侧（桥、JobService、面板、cw 基线、自动提交、降级提醒）共用同一套「引擎到底成功没有」的事实口径。

迁移后 Node 不再自己算依赖图/聚类/增量，一切来自 Python 引擎的一次返回。这条边界一旦含糊，每个消费方都会各自猜终态——这正是 0.14.0 花一整轮修掉的缺陷类型（1 篇成功 + 19 篇失败也报 done）。因此本模块把三件事固定下来（见 `contract.js:1-18`）：

- `EngineResult`（`engineResult`）——一次 generate/update 的完整结果，版本化、可校验。
- `EngineProgress`（`engineProgress`）——推进中的阶段/计数快照，tick 与面板共用。
- `EngineError`（`engineError`）——可机读失败事实（code 决定重试语义，message 只给人看）。

同包内的 `lib/engine/mapping.js` 是这条契约的「格式翻译」半边：把 FSoft 产物树（`overview.md` + 模块页 + `module_tree.json` + `metadata.json` + `update_record.json`）映射成 cw 仓库内的 `.codewiki/` 五类文章 + 顶层 `CodeWiki.md` 入口，并复用 `ENGINE_CONTRACT_VERSION` 作为产物描述对象的版本戳（`mapping.js:28`、`mapping.js:217`）。

设计硬约束（对应 `contract.js:12-18`）——语义不变量由 `engineResult` 与 `validateEngineResult` 双重保证：

- `done` = 完整成功，**不许**带 blockers（带了即自相矛盾）。
- `partial` = 部分完成，**必须**带至少一条 blockers（否则等于伪装成功）。
- `failed` = 失败，必须带 error。
- `cancelled` = 取消，可带 blockers 说明已写成的部分。

本模块是**纯数据校验**：不碰文件、不碰进程、不碰模型，纯函数才能被 TDD 钉死（对应 `contract.js:18`）。

## Key Components

以下全部为 `lib/engine/contract.js` 的公开导出（行号以源码前缀为准）。

### 常量与枚举（契约而非实现细节）

- `ENGINE_CONTRACT_VERSION`（`contract.js:20`）——数字 `1`。跨进程/跨版本真相来源的版本戳；所有结果对象与 `mapping.js` 的产物描述都带它。
- `ENGINE_STAGES`（`contract.js:24-33`）——阶段枚举数组（顺序即推进顺序）：
  `['env','graph','cluster','articles','validate','index','baseline','commit']`。
  `env` 最前（解释器/venv/依赖锁定），`commit` 最后（自动提交）。面板步骤条、`job.stage` 映射、取消检查点都按它对齐。
- `TERMINAL_OUTCOMES`（`contract.js:35`）——`Object.freeze(['done','partial','failed','cancelled'])`。终态集合。
- `BLOCKER_KINDS`（`contract.js:42-53`）——`Object.freeze([...])`。阻塞原因类别，机读、稳定、可被终态判定与面板文案共用。新增只能追加（消费者按 `kind` 分派），不允许改名。共 10 类：
  `article-failed`、`article-missing`、`unmapped-change`、`unmapped-page`、`quality-gate`、`index-failed`、`baseline-failed`、`commit-failed`、`engine-error`、`cancelled`。
- `ENGINE_ERROR_CODES`（`contract.js:57-67`）——`Object.freeze([...])`。可机读错误码，共 9 个：
  `engine-missing`、`engine-deps`、`engine-timeout`、`engine-cancelled`、`engine-crashed`、`engine-protocol`、`engine-model`、`engine-output`、`engine-unknown`。

内部集合（非导出，仅供本模块用）：`OUTCOME_SET`（`contract.js:37`）、`STAGE_SET`（`contract.js:38`）、`BLOCKER_SET`（`contract.js:55`）、`ERROR_CODE_SET`（`contract.js:69`）、`RETRYABLE_CODES`（`contract.js:71`，含 `engine-timeout`/`engine-model`/`engine-unknown`）。

### 私有归一化助手

- `num(v)`（`contract.js:73-76`）——把值规成有限正数，否则为 `0`。所有计数与 token 字段都经它归一，保证面板与终态判定共用同一份非负数。
- `normalizeUsage(usage)`（`contract.js:78-86`）——把任意 `usage` 规成 `{ inputTokens, outputTokens, cachedTokens, requests }` 四元组，缺失即 `0`。
- `normalizeBlocker(b)`（`contract.js:88-94`）——把单个阻塞原因规成 `{ kind, detail }`（`detail` 截断 2000 字符），仅认可登记的 `kind`，未知 `kind` 回落到 `'engine-error'`；有则带 `target`/`source`（均 `String`）。

### 公开函数

- `engineResult(input = {})`（`contract.js:97-141`）——构造一次 generate/update 的结果对象。**非法输入抛错而非静默归一**（契约破坏必须响）。返回对象字段：
  - `contractVersion`（`contract.js:114`）：`ENGINE_CONTRACT_VERSION`。
  - `outcome`（`contract.js:115`）：字符串，必须是 `TERMINAL_OUTCOMES` 之一，否则抛（`contract.js:99-101`）。
  - `stage`（`contract.js:117`）：引擎侧阶段终态（最后一个到达的 stage）；必须属于 `ENGINE_STAGES`，否则 `null`。面板据此解释「停在哪一步」。
  - `blockers`（`contract.js:118`）：`Array` 经 `normalizeBlocker` 归一；**`outcome==='done'` 带 blockers 抛错**（`contract.js:88-90`），**`outcome==='partial'` 无 blockers 抛错**（`contract.js:106-108`）。
  - `error`（`contract.js:109,119`）：仅当 `input.error` 存在时由 `engineError` 构造；**`outcome==='failed'` 缺 error 抛错**（`contract.js:110-112`）。
  - `writtenCount` / `failedCount` / `keptCount` / `removedCount` / `unmappedCount`（`contract.js:120-124`）：均经 `num` 归一的非负整数。
  - `usage`（`contract.js:125`）：`normalizeUsage` 结果。
  - `engine`（`contract.js:127-131`）：`{ version, commit, python }` 字符串三元组（doctor 产物，用于面板展示与回滚取证）。
  - `artifacts`（`contract.js:133-137`）：`{ docsDir, rawTreeDir, updateRecord }` 产物位置字符串三元组。
  - `startedAt` / `finishedAt`（`contract.js:138-139`）：字符串或 `null`（时间戳，原样 `String` 化，不校验格式）。

- `engineProgress(input = {})`（`contract.js:144-162`）——推进中的快照。字段只增不减（旧 job 缺字段按 0/null 解释）。`stage` 必须属于 `ENGINE_STAGES`，否则抛（`contract.js:146-148`）；`percent` 夹到 `0–100` 并四舍五入（`contract.js:149-150`）。返回 `{ contractVersion, stage, percent, message, writtenCount, failedCount, totalCount, usage, at }`。

- `engineError(input = {})`（`contract.js:165-176`）——可机读失败事实。返回字段：
  - `code`（`contract.js:169`）：登记的 `ENGINE_ERROR_CODES`，否则回落 `'engine-unknown'`（`contract.js:57`）。
  - `message`（`contract.js:170`）：截断 4000 字符。
  - `stage`（`contract.js:171`）：所属阶段或 `null`。
  - `retryable`（`contract.js:172`）：`RETRYABLE_CODES.has(code)`；其余视为确定性失败，重试只是浪费。
  - `rawCode`（`contract.js:174`）：仅当 `code==='engine-unknown'` 且原 `code` 非空时，保留原样（截断 200），便于排障且不改 `code` 的机读语义。

- `validateEngineResult(value)`（`contract.js:180-214`）——校验一个「可能来自外部/旧版本/磁盘」的对象。**不抛错，返回逐条 errors**（`{ ok, errors }`）。校验项：
  - 必须是对象且非数组（`contract.js:182-184`）。
  - `contractVersion` 必须匹配 `ENGINE_CONTRACT_VERSION`（`contract.js:185-187`）。
  - `outcome` 必须合法，且 `done` 不可带 blockers、`partial` 必须带 blockers（`contract.js:188-194`）。
  - 五个 count 字段若存在必须是有限非负数（`contract.js:195-200`）。
  - `blockers` 若存在必须是数组，且每项 `kind` 必须登记（`contract.js:201-209`）。
  - `failed` 必须带 `error` 对象（`contract.js:210-212`）。

- `describeEngineResult(result)`（`contract.js:217-234`）——终态文案，与 `lib/update-record.js` 的 `describeOutcome` 同一口径（四态可一眼分清）。不可读返回 `'引擎结果不可读'`；`done`→`完成（写入 N 篇）`；`partial`→`部分完成（...）：首条 blockers 细节`；`failed`→`失败：error.message`；`cancelled`→`已取消（已写入 N 篇）`；未知→`未知终态：…`。

### mapping.js 相关公开导出（契约的格式翻译半边）

- `WIKI_ENTRY` = `'CodeWiki.md'`（`mapping.js:30`），`WIKI_DIR` = `'.codewiki'`（`mapping.js:31`），`WIKI_META_REL` = `'.codewiki/_meta.yaml'`（`mapping.js:32`），`WIKI_UPDATE_RECORD_REL` = `'.codewiki/temp/update-record.json'`（`mapping.js:33`），`WIKI_MODULES_REL` = `'.codewiki/modules'`（`mapping.js:34`）。
- `moduleSlug(name)`（`mapping.js:38-44`）——ASCII 模块名转 kebab-case；非 ASCII 折叠分隔符并小写。
- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（`mapping.js:115-229`）——纯函数，把 FSoft docs 树映射成 cw 写集描述。返回 `{ contractVersion, entry, articles, unmapped, meta, updateRecord, warnings }`。硬规则（迁移安全边界，见 `mapping.js:16-26`）：**不臆造 source_files**、**不静默丢弃**（未映射页进 `unmapped` 带原因）、**不覆盖**（slug 冲突两页都进 `unmapped`）、**不改技术内容**（只搬路径与类型，正文一字不动）。

## Architecture

`contract.js` 是纯函数内核，`mapping.js` 是同一包内的格式翻译层；二者被引擎桥/JobService/面板/基线/降级等消费方共用。组件 ≥3 且流程非平凡，框图如下（≤20 行）：

```text
                 FSoft 原生引擎 (Python 进程)
                          │ 一次 generate/update 返回
                          ▼
        ┌─────────────────────────────────────────────┐
        │ lib/engine/contract.js  (纯函数、版本化契约)  │
        │  ENGINE_CONTRACT_VERSION / ENGINE_STAGES      │
        │  TERMINAL_OUTCOMES / BLOCKER_KINDS / CODES    │
        └─────────────────────────────────────────────┘
           │                │                  │
   engineResult         engineProgress     engineError
   (结果归一+抛错)        (快照 tick/面板)    (机读失败+retryable)
           │                │                  │
           └───────┬────────┴──────────────────┘
                   ▼
        validateEngineResult(value)  ── 反序列化边界校验(不抛, 返回 errors)
                   ▼
        describeEngineResult(result) ── 四态文案
                   │
   ┌───────────────┴───────────────────────────────────────┐
   │ 消费方: 桥(lib/engine/*) / JobService / 面板 /         │
   │        cw 基线(baseline) / 自动提交(commit) / 降级提醒  │
   └───────────────────────────────────────────────────────┘

   FSoft docs 树 ──► mapFsoftOutput (lib/engine/mapping.js)
                     │ 复用 ENGINE_CONTRACT_VERSION 作产物戳
                     ▼
        { entry, articles, unmapped, meta, updateRecord, warnings }
                     │ 映射到 .codewiki/ 五类文章 + CodeWiki.md
                     ▼
        artifacts.docsDir / rawTreeDir / updateRecord (回填 engineResult.artifacts)
```

要点：
- `contract.js` 自身不为任何消费方持有状态，所有函数无副作用（`contract.js:18`）。
- `stage`/`blockers`/`error` 三字段的语义不变量只在 `engineResult`（构造时）与 `validateEngineResult`（反序列化时）两处断言，保证「写入即合法、读入再核验」。
- `mapping.js` 的产物描述带 `contractVersion`（`mapping.js:217`），与 `engineResult.artifacts`（`contract.js:133-137`）联动——引擎把文档写到 `docsDir`、原始树写到 `rawTreeDir`、`update_record` 写到 `updateRecord`，这些路径回填进结果对象供上层入库与回滚取证。

## Data Flow

一次 generate/update 在契约层的数据流（行号指向 `contract.js`）：

1. **引擎返回原始 JSON** → Node 侧拿到一次调用的原始结果字典（含 `outcome`/`stage`/`blockers`/`error`/计数/`usage`/`engine`/`artifacts` 时间戳等）。
2. **`engineResult(raw)` 归一化与断言**（`contract.js:97`）：
   - `outcome` 不在 `TERMINAL_OUTCOMES` → 抛错（`contract.js:99-101`）。
   - `done` + 非空 blockers → 抛（`contract.js:103-105`）；`partial` + 空 blockers → 抛（`contract.js:106-108`）。
   - `error = input.error ? engineError(input.error) : null`（`contract.js:109`）；`failed` 缺 error → 抛（`contract.js:110-112`）。
   - 所有计数经 `num`（`contract.js:73`）、`usage` 经 `normalizeUsage`（`contract.js:78`）、`blockers` 经 `normalizeBlocker`（`contract.js:88`）规整。
3. **`mapFsoftOutput` 翻译产物树**（`mapping.js:115`）：引擎写出的 docs 树 → `{ entry, articles, unmapped, meta, updateRecord, warnings }`，并把路径回填进 `engineResult.artifacts`（`contract.js:133-137`）。`unmapped` 页带可机读原因，绝不静默丢弃（`mapping.js:130-141`）。
4. **推进中**走 `engineProgress`（`contract.js:144`）：`stage` 枚举校验、`percent` 夹 `0–100`，由 tick 与面板共用同一快照形状。
5. **终态判定/展示**：消费方以 `outcome` + `blockers` + `error` 三字段为准——`baseline` 阶段只在完整 `done` 时推进（`ENGINE_STAGES` 顺序，`contract.js:24`；`mapping.js` 注释 `mapping.js:11`），`commit` 失败记 `commit-failed` blocker 但不算引擎失败（`contract.js:50`）。
6. **反序列化边界**：从磁盘/旧版本读回结果时一律过 `validateEngineResult`（`contract.js:180`），返回 `{ ok, errors }` 而非抛错（`contract.js:178`），避免信任外部对象。
7. **文案**：`describeEngineResult`（`contract.js:217`）把四态翻成可一眼分清的人话，与 `lib/update-record.js` 的 `describeOutcome` 同口径（`contract.js:216`）。

关键不变量的端到端示例（来自 `test-engine-contract.mjs:49-133`）：
- `engineResult({ outcome: 'running' })` 抛（`test-engine-contract.mjs:49-52`）。
- `engineResult({ outcome: 'done', blockers: [...] })` 抛（`test-engine-contract.mjs:54-59`）。
- `engineResult({ outcome: 'partial' })` 抛，带 blocker 才合法（`test-engine-contract.mjs:61-71`）。
- `validateEngineResult({ contractVersion: 999, outcome: 'partial', blockers: [], writtenCount: 'two' })` 返回含 `contractVersion`/`partial`/`writtenCount` 三条错误的 `{ ok:false }`（`test-engine-contract.mjs:106-120`）。

## Connections

- [[engine-bridge]] / [[engine-llm-bridge]] — FSoft 引擎通过 `lib/engine/llm-bridge.js` + `lib/engine/openai-bridge.js` 借用宿主凭证做 agentic 写作；契约里的 `usage`（token 计数，`contract.js:125`）源头即这些桥转出的 `StreamChunk` 流（`openai-bridge.js:176` 的 `usageToOpenAI`）。桥不碰契约对象，只负责把模型调用结果喂回引擎。
- [[engine-process-tree]] — `lib/engine/process-tree.js` 负责终止 FSoft 子进程树；取消语义落点即 `engineResult({ outcome:'cancelled', blockers:[{kind:'cancelled'}] })`（`contract.js:97`、`update-record.js:46-53` 同源的 `cancelled` blocker）。
- [[update-record]] — `lib/update-record.js` 的 `judgeOutcome` / `describeOutcome` 与 `engineResult`/`describeEngineResult` 共用同一套四态语义（`done`/`partial`/`failed`/`cancelled`，`contract.js:35` 与 `update-record.js:24` 同集合）；`describeEngineResult` 注释明称与其口径一致（`contract.js:217`）。
- [[article-contract]] — `lib/article-contract.js` 是单篇文章的 frontmatter/锚点/死链/`source_files` 校验门，对应契约里 `BLOCKER_KINDS` 的 `quality-gate`（`contract.js:42`）；引擎 `validate` 阶段（`contract.js:29`）的产物质量由其判定，失败转 blocker 进结果。
- [[incremental]] / [[change-set]] / [[update-planner]] — 增量编译的「哪些变更被消化、哪些未消化」决定 `unmappedCount`/`unmapped-change` blocker（`contract.js:45,124`）；`mapFsoftOutput` 的 `unmapped`（`mapping.js:111,237`）正是这些模块漏掉的页的体现。
- [[cluster]] / [[graph-diff]] / [[symbols]] — 引擎 `graph`/`cluster` 阶段（`contract.js:26-27`）产出的 `module_tree.json` 即 `mapFsoftOutput` 的 `moduleTree` 入参（`mapping.js:74-96`），`source_files` 证据来自其中的 `components`（`mapping.js:60-72`）。
- [[engine-contract]]（本模块）← 被测试钉死：`test-engine-contract.mjs` 同时覆盖 `contract.js` 与 `mapping.js` 两个文件（`test-engine-contract.mjs:23-30`）。

## Known Issues

- **时间戳不校验格式**：`startedAt`/`finishedAt`（`contract.js:138-139`）只 `String(input.startedAt)` 原样收纳，可为任意字符串或 `null`；`engineProgress.at`（`contract.js:160`）同理。消费方若需做时长计算，得自己解析，契约层不保证 ISO 8601。
- **`partial` 的 blockers 语义宽松**：`engineResult` 只要求 `partial` 至少一条 blockers（`contract.js:106-108`），但不校验其 `kind` 是否真能表达「未消化」——`validateEngineResult` 也只查 `kind` 是否登记（`contract.js:206`），不查 `detail` 是否非空。空 `detail` 的 blocker 合法但无信息量。
- **`engine`/`artifacts` 子对象不深校验**：`engineResult` 对 `input.engine`/`input.artifacts` 只做 `String` 化（`contract.js:127-137`），缺子字段即空串，不抛错、不补默认结构；消费方读到空 `docsDir` 时无法从契约层区分「真没产出」与「字段缺失」。
- **`stage` 在 `done` 时可空**：`engineResult` 在 `outcome==='done'` 时不强制 `stage` 属于 `ENGINE_STAGES`（非 `done` 才在 `contract.js:24` 落 `null`），但面板的「停在哪一步」依赖 `stage`；若引擎漏报 `stage`，`done` 结果里 `stage` 为 `null`，面板需自行兜底。
- **`validateEngineResult` 不做 blockers 与 outcome 的交叉深度校验**：例如 `failed` 带了 `error` 但该 `error.code` 是否登记、`error.retryable` 是否一致都不核（`contract.js:210-212` 只查 `error` 是对象），嵌套错误结构合法性完全信任来源。
- **`mapFsoftOutput` 的组件→文件证据不可靠时会静默留空**：`sourceFilesOf`（`mapping.js:60-72`）对无 `::` 又无 `componentFiles` 映射的组件直接跳过（不猜），产物 `sourceFiles` 为空数组并附 warning（`mapping.js:178-184`）；这让 `article-contract` 的质量闸门可能因缺 `source_files` 而拦下，进而转为 `quality-gate` blocker，但根因是上游证据缺失而非文章本身坏。
- **`RETRYABLE_CODES` 把 `engine-unknown` 视为可重试**（`contract.js:71`）：未登记错误码一律 `retryable=true`，意味着「不认识的错」会触发重试，可能掩盖真正的确定性故障（见 `test-engine-contract.mjs:98-100`，`engine-unknown` 的 `retryable` 为 `true`）。
