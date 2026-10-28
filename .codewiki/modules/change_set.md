---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - test-change-set.mjs
tags: [git, incremental, change-collection, wiki]
---

## Overview

`change_set`（源码 `lib/change-set.js`）是 dsh-codewiki 的「变更采集」模块，负责在每次编译前，把一个仓库里**所有**可能影响 wiki 文章的改动收集成一个规范化、可序列化的对象——`ChangeSet`。

背景缺陷（已在文件头注释确认，见 `lib/change-set.js:1-13`）：旧实现 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是三类改动对它完全隐形——（1）改完代码还没提交的工作区修改；（2）只 `git add` 到暂存区没提交的部分；（3）新建但还没被 git 跟踪的文件。结果「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节却一路绿到底。`change_set` 是把「增量漏检」这条缺陷钉死的第一环。

模块职责只有一件事（`lib/change-set.js:11-13`）：把 **committed / staged / unstaged / untracked** 四路改动收成一个 `ChangeSet`，并把「采不全」的情形明确暴露出来——返回 `state` + `fallback='full'`，让调用方退回全量编译，**绝不假装 clean**。

核心设计取舍：
- 路径一律归一为 POSIX 相对路径，越界路径（绝对路径、`../` 跳出）直接丢弃（`normChangePath`，`lib/change-set.js:33-40`）。
- wiki 自身产物目录 `.codewiki/`（以及顶层 `.codewiki`）不当作源码变更，否则增量永远 dirty、且「未映射变更」永远无法清零；但 README/CHANGELOG/CodeWiki.md 这类被文章 `source_files` 引用的文档仍是合法源码（`isWikiProduct`，`lib/change-set.js:24-29`、`184-185`）。
- 真实链路用 `execFileSync`，但 `collectChangeSet` 通过依赖注入 `opts.execFile` 接收执行器，便于离线单测（`lib/change-set.js:15`、`107`）。

## Key Components

本模块只含一个源文件 `lib/change-set.js`，全部为纯函数（除内部默认执行器封装）。以下按「常量 → 工具函数 → 解析器 → 采集入口」顺序列出公开 API。

### 常量与私有辅助

- `CHANGE_SET_VERSION = 1`（导出常量，`lib/change-set.js:19`）——`ChangeSet.version` 的当前版本号，写进记录做机读版本化。
- `WIKI_PRODUCT_PREFIX = '.codewiki/'`（私有常量，`lib/change-set.js:24`）——wiki 自身产物目录前缀，用于区分「产物」与「源码」。
- `defaultExecFile(cwd)`（私有函数，`lib/change-set.js:42-49`）——真实执行器工厂：返回 `(cmd, args) => execFileSync(cmd, args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'], maxBuffer:16*1024*1024 })`。

### 公开函数

- `isWikiProduct(relPath)`（`lib/change-set.js:26-29`）
  - 用途：判断一个相对路径是不是 wiki 自身产物。
  - 逻辑：`p === '.codewiki'` 或 `p.startsWith('.codewiki/')` 即判真；入参先 `replace(/\\/g,'/')` 归一。
  - 注意：README/CHANGELOG/CodeWiki.md 等被 `source_files` 引用的文档**不**在此列，仍算源码。

