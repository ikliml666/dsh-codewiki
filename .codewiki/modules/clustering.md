---
title: clustering
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
tags: [clustering, module-planning, llm, heuristics, super-groups]
---

## Overview

`lib/cluster.js` 是 dsh-codewiki 的「组件聚类」模块：把 AST 符号提取阶段产出的扁平组件清单（`lib/symbols.js` 的 `extractRepoGraph` 输出，组件 id 形如 `<相对路径>#<符号名>`，见 `lib/symbols.js:785-789`）划分成有职责的**模块树**与**架构子系统**。它对应上游 FSoft-AI4Code/CodeWiki 的 `cluster_modules.py` + `prompt_template.py` 三段式（`CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT`），但用纯函数 + 显式层级替代上游的 Python dict 层层递归 + `module_tree.json` 落盘，便于注入 `llmCall` 做无网络单测（`lib/cluster.js:1-20`）。

设计差异与约束（见文件头注释 `lib/cluster.js:10-20`）：

- 用纯函数 + 显式层级而非递归落盘，便于测试（注入 `completer` 不碰网络）。
- 用显式阈值（组件数 / 是否已有子目录）决定要不要下钻，减少 LLM 请求数——大仓库全量聚类几十次请求不可接受。
- 组件 id 用 `path#name`（`lib/symbols.js` 约定），提示词里明确说明。

聚类主流程（`clusterComponents`，`lib/cluster.js:291-389`）分三层：

1. **第一层（顶层聚类）**：把所有叶子组件交给 LLM 聚成「叶子模块」；没有 `llmCall` 或 LLM 失败时整体降级为目录启发式 `heuristicCluster`（`lib/cluster.js:309-324`）。
2. **第二层（递归下钻）**：对组件数超过阈值 `splitThreshold` 的大模块逐层调用 `subdivide` 拆成更小子模块，直到达到 `maxDepth` 层级上限（`lib/cluster.js:327-344`、`lib/cluster.js:396-422`）。
3. **第三层（超级分组）**：顶层模块数超过 `topFanout` 时，用 `superGroupPrompt` 把平铺模块归成更高层的「架构子系统」（`lib/cluster.js:346-356`、`lib/cluster.js:347-370`）。

无论哪一层，所有 LLM 输出都经统一的「宽松 JSON 解析 + id 校验去重 + 补缺失」管线，保证**组件永不丢失**：LLM 漏掉的组件由 `fillMissing` 按目录补回最近模块，实在无归属则新建 `misc` 模块（`lib/cluster.js:246-268`、`lib/cluster.js:247-287`）。

最终 `clusterComponents` 返回 `{ modules, tree, concepts, warnings, stats, byId }`：`modules` 是只含叶子模块（真正写文章的对象）的扁平清单，`tree` 是带父/子导航容器的完整树，`stats` 记录 `requests / llm / levels / fallbacks`（`lib/cluster.js:358-389`）。

## Key Components

### 常量（模块级）

- `DEFAULT_MAX_DEPTH = 2`（第 287 行）：层级总层数上限默认值。`maxDepth=1` 只做顶层聚类；`2` 允许一层子模块；`3` 允许孙模块（注释见 `lib/cluster.js:327-328`）。
- `DEFAULT_SPLIT_THRESHOLD = 60`（第 288 行）：单模块组件数超过它就尝试下钻。
- `DEFAULT_TOP_FANOUT = 14`（第 289 行）：顶层模块数超过它就做超级分组。

### 提示词表示：`formatComponents`（第 28-46 行）

按**文件分组**渲染组件清单（比一长串平铺 id 省 token、利于模型看出归属）。每个文件一行 `# <file>`，其下按 `\t<id>\t<kind>\t<name>(参数)` 列出组件；只给「名字 + 类型 + 一行签名」（参数最多 6 个，多余用 `…`），不给函数体，因为聚类看结构关系不需要函数体（第 40-43 行）。`artifactTag` 给 `package.json` / `tsconfig*.json` / `Cargo.toml` / `pyproject.toml` / `*.ya?ml` 等构建/配置/测试文件追加 ` (artifact: config)` 标记（第 48-51 行，`ARTIFACT_RE`）。

### 三段式提示词（prompts）

