---
title: engine_quality
type: module
source_files:
  - lib/engine/quality-gate.js
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/article-contract.js
  - lib/engine/native-run.js
  - lib/update-record.js
  - test-engine-quality-gate.mjs
tags: [quality-gate, native-engine, baseline, adoption-gate, fsoft]
---

## Overview

`engine_quality` 是 FSoft 原生引擎产物的**采用门（quality gate）**，落在阶段 3：引擎把 `docs` 树交回来之后、写进 `.codewiki/` 与 `CodeWiki.md` 之前（见 `lib/engine/quality-gate.js` 第 1–33 行的总述）。它把三件事合成一个可机读的裁决：

1. **产物自洽**：复用 `lib/engine/output.js` 的 `validateOutput`，不重写任何判定（第 8–13 行）。
2. **目标格式契约**：把 mapping 结果渲染成真正的 wiki 文章（frontmatter + 正文），再走 `lib/article-contract.js` 的 `inspectArticle`（第 9–11 行）。
3. **基线可推进性**：产物对应的 commit 必须是**已提交**的 HEAD，且 `.codewiki/_meta.yaml` 的基线本身已入库——未提交的工作区内容不得被当成已提交基线（第 12–13 行）。

本模块存在的核心理由是**三类问题必须分开**（第 15–33 行）。0.14.0 的教训是「1 篇成功 + 19 篇失败也报 done」，但把一切都塞进一个 `blockers` 数组同样有害：引擎会被归咎于不是它的问题，或 wiki 的陈旧状态被当成产品缺陷。所以分类是机读的：

- `defect`（产品缺陷）：缺入口/缺页/空正文/死链/source_files 指向不存在文件/frontmatter 坏了/围栏未闭合/产物对应 commit 不是 HEAD/工作区有未提交源码改动。
- `degradation`（能力降级）：产物可用但证据不足（whole-repository 模式下 `module_tree` 为空 → 页无归属与 source_files；有页映射不进 wiki）。处置：可入库，但增量 ownership 不可信，因此**不得推进基线**。
- `stale`（wiki 状态陈旧）：不是本次产物的错（既有 wiki 基线落后 HEAD、基线只在工作区未提交）。处置：如实报告；只有 `baseline-uncommitted` 这一条会阻止推进（把未提交状态固化成已提交基线是不可逆的记账错误）。

终态仍然严格：**只有三类皆空才是 `done`**。分类改变的是「谁来修、修什么」的定位，不是放宽闸门（第 32–33 行）。

## Key Components

所有公开符号都在 `lib/engine/quality-gate.js`，另有从 `output.js` / `mapping.js` / `article-contract.js` / `contract.js` / `update-record.js` 复用与接线的部分。

### 常量（quality-gate.js）

- `GATE_VERSION` — `42|` 门版本，固定为 `1`。在 `gateNativeOutput` 返回值里带出（`version: GATE_VERSION`，第 539 行）。
- `GATE_DEFECT_KINDS` — `45–59|` 冻结数组，13 个 defect 类别：`missing-docs-dir` / `missing-metadata` / `missing-module-tree` / `bad-json` / `entry-missing` / `empty-body` / `article-missing` / `unmapped-page` / `source-missing` / `dead-link` / `article-contract` / `commit-mismatch` / `uncommitted-input`。新增只允许追加（消费者按 kind 分派）。
- `GATE_DEGRADATION_KINDS` — `61–66|` 冻结数组，4 个 degradation 类别：`empty-module-tree` / `no-source-evidence` / `missing-section` / `empty-section-optional`。
- `GATE_STALE_KINDS` — `68–72|` 冻结数组，3 个 stale 类别：`baseline-behind-head` / `baseline-uncommitted` / `baseline-absent`。
- 内部集合 `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET` — `74–76|` 由上面三个数组构造的 `Set`，用于 `pushDefect` / `pushDegradation` 校验「未登记的类别直接抛错」。
- `NATIVE_REQUIRED_SECTIONS` — `86|` 冻结的空数组 `[]`。原生通道的章节要求**不沿用** cw agentic 通道的 `Overview/Key Components`（第 80–85 行），只查结构（frontmatter/围栏/正文/死链/来源）；章节非空性由 `checkRendered` 单独判「至少一个非空二级标题」。