- `normChangePath(p)`（`lib/change-set.js:33-40`）
  - 用途：路径归一与越界过滤。
  - 逻辑：先把 `\` 换 `/` 并 `trim`；空串返回 `null`；以 `/` 开头或 `^[A-Za-z]:`（Windows 盘符）开头的绝对路径返回 `null`；去掉 `./` 前缀；若含 `../`（开头、中间或整串 `..`）返回 `null`。否则返回归一后的相对路径。

- `parseNameStatus(out)`（`lib/change-set.js:52-71`）
  - 用途：解析 `git diff --name-status` 的输出。
  - 入参 `out` 为命令 stdout 字符串，按 `\r?\n` 切行，每行 `split('\t')`。
  - 首列 `code`：`R`（rename）/ `C`（copy）两列路径，分别记 `renamed` / `copied`，保留 `from` 与 `path`（到），并带上原始 `status`；`D` 记 `deleted`，其余 `M`/`A`/… 记 `modified`，只留 `path`。每条经 `normChangePath` 过滤越界路径。
  - 返回 `entries: [{ kind, path, status, from? }]`。

- `emptyChangeSet(baseCommit, overrides = {})`（私有函数，`lib/change-set.js:73-93`）
  - 用途：构造一个「采集失败」的空 `ChangeSet` 骨架，所有字段默认值如下，`overrides` 可覆盖：
    ```
    version: CHANGE_SET_VERSION, ok:false, state:'unknown', fallback:null, reason:'',
    baseCommit: String(baseCommit ?? ''), headCommit:'',
    committed:[], staged:[], unstaged:[], untracked:[],
    deleted:[], renamed:[], all:[], sourceChanges:[], ignored:[]
    ```

- `collectChangeSet(cwd, baseCommit, opts = {})`（`lib/change-set.js:102-205`）——**唯一入口**。
  - 参数：
    - `cwd`：仓库工作目录。
    - `baseCommit`：上次成功编译的基线 commit（来自 `.codewiki/_meta.yaml:last_compiled_commit`）。
    - `opts.execFile(cmd, args) -> stdout`：可选执行器注入；抛错表示该命令失败。缺省用 `defaultExecFile(cwd)`。
  - 返回值：`ChangeSet`（结构见下）。`ok=false` 时必带 `state` 与 `reason`，且 `fallback='full'`。

### ChangeSet 结构（成功态，`lib/change-set.js:187-204`）

成功采集返回的对象全部字段如下（字段名 → 含义）：

| 字段 | 类型 | 含义 |
|------|------|------|
| `version` | number | 恒为 `CHANGE_SET_VERSION`（1） |
| `ok` | boolean | `true` 表示成功采集 |
| `state` | string | 成功时 `'ok'` |
| `fallback` | null | 成功态无降级 |
| `reason` | string | 成功态为空串 |
| `baseCommit` | string | 基线 commit |
| `headCommit` | string | `git rev-parse HEAD` 的当前 HEAD |
| `committed` | array | `base..HEAD` 的改动条目（`kind/path/status`，已剔除 `.codewiki` 产物） |
| `staged` | array | 暂存区改动（`--cached HEAD`，已剔除产物） |
| `unstaged` | array | 工作区未提交改动（已剔除产物） |
| `untracked` | array | 未跟踪新文件相对路径（已剔除产物） |
| `deleted` | array | 被删路径（已剔除产物、已剔除「又重建」者），排序 |
| `renamed` | array | `{ from, path, bucket }`（已剔除产物），`bucket` 标记来源桶 |
| `all` | array | 全部变化路径的并集（含改名两端），**排序** |
| `sourceChanges` | array | `all` 中过滤掉 wiki 产物后的「真实源码/文档」变化 |
| `ignored` | array | `all` 中被判为 wiki 产物的路径，排序 |

`all` 的关键语义（`lib/change-set.js:162-185`）：改名时两端（旧路径与新路径）都进 `all`，因为旧路径从「被谁引用」角度同样是变化；同一路径既删又重建（删了又新建同名文件）时，从 `deleted` 中剔除，避免 planner 为一篇还在的文件安排 delete action（`lib/change-set.js:179-181`）。`all` 与 `sourceChanges`/`ignored` 的划分依据是 `isWikiProduct`（`lib/change-set.js:184-185`）。

### 降级语义（失败态 `state` 取值）

`collectChangeSet` 在以下情形返回 `ok:false` 且 `fallback:'full'`（均经 `emptyChangeSet`，`lib/change-set.js:104-159`）：

| `state` | 触发条件 | 代码位置 |
|---------|----------|----------|
| `missing-base` | `baseCommit` 为空（无法计算增量） | `lib/change-set.js:104-106` |
| `no-git` | `rev-parse HEAD` 失败且 `--is-inside-work-tree` 不为 `true` | `lib/change-set.js:118-119` |
| `git-error` | `rev-parse HEAD` 失败但仍在 git 工作树，或 `rev-parse HEAD` 无输出 | `lib/change-set.js:121-124` |
| `unreachable-base` | 基线 commit 被 rebase/GC 掉（`cat-file -e base^{commit}` 失败） | `lib/change-set.js:128-137` |
| `git-error` | 四路采集任一 `git` 命令抛错（含 `ls-files`） | `lib/change-set.js:158-159` |

调用方约定（`lib/change-set.js:100-101`）：`ok=false` 时一定带 `state` 与 `reason`，且 `fallback='full'`——据此退回全量编译；**不许把「采不到」当成「没变化」**。

## Architecture

该模块只有 4 个公开纯函数 + 1 个私有工厂 + 2 个常量，逻辑扁平、无副作用（除注入的 `execFile`）。下面是「四路采集 → 归一/解析 → 分类去重 → 分离 wiki 产物」的框图：

```text
            git repo (cwd) + baseCommit (from _meta.yaml)
                          │
                          ▼
   collectChangeSet(cwd, baseCommit, {execFile})   lib/change-set.js:102
                          │
  ┌───────────────────────┴───────────────────────────────┐
  │ 1) rev-parse HEAD          → no-git / git-error        │
  │ 2) cat-file -e <base>^     → unreachable-base          │
  │ 3) 四路采集 (defaultExecFile / 注入执行器)              │
  │    committed : diff --name-status -M base..HEAD        │
  │    staged    : diff --name-status -M --cached HEAD     │
  │    unstaged  : diff --name-status -M                   │
  │    untracked : ls-files --others --exclude-standard    │
  └───────────────────────┬───────────────────────────────┘
                          │ 每条路径
                          ▼
   parseNameStatus() ──► normChangePath()  (POSIX / 去 ./ / 丢越界)
   isWikiProduct()    (判定 .codewiki/ 产物)
                          │
                          ▼
   allSet / deletedSet / renamed[]   去重(改名两端都留)
   untracked 并入 allSet；删后重建从 deletedSet 摘除
                          │
                          ▼
   sourceChanges = all  − wiki 产物      lib/change-set.js:184
   ignored       = all  ∩ wiki 产物      lib/change-set.js:185
                          │
                          ▼
   ChangeSet { version, ok, state, fallback, reason, baseCommit, headCommit,
               committed/staged/unstaged/untracked/deleted/renamed,
               all, sourceChanges, ignored }   lib/change-set.js:187
                          │
                          ▼
                交给 update-planner / update-record
