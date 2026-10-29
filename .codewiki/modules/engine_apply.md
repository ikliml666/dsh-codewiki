---
title: engine_apply
type: module
source_files:
  - lib/engine/apply-plan.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/git-paths.js
  - lib/article-contract.js
  - lib/engine/quality-gate.js
  - lib/engine/native-run.js
  - index.js
  - test-engine-apply-plan.mjs
tags: [engine, apply, pipeline, atomic-apply, rollback, commit]
---

## Overview

`engine_apply`（落地器）是原生引擎流水线（阶段 4/5）里把「采用裁决」真正固化进仓库的一层，源码位于 `lib/engine/apply-plan.js`。它在 `lib/engine/quality-gate.js` 给出采用裁决（`report`）之后、产物真正进仓库之前执行一次原子事务：

```
写盘(write) → cw index(index) → 基线 meta update(baseline) → 自动提交(commit)
```

这一层存在的理由写在文件头（`lib/engine/apply-plan.js:1-34`）：质量门只说「这批页可以入库」，但「入库这件事真的成立了」是两回事——中间每一步都会失败（写盘越界/权限/磁盘满、`cw index` 建不起索引、`cw meta update` 基线推进失败、自动提交失败）。0.14.0 的教训正是把「写成几篇」当成「成立」，于是 1 篇成功 + 19 篇失败也报 done。落地器把「落地」拆成可被逐条断言的步骤，并用三条硬不变量把验收标准钉死（`lib/engine/apply-plan.js:10-22`）：

1. **写集封闭**（`lib/engine/apply-plan.js:12-15`）：只允许写 `.codewiki/` 子树与仓库根 `CodeWiki.md`，绝对路径/盘符/`..` 上跳/白名单外路径一律**整批拒写**（不是跳过单条——写集不完整时部分写入等于制造没人留意的半成品）。
2. **索引/基线失败即回滚**（`lib/engine/apply-plan.js:16-19`）：文章写盘之后 `cw index` 或 `cw meta update` 失败，磁盘必须回到应用前（旧文章原样写回、新建文件删掉、`_index.md` 与 `_meta.yaml` 恢复 pre-image）。否则留下「文章在、索引没有」或「文章在、基线已推进」的脏库，下次编译会在脏库上判「已消化」，而脏库永不自愈。
3. **提交失败不回滚**（`lib/engine/apply-plan.js:20-22`）：自动提交是最后一步，它失败时文章本身是好的有用的（与索引/基线相反），所以只记 `commit-failed` 阻塞并如实返回，绝不删掉有价值的文章。

该模块刻意**不 import `index.js`**（`lib/engine/apply-plan.js:24-34`）：`index.js` 是插件主入口，加载它会连带拉起宿主服务与 webServer，单测里会变成「为测一个写盘函数启动整个插件」。因此 `runCw` / `commit` / `normalizeIndexLinks` 全部由调用方注入；阶段 4 在生产中由 `index.js` 注入自己的 `runCw`，测试注入桩（`lib/engine/apply-plan.js:26-27`）。但「可注入」不等于「默认什么都不做」：模块自带一个**同语义**的内置提交器 `commitWikiArtifacts`（`lib/engine/apply-plan.js:29-34`，`lib/engine/apply-plan.js:260-308`），否则阶段 3 自己跑起来产物只落盘不入库，而报告看起来仍是 done——那正是「自动提交失败被改写成成功」的前身。

模块对外只暴露一个主入口 `applyNativeOutput`（`lib/engine/apply-plan.js:502-870`），以及一组纯函数/常量（`checkWriteTargets`、`verifyCommitScope`、`commitWikiArtifacts`、`toApplyBlockers` 等）。它被 `lib/engine/native-run.js` 的 `runNativeJob` 在「落地器」步骤调用（`lib/engine/native-run.js:111-141`）。相关上游依赖：`mapping.js` 的 `WIKI_ENTRY`/`WIKI_DIR`/`WIKI_META_REL`、`contract.js` 的 `BLOCKER_KINDS`、`git-paths.js` 的 `withQuotepathOff`/`decodeGitPaths`、`article-contract.js` 的 `parseFrontmatter`。

## Key Components

### 常量（全部 `Object.freeze`，位于 `lib/engine/apply-plan.js`）

