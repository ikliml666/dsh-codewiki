---
title: git_helpers
type: module
source_files:
  - index.js
  - lib/change-set.js
  - test-worktree.mjs
  - test-change-set.mjs
tags: [git, worktree, auto-commit, change-collection, repo-scan]
---

## Overview

「git_helpers」不是仓库里独立成文件的模块，而是一组**集中散布在 `index.js` 顶层、并借力 `lib/change-set.js` 的 git 命令封装**的「Git 命令快捷方式 + 仓库判定辅助」函数。它们承担三件事：

1. **git worktree 识别**：`detectLinkedWorktree` / `isWorktreeCwd` 用 `git rev-parse --git-dir` 与 `--git-common-dir` 的解析结果是否一致，判断一个目录是不是 linked worktree（`index.js:435-470`）。判据**只用 git 自己、与目录命名无关**，避免把主仓库与隔离工作区上的同一份代码各编一遍、产物互相覆盖。
2. **仓库可编译性 / 死目标判定**：`hasCompilableSources` / `isDeadCompileTarget` / `clearSourceProbeCache` 扫文件树或读缓存，决定一个目录是否值得提交编译（`index.js:478-512`），与 `scanRepoFiles` 配合（`index.js:2192-2215`）。
3. **产物自动提交**：`autoCommitWiki`（与底层的 `commitHintText`）用一连串 `git` 子命令在主题分支上提交 `.codewiki/` 与 `CodeWiki.md`，再合并回原分支（`index.js:4942-5057`）。
4. **四路变更采集**（上游模块 `lib/change-set.js`）：`collectChangeSet` 用 `git diff --name-status -M` 等把 committed/staged/unstaged/untracked 四路改动收成可序列化对象。

这些函数都**零第三方依赖**，直接 `spawnSync('git', …)`（`index.js`）或 `execFileSync`（`lib/change-set.js:43-49`）。测试（`test-worktree.mjs`、`test-change-set.mjs`）一律在临时目录 `git init` 真实仓库来跑，环境无可用 git 时整体 `SKIP`（见 `test-worktree.mjs:30-36`），不用 mock。

## Key Components

下述全部为 `index.js` 顶层导出函数（除特别注明），行号以 `index.js` 源码前缀为准；`lib/change-set.js` 的组件单独列出。

### Git worktree 识别（`index.js`）

- `detectLinkedWorktree(cwd)`（导出，`index.js:435-451`）：判断 `cwd` 是否为 linked git worktree。
  - 入参 `cwd` 为空 → 直接 `null`。
  - 跑 `spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { cwd, timeout: 5000 })`（`index.js:439-441`）。
  - 退出码非 0 或非 git 仓库 → `null`（放行）。
  - 解析 `gitDir` / `commonDir` 后 `path.resolve`，两者 `normalize` 并小写比较（`index.js:446-449`）；**不同** → 返回 `{ gitDir, commonDir }`，**相同**（主工作区 / submodule）→ `null`。
  - 返回 `null` 或 `{ gitDir, commonDir }` 两个形态（报错文案会带上真实路径）。
- `isWorktreeCwd(cwd)`（导出，`index.js:459-470`）：`detectLinkedWorktree` 的**带缓存版**，布尔语义，给 2s 轮询端点（面板 `/api/codewiki/jobs`）用。
  - 模块级常量 `WORKTREE_CACHE_TTL_MS = 60000`（`index.js:456`）；缓存 `worktreeCache = new Map()`（`index.js:457`）。
  - 缓存键 `normPathKey`（去尾部分隔符 + 小写，`index.js:458`）；命中且未过期直接返回 `hit.wt`，否则调用 `detectLinkedWorktree` 并写入缓存（`index.js:462-469`）。
  - 空值 → `false`；`detectLinkedWorktree` 抛错 → 兜底 `false`。
- 模块级缓存与键函数（私有）：`worktreeCache`、`normPathKey`、`WORKTREE_CACHE_TTL_MS`（分别为 `index.js:456-458`）。

### 可编译性 / 死目标判定（`index.js`）

