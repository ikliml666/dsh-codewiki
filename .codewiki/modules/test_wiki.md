---
title: test_wiki
type: module
source_files:
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
  - test-sessions.mjs
  - index.js
tags: [test, wiki, anchors, entry, worktree, sessions]
---

## Overview

`test_wiki` 不是一个运行时模块，而是**一组针对 wiki 产物的单元测试**，统一收录在仓库根目录的四个 `test-*.mjs` 文件里，覆盖 wiki 流水线的四类产物正确性：

- `test-wiki-anchors.mjs`（403 行）— wiki 文章里「文件:行号」锚点的自动校验。把「锚点必须对照真实源码核对」制度化，分**硬断言**与**软报告**两档，避免文档滞后时被系统性误报淹没。
- `test-wiki-entry.mjs`（76 行）— `CodeWiki.md` 入口的自动生成（`ensureWikiEntry`）与 Windows 路径规范化（`normalizeArticlePath` / `normalizeIndexLinks` / `parseStatus`）。
- `test-worktree.mjs`（83 行）— linked git worktree 检测（`detectLinkedWorktree` / `isWorktreeCwd` / `hasCompilableSources` / `isDeadCompileTarget`），用真实 git 命令搭临时仓库 + linked worktree 验证判据来自 git 而非目录命名。
- `test-sessions.mjs`（68 行）— 会话记录存储冒烟（`SESSIONS_DIR` / `listSessionRecords` / `readSessionRecord` / `listAllSessionRecords` / `pruneSessionRecords`）。

四个文件都通过 `import` 直接拉取 `index.js` 的导出函数做断言，没有一个 mock 框架——纯 `fs` 造临时目录、真 git 命令、真文件读写。运行方式均为 `node test-xxx.mjs`（anchors 额外支持 `--strict`）。所有测试以 `failures` 计数驱动 `process.exit(failures ? 1 : 0)`（如 `test-wiki-anchors.mjs:403`、`test-wiki-entry.mjs:76`）。

## Key Components

下面按四个测试文件分别列出「被测导出函数」与「测试文件内部的辅助/断言组件」。行号取自 `index.js`（被测方）与四个 `test-*.mjs`（测试方）。

### test-wiki-anchors.mjs — 锚点校验器（被测：index.js 内的 `fixAnchors` 系列同源逻辑）

该测试**不依赖被测函数**，而是独立重实现一套锚点判定，与 `index.js` 的 `fixAnchors` / `fixChangelogAnchors`（见 `index.js:789` 注释「符号提取规则复制自 test-wiki-anchors.mjs symbolsOnLine」）保持同源规则，用来对抗校验流水线产物。

测试文件内部组件（全部在 `test-wiki-anchors.mjs`）：
- `readSourceFile(rel, { head, ref })` — `test-wiki-anchors.mjs:57`：加载某源文件三种基准视图——编译基线版（`git show <ref>:<rel>`）、HEAD 版（`git show HEAD:<rel>`）、工作区版（`fs.readFileSync`）。三者任一可解释该锚点即通过。
- `compiledCommitForViews`（IIFE） — `test-wiki-anchors.mjs:86`：从 `.codewiki/_meta.yaml` 的 `last_compiled_commit` 读出编译基线 commit，作为第三个基准。
- `loadSource(rel, preferHead)` — `test-wiki-anchors.mjs:96`：返回该锚点所有可用基准下的源码视图数组（工作区在前，HEAD 次之，编译基线最后），按全文去重。
- `isFresh(rel)` — `test-wiki-anchors.mjs:135`：逐字比较工作区与编译基线，判断源文件是否新鲜；`FORCE_STRICT` 或基线缺失时分别无条件新鲜/滞后。
- `clSectionsOf(src)` — `test-wiki-anchors.mjs:157`：解析 CHANGELOG 的 `## 版本` 章节区间（与 `index.js:789` `changelogSections` 同源）。
- `symbolsOnLine(line)` — `test-wiki-anchors.mjs:187`：提取行内反引号代码标识符（带字符下标），过滤掉文件名/短符号（与 `index.js:1003` `symbolsWithPos` 同源）。
- `walk(dir)` — `test-wiki-anchors.mjs:213`：递归收集 `.codewiki/` 下全部 `.md` 文章。
- `check(cond, msg)` — `test-wiki-anchors.mjs:172`：硬断言，失败累加 `failures`。
- `soft(msg)` — `test-wiki-anchors.mjs:177`：软报告，记入 `softReports`（不算失败）。
- `describeOk(a, views)` — `test-wiki-anchors.mjs:280`：通过时打印是哪套基准解释了该锚点。
- `judgeAnchor({ a, src, syms, allFileAnchors, line, label, srcName })` — `test-wiki-anchors.mjs:293`：在单个基准下判定锚点。返回 `{ ok, msg, kind }`，`kind` 为 `'struct'`（结构事实，永远硬失败）或 `'sync'`（同步事实，滞后时降级软报告）或 `'changelog'`（CHANGELOG 追加式漂移，永远软报告）。

