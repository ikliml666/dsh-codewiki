---
title: 配置与元数据
type: module
source_files:
  - index.js
  - lib/incremental.js
  - lib/graph-diff.js
  - package.json
  - cordis.patch.yml
  - .gitignore
  - .codewiki/_meta.yaml
  - README.md
  - test-incremental.mjs
  - lib/agentic.js
tags: [配置, 元数据, 快照, frontmatter, schemastery, 增量编译]
---

## Overview

本模块是 dsh-codewiki 插件的「配置面」与「元数据面」，横跨三个正交职责：

1. **插件配置（Configuration）**：整个插件的可调设置集合 `Config`（`index.js` 第 60–86 行，基于 `@deepseek-ai/schemastery` 的 `z.object`）以及把原始配置归一化成运行态的 `liveConfig`（`index.js` 第 92–134 行）。全部 25 个字段都标了 `.volatile()`（第 61–85 行），即只活在内存/设置里、**不会持久化到磁盘**（与 job 快照不同，配置无写回需求）。并发上限、模型选择、规划/写作/增量开关都汇聚到这里。
2. **文章 frontmatter 元数据（Metadata — 文章侧）**：wiki 文章的固定元数据契约由 `articleFormatSection`（`index.js` 第 1179–1208 行）定义；配套解析/生成工具 `slugify`（第 1593–1595 行）、`parseSourceFiles`（第 1599–1611 行）、`readSourceFiles`（第 1613–1621 行）、`numberLines`（第 602–604 行）负责把「模块名→文件名」「文章里列了哪些源文件」「行号前缀标注」这些元数据读出来、写出来、规范化。
3. **符号图快照元数据（Metadata — 增量侧）**：增量编译依赖 `.codewiki/temp/symbol-graph.json` 这座「符号级快照」，由 `lib/incremental.js` 的 `SNAPSHOT_VERSION`/`SNAPSHOT_REL`/`SLIM_FIELDS`/`slimGraph`/`saveSnapshot`/`loadSnapshot`/`graphFromSnapshot`/`sameSnapshotContent`/`filterStaleTasks` 管理；哈希计算（`bodyHash`/`codeHash`/`stripComments`/`documentedSource`）来自 `lib/graph-diff.js`。

此外，设置页级联下拉（选编译模型、思考档位）的数据源 `listModelCatalog` / `resolveModelInfoOf` / `resolveModelEfforts`（`index.js` 第 3796–3856 行）也归入本模块，因为它们是配置项的「可选值来源」。仓库根的静态元数据文件 `package.json`（当前版本 0.13.7）、`cordis.patch.yml`、`.gitignore`、`.codewiki/_meta.yaml`、`README.md` 决定插件以何种 id 挂载、默认编译行为从哪取、以及哪些产物不进版本库。

## Key Components

### 1. 配置数据模型与归一化（`index.js`）

`Config`（第 60–86 行）是一个 schemastery 对象，**每个字段都标了 `.volatile()`**（第 61–85 行）——即只活在内存/设置里、**不会持久化到磁盘**（与 `job` 的快照不同，配置无写回需求）。全部 25 个字段默认与运行时归一值见下表：

