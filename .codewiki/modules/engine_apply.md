---
title: engine_apply
type: module
source_files:
  - lib/engine/apply-plan.js
  - lib/engine/contract.js
  - lib/engine/mapping.js
  - lib/engine/git-paths.js
  - lib/article-contract.js
  - lib/engine/native-run.js
  - lib/engine/quality-gate.js
  - lib/index.js
  - test-engine-apply-plan.mjs
tags: [engine, apply, native, commit, rollback, wiki]
---

## Overview

`engine_apply` 是 FSoft 原生引擎通道（阶段 3）的**落地器**：把质量门 `gateNativeOutput` 给出的采用裁决（report）真正落到仓库里——写盘（write）→ 建索引（`cw index`）→ 推进基线（`cw meta update`）→ 自动提交（commit），并在每一步失败时按三条硬不变量回滚。

源码位于 `lib/engine/apply-plan.js`（1022 行）。它是 `lib/engine/native-run.js` 中 `runNativeJob` 编排链的最后一步，也是「产物真正进仓库」的地方（文件头注释 apply-plan.js:1-34）。

### 三条硬不变量（本模块唯一的验收标准）

定义在文件头 apply-plan.js:10-22：

1. **写集封闭**（不变量 1，apply-plan.js:12-15）：只允许写 `.codewiki/`（来自 `WIKI_DIR`）与仓库根的 `CodeWiki.md`（来自 `WIKI_ENTRY`）。渲染结果的路径由引擎 page 名映射而来，绝不能盲信——绝对路径、盘符、`..` 上跳、白名单外路径一律**整批拒写**（不是跳过单条）。写集不完整时部分写入等于制造没人理会的半成品。
2. **索引/基线失败即回滚**（不变量 2，apply-plan.js:16-19）：文章写盘后 `cw index` 或 `cw meta update` 失败，磁盘必须回到应用前（旧文章原样写回、新建文件删掉、`_index.md`/`_meta.yaml` 恢复 pre-image），否则脏库永远不会自愈。
3. **提交失败不回滚**（不变量 3，apply-plan.js:20-22）：自动提交是入库最后一步，失败时文章本身是好的、有用的，所以只记 `commit-failed` 阻塞并如实返回，绝不删掉有价值的文章。

### 依赖注入而非 import

本模块**不 import `index.js`**（那里是插件主入口，加载会连带拉起宿主服务与 webServer，单测变「为测一个写盘函数启动整个插件」）。`runCw` / `commit` / `normalizeIndexLinks` 全部可由调用方注入（apply-plan.js:24-27）。默认自带同语义的内置提交器 `commitWikiArtifacts`（apply-plan.js:282-330），其安全边界逐条对齐 `index.js` 的 `autoCommitWiki`（apply-plan.js 文件头注释标注为 index.js:4801，分支合并式），差别只在实现大小（直接提交、不建主题分支；apply-plan.js:28-34）。阶段 4 由 `index.js` 注入自己的 `runCw` 与 `autoCommitWiki`。

## Key Components

文件 `lib/engine/apply-plan.js` 全部公开导出（行号以 read_code 返回前缀为准）：

### 常量

- `APPLY_VERSION` = `1`（apply-plan.js:44）—— 落地结果版本标记。
- `APPLY_WRITE_ROOTS`（apply-plan.js:47）：写集白名单，冻结为 `[WIKI_DIR, WIKI_ENTRY]` = `['.codewiki', 'CodeWiki.md']`。`checkWriteTargets`（apply-plan.js:126）、`checkDeleteTargets`（apply-plan.js:465）、`collectPruneTargets`（apply-plan.js:511）共用同一把尺子。
- `APPLY_STAGES`（apply-plan.js:50）：落地阶段顺序 `['write', 'index', 'baseline', 'commit']`，即推进顺序（面板步骤条与日志对齐）。
- `APPLY_PROBLEM_KINDS`（apply-plan.js:53-60）：写集校验的问题类别——`empty-target`、`absolute-target`、`escaping-target`、`out-of-scope`、`duplicate-target`、`bad-content`。
- `APPLY_RESULT_KINDS`（apply-plan.js:63-74）：落地结果问题类别——`write-failed`、`index-failed`、`baseline-failed`、`commit-failed`、`commit-scope`、`not-writable`、`wiki-missing`、`gate-partial`。`done()`（apply-plan.js:651）与 `pushProblem`（apply-plan.js:627）都强制问题类别必须登记在此枚举内，否则抛错。

