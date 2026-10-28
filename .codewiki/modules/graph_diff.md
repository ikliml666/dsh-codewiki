---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - lib/update-planner.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-record.js
  - lib/cluster.js
tags: [graph-diff, incremental, diff, similarity, rename-detection]
---

## Overview

`lib/graph-diff.js` 是**符号级增量 diff 的核心算法库**：它把一个代码仓库抽象成「符号图」（`Map<id, node>`，节点 = 函数/类/方法，边 = `dependsOn`），并逐位移植自 FSoft-AI4Code/CodeWiki 的 `codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现），见文件头注释 `lib/graph-diff.js:1-11`。

之所以移植而不是调用上游：上游最有价值的判断（哪些组件真的变了、变的是「签名」还是「实现」、哪个删除对应哪个新增＝改名）全部是纯标准库算法（`hashlib`/`difflib`/`re`），零 ML 依赖。逐位移植后本插件保持纯 Node、零外部运行时，判定精度与上游一致（见 `lib/graph-diff.js:4-6`）。

模块对外提供四类能力：

1. **归一化 / 哈希**：`normalizeBody`、`stripComments`、`codeHash`、`documentedSource`、`bodyHash` —— 区分「只改了注释/排版」与「代码有实质变化」。
2. **相似度 / diff**：`bodySimilarity`（基于移植版 `difflib.SequenceMatcher` 的 token ratio）、`unifiedDiff` / `unifiedBodyDiff`（移植版 `difflib.unified_diff`）。
3. **改名配对**：`pairRenames` —— 按 body 相似度贪心匹配「删除 + 新增」对，识别重命名。
4. **图级 diff 与序列化**：`diffGraphs`（主入口）把两份图比对成 `added/deleted/interface/body/edge/renamed` 五类变更，并产出每条变更的 `records`；`serializeDiff` 把 `Set`/`Map` 落盘为可机读 JSON。

组件 id 约定与上游同构：`<相对路径>#<符号名>`（上游用 `::`，这里用 `#` 避免与 Windows 盘符的 `:` 混淆），见 `lib/graph-diff.js:8-9`。Node 记录形状为 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`，见 `lib/graph-diff.js:10` 与 `lib/symbols.js:13-14`。

## Key Components

### 常量

- `CLASS_ADDED = 'added'`（`lib/graph-diff.js:14`）—— 新增组件分类。
- `CLASS_DELETED = 'deleted'`（`lib/graph-diff.js:15`）—— 删除组件分类。
- `CLASS_IFACE = 'interface'`（`lib/graph-diff.js:16`）—— 签名变更（interface）分类。
- `CLASS_BODY = 'body'`（`lib/graph-diff.js:17`）—— 仅实现/正文变更分类。
- `CLASS_EDGE = 'edge'`（`lib/graph-diff.js:18`）—— 仅依赖边变更分类。
- `CLASS_RENAMED = 'renamed'`（`lib/graph-diff.js:19`）—— 重命名分类。
- `DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'`（`lib/graph-diff.js:21`）—— 超长 diff 被截断时插入的标记串。
- `DEFAULT_TAU_REN = 0.8`（`lib/graph-diff.js:368`）—— 改名判定的相似度阈值（默认值）。
- `DEFAULT_MAX_DIFF_TOKENS = 2000`（`lib/graph-diff.js:369`）—— 单条 body diff 的最大 token 数（默认值），超出会截断。

### 词法 / 归一化工具

- `WS = /\s+/gu`（`lib/graph-diff.js:23`）—— 空白正则。
- `TOKEN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu`（`lib/graph-diff.js:26`）—— Unicode 感知的 token 切分正则。注释 `lib/graph-diff.js:24-25` 说明：Python 的 `\w` 是 Unicode 感知的（中文算一个 token），JS 的 `\w` 只有 `[A-Za-z0-9_]`，直接用会让中文按字切碎、相似度整体偏高，故用 Unicode 属性类还原 Python 语义。
- `normalizeBody(text)`（`lib/graph-diff.js:28-30`）—— 去首尾空白、压缩内部连续空白为单空格；`null`/`undefined` 当空串处理。
- `LINE_COMMENT_MARKS = ['//', '///', '#', '--', ';', '%']`（`lib/graph-diff.js:36`）/`BLOCK_COMMENT_PAIRS`（`` `lib/graph-diff.js:36` ``）/ `TRAILING_COMMENT_MARKS = ['//', '#']`（`lib/graph-diff.js:39`）—— 注释剥离用的多语言标记表；注释 `lib/graph-diff.js:32-39` 解释了顺序讲究（`--` 会误伤 C 的 `a--`，`#` 会误伤预处理，故行内剥离只认 `//` 与 `#`）。
- `stripTrailingComment(line)`（`lib/graph-diff.js:43-62`）—— 去掉一行里位于引号外的行尾注释，跟踪 `' " ` 三种引号与反斜杠转义；`#` 只在行首或前为空白时才算注释（`lib/graph-diff.js:56`）以免误吃 C 预处理与 JS 私有字段。
- `stripComments(text)`（`lib/graph-diff.js:69-100`）—— 去掉注释与纯装饰空白，只留代码本体；逐行扫并跟踪块注释状态。用途是区分「只改了注释/排版」与「代码有实质变化」（前者不应触发文章重写），见 `lib/graph-diff.js:64-68`。

