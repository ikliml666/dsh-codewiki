---
title: symbols
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
  - index.js
  - lib/cluster.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/change-set.js
tags: [symbol-extraction, ast, tree-sitter, repository-graph, dependency-edges]
---

## Overview

`lib/symbols.js` 是 dsh-codewiki 的「源码符号提取 + 仓库依赖图」基础设施层，对应上游
FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取函数/方法/类
加调用关系）。它把任意仓库的源文件清单编译成一张组件图：

- 每个「函数 / 方法 / 类（容器）」是一个组件节点，id 约定为 `<相对路径>#<符号名>`
  （方法为 `<相对路径>#<类名>.<方法名>`），见 `lib/symbols.js:10-14`。
- 每个节点的形状（契约）与 `lib/graph-diff.js` 的 Node 记录完全一致：`{ id, name, kind,
  relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`
  （`lib/symbols.js:13-14`），这样下游的增量 diff（`lib/incremental.js`、`lib/graph-diff.js`）、
  模块聚类（`lib/cluster.js`）与更新计划（`lib/update-planner.js`）可以直接消费同一套数据。

设计上与上游有两点关键差异（有意为之，`lib/symbols.js:4-11`）：

1. 上游每语言一个 ~800 行 Python 模块、逐语言硬编码；这里用一张**声明式表**
   `LANG_RULES`（`lib/symbols.js:36-271`）把「符号节点类型 + 名称字段 + 参数字段 + 基类字段」
   声明化，**加一门语言只加一行规则**。
2. 上游用原生 tree-sitter 绑定（需编译）；这里用 `web-tree-sitter` + WASM 语法包，依赖装在
   独立的 `vendor/tree-sitter` 子树（`lib/symbols.js:21-25`），一条 `npm install` 即可，不引入
   Python/cargo，不污染宿主注入的 `node_modules`。

**降级是第一等公民**：WASM 语法是可选依赖（没装、装坏、或 `.wasm` 与运行时 ABI 不匹配时），
AST 路径拿不到任何符号。早期实现直接 `return []` 会让整块语言静默消失。本模块在 AST 不可用时
退到**正则兜底** `regexExtract`（`lib/symbols.js:374-440`），且把命中记进
`extractor.stats.regex`，让调用方看得见降级发生了（见 `lib/symbols.js:288-296`、测试
`test-symbols.mjs:333-342`）。

本模块对外暴露两大能力：

- 单文件提取：`SymbolExtractor.extractFile(relPath, content)`（`lib/symbols.js:551-594`）。
- 仓库批量提取 + 边解析：`extractRepoGraph`（`lib/symbols.js:785-805`）产出
  `graph: Map<id,node>`、`byFile: Map<file, ids[]>`；`resolveImportEdges`
  （`lib/symbols.js:810-833`）把各文件 import 语句解析成「本仓库内的相对路径」并连成组件级
  `dependsOn` 边。

## Key Components

### 导出常量与映射

- `DEFAULT_VENDOR_DIR`（`lib/symbols.js:25`）：默认 vendor 路径，=
  `<PKG_ROOT>/vendor/tree-sitter`，`PKG_ROOT` 由 `lib/symbols.js:24` 解析为插件根目录。
