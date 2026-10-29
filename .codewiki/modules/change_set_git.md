---
title: change_set_git
type: module
source_files:
  - lib/change-set.js
  - lib/git-paths.js
  - test-change-set.mjs
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/apply-plan.js
  - lib/engine/quality-gate.js
tags: [git, change-set, incremental-compile, path-decoding, wiki-updates]
---

## Overview

`change_set_git` 不是一个单文件，而是仓库里**负责「采集 git 变更集」+「解码 git 转义路径」**这一小撮能力的统称，由两个真实源文件组成：

- `lib/change-set.js` —— 把一次编译要「看见」的全部改动从 `committed / staged / unstaged / untracked` 四路合一成一个规范的 `ChangeSet`，并把「采不全」的情形显式暴露成 `state` + `fallback='full'`，让调用方退回全量编译，绝不假装 clean。
- `lib/git-paths.js` —— 只做一件事：铲平 git 路径输出与「真实路径」之间的两层落差（`core.quotepath=true` 的八进制字节转义、`/` 与 `..` 的越界路径），输出可被白名单/归档直接当真实 POSIX 相对路径使用的字符串。

背景缺陷（审计确认，见 `lib/change-set.js:1-13`）：旧的 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是三类改动对它完全隐形——工作区未提交修改、只 `git add` 到暂存区、新建未跟踪文件。结果「改完代码就编译」会把未消化的食物当成已消化（基线被前移），文章与源码脱节却一路绿到底。本模块是被设计来修掉这一条「变更不能丢」的。

职责边界（刻意窄）：
1. 只产出**规范化、可序列化、可 JSON 落盘**的 `ChangeSet`（`lib/change-set.js:79-99` `emptyChangeSet` 与 `lib/change-set.js:79-96` 的成功结构），以及路径解码原语；
2. 不决定「要不要增量」——那是 `lib/engine/native-run.js` 的增量决议；
3. 不做图 diff、不写文章、不碰 `.codewiki/` 落盘——那是 `lib/update-planner.js` / `lib/engine/quality-gate.js` / `lib/engine/apply-plan.js`。

依赖注入 `execFile`（`lib/change-set.js:43-50` `defaultExecFile`）是为了离线单测：真实链路用 `execFileSync`，测试给假执行器（`test-change-set.mjs:203-220`）。

## Key Components

