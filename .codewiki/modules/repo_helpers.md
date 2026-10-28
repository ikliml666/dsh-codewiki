---
title: repo_helpers
type: module
source_files:
  - index.js
  - test-worktree.mjs
  - test-cwd-paths.mjs
  - test-prune-orphans.mjs
tags: [repos, overview, cw-status, worktree, gating, data-helpers]
---

## Overview

`repo_helpers` 不是仓库里一个独立文件，而是 `index.js` 中支撑 **仓库总览**（repos overview）面板端点的那一组数据助手与格式化函数。它们的共同职责是：把「一个工作目录（cwd）是不是一个可以/应该被 CodeWiki 编译的仓库」这件事，转成面板 `/api/codewiki/repos` 每一行（repo row）需要的字段与布尔标志。

这一组函数分散在 `index.js` 的几个区块里，但语义上高度内聚：

- **cw 状态解析**（`parseStatus`、`normalizeArticlePath`）：把 Rust CLI `cw status` 的文本输出（`No wiki found` / `has not been compiled yet` / `Wiki is up to date` 以及逐行 `M `/`! ` 清单）解析成结构化 `{state, changedFiles, staleArticles}`，并把 Windows 反斜杠路径归一化为 `/`。
- **编译对象闸门**（`detectLinkedWorktree`、`isWorktreeCwd`、`hasCompilableSources`、`isDeadCompileTarget`）：判定某 cwd 是不是「linked worktree」「空壳目录」「已删除但仍有历史记录」，从而决定它该不该出现在仓库总览里（1.2.0 / 1.2.1）。
- **排除清单判定**（`excludedItem`、`isExcluded`）：把用户配置的排除项（换行/分号/逗号分隔的绝对路径）应用到 cwd，决定面板 `excluded` 字段。
- **已知仓库登记**（`loadKnownRepos`、`rememberRepo`、`forgetRepo`）：维护独立于 job 历史的持久化工作区清单（`dsh-codewiki-repos.json`），让总览不漏掉编译过但已被 `MAX_JOBS_KEPT` 截断掉历史记录的工作区。
- **wiki 统计**（`countWikiArticles`）：递归数出 `.codewiki/` 下 `.md` 文章数，填充总览的 `articleCount`。
- **总览组装**：`/api/codewiki/repos` handler（约 `index.js:4695-4784`）把上面所有助手聚合成一行 `{cwd, excluded, lastJob, state, staleArticles, changedFiles, wikiPath, articleCount}`。

这些函数大多是纯函数（无副作用、返回值可机读），便于在 `test-worktree.mjs` / `test-cwd-paths.mjs` 中单独钉死三态行为。

## Key Components

> 以下函数全部位于 `index.js`（仓库根插件入口）。行号以 `read_code` 返回的「行号| 」前缀为准。

### cw 状态解析

- `normalizeArticlePath(p)` — `index.js:280`。把路径里的 `\\` 全部换成 `/`（纵深防御：旧 cw 二进制 / 上游原版在 Windows 仍输出反斜杠），返回归一化字符串。被 `parseStatus` 复用。
- `parseStatus(stdout)` — `index.js:294-307`。纯函数。输入 `cw status` 的 stdout，按关键字命中三态：
  - 含 `No wiki found` → `{state:'missing'}`
  - 含 `has not been compiled yet` → `{state:'uncompiled'}`
  - 含 `Wiki is up to date` → `{state:'clean'}`
  - 否则逐行匹配 `/^\s+[M!]\s+(.+)$/gm`：行首 `M` 进 `changedFiles`、`!`（其它）进 `staleArticles`，两者都经过 `normalizeArticlePath`，`state:'stale'`。`changedFiles`、`staleArticles` 缺省均为空数组（`index.js:296-298`）。

### 编译对象闸门（worktree / 空壳 / 历史）

