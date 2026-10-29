---
title: engine_quality_gate
type: module
source_files:
  - lib/engine/quality-gate.js
  - test-engine-quality-gate.mjs
  - lib/engine/output.js
  - lib/article-contract.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/update-record.js
tags: [quality-gate, engine, native, baseline, wiki-adoption]
---

## Overview

`engine_quality_gate` 是迁移管道里**阶段 3**的「采用门」（quality gate），实现于 `lib/engine/quality-gate.js`。它处在引擎把 `docs` 树交回来之后、内容被写进 `.codewiki/` 与 `CodeWiki.md` 之前（见文件头注释 `lib/engine/quality-gate.js:1-33`）。

阶段 2 的 `output.js`（`lib/engine/output.js`）只判「产物自身是否自洽」——页在不在、正文空不空、链接指向的东西在不在计划内。这一层（`quality-gate.js`）判的是更高的一个问题：**这批产物能不能被 wiki 采用**。它把三件事合成一个可机读的裁决（`lib/engine/quality-gate.js:4-13`）：

1. **产物自洽**：复用 `output.js` 的 `validateOutput`，不重写任何判定；
2. **目标格式契约**：把映射结果渲染成真正的 wiki 文章（frontmatter + 正文），再走 `article-contract.js` 的 `inspectArticle`（frontmatter 唯一闭合 / 围栏 / 死链 / source_files 证据 / 类型与位置匹配）；
3. **基线可推进性**：产物对应的 commit 必须是**已提交**的 HEAD，且 `.codewiki/_meta.yaml` 的基线本身已入库——未提交的工作区内容不得被当成已提交基线。

### 三类问题必须分开（本模块存在的核心理由）

0.14.0 的教训是「1 篇成功 + 19 篇失败也报 done」。但反过来把一切都塞进一个 `blockers` 数组同样有害：引擎会被归咎于不是它的问题，或 wiki 的陈旧状态被当成产品缺陷，两条路都会让运维在错的地方找原因。所以分类是机读的（`lib/engine/quality-gate.js:15-33`）：

- **defect（产品缺陷）**：本次引擎产物自身的问题（缺入口 / 缺页 / 空正文 / 死链 / source_files 指向不存在的文件 / frontmatter 坏了 / 围栏未闭合 / 产物对应 commit 不是 HEAD）。处置：不让它算完整成功。
- **degradation（能力降级）**：产物可用但证据不足（whole-repository 模式下 `module_tree` 为空 → 页没有归属与 source_files；有页映射不进 wiki）。处置：可以入库，但**增量 ownership 不可信，因此不得推进基线**。
- **stale（wiki 状态陈旧）**：不是本次产物的错（既有 wiki 的基线落后 HEAD、基线只在工作区未提交）。处置：如实报告；只有「基线未入库」这一条会阻止推进。

终态仍然严格：**只有三类皆空才是 done**。分类改变的是「谁来修、修什么」的定位，不是放宽闸门（`lib/engine/quality-gate.js:32-33`）。

## Key Components

### 常量与分类表（机读、稳定、只允许追加）

