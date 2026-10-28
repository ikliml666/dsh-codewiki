---
title: engine_quality_mapping
type: module
source_files:
  - lib/engine/quality-gate.js
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/contract.js
  - lib/article-contract.js
  - lib/update-record.js
  - lib/engine/python/stage_map.py
  - lib/engine/python/entry.py
  - test-engine-quality-gate.mjs
  - test-engine-contract.mjs
  - test-engine-python-entry.mjs
tags: [engine, quality-gate, mapping, stage-map, fsoft-native, output]
---

## Overview

本模块覆盖迁移「FSoft 原生引擎 + 薄适配层」方案里三段相关的纯逻辑/格式翻译职责，它们的共同点是：**都不重新实现 FSoft 的算法**，只负责把引擎产物接进 CodeWiki 的模型并判它能不能用。三段分别为：

1. **采用门（quality gate，阶段 3）** — `lib/engine/quality-gate.js`。引擎把 docs 树交回来、写进 `.codewiki/` 与 `CodeWiki.md` 之前，把「产物自洽 + 目标格式契约 + 基线可推进性」合成一个可机读裁决。这是 0.14.0「1 篇成功 + 19 篇失败也报 done」缺陷的直接修复：终态严格（三类问题皆空才是 `done`），但把问题分成 `defect` / `degradation` / `stale` 三类，分别指明「谁来修、修什么」（见 `quality-gate.js:15-33` 的长注释）。

2. **产物→wiki 映射（mapping，阶段 0）** — `lib/engine/mapping.js`。迁移里唯一一处「格式翻译」：`mapFsoftOutput` 把 FSoft 的 docs 树（overview.md + 模块页 + module_tree.json + metadata.json + update_record.json）翻译成 cw 的写集描述（入口页 `CodeWiki.md` + `.codewiki/modules/<slug>.md` + `_meta.yaml` 证据 + `temp/update-record.json`）。四条硬规则钉在文件头（`mapping.js:115-125`）：不臆造 source_files、不静默丢弃、不覆盖、不改技术内容。

3. **阶段映射（stage mapping）** — `lib/engine/python/stage_map.py`。FSoft 的 `ProgressTracker` 只有五段进度，而契约 `ENGINE_STAGES`（`contract.js:24-33`）是八段；`stage_map.py` 把五段翻成八段、把阶段内进度算成整体百分数并夹到 90% 上限，让面板步骤条与 Node 侧共享同一枚举口径（见 `stage_map.py:1-17`）。

三者都被独立的测试文件逐条钉死：`test-engine-quality-gate.mjs`、`test-engine-contract.mjs`（映射）、`test-engine-python-entry.mjs`（阶段映射）。采用门本身是纯组合：读产物复用 `lib/engine/output.js` 的 `validateOutput`（不重写任何判定），渲染复用 `lib/article-contract.js` 的 `inspectArticle`，基线用 `git` 只读助手，落盘判定靠 `lib/update-record.js` 的 `judgeOutcome`。

## Key Components

### lib/engine/quality-gate.js — 阶段 3 采用门

文件头（`quality-gate.js:1-33`）定义了模块的存在理由：三类问题必须机读分开（`defect` 产品缺陷 / `degradation` 能力降级 / `stale` wiki 状态陈旧），否则要么引擎被归咎于不是它的问题，要么 wiki 的陈旧被当成产品缺陷（两者都会让运维在错处找原因）。

**常量（全部 `Object.freeze`，稳定可机读，消费者按 kind 分派；新增只允许追加）：**

- `GATE_VERSION` — `export const GATE_VERSION = 1`（`quality-gate.js:42`）。
- `GATE_DEFECT_KINDS`（`quality-gate.js:45-59`）— 缺陷类别表，含 13 类：`missing-docs-dir`、`missing-metadata`、`missing-module-tree`、`bad-json`、`entry-missing`、`empty-body`、`article-missing`、`unmapped-page`、`source-missing`、`dead-link`、`article-contract`、`commit-mismatch`、`uncommitted-input`。配套 `DEFECT_SET`（`quality-gate.js:74`）。
- `GATE_DEGRADATION_KINDS`（`quality-gate.js:61-66`）— 降级类别表 4 类：`empty-module-tree`、`no-source-evidence`、`missing-section`、`empty-section-optional`。配套 `DEGRADATION_SET`（`quality-gate.js:75`）。
- `GATE_STALE_KINDS`（`quality-gate.js:68-72`）— 陈旧类别表 3 类：`baseline-behind-head`、`baseline-uncommitted`、`baseline-absent`。配套 `STALE_SET`（`quality-gate.js:76`）。
- `NATIVE_REQUIRED_SECTIONS = Object.freeze([])`（`quality-gate.js:80`）— 原生通道不沿用 agentic 通道的 `Overview`/`Key Components` 章节要求，避免用别的通道章节名去判不能手改的正文（会退化成噪声）；非空二级标题由 `checkRendered` 单独判（见下）。

