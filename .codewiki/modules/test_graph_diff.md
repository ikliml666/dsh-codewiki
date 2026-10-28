---
title: test_graph_diff
type: module
source_files:
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/graph-diff.js
tags: [test, golden-fixture, graph-diff, difflib, python-port]
---

## Overview

`test_graph_diff` 是 `lib/graph-diff.js` 的「对拍 + 组件级」测试模块，由三个文件组成：

- `test-graphdiff.mjs` — Node 测试驱动（无测试框架，裸 `node` 运行，靠 `process.exit(0/1)` 报结果）。
- `test-fixtures/gen-graphdiff-golden.py` — 用 Python 原生 `difflib` + `hashlib` 生成「黄金基准」JSON 的脚本。
- `test-fixtures/graphdiff-golden.json` — 由上面脚本产出的基准（共 499 行、大量用例），是 `test-graphdiff.mjs` 的逐位比对源。

模块目的：验证 `lib/graph-diff.js` 是把 FSoft-AI4Code/CodeWiki 的 `graph_diff.py` **逐位移植**到纯 Node，而非重新实现。移植难点在于 `difflib.SequenceMatcher` 的匹配块算法在边界情形（空序列、重复 token、`autojunk`）下极难靠肉眼核对，因此必须「用 Python 原版喂同一批输入产出期望值，再让 Node 侧比对」（`gen-graphdiff-golden.py` 第 4–7 行注释明确此意图）。

测试分两大块（见 `test-graphdiff.mjs`）：

1. **对拍用例（第 28–53 行）** — 从 `graphdiff-golden.json` 读取 `{kind, ...}` 用例，逐条调用 `bodySimilarity` / `bodyHash` / `unifiedDiff` 与 `expected` 比对。
2. **组件级 diff（第 55–107 行）** — 手工构造 `oldG` / `newG` 两张符号图（`Map<id, node>`），调用 `diffGraphs` + `serializeDiff`，断言改名配对、`interface`/`body`/`edge` 分类、counts 自洽、序列化往返等性质。

## Key Components

### 测试驱动 `test-graphdiff.mjs`

- `goldenPath` / 加载守卫（第 12–18 行）：`path.join(here, 'test-fixtures', 'graphdiff-golden.json')`；若基准文件不存在则 `console.error` 提示先跑 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json` 并 `process.exit(1)`（第 14–17 行）。
- 导入的被测函数（第 7–10 行）：`bodySimilarity`、`bodyHash`、`unifiedDiff`、`diffGraphs`、`serializeDiff`、`sequenceRatio`、`normalizeBody`、`documentedSource`、`truncateToTokens`。
- `splitKeepEnds(s)`（第 23–26 行）：本地辅助函数，把文本切成「保留换行符」的行数组（正则 `/[^\n]*\n|[^\n]+$/g`），供 `unifiedDiff` 用例喂入。注意：库内 `lib/graph-diff.js` 第 263–269 行也有同名私有 `splitKeepEnds`，测试侧另实现了一份，二者行为需一致。
- 对拍主循环（第 28–42 行）：按 `c.kind` 分派：
  - `'similarity'` → `bodySimilarity(c.a, c.b)`，断言 `|got - expected| < 1e-12`（第 30–32 行）。
  - `'hash'` → `bodyHash({ sourceCode: c.code, docstring: c.docstring })`，断言严格相等（第 34–36 行）。
  - `'unified'` → `unifiedDiff(splitKeepEnds(c.oldText), splitKeepEnds(c.newText), 'a/'+c.label, 'b/'+c.label, 2)`，断言严格相等（第 38–40 行；上下文 `n=2` 对应上游 `unified_body_diff`）。
- 失败汇总（第 44–53 行）：打印通过数/失败数，失败最多展示前 5 条（input/expected/got）后 `process.exit(1)`。
- `mk(id, name, src, opts={})`（第 58–66 行）：构造符号节点，默认 `kind:'function'`、`relativePath:'src/a.js'`、`docstring:''`、`parameters:[]`、`baseClasses:[]`、`dependsOn:[]`，其余字段可经 `opts` 覆盖。
- `oldG` / `newG`（第 68–82 行）：两张 `Map`，覆盖六类情形——未变（`a.js#foo`）、body 改动（`a.js#bar` 返回值 1→42）、edge 改动（`a.js#baz` 新增 `dependsOn:['a.js#foo']`）、interface 改动（`a.js#sig` 参数 `['a']`→`['a','b']`）、重命名（`a.js#gone`→`a.js#renamed` 同体）、新增（`a.js#fresh`）。
- `d = diffGraphs(oldG, newG)`（第 83 行）、`s = serializeDiff(d)`（第 84 行）。
- 组件级断言列表 `checks`（第 86–94 行）：
  - `body` 分类含 `a.js#bar`（第 87 行）。
  - `edge` 分类含 `a.js#baz`（第 88 行）。
  - `interface` 分类含 `a.js#sig`（第 89 行）。
  - 未变节点 `a.js#foo` 不出现在任何分类（第 90 行）。
  - 改名配对 `s.renamed['a.js#gone'] === 'a.js#renamed'`（第 91 行）。
  - 改名后不算 deleted/added（第 92 行）。
  - 新增登记 `s.added.includes('a.js#fresh')`（第 93 行）。
  - counts 自洽 `s.counts.body === d.body.size && s.counts.renamed === d.renamed.size`（第 94 行）。
