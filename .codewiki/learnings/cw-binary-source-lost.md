---
title: cw-binary-source-lost
type: learning
source_files:
  - index.js
  - vendor/codewiki/FORK.md
  - vendor/codewiki/src/config.rs
  - vendor/codewiki/src/main.rs
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - CHANGELOG.md
tags: [vendor, rust, cw-cli, path-separator, windows, lesson, fork]
---

## Overview

本文记录 `cw`（Rust 编写的 CodeWiki CLI）二进制源码丢失事件的完整演进：从「源码随临时目录一起蒸发、只能在插件层收口」，到「在 `vendor/codewiki/` 重建可维护 fork、把 Windows 反斜杠问题下沉到 Rust 层根治」，以及当前代码里这套防线具体落在哪些文件与行。

三段式历史（时间线均可核对）：

1. **起因**：`cw` 曾以 `cargo install --path` 方式编译安装，Rust 源码留在系统临时目录（`Temp/cw-src`），临时目录被清理后真源码永久丢失；当时 `vendor/codewiki` 只是上游的**过期快照**——它把 wiki 放在中心目录 `~/.codewiki/<project>`（`vendor/codewiki/src/config.rs:6-9` 的 `wiki_home()`），而现役二进制基于改过的架构（wiki 在 `<repo>/.codewiki`）。因此「改 vendor 源码再编译」得到的是另一种架构的产物，表现为编译成功但跑 `cw index` 报 `No wiki found`（`vendor/codewiki/src/main.rs:284-286` 的 bail 分支）。
2. **过渡收口（0.5.0.1，`CHANGELOG.md:210-219`）**：源码已无法修改，Windows 下 Rust `Path::display()` 输出的反斜杠污染 stale 清单与 `_index.md` 的 `[[...]]` 链接，只能在消费点（插件层）拦截——`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks` 全部是这一阶段的产物。
3. **根治（0.5.0.2，`CHANGELOG.md:197-204`）**：先取证，确认上游 main `64323823b6767d74af732f742c67ed75371c4f0d`（2026-04-06）与 vendor 快照逐字节一致（`vendor/codewiki/FORK.md:13`），于是把 `vendor/codewiki` 重建为本地 fork：`config.rs` 单点重施「仓库内化」魔改 + `main.rs` 新增 `rel_path_string()` 替换两处 `Path::display()`。插件层规范化从「唯一防线」降级为「纵深防御」，并保留至今（`index.js:136-140` 的注释即这段历史的压缩记录）。

**当前状态**：`cw` 的真源码常驻 `vendor/codewiki/` 并随插件仓库提交，`bin/cw.exe` 由它构建；插件层与 Rust 层各守一段（见下文 Data Flow）。这条学习页存在的价值是解释「为什么代码里有两套路径规范化」「为什么不能拿上游原版覆盖 vendor」「为什么二进制有 md5 记录且不许为消警告重编译」。

## Key Components

### 插件侧：二进制定位与进程封装

- **`resolveBinary(cfg)`**（`index.js:82-102`）：决定调用哪个 `cw`。优先级为 `cfg.binaryPath`（`:83`）→ PATH 探测（Windows 用 `where cw`，`index.js:82-87`；POSIX 用 `which cw`，`index.js:82-87`）→ 插件自带 `bin/cw.exe` 兜底（`index.js:82-83`）→ 裸 `'cw'`（`:101`）。`index.js:82-83` 的注释写明**PATH 优先**的理由：用户安装的 `cw` 与其 codewiki 源码同步演进，捆绑副本只在 PATH 找不到时兜底，避免「bash 原生正常、包装层报 No wiki found」的分叉。
- **`runCw(binary, cwd, args, timeoutMs = 120000, signal)`**（`index.js:104-129`）：`spawn` 封装，收集 stdout/stderr，超时与 abort 都 `SIGKILL`（`:110-115`），统一 resolve 成 `{ exitCode, stdout, stderr, timedOut }`（`:118-127`）。所有 `cw` 子命令调用（status/index/meta update/path/init）都经过它。
- **`wikiPathFor(cwd, binary, signal)`**（`index.js:994-999`）：跑 `cw path` 取 wiki 目录；失败时回退 `path.join(cwd, '.codewiki')`（`:998`），注释注明「与 `wiki_path()` 一致：wiki 在仓库内」。
- **`readSourceFiles(articlePath)`**（`index.js:984-992`）：读文章 frontmatter 的 `source_files`（正则 `/^---\r?\n([\s\S]*?)\r?\n---/`，`:987`），stale 逐篇更新时用它决定给模型喂哪些源码。

