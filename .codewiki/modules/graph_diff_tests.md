---
title: graph_diff_tests
type: module
source_files:
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/graph-diff.js
tags: [testing, golden-fixtures, graph-diff, incremental, codewiki]
---

## Overview

`graph_diff_tests` 是 `lib/graph-diff.js`（符号级增量 diff，移植自 FSoft-AI4Code/CodeWiki 的 `graph_diff.py`）的测试与黄金基准模块。它由三部分组成，均位于仓库根目录：

- `test-graphdiff.mjs`：Node 端对拍测试 + 组件级 diff 断言测试，直接 `import` 被测模块并比对。
- `test-fixtures/gen-graphdiff-golden.py`：Python 上游原版基准生成器，用原生 `difflib` / `hashlib` 喂同一批输入产出期望值。
- `test-fixtures/graphdiff-golden.json`：由上面的 Python 脚本生成的黄金基准文件（499 行 JSON 数组），是 `test-graphdiff.mjs` 的必需输入。

测试目标有两类，对应被测模块的两层能力：

1. **逐位一致性对拍**（golden diff）：验证 Node 移植的 `bodySimilarity` / `bodyHash` / `unifiedDiff` 与上游 Python 原版输出逐字节一致。因为 `difflib.SequenceMatcher` 有大量边界情形（空序列、重复 token、`autojunk`），靠肉眼核对不可信，必须用 Python 原版喂同一批输入做期望。
2. **组件级 diff 行为断言**：用人工构造的 `Map<id, node>`，验证 `diffGraphs` 的改名配对、`interface`/`body`/`edge` 分类、`added`/`deleted` 登记、`serializeDiff` 往返等是否正确。

注意：`test-graphdiff.mjs` 第 14-17 行会在缺少 `test-fixtures/graphdiff-golden.json` 时直接 `process.exit(1)`，因此运行测试前必须先生成该基准文件（`python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`），这与脚本头注释（第 2-3、15 行）一致。

## Key Components

本模块的公开实体全部来自 `test-graphdiff.mjs` 与 `test-fixtures/gen-graphdiff-golden.py`，被测函数（来自 `lib/graph-diff.js`）清单见其自身模块文档。下面逐一列出本模块导出的测试逻辑与基准生成器。

### test-graphdiff.mjs（顶层脚本，无 exports，直接运行）

- **导入表**（`test-graphdiff.mjs:7-10`）：从 `./lib/graph-diff.js` 导入 `bodySimilarity`、`bodyHash`、`unifiedDiff`、`diffGraphs`、`serializeDiff`、`sequenceRatio`、`normalizeBody`、`documentedSource`、`truncateToTokens` 共 9 个符号（注意：`sequenceRatio` / `normalizeBody` / `documentedSource` / `truncateToTokens` 在测试脚本中虽被导入却未被引用——属冗余导入）。
- **`goldenPath` 加载与缺失保护**（`test-graphdiff.mjs:12-18`）：拼接 `test-fixtures/graphdiff-golden.json` 路径，`fs.existsSync` 缺失则报错退出；存在则 `JSON.parse` 成 `cases` 数组。
- **`splitKeepEnds(s)`**（`test-graphdiff.mjs:23-26`）：本地辅助函数，按正则 `/[^\n]*\n|[^\n]+$/g` 把文本切成保留行尾换行的数组；用于 `unified` 用例把 `oldText`/`newText` 还原成行数组喂给 `unifiedDiff`（第 38 行）。
- **对拍主循环**（`test-graphdiff.mjs:28-42`）：遍历 `cases`，按 `c.kind` 分派：
  - `similarity`：调 `bodySimilarity(c.a, c.b)`，断言 `Math.abs(got - c.expected) < 1e-12`（第 30-31 行）。
  - `hash`：调 `bodyHash({ sourceCode: c.code, docstring: c.docstring })`，断言 `got === c.expected`（第 34-36 行）。注意这里把黄金文件里的 `code`/`docstring` 字段包成 `sourceCode`/`docstring` 键后传参。
  - `unified`：把 `oldText`/`newText` 用 `splitKeepEnds` 切行后调 `unifiedDiff(..., a/${c.label}, b/${c.label}, 2)`，断言 `got === c.expected`（第 38-40 行）。
  - 每类通过则 `pass++`，否则 `fails.push({ ...c, got, why })`。
