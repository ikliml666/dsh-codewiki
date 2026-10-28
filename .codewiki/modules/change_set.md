---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - test-change-set.mjs
  - lib/update-planner.js
  - index.js
tags: [git, change-set, incremental, path-normalization]
---



## Overview

`lib/change-set.js` 的职责只有一件事：把一次编译要「看见」的全部 git 改动，从四路来源收成一个**规范化、可序列化**的 `ChangeSet`，并把「采不全」的情形用 `state` + `fallback='full'` 明确暴露出来，绝不让调用方把「采不到」当成「没变化」。

背景缺陷（见模块头注释 `lib/change-set.js:1-15` 与 `index.js:3839-3842`）：旧版 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是三类改动对它完全隐形——

1. 改完代码**还没提交**（工作区 unstaged 修改）；
2. 只 `git add` 到暂存区没提交（staged）；
3. 新建文件还没被跟踪（untracked）。

结果「改完代码就编译」会把未消化的变化当成已消化（基线被前移），文章与源码脱节却一路绿到底——这是审计确认的「增量漏检」，本次融合要修的第一条。

本模块因此采集四路：`committed`（`base..HEAD`）、`staged`（`--cached HEAD`）、`unstaged`（工作区）、`untracked`（`ls-files --others`）。所有路径统一规范化为 POSIX 相对路径、越界路径直接丢弃；`.codewiki/` 自身产物（每次编译都被重写）单独记到 `ignored`，不混入 `sourceChanges`。

依赖通过 `opts.execFile` 注入（默认 `execFileSync`），以便离线单测（`test-change-set.mjs:177-194` 用假执行器覆盖四条 git 命令）。

## Key Components

### 常量

- `CHANGE_SET_VERSION`（`lib/change-set.js:19`）— 变更集版本号，当前为 `1`，写入 `ChangeSet.version` 供下游与序列化后比对。
- `WIKI_PRODUCT_PREFIX`（`lib/change-set.js:24`）— 字符串 `'.codewiki/'`，wiki 自身产物目录前缀（每次编译被重写，算进源码变更会让增量永远 dirty）。

### 公开函数

