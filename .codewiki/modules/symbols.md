---
title: symbols
type: module
source_files:
  - lib/symbols.js
  - test-symbols.mjs
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/incremental.js
  - index.js
tags: [ast, tree-sitter, symbol-extraction, dependency-graph, module-graph]
---

## Overview

`lib/symbols.js` 负责把仓库源码解析成「符号 + 依赖边」组成的仓库图（repository graph），是 CodeWiki 编译流水线的数据底座之一。它对应上游 FSoft-AI4Code/CodeWiki 的 `dependency_analyzer/analyzers/*`（tree-sitter 逐语言提取函数/方法/类 + 调用关系），但这里用**表驱动**替代上游「每种语言一个 800 行 Python 模块」的硬编码写法，加一门语言只需在 `LANG_RULES` 里加一行（见 `lib/symbols.js` 第 36–271 行）。

两条解析路径：

- **AST 路径**（主路径）：用 `web-tree-sitter` + 各语言 WASM 语法做精确的符号识别与字节区间切片，通过 `SymbolExtractor` 类实现（第 472 行起）。
- **正则降级路径**（兜底）：当 WASM 语法没装 / ABI 不匹配 / AST 解析成功却零符号时，退到 `REGEX_RULES` + `regexExtract` 做有损但不丢内容的符号提取（第 288–440 行）。早期实现直接 `return []` 会让整块语言静默消失，所以这里专门记账到 `stats.regex`。

输出形状与 `lib/graph-diff.js` 的 Node 记录契约一致（第 13–14 行注释、第 9–10 行 graph-diff 注释）：

```text
{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }
```

组件 id 约定为 `<相对路径>#<符号名>`（方法为 `#<类名>.<方法名>`），与上游 `<相对路径>::<符号名>` 同构，只是分隔符改用 `#` 以避免 Windows 盘符里的 `:` 混淆（第 10–11 行）。`extractRepoGraph`（第 785 行）把一批文件聚合成 `{ graph, byFile, skipped, extractor, ready, stats }`；`resolveImportEdges`（第 810 行）再把各文件的 import 语句解析成「本仓库内的相对路径依赖边」，回写到每个组件的 `dependsOn`。

## Key Components

### 表驱动配置常量

- **`DEFAULT_VENDOR_DIR`**（`lib/symbols.js:25`）：tree-sitter 依赖所在的 vendor 目录绝对路径，由 `PKG_ROOT`（`lib/symbols.js:24` 插件根 `..`）拼接 `vendor/tree-sitter` 得到。之所以不在插件根 `node_modules` 安装，是因为插件根的 `node_modules` 由宿主注入（符号链接），在那里跑 `npm install` 会破坏运行环境——vendor 子树是独立 npm 根（`lib/symbols.js:21-23`）。

- **`LANG_RULES`**（`lib/symbols.js:36-271`）：各语言语法表，键为语言名，值为规则对象。规则字段含义（见第 27–35 行注释）：
  - `wasm`：WASM 语法包名；`exts`：该语言匹配的扩展名数组。
  - `container`：容器节点类型数组（类/结构体/接口等，内部成员归属该类）；`containerName` / `containerBases`：容器名称 / 基类字段名（如 Python `superclasses`、Java `superclass`、Go 无、Ruby `superclass`）；`containerKind`：容器记作什么 kind（统一为 `'class'`）。
  - `fn`：函数节点类型数组；`fnName` / `fnParams`：名称 / 参数字段；`fnKind`：顶层函数 kind；`methodKind`：容器内成员 kind（统一 `'method'`）。
  - `imports`：import 节点类型数组（用于依赖边）。
  - `arrow`：箭头函数赋值节点类型（JS/TS 的 `lexical_declaration` / `variable_declaration`）。
  - `doc`：取 docstring 的方式（`python` 的 `'first_string_in_body'`、`rust` 的 `'preceding_line_comment'`）。
  - 特殊字段：`rust` 无 `fnDeclarator`；`c`/`cpp` 设 `fnDeclarator: true`（`lib/symbols.js:139,154`，函数名与参数挂在 `function_declarator` 子节点上）；`go` 设 `receiverField: 'receiver'`（`lib/symbols.js:112`，方法名要拼成 `<类型>.<方法>`）；`csharp` 在 `WASM_FILE_OVERRIDE`（`lib/symbols.js:279`）里映射到 `tree-sitter-c_sharp`。
  - 支持的语言（≥15）：`javascript, typescript, python, rust, go, java, c, cpp, csharp, ruby, php, kotlin, scala, dart, bash, lua`。

