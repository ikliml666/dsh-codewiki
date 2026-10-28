---
title: misc_tests
type: module
source_files:
  - test-cwd-paths.mjs
  - test-prune-orphans.mjs
  - test-sessions.mjs
  - test-worktree.mjs
  - index.js
tags: [test-suite, paths, orphans, sessions, worktree, integration-tests]
---

## Overview

`misc_tests` 是把四支「杂项集成测试」归到一起的模块：`test-cwd-paths.mjs`（cwd 路径修复）、`test-prune-orphans.mjs`（孤儿模块清理安全边界）、`test-sessions.mjs`（会话记录存储）、`test-worktree.mjs`（git linked worktree / 空壳目录闸门）。四支测试都从 `./index.js` 导入被测函数，绝大多数完全离线（临时目录、临时 git 仓库、`DSH_CODEWIKI_JOBS_FILE` 隔离），只在真实 git/worktree 不可用时才显式 `SKIP`。它们守护的是 `index.js` 里几段「容易悄悄回归、但一回归就让用户全盘出错」的边界逻辑——路径归一化、删文件、会话落盘 TTL、worktree 判定。

统一退出约定：按失败数决定 `process.exit(fails ? 1 : 0)`。

## Key Components

### 被测函数（import 自 index.js）

| 行号 | 函数/常量 | 用途 |
| --- | --- | --- |
| 59-64 | `normalizeCwd(input)` | Windows/Git-Bash 兼容：MSYS 盘符路径（`/e/x`）在 win32 上归一化为 `E:/...`；非 win32 原样返回。 |
| 150-170 | `resolveBinary(cfg)` | 选 cw 可执行文件：`binaryPath` 优先 → PATH 探测（`where`/`which`）→ 捆绑 `bin/cw(.exe)` → 兜底 `'cw'`。 |
| 172-197 | `runCw(binary, cwd, args, timeoutMs, signal)` | spawn cw，返回 `{ exitCode, stdout, stderr, timedOut }`，支持 abort 与 120s 超时。 |
| 271-296 | `pruneOrphanModules(job)` | 全量编译后删 `modules/` 下的孤儿 `.md`；返回 `{ removed, failed, skipped }`。 |
| 364-380 | `detectLinkedWorktree(cwd)` | 用 `git rev-parse --git-dir --git-common-dir` 判 linked worktree；返回 `{ gitDir, commonDir }` 或 `null`。 |
| 388-399 | `isWorktreeCwd(cwd)` | `detectLinkedWorktree` 的 60s 缓存布尔封装（面板 2s 轮询用）。 |
| 407-421 | `hasCompilableSources(cwd)` | 扫出源文件即 `true`；带 10 分钟缓存；目录缺失/非目录返回 `false`。 |
| 433-441 | `isDeadCompileTarget(cwd)` | worktree 或空壳（无源码）判 `true`；目录不存在判 `false`（保留历史）。 |
| 1892 | `SESSION_TTL_MS` | 会话记录 TTL = `24 * 60 * 60 * 1000`（24h）。 |
| 1893 | `SESSIONS_DIR` | `path.join(path.dirname(JOBS_FILE), 'dsh-codewiki-sessions')`。 |
| 1914-1923 | `listSessionRecords(jobId)` | 读某 job 目录下的 `*.meta.json`，按 `n` 倒序。 |
| 1924-1926 | `readSessionRecord(jobId, n)` | 读 `nnn.full.json` 单条全文；不存在返回 `null`。 |
| 1930-1949 | `listAllSessionRecords({ limit, jobIds })` | 跨 job 聚合，按 `startedAt` 倒序，每条带 `jobId`；支持 `limit`/`jobIds` 过滤。 |
| 1952-1972 | `pruneSessionRecords(nowMs, ttlMs)` | 删超 TTL 的记录文件，清空后移除 job 目录；返回删除数。 |
| 1854-1859 | `wikiPathFor(cwd, binary, signal)` | 调 `cw path` 取 wiki 目录；失败兜底 `path.join(cwd, '.codewiki')`。 |
| 1599-1662 | `cwToolDefinition(cfg)`（含 `execute` 1639-1660） | `cw` 工具定义；`execute` 走 `normalizeCwd` → 存在性校验 → `resolveBinary` → `runCw`。 |
| 1670-1672 | `slugify(name)` | 模块名 → 文件名：`lowercase`、非 Han/字母数字/`-/_` 替换成 `-`；空则回落 `'module'`。 |
| 2121-2144 | `scanRepoFiles(cwd)` | 仓库源码扫描：黑名单目录 + 二进制后缀 + 256KB + 总数 2000；`hasCompilableSources` 依赖它。 |

### 测试脚本（本模块四个文件）

