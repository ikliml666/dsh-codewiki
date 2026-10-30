---
title: test_graph_symbols
type: module
source_files:
  - test-graphdiff.mjs
  - test-symbols.mjs
  - test-cwd-paths.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - lib/graph-diff.js
  - lib/symbols.js
  - index.js
tags: [test, graph-diff, symbols, path-utils, golden, ast, regex-fallback]
---

## Overview

`test_graph_symbols` 不是单一文件，而是围绕「符号级图 diff / 多语言符号提取 /
路径归一化工具」三块能力的一组测试与对拍基准，分四个来源：

- `test-graphdiff.mjs` — 对拍测试，验证 `lib/graph-diff.js`（从 FSoft-AI4Code/CodeWiki
  的 `graph_diff.py` 纯标准库移植）与上游 Python 原版逐位一致；并做组件级 diff 的
  改名配对与 interface/body/edge 分类断言。
- `test-symbols.mjs` — 验证 `lib/symbols.js` 的多语言 AST 符号提取与 import 依赖边，
  以及 WASM 不可用时的正则降级（regex fallback）。
- `test-cwd-paths.mjs` — 验证 0.2.3 路径修复：MSYS 盘符路径归一化、Windows 路径的
  `cw` 三态、不存在路径的干净报错。被测逻辑位于 `index.js` 的 `normalizeCwd` /
  `resolveBinary` / `cw` execute 路径。
- `test-fixtures/gen-graphdiff-golden.py` + `test-fixtures/graphdiff-golden.json` —
  对拍黄金基准：Python 侧用原生 `difflib` + `hashlib` 喂同一批输入产出期望值，
  Node 侧比对。黄金 JSON 由 `python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`
  生成（种子固定 `20261027`，见 `gen-graphdiff-golden.py:53`）。

这三块共享同一个「组件记录契约」：Node 形状为
`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`
（见 `lib/graph-diff.js:8-10` 与 `lib/symbols.js:13-14`）。

## Key Components

### 测试驱动：`test-graphdiff.mjs`（107 行）

- `splitKeepEnds(s)` — `test-graphdiff.mjs:23-26`，把字符串按 `/\n/` 切分并保留行尾换行，
  用于把 `unified` 用例的 `oldText`/`newText` 转成 `unifiedDiff` 要求的行数组。
- 顶层导入 `test-graphdiff.mjs:7-10`：从 `./lib/graph-diff.js` 引入
  `bodySimilarity, bodyHash, unifiedDiff, diffGraphs, serializeDiff, sequenceRatio,
  normalizeBody, documentedSource, truncateToTokens`。
- 对拍循环 `test-graphdiff.mjs:28-42`：遍历黄金 JSON，按 `kind` 分三类比对：
  - `similarity` → 比 `bodySimilarity(c.a, c.b)`，容忍 `|got-expected| < 1e-12`（`test-graphdiff.mjs:30-32`）。
  - `hash` → 比 `bodyHash({ sourceCode: c.code, docstring: c.docstring })` 与 `c.expected`（`test-graphdiff.mjs:34-36`）。
  - `unified` → 比 `unifiedDiff(splitKeepEnds(c.oldText), splitKeepEnds(c.newText), \`a/${c.label}\`, \`b/${c.label}\`, 2)` 与 `c.expected`（`test-graphdiff.mjs:38-40`）。
- `mk(id, name, src, opts)` — `test-graphdiff.mjs:58-66`，构造一个最小 Node 记录（`id/name/kind/relativePath/sourceCode/docstring/parameters/baseClasses/dependsOn`），供 `diffGraphs` 用。
- 组件级 diff 断言 `test-graphdiff.mjs:68-94`：构建 `oldG`/`newG` 两个 `Map`，调 `diffGraphs(oldG, newG)` 与 `serializeDiff(d)`，断言 body/edge/interface 分类、
  未变不登记、改名配对（`renamed['a.js#gone'] === 'a.js#renamed'`）、改名后不记为
  deleted/added、新增登记、`counts` 自洽。