### 函数（quality-gate.js）

- `git(repoRoot, args, { timeout = 15000 })` — `90–102|` git 只读助手，`execFileSync` 包装，失败/超时返回 `null`（不抛）。
- `parseMetaCommit(text)` — `104–107|` 从 `_meta.yaml` 文本里正则提取 `last_compiled_commit:` 的值（去掉可选的引号）。
- `readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })` — `117–151|` 读**已提交**的编译基线：`git show HEAD:<rel>` 而不是工作区文件。返回对象字段：`ok` (boolean)、`source` (`'absent' | 'git-head' | 'worktree-only'`)、`commit` (string|null)、`worktreeCommit` (string|null)、`dirty` (boolean)、`reason` (string)。逻辑：
  - 有提交基线 → `source='git-head'`，用 HEAD 的值；工作区值与 HEAD 不一致则 `dirty=true`（第 131–139 行）。
  - 只有工作区有、HEAD 没有 → `source='worktree-only'`、`ok=false`、`dirty=true`（第 140–148 行）。
  - 都不存在 → `source='absent'`（首次编译，第 149–150 行）。
- `uncommittedSourceChanges({ repoRoot })` — `158–174|` 用 `git status --porcelain --untracked-files=all` 取工作区未提交改动，过滤掉 wiki 自身路径（`WIKI_PATHS = ['.codewiki/', 'CodeWiki.md']`，第 156 行）。返回 `{ ok, paths, reason }`。wiki 产物不算源码改动，因为那正是本轮要写的东西（第 153–155 行）。
- `assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput = true })` — `188–244|` 判「这批产物的基线能不能被推进」。返回 `{ ok, headCommit, artifactCommit, defects, stale, writable }`：
  - `requireCommittedInput=false` 时直接放行（第 196–198 行）。
  - `commit-mismatch`：未给 repoRoot / HEAD 不可追溯 / commit_id 非 40 位 sha / 产物 commit ≠ HEAD（第 200–214 行）。
  - `uncommitted-input`：工作区有非 wiki 的未提交源码改动（第 215–223 行）。
  - `stale`：基线 `absent` → `baseline-absent`；基线未入库或与工作区不一致 → `baseline-uncommitted`；基线落后 HEAD → `baseline-behind-head`（第 227–238 行）。
  - **只有 `baseline-uncommitted` 会阻塞推进**（第 240–242 行），`ok = defects.length === 0 && blockingStale.length === 0`。