- **失败报告**（`test-graphdiff.mjs:44-53`）：打印通过/失败计数；有失败时只显示前 5 条 `FAIL`，并打印 `input`/`expect`/`got`，随后 `process.exit(1)`。
- **`mk(id, name, src, opts)`**（`test-graphdiff.mjs:58-66`）：构造被测节点，默认 `kind='function'`、`relativePath='src/a.js'`、`docstring=''`、`parameters=[]`、`baseClasses=[]`、`dependsOn=[]`；`opts` 可覆盖。
- **组件级 fixture 构建**（`test-graphdiff.mjs:68-82`）：`oldG` 与 `newG` 两个 `Map`，覆盖未变/body 变/edge 变/interface 变/改名/新增/删除等多种情形（含 `a.js#gone` → `a.js#renamed` 的改名配对）。
- **`diffGraphs` + `serializeDiff` 调用**（`test-graphdiff.mjs:83-84`）：`d = diffGraphs(oldG, newG)`，`s = serializeDiff(d)`。
- **分类断言 `checks`**（`test-graphdiff.mjs:86-94`）：8 条断言，覆盖：`body` 含 `a.js#bar`、`edge` 含 `a.js#baz`、`interface` 含 `a.js#sig`、未变 `a.js#foo` 不登记、改名配对 `s.renamed['a.js#gone'] === 'a.js#renamed'`、改名后不算 `deleted`/`added`、新增登记 `a.js#fresh`、`counts` 自洽（`s.counts.body === d.body.size` 且 `s.counts.renamed === d.renamed.size`）。
- **断言执行与汇总**（`test-graphdiff.mjs:96-100`）：逐条打印 `PASS`/`FAIL`，任意失败则 `ok = false`。
- **序列化往返校验**（`test-graphdiff.mjs:102-104`）：`JSON.parse(JSON.stringify(s))` 后断言 `round.counts` 存在、`round.added` 为数组、`round.renamed` 为对象。
- **退出**（`test-graphdiff.mjs:106-107`）：`ok` 为真打印 `ALL PASS` 并 `process.exit(0)`，否则 `HAS FAILURES` 并 `process.exit(1)`。

### test-fixtures/gen-graphdiff-golden.py

- **模块 docstring**（第 1-7 行）：说明用途——用 Python 原生 `difflib` + FSoft 原版函数产出 JSON 基准，验证 `lib/graph-diff.js` 移植逐位一致。
- **`normalize_body(text)`**（第 19-20 行）：`(text or "").strip()` 后把 `\s+` 替换为单空格；对应 `lib/graph-diff.js:28-30` 的 `normalizeBody`。
- **`documented_source(code, docstring="")`**（第 23-27 行）：doc 存在且不在 code 中时返回 `f"{doc}\n{code}"`，否则返回 code；对应 `lib/graph-diff.js:114-119` 的 `documentedSource`。
- **`body_hash(code, docstring="")`**（第 30-31 行）：`hashlib.sha1(normalize_body(documented_source(code, docstring)).encode("utf-8")).hexdigest()`；对应 `lib/graph-diff.js:121-126` 的 `bodyHash`（但注意 Node 版接收完整 node 对象 `{sourceCode, docstring}`，Python 版直接接收 `code`/`docstring` 两个标量）。
- **`_tokens(text)`**（第 34-35 行）：`_TOKEN.findall(text or "")`，`_TOKEN = re.compile(r"\w+|[^\w\s]")`（第 16 行）；对应 `lib/graph-diff.js:147-149` 的 `tokens`（但 Node 版用 Unicode 属性类 `[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]`，见 `lib/graph-diff.js:147`，以还原 Python `\w` 的 Unicode 语义）。
- **`body_similarity(a, b)`**（第 38-44 行）：转 token 后空序列特判（都空返回 1.0，单边空返回 0.0），否则 `difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()`；对应 `lib/graph-diff.js:239-245` 的 `bodySimilarity`。
- **`unified_body_diff(old_lines, new_lines, label, n=2)`**（第 47-49 行）：`difflib.unified_diff(..., fromfile=f"a/{label}", tofile=f"b/{label}", n=n)`；对应 `lib/graph-diff.js:260-264` 的 `unifiedBodyDiff`（Node 版内部用 `documentedSource` 取行，Python 版直接收行数组）。
- **`main()`**（第 52-144 行）：随机种子固定为 `random.Random(20261027)`（第 53 行），保证基准可复现，依次生成四类用例：
  1. **similarity 用例**（第 56-86 行）：`sim_inputs` 含 13 组手写 + 30 组随机（`rng.randint(1,25)` 长、`["a","b","c","d","(",")","+","1","2"]` 字母表），每组产出 `{kind:"similarity", a, b, expected}`。
  2. **hash 用例**（第 88-103 行）：`hash_inputs` 含 6 组（含空字符串、仅空白、含 docstring、中文等），产出 `{kind:"hash", code, docstring, expected}`。
  3. **unified diff 用例**（第 105-126 行）：`diff_inputs` 含 9 组（含无末尾换行、纯新增、纯删除、多 hunk、超长插入），用 `old_s.splitlines(keepends=True)` 还原行，产出 `{kind:"unified", oldText, newText, label, expected}`。
  4. **随机 unified diff 用例**（第 128-142 行）：20 组，`n1/n2` 各 `rng.randint(0,12)`，行形如 `L{rng.randint(0,5)}\n`，label 固定 `"r"`。
  最终 `json.dump(cases, sys.stdout, ensure_ascii=False, indent=1)`（第 144 行）。
