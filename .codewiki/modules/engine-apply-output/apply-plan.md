---
title: apply_plan（阶段 3 落地器）
type: module
source_files:
  - lib/engine/apply-plan.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/article-contract.js
  - test-engine-apply-plan.mjs
tags: [apply-plan, quality-gate, cw-index, baseline, auto-commit, rollback]
---

## Overview

`lib/engine/apply-plan.js`（739 行）是迁移流水线的**阶段 3 落地器**。它位于 [[quality_gate]]（quality-gate.js 的 `gateNativeOutput`）给出「采用裁决 report」之后、产物真正进仓库之前，把裁决原子地落地成仓库内 `.codewiki/`（文章 + `_index.md` + `_meta.yaml`）与仓库根 `CodeWiki.md` 入口。

落地不是「写几篇」就等于「成立」。0.14.0 的教训正是把「写成几篇」当成「成立」——1 篇成功 + 19 篇失败也报 done。所以本模块把落地拆成四步，每步都可能独立失败：

1. **写盘**（write）：把渲染结果写进白名单内的路径；
2. **`cw index`**（index）：重建 `_index.md`，索引建不起来就是坏库；
3. **基线推进**（`cw meta update`，baseline）：宣布「这些变化已消化」，写不成就是记账错误；
4. **自动提交**（commit）：产物入库，否则别人拉下来看不到。

本模块唯一的验收标准是**三条硬不变量**（apply-plan.js:10–22）：

- **不变量 1 · 写集封闭**：只允许写 `.codewiki/` 之下与仓库根 `CodeWiki.md`。渲染结果里的路径由引擎 page 名映射而来，直接信它等于把「引擎能写仓库任意文件」写进契约。绝对路径、盘符、`..` 上跳、白名单外路径一律**整批拒写**（不是跳过该条），写集不完整时部分写入等于制造没人理会的半成品。
- **不变量 2 · 索引/基线失败即回滚**：文章写盘之后 `cw index` 或 `cw meta update` 失败，磁盘必须回到应用前的样子（旧文章内容原样写回、新建文件删掉、`_index.md`/`_meta.yaml` 恢复 pre-image）。否则库里留下「文章在、索引没有」或「文章在、基线已推进」的结构，下次编译会在脏库上判「已消化」而脏库永不自愈。
- **不变量 3 · 提交失败不回滚**：自动提交是「产物入库」最后一步，它失败时文章本身是好的、有用的（与索引/基线相反——那两步失败说明这批产物还没被库接受）。只记 `commit-failed` 阻塞并如实返回，绝不因为提交失败删掉有价值文章。

**依赖注入而非 import**：本模块刻意**不 import index.js**（那是插件主入口，加载会连带拉起宿主服务与 webServer，单测就成「为测一个写盘函数启动整个插件」）。`runCw` / `commit` / `normalizeIndexLinks` / `verifyCommit` 全部由调用方注入（阶段 4 由 index.js 注入自己的 `runCw` 与 `autoCommitWiki`，见 index.js:4655 分支合并式；测试注入桩）。但「可注入」≠「默认什么都不做」：默认必须自带同语义的提交器 `commitWikiArtifacts`（apply-plan.js:250），否则阶段 3 自己跑起来产物只落盘不入库，看着仍是 done——那正是「自动提交失败被改写成成功」的前身。它的安全边界逐条对齐 `autoCommitWiki`（只 add wiki 两个路径 / 不 amend 不 push / 合并冲突与无 HEAD 一律拒绝），差别只在实现大小（直接提交，不建主题分支）。

## Key Components

本模块全部公开符号（均为 `export`，并在 apply-plan.js:727–738 的 `export default` 中再次汇总）。行号以源码前缀为准。

### 公开常量

