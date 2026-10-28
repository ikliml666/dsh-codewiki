---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - test-change-set.mjs
  - index.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/incremental.js
  - lib/graph-diff.js
tags: [git, change-set, incremental, diff, baseline]
---

## Overview

`lib/change-set.js` 是 dsh-codewiki 增量编译的**变更采集器**。它只做一件事：把一次编译要「看见」的全部代码改动，从 Git 的四个来源（committed / staged / unstaged / untracked）汇总成一个规范化、可 JSON 序列化、可传给下游 planner 的 `ChangeSet` 对象，并在「采不全」时明确暴露降级（用 `state` + `fallback='full'`），让调用方退回全量编译——**绝不假装 clean**。

背景缺陷（注释 lib/change-set.js:1-13 详述）：旧实现 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，导致三类改动完全隐形——(1) 改完代码还没提交（工作区修改）、(2) 只 `git add` 到暂存区没提交、(3) 新建文件还没被跟踪。结果是「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节却一路绿到底。这是融合要修的第一条——**变更不能丢**。

模块只暴露纯函数，唯一的副作用是执行 git 命令（默认 `execFileSync`，可被注入替换以便离线单测，见 lib/change-set.js:15 与 lib/change-set.js:42-49）。产出的 `ChangeSet` 结构既被增量 planner（lib/update-planner.js:148 `planUpdate` 的 `changeSet` 形参）、也被复盘记录（lib/update-record.js `buildUpdateRecord` 的 `changeSet` 形参）消费，并落进 job 摘要（index.js:3622-3633）。

## Key Components

模块文件 `lib/change-set.js` 全部导出/内部符号如下（行号以源码 `行号|` 前缀为准）。

### 常量与导出常量

- `CHANGE_SET_VERSION`（`lib/change-set.js:19`）：版本号常量，当前为 `1`。写入每个 `ChangeSet.version` 字段，供下游/记录做版本校验。
- `WIKI_PRODUCT_PREFIX`（`lib/change-set.js:24`）：字符串 `'.codewiki/'`。wiki 自身产物目录前缀，每次编译都会被重写；把它算成「源码变更」会让增量永远 dirty，且「未映射变更」永远无法清零。
- `WIKI_PRODUCT_PREFIX` 配套判定 `isWikiProduct(relPath)`（`lib/change-set.js:26-29`）：返回 `true` 当且仅当路径等于 `.codewiki` 或以 `.codewiki/` 开头（先把反斜杠归一为 `/`）。README/CHANGELOG/CodeWiki.md 等被文章 `source_files` 引用的文档**不**在此列，仍是合法源码。

### 路径工具

- `normChangePath(p)`（`lib/change-set.js:33-40`）：路径归一。先把反斜杠换成 `/` 并 `trim`；空串返回 `null`；绝对路径（以 `/` 开头）或 Windows 盘符路径（`[A-Za-z]:`）返回 `null`；去掉 `./` 前缀；若含 `../`（开头、中间或整体为 `..`）判为越界，返回 `null`；否则返回归一后的 POSIX 相对路径。越界路径一律丢弃，因为它们不该出现在变更集里。

### diff 解析

- `parseNameStatus(out)`（`lib/change-set.js:52-71`）：解析 `git diff --name-status` 的输出。逐行 `split(/\r?\n/)`，按 `\t` 切分；首字段 `code` 以 `R`/`C` 开头的，取 `parts[1]` 为 from、`parts[2]` 为 to（均经 `normChangePath`），`R` 记为 `renamed`、`C` 记为 `copied`；其余 `D` 记为 `deleted`，否则 `modified`。每条 entry 形如 `{ kind, path }`（rename/copy 多一个 `from`），`status` 保留原始状态码。非法路径直接跳过。

### 内部辅助

- `defaultExecFile(cwd)`（`lib/change-set.js:42-49`）：默认 git 执行器工厂，返回 `(cmd, args) => execFileSync(cmd, args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'], maxBuffer:16*1024*1024 })`。真实链路用它；测试注入假执行器。
- `emptyChangeSet(baseCommit, overrides)`（`lib/change-set.js:73-93`）：构造一个「失败/未采全」的 `ChangeSet` 骨架（见下方字段表），仅 `baseCommit` 与传入的 `overrides` 有意义，其余数组为空、`ok=false`、`state='unknown'`、`fallback=null`。所有降级返回路径都通过它 + `overrides` 产出。
- `collect(cwd, baseCommit, opts)` 内的局部闭包 `collect(label, args)`（`lib/change-set.js:141-145`）：四路采集的薄封装，调用 `parseNameStatus(git(args))`，抛错时带 `label` 前缀重抛，便于定位是哪一路失败。

