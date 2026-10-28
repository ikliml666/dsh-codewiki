---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - test-change-set.mjs
  - lib/update-planner.js
  - lib/update-record.js
  - index.js
tags: [git, change-set, incremental, baseline, wiki-product]
---

## Overview

`lib/change-set.js` 只负责一件事：**把一次编译「看得见」的全部 git 改动，收成一个规范化、可序列化的 ChangeSet**，并把「采不全」的情形明确暴露出来，让调用方退回全量编译（full），绝不假装 clean。

### 它要修的缺陷（背景）

旧链路 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是三类改动对它完全隐形（`lib/change-set.js:1-9`）：

1. 改完代码**还没提交**（工作区修改 / unstaged）；
2. 只 `git add` 到暂存区没提交（staged）；
3. 新建文件还没被跟踪（untracked）。

结果「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节却一路绿到底。本模块把 **committed / staged / unstaged / untracked** 四路改动合一，配合 `lib/update-planner.js` 把「采不全」的情形（`state` + `fallback='full'`）暴露出来。

### 核心语义

- 模块零依赖（除 Node 内置 `execFileSync`），通过**依赖注入 `opts.execFile`** 支持离线单测（`lib/change-set.js:15, 107`）。
- 返回的 `ChangeSet.ok=false` 时**一定带 `state` 与 `reason`，且 `fallback='full'`**——调用方据此退回全量编译；不许把「采不到」当成「没变化」（`lib/change-set.js:99-102`）。
- wiki 自身产物目录 `.codewiki/` 每次编译都会被重写，把它算成「源码变更」会让增量永远处于 dirty 状态，故从 `sourceChanges` 中剔除、记进 `ignored`（`lib/change-set.js:185-188, 184-185`）。

## Key Components

### 常量 / 导出常量

- `CHANGE_SET_VERSION`（第 19 行）= `1`。ChangeSet 的版本号字段，写入 `version`，供 `lib/update-record.js` 的反序列化版本校验与机读复盘使用。
- `WIKI_PRODUCT_PREFIX`（第 24 行）= `'.codewiki/'`。wiki 自身产物目录前缀，每次编译被重写，不计入源码变更。

### 纯函数（路径归一与解析）

- `isWikiProduct(relPath)`（第 26-29 行）：判断路径是否为 wiki 产物。`relPath` 等于 `'.codewiki'` 或以 `'.codewiki/'` 开头即返回 `true`。新文章 `README.md`/`CHANGELOG`/`CodeWiki.md` 等被文章 `source_files` 引用的文档仍是合法源码，不被判为 wiki 产物。
- `normChangePath(p)`（第 33-40 行）：路径归一。把 Windows 反斜杠统一成 POSIX 相对路径（`/`），`trim` 后若为空返回 `null`；绝对路径（`/...`）或盘符路径（`C:`）返回 `null`；用 `replace(/^\.\//, '')` 去掉 `./` 前缀；以 `../` 开头或包含 `/../` 或整段为 `..` 的**越界路径一律判不安全、直接丢弃**——它们不该出现在变更集里。
- `defaultExecFile(cwd)`（第 42-49 行）：默认执行器工厂，返回 `(cmd, args) => execFileSync(...)`。`cwd` 固定、`encoding:'utf8'`、`stdio:['ignore','pipe','pipe']`、`maxBuffer:16*1024*1024`。真实链路用它；测试注入假执行器可绕过真实 git。
- `parseNameStatus(out)`（第 52-71 行）：解析 `git diff --name-status` 输出。按行 `split(/\r?\n/)`，每行 `split('\t')`：
  - 状态码以 `R`（renamed）或 `C`（copied）开头：`normChangePath(parts[1])` 为 `from`、`normChangePath(parts[2])` 为 `to`，push `{ kind: code.startsWith('R') ? 'renamed' : 'copied', from, path: to, status: code }`，`from`/`to` 任一不安全则跳过；
  - `D` 开头记为 `{ kind:'deleted', path, status }`；其余记为 `{ kind:'modified', path, status }`；路径不安全则跳过。
  - 空行跳过。

### 主入口

