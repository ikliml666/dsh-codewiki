---
title: incremental
type: module
source_files:
  - lib/incremental.js
  - lib/graph-diff.js
  - test-incremental.mjs
  - test-incremental-e2e.mjs
tags: [snapshot, stale-task, incremental-compile, symbol-diff]
---

## Overview

`lib/incremental.js` 实现「符号级增量编译」的核心两步：① 把每次编译时的全仓库 AST 符号图（来自 [[symbols]]）瘦身成一份不存源码全文、只含判定所需字段的快照，落盘到 `.codewiki/temp/symbol-graph.json`，跨会话/跨机器保留，用于下次比对；② 把「文件级改动」折算成「组件级改动」，并据每篇文章 frontmatter 的 `source_files` 决定哪些文章必须重写（keep）、哪些可以跳过（dropped）。

它的存在动机（见文件头注释 `lib/incremental.js:1-13`）：`cw status` 只能给到文件级（哪些文件的 mtime/内容变了）。但绝大多数改动只改了注释/空行/局部实现，模块的对外接口与职责没变，文章没必要重写。CodeWiki 的 updater 用组件级 hash + 签名比对把这些「伪变更」过滤掉，只把 `interface`/`added`/`deleted`/`renamed` 这类真正改变架构描述的变更留给写作者。

本模块是纯逻辑 + IO 的混合体：

- 纯函数（判定、快照构造、序列化）不碰文件系统，方便单测：见 `filterStaleTasks`（`lib/incremental.js:140`）、`slimGraph`（`lib/incremental.js:37`）、`sameSnapshotContent`（`lib/incremental.js:53`）。
- IO 集中在 `loadSnapshot`/`saveSnapshot`/`snapshotPath`（`lib/incremental.js:90`、`:106`、`:90`）。

组件级 diff 的计算本身不在本模块，而是复用 `lib/graph-diff.js` 的 `diffGraphs`/`changedIds`/`graphDiffCounts`/`bodyHash`/`codeHash`（见 `lib/incremental.js:17` 的 import）。本模块在 diff 之上做两件事：快照的「瘦身存取」，以及在判定层加一道「纯注释改动降级」（`lib/incremental.js:146-169`）——这是 `lib/graph-diff.js` 的 hash 粒度不区分注释导致的，本模块在判定层用 `codeHash` 补一道，而不动与上游逐位对齐的 `diffGraphs`。

## Key Components

### 常量与导出符号

- `SNAPSHOT_VERSION`（导出，常量，`lib/incremental.js:19`）：快照格式版本号，当前为 `1`。`loadSnapshot` 用它校验回读快照的版本（见 `lib/incremental.js:94`）。
- `SNAPSHOT_REL`（导出，常量，`lib/incremental.js:22`）：快照相对 wiki 根的路径，值为 `path.posix.join('temp', 'symbol-graph.json')`，即 `.codewiki/temp/symbol-graph.json`。注释说明它类比上游 wiki_out/temp，随 wiki 一起入库，避免换机器后拿不到旧图退化成全量重写。
- `SLIM_FIELDS`（模块内常量，非导出，`lib/incremental.js:26`）：快照只保留这些字段——`['id', 'name', 'kind', 'relativePath', 'parameters', 'baseClasses', 'dependsOn', 'bodyHash', 'codeHash']`。`sourceCode` 一律不存（体积），`bodyHash`/`codeHash` 固化进快照让后续回读走缓存分支、不再需要源码。

### 函数

- `slimComponent(node)`（导出，纯函数，`lib/incremental.js:28-34`）：把一个图节点瘦身为快照组件对象。只挑 `SLIM_FIELDS` 里非 `undefined` 的字段；强制把 `id` 和 `relativePath` 规范化为字符串（缺省 `''`）。`node` 为 `null`/`undefined` 时安全返回 `{id:'', relativePath:''}`。