- `yamlScalar(value)` — `269–288|` YAML 标量安全序列化。只在确实不安全时加双引号（用 `JSON.stringify`，因为 JSON 串是合法 YAML 双引号标量）。触发引号化的条件：首尾空格、控制字符、换行、反斜杠、`": "` 或结尾 `:`、`" #"` 或开头 `#`、`YAML_UNSAFE_HEAD` 首字符、YAML 保留字（`YAML_RESERVED`，第 266 行）、`YAML_NUMBER` 数字形态（第 267 行）。安全值保持裸写（第 263 行）。
- `titleOf(bodyText, fallback)` — `291–297|` 从正文提取首个 H1 文本作为 frontmatter title；提不到用 `fallback`。H1 取 `^#\s+(.+?)\s*$` 整行（含中间空格），用 `oneLine` 去掉换行（第 248–250 行）。
- `renderArticle({ article, body })` — `316–340|` 把映射出的一篇渲染成 wiki 文章完整文本（合成 frontmatter + FSoft 原文）。三条硬约束：① 正文一字不动（不删 H1、不改标题、不重写链接、不补章节）；② frontmatter 只填有证据的字段（source_files 原样、空就是空、绝不按目录名猜，type 由映射给，tags 写空列表）；③ 可回溯（写 `fsoft_page` 记住原始页）。frontmatter 结束标记后**不插空行**（第 334–338 行），否则 `parseFrontmatter` 会把空行算进 body，破坏「正文一字不动」的逐字比对。
- `checkRendered({ content, article, cwd, fsoftPage })` — `346–373|` 渲染后的逐篇检查：先走 `inspectArticle`（复用，传 `NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles: true`、`fsImpl: null`），再补「剥掉自己合成的 frontmatter 后 bodyLength 是否为零」的 `empty-body` 判据（第 362–371 行）——因为 `bodyLength` 只跳过第一个标题行、会放过空壳页，而 `inspectArticle` 的 `empty-body` 判的是 `body.trim()`、H1 在就非空，两条路都放过空壳，故这里自己兜住。
- `gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput, includeContent })` — `390–568|` 主入口，纯组合：读产物（`validateOutput`）→ 渲染 → 契约 → 基线。返回 `GateReport`（可 JSON 序列化），字段见下方「GateReport 结构」。
- `toContractBlockers(report)` — `589–596|` 把 gate 的 `blockers` 翻成 `contract.js` 的 `BLOCKER_KINDS`，一一对应不了的归 `'quality-gate'` 并保留原 kind 在 detail（第 572–587 行 `TO_CONTRACT_KIND` 映射表）。
- `toQualityIssues(report)` — `610–624|` 把 gate 结论翻成 `update-record.js` 的 `qualityIssues`（`judgeOutcome` 的输入）。**只把阻塞性的陈旧算进去**：defects + degradations 全量进，stale 只有 `baseline-uncommitted` 进（第 618–622 行）。`baseline-behind-head` 不算，否则每次增量都落 partial。

### GateReport 结构（gateNativeOutput 返回，528–567 行）

- `version` — GATE_VERSION（第 539 行）。
- `ok` — `outcome === 'done'`（第 540 行）。
- `outcome` — `'failed' | 'partial' | 'done'`：`writable=false` → `failed`；有 blocking → `partial`；否则 `done`（第 533–536 行）。
- `writable` — 有可用入口页 `entry && entry.ok`（第 526 行）。
- `canAdvanceBaseline` — **严格** `outcome === 'done'`（第 544 行）。
- `entry` — `{ source, path, ok }` 或 `null`（第 440–442 行、545 行）。
- `articles` — 逐篇 `{ source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, action: 'write'|'skip', defects, degradations }`（第 502–513 行）。`action` 由 `pageDefects.length ? 'skip' : 'write'` 决定（第 510 行）。
- `rendered` — `{ source, wikiPath, type, content }`，仅 `includeContent && pageDefects.length === 0` 才入（第 514 行）。
- `defects` / `degradations` / `stale` — 三类问题数组（第 548–550 行）。
- `blockers` — 终态阻塞集合：defects + degradations + 仅 `baseline-uncommitted` 的 stale（第 527–531 行）。
- `counts` — `{ pages, articles, writable, skipped, unmapped, defects, degradations, stale }`（第 552–561 行）。
- `baseline` — `{ headCommit, artifactCommit, source }`（第 562–566 行）。

### 复用的上游符号

- `validateOutput` / `bodyLength` / `relativeLinks` / `collectOutput` / `buildWritePlan` — `lib/engine/output.js`（`quality-gate.js` 第 38 行导入）。`validateOutput` 在 `gateNativeOutput` 第 400 行调用，同时回传 `collected`（含 `metadata.generation_info.commit_id` 供基线判定，第 518 行）。
- `mapFsoftOutput` / `WIKI_ENTRY` / `WIKI_META_REL` — `lib/engine/mapping.js`（第 40 行导入）。`mapFsoftOutput` 把 overview 映射成 `entry`、模块页映射成 `articles`、`unmapped` 页、`warnings`（第 115–268 行）。`whole-repository` 模式（`module_tree` 为空）下页进写集但 `sourceFiles=[]`、`attribution='unattributed'`（第 153–187 行）。
- `inspectArticle` / `fencesBalanced` / `parseFrontmatter` — `lib/article-contract.js`（第 39 行导入）。`inspectArticle` 的 `SEVERITY` 分级（error 拒写 / warning 放行但记账）是闸门行为分界（第 56–73 行）。
- `BLOCKER_KINDS` — `lib/engine/contract.js`（第 57–72 行）。`toContractBlockers` 的目标类别集。
- `judgeOutcome` — `lib/update-record.js`（第 37–128 行）。`toQualityIssues` 的产出喂给它第 100–102 行的「质量闸门」blocker 分支。

