---
title: 配置与元数据（Configuration and Metadata）
type: module
source_files:
  - index.js
  - lib/incremental.js
  - lib/graph-diff.js
  - test-incremental.mjs
  - test-batch.mjs
  - lib/agentic.js
  - package.json
  - cordis.patch.yml
  - .gitignore
  - .codewiki/_meta.yaml
  - README.md
tags: [配置, 元数据, 快照, frontmatter, schemastery, 增量编译]
---

## Overview

本模块是 dsh-codewiki 插件的「配置面」与「元数据面」，横跨三个正交职责：

1. **插件配置（Configuration）**：整个插件的可调设置集合 `Config`（`index.js` 第 60–86 行，`@deepseek-ai/schemastery` 的 `z.object`）以及把原始配置归一化成运行态的 `liveConfig`（`index.js` 第 92–134 行）。所有并发上限、模型选择、规划/写作/增量开关最终都汇聚到这里。
2. **文章 frontmatter 元数据（Metadata — 文章侧）**：wiki 文章的固定元数据契约由 `articleFormatSection`（`index.js` 第 897–926 行）定义；配套解析/生成工具 `slugify`（第 1311–1313 行）、`parseSourceFiles`（第 1317–1329 行）、`readSourceFiles`（第 1331–1339 行）、`numberLines`（第 597–599 行）负责把「模块名→文件名」「文章里列了哪些源文件」「行号前缀标注」这些元数据读出来、写出来、规范化。
3. **符号图快照元数据（Metadata — 增量侧）**：增量编译依赖 `.codewiki/temp/symbol-graph.json` 这座「符号级快照」，由 `lib/incremental.js` 的 `slimGraph`/`saveSnapshot`/`loadSnapshot`/`graphFromSnapshot`/`filterStaleTasks` 管理，哈希计算（`bodyHash`/`codeHash`/`stripComments`）来自 `lib/graph-diff.js`。

此外，设置页级联下拉（选编译模型、思考档位）的数据源 `listModelCatalog` / `resolveModelEfforts`（`index.js` 第 3516–3576 行）也归入本模块，因为它们是配置项的「可选值来源」。

## Key Components

### 1. 配置数据模型与归一化（`index.js`）

`Config`（第 60–86 行）是一个 schemastery 对象，**每个字段都标了 `.volatile()`**——即它们只活在内存/设置里、**不会持久化到磁盘**（与 `job` 的快照不同，配置无写回需求）。全部字段默认与运行时归一值见下表：

| 字段 | 默认（第 61–85 行） | 归一化（`liveConfig`）关键行为 | 用途 |
|---|---|---|---|
| `enabled` | `true`（61） | `?? true`（97） | 关闭后两个工具立即报错（第 1282、3123 行） |
| `binaryPath` | `''`（62） | `String(...).trim()`（98） | 手动指定 `cw` 路径；留空走 PATH→捆绑副本（第 141–159 行 `resolveBinary`） |
| `batchProvider` | `'workbuddy'`（63，常量第 35 行） | 原样（99） | 编译模型提供商，必须已在宿主模型设置注册 |
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
| `updateReminder` | `true`（80） | 由 `installUpdateReminder` 读取（第 4047 行） | 注入会话维护提醒 |
| `autoCommit` | `true`（81） | `!== false`（131） | 产物自动提交 |
| `excludePaths` | `''`（82） | 原样（128） | 排除清单（第 324–336 行解析） |
| `autoUpdate` | `false`（83） | `=== true`（129） | 定时自动增量编译 |
| `autoUpdateMin` | `30`（84） | 下限 5（130） | 自动扫描间隔（分钟） |
| `workspaceOnly` | `true`（85） | `!== false`（132） | 任务页只显示已添加工作区 |

相关常量：`CONCURRENCY_HARD_CAP=8`（第 31 行）、`DEFAULT_CONCURRENCY=2`（33）、`DEFAULT_BATCH_PROVIDER='workbuddy'`（35）、`DEFAULT_BATCH_MODEL='hy3'`（36）、`DEFAULT_BIG_PROVIDER='volces-ark'`（39）、`DEFAULT_BIG_MODEL='glm-5.3-flash'`（40）、`DEFAULT_BIG_TOKEN_BUDGET=420000`（42）、`BATCH_TOKEN_BUDGET=110000`（581，单请求输入预算）、`BATCH_TOKEN_HARD_LIMIT=128000`（586，单文件硬上限）、`WIKI_PATHS=['.codewiki','CodeWiki.md']`（45，自动提交唯一 pathspec）。

- `val(x)`（第 88–90 行）：若 `x` 是 schemastery 配置（带 `.get()`），取 `.get()`，否则原样返回——`liveConfig` 用它兼容「直接传普通对象」与「传配置代理」两种调用形态。
- `liveConfig(config)`（第 92–134 行）：返回归一化对象，是**唯一**的配置出口；`config` 为 `null` 时全部走默认值（第 93–97 行）。`parallelLimit` 是派生字段（第 115–119 行），串行时恒为 1。
- `normalizeCwd(input)`（第 49–54 行）：仅 Windows 下把 Git-Bash 的 `/e/...` 盘符路径归一为 `E:/...`，POSIX 下原样保留（识别不了也原样交给 `existsSync`）。