### `lib/change-set.js`

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `CHANGE_SET_VERSION` | `lib/change-set.js:20` | `const number` | ChangeSet 结构版本号，当前恒为 `1`，写进 `version` 字段供下游/归档断言。 |
| `WIKI_PRODUCT_PREFIX` | `lib/change-set.js:25` | `const string` | 值为 `'.codewiki/'`。wiki 自身产物目录前缀，每次编译都会被重写，若算成「源码变更」会让增量永远 dirty、让「未映射变更」永远清零。 |
| `isWikiProduct(relPath)` | `lib/change-set.js:27-30` | 函数 | 判定一个相对路径是否属于 wiki 产物（`relPath === '.codewiki'` 或 `startsWith('.codewiki/')`）。`README`/`CHANGELOG`/`CodeWiki.md` 等被文章 `source_files` 引用的文档**不**在此列，仍是合法源码。 |
| `normChangePath(p)` | `lib/change-set.js:34-41` | 函数 | 路径归一：把 `\` 统一成 `/`，去掉 `./` 前缀；绝对路径（以 `/` 开头或含 `C:` 盘符）、`../` 上跳路径一律丢弃（返回 `null`）——它们不该出现在变更集里。 |
| `defaultExecFile(cwd)` | `lib/change-set.js:43-50` | 函数 | 真实 git 执行器工厂：`execFileSync('git', args, { cwd, maxBuffer: 16MB })`。可被 `opts.execFile` 覆盖（测试注入）。 |
| `parseNameStatus(out)` | `lib/change-set.js:58-77` | 函数 | 解析 `git diff --name-status` 输出。每一条路径先过 `decodeGitPath` 再 `normChangePath`。`R`/`C` 记成 `{kind:'renamed'|'copied', from, path, status}`（两列路径），`D` 记 `kind:'deleted'`，其余记 `kind:'modified'`。 |
| `emptyChangeSet(baseCommit, overrides)` | `lib/change-set.js:79-99` | 函数 | 生成一个「空/failed」ChangeSet 骨架（`ok:false, state:'unknown', fallback:null`），调用方以 `overrides` 覆盖 `state`/`reason`/`fallback`/`headCommit` 等。所有路径数组字段（committed/staged/.../all/sourceChanges/ignored）均为 `[]`。 |
| `collectChangeSet(cwd, baseCommit, opts)` | `lib/change-set.js:108-210` | 函数 | **主入口**。采集四路变更并归一成 ChangeSet。下面单独拆字段。 |

#### `collectChangeSet(cwd, baseCommit, opts)` 行为（`lib/change-set.js:108-210`）

参数：`cwd`（仓库工作目录）、`baseCommit`（上次成功编译基线，`_meta.yaml:last_compiled_commit`）、`opts.execFile`（可选注入执行器）。

返回值是一个 `ChangeSet` 对象，成功形态（`lib/change-set.js:192-209`）字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | `number` | 恒为 `CHANGE_SET_VERSION`（1）。 |
| `ok` | `boolean` | `true` 表示采集成功且基线可信；`false` 表示降级（此时必带 `state`/`reason`/`fallback='full'`）。 |
| `state` | `string` | 见下「降级 state 枚举」。成功时为 `'ok'`。 |
| `fallback` | `string|null` | 降级时为 `'full'`（调用方应退回全量编译）；成功时为 `null`。 |
| `reason` | `string` | 降级原因，成功时为空串。 |
| `baseCommit` | `string` | 传入的基线（去空格）。 |
| `headCommit` | `string` | `git rev-parse HEAD` 结果，失败/异常时缺省空串。 |
| `committed` | `Entry[]` | `base..HEAD` 已提交改动（`lib/change-set.js:157`），已剔除 wiki 产物。 |
| `staged` | `Entry[]` | `--cached HEAD` 暂存改动（`lib/change-set.js:158`），已剔 wiki 产物。 |
| `unstaged` | `Entry[]` | 工作区未提交改动（`lib/change-set.js:159`），已剔 wiki 产物。 |
| `untracked` | `string[]` | `git ls-files --others --exclude-standard` 新文件（`lib/change-set.js:160-162`），已剔 wiki 产物。 |
| `deleted` | `string[]` | 删除路径集合（`lib/change-set.js:169-186`），已剔 wiki 产物；同一路径「删了又重建同名文件」时不算删除（`lib/change-set.js:186`）。 |
| `renamed` | `RenamedEntry[]` | `{from, path, bucket}`（`lib/change-set.js:176-179`），已剔 wiki 产物。 |
| `all` | `string[]` | 四路去重后的全部路径**并集**，含改名两端（旧路径也算变化，`lib/change-set.js:177`），排序。 |
| `sourceChanges` | `string[]` | `all` 中**非** wiki 产物的部分（`lib/change-set.js:189`）。增量 planner 只认它。 |
| `ignored` | `string[]` | `all` 中属于 wiki 产物的部分（`lib/change-set.js:190`），只记账不进源码变更。 |

其中 `Entry` 形状为 `{kind:'modified'|'deleted'|'renamed'|'copied', path, status, bucket?}`（`lib/change-set.js:69-74`），`RenamedEntry` 为 `{from, path, bucket}`。

降级 `state` 枚举（均返回 `ok:false, fallback:'full'`）：

- `'missing-base'`（`lib/change-set.js:110-112`）：`baseCommit` 空，无法计算增量。
- `'no-git'`（`lib/change-set.js:124-126`）：`rev-parse HEAD` 失败且 `rev-parse --is-inside-work-tree` 非 `true`。
- `'git-error'`（`lib/change-set.js:127-131`）：git 命令报错或 `HEAD` 无输出。
- `'unreachable-base'`（`lib/change-set.js:134-143`）：`git cat-file -e <base>^{commit}` 失败，基线被 rebase/GC 掉，必须退回全量而非当 clean。

采集流程（`lib/change-set.js:145-191`）：开 `-M` 改名检测（`lib/change-set.js:188-202`，否则改名会被拆成「删一个 + 加一个」，下游看不出同一份内容换了位置）；四路解析失败整体降级 `git-error`（`lib/change-set.js:163-165`）；最后用 `Set` 去重、把改名两端都并进 `all`（`lib/change-set.js:167-188`）。

### `lib/git-paths.js`

| 名称 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `GIT_QUOTEPATH_OFF` | `lib/git-paths.js:20` | `const string[]` | 值为 `['-c', 'core.quotepath=false']`。让 `git` 不做八进制转义的前置参数，必须紧跟 `git` 之后、子命令之前。 |
| `withQuotepathOff(args)` | `lib/git-paths.js:23-27` | 函数 | 给一份 git 参数表前置 quotepath 关闭；已是关闭状态（`args[0]==='-c' && args[1]==='core.quotepath=false'`）则不重复加。 |
| `SIMPLE_ESCAPES` | `lib/git-paths.js:29-31` | `const object` | `\a \b \t \n \v \f \r " \` 的字节映射，供 `decodeGitPath` 还原简单转义。 |
| `decodeGitPath(p)` | `lib/git-paths.js:37-72` | 函数 | 解开 git 路径转义。非「双引号包裹的转义串」原样返回（幂等）；引号包裹时按**字节**重组 Buffer 再 `utf8` 解码（一个中文三字节 `\NNN`），不认识的转义保守保留反斜杠本体。 |
| `decodeGitPaths(list)` | `lib/git-paths.js:75-79` | 函数 | 一份路径清单整体解码，保持顺序、丢弃空行。 |
| `default` 导出 | `lib/git-paths.js:81` | object | `{ GIT_QUOTEPATH_OFF, withQuotepathOff, decodeGitPath, decodeGitPaths }`。 |

