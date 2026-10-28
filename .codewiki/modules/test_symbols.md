---
title: test_symbols
type: module
source_files:
  - test-symbols.mjs
  - lib/symbols.js
  - lib/graph-diff.js
  - lib/cluster.js
tags: [test, symbols, ast, tree-sitter, repo-graph, import-edges]
---

## Overview

`test-symbols.mjs` 是 `lib/symbols.js` 的单元测试套件，专门验证两件事：

1. **符号提取（symbol extraction）**：用 web-tree-sitter（WASM 语法）把多种语言的源码解析成结构化的「组件记录」（class / method / function / arrow-function 等），覆盖 JS/TS、Python、Go、Rust、Java、C#、C 共七种语言加真实仓库自检。
2. **仓库依赖图构建（repo graph building）**：把多个文件的 import 语句解析成跨文件的依赖边（`resolveImportEdges`），落到组件层的 `dependsOn` 上。

测试套件还重点关注**降级行为**：当 web-tree-sitter 不可用（未安装 / ABI 不匹配 / 语法细则没覆盖某语言新写法）时，`SymbolExtractor` 必须退到正则兜底（`regexExtract`），且必须把降级次数记进 `stats.regex` / `stats.regexLanguages`，而不是像早期实现那样静默 `return []` 让整块语言的模块凭空消失（见 `lib/symbols.js` 第 288–296 行注释）。

测试入口逻辑（`test-symbols.mjs` 第 14–45 行）：先 `new SymbolExtractor()` + `await ex.init()`，若 `web-tree-sitter` 不可用则打印 `SKIP` 并 `process.exit(0)`（第 42–45 行），否则逐个跑 `check` / `checkAsync` 用例，最后打印 `N passed, M failed` 并以失败数作为退出码（第 361–362 行）。

被测模块导出的全部公开符号（`test-symbols.mjs` 第 8–12 行 import）：
`SymbolExtractor`、`extractRepoGraph`、`resolveImportEdges`、`extractImportSpecs`、`resolveSpec`、`LANG_RULES`、`SUPPORTED_EXTS`、`regexExtract`，外加未直接 import 但被间接验证的 `DEFAULT_VENDOR_DIR`、`parseParamList`、`REGEX_RULES`。

## Key Components

测试套件按主题分块，每块由一个或多个 `check` / `checkAsync` 调用组成（辅助函数见 `test-symbols.mjs` 第 17–36 行：`check` 同步、`checkAsync` 异步，内部 `try/catch` 收集 `fails`，通过则 `pass++` 并打印 `PASS` / `FAIL`）。

### 1. 多语言 AST 提取用例（test-symbols.mjs 第 47–211 行）

| 用例标签 | 源码行 | 验证点 |
| --- | --- | --- |
| `JS：类 + 方法 + 函数 + 箭头函数全部提取` | 63–73 | `extractFile('src/widget.js', jsSrc)` 返回 7 个 name（含 `Widget.constructor` / `Widget.helper`），`cls.kind==='class'`、`m.kind==='method'`、`m.relativePath`、`m.id==='src/widget.js#Widget.render'` |
| `JS：参数剥离默认值与 rest` | 75–81 | `standalone` 参数 `['a','b','rest']`（丢弃 `=2` 与 `...`）；`Widget.render` 参数 `['count','opts']` |
| `JS：方法源码切片包含完整函数体` | 83–87 | `m.sourceCode` 含 `render(count, opts = {}) { return count }` |
| `Python：类/方法/函数 + docstring` | 107–118 | `Service.docstring==='Service docs.'`、`baseClasses.sort()===['Base','Mixin']`、`Service.run` 为 method、`top.docstring==='Top docs.'`、`Service.arun` 异步方法被提取 |
| `Go：函数 + 方法` | 135–142 | `New` 顶层函数、`Server.Start` 方法（`start.kind==='method'`） |
| `Rust：impl 块内方法 + 顶层函数` | 157–164 | `parse` 顶层函数、`Config.load` 方法 |
| `Java：类/方法/构造器` | 177–182 | `Repo`、`Repo.list` 被提取 |
| `C#：namespace 内类与方法` | 193–197 | `Client.Send` 被提取 |
| `C：struct + 函数` | 206–211 | `Point`、`add` 被提取 |

### 2. 边界用例（test-symbols.mjs 第 213–226 行）