- 断言执行与汇总（第 96–100 行）：逐条打印 `PASS/FAIL`，任一失败则 `ok=false`。
- 序列化往返（第 102–104 行）：`JSON.parse(JSON.stringify(s))` 后校验 `round.counts`、`Array.isArray(round.added)`、`typeof round.renamed==='object'`。
- 退出（第 106–107 行）：`ok ? 'ALL PASS' : 'HAS FAILURES'`，`process.exit(ok ? 0 : 1)`。

### 黄金基准生成器 `test-fixtures/gen-graphdiff-golden.py`

- 常量：`_WS = re.compile(r"\s+")`（第 15 行）、`_TOKEN = re.compile(r"\w+|[^\w\s]")`（第 16 行）。
- `normalize_body(text)`（第 19–20 行）：去前后空白、空白折叠为单空格。对应 JS `normalizeBody`（`lib/graph-diff.js` 第 28–30 行）。
- `documented_source(code, docstring="")`（第 23–27 行）：docstring 不在 code 中时拼成 `f"{doc}\n{code}"`。对应 JS `documentedSource`（库第 114–119 行）。
- `body_hash(code, docstring="")`（第 30–31 行）：`hashlib.sha1(normalize_body(documented_source(...)).encode("utf-8"))`。对应 JS `bodyHash`（库第 121–126 行）。
- `_tokens(text)`（第 34–35 行）：`_TOKEN.findall`。对应 JS `tokens`（库第 147–149 行）。
- `body_similarity(a, b)`（第 38–44 行）：token 化后用 `difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()`；空对空返回 1.0，单侧空返回 0.0。对应 JS `bodySimilarity`（库第 239–245 行）与 `sequenceRatio`（库第 229–236 行）。
- `unified_body_diff(old_lines, new_lines, label, n=2)`（第 47–49 行）：`difflib.unified_diff(..., fromfile=f"a/{label}", tofile=f"b/{label}", n=n)`。对应 JS `unifiedDiff`（库第 327–355 行）与 `unifiedBodyDiff`（库第 358–362 行）。
- `main()`（第 52–144 行）：用固定种子 `random.Random(20261027)` 生成用例——
  - `sim_inputs`：13 组手写 + 30 组随机（alphabet `["a","b","c","d","(",")","+","1","2"]`、`n,m∈[1,25]`），每条产出 `kind:'similarity'`（第 57–86 行）。
  - `hash_inputs`：6 组手写，产出 `kind:'hash'`（第 89–103 行）。
  - `diff_inputs`：9 组手写（含无末尾换行、纯新增、纯删除、多 hunk），产出 `kind:'unified'`（第 106–126 行）。
  - 随机 diff：20 组 `L0..L5` 随机行，`kind:'unified'`、`label:'r'`（第 129–142 行）。
  - 末尾 `json.dump(cases, sys.stdout, ensure_ascii=False, indent=1)`（第 144 行）输出 499 行 JSON。