### 主入口

- `collectChangeSet(cwd, baseCommit, opts = {})`（`lib/change-set.js:102-205`）：变更采集主函数。参数：
  - `cwd`：仓库工作目录；
  - `baseCommit`：上次成功编译的基线 commit（对应 `.codewiki/_meta.yaml:last_compiled_commit`），空串直接返回 `missing-base` 降级（lib/change-set.js:104-106）；
  - `opts.execFile`：可选注入执行器 `(cmd, args) => stdout`，不传则用 `defaultExecFile(cwd)`（lib/change-set.js:107-108）。
  返回 `ChangeSet`（成功或降级结构一致，见下方字段表）。详细步骤见 [[architecture]] 与 [[data-flow]]。

### ChangeSet 数据结构（对象字段）

`collectChangeSet` 返回的对象（成功态由 lib/change-set.js:102-205 构造；降级态由 `emptyChangeSet` lib/change-set.js:73-93 构造）字段如下：

| 字段 | 类型 | 含义 / 赋值位置 |
| --- | --- | --- |
| `version` | number | `CHANGE_SET_VERSION`（lib/change-set.js:19,188） |
| `ok` | boolean | 是否采集成成功可用；降级态 `false`（lib/change-set.js:76,189） |
| `state` | string | 状态机：`'ok'` / `'missing-base'` / `'no-git'` / `'git-error'` / `'unreachable-base'` / `'unknown'`（lib/change-set.js:77,118-124,131,159,190） |
| `fallback` | string\|null | 降级时为 `'full'`，表示调用方应退回全量编译；成功时 `null`（lib/change-set.js:78,105,119,121,124,131,159,191） |
| `reason` | string | 降级/失败原因文案；成功时为空（lib/change-set.js:79,119-135,159,192） |
| `baseCommit` | string | 传入并 `String(...)` 化后的基线 commit（lib/change-set.js:80,193） |
| `headCommit` | string | `git rev-parse HEAD` 输出；降级在无 HEAD 时为空（lib/change-set.js:81,114,134,194） |
| `committed` | array | `base..HEAD` 已提交变更 entries（已剔除 wiki 产物），每项 `{kind,path,status,bucket}`（lib/change-set.js:82,151,195） |
| `staged` | array | `--cached HEAD` 暂存区变更 entries（剔除 wiki 产物）（lib/change-set.js:83,152,196） |
| `unstaged` | array | 工作区未提交修改 entries（剔除 wiki 产物）（lib/change-set.js:84,153,197） |
| `untracked` | array | `ls-files --others --exclude-standard` 未跟踪新文件路径（剔除 wiki 产物）（lib/change-set.js:85,154-157,198） |
| `deleted` | array | 被删除的路径集合（剔除 wiki 产物，且「已删又重建同名」的会从集合中剔除）（lib/change-set.js:86,164,170-181,199） |
| `renamed` | array | 改名条目 `{from, path, bucket}`（剔除 wiki 产物）（lib/change-set.js:87,171-174,200） |
| `all` | array | 全部受影响路径去重排序（**含** wiki 产物路径，是原始全量）（lib/change-set.js:88,163-183,201） |
| `sourceChanges` | array | `all` 中剔除 wiki 产物后的源码变更集合（lib/change-set.js:184,202） |
| `ignored` | array | `all` 中属于 wiki 产物的路径（被记账但不算源码变更）（lib/change-set.js:185,203） |

> 注意：`committed/staged/unstaged/untracked/deleted/renamed` 在四路阶段里额外打了 `bucket` 字段（lib/change-set.js:175），标记每条改动来自哪一桶；该字段用于 planner 归因，但不进入 `all`。`all` 与 `sourceChanges/ignored` 的划分以 `isWikiProduct` 为准（lib/change-set.js:184-185）。

## Architecture

`collectChangeSet` 内部是一条「先探 HEAD/基线可达性，再四路采集，最后分类去重」的线性流水线。组件数 ≥3、流程非平凡，框图如下（框内标注函数/类与文件位置）：

