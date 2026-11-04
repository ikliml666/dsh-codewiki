---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - lib/incremental.js
  - lib/update-planner.js
  - lib/symbols.js
  - lib/change-set.js
  - lib/update-record.js
tags: [incremental, diff, graph, rename-detection, symbols]
---

## Overview

`lib/graph-diff.js` 实现了一套**符号级（组件级）增量 diff** 算法，移植自
FSoft-AI4Code/CodeWiki 的 `codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现）。
它是整个 CodeWiki 增量编译的判定核心：给定「旧代码图」与「新代码图」两个
`Map<componentId, node>`，产出哪些组件真正变了、变的是签名（interface）还是实现（body）、
依赖边是否变了（edge）、删了又新增的是不是改名（renamed）。

为什么移植而不是调用上游：上游最有价值的部分（哪些组件变了、变的是签名还是实现、
哪个删除对应哪个新增=改名）全部是纯标准库算法（`hashlib`/`difflib`/`re`），零 ML 依赖。
逐位移植后插件保持纯 Node、零外部运行时，判定精度与上游一致（见 `test-graphdiff.mjs` 的 golden 对拍）。

**组件 id 约定**（与上游同构）：`<相对路径>#<符号名>`（上游用 `::`，这里用 `#` 是为避免
Windows 盘符里的 `:` 混淆；方法为 `#<类名>.<方法名>`）。该约定由 `lib/symbols.js` 产出、
经 `lib/incremental.js` 的快照存读、最终由本模块消费，三方一致。

**Node 记录形状**（贯穿 symbols → incremental 快照 → graph-diff，见 `lib/graph-diff.js:10`）：
`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`。

本模块导出三类能力：
1. 文本级工具：`normalizeBody` / `stripComments` / `codeHash` / `documentedSource` / `bodyHash`
   / `signature` / `signatureChanged`，把「注释噪音」「签名」「实现正文」分离成可比较的量。
2. difflib 移植：`sequenceRatio` / `bodySimilarity` / `unifiedDiff` / `unifiedBodyDiff` /
   `truncateToTokens`，提供与 Python `difflib` 逐位对齐的相似度与 unified diff。
3. 组件级主入口：`emptyGraphDiff` / `graphDiffCounts` / `changedIds` / `isDiffEmpty` /
   `pairRenames` / `diffGraphs` / `serializeDiff`，输出结构化变更集（diff 结果）。

## Key Components

### 常量（导出）

- `CLASS_ADDED = 'added'`（`lib/graph-diff.js:14`）— 变更类：新增组件。
- `CLASS_DELETED = 'deleted'`（`lib/graph-diff.js:15`）— 变更类：删除组件。
- `CLASS_IFACE = 'interface'`（`lib/graph-diff.js:16`）— 变更类：签名（接口）变化。
- `CLASS_BODY = 'body'`（`lib/graph-diff.js:17`）— 变更类：实现（正文）变化。
- `CLASS_EDGE = 'edge'`（`lib/graph-diff.js:18`）— 变更类：仅依赖边变化。
- `CLASS_RENAMED = 'renamed'`（`lib/graph-diff.js:19`）— 变更类：改名配对。
- `DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'`（`lib/graph-diff.js:21`）— 截断标记，见 `truncateToTokens`。
- `DEFAULT_TAU_REN = 0.8`（`lib/graph-diff.js:368`）— 改名配对相似度阈值。
- `DEFAULT_MAX_DIFF_TOKENS = 2000`（`lib/graph-diff.js:369`）— 单组件 diff 文本的最大 token 预算。

### 文本级工具（导出）

- `normalizeBody(text)`（`lib/graph-diff.js:28-30`）— 去掉首尾空白并折叠内部连续空白为单个空格；
  返回空串兜底（`text ?? ''`）。用于「正文相似度 / 长度比」前的规范化。
- `stripComments(text)`（`lib/graph-diff.js:69-100`）— 去掉注释与纯装饰空白，只留代码本体。
  逐行扫描、跟踪块注释状态（`/*…*/`、`<!--…-->`、`"""…"""`、`'''…'''`），行首命中
  `//`、`///`、`#`、`--`、`;`、`%`（`LINE_COMMENT_MARKS`，`lib/graph-diff.js:35`）则整行丢弃；
  行内仅对 `//`、`#` 调 `stripTrailingComment`（见 `lib/graph-diff.js:43`）。注意字符串里的
  `//` 会误判为注释（可接受近似，见 `lib/graph-diff.js:66-68`）。`ws` 折叠后 `trim` 返回。
