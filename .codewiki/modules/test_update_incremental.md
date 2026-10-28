---
title: test_update_incremental
type: module
source_files:
  - test-incremental.mjs
  - test-update-planner.mjs
  - test-prune-orphans.mjs
  - test-incremental-e2e.mjs
  - test-update-record.mjs
  - lib/incremental.js
  - lib/update-planner.js
  - lib/graph-diff.js
  - lib/symbols.js
  - lib/update-record.js
  - index.js
tags: [test, incremental, planner, pruning, snapshot, update-record]
---

## Overview

本模块（`test_update_incremental`）是 dsh-codewiki 增量更新能力的**测试簇**，覆盖三类核心能力：

1. **符号级增量判定**（`lib/incremental.js`）：用组件级 hash + 签名比对，把「文件变了但模块接口没变」的改动过滤掉，只留真正改变架构描述的变更（interface / added / deleted / renamed / body），避免每次都重写文章。主测试见 `test-incremental.mjs` 与端到端 `test-incremental-e2e.mjs`。
2. **增量计划器**（`lib/update-planner.js`）：在「要不要重写」之上补上「每篇该做什么、为什么」——反向依赖影响、新文件归属、未重写页 stale scan、无归属变更兜底。主测试见 `test-update-planner.mjs`。
3. **孤儿清理与终态记录**（`index.js` 的 `pruneOrphanModules` 与 `lib/update-record.js`）：清理增量/全量后变成孤儿的模块文章（只删 orphan、绝不误删），以及把一次编译的终态钉成 done / partial / failed。测试见 `test-prune-orphans.mjs` 与 `test-update-record.mjs`。

这些测试共同把上游 FSoft-AI4Code/CodeWiki 引入的三处缺陷钉死：
- 旧 `filterStaleTasks` 只从文章既有 `source_files` 收组件，命中就写、没命中就丢——依赖方文章不重写、新文件被静默丢弃、未重写页从不检查是否已过期（`lib/update-planner.js:4-14` 审计确认）。
- 旧实现只有 `writtenCount === 0` 才失败，1 篇成功 19 篇失败也记作「完成」并照常推进基线（`test-update-record.mjs:2-6`）。
- 模块划分随聚类变化，旧文章成为死文章（`index.js:253-270` 注释详述）。

每个测试文件都用统一的 `check(label, fn)` 范式（`test-incremental.mjs:16-19` 等），通过即打印 `PASS`，失败收集进 `fails` 末尾统一 `process.exitCode = 1`。

## Key Components

### 测试函数（按文件）

#### test-incremental.mjs（符号级增量：快照存取 + 组件级变更折算 + 保留/跳过判定）

导入源：`lib/incremental.js`（slimGraph / graphFromSnapshot / snapshotPath / loadSnapshot / saveSnapshot / filterStaleTasks / describeChange / normRel / componentsByFile / SNAPSHOT_VERSION / sameSnapshotContent）、`lib/symbols.js`（extractRepoGraph）、`lib/graph-diff.js`（bodyHash / stripComments）。

