---
title: engine_apply
type: module
source_files:
  - lib/engine/apply-plan.js
  - lib/engine/native-run.js
  - lib/engine/quality-gate.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/article-contract.js
  - test-engine-apply-plan.mjs
tags: [apply, engine, quality-gate, auto-commit, rollback, cw-index, baseline, native-run]
---

## Overview

`engine_apply` 是迁移流水线里**「把引擎采用的产物真正落到仓库里」**这一整块职责，包含两层：

- **落地器（apply-plan.js）**：`applyNativeOutput`（`lib/engine/apply-plan.js:495`）把采用门 `gateNativeOutput`（`lib/engine/quality-gate.js:390`）给出的裁决 `report` 原子地落地成仓库内 `.codewiki/`（文章 + `_index.md` + `_meta.yaml`）与仓库根 `CodeWiki.md` 入口，并自动提交入库。它是「阶段 3 落地器」，唯一的验收标准是三条硬不变量（写集封闭 / 索引基线失败即回滚 / 提交失败不回滚，见 `lib/engine/apply-plan.js:476-488`）。该落地器本身的逐函数细节由子模块 [[engine_apply_output]]（`modules/engine-apply-output/apply-plan.md`）专门成文，本文只概述其契约与边界，重点放在「它怎么被编排与接线」。
- **编排（native-run.js）**：`runNativeJob`（`lib/engine/native-run.js:109`）是阶段 4 的生产编排器，把一次原生编译的裁决链固定成一条直线，其中最后一步正是调用 `applyNativeOutput`（`lib/engine/native-run.js:50`）。它保证「引擎 done 不能替代质量门、质量门/落地器说 partial/failed 终态就不许是 done、partial/failed 一律不推进基线」（`lib/engine/native-run.js:11-17`）。

「落地等于成立」是 0.14.0 的教训：把「写成几篇」当成「成立」，于是 1 篇成功 + 19 篇失败也报 done。本模块通过「四步独立失败 + 三条不变量 + 最弱终态合成」杜绝这类误报。

**依赖注入而非 import**：落地器刻意不 `import index.js`（加载它会连带拉起宿主服务与 webServer，单测就成「为测一个写盘函数启动整个插件」）。`runCw` / `commit` / `normalizeIndexLinks` / `verifyCommit` 全部由调用方注入；但「可注入」不等于「默认什么都不做」——默认自带同语义提交器 `commitWikiArtifacts`（`lib/engine/apply-plan.js:256`），否则阶段 3 自己跑起来产物只落盘不入库、看着仍是 done（见 [[engine_apply_output]]）。

## Key Components

本模块跨两个文件，全部公开符号以源码 `行号| ` 前缀为准。

### lib/engine/apply-plan.js — 落地器（细节见子模块 [[engine_apply_output]]）

全部导出位于 `lib/engine/apply-plan.js:727-738` 的 `export default`。行号以该文件前缀为准：

