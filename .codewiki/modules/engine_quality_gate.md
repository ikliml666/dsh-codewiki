---
title: engine_quality_gate
type: module
source_files:
  - lib/engine/quality-gate.js
  - lib/engine/output.js
  - lib/article-contract.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/update-record.js
  - lib/engine/apply-plan.js
  - lib/engine/python/entry.py
  - test-engine-quality-gate.mjs
tags: [engine, quality-gate, fsoft-native, baseline, render-checks]
---

## Overview

`lib/engine/quality-gate.js` 是 FSoft 原生引擎流水线的**阶段 3：采用门（quality gate）**。它在 `output.js`（阶段 2：判断产物自身是否自洽）之后、写进 `.codewiki/` 与 `CodeWiki.md`（阶段 4，由 `apply-plan.js` 执行）之前运行，回答一个更高一层的问题：**「这批产物能不能被 wiki 采用」**（见文件头注释 `lib/engine/quality-gate.js:1-33`）。

它把三件事合成一个可机读的裁决（`lib/engine/quality-gate.js:7-13`）：

1. **产物自洽**：复用 `output.js` 的 `validateOutput`，不重写任何判定（`lib/engine/quality-gate.js:38` 的 import 与 `gateNativeOutput` 第 400 行的调用）。
2. **目标格式契约**：把映射结果渲染成真正的 wiki 文章（frontmatter + 正文），再走 `article-contract.js` 的 `inspectArticle`，判 frontmatter 唯一闭合 / 围栏 / 死链 / source_files 证据 / 类型与位置匹配（`lib/engine/quality-gate.js:9-11`、`lib/engine/quality-gate.js:347`）。
3. **基线可推进性**：产物对应的 commit 必须是**已提交**的 HEAD，且 `.codewiki/_meta.yaml` 的基线本身已入库——未提交的工作区内容不得被当成已提交基线（`lib/engine/quality-gate.js:12-13`、`lib/engine/quality-gate.js:111-151`）。

本模块存在的核心理由（0.14.0 的教训，见 `lib/engine/quality-gate.js:15-33`）是**三类问题必须分开**，否则运维会在错的地方找原因：

- `defect`（产品缺陷）：本次引擎产物自身的问题（缺入口/缺页/空正文/死链/source_files 指向不存在的文件/frontmatter 坏了/围栏未闭合/产物对应的 commit 不是 HEAD）。处置：不让它算完整成功。
- `degradation`（能力降级）：产物可用但证据不足（whole-repository 模式下 `module_tree` 为空 → 页没有归属与 source_files；有页映射不进 wiki）。处置：可以入库，但**增量 ownership 不可信，因此不得推进基线**。
- `stale`（wiki 状态陈旧）：不是本次产物的错（既有 wiki 的基线落后 HEAD、基线只在工作区未提交）。处置：如实报告；只有「基线未入库」这一条会阻止推进（把未提交状态固化成已提交基线是不可逆的记账错误）。

终态仍然严格：**只有三类皆空才是 `done`**（`lib/engine/quality-gate.js:32-33`、`lib/engine/quality-gate.js:533-536`）。分类改变的是「谁来修、修什么」的定位，不是放宽闸门。

## Key Components

下列全部以 `lib/engine/quality-gate.js` 的导出名与行号列出（导出对象见 `lib/engine/quality-gate.js:626-639`）。

### 常量（类别表，稳定、可机读、只增不删）