- `graphOf(files)` — `test-incremental.mjs:26-29`：把 `{path: content}` 喂给 `extractRepoGraph` 取符号图 `Map<id,node>`，是其余用例的图构造器。
- `slimGraph 不含源码，但带固化 bodyHash` — `test-incremental.mjs:31-40`：断言快照 JSON 不含源码全文，但每个组件带 40 字符 sha1 `bodyHash`，且 `version === SNAPSHOT_VERSION`。
- `快照往返后 bodyHash 保持一致` — `test-incremental.mjs:42-47`：`slimGraph(g)` → `graphFromSnapshot` → 两端 `bodyHash` 相等（不读源码也能判实现变更）。
- `只有注释变更：实现 hash 变、签名不变 → 记为 body` — `test-incremental.mjs:49-59`：`filterStaleTasks` 把 A→A2（仅改实现细节、签名不变）判成 `counts.body === 1`、`counts.interface === 0`，且 `keep` 带 `changedComponents`。
- `签名变更记为 interface` — `test-incremental.mjs:61-67`：A→A3（加 `currency` 参数）→ `counts.interface === 1`，`describeChange` 含「接口变」。
- `只改注释：body 类变更被降级，文章不重写` — `test-incremental.mjs:77-88`：**核心收益**：A→A_COMMENT_ONLY（仅加注释行，`bodyHash` 变了但 `codeHash` 不变）→ `keep.length === 0`、`dropped.length === 1`、`cosmeticOnly` 含该组件。
- `改代码：仍然是 body 类变更，文章必须重写` — `test-incremental.mjs:90-97`：A→A_CODE_CHANGED（改了 `return ... * 2`）→ 仍记 `body`、不误判为纯注释。
- `改签名 + 改注释：interface 优先` — `test-incremental.mjs:99-107`：含 both 的用例 → `interface` 不被注释降级放行。
- `老快照没有 codeHash 时退回原行为` — `test-incremental.mjs:109-118`：抹掉 `codeHash`/`sourceCode` 后，纯注释改动保守保留（`keep.length === 1`），不误跳过。
- `stripComments 去掉行/块注释` — `test-incremental.mjs:120-126`：`// 尾注`、`/* 块 */`、`# py 注释` 均被剥离，代码本身不同必须区分开。
- `文件内容变了但符号完全没变 → 跳过该文章` — `test-incremental.mjs:128-140`：只动空白/末尾换行 → `keep.length === 0`、`dropped.length === 2`、`describeChange` 含「无实质变更」。
- `新增文件里的组件算 added` — `test-incremental.mjs:142-150`：新加 `src/c.js` 含 `Invoice` → `counts.added >= 1`、`change.added` 含 `src/c.js#Invoice`。
- `源文件被删 → deleted 计入变更` — `test-incremental.mjs:152-158`：`src/c.js` 被删 → `counts.deleted >= 1`、`change.deleted` 含该 id。
- `source_files 无符号 → 保守保留并标 symbolFallback` — `test-incremental.mjs:160-167`：配置类文件（package.json）→ `keep` 且 `symbolFallback === true`。
- `路径分隔符与 ./ 前缀都能归一` — `test-incremental.mjs:169-176`：`normRel('.\\src\\a.js')` 与 `normRel('./src/a.js')` 都归一成 `src/a.js`。
- `多源文件的文章：任一源变动即保留` — `test-incremental.mjs:178-184`：`b.js` 新增 `extra` → `keep[0].changedComponents` 含 `src/b.js#extra`。
- `componentsByFile 按文件聚合组件 id` — `test-incremental.mjs:186-191`：返回 `Map<file, id[]>` 且键排序正确。
- `快照落盘与回读（含目录自动创建）` — `test-incremental.mjs:193-204`：`saveSnapshot(wiki, slimGraph(g, {commit}))` 后 `loadSnapshot` 回读 `commit` 与 `components`。
- `快照版本不符/坏 JSON → 视作没有` — `test-incremental.mjs:206-214`：`version: 999` 与 `{not json` 都使 `loadSnapshot` 返回 `null`（退化成全量）。
- `改名归到 renamed 而非增删两条` — `test-incremental.mjs:216-225`：`old.js`→`new.js`（正文相同）→ `counts.renamed === 1`、`added==0`、`deleted==0`。
- `快照内容比较忽略 generatedAt/commit` — `test-incremental.mjs:227-237`：`sameSnapshotContent` 只比实质字段，元数据/顺序不同视为没变；`bodyHash` 或依赖边变了视为变了；`null` 与对象相比为 `false`。

#### test-update-planner.mjs（增量计划器：反向依赖 / 新文件归属 / stale scan / 无归属）

导入源：`lib/update-planner.js`（planUpdate / realChangedIds / dependentsOf / scanStaleArticle / buildModuleMap / migrateModuleMap / sameModuleMap / isSourcePath / MODULE_MAP_VERSION）、`lib/symbols.js`（extractRepoGraph / resolveImportEdges）、`lib/graph-diff.js`（diffGraphs）。辅助 `graphOf` 在 `test-update-planner.mjs:22-28`，额外 `resolveImportEdges` 建依赖边。

