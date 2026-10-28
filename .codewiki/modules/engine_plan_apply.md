---
title: engine_plan_apply
type: module
source_files:
  - lib/engine/apply-plan.js
  - test-engine-apply-plan.mjs
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/article-contract.js
  - lib/engine/quality-gate.js
tags: [engine, apply, commit, baseline, rollback, native-output]
---

## Overview

`engine_plan_apply` 是 native 引擎流水线的**阶段 3（落地器）**：把 [[engine_quality_gate]] 给出的
采用裁决（`report`）真正落到仓库里——写盘 → `cw index` → 基线（`cw meta update`）→ 自动提交，
并在失败时按三条硬不变量回滚。

位置：`lib/engine/apply-plan.js`。它在 quality-gate 裁决「这批页可以入库」之后、产物真正进仓库之前
介入。裁决说「可入库」和「入库这件事真的成立了」是两回事——中间四步都可能失败（写盘路径越界/权限/
磁盘满、`cw index` 建不起索引、`cw meta update` 基线推进失败、自动提交失败）。0.14.0 的教训正是把
「写成几篇」当成「成立」，于是 1 篇成功 + 19 篇失败也报 done。

三条硬不变量（本模块唯一验收标准，见文件头注释 `lib/engine/apply-plan.js:10-22`）：

1. **写集封闭**：只允许写 `APPLY_WRITE_ROOTS`（`.codewiki` 整棵子树 + 仓库根 `CodeWiki.md`，
   `lib/engine/apply-plan.js:46`）。路径里的绝对路径、盘符、`..` 上跳、白名单外路径一律**整批拒写**
   （不是跳过该条），因为写集不完整时部分写入等于制造一份没人在意的半成品。
2. **索引/基线失败即回滚**：文章写盘之后 `cw index` 或 `cw meta update` 失败，磁盘必须回到应用前
   （旧文章原样写回、新建文件删掉、`_index.md` 与 `_meta.yaml` 恢复 pre-image）。否则库里留下
   「文章在、索引没有」或「文章在、基线已推进」的结构，下次编译在脏库上判「已消化」，而脏库永不自愈。
3. **提交失败不回滚**：自动提交是「产物入库」的最后一步，失败时文章本身是好的、有用的（与索引/基线相反），
   所以只记 `commit-failed` 阻塞并如实返回，绝不删掉有价值的文章。

依赖注入而非 import：本模块**不 import `index.js`**（那里是插件主入口，加载会连带起宿主服务与
webServer，单测就变成「为测一个写盘函数启动整个插件」）。`runCw` / `commit` / `normalizeIndexLinks`
全部由调用方注入。`lib/engine/apply-plan.js:24-34` 进一步说明：默认自带一个**同语义**的内置提交器
`commitWikiArtifacts`，否则阶段 3 自己跑起来产物只落盘不入库、报告却仍是 done——那正是
「自动提交失败被改写成成功」的前身。

## Key Components

本模块（`lib/engine/apply-plan.js`）是纯逻辑 + 进程调用的组合，导出常量、纯函数、内置提交器与唯一入口
`applyNativeOutput`。以下按导出顺序列出全部公开 API。

### 常量

- `APPLY_VERSION`（`lib/engine/apply-plan.js:43`）：落地结果契约版本，固定为 `1`。
- `APPLY_WRITE_ROOTS`（`lib/engine/apply-plan.js:46`）：写集白名单，冻结为
  `Object.freeze([WIKI_DIR, WIKI_ENTRY])`，即 `['.codewiki', 'CodeWiki.md']`（派生自
  `lib/engine/mapping.js:31-32`）。
- `APPLY_STAGES`（`lib/engine/apply-plan.js:49`）：落地阶段顺序，冻结为
  `['write', 'index', 'baseline', 'commit']`，测试 `test-engine-apply-plan.mjs:139-141` 断言其即推进顺序。
- `APPLY_PROBLEM_KINDS`（`lib/engine/apply-plan.js:52-59`）：写集校验问题类别（机读，新增只允许追加）：
  `empty-target` / `absolute-target` / `escaping-target` / `out-of-scope` / `duplicate-target` / `bad-content`。