| 字段 | 默认（第 61–85 行） | 归一化（`liveConfig`）关键行为 | 用途 |
|---|---|---|---|
| `enabled` | `true`（61） | `?? true`（97） | 关闭后两个工具立即报错（第 1564、3403 行） |
| `binaryPath` | `''`（62） | `String(...).trim()`（98） | 手动指定 `cw` 路径；留空走 PATH→捆绑副本（第 140–160 行 `resolveBinary`） |
| `batchProvider` | `'workbuddy'`（63，常量第 35 行） | 原样 `trim()`（99） | 编译模型提供商，必须已在宿主模型设置注册 |
| `batchModel` | `'hy3'`（64，常量第 36 行） | 空则回落默认（100） | 编译模型 id |
| `batchReasoningEffort` | `''`（65） | 原样（101） | 思考档位；空=模型默认档 |
| `bigProvider` | `'volces-ark'`（66，常量第 39 行） | 原样（102） | 大档模型提供商；空=不启用大档 |
| `bigModel` | `'glm-5.3-flash'`（67，常量第 40 行） | 空则回落（103） | 大档模型 id（512k 上下文） |
| `bigReasoningEffort` | `''`（68） | 原样（104） | 大档思考档位 |
| `bigTokenBudget` | `420000`（69，常量第 42 行） | 下限 `BATCH_TOKEN_BUDGET`（105） | 大档单请求输入预算 |
| `sessionTier` | `''`（70） | 原样（106） | 会话通道兜底档位 id；空=自动选路 |
| `maxConcurrency` | `2`（71，常量第 33 行） | 夹 [1, `CONCURRENCY_HARD_CAP=8`]（107–109） | 默认档并发上限 |
| `bigConcurrency` | `0`（72） | 0/空 → 跟随默认档（111–113） | 大档并发上限 |
| `serialProjects` | `true`（73） | `!== false`（114） | 单项目串行开关 |
| `parallelProjects` | `2`（74） | 串行时强制 1，否则夹 [1,4]（115–119） | 并行仓库数上限 |
| `articleLanguage` | `'中文'`（75） | 空则回落（120） | 文章书写语言 |
| `planMode` | `'auto'`（76） | 只允许 `auto`/`dirs`（121） | 模块划分方式 |
| `agenticArticles` | `true`（77） | `!== false`（122） | 是否走 agentic 工具循环写作 |
| `agenticMaxSteps` | `30`（78） | 夹 [1,100]（123–126） | 单篇 agentic 最大步数 |
| `symbolIncremental` | `true`（79） | `!== false`（127） | 是否按 AST 符号级判定变更 |
| `updateReminder` | `true`（80） | 由 `installUpdateReminder` 读取（第 4314 行） | 注入会话维护提醒 |
| `autoCommit` | `true`（81） | `!== false`（131） | 产物自动提交 |
| `excludePaths` | `''`（82） | 原样（128） | 排除清单（第 329–341 行 `excludedItem` 解析） |
| `autoUpdate` | `false`（83） | `=== true`（129） | 定时自动增量编译 |
| `autoUpdateMin` | `30`（84） | 下限 5（130） | 自动扫描间隔（分钟） |
| `workspaceOnly` | `true`（85） | `!== false`（132） | 任务页只显示已添加工作区 |

相关常量：`CONCURRENCY_HARD_CAP=8`（第 31 行）、`DEFAULT_CONCURRENCY=2`（33）、`DEFAULT_BATCH_PROVIDER='workbuddy'`（35）、`DEFAULT_BATCH_MODEL='hy3'`（36）、`DEFAULT_BIG_PROVIDER='volces-ark'`（39）、`DEFAULT_BIG_MODEL='glm-5.3-flash'`（40）、`DEFAULT_BIG_TOKEN_BUDGET=420000`（42）、`BATCH_TOKEN_BUDGET=110000`（586，单请求输入预算）、`BATCH_TOKEN_HARD_LIMIT=128000`（591，单文件硬上限）、`WIKI_PATHS=['.codewiki','CodeWiki.md']`（45，自动提交唯一 pathspec）。

- `val(x)`（第 88–90 行）：若 `x` 是 schemastery 配置（带 `.get()`），取 `.get()`，否则原样返回——`liveConfig` 用它兼容「直接传普通对象」与「传配置代理」两种调用形态。
- `liveConfig(config)`（第 92–134 行）：返回归一化对象，是**唯一**的配置出口；`config` 为 `null` 时全部走默认值（第 93–97 行）。`parallelLimit` 是派生字段（第 115–119 行），串行时恒为 1。
- `normalizeCwd(input)`（第 49–54 行）：仅 Windows 下把 Git-Bash 的 `/e/...` 盘符路径归一为 `E:/...`，POSIX 下原样保留（识别不了也原样交给 `existsSync`）。
- `resolveBinary(cfg)`（第 140–160 行）：`binaryPath` 非空直接返回；否则在 Windows 用 `where cw`、在 POSIX 用 `which cw` 探测 PATH，命中且存在返回；否则回落插件目录 `bin/cw(.exe)`，再不行返回字串 `'cw'`（交给系统 PATH）。
- `excludedItem(cwd, list)`（第 329–338 行）/ `isExcluded`（第 339–341 行）：把 `excludePaths`（换行/分号/逗号分隔，第 330 行）解析为绝对路径清单，判断 cwd 是否等于或位于某项子树内（`codewiki_generate` 入口第 3407 行调用）。

### 2. 文章 frontmatter 元数据格式与解析（`index.js`）