- `接口变更 → 自身文章写；反向依赖文章也写` — `test-update-planner.mjs:47-61`：STRINGS_V1→V2（加 `sep`）→ `util.md` 与 `billing.md` 双双 `write`，`impactedBy` 记录影响源，`summary.write === 2`、`needsFull === false`。
- `纯注释变更 → 两篇都 keep` — `test-update-planner.mjs:63-73`：STRINGS_COMMENT → `summary.write === 0`、`summary.keep === 2`、`cosmeticComponents` 记录降级组件。
- `实现细节变更 → 只重写自身文章，不波及依赖方` — `test-update-planner.mjs:75-86`：IMPL（签名不变）→ `util.md` write、`billing.md` keep。
- `新文件无归属 → 同模块路由给已有文章` — `test-update-planner.mjs:88-104`：`src/util/dates.js` 新文件 → 路由到 `util.md`、`newFiles` 含该文件、`routedTo.length === 1`、`unmappedChanges` 为空。
- `新文件完全无归属 → unmappedChanges + needsFull` — `test-update-planner.mjs:106-120`：`tools/build.rs`（非模块目录）→ `unmappedChanges === ['tools/build.rs']`、`needsFull === true`、`fullReason` 含「无文章归属」。
- `非源码文件无归属：只记账 warning` — `test-update-planner.mjs:122-134`：`notes/scratch.md` → 仍进 `unmappedChanges` 但 `needsFull === false`，`isSourcePath` 对 `.md` 返回 `false`。
- `source_files 有文件被删除 → write` — `test-update-planner.mjs:136-146`：删除 `strings.js` → action `write`、reason 含「已被删除」。
- `source_files 有文件被改名 → write` — `test-update-planner.mjs:148-162`：改名 `strings.js`→`str.js` → action `write`、reason 含「改名」。
- `文章缺 source_files → review + needsFull` — `test-update-planner.mjs:164-175`：`sources: []` → action `review`、`needsFull === true`、`missingSources.length === 1`。
- `stale scan：未重写页正文仍引用已删除符号 → 升级为 write` — `test-update-planner.mjs:177-195`：legacy 文章正文提 `legacyOnly()`，符号被删 → 升级 `write`、reason 含「stale scan」。
- `stale scan：死链 → review` — `test-update-planner.mjs:197-210`：正文 `[[modules/gone]]` 死链 → action `review`、`staleIssues` 含 `dead-link` 类。
- `文件级降级（无图/关闭符号增量）` — `test-update-planner.mjs:212-224`：`oldGraph/newGraph === null` 且 `options.fileLevel` → 仍见自身源文件变化判 `write`。
- `无变更 → 全部 keep` — `test-update-planner.mjs:226-232`：`summary.keep === 2`、`write === 0`、`needsFull === false`。
- `计划可 JSON 序列化` — `test-update-planner.mjs:234-240`：`JSON.parse(JSON.stringify(plan))` 往返后字段一致（要落 update-record）。
- `dependentsOf：反向边索引` — `test-update-planner.mjs:242-248`：认 id 与文件路径两种依赖写法，能找到依赖 `slugify` 的组件。
- `scanStaleArticle 空内容` — `test-update-planner.mjs:250-254`：`content: ''` → `issues === []`、`needsRewrite === false`。
- `buildModuleMap：记录文章→sources/components/module` — `test-update-planner.mjs:256-264`：`version === MODULE_MAP_VERSION`、entry 含 `sources` 与≥1 个 `components`，可 JSON 往返。
- `migrateModuleMap：旧 wiki 无 module-map 时迁移` — `test-update-planner.mjs:266-271`：`migratedFromFrontmatter === true`、components 留空不臆造。
- `sameModuleMap：忽略 generatedAt` — `test-update-planner.mjs:273-280`：不同 `now` 视为相同；文章集不同则不同。
- `realChangedIds：interface 进 structural、纯注释进 cosmetic` — `test-update-planner.mjs:282-293`：V1→V2 → `structural` 含 1、`cosmetic` 空；V1→COMMENT → `cosmetic` 含 1、`real` 空。

#### test-prune-orphans.mjs（孤儿清理安全边界，删文件逻辑）

导入源：`index.js` 的 `pruneOrphanModules`。辅助 `makeWiki()`（`test-prune-orphans.mjs:19-30`）造 `modules/` 4 篇 + `concepts/` 1 篇 + 根 `_architecture.md` 1 篇。

- `全量编译：删掉规划外的孤儿` — `test-prune-orphans.mjs:33-42`：`kind:'full'` + `plan.modules:[keep]` → `removed` = 三篇 orphan，`ls` 只剩 `keep.md`。
- `全量编译：本次写过但失败的文章要保留` — `test-prune-orphans.mjs:44-55`：`articles` 含 `ok:false` 的 `written-failed.md` → 不删。
- `增量编译（kind=stale）一律不动` — `test-prune-orphans.mjs:57-68`：`kind:'stale'` → `removed.length === 0`、`skipped` 含「非全量」。
- `无 plan.modules 时不删` — `test-prune-orphans.mjs:70-77`：`plan: null` → 不动、`skipped` 含「无完整模块清单」。
- `modules 清单为空数组时不删` — `test-prune-orphans.mjs:79-85`：`plan.modules: []` → 最危险输入也一个不动。
- `concepts/ 与 _architecture.md 永不被碰` — `test-prune-orphans.mjs:87-96`：两者在 full 后仍存活。
- `modules 目录不存在时安全返回` — `test-prune-orphans.mjs:98-102`：返回 `removed.length === 0`。
- `只删 .md，不碰同目录其他文件` — `test-prune-orphans.mjs:104-113`：`notes.txt` 不被删。
- `slugify 规则与文件名一致（带空格/中文）` — `test-prune-orphans.mjs:115-126`：`'Core Application'` 经 `slugify` → `core-application.md` 被识别为本模块产物不删。
- `中文/斜杠/括号模块名能匹配（不误删）` — `test-prune-orphans.mjs:131-149`：显式 `['核心应用','模块/子模块','日志与追踪 (logging)']` 与期望文件名对照，规划内文章不被误删。
- `删除失败：记账进 failed、其他照删、不抛错` — `test-prune-orphans.mjs:153-181`：mock `fs.rmSync` 抛 `EBUSY` 于 `orphan-a.md` → 该篇仍在、`orphan-b.md` 照删、`removed` 只报真删的、`failed.length === 1` 且含文件名与原因。
- `非空但残缺的 plan：按非空数组当全集` — `test-prune-orphans.mjs:186-195`：钉住「清理器只认非空数组、完整性由编排侧保证」契约。