### 哈希 / 文档化源码

- `codeHash(node)`（`lib/graph-diff.js:108-111`）—— 对「剥掉注释后的源码」算 SHA1。「代码本体」哈希：只改注释 `codeHash` 不变、改代码才变。若节点没有 `sourceCode` 但带固化 `codeHash` 则直接返回固化值（`lib/graph-diff.js:109`）。判定层用它做纯注释降级，见 `lib/graph-diff.js:102-107`。
- `documentedSource(node)`（`lib/graph-diff.js:114-119`）—— 返回「源码 + 文档注释」。Rust 的 `///` 在 `sourceCode` 之外，不带上就看不出「只改了文档」（docstring 改动应当重写）。若 `docstring` 已包含于 `sourceCode` 则不重复拼接（`lib/graph-diff.js:117`）。
- `bodyHash(node)`（`lib/graph-diff.js:121-126`）—— 对 `normalizeBody(documentedSource(node))` 算 SHA1。快照回读的节点不带源码（`.codewiki/` 要入库不能存全文），哈希已随快照固化，故「无源码但有固化 bodyHash」时走缓存分支（`lib/graph-diff.js:28-30`）。

### 签名比对

- `signature(node)`（`lib/graph-diff.js:128-134`）—— 抽取 `{ name, parameters, baseClasses }` 快照。
- `signatureChanged(a, b)`（`lib/graph-diff.js:136-145`）—— 逐一比对 name/parameters/baseClasses，任一不同即返回 `true`。

### difflib.SequenceMatcher 移植（body 相似度）

- `buildB2J(b)`（`lib/graph-diff.js:156-164`）—— 构建元素→下标列表的映射。
- `findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)`（`lib/graph-diff.js:166-189`）—— 在给定区间内找最长匹配块（autojunk 关闭，无 junk 元素）。
- `getMatchingBlocks(a, b)`（`lib/graph-diff.js:191-226`）—— 递归求所有匹配块并合并相邻块，逻辑与 Python `difflib` 完全一致（`lib/graph-diff.js:208`）。
- `tokens(text)`（`lib/graph-diff.js:147-149`）—— 用 `TOKEN` 正则切分 token，返回数组（空/空串返回 `[]`）。
- `sequenceRatio(aArr, bArr)`（`lib/graph-diff.js:229-236`）—— 移植版 `difflib.SequenceMatcher.ratio()`：匹配 token 数×2 / 总长，落在 `[0,1]`；两序列都空返回 `1.0`（`lib/graph-diff.js:388`）。
- `bodySimilarity(a, b)`（`lib/graph-diff.js:239-245`）—— 上游 `body_similarity`：token 序列的 difflib ratio。双空 `1.0`、单空 `0.0`。

### token 预算 / 截断

- `approxTokens(text)`（`lib/graph-diff.js:247-249`）—— 以「长度/4 + 1」粗估 token 数（与 4 字节预算对应）。
- `truncateToTokens(text, maxTokens)`（`lib/graph-diff.js:251-257`）—— 超出预算时保留头尾各一半并在中间插入 `DIFF_TRUNCATED_MARKER`。`maxTokens<=0` 或预算内不截断。

### difflib.unified_diff 移植