两层落差（`lib/git-paths.js:1-17`）：(1) `core.quotepath=true` 默认把非 ASCII 路径输出成 `"a/\344\270\255.md"`（八进制字节转义 + 双引号），任何按字面量比较路径的代码都会失配；(2) 转义按**字节**做，所以「解转义」必须拼成 Buffer 再 UTF-8 解码。两件都做且相互独立：`GIT_QUOTEPATH_OFF` 挡住新发起的 git 调用不再转义（首选），`decodeGitPath` 兜住「已经被转义」的输入（旧记录/外部清单/调用方自己的 git 调用）。

## Architecture

组件 ≥3，且采集到落盘跨多文件，下面用 UTF-8 框图说明「谁调用谁、路径在哪里被解码」。`collectChangeSet`（`lib/change-set.js:108`）是四路采集的源头，`lib/git-paths.js` 的解码原语在三个消费点被复用。

```text
 ┌─────────────────────────────┐      ┌──────────────────────────────┐
 │ lib/engine/native-run.js   │      │ lib/engine/quality-gate.js   │
 │ runNativeJob (109)         │      │ readCommittedBaseline (117)  │
 │ 调用 collectChangeSet()     │      │ 读已提交基线(last_compiled)   │
 │ 得 changeSet + headCommit   │      └──────────────┬───────────────┘
 └───────────────┬─────────────┘                     │ baseline
                 │ changeSet                         ▼
                 ▼                          ┌──────────────────────────────┐
 ┌──────────────────────────────┐          │ lib/engine/native-state.js   │
 │ lib/change-set.js            │          │ mergeUnconsumed (455)        │
 │ collectChangeSet (108)       │          │ 四路 ∪ 上轮未消费 = 变化集    │
 │  ├─ rev-parse HEAD           │          └──────────────┬───────────────┘
 │  ├─ cat-file 基线可达性      │                         │ effectiveChanges
 │  ├─ diff --name-status -M    │                         ▼
 │  │    └─ parseNameStatus(58) │          ┌──────────────────────────────┐
 │  │         └─ decodeGitPath  │          │ lib/update-planner.js        │
 │  ├─ ls-files --others        │          │ planUpdate (156)             │
 │  │    └─ decodeGitPaths      │          │ 用 sourceChanges 算 action   │
 │  └─ normChangePath / 去重    │          └──────────────┬───────────────┘
 └───────────────┬──────────────┘                        │ UpdatePlan
                 │ ChangeSet                             ▼
                 ▼                          ┌──────────────────────────────┐
 ┌──────────────────────────────┐          │ lib/update-record.js         │
 │ lib/git-paths.js             │          │ buildUpdateRecord (131)      │
 │ decodeGitPath/decodeGitPaths │          │ ChangeSet 入 changeSet 摘要   │
 │ GIT_QUOTEPATH_OFF            │          └──────────────────────────────┘
 │ withQuotepathOff             │
 │ 被 apply-plan.js:214/264/300 │
 └───────────────┬──────────────┘
                 │ 复用解码（提交边界校验/自动提交清单）
                 ▼
       ┌──────────────────────────────┐
       │ lib/engine/apply-plan.js     │
       │ defaultVerifyCommit (214)    │
       │ commitWikiArtifacts (264,300)│
       └──────────────────────────────┘
```