- `GATE_VERSION`（`lib/engine/quality-gate.js:42`）— 门版本号，固定为 `1`，写入 `GateReport.version`。
- `GATE_DEFECT_KINDS`（`lib/engine/quality-gate.js:45-59`，`Object.freeze`）— defect 类别列表（产品缺陷）：`missing-docs-dir`、`missing-metadata`、`missing-module-tree`、`bad-json`、`entry-missing`、`empty-body`、`article-missing`、`unmapped-page`、`source-missing`、`dead-link`、`article-contract`、`commit-mismatch`、`uncommitted-input`。
- `GATE_DEGRADATION_KINDS`（`lib/engine/quality-gate.js:61-66`，`Object.freeze`）— degradation 类别：`empty-module-tree`、`no-source-evidence`、`missing-section`、`empty-section-optional`。
- `GATE_STALE_KINDS`（`lib/engine/quality-gate.js:68-72`，`Object.freeze`）— stale 类别：`baseline-behind-head`、`baseline-uncommitted`、`baseline-absent`。
- `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET`（`lib/engine/quality-gate.js:74-76`）— 上面的列表转成的 `Set`，供 `pushDefect` / `pushDegradation` 在运行时校验「未登记的类别一律抛错」。
- `NATIVE_REQUIRED_SECTIONS`（`lib/engine/quality-gate.js:86`，`Object.freeze([])`）— 原生通道**不沿用** agentic 通道的 Overview/Key Components 章节要求，传空数组只查结构（见注释 `lib/engine/quality-gate.js:80-85`）。
- `WIKI_PATHS`（`lib/engine/quality-gate.js:156`，`Object.freeze(['.codewiki/', 'CodeWiki.md'])`）— 判定「未提交改动」时，wiki 自身产物不算脏。
- `SHA_RE`（`lib/engine/quality-gate.js:109`）— 40 位 hex SHA 校验正则。
- `YAML_UNSAFE_HEAD`（`lib/engine/quality-gate.js:264`）/ `YAML_RESERVED`（`lib/engine/quality-gate.js:266`）/ `YAML_NUMBER`（`lib/engine/quality-gate.js:267`）— `yamlScalar` 判断「裸值是否不安全」的正则与保留字表。
- `TO_CONTRACT_KIND`（`lib/engine/quality-gate.js:572-587`）— gate 的 `blockers.kind` → `contract.js` 的 `BLOCKER_KINDS` 映射表；一一对应不了的归 `'quality-gate'`，`baseline-uncommitted` 映射为 `baseline-failed`。

### git 只读助手

- `git(repoRoot, args, { timeout })`（`lib/engine/quality-gate.js:90-102`）— 封装 `execFileSync('git', ...)`，失败（非 0 / 超时）一律返回 `null`，不抛异常。
- `parseMetaCommit(text)`（`lib/engine/quality-gate.js:104-107`）— 从 YAML 文本里提取 `last_compiled_commit:` 行的值，去掉可选引号；没有则返回 `null`。

### 基线裁决相关

- `readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })`（`lib/engine/quality-gate.js:117-151`）— 读**已提交**的编译基线。关键：用 `git show HEAD:<rel>` 而不是工作区文件（原因见 `lib/engine/quality-gate.js:215-220`）。返回值含字段：`ok`(bool)、`source`(`'absent' | 'git-head' | 'worktree-only'`)、`commit`(string|null)、`worktreeCommit`(string|null)、`dirty`(bool)、`reason`(string)。三种 source：HEAD 里有 → `git-head`；工作区有但 HEAD 没有 → `worktree-only`（ok=false, dirty=true，未入库不能当基线）；都不存在 → `absent`（首次编译）。
- `uncommittedSourceChanges({ repoRoot })`（`lib/engine/quality-gate.js:158-174`）— 跑 `git status --porcelain --untracked-files=all`，过滤掉 `WIKI_PATHS`（`.codewiki/`、`CodeWiki.md`）后返回非 wiki 的未提交改动路径列表。返回 `{ ok, paths, reason }`。
- `assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput = true })`（`lib/engine/quality-gate.js:188-244`）— 判「这批产物的基线能不能被推进」。当 `requireCommittedInput` 关闭时直接放行（`ok=true`, `writable=true`，见 `lib/engine/quality-gate.js:196-198`）。否则校验：未给 repoRoot → defect `commit-mismatch`；无 HEAD → defect `commit-mismatch`；`artifactCommit` 缺失/非 40 位 SHA/不等于 HEAD → defect `commit-mismatch`；工作区有非 wiki 未提交改动 → defect `uncommitted-input`（`lib/engine/quality-gate.js:200-224`）。基线陈旧在 `lib/engine/quality-gate.js:227-238`：absent → stale `baseline-absent`；未入库/脏 → stale `baseline-uncommitted`；基线落后 HEAD → stale `baseline-behind-head`。返回 `{ ok, headCommit, artifactCommit, defects, stale, writable }`，其中**只有 `baseline-uncommitted` 这一类陈旧会阻止推进**（`lib/engine/quality-gate.js:240-243`）。

