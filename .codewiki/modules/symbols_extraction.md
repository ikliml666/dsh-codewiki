---
title: symbols_extraction
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
tags: [ast, tree-sitter, symbol-extraction, import-edges, incremental]
---

## Overview

`symbols_extraction` 模块（实现于 `lib/symbols.js`）负责从源码文件里抽取「符号组件」和「import 依赖边」，是整个文档编译流水线的**事实来源（single source of truth）**：后续的语义聚类（[[cluster]]）、组件级增量判定（[[incremental]]）、符号级 diff（[[graph-diff]]）全部消费它产出的 `Node` 记录，而彼此之间不再重新解析源码。

它是上游 FSoft-AI4Code/CodeWiki `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取）的移植，但做了两处有意为之的改造（见 `lib/symbols.js` 第 1–14 行注释）：

- 上游每个语言一个 ~800 行 Python 模块、逐语言硬编码；这里用**一张表 `LANG_RULES` 声明驱动**，加语言只加一行（节点类型 + 名称字段 + 参数字段 + 基类字段）。
- 上游用需编译的原生 tree-sitter 绑定；这里用 **web-tree-sitter + WASM 语法**，装依赖仍是一条 `npm install`，不引入 Python/cargo 工具链。

核心能力有三类：

1. **AST 级符号提取**：`SymbolExtractor` 用 `web-tree-sitter` 的 WASM 语法解析单个文件，递归遍历语法树，把类/结构体/接口（容器）连同其方法、顶层函数、箭头函数、C/C++/Go/Rust 的特殊声明抽取成统一形状的 `Node` 记录。
2. **正则降级提取**：当 WASM 语法包不可用时（没装、装坏、ABI 不匹配），退到 `regexExtract` 按行正则兜底，**有损但不丢符号**——早期实现对这种情况直接 `return []` 导致整块语言静默消失。
3. **依赖边解析**：`extractImportSpecs` + `resolveSpec` + `resolveImportEdges` 把各文件的 import 语句解析成本仓库内的相对路径，再连到目标文件组件，写入每个节点的 `dependsOn`。

组件 id 约定为 `<相对路径>#<符号名>`，方法为 `<类名>.<方法名>`（第 10–11 行）。这与上游的 `<相对路径>::<符号名>` 同构，只是把分隔符从 `::` 换成 `#` 以避免 Windows 盘符混淆。

输出 `Node` 记录形状（与 `lib/graph-diff.js` 第 10 行契约完全一致，见 [[graph-diff]]）：

```
{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }
```

## Key Components

### 常量（表驱动声明）

- `DEFAULT_VENDOR_DIR`（第 25 行）：默认 web-tree-sitter / WASM 语法所在目录，= `<PKG_ROOT>/vendor/tree-sitter`。插件根的 `node_modules` 由宿主注入（符号链接），在那里跑 `npm install` 会破坏运行环境，所以依赖装在独立的 `vendor` 子树里（第 21–24 行注释）。
- `LANG_RULES`（第 36–271 行）：各语言语法的总声明表，`扩展名 -> { wasm, exts, container, containerName, containerBases, containerKind, fn, fnName, fnParams, fnKind, methodKind, imports, doc, arrow, receiverField, fnDeclarator }`。覆盖 16 种语言：javascript / typescript / python / rust / go / java / c / cpp / csharp / ruby / php / kotlin / scala / dart / bash / lua。关键字段语义：
  - `container`：容器节点类型数组（类/结构体/接口/enum，`walk` 里内部成员归属该类）。
  - `containerName` / `containerBases`：容器名称 / 基类字段名（如 Python 的 `superclasses`、Java 的 `superclass`、Ruby 的 `superclass`）。
  - `fn` / `fnName` / `fnParams`：函数节点类型数组与名称/参数字段。
  - `fnKind`（顶层函数 kind）与 `methodKind`（容器内成员 kind，通常为 `method`）。
  - `imports`：import 节点类型数组（用于依赖边）。
  - `doc`：取 docstring 的方式（`first_string_in_body` 用于 Python、`preceding_line_comment` 用于 Rust）。
  - 特殊字段：`go` 的 `receiverField: 'receiver'`（方法名拼接收者类型）、`c`/`cpp` 的 `fnDeclarator: true`（名称参数挂在 `function_declarator` 子节点上）、`typescript` 的 `interface_declaration` 也当容器、Go 的 `container` 实际是 `type_spec`（真正的具名节点）。