- `hasCompilableSources(cwd)`（导出，`index.js:478-492`）：目录里是否扫得到任何可编译源文件。
  - 空值 / `statSync` 非目录 → `false`；否则先查 `sourceProbeCache`（TTL `SOURCE_PROBE_TTL_MS = 10*60*1000`，`index.js:476-477`），未命中则 `scanRepoFiles(dir).length > 0`。
  - 带 10 分钟缓存：autoScan 每轮对每个历史仓库调用，大仓库文件树遍历不该每分钟重跑。
- `clearSourceProbeCache(cwd)`（导出，`index.js:494-497`）：手动清探测缓存。
  - 不传 `cwd` → `sourceProbeCache.clear()`；传了 → 只删该 key（`normPathKey`）。手动编译 / checkout 刚完成时调用，别让 10 分钟前的空判定挡住真实提交（`index.js:458` 与 `index.js:477` 调用点）。
- `isDeadCompileTarget(cwd)`（导出，`index.js:504-512`）：统一「不是有效编译对象」判定，面板任务列表 / 仓库总览共用。
  - 空值 → `false`；`isWorktreeCwd(dir)` 为真 → `true`；`statSync` 目录不存在 → `false`（历史任务目录后来被删，记录仍有查看价值，不抹掉）；其余 → `!hasCompilableSources(dir)`。
- 模块级缓存：`sourceProbeCache`、`SOURCE_PROBE_TTL_MS`（分别为 `index.js:476-477`）。

### 仓库源码扫描（`index.js`）

- `scanRepoFiles(cwd)`（导出，`index.js:2192-2215`）：递归扫描仓库可编译文件，供本地规划与 `hasCompilableSources` 使用。
  - 黑名单目录 `SCAN_SKIP_DIRS`（含 `.git`、`.codewiki`、`node_modules`、`vendor`、`dist` 等，`index.js:2178-2182`）；二进制后缀 `SCAN_SKIP_EXT`（`index.js:2183-2188`）。
  - 上限：单文件 `SCAN_MAX_FILE_BYTES = 256*1024`、总数 `SCAN_MAX_FILES = 2000`（`index.js:2189-2190`）。
  - 返回 `{ path: 相对路径, bytes }` 数组；`.` 开头的隐藏目录也跳过（`index.js:2202`）。

### 产物自动提交（`index.js`）

- `autoCommitWiki(cwd, { jobId, writtenCount })`（导出，`index.js:4942-5024`）：把 `.codewiki/` 与 `CodeWiki.md` 提交入库，走「主题分支提交 → 合并回原分支 → 删主题分支」流程；detached HEAD / 建分支失败时降级为直接提交（`mode:'direct'`）。
  - 内部 `run(...args) = spawnSync('git', args, { cwd, timeout: 20000 })`（`index.js:4943-4944`）。
  - 安全闸门（任一不满足则只返回 `{committed:false, reason}` 不提交）：非 git 仓库（`index.js:4966-4967`）、无 HEAD（`index.js:4966`）、合并/变基进行中（`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD`，`index.js:4966-4968`）、目标路径未解决冲突（`index.js:4959`）、被 `.gitignore` 忽略（`index.js:4963-4966`）、未配 `user.name/email`（`index.js:4968-4969`）、无未提交改动（`noChanges`，`index.js:4967`）。
  - 提交只动 `WIKI_PATHS = ['.codewiki', 'CodeWiki.md']`（`index.js:58`）这两个 pathspec，不用 `-A`（`index.js:4933-4934`）。
  - 返回值字段：`{ committed, sha?, message?, noChanges?, reason?, mode?, branch?, fallback? }`（`index.js:4940-4941`）。
- `commitHintText(cwd, jobs)`（导出，`index.js:5026-5057`）：会话系统提示里「产物待提交」提醒文案；读 `git -C cwd log -1 --format=%ct -- .codewiki CodeWiki.md` 与最近 done 任务的 `finishedAt` 比较（`index.js:5038-5052`），两者时差决定是否需要提醒。非 git 仓库 / jobs 读取失败 → 返回空串。带 60s 缓存 `commitHintCache`（`index.js:4934`）。
- `currentCommit(cwd)`（导出，`index.js:1916-1923`）：当前 HEAD 短 sha（`git rev-parse --short HEAD`），非 git 仓库 → `null`。供快照记录「这份图对应哪个提交」。
- `autoCommitState(job)`（导出，`index.js:2350-2355`）：由 `job.autoCommit` 推三态 `committed` / `no-changes` / `pending`，与 `commitHintText`、`wakeCompileSession` 共用同一结论。