### 文章渲染（格式翻译，不改正文）

- `oneLine(s)`（`lib/engine/quality-gate.js:248-250`）— 把字符串换行压成单行并 trim，用于 title。
- `yamlScalar(value)`（`lib/engine/quality-gate.js:269-288`）— YAML 标量安全序列化。只在确实不安全时才加双引号（用 `JSON.stringify`，因 YAML 1.2 是 JSON 超集）。不安全判定覆盖：首尾空格、控制字符、换行/回车、反斜杠、`: `/`: `结尾、` #`/`#` 开头、YAML 特殊首字符、`true/false/yes/no/...` 保留字、数字形态（见 `lib/engine/quality-gate.js:264-287`）。安全值（如 `change_set`、`src/core/engine.py`）保持裸写，与既有文章 frontmatter 观感一致。
- `titleOf(bodyText, fallback)`（`lib/engine/quality-gate.js:291-297`）— 从正文第一行的 H1（`# ...`）提取标题，提不到则回退到 `fallback`。
- `renderArticle({ article, body })`（`lib/engine/quality-gate.js:316-340`）— 把映射出的一篇文章渲染成 wiki 文章的**完整文本**：合成的 frontmatter + FSoft 原文。三条硬约束（见 `lib/engine/quality-gate.js:299-315`）：① 正文一字不动（不删 H1、不改链接、不补章节）；② frontmatter 只填有证据的字段（`source_files` 原样来自映射，空就显式写 `source_files: []`）；③ 可回溯（`fsoft_page` 记住正文来自 FSoft 原始树的哪个文件）。frontmatter 结束标记后**不插空行**，以便逐字比对（`lib/engine/quality-gate.js:334-338`）。
- `checkRendered({ content, article, cwd, fsoftPage })`（`lib/engine/quality-gate.js:346-373`）— 渲染后的逐篇检查：先走 `inspectArticle`（复用，传入 `requiredSections: NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles: true`、`fsImpl: null`，见 `lib/engine/quality-gate.js:347-360`），再补两条原生通道专属判据：剥掉**自己合成**的 frontmatter 后用 `bodyLength` 判「除标题外有没有正文」，空则加 `empty-body` error（`lib/engine/quality-gate.js:362-372`）。返回 `{ issues, fsoftPage }`。

### 主入口与下游适配

- `gateNativeOutput({ docsDir, repoRoot, componentFiles = {}, overviewName = 'overview.md', baseline, requireCommittedInput = true, includeContent = true })`（`lib/engine/quality-gate.js:390-568`）— 对一批原生产物做采用裁决，**纯组合**：读产物（`validateOutput`）→ 渲染 → 契约 → 基线。内部 `pushDefect`/`pushDegradation`（`lib/engine/quality-gate.js:405-412`）会校验类别已登记。`GateReport`（返回值，可 JSON 序列化）字段如下：
  - `version`（`GATE_VERSION`）、`ok`（`outcome === 'done'`）、`outcome`（`'failed' | 'partial' | 'done'`）、`writable`（有可读入口才 true）、`canAdvanceBaseline`（`outcome === 'done'`）。
  - `entry`：`{ source, path, ok }` 入口页信息。
  - `articles`：逐篇对象数组，字段含 `source`、`wikiPath`、`type`、`pageKind`、`moduleName`、`sourceFiles`、`attribution`、`action`(`'write' | 'skip'`)、`defects`、`degradations`。
  - `rendered`：当 `includeContent && 无 pageDefects` 时带上的 `{ source, wikiPath, type, content }` 渲染正文（`lib/engine/quality-gate.js:514`）。
  - `defects` / `degradations` / `stale`：三类问题数组，元素含 `kind`、`scope`、`detail`、`source`、`target`。
  - `blockers`：阻塞列表（defects + degradations + 仅 `baseline-uncommitted` 的 stale，见 `lib/engine/quality-gate.js:527-531`）。
  - `counts`：`{ pages, articles, writable, skipped, unmapped, defects, degradations, stale }`。
  - `baseline`：`{ headCommit, artifactCommit, source }`。
  - 终态合成：`writable` 为 false → `failed`；`blocking.length > 0` → `partial`；否则 `done`（`lib/engine/quality-gate.js:533-536`）。
