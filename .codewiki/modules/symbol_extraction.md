---
title: symbol_extraction
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/incremental.js
  - index.js
tags: [ast, tree-sitter, symbol-extraction, repo-graph, module-planning]
---

## Overview

`lib/symbols.js` 是 dsh-codewiki 的符号提取与仓库依赖图构建层，对应 FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取函数/方法/类 + 调用关系）。它把「源码 → 组件图」这一步从上游每个语言一个 800 行 Python 模块、逐语言硬编码的做法，改成**一张声明式语言规则表 + 单一递归 walk**，并改用 `web-tree-sitter` + WASM 语法（而非原生 tree-sitter 绑定）以省去编译步骤。

核心职责有三层：

1. **AST 级符号提取**：用 tree-sitter 把各语言源码解析成组件记录（函数/方法/类/结构体/接口等），每个记录带 `id / name / kind / relativePath / sourceCode / docstring / parameters / baseClasses / dependsOn`。
2. **正则降级兜底**：当 WASM 语法不可用（没装、ABI 不匹配、细则没覆盖某语言新写法）时，退回有损但「不丢」的按行正则提取，避免整块语言在模块划分里凭空消失。
3. **仓库依赖图构建**：`extractRepoGraph` 批量产出 `{ graph, byFile, skipped, stats }`；`resolveImportEdges` 把 import 语句解析成仓库内相对路径依赖边，落到组件级 `dependsOn`。

组件 id 约定 `<相对路径>#<符号名>`（方法为 `<路径>#<类名>.<方法名>`），与上游 `<路径>::<符号名>` 同构，只用 `#` 避免 Windows 盘符里的 `:` 混淆。输出形状与 `lib/graph-diff.js` 的 Node 记录契约一致（见 `graph-diff.js` 第 9–11 行注释）。

## Key Components

### 导出常量与表

- `DEFAULT_VENDOR_DIR`（第 25 行）：`vendor/tree-sitter` 的绝对路径，tree-sitter 依赖装在 vendor 子树而非插件根 `node_modules`（插件根由宿主注入，在那里 `npm install` 会破坏运行环境，见第 21–24 行注释）。
- `LANG_RULES`（第 36–271 行）：各语言语法规则表，扩展名 → `{ wasm, exts, container, containerName, containerBases, containerKind, fn, fnName, fnParams, fnKind, methodKind, imports, arrow, doc, fnDeclarator, receiverField }` 等字段。覆盖 javascript / typescript / python / rust / go / java / c / cpp / csharp / ruby / php / kotlin / scala / dart / bash / lua 共 16 种语言。规则字段含义见第 27–35 行注释。
- `SUPPORTED_EXTS`（第 273–276 行）：由 `LANG_RULES` 派生的 `Map<扩展名, 语言>`，`extractFile` 用它按扩展名选语言。
- `WASM_FILE_OVERRIDE`（第 279 行）：`{ csharp: 'tree-sitter-c_sharp' }`，处理 tree-sitter 的 wasm 文件名与语言 id 不完全一致的问题；`wasmFileFor`（第 281–283 行）据此返回真实 wasm 文件名。
- `REGEX_RULES`（第 302–368 行）：正则降级规则表，与 `LANG_RULES` 同构但只有 `fn / cls / iface / arrow` 正则（不同语言按需给）。`REGEX_MAX_LINES`（第 371 行）限制正则路径单文件最多扫 4000 行。
- `IMPORT_RE`（第 835 行）：import/require/include/use 多语言语句的统一正则，供 `extractImportSpecs` 抽取依赖说明符。

### 导出函数

- `regexExtract(relPath, content, lang)`（第 374–440 行）：正则路径提取，产出与 AST 同形状的符号记录。`sourceCode` 取「该定义行到下一个定义行之前」（末符号最多 60 行，第 422–438 行），`docstring`/`baseClasses`/`dependsOn` 留空。粗粒度跳块注释、空行、`//`、`#` 注释（第 380–394 行），类优先于函数（第 408–411 行）。
- `parseParamList(text)`（第 443–466 行）：参数文本 → 参数名数组，AST 与正则两条路径共用。按顶层逗号切分（跳过嵌套括号/尖括号），再剥默认值（`=`）、类型标注（`:`）、rest（`...`）、指针星号、`$`（第 460–465 行）。
- `extractRepoGraph(files, opts)`（第 785–805 行）：批量提取入口。参数 `files` 为 `{path, content}` 数组或字符串数组；`opts.extractor` 可注入自定义 `SymbolExtractor`。返回 `{ graph: Map<id,node>, byFile: Map<file, id[]>, skipped: string[], extractor, ready, stats }`。`skipped` 为无符号的文件（第 794–798 行）。
- `resolveImportEdges(graph, byFile, files)`（第 810–833 行）：把各文件 import 解析成仓库内相对路径边。对每个 `from→target` 去重后推入 `edges`，并把边落到组件层：`from` 文件所有组件的 `dependsOn` 追加 `to` 文件全部组件 id（第 824–829 行）。`files` 是 `Map<相对路径, 正文>`，缺正文则跳过该文件（第 815–816 行）。
- `extractImportSpecs(_file, text)`（第 837–847 行）：从文本中抽出全部 import/require/include/use 说明符（去重）。
- `resolveSpec(fromFile, spec, known)`（第 849–884 行）：把说明符解析为已知文件里的相对路径。相对路径（`.` 开头）做扩展名/索引文件补全（第 853–864 行）；Python 点号模块 `a.b.c` → `a/b/c.py` 及包尾匹配（第 865–874 行）；Rust `use crate::a::b` / C/C++ 头文件按 basename 匹配（第 876–883 行）。找不到返回 `null`。

