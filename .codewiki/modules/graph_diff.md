---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/update-planner.js
  - lib/incremental.js
  - lib/change-set.js
  - lib/engine/output.js
tags: [graph-diff, incremental, rename-detection, unified-diff, difflib]
---

## Overview

`lib/graph-diff.js` 是符号级（组件级）增量 diff 的核心算法库，移植自 FSoft-AI4Code/CodeWiki 的 `codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现，见文件头注释 `lib/graph-diff.js:1-11`）。

为什么是「移植」而不是「调用」：上游最值钱的判定逻辑（哪些组件真的变了、变的是签名还是实现、哪个删除对应哪个新增＝改名）全部是纯标准库算法（hashlib / difflib / re），零 ML 依赖。逐位移植后本插件保持**纯 Node、零外部运行时**，判定精度与上游一致（`lib/graph-diff.js:4-6`）。

它把两次符号抽取得到的「符号图」（`Map<id, node>`，id 约定为 `<相对路径>#<符号名>`，`lib/graph-diff.js:8-10`）做对比，产出三类结果：

1. **变更分类**：对每个仍存在的组件判定 `interface`（签名变） / `body`（实现变） / `edge`（仅依赖边变）；对新消失的组件记 `deleted`、新出现的记 `added`。
2. **改名检测**：按 body 相似度贪心配对 `deleted` 与 `added`，相似度超过阈值 `tauRen`（默认 `0.8`）则记为 `renamed`，并把对应的 deleted/added 收回。
3. **统一 diff 生成**：对发生实质变化的组件，用移植自 `difflib.unified_diff` 的 `unifiedDiff` 生成带上下文的 unified diff 文本（默认 2 行上下文，长文本按 token 预算截断）。

组件 id 约定与上游相同：`<相对路径>#<符号名>`（上游是 `path::name`，用 `#` 是为了不与 Windows 盘符里的 `:` 混淆）。Node 记录形状为 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（`lib/graph-diff.js:8-10`）。

该模块是纯函数、不碰文件系统，被 `lib/incremental.js`（符号级增量判定）与 `lib/update-planner.js`（升级版「每篇文章该做什么」计划）共同消费。正确性由 `test-graphdiff.mjs` 对拍 `test-fixtures/graphdiff-golden.json`（由 `test-fixtures/gen-graphdiff-golden.py` 用 Python 原生 difflib / hashlib 生成）来保证。

## Key Components

所有公开符号均从 `lib/graph-diff.js` 导出。组件 id 约定 `<相对路径>#<符号名>`，node 记录含 `id / name / kind / relativePath / sourceCode / docstring / parameters / baseClasses / dependsOn`。

### 常量

- `CLASS_ADDED = 'added'`（`lib/graph-diff.js:14`）——新增组件类标记。
- `CLASS_DELETED = 'deleted'`（`lib/graph-diff.js:15`）——删除组件类标记。
- `CLASS_IFACE = 'interface'`（`lib/graph-diff.js:16`）——签名变更类标记。
- `CLASS_BODY = 'body'`（`lib/graph-diff.js:17`）——实现变更类标记。
- `CLASS_EDGE = 'edge'`（`lib/graph-diff.js:18`）——仅依赖边变更类标记。
- `CLASS_RENAMED = 'renamed'`（`lib/graph-diff.js:19`）——改名类标记。
- `DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'`（`lib/graph-diff.js:21`）——长 diff 被截断时插入的标记。
- `DEFAULT_TAU_REN = 0.8`（`lib/graph-diff.js:448`）——改名配对的相似度阈值 `tauRen`。
- `DEFAULT_MAX_DIFF_TOKENS = 2000`（`lib/graph-diff.js:369`）——单个 unified diff 的最大 token 预算（超出则首尾截断）。

### 注释/空白处理与哈希

