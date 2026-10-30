---
title: engine_state
type: module
source_files:
  - lib/engine/native-state.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
  - test-engine-native-incremental.mjs
  - vendor/codewiki/src/main.rs
tags: [native-engine, incremental, state-management, persistence]
---

## Overview

`engine_state` 是阶段 5（统一增量）的**跨轮受管状态层**，代码集中在 `lib/engine/native-state.js`。它的职责是管理 FSoft 原生引擎做组件级增量（rung 3）时所硬依赖的那批文档在「轮与轮之间」的持久化、水合（hydrate）、采集（capture）与凭据（state.json）管理，从而让第二轮起的增量不是「假装增量、实际每轮全量」。

为什么必须有一层：FSoft 的组件级增量读的是上一轮留下的四样东西才能算出「改了什么」——`module_tree.json`、`temp/dependency_graphs/<repo>_dependency_graph.json`、`metadata.json`、上一轮的文章。这些文件都落在引擎自己的 docs 输出目录里，而那个目录是临时目录（每轮一个新 job id），轮与轮之间本来什么都不留。不持久化它们，第二轮的 `_update_options()` 必然返回 None，增量退化成全量（详见文件头注释 `lib/engine/native-state.js:1-41`）。

状态目录必须是 `.codewiki/_native-state`（`NATIVE_STATE_DIR`，`lib/engine/native-state.js:48`），首段以 `_` 开头——因为 `cw index`（vendor/codewiki/src/main.rs:236-256）递归整个 `.codewiki/`，只跳过仓库相对路径以 `_` 开头的项。若放在 `temp/` 前缀下，持久化的原始文章会被 cw index 收成第二份文章，同一页在索引里出现两条链接（见 `lib/engine/native-state.js:20-28`）。`.codewiki/_native-state/` 与落地器的「索引必须收录本次写的 .md」校验共享同样的 `seg.startsWith('_')` 过滤（`lib/engine/apply-plan.js:379`）。

三条不变量（文件头 `lib/engine/native-state.js:30-40`）：

1. 只有「完整成功」才允许把本轮采集到的状态写成下一轮基线（consume）；partial/failed/cancelled 一律不推进。
2. 状态不完整（缺图 / 缺 module_tree / 版本不符 / 基线不可达）→ 显式 full，并在 state.json 留下 `fallbackReason`；绝不假装 clean。
3. 水合是**复制**而不是移动：源状态目录在仓库里（受 git 管理），docsDir 在临时目录（引擎写盘目标），任一侧写坏都不影响另一侧。

状态文件与文章走**同一个** pre-image、同一次回滚、同一个自动提交（`lib/engine/apply-plan.js` 的 `extraFiles`），因此「图/模块树/metadata/update_record 与文章同事务」是结构保证而非约定。

## Key Components

本模块是纯函数/常量集合（`lib/engine/native-state.js`），无 class，全部以具名导出 + `default` 对象（`lib/engine/native-state.js:568-589`）导出。以下是全部公开成员：

### 常量

- `NATIVE_STATE_VERSION`（`lib/engine/native-state.js:46`）——受管状态 schema 版本，当前固定为 `1`。`readState` 会用它校验磁盘上的 `state.json`，版本不符即退全量。
- `NATIVE_STATE_DIR`（`lib/engine/native-state.js:48`）——受管状态目录，相对仓库根：`'.codewiki/_native-state'`。首段 `_` 是给 cw index 的跳过标记。
- `NATIVE_STATE_FILE`（`lib/engine/native-state.js:49`）——状态凭据文件名：`'state.json'`。
- `STATE_REQUIRED_DOCS`（`lib/engine/native-state.js:53`）——引擎增量硬依赖、缺任何一个就退全量的顶层文档白名单：`Object.freeze(['module_tree.json', 'metadata.json'])`。来自实测 `.probe-fsoft/wiki_out_1c/docs`。
- `STATE_TEMP_FILES`（`lib/engine/native-state.js:57-60`）——需跨轮保留的 `temp/` 内白名单文件：`temp/reference_index.json`、`temp/artifact_index.json`。
- `STATE_TEMP_DIRS`（`lib/engine/native-state.js:61`）——需跨轮保留的 `temp/` 内目录白名单：`temp/dependency_graphs`。

### 内部工具

