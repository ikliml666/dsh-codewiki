---
title: symbol_extraction
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
tags: [ast, tree-sitter, symbol-extraction, repo-graph, import-edges, web-tree-sitter, regex-fallback]
---

## Overview

`symbol_extraction` 是 dsh-codewiki 的「代码理解第一关」：从仓库源码里把**组件**（函数、类/结构体/接口、方法、顶层常量/箭头函数）连同它们的**源码切片、签名、基类、文档串**抽取成一组结构化的 `Node` 记录，再把各文件的 `import`/`use`/`require`/`#include` 语句解析成本仓库内的**依赖边**（import edges），从而构建出整座仓库的「符号图」（repo graph）。

它对应上游 FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取函数/方法/类 + 调用关系），但做了两处有意差异（见 `lib/symbols.js` 1–14）：

- 上游每个语言一个 800 行 Python 模块、逐语言硬编码；这里用**一张表驱动**（`LANG_RULES`，`lib/symbols.js` 36–271），把「符号节点类型 + 名称字段 + 参数字段 + 基类字段」声明化，加语言只加一行。
- 上游用原生 tree-sitter 绑定（需编译）；这里用 `web-tree-sitter` + WASM 语法包，依赖装在独立的 `vendor/tree-sitter` 子树（见 21–25），装依赖仍是一条 `npm install`，不引入 Python/cargo。

该模块是纯 Node、零 ML 依赖的工具层，被两大下游消费：

- **语义规划** `semanticPlan`（`index.js` 1410–1493）：全量编译时先抽图再做 LLM 语义聚类。
- **符号级增量** `extractCurrentGraph`（`index.js` 2237–2260）：stale 增量时抽图并建边，供 `lib/graph-diff.js` + `lib/incremental.js` 做组件级变更判定。

组件 id 约定（沿用且与上游 `<相对路径>::<符号名>` 同构，只是分隔符不同以避免 Windows 盘符混淆）：`<相对路径>#<符号名>`，方法为 `#<类名>.<方法名>`（见 `lib/symbols.js` 10–11）。

## Key Components

全部公开 API 都来自 `lib/symbols.js`。下表按「常量 → 导出函数 → `SymbolExtractor` 类（字段 + 方法）」组织，行号以源码「行号| 」前缀为准。

### 导出常量

- `DEFAULT_VENDOR_DIR`（`lib/symbols.js` 25）：默认 WASM 语法包根目录，等于 `<插件根>/vendor/tree-sitter`。`web-tree-sitter` 与各类 `*.wasm` 都装在这一独立 npm 子树里——插件根 `node_modules` 由宿主注入（符号链接），在那里跑 `npm install` 会破坏运行环境。
- `LANG_RULES`（`lib/symbols.js` 36–271）：表驱动的核心。**扩展名 → 语法规则**映射，每条规则声明：`container`（容器节点类型，如类/结构体）、`containerName`/`containerBases`、`containerKind`、`fn`（函数节点类型数组）、`fnName`/`fnParams`/`fnKind`/`methodKind`、`imports`（import 节点类型数组，用于依赖边）、`doc`（取 docstring 的方式）、`arrow`（箭头函数声明节点）、`receiverField`（如 Go 的方法接收者）、`fnDeclarator`（如 C/C++ 函数名在 `function_declarator` 上）。目前覆盖 16 种语言：javascript / typescript / python / rust / go / java / c / cpp / csharp / ruby / php / kotlin / scala / dart / bash / lua。
- `SUPPORTED_EXTS`（`lib/symbols.js` 273–276）：由 `LANG_RULES` 反推生成的 `Map<ext, lang>`，是「扩展名 → 语言」的快查表。`extractFile` 用它决定要不要处理某个文件。
- `WASM_FILE_OVERRIDE`（`lib/symbols.js` 279）：wasm 文件名与语言 id 不完全一致时的覆盖表，目前只有 `csharp -> tree-sitter-c_sharp`。被 `wasmFileFor`（281）使用。
- `REGEX_RULES`（`lib/symbols.js` 302–368）：正则降级的规则表，**每种语言**含 `fn`/`cls`/`iface`/`arrow` 等捕获组正则（捕获组 1 = 名字，捕获组 2 = 参数）。AST 不可用时启用，见「降级路径」。`bash`/`lua` 只用 `fn`。
- `REGEX_MAX_LINES`（`lib/symbols.js` 371）：正则路径单文件最多扫 4000 行，超出截断（避免几千行文件把尾部的全部源码挂到最后一个函数上）。
- `IMPORT_RE`（`lib/symbols.js` 835）：匹配各语言 import 语句的统一正则（JS `import ... from` / bare `import` / Python `from ... import` / C/C++ `#include` / Rust `use` / `require(...)` 等），`extractImportSpecs` 用它。