- `未知扩展名返回空数组，不抛错`（第 214–217 行）：`extractFile('README.md', '# hi')` 返回 `[]`。
- `语法错误不抛错，正常符号仍提取`（第 219–222 行）：`src/broken.js` 含不完整 `function (`，但 `ok` 仍被提取。
- `空文件返回空数组`（第 224–226 行）：`extractFile('src/empty.py', '')` 返回 `[]`。

### 3. import 边解析用例（test-symbols.mjs 第 228–269 行）

- `extractImportSpecs 覆盖多种语句`（第 229–238 行）：验证 `import x from` / `import './c.css'` / `require('./d')` 三种 spec 都被收集（被测函数 `lib/symbols.js` 第 837–847 行）。
- `resolveSpec 相对路径带补全`（第 240–245 行）：`./b`→`src/b.js`、`./b.js`→`src/b.js`、`./sub`→`src/sub/index.ts`（被测函数 `lib/symbols.js` 第 849–884 行）。
- `resolveSpec Python 点号模块`（第 247–250 行）：`app.pkg.mod`→`app/pkg/mod.py`。
- `resolveSpec 找不到返回 null`（第 252–254 行）：`lodash` 在已知集合外返回 `null`。
- `resolveImportEdges 连线到目标文件组件`（第 256–269 行）：构造 `src/a.js`→`src/b.js` 的 Map，经 `extractRepoGraph` 后用 `resolveImportEdges(graph, byFile, files)` 得到 `edges.length===1`，`edges[0].from/to` 正确，且 `fa.dependsOn.includes('src/b.js#fb')`（被测函数 `lib/symbols.js` 第 810–833 行）。

### 4. 真实仓库自检（test-symbols.mjs 第 271–286 行）

`本插件自身源码可被完整提取`（第 272–286 行）：读取 `index.js`、`lib/symbols.js`、`lib/graph-diff.js`、`client.js` 四个文件喂给 `extractRepoGraph`，断言 `graph.size > 30`、`stats.failed === 0`，且每个节点 `id === `${node.relativePath}#${node.name}``、源码非空。

### 5. 正则降级用例（test-symbols.mjs 第 288–331 行）

- `regexExtract：JS 认出函数/类/箭头函数`（第 292–317 行）：注释里的 `function fake()` 不该被认成定义；`addItem`/`Cart`/`helper`（箭头函数）各自被认出；记录形状与 AST 路径一致（`id`、`kind==='function'`、`parameters`、`sourceCode`、`dependsOn:[]`、`baseClasses:[]`）。被测函数 `lib/symbols.js` 第 374–440 行。
- `regexExtract：Python/Go/Rust 各自认出定义`（第 319–326 行）。
- `regexExtract：无规则的语言返回空且不抛错`（第 328–331 行）：`unknown-lang` 返回 `[]`、空 JS 返回 `[]`。

### 6. WASM 降级链路用例（test-symbols.mjs 第 333–351 行）

- `WASM 不可用时 extractFile 自动走正则`（第 333–342 行）：用 `new SymbolExtractor({ vendorDir: '.no-such-vendor' })` 逼 `getParser` 全部失败，断言仍能由正则兜出 `addItem`，且 `broken.stats.regex===1`、`broken.stats.regexLanguages.javascript===1`（被测逻辑 `lib/symbols.js` 第 556–565 行）。
- `WASM 可用时不走正则`（第 344–351 行）：正常环境下断言 `stats.regex` 为假、`stats.parsed >= 1`。

### 7. 语言表覆盖用例（test-symbols.mjs 第 353–359 行）

`语言表覆盖常见扩展名`：断言 `.js/.ts/.tsx/.py/.go/.rs/.java/.cs/.c/.cpp/.rb/.php/.kt/.scala/.dart/.sh/.lua` 在 `SUPPORTED_EXTS` 中，`SUPPORTED_EXTS.get('.tsx')==='typescript'`，`Object.keys(LANG_RULES).length >= 15`（被测导出 `lib/symbols.js` 第 36–276 行）。

### 被测模块核心公开符号（lib/symbols.js）

