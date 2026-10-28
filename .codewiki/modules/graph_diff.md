---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - lib/symbols.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/article-contract.js
  - lib/engine/quality-gate.js
tags: [diff, incremental, symbol-graph, hash, unified-diff, rename-detection]
---

## Overview

`lib/graph-diff.js` 是符号级增量 diff 的核心算法库：它接收两份「组件图」（`Map<componentId, node>`，节点形状由 `lib/symbols.js` 提取、由 `lib/incremental.js` 瘦身快照），逐组件比较，产出「哪些组件真的变了、变的是签名还是实现、哪个删除对应哪个新增 = 改名」，并为每个实质变化的组件生成一段 unified body diff。

它移植自 FSoft-AI4Code/CodeWiki 的 `codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现），见文件头注释 `lib/graph-diff.js:1-10`。移植而非调用的原因（`lib/graph-diff.js:4-6`）：上游那些最值钱的判定全是纯标准库算法（`hashlib`/`difflib`/`re`），零 ML 依赖，逐位移植后本插件保持纯 Node、零外部运行时，判定精度与上游一致。

核心能力分为四块：

- **代码归一与哈希**：`stripComments`（`lib/graph-diff.js:69`）剥掉注释与排版差异，`codeHash`（`lib/graph-diff.js:108`）只看代码本体，`bodyHash`（`lib/graph-diff.js:121`）连 docstring 一起哈希——区分「只改了注释」与「代码有实质变化」。
- **difflib 移植**：`SequenceMatcher` 的匹配块算法（`getMatchingBlocks` `lib/graph-diff.js:191`、`findLongestMatch` `lib/graph-diff.js:166`）与 `ratio`（`sequenceRatio` `lib/graph-diff.js:229`、`bodySimilarity` `lib/graph-diff.js:239`）、`unified_diff`（`unifiedDiff` `lib/graph-diff.js:327`、`unifiedBodyDiff` `lib/graph-diff.js:358`）完整逐位移植，有 Python golden 对拍（`test-fixtures/graphdiff-golden.json`）。
- **改名配对**：`pairRenames`（`lib/graph-diff.js:371`）按 body 相似度贪心最佳匹配，把「删除 + 新增」近似成「改名」。
- **主入口**：`diffGraphs`（`lib/graph-diff.js:447`）把以上拼成组件级变更集，分类为 `added` / `deleted` / `interface` / `body` / `edge` / `renamed`，并附带每条 `records`。

组件 id 约定与上游相同：`<相对路径>#<符号名>`（上游是 `path::name`，用 `#` 是为避开 Windows 盘符里的 `:`），见 `lib/graph-diff.js:8-9`。Node 记录形状：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（见 `lib/graph-diff.js:10`）。

## Key Components

### 导出的常量（分类标签 / 配置 / 标记）

- `CLASS_ADDED = 'added'`（`lib/graph-diff.js:14`）—— 仅在新增图中出现的组件。
- `CLASS_DELETED = 'deleted'`（`lib/graph-diff.js:15`）—— 仅在旧图中出现的组件。
- `CLASS_IFACE = 'interface'`（`lib/graph-diff.js:16`）—— 签名变化（参数 / 基类 / 名字）。
- `CLASS_BODY = 'body'`（`lib/graph-diff.js:17`）—— 实现变化（body 哈希变，签名没变）。
- `CLASS_EDGE = 'edge'`（`lib/graph-diff.js:18`）—— 仅依赖边变化。
- `CLASS_RENAMED = 'renamed'`（`lib/graph-diff.js:19`）—— 删除 + 新增经相似度配对成的改名。
- `DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'`（`lib/graph-diff.js:251`）—— `truncateToTokens` 截断处插入的标记。
- `DEFAULT_TAU_REN = 0.8`（`lib/graph-diff.js:368`）—— 改名配对相似度阈值（默认）。
- `DEFAULT_MAX_DIFF_TOKENS = 2000`（`lib/graph-diff.js:369`）—— body diff 截断后的最大 token 数（默认）。

### 模块级正则

- `WS = /\s+/gu`（`lib/graph-diff.js:23`）—— 空白归一。
- `TOKEN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu`（`lib/graph-diff.js:26`）—— Unicode 感知的 tokenizer；注释说明 JS 的 `\w` 只有 `[A-Za-z0-9_]` 会让中文按字切碎、相似度偏高，故用 Unicode 属性类还原 Python 语义（`lib/graph-diff.js:24-25`）。

