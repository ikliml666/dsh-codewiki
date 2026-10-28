---
title: graph_diff
type: module
source_files:
  - lib/graph-diff.js
  - test-graphdiff.mjs
  - lib/incremental.js
  - lib/update-planner.js
  - lib/symbols.js
  - lib/change-set.js
  - lib/update-record.js
  - test-incremental.mjs
tags: [incremental, diff, similarity, graph, symbol-level]
---

## Overview

`lib/graph-diff.js` 实现「符号级代码图 diff 与相似度」算法，是增量编译判断的核心纯逻辑层。它移植自 FSoft-AI4Code/CodeWiki 的 `codewiki/src/be/updater/graph_diff.py`（MIT，ACL 2026 论文实现），逐位对齐 Python 原版，因此有 `test-fixtures/graphdiff-golden.json` 对拍基准。

为什么是移植而不是调用上游：上游最值钱的判断（哪些组件真的变了、变的是签名还是实现、哪个删除对应哪个新增=改名）全部是纯标准库算法（`hashlib`/`difflib`/`re`），零 ML 依赖。逐位移植后本插件保持纯 Node、零外部运行时，判定精度与上游一致（见文件头注释 `lib/graph-diff.js:1-6`）。

模块对外契约是「组件级变更集」：`diffGraphs(oldGraph, newGraph)` 接收两个 `Map<id, node>` 图，返回带 `added / deleted / interface / body / edge / renamed / records` 七类字段的 diff 对象。每条 `records` 还附带 unified diff 文本，供写作者直接看到改了什么。

Node 记录形状（与上游 `path::name` 同构，用 `#` 分隔避免 Windows 盘符冲突，见 `lib/graph-diff.js:8-10`、契约声明见 `lib/symbols.js:13-15`）：

```
{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }
```

## Key Components

### Exported constants

- `CLASS_ADDED = 'added'` (`lib/graph-diff.js:14`) — 变更类：新增组件。
- `CLASS_DELETED = 'deleted'` (`lib/graph-diff.js:15`) — 变更类：删除组件。
- `CLASS_IFACE = 'interface'` (`lib/graph-diff.js:16`) — 变更类：签名（名称/参数/基类）变了。
- `CLASS_BODY = 'body'` (`lib/graph-diff.js:17`) — 变更类：签名没变但实现（含注释/排版）变了。
- `CLASS_EDGE = 'edge'` (`lib/graph-diff.js:18`) — 变更类：仅依赖边（`dependsOn`）变了。
- `CLASS_RENAMED = 'renamed'` (`lib/graph-diff.js:19`) — 变更类：删除+新增近似匹配到的改名。
- `DIFF_TRUNCATED_MARKER = '... [diff truncated] ...'` (`lib/graph-diff.js:21`) — 长 diff 被截断时插入的占位文本。
- `DEFAULT_TAU_REN = 0.8` (`lib/graph-diff.js:368`) — 改名配对的 body 相似度阈值。
- `DEFAULT_MAX_DIFF_TOKENS = 2000` (`lib/graph-diff.js:251`) — `records.diff` 字段允许的最大 token 数（超出被 `truncateToTokens` 截断）。

模块级私有常量（供哈希/去注释使用）：

- `WS = /\s+/gu` (`lib/graph-diff.js:23`) — 空白归一类。
- `TOKEN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu` (`lib/graph-diff.js:26`) — Unicode 感知的 token 切分（还原 Python `\w` 的中文语义，避免中文被切碎导致相似度偏高，见 `lib/graph-diff.js:24-25`）。
- `LINE_COMMENT_MARKS = ['//', '///', '#', '--', ';', '%']` (`lib/graph-diff.js:69`) — 行首注释标记（见 `stripComments` 说明）。
- `BLOCK_COMMENT_PAIRS = [['/*', '*/'], ['<!--', '-->'], ['"""', '"""'], ["'''", "'''"]]` (`lib/graph-diff.js:36`) — 块注释起止对。
- `TRAILING_COMMENT_MARKS = ['//', '#']` (`lib/graph-diff.js:39`) — 仅做行内剥离的注释起始符（`--`/`;`/`%` 不做行内剥离，因它们在表达式中太常见）。

### Text & hash helpers