#### test-incremental-e2e.mjs（端到端：真实目录 + 真实 cw 外的全部环节）

导入源：`index.js` 的 `extractCurrentGraph` / `currentCommit`、`lib/incremental.js` 的 slimGraph / loadSnapshot / saveSnapshot / filterStaleTasks / describeChange。在 `os.tmpdir()` 真实目录写文件（`test-incremental-e2e.mjs:17-41`）。

- `提取当前符号图（真实目录）` — `test-incremental-e2e.mjs:43-50`：`extractCurrentGraph(tmp)` 就绪且组件数 ≥4，含 `calcTax` 与 `Invoice`。
- `快照落盘到 .codewiki/temp/symbol-graph.json` — `test-incremental-e2e.mjs:52-59`：`saveSnapshot(wiki, slimGraph(...))` → 路径 `temp/symbol-graph.json`，`loadSnapshot` 回读 `components.length`。
- `只改函数体实现（签名不变）→ 该文章要重写，记 body` — `test-incremental-e2e.mjs:61-76`：billing 改实现 → `keep` 只 billing、`dropped` 只 util。
- `只改空白/注释 → 两篇都跳过` — `test-incremental-e2e.mjs:78-95`：加文件头注释与尾部空行 → `keep.length === 0`、`dropped.length === 2`、`describeChange` 含「无实质变更」。
- `签名加参数 → interface 变更，文章必重写` — `test-incremental-e2e.mjs:97-110`：`calcTax(amount,rate)`→`calcTax(amount,rate,currency)` → `counts.interface >= 1`。
- `新增源文件 → 新文章必须写` — `test-incremental-e2e.mjs:112-123`：新增 `src/api/routes.js` → `keep.length === 1`、`counts.added >= 1`。
- `删掉整个源文件 → deleted 计入` — `test-incremental-e2e.mjs:125-137`：`fs.rmSync(strings.js)` → `counts.deleted >= 1`。
- `无 .codewiki 目录时 loadSnapshot 安静返回 null` — `test-incremental-e2e.mjs:139-141`。

#### test-update-record.mjs（更新记录与终态判定，钉死「部分失败仍成功」缺陷）

导入源：`lib/update-record.js`（judgeOutcome / buildUpdateRecord / saveUpdateRecord / loadUpdateRecord / recordPath / describeOutcome / isTerminalStage / TERMINAL / UPDATE_RECORD_VERSION）。辅助 `planOf`（`test-update-record.mjs:23-43`）与 `resultsOf`（`:45`）。

- `TERMINAL 含 partial` — `test-update-record.mjs:47-52`：`TERMINAL.has('partial')` 且 `isTerminalStage('partial') === true`。
- `全部成功 → done` — `test-update-record.mjs:54-60`：`canAdvanceBaseline === true`、`writtenCount === 2`。
- `1 成功 19 失败 → partial` — `test-update-record.mjs:62-76`：**旧实现是 done，这里必须 partial**，`canAdvanceBaseline === false`，`blockers` 含 19 个 `article-failed`。
- `全部失败 → failed` — `test-update-record.mjs:78-82`：无交付成果 → `failed`、`canAdvanceBaseline === false`。
- `缺页 → partial + missing-article` — `test-update-record.mjs:84-89`：计划要写但无结果 → `missing-article`。
- `未映射变更 → partial + unmapped-changes` — `test-update-record.mjs:91-99`：`unmappedChanges:['src/util/new.js']` → 基线不前移。
- `文章缺 source_files → partial + missing-sources` — `test-update-record.mjs:101-108`。
- `质量闸门失败 → partial + quality` — `test-update-record.mjs:110-119`。
- `索引校验失败 → partial + index` — `test-update-record.mjs:121-127`。
- `取消 → cancelled` — `test-update-record.mjs:129-133`。
- `无变更且无失败 → done` — `test-update-record.mjs:135-140`：不写文章不算失败。
- `full 编译没有 plan：任务清单缺页拦基线` — `test-update-record.mjs:142-152`：`plan: null` + `expectedNames` 仍可记 `missing-article`。
- `extraBlockers 补充硬阻塞降 partial` — `test-update-record.mjs:154-162`。
- `buildUpdateRecord：每个 action 带原因、可 JSON 往返` — `test-update-record.mjs:164-177`。
- `buildUpdateRecord：job 只存摘要` — `test-update-record.mjs:179-185`：记录不含整图（`'graph' in rec === false`）。
- `落盘与回读` — `test-update-record.mjs:187-197`：`.codewiki/temp/update-record.json` 往返、`recordPath` 后缀正确。
- `版本不符的记录不认` — `test-update-record.mjs:199-204`：`version: 999` → `loadUpdateRecord` 返回 `null`。
- `describeOutcome 三态文案` — `test-update-record.mjs:206-212`：done/partial/failed/cancelled 文案一眼可分且带首个阻塞原因。

