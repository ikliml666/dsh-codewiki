---
title: symbol_extraction
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/update-planner.js
  - lib/incremental.js
  - index.js
tags: [ast, tree-sitter, symbol-extraction, repository-graph, import-edges, incremental]
---

## Overview

`symbol_extraction` 是 dsh-codewiki 的 **AST 级符号提取层**，对应上游 FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取函数/方法/类 + 调用关系）。它把任意仓库的源文件扫描成一张**组件图（repository graph）**：每个符号（函数、方法、类/结构体/接口等）是一个节点，节点携带源码片段、签名、基类、docstring；再把文件级 `import` 语句解析成**仓库内相对路径**，连成**依赖边（import edges）**，挂到节点的 `dependsOn` 上。

整个模块集中在 `lib/symbols.js`，对外只暴露两个核心入口：

- `extractRepoGraph(files, opts)`（`lib/symbols.js:785`）——给定文件清单，产出 `{ graph: Map<id,node>, byFile: Map<file, ids[]>, skipped, extractor, ready, stats }`。
- `resolveImportEdges(graph, byFile, files)`（`lib/symbols.js:810`）——把 import 边落成 `node.dependsOn`，并返回边列表。

与上游的两个**有意为之**的差异（见文件头注释 `lib/symbols.js:1-14`）：

1. **表驱动而非逐语言硬编码**：上游每个语言一个 800 行 Python 模块；这里用一张 `LANG_RULES` 声明表（节点类型 + 名称字段 + 参数字段 + 基类字段），加语言只加一行（`lib/symbols.js:36-271`）。
2. **web-tree-sitter + WASM，而非原生 tree-sitter 绑定**：依赖装在 `vendor/tree-sitter`（一个独立 npm 根），避免插件根 `node_modules` 被宿主注入的符号链接污染（`lib/symbols.js:21-25`）；装依赖仍是一条 `npm install`，不引入 Python/cargo。

组件 id 约定为 `<相对路径>#<符号名>`，方法为 `#<类名>.<方法名>`（`lib/symbols.js:10-11`）。输出形状与 `lib/graph-diff.js` 的 Node 记录契约完全一致：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（`lib/symbols.js:13-14`），因此图可以直接喂给增量 diff（`lib/graph-diff.js` 的 `diffGraphs`）和模块聚类（`lib/cluster.js` 的 `clusterComponents`）。

一个关键降级保障：**AST 不可用（WASM 没装 / ABI 不匹配 / 语法细则没覆盖）时，不是静默返回空，而是退到正则兜底 `regexExtract`**（`lib/symbols.js:374-440`），拿不到精确字节区间但至少能认出顶层函数/类与名字，且把命中记进 `stats.regex`。这是早期实现「文件被静默跳过、整块语言凭空消失」缺陷的修复（`lib/symbols.js:289-296`）。

## Key Components

模块全部公开 API 都在 `lib/symbols.js`，下面按「常量 / 提取器类 / 批量与边函数 / 正则兜底」分组列出。

### 常量与表

- `DEFAULT_VENDOR_DIR`（导出，`lib/symbols.js:25`）：`vendor/tree-sitter` 的绝对路径（基于 `PKG_ROOT` 即插件根解析，`lib/symbols.js:24`）。可被 `SymbolExtractor` 的 `vendorDir` 选项覆盖。
- `LANG_RULES`（导出，`lib/symbols.js:36-271`）：表驱动的「语言 → 语法规则」映射。每条规则字段（详见 `lib/symbols.js:27-35` 注释）：
  - `wasm`：tree-sitter WASM 语法包名。
  - `exts`：该语言涵盖的扩展名数组。
  - `container` / `containerName` / `containerBases` / `containerKind`：容器节点类型（类/结构体/接口/impl 块等）及其名称字段、基类字段、记作的 `kind`（统一记作 `'class'`）。
  - `fn` / `fnName` / `fnParams`：函数/方法节点类型数组及名称/参数字段。
  - `fnKind` / `methodKind`：顶层函数与容器内成员的 `kind`（通常 `'function'` / `'method'`）。
  - `imports`：import 节点类型数组（用于依赖边）。
  - `arrow`：箭头函数赋值节点类型（JS/TS 专属）。
  - `doc`：docstring 取法（`'first_string_in_body'` 用于 Python，`'preceding_line_comment'` 用于 Rust）。
  - `fnDeclarator`（C/C++）：名称与参数挂在 `function_declarator` 子节点上（`lib/symbols.js:139,154`）。
  - `receiverField`（Go）：方法接收者字段，方法名拼成 `<类型>.<方法>`（`lib/symbols.js:112`）。
  - 覆盖语言：javascript、typescript、python、rust、go、java、c、cpp、csharp、ruby、php、kotlin、scala、dart、bash、lua（共 16 种，`lib/symbols.js:353-359` 测试断言 ≥15 个）。