### 插件侧：路径规范化的两道防线（0.5.0.1 遗产）

- **`index.js:136-140` 注释**：把 cw 的三态输出与逐行清单（`'No wiki found. Run \`cw init\` first.'` / `'Wiki has not been compiled yet.'` / `'Wiki is up to date.'` / `'Changed since last compile (<hash>):'` + `'  M <file>'` / `'Stale articles:'` + `'  ! <article>'`）固化成契约，并说明「cw 0.5.0.2 起 Rust 层已用 `rel_path_string` 输出 `/` 分隔路径；本层规范化保留为纵深防御（旧二进制或上游原版在 Windows 仍输出反斜杠）」，同时指向 `vendor/codewiki/FORK.md` 与本文。
- **`normalizeArticlePath(p)`**（`index.js:141`）：`String(p ?? '').replace(/\\/g, '/')`，单行纯函数；对 `undefined` 安全返回空串。
- **`parseStatus(stdout)`**（`index.js:155-168`）：先用子串判定三态——`missing`（`:157`）、`uncompiled`（`:158`）、`clean`（`:159`）；其余一律 `stale`，再用 `matchAll(/^\s+[M!]\s+(.+)$/gm)`（`:162`）逐行分流：`M` 走 `changedFiles`、`!` 走 `staleArticles`（`:164-165`），两条路径都过 `normalizeArticlePath`。
- **`normalizeIndexLinks(cwd)`**（`index.js:145-153`）：`cw index` 直接写盘 `_index.md`，本函数事后只修链接头——正则 `/\[\[([^\]|\n]*?)\|/g`（`:149`）仅替换 `[[` 到 `|` 之间的反斜杠，正文里的 `E:\ik\repo` 之类不受影响；无改动返回 `false`（`:150`），文件不存在时静默返回 `false`（`:148` 的 catch），因此天然幂等。由 `tickIndex` 在 `cw index` 成功后调用。

### 插件侧：索引收尾与入口补建

- **`tickIndex(job)`**（`index.js:1979-2002`）：编译流水线的最后阶段。仅当 `job.writtenCount > 0` 才动手（`:1981`），依次跑 `cw index`（`:1984`）与 `cw meta update`（`:1985`），任一非 0 退出就记 note 提示「编译基线可能未刷新」（`:1987`）；`cw index` 成功后再调 `normalizeIndexLinks`（`:1988`）。随后 `ensureWikiEntry(job.cwd, job.language)`（`:1993`）补建入口。最后 `setStage(job, 'done')`（`:2000`）并唤醒发起会话（`:2002`，`onSettled` 无 sessionId 时内部静默）。若一篇都没写成功，走 `:1997-1998` 的「跳过 index/meta update」分支（wiki 基线不变）。
- **`ensureWikiEntry(cwd, language = '中文')`**（`index.js:188-221`）：仓库根缺 `CodeWiki.md` 则生成中（`:193-205`）或英（`:206-218`）文入口，已有入口绝不覆盖（`:191` 返回 `false`）；空 cwd 安全返回 `false`（`:189`）。注释 `index.js:188-190` 记录动机：139052c 把收尾提醒门控收紧到入口文件，但流水线此前从不创建它，形成「编译过但无入口 → 永远收不到收尾提醒」的不变量缺口（另见 [[learnings/update-reminder-entry-gap|update-reminder-entry-gap]]）。
- **`countWikiArticles(wikiPath)`**（`index.js:171-183`）：递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），总览卡展示用。

### fork 侧：Rust 源码（`vendor/codewiki/`）

