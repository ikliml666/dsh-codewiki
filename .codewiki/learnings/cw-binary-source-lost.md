---
title: cw-binary-source-lost
type: learning
source_files:
  - index.js
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - CHANGELOG.md
  - .gitignore
  - README.md
  - vendor/codewiki/src/config.rs
  - vendor/codewiki/src/main.rs
  - vendor/codewiki/FORK.md
tags: [cw-cli, binary, path-separator, windows, lesson, defense]
---

## Overview

本文记录 `cw`（Rust 编写的 CodeWiki CLI）二进制的「源码丢失 / 重建 / 再漂移」教训，以及当前代码里「Windows 反斜杠路径」这条防线到底落在哪、为什么有两层。写给对一个 cw 二进制 / `vendor` 目录 / 路径规范化毫无上下文的未来 agent。

三段式历史（时间线以 CHANGELOG 为准）：

1. **起因（0.5.0.1，CHANGELOG.md:665-674）**：`cw` 曾以 `cargo install --path` 方式编译安装，Rust 源码留在系统临时目录（`Temp/cw-src`），临时目录被清理后真源码永久丢失。当时 `vendor/codewiki` 只是上游的**过期快照**——它本身基于「中心目录 `~/.codewiki`」旧架构（见 `vendor/codewiki/src/config.rs:6-9` 的 `wiki_home()`），而现役二进制基于「wiki 在 `<repo>/.codewiki`」的新架构，于是「改 vendor 源码再编译」得到的是另一种架构的产物（`cw index` 报 `No wiki found`，对应 `vendor/codewiki/src/main.rs:284-286` 的 bail 分支）。源码改不了，只能在插件层收口：`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks` 全部是这一阶段的产物（见下方 Key Components）。
2. **重建（0.5.0.2，CHANGELOG.md:652-657）**：取证确认上游 main `64323823b6767d74af732f742c67ed75371c4f0d`（2026-04-06）与 vendor 快照逐字节一致、魔改面收敛到单点后，把 `vendor/codewiki` 重建为本地 fork：`config.rs` 重施「仓库内化」魔改（`vendor/codewiki/src/config.rs:37-42`）、`main.rs` 新增 `rel_path_string()` 把路径渲染统一成 `/`（`vendor/codewiki/src/main.rs:337-339`），Rust 层根治下沉、插件层规范化降级为纵深防御，文档化在 `vendor/codewiki/FORK.md`。
3. **当前现状（本文要修正的核心）**：`vendor/codewiki/` 已**不在工作树中**——仓库根 `list_files` 深度 3 查不到任何 `vendor/` 目录，`.gitignore` 也只忽略 `vendor/codewiki/target/`（`.gitignore:2`）而非 `vendor/codewiki/` 本身，说明它曾被跟踪后于某一刻消失。`bin/cw.exe`（及安全网 `bin/cw.exe.bak-20261010`，命中 `.gitignore:5-6` 的 `bin/*.bak-*` 规则）仍是仓库内唯一被跟踪的二进制耐久产物；`README.md:85-87` 仍写「`vendor/codewiki/ 上游源码（去除 .git）` / 改了 vendor 记得重编」，已与现状不符。

**结论（本文存在的价值）**：Rust 层的 `rel_path_string` 根治已无法从仓库源码重建或验证当前 `bin/cw.exe` 到底带不带这个修复；插件层的 `normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks` 因此从「纵深防御」回升为**唯一确定性防线**。这解释了「为什么代码里有两套路径规范化」「为什么 `resolveBinary` 的 PATH 优先是危险的」「为什么这个二进制没有可重建的源码、只有 `bin/cw.exe` 能信」。

## Key Components

### 插件侧：二进制定位与进程封装