### 注释剥离相关

- `LINE_COMMENT_MARKS = ['//', '///', '#', '--', ';', '%']`（`lib/graph-diff.js:35`）
- `BLOCK_COMMENT_PAIRS = [['/*', '*/'], ['<!--', '-->'], ['"""', '"""'], ["'''", "'''"]]`（`lib/graph-diff.js:36`）
- `TRAILING_COMMENT_MARKS = ['//', '#']`（`lib/graph-diff.js:39`）
- `stripTrailingComment(line)`（`lib/graph-diff.js:43`）—— 剥掉一行里引号外的行尾注释（只认 `//` 与 `#` 行内剥离；`#` 仅当行首或前为空白时才算注释，避免吃到 C 预处理 / JS 私有字段）。`"http://x"` 不被误判。
- `stripComments(text)`（`lib/graph-diff.js:69`，**导出**）—— 逐行扫、跟踪块注释状态，去掉注释与纯装饰空白；用于区分「只改了注释/排版」与「代码有实质变化」。字符串里的 `//` 会被近似误判为注释（可接受，见 `lib/graph-diff.js:64-68`）。

### 归一与哈希

- `normalizeBody(text)`（`lib/graph-diff.js:28`，**导出**）—— 去空、把空白压成单个空格。
- `codeHash(node)`（`lib/graph-diff.js:108`，**导出**）—— 不含注释/排版的代码本体 sha1；若节点已带固化 `codeHash` 且无源码则直接返回（`lib/graph-diff.js:109`）。用于「只改注释」降级判定。
- `documentedSource(node)`（`lib/graph-diff.js:114`，**导出**）—— 源码 + docstring；Rust 的 `///` 在 `sourceCode` 之外，不带上就看不出「只改了文档」。
- `bodyHash(node)`（`lib/graph-diff.js:121`，**导出**）—— 对 `normalizeBody(documentedSource(node))` 取 sha1；若节点无源码但带固化 `bodyHash` 则直接返回（`lib/graph-diff.js:28`）。快照回读节点走这条缓存分支，避免把源码读回来重算。
- `signature(node)`（`lib/graph-diff.js:128`，**导出**）—— 抽取 `{ name, parameters, baseClasses }`，用于签名比较。
- `signatureChanged(a, b)`（`lib/graph-diff.js:136`，**导出**）—— 逐字段比较签名，任一不同即返回 `true`。

### difflib 移植（token 序列相似度 / unified diff）