### 被测库 `lib/graph-diff.js`（被对拍覆盖的公开符号）

- 分类常量：`CLASS_ADDED/CLASS_DELETED/CLASS_IFACE/CLASS_BODY/CLASS_EDGE/CLASS_RENAMED`（第 14–19 行）、`DIFF_TRUNCATED_MARKER`（第 21 行）。
- 文本/哈希：`normalizeBody`（28–30）、`stripComments`（69–100）、`codeHash`（108–111）、`documentedSource`（114–119）、`bodyHash`（121–126）。
- 签名：`signature`（128–134）、`signatureChanged`（136–145）。
- difflib 移植：`buildB2J`（156–164）、`findLongestMatch`（166–189）、`getMatchingBlocks`（191–226）、`sequenceRatio`（229–236）、`bodySimilarity`（239–245）、`approxTokens`（247–249）、`truncateToTokens`（251–257）、`splitKeepEnds`（263–269）、`getOpcodes`（271–287）、`getGroupedOpcodes`（289–317）、`rangeUnified`（319–325）、`unifiedDiff`（327–355）、`unifiedBodyDiff`（358–362）。
- 改名配对：`DEFAULT_TAU_REN`（368）、`DEFAULT_MAX_DIFF_TOKENS`（369）、`pairRenames`（371–407）。
- 主入口与序列化：`emptyGraphDiff`（413–423）、`graphDiffCounts`（425–434）、`changedIds`（436–440）、`isDiffEmpty`（442–444）、`diffGraphs`（447–564）、`serializeDiff`（567–578）。

## Architecture

两个独立阶段：先在 Python 侧离线生成基准（一次性，不随测试运行），再在 Node 侧运行测试时做逐位比对 + 组件级性质断言。

```text
┌────────────────────────────┐        ┌──────────────────────────────┐
│ gen-graphdiff-golden.py    │ 写盘   │ graphdiff-golden.json         │
│ (Python difflib/hashlib)   │ ─────► │ 499 行用例                    │
│ main(): seed=20261027      │        │ kind: similarity/hash/unified │
└────────────────────────────┘        └───────────────┬──────────────┘
                                                       │ 读入 (test-graphdiff.mjs:13-18)
                                                       ▼
┌────────────────────────────┐        ┌──────────────────────────────┐
│ test-graphdiff.mjs         │ 调用   │ lib/graph-diff.js             │
│ ▸ 对拍循环 (28-42)         │ ─────► │ bodySimilarity/bodyHash/      │
│   similarity/hash/unified  │        │ unifiedDiff (difflib 移植)    │
│ ▸ 组件级 (55-107)          │ ─────► │ diffGraphs/serializeDiff      │
│   oldG/newG → checks[]     │        │ (改名/分类/序列化)            │
└────────────────────────────┘        └──────────────────────────────┘
        │                                          ▲
        │ 比对 got vs expected (abs<1e-12 / ===)   │ 同一算法，JS 侧再实现
        └──────────────────────────────────────────┘
```

关键关系：

- `gen-graphdiff-golden.py` 与 `lib/graph-diff.js` 是「同算法双实现」，前者是 Python 原创、后者是逐位移植；`test-graphdiff.mjs` 只消费后者、并以前者产出的 JSON 为真理。
- 对拍层只验证**纯函数**（`bodySimilarity`/`bodyHash`/`unifiedDiff`）；组件级层验证**有状态的图算法**（`diffGraphs`/`serializeDiff`），二者覆盖互补。