- `detectLinkedWorktree(cwd)` — `index.js:435-451`。核心是 `git rev-parse --git-dir --git-common-dir`：linked worktree 中两者 resolve 后不同，主工作区两者相同（submodule 也相同，不误判）；非 git 仓库（rev-parse 失败）返回 `null`，不算 worktree。返回 `null` 或 `{ gitDir, commonDir }`。
- `isWorktreeCwd(cwd)` — `index.js:459-470`。带 **60s 缓存**（`WORKTREE_CACHE_TTL_MS = 60000`，`index.js:435`）的布尔封装：内部调 `detectLinkedWorktree`，命中即 `true`。`/api/codewiki/jobs`（2s 轮询）逐任务 spawnSync git 会拖住宿主事件循环，故缓存。
- `hasCompilableSources(cwd)` — `index.js:478-492`。带 **10 分钟缓存**（`SOURCE_PROBE_TTL_MS`，`index.js:476-477`）。实际靠 `scanRepoFiles(dir).length > 0`（见 `index.js:2192-2215`）。目录不存在返回 `false`，不是目录返回 `false`。
- `clearSourceProbeCache(cwd)` — `index.js:494-497`。手动清掉探测缓存（传 `cwd=null` 清空整个 `Map`），避免 10 分钟前的空判定挡住真实提交。
- `isDeadCompileTarget(cwd)` — `index.js:504-512`。统一判定：linked worktree → `true`；目录不存在 → `false`（保留历史记录）；存在但 `hasCompilableSources` 为 `false` → `true`。面板任务列表与仓库总览共用这个「这个目录根本不是有效编译对象」的判据。

### 排除清单

- `excludedItem(cwd, list)` — `index.js:410-419`。把 `list`（换行/分号/逗号分隔绝对路径）split 后，`cwd` 等于某项或位于其子树内即命中，返回命中的原始项（供工具报错告诉模型是哪条排除项拒绝的）。`path.normalize` + 大小写不敏感（Windows 兼容）。
- `isExcluded(cwd, list)` — `index.js:420-422`。布尔封装，`excludedItem(...) !== null`。面板 repos 总览的 `excluded` 字段依赖它。

### 已知仓库登记（`REPOS_FILE`）

- `loadKnownRepos()` — `index.js:2147-2149`。读 `REPOS_FILE`（`path.dirname(JOBS_FILE)/dsh-codewiki-repos.json`，`index.js:2146`），解析 `{repos:[...]}`，失败返回 `[]`。
- `rememberRepo(cwd)` — `index.js:2150-2158`。一次性登记：规范化 key（normalize + 小写 + 去尾斜杠），已存在则跳过，否则 push 并写回 `REPOS_FILE`。
- `forgetRepo(cwd)` — `index.js:2161-2170`。反登记（1.2.1）：从已知清单摘掉某 cwd（只改 `REPOS_FILE`，不碰用户磁盘目录）。未在清单则 `return false`。

### wiki 统计

- `countWikiArticles(wikiPath)` — `index.js:310-322`（内部函数，非导出）。递归 `fs.readdirSync` 遍历 `wikiPath`，统计所有 `.md` 文件数（含 `_index`）。`wikiPath` 不可读时返回 `null`（总览里 `articleCount` 即 `null`）。

### 总览行组装（`/api/codewiki/repos`）

- `/api/codewiki/repos` handler — `index.js:4695-4784`。带 30s 缓存（`reposCache` / `reposCacheAt`，`index.js:4704-4705`）。组装逻辑：
  - 签名 `wsSig`（`index.js:4711-4717`）= 工作区清单 + 当前非终态任务的工作区，确保编译中的仓库进出总览立即反映，不吃 30s 陈旧缓存。
  - `putCwd(dir, last)`（`index.js:4713-4725`）：经 `isDeadCompileTarget(dir)` 闸门后入 `seen` Map（normKey → 展示用 cwd）；同 key 第二次只补 `last`。
  - `workspaceOnly` 过滤（`index.js:4726-4732`）：只显示已添加工作区（含子仓库），`inWs = !wsPaths || isExcluded(dir, wsPaths)`；非终态任务的工作区例外放行。
  - 行基础对象 `base`（`index.js:4736-4746`）：含 `cwd`、`excluded`(`isExcluded`)、`lastJob`（从 job 历史取 `id/kind/stage/auto/finishedAt/writtenCount/tps/batchProgress/taskList`）。
  - 逐 cwd 现算（`index.js:4747-4763`）：`resolveBinary(c)` → `runCw(binary, cwd, ['status'])` → `parseStatus(stdout)` → `wikiPathFor(cwd, binary)` → `countWikiArticles(wp)`；任何异常整行降级为 `{...base, state:'error', error}`。
  - 返回 `{repos, scheduler:{...}}`（`index.js:4764-4779`），`scheduler` 片段来自 `schedState`（auto-update 调度器状态）。

### 其它被总览链直接复用的公开助手

