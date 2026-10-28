---
title: apply_plan
type: module
source_files:
  - lib/engine/apply-plan.js
  - test-engine-apply-plan.mjs
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/quality-gate.js
  - lib/article-contract.js
  - index.js
tags: [engine, apply-plan, stage-3, landing, cw, baseline, auto-commit]
---

## Overview

`lib/engine/apply-plan.js` 是编译流水线的**阶段 3（落地器）**：把阶段 2 质量门（quality-gate.js）已经给出「采用裁决（report）」的原生产物，真正原子地落进仓库——写盘 → `cw index` → `cw meta update`（基线）→ 自动提交，并在任何一步失败时按不变量回滚。

它位于 `quality-gate.js` 给出采用裁决之后、产物真正进仓库之前（`apply-plan.js:450`）。文件头明确了这段独立一层的动机：0.14.0 的教训是把「写成几篇」当成「成立」，于是 1 篇成功 + 19 篇失败也报 `done`；落地器要把「声称可入库」和「真的成立了」分开。

本模块只认裁决的**结论**（`report.writable` / `report.outcome` / `report.canAdvanceBaseline`），不重复 gate 的判定。它有三条硬不变量（`apply-plan.js:715`-`22`）：

1. **写集封闭**：只允许写 `.codewiki/` 整棵子树 + 仓库根 `CodeWiki.md`（`APPLY_WRITE_ROOTS`，`apply-plan.js:46`）。绝对路径、盘符、`..` 上跳、白名单外路径一律整批拒写（不是跳过该条，是整批拒）。
2. **索引/基线失败即回滚**：文章写盘后 `cw index` 或 `cw meta update` 失败，磁盘必须回到应用前的样子（旧文章原样写回、新建文件删掉、`_index.md` 与 `_meta.yaml` 恢复 pre-image）。
3. **提交失败不回滚**：自动提交是入库最后一步，失败时文章本身是好的、有用的，只记 `commit-failed` 阻塞并如实返回，绝不删掉有价值的文章。

模块刻意**不 import `index.js`**（`apply-plan.js:532`-`27`）：`index.js` 是插件主入口，加载它会连带拉起宿主服务与 webServer，单测会变成「为了测一个写盘函数启动整个插件」。`runCw` / `commit` / `normalizeIndexLinks` 全部由调用方注入；但「可注入」不等于「默认什么都不做」——默认必须自带一个同语义内置提交器 `commitWikiArtifacts`（`apply-plan.js:250`-`34`），否则阶段 3 自跑起来只落盘不入库，而报告看起来仍是 `done`。

## Key Components

全部公开符号都从 `lib/engine/apply-plan.js` 导出（文件末尾 `export default` 块在 `apply-plan.js:727`-`738`）。

### 常量

| 符号 | 行号 | 用途 |
| --- | --- | --- |
| `APPLY_VERSION` | `apply-plan.js:43` | 落地结果结构版本，写进 `ApplyResult.version`，便于反序列化校验。 |
| `APPLY_WRITE_ROOTS` | `apply-plan.js:46` | 写集白名单，`Object.freeze([WIKI_DIR, WIKI_ENTRY])`，即 `['.codewiki', 'CodeWiki.md']`（`mapping.js:30`、`:31`）。不变量 1 的全部判据。 |
| `APPLY_STAGES` | `apply-plan.js:49` | 落地阶段顺序条：`['write', 'index', 'baseline', 'commit']`，面板步骤条与日志按它对齐。 |
| `APPLY_PROBLEM_KINDS` | `apply-plan.js:52`-`59` | 写集校验的问题类别（机读，只允许追加）：`empty-target`、`absolute-target`、`escaping-target`、`out-of-scope`、`duplicate-target`、`bad-content`。 |
| `APPLY_RESULT_KINDS` | `apply-plan.js:62`-`73` | 落地结果的问题类别：`write-failed`、`index-failed`、`baseline-failed`、`commit-failed`、`commit-scope`、`not-writable`、`wiki-missing`、`gate-partial`。前三个直接映射到契约 `BLOCKER_KINDS`。 |

### 公开函数

- **`checkWriteTargets(items)`**（`apply-plan.js:86`-`131`）— 纯函数写集校验，不碰磁盘。遍历 `items`（`{path, content}`），对每条：规范化 `./` 前缀与反斜杠（`toPosix`，`:75`）；拒空路径 → `empty-target`；拒绝对绝对路径/盘符/以 `/` 开头 → `absolute-target`；拒 `..` 上跳 → `escaping-target`；拒绝白名单外 → `out-of-scope`；拒绝非字符串 `content` → `bad-content`；同一路径内容不同 → `duplicate-target`（内容相同只去重）。返回 `{ ok, targets:[{rel, content}], problems:[{kind, detail, target}] }`。注意它**整批拒写**而非逐条跳过（`:80`-`81`）。