- `clusterPrompt(componentText, totalComponents)`（第 57-81 行）：顶层聚类提示词。要求模型把组件分成模块，明确「每个组件必须且只能出现在一个模块里」「(artifact: config) 文件归入 build/config 或附到所配置模块」「模块名简短英文小写下划线」「path 填主要目录」。输出一个 `{ "modules": [{ "name", "path", "summary", "components" }] }`，且**不解释、不围栏**。组件总数 `${totalComponents}` 写入提示词强制模型不遗漏。
- `subClusterPrompt(moduleName, componentText, totalComponents)`（第 84-103 行）：下钻提示词。给一个已聚好的大模块，要求拆成更小的子模块；若确实同属一个不可再分的职责则返回一个保持原名的子模块（第 94 行）。
- `superGroupPrompt(modules)`（第 106-129 行）：超级分组提示词。把平铺顶层模块按架构角色归成子系统，要求「子系统数量必须显著少于模块数量」「模块名原样返回」；输出 `{ "subsystems": [{ "name", "modules" }] }`。

### JSON 解析与校验

- `parseJsonLoose(text)`（第 135-153 行）：尽力抢救模型输出——剥 ```` ```json ```` 围栏、直接 `JSON.parse`、取第一个 `{` 到最后一个 `}` 之间、再尝试去掉尾部多余逗号（`/,\s*([}\]])/g`）后解析，全失败返回 `null`。
- `parseClusterResponse(text, validIds, warnings = [])`（第 156-195 行）：从回复里取模块数组（兼容 `obj.modules` / `obj.groups`），对每条 `modules` 做 id 校验与去重：
  - 不存在的 id 记 `warnings`（第 176 行）；
  - 重复分配的 id 记 `warnings` 并只保留首次（第 177 行）；
  - 模块名经 `normalizeModuleName` 规范化（第 183 行）；
  - `path` 反斜杠归一化为 `/`、去掉 `./` 前缀，空则 `guessPath(kept)`（第 184 行）；
  - 返回 `{ modules, missing }`，`missing` 是 `validIds` 中没被任何模块收入的 id（供 `fillMissing` 补齐，第 193 行）。
- `normalizeModuleName(name)`（第 198-206 行）：模块名统一成文件名友好形式（空格→`_`，非 `[\w\u4e00-\u9fff-]` 都替换成 `_`，连写下划线压成单下划线，去首尾下划线，转小写；全空回落 `'module'`）。会进 `<name>.md`，不能带路径分隔符与空格。
- `guessPath(ids)`（第 208-212 行）：从首个 id 的 `path#name` 取目录名作 path（单文件在根目录则 `''`）。

### 本地启发式聚类（降级路径）

- `heuristicCluster(components)`（第 219-244 行）：无 LLM 时的降级 + 补齐路径。按顶层目录分组（`groupBy(1)`，取路径第一段）；若只有一个组（常见于 `src/` 单顶层目录布局，会把整个仓库塞进一个模块），则下探一层 `groupBy(2)` 取前两段，下探后多于一个组才用（第 231-237 行）。返回 `{ name, path, summary, components }`，与插件 0.10.7 起 `localPlan` 同策略——不是最优但永不断链。
- `fillMissing(modules, components, missingIds)`（第 247-268 行）：把 LLM 漏掉的 `missingIds` 按目录补回最相近模块（`dir === m.path` 或 `dir.startsWith(m.path + '/')`，第 255 行）；实在无归属则 push 一个 `name: 'misc'` 模块（第 259-266 行）。返回新 `modules`（原数组被原地修改）。
- `moduleFiles(componentIds, byId)`（第 274-281 行）：模块 → 源文件清单（文章 frontmatter 的 `source_files` 用它）。从 `byId` 取每个组件的相对路径，去重排序返回。

### 主入口：`clusterComponents(opts)`（第 291-389 行）

输入 `opts`：

- `components`：`{ id, name, kind, relativePath, parameters, ... }` 扁平组件数组（来自 `lib/symbols.js`，契约见 `lib/symbols.js:13-14`）；
- `llmCall`：`async (prompt) => string`（可选，不传则纯本地启发式）；
- `signal`：AbortSignal（透传给 `call`，但目前 `call` 仅解包字符串/对象，未实际中断，见 `lib/cluster.js:303-307`）；
- `maxDepth`（默认 `DEFAULT_MAX_DEPTH=2`）、`splitThreshold`（默认 60）、`topFanout`（默认 14）、`superGroup`（默认非 `false`）。