- `APPLY_VERSION`（`lib/engine/apply-plan.js:44`）= `1`，落果结果 `ApplyResult.version` 的来源。
- `APPLY_WRITE_ROOTS`（`lib/engine/apply-plan.js:47`）= `Object.freeze([WIKI_DIR, WIKI_ENTRY])`，即 `['.codewiki', 'CodeWiki.md']`。写集白名单，唯一允许落地的根（`test-engine-apply-plan.mjs:143-145` 断言）。
- `APPLY_STAGES`（`lib/engine/apply-plan.js:50`）= `Object.freeze(['write', 'index', 'baseline', 'commit'])`，面板步骤条与日志对齐的推进顺序（`test-engine-apply-plan.mjs:139-141` 断言顺序即推进顺序）。
- `APPLY_PROBLEM_KINDS`（`lib/engine/apply-plan.js:53-60`）：写集校验（纯校验）的输出类别，`empty-target` / `absolute-target` / `escaping-target` / `out-of-scope` / `duplicate-target` / `bad-content`。注意：这些不是落地结果词表，落地时统一折算成 `write-failed`（见 `toApplyBlockers`）。
- `APPLY_RESULT_KINDS`（`lib/engine/apply-plan.js:63-74`）：落地结果的问题类别，前三个直接对应契约 `BLOCKER_KINDS`：`write-failed`、`index-failed`、`baseline-failed`、`commit-failed`、`commit-scope`（提交成立但混进 wiki 外路径）、`not-writable`（裁决不允许入库）、`wiki-missing`（`.codewiki/` 存在却缺 `_meta.yaml` 或需要 `cw init`）、`gate-partial`（裁决 partial 但 writable=true，落地只代表文件到位、不算消化完）。