- `LANG_RULES`（`lib/symbols.js:36-271`）：`Map`-like 对象（实际是普通对象），键为语言 id，值为
  该语言的语法/提取规则。每条规则的字段（含义见 `lib/symbols.js:27-35` 注释）：
  - `wasm`：WASM 语法包名（如 `tree-sitter-javascript`）。
  - `exts`：该语言覆盖的扩展名数组。
  - `container` / `containerName` / `containerBases` / `containerKind`：容器节点类型（类/结构体/
    impl/trait 等）、名称字段名、基类字段名（`null` 表示无基类）、记为什么 `kind`（一律 `class`）。
  - `fn` / `fnName` / `fnParams` / `fnKind` / `methodKind`：函数节点类型数组、名称字段、
    参数字段、顶层函数 kind、容器内成员 kind（method）。
  - `imports`：用于依赖边的 import 节点类型数组。
  - 语言特有字段：`arrow`（JS/TS 的 `lexical_declaration`/`variable_declaration`，用于箭头函数），
    `doc`（`python: 'first_string_in_body'`、`rust: 'preceding_line_comment'`），
    `fnDeclarator`（C/C++：`true`，名称与参数在 `function_declarator` 子节点上），
    `receiverField`（`go: 'receiver'`，方法名要拼上接收者类型）。
  - 已声明语言（≥15 种，测试 `test-symbols.mjs:358` 断言 `Object.keys(LANG_RULES).length >= 15`）：
    `javascript`、`typescript`、`python`、`rust`、`go`、`java`、`c`、`cpp`、`csharp`、`ruby`、`php`、
    `kotlin`、`scala`、`dart`、`bash`、`lua`。
- `SUPPORTED_EXTS`（`lib/symbols.js:273-276`）：由 `LANG_RULES` 推导出的 `Map<ext, lang>`
  （如 `.tsx -> typescript`，测试 `test-symbols.mjs:357` 断言）。`lib/update-planner.js:30` 的
  `SOURCE_EXTS` 就是直接复用这个集合判断「路径是不是源码」。
- `REGEX_RULES`（`lib/symbols.js:302-368`）：正则降级规则，每语言含可选 `fn` / `cls` / `iface` /
  `arrow` 正则（捕获组 1 = 名字，部分带捕获组 2 = 参数）。无规则的语言（如 `bash` 只有 `fn`）按行降级。
- `WASM_FILE_OVERRIDE`（`lib/symbols.js:279`）：`{ csharp: 'tree-sitter-c_sharp' }`，因为
  tree-sitter 的 wasm 文件名与语言 id 不一致。`wasmFileFor(lang)`（`lib/symbols.js:281-283`）
  优先用 override，否则取 `LANG_RULES[lang].wasm`。
- `IMPORT_RE`（`lib/symbols.js:835`）：import 语句抓取正则，覆盖 `import x from`、
  `import '...'`、`from x import`、`#include`、Rust `use`、JS `require()` 等写法。

### 导出函数

- `regexExtract(relPath, content, lang)`（`lib/symbols.js:374-440`）：正则降级主函数。按行扫描
  （最多 `REGEX_MAX_LINES = 4000` 行，`lib/symbols.js:371`），跳过块注释/空行/行注释，匹配
  `cls`/`iface`/`fn`/`arrow` 四类规则，按「定义行到下一个定义行之前（末符号最多 60 行）」切出
  `sourceCode`。返回与 AST 路径**同形状**的节点数组（`id`/`name`/`kind`/`relativePath`/
  `sourceCode`/`docstring:''`/`parameters`/`baseClasses:[]`/`dependsOn:[]`），无规则语言或空
  content 返回 `[]`（测试 `test-symbols.mjs:328-331`）。
- `parseParamList(text)`（`lib/symbols.js:443-466`）：参数文本 -> 参数名数组，两条路径共用。
  先按顶层逗号切分（跳过嵌套括号/尖括号），再对每个去掉默认值（`=...`）、类型标注（`:...`）、
  剩余 `...`/`*`/`$` 前缀，只留参数名。
- `extractImportSpecs(_file, text)`（`lib/symbols.js:837-847`）：用 `IMPORT_RE` 抓出所有 import
  路径字符串，去重返回 `string[]`；额外再扫一遍 `require('...')`（`lib/symbols.js:845`）兜底。
  `_file` 参数保留但当前未使用（签名兼容）。