- `SymbolExtractor` 类（第 472–779 行）：构造器接收 `{ vendorDir, wasmDir }`，`stats` 初始 `{ files:0, parsed:0, failed:0, languages:{} }`（第 480 行），另带 `parsers` / `ParserCtor` / `LanguageCtor` / `initError`。
  - `init()`（第 498–519 行）：惰性导入 `web-tree-sitter`，成功返回 `true`，失败置 `initError` 返回 `false`。
  - `getParser(lang)`（第 521–542 行）：语法缓存，加载失败静默降级返回 `null`。
  - `extractFile(relPath, content)`（第 551–594 行）：核心入口，按扩展名取 lang，AST 不可用或零符号时退到 `regexExtract`。
  - `walk(...)`（第 597–695 行）：递归收集容器与方法，处理箭头函数（`rule.arrow`，第 669–690 行）。
  - `findArrow` / `findDeclarator` / `stripCallSuffix` / `fieldText` / `parseParams` / `parseBases` / `sliceSource` / `extractDoc` / `componentId`（第 697–778 行）。
- `extractRepoGraph(files, opts)`（第 785–805 行）：批量提取，返回 `{ graph, byFile, skipped, extractor, ready, stats }`。
- `resolveImportEdges(graph, byFile, files)`（第 810–833 行）：把 import 解析成文件级边并回填组件 `dependsOn`。
- `extractImportSpecs(_file, text)`（第 837–847 行）：正则收集所有 import spec。
- `resolveSpec(fromFile, spec, known)`（第 849–884 行）：相对路径 / Python 点号 / Rust `use` / C `#include` 解析。
- `regexExtract(relPath, content, lang)`（第 374–440 行）：正则兜底提取，无规则语言返回 `[]`。
- `parseParamList(text)`（第 443–466 行）：参数文本→参数名数组（默认值 / 类型 / rest 剥离）。
- 常量：`DEFAULT_VENDOR_DIR`（第 25 行）、`LANG_RULES`（第 36–271 行）、`SUPPORTED_EXTS`（第 273–276 行）、`WASM_FILE_OVERRIDE`（第 279 行）、`REGEX_RULES`（第 302–368 行）、`REGEX_MAX_LINES`（第 371 行）、`IMPORT_RE`（第 835 行）。

## Architecture

测试套件直接驱动 `lib/symbols.js` 的两个对外入口：`SymbolExtractor.extractFile`（单文件）与 `extractRepoGraph`（多文件）。两者都依赖同一套「组件记录形状」（与 `lib/graph-diff.js` 第 10 行的 Node 契约一致：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`），从而把提取结果喂给下游 `lib/cluster.js` 做模块聚类。

```text
                 test-symbols.mjs
                        │
        ┌───────────────┴───────────────┐
        │  check / checkAsync (17–36)    │
        └───────────────┬───────────────┘
                        │ 调用被测
        ┌───────────────┴───────────────┐
        ▼                               ▼
 extractFile (551)              extractRepoGraph (785)
        │                               │
        │  getParser (521)              │ 循环 extractFile
        ▼                               ▼
   web-tree-sitter?                build graph Map / byFile
   是 ─┴─ 否                         │
   ▼    ▼                            │
 walk(597)  regexExtract(374)        │
   │  解析 AST                       │
   ▼    ▼                            ▼
 component records ── 同形状 ──► resolveImportEdges (810)
                                     │ 回填 dependsOn
                                     ▼
                              graph-diff Node 形状 ──► cluster.js (formatComponents)
