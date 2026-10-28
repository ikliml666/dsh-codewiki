---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/incremental.js
  - lib/update-planner.js
  - lib/change-set.js
  - lib/symbols.js
  - lib/update-record.js
tags: [incremental-update, graph-diff, similarity, rename-detection, fsoft-port]
---

## Overview

`lib/graph-diff.js` 是**符号级增量 diff** 引擎：给定两份「文档/代码图」（Map<id, node>），
算出哪些组件真的变了、变的是签名还是实现、哪个删除对应哪个新增（改名），并给出可机读的
判定结果与可供落盘/对拍的序列化。它是增量编译「要不要重写某篇文章」的判定底座。

本模块是**逐位移植**自上游 FSoft-AI4Code/CodeWiki 的
`codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现），理由见文件头
`lib/graph-diff.js:1-10`：上游最值钱的判定（哪些组件真变、变签名还是实现、删除↔新增=改名）
全部是纯标准库算法（hashlib/difflib/re），零 ML 依赖；逐位移植后本插件保持纯 Node、零外部
运行时，判定精度与上游一致。

组件 id 约定与上游相同：`<相对路径>#<符号名>`（上游是 `path::name`，用 `#` 是为了不与
Windows 盘符里的 `:` 混淆）。Node 记录形状（`lib/graph-diff.js:9-10`、
`lib/symbols.js:13-14`）：

```
{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }
```

本模块对外只暴露纯函数，不碰文件系统，因此可被 `lib/incremental.js`、`lib/update-planner.js`
直接复用并离线单测。所有「组件级」判定与上游逐位对齐，由 `test-graphdiff.mjs` 对拍验证
（`test-graphdiff.mjs:1-2`、`28-42`）。

## Key Components

### 常量（导出）

| 名称 | 行号 | 值/含义 |
|---|---|---|
| `CLASS_ADDED` | `lib/graph-diff.js:14` | `'added'`，新增组件类 |
| `CLASS_DELETED` | `lib/graph-diff.js:15` | `'deleted'`，删除组件类 |
| `CLASS_IFACE` | `lib/graph-diff.js:16` | `'interface'`，签名（对外接口）变化 |
| `CLASS_BODY` | `lib/graph-diff.js:17` | `'body'`，实现（代码本体）变化 |
| `CLASS_EDGE` | `lib/graph-diff.js:18` | `'edge'`，仅依赖边变化 |
| `CLASS_RENAMED` | `lib/graph-diff.js:19` | `'renamed'`，删除+新增被配成改名 |
| `DIFF_TRUNCATED_MARKER` | `lib/graph-diff.js:21` | `'... [diff truncated] ...'`，超长 diff 截断标记 |
| `DEFAULT_TAU_REN` | `lib/graph-diff.js:368` | `0.8`，改名配对的 body 相似度阈值 |
| `DEFAULT_MAX_DIFF_TOKENS` | `lib/graph-diff.js:369` | `2000`，单条 body diff 的最大 token 数（超出截断） |

### 注释/空白剥离与哈希

| 函数 | 行号 | 用途 |
|---|---|---|
| `normalizeBody(text)` | `lib/graph-diff.js:28-30` | 去首尾空白、折叠内部空白为单空格；`null`/`undefined` 按空串处理。 |
| `stripTrailingComment(line)` | `lib/graph-diff.js:43-62` | 剥掉一行里**引号外**的行注释（`//` 与 `#`）。跟踪 `' " \`` 三种引号与反斜杠转义（`"http://x"` 不会被误判）；`#` 仅当行首或前一字符为空白才算注释，避免吃到 C 预处理/JS 私有字段。 |
| `stripComments(text)` | `lib/graph-diff.js:69-100` | 逐行扫描、跟踪块注释状态，去掉块注释、行首注释与行尾注释，只留代码本体。用途：区分「只改了注释/排版」与「代码有实质变化」。注释前缀表 `LINE_COMMENT_MARKS`（`lib/graph-diff.js:35`）、块注释表 `BLOCK_COMMENT_PAIRS`（`lib/graph-diff.js:36`）、行内剥离标记 `TRAILING_COMMENT_MARKS`（`lib/graph-diff.js:39`）。 |
| `codeHash(node)` | `lib/graph-diff.js:108-111` | 代码本体哈希：**不含**注释与排版。只改注释→`codeHash` 不变。无源码但有固化 `codeHash` 时直接返回（`lib/graph-diff.js:69`）；否则对 `stripComments(sourceCode)` 取 sha1。 |
| `documentedSource(node)` | `lib/graph-diff.js:114-119` | 源码＋文档注释拼接；Rust 的 `///` 在 `sourceCode` 之外，不带上就看不出「只改了文档」。docstring 为空或已包含在代码内则不重复拼接。 |
| `bodyHash(node)` | `lib/graph-diff.js:121-126` | 整段代码（含 docstring）的归一化 sha1。快照回读节点无 `sourceCode` 时用固化的 `bodyHash`（`lib/graph-diff.js:124`），保证与上游 `normalize_body` 一致。 |
| `signature(node)` | `lib/graph-diff.js:128-134` | 取 `{ name, parameters, baseClasses }`（数组均展开成新数组）。 |
| `signatureChanged(a, b)` | `lib/graph-diff.js:136-145` | 逐一比对 name / parameters / baseClasses；任一不同返回 `true`。用于判定 `interface` 类变更。 |

