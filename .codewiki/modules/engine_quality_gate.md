---
title: engine_quality_gate
type: module
source_files:
  - lib/engine/quality-gate.js
  - test-engine-quality-gate.mjs
  - lib/engine/output.js
  - lib/article-contract.js
  - lib/engine/mapping.js
  - lib/update-record.js
tags: [engine, quality-gate, native-output, baseline, article-contract]
---

## Overview

`lib/engine/quality-gate.js` 是引擎流水线的**阶段 3：采用门（quality gate）**。它位于
`output.js`（阶段 2，只判「产物自身是否自洽」）之后、把 docs 树写进 `.codewiki/` 与
`CodeWiki.md` 之前。它把三件事合成为一个可机读的裁决（GateReport）：

1. **产物自洽**：复用 `output.js` 的 `validateOutput`（`lib/engine/output.js:184`），不重写任何判定。
2. **目标格式契约**：把映射结果用 `renderArticle` 渲染成真正的 wiki 文章（合成的 frontmatter
   + FSoft 原文正文），再走 `article-contract.js` 的 `inspectArticle`（`lib/article-contract.js:213`）——
   frontmatter 唯一闭合 / 围栏 / 死链 / source_files 证据 / 类型与位置匹配。
3. **基线可推进性**：产物对应的 commit 必须是**已提交**的 HEAD，且 `.codewiki/_meta.yaml` 的基线
   本身已入库——未提交的工作区内容不得被当成已提交基线。

模块存在的核心理由是**把三类问题分开**（注释见 `lib/engine/quality-gate.js:15`）。0.14.0 的教训是
「1 篇成功 + 19 篇失败也报 done」；但反过来把所有问题塞进一个 `blockers` 数组同样有害：引擎会被
归咎于不是它的问题，或 wiki 的陈旧状态被当成产品缺陷，两条路都让运维在错的地方找原因。因此分类是
**机读的**，消费者按 `kind` 分派：

- **defect（产品缺陷）**：本次引擎产物自身的问题（缺入口/缺页/空正文/死链/source_files 指向不存在的
  文件/frontmatter 坏了/围栏未闭合/产物对应的 commit 不是 HEAD）。处置：不让它算完整成功。
- **degradation（能力降级）**：产物可用但证据不足（whole-repository 模式下 `module_tree` 为空 →
  页没有归属与 source_files；有页映射不进 wiki）。处置：可以入库，但**增量 ownership 不可信，因此
  不得推进基线**。注意与 defect 的差别：页是真的、内容是真的，只是没法归属。
- **stale（wiki 状态陈旧）**：不是本次产物的错（既有 wiki 的基线落后 HEAD、基线只在工作区未提交）。
  处置：如实报告；只有「基线未入库」这一条会阻止推进（把未提交状态固化成已提交基线是不可逆的记账错误）。

终态仍然严格：**只有三类皆空才是 `done`**。分类改变的是「谁来修、修什么」的定位，不是放宽闸门——放宽
正是迁移里最危险的方向。

## Key Components

全部公开 API 通过具名导出与 `export default` 双重暴露（`lib/engine/quality-gate.js:626`）。下面是
模块的公开常量、函数与内部关键助手（均带真实行号）。

### 常量（公开导出）

- `GATE_VERSION`（`42|`）：采用门 schema 版本，当前固定为 `1`，写入 `GateReport.version`。
- `GATE_DEFECT_KINDS`（`45|`）：`Object.freeze` 的产品缺陷类别表，稳定、可机读，新增只允许追加。
  值见下：`missing-docs-dir`、`missing-metadata`、`missing-module-tree`、`bad-json`、
  `entry-missing`、`empty-body`、`article-missing`、`unmapped-page`、`source-missing`、
  `dead-link`、`article-contract`、`commit-mismatch`、`uncommitted-input`。
- `GATE_DEGRADATION_KINDS`（`61|`）：能力降级类别表。值：`empty-module-tree`、

  `no-source-evidence`、`missing-section`、`empty-section-optional`。
- `GATE_STALE_KINDS`（`68|`）：wiki 状态陈旧类别表。值：`baseline-behind-head`、
  `baseline-uncommitted`、`baseline-absent`。