- **`resolveBinary`**（`index.js:140-160`）：决定调用哪个 `cw`。优先级为 `cfg.binaryPath`（`index.js:141`）→ PATH 探测（Windows 用 `where` `index.js:146`、POSIX 用 `which` `index.js:152`）→ 插件自带 `bin/cw(.exe)` 兜底（`index.js:157-158`）→ 裸字符串 `cw`（`index.js:159`）。`index.js:142-143` 的注释写明 **PATH 优先**的理由：用户安装的 `cw` 与其 codewiki 源码同步演进，捆绑副本只在 PATH 找不到时兜底。⚠️ 由于 `vendor/codewiki` 已不在工作树，PATH 上装的 `cw` 当前**无法用仓库源码验证**其架构/修复版本——这是本学习页的危险点。
- **`runCw`**（`index.js:162-187`）：`spawn` 封装（`index.js:12` 引入 `spawn`/`spawnSync`），收集 stdout/stderr；超时（默认 120s，`index.js:162` 形参 `timeoutMs`、定时器 `index.js:164-167`）与 abort（`index.js:29-30`）都走 `child.kill('SIGKILL')`，统一 resolve 成 `{ exitCode, stdout, stderr, timedOut }`（error 分支 `index.js:140-144`、close 分支 `index.js:181-185`）。所有 `cw` 子命令（init / status / index / meta update / path / projects）都经它；`cw` 工具暴露的子命令白名单是 `CW_SUBCOMMANDS`（`index.js:29`），工具 execute 校验链在 `index.js:1562-1583`（启用开关 `index.js:1564`、cwd 归一化与存在性 `index.js:1565-1566`、args 非空 `index.js:1567-1568`、白名单 `index.js:1569-1571`），实际执行在 `index.js:1572-1573`（`resolveBinary` + 120s `runCw`）。
- **`wikiPathFor`**（`index.js:1633-1638`）：跑 `cw path`（30s 超时 `index.js:1634`）取 wiki 目录；失败时回退到仓库内 `.codewiki`，`index.js:1637` 注释注明「与 wiki_path() 一致：wiki 在仓库内」——这条「仓库内化」契约正是 0.5.0.2 fork 的魔改点，现在只能靠二进制行为与这段注释保证。
- **`readSourceFiles`**（`index.js:1613-1621`）：读文章 frontmatter 的 `source_files`；stale 逐篇更新时用它决定给模型喂哪些源码（解析细节拆在 `parseSourceFiles` `index.js:1599-1611`，同时支持行内数组 `[a,b]` 与缩进列表 `- a` 两种写法；无 `source_files` 的文章返回空数组）。stale 任务的 mission 文案来自 `batchArticleComposePrompt`（`index.js:1434`）与其他 prompt 构造器——“更新过期文章 … 以当前代码为准重写其内容，保留章节结构与 title/type/tags”——本文正是这条流水线的产物。

### 插件侧：路径规范化的两层防线（0.5.0.1 遗产，当前唯一确定性防线）

- **契约注释**（`index.js:189-198`）：把 `cw` 的三态输出与逐行清单固化成契约——`No wiki found. Run \`cw init\` first.` / `Wiki has not been compiled yet.` / `Wiki is up to date.` / `Changed since last compile (<hash>):` 加 `  M <file>` / `Stale articles:` 加 `  ! <article>`。注释首行（`index.js:189`）仍声明「本地 fork，源码 vendor/codewiki，行为基线上游 main 64323823」，历史段（`index.js:196-198`）仍写「见 vendor/codewiki/FORK.md 与 .codewiki/learnings/cw-binary-source-lost.md」——**FORK.md 已不在工作树，这段注释本身是漂移点，但保留作历史记录**。
- **`normalizeArticlePath`**（`index.js:199`）：单行纯函数，把反斜杠统一替换为正斜杠；对 `undefined` 安全返回空串。是 `parseStatus` 和 stale 清单进插件后第一道规范化。
- **`parseStatus`**（`index.js:213-226`）：先用子串判定 `missing` / `uncompiled` / `clean` 三态（对应 `index.js:215-217`）；其余一律 stale，再用 `matchAll(/^\s+[M!]\s+(.+)$/gm)` 逐行分流（`index.js:220`）：`M` 走 changedFiles、`!` 走 staleArticles（两者都过 `normalizeArticlePath`，`index.js:222-223`）。
- **`normalizeIndexLinks`**（`index.js:203-211`）：`cw index` 直接写盘 `_index.md`，本函数事后只修链接头（动机注释 `index.js:3049-3050`）——只替换 `[[` 到 `|` 之间那段的反斜杠（正则在 `index.js:207`），正文里的 `E:\ik\repo` 之类不受影响；文件不存在静默返回 `false`（`index.js:206`），无改动也返回 `false`（`index.js:208`），写回在 `index.js:209`，天然幂等。由 `tickIndex` 在 `cw index` 成功后调用（`index.js:3074`），命中时记 note「_index.md 链接路径已规范化（\ → /）」。
- **`countWikiArticles`**（`index.js:229-241`）：递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），总览卡展示用（注释 `index.js:228`）。