**辅助/私有函数：**

- `git(repoRoot, args, {timeout})`（`quality-gate.js:90-102`）— 仅读的 `execFileSync('git', …)` 包装，失败返回 `null`（不抛）。
- `parseMetaCommit(text)`（`quality-gate.js:104-107`）— 用正则 `^last_compiled_commit:\s*(\S+)\s*$` 从 `_meta.yaml` 文本里取 commit。
- `SHA_RE = /^[0-9a-f]{40}$/i`（`quality-gate.js:109`）— 40 位 sha 校验。
- `oneLine(s)`（`quality-gate.js:248-250`）— 把换行压成单空格并 trim，供 `titleOf` 用。

**公开函数（按职责）：**

- `readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })`（`quality-gate.js:117-151`）— 读**已提交**的编译基线：用 `git show HEAD:<rel>`（不是工作区文件）取 `last_compiled_commit`（`quality-gate.js:126`）。返回 `{ ok, source, commit, worktreeCommit, dirty, reason }`：
  - `source: 'git-head'` 且 `ok: true`（HEAD 里有且能解析）；工作区值与 HEAD 不一致则 `dirty: true`（`quality-gate.js:131-138`）。
  - 工作区有、HEAD 没有 → `source: 'worktree-only'`、`ok: false`、`dirty: true`（绝不能当作已提交基线，`quality-gate.js:140-148`）。
  - 都不存在 → `source: 'absent'`、`reason: '首次编译'`（`quality-gate.js:149-150`）。
  - 为什么不能用工作区：自动提交是插件侧异步做的，存在「已写入、未提交」窗口，把它当基线等于把未提交产物宣布成已消化（`quality-gate.js:111-116`）。

- `uncommittedSourceChanges({ repoRoot })`（`quality-gate.js:158-174`）— 用 `git status --porcelain --untracked-files=all` 取未提交改动；`WIKI_PATHS = ['.codewiki/', 'CodeWiki.md']`（`quality-gate.js:156`）内的改动不算（那正是本轮要写的东西）。返回 `{ ok, paths, reason }`。

- `assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput = true })`（`quality-gate.js:188-244`）— 判「这批产物的基线能不能推进」。读 `git rev-parse HEAD` 得 `headCommit`，必要时现读 `readCommittedBaseline`。分支：
  - `requireCommittedInput = false` → 直接 `{ ok: true, writable: true }`（`quality-gate.js:196-198`）。
  - 否则：缺 `repoRoot`/`headCommit` 或 `artifactCommit` 非 40 位 sha、或对不上 `headCommit` → 推 `commit-mismatch` defect（`quality-gate.js:200-214`）；用 `uncommittedSourceChanges` 发现源码改动 → 推 `uncommitted-input` defect（`quality-gate.js:215-223`）。
  - 基线陈旧（报告不归咎引擎）：`baseline-absent` / `baseline-uncommitted` / `baseline-behind-head`，分别对应 `source: 'absent'`、未入库或与工作区不一致、commit 落后 HEAD（`quality-gate.js:227-238`）。
  - 终态：`blockingStale` 只取 `baseline-uncommitted`，`ok = defects.length === 0 && blockingStale.length === 0`（`quality-gate.js:241-243`）。注意 `writable` 恒为 `true`：基线只决定「能不能推进」，不影响「能不能写」。

- `yamlScalar(value)`（`quality-gate.js:269-288`）— YAML 标量的安全序列化。只在确实不安全时才加双引号（用 `JSON.stringify`，因为 JSON 字符串是合法 YAML 双引号标量）。判据：`YAML_UNSAFE_HEAD`（`quality-gate.js:264`）、`YAML_RESERVED`（`quality-gate.js:266`，含 `true/false/yes/no/~` 等）、`YAML_NUMBER`（`quality-gate.js:267`）、首尾空格、控制字符、反斜杠、`': '` 或结尾 `:`、`' #'`、开头 `#`。安全值保持裸写（如 `title: change_set`）。测试钉死危险值往返一致（`test-engine-quality-gate.mjs:338-371`）。

- `titleOf(bodyText, fallback)`（`quality-gate.js:291-297`）— 取正文第一个 H1 作为 frontmatter `title`，提不到用 `fallback`（模块名）。

