---
title: engine_contract
type: module
source_files:
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/engine/client.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/update-record.js
  - test-engine-contract.mjs
tags: [engine, contract, mapping, fsoft, validation, normalization]
---

## Overview

`engine_contract` 是「FSoft 原生引擎 + 薄适配层」迁移（阶段 0）里唯一一处**跨进程边界的真相来源**。迁移后 Node 不再自己算依赖图/聚类/增量，一切都来自 Python 引擎的一次返回，于是这个边界必须先有**版本化、可校验、可断言失败**的契约，否则后续每个消费方（JobService 终态判定、面板、cw 基线、自动提交、降级提醒）都会在「引擎返回了什么」上各猜一套——这正是 0.14.0 花了整轮修掉的缺陷类型（1 篇成功 + 19 篇失败也报 `done`，见 `lib/engine/contract.js` 第 1–18 行注释）。

本模块钉死两件事（见 `test-engine-contract.mjs` 第 1–12 行背景说明）：

1. **引擎结果的形状与语义**——`EngineResult` / `EngineProgress` / `EngineError` 三个纯函数构造器 + 一个校验器 + 一个文案器。核心不变量由 `engineResult` 与 `validateEngineResult` 双重保证：
   - `done` = 完整成功，**不许**带 `blockers`（带了即自相矛盾）；
   - `partial` = 部分完成，**必须**带至少一条 `blockers`（否则等于把失败伪装成部分成功）；
   - `failed` = 失败，必须带 `error`；
   - `cancelled` = 取消，可带 `blockers` 说明已写成的部分。
2. **FSoft 产物到 CodeWiki.md / `.codewiki/` 的映射**——`mapFsoftOutput` 把 FSoft 的 docs 树（overview.md + 模块页 + module_tree.json + metadata.json + update_record.json）翻译成 cw 的写集描述。父页、artifact、未映射页各有明确去处，绝不允许「静默丢弃」或「强塞进四类文章」。

设计原则：契约层**只做纯数据校验，不碰文件、不碰进程、不碰模型**（见 `lib/engine/contract.js` 第 18 行）。所有构造器非法输入时**抛错而不是静默归一**（`lib/engine/contract.js` 第 96 行），校验器在反序列化边界上**返回逐条 errors 而不是抛**（见 `lib/engine/contract.js` 第 184 行），两条路径对应不同的信任假设。

## Key Components

本模块的核心在 `lib/engine/contract.js` 和 `lib/engine/mapping.js`；其余 `lib/engine/client.js`、`lib/engine/output.js`、`lib/engine/quality-gate.js`、`lib/engine/apply-plan.js`、`lib/update-record.js` 是消费方（见 [[Connections]]）。

### lib/engine/contract.js（契约形状）

**常量（全部 `Object.freeze`）**

- `ENGINE_CONTRACT_VERSION`（第 20 行）——契约版本号，当前为 `1`，是结果对象的 `contractVersion` 字段，校验时硬性比对。
- `ENGINE_STAGES`（第 24–33 行）——阶段枚举，也是**契约**而非实现细节（面板步骤条、job.stage 映射、取消检查点都按它对齐）。顺序即推进顺序：`env → graph → cluster → articles → validate → index → baseline → commit`，其中 `env` 在最前（解释器/venv/依赖锁定），`commit` 在最后（自动提交）。
- `TERMINAL_OUTCOMES`（第 35 行）——四个终态：`['done', 'partial', 'failed', 'cancelled']`。
- `BLOCKER_KINDS`（第 42–53 行）——阻塞原因类别，机读且稳定，消费者按 `kind` 分派，新增只允许追加：`article-failed` / `article-missing` / `unmapped-change` / `unmapped-page` / `quality-gate` / `index-failed` / `baseline-failed` / `commit-failed` / `engine-error` / `cancelled`。
- `ENGINE_ERROR_CODES`（第 57–67 行）——可机读错误码：`engine-missing` / `engine-deps` / `engine-timeout` / `engine-cancelled` / `engine-crashed` / `engine-protocol` / `engine-model` / `engine-output` / `engine-unknown`。
- 内部集合：`OUTCOME_SET`（第 37 行）、`STAGE_SET`（第 38 行）、`BLOCKER_SET`（第 55 行）、`ERROR_CODE_SET`（第 69 行）、`RETRYABLE_CODES`（第 71 行，含 `engine-timeout` / `engine-model` / `engine-unknown`）。
- 私有辅助：`num`（第 73–76 行，把值夹成非负有限数，否则 0）、`normalizeUsage`（第 78–86 行）、`normalizeBlocker`（第 88–94 行，把 blocker 的 `kind` 归一到枚举、未知归 `engine-error`，`detail` 截断到 2000 字符）。