- `GATE_VERSION` — `42`：quality gate 报告版本号，写入 `GateReport.version`（`lib/engine/quality-gate.js:539`）。
- `GATE_DEFECT_KINDS` — `45-59`：`Object.freeze` 数组，产品缺陷类别。含 `missing-docs-dir` / `missing-metadata` / `missing-module-tree` / `bad-json` / `entry-missing` / `empty-body` / `article-missing` / `unmapped-page` / `source-missing` / `dead-link` / `article-contract` / `commit-mismatch` / `uncommitted-input`。
- `GATE_DEGRADATION_KINDS` — `61-66`：`Object.freeze` 数组，能力降级类别。含 `empty-module-tree` / `no-source-evidence` / `missing-section` / `empty-section-optional`。
- `GATE_STALE_KINDS` — `68-72`：`Object.freeze` 数组，wiki 状态陈旧类别。含 `baseline-behind-head` / `baseline-uncommitted` / `baseline-absent`。
- `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET` — `74-76`：上述三表的 `Set` 形态，供 `gateNativeOutput` 做类别合法性校验（未登记的 kind 直接抛错，`lib/engine/quality-gate.js:406`、`lib/engine/quality-gate.js:76`）。
- `NATIVE_REQUIRED_SECTIONS` — `86`：`Object.freeze([])`。原生通道不沿用 agentic 通道的 `Overview`/`Key Components` 章节要求（FSoft 正文由上游 prompt 决定，硬判会产出不可修复的 warning），只查结构，章节非空性由 `checkRendered` 的「至少一个非空二级标题」单独判（`lib/engine/quality-gate.js:80-86`）。

### git 只读助手

- `git(repoRoot, args, opts)` — `90-102`：`execFileSync('git', args, …)`，失败（非 0 / 超时 / IO 错误）返回 `null`，不抛。供基线判定复用。
- `parseMetaCommit(text)` — `104-107`：从 `_meta.yaml` 文本按正则 `^last_compiled_commit:\s*(\S+)\s*$` 提取 `last_compiled_commit`，去掉引号。无则 `null`。
- `readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })` — `117-151`：读**已提交**的编译基线（`git show HEAD:${rel}`，**不读工作区文件**）。返回值字段：`ok`（`boolean`）/ `source`（`'absent' | 'git-head' | 'worktree-only'`）/ `commit`（`string | null`）/ `worktreeCommit`（`string | null`）/ `dirty`（`boolean`）/ `reason`（`string`）。关键分支：HEAD 有基线用 HEAD 的值并比对工作区是否 `dirty`（136）；工作区有、HEAD 没有 → `source: 'worktree-only'`、`ok: false`、`dirty: true`（140-148）；都不存在 → `absent`（149）。见 `lib/engine/quality-gate.js:111-117` 的「为什么不能用工作区」说明。
- `uncommittedSourceChanges({ repoRoot })` — `158-174`：`git status --porcelain --untracked-files=all`，过滤掉 wiki 自身产物（`.codewiki/`、`CodeWiki.md`，见 `WIKI_PATHS` `156` 与 `170` 的跳过逻辑），返回 `{ ok, paths, reason }`。wiki 自身产物不计脏，因为那正是本轮要写的东西。
- `WIKI_PATHS` — `156`：`Object.freeze(['.codewiki/', 'CodeWiki.md'])`。

### 基线裁决

- `assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput = true })` — `188-244`：判「这批产物的基线能不能被推进」。返回 `{ ok, headCommit, artifactCommit, defects, stale, writable }`（returns 见 `186`）。逻辑：无 `requireCommittedInput` 直接放行（196-198）；比对 `artifactCommit`（来自 `metadata.generation_info.commit_id`）与 `git rev-parse HEAD`（192），非法 sha / 不匹配 → `commit-mismatch` defect（205-214）；检查工作区未提交源码改动 → `uncommitted-input` defect（215-223）；基线陈旧只 `stale` 不归引擎（227-238，含 `baseline-absent` / `baseline-uncommitted` / `baseline-behind-head`）；**只有 `baseline-uncommitted` 会阻塞推进**（`blockingStale` 过滤，241-242）。

### 文章渲染（格式翻译，不改正文）