内部 `call`（第 303-307 行）把 `llmCall` 包装成统计 `stats.requests += 1` 并解包（`typeof out === 'string' ? out : String(out?.content ?? '')`）。逻辑：

1. 空组件集直接返回 `{ modules: [], concepts: [], warnings: ['没有可聚类的组件'], stats }`（第 299-301 行）。
2. 顶层聚类：有 `llmCall` 则 `clusterPrompt` → `parseClusterResponse` → `fillMissing`；失败/无 `llmCall` 则 `stats.fallbacks += 1` 并降级 `heuristicCluster`（第 311-324 行）。
3. 下钻：`llmCall && maxDepth > 1` 时遍历 `topModules`，组件数 ≥ `splitThreshold` 的调 `subdivide`；子模块 `> 1` 个则父模块保留为导航节点 `children`，否则保留原模块（第 331-344 行）。
4. 超级分组：`llmCall && topModules.length > topFanout && superGroup !== false` 时调 `superGroupPrompt` → `parseSuperGroups`（第 347-356 行）。
5. `finalize`（第 359-375 行）补齐 `files`（`moduleFiles`）与层级元信息；有 `children` 时父节点汇总 `aggregateFiles`（所有子模块 `files` 去重，避免重复写，第 372 行）。`parent` 字段只在有父时带上。
6. `collect`（第 380-386 行）只收集叶子模块进 `articles`（父节点是导航容器，不单独成文）。
7. 返回 `{ modules: articles, tree, concepts: [], warnings, stats, byId }`（第 388 行）。`byId` 是 `id → component` 的 Map，供上游 `semanticPlan` 组装 `graph` 用（见 `index.js:1388-1397`）。

### 下钻：`subdivide`（第 396-422 行，内部）

对单个大模块下钻一层。`depth` 当前层号（顶层=1），`maxDepth` 层数上限。流程：

- 取该模块子集 → `subClusterPrompt` → `parseClusterResponse` → `fillMissing`；
- 下钻后只有 ≤1 个子模块则视为「不可再分」，返回 `null`（保留原模块，第 404 行）；
- 记录 `stats.levels = Math.max(stats.levels, depth)`（第 405 行）；
- `depth >= maxDepth` 则不再递归直接返回 `kids`（第 408 行）；
- 否则对每个 `kid`：若组件数 < `splitThreshold` 直接收下，否则递归 `subdivide(kid, ..., depth + 1)`，子模块 `> 1` 则挂 `children`（第 409-416 行）。每个子模块组件数严格小于父模块（`kids.length > 1` 已保证），不会无限递归（第 407 行注释）。

### 超级分组解析：`parseSuperGroups(text, modules, warnings = [])`（第 425-456 行）

把超级分组结果转成带子模块的顶层列表。解析 `obj.subsystems` / `obj.groups`；按 `name` 在 `byName`（第 430 行）里取已有模块，引用不存在的模块名记 `warnings` 并跳过（第 438 行），已用过的模块跳过（第 439 行）。每个子系统输出 `{ name, path: '', summary: '架构子系统', components: [], children: picked }`——父节点自身不写文章、组件留空（第 444-451 行）。没被任何子系统收走的模块直接留在顶层（`rest`，第 453-455 行），不能凭空消失。

### 结果转 plan：`toPlanModules(result)`（第 460-467 行）

把 `clusterComponents` 结果转成插件 articles 阶段吃的任务清单形状（与 `index.js` 的 `job.plan.modules` 一致）：`{ name, summary, files, ...(parent ? { parent } : {}) }`。上游 `semanticPlan` 用它（`index.js:1322`）。

### 返回值 shape（供上游消费）

`clusterComponents` 产出两类节点：

- 叶子模块节点（写文章）：`{ name, path, summary, files: string[], components: string[], parent?: string }`；
- 父/子系统导航节点：`{ name, path, summary, components: [], children: [...], aggregateFiles?: string[] }`（`aggregateFiles` 仅父节点汇总子模块文件，见 `lib/cluster.js:372`）。

`tree` 是带 `children` 的完整树；`modules` 是 `tree` 里所有叶子节点的扁平清单。

## Architecture

`clusterComponents` 的三段式 + 降级路径，用 UTF-8 框图表示组件与关系（`lib/cluster.js`）：