- `APPLY_RESULT_KINDS`（`lib/engine/apply-plan.js:62-73`）：落地结果问题类别。前三个（`write-failed` /
  `index-failed` / `baseline-failed`）直接对应契约 `BLOCKER_KINDS`；其余包括 `commit-failed`、
  `commit-scope`、`not-writable`、`wiki-missing`、`gate-partial`。

### 函数

- `checkWriteTargets(items)`（`lib/engine/apply-plan.js:86-131`）：**纯函数，不碰磁盘**。校验渲染写集。
  入参为 `{path, content?}[]`，逐个做：去 `./` 前缀与反斜杠归一（`toPosix`，`lib/engine/apply-plan.js:75`）、
  拒空路径（`empty-target`）、拒绝对路径/盘符/以 `/` 开头（`absolute-target`，`lib/engine/apply-plan.js:97-100`）、
  拒 `..` 上跳（`escaping-target`，`lib/engine/apply-plan.js:101-105`）、拒白名单外路径（`out-of-scope`，
  `lib/engine/apply-plan.js:143-151`，注意 `.codewikix` 不算 `.codewiki` 子路径）、拒 `content` 非字符串
  （`bad-content`）、同一路径内容不同判 `duplicate-target`、内容相同去重（`lib/engine/apply-plan.js:119-126`）。
  返回 `{ok, targets: [{rel, content}], problems}`。测试 `test-engine-apply-plan.mjs:157-171` 覆盖全表。
- `verifyCommitScope(repoRoot, sha, {allowExtra, files})`（`lib/engine/apply-plan.js:224-237`）：校验一次
  提交是否**只**动了 wiki 产物。反查 `git show --name-only`（或复用传入的 `files`）得到实际提交内容，
  与 `APPLY_WRITE_ROOTS` ∪ `allowExtra` 比对，返回 `{ok, files, unexpected, reason?}`。这是「自动提交
  安全边界」从「命令带了 pathspec」变成「可断言的事实」的关键。`test-engine-apply-plan.mjs:613-648` 用真 git 实测。
- `commitWikiArtifacts(cwd, {jobId, writtenCount})`（`lib/engine/apply-plan.js:250-295`）：阶段 3 **内置小提交器**。
  安全边界逐条照抄 `index.js:4655` 的 `autoCommitWiki`（只 add wiki 两个路径、不 amend 不 push、合并/
  变基/无 HEAD 一律拒绝、`.gitignore` 忽略检测、缺 user.name/user.email 拒绝），差别只在实现大小——直接
  提交、不建主题分支。返回 `{committed, sha?, message?, noChanges?, reason?, files?}`。
- `toApplyBlockers(problems)`（`lib/engine/apply-plan.js:309-320`）：把落地结果问题翻成契约 `BLOCKER_KINDS`
  （见 `TO_CONTRACT_KIND`，`lib/engine/apply-plan.js:298-307`）。若翻出的 kind 不在 `BLOCKER_KINDS`
  注册表里则抛错（`lib/engine/apply-plan.js:313`），契约测试会枚举全表。`test-engine-apply-plan.mjs:147-155` 断言每个落地问题都能翻成已登记 blocker。