- **`APPLY_VERSION`**（apply-plan.js:43，值 `1`）：落地结果 `ApplyResult` 的 schema 版本，写进 `base.version`，供反序列化方判断是否认识该结构。
- **`APPLY_WRITE_ROOTS`**（apply-plan.js:46，`Object.freeze([WIKI_DIR, WIKI_ENTRY])` → `['.codewiki', 'CodeWiki.md']`）：写集白名单。只有这两棵子树/文件允许被写。来源 `WIKI_DIR`/`WIKI_ENTRY`（mapping.js:30–31）。
- **`APPLY_STAGES`**（apply-plan.js:49，`['write','index','baseline','commit']`）：面板步骤条与日志按它对齐；顺序即推进顺序（被 test-engine-apply-plan.mjs:139 断言）。
- **`APPLY_PROBLEM_KINDS`**（apply-plan.js:52–59）：写集校验的问题类别（机读，新增只允许追加）：
  - `empty-target`（写集里出现空路径）
  - `absolute-target`（绝对路径 / 盘符）
  - `escaping-target`（`..` 上跳）
  - `out-of-scope`（白名单之外）
  - `duplicate-target`（同一路径写两次且内容不一致）
  - `bad-content`（`content` 不是字符串）
- **`APPLY_RESULT_KINDS`**（apply-plan.js:62–73）：落地结果的问题类别：
  - `write-failed`、`index-failed`、`baseline-failed`：直接对应契约 `BLOCKER_KINDS`
  - `commit-failed`：自动提交失败（不算引擎失败，但产物未入库）
  - `commit-scope`：提交成立但混进 wiki 之外路径
  - `not-writable`：裁决本身不允许入库
  - `wiki-missing`：`.codewiki/` 缺失或没法初始化（映射到 `index-failed`）
  - `gate-partial`：裁决自己是 partial（能力降级/存量未重编译等），但 `writable=true` 所以照样落盘；落地器不许把这个 partial 洗成 done

### 公开函数

