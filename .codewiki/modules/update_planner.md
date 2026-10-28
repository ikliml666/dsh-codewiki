---
title: update_planner
type: module
source_files:
  - lib/update-planner.js
  - test-update-planner.mjs
  - lib/graph-diff.js
  - lib/symbols.js
  - lib/incremental.js
  - index.js
tags: [incremental, planning, documentation, graph-diff]
---

## Overview

`update_planner`（`lib/update-planner.js`）是把「要不要重写某篇文章」升级成「每篇文章该做什么、为什么」的增量计划器。它重写了 FSoft-AI4Code/CodeWiki 的 `updater/ownership.py`、`routing.py`、`stale_scan.py`、`orchestrator.py` 为一组纯函数。

旧实现（`lib/incremental.js:140-193` 的 `filterStaleTasks`）有三个缺陷：反向依赖看不见（`util/strings.js` 签名变了，引用它的 billing 文章却不重写）、新文件无归属（新模块文件被静默丢弃）、未重写页不做 stale scan（正文引用已删除符号的文章过期地留在 wiki 里）。本模块用 `planUpdate` 给出四类显式 action——`write` / `keep` / `delete` / `review`——每个都带 `reason`；无法归属的变更单独列进 `unmappedChanges`，由调用方决定退回全量编译或记 partial，**绝不静默丢弃**。

模块全部为纯函数，不碰文件系统；模块状态文件的读写（`module-map`）集中在文件末尾的 IO 说明小节（实际读写由 `index.js` 的 `loadModuleMap` / `saveModuleMap` 完成，见 Connections）。

## Key Components

### 常量

- `UPDATE_PLAN_VERSION`（第 23 行）：更新计划结构版本，固定为 `1`。
- `MODULE_MAP_VERSION`（第 26 行）：module-map 状态文件版本，固定为 `1`。
- `MODULE_MAP_REL`（第 27 行）：module-map 相对 wiki 根的落盘路径，固定为 `'temp/module-map.json'`（`index.js:1828` 用 `path.join(wikiPath, ...MODULE_MAP_REL.split('/'))` 展开）。

### 导出函数

