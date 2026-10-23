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
2. **过渡收口（0.5.0.1，`CHANGELOG.md:303-312`）**：源码已无法修改，Windows 下 Rust 的路径渲染输出的反斜杠污染 stale 清单与 `_index.md` 的 `[[...]]` 链接，只能在消费点（插件层）拦截——`normalizeArticlePath` / `parseStatus` / `normalizeIndexLinks` 全部是这一阶段的产物。
3. **根治（0.5.0.2，`CHANGELOG.md:290-297`）**：先取证，确认上游 main `64323823b6767d74af732f742c67ed75371c4f0d`（2026-04-06）与 vendor 快照逐字节一致（`vendor/codewiki/FORK.md:13` 基线、`FORK.md:13` 历史），于是把 `vendor/codewiki` 重建为本地 fork：`config.rs` 单点重施「仓库内化」魔改，`main.rs` 新增 `rel_path_string` 替换两处路径渲染。插件层规范化从「唯一防线」降级为「纵深防御」，并保留至今（`index.js:157-166` 的注释即这段历史的压缩记录）。

**当前状态**：`cw` 的真源码常驻 `vendor/codewiki/` 并随插件仓库提交，`bin/cw.exe` 由它构建；插件层与 Rust 层各守一段（见下文 Data Flow）。这条学习页存在的价值是解释「为什么代码里有两套路径规范化」「为什么不能拿上游原版覆盖 vendor」「为什么二进制有 md5 记录且不许为消警告重编译」。

## Key Components

### 插件侧：二进制定位与进程封装

- **`resolveBinary`**（`index.js:103-123`）：决定调用哪个 `cw`。优先级为 `cfg.binaryPath`（`index.js:104`）→ PATH 探测（Windows 用 `where`、POSIX 用 `which`，`index.js:103-115`）→ 插件自带 `bin/cw(.exe)` 兜底（`index.js:103-105`）→ 裸字符串 `cw`（`index.js:103`）。`index.js:103-104` 的注释写明**PATH 优先**的理由：用户安装的 `cw` 与其 codewiki 源码同步演进，捆绑副本只在 PATH 找不到时兜底，避免「bash 原生正常、包装层报 No wiki found」的分叉。
- **`runCw`**（`index.js:125-150`）：`spawn` 封装，收集 stdout/stderr，超时与 abort 都走 `child.kill`，统一 resolve 成四字段结果对象 `{ exitCode, stdout, stderr, timedOut }`。所有 `cw` 子命令调用（status / index / meta update / path / init）都经过它。
- **`wikiPathFor`**（`index.js:1027-1032`）：跑 `cw path` 取 wiki 目录；失败时回退到仓库内 `.codewiki`，注释注明「与 wiki_path() 一致：wiki 在仓库内」。
- **`readSourceFiles`**（`index.js:1017-1025`）：读文章 frontmatter 的 `source_files`，stale 逐篇更新时用它决定给模型喂哪些源码；解析细节拆在 `parseSourceFiles`（`index.js:1003-1015`），同时支持行内数组与缩进列表两种写法。

### 插件侧：路径规范化的两道防线（0.5.0.1 遗产）

- **契约注释**（`index.js:152-161`）：把 cw 的三态输出与逐行清单固化成契约——`No wiki found. Run \`cw init\` first.` / `Wiki has not been compiled yet.` / `Wiki is up to date.` / `Changed since last compile (<hash>):` 加 `  M <file>` / `Stale articles:` 加 `  ! <article>`。
- 同一段注释（`index.js:152-161`）记录了双层防线的理由与出处：0.5.0.2 起 Rust 层已用 `/` 分隔渲染文章相对路径，本层规范化保留为纵深防御（旧二进制或上游原版在 Windows 仍输出反斜杠）；历史一行指向 `vendor/codewiki/FORK.md` 与本文。
- **`normalizeArticlePath`**（`index.js:162`）：单行纯函数，把反斜杠统一替换为正斜杠；对 `undefined` 安全返回空串。
- **`parseStatus`**（`index.js:176-189`）：先用子串判定 `missing` / `uncompiled` / `clean` 三态（`index.js:178-180`）；其余一律 stale，再用 `matchAll` 逐行分流：`M` 走 changedFiles、`!` 走 staleArticles，两条路径都过 `normalizeArticlePath`。
- **`normalizeIndexLinks`**（`index.js:166-174`）：`cw index` 直接写盘 `_index.md`，本函数事后只修链接头——只替换 `[[` 到 `|` 之间那段的反斜杠，正文里的 `E:\ik\repo` 之类不受影响；无改动或文件不存在都返回 `false`，因此天然幂等。由 `tickIndex` 在 `cw index` 成功后调用。

