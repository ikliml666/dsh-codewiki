---
title: engine_output_quality
type: module
source_files:
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/mapping.js
  - lib/article-contract.js
  - lib/engine/contract.js
  - lib/update-record.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
  - lib/engine/native-state.js
  - test-engine-output.mjs
  - test-engine-quality-gate.mjs
tags: [engine, quality-gate, validation, fsoft, native-channel, output-collection]
---

## Overview

本模块负责「引擎把 docs 树交回来之后、写进 `.codewiki/` 与 `CodeWiki.md` 之前」这一拦截带的两件事：把 FSoft 产物**收集并校验自洽性**（阶段 2，`lib/engine/output.js`），再用**采用门**判定这批产物能不能被 wiki 真正采用（阶段 3，`lib/engine/quality-gate.js`）。它是 0.14.0「1 篇成功 + 19 篇失败也报 done」缺陷的直接修复层。

两层职责边界（写死在 `output.js` 文件头 `lib/engine/output.js:1-16`）：

- 阶段 2 `output.js`：只判「产物自身是否自洽」——页在不在、正文空不空、链接指向的东西在不在计划内、source_files 指的文件在不在仓库里。它**不重写任何正文、不重新聚类、不补章节、不臆造 source_files**。
- 阶段 3 `quality-gate.js`：把三件更高层的事合成一个可机读裁决（`lib/engine/quality-gate.js:1-33`）——① 复用 `output.js` 的 `validateOutput` 判产物自洽；② 把映射结果渲染成真实 wiki 文章再走 `article-contract.js` 的 `inspectArticle` 判**目标格式契约**；③ 判**基线可推进性**（`readCommittedBaseline` / `assessBaseline`）：产物对应 commit 必须是已提交的 HEAD，且 `.codewiki/_meta.yaml` 的基线本身已入库。

模块存在的一个核心理由（quality-gate.js:15-33）：把问题分成三类，而不是塞进一个 `blockers` 数组——

- `defect`（产品缺陷）：本次引擎产物自身的问题，处置是不让它算完整成功；
- `degradation`（能力降级）：产物可用但证据不足（whole-repository 模式空 module_tree → 页没有归属与 source_files；有页映射不进 wiki），处置是可入库但**递增 ownership 不可信、不得推进基线**；
- `stale`（wiki 状态陈旧）：不是本次产物的错（既有基线落后 HEAD、基线只在工作区未提交），处置是如实报告，只有「基线未入库」这一条会阻止推进。

终态仍然严格：**只有三类皆空才是 `done`**（quality-gate.js:32-33、525-536）。分类改变的是「谁来修、修什么」的定位，不是放宽闸门。

## Key Components

### 文件 `lib/engine/output.js`（阶段 2：收集 + 校验）

导出常量与函数：

- `OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:23-35`）：冻结数组，列举阶段 2 能报出的问题 `kind`（稳定、可机读，上层按 kind 分派而非 message）。包含 `missing-docs-dir` / `missing-metadata` / `missing-module-tree` / `empty-module-tree` / `bad-json` / `entry-missing` / `empty-body` / `article-missing` / `unmapped-page` / `source-missing` / `dead-link` 共 11 类。
- `PROBLEM_SET`（`lib/engine/output.js:37`）：`OUTPUT_PROBLEM_KINDS` 的集合视图，用于 `validateOutput` 里校验 kind 是否登记。
- 模块级常量/辅助（`lib/engine/output.js:39-82`）：
  - `stripBom(s)`（39）：去 BOM；
  - `TEMP_DIR = 'temp'`（43）：跳过的工作目录名；
  - `listMarkdownPages(rootDir, rel)`（44-62）：递归收集 docs 下所有 markdown 页（已排序），跳过 `.` 开头目录与 `temp/`；
  - `readJsonIfExists(file, problems, kind, opts)`（64-82）：读 JSON，`optional:true` 时缺失不报（全量首轮本来没 `update_record`）、存在但坏了永远报 `bad-json`。
