---
title: incremental
type: module
source_files:
  - lib/incremental.js
  - lib/graph-diff.js
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - lib/update-planner.js
  - index.js
tags: [incremental, snapshot, stale-tasks, symbol-graph, codewiki]
---

## Overview

`lib/incremental.js` 解决「一次改动到底要不要重写某篇文章」的符号级判定问题。背景见文件头注释（lib/incremental.js:1-13）：`cw status` 只能给到文件级变更（`mtime`/内容变了哪些文件），但绝大多数改动只是改了注释/空行/局部实现，模块的对外接口与职责没变——文章没必要重写。FSoft-AI4Code/CodeWiki 的 updater 用「组件级 hash + 签名比对」过滤掉 interface/added/deleted/renamed 之外的纯实现改动，本模块是那套逻辑在 Node 侧的落地。

本模块负责三件事（lib/incremental.js:8-11）：
1. **图快照的瘦身存取**：只存判定需要的字段，不存源码全文（`.codewiki/` 要随 wiki 一起入库）；快照落在 `.codewiki/temp/symbol-graph.json`。
2. **文件级变更 → 组件级变更**：复用 `lib/graph-diff.js` 的 `diffGraphs`。
3. **按文章 frontmatter 的 `source_files` 决定哪些文章保留、哪些跳过**：核心函数为 `filterStaleTasks`。

设计原则：纯逻辑（`filterStaleTasks` 等）不碰文件系统，方便单测；IO 部分集中在 `loadSnapshot` / `saveSnapshot` 末尾（lib/incremental.js:106）。

## Key Components

### 常量

- `SNAPSHOT_VERSION = 1`（lib/incremental.js:19）——快照 schema 版本，回读时版本不符当没有（退化全量）。
- `SNAPSHOT_REL = path.posix.join('temp', 'symbol-graph.json')`（lib/incremental.js:22）——相对 wiki 根的路径，即 `.codewiki/temp/symbol-graph.json`；放 `temp/` 与上游 `wiki_out/temp/` 同思路，且该目录随 wiki 一起入库，避免换机器/换会话后因为拿不到旧图而退化成全量重写（lib/incremental.js:20-21）。
- `SLIM_FIELDS`（lib/incremental.js:26）——快照只存这些字段：`['id', 'name', 'kind', 'relativePath', 'parameters', 'baseClasses', 'dependsOn', 'bodyHash', 'codeHash']`。`sourceCode` 一律不存（体积），`bodyHash`/`codeHash` 直接固化下来，让 `graph-diff` 走缓存分支，避免把源码读回来重算（lib/incremental.js:24-25）。

### 快照瘦身 / 构建

- `slimComponent(node)`（lib/incremental.js:28-34）——从节点抽出 `SLIM_FIELDS`（只取非 `undefined` 的字段），并把 `id`/`relativePath` 强转成 `String`（缺省空串）。
- `slimGraph(graph, { commit = null, now = new Date().toISOString() } = {})`（lib/incremental.js:37-48）——`graph` 是 `Map<id, node>`（node 需带 `bodyHash`）。映射成 `SLIM_FIELDS` 组件数组，现场节点没缓存哈希时当场算一次 `bodyHash(n)` / `codeHash(n)`（lib/incremental.js:42-44）固化进快照。按 `id` 字典序排序后返回 `{ version, generatedAt, commit, components }` 快照对象。
- `sameSnapshotContent(a, b)`（lib/incremental.js:53-66）——忽略 `generatedAt` / `commit` 这类每次都会变的元数据，比较两快照「实质内容」是否相同。用途：编译收尾写快照前先比一次——代码没变时不要覆盖，否则 `autoCommit` 会为「只改了一个时间戳」生成一个空转提交（lib/incremental.js:50-52）。比较时把组件归一化为 `SLIM_FIELDS`（仅取非 `undefined`）并按 `id` 排序后 `JSON.stringify` 直接比对（lib/incremental.js:55-65）。任一参数为 `null` 返回 `false`。

### 快照回读 / 落盘（IO）