- **`APPLY_VERSION`**（:43，值 `1`）：落地结果 `ApplyResult` 的 schema 版本，写进 `base.version`。
- **`APPLY_WRITE_ROOTS`**（:46，`Object.freeze([WIKI_DIR, WIKI_ENTRY])` → `['.codewiki', 'CodeWiki.md']`）：写集白名单，只有这两棵子树/文件允许被写（来源 `WIKI_DIR`/`WIKI_ENTRY`，`lib/engine/mapping.js:30-31`）。
- **`APPLY_STAGES`**（:49，`['write','index','baseline','commit']`）：面板步骤条与日志对齐；顺序即推进顺序。
- **`APPLY_PROBLEM_KINDS`**（:52-59，冻结数组）：写集校验问题类别——`empty-target` / `absolute-target` / `escaping-target` / `out-of-scope` / `duplicate-target` / `bad-content`。
- **`APPLY_RESULT_KINDS`**（:62-73，冻结数组）：落地结果问题类别——`write-failed` / `index-failed` / `baseline-failed` / `commit-failed` / `commit-scope` / `not-writable` / `wiki-missing` / `gate-partial`；每个 kind 都必须在 `pushProblem` 里登记（:428-431），否则启动期抛错。
- **`checkWriteTargets(items)`**（:86-131，纯函数不碰磁盘）：写集校验，返回 `{ok, targets, problems}`；规范化 `./` 前缀与反斜杠、拒绝绝对路径/盘符/`..` 上跳/白名单外、要求 `content` 为字符串、同 `rel` 内容相同去重、内容不同记 `duplicate-target`。残缺写集整批拒写（不逐条跳过）。
- **`verifyCommitScope(repoRoot, sha, {allowExtra, files})`**（:224-237）：用 `git show --name-only` 反查一次提交是否**只**动了 wiki 产物；`files` 可直传省一次 git；落在 `APPLY_WRITE_ROOTS ∪ allowExtra` 前缀外的进 `unexpected`，返回 `{ok, files, unexpected, reason?}`。
- **`commitWikiArtifacts(cwd, {jobId, writtenCount})`**（:250-295）：阶段 3 自带提交器，安全边界逐条照抄 index.js 的 `autoCommitWiki`（只 add wiki 两路径 / 不 amend 不 push / 合并冲突与无 HEAD 一律拒绝）；返回 `{committed, sha?, message?, noChanges?, reason?, files?}`。
- **`toApplyBlockers(problems)`**（:309-320）：把落地问题经 `TO_CONTRACT_KIND`（:298-307）翻成 `contract.js` 的 `BLOCKER_KINDS`；映射结果不在 `BLOCKER_KINDS` 则抛错（契约测试枚举全表）；`detail` 以 `[原类别]` 前缀便于定位。
- **`applyNativeOutput(options)`**（:414-725，async）：落地主入口。入参 `{repoRoot, report, docsDir?, wikiPath?, advanceBaseline?, entryMode?, dryRun?, deps?}`，返回可序列化 `ApplyResult`（字段见子模块 [[engine_apply_output]] 的 `base`/返回结构段，:433-449）。

### lib/engine/native-run.js — 阶段 4 编排（接线方）

全部导出位于 `lib/engine/native-run.js:490-494`。行号以该文件前缀为准：

- **`DEFAULT_ENGINE_ENTRY`**（:34）：默认 Python 引擎入口 `path.join(here, 'python', 'entry.py')`。
- **`DEFAULT_ENGINE_TIMEOUT_MS`**（:38，值 `45 * 60 * 1000`）：一次原生编译默认超时，引擎侧进程树终止兜底。
- **`RANK` / `weakest`**（:41-42）：终态强弱表 `{cancelled:0, failed:1, partial:2, done:3}` 与取最弱函数——合成终态只取最弱的一环，绝不允许被后续步骤提升。
- **`applyBlockersOf(applyRes)`**（:47-53）：把 `applyRes.blockers`（`applyNativeOutput` 产出的契约 blocker）原样翻成 `{kind, detail, target?}`，供 `runNativeJob` 并入终态（不二次映射，因为落地器已经过 `toApplyBlockers` 翻到契约词表）。
- **`runNativeJob(options)`**（:68-488，async）：跑一次原生编译并给出**严格**终态。关键接线点：
  - 注入 `gateImpl`（默认 `realGate`）与 `applyImpl`（默认 `realApply`，:88-89）；`deps.applyDeps` 透传给 `applyNativeOutput` 的 `deps`（:372）。
  - 步骤：环境/锁（:133-218）→ 模型桥（:233-259）→ 引擎 `runEngine`（:261-323）→ **质量门 `gateNativeOutput`（:340）** → **落地器 `applyNativeOutput`（:366，固定 `advanceBaseline:null` 不接受调用方硬开基线）** → 严格合成终态（:385-418）。
  - 终态合成（:399-418）：`finalOutcome = weakest(weakest(engineOutcome, gateOutcome), applyOutcome)`；`blockers` 合并引擎 blockers + `toContractBlockers(report)`（质量门，:407）+ `applyBlockersOf(applyRes)`（落地，:408）；`done` 带 blockers 自动降 `partial`（:412-415）；`partial` 无 blockers 则兜底补一条 `quality-gate`（:416-418）。
  - 首跑落锁：`lockNote` 触发时若 `.codewiki/_meta.yaml` 已存在才 `writeLock`（:426-438），避免往空目录塞 `engine-lock.json` 导致下一轮判成半截库（对应落地器 `wiki-missing` 分支）。

## Architecture

`engine_apply` 的核心是一条「裁决链 → 落地 → 最弱终态」的线性编排。落地器自身是带回滚点的流水线（细节见 [[engine_apply_output]]），这里画的是它在阶段 4 被编排的位置与接线关系（≤20 行，框内标注文件：行号）：