辅助纯函数 `toPosix`（`lib/engine/apply-plan.js:76`）：把 `\` 折成 `/`、空值兜底，全模块复用。

### `checkWriteTargets(items)`（`lib/engine/apply-plan.js:87-132`）

写集校验纯函数，不碰磁盘。入参 `items: Array<{path, content?}>`，返回 `{ok, targets, problems}`。逐条判定（`lib/engine/apply-plan.js:91-129`）：

- `empty-target`：路径为空；
- `absolute-target`：绝对路径 / 盘符（`C:/...` 或 `^[a-zA-Z]:`）/ 以 `/` 开头（`lib/engine/apply-plan.js:98-101`，`test-engine-apply-plan.mjs:205-209` 盘符用例）；
- `escaping-target`：`..` 上跳（规范化后 `norm === '..'`、`startsWith('../')` 或含 `/../`）（`lib/engine/apply-plan.js:102-106`）；
- `out-of-scope`：不在 `APPLY_WRITE_ROOTS` 任一之下；注意 `.codewikix` 不会被误判成 `.codewiki` 子路径（`lib/engine/apply-plan.js:107-115`，`test-engine-apply-plan.mjs:211-215`）；
- `bad-content`：`content` 不是字符串（`lib/engine/apply-plan.js:116-119`）；
- `duplicate-target`：同一路径内容不同（内容相同是重复投递，无害去重；内容不同才记问题）（`lib/engine/apply-plan.js:120-127`，`test-engine-apply-plan.mjs:187-203`）。

关键设计：不「逐条跳过坏路径」，一份残缺的写集落盘后调用方拿到的报告会显得「大部分成功」而缺的那几篇没人知道（`lib/engine/apply-plan.js:78-82`）。

### pre-image 快照与回滚（内部函数）

- `capturePre(repoRoot, rels)`（`lib/engine/apply-plan.js:139-154`）：对给定相对路径逐个读盘，记录 `{rel, abs, exists, content}`。用于恢复——回滚对象不只是本次写的文件，`cw index` 重写的 `_index.md` 与 `cw meta update` 重写的 `_meta.yaml` 也要恢复（它们才是「库是否干净」的判据）。
- `restorePre(snapshot)`（`lib/engine/apply-plan.js:156-177`）：**逆序**恢复（后写的先撤，语义接近撤销事务）。原本存在的文件原样写回；原本不存在（`exists=false`）的文件说明是本次新建，回滚就删掉（`unlinkSync`）。返回 `{restored, failed}`。
- `writeAll(repoRoot, targets)`（`lib/engine/apply-plan.js:179-194`）：写盘，返回 `{written, unchanged}`。与磁盘逐字节相同的项不重写（无变化一轮不该产生 mtime 抖动，更不该让「产物无改动」的自动提交变成一次真实提交，`lib/engine/apply-plan.js:184-188`）。

### 默认 cw 通道与提交校验

- `defaultRunCw(binary, cwd, args, timeoutMs=120000)`（`lib/engine/apply-plan.js:198-208`）：同步 `spawnSync` 默认通道，返回 `{exitCode, stdout, stderr, timedOut}`。阶段 4 注入 `index.js:186` 的异步 `runCw` 即可，签名一致。
- `defaultVerifyCommit(repoRoot, sha)`（`lib/engine/apply-plan.js:210-220`）：用 `git show --name-only --pretty=format: sha` 反查提交内容；`-c core.quotepath=false`（`withQuotepathOff`）+ 逐项 `decodeGitPaths` 两者都要——少了前者，中文模块名的合法产物会被白名单误判成「混进 wiki 之外」，`lib/engine/apply-plan.js:211-213`。
- `verifyCommitScope(repoRoot, sha, {allowExtra=[], files=null})`（`lib/engine/apply-plan.js:234-247`）：校验一次提交**只**动了 wiki 产物。`files` 可直接传入省一次 git（`lib/engine/apply-plan.js:235`）。把 `got.files` 对照 `APPLY_WRITE_ROOTS + allowExtra`，任何越界路径进 `unexpected`，`ok=false` 且带 `reason`（`lib/engine/apply-plan.js:237-245`）。`test-engine-apply-plan.mjs:613-668` 覆盖「只含 wiki」「混进源码」「非 ASCII 中文路径不误判」等真实 git 用例。

### `commitWikiArtifacts(cwd, {jobId=null, writtenCount=0})`（`lib/engine/apply-plan.js:260-308`）

阶段 3 自带的小提交器，只把 wiki 产物入库。安全边界**逐条照抄** `index.js:4995` 的 `autoCommitWiki`（只 add wiki 两个路径、不 amend 不 push、合并冲突与无 HEAD 一律拒绝），差别只在实现大小——直接提交，不建主题分支（`lib/engine/apply-plan.js:29-34`、`:249-254`）。关键判定顺序：

- 只对磁盘上存在的路径操作（固定 pathspec 在文件不存在时让 `git add` 直接 fatal，`lib/engine/apply-plan.js:267-270`）；
- `rev-parse --is-inside-work-tree` 非 git 仓库 → 拒绝；无 HEAD → 拒绝（`lib/engine/apply-plan.js:272-274`）；
- `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 进行中 → 拒绝（避免把 wiki 夹进别人的合并提交，`lib/engine/apply-plan.js:276-278`）；
- `ls-files -u` 未解决冲突 → 拒绝（`lib/engine/apply-plan.js:279`）；
- `.codewiki/` 被 `.gitignore` 忽略 → 拒绝（否则误报无改动静默丢产物，`lib/engine/apply-plan.js:280-284`）；
- 无未提交改动 → `noChanges:true`（`lib/engine/apply-plan.js:285-287`）；
- 未配置 `user.name/user.email` → 拒绝（`lib/engine/apply-plan.js:288-290`）；
- 提交信息固定 `docs(wiki): 更新 CodeWiki 编译产物（任务…、N 篇文章）`（`lib/engine/apply-plan.js:291-292`）；
- `--no-verify` 不跑仓库钩子（`lib/engine/apply-plan.js:301-303`）。

返回 `{committed, sha?, message?, noChanges?, reason?, files?}`。

### `toApplyBlockers(problems)`（`lib/engine/apply-plan.js:322-333`）

把落地问题翻成契约 `BLOCKER_KINDS`（面板/终态判定共用词表，`lib/engine/apply-plan.js:310-320` 的 `TO_CONTRACT_KIND` 映射）。`kind` 必须落在 `contract.js` 的 `BLOCKER_KINDS` 里，否则 `throw`（`lib/engine/apply-plan.js:326`——契约测试枚举全表，写错 kind 会让面板与终态判定同时失明）。`detail` 保留原类别前缀（`[<kind>] ...`），机读靠前缀、人读靠 detail。

### 索引缺页检测与状态裁剪（内部函数）