- 序列化往返检查 `test-graphdiff.mjs:102-104`：`JSON.parse(JSON.stringify(s))` 后确认
  `counts`、`added`（数组）、`renamed`（object）字段齐全。

### 测试驱动：`test-symbols.mjs`（362 行）

- `check(label, fn)` / `checkAsync(label, fn)` — `test-symbols.mjs:17-36`，同步/异步断言包装，
  成功 `pass++` 并打印 `PASS`，失败入 `fails` 并打印 `FAIL`。
- `ex = new SymbolExtractor()` + `await ex.init()` — `test-symbols.mjs:38-39`，初始化后
  若 `!ready` 则打印 `SKIP` 并 `process.exit(0)`（`test-symbols.mjs:42-45`），因为 AST
  相关用例依赖 web-tree-sitter。
- 多语言 `extractFile(relPath, content)` 断言（JS/TS、Python、Go、Rust、Java、C#、C）
  —— `test-symbols.mjs:63-211`：断言类名/方法名/`kind`/`id` 形如 `src/widget.js#Widget.render`、
  参数剥离默认值与 rest（`test-symbols.mjs:75-81`）、方法源码切片含完整函数体
  （`test-symbols.mjs:83-87`）、docstring 与 baseClasses（`test-symbols.mjs:107-118`）。
- 边界用例 `test-symbols.mjs:213-226`：未知扩展名返回 `[]` 不抛错、语法错误仍能提取
  正常符号、空文件返回 `[]`。
- import 边相关纯函数断言 `test-symbols.mjs:229-269`：
  - `extractImportSpecs('a.js', src)` 覆盖 `import` / `import './css'` / `require('./d')`（`test-symbols.mjs:229-238`）。
  - `resolveSpec(from, spec, known)` 相对路径补全（`test-symbols.mjs:240-245`）、Python 点号模块（`test-symbols.mjs:247-250`）、找不到返回 `null`（`test-symbols.mjs:252-254`）。
  - `resolveImportEdges(graph, byFile, files)` 连线到目标文件组件（`test-symbols.mjs:256-269`）——
    经 `extractRepoGraph(list, { extractor: ex })` 得到 `graph` 与 `byFile`，再确认
    `edges[0]` 的 `from/to` 与 `fa.dependsOn` 含 `src/b.js#fb`。
- 真实仓库自检 `test-symbols.mjs:271-286`：对 `index.js/lib/symbols.js/lib/graph-diff.js/client.js`
  跑 `extractRepoGraph`，断言 `graph.size > 30`、`stats.failed === 0`、`id === \`${relativePath}#${name}\``。
- 正则降级断言 `test-symbols.mjs:288-351`：
  - `regexExtract(relPath, src, lang)` 认出 JS 函数/类/箭头函数、忽略注释假函数（`test-symbols.mjs:292-317`）；Python/Go/Rust 各自认出定义（`test-symbols.mjs:319-326`）；未知语言返回 `[]`（`test-symbols.mjs:328-331`）。
  - `new SymbolExtractor({ vendorDir: '.no-such-vendor' })` 逼 `getParser` 失败 → `extractFile` 走正则兜底，并记账 `stats.regex`/`stats.regexLanguages`（`test-symbols.mjs:333-342`）。
  - WASM 可用时不走正则（`stats.regex` 为 0，`stats.parsed >= 1`，`test-symbols.mjs:344-351`）。
- 语言表断言 `test-symbols.mjs:353-359`：常见扩展名都在 `SUPPORTED_EXTS`，`.tsx → typescript`，
  `Object.keys(LANG_RULES).length >= 15`。

### 测试驱动：`test-cwd-paths.mjs`（71 行，路径工具）