- `articleFormatSection()`（第 1179–1208 行）：**全仓库模块文章的元数据契约源头**。它把合法 frontmatter 与章节骨架硬编码成 prompt 条款——frontmatter 必须含 `title` / `type` / `source_files` / `tags`，章节固定为 `Overview / Key Components / Architecture / Data Flow / Connections / Known Issues`（第 1184–1198 行）；第 1199–1206 行是给写作模型看的硬约束（行号以「行号| 」前缀为准、source_files 必须列出每个读过的文件、禁用/注释处写明具体位置、架构框图放进 ```text 围栏、Obsidian 反链等）。批量单轮写作（`batchArticlePrompt` 第 1048 行起、第 1072 行调用）、文章分割合成批（`batchArticleComposePrompt` 第 1459 行调用）与 agentic 写作（`startAgenticRun` 第 2400 行注入的 `articleFormat`）都引用本函数，模块文章由此共享同一套元数据格式；横切/校对 prompt 各自内联 frontmatter 要求。
- `slugify(name)`（第 1593–1595 行）：模块名 → 文件名 slug。`toLowerCase()` 后保留 CJK 字符（中文顶层目录名直接作 slug，避免塌缩成 `module`），其余非 `Han/a-z0-9-_` 清成 `-`；结果为空回落 `'module'`。`plan.modules[].name` 经它变成 `modules/${slug}.md`（在 `tickArticles` 第 2705 行等处）。
- `parseSourceFiles(fm)`（第 1599–1611 行）：从 frontmatter 文本解析 `source_files`，同时支持**行内数组** `source_files: [a, b]`（第 1600–1603 行）与**缩进块** `source_files:\n  - a`（第 1604–1609 行）两种写法，返回相对路径数组。`fixAnchors`（第 779 行起）与 `readSourceFiles` 都依赖它。
- `readSourceFiles(articlePath)`（第 1613–1621 行）：读文章文件 → 抽 frontmatter（`/^---\r?\n([\s\S]*?)\r?\n---/`，第 1616 行）→ 调 `parseSourceFiles`。stale 增量（`codewiki_generate` 第 3479 行预构建任务读取、第 2967 行校对装填、`localReview` 第 2928 行）用它取「这篇旧文引用了哪些源文件」。
- `numberLines(content)`（第 602–604 行）：给源码每行加 `N| ` 前缀（尾部至多去一个换行，第 603 行 `replace(/\r?\n$/,'')`），是**全仓行号引用约定**的权威实现（`collectSources` 第 1028 行、批/校对 prompt 都靠它）。注意：`lib/agentic.js` 有一份**语义相同但独立**的 `numberLines`（agentic 工具返回的读码结果前缀），两处需保持一致。
- `collectSources(cwd, files, budget)`（第 1017 行起）：按 `BATCH_TOKEN_BUDGET`/大档预算把源文件整文件内联为 markdown（不做半文件截断），每一份用 `numberLines` 加行号前缀（第 1028 行）。

### 3. 符号图快照与增量元数据（`lib/incremental.js` + `lib/graph-diff.js`）

`lib/incremental.js` 顶部注释（第 8–13 行）明确三件事：快照瘦身存取、文件级变更折算组件级、按 frontmatter 的 `source_files` 决定文章保留/跳过。

- `SNAPSHOT_VERSION = 1`（第 19 行）：快照版本；`loadSnapshot` 版本不符即视若无（第 98 行）。
- `SNAPSHOT_REL = 'temp/symbol-graph.json'`（第 22 行）：快照相对 wiki 根的落盘路径，`snapshotPath` 第 90–92 行据此拼绝对路径。
- `SLIM_FIELDS`（第 26 行）：快照只持久化这些字段——`id,name,kind,relativePath,parameters,baseClasses,dependsOn,bodyHash,codeHash`，**不存 `sourceCode`**（体积，`graphFromSnapshot` 回填空串，第 83 行）。
- `slimComponent(node)`（第 28–34 行）：单组件瘦身；固化 `id`/`relativePath` 为字符串。
- `slimGraph(graph, {commit, now})`（第 37–48 行）：`Map<id,node>` → 可 JSON 化快照对象，按 id 排序；现场节点无缓存哈希时现场算 `bodyHash`/`codeHash`（第 42–44 行）固化，回读不再需源码。
- `sameSnapshotContent(a, b)`（第 53–66 行）：忽略 `generatedAt`/`commit` 等每轮必变元数据，仅比 `SLIM_FIELDS`——用于收尾写快照前判断「代码没变就别覆盖」，避免 autoCommit 因只改时间戳而空转提交。
- `graphFromSnapshot(snap)`（第 69–88 行）：快照 → `Map<id,node>`，补回 `sourceCode:''`/`docstring:''`（第 83–84 行），供 `graph-diff` 使用。
- `loadSnapshot(wikiPath, fsImpl)`（第 94–104 行）/ `saveSnapshot(wikiPath, snap, fsImpl, pathImpl)`（第 106–115 行）：带目录自动创建的读写；版本不符/坏 JSON 返回 `null`（第 98–103 行）。`fsImpl`/`pathImpl` 可注入便于单测（`test-incremental.mjs` 覆盖落盘/回读/坏数据）。
- `normRel(p)`（第 118–120 行）：把 `.\src\a.js`、`./src/a.js` 都归一为 `src/a.js`，解决 frontmatter 与快照路径分隔符/前缀不一致（第 177 行 `filterStaleTasks` 用）。
- `componentsByFile(graph)`（第 123–132 行）：按文件聚合组件 id，增量判定时「这篇文章的源文件覆盖了哪些组件」。
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)`（第 140–194 行）：**增量核心判定（纯函数，不碰文件系统）**。输入 `tasks:[{name, articlePath, sources}]` 与新旧图，返回 `{keep, dropped, change, counts, cosmeticOnly}`。`keep[i].changedComponents` 带出真变组件供写作者参考（第 186 行）；`source_files` 里解析不出符号的文章保守 `keep` 并标 `symbolFallback`（第 179–183 行）；`ignoreCommentOnly !== false`（默认）下做**纯注释降级**（第 154–169 行）：`bodyHash` 变但 `codeHash` 没变且 docstring 没变 → 视为无实质变更。
- `describeChange(counts)`（第 197–206 行）：把 `counts`（interface/added/deleted/renamed/body/edge）拼成中文摘要（如「接口变 1、实现变 2」），写进 job note。