- `splitKeepEnds(text)`（`lib/graph-diff.js:263-269`）—— 模拟 Python `splitlines(keepends=True)`，保留末尾无换行的最后一行。
- `getOpcodes(a, b)`（`lib/graph-diff.js:271-287`）—— 由匹配块生成 `replace/delete/insert/equal` opcode。
- `getGroupedOpcodes(a, b, n)`（`lib/graph-diff.js:289-317`）—— 按上下文行数 `n` 分组的 opcode（含头部/尾部裁剪与超长 equal 截断）。
- `rangeUnified(start, stop)`（`lib/graph-diff.js:319-325`）—— 把区间换算成 unified diff 的 `start,len` 表示（单行/零长特殊处理）。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n = 3, lineterm = '\n')`（`lib/graph-diff.js:327-355`）—— 移植版 `difflib.unified_diff`：输出 `---/+++` 头、`@@` 区间头与 ` +/-` 行；header 只在首个 group 输出一次（`lib/graph-diff.js:260-264`）。
- `unifiedBodyDiff(oldNode, newNode, label)`（`lib/graph-diff.js:358-362`）—— 上游 `unified_body_diff`：拿 `documentedSource` 拆行，以整文件相对路径作 label，上下文固定 `n=2`。

### 改名配对

- `pairRenames(deleted, added, oldGraph, newGraph, tauRen = DEFAULT_TAU_REN)`（`lib/graph-diff.js:371-407`）—— 把「删除集合」与「新增集合」按 body 相似度贪心最佳匹配：先按 kind 分组（`lib/graph-diff.js:448-453`），再用长度比快筛排除够不到 `tauRen` 的对（`lib/graph-diff.js:388-391`），对满足 `sim >= tauRen` 的候选按相似度降序贪心配对（`lib/graph-diff.js:393-405`）。返回 `[[oldId, newId, sim], ...]`。

### 主入口 / 聚合 / 序列化

- `emptyGraphDiff()`（`lib/graph-diff.js:413-423`）—— 返回空 diff 结构：`{ added:Set, deleted:Set, interface:Set, body:Set, edge:Set, renamed:Map(oldId->newId), records:Map }`。
- `graphDiffCounts(d)`（`lib/graph-diff.js:425-434`）—— 统计各分类 `size`，返回 `{ added, deleted, interface, body, edge, renamed }`。
- `changedIds(d)`（`lib/graph-diff.js:436-440`）—— 合并上述所有 Set 及 `renamed` 的值，返回受影响 id 的 `Set`。
- `isDiffEmpty(d)`（`lib/graph-diff.js:442-444`）—— `changedIds(d).size === 0`。
- `diffGraphs(oldGraph, newGraph, opts = {})`（`lib/graph-diff.js:447-564`）—— **主入口**。详见下。
- `serializeDiff(d)`（`lib/graph-diff.js:567-578`）—— 把 `Set`/`Map` 转数组/对象便于落盘与对拍：`counts` + 各分类排序数组 + `renamed`（`Object.fromEntries` 排序）+ `records`（`Object.fromEntries` 排序）。

### `diffGraphs` 的返回数据结构

`diffGraphs` 返回的 diff 对象，其 `records` 中每条记录（`lib/graph-diff.js:447-461`、`506-520`、`528-542`、`546-561`）字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `componentId` | string | 该组件 id（renamed 时为 newId） |
| `changeClass` | string | 取值 `added`/`deleted`/`interface`/`body`/`edge`/`renamed` |
| `oldId` | string\|null | 旧 id（added 为 `null`） |
| `newId` | string\|null | 新 id（deleted 为 `null`） |
| `relativePath` | string\|null | 组件所在相对路径 |
| `componentType` | string\|null | 组件 kind（如 `function`/`class`） |
| `oldSignature` | object\|null | `signature(o)` 结果（added 为 `null`） |
| `newSignature` | object\|null | `signature(n)` 结果（deleted 为 `null`） |
| `similarity` | number\|null | renamed 时的相似度（四舍五入到万分之一）；其余为 `null` |
| `signatureChanged` | boolean | 签名是否变更 |
| `edgesAdded` | string[] | 新增依赖边（排序） |
| `edgesRemoved` | string[] | 移除依赖边（排序） |
| `diff` | string | body 变更的统一 diff，超出 `maxDiffTokens` 已截断；added/deleted 用单侧 diff，未变更类（`interface`/`edge`）留空 |

`diffGraphs` 的分类判定优先级（`lib/graph-diff.js:447-458`）：签名变 ⇒ `interface`；否则 `bodyHash` 变 ⇒ `body`；否则仅 `dependsOn` 边变 ⇒ `edge`。renamed 在配对后单独登记，若其签名也变了会额外加入 `interface`（`lib/graph-diff.js:523`）。

## Architecture

`graph_diff` 是纯函数库（无 IO），在增量编译链路里作为「图 → 变更集」的判定核心，被 `lib/update-planner.js` 与 `lib/incremental.js` 两类调用方消费。

```text
           oldGraph (Map<id,node>)                 newGraph (Map<id,node>)
                      │                                        │
                      └───────────────┬────────────────────────┘
                                      ▼
                            diffGraphs()  [lib/graph-diff.js:447]
                              ├─ 新增/删除 id 扫描        → added / deleted (Set)
                              ├─ signatureChanged()       → interface (Set)   [lib/graph-diff.js:136]
                              ├─ bodyHash() 变            → body (Set)       [lib/graph-diff.js:121]
                              ├─ dependsOn 边变           → edge (Set)       [lib/graph-diff.js:463-465]
                              ├─ pairRenames()            → renamed (Map)    [lib/graph-diff.js:371]
                              └─ 逐组件产 records (Map)                   [lib/graph-diff.js:480-561]
                                      │
                  ┌───────────────────┼───────────────────────────────┐
                  ▼                   ▼                               ▼
          changedIds()         graphDiffCounts()               serializeDiff()
          [lib/graph-diff.js:436]  [lib/graph-diff.js:425]        [lib/graph-diff.js:567]
                  │                   │                               │
                  └──────┬────────────┴───────────┬───────────────────┘
                         ▼                        ▼
        realChangedIds() / filterStaleTasks()   UpdatePlan (落盘)
        [lib/update-planner.js:57]  [lib/incremental.js:140]
