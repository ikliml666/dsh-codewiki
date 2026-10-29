---
title: engine_state
type: module
source_files:
  - lib/engine/native-state.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/contract.js
  - lib/engine/output.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
  - test-engine-manifest.mjs
  - test-engine-native-incremental.mjs
  - test-engine-output.mjs
tags: [engine, state, manifest, lock, mapping, incremental, codewiki]
---

## Overview

`engine_state` 模块负责三件相邻但边界清晰的事，它们共同支撑「FSoft 原生引擎在
CodeWiki 里做**统一增量**（组件级增量）」这一能力：

1. **跨轮受管状态（native-state）**：FSoft 的组件级增量（rung 3）要读上一轮留下的
   模块树、依赖图、metadata、文章副本才能算出「改了什么」。这些产物在引擎的临时
   `docs` 目录里、每轮都会变空，所以本模块把它们**持久化进仓库内**的
   `.codewiki/_native-state/`，并在每轮之前**水合**回临时 `docs`、之后**采集**回仓库。
   见 `lib/engine/native-state.js:1` 的文件头注释，它解释了为什么必须有这一层、为什么
   状态目录必须以 `_` 开头、以及三条不变量。

2. **引擎清单与锁（manifest）**：FSoft 是外部引擎，版本/依赖不由本仓库控制。
   `manifest.js`（阶段 2）只读探测引擎版本 + Python 版本 + pip check，算出一个稳定
   fingerprint，与落盘的 `.codewiki/engine-lock.json` 比对，漂移就明确报出来。它**不**
   修环境、不联网，只做诊断。见 `lib/engine/manifest.js:1`。

3. **FSoft 产物 → CodeWiki 映射（mapping）**：这是迁移里唯一一处「格式翻译」
   （阶段 0）。`mapping.js` 把 FSoft 的 `overview.md` / 模块页 / `module_tree.json` /
   `metadata.json` / `update_record.json` 翻译成 CodeWiki 的入口页、`.codewiki/modules/*.md`、
   `_meta.yaml` 等，并守住四条硬规则（不臆造 source_files、不静默丢弃、不覆盖、不改
   技术内容）。见 `lib/engine/mapping.js:1`。

这三者被 `native-run.js`（阶段 4/5 的编译编排）串成一条裁决链：
`env(doctor+锁) → 增量决议(change-set+受管状态) → 水合 docs → 引擎(full|update) →
质量门 → 落地器(与状态同事务)`。受管状态与文章通过 `apply-plan.js` 的 `extraFiles` 进入
**同一个** pre-image / 回滚 / 提交，从而「图/模块树/metadata 与文章同事务」不是约定而是结构。

## Key Components

### lib/engine/native-state.js — 跨轮受管状态

文件 `lib/engine/native-state.js`（共 520 行）。三个常量与一组函数：

- `NATIVE_STATE_VERSION = 1`（行 45）：受管状态 schema 版本，`state.json` 比对不匹配即退全量。
- `NATIVE_STATE_DIR = '.codewiki/_native-state'`（行 47）：受管状态目录，相对仓库根，首段以 `_` 开头，使 `cw index` 跳过、不把持久化文章副本收成第二份索引（`native-state.js:20` 解释）。
- `NATIVE_STATE_FILE = 'state.json'`（行 48）：凭据文件名。
- `STATE_REQUIRED_DOCS`（行 52，`Object.freeze(['module_tree.json', 'metadata.json'])`）：引擎做组件级增量硬依赖的文档，缺任一只能退全量。
- `STATE_TEMP_FILES`（行 56，`Object.freeze(['temp/reference_index.json', 'temp/artifact_index.json'])`）：需跨轮保留的 `temp/` 文件白名单。
- `STATE_TEMP_DIRS`（行 60，`Object.freeze(['temp/dependency_graphs'])`）：需跨轮保留的 `temp/` 子目录。

公开函数（行号以 read_code 前缀为准）：