- **`checkWriteTargets(items)`**（apply-plan.js:86–131，纯函数不碰磁盘）：写集校验。把 `items`（`{path, content?}` 数组）逐项检查，返回 `{ok, targets, problems}`。`targets` 是规范化后的 `{rel, content}` 列表，`problems` 是 `{kind, detail, target}`。规则：剔除 `./` 前缀与反斜杠（apply-plan.js:481、`toPosix` 在 apply-plan.js:75）；拒绝空路径、`isAbsolute`/盘符（`/^[a-zA-Z]:/`）/以 `/` 开头、`..` 上跳（`path.posix.normalize` 后含 `../` 或等于 `..`）、白名单外（`APPLY_WRITE_ROOTS.some` 判定 `norm===root || norm.startsWith(root+'/')`，注意 `.codewikix` 不会被当子路径）；要求 `content` 为字符串；同一 `rel` 内容相同去重（无害），内容不同记 `duplicate-target`（保留哪份都是猜）。不「逐条跳过坏路径」：残缺写集落盘后调用方会以为「大部分成功」，比整批拒写危险得多（apply-plan.js:92–82）。
- **`verifyCommitScope(repoRoot, sha, {allowExtra, files})`**（apply-plan.js:224–237）：校验一次提交是否**只**动了 wiki 产物。若 `files` 未传则调 `defaultVerifyCommit`（apply-plan.js:203–210，用 `git show --name-only`）反查实际提交内容；否则直接用传入的 `files`。把每个文件 `toPosix` 后与「`APPLY_WRITE_ROOTS` ∪ `allowExtra`」比对，落在任一写集前缀下的放行，其余进 `unexpected`。返回 `{ok, files, unexpected, reason?}`。`reason` 仅当 `unexpected` 非空时附上（列出最多 5 条）。这是把「命令带了 pathspec」和「提交里真的只有这两个路径」之间的差异变成可断言的事实（应对仓库钩子、并发暂存、`.gitignore` 变化跑偏）。
- **`commitWikiArtifacts(cwd, {jobId, writtenCount})`**（apply-plan.js:250–295）：阶段 3 自带的小提交器，只把 wiki 产物入库。固定 pathspec 在文件不存在时会让 `git add` fatal，所以先 `APPLY_WRITE_ROOTS.filter(fs.existsSync)`（apply-plan.js:255）。安全边界逐条照抄 `autoCommitWiki`：`rev-parse --is-inside-work-tree` 校验是 git 仓库、`rev-parse --verify -q HEAD` 校验无 HEAD 拒绝、`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 任一存在则拒绝（避免把 wiki 夹进别人的合并提交）、`ls-files -u` 检出未解决冲突拒绝、`.gitignore` 忽略 `APPLY_WRITE_ROOTS` 则拒绝、无 `status --porcelain` 改动时 `noChanges` 返回、`user.email`/`user.name` 未配置拒绝。提交用 `--no-verify`（不跑 husky/lint-staged）、pathspec 形式限定在 wiki 两路径、不 amend 不 push。返回 `{committed, sha, message, noChanges?, reason?, files?}`。
- **`toApplyBlockers(problems)`**（apply-plan.js:309–320）：把落地问题翻成契约 `BLOCKER_KINDS`（面板/终态判定共用一套词表）。每个 problem 的 `kind` 经 `TO_CONTRACT_KIND`（apply-plan.js:298–307）映射到 `quality-gate`/`index-failed`/`baseline-failed`/`commit-failed` 之一；若映射结果不在 `BLOCKER_KINDS`（contract.js:42–53）里则抛错（契约测试枚举全表，写错的 kind 会让面板与终态判定同时失明，apply-plan.js:311–313）。返回的 blocker `{kind, detail, target?}`，`detail` 以 `[原类别]` 前缀便于定位（apply-plan.js:316）。
- **`applyNativeOutput(options)`**（apply-plan.js:414–725，async）：落地主入口。入参 `options = {repoRoot, report, docsDir?, wikiPath?, advanceBaseline?, entryMode?, dryRun?, deps?}`，返回可序列化 `ApplyResult`。完整推进步骤与三条不变量见下。

### 内部辅助（非导出，但落地器正确性的关键）

- `toPosix`（apply-plan.js:75）：`String(p).replace(/\\/g,'/')`，反斜杠→正斜杠。
- `capturePre`（apply-plan.js:138–153）：对一批 `rel` 拍 pre-image 快照（存在则读内容，不存在记 `exists:false`），返回 `{rel, abs, exists, content}[]`。
- `restorePre`（apply-plan.js:155–176）：**逆序**恢复快照（后写的先撤）；pre-image 存在的原样写回，不存在的（本次新建）`unlinkSync` 删掉；恢复失败的进 `failed` 数组（不抛）。
- `writeAll`（apply-plan.js:178–187）：`mkdirSync(recursive)` + `writeFileSync` 把 `targets` 全部落盘，返回写过的 `rel[]`。
- `defaultRunCw`（apply-plan.js:191–201）：默认 cw 通道，`spawnSync` 同步跑，返回 `{exitCode, stdout, stderr, timedOut}`（与注入的 `runCw` 签名一致）。
- `defaultVerifyCommit`（apply-plan.js:203–210）：用 `git show --name-only --pretty=format:` 取某次提交的文件清单。
- `findArticlesMissingFromIndex`（apply-plan.js:338–359）：找出「已写盘但没进 `_index.md`」的文章（补 `cw index` 静默跳过 frontmatter 坏文章的漏洞）。按路径比（路径比 title 稳定），跳过 `_` 开头文件，读出 `_index.md` 的 `[[link]]` 链接集做差集。
- `normalizeIndexLinksIn`（apply-plan.js:376–390）：把 `_index.md` 里 `[[link|title]]` 链接头的 `\` 规范成 `/`（应对 Windows 上 cw 写出反斜杠链接）。与 index.js:213 的 `normalizeIndexLinks` 唯一差别：这里 ENOENT 返回 `false`（没有索引可规范化），其余读写错误**抛出**（落地器不能把「索引坏到读不出」当成「不需要规范化」）。
- `entryBody`（apply-plan.js:395–398）：剥掉产物入口页自带 frontmatter（用 `parseFrontmatter`，article-contract.js:77–90），只返回正文；`CodeWiki.md` 是仓库级入口，不参与 cw 索引，带一层 frontmatter 只是噪音。

### 返回结构 `ApplyResult`（由 `done()` 在 apply-plan.js:450–460 构造）

`base`（apply-plan.js:433–449）字段：

- `version`：= `APPLY_VERSION`
- `startedAt` / `finishedAt`：ISO 时间戳（apply-plan.js:458、458）
- `repoRoot`：`path.resolve` 后的绝对路径（apply-plan.js:425）
- `applied`：布尔，是否真落盘成立
- `outcome`：`'done' | 'partial' | 'failed'`
- `written`：写过的 `rel[]`
- `entry`：`{rel, action}`，action ∈ `keep`/`skip`/`overwrite`/`write`
- `index` / `baseline` / `commit`：三步各自的结果对象（见下）
- `rolledBack`：布尔
- `problems` / `blockers`：落地问题 / 契约 blocker
- `notes`：人类可读备注
- `canAdvanceBaseline`：布尔，`applied===true && baseline.advanced===true && problems.length===0`

`done()` 还会做终态收敛（apply-plan.js:450–459）：`blockers = toApplyBlockers(problems)`；若 `outcome==='done'` 但 `blockers` 非空则降为 `partial`；`ok = outcome==='done'`。

`index` 结果对象形态：`{ok, exitCode, normalized?, rolledBack?, missing?}`（`missing` 为缺页 `rel` 列表，见 apply-plan.js:92）；`baseline`：`{advanced:boolean, ok?, reason?, exitCode?}`；`commit`：来自 `commitWikiArtifacts` 或注入器的返回，并叠加 `scope`（来自 `verifyCommitScope`/`verifyCommit`）。

## Architecture

落地器的执行是一条**带回滚点的线性流水线**。除 `checkWriteTargets` / `verifyCommitScope` / `commitWikiArtifacts` / `toApplyBlockers` 是纯函数/独立提交器外，`applyNativeOutput` 的推进与回滚关系如下（≤20 行）：

```text
┌──────────────────────────────────────────────────────────────────┐
│ applyNativeOutput(report)  lib/engine/apply-plan.js:414           │
│  deps: {runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary}│
└───────────────┬──────────────────────────────────────────────────┘
                │ 1) report.writable!==true → failed (一个字不写)
                ▼
