---
title: engine_apply_plan
type: module
source_files:
  - lib/engine/apply-plan.js
  - test-engine-apply-plan.mjs
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/quality-gate.js
  - lib/engine/native-run.js
  - lib/index.js
tags: [engine, native-pipeline, apply, rollback, atomic-commit]
---

## Overview

`lib/engine/apply-plan.js` 是「阶段 3」的**落地器（applier）**：把一个已经通过质量门（`lib/engine/quality-gate.js` 的 `gateNativeOutput`）的采用裁决（`report`）真正写进仓库——`写盘 → cw index → cw meta update（基线）→ 自动提交`，并在任何一步失败时按硬不变量回滚。

它的存在是为了消灭 0.14.0 的缺陷：「写成几篇」被当成「成立」。裁决说「这批页可以入库」和「入库这件事真的成立了」是两回事，中间四步各会失败：写盘（路径越界/权限/磁盘满）、`cw index`（索引建不起来就是坏库）、`cw meta update`（基线推进 = 宣布「这些变化已消化」，写不成就是记账错误）、自动提交（产物没入库别人拉下来看不到）。本模块是唯一负责把这四步串成原子事务的地方。

文件头（`lib/engine/apply-plan.js:1-34`）定义了**三条硬不变量**，也是本模块唯一的验收标准：

1. **写集封闭**（不变量 1，`apply-plan.js:12-15`）：只允许写 `.codewiki/` 之下与仓库根 `CodeWiki.md`。渲染结果里的路径由引擎 page 名映射而来，直接信它等于把「引擎能写仓库任意文件」写进契约。绝对路径、盘符、`..` 上跳、白名单外路径一律**整批拒写**（不是跳过该条，是整批拒——写集不完整时部分写入等于制造一份没人在意的半成品）。
2. **索引/基线失败即回滚**（不变量 2，`apply-plan.js:16-19`）：文章写盘之后 `cw index` 或 `cw meta update` 失败，磁盘必须回到应用前的样子（旧文章原样写回、新建文件删掉、`_index.md` 与 `_meta.yaml` 恢复 pre-image）。否则库里留下「文章在、索引没有」或「文章在、基线已推进」的结构，下次编译会在脏库上判「已消化」，而脏库永远不会自愈。
3. **提交失败不回滚**（不变量 3，`apply-plan.js:20-22`）：自动提交是「产物入库」的最后一步，它失败时文章本身是好的、有用的（与索引/基线相反——那两步失败说明这批产物还没被库接受）。所以只记 `commit-failed` 阻塞并如实返回，绝不因为提交失败把有价值的文章删掉。

**依赖注入而非 import**：本模块刻意不 `import index.js`（那是插件主入口，加载它会连带拉起宿主服务与 webServer，单测里就成了「为了测一个写盘函数启动整个插件」）。`runCw` / `commit` / `normalizeIndexLinks` / `verifyCommit` 全部可由调用方注入；生产路径由 `lib/engine/native-run.js` 注入自己真实的实现，测试注入桩。

但「可注入」不等于「默认什么都不做」：默认必须自带一个同语义的提交器 `commitWikiArtifacts`（`apply-plan.js:256-301`），否则阶段 3 自己跑起来产物只落盘不入库，而报告看起来仍是 done——那正是「自动提交失败被改写成成功」的前身。它的安全边界逐条对齐 `autoCommitWiki`（只 add wiki 两个路径 / 不 amend 不 push / 合并冲突与无 HEAD 一律拒绝），差别只在实现大小（直接提交，不建主题分支；分支合并式留给阶段 4 注入的 `autoCommitWiki`，见 `index.js:4994` 段落注释）。

## Key Components

本模块全部公开导出集中在 `lib/engine/apply-plan.js` 末尾的 `export default`（`apply-plan.js:865-876`）。以下按「常量 → 纯函数 → 内部助手 → 主入口」列出。