- `isWikiProduct(relPath)`（`lib/change-set.js:26-29`）— 判断某相对路径是否为 wiki 自身产物：`relPath === '.codewiki'` 或 `startsWith('.codewiki/')`（先 `\`→`/` 归一）。`README`/`CHANGELOG`/`CodeWiki.md` 这类被文章 `source_files` 引用的文档**不**算 wiki 产物。
- `normChangePath(p)`（`lib/change-set.js:33-40`）— 路径归一与越界过滤：
  - `\`→`/` 替换并 `trim`；空串返回 `null`；
  - 绝对路径（`/...`）或盘符路径（`C:`/`D:` 等）返回 `null`；
  - 去掉 `./` 前缀；`../` 起头、含 `/../`、或整串是 `..` 的越界路径返回 `null`；
  - 否则返回规范化相对路径。
- `parseNameStatus(out)`（`lib/change-set.js:52-71`）— 解析 `git diff --name-status` 文本。逐行 trim 后以 `\t` 切分：
  - `R`/`C` 开头：记 `{ kind: 'renamed'|'copied', from: normChangePath(parts[1]), path: normChangePath(parts[2]), status: code }`（`from`/`to` 任一归一失败则跳过该条目）；
  - `D` 开头：`{ kind: 'deleted', path, status }`；
  - 其余：`{ kind: 'modified', path, status }`。
  - 返回 entries 数组；空行跳过，路径归一失败跳过。
- `collectChangeSet(cwd, baseCommit, opts = {})`（`lib/change-set.js:102-205`）— 模块主入口，采集并返回 `ChangeSet`。详见下节与 Data Flow。

### 内部辅助

- `defaultExecFile(cwd)`（`lib/change-set.js:42-49`）— 默认 git 执行器：`(cmd, args) => execFileSync(cmd, args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'], maxBuffer: 16*1024*1024 })`。
- `emptyChangeSet(baseCommit, overrides = {})`（`lib/change-set.js:73-93`）— 构造一个全字段为「空/降级」的 ChangeSet 骨架（见下表全部字段），再用 `overrides` 覆盖为具体降级原因。所有降级分支都经它返回，`ok` 默认 `false`、`fallback` 默认 `null`、各 bucket 默认 `[]`。

### ChangeSet 结构（返回对象全部字段）

`collectChangeSet` 成功时直接组装（`lib/change-set.js:102-119`），失败时由 `emptyChangeSet` 给出相同字段形状（`lib/change-set.js:73-93`）。字段如下：

| 字段 | 类型 | 含义 / 来源 |
| --- | --- | --- |
| `version` | number | `CHANGE_SET_VERSION`（当前 `1`） |
| `ok` | boolean | 采集是否成功；失败时 `false` 且必带 `state`+`reason`+`fallback='full'` |
| `state` | string | 见下「state 取值」表 |
| `fallback` | string\|null | 降级时 `'full'`（退回全量编译）；成功时 `null` |
| `reason` | string | 降级/错误信息；成功时 `''` |
| `baseCommit` | string | 传入的编译基线 commit |
| `headCommit` | string | `git rev-parse HEAD` 结果；判定失败时可能为空串 |
| `committed` | array | `base..HEAD` 已提交变更条目（`{kind, path, status}`），已过滤 wiki 产物 |
| `staged` | array | 暂存区变更条目，已过滤 wiki 产物 |
| `unstaged` | array | 工作区未提交变更条目，已过滤 wiki 产物 |
| `untracked` | string[] | 未跟踪新文件路径（字符串数组），已过滤 wiki 产物 |
| `deleted` | string[] | 被删除文件的相对路径（已按 `untracked` 去「删后重建同名」），已过滤 wiki 产物 |
| `renamed` | array | `[{ from, path, bucket }]`，文件级改名/复制（`bucket` 标记来自哪个来源），已过滤 wiki 产物 |
| `all` | string[] | 上述所有路径的**去重并集**，按字典序排序；改名两端都在内 |
| `sourceChanges` | string[] | `all` 中**非 wiki 产物**的部分（真实源码/文档变更） |
| `ignored` | string[] | `all` 中**属于 wiki 产物**的部分（`.codewiki/...`），按字典序排序 |

`committed`/`staged`/`unstaged` 中「改名」类条目额外带 `from` 与 `bucket`（`lib/change-set.js:171-175`，`bucket ∈ {'committed','staged','unstaged'}`）。

### `state` 取值

| state | 触发位置 | 含义 / 降级 |
| --- | --- | --- |
| `unknown` | `emptyChangeSet` 默认（`lib/change-set.js:73`） | 骨架初值，正常流程会被覆盖 |
| `missing-base` | `lib/change-set.js:105` | `baseCommit` 为空/不存在，无法计算增量 |
| `no-git` | `lib/change-set.js:119` | `rev-parse HEAD` 失败且 `--is-inside-work-tree` 非 `true`（根本不是 git 仓库） |
| `git-error` | `lib/change-set.js:121,124,159` | git 命令失败（仓库存在但命令出错/无输出/四路采集抛错） |
| `unreachable-base` | `lib/change-set.js:131-136` | 基线 commit 不在历史里（`cat-file -e base^{commit}` 失败，被 rebase/GC 掉） |
| `ok` | `lib/change-set.js:190` | 四路采集成功 |

所有非 `ok` 的 state 都对应 `ok=false` 且 `fallback='full'`（除 `missing-base` 在 `emptyChangeSet` 中一并设了 `fallback:'full'`），调用方据此退回全量编译。

## Architecture

四路采集由单一 `collectChangeSet` 驱动，路径经 `normChangePath` 归一后汇入 `all` 并集，再用 `isWikiProduct` 切分 source/ignored：

```text
              cwd + baseCommit + opts.execFile
                         │
                         ▼
              collectChangeSet  (lib/change-set.js:102)
                         │
       ┌─────────────────┼──────────────────────┬───────────────────┐
       ▼                 ▼                       ▼                   ▼
 rev-parse HEAD    cat-file -e base^{commit}   diff --name-status   ls-files --others
 (no-git/git-error) (unreachable-base)          -M (×3, parseNameStatus) (untracked)
       │                 │                       │                   │
       │                 │                       ▼                   │
       │                 │                  parseNameStatus          │
       │                 │                  (lib/change-set.js:52)   │
       │                 │                       │ normChangePath    │
       │                 │                       ▼                   ▼
       │                 │              committed/staged/      untracked[]
       │                 │              unstaged buckets
       │                 │                       │
       │                 ▼                       ▼
       └──────────►  emptyChangeSet (降级)  ◄── merge buckets into allSet
                      (lib/change-set.js:73)     │  + renamed.from + untracked
                                                 ▼
                                          all = sorted union
                                                 │
                              isWikiProduct ──────┼─────────────┐
                                                 ▼             ▼
                                         sourceChanges    ignored
                                                 │             │
                                                 ▼             ▼
                                          ChangeSet (ok:true/false, state, fallback)
```

## Data Flow

1. **入参校验**（`lib/change-set.js:103-106`）：`baseCommit` 空 → 返回 `state:'missing-base'`、`fallback:'full'`。
2. **执行器就绪**（`lib/change-set.js:107-108`）：`run = opts.execFile ?? defaultExecFile(cwd)`，封装 `git(args)`。
3. **HEAD 与仓库有效性**（`lib/change-set.js:112-125`）：`git rev-parse HEAD` 失败 → 再问 `--is-inside-work-tree`，区分 `no-git` 与 `git-error`；`headCommit` 空 → `git-error`。
4. **基线可达性**（`lib/change-set.js:128-137`）：`git cat-file -e base^{commit}` 失败 → `state:'unreachable-base'`、`headCommit` 回带、建议全量重编。
5. **四路采集**（`lib/change-set.js:141-160`）：`collect(label, args)` 用 `parseNameStatus` 解析三条 `--name-status -M`（`base..HEAD`、`--cached HEAD`、工作区），`-M` 打开改名检测；`untracked` 走 `ls-files --others --exclude-standard` 并按行 `normChangePath` 过滤。任一抛错整体降级为 `git-error`。
6. **分类 + 去重**（`lib/change-set.js:162-185`）：遍历三 bucket，路径入 `allSet`；`deleted` 入 `deletedSet`；`renamed` 额外把 `from` 也入 `allSet` 并记录 `{from,path,bucket}`；`untracked` 全部入 `allSet`。「删了又新建同名」：`deletedSet` 中若也在 `untracked` 则移除（当前存在就不是删除）。`all = [...allSet].sort()`，再用 `isWikiProduct` 拆出 `sourceChanges` 与 `ignored`。
7. **组装返回**（`lib/change-set.js:187-204`）：各 bucket 经 `isWikiProduct` 过滤（wiki 产物不进任何业务 bucket），`deleted`/`renamed` 排序/过滤后返回；成功 `ok:true, state:'ok', fallback:null`。

返回对象**可被 `JSON.parse(JSON.stringify(cs))` 无损序列化**（`test-change-set.mjs:196-203`），因为它只含可序列化字段（`version`/`ok`/`state`/`fallback`/`reason`/`baseCommit`/`headCommit`/`各数组`），且 `renamed` 条目只保留 `from/path/bucket`（不残留函数）。

## Connections

- **上游调用方**：`index.js:3843-3846` 的 `runStaleUpdate` 在 `scope=auto/stale` 时调 `collectChangeSet(cwd, baseline)`，`baseline` 来自 `readCompiledBaseline(wikiPath)`（`index.js:1704-1712`，读 `.codewiki/_meta.yaml:last_compiled_commit`）。失败时 `return { needFull:true, reason }`（退回全量）；成功的 `changeSet` 被裁剪成 `job.changeSet`（`index.js:3622-3633`）并随任务提交（`index.js:3916`）。
- **下游消费者 [[update-planner]]**：`planUpdate`（`lib/update-planner.js:156`）接受 `changeSet`，读取其 `sourceChanges`/`deleted`/`renamed`/`untracked`/`all`（`lib/update-planner.js:171-175`）来判「哪篇要写、哪些变化没人认领」。`needsFull` 由 `unmappedSourceChanges` 决定（无归属的源码变更 → 退回全量）。
- **下游消费者 [[update-record]]**：`buildUpdateRecord`（`lib/update-record.js:131`）把 `changeSet` 的 `state/ok/fallback/reason` 及各 bucket 计数写进 `temp/update-record.json`（`lib/update-record.js:153-169`），作为「一次编译做了什么」的可复盘证据。
- **相关模块 [[incremental]]**：`collectChangeSet` 管「文件级四路变更」，而 `lib/incremental.js` 的 `filterStaleTasks` 管「组件级符号变更」——两者都是判增量是否完整的输入，但职责不重叠。
- **测试 [[test-change-set]]**：`test-change-set.mjs` 用 18 个场景钉住四路采集与降级语义（含非 git 目录、缺 base、基线不可达、改名、删后重建、wiki 产物排除、POSIX 归一、注入 `execFile` 离线路径、JSON 可序列化）。

## Known Issues

- **`missing-base` 分支不回带 `headCommit`**：`lib/change-set.js:112-114` 直接 `emptyChangeSet('', {...})`，`headCommit` 留空串。相比 `unreachable-base`（`lib/change-set.js:131-136`）会回带 `headCommit`，此处信息较少；但因为本就是「无基线」退化，调用方（`index.js:3626-3633`）会按文件级处理，影响有限。
- **改名检测依赖 `-M` 启发式**：`lib/change-set.js:165-167` 用 `git diff -M` 判定改名；相似度阈值取 git 默认（50%）。若一次「大改」被 git 判为「删+加」而非改名，下游 `renamed` 不会记录，planner 会看不到「同一份内容换了位置」（`lib/change-set.js:139-140` 注释已说明为何要 `-M`）。
- **`git-error` 不区分具体失败命令**：`lib/change-set.js:159` 四路采集中任一抛错都归为同一个 `git-error`（reason 带 label），无法单独知道是 committed/staged/unstaged 哪一路挂了；但统一退回 `full` 是安全降级。
- **未直接处理软链接/子模块内文件**：`normChangePath`（`lib/change-set.js:33-40`）只做路径形态过滤，不感知 `.gitmodules`；子模块内的变更由外层 git 视作 `untracked`/`modified`，本模块按普通路径处理，不特殊处理。
- **`all` 去重按字符串**：同名文件既 `deleted` 又 `untracked`（删后重建）时已从 `deletedSet` 剔除（`lib/change-set.js:181`），但若同一相对路径在三路里以不同大小写出现（如 macOS 大小写不敏感文件系统），归一后仍按字符串去重，不跨大小写合并。
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