- `applyNativeOutput(opts)`（`lib/engine/apply-plan.js:414-725`）：**唯一入口，异步**。把采用裁决落地。
  入参 `opts`（`lib/engine/apply-plan.js:251-260`）：
  - `repoRoot`：仓库根（绝对路径）。
  - `report`：`gateNativeOutput` 的返回值（`lib/engine/quality-gate.js:390`）。
  - `docsDir`：引擎产出 docs 目录（读入口页正文用）。
  - `wikiPath`：wiki 目录，默认 `<repoRoot>/.codewiki`。
  - `advanceBaseline`：覆盖 `report.canAdvanceBaseline`（测试/预览用）。
  - `entryMode`：`'keep' | 'overwrite' | 'skip'`，默认 `'keep'`，处置仓库根已存在的入口（`lib/engine/apply-plan.js:409`）。
  - `dryRun`：只算写集与判定（`lib/engine/apply-plan.js:525-530`），不写盘、不跑 cw、不提交。
  - `deps`：`{runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary, gitCommitMessage}`（`lib/engine/apply-plan.js:411`）。

  执行流程（`applyNativeOutput` 内）：
  1. 无 `repoRoot` 或 `report.writable !== true` → 一个字都不写（`lib/engine/apply-plan.js:462-470`）。
  2. 裁决 `outcome !== 'done'` 但 writable → 记 `gate-partial`，照写但不算消化完（`lib/engine/apply-plan.js:475-478`）。
  3. 收集写集：文章（`report.rendered`）+ 仓库根入口（从 `docsDir` 读 `report.entry.source`，剥 frontmatter，
     `entryBody` `lib/engine/apply-plan.js:395-398`），`entryMode` 控制覆盖/保留/跳过（`lib/engine/apply-plan.js:481-513`）。
  4. `checkWriteTargets` 整批校验，不通过则整批拒写（`lib/engine/apply-plan.js:515-522`）。
  5. `dryRun` 提前返回（`lib/engine/apply-plan.js:525-530`）。
  6. 注入 `runCw` / `commit` / `verifyCommit` / `cwBinary`，默认走内置提交器（`lib/engine/apply-plan.js:532-537`）。
  7. 拍 pre-image（`capturePre`，`lib/engine/apply-plan.js:138-153`，覆盖本次写集 + `_index.md` + `_meta.yaml`）。
  8. wiki 未初始化则先 `cw init`（`lib/engine/apply-plan.js:554-577`，对应 `index.js:4021` 状态机里的 missing 分支）。
  9. `writeAll` 写盘（`lib/engine/apply-plan.js:178-187`），失败回滚。
  10. `cw index`（`lib/engine/apply-plan.js:376-393`），失败回滚；随后 `normalizeIndexLinksIn` 规范化
      `\_index.md` 链接头反斜杠（`lib/engine/apply-plan.js:376-390`），失败回滚。
  11. `findArticlesMissingFromIndex`（`lib/engine/apply-plan.js:338-359`）比对「已写盘 vs 索引收录」，
      `cw index` 退出码 0 但文章没进索引（frontmatter 被 serde_yaml 拒收时静默跳过）则记 `index-failed` 并回滚。
  12. 基线：`shouldAdvance` 为真才跑 `cw meta update`，否则不推进（`lib/engine/apply-plan.js:655-680`）。
  13. 自动提交：失败不回滚，记 `commit-failed`；提交成立后 `verifyCommitScope` 反查，混入 wiki 外路径记
      `commit-scope`（`lib/engine/apply-plan.js:682-707`）。

  返回 `base` 结构（`lib/engine/apply-plan.js:433-449`）经 `done`（`lib/engine/apply-plan.js:450-460`）补
  `blockers` / `outcome` / `ok` / `canAdvanceBaseline`：
  `{version, startedAt, repoRoot, applied, outcome, written[], entry, index, baseline, commit,
  rolledBack, problems[], blockers[], notes[], canAdvanceBaseline, finishedAt?}`。
  `canAdvanceBaseline` 仅在 `applied && baseline.advanced && problems.length===0` 时为真
  （`lib/engine/apply-plan.js:715-717`）；`outcome` 为 `done` 但含 blockers 时会被 `done` 降级为 `partial`
  （`lib/engine/apply-plan.js:453`）。

### 模块默认导出（`lib/engine/apply-plan.js:727-738`）

`default` 聚合导出 `APPLY_VERSION / APPLY_WRITE_ROOTS / APPLY_STAGES / APPLY_PROBLEM_KINDS /
APPLY_RESULT_KINDS / checkWriteTargets / verifyCommitScope / commitWikiArtifacts / toApplyBlockers /
applyNativeOutput`。

### 内部辅助（非导出，但被入口依赖）