- **`SUPPORTED_EXTS`**（`lib/symbols.js:273-276`）：`Map<扩展名, 语言>`，由遍历 `LANG_RULES` 构建（扩展名去重，先到的语言优先）。`extractFile` 用它把文件扩展名映射到语言（`lib/symbols.js:36`）。

- **`REGEX_RULES`**（`lib/symbols.js:302-368`）：各语言的正则降级规则，字段（可选）：`fn`（匹配函数/方法定义，捕获组 1 = 名字）、`cls` / `iface`（匹配类/接口定义）、`arrow`（匹配箭头函数，`m[2]`=圆括号参数、`m[3]`=单参数名）。每个语言按需给字段，没有规则的语言（如 `bash`/`lua` 只有 `fn`）返回空。

- **`REGEX_MAX_LINES`** 常量，`lib/symbols.js:371`：正则路径单文件最多扫 4000 行（第 370 行注释：缩进过深的块内实现忽略）。

- **`WASM_FILE_OVERRIDE`**（`lib/symbols.js:279`）：`{ csharp: 'tree-sitter-c_sharp' }`，映射 wasm 文件名与语言 id 不完全一致的情况；由 `wasmFileFor`（`lib/symbols.js:281-283`）使用。

- **`IMPORT_RE`**（`lib/symbols.js:835`）：依赖边解析用的主正则，覆盖 `import ... from`、裸 `import '...'`、`from x import`、`#include "..."` / `<...>`、`use ...`、`require('...')`、以及 `import/require` 后带字符串的松散写法，共 7 个捕获组（`m[1]..m[7]`）。

### 公开函数

- **`regexExtract(relPath, content, lang)`**（`lib/symbols.js:374-440`）：正则降级提取，按行扫 `content`，跳过块注释（`/* ... */`）、行注释与空行（第 380–394 行），用 `REGEX_RULES[lang]` 的 `cls`/`iface`/`fn`/`arrow` 匹配，类优先于函数（第 409–411 行）。每个符号的 `sourceCode` 取「定义行到下一个定义行之前」，末符号最多取 60 行（第 420–438 行）。产出的记录形状与 AST 路径完全一致（`id` 为 `${relPath}#${name}`，含 `kind/relativePath/sourceCode/docstring/parameters/baseClasses/dependsOn`）。`lang` 或 `content` 缺失时返回 `[]`（第 375–376 行）。

- **`parseParamList(text)`**（`lib/symbols.js:443-466`）：参数列表文本 → 参数名数组，AST 与正则两条路径共用。先去掉首尾括号（第 445 行），按顶层逗号切分（跳过嵌套 `()[]<>`，第 447–458 行），再去掉默认值（`=...`）、类型标注（`:...`）、剩余参数前缀 `...`、变参 `*`、bash 的 `$`（第 460–465 行）。空文本返回 `[]`（第 444 行）。

- **`extractRepoGraph(files, opts = {})`**（`lib/symbols.js:785-805`）：批量提取入口。遍历 `files`（每项可为字符串路径或 `{path, content}`），逐文件调 `extractor.extractFile`，无符号的文件记入 `skipped`；有符号的用 `byFile`（文件 → 组件 id 数组）和 `graph`（`Map<id, node>`）聚合，并对每个文件累加 `extractor.stats.files`（第 792–804 行）。返回 `{ graph, byFile, skipped, extractor, ready, stats }`。`opts.extractor` 可注入自定义 `SymbolExtractor`；否则 `new SymbolExtractor(opts)` 并 `init()`（第 786–787 行）。

- **`resolveImportEdges(graph, byFile, files)`**（`lib/symbols.js:810-833`）：依赖边解析。遍历 `byFile` 中每个文件的源文（从 `files` 这个 `Map<file, text>` 取，第 815 行），对每条 `extractImportSpecs` 得到的 spec 调 `resolveSpec` 解析成本仓库目标文件；生成 `from→to` 去重边（第 820–823 行），并把边落到组件层：把 `to` 文件所有组件 id 追加进 `from` 文件每个组件的 `dependsOn`（第 825–829 行，用 `Set` 去重）。返回 `edges` 数组（`{from, to, spec}`）。

- **`extractImportSpecs(_file, text)`**（`lib/symbols.js:837-847`）：从源文提取全部 import spec 字符串。先用 `IMPORT_RE` 的 7 个捕获组之一（第 841 行），再补一轮 `require('...')` 匹配（第 845 行），最后去重（第 846 行）。参数 `_file` 当前未使用（保留签名）。