## Architecture

`gateNativeOutput` 是一条纯组合的裁决链，组件 ≥3、流程非平凡，框图如下（文件/类标注在框内，箭头标注数据关系）：

```text
                  docsDir ──► validateOutput (output.js)
                  repoRoot        │  collected + mapped + problems
                                  ▼
                         ┌──────────────────────┐
                         │ gateNativeOutput     │  quality-gate.js
                         │ (主入口 390–568)       │
                         └──────────────────────┘
                            │        │        │
        problems 分流       │        │        │  metadata.commit →
        defect/degradation  │        │        │  assessBaseline (188)
                            ▼        ▼        ▼
                  ┌─────────────┐ ┌────────────┐ ┌────────────────────┐
                  │ checkRendered│ │ renderArticle│ │ readCommittedBase- │
                  │ (346)       │ │ (316)       │ │ line + uncommitted │
                  │ inspectArti-│ │ frontmatter │ │ SourceChanges       │
                  │ cle (contract)│ │ + FSoft 原文 │ │ (117/158)          │
                  └─────────────┘ └────────────┘ └────────────────────┘
                            │        │        │
                            └───► 合成 GateReport (538)
                                   outcome / writable / canAdvanceBaseline
                                   defects / degradations / stale / blockers
                                            │
                          ┌─────────────────┴─────────────────┐
                          ▼                                   ▼
                 toContractBlockers (589)                toQualityIssues (610)
                          │                                   │
                          ▼                                   ▼
                 contract.BLOCKER_KINDS                judgeOutcome (update-record)
                          │                                   │
                          └──────────► native-run.runNativeJob (503–661) ◄── 终态合成
```

要点（与 `lib/engine/native-run.js` 对齐）：

- 阶段 4 的 `runNativeJob` 在引擎产出后调用 `gateImpl({ docsDir, repoRoot, requireCommittedInput })`（第 506 行），把 `report` 透传给落地器 `applyImpl`（第 609 行）与终态合成（第 651–685 行）。
- 终态用「最弱一环」合成：`weakest(engineOutcome, gateOutcome, applyOutcome)`（第 73–74、654 行）。`gate` 的 blockers 一律经 `toContractBlockers(report)` 进终态（第 660 行），**永不消失**（第 657–659 行注释特别说明真实 gate 拦下的死链/空正文也要进终态）。
- `canAdvanceBaseline` 在 gate 内部与 native-run 终态都严格：`outcome === 'done'` 才 `true`（第 544 行、native-run 第 164 行）。

## Data Flow

一次原生产物的采用裁决数据流（以 `gateNativeOutput` 第 390–568 行为主线）：

1. **读产物**（第 400 行）：`validateOutput({ docsDir, repoRoot, componentFiles, overviewName })` 调 `collectOutput` 读 `docs` 树 + `mapFsoftOutput` 建立写集，得到 `collected`（页清单 + 4 个 JSON）、`mapped`（entry / articles / unmapped / warnings）、`problems`。
2. **问题分流**（第 418–437 行）：遍历 `validation.problems`。
   - `empty-module-tree` → 降级 `degradation`（页照写但增量归属不可用，第 419–422 行）。
   - `article-missing` / `unmapped-page` → `defect`（第 423–430 行）。
   - 其余已登记 kind → `defect`；未登记 kind → 逼补映射成 `article-contract` defect（第 431–437 行）。
   - `pushDefect` / `pushDegradation` 内部校验 kind 必须在冻结集合里，否则抛错（第 405–412 行）——守住「不许静默吞掉未知类别」。
