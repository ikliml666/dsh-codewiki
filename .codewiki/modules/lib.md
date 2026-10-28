---
title: lib
type: module
source_files:
  - lib/agentic-host.js
  - lib/agentic.js
  - lib/article-contract.js
  - lib/articles-agentic.js
  - lib/change-set.js
  - lib/cluster.js
  - lib/engine/apply-plan.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - lib/engine/quality-gate.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
tags: [wiki-generation, agentic, incremental, engine-bridge, quality-gate]
---

## Overview

`lib/` 是 CodeWiki 插件的**纯逻辑层**：宿主接线（`index.js`，不在本目录）负责与 DSH 宿主服务和面板交互，而本目录放的是全部可离线单测的算法与协议代码。共 25 个文件，按职责分四个功能簇：

1. **符号与增量**：`lib/symbols.js`（web-tree-sitter AST 符号提取 + 正则降级）、`lib/graph-diff.js`（逐位移植自 FSoft-AI4Code/CodeWiki `codewiki/src/be/updater/graph_diff.py` 的组件级 diff，见 lib/graph-diff.js:1-11）、`lib/incremental.js`（图快照存取 + 过期任务过滤）、`lib/update-planner.js`（write/keep/review 增量计划器 + module-map 状态）、`lib/change-set.js`（git 四路变更集）、`lib/update-record.js`（终态记账）。
2. **自研 agentic 写作通道**：`lib/agentic.js`（工具循环纯逻辑）、`lib/agentic-host.js`（宿主 llm 适配层）、`lib/articles-agentic.js`（并发执行器 + 子模块递归派发）、`lib/cluster.js`（LLM 驱动的模块聚类）、`lib/article-contract.js`（frontmatter/章节/死链契约闸门）。
3. **FSoft 原生 Python 引擎桥 `lib/engine/`**：跨进程契约、JSON-lines 子进程客户端、loopback 模型桥（不碰凭证）、产物映射与校验、采用质量门、原子落地器、跨轮受管状态、编排器 `native-run.js`，以及 Python 侧入口 `entry.py` 与阶段映射 `stage_map.py`。
4. **基础设施**：`lib/engine/process-tree.js`（受管子进程树终止）。

设计主线有两条。其一是**可测试性优先**：纯逻辑与 IO 分离，`streamFn`/`execFile`/`probe`/`fsImpl`/`pathImpl`/`runCw`/`commit` 全部依赖注入（lib/agentic.js:12-15、lib/change-set.js:15-16、lib/engine/apply-plan.js:24-34）。其二是**失败必须可见**：本目录的每个「闸门」都围绕同一类历史缺陷构建——「1 篇成功 + 19 篇失败也报 done」「未提交改动被基线前移悄悄洗掉」「子模块派发失败却留下死链」，因此终态合成统一取**最弱一环**（lib/engine/native-run.js:194-195），warning 级问题会让编译终态降为 partial 并阻止基线前移（lib/article-contract.js:49-55）。

## Key Components

### 符号提取：lib/symbols.js

AST 级符号提取，对应上游 `dependency_analyzer/analyzers/*`。组件 id 约定为 `<相对路径>#<符号名>`，方法为 `#<类名>.<方法名>`（lib/symbols.js:10-11）。输出节点形状：`{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（lib/symbols.js:13-14）。

常量：

- `DEFAULT_VENDOR_DIR`（25）：`<包根>/vendor/tree-sitter`。依赖装在 vendor 子树而非插件根 `node_modules`，避免污染宿主注入的包（lib/symbols.js:21-24）。
- `LANG_RULES`（36-271）：表驱动的 16 语言规则表，每个语言声明 `wasm` 名、`exts`、`container`（容器节点类型）、`containerName`、`containerBases`、`containerKind`、`fn`（函数节点类型）、`fnName`、`fnParams`、`fnKind`、`methodKind`、`imports`、可选 `doc`/`receiverField`/`fnDeclarator`/`arrow`。覆盖 javascript（37-52）、typescript（53-66）、python（67-81）、rust（82-96）、go（97-113，方法名拼 `<类型>.<方法>`）、java（114-127）、c（128-143，名称/参数挂在 `function_declarator`）、cpp（144-158）、csharp（159-172）、ruby（173-186）、php（187-200）、kotlin（201-214）、scala（215-228）、dart（229-242）、bash（243-256）、lua（257-271）。
- `SUPPORTED_EXTS`（273-276）：`Map<扩展名, 语言>`，由 `LANG_RULES` 展开。
- `WASM_FILE_OVERRIDE`（279）：`csharp → tree-sitter-c_sharp`（wasm 文件名与语言 id 不一致）。
- `REGEX_RULES`（302-368）：WASM 语法不可用时的正则降级规则，每语言给 `fn`/`cls`/可选 `iface`/`arrow`，捕获组 1 为名字。设计动机写在 288-296 行：早期实现直接 `return []`，导致整块语言静默消失。
- `REGEX_MAX_LINES = 4000`（371）：正则路径单文件扫描行数上限。
- `IMPORT_RE`（835）：跨语言 import 语句正则（ESM/Python from-import/`#include`/Rust `use`/`require`）。

函数：

- `regexExtract(relPath, content, lang)`（374-440）：逐行扫（跳过块注释、空行、行注释），类优先于函数匹配；每个符号的 `sourceCode` 取「定义行到下一个定义行」，末符号最多 60 行（421-426 行注释说明上限原因）。
- `parseParamList(text)`（443-466）：参数列表文本 → 参数名数组；按顶层逗号切分（跳过嵌套括号/尖括号），去掉默认值、类型标注、`...`/`*`/`$` 前缀。
- 类 `SymbolExtractor`（472-779），方法：
  - `constructor(opts)`（473-481）：`vendorDir`、`wasmDir`、`parsers Map<lang, parser|null>`、`ParserCtor`、`LanguageCtor`、`initError`、`stats { files, parsed, failed, languages, regex?, regexLanguages? }`。
  - `vendorImport(sub)`（484-495）：从 vendor 树按绝对路径导入（插件根 `node_modules` 解析不到这些包）。
  - `init()`（498-519）：惰性导入 `web-tree-sitter` 并 `Parser.init()`；失败记 `initError` 后永久返回 false（插件照常启动，只是无 AST 能力）。
  - `getParser(lang)`（521-542）：按语言加载 `.wasm` 并缓存 parser；ABI 不匹配时缓存 `null` 并静默降级（537-540）。
  - `resolveWasmDir()`（544-547）：`vendor/tree-sitter/node_modules/tree-sitter-wasms/out`。
  - `extractFile(relPath, content)`（551-594）：AST 解析 → 符号数组；parser 缺失、parse 抛错、或 AST 成功但零符号三种情况都退到 `regexExtract`，并记 `stats.regex`/`stats.regexLanguages` 让降级可见（556-563、569-571、583-592）。
  - `walk(node, rule, relPath, content, out, container)`（597-695）：递归收集；容器（类/结构体/impl/trait）连同其成员方法一起成为组件，成员方法 id 为 `<路径>#<类>.<方法>`（652-653）；顶层函数单独成组件；Go 方法带接收者类型（639-648）；箭头函数赋值 `const foo = (a) => {...}` 也算函数（669-690）。
  - `findArrow(decl)`（697-707）、`findDeclarator(node)`（710-719）、`stripCallSuffix(text)`（722-727）、`fieldText(node, field)`（729-737）、`parseParams(text)`（739-741）、`parseBases(text, node, rule)`（743-748）、`sliceSource(node, content)`（751-757，按字节区间切片，多字节安全）、`extractDoc(node, rule, content)`（759-774，Python 取函数体首字符串、Rust 取前置 `///`）、`componentId(relPath, name)`（776-778）。
- `extractRepoGraph(files, opts)`（785-805）：批量提取，返回 `{ graph: Map<id, node>, byFile: Map<file, id[]>, skipped[], extractor, ready, stats }`。
- `resolveImportEdges(graph, byFile, files)`（810-833）：把各文件 import 解析成仓库内相对路径，再落到组件层——from 文件所有组件的 `dependsOn` 追加 to 文件的组件 id（824-829）。上游还建调用级边，这里先只做文件级 import 边（lib/symbols.js:810-812）。
- `extractImportSpecs(_file, text)`（837-847）：抽取全部 import 说明符（含无扩展名 `require('./d')`），去重。
- `resolveSpec(fromFile, spec, known)`（849-884）：三类解析——相对路径（尝试 `.js/.mjs/.jsx/.ts/.tsx/.py/.rs/.go/.java` 与 `index.js/index.ts/__init__.py/mod.rs` 后缀）、Python 点号模块（`a.b.c → a/b/c.py`，含包路径后缀匹配）、Rust `crate::a::b` 与 C/C++ 头文件（按文件名尾段匹配）。

### 组件级 diff：lib/graph-diff.js

移植自上游 `graph_diff.py`（纯标准库算法，零 ML 依赖，lib/graph-diff.js:14-16）。变更分类常量（14-19）：`CLASS_ADDED`/`CLASS_DELETED`/`CLASS_IFACE`/`CLASS_BODY`/`CLASS_EDGE`/`CLASS_RENAMED`；`DIFF_TRUNCATED_MARKER`（21）。`WS`（23）与 `TOKEN`（26）——后者用 `\p{L}\p{N}` 还原 Python `\w` 的 Unicode 语义，否则中文按字切碎、相似度整体偏高（lib/graph-diff.js:26-27）。

纯函数：

- `normalizeBody(text)`（28-30）：trim + 空白归一。
- `stripTrailingComment(line)`（43-62，私有）：跟踪 `'` `"` ` `` ` 三种引号与反斜杠转义剥行尾注释；`#` 仅在行首或前字符为空白时才算注释（56-57），避免吃掉 C 预处理/JS 私有字段。
- `stripComments(text)`（69-100）：剥块注释与行首注释（`LINE_COMMENT_MARKS` 35 行：`// /// # -- ; %`；`BLOCK_COMMENT_PAIRS` 36 行），行内剥离只认 `//` 与 `#`（`TRAILING_COMMENT_MARKS` 39 行）——`--`/`;`/`%` 在表达式中太常见不做行内剥离（37-38）。
- `codeHash(node)`（108-111）：`stripComments` 后的 sha1——只改注释不变；快照回读节点无源码时直接用固化哈希（109）。
- `documentedSource(node)`（114-119）：源码 + docstring（docstring 是有意义的文档，改动应触发重写，见 103-107 行注释）。
- `bodyHash(node)`（121-126）：`normalizeBody(documentedSource)` 的 sha1；快照回读走缓存分支（122-125）。
- `signature(node)`（128-134）/ `signatureChanged(a, b)`（136-145）：name + parameters + baseClasses 逐位比较。
- difflib 逐位移植（lib/graph-diff.js:147-151 注明动机「不逐位对齐就无法对拍验证」）：`tokens`（147-149）、`buildB2J`（156-164）、`findLongestMatch`（166-189）、`getMatchingBlocks`（191-226，含与 Python difflib 完全一致的相邻块归并 208-226）、`sequenceRatio`（229-236）。
- `bodySimilarity(a, b)`（239-245）：token 序列的 difflib ratio，上游 `body_similarity` 同源。
- `approxTokens(text)`（247-249，`len/4+1`）、`truncateToTokens(text, maxTokens)`（251-257，头尾各半 + 截断标记）。
- unified diff 移植：`splitKeepEnds`（263-269，Python `splitlines(keepends=True)` 语义）、`getOpcodes`（271-287）、`getGroupedOpcodes`（289-317）、`rangeUnified`（319-325）、`unifiedDiff(aLines, bLines, fromFile, toFile, n=3, lineterm='\n')`（327-355，header 只在第一个 group 输出一次，334-339）。
- `unifiedBodyDiff(oldNode, newNode, label)`（358-362）：整文件相对路径作 label，上下文固定 2 行。
- `pairRenames(deleted, added, oldGraph, newGraph, tauRen)`（371-407）：按 body 相似度贪心最佳匹配；先做长度比预筛 `ratio < tauRen*0.9` 剪枝（388-391），候选按相似度降序、一一配对（396-406）。`DEFAULT_TAU_REN = 0.8`（368）、`DEFAULT_MAX_DIFF_TOKENS = 2000`（369）。

diff 结构 `emptyGraphDiff()`（413-423）：`added/deleted/interface/body/edge` 五个 `Set`、`renamed: Map<oldId, newId>`、`records: Map<id, record>`。辅助：`graphDiffCounts(d)`（425-434）、`changedIds(d)`（436-440）、`isDiffEmpty(d)`（442-444）。

主入口 `diffGraphs(oldGraph, newGraph, opts)`（447-564）：