- **`resolveSpec(fromFile, spec, known)`**（`lib/symbols.js:849-884`）：把 spec 解析成 `known`（已知集合，`byFile.keys()`）中的目标相对路径：
  - 相对路径（`spec.startsWith('.')`）：`path.posix` 归一化后用一组候选（`base` 本身 + `.js/.mjs/.jsx/.ts/.tsx/.py/.rs/.go/.java` + `index.js/index.ts/__init__.py/mod.rs`）逐个命中（第 853–863 行）。
  - Python 点号模块（`^[A-Za-z_][\w.]*$`）：`a.b.c → a/b/c.py` 等候选，再退化用文件名后缀匹配（第 866–875 行）。
  - Rust `use crate::a::b` / C/C++ 头文件：取 `::` 或 `/` 分隔的最后一段，与 `known` 中文件的 basename（去扩展名）比较（第 877–882 行）。
  - 解析不到返回 `null`（第 864、875、883 行）。

### `SymbolExtractor` 类（`lib/symbols.js:472-779`）

解析器池与单文件 AST 提取。构造后必须 `init()` 才可用。

- **构造器 `constructor(opts = {})`**（第 473–481 行）：字段：
  - `this.vendorDir`（默认 `DEFAULT_VENDOR_DIR`）、`this.wasmDir`（默认 `null`）。
  - `this.parsers`：`Map<lang, {parser, language}>`，语法只加载一次（第 469 行注释：每次 init 20–50ms，按文件加载会拖垮大仓库）。
  - `this.ParserCtor` / `this.LanguageCtor`：加载后缓存的构造器，初始 `null`。
  - `this.initError`：初始化错误文案，初始 `null`。
  - `this.stats`：`{ files: 0, parsed: 0, failed: 0, languages: {} }`，外加降级时动态追加的 `regex` 与 `regexLanguages`。

- **`vendorImport(sub)`**（第 484–495 行）：从 vendor 树按绝对路径导入（插件根 `node_modules` 没有这些包，裸说明符解析不到）。先检查 `vendorDir/node_modules/sub` 是否存在，再用 `createRequire(vendorDir/package.json)` 让 Node 自己解析 main/exports 并 `import`；失败返回 `null`（第 492 行）。

- **`init()`**（第 498–519 行）：惰性导入 `web-tree-sitter`（`vendorImport('web-tree-sitter')`）。未找到则记 `initError` 返回 `false`（第 503–506 行）；导出缺 `Parser`/`Language` 也返回 `false`（第 509–512 行）；否则 `await this.ParserCtor.init()` 返回 `true`（第 513–514 行）。已初始化（`ParserCtor` 已设）直接返回 `true`；已失败（有 `initError`）返回 `false`（第 499–500 行）。**依赖没装时插件照常启动，只是没有 AST 能力**。

- **`getParser(lang)`**（第 521–542 行）：按语言取（或加载）解析器。命中缓存直接返回（第 522 行）；`init()` 失败或 `LANG_RULES[lang]` 缺失返回 `null`（第 523–525 行）；解析 WASM 文件（`wasmDir ?? resolveWasmDir()` 下 `${wasmFileFor(lang)}.wasm`）并 `LanguageCtor.load` + `new ParserCtor().setLanguage`（第 526–535 行）；**语法与运行时 ABI 不匹配时静默降级**（把该 lang 记为 `null` 并记 `initError`，第 536–541 行），不中断整个编译。

- **`resolveWasmDir()`**（第 544–547 行）：WASM 目录固定为 `vendorDir/node_modules/tree-sitter-wasms/out`，不存在返回 `null`。

- **`extractFile(relPath, content)`**（第 551–594 行）：解析单个文件 → 符号记录数组。
  - 未知扩展名返回 `[]`（第 552–554 行）。
  - `getParser` 失败 → 正则降级 `regexExtract`，并记账 `stats.regex` / `stats.regexLanguages[lang]`（第 555–565 行）。
  - 有 parser 则 `parser.parse(content)`；解析抛错则 `stats.failed += 1` 并退正则（第 566–572 行）。
  - 解析成功：`stats.parsed += 1`、累加 `stats.languages[lang]`，调 `walk` 递归收集（第 573–581 行）；**walk 抛错也只记 `stats.failed`**。
  - **AST 成功但零符号**（语法细则没覆盖新写法）时也兜一层正则（第 582–592 行），避免「文件解析成功却零符号」这种最难查的静默丢失。

