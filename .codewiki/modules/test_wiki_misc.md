---
title: test_wiki_misc
type: module
source_files:
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-prune-orphans.mjs
  - test-semantic-plan.mjs
  - index.js
  - lib/cluster.js
  - lib/symbols.js
tags: [test, wiki, anchors, prune, semantic-plan, entry]
---

## Overview

`test_wiki_misc` 是一组「杂项 wiki 校验/工具」的单测合集，覆盖四块互不隶属但都服务于 `index.js` 编译流水线的能力：

- **行号锚点校验**（`test-wiki-anchors.mjs`）：独立 CLI 脚本，递归扫描 `.codewiki/` 下所有 `.md` 文章，核对其中 `file:NN(-MM)` 行号锚点的真实性。它分「硬断言」与「软报告」两档——结构事实（越界/区间无序）永远硬失败，同步事实（指向空行/符号未绑定/CHANGELOG 版本节）在文档滞后于编译基线时降级为软报告，避免淹没真错误。
- **入口生成与 Windows 路径规范化**（`test-wiki-entry.mjs`）：验证 `ensureWikiEntry`（编译收尾时若仓库根缺 `CodeWiki.md` 则自动生成，人工入口永不覆盖）、`normalizeArticlePath` / `normalizeIndexLinks` / `parseStatus`（cw CLI 输出规范化）。
- **孤儿模块清理边界**（`test-prune-orphans.mjs`）：验证 `pruneOrphanModules` 只在全量编译时删除「规划外且本批未写」的 `modules/*.md`，且绝不误删增量任务成果、非 `modules` 目录、失败文章证据。
- **语义规划端到端**（`test-semantic-plan.mjs`）：验证 `semanticPlan` / `localPlan` / `scanRepoFiles`——AST 符号提取 → LLM 聚类 → 模块清单，以及无模型时降级目录聚类、坏 JSON / 请求抛错时降级而非崩溃。

四个测试文件里只有 `test-wiki-entry.mjs`、`test-prune-orphans.mjs`、`test-semantic-plan.mjs` 从 `./index.js` import 被测函数；`test-wiki-anchors.mjs` 是完全独立的脚本（不 import 任何被测函数，直接 fs 读 `.codewiki/`）。

## Key Components

本模块引用的全部公开函数（均定义于 `index.js`，除非另注明），按被测测试文件分组：

### test-wiki-anchors.mjs（独立脚本，无外部导入）
- 该文件本身不 import 任何被测函数，全部逻辑自包含。关键内部符号：
  - `readSourceFile(rel, {head, ref})`（index.js 测试内定义于 test-wiki-anchors.mjs:57）：读取源文件某一基准视图——工作区版（`readFileSync`）、HEAD 版（`git show HEAD:`）、编译基线版（`git show <ref>:`）；读不到返回 `null`。
  - `compiledCommitForViews`（test-wiki-anchors.mjs:86）：从 `.codewiki/_meta.yaml` 的 `last_compiled_commit` 取编译基线 commit。
  - `loadSource(rel, preferHead)`（test-wiki-anchors.mjs:96）：返回某源文件的「编译基线 ∪ 工作区 ∪ HEAD」三基准视图数组，按全文去重缓存于 `sourceCache`。
  - `isFresh(rel)`（test-wiki-anchors.mjs:135）：逐字比较工作区源码与编译基线版；`--strict` 或相等才算新鲜。
  - `clSectionsOf(src)`（test-wiki-anchors.mjs:157）：解析 CHANGELOG 各版本节起止行。
  - `symbolsOnLine(line)`（test-wiki-anchors.mjs:187）：提取行内反引号代码标识符（带文件名过滤、最小长度过滤）。
  - `judgeAnchor({a, src, syms, allFileAnchors, line, label, srcName})`（test-wiki-anchors.mjs:293）：在单个基准下判定一个锚点，返回 `{ok, msg, kind}`，`kind` 为 `'struct'`（结构事实，永远硬失败）或 `'sync'`（同步事实，滞后可降级）或 `'changelog'`（CHANGELOG 特殊，永远软报告）。
  - `walk(dir)`（test-wiki-anchors.mjs:213）：递归收集 `.codewiki/` 下所有 `.md`。
  - `check(cond, msg)`（test-wiki-anchors.mjs:172）/ `soft(msg)`（test-wiki-anchors.mjs:177）：断言与软报告记账。
  - `describeOk(a, views)`（test-wiki-anchors.mjs:280）：通过时打印是哪个基准解释了该锚点。