- `wikiPathFor(cwd, binary, signal)` — `index.js:1925-1930`。`cw path` 取 wiki 绝对路径失败则兜底 `<cwd>/.codewiki`。
- `resolveBinary(cfg)` — `index.js:163-183`。PATH 优先探测 `cw`，否则用捆绑副本 `bin/cw(.exe)`，再否则字串 `'cw'`。
- `runCw(binary, cwd, args, timeoutMs, signal)` — `index.js:185-210`。spawn 封装，统一返回 `{exitCode, stdout, stderr, timedOut}`。

## Architecture

```
                /api/codewiki/repos  (index.js:4695)
                          │  30s 缓存 + wsSig 失效重算
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  seen Map (normKey→cwd)  经 isDeadCompileTarget 闸门       │
   │   index.js:4713-4725            ▲            index.js:504  │
   └───────────┬──────────────────────┼───────────────────────┘
               │ 逐 cwd 组装行         │
               ▼                      │
   ┌─────────────────────┐   ┌────────┴───────────┐   ┌──────────────────────┐
   │  workspaceOnly 过滤  │   │ isDeadCompileTarget │   │ loadKnownRepos       │
   │  isExcluded (420)   │   │  detectLinkedWork- │   │ rememberRepo/        │
   │  excludedItem (410) │   │  tree (435)        │   │ forgetRepo (2147)    │
   └─────────┬───────────┘   │  isWorktreeCwd(459)│   └──────────┬───────────┘
             │               │  hasCompilable-    │              │
             ▼               │  Sources (478)     │              ▼
   ┌─────────────────────┐   └─────────┬─────────┘   已知仓库清单 REPOS_FILE
   │  base 对象          │             │ 是否 dead
   │  cwd/excluded/      │             ▼
   │  lastJob           │     拒绝入总览（仓储/空壳/已删历史保留）
   │  index.js:4736     │
   └─────────┬───────────┘
             │ 现算 wiki 状态
             ▼
   ┌──────────────────────────────────────────────────────────┐
   │  resolveBinary(163) → runCw(status) → parseStatus(294)    │
   │  wikiPathFor(1925) → countWikiArticles(310)               │
   │  失败整行 ──► {state:'error', error}                      │
   └──────────────────────────────────────────────────────────┘
             │
             ▼
   {repos:[{cwd,excluded,lastJob,state,staleArticles,
            changedFiles,wikiPath,articleCount}], scheduler}
```

`parseStatus` / `normalizeArticlePath` 只吃 `cw status` 文本，纯函数；worktree/shell 闸门只调 `git` 与文件系统，均不碰 wiki 写集。`isWorktreeCwd`、`hasCompilableSources` 各自带 TTL 缓存，专门为了压住 `/api/codewiki/jobs`、`/repos` 的 2s 轮询对 git 与文件树的调用频率。

## Data Flow

1. **触发**：面板前端每 ~2s 轮询 `GET /api/codewiki/repos`（handler 注册于 `index.js:4695-4784`）。
2. **缓存命中判定**：先算签名 `wsSig`（`index.js:4711-4717`）= 工作区清单 + 当前非终态任务的工作区；与上次 `reposCache.sig` 不一致或距 `reposCacheAt` 超过 30s 才重算（`index.js:4704`）。
3. **收集候选 cwd**：遍历 `service.list()` 的 job cwd 与 `loadKnownRepos()`（`index.js:2147-2148`），经 `putCwd` 入 `seen` Map——`putCwd` 内部先过 `isDeadCompileTarget` 闸门（`index.js:504`）。
4. **逐行组装**：对每个 `cwd`：
   - `base` 对象含 `excluded = isExcluded(cwd, c.excludePaths)` 与 `lastJob`（取最近一次该 cwd 的 job 摘要，`index.js:4736-4746`）。
   - 同步 `resolveBinary` → `runCw(..., ['status'])` → `parseStatus(stdout)` 得到 `state/changedFiles/staleArticles`（`index.js:294-303`）。
   - `wikiPathFor` 取 wiki 路径 → `countWikiArticles(wp)` 得到 `articleCount`（`index.js:4768-4775`）。
   - 任一环节异常 → 整行降级为 `{...base, state:'error', error}`（`index.js:4760-4762`）。
5. **返回**：`writeJson(res, 200, reposCache)`，含 `repos[]` 与 `scheduler{enabled, intervalMin, lastScan, scanning, lastError, ...}`（`index.js:4531-4546`）。

并行路径：job 列表端点 `/api/codewiki/jobs`（`index.js:504`）也复用 `isDeadCompileTarget`、`isExcluded`、`wsFilterPaths`、`JOB_TERMINAL` 来过滤行，与 repos 总览共用同一套闸门，保证两处对 worktree / 空壳 / 工作区过滤的判断一致。