```

降级分支统一先走 `emptyChangeSet`（`lib/change-set.js:73`）再补 `state`/`fallback:'full'`/`reason`，保证 `ok=false` 时调用方**只可能得到 `full` 级别决策**，绝不假装 clean。

## Data Flow

`codewiki_generate` 工具在 `auto`/`stale` 逐篇更新路径上调用本模块（真实链路，无测试桩）：

1. `readCompiledBaseline(wikiPath)`（位于 `index.js` 的编排逻辑）读 `.codewiki/_meta.yaml:last_compiled_commit` 作为 `baseCommit`；读不到则 `changeSet=null`，由 planner 退文件级。
2. `collectChangeSet(cwd, baseline)`（`index.js:4133` 与 `index.js:4247` 两处）：
   - 成功 → 用 `notes` 记录四路计数（`index.js:4090`）。
   - 失败（`!changeSet.ok`）→ 直接 `return { needFull:true, reason }`（`index.js:4134-4136`、`index.js:4248-4249`），退回全量编译。
3. 成功对象喂给 `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`index.js:4163` 与 `index.js:4259`）。planner 取 `changeSet.sourceChanges`/`deleted`/`renamed`/`untracked` 折算成集合（`lib/update-planner.js` 的 `planUpdate`），产出每篇 `action`：`write`/`keep`/`review`/`delete`，以及 `unmappedChanges`/`needsFull`。
4. `collectChangeSet` 连同 `updatePlan` 一起传给 `svc.submit({ kind:'stale', …, changeSet, updatePlan })`（`index.js:3876`）。`submit` 内部把它精简为 `job.changeSet`（只取 version/state/baseCommit/headCommit/各 bucket 列表，丢弃 all/sourceChanges/ignored）。
5. 终态判定阶段把 `job.changeSet` 交给 `buildUpdateRecord`（`lib/update-record.js`）写进 `.codewiki/temp/update-record.json`。
6. 基线推进闸门：`job.judged.canAdvanceBaseline === true` 才允许 `cw meta update`；`partial`/`failed` 不推基线——未消化的变化下次编译仍可见（`index.js:4122-4129` 的 `runStaleUpdate` 注释与 `4126-4137` 的采集段）。