### 2. 文章 frontmatter 元数据格式与解析（`index.js`）

- `articleFormatSection()`（第 897–926 行）：**全仓库 wiki 文章的元数据契约源头**。它把合法 frontmatter 与章节骨架硬编码成 prompt 条款——frontmatter 必须含 `title` / `type` / `source_files` / `tags`，章节固定为 `Overview / Key Components / Architecture / Data Flow / Connections / Known Issues`（第 900–916 行）；第 917–924 行是给写作模型看的硬约束（行号以「行号| 」前缀为准、source_files 必须列出每个读过的文件、禁用/注释处写明具体位置、架构框图放进 ```text 围栏、Obsidian 反链等）。批量单轮写作（`batchArticlePrompt` 第 766–793 行）、agentic 写作（`runAgenticArticles` 注入的 `articleFormat`）、横切/校对 prompt 都引用本函数，因此所有维基文章共享同一套元数据格式。
- `slugify(name)`（第 1311–1313 行）：模块名 → 文件名 slug。`toLowerCase()` 后保留 CJK 字符（中文顶层目录名直接作 slug，避免塌缩成 `module`），其余非 `Han/a-z0-9-_` 清成 `-`；结果为空回落 `'module'`。`plan.modules[].name` 经它变成 `modules/${slug}.md`（第 2430–2436 行）。
- `parseSourceFiles(fm)`（第 1317–1329 行）：从 frontmatter 文本解析 `source_files`，同时支持**行内数组** `source_files: [a, b]`（第 1318–1321 行）与**缩进块** `source_files:\n  - a`（第 1322–1327 行）两种写法，返回相对路径数组。`fixAnchors`（第 608–730 行）与 `readSourceFiles` 都依赖它。
- `readSourceFiles(articlePath)`（第 1331–1339 行）：读文章文件 → 抽 frontmatter → 调 `parseSourceFiles`。stale 增量（`codewiki_generate` 第 3199 行预构建任务、第 2692 行校对装填、`localReview` 第 2653 行）用它取「这篇旧文引用了哪些源文件」。
- `numberLines(content)`（第 597–599 行）：给源码每行加 `N| ` 前缀（尾部至多去一个换行），是**全仓行号引用约定**的权威实现（`collectSources` 第 746 行、`fixAnchors` 第 641 行、批/校对 prompt 都靠它）。注意：`lib/agentic.js` 第 101–106 行有一份**语义相同但独立**的 `numberLines`（agentic 工具返回的读码结果前缀），两处需保持一致。

### 3. 符号图快照与增量元数据（`lib/incremental.js` + `lib/graph-diff.js`）

`lib/incremental.js` 顶部注释（第 8–13 行）明确三件事：快照瘦身存取、文件级变更折算组件级、按 frontmatter 的 `source_files` 决定文章保留/跳过。

- `SNAPSHOT_VERSION = 1`（第 19 行）：快照版本；`loadSnapshot` 版本不符即视若无（第 98 行）。
- `SNAPSHOT_REL = 'temp/symbol-graph.json'`（第 22 行）：快照相对 wiki 根的落盘路径，`snapshotPath` 第 90–92 行据此拼绝对路径。
- `SLIM_FIELDS`（第 26 行）：快照只持久化这些字段——`id,name,kind,relativePath,parameters,baseClasses,dependsOn,bodyHash,codeHash`，**不存 `sourceCode`**（体积，`graphFromSnapshot` 回填空串，第 83 行）。
- `slimComponent(node)`（第 28–34 行）：单组件瘦身；固化 `id`/`relativePath` 为字符串。
- `slimGraph(graph, {commit, now})`（第 37–48 行）：`Map<id,node>` → 可 JSON 化快照对象，按 id 排序；现场节点无缓存哈希时现场算 `bodyHash`/`codeHash`（第 42–44 行）固化，回读不再需源码。
- `sameSnapshotContent(a, b)`（第 53–66 行）：忽略 `generatedAt`/`commit` 等每轮必变元数据，仅比 `SLIM_FIELDS`——用于收尾写快照前判断「代码没变就别覆盖」，避免 autoCommit 因只改时间戳而空转提交。
- `graphFromSnapshot(snap)`（第 69–88 行）：快照 → `Map<id,node>`，补回 `sourceCode:''`/`docstring:''`（第 83–84 行），供 `graph-diff` 使用。
- `loadSnapshot(wikiPath, fsImpl)`（第 94–104 行）/ `saveSnapshot(wikiPath, snap, fsImpl, pathImpl)`（第 106–115 行）：带目录自动创建的读写；版本不符/坏 JSON 返回 `null`（第 98–103 行）。`fsImpl`/`pathImpl` 可注入便于单测。
- `normRel(p)`（第 118–120 行）：把 `.\src\a.js`、`./src/a.js` 都归一为 `src/a.js`，解决 frontmatter 与快照路径分隔符/前缀不一致（第 169–176 行 `filterStaleTasks` 用）。
- `componentsByFile(graph)`（第 123–132 行）：按文件聚合组件 id，增量判定时「这篇文章的源文件覆盖了哪些组件」。
- `filterStaleTasks(tasks, oldGraph, newGraph, opts)`（第 140–194 行）：**增量核心判定（纯函数，不碰文件系统）**。输入 `tasks:[{name, articlePath, sources}]` 与新旧图，返回 `{keep, dropped, change, counts, cosmeticOnly}`。`keep[i].changedComponents` 带出真变组件供写作者参考（第 138 行）；`source_files` 里解析不出符号的文章保守 `keep` 并标 `symbolFallback`（第 179–183 行）；`ignoreCommentOnly !== false`（默认）下做**纯注释降级**（第 154–169 行）：`bodyHash` 变但 `codeHash` 没变且 docstring 没变 → 视为无实质变更。
- `describeChange(counts)`（第 197–206 行）：把 `counts`（interface/added/deleted/renamed/body/edge）拼成中文摘要（如「接口变 1、实现变 2」），写进 job note。

`lib/graph-diff.js` 提供哈希原语（被 `slimGraph`/`filterStaleTasks` 间接调用）：
- `normalizeBody(text)`（第 28–30 行）：trim + 空白归一。
- `stripComments(text)`（第 69–100 行）：逐行剥掉块注释与行注释（含字符串感知的 `stripTrailingComment` 第 43–62 行），用于区分「只改注释」与「改了代码」。
- `codeHash(node)`（第 108–111 行）：对 `stripComments` 后的源码做 sha1——注释变化不影响它；`docstring` 不算噪音（见第 105–107 行注释）。
- `documentedSource(node)`（第 114–119 行）：代码 + docstring 合并（Rust `///` 在 sourceCode 之外）。
- `bodyHash(node)`（第 121–126 行）：对 `normalizeBody(documentedSource)` 做 sha1——覆盖整段源码+文档；快照回读节点用固化值。