- `SUPPORTED_EXTS`（导出，`lib/symbols.js:273-276`）：由 `LANG_RULES` 构建的 `Map<ext, lang>`，扩展名 → 语言。`update-planner.js:20,30` 直接用它判断一个路径是不是源码（`isSourcePath`）。
- `WASM_FILE_OVERRIDE`（局部，`lib/symbols.js:279`）：`{ csharp: 'tree-sitter-c_sharp' }`，处理 WASM 文件名与语言 id 不一致的特例。
- `REGEX_RULES`（导出，`lib/symbols.js:302-368`）：正则兜底规则表，与 `LANG_RULES` 语言一一对应。`fn` / `cls` / `iface` / `arrow` 为正则，捕获组 1 = 名字、捕获组 2 = 参数。
- `REGEX_MAX_LINES`（局部，`lib/symbols.js:371`）：正则路径单文件最多扫 4000 行。

### 类 `SymbolExtractor`（`lib/symbols.js:472-779`）

符号提取器；语法只加载一次（缓存在 `this.parsers`），避免大仓库逐文件加载（每次 init 20–50ms，`lib/symbols.js:468-470`）。

构造与选项：

- `constructor(opts = {})`（`lib/symbols.js:473-481`）：选项 `vendorDir`（默认 `DEFAULT_VENDOR_DIR`）、`wasmDir`（默认 `null`，由 `resolveWasmDir` 兜底）。实例字段：
  - `parsers: Map<lang, {parser, language}>`（`lib/symbols.js:476`）
  - `ParserCtor` / `LanguageCtor`：web-tree-sitter 构造器（`lib/symbols.js:477-478`）
  - `initError`：初始化错误信息（`lib/symbols.js:479`）
  - `stats`（初始化，`lib/symbols.js:480`）：`{ files, parsed, failed, languages, regex?, regexLanguages? }`。

方法：

- `vendorImport(sub)`（`lib/symbols.js:484-495`）：从 `vendor/tree-sitter/node_modules` 按绝对路径导入（因插件根 `node_modules` 没有这些包，`lib/symbols.js:483`）。目录不存在或解析失败返回 `null`。
- `init()`（`lib/symbols.js:498-519`）：惰性导入 `web-tree-sitter`（依赖没装时插件照常启动，只是没有 AST 能力）。导出缺 `Parser`/`Language` 或异常时记到 `initError` 并返回 `false`。成功则 `await ParserCtor.init()` 返回 `true`。`initError` 已存在则直接返回 `false`（不重试）。
- `getParser(lang)`（`lib/symbols.js:521-542`）：取/建某语言的 parser；`init()` 失败、`LANG_RULES` 缺该语言、WASM 文件不存在都返回 `null`。WASM 与运行时 ABI 不匹配时静默降级（把 `lang → null` 缓存起来，不中断整个编译），并把错误记进 `initError`（`lib/symbols.js:536-541`）。
- `resolveWasmDir()`（`lib/symbols.js:544-547`）：定位 WASM 目录为 `vendor/tree-sitter/node_modules/tree-sitter-wasms/out`，不存在返回 `null`。
- `extractFile(relPath, content)`（`lib/symbols.js:551-594`）：**单文件提取主入口**。未知扩展名直接 `[]`；`getParser` 返回 `null` 时退正则兜底并记 `stats.regex`；parser 抛错（`tree.parse` 失败，`lib/symbols.js:569`）或 AST 解析成功但零符号（`lib/symbols.js:584`）也兜一层正则，**避免「解析成功却零符号」这种最难查的静默丢失**。成功则 `walk` 递归收集，`stats.parsed++` 并累加 `stats.languages[lang]`。
- `walk(node, rule, relPath, content, out, container)`（`lib/symbols.js:597-695`）：递归收集。容器（类）连同其成员方法一起成为组件；顶层函数单独成为组件。处理四类节点：
  1. **容器**（命中 `rule.container`，`lib/symbols.js:602-624`）：取 `containerName` 作名、解析 `containerBases` 基类，记 `kind=containerKind`（统一 `'class'`），`sourceCode` 取整个节点字节区间（`sliceSource`），`docstring` 用 `extractDoc`。然后**继续遍历子节点**，把成员方法归属到这个类（`container = { name, id }`，`lib/symbols.js:621`）。
  2. **函数/方法**（命中 `rule.fn`，`lib/symbols.js:626-666`）：取 `fnName`/`fnParams`；C/C++ 经 `findDeclarator` 下取一层（`lib/symbols.js:631-638`）；Go 经 `receiverField` 取接收者类型拼成 `<类型>.<方法>`（`lib/symbols.js:640-648`）。有 owner 且 `methodKind==='method'` 时记为方法（`kind='method'`，名 `owner.name.name` → 实际为 `owner.name`），否则记为顶层函数。
  3. **箭头函数赋值**（命中 `rule.arrow`，`lib/symbols.js:669-690`）：在 `lexical_declaration`/`variable_declaration` 的子节点里用 `findArrow` 找 `arrow_function`/`function`，以 `name` 字段作 `kind='function'` 组件。
  4. 其余节点继续遍历子节点（`lib/symbols.js:692-694`）。