### 导出函数（非类成员）

- `regexExtract(relPath, content, lang)`（`lib/symbols.js` 374–440）：正则降级抽取。按行扫描，跳过块注释/空行/行注释，逐语言套 `REGEX_RULES` 认类/函数/箭头函数；每个符号的 `sourceCode` 取「定义行到下一个定义行前」（末符号最多 60 行，见 420–426）。产出与 AST 路径**同形状**的 `Node` 记录（`id/name/kind/relativePath/sourceCode/docstring/parameters/baseClasses/dependsOn`），保证下游 `graph-diff`/`cluster` 零差异消费。
- `parseParamList(text)`（`lib/symbols.js` 443–466）：参数文本 → 参数名数组（AST 与正则两条路径共用）。去掉默认值（`=`）与类型标注（`:`）、展开嵌套括号/尖括号里的顶层逗号、剥掉 rest（`...`）与指针（`*`）。
- `wasmFileFor(lang)`（`lib/symbols.js` 281–283）：返回某语言对应的 wasm 文件名（套 `WASM_FILE_OVERRIDE`）。
- `extractRepoGraph(files, opts)`（`lib/symbols.js` 785–805）：批量入口。遍历 `{path, content}` 文件清单，对每个文件调 `extractFile`，汇总成 `{ graph: Map<id, node>, byFile: Map<file, id[]>, skipped, extractor, ready, stats }`。`skipped` 是没抽出任何组件的文件（无对应语法/空文件/未知扩展名）。
- `resolveImportEdges(graph, byFile, files)`（`lib/symbols.js` 810–833）：依赖边。对每个文件用 `extractImportSpecs` 抽出 import spec，再用 `resolveSpec` 解析成本仓库内相对路径；命中后 `edges.push({from, to, spec})` 并把 `to` 文件的全部组件 id 追加进 `from` 文件各组件的 `dependsOn`。`files` 可以是 `Map<file, text>` 或带 `text` 字段的列表（见 815）。
- `extractImportSpecs(_file, text)`（`lib/symbols.js` 837–847）：用 `IMPORT_RE` + 一条额外的 `require(...)` 正则抽出所有 import spec，去重返回数组。`_file` 仅占位（历史签名）。
- `resolveSpec(fromFile, spec, known)`（`lib/symbols.js` 849–884）：把一条 spec 解析成本仓库内的真实相对路径。`known` 是已知文件集合（`Set`）。三种解析：相对路径（`.` 开头，补 `.js/.ts/.py/...` 及 `index`/`__init__`/`mod` 候选，见 853–864）、Python 点号模块（`a.b.c -> a/b/c.py`，见 866–875）、Rust `crate::`/C/C++ 头文件（按文件名尾段匹配，见 877–883）。找不到返回 `null`。

### `SymbolExtractor` 类（`lib/symbols.js` 472–779）

构造（`472–481`）字段：

- `vendorDir`：WASM 语法包根目录（默认 `DEFAULT_VENDOR_DIR`，可被 `opts.vendorDir` 覆盖）。
- `wasmDir`：wasm 文件目录（默认 `null`，首次解析时由 `resolveWasmDir` 填充）。
- `parsers`：`Map<lang, parser>`，语法只加载一次（每次 `init` 要 20–50ms，按文件加载会拖垮大仓库，见 468–470）。
- `ParserCtor` / `LanguageCtor`：`web-tree-sitter` 的 `Parser` / `Language` 构造器，惰性导入。
- `initError`：初始化失败原因（`null` 表示未失败）。
- `stats`：`{ files, parsed, failed, languages }`；降级时追加 `stats.regex` 与 `stats.regexLanguages`（见 480、560–563）。

方法：

