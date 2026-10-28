---
title: test_change_worktree
type: module
source_files:
  - test-change-set.mjs
  - test-worktree.mjs
  - lib/change-set.js
  - index.js
  - lib/update-record.js
tags: [test, change-set, worktree, git]
---

## Overview

本模块聚合了两份针对「git 变更采集」与「worktree / 空壳目录闸门」的测试文件，它们同属 dsh-codewiki 的编译对象判定层：

- `test-change-set.mjs`：钉住 `lib/change-set.js` 导出的 `collectChangeSet` 的**四路变更采集与降级语义**。背景缺陷见 `lib/change-set.js` 第 1–15 行的注释：旧实现 `cw status` 只跑 `git diff <last>..HEAD`，未提交的工作区修改、暂存区、未跟踪新文件全部隐形，导致「改完代码还没提交就编译」会把未消化变化当成已消化——这是审计确认的「增量漏检」。
- `test-worktree.mjs`：钉住 `index.js` 中 `detectLinkedWorktree`（0.12.0）、`isWorktreeCwd` / `hasCompilableSources` / `isDeadCompileTarget`（0.12.1）的工作树判定与空壳判定。判据一律来自 git 自身（而非目录命名），用真实 `git worktree add` 建临时仓库验证。

两份测试都不依赖宿主，全部用真实 `git`/`execFile` 在 `os.tmpdir()` 下的临时仓库里断言；环境没有可用 git（或 hooks 干扰）时 `test-worktree.mjs` 会 `SKIP` 而不是误报成功（见 `test-worktree.mjs` 第 30–36 行）。

## Key Components

### 测试文件 `test-change-set.mjs`（209 行）

纯函数式断言脚本（无测试框架，自写 `check` 包裹 `assert`）。导入 `collectChangeSet`：

- `check(label, fn)`（第 15–18 行）：异步断言包裹器，累加 `pass` 计数，失败 push 进 `fails` 数组并打印 `FAIL`。
- `makeRepo()`（第 23–42 行）：在 `os.tmpdir()` 下 `git init` + 配置 user、`commit -qm base`，含基线提交（`.codewiki/_meta.yaml` 等），返回 `{ dir, base, write }`。每个场景独立临时仓库。
- `git(cwd, args)`（第 20 行）：封装 `execFileSync('git', args, …)`，仅取 stdout。
- `allPaths(cs)`（第 44 行）：取 `cs.all` 排序后副本；`names(list)`（第 45 行）：把 `{path}` 或字符串列表归一为排序后的名字数组——测试内比较 `all`/`committed`/`staged`/`unstaged`/`untracked`/`deleted` 时的工具。
- 覆盖的断言场景（从 `await check(...)` 起）：
  - 非 git 目录 → `state==='no-git'`、`ok===false`、`all===[]`、带 `reason`（第 47–55 行）。
  - 缺 `baseCommit` → `state==='missing-base'`、`fallback==='full'`（第 57–63 行）。
  - `base` 不可达（40 个 `0`）→ `state==='unreachable-base'`、退回 `full`、`reason` 含 7 位短 hash（第 65–72 行）。
  - 干净仓库（`base==HEAD`）→ `ok===true`、`state==='ok'`、`all===[]`、`headCommit===base===baseCommit`（第 74–82 行）。
  - 仅 unstaged（第 84–93 行）、仅 staged（第 95–103 行）、untracked 新文件（第 105–111 行）、删除文件（第 113–119 行）、改名（第 121–129 行，记 `renamed` 且 `all` 含两端）。
  - committed 变更（第 131–139 行）、四路合并去重（第 141–150 行，同一文件既 committed 又 unstaged 时 `all` 只出现一次）。
  - `.codewiki/` 自身产物不计入源码变更：`sourceChanges` 排除、`ignored` 记账（第 152–164 行），README/CHANGELOG 等被 source_files 引用的文档仍是合法 source。
  - 路径一律规范化为 POSIX（无反斜杠、无 `./` 前缀，第 166–175 行）。
  - 可注入 `execFile`（离线单测，第 177–194 行）：`collectChangeSet('/fake', 'base123', { execFile: fake })`，断言通过注入执行器调用 git。
  - ChangeSet 可 JSON 序列化（第 196–203 行），要写进 update-record。