- `renderArticle({ article, body })`（`quality-gate.js:316-340`）— 把映射出的一篇文章渲染成完整 wiki 文本（合成 frontmatter + FSoft 原文）。三条硬约束：①正文一字不动（含不删 H1、不改链接）；②frontmatter 只填有证据的字段（`source_files` 原样来自映射，空就显式写 `source_files: []`，`quality-gate.js:326-329`，省略会被误读为「没声明」）；③可回溯（`fsoft_page` 记原始页）。`---` 结束标记后**不插空行**，避免 `parseFrontmatter` 把空行算进 body 破坏「逐字比对」（`quality-gate.js:334-338`）。

- `checkRendered({ content, article, cwd, fsoftPage })`（`quality-gate.js:346-373`）— 渲染后逐篇检查：先走 `inspectArticle`（复用，传 `requiredSections: NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles: true`、`fsImpl: null`、`readableSources: null`、`allowedLinks: null`，`quality-gate.js:347-360`），再补一条原生通道专属判据——剥掉自己合成的 frontmatter 后 `bodyLength(pageBody) === 0` 才判 `empty-body` error（`quality-gate.js:362-372`）。这是为兜住「只有标题的空壳页」：`bodyLength` 只跳第一个标题行、`inspectArticle` 判 `body.trim()`，两条路都会放过空壳页（`quality-gate.js:362-365`）。

- `gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput, includeContent })`（`quality-gate.js:390-568`）— **主入口**，纯组合：
  1. `validateOutput`（`output.js`）读产物 → `collected`/`mapped`（`quality-gate.js:400-401`）。
  2. 把 `validation.problems` 分流到 defect / degradation：`empty-module-tree`→degradation，其余已在 `DEFECT_SET` 的按 kind 推 defect，未知类别一律当 `article-contract` 报出来逼补映射（`quality-gate.js:418-437`）。
  3. 入口页：无 overview 则 `entry = null` → 整批不可入库；读不了或空正文或围栏未闭合 → `entry-missing`/`empty-body`/`article-contract` defect（`quality-gate.js:440-462`）。
  4. 逐篇渲染 + 契约：error 级 issue → `article-contract` defect，warning 级 → `missing-section`/`empty-section-optional` degradation（`quality-gate.js:464-495`）；空 `source_files` → `no-source-evidence` degradation（页照写，归属不可用，`quality-gate.js:497-501`）；`action = pageDefects.length ? 'skip' : 'write'`（`quality-gate.js:510`）。
  5. 基线：`assessBaseline`，把它的 `defects` 并入、`stale` 留作单独数组（`quality-gate.js:517-523`）。
  6. 终态合成（严格，三类皆空才 `done`）：`writable = Boolean(entry && entry.ok)`；`blocking = defects + degradations + stale.baseline-uncommitted`；`outcome = failed / partial / done`（`quality-gate.js:525-536`）。
  返回 GateReport：`{ version, ok, outcome, writable, canAdvanceBaseline, entry, articles, rendered, defects, degradations, stale, blockers, counts, baseline }`，其中 `counts` 含 `pages/articles/writable/skipped/unmapped/defects/degradations/stale`（`quality-gate.js:538-567`），`canAdvanceBaseline = outcome === 'done'`（`quality-gate.js:544`）。

- `toContractBlockers(report)`（`quality-gate.js:589-596`）— 把 gate 的 `blockers` 翻成 `contract.js` 的 `BLOCKER_KINDS`，靠 `TO_CONTRACT_KIND` 映射表（`quality-gate.js:572-587`，对应不上一律归 `'quality-gate'`），detail 保留原 kind（格式 `[kind/scope] detail`，`quality-gate.js:570`）。

- `toQualityIssues(report)`（`quality-gate.js:610-624`）— 把 gate 结论翻成 `update-record` 的 `qualityIssues`（`judgeOutcome` 的输入）。遍历 `degradations`/`defects` 全量，加只 `baseline-uncommitted` 这一条 `stale`（其余陈旧如 `baseline-behind-head` 不进，否则每次增量都落 partial，`quality-gate.js:618-622`）。为什么必须有这条：否则 `judgeOutcome` 只看「写成了没有」会把空 source_files 页判成 done 并推进基线（`test-engine-quality-gate.mjs:211-224`）。

- `default` 导出（`quality-gate.js:626-639`）— 汇总上述全部公开符号。

### lib/engine/mapping.js — 阶段 0 格式翻译