#### test-cwd-paths.mjs（72 行）
- `pluginDir`（7）、`repoWin`（8，argv[2] 默认 `E:/ik/.../Wxxy-CampusLogin`）、`msys`（10，`/e/x` 推导）。
- `ctx`（13-18）+ `plugin.apply(ctx, {})`（20）→ 从 `registered.cw` 拿到 `cw` 工具（22）。
- 五段断言：MSYS 路径能跑通（34-45）、Windows 路径 `status` 三态（48-57）、不存在路径干净报错「cwd 不存在」（62-69）、`resolveBinary` 经 `cw path` 间接验证（25-28）、`wikiPathFor` 兜底经成功路径覆盖（59）。
- 注意：`resolveBinary`/`wikiPathFor` 未导出，仅通过 `cw.execute` 成功路径间接验证（27、59 行注释）。

#### test-prune-orphans.mjs（200 行）
- `makeWiki()`（19-30）：造 `.codewiki` 目录：modules 4 篇 + concepts 1 篇 + 根 1 篇。
- `check(label, fn)`（14-16）：收 `pass`/`fails`，逐条打印 `PASS/FAIL`。
- `ls(wiki, sub)`（31）：读目录排序。
- 14 段断言覆盖：全量删孤儿保留规划内（33-42）、失败文章保留（44-55）、增量（kind=stale）一律不动（57-68）、无 `plan.modules` 不删（70-77）、空数组不删（79-85）、concepts/`_architecture.md` 永不被碰（87-96）、modules 目录缺失安全返回（98-102）、只删 `.md`（104-113）、slug 匹配（115-126）、中文/斜杠/括号模块名匹配（131-149）、删除失败记账（153-181）、非空残缺 plan 当全集（186-195）。

#### test-sessions.mjs（69 行）
- `DSH_CODEWIKI_JOBS_FILE`（7）隔离；导入 `SESSIONS_DIR/listSessionRecords/readSessionRecord/pruneSessionRecords/listAllSessionRecords`（8）。
- `rmSync(SESSIONS_DIR, {recursive, force})`（13）先清残留。
- 手工构造 `job_manual`/`job_second` 记录（18-35），断言：`n` 倒序（24-25）、单条全文（27-29）、全局聚合带 `jobId`（36-42）、`limit`/`jobIds` 过滤（40-42）、TTL 清理（45-55，mtime 改 25h 前）、幂等（54-55）、全空 job 目录移除（57-63）。

#### test-worktree.mjs（84 行）
- `DSH_CODEWIKI_JOBS_FILE`（10）隔离；导入 `detectLinkedWorktree/isWorktreeCwd/hasCompilableSources/isDeadCompileTarget`（11）。
- 真实 `git init` + `git worktree add`（21-27）；git 不可用 → `SKIP`（30-36）。
- 断言：主工作区 `null`/linked 命中且 `gitDir` 含 `worktrees`、`commonDir` 指主仓库（38-43）、子目录命中（47）、非 git `null`（52）、空值 `null`（53）、`isWorktreeCwd` 布尔与缓存一致（56-62）、`hasCompilableSources`（64-70，空壳只剩 `.codewiki` 判 `false`）、`isDeadCompileTarget`（72-77）。

## Architecture

```text
┌──────────────────── 临时环境（每个脚本独立进程）────────────────────┐
│  test-cwd-paths.mjs  ──apply()──► cw.execute ─► normalizeCwd       │
│       │                                      resolveBinary/runCw  │
│  test-prune-orphans.mjs ──► pruneOrphanModules(job)               │
│  test-sessions.mjs ──► listSessionRecords / readSessionRecord    │
│                      ──► listAllSessionRecords / pruneSessionRecords│
│  test-worktree.mjs ──► detectLinkedWorktree (spawnSync git)       │
│       │              ──► isWorktreeCwd / hasCompilableSources    │
│       │              ──► isDeadCompileTarget                     │
└───────────────────────────┬──────────────────────────────────────┘
                            │ 导入自 ./index.js
                            ▼
┌─────────────────── index.js（宿主半侧函数，见 [[index]]）────────────┐
│  cwd 路径：normalizeCwd(59) / resolveBinary(150) / runCw(172)      │
│  / wikiPathFor(1854) / cwToolDefinition.execute(1639)             │
│  孤儿：pruneOrphanModules(271) + slugify(1670)                    │
│  会话：SESSIONS_DIR(1893) / list·read·prune·listAll(1914-1972)    │
│  worktree：detectLinkedWorktree(364) / isWorktreeCwd(388)         │
│   / hasCompilableSources(407) / isDeadCompileTarget(433)          │
└───────────────────────────────────────────────────────────────────┘
```

## Data Flow