### difflib 移植（token 级相似度）

| 函数 | 行号 | 用途 |
|---|---|---|
| `tokens(text)` | `lib/graph-diff.js:147-149` | 用 Unicode 感知的 `TOKEN` 正则（`lib/graph-diff.js:26`，还原 Python `\w` 的中文语义）把文本切成 token 数组。 |
| `buildB2J(b)` | `lib/graph-diff.js:156-164` | `difflib.SequenceMatcher` 的 b2j 索引（`token -> 出现位置列表`）。 |
| `findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)` | `lib/graph-diff.js:166-189` | 在指定区间内找最长匹配块，与上游算法逐位一致。 |
| `getMatchingBlocks(a, b)` | `lib/graph-diff.js:191-226` | 递归划分 + 合并相邻块，完全复刻 Python `get_matching_blocks`。 |
| `sequenceRatio(aArr, bArr)` | `lib/graph-diff.js:229-236` | `difflib.SequenceMatcher.ratio()`：`(2*matches)/(|a|+|b|)`，落在 [0,1]。两序列皆空返回 `1.0`。 |
| `bodySimilarity(a, b)` | `lib/graph-diff.js:239-245` | 上游 `body_similarity`：token 序列的 difflib ratio。双侧为空返回 `1.0`，单侧为空返回 `0.0`。改名配对与 golden 对拍都用它。 |
| `approxTokens(text)` | `lib/graph-diff.js:247-249` | 用 `长度/4 + 1` 估算 token 数，给截断预算用。 |
| `truncateToTokens(text, maxTokens)` | `lib/graph-diff.js:251-257` | 超过预算时保留头尾各一半并插入 `DIFF_TRUNCATED_MARKER`（`lib/graph-diff.js:256`）。 |
| `splitKeepEnds(text)` | `lib/graph-diff.js:263-269` | 复刻 Python `splitlines(keepends=True)`：末尾无换行的最后一行也保留。 |
| `getOpcodes(a, b)` | `lib/graph-diff.js:271-287` | 由匹配块推出 opcode（`equal/replace/delete/insert`）。 |
| `getGroupedOpcodes(a, b, n)` | `lib/graph-diff.js:289-317` | 按 n 行上下文归并 opcode，复刻 Python `get_grouped_opcodes`。 |
| `rangeUnified(start, stop)` | `lib/graph-diff.js:319-325` | 生成 unified diff 的行列号范围字符串。 |
| `unifiedDiff(aLines, bLines, fromFile, toFile, n=3, lineterm='\n')` | `lib/graph-diff.js:327-355` | 逐位移植 `difflib.unified_diff`：header 仅在首个 group 输出一次、每个 group 都有 `@@` 头。 |
| `unifiedBodyDiff(oldNode, newNode, label)` | `lib/graph-diff.js:358-362` | 上游 `unified_body_diff`：对 `documentedSource` 取行、以整文件相对路径作 label、上下文固定 2 行。 |

### 改名配对

