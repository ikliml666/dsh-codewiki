---
title: test_incremental_update
type: module
source_files:
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - lib/incremental.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/graph-diff.js
  - lib/symbols.js
  - index.js
tags: [test, incremental, snapshot, update-planner, update-record, graph-diff]
---

## Overview

本模块是「符号级增量更新」一整套能力的**测试集合**，覆盖四类文件：

- `test-incremental.mjs`：针对 `lib/incremental.js` 的单元测试——图快照瘦身存取、组件级变更折算（`filterStaleTasks`）、文章 keep/skip 判定、纯注释降级。
- `test-incremental-e2e.mjs`：端到端测试，用真实目录串起「提取符号图 → 存快照 → 改代码 → `filterStaleTasks` 判定是否重写」整条链路。
- `test-update-planner.mjs`：针对 `lib/update-planner.js` 的单元测试——反向依赖影响、新文件归属路由、stale scan、无归属变更兜底、`module-map` 构建/迁移。
- `test-update-record.mjs`：针对 `lib/update-record.js` 的单元测试——终态判定（done/partial/failed/cancelled）、记录落盘与回读、版本兼容。

这些测试钉死了三件历史缺陷：旧 `filterStaleTasks` 看不见反向依赖/新文件/未重写页（`lib/incremental.js:140-193`，`lib/update-planner.js:4-14`）；旧结算逻辑只有 `writtenCount===0` 才失败、部分失败仍判 done（`test-update-record.mjs:1-6`，`index.js` 旧 `2775-2776`）。

测试的统一约定：顶部各有一个 `check(label, fn)` 辅助函数（见 `test-incremental.mjs:16-19`、`test-update-planner.mjs:16-19`、`test-update-record.mjs:18-21`、`test-incremental-e2e.mjs:12-15`），`pass`/`fails` 统计，末尾打印 `N passed, M failed` 并以失败数设 `process.exitCode = 1`。涉及文件系统时用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))` 建临时 wiki 目录。

## Key Components

（按测试文件逐一列出：公开 fixtures / helper / 测试用例，附行号与用途。被测试的源函数行号在 Connections 与下方引用中给出。）

### test-incremental.mjs

测试目标：`lib/incremental.js`。导入见 `test-incremental.mjs:7-12`（`slimGraph`、`graphFromSnapshot`、`snapshotPath`、`loadSnapshot`、`saveSnapshot`、`filterStaleTasks`、`describeChange`、`normRel`、`componentsByFile`、`SNAPSHOT_VERSION`、`sameSnapshotContent`），以及 `extractRepoGraph`（`test-incremental.mjs:11`）与 `bodyHash`、`stripComments`（`test-incremental.mjs:12`）。

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `graphOf(files)` | 26-29 | helper | 把 `{path:content}` 对象喂给 `extractRepoGraph`，返回 `ex.graph`（`Map<id,node>`） |
| `A` / `A2` / `A3` | 21-23 | fixtures | `calcTax` 的三个版本：A 原始；A2 只改注释+实现细节（签名不变）；A3 签名加 `currency` 参数 |
| `B` | 24 | fixture | `class Invoice { constructor(id){...} }` |
| `slimGraph 不含源码` | 31-40 | case | 断言 `slimGraph` 不存源码全文、组件带 40 位 `bodyHash`、快照 `version===SNAPSHOT_VERSION` |
| `快照往返后 bodyHash 一致` | 42-47 | case | `graphFromSnapshot(slimGraph(g))` 后 `bodyHash` 不变（不读源码也能判实现变更） |
| `只有注释变更→记 body` | 49-59 | case | A→A2：实现哈希变、签名不变 ⇒ `counts.body===1`、`interface===0`、`keep[0].changedComponents` 非空 |
| `签名变更记为 interface` | 61-67 | case | A→A3：`counts.interface===1`，`describeChange` 命中「接口变」 |
| `只改注释：body 被降级` | 77-88 | case | `A_COMMENT_ONLY` 仅加注释行：先确认 `counts.body===1`（前提），再断言 `keep.length===0`、`dropped.length===1`、`cosmeticOnly.length===1`、被跳过任务带 `cosmeticOnlyComponents` |
| `改代码：仍是 body` | 90-97 | case | `A_CODE_CHANGED` 真改实现：`keep.length===1`、`cosmeticOnly.length===0` |
| `改签名+改注释：interface 优先` | 99-107 | case | `withBoth`：interface 不被注释降级放行 |
| `老快照无 codeHash 退回原行为` | 109-118 | case | 抹掉回读节点的 `codeHash`/`sourceCode` ⇒ 保守保留（`keep.length===1`） |
| `stripComments 去注释` | 120-126 | case | 行注释/块注释/`#` py 注释被剥，纯代码不同仍能区分 |
| `文件内容变但符号没变→跳过` | 128-140 | case | 只动空白/末尾换行：`keep.length===0`、`dropped.length===2`、命中「无实质变更」 |
| `新增文件组件算 added` | 142-150 | case | `src/c.js#Invoice` 进 `change.added`，`counts.added>=1` |
| `源文件被删→deleted` | 152-158 | case | 删除 `src/c.js`：`change.deleted` 含 `src/c.js#Invoice` |
| `source_files 无符号→保守保留` | 160-167 | case | `package.json` 当 source：`keep[0].symbolFallback===true` |
| `路径分隔符与 ./ 归一` | 169-176 | case | `normRel('.\\src\\a.js')` 与 `./src/a.js` 都归一到 `src/a.js`，反斜杠路径能命中组件 |
| `多源文件文章` | 178-184 | case | 任一源变动即保留，且 `changedComponents` 带出新组件 `src/b.js#extra` |
| `componentsByFile 聚合` | 186-191 | case | 按文件聚合组件 id，键排序为 `[src/a.js, src/b.js]` |
| `快照落盘与回读` | 193-204 | case | `saveSnapshot(wiki, slimGraph(g,{commit:'abc123'}))` 后 `loadSnapshot` 回读 commit/components |
| `快照版本不符/坏 JSON→视为无` | 206-214 | case | `version:999` 与 `{not json` 都令 `loadSnapshot` 返回 `null`（退化全量） |
| `改名归到 renamed` | 216-225 | case | `src/old.js`→`src/new.js` 同体：`counts.renamed===1`、`added/deleted===0`、`keep.length===1` |
| `快照内容比较忽略元数据` | 227-237 | case | `sameSnapshotContent` 忽略 `generatedAt`/`commit`/数组顺序；`bodyHash` 或依赖边变了则判不同 |