`lib/graph-diff.js` 提供哈希原语（被 `slimGraph`/`filterStaleTasks` 间接调用）：
- `normalizeBody(text)`（第 28–30 行）：trim + 空白归一。
- `stripComments(text)`（第 69–100 行）：逐行剥掉块注释与行注释（含字符串感知的 `stripTrailingComment` 第 43–62 行），用于区分「只改注释」与「改了代码」。
- `codeHash(node)`（第 108–111 行）：对 `stripComments` 后的源码做 sha1——注释变化不影响它；`docstring` 不算噪音（见第 105–107 行注释）。
- `documentedSource(node)`（第 114–119 行）：代码 + docstring 合并（Rust `///` 在 sourceCode 之外）。
- `bodyHash(node)`（第 121–126 行）：对 `normalizeBody(documentedSource)` 做 sha1——覆盖整段源码+文档；快照回读节点用固化值。
- `diffGraphs(oldGraph, newGraph, opts)`（第 447–564 行）：组件级变更集（签名变=interface、实现变=body、仅依赖变=edge，删除+新增近似=renamed），并写 `records`（diff 经 `truncateToTokens` 第 251–257 行截断到 `DEFAULT_MAX_DIFF_TOKENS=2000`）。核心入口被 `filterStaleTasks` 调用。
- `changedIds(d)`（第 436–440 行）/ `graphDiffCounts(d)`（第 425–434 行）：从 diff 结果聚合变更 id 集合与计数。

### 4. 模型目录元数据（`index.js`）

- `listModelCatalog(llm)`（第 3796–3817 行）：枚举宿主已注册 provider 及其 models，作为设置页「编译模型」级联下拉数据源；与配置项的 `batchProvider/batchModel/bigProvider/bigModel` 同源（`/api/codewiki/models` 端点第 4080–4095 行注册）。缺 llm 服务时整体降级 `ok:false`。
- `resolveModelInfoOf(llm)`（第 3823–3828 行）：兼容 `resolveModelInfo`（新）与 `resolveModel`（旧宿主/测试桩）两种接口。
- `resolveModelEfforts(llm, provider, model)`（第 3834–3856 行）：取单个 provider/model 的思考档位列表 `reasoning.efforts` 与 `defaultEffort`，驱动设置页 `batchReasoningEffort/bigReasoningEffort` 下拉（`/api/codewiki/model-efforts` 第 4099–4119 行注册）。
- `installUpdateReminder(ctx, config)`（第 4314–4346 行）：通过 `ctx.inject(['systemPrompt'])` 注入 section `codewiki:update-reminder`，当且仅当 `updateReminder !== false` 且仓库根存在 `CodeWiki.md` 时返回提醒文本（第 4327–4329 行）。

### 5. 静态元数据文件（仓库根）

