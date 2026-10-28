---
title: symbols
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
tags: [ast, tree-sitter, symbol-extraction, import-graph, code-analysis]
---

## Overview

`lib/symbols.js` 负责**源码级符号提取与导入依赖图构建**，是 CodeWiki「按组件（符号）而非按文件」划分模块与文章的基础数据源。它对应上游 FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取函数/方法/类 + 调用关系），但做了两处有意为之的差异：

- 上游每个语言一个 ~800 行 Python 模块、逐语言硬编码；这里用一张 `LANG_RULES` 表驱动，把「符号节点类型 + 名称字段 + 参数字段 + 基类字段」声明化，加语言只加一行（`lib/symbols.js:36`）。
- 上游用原生 tree-sitter 绑定（需编译）；这里用 `web-tree-sitter` + WASM 语法，装依赖仍是一条 `npm install`，不引入 Python/cargo。

组件 id 约定为 `<相对路径>#<符号名>`（方法为 `#<类名>.<方法名>`），与上游 `<相对路径>::<符号名>` 同构，只是分隔符改为 `#` 以避免 Windows 盘符混淆（`lib/symbols.js:10`）。输出形状与 `lib/graph-diff.js` 的 Node 记录契约一致：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（`lib/symbols.js:13`）。

该模块对外提供两条核心能力：
1. **单文件符号提取**（`SymbolExtractor.extractFile`）——优先走 AST（tree-sitter WASM），不可用时降级到正则（`regexExtract`），两条路都不通才返回空；
2. **整仓库图构建**（`extractRepoGraph`）+ **导入边解析**（`resolveImportEdges`）——把符号聚成 `graph: Map<id, node>`，并把各文件的 import 语句解析成组件级 `dependsOn` 依赖边。

## Key Components

### 导出常量与表

- `DEFAULT_VENDOR_DIR`（lib/symbols.js:25）— `vendor/tree-sitter` 绝对路径，作为 WASM 语法与 `web-tree-sitter` 依赖的搜索根。依赖装在 `vendor/tree-sitter` 而非插件根 `node_modules`，避免宿主注入的 `@deepseek-ai/*` 符号链接被 npm 破坏（`lib/symbols.js:21`）。
- `LANG_RULES`（lib/symbols.js:36）— 各语言语法表：`扩展名 -> { wasm 名, 符号规则 }`。规则字段包括 `container`/`containerName`/`containerBases`/`containerKind`、`fn`/`fnName`/`fnParams`/`fnKind`/`methodKind`、`imports`、`arrow`、`doc`、`fnDeclarator`/`receiverField` 等。覆盖 javascript、typescript、python、rust、go、java、c、cpp、csharp、ruby、php、kotlin、scala、dart、bash、lua 共 16 种语言（`lib/symbols.js:36`–`271`）。
- `SUPPORTED_EXTS`（lib/symbols.js:273）— 由 `LANG_RULES` 反推的 `扩展名 -> 语言` 映射（`Map`），用于 `extractFile` 快速判断文件可解析性。
- `WASM_FILE_OVERRIDE`（lib/symbols.js:279）— `tree-sitter` 的 wasm 文件名与语言 id 不一致的硬编码映射，目前只有 `csharp: 'tree-sitter-c_sharp'`。
- `REGEX_RULES`（lib/symbols.js:302）— 正则降级规则表：每种语言给出 `fn`/`cls`/`iface`/`arrow` 正则，捕获组 1 为名字、组 2 为参数。AST 不可用时由 `regexExtract` 使用。
- `REGEX_MAX_LINES`（lib/symbols.js:371）— 正则路径单文件扫描行数上限 4000，缩进过深的行当块内实现忽略。

### 导出函数

- `wasmFileFor(lang)`（lib/symbols.js:281）— 返回某语言对应的 wasm 文件名（套用 `WASM_FILE_OVERRIDE`）。
- `regexExtract(relPath, content, lang)`（lib/symbols.js:374）— 纯正则降级提取，按行扫（粗粒度跳过块注释/空行/`//`/`#`），类优先于函数，产出与 AST 同形状的符号记录（`sourceCode` 取「该定义行到下一个定义行」，末符号最多 60 行）。无规则语言或空内容返回 `[]`。
- `parseParamList(text)`（lib/symbols.js:443）— 参数列表文本 → 参数名数组，AST 与正则两条路径共用。按顶层逗号切分（跳过嵌套括号/尖括号），再去掉默认值（`=...`）与类型标注（`:...`），剥离 `...`/`*`/`$` 前缀。
- `extractRepoGraph(files, opts)`（lib/symbols.js:785）— 批量提取入口：遍历 `files`（`string` 或 `{path, content}`），逐文件调 `extractFile`，产出 `{ graph: Map<id,node>, byFile: Map<file, id[]>, skipped, extractor, ready, stats }`。每个文件至少产出 1 个组件才计入 `stats.files`，否则进 `skipped`。
- `resolveImportEdges(graph, byFile, files)`（lib/symbols.js:810）— 依赖边解析：对 `byFile` 中每个文件调 `extractImportSpecs` 取 import 说明符，用 `resolveSpec` 把说明符解析成本仓库内已知相对路径，连成 `edges`（去重）。同时把边落到组件层：from 文件每个组件的 `dependsOn` 追加 to 文件的所有组件 id。
- `extractImportSpecs(_file, text)`（lib/symbols.js:837）— 用 `IMPORT_RE`（lib/symbols.js:835）从源码文本里抓所有 import 说明符（覆盖 `import ... from`、`import '...'`、`from x import`、`#include`、`use`、`require(...)` 等），返回去重数组。
- `resolveSpec(fromFile, spec, known)`（lib/symbols.js:849）— 把 import 说明符解析为已知文件相对路径：相对路径（`.` 开头）按 `path.posix` 归一化并补全 `.js/.mjs/.ts/.py/.rs/.go/.java` 及 `index.*`/`__init__.py`/`mod.rs`；Python 点号模块 `a.b.c -> a/b/c.py`；Rust `use`/C 头文件按尾名匹配 `known`。匹配不到返回 `null`。