1. 新增/删除集合（454-455）。
2. 同 id 组件比较：签名变 → `interface`；body 哈希变 → `body`；仅依赖边变 → `edge`（461-477）。
3. 改名配对（499-524）：从 deleted/added 中移出，记 `renamed`，签名也变的追加进 `interface`（523）。
4. 为 added/deleted 补 record，diff 为整段新增/删除（526-561）。

record 全字段（480-495）：`componentId`、`changeClass`、`oldId`、`newId`、`relativePath`、`componentType`、`oldSignature`、`newSignature`、`similarity`、`signatureChanged`、`edgesAdded[]`、`edgesRemoved[]`、`diff`。`serializeDiff(d)`（567-578）：Set/Map 转排序数组/对象，供落盘与对拍。

### 快照与过期过滤：lib/incremental.js

- `SNAPSHOT_VERSION = 1`（19）；`SNAPSHOT_REL = 'temp/symbol-graph.json'`（22，放 `.codewiki/temp/` 下随 wiki 入库，避免换机器后退化成全量重写，20-21 行注释）；`SLIM_FIELDS`（26）：`['id','name','kind','relativePath','parameters','baseClasses','dependsOn','bodyHash','codeHash']`——**不存 sourceCode**（`.codewiki/` 要进仓库，24-25 行注释）。
- `slimComponent(node)`（28-34）：按 `SLIM_FIELDS` 裁剪。
- `slimGraph(graph, {commit, now})`（37-48）：现场节点在此固化 `bodyHash`/`codeHash`（39-45），快照对象形状 `{ version, generatedAt, commit, components[] }`。
- `sameSnapshotContent(a, b)`（53-66）：忽略 `generatedAt`/`commit` 比较实质内容——代码没变时不覆盖快照，避免 autoCommit 为「只改了时间戳」产生空转提交（50-52 行注释）。
- `graphFromSnapshot(snap)`（69-88）：快照 → `Map<id, node>`（`sourceCode: ''`、`docstring: ''`，哈希走固化值）。
- `snapshotPath(wikiPath)`（90-92）、`loadSnapshot(wikiPath, fsImpl)`（94-104，版本不符当没有：「宁可重写也不误判」，98）、`saveSnapshot(wikiPath, snap, fsImpl, pathImpl)`（106-115）。
- `normRel(p)`（118-120）：`\`→`/`、去 `./` 前缀、trim。
- `componentsByFile(graph)`（123-132）：文件 → 组件 id 清单。
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)`（140-194）：核心纯函数。先 `diffGraphs`，再做**纯注释降级**（147-170）：`body` 类变更里 `codeHash` 相同且 docstring 未变的组件视为「描述不变」，不触发重写；`interface/added/deleted/renamed` 一律不放行（152-153 行注释）。判定逻辑：文章的 `source_files` 无可解析符号 → `symbolFallback: true` 保守保留（179-184，交给文件级判定）；命中真实变更 → keep 并附 `changedComponents`；只命中纯注释改动 → dropped 并附 `cosmeticOnlyComponents` 供面板解释（188-190）。返回 `{ keep, dropped, change, counts, cosmeticOnly }`。
- `describeChange(counts)`（197-206）：变更摘要文案（接口变/新增/删除/改名/实现变/依赖变）。

### 增量计划器：lib/update-planner.js

吸收自上游 `updater/ownership.py`、`routing.py`、`stale_scan.py`、`orchestrator.py`（1-2 行）。头部注释（4-14）记录了旧实现的三个缺陷：反向依赖看不见、新文件无归属、未重写页不做 stale scan。

- `UPDATE_PLAN_VERSION = 1`（23）；`MODULE_MAP_VERSION = 1`（26）；`MODULE_MAP_REL = 'temp/module-map.json'`（27）。
- `SOURCE_EXTS`（30）/ `isSourcePath(p)`（33-36）：只看扩展名；非源码文件无归属只记 warning，不触发全量重编（31-32 行注释——否则随手写的笔记会让增量永远退回 full）。
- `dirOf(p)`（38-41）、`commonDir(a, b)`（44-53）：最长公共目录，至少一级才算「同模块」。
- `realChangedIds(diff, oldGraph, newGraph, {ignoreCommentOnly})`（57-81）：与 `incremental.js` 同一套纯注释降级判据（复用 `codeHash`，55 行注释），返回 `{ changed, cosmetic, real, structural }`；`structural` = 非 cosmetic 且属于 interface/added/deleted/renamed/edge。
- `dependentsOf(graph, ids)`（85-101）：组件 → 依赖它的组件（反向边）；`dependsOn` 里组件 id 与文件路径两种形态都认（83-84 行注释）。
- `scanStaleArticle(article, {deletedComponents, renamedComponents, linkExists})`（106-145）：正文引用已删/改名符号（按符号名做带词边界的正则匹配，115、122）或死链检测（`[[name]]` 与 markdown 相对链接，128-137）。返回 `{ issues[], needsRewrite }`——引用已删/改名符号必须重写，死链只要求 review（139-144 行注释）。
- `planUpdate({changeSet, oldGraph, newGraph, articles, moduleMap, options})`（156-436）：主入口，返回 UpdatePlan。要点：
  - 文件级降级条件：`options.fileLevel === true` 或任一图为 null（179）；降级时仍处理删除/改名/新文件，不再只认 source_files 命中（177-178 行注释）。
  - 反向依赖闭包只对 `structural` 变更做（206-208 行注释：实现细节变了不连带重写引用方）。
  - 文章分支判定顺序（238-347）：缺 `source_files` → review + needsFull（252-257）；文件被删/改名 → write（269-289）；无符号可判 → 文件级判定 write/keep（290-304）；自身组件或被依赖组件变更 → write，附 `changedComponents`/`impactedBy`（305-317）；否则 stale scan → write/review/keep（319-345）。
  - 无归属变更（349-382）：先尝试按共享目录前缀保守路由给某篇文章（359-380），路由不了进 `unmappedChanges`。
  - **只有源码变更**无归属才 `needsFull = true`（391-393）；`requiredNames` 只取 write 动作（399-407 行注释解释了把 keep 算进必需清单导致「完整成功却落 partial」的踩坑）。
  - 图中无任何 `dependsOn` 边时记 warning「反向依赖影响不可用」（395-397）。
  - UpdatePlan 全字段（410-435）：`version`、`fileLevel`、`changedComponents[]`、`cosmeticComponents[]`、`structuralComponents[]`、`counts`、`actions[]`（每个 action：`name`、`articlePath`、`sources[]`、`changedComponents[]`、`impactedBy[]`、`reasons[]`/`reason`、`action`，可选 `staleIssues[]`/`newFiles[]`/`fileLevel`/`needsFull`）、`summary { write, keep, delete, review }`、`unmappedChanges[]`、`unmappedSourceChanges[]`、`routedTo[{file, name}]`、`missingSources[]`、`missingRequired[]`、`requiredNames[]`、`warnings[]`、`needsFull`、`fullReason`、`hasChanges`。
- `buildModuleMap({articles, graph, plan, now})`（442-468）：full 编译后从真实 plan 重建 `{ version, generatedAt, articles: { [name]: { sources[], components[], module } } }`；`module` 优先取 plan 模块名，其次 source_files 公共目录（457-464）。
- `migrateModuleMap({articles, now})`（472-481）：旧 wiki 无 module-map 时从 frontmatter 保守迁移（只记 sources，组件留空，条目带 `migrated: true`，顶层带 `migratedFromFrontmatter: true`）。
- `sameModuleMap(a, b)`（484-492）：忽略 `generatedAt` 的实质比较，避免空转提交。

### git 变更集：lib/change-set.js

头部注释（1-13）记录缺陷：旧 `cw status` 只跑 `git diff <base>..HEAD`，未提交/暂存/未跟踪三类改动完全隐形，导致「改完代码就编译」把未消化变化当已消化。

- `CHANGE_SET_VERSION = 1`（19）；`WIKI_PRODUCT_PREFIX = '.codewiki/'`（24）。
- `isWikiProduct(relPath)`（26-29）：wiki 自身产物目录不算源码变更（21-23 行注释）。
- `normChangePath(p)`（33-40）：统一 POSIX；绝对路径与 `../` 越界一律丢弃。
- `parseNameStatus(out)`（52-71）：解析 `git diff --name-status`，R/C 两列路径记 `renamed`/`copied`（带 `from`），D 记 `deleted`，其余记 `modified`。
- `emptyChangeSet(baseCommit, overrides)`（73-93，私有）：ChangeSet 骨架。
- `collectChangeSet(cwd, baseCommit, opts)`（102-205）：主入口。流程：无基线 → `missing-base`（104-106）；HEAD 读取失败区分「非 git 目录」（`no-git`）与「命令出错」（`git-error`）（110-125）；基线被 rebase/GC 掉 → `unreachable-base`（127-137）；四路采集 `-M` 打开改名检测（139-160）：committed（`base..HEAD`）、staged（`--cached HEAD`）、unstaged、untracked（`ls-files --others --exclude-standard`）。分类去重（162-181）：`all` 含改名两端；「同一路径既删又重建」从删除集剔除（180-181）。**ok=false 时一定带 state 与 reason 且 fallback='full'**——「采不到」绝不当成「没变化」（100-101 行注释）。
- ChangeSet 全字段（74-93、187-204）：`version`、`ok`、`state`、`fallback`、`reason`、`baseCommit`、`headCommit`、`committed[]`、`staged[]`、`unstaged[]`、`untracked[]`、`deleted[]`、`renamed[]`、`all[]`、`sourceChanges[]`（剔除 wiki 产物）、`ignored[]`（wiki 产物）。条目形状：`{ kind, from?, path, status, bucket }`。

### 模块聚类：lib/cluster.js

对应上游 `cluster_modules.py` + `prompt_template.py` 三段式（1-8 行）。差异：纯函数 + 显式阈值决定下钻（减少请求数），组件 id 用 `path#name`（10-15 行）。