- `SUPPORTED_EXTS`（第 273–276 行）：由 `LANG_RULES` 构建的 `Map<扩展名, 语言>`，提供 `扩展名 -> 语言` 反查（如 `.tsx` -> `typescript`）。
- `WASM_FILE_OVERRIDE`（第 279 行）：wasm 文件名与语言 id 不完全一致时的映射（如 `csharp` -> `tree-sitter-c_sharp`）。
- `REGEX_RULES`（第 302–368 行）：正则降级用的 `Map<语言, { fn, cls, iface?, arrow?, params? }>`。每条正则是「匹配定义行、捕获组 1 = 名字」的规则，覆盖与 `LANG_RULES` 相同的语言集。注释（第 288–296 行）解释了为什么要保留这一层——WASM 不可用时的兜底。
- `REGEX_MAX_LINES`（第 371 行）：正则路径单文件最多扫描 4000 行，超出部分忽略（视为块内实现）。

### 顶层函数

- `wasmFileFor(lang)`（第 281–283 行）：返回某语言对应的 WASM 文件名（先查 `WASM_FILE_OVERRIDE`）。
- `regexExtract(relPath, content, lang)`（第 374–440 行）：正则降级提取。按行扫、粗粒度跳过块注释/空行/行注释，依次试 `cls`/`iface`/`fn`/`arrow` 正则，命中即记 `{name, kind, line, params}`。`sourceCode` 取「定义行到下一个定义行之前」（末符号到文件尾，最多 60 行，第 422–438 行）。输出形状与 AST 路径完全一致：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`。返回空数组的情形（第 376 行）：`rule` 不存在或 `content` 为空。
- `parseParamList(text)`（第 443–466 行）：参数列表文本 -> 参数名数组。**AST 与正则两条路径共用**。按顶层逗号切分（跟踪嵌套括号/尖括号深度，第 448–459 行），再去掉默认值（`=` 前）与类型标注（`:` 前），剥掉 `...`/`*`/`$` 前缀。例：`(a, b = 2, ...rest)` -> `['a', 'b', 'rest']`（test 第 75–81 行）。
- `extractRepoGraph(files, opts)`（第 785–805 行）：批量提取入口。遍历 `files`（`{path, content}` 或字符串路径，第 792–794 行），逐个 `extractFile`，返回 `{ graph: Map<id, node>, byFile: Map<文件, 组件id[]>, skipped: [], extractor, ready, stats }`。`ready` 为 false 时不抛错（WASM 没装），由调用方决定退回降级路径（见 [[index]] 的 `semanticPlan`，第 1429–1432 行）。
- `resolveImportEdges(graph, byFile, files)`（第 810–833 行）：把各文件 import 解析成「本仓库内的相对路径」并连到对应文件组件。遍历 `byFile` 里每个文件的 `text`（`files` 为 `Map<路径, 文本>`，第 814–816 行），对每个 import spec 调 `resolveSpec`，命中后压入 `edges`（去重，`seen` 集合，第 820–822 行），并把边落到组件层：把 from 文件所有组件的 `dependsOn` 追加 to 文件全部组件 id（第 824–829 行）。返回 `edges: [{from, to, spec}]`。**与上游差异**（第 807–809 行注释）：上游还建调用级边，这里只做文件级 import 边（够用于模块聚类与 edge 变更判定），调用级边留待扩充。
- `extractImportSpecs(_file, text)`（第 837–847 行）：用 `IMPORT_RE`（第 835 行）从文本里匹配所有 import 语句，捕获组 `m[1]..m[7]` 兼容 `import ... from` / `import '...'` / `from x import` / `#include "..."` / `use a::b` / `require('...')` / 通用 import/require。再补一条 `require(...)` 正则，最后去重返回 spec 列表。
- `resolveSpec(fromFile, spec, known)`（第 849–884 行）：把一条 spec 解析成本仓库内存在的相对路径（在 `known` 集合里找），找不到返回 `null`。三类解析：
  - 相对路径（`.` 开头，第 853–864 行）：`path.posix.join` 后依次补 `.js/.mjs/.jsx/.ts/.tsx/.py/.rs/.go/.java` 及 `index.js`/`index.ts`/`__init__.py`/`mod.rs`。
  - Python 点号模块（如 `a.b.c` -> `a/b/c.py`，第 866–875 行）。
  - Rust `use crate::a::b` / C/C++ 头文件：取 `::` 或 `/` 最后一段，按 `basename`（去扩展名）匹配 `known`（第 877–883 行）。