- 加载 `./index.js` 并 `plugin.apply(ctx, {})` 拿到注册的 `cw` tool（`test-cwd-paths.mjs:5-22`）。
- MSYS 路径归一化复现：`'/'+repoWin.replace(/^([A-Za-z]):\//, ... )` 把 `E:/x` 转 `/e/x`
  （`test-cwd-paths.mjs:22`），再 `cw.execute({ cwd: msys, args: ['path'] })`，断言
  stdout 含 `.codewiki`（`test-cwd-paths.mjs:30-45`）。
- Windows 路径 `cw.execute({ cwd: repoWin, args: ['status'] })` 三态断言：exitCode 0
  且不含 `No wiki found`（`test-cwd-paths.mjs:47-57`）。
- 不存在路径 `cw.execute({ cwd: '/q/nonexistent-repo-xyz', args: ['status'] })` 必须抛
  `cwd 不存在` 错误（`test-cwd-paths.mjs:61-69`）。

### 黄金基准：`test-fixtures/gen-graphdiff-golden.py`（148 行）

- `normalize_body(text)` `:19-20` / `documented_source(code, docstring)` `:23-27` /
  `body_hash(code, docstring)` `:30-31` — 与 `lib/graph-diff.js` 的 `normalizeBody` /
  `documentedSource` / `bodyHash` 语义对齐（sha1）。
- `_tokens(text)` `:34-35`（`\w+|[^\w\s]` 正则）、`body_similarity(a, b)` `:38-44`
  （`difflib.SequenceMatcher(None, ta, tb, autojunk=False).ratio()`）。
- `unified_body_diff(old_lines, new_lines, label, n=2)` `:47-49`（`difflib.unified_diff`）。
- `main()` `:52-145`：种子 `random.Random(20261027)`（`:53`），生成 similarity（含 30 条
  随机，`:72-78`）、hash（`:88-103`）、unified（含无末尾换行/纯新增/纯删除/多 hunk，
  `:105-116` 与 20 条随机 diff `:128-142`）三类用例，JSON 写 stdout。

### 被测源：`lib/graph-diff.js`（578 行）关键导出

- 变更分类常量 `CLASS_ADDED/CLASS_DELETED/CLASS_IFACE/CLASS_BODY/CLASS_EDGE/CLASS_RENAMED`
  `:14-19`；`DIFF_TRUNCATED_MARKER` `:21`。
- `normalizeBody(text)` `:28-30`、`stripComments(text)` `:69-100`、`codeHash(node)` `:108-111`、
  `documentedSource(node)` `:114-119`、`bodyHash(node)` `:121-126`、`signature(node)` `:128-134`、
  `signatureChanged(a, b)` `:136-145`。
- `sequenceRatio(aArr, bArr)` `:229-236`、`bodySimilarity(a, b)` `:239-245`、
  `approxTokens(text)` `:247-249`、`truncateToTokens(text, maxTokens)` `:251-257`。
- `unifiedDiff(aLines, bLines, fromFile, toFile, n, lineterm)` `:327-355`、
  `unifiedBodyDiff(oldNode, newNode, label)` `:358-362`。
- `pairRenames(deleted, added, oldGraph, newGraph, tauRen)` `:371-407`（按 body 相似度贪心配对）。
- `emptyGraphDiff()` `:413-423`、`graphDiffCounts(d)` `:425-434`、`changedIds(d)` `:436-440`、
  `isDiffEmpty(d)` `:442-444`、`diffGraphs(oldGraph, newGraph, opts)` `:447-564`、
  `serializeDiff(d)` `:567-578`。

### 被测源：`lib/symbols.js`（884 行）关键导出

- `DEFAULT_VENDOR_DIR` `:25`、`LANG_RULES` `:36-271`（16 种语言的 wasm/exts/符号规则表）、
  `SUPPORTED_EXTS` `:273-276`（由 `LANG_RULES` 填充）。