文件头（`mapping.js:1-26`）把「FSoft docs 树」与「cw 五类文章 + CodeWiki.md」两套模型讲清，并列出四条硬规则：①不臆造 source_files；②不静默丢弃（未映射页进 `unmapped` 带原因）；③不覆盖（slug 冲突两页都进 `unmapped`）；④不改技术内容（只搬路径与类型，正文一字不动）。

**常量（路径常量，供消费方直接引用）：**

- `WIKI_ENTRY = 'CodeWiki.md'`（`mapping.js:30`）
- `WIKI_DIR = '.codewiki'`（`mapping.js:31`）
- `WIKI_META_REL = '.codewiki/_meta.yaml'`（`mapping.js:32`）
- `WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'`（`mapping.js:33`）
- `WIKI_MODULES_REL = '.codewiki/modules'`（`mapping.js:34`）

**辅助函数：**

- `moduleSlug(name)`（`mapping.js:38-44`）— 模块名 → cw 惯用 kebab-case：ASCII 保留，其它非字母数字折叠成 `-`，去首尾 `-` 转小写。测试见 `test-engine-contract.mjs:189-194`。
- `posix(p)`（`mapping.js:46`）— 反斜杠统一成正斜杠。
- `normalizeSourceFiles(list)`（`mapping.js:48-58`）— 去重、去空、去 `./` 前缀。
- `sourceFilesOf(components, componentFiles)`（`mapping.js:62-72`）— 模块页的 source_files 只认组件→文件证据：组件 id 形如 `src/a.py::Class.method`，取 `::` 前文件部分；`componentFiles` 里没有该组件则跳过（宁缺勿造）。
- `indexModuleTree(moduleTree)`（`mapping.js:76-96`）— 把 FSoft `{name: {path, components, children}}` 的模块树走平成一个 `byName: Map<name, node>`；节点含 `path`/`components`/`hasChildren`/`artifact`（`node.artifact` 或名匹配 `/^artifacts?$/i`）/`parent`。

**公开函数：**

- `mapFsoftOutput({ pages, moduleTree, componentFiles, metadata, updateRecord, overviewName })`（`mapping.js:115-268`）— 纯函数（不读写文件、不 spawn），把 docs 树映射成 cw 写集描述。逐页处理（`mapping.js:135-232`）：
  - `overview.md` → `entry = { path: WIKI_ENTRY, source }`，重复则进 `unmapped`（`mapping.js:136-144`）。
  - 非 `.md` → `unmapped`（非文章，`mapping.js:148-151`）。
  - 页名不在模块树且树为空（whole-repository 模式，`module_tree.json === {}`，`mapping.js:153-188`）→ 进写集但 `sourceFiles: []`、`attribution: 'unattributed'`、带 warning（硬给 source_files 才是错，丢页更错）。
  - 页名不在模块树 → `unmapped`（`mapping.js:189-192`）。
  - slug 冲突（A_B 与 A-B 都 → a-b）→ 两页都进 `unmapped` 并互相剔除（`mapping.js:194-211`）。
  - 正常 → `articles.push({ source, wikiPath, type:'module', pageKind, moduleName, sourceFiles, attribution, warnings })`，`pageKind = node.artifact ? 'artifact' : (node.hasChildren ? 'parent' : 'leaf')`（`mapping.js:222-231`）。
  - 树里有但没产出页的模块 → `warnings.push`（`mapping.js:235-242`）。
  - `updateRecord` 对象 → `record = { path: WIKI_UPDATE_RECORD_REL, outcome, pagesWritten, pagesRemoved, source: 'incremental' }`（`mapping.js:244-253`）。
  - 返回 `{ contractVersion: ENGINE_CONTRACT_VERSION, entry, articles, unmapped, meta: {lastCompiledCommit, layout, language}, updateRecord, warnings }`（`mapping.js:255-267`）。
  测试逐一钉死：overview→CodeWiki.md（`test-engine-contract.mjs:196-212`）、parent 页（`214-235`）、source_files 只来自真实证据（`237-258`）、unmapped 不静默丢弃（`260-271`）、artifact 页（`273-290`）、slug 冲突（`292-305`）、update_record 搬运（`307-327`）、空页可序列化（`329-334`）。

### lib/engine/python/stage_map.py — FSoft 五段 → 引擎八段契约映射

文件头（`stage_map.py:1-17`）说明这是 Node 与 Python 唯一共享的枚举口径：`ENGINE_STAGES`（八段，面板步骤条 / `job.stage` / 取消检查点共用，见 `contract.js:24-33`）vs FSoft `ProgressTracker` 五段。两边一旦漂移，表现是「面板显示在写作，实际已在校验」。映射由 `test-engine-python-entry.mjs:236-247` 反向对账集合一致。注意 FSoft 只覆盖八段前四段（`env` 归 doctor，`index/baseline/commit` 归 Node 侧），故进度上限压到 90%（`stage_map.py:12-16`）。