- **路径修复链路**：`test-cwd-paths.mjs` 把命令行传入的 Windows 形式 `repoWin`（8）推导成 MSYS 形式 `msys`（10），`plugin.apply` 注入后从 `registered.cw` 取工具（22）。`execute`（1639）先用 `normalizeCwd`（59）归一化 `cwd`，再 `fs.existsSync` 校验（1643），然后 `resolveBinary`（150）+ `runCw`（172）跑 `cw path` / `cw status`。MSYS 路径能跑通即证明归一化 + PATH 探测生效（34-45）；不存在路径须抛「cwd 不存在」（1643、67）。
- **孤儿清理链路**：`test-prune-orphans.mjs` 调 `pruneOrphanModules({ kind, wikiPath, plan, articles })`（35、46 等）。被测函数先判 `kind !== 'full'` → `skipped`（274），再判 `plan.modules` 非数组/空 → `skipped`（276），否则读 `modules/` 目录（277、284），按 `slugify(m.name)+'.md'` 算 `planned`（280）与 `touched`（282），非规划非触碰的 `.md` 才 `rmSync` 并 push `removed`；失败 push `failed`（288-293）。删除失败只记账不抛错（291-293）。
- **会话记录链路**：`test-sessions.mjs` 先 `rmSync(SESSIONS_DIR)` 清残留（13），再手工写 `nnn.meta.json`/`nnn.full.json`（20-22）。`listSessionRecords` 读 `*.meta.json` 按 `n` 倒序（1918-1922）；`readSessionRecord` 读 `.full.json`（1925）；`listAllSessionRecords` 跨目录聚合、按 `startedAt` 排序、带 `jobId`（1929-1949）；`pruneSessionRecords` 按 `st.mtimeMs` 超 `ttlMs` 删除（1965-1966），目录清空后 `rmdirSync`（1969）。脚本把 001 文件 mtime 改到 25h 前（46-48）触发 TTL。
- **worktree 判定链路**：`test-worktree.mjs` 用真 git 建主仓库 + linked worktree（21-27），`detectLinkedWorktree` 调 `git rev-parse --git-dir --git-common-dir`（368），`gitDir` 与 `commonDir` resolve 后不同即命中（378）。`isWorktreeCwd`（388）包 60s 缓存；`hasCompilableSources`（407）经 `scanRepoFiles`（2121）判有源码；`isDeadCompileTarget`（433）= worktree 或无源码且无目录缺失。

## Connections

- [[index]] —— 全部被测函数的实现方（`index.js`）：`normalizeCwd`/`resolveBinary`/`runCw`/`wikiPathFor`/`cwToolDefinition`、`pruneOrphanModules`/`slugify`、`SESSIONS_DIR`/会话四函数、`detectLinkedWorktree`/`isWorktreeCwd`/`hasCompilableSources`/`isDeadCompileTarget`、`scanRepoFiles`。
- [[root]] —— 测试套件总览：四支脚本均列于 root.md 的「组 1」表格（182、183、184、185 行），与 `client.js`、其余 `test-*.mjs` 同属仓库验收套件。
- [[lib-article-contract]] —— `test-prune-orphans.mjs` 的「失败文章保留」与文章契约闸门同源精神（坏输出不入库、失败证据不删）；本模块不直连，但同属边界守护。
- [[lib-incremental]] / [[lib-update-planner]] —— `pruneOrphanModules` 的 `planned`/`touched` 集合依赖与任务组装侧 `slugify` 同一文件名规则（115-149 行对照断言），与增量/计划层的模块命名一致性互为回归网。
- [[root]] 的 `test-orchestration` 段落（组 3）—— 端到端编排冒烟里「全局会话聚合接口 + worktree 闸门」（1360-1434）与「空壳目录闸门与面板过滤」（1437-1485）两节，与本文 `test-worktree.mjs`/`test-sessions.mjs` 的单元级断言上下呼应。

## Known Issues

- **`resolveBinary` / `wikiPathFor` 不可直接断言**：两者未导出，`test-cwd-paths.mjs` 只能经 `cw.execute` 成功路径间接验证（27、59 行注释）；捆绑副本的 sha256 一致性由外部完成（28 行注释）。
- **硬编码默认仓库路径**：`test-cwd-paths.mjs` 第 8 行默认 `E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin`，其他机器须用 `argv[2]` 覆盖，否则 MSYS/Windows 段会指向不存在路径（虽仍会被 62-69 的干净报错兜住，但 PASS 不了）。
- **删除失败的 mock 仅在非 Windows 生效**：`test-prune-orphans.mjs` 153-181 用 `chmod`/`rmSync` 造删不掉目标，注释明言「Windows 上 chmod 无效，改用 mock fs.rmSync」——在 Windows 跑时该用例行为不同（依赖 `fsMod.default.rmSync` 覆写）。
- **环境依赖的 SKIP 面**：`test-worktree.mjs` 30-36 依赖可用 git（含 `git worktree add`），不可用则整组 `SKIP`（非误报）；`test-sessions.mjs`/`test-prune-orphans.mjs` 靠 `DSH_CODEWIKI_JOBS_FILE` 隔离，默认 `JOBS_FILE` 在 tmp 与宿主实例共享（1876 行注释）。
- **会话目录命名清洗**：`sessionDirFor`（1896）对 `jobId` 做 `[^\w-]` 清洗；`listAllSessionRecords` 的 `jobIds` 过滤（1937）按清洗后的目录名比对——`jobId` 若含特殊字符会被 sanitize，跨文件聚合时须用同一清洗结果。
- **`pruneOrphanModules` 的完整性契约**：当前实现只要 `plan.modules` 非空数组就当全集（186-195 行注释），完整性由编排侧保证；未来若给 `plan` 加 `completeness` 标志，该断言需同步改。