- `tokens(text)`（`lib/graph-diff.js:147`）—— 用 `TOKEN` 正则切分。
- `buildB2J(b)`（`lib/graph-diff.js:156`）—— 构造值→下标列表的映射（SequenceMatcher 内部）。
- `findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)`（`lib/graph-diff.js:166`）—— 最长公共子序列匹配块（autojunk=False 语义）。
- `getMatchingBlocks(a, b)`（`lib/graph-diff.js:191`）—— 队列式递归求匹配块并归并相邻块，与 Python difflib 完全一致。
- `sequenceRatio(aArr, bArr)`（`lib/graph-diff.js:229`，**导出**）—— `(2.0 * matches) / total`，区间 `[0,1]`。
- `bodySimilarity(a, b)`（`lib/graph-diff.js:239`，**导出**）—— token 序列的 difflib ratio；空/空返回 1.0，单边空返回 0.0。
- `approxTokens(text)`（`lib/graph-diff.js:247`，**导出**）—— 按 `length/4 + 1` 估算 token 数。
- `truncateToTokens(text, maxTokens)`（`lib/graph-diff.js:251`，**导出**）—— 超过预算则保留头尾各一半并插入 `DIFF_TRUNCATED_MARKER`（`lib/graph-diff.js:21`）。
- `splitKeepEnds(text)`（`lib/graph-diff.js:263`）—— 模拟 Python `splitlines(keepends=True)`。
- `getOpcodes(a, b)`（`lib/graph-diff.js:271`）—— 由匹配块生成 `replace/delete/insert/equal` opcode。
- `getGroupedOpcodes(a, b, n)`（`lib/graph-diff.js:289`）—— 按 n 行上下文分组 opcode（每组长匹配块之间截断）。
- `rangeUnified(start, stop)`（`lib/graph-diff.js:319`）—— 把区间渲染成 unified diff 的 `@@` 行号格式。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n=3, lineterm='\n')`（`lib/graph-diff.js:327`，**导出**）—— difflib `unified_diff` 逐位移植；`---`/`+++` header 只输出一次，`@@` 头每个 group 都有（`lib/graph-diff.js:260-266`）。
- `unifiedBodyDiff(oldNode, newNode, label)`（`lib/graph-diff.js:358`，**导出**）—— 用 `documentedSource` 取两节点源码切片，调 `unifiedDiff` 生成上下文 2 行的 body diff，label 用 `a/<label>`、`b/<label>`。

### 改名配对

- `pairRenames(deleted, added, oldGraph, newGraph, tauRen=DEFAULT_TAU_REN)`（`lib/graph-diff.js:371`，**导出**）—— 按 kind 把新增分组（`lib/graph-diff.js:373-378`），对每对 (oldId, newId) 先用长度比快速剪枝（`lib/graph-diff.js:391-392`，够不到 `tauRen*0.9` 直接跳过），再用 `bodySimilarity` 求相似度；按相似度降序贪心配对，返回 `[[oldId, newId, sim], ...]`（`lib/graph-diff.js:396-406`）。`deleted`/`added` 任一为空直接返回 `[]`（`lib/graph-diff.js:372`）。

### 主入口与结果结构

- `emptyGraphDiff()`（`lib/graph-diff.js:413`，**导出**）—— 返回空的 diff 结果壳：

  ```
  {
    added: Set, deleted: Set, interface: Set, body: Set, edge: Set,
    renamed: Map,   // oldId -> newId
    records: Map,   // componentId -> record
  }
  ```

- `graphDiffCounts(d)`（`lib/graph-diff.js:425`，**导出**）—— 把各 Set/Map 的 `size` 汇总成 `{ added, deleted, interface, body, edge, renamed }`。
- `changedIds(d)`（`lib/graph-diff.js:436`，**导出**）—— 所有变更 id 的并集（含 renamed 的 newId）。
- `isDiffEmpty(d)`（`lib/graph-diff.js:442`，**导出**）—— `changedIds(d).size === 0`。
- `diffGraphs(oldGraph, newGraph, opts={})`（`lib/graph-diff.js:447`，**导出**）—— 主入口，详见 Data Flow。

每条 `records` entry 的字段（由 `diffGraphs` 构造，见 `lib/graph-diff.js:480-497`、`506-520`、`528-542`、`546-560`）：

| 字段 | 含义 |
|------|------|
| `componentId` | 组件 id（renamed 时是 newId） |
| `changeClass` | 上述 `CLASS_*` 之一 |
| `oldId` / `newId` | 旧/新 id（added 的 oldId 为 `null`，deleted 的 newId 为 `null`） |
| `relativePath` | 取自新节点（或旧节点）的 `relativePath` |
| `componentType` | `kind` |
| `oldSignature` / `newSignature` | `signature()` 结果（缺失侧为 `null`/`null`） |
| `similarity` | 仅 renamed 有值，其余 `null`，保留 4 位小数（`Math.round(sim*10000)/10000` `lib/graph-diff.js:515`） |
| `signatureChanged` | `signatureChanged(o, n)` 的布尔值 |
| `edgesAdded` / `edgesRemoved` | `dependsOn` 的差集，已排序（`lib/graph-diff.js:478-479`） |
| `diff` | 截断后的 `unifiedBodyDiff` 字符串；非 body/renamed 变化组件为空串 |

- `serializeDiff(d)`（`lib/graph-diff.js:567`，**导出**）—— 把 Set/Map 转数组（按 id 排序、`renamed` 转对象），产出可 JSON 化的 `{ counts, added, deleted, interface, body, edge, renamed, records }`，便于落盘与对拍。

## Architecture

`graph-diff` 是纯算法模块，内部由「归一/哈希 → difflib 移植 → 改名配对 → 汇总」四层串成。`diffGraphs` 把 `oldGraph`/`newGraph` 两个 `Map` 喂进去，逐组件分类、递归配对改名、构造 `records`。

```text
            oldGraph Map ──┐
                           ├──► diffGraphs (447)
            newGraph Map ──┘        │
                                   ├─► 哈希/签名比对 ── codeHash/bodyHash/signatureChanged
                                   │   (108/121/136)
                                   ├─► pairRenames ──► bodySimilarity (239)
                                   │   (371)            + SequenceMatcher (191/229)
                                   │
                                   ▼
                          emptyGraphDiff 结构 (413)
                          ┌──────────────────────────────────┐
                          │ added/deleted/interface/body/edge │
                          │ renamed: oldId->newId            │
                          │ records: id -> { changeClass,    │
                          │   oldSig/newSig, edges±, diff }  │
                          └──────────────────────────────────┘
                                   │
                  unifiedBodyDiff (358) ──► unifiedDiff (327) ──► truncateToTokens (251)
                                   │
                                   ▼
                          serializeDiff (567) ──► JSON 落盘 / 对拍

  注释剥离: stripComments (69) ← LINE/BLOCK/TRAILING_COMMENT_MARKS (35-39)
  哈希:     codeHash (108) / bodyHash (121) ← documentedSource (114)/normalizeBody (28)