- `graphFileName(repoRoot)`（行 77–81）：按仓库名生成依赖图文件名 `<safe>_dependency_graph.json`。必须用 `\p{L}\p{N}` 而不是 `[A-Za-z0-9]`，否则中文仓库名的图会被判成缺失，每轮白退全量（注释 `native-state.js:77–72`）。
- `stateDocsDir(stateDir)`（行 84–86）：返回状态目录里的 docs 副本根 `<stateDir>/docs`。
- `isStateDocPath(rel)`（行 101–110）：判断某 docs 相对路径要不要进受管状态——所有 `.md`、顶层 `.json`、`temp/` 白名单、其他子目录都进；其余 `temp/` 中间件排除。
- `stateDocFiles(stateDir = NATIVE_STATE_DIR)`（行 118–123）：返回状态文件的仓库相对路径清单（供审计）。
- `readState(stateDir, repoRoot)`（行 135–162）：读并校验 `state.json`。反序列化边界必须检查不信任：文件缺失返回 `{ok:false, code:'absent'}`（行 141），坏 JSON 返回 `'corrupt'`（行 148），非对象返回 `'corrupt'`（行 151），版本不符返回 `{ok:false, code:'version'}`（行 154–159），否则返回 `{ok:true, code:'ok', state}`（行 161）。
- `readStateText(stateDir, repoRoot)`（行 165–171）：读 `state.json` 原始文本（用于「内容未变就不重写」的字节比较），读不到返回 `null`。
- `isUpdateEligible({...})`（行 187–234）：判断「能不能走真实增量」，每个不可增量的原因都要说出来进 `fallbackReason`。检查顺序：① 读 `state.json`（行 189–190）；② 校验 `STATE_REQUIRED_DOCS` 是否都在（行 195–197）；③ 按当前仓库名找依赖图（行 199–200）；缺失报「持久化状态缺…改走全量」；④ 引擎版本变了报 drift（行 211–219）；⑤ 基线不一致不报错、记原因返回 `eligible:true`（行 223–232）。
- `hydrateDocsDir({...})`（行 265–283）：把受管状态**复制**进引擎 docs 目录（跑引擎前）。复制而非移动：源在仓库受 git 管理，目标是临时目录。返回 `{hydrated, skipped}`。
- `captureDocsDir({...})`（行 300–333）：把引擎 docs 目录里的状态**采集**成 `{rel, content}` 写集（rel 相对仓库根），可直接交落地器当 `extraFiles`。非 utf8 文件探测到 `\uFFFD` 跳过并记 `missing`（行 317–319）；硬依赖缺失单独报（行 325–327）；缺依赖图也报（行 328–331）。
- `buildStatePayload({...})`（行 352–406）：组装 `state.json` 内容（下一轮凭据）。**不记录本轮结局**，只记录「本轮开始时的已消费范围」与「本轮看见的变化」，原因是本轮结局权威在 `.codewiki/_meta.yaml`，state.json 要在 apply 之前就落盘（注释 `native-state.js:352–347`）。返回对象含 `stateVersion / repoRoot / consumedRange / pendingChanges / unconsumed / engineVersion / scope / effectiveScope / updateOutcome / fallbackReason / notes / updatedAt`（行 371–405）。`pendingChanges` 各路路径有长度截断（`committed` ≤2000、`staged/unstaged/untracked/deleted` ≤500、`renamed` ≤500、reason ≤1000）。
- `stateFileItem(payload, stateDir = NATIVE_STATE_DIR)`（行 409–414）：把 state.json 内容包成一条写集项 `{rel, content}`（带 2 空格缩进 + 尾换行）。
- `stateFingerprint(text)`（行 425–435）：state.json 的「实质内容」指纹（去掉 `updatedAt`/`notes`）。`updatedAt` 每轮都变，若照写会让无变化轮也产生一次真实提交；只有实质内容变了才写新时间戳。解析失败退回原文。
- `mergeUnconsumed({changeSet, prevUnconsumed})`（行 455–497）：跨轮「未消化变化」合并（纯函数）。把上一轮 `unconsumed` 里「本轮已出现在 committed」的路径移出（消费成立），并合并本轮 staged/unstaged/untracked 为「未消费」。`effectiveChanges = 本轮四路 ∪ 上一轮携带`（行 488）。返回 `{unconsumed, consumedNow, effectiveChanges, carried}`。这是消灭「文章与源码脱节」第二类丢变化的核心（注释 `native-state.js:485–448`）。

