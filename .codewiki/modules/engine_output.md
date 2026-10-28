---
title: engine_output
type: module
source_files:
  - lib/engine/output.js
  - lib/engine/mapping.js
  - test-engine-output.mjs
  - test-engine-output-real.mjs
tags: [engine, fsoft, stage-2, write-plan, validation]
---

## Overview

`engine_output` 是 FSoft 原生引擎迁移的**阶段 2**产物处理层（代码集中在 `lib/engine/output.js`，映射规则在 `lib/engine/mapping.js`）。它位于 Python 引擎已经把 `docs` 目录吐出来之后、落盘成 `.codewiki/` 之前，只做三件事，且每一件都被测试逐条钉死（`test-engine-output.mjs` 28 项断言 + `test-engine-output-real.mjs` 用真实产物钉住两类单测抓不到的缺陷）：

1. **读（read）**：把引擎产出的 `docs` 目录读成结构化事实——页清单（递归 markdown）+ 四个 JSON（`metadata.json` / `module_tree.json` / `first_module_tree.json` / `update_record.json`）。坏文件变成 `problems` 而不是异常（`collectOutput`，`lib/engine/output.js:91`）。
2. **映射（map）**：交给 `lib/engine/mapping.js` 的 `mapFsoftOutput`（`lib/engine/output.js:19` 引入），这里**不重复实现任何规则**——只把 docs 树翻译成 CodeWiki 的写集描述（`entry` / `articles` / `unmapped` / `meta` / `updateRecord`）。
3. **校验（validate）**：把「这次产物能不能算成功」判成可机读的 `problems` 列表（`validateOutput`，`lib/engine/output.js:184`）。

### 安全边界（这是迁移不变量，写下来防止它长成第二个引擎）

- 不重新聚类、不做图 diff、不改写文章正文——FSoft 已经算完了（`lib/engine/output.js:8-12`）。
- 不臆造 `source_files`（沿用 `mapping.js` 的证据规则）。
- 不因为「产物看起来差不多」就把 problem 降级成 warning。缺页就是缺页，上层据此判 `partial`；把缺失静默吞掉会让 wiki 少一篇而没人知道。
- 与阶段 3（frontmatter/锚点/写集冲突闸门，见 `index.js` 的 `contractCheck`）的分界：这里只判「产物自身是否自洽」——页在不在、正文空不空、链接指向的东西在不在计划内。目标格式的闸门属于阶段 3。

### 问题类别枚举

`OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:22-34`）是稳定、可机读的枚举，上层按 `kind` 分派（**不要靠 message 文本匹配**）。共 12 类：

| kind | 含义 |
| --- | --- |
| `missing-docs-dir` | 引擎没产出 docs 目录 |
| `missing-metadata` | 缺 `metadata.json`（无法确定 commit/layout） |
| `missing-module-tree` | 缺 `module_tree.json`（无法确定归属与 source_files） |
| `empty-module-tree` | `module_tree.json` 是 `{}`：归属证据缺失，写集只能算 unattributed |
| `bad-json` | JSON 存在但不可解析 |
| `entry-missing` | 没有 `overview.md`，即没有 `CodeWiki.md` 入口 |
| `empty-body` | 页面除标题外没有正文 |
| `article-missing` | 模块树里有模块，但没有对应页 |
| `unmapped-page` | 页在 docs 里，但映射不到 wiki 的任何位置 |
| `source-missing` | `source_files` 指向的文件在仓库里不存在 |
| `dead-link` | 正文里的相对链接指向计划外的文件 |

## Key Components

### `lib/engine/output.js` 公开导出

所有公开符号同时挂在 `default` 导出对象上（`lib/engine/output.js:284`）。

#### 常量与内部工具

- `OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:22-34`）— `Object.freeze` 的 12 类问题枚举数组（见上方表格）。
- `PROBLEM_SET`（`lib/engine/output.js:36`）— 由 `OUTPUT_PROBLEM_KINDS` 构造的 `Set`，用于 `validateOutput` 里防自由发挥地校验 `kind` 是否登记。
- `posix(p)`（`lib/engine/output.js:38`）— 把路径里反斜杠归一化为 `/`，空值安全。
- `stripBom(s)`（`lib/engine/output.js:39`）— 去掉 UTF-8 BOM（`\uFEFF`），JSON 解析前必过。
- `TEMP_DIR = 'temp'`（`lib/engine/output.js:43`）— `docs/temp/` 是工作文件（依赖图/引用索引/artifact 索引），不算页，递归扫描时跳过。

