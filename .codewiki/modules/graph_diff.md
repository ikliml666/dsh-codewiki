---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - lib/symbols.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - lib/incremental.js
  - lib/update-planner.js
tags: [graph-diff, diff, similarity, unified-diff, incremental, fsoft, codewiki]
---

## Overview

`graph_diff`（源码 `lib/graph-diff.js`）是一个**纯标准库、零 ML 依赖**的符号级增量 diff 引擎，移植自 FSoft-AI4Code/CodeWiki 的 `codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现）。移植而非调用的原因写在文件头（`lib/graph-diff.js:1-10`）：上游最值钱的判定逻辑——哪些组件真的变了、变的是签名还是实现、哪个删除对应哪个新增（即改名）——全部是 `hashlib` / `difflib` / `re` 的纯算法，逐位移植后本插件保持纯 Node、零外部运行时，判定精度与上游一致。

它的输入与输出都是一张「符号图」：`Map<id, node>`，其中 `node` 的形状是 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（见 `lib/graph-diff.js:9-10` 头注释，与 `lib/symbols.js:827-828` 的提取契约一致）。组件 id 约定为 `<相对路径>#<符号名>`（上游用 `::`，换成 `#` 是为了不与 Windows 盘符里的 `:` 混淆）。

该模块对外提供三大能力，对应文章标题的三部分：

1. **Graph diffing（组件级变更分类）**：`diffGraphs(oldGraph, newGraph, opts)`（`lib/graph-diff.js:447-564`）逐组件比较，把每个变化归到五类：`added` / `deleted` / `interface`（签名变）/ `body`（实现变）/ `edge`（仅依赖变），并把「一个删除 + 一个高度相似新增」配对为 `renamed`。输出 `GraphDiff` 结构（带 `records` 明细）。
2. **Similarity（相似度）**：`bodySimilarity(a, b)`（`lib/graph-diff.js:239-245`）用移植自 Python `difflib.SequenceMatcher` 的 `sequenceRatio`（`lib/graph-diff.js:229-236`）算 token 序列的 `ratio`，落在 `[0,1]`，用于改名配对阈值判定。
3. **Unified diff generation（统一 diff 生成）**：`unifiedDiff(...)`（`lib/graph-diff.js:327-355`）/`unifiedBodyDiff(...)`（`lib/graph-diff.js:358-362`）逐位复刻 `difflib.unified_diff`，产出生格式与 GNU unified diff 完全一致的文本，供文章里展示「这个函数改成什么样了」。

整份实现有对拍基准护体：`test-fixtures/gen-graphdiff-golden.py`（`test-fixtures/gen-graphdiff-golden.py:31-148`）用 Python 原生 `difflib` + `hashlib` 喂同一批输入产出 `test-fixtures/graphdiff-golden.json`，`test-graphdiff.mjs`（`test-graphdiff.mjs:2-107`）逐用例比对，确保与上游逐位一致。

## Key Components

`lib/graph-diff.js` 全部为导出常量与函数（无 class，无独立 model 结构；`GraphDiff` 与 `ChangeRecord` 是 `diffGraphs` 返回的普通对象，见下文）。下面按「常量 → 单点工具 → difflib 移植 → 改名配对 → 主入口 → 序列化」分组列出，行号以源码「行号| 」前缀为准。

### 导出常量

- `CLASS_ADDED = 'added'` — `lib/graph-diff.js:14`，变更类标签。
- `CLASS_DELETED = 'deleted'` — `lib/graph-diff.js:15`，变更类标签。
- `CLASS_IFACE = 'interface'` — `lib/graph-diff.js:16`，变更类标签（签名变）。
- `CLASS_BODY = 'body'` — `lib/graph-diff.js:17`，变更类标签（实现变）。
- `CLASS_EDGE = 'edge'` — `lib/graph-diff.js:18`，变更类标签（仅依赖变）。
- `CLASS_RENAMED = 'renamed'` — `lib/graph-diff.js:19`，变更类标签（删除+相似新增配对）。
- `DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'` — `lib/graph-diff.js:251`，超长 diff 被截断时插入的分隔符（`truncateToTokens` 用）。
- `DEFAULT_TAU_REN = 0.8` — `lib/graph-diff.js:371`，改名配对的相似度阈值，给 `pairRenames` / `diffGraphs` 作默认。
- `DEFAULT_MAX_DIFF_TOKENS = 2000` — `lib/graph-diff.js:447`，单个组件 unified diff 的 token 上限，给 `diffGraphs` 作默认。