### Git 路径归一（`index.js`）

- `normalizeCwd(input)`（导出，`index.js:62-67`）：Windows/Git-Bash 兼容——MSYS 盘符路径 `/e/...` 在 win32 上归一为 `E:/...`，POSIX 上原样保留（文件可能真是绝对路径）。

### 变更采集（`lib/change-set.js`）

- `collectChangeSet(cwd, baseCommit, opts)`（导出，`lib/change-set.js:102-205`）：采集四路变更集。
  - 通过依赖注入 `opts.execFile` 接收执行器，默认 `defaultExecFile` 用 `execFileSync('git', args, { cwd })`（`lib/change-set.js:42-49`、`107`）。
  - 内部 `git(args)` 抽象（`lib/change-set.js:108`）；先 `rev-parse HEAD` 确认仓库有效（`110-125`），再 `cat-file -e <base>^{commit}` 确认基线可达（`127-137`），最后 `diff --name-status -M`（committed/staged/unstaged）+ `ls-files --others --exclude-standard`（untracked）（`141-160`）。
  - 返回 `ChangeSet`：`ok`/`state`/`fallback`/`baseCommit`/`headCommit`/`committed`/`staged`/`unstaged`/`untracked`/`deleted`/`renamed`/`all`/`sourceChanges`/`ignored`。`ok=false` 必带 `state`+`reason` 且 `fallback='full'`（永不假装 clean）。
- `parseNameStatus(out)`（导出，`lib/change-set.js:52-71`）：解析 `git diff --name-status` 输出，处理 R/C 两列路径、D 删除、其余修改。
- `normChangePath(p)`（导出，`lib/change-set.js:33-40`）：路径归一为 POSIX 相对路径，越界（绝对路径 / `../` 跳出）丢弃。
- `isWikiProduct(relPath)`（导出，`lib/change-set.js:26-29`）：判断是否为 `.codewiki/` 产物（不当作源码变更）。
- `CHANGE_SET_VERSION = 1`（导出常量，`lib/change-set.js:19`）。

### 组件字段 / 返回值结构

`detectLinkedWorktree` 返回对象字段（`index.js:435`）：
- `gitDir`：`path.resolve(cwd, <git-dir 原始输出>)`——linked worktree 下形如 `<主仓库>/.git/worktrees/<name>`。
- `commonDir`：`path.resolve(cwd, <git-common-dir 原始输出>)`——指向主仓库 `.git`。

`autoCommitWiki` 返回对象字段（`index.js:4952-4953`）：
- `committed`：布尔，是否成功提交。
- `sha`：提交后 `git rev-parse --short HEAD` 短哈希（成功时）。
- `message`：提交信息，形如 `docs(wiki): 更新 CodeWiki 编译产物（任务 <id>，<n> 篇文章）`。
- `noChanges`：布尔，产物本就无未提交改动。
- `reason`：失败原因（被忽略 / 冲突 / 未配 user / 合并失败等）。
- `mode`：`'branch'`（主题分支合并式）或 `'direct'`（降级直提）。
- `branch`：主题分支名 `codewiki/wiki-<jobId>`。
- `fallback`：`direct` 降级的原因说明。

`ChangeSet` 字段（`lib/change-set.js:73-93`、`187-204`）：`version`、`ok`、`state`（`ok`/`no-git`/`missing-base`/`unreachable-base`/`git-error`/`unknown`）、`fallback`、`reason`、`baseCommit`、`headCommit`，以及 `committed`/`staged`/`unstaged`/`untracked`/`deleted`/`renamed` 六路数组、`all`（含改名两端、去重排序）、`sourceChanges`（排除 `.codewiki/` 后的源码变更）、`ignored`（被排除的 wiki 产物）。