**常量/映射表：**

- `ENGINE_STAGES`（`stage_map.py:20-29`）— 与 `contract.js` 完全一致的八段列表。
- `FSOFT_STAGE_NAMES`（`stage_map.py:33-39`）— FSoft 五段名镜像：1 Dependency Analysis、2 Module Clustering、3 Documentation Generation、4 HTML Generation、5 Finalization。
- `FSOFT_STAGE_WEIGHTS`（`stage_map.py:40-46`）— 五段权重：1→0.40、2→0.20、3→0.30、4→0.05、5→0.05（与 FSoft 一致，避免进度条在阶段交界处跳变）。
- `FSOFT_TO_ENGINE`（`stage_map.py:50-56`）— 五段→四段：1→graph、2→cluster、3→articles、4→validate、5→validate（HTML 与 finalization 都属「收口」，报成 articles 会让面板一直显示写作，`stage_map.py:48-49`）。
- `DEFAULT_ENGINE_STAGE = "articles"`（`stage_map.py:60`）— 未知阶段不抛错，归到 articles（耗时最长、最需让用户看见的阶段）。
- `FSOFT_PROGRESS_CEILING = 90`（`stage_map.py:63`）— 引擎内部进度只到 90%。

**函数：**

- `map_stage(fsoft_stage)`（`stage_map.py:66-72`）— FSoft 阶段号 → 引擎契约阶段名；`int()` 失败或映射缺失都归 `DEFAULT_ENGINE_STAGE`。
- `percent_of(fsoft_stage, stage_progress)`（`stage_map.py:75-97`）— FSoft `(阶段号, 阶段内进度 0..1)` → 整体百分数 0..90。算法与 FSoft `ProgressTracker.get_overall_progress` 同构（已完成阶段权重之和 + 当前阶段权重×进度），多乘 `CEILING` 并夹到 `[0,100]`，非法输入夹紧。`range(1, n)` 即已完成阶段的权重和（`stage_map.py:94`）。

**使用方** — `lib/engine/python/entry.py` 的 `bridge_progress(adapter, request_id, on_stage)`（`entry.py:281-332`）把 `map_stage`/`percent_of` 注入 FSoft 的 `ProgressTracker` 三个方法（替换而非继承，因为 tracker 无注入点，`entry.py:284-287`），每到达一个引擎阶段回调 `on_stage`，让 done 结果里的 `stage` 是实测值而非写死（`entry.py:301-328`、`414-417`）。`emit_progress`（`entry.py:115-128`）把映射后的 `stage`/`percent` 推成协议行。

### 被复用的依赖模块（网关、契约、落盘判定）

采用门与映射不重写任何判定，而是复用以下模块（行号均来自实际读取）：

- `lib/engine/output.js`（阶段 2）— 采用门的上游事实来源。
  - `OUTPUT_PROBLEM_KINDS`（`output.js:22-34`）— 11 类问题，含 `empty-module-tree`、`source-missing`、`dead-link` 等，注意 `empty-module-tree` 在 gate 里被重新分类为 degradation。
  - `collectOutput({ docsDir })`（`output.js:91-124`）— 只读不抛，递归扫 markdown 页（`listMarkdownPages`，跳过 `temp/` 与点目录，`output.js:44-62`），读 `metadata.json`/`module_tree.json`/`first_module_tree.json`(可选)/`update_record.json`(可选)。坏文件变 problem 不抛。
  - `bodyLength(text)`（`output.js:127-137`）— 去标题行与空白后正文字符数，判「这页其实只有个标题」。
  - `relativeLinks(text)`（`output.js:140-152`）— 收集正文相对 markdown 链接目标（跳外链/锚点/data URI）。
  - `buildWritePlan({ docsDir, componentFiles, overviewName })`（`output.js:162-173`）— `collectOutput` + `mapFsoftOutput`，返回 `{ collected, mapped }`。
  - `validateOutput({ docsDir, repoRoot, componentFiles, overviewName })`（`output.js:184-282`）— 校验产物自洽：入口缺失、空模块树、空正文、未映射页、模块树缺页、`source-missing`（需 `repoRoot`）、`dead-link`。返回 `{ ok, problems, mapped, collected, stats }`，且**原样带出 `collected`**（gate 要读 `metadata.generation_info.commit_id`，避免二次读目录漂移，`output.js:271-274`）。