- `regexExtract(relPath, content, lang)` `:374-440`、`parseParamList(text)` `:443-466`、
  `REGEX_RULES` `:302-368`（正则降级规则表）。
- `class SymbolExtractor` `:472-779`：构造器 `:473-481`（`vendorDir`/`wasmDir`/`parsers`/
  `ParserCtor`/`LanguageCtor`/`initError`/`stats`）；`vendorImport(sub)` `:484-495`、
  `init()` `:498-519`、`getParser(lang)` `:521-542`、`resolveWasmDir()` `:544-547`、
  `extractFile(relPath, content)` `:551-594`（AST 优先，失败/零符号/解析异常均退正则）、
  `walk(node, rule, relPath, content, out, container)` `:597-695`、
  `findArrow(decl)` `:697-707`、`findDeclarator(node)` `:710-719`、`stripCallSuffix(text)` `:722-727`、
  `fieldText(node, field)` `:729-737`、`parseParams(text)` `:739-741`、`parseBases` `:743-748`、
  `sliceSource(node, content)` `:751-757`、`extractDoc(node, rule, content)` `:759-774`、
  `componentId(relPath, name)` `:776-778`。
- `extractRepoGraph(files, opts)` `:785-805`（返回 `{ graph, byFile, skipped, extractor, ready, stats }`）。
- `resolveImportEdges(graph, byFile, files)` `:810-833`、`extractImportSpecs(_file, text)` `:837-847`、
  `resolveSpec(fromFile, spec, known)` `:849-884`。

### 被测源：`index.js` 路径相关（被 `test-cwd-paths.mjs` 覆盖）

- `normalizeCwd(input)` `:63-68` — win32 下把 `/e/...` MSYS 路径转 `E:/...`；非 win32 原样返回。
- `resolveBinary(cfg)` `:164-184` — PATH 探测优先（`which`/`where cw`），找不到回退 `bin/cw(.exe)`，
  再不行返回 `'cw'`。`test-cwd-paths.mjs` 通过 `cw.execute` 的 `cw path` 成功间接验证其归一化与探测生效。
- `cw` tool 的 `execute` 路径（`cw.execute({ cwd, args }, signal)`）— 路径归一化后跑 `cw`
  CLI，`cw path` 返回 `<repo>/.codewiki`、`cw status` 返回三态；cwd 不存在抛 `cwd 不存在`。

## Architecture

三个测试各覆盖一条相对独立的链路；其中 graph-diff 与 symbols 共用组件记录契约并服务于
index.js 的增量编译，path-utils 则独立验证 cw 包装层对路径的归一化。

```text
┌──────────────────────────────────────────────────────────────┐
│ test-graphdiff.mjs                                            │
│   splitKeepEnds / mk / diffGraphs / serializeDiff 断言         │
└───────┬──────────────────────────────┬───────────────────────┘
        │ 对拍期望值                    │ 组件级 diff 分类
        ▼                              ▼
┌──────────────────────┐      ┌─────────────────────────────┐
│ gen-graphdiff-        │      │ lib/graph-diff.js           │
│ golden.py → JSON      │      │ sequenceRatio/bodySimilarity│
│ (difflib + hashlib)   │      │ unifiedDiff/pairRenames/    │
│                       │      │ diffGraphs/serializeDiff    │
└──────────────────────┘      └──────────────┬──────────────┘
                                            │ 消费 Node 记录
                                            ▼
┌──────────────────────────────────────────────────────────────┐
│ test-symbols.mjs                                     │
│   SymbolExtractor.extractFile / regexExtract /       │
│   extractRepoGraph / resolveImportEdges              │
└───────┬────────────────────────────┬────────────────┘
        │ AST (web-tree-sitter)      │ 正则降级 (REGEX_RULES)
        ▼                            ▼
┌──────────────────────┐      ┌─────────────────────────────┐
│ lib/symbols.js        │      │ stats.regex 记账           │
│ LANG_RULES / walk /   │      │ (vendorDir 找不到时触发)   │
│ extractImportSpecs    │      └─────────────────────────────┘
└───────────┬──────────┘
            │ 产出 graph: Map<id,Node>
            ▼
┌──────────────────────────────────────────────────────────────┐
│ index.js (liveConfig/diffGraphs/extractRepoGraph 被调用)       │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ test-cwd-paths.mjs ── apply(plugin) ──► index.js cw.execute    │
│   MSYS(E:/x→/e/x)  │ Windows status 三态  │ 不存在路径报错     │
│        ▼                  ▼                    ▼               │
│   normalizeCwd ─► resolveBinary ─► runCw(spawn cw CLI)         │
└──────────────────────────────────────────────────────────────┘
```