#### `listMarkdownPages(rootDir, rel='')`（内部，`lib/engine/output.js:44-62`）

递归列出 `docs` 下所有 markdown 页，返回 POSIX 相对路径且已排序。

- 跳过以 `.` 开头的隐藏目录与 `temp` 目录（`lib/engine/output.js:55`）。
- 只收 `.md`/`\.md$/`i 匹配的文件（`lib/engine/output.js:59`）。
- 顶层 `readdirSync` 失败时返回空数组（`lib/engine/output.js:49-51`），不抛——保证「坏输入变 problems」的整体契约。

#### `readJsonIfExists(file, problems, kind, { optional=false })`（内部，`lib/engine/output.js:64-82`）

读一个 JSON 文件，结果归并进 `problems`：

- 文件缺失：仅当 `!optional` 才 `push({ kind })`（全量首轮本来没有 `update_record`，可选文件缺失不是问题，`lib/engine/output.js:69-71`）。
- 存在但坏了（解析失败）：**永远**报 `bad-json`，不因为「文件可选」就吞掉（`lib/engine/output.js:77-81`）。
- 返回解析后的对象或 `null`。

#### `collectOutput({ docsDir })`（`lib/engine/output.js:91-124`）

**只读、不抛**：把 `docs` 目录读成结构化事实。

签名与返回结构：

```js
export function collectOutput({ docsDir } = {})
// 返回 { docsDir, exists, pages:string[], json:{metadata,moduleTree,firstModuleTree,updateRecord}, problems:[] }
```

- `docsDir` 为空 → `push({kind:'missing-docs-dir'})` 并直接返回（`lib/engine/output.js:101-104`）。
- `docsDir` 不可读（如不存在）→ `push({kind:'missing-docs-dir'})` 返回（`lib/engine/output.js:105-111`）。
- `out.json` 四个槽位的读取（`lib/engine/output.js:118-122`）：
  - `metadata` ← `metadata.json`（`missing-metadata`）
  - `moduleTree` ← `module_tree.json`（`missing-module-tree`）
  - `firstModuleTree` ← `first_module_tree.json`（`bad-json`，可选）
  - `updateRecord` ← `update_record.json`（`bad-json`，可选）
- `pages` 用 `listMarkdownPages` **递归**收集（`lib/engine/output.js:116`）——hierarchical 布局把子模块页放在子目录里（`doc_layout.py:module_doc_relpath`），只扫根目录会漏掉整棵子树。

#### `bodyLength(text)`（`lib/engine/output.js:127-137`）

去掉标题行与空白后剩余的正文字符数，用于判「这页其实只有个标题」。

- 用 `stripBom` 去 BOM，按行切（`lib/engine/output.js:128`）。
- 找到首个 `#{1,6} ` 标题后开始算正文（`lib/engine/output.js:132-135`）；正文所有空白压掉后取 `.length`（`lib/engine/output.js:136`）。
- 只有标题 → 返回 `0`（`test-engine-output.mjs:65-70` 断言覆盖）。

#### `relativeLinks(text)`（`lib/engine/output.js:140-152`）

收集页面正文里的相对 markdown 链接目标。

- 正则 `/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g` 抓链接（`lib/engine/output.js:142`）。
- 跳过：空目标、以 `#` 开头的锚点、带协议头的（`http:` / `mailto:` / `data:` 等，`/^[a-z][a-z0-9+.-]*:/i`，`lib/engine/output.js:147-148`）。
- 反斜杠归一化为 `/` 后返回（`lib/engine/output.js:149`）。`test-engine-output.mjs:72-77` 验证它跳过外链/锚点/图片 data URI，只抽相对链接。

#### `buildWritePlan({ docsDir, componentFiles={}, overviewName='overview.md' })`（`lib/engine/output.js:162-173`）

建写集计划：读 `docs` → 交给 `mapping.js`。返回 `{ collected, mapped }`（`lib/engine/output.js:172`）。