**函数**

- `engineResult(input = {})`（第 97–147 行）——构造一次 generate/update 的完整结果。
  - 入参 `outcome` 必须是四个终态之一，否则抛错（第 99–101 行）。
  - `done` 带 `blockers` 抛错（第 103–105 行）；`partial` 无 `blockers` 抛错（第 106–108 行）；`failed` 无 `error` 抛错（第 109–112 行）。
  - 返回对象的全部字段：`contractVersion`、`outcome`、`stage`（落不到枚举则为 `null`）、`blockers`、`error`、`writtenCount`/`failedCount`/`keptCount`/`removedCount`/`unmappedCount`（全部经 `num` 归一）、`usage`（`{inputTokens, outputTokens, cachedTokens, requests}`）、`engine`（`{version, commit, python, deps:{ok, summary}}`，其中 `deps.ok` 只有严格 `true` 才算通过，摘要截断 2000）、`artifacts`（`{docsDir, rawTreeDir, updateRecord}`）、`startedAt`/`finishedAt`（字符串或可空）。
- `engineProgress(input = {})`（第 150–168 行）——构造推进中的快照。
  - `stage` 必须落在 `ENGINE_STAGES`，否则抛错（第 151–154 行）；`percent` 夹到 0–100 并四舍五入（第 155–156 行）。
  - 字段：`contractVersion`、`stage`、`percent`、`message`、`writtenCount`、`failedCount`、`totalCount`、`usage`、`at`。注释强调字段只增不减（旧 job 缺字段按 0/null 解释，第 149 行）。
- `engineError(input = {})`（第 171–182 行）——构造可机读失败事实。
  - 未登记的 `code` 归到 `engine-unknown`，原样文本保留在 `rawCode`（截断 200 字符）（第 180 行）。
  - `retryable` 由 `RETRYABLE_CODES` 决定（第 178 行）。
  - 字段：`code`、`message`（截断 4000）、`stage`、`retryable`、`rawCode`（仅未知时）。
- `validateEngineResult(value)`（第 186–220 行）——校验一个可能来自外部/磁盘/旧版本的裸对象，不抛，返回 `{ ok, errors }`。检查：`contractVersion` 匹配、`outcome` 合法、`done/partial` 的 blockers 自洽、五个计数非负有限、`blockers` 结构与 `kind` 登记、`failed` 必带 `error`。非对象直接返回 `['结果不是对象']`（第 188–190 行）。
- `describeEngineResult(result)`（第 223–240 行）——四态中文文案，与 `lib/update-record.js` 的 `describeOutcome` 同一口径（第 222 行注释）：`done` 带写入篇数、`partial` 带首个 blocker 的 detail、`failed` 带 `error.message`、`cancelled` 带已写入篇数；不可读时返回 `'引擎结果不可读'`。

### lib/engine/mapping.js（产物映射）

**常量**

- `WIKI_ENTRY`（第 30 行）= `'CodeWiki.md'`（仓库根入口）。
- `WIKI_DIR`（第 31 行）= `'.codewiki'`。
- `WIKI_META_REL`（第 32 行）= `'.codewiki/_meta.yaml'`。
- `WIKI_UPDATE_RECORD_REL`（第 33 行）= `'.codewiki/temp/update-record.json'`。
- `WIKI_MODULES_REL`（第 34 行）= `'.codewiki/modules'`。

**函数**