`lib/graph-diff.js:8-10` 与 `lib/symbols.js:13-14` 声明了同一套 Node 形状，是 symbols 的
输出能直接喂给 graph-diff 的前提：`extractRepoGraph` 返回的 `graph: Map<id, node>` 的
`node` 即此契约记录，故 `diffGraphs(oldGraph, newGraph)` 可对其取 `sourceCode`/`docstring`/
`parameters`/`baseClasses`/`dependsOn` 做比较。

## Data Flow

**graph-diff 对拍流（`test-graphdiff.mjs`）：**
1. 运行前 `test-graphdiff.mjs:12-17` 检查黄金文件是否存在，缺失则提示先跑 Python 生成并 `process.exit(1)`。
2. `JSON.parse(fs.readFileSync(goldenPath))` 读入 `cases`（`test-graphdiff.mjs:18`）。
3. 按 `c.kind` 分发比对：`similarity` 走 `bodySimilarity`（`test-graphdiff.mjs:30`）、`hash` 走 `bodyHash`（`test-graphdiff.mjs:34`）、`unified` 走 `unifiedDiff`（`test-graphdiff.mjs:38`，入参先用 `splitKeepEnds` 切行）。
4. `pass`/`fails` 计数，`fails` 非空时打印前 5 条并 `process.exit(1)`（`test-graphdiff.mjs:44-53`）。
5. 组件级分支：手工 `mk` 出 `oldG`/`newG` 两个 `Map`，`diffGraphs` 算出 `d`，`serializeDiff(d)` 得 `s`，逐项断言 body/edge/interface/renamed/added 分类与 `counts` 自洽（`test-graphdiff.mjs:68-94`）。
6. 最后 `JSON.parse(JSON.stringify(s))` 验证序列化往返字段齐全（`test-graphdiff.mjs:102-104`）。

**symbols 提取流（`test-symbols.mjs`）：**
1. `new SymbolExtractor(); await ex.init()`（`test-symbols.mjs:38-39`）；`init` 失败则 `SKIP` 退出（`test-symbols.mjs:42-45`）。
2. 各语言用例调 `ex.extractFile(relPath, src)`（`test-symbols.mjs:38` 起），AST 解析成功后 `walk` 递归产出 `recs`（`lib/symbols.js:551-594, 597-695`）。
3. import 边用例：构造 `{path, content}` 列表 → `extractRepoGraph(list, {extractor:ex})` 得 `graph`/`byFile`（`lib/symbols.js:785-805`）→ `resolveImportEdges` 解析 `extractImportSpecs` 得到的 spec 经 `resolveSpec` 落库成 `node.dependsOn`（`lib/symbols.js:810-833`）。
4. 正则降级：把 `vendorDir` 指到不存在目录（`test-symbols.mjs:335`），`getParser` 失败 → `extractFile` 走 `regexExtract` 兜底并记 `stats.regex`/`stats.regexLanguages`（`lib/symbols.js:556-565`）。