### 4. 模型目录元数据（`index.js`）

- `listModelCatalog(llm)`（第 3516–3537 行）：枚举宿主已注册 provider 及其 models，作为设置页「编译模型」级联下拉数据源；与配置项的 `batchProvider/batchModel/bigProvider/bigModel` 同源（`/api/codewiki/models` 端点第 3800–3815 行）。缺 llm 服务时整体降级 `ok:false`。
- `resolveModelInfoOf(llm)`（第 3543–3548 行）：兼容 `resolveModelInfo`（新）与 `resolveModel`（旧宿主/测试桩）两种接口。
- `resolveModelEfforts(llm, provider, model)`（第 3554–3576 行）：取单个 provider/model 的思考档位列表 `reasoning.efforts` 与 `defaultEffort`，驱动设置页 `batchReasoningEffort/bigReasoningEffort` 下拉（`/api/codewiki/model-efforts` 第 3819–3839 行）。

## Architecture

```text
┌─────────────────────────┐         ┌──────────────────────────┐
│  设置 (schemastery)     │         │  文章 frontmatter 契约   │
│  Config (index.js:60)   │──归一──▶│  articleFormatSection     │
│  · batchProvider/Model  │  liveConfig                (index.js:897)  ◀── 所有文章格式
│  · bigProvider/Model    │  (index.js:92)            └────────────┬─────────┘
│  · 并发/开关            │                                         │ 产出/解析
└───────────┬─────────────┘                                         ▼
            │ 供全链路消费                                          ┌──────────────────────┐
            ▼                                                       │ slugify/parseSource  │
┌─────────────────────────┐          ┌──────────────────────┐      │ Files/readSourceFiles │
│ 模型目录元数据          │          │ stale 增量任务构建    │─────▶│ (index.js:1311/1317)  │
│ listModelCatalog (3516) │─────────▶│ codewiki_generate     │      └──────────────────────┘
│ resolveModelEfforts     │ 下拉值   │ (:3199 预构建任务)    │
│ (3554)                  │          └──────────┬───────────┘
└─────────────────────────┘                     │ 旧图 vs 新图
                                                  ▼
                                       ┌──────────────────────────┐
                                       │ 符号图快照 (.codewiki/    │
                                       │   temp/symbol-graph.json) │
                                       │ slimGraph/saveSnapshot   │
                                       │ loadSnapshot(:94/:106)    │
                                       │ graphFromSnapshot(:69)    │
                                       └───────────┬──────────────┘
                                                   │ filterStaleTasks(:140)
                                                   ▼
                                       ┌──────────────────────────┐
                                       │ 判定 keep/dropped + 降级  │
                                       │ bodyHash/codeHash (graph  │
                                       │   -diff.js:108/121)       │
                                       └──────────────────────────┘
```