### 函数

- `checkWriteTargets(items)`（apply-plan.js:126-154）——纯函数、不碰磁盘。逐条校验写集：规范化 `./` 前缀与反斜杠（toPosix，apply-plan.js:166）、拒绝空路径/绝对路径/盘符/上跳/白名单外，校验 `content` 为字符串（`bad-content`），对同路径同内容去重（无害），同路径异内容记 `duplicate-target`。返回 `{ ok, targets, problems }`。设计上**整批拒写**而非逐条跳过（apply-plan.js:117-124 注释）。
- `capturePre(repoRoot, rels)`（apply-plan.js:161-176）——拍 pre-image 快照：对每个 rel 记录 `exists` 与 `content`（读不到按不存在处理，apply-plan.js:170-171）。回滚对象不仅含本次写的文件，还含 `cw index` 重写的 `_index.md` 与 `cw meta update` 重写的 `_meta.yaml`（apply-plan.js:166-167）。
- `restorePre(snapshot)`（apply-plan.js:178-199）——逆序恢复 pre-image：存在的文件原样写回、不存在的文件（本次新建）删除；返回 `{ restored, failed }`。逆序语义更接近「撤销事务」（apply-plan.js:182）。
- `writeAll(repoRoot, targets)`（apply-plan.js:201-216）——写盘；内容与磁盘逐字节相同的项跳过重写（`unchanged`），避免无变化一轮产生 mtime 抖动与假提交（apply-plan.js:209-210）。返回 `{ written, unchanged }`。
- `defaultRunCw(binary, cwd, args, timeoutMs=120000)`（apply-plan.js:220-230）——默认 cw 通道：同步 `spawnSync`，返回 `{ exitCode, stdout, stderr, timedOut }`。阶段 4 注入的 `index.js` 的 `runCw`（index.js:175）是异步版，签名一致。
- `defaultVerifyCommit(repoRoot, sha)`（apply-plan.js:232-242）——反查 `git show --name-only` 取实际提交内容；用 `withQuotepathOff` + `decodeGitPaths` 双重处理（见 lib/git-paths.js），否则中文页名会被八进制转义误判越界（apply-plan.js:233-235）。
- `verifyCommitScope(repoRoot, sha, { allowExtra, files })`（apply-plan.js:256-269）——校验一次提交**只**动了 wiki 产物：把提交里实际文件与 `APPLY_WRITE_ROOTS ∪ allowExtra` 比对，列出 `unexpected`。`files` 可直接传入省一次 git（apply-plan.js:257）。这是「自动提交安全边界」从命令行 pathspec 变成可断言事实的关键（apply-plan.js:260-265）。
- `commitWikiArtifacts(cwd, { jobId, writtenCount })`（apply-plan.js:282-330）——内置提交器，**逐条照抄** `autoCommitWiki` 的安全边界：确认是 git 仓库（apply-plan.js:295）、有 HEAD（apply-plan.js:296）、无 MERGE/REBASE/CHERRY_PICK 进行中（apply-plan.js:298-300）、无未解决冲突（apply-plan.js:301）、`.codewiki/` 不被 `.gitignore` 忽略（apply-plan.js:303-306）、有未提交改动（apply-plan.js:307-309）、配置了 user.name/email（apply-plan.js:310-312）。最后 `git add -- <paths>` + `git commit --no-verify`（apply-plan.js:316-325，不跑仓库钩子）。返回含 `sha`、`files`、`message` 的对象。
- `toApplyBlockers(problems)`（apply-plan.js:344-355）——把落地问题翻成契约 `BLOCKER_KINDS`（通过 `TO_CONTRACT_KIND` 映射表 apply-plan.js:333-342）。kind 必须落在 `contract.js` 的 `BLOCKER_KINDS` 内，否则抛错（apply-plan.js:348）。
- `findArticlesMissingFromIndex(repoRoot, written)`（apply-plan.js:373-394）——找出「已写盘但没进 `_index.md`」的文章。`cw index` 退出 0 但 frontmatter 解析失败时 `main.rs` 会静默 `continue`（vendor/codewiki/src/main.rs:236-256），导致缺页静默成功；这里按路径比对索引链接（apply-plan.js:357-367）。跳过 `_` 开头的文件（apply-plan.js:379）。
- `listFilesUnder(repoRoot, relRoot)`（apply-plan.js:397-412）——递归列出目录下全部文件（相对仓库根的 POSIX 路径），目录不存在返回 `[]`。供 `findOrphanPages`、`collectPruneTargets`、`pruneEmptyDirs` 复用。
- `findOrphanPages({ repoRoot, keepPages, modulesDir })`（apply-plan.js:435-456）——扫描存量模块页，找出 `source_files` **非空且每一个都已在仓库失效**的孤儿页（apply-plan.js:414-434）。判据保守：空 `source_files`（whole-repository 无归属证据）跳过（apply-plan.js:425-427、450-451）；只要还有一个文件存在就不是孤儿；frontmatter 缺失/坏掉的页不动（可能是人工页）。`keepPages` 中的本轮产物页不算孤儿（apply-plan.js:438-442）。
- `checkDeleteTargets(rels, { repoRoot })`（apply-plan.js:465-496）——删除目标白名单校验（与写集同尺子，但不要求 `content` 为字符串，语义是「删」）。额外禁止把**目录**当删除目标（apply-plan.js:166-178，删目录语义必须由调用方显式列文件，否则回滚粒度丢失）。删除比写入更危险，故单独做一遍（apply-plan.js:458-464）。
- `collectPruneTargets(repoRoot, pruneRoots, keepRels)`（apply-plan.js:511-525）——受管状态目录裁剪清单：白名单内、本次写集里没有的文件都是过期状态（apply-plan.js:498-505）。安全边界：裁剪根必须落在写集白名单内，否则会删用户源码（apply-plan.js:516-518）。
- `pruneEmptyDirs(repoRoot, relRoot)`（apply-plan.js:529-543）——删掉因裁剪变空的目录（自底向上）；目录不进 pre-image（restorePre 按文件路径重建父目录）。
- `normalizeIndexLinksIn(repoRoot)`（apply-plan.js:560-574）——把 `_index.md` 链接头里的 `\` 规范成 `/`（Windows 上 cw 可能写出反斜杠链接，apply-plan.js:545-556）。与 index.js 的 `normalizeIndexLinks`（index.js:293）同语义，唯一差别在错误处置：本模块 ENOENT 当「没有索引可规范化」返回 false，其余读写错误**抛出**（apply-plan.js:553-567）。
- `entryBody(text)`（apply-plan.js:579-582）——剥掉产物入口可能自带的 frontmatter，取 body（`CodeWiki.md` 不参与 cw 索引，留 frontmatter 只是噪音，apply-plan.js:576-578）。
- `applyNativeOutput({ repoRoot, report, docsDir, wikiPath, advanceBaseline, entryMode, dryRun, noChanges, extraFiles, pruneRoots, deleteFiles, beforeCommit, deps })`（apply-plan.js:608-1009）——**主入口**，见下。

### 主入口 `applyNativeOutput` 的结构（apply-plan.js:608-1009）

- 入参（apply-plan.js:584-622）：`repoRoot`（绝对路径）、`report`（`gateNativeOutput` 返回值）、`docsDir`（读入口页正文）、`wikiPath`、`advanceBaseline`、`entryMode`（默认 `'keep'`）、`dryRun`、`noChanges`、`extraFiles`（引擎原始状态：模块树/元数据/依赖图/增量凭据，与文章同事务，apply-plan.js:595-604）、`pruneRoots`（受管状态目录，apply-plan.js:601-604）、`deleteFiles`、`beforeCommit`、`deps`（注入 `{ runCw, commit, normalizeIndexLinks, verifyCommit, cwBinary, gitCommitMessage }`，apply-plan.js:600）。
- 内部 `base` 结果骨架（apply-plan.js:632-650）：含 `version`、`startedAt`、`applied`、`outcome`、`written`、`pruned`、`deleted`、`entry`、`index`、`baseline`、`commit`、`rolledBack`、`problems`、`blockers`、`notes`、`canAdvanceBaseline`。
- `done()`（apply-plan.js:651-661）：合并补 `blockers`（toApplyBlockers）、`outcome==='done'` 但有 blockers 降级成 `partial`（apply-plan.js:654）、`ok`/`canAdvanceBaseline`（仅当 `applied && baseline.advanced && 无 problems`，apply-plan.js:656-658）与 `finishedAt`。
- 推进顺序（apply-plan.js:663-1008）：
  1. 无 repoRoot / `noChanges` 短路（apply-plan.js:663-679）/ `report.writable !== true` 一个字都不写（apply-plan.js:681-684）/ gate partial 但 writable=true 照写但记 `gate-partial` 且不洗成 done（apply-plan.js:689-692）。
  2. 收集写集：rendered 文章（apply-plan.js:126）+ extraFiles 状态文件（apply-plan.js:699-706）+ 入口页（apply-plan.js:707-737，缺入口直接 failed）。`checkWriteTargets` 不通过则整批拒（apply-plan.js:739-746）。`dryRun` 只算写集与判定不落盘（apply-plan.js:749-754）。
  3. 注入 `runCw`/`commit`/`verifyCommit`，拍 pre-image（apply-plan.js:756-799，含 `rollback`：失败则恢复 pre-image、整 `.codewiki/` 是本次新建则连目录删掉，apply-plan.js:793-799）。`wiki-missing` 分支：`.codewiki/` 存在却缺 `_meta.yaml` 拒绝自动初始化；不存在则先 `cw init`（apply-plan.js:806-824）。
  4. 写盘 `writeAll`（apply-plan.js:832），随后裁剪过期状态 `pruneTargets`（apply-plan.js:838-845）、删孤儿页 `deleteTargets`（apply-plan.js:847-854）、收空目录 `pruneEmptyDirs`（apply-plan.js:855-860）。写盘失败整体回滚（apply-plan.js:861-866）。
  5. `cw index`（apply-plan.js:560）→ 索引链接规范化 `normalizeIndexLinksIn`（apply-plan.js:373）→ 缺页校验 `findArticlesMissingFromIndex`（apply-plan.js:917-930）。这三步任一失败都整体回滚并记 `index-failed`（apply-plan.js:880-930）。
  6. 基线 `cw meta update`（apply-plan.js:945-958），仅当 `canAdvanceBaseline===true` 才推进；失败连文章一起回滚记 `baseline-failed`（apply-plan.js:949-958）。
  7. 自动提交 `doCommit`（apply-plan.js:967-988），失败不回滚记 `commit-failed`、混进 wiki 外路径记 `commit-scope`（apply-plan.js:976-979）。兜底：未提交且非 noChanges 绝不允许 done（apply-plan.js:990-995）。终态 `outcome = problems.length===0 ? 'done' : 'partial'`（apply-plan.js:996）。

返回结构（apply-plan.js:997-1009）含 `applied`、`outcome`、`written`、`unchangedFiles`、`pruned`、`deleted`、`entry`、`index`、`baseline`、`commit`，每个子结果都带 `ok`/`advanced`/`committed` 等现场字段，供 `native-run.js` 的 `settle`（native-run.js:145）与面板消费。

## Architecture

`applyNativeOutput` 内部是一条「写集封闭 → 原子写盘 → 索引/基线/提交，失败回滚」的直线。下图标注各组件所在文件与类，箭头标注推进与回滚关系（≤20 行）。

```text
  gateNativeOutput(report)            ┌─ apply-plan.js ───────────────────────┐
  quality-gate.js                     │                                       │
        │ report.writable / outcome   │  applyNativeOutput (入口, :608)        │
        ▼                             │     │                                 │
  ┌───────────────────┐               │  1. checkWriteTargets (:126) 写集封闭 │
  │ collected/rendered│──────────────▶│     │ 整批拒写?─▶ failed 退出          │
  └───────────────────┘               │     ▼                                 │
                                       │  2. capturePre (:161) 拍 pre-image    │
  extraFiles ─(受管状态)──┐            │     │  (文章+_index+_meta+裁剪+删除)   │
  deleteFiles─(孤儿页)──┤            │     ▼                                 │
  pruneRoots ─(裁剪)────┼─▶ watch ──▶│  3. writeAll (:201) 写盘             │
                       └────────────│     ├─ pruneTargets 过期状态删除        │
                                    │     ├─ deleteTargets 孤儿页删除         │
                                    │     ▼                                 │
                                    │  4. cw init? (:814) wiki 缺失先建骨架  │
                                    │     ▼                                 │
                                    │  5. cw index (:875) → normalize (:896) │
                                    │     └─ 缺页/失败 ─▶ rollback (:793)    │
                                    │     ▼                                 │
                                    │  6. cw meta update (:945) 基线         │
                                    │     └─ 失败 ─▶ rollback 连文章撤回     │
                                    │     ▼                                 │
                                    │  7. commitWikiArtifacts (:282) 提交    │
                                    │     └─ 失败不回滚, 记 commit-failed    │
                                    │     ▼                                 │
                                    │  done() → {applied,outcome,index,...}  │
                                    └───────────────────────────────────────┘
                                            │ 返回 ApplyResult
                                            ▼
                                    runNativeJob / settle  (native-run.js:113/:144)