- `resolveSpec(fromFile, spec, known)`（`lib/symbols.js:849-884`）：把一个 import 字符串解析成本
  仓库内的相对路径（命中 `known` 集合则返回，否则 `null`）。三种策略：
  1. 相对路径（`.` 开头）：`path.posix.normalize(join(dir, spec))`，并补全
     `.js/.mjs/.jsx/.ts/.tsx/.py/.rs/.go/.java` 及 `index.*`/`__init__.py`/`mod.rs`
     （`lib/symbols.js:853-863`）。
  2. Python 点号模块（`a.b.c`）：替换成 `a/b/c.py`（及 `__init__.py`、`.js/.ts`），再按文件名
     后缀匹配（`lib/symbols.js:866-874`）。
  3. Rust `use crate::a::b` / C/C++ 头文件：取 `::` 或 `/` 分隔的末段，按文件名（去扩展名）匹配
     已知文件（`lib/symbols.js:877-882`）。
- `extractRepoGraph(files, opts)`（`lib/symbols.js:785-805`）：批量提取入口。`files` 为
  `{ path, content }` 或纯字符串路径数组（调用 `index.js` 的 `extractCurrentGraph` 时传带
  content 的对象，见 `index.js:2244-2248`）。返回
  `{ graph, byFile, skipped, extractor, ready, stats }`。其中 `skipped` 是没有任何符号的文件
  列表，`stats` 即 `extractor.stats`。注意：**本函数只提取组件，不建依赖边**——边由调用方显式调
  `resolveImportEdges`，见 `index.js:2251-2254` 的修复说明。
- `resolveImportEdges(graph, byFile, files)`（`lib/symbols.js:810-833`）：依赖边解析。遍历
  `byFile`，对每个文件用 `extractImportSpecs` + `resolveSpec` 解析出依赖目标文件，产出
  `{ from, to, spec }` 边数组；并把边落到**组件层**：`from` 文件所有组件的 `dependsOn` 追加
  `to` 文件的所有组件 id（`lib/symbols.js:826-829`）。`files` 应是 `Map<path, content>` 或带
  `.get(file)` 的对象，取不到文本则跳过该文件。

### 类 `SymbolExtractor`（`lib/symbols.js:472-779`）

构造器 `constructor(opts)`（`lib/symbols.js:473-481`）：
- `opts.vendorDir`：覆盖 `DEFAULT_VENDOR_DIR`（测试 `test-symbols.mjs:335` 用不存在的 vendor
  目录逼 `getParser` 失败以验证正则兜底）。
- `opts.wasmDir`：显式指定 wasm 目录，覆盖 `resolveWasmDir` 的默认推导。
- 实例字段：`parsers`（`Map<lang, {parser, language}>`）、`ParserCtor`、`LanguageCtor`、
  `initError`、`stats = { files:0, parsed:0, failed:0, languages:{} }`
  （`lib/symbols.js:476-480`）。`stats` 还会被 `extractFile` 动态加 `regex` 与
  `regexLanguages` 字段（见下）。

方法：
- `vendorImport(sub)`（`lib/symbols.js:484-495`）：从 vendor 树按绝对路径导入（插件根
  `node_modules` 没有这些包，裸说明符解析不到）。用 `createRequire` 让 Node 自行解析，失败返回
  `null`。
- `init()`（`lib/symbols.js:498-519`）：惰性导入 `web-tree-sitter`（`Parser`/`Language`，
  兼容 `mod.default` 导出），调 `Parser.init()`。失败（缺包/缺导出）把原因写进 `initError`
  并返回 `false`，使插件**照常启动、只是没有 AST 能力**（测试 `test-symbols.mjs:42-45`）。
- `getParser(lang)`（`lib/symbols.js:521-542`）：解析器池，语法只加载一次（每次 `init` 需
  20–50ms，按文件加载会拖垮大仓库，见 `lib/symbols.js:469`）。查 `parsers` 缓存 → `init()` →
  解析 wasm 路径 → `Language.load` + `parser.setLanguage`。ABI 不匹配时静默降级（缓存 `lang -> null`
  并记 `initError`，不中断整批），返回 `null`。
- `resolveWasmDir()`（`lib/symbols.js:544-547`）：默认 wasm 目录 =
  `<vendorDir>/node_modules/tree-sitter-wasms/out`，不存在返回 `null`。
