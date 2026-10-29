---
title: test_engine_apply
type: module
source_files:
  - test-engine-apply-plan.mjs
  - test-prune-orphans.mjs
  - lib/engine/apply-plan.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/git-paths.js
  - index.js
tags: [tests, engine, apply-plan, orphan-pruning]
---

## Overview

本模块收录两份测试文件，分别验收「阶段 3 落地器」与「孤儿页清理」两条安全边界，二者都属于「产物真正进仓库之前」的最后一公里裁决，不变量失败会导致 0.14.0 那类「1 篇写成 + 19 篇失败也报 done」的假成功。

- `test-engine-apply-plan.mjs`（773 行）：针对 `lib/engine/apply-plan.js` 的 `applyNativeOutput` 及其纯函数（`checkWriteTargets` / `verifyCommitScope` / `findOrphanPages` / `toApplyBlockers` / `checkDeleteTargets`）。全程用临时目录 + 注入桩，不碰真仓库、不跑真 `cw`；唯一用真 git 的只有 `verifyCommitScope`（第 690–759 行那段），因为它判的就是「提交里到底有什么」。
- `test-prune-orphans.mjs`（199 行）：针对 `index.js` 的 `pruneOrphanModules`（第 361–386 行）。重点不是「能不能删掉」，而是「会不会误删」——增量编译、失败文章、非 `modules/` 目录一律不许动。

两份测试共享的底层不变量：
  1. **写集封闭**：只允许写 `.codewiki/` 之下与仓库根 `CodeWiki.md`（`apply-plan.js:12-15`）。
  2. **索引/基线失败即回滚**：`cw index` 或 `cw meta update` 失败时磁盘回到应用前（`apply-plan.js:16-19`）。
  3. **提交失败不回滚**：自动提交失败只记 blocker、不删文章（`apply-plan.js:20-22`）。

## Key Components

### 测试侧导出的公共函数（test-prune-orphans.mjs）

- `makeWiki()`（第 19–30 行）：建一个 `.codewiki/` 测试沙箱——`modules/` 下 4 篇（`keep.md` / `orphan-a.md` / `orphan-b.md` / `written-failed.md`）+ `concepts/stays.md` + 根级 `_architecture.md`，返回 `{ root, wiki }`。
- `ls(wiki, sub='modules')`（第 31 行）：列某子目录下文件名，排序后返回，便于断言「目录还剩哪些文件」。
- `check(label, fn)`（第 14–16 行）：async 包裹，记录 pass/fail 并打印 `PASS` / `FAIL`，`fails` 数组收集失败用例。
- 用例本身不导函数，全部是顶层 `await check(...)`：覆盖全量/增量、空清单、`slugify` 匹配、删除失败记账等（见下「pruneOrphanModules 用例」）。

### 测试侧导出的公共函数（test-engine-apply-plan.mjs）

- `makeRepo()`（第 51–55 行）：`mkdtempSync` 造仓库根，登记进 `tmpRoots` 收尾统一删除。
- `writeFile(root, rel, text)` / `readFile` / `exists`（第 56–66 行）：相对仓库根的小工具。
- `makeReport({ pages, canAdvanceBaseline, writable, outcome })`（第 69–88 行）：造一份「能过门」的 gate 裁决：`version` / `ok` / `outcome` / `writable` / `canAdvanceBaseline` / `entry` / `articles`（`action:'write'`）/ `rendered` / `defects` / `degradations` / `stale` / `blockers`。
- `makeDocs(dir=null)`（第 91–97 行）：在 docs 目录写一份入口页 `overview.md` 与 `core.md`。
- `seq(calls)`（第 101–103 行）：从桩的 `calls` 里抽出 `args` 并滤掉 `init`，用于断言「先 index 后 meta」的顺序。
- `recordingDeps(overrides)`（第 105–134 行）：核心桩。返回 `{ deps, calls }`——`deps.runCw` 记录每次调用并按 `failOn` 失败，且**忠实模拟真 `cw` 副作用**：`init` 写 `.codewiki/modules/` 与 `_meta.yaml`、`index` 写 `_index.md`、`meta` 写 `_meta.yaml`，`commit` / `verifyCommit` 默认成功。这是「桩必须复刻真行为」的关键，否则回滚测试没意义。
- `gitRepo()`（第 692–702 行）：造一个真 git 仓库（只给 `verifyCommitScope` 用），含一次初始提交。