### SymbolExtractor 类（lib/symbols.js:472）

构造参数 `opts`：`vendorDir`（默认 `DEFAULT_VENDOR_DIR`）、`wasmDir`（默认 `null`，由 `resolveWasmDir` 兜底）。

实例字段：
- `parsers`（Map：lang -> `{ parser, language }`）— 解析器池，语法只加载一次（每次 `init` 20–50ms，按文件加载会拖垮大仓库，`lib/symbols.js:469`）。
- `ParserCtor` / `LanguageCtor` — 惰性缓存的 `web-tree-sitter` 构造器。
- `initError` — 初始化/语法加载失败信息；非 null 后 `init()` 直接返回 false。
- `stats` — `{ files, parsed, failed, languages, regex?, regexLanguages? }`，供调用方观测降级情况。

方法：
- `vendorImport(sub)`（lib/symbols.js:484）— 从 vendor 树按绝对路径导入（`path.join(vendorDir, 'node_modules', sub)`），用 `createRequire` 解析；目录不存在返回 `null`。
- `init()`（lib/symbols.js:498）— 惰性导入 `web-tree-sitter`，失败写 `initError` 并返回 false（保证插件无 AST 依赖也能启动）。
- `getParser(lang)`（lib/symbols.js:521）— 取/建某语言解析器；依赖缺失或 wasm ABI 不匹配时静默降级（写 `initError`，返回 `null`），不中断整体。
- `resolveWasmDir()`（lib/symbols.js:544）— 解析 wasm 目录：`vendor/tree-sitter/node_modules/tree-sitter-wasms/out`。
- `extractFile(relPath, content)`（lib/symbols.js:551）— 解析单个文件：未知扩展名返回 `[]`；AST 不可用→正则兜底并记 `stats.regex`；AST 解析抛错→`stats.failed++` 后正则；AST 成功但零符号→再兜一层正则。
- `walk(node, rule, relPath, content, out, container)`（lib/symbols.js:597）— 递归收集：容器（类/struct/impl 等）连同成员方法一起成组件，顶层函数单独成组件。处理 C/C++ 的 `fnDeclarator`（`findDeclarator`）、Go 的 `receiverField`（`recv` 拼成 `<类型>.<方法>`）、箭头函数赋值（`findArrow`）。
- `findArrow(decl)`（lib/symbols.js:697）— 在变量声明节点里找 `arrow_function`/`function` 子节点。
- `findDeclarator(node)`（lib/symbols.js:710）— C/C++：`function_definition -> function_declarator`（可能包 `pointer_declarator`）。
- `stripCallSuffix(text)`（lib/symbols.js:722）— 去掉 declarator 文本里的 `(*fn)` 指针/调用后缀，只留函数名。
- `fieldText(node, field)`（lib/symbols.js:729）— 安全取节点命名字段文本；无字段或抛错返回 `null`。
- `parseParams(text)`（lib/symbols.js:739）— 调 `parseParamList`。
- `parseBases(text, node, rule)`（lib/symbols.js:743）— 基类文本 → 基类名数组（按逗号切、去括号）。
- `sliceSource(node, content)`（lib/symbols.js:751）— 按节点字节范围切源码（`startIndex..endIndex`，多字节安全）。
- `extractDoc(node, rule, content)`（lib/symbols.js:759）— 取 docstring：Python 取 body 内首个字符串表达式（`first_string_in_body`）；Rust 取节点前驱行注释（`preceding_line_comment`）；其余语言返回 `''`。
- `componentId(relPath, name)`（lib/symbols.js:776）— 拼 `relPath#name`。

## Architecture