### 插件侧：索引收尾与入口补建

- **`tickIndex`**（`index.js:1953-1976`）：编译流水线的最后阶段。仅当 `job.writtenCount > 0` 才动手，依次跑 `cw index` 与 `cw meta update`，退出码写进 note，任一非 0 再补一条「编译基线可能未刷新」的提示；`cw index` 成功后再调 `normalizeIndexLinks`。随后 `ensureWikiEntry` 补建入口。最后切到终态并唤醒发起会话。若一篇都没写成功，走「跳过 index/meta update」分支（wiki 基线不变）。
- **`ensureWikiEntry`**（`index.js:209-242`）：仓库根缺 `CodeWiki.md` 则生成入口，已有入口绝不覆盖，空 cwd 安全返回 false。
- 入口文案分两套：中文模板落在 `index.js:214-226`，英文模板落在 `index.js:227-239`；语言由 `articleLanguage` 决定。
- 上面这个函数的动机注释（`index.js:206-208`）：收尾提醒的门控被收紧到仓库根入口文件，但流水线此前从不创建它，形成「编译过但无入口 → 永远收不到收尾提醒」的不变量缺口（另见 [[learnings/update-reminder-entry-gap|update-reminder-entry-gap]]）。
- **`countWikiArticles`**（`index.js:192-204`）：递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），总览卡展示用。

### fork 侧：Rust 源码（`vendor/codewiki/`）

| 文件 | 位置 | 作用 |
|---|---|---|
| `src/config.rs` | `vendor/codewiki/src/config.rs:40-42` | `wiki_path()`＝`repo_path.join(".codewiki")`，FORK MOD，注释在上方 `vendor/codewiki/src/config.rs:40-42` |
| `src/config.rs` | `vendor/codewiki/src/config.rs:6-9` | `wiki_home()`＝`~/.codewiki`，仅 `cw projects` 仍用（中心枚举保留） |
| `src/config.rs` | `vendor/codewiki/src/config.rs:12-35` | `project_name()`：`git remote get-url origin` 取末段、去 `.git`，失败回退目录名 |
| `src/main.rs` | `vendor/codewiki/src/main.rs:126-206` | `cmd_status()`：三态 + 变更清单 + stale 文章 |
| `src/main.rs` | `vendor/codewiki/src/main.rs:227-281` | `cmd_index()`：遍历 `.md`、按 frontmatter `type` 分组重建 `_index.md` |
| `src/main.rs` | `vendor/codewiki/src/main.rs:318-323` | `cmd_path()`：打印 `wiki_path()` 的 display |
| `src/main.rs` | `vendor/codewiki/src/main.rs:337-339` | `rel_path_string()`：把相对路径里的反斜杠统一成 `/`，FORK FIX |

`cmd_status` 的关键分支：wiki 目录不存在 → `No wiki found. Run \`cw init\` first.`（`main.rs:130-133`）；`last_compiled_commit` 为空 → `Wiki has not been compiled yet.`（`main.rs:138-144`）；`git diff --name-only <last>..HEAD` 失败 → `Last compiled commit … no longer in history.` + `Full recompile recommended.`（`main.rs:151-158`）；无变更 → `Wiki is up to date.`（`main.rs:166-169`）；有变更则打印 `Changed since last compile (<hash>):`（`main.rs:171-177`）与逐行 `  M <file>`（`main.rs:175-177`），再按 frontmatter 的 `source_files` 命中筛出 stale 并打印 `Stale articles:`（`main.rs:199-203`）加逐行 `  ! <article>`（`main.rs:200-202`）。