- `oneLine(s)` — `248-250`：把 `\r\n` 压成空格并 trim，给标题去换行用。
- `yamlScalar(value)` — `269-288`：YAML 标量安全序列化。危险形态（首尾空格、控制字符、换行、反斜杠、`: `、` #`、YAML 特殊首字符、保留字 `true/false/yes/no/on/off/null/~`、数字形态）一律 `JSON.stringify` 加双引号转义（YAML 1.2 是 JSON 超集，serde_yaml 认），安全形态保持裸值（见 `lib/engine/quality-gate.js:252-288` 的完整理由）。
- `titleOf(bodyText, fallback)` — `291-297`：从正文提取首个 H1 文本作为 frontmatter `title`，提不到用 fallback。
- `renderArticle({ article, body })` — `316-340`：把一篇映射文章渲染成完整 wiki 文本（合成 frontmatter + FSoft 原文）。硬约束：① 正文一字不动（318、339 直接拼接 `text`）；② frontmatter 只填有证据的字段（`source_files` 原样来自映射，空就显式写 `source_files: []` 327-329，`tags: []` 331，`generated_by: fsoft-native` 332，`fsoft_page` 记住原始页 333）；③ frontmatter 结束后不插空行（334-338，否则逐字比对对不上）。`article` 字段：`wikiPath` / `type` / `moduleName` / `sourceFiles` / `source`（312）。
- `checkRendered({ content, article, cwd, fsoftPage })` — `346-373`：渲染后的逐篇检查。先走 `inspectArticle`（347-360，传 `NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles: true`、`readableSources/allowedLinks/fsImpl` 全 `null` 避免重复报）；再补两条原生专属判据：① 必须有「至少一个非空二级标题」（`extractSections` 见 `article-contract.js:138`，注释见 `lib/engine/quality-gate.js:86-89`）；② 剥掉**自己合成**的 frontmatter 后用 `bodyLength` 判空（`lib/engine/quality-gate.js:362-371`，因为 `bodyLength` 只跳第一个标题行，直接喂全文会把 8 行 frontmatter 当正文）。

### 主入口

- `gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput, includeContent })` — `390-568`：对一批原生产物做采用裁决。**纯组合**：`validateOutput`（400）→ 产物自洽 defect/degradation 分流（414-437）→ 入口检查（439-462）→ 逐篇渲染 + 契约（464-515）→ 基线 `assessBaseline`（517-523）→ 终态合成（525-536）。返回值关键字段：`version`（`GATE_VERSION`）、`ok`、`outcome`（`'done' | 'partial' | 'failed'`）、`writable`、`canAdvanceBaseline`（`outcome === 'done'`）、`entry`、`articles`、`rendered`、`defects`、`degradations`、`stale`、`blockers`、`counts`、`baseline`（`562-566`）。注意 `blockers` 是 defect + degradation + 仅 `baseline-uncommitted` 类 stale 的并集（527-531），`outcome` 严格三段（534-536：无 `entry.ok` → `failed`；有 blocker → `partial`；否则 `done`）。
  - 内部辅助 `pushDefect`/`pushDegradation`（405-412）：先校验 kind 在登记表内，否则抛错。
  - `articles` 每篇含 `source` / `wikiPath` / `type` / `pageKind` / `moduleName` / `sourceFiles` / `attribution` / `action`（`'write' | 'skip'`）/ `defects` / `degradations`（502-513）。`pageDefects.length` 决定 `skip`（510）。

### 结果转译（供应上层 / 阶段 4 接线）

- `TO_CONTRACT_KIND` — `572-587`：gate 的 blocker kind → `contract.js` 的 `BLOCKER_KINDS` 映射表（见 `lib/engine/contract.js:42-53`）。一一对应不了的一律归 `'quality-gate'`，并保留原 kind 在 detail 里。
- `toContractBlockers(report)` — `589-596`：把 `report.blockers` 翻成 contract.js 兼容的 blocker 数组（`kind` 落在 `BLOCKER_KINDS` 内，`detail` 保留 `[kind/scope]` 前缀，截断 2000 字符）。
- `toQualityIssues(report)` — `610-624`：把 gate 结论翻成 `update-record.js` 的 `qualityIssues`（`judgeOutcome` 的输入之一，见 `lib/update-record.js:37`）。**必须显式喂给 `judgeOutcome`**：否则一篇「可写但 source_files 为空」的页会被判 `done` 并推进基线（即 `lib/engine/quality-gate.js:598-624` 的完整理由）。只把 `degradations` + `defects` + **仅 `baseline-uncommitted`** stale 算进去（619-621，基线落后 HEAD 不混进去，否则每次增量都 `partial`）。