- `slimGraph(graph, { commit, now })`（导出，纯函数，`lib/incremental.js:37-48`）：`Map<id,node>` → 可 JSON 化的快照对象 `{ version, generatedAt, commit, components }`。
  - `components` 由图节点 `map` 成 `slimComponent({...n, bodyHash: n.bodyHash ?? bodyHash(n), codeHash: n.codeHash ?? codeHash(n)})`：现场节点没缓存哈希就现算一次固化（`lib/incremental.js:40-45`），之后回读不再需要源码重算。
  - 按 `id` 升序排序（`lib/incremental.js:53`），保证序列化稳定（与 `sameSnapshotContent` 的归一顺序一致）。
  - `generatedAt` 默认 `new Date().toISOString()`，`commit` 默认为 `null`（由调用方传入 `currentCommit(cwd)`，见 `index.js:3427`）。

- `sameSnapshotContent(a, b)`（导出，纯函数，`lib/incremental.js:53-66`）：比较两份快照的「实质内容」是否相同，**忽略 `generatedAt`/`commit` 这类每次都变的元数据**。用途（见 `lib/incremental.js:50-52`）：编译收尾写快照前先比一次——代码没变就不要覆盖，否则 `autoCommit` 会为「只改了一个时间戳」生成一个空转提交把历史搞脏。`norm` 内部按 `SLIM_FIELDS` 归一、过滤掉无 `id` 的组件、按 `id` 排序后 `JSON.stringify` 比较。任一为 `null`/`undefined` 返回 `false`（见 `lib/incremental.js:54`、`:65`）。

- `graphFromSnapshot(snap)`（导出，纯函数，`lib/incremental.js:69-88`）：快照对象 → `Map<id,node>`，直接喂给 `lib/graph-diff.js` 的 diff 输入。回读节点**不恢复 `sourceCode`/`docstring`**（填 `''`），但保留固化的 `bodyHash`/`codeHash`——后续 `filterStaleTasks` 判 `codeHash` 时用固化值，判不出就当 `null` 保守处理（`lib/incremental.js:162-163`、`lib/incremental.js:140`）。`relativePath`/`parameters`/`baseClasses`/`dependsOn` 缺省为空数组/空串，保证下游 `diffGraphs` 不报错。

- `snapshotPath(wikiPath)`（导出，`lib/incremental.js:90-92`）：返回 `path.join(wikiPath, ...SNAPSHOT_REL.split('/'))`，即 `wikiPath/.codewiki/temp/symbol-graph.json`。

- `loadSnapshot(wikiPath, fsImpl = fs)`（导出，`lib/incremental.js:94-104`）：读取并解析快照。读失败 / 解析失败 / `version !== SNAPSHOT_VERSION` / `components` 非数组，**全部静默返回 `null`**（见 `lib/incremental.js:98-103`）。返回 `null` 的语义是「没有可用旧图」——调用方据此退化为全量或文件级判定，而不是误判。支持注入 `fsImpl` 便于测试（`test-incremental.mjs:200` 用真实 fs，`test-incremental-e2e.mjs:58` 验证无目录时返回 `null`）。

- `saveSnapshot(wikiPath, snap, fsImpl = fs, pathImpl = path)`（导出，`lib/incremental.js:106-115`）：自动 `mkdirSync` 父目录后写 `JSON.stringify(snap)`，成功返回 `{ ok: true, path }`，失败返回 `{ ok: false, reason }`。写入失败不影响编译结果，只是下次退回文件级判定（`index.js:3436`）。

