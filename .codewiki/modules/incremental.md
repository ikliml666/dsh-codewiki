---
title: incremental
type: module
source_files:
  - lib/incremental.js
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - lib/graph-diff.js
  - lib/update-planner.js
  - index.js
tags: [incremental, snapshot, stale, symbol-diff, change-filter]
---

## Overview

`lib/incremental.js` 负责**符号级（组件级）增量判定**：把「这次代码改动到底要不要重写某篇 wiki 文章」从粗糙的文件级（只看 `cw status` 的 mtime/内容 hash）细化到符号级，吸收自 FSoft-AI4Code/CodeWiki 的 `updater`。核心收益是：一次改动绝大多数只是「改了注释/空行/局部实现」，模块的对外接口与职责没变，文章没必要重写。

本模块承担三件事（见 `lib/incremental.js:8-13` 的模块头注释）：

1. **图快照的瘦身存取**：只存判定需要的字段，不存源码全文（`.codewiki/` 会入库，存全文太重）。固化 `bodyHash`/`codeHash`，让 `graph-diff` 走缓存分支、省掉回读源码重算。
2. **「文件级变更」→「组件级变更」折算**：复用 `lib/graph-diff.js` 的 `diffGraphs`，输出 `keep`/`dropped` 两类任务清单。
3. **按文章 frontmatter 的 `source_files` 决定哪些文章保留、哪些跳过**：保守的 fallback 处理「符号级手段无效」的文章。

纯逻辑（`filterStaleTasks`）不碰文件系统，方便单测；IO 集中在文件末尾的 `loadSnapshot`/`saveSnapshot`（见 `lib/incremental.js:94-115`）。

关键降级策略（见 `lib/incremental.js:146-169`）：`bodyHash` 变了但 `codeHash` 没变的组件，视为「纯注释/排版改动」，放行不重写——只放行 `body` 类；`interface`/`added`/`deleted`/`renamed`/`edge` 一律视为实质变化、必须重写。`docstring` 变化单独检查，因为「文档注释改了应当重写」（它不是噪音）。

## Key Components

本模块全部为纯函数（除末尾两个 IO 函数），导出清单（见 `lib/incremental.js:1-207`）：

### 常量与路径约定

- `SNAPSHOT_VERSION = 1`（`lib/incremental.js:94`）——快照格式版本号；`loadSnapshot` 在版本不符时返回 `null`，宁可退化全量重写也不误判。
- `SNAPSHOT_REL = path.posix.join('temp', 'symbol-graph.json')`（`lib/incremental.js:22`）——快照相对 wiki 目录的路径，落在 `.codewiki/temp/` 下，与上游 `wiki_out/temp/` 同思路，随 wiki 一起入库以跨机器/会话复用旧图。
- `SLIM_FIELDS`（模块内常量，`lib/incremental.js:26`）——快照只保留的字段数组：`['id', 'name', 'kind', 'relativePath', 'parameters', 'baseClasses', 'dependsOn', 'bodyHash', 'codeHash']`。注意**不含 `sourceCode`**，也不含 `docstring`。

### 快照构建 / 解析

- `slimComponent(node)`（`lib/incremental.js:28-34`）——把单个图节点瘦身为快照组件；遍历 `SLIM_FIELDS`，缺失字段不写入；强制 `id`/`relativePath` 为字符串（防 `null`）。
- `slimGraph(graph, { commit, now })`（`lib/incremental.js:37-48`）——`Map<id, node>` → 可 JSON 化的快照对象 `{ version, generatedAt, commit, components }`。对现场节点（无缓存哈希）现场算一次 `bodyHash`/`codeHash` 固化进快照；`components` 按 `id` 排序。
- `graphFromSnapshot(snap)`（`lib/incremental.js:69-88`）——快照对象 → `Map<id, node>`（供 `graph-diff` 直接输入）。回读时补齐 `sourceCode: ''`、`docstring: ''` 等字段，确保下游哈希走「用固化值」分支而不读源码。
- `sameSnapshotContent(a, b)`（`lib/incremental.js:53-66`）——判断两份快照「实质内容」是否相同：**忽略 `generatedAt`/`commit` 这类每次都会变的元数据**，以及 `components` 顺序。用途：编译收尾写快照前先比一次——代码没变就不要覆盖，否则 `autoCommit` 会为「只改了一个时间戳」生成一个空转提交（见 `index.js:3708-3713` 调用点）。