默认导出（行 499–519）：汇总上述全部常量与函数。

### lib/engine/manifest.js — 引擎清单与锁

文件 `lib/engine/manifest.js`（共 197 行）。常量：

- `MANIFEST_VERSION = 1`（行 19）：清单 schema 版本。
- `ENGINE_LOCK_REL = '.codewiki/engine-lock.json'`（行 20）：落盘锁的相对路径。

公开函数（行号以 read_code 前缀为准）：

- `probeEnvironment({probe, engineRoot})`（行 34–45，async）：只读探测引擎环境事实。调用方传入 `probe`（返回 `{version, pythonVersion, pipCheck:{ok,output}}`），不在此 spawn，保持本层纯、可单测（注释 `manifest.js:34–28`）。返回 `{version, pythonVersion, pipCheckOk, pipCheckOutput, engineRoot, fingerprint}`。无 `probe` 函数直接抛错（行 35）。
- `fingerprintOf(facts)`（行 50–56）：指纹只吃**决定产物内容**的因素——引擎版本 + Python 版本（SHA256 取前 16 位）。`pipCheckOk` **不**进指纹（修依赖不算换引擎，注释 `manifest.js:50–49`）。
- `readLock({repoRoot})`（行 61–75）：读已落盘 lock。不存在/坏 JSON 都返回 `null`（不是错误，首次运行本来没有 lock）。
- `compareLock({current, lock})`（行 86–111）：比对当前指纹与 lock，返回可机读差异项（不抛错、不布尔）。`status` 取值：`'absent'`（无 lock）、`'match'`（一致）、`'drift'`（引擎/Python 版本变了）、`'unhealthy'`（指纹一致但 `pipCheckOk !== true`）。版本/Python 不一致的字段进 `diffs`（行 94–103）；`pipCheckOk` 失败优先判 `unhealthy`（行 104–106）。
- `buildLockBody(current)`（行 125–136）：构造 lock 落盘正文（不写盘）。单独拆出是因为「落锁」时机必须与产物同批：`native-run` 把这份正文当 apply 写集的一项，与文章/状态共享同一 pre-image，失败一起回滚（注释 `manifest.js:125–124`）。无 `fingerprint` 抛错（行 126）。正文含 `manifestVersion / fingerprint / version / pythonVersion / engineRoot / pipCheckOk / recordedAt`（行 127–135）。
- `writeLock({repoRoot, current})`（行 142–150）：原子写（先写 `*.tmp` 再 `renameSync`，避免半截文件）。返回写入的相对路径。无 `repoRoot` 或 `current.fingerprint` 抛错。
- `doctor({probe, repoRoot, engineRoot})`（行 156–185，async）：一次调用把「引擎在不在、环境闭不闭合、和上次比有没有漂」全判出，**不抛**（probe 抛错变成 `ok:false, status:'probe-failed'`）。返回 `{ok, status, current, diffs, advice}`，`advice` 按 `status` 给不同文案（行 171–177）。`ok` 仅在 `match`/`absent` 时为 `true`（行 179）。

默认导出（行 187–196）：汇总常量与函数。

注意：`manifest.js` 本身**不调用** `writeLock` 直接落盘——首次运行落锁推迟到 `native-run.js` 第 5 步之后（见 `native-run.js:269–275` 与 `native-run.js:699–711`），以免在 `cw init` 之前创建 `.codewiki/` 导致落地器误判半截库。

