---
title: engine_output
type: module
source_files:
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/client.js
  - test-engine-output.mjs
  - test-engine-output-real.mjs
tags: [engine, fsoft, output, mapping, validation, native]
---

## Overview

`engine_output` 模块负责把 FSoft 原生引擎产出的 `docs/` 树（markdown 文章 + 四个 JSON 元数据）**读取、映射到 cw 写集、校验自洽性**。它对应迁移里被称为「阶段 2」的那一层，是 Node 侧消费引擎产物、把它变成可以落库的 wiki 写集之前的最后一关纯逻辑。

这一层刻意只做三件事，且三件事都必须可被测试逐条钉死（`lib/engine/output.js:1-15`）：

1. **读（collect）**：把 `docs/` 目录读成结构化事实——页清单 + 四个 JSON（`metadata.json` / `module_tree.json` / `first_module_tree.json` / `update_record.json`）。坏输入变成 `problems` 而不是异常，调用方据此判 `partial`，不会把缺失静默吞掉。
2. **映射（map）**：交给 `lib/engine/mapping.js`，把 FSoft 的 docs 树翻译成 cw 的写集描述（入口页 + 模块文章 + 元数据）。mapping 实现了阶段 0 冻结的四条硬规则，output.js 不重复实现任何规则。
3. **校验（validate）**：把「能不能算成功」判成可机读的 `problems` 列表。只判「产物自身是否自洽」（页在不在、正文空不空、链接指向的东西在不在计划内）；frontmatter/锚点/写集冲突这类**目标格式**闸门属于阶段 3（`lib/engine/quality-gate.js` 与 `lib/engine/apply-plan.js`）。

安全边界（写下来防止它长成「第二个引擎」，`lib/engine/output.js:8-15`）：
- 不重新聚类、不做图 diff、不改写文章正文（FSoft 已经算完了）；
- 不臆造 `source_files`（沿用 mapping.js 的证据规则）；
- 不因为「产物看起来差不多」就把 problem 降级成 warning——缺页就是缺页，上层据此判 partial。

涉及的两个核心文件分工明确：`lib/engine/output.js` 是「读 + 校验 + 编排」层，`lib/engine/mapping.js` 是「纯格式翻译」层。`lib/engine/contract.js` 提供跨进程契约常量（`ENGINE_CONTRACT_VERSION` 等）与终态机读词表，被 mapping 引用。

## Key Components

### `lib/engine/output.js`

**常量**

- `OUTPUT_PROBLEM_KINDS`（第 22-34 行）：冻结的问题类别数组，机读、稳定、上层按 `kind` 分派（不靠 message 文本匹配）。含 `missing-docs-dir` / `missing-metadata` / `missing-module-tree` / `empty-module-tree` / `bad-json` / `entry-missing` / `empty-body` / `article-missing` / `unmapped-page` / `source-missing` / `dead-link`。对应 `PROBLEM_SET`（第 36 行）是其 `Set` 形式，用于 `validateOutput` 注册检查。
- 模块级辅助：`posix()`（第 38 行，反斜杠归一为 `/`）、`stripBom()`（第 39 行，去 UTF-8 BOM）。
- `TEMP_DIR = 'temp'`（第 43 行）：docs 下工作文件目录，不算文章页。

**函数**