┌───────────────────────────┐   reject-all   ┌──────────────────┐
│ checkWriteTargets(items)  │──── 写集越界 ──▶│ write-failed +   │
│ apply-plan.js:86          │   (不变量1)     │ 整批拒写          │
└───────────────┬───────────┘                └──────────────────┘
                │ ok
                ▼ 2) capturePre → pre-image 快照 (含 _index.md/_meta.yaml)
┌───────────────────────────┐
│ writeAll(root, targets)   │ 写盘失败 → rollback() → write-failed
│ apply-plan.js:178         │
└───────────────┬───────────┘
                ▼ 3) cw init (若 .codewiki 缺失, 3b)
┌───────────────────────────┐
│ runCw('index')            │ exit!=0 / 规范化异常 / 索引缺页
│ + normalizeIndexLinksIn   │   → rollback() (不变量2: 复原文章+索引+基线)
│ + findArticlesMissing…    │
└───────────────┬───────────┘
                ▼ 4) runCw('meta','update') 仅当 shouldAdvance
┌───────────────────────────┐
│ baseline 推进             │ exit!=0 → rollback() (文章也不留)
└───────────────┬───────────┘
                ▼ 5) doCommit(root) 内置 commitWikiArtifacts / 注入器
┌───────────────────────────┐
│ verifyCommitScope(sha)    │ committed=false → commit-failed (不变量3:
│                            │   不回滚产物, 终态最多 partial)
└───────────────┬───────────┘
                ▼
         done / partial / failed
         (canAdvanceBaseline = applied&&baseline.advanced&&无问题)
```

组件依赖边界：`apply-plan.js` 仅 import 三个叶子模块——`mapping.js`（取 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`，mapping.js:32–32）、`contract.js`（取 `BLOCKER_KINDS`，contract.js:42–53）、`article-contract.js`（取 `parseFrontmatter`，article-contract.js:77–90）。**不** import `index.js`，所有外部副作用（跑 cw、提交、规范化链接、验提交）都走 `deps` 注入（apply-plan.js:411、532–537）。

## Data Flow

### `applyNativeOutput` 完整推进步骤与不变量