- `graphFromSnapshot(snap)`（lib/incremental.js:69-88）——快照对象 → `Map<id, node>`，是 `graph-diff` 的直接输入。每个组件补全成标准 Node 形状：`id, name, kind, relativePath, parameters, baseClasses, dependsOn` 取快照值（数组缺省 `[]`、其余缺省 `null`），并补 `bodyHash`/`codeHash`/`sourceCode=''`/`docstring=''`（注意 `sourceCode` 为空串——回读节点没有源码，哈希靠固化的 `bodyHash`/`codeHash`）。
- `snapshotPath(wikiPath)`（lib/incremental.js:90-92）——`path.join(wikiPath, ...SNAPSHOT_REL.split('/'))`。
- `loadSnapshot(wikiPath, fsImpl = fs)`（lib/incremental.js:94-104）——读 `snapshotPath` 的 JSON；`version !== SNAPSHOT_VERSION` 或 `components` 非数组都返回 `null`（「版本不符当没有：宁可重写也不误判」，lib/incremental.js:98-99）；任何读取/解析异常 `catch` 返回 `null`（安静失败，退化全量）。
- `saveSnapshot(wikiPath, snap, fsImpl = fs, pathImpl = path)`（lib/incremental.js:106-115）——`mkdirSync(递归)` 父目录后 `writeFileSync` 整个快照 JSON；成功返回 `{ ok: true, path }`，失败返回 `{ ok: false, reason }`（不抛，调用方可继续）。

### 路径 / 文件 → 组件 工具

- `normRel(p)`（lib/incremental.js:118-120）——目录相对路径归一：把 `\` 替换成 `/`、去掉开头的 `./`、去首尾空白。解决「快照里存的是 posix 相对路径，文章 frontmatter 里可能是 `\` 或 `./` 开头」的错位（lib/incremental.js:117）。
- `componentsByFile(graph)`（lib/incremental.js:123-132）——返回 `Map<归一文件路径, 组件id[]>`（基于 `node.relativePath`）。注意用 **newGraph** 侧，因为新增文件也要算进去（lib/incremental.js:122）。

### 核心判定

- `filterStaleTasks(tasks, oldGraph, newGraph, opts = {})`（lib/incremental.js:140-194）——**纯函数**，不碰文件系统。
  - 入参：`tasks` 为 `[{ name, articlePath, sources: [file...] }]`；`oldGraph`/`newGraph` 为 `Map<id, node>`（回读节点 `sourceCode` 为空、靠固化 `bodyHash`/`codeHash`）。
  - 内部：先 `diffGraphs(oldGraph, newGraph, opts)`（lib/incremental.js:141，来自 `lib/graph-diff.js:447`），再 `changedIds(diff)` / `graphDiffCounts(diff)`，`componentsByFile(newGraph)`。
  - **纯注释/排版改动降级**（lib/incremental.js:146-169）：`bodyHash` 变了但 `codeHash` 没变的组件，视为「描述不变」。`opts.ignoreCommentOnly !== false`（默认开启）时遍历 `changed` 中落在 `diff.body` 集合的组件；现场节点用 `codeHash(o)`（有源码），回读节点用固化 `o.codeHash ?? null`（lib/incremental.js:162-163）；额外单独比 `docstring`（文档注释改了应当重写，不算噪音，lib/incremental.js:165-167）；`oh === nh && !docChanged` 才进 `cosmeticOnly` 集合。**只降级 body 类**：interface/added/deleted/renamed 一律不放行（lib/incremental.js:152-153）。`realChanged` = 去掉 `cosmeticOnly` 后的变更集（lib/incremental.js:170）。
  - 遍历 `tasks`（lib/incremental.js:172-192）：
    - 若某篇文章 `source_files` 在 `componentsByFile` 里解析不出任何组件 id（`!ids.size`）——配置文件/模板/无语法支持的扩展名——**保守保留**并标 `symbolFallback: true`（交回文件级判定，lib/incremental.js:179-184）。
    - 命中 `realChanged` 的组件 → 进 `keep`，带 `changedComponents`（排序后的命中组件 id，喂给写作者当重点，lib/incremental.js:185-186）。
    - 只命中纯注释改动（`cosmeticOnly`）→ 进 `dropped`，并带 `cosmeticOnlyComponents` 记录原因，便于面板/日志解释「为什么这篇没重写」（lib/incremental.js:188-190）。
  - 返回 `{ keep, dropped, change: diff, counts, cosmeticOnly: [...] }`（lib/incremental.js:193）。`keep[i].changedComponents` 是该文章覆盖到的、本次真的变了（非纯注释）的组件 id。
  - 没有任何符号可判的文章一律 `keep`（宁可多写一篇，不留下过期文章，lib/incremental.js:138-139）。

- `describeChange(counts)`（lib/incremental.js:197-206）——把 `counts`（来自 `graphDiffCounts`，含 `interface/added/deleted/renamed/body/edge`）拼成中文摘要，如「接口变 1、新增 1、实现变 1」；全 0 时返回「无实质变更」。写进 job note（lib/incremental.js:143）。

### 依赖（lib/graph-diff.js，被本模块复用）

本模块不重造 diff，全部委托 `lib/graph-diff.js`（移植自 FSoft updater，逐位对齐上游 golden）：
- `diffGraphs(oldGraph, newGraph, opts)`（lib/graph-diff.js:447-564）——返回 `{ added, deleted, interface, body, edge, renamed, records }` 的 GraphDiff。
- `changedIds(d)`（lib/graph-diff.js:436-440）、`graphDiffCounts(d)`（lib/graph-diff.js:425-434）。
- `bodyHash(node)`（lib/graph-diff.js:121-126）——整段源码（含 docstring）归一后的 sha1；回读节点走固化值。
- `codeHash(node)`（lib/graph-diff.js:108-111）——**剥掉注释与排版**后的源码 sha1；用于纯注释降级（区分「只改了注释」与「代码有实质变化」）。文档注释 `docstring` 不视作噪音——`codeHash` 只看源码本体，`docstring` 由 `filterStaleTasks` 单独比较（lib/graph-diff.js:102-107）。
- `stripComments(text)`（lib/graph-diff.js:69-100）——逐行剥注释/块注释，供 `codeHash` 使用。

## Architecture

```text
┌────────────────────┐   .codewiki/temp/symbol-graph.json
│ full-compile finish│  (index.js tickIndex ~3680)
│ extractCurrentGraph│
└─────────┬──────────┘
          │ slimGraph (lib/incremental.js:37)
          ▼