- `normalizeBody(text)` (`lib/graph-diff.js:28-30`) — 去首尾空白、压缩内部空白为单空格，用于 body 哈希前的归一。
- `stripTrailingComment(line)` (`lib/graph-diff.js:43-62`) — 剥掉一行里位于引号外的行注释（`//`、`#`），跟踪 `' " \`` 三种引号与反斜杠转义，故 `"http://x"` 不会被误判；`#` 仅在行首或前面是空白时算注释，避免吃掉 C 预处理/JS 私有字段。
- `stripComments(text)` (`lib/graph-diff.js:69-100`) — 去掉注释与纯装饰空白，只留代码本身。逐行扫、跟踪块注释状态；字符串里的 `//` 会被误判为注释（可接受近似，见 `lib/graph-diff.js:64-68`）。用途：区分「只改了注释/排版」与「代码有实质变化」。
- `codeHash(node)` (`lib/graph-diff.js:108-111`) — 「代码本体」SHA1 哈希，不含注释与排版差异。若节点没有 `sourceCode` 但有固化 `codeHash` 则直接返回（快照回读场景）。调用方用它与 `bodyHash` 配合做「纯注释改动降级」（见 [[incremental]] 与 [[update_planner]]）。
- `documentedSource(node)` (`lib/graph-diff.js:114-119`) — 组件源码＋文档注释；Rust 的 `///` 在 `sourceCode` 之外，不带上就看不出「只改了文档」。若 `docstring` 未包含在 `sourceCode` 内则拼成 `${doc}\n${code}`。
- `bodyHash(node)` (`lib/graph-diff.js:121-126`) — 对 `normalizeBody(documentedSource(node))` 做 SHA1。快照回读节点不带源码，只在「没有源码但是有固化 `bodyHash`」时走缓存分支返回固化值。
- `signature(node)` (`lib/graph-diff.js:128-134`) — 返回 `{ name, parameters, baseClasses }` 浅拷贝，用于签名比对。
- `signatureChanged(a, b)` (`lib/graph-diff.js:136-145`) — 逐项比较 name / parameters / baseClasses，任一不同即返回 `true`。
- `approxTokens(text)` (`lib/graph-diff.js:247-249`) — 按 `length/4 + 1` 估算 token 数，用于截断预算。
- `truncateToTokens(text, maxTokens)` (`lib/graph-diff.js:251-257`) — 超过预算时保留首尾各一半、中间插 `DIFF_TRUNCATED_MARKER`。

### difflib.SequenceMatcher port（token 级相似度）

- `tokens(text)` (`lib/graph-diff.js:147-149`) — 用 `TOKEN` 正则切分文本为 token 数组。
- `buildB2J(b)` (`lib/graph-diff.js:156-164`) — 构造 `b` 的 token→下标列表映射（Python `b2j`）。
- `findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)` (`lib/graph-diff.js:166-189`) — 在给定窗口内找最长匹配块（`[besti, bestj, bestsize]`）。
- `getMatchingBlocks(a, b)` (`lib/graph-diff.js:191-226`) — 递归切分队列求所有匹配块，并合并相邻块（与 Python difflib 完全一致）。
- `sequenceRatio(aArr, bArr)` (`lib/graph-diff.js:229-236`) — 移植 `difflib.SequenceMatcher.ratio()`：`(2*matches)/(len(a)+len(b))`，空序列返回 `1.0`。
- `bodySimilarity(a, b)` (`lib/graph-diff.js:239-245`) — 上游 `body_similarity`：对 `a`/`b` 做 token 序列的 difflib ratio，落在 `[0,1]`；双空返回 `1.0`，单空返回 `0.0`。

### difflib.unified_diff port