| 函数 | 行号 | 用途 |
|---|---|---|
| `pairRenames(deleted, added, oldGraph, newGraph, tauRen=DEFAULT_TAU_REN)` | `lib/graph-diff.js:371-407` | 按 body 相似度贪心最佳匹配。仅同 kind 配对；先按长度比快速剪枝（够不到 `tauRen` 的直接跳过，`lib/graph-diff.js:391`），再用 `bodySimilarity` 算相似度，`sim >= tauRen` 才入候选；候选按相似度降序，贪心去重取最优配对，返回 `[[oldId, newId, sim], ...]`。 |

### 主入口与结果结构

`diffGraphs` 返回的对象结构由 `emptyGraphDiff()`（`lib/graph-diff.js:413-423`）定义，所有字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `added` | `Set<string>` | 仅出现在新图的组件 id |
| `deleted` | `Set<string>` | 仅出现在旧图的组件 id |
| `interface` | `Set<string>` | 签名变化的组件 id（含因改名导致签名变的 newId） |
| `body` | `Set<string>` | 仅实现（代码本体）变化的组件 id |
| `edge` | `Set<string>` | 仅依赖边变化的组件 id |
| `renamed` | `Map<oldId, newId>` | 删除↔新增被配成改名的映射 |
| `records` | `Map<cid, record>` | 每个变更组件的明细记录 |

每个 `record` 的字段（`lib/graph-diff.js:480-494` 定义 body 类；`506-520` renamed；`528-542` added；`546-560` deleted）：

| record 字段 | 含义 |
|---|---|
| `componentId` | 变更组件 id |
| `changeClass` | `'added'/'deleted'/'interface'/'body'/'edge'/'renamed'` |
| `oldId` / `newId` | 旧/新 id（新增的 `oldId=null`，删除的 `newId=null`） |
| `relativePath` | 文件相对路径 |
| `componentType` | 组件 kind |
| `oldSignature` / `newSignature` | 旧/新 `signature(node)` 结果 |
| `similarity` | renamed 时为四舍五入保留 4 位小数的相似度，其余为 `null` |
| `signatureChanged` | 布尔，签名是否变化 |
| `edgesAdded` / `edgesRemoved` | 依赖边增删（排序后的数组） |
| `diff` | body 变化时的截断 unified diff（`truncateToTokens(..., maxDiffTokens)`）；无变化时为空串 |

| 函数 | 行号 | 用途 |
|---|---|---|
| `emptyGraphDiff()` | `lib/graph-diff.js:413-423` | 返回空的判定结果结构（见上表）。 |
| `graphDiffCounts(d)` | `lib/graph-diff.js:425-434` | 把六个计数的 `size` 汇总成普通对象 `{ added, deleted, interface, body, edge, renamed }`。 |
| `changedIds(d)` | `lib/graph-diff.js:436-440` | 返回所有变更 id 的 `Set`（含 renamed 的 newId）。 |
| `isDiffEmpty(d)` | `lib/graph-diff.js:442-444` | `changedIds(d).size === 0` 时为真。 |
| `diffGraphs(oldGraph, newGraph, opts={})` | `lib/graph-diff.js:447-564` | 主入口。详见下方「判定逻辑」。 |
| `serializeDiff(d)` | `lib/graph-diff.js:567-578` | 序列化用：把 `Set/Map` 转成排序数组/对象，并附带 `counts`，便于落盘与对拍。 |

### `diffGraphs` 判定逻辑（`lib/graph-diff.js:447-564`）

1. `opts.tauRen` 默认 `DEFAULT_TAU_REN`、`opts.maxDiffTokens` 默认 `DEFAULT_MAX_DIFF_TOKENS`（`lib/graph-diff.js:448-449`）。
2. 先按 id 集合差分出 `added` / `deleted`（`lib/graph-diff.js:454-455`）。
3. 对共有 id：算 `signatureChanged` / `bodyHash` 是否变化 / `dependsOn` 是否变化；三者皆无则跳过（`lib/graph-diff.js:457-466`）。否则分类：`signatureChanged`→`interface`，否则`hashChanged`→`body`，否则→`edge`（`lib/graph-diff.js:467-477`），并写 `records`。`hashChanged` 时填充截断 unified diff（`lib/graph-diff.js:495`）。
4. 改名配对：`pairRenames` 的结果里把 oldId 从 `deleted`、newId 从 `added` 中移除，写入 `renamed`（oldId→newId），并写 renamed record；若签名也变了，把 newId 同时加入 `interface`（`lib/graph-diff.js:499-524`）。
5. 兜底写 `added` / `deleted` 的 record（`lib/graph-diff.js:526-561`）。

