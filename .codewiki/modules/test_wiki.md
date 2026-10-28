---
title: test_wiki
type: module
source_files:
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
  - test-prune-orphans.mjs
  - index.js
tags: [test, wiki, anchors, worktree, prune, entry]
---

## Overview

`test_wiki` 是 `dsh-codewiki` 仓库里一组**纯黑盒/集成测试**，专门校验 wiki 编译流水线的四个「会悄悄出错、却不影响编译成功」的环节：

- **锚点校验**（`test-wiki-anchors.mjs`）：扫 `.codewiki/` 下所有文章，把每个 `file:行号` 锚点对照真实源码核对，分「硬断言 / 软报告」两档，避免流水线幻觉出来的行号被编译「成功」地放过。
- **入口与路径规范化**（`test-wiki-entry.mjs`）：校验 `ensureWikiEntry` 缺失时生成双语入口、已有入口绝不覆盖、空 cwd 安全返回；以及 Windows 反斜杠路径在 `normalizeArticlePath` / `normalizeIndexLinks` / `parseStatus` 里的统一收口。
- **worktree / 空壳目录闸门**（`test-worktree.mjs`）：用真实 git 命令搭临时仓库 + linked worktree，验证 `detectLinkedWorktree` / `isWorktreeCwd` / `hasCompilableSources` / `isDeadCompileTarget` 的四态判定。
- **孤儿模块清理**（`test-prune-orphans.mjs`）：`pruneOrphanModules` 会**删文件**，所以测试重点不是「能不能删」，而是「会不会误删」——增量编译、失败文章、非 modules 目录、空清单都必须一个不动。

四条测试全部零依赖第三方断言库（只用 node: 内置模块），各自 `node test-*.mjs` 直接跑、`process.exit(failures ? 1 : 0)` 收尾。

## Key Components

### test-wiki-anchors.mjs — 锚点自动校验脚本（自包含，不 import index.js）

脚本常量与加载逻辑：

- `ROOT` / `WIKI` / `FORCE_STRICT` 常量（37–39）：仓库根、`.codewiki` 目录、`--strict` 强制硬断言开关。
- `readSourceFile(rel, {head, ref})`（57–78）：返回某基准下的「源码视图」（按 `\n` 切行）。三个基准：编译基线版（`ref`，用 `git show ref:rel`）、`HEAD` 版（`git show HEAD:rel`）、工作区版（`fs.readFileSync`）。任一读不到返回 `null`。
- `compiledCommitForViews`（86–91）：从 `.codewiki/_meta.yaml` 的 `last_compiled_commit` 取编译基线 commit。
- `loadSource(rel, preferHead)`（96–118）：返回某文件**所有可用基准**的视图数组（工作区 ∪ HEAD ∪ 编译基线三版，按全文去重）。空数组 = 文件不存在，跳过。
- `SOURCES`（119–122）：预加载 `index.js` / `client.js` 两文件视图（其余引用文件按需 `loadSource`）。
- `compiledCommit` / `META_PATH`（127–133）与 `isFresh(rel)`（135–149）：逐字比较工作区内容与编译基线版是否相同，决定该文件是否「新鲜」（新鲜 → 同步类失败升硬断言；滞后 → 降级软报告）。`FORCE_STRICT` 无条件新鲜；无基线返回 `false`。
- `clSectionsOf(src)`（157–165）：解析 `CHANGELOG.md` 的 `## 版本` 章节区间（按本基准视图算）。
- `CL_VIEWS` / `CL_SECTIONS_OF_VIEW`（166–167）：CHANGELOG 的所有基准视图与章节映射。
- `check(cond, msg)`（172–176）：硬断言，失败 `failures++` 并 `console.error`；返回 `cond` 供 `if (!check(...)) continue`。
- `soft(msg)`（177–180）：软报告，入 `softReports`，绿 `~` 输出。
- `FILE_LIKE`（186）与 `symbolsOnLine(line)`（187–202）：提取行内反引号代码标识符为符号（拒绝文件名、长度 <3 的非符号）；多锚点行有意不做符号绑定（204–211 注释说明这是死代码/会误报）。
- `walk(dir)`（213–222）：递归收集 `.codewiki/` 下所有 `.md`。
- `describeOk(a, views)`（280–288）：通过时打日志，标明是哪个基准解释了该锚点。
- `judgeAnchor({a, src, syms, allFileAnchors, line, label, srcName})`（293–394）：单基准下判定一个锚点。返回 `{ok, msg, kind}`，`kind` 为 `struct`（永远硬失败）或 `sync`（滞后可降级）或 `changelog`（永远软报告）。内含：
  - 起始行越界 → `struct`（297）；
  - 指向空行且区间内也无代码 → `sync`（302–306）；
  - 区间起止无序 / 终点越界 → `struct`（307–310）；
  - CHANGELOG 版本节校验 → `changelog`（321–334）；
  - 唯一锚点行 + 分句归属的符号绑定（358–392）：符号本文件不存在 → `struct`（铁证真错），符号在但不在区间 → `sync`（可能漂移）。