- `stripTrailingComment(line)`（`lib/graph-diff.js:43-62`，内部）— 去掉引号外的行末注释，
  跟踪 `' " \`` 三种引号与反斜杠转义，故 `"http://x"` 不被当成注释。`#` 仅当位于行首或
  前一字符为空白时才算注释（避免吃掉 C 预处理 / JS 私有字段，见 `lib/graph-diff.js:56`）。
- `codeHash(node)`（`lib/graph-diff.js:108-111`）— 「代码本体」SHA1 哈希，**不含注释与排版差异**。
  快照回读节点若没有 `sourceCode` 但带固化 `codeHash` 则直接返回（见 `lib/graph-diff.js:109`）。
  用于区分「只改注释」与「代码实质变化」。注意它**不**看 `docstring`（docstring 是文档，应触发重写）。
- `documentedSource(node)`（`lib/graph-diff.js:114-119`）— 组件「源码＋文档注释」拼接：
  把 `docstring` 拼到 `sourceCode` 前（仅当 `sourceCode` 不含该 doc 时）。Rust 的 `///` 在
  `sourceCode` 之外，不带上就看不出「只改了文档」。
- `bodyHash(node)`（`lib/graph-diff.js:121-126`）— 对 `normalizeBody(documentedSource(node))`
  取 SHA1。快照回读节点无 `sourceCode` 但有固化 `bodyHash` 时直接返回（`lib/graph-diff.js:124`），
  避免把源码读回重算。这是 `diffGraphs` 判定「实现是否变化」的主哈希。
- `signature(node)`（`lib/graph-diff.js:128-134`）— 取「签名三元组」：`{ name, parameters, baseClasses }`
  （数组用展开拷贝，避免外部改动）。
- `signatureChanged(a, b)`（`lib/graph-diff.js:136-145`）— 逐字段比较签名三元组
  （name、parameters 长度与逐项、baseClasses 长度与逐项），任一不同即返回 `true`。

### difflib 移植（导出）

- `tokens(text)`（`lib/graph-diff.js:147-149`，内部）— 用 Unicode 属性类 `TOKEN`
  （`lib/graph-diff.js:26`，`/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu`）分词。用 Unicode 属性类还原
  Python `\w` 的语义（中文算一个 token），避免 JS `\w` 把中文按字切碎、整体相似度偏高
  （见 `lib/graph-diff.js:24-26`）。
- `buildB2J(b)` / `findLongestMatch(...)` / `getMatchingBlocks(...)`（`lib/graph-diff.js:156-226`，内部）
  — `difflib.SequenceMatcher` 的逐位移植（`autojunk=False`，无 junk 元素），含最长匹配 DP 与
  相邻匹配块归并（与 Python 完全一致，见 `lib/graph-diff.js:208`）。
- `sequenceRatio(aArr, bArr)`（`lib/graph-diff.js:229-236`）— `difflib.SequenceMatcher.ratio()` 移植：
  `2.0 * matches / (len(a) + len(b))`，空序列返回 `1.0`。
- `bodySimilarity(a, b)`（`lib/graph-diff.js:239-245`）— 上游 `body_similarity`：token 序列的
  difflib ratio，落在 `[0,1]`；双双为空返回 `1.0`，任一为空返回 `0.0`。
- `approxTokens(text)`（`lib/graph-diff.js:247-249`）— 估算 token 数（`floor(len/4)+1`），用于截断决策。
- `truncateToTokens(text, maxTokens)`（`lib/graph-diff.js:251-257`）— 当估算 token 超预算时，
  头尾各取 `maxTokens/2` 并用 `DIFF_TRUNCATED_MARKER` 连接，避免巨型 diff 撑爆上下文。
- `splitKeepEnds(text)`（`lib/graph-diff.js:263-269`，内部）— 还原 Python `splitlines(keepends=True)`，
  末尾无换行的最后一行也保留。
