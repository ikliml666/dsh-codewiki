---
title: symbol_extraction
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/incremental.js
  - lib/update-planner.js
  - index.js
tags: [ast, tree-sitter, symbol-extraction, code-graph, import-resolution, regex-fallback, fsoft-port]
---

## Overview

`lib/symbols.js` 是 **AST 级符号提取与依赖图构建** 模块，对应上游
FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取
函数/方法/类 + 调用关系）。它把一份仓库文件清单（含正文）提取成一张组件图
`Map<id, node>`，并把各文件的 import 语句解析成「本仓库内的相对路径」依赖边。

与上游的差异（有意为之，见 `lib/symbols.js:1-14`）：

- 上游每个语言一个 ~800 行 Python 模块、逐语言硬编码；这里用**一张表驱动**
  （`LANG_RULES`，`lib/symbols.js:36-271`），把「符号节点类型 + 名称字段 + 参数字段 +
  基类字段」声明化，加语言只加一行。
- 上游用原生 tree-sitter 绑定（需编译）；这里用 **web-tree-sitter + WASM 语法**
  （`lib/symbols.js:497-519`），依赖装在 `vendor/tree-sitter`（独立 npm 根，
  `lib/symbols.js:21-25`），装依赖仍是一条 `npm install`，不引入 Python/cargo。

组件 id 约定：`<相对路径>#<符号名>`；方法为 `#<类名>.<方法名>`（与上游
`<相对路径>::<符号名>` 同构，只用 `#` 避免 Windows 盘符混淆，`lib/symbols.js:10-11`）。

输出 Node 记录形状（与 `lib/graph-diff.js` 的 Node 契约一致，`lib/symbols.js:13-14`、
`lib/graph-diff.js:9-10`）：

```
{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }
```

本模块是**图的生产者**：`extractRepoGraph` 产出的 `graph` 是 `lib/graph-diff.js`
的 `diffGraphs` 输入，`byFile` 是聚类（`lib/cluster.js`）与增量判定
（`lib/incremental.js` / `lib/update-planner.js`）的索引底座。

## Key Components

### 导出常量

| 名称 | 行号 | 含义 |
|---|---|---|
| `DEFAULT_VENDOR_DIR` | `lib/symbols.js:25` | 默认 WASM 语法所在目录：`PKG_ROOT/vendor/tree-sitter`。插件根的 `node_modules` 由宿主注入（符号链接），在那里跑 `npm install` 会破坏运行环境，故语法包独立放在 `vendor` 子树（`lib/symbols.js:21-25`）。 |
| `LANG_RULES` | `lib/symbols.js:36-271` | 各语言语法规则表：扩展名 → `{ wasm, exts, container, containerName, containerBases, containerKind, fn, fnName, fnParams, fnKind, methodKind, imports, doc, arrow, receiverField, fnDeclarator }`。覆盖 javascript/typescript/python/rust/go/java/c/cpp/csharp/ruby/php/kotlin/scala/dart/bash/lua 共 17 种语言。加语言只加一行。 |
| `SUPPORTED_EXTS` | `lib/symbols.js:273-276` | 由 `LANG_RULES` 汇总出的 `Map<ext, lang>`（扩展名 → 语言 id），供 `extractFile` 做「扩展名 → 能否提取」的快速查表。 |
| `WASM_FILE_OVERRIDE` | `lib/symbols.js:279` | `csharp` 的 wasm 文件名与语言 id 不一致时的映射 `{ csharp: 'tree-sitter-c_sharp' }`，被 `wasmFileFor` 使用。 |
| `REGEX_RULES` | `lib/symbols.js:302-368` | 正则降级规则表：语言 → `{ fn, cls, iface, arrow }` 正则（捕获组 1 = 名字，捕获组 2 = 参数）。WASM 语法不可用时的兜底符号提取（`lib/symbols.js:285-296`）。 |
| `REGEX_MAX_LINES` | `lib/symbols.js:371` | `4000`，限制正则路径一次扫描的行数深度，缩进过深的函数体被忽略。 |

### 导出函数（顶层）