`rel_path_string` 的两个调用点就是「两处路径渲染」的替代：stale 清单（`main.rs:190`）与索引链接（`main.rs:243` → 拼成 `- [[{link_name}|{title}]]`，`main.rs:268-269`，写盘 `main.rs:276-277`）。同一函数顺带用于 `_` 前缀过滤（`main.rs:245`）与 title 回退（`main.rs:251`）。

`vendor/codewiki/FORK.md` 是这套 fork 的随文档：基线取证（`FORK.md:5`）、历史（`FORK.md:6`）、魔改点全集（`FORK.md:8-15`，仅两处）、构建安装命令（`FORK.md:17-26`，注意 `cargo install --path` 会联网且本机曾失败，建议直接复制编译产物）、警告（`FORK.md:28-32`，不得用上游原版覆盖、不得放临时目录、改源码后必须重编译并同步两处二进制 + 跑回归）、行为规格表（`FORK.md:34-43`）、验证记录（`FORK.md:45-50`，旧二进制 md5 `835702929c4ec44149ad97ae25192955`、新二进制 md5 `952b0282523ad016c13688cc594afdd8`）、已知有意差异（`FORK.md:52-54`）、构建噪音（`FORK.md:56-58`）。

### 配置项 (Config)

`Config`（`index.js:48-67`）由 `@deepseek-ai/schemastery` 定义，全部字段 `volatile()`；`liveConfig`（`index.js:73-97`）负责取默认值与夹取范围：

- `enabled`（`index.js:49`）：停用后工具立即报错。
- `binaryPath`（`index.js:50`）：`cw` 可执行文件路径；留空则 PATH 优先、再落插件自带 `bin/cw(.exe)`。
- `batchProvider`（`index.js:51`）：编译模型提供商，必须是 DSH 模型设置里已注册的 provider id；**留空将无法提交任务**（提交前置校验见 `index.js:2090-2091`）。
- `batchModel`（`index.js:52`）：默认 `hy3`（见 `DEFAULT_BATCH_MODEL`，`index.js:27`），全部模型环节共用。
- `batchReasoningEffort`（`index.js:53`）：思考程度档位 id，留空用模型默认档。
- `bigProvider`（`index.js:54`）/`bigModel`（`index.js:55`）/`bigReasoningEffort`（`index.js:56`）/`bigTokenBudget`（`index.js:57`）：大档模型相关，单文件超普通预算时改走大档，仍装不下才转会话通道。
- `sessionTier`（`index.js:58`）：超预算转会话通道时的档位 id，留空让会话模型自动选路。
- `maxConcurrency`（`index.js:59`）：并发上限，默认 2（`DEFAULT_CONCURRENCY`，`index.js:24`），硬顶 `CONCURRENCY_HARD_CAP`（`index.js:22`）。
- `serialProjects`（`index.js:60`）：单项目串行，默认开。
- `articleLanguage`（`index.js:61`）：文章语言，也是 `ensureWikiEntry` 的语言入参来源。
- `updateReminder`（`index.js:62`）：会话系统提示注入维护提醒（仅当仓库根存在 `CodeWiki.md`）。
- `excludePaths`（`index.js:63`）：排除编译的绝对路径清单，解析在 `excludedItem`（`index.js:247-256`），`isExcluded` 是它的布尔包装（`index.js:257-259`）。
- `autoUpdate` / `autoUpdateMin`（`index.js:64-65`）：自动增量编译开关与扫描间隔（最小 5 分钟，`index.js:94` 夹取）。
- `workspaceOnly`（`index.js:66`）：任务页只显示已添加工作区的任务。

其余与本主题相关的常量：`JOBS_FILE`（`index.js:1049`，默认在 `os.tmpdir()`，可用 `DSH_CODEWIKI_JOBS_FILE` 隔离）、`TICK_MS`（`index.js:1050`，默认 10000）、`SESSION_TASK_DIR`（`index.js:1055`，会话通道任务文件目录）、`BATCH_TOKEN_BUDGET`（`index.js:369`，默认 110000）、`BATCH_TOKEN_HARD_LIMIT`（`index.js:374`，默认 128000）。