- `getOpcodes(a, b)` / `getGroupedOpcodes(a, b, n)` / `rangeUnified(start, stop)`
  （`lib/graph-diff.js:271-325`，内部）— `unified_diff` 的 opcode 与分组逻辑移植（含 `n` 行上下文裁剪）。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n = 3, lineterm = '\n')`
  （`lib/graph-diff.js:327-355`）— `difflib.unified_diff` 移植，返回完整 unified diff 字符串。
- `unifiedBodyDiff(oldNode, newNode, label)`（`lib/graph-diff.js:358-362`）— 上游 `unified_body_diff`：
  对 `documentedSource` 取行后调 `unifiedDiff`，整文件相对路径作 label，上下文固定 `n=2`。

### 组件级主入口（导出）

- `emptyGraphDiff()`（`lib/graph-diff.js:413-423`）— 返回空 diff 结构：
  `{ added:Set, deleted:Set, interface:Set, body:Set, edge:Set, renamed:Map(oldId→newId), records:Map }`。
- `graphDiffCounts(d)`（`lib/graph-diff.js:425-434`）— 把各 Set/Map 的大小汇成
  `{ added, deleted, interface, body, edge, renamed }` 计数对象。
- `changedIds(d)`（`lib/graph-diff.js:436-440`）— 合并所有变更类 id（含 `renamed` 的 newId）成单一 `Set`。
- `isDiffEmpty(d)`（`lib/graph-diff.js:442-444`）— `changedIds(d).size === 0` 即空。
- `pairRenames(deleted, added, oldGraph, newGraph, tauRen = DEFAULT_TAU_REN)`
  （`lib/graph-diff.js:371-407`）— 改名配对：按组件 **kind** 分组新增（`addedByKind`），
  对每个被删组件，按「长度比」先筛掉够不到阈值者（`ratio < tauRen*0.9` 直接跳过，见
  `lib/graph-diff.js:391`），再用 `bodySimilarity` 计算相似度，≥ `tauRen` 入候选；候选按相似度
  降序贪心匹配（old/new 各只消费一次），返回 `[[oldId, newId, sim], …]`。
- `diffGraphs(oldGraph, newGraph, opts = {})`（`lib/graph-diff.js:447-564`）— **主入口**，见下方详解。
- `serializeDiff(d)`（`lib/graph-diff.js:567-578`）— 序列化：Set/Map 转排序数组/对象，便于落盘与对拍。

### `diffGraphs` 主流程详解（`lib/graph-diff.js:447-564`）

1. 取 `tauRen`（默认 `0.8`）、`maxDiffTokens`（默认 `2000`）两个选项（`lib/graph-diff.js:448-449`）。
2. 按 id 集合差算 `added` / `deleted`（`lib/graph-diff.js:454-455`）。
3. 遍历新旧都在的 id（`lib/graph-diff.js:457-497`）：
   - `sigChanged = signatureChanged(o, n)`；
   - `hashChanged = bodyHash(o) !== bodyHash(n)`；
   - `edgesChanged`：比较 `o.dependsOn` / `n.dependsOn` 的 Set（`lib/graph-diff.js:463-465`）；
   - 三类互斥分类（`lib/graph-diff.js:466-477`）：签名变→`interface`；仅实现变→`body`；
     仅依赖变→`edge`；三者皆未变则跳过。
   - 写入 `rec`（含 `componentId / changeClass / oldId / newId / relativePath / componentType /
     oldSignature / newSignature / similarity(=null) / signatureChanged / edgesAdded / edgesRemoved / diff`），
     `body` 类才填 `diff = truncateToTokens(unifiedBodyDiff(...), maxDiffTokens)`（`lib/graph-diff.js:495`）。
4. 改名配对（`lib/graph-diff.js:499-524`）：调 `pairRenames` 后从 deleted/added 移除、写入
   `renamed`（`oldId→newId`），`records` 里记 `changeClass: CLASS_RENAMED`、`similarity` 四舍五入到 4 位、
   若签名变则额外把 newId 加入 `interface`。
5. 补 `added` / `deleted` 的 records（`lib/graph-diff.js:526-561`），`diff` 一律填 `unifiedBodyDiff`
   （新增用 `oldNode=null`、删除用 `newNode=null`）。
6. 返回 `result`（`lib/graph-diff.js:563`）。

### 数据契约（Node 记录字段）

贯穿 symbols → incremental 快照 → graph-diff 的 Node 形状（见 `lib/graph-diff.js:10`）：

| 字段 | 类型 | 用途 | 是否参与判定 |
| --- | --- | --- | --- |
| `id` | string | 组件 id，形如 `<相对路径>#<符号名>` | 作 Map key |
| `name` | string | 符号名 | 签名比较 |
| `kind` | string | 类型（`function`/`class`/`method`…） | 改名配对分组（`lib/graph-diff.js:375`） |
| `relativePath` | string | POSIX 相对路径 | 仅记录，不判定 |
| `sourceCode` | string | 源码本体 | `codeHash`/`bodyHash`/`bodySimilarity` 输入 |
| `docstring` | string | 文档注释 | `documentedSource`/`bodyHash` |
| `parameters` | string[] | 参数名 | 签名比较 |
| `baseClasses` | string[] | 基类 | 签名比较 |
| `dependsOn` | string[] | 依赖边（其他组件 id） | `edge` 类判定 |
| `bodyHash` | string? | 固化实现哈希（快照回读） | 命中则跳过源码重算（`lib/graph-diff.js:124`） |
| `codeHash` | string? | 固化「代码本体」哈希（快照回读） | 命中则跳过源码重算（`lib/graph-diff.js:109`） |