- `lib/engine/contract.js`（阶段 0 契约）—
  - `ENGINE_STAGES`（`contract.js:24-33`）、`TERMINAL_OUTCOMES`（`contract.js:35`）。
  - `BLOCKER_KINDS`（`contract.js:42-53`）— 10 类阻塞原因（`toContractBlockers` 据此把 gate 的 blocker 归一）。
  - `engineResult`（`contract.js:97-147`，硬不变量：`done` 不许带 blockers、`partial` 必须带、`failed` 必须带 error）、`describeEngineResult`（`contract.js:223-240`）。

- `lib/article-contract.js`（文章契约闸门）—
  - `REQUIRED_SECTIONS`（`article-contract.js:36-45`，native 通道不沿用）、`REQUIRED_FIELDS = ['title','type','source_files']`（`article-contract.js:56`）、`SEVERITY`（`article-contract.js:56-73`，error/warning 分级）。
  - `parseFrontmatter(content)`（`article-contract.js:77-90`）— 只认文首第一个 `---` 块，返回 `{ fields, body, endLine, closed, raw }`。`parseYamlLite`（`article-contract.js:94-118`）、`unquote`（`article-contract.js:120-135`，双引号标量优先 `JSON.parse`）是其内部支撑。
  - `fencesBalanced(body)`（`article-contract.js:161-164`）— 围栏是否成对（gate 入口页专用）。
  - `inspectArticle(content, opts)`（`article-contract.js:213-335`）— 主入口，判 frontmatter/字段/type/`source_files`/正文/围栏/章节/内部链接；`requiredSections = null` 时回退默认表，`allowEmptySourceFiles` 默认 false（native whole-repository 通道显式开 true，`article-contract.js:225-231`）。

- `lib/update-record.js`（落盘判定）—
  - `judgeOutcome({ plan, results, options })`（`update-record.js:37-128`）— 由逐篇结果与计划算 `done/partial/failed`；`options.qualityIssues` 会变成 `quality` 级 blocker（`update-record.js:100-102`）。这正是 `toQualityIssues` 要喂进去的原因，否则空 source_files 页被判 done（`test-engine-quality-gate.mjs:211-224`）。
  - `buildUpdateRecord`（`update-record.js:131-211`）、`saveUpdateRecord`（`update-record.js:217-227`）、`describeOutcome`（`update-record.js:241-253`）。

## Architecture

采用门是纯组合层：它不持有状态，把上游 `output.js` 的事实、下游 `article-contract.js` / `contract.js` / `update-record.js` 的判定、以及 `stage_map.py` 的进度翻译串起来。框图如下（框内标注文件/函数）：

```text
              FSoft docs 树 (.codewiki/wiki_out/…)
                         │
                         ▼
   ┌─────────────────────────────────────────────┐
   │ lib/engine/output.js                          │
   │  collectOutput → buildWritePlan              │
   │  → validateOutput  → {collected, mapped,     │
   │                       problems}               │
   └───────────────────────┬─────────────────────┘
                            │ collected/mapped/problems
              ┌─────────────┴──────────────┐
              ▼                            ▼
   ┌──────────────────────┐   ┌─────────────────────────────────┐
   │ lib/engine/mapping.js│   │ lib/engine/quality-gate.js        │
   │  mapFsoftOutput      │   │  gateNativeOutput (主入口)        │
   │  (FSoft→cw 写集描述)  │   │   1. problems → defect/degr      │
   └──────────────────────┘   │   2. entry 校验                  │
            │ wikiPath/type/   │   3. renderArticle → inspectArticle│
            │ pageKind/source  │   4. no-source-evidence degrad.  │
            │                  │   5. assessBaseline (git 只读)   │
            └──────┬───────────│   6. 终态合成 done/partial/failed │
                   │           └──────────────┬──────────────────┘
                   │ 每篇 article              │ GateReport
                   ▼                           ▼
   ┌───────────────────────────┐   ┌─────────────────────────────────┐
   │ lib/article-contract.js    │   │ renderArticle → yamlScalar       │
   │  inspectArticle (复用语)   │   │  titleOf / checkRendered         │
   │  parseFrontmatter/         │   └──────────────┬──────────────────┘
   │  fencesBalanced            │                  │ toContractBlockers →
   └───────────────────────────┘                  │  contract.js BLOCKER_KINDS
                                                   │ toQualityIssues →
                                                   │  update-record.js judgeOutcome
   FSoft 五段进度 ──► lib/engine/python/stage_map.py
                    map_stage / percent_of (→90%)
                    ▲ 被 entry.py bridge_progress 注入 ProgressTracker
```