## Architecture

本模块是纯函数管线，组件 ≥3 且流程非平凡，框图如下：

```text
            oldGraph / newGraph  (Map<id, node>)
            │  node = { id,name,kind,relativePath,sourceCode,
            │          docstring,parameters,baseClasses,dependsOn }
            ▼
┌─────────────────────────── diffGraphs (lib/graph-diff.js:447) ───────────────────────────┐
│                                                                                          │
│  ┌─ id 集合差分 ──────────────┐   ┌─ 共有 id 分类 ───────────────────┐                    │
│  │ added / deleted  (454-455) │   │ signatureChanged?→interface      │                    │
│  └────────────┬───────────────┘   │ else hashChanged?→body           │                    │
│               │                   │ else edgesChanged?→edge (467-477)│                    │
│               │                   └───────────────┬──────────────────┘                    │
│               │                                    │                                       │
│               └──────────────►  pairRenames (371) ◄┘                                       │
│                      deleted×added 按 bodySimilarity 贪心配对 (tauRen=0.8)                 │
│                                    │                                                       │
│                                    ▼                                                       │
│  ┌─ 哈希底座 ────────────────────────────────────────────────────────────┐               │
│  │ codeHash / bodyHash (108/121) → stripComments(69)/documentedSource(114)│               │
│  │ bodySimilarity(239) → sequenceRatio(229) → difflib 移植 (156-236)      │               │
│  │ unifiedBodyDiff(358) → unifiedDiff(327) → truncateToTokens(251)        │               │
│  └───────────────────────────────────────────────────────────────────────┘               │
│                                    │                                                       │
│                                    ▼                                                       │
│  emptyGraphDiff() 结构 (413): { added,deleted,interface,body,edge,renamed:Map,             │
│                                 records:Map<cid,record> }                                  │
└─────────────────────────────────────┬────────────────────────────────────────────────────┘
                                      │ serializeDiff (567) → JSON 对拍 (test-graphdiff.mjs)
                                      ▼
                          调用方：incremental.filterStaleTasks / update-planner.planUpdate
```

关键设计点：

- **哈希三件套**：`codeHash`（剥注释，用于纯注释降级）、`bodyHash`（含 docstring，用于实现变化判定）、`documentedSource`（源码＋文档注释，喂给 unified diff）。三者分工见 `lib/graph-diff.js:102-119` 注释。
- **difflib 逐位移植**：`buildB2J`→`findLongestMatch`→`getMatchingBlocks`→`sequenceRatio` + `getOpcodes`→`getGroupedOpcodes`→`unifiedDiff`，与 Python `difflib` 完全一致，因此能用 `test-fixtures/gen-graphdiff-golden.py` 生成的 golden 逐用例对拍（见 `test-graphdiff.mjs:28-42`）。
- **改名配对独立成步**：先按 id 差分得 deleted/added，再在二者间按 body 相似度贪心配对，配对成功的从 deleted/added 移除并写入 `renamed`，保证「改名」不被视为「删除+新增」。

## Data Flow

以一次增量编译为例，数据从符号提取流到判定再流到计划器：

1. **图来源**：`lib/symbols.js` 用 web-tree-sitter 提取出 `Map<id, node>`（`lib/symbols.js:13-14` 规定的形状与本模块契约一致）。旧图来自上一次编译落盘的快照（`lib/incremental.js:22` 的 `SNAPSHOT_REL`，由 `slimGraph` 生成，`lib/incremental.js:37-48`），新图来自本次实时提取。
2. **快照瘦身**：`slimGraph` 只存判定所需字段，不存 `sourceCode`，但把 `bodyHash`/`codeHash` 固化进快照（`lib/incremental.js:26-48`），让回读节点走 `bodyHash`/`codeHash` 的缓存分支（`lib/graph-diff.js:109`、`124`）。
3. **组件级 diff**：调用方把旧/新图交给 `diffGraphs`（`lib/incremental.js:141`、`lib/update-planner.js:186`），得到 `GraphDiff` 结构与 `records`。
4. **纯注释降级**（判定层，不在本模块内）：`filterStaleTasks`（`lib/incremental.js:140-156`）与 `realChangedIds`（`lib/update-planner.js:57-81`）复用 `codeHash` 把「只改了注释/排版」的 body 变更降级为 `cosmetic`，不动 `diffGraphs`（因为它与上游逐位对齐、有 golden 对拍）。interface/added/deleted/renamed/edge 一律不放行。
5. **计划生成**：`planUpdate`（`lib/update-planner.js:156`）消费 diff，结合 `moduleMap` 与 `dependentsOf`（`lib/update-planner.js:85`）算反向依赖闭包，给每篇文章产出 `write/keep/delete/review` 四类 action。
6. **序列化与对拍**：`serializeDiff`（`lib/graph-diff.js:567`）把结果转 JSON；`test-graphdiff.mjs` 用 `test-fixtures/graphdiff-golden.json`（由 `gen-graphdiff-golden.py` 用 Python `difflib`/`hashlib` 生成，`test-fixtures/gen-graphdiff-golden.py:1-8`）逐用例验证 `bodySimilarity`/`bodyHash`/`unifiedDiff` 与上游一致（误差 `<1e-12`，`test-graphdiff.mjs:2`）。