- `extractFile(relPath, content)`（`lib/symbols.js:551-594`）：单文件提取核心。流程：
  1. 取扩展名 → `SUPPORTED_EXTS` 查 `lang`，未知扩展名直接 `[]`（测试
     `test-symbols.mjs:214-217`）。
  2. `getParser(lang)`：拿不到解析器 → `regexExtract` 兜底，且命中时 `stats.regex++`、
     `stats.regexLanguages[lang]++`（`lib/symbols.js:558-564`）。
  3. `parser.parse` 抛错 → `stats.failed++` 并退回正则（`lib/symbols.js:569-572`）。
  4. 解析成功 → `stats.parsed++`、`stats.languages[lang]++`，`walk` 递归收集
     （`lib/symbols.js:577-581`）；`walk` 抛错只记 `stats.failed`，不丢整文件。
  5. **AST 成功但零符号**（语法细则没覆盖新写法）也兜一层正则（`lib/symbols.js:584-592`），
     避免「解析成功却零符号」这种最难查的静默丢失。
- `walk(node, rule, relPath, content, out, container)`（`lib/symbols.js:597-695`）：递归收集节点。
  三类命中：
  1. 容器节点（`rule.container.includes(typeOf)`）：取 `containerName` 字段作名、`containerBases`
     作基类（经 `parseBases`），整段 `sliceSource` 作 `sourceCode`，`kind=containerKind`。然后
     对 `namedChildren` 递归、`container` 设为 `{ name, id }`，成员方法归属该类
     （`lib/symbols.js:620-623`）。匿名容器名兜底为 `<anon@行号>`（`lib/symbols.js:603`）。
  2. 函数节点（`rule.fn`）：取 `fnName`/`fnParams`；C/C++ 经 `findDeclarator` 下取一层
     `function_declarator`（`lib/symbols.js:631-638`）；Go 经 `receiverField` 取接收者类型
     （`lib/symbols.js:640-648`）。有 `container` 或接收者 → 拼成 `<类名>.<方法名>`、`kind=method`
     （`lib/symbols.js:650-657`）。
  3. 箭头函数赋值（`rule.arrow`）：`findArrow` 找 `arrow_function`/`function` 子节点，取首个
     命名子节点作名，`kind='function'`（`lib/symbols.js:669-690`）。
- `findArrow(decl)`（`lib/symbols.js:697-707`）：BFS 找 `arrow_function`/`function` 节点。
- `findDeclarator(node)`（`lib/symbols.js:710-719`）：BFS 找 `function_declarator`（C/C++ 用）。
- `stripCallSuffix(text)`（`lib/symbols.js:722-727`）：从 declarator 文本里只取函数名
  （`add(int a)` / `(*fn)(int a)` → `add` / `fn`）。
- `fieldText(node, field)`（`lib/symbols.js:729-737`）：安全取 `node.childForFieldName(field)` 文本。
- `parseParams(text)`（`lib/symbols.js:739-741`）：包装 `parseParamList`。
- `parseBases(text, node, rule)`（`lib/symbols.js:743-748`）：基类文本 -> 基类名数组
  （按逗号切、去参数括号里的部分）。
- `sliceSource(node, content)`（`lib/symbols.js:751-757`）：按节点字节范围 `content.slice(start,end)`
  取源码（多字节安全）。
- `extractDoc(node, rule, content)`（`lib/symbols.js:759-774`）：docstring 提取。
  `python: first_string_in_body` 取函数体第一个字符串表达式；`rust: preceding_line_comment` 取
  节点前一个 `line_comment`/`block_comment` 兄弟节点；否则 `''`。
- `componentId(relPath, name)`（`lib/symbols.js:776-778`）：`${relPath}#${name}`。

### 组件节点（graph 中的 value）字段

每个节点（AST 与正则两条路径产出的形状一致，见 `lib/symbols.js:427-437` 与
`lib/symbols.js:608-618`/`654-664`）含：