- `formatComponents(components)`（28-46）：按文件分组的提示词表示，只给「名字 + 类型 + 一行签名」。
- `ARTIFACT_RE`（48）/ `artifactTag(file)`（49-51）：配置类文件打 `(artifact: config)` 标。
- `clusterPrompt(componentText, totalComponents)`（57-81）：顶层聚类提示词，要求每个组件必须且只能出现一次、模块名用英文小写下划线、path 填主要目录。
- `subClusterPrompt(moduleName, componentText, totalComponents)`（84-103）：下钻提示词，不可再分时返回单个子模块保持原名。
- `superGroupPrompt(modules)`（106-129）：超级分组提示词（上游 `SUPER_GROUP_PROMPT`），要求子系统数显著少于模块数。
- `parseJsonLoose(text)`（135-153）：剥围栏 → 直接 parse → 首尾大括号截取 → 去尾逗号重试。
- `parseClusterResponse(text, validIds, warnings)`（156-195）：id 校验（未知 id 记 warning 丢弃）、去重（重复分配记 warning）、返回 `{ modules, missing }`。
- `normalizeModuleName(name)`（198-206）：统一成文件名友好形式（空格→下划线、剔非法字符、小写，空则 `module`）。
- `guessPath(ids)`（208-212，私有）。
- `heuristicCluster(components)`（219-244）：无 LLM 时的降级路径，按顶层目录分组；单顶层目录（`src/` 布局）下探一层（232-237）。「它不是最优，但永不断链」（216 行注释）。
- `fillMissing(modules, components, missingIds)`（247-268）：LLM 漏掉的组件按目录补回最相近模块，实在没有就建 `misc`。
- `moduleFiles(componentIds, byId)`（274-281）：模块 → 源文件清单（frontmatter `source_files` 用）。
- 常量（287-289）：`DEFAULT_MAX_DEPTH = 2`、`DEFAULT_SPLIT_THRESHOLD = 60`、`DEFAULT_TOP_FANOUT = 14`。
- `clusterComponents(opts)`（291-389）：主入口。第一层全仓库聚类（309-324，无 llmCall 或解析失败降级 `heuristicCluster` 并记 `stats.fallbacks`）；第二层对组件数 ≥ splitThreshold 的模块递归下钻（327-344，父模块保留为目录节点）；第三层顶层模块数 > topFanout 时超级分组（346-356）。`finalize`（359-375）补齐 `files`/`parent`/`children`/`aggregateFiles`；成文清单只收叶子模块（378-386）。返回 `{ modules, tree, concepts: [], warnings, stats { requests, llm, levels, fallbacks }, byId }`（388）。
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)`（396-422，私有）：对单个大模块下钻；递归条件「还有余量 + 该子模块 ≥ splitThreshold」，且 `kids.length > 1` 已保证组件数严格递减不会无限递归（406-407 行注释）。早期实现只循环一次、`maxDepth` 退化成布尔开关的缺陷记录在 393-395 行。
- `parseSuperGroups(text, modules, warnings)`（425-456）：没被任何子系统收走的模块留在顶层，不能凭空消失（453-455）。
- `toPlanModules(result)`（460-467）：转成插件 articles 阶段的任务清单形状 `{ name, summary, files, parent? }`。

### agentic 工具循环：lib/agentic.js

对应上游 `read_code_components.py`、`str_replace_editor.py`、`generate_sub_module_documentations.py` 与 `documentation_generator.py` 的工具循环（1-5 行）。价值主张：给模型一个可反复读代码、可精确编辑文章、可拆分大模块的工作台，行号/签名现场核对而不是靠一次性读上下文猜（7-9 行）。纯逻辑 + 注入 `streamFn`/工具实现，不绑 pydantic-ai 也不绑宿主 llm（12-13 行）。

- `TOOL_SCHEMAS`（27-87）：四个工具的 JSON Schema。
  - `read_code`（28-42）：参数 `path`（必填）、`start_line`、`end_line`；描述强调「行号以返回的『行号| 』前缀为准，禁止自行推算」。
  - `list_files`（43-53）：参数 `path`、`depth`。
  - `edit_article`（54-71）：参数 `command`（`view`/`str_replace`/`insert`）、`old_str`、`new_str`、`line`、`text`。
  - `generate_sub_module`（72-86）：参数 `module_name`（必填）、`components[]`、`description`（必填）。
- 常量：`MAX_READ_LINES = 2000`（93）、`MAX_READ_CHARS = 40000`（96，实测单行 20 万字符的压缩产物一次回吐 5.7 万 token，行数上限挡不住，94-95 行注释）、`IGNORED_DIRS`（98，`node_modules/.git/dist/build/.next/target/vendor/__pycache__/.venv/venv`）。
- `numberLines(text)`（101-106）：加 `行号| ` 前缀，与插件其余环节一致。
- `makeReadCodeTool(workspace, { seen, getStep })`（115-177）：read_code 实现。**重复读抑制**（108-114 行注释记录实跑数据：模型 45 步里把 index.js 读了 13 次，16 次读码只有 4 个不同文件，累计 2.1MB 上下文，步数全耗在读码上）：同一 `(path, 起始行, 结束行)` 再读只回「你已在第 N 步读过这段」（129-135）；去重发生在读盘之前（123 行注释）；原始 key 与「夹取后等价 key」都记（150-152，不带 `end_line` 与显式写满全文视为同一段）。超限截断并附提示（156-170）。
- `makeListFilesTool(workspace)`（179-197）：列目录，过滤 `IGNORED_DIRS` 并注明隐藏数量（194）。
- `makeArticleEditor(initial)`（200-263）：edit_article 实现，状态在闭包里。`view` 返回带行号全文（204-207）；`str_replace` 做**行尾归一化**（212-215 行注释：`core.autocrlf=true` 真实仓库 28/36 篇是 CRLF，模型按 `\n` 写 old_str 永远匹配不上，只能反复换锚点直到步数耗尽）——匹配前两侧行尾统一 `\n`，命中后按原文风格写回避免悄悄改整个文件（216-228）；`old_str` 不唯一时报错（223-226）。`insert` 对负数行号显式报错而非静默吞成「插到最前」（233-237）；空文章 split 出 `['']` 当零行处理（244-245）。
- `safeRelPath(rel)`（266-273）：路径越界防护（反斜杠归一、拒绝绝对路径/盘符/`..` 上跳）。
- `buildToolset({ workspace, editor, onSubModule, getStep, subModuleBlocked })`（279-315）：工具调度表。`generate_sub_module` 在不可用时**必须说实话**（290-305 行注释：此前笼统回「已派发」，模型据此在父文写「详见 xxx.md」而那个文件从未生成——死链且父任务仍记 ok:true）；区分 `max-depth` 与不支持递归两种原因分别给出可行动指示。
- `DEFAULT_MAX_STEPS = 30`（325）：步数上限唯一定义点（321-324 行注释记录了两处各写一个常量 24/30 导致同配置两种行为的教训）。
- `runAgenticArticle(opts)`（331-432）：循环本体，契约见 17-19 行注释。流程：构造 editor 与工具集（348-351）；只把实际可用的工具声明给模型（354）；逐步调 `streamFn` 拿 blocks（371-379）；模型消息原样进历史（382-383，否则下一轮对不上 callId）；无 tool-call = 写完，若正文有文章而 editor 还空则收下（389-394）；执行工具调用、结果作为 tool-result 消息回灌（397-421）。返回 `{ article, steps, usedTools, stopReason, messages }`（425-431）。
- `stripJsonFence(s)`（439-444）/ `sliceBalancedObject(s)`（447-473，跳过字符串字面量里的括号）/ `parseToolArgs(raw, steps, step, toolName)`（476-500）：坏 JSON 三级抢救（原样 → 剥围栏 → 截首个平衡 `{...}`），都不成才记警告；435-438 行注释说明不剥围栏的真实后果——参数退化成 `{}`，模型反复重试同一错误。
- `buildOpeningPrompt({ mission, systemPrompt, articleFormat, schemas })`（506-541）：开场提示词，含六步工作方式（519-524）、可选拆分规则（525-533）、硬要求「不许编造文件/函数/行号」「不要用 markdown 围栏包整篇文章」（535-538）。

### 宿主适配：lib/agentic-host.js

agentic 工具循环 ↔ 宿主 llm 服务的适配层（1-9 行注释说明两套形态差异：宿主要带 id + source 的正式 Message，且一条 tool 消息只装一个结果，而循环里「一轮多个调用」是一条消息装多条结果——本层负责展开）。

- `SOURCE`（15）：`{ kind: 'plugin:codewiki' }`。
- `IDENTITY`（26）：`WeakMap` 身份缓存。理由在 18-25 行注释：宿主对 MessageId 要求「跨表示边界保持稳定身份」，每轮重造消息会让同一条消息每步换新 UUID；WeakMap 以裸消息为键，循环结束自动释放。
- `stableKeyFor(role, r, index)`（29-31）：tool 角色一拆多时键带结果序号。
- `toRequestMessages(messages, { provider, model })`（34-79）：裸消息 → 宿主 `RequestMessage[]`。user/assistant 走缓存（40-57）；已构造过的正式消息（有 id）直接透传（47-48）；tool 消息逐结果展开为多条（59-75），内容非数组时兜底成单 text block（69）。
- `makeHostStream({ llm, provider, model, reasoningEffort, onDelta, onFinish })`（83-108）：建 streamFn 交给 `runAgenticArticle`。用 `BlockAssembler` 收 chunk 成 blocks（86-99）；`finish.kind` 为 `error`/`aborted` 时抛出带机读信息的错误（101-103）；tools 映射成宿主形态、`temperature: 0`、透传 `signal`（88-96）；`onDelta`/`onFinish` 回调异常不影响写作（98、105）。
- `makeFsWorkspace(fs, path, cwd)`（111-135）：仓库 workspace 抽象（agentic 工具只认 `readFile`/`listDir`）。`absOf`（114-118）要求相对路径落在 cwd 内——符号链接逃逸由 `safeRelPath` 兜一层，这里再兜真实路径一层（113 行注释）；返回路径用 POSIX 斜杠拼接（129-132）。

### agentic 执行器：lib/articles-agentic.js

与 `index.js` 的 `runRealtimeTasks`（单轮 prompt → 全文）并列的第二条执行通道（1-7 行）：模型自己读源码、增量写文章，不需要「装填超预算 → 拆观察批 → 合成」整套。

- 21 行：再导出 `DEFAULT_MAX_STEPS`（保持既有导入路径可用，避免又出现独立常量，19-20 行注释）。
- `runOneArticle(task, {...})`（33-179）：单篇跑一次 agentic 循环并落盘。要点：
  - 已有旧文（`task.prevArticlePath`）作为初始内容交给 editor 增量改，而非从零重写（59-63）。
  - 写集闸门（48-51 行注释）：`allowedWritePaths` 编译成集合；未给（undefined）保持旧行为，传 `null`/`[]` 视为「谁都不许写」（66-67）。越界写入返回 `stopReason: 'write-set'` 与 `writeSetViolation`（152-167），不静默写也不静默丢。
  - 子模块派发（26-32 行注释，对应上游 `generate_sub_module_documentations.py`）：就地递归 `runOneArticle`，子文章路径 `modules/<父 slug>/<子 slug>.md`（95-96）；子模块名全局唯一（71-73 行注释，上游 issue #76/#113 的教训：重名互相覆盖），重名加父模块名前缀、仍重则跳过；递归深度封顶 `subDepth`（82-84）；到顶时 `onSubModule` 传 null 并用 `subModuleBlocked='max-depth'` 让工具层说实话（79-81）；**递归时 `onSubModule` 传 null 而不是 `dispatchSub`**——原样下传会让子层永远用父层的深度判定，封顶形同虚设（113-117 行注释）；子层写集只有它自己那条路径（110-112）。
  - 空文章算失败（146-149），不能把空文件写下去覆盖旧文。
  - `fixAnchors` 钩子失败不影响落盘（169-174）。
  - 返回 `{ ok, stopReason, article, steps, usedTools, subModules, ... }`。
- `sourceTokensOf(task, cwd, { fsImpl, pathImpl })`（185-203）：模块源文本量近似 token 数（CJK 按 1、其余按 3.5 字符/token，与 `index.js estimateTokens` 同口径，181-183 行注释）；读不到的文件按 0 计不阻断。
- `resolveTaskRoute(task, { provider, model, reasoningEffort })`（208-222）：单任务选档；任务自带 provider+model（大档）时完全以任务为准，effort 也以任务为准——不回落默认档，因为默认档的 effort（如 off）可能不被大档模型支持（205-207 行注释）。
- `runAgenticArticles(tasks, { concurrency, bigConcurrency, notes, signal, onTaskDone, onRequestStart, ...rest })`（231-312）：并发池，返回 `Map(customId → 结果)`。双池（227-230 行注释）：`bigTier` 标记任务走大档池，其余走默认档，两池独立限流同时推进（244-255）；`outputTokens` 按步数粗估（277-278 行注释：chunk 里 usage 会出现多次）；失败只记账不影响其它任务（292-303）。
- `markBigAgenticTasks(tasks, { bigTier, sizeOf })`（320-333）：按体量打大档标记。agentic 通道不装填源码，所以单轮通道的「装填超预算」判据不适用，等价物是「模块源文本量超过 budget」（314-318 行注释）；未配置 bigTier 时原样返回（322-324）。

### 文章契约：lib/article-contract.js

一篇 wiki 文章要满足的最低结构，统一在这里判（1 行）。头部注释（2-12）列出旧闸门放进过库的东西：正文里又贴一份 frontmatter、必需章节空着、source_files 列不存在的文件或目录、`[[链接]]` 指向已删文章、代码围栏未闭合。

- `ARTICLE_CONTRACT_VERSION = 1`（16）。
- `TYPE_BY_DIR`（19-26）：目录 → 允许的 type（modules/concepts/learnings/decisions/patterns/queries）；`ROOT_TYPES`（28-32）：`_architecture.md`/`_index.md`/`_patterns.md`。
- `REQUIRED_SECTIONS`（36-45）：module/architecture 必须有 `Overview` + `Key Components`，其余类型至少 `Overview`，index 无要求。
- `REQUIRED_FIELDS`（46）：`['title', 'type', 'source_files']`。
- `SEVERITY`（56-73）：问题分级是**闸门行为**的分界（48-49 行注释）。`error`（结构已破坏，拒写）：`empty`、`frontmatter-missing`、`frontmatter-unclosed`、`missing-field`、`type-mismatch`、`bad-source`、`missing-source`、`source-not-evidence`、`empty-body`、`duplicate-frontmatter`、`duplicate-section`、`unclosed-fence`、`dead-link`、`empty-section`；`warning`（内容不达标但结构完整，放行但终态降 partial）：`missing-section`、`empty-section-optional`。`missing-section` 与 `empty-section` 必须分开——「压根没写」与「写了标题却空着」是两种缺陷（54-55 行注释）。
- `parseFrontmatter(content)`（77-90）：只认文首第一个 `---` 块，返回 `{ fields, body, endLine, closed, raw }`，剥 BOM（79）。
- `parseYamlLite(raw)`（94-118）：极简 YAML，只支持 `key: value` 与 `key:` 后跟 `- item` 列表、行内 `[a, b]`（111-114）；不引依赖（92-93 行注释）。
- `unquote(s)`（120-135，私有）：双引号标量优先 `JSON.parse`（YAML 1.2 是 JSON 超集，带转义序列的值只有这样才是权威解，122-126 行注释）；失败回退切引号；单引号标量的 `''` 是转义单引号（130-133）。
- `extractSections(body)`（138-158）：正文 `## 标题` 章节，跟踪代码围栏状态（145），返回 `[{ title, content, line }]`。
- `fencesBalanced(body)`（161-164）：```/~~~ 围栏计数奇偶。
- `collectWikiLinks(body)`（167-176）：`[[目标]]`（可带 `|标题`/`#锚点`）与 markdown 相对 `.md` 链接（排除 `http:` 等 URI scheme，173）。
- `hasDuplicateFrontmatter(body)`（179-193）：正文 40 行窗口内再次出现 `---` 对且中间有 `title:/type:/source_files:` 即判重复贴头。
- `isRepoRelativeFile(p)`（195-203，私有）：目录形态（无扩展名）不是合法 source_files 条目（201-202）。
- `inspectArticle(content, opts)`（213-335）：主入口，返回 issues[]（空 = 通过）。opts：`cwd`、`articlePath`（type 与目录匹配）、`expectedType`、`readableSources`（source_files 必须是其子集）、`allowedLinks`（死链检查）、`fsImpl`（存在性）、`requiredSections`（215-224 行注释：原生通道章节名由上游 prompt 决定，用默认表判它等于给被禁止手改的正文判死刑、闸门退化成噪声）、`allowEmptySourceFiles`（226-232 行注释：whole-repository 通道空 source_files 是诚实记录而非编造）。检查项：必填字段（249-257）、`tags` 必须存在但允许空列表（258-262）、type 与目录匹配（264-273）、source_files 格式/证据/存在性（275-292）、空正文/重复 frontmatter/围栏（294-299）、章节重复/缺失/空（301-320）、死链（322-332）。
- `issueSummary(issues)`（338-343）、`hasBlockingIssue(issues)`（346-348，只有 error 级拦落盘）。
- `makeWriteSet(paths)`（352-355）/ `normalizeWritePath(p)`（357-361）/ `isWritable(target, writeSet, { cwd })`（365-378）：agentic 工具的 allowedWritePaths 闸门；相对路径以 cwd 解析后比对，避免 `../` 越界写到别的仓库（363-364 行注释）。