- `WS = /\s+/gu`（`lib/graph-diff.js:23`）；`TOKEN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu`（`lib/graph-diff.js:26`）——Unicode 感知的 token 正则，用于还原 Python `\w` 的语义（中文算一个 token），否则中文会被按字切碎导致相似度整体偏高（见 `lib/graph-diff.js:24-25`）。
- `normalizeBody(text)`（`lib/graph-diff.js:28-30`）——`String(text ?? '').trim().replace(WS, ' ')`，规范化正文：去首尾空白、合并内部空白为单空格。
- `LINE_COMMENT_MARKS = ['//', '///', '#', '--', ';', '%']`（`lib/graph-diff.js:35`）、`BLOCK_COMMENT_PAIRS = [['/*','*/'], ['<!--','-->'], ['"""','"""'], ["'''","'''"]]`（`lib/graph-diff.js:39`）、`TRAILING_COMMENT_MARKS = ['//', '#']`（`lib/graph-diff.js:39`）——注释剥离用的标记表；行首注释只认 `LINE_COMMENT_MARKS`，行内剥离只认 `TRAILING_COMMENT_MARKS`（避免 `--` / `;` / `%` 在表达式里被误剥，见 `lib/graph-diff.js:32-39`）。
- `stripTrailingComment(line)`（`lib/graph-diff.js:43-62`）——剥掉一行里位于引号（`' " \``）之外、且带反斜杠转义跟踪的行注释；`#` 只有在行首或前导空白时才算注释（避免吃到 C 预处理 / JS 私有字段）。
- `stripComments(text)`（`lib/graph-diff.js:69-100`）——逐行扫描、跟踪块注释状态、之后再做行首注释与行内注释剥离，返回只留代码本体的字符串（空白归一）。用途：区分「只改了注释/排版」与「代码有实质变化」，前者不该触发文章重写（见 `lib/graph-diff.js:64-68`）。字符串里的 `//` 会被误判为注释，是**可接受的近似**（真正词法分析要带语言参数、得不偿失）。
- `codeHash(node)`（`lib/graph-diff.js:108-111`）——「代码本体」哈希（sha1），不含注释与排版差异。若节点无 `sourceCode` 但有固化 `codeHash` 则直接返回（快照回读分支）。注意**不**用 `documentedSource`：`docstring` 是有意义的文档，改它应当重写，普通注释才算噪音（见 `lib/graph-diff.js:102-107`）。
- `documentedSource(node)`（`lib/graph-diff.js:114-119`）——返回 `docstring + '\n' + sourceCode`（仅当 docstring 不含在源码里时），用于 Rust `///` 这类在 `sourceCode` 之外的文档注释也能被比较。
- `bodyHash(node)`（`lib/graph-diff.js:121-126`）——对 `normalizeBody(documentedSource(node))` 做 sha1。若节点无 `sourceCode` 但有固化 `bodyHash` 则直接返回（快照回读分支，`.codewiki/` 不存源码全文，哈希已固化，见 `lib/graph-diff.js:122-124`）。
- `signature(node)`（`lib/graph-diff.js:128-134`）——返回 `{ name, parameters, baseClasses }` 的浅拷贝，用于签名比对。
- `signatureChanged(a, b)`（`lib/graph-diff.js:136-145`）——依次比对 `name` / `parameters`（长度与逐项） / `baseClasses`（长度与逐项），任一不同即返回 `true`。

### difflib 移植（SequenceMatcher）

- `tokens(text)`（`lib/graph-diff.js:147-149`）——用 `TOKEN` 正则把文本切成 token 数组。
- `buildB2J(b)`（`lib/graph-diff.js:156-164`）——构建 `token → 出现位置数组` 的倒排索引（`b2j`），对应 Python `difflib._chain_b` / b2j 构建。
- `findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)`（`lib/graph-diff.js:166-189`）——在 `[alo,ahi) × [blo,bhi)` 区间内找最长公共子序列匹配，与 `difflib.SequenceMatcher.find_longest_match` 逐位对齐（含 `j2len` 动态规划）。
- `getMatchingBlocks(a, b)`（`lib/graph-diff.js:191-226`）——递归分治找所有匹配块，排序后合并相邻块，末尾追加哨兵 `[la, lb, 0]`，与 Python `difflib` 完全一致（`lib/graph-diff.js:208` 注释）。
- `sequenceRatio(aArr, bArr)`（`lib/graph-diff.js:229-236`）——`difflib.SequenceMatcher.ratio()` 移植：`(2.0 * matches) / (a.length + b.length)`，两者都为空返回 `1.0`。
- `bodySimilarity(a, b)`（`lib/graph-diff.js:239-245`）——上游 `body_similarity`：对 `tokens(a)`/`tokens(b)` 取 `sequenceRatio`，落在 `[0,1]`；两者都空返回 `1.0`，任一为空返回 `0.0`。

### 截断与 unified diff 移植