```

下游消费方（Connections 一节详述）：`lib/incremental.js` 的 `filterStaleTasks` 与 `lib/update-planner.js` 的 `planUpdate` 都先调 `diffGraphs`，再用 `changedIds`/`graphDiffCounts` 做判定与统计。

## Data Flow

`diffGraphs(oldGraph, newGraph, opts)`（`lib/graph-diff.js:447`）的完整流程：

1. **参数解析**：`tauRen = opts.tauRen ?? DEFAULT_TAU_REN`、`maxDiffTokens = opts.maxDiffTokens ?? DEFAULT_MAX_DIFF_TOKENS`（`lib/graph-diff.js:413-414`）；`emptyGraphDiff()` 起壳（`lib/graph-diff.js:450`）。
2. **id 全集对比**：`newIds` 中不在 `oldIds` 的进 `added`，`oldIds` 中不在 `newIds` 的进 `deleted`（`lib/graph-diff.js:454-455`）。
3. **共现组件分类**（`lib/graph-diff.js:457-497`）：对 `oldIds` 与 `newIds` 都有的 `cid`：
   - 算 `sigChanged = signatureChanged(o, n)`、 `hashChanged = bodyHash(o) !== bodyHash(n)`、依赖边差集 `edgesChanged`（`lib/graph-diff.js:461-465`）。
   - 三者都不变则 `continue`（`lib/graph-diff.js:466`）。
   - 优先级：`sigChanged` → `interface`；否则 `hashChanged` → `body`；否则 `edge`（`lib/graph-diff.js:468-477`）。
   - 构造 `rec`，`edgesAdded`/`edgesRemoved` 是 `dependsOn` 有序差集（`lib/graph-diff.js:478-479`）；若 `hashChanged` 则 `rec.diff = truncateToTokens(unifiedBodyDiff(o, n, cid), maxDiffTokens)`（`lib/graph-diff.js:495`）。
4. **改名配对**（`lib/graph-diff.js:499-524`）：用 `pairRenames(result.deleted, result.added, oldGraph, newGraph, tauRen)` 得到 `[[oldId, newId, sim], ...]`；逐个把 `oldId` 从 `deleted` 删、`newId` 从 `added` 删，写入 `renamed.set(oldId, newId)`（`lib/graph-diff.js:500-502`），构造 `CLASS_RENAMED` 的 `rec`，`similarity` 保留 4 位小数（`lib/graph-diff.js:515`）；若 `signatureChanged` 则同时把 `newId` 加进 `interface`（`lib/graph-diff.js:523`）。
5. **补充 added/deleted 记录**（`lib/graph-diff.js:526-561`）：给每个剩余 `added` 构造 `CLASS_ADDED` 的 `rec`（`oldSignature` 为 `null`，`edgesAdded` 为 `dependsOn` 去重排序，`diff` 为 `unifiedBodyDiff(null, n, cid)`）；给每个剩余 `deleted` 构造 `CLASS_DELETED` 的 `rec`（`newSignature` 为 `null`，`edgesRemoved` 为旧 `dependsOn`，`diff` 为 `unifiedBodyDiff(o, null, cid)`）。
6. **返回** `result`（`lib/graph-diff.js:563`）。

调用方通常再调一次 `serializeDiff(result)`（`lib/graph-diff.js:567`）转成可 JSON 结构用于落盘或测试对拍（见 `test-graphdiff.mjs:83-84`）。

**节点形状契约**（与 `lib/symbols.js:13-14` 一致）：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`。注意快照回读节点（经 `lib/incremental.js:69` 的 `graphFromSnapshot`）`sourceCode`/`docstring` 为空、`bodyHash`/`codeHash` 已固化——这时 `codeHash`（`lib/graph-diff.js:109`）和 `bodyHash`（`lib/graph-diff.js:124`）直接走缓存分支，不重算。这也是 `SLIM_FIELDS`（`lib/incremental.js:26`）刻意保留哈希字段的原因。