### 更新记录：lib/update-record.js

- `UPDATE_RECORD_VERSION = 1`（17）；`UPDATE_RECORD_REL = 'temp/update-record.json'`（18）。
- `TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled'])`（24）；`isTerminalStage(stage)`（26-28）。
- `judgeOutcome({ plan, results, options })`（37-128）：终态判定。缺页与失败分开记（57-75，处置不同）；无 plan 通道用 `options.expectedNames` 判缺页（71-75）；**只算源码变更**的 unmapped（80-91 行注释：README 等文档无文章引用是常态，混进来会让正常增量永远 partial）；质量闸门（100-102）、索引（105）、调用方硬阻塞（107-110）。终态：blockers/失败/缺页全空才 `done`；写成了一部分就是 `partial`，0 篇成功且有失败/缺页/阻塞才是 `failed`（113-118）。`canAdvanceBaseline = outcome === 'done' && blockers.length === 0`（124）。
- `buildUpdateRecord({...})`（131-211）：组装可序列化记录，job 里只存路径与摘要不塞整图（130 行注释）。全字段：`version`、`jobId`、`scope`、`startedAt`、`finishedAt`、`baseCommit`、`headCommit`、`changeSet { state, ok, fallback, reason, counts { committed, staged, unstaged, untracked, deleted, renamed, ignored }, sourceChanges[], ignored[] }`、`plan { version, fileLevel, needsFull, fullReason, summary, counts, changedComponents[], cosmeticComponents[], structuralComponents[], actions[{ name, action, reason, sources, changedComponents, impactedBy, newFiles, staleIssues }], unmappedChanges[], routedTo[], missingSources[], warnings[] }`、`results[{ name, ok, stopReason, error }]`、`qualityIssues[{ name, issue }]`、`outcome`、`blockers[]`、`canAdvanceBaseline`、`writtenCount`、`failedCount`、`notes[]`（截尾 20 条，208）、`wikiPath`。
- `recordPath(wikiPath)`（213-215）、`saveUpdateRecord(wikiPath, record, fsImpl)`（217-227）、`loadUpdateRecord(wikiPath, fsImpl)`（229-238，版本不符返回 null）。
- `describeOutcome(outcome, blockers)`（241-253）：done/partial/failed/cancelled 四态一眼能分的面板文案。

### 引擎契约：lib/engine/contract.js

FSoft 原生引擎的跨进程契约（阶段 0，1-18 行）。语义硬不变量（12-17 行）：`done` 不许带 blockers；`partial` 必须带 blockers；`failed` 必须带 error；`cancelled` 可带 blockers。

- `ENGINE_CONTRACT_VERSION = 1`（20）。
- `ENGINE_STAGES`（24-33）：`env → graph → cluster → articles → validate → index → baseline → commit`，顺序即推进顺序；这是**契约**不是实现细节（22-23 行注释）。
- `TERMINAL_OUTCOMES`（35）：`['done', 'partial', 'failed', 'cancelled']`。
- `UPDATE_OUTCOMES`（45-50）：`incremental`（真做了组件级更新）/ `no_change`（图 diff 为空）/ `full_fallback`（想增量但回退整份重建）/ `detector_failure`（连旧状态都读不到）。`CONSUMING_UPDATE_OUTCOMES = ['incremental', 'no_change']`（53）：只有这两种算「增量真的成立」。
- `BLOCKER_KINDS`（57-72）：`article-failed`、`article-missing`、`unmapped-change`、`unmapped-page`、`quality-gate`、`index-failed`、`baseline-failed`、`commit-failed`、`engine-error`、`cancelled`、`incremental-fallback`（新增只允许追加，56 行注释）。
- `ENGINE_ERROR_CODES`（76-86）：`engine-missing`/`engine-deps`/`engine-timeout`/`engine-cancelled`/`engine-crashed`/`engine-protocol`/`engine-model`/`engine-output`/`engine-unknown`；`RETRYABLE_CODES = {'engine-timeout', 'engine-model', 'engine-unknown'}`（90）。
- `normalizeUsage`（97-105）、`normalizeBlocker`（107-113，未登记 kind 归 `engine-error`，私有）。
- `engineResult(input)`（116-180）：构造 EngineResult，非法输入**抛错**而不是静默归一（115 行注释）。硬校验：done 带 blockers 抛错（122-124）、partial 无 blockers 抛错（125-127）、failed 无 error 抛错（128-131）、updateOutcome 未登记抛错（134-142，「忽略它等于把『引擎其实退了全量』洗成增量成功」，132-133 行注释）。EngineResult 全字段（143-179）：`contractVersion`、`outcome`、`stage`、`blockers[]`、`error`、`writtenCount`、`failedCount`、`keptCount`、`removedCount`、`unmappedCount`、`updateOutcome`、`usage { inputTokens, outputTokens, cachedTokens, requests }`、`engine { version, commit, python, deps { ok, summary } }`、`artifacts { docsDir, rawTreeDir, updateRecord }`、`startedAt`、`finishedAt`。
- `engineProgress(input)`（183-201）：推进快照，字段只增不减（182 行注释）；`percent` 夹到 [0,100]（188-189）。字段：`contractVersion`、`stage`、`percent`、`message`、`writtenCount`、`failedCount`、`totalCount`、`usage`、`at`。
- `engineError(input)`（204-215）：可机读失败事实；未登记 code 归 `engine-unknown` 并把原文留 `rawCode`（212-213）。字段：`code`、`message`（截 4000）、`stage`、`retryable`、`rawCode`。
- `validateEngineResult(value)`（219-260）：校验「可能来自外部/旧版本/磁盘」的对象，不抛错返回逐条 errors（217-218 行注释）。
- `describeEngineResult(result)`（263-280）：与 `lib/update-record.js` 的 `describeOutcome` 同口径的终态文案（262 行注释）。

### 协议客户端：lib/engine/client.js

Node ↔ Python 的薄适配层（阶段 2，1-20 行）。协议不变量（13-20 行）：stdout 只能是 JSON-lines（非 JSON 行记 `not-json` 但不丢弃已收结果）；消息必须带匹配 `requestId`；没有 `result` 消息 = 协议破坏即使退出码 0；退出码只表达进程层结果（语义以 result 为准，done + 非零退出记 `nonzero-exit`）；取消后到达的 result 记 `late-result` 丢弃；重复 result 先到赢。

- `ENGINE_PROTOCOL_VERSION = 1`（27，独立于结果契约版本：前者管「行怎么长」，后者管「结果字段」，26 行注释）。
- `DEFAULT_MAX_LINE_BYTES = 4MB`（29）、`DEFAULT_STDERR_TAIL = 4000`（30）。
- `createProtocolReader(options)`（39-186）：增量式 JSON-lines 读取器，纯逻辑可逐字节喂。方法：
  - `push(chunk)`（133-156）：按字节缓冲（多字节 UTF-8 跨 chunk 不切坏）；单行超限记 `line-too-long` 跳过（143-145）；无换行残留超限丢缓冲（151-154）；返回本次新解析的 progress 快照供实时回调。
  - `progress` getter（158-161）：已解析进度快照。
  - `markCancelled()`（163-166）：此后到达的 result 一律 `late-result`。
  - `end()`（168-184）：残留半行当 `not-json`（截断的 JSON 不能当结果，168 行注释）；返回 `{ result, progress, errors, violations, cancelled, endedWithResult, ended }`。
  - 行处理（56-126）：`hello` 校验协议版本（74-80）；requestId 缺失/不匹配记 `unknown-request`（82-86）；`progress`/`error`/`result` 分别入列，shape 坏记 `bad-shape`/`bad-result`；未登记类型记 `bad-shape`（124-125）。
- `spawnPlan(engine, cwd, env)`（189-199，私有）：engine 描述 → spawn 参数。
- `runEngine(options)`（223-422）：跑一次引擎动作并归一成 EngineResult。action 限 `doctor/generate/update/cancel`（226-229）。写一行请求 JSON 后关 stdin（323-329，引擎读到 EOF 就开始干活）；POSIX 上 `detached` 独立进程组（293-294，取消时整组打掉）；`Promise.race([exited, timeout, abort, spawnError])`（359）；超时/取消走 `terminateProcessTree`（368-391，取消时 `writtenCount` 只取已确认进度，380 行注释）；进程退出后等 stdout end 确保剩余行读完（393-399）；无 result 时按崩溃/协议破坏分码，**stderr 尾部必须进 message**（404-414，「崩溃的现场只有引擎自己吐得出来」，407-408 行注释）；语义 done + 退出码非 0 记 `nonzero-exit` 违规（416-419）。

### 进程树终止：lib/engine/process-tree.js

- `IS_WINDOWS`（18）。
- `isAlive(pid)`（41-49）：`process.kill(pid, 0)` 存在性探测；ESRCH 已退出，EPERM 存在但无权限仍算活着（33-39 行注释）。
- `terminateProcessTree(pid, options)`（61-103）：整树终止。Windows 用 `taskkill /T /F /PID`（72-79，/T 递归整树、/F 强制）；POSIX 先对进程组 `SIGTERM`（负 pid，83-89），宽限 `graceMs`（默认 3000）未退再 `SIGKILL`（94-99）。返回 `{ ok, rootAlive, method }`——`ok=false` 表示根进程超时后仍活着，调用方应报错而不是假装取消成功（57-59 行注释）。
- `waitForDeath(pid, timeoutMs)`（105-113，私有）：25ms 步进轮询。

### 环境清单：lib/engine/manifest.js

引擎清单（阶段 2，1-13 行）：回答「现在跑的是哪个引擎、哪个环境」，只做指纹/比对/落盘三件事，不装依赖不修环境（doctor 是只读诊断）。