### 路径与文件索引

- `snapshotPath(wikiPath)`（`lib/incremental.js:90-92`）——`wikiPath` 拼接 `SNAPSHOT_REL` 得到快照绝对路径。
- `normRel(p)`（`lib/incremental.js:118-120`）——目录相对路径归一：反斜杠 `\` → `/`，去掉行首 `./`，`trim`。因为快照里存的是 posix 相对路径，而文章 `source_files` 里可能是 `\` 或 `./` 开头（测试见 `test-incremental.mjs:169-176`）。
- `componentsByFile(graph)`（`lib/incremental.js:123-132`）——`Map<id, node>` → `Map<file, id[]>`：按 `normRel(node.relativePath)` 聚合组件 id（新图侧，新增文件也要算进去）。

### 磁盘 IO

- `loadSnapshot(wikiPath, fsImpl = fs)`（`lib/incremental.js:94-104`）——读 `snapshotPath(wikiPath)` 并 `JSON.parse`；版本不符（`snapshot.version !== SNAPSHOT_VERSION`）或 `components` 非数组时返回 `null`（见 `test-incremental.mjs:206-214` 坏 JSON / 坏版本都返回 `null`）；读文件/解析异常也返回 `null`（安静失败，不抛错，见 `test-incremental-e2e.mjs:139-141`）。
- `saveSnapshot(wikiPath, snap, fsImpl = fs, pathImpl = path)`（`lib/incremental.js:106-115`）——`mkdirSync` 自动建目录（`recursive: true`）后 `writeFileSync` 写入序列化快照；返回 `{ ok: true, path }` 或 `{ ok: false, reason }`，**失败不抛错**（写失败只是下次退化成文件级判定）。

### 核心判定

- `filterStaleTasks(tasks, oldGraph, newGraph, opts = {})`（`lib/incremental.js:140-194`）——**本模块的核心纯函数**。输入：
  - `tasks: [{ name, articlePath, sources: [file...] }]`
  - `oldGraph` / `newGraph: Map<id, node>`
  - `opts.ignoreCommentOnly`（默认 `true`：开启纯注释降级）

  处理逻辑：
  1. `diffGraphs(oldGraph, newGraph)` → `changedIds` → `graphDiffCounts` → `componentsByFile(newGraph)`。
  2. 纯注释降级（`lib/incremental.js:154-169`）：遍历 `diff.body` 里的组件，用 `codeHash`（现场节点按需算，快照节点用固化值）判断；`codeHash` 相等且 `docstring` 未变则该组件进 `cosmeticOnly` 集合。
  3. `realChanged = changed − cosmeticOnly`（`lib/incremental.js:170`）。
  4. 遍历 `tasks`：按 `sources` 命中 `byFile` 的组件 id；
     - 无命中符号（配置文件/模板/无语法支持扩展名）→ 保守 `keep` 并标 `symbolFallback: true`（`lib/incremental.js:179-184`）；
     - 命中 `realChanged` → `keep`，附 `changedComponents: hit.sort()`（供写作者当重点，`lib/incremental.js:185-186`）；
     - 只命中 `cosmeticOnly` → `dropped`，附 `cosmeticOnlyComponents`（便于面板/日志解释「为什么这篇没重写」，`lib/incremental.js:188-190`）。

  返回 `{ keep, dropped, change: diff, counts, cosmeticOnly: [...] }`（`lib/incremental.js:193`）。关键语义：没有任何符号可判的文章一律 `keep`（宁可多写一篇，不留下过期文章，见 `lib/incremental.js:139`）。

### 变更摘要

- `describeChange(counts)`（`lib/incremental.js:197-205`）——把 `graphDiffCounts` 的计数拼成中文摘要：接口变/新增/删除/改名/实现变/依赖变，全为 0 时返回 `'无实质变更'`。写入 job note（见 `index.js` 的 e2e 链路的 `describeChange(r.counts)` 调用），让人一眼看出「改了几处、为什么少写了 N 篇」。

> 注意：`lib/update-planner.js`（上游 `updater/ownership.py` 的纯函数重写）是**更高层**的计划器，它复用本模块的 `normRel` 以及 `graph-diff` 的 `codeHash`/`diffGraphs`/`changedIds`/`graphDiffCounts`，并实现同样一套纯注释降级（`realChangedIds`，`lib/update-planner.js:57-81`）。本模块的 `filterStaleTasks` 是更轻量的「直接按 source_files 命中」判定，而 `planUpdate` 额外处理反向依赖闭包、未归属变更、stale scan 等（见 `lib/update-planner.js:156-436`）。两者都被 `index.js` 的 stale 增量链调用。

## Architecture

本模块是 stale 增量的「判定层 + 快照存取层」，组件关系如下（≤20 行框图）：

```text
┌────────────────────────────────────────────────────────────┐
│ 符号图来源：lib/symbols.js extractCurrentGraph()             │
│   cwd 源码 → Map<id, node>（带 sourceCode / bodyHash）        │
└───────────────┬───────────────────────────────┬────────────┘
                │ 首次/每次编译                    │ 下次 stale 比对
                ▼                                 ▼