| 函数 | 行号 | 用途 |
|---|---|---|
| `wasmFileFor(lang)` | `lib/symbols.js:281-283` | 取某语言的 wasm 文件名，先查 `WASM_FILE_OVERRIDE` 再退回 `LANG_RULES[lang].wasm`。 |
| `regexExtract(relPath, content, lang)` | `lib/symbols.js:374-440` | 正则兜底提取：按行扫、跳过块注释/空行/行注释/井号注释，类优先于函数，箭头函数单独匹配。产出与 AST 路径**同形状**的记录。 |
| `parseParamList(text)` | `lib/symbols.js:443-466` | 参数列表文本 → 参数名数组：按顶层逗号切分（跳过嵌套括号/尖括号/泛型），剥掉默认值与类型标注，去掉 `...`/`*`/`$` 前缀。AST 与正则两条路径共用。 |
| `extractRepoGraph(files, opts={})` | `lib/symbols.js:785-805` | 批量入口：给定文件清单（字符串路径 或 `{path, content}`），返回 `{ graph, byFile, skipped, extractor, ready, stats }`。**只提取组件、不建依赖边**——边由调用方显式调 `resolveImportEdges` 构建。 |
| `resolveImportEdges(graph, byFile, files)` | `lib/symbols.js:810-833` | 把各文件 import 解析成本仓库内的相对路径依赖边：生成 `{ from, to, spec }` 边，并把边落到组件层（`node.dependsOn` 追加目标文件的全部组件 id）。 |
| `extractImportSpecs(_file, text)` | `lib/symbols.js:837-847` | 用 `IMPORT_RE`（`lib/symbols.js:835`）从文本里抽出 import 规格串（JS/TS import、Python `from ... import`、C/C++ `#include`、Rust `use`、JS `require`）去重返回。 |
| `resolveSpec(fromFile, spec, known)` | `lib/symbols.js:849-884` | 把 import 规格解析成仓库内已知路径：相对路径带扩展名补全；Python 点号模块 `a.b.c → a/b/c.py`；Rust `use crate::a::b` / C 头文件按尾名匹配。找不到返回 `null`。 |

### `SymbolExtractor` 类（`lib/symbols.js:472-779`）

解析器池与单文件/单仓库提取的核心类。

| 成员 | 行号 | 类型 / 可见性 | 用途 |
|---|---|---|---|
| `constructor(opts={})` | `lib/symbols.js:473-481` | 构造器 | 初始化 `vendorDir`（`opts.vendorDir ?? DEFAULT_VENDOR_DIR`）、`wasmDir`、`parsers`（`Map`，lang→{parser,language} 缓存）、`ParserCtor`/`LanguageCtor` 占位、`initError`、`stats = { files, parsed, failed, languages }`。 |
| `vendorImport(sub)` | `lib/symbols.js:484-495` | 方法（私有约定） | 从 `vendor/tree-sitter/node_modules` 按绝对路径导入包（如 `web-tree-sitter`）；目录不存在或解析失败返回 `null`，保证「依赖没装时插件照常启动，只是没有 AST 能力」（`lib/symbols.js:497`）。 |
| `init()` | `lib/symbols.js:498-519` | 异步方法 | 惰性导入 `web-tree-sitter`，把 `Parser`/`Language` 构造器取出并调 `Parser.init()`；失败（包缺失/导出残缺）把错误存进 `initError` 并返回 `false`，不抛异常。 |
| `getParser(lang)` | `lib/symbols.js:521-542` | 异步方法 | 按语言取（或首次加载并缓存）解析器；加载语法文件失败（ABI 不匹配等）静默降级、缓存 `null`、不中断整套编译（`lib/symbols.js:536-541`）。 |
| `resolveWasmDir()` | `lib/symbols.js:544-547` | 异步方法 | 定位 WASM 语法目录：`vendor/tree-sitter/node_modules/tree-sitter-wasms/out`；不存在返回 `null`。 |
| `extractFile(relPath, content)` | `lib/symbols.js:551-594` | 异步方法 | 解析单个文件 → 符号记录数组。**两条路径**：`getParser` 拿到解析器走 AST 路径（`walk`，`lib/symbols.js:578`）；拿不到（语法没装/ABI 不匹配/`parse` 抛错/解析成功但零符号）一律退到正则兜底 `regexExtract`，并记账 `stats.regex`/`stats.regexLanguages`。 |
| `walk(node, rule, relPath, content, out, container)` | `lib/symbols.js:597-695` | 方法（私有约定） | 递归收集：容器（类/接口/struct 等，`rule.container`）连同其成员方法一起成为组件；顶层函数单独成为组件；箭头函数赋值单独走 `arrow` 分支；方法名拼成 `<类名>.<方法名>`（`lib/symbols.js:652`）。 |
| `findArrow(decl)` | `lib/symbols.js:697-707` | 方法（私有约定） | 在声明子树里找 `arrow_function`/`function` 节点（用于箭头函数提取）。 |
| `findDeclarator(node)` | `lib/symbols.js:710-719` | 方法（私有约定） | C/C++：从 `function_definition` 向下找 `function_declarator`（可能被 `pointer_declarator` 包一层）。 |
| `stripCallSuffix(text)` | `lib/symbols.js:722-727` | 方法（私有约定） | 从 declarator 文本里只取函数名部分（剥掉 `(*fn)(...)` 之类）。 |
| `fieldText(node, field)` | `lib/symbols.js:729-737` | 方法（私有约定） | 安全取某字段名的子节点文本（字段不存在/取失败返回 `null`）。 |
| `parseParams(text)` | `lib/symbols.js:739-741` | 方法 | 委托给导出函数 `parseParamList`。 |
| `parseBases(text, node, rule)` | `lib/symbols.js:743-748` | 方法（私有约定） | 解析基类列表：剥掉括号、按逗号切分、去掉每项的 `(...)` 后缀（如泛型）。 |
| `sliceSource(node, content)` | `lib/symbols.js:751-757` | 方法（私有约定） | 按节点字节范围（`startIndex`/`endIndex`）取原文，多字节安全（`lib/symbols.js:753`）。 |
| `extractDoc(node, rule, content)` | `lib/symbols.js:759-774` | 方法（私有约定） | 取 docstring：Python 取函数体第一个字符串表达式（`first_string_in_body`）；Rust 取节点前的行注释（`preceding_line_comment`）；其余语言返回空串。 |
| `componentId(relPath, name)` | `lib/symbols.js:776-778` | 方法 | 拼组件 id：`${relPath}#${name}`。 |