3. **入口检查**（第 440–462 行）：无 overview → `entry=null`、整批 `writable=false`；有则读正文，空正文→`empty-body` defect、围栏未闭合→`article-contract` defect。
4. **逐篇渲染 + 契约**（第 465–515 行）：每篇读 `a.source` 正文 → `renderArticle` 合成 frontmatter → `checkRendered` 走 `inspectArticle` + 自补 `empty-body`。`error` 级 issue → `article-contract` defect 且 `action='skip'`；`warning` 级 → `degradation`（`missing-section` 等）。空 `sourceFiles` → `no-source-evidence` degradation（第 497–501 行）。仅 `pageDefects.length === 0` 的页进 `rendered`（第 514 行）。
5. **基线裁决**（第 517–523 行）：从 `collected.json.metadata.generation_info.commit_id` 取 `treeCommit`，调 `assessBaseline`；其 `defects` 并入、其 `stale` 直接带上。
6. **终态合成**（第 525–567 行）：
   - `writable = Boolean(entry && entry.ok)`（第 526 行）。
   - `blocking` = 全部 defects + 全部 degradations + 仅 `baseline-uncommitted` 的 stale（第 527–531 行）。
   - `outcome`：`!writable → 'failed'`；`blocking.length → 'partial'`；否则 `'done'`（第 533–536 行）。
   - `canAdvanceBaseline = outcome === 'done'`（第 544 行，严格）。

下游消费（见 Connections）：`runNativeJob` 拿 `report` 去 `apply-plan.js` 落地，并把 `toContractBlockers(report)` 与 `toQualityIssues(report)` 喂进终态/更新记录。

典型故障 → 终态对照（来自 `test-engine-quality-gate.mjs`）：

| 故障场景 | 触发的 kind | outcome | canAdvanceBaseline |
| --- | --- | --- | --- |
| 干净产物 + 已提交 HEAD + 基线一致 | 无 | `done` | `true` |
| 缺 overview | `entry-missing` | `failed` | `false` |
| 模块页只有标题 | `empty-body` | `partial` | `false` |
| whole-repository（`module_tree={}`） | `empty-module-tree` + `no-source-evidence` | `partial` | `false` |
| 产物 commit ≠ HEAD | `commit-mismatch` | `partial` | `false` |
| 基线只在工作区未提交 | `baseline-uncommitted` (stale) | `failed`（blocking） | `false` |
| 基线落后 HEAD | `baseline-behind-head` (stale) | 仍 `done`（非阻塞） | `true` |

## Connections

- [[engine_output]]（阶段 2）—— `lib/engine/output.js` 的 `validateOutput` 被本模块直接调用（第 400 行），本层在其「产物自身自洽」之上叠加「目标格式契约」与「基线可推进性」。output 判「页在不在/正文空不空/链接指的东西在不在计划内」，本层判「这批产物能不能被 wiki 采用」。
- [[engine_mapping]]（阶段 0）—— `lib/engine/mapping.js` 的 `mapFsoftOutput` 把 FSoft 文档树翻译成写集（`entry`/`articles`/`unmapped`），`WIKI_ENTRY`/`WIKI_META_REL` 常量也来自这里；whole-repository 的空归属证据正是由 mapping 决定（`attribution='unattributed'`、`sourceFiles=[]`）。
- [[article_contract]]—— `lib/article-contract.js` 的 `inspectArticle`/`parseFrontmatter`/`fencesBalanced` 是渲染后逐篇校验的复用点；`SEVERITY`（error 拒写 / warning 放行）决定了 defect 与 degradation 的分流。原生通道经 `NATIVE_REQUIRED_SECTIONS=[]` 与 `allowEmptySourceFiles` 关掉 agentic 通道的章节/来源硬判（第 80–85、357–359 行）。
- [[engine_contract]]（阶段 0）—— `lib/engine/contract.js` 的 `BLOCKER_KINDS` 是 `toContractBlockers` 的目标类别集；`ENGINE_STAGES` 里 `validate`（质量门）与 `baseline`（只有完整成功才推进）即本模块职责边界。
- [[engine_native_run]]（阶段 4）—— `lib/engine/native-run.js` 的 `runNativeJob` 把 `gateImpl` 串进裁决链（第 506 行），把 `report` 透传给 `apply-plan.js` 落地（第 609 行），并用 `weakest(...)` 合成终态（第 654 行）、`toContractBlockers(report)` 注入 blockers（第 660 行）。
- [[update_record]]（阶段 4）—— `lib/update-record.js` 的 `judgeOutcome` 接收 `toQualityIssues(report)` 作为 `options.qualityIssues`（第 100–102 行）；这正是防止「空 source_files 的页被 judgeOutcome 默默判成 done 并推进基线」的关键接线（测试第 211–224 行）。
- [[engine_apply_plan]]（落地器）—— `applyNativeOutput` 接收本模块的 `GateReport`（含 `articles`/`rendered`/`canAdvanceBaseline`），`advanceBaseline` 不接受调用方硬开、由裁决结果决定（native-run 第 613–614 行）。
- [[engine_python_entry]]—— FSoft 引擎侧产出 `docs` 树、`metadata.json`（`generation_info.commit_id`）、`module_tree.json`，是本模块读取的事实来源。