## Connections

- [[incremental]] — `lib/incremental.js` 是主要调用方：`filterStaleTasks`（`lib/incremental.js:140-194`）直接调用 `diffGraphs`/`changedIds`/`graphDiffCounts`/`bodyHash`/`codeHash`，并用 `codeHash` 做纯注释降级；`SNAPSHOT_REL` 的瘦身快照（`lib/incremental.js:22-48`）是 `diffGraphs` 的旧图来源。
- [[update-planner]] — `lib/update-planner.js` 的 `planUpdate`（`lib/update-planner.js:156`）与 `realChangedIds`（`lib/update-planner.js:57`）消费 `diffGraphs` 结果，结合 `moduleMap`/`dependentsOf` 生成文章级增量计划；两者共用同一套 `codeHash` 降级判据。
- [[symbols]] — `lib/symbols.js` 是图的**生产者**，其 Node 记录形状（`lib/symbols.js:13-14`）与本模块的契约完全一致，是 `diffGraphs` 输入的前提。
- [[change-set]] — `lib/change-set.js` 采集文件级变更，与 `update-planner` 配合在 `fileLevel` 时退化成文件级判定（不再调用 `diffGraphs`，`lib/update-planner.js:179-192`）。
- [[update-record]] — `lib/update-record.js` 记录每次编译的终态，其中「完整性」部分依赖本模块产出的变更计数（`graphDiffCounts`）判定是否可推进基线。
- [[lib]] — 本模块在 `lib/` 代码库中的归属与同目录其它核心库的整体关系，见 `modules/lib.md`。

## Known Issues

- **注释剥离是近似，非真词法分析**：`stripComments`（`lib/graph-diff.js:69-100`）不做真正的多语言词法解析，字符串里的 `//` 会被误判为注释（见 `lib/graph-diff.js:64-68` 注释说明）。这是有意为之的取舍——误判只会让「看起来像注释」的代码被一并剥掉，导致 `codeHash` 更小概率碰撞；若引入真词法分析需带语言参数，会把这条纯逻辑路径复杂化。
- **`bodyHash` 不区分注释**：`bodyHash`（`lib/graph-diff.js:121-126`）覆盖整段源码文本，只做空白归一（与上游 `normalize_body` 一致），因此「只改了注释」也会让它变。真正过滤掉纯注释改动的是**判定层**（`lib/incremental.js:148-164` / `lib/update-planner.js:57-81`）用 `codeHash` 做的降级，而非 `diffGraphs` 本身——这是刻意分层：保持 `diffGraphs` 与上游逐位对齐以便 golden 对拍。
- **改名配对对同 kind 强约束**：`pairRenames`（`lib/graph-diff.js:371-407`）只在相同 `kind` 的 deleted×added 之间配对；跨 kind 的删除+新增不会被识别为改名。
- **长度剪枝阈值**：`lib/graph-diff.js:391` 用 `ratio < tauRen * 0.9` 提前剪枝跳过长度差太大的候选，是性能优化而非语义裁剪——最终仍以 `sim >= tauRen`（`lib/graph-diff.js:393`）为准。
- **无功能禁用/注释掉的代码**：通读 `lib/graph-diff.js` 全文件，没有发现被注释掉或被禁用的函数；所有导出函数（14 起常量与本文件函数）均处于启用状态。