- `isSourcePath(p)`（第 33–36 行）：仅看扩展名判断是否为源码文件。集合取自 `SUPPORTED_EXTS`（来自 `lib/symbols.js:273` 的 `Map<ext, lang>` 的 key 集，见第 30 行 `SOURCE_EXTS`）。`.md/.json/.log` 等非源码文件返回 `false`——无归属时只记 warning、不触发全量重编（否则随手写的笔记会让增量永远退回 full）。
- `realChangedIds(diff, oldGraph, newGraph, { ignoreCommentOnly = true })`（第 57–81 行）：在 `changedIds` 基础上拆分出 `changed` / `cosmetic`（纯注释改动）/ `real`（实质变化）/ `structural`（interface/added/deleted/renamed/edge）。复用 `codeHash`（`lib/graph-diff.js:108`）判定「代码本体」是否变化；只降级 `body` 类变更，interface/added/deleted/renamed/edge 一律视为实质变化（docstring 变化单独比较，见第 69 行）。
- `dependentsOf(graph, ids)`（第 85–101 行）：反向边索引，`dependsOn` 里既认组件 id 也认文件路径（第 84、89 行），保证「被依赖方变了 → 使用方文章重写」生效。返回 `Map<changedId, 使用方 id 数组>`。
- `scanStaleArticle(article, { deletedComponents, renamedComponents, linkExists })`（第 106–145 行）：单篇文章的 stale scan 纯函数。`linkExists` 由调用方注入（wiki 里是否有这篇）。返回 `{ issues: [{kind, detail}], needsRewrite: bool }`。检测三类：`deleted-symbol`（正文出现已删除符号名或 id 尾巴）、`renamed-symbol`（已改名符号）、`dead-link`（`[[name]]` 与 markdown 相对链接两种形态，第 128–132 行）。`needsRewrite` 仅在引用已删/改名符号时为 `true`；死链只要求 `review`（第 143 行）。
- `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（第 156–436 行）：主入口，详见 Architecture / Data Flow。返回 `UpdatePlan` 对象。
- `buildModuleMap({ articles, graph, plan, now })`（第 442–468 行）：从真实文章 + 符号图 + full 编译 plan 重建 module-map。模块归属优先取 `plan.modules` 里覆盖到该文章 sources 的模块名（第 459 行），否则用 sources 的公共目录。返回 `{ version, generatedAt, articles: { [name]: { sources, components, module } } }`。
- `migrateModuleMap({ articles, now })`（第 472–481 行）：旧 wiki 没有 module-map 时从 frontmatter 保守迁移，只记 `sources`，`components: []`，`migrated: true`，`module` 取 sources 首个目录（第 478 行）。绝不臆造组件。
- `sameModuleMap(a, b)`（第 484–492 行）：忽略 `generatedAt` 比两份 module-map 实质内容是否相同（防止为空转提交写文件）。

### 内部结构（非导出）

- `dirOf(p)`（第 38–41 行）：取相对路径的目录，根目录返回 `''`。
- `commonDir(a, b)`（第 44–53 行）：最长公共目录（至少一级才算同模块），不同目录返回 `''`——用于新文件按目录路由到已有文章。

### `planUpdate` 返回的 UpdatePlan 字段

`planUpdate` 在 `lib/update-planner.js:156-181` 返回的对象包含：

- `version`：等于 `UPDATE_PLAN_VERSION`。
- `fileLevel`：是否退化成文件级判定（无图或 `options.fileLevel === true`，第 179 行）。
- `changedComponents` / `cosmeticComponents` / `structuralComponents`：排序后的组件 id 数组。
- `counts`：`graphDiffCounts` 的结果（interface/added/deleted/renamed/body/edge 计数）。
- `actions`：每篇文章一条 `{ name, articlePath, sources, changedComponents, impactedBy, reasons, action, reason, ... }`，`action ∈ {write, keep, delete, review}`。
- `summary`：`{ write, keep, delete, review }` 计数。
- `unmappedChanges`：无任何文章认领的变更文件（源码 + 非源码都进，但只有源码才阻断基线）。
- `unmappedSourceChanges`：其中是源码扩展名的子集。
- `routedTo`：`[{ file, name }]`，新文件保守路由到的文章。
- `missingSources`：`[{ name, file, reason }]`，缺 source_files 的文章。
- `missingRequired`：计划必需但既不在 wiki 也不在 actions 的文章名。
- `requiredNames`：必需文章名清单（默认等于 write 动作名）。
- `warnings`：提示信息数组（如「源码变更无文章归属」「符号图无依赖边」）。
- `needsFull`：是否要求全量重编（源码无归属或文章缺 source_files 时为 `true`）。
- `fullReason`：退回全量的原因文案。
- `hasChanges`：是否有任何变更。

## Architecture

`planUpdate` 是纯函数，输入三路数据（变更集、旧/新符号图、现存文章 + module-map），输出每篇文章的 action。组件关系如下：

```text
                collectChangeSet (lib/change-set.js)
                          │  sourceChanges/deleted/renamed/untracked
                          ▼
   oldGraph ──diffGraphs──► newGraph  (lib/graph-diff.js, Map<id,node>)
        │                        │
        │  realChangedIds         │  componentsByFile / dependentsOf
        ▼                        ▼
   real/structural/cosmetic   impactByFile (反向依赖闭包)
        │                        │
        └──────────┬─────────────┘
                   ▼
   articles + moduleMap ──► planUpdate (lib/update-planner.js:156)
                   │
        ┌──────────┼───────────────┬───────────────┐
        ▼          ▼               ▼               ▼
   write        keep            review          unmappedChanges
   (自身/依赖/     (无实质变更      (缺 source_files/   (源码无归属→
    删除/改名/     +stale 通过)     死链/stale)          needsFull)
    stale命中)