### `SymbolExtractor` 类（第 472–779 行）

字段（构造函数第 473–481 行）：

- `vendorDir`（默认 `DEFAULT_VENDOR_DIR`）
- `wasmDir`（默认 `null`，首次用时由 `resolveWasmDir` 填）
- `parsers`：`Map<lang, {parser, language}>`，语法只加载一次
- `ParserCtor` / `LanguageCtor`：`web-tree-sitter` 导出的构造器，惰性导入
- `initError`：初始化/语法加载失败信息
- `stats`：`{ files, parsed, failed, languages, regex?, regexLanguages? }`

方法：

- `vendorImport(sub)`（第 484–495 行）：从 vendor 树按绝对路径导入（插件根 node_modules 没有这些包），用 `createRequire` 让 Node 解析到 package 的 main/exports，找不到返回 `null`。
- `init()`（第 498–519 行）：惰性导入 `web-tree-sitter` 并 `ParserCtor.init()`。依赖没装时插件照常启动、仅无 AST 能力；失败写 `initError` 返回 `false`，幂等（已有 `ParserCtor` 直接 `true`）。
- `getParser(lang)`（第 521–542 行）：按语言取/建解析器；语法文件缺失或 ABI 不匹配时静默降级（把该语言 parser 记为 `null`，第 538–540 行），不中断整个编译。
- `resolveWasmDir()`（第 544–547 行）：`vendor/tree-sitter/node_modules/tree-sitter-wasms/out`，不存在返回 `null`。
- `extractFile(relPath, content)`（第 551–594 行）：**单文件提取主入口**。按扩展名选语言，AST 不可用时退回 `regexExtract` 并记账（第 556–565 行）；`parser.parse` 抛错也退正则（第 566–572 行）；AST 成功但零符号时再兜一层正则（第 584–592 行）。未知扩展名返回 `[]`（第 553–554 行）。
- `walk(node, rule, relPath, content, out, container)`（第 597–695 行）：递归收集。容器（类）连同其成员方法一起成组件（第 602–624 行）；函数/方法按是否存在 `container` 决定 `method` 还是 `function` 的 kind（第 626–666 行）；箭头函数赋值单独处理（第 668–690 行）。匿名符号用 `<anon@行号>` 兜底（第 603、649 行）。
- `findArrow(decl)`（第 697–707 行）：从 `variable_declarator` 向下找 `arrow_function`/`function` 节点。
- `findDeclarator(node)`（第 710–719 行）：C/C++ 向下找 `function_declarator`（可能被 `pointer_declarator` 包一层）。
- `stripCallSuffix(text)`（第 722–727 行）：从 `declarator` 文本里取函数名，剥 `(*fn)` 这类指针写法。
- `fieldText(node, field)`（第 729–737 行）：安全取命名子字段文本（无该字段/抛错返回 `null`）。
- `parseParams(text)`（第 739–741 行）：转发 `parseParamList`。
- `parseBases(text, node, rule)`（第 743–748 行）：基类列表文本 → 数组，剥括号/逗号/构造参数。
- `sliceSource(node, content)`（第 751–757 行）：按节点字节范围切片原文（多字节安全）。
- `extractDoc(node, rule, content)`（第 759–774 行）：取 docstring。Python 取函数体首个字符串字面量（第 760–766 行），Rust 取前一个兄弟行/块注释（第 767–772 行），其余语言默认空。
- `componentId(relPath, name)`（第 776–778 行）：返回 `${relPath}#${name}`。

## Architecture

仓库依赖图构建的非平凡流程（AST 主路径 + 正则降级 + import 边），用 UTF-8 框图表示：

```text
                files: {path, content}[]
                          │
                          ▼
                 extractRepoGraph (785)
                  │          │
        ┌─────────┘          └─────────┐
        ▼                              ▼
  SymbolExtractor.init (498)    for f: extractFile (551)
        │                              │  getParser(lang) (521)
        │                              │   ├─ WASM ok ─► walk() (597) ──► AST 符号
        │                              │   └─ WASM 缺/ABI错/零符号
        │                              │              └─► regexExtract() (374) ──► 正则符号
        ▼                              ▼
   { graph, byFile, skipped, stats }  ◄── 汇总
                          │
                          ▼
              resolveImportEdges (810)
           text=files ► extractImportSpecs (837)
                      ► resolveSpec (849) ──► edges[] + node.dependsOn
                          │
                          ▼
        { graph, byFile, edges } ──► cluster.js / graph-diff.js / incremental.js
```