- `collectOutput({ docsDir })`（`lib/engine/output.js:91-124`）：**只读、不抛**。读 docs 目录产出结构化事实 `{ docsDir, exists, pages, json, problems }`。`json` 含 `metadata` / `moduleTree` / `firstModuleTree` / `updateRecord` 四个字段（`firstModuleTree`、`updateRecord` 为可选）。坏输入变成 problems 而非异常。
- `bodyLength(text)`（`lib/engine/output.js:127-137`）：去掉首个标题行与空白后的正文字符数，用于判「这页其实只有个标题」。
- `relativeLinks(text)`（`lib/engine/output.js:140-152`）：收集正文里的相对 markdown 链接目标，跳过外链（`http:`/`mailto:`/`data:` 等）、锚点与图片 data URI。
- `buildWritePlan({ docsDir, componentFiles, overviewName })`（`lib/engine/output.js:162-173`）：读 docs（先 `collectOutput`）后交给 `mapFsoftOutput`（阶段 0 映射），返回 `{ collected, mapped }`。
- `validateOutput({ docsDir, repoRoot, componentFiles, overviewName })`（`lib/engine/output.js:184-282`）：**不抛、不修**。先 `buildWritePlan`，再逐条追加 problems：
  1. 入口缺失（197）→ `entry-missing`；
  2. 空 module_tree 但有 >1 页（199-207）→ `empty-module-tree`（注意：这是 whole-repository 模式正常产物，但归属证据整体缺失）；
  3. 每篇页正文为空（209-225）→ `empty-body`（用 `bodyLength`）；
  4. 未映射页（227-228）→ `unmapped-page`；
  5. mapping 的 warnings 含「未产出」的（230-233）→ `article-missing`；
  6. `repoRoot` 给定时，source_files 指向不存在文件（235-248）→ `source-missing`；
  7. docs 内相对死链（250-265）→ `dead-link`。
  返回 `{ ok, problems, mapped, collected, stats }`，其中 `collected` 原样带出供阶段 3 读 `metadata.generation_info.commit_id`（271-273）。
- `emptyStats()`（`lib/engine/output.js:284-286`）：返回零统计。
- `default`（288）：聚合导出上述符号。

### 文件 `lib/engine/quality-gate.js`（阶段 3：采用门）

导出常量与函数：

- `GATE_VERSION = 1`（`lib/engine/quality-gate.js:43`）：gate 报告版本。
- `GATE_DEFECT_KINDS`（`lib/engine/quality-gate.js:46-60`）：冻结数组，13 类产品缺陷 kind（含 `commit-mismatch` / `uncommitted-input` 等阶段 3 特有项）。
- `GATE_DEGRADATION_KINDS`（`lib/engine/quality-gate.js:62-67`）：冻结数组，4 类能力降级 kind：`empty-module-tree` / `no-source-evidence` / `missing-section` / `empty-section-optional`。
- `GATE_STALE_KINDS`（`lib/engine/quality-gate.js:69-73`）：冻结数组，3 类陈旧 kind：`baseline-behind-head` / `baseline-uncommitted` / `baseline-absent`。
- `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET`（75-77）：上述三类的集合视图。
- `NATIVE_REQUIRED_SECTIONS = []`（85）：原生通道不沿用 agentic 通道的 Overview/Key Components 章节名，只查结构（见 quality-gate.js:79-85 注释）。
- git 只读助手（89-101）：
  - `git(repoRoot, args, opts)`（89-101）：`execFileSync('git', ...)` 失败返回 `null`；
  - `parseMetaCommit(text)`（103-106）：从 `_meta.yaml` 文本取 `last_compiled_commit`；
  - `SHA_RE` / `readCommittedBaseline({ repoRoot, relPath })`（108, 116-150）：读**已提交**基线 `git show HEAD:.codewiki/_meta.yaml`（不用工作区文件），返回 `{ ok, source, commit, worktreeCommit, dirty, reason }`，`source ∈ git-head | worktree-only | absent`；
  - `WIKI_PATHS`（155）：`['.codewiki/', 'CodeWiki.md']`，工作区未提交改动排除这两项；
  - `uncommittedSourceChanges({ repoRoot })`（157-173）：解析 `git status --porcelain --untracked-files=all`，排除 wiki 自身产物，返回 `{ ok, paths, reason }`。