- `findArticlesMissingFromIndex(repoRoot, written)`（`lib/engine/apply-plan.js:351-372`）：找出「已写盘但没进 `_index.md`」的文章。`cw index` 的退出码只表示索引文件写成功，不表示文章被收录——vendor/codewiki `main.rs:236-256` 逐篇 `frontmatter::parse` 失败就 `continue`，exit 仍 0（`lib/engine/apply-plan.js:338-341`）。比对口径按「相对 `.codewiki/` 的路径去掉 `.md`」，跳过 `_` 开头文件（`lib/engine/apply-plan.js:357`、`lib/engine/native-state.js:23-28`）。
- `listFilesUnder(repoRoot, relRoot)`（`lib/engine/apply-plan.js:375-390`）：递归列出目录下所有文件（相对仓库根的 POSIX 路径），目录不存在返回 `[]`。
- `collectPruneTargets(repoRoot, pruneRoots, keepRels)`（`lib/engine/apply-plan.js:405-419`）：受管状态目录的裁剪清单——这些根下「本次写集里没有」的文件是过期状态。安全边界：裁剪根必须落在写集白名单内（否则会删用户源码，`lib/engine/apply-plan.js:410-412`）。
- `pruneEmptyDirs(repoRoot, relRoot)`（`lib/engine/apply-plan.js:423-437`）：删掉因裁剪变空的目录（自底向上；目录不进 pre-image，回滚时 `restorePre` 会按文件路径重建父目录）。
- `normalizeIndexLinksIn(repoRoot)`（`lib/engine/apply-plan.js:454-468`）：把 `_index.md` 里 `[[link|title]]` 链接头的 `\` 规范成 `/`（cw 在 Windows 上会写出 `\` 分隔链接，而 stale 判定/链接校验用 `/`，同一篇文章两种写法等于索引不可信）。与 `index.js:301` 的 `normalizeIndexLinks` 同语义，唯一差别是 ENOENT 当「没有索引可规范化」返回 false，其余读写错误**抛出**（落地器不能把「索引文件坏到读不出来」当成「不需要规范化」然后判成功，`lib/engine/apply-plan.js:447-449`）。
- `entryBody(text)`（`lib/engine/apply-plan.js:473-476`）：剥掉产物入口页可能自带的 frontmatter（CodeWiki.md 不参与 cw 索引，带一层 frontmatter 只是噪音；保留会让「手写入口」与「产物入口」看起来不是同一类文件）。

### `applyNativeOutput(opts)`（`lib/engine/apply-plan.js:502-870`）—— 主入口

把一次采用裁决落地：写盘 → cw index → 基线 → 自动提交，失败按不变量回滚。完整签名见 `lib/engine/apply-plan.js:481-500`：

- `repoRoot`：仓库根（绝对路径）；
- `report`：`gateNativeOutput` 的返回值（`lib/engine/quality-gate.js:390-419`）；
- `docsDir`：引擎产出的 docs 目录（读入口页正文用）；
- `wikiPath` / `advanceBaseline`（覆盖 `report.canAdvanceBaseline`，测试/预览用）/ `entryMode`（`'keep'|'overwrite'|'skip'`，默认 `'keep'`）/ `dryRun`（只算写集与判定）/ `noChanges`（无变化短路）；
- `extraFiles`：附加写集（引擎原始状态：模块树/元数据/依赖图/增量凭据，相对仓库根），与文章共用同一份 pre-image、同一次回滚、同一个自动提交（`lib/engine/apply-plan.js:489-493`、`lib/engine/native-run.js:617-618`）；
- `pruneRoots`：受管状态目录（相对仓库根），写盘后这些根下「本次写集里没有」的文件被删除（`lib/engine/apply-plan.js:495-499`、`lib/engine/native-run.js:649`）；
- `deps`：`{ runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary, gitCommitMessage }`（`lib/engine/apply-plan.js:494`）。

返回 `ApplyResult`（可 JSON 序列化），其 `base` 形状见 `lib/engine/apply-plan.js:525-542`，包含 `version`、`startedAt`、`applied`、`outcome`、`written`、`pruned`、`entry`、`index`、`baseline`、`commit`、`rolledBack`、`problems`、`blockers`、`notes`、`canAdvanceBaseline`。`done` 收尾函数（`lib/engine/apply-plan.js:543-553`）保证：有 blockers 时 `outcome` 由 `done` 降为 `partial`；`ok = outcome==='done'`；`canAdvanceBaseline = applied && baseline?.advanced && problems.length===0`。

主流程关键分支（按源码顺序）：

1. 无 `repoRoot` → `not-writable` 失败（`lib/engine/apply-plan.js:555-558`）；`noChanges` 短路 → done 但跳过全部步骤（`lib/engine/apply-plan.js:559-571`）；
2. `report.writable !== true` → 一个字都不写（`lib/engine/apply-plan.js:573-576`）；`report.outcome !== 'done'` 但 writable=true → 记 `gate-partial`（能写一部分的合法状态，落地不许洗成 done，`lib/engine/apply-plan.js:581-584`）；
3. 收集写集：文章（`report.rendered`）+ 仓库根入口（`lib/engine/apply-plan.js:587-629`）+ `extraFiles`。入口策略：`entryMode='keep'` 且已有入口 → 保留（action `keep`）；`skip` → 不写；否则从 `docsDir` 读入口正文、剥 frontmatter、写盘（action `overwrite`/`write`）。无入口页（`report.entry` 为 null）→ `not-writable` 失败（`lib/engine/apply-plan.js:626-629`）；
4. `checkWriteTargets` 不通过 → 整批拒写（统一记 `write-failed`，原子类别留 detail 前缀，`lib/engine/apply-plan.js:631-638`）；
5. `dryRun` → 不写盘/不跑 cw/不提交，`applied=false`（`lib/engine/apply-plan.js:641-646`）；
6. 注入 `runCw`/`commit`/`verifyCommit`，默认走内置 `commitWikiArtifacts`（`lib/engine/apply-plan.js:648-653`）；
7. pre-image：`targets + pruneTargets + _index.md + _meta.yaml`，并捕获 `wikiExisted`（`lib/engine/apply-plan.js:655-677`）；`rollback()` 恢复 pre-image，若整棵 `.codewiki/` 是本次才出现的还会删掉空壳目录（`lib/engine/apply-plan.js:669-677`）；
8. `cw init` 前置：`.codewiki/` 存在却缺 `_meta.yaml` → `wiki-missing` 失败（拒绝自动初始化，避免人工破坏的半截库）；完全没有 wiki → 先 `cw init` 建骨架（`lib/engine/apply-plan.js:679-702`）；
9. 写盘 `writeAll` + 裁剪过期状态 `pruneTargets` + `pruneEmptyDirs`（`lib/engine/apply-plan.js:704-732`）；
10. `cw index`：失败 → 回滚（`lib/engine/apply-plan.js:351-368`）；`_index.md` 链接规范化失败 → 回滚（`lib/engine/apply-plan.js:752-770`）；`findArticlesMissingFromIndex` 缺页 → 回滚（`lib/engine/apply-plan.js:773-792`）；
11. 基线 `cw meta update`：仅当 `report.canAdvanceBaseline===true`（或 `advanceBaseline` 覆盖）才推进，失败回滚（`lib/engine/apply-plan.js:794-823`）；
12. 自动提交：失败不回滚（记 `commit-failed`/`commit-scope`，终态至少 partial，`lib/engine/apply-plan.js:825-850`）；未提交但有产物不落地 → 兜底记 `commit-failed` 绝不 done（`lib/engine/apply-plan.js:852-857`）。

## Architecture

落地器是原生引擎流水线「决议链」的最后一段（`env → 引擎 → 质量门 → 落地器`），位置在 `gateNativeOutput`（`lib/engine/quality-gate.js:390`）之后、`autoCommitWiki`/`runCw`（`index.js:186`/`:186`）被注入之前。

```text
                 gateNativeOutput(report)                applyNativeOutput
  FSoft docs ───────► [quality-gate.js] ──report──► [apply-plan.js] ◄── deps{runCw,commit,verifyCommit,normalizeIndexLinks}
                                                    │
        ┌───────────────────────────────────────────┤  APPLY_STAGES 顺序推进
        ▼              ▼                ▼             ▼
   [checkWriteTargets] [writeAll]   [cw index]   [cw meta update]  [commit/verifyCommitScope]
   write-set closed  +pruneTargets  +normalize    baseline only if   safe boundary:
   (整批拒/全过)     +pruneEmptyDirs IndexLinksIn  report.ok &&       only .codewiki/
        │              │              │             canAdvance       CodeWiki.md
        └──────┬───────┴──────┬───────┴──────────────┬───────────────┘
            pre-image(capturePre)            rollback(restorePre, 逆序)
       写集+索引+基线+裁剪对象  ◄──── 任一失败 → 磁盘回到应用前
                                               │ 成功
                                               ▼
                                       extraFiles 与文章同事务
                                  (.codewiki/_native-state, native-state.js)