## Data Flow

1. **配置流入**：宿主把 `Config` 注入插件 → `apply`（`index.js` 第 4068 行）持有原始配置 → 任意需要配置处先过 `liveConfig(config)`（第 92 行）拿归一对象。`cw`/`codewiki_generate` 工具入口各自 `liveConfig(cfg)` 先校验 `enabled`（第 1282、3123 行），关闭则直接抛错。
2. **模型选项流出**：设置页前端经 `/api/codewiki/models`、`/api/codewiki/model-efforts`（`index.js` 第 3800、3819 行）调 `listModelCatalog`/`resolveModelEfforts`，把可选 provider/model/effort 回填到 `batchProvider/batchModel/batchReasoningEffort` 等配置字段。
3. **frontmatter 在增量中的往返**：`codewiki_generate` 对 stale 文章先用 `readSourceFiles` 取旧文 `source_files`（第 3199 行）→ 作为预构建任务的 `sources` → 连同 `slugify` 出的文件名一起交给 job 服务写文章 → 新文章由 `articleFormatSection` 规定的格式产出，行号由 `numberLines`/`collectSources` 标注。
4. **快照在增量中的往返**：全量编译收尾写 `saveSnapshot(wikiPath, slimGraph(graph, {commit}))`（`lib/incremental.js` 第 106、37 行）；下次 stale 编译用 `loadSnapshot` 回读旧图、`extractCurrentGraph`（`index.js` 第 1642 行）取新图 → `filterStaleTasks` 比组件级变更 → 决定 `keep`/`dropped`，并用 `describeChange` 写 note。

## Connections

- [[pipeline-orchestration]]：`createJobService`（`index.js` 第 1774 行起的 `submit`/`tick`）是配置与快照的**最大消费者**——它读 `liveConfig` 决定并发/模型/规划开关，调用 `filterStaleTasks` 做增量、`saveSnapshot` 落快照。
- [[codewiki-cli-wrapper]]：`cw` 工具（`cwToolDefinition` 第 1240 行）与 `resolveBinary`（第 140 行）受 `binaryPath`/`enabled` 配置控制；`parseStatus`（第 213 行）判定 wiki 三态供增量分支使用。
- [[agentic-article-writing]]：`lib/agentic.js` 的 `numberLines`（第 101 行）与本模块 `numberLines`（第 597 行）是同一行号约定；`TOOL_SCHEMAS`（第 27 行）定义工具的元数据描述。
- [[semantic-planning]]：`semanticPlan`/`localPlan`（`index.js` 第 963、941 行）产出的 `plan.modules[].name` 经本模块 `slugify`（第 2430 行）变成文章文件名。
- [[symbol-extraction]]：`extractRepoGraph`（`index.js` 第 16 行导入、`extractCurrentGraph` 第 1642 行调用）产出的图是 `slimGraph`/`filterStaleTasks` 的输入。

## Known Issues

- **`liveConfig` 默认档并发与 `bigConcurrency` 易混**：`bigConcurrency` 为 0/未填时回落默认档（第 111–113 行），文档与面板需讲清「两池独立、大档 0=跟随默认」；旧 0.12.1 前是单一池，行为不同（第 110 行注释）。
- **纯注释降级依赖 `codeHash` 字段**：若旧快照缺 `codeHash`（如从 `<version 1/SNAPSHOT_VERSION` 升级前），`filterStaleTasks` 会保守保留（第 109–118 行测试覆盖），即「降级失效」而非误删——是安全方向，但意味着存量快照第一次比对仍可能重写。
- **frontmatter 解析是弱正则**：`parseSourceFiles` 只认 `source_files:` 后行内 `[...]` 或缩进 `- ...` 两种形态（第 1318–1327 行），其他写法（如 YAML 多行字符串）会解析为空数组 → stale 任务以 `symbolFallback` 保守保留（第 179–183 行），文章不会漏更但可能多写。
- **两处 `numberLines` 需同步**：`index.js` 第 597 行（批量/校对装填）与 `lib/agentic.js` 第 101 行（agentic 读码前缀）是同一约定两份实现，改一处须同步另一处，否则模型在两种通道里看到不一致的行号前缀。
- **`WIKI_PATHS` 只认两个路径**：`autoCommitWiki`（第 3906 行）只用 pathspec `.codewiki` 与 `CodeWiki.md`，不扩到 `-A`——若用户把 wiki 产物挪到别的路径会提交不到（第 43–45 行注释明确这是有意为之，避免卷入其它改动）。

## Overview

本模块负责定义 `@local/dsh-codewiki` 项目的**核心包元数据、运行时依赖约束、DSH 插件挂载补丁、Git 忽略规则与 CodeWiki 产物元信息**。它由若干静态文件组成，自身不含任何可执行逻辑，但在 `dsh bundle` 打包 / 本地开发直挂时被 DSH 宿主读取，决定插件以何种 id 挂载、默认编译行为（模型、并发、分层策略）从哪取、以及哪些产物不进版本库。本模块还覆盖 `index.js` 中 `Config` schema（行60-86）与 `liveConfig()`（行92-134）这两个**配置项的唯一定义来源**——`cordis.patch.yml` 只注释了 13 个常用配置项，真正的全量字段与默认值都写在 `index.js` 里。