- `vendorImport(sub)`（`484–495`）：从 `vendor/tree-sitter/node_modules` 按绝对路径动态导入（插件根找不到这些包，裸说明符解析不到）。找不到返回 `null`。
- `init()`（`498–519`）：惰性导入 `web-tree-sitter`，调 `ParserCtor.init()`。依赖没装/导出缺失时 `initError` 记账并 `return false`，**插件照常启动，只是没有 AST 能力**。
- `getParser(lang)`（`521–542`）：按语言取/建解析器；语法与运行时 ABI 不匹配时静默降级（`parsers.set(lang, null)`），不中断整库解析。
- `resolveWasmDir()`（`544–547`）：定位 `tree-sitter-wasms/out` 目录，不存在返回 `null`。
- `extractFile(relPath, content)`（`551–594`）：解析单文件。**主路径**：扩展名不在 `SUPPORTED_EXTS` 直接返回 `[]`；拿到 parser 就 `walk` 整棵 AST。三种降级：① 拿不到 parser（`getParser` 返回 `null`）→ `regexExtract` 兜底并记 `stats.regex`；② `parser.parse` 抛错 → 记 `stats.failed` 后 `regexExtract`；③ AST 解析成功但**零符号**（语法细则没覆盖新写法）→ 同样 `regexExtract` 兜底。两条路都不通才返回空。
- `walk(node, rule, relPath, content, out, container)`（`597–695`）：递归收集。容器（类）连同成员方法一起成组件（`container` 非 `null` 时方法名拼成 `类名.方法`，见 650–653）；顶层函数单独成组件。处理 C/C++ 的 `fnDeclarator`（630–638）、Go 接收者（640–648）、箭头函数赋值（669–690）。
- `findArrow(decl)`（`697–707`）：从 `variable_declarator` 向下找 `arrow_function` / `function` 节点。
- `findDeclarator(node)`（`710–719`）：C/C++ 向下找 `function_declarator`（可能被 `pointer_declarator` 包一层）。
- `stripCallSuffix(text)`（`722–727`）：从 declarator 文本（`add(int a)` / `(*fn)(int a)`）里只取函数名。
- `fieldText(node, field)`（`729–737`）：按字段名取子节点文本（try/catch，字段不存在返回 `null`）。
- `parseParams(text)`（`739–741`）：直接委托 `parseParamList`。
- `parseBases(text, node, rule)`（`743–748`）：基类文本 → 基类名数组（取 `(` 前、按 `,` 切分、剥掉调用参数）。
- `sliceSource(node, content)`（`751–757`）：按节点字节范围切原文（多字节安全）。
- `extractDoc(node, rule, content)`（`759–774`）：取 docstring。Python `first_string_in_body`（找 body 里首条字符串语句，760–766）；Rust `preceding_line_comment`（取前驱 `line_comment`/`block_comment`，767–772）；其它语言返回空。
- `componentId(relPath, name)`（`776–778`）：拼 `<relPath>#<name>`。

### `Node` 记录形状（消费者契约）

`graph.get(id)` 与 `byFile` 里的节点，形状与 `lib/graph-diff.js` 的 Node 契约一致（`lib/symbols.js` 13–14）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | `<relPath>#<name>`，方法为 `#<类>.<方法>` |
| `name` | string | 符号名（方法含 `类.` 前缀） |
| `kind` | string | `class` / `function` / `method` |
| `relativePath` | string | 仓库相对路径（POSIX） |
| `sourceCode` | string | 该符号的完整源码切片（AST 按字节区间；正则按行到下一个定义） |
| `docstring` | string | 文档串（Python 三重引号 / Rust `///`；其余语言为空） |
| `parameters` | string[] | 参数名数组（已剥默认值与类型） |
| `baseClasses` | string[] | 基类/接口列表（有基类字段的语言） |
| `dependsOn` | string[] | 依赖边解析后追加的「被 import 文件的所有组件 id」 |

## Architecture

组件 ≥3 且流程非平凡，下面是「单文件抽取 + 批量建图 + 依赖边」的框图（≤20 行）：

