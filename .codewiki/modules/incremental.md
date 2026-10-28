---
title: incremental
type: module
source_files:
  - lib/incremental.js
  - lib/graph-diff.js
  - test-incremental.mjs
  - test-incremental-e2e.mjs
tags: [incremental, stale, snapshot, symbol-graph, filter-stale-tasks]
---

## Overview

`lib/incremental.js` 负责「符号级增量」：判断一次代码改动到底要不要重写某篇文章。
`cw status` 只能给到**文件级**结论（哪些文件的 mtime/内容变了），但一次改动绝大多数情况是
「只改了注释/空行/局部实现」——模块的对外接口与职责没变，文章没必要重写。本模块把
「文件级变更」折算成「组件级变更」（复用 `lib/graph-diff.js`），再按文章 frontmatter 的
`source_files` 决定哪些文章保留、哪些跳过，从而避免把昂贵的 LLM 重写预算浪费在不必要的地方。

本模块承担三件事（见 `lib/incremental.js:8-13` 注释）：

1. **图快照的瘦身存取**：只存判定需要的字段，不存源码全文（`.codewiki/` 会进仓库，体积必须小）。
   见 `slimGraph`（`lib/incremental.js:37-48`）、`graphFromSnapshot`（`lib/incremental.js:69-88`）、
   `saveSnapshot`（`lib/incremental.js:106-115`）、`loadSnapshot`（`lib/incremental.js:94-104`）。
2. **把文件级变更折算成组件级变更**：`filterStaleTasks`（`lib/incremental.js:140-194`）是核心纯函数，
   它调用 `diffGraphs`（`lib/graph-diff.js:447-564`）拿到组件级 diff，再过滤掉「纯注释/排版改动」。
3. **按 `source_files` 决定文章保留/跳过**：`filterStaleTasks` 逐篇把 `source_files` 命中真实变化的
   文章放进 `keep` 列表，其余放进 `dropped` 列表。

纯逻辑（`filterStaleTasks`、`describeChange`、`sameSnapshotContent`、`normRel`、`componentsByFile`）
不碰任何文件系统，方便单测；IO 部分（`loadSnapshot`/`saveSnapshot`/`snapshotPath`）集中在文件末尾，
且都接受可选的 `fsImpl`/`pathImpl` 以便测试注入。

> 注意：在生产编排（`index.js`）里，真正的「逐篇更新计划」已经升级为 `lib/update-planner.js` 的
> `planUpdate`（`index.js:4163` 调用）。`filterStaleTasks` 仍是本模块的核心组件，但线上主链路
> 走的是 `planUpdate`（带反向依赖、stale scan、unmapped 兜底）。`filterStaleTasks`/`describeChange`
> 仍被 `test-incremental.mjs` / `test-incremental-e2e.mjs` 大量覆盖，并作为本模块语义的最小可验证单元保留。

## Key Components

### 常量

- **`SNAPSHOT_VERSION`**（`lib/incremental.js:19`）：快照格式版本号，当前为 `1`。`loadSnapshot`
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
   在 `cw index` 之后调用 `extractCurrentGraph`（`index.js:2220`）+ `slimGraph`（`lib/incremental.js:37`）
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
- [[symbols]]：`extractRepoGraph` / `extractCurrentGraph`（`index.js:2220`）产出 `newGraph` 的 `Map<id,node>`；
  `SUPPORTED_EXTS`（`lib/update-planner.js:20` 导入）用于 `isSourcePath` 判断源码文件。
- [[index]]（编排服务）：`codewiki_generate` 的 `runStaleUpdate`（`index.js:4122`）与 stale 分支
  （`index.js:4231-4296`）调用 `loadSnapshot`/`graphFromSnapshot`/`slimGraph`/`saveSnapshot`/
  `sameSnapshotContent`/`describeChange`；`tickIndex`（`index.js:3650-3695`）在收尾阶段写符号快照。
- [[change-set]]：`collectChangeSet`（`index.js:4133`）产出文件级变更，先经 `planUpdate` 再影响任务，
  与符号级判定互补。
- [[update-record]]：编译收尾 `saveRecord`（`index.js:2574`）把 `updatePlan` 复盘写进 `update-record.json`。

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
- **快照不存源码全文**：`.codewiki/` 要随仓库入库，故 `SLIM_FIELDS`（`lib/incremental.js:26`）刻意不存
  `sourceCode`，回读节点的 `sourceCode` 恒为 `''`；需要源码的判定（如 `diffGraphs` 里的 unified diff）
  在回读场景下会拿到空 `sourceCode`，只能靠固化哈希兜底。