组成文件：

- `package.json`（行1-28）：Node.js/DSH 环境要求、基础依赖与 DSH 打包字段，是插件行为的「包级声明」。
- `cordis.patch.yml`（行1-33）：DSH 插件系统的 Cordis 挂载补丁（`- insert:` 注册 id `codewiki`），`config: {}`（行24）为空壳，默认值来自 `index.js` 的 `Config`。
- `index.js` 的 `Config` / `liveConfig`（行60-134）：编译配置 schema 与运行期归一化逻辑，是全部 25 个配置项的真实来源。
- `.gitignore`（行1-12）：构建产物、cw 二进制备份、DSH 运行期产物、测试输出不入库。
- `.codewiki/_meta.yaml`（行1-5）：CodeWiki 编译产物的元信息。
- `README.md`（行1-91）：与 `package.json` 描述同步的能力说明与配置项文档。

当前版本 `0.13.5`（`package.json` 行3）。`package.json` 行4 描述明确了：CLI（`cw`）、全仓库 Wiki 编译管线（插件内、默认 `workbuddy`/`hy3` 192k 上下文、`large tier volces-ark/glm-5.3-flash` 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能；并声明自 0.13.0 起吸收了 FSoft-AI4Code/CodeWiki 的 AST 符号提取 + LLM 语义聚类、agentic 工具循环文章写作、符号级增量更新，基于 Node + tree-sitter WASM 实现（无 Python 运行时）。

## Key Components

本模块由一组静态配置文件与 `index.js` 中的配置 schema 组成。其中 `index.js` 的 `Config`（行60-86）/ `liveConfig`（行92-134）是唯一完整的配置项定义来源；静态文件的字段含义与行号如下。

### package.json

位于仓库根目录，JSON 格式包声明文件（源码行1-28）。无代码函数/类，以下为各字段含义与行号。

- **行2** `"name": "@local/dsh-codewiki"`：项目唯一标识符（命名空间 `@local/` 表示本地私有包）。
- **行3** `"version": "0.13.5"`：当前语义化版本号。
- **行4** `"description"`：长描述，说明 CLI（`cw`）、全仓库 Wiki 编译管线（插件内、默认 `workbuddy`/`hy3` 192k、large tier `volces-ark/glm-5.3-flash` 512k 用于超大输入、零子代理、单项目串行）及侧边栏面板功能；并声明自 0.13.0 起吸收 FSoft-AI4Code/CodeWiki 的三层能力（AST 符号提取+LLM 语义聚类、agentic 工具循环写作、符号级增量），用 Node + tree-sitter WASM 实现，无 Python 运行时。
- **行5** `"private": true`：私有包，防止误发布到公共注册表。
- **行6** `"type": "module"`：启用 ES Modules (ESM)，所有 `.js` 文件默认按 ESM 处理（对应 `index.js` 行8 起的 `import`、`import.meta.url` 用法）。
- **行7** `"main": "index.js"`：入口点，也是 DSH 宿主加载插件时执行的模块。
- **行8-11** `"exports"`：子路径导出。
  - **行9** `"."` 映射至 `./index.js`。
  - **行10** `"./client"` 映射至 `./client.js`（浏览器半侧 UI，见 `client-interface`）。
- **行12** `"license": "MIT"`：开源许可证。
- **行13-16** `"engines"`：
  - **行14** `"node": ">=20"`：强制 Node.js ≥ 20。
  - **行15** `"dsh": ">=0.2.0-rc.0"`：强制 DeepSeek Harness ≥ 0.2.0-rc.0。
- **行17-19** `"dependencies"`：
  - **行18** `"@deepseek-ai/schemastery": "^3.18.4"`：运行时依赖，`index.js` 行14 通过 `import z from '@deepseek-ai/schemastery'` 用它定义 `Config` schema（行60-86）与各类工具参数 schema。
- **行20-27** `"dsh"`：自定义字段，专供 DSH 工具链使用。
  - **行21-23** `"client"`：`"platform": "web"`（行22），指定客户端运行平台为 Web（对应 `client.js` 浏览器半侧）。
  - **行24-26** `"bundle"`：`"patch": "cordis.patch.yml"`（行25），指定 `dsh bundle` 打包时使用的 Cordis 补丁文件路径。

### cordis.patch.yml

位于仓库根目录，YAML 格式补丁定义文件（源码行1-33）。由 `dsh bundle` 或 Cordis 加载器读取。

