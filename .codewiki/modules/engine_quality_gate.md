---
title: engine_quality_gate
type: module
source_files:
  - lib/engine/quality-gate.js
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/article-contract.js
  - lib/update-record.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
  - test-engine-quality-gate.mjs
tags: [engine, quality-gate, fsoft, baseline, native-run]
---

## Overview

`lib/engine/quality-gate.js` 是迁移「阶段 3」的**采用门（quality gate）**：引擎把 docs 树交回来之后、产物真正写进 `.codewiki/` 与 `CodeWiki.md` 之前，判定「这批产物能不能被 wiki 采用」。

它位于 `output.js`（阶段 2，只判「产物自身是否自洽」：页在不在、正文空不空、链接指的东西在不在计划内）之上，把三件事合成一个可机读的裁决（`gateNativeOutput`，`lib/engine/quality-gate.js:390`）：

1. **产物自洽**——复用 `output.js` 的 `validateOutput`（`lib/engine/quality-gate.js:38` 导入，`lib/engine/quality-gate.js:400` 调用），不重写任何判定；
2. **目标格式契约**——把映射结果渲染成真正的 wiki 文章（frontmatter + 正文），再走 `article-contract.js` 的 `inspectArticle`（`lib/engine/quality-gate.js:39` 导入，`lib/engine/quality-gate.js:347` 调用）；
3. **基线可推进性**——产物对应的 commit 必须是**已提交**的 HEAD，且 `.codewiki/_meta.yaml` 的基线本身已入库（`readCommittedBaseline` / `assessBaseline`，`lib/engine/quality-gate.js:188` / `:188`）。

### 三类问题必须分开（本模块存在的核心理由）

0.14.0 的教训是「1 篇成功 + 19 篇失败也报 done」。但反过来把一切都塞进一个 `blockers` 数组同样有害：引擎会被归咎于不是它的问题，或 wiki 的陈旧状态被当成产品缺陷，两条路都会让运维在错的地方找原因。所以分类是机读的（`lib/engine/quality-gate.js:45-72`）：

- **defect（产品缺陷）**：本次引擎产物自身的问题（缺入口 / 缺页 / 空正文 / 死链 / `source_files` 指向不存在的文件 / frontmatter 坏了 / 围栏未闭合 / 产物对应 commit 不是 HEAD）。处置：不让它算完整成功。对应 `GATE_DEFECT_KINDS`（`lib/engine/quality-gate.js:45-59`）。
- **degradation（能力降级）**：产物可用但证据不足（whole-repository 模式下 `module_tree` 为空 → 页没有归属与 `source_files`；有页映射不进 wiki）。处置：可以入库，但**增量 ownership 不可信，因此不得推进基线**。对应 `GATE_DEGRADATION_KINDS`（`lib/engine/quality-gate.js:61-66`）。
- **stale（wiki 状态陈旧）**：不是本次产物的错（既有 wiki 的基线落后 HEAD、基线只在工作区未提交）。处置：如实报告；只有「基线未入库」这一条会阻止推进（把未提交状态固化成已提交基线是不可逆的记账错误）。对应 `GATE_STALE_KINDS`（`lib/engine/quality-gate.js:68-72`）。

终态仍然严格：**只有三类皆空才是 `done`**（`lib/engine/quality-gate.js:533-536`）。分类改变的是「谁来修、修什么」的定位，不是放宽闸门——放宽正是迁移里最危险的方向。

## Key Components

本模块全部导出位于 `lib/engine/quality-gate.js`。下文按「常量 → git 助手 → 基线裁决 → 渲染 → 主入口 → 转换器」分组，行号以源码 `行号| ` 前缀为准。

### 常量（机读类别表，稳定、只可追加）