```text
  FSoft docs/ 产物              repoRoot (git + .codewiki/)
       │                              │
       ▼                              │
  ┌─────────────────────────────────────────────────────────┐
  │ quality-gate.js: gateNativeOutput (:390)                 │
  │  → report {outcome, writable, canAdvanceBaseline,         │
  │            rendered[], entry, blockers[]}                 │
  └───────────────────────┬─────────────────────────────────┘
                          │ report (被原生通道/阶段4消费)
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ native-run.js: runNativeJob (:68)  [阶段4 编排]           │
  │  env→bridge→engine(:268) → gate(:340) → apply(:366)      │
  │  advanceBaseline:null (基线只由裁决决定)                  │
  │  deps.applyDeps → applyNativeOutput.deps                 │
  └───────────────┬───────────────────────┬─────────────────┘
                  │                        │
                  ▼                        ▼
  ┌───────────────────────────────┐   ┌──────────────────────────────┐
  │ apply-plan.js:                │   │ 终态合成 (:399-418)          │
  │  applyNativeOutput (:414)     │   │ weakest(engine,gate,apply)   │
  │  deps.runCw / commit /        │   │ + toContractBlockers(report) │
  │  normalizeIndexLinks /       │   │ + applyBlockersOf(applyRes)  │
  │  verifyCommit (注入)          │   │ done带blockers→partial        │
  └───────────────┬──────────────┘   └───────────────┬──────────────┘
                  │ 写盘→index→meta update→commit    │
                  ▼                                  ▼
  ┌───────────────────────────────┐       EngineResult {outcome, blockers,
  │ cw (vendor/codewiki) + git     │        apply:{outcome,applied,rolledBack},
  │ write .codewiki/ + CodeWiki.md │        gate:{}, baseline, commit}
  └───────────────────────────────┘       (lib/engine/native-run.js:440-487)
```

组件依赖边界：

- **落地器 `apply-plan.js`** 只 import 三个叶子模块——`mapping.js`（`WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`，`lib/engine/mapping.js:31-32`）、`contract.js`（`BLOCKER_KINDS`，`lib/engine/contract.js:57-68`）、`article-contract.js`（`parseFrontmatter`，`lib/article-contract.js:77-90`）。**不** import `index.js`，所有外部副作用（跑 cw、提交、规范化链接、验提交）都走 `deps` 注入（:411、:532-537）。
- **编排器 `native-run.js`** 直接 import 真实实现 `runEngine`（`client.js`）、`doctor`/`writeLock`（`manifest.js`）、`gateNativeOutput`/`toContractBlockers`（`quality-gate.js`）、`applyNativeOutput`（`apply-plan.js`）、`startLlmBridge`（`llm-bridge.js`）（:26-31），但允许全部按 `deps` 替换（测试用假 `runEngine` + 真实 gate/apply，:86-93）。
- **终态强弱**：`RANK`（`native-run.js:73`）保证落地器的 partial/failed 不会被引擎的 done 洗白；`done` 带 blocker 一律降 `partial`（:412-415）。

## Data Flow

一次 `runNativeJob` 调用如何把产物落地并从 `ApplyResult` 合成终态：