> 注意：快照侧只存 `SLIM_FIELDS`（`id / name / kind / relativePath / parameters / baseClasses /
> dependsOn / bodyHash / codeHash`，见 `lib/incremental.js:26`），**不存 `sourceCode` / `docstring`**，
> 故快照回读节点的 `bodyHash`/`codeHash` 必须已固化，否则 `diffGraphs` 无法重算
> （`lib/incremental.js:24-26`）。

## Architecture

组件级 diff 处于「源码图 → 变更判定 → 增量编译」管线的中段。三方（生产者 / 存取方 / 消费方）共用同一 Node 契约与 `#` id 约定。

```text
 symbol extraction          snapshot store              graph-diff core
┌──────────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐
│ lib/symbols.js   │   │ lib/incremental.js    │   │ lib/graph-diff.js        │
│ extractSymbols() │──►│ slimGraph()/          │──►│ diffGraphs()             │
│ -> Map<id,Node>  │   │ graphFromSnapshot()   │   │  ├ added/deleted         │
│ (Node shape:     │   │ (SLIM_FIELDS, no src) │   │  ├ interface/body/edge   │
│  id#name,kind,   │   │ [19-88]               │   │  ├ pairRenames()         │
│  sourceCode,...) │   │                       │   │  └ serializeDiff()       │
│ [symbols.js:13]  │   └───────────┬───────────┘   └────────────┬─────────────┘
└──────────────────┘               │ old/new Graph (Map)        │ diff result
                                    │                            │
                                    ▼                            ▼
                         ┌───────────────────────────┐   ┌──────────────────────────┐
                         │ filterStaleTasks()        │   │ consumers:               │
                         │ (incremental.js:140-194)  │   │  update-planner.js:19    │
                         │ realChanged = bodyHash    │   │   realChangedIds()       │
                         │   xor codeHash (cosmetic) │   │  change-set.js /         │
                         │                           │   │  update-record.js        │
                         └───────────────────────────┘   └──────────────────────────┘
```

- **生产者** `lib/symbols.js`：AST 级提取，输出满足 Node 契约的 `Map<id, Node>`（`lib/symbols.js:13-14`）。
- **存取方** `lib/incremental.js`：`slimGraph`/`slimComponent` 落地精简快照（`lib/incremental.js:28-48`），
  `graphFromSnapshot` 回读为 `Map<id, Node>`（`lib/incremental.js:69-88`），二者均补齐 `bodyHash`/`codeHash`。
- **核心** `lib/graph-diff.js`：`diffGraphs` 是导出给外部的唯一种子入口，其余为文本工具 / difflib 移植 / 辅助函数。
- **消费方**：`lib/incremental.js:140` 的 `filterStaleTasks` 与 `lib/update-planner.js:19` 的 `realChangedIds`
  都调 `diffGraphs` + `changedIds` + `graphDiffCounts`，并在判定层叠加「纯注释降级」（codeHash 不变则放行）。