| 文件 | 位置 | 作用 |
|---|---|---|
| `src/config.rs` | `:40-42` | `wiki_path()`＝`repo_path.join(".codewiki")`，FORK MOD，注释在上方 `:37-39` |
| `src/config.rs` | `:5-9` | `wiki_home()`＝`~/.codewiki`，仅 `cw projects` 仍用（中心枚举保留） |
| `src/config.rs` | `:11-35` | `project_name()`：`git remote get-url origin` 取末段、去 `.git`，失败回退目录名 |
| `src/main.rs` | `:126-206` | `cmd_status()`：三态 + 变更清单 + stale 文章 |
| `src/main.rs` | `:227-281` | `cmd_index()`：遍历 `.md`、按 frontmatter `type` 分组重建 `_index.md` |
| `src/main.rs` | `:318-323` | `cmd_path()`：打印 `wiki_path()` 的 display |
| `src/main.rs` | `:337-339` | `rel_path_string()`：`rel.to_string_lossy().replace('\\', "/")`，FORK FIX |

`cmd_status` 的关键分支：`!wiki.exists()` → `No wiki found. Run \`cw init\` first.`（`:130-133`）；`last_compiled_commit` 为空 → `Wiki has not been compiled yet.`（`:140-142`）；`git diff --name-only <last>..HEAD` 失败 → `Last compiled commit … no longer in history.` + `Full recompile recommended.`（`:151-158`）；无变更 → `Wiki is up to date.`（`:166-169`）；有变更则打印 `Changed since last compile (<hash>):`（`:171-174`）与 `  M <file>`（`:175-177`），再按 `source_files` 命中筛出 stale 并打印 `Stale articles:` + `  ! <article>`（`:197-203`）。

`rel_path_string()` 的两个调用点就是「两处 `Path::display()`」的替代：stale 清单（`src/main.rs:190`）与索引链接（`src/main.rs:243` → 拼成 `- [[{link_name}|{title}]]`，`:268-269`，写盘 `:276-278`）。同一函数还顺带用于 `_` 前缀过滤（`:245`）与 title 回退（`:251`）。

`vendor/codewiki/FORK.md` 是这套 fork 的随文档：基线（`:5`）、历史（`:6`）、魔改点全集（`:10-15`，仅两处）、构建安装命令（`:19-24`，注意 `cargo install --path` 会联网且可能失败，建议直接复制编译产物）、警告（`:28-32`，不得用上游原版覆盖、不得放临时目录、改源码后必须重编译并同步两处二进制 + 跑回归）、行为规格表（`:36-43`）、验证记录（`:45-50`，旧二进制 md5 `835702929c4ec44149ad97ae25192955`、新二进制 md5 `952b0282523ad016c13688cc594afdd8`）、已知有意差异（`:52-54`）、构建噪音（`:56-58`）。

### 配置项 (Config)

`Config`（`index.js:37-51`）由 `@deepseek-ai/schemastery` 定义，全部字段 `volatile()`；`liveConfig(config)`（`index.js:57-76`）负责取默认值与夹取范围：

- `enabled`（`:38`）：停用后工具立即报错。
- `binaryPath`（`:39`）：`cw` 可执行文件路径；留空则 PATH 优先、再落插件自带 `bin/cw(.exe)`。
- `batchProvider`（`:40`）：编译模型提供商；空＝走百炼兼容通道，非空＝走宿主 llm 服务。
- `batchModel`（`:41`）：默认 `qwen3.7-flash`，全部模型环节共用。
- `batchApiKey`（`:42`）：百炼 Key，留空自动取模型设置「阿里百炼云」渠道凭证。
- `batchThinkingBudget`（`:43`）：0 关思考，1~32768 限预算（`liveConfig` `:66` 夹取）。
- `maxConcurrency`（`:44`）：并发上限，硬顶 `CONCURRENCY_HARD_CAP = 8`（`index.js:57`，`liveConfig` `:67-69` 再夹）。
- `articleLanguage`（`:45`）：文章语言，也是 `ensureWikiEntry` 的语言入参来源。
- `updateReminder`（`:46`）：会话系统提示注入维护提醒（仅当仓库根存在 `CodeWiki.md`）。
- `excludePaths`（`:47`）：排除编译的绝对路径清单，解析在 `excludedItem(cwd, list)`（`index.js:226-235`，`isExcluded` 是它的布尔包装，`index.js:236-238`）。
- `autoUpdate` / `autoUpdateMin`（`:48-49`）：自动增量编译开关与扫描间隔（最小 5 分钟，`liveConfig` `:73`）。
- `workspaceOnly`（`:50`）：任务页只显示已添加工作区的任务。