- `collected = collectOutput({ docsDir })`（`lib/engine/output.js:163`）。
- `mapped = mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（`lib/engine/output.js:164-171`）——`moduleTree` / `metadata` / `updateRecord` 缺省成 `{}` / `{}` / `undefined`。
- `componentFiles` 是「组件 id → 仓库相对文件」的唯一证据来源，`mapping.js` 用它决定 `source_files`。

#### `validateOutput({ docsDir, repoRoot, componentFiles={}, overviewName='overview.md' })`（`lib/engine/output.js:184-278`）

校验产物自洽性。**不抛、也不修任何东西**，返回 `{ ok, problems, mapped, stats }`。

- `push(kind, detail, extra={})`（`lib/engine/output.js:187-190`）：若 `kind` 不在 `PROBLEM_SET` 里直接抛错（防止自由发挥）。
- 若 `docsDir` 根本不存在（`!collected.exists`）→ 直接返回 `{ ok:false, problems, mapped, stats: emptyStats() }`（`lib/engine/output.js:192-194`）。
- 6 项检查（覆盖完整行号区间）：
  1. **入口**：`!mapped.entry` → `entry-missing`（`lib/engine/output.js:196-197`）。
  2. **空模块树**：`module_tree.json` 是 `{}` 且页数 >1 → `empty-module-tree`（`lib/engine/output.js:199-207`）。这是 whole-repository 模式的可空产物，页是真的但归属证据整体缺失，必须让上层看见（不能算完整成功）。
  3. **每篇正文非空**：逐页读正文，`bodyLength(text)===0` → `empty-body`（带 `source`，`lib/engine/output.js:214-225`）。
  4. **未映射页**：`mapped.unmapped` 每条 → `unmapped-page`（带 `source`，`lib/engine/output.js:228`）。
  5. **模块树有但没产页**：`mapping` 的 `warnings` 里匹配 `未产出` 的 → 升级成 `article-missing`（`lib/engine/output.js:230-233`）。
  6. **source_files 真实存在**：仅当给了 `repoRoot` 才查（`lib/engine/output.js:236`）；对每篇 `article.sourceFiles` 做 `fs.existsSync(path.resolve(repoRoot, rel))`，不存在 → `source-missing`（带 `source`/`target`，`lib/engine/output.js:237-248`）。
- **死链检查**（第 6 项之外的独立循环，`lib/engine/output.js:250-265`）：只查「指向 docs 内相对路径」的链接——目标既不在计划内（`plannedPages`）也不在 docs 页清单里、且以 `.md` 结尾 → `dead-link`（带 `source`/`target`）。指向仓库源文件（`../src/x.py`，`resolved.startsWith('../')`）的交给阶段 3 的 source 校验，这里不查（`lib/engine/output.js:257-258`）；外链不查（`lib/engine/output.js:146` 注释）。
- `ok = problems.length === 0`（`lib/engine/output.js:268`）。
- `stats = { pages, articles, unmapped, problems }`（`lib/engine/output.js:271-276`）。

#### `emptyStats()`（内部，`lib/engine/output.js:280-282`）

返回全 0 的 stats 结构，用于 `docsDir` 缺失早退时。

### `lib/engine/mapping.js` 公开导出（本模块的映射依赖）

`output.js` 通过 `mapFsoftOutput` 把 docs 翻译成写集描述。关键公开符号：

- `WIKI_ENTRY = 'CodeWiki.md'` / `WIKI_DIR = '.codewiki'` / `WIKI_META_REL` / `WIKI_UPDATE_RECORD_REL` / `WIKI_MODULES_REL = '.codewiki/modules'`（`lib/engine/mapping.js:30-34`）— 写集落点常量。
- `moduleSlug(name)`（`lib/engine/mapping.js:38-44`）— 模块名 → kebab-case 文件名。
- `mapFsoftOutput({ pages, moduleTree={}, componentFiles={}, metadata={}, updateRecord=null, overviewName='overview.md' })`（`lib/engine/mapping.js:115-268`）— 纯函数，返回：

```js
{
  contractVersion,         // ENGINE_CONTRACT_VERSION
  entry,                   // { path:'CodeWiki.md', source } | null
  articles,                // [{ source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings }]
  unmapped,                // [{ source, reason }]
  meta,                    // { lastCompiledCommit, layout, language }
  updateRecord,            // { path, outcome, pagesWritten, pagesRemoved, source } | null
  warnings,                // 全局告警（未映射页数 / 缺页等）
}
```

- `articles[].pageKind` ∈ `leaf` / `parent` / `artifact`（`lib/engine/mapping.js:226`）。
- `articles[].attribution` ∈ `attributed` / `unattributed`：空模块树下（whole-repository 模式）页仍进写集但 `sourceFiles=[]`、`attribution='unattributed'`（`lib/engine/mapping.js:177-187`）。
- `source_files` 只认组件→文件证据（`sourceFilesOf`，`lib/engine/mapping.js:62-72`）：组件 id 形如 `src/a.py::Class.method`，取 `::` 前文件部分；`componentFiles` 里没有该组件则不计入（宁缺勿造）。

### 测试文件

- `test-engine-output.mjs`（28 项 `check`）：覆盖 `bodyLength`/`relativeLinks`/`collectOutput`/`buildWritePlan`/`validateOutput` 的每一类 problem，含「两次调用结果稳定（无隐藏状态）」与「未登记的 problem kind 会被拒」。
- `test-engine-output-real.mjs`：用真实 FSoft 产物（`.probe-fsoft/wiki_out_1c/docs`）钉两类单测抓不到的缺陷——hierarchical 嵌套子目录页的收集、whole-repository 模式下 `module_tree={}` 时不丢真页也不臆造 `source_files`。该套测试依赖真实产物路径，缺失时整体 `SKIP`（`test-engine-output-real.mjs:33-36`）。

## Architecture

`engine_output` 是「读 docs → 映射 → 校验」三段纯函数链，组件少但职责边界严格（见 `lib/engine/output.js:1-16` 注释）。框图如下：

```text
┌──────────────────────────────────────────────────────────────┐
│ Python 引擎 (lib/engine/python/entry.py) 吐出 docs/ 目录        │
│   overview.md + *.md + metadata.json + module_tree.json        │
│   + first_module_tree.json(可选) + update_record.json(可选)     │
└───────────────────────────────┬──────────────────────────────┘
                                 │ docsDir
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ collectOutput()                     lib/engine/output.js:91   │
│   读 docs → { pages, json{4}, problems }                       │
│   listMarkdownPages(递归,跳 . /temp)  readJsonIfExists(坏→problem)│
└───────────────────────────────┬──────────────────────────────┘
                                 │ {pages, moduleTree, metadata, updateRecord}
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ mapFsoftOutput()                     lib/engine/mapping.js:115 │
│   docs 树 → 写集描述 { entry, articles, unmapped, meta,         │
│   updateRecord, warnings }  (硬规则：不臆造/不丢弃/不覆盖/不改内容)│
└───────────────────────────────┬──────────────────────────────┘
                                 │ {collected, mapped}  = buildWritePlan()
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ validateOutput()                   lib/engine/output.js:184   │
│   6 项自洽检查 + 死链检查 → { ok, problems, mapped, stats }    │
│   problems[kind] 由 OUTPUT_PROBLEM_KINDS(12 类) 机读分派        │
└───────────────────────────────┬──────────────────────────────┘
                                 │ { ok, problems, mapped, stats }
                                 ▼
                    上层终态判定 (partial / done / failed)
                    repoRoot 仅此处用于 source_files 存在性检查
