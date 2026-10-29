---
title: change_set
type: module
source_files:
  - lib/change-set.js
  - lib/git-paths.js
  - test-change-set.mjs
  - lib/engine/native-run.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/native-state.js
tags: [git, change-set, incremental, delta-collection, quotepath]
---

## Overview

`change_set` 模块解决「增量编译到底改动了哪些文件」这一事实来源问题。它由两个源文件组成：

- `lib/change-set.js`：把 `committed / staged / unstaged / untracked` 四路 git 改动收成一个规范化、可序列化的 `ChangeSet`，并把「采不全」的情形显式暴露为 `state` + `fallback='full'`，让调用方退回全量编译。
- `lib/git-paths.js`：专门铲平 git 路径输出的两层落差——`core.quotepath=true` 把非 ASCII 路径写成八进制转义 + 双引号，以及转义是按字节做的（中文占三个 `\NNN`），必须把字节重拼成 Buffer 再按 UTF-8 解码。

背景缺陷（见 `lib/change-set.js:1-13` 注释）：旧实现 `cw status` 只跑 `git diff <last_compiled_commit>..HEAD`，于是未提交修改、暂存区修改、新建未跟踪文件三类改动对它完全隐形，导致「改完代码就编译」会把未消化变化当成已消化（基线被前移），文章与源码脱节却一路绿到底。本模块是融合后「变更不能丢」的第一条防线。

测试文件 `test-change-set.mjs` 用真实临时 git 仓库钉住四路采集与每一条降级语义（`no-git` / `missing-base` / `unreachable-base` / 中文路径配额转义 / 可注入 execFile 等）。

## Key Components

### lib/change-set.js

| 公开符号 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `CHANGE_SET_VERSION` | 20 | 常量 `=1` | ChangeSet 的版本标记，随 `version` 字段写入，供序列化与升级判断 |
| `WIKI_PRODUCT_PREFIX` | 25 | 常量 `='.codewiki/'` | wiki 自身产物目录前缀；每次编译都会被重写，不能算源码变更 |
| `isWikiProduct(relPath)` | 27-30 | 函数 | 返回 `true` 当路径为 `.codewiki` 或以其开头；用于把 wiki 产物从 `sourceChanges` 剔除、移入 `ignored` |
| `normChangePath(p)` | 34-41 | 函数 | 路径归一化：反斜杠转 `/`、去 `.//` 前缀、拒绝绝对路径 / 盘符 / `../` 跳出（返回 `null`） |
| `defaultExecFile(cwd)` | 43-50 | 内部函数 | 返回一个基于 `execFileSync` 的执行器（真实链路用），`maxBuffer` 16MB |
| `parseNameStatus(out)` | 58-77 | 函数 | 解析 `git diff --name-status` 输出；`R/C` 记 `from→to`，`D` 记删除，逐条过 `decodeGitPath`+`normChangePath` |
| `emptyChangeSet(baseCommit, overrides)` | 79-99 | 函数 | 返回 ChangeSet 骨架，默认 `ok:false`、各数组为空；`...overrides` 注入降级原因 |
| `collectChangeSet(cwd, baseCommit, opts)` | 108-210 | 函数 | 主采集器，详见下文 |

**`collectChangeSet(cwd, baseCommit, opts)`**（`lib/change-set.js:108-210`）是模块唯一对外的核心函数：

- 入参：`cwd`（仓库工作目录）、`baseCommit`（上次成功编译的基线 commit，来自 `cw` 的 `_meta.yaml:last_compiled_commit`）、`opts.execFile(cmd, args) -> stdout`（依赖注入，测试传假执行器；缺省走 `defaultExecFile`）。
- 流程四步：
  1. HEAD 与仓库有效性（`lib/change-set.js:116-131`）：`rev-parse HEAD` 失败再问 `--is-inside-work-tree`，区分 `no-git`（非 git 目录）与 `git-error`（是 git 但命令出错）。
  2. 基线可达性（`lib/change-set.js:133-143`）：`cat-file -e ${base}^{commit}`，不可达返回 `unreachable-base`，退回全量。
  3. 四路采集（`lib/change-set.js:145-165`）：`-M` 打开改名检测，避免改名被拆成「删+加」。
  4. 分类 + 去重（`lib/change-set.js:167-190`）：用 `allSet` 收集全部路径（改名两端都算），`deletedSet` 记删除，删后又重建的同一路径从 `deletedSet` 移除，最后 `sourceChanges = all 去掉 wiki 产物`，`ignored = 仅 wiki 产物`。