```

`dependentsOf` / `realChangedIds` 依赖 `lib/graph-diff.js:19` 导出的 `diffGraphs`、`changedIds`、`graphDiffCounts`、`codeHash`，以及 `lib/symbols.js` 的 `SUPPORTED_EXTS`。`normRel` 来自 `lib/incremental.js:118`，把 `\\` 与 `./` 开头的路径归一化为 POSIX 相对路径。

## Data Flow

1. **归一化变更集**（第 171–175 行）：`changeSet` 缺省为「全空」骨架；`sourceChanges` 取自 `cs.sourceChanges ?? cs.all`，`deleted` / `untracked` 各自归一化。
2. **文件级降级判定**（第 179 行）：`fileLevel = options.fileLevel === true || !oldGraph || !newGraph`。降级时跳过图 diff，直接按文件判定，但仍处理删除/改名/新文件。
3. **图 diff 与拆类**（第 185–192 行）：非降级时 `diffGraphs(oldGraph, newGraph)` → `realChangedIds`，拆出 `real`/`structural`/`cosmetic`。
4. **组件→文件索引与反向依赖闭包**（第 195–219 行）：`componentsByFile`（`fileOfComponent` 反向）、仅对 `structural` 变更算 `impactByFile`——实现细节变了不该连带重写引用方（这是与旧实现的关键差异，测试 `test-update-planner.mjs:75` 验证）。
5. **ownership 建立**（第 221–236 行）：以文章 `source_files` 为初始所有权，`moduleMap` 作补充证据；组件所在文件也视为被某文章占住（否则有主源码会被算成无归属）。
6. **逐篇文章判定**（第 238–347 行），优先级：
   - 无 `source_files` → `review` + `needsFull`（第 253–258 行），不再像旧实现只记 note。
   - `sources` 有文件被删除 → `write`，理由点名被删文件（第 259–279 行）。
   - `sources` 有文件被改名 → `write`，理由含 `from→to`（第 280–289 行）。
   - 无符号可判（配置/模板/无语法支持扩展名）→ 文件级判定命中则 `write` 否则 `keep`（第 290–304 行）。
   - 自身源文件组件命中（`ownHit`）或反向依赖影响（`depHit`）→ `write`，理由拼两类（第 305–318 行）。
   - 未命中则跑 `scanStaleArticle`（第 325–344 行）：引用已删/改名符号 → 升级 `write`；仅有死链 → `review`；无问题 → `keep`。
7. **无归属变更兜底**（第 349–390 行）：源码变了但无任何文章认领。新文件按公共目录保守路由给同模块文章（第 359–380 行，把对应 `keep` 改为 `write` 并加 `newFiles`）；路由不到的进 `unmappedChanges`。源码类无归属 → warning 且 `needsFull=true`（第 391–392 行）；非源码（README/笔记）只记账 warning、不触发全量（第 385–389 行）。
8. **必需文章与完整性**（第 399–408 行）：只有 `write` 动作才算「本次必须产出」（第 404 行），`keep`/`review` 不计入，避免正常增量被误判 partial（踩坑见注释 403 行）。

## Connections

- [[graph-diff]]：`planUpdate` 直接调用 `diffGraphs` / `changedIds` / `graphDiffCounts` / `codeHash`，组件 id 与 Node 形状（id/name/kind/relativePath/dependsOn 等）来自该模块约定。
- [[symbols]]：`SUPPORTED_EXTS`（`lib/symbols.js:273`）决定 `isSourcePath` 的判定范围；符号图由 `extractRepoGraph` + `resolveImportEdges` 产出（见测试 `test-update-planner.mjs:26`）。
- [[incremental]]：`normRel`（第 118 行）做路径归一化；旧实现 `filterStaleTasks`（第 140 行）是被本模块取代的对照对象；`loadSnapshot`/`graphFromSnapshot` 提供 old/newGraph。
- [[change-set]]：`collectChangeSet` 产出 `planUpdate` 的 `changeSet` 输入（committed+staged+unstaged+untracked+deleted+renamed 合起来才是「自上次编译以来代码发生了什么」）。
- [[update-record]]：`buildUpdateRecord` 接收 `planUpdate` 返回的 `plan` 写进 `.codewiki/temp/update-record.json`（见 `index.js:4076` 的 `saveRecord`）。
- 调用方 `index.js`：`runStaleUpdate` 在 `index.js:4132` 与 `index.js:4134` 两处调用 `planUpdate`，并把 `updatePlan` 经 `slimPlanForJob`（`index.js:1890`）精简后存入 job；`loadModuleMap`（`index.js:1826`）读/迁移 module-map，`saveModuleMap`（`index.js:1835`）落盘；`makeLinkExists`（`index.js:1867`）为 stale scan 注入 `linkExists`。
- [[engine-native-run]] 与 [[engine-client]]：full 编译由原生引擎通道完成，`buildModuleMap` 在 full 编译成功后重建 module-map（由 `index.js` 编排，本模块只提供纯函数）。

## Known Issues

- **反向依赖闭包依赖 `dependsOn` 边**：如果符号图没有依赖边（第 395–397 行会在 `warnings` 记「符号图没有任何依赖边，反向依赖影响不可用」），本模块只能按 `source_files` 自身判定，接口变了但依赖方文章不会重写——这是历史链路（旧 `extractCurrentGraph` 不建边）的如实记账，不是 bug。
- **`options.staleArticles` 在 `index.js:300` 传入但 `planUpdate` 未使用**：`planUpdate` 自身不消费 `staleArticles`（第 162 行解构未列出该字段），stale 由 `cw status` 与文章实际内容判定，该字段是调用方冗余传入。
- **`delete` action 已定义但无分支产出**：`summary` 统计含 `delete`、`action` 常量含 `'delete'`（第 169、156 文档注释），但当前 `planUpdate` 没有任何分支把某篇文章判成 `delete`——删除文件的文章走的是 `write`（改写以反映源文件消失），真正删文章由 `index.js` 的 `pruneOrphanModules`（`index.js:342`）处理。
- **文件级降级不计算 `impactByFile`**：降级时 `structural` 为空（第 209 行 `if (!fileLevel && structural.size)`），因此无符号图时新文件路由仍按目录保守处理，但反向依赖重写不可用。