- `GATE_VERSION = 1`（`lib/engine/quality-gate.js:42`）——门报告契约版本。
- `GATE_DEFECT_KINDS`（冻结数组，`lib/engine/quality-gate.js:45-59`）——产品缺陷类别，全部 13 项：`missing-docs-dir`、`missing-metadata`、`missing-module-tree`、`bad-json`、`entry-missing`、`empty-body`、`article-missing`、`unmapped-page`、`source-missing`、`dead-link`、`article-contract`、`commit-mismatch`、`uncommitted-input`。
- `GATE_DEGRADATION_KINDS`（冻结数组，`lib/engine/quality-gate.js:61-66`）——能力降级类别，共 4 项：`empty-module-tree`、`no-source-evidence`、`missing-section`、`empty-section-optional`。
- `GATE_STALE_KINDS`（冻结数组，`lib/engine/quality-gate.js:68-72`）—— wiki 状态陈旧类别，共 3 项：`baseline-behind-head`、`baseline-uncommitted`、`baseline-absent`。
- `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET`（三个 `Set`，`lib/engine/quality-gate.js:74-76`）——上面三张表的查表集合，用于 `pushDefect` / `pushDegradation` 在运行期校验 kind 已登记（`lib/engine/quality-gate.js:409`、`:410`）。
- `NATIVE_REQUIRED_SECTIONS`（冻结空数组，`lib/engine/quality-gate.js:86`）——原生通道的章节要求传 `[]`：只查结构（frontmatter / 围栏 / 正文 / 死链 / 来源），章节非空性由 `checkRendered` 单独判「至少一个非空二级标题」（见 `renderArticle` 与 `checkRendered`）。
- `WIKI_PATHS`（冻结数组，`lib/engine/quality-gate.js:156`）——`['.codewiki/', 'CodeWiki.md']`，`uncommittedSourceChanges` 用它在判定「未提交改动」时排除 wiki 自身产物。
- `TO_CONTRACT_KIND`（映射表，`lib/engine/quality-gate.js:572-587`）——`toContractBlockers` 把门 blocker 的 kind 翻成 `contract.js` 的 `BLOCKER_KINDS`；一一对应不了的一律归 `'quality-gate'`，`baseline-uncommitted` 归 `'baseline-failed'`。

### git 只读助手

- `git(repoRoot, args, { timeout = 15000 })`（`lib/engine/quality-gate.js:90-102`）——薄封装 `execFileSync('git', ...)`，失败（含超时）返回 `null` 而非抛错；`maxBuffer` 8 MiB。
- `parseMetaCommit(text)`（`lib/engine/quality-gate.js:104-107`）——从文本里正则提取 `last_compiled_commit:` 行的值，去掉首尾引号；没有则 `null`。
- `SHA_RE`（`lib/engine/quality-gate.js:109`）——40 位十六进制 SHA 校验正则，用于判定 `commit_id` 是否为合法 sha。
- `readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })`（`lib/engine/quality-gate.js:117-151`）——读**已提交**的编译基线：`git show HEAD:.codewiki/_meta.yaml`（`lib/engine/quality-gate.js:215`），不是工作区文件。返回 `{ ok, source, commit, worktreeCommit, dirty, reason }`。`source` 取值：`'git-head'`（HEAD 中有、且含 `last_compiled_commit` 行）、`'worktree-only'`（工作区有但 HEAD 没有 → `ok:false, dirty:true`）、`'absent'`（都没有）。用 HEAD 的值而非工作区值（`lib/engine/quality-gate.js:136`），工作区与 HEAD 不一致标 `dirty`（`lib/engine/quality-gate.js:136`）。
- `uncommittedSourceChanges({ repoRoot })`（`lib/engine/quality-gate.js:158-174`）——`git status --porcelain --untracked-files=all`（`lib/engine/quality-gate.js:156`，剔除 `WIKI_PATHS`（`:156`）命中的路径）；逐行解析（porcelain v1：`XY<space>path`，重命名取 `->` 后一侧），返回 `{ ok, paths, reason }`。wiki 自身的未提交改动不算脏（`lib/engine/quality-gate.js:170`）。

### 基线裁决

- `assessBaseline({ repoRoot, artifactCommit = null, baseline = null, requireCommittedInput = true })`（`lib/engine/quality-gate.js:188-244`）——判「这批产物的基线能不能被推进」。逻辑：
  - `requireCommittedInput=false` 时直接放行（`ok:true, writable:true`，`lib/engine/quality-gate.js:196-198`）。
  - 否则核对 HEAD（`:192`）与产物 `commit_id`：`artifactCommit` 缺失 → `missing-metadata` defect（`:206`）；非 40 位 sha → `commit-mismatch`（`:208`）；与 HEAD 不符 → `commit-mismatch`（`:210-213`）；工作区有未提交源码改动 → `uncommitted-input` defect（`:215-220`）。
  - 基线陈旧的 `stale`：按 `base.source`/`base.dirty` 派生 `baseline-absent` / `baseline-uncommitted` / `baseline-behind-head`（`:227-238`）。
  - 只有 `baseline-uncommitted` 这一条陈旧阻塞推进（`lib/engine/quality-gate.js:241`）；`ok = defects.length === 0 && blockingStale.length === 0`（`:242`）。返回 `{ ok, headCommit, artifactCommit, defects, stale, writable }`。