- `normRel(p)`（导出，`lib/incremental.js:118-120`）：目录相对路径归一：把 `\` 换成 `/`、去掉开头的 `./`、`.trim()`。用于兼容 Windows 反斜杠路径与 `./` 前缀（见 `test-incremental.mjs:169-176`）。注意此函数与 `lib/update-planner.js:21` 导入的是同一实现。

- `componentsByFile(graph)`（导出，纯函数，`lib/incremental.js:123-132`）：遍历 `graph` 按 `normRel(relativePath)` 聚合成 `Map<file, id[]>`。只用新图侧（新增文件也要算进去）。`relativePath` 为空的节点跳过。供 `filterStaleTasks` 把「文章 source_files」映射到「该文件里覆盖了哪些组件」。

- `filterStaleTasks(tasks, oldGraph, newGraph, opts = {})`（导出，**核心判定**，纯函数，`lib/incremental.js:140-194`）：
  - **输入**：`tasks` 为 `[{ name, articlePath, sources: [file...] }]`；`oldGraph`/`newGraph` 为 `Map<id,node>`（通常来自 `graphFromSnapshot(oldSnap)` 与 `extractCurrentGraph`）。
  - **过程**：
    1. `diff = diffGraphs(oldGraph, newGraph, opts)`（`lib/incremental.js:141`），`changed = changedIds(diff)`，`counts = graphDiffCounts(diff)`，`byFile = componentsByFile(newGraph)`（`lib/incremental.js:142-144`）。
    2. 纯注释降级（`lib/incremental.js:154-169`）：遍历 `changed` 中属于 `diff.body` 的组件，用 `codeHash`（现场算或取固化值）比较——`codeHash` 相等且 docstring 未变则判为 `cosmeticOnly`（纯注释/排版改动），不计作真实变更。可用 `opts.ignoreCommentOnly === false` 关闭（默认开启）。
    3. `realChanged = changed - cosmeticOnly`（`lib/incremental.js:170`）。
  - **逐任务判定**（`lib/incremental.js:174-192`）：
    - 收集该文章 `sources` 命中的组件 `ids`；若 `ids.size === 0`（无符号可判，如配置文件/模板/无语法支持的扩展名）→ 保守保留，`keep.push({...t, changedComponents: [], symbolFallback: true})`（`lib/incremental.js:179-183`）。
    - 否则 `hit = ids ∩ realChanged`；有命中则 `keep.push({...t, changedComponents: hit.sort()})`（`lib/incremental.js:185-186`），把真正变了的组件 id 喂给写作者当重点。
    - 无命中（且非 symbolFallback）→ `dropped.push`，若只命中 `cosmeticOnly` 组件则带 `cosmeticOnlyComponents` 原因（`lib/incremental.js:187-191`）。
  - **返回** `{ keep, dropped, change: diff, counts, cosmeticOnly: [...] }`（`lib/incremental.js:193`）。`keep[i].changedComponents` 是「该文章覆盖到的、本次真的变了」的组件 id 列表。
  - **关键不变式**（注释 `lib/incremental.js:139`）：没有任何符号可判的文章一律 `keep`（宁可多写一篇，不留下过期文章）。

- `describeChange(counts)`（导出，`lib/incremental.js:197-206`）：把 `counts`（来自 `graphDiffCounts`）翻译成中文摘要，如 `接口变 1`、`新增 1`、`删除 1`、`改名 1`、`实现变 1`、`依赖变 1`；全为 0 时返回 `'无实质变更'`。写进 job note 让人一眼看出「改了几处、为什么少写了 N 篇」。

### 与 `lib/graph-diff.js` 的契约

`lib/incremental.js:17` 从 `lib/graph-diff.js` 导入 `diffGraphs`、`changedIds`、`graphDiffCounts`、`bodyHash`、`codeHash`：

- `bodyHash(node)`（`lib/graph-diff.js:121-126`）：源码＋docstring 归一化后的 sha1。快照回读节点无源码时走 `node.bodyHash` 固化值。
- `codeHash(node)`（`lib/graph-diff.js:108-111`）：**剥掉注释与排版**后的源码 sha1——只改注释 `codeHash` 不变，改代码才变。这是 `filterStaleTasks` 纯注释降级的依据（`lib/incremental.js:162-163`）。
- `diffGraphs(oldGraph, newGraph, opts)`（`lib/graph-diff.js:447-564`）：返回 `emptyGraphDiff()` 形状（`lib/graph-diff.js:413-423`）——`added/deleted/interface/body/edge` 都是 `Set`，`renamed` 是 `Map<oldId,newId>`，`records` 是 `Map`。
- `changedIds(d)`（`lib/graph-diff.js:436-440`）：`added ∪ deleted ∪ interface ∪ body ∪ edge ∪ renamed.values()`。
- `graphDiffCounts(d)`（`lib/graph-diff.js:425-434`）：把上述 Set 大小转为 `{added, deleted, interface, body, edge, renamed}` 计数对象。

## Architecture

```text
                  ┌──────────────────────────────┐
                  │   extractCurrentGraph()      │  index.js:2149
                  │   (lib/symbols.js 全仓库图)   │
                  └───────────────┬──────────────┘
                                  │ Map<id,node>
                  ┌───────────────┴──────────────┐
                  │  slimGraph()                 │  incremental.js:37
                  │  graphFromSnapshot()         │  incremental.js:69
                  └───────┬───────────────┬──────┘
                          │               │
              ┌───────────┴────┐    ┌─────┴──────────────┐
              │ saveSnapshot() │    │ loadSnapshot()     │  incremental.js:106 / :94
              │ .codewiki/     │    │ (version≠1→null)   │
              │ temp/symbol-   │    └─────────┬──────────┘
              │ graph.json     │              │ oldGraph
              └────────────────┘              │
                                             ▼
                  newGraph ──► diffGraphs() ──► diff (lib/graph-diff.js:447)
                                  │
                                  ▼
                  filterStaleTasks()           incremental.js:140
                    • codeHash 降级纯注释        │
                    • componentsByFile 反查      │
                    • per-task keep/dropped     │
                                  │
                                  ▼
                  { keep[], dropped[], change, counts, cosmeticOnly }
                                  │
                                  ▼
                  写作者(keep) / 跳过(dropped) / describeChange→job note