- `approxTokens(text)`（`lib/graph-diff.js:247-249`）——`Math.floor(len/4) + 1`，粗略 token 预算（每 4 字符约 1 token）。
- `truncateToTokens(text, maxTokens)`（`lib/graph-diff.js:251-257`）——若 `approxTokens(text) > maxTokens`，则保留首尾各 `maxTokens/2` 个字符，中间插入 `DIFF_TRUNCATED_MARKER`，用于长 diff 截断。
- `splitKeepEnds(text)`（`lib/graph-diff.js:263-269`）——对应 Python `splitlines(keepends=True)`：用 `/[^\n]*\n|[^\n]+$/g` 匹配，末尾无换行的最后一行也保留。
- `getOpcodes(a, b)`（`lib/graph-diff.js:271-287`）——由匹配块生成 `replace/delete/insert/equal` 操作码（tag, i1, i2, j1, j2）。
- `getGroupedOpcodes(a, b, n)`（`lib/graph-diff.js:289-317`）——按上下文行数 `n` 把操作码分组（hunk），与 `difflib.unified_diff` 的分组逻辑一致（含首尾 equal 裁剪、过长的 equal 块切分）。
- `rangeUnified(start, stop)`（`lib/graph-diff.js:319-325`）——把 `[start, stop)` 区间转成 unified diff 的行列范围表示（`3` / `2,0` / `3,4`）。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n = 3, lineterm = '\n')`（`lib/graph-diff.js:327-355`）——完整移植 `difflib.unified_diff`：输出 `---` / `+++` 文件头（仅首个 group 输出一次）、每个 group 一行 `@@` 头、再按 `equal/-/+/` 前缀逐行拼接。返回字符串（已 join）。
- `unifiedBodyDiff(oldNode, newNode, label)`（`lib/graph-diff.js:358-362`）——上游 `unified_body_diff`：用 `documentedSource` 取新旧源码行、`a/<label>` / `b/<label>` 作 label、上下文固定 `n = 2` 调 `unifiedDiff`。任一节点为 `null` 时空数组（纯新增/纯删除）。

### 改名配对

- `pairRenames(deleted, added, oldGraph, newGraph, tauRen = DEFAULT_TAU_REN)`（`lib/graph-diff.js:371-407`）——改名配对主函数。算法：
  1. 按 `kind` 把 `added` 分组（`addedByKind`）；
  2. 对每个 `deleted` 节点，只与同类 `kind` 的 `added` 节点比较；先按长度比快速排除（长度差太大够不到 `tauRen` 则跳过，`lib/graph-diff.js:388-391`）；
  3. 用 `bodySimilarity` 算相似度，≥ `tauRen` 的进候选（`lib/graph-diff.js:392-393`）；
  4. 候选按相似度降序排序后贪心匹配：每个 old/new 至多配对一次（`lib/graph-diff.js:396-406`）。
  返回 `[[oldId, newId, sim], ...]`。

### 主入口与结果结构

- `emptyGraphDiff()`（`lib/graph-diff.js:413-423`）——返回空 diff 结果骨架：`{ added, deleted, interface, body, edge: Set, renamed: Map<oldId,newId>, records: Map }`。
- `graphDiffCounts(d)`（`lib/graph-diff.js:425-434`）——把各 Set/Map 的 `.size` 汇总成 `{ added, deleted, interface, body, edge, renamed }` 计数对象。
- `changedIds(d)`（`lib/graph-diff.js:436-440`）——返回所有「发生过变化的 id」集合：合并 `added` / `deleted` / `interface` / `body` / `edge`，并加入 `renamed` 的 value（newId）。
- `isDiffEmpty(d)`（`lib/graph-diff.js:442-444`）——`changedIds(d).size === 0`。
- `diffGraphs(oldGraph, newGraph, opts = {})`（`lib/graph-diff.js:447-564`）——**主入口**，见下节「Architecture」详述。返回的 `records: Map<componentId, record>` 每条记录字段（`lib/graph-diff.js:480-494`、`506-520`、`528-542`、`546-560`）：
  - `componentId`：组件 id；
  - `changeClass`：取 `CLASS_*` 之一；
  - `oldId` / `newId`：`added` 的 `oldId=null`、`deleted` 的 `newId=null`、`renamed` 的 `oldId/newId` 分别为旧/新 id；
  - `relativePath`：新节点（或旧节点，对 deleted）的 `relativePath`；
  - `componentType`：`kind`；
  - `oldSignature` / `newSignature`：`signature(o)` / `signature(n)`，`added` 的 `oldSignature=null`、`deleted` 的 `newSignature=null`；
  - `similarity`：`renamed` 为 `Math.round(sim * 10000) / 10000`，其余 `null`；
  - `signatureChanged`：`signatureChanged(o, n)`；
  - `edgesAdded` / `edgesRemoved`：依赖边增删（排序数组），`added` 记全部 `dependsOn`、`deleted` 记全部 `dependsOn`；
  - `diff`：`body` / `renamed`（且 `bodyHash` 不同）/ `added` / `deleted` 时填 `truncateToTokens(unifiedBodyDiff(...), maxDiffTokens)`，其余空串。

### 序列化

- `serializeDiff(d)`（`lib/graph-diff.js:567-578`）——把 Set/Map 转成可落盘 / 对拍的数组对象：`{ counts, added[], deleted[], interface[], body[], edge[], renamed: {oldId:newId}, records: {id: record} }`，各数组/键均排序。`renamed` 与 `records` 用 `Object.fromEntries(...sort(...))` 保证稳定顺序。

## Architecture

`diffGraphs` 是主入口；它先基于 id 集合做 added/deleted 拆分，再逐组件分类（interface/body/edge），最后用 `pairRenames` 把删除+新增配对成 renamed，并补登记纯 added/deleted 的 records。

```text
                       oldGraph ─────────┐
                       newGraph ─────────┤
                                          ▼
                              ┌──────────────────────┐
                              │   diffGraphs()       │  lib/graph-diff.js:447
                              │  opts.tauRen /        │
                              │  maxDiffTokens        │
                              └──────────┬───────────┘
                                         │
       ┌─────────── 1) id 集合拆分 ──────┼───────────────┐
       │  newIds∖oldIds→added            │               │ oldIds∖newIds→deleted
       ▼                                 ▼               ▼
  result.added                  result.deleted   (待 pairRenames 收回)
                                         │
       ┌─────────── 2) 逐组件分类 (仍存在的 id) ─┘
       │  signatureChanged()? → CLASS_IFACE
       │  else bodyHash() 变? → CLASS_BODY (+ unifiedBodyDiff 截断)
       │  else dependsOn 变? → CLASS_EDGE
       ▼
  result.interface / body / edge  +  records.set(cid, rec)
                                         │
       ┌─────────── 3) 改名配对 ─────────┘
       │  pairRenames(deleted, added, oldGraph, newGraph, tauRen)
       │    kind 分组 → bodySimilarity ≥ 0.8 候选 → 贪心匹配
       ▼
  result.renamed: Map<oldId,newId>  (从 added/deleted 删除，补 record)
                                         │
       ┌─────────── 4) 补登记 ───────────┘
       │  剩余 added → CLASS_ADDED  record（含 unifiedBodyDiff）
       │  剩余 deleted → CLASS_DELETED record（含 unifiedBodyDiff）
       ▼
  emptyGraphDiff 结果 ──► serializeDiff() ──► 可落盘/对拍对象

  文档字符串/注释哈希链（供判定层降级用）:
    stripComments → codeHash      (lib/graph-diff.js:69/108)
    documentedSource → bodyHash   (lib/graph-diff.js:114/121)
    bodySimilarity ← tokens ← TOKEN (lib/graph-diff.js:239/147/26)
    unifiedDiff ← getOpcodes ← getMatchingBlocks ← findLongestMatch (lib/graph-diff.js:327/271/191/166)