┌───────────────────────┐          ┌──────────────────────────┐
│ slimGraph()           │          │ loadSnapshot(wikiPath)   │
│ (incremental.js:37)   │          │ (incremental.js:94)      │
│ 现场算 bodyHash/      │          │ 读 .codewiki/temp/       │
│ codeHash 固化         │          │ symbol-graph.json → snap │
└──────────┬────────────┘          └────────────┬─────────────┘
           │ 序列化                                 │ graphFromSnapshot()
           ▼                                       ▼ (incremental.js:69)
┌───────────────────────┐          ┌──────────────────────────┐
│ saveSnapshot()        │          │ oldGraph (Map)           │
│ (incremental.js:106)  │          │ newGraph (Map, 现场)     │
└──────────┬────────────┘          └────────────┬─────────────┘
           │                                     │
           │                       ┌─────────────▼──────────────┐
           │                       │ diffGraphs() (graph-diff) │
           │                       │ added/deleted/interface/  │
           │                       │ body/edge/renamed        │
           │                       └─────────────┬──────────────┘
           │                                     │ changedIds/counts
           │                                     ▼
           │                       ┌──────────────────────────────┐
           │                       │ filterStaleTasks()           │
           │                       │ (incremental.js:140)         │
           │                       │ codeHash 降级 → keep/dropped │
           │                       └─────────────┬────────────────┘
           │                                     │ {keep, dropped,
           │                                     │  counts, cosmeticOnly}
           ▼                                     ▼
┌────────────────────────────────────────────────────────────┐
│ index.js stale 链路：planUpdate() 用 old/newGraph 做 write/   │
│ keep/delete/review；filterStaleTasks 直接收口；describeChange│
│ 写 job note；sameSnapshotContent 决定要不要回写快照           │
└────────────────────────────────────────────────────────────┘
```

组件 ≥3 且流程非平凡，已在上方用 UTF-8 框图展示。核心依赖 `lib/graph-diff.js`（纯标准库实现，`diffGraphs`/`changedIds`/`graphDiffCounts`/`bodyHash`/`codeHash`/`stripComments`），本模块只做「快照存取 + 降级 + 按 source_files 收口」，不动 `diffGraphs`（那个函数与上游逐位对齐，有 golden 对拍，见 `test-fixtures/graphdiff-golden.json`）。

## Data Flow

## Connections

## Known Issues