入参 `options`（apply-plan.js:414–423）：`repoRoot`（绝对仓库根）、`report`（gateNativeOutput 返回值）、`docsDir`（引擎 docs 目录，读入口正文用）、`wikiPath?`、`advanceBaseline?`（覆盖 `report.canAdvanceBaseline`）、`entryMode?`（缺省 `'keep'`，取值 `keep`/`overwrite`/`skip`）、`dryRun?`、`deps?`（注入 `{runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary, jobId}`）。

步骤：

1. **初始化与可序列化骨架**（apply-plan.js:424–460）：记录 `startedAt`，`path.resolve` 出 `root`。构造 `base`（apply-plan.js:433–449）与 `done()` 收敛器（apply-plan.js:450–460）。任何未登记 `APPLY_RESULT_KINDS` 的 kind 被 `pushProblem` 抛错（apply-plan.js:428–431）——这把词表违规变成启动期故障。
2. **无仓库根 → 失败**（apply-plan.js:462–465）：`not-writable` + `outcome:'failed'`。
3. **裁决不允许入库 → 一个字不写**（apply-plan.js:467–470）：`report.writable !== true` 时直接 `not-writable` 失败，不重复 gate 判定，只认结论。测试钉死：test-engine-apply-plan.mjs:260–269「writable=false → 一个字都不写」，且 `blockers[0].kind === 'quality-gate'`。
4. **裁决 partial 但 writable=true → 照写但不洗成 done**（apply-plan.js:475–478）：`gateOutcome !== 'done'` 时压 `gate-partial` 问题（pushProblem，apply-plan.js:477）。落地器必须把「没消化完」如实记下，否则下一轮会以为这些变化已消化。测试：test-engine-apply-plan.mjs:445–468。
5. **收集写集**（apply-plan.js:480–513）：遍历 `report.rendered` 推 `{path: r.wikiPath, content: r.content}`；入口从 `report.entry.source` 读 `docsDir` 下文件正文（用 `entryBody` 剥 frontmatter）。`entryMode` 三种处置：`keep`（已存在则保留人工入口，action=`keep`）、`skip`（action=`skip`）、默认/overwrite（读正文、非空才推入写集，action=`overwrite`/`write`）。入口缺失（`report.entry` 为 null）则 `not-writable` 失败——拒绝生成「只有文章的 wiki」（apply-plan.js:395–513）。入口正文空（除 frontmatter 外无内容）也 `write-failed` 失败（apply-plan.js:483–506）。
6. **写集校验 + 整批拒写**（apply-plan.js:515–522，不变量 1）：调 `checkWriteTargets`。失败把所有问题统一记 `write-failed`（原子类别保留在 `detail` 前缀 `[kind]` 里），并**整批拒写**返回 `failed`。测试：test-engine-apply-plan.mjs:28–299「越界路径 → 整批拒写（不是跳过该条）」，合法页 `.codewiki/modules/core.md` 也不写；test-engine-apply-plan.mjs:157–171 覆盖 `APPLY_PROBLEM_KINDS` 全部输出类别。
7. **dryRun 短路**（apply-plan.js:525–530）：只算写集与判定，返回 `applied:false`、`dryRun:true`，**不写盘、不跑 cw、不提交**。测试：test-engine-apply-plan.mjs:249–258。调用方必须把 `applied===false` 与 `dryRun===true` 当作「预览而非完成」。
8. **解析注入依赖**（apply-plan.js:532–537）：`runCw` 默认 `defaultRunCw`，`cwBinary` 默认 `process.env.DSH_CODEWIKI_CW ?? 'cw'`，`commit` 默认走内置 `commitWikiArtifacts`（apply-plan.js:536，绝不允许「没注入就不提交」），`verifyCommit` 默认 `null`（回退到 `verifyCommitScope`）。
9. **pre-image 快照**（apply-plan.js:92–552）：对 `targets` 的所有 `rel` + `path.posix.join(WIKI_DIR,'_index.md')` + `WIKI_META_REL` 去重后 `capturePre` 拍快照。注意索引/基线即使不是本次写的也要能恢复（它们是「库是否干净」的判据）。`rollback()`（apply-plan.js:546–552）调 `restorePre` 后，若整个 `.codewiki/` 是本次才出现（`!wikiExisted`）则 `fs.rmSync` 删掉空壳目录——否则回滚后会留下「有 wiki 没文章」的假象。
10. **`cw init` 兜底**（apply-plan.js:546–577，3b）：`.codewiki/_meta.yaml` 缺失时必须先 `cw init` 建骨架，否则 `cw meta update` 必在最后一步基线失败、整批回滚。若 `.codewiki/` 存在却缺 `_meta.yaml`（人工半截破坏），`wiki-missing` 失败且**不自动初始化**。init 失败则 `rollback()` 并 `wiki-missing`。
11. **写盘**（apply-plan.js:178–589）：`writeAll`。异常则 `rollback()`、`write-failed`、`applied:false`、`rolledBack` 视恢复情况。
12. **`cw index` + 规范化 + 缺页比对**（apply-plan.js:591–649，不变量 2 主场）：
    - `runCw('index')`：`exitCode!==0` → `rollback()` + `index-failed`（新文件删、旧内容复原、索引复原，测试 test-engine-apply-plan.mjs:305–323）。
    - `normalizeIndexLinksIn`（或注入 `normalizeIndexLinks`）：把链接头反斜杠规范成正斜杠；**异常按索引失败同等处置**——`rollback()` + `index-failed`，绝不「吞错往下走」（apply-plan.js:546–627、测试 test-engine-apply-plan.mjs:521–540）。
    - `findArticlesMissingFromIndex`（apply-plan.js:636–649）：补 `cw index` 的静默跳过漏洞——cw 在 frontmatter 解析失败时 `continue` 仍返回 exit 0（vendor/codewiki/src/main.rs:236-256），导致「缺页静默成功」。比对路径差集，有缺页则 `rollback()` + `index-failed` 并记下 `index.missing`（测试 test-engine-apply-plan.mjs:563–569）。
