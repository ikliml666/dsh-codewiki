---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - test-change-set.mjs
  - lib/update-planner.js
  - lib/update-record.js
  - index.js
tags: [git, incremental, change-collection, planner-feed]
---

## Overview

`lib/change-set.js` 的职责只有一件事：把一次编译「自上次编译以来代码到底发生了什么」收成一个规范化、可序列化的变更集（ChangeSet），并把「采不全」的情形明确暴露出来，让调用方退回全量编译——绝不假装 clean。

背景缺陷（见 `lib/change-set.js:1-13` 注释）：旧的 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是三类改动对它完全隐形——

1. 改完代码**还没提交**（工作区修改）；
2. 只 `git add` 到暂存区没提交；
3. 新建文件还没被跟踪。

结果「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节却一路绿到底。本模块把 committed / staged / unstaged / untracked **四路改动**合并为一张去重后的清单，并单独标记 deleted / renamed，再把 wiki 自身产物（`.codewiki/`）剔除出「源码变更」。

模块导出两个纯函数（`parseNameStatus`、`collectChangeSet`）与两个工具函数（`isWikiProduct`、`normChangePath`），以及一个常量 `CHANGE_SET_VERSION`。`collectChangeSet` 通过依赖注入的 `execFile` 执行 git 命令，方便离线单测（真实链路用 `execFileSync`）。

## Key Components

### 常量

- `CHANGE_SET_VERSION = 1`（`lib/change-set.js:19`）——ChangeSet 的版本号，写入 `version` 字段，供下游（[[update_record]] 的 `buildUpdateRecord`）识别 schema 代数。
- `WIKI_PRODUCT_PREFIX = '.codewiki/'`（`lib/change-set.js:22`）——wiki 自身产物目录前缀：每次编译都会被重写，把它算成「源码变更」会让增量永远处于 dirty 状态。注意 `README`/`CHANGELOG`/`CodeWiki.md` 这类被文章 `source_files` 引用的文档**仍是合法源码**，不在此列。

### 公开函数 / 工具函数