```

组件 ≥3 且流程非平凡，故上图按四个阶段拆分。注意 `difflib` 全套（`SequenceMatcher` 的 `buildB2J`/`findLongestMatch`/`getMatchingBlocks`/`ratio`，`unified_diff` 的 `getOpcodes`/`getGroupedOpcodes`/`rangeUnified`）与 Python 原版**逐位对齐**，由 `test-graphdiff.mjs` 对拍 `test-fixtures/graphdiff-golden.json` 验证（`lib/graph-diff.js:151-155`、`259-261`）。

## Data Flow

`lib/graph-diff.js` 自身不碰 IO，其数据流是「两份符号图 → GraphDiff 结果 → 序列化/下游消费」：

1. **输入**：`oldGraph` 与 `newGraph` 都是 `Map<id, node>`，id 形如 `<相对路径>#<符号名>`。节点字段见 `lib/graph-diff.js:10`。实时抽取节点带 `sourceCode`；从快照回读的节点（`lib/incremental.js:69-88` 的 `graphFromSnapshot`）不带 `sourceCode`，改为带固化的 `bodyHash` / `codeHash`，于是 `codeHash()` / `bodyHash()` 走缓存分支（`lib/graph-diff.js:121`、`124`）。
2. **分类**：`diffGraphs` 先按 id 集合差集得到 `added` / `deleted`（`lib/graph-diff.js:454-455`）。对仍存在的 id，依次用 `signatureChanged`（签名）、`bodyHash` 比较（实现）、`dependsOn` 集合比较（依赖边）判定 `interface` / `body` / `edge`（`lib/graph-diff.js:457-477`）。`body` 类变更会生成截断后的 unified diff 文本（`lib/graph-diff.js:121`）。
3. **改名**：把 `deleted` × `added` 交给 `pairRenames`，按 `kind` 分组、用 `bodySimilarity` 筛 ≥ `tauRen(0.8)` 的候选、贪心匹配（`lib/graph-diff.js:499`、`371-407`）。命中后从 `added`/`deleted` 收回，写入 `renamed` 并补 `CLASS_RENAMED` record（若签名也变则叠加 `interface`，`lib/graph-diff.js:523`）。
4. **补登记**：剩余 `added` / `deleted` 各补一条 record，含各自的 `unifiedBodyDiff`（`lib/graph-diff.js:526-561`）。
5. **输出**：`diffGraphs` 返回含 `added/deleted/interface/body/edge/renamed/records` 的 GraphDiff 对象；`serializeDiff` 把它转成稳定排序的数组/对象（`lib/graph-diff.js:567-578`）。