- `capturePre` / `restorePre`（`lib/engine/apply-plan.js:138-176`）：pre-image 快照与逆序回滚。
- `writeAll`（`lib/engine/apply-plan.js:178-187`）：批量写盘。
- `defaultRunCw`（`lib/engine/apply-plan.js:191-201`）：同步 `spawnSync` 默认 cw 通道，返回
  `{exitCode, stdout, stderr, timedOut}`。
- `defaultVerifyCommit`（`lib/engine/apply-plan.js:203-210`）：`git show --name-only` 反查。
- `findArticlesMissingFromIndex`（`lib/engine/apply-plan.js:338-359`）：缺页检测，跳过 `_` 开头文件。
- `normalizeIndexLinksIn`（`lib/engine/apply-plan.js:376-390`）：内置索引链接 `\`→`/` 规范化。
- `entryBody`（`lib/engine/apply-plan.js:395-398`）：剥掉入口页自带 frontmatter（用
  `lib/article-contract.js:77` 的 `parseFrontmatter`），保留正文。

## Architecture

阶段 3 是「裁决 → 落地」的单向管道，四步顺序推进，索引/基线失败时沿 `restorePre` 回滚。

```text
┌────────────────────────────────────────────────────────────────────────┐
│ quality-gate.js: gateNativeOutput(report)                               │
│   report.{writable, outcome, canAdvanceBaseline, rendered[], entry}      │
└───────────────────────────────┬────────────────────────────────────────┘
                                 │ report
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ apply-plan.js: applyNativeOutput (入口, lib/engine/apply-plan.js:414)    │
│                                                                        │
│  1. checkWriteTargets (纯函数, :86)  ── 不通过 → 整批拒写             │
│         │ 写集封闭：APPLY_WRITE_ROOTS = [.codewiki, CodeWiki.md]        │
│         ▼ 通过                                                       │
│  2. cw init (若 wiki 未初始化, :554)                                   │
│  3. writeAll (写盘, :178) ── 失败 → rollback()                        │
│  4. runCw('index') (:591) ── 失败 → rollback()                       │
│     normalizeIndexLinksIn (:376) ── 失败 → rollback()                │
│     findArticlesMissingFromIndex (:338) 缺页 → rollback()             │
│  5. runCw('meta','update') 基线 (:655) ── 失败 → rollback()          │
│  6. commitWikiArtifacts / deps.commit (:250) 提交失败 → 不回滚        │
│         │ verifyCommitScope(:224) 反查，越界记 commit-scope           │
│         ▼                                                            │
│  done() → ApplyResult {applied, outcome, baseline, commit, blockers}   │
└────────────────────────────────────────────────────────────────────────┘
                                 │
              rollback() = restorePre(pre) + (若 .codewiki 新建则删目录)
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 依赖注入点 deps = {runCw, commit, normalizeIndexLinks, verifyCommit,    │
│                    cwBinary}（lib/engine/apply-plan.js:411）             │
│ 默认：defaultRunCw / commitWikiArtifacts（同 autoCommitWiki 安全边界）   │
└────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **输入 `report`**：来自 [[engine_quality_gate]] 的 `gateNativeOutput`，携带 `{writable, outcome,
   canAdvanceBaseline, rendered:[{wikiPath, content}], entry:{source}, articles[]}`。落地器只认结论，
   不重复 gate 判定（`lib/engine/apply-plan.js:466-478`）。
2. **写集构建**：`rendered` 每篇 → `{path: r.wikiPath, content: r.content}`；入口页从 `docsDir` 读
   `report.entry.source`，剥 frontmatter 后压入（`lib/engine/apply-plan.js:481-509`）。
3. **写集校验**：`checkWriteTargets` 归一路径、判越界/重复/类型（`lib/engine/apply-plan.js:86-131`），
   不通过 → 整批拒，问题统一记 `write-failed` 并保留原子类别到 `detail` 前缀（`lib/engine/apply-plan.js:515-522`,
   测试 `test-engine-apply-plan.mjs:283-299` 验证越界即整批拒）。