┌────────────────────┐   saveSnapshot (lib/incremental.js:106)
│  SNAPSHOT (slim)   │──────────► disk (sameSnapshotContent 去重, :53)
└────────────────────┘

┌────────────────────┐   loadSnapshot (lib/incremental.js:94)
│ stale update begin │──► graphFromSnapshot ──► oldGraph  (lib/incremental.js:69)
│ (index.js runStale │   extractCurrentGraph ──► newGraph
│  Update ~4160)     │
└─────────┬──────────┘
          ▼
┌─────────────────────────────────────────────────────────┐
│ filterStaleTasks(tasks, oldGraph, newGraph, opts)        │
│  diffGraphs (graph-diff:447) ─► changedIds/graphDiffCounts│
│  componentsByFile(newGraph) ─► 文章 sources → 组件        │
│  cosmetics downgrade: bodyHash变 && codeHash没变 &&       │
│     docstring没变 ─► cosmeticOnly（放行）                 │
└──────┬───────────────────────────────┬──────────────────┘
       ▼ keep (changedComponents)      ▼ dropped (cosmeticOnlyComponents)
                                       / symbolFallback:true
┌────────────────────┐   describeChange(counts) ─► job note
│ write / keep tasks │
└────────────────────┘
```

## Data Flow

1. **落盘（全量编译收尾）**——`index.js` 的 `tickIndex`（约 lib/incremental.js 被调用的 index.js:3618-3627）：编译成功、`writtenCount>0`、且 `symbolIncremental` 开关开启时，`extractCurrentGraph(job.cwd)` 取当前图 → `slimGraph(cur.graph, { commit: currentCommit(...) })` 生成瘦快照 → 先 `loadSnapshot` 比对 `sameSnapshotContent`，内容没变就跳过写入（避免空转提交），否则 `saveSnapshot` 落到 `.codewiki/temp/symbol-graph.json`。写失败只记 note，下次 stale 退回文件级。
2. **比对（逐篇更新）**——`index.js` 的 `runStaleUpdate`（`index.js:4148-4157` 与 `index.js:2236-2239`）：当 `symbolIncremental` 且 `loadSnapshot` 返回非 null 且当前符号提取可用（`cur.ready`）时，`graphFromSnapshot(snap)` → `oldGraph`，`extractCurrentGraph` → `newGraph`，交给 `planUpdate`（lib/update-planner.js:156）做更完整的规划（反向依赖、stale scan、无归属变更兜底）。在旧 wiki（无 module-map、无 plan）退化分支里则直接调 `filterStaleTasks`（index.js:21 等历史分支）。
3. **纯函数判定**——`filterStaleTasks` 内部：文件级变更经 `diffGraphs` 折算成组件级变更集 → `componentsByFile` 把文章 `source_files` 映射到组件 → 纯注释降级过滤 → 产出 `keep`/`dropped`/`counts`/`cosmeticOnly`，供上层决定哪些任务真正提交、`describeChange` 产出摘要。

## Connections

- [[graph-diff]]：`lib/incremental.js` 的 diff 全部委托 `lib/graph-diff.js`（`diffGraphs`/`changedIds`/`graphDiffCounts`/`bodyHash`/`codeHash`/`stripComments`）。
- [[update-planner]]：更上层的增量规划器。它 `import { normRel } from './incremental.js'`（lib/update-planner.js:57），并**重写了**一套与 `filterStaleTasks` 同判据的 `realChangedIds`（`lib/update-planner.js:57-81`，复用 `codeHash` 做纯注释降级）来补足 `filterStaleTasks` 看不到的反向依赖/无归属变更。`filterStaleTasks` 是上游「只回答要不要重写」的朴素版，其缺陷在 lib/update-planner.js:4-14 有审计说明。
- [[symbols]]：`extractCurrentGraph` / `extractRepoGraph`（来自 lib/symbols.js）产出 `Map<id, node>`，是本模块 `oldGraph`/`newGraph` 的来源；`node` 形状契约见 lib/symbols.js:827-828 与 lib/graph-diff.js:9-10。
- `index.js`：编排层。`symbolIncremental` 开关（见 index.js 配置）控制是否走符号级增量；落盘在 `tickIndex`（index.js:3618-3627），比对在 `runStaleUpdate`（index.js:4148-4157、4263-4266）。导入见 index.js:19-22。
- [[change-set]]：提供 `collectChangeSet`，与 `planUpdate` 配合做四路变更（committed/staged/unstaged/untracked+deleted+renamed）的归属，补偿 `cw status` 只查 `git diff <baseline>..HEAD` 的漏检（index.js:4136-4147）。

## Known Issues

- **老快照无 `codeHash` 时退回原行为**：`filterStaleTasks` 在 `oh`/`nh` 任一为 `null`（拿不到固化哈希、也没有源码可现场算）时跳过该组件的降级（lib/incremental.js:140），于是纯注释改动会被当成 body 变更、文章照旧重写。这是保守的「宁重写不漏判」（test-incremental.mjs:109-118 覆盖）。
- **`codeHash` 的字符串近似**：`stripComments`（lib/graph-diff.js:69-100）是按语言松散匹配注释标记的逐行近似，字符串里的 `//` 会被误判为注释。注释里带 URL/正则的代码可能被一并剥掉，导致 `codeHash` 小概率碰撞（lib/graph-diff.js:64-68 已说明这是可接受的近似，避免引入语言参数把纯逻辑路径复杂化）。
- **`filterStaleTasks` 不处理反向依赖 / 无归属变更**：`util/strings.js` 签名变、`billing` 文章不重写，或新文件无 `source_files` 归属被静默丢弃——这些缺陷已在 lib/update-planner.js 升级为 `write/keep/delete/review` 四类动作。直接用 `filterStaleTasks` 的老链路只适合朴素「文章自身源变了才写」场景。
- **`loadSnapshot` 静默失败**：版本不符 / 坏 JSON / 目录不存在一律返回 `null`（lib/incremental.js:98-103），上层必须显式处理「无快照 → 文件级判定」分支，否则会退化成全量（test-incremental-e2e.mjs:139-141）。
- **`symbolFallback` 保守保留**：`source_files` 全是不可解析符号的配置文件/模板时，文章一律 `keep`（lib/incremental.js:179-184），可能带来「明明没改却重写」的少量冗余，但换来「绝不留下过期文章」。


  对版本不符的快照直接返回 `null`（宁可全量重写也不误判，见 `lib/incremental.js:98`）。