### test-incremental-e2e.mjs

端到端链路测试，导入见 `test-incremental-e2e.mjs:7-8`（`extractCurrentGraph`、`currentCommit`、`slimGraph`、`loadSnapshot`、`saveSnapshot`、`filterStaleTasks`、`describeChange`），并在运行时动态 `import('./lib/incremental.js')` 取 `graphFromSnapshot`（`test-incremental-e2e.mjs:69` 等）。

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `V1` / `STRINGS` | 25-39 | fixtures | `invoice.js`（calcTax+Invoice）与 `strings.js`（slugify）原始源码 |
| `write(rel, content)` | 19-23 | helper | 在临时真实目录写文件（自动建父目录） |
| `提取当前符号图` | 43-50 | case | `extractCurrentGraph(tmp)` 就绪且组件数 `>=4` |
| `快照落盘到 .codewiki/temp/symbol-graph.json` | 52-59 | case | 快照写入并回读，`components.length` 等于图大小 |
| `只改函数体实现→该文章重写` | 61-76 | case | 改 `return amount * rate` 实现：`keep` 只有 billing、util 进 `dropped`、记 `body` |
| `只改空白/注释→两篇都跳过` | 78-95 | case | 仅加文件头注释/空行：`keep.length===0`、命中「无实质变更」（省钱场景） |
| `签名加参数→interface` | 97-110 | case | `calcTax` 加默认参数：`counts.interface>=1` |
| `新增源文件→新文章必须写` | 112-123 | case | 新增 `src/api/routes.js`：`counts.added>=1`、`keep.length===1` |
| `删掉整个源文件→deleted` | 125-137 | case | 删除 `src/util/strings.js`：`counts.deleted>=1` |
| `无 .codewiki 目录 loadSnapshot 返回 null` | 139-141 | case | 目录不存在时安静返回 `null` |

### test-update-planner.mjs