### 被测源函数（均来自本模块引用的源文件）

#### lib/incremental.js（符号级增量核心，206 行）

- `SNAPSHOT_VERSION` — `lib/incremental.js:19`：常量 `1`。
- `SNAPSHOT_REL` — `lib/incremental.js:22`：`'temp/symbol-graph.json'`（入库路径，换机器也能拿到旧图）。
- `SLIM_FIELDS` — `lib/incremental.js:26`：`['id','name','kind','relativePath','parameters','baseClasses','dependsOn','bodyHash','codeHash']`，快照只存判定需要的字段。
- `slimComponent(node)` — `lib/incremental.js:28-34`：把节点裁成 SLIM_FIELDS，固化 `id`/`relativePath` 为字符串。
- `slimGraph(graph, {commit, now})` — `lib/incremental.js:37-48`：图 → 可 JSON 快照对象，现场算 `bodyHash`/`codeHash` 固化，按 id 排序。
- `sameSnapshotContent(a, b)` — `lib/incremental.js:53-66`：忽略 `generatedAt`/`commit` 只比实质字段，避免空转提交。
- `graphFromSnapshot(snap)` — `lib/incremental.js:69-88`：快照 → `Map<id,node>`，回读节点 `sourceCode`/`docstring` 置空，用固化 `bodyHash`/`codeHash`。
- `snapshotPath(wikiPath)` — `lib/incremental.js:90-92`：拼 `wikiPath + SNAPSHOT_REL`。
- `loadSnapshot(wikiPath, fsImpl)` — `lib/incremental.js:94-104`：版本不符或坏 JSON 返回 `null`（宁可重写不误判）。
- `saveSnapshot(wikiPath, snap, fsImpl, pathImpl)` — `lib/incremental.js:106-115`：目录自动创建，返回 `{ok, path}` 或 `{ok:false, reason}`。
- `normRel(p)` — `lib/incremental.js:118-120`：`\` 换 `/`、去 `./` 前缀、trim。
- `componentsByFile(graph)` — `lib/incremental.js:123-132`：`Map<file, id[]>` 聚合。
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)` — `lib/incremental.js:140-194`：**核心判定纯函数**。返回 `{keep, dropped, change:diff, counts, cosmeticOnly}`。`keep[i].changedComponents` 为真的变组件；`dropped[i].cosmeticOnlyComponents` 为纯注释降级原因；`symbolFallback` 标记无符号可判的文章。纯注释降级逻辑 `lib/incremental.js:182-197`：只降级 `body` 类、保留 `interface/added/deleted/renamed`，且 `docstring` 变了不算降级。
- `describeChange(counts)` — `lib/incremental.js:197-206`：把 `counts`（interface/added/deleted/renamed/body/edge）拼成中文摘要；全 0 时返回「无实质变更」。

#### lib/update-planner.js（增量计划器，492 行）

- `UPDATE_PLAN_VERSION` — `lib/update-planner.js:23`：`1`。
- `MODULE_MAP_VERSION` — `lib/update-planner.js:26`：`1`。
- `MODULE_MAP_REL` — `lib/update-planner.js:27`：`'temp/module-map.json'`。
- `SOURCE_EXTS` — `lib/update-planner.js:30`：从 `SUPPORTED_EXTS`（lib/symbols.js:273）取的扩展名集合。
- `isSourcePath(p)` — `lib/update-planner.js:33-36`：按扩展名判断是否为源码（非源码无归属只记 warning）。
- `dirOf(p)` — `lib/update-planner.js:38-41`：`normRel` 后的目录，根返回 `''`。
- `commonDir(a, b)` — `lib/update-planner.js:44-53`：最长公共目录（至少一级才算同模块）。
- `realChangedIds(diff, oldGraph, newGraph, {ignoreCommentOnly})` — `lib/update-planner.js:57-81`：返回 `{changed, cosmetic, real, structural}`，`structural` = 实变且属 interface/added/deleted/renamed/edge（实现细节变了不波及依赖方）。
- `dependentsOf(graph, ids)` — `lib/update-planner.js:85-101`：组件 → 依赖它的组件的反向边索引，认 id 与文件路径两种 `dependsOn` 写法。
- `scanStaleArticle(article, {deletedComponents, renamedComponents, linkExists})` — `lib/update-planner.js:106-145`：单篇 stale scan，返回 `{issues:[{kind,detail}], needsRewrite}`。`kind` 含 `deleted-symbol`/`renamed-symbol`/`dead-link`；引用已删/改名符号 → `needsRewrite`，死链只记 issue 不强制重写（交 review）。
- `planUpdate({changeSet, oldGraph, newGraph, articles, moduleMap, options})` — `lib/update-planner.js:156-436`：**主入口**。返回 `UpdatePlan`，每篇一个 `action`（write/keep/review/delete）+ `reason`，外加 `unmappedChanges`/`missingSources`/`needsFull`/`fullReason`/`routedTo`/`warnings`/`summary`/`cosmeticComponents`/`structuralComponents`。关键分支：文件级降级（`:179`）、反向依赖闭包（`:209-219`）、缺 source_files → review（`:253-258`）、删除/改名源 → write（`:270-289`）、未命中先做 stale scan（`:319-346`）、无归属新文件同模块路由（`:351-382`）、`needsFull`（`:391-433`）。
- `buildModuleMap({articles, graph, plan, now})` — `lib/update-planner.js:442-468`：文章 → sources/components/module 的版本化状态，full 编译时由真实 plan 重建。
- `migrateModuleMap({articles, now})` — `lib/update-planner.js:472-481`：旧 wiki 无 module-map 时从 frontmatter 保守迁移（components 留空、标 `migrated`）。
- `sameModuleMap(a, b)` — `lib/update-planner.js:484-492`：忽略 `generatedAt` 只比实质内容。