**cwd 路径流（`test-cwd-paths.mjs`）：**
1. `plugin.apply(ctx, {})` 注册 `cw` tool（`test-cwd-paths.mjs:20`）；取 `registered.cw`（`test-cwd-paths.mjs:22`）。
2. MSYS：`msys = '/'+repoWin.replace(/^([A-Za-z]):\//, ...)`（`test-cwd-paths.mjs:22`）→ `cw.execute({cwd: msys, args:['path']})` 经 `normalizeCwd` 归一化后再跑 `cw path`，断言 stdout 含 `.codewiki`（`test-cwd-paths.mjs:30-45`）。
3. Windows：`cw.execute({cwd: repoWin, args:['status']})` 断言 exitCode 0 且不含 `No wiki found`（`test-cwd-paths.mjs:47-57`）。
4. 不存在路径：断言抛 `cwd 不存在`（`test-cwd-paths.mjs:61-69`），由 `cw.execute` 路径内的校验触发。

## Connections

- [[graph-diff]] — `lib/graph-diff.js` 的移植实现，`test-graphdiff.mjs` 直接对拍并组件级断言。
- [[symbols]] — `lib/symbols.js` 的符号提取与 import 边，`test-symbols.mjs` 覆盖 AST + 正则降级。
- [[index]] — `index.js` 的 `normalizeCwd`/`resolveBinary`/`cw.execute` 由 `test-cwd-paths.mjs` 覆盖；同时 index.js 在增量编译里调用 `diffGraphs`/`extractRepoGraph`（见 `index.js:153-155`）。
- [[update-planner]] / [[incremental]] — 消费 `diffGraphs` 产出的变更集做模块规划与快照增量；本模块的对拍保证其变更判定的精度与上游一致。
- [[cluster]] — 依赖 `extractRepoGraph` 的 `graph` 做模块聚类（`index.js:17` 引入 `clusterComponents`）。

## Known Issues

1. **`test-symbols.mjs` 在缺 web-tree-sitter 时整体 SKIP**（`test-symbols.mjs:42-45`）：AST 用例全部跳过，只留下正则降级与纯函数断言；这意味着 CI 若没装 `vendor/tree-sitter`，多语言 AST 提取路径实际上没被回归。
2. **`test-cwd-paths.mjs` 硬编码 Windows 仓库路径默认值**（`test-cwd-paths.mjs:8`：`E:/ik/Documents/.../Wxxy-CampusLogin`），且依赖真实 `cw` 二进制与 PATH 探测；非 win32 平台下 `normalizeCwd` 原样返回（`index.js:52`），该用例在 POSIX 上只验证「不报错」而非真实归一化。
3. **`lib/git-paths.js` 无专属测试**：`test_graph_symbols` 标题含 "path utilities"，但实际只覆盖了 `index.js` 内的 `cw` 路径处理（`normalizeCwd`/`resolveBinary`），并未测试 `lib/git-paths.js` 的 `decodeGitPath`/`withQuotepathOff`/`GIT_QUOTEPATH_OFF`（`lib/git-paths.js:20-79`）。八进制转义路径解码（`decodeGitPath`，`lib/git-paths.js:37-72`）目前靠手动/集成覆盖，缺单元测试。
4. **黄金基准依赖外部 Python 生成**：`test-graphdiff.mjs` 若缺失 `graphdiff-golden.json` 会直接 `exit(1)`（`test-graphdiff.mjs:14-17`），而该 JSON 需手动跑 `gen-graphdiff-golden.py` 生成（固定种子 `20261027`，`gen-graphdiff-golden.py:53`）；改了 `lib/graph-diff.js` 的算法后必须同步重生成基准，否则对拍会误报。
5. **正则降级精度低于 AST**：`regexExtract` 的源码区间是「定义行到下一定义行（末符号最多 60 行）」（`lib/symbols.js:374-439`），与 AST 的精确字节切片（`sliceSource`，`lib/symbols.js:751-757`）不同；`test-symbols.mjs:292-317` 仅断言 `sourceCode.includes('return a + b')`，未严格比对切片边界。