- `assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput })`（`lib/engine/quality-gate.js:187-243`）：判「这批产物的基线能不能被推进」。校验 `commit_id` 是 40 位 sha 且等于 `git rev-parse HEAD`（206-213）、工作区无未提交源码改动（214-222）；陈旧只报告不归咎；只有 `baseline-uncommitted` 这一条阻止推进（240-242）。返回 `{ ok, headCommit, artifactCommit, defects, stale, writable }`。
- 渲染助手（247-249 等）：
  - `oneLine(s)`（247-249）；
  - `yamlScalar(value)`（268-287）：YAML 标量安全序列化，只在确实不安全时才加双引号（用 `JSON.stringify` 保证合法 YAML 双引号标量、可被逐字反解）；
  - `titleOf(bodyText, fallback)`（290-296）：从正文提 H1 作为 frontmatter title，提不到用模块名；
  - `renderArticle({ article, body })`（315-339）：把映射出的一篇合成完整 wiki 文本（合成的 frontmatter + FSoft 原文），**正文一字不动**，`source_files` 空列表显式写成 `[]`，带 `fsoft_page` 可追溯，`---` 后不插空行；
  - `checkRendered({ content, article, cwd, fsoftPage })`（345-372）：先 `inspectArticle`（用 `NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles:true`），再补原生通道专属判据「至少一个非空二级标题」（用剥头后的 `bodyLength` 兜底空壳页）。
- 主入口 `gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput, includeContent })`（`lib/engine/quality-gate.js:389-567`）：组合读产物 → 渲染 → 契约 → 基线，产出 `GateReport`。内部把 `validateOutput` 的 problems 分流成 `defects` / `degradations`（417-436），逐篇渲染+契约（466-514），接基线（516-522），合成终态（525-536）：`!writable → failed`；否则 `blocking.length → partial`；否则 `done`。返回 `{ version, ok, outcome, writable, canAdvanceBaseline, entry, articles, rendered, defects, degradations, stale, blockers, counts, baseline }`。
- 转换器（571-586 等）：
  - `TO_CONTRACT_KIND`（571-586）：gate blocker kind → `contract.js` 的 `BLOCKER_KINDS` 映射表；
  - `toContractBlockers(report)`（588-595）：把关卡的 blockers 翻成契约 blockers（kind 不在映射表则归 `'quality-gate'`）；
  - `toQualityIssues(report)`（609-623）：把 gate 结论翻成 `update-record` 的 `qualityIssues`（judgeOutcome 输入），含 degradations + defects + 仅 `baseline-uncommitted` 陈旧。
- `default`（625-638）：聚合导出。

### 依赖：被复用的模块（本模块不重复实现）

- `mapFsoftOutput`（阶段 0，`lib/engine/mapping.js:114-266`）：纯函数映射 FSoft 树 → cw 写集；产出 `{ entry, articles, unmapped, meta, updateRecord, warnings }`，`articles[]` 每项含 `{ source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings }`。硬规则见 mapping.js:16-26（不臆造 source_files / 不静默丢弃 / 不覆盖 / 不改技术内容）。
- `inspectArticle` / `parseFrontmatter` / `fencesBalanced`（阶段 3 文章契约，`lib/article-contract.js:161`、77、161）：用于目标格式闸门。`SEVERITY` 分级（article-contract.js:56-73）区分 `error`（拒写）与 `warning`（放行但记账）。
- `BLOCKER_KINDS` / `engineResult`（契约与终态，`lib/engine/contract.js:116`、116）：gate 的 blockers 必须翻成已登记 kind，native-run 用 `engineResult` 兜底不变量。
- `judgeOutcome`（终态判定，`lib/update-record.js:37`）：`toQualityIssues` 专为喂它而设，防止空 source_files 的页被它误判 done。

## Architecture