## Data Flow

一次增量编译中，本模块的数据流动如下：

1. **建图**（上游）：`lib/symbols.js` 对变更文件做 AST 提取，得到 `newGraph: Map<id, Node>`；
   同时 `lib/incremental.js` 从 `.codewiki/temp/symbol-graph.json` 回读旧快照得 `oldGraph`
   （`graphFromSnapshot`，`lib/incremental.js:69-88`）。
2. **主 diff**：`filterStaleTasks`（或 `planUpdate`）调 `diffGraphs(oldGraph, newGraph, opts)`
   （`lib/incremental.js:141`、`lib/update-planner.js`），输出含 `added/deleted/interface/body/edge/renamed/records` 的 diff。
3. **降级判定**（消费方叠加）：遍历 `changedIds`，对 `body` 类组件比较 `codeHash`
   （`lib/incremental.js:154-169`）；`codeHash` 相同且 docstring 未变者归入 `cosmeticOnly`，
   从 `realChanged` 剔除——避免「只改注释/排版」触发文章重写。
4. **产出**：
   - `lib/incremental.js` 用 `realChanged` 决定每篇文章 `keep` / `dropped`，并附 `changedComponents`
     （`lib/incremental.js:172-193`）；
   - `lib/update-planner.js` 用 `realChangedIds` 升级为 `write/keep/delete/review` 四类 action，
     并收集 `unmappedChanges`（`lib/update-planner.js:166` 起）；
   - `diffGraphs` 返回的 `diff` 文本（unified body diff，已按 `maxDiffTokens` 截断）随 record 落盘，
     供写作者当重点、供 `lib/update-record.js` 复盘。
5. **序列化 / 对拍**：`serializeDiff` 把 diff 转成可 JSON 化的对象（`lib/graph-diff.js:567-578`），
   由 `test-graphdiff.mjs` 与上游 `test-fixtures/graphdiff-golden.json` 逐位对拍，
   保证移植与 FSoft Python 原版一致。

**关键数据不变量**：
- 改名配对成功后，该 id 同时**从** `deleted`/`added` **移除**并**写入** `renamed`
  （`lib/graph-diff.js:499-502`），故 `changedIds` 不会重复计数。
- `renamed` 的 `newId` 会被 `changedIds` 纳入（`lib/graph-diff.js:438`）；若签名也变了，还会进 `interface`
  （`lib/graph-diff.js:523`）。
- 同一组件至多落一条 `records`（按 `cid`/`newId` 覆盖写）。

## Connections

- [[incremental]] — `lib/incremental.js` 是最直接消费方：`filterStaleTasks` 调 `diffGraphs` +
  `changedIds` + `graphDiffCounts`（`lib/incremental.js:17,141-143`）并叠加纯注释降级；同时负责
  `slimGraph`/`graphFromSnapshot` 的快照存取（Node 契约的实现方之一）。
- [[update-planner]] — `lib/update-planner.js` 也复用 `diffGraphs`/`changedIds`/`graphDiffCounts`/
  `codeHash`（`lib/update-planner.js:19`），其 `realChangedIds`（`:57`）与本模块判定同源，把组件级
  diff 升级为文章级 `write/keep/delete/review` action。
- [[symbols]] — `lib/symbols.js` 是 Node 记录的生产者，输出的字段形状与本模块契约一致
  （`lib/symbols.js:13-14`），并定义 `SUPPORTED_EXTS` 供 planner 判断源码扩展名。
- [[change-set]] — `lib/change-set.js` 采集 committed/staged/unstaged/untracked 四路文件级改动，
  其 `normChangePath` 的 POSIX 归一思路与本模块的 `#` id / `normRel`（`lib/incremental.js:118-120`）一致。
- [[update-record]] — `lib/update-record.js` 把 `diffGraphs` 产出的变更与逐篇结果收成可机读记录，
  回答「变更是否全部有归属、能不能推进编译基线」。
- 外部依赖（非本仓模块）：FSoft-AI4Code/CodeWiki 的 `graph_diff.py`（上游算法源，见
  `lib/graph-diff.js:1-6`）；对拍基准 `test-fixtures/gen-graphdiff-golden.py` 用 Python 原生
  `difflib`/`hashlib` 生成 `test-fixtures/graphdiff-golden.json`，由 `test-graphdiff.mjs` 消费。