### 注释/空白处理工具（单点函数）

- `normalizeBody(text)` — `lib/graph-diff.js:28-30`。`trim` 后把连续空白归一为单个空格，用于 body 长度比较与 `bodyHash` 输入归一。
- `stripComments(text)` — `lib/graph-diff.js:69-100`（内部 `stripTrailingComment` 在 `lib/graph-diff.js:43-62`）。剥掉注释与纯装饰空白，只留代码本体（区分「只改了注释」vs「代码有实质变化」）。块注释用 `BLOCK_COMMENT_PAIRS`（`lib/graph-diff.js:36`，含 `/* */` / `<!-- -->` / `""" """` / `''' '''`），行首注释用 `LINE_COMMENT_MARKS`（`lib/graph-diff.js:35`，`//` `#` `--` `;` `%`），行内注释用 `TRAILING_COMMENT_MARKS`（`lib/graph-diff.js:39`，仅 `//` `#`）。字符串内的 `//` 会被误判为注释，这是可接受的近似（见 `lib/graph-diff.js:64-68` 注释）。
- `codeHash(node)` — `lib/graph-diff.js:108-111`。「代码本体」SHA1 哈希：先 `stripComments`，再 `crypto.createHash('sha1')`。只改注释 → `codeHash` 不变。**注意**：若节点没有 `sourceCode` 但有固化 `codeHash`（快照回读场景），直接返回固化值（`lib/graph-diff.js:109`）。调用方用它与 `bodyHash` 做降级判定（见 [[incremental]]）。
- `documentedSource(node)` — `lib/graph-diff.js:114-119`。源码 + 文档注释拼接：Rust 的 `///` 在 `sourceCode` 之外，不带上就看不出「只改了文档」。若 `docstring` 不为空且未包含于源码，则 `doc\ncode`，否则仅 `code`。
- `bodyHash(node)` — `lib/graph-diff.js:121-126`。组件源码＋文档注释的 SHA1 哈希：`normalizeBody(documentedSource(node))` 后算。快照回读节点无源码但带固化 `bodyHash` 时直接返回（`lib/graph-diff.js:28`），实时节点行为不变。与 `codeHash` 的区别：`bodyHash` 含 `docstring`（文档改动算实质变化），`codeHash` 剥注释（纯注释改动不算）。
- `signature(node)` — `lib/graph-diff.js:128-134`。从 node 抽取 `{ name, parameters, baseClasses }` 三元组，供签名比较。
- `signatureChanged(a, b)` — `lib/graph-diff.js:136-145`。逐字段比较 `signature(a)` 与 `signature(b)`：`name` / `parameters` 长度与逐项 / `baseClasses` 长度与逐项，任一不同即返回 `true`。

### difflib 移植（`bodySimilarity` 底层）

- `tokens(text)` — `lib/graph-diff.js:147-149`。用 Unicode 属性类 `TOKEN`（`/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu`，`lib/graph-diff.js:26`）切 token。注意：JS 的 `\w` 不是 Unicode 感知的，直接用会让中文按字切碎、相似度整体偏高，故用 `TOKEN` 还原 Python `\w` 语义（`lib/graph-diff.js:24-26`）。
- `buildB2J(b)` — `lib/graph-diff.js:156-164`，`findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)` — `lib/graph-diff.js:166-189`，`getMatchingBlocks(a, b)` — `lib/graph-diff.js:191-226`。这三者是 `difflib.SequenceMatcher` 的 `get_matching_blocks` 逐位移植（`autojunk=False`，无 junk 元素），含相邻块归并逻辑（`lib/graph-diff.js:207-225`）。
- `sequenceRatio(aArr, bArr)` — `lib/graph-diff.js:229-236`。对应 `difflib.SequenceMatcher.ratio()`：`(2 * 匹配总数) / (len(a) + len(b))`，两序列皆空返回 `1.0`。
- `bodySimilarity(a, b)` — `lib/graph-diff.js:239-245`。上游 `body_similarity`：先 `tokens` 化，任一侧为空返回 `0.0`（两侧皆空返回 `1.0`），否则 `sequenceRatio`。落在 `[0,1]`。