`SymbolExtractor` 用一张解析器 Map 缓存语法（每次 `init` 20–50ms，不能按文件加载），`walk` 单函数覆盖全部语言（规则驱动），两条提取路径产出**完全相同的记录形状**，下游 `graph-diff` / `cluster` 无需感知差异。

## Data Flow

1. **输入**：`extractRepoGraph(files, opts)` 收到 `{path, content}` 列表（正文已由调用方读好，提取与建边共用，不读两遍，见 `index.js` 第 1324–1336 行）。
2. **逐文件提取**：`extractFile` 按 `SUPPORTED_EXTS` 选语言 → `getParser` 取/建 tree-sitter 解析器 → 成功则 `walk` 递归产出 AST 符号；任何一环失败（语法缺、ABI 不匹配、`parse` 抛错、零符号）都退 `regexExtract`。
3. **记录形状**：每条记录 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`，与 `graph-diff.js` 的 Node 契约一致（`graph-diff.js` 第 9–11 行）。`id === relativePath#name`，`sourceCode` 是节点字节切片。
4. **汇总**：`graph` 是 `Map<id, node>`，`byFile` 是 `Map<file, id[]>`；`stats` 累计 `parsed/failed/languages/regex/regexLanguages`。
5. **依赖边**：`resolveImportEdges` 用 `files` 的 `Map` 取正文，`extractImportSpecs` 抽 import 说明符，`resolveSpec` 映射到已知文件，`edges[]` 记录 `from→to`，并把边落到 `from` 侧组件 `dependsOn`（指向 `to` 文件全部组件 id）。
6. **输出消费**：`index.js` 的 `semanticPlan`（第 1322–1405 行）把 `components` 交给 `cluster.js` 做语义聚类，`edges` 与 `graph` 持久化进 job 的 `plan`（`index.js` 第 1388–1397 行，注意**不带 sourceCode**），供 `lib/incremental.js` 的 `slimGraph`/`filterStaleTasks` 做符号级增量判定。

## Connections

- [[graph-diff]]：组件记录形状与 Node 契约一致；`diffGraphs` / `bodyHash` / `codeHash` 直接消费 `extractRepoGraph` 的 `graph`。
- [[cluster]]：`clusterComponents` / `toPlanModules` 消费 `components`（按 `relativePath` 分组、`parameters`/`kind`/`name` 描述签名），见 `cluster.js` 第 28–46 行 `formatComponents`。
- [[incremental]]：`slimGraph` / `slimComponent` 只读 `SLIM_FIELDS`（`incremental.js` 第 26 行），其中 `bodyHash`/`codeHash` 由 `graph-diff.js` 算出；符号级增量依赖本模块产出的 `components`/`edges`。
- [[update-planner]]：模块树与符号图随 `plan` 持久化，`realChangedIds` / `dependentsOf` 据此判定 stale 文章。
- [[article-contract]]：文章 `source_files` 必须列出本模块产出的真实源文件，供 `fixAnchors` 行号校正。

## Known Issues

- **WASM 依赖是可选依赖**：`vendor/tree-sitter` 没装或 ABI 不匹配时，AST 路径整体失效、自动走正则降级（有损但不丢符号）。早期实现直接 `return []` 静默丢符号，已在 `regexExtract` + 双兜底记账（第 556–565、584–592 行）修复；`stats.regex` / `stats.regexLanguages` 让调用方看得见降级发生。
- **依赖边只做到文件级 import**：`resolveImportEdges` 仅解析 import/require/include/use 语句并按文件连线（第 807–809 行注释明确「调用级边留待需要时扩充」）。方法级/函数级调用边尚未构建，模块聚类与 edge 变更判定只用到文件级粒度。
- **正则路径精度有限**：`REGEX_MAX_LINES = 4000` 限制单文件扫描深度（第 371 行）；块注释/字符串里的定义不做精确区分，只粗粒度跳过；`sourceCode` 区间按「定义行到下一定义行」近似（末符号最多 60 行，第 425 行），可能与真实函数体边界不符。
- **C/C++ 名称解析依赖 `fnDeclarator` 下钻**：函数名/参数挂在 `function_declarator` 子节点（第 138、630–637 行），被 `pointer_declarator` 包一层时由 `findDeclarator` 处理；复杂宏/模板写法可能认不出。
- **`go` 的 `type_spec` 容器**：Go 真正的具名节点是 `type_spec` 而非 `type_declaration`（第 100–101 行注释），方法接收者类型需从 `receiver` 字段手工拼出（第 640–648 行），泛型/多接收者情形未覆盖。
- **`doc` 仅覆盖 python/rust**：除 Python（`first_string_in_body`）与 Rust（`preceding_line_comment`）外，其余语言 docstring 一律返回空字符串（第 759–773 行）。
- **匿名符号兜底**：AST 无名称节点用 `<anon@行号>` 作为 name（第 603、649 行），会污染 `graph` 的 id 唯一性假设，但调用方按 id 去重一般不会冲突。