## Connections

- [[incremental]] —— 本模块的直接上游消费者。`lib/incremental.js:140` 导入 `diffGraphs, changedIds, graphDiffCounts, bodyHash, codeHash`；`filterStaleTasks`（`lib/incremental.js:140-194`）调 `diffGraphs` 后，用 `codeHash` 在判定层做「纯注释/排版改动降级」（只降级 `body` 类，见 `lib/incremental.js:146-169`），并把 `change`/`counts`/`cosmeticOnly` 一并透传给调用方。同一文件还负责图快照的瘦身存取（`slimGraph`/`graphFromSnapshot`，`lib/incremental.js:37-88`），决定了节点回读时 `bodyHash`/`codeHash` 已固化这一前提。
- [[update-planner]] —— 另一个消费者。`lib/update-planner.js:156` 导入 `diffGraphs, changedIds, graphDiffCounts, codeHash`；`planUpdate`（`lib/update-planner.js:186`）在非 fileLevel 时调 `diffGraphs`（`lib/update-planner.js:57`），并经 `realChangedIds`（`lib/update-planner.js:180`）按 `diff.body` 再走一遍 `codeHash` 降级，区分 `real`/`cosmetic`/`structural`（`lib/update-planner.js:73-80`），最终驱动 write/keep/delete/review 四类 action 与反向依赖闭包（`lib/update-planner.js:181-191`）。
- [[symbols]] —— 节点形状与 id 约定的来源。组件 id `<相对路径>#<符号名>` 与节点字段 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }` 在 `lib/symbols.js:10-14` 声明，与本文模块严格对齐（上游是 `path::name`）。
- [[article-contract]] / [[engine-quality-gate]] —— 下游不直接依赖 graph-diff，但 `diffGraphs` 产出的 `records.diff`（unified body diff）最终会作为「这次改了几处、为什么」的上下文进入文章写作；quality-gate（`lib/engine/quality-gate.js`）负责采用门，本模块不参与该阶段。
- 测试与对拍基准：[[test-graphdiff]]（即 `test-graphdiff.mjs`）与 `test-fixtures/gen-graphdiff-golden.py` + `test-fixtures/graphdiff-golden.json`。golden 用 Python 原生 `difflib`/`hashlib` 生成期望值（相似度、哈希、unified diff 三类用例，`gen-graphdiff-golden.py:31-123`），Node 侧逐项比对（容忍 `1e-12`，`test-graphdiff.mjs:2`），保证移植逐位一致。

## Known Issues

- **字符串内 `//` 被近似误判为注释**：`stripComments`（`lib/graph-diff.js:69-73`、`69-100`）不区分字符串字面量里的 `//`，会把它连同后续内容一并剥掉。作者明确注释这是「可接受的近似」——最坏情况是让某行看着像注释的代码被剥掉，使 `codeHash` 更小概率碰撞；引入真词法分析需带语言参数、会复杂化这条纯逻辑路径，故未做。影响范围：纯注释降级判定在极个别含 `//` 字符串的代码上可能误判。

- **`#`/`;`/`%`/`--` 不做行内剥离**：`TRAILING_COMMENT_MARKS` 只含 `//` 和 `#`（`lib/graph-diff.js:39`），且 `#` 仅当行首或前为空白才算注释（`lib/graph-diff.js:35`），原因见 `lib/graph-diff.js:37-38`——这些符号在表达式里太常见（`a--b`、分号结尾、取模），剥离会吃掉真代码。反之 `--`/`;`/`%` 只在行首生效（`LINE_COMMENT_MARKS`，`lib/graph-diff.js:35`、`93-94`）。