1. **环境与锁（native-run.js:133-218）**：`doctorImpl` 探测解释器/依赖闭合；`lockStatus` 为 `probe-failed`/`drift`/`unhealthy` 直接 `settle({outcome:'failed'})` 不跑引擎（锁不一致/依赖不闭合跑出来的产物不可信，:179-218）。`absent`（首跑）记 `lockNote` 待后置落锁（:224-225）。
2. **模型桥 + 引擎（native-run.js:233-323）**：`bridgeImpl` 建 loopback 桥（:239）；`runEngineImpl` 跑 `generate`/`update`（按 `scope/kind` 决定，:263），拿到 `result`（`EngineResult`）。`engineOutcome` 为 `cancelled`/`failed` 直接 `settle` 短路（:304-323）。
3. **质量门（native-run.js:129，调用 apply-plan 的上游）**：`gateImpl({docsDir, repoRoot, requireCommittedInput})` 返回 `report`；若 `signal.aborted` 在门后取消则 `settle({cancelled})` 且**未落盘**（:351-360）。
4. **落地器（native-run.js:366-383，核心 apply 接线）**：`applyImpl({repoRoot, report, docsDir, advanceBaseline:null, deps: deps.applyDeps ?? {}})` 调用 `applyNativeOutput`。注意 `advanceBaseline` 固定为 `null`——基线只由「裁决是否完整」决定，partial 一律不推进（:370-371）。异常则 `settle({failed, stage:'index'})`（:374-383）。
5. **落地器内部四步（apply-plan.js，详见 [[engine_apply_output]]）**：写盘 → `cw index`（+ 链接规范化 + 缺页比对）→ `cw meta update`（仅 `shouldAdvance`）→ `doCommit`（内置 `commitWikiArtifacts` 或注入器）→ `verifyCommitScope`。任意一步失败按三条不变量处置：`write-failed`/`index-failed`/`baseline-failed` 触发 `rollback()`（复原 pre-image），`commit-failed`/`commit-scope` 不回滚。返回 `ApplyResult`，含 `applied`/`outcome`/`rolledBack`/`written`/`entry`/`index`/`baseline`/`commit`/`blockers`。
6. **严格终态合成（native-run.js:385-418）**：
   - `finalOutcome = weakest(weakest(engineOutcome, gateOutcome), applyOutcome)`（:401）。
   - `blockers = [...result.blockers, ...toContractBlockers(report), ...applyBlockersOf(applyRes)]`（:402-409）——质量门的 blockers 一律经 `toContractBlockers` 翻成契约 kind，落地器的已翻好直接并入；曾因「只有注入 gate 才带 blockers」导致真实 gate 拦下的死链/空正文在终态消失，故统一走公开转换器。
   - `done` 带 blockers 自动降 `partial`（:412-415）；`partial` 无 blockers 则兜底补 `quality-gate`（:416-418）。
   - `written = applyRes.written.length`（:420）；提交后 `verifyCommitScope` 把 `commit.scope` 带进 `apply.commit`（:484）。
7. **首跑落锁（native-run.js:274-289）**：若 `lockNote` 设置且 `.codewiki/_meta.yaml` 已存在，`writeLockImpl` 原子写 `engine-lock.json`（:428-431）；否则记 note「wiki 未初始化，下次成功编译再落锁」（:435-437），避免把锁写进空目录使下一轮判成半截库。
8. **统一出口（native-run.js:97-124）**：所有分支经 `settle` → `engineResult(base)`（:113），施加契约硬不变量（done 不许带 blockers / partial 必须带 / failed 必须有 error）；最终对象附加 `gate`/`apply`/`engineLock` 现场证据（:440-487）。

下游消费：`runNativeJob` 的返回值（含 `apply` 子对象）由 JobService（index.js 的 `submit`/`start` 阶段机）保存为 job 终态，面板据此展示「已写/失败/基线/提交」明细（`lib/engine/native-run.js:109-135`）。

## Connections