### 依赖的相邻模块导出（被本模块 import）

- `output.js`：`validateOutput`（184-282）、`bodyLength`（127-137）——`lib/engine/quality-gate.js:38`。
- `article-contract.js`：`inspectArticle`（213-335）、`fencesBalanced`（161-164）、`parseFrontmatter`（77-90）——`lib/engine/quality-gate.js:39`。
- `mapping.js`：`WIKI_ENTRY`（`30`）、`WIKI_META_REL`（`32`）——`lib/engine/quality-gate.js:40`。

## Architecture

阶段 3 采用门是 `output.js`（阶段 2，产物自洽）与 `apply-plan.js`（阶段 4，落地）之间的组合层，自身不读真实文件落盘、不 spawn 引擎，只复用 `validateOutput` + `inspectArticle` + git 只读助手。

```text
  docs 树 (FSoft 原生产物)
        │
        ▼
 ┌──────────────────────┐   复用 (不重写判定)
 │ output.js             │── validateOutput: 页在不在 / 正文空不空 /
 │ validateOutput        │   链接指不指计划内 / source_files 存在否
 └──────────┬───────────┘
            │ { collected, mapped, problems }
            ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ quality-gate.js  gateNativeOutput (390)                       │
 │                                                              │
 │  ① 问题分流(418): output problem ──► defect / degradation      │
 │     · empty-module-tree ──► degradation (415-422)             │
 │     · 其余 DEFECT_SET kind ──► defect                         │
 │  ② 入口检查(439): overview.md ──► entry; 空壳/未闭合 ──► defect │
 │  ③ 逐篇 renderArticle(316) ──► checkRendered(346)             │
 │     inspectArticle + 非空二级标题 + 剥头判空 ──► defect/degr.  │
 │  ④ 空 source_files ──► degradation no-source-evidence (497)   │
 │  ⑤ assessBaseline(188): git HEAD / 未提交 / 基线陈旧           │
 │     ──► defects + stale                                      │
 │                                                              │
 │  blockers = defects + degradations + 仅 baseline-uncommitted  │
 │  outcome: !writable→failed │ blockers→partial │ 空→done        │
 └──────────┬───────────────────────────────────────────────────┘
            │ GateReport { outcome, writable, canAdvanceBaseline,
            │            defects, degradations, stale, blockers }
            ▼
 ┌──────────────────────┐   toContractBlockers / toQualityIssues
 │ apply-plan.js        │   写盘 → cw index → 基线 → 自动提交
 │ applyNativeOutput    │   阶段4只接受 writable=true 且按 blocking 记账
 └──────────────────────┘

  git (read-only) ── readCommittedBaseline(117) / uncommittedSourceChanges(158)
                   / rev-parse HEAD  (assessBaseline 192, 215)
```

## Data Flow

一次 `gateNativeOutput` 的端到端数据流：

1. **输入参数**（`lib/engine/quality-gate.js:380-398`）：`docsDir`（引擎 docs 目录）、`repoRoot`（git / source_files 存在性）、`componentFiles`（组件 id → 仓库相对文件，source_files 唯一证据）、`overviewName`（默认 `overview.md`）、`baseline`（可选，预读结果）、`requireCommittedInput`（默认 `true`）、`includeContent`（默认 `true`，是否回带渲染正文）。