- `posix` 是 `toPosix` 的导入别名（`lib/engine/native-state.js:44`，来自 `../git-paths.js`）——把任意分隔符统一成 `/`。
- `absOf(root, rel)`（`lib/engine/native-state.js:63`）——拼出相对 `root` 的绝对路径。
- `listFiles(dir)`（`lib/engine/native-state.js:306-320`）——递归收集目录下相对 POSIX 文件路径，目录不存在返回 `[]`，结果排序。被 `hydrateDocsDir` / `captureDocsDir` 复用。

### 公开函数

- `archiveDocsTree({docsDir, destDir})`（`lib/engine/native-state.js:88-132`）——把引擎产出的整棵原始 docs 树完整复制到仓库外独立目录留档（事实来源）。返回 `{ok, dir, files, bytes, error?}`，拷不动不影响编译。
- `graphFileName(repoRoot)`（`lib/engine/native-state.js:146-150`）——按当前仓库名生成依赖图文件名 `<sanitize(仓库名)>_dependency_graph.json`。必须用 `\p{L}`/`\p{N}` 而非 `[A-Za-z0-9]`（对齐 Python `sanitize_repo_name` 的 `c.isalnum()`，是 Unicode 字母数字，中文/日文字符原样保留）——否则中文仓库名的图会被判成缺失，每轮白退全量。
- `stateDocsDir(stateDir)`（`lib/engine/native-state.js:153-155`）——返回 `<stateDir>/docs`，即状态目录里保存的 docs 副本根。
- `isStateDocPath(rel)`（`lib/engine/native-state.js:170-179`）——判断一份 docs 文件要不要进受管状态。判据是「是不是下一轮增量需要的输入」：所有 `.md`、顶层 `.json`（`module_tree`/`first_module_tree`/`metadata`/`update_record`）、`temp/` 下白名单（`reference_index`/`artifact_index`/`dependency_graphs`）、其他子目录里的文件；排除 `temp/` 其余中间件。注意 `temp/` 子路径优先于通用尾部 `return true`，所以未列入白名单的 temp 中间件被排除。
- `stateDocFiles(stateDir = NATIVE_STATE_DIR)`（`lib/engine/native-state.js:187-192`）——返回受管状态文件的仓库相对路径清单（`{rel, docRel}`），供审计与「哪些路径属于受管状态」的判据。当前只列 `STATE_REQUIRED_DOCS` 与 `STATE_TEMP_DIRS`（不含 `STATE_TEMP_FILES`）。
- `readState(stateDir, repoRoot)`（`lib/engine/native-state.js:204-231`）——读并校验 `state.json`。返回 `{ok, code, state, reason}`：
  - `ENOENT` → `{ok:false, code:'absent', reason:'还没有持久化状态（首次增量）'}`（`lib/engine/native-state.js:210`）
  - JSON 解析失败 → `code:'corrupt'`（`lib/engine/native-state.js:217`）
  - 不是对象/是数组 → `code:'corrupt'`，reason `'state.json 不是对象'`（`lib/engine/native-state.js:220`）
  - `stateVersion` 不等于 `NATIVE_STATE_VERSION` → `code:'version'`（`lib/engine/native-state.js:222-229`）
  - 否则 `{ok:true, code:'ok', state:parsed, reason:''}`（`lib/engine/native-state.js:230`）
- `readStateText(stateDir, repoRoot)`（`lib/engine/native-state.js:234-240`）——读 `state.json` 原始文本，用于「内容未变就不重写」的字节比较；读不到返回 `null`。
- `isUpdateEligible({stateDir, repoRoot, baseCommit, engineVersion, headCommit})`（`lib/engine/native-state.js:256-303`）——判断能不能走真实增量。返回 `{eligible, reason, state, missing}`。依次检查四类不可增量的事实（任一不成立都说出来，进 fallbackReason，避免「悄悄退全量」）：
  1. `STATE_REQUIRED_DOCS` 缺 → `missing` 收集 + 退全量（`lib/engine/native-state.js:264-266`）
  2. 当前仓库名的依赖图不存在 → `missing` 收集（`lib/engine/native-state.js:268-269`）
  3. 引擎版本变了（记录值≠入参值）→ 退全量（`lib/engine/native-state.js:280-288`）
  4. 记录的 `consumedRange.baseCommit` 与本次 cw 基线不同 → **不报错**，返回 `eligible:true` + 说明（cw 基线可能被别的任务前移，未消费变化仍会并入）（`lib/engine/native-state.js:294-301`）