- **`verifyCommitScope(repoRoot, sha, { allowExtra, files })`**（`apply-plan.js:224`-`237`）— 反查一次提交是否只动了 wiki 产物。若不传 `files`，用 `defaultVerifyCommit`（`apply-plan.js:203`-`210`，内部 `git show --name-only`）取出实际改动文件，再过滤出不在 `APPLY_WRITE_ROOTS ∪ allowExtra` 内的路径为 `unexpected`。返回 `{ ok, files, unexpected, reason? }`。这是「命令带了 pathspec」与「提交真的只有这两个路径」之间的可断言事实（`:212`-`217`）。

- **`commitWikiArtifacts(cwd, { jobId, writtenCount })`**（`apply-plan.js:250`-`295`）— 阶段 3 自带的小提交器，只把 wiki 产物入库。安全边界逐条照抄 `index.js` 的 `autoCommitWiki`（`:242`-`244`）：只对磁盘存在路径 `git add -- .codewiki CodeWiki.md`；非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中、未解决冲突、被 `.gitignore` 忽略、无 user.name/email、无未提交改动一律拒绝；`--no-verify` 跳过钩子。返回 `{ committed, sha?, message?, noChanges?, reason?, files? }`。

- **`toApplyBlockers(problems)`**（`apply-plan.js:309`-`320`）— 把落地问题翻成契约 `BLOCKER_KINDS`。经 `TO_CONTRACT_KIND` 映射表（`:298`-`307`）：`write-failed`/`not-writable`/`gate-partial` → `quality-gate`，`index-failed`/`wiki-missing` → `index-failed`，`baseline-failed` → `baseline-failed`，`commit-failed`/`commit-scope` → `commit-failed`。若映射出的 kind 不在 `BLOCKER_KINDS`（`contract.js:42`-`53`）里直接抛错（契约测试会枚举全表，`:312`-`313`）。返回的 blocker 把原类别保留在 `detail` 的 `[...]` 前缀里（机读靠前缀，人读靠 detail）。

