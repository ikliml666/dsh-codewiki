---
title: update_planning
type: module
source_files:
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/mapping.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/change-set.js
  - lib/engine/apply-plan.js
  - lib/engine/native-run.js
  - lib/symbols.js
  - lib/engine/contract.js
  - test-update-planner.mjs
  - test-update-record.mjs
tags: [incremental, planning, module-map, update-record, diff, baseline]
---

## Overview

`update_planning` 这一模块簇负责回答「**这次编译到底该做什么、为什么做、做完是不是真的做完了**」三件事，覆盖三个协同的纯逻辑层：

- **更新计划（`lib/update-planner.js`）**：把旧的「只要文章 source_files 命中变更就重写、否则丢弃」升级成「每篇文章该做什么 + 为什么」——显式的 `write` / `keep` / `delete` / `review` 四类 action，每个都带 `reason`；同时解决三个旧实现盲点：反向依赖看不见、新文件无归属、未重写页不查 stale（`lib/update-planner.js:1-16`）。
- **模块地图（`lib/update-planner.js` 的 `buildModuleMap` / `migrateModuleMap` / `sameModuleMap`，以及 `lib/engine/mapping.js` 的 FSoft→CodeWiki 产物映射）**：把「文章 → 源码文件 / 组件 / 模块」的归属关系落成一份版本化单状态文件 `temp/module-map.json`，让增量 ownership 可被重建与复用，而不是每次从文章 frontmatter 现猜。
- **更新记录与终态判定（`lib/update-record.js`）**：把 `ChangeSet + UpdatePlan + 逐篇结果` 收成一份版本化可机读 JSON（`temp/update-record.json`），并判定终态 `done` / `partial` / `failed` / `cancelled`，明确回答「能不能推进编译基线」——只有完整成功（`done`）才可以（`lib/update-record.js:1-24`）。

这三个层的共同设计目标是审计确认的历史缺陷：旧实现只会落 `writtenCount` / `failedCount` 两个数字，于是「1 篇成功 + 19 篇失败」也被报成 done，且基线照样前移（`lib/update-record.js:1-11`）。本模块把「部分完成」钉成显式 `partial` 终态，并规定任何未消化项都不得推进基线。

计划与记录层都是**纯函数 + 少量 IO 助手**，不依赖宿主服务，便于独立单测（`lib/update-planner.js:16`、`lib/update-record.js:12`）。

### lib/update-planner.js

**常量与状态文件路径**

- `UPDATE_PLAN_VERSION = 1`（行 23）：计划文件版本号。
- `MODULE_MAP_VERSION = 1`（行 26）：模块地图版本号。
- `MODULE_MAP_REL = 'temp/module-map.json'`（行 27）：模块地图相对 wiki 根的落盘路径。

**公开函数**