- **`walk(node, rule, relPath, content, out, container)`**（第 597–695 行）：递归收集。节点类型命中 `rule.container` 则产出容器（类）记录，名字缺失时回退 `<anon@行号>`（第 603 行），再递归子节点让成员方法归属该类（第 620–623 行）。命中 `rule.fn` 则产出函数/方法（第 626–666 行），其中：
  - C/C++ `fnDeclarator` 时向下取 `function_declarator`（`findDeclarator`，第 631–638 行）。
  - Go `receiverField` 时从 `receiver` 字段取末词剥指针星号得接收者类型（第 640–648 行），方法名拼成 `<接收者>.<方法>`。
  - 方法 `kind` 取 `methodKind`，顶层函数取 `fnKind`（第 651–657 行）。
  - 命中 `rule.arrow` 则遍历声明子节点找箭头函数（`findArrow`），名字取首个命名子节点文本（第 669–690 行）。其余节点继续递归（第 692–694 行）。

- **`findArrow(decl)`**（第 697–707 行）：`variable_declarator → arrow_function / function` 的 BFS 查找。

- **`findDeclarator(node)`**（第 710–719 行）：C/C++ 找 `function_declarator`（可能被 `pointer_declarator` 包一层）。

- **`stripCallSuffix(text)`**（第 722–727 行）：剥掉 `declarator` 文本里的 `(` 之前部分与指针前缀，只取函数名（处理 `add(int a)` 或 `(*fn)(int a)`）。

- **`fieldText(node, field)`**（第 729–737 行）：安全取节点的命名字段文本（`childForFieldName`，失败/异常返回 `null`）。

- **`parseParams(text)`**（第 739–741 行）：委托 `parseParamList`。

- **`parseBases(text, node, rule)`**（第 743–748 行）：基类文本 → 基类名数组（`superclasses`/`superclass` 等），按逗号切，去掉 `(` 前与 `)` 后、剥掉参数列表（第 747 行）。

- **`sliceSource(node, content)`**（第 751–757 行）：按节点字节范围（`startIndex`/`endIndex`）取原文，多字节安全；异常返回 `''`。

- **`extractDoc(node, rule, content)`**（第 759–774 行）：按 `rule.doc` 取 docstring：
  - `'first_string_in_body'`（Python）：取 body 首个 `expression_statement` 里的字符串字面量（第 760–765 行）。
  - `'preceding_line_comment'`（Rust）：取 `node.previousSibling` 若为 `line_comment`/`block_comment`（第 767–771 行，因 `///` 在函数节点之前、不属于节点本身）。
  - 其它返回 `''`。

- **`componentId(relPath, name)`**（第 776–778 行）：返回 `${relPath}#${name}`，统一组件 id 生成。

> 注：符号记录对象（由 `walk` 与 `regexExtract` 产出）不是 class，而是普通对象，字段固定为 `id / name / kind / relativePath / sourceCode / docstring / parameters / baseClasses / dependsOn`（见 `lib/symbols.js` 中 `walk` 的 `out.push`（如第 608–618 行）与 `regexExtract` 的 `out.push`（第 427–437 行））。这些字段正是 `lib/graph-diff.js`（第 9–10 行）与 `lib/cluster.js`（`formatComponents`，第 28–46 行）、`lib/incremental.js`（`SLIM_FIELDS`，第 26 行）消费的契约。

## Architecture

组件 ≥3，且整条提取+建边流程非平凡，故用 UTF-8 框图表示主链路。两条解析路径由 `getParser`/`extractFile` 在运行时按「WASM 是否可用」分流，正则路径只在 AST 不可用时启用并记账。