- `toContractBlockers(report)`（`lib/engine/quality-gate.js:589-596`）— 把 `report.blockers` 翻成 `contract.js` 的 `BLOCKER_KINDS` 形态：`kind` 经 `TO_CONTRACT_KIND` 映射（落不进的一律 `'quality-gate'`），`detail` 保留原 `kind/scope` 前缀并截断到 2000 字符，附带 `source`/`target`。
- `toQualityIssues(report)`（`lib/engine/quality-gate.js:610-624`）— 把 gate 结论翻成 `update-record` 的 `qualityIssues`（`[{ name, issue }]`，`judgeOutcome` 的输入之一）。合并 degradations + defects + **仅 `baseline-uncommitted`** 的 stale（基线落后 HEAD 不算，见 `lib/engine/quality-gate.js:599-603`）。这是防止「可写但 source_files 为空」的页被 `judgeOutcome` 判成 done 的关键接线（见 `lib/engine/quality-gate.js:598-605`）。

## Architecture

`gateNativeOutput` 是一个纯组合函数：它自己不读正文语义，而是把上游 `output.js`、`article-contract.js` 的判定与 git 基线状态拼成一份 `GateReport`，再通过两个适配器（`toContractBlockers` / `toQualityIssues`）接入下游契约。组件关系如下：

```text
            docsDir / repoRoot / componentFiles / baseline
                          │
                          ▼
   ┌─────────────────────────────────────────────────────┐
   │ gateNativeOutput (quality-gate.js:390)              │
   │   纯组合：读产物→渲染→契约→基线                       │
   └───────────────┬───────────────┬───────────┬────────┘
                   │               │           │
       ┌───────────▼────┐   ┌──────▼──────┐  ┌─▼──────────────────┐
       │ validateOutput │   │ renderArticle│  │ assessBaseline      │
       │ (output.js:184)│   │ (qg:316)     │  │ (qg:188)            │
       │ → problems     │   │ → wiki text  │  │ → defects + stale   │
       └────────┬───────┘   └──────┬──────┘  │  ├ readCommittedBaseline │
                │                  │         │  │   (qg:117 git HEAD)    │
                │                  │         │  │  └ uncommittedSource-   │
                │                  │         │  │     Changes (qg:158)   │
   problems ────┤ defect/degradation 分派    │  └───────────────────────┘
                │ (qg:418-437)     │         │
                │                  │         │
                │          checkRendered (qg:346)
                │          → inspectArticle (article-contract.js:213)
                │            + bodyLength empty-body
                ▼                   ▼
        ┌───────────────────────────────────────┐
        │ GateReport (defects/degradations/stale │
        │  + articles + rendered + blockers)     │
        └───────┬───────────────────────┬───────┘
                │                       │
      ┌─────────▼────────┐    ┌─────────▼─────────┐
      │ toContractBlockers│    │ toQualityIssues   │
      │ (qg:589) →        │    │ (qg:610) →        │
      │ contract.js       │    │ update-record.js  │
      │  BLOCKER_KINDS    │    │  judgeOutcome     │
      └──────────────────┘    └───────────────────┘
```