```text
             cwd, baseCommit
   ┌─────────────────────────────────────┐
   │ collectChangeSet()                   │  lib/change-set.js:102
   │                                       │
   │  ①  base 空？ ─► missing-base        │  :104-106
   │  ②  rev-parse HEAD ──┬─ 失败 ─► no-git│  :113-122
   │  ③  cat-file 基线可达？ ─ 否 ─►        │  :128-137
   │            unreachable-base          │
   │                                       │
   │  ④ 四路采集 (defaultExecFile/execFile) │  :141-160
   │     ┌──────┬────────┬────────┬───────┐│
   │     │committed│staged│unstaged│untracked│ :151-157
   │     └───┬────┴───┬────┴───┬────┴───┬──┘│
   │      parseNameStatus()  (①②③④ 全程)  │  :52
   │         normChangePath / isWikiProduct│  :33 / :26
   │                                       │
   │  ⑤ 分类去重 + 删除/改名归并           │  :163-185
   │     all / sourceChanges / ignored     │
   └───────────────────┬───────────────────┘
                       ▼
              ChangeSet { ok,state,
              fallback,committed,staged,
              unstaged,untracked,deleted,
              renamed,all,sourceChanges,
              ignored }  ──► 下游
                       ┌──────────────────────┐
                       │ planUpdate(changeSet) │ lib/update-planner.js:156
                       │ buildUpdateRecord(..) │ lib/update-record.js
                       │ job.changeSet (index:3622) │
                       └──────────────────────┘
```

降级（②④ 任意一步失败）统一经 `emptyChangeSet` + `overrides` 产出，且 `fallback='full'`（lib/change-set.js:73,119,121,124,131,159）。框图里①②③④ 是按顺序短路的守卫：任一守卫失败立即返回降级 `ChangeSet`，不再继续后续采集——保证「采不全 = 显式降级」，而非隐性干净。

## Data Flow

以增量编译（stale/auto）的一次调用为例，数据从源头到 `ChangeSet` 的流向（`index.js` 调用链，行号见下）：

1. **基线读取**：`readCompiledBaseline(wikiPath)`（index.js:1704-1712）从 `.codewiki/_meta.yaml` 的正则 `^last_compiled_commit:\s*(\S+)` 取出上次编译基线 commit。读不到返回 `null`。

2. **采集触发**：当基线存在时，`runStaleUpdate` 内调用 `collectChangeSet(cwd, baseline)`（index.js:3843-3846）。拿不到基线时跳过采集、改用文件级退化（index.js:3835-3837）。

3. **内部四路采集**（lib/change-set.js:141-160，均走注入或默认的 `execFile`）：
   - `committed`：`git diff --name-status -M <base>..<HEAD>`（lib/change-set.js:151）
   - `staged`：`git diff --name-status -M --cached HEAD`（lib/change-set.js:152）
   - `unstaged`：`git diff --name-status -M`（lib/change-set.js:153）
   - `untracked`：`git ls-files --others --exclude-standard`，逐行 `normChangePath`（lib/change-set.js:154-157）
   - `-M` 打开改名检测，避免改名被拆成「删+加」让 planner 看不出同一份内容换了位置（lib/change-set.js:139-140）。

4. **分类与去重**（lib/change-set.js:163-185）：
   - 遍历 `committed/staged/unstaged` 三桶，每条打 `bucket` 字段（lib/change-set.js:175）；`deleted` 进 `deletedSet`、`renamed` 进 `renamed` 且把 from 也加进 `allSet`（lib/change-set.js:169-174）。
   - `untracked` 直接并入 `allSet`（lib/change-set.js:178）。
   - 「已删又重建同名」：若某删除路径同时出现在 `untracked`，从 `deletedSet` 剔除，避免 planner 给一篇仍存在的文件排 `delete` action（lib/change-set.js:179-181）。
   - `all = [...allSet].sort()`（lib/change-set.js:183）；`sourceChanges = all.filter(!isWikiProduct)`、`ignored = all.filter(isWikiProduct)`（lib/change-set.js:184-185）。
   - 各分类数组（committed/staged/unstaged/untracked/deleted/renamed）再各经 `isWikiProduct` 过滤掉 wiki 产物后输出（lib/change-set.js:195-200）。

5. **产物落点**：成功 `ChangeSet`（`ok=true, state='ok'`）被 `runStaleUpdate` 传给 `planUpdate({ changeSet, ... })`（index.js:3876），并作为 `changeSet`/`updatePlan` 实参随 `svc.submit({ kind:'stale', changeSet, updatePlan })`（index.js:3916）进入 job；`submit` 内把它的核心字段抄进 `job.changeSet`（index.js:3622-3633）。`{handled:true}` 分支的 `needFull:true` 在 `!changeSet.ok` 或 `plan.needsFull` 时触发（index.js:3847-3849, 3880-3882）。