关系说明：
- `gateNativeOutput` 通过 `validateOutput` 间接调用 `mapFsoftOutput`，因此「映射」与「采用门」是同一读路径的上下游，不是两套独立读取。
- `renderArticle` + `checkRendered` 把映射出的每篇 `article` 与 FSoft 原文翻译成可落盘文本并复用 `inspectArticle`（native 通道传 `requiredSections: []`、`allowEmptySourceFiles: true`）。
- `assessBaseline` 用 `git` 只读助手（不 spawn 写），与 `readCommittedBaseline` / `uncommittedSourceChanges` 同源。
- `stage_map.py` 与 JS 侧不共享运行时，只在测试中双向对账 `ENGINE_STAGES` 集合一致（`test-engine-python-entry.mjs:236-247`）。

## Data Flow

完整一次采用裁决的数据流（以 `gateNativeOutput` 主入口为线索）：

1. **读产物（只读、不抛）** — `collectOutput({ docsDir })`（`output.js:91-124`）递归扫 markdown 页、读四个 JSON（坏文件变 problem）。`buildWritePlan`（`output.js:162-173`）调 `mapFsoftOutput`（`mapping.js:115-268`）得到 `{ collected, mapped }`；`mapped` 含 `entry`/`articles`/`unmapped`/`meta`/`updateRecord`/`warnings`，`articles` 每篇带 `wikiPath`/`type`/`pageKind`/`moduleName`/`sourceFiles`/`attribution`。`validateOutput` 额外产出 `problems` 数组（`output.js:184-282`），并把 `collected` 原样带出供 gate 读 `metadata.generation_info.commit_id`。

2. **问题分流** — gate 遍历 `validation.problems`（`quality-gate.js:418-437`）：`empty-module-tree` 映射成 `degradation`（whole-repository 模式正常产物，属证据缺失），`article-missing`/`unmapped-page` 映射成 defect，其余已在 `DEFECT_SET` 的按 kind 推 defect，未知类别一律当 `article-contract` 报出（逼补映射，绝不静默吞）。

3. **入口与逐篇渲染** — 无 overview → `entry=null`、整批 `writable=false`（`quality-gate.js:316-318`）；入口可读则 `fs.readFileSync` 取正文，空正文/围栏未闭合推 defect（`quality-gate.js:444-462`）。每篇 article：`fs.readFileSync` 读原文 → `renderArticle` 合成 frontmatter+原文（`quality-gate.js:316-340`）→ `checkRendered` 复用 `inspectArticle` 并补空壳页判据（`quality-gate.js:346-373`）。error 级 issue → `article-contract` defect，warning 级 → `missing-section`/`empty-section-optional` degradation；空 `source_files` → `no-source-evidence` degradation；`action = pageDefects.length ? 'skip' : 'write'`（`quality-gate.js:346`）。`includeContent && 无 defect` 的页进 `rendered`（`quality-gate.js:514`）。

4. **基线裁决（git 只读）** — `assessBaseline({ repoRoot, artifactCommit: collected.json.metadata.generation_info.commit_id, requireCommittedInput })`（`quality-gate.js:518-521`）调 `readCommittedBaseline`（用 `git show HEAD:_meta.yaml`，`quality-gate.js:117`）与 `uncommittedSourceChanges`（用 `git status --porcelain`，`quality-gate.js:158`）。产出 `defects`（`commit-mismatch`/`uncommitted-input`）与 `stale`（`baseline-behind-head`/`baseline-uncommitted`/`baseline-absent`），只有 `baseline-uncommitted` 阻塞推进（`quality-gate.js:241-242`）。

5. **终态合成** — `writable = Boolean(entry && entry.ok)`；`blocking = defects + degradations + stale.baseline-uncommitted`（`quality-gate.js:527-531`）；`outcome = !writable ? 'failed' : blocking.length ? 'partial' : 'done'`（`quality-gate.js:533-536`）；`canAdvanceBaseline = outcome === 'done'`（`quality-gate.js:544`）。返回 GateReport（`quality-gate.js:538-567`）。

6. **下游两路接线** — `toContractBlockers(report)`（`quality-gate.js:589-596`）按 `TO_CONTRACT_KIND`（`quality-gate.js:572-587`）翻成 `contract.js` 的 `BLOCKER_KINDS`；`toQualityIssues(report)`（`quality-gate.js:610-624`）翻成 `update-record.js` 的 `qualityIssues`，喂给 `judgeOutcome`（`update-record.js:100-102`）——这是防止「空 source_files 页被判 done 并推进基线」的关键桥接点（`test-engine-quality-gate.mjs:211-224`）。