- `MANIFEST_VERSION = 1`（19）；`ENGINE_LOCK_REL = '.codewiki/engine-lock.json'`（20）。
- `probeEnvironment({ probe, engineRoot })`（34-45）：调用方传 `probe` 而不是在这里 spawn（26-29 行注释，进程管理留在 client.js）；返回 facts + `fingerprint`。
- `fingerprintOf(facts)`（50-56）：sha256 前 16 位，只吃**决定产物内容**的因素（引擎版本 + Python 版本）；pip check 的 ok 不参与指纹——依赖闭合是「能不能跑」的闸门，不是「产物会是什么」的输入（47-49 行注释）。
- `readLock({ repoRoot })`（61-75）：不存在/坏了返回 null（首次运行本来没有 lock）。
- `compareLock({ current, lock })`（86-111）：返回 `{ status: 'absent'|'match'|'drift'|'unhealthy', diffs[], current, locked }`；diffs 逐字段机读（version/pythonVersion/fingerprint）。
- `writeLock({ repoRoot, current })`（117-135）：原子写（临时文件 + rename，114 行注释）。lock 体全字段（122-130）：`manifestVersion`、`fingerprint`、`version`、`pythonVersion`、`engineRoot`、`pipCheckOk`、`recordedAt`。
- `doctor({ probe, repoRoot, engineRoot })`（141-170）：一次调用判全「引擎在不在、环境闭不闭合、和上次比有没有漂」；**不抛**（probe 抛错变 `status: 'probe-failed'`）；返回 `{ ok, status, current, diffs, advice }`。

### OpenAI 转换层：lib/engine/openai-bridge.js

纯转换（无 I/O、无网络、无密钥，8 行）。职责边界与方向映射详见 1-27 行注释：assistant `tool_calls` 的 arguments 保持原始 JSON 字符串（DSH 的 ToolCallBlock 就是这么定义，提前 parse 会破坏增量拼接，12-13 行）；usage 字段 `inputTokens` 是不含缓存的净输入，OpenAI `prompt_tokens` 含缓存（21-23 行）。

- `PLACEHOLDER_KEY_PATTERN = /^dsh-bridge-[a-z0-9-]+$/`（29）；`isPlaceholderKey(value)`（31-33）。
- `contentToBlocks(content)`（38-51，私有）：string/parts 数组统一摊平成 ContentBlock[]；`image_url` 等显式跳过不造块（46）。
- `toolsToSchemas(tools)`（53-66，私有）：`tools[].function` → ToolSchema。
- `messageToDsh(msg, route)`（76-122，私有）：一条 OpenAI 消息 → 一或多条 DSH RequestMessage。system/developer 抽出（79-83）；assistant 的 tool_calls 转 tool-call 块（88-100）；**source 不是可选的**——宿主 `LlmRuntime.forAdapter()` 无条件读 `message.source.replayState`，缺 source 会抛错整轮判 error（71-75 行注释），桥不伪造 replayState 只填 provider/model（102-105）；tool 消息按 `tool_call_id` 转 ToolResultMessage（112-120）。
- `toLlmRequest({ provider, model, reasoningEffort, body })`（128-161）：请求体 → GenerateOptions 子集；system 消息合并进 system 槽（134-145）；透传 `temperature`/`max_tokens`/`stop`（157-159）。返回值永远没有 apiKey 字段（27 行注释）。
- `finishReasonToOpenAI(reason)`（164-173）：`tool-calls→tool_calls`、`max-tokens→length`、`error/aborted→error`、其余 `stop`。
- `usageToOpenAI(usage)`（176-188，私有）：`prompt_tokens = inputTokens + cacheRead + cacheWrite`，缓存单列 `prompt_tokens_details.cached_tokens`。
- `foldChunks(chunks)`（192-233，私有）：chunk 流折叠成「文本 + 按 index 拼接的 tool 调用 + usage + finish」中间态；只保留有 name 的调用（222-223 行注释：无 name 引擎无法执行）；非流式与流式共用，避免两条路径行为分叉（23-24 行）。
- `chunksToCompletion({ id, model, chunks })`（236-256）：非流式响应体；纯工具调用时 `content` 为 null 不是空串（248-249）。
- `sseFrame(payload)`（259-262）、`chunksToSse({ id, model, created, chunks })`（265-317）：流式 SSE 帧数组；`usage` 帧 choices 为空数组（297-301）；finish 帧的 `tool_calls` 修正（303-306）；流没给 finish 也要补终帧否则引擎流读取挂住（310-314）；末帧 `[DONE]`（315）。

### loopback 模型桥：lib/engine/llm-bridge.js

把 FSoft 引擎发来的 OpenAI-compatible 请求翻译成宿主 `llm.stream(GenerateOptions)`（1-5 行）。**凭证边界是最不能破的一条**（6-12 行）：桥不读凭证文件、不接收真实 api_key、不转发 Authorization 头；引擎侧只拿到 `http://127.0.0.1:<随机端口>/v1` 和占位 key；访问日志只记 method/path/状态/耗时/请求 id。loopback + 随机端口 + 占位 key 校验三者缺一都等于把宿主凭证开放给本机任意进程（14-17 行）。

- `DEFAULT_TIMEOUT_MS = 10min`（33）、`MAX_BODY_BYTES = 32MB`（34）。
- `bearerOf(req)`（38-43，私有）：只用于**校验占位 key**，取完即弃（36-37 行注释）。
- `startLlmBridge({ llm, provider, model, reasoningEffort, timeoutMs, onLog })`（90-241）：启动桥，返回 `{ url, placeholderKey, port, stats(), close() }`（232-238）。占位 key 每次启动随机生成 `dsh-bridge-<64hex>`，不复用不落盘不进日志（95-96）。路由：
  - `GET /healthz`（112-115）：桥自身存活，不含模型信息。
  - 所有 `/v1` 请求必须带占位 key（117-126）：不匹配记 `authRejected`；错误体不回显收到的 key——避免把用户误配的真实 key 写进日志（123-124 行注释）。
  - `GET /v1/models`（128-131）。
  - `POST /v1/chat/completions`（133-218）：客户端断连 → AbortController 中止上游（163-167，「省 token，也让引擎的取消语义能真正生效」）；流式边收边转（172-187，引擎在等第一个 token，攒完再发就失去流式意义；`[DONE]` 留给收尾统一发，184-186）；流已开始后上游失败只能用终止帧表达（193-200）；非流式走 `chunksToCompletion`（216-218）。
- `stats()`：`{ requests, streamRequests, authRejected, failures, lastError }`（97）。

### 产物映射：lib/engine/mapping.js

FSoft 产物 → `CodeWiki.md` / `.codewiki/` 的映射（阶段 0，1-26 行）。四条硬规则（17-26 行）：**不臆造 source_files**（只认组件→文件证据，拿不到就是空数组 + warning）；**不静默丢弃**（没映射的页进 unmapped 带机读原因）；**不覆盖**（slug 冲突两页都进 unmapped）；**不改技术内容**（只搬路径与类型，正文一字不动）。

- 常量（30-34）：`WIKI_ENTRY = 'CodeWiki.md'`、`WIKI_DIR = '.codewiki'`、`WIKI_META_REL = '.codewiki/_meta.yaml'`、`WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'`、`WIKI_MODULES_REL = '.codewiki/modules'`。
- `moduleSlug(name)`（38-44）：模块名 → kebab-case 文件名。
- `normalizeSourceFiles(list)`（48-58，私有）：去重归一。
- `sourceFilesOf(components, componentFiles)`（62-72，私有）：组件 id 取 `::` 前的文件部分；无 `::` 且无映射则跳过（不猜，69 行注释）。
- `indexModuleTree(moduleTree)`（76-96，私有）：FSoft 模块树 `{name: {path, components, children}}` 摊平成 `Map<name, node>`，节点带 `hasChildren`/`artifact`（`/^artifacts?$/i` 名字也算，88）。
- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（115-268）：主入口，纯函数。返回全字段（255-267）：`contractVersion`、`entry { path, source } | null`、`articles[]`、`unmapped[{ source, reason }]`、`meta { lastCompiledCommit, layout, language }`、`updateRecord { path, outcome, pagesWritten[], pagesRemoved[], source: 'incremental' } | null`、`warnings[]`。分支：overview 页重复进 unmapped（136-141）；非 markdown 页进 unmapped（148-151）；**模块树为空（whole-repository 模式）时页仍进写集但 `sourceFiles: []` + `attribution: 'unattributed'` + warning**（152-188，`documentation_generator.py:241` 原文 "stays {} in whole-repository mode"）；页名不在模块树且树非空 → unmapped（189-192）；slug 冲突两页都不写（199-211）；正常页 `pageKind` 取 `artifact`/`parent`/`leaf`（226）。模块树里有但引擎没产出页的模块记 warning（234-242，hierarchical 布局按 basename 再比一次 238-240）。

### 产物校验：lib/engine/output.js

阶段 2 的「读 → 映射 → 校验」三层（1-15 行）：只判「产物自身是否自洽」，frontmatter/锚点/写集冲突这类目标格式闸门属于阶段 3（14-15 行）；坏文件变成 problem 而不是异常（5 行）。

- `OUTPUT_PROBLEM_KINDS`（22-34）：`missing-docs-dir`、`missing-metadata`、`missing-module-tree`、`empty-module-tree`、`bad-json`、`entry-missing`、`empty-body`、`article-missing`、`unmapped-page`、`source-missing`、`dead-link`。
- `listMarkdownPages(rootDir, rel)`（44-62，私有）：递归收集（hierarchical 布局把子模块页放子目录，113-115 行注释引用 `doc_layout.py:module_doc_relpath`），跳过 `temp/` 与点开头目录。
- `readJsonIfExists`（64-82，私有）：可选文件缺失不是问题（全量首轮本来没有 update_record，69-70）；存在但坏了永远要报（77-79）。
- `collectOutput({ docsDir })`（91-124）：读 docs 成结构化事实 `{ docsDir, exists, pages[], json { metadata, moduleTree, firstModuleTree, updateRecord }, problems[] }`。
- `bodyLength(text)`（127-137）：去标题行与空白后的正文字符数。
- `relativeLinks(text)`（140-152）：正文相对 markdown 链接目标（跳过外链/锚点/图片 data URI）。
- `buildWritePlan({ docsDir, componentFiles, overviewName })`（162-173）：读 docs → 交给 mapping.js，不重复实现任何规则（6-7 行）。
- `validateOutput({ docsDir, repoRoot, componentFiles, overviewName })`（184-282）：校验产物自洽性，**不抛也不修**（176 行注释）。检查：入口缺失（197）、空模块树（199-207，「页是真的照写，但不能算完整成功」，201-202 行注释）、每页正文非空（209-225）、未映射页（227-228）、模块树有但无页（230-233）、source_files 存在性（235-248）、docs 内 `.md` 死链（250-265，链接到仓库源文件的交给阶段 3）。返回 `{ ok, problems, mapped, collected, stats }`——`collected` 原样带出避免上层二次读目录造成判据漂移（270-273 行注释）。

### 质量门：lib/engine/quality-gate.js

阶段 3 的**采用门**（1-33 行）：判「这批产物能不能被 wiki 采用」，合成产物自洽 + 目标格式契约 + 基线可推进性三件事。核心是三类问题分开（15-33 行）：`defect`（产品缺陷，不让算完整成功）、`degradation`（能力降级：页是真的但证据不足，可入库但**增量 ownership 不可信、不得推进基线**）、`stale`（wiki 状态陈旧，不是本次产物的错）。终态仍严格：**三类皆空才 done**（32-33 行）。