```

关键职责切分：
- **哈希层** `codeHash` / `bodyHash` / `documentedSource`（`` `lib/graph-diff.js:108-126` ``）只负责「这串代码是否变了」，不关心为什么变。
- **分类层** `diffGraphs`（`lib/graph-diff.js:447`）把变化归到五类，并产出每条变更的 `records`（含截断后的统一 diff）。
- **消费方的降级**（纯注释改动放行）不写在本模块内，而在 `lib/update-planner.js:57` 的 `realChangedIds` 与 `lib/incremental.js:140` 的 `filterStaleTasks` 里做——因 `diffGraphs` 与上游逐位对齐、有 golden 对拍，不应被改，见 `lib/incremental.js:148-153`。

## Data Flow

1. **输入来源**：`oldGraph` / `newGraph` 都是 `Map<id, node>`，节点形状为 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`。新图通常来自 `lib/symbols.js` 的 AST 提取；旧图来自 `lib/incremental.js` 的快照回读 `graphFromSnapshot`（`lib/incremental.js:69-88`），快照里 `sourceCode`/`docstring` 为空、只带固化 `bodyHash`/`codeHash`，因此 `bodyHash`/`codeHash` 走缓存分支（`lib/graph-diff.js:109,124`）。
2. **id 集合比对**：`diffGraphs` 先扫 `newIds` 减 `oldIds` 得 added、`oldIds` 减 `newIds` 得 deleted（`lib/graph-diff.js:454-455`）。
3. **共有 id 分类**：对每个 `oldIds ∩ newIds` 中的 cid，依次算 `signatureChanged`（签名）、`bodyHash(o) !== bodyHash(n)`（实现）、`dependsOn` 差集（依赖边），按优先级归类（`lib/graph-diff.js:457-477`）；若 `hashChanged` 则调用 `truncateToTokens(unifiedBodyDiff(o, n, cid), maxDiffTokens)` 生成截断 diff（`lib/graph-diff.js:495`）。
4. **改名配对**：把 deleted 与 added 交给 `pairRenames`，相似度 ≥ `tauRen`（默认 0.8）的配对移出两个集合、写入 `renamed` Map（`lib/graph-diff.js:499-502`）；若签名也不同则额外补进 `interface`（`lib/graph-diff.js:523`）。
5. **补齐单侧记录**：剩余 added/deleted 各生成一条 `records`（含单侧统一 diff）（`lib/graph-diff.js:526-561`）。
6. **下游消费**：调用方拿 `diff` 对象，用 `changedIds`（`lib/graph-diff.js:436`）取受影响集合、`graphDiffCounts`（`lib/graph-diff.js:425`）取计数；`lib/update-planner.js` 的 `realChangedIds`（`lib/update-planner.js:57-81`）再用 `codeHash` 做纯注释降级，`lib/incremental.js` 的 `filterStaleTasks`（`lib/incremental.js:140-194`）同理降级后决定保留/丢弃文章。
7. **落盘**：引擎收尾时 `serializeDiff`（`lib/graph-diff.js:567`）把 `Set`/`Map` 转成可 JSON 化结构，存入 `UpdatePlan` / `UpdateRecord`（见 [[update-planner]] 与 [[update-record]]）。

## Connections