- `listMarkdownPages(rootDir, rel)`（第 44-62 行）：递归收集 `docs/` 下所有 markdown 页（POSIX 相对路径、已排序）。跳过 `.` 开头的隐藏目录与 `temp/`（依赖图、引用索引、artifact 索引等工作文件）。
- `readJsonIfExists(file, problems, kind, { optional })`（第 64-82 行）：读一个 JSON 文件；`ENOENT` 且 `optional=false` 才报 `kind` 类问题；可选文件缺失不报；存在但坏了永远报 `bad-json`（不因为「文件可选」就吞掉）。
- `collectOutput({ docsDir })`（第 91-124 行）：**读**层主入口。返回 `{docsDir, exists, pages, json, problems}`。`json` 含 `metadata / moduleTree / firstModuleTree / updateRecord` 四个字段（`firstModuleTree` 与 `updateRecord` 通过 `optional:true` 读取，全量首轮本来就没有）；`pages` 来自 `listMarkdownPages` 的递归收集。**不抛**（坏输入变成 problems，缺 `docsDir` 报 `missing-docs-dir`）。
- `bodyLength(text)`（第 127-137 行）：去掉标题行与空白后的正文字符数，用于判「这页其实只有个标题」。
- `relativeLinks(text)`（第 140-152 行）：收集正文里的相对 markdown 链接目标，跳过外链（`http:`/`mailto:`/`data:` 等 scheme）、锚点（`#`）、图片 data URI。
- `buildWritePlan({ docsDir, componentFiles, overviewName })`（第 162-173 行）：编排入口——`collectOutput` 后交给 `mapFsoftOutput`，返回 `{collected, mapped}`。纯函数之外只多一次目录读。
- `validateOutput({ docsDir, repoRoot, componentFiles, overviewName })`（第 184-282 行）：**校验**主入口。返回 `{ok, problems, mapped, collected, stats}`，**不抛、不修任何东西**。依次检查：① 入口（`entry-missing`）；② 空模块树（`empty-module-tree`，whole-repository 模式的正常产物但归属证据缺失）；③ 每篇文章正文非空（`empty-body`）；④ 未映射页（`unmapped-page`）；⑤ 模块树有但没产页（`article-missing`，从 mapping 的 warnings 升级）；⑥ `source_files` 真实存在（`source-missing`，仅当给了 `repoRoot`）；⑦ docs 内相对链接死链（`dead-link`）。`push` 闭包（第 187-190 行）会校验 `kind` 已登记，未登记一律抛错（防自由发挥）。`stats`（第 275-280 行）含 `pages / articles / unmapped / problems` 计数。
- `emptyStats()`（第 284-286 行）：返回全 0 的 stats 兜底。
- 默认导出（第 288 行）：聚合 `OUTPUT_PROBLEM_KINDS, collectOutput, buildWritePlan, validateOutput, bodyLength, relativeLinks`。

### `lib/engine/mapping.js`

**常量**

- `WIKI_ENTRY = 'CodeWiki.md'`（第 30 行）、`WIKI_DIR = '.codewiki'`（第 31 行）、`WIKI_META_REL = '.codewiki/_meta.yaml'`（第 32 行）、`WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'`（第 33 行）、`WIKI_MODULES_REL = '.codewiki/modules'`（第 34 行）。这些是 FSoft docs 树 → cw 落盘位置的唯一映射口径。

**函数**

- `moduleSlug(name)`（第 38-44 行）：模块名 → cw 惯用的 kebab-case 文件名（ASCII 保留，其它折叠成 `-`，小写）。与 cw 现有文章命名一致。
- `normalizeSourceFiles(list)`（第 48-58 行）：去重 + 去 `./` 前缀，作为 `source_files` 规范化。
- `sourceFilesOf(components, componentFiles)`（第 62-72 行）：模块页的 `source_files` 唯一来源——只认组件→文件证据。组件 id 形如 `src/a.py::Class.method`，取 `::` 前文件部分；`componentFiles` 里有则用映射值，否则若含 `::` 取文件部分，否则跳过（宁缺勿造，绝不以目录名猜）。
- `indexModuleTree(moduleTree)`（第 76-96 行）：把 FSoft `{name: {path, components, children}}` 的模块树建立 `name → {name, path, components, hasChildren, artifact, parent}` 的索引，含 `walk` 递归。
- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（第 115-268 行）：**纯函数**格式翻译。对每页：overview 页→入口（重复出现则后到的进 `unmapped`）；非 md→`unmapped`；模块树空（`{}`）时页名不在树里也进写集但 `attribution='unattributed'`、`source_files=[]`；否则按树节点映射为 `articles`（`type:'module'`、`pageKind` 为 `leaf`/`parent`/`artifact`、`moduleName`、`sourceFiles`、`attribution:'attributed'`、`warnings`）。slug 冲突（`A_B` 与 `A-B` 都→`a-b`）两页都进 `unmapped`（不覆盖）。模块树有但没产页→全局 `warnings`（上层升级成 `article-missing`）。返回 `{contractVersion, entry, articles, unmapped, meta:{lastCompiledCommit, layout, language}, updateRecord, warnings}`。
- 默认导出见第 38-268 行引用的各函数（无聚合 default 导出对象，按需具名导出）。