`SymbolExtractor` 实例运行时字段（在 `stats` 之外）：

- `stats.files` / `stats.parsed` / `stats.failed` / `stats.languages`（`lib/symbols.js:480`）：每次 `extractRepoGraph` 循环累加（`lib/symbols.js:785`）。
- `stats.regex` / `stats.regexLanguages`（懒建，`lib/symbols.js:560-562`）：正则兜底次数与按语言计数。`stats.regex` 在「语法不可用」与「AST 解析成功但零符号」两种兜底分支都会累加（`lib/symbols.js:560`、`587`）。

### `walk` 的关键分支（逐语言形状）

- **容器（类/接口/struct/enum/trait/impl/namespace）**：`lib/symbols.js:602-624`，取出 `name`、`baseClasses`（如 Python `superclasses`、Java `superclass`）、docstring，继续向子树递归、让成员方法归属该类（`container = { name, id }`）。
- **函数/方法**：`lib/symbols.js:626-666`。C/C++ 向下取 `function_declarator`（`lib/symbols.js:631-638`）；Go 把接收者类型拼进方法名（`lib/symbols.js:639-648`）；容器内的成员记为 `method` 且全名 `<owner>.<name>`（`lib/symbols.js:650-653`）。
- **箭头函数**：`lib/symbols.js:669-690`，`const foo = (a) => {}` 之类记为 `function` 类。

## Architecture

本模块是「表驱动 AST 提取 → 正则兜底 → 依赖边解析」三段式管线，组件 ≥3 且流程非平凡，框图如下：

```text
   files: [{path, content}]  (index.js:semanticPlan / extractCurrentGraph 喂入)
                 │
                 ▼
   ┌────────── extractRepoGraph (lib/symbols.js:785) ──────────┐
   │  for f: extractor.extractFile(f.path, f.content)           │
   │   └─未提取到符号 → skipped[] (797-798)                    │
   │  byFile.set(f, ids); graph.set(id, node) (799-800)         │
   └────────────────────────┬─────────────────────────────────┘
                            │ graph: Map<id,node>, byFile: Map<file,ids>
                            ▼
   ┌───── SymbolExtractor.extractFile (lib/symbols.js:551) ────┐
   │  init()→web-tree-sitter (498)  getParser(lang) (521)       │
   │   ├─ parser 可用 ─► walk()  AST 路径 (597)                │
   │   └─ 不可用/解析失败/零符号 ─► regexExtract() 兜底 (374)   │
   │        (记账 stats.regex / stats.regexLanguages)           │
   └────────────────────────┬─────────────────────────────────┘
                            │ node = {id,name,kind,relativePath,
                            │         sourceCode,docstring,parameters,
                            │         baseClasses,dependsOn}
                            ▼
   ┌──────── resolveImportEdges (lib/symbols.js:810) ──────────┐
   │  byFile → extractImportSpecs() (837) → resolveSpec() (849) │
   │  → edges[{from,to,spec}] + 回写 node.dependsOn (824-829)   │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
         消费者：cluster.clustering / graph-diff.diffGraphs
         incremental.extractCurrentGraph / update-planner.planUpdate
```