- `id`：`string` = `<relativePath>#<name>`（方法为 `#<Class>.<method>`）。
- `name`：`string`，容器/顶层函数用原名，方法用 `<Class>.<method>` 全称。
- `kind`：`'class' | 'function' | 'method'`（容器一律记 `class`，见 `containerKind`；
  顶层 `fnKind`，容器内 `methodKind`）。
- `relativePath`：`string`，相对仓库根的路径。
- `sourceCode`：`string`，方法/函数体或类声明的完整源码切片（`sliceSource` 按字节区间取，
  多字节安全）。
- `docstring`：`string`，仅 python/rust 路径会填充（正则路径恒为 `''`）。
- `parameters`：`string[]`，参数名数组（`parseParamList` 已剥离默认值/类型/rest）。
- `baseClasses`：`string[]`，仅带 `containerBases` 的语言（python/ruby/java/...）提取，
  其余语言恒为 `[]`。
- `dependsOn`：`string[]`，初始 `[]`；由 `resolveImportEdges` 在图层面补全（见
  `lib/symbols.js:826-829`），不随 `extractFile` 产生。

## Architecture

`lib/symbols.js` 由三层组成：声明式语言表（静态）、`SymbolExtractor` 解析器池（AST 主路径 +
正则兜底）、批量/边编排函数。下游 `extractCurrentGraph`（`index.js`）把三者串成「仓库 → 组件图
→ 依赖边 → 聚类/增量」。

```text
            files: {path, content}[]                         (index.js:2237 scanRepoFiles)
                          │
                          ▼
                 extractRepoGraph (lib/symbols.js:785)
                          │
            ┌─────────────┴───────────────┐
            ▼                              ▼
   for each file:                  SymbolExtractor (lib/symbols.js:472)
   extractFile (lib/symbols.js:551)
            │                              │
            │   getParser(lang) (lib/symbols.js:521)  ── cache parsers Map
            ▼                              │
   ┌──────────────────┐        ┌──────────┴──────────┐
   │  AST 主路径       │        │  WASM 不可用/ABI错   │
   │  parser.parse +   │  null  │  → regexExtract      │
   │  walk() 递归收集  │◄───────┤  (lib/symbols.js:374)│
   │  (lib/symbols.js: │        └─────────────────────┘
   │   597)            │
   └──────────────────┘
            │  node {id,name,kind,relativePath,sourceCode,docstring,parameters,baseClasses,dependsOn:[]}
            ▼
   graph: Map<id,node>  +  byFile: Map<file, ids[]>
            │
            ▼  (index.js:2254 显式调用)
   resolveImportEdges (lib/symbols.js:810)  ── extractImportSpecs + resolveSpec
            │  把 file 级 import 落到组件级 dependsOn
            ▼
   最终 graph（含 dependsOn 边）──►  lib/cluster.js (聚类) / lib/incremental.js (增量 diff)
```

- **LANG_RULES / REGEX_RULES / SUPPORTED_EXTS**（`lib/symbols.js:36/273/302`）：静态声明层，加语言只
  改这两张表。
- **SymbolExtractor**（`lib/symbols.js:472`）：持有 `web-tree-sitter` 运行时与按语言的解析器缓存，
  AST 失败时无缝切到 `regexExtract`，并在 `stats.regex` 记账。
- **extractRepoGraph / resolveImportEdges**（`lib/symbols.js:785/810`）：批量编排。注意职责切分——
  `extractRepoGraph` 只产组件（不建边），`resolveImportEdges` 单独负责把 import 连成依赖边，调用方
  必须显式串接（否则下游增量侧看不到 `dependsOn`，见 Known Issues 与 `index.js:1480`）。

## Data Flow

一次典型的「仓库 → 组件图」数据流（以 `index.js:2236 extractCurrentGraph` 为例）：

1. `scanRepoFiles(cwd)`（`index.js:2208`）递归扫描仓库，跳过黑名单目录（`.git`/`node_modules`/
   `vendor`/`dist`...，`index.js:2194-2198`）、二进制后缀（`index.js:2199-2204`）、单文件 >256KB
   或空文件、总数上限 2000（`index.js:2205-2206`），产出 `{ path, bytes }[]`。