### `SymbolExtractor` 类（第 472–779 行）

字段（构造于 `constructor`，第 473–481 行）：

- `vendorDir`：vendor 根目录（默认 `DEFAULT_VENDOR_DIR`），可由 `opts.vendorDir` 覆盖（test 第 335 行用它指向不存在目录逼 WASM 全失败）。
- `wasmDir`：`null`（运行时由 `resolveWasmDir` 填）。
- `parsers`：`Map<语言, {parser, language}>`，语法只加载一次（第 469 行注释：每次 init 要 20–50ms，按文件加载会拖垮大仓库）。
- `ParserCtor` / `LanguageCtor`：web-tree-sitter 的构造器，惰性导入。
- `initError`：`null` 或初始化错误信息字符串。
- `stats`：`{ files: 0, parsed: 0, failed: 0, languages: {}, regex, regexLanguages }`（第 480 行起；`regex`/`regexLanguages` 在降级时累加，第 560–562、587–589 行）。

方法：

- `vendorImport(sub)`（第 484–495 行）：从 vendor 子树按绝对路径导入（插件根 `node_modules` 没这些包，裸说明符解析不到）。目录用 `createRequire` 让 Node 自己解析；找不到返回 `null`。
- `init()`（第 498–519 行）：惰性导入 `web-tree-sitter`，取 `Parser`/`Language` 构造器，调 `ParserCtor.init()`。失败把错误写进 `initError` 并返回 `false`，**不抛错**——保证插件在没装语法时照常启动。
- `getParser(lang)`（第 521–542 行）：拿（或加载）某语言的 parser。已缓存直接返回；否则 `init()` -> 取 `LANG_RULES[lang]` -> 定位 WASM 文件 -> `LanguageCtor.load(file)` -> `new ParserCtor()` -> `setLanguage`。ABI 不匹配时把该语言 parser 记为 `null` 并静默降级（第 536–541 行）。
- `resolveWasmDir()`（第 544–547 行）：定位 `<vendorDir>/node_modules/tree-sitter-wasms/out`，不存在返回 `null`。
- `extractFile(relPath, content)`（第 551–594 行）：解析单个文件 -> 符号记录数组。扩展名不在 `SUPPORTED_EXTS` 直接返回 `[]`；解析器不可用时退正则（记账 `stats.regex`/`regexLanguages`）；`parse` 抛错也退正则（并把 `failed+1`）。AST 解析成功但**一个符号都没认出**时再兜一层正则（第 582–592 行），避免「解析成功却零符号」的静默丢失。
- `walk(node, rule, relPath, content, out, container)`（第 597–695 行）：递归遍历语法树的核心。三类节点：(a) 容器（类/结构体）：取 `name`/`bases`，压入 `containerKind` 记录，再对 `namedChildren` 递归并带上 `{name, id}` 作为 owner（第 602–624 行）；(b) 函数/方法：处理 C/C++ 的 `fnDeclarator`（第 631–638 行）、Go 的 `receiverField`（第 640–648 行），拼出 `fullName`（`owner.name` 作为方法名前缀，否则裸名），压入记录（第 650–665 行）；(c) 箭头函数赋值（JS/TS 的 `lexical_declaration`/`variable_declaration`）：用 `findArrow` 找到 `arrow_function`/`function` 子节点，记成 `function`（第 668–690 行）。其余节点对其 `namedChildren` 递归（第 692–694 行）。
- `findArrow(decl)`（第 697–707 行）：从 `variable_declarator` 向下 DFS 找 `arrow_function` 或 `function` 节点。
- `findDeclarator(node)`（第 710–719 行）：C/C++ 专用，DFS 找 `function_declarator`（可能被 `pointer_declarator` 包一层）。
- `stripCallSuffix(text)`（第 722–727 行）：把 `add(int a)` / `(*fn)(int a)` 形式的 declarator 文本只取函数名部分。
- `fieldText(node, field)`（第 729–737 行）：用 `childForFieldName` 安全取字段文本，失败返回 `null`。
- `parseParams(text)`（第 739–741 行）：包一层 `parseParamList`。
- `parseBases(text, node, rule)`（第 743–748 行）：基类文本 -> 基类名数组（`superclasses`/`superclass` 字段可能是 `Base, Mixin` 或 `(Base)` 形式）。
- `sliceSource(node, content)`（第 751–757 行）：按节点字节范围 `content.slice(startIndex, endIndex)` 取源码原文（多字节安全）。
- `extractDoc(node, rule, content)`（第 759–774 行）：取 docstring。Python 取 body 内第一个字符串表达式（第 760–766 行），Rust 取紧邻的前一个兄弟 `line_comment`/`block_comment`（第 767–772 行），其它语言返回 `''`。
- `componentId(relPath, name)`（第 776–778 行）：拼 `<relPath>#<name>`。