## Known Issues

- **字符串内 `//` 被误判为注释**（`lib/graph-diff.js:69-71`）：`stripComments` 的块/行注释剥离不进词法分析器，
  字符串字面量里的 `//` 会被当成注释剥掉，导致 `codeHash` 偏小、理论上有低概率碰撞。作者明确这是
  「可接受的近似」，引入真正词法分析需带语言参数、得不偿失。目前**未禁用**，属设计取舍而非 bug。
- **`bodyHash` 粒度不区分注释**（`lib/graph-diff.js:121-126`）：`bodyHash` 覆盖整段源码文本，只做空白归一
  （与上游 `normalize_body` 一致），所以「只改注释」也会让它变，进而把组件归入 `body` 类。本模块**故意不动**
  diff 逻辑（要与上游 golden 对拍），而是把「纯注释降级」上移到判定层 `lib/incremental.js:146-169` 与
  `lib/update-planner.js:57` 的 `realChangedIds`，用 `codeHash` 抵消该粒度问题。
- **快照不存 `sourceCode`/`docstring`**（`lib/incremental.js:24-26`）：`.codewiki/` 要入库故只存 `SLIM_FIELDS`。
  后果是快照回读节点在 `bodyHash`/`codeHash` 未固化时必须返回 `null`（`lib/graph-diff.js:108,124`），
  否则无法重算——因此 `slimGraph` 在落地前就固化这两个哈希（`lib/incremental.js:37-42`）。属预期行为，无禁用项。
- **改名阈值与长度比预筛**（`lib/graph-diff.js:371,388-391`）：`pairRenames` 用 `tauRen*0.9` 做长度比粗筛、
  用 `tauRen=0.8` 做相似度精筛，二者都是经验常量。跨语言/跨大改动的改名可能漏配（相似度＜0.8），
  该删除/新增会分别落入 `deleted`/`added` 而非 `renamed`。属参数调优范畴，非禁用功能。
- **`#` 行内注释的局限**（`lib/graph-diff.js:37-39`）：`--` / `;` / `%` 在表达式中常见（`a--b`、分号结尾、
  取模），故不做行内剥离，只在行首生效。这是为兼容 C/SQL 等有歧义语法的有意为之。
- **无可直接引用的「功能禁用 / 注释关闭」项**：本模块所有导出函数均在 `test-graphdiff.mjs` 与生产链路中被引用，
  未发现被 `#` 注释禁用或功能被关闭的代码；上述均为设计取舍而非禁用。

## Architecture Detail

`diffGraphs` 的判定分两大阶段：**同 id 组件分类**与**跨 id 改名配对**，二者都复用 `bodyHash` / `signature` / `pairRenames` 等纯函数。

```text
                oldGraph ──┐                ┌── newGraph
                           ▼                ▼
   ┌─────────────────────────── diffGraphs ───────────────────────────┐
   │                                                                   │
   │  1) 集合差分: added=新\旧  deleted=旧\新                          │
   │              │                                                    │
   │  2) 同 id 遍历 oldGraph∩newGraph:                                │
   │     signatureChanged(o,n)? ──是──► interface (CLASS_IFACE)       │
   │        │否                                                        │
   │     bodyHash(o)!==bodyHash(n)? ─是──► body (CLASS_BODY)          │
   │        │否                                                        │
   │     dependsOn 不同? ──────────────► edge (CLASS_EDGE)             │
   │     都否 → 跳过（不变）                                          │
   │              │                                                    │
   │  3) pairRenames(deleted, added, ...) ──► renamed Map<old,new>     │
   │     (按 bodySimilarity 贪心，tauRen=0.8)                         │
   │              │                                                    │
   │  4) 写 records: added/deleted 各有独立分支                       │
   └───────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                          GraphDiff {added,deleted,
                                     interface,body,edge,
                                     renamed,records}
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                                       ▼
   update-planner.planUpdate              incremental.filterStaleTasks
   (realChangedIds 降级)                  (cosmetic 降级)
```

底层依赖（`lib/graph-diff.js` 内部）：见本模块 Architecture 主框图之上的依赖说明。