#### lib/graph-diff.js（符号级 diff，供增量判定复用，578 行）

- `CLASS_ADDED/DELETED/IFACE/BODY/EDGE/RENAMED`、`DIFF_TRUNCATED_MARKER` — `lib/graph-diff.js:14-21`。
- `stripComments(text)` — `lib/graph-diff.js:69-100`：剥离行/块注释与纯装饰空白，仅靠 `codeHash` 区分「只改注释」与「代码实质变」。
- `codeHash(node)` — `lib/graph-diff.js:108-111`：对 `stripComments(sourceCode)` 取 sha1；有固化 `codeHash` 时直接返回。
- `bodyHash(node)` — `lib/graph-diff.js:121-126`：对 `normalizeBody(documentedSource(node))` 取 sha1（含 docstring）。
- `signature` / `signatureChanged` — `lib/graph-diff.js:128-145`：比较 name/parameters/baseClasses。
- `diffGraphs(oldGraph, newGraph, opts)` — `lib/graph-diff.js:447-564`：组件级变更集主入口，签名变=interface、实现变=body、仅依赖变=edge、删+增近似=renamed。
- `graphDiffCounts` / `changedIds` / `emptyGraphDiff` — `lib/graph-diff.js:413-440`。

#### lib/symbols.js（AST 符号提取与依赖边，供测试造图，884 行）

- `LANG_RULES` / `SUPPORTED_EXTS` / `REGEX_RULES` — `lib/symbols.js:36-368`：表驱动各语言提取规则。
- `extractRepoGraph(files, opts)` — `lib/symbols.js:785-805`：返回 `{graph: Map<id,node>, byFile, skipped, ready, stats}`。
- `resolveImportEdges(graph, byFile, files)` — `lib/symbols.js:810-833`：把 import 解析成文件级边并落到组件 `dependsOn`（反向依赖影响的前提）。
- `SymbolExtractor` 类 — `lib/symbols.js:472-779`（`constructor` `:473-481`、`init` `:498-519`、`extractFile` `:551-594`、`walk` `:597-695`、`componentId` `:776-778` 等）。

#### lib/update-record.js（更新记录与终态，253 行）

- `UPDATE_RECORD_VERSION` — `lib/update-record.js:17`：`1`。
- `UPDATE_RECORD_REL` — `lib/update-record.js:18`：`'temp/update-record.json'`。
- `TERMINAL` — `lib/update-record.js:24`：`Set(['done','partial','failed','cancelled'])`。
- `isTerminalStage(stage)` — `lib/update-record.js:26-28`。
- `judgeOutcome({plan, results, options})` — `lib/update-record.js:37-128`：**终态判定**。任何未消化项（缺页/失败/unmapped/missing-sources/quality/index/extra）⇒ `partial`/`failed`；`canAdvanceBaseline` 仅 `done` 时为 `true`。
- `buildUpdateRecord({...})` — `lib/update-record.js:131-211`：组装可序列化记录，每 action 带 `reason`，job 只存摘要不塞整图。
- `recordPath` / `saveUpdateRecord` / `loadUpdateRecord` — `lib/update-record.js:213-238`。
- `describeOutcome(outcome, blockers)` — `lib/update-record.js:241-253`。

#### index.js（孤儿清理与编排桥接，4882 行）