测试目标：`lib/update-planner.js`。导入见 `test-update-planner.mjs:7-12`（`planUpdate`、`realChangedIds`、`dependentsOf`、`scanStaleArticle`、`buildModuleMap`、`migrateModuleMap`、`sameModuleMap`、`isSourcePath`、`MODULE_MAP_VERSION` 等），以及 `extractRepoGraph`、`resolveImportEdges`（`test-update-planner.mjs:11`）与 `diffGraphs`（`test-update-planner.mjs:12`）。

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `graphOf(files)` | 22-28 | helper | 同 `test-incremental` 但额外调 `resolveImportEdges(ex.graph, ex.byFile, textByFile)`，保证反向依赖边存在 |
| `STRINGS_V1/V2/COMMENT` + `INVOICE` | 30-36 | fixtures | slugify 三版本（V1 原始；V2 加 `sep` 参数=interface；COMMENT 仅补函数内注释）+ 引用 slugify 的 `invoiceSlug` |
| `ARTICLES` | 38-41 | fixtures | `modules/util.md`(源 strings.js) 与 `modules/billing.md`(源 invoice.js) 两篇文章 |
| `changeSetOf(over)` | 43-45 | helper | 构造默认 `changeSet`（`ok/state/sourceChanges/all/...`），支持覆盖 |
| `接口变更→自身+反向依赖都写` | 47-61 | case | strings.js 签名变：util、billing 两篇都 `write`，billing 带 `impactedBy`，`summary.write===2` |
| `纯注释变更→两篇都 keep` | 63-73 | case | `summary.write===0`、`keep===2`、`cosmeticComponents>=1` |
| `实现细节变更→只重写自身` | 75-86 | case | 仅实现变（签名不变）：util `write`、billing `keep` |
| `新文件无归属→同模块路由` | 88-104 | case | `src/util/dates.js` 路由给 util.md（`routedTo.length===1`、带 `newFiles`） |
| `新文件完全无归属→unmapped+needsFull` | 106-120 | case | `tools/build.rs`：`unmappedChanges` 含它、`needsFull===true`、`fullReason` 命中「无文章归属」、warning 含该路径 |
| `非源码文件无归属` | 122-134 | case | `notes/scratch.md`：只记 warning，`needsFull===false`，`isSourcePath` 区分 |
| `source_files 被删→write` | 136-146 | case | util.md 的源被删：`action==='write'`、`reason` 命中「已被删除」 |
| `source_files 被改名→write` | 148-162 | case | `strings.js→str.js`：`reason` 含「改名」 |
| `文章缺 source_files→review+needsFull` | 164-175 | case | `sources:[]`：`action==='review'`、`needsFull===true`、`missingSources.length===1` |
| `stale scan：引用已删符号→write` | 177-195 | case | legacy.md 正文引用已删 `legacyOnly`：升级为 `write`，`reason` 含「stale scan」 |
| `stale scan：死链→review` | 197-210 | case | 正文 `[[modules/gone]]`：`action==='review'`、`staleIssues` 含 `dead-link` |
| `文件级降级（无图）` | 212-224 | case | `oldGraph/newGraph` 为 null 走文件级：自身源文件变化仍 `write` |
| `无变更→全 keep` | 226-232 | case | `summary.keep===2`、`write===0`、`needsFull===false` |
| `计划可 JSON 序列化` | 234-240 | case | `JSON.parse(JSON.stringify(plan))` 往返，`version`/`actions.length` 不变（要落 update-record） |
| `dependentsOf：反向边索引` | 242-248 | case | 认 id 与文件路径两种依赖写法，能找到依赖 slugify 的 `invoiceSlug` |
| `scanStaleArticle 空内容` | 250-254 | case | 空正文：`issues===[]`、`needsRewrite===false` |
| `buildModuleMap` | 256-264 | case | 记录 article→sources/components/module，`version===MODULE_MAP_VERSION`，可 JSON 往返 |
| `migrateModuleMap` | 266-271 | case | 旧 wiki 无 module-map 时从 frontmatter 保守迁移，`migratedFromFrontmatter===true`，不臆造 components |
| `sameModuleMap` | 273-280 | case | 忽略 `generatedAt`，只比实质内容 |
| `realChangedIds` | 282-293 | case | interface 进 `structural`、纯注释进 `cosmetic` |

### test-update-record.mjs