### test-wiki-entry.mjs — 入口生成 + Windows 路径（被测：index.js）

被测导出函数（行号取自 `index.js`）：
- `ensureWikiEntry(cwd, language)` — `index.js:381`：仓库根缺失 `CodeWiki.md` 时生成中文/英文入口（含 `.codewiki` 绝对路径、`codewiki_generate` 工具名、架构总览指引、声明不覆盖人工入口）；已有入口或空 cwd 返回 `false` 不覆盖。
- `normalizeArticlePath(p)` — `index.js:289`：把 `\` 替换成 `/`（纵深防御 Windows 旧二进制输出）。
- `normalizeIndexLinks(cwd)` — `index.js:293`：把 `_index.md` 里 `[[link|title]]` 链接头的 `\` 规范化为 `/`，只动链接头；无改动返回 `false`，文件不存在静默跳过。
- `parseStatus(stdout)` — `index.js:303`：解析 `cw status` 三态输出（missing/uncompiled/clean/stale），每行 `M` 进 `changedFiles`、`!` 进 `staleArticles`，二者都过 `normalizeArticlePath`。

测试文件内部组件（在 `test-wiki-entry.mjs`）：
- `check(cond, msg)` — `test-wiki-entry.mjs:13`：统一断言。
- `repo(name)` — `test-wiki-entry.mjs:19`：在临时根下造一个子仓库目录。
- 第 6 组用例（Windows 路径规范化，`test-wiki-entry.mjs:59` 起）：逐一验证 `normalizeArticlePath` 的 `\`→`/`、原样保留、`undefined` 安全返回空串；`parseStatus` 对 changedFiles / staleArticles 的 `\` 规范化；`normalizeIndexLinks` 改链接头、不动正文反斜杠、幂等、无 `_index.md` 静默返回 `false`。

### test-worktree.mjs — worktree / 空壳闸门（被测：index.js）

被测导出函数（行号取自 `index.js`）：
- `detectLinkedWorktree(cwd)` — `index.js:444`：用 `git rev-parse --git-dir --git-common-dir` 判读，两者 resolve 后不同即 linked worktree，返回 `{ gitDir, commonDir }`，否则 `null`（主工作区、非 git、空值、路径不存在均返回 `null`）。
- `isWorktreeCwd(cwd)` — `index.js:468`：带 60s 缓存的布尔封装，轮询端点用（见 `index.js:472` 注释）。
- `hasCompilableSources(cwd)` — `index.js:487`：带 10 分钟缓存，扫目录是否还有可编译源文件（`scanRepoFiles` 长度 > 0）；目录不存在/非目录返回 `false`。
- `isDeadCompileTarget(cwd)` — `index.js:513`：统一判定「不是有效编译对象」—— linked worktree 或「目录在但扫不出源码」返回 `true`；目录已不存在返回 `false`（保留历史记录）；空值返回 `false`。

测试文件内部组件（在 `test-worktree.mjs`）：
- `setup` / `git(...args)` — `test-worktree.mjs:19`-`27`：用 `spawnSync('git', ...)` 建临时仓库 + linked worktree；环境无 git 时 `SKIP` 而非误报（`test-worktree.mjs:32`）。
- `check(cond, msg)` — `test-worktree.mjs:14`：随 `WORKTREE_CACHE_TTL_MS`（60000）、`SOURCE_PROBE_TTL_MS`（10 分钟）断言缓存命中一致性。
- 测试覆盖：`detectLinkedWorktree` 主工作区→null、linked→命中且 `gitDir` 含 `worktrees`、`commonDir` 指主仓库、子目录命中、非 git→null、空值→null；`isWorktreeCwd` 布尔封装与缓存；`hasCompilableSources` 空壳（只剩 `.codewiki`）；`isDeadCompileTarget` worktree/空壳算 dead、不存在目录不算。

### test-sessions.mjs — 会话记录存储（被测：index.js）

被测导出常量/函数（行号取自 `index.js`）：
- `SESSIONS_DIR`（常量）— `index.js:1846`：会话记录根目录 `<tmp>/dsh-codewiki-sessions/<jobId>/`，由 `JOBS_FILE` 同级推导。
- `listSessionRecords(jobId)` — `index.js:1867`：读某 job 下全部 `*.meta.json`，按 `n` 倒序（最新在前）。
- `readSessionRecord(jobId, n)` — `index.js:1877`：读 `(jobId, n)` 对应的 `nnn.full.json` 全文（prompt/output），不存在返回 `null`。
- `listAllSessionRecords({ limit, jobIds })` — `index.js:1883`：跨任务聚合，按 `startedAt` 倒序（缺失退到 `n`），每条带 `jobId`，支持 `limit` 与 `jobIds` 过滤。
- `pruneSessionRecords(nowMs, ttlMs)` — `index.js:1905`：删超 TTL（默认 `SESSION_TTL_MS` = 24h，`index.js:1845`）的记录文件，目录空了则移除，返回删除数。

测试文件内部组件（在 `test-sessions.mjs`）：
- `check(cond, msg)` — `test-sessions.mjs:11`：统一断言；运行前先 `fs.rmSync(SESSIONS_DIR)`，保证断言稳定（`test-sessions.mjs:13`）。
- 手工构造记录（`test-sessions.mjs:17` 起）：直接写 `001.meta.json` / `001.full.json` 等文件形态验证三导出函数（因 `beginSessionRecord` 是私有，`index.js:1937`）。
- TTL 清理用例（`test-sessions.mjs:45` 起）：把 `001` 两个文件 `mtime` 改到 25h 前，断言 `pruneSessionRecords(Date.now())` 删 2 个、保留未过期记录、幂等、job 目录全空后移除。

## Architecture

四个测试文件各自独立，但都与 `index.js` 的同一组导出函数耦合。整体结构如下（框内标注组件名与文件:行）：

```text
┌───────────────────────────── index.js (被测实源) ─────────────────────────────┐
│ ensureWikiEntry:391   normalizeArticlePath:299  normalizeIndexLinks:303        │
│ parseStatus:313       detectLinkedWorktree:454  isWorktreeCwd:478              │
│ hasCompilableSources:497  isDeadCompileTarget:523  SESSIONS_DIR:1987           │
│ listSessionRecords:2008  readSessionRecord:2018  listAllSessionRecords:2024   │
│ pruneSessionRecords:2046  (+ 私有的 beginSessionRecord:2078 等)                │
└───────────────────────────────────────────────────────────────────────────────┘
        │ import 直接拉取导出函数                 ▲ 同源规则（符号/章节解析）
        ▼                                        │