- `baseCommit` 为空时直接返回 `missing-base` + `fallback='full'`（`lib/change-set.js:110-112`）。

**ChangeSet 对象结构**（`lib/change-set.js:79-99` 骨架 + `192-209` 实装），全部字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | number | `CHANGE_SET_VERSION`（=1） |
| `ok` | boolean | 仅 `state==='ok'` 时为 `true` |
| `state` | string | `'ok' \| 'missing-base' \| 'no-git' \| 'git-error' \| 'unreachable-base' \| 'unknown'` |
| `fallback` | `'full' \| null` | 非 ok 时恒为 `'full'`，调用方据此退回全量 |
| `reason` | string | 人类可读原因，非 ok 时非空（多处截断到 120/200 字符） |
| `baseCommit` | string | 传入的基线 commit |
| `headCommit` | string | `git rev-parse HEAD` 输出 |
| `committed` | `Entry[]` | `base..HEAD` 之间的改动 |
| `staged` | `Entry[]` | `--cached HEAD` 暂存区改动 |
| `unstaged` | `Entry[]` | 工作区相对索引的改动 |
| `untracked` | `string[]` | `ls-files --others --exclude-standard` 的纯字符串路径 |
| `deleted` | `string[]` | 被删除的路径（删后又重建的已剔除） |
| `renamed` | `{from, path, bucket}[]` | 改名 / 拷贝记录 |
| `all` | `string[]` | 四路去重后的全路径并集（**含** wiki 产物路径，已排序） |
| `sourceChanges` | `string[]` | `all` 去掉 wiki 产物（真正的源码/文档变更） |
| `ignored` | `string[]` | 仅 wiki 产物路径（已排序） |

`committed/staged/unstaged` 的条目 `Entry` 形态（由 `parseNameStatus` 产出，`lib/change-set.js:58`、`:74`，并在 `:180` 补 `bucket`）：

| 字段 | 含义 |
| --- | --- |
| `kind` | `'modified' \| 'deleted' \| 'renamed' \| 'copied'` |
| `path` | 归一化 POSIX 路径 |
| `from` | 仅 `renamed`/`copied` 有，来源路径 |
| `status` | 原始 git 状态码，如 `'M'`、`'D'`、`'R100'` |
| `bucket` | 该条目属于 `committed`/`staged`/`unstaged` 哪一桶 |

### lib/git-paths.js

| 公开符号 | 行号 | 类型 | 用途 |
| --- | --- | --- | --- |
| `GIT_QUOTEPATH_OFF` | 20 | 常量 `['-c', 'core.quotepath=false']` | 关闭配额转义的前置参数（必须紧跟 `git` 之后、子命令之前） |
| `withQuotepathOff(args)` | 39-43 | 函数 | 给参数表前置配额关闭；若已关闭则不重复加 |
| `toPosix(p)` | 34-36 | 函数 | 路径归一到 POSIX 分隔符（**唯一实现**） |
| `SIMPLE_ESCAPES` | 45-47 | 内部常量 | 简单转义映射：`a b t n v f r " \` |
| `decodeGitPath(p)` | 53-88 | 函数 | 解开 git 路径转义；非「双引号包裹的转义串」原样返回（幂等）；解不开保守原样返回 |
| `decodeGitPaths(list)` | 91-95 | 函数 | 整份路径清单解码（保持顺序、丢弃空串） |
| `default` 导出 | 97 | 对象 | `{ GIT_QUOTEPATH_OFF, withQuotepathOff, toPosix, decodeGitPath, decodeGitPaths }` |

`decodeGitPath` 的关键实现点（`lib/git-paths.js:53-88`）：它逐字符扫描，遇到 `\0-\7` 的三位八进制转义则 `parseInt(oct, 8)` 推入字节数组，遇到 `SIMPLE_ESCAPES` 里的简单转义同样推字节，其余字符按字节或 `Buffer.from(ch,'utf8')` 推字节，最后 `Buffer.from(bytes).toString('utf8')`——这正是「转义按字节做、必须重拼 Buffer」的落地。代理对（`cp>0xffff`）会多跳一个索引（`:85`）。

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ git subprocess (execFile / execFileSync)              │
│  rev-parse HEAD · cat-file -e · diff --name-status -M │
│  ls-files --others --exclude-standard                 │
└───────────────────────┬──────────────────────────────┘
                        │ raw stdout (may be quotepath-escaped)
                        ▼
┌──────────────────────────────────────────────────────┐
│ collectChangeSet (lib/change-set.js:108)              │
│  1 HEAD/validity  2 base reachability                 │
│  3 four-way collect  4 classify + dedupe              │
└───────┬───────────────────────────┬──────────────────┘
        │ --name-status lines       │ untracked lines
        ▼                           ▼
┌────────────────────────┐  ┌───────────────────────────────┐
│ parseNameStatus (58)   │  │ decodeGitPaths (git-paths:91)  │
│  decodeGitPath (gp:53) │  │  normChangePath (change-set:34)│
│  normChangePath (34)   │  └───────────────────────────────┘
└───────────┬────────────┘
            │ Entry{path,from,status,bucket}
            ▼
┌──────────────────────────────────────────────────────┐
│ isWikiProduct (27): all → sourceChanges | ignored     │
│ ChangeSet object (change-set:192-209)                 │
└──────────────────────────────────────────────────────┘
```