### diff 文本工具

- `approxTokens(text)` — `lib/graph-diff.js:247-249`。按 `floor(len/4) + 1` 估算 token 数（粗略，用于截断判断）。
- `truncateToTokens(text, maxTokens)` — `lib/graph-diff.js:251-257`。若 `approxTokens(text) > maxTokens`（且 `maxTokens > 0`）则截成「前半 + `DIFF_TRUNCATED_MARKER` + 后半」各取 `budget/2` 字符。
- `splitKeepEnds(text)` — `lib/graph-diff.js:263-269`。对应 Python `splitlines(keepends=True)`：用 `/[^\n]*\n|[^\n]+$/g` 保留行尾换行（末尾无换行也保留最后一行）。
- `getOpcodes(a, b)` — `lib/graph-diff.js:271-287`，`getGroupedOpcodes(a, b, n)` — `lib/graph-diff.js:289-317`。对应 `difflib` 的 `get_opcodes` / `get_grouped_opcodes`，产出带 `n` 行上下文的 diff 分组。
- `rangeUnified(start, stop)` — `lib/graph-diff.js:319-325`。把 `[start, stop)` 区间转成 unified diff 的 `a,b` 计数格式（长度 1 时省略长度；空区间用 `beginning-1,0`）。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n = 3, lineterm = '\n')` — `lib/graph-diff.js:327-355`。对应 `difflib.unified_diff`：输出 `--- / +++ / @@` 头与带 `+` `-` ` ` 前缀的行，与 GNU unified diff 格式完全一致。
- `unifiedBodyDiff(oldNode, newNode, label)` — `lib/graph-diff.js:358-362`。上游 `unified_body_diff`：取 `documentedSource` 后 `splitKeepEnds`，调用 `unifiedDiff` 且 `fromFile=a/${label}`、`toFile=b/${label}`、上下文固定 `n=2`。任一节点为 `null` 时对应侧行列表为空（纯新增/纯删除）。

### 改名配对

- `pairRenames(deleted, added, oldGraph, newGraph, tauRen = DEFAULT_TAU_REN)` — `lib/graph-diff.js:371-407`。按 body 相似度贪心最佳匹配：先按 `kind` 给 `added` 分组（`lib/graph-diff.js:373-378`），对每个被删节点找同类新增节点，先用长度比 `ratio` 预筛（长度差太大直接跳过，`lib/graph-diff.js:388-391`），再算 `bodySimilarity`，`sim >= tauRen` 入候选；候选按 `sim` 降序，贪心去重取首个未用组合，返回 `[oldId, newId, sim]` 三元组列表。两侧 `Set` 任一为空直接返回 `[]`（`lib/graph-diff.js:392`）。

### 主入口与聚合

- `emptyGraphDiff()` — `lib/graph-diff.js:413-423`。构造空 `GraphDiff`：`{ added, deleted, interface, body, edge }` 为 `Set`，`renamed` 为 `Map`（oldId→newId），`records` 为 `Map`。
- `graphDiffCounts(d)` — `lib/graph-diff.js:425-434`。把 `GraphDiff` 六个分类的 `size` 收成普通对象，便于日志/序列。
- `changedIds(d)` — `lib/graph-diff.js:436-440`。并集六个分类的所有 id（含 renamed 的 value 侧）成 `Set`。
- `isDiffEmpty(d)` — `lib/graph-diff.js:442-444`。`changedIds(d).size === 0` 即空。
- `diffGraphs(oldGraph, newGraph, opts = {})` — `lib/graph-diff.js:447-564`。**主入口**。流程见下方 Architecture。`opts.tauRen` 默认 `DEFAULT_TAU_REN`、`opts.maxDiffTokens` 默认 `DEFAULT_MAX_DIFF_TOKENS`（`lib/graph-diff.js:448-449`）。返回 `GraphDiff`。其中每个 `ChangeRecord`（存于 `records`，`lib/graph-diff.js:449-463` 等）字段完整列举：

  | 字段 | 含义 |
  |---|---|
  | `componentId` | 组件 id（`newId`，改名时是新 id） |
  | `changeClass` | 六类之一：`added` / `deleted` / `interface` / `body` / `edge` / `renamed` |
  | `oldId` / `newId` | 旧/新 id；新增时 `oldId=null`，删除时 `newId=null` |
  | `relativePath` | `node.relativePath` |
  | `componentType` | `node.kind` |
  | `oldSignature` / `newSignature` | `signature(o)` / `signature(n)`；无来源时为 `null` |
  | `similarity` | 改名时的相似度（`Math.round(sim*10000)/10000`，`lib/graph-diff.js:515`）；其余为 `null` |
  | `signatureChanged` | `signatureChanged(o, n)` 结果 |
  | `edgesAdded` / `edgesRemoved` | `dependsOn` 相对旧的增删（排序数组） |
  | `diff` | 仅当 body 变化时由 `truncateToTokens(unifiedBodyDiff(...), maxDiffTokens)` 生成（`lib/graph-diff.js:495`、`lib/graph-diff.js:521`、`lib/graph-diff.js:541`、`lib/graph-diff.js:559`） |

- `serializeDiff(d)` — `lib/graph-diff.js:567-578`。序列化用：`Set`/`Map` 转数组/对象便于落盘与对拍。`counts` 来自 `graphDiffCounts`；`added/deleted/interface/body/edge` 排序数组；`renamed` 为 `{oldId: newId}` 排序对象；`records` 为 `{cid: record}` 排序对象。

### 非导出内部辅助（仅供本模块调用，概览）

- `stripTrailingComment(line)` — `lib/graph-diff.js:43-62`，`tokens`/`buildB2J`/`findLongestMatch`/`getMatchingBlocks` 见上，另 `getOpcodes` / `getGroupedOpcodes` / `rangeUnified` 见上。这些函数名未加 `export`，外部不可直接调用。

## Architecture

`diffGraphs` 是组件级入口；它内部按「集合差分 → 逐组件分类 → 改名配对 → 补齐 added/deleted 记录」四段执行。相似度与 unified diff 都复用下方移植自 `difflib` 的纯算法层。框图（组件名｜文件:行）：

```text
              oldGraph / newGraph  (Map<id, node>)
                          │
                          ▼
   ┌──────────────────────────────────────────────┐
   │ diffGraphs              lib/graph-diff.js:447 │
   │  1. 集合差分: added/deleted  (Set)            │
   │  2. 逐组件分类 interface/body/edge            │
   │     ├─ signatureChanged  :136                 │
   │     ├─ bodyHash 对比    :121                  │
   │     └─ dependsOn 对比 (edge)                  │
   │  3. pairRenames → renamed  Map  :371          │
   │  4. 补 added/deleted 记录                   │
   └──────────────────────────────────────────────┘
      │                    │                    │
      ▼                    ▼                    ▼
 ┌──────────┐      ┌──────────────┐     ┌──────────────┐
 │ Change   │      │ pairRenames  │     │ unifiedBody  │
 │ Record   │◄─────│ (similarity) │     │ Diff :358    │
 │ (records)│      └──────────────┘     └──────┬───────┘
 └──────────┘                                  │
      │                                        ▼
      ▼                              ┌────────────────────┐
 serializeDiff :567 ──► JSON        │ unifiedDiff :327   │
                                           ▲
                                           │ 复用
                              ┌────────────────────────┐
                              │ difflib 移植层          │
                              │  getMatchingBlocks :191 │
                              │  sequenceRatio   :229   │
                              │  bodySimilarity  :239   │
                              │  tokens/TOKEN   :147/26 │
                              └────────────────────────┘