- `package.json`（第 1–28 行）：`name` `@local/dsh-codewiki`（2）、`version` `0.13.7`（3）、`description`（4，CLI `cw` + 全仓 wiki 编译管线 + 侧边栏面板；自 0.13.0 吸收 FSoft-AI4Code/CodeWiki 的 AST 符号提取+LLM 语义聚类、agentic 工具循环写作、符号级增量更新，Node + tree-sitter WASM 实现）、`private: true`（5）、`type: module`（6）、`main: index.js`（7）、`exports` `.` 与 `./client`（8–11）、`license: MIT`（12）、`engines` `node>=20`/`dsh>=0.2.0-rc.0`（13–16）、`dependencies` `@deepseek-ai/schemastery ^3.18.4`（17–19，`index.js` 第 14 行导入后用于定义 `Config`）、`dsh.client.platform=web`（21–23）与 `dsh.bundle.patch=cordis.patch.yml`（24–26）。
- `cordis.patch.yml`：DSH 插件挂载补丁（bundle 形式安装用）。`- insert:` 注册插件 `id: codewiki`，`name` 指向本地 `file:///.../index.js`（Windows 绝对路径，空格写作 `%20`），`config: {}` 为空壳——默认值全部来自 `index.js` 的 `Config`（第 60–86 行），本文件只作用户覆盖层；注释列出 13 个常用配置项（`binaryPath`/`batchProvider`/`batchModel`/`batchReasoningEffort`/`maxConcurrency`/`bigConcurrency`/`serialProjects`/`articleLanguage`/`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`/`updateReminder`），未列出的字段也全部定义在 `Config` schema 里。
- `.gitignore`（第 1–12 行）：忽略 `node_modules/`（1）、`vendor/codewiki/target/`（2）、`*.log`（3）、`bin/*.bak-*`（6，cw 二进制备份）、`.orch-test-out.txt`（8）、`.probe3.txt`（9）、`.dsh-ops/`（12，DSH 运行期产物）。
- `.codewiki/_meta.yaml`（第 1–5 行）：产物元信息——`project: dsh-codewiki`（1）、`repo_path`（2，Windows 路径含空格）、`last_compiled_commit`（3，如 `c8569bcaa3e6c053d2515499142089d5667b9dcc`）、`last_compiled_at`（4，UTC）、`created_at`（5，UTC）。注意这些值是**上次编译时写成的具体值**，随编译刷新的活数据，不是固定契约。
- `README.md`：与 `package.json` 描述同步的能力说明与配置项文档。

## Architecture

```text
┌───────────────────────────┐         ┌──────────────────────────────┐
│ 设置：Config (index.js:60)│──归一───▶│ 文章 frontmatter 契约         │
│ · batchProvider/Model     │ liveConfig│ articleFormatSection         │
│ · bigProvider/Model       │ (:92)    │ (index.js:1179) ◀── 所有文章  │
│ · 并发/增量/写作开关       │         └───────────────┬──────────────┘
└─────────────┬─────────────┘                         │ 产出/解析
              │ 供全链路消费                           ▼
              ▼                        ┌──────────────────────────────┐
┌───────────────────────────┐         │ slugify / parseSourceFiles /  │
│ 模型目录元数据             │ 下拉值   │ readSourceFiles               │
│ listModelCatalog (:3796)  │────────▶│ (index.js:1593/1599/1613)     │
│ resolveModelEfforts(:3834)│         └──────────────────────────────┘
└─────────────┬─────────────┘
              │ stale 预构建任务（codewiki_generate :3479）
              ▼
┌──────────────────────────────────────────────┐
│ 符号图快照 .codewiki/temp/symbol-graph.json   │
│ slimGraph(:37) / saveSnapshot(:106)           │
│ loadSnapshot(:94) / graphFromSnapshot(:69)    │
└─────────────┬────────────────────────────────┘
              │ filterStaleTasks(:140)
              ▼
┌──────────────────────────────────────────────┐
│ keep/dropped 判定 + 纯注释降级                 │
│ bodyHash/codeHash（lib/graph-diff.js:121/108） │
└──────────────────────────────────────────────┘
```

## Data Flow