### `Node` 记录字段（消费方契约，见 [[graph-diff]] 第 10 行）

每个抽取出的组件记录含以下字段（AST 与正则路径形状一致）：

- `id`：``<相对路径>#<符号名>``，方法为 `<相对路径>#<类名>.<方法名>`。
- `name`：符号名（方法含 `.` 间隔）；匿名节点用 `<anon@<行号>>`。
- `kind`：`class` / `function` / `method`（由 `containerKind`/`fnKind`/`methodKind` 决定）。
- `relativePath`：文件相对路径。
- `sourceCode`：源码切片（AST 取字节区间；正则取定义行到下一定义行）。
- `docstring`：文档注释（Python `"""`/Rust `///`；其它语言空串）。
- `parameters`：参数名数组（已去默认值与类型）。
- `baseClasses`：基类/接口名数组。
- `dependsOn`：依赖的组件 id 数组（仅 `resolveImportEdges` 填充）。

## Architecture

模块由「表驱动声明 + AST 提取器 + 正则兜底 + 依赖边解析」四块组成，整体是单向数据流（输入源码 -> 输出 `graph`/`byFile`/`edges`）：

```text
┌─────────────────┐   LANG_RULES / REGEX_RULES (表驱动声明)
│  lib/symbols.js  │
└─────────────────┘
        │  extractRepoGraph(files, opts)
        ▼
┌─────────────────────────────────────────────────────────┐
│  SymbolExtractor                                          │
│  ┌──────────┐   init/getParser(lang)   ┌──────────────┐  │
│  │web-tree- │◄────────────────────────│ WASM 语法包  │  │
│  │sitter     │   (vendor/tree-sitter)  │ (tree-sitter-│  │
│  └──────────┘                          │  wasms/out)  │  │
│        │ parse(content)                 └──────────────┘  │
│        ▼                                                   │
│  walk(node, rule, ...)  ──►  Node[] (AST 路径)             │
│        │ not ready / 0 symbols / parse error              │
│        ▼                                                   │
│  regexExtract(relPath, content, lang)  ──►  Node[] (兜底)  │
└─────────────────────────────────────────────────────────┘
        │
        ▼  graph: Map<id,Node>, byFile: Map<file,[id]>
┌──────────────────────────────────────────────┐
│  resolveImportEdges(graph, byFile, files)      │
│  extractImportSpecs -> resolveSpec -> edges[]  │
│  并回填每个 Node.dependsOn                      │
└──────────────────────────────────────────────┘
        │
        ▼
  consumers: [[cluster]] (语义聚类) / [[incremental]] (增量判定)
             / [[graph-diff]] (组件级 diff)
```

关键设计点：

- **语法只加载一次**：`parsers` Map 缓存（第 476 行），大仓库不会每文件重跑 20–50ms 的 WASM 加载。
- **两条路径同形状**：AST 与正则都产出相同的 `Node` 结构，下游（graph-diff / cluster）无感知切换。test 第 309–316 行显式断言这点。
- **多层降级而非静默丢符号**：`extractFile` 在 (1) 解析器不可用 / (2) parse 抛错 / (3) 解析成功但 0 符号 三种情况下都退回 `regexExtract`，且只有真正命中时才记 `stats.regex`（第 557–564、569–572、584–592 行）。早期实现对情况 (1) 直接 `return []`，导致整块语言凭空消失（REGEX_RULES 注释第 290–292 行）。
- **vendor 隔离**：依赖装在 `vendor/tree-sitter` 而非插件根 `node_modules`，避免宿主注入的符号链接包被 `npm install` 标记 retire（第 21–24 行注释）。

## Data Flow

以 `index.js` 的 `semanticPlan` 为真实调用链（第 1409–1492 行），端到端数据流如下：