### 测试文件 `test-worktree.mjs`（83 行）

纯断言脚本（自写 `check(cond, msg)` 在第 14 行）。导入 `detectLinkedWorktree`、`isWorktreeCwd`、`hasCompilableSources`、`isDeadCompileTarget`（第 11 行，从 `./index.js` 动态 `import`）。

- 环境准备（第 10–43 行）：设 `DSH_CODEWIKI_JOBS_FILE` 隔离 jobs 文件；`git init` 主仓库 + `git worktree add -q linked` 造 linked worktree；`bad = setup.find(r => r.status !== 0)` 时 `SKIP` 而非误报（第 30–36 行）。
- `detectLinkedWorktree` 三态（第 38–53 行）：主工作区 → `null`；linked → 命中且 `gitDir` 含 `worktrees` 而 `commonDir` 指向主仓库 `.git`；不存在路径 → `null`；linked 子目录 → 命中；非 git 目录 → `null`；空/空值输入 → `null`。
- `isWorktreeCwd`（第 55–62 行）：`main===false`、`linked===true`、`linked/sub===true`、`plain===false`、空值 `===false`、同路径二次查询命中缓存结果一致。
- `hasCompilableSources`（第 64–70 行）：有 `a.txt` 的仓库 `===true`、只剩 `.codewiki` 骨架 `===false`、不存在路径 `===false`。
- `isDeadCompileTarget`（第 72–77 行）：主工作区 `===false`、`linked worktree===true`、空壳 `===true`、不存在目录 `===false`（历史保留）、空值 `===false`。

### 被测实现 `lib/change-set.js`（205 行）

- `CHANGE_SET_VERSION`（第 19 行）：常量 `1`，写进每个 ChangeSet 的 `version` 字段。
- `isWikiProduct(relPath)`（第 26–29 行）：判断路径是否为 `.codewiki` 或其前缀，用于把 wiki 自身产物从源码变更中剔除。
- `normChangePath(p)`（第 33–40 行）：路径归一（反斜杠→`/`、去 `./` 前缀、绝对路径/越级 `../` 判为不安全返回 `null`）。
- `defaultExecFile(cwd)`（第 42–49 行）：默认执行器封装 `execFileSync`，`maxBuffer` 16MB；供 `opts.execFile` 覆盖（离线单测注入）。
- `parseNameStatus(out)`（第 52–71 行）：解析 `git diff --name-status` 输出，`R`/`C` 记 `renamed`/`copied`（from→to），`D` 记 `deleted`，其余记 `modified`；返回 entries 数组。
- `emptyChangeSet(baseCommit, overrides)`（第 73–93 行）：返回 ChangeSet 空骨架（18 个字段：`version/ok/state/fallback/reason/baseCommit/headCommit/committed/staged/unstaged/untracked/deleted/renamed/all/sourceChanges/ignored`），缺省 `ok=false`、`state='unknown'`、`fallback=null`。
- `collectChangeSet(cwd, baseCommit, opts)`（第 102–205 行）：核心采集函数，返回 ChangeSet。流程：
  1. 空 `baseCommit` → `missing-base`/`fallback='full'`（第 104–106 行）。
  2. `rev-parse HEAD` 失败先问 `rev-parse --is-inside-work-tree`：`not true` → `no-git`，否则 `git-error`（第 113–125 行）。
  3. `cat-file -e base^{commit}` 不可达 → `unreachable-base`、退回 `full`（第 128–137 行）。
  4. 四路采集（第 141–160 行）：`committed`=`base..HEAD`、`staged`=`--cached HEAD`、`unstaged`、untracked=`ls-files --others --exclude-standard`，`-M` 开改名检测。
  5. 分类去重（第 163–185 行）：`all` 含改名两端、删除与重建同名文件互斥、`sourceChanges`/`ignored` 按 `isWikiProduct` 分流。
  6. 成功返回 `ok=true`、`state='ok'`（第 187–204 行）。

ChangeSet 返回值完整字段（`emptyChangeSet` 第 73–93 行定义骨架，`collectChangeSet` 第 187–204 行覆盖）：`version`（=`CHANGE_SET_VERSION`）、`ok`、`state`（如 `ok`/`no-git`/`missing-base`/`unreachable-base`/`git-error`）、`fallback`（`'full'` 或 `null`）、`reason`、`baseCommit`、`headCommit`、`committed`、`staged`、`unstaged`、`untracked`、`deleted`、`renamed`、`all`、`sourceChanges`、`ignored`。