关键设计点：

- **表驱动多态**：`LANG_RULES`（`lib/symbols.js:36-271`）把「容器节点类型 / 名称字段 / 参数字段 / 基类字段 / import 节点类型」声明化，`walk`（`lib/symbols.js:597-695`）按规则遍历，加语言只改表（`lib/symbols.js:4-6`）。
- **双路径容错**：AST 不可用（WASM 没装/ABI 不匹配/`parse` 抛错/零符号）一律退 `regexExtract`，且记录 `stats.regex`（`lib/symbols.js:556-592`），避免「静默丢符号」让整块语言的模块凭空消失（`test-symbols.mjs:289-291`、`333-342`）。两条路径产出**同形状**的 Node 记录，让下游消费者无感切换（`test-symbols.mjs:309-316`）。
- **解析器只加载一次**：`parsers` 缓存（lang→{parser,language}，`lib/symbols.js:476`），每次 `init` 约 20–50ms，按文件加载会拖垮大仓库（`lib/symbols.js:468-470`）。
- **图不含边、边另建**：`extractRepoGraph` 只提取组件（`lib/symbols.js:785-787`），依赖边由调用方显式调 `resolveImportEdges`——聚类链路（`index.js:1429`）与增量链路（`index.js:2238`）都补了这一步。

## Data Flow

以一次全量编译（`semanticPlan`）与一次增量编译（`extractCurrentGraph`）为例，数据从源码流到符号图再到下游。

### 全量编译（语义规划链路）

1. **正文读取 + 符号提取**：`semanticPlan`（`index.js:1393-1422`）先统一读正文（`textByFile`），再调 `extractRepoGraph(filesWithText, { cwd })`（`index.js:1412`）产出 `graph`/`byFile`。`ex.ready` 为 `false` 时退回目录分组（`index.js:1413-1416`）。
2. **依赖边**：`resolveImportEdges(graph, byFile, textByFile)`（`index.js:1429`）补文件级 import 边、把边落到组件 `dependsOn`。
3. **聚类**：`clusterComponents`（`lib/cluster.js`）消费组件清单做语义聚类（LLM 不可用则启发式目录分组）。
4. **plan 持久化**：`semanticPlan` 把 `graph.components`（不含 `sourceCode`，避免膨胀）与 `edges` 落盘。

### 增量编译（符号级判定链路）

1. **当前图提取**：`extractCurrentGraph(cwd)`（`index.js:2220-2243`）用 `scanRepoFiles` + `extractRepoGraph` 取当前代码图，并调 `resolveImportEdges` 补边（`index.js:2238`，修复 0.14.0 前增量侧从不建边导致反向依赖判定失效的缺陷）。
2. **快照瘦身**：`slimGraph(cur.graph)`（`lib/incremental.js:37-48`）把图存进 `.codewiki/temp/symbol-graph.json`（`SNAPSHOT_REL`，`lib/incremental.js:22`），只存 `SLIM_FIELDS`（`lib/incremental.js:26`）并把 `bodyHash`/`codeHash` 固化。
3. **组件级 diff**：旧图（快照回读）与新图交给 `diffGraphs`（`lib/graph-diff.js:447`），判定哪些组件真变了。
4. **文章级计划**：`planUpdate`（`lib/update-planner.js`）消费 diff，结合 `moduleMap` 与 `dependentsOf`（`lib/update-planner.js:85`）算反向依赖闭包，给每篇文章产出 `write/keep/delete/review` 动作。

### 单文件提取的内部流转（`extractFile`）