## Architecture

这些 git 辅助函数分散在 `index.js` 顶层，按「编译前闸门 → 编译中落盘 → 编译后提交」三段被编排服务与工具层调用；`lib/change-set.js` 是独立上游模块。核心调用关系（组件名｜文件）：

```text
提交入口（codewiki_generate / svc.submit）
   │  detectLinkedWorktree(cwd) ── 1.2.0 worktree 闸门
   │  clearSourceProbeCache(cwd) → hasCompilableSources(cwd)
   │                                  └─ scanRepoFiles(cwd)  [文件树扫描]
   ▼
编译任务（job）推进阶段机：articles→crosscut→review→index→commit
   │  tickCommit → autoCommitWiki(cwd)  [分支合并式提交 .codewiki/ + CodeWiki.md]
   ▼
增量规划 runStaleUpdate
   │  collectChangeSet(cwd, base)  [lib/change-set.js]
   │     └─ git diff --name-status -M / ls-files --others
   │  readCompiledBaseline → planUpdate
   ▼
面板 / 系统提示
   │  isDeadCompileTarget(cwd)  [jobs/repos 端点过滤]
   │  isWorktreeCwd(cwd)  [60s 缓存，2s 轮询不打爆 git]
   │  commitHintText(cwd)  [60s 缓存，提醒待提交]
   ▼
autoScan（60s 心跳）
      isWorktreeCwd / hasCompilableSources → 跳过 worktree/空壳，避免积压失败任务
```

要点：缓存是避免「每 2s 轮询 × N 任务 × 每次 spawnSync git 冷启动」拖垮宿主事件循环的关键（`isWorktreeCwd` 60s、`hasCompilableSources` 10min）。两个闸门（`detectLinkedWorktree` / `hasCompilableSources`）集中在 `submit`（`index.js:3872-3889`）和 `generateToolDefinition.execute`（`index.js:4056-4077`）两处，覆盖「工具 / 面板 / 自动调度」全部提交路径；`auto` 调度路径对 worktree / 空壳**静默跳过**（返回 `{skipped}`），不污染 note。

## Data Flow

典型数据流（以「手动提交一次编译」为例）：

1. **闸门（编译前）**：`codewiki_generate` 调 `normalizeCwd` 归一路径 → `detectLinkedWorktree(cwd)`（`index.js:435`）。命中 worktree → 非 auto 抛错、auto 返回 `state:'worktree'`。否则 `clearSourceProbeCache` 后 `hasCompilableSources`（走 `scanRepoFiles` 或缓存，`index.js:2192`）→ 空壳则 `state:'no-source'`。两道闸门都过才进 `runCw('status')`（工具走 `git status` 实际是 `cw` 封装，不是裸 `git`）。
2. **增量规划（编译前，stale 路径）**：`runStaleUpdate` 读 `readCompiledBaseline(wikiPath)` 拿到 `_meta.yaml:last_compiled_commit` → `collectChangeSet(cwd, base)`（`index.js:1775`）。`collectChangeSet` 跑 `git rev-parse HEAD` / `cat-file -e <base>^{commit}` / `diff --name-status -M` / `ls-files --others`，产出四路 `ChangeSet`，再交给 `planUpdate` 判「哪篇要写」。
3. **提交（编译后）**：`tickCommit`（`index.js:3716`）对写成功的 job 调 `autoCommitWiki(cwd)`（`index.js:4952`）。它跑 `rev-parse --is-inside-work-tree` → `branch --show-current` → `switch -c codewiki/wiki-<jobId>` → `add -- .codewiki CodeWiki.md` → `commit --no-verify` → `merge --no-edit` → `branch -d`。结果写进 `job.autoCommit`，面板 `/api/codewiki/jobs`（`index.js:4721`）与 `codewiki_progress` 直接展示。
4. **提醒（会话系统提示）**：`commitHintText(cwd)`（`index.js:5036`）读 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 与最近 done 任务的 `finishedAt` 比对；`autoCommitState(job)==='pending'` 且 job 比 git 提交更新 → 注入「产物待提交」提醒。
5. **过滤（面板）**：`/api/codewiki/repos`、`/api/codewiki/jobs` 用 `isDeadCompileTarget`（内含 `isWorktreeCwd` + `hasCompilableSources`）滤掉 worktree / 空壳条目（`index.js:478`、`4717`）。