## Data Flow

**基准生成（离线、一次性）：**

1. `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`（`gen-graphdiff-golden.py` 第 147–148 行 `__main__` 触发 `main()`）。
2. `main()` 以固定随机种子 `random.Random(20261027)`（第 53 行）构造 `cases` 数组，三类用例各带 `kind` 与 `expected`。
3. `json.dump(..., ensure_ascii=False, indent=1)`（第 144 行）输出到 stdout，重定向落盘为 `graphdiff-golden.json`。

**测试运行（每次 `node test-graphdiff.mjs`）：**

1. 加载守卫：`fs.existsSync(goldenPath)`（第 14 行）；缺失则报错退出。否则 `JSON.parse(fs.readFileSync(goldenPath,'utf8'))` 得到 `cases`（第 18 行）。
2. 对拍循环（第 28–42 行）：遍历 `cases`，按 `kind` 调 `lib/graph-diff.js` 对应函数得 `got`，与 `c.expected` 比对；`similarity` 用相对误差 `<1e-12`，`hash`/`unified` 用严格 `===`。累计 `pass`/`fails`。
3. 失败打印（第 44–53 行）：输出统计，最多 5 条明细，`process.exit(1)`。
4. 组件级（第 55–100 行）：`mk` 造节点 → 填 `oldG`/`newG` 两张 `Map` → `diffGraphs` → `serializeDiff` → 8 条 `checks` 断言分类/改名/counts。
5. 序列化往返（第 102–104 行）：`JSON.parse(JSON.stringify(s))` 校验字段类型。
6. 退出码（第 106–107 行）：全过 `0`（`ALL PASS`），否则 `1`（`HAS FAILURES`）。

## Connections

- [[graph-diff]] — 本测试唯一被测模块 `lib/graph-diff.js` 的实现与文档（FSoft 上游 Python 的逐位移植）。
- [[test-incremental]] / [[test-incremental-e2e]] — 增量更新管线测试，依赖 `diffGraphs` 的判定结果驱动文章重写。
- [[test-change-set]] — 变更集相关测试，`serializeDiff` 产出的 `counts/records` 结构是变更集的输入形态。
- [[test-prune-orphans]] — 删孤儿节点测试，与 `diffGraphs` 的 `deleted` 分类相关。

## Known Issues

- **`splitKeepEnds` 双份实现**：测试侧 `test-graphdiff.mjs` 第 23–26 行与库侧 `lib/graph-diff.js` 第 263–269 行各有一份同名逻辑，并非共用。若将来库内实现变化，测试侧这份不会自动跟随，存在各自漂移风险。
- **基准文件非随测生成**：`graphdiff-golden.json` 必须手工重跑 `gen-graphdiff-golden.py` 才能刷新（第 15 行提示）。随手改 `lib/graph-diff.js` 后若发现对拍失败，需先确认是「实现回归」还是「基准该重生成」，两者目前靠人工区分。
- **随机用例不可复现但已固化**：`gen-graphdiff-golden.py` 用 `random.Random(20261027)` 固定种子（第 53 行），只有重跑脚本才会重算；`graphdiff-golden.json` 里已经固化的随机用例（如 `L5\nL4...` 类 `kind:'unified'`、`label:'r'`，见 JSON 第 440–498 行）是固定真理，改动脚本种子会令整份基准失真。
- **组件级断言不覆盖全部分类路径**：`checks`（第 86–94 行）验证了 `body/edge/interface/renamed/added`，但**未直接断言 `deleted` 列表**（仅在第 92 行以「改名后不算 deleted」间接验证）；`CLASS_DELETED` 的完整记录形状由 `diffGraphs` 第 544–561 行产出，但测试未单独构造「仅删除」用例做正向断言。
- **功能禁用/注释**：本模块无被禁用或注释掉的功能；所有断言分支（similarity/hash/unified）均生效。