```

要点：

- `buildWritePlan` 只是把 `collectOutput` 与 `mapFsoftOutput` 串起来的薄壳（`lib/engine/output.js:162-173`）。
- `validateOutput` 在 `buildWritePlan` 之上再叠加 6 项自洽检查 + 死链检查，`ok` 仅由 `problems.length === 0` 决定（`lib/engine/output.js:162`），**不修任何东西**也不抛。
- `repoRoot` 是 `validateOutput` 的可选入参，不给则跳过 `source_files` 存在性检查（阶段 2 本身可选，交给阶段 3，`lib/engine/output.js:180` 注释、`test-engine-output.mjs:180-189`）。

## Data Flow

以一次「正常全量产物」为例，数据如何流经本模块（`test-engine-output.mjs:31-56` 造的 fixture）：

1. **入口**：上层拿到 `docsDir`（FSoft 通过 `entry.py` 的 `_done_result` 把 `docsDir` 写进 `EngineResult.artifacts.docsDir`，`lib/engine/python/entry.py:467-471`）后调用 `validateOutput({ docsDir, repoRoot, componentFiles })`。
2. **收集**：`collectOutput` 递归扫出 `pages = ['Core.md','Web.md','overview.md']`，读四个 JSON；`metadata.generation_info.commit_id` / `layout` 被取出，缺件/坏件进 `problems`。
3. **映射**：`mapFsoftOutput` 把 `overview.md` → `entry{path:'CodeWiki.md'}`，把 `Core.md`/`Web.md` 按 `module_tree` 命中各节点 → `articles[].wikiPath = '.codewiki/modules/<slug>.md'`、`type:'module'`、`sourceFiles` 由 `componentFiles` + `module_tree.components` 决定；`meta.lastCompiledCommit` 取自 `metadata.commit_id`（`lib/engine/mapping.js:261`）。
4. **校验**：`validateOutput` 对每页算 `bodyLength`、对 `mapped.unmapped`/`warnings` 升级 problem、对 `source_files` 做 `fs.existsSync` 校验、对正文相对链接算死链。`ok=true` 时 `stats = { pages:3, articles:2, unmapped:0, problems:0 }`（`test-engine-output.mjs:121-132`）。
5. **出口**：`{ ok, problems, mapped, stats }` 交给上层（JobService / 终态判定），`problems` 的 `kind` 被机读分派成 `partial` 的 `blockers` 或 `failed` 的 `error`（`contract.js` 的 `BLOCKER_KINDS` 含 `unmapped-page`/`article-missing` 等）。

两类真实产物才暴露的流向分支（见 `test-engine-output-real.mjs`）：

- **hierarchical 嵌套**：页在 `docs/core/engine.md` 子目录，`listMarkdownPages` 必须递归收进 `pages`，否则整棵子树漏掉（`test-engine-output-real.mjs:97-114`）。
- **whole-repository 空模块树**：`module_tree.json === {}` 时，`mapFsoftOutput` 仍把页推进 `articles` 但 `sourceFiles=[]`/`attribution='unattributed'`；`validateOutput` 额外报 `empty-module-tree`，使 `ok=false` 让上层判 `partial`（`test-engine-output-real.mjs:57-84`）。

## Connections

- [[engine-contract]] — `engine_output` 的上游契约层：`entry.py` 把 `docsDir` 写进 `EngineResult.artifacts`，`BLOCKER_KINDS`（`lib/engine/contract.js:42-53`）的 `unmapped-page`/`article-missing` 与本模块的 `problems` 一一对应；`ENGINE_ERROR_CODES` 含 `engine-output`（产物缺失或不可解析）。
- [[engine-client]] — 进程/协议薄适配层（`lib/engine/client.js`），负责把 FSoft 进程跑完、归一成 `EngineResult`；产物落盘与映射不在这里做（`lib/engine/client.js:11` 注释）。
- [[engine-mapping]]（即 `lib/engine/mapping.js`）— 本模块的映射依赖，FSoft 产物 → CodeWiki 写集的四条硬规则全在这（`lib/engine/mapping.js:16-26`）。
- [[engine-manifest]] — 阶段 1A 锁定引擎环境（指纹/lock），与本模块无直接调用但同属阶段 0–2 的引擎迁移套件。
- [[engine-python-entry]]（即 `lib/engine/python/entry.py`）— FSoft 原生入口，吐出 `docsDir` 与 `update_record` 落点，是本模块的输入来源。
- [[article-contract]] — 阶段 3 的目标格式闸门（`index.js` 的 `contractCheck`/`inspectArticle`）：本模块只判产物自洽，frontmatter/锚点/写集冲突闸门在它之后。
- [[engine-llm-bridge]] / [[engine-openai-bridge]] — 阶段 1B 宿主模型桥，与产物读取正交，但同属本次迁移的引擎适配层。

## Known Issues

- **`validateOutput` 不修任何东西**：它只报 `problems`，缺页/空壳页/死链都不会被本模块修复；修复或降级决策完全交给上层终态判定（这是有意为之，见 `lib/engine/output.js:184-192` 安全边界）。
- **`repoRoot` 缺失时 `source_files` 校验被跳过**：阶段 2 把 `source_files` 存在性检查设为可选（`lib/engine/output.js:180`、`test-engine-output.mjs:180-189`）。若上层忘记传 `repoRoot`，伪造的 `source_files` 不会被本模块抓出——真正的存在性闸门落在阶段 3 的 `article-contract.js`（`inspectArticle` 的 `source_files 真实存在` 检查，`CHANGELOG.md:25`）。
- **死链检查只查 docs 内相对 `.md` 链接**：指向仓库源文件（`../src/x.py`）或 `metadata` 缺失时的非 `.md` 目标，会被显式放行（`lib/engine/output.js:257-261`），这些情况交阶段 3 处理，不在本模块职责内。
- **`metadata` 缺失时不阻断但降级**：`collectOutput` 只把 `missing-metadata` 记进 `problems`，`validateOutput` 仍会跑完其余检查（`lib/engine/output.js:184`）；没有 `metadata` 意味着 `meta.lastCompiledCommit` 为空（增量基线来源缺失），上层据此能判 `partial`。
- **真实产物测试不可移植**：`test-engine-output-real.mjs` 硬编码了 `E:/ik/Documents/trae_projects/1/dsh plugin/.probe-fsoft/wiki_out_1c/docs`（Windows 绝对路径，`test-engine-output-real.mjs:32-37`），其它机器上整套 `SKIP`，所以真实缺陷的回归保障只在那台机器上有效。