## Architecture

```text
┌───────────────────────────────────┐
│ 插件层 index.js                   │
│ resolveBinary()  :103             │──► where/which 探测 ─► bin/cw.exe 兜底
│ runCw()          :125             │
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
插件侧纵深防御：parseStatus :176 ─► normalizeArticlePath :162
                tickIndex  :1953 ─► normalizeIndexLinks :166（cw index 之后）
收尾补建：     tickIndex  :1976 ─► ensureWikiEntry :209
```

## Data Flow

### 反斜杠路径的完整生命周期（Rust 根治 + 插件兜底）

```text
cw status 执行（Rust，main.rs:126-206）
      │  stale 路径经 rel_path_string()（main.rs:190 → main.rs:337-339）渲染为 /
      ▼
插件 parseStatus（index.js:176-189）
      │  matchAll(/^\s+[M!]\s+(.+)$/gm)
      ▼
normalizeArticlePath（index.js:162）  ← 旧二进制/上游原版仍输出反斜杠时在此兜住
      │
      ├──► changedFiles / staleArticles 进 job.tasks（stale 逐篇更新）
      │
      ▼
cw index 写盘 _index.md（main.rs:227-281，链接由 rel_path_string 渲染，main.rs:243 与 main.rs:269）
      │
      ▼
normalizeIndexLinks（index.js:166-174，仅在 cw index exit 0 后由 tickIndex 调用）
      │  只动 [[ 到 | 之间；无改动返回 false
      ▼
修正后的 _index.md（正文反斜杠不受影响）
```

正常路径下 `normalizeIndexLinks` 返回 `false`——说明 Rust 层已产出 `/` 分隔路径，插件层没有可修的东西；它存在的意义只在「旧二进制 / 用户 PATH 上装的是上游原版」这两种退化场景。

### 编译收尾的 index 阶段（`tickIndex`）

1. `writtenCount === 0`？直接跳过 `cw index` / `cw meta update`，记 note 后切终态（`index.js:1970-1972`）。
2. `resolveBinary` 取二进制（`index.js:1955`）——注意这里用的是**运行时配置**，所以面板改 `binaryPath` 立即生效。
3. 两次 `runCw`（`index.js:1957-1958`）：`cw index` 与 `cw meta update`，退出码写进 note（`index.js:125`），失败再补提示（`index.js:125`）。
4. `cw index` 成功后调 `normalizeIndexLinks`（`index.js:1961`）。
5. `ensureWikiEntry` 补建入口（`index.js:1966`）：缺 `CodeWiki.md` 则生成，失败只记 `note` 不让任务失败（`index.js:209-211`）。
6. 切 `done` + 写 `finishedAt` + `onSettled` 唤醒（`index.js:1973-1975`）。

调度侧与之配合的三点：`tick`（`index.js:1987-2052`）每轮遍历非终态 job，另一实例的 job 若 `updatedAt` 停更超过 `ORPHAN_TAKEOVER_MS`（`index.js:1098`）就被本实例接管（`index.js:1987-1996`，宿主重启后实例 id 变化即走此路径），在途会话通道任务会重发 steer；`submit`（`index.js:2054-2119`）先做排除清单校验（`excludedItem`，`index.js:2056-2059`）、活动任务幂等（`jobs.find`，`index.js:2061-2062`），再按 `kind` 决定起始阶段；job 记录持久化在 `JOBS_FILE`，`mergeFromDisk`（`index.js:1284-1305`）负责把另一实例写入的更新并回内存，`flush`（`index.js:1306-1309`）在脏标记为真时才整写，`touch`（`index.js:1316-1318`）是所有状态变更的统一入口，`setStage`（`index.js:1321-1331`）顺带累计各阶段耗时。

## Connections

