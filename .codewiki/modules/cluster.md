---
title: cluster
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/symbols.js
tags: [clustering, llm, planning, modules, heuristics]
---

## Overview

`lib/cluster.js` 是 CodeWiki 编译流水线的「语义模块规划」组件库：把 `lib/symbols.js` 提取出的
全仓库组件（函数/类/方法/常量，id 形如 `<相对路径>#<符号名>`）按职责聚成模块树，供后续逐模块撰写架构文档。
它是上游 FSoft-AI4Code/CodeWiki `cluster_modules.py` + `prompt_template.py` 三段式（顶层聚类 /
下钻 / 超级分组的）纯函数重写，对应 `index.js` 里 `semanticPlan()` 的聚类阶段。

模块对外只暴露纯函数，无副作用、不碰文件系统，因此测试里注入假的 `llmCall` 即可不碰网络跑全套路径
（见 `test-cluster.mjs`）。设计上与上游的关键差异写在该文件头注释（`lib/cluster.js:1-20`）：

- 上游用 Python dict 层层递归 + 落盘 `module_tree.json`；这里用纯函数 + 显式层级，便于测试。
- 上游把「要不要下钻」交给 LLM 回复里的嵌套结构；这里用显式阈值（`splitThreshold` 组件数 /
  是否已有子目录）决定下钻，减少请求数——大仓库全量聚类几十次请求不可接受。
- 组件 id 用 `path#name`（本插件 `symbols.js` 约定），提示词里明确说明。

契约（入口 `clusterComponents`）：

```
clusterComponents({ components, llmCall?, signal?, maxDepth?, splitThreshold?, topFanout?, superGroup? })
  -> { modules, tree, concepts, warnings, stats, byId }
```

- `llmCall` 形如 `async (prompt) => string`；**不传则纯本地启发式**（`heuristicCluster`），
  无网络可跑、可测，但只是按目录分组，永不断链。
- 返回的 `modules` 只含**叶子模块**（父节点是导航容器，不单独成文）；
  `tree` 含完整层级（父 + 子）；`concepts` 当前恒为空数组；
  `warnings` 累积所有降级/解析异常；`stats` 记录 `requests/llm/levels/fallbacks`；
  `byId` 是 `id -> 组件` 的 Map 供调用方复用。

## Key Components

全部符号都从 `lib/cluster.js` 导出（除 `subdivide`、`guessPath`、`artifactTag`、`groupBy` 等为内部辅助）。

### 提示词组件表示与提示词模板

- `formatComponents(components)` — `lib/cluster.js:28-46`
  把组件按文件分组输出为纯文本：每行 `# <file>`（带 artifact 标记），文件下逐行
  `<TAB><id><TAB><kind><TAB><name>(签名)`。只给名字+类型+一行签名（参数取前 6 个，超了加 `…`），
  不给函数体——聚类看结构关系。`test-cluster.mjs:51-55` 验证 `package.json` 被标 `(artifact: config)`。
- `ARTIFACT_RE` / `artifactTag(file)` — `lib/cluster.js:48-51`
  正则匹配配置/打包/构建类文件（`package.json`、`tsconfig*`、`Cargo.toml`、`*.ya?ml`、`Dockerfile*` 等），
  命中则返回 ` (artifact: config)`，提示词据此要求模型把这类文件归入 build/config 模块。
- `clusterPrompt(componentText, totalComponents)` — `lib/cluster.js:57-81`
  顶层聚类提示词：说明组件 id 形态、要求「每个组件必须且只能出现在一个模块里」、输出严格 JSON
  （`{ "modules": [{ name, path, summary, components }] }`），不要 markdown 围栏、不要解释。
- `subClusterPrompt(moduleName, componentText, totalComponents)` — `lib/cluster.js:84-103`
  下钻提示词：给一个已聚好的大模块，要求拆成更小子模块；允许「确实不可再分时返回原模块不变」。
- `superGroupPrompt(modules)` — `lib/cluster.js:106-129`
  超级分组提示词：把平铺的顶层模块按架构角色归成更少数量的子系统，输出
  `{ "subsystems": [{ name, modules }] }`。

### 解析与校验