- `isSourcePath(p)`（行 33-36）：按扩展名判断一个路径是不是源码（对照 `SUPPORTED_EXTS` 的 key 集合 `SOURCE_EXTS`，行 30）。非源码文件（`.md/.json/.log…`）无归属时不触发全量重编，只记账 warning（见 `planUpdate` 兜底逻辑）。
- `realChangedIds(diff, oldGraph, newGraph, { ignoreCommentOnly = true })`（行 57-81）：从 `diffGraphs` 的 diff 里把「纯注释/排版改动」降级为 `cosmetic`，返回 `{ changed, cosmetic, real, structural }` 四组 id 集合。`structural` = 排除 cosmetic 后、且属于 `interface/added/deleted/renamed/edge` 的组件（行 77-79）。注意它复用 `graph-diff.js` 的 `codeHash` 与 `docstring` 比较，不另造哈希规则（行 55-56、66-70）。
- `dependentsOf(graph, ids)`（行 85-101）：反向依赖索引——返回「被变更的组件（id 或文件路径）被哪些组件使用」的 Map。边的两种写法（`dependsOn` 里的组件 id 与文件路径）都认（行 83-84），保证「被依赖方变了 → 使用方文章要重写」。
- `scanStaleArticle(article, { deletedComponents, renamedComponents, linkExists })`（行 106-145）：单篇文章的 stale scan 纯函数。`linkExists(target)` 由调用方注入（wiki 里是否有这篇）。检测三类问题并 push 到 `issues`：`deleted-symbol`（正文引用了已删除符号，基于正则匹配符号名/尾部，行 112-117）、`renamed-symbol`（引用了已改名符号，行 118-124）、`dead-link`（`[[name]]` 与 markdown 相对 `.md` 链接指向不存在的文章，行 126-138）。返回 `{ issues, needsRewrite }`：引用已删/改名符号 → `needsRewrite: true`（内容已错，必须重写）；死链只要求 `review`（链接目标可能只是被改名成等价标题，行 141-144）。
- `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（行 156-436）：**计划主入口（纯函数）**。入参见行 147-155。关键行为：
  - `fileLevel` 降级（行 179）：当 `options.fileLevel === true` 或 `oldGraph` / `newGraph` 任一为 null 时，退化为文件级判定，不再做符号级 diff。
  - 反向依赖闭包（行 209-219）：只对 `structural` 变更做——实现细节变了不该连带重写所有引用方文章。
  - 逐篇 action（行 238-347）：缺 source_files → `review` + `needsFull`（行 253-258）；source_files 有文件被删 → `write`（行 270-279）；有改名 → `write`（行 280-289）；无符号可判 → 文件级判定命中则 `write`、否则 `keep`（行 290-304）；自身/依赖命中 → `write`（行 305-318）；未命中则 stale scan（行 319-344）：`needsRewrite` → `write`，仅 `dead-link` 等有 issue → `review`，否则 `keep`。
  - 无归属变更兜底（行 349-392）：源码文件变了但没文章认领 → 进 `unmappedChanges` 并要求 `needsFull`（保守，绝不静默丢弃）；新文件按最长公共目录路由给同模块已有文章（行 359-380）；非源码文件只进 `warnings`。`needsFull` 判定在行 392-397。
  - 必需文章清单 `requiredNames`（行 404-408）：只有 `write` 动作才算「本次必须产出」（行 399-403 注释解释为何 keep/review 不算，否则正常增量会误判 missing-article 而落 partial）。
  - 返回 `UpdatePlan` 对象（行 410-435）：含 `version`、`fileLevel`、`changedComponents`、`cosmeticComponents`、`structuralComponents`、`counts`、`actions`、`summary`、`unmappedChanges`、`unmappedSourceChanges`、`routedTo`、`missingSources`、`missingRequired`、`requiredNames`、`warnings`、`needsFull`、`fullReason`、`hasChanges`。
- `buildModuleMap({ articles, graph, plan, now })`（行 442-468）：从真实 plan / 符号图重建「文章 → { sources, components, module }」。模块归属优先取 full 编译 `plan.modules` 里的模块名，其次用 source_files 公共目录（行 457-464）。返回 `{ version, generatedAt, articles }`。
- `migrateModuleMap({ articles, now })`（行 472-481）：旧 wiki 没有 module-map 时从 frontmatter 保守迁移，只记 `sources`、组件留空（`components: []`），绝不臆造（行 470-478）。返回带 `migratedFromFrontmatter: true` 的对象。
- `sameModuleMap(a, b)`（行 484-492）：比较两份 module-map 的**实质内容**（忽略 `generatedAt`），避免为空转提交写文件（行 483）。

**模块内辅助函数**（非导出，供 `planUpdate` 使用）

- `dirOf(p)`（行 38-41）：取相对路径的目录段。
- `commonDir(a, b)`（行 44-53）：两路径的最长公共目录（至少一级才算同模块）。
- 局部集：`SOURCE_EXTS`（行 30，`Set([...SUPPORTED_EXTS.keys()])`）。

### lib/update-record.js

**常量**

- `UPDATE_RECORD_VERSION = 1`（行 17）：记录文件版本号。
- `UPDATE_RECORD_REL = 'temp/update-record.json'`（行 18）：记录相对 wiki 根的落盘路径。
- `TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled'])`（行 24）：终态词表。
- `isTerminalStage(stage)`（行 26-28）：判断某 stage 是否终态。

**公开函数**