```text
文件清单(files)
   │  extractRepoGraph (lib/symbols.js:785)
   ▼
SymbolExtractor.extractFile (lib/symbols.js:551)
   │  getParser(lang) (lib/symbols.js:521)
   ├── AST 可用 ──► walk() 递归 (lib/symbols.js:597) ──► 符号记录[]
   │  getParser 失败/ABI 不匹配/零符号/解析抛错
   └── 降级 ──► regexExtract() (lib/symbols.js:374) ──► 符号记录[]
   │
   ▼
graph: Map<id,node>  +  byFile: Map<file, id[]>
   │  resolveImportEdges (lib/symbols.js:810)
   ├── extractImportSpecs (lib/symbols.js:837) 取说明符
   ├── resolveSpec (lib/symbols.js:849) 说明符→已知文件
   └── 连边 + 写 graph[].dependsOn
   ▼
完整符号图 ──► 消费方：[[cluster]] / [[incremental]] / [[graph-diff]]
```

## Data Flow

1. **输入**：`files` 是 `string[]` 或 `{path, content}[]`（相对仓库根）。`extractRepoGraph` 先 `init()`，再逐文件调 `extractFile`（`lib/symbols.js:785`–`802`）。
2. **单文件提取**：`extractFile` 按扩展名查 `SUPPORTED_EXTS` 得 `lang`；`getParser` 返回解析器则 `parser.parse(content)` 后 `walk` 出符号；否则 `regexExtract` 兜底。每个符号记录携带 `sourceCode`（字节切片）、`docstring`、`parameters`、`baseClasses`、`dependsOn:[]`（`lib/symbols.js:426`–`594`）。
3. **图聚合**：所有符号进 `graph`（`Map`，键=`id`），每个文件产出的 id 列表进 `byFile`；空产出文件进 `skipped`（`lib/symbols.js:790`–`804`）。
4. **依赖边**：`resolveImportEdges` 用正则（`IMPORT_RE`）扫每个文件的 import 文本，把说明符经 `resolveSpec` 解析成仓库内已知相对路径，生成 `edges` 并把 `to` 文件的全部组件 id 追加进 `from` 文件每个组件的 `dependsOn`（`lib/symbols.js:812`–`833`）。注意：当前只做**文件级 import 边**，调用级边留待扩充（`lib/symbols.js:849`）。
5. **下游消费**：符号图被 `[[cluster]]`（`formatComponents` 按文件分组喂给 LLM 聚类）、`[[incremental]]`（经 `slimComponent` 取 `bodyHash`/`codeHash` 做组件级增量判定）、`[[graph-diff]]`（复用同形状 Node 记录做签名/实现级 diff）消费。

## Connections

- [[graph-diff]] — 符号记录形状（`{id,name,kind,relativePath,sourceCode,docstring,parameters,baseClasses,dependsOn}`）与 `lib/graph-diff.js` 的 Node 契约一致（lib/symbols.js:13 / graph-diff.js:10）；`[[incremental]]` 用 `bodyHash`/`codeHash` 做增量判定。
- [[cluster]] — `cluster.js` 的 `formatComponents` 直接消费本模块产出的 `graph` 节点（`relativePath`/`id`/`kind`/`name`/`parameters`）；id 形态 `path#name` 在聚类提示词里明确（`cluster.js:15`）。
- [[incremental]] — `test-incremental.mjs` 直接 `import { extractRepoGraph } from './lib/symbols.js'` 构造测试图；`lib/incremental.js` 的 `slimComponent` 读取本模块节点字段（`SLIM_FIELDS`，lib/incremental.js:26）。
- [[engine-manifest]] — vendor 子树（含 `web-tree-sitter` / `tree-sitter-wasms`）由引擎环境提供与本模块对接。

## Known Issues

- `resolveImportEdges` 仅解析**文件级 import 边**，不含函数/方法调用级边；调用级依赖图尚未实现（`lib/symbols.js:810`）。
- 正则降级路径精度明显低于 AST：拿不到精确字节区间与嵌套结构，仅认顶层附近定义（`REGEX_MAX_LINES=4000` 上限，`lib/symbols.js:371`）。早期实现 AST 不可用时直接 `return []` 导致整块语言静默消失，已改为正则兜底并记 `stats.regex`（`lib/symbols.js:288`–`296`）。
- C/C++ 函数名与参数挂在 `function_declarator` 子节点（`fnDeclarator: true`），靠 `findDeclarator` 向下取一层；若语法细则未覆盖某语言新写法，AST 解析成功却零符号时会再兜一层正则（`lib/symbols.js:582`–`592`）。
- `wasmDir` 默认依赖 `vendor/tree-sitter/node_modules/tree-sitter-wasms/out` 存在；vendor 子树缺失或 ABI 不匹配时 `getParser` 静默返回 `null` 走正则，仅通过 `stats.regex* / initError` 可见（`lib/symbols.js:536`–`541`）。
- Ruby 的 `imports: []`、bash/lua 的 `imports: []` 意味着这些语言的 import 边不会被 `resolveImportEdges` 解析（`lib/symbols.js:810`、`:255`、`:269`）。