### lib/engine/mapping.js — FSoft 产物 → CodeWiki 映射

文件 `lib/engine/mapping.js`（共 269 行）。映射关系与目标类型见文件头注释（行 8–15），
四条硬规则见行 16–26。`ENGINE_CONTRACT_VERSION` 从 `lib/engine/contract.js` 引入（行 28）。

常量（行 30–34）：

- `WIKI_ENTRY = 'CodeWiki.md'`（行 30）
- `WIKI_DIR = '.codewiki'`（行 31）
- `WIKI_META_REL = '.codewiki/_meta.yaml'`（行 32）
- `WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'`（行 33）
- `WIKI_MODULES_REL = '.codewiki/modules'`（行 34）

公开函数（行号以 read_code 前缀为准）：

- `moduleSlug(name)`（行 38–44）：模块名 → cw 惯用 kebab-case 文件名（非 ASCII 折叠成 `-`，小写）。
- `mapFsoftOutput({pages, moduleTree, componentFiles, metadata, updateRecord, overviewName})`（行 115–268）：纯函数，把 FSoft docs 树映射成 cw 写集描述。**不读写文件、不 spawn**。返回对象（行 255–267）：
  - `contractVersion`：来自 `ENGINE_CONTRACT_VERSION`（行 256）。
  - `entry`：`{path: CodeWiki.md, source}` 或 `null`（行 142、258）。`overview.md` 只允许一个，重复出现（不同路径同名）后到的进 `unmapped`（行 136–143）。
  - `articles`：`[{source, wikiPath, type, pageKind, moduleName, sourceFiles, attribution, warnings}]`（行 222–231）。`type` 恒为 `'module'`；`pageKind` 为 `'artifact'`（节点 mark 为 artifact 或名匹配 `/^artifacts?$/i`）、`'parent'`（有 children）、或 `'leaf'`（行 226）。`sourceFiles` 只认组件→文件证据（见 `sourceFilesOf`，行 62–72），拿不到就是空数组 + warning，绝不猜。
  - `unmapped`：`[{source, reason}]`（行 259）—— 任何没被映射的页都进这里带可机读原因，由上层决定 partial（硬规则 2）。
  - `meta`：`{lastCompiledCommit, layout, language}`，取自 `metadata.generation_info.commit_id / layout / language`（行 260–264）。
  - `updateRecord`：`{path, outcome, pagesWritten, pagesRemoved, source}` 或 `null`（行 244–253、265）。
  - `warnings`：全局告警，如「模块树含 X 但未产出 X.md」（行 235–242、266）。

内部辅助：

- `normalizeSourceFiles(list)`（行 48–58）：去重、规整 `./` 前缀。
- `sourceFilesOf(components, componentFiles)`（行 62–72）：组件 id 形如 `src/a.py::Class.method`，取 `::` 前文件部分；`componentFiles` 里有映射就用映射，有 `::` 无映射取 `::` 前段，无 `::` 且无映射则跳过（不猜）。
- `indexModuleTree(moduleTree)`（行 76–96）：把 FSoft 模块树 `{name: {path, components, children}}` 拍平成 `Map<name, {name, path, components, hasChildren, artifact, parent}>`。
- `moduleSlug` 冲突处理（行 165–175、200–211）：两个不同名模块规范化到同一文件名时两页都不写（否则覆盖丢内容），并把先占用的页也从 `articles` 里 `splice` 出去、进 `unmapped`（硬规则 3）。
- whole-repository 模式：`module_tree.json` 为 `{}` 时页名不在树里不等于孤儿页——页仍进写集，`sourceFiles` 留空 + `attribution:'unattributed'` + warning（行 153–188，硬给 source_files 才是错）。

`mapping.js` 被 `output.js` 使用（`output.js:19` 的 `import { mapFsoftOutput }`），后者只做「读 + 映射 + 校验」，不重写任何映射规则（`output.js:5`）。