### test-wiki-entry.mjs 引用的函数（定义于 index.js）
- `ensureWikiEntry(cwd, language='中文')`（index.js:372）：若 `cwd` 无 `CodeWiki.md` 则生成中文/英文入口（含 `.codewiki` 绝对路径、`codewiki_generate` 收尾指引、不覆盖声明），返回 `true`；已存在返回 `false`；空 `cwd` 返回 `false`。
- `normalizeArticlePath(p)`（index.js:280）：把路径里的 `\` 全部替换为 `/` 返回（Windows 纵深防御）。
- `normalizeIndexLinks(cwd)`（index.js:284）：读 `.codewiki/_index.md`，只把 `[[link|title]]` 链接头内的 `\` 规范化为 `/`；无变化返回 `false`，已改返回 `true`；文件不存在静默返回 `false`。
- `parseStatus(stdout)`（index.js:294）：解析 cw `status` 三态输出，返回 `{state, changedFiles, staleArticles}`；`state` ∈ `missing`/`uncompiled`/`clean`/`stale`；逐行 `M`/`!` 前缀经 `normalizeArticlePath` 规范化。

### test-prune-orphans.mjs 引用的函数（定义于 index.js）
- `pruneOrphanModules(job)`（index.js:342）：清理孤儿模块文章。入参 `job` 需含 `kind`、`plan?.modules`、`wikiPath`、`articles`。返回 `{removed[], failed[], skipped?}`。
  - 仅当 `job.kind === 'full'` 且 `plan.modules` 为非空数组才动手；否则返回 `skipped` 原因（index.js:345、index.js:347）。
  - 规划内文章名按 `slugify(m.name)` + `.md`（index.js:351）；本批 `job.articles` 里出现的（含失败）一并保留（index.js:353）。
  - 只删 `.codewiki/modules/*.md`，删失败的进 `failed[]` 并记账、不中断（index.js:356-365）。
- `slugify(name)`（index.js:1741）：模块名 → 文件名友好 slug（保留 CJK、小写、非词字符转 `-`、空则回落 `'module'`）。`pruneOrphanModules` 用它把规划名映射到文章名，测试用「规划名 → 期望文件名」对照断言（test-prune-orphans.mjs:131）。

### test-semantic-plan.mjs 引用的函数（定义于 index.js）
- `scanRepoFiles(cwd)`（index.js:2192）：递归扫源码，跳过 `SCAN_SKIP_DIRS`（`.git`/`.codewiki`/`node_modules`/`vendor`/`dist`/… 及所有点开头目录，index.js:2179）、`SCAN_SKIP_EXT` 二进制后缀（index.js:2183）、空文件与 >256KB（index.js:2178），总数上限 2000（index.js:2190）。返回 `{path, bytes}[]`。
- `localPlan(files)`（index.js:1371）：按顶层目录分组生成模块清单（每个 `f.path` 取首段作 `slugify` 名），返回 `{project, modules:[{name, summary, files}], concepts:[]}`。project 文案标注「本地规划：按顶层目录分组」。
- `semanticPlan(files, {cwd, llm, provider, model, reasoningEffort, signal, notes})`（index.js:1393）：语义规划主入口。先 `extractRepoGraph` 提组件（不可用时 `fallback=true` 退回 localPlan），再 `resolveImportEdges` 建依赖边，再 `clusterComponents({components, llmCall})` 聚类，最后组装 `{project, modules: toPlanModules(result), concepts, tree, graph, stats}`。返回 `{plan, fallback, result}`；`fallback` 在任一环节失败时为真。

### 被 semanticPlan 间接依赖（定义于 lib/cluster.js）
- `clusterComponents(opts)`（lib/cluster.js:291）：LLM 驱动模块聚类。无 `llmCall` 时走 `heuristicCluster`（lib/cluster.js:219，按顶层目录分组）并记 `stats.fallbacks`。返回 `{modules, tree, concepts, warnings, stats, byId}`。
- `toPlanModules(result)`（lib/cluster.js:460）：把 `clusterComponents` 结果转成 `job.plan.modules` 形状 `{name, summary, files, parent?}`。
- `formatComponents(components)`（lib/cluster.js:28）、`normalizeModuleName(name)`（lib/cluster.js:198）、`fillMissing(modules, components, missingIds)`（lib/cluster.js:247）：提示词表示 / 模块名规范化 / 漏掉组件补回。

### 被 semanticPlan 间接依赖（定义于 lib/symbols.js，index.js:16 导入）
- `extractRepoGraph(filesWithText, {cwd})`（lib/symbols.js，经 index.js:16 引入）：tree-sitter AST 提取全仓库组件图，`{ready, graph, byFile, skipped}`。
- `resolveImportEdges(graph, byFile, textByFile)`（lib/symbols.js，经 index.js:16 引入）：解析 import/require 依赖边。

## Architecture

四组测试各自独立，但被测函数都挂在 `index.js` 的编译流水线之上。语义规划那条链路最长，框图如下（其余三组为单函数单测，不成链）：

```text
                       ┌──────────────────────────────────┐
                       │  test-semantic-plan.mjs          │
                       │  (scanRepoFiles 造仓 → semanticPlan)│
                       └───────────────┬──────────────────┘
                                       │ files: {path,bytes}
                                       ▼
                       ┌──────────────────────────────────┐
                       │  scanRepoFiles (index.js:2192)    │
                       │  黑名单目录/后缀/256KB/2000 上限    │
                       └───────────────┬──────────────────┘
                                       │ filesWithText
                                       ▼
       ┌───────────────────────────────────────────────────────────────┐
       │  semanticPlan (index.js:1393)                                  │
       │   extractRepoGraph ──► resolveImportEdges ──► clusterComponents │
       │   (lib/symbols.js)        (lib/symbols.js)    (lib/cluster.js)  │
       └───────────────┬───────────────────────────────────────────────┘
                       │ graph{tree,components,dependsOn}
                       ▼
       ┌───────────────────────────────────────────────────────────────┐
       │  toPlanModules (lib/cluster.js:460) ──► job.plan.modules        │
       └───────────────────────────────────────────────────────────────┘

   降级路径：extractRepoGraph 不可用 / 坏 JSON / llmCall 抛错
        └──► fallback=true ──► localPlan (index.js:1371) 目录聚类

   其余三组（无链路）：
     test-wiki-entry.mjs   ──► ensureWikiEntry / normalizeArticlePath
                              / normalizeIndexLinks / parseStatus
     test-prune-orphans.mjs ──► pruneOrphanModules ──► slugify (映射名)
     test-wiki-anchors.mjs ──► 独立脚本（fs 读 .codewiki/，三基准对照校验）
```

`pruneOrphanModules` 在生产链路中的位置：`index.js` 的 `tickIndex`（index.js:3602）在 `job.writtenCount > 0` 时调用它（index.js:342），清理模块改名后残留的旧 `modules/*.md`，并把 `removed` / `failed` 写进 job note（index.js:3634-3642）。

## Data Flow

**test-wiki-anchors.mjs 的数据流（最复杂）：**
1. `walk(WIKI)`（test-wiki-anchors.mjs:213）递归收集 `.codewiki/` 全部 `.md`（test-wiki-anchors.mjs:224）。
2. 对每篇文章每行，正则抽出 `file:NN(-MM)` 锚点（test-wiki-anchors.mjs:187），`symbolsOnLine` 抽符号（test-wiki-anchors.mjs:187）。
3. 每个锚点经 `loadSource(srcName)` 拿到「编译基线 ∪ 工作区 ∪ HEAD」三基准视图（test-wiki-anchors.mjs:96）；逐个基准调 `judgeAnchor`（test-wiki-anchors.mjs:293）判定。
4. 结构类失败（`kind:'struct'`，越界/区间无序）永远硬失败；同步类失败（`kind:'sync'`，空行/符号）在 `isFresh(srcName)` 判定滞后时降级软报告（test-wiki-anchors.mjs:269-272）；CHANGELOG 失败（`kind:'changelog'`）永远软报告（test-wiki-anchors.mjs:270）。
5. 末尾汇总 `softReports`（test-wiki-anchors.mjs:396）：列出「文档滞后无法定性」的源文件，提示重跑 `codewiki_generate`。`--strict` 经 `FORCE_STRICT`（test-wiki-anchors.mjs:39）把 `isFresh` 强制为 `true`。

**test-wiki-entry.mjs 的数据流：**
- `ensureWikiEntry(repo, '中文')` 缺文件时生成中文入口（index.js:372-384），断言正文含 `.codewiki` 绝对路径、`codewiki_generate`、`_architecture.md`、不覆盖声明；英文走另一分支（index.js:390-402）；已有入口返回 `false`（index.js:375）；空 `cwd` 返回 `false`（index.js:373）；重复调用幂等（test-wiki-entry.mjs:53）。
- `normalizeArticlePath('learnings\\update-gap.md')` → `learnings/update-gap.md`（index.js:280）；`parseStatus` 解析 `Changed since...` + `Stale articles:` 清单并把 `\` 规范化（test-wiki-entry.mjs:60-62）；`normalizeIndexLinks` 改链接头 `\`→`/`（test-wiki-entry.mjs:65-71），正文反斜杠不受影响。

**test-prune-orphans.mjs 的数据流：**
- `makeWiki()`（test-prune-orphans.mjs:19）造 `modules/`(4 篇) + `concepts/`(1) + 根 `_architecture.md`(1)。
- `pruneOrphanModules({kind, wikiPath, plan, articles})` 删掉 `modules/` 下「规划外且本批未写」的 `.md`；测试逐一断言：全量删孤儿（test-prune-orphans.mjs:33）、保留失败文章（test-prune-orphans.mjs:44）、增量不动（test-prune-orphans.mjs:57、`skipped` 含「非全量」）、空 plan/空 modules 不删（test-prune-orphans.mjs:70、79）、concepts/根文章不碰（test-prune-orphans.mjs:87）、只删 `.md`（test-prune-orphans.mjs:104）、`slugify` 匹配（test-prune-orphans.mjs:115、131）、删除失败记账进 `failed` 且其它照删（test-prune-orphans.mjs:153）。

**test-semantic-plan.mjs 的数据流：**
- `tmp` 造「目录划分 ≠ 职责划分」的仓库（`src/billing` 混 HTTP 路由、`src/api` 混 DB 事务，test-semantic-plan.mjs:20-28），`scanRepoFiles(tmp)` 扫出 6 个源文件（test-semantic-plan.mjs:35）。
- `semanticPlan(scanned, {llm:null,...})` 无模型走 `heuristicCluster` 降级（lib/cluster.js:219），断言 `plan.stats.llm=false`、`project` 含「降级」（test-semantic-plan.mjs:38-50）；有模型走 `fakeLlm` 流式返回聚类 JSON，`normalizeModuleName` 小写化（test-semantic-plan.mjs:71-112）。
- 模型返回坏 JSON / 抛错时不崩溃、累加 `stats.fallbacks`/`fallback=false`（test-semantic-plan.mjs:114-140）；空仓库 `fallback=true`（test-semantic-plan.mjs:175）；`plan.graph` 可序列化、不含 `sourceCode`、序列化体积 <400KB（test-semantic-plan.mjs:151-172）；`localPlan` 同批文件仍可用（test-semantic-plan.mjs:174）。

## Connections

- 生产调用点：`pruneOrphanModules` 由 `tickIndex` 在 full 编译收尾时调用（index.js:3602），`semanticPlan` 由 `buildPlan` 在 full 编译规划阶段调用（index.js:2988-2999，失败退回 `localPlan`），`scanRepoFiles` 同时服务于 `hasCompilableSources`（index.js:478、源码探测门）、`tickArticles` 的本地规划（index.js:3135）、`extractCurrentGraph`（index.js:2220、stale 增量）、`isDeadCompileTarget`（index.js:504）。
- `ensureWikiEntry` 由 `tickIndex` 在写成功文章后调用（index.js:3602），`normalizeIndexLinks` 由 `tickIndex` 在 `cw index` 后调用（index.js:284），`parseStatus` 由 `generateToolDefinition.execute` 在判态时调用（index.js:4011）、`/api/codewiki/repos` 端点调用（index.js:294）。
- 相关模块：[[index]]（编译流水线主模块，所有被测函数定义处）、[[lib-cluster]]（语义聚类，lib/cluster.js）、[[lib-symbols]]（AST 提取与依赖边，lib/symbols.js）、[[test-wiki-entry]] 文中锚点修正同源逻辑见 [[index]] 的 `fixAnchors`/`fixChangelogAnchors`（index.js:780、780）与 `test-wiki-anchors.mjs` 的 `judgeAnchor`/`clSectionsOf` 务必保持规则同源（见 test-wiki-anchors.mjs:157-163）。
- 编排/面板侧：[[codewiki-generate]]（codewiki_generate 工具，触发 `ensureWikiEntry` 与 `pruneOrphanModules` 的流水线）、[[incremental]]（stale 增量复用 `semanticPlan` 产出的 `plan.tree`/`graph` 做组件级变更判定）。

## Known Issues

- **测试与修正器规则必须同源**：`test-wiki-anchors.mjs` 的锚点符号绑定与 CHANGELOG 版本节归属规则，和 `index.js` 的 `fixAnchors`/`fixChangelogAnchors` 是两份独立实现，注释里多次强调改动一处必须同步另一处（test-wiki-anchors.mjs:320-325；index.js:780-782、761-769）。若漂移会出现「修正器认为已对、校验器判错」的死循环——这正是该测试存在的根因之一。
- **多锚点行不做符号绑定校验**：`judgeAnchor` 在「本行锚点唯一」时（test-wiki-anchors.mjs:293）才做符号绑定；多锚点行只由「行号在范围内 + 指向非空行」兜底（test-wiki-anchors.mjs:204-211、356-357）。曾有一个「就近符号」启发式函数被写成死代码从未调用，已删除说明。
- **`pruneOrphanModules` 把非空但残缺的 plan 当全集**：当 `plan.modules` 非空但不完整（目录里还有规划外文章）时，当前实现按非空数组当真全删（test-prune-orphans.mjs:186-195）。这是显式契约——清理器只认非空数组，完整性由编排侧（`buildPlan`/`planUpdate`）保证；若将来给 plan 加 completeness 标志，这条断言需同步改。
- **CHANGELOG 锚点校验永远软报告**：因 CHANGELOG 是追加式流水账，每次发版顶部插节会让历史锚点必然下移，`judgeAnchor` 对 CHANGELOG 的版本节失败一律返回 `kind:'changelog'`，不计入硬失败（test-wiki-anchors.mjs:293-314、270-271）。兜底靠 `## X.Y.Z` 稳定标题与 `fixChangelogAnchors` 落盘前重定位。
- **空仓 `semanticPlan` 返回 `fallback=true`**：`extractRepoGraph` 无组件时（index.js:1393-1396）直接退回 localPlan，语义规划路径不产生任何模块，`plan` 为 `null`；调用方（`buildPlan`）据此降级（index.js:3001-3003）。