### `lib/engine/contract.js`（被 mapping 引用的契约常量与词表）

- `ENGINE_CONTRACT_VERSION`（第 20 行）：当前契约版本（值 `1`）。`mapFsoftOutput` 的返回里 `contractVersion` 字段即取它。
- `ENGINE_STAGES`（第 24-33 行）、`TERMINAL_OUTCOMES`（第 35 行）、`BLOCKER_KINDS`（第 42-53 行）、`ENGINE_ERROR_CODES`（第 57-67 行）：机读枚举，供面板、终态判定、apply-plan 与 quality-gate 共用。
- `engineResult` / `engineProgress` / `engineError` / `validateEngineResult` / `describeEngineResult`：跨进程结果/进度/错误的纯函数构造与校验（第 97-240 行），本模块不调用，但 `ENGINE_CONTRACT_VERSION` 直接被 mapping 使用。

### 相关消费方（不在本模块但密切协作）

- `lib/engine/quality-gate.js:gateNativeOutput`（第 390 行起）直接调用 `validateOutput` 与 `bodyLength`，把产物自洽判据复用到「采用门」里，并把 `empty-module-tree` 降级成 `degradation`、`unmapped-page`/`article-missing` 升级成 `defect`。
- `renderArticle`（quality-gate.js:316）消费 mapping 产出的 `article` 结构，渲染成带 frontmatter 的完整 wiki 文章。

## Architecture

三组件流水线：collect（output.js）读磁盘 → map（mapping.js）纯翻译 → validate（output.js）判 problems。quality-gate（阶段 3）与 apply-plan（阶段 3/4）在其上叠加采用门与落地。

```text
  FSoft docs/ 树
  (overview.md + *.md + 4 JSON)
        │
        ▼
┌───────────────────────────┐
│ collectOutput  output.js:91 │ 读磁盘，递归收页、读4个JSON
│  → {exists,pages,json,     │ 坏输入变成 problems（不抛）
│     problems}              │
└─────────────┬─────────────┘
              │ {pages,moduleTree,metadata,updateRecord}
              ▼
┌───────────────────────────┐
│ mapFsoftOutput mapping.js:115│ 纯函数：FSoft 文档树 → cw 写集
│  → {entry,articles,        │ 四条硬规则（不臆造/不丢弃/
│     unmapped,meta,warnings} │        不覆盖/不正文）
└─────────────┬─────────────┘
              │ {collected,mapped}
              ▼
┌───────────────────────────┐
│ validateOutput output.js:184 │ 逐条判 problems（自洽性）
│  → {ok,problems,mapped,     │ entry/empty-body/unmapped/
│     collected,stats}        │ article-missing/source-missing/dead-link
└─────────────┬─────────────┘
              │ problems
              ▼
┌───────────────────────────┐
│ gateNativeOutput          │ 复用 validateOutput，分流
│ quality-gate.js:390       │ defect / degradation / stale
└─────────────┬─────────────┘
              │ GateReport
              ▼
┌───────────────────────────┐
│ applyNativeOutput         │ 写盘→cw index→基线→提交
│ apply-plan.js:414         │ 失败按不变量回滚
└───────────────────────────┘
```