- [[modules/core-application|core-application]]：`index.js` 宿主侧全部逻辑所在模块，本文所有插件层锚点的宿主。
- [[modules/testing-suite|testing-suite]]：`test-wiki-entry.mjs` 把本主题固化为回归——入口生成断言（`test-wiki-entry.mjs:59-76`）+ 路径规范化断言（`test-wiki-entry.mjs:59-75`，含 `normalizeArticlePath` 的正斜杠保留与 `undefined` 安全、`parseStatus` 对 stale 反斜杠的清洗、`normalizeIndexLinks` 的幂等与「正文反斜杠不受影响」）。
- [[learnings/update-reminder-entry-gap|update-reminder-entry-gap]]：`ensureWikiEntry` 要补的正是那个不变量缺口（提醒门控依赖入口文件，而流水线曾不创建它）。
- [[concepts/configuration-management|configuration-management]]：`binaryPath` / `maxConcurrency` / `excludePaths` 等配置项的解析与夹取路径（`liveConfig`，`index.js:73-97`）。
- 补充守卫：`test-wiki-anchors.mjs`（动机说明见 `test-wiki-anchors.mjs:1-9`）校验 `.codewiki/**/*.md` 里每个 `index.js:` / `client.js:` 锚点——行号在范围内、指向非空行、同行反引号符号必须出现在锚点行源码中、区间起止有序。符号提取规则在 `test-wiki-anchors.mjs:38-49`，与 `fixAnchors`（`index.js:396-479`）同源（改一处须同步另一处）。本页的行号锚点即以它为回归标准。

## Known Issues

1. **两处二进制必须同步**：`FORK.md:22-23` 要求 `bin/cw.exe`（插件自带）与 `~/.cargo/bin/cw.exe`（PATH 里的全局）一起更新。只更新一处时，`resolveBinary`（`index.js:103-123`）的 PATH 优先策略会让「bash 里直接跑 `cw` 正常、插件包装层行为不同」——这正是该函数注释要避免的分叉形态。
2. **不要用上游原版覆盖 `vendor/codewiki`**：上游是中心制（`~/.codewiki/<project>`），覆盖后编译产物跑 `cw index` 会命中 `No wiki found` 的 bail（`vendor/codewiki/src/main.rs:231-233`）。同理不要把源码放到 Temp 等易清理目录——那正是本页事故的起爆点（`FORK.md:30-31`）。
3. **二进制是「验证过的工件」，md5 一致性记录不应被随意破坏**：`FORK.md:58-58` 明确记录 `cargo build` 产生 1 个 `dead_code` 警告（`WikiMeta` 的 `tags` 字段从未被读取，上游固有），有意不修——为消一个无害警告重编译，会破坏「仓库源码 ↔ 已装二进制」的一致性记录。
4. **内嵌 skill 模板是已知有意差异**：本 fork 构建时嵌入的是 0.5.0.x 文案（`codewiki_generate` 优先、面板、`<repo>/CodeWiki.md` 入口承诺），丢失版二进制嵌入的是子代理时代旧文案；`cw setup claude-code` 写出的文本对应各自内嵌版本，插件不依赖该路径（`FORK.md:54-56`）。
5. **插件层规范化现在是冗余的，但不要删**：正常路径下 `normalizeIndexLinks` 返回 false；它服务的是「旧二进制」或「PATH 上是上游原版」两种退化场景（契约注释里 `rel_path_string` 那一段，`index.js:166-175`）。删除会让这两类环境重新出现 stale 清单与 `_index.md` 链接被反斜杠污染的问题。
6. **行号幻觉历史**：流水线产物曾系统性幻觉 `index.js:` 行号（偏移 34~760 行，校对阶段拦不住，见 `CHANGELOG.md:277-283`），因此 `test-wiki-anchors.mjs` 把「锚点必须对照真实源码核对」制度化（`CHANGELOG.md:277-283`）；0.8.8 又加了落盘前的确定性修正 `fixAnchors`（`index.js:396-479`）作第四层兜底（`CHANGELOG.md:122-131`）。写/改本页后应跑一次锚点测试。
7. **恢复推进依赖心跳与临时目录**：孤儿接管按 `updatedAt` 停更判定（`tick`，`index.js:1987-1996`），而作业状态文件 `JOBS_FILE`（`index.js:1049`）与会话通道任务目录 `SESSION_TASK_DIR`（`index.js:1055`）默认都落在系统临时目录——临时目录被清理会丢活动 job 的记录与在途任务文件，只能重新提交编译。