## Architecture

三份状态/映射工具被 `native-run.js` 的编译裁决链串起来，并通过 `apply-plan.js` 的
`extraFiles`/`pruneRoots` 与文章同事务落地。`manifest.js` 是 `env` 阶段的事实源；
`native-state.js` 是 `增量决议`/`水合`/`采集` 阶段的事实源；`mapping.js` 是 `output.js`
（产物解析）的事实源。

```text
            ┌──────────────────────── lib/engine/native-run.js (阶段4/5 裁决链) ────────────────────────┐
            │                                                                                              │
  repo ──►  │  env: doctor() ──► [manifest.js] probeEnvironment/fingerprintOf/compareLock/readLock       │
            │        │  (drift/unhealthy → failed, 不跑引擎)                                                 │
            │        ▼                                                                                      │
            │  增量决议: collectChangeSet + [native-state.js] readState/mergeUnconsumed/isUpdateEligible    │
            │        │  (resolution = full | update, 记 fallbackReason)                                      │
            │        ▼                                                                                      │
            │  水合: [native-state.js] hydrateDocsDir  ──copy──► 临时 docsDir                                 │
            │        │                                                                                      │
            │        ▼                                                                                      │
  docsDir ─►│  引擎 runEngine(action=generate|update) ──► outDocsDir                                          │
            │        │                                                                                      │
            │        ▼                                                                                      │
            │  质量门 gateNativeOutput（output.js→mapping.js 产物解析）                                       │
            │        │                                                                                      │
            │        ▼                                                                                      │
            │  采集: [native-state.js] captureDocsDir + buildStatePayload + stateFileItem                     │
            │        │  (idleRound 不重写；stateFingerprint 相同则沿用旧文本)                                 │
            │        ▼                                                                                      │
            │  落地: [apply-plan.js] applyNativeOutput(extraFiles=stateFiles, pruneRoots) ──同事务提交──► repo│
            └──────────────────────────────────────────────────────────────────────────────────────────────┘

  受管状态目录 .codewiki/_native-state/  (native-state.js:47)
    ├─ state.json            (buildStatePayload/stateFileItem, 行 352/409)
    └─ docs/
        ├─ module_tree.json  (STATE_REQUIRED_DOCS, 行 52)
        ├─ metadata.json
        ├─ *.md 文章副本      (isStateDocPath, 行 101)
        ├─ temp/reference_index.json / artifact_index.json   (STATE_TEMP_FILES, 行 56)
        └─ temp/dependency_graphs/*_dependency_graph.json     (STATE_TEMP_DIRS, 行 60)

  引擎锁 .codewiki/engine-lock.json        (manifest.js:20)
    └─ {manifestVersion, fingerprint, version, pythonVersion, engineRoot, pipCheckOk, recordedAt}
```

关键不变量（来自各文件头注释）：
- `native-state.js:30–37` 三条不变量：① 只有完整成功才 consume；② 状态不完整显式 full + `fallbackReason`；③ 水合是复制不是移动。
- `manifest.js:12–13`：doctor 只读诊断，不装依赖/不联网。落锁时机在 `native-run.js:699` 之后。
- `mapping.js:16–26`：不臆造 source_files、不静默丢弃、不覆盖、不改技术内容。
- `apply-plan.js:10–22` 与 `native-state.js:39–40`：状态文件与文章同 pre-image / 回滚 / 提交。

## Data Flow

一次原生编译的「状态」数据流（集中在 `native-run.js`）：

1. **env 阶段**：`doctor`（`native-run.js:220`）调 `manifest.probeEnvironment`，拿到
   `{version, pythonVersion, pipCheckOk, fingerprint}`（`native-run.js:194–216`）。
   落盘锁检查：`drift`/`unhealthy`/`probe-failed` 直接 `failed` 不跑引擎
   （`native-run.js:275–268`）；`absent` 时记 `lockNote`，推迟到落地成功后再写
   （`native-run.js:275`、`native-run.js:699–711`）。