- `collectChangeSet(cwd, baseCommit, opts = {})`（第 102-205 行）：采集变更集。
  - `cwd`：仓库工作目录；`baseCommit`：上次成功编译的基线 commit（`cw` 的 `_meta.yaml:last_compiled_commit`）；`opts.execFile(cmd, args) -> stdout` 注入执行器，抛错表示该命令失败。
  - 流程：
    1. `baseCommit` 为空 → 返回 `emptyChangeSet('', { state:'missing-base', fallback:'full', reason:'没有编译基线 commit，无法计算增量' })`（第 104-106 行）。
    2. 取 `HEAD`：`git rev-parse HEAD`（第 113-114 行）。失败再问 `git rev-parse --is-inside-work-tree` 区分「非 git 目录」（`state:'no-git'`）与「git 仓库但命令出错」（`state:'git-error'`，第 116-122 行）；无输出也归 `git-error`（第 123-125 行）。
    3. 基线可达性：`git cat-file -e <base>^{commit}` 失败（基线被 rebase/GC 掉）→ `state:'unreachable-base'`、`fallback='full'`，不把脏状态当 clean（第 128-137 行）。
    4. 四路采集（第 139-160 行）：`-M` 打开改名检测，否则改名会被拆成「删+加」下游 planner 看不出同一份内容换了位置。
       - committed：`git diff --name-status -M <base>..<headCommit>`
       - staged：`git diff --name-status -M --cached HEAD`
       - unstaged：`git diff --name-status -M`
       - untracked：`git ls-files --others --exclude-standard` 后逐行 `normChangePath` 过滤。
       - 任一 `git` 调用抛错 → `state:'git-error'`、`fallback='full'`（第 158-160 行）。
    5. 分类 + 去重（第 162-185 行）：用 `allSet` 收集所有 `path`；`deletedSet` 收集 `kind==='deleted'`；`renamed` 数组额外收集 `from`（改名两端都要留在 `all`）；`untracked` 也并入 `allSet`。「先删后重建同名文件」时从 `deletedSet` 摘除（当前存在就不是删除，否则 planner 会给还在的文件安排 delete）。`all` 排序后输出；`sourceChanges = all.filter(!isWikiProduct)`，`ignored = all.filter(isWikiProduct)`。
  - 返回的 `ok=true` 成功对象（第 187-204 行）见下「ChangeSet 字段」。

- `emptyChangeSet(baseCommit, overrides = {})`（第 73-93 行）：构造带全部字段的空变更集，默认 `ok:false`、`state:'unknown'`、`fallback:null`、`reason:''`，再 `...overrides` 覆盖。所有降级分支都先走它再补 `state`/`reason`/`fallback`。

### ChangeSet 字段（成功对象，第 74-92、187-204 行）

| 字段 | 类型 | 含义 |
|------|------|------|
| `version` | number | `CHANGE_SET_VERSION`（=1） |
| `ok` | boolean | 是否成功采集（`false` 时必有降级分支） |
| `state` | string | 状态码：`ok` / `missing-base` / `no-git` / `git-error` / `unreachable-base` / `unknown` |
| `fallback` | string\|null | 失败时 `'full'`，表示调用方应退回全量编译；成功时 `null` |
| `reason` | string | 降级原因；成功时为空串 |
| `baseCommit` | string | 编译基线 commit |
| `headCommit` | string | `git rev-parse HEAD` 结果；降级时若已取到也填 |
| `committed` | array | `{ kind, path, status }[]`（`kind`∈ modified/deleted/renamed/copied，R/C 带 `from`），已剔除 wiki 产物 |
| `staged` | array | 同上，暂存区变更 |
| `unstaged` | array | 同上，工作区未提交变更 |
| `untracked` | string[] | 未跟踪新文件路径，已剔除 wiki 产物 |
| `deleted` | string[] | 被删路径（已剔除 wiki 产物、已扣掉「删后重建」），排序 |
| `renamed` | array | `{ from, path, bucket }[]`（bucket∈ committed/staged/unstaged），已剔除 wiki 产物 |
| `all` | string[] | 四路去重后的全部路径（含改名两端、含 wiki 产物），排序 |
| `sourceChanges` | string[] | `all` 中**非 wiki 产物**的路径（交给 planner 做增量判定的真实源码/文档变更） |
| `ignored` | string[] | `all` 中被判为 wiki 产物（`.codewiki/` 下）的路径，仅记账，不触发重写 |

### 被本模块喂给的下游结构

