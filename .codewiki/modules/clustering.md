---
title: clustering
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/update-planner.js
  - lib/incremental.js
tags: [clustering, modules, llm, heuristic, planning]
---

## Overview

`lib/cluster.js` 负责把「仓库的全部叶子组件（函数/类/方法/常量）」聚合成「按职责划分的模块树」，供后续逐模块撰写架构文档。它对应上游 FSoft-AI4Code/CodeWiki 的 `src/be/cluster_modules.py` + `prompt_template.py` 三段式（`CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT`）。

上游与本文模块的差异（见 `lib/cluster.js:1-20` 头注释）：

- 上游用 Python dict 层层递归 + 落盘 `module_tree.json`；这里用「纯函数 + 显式层级」便于测试（注入 `completer` 即不碰网络）。
- 上游把「要不要下钻」交给 LLM 回复的嵌套结构；这里用显式阈值（`splitThreshold` 组件数、`maxDepth` 层数）决定，减少请求数——大仓库一次全量聚类几十次请求不可接受。
- 组件 id 形态为 `path#name`（本插件 `lib/symbols.js` 约定），提示词里明确说明。

公共契约（`lib/cluster.js:17-20`）：

```js
clusterComponents({ components, tree?, llmCall, ... }) ->
  { modules: [{ name, summary, files, components, children?, parent? }],
    tree, concepts: [], warnings, stats, byId }
// llmCall 形如 async (prompt) => string；不传则纯本地启发式（无网络可跑、可测）
```

三段式流程（见 `lib/cluster.js:5-9`）：

1. `clusterComponents` 把全部叶子组件交给 LLM，分成「顶层模块」；
2. 对每个超阈值模块递归下钻（`subClusterPrompt` 分支），产出子模块；
3. `super_group_modules`（即 `superGroupPrompt`）把层级过浅、平铺的顶层模块重新聚成「架构子系统」。

降级哲学：任何 LLM 环节失败 / 不传 `llmCall` / 返回垃圾文本，都会退回 `heuristicCluster`（按目录分组），保证「永不断链、组件不丢」。这与 `index.js` 的 `localPlan`（按顶层目录分组）策略一致。

## Key Components

所有导出符号均在 `lib/cluster.js`，测试覆盖见 `test-cluster.mjs`。

### 提示词辅助与提示词构造

- `formatComponents(components)` — `lib/cluster.js:28-46`。按文件分组渲染组件清单（比平铺一长串 id 更省 token、更利于模型看出归属）。每行 `id <TAB> 类型 <TAB> 名称(参数)`，只给名字+类型+一行签名（最多 6 个参数，`parameters.slice(0,6)`），不给函数体。
- `ARTIFACT_RE` / `artifactTag(file)` — `lib/cluster.js:48-51`。正则匹配构建/打包/配置/测试类文件（`package.json`、`tsconfig*.json`、`Cargo.toml`、`pyproject.toml`、`Dockerfile*`、`.*rc`、`*.y*ml`、`*.toml` 等）；命中后追加 ` (artifact: config)` 标记，提示词要求它们归入 build/config 模块或所配置的模块。
- `clusterPrompt(componentText, totalComponents)` — `lib/cluster.js:57-81`。顶层聚类提示词（对应 `CLUSTER_REPO_PROMPT`）。明确 id 形态 `<相对路径>#<符号名>` 必须原样返回，要求每个组件恰出现一次、规模均衡（5–40 组件）、模块名用小写下划线、输出裸 JSON 对象（不要 markdown 围栏）。
- `subClusterPrompt(moduleName, componentText, totalComponents)` — `lib/cluster.js:84-103`。下钻提示词（对应 `CLUSTER_MODULE_PROMPT`）。把一个大模块拆成更小子模块；若确实不可再分则返回一个保持原名的子模块。
- `superGroupPrompt(modules)` — `lib/cluster.js:106-129`。超级分组提示词（对应 `SUPER_GROUP_PROMPT`）。把平铺的顶层模块清单按架构角色归成子系统，要求子系统数显著少于模块数、模块名原样返回、输出 `{ subsystems: [{ name, modules }] }`。

### 解析与校验