- **`bodyHash` 不区分注释、需判定层降级**：`bodyHash`（`lib/graph-diff.js:121`）覆盖整段源码文本，注释被改一下它就变，于是文章会被无条件重写。作者确认这不是移植错（上游 Python `normalize_body` 也只做空白归一，`lib/incremental.js:147-149`）。因此「纯注释改动降级」是在判定层（`filterStaleTasks`/`realChangedIds`）用 `codeHash` 补一道（`lib/incremental.js:155-169`、`lib/update-planner.js:60-72`），本模块刻意保持与上游逐位对齐、不在此修改。

- **`TOKEN` 用 Unicode 近似 Python `\w`**：`TOKEN`（`lib/graph-diff.js:26`）用 `[\p{L}\p{N}_]` 还原 Python 的 Unicode 感知 `\w`，否则中文会被按字切碎、相似度整体偏高（`lib/graph-diff.js:24-25`）。这是语义对齐上的有意为之，不是 bug，但意味着非字母数字符号的切分粒度与 Python `\w` 在数学符号（如 `\p{N}` 是否含下角标等）上可能存在细微差异。

- **改名配对是贪心近似，非全局最优**：`pairRenames`（`lib/graph-diff.js:371-407`）按相似度降序贪心配对，先到先得（`usedOld`/`usedNew` 去重，`lib/graph-diff.js:397-405`）；同一旧组件若与多个新组件都高相似，只能配一个。长度差太大（够不到 `tauRen*0.9`）直接剪枝（`lib/graph-diff.js:397-398`），所以「大幅改动但语义等同」的改名可能漏配、退化成独立的 added + deleted。

- **无功能禁用/注释关闭项**：本模块全部导出均处于启用状态，未发现有被 `//` 整块注释关闭或受 `disabled` 标志控制的代码（已通读 `lib/graph-diff.js` 全部 578 行）。

- **`documentedSource` 的 docstring 前缀不幂等**：当 `doc` 已作为子串出现在 `code` 中时，`documentedSource`（`lib/graph-diff.js:114-119`）不会前缀 docstring（`lib/graph-diff.js:117` 的 `!code.includes(doc)` 判断），否则会重复。这意味着「docstring 恰好等于源码子串」的节点，`bodyHash` 与「docstring 独立」的节点可能不同——属边界情形，未特殊处理。

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



## Known Issues

- **注释剥离是近似，非真词法分析**：`stripComments`（`lib/graph-diff.js:69-100`）不做真正的多语言词法解析，字符串里的 `//` 会被误判为注释（见 `lib/graph-diff.js:64-68` 注释说明）。这是有意为之的取舍——误判只会让「看起来像注释」的代码被一并剥掉，导致 `codeHash` 更小概率碰撞；若引入真词法分析需带语言参数，会把这条纯逻辑路径复杂化。
- **`bodyHash` 不区分注释**：`bodyHash`（`lib/graph-diff.js:121-126`）覆盖整段源码文本，只做空白归一（与上游 `normalize_body` 一致），因此「只改了注释」也会让它变。真正过滤掉纯注释改动的是**判定层**（`lib/incremental.js:148-164` / `lib/update-planner.js:57-81`）用 `codeHash` 做的降级，而非 `diffGraphs` 本身——这是刻意分层：保持 `diffGraphs` 与上游逐位对齐以便 golden 对拍。
- **改名配对对同 kind 强约束**：`pairRenames`（`lib/graph-diff.js:371-407`）只在相同 `kind` 的 deleted×added 之间配对；跨 kind 的删除+新增不会被识别为改名。
- **长度剪枝阈值**：`lib/graph-diff.js:391` 用 `ratio < tauRen * 0.9` 提前剪枝跳过长度差太大的候选，是性能优化而非语义裁剪——最终仍以 `sim >= tauRen`（`lib/graph-diff.js:393`）为准。
- **无功能禁用/注释掉的代码**：通读 `lib/graph-diff.js` 全文件，没有发现被注释掉或被禁用的函数；所有导出函数（14 起常量与本文件函数）均处于启用状态。