### 插件侧：索引收尾、入口补建与产物提交

- **`tickIndex`**（`index.js:3049-3121`）：编译流水线的 index 阶段。仅当 `job.writtenCount > 0` 才动手（`index.js:261`）；先清孤儿模块文章（`index.js:203`，实现 `pruneOrphanModules` 在 `index.js:291-316`），取二进制（`index.js:4226`）后依次跑 `cw index` 与 `cw meta update`（`index.js:3070-3071`），退出码写进 note（`index.js:3072`），任一非 0 再补「编译基线可能未刷新」提示（`index.js:3073`）；`cw index` 成功后再调 `normalizeIndexLinks`（`index.js:3074`）。随后按 `symbolIncremental` 开关写符号快照（`index.js:3081-3102`，供下次 stale 做组件级比对），再 `ensureWikiEntry` 补建入口（调用点 `index.js:3104`，失败只记 note `index.js:3105-3107`）。收尾不再直接置终态：有产物且 `autoCommit` 开启时切到独立 `commit` 阶段（`index.js:3114-3116`，0.10.11 起），否则直接 `done` + 唤醒（`index.js:3118-3120`）。若一篇都没写成功，走「跳过 index/meta update」分支（`index.js:3108-3110`）。
- **`tickCommit`**（`index.js:3123-3139`）：0.10.11 新增的提交阶段。调 `autoCommitWiki`（`index.js:3128`）并按三态记 note——成功（分支合并式 `index.js:3130-3131`、直接提交 `index.js:3132` 两种文案）、无改动（`index.js:3133`）、失败（`index.js:3134`）；然后 `done` + `finishedAt` + `onSettled` 唤醒发起会话（`index.js:3136-3138`）。中途死在本阶段的任务重启后重跑，`autoCommitWiki` 对已入库产物报 noChanges，幂等。
- **`autoCommitWiki`**（`index.js:4186-4268`）：产物提交的唯一实现。完整安全边界注释在 `index.js:45-53`。pathspec 由 `WIKI_PATHS` 唯一定义（`index.js:4217`），磁盘存在性筛选在 `index.js:4193`。前置安全检查全部在分支切换之前：非 git 仓库（`index.js:4197`）、无 HEAD（`index.js:4198`）、merge/rebase/cherry-pick 进行中（`index.js:4200-4201`）、未解决冲突（`index.js:4203`）、路径被 ignore（`index.js:4207-4210`）、无改动（`index.js:4211`）、缺 git 身份（`index.js:4212-4213`）。提交信息在 `index.js:4216`（`docs(wiki): 更新 CodeWiki 编译产物`），`commitOn` 闭包在 `index.js:4217-4229`（`git add -- <paths>` `index.js:4219`、暂存核对 `index.js:4222`、git commit --no-verify `index.js:4226`）。随后走分支合并式：detached HEAD 或建分支失败降级为直接提交（`index.js:4232-4241`）；进入主题分支 `codewiki/wiki-<jobId>`（`index.js:4237`）后任何失败先切回原分支（`index.js:4242-4248`）；合并回原分支（`index.js:4253`），失败则中止合并、保留主题分支（`index.js:4254-4261`）；成功后 `git branch -d` 删主题分支（`index.js:4263`）。
- **`ensureWikiEntry`**（`index.js:291-324`）：仓库根缺 `CodeWiki.md` 则生成入口，已有入口绝不覆盖（`index.js:3435`）；空 cwd 安全返回 false（`index.js:292`）。入口文案分两套：中文模板 `index.js:297-308`、英文模板 `index.js:310-320`；语言判定在 `index.js:296`（`/中文|zh/i`），调用点传 `job.language`（`index.js:3104`）。动机注释在 `index.js:288-290`：收尾提醒门控被收紧到仓库根入口文件（139052c），但流水线此前从不创建它，形成「编译过但无入口 → 永远收不到收尾提醒」的不变量缺口（另见 [[learnings/update-reminder-entry-gap|update-reminder-entry-gap]]）。
- **入库三态统一判定 `autoCommitState`**（`index.js:2032-2037`）：`committed` / `no-changes` / `pending` 三态，`wakeCompileSession`（`index.js:2039-2054`）与 `commitHintText`（`index.js:4270-4301`）共用；`wakeCompileSession` 的静默守卫在 `index.js:2043`——已提交或本就无改动完全不打扰会话；`commitHintText` 的提醒也只在 `pending` 时出现（`index.js:4314-4315`），其门控（仅当仓库根存在 `CodeWiki.md`）在 `installUpdateReminder` 的 section text 回调里（`index.js:4329-4330`）。