4. **pre-image**：`capturePre` 拍下本次写集 + `_index.md` + `_meta.yaml` 的 pre-image
   （`lib/engine/apply-plan.js:540-541`），供回滚恢复。该快照不只是「本次写的文件」——`cw index` /
   `cw meta update` 会重写这两份，它们才是「库是否干净」的判据（`lib/engine/apply-plan.js:133-137`）。
5. **写盘 → index → baseline → commit** 顺序推进（`APPLY_STAGES` 顺序，
   `test-engine-apply-plan.mjs:233` 断言 `['index','meta update']` 顺序）。
6. **缺页比对**：`findArticlesMissingFromIndex` 用 `git`-无关的方式比对「写集期望收录」与「索引实际收录」，
   专门兜住 `cw index` 退出码 0 但 frontmatter 被 `serde_yaml` 拒收导致文章静默缺席的情形
   （`lib/engine/apply-plan.js:338-359`，测试 `test-engine-apply-plan.mjs:542-569`）。
7. **提交反查**：`commitWikiArtifacts` 提交后，用 `verifyCommitScope` 反查实际提交内容，混入 wiki 外路径
   记 `commit-scope` 但不回滚（`lib/engine/apply-plan.js:682-707`，测试 `test-engine-apply-plan.mjs:391-401`）。
8. **输出 `ApplyResult`**：`done()`（`lib/engine/apply-plan.js:450-460`）合成
   `{version, startedAt, repoRoot, applied, outcome, written, entry, index, baseline, commit,
   rolledBack, problems, blockers, notes, canAdvanceBaseline, finishedAt}`。终态规则：提交未成立且非
   `noChanges` 时绝不 `done`（兜底 `lib/engine/apply-plan.js:709-714`），`outcome='done'` 含 blockers 即降级 `partial`。

边界值要点：
- `dryRun=true`：`applied=false`，不调 cw、不写盘（`test-engine-apply-plan.mjs:249-258`）。
- `entryMode='keep'`：已有 `CodeWiki.md` 保留人工入口（`test-engine-apply-plan.mjs:407-416`）；
  `overwrite` 覆盖（`test-engine-apply-plan.mjs:418-426`）。
- 入口页无正文（除 frontmatter）判 `write-failed` 且整批拒（`test-engine-apply-plan.mjs:428-438`）。
- 零注入（只给 `runCw`）也能跑：内置提交器 + 内置规范化，非 git 仓库落盘后报 `commit-failed`/partial
  （`test-engine-apply-plan.mjs:571-582`）。

## Connections

- [[engine_quality_gate]]：`applyNativeOutput` 的唯一上游，`gateNativeOutput` 产出 `report`
  （`lib/engine/quality-gate.js:390-568`）。落地器只认 `report.writable` / `outcome` /
  `canAdvanceBaseline` / `rendered` / `entry`，不重复 gate 判定。gate 的 `renderArticle`
  （`lib/engine/quality-gate.js:316-340`）已把映射结果渲染成完整 wiki 文章文本，`apply-plan` 直接消费。
- [[engine_mapping]]：`APPLY_WRITE_ROOTS` 的 `WIKI_DIR` / `WIKI_ENTRY` / `WIKI_META_REL`
  均来自 `lib/engine/mapping.js:31-32`，写集封闭性直接依赖这份白名单定义。
- [[engine_contract]]：落地问题经 `toApplyBlockers`（`lib/engine/apply-plan.js:309-320`）映射到
  `BLOCKER_KINDS`（`lib/engine/contract.js:42-53`，含 `quality-gate`/`index-failed`/`baseline-failed`/
  `commit-failed`）。契约测试会枚举全表，新增 kind 必须登记。
- [[article_contract]]：`entryBody` 复用了 `parseFrontmatter`（`lib/article-contract.js:77-90`）剥掉入口
  frontmatter；`lib/article-contract.js` 的契约闸门在 gate 阶段已用，落地器只消费渲染结果。