- `GATE_VERSION = 1`（42）。
- `GATE_DEFECT_KINDS`（45-59）：`missing-docs-dir`、`missing-metadata`、`missing-module-tree`、`bad-json`、`entry-missing`、`empty-body`、`article-missing`、`unmapped-page`、`source-missing`、`dead-link`、`article-contract`、`commit-mismatch`、`uncommitted-input`。
- `GATE_DEGRADATION_KINDS`（61-66）：`empty-module-tree`、`no-source-evidence`、`missing-section`、`empty-section-optional`。
- `GATE_STALE_KINDS`（68-72）：`baseline-behind-head`、`baseline-uncommitted`、`baseline-absent`。
- `NATIVE_REQUIRED_SECTIONS = []`（86）：原生通道不沿用 cw 的 Overview/Key Components 章节名，传 [] 只查结构（78-85 行注释）。
- `git(repoRoot, args, { timeout })`（90-102，私有）：失败返回 null 不抛。
- `readCommittedBaseline({ repoRoot, relPath })`（117-151）：读**已提交**的编译基线 `git show HEAD:.codewiki/_meta.yaml`——不能用工作区文件，「已写入、未提交」窗口内的基线等于把未提交产物宣布成已消化（110-116 行注释）。返回 `{ ok, source: 'absent'|'git-head'|'worktree-only', commit, worktreeCommit, dirty, reason }`。
- `WIKI_PATHS = ['.codewiki/', 'CodeWiki.md']`（156）；`uncommittedSourceChanges({ repoRoot })`（158-174）：工作区非 wiki 的未提交改动（porcelain v1 解析，重命名取 new 一侧，166-168）。
- `assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput })`（188-244）：基线裁决。defect：无 HEAD、metadata 缺 commit_id、commit_id 非 40 位 sha、产物 commit ≠ HEAD、工作区有未提交源码改动（200-224）。stale：基线缺失/未入库/落后 HEAD（226-238）。只有「基线未入库」这一条陈旧阻止推进（240-241 行注释）。
- `yamlScalar(value)`（269-288）：YAML 标量安全序列化。动机在 252-259 行注释：真实 FSoft 页标题含 `: `、` #`、反斜杠 Windows 路径，plain scalar 会让 serde_yaml 解析成嵌套映射/注释，parse_frontmatter 判坏头。做法：只在确实不安全时加双引号（`JSON.stringify` 即正确转义）；`YAML_UNSAFE_HEAD`（264）、`YAML_RESERVED`（266，`true/false/yes/no/on/off/null/~` 等裸写会变非字符串）、`YAML_NUMBER`（267）、反斜杠一律引号化（277-281 行注释）。
- `titleOf(bodyText, fallback)`（291-297）：从正文首个 H1 提取 title。
- `renderArticle({ article, body })`（316-340）：合成 frontmatter + FSoft 原文。三条硬约束（299-309 行注释）：**正文一字不动**（H1 与 title 重复是观感问题不裁剪）；**frontmatter 只填有证据的字段**（source_files 空就是空，绝不按目录猜）；**可回溯**（`fsoft_page` 记录正文来自 FSoft 原始树哪个文件，332-333）。frontmatter 结束标记后**不插空行**——否则「正文 = 原文」逐字比对永远对不上（334-337 行注释）。
- `checkRendered({ content, article, cwd, fsoftPage })`（346-373，私有）：先走 `inspectArticle`（复用不重写，342 行注释），再补「剥掉合成 frontmatter 后 `bodyLength === 0`」判空壳页（363-371 行注释：直接喂全文会把 8 行 frontmatter 当正文，`# Web` 这种空壳页 bodyLength 反而 ≈100）。
- `gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput, includeContent })`（390-568）：主入口，纯组合。`empty-module-tree` 从 problem 降为 degradation（415-421，「证据缺失不是产物坏了」）；未来 output.js 新增类别不许静默吞掉（434-436）；入口页缺/空/围栏未闭合 → 不可入库（439-462）；逐篇渲染 + 契约 + 空 source_files 记 `no-source-evidence` degradation（464-515）；有 defect 的页 `action: 'skip'` 不进 rendered（510-514）。GateReport 全字段（538-567）：`version`、`ok`、`outcome`、`writable`、`canAdvanceBaseline`（543 行注释：有 defect/degradation 就绝不推进）、`entry`、`articles[{ source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, action, defects, degradations }]`、`rendered[{ source, wikiPath, type, content }]`、`defects[]`、`degradations[]`、`stale[]`、`blockers[]`、`counts { pages, articles, writable, skipped, unmapped, defects, degradations, stale }`、`baseline { headCommit, artifactCommit, source }`。
- `TO_CONTRACT_KIND`（572-587）/ `toContractBlockers(report)`（589-596）：gate 的 blockers 翻成 contract.js 的 BLOCKER_KINDS，对不上的归 `quality-gate` 并保留原 kind 在 detail（570-571 行注释）。
- `toQualityIssues(report)`（610-624）：翻成 update-record 的 `qualityIssues`。必须显式喂给 `judgeOutcome`——否则一篇「可写但 source_files 为空」的页会被判 done 并推进基线（599-607 行注释）；只有 `baseline-uncommitted` 这条 stale 属于阻塞（618-621）。

### 落地器：lib/engine/apply-plan.js

阶段 3 的原生产物落地器：原子应用 → cw index → 基线 → 自动提交（1 行）。三条硬不变量（10-22 行）：

1. **写集封闭**：只允许写 `.codewiki/` 之下与仓库根 `CodeWiki.md`；白名单外路径一律**整批拒写**（写集不完整时部分写入等于制造没人知道的半成品，13-15 行）。
2. **索引/基线失败即回滚**：磁盘必须回到应用前，否则库里留下「文章在、索引没有」的脏结构且永不自愈（16-19 行）。
3. **提交失败不回滚**：文章本身是好的，只记 `commit-failed` 阻塞（20-22 行）。

依赖注入而不是 import index.js（23-27 行：加载 index.js 会连带拉起宿主服务）；但「可注入」不等于「默认什么都不做」——默认自带同语义提交器 `commitWikiArtifacts`（28-34 行）。