`mapFsoftOutput` 是唯一一处格式翻译，刻意窄到能被完整读一遍（见 `lib/engine/mapping.js:115-140` 的硬规则）；`validateOutput` 不重写任何判定，只把 mapping 产出的事实与磁盘事实比对后报机读 problem。两条调用链都只增加「一次目录读」（`buildWritePlan` 在第 162-173 行把 collect 与 map 串起来）。

## Data Flow

输入是 FSoft 原生引擎跑完后落下的 `docs/` 目录（由 `lib/engine/entry.py` 的 `action_generate` 在 `docs_dir` 产出，含 `module_tree.json`、`metadata.json` 等）。数据流经四步：

1. **collect**（`output.js:91`）：`collectOutput` 用 `fs.readdirSync` 读根目录，再用 `listMarkdownPages`（第 44 行，递归、跳过 `temp/` 与 `.` 目录）收集页；`readJsonIfExists`（第 64 行）分别读 `metadata.json`、`module_tree.json`（必需），以及 `first_module_tree.json`、`update_record.json`（可选，`optional:true`）。任何坏/缺都在 `problems` 里登记，函数不抛。

2. **map**（`mapping.js:115`）：`buildWritePlan`（第 162 行）把 `collected.pages` + `collected.json.moduleTree` + `componentFiles` + `metadata` 交给 `mapFsoftOutput`。映射产出：`entry`（overview→CodeWiki.md）、`articles`（模块页→`.codewiki/modules/<slug>.md`，含 `sourceFiles`/`attribution`/`pageKind`）、`unmapped`（无法归属的页带可机读原因）、`meta.lastCompiledCommit`（来自 `metadata.generation_info.commit_id`）、`updateRecord`（原样搬运自 `update_record.json`）。

3. **validate**（`output.js:184`）：`validateOutput` 在 `buildWritePlan` 之上再逐页读正文、比对：正文空→`empty-body`；映射不上→从 `mapped.unmapped` 推 `unmapped-page`；模块树有但没产页→把 mapping 的 `warnings` 升级成 `article-missing`；给 `repoRoot` 时校验 `source_files` 存在性（`source-missing`，第 236-248 行）；docs 内相对链接在计划外→`dead-link`（第 252-265 行，跳过 `../` 仓库源文件链接与 `http` 外链）。`ok = problems.length === 0`。

4. **consume**：`quality-gate.js:gateNativeOutput`（第 400 行）复用同一份 `validateOutput` 结果，再渲染+契约+基线，合成 `GateReport`；其 `rendered` 写集最终由 `apply-plan.js:applyNativeOutput` 落地。

关键不变量（数据层面）：
- 递归收页是必须的——hierarchical 布局把子模块页放在子目录（`doc_layout.py:module_doc_relpath` 的 `posixpath.join(*path[:-1], name.md)`），只扫根会漏整棵子树（`output.js:113-116`、`test-engine-output-real.mjs:6`）。
- whole-repository 模式 `module_tree.json` 是 `{}`（`mapping.js:154` 注释引用 documentation_generator.py:241）：页仍进写集但 `source_files` 空 + `attribution='unattributed'`，`validateOutput` 额外报 `empty-module-tree` 让上层判 partial，绝不臆造或丢弃（`test-engine-output-real.mjs:57`、`output.js:199-207`）。
- mapping 不写磁盘，因此相同输入两次调用结果稳定（`test-engine-output.mjs:206` 验证 `validateOutput` 无隐藏状态）。

## Connections