- 终态语义（行 20-24）：`done` = 完整成功（必需文章全写好、变更全有归属、质量闸门全过）；`partial` = 部分完成（已成功文章可入库，但「全部已消化」不成立，基线不得前移）；`failed` = 失败（无交付成果）；`cancelled` = 被取消。
- `judgeOutcome({ plan, results, options })`（行 37-128）：**从逐篇结果与计划算终态（纯函数）**。逐条记账 blockers（行 56-110）：① 计划内必需文章缺页 / 失败分开记 `missing-article`（行 56-75，含无 plan 通道用 `options.expectedNames` 判缺页，行 71-75）；② 逐篇失败 `article-failed`（行 78）；③ 变更无归属 `unmapped-changes`（只算源码变更，行 83-91）；④ 缺 source_files `missing-sources`（行 92-97）；⑤ 质量闸门 `quality`（行 100-102）；⑥ 索引/入口 `index`（行 105）；⑦ 调用方补充 `extra`（行 108-110）。终态规则（行 112-118）：`blockers/failed/missing/requiredMissing` 全空 → `done`；否则只要有成果（`writtenCount > 0` 且非 `nothingDelivered`）→ `partial`；零成果且有失败/缺页/阻塞 → `failed`。`canAdvanceBaseline` 只在 `done` 且无 blocker 时为 true（行 124）。返回 `{ outcome, blockers, canAdvanceBaseline, writtenCount, failedCount }`。
- `buildUpdateRecord({ jobId, scope, changeSet, plan, results, outcome, wikiPath, qualityIssues, notes, startedAt, finishedAt })`（行 131-211）：组装可序列化记录。内部调 `judgeOutcome` 得到终态（行 144），并把 changeSet（state/计数/sourceChanges，行 153-169）、plan（**每个 action 都带 `reason`**，行 170-195）、results（行 196-201）、qualityIssues（行 202）收拢。**关键不变量**：job 里只存路径与摘要，不塞整张符号图与任务快照（行 130、183-184 测试断言）。返回含 `version / jobId / scope / startedAt / finishedAt / baseCommit / headCommit / changeSet / plan / results / qualityIssues / outcome / blockers / canAdvanceBaseline / writtenCount / failedCount / notes / wikiPath` 的对象（行 145-210）。
- `recordPath(wikiPath)`（行 213-215）：返回 `temp/update-record.json` 的完整路径。
- `saveUpdateRecord(wikiPath, record, fsImpl = fs)`（行 217-227）：落盘 IO 助手。无 wiki 路径返回 `{ ok:false, reason }`（行 218）；否则 `mkdirSync` + `writeFileSync`（带结尾换行）。
- `loadUpdateRecord(wikiPath, fsImpl = fs)`（行 229-238）：回读 IO 助手。**版本不符（`version !== UPDATE_RECORD_VERSION`）直接返回 null**（行 233）——避免旧格式被当新格式读。
- `describeOutcome(outcome, blockers)`（行 241-253）：面板/工具文案，`done` / `partial` / `cancelled` / `failed` 四态必须一眼能分，并带首个 blocker 原因。

### lib/engine/mapping.js

本文件负责 FSoft 原生产物 → CodeWiki 仓库结构（`.codewiki/` + 顶层 `CodeWiki.md`）的**格式翻译**（阶段 0，行 1-26）。它是迁移里唯一一处格式翻译，边界刻意收窄：只搬路径与类型、不臆造 source_files、不静默丢弃、不覆盖、不改技术内容（硬规则见行 16-26）。

**常量（输出路径锚点）**

- `WIKI_ENTRY = 'CodeWiki.md'`（行 30）
- `WIKI_DIR = '.codewiki'`（行 31）
- `WIKI_META_REL = '.codewiki/_meta.yaml'`（行 32）
- `WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'`（行 33）：FSoft `update_record.json` 原样搬运到此路径。
- `WIKI_MODULES_REL = '.codewiki/modules'`（行 34）

**公开函数**