测试目标：`lib/update-record.js`。导入见 `test-update-record.mjs:11-14`（`judgeOutcome`、`buildUpdateRecord`、`saveUpdateRecord`、`loadUpdateRecord`、`recordPath`、`describeOutcome`、`isTerminalStage`、`TERMINAL`、`UPDATE_RECORD_VERSION`）。

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `planOf(over)` | 23-43 | helper | 构造默认 `plan`（version/fileLevel/needsFull/summary/counts/actions/...），支持覆盖 |
| `resultsOf(names, ok)` | 45 | helper | 把文章名数组映射成 `{name, ok}` 结果 |
| `TERMINAL 含 partial` | 47-52 | case | `TERMINAL.has('partial')`、`isTerminalStage('partial'/'done')` 为真、非 `'articles'` |
| `全部成功→done` | 54-60 | case | 两篇都 ok：`outcome==='done'`、`canAdvanceBaseline===true` |
| `1成功19失败→partial` | 62-76 | case | 旧实现会判 done；此处 `outcome==='partial'`、`canAdvanceBaseline===false`、19 个 `article-failed` blocker |
| `全部失败→failed` | 78-82 | case | 两篇都失败：`outcome==='failed'` |
| `缺页→partial+missing-article` | 84-89 | case | 计划要写的 b.md 无结果：`missing-article` blocker |
| `未映射变更→partial` | 91-99 | case | `unmappedChanges:['src/util/new.js']`：`unmapped-changes` blocker |
| `文章缺 source_files→partial` | 101-108 | case | `missingSources`：记 `missing-sources` blocker |
| `质量闸门失败→partial` | 110-119 | case | `options.qualityIssues`：`quality` blocker |
| `索引校验失败→partial` | 121-127 | case | `options.indexOk===false`：`index` blocker |
| `取消→cancelled` | 129-133 | case | `options.cancelled===true`：`outcome==='cancelled'` |
| `无变更且无失败→done` | 135-140 | case | `hasChanges:false`、无 plan 动作：仍 `done`（不因「没写文章」失败） |
| `full 编译没有 plan` | 142-152 | case | `plan:null` + `expectedNames`：任务清单缺页同样拦基线 |
| `extraBlockers` | 154-162 | case | 调用方补 `git-base` blocker ⇒ `partial`、不进基线 |
| `buildUpdateRecord：每 action 带原因` | 164-177 | case | 每个 `rec.plan.actions` 都有 `reason`；`changeSet.counts.committed===1`；可 JSON 往返 |
| `buildUpdateRecord：只存摘要` | 179-185 | case | 500 组件 id 清单保留但记录里无整图（`'graph' in rec===false`）、无任务快照 |
| `落盘与回读` | 187-197 | case | `saveUpdateRecord` 后 `.codewiki/temp/update-record.json` 存在、回读 `outcome/jobId` |
| `版本不符的记录不认` | 199-204 | case | `version:999` ⇒ `loadUpdateRecord` 返回 `null` |
| `describeOutcome` | 206-212 | case | 三态文案一眼可分且带首个阻塞原因 |

## Architecture

四个测试文件分两层：单元测试（直接 import 源纯函数 + `extractRepoGraph` 造图）与端到端测试（真实临时目录串链路）。它们共同验证「符号级增量更新」的判定闭环。

```text
                 ┌──────────────────────────────┐
                 │   lib/graph-diff.js           │
                 │   diffGraphs/bodyHash/codeHash│
                 │   stripComments               │
                 └──────────────┬───────────────┘
                                │ 组件级 diff
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
┌───────────────┐   ┌────────────────────┐   ┌────────────────────┐
│lib/incremental│   │ lib/update-planner │   │ lib/update-record  │
│.js (slimGraph │   │ .js (planUpdate,   │   │ .js (judgeOutcome, │
│ filterStale,  │   │  dependentsOf,     │   │  buildUpdateRecord)│
│ saveSnapshot) │   │  scanStaleArticle) │   │                    │
└──────┬────────┘   └─────────┬──────────┘   └─────────┬──────────┘
       │                      │                        │
       ▼                      ▼                        ▼
 test-incremental.mjs   test-update-planner.mjs   test-update-record.mjs
 test-incremental-e2e.mjs   (链：planUpdate→        (链：record 落盘/
       │                      judgeOutcome)         版本/终态语义)
       └─────────── 共用 extractRepoGraph + resolveImportEdges 造图 ──────────┘
```

- `test-incremental.mjs` / `test-incremental-e2e.mjs` 直测 `lib/incremental.js`（快照 + `filterStaleTasks`）。
- `test-update-planner.mjs` 直测 `lib/update-planner.js`（`planUpdate` 等），依赖 `lib/graph-diff.js` 的 `diffGraphs` 与 `lib/incremental.js` 的 `normRel`。
- `test-update-record.mjs` 直测 `lib/update-record.js`，从 `plan`/`results` 算 `judgeOutcome`，不依赖图。

## Data Flow

典型测试数据流向（以 `test-update-planner.mjs` 的「接口变更 → 反向依赖也写」为例，`test-update-planner.mjs:47-61`）：