- `moduleSlug(name)`（第 38–44 行）——模块名 → cw 惯用 kebab-case：trim、非 `[A-Za-z0-9]` 折叠成 `-`、去首尾 `-`、转小写。如 `'Core_Engine' → 'core-engine'`，`'Web Handler' → 'web-handler'`，`'a/b::c' → 'a-b-c'`，`'  ' → ''`。
- 私有：`posix`（第 46 行）、`normalizeSourceFiles`（第 48–58 行，去重、去 `./` 前缀、POSIX 化）、`sourceFilesOf`（第 62–72 行，只认组件→文件证据：组件 id 形如 `src/a.py::Class.method`，取 `::` 前文件；`componentFiles` 里有映射就取映射；无 `::` 且无映射则跳过，**不猜**）、`indexModuleTree`（第 76–96 行，把 `{name:{path,components,children}}` 树扁平成 `byName` Map，记录 `hasChildren`、`artifact`、父节点）。
- `mapFsoftOutput({pages, moduleTree, componentFiles, metadata, updateRecord, overviewName})`（第 115–268 行）——纯函数映射，不读写文件、不 spawn。
  - 入参：`pages`（页相对路径数组）、`moduleTree`（FSoft module_tree.json）、`componentFiles`（组件 id→仓库相对文件，**source_files 唯一证据来源**）、`metadata`（取 `generation_info` 的 `commit_id`/`layout`/`language`）、可选 `updateRecord`、`overviewName`（默认 `overview.md`）。
  - 出参（带 `contractVersion`）：`entry`（`{path, source}` 或 null）、`articles`（每篇 `{source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings}`）、`unmapped`（`{source, reason}`）、`meta`（`{lastCompiledCommit, layout, language}`）、`updateRecord`（`{path, outcome, pagesWritten, pagesRemoved, source}` 或 null）、`warnings`（全局告警）。
  - 四个硬规则（第 16–26 行）：**不臆造 source_files**、**不静默丢弃**（未映射页进 `unmapped` 带原因）、**不覆盖**（slug 冲突两页都进 `unmapped`，见第 200–211 行）、**不改技术内容**（只搬路径与类型）。
  - `pageKind` 取值：`'parent'`（有 children）、`'artifact'`（`artifact` 标志或名字匹配 `artifacts?`）、`'leaf'`（默认）。`attribution`：`'attributed'` 或 `'unattributed'`（whole-repository 模式模块树为 `{}` 时，第 153–187 行）。
  - slug 冲突（如 `A_B` 与 `A-B` 都 → `a-b`）时两页都进 `unmapped`，并回退先占用的那篇（第 165–175 行、第 200–211 行）。
  - 模块树里有但引擎没产出页的模块 → 进 `warnings`（第 234–242 行），由上层判 `partial`。

### 消费方与本模块契约对接的函数（简述，详见各自模块）

- `lib/engine/client.js`：`createProtocolReader`（第 39–186 行）在 `handleLine` 里用 `engineProgress` / `engineError` / `engineResult` 把引擎 JSON-lines 消息翻译成契约对象；`runEngine`（第 223–422 行）在超时/崩溃/取消时调用 `engineResult({outcome:'failed'|'cancelled', error})` 归一失败。
- `lib/engine/output.js`：`buildWritePlan`（第 162–173 行）调 `mapFsoftOutput`；`validateOutput`（第 184–282 行）复用其 `mapped`/`warnings`，把未映射页升级成 `unmapped-page` 问题。
- `lib/engine/quality-gate.js`：导入 `WIKI_ENTRY`/`WIKI_META_REL`（第 40 行），`toContractBlockers`（第 589–596 行）把 gate 的 blockers 翻成 `BLOCKER_KINDS`。
- `lib/engine/apply-plan.js`：导入 `BLOCKER_KINDS`（第 40 行），`toApplyBlockers`（第 309–320 行）把落地问题翻成契约 blocker 且断言 `kind` 必须落在枚举里。
- `lib/update-record.js`：`describeOutcome`（第 241–253 行）与 `describeEngineResult` 同一四态口径；`judgeOutcome`/`buildUpdateRecord` 产出与契约 `blockers` 同构的终态记录。

## Architecture

契约层本身是纯函数，被上下游夹在「进程边界」与「落盘边界」之间。下图标出各组件及其在文件/类中的位置，箭头表示「谁把数据喂给契约、谁消费契约」。

```text
            Python 引擎 (FSoft 原生)
                 │ stdout JSON-lines
                 ▼
   ┌─────────────────────────────────────┐
   │ lib/engine/client.js                  │
   │  createProtocolReader.handleLine      │
   │  runEngine (超时/崩溃/取消→失败归一)   │
   └───────────────┬─────────────────────┘
                   │  EngineProgress / EngineError / EngineResult
                   ▼
   ┌─────────────────────────────────────┐
   │ lib/engine/contract.js  (阶段0·契约)  │
   │  engineResult / engineProgress /      │
   │  engineError / validateEngineResult / │
   │  describeEngineResult + 枚举常量      │
   └───────────────┬─────────────────────┘
                   │  磁盘/旧版本对象
                   ▼
   ┌─────────────────────────────────────┐
   │ lib/engine/output.js                  │
   │  collectOutput→buildWritePlan         │
   │  调 mapFsoftOutput                    │
   └───────────────┬─────────────────────┘
                   │  FSoft docs 树
                   ▼
   ┌─────────────────────────────────────┐
   │ lib/engine/mapping.js  (阶段0·映射)   │
   │  mapFsoftOutput / moduleSlug          │
   │  → entry/articles/unmapped/meta       │
   └───────────────┬─────────────────────┘
                   │  mapped 写集
                   ▼
   ┌─────────────────────────────────────┐
   │ lib/engine/quality-gate.js            │
   │  gateNativeOutput→toContractBlockers  │
   └───────────────┬─────────────────────┘
                   │  report + 契约 blockers
                   ▼
   ┌─────────────────────────────────────┐
   │ lib/engine/apply-plan.js              │
   │  applyNativeOutput→toApplyBlockers    │
   │  (写集封闭·回滚·提交)                  │
   └───────────────┬─────────────────────┘
                   │  ApplyResult (outcome+blockers)
                   ▼
            落盘 .codewiki/ + CodeWiki.md
```