- **入口**（`__main__`，第 147-148 行）：调用 `main()`。

### test-fixtures/graphdiff-golden.json

纯数据文件，JSON 数组，共 499 行（即 `(13+30)+(6)+(9)+(20) = 78` 个用例）。每个元素形如第 1-7 行（similarity 空用例）。字段集合：

- similarity：`kind`, `a`, `b`, `expected`（数值，如 `0.6666666666666666`，第 30、36 行）。
- hash：`kind`, `code`, `docstring`, `expected`（sha1 十六进制串）。
- unified：`kind`, `oldText`, `newText`, `label`, `expected`（完整 unified diff 文本，含 `@@` 头与 `---`/`+++` 行）。

该文件是 `test-graphdiff.mjs` 的 **必需输入**（缺失即退出，见上），本身不导出任何符号。

## Architecture

本模块是「Python 原版生成基准 → Node 侧读基准对拍」的黄金对拍（golden testing）结构，外加一段组件级行为断言。整体框图如下（文件/类用 `()` 标出）：

```text
┌─────────────────────────────┐      generates       ┌──────────────────────────┐
│ gen-graphdiff-golden.py     │ ───────────────────► │ graphdiff-golden.json    │
│ (Python upstream oracle)    │   python ... > json  │ (78 golden cases)        │
└─────────────────────────────┘                      └────────────┬─────────────┘
                                                                   │ read (existsSync guard)
                                                                   ▼
┌─────────────────────────────┐      import       ┌──────────────────────────┐
│ test-graphdiff.mjs          │ ─────────────────► │ lib/graph-diff.js        │
│ (Node test harness)         │                    │ (ported difflib/hashlib) │
│  - golden loop (3 kinds)    │ ◄──── compare ──── │ bodySimilarity/bodyHash/ │
│  - component-level asserts  │      got vs exp    │ unifiedDiff/diffGraphs.. │
└─────────────────────────────┘                    └──────────────────────────┘
```

组件职责划分：

- `gen-graphdiff-golden.py`：充当「oracle」，用 Python 原生标准库（上游原版逻辑）算出权威期望值，是可信基准来源。
- `graphdiff-golden.json`：基准载体，连接 Python 侧与 Node 侧，固定随机种子保证可复现。
- `test-graphdiff.mjs`：测试执行体，分两段——前段（第 28-42 行）对拍逐位一致性，后段（第 58-107 行）断言 `diffGraphs`/`serializeDiff` 的组件级行为。两段都通过才会 `ALL PASS`。
- `lib/graph-diff.js`：被测系统（SUT），不在本模块但为本模块存在的理由；其全部公开符号均被 import（第 7-10 行）。

## Data Flow

**基准生成流（离线，CI 前或首次）：**