- `parseJsonLoose(text)` — `lib/cluster.js:135-153`。尽力抢救模型回复：剥 markdown 围栏（` ```json ` 等）、直接 `JSON.parse`、取第一个 `{` 到最后一个 `}` 之间、再去掉尾部多余逗号重试。全失败返回 `null`。
- `parseClusterResponse(text, validIds, warnings = [])` — `lib/cluster.js:156-195`。从回复取出 `modules`（兼容 `groups`）。用 `validIds` 做 id 校验与去重：不存在的 id 记警告并丢弃；重复分配只保留首次出现、记警告。返回 `{ modules, missing }`，其中 `modules` 每项 `{ name: normalizeModuleName(name), path, summary, components: kept }`，`path` 由回复给出或 `guessPath(kept)` 兜底，`missing` 是 `validIds` 中未被任何模块收走的 id。
- `normalizeModuleName(name)` — `lib/cluster.js:198-206`。把模块名规整成文件名友好形式：空格转下划线、非 `\w`/中文/连字符字符转下划线、压缩重复下划线、去首尾下划线、转小写；空名兜底为 `'module'`。
- `guessPath(ids)` — `lib/cluster.js:208-212`。从首个组件 id 取 `#` 前的目录作为 `path`；`dirname` 为 `.` 时返回 `''`。

### 本地启发式与补齐

- `heuristicCluster(components)` — `lib/cluster.js:219-244`。无 LLM 时的降级路径，也用于 LLM 漏掉组件时兜底。按顶层目录 `groupBy(1)` 分组；若只有一个组（极常见的 `src/` 布局），下探一层 `groupBy(2)`，下探后多于一组才采用。每项 `{ name, path, summary, components }`。与 `index.js:1387-1400` 的 `localPlan` 同策略（按顶层目录分组，宁可粗也不中断流水线）。
- `fillMissing(modules, components, missingIds)` — `lib/cluster.js:247-268`。把 LLM 漏掉的组件按「目录是否落在某模块 `path` 下（`dir === m.path || dir.startsWith(m.path + '/')`）」挂回最相近模块；实在无归属则新建 `misc` 模块（`summary: '未归入其他模块的零散组件'`）。

### 文件归属与结果转换

- `moduleFiles(componentIds, byId)` — `lib/cluster.js:274-281`。由组件 id 集合反查其 `relativePath`，去重排序，产出模块文章的 `source_files`。
- `toPlanModules(result)` — `lib/cluster.js:460-467`。把 `clusterComponents` 结果转成索引 `job.plan.modules` 形状：`{ name, summary, files, ...(parent ? { parent } : {}) }`。`index.js:1468` 调用它将语义聚类结果接入编译流水线。

### 主入口与递归下钻

- `clusterComponents(opts)` — `lib/cluster.js:291-389`。主入口（详见 Architecture / Data Flow）。返回 `{ modules, tree, concepts: [], warnings, stats, byId }`，其中 `modules` 仅含叶子模块（父节点是导航容器，不单独成文）、`tree` 为带 `children` 的完整层级树、`stats` 含 `requests / llm / levels / fallbacks`。
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` — `lib/cluster.js:396-422`。对单个超大模块下钻一层（递归）。`depth` 为当前层号（顶层=1）；子模块仍 `>= splitThreshold` 且未到 `maxDepth` 时继续递归。下钻后 `kids.length <= 1`（单子模块且名字没变）视为「不可再分」，返回 `null` 让父模块保留。抛错时记警告并 `fallbacks += 1`。
- `parseSuperGroups(text, modules, warnings = [])` — `lib/cluster.js:425-456`。把超级分组回复转成带 `children` 的顶层列表。用 `byName` 反查模块、去重（`used` 集合）、丢弃不存在的模块名（记警告）；未被任何子系统收走的模块直接留在顶层（`rest`），绝不凭空消失。每项 `{ name, path: '', summary, components: [], children }`。

### 常量（模块级）

- `DEFAULT_MAX_DEPTH = 2` — `lib/cluster.js:287`。总层数上限：1=只顶层、2=允许一层子模块、3=允许孙模块。
- `DEFAULT_SPLIT_THRESHOLD = 60` — `lib/cluster.js:288`。单个模块组件数超过它才尝试下钻。
- `DEFAULT_TOP_FANOUT = 14` — `lib/cluster.js:289`。顶层模块数超过它且未禁用 `superGroup` 时才做超级分组。

## Architecture

`clusterComponents` 把「组件 → 模块树」的工作拆成三层，每层都可在失败时退回上一层的产物。组件用 `path#name` 形态（`lib/symbols.js` 约定），提示词与解析都围绕该形态。