- `NATIVE_REQUIRED_SECTIONS`（`86|`）：原生通道传给 `inspectArticle` 的章节白名单，固定为 `[]`。
  原因见文件注释 `80|`：FSoft 正文由上游 prompt 决定（如 `## Introduction and Purpose`），计划硬约束是
  「不改技术内容」，用 agentic 通道的 `Overview`/`Key Components` 去判它，每条都是不可修复的 warning，
  闸门会退化成噪声。「至少一个非空二级标题」由 `renderArticle` 渲染后的 `checkRendered` 单独判。

### 内部集合与助手

- `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET`（`74|`、`75|`、`76|`）：把三类类别表转成 `Set`，供
  `gateNativeOutput` 分派时校验「写进的 kind 必须已登记」，未登记一律报错（`406|`、`410|`）。
- `posix`（`78|`）：把反斜杠统一成 `/`，并兜底 `null`/`undefined`。
- `git`（`90|`）：只读 git 助手，用 `execFileSync` 调用 `git`，失败（含超时 15s）统一返回 `null`
  而非抛异常，让「 git 命令失败」变成一个可上报的状态而不是崩溃。
- `parseMetaCommit`（`104|`）：用正则从 `_meta.yaml` 文本里抓 `last_compiled_commit:` 行的值，
  去掉可选的引号。
- `SHA_RE`（`109|`）：40 位 hex sha 校验正则。
- `WIKI_PATHS`（`156|`）：`['.codewiki/', 'CodeWiki.md']`，`uncommittedSourceChanges` 用来把「wiki 自身
  产物」排除在「未提交源码改动」之外。
- `oneLine`（`248|`）：把多行文本压成单行、去首尾空白，供 `titleOf` 提取标题用。
- `YAML_UNSAFE_HEAD` / `YAML_RESERVED` / `YAML_NUMBER`（`264|`、`266|`、`267|`）：`yamlScalar`
  判定「裸值不安全」的正则与保留字集合（详见 `yamlScalar`）。

### 公开函数

- **`readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })`**（`117|`，WIKI_META_REL 来自
  `lib/engine/mapping.js:32`）：读**已提交**的编译基线，而非工作区文件。返回对象字段：
  - `ok: boolean` —— 是否拿到有效的已提交基线；
  - `source: string` —— `'git-head' | 'worktree-only' | 'absent'`；
  - `commit: string|null` —— `HEAD` 里 `_meta.yaml` 的 `last_compiled_commit`；
  - `worktreeCommit: string|null` —— 工作区同名文件的 commit（用于比对是否 dirty）；
  - `dirty: boolean` —— 工作区值是否与 `HEAD` 值不一致；
  - `reason: string` —— 人类可读原因。
  关键逻辑：通过 `git('show', 'HEAD:' + rel)`（`126|`）读取已提交内容；工作区文件仅用
  `fs.readFileSync` 辅助比对。若 `HEAD` 里没有但该文件在工作区存在（`140|`），`source='worktree-only'`、
  `ok=false`、`dirty=true`——这是「基线未入库」的判定来源，是**唯一会阻止推进**的陈旧。

- **`uncommittedSourceChanges({ repoRoot })`**（`158|`）：用 `git status --porcelain
  --untracked-files=all`（`161|`）列出**非 wiki** 的未提交改动。返回 `{ ok, paths, reason }`；
  `paths` 已被 `WIKI_PATHS` 过滤掉 `.codewiki/` 与 `CodeWiki.md` 自身。这是判断「产物反映的内容是否在
  某个 commit 里」的依据。

- **`assessBaseline({ repoRoot, artifactCommit, baseline, requireCommittedInput = true })`**（`188|`）：
  判「这批产物的基线能不能被推进」。返回 `{ ok, headCommit, artifactCommit, defects, stale, writable }`。
  - 若 `requireCommittedInput=false`（`196|`）直接放行（`ok=true, writable=true`）；
  - 否则比对 `artifactCommit`（产物 `metadata.generation_info.commit_id`）与 `git rev-parse HEAD`
    （`192|`）：缺 commit / 不是 40 位 sha / 与 HEAD 不符 → `defect: commit-mismatch`；
  - 通过 `uncommittedSourceChanges` 检查工作区脏否 → `defect: uncommitted-input`（`215|`）；
  - 基线本身的陈旧只报告不归咎引擎（`227|`）：`baseline-absent` / `baseline-uncommitted` /
    `baseline-behind-head`；
  - **只有 `baseline-uncommitted` 这一条陈旧会阻止推进**（把未提交状态记成已消化是不可逆的），
    见 `blockingStale` 过滤（`241|`）；`ok = defects.length===0 && blockingStale.length===0`（`242|`）。