```text
        components: {id,name,kind,relativePath,...}
                         │  (来自 lib/symbols.js: extractRepoGraph)
                         ▼
                  ┌──────────────────────┐
   llmCall? no ──►│ heuristicCluster()   │  (lib/cluster.js:219)
                  │  按顶层/次顶层目录分组 │
                  └──────────────────────┘
                         │
   llmCall? yes ─► clusterPrompt ► llmCall ► parseClusterResponse ──┐
                         │                                          │
                         │            (任一失败/空)                  │
                         └──── stats.fallbacks++ ► 降级 heuristic ──┘
                         ▼
                  fillMissing() 补漏掉的组件 (lib/cluster.js:247)
                         ▼
              topModules (第一层, stats.levels=1)
                         │
        ┌────────────────┴─────────────────┐
   maxDepth>1?           │ components>=splitThreshold?
        │ yes            ▼                         no
        ▼        ┌──────────────────────┐              │
   subdivide()   │ subClusterPrompt ►    │  父模块保留   │
   (递归下钻,     │ llmCall ►            │  {children}   │
    lib:396)     │ parseClusterResponse  │              │
        │        └──────────────────────┘              │
        ▼                                                  │
   topModules (带 children 的导航节点) ◄──────────────────┘
                         │
        topFanout 超过? ── yes ─► superGroupPrompt ► parseSuperGroups
                                         │           (父节点 components:[])
                                         ▼
                  finalize() 补 files / aggregateFiles (lib:359)
                         ▼
                  collect() 只收叶子 → modules[] (文章清单)
                         ▼
        { modules, tree, concepts, warnings, stats, byId }
                         ▼
                  toPlanModules() → job.plan.modules (index.js:1381)
```

## Data Flow

以「有 LLM、含一个超大模块、顶层数超过上限」的典型全量编译为例，追踪数据流转：

1. **输入**：`semanticPlan`（`index.js:1315-1405`）先调用 `extractRepoGraph`（`lib/symbols.js`）提取全仓库组件，得到 `components = [...graph.values()]`（`index.js:1352`），再包一个 `llmCall`（把 `llmChat` 的输出解包成字符串，`index.js:1360-1365`），调 `clusterComponents({ components, llmCall, signal })`（`index.js:1369`）。
2. **第一层**：`formatComponents(components)`（第 28 行）渲染清单 → `clusterPrompt(...)`（第 313 行）→ `llmCall` → `parseClusterResponse` 校验去重 → `fillMissing`（第 315 行）。若 `llmCall` 抛错，第 318 行把错误写入 `warnings` 并 `stats.fallbacks += 1`，随后第 324 行走 `heuristicCluster`。
3. **第二层下钻**：`big` 模块组件数（如 70）≥ `splitThreshold`（默认 60），进入 `subdivide`（`lib/cluster.js:335`）。`subdivide` 用 `subClusterPrompt` 让 LLM 把 `big` 拆成 `big_core` / `big_ext`，父节点保留为 `{ ...m, children: kids }`（第 338 行），`stats.levels` 升到 2。若 `maxDepth=3` 且子模块仍超大，第 412 行继续递归到孙模块（见 `test-cluster.mjs:329-343` 的 `maxDepth=3` 用例）。
4. **第三层超级分组**：顶层模块数 > `topFanout`（默认 14）时，`superGroupPrompt`（第 350 行）→ `parseSuperGroups` 生成 `{ name, path:'', components:[], children: [...] }` 导航节点，未归类模块留在顶层（第 453-455 行）。
5. **终态化**：`finalize`（第 359 行）给每个节点补 `files`（`moduleFiles`，第 274 行），父节点补 `aggregateFiles`（第 372 行）；`collect`（第 380 行）只收**叶子**节点进 `modules`（写文章的对象），父/子系统只作导航。
6. **返回与转换**：`clusterComponents` 返回 `{ modules, tree, concepts, warnings, stats, byId }`（第 388 行）。`semanticPlan` 用 `toPlanModules(result)`（第 1381 行）把叶子模块转成 `{ name, summary, files }` 写进 `job.plan.modules`，并把 `tree` 与精简 `graph`（每组件只留 id/name/kind/relativePath/parameters/baseClasses/dependsOn/docstring，不含 `sourceCode`，第 1388-1397 行）随 `plan` 持久化——后续 stale 增量按组件粒度判变更。

**不变式**：每个 `components` 里的 id 必须出现在某个叶子模块里。`fillMissing`（第 247 行）与 `heuristicCluster`（第 219 行）确保无 `llmCall` 或 LLM 漏给时也不丢组件；`test-cluster.mjs:153-159` 与 `:188-199` 断言组件集合大小恒定。