要点：
- `collectChangeSet` 在所有 git 路径输出侧都先过 `decodeGitPath`/`decodeGitPaths`（`lib/change-set.js:66-67, 72, 160`），再 `normChangePath`（`lib/change-set.js:34`），所以出 `ChangeSet` 时路径已经是干净的 POSIX 相对路径。
- `lib/git-paths.js` 在两个落地点被**独立**复用：`lib/engine/quality-gate.js` 不直接用，但 `lib/engine/apply-plan.js` 用 `withQuotepathOff` + `decodeGitPaths` 校验自动提交边界（`lib/engine/apply-plan.js:214, 264, 300`），理由见 `lib/engine/apply-plan.js:211-213`——少了关 quotepath，中文模块名的合法产物会被白名单判成「混进 wiki 之外」，整轮编译被拉成 partial。
- `ChangeSet` 是纯数据，可 JSON 序列化（`test-change-set.mjs:222-229`），直接喂给 `lib/update-planner.js:148-152` 的 `planUpdate` 与 `lib/update-record.js:31-49` 的 `buildUpdateRecord`。

## Data Flow

一次增量编译里，本模块产出的 `ChangeSet` 沿以下路径流动（行号均来自真实调用点）：

1. **采集**：`lib/engine/native-run.js:287-300` 在增量决议段调用 `collectChangeSet(root, baseCommit)`。`baseCommit` 来自 `readCommittedBaseline`（`lib/engine/native-run.js:292-293`，实现在 `lib/engine/quality-gate.js:117-151`，读 **已提交**的 `HEAD:.codewiki/_meta.yaml` 而非工作区文件）。若抛错，兜底成 `{ok:false, state:'git-error', fallback:'full', …}`（`lib/engine/native-run.js:293-295`）。

2. **跨轮携带**：`lib/engine/native-state.js:485-487` 读上一轮 `state.json` 的 `unconsumed`，交给 `mergeUnconsumed`（`lib/engine/native-state.js:455-497`）。该函数只把 `staged/unstaged/untracked` 算「未消费」，把 `committed` 视为已进 commit；最终 `effectiveChanges = 本轮 sourceChanges ∪ 上轮未消费`（`lib/engine/native-state.js:488`）——这是消灭「未提交改动被基线前移洗掉」的第二类丢变化的关键。

3. **增量决议**：`lib/engine/native-run.js:309-335` 用 `changeSet.ok`、`baseCommit`、受管状态齐全度决定 `resolution`（`'full'` 或 `'update'`）。`changeSet` 不可信 → `fallbackReason` 写明原因并走全量（`lib/engine/native-run.js:310-311`）。

4. **计划**：`ChangeSet` 喂给 `lib/update-planner.js:148` 的 `planUpdate`，其中 `sourceChanges`/`deleted`/`renamed`/`untracked` 经 `normRel` 归一后驱动 write/keep/delete/review 四类 action（`lib/update-planner.js:171-175`）；无归属源码变更进 `unmappedChanges`，触发 `needsFull`（`lib/update-planner.js:381-392`）。

5. **裁决与归档**：`lib/update-record.js:151-169` 的 `buildUpdateRecord` 把 `changeSet` 折成 `changeSet` 摘要（counts/sourceChanges/ignored）写进 `temp/update-record.json`；`judgeOutcome`（`lib/update-record.js:37-45`）用 `unmappedSourceChanges` 判 blockers，决定 `canAdvanceBaseline`。

6. **落盘边界校验**：自动提交后，`lib/engine/apply-plan.js:234-247` 的 `verifyCommitScope` 用 `withQuotepathOff` + `decodeGitPaths` 反查提交实际文件清单，断言只动了 `.codewiki/` 与 `CodeWiki.md`（`lib/engine/apply-plan.js:300`）。

闭环保障：`ChangeSet.ok=false` 或 `fallback='full'` ⇒ 调用方走全量且**不推进基线**；`sourceChanges` 非空但无人认领 ⇒ planner 记 `unmappedSourceChanges` ⇒ `judgeOutcome` 加 blocker ⇒ `canAdvanceBaseline=false`。任何一跳都「不假装 clean」，这是本模块硬不变量。