判定语义要点：
- `missing-base`：base 为空（index.js 调 `collectChangeSet(cwd, '')` 时，lib/change-set.js:102-104）。
- `no-git`：`rev-parse HEAD` 失败且 `rev-parse --is-inside-work-tree` 不为 `'true'`（lib/change-set.js:117-120）。
- `git-error`：`rev-parse HEAD` 失败但处在 git 仓库内，或四路采集抛错（lib/change-set.js:118-124,158-159）。
- `unreachable-base`：基线 commit 经 `cat-file -e <base>^{commit}` 探测不在历史里（lib/change-set.js:128-137）。
- 以上任一降级都带 `fallback='full'`，调用方据此退回全量编译，且**不会**前移编译基线。

## Connections

- [[update-planner]]：下游核心消费者。`planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（lib/update-planner.js:156）以 `ChangeSet` 为输入，把「哪篇要写/keep/review/delete、哪些变化没人认领（unmappedChanges）」算出来；`changeSet.ok===false` 或 `plan.needsFull` 时调用方退回全量（index.js:3847-3849, 3880-3882）。改名信息（`renamed`）还被 `scanStaleArticle` 的 `renamedComponents` 用于死链/stale 扫描（lib/update-planner.js:106-145）。
- [[update-record]]：`buildUpdateRecord({ changeSet, plan, results, outcome, ... })`（lib/update-record.js）把 `ChangeSet` 收进版本化复盘记录；增量完整性判定（done/partial/failed）依赖 changeSet 暴露的未映射变更。`saveRecord`（index.js:2495-2517）在 job 收尾时调用它。
- [[incremental]]：编译基线 `last_compiled_commit` 的读取（`readCompiledBaseline`，index.js:1704）与符号快照比对（`loadSnapshot`/`graphFromSnapshot`，index.js:3863-3871）同源。本模块只负责「采」，不负责「比」——符号级 diff 由 lib/incremental.js 与 lib/graph-diff.js 完成。
- index.js 编排层：`codewiki_generate` → `runStaleUpdate`（index.js:3835-3939）是变更采集的唯一切入点；`submit` 把 `changeSet` 抄进 `job.changeSet`（index.js:3622-3633），`jobSummary`（index.js:2206-2216）再透出给面板与 `codewiki_progress`。

## Known Issues

- **降级一律退回 full，无部分回退**：当任一守卫失败（`no-git` / `git-error` / `unreachable-base` / `missing-base`）时 `fallback='full'`，调用方会丢弃所有已采集到的四路信息、走全量重编（lib/change-set.js:104-160）。这是有意保守（不假装 clean），代价是少数学坏 git 状态的仓库会触发全量——目前无「partial change-set」模式。
- **「已删又重建同名」仅按路径名判**：lib/change-set.js:179-181 用 `untracked.includes(p)` 做集合判断，依据是文件名匹配而非内容/类型比对。若删除的路径是目录、重建的是同名文件（或反之），仍按路径名去重，可能漏判一次真实的 delete+add。属边界情况，尚未在测试中覆盖。
- **`all` 含 wiki 产物但各分类已剔除**：`all` 保留 `.codewiki/*` 路径（lib/change-set.js:183），而 `committed/staged/.../renamed` 与 `sourceChanges` 已过滤掉它们（lib/change-set.js:184-200）。下游若误用 `all` 当源码清单会重复处理 wiki 产物；正确来源应是 `sourceChanges`。
- **rename/copy 的两列路径依赖 `git --name-status` 列数**：`parseNameStatus`（lib/change-set.js:52-56）假定 rename/copy 输出为 `Rxx\tfrom\tto` 三列；若 `core.quotePath` 对含特殊字符路径加引号并在 `parts` 切割后带引号，归一化仅做反斜杠替换与 `./` 剥离（lib/change-set.js:57-60），不去除引号——极端路径可能残留引号字符（当前 `normChangePath` 未处理引号剥离）。
- **无符号级/内容级语义**：本模块只做「文件级」变更采集，不解析文件内容、不建依赖边。符号级「被依赖方变了→使用方文章要重写」由 [[update-planner]] 借助 [[incremental]] 的符号图完成；当 `symbolIncremental` 关闭或符号提取不可用时，planner 退化为纯文件级判定（index.js:3862-3873）。
- **测试用临时 git 仓库**：`test-change-set.mjs` 每个场景 `git init` 独立临时仓库（test-change-set.mjs:23-42），覆盖四路采集、改名、降级、wiki 产物过滤、POSIX 归一、execFile 注入与 JSON 可序列化（test-change-set.mjs:47-203）；但未覆盖「目录删除+同名文件重建」与跨 worktree 场景。