其余与本主题相关的常量：`JOBS_FILE`（`index.js:1016`，默认在 `os.tmpdir()`，可用 `DSH_CODEWIKI_JOBS_FILE` 隔离）、`TICK_MS`（`index.js:1016`，默认 10000）。

## Architecture

```text
┌───────────────────────────────────┐
│ 插件层 index.js                   │
│ resolveBinary()  :82-102          │──► where/which 探测 ─► bin/cw.exe 兜底
│ runCw()         :104-129          │
└────────────────┬──────────────────┘
                 │ spawn: status / index / meta update / path / init
                 ▼
┌───────────────────────────────────┐      ┌────────────────────────────────┐
│ cw 二进制                         │      │ vendor/codewiki/src/           │
│ （唯一的真源码在 vendor/codewiki）│◄─────│ config.rs  wiki_path()   :40   │
└────────────────┬──────────────────┘ 构建 │ main.rs    rel_path_string():337│
                 │ 输出（/ 分隔路径）     └────────────────────────────────┘
                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ <repo>/.codewiki/  _index.md · modules/ · concepts/ · _meta.yaml         │
└──────────────────────────────────────────────────────────────────────────┘
插件侧纵深防御：parseStatus :155 ─► normalizeArticlePath :141
                tickIndex  :1980 ─► normalizeIndexLinks :145（cw index 之后）
收尾补建：     tickIndex  :1993 ─► ensureWikiEntry :188
```

## Data Flow

### 反斜杠路径的完整生命周期（Rust 根治 + 插件兜底）

```text
cw status 执行（Rust，main.rs:126-206）
      │  stale 路径经 rel_path_string()（main.rs:190 → :337）渲染为 /
      ▼
插件 parseStatus（index.js:155）
      │  matchAll(/^\s+[M!]\s+(.+)$/gm)（index.js:162）
      ▼
normalizeArticlePath(line)（index.js:141）      ← 旧二进制/上游原版仍输出反斜杠时在此兜住
      │
      ├──► changedFiles / staleArticles 进 job.tasks（stale 逐篇更新）
      │
      ▼
cw index 写盘 _index.md（main.rs:227-281，链接由 rel_path_string 渲染，main.rs:243/:269）
      │
      ▼
normalizeIndexLinks(cwd)（index.js:145，仅在 cw index exit 0 后由 tickIndex:1988 调用）
      │  只动 [[ 到 | 之间；无改动返回 false
      ▼
修正后的 _index.md（正文反斜杠不受影响）
```

正常路径下 `normalizeIndexLinks` 返回 `false`——说明 Rust 层已产出 `/` 分隔路径，插件层没有可修的东西；它存在的意义只在「旧二进制 / 用户 PATH 上装的是上游原版」这两种退化场景。

### 编译收尾的 index 阶段（`tickIndex`）

1. `writtenCount === 0`？直接跳过 `cw index` / `cw meta update`，记 note 后 `setStage('done')`（`index.js:1261-1262`）。
2. `resolveBinary(liveConfig(config))` 取二进制（`index.js:82`）——注意这里用的是**运行时配置**，所以面板改 `binaryPath` 立即生效。
3. `runCw(..., ['index'], 120000)`（`:1984`）→ `runCw(..., ['meta','update'], 120000)`（`:1985`），退出码写进 note（`:1986-1987`）。
4. `cw index` 成功后 `normalizeIndexLinks(job.cwd)`（`:1988`）。
5. `ensureWikiEntry(job.cwd, job.language)`（`:1993`）：缺 `CodeWiki.md` 则生成，失败只记 note 不让任务失败（`:1994-1996`）。
6. `setStage(job, 'done')` + `finishedAt` + `onSettled` 唤醒（`:2000-2002`）。

调度侧与之配合的两点：`tick()`（`index.js:2014-2058`）每轮遍历非终态 job，另一实例的 job 若 `updatedAt` 停更超过 `ORPHAN_TAKEOVER_MS` 就被本实例接管（`:2021-2030`，宿主重启后 `instanceId` 变化即走此路径），在途会话通道任务会重发 steer（`:2030`）；`submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId })`（`index.js:2059-2116`）先做排除清单校验（`:2062-2064`）、活动任务幂等（`:2067-2068`），再按 `kind` 决定起始阶段——`setStage(job, kind === 'full' ? 'plan' : 'articles')`（`:2111`），stale 直接挂预构建任务（`:2112`）。`job` 记录持久化在 `JOBS_FILE`，`mergeFromDisk()`（`index.js:1224-1245`）负责把另一实例写入的更新并回内存，避免旧快照覆盖对方的活动 job。