┌─ test-wiki-entry.mjs:10 ─┐  ┌─ test-worktree.mjs:11 ─┐  ┌─ test-sessions.mjs:8 ─┐
│ repo() 造临时目录         │  │ git worktree add 真仓库 │  │ 手写 *.meta/full.json  │
│ check() 断言              │  │ check() 断言            │  │ check() 断言           │
└────────┬─────────────────┘  └────────┬───────────────┘  └─────────┬──────────────┘
         │                             │                            │
┌─ test-wiki-anchors.mjs ─────────────────────────────────────────────────────┐
│ 独立重实现 judgeAnchor:293 / loadSource:96 / isFresh:135 / symbolsOnLine:187 │
│ 三基准视图(工作区∪HEAD∪编译基线) 对抗 fixAnchors:946 同源规则                 │
└──────────────────────────────────────────────────────────────────────────────┘
        │ 全部经 node test-*.mjs 运行，failures 计数 → process.exit(1)
        ▼
 退出码 0 = 全过；非 0 = 有硬断言失败
```

关键设计点：
- **anchors 测试不调用被测函数**，而是自带一套「同源但独立」的判定（`judgeAnchor` 与 `index.js:946` 的 `fixAnchors` 共享符号提取/CHANGELOG 章节规则），目的是做对抗校验——它能抓住 fixAnchors 没修对的锚点。注释 `test-wiki-anchors.mjs:293` 明确要求「两处同源，改一处须同步另一处」。
- **worktree / sessions 测试直接 import 被测函数**做黑盒断言；worktree 还用真实 `git` 子进程搭环境，避免目录命名假阳性。

## Data Flow

四个测试的数据流各不相同，分别说明：

**test-wiki-anchors.mjs**
```
读取 .codewiki/_meta.yaml:last_compiled_commit
  └─► compiledCommitForViews / compiledCommit (test:86,128)
        │
        ▼
walk(.codewiki/) 收集全部 .md (test:213,224)
        │ 逐行正则匹配 file:NN(-MM) 锚点 (test:241)
        ▼
loadSource(rel) → 工作区∪HEAD∪编译基线 三视图 (test:96)
        │
        ▼
对每个锚点 × 每个视图 调 judgeAnchor (test:293)
  kind='struct'  → 越界/区间无序/符号不存在 → 永远硬失败
  kind='sync'    → 空行/符号未绑定，仅当 isFresh→false 时降级软报告
  kind='changelog'→ CHANGELOG 版本节漂移 → 永远软报告
        │
        ▼