- `pruneOrphanModules(job)` — `index.js:271-296`：**删除孤儿文章**。仅当 `job.kind === 'full'` 且 `job.plan.modules` 为非空数组时动手；只删 `.codewiki/modules/*.md`，保留 `concepts/`、`_architecture.md`、本次写过（含失败）的文章；删除失败记 `failed` 不中断。依赖 `slugify`（`index.js:1670-1672`，保留 CJK、其余替换成 `-`、空则回落 `'module'`）把模块名映射到文件名。
- `slugify(name)` — `index.js:1670-1672`：模块名 → 文件名片段；与清理器的 `planned` 集合（`:280`）规则一致。

## Architecture

测试簇对应的三套被测能力，其数据依赖关系如下（`┌─┐` 为组件/文件，`►` 为调用/数据流向）：

```text
 真实仓库/临时目录
        │ extractRepoGraph + resolveImportEdges
        ▼
 ┌─────────────┐   diffGraphs (lib/graph-diff.js)   ┌──────────────┐
 │  oldGraph /  │ ────────────────────────────────► │  GraphDiff   │
 │  newGraph    │ ◄──────────────────────────────── │ (interface/  │
 └─────────────┘        filterStaleTasks           │  added/del/  │
        │                (lib/incremental.js)        │  renamed/    │
        ▼                                            │  body/edge)  │
 ┌─────────────┐                                    └──────────────┘
 │ slimGraph / │  graphFromSnapshot   loadSnapshot / saveSnapshot
 │ snapshot    │ ◄────────────────────────────────► ┌────────────┐
 └─────────────┘                                    │ .codewiki/ │
                                                    │ temp/*.json│
 ┌─────────────┐  realChangedIds + dependentsOf     └────────────┘
 │ planUpdate   │ ────────────────────────────────► (反向依赖闭包)
 │(lib/update-  │  scanStaleArticle / buildModuleMap
 │ planner.js)  │
 └──────┬──────┘
        │ UpdatePlan { actions, unmappedChanges, needsFull }
        ▼
 ┌─────────────┐  judged by   ┌──────────────────┐
 │ judgeOutcome │ ───────────► │ buildUpdateRecord │ ──► temp/update-record.json
 │(update-record)│              │ (update-record.js)│
 └─────────────┘              └──────────────────┘
        │ 全量编译收尾
        ▼
 ┌─────────────┐  only if kind=full & modules 非空
 │ pruneOrphan  │ ── 删 .codewiki/modules/*.md 孤儿（保留 concepts/_architecture）
 │ Modules      │
 └─────────────┘
```

测试文件与被测源的一一对应：`test-incremental.mjs` + `test-incremental-e2e.mjs` → `lib/incremental.js`；`test-update-planner.mjs` → `lib/update-planner.js` + `lib/graph-diff.js` + `lib/symbols.js`；`test-prune-orphans.mjs` → `index.js:271 pruneOrphanModules`；`test-update-record.mjs` → `lib/update-record.js`。

## Data Flow

以 `test-incremental-e2e.mjs`（最贴近真实链路）为例，端到端数据流向：

1. **造图**：`write('src/billing/invoice.js', V1)` 等把源码写到 `os.tmpdir()` 真实目录（`test-incremental-e2e.mjs:40-41`）；`extractCurrentGraph(tmp)` 调 `extractRepoGraph` 取 `graph: Map<id,node>`（`index.js` 暴露、`lib/symbols.js:785` 实现）。
2. **落快照**：`saveSnapshot(wiki, slimGraph(cur.graph, {commit}))`（`test-incremental-e2e.mjs:54`）→ 写 `.codewiki/temp/symbol-graph.json`（`lib/incremental.js:106`）。`slimGraph` 用 `bodyHash`/`codeHash` 固化（`:37-48`），不存源码全文。
3. **改代码**：再次 `write()` 触发文件改动（如只改实现细节 `:62`，或加注释 `:82`，或改签名 `:100`，或新增文件 `:113`，或删文件 `:128`）。
4. **重新提图 + 比对**：`extractCurrentGraph(tmp)` 得新图 → `loadSnapshot(wiki)` 回旧图（经 `graphFromSnapshot` 还原 `:69-88`）→ `filterStaleTasks(tasks, oldGraph, newGraph)`（`test-incremental-e2e.mjs:70`）。
5. **判定**：`filterStaleTasks`（`lib/incremental.js:140`）内部 `diffGraphs`，折算出 `keep`/`dropped`，纯注释改动经 `codeHash` 降级（`lib/incremental.js:154-169`）；`describeChange(counts)` 出中文摘要。
6. **更高层**：全量/增量编排里，新图旧图交给 `planUpdate`（`lib/update-planner.js:156`）做反向依赖、stale scan、无归属兜底；产出的 `UpdatePlan` 交给 `judgeOutcome`（`lib/update-record.js:37`）判终态；`buildUpdateRecord` 落 `temp/update-record.json`；全量收尾时 `pruneOrphanModules`（`index.js:271`）清理孤儿。