- [[index_js_plugin_entry]]：阶段 4 由 `index.js` 注入自己的 `runCw`（`index.js:172-197`，异步 spawn）
  与 `autoCommitWiki`（`index.js:4655`，分支合并式，安全边界与 `commitWikiArtifacts` 逐条对齐）。
  落地器刻意不 import `index.js`（避免连带启动宿主服务，`lib/engine/apply-plan.js:24-34`），
  而是靠 `deps` 注入。注意：`index.js` 既有 `tickIndex`（`index.js:3346-3463`）走的是另一条
  agentic 通道的「judge → index → meta → autoCommitWiki」路径，与 native 通道的 `applyNativeOutput`
  职责对等、互不调用——前者供既有 agentic 编译，后者供 native 引擎产物落地。
- [[engine_output]]：`gateNativeOutput` 内部消费的 `validateOutput`（`lib/engine/output.js`）产出 `report`
  的 `defects`/`degradations` 原始事实；落地器只接 gate 综合后的 `report`。

## Known Issues

- **`deps.gitCommitMessage` 声明了但从未被消费**（`lib/engine/apply-plan.js:411` 的 `deps` 类型注释列出了
  `gitCommitMessage`，但 `applyNativeOutput` 调 `doCommit` 时只传 `{jobId, writtenCount}`
  （`lib/engine/apply-plan.js:250`），`commitWikiArtifacts` 的提交信息硬编码为
  `docs(wiki): 更新 CodeWiki 编译产物…`（`lib/engine/apply-plan.js:280`）。若阶段 4 注入的是
  `index.js:4655` 的 `autoCommitWiki`，那条路径自己会拼 message；但默认路径会直接忽略
  `deps.gitCommitMessage`。调用方若期望自定义 message，目前只有注入 `commit` 才能生效。
- **索引/基线提交器与入口存在两份近重复实现**：`commitWikiArtifacts`
  （`lib/engine/apply-plan.js:250-295`）逐行照抄 `index.js:4655` 的 `autoCommitWiki` 安全边界，
  只因本模块刻意不 import `index.js`（`lib/engine/apply-plan.js:24-34`）才另写一份。同理
  `normalizeIndexLinksIn`（`lib/engine/apply-plan.js:376-390`）是 `index.js:213`
  `normalizeIndexLinks` 的复刻，唯一差别在 ENOENT 的处理（见文件头注释 `lib/engine/apply-plan.js:361-371`）。
  三处边界必须保持同步：一旦 `autoCommitWiki` 收紧（如新增拒绝条件），`commitWikiArtifacts` 与之对齐
  靠的是「人肉对照注释」而非类型/测试约束——属于有意但易腐的技术债。
- **`verifyCommitScope` 默认通道依赖真 git**：内置 `defaultVerifyCommit`
  （`lib/engine/apply-plan.js:203-210`）直接 `spawnSync('git', …)`；若仓库无 `.git` 则 `git show`
  失败、`verifyCommitScope` 返回 `ok:false` 并记 `commit-scope`——但此时 `commit` 本身（内置
  `commitWikiArtifacts`）早已因「不是 git 仓库」在前一步返回 `committed:false` 并记 `commit-failed`，
  所以 `commit-scope` 只在「真提交成立且 `verifyCommit` 未注入」时触发反查，正常不会误报。
- **`canAdvanceBaseline` 与 `report.canAdvanceBaseline` 的语义错位**：`done()` 把
  `canAdvanceBaseline` 设为「`applied && baseline.advanced && problems.length===0`」
  （`lib/engine/apply-plan.js:455-457`），而非直接信任 `report.canAdvanceBaseline`。这意味着即使 gate
  判 `canAdvanceBaseline=true`，只要落地过程有任何 problem（含 `gate-partial`/`commit-failed`），
  落地器也会把它压成 false——与 gate 的「done 才能推进」口径一致，但调用方若直接读
  `report.canAdvanceBaseline` 会被误导，应读返回的 `result.canAdvanceBaseline`。
- **`entryMode` 不处理「入口在写集里但 docsDir 缺失」**：`report.entry.source` 非空但 `docsDir`
  读不到对应文件时直接 `write-failed` 整批拒（`lib/engine/apply-plan.js:497-501`）。这是有意的安全行为，
  不是 bug，但调用方必须保证 `docsDir` 与 `report.entry.source` 一致。