- `moduleSlug(name)`（行 38-44）：模块名 → kebab-case 文件名（ASCII 保留，其余折叠成 `-`），与 cw 现有文章命名一致（`core-application.md` 等）。
- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（行 115-268）：**纯函数主入口**，把 FSoft 的 docs 树映射成 cw 写集描述。
  - 逐页处理（行 135-232）：`overview.md` 唯一映射为入口 `CodeWiki.md`（重复则后者进 `unmapped`，行 136-144）；非 `.md` 页进 `unmapped`（行 148-151）；whole-repository 模式下 `module_tree.json` 为 `{}` 但该页名存在时，按 `attribution: 'unattributed'` + 空 `sourceFiles` 进写集（不臆造，行 153-188）；模块树里找不到的页进 `unmapped`（行 189-192）；`slug` 冲突（A_B 与 A-B 都 → a-b）时两页都进 `unmapped`（不覆盖，行 200-211）。
  - `sourceFilesOf(components, componentFiles)`（行 62-72）：**唯一**的 source_files 证据来源——只认组件 id → 文件映射（无证据则宁缺勿造，行 17-20）；组件 id 形如 `src/a.py::Class.method`，取 `::` 前文件部分。
  - `indexModuleTree(moduleTree)`（行 76-96）：把 FSoft `module_tree.json`（`{name: {path, components, children}}`）索引成 `byName` Map。
  - `normalizeSourceFiles(list)`（行 48-58）：source_files 去重 + 规整（去 `./` 前缀、反斜杠转 POSIX）。
  - 模块树里有、但引擎没产出页的模块 → 进 `warnings`（行 234-242）。
  - 返回的 `updateRecord`（行 244-253）把 FSoft 的 `update_record.json` 搬成 `{ path, outcome, pagesWritten, pagesRemoved, source: 'incremental' }`。
  - 返回值（行 255-267）：`{ contractVersion, entry, articles, unmapped, meta: {lastCompiledCommit, layout, language}, updateRecord, warnings }`。每个 article 形如 `{ source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings }`，`pageKind` 由节点的 `artifact` / `hasChildren` 决定：`artifact` → `'artifact'`、`hasChildren` → `'parent'`、否则 `'leaf'`（行 222-231）。

> 注意：本模块的 `WIKI_UPDATE_RECORD_REL` 与 `lib/update-record.js` 的 `UPDATE_RECORD_REL` 指向**同一文件** `temp/update-record.json`——mapping 负责「搬运」FSoft 的 update_record，update-record.js 负责「生成与终态判定」CodeWiki 自己的 update-record。

### Shared/supporting symbols

计划与记录层复用的底层符号（`lib/graph-diff.js`，移植自 FSoft `graph_diff.py`，与上游逐位对齐，见行 1-11）：

- `diffGraphs(oldGraph, newGraph, opts)`（行 447-564）：组件级 diff 主入口。签名变 → `interface`、实现变 → `body`、仅依赖变 → `edge`；删除 + 新增按 `body` 相似度（`pairRenames`，阈值 `DEFAULT_TAU_REN=0.8`，行 368-407）近似配对 → `renamed`。返回 `emptyGraphDiff()` 形状（行 413-423）：`{ added, deleted, interface, body, edge, renamed:Map, records:Map }`。
- `changedIds(d)`（行 436-440）：合并 diff 全部变更 id 成 Set。
- `graphDiffCounts(d)`（行 425-434）：把 diff 的 Set/Map 计成 `{ added, deleted, interface, body, edge, renamed }` 数字对象——正是 `planUpdate` 返回的 `counts`（行 184、191、416）。
- `codeHash(node)`（行 108-111）：剥注释后的「代码本体」SHA1，**只改动注释时 `codeHash` 不变**——`realChangedIds` 与 `filterStaleTasks` 用它做纯注释降级判据。
- `bodyHash(node)`（行 121-126）：含 docstring 的归一化哈希（快照回读节点走固化缓存分支）。
- `signatureChanged(a, b)`（行 136-145）：参数 / 基类是否变化。

路径归一依赖 `lib/incremental.js` 的 `normRel(p)`（行 118-120，把反斜杠与 `./` 前缀规整成 POSIX 相对路径），被 `planUpdate` 的 `articles` / `moduleMap` / `changeSet` 各处反复调用。

测试入口：`test-update-planner.mjs`（覆盖反向依赖、新文件归属、stale scan、无归属变更、文件级降级等，行 1-299）与 `test-update-record.mjs`（覆盖 `done`/`partial`/`failed`/`cancelled` 终态、各类 blocker、`buildUpdateRecord` 摘要、`save`/`load` 往返，行 1-218）。

## Architecture

三层的依赖关系：计划层（`update-planner.js`）与记录层（`update-record.js`）互不依赖，都只依赖底层符号/图工具（`graph-diff.js` / `incremental.js` / `symbols.js`）；`engine/mapping.js` 只服务于「FSoft→CodeWiki 迁移」这一个特殊通道，与计划/记录层共享 `temp/update-record.json` 这个落盘点但职责不同。

