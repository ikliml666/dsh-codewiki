---
title: update_planner
type: module
source_files:
  - lib/update-planner.js
  - test-update-planner.mjs
  - lib/graph-diff.js
  - lib/symbols.js
  - lib/incremental.js
  - lib/update-record.js
tags: [incremental, planning, stale-detection, module-map, reverse-dependency]
---

## Overview

`update_planner`（源文件 `lib/update-planner.js`）是增量编译的「计划器」：它回答「这次改动后，wiki 里的每篇文章该做什么、为什么」，而不只是旧实现里粗糙的「要不要重写」。它是把 FSoft-AI4Code/CodeWiki 的 `updater/ownership.py`、`routing.py`、`stale_scan.py`、`orchestrator.py` 重写为纯函数（不碰文件系统）后抽出的核心模块。

背景缺陷（见 `lib/update-planner.js:4-14` 与 `lib/incremental.js:140-194`）：旧实现 `filterStaleTasks`（`lib/incremental.js:140-194`）只从文章既有 `source_files` 里取组件，命中变更就写、没命中就丢，造成三个后果：

1. **反向依赖看不见**：`util/strings.js` 的签名变了，引用它的 `billing` 文章却不重写；
2. **新文件无归属**：新加的模块文件不属于任何文章的 `source_files`，被静默丢弃；
3. **未重写页不做 stale scan**：正文里引用着已删除的符号、指向已不存在的文章，文章就这样过期地留在 wiki 里。

本模块把「要不要重写」升级成四类显式 `action`：`write` / `keep` / `delete` / `review`，每个都带 `reason`；无法归属的变更单独列出（`unmappedChanges`），由调用方决定退回全量编译或记 `partial`——绝不静默丢弃。

模块由两部分组成：

- **纯函数计划器**（`lib/update-planner.js:33-436`）：`planUpdate` 主入口，配合 `isSourcePath`、`realChangedIds`、`dependentsOf`、`scanStaleArticle` 等辅助函数，输出一份 `UpdatePlan`。
- **module-map 状态管理**（`lib/update-planner.js:442-492`）：`buildModuleMap` / `migrateModuleMap` / `sameModuleMap`，维护一份版本化单一状态文件 `temp/module-map.json`，记录「文章 → 源码/组件/模块」的关系，供 `planUpdate` 作为补充所有权证据。

## Key Components

### Constants

- `UPDATE_PLAN_VERSION = 1` —— 计划 schema 版本，落在 `UpdatePlan.version`（`lib/update-planner.js:411`）。
- `MODULE_MAP_VERSION = 1` —— module-map 状态文件 schema 版本（`lib/update-planner.js:26`）。
- `MODULE_MAP_REL = 'temp/module-map.json'` —— module-map 在 wiki 内的相对落盘路径（`lib/update-planner.js:27`）。
- `SOURCE_EXTS` —— 由 `SUPPORTED_EXTS`（来自 `lib/symbols.js:273-276`，`Map<ext, lang>`）的 key 集合构造的源码扩展名集合（`lib/update-planner.js:29-30`）。

### Functions (public)

- `isSourcePath(p)`（`lib/update-planner.js:33-36`）：只看扩展名（不读内容）判断 `p` 是否为源码文件。非源码文件（`.md`/`.json`/`.log`…）无归属时只记 warning，不触发全量重编，否则任何随手写的笔记都会让增量永远退回 full。

- `dirOf(p)`（`lib/update-planner.js:38-41`）：取 `p` 的目录部分（经 `normRel` 归一后的 posix 路径），仓库根返回 `''`。

- `commonDir(a, b)`（`lib/update-planner.js:44-53`）：取两路径的最长公共目录（至少一级才算「同模块」），不同目录返回 `''`。用于新文件路由时判断「与某篇文章共享目录前缀」。

- `realChangedIds(diff, oldGraph, newGraph, { ignoreCommentOnly = true })`（`lib/update-planner.js:57-81`）：在 `changedIds(diff)`（`lib/graph-diff.js:436-440`）基础上做纯度降级。返回 `{ changed, cosmetic, real, structural }` 四个 `Set`：
  - `cosmetic`：仅改注释/排版（body 变更且 `codeHash` 相同、`docstring` 没变）的组件，复用 `codeHash`（`lib/graph-diff.js:108-111`）做哈希，不另造规则；
  - `real`：`changed` 中剔除 `cosmetic` 的部分；
  - `structural`：`real` 中属于 `interface`/`added`/`deleted`/`renamed`/`edge` 任一类的组件（实现细节 `body` 变更不算，避免连带重写依赖方）。