- [[engine-client]] / [[engine-bridge]]：`lib/engine/client.js` 的 `runEngine`（第 223 行）与 `lib/engine/python/entry.py` 把引擎运行产物（含 `docsDir`）交回 Node 侧，本模块的 `validateOutput`/`collectOutput` 正是消费那个 `docsDir` 的下游。
- [[engine-contract]]：`lib/engine/contract.js` 提供 `ENGINE_CONTRACT_VERSION`（被 `mapFsoftOutput` 第 256 行引用）与 `BLOCKER_KINDS` 词表；quality-gate/apply-plan 把本模块的 problem kind 翻成契约 `BLOCKER_KINDS`。
- [[engine-quality-gate]]：`lib/engine/quality-gate.js` 的 `gateNativeOutput`（第 390 行）直接 `import { validateOutput, bodyLength }`（第 38 行），是本模块最密切的消费者；`renderArticle`（第 316 行）消费 mapping 的 `article` 结构。
- [[engine-apply-plan]]：`lib/engine/apply-plan.js` 的 `applyNativeOutput`（第 414 行）消费 quality-gate 的 `GateReport.rendered`，是写集的最终落地方；其白名单 `APPLY_WRITE_ROOTS`（第 46 行）复用了 mapping 的 `WIKI_DIR`/`WIKI_ENTRY`。
- [[engine-manifest]]：`lib/engine/manifest.js` 负责引擎环境指纹/lock，与本模块同属「阶段 2」，但互不调用（manifest 只 probe 环境）。
- [[article-contract]]：quality-gate 把 mapping 产物渲染后交给 `lib/article-contract.js` 的 `inspectArticle` 做目标格式校验；`bodyLength`/`parseFrontmatter` 被两处共用。
- [[engine-python-entry]]：`lib/engine/python/entry.py` 与 `lib/engine/python/stage_map.py` 是产出 `docs/` 的引擎入口，本模块是它产物的第一道 Node 侧校验。

## Known Issues

- **`dead-link` 判定对无扩展名相对链接保守放行**：`validateOutput` 第 260 行 `if (!hit && !collected.json.metadata && !/\.md$/i.test(resolved)) continue`——当 `metadata.json` 缺失时，指向非 `.md` 的相对链接会被直接跳过而不报问题。这是为兼容仓库源文件链接的妥协，但若引擎产出了指向其它非 md 非源码的相对文件且该链接确实失效，可能在 metadata 缺失时被漏判。
- **`updateRecord.json` 中的 `revision` 字段未映射**：`mapFsoftOutput` 只读取 `outcome`/`pages_written`/`pages_removed`（第 245-253 行），`test-engine-output-real.mjs:124` 验证真实产物里 `updateRecord.revision.new_commit` 存在但 mapping 并未把它带进返回值；增量 base 依赖的 `commit_id` 来自 `metadata.generation_info.commit_id` 而非 update_record。
- **`temp/` 下的 markdown 不被当页，但 `temp/update-record.json` 在 mapping 里被映射成 `WIKI_UPDATE_RECORD_REL`**（`.codewiki/temp/update-record.json`，`mapping.js:33`/`245`）。这是有意为之：工作目录里的 json 要原样搬运，但 `temp/*.md` 是索引/引用中间文件，不算文章（`output.js:42-43`）。读者容易把两者混淆。
- **empty-module-tree 不是致命错**：whole-repository 模式下 `module_tree.json` 为空对象是正常产物（`output.js:199-207`），本模块报 `empty-module-tree` 让上层判 partial，但不阻止写集成立。若调用方忽略 `empty-module-tree` 直接拿 articles 写库，会产出一批**无增量归属证据**的页（`attribution='unattributed'`，`source_files=[]`），下游增量 ownership 不可用。
- **`source-missing` 仅在提供 `repoRoot` 时检查**（`output.js:236`）：不给 `repoRoot` 则跳过 `source_files` 存在性校验（`test-engine-output.mjs:180`）。若上层漏传 `repoRoot`，会放过指向不存在文件的 `source_files`。
- **无已知禁用/注释掉的功能**：本模块 `output.js` 与 `mapping.js` 的全部导出函数均启用，没有注释禁用分支（与 `contract.js` 的 `RETRYABLE_CODES`/`validateEngineResult` 等一并生效）。