## Connections

- [[update-record]] — `jobSummary`（`index.js:2277-2330`）、`isTerminalStage`、`TERMINAL` 共同决定总览 `lastJob` 里 `taskList`/`outcome`/`canAdvanceBaseline` 的取值；`isDeadCompileTarget` 用 `JOB_TERMINAL`（`index.js:2175`）判定非终态任务。
- [[engine-bridges]] / [[engine-runtime]] — `nativeChannelFor`、`resolveNativePython`、`runNativeJob` 提供原生引擎通道配置，与 `/repos` 行里的 `channel`/`nativeStage` 等字段同源于 `jobSummary`。
- [[git_helpers]] — `loadKnownRepos`/`rememberRepo`/`forgetRepo` 维护的 `REPOS_FILE` 与 `cw path`/git 状态查询互为补充：git 侧负责「能不能编」，登记侧负责「编过哪些」。
- [[wiki_tests]] / [[misc_tests]] — `parseStatus` 三态、`isDeadCompileTarget` 等由 `test-worktree.mjs`、`test-cwd-paths.mjs`、`test-prune-orphans.mjs` 直接断言。
- 面板 UI 端点链：`/api/codewiki/jobs`（`index.js:4655`）与 `/api/codewiki/repos`（`index.js:4695`）是总览与任务列表两个视图的数据底座，二者闸门一致。
- [[engine_quality_gate]]、`[[update-record]]` 的 `judgeOutcome`/`buildUpdateRecord`：repos 总览 `lastJob` 里带的 `outcome`/`blockers`/`canAdvanceBaseline` 正是这些模块产出的终态，repos 行只是把它们的结论展示出来。
- `test-worktree.mjs` — 直接 import 并断言 `detectLinkedWorktree` / `isWorktreeCwd` / `hasCompilableSources` / `isDeadCompileTarget` 的三态（见 `test-worktree.mjs:11`）。
- `test-cwd-paths.mjs` — 经 `cw.execute({cwd, args:['status']})` 间接覆盖 MSYS/Windows 路径下 `parseStatus` 的真实三态（见 `test-cwd-paths.mjs:48-57`）。

## Known Issues

- **`parseStatus` 只按关键字做字符串包含匹配**（`index.js:294-296`）：任何把 `No wiki found` / `has not been compiled yet` / `Wiki is up to date` 作为正文/文件名出现的场景都会误判三态。当前 `cw status` 输出格式固定（Rust CLI 上游基线），属于可接受依赖；若上游改文案，匹配会静默失效成 `state:'stale'` 的空清单。
- **`countWikiArticles` 是内部非导出函数**（`index.js:310-322`），且对 `wikiPath` 不可读直接返回 `null`——面板 `articleCount` 字段缺失语义（wiki 没建或路径错）与 `0` 篇混为两个状态，消费方需区分 `null` 与 `0`。
- **`isWorktreeCwd` 60s 缓存、`hasCompilableSources` 10 分钟缓存**：新建/删除 worktree、目录内容变化（手动编译后）可能延迟最多 60s / 10 分钟才在总览反映；`clearSourceProbeCache(cwd)` 提供手动清缓存入口（`index.js:494-497`），但 worktree 缓存目前无对应手动清接口（只能等 TTL）。
- **`repos` 端点 30s 缓存 + `wsSig` 失效条件**（`index.js:4711`）：缓存键只含「工作区清单 + 非终态任务工作区」。若一个仓库从无 job 状态、但其 `cw status` 因外部改动（用户手动 `cw index`/改文件）变化，且它本身已是 knownRepo 且非活动，则最多 30s 才刷新——设计上换取 2s 轮询不拖垮 git。
- **`forgetRepo` 只改插件自己的 `REPOS_FILE`**（`index.js:2161-2170`）：误删的用户目录不会从磁盘物理删除，但若该 cwd 同时仍有 job 历史，`putCwd` 仍会通过 job 来源重新登记（knownRepos 是补缺而非唯一来源），不会真正「忘掉」。
- **`workspaceOnly` 过滤依赖宿主 `workspaceRegistry`**（`index.js:4623-4645`）：若宿主注册表 `list()` 抛错，降级为不过滤（返回 `null`），此时所有 knownRepo 与历史 job cwd 都会进总览——是体验降级而非数据错误。
- 无功能性禁用/注释掉的分支；本模块所有函数均处于启用状态。