- `isWikiProduct(relPath)`（`lib/change-set.js:26-29`）——判断一个相对路径是否落在 `.codewiki/`（等于 `.codewiki` 或以 `.codewiki/` 开头）。先 `String(relPath ?? '')` 再 `\` 转 `/`，是「剔除 wiki 自身产物」的统一判据。
- `normChangePath(p)`（`lib/change-set.js:33-40`）——路径归一化：把 `\` 转成 `/`、去首尾空白；绝对路径（`/` 开头）或盘符路径（`C:` 等）一律返回 `null`；剥离前导 `./`；含 `../` 跳出仓库的路径返回 `null`（视为不安全直接丢弃）。返回 POSIX 相对路径或 `null`。
- `parseNameStatus(out)`（`lib/change-set.js:52-71`）——解析 `git diff --name-status` 输出。逐行 `split(/\r?\n/)`，按 `\t` 切分：
  - 状态码以 `R`（renamed）或 `C`（copied）开头：取 `parts[1]` 为 `from`、`parts[2]` 为 `to`，经 `normChangePath` 归一（任一为 `null` 则跳过该行），产出 `{ kind: 'renamed' | 'copied', from, path: to, status: code }`。
  - 其余：`parts[1]` 经 `normChangePath`，为 `null` 则跳过；`D` 记 `{ kind: 'deleted', path, status }`，其它记 `{ kind: 'modified', path, status }`。
  - 返回 `entries` 数组（每行一个 entry，字段见上）。
- `defaultExecFile(cwd)`（`lib/change-set.js:42-49`，内部辅助）——返回默认执行器：`(cmd, args) => execFileSync(cmd, args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'], maxBuffer: 16*1024*1024 })`。真实链路用它跑 git。
- `emptyChangeSet(baseCommit, overrides = {})`（`lib/change-set.js:73-93`，内部辅助）——构造一个「失败/缺数据」基线 ChangeSet，字段全填默认值（`ok:false, state:'unknown', fallback:null, reason:'', committed/staged/.../all 全空数组`），再 `...overrides` 覆盖。返回的完整字段清单见下方 ChangeSet 结构。
- `collectChangeSet(cwd, baseCommit, opts = {})`（`lib/change-set.js:102-205`）——**模块主入口**。采集四路变更并返回 ChangeSet。流程：
  1. `base` 为空字符串 → 返回 `emptyChangeSet('', { state:'missing-base', fallback:'full', reason:'没有编译基线 commit，无法计算增量' })`（`:104-106`）。
  2. `run = opts.execFile ?? defaultExecFile(cwd)`；`git = (args) => String(run('git', args) ?? '')`（`:107-108`）。
  3. HEAD 有效性：`git(['rev-parse','HEAD'])` 失败先追问 `--is-inside-work-tree`：
     - 非 git 仓库 → `state:'no-git', fallback:'full'`；
     - git 仓库但命令出错 → `state:'git-error', fallback:'full'`（`:112-122`）。
     - 无输出 → `state:'git-error'`（`:123-125`）。
  4. 基线可达性：`git(['cat-file','-e',`${base}^{commit}`])` 失败 → `state:'unreachable-base', fallback:'full'`（`:128-137`，baseline 被 rebase/GC 掉时退回全量）。
  5. 四路采集（`:141-160`）：
     - `committed = git(['diff','--name-status','-M',`${base}..${headCommit}`])`；
     - `staged = git(['diff','--name-status','-M','--cached','HEAD'])`；
     - `unstaged = git(['diff','--name-status','-M'])`；
     - `untracked = git(['ls-files','--others','--exclude-standard'])` 逐行 `normChangePath` 过滤。
     - `-M` 打开改名检测，否则改名被拆成「删一个 + 加一个」下游看不出同份内容换位。
     - 任一 `git('name-status')` 抛错 → 整段抛 `Error`，外层 catch 返回 `state:'git-error', fallback:'full'`。
  6. 分类 + 去重（`:162-185`）：
     - `allSet` 收集所有 `path`；`deletedSet` 收集 `kind==='deleted'` 的路径；`renamed` 收集 `{ from, path, bucket }` 并把 `from` 也加进 `allSet`（改名两端都要进 `all`）；给每个 entry 打 `e.bucket`（committed/staged/unstaged）。
     - 把 `untracked` 加入 `allSet`。
     - 同一路径「既删又重建」：`untracked.includes(p)` 时从 `deletedSet` 删掉（否则 planner 会给一篇还在的文件安排 delete action）。
     - `all = [...allSet].sort()`；`sourceChanges = all.filter(p => !isWikiProduct(p))`；`ignored = all.filter(isWikiProduct)`。
  7. 返回 `ok:true` 的 ChangeSet（`:187-204`），各 bucket 数组均经 `isWikiProduct` 过滤掉 wiki 产物，且 `deleted`/`ignored` 额外 `.sort()`。

### ChangeSet 结构（返回对象的全部字段）

`collectChangeSet` 在成功（`:187-204`）或失败（`emptyChangeSet`，`:73-93`）时返回的对象，字段完全一致：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | `number` | `CHANGE_SET_VERSION`（=1） |
| `ok` | `boolean` | `true`=采集成功；`false`=需退回全量（此时一定有 `state`+`reason`+`fallback:'full'`） |
| `state` | `string` | `'ok'` / `'missing-base'` / `'no-git'` / `'git-error'` / `'unreachable-base'` / `'unknown'` |
| `fallback` | `string\|null` | `ok` 时 `null`；失败时为 `'full'`（调用方据此退回全量编译，不许把「采不到」当「没变化」） |
| `reason` | `string` | 失败原因；`ok` 时为空串 |
| `baseCommit` | `string` | 上次编译基线 commit（调用方传入） |
| `headCommit` | `string` | `git rev-parse HEAD` 得到的当前 commit |
| `committed` | `Entry[]` | `base..HEAD` 之间已提交变更（不含 wiki 产物） |
| `staged` | `Entry[]` | 暂存区（index）变更（不含 wiki 产物） |
| `unstaged` | `Entry[]` | 工作区未提交变更（不含 wiki 产物） |
| `untracked` | `string[]` | 未跟踪新文件路径（不含 wiki 产物） |
| `deleted` | `string[]` | 被删除的文件路径（已剔除「删后又重建」的，不含 wiki 产物） |
| `renamed` | `RenameEntry[]` | `{ from, path, bucket }`（不含 wiki 产物），`bucket` ∈ {committed,staged,unstaged} |
| `all` | `string[]` | 全部受影响路径（去重、排序，含改名两端，含 wiki 产物） |
| `sourceChanges` | `string[]` | `all` 中剔除 wiki 产物后的真实源码变更（planner 判「未映射变更」的唯一依据） |
| `ignored` | `string[]` | `all` 中属于 wiki 产物的路径（仅记账，不触发全量） |

`Entry` 形如 `{ kind: 'modified'|'deleted'|'renamed'|'copied', path, status, bucket? }`；`RenameEntry` 形如 `{ from, path, bucket }`。

注意：`version`/`ok`/`state`/`fallback`/`reason`/`baseCommit`/`headCommit`/`committed`/`staged`/`unstaged`/`untracked`/`deleted`/`renamed`/`all`/`sourceChanges`/`ignored` 全为可 JSON 序列化字段（`test-change-set.mjs:196-203` 验证 `JSON.parse(JSON.stringify(cs))` 后 `all`/`version` 不变），以便写入 [[update_record]] 的 `update-record.json`。

## Architecture

`collectChangeSet` 以注入的 `execFile` 为唯一 git 入口，四路采集后归并去重，输出规范化 ChangeSet 给 planner 与 update-record。

```text
                execFile 注入 (opts.execFile ?? defaultExecFile)
                              │
                              ▼
                   ┌──────────────────────┐
                   │   collectChangeSet    │  lib/change-set.js:102
                   │  (cwd, baseCommit)    │
                   └──────────┬───────────┘
                              │ 四路 git 采集
        ┌─────────────┬───────┼──────────────┬─────────────┐
        ▼             ▼       ▼              ▼             ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │committed │ │ staged   │ │unstaged  │ │untracked │ │baseline  │
  │ diff ..  │ │ diff -M  │ │ diff -M  │ │ls-files  │ │cat-file  │
  │ -M base..│ │ --cached │ │          │ │--others  │ │ -e check │
  │ HEAD     │ │ HEAD     │ │          │ │          │ │          │
  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
       │            │            │            │            │
       └──── parseNameStatus (lib/change-set.js:52) ────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │  归并去重 + 分类       │  lib/change-set.js:162
                   │ allSet / deletedSet / │
                   │ renamed / untracked   │
                   │ isWikiProduct 过滤     │
                   └──────────┬───────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │      ChangeSet        │
                   │ ok/state/fallback     │
                   │ committed/staged/...   │
                   │ all/sourceChanges/     │
                   │ ignored                │
                   └──────┬─────────┬──────┘
                          │         │
              feeds planUpdate   feeds buildUpdateRecord
              (lib/update-planner) (lib/update-record)
```

组件清单（均位于 `lib/change-set.js`）：`collectChangeSet`（主入口，`:102`）、`parseNameStatus`（输出解析，`:52`）、`normChangePath`（路径归一/越界拦截，`:33`）、`isWikiProduct`（wiki 产物剔除，`:26`）、`emptyChangeSet`（失败基线，`:73`）、`defaultExecFile`（默认执行器，`:42`）、常量 `CHANGE_SET_VERSION`（`:19`）/ `WIKI_PRODUCT_PREFIX`（`:24`）。

## Data Flow

1. **触发**：`index.js` 的 `codewiki_generate` 工具在 `runStaleUpdate`（见 `index.js:4148-4166`）里先调 `readCompiledBaseline(wikiPath)`（`index.js:1791-1799`，读 `.codewiki/_meta.yaml:last_compiled_commit`）拿到基线；读不到则按文件级退化、不采变更。
2. **采集**：`changeSet = collectChangeSet(cwd, baseline)`（`index.js:4148`）。若 `!changeSet.ok`，`runStaleUpdate` 直接返回 `{ needFull: true, reason: ... }`（`index.js:4160-4162`），调用方退回全量编译。
3. **喂给 planner**：成功时 `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`index.js:4189`，定义于 `lib/update-planner.js:156`）。planner 只读 ChangeSet 的 `sourceChanges`/`deleted`/`renamed`/`untracked`/`all`（见 `lib/update-planner.js:171-175`），用 `sourceChanges` 判「未映射变更」、用 `deleted`/`renamed` 判文章 `write`、用 `untracked` 给无归属新文件打标签。若 `unmappedSource` 非空，planner 返回 `needsFull`（`:391-392`），再次退回全量。
4. **写入 job**：`index.js:3935-3946` 把 ChangeSet 的 `version/state/baseCommit/headCommit/committed/staged/unstaged/untracked/deleted/renamed` 摘要塞进 `job.changeSet`（注意这里**不含** `all`/`sourceChanges`/`ignored`，只留 planner 已消化的明细）。
5. **落盘复盘**：编译收尾时 `saveRecord`（`index.js:2590`）调 `buildUpdateRecord`（`lib/update-record.js:131`），从 `job.changeSet` 重建精简 `changeSet` 段（含 `state/ok/fallback/reason/counts/sourceChanges/ignored`，见 `lib/update-record.js:153-169`），写进 `<wiki>/temp/update-record.json`，供面板复盘「这次到底动了哪些文件」。
6. **降级语义贯穿**：任何 `fallback:'full'` 的 state（missing-base / no-git / git-error / unreachable-base）都意味着「采不全」——调用方必须退回全量编译，而不许把「采不到」当成「没变化」（这是修复「增量漏检」的核心约束，见 `lib/change-set.js:100-101`）。

## Connections

- [[update-planner]] —— ChangeSet 是增量规划的输入：`planUpdate`（`lib/update-planner.js:156`）消费 `changeSet.sourceChanges`/`deleted`/`renamed`/`untracked`/`all`（`lib/update-planner.js:171-175`），据此判每篇文章 `write/keep/delete/review`，并把无归属源码变更标成 `unmappedChanges` 触发全量。
- [[update_record]] —— `buildUpdateRecord`（`lib/update-record.js:131`）把 ChangeSet 摘要（`lib/update-record.js:153-169`）连同 judgeOutcome 落盘为 `temp/update-record.json`，是「一次编译动了哪些文件」的机读证据。
- [[index]]（codewiki_generate 编排）—— `index.js:4148-4166` 的 `runStaleUpdate` 调 `readCompiledBaseline` + `collectChangeSet`；`index.js:1791-1802` 把 ChangeSet 摘要写入 `job.changeSet`。
- [[incremental]] —— 提供 `loadSnapshot`/`graphFromSnapshot`/`extractCurrentGraph` 等，供 planner 在「符号级增量」路径比对 `oldGraph`/`newGraph`（见 `index.js:4175-4186`）。本模块的 ChangeSet 是文件级变更底表，符号级比对在其之上叠加。
- git 命令执行依赖 `node:child_process` 的 `execFileSync`（真实链路，`lib/change-set.js:17,43`），测试用 `opts.execFile` 注入假执行器（见 `test-change-set.mjs:177-194`，验证离线单测不依赖真实 git）。

## Known Issues

- **`all` 仍含 wiki 产物，但 `job.changeSet` 丢弃了 `all`/`sourceChanges`/`ignored`**：`index.js:3935-3946` 只把 bucket 明细（`committed/staged/unstaged/untracked/deleted/renamed`）塞进 `job.changeSet`，没带 `sourceChanges` 与 `ignored`。rebuild 后的 `update-record` 里的 `sourceChanges`/`ignored`（`lib/update-record.js:167-168`）只能从 job 里现有字段重新推导，而 planner 需要的正是 `sourceChanges` 全量——若 job 摘要丢失该项，复盘/判终态的「未映射源码变更」口径会收窄。非 bug 但需注意：调用方（[[update_planner]]）必须自己从 bucket 明细重建 `sourceChanges`，不能依赖 job 透传。
- **改名 bucket 仅标记来源，不改写 `all` 顺序**：`renamed` 的 `bucket`（`:173`）只说明改名出现在哪一路（committed/staged/unstaged），下游若想区分「改名 vs 纯新增」，需配合 `renamed` 列表与 `all` 两端路径自行判断（`lib/update-planner.js:280-289` 已这样处理）。
- **`.codewiki/` 内人工改动会被静默忽略**：`isWikiProduct`（`lib/change-set.js:26`）把所有 `.codewiki/` 路径（含手写的 `.codewiki/modules/*.md`）一律从 `sourceChanges` 剔除、只进 `ignored`（`lib/change-set.js:184-185`）。若用户在 wiki 产物里手改了内容，增量编译不会把它当源码变更重编——这是有意设计（避免增量永远 dirty），但意味着「改 wiki 自身」不会触发文章重算，需靠 `scope=full` 或 staleness 察觉。测试见 `test-change-set.mjs:152-164`。
- **`renamed` 在 untracked 合并前已固定 bucket**：`renamed` 在 `:171-177` 即完成采集与 `bucket` 标记，而 `untracked` 对 `deletedSet` 的「删后重建」修正（`:181`）只影响 `deleted` 集合，不回头修 `renamed`（改名不会同时出现在 untracked，因此实际不影响，但逻辑顺序是「先 renamed 后 untracked 修正」）。
- **无「禁用」分支**：本模块所有逻辑均处于启用状态，没有注释掉或 `disabled` 的功能；降级全部通过 `ok=false + fallback='full'` 的状态机表达，而非开关。


---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - test-change-set.mjs
  - lib/update-planner.js
  - lib/update-record.js
  - index.js
tags: [incremental, git, change-collection, fallback]
---

## Overview

`lib/change-set.js` 解决的是「一次编译到底要看见哪些改动」这个增量编译的第一道关口。

背景缺陷（文件头注释 `lib/change-set.js:1-13` 已写明）：旧的 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是三类改动对它完全隐形——①改完代码还没提交（工作区修改）；②只 `git add` 到暂存区没提交；③新建文件还没被跟踪。结果「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节却一路绿到底。这是本仓库增量融合要修的第一条——变更不能丢。

本模块的职责只有一件事（见 `lib/change-set.js:11-13`）：把 **committed / staged / unstaged / untracked** 四路改动收成一个规范化、可序列化（JSON）的 `ChangeSet`，并把「采不全」的情形明确暴露出来（`state` + `fallback='full'`），让调用方退回全量编译——绝不假装 clean（即绝不把「采不到」当成「没变化」）。

核心公共函数是 `collectChangeSet`（`lib/change-set.js:102`），辅助导出有 `CHANGE_SET_VERSION`、`isWikiProduct`、`normChangePath`、`parseNameStatus`，以及模块内部未导出的 `emptyChangeSet` 与 `defaultExecFile`。

设计要点：
- **依赖注入**：`collectChangeSet` 通过 `opts.execFile` 注入 git 执行器（默认 `defaultExecFile` 用 `execFileSync`），便于离线单测（见 `test-change-set.mjs:177-194`）。
- **wiki 自身产物排除**：`.codewiki/` 下每次编译都会被重写的产物不算源码变更，否则增量永远 dirty 且「未映射变更」永远无法清零（`lib/change-set.js:21-29`、`lib/change-set.js:184-185`）。README/CHANGELOG/CodeWiki.md 这类被文章 `source_files` 引用的文档仍是合法源码，不在此列。
- **降级语义**：任何采不全的情形都返回 `ok=false` 且 `fallback='full'`，调用方据此退回全量编译（见 `lib/change-set.js:99-101`）。

## Key Components

### 常量与辅助（均导出）

- `CHANGE_SET_VERSION`（常量，`lib/change-set.js:19`）：变更集结构版本号，当前为 `1`。
- `WIKI_PRODUCT_PREFIX`（模块内部常量，`lib/change-set.js:24`，未导出）：`'.codewiki/'`，用于判定「wiki 自身产物目录」。
- `isWikiProduct(relPath)`（函数，`lib/change-set.js:26-29`）：返回 `relPath` 是否等于 `.codewiki` 或以 `.codewiki/` 开头（路径先 `\`→`/` 归一）。被 `collectChangeSet` 用来从 `all` 中区分出 `sourceChanges` 与 `ignored`。
- `normChangePath(p)`（函数，`lib/change-set.js:33-40`）：路径归一——`\`→`/`、`trim`、去掉行首 `./`；绝对路径（`/...`）或盘符路径（`C:/...`）以及任何越界路径（`../` 跳出）一律返回 `null`（直接丢弃，它们不该出现在变更集里）。返回归一后的 POSIX 相对路径，空串返回 `null`。
- `parseNameStatus(out)`（函数，`lib/change-set.js:52-71`）：解析 `git diff --name-status` 输出。每行按 `\t` 拆分：`R`/`C` 开头的记 `{ kind: 'renamed' | 'copied', from, path, status }`（两端路径都过 `normChangePath`，任一为 null 则跳过该行）；`D` 记 `{ kind: 'deleted', path, status }`；其余记 `{ kind: 'modified', path, status }`。`from`/`path` 均为归一后的相对路径。

### 主入口

- `collectChangeSet(cwd, baseCommit, opts = {})`（函数，`lib/change-set.js:102-205`）：采集四路变更集。参数：
  - `cwd`：仓库工作目录；
  - `baseCommit`：上次成功编译的基线 commit（对应 `cw` 的 `_meta.yaml:last_compiled_commit`）；
  - `opts.execFile(cmd, args) -> stdout`：注入的 git 执行器，抛错表示该命令失败，默认 `defaultExecFile(cwd)`（`lib/change-set.js:42-49`，用 `execFileSync`，`maxBuffer: 16*1024*1024`）。
  - 返回 `ChangeSet` 对象（形状见下）。
  - 流程（`lib/change-set.js:103-204`）：
    1. `base` 为空 → `emptyChangeSet('', { state: 'missing-base', fallback: 'full', reason: '没有编译基线 commit，无法计算增量' })`（`lib/change-set.js:104-106`）。
    2. `git rev-parse HEAD` 失败 → 再问 `git rev-parse --is-inside-work-tree`，区分 `no-git`（非 git 目录）与 `git-error`（`lib/change-set.js:112-122`）；无输出也算 `git-error`。
    3. `git cat-file -e <base>^{commit}` 失败 → `state: 'unreachable-base'`，基线是 rebase/GC 掉的（`lib/change-set.js:127-137`）。
    4. 四路采集（`-M` 打开改名检测，见 `lib/change-set.js:139-145`）：
       - committed：`diff --name-status -M <base>..<headCommit>`；
       - staged：`diff --name-status -M --cached HEAD`；
       - unstaged：`diff --name-status -M`（工作区对 HEAD）；
       - untracked：`ls-files --others --exclude-standard` 后逐行 `normChangePath` + 过滤。
       任一命令抛错 → `state: 'git-error', fallback: 'full'`（`lib/change-set.js:158-160`）。
    5. 分类去重（`lib/change-set.js:162-185`）：`all` 必须含改名两端（旧路径从「被谁引用」角度同样是变化）；`deletedSet` 记录删除路径；若同一路径既删又重建（untracked 含同名），从 `deletedSet` 中剔除（否则 planner 会为一篇还在的文件安排 delete action）。`sourceChanges = all` 中排除 wiki 产物的部分；`ignored = all` 中是 wiki 产物的部分。
    6. 返回 `ok:true, state:'ok', fallback:null`（连同四路分类数组）或上述降级对象。

### ChangeSet 对象字段（完整结构）

降级骨架由 `emptyChangeSet`（`lib/change-set.js:73-93`）构造，成功路径在 `lib/change-set.js:187-204` 填充。所有字段如下（无时间戳/自动生成字段，本身为纯快照对象，可 `JSON.stringify` 落盘）：

| 字段 | 类型 | 含义 / 来源 |
|---|---|---|
| `version` | number | `CHANGE_SET_VERSION`（始终为 `1`） |
| `ok` | boolean | `true` 表示四路采集完整成功；`false` 表示降级（必带 `state`/`reason`/`fallback`） |
| `state` | string | `'ok'` / `'missing-base'` / `'no-git'` / `'git-error'` / `'unreachable-base'` / `'unknown'`（骨架默认） |
| `fallback` | string\|null | 降级时固定 `'full'`；成功时 `null`。调用方据此决定是否退回全量编译 |
| `reason` | string | 降级原因文本（slice 截断）；成功时为空串 |
| `baseCommit` | string | 传入的基线 commit（trim 后） |
| `headCommit` | string | `git rev-parse HEAD` 结果；降级在能拿到时也填（`lib/change-set.js:119-135`） |
| `committed` | Array<{kind,path,status,bucket?}> | `base..HEAD` 的已提交改动 |
| `staged` | Array<{kind,path,status,bucket?}> | 暂存区改动 |
| `unstaged` | Array<{kind,path,status,bucket?}> | 工作区未提交改动 |
| `untracked` | Array<string> | 未跟踪新文件（相对路径） |
| `deleted` | Array<string> | 被删除的文件路径（已剔除「删后又建同名」的情形），按字典序 |
| `renamed` | Array<{from,path,bucket}> | 改名记录（旧→新），`bucket` 为来源（`committed`/`staged`/`unstaged`） |
| `all` | Array<string> | 全部变化路径去重后排序（含改名两端）；**注意**：含 wiki 产物 |
| `sourceChanges` | Array<string> | `all` 中排除 wiki 产物后的部分（真实源码/文档变更），喂给 planner |
| `ignored` | Array<string> | `all` 中是 wiki 产物的部分，按字典序（只记账，不触发全量） |

注：`committed/staged/unstaged` 原始条目在去重阶段被就地加上 `bucket` 字段（`lib/change-set.js:175`），标明它们从哪个桶来；最终返回前还会用 `isWikiProduct` 过滤掉 wiki 产物自身（`lib/change-set.js:195-200`）。

### 模块内部辅助（未导出）

- `defaultExecFile(cwd)`（`lib/change-set.js:42-49`）：默认 git 执行器工厂，返回 `(cmd, args) => execFileSync(cmd, args, {...})`。
- `emptyChangeSet(baseCommit, overrides = {})`（`lib/change-set.js:73-93`）：所有降级分支共用的骨架构造器，按 `overrides` 覆盖默认字段（`ok:false, state:'unknown', fallback:null, ...`）。
- `collect(label, args)`（闭包，`lib/change-set.js:141-145`）：四路采集的薄封装，捕获异常并转成带 label 的错误（抛给上层统一降级为 `git-error`）。

## Architecture

`collectChangeSet` 是单文件、无外部状态模块，内部由「四路 git 采集 → 统一解析 → 分类去重 → 排除 wiki 产物」一条流水线构成。框图如下（组件标注文件名/函数）：

```text
            cwd + baseCommit + opts.execFile
                         │
                         ▼
            ┌──────────────────────────────────┐
            │ collectChangeSet (change-set.js)  │
            │  :102                              │
            └──────────────────────────────────┘
              │        │         │        │
   ┌──────────┘        │         │        └──────────┐
   ▼                   ▼         ▼                    ▼
┌────────┐      ┌──────────┐ ┌──────────┐     ┌──────────────┐
│ HEAD   │      │ committed│ │ staged/  │     │ untracked    │
│ check  │      │ diff     │ │ unstaged │     │ ls-files     │
│ :113   │      │ -M       │ │ diff -M  │     │ --others     │
│ cat-file│     │ :151     │ │ :152-153 │     │ :154         │
└───┬────┘      └────┬─────┘ └────┬─────┘     └──────┬───────┘
    │  any fail       │            │                  │
    │ ───────────────►│  parseNameStatus (each)      │ normChangePath
    │  emptyChangeSet │      :52                     │  each line :156
    │  state+fallback │            │                  │
    │  ='full'        │            ▼                  │
    └─► (caller: full)└──►  collect(label,args):141 ─┘
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │ 分类+去重 :162-183          │
                    │ allSet / deletedSet /      │
                    │ renamed / untracked        │
                    │ 删后又建同名 → 移出 deleted │
                    └──────────────┬─────────────┘
                                   ▼
                    ┌────────────────────────────┐
                    │ isWikiProduct 分离 :184-185 │
                    │ sourceChanges / ignored    │
                    └──────────────┬─────────────┘
                                   ▼
                         ChangeSet { ok, state,
                          committed, staged,
                          unstaged, untracked,
                          deleted, renamed, all,
                          sourceChanges, ignored }
                                   │
                                   ▼
                        planUpdate / update-record
```

`state` 的取值与触发条件（均落在降级分支，调用方读 `fallback==='full'` 退回全量）：

| state | 触发位置 | 含义 |
|---|---|---|
| `missing-base` | `lib/change-set.js:105` | 没有编译基线 commit |
| `no-git` | `lib/change-set.js:119` | 不是 git 仓库 / 无法读 HEAD |
| `git-error` | `lib/change-set.js:121,124,159` | git 命令失败或无输出 |
| `unreachable-base` | `lib/change-set.js:131-136` | 基线 commit 已不在历史里 |
| `ok` | `lib/change-set.js:190` | 四路采集成功 |

## Data Flow

`ChangeSet` 不是终态，而是增量编译链路的「第一份证据」，沿 `index.js` → `update-planner.js` → `update-record.js` 一路传递：

1. **采集触发**：`index.js` 的 `runStaleUpdate`（`index.js:4148`）在 stale/auto 逐篇更新分支里读取编译基线（`readCompiledBaseline(wikiPath)`，`index.js:1791`），然后：
   ```js
   changeSet = collectChangeSet(cwd, baseline)   // index.js:4143
   if (!changeSet.ok) return { needFull: true, reason: `变更采集不可用（${changeSet.reason}）` }
   ```
   另一处「cw status 说有变更却没命中文章」的分支（`index.js:4248-4257`）同样先 `collectChangeSet` 再交给 `planUpdate`。

2. **入 job 占位**：编译任务提交时，`changeSet` 的精简版被写入 job 对象（`index.js:3919-3930`，只记 `state/baseCommit/headCommit` 与各分类数组，去掉 `reason`/`all`/`sourceChanges`/`ignored`），供面板展示与终态判定。

3. **喂给 planner**：`changeSet.ok` 且已有文章时，`index.js:1924` 调 `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`lib/update-planner.js:156`）。planner 从中取 `sourceChanges / deleted / renamed / untracked / all`（`lib/update-planner.js:424-428`）判断哪篇文章要 write/keep/delete/review，并把「无归属的源码变更」记进 `unmappedSourceChanges` 要求全量（`lib/update-planner.js:391-392`）。`plan.needsFull` 或 `plan.unmappedChanges` 非空时，`index.js` 退回全量编译（`index.js:4177-4179`、`index.js:4272-4277`）。

4. **入更新记录**：最终 `changeSet` 被 `buildUpdateRecord`（`lib/update-record.js:131`，调用在 `index.js` 收尾阶段）收进 `update-record.json` 的 `changeSet` 字段——只留 `state/ok/fallback/reason` 与各类 `counts`、以及完整的 `sourceChanges`/`ignored`（`lib/update-record.js:153-169`）。`judgeOutcome`（`lib/update-record.js:37`）用 `plan.unmappedSourceChanges` 决定 `canAdvanceBaseline`（只有 `outcome==='done'` 才允许前移基线，`lib/update-record.js:124`），从而把「采不全/采到没人认领的变更」显式阻断基线前移。

5. **可序列化约束**：`test-change-set.mjs:196-203` 钉住 `ChangeSet` 必须能 `JSON.parse(JSON.stringify(cs))` 往返（`version/all` 不丢），因为它要写进 `update-record`。

一句话：`collectChangeSet` 把「git 看见的四路改动」变成一份可机读、可降级、可序列化的事实清单；下游 planner 把它翻译成「每篇文章该做什么」，update-record 把它作为「能不能推进编译基线」的依据。

## Connections

- [[update-planner]]：`collectChangeSet` 的产物是 `planUpdate` 的第一个输入（`lib/update-planner.js:156-163` 解 `changeSet.sourceChanges/deleted/renamed/untracked/all`）。planner 把无归属的源码变更升级为 `needsFull`，本模块是这套「变化不能丢」语义的数据源头。
- [[update-record]]：`buildUpdateRecord`（`lib/update-record.js:131-169`）把 `ChangeSet` 收进 `update-record.json`；`judgeOutcome`（`lib/update-record.js:37-128`）依 `unmappedSourceChanges` 决定 `canAdvanceBaseline`。
- [[incremental]]：当 `update-planner` 走符号级判定时（`oldGraph/newGraph` 非空），`lib/incremental.js` 的 `filterStaleTasks` 复用 `lib/change-set.js` 的 `isWikiProduct` 同源思路（`WIKI_PRODUCT_PREFIX` 在 change-set 定义，`lib/change-set.js:24`），但两者是独立实现；符号快照 `SNAPSHOT_REL` 落在 `.codewiki/temp/` 下，正属本模块排除的 wiki 产物（`lib/incremental.js:22`）。
- [[symbols]]：`extractCurrentGraph`（`index.js` 经 `lib/symbols.js`）提供 `newGraph`，与 `loadSnapshot`（`[[incremental]]`）的 `oldGraph` 一起喂给 `planUpdate` 做符号级增量；`collectChangeSet` 提供其文件级地基。
- [[graph-diff]]：符号级判定依赖 `diffGraphs`/`changedIds`/`graphDiffCounts`，与 `ChangeSet` 的文件级变更互补（文件级在无符号可判时兜底，见 `lib/update-planner.js:179-304`）。
- `index.js`：`runStaleUpdate`（`index.js:4148`）与 stale 兜底分支（`index.js:3892`）是 `collectChangeSet` 在运行时的唯二调用点；`submit`（`index.js:3919`）把精简 `changeSet` 写入 job。

## Known Issues

- **改名只记文件级**：`collectChangeSet` 的 `renamed` 是 `{from, path, bucket}` 文件级记录，没有组件级 oldId→newId 映射。planner 在 stale scan 时需同时接受 `diff.renamed`（`Map<oldId,newId>`，来自 `[[graph-diff]]`）与 git 文件级改名（`lib/update-planner.js:320-324`）两种形态——两者来源不同，需要调用方自己合并，本模块不提供。
- **「删后又建同名」靠 untracked 列表推断**：同一路径既删又出现在 `untracked` 时，从 `deletedSet` 移除（`lib/change-set.js:179-181`）。若文件系统上该路径其实不存在（极端脏状态），理论上仍会被记为 deleted——这一推断依赖 `ls-files --others` 的即时准确性。
- **wiki 产物判定只认路径前缀**：`isWikiProduct`（`lib/change-set.js:26-29`）只按 `.codewiki` 前缀过滤。若用户把真实源码放进 `.codewiki/` 下（非常规），会被错误地排除出 `sourceChanges`；反之 `README.md`/`CHANGELOG.md`/`CodeWiki.md` 即便被文章引用也保留在 `sourceChanges`——这是有意为之（`lib/change-set.js:184-187`），但依赖部署约定。
- **降级不重试/不部分成功**：任一 git 命令失败即整体 `git-error` + `fallback='full'`（`lib/change-set.js:158-160`）——即便只有一路（如 untracked）失败，已采到的 committed/staged 也一并丢弃。这是保守设计（宁可全量也不丢变更），但意味着 git 暂时性故障会强制全量重编。
- **`all` 含 wiki 产物、`sourceChanges`/`ignored` 不含**：`all` 是去重后的全量（含 `.codewiki/`），而真正喂给 planner 的是 `sourceChanges`（`lib/change-set.js:184-185`）。调用方若误用 `all` 而非 `sourceChanges` 判定归属，会把 wiki 自产物当成「未映射变更」导致永远 partial（这正是 `lib/update-record.js:167-168` 只取 `unmappedSourceChanges` 的原因）。
- **测试覆盖见 `test-change-set.mjs`**（P0-1）：钉死了非 git 目录（no-git）、缺 baseCommit（missing-base）、base 不可达（unreachable-base）、干净仓库、unstaged/staged/untracked、删除、改名、committed、四路合并去重、wiki 产物剔除 `.codewiki/`、路径归一 POSIX、注入 execFile 离线单测、`ChangeSet` 可 JSON 序列化共 15 个场景（`test-change-set.mjs:47-203`）。