- `dependentsOf(graph, ids)`（`lib/update-planner.js:85-101`）：反向依赖索引。遍历 `graph` 中每个节点的 `dependsOn`（其中既可能是组件 id，也可能是文件路径，两种都认），返回 `Map<被依赖id, 使用方id[]>`。用于「被依赖方变了 → 使用方文章要重写」。

- `scanStaleArticle(article, { deletedComponents = [], renamedComponents = [], linkExists = null })`（`lib/update-planner.js:106-145`）：单篇文章的 stale scan（纯函数，不碰文件系统）。`linkExists(target)` 由调用方注入（判断 wiki 里是否有这篇）。返回 `{ issues, needsRewrite }`，其中 `issues` 为 `{ kind, detail }` 列表，三类问题：
  - `deleted-symbol`：正文出现已删除组件的名字或 id 尾巴；
  - `renamed-symbol`：正文出现已改名组件的旧名；
  - `dead-link`：`[[name]]` 或 markdown 相对 `.md` 链接指向不存在的文章（非 `http(s):` 协议）。
  - `needsRewrite`：仅当命中 `deleted-symbol` 或 `renamed-symbol`（内容已错）时为 `true`；死链只要求 `review`（链接目标可能只是被改名成等价标题）。

- `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`lib/update-planner.js:156-436`）：**计划主入口**（纯函数）。详细见下文「Data Flow」。返回 `UpdatePlan` 对象（结构见 `lib/update-planner.js:154-179`）。

- `buildModuleMap({ articles, graph, plan, now })`（`lib/update-planner.js:442-468`）：从真实图与文章构造 module-map。每篇文章记录 `{ sources, components, module }`：组件来自其 `sources` 在 `graph` 中的组件 id；`module` 优先取 full 编译 `plan.modules` 里的模块名，否则用 `sources` 的公共目录（仅当所有源文件同目录时）。

- `migrateModuleMap({ articles, now })`（`lib/update-planner.js:472-481`）：旧 wiki 没有 module-map 时从 frontmatter 保守迁移——只记 `sources`，`components` 留空（下次编译成功由真实 plan 重建），并标 `migrated: true`。绝不因为缺文件就当成「没有归属」。

- `sameModuleMap(a, b)`（`lib/update-planner.js:484-492`）：比较两份 module-map 的实质内容（忽略 `generatedAt` 与排序），用于避免为空转提交写文件。

### Key types / shapes

**`UpdatePlan`**（返回自 `planUpdate`，`lib/update-planner.js:156-181`）：

| 字段 | 含义 |
| --- | --- |
| `version` | `UPDATE_PLAN_VERSION` |
| `fileLevel` | 是否降级为文件级判定（无图 / `options.fileLevel`） |
| `changedComponents` / `cosmeticComponents` / `structuralComponents` | 排序后的组件 id 数组 |
| `counts` | `graphDiffCounts(diff)` 结果（`lib/graph-diff.js:425-434`） |
| `actions` | 每篇文章一个 action 对象（见下） |
| `summary` | `{ write, keep, delete, review }` 计数 |
| `unmappedChanges` | 无文章认领的变更文件（含非源码，如 `CodeWiki.md`） |
| `unmappedSourceChanges` | `unmappedChanges` 中真正是源码的 subset —— 阻断基线前移的就是它 |
| `routedTo` | `[{ file, name }]`：新文件按模块目录保守路由的目标文章 |
| `missingSources` | 缺 `source_files` 的文章 `{ name, file, reason }` |
| `missingRequired` | 计划必需但既不在 `articleNames` 也不在 `actions` 的命名 |
| `requiredNames` | 本次必需文章清单（`options.requiredNames` 或所有 `write` 名） |
| `warnings` | 诊断信息数组（如反向依赖图无边、非源码无归属） |
| `needsFull` | 是否必须退回全量编译 |
| `fullReason` | 退回全量的理由文本 |
| `hasChanges` | 是否有任何变更 |

**Action 对象**（每个 `actions` 元素，`lib/update-planner.js:168-175, 271-346`）字段：
`name`、`articlePath`、`sources`、`action`（`write`/`keep`/`delete`/`review`）、`reason`、`changedComponents`、`impactedBy`、`staleIssues`、`newFiles`、`needsFull`。

**module-map 形状**（`buildModuleMap` 返回，`lib/update-planner.js:442`）：
`{ version, generatedAt, articles: { [name]: { sources: string[], components: string[], module: string|null } } }`；迁移版额外带 `migrated: true` / `migratedFromFrontmatter: true`。

## Architecture

`planUpdate` 把外部输入（变更集、符号图、文章、module-map）折成三类判定，输出显式 action。下列框图标注组件名与文件/函数，箭头标注关系：

```text
                 changeSet            oldGraph / newGraph          articles(+moduleMap)
                     │                        │                          │
                     ▼                        ▼                          ▼
            ┌──────────────────────────────────────────────────────────────────────┐
            │  planUpdate  (lib/update-planner.js:156)                                │
            │                                                                        │
            │  diffGraphs ──► realChangedIds ──► {real, cosmetic, structural}         │
            │   (graph-diff.js:447)    (update-planner.js:57)                         │
            │                                        │                               │
            │                  dependentsOf ──► impactByFile (反向依赖闭包)          │
            │                   (update-planner.js:85)   (仅 structural)             │
            │                                        │                               │
            │   ┌──────────── 逐篇判定 ───────────────┴───────────────────────┐      │
            │   │ gone? ─write │ renamed? ─write │ no-symbol? ─fileLevel       │      │
            │   │ ownHit/depHit? ─write │ else ─scanStaleArticle─►write/review/keep │ │
            │   └─────────────────────────────────────────────────────────────┘      │
            │                                        │                               │
            │           无归属变更 ──► routedTo(同模块路由) / unmappedChanges          │
            └──────────────────────────────────────────────────────────────────────┘
                     │
                     ▼
                 UpdatePlan ──► buildModuleMap / migrateModuleMap (写入 module-map)
                     │
                     ▼
              update-record.judgeOutcome (lib/update-record.js:37)