阶段 2（output.js）与阶段 3（quality-gate.js）是一条直线上的两道闸；quality-gate 复用 output 的结论，不再重写任何判定。

```text
┌──────────────────────────────────────────────────────────────────────┐
│  FSoft engine docs 树 (overview.md + *.md + metadata/module_tree/...) │
└───────────────┬──────────────────────────────────────────────────────┘
                │ docsDir
                ▼
┌──────────────────────────────┐
│ output.js: collectOutput      │ 只读、不抛
│  • listMarkdownPages          │ pages[] + json{metadata,moduleTree,
│  • readJsonIfExists           │   firstModuleTree,updateRecord}
└───────────────┬──────────────┘ problems[] (OUTPUT_PROBLEM_KINDS)
                │ {collected, mapped}
                ▼
┌──────────────────────────────┐   mapping.js: mapFsoftOutput (阶段0)
│ output.js: buildWritePlan     │   → {entry, articles[], unmapped[]}
└───────────────┬──────────────┘
                │
                ▼
┌──────────────────────────────┐
│ output.js: validateOutput     │ 产物自身自洽：入口/正文/链接/
│  (阶段2终态: ok / problems)   │ source_files存在性
└───────────────┬──────────────┘
                │ 复用 (不重写)
                ▼
┌──────────────────────────────┐
│ quality-gate.js: gateNativeOutput  (阶段3)
│  ├─ 分流 validateOutput.problems → defects / degradations
│  ├─ renderArticle 每篇 → checkRendered (article-contract inspectArticle)
│  ├─ assessBaseline: readCommittedBaseline + uncommittedSourceChanges
│  └─ 合成 GateReport: outcome∈{done,partial,failed}
└───────────────┬──────────────┘
                │ GateReport.articles / rendered / blockers
                ▼
┌──────────────────────────────┐
│ native-run.js: runNativeJob   │ toContractBlockers → engineResult
│  + apply-plan.js (落地)       │ done ⟺ 三类皆空 ⟺ 可推进基线
└──────────────────────────────┘
```

辅助数据：阶段 3 的 `renderArticle`（quality-gate.js:322）独立渲染每篇，供 `article-contract.js` 的 `inspectArticle`（article-contract.js:213）检验**目标格式**；`assessBaseline`（quality-gate.js:188）调 `readCommittedBaseline`（116）读已提交基线、`uncommittedSourceChanges`（157）查脏。

## Data Flow

一次完整采用裁决的数据走向（以 `gateNativeOutput` 为入口，`lib/engine/quality-gate.js:389-567`）：

1. **读产物**：`validateOutput({ docsDir, repoRoot, componentFiles })`（quality-gate.js:399）→ 内部 `buildWritePlan` → `collectOutput` + `mapFsoftOutput`（mapping.js），得到 `{ collected, mapped }`。`collected.pages` 是递归收集的 markdown 页（output.js:116），`mapped` 含 `entry` / `articles[]` / `unmapped[]`。
2. **分流问题**：遍历 `validation.problems`，按 kind 映射到 `defects` 或 `degradations`（quality-gate.js:417-436）。关键映射：`empty-module-tree` → `degradation`（页真、并非产物坏）；`article-missing` / `unmapped-page` → `defect`；未登记 kind → 转成 `article-contract` defect（迫使补映射，435-436）。
3. **入口校验**：读 `mapped.entry.source` 正文，判 `bodyLength === 0` → `empty-body` defect，判 `fencesBalanced` → 未闭合则 `article-contract` defect（quality-gate.js:439-461）。`entry.ok` 决定整体 `writable`。
4. **逐篇渲染 + 契约**：对每篇 `mapped.articles`：`renderArticle({ article, body })` 合成 wiki 文本（quality-gate.js:322）→ `checkRendered` 调 `inspectArticle`（article-contract.js:213，用 `NATIVE_REQUIRED_SECTIONS=[]`、`allowEmptySourceFiles:true`）→ 把 `error` 级 issue 记成 `defect`、warning 级（缺章节/空章节）记成 `degradation`（480-494）。空 `sourceFiles` 额外记 `no-source-evidence` degradation（496-500）。每篇产出 `articles[]` 项 `{ source, wikiPath, type, action:'write'|'skip', defects, degradations }`，无缺陷的进 `rendered[]`（513）。
5. **基线裁决**：从 `collected.json.metadata.generation_info.commit_id` 取 `treeCommit`（quality-gate.js:526）→ `assessBaseline({ repoRoot, artifactCommit: treeCommit })`（518）调 `readCommittedBaseline`（116）读已提交 `_meta.yaml`、`uncommittedSourceChanges`（157）查脏，产出 `defects` + `stale`。
6. **合成终态**（quality-gate.js:525-536）：
   - `writable = Boolean(entry && entry.ok)`；
   - `blocking = [...defects, ...degradations, 仅 baseline-uncommitted 的 stale]`；
   - `outcome = !writable ? 'failed' : (blocking.length ? 'partial' : 'done')`；
   - `canAdvanceBaseline = outcome === 'done'`，`ok = outcome === 'done'`。