测试的 `graphOf` 辅助（`test-incremental.mjs:26` / `test-update-planner.mjs:22`）在内存里同步跑同样链路，区别是 planner 测试额外 `resolveImportEdges`（`:26`）以便反向依赖影响生效。

## Connections

- [[lib-incremental]] — 本模块 `test-incremental.mjs`/`test-incremental-e2e.mjs` 直接被测的快照与 `filterStaleTasks` 逻辑。
- [[lib-update-planner]] — `test-update-planner.mjs` 被测的反向依赖 / stale scan / 无归属路由主入口。
- [[lib-graph-diff]] — `diffGraphs`/`bodyHash`/`codeHash`/`stripComments` 是增量判定复用的底层 diff（纯注释降级的判据来源）。
- [[lib-symbols]] — `extractRepoGraph`/`resolveImportEdges` 是所有测试造图与建依赖边的来源。
- [[lib-update-record]] — `test-update-record.mjs` 被测的终态判定与记录落盘。
- [[index]] — `pruneOrphanModules`/`slugify` 与编排层桥接（`codewiki_generate` 流水线、extractCurrentGraph、module-map 读写）。
- [[test-change-set]] — `planUpdate` 的 `changeSet` 由 collectChangeSet（`lib/change-set.js`）产出，二者协同决定 needsFull。
- [[test-wiki-anchors]] — 孤儿文章会破坏 `test-wiki-anchors` 的行号校验（见 `index.js:271-288` 注释，251 处失败里 169 处来自孤儿），这正是 `pruneOrphanModules` 存在的动机之一。

## Known Issues

- **非空但残缺的 plan 会被当成全集**：`pruneOrphanModules` 只要 `plan.modules` 是非空数组就当真删除规划外孤儿（`test-prune-orphans.mjs:186-195` 显式钉住）。若编排侧传入残缺清单，会误删有主文章；完整性必须由编排侧（`index.js` 的 full 编译任务组装）保证，清理器自身不校验。
- **纯注释降级依赖 `codeHash`，老快照缺字段时退回保守保留**：`filterStaleTasks` 只在节点带 `codeHash`（或现场有 `sourceCode` 可现算）时做降级；否则纯注释改动会被误判为实变、照常重写（`test-incremental.mjs:109-118` 覆盖）。这是「宁可多写不漏改」的取舍。
- **注释只能写在函数体内才进 `sourceCode`**：tree-sitter 把函数前的注释当 sibling 节点，不进入节点文本；所以「函数前加注释」仍会被 `bodyHash` 判为实变并触发重写（`test-update-planner.mjs:33-35` 注释明确）。只有函数体内的注释能被 `stripComments`+`codeHash` 降级识别。
- **反向依赖影响依赖 `dependsOn` 边**：`planUpdate` 的反向闭包（`lib/update-planner.js:156-166`）只在图带 import 边时生效；若 `oldGraph`/`newGraph` 没建边（旧链路 `extractCurrentGraph` 曾不建边），则 `billing 文章不会因 util 接口变而重写`，仅记一条 warning（`:395-397`）。`test-update-planner.mjs:22-28` 的 `graphOf` 因此显式 `resolveImportEdges`。
- **死链只记 review 不强制重写**：`scanStaleArticle` 对 `dead-link` 类 issue 只要求人工复核（`needsRewrite` 只对 `deleted-symbol`/`renamed-symbol` 为真，`lib/update-planner.js:139-144`），因为链接目标可能只是被改名成等价标题（同篇重定向不该触发重写）。
- **`needsFull` 触发条件多样**：`unmappedSourceChanges` 非空、或任一 action 标 `needsFull=true`（缺 source_files 的 review）都会令 `planUpdate` 返回 `needsFull=true`（`lib/update-planner.js:391-433`），调用方须退回全量编译而非当 keep 处理。
- **测试与真实宿主共享 `JOBS_FILE` 的 flaky 风险**：`index.js:1876` 注释指出真实编排用 `dsh-codewiki-jobs.json`，测试需设 `DSH_CODEWIKI_JOBS_FILE` 隔离，否则会被宿主 flush 洗掉内存字段（与本模块测试无直接断言，但属相邻模块的运行前提）。

## 测试运行方式

- `node test-incremental.mjs` — 符号级增量（快照 + `filterStaleTasks` + 纯注释降级）。
- `node test-update-planner.mjs` — 计划器（反向依赖 / 新文件路由 / stale scan / module-map）。
- `node test-prune-orphans.mjs` — 孤儿清理安全边界（删文件逻辑）。
- `node test-incremental-e2e.mjs` — 真实目录端到端（extractCurrentGraph → 落快照 → 改代码 → 判定）。
- `node test-update-record.mjs` — 终态判定与记录落盘（钉死「部分失败仍成功」缺陷）。

每个文件末尾打印 `N passed, M failed`，失败时 `process.exitCode = 1`；`fails` 收集失败用例的 `label` 与 `err.stack` 供排查。