组件依赖：本模块内 `lib/change-set.js` 仅从 `lib/git-paths.js` 导入 `decodeGitPath`、`decodeGitPaths`（`:18`），不导入 `withQuotepathOff`/`GIT_QUOTEPATH_OFF`——它选择「靠解码兜住已转义输入」这一层（`git-paths.js:11-17` 注释说明两件都做的原因）。`normChangePath` 与 `parseNameStatus` 是 change-set.js 内部对路径的二次保险。

## Data Flow

四路采集的命令与含义：

| 桶 (bucket) | git 命令 | 行号 | 含义 |
| --- | --- | --- | --- |
| `committed` | `git diff --name-status -M ${base}..${headCommit}` | 157 | 已提交但未编入基线的改动 |
| `staged` | `git diff --name-status -M --cached HEAD` | 158 | 已 `git add` 未提交的改动 |
| `unstaged` | `git diff --name-status -M` | 159 | 工作区相对索引的未暂存改动 |
| `untracked` | `git ls-files --others --exclude-standard` | 160 | 新建且未被跟踪的文件 |

数据流串接：

1. `defaultExecFile`/`opts.execFile` 跑上述命令，stdout 交给 `parseNameStatus`（前三路）或 `decodeGitPaths`（第四路）。
2. `parseNameStatus` 对每条 `R/C` 行产出 `{kind:'renamed'|'copied', from, path, status}`，其余行产出 `{kind:'modified'|'deleted', path, status}`；所有路径过 `decodeGitPath` 解码配额转义，再 `normChangePath` 归一化与越界过滤（`:58-77`）。
3. 四路汇总进 `allSet`/`deletedSet`/`renamed`（`lib/change-set.js:167-182`）：改名条目额外把 `from` 也加进 `allSet`；`untracked` 直接并入 `allSet`；删后又重建的路径从 `deletedSet` 删除（`:186`）。
4. `all = [...allSet].sort()`，`sourceChanges = all 过滤掉 isWikiProduct`，`ignored = all 仅 isWikiProduct`（`lib/change-set.js:188-190`）。
5. 返回对象里 `committed/staged/unstaged/untracked/deleted/renamed` 各自再套一层 `isWikiProduct` 过滤后输出（`:200-205`），保证下游拿到的是「源码视角」——但 `all` 仍含 wiki 产物（`:206`），这是有意为之：供审计与调试，下游应读 `sourceChanges`。
6. 任一 git 命令抛错，`collect` 包装成 `「<label> 采集失败：...」`，`collectChangeSet` 在 `:163-165` 捕获并返回 `git-error` + `fallback='full'`。

可注入性：`opts.execFile` 让测试脱离真实 git（`test-change-set.mjs:203-220` 注入假执行器并断言它真的被调用）。ChangeSet 是纯数据对象，`JSON.parse(JSON.stringify(cs))` 可无损往返（`test-change-set.mjs:222-229`）。