### 常量（导出）

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `APPLY_VERSION` | `apply-plan.js:43` | `number`（=1） | 落地结果 `version` 字段，JSON 可序列化标记。 |
| `APPLY_WRITE_ROOTS` | `apply-plan.js:46` | `string[]`（冻结） | 写集白名单：`['.codewiki', 'CodeWiki.md']`，来自 `mapping.js` 的 `WIKI_DIR` 与 `WIKI_ENTRY`。测试断言见 `test-engine-apply-plan.mjs:143-145`。 |
| `APPLY_STAGES` | `apply-plan.js:49` | `string[]`（冻结） | 落地阶段顺序：`['write', 'index', 'baseline', 'commit']`；顺序即推进顺序，面板步骤条与日志按它对齐。测试见 `test-engine-apply-plan.mjs:139-141`。 |
| `APPLY_PROBLEM_KINDS` | `apply-plan.js:52-59` | `string[]`（冻结） | 写集校验的问题类别（机读，仅追加）：`empty-target` / `absolute-target` / `escaping-target` / `out-of-scope` / `duplicate-target` / `bad-content`。 |
| `APPLY_RESULT_KINDS` | `apply-plan.js:62-73` | `string[]`（冻结） | 落地结果问题类别：`write-failed` / `index-failed` / `baseline-failed` / `commit-failed` / `commit-scope` / `not-writable` / `wiki-missing` / `gate-partial`。前三个直接对应契约 `BLOCKER_KINDS`。 |

### 导出函数

#### `checkWriteTargets(items)` — 写集校验（纯函数，不碰磁盘）
- 行号：`apply-plan.js:86-131`
- 入参：`items: Array<{path:string, content?:string}>`（渲染结果 + 入口 + 附加状态）。
- 出参：`{ok:boolean, targets:Array<{rel:string, content:string}>, problems:Array}`。
- 语义：逐条规范化并校验写集，规则与拒绝原因：
  - 空路径 → `empty-target`（`apply-plan.js:93-96`）
  - 绝对路径 / 盘符（`/^[a-zA-Z]:/`）/ 以 `/` 开头 → `absolute-target`（`apply-plan.js:97-100`）
  - `..` 上跳（含 `/../`、`../`、等于 `..`）→ `escaping-target`（`apply-plan.js:101-105`）
  - 不在 `APPLY_WRITE_ROOTS` 白名单内（`.codewiki/` 子树或仓库根 `CodeWiki.md`）→ `out-of-scope`（`apply-plan.js:106-114`）。注意 `.codewikix` 前缀不会被当成 `.codewiki` 子路径（测试 `test-engine-apply-plan.mjs:211-215`）。
  - `content` 不是字符串 → `bad-content`（`apply-plan.js:115-118`）
  - 同一 `rel` 内容相同 → 去重（无害，不算问题）；内容不同 → `duplicate-target`（`apply-plan.js:119-126`）
- 设计要点：不「逐条跳过坏路径」。一份残缺的写集落盘后报告会显得「大部分成功」，而缺的那几篇没人知道——比整批拒写危险得多（注释 `apply-plan.js:78-82`）。

#### `verifyCommitScope(repoRoot, sha, {allowExtra, files})` — 校验提交只动了 wiki 产物
- 行号：`apply-plan.js:230-243`
- 语义：`git show --name-only --pretty=format:` 反查实际提交内容，把「命令带了 pathspec」变成「提交里真的只有这两个路径」的可断言事实（安全边界注释 `apply-plan.js:218-224`）。`files` 可直接传入已取到的清单（省一次 git）；`allowExtra` 里的路径不算越界。
- 出参：`{ok:boolean, files:string[], unexpected:string[], reason?:string}`。有越界路径时 `ok=false` 并给出 `reason`。

#### `commitWikiArtifacts(cwd, {jobId, writtenCount})` — 阶段 3 自带小提交器
- 行号：`apply-plan.js:256-301`
- 安全边界逐条照抄 `autoCommitWiki`（注释 `apply-plan.js:245-254`）：只对磁盘上存在的 wiki 路径操作；要求 git 仓库、有 HEAD、不在 merge/rebase/cherry-pick 中、目标路径无未解决冲突；`.codewiki/` 被 `.gitignore` 忽略时报拒绝；无未提交改动返回 `noChanges`；未配置 `user.name/user.email` 报拒绝；用 `--no-verify` 不跑钩子；pathspec 形式限定在 wiki 两个路径内。
- 出参：`{committed:boolean, sha?, message?, noChanges?, reason?, files?}`。
- 早退分支：路径全不存在 → `{committed:false, noChanges:true, reason}`（`apply-plan.js:262-264`）。

#### `toApplyBlockers(problems)` — 落地问题 → 契约 `BLOCKER_KINDS`
- 行号：`apply-plan.js:315-326`
- 通过 `TO_CONTRACT_KIND` 映射表（`apply-plan.js:304-313`）把 `APPLY_RESULT_KINDS` 翻成契约词表（`write-failed/index-failed/baseline-failed/commit-failed/commit-scope/not-writable/wiki-missing/gate-partial` → 对应 kind）。若映射结果不在 `BLOCKER_KINDS` 枚举里会抛错（契约测试会枚举全表，写错的 kind 会让面板与终态判定同时失明，`apply-plan.js:318-319`）。原子类别保留在 `detail` 前缀 `[kind]` 里（机读靠前缀，人读靠 detail）。