## Connections

- [[native-run]] —— `lib/engine/native-run.js` 是 `collectChangeSet` 的生产调用方（增量决议段 `:287-379`），也是把 `ChangeSet` 折进 `native-state`/`update-record` 的编排者。
- [[native-state]] —— `lib/engine/native-state.js` 的 `mergeUnconsumed`（`lib/engine/native-state.js:455`）消费 `ChangeSet` 四路并合并上轮未消费，是「跨轮不丢变化」的持久化底座。
- [[update-planning]] —— `lib/update-planner.js` 的 `planUpdate`（`lib/update-planner.js:156`）把 `sourceChanges`/`deleted`/`renamed`/`untracked` 翻成每篇文章的 action，无主源码变更触发 `needsFull`。
- [[update-record]] —— `lib/update-record.js` 的 `buildUpdateRecord`（`lib/update-record.js:131`）把 `ChangeSet` 折成可机读摘要入 `temp/update-record.json`，`judgeOutcome` 据此判 `canAdvanceBaseline`。
- [[quality-gate]] —— `lib/engine/quality-gate.js` 的 `readCommittedBaseline`（`lib/engine/quality-gate.js:117`）提供 `collectChangeSet` 的 `baseCommit`；门禁的 `uncommitted-input` 判据与「四路采集要不要把工作区改动算进来」同源。
- [[engine-apply-plan]] —— `lib/engine/apply-plan.js` 复用 `lib/git-paths.js` 的 `withQuotepathOff`/`decodeGitPaths`（`lib/engine/apply-plan.js:42, 214, 264, 300`）做自动提交的边界校验，是路径解码原语的另一消费点。
- [[git_repo_utils]] —— `test-change-set.mjs` / `test-engine-native-job.mjs` 等测试手搓的临时 git 仓库 fixture，是验证本模块「四路采集 + 降级语义」的依托。

## Known Issues

- **未提交/暂存改动被「基线前移」洗掉的账靠 `native-state` 携带，本模块本身不解决**：`collectChangeSet` 诚实地把 `staged/unstaged/untracked` 收进 `ChangeSet`（`lib/change-set.js:108-112`），但 cw 基线只推进到 `HEAD`；真正防止「改了没提交就被当成已消化」的是 `lib/engine/native-state.js:451-493` 的 `mergeUnconsumed` 跨轮携带，不在本模块内。
- **`ChangeSet` 不含「变更内容」**，只有路径：planner 的「变没变」由_engine 的图 diff 决定（`lib/engine/native-run.js:287-289` 注释明确：变化集只决定「增量可不可信」，不决定「变没变」）。不要拿 `all` 非空当「引擎应增量」的依据。
- **`parseNameStatus` 假设 tab 分隔的 `--name-status` 输出**（`lib/change-set.js:58`）：重写/复制状态靠 `decodeGitPath` 兜底引号包裹路径，但若上游某天改用 `--name-only` 单列输出，R/C 的两列 `from→to` 会塌成单列，改名信息会丢。
- **越界/不可解码路径被静默丢弃**：`normChangePath` 对绝对路径/`../` 返回 `null`（`lib/change-set.js:37-39`），`decodeGitPath` 对解不开的转义保守原样返回（`lib/git-paths.js:37-39`）。这是「宁可暴露陌生字面量也不吐半截路径」的有意取舍，但也意味着极端畸形路径不会出现在 `ChangeSet` 里、不会被增量消费——理论上可能造成漏检（实践中未触发）。
- **`fallback:'full'` 只表示「调用方应退回全量」，本模块不主动退**：若调用方忽略 `ok=false`/`fallback` 直接当 clean 用，会重新引入「增量漏检」。强制退全是 `lib/engine/native-run.js:309-335` 的职责。
- **测试覆盖的盲区**：`test-change-set.mjs` 钉死了四路采集与降级语义，但它用 `makeRepo` 造的仓库路径全是 ASCII（`test-change-set.mjs:23-42`），中文路径那条靠 `test-change-set.mjs:182-201` 的 `decodeGitPath` 集成用例覆盖，非 ASCII 的 `R`/`C` 两列转义路径仍主要靠 `lib/git-paths.js` 单测与 `lib/engine/apply-plan.js` 真实链路兜底，没有独立 e2e 把「改名的中文文件」走通一遍。