1. `graphOf`（`test-update-planner.mjs:22-28`）调用 `extractRepoGraph` 造 `oldGraph`/`newGraph`，并 `resolveImportEdges` 建 `invoice.js → strings.js` 的依赖边。
2. 构造 `changeSet`（`changeSetOf`，`test-update-planner.mjs:43-45`）带 `sourceChanges`/`all`。
3. 调 `planUpdate({changeSet, oldGraph, newGraph, articles})`（`lib/update-planner.js:156-436`）：内部 `diffGraphs`（`lib/graph-diff.js:447`）算变更，`realChangedIds`（`lib/update-planner.js:57`）降纯注释，`dependentsOf`（`lib/update-planner.js:85`）求反向依赖闭包，逐篇产出 `{action, reason, changedComponents, impactedBy}`。
4. 断言 `actions` 里 util/billing 都是 `write`、billing 带 `impactedBy`（`test-update-planner.mjs:54-58`）。

记录侧（`test-update-record.mjs`）：`planOf`（`:23-43`）造 `plan` + `resultsOf`（`:45`）造结果 → `judgeOutcome`（`:37`）/ `buildUpdateRecord`（`:131`）→ `saveUpdateRecord`/`loadUpdateRecord`（`:217`/`:229`）落盘 `.codewiki/temp/update-record.json` 并回读。

快照侧（`test-incremental.mjs`）：`graphOf`（`:26-29`）→ `slimGraph`（`:37`）→ `saveSnapshot`（`:106`）→ `loadSnapshot`（`:94`）→ `graphFromSnapshot`（`:69`）→ `filterStaleTasks`（`:140`）判定 keep/dropped。

## Connections

- [[lib-incremental]] — `test-incremental.mjs` / `test-incremental-e2e.mjs` 直测的对象（快照瘦身、`filterStaleTasks`、`describeChange`、`normRel`、`componentsByFile`、`sameSnapshotContent`）。
- [[lib-update-planner]] — `test-update-planner.mjs` 直测对象（`planUpdate`、`realChangedIds`、`dependentsOf`、`scanStaleArticle`、`buildModuleMap`、`migrateModuleMap`、`sameModuleMap`、`isSourcePath`）。
- [[lib-update-record]] — `test-update-record.mjs` 直测对象（`judgeOutcome`、`buildUpdateRecord`、`saveUpdateRecord`、`loadUpdateRecord`、`recordPath`、`describeOutcome`、`TERMINAL`、`isTerminalStage`）。
- [[lib-graph-diff]] — 三套测试共享的底层：组件级 diff（`diffGraphs`）、哈希（`bodyHash`/`codeHash`）、`stripComments`、`changedIds`、`graphDiffCounts`。
- [[lib-symbols]] — 测试中用 `extractRepoGraph` 与 `resolveImportEdges`（`SUPPORTED_EXTS` 被 `isSourcePath` 复用，见 `lib/update-planner.js:20`）造符号图；`test-update-planner.mjs:26`、`test-update-planner.mjs:242-248`。

## Known Issues

- 纯注释降级依赖 `codeHash`（`lib/graph-diff.js:108`）：若回读快照节点既无 `sourceCode` 又无固化 `codeHash`，则降级分支 `continue` 跳过（`lib/incremental.js:164`、`lib/update-planner.js:68`），保守保留。测试用例 `test-incremental.mjs:109-118` 专门钉住「老快照缺字段不误跳过」的回退行为。
- `stripComments`（`lib/graph-diff.js:69-100`）对字符串内的 `//` 近似剥离（注释态误判），是已知可接受的近似；测试 `test-incremental.mjs:120-126` 只验证「去注释后纯代码不同仍区分」。
- `test-update-record.mjs:1-6` 记录的旧缺陷（部分失败判 done）已被 `judgeOutcome`（`lib/update-record.js:37-128`）的 blocker 机制钉死，测试 `test-update-record.mjs:62-76` 用「1 成功 19 失败」断言 `partial`。
- 反向依赖影响仅在 `newGraph` 有 `dependsOn` 边时生效；`planUpdate` 会在无边时推 warning（`lib/update-planner.js:395-397`）。测试 `test-update-planner.mjs:22-28` 用 `resolveImportEdges` 保证边存在。
- 文件级降级（`options.fileLevel` 或 `oldGraph/newGraph` 为 null）下不再只认 `source_files` 命中，删除/改名/新文件仍处理（`lib/update-planner.js:179`、`test-update-planner.mjs:212-224`）。