```

分类优先级（同名组件，三判据都变时取最先命中者，`lib/graph-diff.js:466-477`）：`signatureChanged` 为真 → `interface`；否则 `bodyHash` 不同 → `body`；否则依赖变 → `edge`；三者皆否 → 不登记（未变）。改名路径独立：先清空被配对的 `deleted`/`added`（`lib/graph-diff.js:500-502`），写 `renamed` 映射与 `renamed` 类记录；若该 rename 同时 `signatureChanged` 为真，还会把新 id 额外加进 `interface`（`lib/graph-diff.js:136`）。

`GraphDiff` 结构（由 `emptyGraphDiff` 构造，`lib/graph-diff.js:413-423`）是模块的「中枢数据」：`added/deleted/interface/body/edge` 五个 `Set` 存 id，`renamed` 是 `Map`，`records` 是 `Map<cid, ChangeRecord>`。下游（[[incremental]]、[[update-planner]]）只读这个结构，不直接调内部算法。

## Data Flow

典型调用链（以增量编译为例，`lib/incremental.js` 是其最主要消费者）：

1. **构图**：`lib/symbols.js` 提取源码得 `Map<id, node>`，节点形状 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（与 `lib/graph-diff.js:9-10` 契约一致）。
2. **快照存/取**：`lib/incremental.js` 的 `slimGraph`（`lib/incremental.js:37-48`）把实时图瘦身成只含 `SLIM_FIELDS`（`lib/incremental.js:26`，含固化 `bodyHash`/`codeHash`）的快照落盘 `.codewiki/temp/symbol-graph.json`；下次编译用 `graphFromSnapshot`（`lib/incremental.js:69-88`）回读成 `Map`，回读节点 `sourceCode=''`、带固化哈希，于是 `bodyHash`/`codeHash` 走缓存分支（`lib/graph-diff.js:109`、`lib/graph-diff.js:124`）不直接重算源码。
3. **比对**：`filterStaleTasks`（`lib/incremental.js:140-194`）调 `diffGraphs(oldGraph, newGraph, opts)` 得 `GraphDiff`，再用 `changedIds`（`lib/graph-diff.js:436-440`）+ `graphDiffCounts`（`lib/graph-diff.js:425-434`）算 `changed` 与 `counts`。随后在**判定层**做纯注释降级：对 `diff.body` 中 `codeHash` 相同且 `docstring` 未变的组件视为「描述不变」、`bodyHash` 变化被忽略（`lib/incremental.js:154-170`）。
4. **改名配对**：`diffGraphs` 内部用 `pairRenames`（`lib/graph-diff.js:371-407`）把 `deleted`×`added`（同 `kind`，`bodySimilarity >= tauRen=0.8`）配成 `renamed`，`tauRen` 经 `opts` 透传（`lib/graph-diff.js:448`）。
5. **输出**：`serializeDiff`（`lib/graph-diff.js:567-578`）把 `GraphDiff` 转成可 JSON 化的 `{ counts, added[], deleted[], interface[], body[], edge[], renamed{}, records{} }`，供 `lib/update-planner.js` / `lib/update-record.js` 做增量计划与落盘记录。

对拍链路（质量保证，不参与运行时）：`test-fixtures/gen-graphdiff-golden.py`（`test-fixtures/gen-graphdiff-golden.py:31-123`）用 Python 原生 `difflib`/`hashlib` 产出 `test-fixtures/graphdiff-golden.json`；`test-graphdiff.mjs`（`test-graphdiff.mjs:2-16`）逐用例比对 `bodySimilarity` / `bodyHash` / `unifiedDiff`，误差阈值 `<1e-12`，确保与上游逐位一致。

## Connections

- [[symbols]] — `lib/symbols.js` 是 `graph_diff` 的上游生产者：它提取的节点形状（`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`，`lib/symbols.js:13-14`）正是 `diffGraphs` 输入的契约；组件 id `<相对路径>#<符号名>` 约定（`lib/symbols.js:10-11`）与 `lib/graph-diff.js:447-449` 一致。
- [[incremental]] — `lib/incremental.js` 是最主要消费者：导入 `diffGraphs, changedIds, graphDiffCounts, bodyHash, codeHash`（`lib/incremental.js:140`），在 `filterStaleTasks`（`lib/incremental.js:140-194`）里调 `diffGraphs` 并叠加纯注释降级。它还负责图的瘦身快照存取（`slimGraph`/`graphFromSnapshot`），使回读节点走 `bodyHash`/`codeHash` 缓存分支。
- [[update-planner]] — `lib/update-planner.js` 也导入 `diffGraphs, changedIds, graphDiffCounts, codeHash`（`lib/update-planner.js:19`），把组件级 diff 升级成逐篇 `write/keep/delete/review` 四类 action。
- [[update-record]] — `lib/update-record.js` 消费 `serializeDiff` 产出的 `GraphDiff` 快照，把「改了几处、哪些变更无归属」落盘成更新记录。
- [[change-set]] — `lib/change-set.js` 负责采集「四路改动」（committed/staged/unstaged/untracked），其产出与 `graph_diff` 的图级 diff 在增量管线中互补：前者回答「哪些文件在变」，后者回答「哪些符号在变」。