- [[engine_apply_output]]——落地器 `apply-plan.js` 的逐函数细节（常量、`checkWriteTargets`、`verifyCommitScope`、`commitWikiArtifacts`、`toApplyBlockers`、`applyNativeOutput` 的 15 步推进与 `ApplyResult` 结构、三条不变量）由该子模块专门成文；本文只概述其契约与边界。
- [[engine_quality_gate]]——`gateNativeOutput`（`lib/engine/quality-gate.js:390`）是本模块唯一上游：`applyNativeOutput` 消费其 `report.writable`/`canAdvanceBaseline`/`rendered`/`entry`；落地器不重复 gate 判定，只认结论。`runNativeJob` 在 `:340` 调门、在 `:407` 调 `toContractBlockers` 把门的 blockers 翻成契约词表。
- [[engine_output]] / [[engine_mapping]]——`mapFsoftOutput`（`lib/engine/mapping.js:115`）与 `validateOutput`（`lib/engine/output.js`）产出 `rendered`/`entry`；落地器用的 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL` 也定义于 `lib/engine/mapping.js:31-32`。产物对应 commit 来自 `metadata.generation_info.commit_id`。
- [[engine_contract]]——`BLOCKER_KINDS`（`lib/engine/contract.js:57`）是 `toApplyBlockers` 的目标词表；`engineResult` 的硬不变量（done 不许带 blockers）由 `runNativeJob` 的 `settle`（`lib/engine/native-run.js:140`）施加。四态 `done/partial/failed/cancelled` 两边共用。
- [[engine_native_run]]——`runNativeJob`（`lib/engine/native-run.js:109`）的阶段 4 编排是本模块的接线方：在 `:366` 注入 `report` 调落地器、在 `:401` 以 `weakest` 合成最弱终态、在 `:423-438` 处理首跑落锁。
- [[article_contract]]——`parseFrontmatter`（`lib/article-contract.js:77`）被落地器 `entryBody`（:395）用来剥掉入口页自带 frontmatter。
- vendor/codewiki——`cw init`/`cw index`/`cw meta update` 的真实实现方；落地器对 `cw index` 静默跳过坏 frontmatter 文章（`vendor/codewiki/src/main.rs:236-256`）补了 `findArticlesMissingFromIndex`（`lib/engine/apply-plan.js:344`）。
- index.js（宿主主入口）——阶段 4 的真实注入方，向 `deps.applyDeps` 注入 `runCw` 与 `autoCommitWiki`（分支合并式）、`normalizeIndexLinks`；落地器刻意不 import 它以避免拉起宿主服务与 webServer。

## Known Issues

- **落地器三条不变量是「阶段 3 唯一的验收标准」，由测试逐条钉死**：`test-engine-apply-plan.mjs` 不碰真仓库、不跑真 cw，验收对象是**不变量**（写集封闭 / 索引基线失败回滚 / 提交失败不回滚），不是 cw 自己的行为。其中 `verifyCommitScope` 那一条用真 git（`test-engine-apply-plan.mjs:613-648`），因为它判的就是「提交里到底有什么」，桩不出真值。
- **`gate-partial` 照写但不许洗成 done**（apply-plan.js:534-541）：裁决自己是 partial（能力降级/存量未重编译/部分页 skip）但 `writable=true` 时，落地器照样落盘，但终态必须继续报 partial、基线不推进（否则下一轮编译会以为这些变化已消化）。`done()` 的 `canAdvanceBaseline = applied===true && baseline.advanced===true && problems.length===0`（:455-457）强制这条。
- **`not-writable` 不细分**：`report.writable !== true`（apply-plan.js:467）与「缺入口页」（:510-513）都压 `not-writable`；调用方需结合 `blockers[].detail` 区分是「裁决拒绝」还是「入口缺失」。两者都一个字不写。
- **`advanceBaseline` 不接受调用方硬开**：`runNativeJob` 固定传 `advanceBaseline:null`（native-run.js:109），落地器内部按 `report.canAdvanceBaseline` 决定（`apply-plan.js:655-657`）。partial 一律不推进基线，交给上层决定（不变量 4，native-run.js:16）。
- **`cw index` 静默缺页**已用 `findArticlesMissingFromIndex` 缓解（apply-plan.js:344、:630-649）：真实 cw 在 frontmatter 解析失败时 `continue` 仍返回 exit 0，若不比对路径差集会把「缺页」判成 done。该缓解依赖对 `_index.md` 链接头的路径解析口径与 cw 一致（去掉 `WIKI_DIR` 前缀、`trim_end_matches('.md')`、跳过 `_` 开头文件）。
- **Windows 反斜杠链接**已用 `normalizeIndexLinksIn` 缓解（apply-plan.js:447、:609-627）：cw 在 Windows 上写出 `[[modules\a|x]]`，会让 stale 判定与链接校验按不同字符串比较同一篇文章；规范化的任何异常按 `index-failed` 同等处置并整体回滚。
- **回滚本身可能失败**：`restorePre`（apply-plan.js:155）恢复失败只进 `failed` 数组并在 `notes` 里记「N 个文件恢复失败」（:586 等），不会因此抛错中断返回——极端磁盘故障下可能留半截脏库，需人工介入。
- **首跑落锁顺序敏感**：`writeLock` 故意推迟到落地器跑完（native-run.js:423-438），因为 `.codewiki/engine-lock.json` 过早写入会让目录在 `cw init` 之前就存在，落地器会把「`.codewiki` 存在却缺 `_meta.yaml`」判成人工破坏的半截库并拒绝自动初始化（apply-plan.js 的 `wiki-missing` 分支），首次编译会整批失败并回滚。
- **`done` 带 blockers 自动降级**：`runNativeJob` 合成终态时若三者都说 done 却还有 blockers（例如质量门与落地的 blocker 在 `toContractBlockers`/`applyBlockersOf` 合并后非空），则 `finalOutcome` 降为 `partial`（native-run.js:636-639），宁可降级也不掩盖自相矛盾。