### 被测实现 `index.js`（worktree 闸门，第 353–441 行）

- `detectLinkedWorktree(cwd)`（第 364–380 行，导出）：用 `git rev-parse --git-dir --git-common-dir`，两者 `resolve` 后 `normalize` 不同即命中，返回 `{ gitDir, commonDir }`，否则 `null`。非 git 仓库 / 失败 → `null`（放行）。
- `normPathKey(p)`（第 387 行）：路径 normalize + 去尾部分隔符 + 小写，作缓存 key。
- `isWorktreeCwd(cwd)`（第 388–399 行，导出）：`detectLinkedWorktree` 的 60s 缓存版（`WORKTREE_CACHE_TTL_MS` 第 385 行），供面板 2s 轮询使用；空值 → `false`。
- `hasCompilableSources(cwd)`（第 407–421 行，导出）：10 分钟缓存（`SOURCE_PROBE_TTL_MS` 第 405 行）的 `scanRepoFiles(dir).length > 0` 判定；目录不存在/非目录 → `false`。
- `clearSourceProbeCache(cwd)`（第 423–426 行，导出）：手动/目录内容变化后清探测缓存；`cwd` 为空则 `sourceProbeCache.clear()`。
- `isDeadCompileTarget(cwd)`（第 433–441 行，导出）：统一判定——worktree 或「存在但扫不出源码的空壳」→ `true`；目录不存在 → `false`（历史保留）。
- 相关常/变量：`WORKTREE_CACHE_TTL_MS`(385)、`worktreeCache`(386)、`SOURCE_PROBE_TTL_MS`(405)、`sourceProbeCache`(406)；底层探测用 `scanRepoFiles`（第 2121–2144 行，黑名单目录 + 二进制后缀 + 单文件 256KB + 总数 2000）。

这些判定在 `submit`/`generateToolDefinition.execute`（第 3587–3592 行、第 3769–3777 行、第 3784–3789 行）、`autoScan`（第 4845–4848 行）、`createJobService` 启动清理（第 2331–2346 行）、面板 jobs/repos 端点（第 4383 行、第 4430 行）等处统一复用。

## Architecture

两份测试都采用「临时仓库 + 真实 git」的现场断言，被测逻辑分两套闸门各管一件事：变更采集（`collectChangeSet`）与编译对象判定（worktree/空壳）。

```text
test-change-set.mjs ──import──▶ lib/change-set.js: collectChangeSet
        │                          │ 四路采集
        │                          ▼
        │                    git (真实/注入 execFile)
        │                          │
        │                          ▼
        │                    ChangeSet {state, ok, fallback,
        │                    all, sourceChanges, ignored, …}
        ▼
test-worktree.mjs ──import('./index.js')──▶ index.js 闸门函数
        │                                   │
        │                  detectLinkedWorktree ──▶ git rev-parse --git-dir/--git-common-dir
        │                  isWorktreeCwd (60s 缓存封装)
        │                  hasCompilableSources (10min 缓存 + scanRepoFiles)
        │                  isDeadCompileTarget = isWorktreeCwd || !hasCompilableSources
        ▼
   断言 {gitDir, commonDir} / boolean 三态 / 空壳判定
```

两种闸门在设计上不重叠（`submit` 内分别见 `index.js` 第 3585–3592 行的 worktree 闸门注释与第 3593–3601 行的空壳目录闸门注释）：worktree 闸门保证同一份代码只编一次（隔离工作区与主仓库产物不打架）；空壳闸门避免「扫不出源码」的目录被自动调度反复提交失败任务。判据全部来自 git 自身或文件树扫描，与目录命名无关——这正是 `test-worktree.mjs` 用真实 `git worktree add` 而非靠名字猜测的原因。

## Data Flow

### change-set 测试的数据流