- **`applyNativeOutput({ repoRoot, report, docsDir, wikiPath, advanceBaseline, entryMode, dryRun, deps })`**（`apply-plan.js:414`-`725`）— 核心落地入口（async）。流程详见 [[#Data Flow]]。返回 `ApplyResult`，字段在下表。

### 内部函数（`applyNativeOutput` 私有支撑）

| 函数 | 行号 | 用途 |
| --- | --- | --- |
| `capturePre(repoRoot, rels)` | `apply-plan.js:138`-`153` | 拍 pre-image 快照：对本次写集 + `_index.md` + `_meta.yaml` 读出现存内容与 `exists` 标志。 |
| `restorePre(snapshot)` | `apply-plan.js:155`-`176` | 逆序恢复 pre-image：存在则原样写回，不存在（本次新建）则删除；返回 `{ restored, failed }`。 |
| `writeAll(repoRoot, targets)` | `apply-plan.js:178`-`187` | 实际写盘：逐条 `mkdirSync` + `writeFileSync`，返回已写 `rel` 列表。 |
| `defaultRunCw(binary, cwd, args, timeoutMs)` | `apply-plan.js:191`-`201` | 默认 cw 通道：同步 `spawnSync`，返回 `{ exitCode, stdout, stderr, timedOut }`。阶段 4 注入 `index.js` 的异步 `runCw` 即可（`:189`-`190`）。 |
| `findArticlesMissingFromIndex(repoRoot, written)` | `apply-plan.js:338`-`359` | 找出「已写盘但没进 `_index.md`」的文章。`cw index` 退出码只表示索引文件写成功、不表示文章被收录（main.rs 逐篇 frontmatter 解析失败就 `continue`），这里用链接比对补上「缺页静默成功」的洞。 |
| `normalizeIndexLinksIn(repoRoot)` | `apply-plan.js:376`-`390` | 把 `_index.md` 链接头的 `\` 规范成 `/`，与 `index.js:213` 同语义但本模块刻意不 import（避免拉起宿主服务）；ENOENT 返回 false，其余读写错误**抛出**。 |
| `entryBody(text)` | `apply-plan.js:395`-`398` | 剥掉产物入口页的 frontmatter，只留正文（`parseFrontmatter` 来自 `article-contract.js:77`）。 |

### `ApplyResult`（`applyNativeOutput` 返回结构）

由 `base`（`apply-plan.js:433`-`449`）经 `done()`（`apply-plan.js:450`-`460`）收尾生成，全部字段可 JSON 序列化：

| 字段 | 含义 / 来源 |
| --- | --- |
| `version` | `APPLY_VERSION`（落地结构版本）。 |
| `startedAt` / `finishedAt` | 起止 ISO 时间，由 `new Date().toISOString()` 自动生成（`:424`、`:458`）。 |
| `repoRoot` | 归一化后的仓库绝对路径（`path.resolve`，`:425`）。 |
| `applied` | 写盘是否成立（true 不代表已入库）。 |
| `outcome` | `done` / `partial` / `failed`；若 `outcome==='done'` 且仍有 blockers 则降级为 `partial`（`:453`）。 |
| `ok` | `outcome === 'done'`。 |
| `written` | 写入成功的 `rel` 列表（来自 `writeAll`）。 |
| `entry` | 入口处置信息 `{ rel: 'CodeWiki.md', action: 'keep'|'overwrite'|'skip'|'write' }` 或 `null`。 |
| `index` | `{ ok, exitCode, normalized?, missing?, rolledBack? }`。 |
| `baseline` | `{ advanced, ok?, exitCode?, reason?, stdout? }`；`advanced` 来自 `cw meta update` 是否成功。 |
| `commit` | 提交器返回（含 `committed` / `sha` / `message` / `noChanges` / `reason` / `scope`）。 |
| `rolledBack` | 是否发生了整体回滚。 |
| `problems` | 落地问题数组（kind 在 `APPLY_RESULT_KINDS` 内）。 |
| `blockers` | `toApplyBlockers(problems)` 的结果，机读供终态判定。 |
| `notes` | 人读说明（如「保留人工入口」「基线未推进」）。 |
| `canAdvanceBaseline` | 由 `applied===true && baseline.advanced===true && problems.length===0` 推导（`:455`-`457`）。 |
| `dryRun` | 预览模式标志（`:525`-`530`）。 |

## Architecture

落地器由纯函数校验层 + 有副作用的落地入口 + 注入式外部依赖（cw / git）组成。组件 ≥3 且推进流程非平凡，框图如下（组件名 / 文件或类）：

```text
              report (quality-gate 裁决)
  report.writable / outcome / canAdvanceBaseline
                     │
                     ▼
        ┌──────────────────────────┐
        │ checkWriteTargets         │ 纯函数，不碰磁盘 (apply-plan.js:86)
        │ 白名单 APPLY_WRITE_ROOTS  │ 整批拒写 / 去重
        └────────────┬─────────────┘
                     │ targets[] + problems[]
                     ▼
        ┌──────────────────────────┐
        │ applyNativeOutput         │ 落地入口 (apply-plan.js:414)
        │  deps:{runCw,commit,      │ 依赖注入：默认走内置实现
        │    normalizeIndexLinks,   │
        │    verifyCommit}          │
        │                           │
        │  writeAll ─► cw index ─►  │ 顺序：write→index→baseline→commit
        │  normIndex ─► missingChk  │ (APPLY_STAGES:49)
        │  ─► cw meta update ─►     │
        │  commitWikiArtifacts      │
        │                           │
        │  capturePre/restorePre    │ 回滚 (invariant 2)
        │  (snapshot _index/_meta)  │
        └────────────┬─────────────┘
                     │ ApplyResult
                     ▼
        ┌──────────────────────────┐
        │ toApplyBlockers           │ 问题→BLOCKER_KINDS
        │ contract.js:42            │ (apply-plan.js:309)
        └────────────┬─────────────┘
                     ▼
              panel / 终态判定共用词表

  外部依赖（注入，默认自带同语义实现）：
   runCw ──────────► cw CLI (init/index/meta update)
   commit ─────────► commitWikiArtifacts / autoCommitWiki(index.js:4655)
   verifyCommit ───► verifyCommitScope (apply-plan.js:224)
```

设计要点：

- **校验与落地分离**：`checkWriteTargets` 是纯函数（`:77`-`78`），可在不碰磁盘下被单测；`applyNativeOutput` 负责副作用与回滚编排。
- **依赖注入而非 import index.js**：`runCw` / `commit` / `normalizeIndexLinks` / `verifyCommit` 全部参数注入（`:24`-`27`、`:411`）。默认 `runCw` = `defaultRunCw`（同步 `spawnSync`），默认 `commit` = `commitWikiArtifacts`（`:536`），否则单测会被拉去启动宿主服务。
- **回滚对象含索引与基线**：`capturePre`（`apply-plan.js:138`）拍的快照不仅是本次写的文件，还有 `cw index` 会重写的 `_index.md` 与 `cw meta update` 会重写的 `_meta.yaml`——这两份才是「库是否干净」的判据（`:133`-`136`）。`rollback()`（`apply-plan.js:546`-`552`）在 `.codewiki/` 是本次才出现时连目录一起删掉，避免留下空壳。

## Data Flow

`applyNativeOutput`（`apply-plan.js:414`-`725`）的推进顺序严格对应 `APPLY_STAGES`（`:49`）。每个分支的失败处理都对齐三条硬不变量：

1. **前置判定**（`apply-plan.js:462`-`513`）
   - 无 `repoRoot` → `not-writable` + `failed`（`:462`-`464`）。
   - `report.writable !== true` → 一个字都不写，`not-writable`（`:467`-`470`）。
   - `report.outcome !== 'done'` → 记 `gate-partial` 但**照写**（writable=true 的合法状态，如能力降级/存量未重编译/部分页 skip），且终态不许洗成 `done`、基线不推进（`:475`-`478`）。
   - 收集写集：从 `report.rendered` 取文章（字段 `wikiPath` + `content`，`:482`），从 `report.entry.source` 经 `docsDir` 读入口正文（剥 frontmatter，`entryBody`，`:483`-`508`）。`entryMode` 决定仓库根已有 `CodeWiki.md` 时 `keep` / `overwrite` / `skip`（`:488`-`493`）。
   - 缺入口页（`report.entry` 为 null）→ `not-writable` + `failed`，连文章都不写（`:510`-`513`）。

2. **写集校验**（`apply-plan.js:515`-`522`）：`checkWriteTargets(items)`。不通过则把所有原子类别统一记 `write-failed`、把原子类别留在 `detail` 前缀（`[out-of-scope]` 等），整批拒写（不变量 1）。

3. **dryRun**（`apply-plan.js:715`-`530`）：只算写集与判定，`applied=false`、不写盘不跑 cw 不提交；`outcome` 只表示「裁决可采纳」，不代表已交付——调用方必须看 `applied=false && dryRun=true`。

4. **依赖解析与 pre-image**（`apply-plan.js:532`-`577`）：`runCw` / `cwBinary`（默认 `cw` 或 `DSH_CODEWIKI_CW` 环境变量，`:533`）/ `doCommit`（默认 `commitWikiArtifacts`，`:536`）/`verifyCommit`（`:537`）。`capturePre` 拍 `targets + _index.md + _meta.yaml` 快照；若 `.codewiki/` 不存在则先尝试 `cw init`（`:559`-`577`，对应 `index.js:172` 的 `cw init` 前置；有 `.codewiki` 却缺 `_meta.yaml` 属人工破坏态，拒绝并提示跑 `cw init`，`:563`）。

5. **写盘**（`apply-plan.js:178`-`589`）：`writeAll`；异常即 `rollback()` + `write-failed` + `applied:false`。

6. **cw index**（`apply-plan.js:546`-`629`）：失败 → `rollback()` + `index-failed`（不变量 2）。成功后 `normalizeIndexLinksIn` 规范化 `_index.md` 的 `\` 链接，失败同样按 `index-failed` 整体回滚（`:613`-`627`）。

7. **缺页比对**（`apply-plan.js:338`-`649`）：`findArticlesMissingFromIndex` 比对已写文章与索引内链接。`cw index` 退出码 0 但文章没进索引（frontmatter 被 serde_yaml 拒收而静默跳过）也要 `index-failed` + 回滚——消灭「缺页静默成功」。

8. **基线**（`apply-plan.js:655`-`680`）：`shouldAdvance` 由 `advanceBaseline` 覆盖参数或 `report.canAdvanceBaseline` 决定。不推进时只 `notes` 不跑 `meta update`；推进失败 → `rollback()` + `baseline-failed`（连文章一起撤，避免「文章比基线新」导致下一轮重复消费，`:651`-`654`）。

9. **自动提交**（`apply-plan.js:537`-`714`，不变量 3）：提交成功则 `verifyCommit` / `verifyCommitScope` 反查实际改动；混进 wiki 外路径 → 记 `commit-scope`（不回滚，如实报）。`noChanges`（无未提交改动）不算失败只记 note。`commit-failed` 不回滚，但终态至少 `partial`（`:684`-`707`）。兜底：已无 problems 但也没成立提交时补一条 `commit-failed`，绝不留干净 `done`（`:710`-`714`）。

10. **终态收尾**（`apply-plan.js:716`-`724`）：`outcome = problems.length === 0 ? 'done' : 'partial'`；`done()` 内若 `outcome==='done'` 且仍有 blockers 则降级为 `partial`。

## Connections

- [[quality-gate]] — 阶段 3 的上游：本模块的入参 `report` 即 `gateNativeOutput` 的返回值；`report.writable/outcome/canAdvanceBaseline/rendered/entry` 全是 gate 的结论（不变量见 `quality-gate.js:390`）。
- [[contract]] — `BLOCKER_KINDS`（`contract.js:42`-`53`）是落地问题映射到面板/终态判定的唯一词表；`toApplyBlockers` 映射表 `TO_CONTRACT_KIND`（`apply-plan.js:298`）必须落在其中，否则抛错。
- [[mapping]] — 提供 `WIKI_DIR` / `WIKI_ENTRY` / `WIKI_META_REL`（`mapping.js:32`-`32`），即 `APPLY_WRITE_ROOTS`（`apply-plan.js:46`）与 pre-image 快照路径（`_index.md`、`_meta.yaml`）的来源。
- [[article-contract]] — `parseFrontmatter`（`article-contract.js:77`）被 `entryBody` 用作剥入口 frontmatter（`:395`）；`REQUIRED_FIELDS`/`REQUIRED_SECTIONS` 等闸门由 quality-gate 复用，本模块只消费其渲染产物。
- [[output]] — 阶段 2 的 `validateOutput` 被 quality-gate 复用，本模块在其之上做「采用并落地」。
- `index.js`（`autoCommitWiki`，`index.js:4655`）— 阶段 4 注入的提交器，安全边界逐条与内置 `commitWikiArtifacts` 对齐（`apply-plan.js:250`-`244`）；`runCw`（`index.js:172`）是被注入的异步 cw 通道；`normalizeIndexLinks`（`index.js:213`）是同语义内置规范化函数的外部版。`WIKI_PATHS`（`index.js:55`）与 `APPLY_WRITE_ROOTS` 是同一组唯二 pathspec。
- 测试入口 [[test-engine-apply-plan.mjs]] — 全程用临时目录 + 注入桩，不碰真仓库、不跑真 cw（除 `verifyCommitScope` 那条用真 git）；夹具 `makeReport`/`makeDocs`/`recordingDeps`/`gitRepo` 见该文件 `:68`/`:90`/`:104`/`:601`。

## Known Issues

- **`cw index` 缺页静默成功**：`cw index`（vendor/codewiki/src/main.rs:236-256）在 frontmatter 解析失败时 `continue` 且仍退出 0，落地器必须用 `findArticlesMissingFromIndex`（`apply-plan.js:338`）比对才能发现缺页（`apply-plan.js:630`-`649`）。若 cw 行为变更（不再静默跳过）该比对可能误报；目前以「缺页即 index-failed 回滚」为正确行为。
- **`.codewiki/` 被 `.gitignore` 忽略会静默丢产物**：`commitWikiArtifacts`（`apply-plan.js:250`-`272`）会显式拒绝被忽略的路径；但 pre-image 快照与回滚不感知 ignore，仅按文件存在性恢复——若人工仓库先 ignore 了 `.codewiki/` 又手动改过，回滚逻辑按「存在则写回」处理，与 git 状态无关。
- **`entryMode` 仅作用于仓库根已存在入口**：`docsDir` 里缺入口正文（`entryBody` 剥完 frontmatter 后为空，`apply-plan.js:395`-`506`）直接 `write-failed`，不会退回「只写文章」——调用方需保证 `report.entry.source` 指向的文档可读且非空。
- **内置提交器不建主题分支**：`commitWikiArtifacts`（`:250`）直接提交，不建 `codewiki/wiki-<jobId>` 主题分支；分支合并式（`index.js:4655` `autoCommitWiki`）只在阶段 4 注入后生效——两套提交器判据必须对齐，否则出现「阶段 3 能提交、阶段 4 不能」的行为差异（`:242`-`244`）。
- **`verifyCommitScope` 默认依赖真 git**：`defaultVerifyCommit`（`:203`）内部跑 `git show --name-only`；桩测试通过注入 `files` 直接传入清单省一次 git（`:637`-`642`）。临时目录若不是 git 仓库，`verifyCommitScope` 会返回 `ok:false`（测试里用 `gitRepo()` 夹具 `:601` 构造真仓库）。
- **回滚失败不可自愈**：`restorePre`（`apply-plan.js:155`）的 `failed` 列表只进 `notes` 不阻断流程；若旧内容写回失败（如权限），磁盘会留在脏状态，调用方需在 `notes` 里看「回滚时有 N 个文件恢复失败」（`apply-plan.js:586`、`:602` 等）。