```

- 主入口 `applyNativeOutput`（`lib/engine/apply-plan.js:502`）串起四个阶段，每阶段失败按不变量回滚；
- `checkWriteTargets`（`lib/engine/apply-plan.js:87`）是写集封闭的唯一守门员；
- `commitWikiArtifacts`（`lib/engine/apply-plan.js:260`）与 `index.js:4995` 的 `autoCommitWiki` 安全边界逐条对齐（只在阶段 4 被注入替换）；
- `extraFiles` + `pruneRoots` 来自 `lib/engine/native-run.js:649-655`，实现「图/模块树/metadata/update_record 与文章同事务」。

## Data Flow

一次 `applyNativeOutput` 的数据流（以 `lib/engine/native-run.js:52-82` 的生产接线为例）：

1. **输入**：`repoRoot`、`report`（质量门产物，`lib/engine/quality-gate.js:538-567`）、`docsDir`（引擎 docs 目录）、`extraFiles`（受管状态文件，由 `nativeState.captureDocsDir` 采集，`lib/engine/native-run.js:553`）、`pruneRoots=['.codewiki/_native-state/docs']`（`lib/engine/native-run.js:623`）、`noChanges`（idle 轮）、`deps.applyDeps`（`lib/engine/native-run.js:650`）。
2. **写集构建**：从 `report.rendered` 取 `{wikiPath, content}`（`lib/engine/apply-plan.js:588`），附加 `extraFiles`（`lib/engine/apply-plan.js:591-597`），再从 `report.entry.source` 经 `entryBody` 读正文剥 frontmatter 得到入口项（`lib/engine/apply-plan.js:599-624`）。
3. **写集校验**：`checkWriteTargets` 生成 `targets` + `problems`（`lib/engine/apply-plan.js:631-639`）；`problems` 折算成 `write-failed` 并入 `pushProblem`（`lib/engine/apply-plan.js:635`）。整批拒写时 `done({outcome:'failed'})` 早退。
4. **pre-image 捕获**：`capturePre` 对 `targets + pruneTargets + _index.md + _meta.yaml` 快照（`lib/engine/apply-plan.js:658-666`），`wikiExisted` 标记是否是首次建 wiki（`lib/engine/apply-plan.js:667-668`）。
5. **`cw init` 前置**：缺 `_meta.yaml` 时按 `wikiExisted` 分别报 `wiki-missing` 或先 `cw init`（`lib/engine/apply-plan.js:683-702`）。
6. **写盘 + 裁剪**：`writeAll` 写 `targets`（`lib/engine/apply-plan.js:709`），随后删除 `pruneTargets` 里「本轮没有」的状态文件并清空调空目录（`lib/engine/apply-plan.js:715-723`）。
7. **索引 + 规范化 + 缺页比对**：`cw index` → `normalizeIndexLinksIn` → `findArticlesMissingFromIndex`（`lib/engine/apply-plan.js:736-792`），任一失败 `rollback()` 并早退。
8. **基线**：`report.canAdvanceBaseline===true` 时 `cw meta update`，否则记 `baseline:{advanced:false, ok:true}`（`lib/engine/apply-plan.js:798-823`）。
9. **提交**：`commitWikiArtifacts`（或注入的 `commit`）跑完 → `verifyCommitScope` 反查提交内容（`lib/engine/apply-plan.js:833-842`）；`committed` 但混进 wiki 外路径 → `commit-scope`（不回滚）；未成立 → `commit-failed`（不回滚）。
10. **终态合成**：`done()`（`lib/engine/apply-plan.js:543-553`）将 `problems` 经 `toApplyBlockers` 转成契约 blockers，有 blockers 则 `outcome` 由 done 降 partial；`canAdvanceBaseline` 仅在全部成立时为真。
11. **回传**：`ApplyResult` 被 `runNativeJob` 收进 `settle` 的 `apply` 字段（`lib/engine/native-run.js:142-150`），再与引擎/质量门结论取「最弱终态」合成（`lib/engine/native-run.js:654-686`）。

注意：回滚对象不只是本次写的文章——`cw index` 重写的 `_index.md` 与 `cw meta update` 重写的 `_meta.yaml` 同样进入 `watch` 列表（`lib/engine/apply-plan.js:660-665`），保证「库是否干净」的判据随文章一起复原。

## Connections

- [[engine_quality_gate]] — 上游采用门：本模块的 `report` 参数即 `gateNativeOutput` 的返回值（`lib/engine/quality-gate.js:390-568`），落地器只认它的 `writable`/`outcome`/`canAdvanceBaseline` 结论。
- [[engine_contract]] — 终态词表：`BLOCKER_KINDS`（`lib/engine/contract.js:57-72`）是 `toApplyBlockers` 映射的目标（`lib/engine/apply-plan.js:310-333`），`APPLY_RESULT_KINDS` 必须与之一致。
- [[engine_native_run]] — 生产编排：`runNativeJob` 在「落地器」步骤调用 `applyNativeOutput`，并注入 `deps.applyDeps`、拼装 `extraFiles`/`pruneRoots`（`lib/engine/native-run.js:605-635`）。
- [[engine_native_state]] — 受管状态：`.codewiki/_native-state/docs` 下的图/树/metadata 经 `extraFiles` 与文章同事务写盘、同回滚、同提交（`lib/engine/native-state.js:39-40`）。
- [[engine_mapping]] — 写集白名单 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL` 来自 `mapping.js:30-32`，落地器不自己定义路径。
- [[index.js]]（插件主入口）— 提供注入的 `runCw`（`index.js:186`）与分支合并式 `autoCommitWiki`（`index.js:4995`），两者是 `commitWikiArtifacts` 的对齐对象；`normalizeIndexLinks`（`index.js:301`）是 `normalizeIndexLinksIn` 的同语义兄弟。
- [[git-paths]] — `withQuotepathOff` / `decodeGitPaths` 用来让中文路径在提交校验里不被误判越界（`lib/engine/apply-plan.js:42`、`:210-220`）。
- [[article-contract]] — `parseFrontmatter` 用于剥入口页 frontmatter（`lib/engine/apply-plan.js:41`、`:473-476`）。