```text
 components ──► formatComponents ──► clusterPrompt
 (from lib/symbols.js)              (lib/cluster.js:57)
                                          │  llmCall(prompt)
                                          ▼
                            parseClusterResponse ──fail/垃圾──► heuristicCluster
                                  (lib/cluster.js:156)              (lib/cluster.js:219)
                                          │  ok
                                          ▼
                          fillMissing(parsed.modules, missing)
                                  (lib/cluster.js:247)  ──► topModules (L1)
                                          │
                          [超大模块?] subClusterPrompt ─► subdivide (递归, lib/cluster.js:396)
                                          │  llmCall + 解析 + fillMissing
                                          ▼
                          topModules (带 children, L2..maxDepth)
                                          │
                          [顶层 > topFanout?] superGroupPrompt ─► parseSuperGroups
                                  (lib/cluster.js:106)         (lib/cluster.js:425)
                                          ▼
                          finalize() + collect() ──► { modules(叶子), tree, stats }
                                  (lib/cluster.js:359/380)
                                          │
                                          ▼
                          toPlanModules(result) ──► job.plan.modules  (index.js:1468)
```

关键设计点：

- **纯函数 + 显式层级**：上游靠 LLM 回复的嵌套结构决定下钻，本模块用 `splitThreshold`/`maxDepth` 显式决定（`lib/cluster.js:329-330`），减少请求数。早期实现 `subdivide` 不再递归、`maxDepth` 只当 `>1` 布尔开关（配 2 与配 3 行为一致），现已修正为真正可配多层（见 `lib/cluster.js:394-395` 注释与 `test-cluster.mjs:269-343`）。
- **父节点不单独成文**：`finalize`（`lib/cluster.js:359-375`）给父模块加 `aggregateFiles`（子模块 files 汇总），但 `collect`（`lib/cluster.js:380-386`）只把叶子节点收进 `modules`，父节点仅作导航容器。`parseSuperGroups` 产出的子系统节点 `components` 留空、不单独成文。
- **两种 plan 形状并存**：`localPlan`（`index.js:1387-1400`，纯目录分组）与 `semanticPlan`（`index.js:1409-1492`，调用本模块）都产出 `job.plan.modules`；`planMode` 配置项（`index.js:89`）选择 `auto`（语义聚类，失败降级）或 `dirs`（仅目录分组）。

## Data Flow

以 `index.js:1409` 的 `semanticPlan` 为主线（这是本模块最完整的调用方），数据流如下：

1. **组件来源**：`extractRepoGraph`（`lib/symbols.js`）从 tree-sitter AST 提取全仓库符号，得到 `graph: Map<id, node>`，`components = [...graph.values()]`（`index.js:1428-1439`）。每个组件形如 `{ id: 'src/auth/login.js#login0', name, kind, relativePath, parameters, dependsOn, ... }`。`resolveImportEdges` 解析导入边（失败不计较，`index.js:1445`）。
2. **构造 llmCall**：仅当 `llm && (provider || model)` 时构造 `async (prompt) => (await llmChat(...)).content`，否则 `llmCall = null`（`index.js:1447-1452`）。
3. **调用聚类**：`result = await clusterComponents({ components, llmCall, signal })`（`index.js:1456`）。`clusterComponents` 内部：
   - 空组件集直接返回 `{ modules: [], warnings: ['没有可聚类的组件'], stats }`（`lib/cluster.js:299-301`）。
   - 顶层：`llmCall ? call(clusterPrompt(formatComponents(components), len))` → `parseClusterResponse` → `fillMissing`；任何失败 `fallbacks += 1`，最终 `topModules = heuristicCluster(components)`（`lib/cluster.js:311-324`）。
   - 下钻：`llmCall && maxDepth > 1` 时遍历 `topModules`，`components.length >= splitThreshold` 的走 `subdivide`（`lib/cluster.js:331-344`）。
   - 超级分组：`llmCall && topModules.length > topFanout && opts.superGroup !== false` 时 `call(superGroupPrompt(topModules))` → `parseSuperGroups`（`lib/cluster.js:347-356`）。
   - `finalize`/`collect` 生成 `tree` 与 `modules`（`lib/cluster.js:359-388`）。
4. **降级标注**：`result.stats.llm` 为 `false` 时（`index.js:1465` 分支），说明聚类只是目录启发式，plan 标注「已降级为目录聚类」。
5. **转 plan**：`toPlanModules(result)`（`index.js:1468`）得到 `{ name, summary, files, parent? }` 列表，连同 `tree`、瘦身后的 `graph`（只留 `id/name/kind/relativePath/parameters/baseClasses/dependsOn/docstring`，不含 `sourceCode`，`index.js:1475-1484`）写进 `job.plan`。
6. **下游消费**：`job.plan.modules` 交给文章写作阶段（agentic / 单轮装填）；`tree` 随 plan 持久化供 stale 增量编译按组件粒度判定变更（`index.js:1470-1471`，配合 `lib/update-planner.js` 与 `lib/incremental.js`）。