1. **扫描 + 读正文**：`scanRepoFiles` 给 `{path, bytes}`，`semanticPlan` 再统一读一遍正文（第 1411–1423 行），因为「提取」和「建边」都要 `content`，不想读两遍。
2. **批量提取**：`extractRepoGraph(filesWithText, { cwd })`（第 1428 行）返回 `{ graph, byFile, skipped, extractor, ready, stats }`。`ready` 为 `false` 时立即 `fallback=true` 退回目录分组（第 1429–1432 行）；抛错同样退回（第 1435–1438 行）；`graph` 为空也退回（第 1440–1443 行）。
3. **建依赖边**：`resolveImportEdges(graph, byFile, textByFile)`（第 1445 行），失败不影响聚类（被 `try/catch` 吞掉）。`from` 文件组件的 `dependsOn` 被追加 `to` 文件全部组件 id。
4. **语义聚类**：`clusterComponents({ components: [...graph.values()], llmCall })`（第 1456 行）消费 `Node` 列表 —— 注意聚类只用到 `relativePath`/`id`/`kind`/`name`/`parameters`（见 [[cluster]] 的 `formatComponents`，第 28–46 行），**不看 `sourceCode` 全文**，以省 token。
5. **持久化**：`plan.graph` 只保留 `{id,name,kind,relativePath,parameters,baseClasses,dependsOn,docstring}`（剥离 `sourceCode`，第 1475–1484 行），因为后续增量判定只用 `bodyHash`/签名/依赖，源码没有任何消费者（第 1471–1474 行注释）。

单文件微观流（`extractFile`，第 551–594 行）：`extname` -> `SUPPORTED_EXTS` 查语言 -> `getParser` -> `parse`/`walk` -> 若 AST 不通则 `regexExtract`。`walk` 对语法树做深度优先，`container` 节点把 `owner` 下传给孩子，`fn` 节点据 `owner`/`receiverField` 决定记成 `method` 还是 `function`，`arrow` 节点单独处理（`findArrow`）。

## Connections

- [[cluster]]：本模块产出的 `Node` 列表直接喂给 `clusterComponents` 做 LLM 语义聚类（无 LLM 时退化为目录启发式）；`formatComponents` 用的是 `relativePath`/`id`/`kind`/`name`/`parameters` 字段。
- [[graph-diff]]：`Node` 记录形状与 `lib/graph-diff.js` 第 10 行契约完全一致（字段逐一对应），`diffGraphs` 直接用 `signature`/`bodyHash`/`dependsOn` 做组件级 diff；`incremental.js` 的 `SLIM_FIELDS` 也是这套字段的子集。
- [[incremental]]：`extractRepoGraph` 产出的 `graph`/`byFile` 是 `filterStaleTasks` 的输入之一，配合快照（`slimGraph`/`graphFromSnapshot`）做组件级增量判定，`dependsOn` 字段在这里产生 edge 类变更。
- [[index]]：`semanticPlan`（第 1409–1492 行）是本模块的总调度方，负责读正文、`extractRepoGraph`、建边、聚类、并把图随 job 持久化；`localPlan` 是它失败时的降级路径。
- [[update-planner]]：模块地图（`buildModuleMap`）与 stale 判定依赖符号 id 与 `dependsOn` 关系。

## Known Issues

- **调用级依赖边未实现**（设计取舍，非 bug）：`resolveImportEdges` 只建文件级 import 边，注释（第 807–809 行）明确说明「调用级边留待需要时扩充」。因此组件级 `dependsOn` 只反映文件 import 关系，不反映函数间的实际调用关系。
- **正则路径的精度明显低于 AST**（第 294–296 行注释）：拿不到精确字节区间与嵌套结构，只认顶层附近定义（最多扫描 4000 行、`REGEX_MAX_LINES`），缩进过深的块内实现会被忽略；`sourceCode` 也只粗略取「定义行到下一个定义行」。
- **Go 的 `type_spec` 容器内方法名拼接依赖 receiver**（第 640–648 行）：`func (s *Server) Start()` 通过 `receiver` 字段取最后一个词再剥 `*` 得到 `Server`，拼成 `Server.Start`；若 receiver 解析异常会退化为空（不报错，但方法可能记成裸名）。
- **WASM ABI 不匹配会静默降级**（第 536–541 行）：语法与运行时 ABI 不匹配时 `getParser` 把该语言 parser 记为 `null` 并写入 `initError`，不中断整个编译——但这会让该语言后续文件全部走正则路径（可通过 `stats.regexLanguages` 观察到）。
- **`extractImportSpecs` 的 `IMPORT_RE` 是粗匹配**（第 835 行）：基于正则的文本扫描，对复杂动态 import（如模板字符串、运行时拼路径）无能为力，只能识别字面量 import。