```

要点：
- AST 路径（`walk`）与正则路径（`regexExtract`）产出**完全相同形状**的记录，因此下游消费者（`graph-diff`、`cluster`）不必感知降级来源（测试第 309 行明确断言）。
- 降级开关在 `extractFile` 第 556–565 行（WASM 不可用）与第 584–592 行（AST 成功但零符号），二者都记 `stats.regex` / `stats.regexLanguages`。
- `resolveImportEdges` 是独立的纯函数，测试里用构造的 2 文件 Map 直接验证，不依赖真实文件系统。

## Data Flow

以 `JS：类 + 方法 + 函数 + 箭头函数全部提取`（第 63–73 行）为例，单条用例的数据流：

1. 测试构造 `jsSrc` 字符串（第 48–62 行），调用 `ex.extractFile('src/widget.js', jsSrc)`。
2. `extractFile` 取扩展名 `.js` → `lang='javascript'`（第 552–554 行）。
3. `getParser('javascript')` 加载 `tree-sitter-javascript.wasm`；本测试套件要求 web-tree-sitter 可用，否则在入口 `SKIP`（第 42–45 行）。
4. `walk` 递归：`class_declaration` → 容器 `Widget`（`kind='class'`，第 602–624 行）；其中 `method_definition` `render`/`helper`/构造器归属为 `Widget.render` 等方法（`kind='method'`，第 626–665 行）；顶层 `function_declaration` → `standalone`；`lexical_declaration` 内的箭头函数 → `arrowFn`（第 669–690 行）；`export default function` → `defaulted`。
5. 每个记录带 `sourceCode`（按节点字节区间切片，`sliceSource` 第 751–757 行）、`parameters`（`parseParamList` 剥离默认值与 rest）。
6. 测试对返回数组断言 `names` 排序后 === 预期 7 成员、`Widget.kind==='class'`、`Widget.render.id==='src/widget.js#Widget.render'`。

import 边的数据流（第 256–269 行）：

1. 构造 `Map([['src/a.js', ...], ['src/b.js', ...]])`，转成 `{ path, content }` 列表。
2. `extractRepoGraph(list, { extractor: ex })` → `{ graph, byFile, stats }`。
3. `resolveImportEdges(graph, byFile, files)`：对 `src/a.js` 用 `extractImportSpecs` 抽出 `'./b.js'`，`resolveSpec('src/a.js', './b.js', known)` 补出 `src/b.js`，生成 `{ from, to, spec }` 边，并把 `src/a.js#fa` 的 `dependsOn` 追加 `src/b.js#fb`。
4. 测试断言 `edges.length===1`、`edges[0].from/to` 正确、`fa.dependsOn.includes('src/b.js#fb')`。

正则降级的数据流（第 333–342 行）：`vendorDir` 指向不存在目录 → `getParser` 返回 `null` → `extractFile` 调 `regexExtract` 兜底，且 `stats.regex===1` / `stats.regexLanguages.javascript===1`。

## Connections

- [[lib-symbols]]：本测试套件唯一被测模块，全部用例围绕其导出符号展开。
- [[lib-graph-diff]]：`SymbolExtractor` 产出的记录形状与 `lib/graph-diff.js` 第 10 行的 Node 契约一致（`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`）；`extractRepoGraph` 返回的 `graph` 就是 graph-diff 的输入。
- [[lib-cluster]]：`cluster.js` 第 28–46 行 `formatComponents` 直接消费这种记录（按 `relativePath` 分组、读 `id`/`kind`/`name`/`parameters`），是符号提取的下游消费者之一。
- 上游对应实现：FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*` 与 `codewiki/src/be/updater/graph_diff.py`（见 `lib/symbols.js` 第 1–14 行与 `lib/graph-diff.js` 第 1–10 行注释）。

## Known Issues

- **测试依赖 web-tree-sitter 真实安装**：入口 `if (!ready) { SKIP; process.exit(0) }`（`test-symbols.mjs` 第 42–45 行）会在 `vendor/tree-sitter` 未装时整体跳过全部 AST 用例，仅正则与 import 解析用例能跑。CI 必须安装 WASM 语法包才能得到有意义的 PASS/FAIL。
- **递归型 AST 解析失败只记 failed 不兜底**：`extractFile` 第 577–581 行 `try { this.walk(...) } catch` 仅 `stats.failed += 1` 且**不**退到正则（与第 556–565、584–592 行的两处降级不同），理论上 `walk` 抛错会丢该文件全部符号。测试用例 `语法错误不抛错` 只覆盖 `parser.parse` 抛错（第 569–572 行），未覆盖 `walk` 中途抛错场景。
- **正则路径精度有限**：`regexExtract` 仅按行扫描、源码切片取「到下一个定义行」且最多 60 行（`lib/symbols.js` 第 425 行），不产出 `docstring` / `baseClasses`（`lib/symbols.js` 第 433–436 行），因此 Go/Rust 的基类、Python docstring 等正则用例被刻意排除（测试第 319–326 行只验名字）。
- **`WASM 可用时不走正则` 用例可能空跑**：第 344–351 行中若环境内没有 JS 语法（`getParser('javascript')` 返回假值），用例直接 `return` 跳过，不会被记入 `fails` 也不算有意义通过。
- **C/C++ 参数名解析依赖 `function_declarator`**：`findDeclarator`（`lib/symbols.js` 第 710–719 行）假设函数名/参数在 `function_declarator` 子节点，对非常规声明写法可能取不到名字（退化为 `<anon@行号>`，见第 635 行）。测试未显式覆盖 C/C++ 带 `typedef`/`pointer_declarator` 的复杂声明。