- **行1-4** 注释块：
  - 行1 说明文件用途：dsh-codewiki — CodeWiki (mraza007/codewiki) for DeepSeek Harness。
  - 行2 说明 0.13.0 起吸入 AST 聚类 / agentic 写作 / 符号级增量三层能力。
  - 行3-4 说明挂载方式：本文件供 **bundle 形式安装**用；本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂（URL 中空格写 `%20`），二者保持 id 一致为 `codewiki`。⚠️ 注意：仓库当前**不存在 `profiles/` 目录**（见 `README.md` 行66-81 的安装说明，该直挂文件需手动追加），本文件是 bundle 形态的挂载声明。
- **行5** 说明设置项 config 命名空间 = `codewiki`（注释，非 YAML 键）。
- **行6-18** 注释块列出 13 个常用配置项含义（仅注释，未在 YAML 主体展开默认值）：
  - `binaryPath`（行6）：cw 可执行路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw.exe`。
  - `batchProvider`（行7）：编译模型提供商（必须是模型设置里已注册的 provider；默认 `workbuddy`，留空=提交失败）。
  - `batchModel`（行8）：编译模型 id（默认 `hy3`，免费 192k 上下文）。
  - `batchReasoningEffort`（行9）：思考档位（取值来自模型目录 `reasoning.efforts`；留空=模型默认档）。
  - `maxConcurrency`（行10）：默认档并发上限（1–8，默认 2）。
  - `bigConcurrency`（行11）：大档并发上限（1–8，默认 0=跟随默认档），与默认档各自独立限流、同时推进。
  - `serialProjects`（行12）：单项目串行（默认开）。
  - `articleLanguage`（行13）：文章语言（默认中文）。
  - `planMode`（行14）：模块划分 auto=AST 符号+LLM 语义聚类（默认）｜dirs=顶层目录分组（旧行为）。
  - `agenticArticles`（行15）：文章写作走 agentic 工具循环（默认开）。
  - `agenticMaxSteps`（行16）：agentic 单篇步数上限（默认 30，1–100）。
  - `symbolIncremental`（行17）：增量按 AST 符号级判定（默认开）。
  - `updateReminder`（行18）：会话系统提示注入 wiki 维护提醒（默认开）。
  - 注：注释覆盖 13 项，**未列出** `enabled`/`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`/`sessionTier`/`parallelProjects`/`autoCommit`/`excludePaths`/`autoUpdate`/`autoUpdateMin`/`workspaceOnly` 这些字段。它们全部定义在 `index.js` 的 `Config` schema（行60-86）里，默认值见 `liveConfig()`（行92-134）；含义与可选值在 `README.md` 行47-64 有完整文档。
- **行19** `- insert:`：Cordis 的插入操作根节点。
- **行20** `- id: codewiki`：插件 ID，固定为 `codewiki`，须全局唯一且须与本地开发配置一致。
- **行21** `name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`：指向本地绝对路径的 `index.js`，含空格编码 `%20`，为 Windows 绝对路径。此为 bundle 安装形态声明。
- **行22-23** 注释：默认值不在本文件重复声明——留空即用插件 `Config` schema 里的默认值（见 `index.js` 的 `Config`）。想改哪项就填哪项。
- **行24** `config: {}`：初始配置对象为空。实际默认值来自 `index.js` 的 `Config`（行60-86）与 `liveConfig()`（行92-134）合并逻辑；本文件只作为用户覆盖层。
- **行25-33** 注释示例：展示如何填写 `config`（行26-33 注掉）以换编译模型、调并发、关掉 agentic 写作等，逐项对应行6-18 的配置项。

### index.js — Config schema（行60-86）与 liveConfig（行92-134）

`index.js` 是配置项的唯一完整定义处。靠顶部的常量（行30-45）给出若干默认值常量，再经 `Config`（行60-86，基于 `@deepseek-ai/schemastery` 的 `z.object`）声明 25 个字段。`liveConfig()`（行92-134）把读取到的 patch 配置归一化为运行期值（处理缺省、钳制范围、空串回退到默认常量）。全部字段如下：

| 字段 | 声明行 | 默认值（schema） | 用途 |
|------|--------|------------------|------|
| `enabled` | 行61 | `true` | 停用后两个工具立即报错 |
| `binaryPath` | 行62 | `''` | cw 可执行路径；留空优先用 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | 行63 | `workbuddy`（常量行35） | 编译模型提供商（模型设置里已注册的 provider id） |
| `batchModel` | 行64 | `hy3`（常量行36） | 编译模型 id（该 provider 下的模型 id） |
| `batchReasoningEffort` | 行65 | `''` | 思考档位 id；留空=模型默认档 |
| `bigProvider` | 行66 | `volces-ark`（常量行39） | 大档模型提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | 行67 | `glm-5.3-flash`（常量行40） | 大档模型 id（默认 512k 上下文） |
| `bigReasoningEffort` | 行68 | `''` | 大档模型思考档位；留空=模型默认档 |
| `bigTokenBudget` | 行69 | `420000`（常量行42） | 大档单请求输入预算（token）；输入超 110k 普通预算改用大档 |
| `sessionTier` | 行70 | `''` | 会话通道档位 id（仅大档都装不下且 `bigProvider` 留空时兜底） |
| `maxConcurrency` | 行71 | `2`（常量行33） | 默认档并发上限（1–8，硬顶 8） |
| `bigConcurrency` | 行72 | `0` | 大档并发上限（1–8，硬顶 8）；0/留空=跟随默认档 |
| `serialProjects` | 行73 | `true` | 单项目串行；关闭后按 `parallelProjects` 并行推进多仓库 |
| `parallelProjects` | 行74 | `2` | 并行推进的仓库编译任务上限（1–4），关闭单项目串行后生效 |
| `articleLanguage` | 行75 | `中文` | wiki 文章书写语言 |
| `planMode` | 行76 | `auto` | 模块划分方式：`auto`=AST 符号+LLM 语义聚类，`dirs`=顶层目录分组 |
| `agenticArticles` | 行77 | `true` | 文章写作走 agentic 工具循环；关闭走单轮整包装填旧通道 |
| `agenticMaxSteps` | 行78 | `30` | agentic 写作单篇最大步数（硬顶 100） |
| `symbolIncremental` | 行79 | `true` | stale 增量按 AST 符号级判定；关闭按文件级 mtime/hash |
| `updateReminder` | 行80 | `true` | 会话系统提示注入 wiki 维护提醒（仅当仓库根存在 `CodeWiki.md`） |
| `autoCommit` | 行81 | `true` | 编译完成后插件自己在主题分支提交产物（`git add .codewiki CodeWiki.md`） |
| `excludePaths` | 行82 | `''` | 排除清单：这些目录（含子目录）不编译；换行/分号/逗号分隔绝对路径 |
| `autoUpdate` | 行83 | `false` | 定时扫描已编译工作区、检测到变更自动增量编译 |
| `autoUpdateMin` | 行84 | `30` | 自动更新扫描间隔（分钟），最小 5 |
| `workspaceOnly` | 行85 | `true` | 任务页只显示属于已添加 dsh 工作区的任务 |

`liveConfig()`（行92-134）的关键归一化逻辑：
- `maxConcurrency` 经 `CONCURRENCY_HARD_CAP`（行31，=8）钳制，越界或非有限回落 `DEFAULT_CONCURRENCY`（行33，=2）（行107-109）。
- `bigConcurrency` 同样钳制到 8，0/未填回落 0（跟随默认档）（行111-113）。
- `parallelLimit`（行115-119）：`serialProjects` 为真时恒为 `1`；关闭后取 `parallelProjects` 钳到 4，缺省回落 2。
- `batchModel`/`bigModel`/`articleLanguage` 空串回落默认（行100、行103、行120）。
- `planMode` 非 `auto`/`dirs` 回落 `auto`（行121）；`agenticMaxSteps` 钳到 100、缺省 30（行123-126）；`autoUpdateMin` 最小 5（行130）；`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET`（行581，=110000）（行105）。

### .gitignore

位于仓库根目录，Git 忽略规则文件（源码行1-12）。无代码函数/类，以下为各规则行号与含义。

- **行1** `node_modules/`：忽略 npm/yarn/pnpm 安装依赖目录。
- **行2** `vendor/codewiki/target/`：忽略 vendor 目录下 CodeWiki 构建目标输出文件夹。
- **行3** `*.log`：忽略所有日志文件。
- **行4** 空行。
- **行5** 注释：说明 `bin/*.bak-*` 用途为 cw 二进制备份（丢失源码的最后产物，安全网）。
- **行6** `bin/*.bak-*`：忽略 `bin/` 目录下以 `.bak-` 开头的备份文件（当前仓库 `bin/` 下有 `cw.exe` 与 `cw.exe.bak-20261010`，后者被忽略、前者保留）。
- **行7** 空行。
- **行8** `.orch-test-out.txt`：忽略编排测试输出文件。
- **行9** `.probe3.txt`：忽略探针测试标记文件。
- **行10** 空行。
- **行11** 注释：说明 `.dsh-ops/` 用途为 DSH 运行期产物（面板会话流、工具调用记录），不入库。
- **行12** `.dsh-ops/`：忽略 DSH 运行期产物目录。

### .codewiki/_meta.yaml

位于 `.codewiki/` 目录，CodeWiki 编译产物的元信息文件（源码行1-5）。无代码函数/类，以下为各字段含义与行号。

- **行1** `project: dsh-codewiki`：项目标识，与 `package.json` 行2 的包名对应。
- **行2** `repo_path: E:\ik\Documents\trae_projects\1\dsh plugin\dsh-codewiki`：仓库绝对路径（Windows 反斜杠，含空格，与 `cordis.patch.yml` 行21 指向同一目录）。
- **行3** `last_compiled_commit: 2658208d92c132bf2391e12dff9b427f77053c0d`：最近一次成功编译时的 git commit 哈希。
- **行4** `last_compiled_at: 2026-10-27T05:09:53.711955800Z`：最近一次编译完成时间（UTC ISO 8601）。
- **行5** `created_at: 2026-10-10T04:14:56.349123500Z`：该 wiki 产物首次生成时间（UTC）。

## Architecture

```text
┌──────────────────┐    ┌──────────────────────┐
│ package.json     │    │ cordis.patch.yml     │
│ (行1-28)         │    │ (行1-33)             │
│ metadata, deps,  │    │ insert id:codewiki   │
│ dsh.bundle.patch │    │ name, config:{}      │
└────────┬─────────┘    └──────────┬───────────┘
         │ (行25)                  │ (行19-24)
         ▼                         ▼
┌─────────────────────────────────────────────┐
│ DSH Runtime                                 │
│ load patch from package.json (行25)         │
│ register plugin (行20-24) apply defaults    │
│ from index.js Config schema (行22-23 note,  │
│   全量字段行60-86 liveConfig 行92-134)       │
└─────────────────────────────────────────────┘

┌──────────────────┐    ┌──────────────────┐
│ .gitignore       │    │ Git VCS          │
│ (行1-12)         │───►│ exclude artifacts│
└──────────────────┘    └──────────────────┘
```

`.gitignore`（行1-12）独立于上述运行时加载流程，在 Git 版本控制阶段过滤产物。`index.js` 的 `Config`/`liveConfig`（行60-134）才是全部 25 个配置项与运行期归一化的唯一来源，`cordis.patch.yml` 仅作空壳覆盖层。

## Data Flow

1. **初始化阶段**：
   - DSH 启动时，首先读取根目录的 `package.json`（行1-28）。
   - 验证 `engines` 字段（行13-16），确保当前 Node.js 版本 `>=20`（行14）且 DSH 版本 `>=0.2.0-rc.0`（行15）。若不满足，抛出错误并终止。
   - 解析 `dependencies`（行17-19），安装或链接 `@deepseek-ai/schemastery`（行18）。

2. **插件加载阶段**：
   - DSH 检查 `package.json` 中的 `dsh.bundle.patch` 字段（行20-27，具体为行25），获取值 `"cordis.patch.yml"`。
   - 读取 `cordis.patch.yml` 文件内容（行1-33）。
   - 解析 YAML 结构，找到 `- insert:` 列表（行19）。
   - 提取元素（行20-24）：
     - `id`: `"codewiki"`（行20）。
     - `name`: 解析 `file:///E:/ik/.../index.js` 路径（行21）。
     - `config`: 初始化为 `{}`（行24）。
   - 将 `codewiki` 插件注册到 DSH 插件管理器中，并把插件的 `Config` schema（行60-86）作为该命名空间的配置契约。

3. **配置应用阶段**：
   - 当用户调用 CodeWiki 相关功能时，DSH 会从插件配置中读取 `codewiki` 命名空间下的设置。
   - 由于 `cordis.patch.yml` 中 `config: {}` 为空（行24），实际生效的配置来自插件 `index.js` 的 `Config` schema 默认值（行60-86）经 `liveConfig()`（行92-134）归一化后的结果，未填的项沿用 schema 默认，用户覆盖项通过 patch 注入。全量 25 个字段见上文「index.js — Config schema」表。其中与本阶段相关的默认行为：
     - 若未设置 `binaryPath`，`resolveBinary()`（行140-160）搜索 `$PATH` 中的 `cw`，失败则使用内置 `bin/cw(.exe)`（注释见 `cordis.patch.yml` 行6）。
     - 若未设置 `batchProvider`/`batchModel`，默认 `workbuddy`/`hy3`。
     - `maxConcurrency` 默认 2，范围 1–8 硬顶 8（`liveConfig` 行107-109、常量行31/33）。
     - `bigConcurrency` 默认 0=跟随默认档，范围 1–8 硬顶 8（`liveConfig` 行111-113）。
     - `serialProjects` 默认开启；关闭后 `parallelLimit` 取 `parallelProjects`（1–4，默认 2）（`liveConfig` 行115-119）。
     - `planMode` 默认 `auto`=AST 符号 + LLM 语义聚类（`liveConfig` 行121）。
     - `agenticArticles` 默认开启，`agenticMaxSteps` 默认 30、硬顶 100（行123-126）。
     - `symbolIncremental` 默认开启（行79）。
     - `updateReminder` 默认开启，但仅在仓库根存在 `CodeWiki.md` 时注入提醒（行80；详见 `README.md` 行62）。

4. **排除流程**：
   - Git 在提交前扫描工作区，匹配 `.gitignore` 规则（行1-12）。
   - 若发现 `node_modules/`（行1）、`vendor/codewiki/target/`（行2）、`*.log`（行3）、`bin/*.bak-*`（行6）、`.orch-test-out.txt`（行8）、`.probe3.txt`（行9）或 `.dsh-ops/`（行12）等文件/目录，直接跳过索引，不纳入版本控制。