### 被测公共函数（lib/engine/apply-plan.js）

- `APPLY_VERSION`（第 44 行，`=1`）：落地结果结构版本号。
- `APPLY_WRITE_ROOTS`（第 47 行，`Object.freeze(['.codewiki','CodeWiki.md'])`）：写集白名单，也是删除集白名单。
- `APPLY_STAGES`（第 50 行，`Object.freeze(['write','index','baseline','commit'])`）：落地阶段顺序（步骤条/日志对齐用）。
- `APPLY_PROBLEM_KINDS`（第 53–60 行）：写集校验的问题类别快照——`empty-target` / `absolute-target` / `escaping-target` / `out-of-scope` / `duplicate-target` / `bad-content`。
- `APPLY_RESULT_KINDS`（第 63–74 行）：落地结果问题类别——`write-failed` / `index-failed` / `baseline-failed` / `commit-failed` / `commit-scope` / `not-writable` / `wiki-missing` / `gate-partial`。
- `checkWriteTargets(items)`（第 126–154 行）：纯函数写集校验。规范化 `./` 前缀与反斜杠、拒绝空/绝对/盘符/`..` 上跳/白名单外路径，内容相同去重、内容不同记 `duplicate-target`，非字符串 `content` 记 `bad-content`。返回 `{ ok, targets, problems }`。
- `verifyCommitScope(repoRoot, sha, { allowExtra=[], files=null })`（第 256–269 行）：反查一次提交是否只动了 wiki 产物。`files` 可直接传入省一次 git；否则走 `defaultVerifyCommit`（第 232–242 行，`git show --name-only -c core.quotepath=false`）。与 `APPLY_WRITE_ROOTS` 比对，越界路径收集进 `unexpected` 并写 reason。
- `commitWikiArtifacts(cwd, { jobId, writtenCount })`（第 282–330 行）：阶段 3 自带的提交器（同语义抄 `autoCommitWiki`，见 `index.js:4801`），逐条对齐安全边界：非 git 仓库 / 无 HEAD / 合并中 / 未冲突 / `.gitignore` 忽略 / 无改动 / 缺 user.name/email 一律返回 `{committed:false, reason}`。
- `toApplyBlockers(problems)`（第 344–355 行）：落地问题 → 契约 `BLOCKER_KINDS`（`TO_CONTRACT_KIND` 映射表在第 333–342 行）。`kind` 必须落在 `contract.js` 的枚举里，否则抛错。
- `findArticlesMissingFromIndex(repoRoot, written)`（第 373–394 行）：私有纯函数，找出「写盘了但没进 `_index.md`」的文章（真 `cw` frontmatter 解析失败会静默跳过、`exitCode` 仍 0，见 `vendor/codewiki/src/main.rs:236-256`）。
- `findOrphanPages({ repoRoot, keepPages=[], modulesDir='.codewiki/modules' })`（第 435–456 行）：扫描存量模块页，识别**孤儿页**——`source_files` 非空且**每一个**在仓库里都不存在。`source_files` 为空（whole-repository 无归属证据）不算孤儿；保留 `keepPages` 里本轮要写的页。返回 `[{ rel, sourceFiles, missing }]`。
- `checkDeleteTargets(rels, { repoRoot=null })`（第 465–496 行）：删除集白名单校验（与 `checkWriteTargets` 同一把尺子，但不要求 `content`），额外拒绝「目录」作删除目标、并保留 `repoRoot` 下「不存在=幂等删除」的语义。
- `collectPruneTargets(repoRoot, pruneRoots, keepRels)`（第 511–525 行）：私有，算出受管状态目录里「本次写集没有」的过期文件（裁剪清单），裁剪根必须落在写集白名单内。
- `normalizeIndexLinksIn(repoRoot)`（第 560–574 行）：私有内置实现，把 `_index.md` 链接头的 `\` 规范成 `/`；与 `index.js:303` 的 `normalizeIndexLinks` 唯一差别是 ENOENT→false、其余读写错误**抛出**（落地器不能把「索引读不出来」当成「不需要规范化」然后判成功）。
- `applyNativeOutput({ repoRoot, report, docsDir, wikiPath, advanceBaseline, entryMode, dryRun, noChanges, extraFiles, pruneRoots, deleteFiles, beforeCommit, deps })`（第 608–1009 行）：核心落地器。推进顺序见下「Data Flow」。返回 `ApplyResult`（base 初始化于第 632–650 行：`version` / `startedAt` / `repoRoot` / `applied` / `outcome` / `written` / `pruned` / `deleted` / `entry` / `index` / `baseline` / `commit` / `rolledBack` / `problems` / `blockers` / `notes` / `canAdvanceBaseline`），`done()`（第 651–661 行）负责终态合并：`blockers=toApplyBlockers(problems)`、有 blocker 时 `done`→`partial`、`ok=outcome==='done'`、`canAdvanceBaseline` 综合 `applied && baseline.advanced && problems.length===0`。

### 被测公共函数（index.js）

- `pruneOrphanModules(job)`（第 361–386 行）：删除「成为孤儿」的模块文章。入参 `job` 需要 `kind` / `plan.modules`（形如 `[{name}]`）/ `wikiPath` / `articles`（形如 `[{name, ok}]`）。安全边界：只在 `kind==='full'` 且 `modules` 非空数组时动手；只删 `.codewiki/modules/*.md`（`concepts/` / `learnings/` / `_architecture.md` 等不碰，见第 354–356 行）；本次规划内 + 本次写过（含失败）的都保留；删除失败只记账不中断。返回 `{ removed, failed, skipped? }`。

### 被测常量 / 枚举（lib/engine/contract.js）

- `BLOCKER_KINDS`（第 57–72 行，`Object.freeze`）：机读阻塞类别，新增只允许追加。`apply-plan.js` 的 `TO_CONTRACT_KIND`（第 333–342 行）把落地问题映射到其中——`quality-gate` / `index-failed` / `baseline-failed` / `commit-failed` / `not-writable` / `wiki-missing` / `gate-partial`。

### 被测常量（lib/engine/mapping.js）

- `WIKI_ENTRY='CodeWiki.md'` / `WIKI_DIR='.codewiki'` / `WIKI_META_REL='.codewiki/_meta.yaml'` / `WIKI_MODULES_REL='.codewiki/modules'`（第 31–35 行）：写集白名单的语义来源，两个测试都 import 了 `WIKI_ENTRY`。

## Architecture

两份测试分别钉住两条「产物落库前的最后一公里」链路。框图标注组件与文件/类：

```text
┌──────────────────────── test-engine-apply-plan.mjs ────────────────────────┐
│ recordingDeps() 桩（apply-plan.js:105）                                     │
│   runCw: 记调用 + 复刻真 cw 副作用(init/index/meta 各写对应文件)            │
│   commit / verifyCommit: 默认成功                                            │
└───────────────┬──────────────────────────────────────────┬────────────────┘
                │ inject deps                                │
                ▼                                            ▼
┌─────────────────────── apply-plan.js ────────────────┐  ┌── verifyCommitScope ──┐
│ checkWriteTargets        (apply-plan.js:126)          │  │ git show --name-only  │
│ applyNativeOutput        (apply-plan.js:608)          │  │ -c core.quotepath=false│
│   writeAll → cw index → meta update → commit          │  │ (apply-plan.js:232,236)│
│   capturePre/restorePre  (apply-plan.js:161,178)      │  └──────────┬───────────┘
│ findOrphanPages          (apply-plan.js:435)          │            │ files/unexpected
│ findArticlesMissingFromIndex (apply-plan.js:373)      │            ▼
└───────────────┬───────────────────────────────────────┘   toApplyBlockers?
                │ report (gateNativeOutput 产物)            (apply-plan.js:344)
                ▼
        ┌─────────────── contract.js ───────────────┐
        │ BLOCKER_KINDS (contract.js:57)            │
        └───────────────────────────────────────────┘

┌──────────────────────── test-prune-orphans.mjs ───────────────────────────┐
│ makeWiki() 造 .codewiki/ 沙箱 (test-prune-orphans.mjs:19)                  │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ { kind:'full', wikiPath, plan, articles }
                ▼
┌─────────────── pruneOrphanModules (index.js:361) ──────────────────────────┐
│ 只 full + modules 非空 → 删 modules/*.md（不在 planned/touched 集合里）     │
└─────────────────────────────────────────────────────────────────────────────┘
```

两条链路的共同主题是「宁可漏删不可误删」：`applyNativeOutput` 用整批拒写 + 回滚保证写集完整且可恢复；`pruneOrphanModules` 用「full 才动手、只动 modules、失败文章保留」保证删动作不可逆但保守。

## Data Flow

## Connections

## Known Issues