13. **基线推进**（apply-plan.js:655–680，不变量 2 延续）：`shouldAdvance` 由 `advanceBaseline`/`report.canAdvanceBaseline` 决定（apply-plan.js:655–657）。不推进时 `baseline.advanced=false` 且只记 note（测试 test-engine-apply-plan.mjs:340–351）。推进时 `runCw('meta','update')`，`exitCode!==0` → `rollback()` + `baseline-failed`（**连文章也回滚**，避免「文章比基线新」被下一轮重复消费，apply-plan.js:546–654）。
14. **自动提交**（apply-plan.js:536–707，不变量 3）：调 `doCommit`。
    - `committed===true`：用 `verifyCommit`（注入）或 `verifyCommitScope` 反查实际提交内容（apply-plan.js:224–694）；若 `scope.ok===false` 且有 `unexpected`，压 `commit-scope`（不回滚，文章与提交都真存在，如实报让人处理，apply-plan.js:695–698、测试 test-engine-apply-plan.mjs:391–401）。
    - `noChanges===true`：只记 note，不认作失败也不宣称已入库（apply-plan.js:700–703、测试 test-engine-apply-plan.mjs:370–377）。
    - 其余（提交未成立且非 noChanges）：压 `commit-failed`，但**文章与索引/基线已生效，不回滚**（apply-plan.js:704–706、测试 test-engine-apply-plan.mjs:357–368）。
15. **终态兜底**（apply-plan.js:709–715）：若 `commitRes.committed !== true && commitRes.noChanges !== true` 且前面漏了 push，则兜底压 `commit-failed`「产物未入库（提交通道未成立）」——**绝不在「未提交」状态下留一个干净的 done**。最终 `outcome = problems.length===0 ? 'done' : 'partial'`，`done({applied:true, ...})` 返回（apply-plan.js:716–725）。

### `commitWikiArtifacts` 的安全边界（apply-plan.js:250–295）

逐条对齐 index.js 的 `autoCommitWiki`，一条都不放宽，否则「阶段 3 能提交、阶段 4 不能」会变成没人能解释的行为差异：