```

组件与文件/行号对照：
- 入口 `applyNativeOutput`：apply-plan.js:608。
- 写集封闭 `checkWriteTargets`：apply-plan.js:126；删除校验 `checkDeleteTargets`：apply-plan.js:465；裁剪清单 `collectPruneTargets`：apply-plan.js:511。
- 原子写盘 `writeAll`：apply-plan.js:201；pre-image `capturePre`/`restorePre`：apply-plan.js:178/178；回滚函数 `rollback`：apply-plan.js:793。
- 索引 `defaultRunCw`：apply-plan.js:220；链接规范化 `normalizeIndexLinksIn`：apply-plan.js:560；缺页检测 `findArticlesMissingFromIndex`：apply-plan.js:373。
- 提交 `commitWikiArtifacts`：apply-plan.js:282；提交反查 `verifyCommitScope`：apply-plan.js:256。
- 孤儿页探测 `findOrphanPages`：apply-plan.js:435；入口正文剥头 `entryBody`：apply-plan.js:579。

## Data Flow

一次落地的事务边界如下（数据一律相对仓库根 POSIX 路径）：

1. **输入**：`report`（`gateNativeOutput` 返回值，quality-gate.js:397），含 `rendered`（仅无缺陷文章，含 `wikiPath`+`content`）、`entry`（入口 source 与 ok）、`outcome`/`writable`/`canAdvanceBaseline`。外加 `extraFiles`（受管状态：`nativeState.captureDocsDir` 产物，native-run.js:640）、`deleteFiles`（孤儿页 rel，`findOrphanPages` 结果，native-run.js:681-693）、`pruneRoots`（受管状态目录 `stateDir/docs`，native-run.js:769）。
2. **写集生成**：`rendered` 每篇 → `{ path: r.wikiPath, content: r.content }`（apply-plan.js:696）；`extraFiles` 每项 → `{ path: f.rel, content: f.content }`（apply-plan.js:699-706）；入口由 `docsDir` 读 `entry.source` 正文、剥头后入集（apply-plan.js:707-737）。
3. **校验**：`checkWriteTargets`（apply-plan.js:739）整批拒写；`checkDeleteTargets`（apply-plan.js:772）整批拒删。
4. **pre-image**：`watch` = 写集 + 裁剪目标 + 删除目标 + `_index.md` + `_meta.yaml`（apply-plan.js:781-788），`capturePre` 记录 each rel 的 `exists`/`content`。
5. **同事务推进**：写盘 `writeAll` → 删裁剪/孤儿 → `cw index` → 链接规范化 → 缺页校验 →（若可推进）`cw meta update` → `doCommit`。`extraFiles`、孤儿页删除、状态裁剪与文章**共享同一份 pre-image、同一次回滚、同一个提交**（apply-plan.js:595-604、766-788）——这正是「原始图/模块树/metadata/update_record 与文章同事务」的结构保证。
6. **提交反查**：`doCommit` 成功后 `verifyCommit`（注入）或 `verifyCommitScope`（apply-plan.js:973-974）反查实际提交文件，越界则记 `commit-scope`（apply-plan.js:761-764）。
7. **输出**：`ApplyResult`（`base` 骨架 apply-plan.js:632-650，最终由 `done()` apply-plan.js:651 补全）。含 `applied`、`outcome`(`done`/`partial`/`failed`)、`written`/`pruned`/`deleted`/`unchangedFiles`、`entry`、`index`(`ok`/`normalized`/`missing`)、`baseline`(`advanced`)、`commit`(`committed`/`scope`/`sha`)、`rolledBack`、`problems`、`blockers`(已转契约 kind)、`notes`、`canAdvanceBaseline`。

**回滚语义对照表**：

| 失败发生在 | 处置 | 行号 |
|---|---|---|
| `checkWriteTargets` 不通过 | 整批拒写，不跑 cw，记 `write-failed` | apply-plan.js:739-746 |
| 写盘失败 | 回滚（恢复 pre-image + 删新建 `.codewiki/`） | apply-plan.js:861-866 |
| `cw index` 失败 | 回滚，记 `index-failed` | apply-plan.js:880-889 |
| 链接规范化失败 | 回滚，记 `index-failed` | apply-plan.js:899-908 |
| 缺页（index 退出 0 但没收录） | 回滚，记 `index-failed` + `missing` | apply-plan.js:917-930 |
| `cw meta update` 失败 | 回滚（连文章撤回）记 `baseline-failed` | apply-plan.js:949-958 |
| 自动提交失败 | **不回滚**，记 `commit-failed`，终态 `partial` | apply-plan.js:985-988 |
| 提交混进 wiki 外路径 | **不回滚**，记 `commit-scope`，终态 `partial` | apply-plan.js:976-979 |

## Connections

- [[engine_native_run]]：`runNativeJob`（native-run.js:114）是上游编排器，在阶段 4 调用 `applyNativeOutput`（native-run.js:52-70），把 `extraFiles`/`deleteFiles`/`pruneRoots`/`noChanges`/`advanceBaseline=null` 全部喂进来；其 `settle`（native-run.js:145）消费 `ApplyResult` 合成严格终态（最弱一环说了算，native-run.js:760、711）。
- [[engine_quality_gate]]：`gateNativeOutput`（quality-gate.js:397）产出 `report` 是本模块唯一输入；`toContractBlockers`（quality-gate.js:597）与 `applyBlockersOf`（native-run.js:91）把门/落地 blocker 翻成同一套 `contract.js` 的 `BLOCKER_KINDS`。
- [[engine_contract]]：`BLOCKER_KINDS`（contract.js:57-72）是 `toApplyBlockers` 映射表（apply-plan.js:344-355）的目标枚举；`TERMINAL_OUTCOMES`/`RANK` 语义与 `engineResult`（contract.js:116）的硬不变量在 native-run.js `settle` 处对齐。
- [[engine_mapping]]：`WIKI_DIR`/`WIKI_ENTRY`/`WIKI_META_REL`（mapping.js:31-33）定义写集白名单 `APPLY_WRITE_ROOTS`（apply-plan.js:47）；`mapFsoftOutput`（mapping.js:114）的映射结果经 gate 渲染后落入本模块写集。
- [[git-paths]]：`withQuotepathOff` + `decodeGitPaths`（git-paths.js:23、75）被 `verifyCommitScope`/`defaultVerifyCommit`（apply-plan.js:232、220、256）用来正确处理中文（非 ASCII）路径，避免八进制转义误判越界（apply-plan.js:256-269、973-979）。
- [[article-contract]]：`parseFrontmatter`（article-contract.js:77）被 `entryBody`（apply-plan.js:579）与 `findOrphanPages`（apply-plan.js:435）复用，剥 frontmatter、读 `source_files`。
- [[engine_native_state]]：`collectPruneTargets` 的 `pruneRoots` 来自 `nativeState.NATIVE_STATE_DIR`（native-run.js:300、720），受管状态目录的裁剪保证「状态目录 == 上一轮引擎最终产物」（apply-plan.js:511-525）。
- `index.js`：宿主主入口；其 `runCw`（index.js:175，异步）与「分支合并式」`autoCommitWiki`（apply-plan.js 文件头注释标注为 index.js:4801）在阶段 4 注入；本模块刻意不 import 它（apply-plan.js:24-27），`normalizeIndexLinks`（index.js:293）同语义回退实现见 apply-plan.js:560。

## Known Issues

- **半截库不自动初始化**（apply-plan.js:806-824）：`.codewiki/` 存在却缺 `_meta.yaml` 时，落地器判 `wiki-missing` 并拒绝自动初始化（人工破坏的半截状态不猜、不手写配置、不搬目录），要求用户先 `cw init` 或删目录重来。这与首次编译（`.codewiki/` 不存在）自动 `cw init` 不同——native-run.js 注释（native-run.js:280-284）特意要求不能在 doctor 阶段写 `engine-lock.json`，否则会让 `.codewiki/` 早于 `cw init` 存在从而触发该分支。
- **`dryRun` 不落盘但 `applied=false`**（apply-plan.js:749-754）：预览的 `outcome` 只表示「裁决可采纳」而非「已交付」，调用方必须同时看 `applied===false` 与 `dryRun===true`（apply-plan.js:751-753 注释），勿把预览当完成。
- **缺入口即整批拒（连文章都不写）**（apply-plan.js:734-737）：产物没有 `overview`（即 `CodeWiki.md` 入口）时返回 `not-writable` 失败，已校验合法的模块页也不会写——目的是「拒绝生成只有文章的 wiki」（与 gate 的 `entry-missing` 一致，见 quality-gate.js:439-441）。
- **提交失败只记 `commit-failed` 不回滚**（不变量 3，apply-plan.js:20-22、985-988）：文章、索引、基线都已生效时，提交失败产物仍留在磁盘（终态 `partial`），依赖「未提交」分支（native-run.js:711、985-988）的后续提交，不会因提交失败丢失有价值的文章。
- **中文/非 ASCII 路径是真实仓库常态**（apply-plan.js:232-269、test-engine-apply-plan.mjs:746-759）：`verifyCommitScope` 必须关 `quotepath` 并解码，否则 `git show --name-only` 的八进制转义会让合法中文产物被误判 `commit-scope` 拉成 `partial`；纯 ASCII 测试数据永远碰不到这条。
- **`findArticlesMissingFromIndex` 依赖 cw 的链接格式**（apply-plan.js:373-394）：按「相对 `.codewiki/` 去 `.md`」比对，与 title 无关；若上游 cw 改了索引链接写法，比对口径需同步调整。
- **`collectPruneTargets` 只在非 idleRound 走**（native-run.js:720）：无变化轮（`idleRound`）若裁剪会按「写集里没有它们」把上一轮状态整批删除，等于清空增量输入；因此 native-run.js 对 idleRound 传空 `pruneRoots`。