- [[update-planner]] —— 主消费方之一。`planUpdate`（`lib/update-planner.js:156`）在符号级模式下调用 `diffGraphs`（`lib/update-planner.js:186`）、`changedIds`、`graphDiffCounts`（`lib/update-planner.js:191`）；`realChangedIds`（`lib/update-planner.js:57`）复用 `codeHash` 做纯注释降级。
- [[incremental]] —— 另一主消费方。`filterStaleTasks`（`lib/incremental.js:140`）调用 `diffGraphs`/`changedIds`/`graphDiffCounts`（`lib/incremental.js:17,141-143`），并维护快照的 `slimGraph`/`graphFromSnapshot`（`lib/incremental.js:69,69`）以固化 `bodyHash`/`codeHash` 供本模块缓存分支使用。
- [[symbols]] —— 节点形状 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }` 由 `lib/symbols.js` 的 AST 提取产出（`lib/symbols.js:13-14`），是 `diffGraphs` 的输入契约。
- [[update-record]] —— `serializeDiff` 的产物经 `UpdatePlan` 进入 `buildUpdateRecord`（`lib/update-record.js:131`），其中 `changedComponents`/`cosmeticComponents`/`structuralComponents` 来自本模块的分类结果。
- [[cluster]] —— `lib/cluster.js` 消费同一套节点形状（`id`/`relativePath`/`parameters` 等），但只取签名做聚类提示词，不调用本模块。
- 黄金对拍：[[test-graphdiff.mjs]] 与 `test-fixtures/gen-graphdiff-golden.py` 共同保证本模块与上游 Python `difflib`/`hashlib` 逐位一致（见 `test-graphdiff.mjs:1-3` 与 `test-fixtures/gen-graphdiff-golden.py:1-7`）。

## Known Issues

- **字符串里的 `//` 被近似误判为注释**：`stripComments`（`lib/graph-diff.js:69-100`）不做真正的多语言词法解析，字符串字面量里的 `//` 会被当成注释一并剥掉（见 `lib/graph-diff.js:64-68` 注释）。这是有意为之的取舍——误判只会让「看起来像注释」的代码被剥掉，使 `codeHash` 更小概率碰撞；引入真词法分析需带语言参数，会把这条纯逻辑路径复杂化，故未做。影响范围：纯注释降级判定在极个别含 `//` 字符串的代码上可能误判。
- **`bodyHash` 不区分注释、需判定层降级**：`bodyHash`（`lib/graph-diff.js:121-126`）覆盖整段源码文本，只做空白归一（与上游 `normalize_body` 一致），因此「只改了注释」也会让它变，文章会被无条件重写。真正过滤纯注释改动的是**判定层**（`lib/incremental.js:146-169` / `lib/update-planner.js:60-72`）用 `codeHash` 做的降级，而非 `diffGraphs` 本身——刻意分层以保持 `diffGraphs` 与上游逐位对齐、便于 golden 对拍。
- **行内注释剥离对 `--`/`;`/`%` 不生效**：`TRAILING_COMMENT_MARKS`（`lib/graph-diff.js:39`）只含 `//` 与 `#`，因为 `--`（如 `a--b`）、`;`（语句结尾）、`%`（取模）在表达式里太常见，剥离会吃掉真代码，见 `lib/graph-diff.js:35-37`。`--`/`;`/`%` 仅在行首作为整行注释生效（`LINE_COMMENT_MARKS` + 行首判断，`lib/graph-diff.js:35,93-94`）。
- **改名配对是贪心近似、非全局最优**：`pairRenames`（`lib/graph-diff.js:371-407`）按相似度降序贪心配对，先到先得（`usedOld`/`usedNew` 去重，`lib/graph-diff.js:397-405`）；同一旧组件若与多个新组件都高相似，只能配一个。长度差太大（够不到 `tauRen*0.9`）直接剪枝（`lib/graph-diff.js:397-400`），「大幅改动但语义等同」的改名可能漏配、退化成独立的 added + deleted。
- **改名仅限同 kind 配对**：`pairRenames` 先按 kind 分组再配对（`lib/graph-diff.js:371-376`），跨 kind 的删除+新增不会被识别为改名。
- **无功能被禁用/注释关闭**：通读 `lib/graph-diff.js` 全文，所有导出函数（常量与主入口均列于上文）均处于启用状态，没有发现被整块注释掉或被 `disabled` 标志控制的代码；`diffGraphs` 的 `opts.tauRen` / `opts.maxDiffTokens` 也都提供了默认值（`lib/graph-diff.js:449-450,448-449`）。
- **golden 基准依赖外部生成**：`test-graphdiff.mjs` 要求先运行 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`，缺少会直接 `process.exit(1)`（`test-graphdiff.mjs:14-17`），对拍用例并不内联在测试里。