2. **增量决议阶段**（`native-run.js:283–379`）：
   - `readCommittedBaseline` 取本轮基线 `baseCommit`（`native-run.js:293–293`）。
   - `collectChangeSet(root, baseCommit)` 收集四路变化（`native-run.js:287`）。
   - `readState` 读上一轮状态，`prevUnconsumed` 取出（`native-run.js:303–303`）。
   - `mergeUnconsumed({changeSet, prevUnconsumed})` 算出 `unconsumed`/`consumedNow`/`effectiveChanges`（`native-run.js:372`）。
   - `isUpdateEligible`（带 `baseCommit`/`engineVersion`/`headCommit`）裁决能否 update（`native-run.js:293–325`）。任意不成立 → `resolution='full'` + `fallbackReason`。
   - 决议现场 `inc`（`native-run.js:361–379`）随结果出去。

3. **水合阶段**：`resolution==='update'` 时 `hydrateDocsDir` 把 `.codewiki/_native-state/docs/` 复制进临时 `docsDir`（`native-run.js:340–352`）。空目录 → 退全量。

4. **引擎阶段**：`action = update ? 'update' : 'generate'`（`native-run.js:415`），
   update 带 `updateOptions:{rung:'3'}`（`native-run.js:66–429`，`DEFAULT_UPDATE_OPTIONS` 在行 66）。引擎自报 `updateOutcome`（incremental/no_change/full_fallback/detector_failure）存入 `inc.updateOutcome`（`native-run.js:460`）。

5. **采集阶段**（`native-run.js:528–603`，gate 之后、apply 之前）：
   - `idleRound = UPDATE && no_change && effectiveChanges 空 && unconsumed 空`（`native-run.js:543–546`）——无变化轮不重写状态（否则每次无变化都纯记账提交）。
   - 否则 `captureDocsDir` 采集、`buildStatePayload` 组装、`stateFileItem` 包成写集，`readStateText` + `stateFingerprint` 比较决定沿用旧文本（不抖动 `updatedAt`，`native-run.js:591–595`）。
   - `extraFiles = [...captureFiles, stateItem]`。

6. **落地阶段**：`applyNativeOutput({extraFiles, pruneRoots:[<stateDir>/docs]})`
   （`native-run.js:609–625`）。状态文件与文章**共用同一 pre-image**：index/基线失败一起回滚（`test-engine-native-incremental.mjs:401–402`、`429`），提交时同进一个 commit（含 `.codewiki/_native-state/` 路径，`test-engine-native-incremental.mjs:212`）。
   `pruneRoots` 在增量轮把上一轮有、本轮写集没有的状态文件删掉（防止旧页/旧图复活，`apply-plan.js:392–419`），无变化轮 `pruneRoots=[]` 不裁（`native-run.js:623`）。

跨轮「未消费变化」流转（消灭文章与源码脱节的第二类丢变化，`native-state.js:437–448`）：
- 未提交改动被引擎读到（引擎读工作区文件），但 cw 基线只推进到 HEAD。
- 这些路径记进 `state.json.unconsumed`，每轮并入 `effectiveChanges`，直到它们真的出现在 `git diff base..HEAD` 才移出（`mergeUnconsumed`，`native-state.js:455–497`）。
- 测试证据：`test-engine-native-incremental.mjs` 用例 3（四路+delete/rename）、用例 4（未提交改动两轮不丢，提交后 `consumedNow` 移出）。

## Connections