契约的两条不可变轴：

- **构造轴**（`engineResult` / `engineProgress` / `engineError`）：输入来自「信任边界内」（进程内调用方或已解析的协议消息），非法即抛错，逼调用方在源头修正。
- **校验轴**（`validateEngineResult`）：输入来自「信任边界外」（磁盘残留、旧版本、跨进程反序列化），不抛、返回逐条 `errors`（见 `lib/engine/contract.js` 第 184–186 行）。

`mapping.js` 的硬规则（不臆造 source_files / 不静默丢弃 / 不覆盖 / 不改正文）与 `contract.js` 的四态不变量共同构成「迁移安全边界」，上游 `quality-gate.js` 与 `apply-plan.js` 通过 `toContractBlockers` / `toApplyBlockers` 把各自领域的问题翻回同一套 `BLOCKER_KINDS`，使面板与终态判定共用一个词表。

## Data Flow

以一次全量 `generate` 为例，串起契约与映射的形状（行号均来自本模块读过的文件）：

1. **进程边界**：`runEngine`（`lib/engine/client.js` 第 223 行）spawn Python 引擎，逐行喂给 `createProtocolReader.push`（`client.js` 第 133 行）。`handleLine`（`client.js` 第 56 行）遇到 `progress` 调 `engineProgress`（`contract.js` 第 150 行）、`error` 调 `engineError`（`contract.js` 第 171 行）、`result` 调 `engineResult`（`contract.js` 第 97 行）。取消后到达的 result 记 `late-result` 并丢弃（`client.js` 第 104–109 行），退出码与语义分离（`client.js` 第 403–421 行）。
2. **产物读取**：`buildWritePlan`（`lib/engine/output.js` 第 162 行）先 `collectOutput`（第 91 行）递归扫 `docs/` 下的 `.md` 页并读四个 JSON（`metadata`/`module_tree`/`first_module_tree`/`update_record`），再交给 `mapFsoftOutput`。
3. **映射翻译**：`mapFsoftOutput`（`lib/engine/mapping.js` 第 115 行）把 `pages` + `moduleTree` + `componentFiles` + `metadata` 翻成 `{ entry, articles, unmapped, meta, updateRecord, warnings }`。其中 `entry` 落到 `CodeWiki.md`（第 142 行）、模块页落到 `.codewiki/modules/<slug>.md`（第 199 行）、`updateRecord` 原样搬到 `.codewiki/temp/update-record.json`（第 245–253 行）、`meta` 取 `generation_info` 的 commit/layout/language（第 260–264 行）。
4. **自洽校验**：`validateOutput`（`lib/engine/output.js` 第 184 行）复用 `mapped`，把未映射页升级成 `unmapped-page` 问题（第 228 行），把模块树缺失的页升级成 `article-missing`（第 231–233 行），并把 `source_files` 指向真实文件（第 236–248 行）。
5. **采用裁决**：`gateNativeOutput`（`lib/engine/quality-gate.js` 第 390 行）把产物问题分流成 defect / degradation / stale 三类，严格判定「三类皆空才 `done`」（第 525–536 行），再经 `toContractBlockers`（第 589 行）翻译成 `BLOCKER_KINDS`。
6. **落地归一**：`applyNativeOutput`（`lib/engine/apply-plan.js` 第 414 行）写盘→`cw index`→基线→提交，失败按不变量回滚；`toApplyBlockers`（第 309 行）把落地问题翻成契约 blocker，并断言 `kind` 必须落在 `BLOCKER_KINDS` 枚举里（第 313 行）。`done` 带 blockers 会被强制降级成 `partial`（第 453 行）。
7. **终态文案**：任何一层的 `outcome` 都可用 `describeEngineResult`（`contract.js` 第 223 行）或 `lib/update-record.js` 的 `describeOutcome`（第 241 行）渲染成四态中文，二者口径一致。

**两条关键数据流对照（契约不变量如何被消费）**：