| 检查 | 行为 | 行号 |
| --- | --- | --- |
| 只 add 磁盘存在的 wiki 路径 | `APPLY_WRITE_ROOTS.filter(fs.existsSync)`，否则 `git add` 对不存在文件 fatal | apply-plan.js:255–258 |
| 是 git 仓库 | `rev-parse --is-inside-work-tree` 必须等于 `true` | apply-plan.js:260–261 |
| 有 HEAD | `rev-parse --verify -q HEAD` 失败则拒绝（无首次提交） | apply-plan.js:262 |
| 不在合并/变基中 | `MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 任一存在则拒绝 | apply-plan.js:264–266 |
| 无未解决冲突 | `ls-files -u` 非空则拒绝 | apply-plan.js:267 |
| 未被 .gitignore 忽略 | `check-ignore -q` 命中则拒绝（否则误报无改动静默丢产物） | apply-plan.js:269–272 |
| 有未提交改动 | `status --porcelain` 空 → `noChanges` 返回 | apply-plan.js:273–275 |
| 配置了 user | 缺 `user.email`/`user.name` 则拒绝 | apply-plan.js:276–278 |
| 提交方式 | `git commit --no-verify`（不跑 husky/lint-staged） + pathspec 限定 wiki 两路径，不 amend 不 push | apply-plan.js:282–291 |

测试钉死：test-engine-apply-plan.mjs:379–389「未注入提交通道时走内置提交器，非 git 仓库 → commit-failed 且绝不 done」；test-engine-apply-plan.mjs:571–596「零注入 + 真 git 仓库 → 内置提交器真能提交且只含 wiki 产物（`scope.ok===true`）」。

### `verifyCommitScope` 提交范围反查（apply-plan.js:224–237）

提交的安全边界写在 `git add -- .codewiki CodeWiki.md` 的 pathspec 里，但「命令带了 pathspec」和「提交里真的只有这两个路径」是两回事（仓库钩子、并发暂存、`.gitignore` 变化都可能让它跑偏）。本函数用 `git show --name-only` 反查实际提交内容把边界变成可断言的事实：

- `files` 未传 → `defaultVerifyCommit`（`git show --name-only --pretty=format:`，apply-plan.js:203–210）取清单；已传则省一次 git。
- 每个文件 `toPosix` 后与 `allowed = APPLY_WRITE_ROOTS ∪ allowExtra` 比对，落在 `f===root || f.startsWith(root+'/')` 的放行，其余进 `unexpected`。
- 返回 `{ok: unexpected.length===0, files, unexpected, reason?}`（`reason` 仅 `unexpected` 非空时给出，列出最多 5 条越界文件）。

测试钉死：test-engine-apply-plan.mjs:613–623「只含 wiki 产物的提交判 ok」；test-engine-apply-plan.mjs:625–635「混进源码的提交判失败并列出 `src/app.js`」；test-engine-apply-plan.mjs:637–642「`files` 可直接传入」；test-engine-apply-plan.mjs:644–648「`allowExtra` 里的路径不算越界」。

## Connections

- [[quality_gate]]：`applyNativeOutput` 的唯一上游——消费 `gateNativeOutput` 的 report（`writable`/`canAdvanceBaseline`/`rendered`/`entry`）。落地器不重复 gate 判定，只认结论。
- [[mapping]]：提供 `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`（mapping.js:32–32），落地器据此构造写集白名单 `APPLY_WRITE_ROOTS` 与索引/基线路径。
- [[contract]]：提供 `BLOCKER_KINDS`（contract.js:42–53），`toApplyBlockers` 把落地问题翻成契约词表；并共享 `done`/`partial`/`failed` 终态语义。
- [[article_contract]]：提供 `parseFrontmatter`（article-contract.js:77–90），`entryBody` 用它剥掉入口页自带 frontmatter。
- index.js（宿主主入口）：阶段 4 的注入方，向 `deps` 注入 `runCw` 与 `autoCommitWiki`（分支合并式，index.js:4655）、`normalizeIndexLinks`（index.js:213）。落地器刻意不 import 它以避免拉起宿主服务。
- vendor/codewiki：`cw init`/`cw index`/`cw meta update` 的真实实现方；落地器对 `cw index` 静默跳过坏 frontmatter 文章（main.rs:236-256）补了 `findArticlesMissingFromIndex`。

## Known Issues

- **`cw index` 静默缺页**（已用 `findArticlesMissingFromIndex` 缓解，apply-plan.js:338–359、630–649）：真实 cw 在 frontmatter 解析失败时 `continue` 仍返回 exit 0，落地器若不比对路径差集会把「缺页」判成 done。该缓解依赖对 `_index.md` 链接头的路径解析口径与 cw 一致（去掉 `WIKI_DIR` 前缀、`trim_end_matches('.md')`、跳过 `_` 开头文件）。
- **Windows 反斜杠链接**（已用 `normalizeIndexLinksIn` 缓解，apply-plan.js:376–390）：cw 在 Windows 上写出 `[[modules\a|x]]`，会让 stale 判定与链接校验按不同字符串比较同一篇文章。`normalizeIndexLinksIn` 把链接头 `\` 改 `/`，其余读写错误**抛出**（与 index.js 版本的差异见 apply-plan.js:369–371）。
- **新建 `.codewiki/` 回滚残留**（已缓解，apply-plan.js:549–551）：若整个 `.codewiki/` 是本次才出现，回滚后 `fs.rmSync` 删掉空壳目录，避免「有 wiki 没文章」假象。
- **`not-writable` 不细分**：`report.writable !== true` 与「缺入口页」都压 `not-writable`（apply-plan.js:467–469、510–513），调用方需结合 `blockers[].detail` 区分是裁决拒绝还是入口缺失。
- **回滚本身可能失败**：`restorePre` 恢复失败只进 `failed` 数组并在 `notes` 里记「N 个文件恢复失败」（apply-plan.js:427–173、586 等），不会因此抛错中断返回——极端磁盘故障下可能留半截脏库，需人工介入。

## 不变量钉死清单（test-engine-apply-plan.mjs 逐条）

| 不变量 | 测试 | 行号 |
| --- | --- | --- |
| 写集封闭：越界整批拒写 | `渲染结果里有越界路径 → 整批拒写` | test-engine-apply-plan.mjs:283–299 |
| 写集问题统一记 write-failed | 同上 | test-engine-apply-plan.mjs:296–298 |
| `APPLY_PROBLEM_KINDS` 全覆盖 | 同文件 | test-engine-apply-plan.mjs:157–171 |
| `APPLY_STAGES` 顺序即推进 | `APPLY_STAGES 顺序即推进顺序` | test-engine-apply-plan.mjs:139–141 |
| 写集白名单只含两路径 | `写集白名单只含 .codewiki 与 CodeWiki.md` | test-engine-apply-plan.mjs:143–145 |
| 每个落地问题能翻成 BLOCKER_KINDS | `每个落地问题都能翻成契约 BLOCKER_KINDS` | test-engine-apply-plan.mjs:147–155 |
| 索引失败回滚（旧正文复原/新文件删） | `cw index 失败 → 回滚` | test-engine-apply-plan.mjs:305–323 |
| 基线失败回滚（文章也撤回） | `cw meta update 失败 → 回滚` | test-engine-apply-plan.mjs:325–338 |
| 提交失败不回滚，终态 partial | `自动提交失败 → 不回滚` | test-engine-apply-plan.mjs:357–368 |
| 未提交绝不 done | `未注入提交通道时走内置提交器` | test-engine-apply-plan.mjs:379–389 |
| 提交混进 wiki 外 → commit-scope 不回滚 | `提交成立但混进 wiki 外路径` | test-engine-apply-plan.mjs:391–401 |
| partial 裁决照写但不洗成 done | `裁决 partial 且 writable=true` | test-engine-apply-plan.mjs:445–468 |
| 规范化失败整体回滚 | `索引规范化失败 → 记 index-failed 并整体回滚` | test-engine-apply-plan.mjs:521–540 |
| 索引缺页回滚（exit 0 也拦） | `cw index 退出 0 但文章没进索引` | test-engine-apply-plan.mjs:542–569 |
| `verifyCommitScope` 反查 | 第 7 节整段 | test-engine-apply-plan.mjs:613–648 |