```
makeRepo() → git init + base 提交（含 .codewiki/_meta.yaml）
   │
   ▼
collectChangeSet(dir, base) 或 collectChangeSet('/fake', 'base', {execFile: fake})
   │  1. base 为空 → missing-base / fallback='full'
   │  2. rev-parse HEAD 失败 → no-git | git-error
   │  3. cat-file -e base^{commit} 失败 → unreachable-base / fallback='full'
   │  4. 四路 diff --name-status(-M) + ls-files --others
   │  5. 分类去重：all 含改名两端；sourceChanges / ignored 按 isWikiProduct 分流
   ▼
ChangeSet → assert 比对 allPaths(cs) / names(cs.*) / cs.sourceChanges / cs.ignored
```

- 离线单测路径（第 177–194 行）：传入 `opts.execFile` 假执行器，直接返回伪造的 `rev-parse HEAD` / `cat-file` / `name-status` / `ls-files` 输出，无需真实 git。
- 序列化路径（第 196–203 行）：`JSON.parse(JSON.stringify(cs))` 必须保留 `all` 与 `version`，以便写进 update-record（`lib/update-record.js`）。

### worktree 测试的数据流

```
setup: git init main + git worktree add linked + 主仓库造 a.txt
   │  bad = setup.find(r => r.status!==0) → 若真失败则 SKIP（不误报）
   ▼
detectLinkedWorktree(path) ──▶ spawnSync('git',['rev-parse','--git-dir','--git-common-dir'])
   │  命中 → { gitDir（含 worktrees）, commonDir（主仓库 .git）}
   ▼
isWorktreeCwd / hasCompilableSources / isDeadCompileTarget → 布尔/三态断言
   │  清理：git worktree remove --force linked；rm 临时目录与 DSH_CODEWIKI_JOBS_FILE
   ▼
console: PASS / FAIL（failures ? 1 : 0 退出码）
```

## Connections

- [[change-set]] — `collectChangeSet` / `parseNameStatus` / `isWikiProduct` 的实现本体，本模块的全部变更采集断言都钉它。
- [[incremental]] — `collectChangeSet` 的产出（`ChangeSet`）是 stale 增量规划的输入：`index.js` 第 3843–3849 行 `readCompiledBaseline` + `collectChangeSet` 后交给 `planUpdate`，未消化变化会阻断编译基线前移。
- [[update-planner]] — 消费 ChangeSet 的 `planUpdate`，判定哪些文章要重写、哪些变化无人认领。
- [[update-record]] — ChangeSet 经 `JSON` 序列化后由 `buildUpdateRecord` 写进 `.codewiki/temp/update-record.json`（测试第 196–203 行即验证其可序列化，实现见 `lib/update-record.js`）。
- [[wiki-tests]] — 同属测试层模块，覆盖其余编译流水线（orchestration / sessions / engine bridge 等）。
- [[batch-tests]] — 另一份批量流程测试，与本模块一起构成 `*.mjs` 顶层测试套件。
- [[index]]（本仓插件入口）— `detectLinkedWorktree`/`isWorktreeCwd`/`hasCompilableSources`/`isDeadCompileTarget` 的定义处（第 353–441 行），被 `submit`、`generateToolDefinition.execute`、`autoScan`、面板 jobs/repos 端点共享。

## Known Issues

- `test-worktree.mjs` 第 30–36 行的 `SKIP` 分支：环境若没有可用 git（或 hooks 干扰，`setup` 中任一 `git` 调用 `status !== 0`），测试整体 `SKIP` 返回 0——这意味着在缺 git 的 CI 上，worktree 闸门的正确性**完全不被验证**，不会暴露回归。
- `test-change-set.mjs` 与 `test-worktree.mjs` 都自带 `check` 包裹器、各写各的断言风格（前者用 `node:assert/strict`，后者用裸 `check(cond,msg)`），与别的 `*.mjs`（如 `test-batch.mjs` 用 `node:test`）风格不一致，没有统一运行入口，靠仓库脚本逐个跑。
- `detectLinkedWorktree` 的判定依赖 `git rev-parse --git-common-dir`（第 368 行）：极老的 git 版本若不支持该 flag 会 `status !== 0` → 静默 `return null`，把真 worktree 当成主工作区放行（不过自动调度仍会被 `hasCompilableSources` 兜底一次）。
- `isWorktreeCwd` 缓存 60s、`hasCompilableSources` 缓存 10 分钟（第 385、405 行）：在自动化测试里手动路径会先 `clearSourceProbeCache`（第 3783 行）强制刷新，但单测并未覆盖「缓存命中后结果一致」之外的并发失效场景。