- **`SNAPSHOT_REL`**（`lib/incremental.js:22`）：快照相对 wiki 根的路径 `temp/symbol-graph.json`。
  放在 `.codewiki/temp/` 下，随 wiki 一起入库，避免换机器/换会话后因为拿不到旧图而退化成全量重写。
- **`SLIM_FIELDS`**（`lib/incremental.js:26`）：快照只保留的字段清单
  `['id', 'name', 'kind', 'relativePath', 'parameters', 'baseClasses', 'dependsOn', 'bodyHash', 'codeHash']`。
  **不存 `sourceCode`**（体积大），`bodyHash`/`codeHash` 直接固化进快照，让 `graph-diff` 走缓存分支、
  回读时不必再把源码读回来重算哈希。

### 函数

- **`slimComponent(node)`**（`lib/incremental.js:28-34`）：把一个图节点瘦身为快照组件。只拷
  `SLIM_FIELDS` 里存在的字段，并把 `id`/`relativePath` 强制转成字符串（缺省 `''`）。
- **`slimGraph(graph, { commit, now })`**（`lib/incremental.js:37-48`）：`Map<id,node>` → 可 JSON 化的
  快照对象 `{ version, generatedAt, commit, components }`。`components` 先按 `SLIM_FIELDS` 瘦身、
  现场节点若没缓存哈希则当场算一次（`lib/incremental.js:42-44`），最后按 `id` 排序保证稳定。