```text
┌──────────────────────────────────────────────────────────────┐
│  extractRepoGraph(files, opts)        lib/symbols.js:785       │
│  for each {path, content}: extractFile ─► graph Map / byFile Map│
└───────────────┬──────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│  SymbolExtractor.extractFile(relPath, content)  lib/symbols.js:551│
│  ext = SUPPORTED_EXTS.get(ext) ? ── 未知 ─► 返回 []            │
│  parser = getParser(lang)  (web-tree-sitter, LANG_RULES)       │
│    ├─ 有 parser ─► walk() 递归 AST ──► Node[]                  │
│    └─ 无 parser / parse 抛错 / 零符号                           │
│              └─► regexExtract() 正则兜底 (REGEX_RULES)         │
│                    记 stats.regex / regexLanguages             │
└───────────────┬──────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│  SymbolExtractor.walk(node, rule, …, container)  lib/symbols.js:597│
│  container(类/struct) ─► 组件 + 成员方法(类.方法)              │
│  fn(函数) ─► 顶层 function 组件                                │
│  arrow ─► const foo = (a)=>… 认作 function                     │
│  每条规则查 LANG_RULES[lang]：container/fn/fnName/fnParams/…    │
└───────────────┬──────────────────────────────────────────────┘
                │ graph(Map<id,Node>) + byFile(Map<file,id[]>)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  resolveImportEdges(graph, byFile, files)  lib/symbols.js:810  │
│  extractImportSpecs ─ IMPORT_RE ─► specs                     │
│  resolveSpec(spec) ──► 本仓库相对路径 (相对/py点号/rust use)  │
│  edges[] + 回填 node.dependsOn                                │
└───────────────┬──────────────────────────────────────────────┘
                │
                ▼
        consumers: cluster.js (聚类) / graph-diff.js (增量 diff)
```

`Index` 中 `semanticPlan`（1410）与 `extractCurrentGraph`（2237）是这里两个主要调用点：前者把 `components` 交给 LLM 语义聚类，后者把图交给 `graph-diff`/`incremental` 做组件级变更判定。

## Data Flow

以 `semanticPlan`（`index.js` 1410–1493）的全量编译路径为例，端到端数据流：

1. **扫文件**：`scanRepoFiles(cwd)`（`index.js` 2209–2232）按黑名单目录（`SCAN_SKIP_DIRS`，含 `node_modules`/`vendor`/`dist` 等）、二进制后缀、单文件 ≤256KB、总数 ≤2000 产出 `{path, bytes}` 清单。注意它**不读正文**，正文由 `semanticPlan` 统一读一遍（1420–1424），提取与建边共用，不读两遍。
2. **抽组件**：`extractRepoGraph(filesWithText, { cwd })`（`index.js` 1429`）→ 对每个文件 `extractFile`。返回 `ex.graph`（`Map<id, Node>`）、`ex.byFile`（`Map<file, id[]>`）、`ex.ready`、`ex.extractor.initError`。
   - 若 `!ex.ready`（web-tree-sitter 没装）→ 直接 `fallback: true`，退回目录分组（`index.js` 1431）。
   - 若 `graph` 空（`no-components`）→ 同样退回目录分组（1443）。
3. **建依赖边**：`resolveImportEdges(graph, byFile, textByFile)`（`index.js` 1446`）→ `edges[]` 并把 `to` 文件组件 id 追加进 `from` 文件各组件的 `dependsOn`。建边失败不影响聚类（try/catch）。
4. **聚类**：`clusterComponents({ components: [...graph.values()], llmCall })`（`index.js` 1457`，定义见 `lib/cluster.js` 291）。`components` 的 `id/kind/relativePath/parameters/baseClasses/dependsOn/docstring` 字段正是本模块产出的形状。
5. **落盘 plan**：`toPlanModules(result)`（`index.js` 1469`，`lib/cluster.js` 460）产出模块清单；`plan.graph` 只带 `id/name/kind/relativePath/parameters/baseClasses/dependsOn/docstring`——**不带 `sourceCode`**（`index.js` 1476–1485`），因为判变更只靠 `bodyHash`/签名/依赖（见 `lib/incremental.js`）。

增量路径 `extractCurrentGraph`（`index.js` 2237–2260）流程类似：自己调 `scanRepoFiles` + 读正文 + `extractRepoGraph` + `resolveImportEdges`，返回 `{graph, byFile, ready, reason}`；之后交给 `lib/incremental.js` 的 `filterStaleTasks`（复用 `lib/graph-diff.js` 的 `diffGraphs`）。

正则降级的内部数据流：`extractFile` 拿不到 AST → `regexExtract(relPath, content, lang)`（`lib/symbols.js` 558`，374）→ 按 `REGEX_RULES[lang]` 逐行认类/函数/箭头函数 → 用 `parseParamList` 解析参数 → 产出与 AST 同形状的 `Node[]`，并 `stats.regex++`。测试 `test-symbols.mjs` 333–342 专门验证「WASM 不可用时自动走正则且 `stats.regex` 被记账」。