- `findArrow(decl)`（`lib/symbols.js:697-707`）：BFS 找 `arrow_function` 或 `function`。
- `findDeclarator(node)`（`lib/symbols.js:710-719`）：BFS 找 `function_declarator`（C/C++ 可能被 `pointer_declarator` 包一层）。
- `stripCallSuffix(text)`（`lib/symbols.js:722-727`）：从 `add(int a)` / `(*fn)(int a)` 这类文本里只取函数名部分（剥 `*` 与参数后缀）。
- `fieldText(node, field)`（`lib/symbols.js:729-737`）：安全取节点的具名字段文本（`childForFieldName`，异常返回 `null`）。
- `parseParams(text)`（`lib/symbols.js:739-741`）：委托 `parseParamList`。
- `parseBases(text, node, rule)`（`lib/symbols.js:743-748`）：把基类字符串按逗号切分、剥调用括号，返回基类名数组。
- `sliceSource(node, content)`（`lib/symbols.js:751-757`）：按节点字节区间 `startIndex..endIndex` 取原文（多字节安全）。
- `extractDoc(node, rule, content)`（`lib/symbols.js:759-774`）：按 `rule.doc` 取 docstring——`'first_string_in_body'`（Python：取 `body` 下第一个字符串表达式语句）或 `'preceding_line_comment'`（Rust：`previousSibling` 是 `line_comment`/`block_comment`）。
- `componentId(relPath, name)`（`lib/symbols.js:776-778`）：返回 `${relPath}#${name}`，组件 id 的唯一来源。

### 批量与边函数

- `extractRepoGraph(files, opts = {})`（`lib/symbols.js:785-805`）：批量入口。每个元素可以是字符串（仅路径）或 `{ path, content }`。遍历文件调用 `extractFile`，零符号的入 `skipped`，否则写入 `graph`（Map<id,node>）与 `byFile`（Map<file, ids>）。返回 `{ graph, byFile, skipped, extractor, ready, stats }`。**注意：它只提取组件，不建依赖边**——建边由调用方显式调 `resolveImportEdges`（见 `index.js:2099-2102` 的修复说明）。
- `resolveImportEdges(graph, byFile, files)`（`lib/symbols.js:810-833`）：**依赖边建造**。对 `byFile` 每个文件，用 `files`（Map<file, text>）取全文，经 `extractImportSpecs` 抽出 import 说明符，再经 `resolveSpec` 解析成本仓库内相对路径（落到 `known` 文件集）。每条 `from → to` 边去重后 push 到 `edges`，并把边**落到组件层**：`from` 文件所有组件的 `dependsOn` 追加 `to` 文件的所有组件 id（`lib/symbols.js:825-829`）。返回 `edges` 数组。上游把「调用关系」也建边；这里先做**文件级 import 边**（够用于模块聚类与 edge 变更判定），调用级边留待扩充（`lib/symbols.js:812-814`）。
- `extractImportSpecs(_file, text)`（`lib/symbols.js:837-847`）：用 `IMPORT_RE` 正则从全文抽出所有 import 说明符（`import ... from`、`import '...'`、`from x import`、`#include`、`use ...`、`require('...')` 等），去重返回。
- `resolveSpec(fromFile, spec, known)`（`lib/symbols.js:849-884`）：把说明符解析成 `known` 集合中的相对路径：
  - 相对路径（`.` 开头）：`normalize(join(dir, spec))` 后尝试一堆候选（加 `.js/.mjs/.ts/.py/.rs/.go/.java` 后缀、`index.js`、`__init__.py`、`mod.rs` 等，`lib/symbols.js:854-862`）。
  - Python 点号模块（`a.b.c`）：转 `a/b/c.py` / `__init__.py`，并退化为后缀匹配（`lib/symbols.js:866-874`）。
  - Rust `use crate::a::b` / C/C++ 头文件：按 `::` 或 `/` 拆出尾名，匹配 `known` 中同名 basename（`lib/symbols.js:876-883`）。
  - 都匹配不上返回 `null`。