## Known Issues

- **`normalizeIndexLinksIn` 的 ENOENT 语义与 `index.js:301` 不同**：`index.js` 的 `normalizeIndexLinks` 把读失败一律当「文件不存在」返回 false（探测式）；落地器这版 ENOENT 返回 false、其余读写错误**抛出**（`lib/engine/apply-plan.js:447-461`），否则会把「索引文件坏到读不出来」误判成「不需要规范化」然后判成功。两条路径不能混用。
- **`.codewiki/` 首段必须以 `_` 开头才能被裁剪/不被 cw 收录**：受管状态目录是 `.codewiki/_native-state`（`lib/engine/native-state.js:28`），其下原始文章若被放在不以 `_` 开头的子目录（如 `temp`）会被 cw index 收成第二份文章（`lib/engine/native-state.js:20-28`）。`findArticlesMissingFromIndex` 与 `cw index` 都用 `seg.startsWith('_')` 过滤（`lib/engine/apply-plan.js:357`），路径约定一旦破坏会误报缺页。
- **首次编译的锁落盘时机**：`native-run.js` 把 `.codewiki/engine-lock.json` 的写入推迟到落地器跑完之后（`lib/engine/native-run.js:269-275`、`:699-711`），否则 `.codewiki/` 在 `cw init` 前就存在，落地器会把它判成「人工破坏的半截库」并拒绝自动初始化，导致首次编译整批失败回滚。
- **内置提交器与注入提交器的差异**：`commitWikiArtifacts`（`lib/engine/apply-plan.js:260`）是「直接提交」，而 `index.js:4995` 的 `autoCommitWiki` 是「分支合并式」。生产路径由 `native-run.js` 注入后者，二者安全边界必须对齐，否则「阶段 3 能提交、阶段 4 不能」会变成无人能解释的行为差异（`lib/engine/apply-plan.js:252-254`）。
- **`dryRun` 与 `noChanges` 的终态歧义**：`dryRun` 的 `outcome` 只表示「裁决可采纳」、`applied=false`（`lib/engine/apply-plan.js:641-646`）；`noChanges` 短路返回 done 但 `index`/`baseline`/`commit` 全部标 `skipped`/`noChanges`（`lib/engine/apply-plan.js:565-570`）。调用方必须同时看 `applied` 与 `dryRun` 两个字段，别把预览当成完成。
- **`verifyCommitScope` 依赖真实 git**：该函数的验收对象是「提交里到底有什么」，桩出不了真值，所以只在 `test-engine-apply-plan.mjs:599-668` 的真 git 用例里覆盖；纯桩测试不涉及它（`test-engine-apply-plan.mjs:1-6`）。