- `APPLY_VERSION = 1`（43）；`APPLY_WRITE_ROOTS = [WIKI_DIR, WIKI_ENTRY]`（46）；`APPLY_STAGES = ['write', 'index', 'baseline', 'commit']`（49）。
- `APPLY_PROBLEM_KINDS`（52-59）：`empty-target`、`absolute-target`、`escaping-target`、`out-of-scope`、`duplicate-target`、`bad-content`。
- `APPLY_RESULT_KINDS`（62-73）：`write-failed`、`index-failed`、`baseline-failed`、`commit-failed`、`commit-scope`、`not-writable`、`wiki-missing`、`gate-partial`。
- `checkWriteTargets(items)`（86-131）：写集校验纯函数；**内容相同的重复投递去重，内容不同才报**（120-125）。为什么不逐条跳过：78-82 行注释。
- `capturePre(repoRoot, rels)`（138-153）/ `restorePre(snapshot)`（155-176，私有）：pre-image 快照与逆序恢复；pre-image 不存在 = 本次新建，回滚就删掉（166-167）。
- `writeAll(repoRoot, targets)`（178-193，私有）：内容与磁盘逐字节相同的项不重写——无变化的一轮不产生 mtime 抖动、不触发假提交（183-185 行注释）。
- `defaultRunCw`（197-207，私有）、`defaultVerifyCommit`（209-216，私有）。
- `verifyCommitScope(repoRoot, sha, { allowExtra, files })`（230-243）：用 `git show --name-only` 反查实际提交内容——「命令带了 pathspec」和「提交里真的只有这两个路径」是两件事（221-223 行注释）。
- `commitWikiArtifacts(cwd, { jobId, writtenCount })`（256-301）：小提交器，安全边界逐条照抄 `autoCommitWiki`（248-251 行注释）。检查链：只对磁盘存在的路径操作（260-264）、git 仓库/有 HEAD/不在 merge-rebase-cherry-pick 中（266-272）、无未解决冲突（273）、`.codewiki/` 被 `.gitignore` 忽略时显式认出防误报无改动（274-278）、无改动返回 `noChanges`（279-281）、需配置 user.name/email（282-284）、`commit --no-verify` 不跑仓库钩子（294-296）。
- `TO_CONTRACT_KIND`（304-313）/ `toApplyBlockers(problems)`（315-326）：落地问题 → 契约 BLOCKER_KINDS；kind 写错会让面板与终态判定同时失明（318-319 行注释）。
- `findArticlesMissingFromIndex(repoRoot, written)`（344-365，私有）：找出「已写盘但没进 `_index.md`」的文章。动机在 329-338 行注释：`cw index`（vendor/codewiki/src/main.rs:236-256）逐篇 `frontmatter::parse`，**解析失败就 continue**，最后照样返回 0——frontmatter 写坏的文章静默缺席，实测 `title: 核心: 引擎` 会让 serde_yaml 把后半当嵌套映射、索引显示 "Index updated: 0 articles" 而退出码 0（751-757 行注释）。比对口径：索引链接是「相对 `.codewiki/` 去掉 `.md`」（336-337）；跳过 `_` 开头文件（338、350）。
- `listFilesUnder`（368-383）、`collectPruneTargets(repoRoot, pruneRoots, keepRels)`（398-412，裁剪根必须落在写集白名单内否则会删用户源码，403-405）、`pruneEmptyDirs`（416-430，空目录不进 pre-image，414-415）。
- `normalizeIndexLinksIn(repoRoot)`（447-461，私有）：把 `_index.md` 链接头的 `\` 规范成 `/`——Windows 上 cw 会写出 `[[modules\a|x]]`，不规范化等于索引不可信（432-439 行注释）；与 index.js 版本唯一差别是 ENOENT 之外的读写错误**抛出**（440-445）。
- `entryBody(text)`（466-469，私有）：剥掉入口页自带 frontmatter（CodeWiki.md 不参与 cw 索引，463-465）。
- `applyNativeOutput({...})`（495-848）：主入口。流程与分支：
  - `report.writable !== true` → 一个字不写（551-554）；gate 是 partial 但 writable=true → 照写但**不许洗成 done**（555-562）。
  - 收集写集：文章 + 入口（`entryMode: 'keep'/'overwrite'/'skip'`，578-607）+ `extraFiles`（引擎原始状态，567-576，与文章同批写、同批回滚、同批提交）。
  - `dryRun` 只算写集与判定（619-624）。
  - pre-image 覆盖写集 + 索引 + 基线 + 裁剪对象（633-644）；`.codewiki/` 本次才出现时回滚连目录一起删（646-655）。
  - wiki 未初始化时先 `cw init`（657-680）；「有 `.codewiki` 却缺 `_meta.yaml`」判人工破坏拒绝自动初始化（662-667）。
  - 写盘 → 裁剪过期状态（683-701，顺序反了会让下一轮水合读到「新图 + 旧文章」这种从未存在过的组合，690-692 行注释）。
  - `cw index` 失败回滚（712-729）；链接规范化失败按索引失败同等处置（730-748）；索引缺页回滚（751-770）。
  - 基线：只有「所有变化都被消化」才推进；失败连文章一起回滚——「文章比基线新」会导致下一轮重复消费（772-801，773-775 行注释）。
  - 自动提交失败**不回滚**（803-828）；提交成立后反查范围，混进 wiki 之外路径记 `commit-scope`（811-820）；`noChanges` 只记 note（821-824）；兜底「未提交状态下不许留干净的 done」（830-835）。
  - ApplyResult 骨架全字段（516-533）：`version`、`startedAt`、`repoRoot`、`applied`、`outcome`、`written[]`、`pruned[]`、`entry`、`index`、`baseline`、`commit`、`rolledBack`、`problems[]`、`blockers[]`、`notes[]`、`canAdvanceBaseline`；`done()` 追加 `finishedAt`、`ok`、`unchangedFiles`、`dryRun`（534-544）。

### 跨轮状态：lib/engine/native-state.js

阶段 5：原生引擎的跨轮受管状态（统一增量的持久化底座）。头部注释（1-40 行）解释了 FSoft 组件级增量的四个硬依赖：`module_tree.json`（缺了 `_update_options()` 直接返回 None 退化全量）、`temp/dependency_graphs/<repo>_dependency_graph.json`、`metadata.json`（`generation_info.commit_id` 是 updater 的 old_commit）、上一轮的文章（updater 是原地 patch，页不在就走 missing_page 重建）。

- `NATIVE_STATE_VERSION = 1`（45）；`NATIVE_STATE_DIR = '.codewiki/_native-state'`（47）；`NATIVE_STATE_FILE = 'state.json'`（48）。**状态目录以 `_` 开头的原因**（22-28 行）：`cw index` 会递归整个 `.codewiki/` 收录 `.md` 且只跳过 `_` 开头路径，放 `temp/native-state/` 会让持久化文章被收成第二份文章。
- `STATE_REQUIRED_DOCS = ['module_tree.json', 'metadata.json']`（52）；`STATE_TEMP_FILES`（56-59，`temp/reference_index.json`、`temp/artifact_index.json`）；`STATE_TEMP_DIRS = ['temp/dependency_graphs']`（60）。
- `graphFileName(repoRoot)`（77-81）：对齐引擎 `graph_store.sanitize_repo_name`——Python 的 `c.isalnum()` 是 Unicode 感知，中文仓库名保留原样，所以必须用 `\p{L}\p{N}` 而非 `[A-Za-z0-9]`，否则中文仓库的图每轮被判缺失、白退全量（66-76 行注释）。
- `stateDocsDir(stateDir)`（84-86）；`isStateDocPath(rel)`（101-110）：判据是「是不是下一轮增量需要读的输入」——所有 `.md`、顶层 `.json`、`temp/` 白名单、其他子目录文件；排除 `temp/` 其余中间件（88-96 行注释）。
- `stateDocFiles(stateDir)`（118-123）：受管路径清单（审计用）。
- `readState(stateDir, repoRoot)`（135-162）：读 state.json；反序列化边界上的对象必须被检查（126-129 行注释）；坏掉返回 `{ ok: false, code: 'absent'|'unreadable'|'corrupt'|'version', reason }`。
- `readStateText`（165-171）：原始文本（字节比较用）。
- `isUpdateEligible({ stateDir, repoRoot, baseCommit, engineVersion, headCommit })`（187-234）：判「能不能走真实增量」，每个不可增量的原因都要说出来（173-177 行注释——「悄悄退全量」会让用户以为增量生效了实际每轮全量）。检查：必需 docs 缺失（194-208）、依赖图按当前仓库名找（198-200）、引擎版本变更使旧图不可比（210-219）、记录基线与 cw 基线不一致时不阻断但记原因（221-233）。返回 `{ eligible, reason, state, missing[] }`。
- `hydrateDocsDir({ stateDir, repoRoot, docsDir })`（265-283）：跑引擎前把状态**复制**进 docs 目录——移动会让「这一轮失败」直接毁掉下一轮的输入（253-258 行注释）。返回 `{ hydrated[], skipped[] }`。
- `captureDocsDir({ docsDir, stateDir })`（300-333）：把引擎 docs 采集成「下一轮的原始状态」写集 `{ rel, content }`（直接交落地器当 extraFiles，285-289 行注释）。非 utf8 文本跳过并记 missing（316-320）；硬依赖缺失单独报（324-331）。返回 `{ files[], captured[], missing[] }`。
- `buildStatePayload({...})`（352-406）：组装 state.json。**不记录本轮结局**——本轮结局的权威在 `.codewiki/_meta.yaml`，而 state.json 要在 apply 之前就落盘（与文章同一份 pre-image），写「本轮结局」就必须 apply 后再改一次文件，造出第二个提交且回滚语义分叉（336-347 行注释）。payload 全字段（371-405）：`stateVersion`、`repoRoot`、`consumedRange { baseCommit, headCommit }`、`pendingChanges { state, baseCommit, headCommit, committed[], staged[], unstaged[], untracked[], deleted[], renamed[], reason }`、`unconsumed[]`、`engineVersion`、`scope`、`effectiveScope`、`updateOutcome`、`fallbackReason`、`notes[]`（截尾 20）、`updatedAt`。
- `stateFileItem(payload, stateDir)`（409-414）：payload → 写集项 `{ rel, content }`。
- `stateFingerprint(text)`（425-435）：去掉 `updatedAt`/`notes` 的实质指纹——否则无变化的一轮也产生一次真实提交（416-421 行注释）。
- `mergeUnconsumed({ changeSet, prevUnconsumed })`（455-497）：跨轮未消化变化合并。核心问题（439-448 行注释）：引擎读的是**工作区文件**，未提交改动会被写进文章；但 cw 基线推进到 HEAD，下一轮 change-set 从新 HEAD 算起，那些未提交改动就再也算不进变化集——文章与源码脱节而系统一路绿。解法：staged/unstaged/untracked 一律记进 `unconsumed`（465-469），只有出现在 committed 里才算消费成立（471-485）；变化集 = 本轮四路 ∪ 上一轮携带（487-489）。返回 `{ unconsumed[], consumedNow[], effectiveChanges[], carried }`。

### 编排器：lib/engine/native-run.js

阶段 4：原生引擎的一次「完整编译」编排（生产通道）。为什么单独一层（1-8 行）：JobService 已 4800+ 行，把全部裁决塞进 tick 会让「终态由谁裁决」再次含糊。裁决链固定成一条直线（9 行）：`env(doctor + engine-lock) → 增量决议 → 水合 → 引擎 → validate(质量门) → index/baseline/commit(落地器)`。硬不变量（11-17 行）：锁不一致/依赖不闭合直接 failed 不跑引擎；引擎 done 不能替代质量门；落地器 partial/failed 终态不许 done；partial/failed 一律不推进基线；取消是终态。

- `DEFAULT_ENGINE_ENTRY`（56，`<这里>/python/entry.py`）。
- `DEFAULT_UPDATE_OPTIONS = { rung: '3' }`（66）：增量算法档位必须显式给——「留空靠引擎内部默认值，上游改默认就等于我们的增量语义静默漂移」（60-65 行注释）。
- `DEFAULT_ENGINE_TIMEOUT_MS = 45min`（70）。
- `RANK` / `weakest`（73-74，私有）：合成终态只能取最弱的，绝不允许被后续步骤提升。
- `RESOLUTION = { FULL: 'full', UPDATE: 'update' }`（85）；「变化集为空」**不是**跳过引擎的理由——「有没有变」是图 diff 说的不是 git 路径集合说的（79-84 行注释）。
- `applyBlockersOf(applyRes)`（88-94，私有）。
- `runNativeJob({ repoRoot, scope, kind, requestId, signal, timeoutMs, requireCommittedInput, docsDir, deps, onProgress, onLog })`（109-743）：主入口，全部依赖注入（19-20 行）。流程：
  1. **环境与锁**（183-276）：probe 失败必须带出去（205-208 行注释：否则 doctor 把「引擎没装」和「装了但坏了」混为一谈）；`drift`（版本漂移）与 `unhealthy`（pip check 未通过，不自动绕过，255-268）都直接 failed；**首次落锁推迟**到落地器跑完之后——现在写 `.codewiki/engine-lock.json` 会让 `.codewiki/` 在 `cw init` 前就存在，被落地器判成人工破坏的半截库、首次编译整批失败还回滚（269-275 行注释）。
  2. **增量决议**（283-379）：变化是什么（`collectChangeSet` + 上一轮 `unconsumed` 合并）、能不能增量（受管状态齐全性 `isUpdateEligible`、基线可达、必须有独立 docsDir——把状态水合进仓库 `.codewiki/` 会污染用户库且 pre-image 覆盖自己的输入，314-317 行注释）、水合（`hydrateDocsDir`，338-352；水合不到任何文件等同缺图退全量 341-344）。决议现场 `inc` 无论走哪条分支都随结果出去（360-379）。
  3. **模型桥**（381-407）：占位 key 随机、不进日志；桥在引擎退出后关闭（454-457，先关桥会让还在读流的引擎拿到 502）。
  4. **引擎**（409-457）：增量用 `update`、全量用 `generate`，**两者不能互换**（410-415 行注释）；`commitId` 用当前 HEAD，未提交部分由 state.json 的 unconsumed 携带（431-436 行注释）。
  5. **质量门**（503-526）：引擎 done 不能替代；gate 后取消是「未落盘的取消」（517-526）。
  6. **采集跨轮受管状态**（528-589）：采集点在「gate 之后、apply 之前」，放进 apply 的 extraFiles 与文章同事务（530-533 行注释）；引擎自报 `stateFiles` 与实际采集交叉核对（540-548）；state.json 指纹相同沿用旧文本防假提交（578-582）；采集失败不能悄悄退化成不持久化（586-588 行注释）。
  7. **落地器**（591-617）：`advanceBaseline: null`——基线只由裁决决定，不接受调用方硬开（599-600）；`pruneRoots` 只在增量时裁（603-605）。
  8. **严格合成终态**（619-668）：`finalOutcome = weakest(weakest(engine, gate), apply)`；gate 的阻塞原因必须一律进终态（638-643 行注释：否则真实 gate 拦下的死链/空正文在终态里消失）；增量降级可见性（645-659）：想要增量却没走成（`degradedToFull`）或引擎自报回退（`engineRolledBack`）且产物已不完整时加 `incremental-fallback` blocker——产物完整时只进 notes，否则「每次都 full_fallback」的仓库永远绿不了（646-649 行注释）；done 不许带 blockers，有就降 partial（660-664）。
  9. 待落锁写盘（679-693，仍要再核 `_meta.yaml`——落地器可能早退）；返回带 `gate.articles` 逐篇明细（718-729 行注释：否则面板只能靠引擎自报计数去猜，把门拦下的页显示成成功）。
  - 返回结构（`settle`，140-174）：outcome、stage、blockers、error、writtenCount、failedCount、`updateOutcome`（148-152 行注释：缺了它 full_fallback 会在上层被当普通 done——「基线悄悄前移、变化悄悄丢」的入口）、engine、usage、startedAt/finishedAt、requestId、`canAdvanceBaseline`、artifacts、`incremental`（inc 现场证据）、gate、apply、engineLock、notes。

### Python 入口：lib/engine/python/entry.py

FSoft 原生引擎的 JSON-lines 薄入口（1-36 行 docstring）。**不是算法实现**——依赖图、聚类、写作、增量全部由 FSoft 做；本文件只做四件事：stdin 一行 JSON → 一次 FSoft 调用；五段进度翻译成八段契约；结果翻译成 EngineResult；守住两条红线（**不读本机凭证库**、**不让 FSoft 的打印污染协议流**）。

- stdout 接管（12-21 行 docstring + 实现 46-92）：FSoft 大量用 `print`/`click.secho` 且 click 会缓存 stdout 包装器，「事后替换 sys.stdout」拦不住已缓存的引用，所以**在导入任何 codewiki 模块之前**把 `sys.stdout` 换成 `_ProtocolOnly`（59-92）：普通 write 全部改道 stderr，协议行走保存下来的 `_REAL_STDOUT`（48）；连 `flush` 也转（73-78，进度条 flush 打到真 stdout 会把半行日志挤进协议流）；Windows 下先把两个流 reconfigure 成 utf-8（50-56，否则中文错误信息过管道是乱码）。
- 不用 ConfigManager（23-29 行 docstring）：它会读 `~/.codewiki/config.json` 或系统 keyring；迁移后密钥只在进程环境变量里。
- 退出码（31-35 行 docstring）：只表达进程层结果，语义以最后那条 result 行为准。
- 协议常量：`PROTOCOL_VERSION = 1`、`ACTIONS = ("doctor", "generate", "update", "cancel")`（94-95）；模型通道环境变量 `ENV_BASE_URL`/`ENV_API_KEY`/`ENV_MAIN_MODEL`/`ENV_CLUSTER_MODEL`（98-101）。
- `emit(obj)`（104-108）：所有协议消息必经之路；`emit_hello`（111-112）、`emit_progress`（115-128）、`emit_result`（131-132）。
- `failure(code, message, stage, request_id)`（135-153）：failed 终态骨架，message 只放给人看的说明绝不拼凭证内容（136）。
- `_engine_version()`（159-173）、`_pip_check(timeout=120)`（176-195，1A 门禁的运行时版本：装到一半的 venv 会让 FSoft 在生成中途崩掉，一整轮模型调用白烧，178-181 行注释）。
- `action_doctor(request_id, payload)`（198-237）：版本 + pip check，失败也带 engine 现场（208-215）。
- `_model_config()`（243-275）：从进程环境读通道，缺项返回原因；错误信息刻意不打印值（246-248 行注释）；`fallback_model` 必须显式给——缺省 None 会让 FSoft 在 `model_name.lower()` 上抛 AttributeError 且崩在 graph 阶段开头（263-267 行注释）。
- `bridge_progress(adapter, request_id, on_stage)`（281-332）：替换 adapter.progress_tracker 的三个阶段方法（284-290 行注释：FSoft 直接构造 ProgressTracker 没有注入点，替换比 fork 类更不随上游漂移）；`on_stage` 记录最后一个真实到达的阶段，done 结果里的 stage 是实测值不是写死常量（327-329 行注释）。
- `_count_docs(docs_dir)`（338-363）：清点产物页数，**必须递归**（hierarchical 布局页在子目录，只 glob 根层会少计而终态看着像成功，339-344 行注释）；排除 `temp/` 与点目录。
- `_git_commit(repo_path)`（366-381）。
- `action_generate(request_id, payload, is_update=False)`（384-496）：准备 config → 跑 adapter → 异常翻契约终态。`SystemExit(0)` 不是失败——FSoft 在「无变更」路径会 sys.exit(0)（444-453）；config 显式给 `max_tokens=32768`、`max_token_per_module=36369`、`max_depth=2`、`request_limit=100` 等（405-412）；`updateOptions` 与 `commitId` 由调用方显式给出（414-426，组件级增量比较的是依赖图与 commit 号无关，424-426 行注释）；缺页 → partial + `article-missing` blockers（473-481）；用量取自 `job.statistics.usage_totals`（485-495）。
- `_update_outcome_of(adapter)`（499-513）：增量结局取自 `_last_update_record`；拿不到不等于「没增量」（可能是全量 generate），返回 None 而不是编一个值（502-506 行注释）。
- `_state_files(docs_dir)`（516-545）：列出引擎**真实产出**的跨轮状态文件（顶层 `*.json` + temp 白名单）；只报磁盘存在的文件不按白名单编造——白名单写错会把「引擎其实没产出依赖图」误记成已持久化，下一轮图 diff 恒为空、永远 no_change（565-570 行注释）。
- `_done_result`（548-579）：done 骨架，`artifacts.stateFiles` 交叉校验用（566-571），`updateOutcome` 与 artifacts 并列（573-576）。
- `_classify_exception`（582-609）：按异常**类型**分类（文本随版本变，585-586 行注释）：`IncompleteGenerationError`/`IncompleteDocumentationError` → partial + 缺页（591-600）；`APIError`/`ConfigurationError` → `engine-model`；`RepositoryError` → `engine-missing`；`KeyboardInterrupt` → cancelled；其余 `engine-crashed`。
- `_cancelled_result`（612-629）；`handle_request(msg)`（635-657，任何路径都必须返回 result）；`main()`（660-673）；顶层 KeyboardInterrupt 兜底也回一条 cancelled（676-686）。

### 阶段映射：lib/engine/python/stage_map.py

FSoft 五段进度 → 引擎八段契约的映射（纯函数，1-17 行 docstring）。单独成文件的理由：这是 Node 与 Python 唯一共享的**枚举口径**，两边漂移的表现是「面板显示在写作，实际已经在校验」——错得不响但很难查（3-7 行）；测试反向断言两边集合完全一致（9-10 行）。

- `ENGINE_STAGES`（20-29）：与 `contract.js` 完全一致（测试双向对账）。
- `FSOFT_STAGE_NAMES`（33-39）/ `FSOFT_STAGE_WEIGHTS`（40-46）：FSoft ProgressTracker 的镜像，权重保持一致否则进度条在阶段交界跳变（31-32）。
- `FSOFT_TO_ENGINE`（50-56）：五段 → 四段（4/5 都落 validate：HTML 不做、finalization 是收口，报成 articles 会让面板一直显示在写作，48-49）。
- `DEFAULT_ENGINE_STAGE = "articles"`（60）：未知阶段不抛错——进度上报是旁路，不该因版本差异打断编译（58-59）；归 articles 因第 3 段最耗时最需要可见。
- `FSOFT_PROGRESS_CEILING = 90`（63）：引擎只占 90%，剩 10% 留给 Node 侧收尾，避免「引擎说 100% 但 wiki 还没索引/没提交」的假完成（14-16）。
- `map_stage(fsoft_stage)`（66-72）；`percent_of(fsoft_stage, stage_progress)`（75-97）：与 FSoft `get_overall_progress` 同构（已完成权重和 + 当前权重×阶段内进度），乘 CEILING 后夹到 [0,100]；自己再算一遍是因为不持有 tracker 实例时也要能算（83-86 行注释）。

## Architecture

```text
                  ┌───────────────────────────────────┐
                  │      index.js（宿主插件主入口）    │
                  └───────┬──────────────────┬────────┘
        自研 agentic 通道 │                  │ FSoft 原生引擎通道
  ┌──────────────────────▼─────────┐  ┌─────▼─────────────────────────────┐
  │ symbols.js    符号图提取        │  │ native-run.js   裁决链编排         │
  │ graph-diff.js 组件级 diff       │  │  ├ manifest.js    doctor+引擎锁   │
  │ incremental.js 快照+过期过滤    │  │  ├ client.js     JSON-lines 子进程│
  │ change-set.js  git 四路变更集   │  │  ├ llm-bridge.js ◄ openai-bridge │
  │ update-planner.js 增量计划      │  │  ├ quality-gate.js 采用裁决       │
  │ cluster.js     LLM 聚类        │  │  ├ apply-plan.js  落地+回滚       │
  │         ▼                       │  │  └ native-state.js 跨轮状态       │
  │ articles-agentic.js 并发执行    │  │        ▲ stdio / HTTP loopback   │
  │  └ agentic-host.js → llm.stream │  │  entry.py / stage_map.py         │
  │     └ agentic.js 工具循环       │  └──────────────────────────────────┘
  │         ▼                       │
  │ article-contract.js 契约闸门 ◄──┼──── 两通道共用（含 update-record.js）
  └─────────────────────────────────┘