## Connections

- [[symbols]] —— 聚类上游：提供 `extractRepoGraph` 产出的扁平组件（`{ id, name, kind, relativePath, parameters, ... }`），组件 id 约定 `path#name` 即在此定义（`lib/symbols.js:785-789`）。
- [[incremental]] —— 聚类结果 `tree` 与精简 `graph` 随 `job.plan` 持久化，供 stale 增量按组件粒度判「哪些真变了」（`index.js:1383-1397`，`lib/incremental.js` 的 `slimGraph` / `realChangedIds` 等）。
- [[update-planner]] —— 模块规划结果经由 `planMode`（`auto`=本模块语义聚类 / `dirs`=目录分组）进入 `buildPlan`（`index.js:2730-2753`），再喂给更新规划器组装增量任务。
- [[articles-agentic]] / 批量写作通道 —— `toPlanModules` 转出的 `{ name, summary, files }` 即 `job.plan.modules`，是 articles 阶段为每篇模块文章装配任务（含 `source_files`、mission）的输入。
- [[graph-diff]] —— 组件节点 shape 与 `lib/graph-diff.js` 的 Node 记录契约一致（`lib/symbols.js:13-14`）；`components` 里的 `dependsOn` 由 `lib/symbols.js` 的 `resolveImportEdges` 填充（见 `index.js:1358`）。

## Known Issues

- **`signal` 未实际中断聚类请求**：`clusterComponents` 接受 `opts.signal`，但 `call` 包装只做字符串解包（`lib/cluster.js:303-307`），并未把 `signal` 透传给 `llmCall`。异常（如超时）只能由 `llmCall` 自身抛出后在外层 `try/catch` 里降级，无法中途取消（见 `lib/cluster.js:311-320`、`lib/cluster.js:291-299` 的 `try/catch` 只捕获不重抛）。`signal` 在 `index.js:1369` 透传进来但目前是空门。
- **`superGroup` 选项的语义边界**：`superGroup` 仅在 `=== false` 时关闭超级分组（第 348 行 `opts.superGroup !== false`）。其它 falsy 值（`undefined` 默认、`null`、`0`）都视为「开启」，与直觉上「显式关」不同——调用方须用 `superGroup: false` 而非省略。
- **`heuristicCluster` 单顶层目录场景仍可能过大**：仅当 `groupBy(1)` 得到一个组时才下探 `groupBy(2)`（第 234-237 行）。若仓库是 `src/` 单一顶层且 `src/` 下各子目录仍超大（如 `src/` 下只有一个巨型目录），下探一层后仍是单组则退回原分组——这种布局下目录启发式不会进一步细分，需靠 LLM 路径在顶层聚类阶段就切好「职责」。
- **`subdivide` 递归深度受 `maxDepth` 但每层都发请求**：`maxDepth` 控制总层数，但每下钻一层都消耗一次 `llmCall`（`stats.requests += 1`，第 304 行）。超大仓库多层下钻的 LLM 请求数随模块数线性增长，注释明确「大仓库上一次全量聚类几十次请求不可接受」（`lib/cluster.js:293`），故 `splitThreshold` 与 `maxDepth` 都偏大以抑请求数。
- **配置 / artifact 文件仍可能零散**：`fillMissing` 把漏掉的 `(artifact: config)` 文件（如 `README.md`、`package.json`）按目录补回；若这些根级文件无同目录模块，会落入 `misc` 模块（`lib/cluster.js:259-266`），导致 build/config 被混进 `misc` 而非专门的 build/config 模块——`clusterPrompt` 虽提示「归入专门 build/config 模块」（第 70 行），但纯本地启发式无此概念。
- **`stats.levels` 只反映真实下钻层数**：空组件 / 纯启发式路径下 `levels` 恒为 1（第 325 行），即使 `maxDepth` 配到 3。`test-cluster.mjs:313-327` 用 `splitThreshold: 2` 强制下钻来验证 `maxDepth` 真正生效（`lib/cluster.js:329-332` 注释记录旧实现的布尔开关 bug）。
- **`parseClusterResponse` 之后模块顺序取决于模型**：返回 `modules` 按模型回复顺序排列，无稳定排序；`fillMissing` 仅在尾部补 `misc`，不重排。若需确定性顺序，由上游 `semanticPlan` / `toPlanModules` 自行排序（`index.js:1381`）。