- `parseJsonLoose(text)` — `lib/cluster.js:135-153`
  「尽力抢救」式 JSON 解析：剥 markdown 围栏（` ```json ... ``` `）、直接 `JSON.parse`、
  取第一个 `{` 到最后一个 `}`、再修尾部多余逗号；都不是合法 JSON 返回 `null`。
- `parseClusterResponse(text, validIds, warnings = [])` — `lib/cluster.js:156-195`
  从模型回复取模块数组（兼容 `modules` / `groups` 字段名），并做 id 校验与去重：
  - 丢弃 `validIds` 外的 id，记 `聚类返回了不存在的组件 id` 警告；
  - 重复分配的 id 丢弃后出现的，记 `组件被重复分配` 警告；
  - 模块名经 `normalizeModuleName` 规范化，`path` 缺省用 `guessPath(kept)` 推断；
  - 返回 `{ modules, missing }`，`missing` 是 `validIds` 里未被覆盖的 id（供 `fillMissing` 补齐）。
- `normalizeModuleName(name)` — `lib/cluster.js:198-206`
  把模块名统一成文件名友好的形式：空白→`_`、非 `[\w\u4e00-\u9fff-]` 字符→`_`、折叠连续下划线、
  去首尾下划线、小写；空串兜底为 `module`。`test-cluster.mjs:113-118` 验证 `Wiki Compile`→`wiki_compile`、
  `a/b:c`→`a_b_c`、空→`module`、中文保留。
- `guessPath(ids)` — `lib/cluster.js:208-212`（内部）
  从第一个 id 的 `<path>#` 取目录作为模块 path；若已在仓库根返回 `''`。

### 本地启发式降级

- `heuristicCluster(components)` — `lib/cluster.js:219-244`
  无 LLM 时的降级路径，也用于补齐漏掉的组件。按顶层目录分组（`depth=1`）；
  若只有一个组（典型 `src/` 单顶层布局会把整个仓库塞进一个模块），下探一层 `depth=2` 多给几个模块。
  每组产出 `{ name, path, summary, components }`，`root` 表示仓库根文件。
  `test-cluster.mjs:121-128` 验证 `src/` 与 `root` 分组、且 `src` 组含除 2 个根文件外的全部组件。
- `fillMissing(modules, components, missingIds)` — `lib/cluster.js:247-268`
  把 LLM 漏掉的组件按目录补回最相近的模块（`dir === m.path` 或以 `m.path/` 开头）；
  实在没归属就新建 `misc` 模块（`name: 'misc'`，path 用 `guessPath`）。
- `moduleFiles(componentIds, byId)` — `lib/cluster.js:274-281`
  由组件 id 反查并去重出源文件清单（文章 frontmatter 的 `source_files` 用它）；
  按字典序返回。`test-cluster.mjs:146-150` 验证两个同目录 id 只出一个文件名。

### 主入口与下钻/超级分组实现

- `DEFAULT_MAX_DEPTH = 2` / `DEFAULT_SPLIT_THRESHOLD = 60` / `DEFAULT_TOP_FANOUT = 14`
  — `lib/cluster.js:287-289`：下钻层数上限、触发下钻的组件数阈值、触发超级分组的顶层模块数阈值。