```
extractFile(relPath, content)            lib/symbols.js:551
  └─ SUPPORTED_EXTS.get(ext)             lib/symbols.js:553  未支持扩展名 → 返回 []
  └─ getParser(lang)                     lib/symbols.js:555
       ├─ parser 命中 → walk(tree.rootNode)         lib/symbols.js:578
       │     └─ 容器/函数/箭头 三类分支递归收集       lib/symbols.js:602-695
       └─ parser 未命中 → regexExtract(...)         lib/symbols.js:558
             └─ 按行扫 + 参数解析，同形状记录        lib/symbols.js:374-440
```

## Connections

- [[graph-diff]] — `lib/graph-diff.js` 是图的**消费者**与契约持有方：`diffGraphs`（`lib/graph-diff.js:447`）接收本模块产出的 `Map<id, node>`，Node 记录形状由本模块的 `lib/symbols.js:13-14` 与 `lib/graph-diff.js:9-10` 共同约定。
- [[cluster]] — `lib/cluster.js` 消费 `extractRepoGraph` 的组件清单做语义聚类：`formatComponents`（`lib/cluster.js:28-46`）按文件分组、只给「名字 + 类型 + 一行签名」（依赖 `parameters`），提示词里明确 id 形态为 `<相对路径>#<符号名>`（`lib/cluster.js:41-65`）。
- [[incremental]] — `lib/incremental.js` 的 `extractCurrentGraph` 等价体（`index.js:2220-2243`）调 `extractRepoGraph` + `resolveImportEdges` 取当前图；`SNAPSHOT_REL`（`lib/incremental.js:22`）的瘦身快照是 `diffGraphs` 的旧图来源。
- [[update-planner]] — `lib/update-planner.js` 复用 `SUPPORTED_EXTS`（`lib/update-planner.js:20-30`，`SOURCE_EXTS` 由它派生）做源码扩展名判断；`planUpdate`（`lib/update-planner.js`）消费 diff 生成文章级增量计划，依赖本模块建好的 `dependsOn` 边做反向依赖闭包（`dependentsOf`，`lib/update-planner.js:85`）。
- [[index]] — `index.js` 是编排总入口：`semanticPlan`（`index.js:1393`）与 `extractCurrentGraph`（`index.js:2220`）两条链路都调本模块；`resolveImportEdges` 在 `index.js:1429` 与 `index.js:2238` 两处显式补边（0.14.0 修增量侧从不建边的缺陷）。

## Known Issues

- **WASM 语法是可选依赖，未装时静默降级**：`vendorImport` / `init` / `getParser` 在语法缺失或 ABI 不匹配时返回 `false`/`null` 并走正则兜底（不抛异常，`lib/symbols.js:503-506`、`536-541`），只把 `initError` 与 `stats.regex` 记下来。好处是不阻断编译，坏处是「降级发生」需要读 `stats` 才知道（`test-symbols.mjs:333-342`）。
- **正则降级有损但不丢**：`regexExtract`（`lib/symbols.js:374-440`）拿不到精确字节区间与嵌套结构，只认顶层附近的定义行（最多 4000 行，`REGEX_MAX_LINES`，`lib/symbols.js:371`），缩进过深的函数体被忽略；参数只剥默认值和类型、保留名字（`lib/symbols.js:460-465`）。精度明显低于 AST，只在 AST 不可用时启用。
- **C/C++ 参数名依赖 `function_declarator` 下钻**：`findDeclarator`（`lib/symbols.js:710-719`）从 `function_definition` 向下找 `function_declarator`/`pointer_declarator`，取函数名与参数；若语言语法把声明结构改了，名字可能拿不全。
- **import 解析只覆盖本仓库内的相对/点号/头文件引用**：`resolveSpec`（`lib/symbols.js:849-884`）不解析第三方包（如 `lodash`）——`resolveSpec('src/a.js','lodash',...)` 直接返回 `null`（`test-symbols.mjs:252-254`）。外部依赖不会在本仓库图上连线，符合「模块聚类与 edge 变更判定只用本仓库依赖」的设计（`lib/symbols.js:807-809`）。
- **无功能禁用/注释掉的代码**：通读 `lib/symbols.js` 全文件（885 行），没有被注释掉或被禁用的导出函数/常量。所有 17 种语言的 `LANG_RULES` 条目与 `REGEX_RULES` 条目均处于启用状态；`bash`/`lua` 等无容器语言显式置 `container: []`（`lib/symbols.js:243-256`、`260-269`），属正常配置而非禁用。