- **`sameSnapshotContent(a, b)`**（`lib/incremental.js:53-66`）：比较两份快照的「实质内容」是否相同，
  **忽略** `generatedAt` / `commit` 这类每次都会变的元数据（还有数组顺序）。用于编译收尾写快照前先
  比一次——代码没变时不覆盖，否则 `autoCommit` 会为「只改了一个时间戳」生成一个空转提交、把用户
  历史搞脏。返回 `false` 的情况包括任一为 `null`。
- **`graphFromSnapshot(snap)`**（`lib/incremental.js:69-88`）：快照对象 → `Map<id, node>`，即
  `diffGraphs` 的直接输入。回读节点补上 `sourceCode: ''` 与 `docstring: ''`，并把 `parameters` /
  `baseClasses` / `dependsOn` 缺省归一成空数组。
- **`snapshotPath(wikiPath)`**（`lib/incremental.js:90-92`）：`wikiPath` + `SNAPSHOT_REL` 展开，返回
  快照完整路径。
- **`loadSnapshot(wikiPath, fsImpl = fs)`**（`lib/incremental.js:94-104`）：读快照。版本不符
  （`version !== SNAPSHOT_VERSION`）或 `components` 不是数组时返回 `null`；读不到/坏 JSON 也返回
  `null`（见 `lib/incremental.js:101-103`）。`test-incremental-e2e.mjs:139-141` 验证了无 `.codewiki`
  目录时安静返回 `null`。
- **`saveSnapshot(wikiPath, snap, fsImpl = fs, pathImpl = path)`**（`lib/incremental.js:106-115`）：
  自动 `mkdirSync` 父目录后写 `JSON.stringify(snap)`。返回 `{ ok: true, path }` 或
  `{ ok: false, reason }`（不抛错，见 `lib/incremental.js:112-114`）。