## Connections

- [[lib/git-paths]]：`lib/change-set.js:18` 直接依赖 `decodeGitPath` / `decodeGitPaths` 做路径解码；两文件的职责边界即「采集 vs 解码」。
- [[lib/engine/native-run]]：`lib/engine/native-run.js:299` 导入 `collectChangeSet as realCollectChangeSet`，在增量决议段（`:298-308`）调用 `changeSetImpl(root, baseCommit)`。其结果进入 `nativeState.mergeUnconsumed({changeSet})`（`:315`）与 `nativeState.buildStatePayload({pendingChanges: changeSet})`（`:602-620`）——即未提交改动由 `unconsumed` 跨轮携带、不会因基线前移而丢失。
- [[lib/update-planner]]：`planUpdate({changeSet})`（`lib/update-planner.js:156`）消费 `changeSet.sourceChanges` / `deleted` / `renamed` / `untracked` / `all`（`:171-175`），作为「哪些文件变了」的事实输入，并据此决定每篇文章的 `write/keep/delete/review` action。
- [[lib/update-record]]：`buildUpdateRecord({changeSet})`（`lib/update-record.js:131`）从 ChangeSet 抽取 `state/ok/fallback/reason` 与各类 `counts`，连同 `sourceChanges`/`ignored` 持久化进 `temp/update-record.json`（`:151-169`），供事后复盘与面板展示。
- [[lib/engine/native-state]]：`mergeUnconsumed`（`lib/engine/native-state.js:524`）与 `buildStatePayload`（`lib/engine/native-state.js:421`）接收 ChangeSet 形状；前者把 `staged/unstaged/untracked` 视为「未消费」跨轮携带，后者把四路路径原样记入 `pendingChanges` 作审计凭据。
- [[lib/incremental]]：`normRel`（来自 `lib/incremental.js`）在 `update-planner.js` 里对 `changeSet` 的路径再做一次归一化（与 `normChangePath` 互补），是连接变更集与增量计划器的桥梁。

## Known Issues

- **`all` 含 wiki 产物**：`all`（`lib/change-set.js:206`）是四路并集、不去 wiki 产物，而 `committed/staged/...` 都已过滤（`lib/change-set.js:189-194`）。下游若误用 `all` 而非 `sourceChanges` 会重新把 `.codewiki/` 当源码变更，使增量永远 dirty。`sourceChanges` 才是语义正确的「源码视角」入口。
- **`defaultExecFile` 同步阻塞**：真实链路用 `execFileSync`（`:44`），大仓库四路 diff / ls-files 会阻塞事件循环；`maxBuffer` 上限 16MB（`:48`），超大会抛错并落入 `git-error` 降级。
- **改名相似度阈值默认 50%**：`-M` 没带数字（`:157-159`），git 默认 50% 相似度，低于阈值的重名会被拆成「删+加」，导致 `renamed` 漏记、`deleted`/`untracked` 误记。
- **不带 `--find-renames` 之外的其他选项**：没有处理拷贝相似度以外的情形（如 `--find-copies-harder`），且未处理 merge commit 的特殊 diff 语义。
- **`reason` 多处截断**：仓库探测类降级原因在 `:125`/`:127` 用 `slice(0, 200)` 截断，基线不可达原因在 `:141` 用 `slice(0, 120)` 截断，四路采集失败经 `collect` 包装（`:149`，`slice(0, 200)`）后于 `:164` 透传。长错误信息会被裁短，排障时需结合 `state` 判断。
- **配额转义仅靠解码层**：`collectChangeSet` 未使用 `withQuotepathOff` 关掉 `core.quotepath`，而是依赖 `decodeGitPath` 幂等解码（`lib/git-paths.js:11-17`）。这层选择是故意的（兜住已写进历史清单的转义串），但若将来某次 git 调用忘记走解码、又没关 quotepath，中文路径会再次漏解码（测试 `test-change-set.mjs:182-201` 正是为守住这条线）。
- **无符号级信息**：本模块只到「文件路径」粒度，组件级增量所需的图 diff 由 [[lib/update-planner]] / graph-diff 负责，ChangeSet 不感知符号。