2. 逐个 `fs.readFileSync` 读成 `{ path, content }` 对象，塞进 `textByFile: Map<path, content>`
   （`index.js:2240-2246`）。
3. `extractRepoGraph(inputs, { cwd })`（`index.js:2248` → `lib/symbols.js:785`）：内部 `new
   SymbolExtractor`，`init()` 加载 `web-tree-sitter`，对每个文件 `extractFile`。
   - 未知扩展名 / 解析器拿不到 → `regexExtract` 兜底（记录 `stats.regex`）。
   - 成功文件：`byFile.set(rel, recs.map(id))`、`graph.set(id, rec)`（`lib/symbols.js:799-800`）；
     零符号文件推入 `skipped`（`lib/symbols.js:796`）。
   - 返回 `{ graph, byFile, skipped, extractor, ready, stats }`。
4. `ready` 为 `false`（没装 WASM）→ 返回 `graph:null`，调用方退回文件级判定（`index.js:2249`）。
5. `resolveImportEdges(ex.graph, ex.byFile, textByFile)`（`index.js:2254` → `lib/symbols.js:810`）：
   把 `byFile` 里每个文件的 import 解析成目标文件，并把 `from` 文件所有组件的 `dependsOn` 追加
   目标文件组件 id。建边失败只 `catch` 降级为「无依赖判定」，不阻断（`index.js:2254`）。
6. 最终返回 `{ graph, byFile, ready:true, skipped }`，喂给：
   - **聚类**：`lib/cluster.js` 的 `clusterComponents` 用 `formatComponents`（`lib/cluster.js:28`）
     按文件分组渲染组件（只给 `id/kind/name/参数签名`，不给全文），产出模块树。
   - **增量**：`lib/incremental.js` 的 `filterStaleTasks`（`lib/incremental.js:140`）用 `graph`
     的 `id`/`sourceCode`/`docstring`/`parameters`/`baseClasses`/`dependsOn` 做组件级 diff，决定
     哪些文章需要重写。

单文件提取的降级判定（`extractFile`，`lib/symbols.js:551-594`）数据流分支：

```text
extname(relPath) ──► SUPPORTED_EXTS.get(ext) ── 未知 ──► []
                              │ 已知 lang
                              ▼
                   getParser(lang) ── null ──► regexExtract (记 stats.regex)
                          │ 有 parser
                          ▼
                   parser.parse(content) ── 抛错 ──► stats.failed++ + regexExtract
                          │ 成功
                          ▼
                   walk() 递归收集 ── 零符号 ──► regexExtract (记 stats.regex)
                          │ 有符号
                          ▼
                   out (AST 节点数组)
```

注意 `dependsOn` 不会在 `extractFile` 内产生（恒为 `[]`），必须等 `resolveImportEdges` 在图上补全
（`lib/symbols.js:826-829`）——这是 0.14.0 修掉的关键缺陷（增量侧过去从不建边，导致「被依赖模块
变了、使用方文章却不重写」的判定失效，见 `index.js:2251-2253`）。

## Connections

- [[index]]：`index.js:16` 导入 `extractRepoGraph` 与 `resolveImportEdges`；`extractCurrentGraph`
  （`index.js:2236`）是本模块在真实编排中的唯一入口，把「扫描仓库 → 提符号 → 建依赖边」串成
  `graph`/`byFile` 供后续阶段使用。
- [[cluster]]：`lib/cluster.js` 消费组件节点（`formatComponents` 用 `relativePath`/`id`/`kind`/
  `name`/`parameters`，`lib/cluster.js:28-46`），把组件聚成模块树。组件 id 约定（`path#name`）
  在 `lib/cluster.js:15` 显式说明。
- [[graph-diff]]：`lib/graph-diff.js` 与本模块共用同一份 Node 形状契约（`lib/symbols.js:13-14` 与
  `lib/graph-diff.js:447-449` 同构），`diffGraphs`/`changedIds` 直接对 `extractRepoGraph` 产出的
  `Map<id,node>` 做组件级 diff。