### fork 侧：Rust 源码（当前工作树已缺失）

0.5.0.2 时 `vendor/codewiki/` 是本地 fork：`config.rs` 重施「仓库内化」魔改（`wiki_path()＝repo_path.join(".codewiki")`、`vendor/codewiki/src/config.rs:40-42`）、`main.rs` 新增 `rel_path_string()` 替换两处 `Path::display()` 的 `\` 渲染（stale 清单与 `_index.md` 链接，`vendor/codewiki/src/main.rs:337-339`），文档化在 `vendor/codewiki/FORK.md`（基线 / 构建安装 / 警告 / 行为规格 / 验证 md5）。**这些文件当前均不在工作树中**——`list_files` 仓库根深度 3 无 `vendor/`，`.gitignore` 仅忽略 `vendor/codewiki/target/`（` .gitignore:2`）。因此：

- 仓库内**唯一被跟踪的二进制耐久产物**是 `bin/cw.exe`（及安全网 `bin/cw.exe.bak-20261010`，命中 `.gitignore:5-6` 的 `bin/*.bak-*`）；
- 「改源码 → `cargo build` → 同步 `bin/cw.exe` 与 `~/.cargo/bin/cw.exe`」这套 0.5.0.2 安全流程（CHANGELOG.md 0.1.0 段「vendor 上游 codewiki … cargo release 编译出 bin/cw.exe」）**已无法执行**，因为没有源码可改、也没有产地可重编译；
- 当前 `bin/cw.exe` 是否为带 `rel_path_string` 修复的 fork 构建、PATH 上装的 `cw` 是哪个版本，都**无法用仓库源码验证**——只剩运行时行为（插件层规范化是否还命中 `\`）能间接观察；
- 历史记录仍可在 CHANGELOG 查到：0.1.0 记录初版 vendor（CHANGELOG.md:934-935）、0.5.0.x 的起步与 Windows 收口（见 0.5.0.5 起各节）。`README.md:85-87` 的「开发」节仍指向 `vendor/codewiki/`，属同一漂移，不在本页修正范围。

### 配置项（本主题相关）

`Config`（`index.js:60-86`）由 `@deepseek-ai/schemastery` 定义，全部字段 `volatile()`；`liveConfig`（`index.js:92-134`）负责取默认值与夹取范围：

- `binaryPath`（`index.js:62`）：`cw` 可执行文件路径；留空则 PATH 优先、再落插件自带 `bin/cw(.exe)`（见 `resolveBinary`；liveConfig 的 trim 在 `index.js:140`）。⚠️ 因 `vendor/codewiki` 缺失，PATH 上的 `cw` 不可验证来源。
- `enabled`（`index.js:61`）：停用后工具立即报错。
- `autoCommit`（`index.js:81`，liveConfig 在 `index.js:3123`）：编译完成后由插件自己提交产物（0.10.11 起走 `tickCommit`/`autoCommitWiki` 分支合并式）；关掉则 `tickIndex` 直接终态（`index.js:3049`）。
- `symbolIncremental`（`index.js:79`）：stale 增量按符号级判定（直接改变本文关心的 stale 更新路径，CHANGELOG 0.13.x 多节记录）。
- `updateReminder`（`index.js:80`）：会话系统提示注入维护提醒（仅当仓库根存在 `CodeWiki.md`，判定在 `installUpdateReminder` `index.js:4314`）。

其余与本主题相关常量：`WIKI_PATHS`（`index.js:45`，自动提交只认的产物 pathspec）、`ORPHAN_TAKEOVER_MS`（`index.js:1848`，孤儿接管阈值，默认 5 分钟）、`JOBS_FILE`（`index.js:1655`，默认在 `os.tmpdir()`，可用 `DSH_CODEWIKI_JOBS_FILE` 隔离）、`TICK_MS`（`index.js:1656`，默认 10000）、`SESSION_TASK_DIR`（`index.js:1661`）、`REPOS_FILE`（`index.js:1854`）、`BATCH_TOKEN_BUDGET`（`index.js:586`，默认 110000）、`BATCH_TOKEN_HARD_LIMIT`（`index.js:591`，默认 128000）、`isDeadCompileTarget`（`index.js:423-431`）。

### 行号锚点校正（同源守卫，避免本页自身行号漂移）

- **`numberLines`**（`index.js:602-604`）：内联源码每行加 `行号| ` 前缀，模型引用行号有据可依。
- **`fixAnchors`**（`index.js:779-996` 区间，含 `repairUnclosedFrontmatter` `index.js:757-777`、`changelogSections` `index.js:622-630`、`fixChangelogAnchors` `index.js:632-748`）：文章落盘前把 `file:NN(-MM)` 锚点对照 `source_files` 源码确定性校正（符号绑定规则 `index.js:77-81` 注释，与 `test-wiki-anchors.mjs` 同源，见 Connections）。本页所有行号须以 `read_code` 返回前缀为准——这正是 0.5.0.3 立规、本页被点名的场景（CHANGELOG.md 0.13.6/0.13.7 段详述）。

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ 插件层 index.js                                       │
│ resolveBinary() :140  where/which→bin/cw(.exe)        │
│ runCw()         :162  spawn+超时/abort(120s)          │
└─────────────────────────┬────────────────────────────┘
                           │ spawn: init/status/index/meta/path/projects
                           ▼
┌──────────────────────────────────────────────────────┐
│ cw 二进制（仓库内唯一耐久产物 bin/cw.exe）            │
│   Rust 源头 vendor/codewiki 已不在工作树——无法重建 │
└─────────────────────────┬────────────────────────────┘
                           │ 输出（可能含 \ 分隔路径；无法用源码验证）
                           ▼
┌──────────────────────────────────────────────────────┐
│ <repo>/.codewiki/  _index.md · modules/ · concepts/    │
└──────────────────────────────────────────────────────┘
插件层唯一确定性防线（vendor 不复存在后的兜底）：
  parseStatus     :213 → normalizeArticlePath :199
  tickIndex       :3049 → normalizeIndexLinks :203（cw index 后）
收尾补链：tickIndex :3049 → ensureWikiEntry :291 → tickCommit :3123 自动提交
```

## Data Flow

### 反斜杠路径的完整生命周期（插件层为唯一防线）

```text
cw status 执行（Rust 二进制，bin/cw.exe）
       │  输出 stale 路径；是否含 \ 取决于该二进制是否带 0.5.0.2 的 rel_path_string 修复
       │  —— 源码已不在工作树，无法重建/验证，故不能假设它一定输出 /
       ▼
插件 parseStatus（index.js:213-226）
       │  matchAll(/^\s+[M!]\s+(.+)$/gm)（index.js:220）
       ▼
normalizeArticlePath（index.js:199）  ← 无条件兜底：无论二进制是否带 Rust 层修复都在此收口
       │
       ├──► changedFiles / staleArticles 进 stale 任务预构建
       │
       ▼
cw index 写盘 _index.md（二进制行为）
       │
       ▼
normalizeIndexLinks（index.js:203-211，仅 cw index exit 0 后由 tickIndex 调用，index.js:3074）
       │  只动 [[ 到 | 之间；无改动返回 false
       ▼
修正后的 _index.md（正文反斜杠不受影响）
```

当前路径下 `normalizeIndexLinks` 仍可能返回 `true`——说明二进制（或 PATH 上的 cw）仍输出 `\` 分隔路径；若返回 `false`，仅说明本次二进制碰巧输出了 `/`。插件层不依赖 Rust 层修复，因此无论二进制版本如何都是确定性防线。

### 编译收尾的 index → commit 阶段（0.10.11 起）

1. `writtenCount === 0`？直接跳过 `cw index` / `cw meta update`，记 note 后不进 commit（`index.js:3108-3110`）。
2. `resolveBinary` 取二进制（`index.js:3068`）——注意这里用**运行时配置**，面板改 `binaryPath` 立即生效。⚠️ 见 Overview：PATH 优先让"不同 cw 版本"风险在插件层重新出现。
3. 两次 `runCw`：`cw index` 与 `cw meta update`（`index.js:3070-3071`），退出码写进 note（`index.js:3072`）。
4. `cw index` 成功后调 `normalizeIndexLinks`（`index.js:3074`）。
5. 符号快照：`symbolIncremental` 开启时 `extractCurrentGraph`（`index.js:1924`）+ `slimGraph` 写入 `.codewiki/temp/`（快照位置经 `lib/incremental.js` 的 `saveSnapshot`），内容未变则跳过以免「只改时间戳」的空转提交污染 autoCommit（`index.js:3089-3090`）。
6. `ensureWikiEntry` 补建入口（调用点 `index.js:3104`；函数本体 `index.js:291-324`）：缺 `CodeWiki.md` 则生成，失败只记 note 不让任务失败。
7. 切 `commit` 阶段（`index.js:3114-3116`，`autoCommit` 关闭时直接 done）；下个 tick 的 `tickCommit`（`index.js:3123-3139`）执行分支合并式自动提交后才置 `done` + 写 `finishedAt` + `onSettled` 唤醒（`index.js:3136-3138`）——终态最多晚一个 tick（默认 `TICK_MS` 10s，`index.js:1656`）。唤醒是否打扰会话由 `autoCommitState`（`index.js:2032-2037`）统一判定：`committed`/`no-changes` 静默（`index.js:2043` 守卫），仅 `failed`/`pending` 才 steer。

### 调度与恢复：任务如何活过进程重启

- `tick`（`index.js:3150-3236` 可见范围）每轮遍历非终态 job；另一实例的 job 若 `updatedAt` 停更超过 `ORPHAN_TAKEOVER_MS`（`index.js:1848`，判定在 `index.js:3179-3180`）就被本实例接管，在途会话通道任务重发 steer（`index.js:3184`）。
- `submit` / 作业持久化：`job` 记录持久化在 `JOBS_FILE`（`index.js:1655`），`mergeFromDisk`（`index.js:2110-2131`）把另一实例写入并回内存，`flush`（`index.js:2132-2135`）脏标记为真才整写，`touch`（`index.js:2142-2144`）是状态变更统一入口，`setStage`（`index.js:2147-2157`）累计各阶段耗时。
- 启动清理：cwd 位于系统临时目录的终态任务直接移除（`index.js:423-434`，0.4.6 起）；1.2.1 起 worktree/空壳目录历史任务从已知仓库登记摘除（统一判定 `isDeadCompileTarget` `index.js:1869-1877`，清理 `index.js:2092-2107`、`forgetRepo` 在 `index.js:1869-1878`）。

## Connections

- [[modules/core-application|core-application]]：`index.js` 宿主侧全部逻辑所在模块，本文所有插件层锚点的宿主。
- [[modules/testing-suite|testing-suite]]：`test-wiki-entry.mjs` 把本主题固化为回归（文件头 `test-wiki-entry.mjs:59-64`）——入口生成断言（中文 `:27-32`、绝对路径 `:29`、工具名 `:30`、架构总览指引 `:31`、不覆盖声明 `:32`，英文 `:43-46`，空 cwd `:49`，幂等 `:52-54`）+ 路径规范化断言（`:56-72`）：`normalizeArticlePath` 的反斜杠替换/正斜杠保留/`undefined` 安全 `:57-59`、`parseStatus` 对 stale 反斜杠的清洗 `:60-62`、`normalizeIndexLinks` 的链接头修正与「正文反斜杠不受影响」`:63-72`（fixture 写入 `:64-66`、命中 `:67`、链接修正 `:69`、正文不动 `:70`、幂等 `:71`、无 `_index.md` 静默 `:72`）。这是「插件层规范化是唯一防线」的硬测试。
- [[concepts/documented-contract|documented-contract]]：`index.js:213-226` 的契约注释把 `cw` 三态输出固化下来（实际注释在 `index.js:189-198`），`parseStatus`（`index.js:213-226`）即该契约的解析实现；本学习页解释为什么契约里仍残留「vendor/codewiki」字样的漂移。
- [[learnings/update-reminder-entry-gap|update-reminder-entry-gap]]：`ensureWikiEntry` 要补的正是那个不变量缺口（提醒门控依赖入口文件，而流水线曾不创建它，`index.js:291-293`）。
- [[concepts/configuration-management|configuration-management]]：`binaryPath` / `autoCommit` / `symbolIncremental` 等配置项的解析与夹取路径（`liveConfig`，`index.js:92-134`）。
- 补充守卫：`test-wiki-anchors.mjs`（文件头 `test-wiki-anchors.mjs:96-104`，校验对象按需加载所有被引用的文件——`index.js`/`client.js` 在 `test-wiki-anchors.mjs:187-190` 显式列入，其余文件在遍历 `.codewiki/**/*.md` 时按需 `loadSource`）扫描 `.codewiki/**/*.md` 里每个 `file:行号` 锚点——行号在范围内（`test-wiki-anchors.mjs:38`）、指向非空行（`:96`）、同行反引号符号必须出现在锚点行源码区间内（绑定检查 `:105-112`，单锚点行才校验，理由 `:101-104`）、区间起止有序（`:98-99`）。符号提取规则 `symbolsOnLine` 在 `test-wiki-anchors.mjs:38-49` 与 `fixAnchors`（`index.js:779` 起）同源（同步要求写在 `index.js:608-612` 注释，改一处须同步另一处）。本页行号即以它为回归标准——改完本页跑 `node test-wiki-anchors.mjs`。

## Known Issues

1. **插件层规范化现在是唯一确定性防线，且不能删**：`vendor/codewiki` 已不在工作树，`rel_path_string` 的 Rust 层根治无法从仓库源码重建或验证；当前 `bin/cw.exe` 是否带该修复、PATH 上装的 `cw` 是哪个版本都不可考。因此 `normalizeArticlePath`/`parseStatus`/`normalizeIndexLinks` 成为确定性的唯一防线（由 `test-wiki-entry.mjs:56-72` 固化）。删除会让 Windows 下 stale 清单与 `_index.md` 链接重新被 `\` 污染——与「脚本里 `E:\ik\repo` 反斜杠」混在一起会污染 wiki 链接解析。

2. **二进制来源已无法从仓库重建**：唯一耐久产物是 `bin/cw.exe`，安全网是 `bin/cw.exe.bak-20261010`（`.gitignore:5-6` 的 `bin/*.bak-*`）。`vendor/codewiki`（含 FORK.md 与 `config.rs`/`main.rs` 魔改）当前缺失，意味着 0.5.0.2 的「改源码 → 重编译 → 同步两处二进制 + 跑回归」安全流程已无法执行。若 `bin/cw.exe` 损坏或被错误二进制覆盖，回退手段只剩该 `.bak` 与 PATH 上用户自装的 `cw`。`resolveBinary` 的 PATH 优先（`index.js:140-160`）会把「bash 里 `cw` 正常、插件包装层行为不同」的分叉风险放回来——正是 0.5.0.1 注释要避免的场景。

3. **README 开发节仍指向已消失的 `vendor/codewiki`**：`README.md:85-87` 写「`vendor/codewiki/ 上游源码（去除 .git）` / `改了 vendor 记得重编`」，与现状不符（仓库根无 `vendor/`）。本页解释的就是这个漂移；修 README 不在本次范围。

4. **插件层契约注释指向已消失的 `FORK.md`**：`index.js:189-198` 仍写「见 vendor/codewiki/FORK.md 与 .codewiki/learnings/cw-binary-source-lost.md」。FORK.md 已不在工作树，注释本身成了漂移点，但保留它作历史记录（它准确描述了 0.5.0.x 的意图，且第二段字面正确指向本页）。

5. **行号锚点幻觉历史**：流水线产物曾系统性幻觉 `index.js:`/`client.js:` 行号（偏移 34~760 行，校对阶段拦不住，CHANGELOG.md 0.13.6/0.13.7 段详述——0.13.6 把基准扩到全仓后暴露 263 处失败、补第三基准后回到 0 败；更早的归因见 0.13.5），因此 `test-wiki-anchors.mjs` 把「锚点必须对照真实源码核对」制度化（符号绑定 `test-wiki-anchors.mjs:38-49`、CHANGELOG 语义校验 `:321-334` 实际对应 `index.js:77-193` 的同源逻辑）。写/改本页后应跑一次 `node test-wiki-anchors.mjs`；本页所有行号以 `read_code` 返回前缀为准，禁止自行数行。

6. **恢复推进依赖心跳与临时目录**：孤儿接管按 `updatedAt` 停更判定（`tick` 内 `index.js:3179-3180`，阈值 `ORPHAN_TAKEOVER_MS` `index.js:1848`）而作业状态文件 `JOBS_FILE`（`index.js:1655`）与会话通道任务目录 `SESSION_TASK_DIR`（`index.js:1661`）默认都落在系统临时目录——临时目录被清理会丢活动 job 的记录与在途任务文件，只能重新提交编译。启动清理：cwd 位于 Temp 的终态任务直接移除（`index.js:423-434`）；1.2.1 起 worktree/空壳目录历史任务从已知仓库登记摘除（统一判定 `isDeadCompileTarget` `index.js:3150-3158`，清理 `index.js:2092-2107`）。
---