## Connections

- [[change_set]] — 四路变更采集的实现模块（`lib/change-set.js` 的 `collectChangeSet`），本模块的增量路径直接调用它，且把 `state='missing-base'/'unreachable-base'` 的降级语义退回全量。
- [[engine_python]] — 原生引擎 `lib/engine/python/entry.py` 在 Python 侧另起一套 `git` 调用（init / 提交 / 基线），与本模块 `autoCommitWiki` 是平行的「编译产物入库」两条实现，落地器 `apply-plan.js` 复用 `index.js` 的 `runCw` / `autoCommitWiki`（`index.js:2764-2766`）。
- [[incremental]] — `readCompiledBaseline` 读的 `last_compiled_commit` 来自 `lib/incremental.js` 的快照/基线；`collectChangeSet` 的 `baseCommit` 即此值。
- [[update_planner]] — `planUpdate` 消费 `collectChangeSet` 的 `ChangeSet`，产出 write/keep/review 动作与未映射变更。
- [[engine_runtime]] / [[engine_plan_apply]] — 原生通道 `startNativeRun`（`index.js:2727`）经 `deps.applyDeps.commit` 复用本模块 `autoCommitWiki`。
- [[articles_agentic]] — agentic 写作通道不依赖 git，但 `tickArticles` 的 localPlan 调用 `scanRepoFiles`（`index.js:2192`）做源文件清单。
- 工具层 [[（无对应文章，指 index.js 的 codewiki_generate/update 工具定义）]]：`detectLinkedWorktree` / `hasCompilableSources` 的调用点在 `generateToolDefinition.execute` 与 `svc.submit`。

## Known Issues

- **`autoCommitWiki` 的 merge 失败路径是防御性的、单测构造不出来**（`index.js:4952-4963`）：同步流程内原分支切出后不再前进，merge 恒为 ff；diverged/冲突只来自「编译期间用户在原分支的真实推进」，注释明说单测覆盖不到，靠 `merge --abort` 兜底保留主题分支。这意味着该分支的真实行为只在真实并发场景下才被验证。
- **`hasCompilableSources` 与 `isDeadCompileTarget` 的缓存可能挡住刚 checkout 的目录**：为此 `submit` / `generateDef.execute` 手动路径会先 `clearSourceProbeCache(cwd)`（`index.js:494` 定义，`index.js:5122` 与 `index.js:3876` 调用点），自动调度则不清（靠 10 分钟 TTL 自然过期）。若手动提交仍遇到「空壳误判」，多半是缓存未清或 TTL 内工作区未变。
- **worktree 判定依赖 git 可用**：`detectLinkedWorktree` 在 `git` 缺失或 `rev-parse` 失败时返回 `null`（放行），不会误拦，但也意味着「环境没装 git 时，worktree 与 submodule 都按主工作区处理」——不报错但语义降级（见 `test-worktree.mjs:30-36` 的 SKIP 逻辑）。
- **`scanRepoFiles` 上限 2000 文件 / 256KB**：超大仓库的本地规划输入会被截断（`index.js:2192-2193`），可能影响模块划分完整性，但不是 git 相关缺陷。
- **`commitHintText` 与 `autoCommitWiki` 对 `.gitignore` 的处理边界**：`.codewiki/` 常被项目忽略，`autoCommitWiki` 会显式识别并返回失败原因（`index.js:4952-4955`），而不是静默丢产物；`commitHintText` 因此只在真的「没提成功」时才提醒，避免误扰。
- **未独立成文件**：这些 git 辅助函数都挂在 `index.js` 顶层（5168 行大文件），与编排服务、工具定义混在一起，没有像 `lib/change-set.js` 那样单独抽模块，重构时需注意调用面很广（工具层、服务层、面板、`autoScan` 都用）。