主循环（232–277）：逐文章逐行提取 `file:NN(-MM)` 锚点（正则 241，含 `(?!\.\d)` 防把版本号当行号），对每个锚点逐基准调 `judgeAnchor`，任一通过即整体通过；否则按 `firstKind` 与 `isFresh` 决定硬失败 / 软报告。

### test-wiki-entry.mjs — 入口生成 + Windows 路径规范化

被测 `index.js` 函数（行号指向 index.js）：

- `ensureWikiEntry(cwd, language='中文')`（index.js 372–405）：缺失入口时生成中英双语 `.codewiki` 绝对路径引导文；已有入口返回 `false` 绝不覆盖；`cwd` 为空返回 `false`。
- `normalizeArticlePath(p)`（index.js 280）：把 `\` 统一替换为 `/`。
- `normalizeIndexLinks(cwd)`（index.js 284–292）：只动 `_index.md` 链接头 `[[...|` 到 `|` 之间的 `\`，不碰标题/正文；无改动返回 `false`（幂等）。
- `parseStatus(stdout)`（index.js 294–307）：把 `cw status` 三态输出解析为 `{state, changedFiles, staleArticles}`，两列表都经 `normalizeArticlePath` 规范化。

测试要点（test-wiki-entry.mjs 行号）：① 缺失→生成含 `.codewiki` 绝对路径/`codewiki_generate`/`_architecture.md`/`不会覆盖`（27–32）；② 已有入口不覆盖（38–39）；③ 英文文案（43–46）；④ 空 cwd 返回 false（49）；⑤ 幂等（52–54）；⑥ Windows 路径规范化：`normalizeArticlePath` 的 `\`→`/`（57–59）、`parseStatus` 的 `changedFiles`/`staleArticles` 规范化（60–62）、`normalizeIndexLinks` 链接头规范化且正文反斜杠不动、幂等、无 `_index.md` 静默返回（63–72）。

### test-worktree.mjs — worktree / 空壳目录闸门

被测 `index.js` 函数（行号指向 index.js）：

- `detectLinkedWorktree(cwd)`（index.js 435–451）：用 `git rev-parse --git-dir --git-common-dir` 对比二者归一化路径，不同则返回 `{gitDir, commonDir}`，相同或失败返回 `null`。空值返回 `null`。
- `isWorktreeCwd(cwd)`（index.js 459–470）：`detectLinkedWorktree` 的带缓存版（60s TTL，`WORKTREE_CACHE_TTL_MS` / `worktreeCache` 见 456–458），供 2s 轮询端点使用。
- `hasCompilableSources(cwd)`（index.js 478–492）：目录不存在或 `scanRepoFiles` 扫不出源码即 `false`（10 分钟缓存，`SOURCE_PROBE_TTL_MS` / `sourceProbeCache` 见 476–477）。底层 `scanRepoFiles`（index.js 2192–2215）按黑名单目录 + 二进制后缀 + 单文件 256KB + 总数 2000 扫描。
- `isDeadCompileTarget(cwd)`（index.js 504–512）：worktree（`isWorktreeCwd`）或「目录在但无源码」→ `true`；目录不存在 → `false`（保留历史）。

测试要点（test-worktree.mjs 行号）：用 `spawnSync('git', ...)` 在临时目录 `git init` + 建 linked worktree（19–28），无 git 环境则 `SKIP` 退出 0（30–36）。断言：主工作区→`null`、linked→命中且 `gitDir` 含 `worktrees`/`commonDir` 指向主仓库、不存在路径→`null`（38–43）；worktree 子目录命中（47）；非 git 目录→`null`（52）；空值→`null`（53）；`isWorktreeCwd` 四态 + 缓存一致性（56–62）；空壳目录（`hasCompilableSources`：只剩 `.codewiki` 骨架 → `false`，见 64–70）；`isDeadCompileTarget`：worktree 与空壳都 `true`、不存在目录 `false`、空值 `false`（73–77）。末尾 `git worktree remove --force` 清理（79）。

### test-prune-orphans.mjs — 孤儿模块清理安全边界

被测 `index.js` 函数：

- `pruneOrphanModules(job)`（index.js 342–367）：返回 `{removed, failed, skipped?}`。**只在 `kind==='full'` 且 `plan.modules` 非空数组时动手**（345–347）；只删 `<wikiPath>/modules/*.md`；保留「规划内」（`slugify(name)+'.md'`，351）与「本次写过」（含失败，`job.articles`，353）的文章；删除失败只记账 `failed` 不中断（359–364）。

测试要点（test-prune-orphans.mjs 行号）：`makeWiki()`（19–30）造 4 篇 modules + 1 concepts + 1 根文章；`ls(wiki, sub)`（31）列目录。`check(label, fn)`（14–16）用 `node:assert/strict` 包裹异步用例：
- 全量编译删孤儿、保留规划内（33–42）；
- 本次写过但失败的文章保留（44–55）；
- 增量（`kind='stale'`）一律不动，记 `skipped` 含「非全量」（57–68）；
- 无 `plan.modules` 不删，记「无完整模块清单」（70–77）；
- 空 `modules` 数组不删（最危险输入，79–85）；
- `concepts/` 与 `_architecture.md` 永不被碰（87–96）；
- `modules` 目录不存在安全返回（98–102）；
- 只删 `.md`，不碰 `notes.txt`（104–113）；
- `slugify` 规则与文件名一致：空格/中文模块名匹配自己文章（115–126；`核心应用`→`核心应用.md`、模块/子模块→`模块-子模块.md`、`日志与追踪 (logging)`→`日志与追踪-logging.md`，131–149）；
- 删除失败记账 `failed` 且不拖垮其他孤儿（用 mock `fs.rmSync` 抛 `EBUSY`，153–181）；
- 非空但残缺的 plan 按非空数组当全集（完整性由编排侧保证，186–195）。

`index.js` 侧 `slugify(name)`（index.js 1741–1743）：CJK 保留、非脚本字符转 `-`、空回落 `'module'`——与 `pruneOrphanModules` 第 351 行用的是同一规则，测试正是钉住二者不能漂移。

## Architecture

```text
┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ test-wiki-      │  │ test-wiki-      │  │ test-worktree    │  │ test-prune-      │
│ anchors.mjs     │  │ entry.mjs       │  │ .mjs             │  │ orphans.mjs      │
│ (扫 .codewiki/) │  │ (入口+路径规范) │  │ (git+缓存判定)    │  │ (删文件安全边界)  │
└────────┬────────┘  └────────┬────────┘  └────────┬─────────┘  └────────┬─────────┘
         │ view sources         │ import            │ spawnSync('git')   │ import
         ▼                      ▼                  ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ index.js                                                                          │
│  ensureWikiEntry(372) normalizeArticlePath(280) normalizeIndexLinks(284)          │
│  parseStatus(294)  detectLinkedWorktree(435) isWorktreeCwd(459)                   │
│  hasCompilableSources(478) scanRepoFiles(2192) isDeadCompileTarget(504)           │
│  pruneOrphanModules(342) slugify(1741)                                           │
└───────────────────────────────────────┬──────────────────────────────────────────┘
                                         │ reads
                          ┌──────────────┴──────────────┐
                          ▼                             ▼
                  ┌──────────────┐              ┌────────────────┐
                  │ .codewiki/   │              │ git repo       │
                  │ _meta.yaml   │              │ (HEAD /        │
                  │ *.md,        │              │  worktree)     │
                  │ CHANGELOG.md │              └────────────────┘
                  └──────────────┘
```

四条测试都是 `node` 直接执行的独立脚本（无测试框架），各自 `process.exit(failures ? 1 : 0)`。仅 `test-wiki-anchors.mjs` 不 import index.js，而是直接读 `.codewiki/` 与 git 基线；其余三条从 `./index.js` 导入被测函数（test-wiki-entry.mjs 10、test-worktree.mjs 11、test-prune-orphans.mjs 10）。

## Data Flow

**锚点校验流（test-wiki-anchors.mjs）**：
1. 读 `.codewiki/_meta.yaml` 取 `last_compiled_commit` → `compiledCommit` / `compiledCommitForViews`（86–91、127–133）。
2. `walk(WIKI)` 收集全部 `.md`（213–224），逐行正则抽锚点（241）。
3. 每个锚点 `loadSource(srcName)` 取三基准视图（96–118），逐个 `judgeAnchor`（293–394）。
4. 任一通过即过；否则取首个失败 `kind`：`struct`/`changelog` 永远硬失败，`sync` 且 `!isFresh` 降级软报告（264–274）。
5. 末尾汇总 `passed / failures / softReports`；`failures>0` 退出 1（396–403）。

**入口/路径流（test-wiki-entry.mjs）**：纯函数输入→输出断言，无状态。`ensureWikiEntry` 写盘后读回比对正文关键词（27–46）。

**worktree 闸门流（test-worktree.mjs）**：`git init` + `git worktree add` 建真仓库（21–27）→ 调 `detectLinkedWorktree` 取 `{gitDir, commonDir}` → 派生 `isWorktreeCwd`（带缓存）、`hasCompilableSources`（带探测缓存）、`isDeadCompileTarget`（组合前两者）→ 断言后 `git worktree remove --force` 清理（79）。

**孤儿清理流（test-prune-orphans.mjs）**：`makeWiki()` 造含孤儿/规划内/失败文章的 `modules/`（19–30）→ 调 `pruneOrphanModules({kind, wikiPath, plan, articles})` → 断言 `removed` / 目录残留 / `skipped` / `failed` 是否符合预期（33–195）。

## Connections

- [[index]] — 全部被测函数的实现所在（`ensureWikiEntry`/`normalizeArticlePath`/`normalizeIndexLinks`/`parseStatus`/`detectLinkedWorktree`/`isWorktreeCwd`/`hasCompilableSources`/`isDeadCompileTarget`/`pruneOrphanModules`/`slugify`/`scanRepoFiles`）。
- [[test-batch]] — `index.js` 的 `fixAnchors` / `fixChangelogAnchors` 是 test-wiki-anchors 校验器的**修正器对侧**（二者符号绑定/版本节归属规则必须同源，见 index.js 755–765、807–816 注释），对抗用例在 test-batch.mjs。
- [[incremental]] — `scanRepoFiles` / `hasCompilableSources` 也是 stale 增量编译的规划输入来源之一。
- [[change-set]] — `parseStatus` 解析的 `changedFiles`/`staleArticles` 是变更采集的入口。

## Known Issues

- `test-wiki-anchors.mjs` 的 `--strict` 之外，同步类（空行/版本节/符号绑定）在源文件滞后于编译基线时一律降级为软报告——这是**有意为之**的事实性降级（264–272、314–320），不是测试漏洞；真错误靠「符号在源文件根本不存在」这一 `struct` 铁证兜底（373–389）。
- `test-wiki-anchors.mjs` 的 `symbolsOnLine` 多锚点行绑定逻辑曾被写成 `closest` 启发式但从未调用（死代码，204–211 注释），多锚点行只靠「行号在范围内 + 指向非空行」兜底；真正的对抗用例在 test-batch.mjs 的 `fixAnchors`。
- `test-worktree.mjs` 在无可用 git 环境时**整体 SKIP 退出 0**（30–36），不会误报成功；它依赖 `spawnSync('git', ...)`，CI 必须配 git。
- `test-prune-orphans.mjs` 的「非空但残缺 plan」用例明确钉住一条契约：清理器只认非空 `modules` 数组、完整性由编排侧保证（183–195）。若将来给 plan 加 `completeness` 标志，这条要同步改。
- 删除失败用例（153–181）在 Windows 上 `chmod` 无效，改用 mock `fs.rmSync` 抛 `EBUSY` 来模拟，非真实权限失败。