2. **读产物+映射**（`400`）：`validateOutput` 内部 `collectOutput`（`output.js:91`）递归读 docs 下 md 页 + 4 个 JSON，`mapFsoftOutput`（`mapping.js:115`）产出 `{ entry, articles, unmapped, warnings }`。`collected` 原样带出，因为阶段 3 要读 `collected.json.metadata?.generation_info?.commit_id` 判产物对应哪个 commit（`output.js:271-274`）。

3. **问题分流**（`414-437`）：遍历 `validation.problems`。`empty-module-tree` → `degradation`（证据缺失不是产物坏，`lib/engine/quality-gate.js:414-422`）；`article-missing` / `unmapped-page` → `defect`；`DEFECT_SET` 内 kind → `defect`；未来 output.js 新增未映射 kind → 兜底成 `article-contract` defect（436，逼这里补映射，测试钉 `test-engine-quality-gate.mjs:185-193`）。

4. **入口**（`439-462`）：取 `mapped.entry`，读 overview 正文；为空壳（`bodyLength === 0`）或围栏未闭合（`fencesBalanced`）→ `defect` 且 `entry.ok = false`。无 entry 则整批不可写（`writable` 依赖它，`526`）。

5. **逐篇渲染+契约**（`464-515`）：对每篇 `mapped.articles` 读原文 → `renderArticle`（合成 frontmatter + 原文）→ `checkRendered`（inspectArticle + 非空二级标题 + 剥头判空）。error 级 issue → `defect`（`article-contract` kind，487）；warning 级（缺/空章节）→ `degradation`（`missing-section`，492）。`sourceFiles` 为空 → `degradation no-source-evidence`（497-501，记 `attribution`）。`pageDefects.length` 决定 `action: 'skip'` 还是 `'write'`（510）；仅 `write` 篇进 `rendered`（514）。

6. **基线**（`517-523`）：`treeCommit = collected.json.metadata?.generation_info?.commit_id`（`518`）→ `assessBaseline`（查 HEAD、未提交源码改动、已提交基线）。`defects`/`stale` 合并进 report。

7. **终态合成**（`525-536`）：`writable = Boolean(entry && entry.ok)`；`blockers` = defect + degradation + 仅 `baseline-uncommitted` stale；`outcome` 三段（failed/partial/done）；`canAdvanceBaseline = outcome === 'done'`（严格，绝不为 degradation 推进）。

8. **输出 → 上层**（`538-567`）：`GateReport` 含 `entry`、`articles`、`rendered`、`defects`、`degradations`、`stale`、`blockers`、`counts`（`pages/articles/writable/skipped/unmapped/defects/degradations/stale`）、`baseline`（`headCommit`/`artifactCommit`/`source`）。

下游两条接线路径（必须一致，不能一个严一个松）：

- **update-record 终态**：`toQualityIssues(report)`（`610`）→ `judgeOutcome` 的 `options.qualityIssues`（`update-record.js:37`），补上「空 source_files 仍算成功」的盲区（测试 `test-engine-quality-gate.mjs:211-224`）。
- **apply-plan 落地**：`applyNativeOutput`（apply-plan.js:414）消费 `report.writable` / `report.canAdvanceBaseline`；`toContractBlockers(report)`（`589`）把 blocker kind 翻成 `BLOCKER_KINDS` 供面板/终态共用。

## Connections