关键边界（来自源码注释）：
- `output.js` 只判「产物自洽」，`quality-gate.js` 只判「能否被采用」——前者是后者的子检查（`lib/engine/output.js:14-15`）。
- `renderArticle` 正文**一字不动**；frontmatter 结束符后不插空行，保证逐字可比对（`lib/engine/quality-gate.js:303-338`）。
- 原生通道不要求 Overview/Key Components 章节（`NATIVE_REQUIRED_SECTIONS = []`），否则 FSoft 正文会被误判成不可修复的 warning（`lib/engine/quality-gate.js:80-85`）。
- `source_files` 存在性只在 `output.js` 判一次（`qg:353-355` 注释说明 `checkRendered` 不再判一遍，避免同一条缺陷翻倍）。

## Data Flow

`gateNativeOutput` 一次性跑完六个阶段，数据在各阶段间流动如下（`lib/engine/quality-gate.js:390-568`）：

1. **读产物（产物自洽）**：调用 `validateOutput({ docsDir, repoRoot, componentFiles, overviewName })`（`lib/engine/quality-gate.js:400`），拿到 `validation.collected`（页清单 + 四个 JSON）、`validation.mapped`（映射出的 entry/articles/unmapped）、`validation.problems`。
2. **problem 分流（defect / degradation）**：遍历 `validation.problems`（`lib/engine/quality-gate.js:418-437`）：
   - `empty-module-tree` → 降级为 degradation（页照写，增量归属不可用）；
   - `article-missing` / `unmapped-page` → defect；
   - 其余已在 `GATE_DEFECT_KINDS` 中的 → defect；
   - 未来 output.js 新增、未登记的类别 → 兜底成 `article-contract` defect（逼这里补映射）。
3. **入口校验**：读 `mapped.entry.source`（`lib/engine/quality-gate.js:440-462`），不可读 → defect `entry-missing` 且 `entry.ok=false`；正文空 → defect `empty-body`；围栏未闭合 → defect `article-contract`。没有 entry 则 `writable=false`。
4. **逐篇渲染 + 契约**（对每个 `mapped.articles`，`lib/engine/quality-gate.js:467-515`）：
   - 读原文 → `renderArticle` 渲染成带 frontmatter 的 wiki 文本；
   - `checkRendered` 调 `inspectArticle`，error 级 → pageDefects（记成 `article-contract` defect），warning 级 → pageDegradations（记成 `missing-section` 或既有 degradation）；
   - 剥自己合成的头后用 `bodyLength` 兜住「空壳页」（`lib/engine/quality-gate.js:362-372`）；
   - `sourceFiles` 为空 → degradation `no-source-evidence`（`lib/engine/quality-gate.js:497-501`）；
   - 汇总出 `articles[i]`（`action = pageDefects.length ? 'skip' : 'write'`），无缺陷页进 `rendered`。
5. **基线**：从 `collected.json.metadata.generation_info.commit_id` 取 `treeCommit`（`lib/engine/quality-gate.js:518`），调 `assessBaseline` → 把返回的 `defects` 并入全局 defects，`stale` 单独保留。
6. **终态合成**（严格：三类皆空才 done，`lib/engine/quality-gate.js:525-536`）：`blocking = defects + degradations + 仅 baseline-uncommitted 的 stale`；`writable` 为 false → `failed`；`blocking.length>0` → `partial`；否则 `done`。`canAdvanceBaseline = (outcome === 'done')`。

下游接线（两个适配器）：
- `toContractBlockers(report)` → 产出 `contract.js` 的 `BLOCKER_KINDS` 列表（`lib/engine/quality-gate.js:589-596`），供 JobService 终态判定 / 面板 / 自动提交使用。
- `toQualityIssues(report)` → 产出 `qualityIssues`（`lib/engine/quality-gate.js:610-624`），喂给 `update-record.js` 的 `judgeOutcome`，防止「可写但 source_files 为空」的页被独立判成 done 并推进基线（`lib/engine/quality-gate.js:598-605`、测试 `test-engine-quality-gate.mjs:211-224`）。

## Connections