### 正则兜底函数

- `regexExtract(relPath, content, lang)`（`lib/symbols.js:374-440`）：按行扫的降级提取，产出与 AST 路径**同形状**的节点（`test-symbols.mjs:309` 的注释强调 consumer 一致：graph-diff / cluster）。跳过块注释、`//`/`#` 行注释；类优先于函数判定；箭头函数单独处理。每个符号的 `sourceCode` 取「该定义行到下一个定义行之前」（末符号最多 60 行，`lib/symbols.js:425-426`）。零规则语言或非字符串返回 `[]`。
- `parseParamList(text)`（`lib/symbols.js:443-466`）：参数文本 → 参数名数组，**AST 与正则两条路径共用**。按顶层逗号切分（跳过嵌套括号/尖括号），剥默认值（`=`）与类型标注（`:`），剥 `...`/`*`/`$` 前缀，只留参数名。
- `IMPORT_RE`（局部，`lib/symbols.js:835`）：驱动 `extractImportSpecs` 的多选正则。
- `wasmFileFor(lang)`（`lib/symbols.js:281-283`）：按 `WASM_FILE_OVERRIDE` 把语言 id 映射到 WASM 文件名。

## Architecture

`symbol_extraction` 是一个表驱动 + 双路径（AST / 正则）的提取器，生产一张带依赖边的组件图。组件 ≥3 且流程非平凡，框图如下：

```text
┌────────────────────────────────────────────────────────────┐
│  extractRepoGraph(files, opts)      lib/symbols.js:785       │
│  - 遍历 files，逐文件 extractFile                           │
│  - 产出 graph: Map<id,node> + byFile: Map<file,ids> + skipped│
└───────────────┬────────────────────────────────────────────┘
                │ 每文件
                ▼
┌────────────────────────────────────────────────────────────┐
│  SymbolExtractor.extractFile(relPath, content)  :551         │
│  ┌──────────────┐       null           ┌─────────────────┐  │
│  │ getParser(lang)              regexExtract  (正则兜底) │  │
│  │ (AST，web-tree-sitter WASM)  :521  :374  记 stats.regex│  │
│  └──────┬───────┘                                ▲         │
│         │ parser 成功                             │ 同样形状 │
│         ▼                                         │ 的节点   │
│  tree.parse → walk(rootNode,rule,...)   :597       │         │
│   (递归：container / fn / arrow) 产出 组件节点      ┘         │
└───────────────┬────────────────────────────────────────────┘
                │ graph / byFile
                ▼
┌────────────────────────────────────────────────────────────┐
│  resolveImportEdges(graph, byFile, files)     :810           │
│  - files(Map) 取全文 → extractImportSpecs :837 (IMPORT_RE)   │
│  - resolveSpec :849 把 import 解析成本仓库相对路径           │
│  - 写 edges[] + 回填 node.dependsOn (组件层边)               │
└───────────────┬────────────────────────────────────────────┘
                │ graph (带 dependsOn) 作为「当前代码符号图」
                ▼
        下游消费者（见 Connections）
   graph-diff.diffGraphs / cluster.clusterComponents
   update-planner.planUpdate / incremental.filterStaleTasks
```

要点：

- **表驱动**：`LANG_RULES`（`lib/symbols.js:36`）+ `REGEX_RULES`（`lib/symbols.js:302`）两张声明表决定每一种语言怎么提；新增语言加一行，无需写新代码。
- **双路径兜底**：AST 路径（web-tree-sitter WASM）优先；任何一环失败（缺依赖、ABI 不匹配、解析零符号）都退到 `regexExtract` 正则路径，**绝不让整块语言静默消失**（`lib/symbols.js:374-381, 551-594`）。
- **组件 id 唯一来源**：一切 id 都由 `SymbolExtractor.componentId`（`lib/symbols.js:776`）以 `${relPath}#${name}` 生成，方法名形如 `Class.method`（Go/Rust 接收者、C/C++ 函数名下取等细节都在 `walk` 内处理）。
- **边与节点分离**：`extractRepoGraph` 只建节点；依赖边必须显式调 `resolveImportEdges`，否则增量侧的反向依赖判定会失效（`index.js:2258-2261`）。