下游消费方（`lib/incremental.js`、`lib/update-planner.js`）在判定层再加「纯注释/排版降级」——即 `bodyHash` 变了但 `codeHash` 没变的 `body` 类组件视为无实质变化（`lib/incremental.js:154-169`、`lib/update-planner.js:57-81`）。这一降级**不动** `diffGraphs`（它必须与上游逐位对齐、有 golden 对拍），只在其外层过滤。

对拍数据流（保证移植正确性）：`test-fixtures/gen-graphdiff-golden.py` 用 Python 原生 `difflib`/`hashlib` 喂同一批输入产出 `test-fixtures/graphdiff-golden.json`（`similarity` / `hash` / `unified` 三类用例，`gen-graphdiff-golden.py:52-142`）；`test-graphdiff.mjs` 读该 JSON，对 `bodySimilarity` / `bodyHash` / `unifiedDiff` 逐项比对（容差 `1e-12`，`test-graphdiff.mjs:28-42`），并通过手写 `oldG`/`newG` 两套图验证 `diffGraphs` 的 interface/body/edge 分类与改名配对（`test-graphdiff.mjs:58-94`）。

## Connections

- [[incremental]]（`lib/incremental.js`）——本模块的主力消费者之一。`filterStaleTasks`（`lib/incremental.js:140-194`）直接调 `diffGraphs`/`changedIds`/`graphDiffCounts`，并把结果按文章 `source_files` 过滤（`keep`/`dropped`）；`slimGraph`/`graphFromSnapshot`（`lib/incremental.js:37-88`）负责把快照回读的节点（带固化 `bodyHash`/`codeHash`）喂给 `bodyHash`/`codeHash` 的缓存分支。注意纯注释降级在 `lib/incremental.js:154-169` 完成，不在 `diffGraphs` 内。
- [[update-planner]]（`lib/update-planner.js`）——另一主力消费者。`planUpdate`（`lib/update-planner.js:156-436`）在符号级路径下调 `diffGraphs`+`graphDiffCounts`（`lib/update-planner.js:186-191`），并用 `realChangedIds`（`lib/update-planner.js:57-81`，同样调 `changedIds`/`codeHash` 做注释降级）与 `dependentsOf` 做反向依赖闭包，把组件级变更升级成「每篇文章 write/keep/delete/review 的 action + reason」。
- [[change-set]]（`lib/change-set.js`）——提供文件级变更集（committed/staged/unstaged/untracked + `-M` 改名检测，`lib/change-set.js:139-205`）。`graphDiffs` 的「内容级」判定与 `change-set` 的「文件级」采集是互补的两层：`fileLevel` 退化时（`lib/update-planner.js:179` 无 old/new 图）planner 退化为只认 `change-set` 的文件变化。
- [[symbols]]（`lib/symbols.js`）——`update-planner.js:20` 的 `SUPPORTED_EXTS` 来自此模块，用于区分源码/非源码文件（影响 unmapped 变更的「全量重编」判定）。符号抽取产出的 `node` 形状（`id/name/kind/relativePath/...`）正是本模块 `diffGraphs` 的输入。
- [[engine-output]]（`lib/engine/output.js`）——阶段 2 产物校验，明确「不做图 diff」（见 `lib/engine/output.js:8-12` 的边界声明），与本模块职责互补：图 diff 发生在增量判定阶段，不在 FSoft 产物解析阶段。