- **`normRel(p)`**（`lib/incremental.js:118-120`）：目录相对路径归一——把 `\` 换成 `/`、去掉开头的
  `./`、首尾去空白。用于把文章 frontmatter 里的 `\` 或 `./` 开头路径统一成与快照里 posix 路径一致。
- **`componentsByFile(graph)`**（`lib/incremental.js:123-132`）：`Map<id,node>` → `Map<相对文件, id[]>`，
  把每个组件按 `normRel(relativePath)` 归到所在文件。`relativePath` 为空的组件被跳过。
- **`filterStaleTasks(tasks, oldGraph, newGraph, opts = {})`**（`lib/incremental.js:140-194`）：**核心判定
  （纯函数）**。输入 `tasks`（`[{ name, articlePath, sources: [file...] }]`）与新旧两份
  `Map<id,node>`，返回 `{ keep, dropped, change, counts, cosmeticOnly }`：
  - `keep[i].changedComponents`：该文章覆盖到的、本次**真的变化了**的组件 id 清单（喂给写作者当重点）。
  - `dropped[i]`：被跳过的文章；若是纯注释改动命中，则带 `cosmeticOnlyComponents`。
  - `change`：来自 `diffGraphs` 的原始 `GraphDiff`；`counts`：来自 `graphDiffCounts`。
  - `cosmeticOnly`：被判定为「纯注释/排版改动」的组件 id 数组。
  - **纯注释降级**（`lib/incremental.js:154-170`）：`bodyHash` 变了但 `codeHash` 没变、且 `docstring`
    也没变的组件，视为「描述不变」从真实变更里剔除。用 `opts.ignoreCommentOnly !== false` 控制（默认开）。
    `interface`（签名变）/ `added` / `deleted` / `renamed` / `edge` 一律不放行。docstring 变化单独比较
    （`lib/incremental.js:166`），因为它是有意义的文档改动、应当重写。
  - **无符号可判**（`lib/incremental.js:179-184`）：某篇文章 `source_files` 里没有任何可解析的符号
    （配置文件、模板、无语法支持的扩展名），保守保留并标 `symbolFallback: true`，交回文件级判定。
  - **多源文件**（`lib/incremental.js:174-192`）：任一源文件命中真实变更即 `keep`，且 `changedComponents`
    带出全部命中组件（见 `test-incremental.mjs:178-184`）。
- **`describeChange(counts)`**（`lib/incremental.js:197-206`）：把 `graphDiffCounts` 的结果拼成中文摘要，
  如「接口变 1、新增 2、实现变 3」，全部为 0 时返回「无实质变更」。写进 job note 让人一眼看出
  「改了几处、为什么少写了 N 篇」。

### 关键数据结构（快照对象与回读节点）

- 快照对象：`{ version, generatedAt, commit, components: [{ id, name, kind, relativePath, parameters, baseClasses, dependsOn, bodyHash, codeHash }] }`
  ——由 `slimGraph`（`lib/incremental.js:37`）产出，字段集合由 `SLIM_FIELDS`（`lib/incremental.js:26`）定义。
- 回读节点（`graphFromSnapshot` 的 `Map` value）：在 slim 字段基础上补 `sourceCode: ''`、`docstring: ''`。
  因为不存全文，`bodyHash`/`codeHash` 已随快照固化，回读时 `graph-diff` 的 `bodyHash`/`codeHash`
  会直接走「有固化哈希就跳过重算」的缓存分支（见 `lib/graph-diff.js:108-110`、`121-125`）。

## Architecture

本模块是把「文件级改动」翻译成「组件级改动」、再落到「文章级保留/跳过」的一层纯函数 + 一层 IO。
组件 ≥3 且流程非平凡，框图如下：

```text
           旧快照(.codewiki/temp/symbol-graph.json)       当前代码
                          │                                  │
                          │ loadSnapshot (94)                 │ extractCurrentGraph (index.js:2220)
                          ▼                                  ▼
                  graphFromSnapshot (69)                extractRepoGraph → Map<id,node>
                          │  oldGraph                          │  newGraph
                          └──────────────┬─────────────────────┘
                                         ▼
                              diffGraphs (graph-diff.js:447)
                                 返回 GraphDiff {added,deleted,interface,body,edge,renamed}
                                         │
                                         ▼
                          filterStaleTasks (140)  ── 纯函数，不碰 FS ──
                              ├─ 纯注释降级：bodyHash变&&codeHash不变&&docstring不变 ⇒ cosmeticOnly
                              ├─ componentsByFile (123) 按 source_files 命中
                              └─ per task: 任一真实变更 ⇒ keep(changedComponents) / 否则 dropped
                                         │
                          ┌──────────────┴───────────────┐
                          ▼                               ▼
                keep[]（要重写，带 changedComponents）   dropped[]（跳过/纯注释）
                          │                               │
                          ▼                               ▼
                stale 任务提交 (index.js:4203)        describeChange (197) 记 note

   ── IO 侧（编译收尾写基线前）──
   slimGraph (37) → saveSnapshot (106) → .codewiki/temp/symbol-graph.json
   （写前先 sameSnapshotContent (53) 比对，内容没变就跳过，避免空转提交）