- [[engine_contract]] — `contract.js` 定义 `ENGINE_CONTRACT_VERSION`、`BLOCKER_KINDS`（含 `incremental-fallback`）、`UPDATE_OUTCOMES`；`native-run.js` 的 `settle` 用 `engineResult` 保证终态合法；`mapping.js` 的 `mapFsoftOutput` 输出带 `contractVersion`（`mapping.js:256`）。
- [[engine_output]] — `output.js` 直接 `import { mapFsoftOutput }`（`output.js:19`）做产物解析/校验，自身不重写任何映射规则（`output.js:5`）。测试见 `test-engine-output.mjs`。
- [[engine_native_run]] — `native-run.js` 是三份工具的主消费方：env 用 manifest、增量决议/水合/采集用 native-state、编排整条裁决链（`native-run.js:283–625`）。
- [[engine_apply_plan]] — `apply-plan.js` 的 `applyNativeOutput` 通过 `extraFiles`/`pruneRoots` 把受管状态与文章同事务落地（`apply-plan.js:502–499`、`native-run.js:623–624`）；`verifyCommitScope`/`commitWikiArtifacts` 保证提交只含 wiki 路径（`apply-plan.js:260`、`260`）。
- [[engine_quality_gate]] — `quality-gate.js` 的 `gateNativeOutput` 是采集前的一道闸门，产物不完整则全量重建的基线不推进（`native-run.js:49`）。
- [[change_set]] — `change-set.js` 的 `collectChangeSet` 为增量决议提供四路变化（`native-run.js:287`、`297`），其 `committed/staged/unstaged/untracked/deleted/renamed` 是 `mergeUnconsumed` 的输入。
- [[engine_python_entry]] — `entry.py`（`native-run.js:56` 的 `DEFAULT_ENGINE_ENTRY`）产出 FSoft docs 树与 `update_record.outcome`，后者经 `settle` 透出 `updateOutcome`（`native-run.js:653`、`460`）。

## Known Issues

- **无变化轮仍可能因 `stateFingerprint` 误判重写**：`stateFingerprint` 仅剥离 `updatedAt`/`notes`（`native-state.js:425–435`），若本轮 `pendingChanges`/`unconsumed` 等实质字段与上一轮不同仍会改写 state.json 并产生提交；`native-run.js:567–546` 的 `idleRound` 额外用 `effectiveChanges`/`unconsumed` 为空来兜底，二者互补而非冗余。
- **依赖图文件名对仓库名敏感**：`graphFileName` 必须用 `\p{L}\p{N}`（`native-state.js:77–81`），否则中文仓库名图判缺失 → 每轮退全量。若 FSoft 侧 `sanitize_repo_name` 算法变更，需同步此处的正则（否则 `isUpdateEligible` 在行 199–200 报缺图）。
- **首次运行落锁时机耦合 cw init**：`manifest.writeLock` 不能在 doctor 阶段调用，必须推迟到落地成功、`_meta.yaml` 存在之后（`native-run.js:269–275`、`699–711`）；若落地器早退（not-writable/回滚），当轮不写锁，下一轮成功时再落（`native-run.js:708–710`）。
- **`mergeUnconsumed` 假定 changeSet 字段形状**：staged/unstaged/untracked 一律按「未消费」处理，committed 的 `from` 字段（rename）需是 `{path, from}` 或字符串（`native-state.js:455–476`）。若 `collectChangeSet` 返回畸形条目，路径归一会静默丢路径。
- **`mapping.js` 不校验 source_files 存在性**：`mapFsoftOutput` 只按 `componentFiles` 证据填 `source_files`（`mapping.js:115–72`）；存在性检查在 `output.js` 的 `validateOutput`（`test-engine-output.mjs:166`）。只传 `docsDir` 不传 `repoRoot` 时该检查被跳过（`test-engine-output.mjs:180–189`）。
- **受管状态目录 `_` 前缀是硬依赖**：任何把 `NATIVE_STATE_DIR` 改成不以 `_` 开头的操作都会让 `cw index` 把持久化文章副本收成第二份索引（`native-state.js:47–28`），破坏 `findArticlesMissingFromIndex` 的 `seg.startsWith('_')` 过滤（`native-state.js:28` 注释、`apply-plan.js`）。