- [[engine_phase2_output]]：阶段 2，`validateOutput`（`output.js:184`）/`bodyLength`（`output.js:127`）被本模块直接复用判「产物自身自洽」；本层只补「能不能被 wiki 采用」的更高一层判定。
- [[engine_mapping]]:`mapFsoftOutput`（`mapping.js:115`）与 `WIKI_ENTRY`/`WIKI_META_REL`（`mapping.js:32`、`32`）是本层入口映射与基线相对路径的来源。
- [[article_contract]]：`inspectArticle`（`article-contract.js:213`）/`fencesBalanced`/`parseFrontmatter` 是渲染后逐篇契约判据；原生通道用 `NATIVE_REQUIRED_SECTIONS`（`quality-gate.js:86`）关掉章节名硬判，转由「至少一个非空二级标题」（`checkRendered`，`quality-gate.js:346`）兜。
- [[engine_contract]]：`BLOCKER_KINDS`（`contract.js:42`）是 `toContractBlockers`（`quality-gate.js:589`）的落点；`assessBaseline` 的 `defect`/`stale` 语义与契约终态（`done` 不带 blocker、`partial` 必须带）保持一致。
- [[update_record]]：`judgeOutcome`（`update-record.js:37`）吞不掉「空 source_files 却成功」的盲区，所以 `toQualityIssues`（`quality-gate.js:610`）必须显式把 gate 结论喂进去，否则会判 done 并推进基线。
- [[engine_apply_plan]]：阶段 4 落地器 `applyNativeOutput`（`apply-plan.js:414`）消费本层的 `GateReport`（`writable` / `canAdvanceBaseline` / `blockers` / `rendered`），把「裁决说可以」变成「入库真的成立」。
- [[engine_python_entry]]：`entry.py` 的 `action_generate`（`entry.py:384`）产出 FSoft docs 树 + `metadata.generation_info.commit_id`，前者是本层 `docsDir` 输入，后者经 `assessBaseline` 比对 HEAD（本层只做采用裁决，不跑引擎）。

## Known Issues

1. **原生通道章节名硬编码豁免**：`NATIVE_REQUIRED_SECTIONS`（`quality-gate.js:86`）为空，依赖「至少一个非空二级标题」（`checkRendered`，`quality-gate.js:346-355`）兜底。若 FSoft 上游 prompt 改出「整篇无 `##` 但内容合法」的形态，这条兜不住（注释已说明真实产物不会出现，但引擎降级/截断路径可能产出）。

2. **`requireCommittedInput=false` 会跳过 commit 校验**：`gateNativeOutput` 默认 `requireCommittedInput=true`（`quality-gate.js:390`）；大量单测传 `false`（`test-engine-quality-gate.mjs:141` 等）只为隔离产物层校验。生产接线若误用 `false`，`commit-mismatch` / `uncommitted-input` 这两条 defect 不会报，未提交工作区会被当成已提交基线。

3. **`toQualityIssues` 必须被调用方主动接上**：它不是 `gateNativeOutput` 内部副作用，而是一条独立翻译（`quality-gate.js:390`）。若阶段 4 走 `judgeOutcome` 路径却忘了传 `toQualityIssues(report)` 的返回值，空的 source_files 会被判 `done` 并推进基线（测试 `test-engine-quality-gate.mjs:216-219` 钉死的前提）。

4. **`readCommittedBaseline` 依赖 `git show HEAD:<rel>` 可读**：若仓库从未提交过 `.codewiki/_meta.yaml`，`git show` 返回 `null`，落到 `source: 'absent'`（首次编译，`quality-gate.js:117`），这本身是合法 stale（`baseline-absent`），不阻塞推进——但要求调用方区分「首次」与「已提交后丢失」。

5. **YAML 安全序列化是「能读回」语义，非完整 YAML**：`yamlScalar`（`quality-gate.js:269`）只处理本仓库文章真实出现的危险形态（反斜杠路径、`: `、` #`、保留字、数字），靠双引号 + JSON 转义保证 `parseFrontmatter`/`serde_yaml` 一致读回（测试 `test-engine-quality-gate.mjs:338-371`）。多行块标量、锚点等 YAML 特性不在此模块职责内。

6. **`blockers` 不含非 `baseline-uncommitted` 的 stale**：`gateNativeOutput` 的 `blockers`（`quality-gate.js:390-394`）只并入 `baseline-uncommitted` 类 stale；`baseline-behind-head`（本轮编译正是为了消化它）与 `baseline-absent`（首次）只进 `stale` 报告、不进 blocker，因此不阻塞 `writable`（见 `assessBaseline` `227-238` 与测试 `test-engine-quality-gate.mjs:296-310`）。