7. **出口转换**：`toContractBlockers(report)`（588）把关卡 blockers 翻成 `contract.js` 的 `BLOCKER_KINDS`，供 `native-run.js:90` 合入终态；`toQualityIssues(report)`（609）翻成 `update-record` 的 `qualityIssues`，供 `judgeOutcome`（update-record.js:37）判定——这条专门防止空 source_files 的页被 `judgeOutcome` 误判 done 并推进基线（见 test-engine-quality-gate.mjs:211-224）。

下游消费：`native-run.js:135` 调 `gateImpl`（即 `gateNativeOutput`），把 `report.outcome` 与 apply 结果按最弱终态合成（native-run.js:146 交 `applyNativeOutput`），并经 `engineResult`（contract.js:116）强制 `done` 不带 blockers 不变量。

## Connections

- [[engine_native_run]]（`lib/engine/native-run.js`）：阶段 4 编排，在 `runNativeJob` 里于 native-run.js:114 调用 `gateNativeOutput`，把 gate 结论与 apply 结果合成严格终态（734-783），并经 `toContractBlockers` 注入 `engineResult`。
- [[engine_mapping]]（`lib/engine/mapping.js`）：阶段 0 映射，本模块的 `buildWritePlan` 调 `mapFsoftOutput` 把 FSoft 树翻成写集；硬规则（不臆造 source_files / 不静默丢弃 / 不覆盖）被本模块直接沿用。
- [[article_contract]]（`lib/article-contract.js`）：阶段 3 的「目标格式闸门」复用 `inspectArticle` / `parseFrontmatter` / `fencesBalanced`，本模块用 `NATIVE_REQUIRED_SECTIONS=[]` 与 `allowEmptySourceFiles:true` 适配原生通道。
- [[engine_contract]]（`lib/engine/contract.js`）：`BLOCKER_KINDS` / `engineResult` 是 gate 出口的契约目标；`toContractBlockers` 的映射表必须落在 `BLOCKER_KINDS` 内（test-engine-quality-gate.mjs:397-408 断言）。
- [[update_record]]（`lib/update-record.js`）：`judgeOutcome` 是阶段 4 终态判定的另一条路径；`toQualityIssues` 专为把 gate 的 degradation 喂进去而设，保证两条路径判定口径一致（不一个严一个松）。
- [[engine_apply_plan]]（`lib/engine/apply-plan.js`）：gate 的 `GateReport`（`articles` / `rendered` / `entry` / `outcome`）是落地器的输入；native-run.js:146 把 `report` 交给 `applyNativeOutput`，且 `advanceBaseline: null`（基线只由裁决决定，partial 不推进）。
- [[engine_native_state]]（`lib/engine/native-state.js`）：`assessBaseline` 读的 `readCommittedBaseline` 与受管状态共同决定增量能否推进；未提交改动由 native-state 的 `unconsumed` 携带，不被基线前移洗掉。

## Known Issues

本模块没有功能性「禁用」代码（没有 `disabled` 分支或注释掉的判定）；下列是源码中明确写下的**职责边界与有意为之的弱判定**，调用方必须知晓，否则会误判终态：