- `hydrateDocsDir({stateDir, repoRoot, docsDir})`（`lib/engine/native-state.js:334-352`）——把受管状态**复制**进引擎 docs 目录（跑引擎之前）。返回 `{hydrated, skipped}`。复制而非移动：源在仓库受 git 管理，目标是临时目录。源不存在直接返回空。
- `captureDocsDir({docsDir, stateDir})`（`lib/engine/native-state.js:369-402`）——把引擎 docs 目录里的状态**采集**成「下一轮原始状态」写集。返回 `{files, captured, missing}`，`files` 为 `{rel, content}`（`rel` 相对仓库根），可直接交给落地器当 `extraFiles`。非 utf8 文本（含 `U+FFFD`）直接跳过并记进 `missing`（`lib/engine/native-state.js:385-389`）；硬依赖缺失单独报（`lib/engine/native-state.js:394-396`）。
- `buildStatePayload({...})`（`lib/engine/native-state.js:421-475`）——组装 state.json 内容（下一轮凭据）。返回对象完整字段见下。关键设计：本文件**不记录本轮结局**，只记录「本轮开始时的已消费范围」与「本轮看见了哪些变化」，因为本轮结局（基线是否推进）的权威在 `.codewiki/_meta.yaml`，state.json 要在 apply 之前就落盘（与文章同一份 pre-image）（`lib/engine/native-state.js:407-416`）。
- `stateFileItem(payload, stateDir)`（`lib/engine/native-state.js:478-483`）——把 state.json 内容作为一条写集项返回（`rel: '<stateDir>/state.json'`，带 `2` 空格缩进 + 末尾换行）。
- `stateFingerprint(text)`（`lib/engine/native-state.js:494-504`）——state.json 的「实质内容」指纹（去掉 `updatedAt` 与 `notes`）。用于「实质内容没变就不重写」，避免无变化一轮也产生真实提交。解析失败退回原文。
- `mergeUnconsumed({changeSet, prevUnconsumed})`（`lib/engine/native-state.js:524-566`）——跨轮「未消化变化」合并（纯函数）。返回 `{unconsumed, consumedNow, effectiveChanges, carried}`。详见 [Data Flow](#data-flow)。

### `buildStatePayload` 返回对象全部字段

| 字段 | 类型 | 说明 | 行号 |
| --- | --- | --- | --- |
| `stateVersion` | number | 固定 `NATIVE_STATE_VERSION` | `lib/engine/native-state.js:441` |
| `repoRoot` | string | 仓库根 | `lib/engine/native-state.js:442` |
| `consumedRange` | object\|null | `{baseCommit, headCommit}`：本轮开始时已消化到哪儿（副本，供审计与基线不一致诊断） | `lib/engine/native-state.js:445-448` |
| `pendingChanges` | object\|null | 本轮引擎真正看见的四路变化：`{state, baseCommit, headCommit, committed[], staged[], unstaged[], untracked[], deleted[], renamed[], reason}`；数组截断（`committed`≤2000、`staged/unstaged/...`≤500、`renamed`≤500、`reason`≤1000） | `lib/engine/native-state.js:450-462` |
| `unconsumed` | string[] | 已读进产物、还没进任何 commit 的路径；下一轮无条件并入变化集，直到真出现在 `git diff base..HEAD` 才移出（≤2000） | `lib/engine/native-state.js:465` |
| `engineVersion` | string | 引擎版本（与状态里记录的比较） | `lib/engine/native-state.js:466` |
| `scope` | string | 本轮请求的 scope | `lib/engine/native-state.js:468` |
| `effectiveScope` | string | 实际生效的 scope（显式记下 full 回退） | `lib/engine/native-state.js:469` |
| `updateOutcome` | string\|null | 引擎自报的 update 结局 | `lib/engine/native-state.js:470` |
| `fallbackReason` | string | 降级原因 | `lib/engine/native-state.js:471` |
| `notes` | string[] | 取最近 20 条 | `lib/engine/native-state.js:472` |
| `updatedAt` | string | ISO 时间戳（`at ?? new Date().toISOString()`） | `lib/engine/native-state.js:473` |

### `default` 导出

`lib/engine/native-state.js:568-589` 把上面 20 个具名符号全部重导出为一个对象：`NATIVE_STATE_VERSION, NATIVE_STATE_DIR, NATIVE_STATE_FILE, STATE_REQUIRED_DOCS, STATE_TEMP_FILES, STATE_TEMP_DIRS, graphFileName, stateDocsDir, stateDocFiles, isStateDocPath, archiveDocsTree, readState, readStateText, isUpdateEligible, hydrateDocsDir, captureDocsDir, buildStatePayload, stateFileItem, stateFingerprint, mergeUnconsumed`。

## Architecture

本模块是「状态在仓库里 ↔ 引擎临时 docs 目录」之间的桥。它在 native-run.js 的增量决议段（1.5）被调用：读旧状态、判增量资格、水合，引擎跑完后在 3.5 段采集新状态、组装 payload、交给落地器当 `extraFiles`。整条链的所有写操作都落在 `apply-plan.js` 的同一事务里（写盘→index→基线→提交→回滚）。

```text
           仓库（受 git 管理，权威）                        临时目录（每轮新 job）
  ┌──────────────────────────────────┐          ┌────────────────────────────────┐
  │ .codewiki/_native-state/          │          │ docsDir (引擎写盘目标)          │
  │   state.json      ◄─ readState ──┐│          │   module_tree.json              │
  │   docs/                          ││          │   metadata.json                 │
  │     module_tree.json             ││          │   temp/dependency_graphs/*      │
  │     metadata.json                ││          │   modules/*.md (文章副本)        │
  │     temp/dependency_graphs/*     ││          │   update_record.json            │
  │     modules/*.md                 ││          └────────────────────────────────┘
  └──────────────────────────────────┘                    │        ▲
            ▲        │                                     │        │
            │        │ copy (hydrateDocsDir, 非移动)        │        │ captureDocsDir
            │        ▼                                     ▼        │ (采集成写集)
   readState / isUpdateEligible                engine run (generate|update)
   mergeUnconsumed (跨轮携带)                            │        │
            │                                          │        │
            │   buildStatePayload → stateFileItem      │        │
            │         (state.json 写集项)               │        │
            └──────────► apply-plan.js extraFiles ──────┘
                              │
                              ▼
                  写盘 → cw index → 基线 → 提交
                  (失败则整批回滚：状态与文章同 pre-image)
```

组件关系要点：

- `native-state.js`（纯函数）◄ `native-run.js`（`lib/engine/native-run.js:55` 的 `import * as nativeState`）。所有调用点集中在增量决议段 `lib/engine/native-run.js:294-390` 与状态采集段 `lib/engine/native-run.js:568-643`。
- 状态写集（`stateFiles`）作为 `extraFiles` 传入 `applyNativeOutput`（`lib/engine/native-run.js:704-722`），在 `apply-plan.js` 与文章一起进写集循环（`lib/engine/apply-plan.js:699-706`）——状态文件不是文章，因此**跳过** `findArticlesMissingFromIndex` 那条 `.md` 必须进索引的校验（`lib/engine/apply-plan.js:373`）。
- 过期状态裁剪：`native-run.js` 传 `pruneRoots: [<stateDir>/docs]`（`lib/engine/native-run.js:720`），`apply-plan.js` 的 `collectPruneTargets`（`lib/engine/apply-plan.js:511-525`）删掉「上一轮有、本轮写集没有」的状态文件，维持「状态目录 == 上一轮引擎最终产物」的等价关系。

## Data Flow

一次原生编译（stale 增量）的跨轮状态流转如下：

1. **读旧状态**（`native-run.js:313-315`）：`readState(stateDir, root)` 读上一轮 `state.json`，取 `prevState.state.unconsumed` 为 `prevUnconsumed`；`mergeUnconsumed({changeSet, prevUnconsumed})` 算本轮合并结果。
2. **判增量资格**（`native-run.js:330-343`）：`isUpdateEligible` 检查缺图/缺树/版本/基线，可增则 `resolution='update'`，否则 `fallbackReason` 记下原因 → 显式 full。
3. **水合**（`native-run.js:349-363`）：`resolution='update'` 时 `hydrateDocsDir` 把 `_native-state/docs` 复制进本轮 `docsDir`。水合不到任何文件 → 退全量。
4. **引擎跑**（`native-run.js:426-457`）：update 动作带 `updateOptions.rung='3'`，引擎读 docsDir 里的旧图/旧树做图 diff 并原地 patch 文章。
5. **采集新状态**（`native-run.js:568-643`）：gate 之后、apply 之前，`captureDocsDir` 把 docsDir 里 `isStateDocPath` 命中的文件采成写集；`buildStatePayload` 组装新凭据（含本轮 `pendingChanges`、`unconsumed=merged.unconsumed`）；`stateFileItem` 生成 `state.json` 写集项；`stateFingerprint` 比对旧文本，实质没变就沿用旧文本（不动 `updatedAt`，避免无变化轮产生提交）。
6. **同事务落地**（`native-run.js:704-722`）：`stateFiles` 作为 `extraFiles` 进 `applyNativeOutput`；`pruneRoots: [<stateDir>/docs]` 触发过期状态裁剪。index/基线失败 → 状态随文章一起回滚；提交 → 状态随文章进同一 commit。

### `mergeUnconsumed` 的未消化变化账（消灭「第二类丢变化」）

这是本阶段要消灭的核心隐患（`lib/engine/native-state.js:506-517`）：FSoft 的组件级增量读的是**工作区实际文件**构建的新图，未提交的改动确实会被引擎看见并写进文章；但 cw 基线（`_meta.yaml:last_compiled_commit`）推进的是 HEAD。于是「文章已覆盖未提交改动、基线却停在 HEAD」——下一轮 change-set 从新 HEAD 算起，那些未提交改动就再也算不进变化集，文章与源码脱节却一路绿到底。

`mergeUnconsumed`（`lib/engine/native-state.js:524-566`）的解法：

- `staged`/`unstaged`/`untracked` 一律算「本轮还没进 commit」→ 进 `pendingNow`（`lib/engine/native-state.js:534-537`）。
- `committed` 里本轮被看见的路径（含 `from`，针对 rename）算「已进 commit」→ 进 `committedNow`（`lib/engine/native-state.js:541-545`）。
- 上一轮携带的 `prevUnconsumed`：只有这一轮出现在 `committedNow` 里才算被提交消化掉，移入 `consumedNow`；其余继续携带（`lib/engine/native-state.js:546-553`）。
- `unconsumed = [...stillUnconsumed, ...pendingNow]` 去重排序（`lib/engine/native-state.js:554`）。
- `effectiveChanges = 本轮四路 ∪ 上一轮携带` 去重排序，引擎与门都按它判断「消化了什么」（`lib/engine/native-state.js:556-559`）。

条目既可能是字符串路径，也可能是 `{path, from}` 对象（`lib/engine/native-state.js:529-530`），`pathOf`/`fromOf` 统一抽取。`stillUnconsumed.length` 即返回的 `carried`，由 `inc.carried` 带出结果（`lib/engine/native-run.js:385`）。

### 无变化轮短路

`native-run.js:583-586` 定义 `idleRound = resolution==='update' && updateOutcome==='no_change' && effectiveChanges 为空 && unconsumed 为空`。三种情况同时成立才短路：不采集状态、不重写 `state.json`、不裁状态目录（裁剪会按「写集里没有它们」把上一轮图/树/文章整批删掉，清空增量输入）、`noChanges:true` 让 apply 跳过写盘/index/基线/提交（`lib/engine/apply-plan.js:667-679`）。只要还有一项未消化的账（哪怕未提交源码改动），本轮必须照常采集。

## Connections

- [[engine_native_run]]（`lib/engine/native-run.js`）——唯一的调用方：增量决议（1.5 段）读/判/水合旧状态，状态采集（3.5 段）采/组/写新状态，全部经此模块桥接。
- [[engine_apply_plan]]（`lib/engine/apply-plan.js`）——落地器。`extraFiles` 把受管状态与文章同批写/回滚/提交（`lib/engine/apply-plan.js:699-706`）；`pruneRoots` 裁剪过期状态（`lib/engine/apply-plan.js:511-525`）；`findArticlesMissingFromIndex` 的 `_` 前缀跳过与本模块的 `_native-state` 命名约定同源（`lib/engine/apply-plan.js:373`）。
- [[engine_contract]]（`lib/engine/contract.js`）——`EngineResult` 的硬不变量：state.json 不记录本轮结局，是因为结局权威在 `_meta.yaml`，且 state.json 要在 apply 前落盘，避免第二个提交（`lib/engine/native-state.js:407-416`）。
- [[engine_quality_gate]]（`lib/engine/quality-gate.js`）——状态采集发生在 gate 之后（`native-run.js:546` 起），gate 说 partial 则基线不推进，未消费变化下一轮继续携带。
- [[change_set]]（`lib/engine/change-set.js`）——四路变化的来源。`mergeUnconsumed` 直接消费其 `committed/staged/unstaged/untracked/deleted/renamed`。
- [[engine_client]]（`lib/engine/client.js`）——`update`/`generate` 动作的协议层；`updateOptions.rung='3'` 由 native-run 传入（`lib/engine/native-run.js:426-441`）。
- [[engine_manifest]]（`lib/engine/manifest.js`）——`engineVersion` 由 doctor 探测结果提供，写入 state.json 并与下一轮比较（`lib/engine/native-state.js:280-288`、`lib/engine/native-run.js:623`）。
- [[engine_python_entry]]（`lib/engine/python/entry.py`）——引擎侧 `artifacts.stateFiles` 与 `captureDocsDir` 采集结果交叉核对（`lib/engine/native-run.js:640-645`）。

## Known Issues

- **中文/Unicode 仓库名依赖图必须用 `\p{L}\p{N}` 对齐**：`graphFileName`（`lib/engine/native-state.js:146-150`）若改用 `[A-Za-z0-9]`，中文仓库名的图会被判成缺失，每轮白退全量。这是与 Python `sanitize_repo_name`（`c.isalnum()`，Unicode 字母数字）逐字符对齐的硬约束。
- **状态目录首段必须 `_` 开头**：若改为 `temp/` 前缀，cw index 会把持久化的原始文章收成第二份文章，同一页出现两条索引链接（`lib/engine/native-state.js:20-28`）。这是命名约定的硬约束，改目录名需同步改 cw index 排除逻辑与 `findArticlesMissingFromIndex` 的 `seg.startsWith('_')`（`lib/engine/apply-plan.js:379`）。
- **旧通道（nativeEngine=false）不读不写本模块**：`test-engine-native-incremental.mjs` 用例 9（`test-engine-native-incremental.mjs:488-504`，在 `lib/engine/native-run.js` 之外）确认旧通道完全不跑原生引擎、不产生 `_native-state`。`.codewiki/_native-state/` 是原生通道专属，回滚时 `git rm -r .codewiki/_native-state .codewiki/engine-lock.json` 即可干净清理（`docs/fsoft-native-engine.md:299-310`）。
- **水合是复制不是移动**：源状态目录在仓库受 git 管理，目标是临时目录。若改成移动，本轮失败会直接毁掉下一轮输入（`lib/engine/native-state.js:36-37`、`lib/engine/native-run.js:349-363` 的「水合不到任何文件即退全量」分支）。
- **无变化轮绝不能裁状态目录**：`pruneRoots` 仅 `idleRound === false` 时传 `[<stateDir>/docs]`（`lib/engine/native-run.js:769`）。若无变化轮也裁，会按「写集里没有它们」把上一轮图/树/文章副本整批删掉，清空增量输入。
- **state.json 不记录本轮结局**：这是设计选择而非缺陷——结局权威在 `.codewiki/_meta.yaml`，state.json 要在 apply 前落盘。若强行写「本轮结局」会造出第二个提交、回滚语义分叉（`lib/engine/native-state.js:524-533`）。因此「未消费凭据」必须靠 `mergeUnconsumed` 在 `unconsumed` 里滚动携带。
- **`captureDocsDir` 对二进制的处理**：非 utf8 文本（含 `U+FFFD`）直接跳过并记进 `missing`，不写坏数据（`lib/engine/native-state.js:385-389`）。当前受管状态只有 JSON/markdown，但若将来引擎产出二进制，会被静默排除——`missing` 会在结果里可见但不阻断落地。
- **`stateDocFiles` 未含 `STATE_TEMP_FILES`**：`stateDocFiles`（`lib/engine/native-state.js:187-192`）只列 `STATE_REQUIRED_DOCS` 与 `STATE_TEMP_DIRS`，不含 `temp/reference_index.json`、`temp/artifact_index.json`。若依赖此函数做完整清单，会漏掉这两个白名单文件（它们由 `isStateDocPath` 在采集时仍会被纳入）。