- [[incremental]]：`lib/incremental.js` 的 `filterStaleTasks`（`lib/incremental.js:140`）与
  `slimGraph`（`lib/incremental.js:37`，只存 `SLIM_FIELDS` 含 `dependsOn`）消费本模块的图；
  `symbolIncremental` 开关（`index.js:144`）控制是否走符号级增量。
- [[update-planner]]：`lib/update-planner.js:20` 复用本模块的 `SUPPORTED_EXTS` 推导 `SOURCE_EXTS`
  （`lib/update-planner.js:33`），`isSourcePath`（`lib/update-planner.js:33`）据此判断路径是否源码。
- [[change-set]] / [[update-record]]：下游用本模块产出的组件图做变更集归档与更新记录（`index.js`
  的 import 链：`index.js:25` `collectChangeSet`、`index.js:30-33` `planUpdate` 等）。

## Known Issues

- **`extractRepoGraph` 默认不建依赖边（0.14.0 已修，但仍是职责陷阱）**：`extractRepoGraph`
  （`lib/symbols.js:785-805`）只提取组件，`dependsOn` 恒为 `[]`；依赖边必须调用方显式调
  `resolveImportEdges`（`lib/symbols.js:810`）。`index.js:2251-2253` 的注释记录了历史上增量侧从不调
  这个，导致「被依赖模块变了、使用方文章却不重写」的判定根本不生效。若有人在别处直接消费
  `extractRepoGraph` 的图却不补边，会再次踩坑。
- **WASM 依赖是可选且易碎的**：`web-tree-sitter` 装在独立 `vendor/tree-sitter` 子树
  （`lib/symbols.js:21-25`），没装、ABI 不匹配、或某语言 `.wasm` 缺失时整语言会静默退回正则
  （`lib/symbols.js:556-564`）。正则路径**有损但不丢**（拿不到精确字节区间/嵌套结构/基类/docstring），
  所以低精度符号会被无声写入聚类与文章任务。命中记进 `extractor.stats.regex`，但只有在调用方去查
  这个字段时才看得见（`test-symbols.mjs:340-341` 验证了记账行为）。
- **`extractImportSpecs` 的 `_file` 参数未使用**：函数签名保留 `_file`（`lib/symbols.js:837`），纯
  为兼容调用方传两参，实际只用 `text`。未来若想按文件语言切换正则，这里是个待补的钩子。
- **依赖边只做到「文件级 import → 文件组件」**：`lib/symbols.js:807-809` 明确说明——上游连调用级边，
  这里只建 import 文件级边（够模块聚类与 edge 变更判定），调用级边尚未实现。因此 `dependsOn` 是
  粗粒度的「文件 A 依赖文件 B 的所有组件」，而非「函数 f 调用函数 g」。
- **正则路径不解析基类与 docstring**：`regexExtract` 产出的节点 `baseClasses` 恒为 `[]`、
  `docstring` 恒为 `''`（`lib/symbols.js:433-436`），与 AST 路径（python/rust 能提 docstring、
  多语言能提基类）不一致。聚类/增量若依赖这两个字段，在降级路径下会失真。
- **`resolveSpec` 的相对路径补全列表是硬编码的**：`lib/symbols.js:849-854` 写死了候选扩展名与
  `index.*`/`__init__.py`/`mod.rs`，新增语言若用其它入口约定会在解析时漏配。
- **测试对真实仓库有硬依赖**：`test-symbols.mjs:272-286` 的「本插件自身源码可被完整提取」用例依赖
  `index.js`/`lib/symbols.js`/`lib/graph-diff.js`/`client.js` 实际存在，且要求 `web-tree-sitter`
  可用（`test-symbols.mjs:38-45` 不可用时整段 SKIP）。CI 若没装 vendor WASM，AST 相关用例全部跳过，
  只剩正则用例覆盖。