### 文章渲染（格式翻译，不改正文）

- `oneLine(s)`（`lib/engine/quality-gate.js:248-250`）——把字符串内换行压缩成单空格并 trim。
- `YAML_UNSAFE_HEAD`（`lib/engine/quality-gate.js:264`）/ `YAML_RESERVED`（`lib/engine/quality-gate.js:266`）/ `YAML_NUMBER`（`lib/engine/quality-gate.js:267`）——`yamlScalar` 判定「裸值是否不安全」的正则与保留字集合。
- `yamlScalar(value)`（`lib/engine/quality-gate.js:269-288`）——YAML 标量安全序列化：只在确实不安全（首尾空格 / 控制字符 / 换行 / 反斜杠 / `: `/` #` / 危险首字符 / 保留字 / 数字）时才加双引号，双引号形态用 `JSON.stringify`（YAML 1.2 是 JSON 超集，`lib/engine/quality-gate.js:261-263`）。安全值保持裸写（`change_set`、`Core Engine`、`src/core/engine.py`）。
- `titleOf(bodyText, fallback)`（`lib/engine/quality-gate.js:291-297`）——从正文提取 H1 文本作 frontmatter `title`，提不到用 `fallback`。
- `renderArticle({ article, body })`（`lib/engine/quality-gate.js:316-340`）——把一篇映射结果渲染成完整 wiki 文章文本：`---\n` + `title` / `type`（经 `yamlScalar`）/ `source_files`（`a.sourceFiles` 原样，空则显式写 `source_files: []`，`lib/engine/quality-gate.js:327-329`）/ `tags: []` / `generated_by: fsoft-native` /（有则）`fsoft_page` + `---\n` 紧跟正文。**三条硬约束**：正文一字不动（`:303-305`）、frontmatter 只填有证据的字段（`:306-308`）、可回溯（`fsoft_page` 记住原始页，`:308-310`）；结束 `---\n` 后**不插空行**以便逐字比对（`:334-338`）。
- `checkRendered({ content, article, cwd, fsoftPage })`（`lib/engine/quality-gate.js:346-373`）——渲染后逐篇检查：先走 `inspectArticle`（`:347-360`，`requiredSections: NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles: true`、`fsImpl: null` 避免与 `output.js` 重复判），再补两条原生专属判据：剥掉**自己合成**的 frontmatter 后用 `bodyLength` 判「除标题外无正文」→ `empty-body` error（`:366-371`）。

### 主入口

- `gateNativeOutput({ docsDir, repoRoot = null, componentFiles = {}, overviewName = 'overview.md', baseline = null, requireCommittedInput = true, includeContent = true })`（`lib/engine/quality-gate.js:390-568`）——对一批原生产物做采用裁决。纯组合：读产物（`validateOutput`，`:400`）→ 渲染（`renderArticle`，`:477`）→ 契约（`checkRendered`，`:478`）→ 基线（`assessBaseline`，`:519`）。返回 `GateReport`（可 JSON 序列化），字段见下。

  `GateReport` 字段（行号 `lib/engine/quality-gate.js:388-417`）：
  - `version`（`GATE_VERSION`）、`ok`（`outcome === 'done'`）、`outcome`（`failed`/`partial`/`done`）、`writable`（有可用入口）、`canAdvanceBaseline`（`outcome === 'done'`）。
  - `entry`（`{ source, path, ok }` 或 `null`）、`articles`（逐篇明细数组：`source`/`wikiPath`/`type`/`pageKind`/`moduleName`/`sourceFiles`/`attribution`/`action`(`write`|`skip`)/`defects`/`degradations`）、`rendered`（`includeContent` 且 `pageDefects` 为零的渲染结果 `{ source, wikiPath, type, content }`）。
  - `defects` / `degradations` / `stale`（三类问题数组）、`blockers`（终态阻塞数组：`defects` + `degradations` + `stale` 中 `baseline-uncommitted`）。
  - `counts`（页/文章/可写/跳过/未映射/缺陷/降级/陈旧计数）、`baseline`（末态 `{ headCommit, artifactCommit, source }`）。
  - `outcome` 合成规则（`:533-536`）：`writable` 为假 → `failed`；否则 `blocking.length` 非零 → `partial`；否则 `done`，严格「三类皆空才 done」。