- `splitKeepEnds(text)` (`lib/graph-diff.js:263-269`) — 模拟 Python `splitlines(keepends=True)`：末尾无换行的最后一行也保留。
- `getOpcodes(a, b)` (`lib/graph-diff.js:271-287`) — 由匹配块生成 `replace/delete/insert/equal` 操作码。
- `getGroupedOpcodes(a, b, n)` (`lib/graph-diff.js:289-317`) — 按 `n` 行上下文分组，裁剪过长 equal 段。
- `rangeUnified(start, stop)` (`lib/graph-diff.js:319-325`) — 把 `[start, stop)` 转成 unified diff 的 `beginning,length` 区间格式。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n=3, lineterm='\n')` (`lib/graph-diff.js:327-355`) — 完整移植 `difflib.unified_diff`：首个 group 输出 `---/+++` 头，每个 group 带 `@@` 头。
- `unifiedBodyDiff(oldNode, newNode, label)` (`lib/graph-diff.js:358-362`) — 上游 `unified_body_diff`：对 `documentedSource` 按 `splitKeepEnds` 切行，以整文件相对路径作 label、上下文固定 `2` 行调用 `unifiedDiff`。任一节点为 `null` 时对应侧为空（纯增/纯删 diff）。

### Rename pairing

- `pairRenames(deleted, added, oldGraph, newGraph, tauRen=DEFAULT_TAU_REN)` (`lib/graph-diff.js:371-407`) — 按 body 相似度贪心最佳匹配改名。先按 `kind` 分组新增项；对每个删除项，先用长度比（`min/len` 小于 `tauRen*0.9` 直接跳过）粗筛，再算 `bodySimilarity` ≥ `tauRen` 的候选；候选按相似度降序，贪心取未被占用的 old/new 对。返回 `[[oldId, newId, sim], ...]`。

### Main entry & diff object helpers

- `emptyGraphDiff()` (`lib/graph-diff.js:413-423`) — 返回空白 diff：`{ added, deleted, interface, body, edge: Set(), renamed: Map(), records: Map() }`。
- `graphDiffCounts(d)` (`lib/graph-diff.js:425-434`) — 把六个集合的大小汇总成 `{ added, deleted, interface, body, edge, renamed }`。
- `changedIds(d)` (`lib/graph-diff.js:436-440`) — 返回所有发生变化（含 `renamed` 的 value 端）的组件 id 集合。
- `isDiffEmpty(d)` (`lib/graph-diff.js:442-444`) — `changedIds(d).size === 0` 判定无变更。
- `diffGraphs(oldGraph, newGraph, opts={})` (`lib/graph-diff.js:447-564`) — 主入口，见下文 Architecture。
- `serializeDiff(d)` (`lib/graph-diff.js:567-578`) — Set/Map 转数组与对象，便于落盘与对拍；`renamed` 与 `records` 按 key 排序。

### `diffGraphs` 产生的 record 字段

每个 `records` 条目（`lib/graph-diff.js:480-496`、`506-523`、`528-560`）结构：

| 字段 | 含义 |
| --- | --- |
| `componentId` | 组件 id（改名时为 newId） |
| `changeClass` | 上述 6 个 `CLASS_*` 之一 |
| `oldId` / `newId` | 变更前后 id（删除时 newId=null，新增时 oldId=null） |
| `relativePath` | 组件相对路径 |
| `componentType` | 组件 `kind` |
| `oldSignature` / `newSignature` | `signature()` 输出；删除/新增侧为 `null` |
| `similarity` | 仅改名时填 `round(sim*10000)/10000`，其余 `null` |
| `signatureChanged` | `signatureChanged(o,n)` 结果 |
| `edgesAdded` / `edgesRemoved` | 相对旧图排序后的 `dependsOn` 增减 |
| `diff` | `unifiedBodyDiff` 经 `truncateToTokens(..., maxDiffTokens)` 后的文本 |

## Architecture

`diffGraphs` 是纯函数主入口；它按「分类 → 改名配对 → 补登记」三段式产出 diff。下方框图标注组件名与所在文件/行：

```text
         oldGraph: Map<id,node> ──┐
                                   ├─► diffGraphs (lib/graph-diff.js:447)
         newGraph: Map<id,node> ──┘        │
                                           ▼
                            ┌──────────────────────────────┐
                            │ 1. 新增/删除分类 (454-455)    │
                            │ 2. 同名组件逐对判定 (457-497) │
                            │    sigChanged? -> interface  │
                            │    hashChanged? -> body      │
                            │    edgesChanged? -> edge     │
                            │    truncateToTokens +       │
                            │      unifiedBodyDiff -> diff │
                            └──────────────┬───────────────┘
                                           │ result.deleted/added
                                           ▼
                            ┌──────────────────────────────┐
                            │ pairRenames (371)             │
                            │   bodySimilarity >= tauRen    │
                            │   -> result.renamed (499-524) │
                            └──────────────┬───────────────┘
                                           │ 剩余 added/deleted
                                           ▼
                            ┌──────────────────────────────┐
                            │ 3. 补登记 added/deleted 记录 │
                            │    (526-561)                  │
                            └──────────────┬───────────────┘
                                           ▼
                              GraphDiff { added, deleted,
                              interface, body, edge,
                              renamed:Map, records:Map }

  支撑子函数（同文件）：
  signatureChanged(136) ─► sequenceRatio(229)┐
  bodyHash(121) ─────────► bodySimilarity(239) ├─► getMatchingBlocks(191)
  codeHash(108) ─────────► unifiedBodyDiff(358) ─► unifiedDiff(327)