```text
 files: [{path,content}]                       ┌─────────────────────────────┐
        │                                      │  LANG_RULES (表驱动)        │
        ▼                                      │  SUPPORTED_EXTS (ext→lang)  │
 ┌──────────────────┐                          └──────────────┬──────────────┘
 │ extractRepoGraph │  (init + 逐文件 extractFile)             │
 └────────┬─────────┘                                          ▼
          │                                       ┌──────────────────────────┐
          ▼                                       │ SymbolExtractor          │
 ┌──────────────────┐  getParser(lang)            │  getParser→WASM load     │
 │  extractFile     │──────────────┐              │  init() lazy import      │
 └────────┬─────────┘              │              │  web-tree-sitter         │
          │                        ▼              └──────────────────────────┘
          │              ┌──────────────────┐
          │   parser?    │   AST path       │ walk() 递归:
          │   null?      │ (web-tree-sitter)│  容器(类) + 成员方法
          ├─────────────►│  slice/extractDoc│  顶层函数 / 箭头函数
          │   yes        └────────┬─────────┘
          ▼                       │ 符号记录 {id,name,kind,...}
 ┌──────────────────┐             ▼
 │  regexExtract    │  REGEX_RULES ──► 同形状符号记录 (stats.regex 记账)
 │  (降级兜底)      │
 └────────┬─────────┘
          ▼  graph:Map<id,node>  byFile:Map<file,ids>
 ┌──────────────────┐
 │ resolveImportEdges│  extractImportSpecs + resolveSpec → 依赖边
 └────────┬─────────┘             ↘ 回写 node.dependsOn
          ▼
    { graph, byFile, edges, skipped, stats }
```

- **配置层**：`LANG_RULES` / `SUPPORTED_EXTS` / `REGEX_RULES` 都是纯数据表，加语言只改这几张表，不改控制流。
- **解析层**：`SymbolExtractor` 持有解析器池（`parsers`），`init()` 惰性导入 `web-tree-sitter`，`getParser` 按语言加载/复用 WASM；`extractFile` 在「parser 缺失 / parse 抛错 / AST 零符号」三种情况下都退到 `regexExtract`。
- **图构建层**：`extractRepoGraph` 聚合成 `graph`/`byFile`；`resolveImportEdges` 用 `extractImportSpecs`+`resolveSpec` 把 import 转成本仓库文件路径依赖边，并回写每个组件的 `dependsOn`。

## Data Flow

以「全量编译的语义规划阶段」为例（`index.js` 的 `semanticPlan`，第 1322 行起），端到端数据流如下：

1. **文件清单 → 带正文文件**：`scanRepoFiles(cwd)` 只给 `{path, bytes}`，`semanticPlan` 统一读正文进 `textByFile: Map<rel, text>` 与 `filesWithText: [{path, content}]`（`index.js:1322-1332`）。提取与建边共用这份正文，不读两遍（第 1324–1325 行注释）。

2. **提取组件图**：`extractRepoGraph(filesWithText, { cwd })`（`index.js:1341`）→ `graph`（Map<id,node>）、`byFile`（Map<file, ids>）。若 `!ex.ready`（tree-sitter 未就绪）则直接返回 `fallback=true`，由调用方退回 `localPlan`（`index.js:1300-1303`）。零组件也退回（`index.js:1353-1356`）。

3. **建依赖边**：`resolveImportEdges(graph, byFile, textByFile)`（`index.js:1358`）→ `edges`，失败不影响后续聚类（包在 try/catch 里）。

4. **语义聚类**：把 `[...graph.values()]` 交给 `clusterComponents({ components, llmCall, signal })`（`index.js:1369`，来自 `lib/cluster.js`），产出模块树。无模型时 `llmCall=null` 走纯本地启发式。

5. **持久化**（不带 `sourceCode`）：`plan.graph` 只保留 `id/name/kind/relativePath/parameters/baseClasses/dependsOn/docstring` + `edges`（`index.js:1388-1397`）——源码不进 JOBS_FILE（否则单 job 多几百 KB~几 MB），判变更只用 `bodyHash/签名/依赖`（`index.js:1385-1387` 注释）。

6. **增量复用**：`stale` 增量更新时，`extractCurrentGraph(cwd)`（`index.js:3968` 调用处）重新跑 `extractRepoGraph` 得到当前图，与从快照 `loadSnapshot(wikiPath)` + `graphFromSnapshot(snap)` 得到的旧图一起交给 `planUpdate` 做组件级 diff（`index.js:3965-3969`）。这依赖 `symbolIncremental` 配置开关（`index.js:137`，默认开）。

关键数据契约：符号记录对象的所有字段（`id/name/kind/relativePath/sourceCode/docstring/parameters/baseClasses/dependsOn`）在 `walk`、`regexExtract` 两处产出时必须完全一致，因为下游 `graph-diff` / `cluster` / `incremental` 不区分来源（`test-symbols.mjs:309-316` 专门断言了正则记录的形状）。

## Connections