测试桩演示同一条流：`test-cluster.mjs:153-216` 验证无 `llmCall` 走启发式且组件不丢；`test-cluster.mjs:219-267` 验证下钻后父节点不出现于 `modules`；`test-cluster.mjs:362-387` 验证顶层过多时生成 `core`/`ui` 子系统。

## Connections

- [[symbols]]：`clusterComponents` 的输入 `components` 由 `extractRepoGraph` 产出，组件 id 形态 `path#name`、`relativePath`、`parameters` 等字段约定来自本模块（`index.js:1477` 调用、`lib/cluster.js:41,42,208` 读取）。`resolveImportEdges` 解析的依赖边一并随 plan 持久化。
- [[incremental]]：`semanticPlan` 把 `tree` 与瘦身 `graph`（不含 `sourceCode`）写进 `job.plan`（`index.js:1470-1484`），供 stale 增量编译按组件粒度判定「哪些真变了」；`SLIM_FIELDS`（`lib/incremental.js:26`）与聚类 `graph` 字段是对应的。
- [[update-planner]]：`job.plan.modules` / `tree` 是 `buildModuleMap`、`realChangedIds`、`scanStaleArticle` 等增量规划函数的输入（`lib/update-planner.js:106-119` 头注释解释为何要从组件粒度重判）。
- [[index]]：唯一生产调用方。`semanticPlan`（`index.js:1409-1492`）调用 `clusterComponents` 与 `toPlanModules`；`localPlan`（`index.js:1387-1400`）是其目录分组的等价降级；`planMode` 配置（`index.js:89`）决定走哪条路。
- [[articles-agentic]] / 文章写作阶段：`toPlanModules` 产出的 `modules` 即逐篇模块文章的写作任务（每篇对应一个 `name + files + summary`），由 agentic 或单轮装填通道消费。
- [[engine-native-run]]：当 `nativeEngine` 开启（`index.js:99`）时 full 编译走 FSoft Python 原生流水线（含原生聚类），本 Node 聚类仅在 stale 增量时仍使用；两者互为可切换通道。

## Known Issues

- **`subdivide` 早期实现 maxDepth 不生效**：旧版只对 `topModules` 做一次 `for` 循环、`subdivide` 内部不再递归，`maxDepth` 仅被当成 `>1` 布尔开关，配 2 与配 3 行为完全相同（`lib/cluster.js:394-395` 注释）。现已改为真正的多层递归，由 `test-cluster.mjs:269-343`（`maxDepth=2` / `maxDepth=3` 两个用例）守护。
- **大仓库全量聚类的请求数**：上游 `CLUSTER_REPO_PROMPT` 一次递归几十次请求不可接受；本模块用显式阈值（`splitThreshold`/`maxDepth`）限制下钻（`lib/cluster.js:329-330`）。但若 `splitThreshold` 设得过小（如测试里的 `2`），仍会触发逐层下钻、请求数随层数指数上升（`test-cluster.mjs:286-343` 的桩模型演示）。
- **LLM 漏组件依赖 `fillMissing` 兜底**：模型可能丢组件或重复分配，`parseClusterResponse` 只保留首次出现、去重后由 `fillMissing` 按目录挂回（`lib/cluster.js:156-195, 247-268`）。若某组件目录不在任何模块 `path` 下，会被塞进新建的 `misc` 模块——这意味着语义聚类「职责」可能被目录近似破坏（见 `test-cluster.mjs:130-144`）。
- **`superGroup` 默认开启且阈值偏低**：`DEFAULT_TOP_FANOUT = 14`（`lib/cluster.js:289`），平铺模块数 >14 即触发超级分组；若模型超级分组回复垃圾，仅记警告并「保留平铺模块」（`lib/cluster.js:353-355`），不致命。
- **`concepts` 始终为空**：`clusterComponents` 返回 `concepts: []`（`lib/cluster.js:291, 300, 388`），跨模块概念由后续横切文章阶段（`batchConceptPrompt`，`index.js:1547`）负责，不在本模块产出。
- **无配置项直接传入聚类**：`clusterComponents` 的 `maxDepth`/`splitThreshold`/`topFanout`/`superGroup` 均由调用方 `opts` 决定，目前 `index.js` 的 `semanticPlan` 调用（`index.js:1409`）未显式传这些参数，全部走 `DEFAULT_*`（即 maxDepth=2、splitThreshold=60、topFanout=14）。如需调整需改 `index.js` 调用处或加配置项。