## Data Flow

一次「全量编译」或「stale 增量」里的典型数据流（以 `index.js` 的 `extractCurrentGraph` 为例，`index.js:2243-2266`）：

1. **扫描仓库** → `scanRepoFiles(cwd)`（`index.js:2074`）：按黑名单目录/二进制后缀/单文件 256KB/总数 2000 的约束，产出 `{ path, bytes }` 清单。
2. **读全文** → `index.js:2248-2253` 把每个文件读成 `{ path, content }`，并另存 `textByFile: Map<file, text>` 供建边时用。
3. **批量提取** → `extractRepoGraph(inputs, { cwd })`（`lib/symbols.js:785`）。注意 `extractRepoGraph` 内部会 `new SymbolExtractor(opts)` 并 `await extractor.init()`（`lib/symbols.js:786-787`），`opts.cwd` 透传给 `SymbolExtractor` 的 `vendorDir`/`wasmDir` 仅作覆盖项来源。
   - 每个文件走 `extractFile` → `getParser`（AST）或 `regexExtract`（正则）→ `walk` 递归产出组件节点，写入 `graph`/`byFile`。
   - 返回 `{ graph, byFile, skipped, ready, stats }`；`ready` 为 `false`（WASM 没装）时 `extractCurrentGraph` 直接返回 `graph=null`，由调用方退文件级判定（`index.js:2099-2100`）。
4. **补依赖边** → `resolveImportEdges(graph, byFile, textByFile)`（`index.js:2261`，`lib/symbols.js:810`）。失败只降级为「无依赖判定」，不阻断（`index.js:2261` 的 `try/catch`）。
5. **落图** → 得到的 `graph`（`Map<id,node>`，node 带 `dependsOn`）即「当前代码符号图」，被两路使用：
   - **增量 diff**：与历史快照的 `graphFromSnapshot`（`lib/incremental.js:69`）做 `diffGraphs`（`lib/graph-diff.js:447`），算组件级 added/deleted/interface/body/edge/renamed（`index.js` 全量编译也用 `extractRepoGraph` 产出 full graph 喂给 `clusterComponents`）。
   - **模块聚类**：`clusterComponents({ components: [...graph.values()] })`（`lib/cluster.js:291`），`formatComponents`（`lib/cluster.js:28`）按文件分组把节点喂给 LLM 聚类。

节点记录的字段契约（贯穿整条流水线）：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`。其中 `sourceCode` 在 `extractFile` 里由 `sliceSource` 按字节区间切出（`lib/symbols.js:751`），`docstring` 由 `extractDoc` 按语言规则取（`lib/symbols.js:759`）；`dependsOn` 初始为空、由 `resolveImportEdges` 回填（`lib/symbols.js:810`）。`incremental.js:26` 的 `SLIM_FIELDS` 明确哪些字段进快照（**`sourceCode`/`docstring` 不进快照**，回读时置空，`lib/incremental.js:84-85`），`bodyHash`/`codeHash` 固化进快照以加速 diff（`lib/incremental.js:37-48`）。

## Connections

本模块是编译流水线的「符号级输入」，与以下模块直接相连：

- [[graph-diff]] —— `lib/graph-diff.js` 定义了节点记录契约（Node shape）与 `diffGraphs`（`lib/graph-diff.js:447`）。本模块产出的 `graph`（`Map<id,node>`）是 `diffGraphs` 的直接输入；`signature`/`bodyHash`/`codeHash` 的判定都依赖本模块产出的 `parameters`/`baseClasses`/`sourceCode`/`docstring`。`index.js` 中 `extractCurrentGraph` 的图与 `lib/incremental.js:69` 的 `graphFromSnapshot` 互相对拍。
- [[cluster]] —— `lib/cluster.js` 的 `clusterComponents`（`lib/cluster.js:291`）消费 `[...graph.values()]` 作 `components`，`formatComponents`（`lib/cluster.js:28`）按文件分组读取每个节点的 `id/kind/name/parameters` 拼提示词。`clusterPrompt`（`lib/cluster.js:57`）明确「组件 ID 形如 `<相对路径>#<符号名>`」——正是本模块 `componentId`（`lib/symbols.js:776`）的产物。
- [[update-planner]] —— `lib/update-planner.js` 复用本模块的 `SUPPORTED_EXTS`（`lib/update-planner.js:20,30`，`isSourcePath`）判定源码扩展名，并用 `diffGraphs` 的结果做反向依赖影响分析（`dependentsOf`，`lib/update-planner.js:85` 依赖 `dependsOn` 边）。`realChangedIds`（`lib/update-planner.js:57`）与 `lib/incremental.js` 共用 `codeHash` 纯注释降级判据。
- [[incremental]] —— `lib/incremental.js` 的 `filterStaleTasks`（`lib/incremental.js:140`）和 `componentsByFile`（`lib/incremental.js:123`）消费 `Map<id,node>`，并处理 `dependsOn` 与 `bodyHash`/`codeHash` 的快照固化（`SLIM_FIELDS`，`lib/incremental.js:26`）。
- [[change-set]] —— 提供 `collectChangeSet` 的「文件级变更」，作为符号图 diff 的上游；符号图只在文件真变时才被拉起（`index.js:2243` 的 `extractCurrentGraph` 与 `change-set.js` 协同）。
- 生产调用点：`index.js` 的 `extractCurrentGraph`（`index.js:2243`，导出）、`prepareArticleTasks`/`slugify`（`index.js:1660,1760`）等；批量入口 `extractRepoGraph` 与边函数 `resolveImportEdges` 在 `index.js:1245` 顶层导入，在 `index.js:2255` 与 `index.js:1255` 调用。