```

## Data Flow

1. **快照写入**：每次编译 `tickIndex` 收尾时（`index.js:3346-3367`），若 `symbolIncremental` 开启且 `extractCurrentGraph` 就绪（`index.js:3424-3426`），调用 `slimGraph(cur.graph, { commit: currentCommit(job.cwd) })` 构造快照（`index.js:3427`）。写前用 `loadSnapshot` 取旧快照并 `sameSnapshotContent` 比较（`index.js:3430-3431`）：实质内容没变就跳过写入（`index.js:3432`），避免 `autoCommit` 空转提交。
2. **快照回读（下次增量）**：stale 编译时，旧快照经 `graphFromSnapshot(loadSnapshot(wikiPath))` 还原成 `oldGraph`（`test-incremental-e2e.mjs:70`），当前代码经 `extractCurrentGraph` 得到 `newGraph`。
3. **组件级 diff**：`filterStaleTasks` 内部调 `diffGraphs(oldGraph, newGraph)`、`changedIds`、`graphDiffCounts`（见上文 Key Components）。
4. **纯注释降级**：对 `diff.body` 里的组件重算 `codeHash`（`lib/incremental.js:162-163`），若 `codeHash` 相等且 docstring 未变，从 `realChanged` 剔除。老快照无 `codeHash` 字段时（`lib/incremental.js:170-171` 取 `null`）退到原行为保守保留（见 `test-incremental.mjs:109-118`）。
5. **文章判定**：用 `componentsByFile(newGraph)` 把每篇任务的 `source_files` 映射到组件 id，与 `realChanged` 取交集。有交集→`keep`（带 `changedComponents`）；无交集且 `ids` 为空→`keep` + `symbolFallback:true`（保守）；否则→`dropped`。
6. **摘要**：`describeChange(counts)` 进 job note（`index.js:21` 附近用法见 e2e `test-incremental-e2e.mjs:75`）。

> 注意：`filterStaleTasks` 是「从文章既有的 source_files 取组件、命中就写」的纯判定器。它**不处理反向依赖、新文件无归属、stale scan**（这些由 [[update-planner]] 的 `planUpdate` 负责）。`lib/update-planner.js:156-166` 的注释明确指出这是旧实现的缺陷，本模块的 `filterStaleTasks` 专注「组件级 keep/dropped 折算」，更完整的增量计划交给 `planUpdate`。

## Connections

- [[symbols]]：`extractCurrentGraph` / `extractRepoGraph` 提供的 `Map<id,node>` 是 `slimGraph`/`filterStaleTasks` 的输入；节点字段契约（`id/name/kind/relativePath/sourceCode/docstring/parameters/baseClasses/dependsOn`）在 `lib/symbols.js:785-786` 与本模块一致。
- [[graph-diff]]：`lib/graph-diff.js` 是组件级 diff 的计算引擎，`diffGraphs`/`changedIds`/`graphDiffCounts`/`bodyHash`/`codeHash` 全部来自它；`codeHash`（注释无关哈希）是本模块纯注释降级的基础。
- [[update-planner]]：`planUpdate`（`lib/update-planner.js:156`）是更上层的增量计划器，吸收 `filterStaleTasks` 的「组件级判定」思路但扩展到反向依赖/新文件/stale scan；`lib/update-planner.js:57` 的 `realChangedIds` 复用了与本模块完全同款的 `codeHash` 纯注释降级判据（不另造哈希规则）。
- [[update-record]]：`tickIndex` 收尾时 `saveRecord`（`index.js:2495`）把 `changeSet`/`updatePlan`/`results` 写入 `.codewiki/temp/update-record.json` 复盘；`filterStaleTasks` 不参与记录，但 `describeChange` 的摘要进入 job note。
- `index.js`（编排服务）：`extractCurrentGraph`（`index.js:2149`）、`currentCommit`（`index.js:1845`）、`tickIndex` 快照回写（`index.js:3346-3367`）、`submit` 的 stale 预置任务（`index.js:3579`）、`tickArticles` 直接取 `job.tasks`（`index.js:2989`）。配置项 `symbolIncremental`（`index.js:89`、`liveConfig` 见 `index.js:102`）控制是否启用符号级增量（关闭则退回文件级 mtime/hash 判定）。

## Known Issues

- **`filterStaleTasks` 不处理反向依赖 / 新文件无归属 / stale scan**：这是已知的职责边界（见 `lib/update-planner.js:4-14`），完整增量规划由 [[update-planner]] 的 `planUpdate` 负责。若单独使用 `filterStaleTasks`，「改了被依赖的模块、使用方文章也该重写」这条判定不会生效（不过 `index.js:21-24` 已给 `extractCurrentGraph` 补上依赖边，使 `planUpdate` 的反向依赖闭包可用）。
- **老快照无 `codeHash` 字段会退回原行为**：`lib/incremental.js:162-163` 在取不到固化 `codeHash` 时直接 `continue`，纯注释降级不触发、文章保守保留——符合「宁可多写不漏写」，但意味着老格式快照（v1 之前的实验格式）下「只改注释不重写」的承诺不生效（测试见 `test-incremental.mjs:109-118`）。
- **快照版本不符/坏 JSON 静默返回 `null`**：`lib/incremental.js:98-103`，调用方必须显式处理 `null`，否则会把「无旧图」误当全量或文件级——`index.js` 侧通过 `filterStaleTasks` 的 `oldGraph` 为 `new Map()` 时自然降级（见 `test-incremental.mjs:160-167` 的 `new Map()` 入参）。
- **`codeHash` 的注释剥离是近似**：`lib/graph-diff.js:64-100` 的 `stripComments` 在字符串字面量里的 `//` 会被误判为注释（注释里明确说「可接受的近似」），极端情况下可能让含 `//` 的字符串行被剥掉、概率性碰撞；但这只影响纯注释降级的精确度，不会误判实现变更（实现变更一定改变 `codeHash`）。