```text
┌─────────────────────────────┐   collects    ┌──────────────────────────┐
│ change-set.js (ChangeSet)   │──────────────►│  lib/update-planner.js   │
│  committed/staged/          │  changeSet    │  planUpdate()            │
│  unstaged/untracked         │               │                          │
└─────────────────────────────┘               │  realChangedIds()        │
                                               │  dependentsOf()          │
┌─────────────────────────────┐  old/new graph│  scanStaleArticle()      │
│ symbols.js + graph-diff.js  │──────────────►│  buildModuleMap()        │
│  Map<id,node>  diffGraphs() │  graphs       │  migrateModuleMap()      │
└─────────────────────────────┘               │  sameModuleMap()         │
                                               │  (MODULE_MAP_REL)        │
              articles ───────────────────────►│                          │
                                               └───────────┬──────────────┘
                                                           │ UpdatePlan
                                                           ▼
                              ┌────────────────────────────────────────────┐
                              │  lib/update-record.js  judgeOutcome()       │
                              │  buildUpdateRecord() → UPDATE_RECORD_REL    │
                              │  save/load/describeOutcome                  │
                              └────────────────────────────────────────────┘

   ┌───────────────────────────────────────────────────────────────┐
   │ lib/engine/mapping.js  mapFsoftOutput()  (迁移专用阶段 0)        │
   │   FSoft docs 树 → .codewiki/ + CodeWiki.md；搬运 update_record  │
   └───────────────────────────────────────────────────────────────┘
```

组件数 ≥3、流程非平凡，故画框图（见上）。`planUpdate` 内部已是一个多分支纯函数（行 156-436）；`judgeOutcome` 把 7 类 blocker 合成终态（行 56-118）；`mapFsoftOutput` 是迁移通道的独立纯函数（行 115-268）。

## Data Flow

一次增量编译里，本模块簇的数据流（生产通道见 `lib/engine/native-run.js` 阶段的「增量决议 → 引擎 → gate → apply」直线，行 22-40）：