- **`yamlScalar(value)`**（`269|`）：YAML 标量的安全序列化。只在**确实不安全**时才加双引号，
  且用 `JSON.stringify` 得到合法 YAML 双引号标量（YAML 1.2 是 JSON 超集）。不安全情形
  （`plainUnsafe`，`273|`）包括：首尾空格、控制字符、换行/回车、反斜杠（Windows 路径）、`: `/`:` 结尾、
  ` #`/`#` 开头、`YAML_UNSAFE_HEAD` 首字符、`YAML_RESERVED` 保留字（true/false/yes/no/…）、
  `YAML_NUMBER` 数字形态。该函数的所有危险值都已在测试 `test-engine-quality-gate.mjs:338` 钉死「写进
  frontmatter 后能被 `parseFrontmatter` 读回原字符串且 JSON 合法」。

- **`titleOf(bodyText, fallback)`**（`291|`）：从正文第一行 `# 标题` 提取 H1 文本（`293|`）作为
  frontmatter 的 `title`；提不到则用 `fallback`（通常是模块名）。

- **`renderArticle({ article, body })`**（`316|`）：把映射出的一篇文章渲染成 wiki 文章的**完整文本**
  ——合成 frontmatter + FSoft 原文。三条硬约束（测试钉死 `test-engine-quality-gate.mjs:314`）：
  1. **正文一字不动**（不删 H1、不改标题、不重写链接、不补章节）（`318|` 仅 `stripBOM`）；
  2. **frontmatter 只填有证据的字段**：`source_files` 原样来自映射（`321|`），空列表显式写成
     `source_files: []`（`328|`）以区分「声明为空」与「没声明」；`type` 来自映射（`320|`）；
     固定写 `tags: []`（`331|`）、`generated_by: fsoft-native`（`332|`）；
  3. **可回溯**：`fsoft_page` 记下正文来自 FSoft 原始树的哪个文件（`333|`）。
     结束标记 `---` 后**不插空行**（`338|`），保证「wiki 里的这篇 = 引擎产出的那篇」可逐字比对。

- **`checkRendered({ content, article, cwd, fsoftPage })`**（`346|`）：渲染后的逐篇检查。先走
  `inspectArticle`（`347|`，`requiredSections: NATIVE_REQUIRED_SECTIONS`、`allowEmptySourceFiles: true`、
  `fsImpl: null`、`readableSources: null`、`allowedLinks: null`），再补两条原生通道专属判据：
  剥掉**自己合成**的 frontmatter 后算 `bodyLength`（来自 `output.js:127`），若 `===0` 则加
  `empty-body` error（`368|`）——这是因为 `inspectArticle` 的 empty-body 看 `body.trim()`，H1 在就非空，
  会放过空壳页，这里用剥头后的正文兜住。返回 `{ issues, fsoftPage }`。

- **`gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput,
  includeContent })`**（`390|`）：主入口。纯组合流水线，返回 `GateReport`（可 JSON 序列化）。
  内部步骤：
  1. 调 `validateOutput`（`400|`）得到 `collected`/`mapped`/`problems`；
  2. 把 `validation.problems` 按 kind 分流（`418|`）：`empty-module-tree` → degradation（`420|`）；
     `article-missing`/`unmapped-page`/已登记 defect → defect（`424|`、`428|`、`432|`）；未登记类别一律
     当成 `article-contract` 报出来（`436|`），逼上层补映射；
  3. 入口检查（`440|`）：无 overview → 整批不可入库（`entry.ok=false`）；读不到 / 空正文 / 围栏未闭合
     → `entry-missing`/`empty-body`/`article-contract`（示例 `449|`、`454|`、`459|`）；
  4. 逐篇渲染 + 契约（`467|`）：读正文 → `renderArticle` → `checkRendered`；error 级 issue →
     `article-contract` defect（`487|`），warning 级 → degradation（`492|`）；空 `source_files`
     → `no-source-evidence` degradation（`497|`）；每篇记 `articles[]` 与（无 defect 时）`rendered[]`
     （`502|`、`514|`）；
  5. 基线（`518|`）：取 `collected.json.metadata.generation_info.commit_id` 作 `artifactCommit`，
     调 `assessBaseline`（`519|`）；
  6. 终态合成（`526|`）：`writable = entry && entry.ok`；`blocking` 合并 defects + degradations +
     `baseline-uncommitted` stale（`527|`）；`outcome = !writable ? 'failed' : blocking.length ?
     'partial' : 'done'`（`533|`）。
  返回字段见源码 `538|`：`version`、`ok`、`outcome`、`writable`、`canAdvanceBaseline`、`entry`、
  `articles`、`rendered`、`defects`、`degradations`、`stale`、`blockers`、`counts`
  （`pages/articles/writable/skipped/unmapped/defects/degradations/stale`）、`baseline`
  （`headCommit/artifactCommit/source`）。