## Known Issues

- **依赖边是「文件级 import」而非「调用级」**：`resolveImportEdges`（`lib/symbols.js:810`）只解析 `import` 语句到本仓库内相对路径，再整文件连边；上游 CodeWiki 还会建「函数调用级」边，这里留待扩充（`lib/symbols.js:807-809`）。因此 `dependsOn` 是文件内全部组件的并集（`lib/symbols.js:825-829`），粒度比调用关系粗。
- **纯正则降级会丢失精度**：`regexExtract`（`lib/symbols.js:374`）只认顶层附近定义、最多扫 4000 行、不解析嵌套结构；`sourceCode` 取「定义行到下一个定义行」（末符号最多 60 行），`docstring` 恒为空、`baseClasses` 恒为 `[]`（`lib/symbols.js:427-437`）。只在 AST 不可用时启用，且记 `stats.regex`（`lib/symbols.js:560-562`）。`test-symbols.mjs:333-342` 专门保证 WASM 不可用时仍能兜底出符号。
- **WASM 依赖是「可选依赖」**：`vendor/tree-sitter` 装没装、`.wasm` 与运行时 ABI 是否匹配，直接决定走 AST 还是正则。`getParser` 在 ABI 不匹配时静默降级（`lib/symbols.js:536-541`），且 `initError` 一旦被设置就不会重试（`lib/symbols.js:500`）。生产侧 `extractCurrentGraph` 用 `ready` 标志显式降回文件级判定（`index.js:2099-2100`）。
- **C/C++ 名称/参数在 `function_declarator` 子节点**：`fnDeclarator: true` 规则（`lib/symbols.js:139,154`）配合 `findDeclarator`（`lib/symbols.js:710`）和 `stripCallSuffix`（`lib/symbols.js:722`）处理，但指针函数 `(*fn)(...)` 的解析依赖文本前缀剥离，复杂声明可能取不到干净名。
- **import 正则对注释里的 import 文本无感知**：`IMPORT_RE`（`lib/symbols.js:835`）是纯文本正则，不区分代码与注释中的 `import`/`require` 字样；出现在注释里的写法也会被 `extractImportSpecs` 抽出来，再由 `resolveSpec` 过滤（`known` 集合里找不到就返回 `null`，`lib/symbols.js:849`）。
- **`extractRepoGraph` 不建边是一个历史坑**：旧链路（曾叫 `extractCurrentGraph`）只提组件不调 `resolveImportEdges`，导致「被依赖模块变了、使用方文章不重写」的反向依赖判定形同虚设。`index.js:2258-2261` 的注释记录了这次修复——现在 `extractCurrentGraph` 会显式补边。
- **`stats.failed` 与「零符号文件」区分不清**：`extractFile` 在 `tree.parse` 抛错时 `stats.failed++`（`lib/symbols.js:570`）但随后仍退正则；AST 成功但零符号时不记 `failed` 而是退正则并记 `regex`（`lib/symbols.js:584-591`）。调用方看 `stats` 需注意这两类降级是不同的记账字段。