- `ChangeSet` 作为 `planUpdate` 入参 `changeSet`（`lib/update-planner.js:148-175`）：planner 取 `cs.sourceChanges`/`deleted`/`renamed`/`untracked`/`all` 折算成 `Set`，并据 `renamed` 的 `{from,to}` 喂给 stale scan。
- `ChangeSet` 经 `index.js` 的 `submit` 精简进 `job.changeSet`（`index.js:3622-3633`，只留 version/state/baseCommit/headCommit/committed/staged/unstaged/untracked/deleted/renamed，不含 all/sourceChanges/ignored），再经 `buildUpdateRecord`（`lib/update-record.js:151-169`）落 `.codewiki/temp/update-record.json`。

## Architecture

该模块只有 4 个函数 + 2 个常量 + 1 个内部工厂，逻辑扁平且纯（除注入的 `execFile`）。下面是「四路采集 → 归一/解析 → 分类去重 → 分离 wiki 产物」的框图：

```text
        git repo (cwd) + baseCommit (from _meta.yaml)
                          │
                          ▼
        collectChangeSet(cwd, baseCommit, {execFile})   lib/change-set.js:102
                          │
      ┌───────────────────┴───────────────────────────────┐
      │ 1) rev-parse HEAD        → no-git / git-error      │
      │ 2) cat-file -e <base>^   → unreachable-base        │
      │ 3) 四路采集 (defaultExecFile / 注入执行器)          │
      │    committed : diff --name-status -M base..HEAD    │
      │    staged    : diff --name-status -M --cached HEAD │
      │    unstaged  : diff --name-status -M               │
      │    untracked : ls-files --others --exclude-standard│
      └───────────────────┬───────────────────────────────┘
                          │ 每条路径
                          ▼
        parseNameStatus() ──► normChangePath()  (POSIX/去./ /丢越界)
        isWikiProduct()    (判定 .codewiki/ 产物)
                          │
                          ▼
        allSet / deletedSet / renamed[]  去重 (改名两端都留)
        untracked 并入 allSet；删后重建从 deletedSet 摘除
                          │
                          ▼
        sourceChanges = all  − wiki 产物      lib/change-set.js:184
        ignored       = all  ∩ wiki 产物      lib/change-set.js:185
                          │
                          ▼
        ChangeSet { ok, state, fallback, reason, baseCommit, headCommit,
                    committed/staged/unstaged/untracked/deleted/renamed,
                    all, sourceChanges, ignored }   lib/change-set.js:187
                          │
        ┌─────────────────┴──────────────────┐
        ▼                                     ▼
  planUpdate(changeSet, …)                job.changeSet (精简)
        lib/update-planner.js:148          index.js:3622
        (判 write/keep/delete/review,       →
         unmappedChanges, needsFull)        buildUpdateRecord
                                           lib/update-record.js:151
```

降级分支统一先走 `emptyChangeSet`（`lib/change-set.js:73`）再补 `state`/`fallback:'full'`/`reason`，保证 `ok=false` 时调用方**只可能得到 `full` 级别决策**，绝不假装 clean。

## Data Flow

`codewiki_generate` 工具在 `auto`/`stale` 逐篇更新路径上调用本模块（真实链路，无测试桩）：

1. `readCompiledBaseline(wikiPath)`（`index.js:1704`）读 `.codewiki/_meta.yaml:last_compiled_commit` 作为 `baseCommit`；读不到则 `changeSet=null`，由 planner 退文件级。
2. `collectChangeSet(cwd, baseline)`（`index.js:3846` 与 `index.js:3960` 两处）：
   - 成功 → 用 `notes` 记录四路计数（`index.js:3850`）。
   - 失败（`!changeSet.ok`）→ 直接 `return { needFull:true, reason }`（`index.js:3847-3849`），退回全量编译。