```

判定优先级（`lib/graph-diff.js:136-147`）：先判 `signatureChanged`，否则判 `bodyHash` 变，否则判 `dependsOn`（边）变；三者皆否则跳过该组件（视为未变）。

## Data Flow

1. **图来源**：`oldGraph` / `newGraph` 由 [[symbols]] 的 `extractRepoGraph` 产出 `Map<id, node>` 节点，字段与 `lib/graph-diff.js:9-10` 契约一致。
2. **快照瘦身**：在 [[incremental]] 里，现场图经 `slimGraph` 固化 `bodyHash`/`codeHash` 后落盘为 `temp/symbol-graph.json`；下次编译用 `graphFromSnapshot` 回读成图（无 `sourceCode`，只带固化哈希）。`bodyHash`/`codeHash` 各自在有缓存时直接返回固化值（`lib/graph-diff.js:109`、`124`），因此回读图无需源码即可判定实现变更（见 `test-incremental.mjs:42-47`）。
3. **diff 计算**：`diffGraphs` 产出 `GraphDiff`；`changedIds` 取其变化集合。
4. **纯注释降级**：调用方（[[incremental]] `filterStaleTasks`、[[update_planner]] `realChangedIds`）对 `body` 类变更再做一道 `codeHash` 比对——`bodyHash` 变但 `codeHash` 没变且没有 `docstring` 变化，则视为「纯注释/排版噪音」降级放行（不改写文章），而 `interface/added/deleted/renamed/edge` 一律视为实质变化（见 `lib/incremental.js:146-169`、`lib/update-planner.js:57-81`）。
5. **下游消费**：
   - [[incremental]] `filterStaleTasks` 据 `realChanged` 决定文章 `keep`/`dropped`，并把 `changedComponents` 喂给写作者。
   - [[update_planner]] `planUpdate` 据 `structural`/`real` 决定每篇的 `write/keep/delete/review` action，并用 `diff.renamed` 做 stale scan（见 `lib/update-planner.js:320-329`）。
   - 结果经 `serializeDiff` 落盘、`graphDiffCounts` 摘要进 [[update_record]]。

## Connections

- [[symbols]] — 提供 `GraphDiff` 所需的节点图（`Map<id, node>`），字段契约一致（`lib/symbols.js:13-15`）。
- [[incremental]] — 快照瘦身存取 + 组件级变更折算；直接 import `diffGraphs / changedIds / graphDiffCounts / bodyHash / codeHash`（`lib/incremental.js:17`），并在判定层做纯注释降级。
- [[update_planner]] — 计划主入口 `planUpdate` import `diffGraphs / changedIds / graphDiffCounts / codeHash`（`lib/update-planner.js:156`），用 diff 结果驱动 write/keep/delete/review 与 stale scan（反向依赖、死链）。
- [[change_set]] — 文件级变更集（`collectChangeSet`）经 [[incremental]]/[[update_planner]] 折算成组件级变更；本模块是其中的「组件级」内核。
- [[update_record]] — `buildUpdateRecord` 收纳 `plan.changedComponents / cosmeticComponents / structuralComponents` 与 `counts`，这些均源自本模块的 diff 结果。

## Known Issues

- **字符串内注释误判（已知近似）**：`stripComments`（`lib/graph-diff.js:69-100`）会把字符串字面量里的 `//` 误判为注释。作者明确认定「可接受」，因为引入真正词法分析需带语言参数、把纯逻辑路径复杂化不划算（见 `lib/graph-diff.js:64-68`）。副作用：仅让「看着像注释」的代码被剥掉使 `codeHash` 变小概率碰撞，不影响实质判定。
- **哈希粒度不区分注释（已在上层降级补偿）**：`bodyHash` 覆盖整段源码文本，注释被改一下它就变，导致文章无条件重写。这是移植对齐上游的固有粒度（`lib/graph-diff.js:121` 注释说明上游 Python `normalize_body` 也只做空白归一）。补偿措施在判定层（[[incremental]] `filterStaleTasks`、[[update_planner]] `realChangedIds`）用 `codeHash` 做纯注释降级，而非改动本模块（保持与上游逐位对拍，见 `lib/incremental.js:146-169`）。
- **`#` 注释在行内受限**：`stripTrailingComment` 中 `#` 只在行首或前接空白才算注释（`lib/graph-diff.js:43-45`），以避免吃掉 C 预处理与 JS 私有字段（`#field`）。
- **无被注释/禁用的导出**：本模块全部导出均处于启用状态，无 `disabled` 分支（除快照回读的缓存分支 `codeHash`/`bodyHash` 在「无源码」时走不同返回路径，见 `lib/graph-diff.js:108-111`、`121-126`，这是设计内的双路径而非禁用）。
- **对拍基准依赖外部生成**：`test-graphdiff.mjs:1-17` 要求先跑 `python test-fixtures/gen-graphdiff-golden.py` 生成 `test-fixtures/graphdiff-golden.json`，否则测试直接 `process.exit(1)`；golden 由 Python 原生 difflib/hashlib 生成，与逐位移植互相验证。