- [[engine_output]] — 阶段 2 的产物自洽校验（`validateOutput` / `bodyLength` / `OUTPUT_PROBLEM_KINDS`），本模块的 defect/degradation 大部分直接复用其 `problems`，并在 `gateNativeOutput` 里做类别分流（`lib/engine/quality-gate.js:390,418-437`）。
- [[article_contract]] — `inspectArticle` / `parseFrontmatter` / `fencesBalanced` 的 error/warning 级判据，被 `checkRendered` 与入口校验复用（`lib/engine/quality-gate.js:346-373,456-459`）。
- [[engine_mapping]] — 产物 → wiki 的映射（`mapFsoftOutput`），导出 `WIKI_ENTRY` / `WIKI_META_REL`（`lib/engine/quality-gate.js:40`）。`gateNativeOutput` 的 `mapped` 即来自它。
- [[engine_contract]] — 下游 `BLOCKER_KINDS` 与跨进程契约语义（`lib/engine/contract.js:57-72`），`toContractBlockers` 把门结论翻成契约阻塞（`lib/engine/quality-gate.js:572-596`）。
- [[update_record]] — `judgeOutcome` 的终态判定接收 `toQualityIssues` 产出的 `qualityIssues`，保证「可写但无来源证据」不误判 done（`lib/engine/quality-gate.js:610-624`、`lib/update-record.js:37`）。
- [[engine_native_run]] / [[engine_native_state]] — 调用 `gateNativeOutput` 的上游任务执行与状态机（终态 done/partial/failed 的消费者）。

## Known Issues

- **基线陈旧只有一条会阻塞**：`assessBaseline` 中只有 `baseline-uncommitted`（基线只在工作区未提交）会阻止推进（`lib/engine/quality-gate.js:188-244`）；`baseline-behind-head`、`baseline-absent` 只报告不阻塞（设计如此，本轮编译正是为了消化落后基线）。评审时若误以为「陈旧一律阻塞」会读错终态。
- **原生通道不查章节 / 不查来源存在性**：`checkRendered` 传 `requiredSections: NATIVE_REQUIRED_SECTIONS`（`[]`）且 `fsImpl: null`（`lib/engine/quality-gate.js:346-359`）。因此原生页的 Overview/Key Components 章节、source_files 存在性**不在本层判**——它们依赖 `output.js` 在阶段 2 已判过一次（`lib/engine/output.js:235-248`）。若上游那次判定被移除，门会静默漏掉这类 defect。空 `source_files` 降级为 degradation 而非拒写（`allowEmptySourceFiles: true`，`lib/engine/quality-gate.js:359`）。
- **空壳页兜底依赖自建 frontmatter 剥离**：`inspectArticle` 的 `empty-body` 判的是 `body.trim()`（有 H1 即非空），`bodyLength` 只跳过首个标题行——两者都会放过「只有标题」的空壳页。门因此额外剥掉自己合成的 frontmatter 再判（`lib/engine/quality-gate.js:362-372`），这条兜底一旦误删，空壳页会被判可写。
- **`requireCommittedInput=false` 会完全绕过 commit/stale 检查**：此时 `assessBaseline` 直接返回 `ok:true, writable:true`（`lib/engine/quality-gate.js:188-198`）。测试里大量用 `requireCommittedInput: false` 隔离 git 状态；生产调用必须保持默认 `true`，否则未提交工作区会被当已提交基线。
- **`parseMetaCommit` 只认 `last_compiled_commit:` 一行**：窄正则（`lib/engine/quality-gate.js:104-107`），不会读其它键；基线文件若改格式需同步此处。
- **测试对作者机器路径硬编码**：`test-engine-quality-gate.mjs:433-434` 的 `REAL` / `REAL_REPO` 指向 `E:/ik/Documents/trae_projects/...` 绝对路径，其它环境（含 CI）会整组 `SKIP`（`test-engine-quality-gate.mjs:436-437`），真实产物的那批断言不会在主干上跑。
- **无被注释 / 禁用的功能**：本模块没有发现被 `#` 注释掉或 `disabled` 的逻辑分支；所有分类、`TO_CONTRACT_KIND` 映射、`NATIVE_REQUIRED_SECTIONS` 均为 `Object.freeze` 的生效常量。