- **`toContractBlockers(report)`**（`589|`）：把 `GateReport.blockers` 翻成 `contract.js` 的
  `BLOCKER_KINDS`（`lib/engine/contract.js`）。一一对应不了的一律归 `'quality-gate'`
  （`591|`），并保留原 kind 在 `detail` 里（`592|`）。映射表 `TO_CONTRACT_KIND`（`572|`）。

- **`toQualityIssues(report)`**（`610|`）：把 gate 结论翻成 `update-record.js` 的 `qualityIssues`
  （`judgeOutcome` 的输入之一）。逻辑（见 `612|`）：degradations + defects 全量转成
  `{name, issue}`，stale 里**只有 `baseline-uncommitted` 算阻塞**（`621|`），其余（如基线落后 HEAD）
  混入会让每次增量都落 partial。这是防止「可写但空 source_files 的页被 `judgeOutcome` 默默算成功并推进
  基线」的关键接线（测试 `test-engine-quality-gate.mjs:211` 专门验证了盲区）。

## Architecture

组件 ≥3，且主入口 `gateNativeOutput`（`lib/engine/quality-gate.js:390`）是明确的组合流水线。下面是
采用门的组件关系框图（箭头表示「调用 / 数据流」）：

```text
                docsDir + repoRoot + componentFiles
                              │
                              ▼
                  ┌───────────────────────────┐
                  │ gateNativeOutput (390)     │  主入口：组合 + 终态合成
                  └─────────────┬─────────────┘
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
 ┌──────────────────┐  ┌────────────────┐  ┌──────────────────────┐
 │ output.js        │  │ mapping.js     │  │ assessBaseline (188) │
 │ validateOutput   │  │ mapFsoftOutput │  │  ├ git rev-parse HEAD│
 │ (184)            │  │ (115)          │  │  ├ uncommittedSource │
 │  problems→分流    │  │  articles/entry│  │     Changes (158)    │
 │  defect/deg.     │  │                │  │  └ readCommittedBase-│
 └────────┬─────────┘  └───────┬────────┘  │     line (117)        │
          │                    │           └───────────┬──────────┘
          │   problems 按 kind 分流     articles[]      │  baseline{ok,stale}
          ▼                    ▼                        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ 逐篇：renderArticle (316) → checkRendered (346)           │
 │   ├ yamlScalar (269) 合成安全 frontmatter                 │
 │   └ inspectArticle (article-contract.js:213) 复用契约      │
 └──────────────────────────┬───────────────────────────────┘
            │ defects / degradations / stale
            ▼
 ┌──────────────────────────┐
 │ 终态合成 (526):          │
 │  writable = entry.ok     │
 │  blocking = defects+     │
 │     degradations+        │
 │     baseline-uncommitted │
 │  outcome: failed/       │
 │     partial/done         │
 └────────────┬─────────────┘
              ▼
       GateReport (538) ──► toContractBlockers(589) ─► contract.js
                           └► toQualityIssues(610) ─► update-record.js:judgeOutcome
```

模块刻意**不**重写任何判定逻辑，而是复用 `output.js` 的 `validateOutput` 与 `article-contract.js` 的
`inspectArticle`；它的价值在于「分流 + 终态语义 + 基线裁决 + 安全渲染」。

## Data Flow

一笔原生产物从进来到出 `GateReport` 的数据流如下：

1. **入口收集**：`gateNativeOutput`（`390|`）接收 `docsDir`、`repoRoot`、`componentFiles`、
   `overviewName`、`baseline`、`requireCommittedInput`、`includeContent`。先调
   `validateOutput`（`400|`），后者内部 `buildWritePlan`（`lib/engine/output.js:162`）→
   `collectOutput`（`lib/engine/output.js:91`）+ `mapFsoftOutput`（`lib/engine/mapping.js:115`），
   产出 `{ collected, mapped, problems }`。