1. **采集变更**：`lib/change-set.js` 的 `collectChangeSet` 把 committed/staged/unstaged/untracked 四路合成 `ChangeSet`（含 `baseCommit`、`sourceChanges`、`deleted`、`renamed`、`untracked` 等）。
2. **取图**：`lib/symbols.js`（`extractRepoGraph` / `resolveImportEdges`）产出 `oldGraph` / `newGraph`（`Map<id,node>`）；`lib/incremental.js` 负责图快照的瘦身存取。
3. **生成计划**：调用 `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`lib/update-planner.js:156`）。其中 `articles` 取自 `.codewiki/modules/*.md` 的 frontmatter `source_files`；`moduleMap` 来自上轮 `buildModuleMap` / `migrateModuleMap`（`temp/module-map.json`）。产出 `UpdatePlan`（`actions[]` 每个带 `action`/`reason`/`changedComponents`/`impactedBy`/`newFiles`/`staleIssues`）。
4. **重建模块地图**：full 编译成功或增量收尾时，用真实 plan / 图调 `buildModuleMap`（`lib/update-planner.js:442`），写 `temp/module-map.json`（用 `sameModuleMap` 判断是否内容变化、避免空转提交）。
5. **落地与逐篇结果**：`lib/engine/apply-plan.js` 的 `applyNativeOutput` 写盘 → `cw index` → 基线 → 提交，产出逐篇 `{ name, ok, error? }` 结果。
6. **判定终态与写记录**：把 `ChangeSet + UpdatePlan + results` 喂给 `buildUpdateRecord`（内部 `judgeOutcome`）得到 `outcome` / `blockers` / `canAdvanceBaseline`（`lib/update-record.js:38`、`37`）。仅当 `done`（且 `canAdvanceBaseline=true`）才允许 `cw meta update` 推进基线；否则基线保持不动，下一轮 change-set 仍从旧基线算，变化不丢（`lib/engine/native-run.js:32-36`）。记录落 `temp/update-record.json`（`saveUpdateRecord`）。

**迁移专用通道**：`lib/engine/mapping.js` 的 `mapFsoftOutput` 在阶段 0 把 FSoft `docs` 树翻译为 cw 写集（`articles`/`entry`/`unmapped`/`meta`），并把 FSoft 的 `update_record.json` 原样搬进 `WIKI_UPDATE_RECORD_REL`（= `temp/update-record.json`）——注意它只是「搬运」既有 update_record，终态判定仍由步骤 6 的 `judgeOutcome` 负责。

## Connections

- [[change-set]] — 提供 `planUpdate` 所需的 `ChangeSet`（四路变更），本模块的 `unmapped` 兜底与它同源。
- [[graph-diff]] — 提供 `diffGraphs` / `changedIds` / `graphDiffCounts` / `codeHash` 等，是 `realChangedIds` 与 `filterStaleTasks` 的底层判据。
- [[incremental]] — 提供 `normRel` 路径归一与图快照存取；`planUpdate` 的 `fileLevel` 降级与它的 `filterStaleTasks` 是同套判据（`lib/update-planner.js:179`、`lib/incremental.js:140-193`）。
- [[symbols]] — `extractRepoGraph` / `resolveImportEdges` 产出 `oldGraph`/`newGraph`，且依赖边（`dependsOn`）是 `dependentsOf` 反向依赖生效的前提（`test-update-planner.mjs:21-28`）。
- [[engine-quality-gate]] — `judgeOutcome` 的 `quality` blocker 来自质量闸门结果（`lib/update-record.js:100-102`）。
- [[engine-apply-plan]] — 落地器消费的 `applyNativeOutput` 产出逐篇 `results`，且本身也有独立的 partial/done 不变量（`lib/engine/apply-plan.js:495-529`、行 557-564）。
- [[engine-native-run]] — 阶段 4 编排把「计划 → 引擎 → gate → 记录/apply」粘成一条直线，并固定终态裁决链（`lib/engine/native-run.js:1-40`）。
- [[engine-mapping]] — `lib/engine/mapping.js` 的本模块 Mapping 子能力（FSoft→CodeWiki 产物映射）。
- [[engine-contract]] — `WIKI_*` 常量、`BLOCKER_KINDS` 与记录里的 blocker 词表同源（`lib/engine/mapping.js:28`、`lib/engine/apply-plan.js:40`）。

## Known Issues

- **反向依赖依赖图里真的有 `dependsOn` 边**：`dependentsOf` 只对 `structural` 变更做闭包，若符号图没有建依赖边（`lib/update-planner.js:395-397` 会推 `warnings`），则「接口变了依赖方文章不重写」必然发生——旧链路（`extractCurrentGraph`）曾经不建边，代码如实记账不假装做到。这是**已识别并显式预警**的行为，不是 bug。
- **`unmappedChanges` 与非源码文件的边界**：非源码文件（README / `CodeWiki.md` / `CHANGELOG`）无文章引用是常态，只能进 `warnings` 而**不能**混进 `unmappedChanges`/`unmappedSourceChanges`，否则每次正常增量都会因 `CodeWiki.md` 无归属而落 `partial`（踩过的坑，见 `lib/update-planner.js:421-423`、`lib/update-record.js:80-84`）。
- **`requiredNames` 只含 `write` 动作**：`keep`/`review` 不算「本次必须产出」，否则两篇 keep 会被当成 missing-article 而误判 partial（踩过的坑，见 `lib/update-planner.js:399-403`）。
- **`module-map` 与 `update-record` 两份状态文件的版本独立**：`MODULE_MAP_VERSION`（行 26）与 `UPDATE_RECORD_VERSION`（行 17）各自演进；`loadUpdateRecord` 版本不符直接返回 null（行 233），`sameModuleMap` 只比实质内容忽略 `generatedAt`（行 484-492）。读写两端必须同源版本，不能混用。
- **`mapFsoftOutput` 是迁移专用、非日常增量路径**：它只搬路径与类型、不改技术内容；其 `WIKI_UPDATE_RECORD_REL` 与 `update-record.js` 的 `UPDATE_RECORD_REL` 指向同一文件，但日常增量流程**不**走 mapping，直接由 `buildUpdateRecord` 生成，避免重复/覆盖。
- **纯注释降级依赖注释写在函数体内**：tree-sitter 里函数前的注释是 sibling 节点、不在节点文本内，所以「只补了一行函数前注释」不会进入 `codeHash` 比较、可能仍触发重写（见 `test-update-planner.mjs:33-35` 注释）。这是 tree-sitter 提取粒度限制，判定层已文档化。
- **无禁用/注释掉的功能**：本模块三个文件的导出函数全部在生产链路或测试中被使用，没有整段被注释禁用的情况（如需确认某函数是否接线，见 [[engine-native-run]] 与 [[engine-apply-plan]]）。