1. 运行 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`（测试头注释第 2-3、15 行规定）。
2. `main()` 用固定种子 `random.Random(20261027)` 构造输入，调用 Python 版 `body_similarity` / `body_hash` / `unified_body_diff` 算出 `expected`。
3. 全部用例 `json.dump` 到 stdout，`indent=1`，落到 `graphdiff-golden.json`。

**测试执行流（在线，每次运行 `node test-graphdiff.mjs`）：**

1. `goldenPath = test-fixtures/graphdiff-golden.json`；`fs.existsSync` 为否则报错 `process.exit(1)`（`test-graphdiff.mjs:13-17`）。
2. `JSON.parse` 出 `cases` 数组（`test-graphdiff.mjs:18`）。
3. 对拍循环：按 `c.kind` 把 `c.a/c.b`、`c.code/c.docstring`、`c.oldText/c.newText` 喂给对应的 `lib/graph-diff.js` 函数，得到 `got`，与 `c.expected` 比对（similarity 用 `1e-12` 容差，hash/unified 用严格相等）。
4. 组件级流：本地 `mk` 构造 `oldG`/`newG` 两个 `Map`（`test-graphdiff.mjs:68-82`），调 `diffGraphs(oldG, newG)` → `diff` 对象，再 `serializeDiff` → `s`（第 83-84 行），对 `s.body/s.edge/s.interface/s.renamed/s.added/s.counts` 做 8 条断言（第 86-94 行）。
5. 汇总 `pass`/`ok`，打印 `ALL PASS` 或 `HAS FAILURES`，退出码 0／1（第 96-107 行）。

数据流中值得注意的是 **字段语义桥接**：黄金文件里 hash 用例的键是 `code`/`docstring`（Python 标量约定），但 `test-graphdiff.mjs:34` 在调用 `bodyHash` 前把它们重新打包成 `{ sourceCode: c.code, docstring: c.docstring }`，因为 Node 版 `bodyHash` 接收的是完整 node 对象（`lib/graph-diff.js:121-126`）。

## Connections

- [[graph-diff]]：被测系统（SUT）`lib/graph-diff.js`，本模块的全部对拍与断言都围绕它的公开符号（`bodySimilarity`/`bodyHash`/`unifiedDiff`/`diffGraphs`/`serializeDiff` 等）展开。
- [[incremental]]：`lib/incremental.js` 是 `lib/graph-diff.js` 的主要消费方之一（第 17 行 import `diffGraphs`/`changedIds`/`graphDiffCounts`/`bodyHash`/`codeHash`），本模块的黄金对拍保证了 `lib/incremental.js` 赖以判断「是否重写文章」的组件级 diff 与上游一致。
- [[update-planner]]：`lib/update-planner.js` 同样 import `diffGraphs`/`changedIds`/`graphDiffCounts`/`codeHash`（第 19 行），把它升级成 `write/keep/delete/review` 四类 action；本模块的逐位一致性是其可靠性前提。

## Known Issues

- **`test-graphdiff.mjs` 冗余导入**（第 7-10 行）：`sequenceRatio`、`normalizeBody`、`documentedSource`、`truncateToTokens` 四个符号被 import 但整个脚本未使用，属死代码；保留它们可能是为了将来补测试，但当前不构成断言。
- **`graphdiff-golden.json` 必须离线预生成**：脚本在文件缺失时直接 `process.exit(1)`（第 14-17 行），没有内置「按需调用 Python 生成」的回退；CI 必须把 `gen-graphdiff-golden.py` 的产出作为构建产物纳入，否则测试无法启动。没有自动校验「基准是否过期」——若 `lib/graph-diff.js` 逻辑被有意改动而基准未重生成，对拍会全量失败而非给出精细化提示。
- **`bodyHash` 的 Python/Node 入参不一致隐患**：Python 版 `body_hash(code, docstring)` 收标量（`gen-graphdiff-golden.py:30-31`），Node 版 `bodyHash(node)` 收对象（`lib/graph-diff.js:121-126`），桥接发生在 `test-graphdiff.mjs:34`。若有人误在黄金生成脚本里改成收对象，两边会对不上。目前由测试逻辑中的手动包装维持一致，无类型约束保护。
- **相似度容差较宽**：`similarity` 用例只验证 `Math.abs(got - c.expected) < 1e-12`（第 31 行），依赖 Python `difflib` 与 Node 移植的浮点运算在 double 精度下完全一致；这属于设计预期（逐位对齐），但意味着若该精度被打破（如一方改用不同 ratio 公式），将产生大量边界失败。
- **无独立断言文件/框架**：测试是零依赖的裸 Node 脚本（无 `node:test`、`mocha` 等），通过 `console.log` + `process.exit(1)` 表达结果；尚未接入 `package.json` 的统一测试入口（脚本内无 `npm test` 钩子）。