### 转换器（供上层 update-record / 终态判定使用）

- `toContractBlockers(report)`（`lib/engine/quality-gate.js:589-596`）——把 `report.blockers` 翻成 `contract.js` 的 `BLOCKER_KINDS`（经 `TO_CONTRACT_KIND`，`:591`），保留原 kind 在 `detail` 前缀里（`[${b.kind}/${b.scope}] ...`）。
- `toQualityIssues(report)`（`lib/engine/quality-gate.js:610-624`）——把门结论翻成 `update-record` 的 `qualityIssues`（`{ name, issue }`）：`degradations` + `defects` 全量 + `stale` 中**仅** `baseline-uncommitted`。这是为了让 `judgeOutcome`（`lib/update-record.js:37`）把「可写但 `source_files` 为空」的页判成 partial（`:601-605`），两条判定路径不能一个严一个松。

### 默认导出

- `default`（`lib/engine/quality-gate.js:626-639`）——一次性导出全部上述符号：`GATE_VERSION`、`GATE_DEFECT_KINDS`、`GATE_DEGRADATION_KINDS`、`GATE_STALE_KINDS`、`gateNativeOutput`、`renderArticle`、`titleOf`、`readCommittedBaseline`、`uncommittedSourceChanges`、`assessBaseline`、`toContractBlockers`、`toQualityIssues`。

## Architecture

`gateNativeOutput` 是纯组合器：它自己不重新解析 docs，而是复用 `output.js` 的 `validateOutput`，再叠加渲染、契约、基线三道检查，最后把三类问题分流成终态。组件关系如下（UTF-8 框图，组件名 + 文件：行号）：

```text
  docs/ (FSoft 产物)            repoRoot (git + .codewiki)
        │                            │
        ▼                            │
 ┌───────────────┐                  │
 │ output.js:     │  validateOutput │
 │ validateOutput │─────────────────┘  (读 docs + 映射 + 自洽校验)
 │   :400         │
 └──────┬────────┘
        │ { validation: { collected, mapped, problems } }
        ▼
 ┌──────────────────────────────────────────────┐
 │ quality-gate.js: gateNativeOutput (:390)      │
 │  1) problems 分流 defect/degradation (:418)   │
 │  2) 入口 entry 读 + 空正文/围栏校验  (:440)    │
 │  3) 逐篇 renderArticle(:477)→checkRendered(:478)│
 │  4) 空 source_files → no-source-evidence(:497)│
 │  5) assessBaseline(:519)  ← readCommittedBaseline(:117)
 │  6) 终态合成 outcome (:533)                    │
 └──┬─────────┬───────────────┬───────────────┘
    │         │               │
    ▼         ▼               ▼
 ┌────────┐ ┌──────────┐ ┌──────────────────────┐
 │renderArticle│ inspectArticle│ assessBaseline+     │
 │ :316    │ │ article- │ │ readCommittedBaseline  │
 │ (正文不 │ │ contract │ │ :188  (git HEAD 基线)  │
 │  改写)  │ │ .js:347  │ │ uncommittedSourceChanges│
 └────────┘ └──────────┘ └──────────────────────┘
    │
    ▼  GateReport { outcome, defects, degradations, stale, blockers, rendered }
 ┌──────────────────────────────────────────────┐
 │ native-run.js: runNativeJob (:340)            │
 │  toContractBlockers(:407) → 终态 blockers      │
 │  report → apply-plan.js: applyNativeOutput     │
 │  toQualityIssues(report) → judgeOutcome        │
 └──────────────────────────────────────────────┘
```

要点（行号均为源码前缀）：

- `gateNativeOutput` 复用 `validateOutput`（`lib/engine/quality-gate.js:400`），后者内部已调用 `mapFsoftOutput`（`lib/engine/output.js:164` → `lib/engine/mapping.js:115`）并带出 `collected.json.metadata.generation_info.commit_id` 给基线判定用（`lib/engine/output.js:271-274`）。
- `checkRendered` 刻意把 `allowedLinks` / `readableSources` / `fsImpl` 设为 `null`（`lib/engine/quality-gate.js:351-355`），因为死链、source 存在性、source 证据已在 `output.js` 阶段判过一次，这里再判只会把同一条缺陷翻倍上报。
- 原生通道 `requiredSections` 传 `[]`（`NATIVE_REQUIRED_SECTIONS`，`:356`），章节名由上游 prompt 决定，不能用 agentic 通道的 `Overview`/`Key Components` 去判，否则闸门会退化成噪声（`lib/engine/quality-gate.js:80-85`，`lib/article-contract.js:217-224`）。