passed / failures / softReports 汇总 → exit(failures>0?1:0) (test:402)
```

**test-wiki-entry.mjs**
```
repo(name) 造临时目录 (test:19)
  → ensureWikiEntry(dir, lang) 返回 true 并写 CodeWiki.md (index:391)
  → 断言正文含 .codewiki 路径 / codewiki_generate / 不覆盖声明
空 cwd → 返回 false 不抛错 (index:392)
Windows 组 → normalizeArticlePath/parseStatus/normalizeIndexLinks 路径反斜杠归一 (index:299,313,303)
```

**test-worktree.mjs**
```
git init 主仓库 → git worktree add 建 linked (test:21-27)
  → detectLinkedWorktree(main) === null，detectLinkedWorktree(linked) 命中 (index:454)
  → isWorktreeCwd() 布尔封装 + 60s 缓存一致性 (index:478)
  → hasCompilableSources(shell 只剩 .codewiki) === false (index:497)
  → isDeadCompileTarget(linked/shell) === true，不存在目录 === false (index:523)
环境无 git → 打印 SKIP 并 exit(0) (test:30)
```

**test-sessions.mjs**
```
fs.rmSync(SESSIONS_DIR) 清空 (test:13)
手写 001.meta.json / 001.full.json (test:20-22)
  → listSessionRecords(job) 按 n 倒序 (index:2008)
  → readSessionRecord(job,1) 读 full 全文 (index:2018)
  → listAllSessionRecords() 跨 job 聚合 + limit/jobIds 过滤 (index:2024)
utimesSync 改 mtime 到 25h 前 (test:46)
  → pruneSessionRecords(Date.now()) 删超 TTL 文件 + 空目录移除 (index:2046)
```

## Connections

- [[index]] — 被测实源，`test_wiki` 里全部导出函数（`ensureWikiEntry`、`detectLinkedWorktree`、`SESSIONS_DIR` 等）都在 `index.js` 定义。
- [[test-batch]] — `test-batch.mjs` 里的 `fixAnchors` 对抗用例是锚点「行号在范围内 + 指向非空行」兜底的真正钉死方（见 `test-wiki-anchors.mjs:211` 注释）。
- [[test-orchestration]] — 整轮编排里 `ensureWikiEntry` 在收尾阶段被调用（入口门控收紧见 `index.js:381` 注释）；`beginSessionRecord`（私有，`index.js:1937`）由并发池 `runRealtimeTasks`（`index.js:671`）的 `onRequestStart` 挂钩驱动。
- [[test-engine-output]] / [[test-engine-bridge]] — 会话通道（`classifySessionTask` `index.js:1985`、`buildSessionSteerText` `index.js:2002`）与会话记录共享同一个临时目录体系；`SESSIONS_DIR` 与 `SESSION_TASK_DIR`（`index.js:1824`）同源推导。

## Known Issues

- **anchors 测试与 fixAnchors 必须同源维护**：`test-wiki-anchors.mjs:211` 指出符号提取规则复制自 `fixAnchors` 内部的 `symbolsWithPos`（`index.js:992`）、CHANGELOG 章节规则复制自 `changelogSections`（`index.js:779`）。两处若各改一套归属判据会陷入「修正器认为已对、校验器判错」的死循环（见 `index.js:936`）。
- **CHANGELOG 锚点永远软报告**：`test-wiki-anchors.mjs:320`、`index.js:789` 一致——追加式流水账导致历史锚点必然单向下移，要求它们落在正确版本节内不可满足，故只报告不判负；真正兜底靠 `## X.Y.Z` 标题稳定锚 + `fixChangelogAnchors` 落盘前重定位（`index.js:799`）。
- **多锚点行（一行并列多个 `file:NN`）不做符号绑定**：`test-wiki-anchors.mjs:204` 注释说明曾写过的「取离锚点最近符号」启发式函数是死代码、从未被调用；多锚点行价值由「行号在范围内 + 指向非空行」兜底。
- **worktree 测试环境依赖 git**：无可用 git（或 hooks 干扰）时整体 `SKIP` 并 `exit(0)`（`test-worktree.mjs:32`），不会误报成功，但也意味着 CI 无 git 时该闸门的覆盖被跳过。
- **sessions 测试不测 `beginSessionRecord`**：该函数为私有（`index.js:1937`），测试通过手工构造 `*.meta.json` / `*.full.json` 文件形态（`test-sessions.mjs:17`）间接验证 `list/read/prune/all` 三套导出函数，并未验证流式 `onDelta` 节流写盘路径。
- **`isDeadCompileTarget` 的「目录不存在」边界**：`index.js:513` 显式对不存在目录返回 `false`（保留历史记录），而空壳（只剩 `.codewiki`）返回 `true`——两个看似相反的边界需靠 `test-worktree.mjs:76` 的断言守住，回归时容易踩反。