## Known Issues

- **纯注释改动默认仍会触发 `body` 分类**：`diffGraphs` 里只要是 `bodyHash` 变了就归 `CLASS_BODY`（`lib/graph-diff.js:471-473`），而 `bodyHash` 覆盖整段源码文本（含注释），注释被改一下它就会变。这是上游 Python `normalize_body` 的粒度本身不区分注释。因此在 `lib/incremental.js:154-169` 与 `lib/update-planner.js:57-81` 的**判定层**额外加了一道「`codeHash` 没变且 docstring 没变则降级」的过滤，`diffGraphs` 本身不动（要保持与上游逐位对齐、有 golden 对拍）。`lib/graph-diff.js:64-68`、`lib/graph-diff.js:447-452`、`lib/incremental.js:146-153` 注释说明了这一取舍。
- **`stripComments` 对字符串内的 `//` 会误判为注释**（`lib/graph-diff.js:69-71`）：字符串里的 `//` 会被一并剥掉，导致 `codeHash` 变小概率碰撞。这是可接受的近似——引入真正词法分析要带语言参数、会复杂化这条纯逻辑路径，不划算。
- **`#` 行内注释剥离的边界**：`stripTrailingComment` 仅在 `#` 前是行首或空白时才当注释（`lib/graph-diff.js:43-45`），以避免吃掉 C 预处理 / JS 私有字段（`#field`），但行首注释表 `LINE_COMMENT_MARKS` 含 `--`/`;`/`%`，这些**只**对行首生效（`lib/graph-diff.js:34-35`、`37-39`），行内不做剥离（避免吃掉 `a--b`、分号结尾、取模等真代码）。
- **改名检测依赖 body 相似度、且按 `kind` 分组**（`lib/graph-diff.js:384`、`392-393`）：只有同类 `kind` 的 deleted/added 才会配对，`tauRen` 默认 `0.8`；若一次改名同时改了 `kind`（极罕见），或相似度低于阈值，则不会识别为 renamed，而退化为「一次 deleted + 一次 added」。长度差太大的组合会被快速跳过（`lib/graph-diff.js:388-391`）。
- **`unifiedDiff` 是完整移植但只产文本**：`unifiedDiff`（`lib/graph-diff.js:327-355`）返回已 join 的字符串，不返回行数组；`label` 固定 `a/`、`b/` 前缀由调用方（`unifiedBodyDiff`，`lib/graph-diff.js:358`）拼好。测试侧自己实现了 `splitKeepEnds`（`test-graphdiff.mjs:23-26`）与 `graph-diff.js` 内部同名函数（`lib/graph-diff.js:263-269`）保持一致，用于把 golden 的 `oldText` 切成行再喂入。
- **节点记录形状为隐式 contract**：`records` 里每条 record 的字段在 `diffGraphs` 内多处构造（`lib/graph-diff.js:447-461`、`506-520`、`528-542`、`546-560`），并非来自一个共享工厂函数，多处分支需手动保持字段一致；下游消费方（如 `serializeDiff`）依赖这些字段齐全。改动分类逻辑时容易漏填某个分支的字段。
- **`graphdiff-golden.json` 必须先用 Python 生成**：`test-graphdiff.mjs:14-17` 在基准文件缺失时直接 `process.exit(1)`，开发机需先跑 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`（当前已生成，见 `test-fixtures/graphdiff-golden.json` 第 1 行起的 499 行用例）。该文件无禁用/注释代码，全量生效。