#### `applyNativeOutput(opts)` — 主入口（阶段 3 落地器）
- 行号：`apply-plan.js:495-863`
- 完整签名与字段见下方「`applyNativeOutput` 选项与返回」小节。它是本模块唯一的异步入口，编排写盘 → index → 基线 → 提交四步，并通过 `done()`（`apply-plan.js:536-546`）合成 `ApplyResult`。

### 内部助手（非导出，仅模块内）

| 函数 | 行号 | 用途 |
| --- | --- | --- |
| `toPosix(p)` | `apply-plan.js:75` | 把 `\` 规范成 `/`。 |
| `capturePre(repoRoot, rels)` | `apply-plan.js:138-153` | 拍 pre-image 快照（每文件中是否存在 + 内容），回滚对象。 |
| `restorePre(snapshot)` | `apply-plan.js:155-176` | 逆序恢复 pre-image：存在的文件原样写回，不存在的（本次新建）删掉；返回 `{restored, failed}`。 |
| `writeAll(repoRoot, targets)` | `apply-plan.js:178-193` | 真正写盘；内容与磁盘逐字节相同的项不重写（避免 mtime 抖动与假提交）；返回 `{written, unchanged}`。 |
| `defaultRunCw(binary, cwd, args, timeoutMs)` | `apply-plan.js:197-207` | 默认 cw 通道：同步 `spawnSync`，返回 `{exitCode, stdout, stderr, timedOut}`。 |
| `defaultVerifyCommit(repoRoot, sha)` | `apply-plan.js:209-216` | 默认 `git show --name-only` 取提交文件清单。 |
| `findArticlesMissingFromIndex(repoRoot, written)` | `apply-plan.js:344-365` | 找出「已写盘但没进 `_index.md`」的文章，消灭「缺页静默成功」（cw index 对 frontmatter 解析失败的文章静默 `continue` 但 exit 0，见注释 `apply-plan.js:328-339`）。比对按路径（相对 `.codewiki/` 去掉 `.md`），跳过 `_` 开头的文件。 |
| `listFilesUnder(repoRoot, relRoot)` | `apply-plan.js:368-383` | 递归列出目录下所有文件（相对仓库根的 POSIX 路径）。 |
| `collectPruneTargets(repoRoot, pruneRoots, keepRels)` | `apply-plan.js:398-412` | 受管状态目录裁剪清单：白名单内、本次写集里没有的文件都是过期状态，下一轮水合会把它原样搬回 docs，所以必须删。 |
| `pruneEmptyDirs(repoRoot, relRoot)` | `apply-plan.js:416-430` | 删掉因裁剪变空的目录（自底向上）。 |
| `normalizeIndexLinksIn(repoRoot)` | `apply-plan.js:447-461` | 把 `_index.md` 里 `[[link|title]]` 链接头的 `\` 规范成 `/`（Windows 上 cw 会写出反斜杠，见注释 `apply-plan.js:432-442`）。与 `index.js` 版本唯一差别：ENOENT 返回 false，其余读写错误**抛出**（落地器不能把「索引坏到读不出」当成「不需要规范化」）。 |
| `entryBody(text)` | `apply-plan.js:466-469` | 剥掉产物可能自带的 frontmatter，只留正文（仓库级入口不参与 cw 索引，保留 frontmatter 是噪音）。 |

### `applyNativeOutput` 选项（入参 `opts`）

定义在 `apply-plan.js:494-508` 的 JSDoc 中，逐字段：

- `repoRoot: string` — 仓库根（绝对路径）。
- `report: object` — `gateNativeOutput` 的返回值（必须含 `rendered`、`entry`、`writable`、`outcome`、`canAdvanceBaseline`）。
- `docsDir: string` — 引擎产出的 docs 目录（读入口页正文用）。
- `wikiPath?: string` — 默认 `<repoRoot>/.codewiki`。
- `advanceBaseline?: boolean` — 覆盖 `report.canAdvanceBaseline`（测试/预览用）。
- `entryMode?: 'keep'|'overwrite'|'skip'`（默认 `'keep'`）— 仓库根已有入口时的处置。
- `dryRun?: boolean`（默认 `false`）— 只算写集与判定，不写盘、不跑 cw、不提交。
- `noChanges?: boolean` — 无变化短路：跳过写盘/索引/基线/提交（须经 `writable` 校验）。
- `extraFiles?: Array<{rel, content}>` — 附加写集（引擎原始状态：模块树/元数据/依赖图/增量凭据），相对仓库根；与文章共用同一份 pre-image、同一次回滚、同一个自动提交（注释 `apply-plan.js:481-486`）。
- `pruneRoots?: string[]` — 受管状态目录（相对仓库根）；写盘后这些根下「本次写集里没有」的文件会被删除（注释 `apply-plan.js:488-492`）。
- `beforeCommit?: function` — 提交前钩子。
- `deps?: object` — `{ runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary, gitCommitMessage, jobId, applyDeps... }`，依赖注入。

### `ApplyResult`（返回对象，由 `done()` 合成）

字段来自 `apply-plan.js:518-535` 的 `base` 与 `done()`（`apply-plan.js:536-546`），全部 JSON 可序列化：

- `version: number` — `APPLY_VERSION`。
- `startedAt` / `finishedAt: string` — ISO 时间戳。
- `repoRoot: string` — 解析后的绝对路径。
- `applied: boolean` — 写盘是否成立（与「提交成立」是两件事）。
- `outcome: 'done'|'partial'|'failed'` — 终态。
- `written: string[]` — 实际写入的 rel 列表。
- `pruned: string[]` — 裁剪掉的过期状态文件。
- `entry: {rel, action} | null` — 入口处置：`keep`/`skip`/`write`/`overwrite`。
- `index: object` — 含 `ok`、`exitCode`、`normalized`、`missing?`、`rolledBack?`。
- `baseline: object` — 含 `advanced`、`ok`、`reason?`、`exitCode?`、`stdout?`。
- `commit: object` — 提交器返回（含 `committed`、`sha`、`scope`、可能 `noChanges`）。
- `rolledBack: boolean` — 是否回滚了。
- `problems: Array` — 落地问题列表（kind 来自 `APPLY_RESULT_KINDS`）。
- `blockers: Array` — 由 `toApplyBlockers(problems)` 翻出的契约 blockers。
- `notes: string[]` — 人类可读的逐步说明。
- `canAdvanceBaseline: boolean` — `applied===true && baseline.advanced===true && problems.length===0` 时为真（`apply-plan.js:541-543`）。
- `ok: boolean` — `outcome==='done'`。

### 关键控制流（主入口）

1. 无 `repoRoot` 或 `noChanges` 短路（`apply-plan.js:548-564`）。
2. `report.writable !== true` → 一个字都不写，记 `not-writable`（`apply-plan.js:566-569`）。
3. 裁决 partial 但 `writable=true` → 照写，但记 `gate-partial`，终态不许洗成 done、基线不推进（`apply-plan.js:570-577`）。
4. 收集写集 + 入口策略（keep/overwrite/skip）+ 写集校验，整批拒写（`apply-plan.js:579-639`）。
5. `dryRun` 只报可采纳，不落盘（`apply-plan.js:634-639`）。
6. `cw init` 前置（仓库本来没 wiki，且 `.codewiki/` 存在却缺 `_meta.yaml` 则拒绝自动初始化，注释 `apply-plan.js:672-695`）。
7. 写盘 → 裁剪过期状态（`apply-plan.js:697-725`）。
8. `cw index` → 链接规范化 → 索引缺页校验，任何失败整体回滚（`apply-plan.js:727-785`）。
9. `cw meta update` 基线推进（不变量 2：失败连文章一起回滚，`apply-plan.js:787-816`）。
10. 自动提交（不变量 3：失败不回滚，只记 `commit-failed`/`commit-scope`，`apply-plan.js:818-863`）。

## Architecture

本模块把四步落地串成一次原子事务，组件 ≥3 且流程非平凡，框图如下：

```text
                 report (gateNativeOutput)
   quality-gate.js │  (writable/outcome/rendered/entry)
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  apply-plan.js :: applyNativeOutput  (orchestrator)          │
│                                                               │
│  checkWriteTargets ──整批拒写──► APPLY_WRITE_ROOTS 白名单     │
│       │ ok                                                     │
│       ▼                                                       │
│  capturePre ──► writeAll ──► pruneRoots 裁剪                  │
│       │                 (pre-image 快照)                      │
│       ▼                                                       │
│  [3b cw init]  (无 wiki 时建骨架)                             │
│       ▼                                                       │
│  runCw('index') ─► normalizeIndexLinksIn ─► findArticles...   │
│       │ 任意失败 ⇒ restorePre 整体回滚                        │
│       ▼                                                       │
│  runCw('meta update')  基线推进                               │
│       │ 失败 ⇒ restorePre 整体回滚（文章+索引一起撤）         │
│       ▼                                                       │
│  commitWikiArtifacts / deps.commit  ──失败不回滚──► 记 problem│
│       ▼                                                       │
│  verifyCommitScope ──越界 ⇒ commit-scope（不回滚）           │
└─────────────────────────────────────────────────────────────┘
                   │
                   ▼
              ApplyResult
   (ok / applied / outcome / blockers / canAdvanceBaseline)
                   │
                   ▼
        native-run.js :: runNativeJob  (合成最弱终态)