- [[graph-diff]]：`lib/graph-diff.js` 定义并消费符号 Node 记录契约（`{id,name,kind,relativePath,sourceCode,docstring,parameters,baseClasses,dependsOn}`，第 9–10 行），`diffGraphs` / `changedIds` 用 `id` 与 `dependsOn` 做组件级增量 diff；`incremental.js` 的 `SLIM_FIELDS`（第 26 行）正是这批字段的超集。
- [[cluster]]：`lib/cluster.js` 的 `clusterComponents` / `toPlanModules` 把 `extractRepoGraph` 产出的 `components` 做语义聚类，`formatComponents`（第 28 行）按 `relativePath / id / kind / name / parameters` 渲染提示词，`index.js` 的 `semanticPlan` 就是它的主要调用方。
- [[incremental]]：`lib/incremental.js` 的 `slimGraph` / `slimComponent` / `graphFromSnapshot` 把符号图瘦身成快照持久化，再用 `symbols` 的 `extractRepoGraph` 重建当前图做增量比对；`SNAPSHOT_REL`（`temp/symbol-graph.json`）就是这份图的落盘位置（`incremental.js:22`）。
- [[update-planner]]：`lib/update-planner.js` 的 `planUpdate` 接收新旧符号图做组件级变更规划（added/deleted/renamed/interface/edge），决定哪些文章要重写。
- [[index]]：`index.js` 是 `symbols` 模块的两处主要消费者——`semanticPlan`（第 1322 行，全量编译规划）与「stale 增量」路径（`extractCurrentGraph`，第 3968 行调用处）；通过 `extractRepoGraph` 与 `resolveImportEdges`（第 16 行 import）串起「提取 → 聚类 → 增量 diff」整条流水线。

## Known Issues

- **调用级依赖边未实现**：`resolveImportEdges` 只建「文件级 import 边」，不是调用级边（见 `lib/symbols.js:810-812` 注释）。上游把调用关系也建成边；这里明确「先做文件级 import 边（够用于模块聚类与 edge 变更判定），调用级边留待需要时扩充」。因此 `dependsOn` 反映的是文件间的 import 关系，而非函数/方法间的实际调用。

- **整段块注释里的伪定义会被 AST 漏、但正则已防范**：正则路径主动跳过块注释（`lib/symbols.js:386-393`），`test-symbols.mjs:308` 专门断言「注释里的 `function fake()` 不该被认成定义」。但 AST 路径依赖语法正确性——畸形/新语法写法可能零符号，所以该情形由 `extractFile` 的正则兜底层兜住（`lib/symbols.js:582-592`）。

- **C/C++ 函数名取法有前提**：`fnDeclarator: true` 语言（c/cpp，`lib/symbols.js:139,154`）依赖函数名与参数挂在 `function_declarator` 子节点上；`stripCallSuffix`（`lib/symbols.js:722-727`）只取 `(` 前的名字部分，对 `(*fn)(int a)` 这种函数指针赋值能剥出 `fn`，但极特殊的嵌套 declarator 可能取不到准确名字（取不到时回退到 `decl.namedChildren?.[0]?.text`）。

- **Go 接收者解析只看末词**：`receiverField` 处理（`lib/symbols.js:640-648`）只取 `(s *Server)` 的最后一个词再剥指针星号得 `Server`，不含包名/多级接收者类型。

- **正则路径精度明显低于 AST**：正则只扫顶层附近（最多 `REGEX_MAX_LINES=4000` 行，第 371 行），嵌套块内实现、跨行签名会漏；`sourceCode` 区间是「定义行到下个定义行」而非精确节点字节区间（`lib/symbols.js:420-426`）。它定位是「有损但不丢」，只在 AST 不可用时启用，且命中记进 `stats.regex`（`lib/symbols.js:294-296` 注释）。

- **`extractImportSpecs` 的 `_file` 参数未使用**：第 837 行签名保留 `_file` 但函数体内从未引用（仅 `text` 参与匹配），属历史遗留，调用方传文件路径不影响结果。

- **WASM 目录与 ABI 强绑定**：`getParser` 在语法与运行时 ABI 不匹配时静默降级（记 `initError`、该 lang 标 `null`，`lib/symbols.js:536-541`）。这意味着某语言「看似支持」实则静默退正则——排查时要看 `stats.regexLanguages` 才能发现降级发生了。

- **未支持语言的静默跳过**：`SUPPORTED_EXTS` 不含的扩展名（如 `.md`、`.vue`、`.swift`）在 `extractFile` 直接返回 `[]`（`lib/symbols.js:552-554`），不进 `graph`、计入 `skipped`。