| 数据流阶段 | 由谁产出契约对象 | 不变量如何被强制 |
| --- | --- | --- |
| 进程内构造 | `client.js` / `quality-gate.js` / `apply-plan.js` 调 `engineResult` | `done` 带 blockers 即抛错（`contract.js` 第 103–105 行） |
| 反序列化边界 | `validateEngineResult` 校验磁盘/旧版本对象 | `done+blockers`、`partial` 无 blockers、`writtenCount` 非数均给 errors（第 196–206 行） |
| 领域问题翻回契约 | `toContractBlockers` / `toApplyBlockers` | `kind` 必须落在 `BLOCKER_KINDS`，否则抛错（`apply-plan.js` 第 313 行） |

## Connections

- [[engine-client]] — 跨进程薄适配层，`createProtocolReader` / `runEngine` 是契约在「进程边界」上的唯一生产者（见 `lib/engine/client.js` 第 39、223 行）。
- [[engine-output]] — `collectOutput` / `buildWritePlan` / `validateOutput` 是 `mapFsoftOutput` 的消费者，产物自洽判定在此发生（见 `lib/engine/output.js` 第 91、162、184 行）。
- [[engine-quality-gate]] — `gateNativeOutput` 把产物问题分流成 defect/degradation/stale，并经 `toContractBlockers` 翻回契约（见 `lib/engine/quality-gate.js` 第 390、589 行）。
- [[engine-apply-plan]] — `applyNativeOutput` 落地器，经 `toApplyBlockers` 翻回契约并断言 `kind` 合法（见 `lib/engine/apply-plan.js` 第 414、309 行）。
- [[article-contract]] — 目标格式契约（frontmatter/围栏/死链/source_files）。`quality-gate.js` 第 39 行导入 `inspectArticle` / `fencesBalanced` / `parseFrontmatter`，与本文的「产物自洽」是两层不同的判定。
- [[update-record]] — `judgeOutcome` / `buildUpdateRecord` / `describeOutcome` 产出与契约 `blockers` 同构的终态记录，`describeOutcome`（第 241 行）与 `describeEngineResult`（第 223 行）四态口径一致。
- [[engine-manifest]] / [[engine-process-tree]] / [[engine-llm-bridge]] — 同属 `lib/engine/` 的邻近模块；manifest 与 process-tree 是 `client.js` 的上下游依赖（进程启动/进程树终止），但不直接消费本文契约对象。

## Known Issues

- **`describeEngineResult` 与 `describeOutcome` 存在两份平行四态文案**：分别在 `lib/engine/contract.js` 第 223 行和 `lib/update-record.js` 第 241 行，目前靠注释约定「同一口径」（contract.js 第 222 行）。两份实现任一改动都可能漂移，且 `cancelled` 在 `describeOutcome` 里没有「已写入篇数」的措辞（第 247 行），与 `describeEngineResult` 第 236 行不一致。
- **契约 `engine.deps.ok` 只认严格 `true`**：`engineResult` 第 134 行把 `'yes'` / `1` / 缺失都归一为 `false`；若 FSoft 未来换用非布尔真值表示通过，这条白名单归一会静默把「闭合」判成「未闭合」。该行为已用 `test-engine-contract.mjs` 第 99–100 行钉死（`sloppy` 用例断言 `'yes'` 归为 `false`）。
- **`mapFsoftOutput` 的 whole-repository 模式把归属证据缺失当成「可写」**：模块树为 `{}` 时页进 `articles` 且 `attribution='unattributed'`、`sourceFiles=[]`（mapping.js 第 153–187 行）。这本身是诚实记录，但下游 `quality-gate.js` 必须靠 `no-source-evidence` 降级来识别（第 497–501 行），若某消费方只看 `mapped.articles` 不看 warnings，会漏判增量归属不可用。
- **`validateEngineResult` 不递归校验 `engine` / `usage` 结构**：它只校验顶层字段（第 186–220 行），`engine.deps.ok` 与 `usage.*` 的形状由 `engineResult` 的白名单归一兜底；反序列化边界上若传入结构错乱的 `engine`，`validateEngineResult` 仍返回 `ok`（只要顶层字段合法），依赖 `engineResult` 只在构造路径调用这一假设。
- **slug 冲突回退逻辑会改写已发布文章数组**：`mapFsoftOutput` 第 165–175 行与第 200–211 行在发现冲突时 `articles.splice` 掉先占用的那篇，再把两篇都塞进 `unmapped`。若调用方已持有 `articles` 引用并假设「先到的页必在写集里」，会与之不一致——目前 `output.js` / `quality-gate.js` 都重新读 `mapped` 不缓存，故尚未触发。