3. 成功对象喂给 `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`index.js:3876` 与 `index.js:3973`）。planner 取 `changeSet.sourceChanges`/`deleted`/`renamed`/`untracked` 折算成集合（`lib/update-planner.js:171-175`），产出每篇 `action`：`write`/`keep`/`review`/`delete`，以及 `unmappedChanges`/`needsFull`。
4. `collectChangeSet` 连同 `updatePlan` 一起传给 `svc.submit({ kind:'stale', …, changeSet, updatePlan })`（`index.js:3916`、`index.js:3994`）。`submit` 内部把它精简为 `job.changeSet`（`index.js:3622-3633`，只取 version/state/baseCommit/headCommit/各 bucket 列表，丢弃 all/sourceChanges/ignored）。
5. 终态判定阶段 `tickIndex` 调 `judgeOutcome({ plan: job.updatePlan, … })`（`index.js:3363`），并把 `job.changeSet` 交给 `buildUpdateRecord`（`index.js:2497`）写进 `.codewiki/temp/update-record.json`（`lib/update-record.js:151-169`，记录各 bucket 长度与 `sourceChanges`/`ignored` 清单）。
6. 基线推进闸门：`job.judged.canAdvanceBaseline === true` 才允许 `cw meta update`（`index.js:3399`）；`partial`/`failed` 不推基线——未消化的变化下次编译仍可见。

可机读性：ChangeSet 纯数据、无方法，可直接 `JSON.stringify`/`parse`（`test-change-set.mjs:196-203` 专门断言），因为这要写进 `update-record.json` 复盘。

## Connections

- [[update-planner]] — 核心消费方。`planUpdate`（`lib/update-planner.js:156`）把 `changeSet` 的 `sourceChanges`/`deleted`/`renamed`/`untracked` 折算成判定输入；`cs.sourceChanges` 为空时退化为 `cs.all`（`lib/update-planner.js:172`）。`needsFull` 与 `unmappedChanges` 直接决定能否推进基线。
- [[update-record]] — `buildUpdateRecord`（`lib/update-record.js:131`）把 `job.changeSet` 收编进 `update-record.json`；`judgeOutcome`（`lib/update-record.js:37`）据 `unmappedSourceChanges` 记 `unmapped-changes` 阻塞（阻止基线前移）。
- 编排服务（`index.js`）— `codewiki_generate` 在 `auto`/`stale` 路径调 `collectChangeSet`（`index.js:3846`、`index.js:3791`），`submit`（`index.js:3579`）把精简后的变更集写进 `job`，`tickIndex`/`finishJob` 据此判定终态。
- [[incremental]] — 符号级增量的图快照与文件级降级与本模块四路采集互为补充：本模块负责「文件级发生了什么」，incremental 负责「这些文件里的组件级变更」。planner 里 `!oldGraph || !newGraph` 时退文件级（`lib/update-planner.js:179`）。
- [[engine-contract]] — 终态语义（done/partial/failed/cancelled）与本模块的「采集不可用 ⇒ fallback='full'」一脉相承：任何未消化项都不得把基线前移。

## Known Issues

- **越界路径被静默丢弃**：`normChangePath`（`lib/change-set.js:33-34`）对 `../` 或盘符路径直接返回 `null`，这些路径不会进入 `all`，也不会触发任何告警——若未来出现合法的仓库外引用，会被无声忽略（当前设计上它们本不该出现）。
- **改名检测依赖 `-M` 开关**：四路 `git diff` 都带 `-M`，但 `ls-files --others`（untracked）没有改名概念；若「改名 + 未跟踪」混合出现，改名只对 tracked 文件生效（`lib/change-set.js:151-157`）。
- **「删后重建同名文件」的判定是路径级**：`lib/change-set.js:181` 仅在 untracked 含该路径时从 `deletedSet` 摘除，不做内容比对——同一路径先删文件再新建同名文件会被当作「未删」。
- **降级原因被截断**：除基线不可达错误用 `slice(0, 120)`（`lib/change-set.js:135`）、四路采集整体捕获处未截断（`lib/change-set.js:159`）外，其余 `reason` 经 `String(err.message ?? err).slice(0, 200)`（`lib/change-set.js:119-121, 143`）截断到 200 字符，超长 git 错误细节会丢失。
- **`state:'unknown'` 仅作默认初值**：正常路径不会返回 `unknown`（所有分支都覆盖 state），但 `emptyChangeSet` 默认 `state:'unknown'`，若未来新增分支漏设 state，会把 `ok=false` 与 `unknown` 一起暴露出来。
- 测试覆盖见 `test-change-set.mjs`（P0-1），钉死了 no-git / missing-base / unreachable-base / clean / unstaged / staged / untracked / deleted / renamed / committed / 四路去重 / wiki 产物剔除 / 路径归一 / 注入 execFile / JSON 可序列化共 15 个场景。