1. **配置流入**：宿主把 `Config` 注入插件 → `apply`（`index.js` 第 4348 行）持有原始配置 → 任意需要配置处先过 `liveConfig(config)`（第 92 行）拿归一对象。`cw`/`codewiki_generate` 工具入口各自 `liveConfig(cfg)` 先校验 `enabled`（第 1564、3403 行），关闭则直接抛错。
2. **模型选项流出**：设置页前端经 `/api/codewiki/models`、`/api/codewiki/model-efforts`（`index.js` 第 4080、4099 行）调 `listModelCatalog`/`resolveModelEfforts`，把可选 provider/model/effort 回填到 `batchProvider/batchModel/batchReasoningEffort` 等配置字段。
3. **frontmatter 在增量中的往返**：`codewiki_generate` 对 stale 文章先用 `readSourceFiles` 取旧文 `source_files`（第 3479 行）作为预构建任务的 `sources`（文章名沿用 cw status 给出的相对路径）交给 job 服务写文章；全量编译则由 `plan.modules[].name` 经 `slugify`（第 2705 行）变成 `modules/<slug>.md`。新文章由 `articleFormatSection` 规定的格式产出，行号由 `collectSources` 内联源码时的 `numberLines` 前缀标注（第 1028 行）。
4. **快照在增量中的往返**：全量编译收尾写 `saveSnapshot(wikiPath, slimGraph(graph, {commit}))`（`lib/incremental.js` 第 106、37 行）；下次 stale 编译用 `loadSnapshot` 回读旧图、`extractCurrentGraph`（`index.js` 第 1924 行）取新图 → `filterStaleTasks` 比组件级变更 → 决定 `keep`/`dropped`，并用 `describeChange` 写 note。

## Connections

- [[pipeline-orchestration]]：`createJobService`（`index.js` 第 2056 行起的 `submit`/`tick`）是配置与快照的**最大消费者**——它读 `liveConfig` 决定并发/模型/规划开关，收尾阶段 `saveSnapshot` 落快照（第 3092 行）；stale 增量的 `filterStaleTasks` 判定在提交侧 `generateToolDefinition`（第 3509 行）完成后经 `submit` 进入服务。
- [[codewiki-cli-wrapper]]：`cw` 工具（`cwToolDefinition` 第 1522 行）与 `resolveBinary`（第 140 行）受 `binaryPath`/`enabled` 配置控制；`parseStatus`（第 213 行）判定 wiki 三态供增量分支使用。
- [[agentic-article-writing]]：`lib/agentic.js` 的 `numberLines` 与本模块 `numberLines`（`index.js` 第 602 行）是同一行号约定；`TOOL_SCHEMAS`（`index.js` 第 24 行从 `lib/agentic.js` 导入）定义 agentic 工具的元数据描述。
- [[semantic-planning]]：`semanticPlan`/`localPlan`（`index.js` 第 1245、1223 行）产出的 `plan.modules[].name` 经本模块 `slugify`（第 2705 行）变成文章文件名。
- [[symbol-extraction]]：`extractRepoGraph`（`index.js` 第 16 行导入、`extractCurrentGraph` 第 1924 行调用）产出的图是 `slimGraph`/`filterStaleTasks` 的输入。

## Known Issues

- **`liveConfig` 默认档并发与 `bigConcurrency` 易混**：`bigConcurrency` 为 0/未填时归一为 0、运行期跟随默认档（第 111–113 行），文档与面板需讲清「两池独立、大档 0=跟随默认」；第 110 行注释明确该兜底与 0.12.1 前的单一池行为等价，0.12.2 起两池才独立限流。
- **纯注释降级依赖 `codeHash` 字段**：若组件算不出 `codeHash`（旧快照缺该字段时回读节点为 null），`filterStaleTasks` 不做降级、保守归入需重写——即「降级失效」而非漏更，是安全方向，但意味着这类组件每次比对都会触发重写。
- **frontmatter 解析是弱正则**：`parseSourceFiles` 只认 `source_files:` 后行内 `[...]` 或缩进 `- ...` 两种形态（第 1600–1609 行），其他写法（如 YAML 多行字符串）会解析为空数组——stale 流程会直接跳过该文章（第 3480–3482 行，提示可手工处理或用 scope=full），存在漏更风险；`source_files` 非空但解析不出符号的文章才走 `symbolFallback` 保守保留（第 179–183 行）。
- **两处 `numberLines` 需同步**：`index.js` 第 602 行（批量/校对装填）与 `lib/agentic.js` 的 `numberLines`（agentic 读码前缀）是同一约定两份实现，改一处须同步另一处，否则模型在两种通道里看到不一致的行号前缀。
- **`WIKI_PATHS` 只认两个路径**：`autoCommitWiki`（第 4186 行）只用 pathspec `.codewiki` 与 `CodeWiki.md`，不扩到 `-A`——若用户把 wiki 产物挪到别的路径会提交不到（第 43–45 行注释明确这是有意为之，避免卷入其它改动）。