```

关键设计点：

- **反向依赖闭包只对 `structural` 做**（`lib/update-planner.js:209-219`）：接口变了/新增/删除/改名/依赖边变了才会连带重写使用方文章；纯 `body` 实现细节变更不波及依赖方（测试 `test-update-planner.mjs:75-86` 验证）。
- **component→file 索引**（`lib/update-planner.js:195-203`）：新图侧构建 `componentsByFile` 与 `fileOfComponent`，新增文件也能算进归属。
- **ownership 来源**（`lib/update-planner.js:221-236`）：以文章 `sources` 为初始所有权，`moduleMap.articles[].sources` 作补充，且组件所在文件视为已被某篇文章占住。
- **stale scan 在「未命中」分支才跑**（`lib/update-planner.js:319-344`）：自身与依赖都没实质变更的文章，既可能引用了已删符号（升级 `write`），也可能只有死链（进 `review`），否则 `keep`。

## Data Flow

`planUpdate` 入参（`lib/update-planner.js:156-163`）：

```js
planUpdate({
  changeSet = null,   // collectChangeSet 产物（可为 null → 显式要求 full）
  oldGraph = null,    // Map<id,node>；任一为 null 退化为文件级判定
  newGraph = null,
  articles = [],      // [{ name, articlePath, sources:[file], content?, type? }]
  moduleMap = null,   // { version, articles:{ [name]:{ sources, components, module } } }
  options = {},       // { fileLevel, linkExists, articleExists, requiredNames }
})
```

执行流程（纯函数，不碰文件系统）：

1. **归一变更集**（`lib/update-planner.js:171-175`）：`sourceChanges` / `deleted` / `renamed` / `untracked` 各自经 `normRel`（`lib/incremental.js:118-119`）归一为 `Set`/`array`。
2. **文件级降级判定**（`lib/update-planner.js:179-192`）：`fileLevel = options.fileLevel === true || !oldGraph || !newGraph`。非 `fileLevel` 时才 `diffGraphs`（`lib/graph-diff.js:447-564`）+ `realChangedIds`；否则 `real`/`structural`/`cosmetic` 全空，只走文件命中。
3. **构建 component→file 索引与反向依赖闭包**（`lib/update-planner.js:195-219`）：`fileLevel` 下 `impactByFile` 为空。
4. **遍历文章判定**（`lib/update-planner.js:238-347`），逐篇产出 action：
   - 无 `sources` → `review` + `missingSources`，`needsFull=true`（`lib/update-planner.js:253-258`）。
   - `sources` 中有 `deleted` 文件 → `write`（理由点名被删文件，`lib/update-planner.js:270-279`）。
   - 有文件被 `renamed` → `write`（理由含 `from→to`，`lib/update-planner.js:280-289`）。
   - 无任何符号可判 → 文件级降级：`sourceChanges` 命中则 `write`，否则 `keep`（`lib/update-planner.js:290-304`）。
   - 自身 `real` 命中或有 `impactedBy` 依赖影响 → `write`，带 `changedComponents`/`impactedBy`（`lib/update-planner.js:305-318`）。
   - 以上都不中 → 跑 `scanStaleArticle`（`lib/update-planner.js:319-344`）：引用已删/改名符号则 `write`；仅死链则 `review`；都无则 `keep`。
5. **无归属变更处理**（`lib/update-planner.js:349-390`）：遍历 `sourceChanges` 中未被 `claimedFiles` 认领的文件。
   - 与某篇文章 `sources` 共享目录前缀 → `routedTo`，把该新文件并入最佳候选文章（把其 `keep` 升级为 `write`，`lib/update-planner.js:360-380`）。
   - 否则进 `unmappedChanges`；是源码则推 warning 并计入 `unmappedSourceChanges`。
6. **汇总**（`lib/update-planner.js:391-435`）：
   - `needsFull = unmappedSource.length > 0 || 有 action.needsFull === true`。
   - 若符号图没有任何 `dependsOn` 边（`lib/update-planner.js:395-397`），追加 warning「反向依赖影响不可用」。
   - `requiredNames`：默认取所有 `write` 动作名（`lib/update-planner.js:405-407`），供 `update-record` 判定缺页。
   - 注意：`keep` 与 `review` 不算「必需产出」，把它们算进必需清单会让正常增量永远缺页（曾踩坑，见 `lib/update-planner.js:399-408` 注释）。

**module-map 数据流**：`buildModuleMap`（`lib/update-planner.js:442-468`）在 full 编译成功后由真实 `plan` + `graph` + `articles` 重建；旧 wiki 无此文件时 `migrateModuleMap`（`lib/update-planner.js:472-481`）从 frontmatter 保守迁移。`sameModuleMap`（`lib/update-planner.js:484-492`）避免为空转提交写文件。

## Connections

- [[incremental]] —— 上游增量模块：`filterStaleTasks`（`lib/incremental.js:140-194`）是本模块要取代的旧「要不要重写」逻辑；`normRel`（`lib/incremental.js:118-119`）被本模块直接复用；符号图快照（`slimGraph`/`loadSnapshot`）提供 `oldGraph`/`newGraph`。
- [[graph-diff]] —— `diffGraphs` / `changedIds` / `graphDiffCounts` / `codeHash`（`lib/graph-diff.js`）提供组件级 diff 与纯注释降级所需的哈希。
- [[symbols]] —— `extractRepoGraph` / `resolveImportEdges`（`lib/symbols.js`）产出带 import 边的符号图（没有边则反向依赖影响不可用）；`SUPPORTED_EXTS`（`lib/symbols.js:273-276`）提供 `isSourcePath` 的扩展名集合。
- [[update-record]] —— `judgeOutcome`（`lib/update-record.js:37-128`）消费 `UpdatePlan` 的 `unmappedSourceChanges` / `missingSources` / `requiredNames` / `actions` 判定终态（`done`/`partial`/`failed`）与基线能否前移（测试 `test-update-planner.mjs` 端到端验证）。

## Known Issues

- **反向依赖图缺边时无法使用**（`lib/update-planner.js:392-397`）：旧链路 `extractCurrentGraph` 曾不建 `dependsOn` 边，那时「接口变了但依赖方文章不重写」是必然的。本模块如实记账（warning），不假装做到了。前提依赖见 `lib/symbols.js:824-831` 的边落点逻辑与测试 `test-update-planner.mjs:21-28` 的 `graphOf` 必须调用 `resolveImportEdges`。
- **纯注释降级依赖 `codeHash` 缓存分支**（`lib/update-planner.js:66-68`、`lib/graph-diff.js:108-111`）：快照回读节点不带 `sourceCode`，靠固化的 `codeHash` 字段；若节点两者皆无则跳过降级（保守不误判），可能放过本可 `keep` 的注释改动。
- **`commonDir` 路由只按目录前缀，不按语义**（`lib/update-planner.js:360-364`）：新文件同模块路由取「公共目录最深的文章」，是保守近似，可能并入并非最相关的文章。这是「变化不能丢」优先于「精准归属」的取舍。
- **`delete` action 在网络上被定义但本模块不实际产出**（`lib/update-planner.js:12` 注释列出四类 `write/keep/delete/review`，但遍历逻辑只产 `write`/`keep`/`review`，见 `lib/update-planner.js:253-346`）。删除类动作由上层 `update-record` / 编排层根据 `deleted` 与孤儿文章另行处理；本模块自身不直接发 `delete`。
- **`scanStaleArticle` 死链判定兼容「同篇内重定向」**（`lib/update-planner.js:106-108`）：死链只进 `review` 不硬重写，避免链接目标只是被改名成等价标题时误触发重写。
- **踩坑记录（写入代码注释，供后续 agent 参考）**：`keep`/`review` 不得计入 `requiredNames`（`lib/update-planner.js:399-408`）；非源码文件（如 `CodeWiki.md`）无归属是常态，只能进 `warnings` 不可进 `unmappedChanges`（`lib/update-planner.js:419-423`），否则正常增量会永远落 `partial`。