## Connections

- [[cluster]] — 本模块产出的 `components`（含 `id/kind/relativePath/parameters/baseClasses/dependsOn`）是语义聚类的直接输入；`formatComponents`/`clusterPrompt` 依赖 `id` 的 `<relPath>#<name>` 形态。
- [[graph-diff]] — `Node` 记录的字段形状（`id/name/kind/relativePath/sourceCode/parameters/baseClasses/dependsOn`）与 `diffGraphs` 的契约完全一致；`graph-diff` 的 `signature`/`bodyHash`/`documentedSource` 直接消费这些字段。
- [[incremental]] — stale 增量靠 `extractCurrentGraph` 建图后，`filterStaleTasks` 复用 `graph-diff` 做组件级变更判定；快照 `slimComponent`/`graphFromSnapshot` 只保留本模块产出的字段子集（见 `lib/incremental.js` 26、28）。
- [[index]] — `semanticPlan`（1410）/ `extractCurrentGraph`（2237）/ `scanRepoFiles`（2209）是这条流水线的编排点；`extractRepoGraph` 与 `resolveImportEdges` 在 16 行被导入。
- [[change-set]]、`[[update-planner]]` — 基于符号级变更结果做文章级变更集合与更新规划。
- 上游对照：FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（本模块是表驱动移植）与 `src/be/updater/graph_diff.py`（`graph-diff` 逐位移植的来源）。

## Known Issues

- **WASM 是可选依赖，缺失时静默降级为正则**：`init()` 失败只记账 `initError`、返回 `false`，AST 路径全部退回 `regexExtract`（有损但不丢符号）。`semanticPlan` 会据此退回目录分组（`index.js` 1431）。早期实现直接 `return []` 导致整块语言凭空消失、日志只看到 `skipped +N`——已在 `lib/symbols.js` 286–297 的说明里记为历史缺陷，并用 `stats.regex` 让调用方看得见降级（见测试 `test-symbols.mjs` 333–342）。
- **调用级边未做**：`resolveImportEdges` 只建「文件级 import 边」（够用于模块聚类与 edge 变更判定），没有建函数调用级边（见 `lib/symbols.js` 807–809 的注释「调用级边留待需要时扩充」）。
- **正则路径精度明显低于 AST**：`regexExtract` 只扫顶层附近（`REGEX_MAX_LINES = 4000`，`lib/symbols.js` 371）、不嵌套、不精确取字节区间，源码切片取「定义行到下一个定义行前」（`lib/symbols.js` 420–426）。容器成员归属、基类、docstring 在正则路径下全部为空（见 `regexExtract` 的 `baseClasses: []`/`docstring: ''` 433–436）。
- **C/C++ 依赖 `fnDeclarator` 启发式**：函数名/参数从 `function_declarator` 子节点取（`lib/symbols.js` 631–638），`stripCallSuffix` 对 `(*fn)(...)` 这类函数指针形态做了兼容（722–727），但极端写法仍可能取错名。
- **`resolveSpec` 对未知 spec 返回 `null` 即丢边**：无法解析成仓库内相对路径的 import（如第三方包 `lodash`、绝对路径）直接跳过（`lib/symbols.js` 253、849），不报错也不记入依赖图。
- **Python 点号模块匹配只比对后缀**：`resolveSpec` 的 Python 分支在找不到 `a/b/c.py` 时，退化为「只比对模块名后缀」（`lib/symbols.js` 872–873），包路径不完整时可能误连到同名模块。
- **`bash`/`lua` 无 `parameters` 抽取**：`REGEX_RULES` 里 bash/lua 的 `fn` 不含参数捕获组（`lib/symbols.js` 363、366），这两类语言的符号 `parameters` 恒为空数组。