```

关键设计点：

- **`diffGraphs` 与上游逐位对齐**（`lib/graph-diff.js:447-453`），带 golden 对拍；本模块**只**在判定层
  （`lib/incremental.js:154-170`）加纯注释降级，**不**动 `diffGraphs` 本身。
- **`codeHash` vs `bodyHash`**：`bodyHash` 覆盖整段源码文本（含注释），`codeHash` 用 `stripComments`
  剥掉注释与排版只留代码本体（`lib/graph-diff.js:69-111`）。降级靠这两者拉开粒度差。
- **`docstring` 单独比较**（`lib/incremental.js:166`）：文档注释改动是有意义的，不算噪音。

## Data Flow

1. **编译收尾写入快照**（`index.js:3597-3618`，在 `tickIndex` 里）：本次全量/增量编译若写成文章，
   在 `cw index` 之后调用 `extractCurrentGraph`（`index.js:2236`）+ `slimGraph`（`lib/incremental.js:37`）
   生成新快照；写盘前先 `loadSnapshot` 取得旧快照并用 `sameSnapshotContent`（`lib/incremental.js:53`）
   比对——内容没变就**跳过写入**（避免 `autoCommit` 空转提交）。写入路径
   `.codewiki/temp/symbol-graph.json`（`SNAPSHOT_REL`，`lib/incremental.js:22`）。
2. **下一次 stale 触发读取快照**（`index.js:4149-4160` / `4252-4258`）：`codewiki_generate` 走
   `runStaleUpdate` 时，若 `symbolIncremental` 开启且有旧快照，则 `loadSnapshot`（`lib/incremental.js:94`）
   + `graphFromSnapshot`（`lib/incremental.js:69`）得到 `oldGraph`；`extractCurrentGraph` 得到 `newGraph`。
3. **组件级 diff 折算**（`lib/incremental.js:140-194`）：`filterStaleTasks` 用 `diffGraphs`
   （`lib/graph-diff.js:569`）算出 `changed`/`counts`，再做纯注释降级得到 `realChanged`，逐篇按
   `source_files`（经 `normRel` 归一，见 `lib/incremental.js:118-120` 与 `componentsByFile`）命中，
   产出 `keep`/`dropped`。
4. **任务提交**（`index.js:1903-1935`）：`keep` 侧的 `changedComponents` 转成 stale 写作任务
   `mission` 文案后 `svc.submit({ kind: 'stale', ... })`。被 `dropped` 的文章不重写。
5. **变更摘要落盘**：`describeChange(counts)`（`lib/incremental.js:197`）的结果写进 job note，
   供面板/复盘查看「改了几处、为什么少写了 N 篇」。

测试侧端到端链路见 `test-incremental-e2e.mjs`：真实目录 `write` 源码 → `slimGraph`+
`saveSnapshot` → `loadSnapshot`+`graphFromSnapshot` 还原 → 改代码 → `filterStaleTasks` 判定
`keep`/`dropped`（如 `test-incremental-e2e.mjs:61-95` 的「只改实现/只改注释」场景）。

## Connections

- [[graph-diff]]：`diffGraphs`（`lib/graph-diff.js:447`）、`changedIds`、`graphDiffCounts`、`bodyHash`、
  `codeHash`、`stripComments` 都是本模块的直接依赖。`filterStaleTasks` 的纯注释降级完全建立在
  `codeHash`/`bodyHash` 的粒度差之上（本模块 `lib/incremental.js:154-170` ↔ `lib/graph-diff.js:108-125`）。
- [[update-planner]]：生产主链路已经从 `filterStaleTasks` 升级到 `planUpdate`（`lib/update-planner.js:156`）。
  `planUpdate` 复用了本模块的 `normRel`（`lib/incremental.js:118`，在 `lib/update-planner.js:21` 导入），
  并另行实现了更完整的反向依赖闭包（`dependentsOf`，`lib/update-planner.js:85`）、stale scan
  （`scanStaleArticle`，`lib/update-planner.js:106`）、unmapped/needsFull 兜底。其背景正是
  `lib/update-planner.js:4-14` 指出的 `filterStaleTasks` 的三个缺陷（反向依赖看不见、新文件无归属、
  未重写页不做 stale scan）。
- [[symbols]]：`extractRepoGraph` / `extractCurrentGraph`（`index.js:2236`）产出 `newGraph` 的 `Map<id,node>`；
  `SUPPORTED_EXTS`（`lib/update-planner.js:20` 导入）用于 `isSourcePath` 判断源码文件。
- [[index]]（编排服务）：`codewiki_generate` 的 `runStaleUpdate`（`index.js:4148`）与 stale 分支
  （`index.js:4231-4296`）调用 `loadSnapshot`/`graphFromSnapshot`/`slimGraph`/`saveSnapshot`/
  `sameSnapshotContent`/`describeChange`；`tickIndex`（`index.js:3618-3663`）在收尾阶段写符号快照。
- [[change-set]]：`collectChangeSet`（`index.js:4133`）产出文件级变更，先经 `planUpdate` 再影响任务，
  与符号级判定互补。
- [[update-record]]：编译收尾 `saveRecord`（`index.js:2590`）把 `updatePlan` 复盘写进 `update-record.json`。

## Known Issues

- **`filterStaleTasks` 已非生产主链路**：线上 stale 走 `lib/update-planner.js` 的 `planUpdate`
  （`index.js:21`、`4260`），`filterStaleTasks` 仅保留为最小可验证单元（被单测覆盖）。本模块的
  `filterStaleTasks` 不处理反向依赖（引用的模块变了、使用方文章不重写）、新文件无归属、未重写页
  stale scan——这些缺陷已在 `update-planner` 修复（见 `lib/update-planner.js:4-14`）。
- **纯注释降级的近似**：`codeHash` 用 `stripComments`（`lib/graph-diff.js:69-100`）逐行剥注释，字符串里的
  `//` 会被误判为注释（源码注释在字符串里的情况极少，作者认为可接受，见 `lib/graph-diff.js:64-68`）。
  因此极少数情况会误把含 `//` 的代码行一并剥掉，导致 `codeHash` 偏小概率碰撞。
- **老快照无 `codeHash` 时退回旧行为**：若回读节点没有 `codeHash`（早期格式快照），降级分支算不出
  `oh`/`nh` 会直接 `continue`（`lib/incremental.js:164`），于是纯注释改动**不会被降级**而照常重写——
  这是保守行为，见 `test-incremental.mjs:109-118`。
- **`loadSnapshot` 对坏 JSON / 版本不符静默返回 `null`**：这不是「disabled」，而是降级为全量判定的
  设计（`lib/incremental.js:98-103`）；调用方 `index.js:4152-4154`、`4253-4257` 据此走文件级判定。