- `clusterComponents(opts)` — `lib/cluster.js:291-389`（主入口，详见 Architecture / Data Flow）
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)`
  — `lib/cluster.js:396-422`（内部递归下钻：见下）
- `parseSuperGroups(text, modules, warnings = [])` — `lib/cluster.js:425-456`
  解析超级分组结果 → 带 `children` 的顶层列表：按 `subsystems`（`groups` 兼容）把模块收进子系统，
  父节点 `components: []`（不写文章）、`path: ''`；未在任一子系统出现的模块保留在顶层（`rest`）。
- `toPlanModules(result)` — `lib/cluster.js:460-467`
  把 `clusterComponents` 结果转成后续 articles 阶段吃的任务清单形状
  `{ name, summary, files, ...(parent ? {parent} : {}) }`，与 `index.js` 的 `job.plan.modules` 一致。

### 返回值结构（叶子模块节点）

经 `clusterComponents` 内部 `finalize`（`lib/cluster.js:359-375`）后，每个模块节点字段如下：

- `name`：规范化后的模块名（文件名友好）。
- `path`：模块主要目录（仓库相对 POSIX 路径）。
- `summary`：一句话职责（缺省为 `「<name> 模块」`）。
- `files`：`moduleFiles` 算出的源文件清单（去重、排序）。
- `components`：组件 id 数组（叶子模块独有内容）。
- `parent`：仅当下钻产生层级时带，指向父模块名。
- `children`：仅父节点带，子模块数组；父节点另加 `aggregateFiles`（子模块 files 的并集，供导航用）。
- `tree` / `modules` / `concepts` / `warnings` / `stats` / `byId`：见 Overview 说明。

## Architecture

`clusterComponents` 是纯函数编排，三段式（顶层聚类 → 递归下钻 → 超级分组）串在一条链上，
最后 `finalize` 递归补全文件清单与层级元信息。组件 ≥3 + 流程非平凡，框图如下：

```text
            components[] (from lib/symbols.js: extractRepoGraph)
                  │
                  ▼
        ┌──────────────────────┐
        │  clusterComponents   │  lib/cluster.js:291
        │  (main orchestrator) │
        └──────────┬───────────┘
                   │
        ┌──────────┴─────────────────────────────┐
        │ 1) TOP LEVEL  (if llmCall set)          │   lib/cluster.js:311-324
        │   clusterPrompt(formatComponents(c))     │
        │   -> parseClusterResponse -> fillMissing │
        │   else heuristicCluster (fallback)       │
        └──────────┬─────────────────────────────┘
                   │ topModules
        ┌──────────┴─────────────────────────────┐
        │ 2) SUBDIVIDE  (if llmCall && depth>1)    │   lib/cluster.js:331-344
        │   for each big module (>splitThreshold): │
        │     subClusterPrompt -> subdivide()      │   lib/cluster.js:396 (recursive)
        │   parent kept as dir node w/ children    │
        └──────────┬─────────────────────────────┘
                   │ topModules (possibly deeper)
        ┌──────────┴─────────────────────────────┐
        │ 3) SUPER GROUP  (if >topFanout)         │   lib/cluster.js:347-356
        │   superGroupPrompt -> parseSuperGroups   │   lib/cluster.js:425
        │   flat modules -> subsystems(children)   │
        └──────────┬─────────────────────────────┘
                   │ topModules
        ┌──────────┴─────────────────────────────┐
        │ finalize()  (recursive)                 │   lib/cluster.js:359-375
        │   moduleFiles(byId) -> files/children   │   lib/cluster.js:274
        │ collect leaves -> articles[]             │
        └──────────┬─────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   { modules, tree }      toPlanModules()  lib/cluster.js:460
        │                     │
        │                     ▼
        │              index.js: semanticPlan (index.js:1322; toPlanModules 调用见 index.js:1381)
        ▼
   articles stage (write modules/*.md)
```

关键提示词 / 解析 / 降级部件关系：

- `formatComponents`（`lib/cluster.js:28`）把组件压成 token 省的字串，喂给 `clusterPrompt` /
  `subClusterPrompt`；
- LLM 文本先经 `parseJsonLoose`（`lib/cluster.js:135`）抢救，再经 `parseClusterResponse`
  （`lib/cluster.js:219`）做 id 校验；失败时 `stats.fallbacks++` 并退回 `heuristicCluster`；
- 下钻由 `subdivide`（`lib/cluster.js:396`）递归完成，`depth` 从 2 起算，到 `maxDepth` 停止；
- 无 LLM 或全程失败时，最终 `topModules` 落回 `heuristicCluster`（`lib/cluster.js:324`），保证断链。

## Data Flow

以 `index.js: semanticPlan()`（`index.js:1322`）为上游调用方，端到端数据流如下：

1. **组件来源**：`semanticPlan` 先 `scanRepoFiles` + 读正文，再 `extractRepoGraph`
   （`lib/symbols.js`）得到 `graph`，`[...graph.values()]` 即组件数组（`index.js:1352`）。
   组件形状由 `lib/symbols.js:13-14` 约定：`{ id, name, kind, relativePath, sourceCode, docstring,
   parameters, baseClasses, dependsOn }`，id 形如 `path#name`（`lib/symbols.js:10`）。

2. **进入聚类**：`semanticPlan` 构造 `llmCall`（当 `llm && (provider || model)` 时，
   `index.js:1360-1365`），调 `clusterComponents({ components, llmCall, signal })`
   （`index.js:1369`）。`signal` 透传用于取消在飞请求（`lib/cluster.js:303` 的 `call` 包装）。

3. **顶层聚类**（`lib/cluster.js:309-325`）：有 `llmCall` 时拼 `clusterPrompt(formatComponents(components), N)`
   请求；解析失败/抛错 → `stats.fallbacks++` 并记 warning，最终 `topModules = heuristicCluster(components)`。

4. **递归下钻**（`lib/cluster.js:327-344`）：仅当 `llmCall && maxDepth > 1`。对 `components.length >=
   splitThreshold`（默认 60）的模块调 `subdivide`（`lib/cluster.js:396-422`）：内部用
   `subClusterPrompt` 请求拆子模块，`kids.length <= 1`（不可再分）则丢弃下钻保留原模块；
   否则父模块保留为 `{ ...m, children: kids }` 目录节点。`depth >= maxDepth` 即停止递归。
   历史上 `maxDepth` 只被当布尔开关（`>1`）用——配 2 与 3 行为一样；现实现真递归
   （`lib/cluster.js:407-415`），`test-cluster.mjs:313-343` 用 `deepLlm` 桩验证层数可配。

5. **超级分组**（`lib/cluster.js:346-356`）：仅当 `llmCall && topModules.length > topFanout`
   （默认 14）且 `opts.superGroup !== false`。调 `superGroupPrompt` → `parseSuperGroups`
   （`lib/cluster.js:425`），把模块收进 `subsystems`（带 `children`），未被收走的模块留在顶层。

6. **finalize**（`lib/cluster.js:359-386`）：递归给每个节点补 `files`（`moduleFiles`，`lib/cluster.js:274`）、
   `summary`、父节点补 `aggregateFiles`（子 files 并集）；`collect` 只收叶子节点进 `articles`。
   父节点 `components` 为 `[]`，不单独成文（导航容器）。

7. **回传 plan**：`semanticPlan` 用 `toPlanModules(result)`（`lib/cluster.js:460`）把结果转成
   `{ name, summary, files, parent? }` 清单，附 `tree` 与精简 `graph`（只留组件元数据、不带 sourceCode，
   因 `plan` 会写进 `JOBS_FILE`，`index.js:1385-1388`）。后续 articles 阶段据此生成 `modules/*.md`
   写任务（`index.js:2998-3008`，slug 用 `slugify(mod.name)`）。

**降级不变量**：无论 LLM 全程成功、部分失败还是完全不可用，组件集都「不丢失」——
`fillMissing` + `heuristicCluster` 兜底，所有测试（`test-cluster.mjs:153-216`）都断言最终
`Set(modules.flatMap(m => m.components)).size === components.length`。

## Connections

- [[symbols]] — 组件（`{id,name,kind,relativePath,parameters,...}`）的唯一来源：
  `extractRepoGraph`（`lib/symbols.js`，输出形状见 `lib/symbols.js:785-786`）产出的图 `values()`
  即本模块的 `components` 输入。组件 id 约定 `path#name` 在 `lib/symbols.js:10-11` 定义。
- [[index]] — 唯一生产调用方。`semanticPlan()`（`index.js:1322`）调 `clusterComponents`
  （`index.js:1381`）与 `toPlanModules`（`index.js:1300`）；`localPlan`（`index.js:1300`）是按目录
  分组的旧/备路径，`planMode: 'dirs'` 时直接用。模块划分变化驱动的「孤儿文章清理」见
  `pruneOrphanModules`（`index.js:271`）。
- [[incremental]] / [[update-planner]] — `semanticPlan` 持久化到 `job.plan` 的 `tree` + 精简 `graph`
  （`index.js:1383-1397`）被 stale 增量规划复用，按组件粒度（`bodyHash`/签名/依赖）判定哪些模块真变了。
- [[articles-agentic]] / 文章写作阶段（`index.js:2998-3045`）— 消费 `toPlanModules` 产出的 `modules`
  清单生成 `modules/*.md` 写任务，agentic 或单轮批量通道据此成稿。
- `test-cluster.mjs` — 本模块全部公开函数的单测：三段式 LLM 路径 + 全部降级路径 + 多层递归下钻
  + 超级分组 + `toPlanModules` 形状。

## Known Issues