2. **问题分流**：遍历 `validation.problems`（`418|`）。`empty-module-tree` 降为 degradation
   （`420|`，证据缺失而非产物坏了）；`article-missing`/`unmapped-page`/已登记的 defect 升为 defect；
   未登记类别统一报成 `article-contract` defect（`436|`）以逼上层补映射。所有写进的 kind 必须在对应
   集合里（`406|`、`410|`），否则抛错。

3. **入口校验**：从 `mapped.entry` 取 overview 页（`440|`），读不到/空正文/围栏未闭合分别推
   `entry-missing`/`empty-body`/`article-contract` 并置 `entry.ok=false`（`449|`、`454|`、`459|`）。

4. **逐篇渲染 + 契约**：对 `mapped.articles` 每条（`467|`）：读原始正文 → `renderArticle`（`477|`）
   合成 frontmatter+正文 → `checkRendered`（`478|`）。`inspectArticle` 返回的 error 级 issue 转成
   `article-contract` defect（`487|`），warning 级转 degradation（`492|`）；空 `source_files` 推
   `no-source-evidence`（`497|`）。无 defect 的页进入 `rendered[]`（`514|`），且每篇在 `articles[]`
   里记 `action: 'write' | 'skip'`（`510|`）。注意：有缺陷的页**绝不**进 `rendered`（`155|` 注释说明，
   否则上游会绕过 skip 整篇落盘）。

5. **基线裁决**：取 `collected.json.metadata.generation_info.commit_id` 为 `artifactCommit`
   （`518|`），调 `assessBaseline`（`519|`）。后者比对 HEAD、校验 commit 形态与 `uncommitted-input`，
   再结合 `readCommittedBaseline`（`117|`）报告的基线陈旧，得到 `{ ok, defects, stale }`
   （`242|` 的 `ok` 仅被 `baseline-uncommitted` 阻塞）。

6. **终态合成**：`writable = Boolean(entry && entry.ok)`（`526|`）；`blocking` 是 defects +
   degradations + `baseline-uncommitted` 的 stale（`527|`）；`outcome` 三态（`533|`）。
   最终 `GateReport`（`538|`）含全部明细与 `counts`。

7. **下游接线**：`toContractBlockers`（`589|`）把 blockers 翻成 `contract.js` 的 `BLOCKER_KINDS`，
   供索引层落盘闸门消费；`toQualityIssues`（`610|`）把结论翻成 `update-record.js` 的 `qualityIssues`，
   喂给 `judgeOutcome` 防止「空 source_files 页被默默算成功并推进基线」。

## Connections

本模块处于引擎流水线的「采用门」层，与以下模块强耦合：

- [[engine_output]]（阶段 2，`lib/engine/output.js`）：本模块的 `gateNativeOutput` 直接复用
  `validateOutput`（`lib/engine/output.js:184`）与 `bodyLength`（`lib/engine/output.js:127`），
  不重写任何「产物自身自洽」判定；二者分工见 `lib/engine/output.js:14` 注释。
- [[article_contract]]（`lib/article-contract.js`）：复用 `inspectArticle`（`213|`）、
  `fencesBalanced`（`161|`）、`parseFrontmatter`（`77|`）做渲染后文章的格式闸门；原生通道通过
  `requiredSections=[]` + `allowEmptySourceFiles=true` 关闭 agentic 通道专属判据。
- [[engine_mapping]]（`lib/engine/mapping.js`）：本模块 `import` 了 `WIKI_ENTRY`（`30|`）与
  `WIKI_META_REL`（`32|`），并消费 `mapFsoftOutput`（`115|`）产出的 `entry`/`articles`/`unmapped`。
- [[engine_contract]]（`lib/engine/contract.js`）：`toContractBlockers`（`589|`）把 gate 的 blockers
  映射到 `BLOCKER_KINDS`，保证上层落盘闸门能识别。
- [[update_record]]（`lib/update-record.js`）：`toQualityIssues`（`610|`）把 gate 结论翻成
  `judgeOutcome`（`lib/update-record.js:37`）的 `qualityIssues`，是「两条判定路径不能一个严一个松」
  的关键接线（见 `lib/engine/quality-gate.js:598` 注释）。
- 测试侧：`test-engine-quality-gate.mjs`（本模块专属测试）同时 import 了
  `lib/update-record.js` 的 `judgeOutcome` 与 `lib/engine/contract.js` 的 `BLOCKER_KINDS` 验证接线正确性。

## Known Issues

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