## Connections

- [[modules/core-application|core-application]]：`index.js` 宿主侧全部逻辑所在模块，本文所有插件层锚点的宿主。
- [[modules/testing-suite|testing-suite]]：`test-wiki-entry.mjs` 的 23 条断言把本主题固化为回归——入口生成 13 条（`test-wiki-entry.mjs:59-76`）+ 路径规范化 10 条（`:56-72`，含 `normalizeArticlePath` 的正斜杠保留与 `undefined` 安全、`parseStatus` 对 stale 反斜杠的清洗、`normalizeIndexLinks` 的幂等与「正文反斜杠不受影响」）。
- [[learnings/update-reminder-entry-gap|update-reminder-entry-gap]]：`ensureWikiEntry` 要补的正是那个不变量缺口（提醒门控依赖入口文件，而流水线曾不创建它）。
- [[concepts/configuration-management|configuration-management]]：`binaryPath` / `maxConcurrency` / `excludePaths` 等配置项的解析与夹取路径（`liveConfig`，`index.js:57-76`）。
- 补充守卫：`test-wiki-anchors.mjs`（全文 `:1-9` 说明动机，`:80-93` 三重断言）校验 `.codewiki/**/*.md` 里每个 `index.js:` / `client.js:` 锚点——行号在范围内、指向非空行、同行反引号符号必须出现在锚点行源码中、区间起止有序。本页的行号锚点即以它为回归标准。

## Known Issues

1. **两处二进制必须同步**：`vendor/codewiki/FORK.md:22-23` 要求 `bin/cw.exe`（插件自带）与 `~/.cargo/bin/cw.exe`（PATH 里的全局）一起更新。只更新一处时，`resolveBinary` 的 PATH 优先策略（`index.js:82`）会让「bash 里直接跑 `cw` 正常、插件包装层行为不同」——这正是 `index.js:82-83` 注释要避免的分叉形态。
2. **不要用上游原版覆盖 `vendor/codewiki`**：上游是中心制（`~/.codewiki/<project>`），覆盖后编译产物跑 `cw index` 会命中 `No wiki found` 的 bail（`vendor/codewiki/src/main.rs:232-234`）。同理不要把源码放到 Temp 等易清理目录——那正是本页事故的起爆点（`FORK.md:28-32`）。
3. **二进制是「验证过的工件」，md5 一致性记录不应被随意破坏**：`FORK.md:58-58` 明确记录 `cargo build` 产生 1 个 `dead_code` 警告（`WikiMeta.tags` 从未被读取，上游固有），有意不修——为消一个无害警告重编译，会破坏「仓库源码 ↔ 已装二进制」的一致性记录。
4. **内嵌 skill 模板是已知有意差异**：本 fork 构建时嵌入的是 0.5.0.x 文案（`codewiki_generate` 优先、面板、`<repo>/CodeWiki.md` 入口承诺），丢失版二进制嵌入的是子代理时代旧文案；`cw setup claude-code` 写出的文本对应各自内嵌版本，插件不依赖该路径（`FORK.md:54-56`）。
5. **插件层规范化现在是冗余的，但不要删**：正常路径下 `normalizeIndexLinks` 返回 `false`；它服务的是「旧二进制」或「PATH 上是上游原版」两种退化场景（`index.js:145-149` 注释）。删除会让这两类环境重新出现 stale 清单与 `_index.md` 链接被反斜杠污染的问题。
6. **行号幻觉历史**：流水线产物曾系统性幻觉 `index.js:` 行号（偏移 34~760 行，校对阶段拦不住，见 `CHANGELOG.md:186-190`），因此 `test-wiki-anchors.mjs` 把「锚点必须对照真实源码核对」制度化；写/改本页后应跑一次该测试。
7. **恢复推进依赖心跳与临时目录**：孤儿接管按 `updatedAt` 停更判定（`index.js:1015-1024`），而作业状态文件 `JOBS_FILE` 默认落在系统临时目录（`index.js:1015`）——临时目录被清理会丢活动 job 的记录，只能重新提交编译。