## Known Issues

- **字符串内的 `//` 被误判为注释**：`stripComments`（`lib/graph-diff.js:69-100`）的块/行内剥离不跟踪引号状态，形如 `"http://x"` 的 URL 会被当成注释剥掉。这是有意为之的近似（`lib/graph-diff.js:64-68`）：误判只会让 `codeHash` 变小概率碰撞，而引入真词法分析要带语言参数、把纯逻辑复杂化，不划算。改动注释/文档的语义不受影响（`documentedSource` 单独处理 docstring）。
- **`codeHash` 粒度不区分注释**：上游 Python 的 `normalize_body` 只做空白归一，本移植一致（`lib/graph-diff.js:108-110` + `lib/graph-diff.js:28-30`）。因此纯注释改动也会让 `bodyHash` 变化、触发文章重写——这个问题不在 `graph_diff` 内修，而由 [[incremental]] 的 `filterStaleTasks` 在判定层加 `codeHash` 降级（`lib/incremental.js:154-170`）兜住。「与上游逐位对齐、有 golden 对拍」是硬约束，所以 `diffGraphs` 本身不动。
- **`approxTokens` 是粗略估算**：`truncateToTokens`（`lib/graph-diff.js:251-257`）用 `floor(len/4)+1`（`lib/graph-diff.js:247-249`）判是否超 `maxDiffTokens`，长度 + 多字节字符会让实际 token 数与预算有偏差，但只在截断边界附近，不影响 diff 内容正确性。
- **`pairRenames` 先按 `kind` 严格分组**：删除与新增必须同 `kind`（`lib/graph-diff.js:373-378`）才进入候选；跨语言/跨类型的「改名 + 换签名」不会被配对，会退化为独立的 `deleted` + `added`，它们是真改动了对外描述的，必须重写，符合预期。
- **回读快照节点无源码**：`graphFromSnapshot`（`lib/incremental.js:69-88`）返回的节点 `sourceCode=''`，故 `codeHash`/`bodyHash` 只能用固化值（`lib/incremental.js:82-83`）或返回 `null`；若快照缺 `codeHash`/`bodyHash`（`lib/graph-diff.js:121`、`lib/graph-diff.js:108` 的 `?? null` 分支），降级判定会 `continue` 跳过该组件（`lib/incremental.js:164`），此时不会误判为「描述不变」。
- **无显式禁用/注释掉的功能**：本模块所有导出函数均处于启用状态，无 `@disabled` / 注释禁用 / 死代码分支。