## Known Issues

- **未登记类别会被强制报错而非静默吞掉**（第 405–412、436 行）：`pushDefect`/`pushDegradation` 中 kind 不在冻结集合直接 `throw`；output.js 未来新增类别时，必须在本文件补映射，否则 gate 跑 `gateNativeOutput` 会抛 `未登记的 defect 类别`。这是故意的紧约束（测试第 185–193 行钉死），不是 bug。
- **空壳页的空正文判据要自己兜底**（第 362–371 行）：`output.js` 的 `bodyLength` 只跳过第一个标题行、`inspectArticle` 的 `empty-body` 只看 `body.trim()`，两条路都会把「只有 H1 的空壳页」放过。`checkRendered` 必须先用 `parseFrontmatter` 剥掉自己合成的 frontmatter 再算 `bodyLength`，否则空壳页永远判不出。
- **frontmatter 结束标记后不能插空行**（第 334–338 行）：`renderArticle` 刻意不插空行，否则 `parseFrontmatter` 会把空行算进 body，破坏「正文一字不动」的逐字比对——这条正是「wiki 里这篇 = 引擎产出的那篇」唯一可验证的形式。消费方若依赖「frontmatter 后空行」会踩坑。
- **`judgeOutcome` 自身看不见来源证据缺失**（测试第 211–224 行、注释第 601–605 行）：一篇「可写但 source_files 为空」的页在 `judgeOutcome` 眼里就是成功，会被判 `done` 并推进基线。本模块用 `toQualityIssues` 显式把 degradation 喂进去封堵；如果接线时漏掉这一步（例如阶段 4 没传 `qualityIssues`），空归属产物会被当成已消化，是真实可发生的基线错位缺陷。
- **真实产物（1C 全量）路径是绝对路径且本地依赖**（测试第 433–434 行 `E:/ik/Documents/...`）：`test-engine-quality-gate.mjs` 第 8 组「真实产物」用例依赖本地磁盘上的 `.probe-fsoft/wiki_out_1c/docs`，不存在时整个第 8 组 `SKIP`。CI/其它机器跑这套测试会部分跳过，不代表门逻辑未覆盖。
- **`assessBaseline` 默认 `requireCommittedInput=true`**（第 196–224 行）：测试里多数用例显式传 `requireCommittedInput: false` 来隔离 commit 判定；生产路径（native-run 第 506 行）也透传该开关。若某消费方误设为 true 又处于脏工作区，会多出 `uncommitted-input` defect 把 outcome 拉成 partial。
- **`dead-link` 只查 docs 内相对路径**（output.js 第 250–265 行）：指向仓库源文件（`../src/x.py`）的链接不在 docs 内，交给阶段 3 的 source 校验；跨页 `.md` 链接不在本次产出里才算死链。外链（http:/mailto:/data:）不查（第 148 行）。