7. **进度旁路（独立流）** — FSoft 的 `ProgressTracker` 五段进度经 `entry.py bridge_progress`（`entry.py:281-332`）调 `stage_map.map_stage`/`percent_of`（`stage_map.py:66-97`）翻成八段契约、`percent` 夹到 90%，以协议行推给 `client.js`，与上面的采用裁决数据流互不耦合。

## Connections

- [[engine_contract]] — `contract.js` 定义 `ENGINE_STAGES` / `BLOCKER_KINDS` / `engineResult` 不变量；`stage_map.py` 的 `ENGINE_STAGES` 必须与它逐元素一致（双向对账测试 `test-engine-python-entry.mjs:236-247`）；`toContractBlockers` 把 gate 的 blocker 归一到 `BLOCKER_KINDS`。
- [[engine_output]] — `output.js` 是采用门的上游事实来源：`gateNativeOutput` 通过 `validateOutput` 间接调用 `mapping.js` 的 `mapFsoftOutput`；`empty-module-tree` 在 output 是 problem、在 gate 被重分类为 degradation。
- [[article_contract]] — `article-contract.js` 的 `inspectArticle`/`parseFrontmatter`/`fencesBalanced` 被 `checkRendered`/`renderArticle` directly 复用；native 通道显式传 `requiredSections: []` 与 `allowEmptySourceFiles: true` 以避开 agentic 通道的章节要求。
- [[update_record]] — `update-record.js` 的 `judgeOutcome` 是阶段 4 落盘判定；`toQualityIssues` 显式把 gate 的 degradation/`baseline-uncommitted` 喂进去，防止空 source_files 页被判 done 并推进基线。
- [[engine_client]] — `client.js` 是 Node↔Python 跨语言边界，消费 `stage_map` 翻译出的八段 `progress` 协议行；`entry.py` 的 `bridge_progress` 负责注入映射。
- [[engine_python_entry]] — `entry.py` 是薄入口，把 FSoft 五段进度经 `stage_map` 翻成契约阶段，并把终态翻成 `EngineResult` 语义。

## Known Issues

- **空 source_files 的盲区（设计上必须显式桥接）** — `judgeOutcome`（`update-record.js:37-39`）只看「计划内文章写成了没有」，会把「可写但 source_files 为空」的页判成 `done` 并推进基线。`gateNativeOutput` 已把它算成 `no-source-evidence` degradation 并计入 `blocking`/`canAdvanceBaseline`，但阶段 4 接线若走 `judgeOutcome` 那条路，必须调 `toQualityIssues(report)` 显式喂入，否则两侧判定一个严一个松（`quality-gate.js:598-624`、`test-engine-quality-gate.mjs:211-224`）。
- **工作区基线不可当已提交基线** — `readCommittedBaseline` 必须用 `git show HEAD:.codewiki/_meta.yaml` 而非工作区文件：自动提交是异步的，存在「已写入、未提交」窗口，误用会让未提交产物被宣布成「已消化」（下次编译 base 指向不存在状态，`quality-gate.js:117-122`）。当前实现已规避：HEAD 里没有而工作区有的 `_meta.yaml` → `source: 'worktree-only'`、`ok: false`（`quality-gate.js:140-148`）。
- **原生通道的章节要求差异** — 若把 agentic 通道的 `Overview`/`Key Components` 章节名强加给 FSoft 正文，每条都是不可修复的 warning，真实产物永远 partial（闸门退化成噪声）。因此 `NATIVE_REQUIRED_SECTIONS = []`（`quality-gate.js:80`），非空二级标题改由 `checkRendered` 的 `bodyLength` 判据兜住（`quality-gate.js:362-372`）。
- **`base` 被二次读取的轻微冗余** — `gateNativeOutput` 在 `baseline` 未传入时，先在 `assessBaseline` 内 `readCommittedBaseline` 一次，又在返回值 `baseline.source` 处 `readCommittedBaseline` 第二次（`quality-gate.js:562-566`、`565`）。逻辑正确（`baseline` 已传入时不会二次读），但若调用方不传 `baseline` 会有一次重复 git 读——属于已知的小冗余，不是缺陷。
- **whole-repository 模式下的 unattributed 页** — `module_tree.json === {}` 时所有真产物页进写集但 `sourceFiles: []`、`attribution: 'unattributed'`，会被判 `partial` 且 `canAdvanceBaseline: false`（增量归属不可用）。这是诚实记录而非缺陷，但运维若期望整体 done 需理解这是模式固有限制（`mapping.js:153-188`、`test-engine-quality-gate.mjs:197-209`）。