```

两条通道共享同一批底座：`article-contract.js` 是文章能不能入库的唯一判据；`graph-diff.js` 同时服务于自研增量（`incremental.js`/`update-planner.js`）与 FSoft 引擎同源算法的对照；`change-set.js` 被自研计划器与 `native-run.js` 的增量决议共同消费；`update-record.js` 的四态终态口径与 `contract.js` 的 `describeEngineResult` 保持一致。

## Data Flow

### 自研 agentic 通道：全量编译

1. `extractRepoGraph`（lib/symbols.js:785）读仓库文件 → `graph: Map<id, node>` 与 `byFile`；`resolveImportEdges`（lib/symbols.js:810）补 `dependsOn` 边。WASM 不可用时逐文件降级 `regexExtract` 并记 `stats.regex`。
2. `clusterComponents`（lib/cluster.js:291）用 `llmCall` 做三层聚类（顶层 → 超大模块下钻 → 超级分组），失败降级 `heuristicCluster`；`toPlanModules`（lib/cluster.js:460）产出任务清单。
3. `runAgenticArticles`（lib/articles-agentic.js:231）按双并发池调度，每个任务走 `runOneArticle`（lib/articles-agentic.js:33）→ `runAgenticArticle`（lib/agentic.js:331）工具循环：模型用 `list_files`/`read_code`（带重复读抑制）现场读源码，用 `edit_article` 的 insert/str_replace 增量写文章；需要时 `generate_sub_module` 就地递归派发子文章（深度封顶 `subDepth`）。`streamFn` 由 `makeHostStream`（lib/agentic-host.js:83）提供，裸消息经 `toRequestMessages`（lib/agentic-host.js:34）换成带稳定身份的宿主正式消息。
4. 写盘前过写集闸门（`makeWriteSet`/`isWritable`，lib/article-contract.js:352-378），落盘后由 `index.js` 调 `inspectArticle`（lib/article-contract.js:213）做契约判定。

### 自研通道：增量更新

1. `collectChangeSet`（lib/change-set.js:102）收 committed/staged/unstaged/untracked 四路，`ok=false` 时调用方退全量。
2. `loadSnapshot`（lib/incremental.js:94）取上一轮瘦身图，与现场新图一起喂 `diffGraphs`（lib/graph-diff.js:447）；`filterStaleTasks`（lib/incremental.js:140）或 `planUpdate`（lib/update-planner.js:156）产出逐篇 action（write/keep/review）+ reason，反向依赖经 `dependentsOf`（lib/update-planner.js:85）闭包，无归属源码变更置 `needsFull`。
3. 只跑 write 任务；`judgeOutcome`（lib/update-record.js:37）合成终态，`buildUpdateRecord` + `saveUpdateRecord`（lib/update-record.js:217/217）落盘可复盘记录；`slimGraph` + `saveSnapshot`（lib/incremental.js:106/106）只在实质变化时覆盖快照（`sameSnapshotContent`，lib/incremental.js:53）。

### FSoft 原生引擎通道

1. `runNativeJob`（lib/engine/native-run.js:109）先 doctor（`manifest.js`）：指纹与 `.codewiki/engine-lock.json` 比对，`drift`/`unhealthy` 直接 failed。
2. 增量决议：`collectChangeSet` + `native-state.mergeUnconsumed`（lib/engine/native-state.js:451）→ `isUpdateEligible`（lib/engine/native-state.js:187）判定 `full`/`update`；增量时 `hydrateDocsDir`（lib/engine/native-state.js:265）把上一轮状态复制进独立 docsDir。
3. `startLlmBridge`（lib/engine/llm-bridge.js:90）在 127.0.0.1 随机端口起桥，引擎侧拿占位 key；`runEngine`（lib/engine/client.js:223）spawn `entry.py`，写一行请求，读 JSON-lines。`entry.py` 内部：stdout 守卫 → `_model_config` 从环境读通道 → `CLIDocumentationGenerator.generate()` → `bridge_progress`（经 `stage_map.py` 的 `map_stage`/`percent_of`）推进度 → 结果翻译成 EngineResult（`artifacts.stateFiles` 报真实产出的状态文件）。
4. `gateNativeOutput`（lib/engine/quality-gate.js:390）读 docs → `validateOutput`（lib/engine/output.js:184）→ `renderArticle` 合成 frontmatter → `checkRendered`（走 `inspectArticle`）→ `assessBaseline`；defect/degradation/stale 三分。
5. `captureDocsDir`（lib/engine/native-state.js:300）采集跨轮状态 → `applyNativeOutput`（lib/engine/apply-plan.js:495）：`checkWriteTargets` → pre-image → 写盘+裁剪 → `cw index`（含缺页反查 `findArticlesMissingFromIndex`）→ 链接规范化 → `cw meta update`（基线）→ `commitWikiArtifacts` + `verifyCommitScope`；index/基线失败整体回滚，提交失败不回滚。
6. `runNativeJob` 合成最弱终态并返回 `updateOutcome`/`incremental`/`gate`/`apply` 全部现场证据。

## Connections

- [[index]]：插件主入口（`index.js`）消费本目录全部导出——`runAgenticArticles`/`markBigAgenticTasks`/`DEFAULT_MAX_STEPS` 走 agentic 通道，`runNativeJob` 走原生通道，`inspectArticle`/`hasBlockingIssue` 是落盘闸门，`judgeOutcome`/`describeOutcome` 决定面板终态文案。
- [[engine]]：`lib/engine/` 子系统（契约、客户端、模型桥、质量门、落地器、跨轮状态、Python 入口）若单独成文，从这里进入；`native-run.js:109` 的 `runNativeJob` 是该子系统的唯一编排入口。
- [[symbols]]：符号提取细节（16 语言规则表、正则降级、import 边解析）。
- [[incremental]]：增量判定细节（快照格式、纯注释降级、write/keep/review 计划、module-map）。
- [[agentic]]：agentic 写作细节（四个工具 Schema、重复读抑制、CRLF 归一化、开场提示词）。

## Known Issues

- **正则降级有损**（lib/symbols.js:289-296、374-440）：WASM 语法缺失/ABI 不匹配/AST 零符号时退到 `regexExtract`，拿不到精确字节区间与嵌套结构，`sourceCode` 只是「定义行到下一个定义行」且末符号最多 60 行（421-426）；嵌套类成员、多行签名可能识别不出。降级本身记在 `stats.regex` 可见。
- **`stripComments` 是近似**（lib/graph-diff.js:69-74）：字符串字面量里的 `//` 会被误剥，导致 `codeHash` 小概率碰撞；引入真词法分析需要语言参数，纯逻辑路径不划算。
- **read_code 重复读抑制只省回吐不省历史**（lib/agentic.js:108-114）：去重命中时返回「你已在第 N 步读过」，但此前那次读的正文仍在消息历史里占上下文。
- **`generate_sub_module` 的死链风险靠说实话兜底**（lib/agentic.js:290-305、lib/articles-agentic.js:79-81、113-117）：任何一层把「没派出」说成「已派发」，父文就会留下指向不存在文件的链接；深度判定闭包下传错误会让 `subDepth` 封顶形同虚设。
- **whole-repository 模式归属证据整体缺失**（lib/engine/mapping.js:152-188、lib/engine/quality-gate.js:61-66、496-501）：`module_tree.json` 为 `{}` 时所有页 `source_files: []` + `no-source-evidence` degradation——页照写，但该通道的增量 ownership 不可用，终态落 partial。
- **`cw index` 静默缺页**（lib/engine/apply-plan.js:751-770）：vendor 引擎对 frontmatter 解析失败的文章 `continue` 且退出码仍 0；落地器用 `findArticlesMissingFromIndex` 反查并整体回滚，但这依赖链接格式比对（`_` 开头文件被排除，350），若上游改索引链接格式该判据会失灵。
- **引擎锁推迟写盘的窗口**（lib/engine/native-run.js:269-276、679-693）：首次编译在落地器成功前不写 `.codewiki/engine-lock.json`；若每次编译都在落地器早退（如 not-writable），锁会一直缺席、每轮都走 doctor 的 `absent` 分支。
- **无依赖边时反向依赖不可用**（lib/update-planner.js:393-397）：`extractCurrentGraph` 类链路若不建 `dependsOn` 边，「接口变了但依赖方文章不重写」是必然的，只能如实记 warning。
- **`_detect_changed_files` 的 compare_to 未使用**（lib/engine/python/entry.py:423-425）：组件级增量（rung 3）比较依赖图而非 commit 号，CLI 的按文件失效路径（rung 0）不在本入口走；`commitId` 仅用于记账。
- **两套增量算法并存的口径差**：自研通道的「纯注释降级」在判定层实现（lib/incremental.js:147-170、lib/update-planner.js:186-210），而 `diffGraphs`（lib/graph-diff.js:447）与上游逐位对齐、不做该降级——两处对「实现变（body）」的 counts 口径不同（一个含 cosmetic、一个过滤后），消费时需注意 `changedComponents` 与 `cosmeticComponents` 的区别（lib/update-planner.js:413-415）。