## Data Flow

一次 `gateNativeOutput` 调用从输入到 `GateReport` 的数据流：

1. **输入**：`docsDir`（FSoft 产出的 docs 目录）、`repoRoot`（仓库根，用于 `source_files` 存在性与 git 基线）、`componentFiles`（组件 id → 仓库相对文件）、`overviewName`、`baseline`（可选，现读则省一次 `git`）、`requireCommittedInput`、`includeContent`。
2. **产物自洽（`lib/engine/quality-gate.js:400-437`）**：`validateOutput` 返回 `{ collected, mapped, problems }`。逐条 `problem` 按 kind 分流：
   - `empty-module-tree` → 降级 `empty-module-tree`（`lib/engine/quality-gate.js:419`，whole-repository 模式属性缺失而非产物坏）；
   - `article-missing` / `unmapped-page` → 缺陷（`lib/engine/quality-gate.js:423`、`:427`）；
   - 其余已登记 defect kind → 缺陷；未登记 kind → `article-contract` 缺陷（逼这里补映射，`lib/engine/quality-gate.js:436`）。
3. **入口（`lib/engine/quality-gate.js:440-462`）**：读 `mapped.entry.source`，判空正文（`bodyLength`）与围栏未闭合（`fencesBalanced`），任一失败 → `entry-missing` / `empty-body` / `article-contract` 缺陷且 `entry.ok=false`。
4. **逐篇渲染 + 契约（`lib/engine/quality-gate.js:467-515`）**：对 `mapped.articles` 每篇读正文 → `renderArticle`（正文一字不动，`lib/engine/quality-gate.js:477`）→ `checkRendered`（`:478`）。`inspectArticle` 返回的 error 级 → `article-contract` 缺陷（`:487`），warning 级 → 降级（`:492`，kind 为 `missing-section` 等）。空 `sourceFiles` → `no-source-evidence` 降级（`:497`）。`action` 由 `pageDefects.length` 决定 `write` / `skip`（`:510`）；`includeContent && pageDefects.length===0` 的才进 `rendered`（`:514`）。
5. **基线（`lib/engine/quality-gate.js:518-523`）**：`treeCommit = collected.json.metadata.generation_info.commit_id`（`:518`），交给 `assessBaseline`，其 `defects` 追加进门的 `defects`（`:522`），`stale` 原样保留。
6. **终态合成（`lib/engine/quality-gate.js:526-567`）**：`writable = Boolean(entry && entry.ok)`（`:526`）；`blocking` = 全部 `defects` + `degradations` + `stale` 中仅 `baseline-uncommitted`（`:527-531`）。`outcome`：`!writable → failed`；`blocking.length → partial`；否则 `done`（`:533-536`）。`canAdvanceBaseline = outcome === 'done'`（`:544`）。

下游消费：`GateReport` 由 `native-run.js:runNativeJob` 在 `lib/engine/native-run.js:340` 调用（阶段 4），其 `blockers` 经 `toContractBlockers`（`lib/engine/native-run.js:407`）并入终态，再交给 `apply-plan.js:applyNativeOutput`（`lib/engine/native-run.js:402`）落盘。若阶段 4 走 `judgeOutcome` 那条路（如测试 `lib/update-record.js:37`），必须显式用 `toQualityIssues(report)`（`lib/engine/quality-gate.js:610`）喂入 `qualityIssues`，否则空 `source_files` 会被判成 done 并推进基线（`test-engine-quality-gate.mjs:211-224`）。

## Connections