- **阶段 2 的 `source_files` 存在性检查是可选的**：只在传入 `repoRoot` 时才查（output.js:236-248）。不传 `repoRoot` 时 `source-missing` 不会产生——这是「阶段 2 可选」的设计，但意味着单纯调 `validateOutput` 而不给 `repoRoot` 会漏掉编造来源（测试 test-engine-output.mjs:180-189 专门覆盖）。
- **死链只查 docs 内相对链接**：`validateOutput` 的死链判定（output.js:184-199）只查指向 docs 内的相对 `.md`，明确**不查 `http` 外链**（网络不是本层责任，251），并跳过 `../` 开头的仓库源文件链接（258，交给阶段 3 的 source 校验）。链接到非 markdown 且无 metadata 的情况也会被放过（260）。
- **`relativeLinks` 跳过外链/锚点/data URI**（output.js:140-142）：`http:`/`mailto:`/`data:` 与 `#anchor` 不计为相对链接，因此不会误报外链为死链。
- **原生通道不强制 Overview/Key Components 章节**：`NATIVE_REQUIRED_SECTIONS = []`（quality-gate.js:352）刻意不沿用 agentic 通道章节名，否则原生正文（FSoft 自定章节体系）会因「不改技术内容」硬约束被判成不可修复 warning，使真实产物永远 partial。代之以 `checkRendered` 的「至少一个非空二级标题」兜空壳页（quality-gate.js:345-372）。
- **`renderArticle` 的 `---` 结束标记后不插空行**（quality-gate.js:322-326）：为了「正文一字不动」可被逐字比对，frontmatter 紧接正文。这是为满足 `parseFrontmatter` 行为而做的格式约定，不是疏忽。
- **`empty-module-tree` 在 output.js 是 problem、在 gate 里是 degradation**（quality-gate.js:417-421）：whole-repository 模式下 FSoft 把 module_tree 留成 `{}` 是正常产物，页照写但增量归属不可用、基线不得推进。若 `output.js` 未来新增问题类别，gate 会在 435-436 把它兜底成 `article-contract` defect 并**抛错式暴露**（测试 test-engine-quality-gate.mjs:185-193 守住「不许静默吞掉未知类别」）。
- **`toContractBlockers` 映射不上的 kind 一律归 `'quality-gate'`**（quality-gate.js:597-604、591）：宁可粗也不能漏，原 kind 保留在 `detail` 里便于定位。
- **`assessBaseline` 的 `requireCommittedInput` 默认 `true`**（quality-gate.js:188、195-197）：生产通道要求产物对应干净的已提交 HEAD；测试为隔离 git 因素常传 `false`（test-engine-quality-gate.mjs 多处）。若生产误用 `false`，会跳过 commit 匹配与脏检查，放行未提交的产物。
- **`done` 的强不变量由两层共同保证**：gate 内部 `outcome==='done'` 要求三类皆空（quality-gate.js:525-536）；native-run.js:777-780 还兜底「三者都说 done 却还有 blockers 就降级成 partial」，防止判定自相矛盾。

### 历史缺陷（已被本模块修复，作为回归锚点）

- 0.14.0「1 篇成功 + 19 篇失败也报 done」：本模块阶段 3 的分类与严格终态（quality-gate.js:15-33）直接针对此缺陷；测试覆盖见 test-engine-quality-gate.mjs:113-134（干净产物 → done）与 147-175（各类缺陷 → partial/failed）。
- 缺页/空壳页被静默放行、source_files 编造导致增量 ownership 静默错位：output.js 的 `entry-missing` / `empty-body` / `source-missing` / `unmapped-page`（output.js:197-265）与 test-engine-output.mjs:134-178 钉死。
- 未提交工作区被当成已提交基线、推进一个 git 里不存在的状态：quality-gate.js:116-150 只读 `git show HEAD:`，并区分 `baseline-uncommitted`（阻塞，240-242）与 `baseline-behind-head`（仅报告，231-236）。