```

依赖注入边界：`runCw`、`commit`、`normalizeIndexLinks`、`verifyCommit`、`cwBinary` 全部来自 `opts.deps`（`apply-plan.js:641-646`）。未注入时默认值：`defaultRunCw`（同步 spawn）、内置 `commitWikiArtifacts`（见注释 `apply-plan.js:643-645`「不提交还能报 done 就是把产物没入库写成成功」）。`native-run.js:609-625` 在真实通道里把 `report` / `extraFiles`（受管状态）/ `pruneRoots` / `noChanges` / `advanceBaseline:null` 一并注入。

## Data Flow

1. **输入**：`gateNativeOutput` 的 `report`（`lib/engine/quality-gate.js`）+ `docsDir` + 注入的 `deps`。`report.rendered` 每项形如 `{wikiPath, content}`；`report.entry` 形如 `{source, path, ok}`；`report.writable` 必须是 `true` 才落盘。
2. **写集组装**（`apply-plan.js:580-591`）：文章（gate 已保证 `rendered` 只含无缺陷页）+ 仓库根入口（从 `docsDir` 读 `entry.source` 正文，剥 frontmatter，`apply-plan.js:592-622`）+ 引擎原始状态 `extraFiles`（模块树/元数据/依赖图/增量凭据，不是文章，不参与索引收录校验）。
3. **写集校验**（`checkWriteTargets`）：纯函数规范化 + 白名单封闭，不通过则整批拒写、统一记 `write-failed`（原子类别留在 `detail` 前缀），返回 `done({outcome:'failed'})`（`apply-plan.js:624-631`）。
4. **pre-image**（`apply-plan.js:648-670`）：`watch` 列表 = 本次写集所有 rel + 裁剪目标 + `_index.md` + `_meta.yaml`（`WIKI_META_REL`），调用 `capturePre` 拍快照。若整个 `.codewiki/` 是本次才出现的，回滚时连目录一起删（`apply-plan.js:138-144`）。
5. **写盘 + 裁剪**（`writeAll` + `collectPruneTargets`/`pruneEmptyDirs`）：先写新文件，再删「上一轮有、本轮没有」的受管状态文件——顺序反了会让下一轮水合读到「新图 + 旧文章」这种从未存在过的组合（注释 `apply-plan.js:705-716`）。
6. **索引**（`apply-plan.js:727-785`）：`runCw(cwBinary, root, ['index'])` → `normalizeIndexLinksIn`（反斜杠链接规范化）→ `findArticlesMissingFromIndex`（消灭缺页静默成功）。三步任一失败都 `restorePre` 整体回滚。
7. **基线**（`apply-plan.js:787-816`）：只有 `shouldAdvance`（优先 `advanceBaseline`，否则 `report.canAdvanceBaseline`）为真才跑 `runCw(cwBinary, root, ['meta','update'])`；失败连文章一起回滚（「文章比基线新 = 重复消费」）。
8. **提交**（`apply-plan.js:818-863`）：`doCommit`（内置 `commitWikiArtifacts` 或注入实现）→ 若 `committed` 则 `verifyCommitScope` 反查实际提交内容；越界记 `commit-scope`（不回滚，如实报）；未提交则记 `commit-failed`，**终态绝不 done**。
9. **合成**（`done()`）：`blockers = toApplyBlockers(problems)`；`outcome` 有 problems 则降 `partial`；`ok = outcome==='done'`；`canAdvanceBaseline` 仅在 `applied && baseline.advanced && problems.length===0` 时为真。所有字段齐进 `ApplyResult`。

跨轮一致性要点：受管状态（`extraFiles`）与文章共享同一 pre-image、同一回滚、同一提交（`apply-plan.js:581-590` 注释），这是「图/模块树/metadata/update_record 与文章同事务」的结构保证；`pruneRoots` 在 `noChanges` 轮必须置空（否则一次空写会把增量输入整批删掉，`native-run.js:621-623`）。

## Connections

- [[engine_quality_gate]] — 上游采用门：`gateNativeOutput` 产出 `report`，本模块只认其 `writable`/`outcome`/`rendered`/`entry` 结论，不重复 gate 的判定（注释 `apply-plan.js:565-569`）。`toApplyBlockers` 与 gate 的 `toContractBlockers`（`quality-gate.js:589-596`）共用契约 `BLOCKER_KINDS`。
- [[engine_native_run]] — 生产编排：`lib/engine/native-run.js` 的 `runNativeJob` 在 `native-run.js:109-125` 调用 `applyNativeOutput`，注入 `report`/`extraFiles`(受管状态)/`pruneRoots`/`noChanges`/`advanceBaseline:null`，并在 `native-run.js:655-686` 把 `apply.blockers` 与 gate/engine 的 blockers 合并成最弱终态。
- [[engine_contract]] — `BLOCKER_KINDS`（`contract.js:57-72`）是 `toApplyBlockers` 映射表的落点；`engineResult` 的硬不变量（done 不许带 blockers / partial 必须带 blockers）在 `native-run.js` 的 `settle` 中强制生效。
- [[engine_mapping]] — `WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`（`mapping.js:30-32`）是写集白名单与索引/基线文件位置的唯一定义来源；`APPLY_WRITE_ROOTS` 由它们冻结而成。
- [[engine_output]] — 阶段 2 的 `validateOutput` 只判「产物自身是否自洽」，本模块落地的 `report` 来自其下游 gate，二者的判定不重叠。
- [[index.js 主入口]] — 阶段 4 注入 `autoCommitWiki`（分支合并式提交）替换内置 `commitWikiArtifacts`（注释 `apply-plan.js:27-34` 指向 `index.js:4994`），并把 `WIKI_PATHS = ['.codewiki/', 'CodeWiki.md']`（`quality-gate.js:156`）作为两处共用的唯一定义。

## Known Issues

- **提交失败不回滚是刻意设计，不是漏回滚**：不变量 3（`apply-plan.js:20-22`）明确「自动提交失败时文章本身是好的、有用的」，因此 `commit-failed`/`commit-scope` 只进 `problems` 并终态降 `partial`，磁盘不动。阅读者若误以为这是 bug，请回到 `apply-plan.js:818-843` 与测试 `test-engine-apply-plan.mjs:357-401`。
- **「索引缺页静默成功」是 cw 上游行为，本模块靠比对兜底**：`cw index` 退出码 0 不代表文章被收录（`vendor/codewiki/src/main.rs:236-256` 对 frontmatter 解析失败的文章静默 `continue`，注释 `apply-plan.js:328-339`）。因此本模块额外跑 `findArticlesMissingFromIndex`（`apply-plan.js:344-365`）比对 `_index.md` 链接，缺失即整体回滚。
- **`.codewiki/` 先存在却缺 `_meta.yaml` 会拒绝自动初始化**：注释 `apply-plan.js:672-695` 与 `native-run.js:269-275` 解释——这是人工破坏的半截状态，不猜、不手写配置。但由此带来的副作用是「首次落锁不能早于 `cw init`」：`native-run.js` 把引擎锁写入推迟到落地器跑完之后（`native-run.js:696-711`）。
- **未注入提交通道时仍走内置提交器，非 git 仓库会如实拒绝**：`apply-plan.js:643-645` 强调默认自带 `commitWikiArtifacts` 而非「没注入就不提交」，否则未入库却能报 done。测试 `test-engine-apply-plan.mjs:575-585` 与 `:571-582` 覆盖「未注入 + 非 git 仓库 → partial」。
- **`normalizeIndexLinksIn` 与 `index.js` 版本的语义差别需警惕**：`apply-plan.js:447-449` 指出本模块刻意不 import `index.js` 的同名函数（避免单测拉起宿主服务），唯一差别是 ENOENT 返回 false、其余读写错误**抛出**——落地器不能把「索引坏到读不出」当成「不需要规范化」然后判成功。
- **`pruneRoots` 在无变化轮必须置空**：否则一次空写会按「写集里没有它们」把上一轮的图/树/文章副本整批删掉，清空增量输入。约束在 `native-run.js:621-623`，由调用方（阶段 4）保证，本模块本身不区分轮次类型。