- [[engine_output]]——阶段 2：`validateOutput`（`lib/engine/output.js:184`）是被复用的产物自洽校验；门只在其之上叠加格式契约与基线判定，不重写任何判定。
- [[engine_mapping]]——阶段 0 的 `mapFsoftOutput`（`lib/engine/mapping.js:115`）提供 `entry` / `articles` / `unmapped`；门消费的 `WIKI_ENTRY`、`WIKI_META_REL` 也在此定义（`lib/engine/mapping.js:32`、`:32`）。产物对应 commit 来自 `metadata.generation_info.commit_id`。
- [[engine_contract]]——`contract.js` 的 `BLOCKER_KINDS`（`lib/engine/contract.js:42`）是 `toContractBlockers` 的目标词表；终态四态（`done/partial/failed/cancelled`）与 `engineResult` 硬不变量（done 不许带 blockers）由 `native-run.js:settle`（`lib/engine/native-run.js:407`）施加。
- [[engine_native_run]]——阶段 4 编排 `runNativeJob`（`lib/engine/native-run.js:68`）：在 `:340` 调 `gateNativeOutput`、在 `:407` 调 `toContractBlockers`、在 `:366` 把 `report` 交给落地器，并以「最弱终态」合成（`RANK`，`lib/engine/native-run.js:41`）。
- [[engine_apply_plan]]——阶段 3 落地器 `applyNativeOutput`（`lib/engine/apply-plan.js:414`）：认 `report.writable`/`report.rendered`/`report.outcome`，写集封闭（`lib/engine/apply-plan.js:715` 白名单与 `:86` 校验）、索引/基线失败即回滚、提交失败不回滚；对 `gate-partial` 照写但不洗成 done（`lib/engine/apply-plan.js:471-478`）。
- [[article_contract]]——`inspectArticle`（`lib/article-contract.js:213`）是被复用的目标格式闸门；门的 `checkRendered` 用其 `requiredSections=[]` + `allowEmptySourceFiles=true` 两个开关规避重复判与噪声降级。
- [[update_record]]——`judgeOutcome`（`lib/update-record.js:37`）是阶段 4 的另一条终态判定路径；`toQualityIssues` 必须把门的 `degradations`/`defects`/`baseline-uncommitted` 喂进去，否则两条路径会一严一松。

## Known Issues

- **`requireCommittedInput=true` 时 `uncommitted-input` 会把整批判 partial**：工作区任何非 wiki 的未提交改动都算缺陷（`lib/engine/quality-gate.js:215-220`）。这是有意为之——产物反映的内容不在任何 commit 里，不能作为已提交基线。但意味着开发期未提交源码时永远不能推进基线；测试里普遍传 `requireCommittedInput: false` 来绕开（如 `test-engine-quality-gate.mjs:141`）。
- **未登记的 `output.js` 类别会被静默转成 `article-contract`**：`lib/engine/quality-gate.js:436` 对未知 `problem.kind` 兜底成 `article-contract` 缺陷。这保证「不会静默吞掉」，但会丢失原 kind 信息——若 `output.js` 新增类别，必须在此显式补映射，否则监控按 kind 分派会失效（测试 `test-engine-quality-gate.mjs:185-193` 守住「全部 kind 必须在登记表里」）。
- **`readCommittedBaseline` 依赖真实 git**：`git show HEAD:.codewiki/_meta.yaml`（`lib/engine/quality-gate.js:117`）在非 git 仓库或没有 HEAD 时返回 `ok:false`，不会抛（被 `git()` 的 catch 吞成 `null`，`:99-101`）。调用方需自行处理 `ok` 为假的情况（如 `assessBaseline` 把它转成 `baseline-absent`/`baseline-uncommitted`）。
- **`checkRendered` 自剥 frontmatter 才能判空壳**：因 `renderArticle` 合成的 frontmatter 会进 `bodyLength` 统计（`lib/engine/quality-gate.js:362-365`），直接喂全文会让 `# Web` 这种只有标题的空壳页 `bodyLength ≈ 100` 永远判不出空；故必须先 `parseFrontmatter` 剥头（`:366`）再判。
- **`yamlScalar` 对危险值一律加双引号**：为与既有文章观感一致，安全值保持裸写（`lib/engine/quality-gate.js:269`），但若某未来标题恰命中 `YAML_UNSAFE_HEAD`/`YAML_RESERVED`/`YAML_NUMBER`（如 `12345`、`true`、`~`、`- leading dash`），会渲染成双引号形态。测试 `test-engine-quality-gate.mjs:338-371` 钉死「危险值写出后必须能被 `parseFrontmatter` 读回原字符串」。
- **真实产物（`.probe-fsoft/wiki_out_1c/docs`）测试默认跳过**：`test-engine-quality-gate.mjs:433-436` 仅在路径存在时跑这组（阶段 1C 未跑过则 SKIP），绝不直接改写原产物（`:13-14`，复制到临时目录后变形）。