可机读性：ChangeSet 纯数据、无方法，可直接 `JSON.stringify`/`parse`（`test-change-set.mjs:196-203` 专门断言），因为这要写进 `update-record.json` 复盘。

## Connections

- [[update-planner]] — 核心消费方。`planUpdate` 把 `changeSet` 的 `sourceChanges`/`deleted`/`renamed`/`untracked`/`all` 折算成判定输入；`needsFull` 与 `unmappedChanges` 直接决定能否推进基线。
- [[update-record]] — `buildUpdateRecord` 把 `job.changeSet` 收编进 `update-record.json`；`judgeOutcome` 据未映射变更记阻塞（阻止基线前移）。
- 编排服务（`index.js`）— `codewiki_generate` 在 `auto`/`stale` 路径调 `collectChangeSet`（`index.js:4088`、`index.js:4078`），`submit` 把精简后的变更集写进 `job`。
- [[incremental]] — 符号级增量的图快照与文件级降级与本模块四路采集互为补充：本模块负责「文件级发生了什么」，incremental 负责「这些文件里的组件级变更」。
- [[engine-contract]] — 终态语义（done/partial/failed/cancelled）与本模块的「采集不可用 ⇒ fallback='full'」一脉相承：任何未消化项都不得把基线前移。

## Known Issues

- **越界路径被静默丢弃**：`normChangePath`（`lib/change-set.js:33-40`）对 `../` 或盘符路径直接返回 `null`，这些路径不会进入 `all`，也不会触发任何告警——若未来出现合法的仓库外引用，会被无声忽略（当前设计上它们本不该出现）。
- **改名检测依赖 `-M` 开关**：四路 `git diff` 都带 `-M`，但 `ls-files --others`（untracked）没有改名概念；若「改名 + 未跟踪」混合出现，改名只对 tracked 文件生效（`lib/change-set.js:151-157`）。
- **「删后重建同名文件」的判定是路径级**：`lib/change-set.js:181` 仅在 untracked 含该路径时从 `deletedSet` 摘除，不做内容比对——同一路径先删文件再新建同名文件会被当作「未删」。
- **降级原因被截断**：除基线不可达错误用 `slice(0, 120)`（`lib/change-set.js:135`）外，其余 `reason` 经 `String(err.message ?? err).slice(0, 200)`（`lib/change-set.js:119-121, 143`）截断到 200 字符，超长 git 错误细节会丢失；四路采集整体捕获处（`lib/change-set.js:159`）未截断。
- **`state:'unknown'` 仅作默认初值**：正常路径不会返回 `unknown`（所有分支都覆盖 state），但 `emptyChangeSet` 默认 `state:'unknown'`（`lib/change-set.js:73`），若未来新增分支漏设 state，会把 `ok=false` 与 `unknown` 一起暴露出来。
- 测试覆盖见 `test-change-set.mjs`（P0-1，1–209 行），钉死了 no-git / missing-base / unreachable-base / clean / unstaged / staged / untracked / deleted / renamed / committed / 四路去重 / wiki 产物剔除 / 路径归一 / 注入 execFile / JSON 可序列化共 15 个场景。
