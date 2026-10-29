---
title: clustering
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/symbols.js
  - lib/engine/python/entry.py
tags: [clustering, module-planning, semantic-cluster, planning]
---

## Overview

`clustering` 模块（实现文件 `lib/cluster.js`）负责把全仓库的「叶子组件」聚成「模块」并规划模块树结构。它对应上游 FSoft-AI4Code/CodeWiki 的 `cluster_modules.py` + `prompt_template.py` 三段式（`CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT`）。

与上游的两点关键差异（见 `lib/cluster.js` 第 1–20 行头部注释）：

- 上游用 Python dict 层层递归 + 落盘 `module_tree.json`；这里用纯函数 + 显式层级，便于注入 `llmCall` 做单测（不碰网络）。
- 上游把「要不要下钻」交给 LLM 回复的嵌套结构；这里用显式阈值（组件数 / 是否已有子目录）决定下钻，减少请求数。

入口 `clusterComponents`（`lib/cluster.js` 第 291 行）接受 `{ components, llmCall?, maxDepth?, splitThreshold?, topFanout?, superGroup? }`，返回 `{ modules, tree, concepts, warnings, stats, byId }`。组件来源是 `lib/symbols.js` 的 AST 提取结果，每条形如 `{ id: '<相对路径>#<符号名>', name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }`（见 `lib/symbols.js` 第 13–14 行）。

聚类流程分三段（对应三个提示词），失败时逐级降级：

1. **顶层聚类** —— `clusterPrompt`（`lib/cluster.js` 第 57 行）让 LLM 把全部组件分进若干模块。
2. **递归下钻** —— `subClusterPrompt`（`lib/cluster.js` 第 84 行）对超 `splitThreshold` 的大模块拆子模块，最多 `maxDepth` 层。
3. **超级分组** —— `superGroupPrompt`（`lib/cluster.js` 第 106 行）把顶层过多（> `topFanout`）的平铺模块归成架构子系统。

当 `llmCall` 缺失、抛错或返回非法 JSON 时，自动退化到 `heuristicCluster`（`lib/cluster.js` 第 219 行）的目录分组，保证组件永不丢失（`test-cluster.mjs` 第 153 行「无 llmCall 时走目录启发式，组件不丢」）。

该模块被 `index.js` 的 `semanticPlan`（`index.js` 第 1410 行）调用，并经由 `toPlanModules`（`lib/cluster.js` 第 460 行）转成 `job.plan.modules` 形状。原生 Python 引擎（`lib/engine/python/entry.py`）内部另有 FSoft 自己的聚类实现，本模块只服务 Node 内置流水线。

## Key Components

### 导出函数 / 常量

- `formatComponents(components)` —— `lib/cluster.js` 第 28–46 行。把组件按 `relativePath` 分组，每组输出 `# 文件` 标题行与 `\t组件ID\t类型\t名称(参数)` 行；配置文件会被 `artifactTag`（`lib/cluster.js` 第 49 行，`ARTIFACT_RE` 第 48 行）打上 `(artifact: config)` 标记。只给名字/类型/一行签名，不给函数体。
- `clusterPrompt(componentText, totalComponents)` —— `lib/cluster.js` 第 57–81 行。顶层聚类提示词，要求 LLM 输出 `{ modules: [{ name, path, summary, components: [...] }] }`，并强调「组件必须且只能出现一次」「标 artifact 的文件归 build/config」「模块名用小写下划线」。
- `subClusterPrompt(moduleName, componentText, totalComponents)` —— `lib/cluster.js` 第 84–103 行。下钻提示词，把单个大模块拆子模块；若不可再分则返回一个同名子模块。
- `superGroupPrompt(modules)` —— `lib/cluster.js` 第 106–129 行。超级分组提示词，把模块清单归成 `subsystems: [{ name, modules: [...] }]`。
- `parseJsonLoose(text)` —— `lib/cluster.js` 第 135–153 行。尽力抢救 LLM 输出：剥 ```json 围栏、直接 `JSON.parse`、取第一个 `{` 到最后一个 `}`、再修尾逗号。全失败返回 `null`。
- `parseClusterResponse(text, validIds, warnings = [])` —— `lib/cluster.js` 第 156–195 行。解析聚类响应，做 id 校验（未知 id 记 warning、重复分配丢后者）、`normalizeModuleName`、`guessPath`，并把漏掉的组件计入 `missing` 返回 `{ modules, missing }`。
- `normalizeModuleName(name)` —— `lib/cluster.js` 第 198–206 行。模块名规整为文件名友好形式（空格→`_`，非 `[\\w一-鿿-]` 清成 `_`，小写，空则回落 `'module'`）。
- `heuristicCluster(components)` —— `lib/cluster.js` 第 219–244 行。本地启发式：按顶层目录（`depth=1`）分组；若只有一个分组且存在 `depth=2` 能拆出多组则下探一层。返回 `{ name, path, summary, components }` 数组。
- `fillMissing(modules, components, missingIds)` —— `lib/cluster.js` 第 247–268 行。把漏掉的组件按目录补回最相近的模块，无处归属时建 `misc` 模块（第 261 行）。
- `moduleFiles(componentIds, byId)` —— `lib/cluster.js` 第 274–281 行。汇总模块组件的源文件集合（排序去重），供文章 `source_files` 使用。
- `clusterComponents(opts)` —— `lib/cluster.js` 第 291–389 行。主入口（详见 Architecture）。
- `parseSuperGroups(text, modules, warnings = [])` —— `lib/cluster.js` 第 425–456 行。解析超级分组响应，把引用到的模块收进子系统（父节点 `components: []`、`children` 挂原模块），未被收走的模块直接留在顶层（第 454 行）。
- `toPlanModules(result)` —— `lib/cluster.js` 第 460–467 行。把 `clusterComponents` 结果转成 `{ name, summary, files, parent? }` 任务清单形状，供 `index.js` 的 `buildPlan` 直接用。
- 模块级常量（默认值）：
  - `DEFAULT_MAX_DEPTH = 2` —— `lib/cluster.js` 第 287 行。
  - `DEFAULT_SPLIT_THRESHOLD = 60` —— `lib/cluster.js` 第 288 行。组件数超过就尝试下钻。
  - `DEFAULT_TOP_FANOUT = 14` —— `lib/cluster.js` 第 289 行。顶层模块超过就做超级分组。

### 内部函数（非导出，测试经由导出 API 间接覆盖）

- `artifactTag(file)` —— `lib/cluster.js` 第 49–51 行。判断文件是否 config 类。
- `guessPath(ids)` —— `lib/cluster.js` 第 208–212 行。从首个组件 id 取目录作为模块 `path`。
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` —— `lib/cluster.js` 第 396–422 行。对单个大模块递归下钻一层，返回 `kids`（含 `children`）；下钻后只剩一个子模块或名字未变则视为「不可再分」，返回 `null`。
- `finalize` / `collect` —— `lib/cluster.js` 第 359–386 行。闭包内函数：`finalize` 给每个节点补 `files`、父节点补 `aggregateFiles`；`collect` 只收集叶子节点入 `articles`（父节点只在 `tree` 里当导航容器，不单独成文）。

## Architecture

```text
components (lib/symbols.js 提取, id=path#name)
        │
        ▼
clusterComponents (lib/cluster.js:291)
   ├─ llmCall? ──yes──► call(clusterPrompt) ──► parseClusterResponse ──► fillMissing
   │   (顶层聚类)                                  │ 解析失败/抛错
   │                                              ▼
   │                                         stats.fallbacks++  ►  heuristicCluster (目录分组)
   ├─ 无 llmCall ──────────────────────────────────────────────────►  heuristicCluster
   │
   ├─ 大模块(≥splitThreshold & maxDepth>1) ──► subdivide (lib/cluster.js:396) 递归下钻
   │       父模块保留 children，叶子模块才有文章
   │
   ├─ 顶层>topFanout ──► call(superGroupPrompt) ──► parseSuperGroups (子系统节点)
   │
   └─ finalize (lib/cluster.js:359) 补 files/aggregateFiles
              │
              ▼
   { modules(叶子), tree(含父/子系统), concepts:[], warnings, stats, byId }
              │
              ▼
   toPlanModules (lib/cluster.js:460) ──► job.plan.modules ──► index.js buildPlan (index.js:3008)
```

关键设计点：

- **父 / 子系统节点不单独成文**：`finalize`（`lib/cluster.js` 第 359–375 行）在父模块上挂 `children` 与 `aggregateFiles`（子模块 `files` 去重汇总），但 `collect`（`lib/cluster.js` 第 380–386 行）只把「无 children 的叶子」推进 `articles`；因此 `r.modules` 只含叶子模块，`r.tree` 才是完整层级结构（`test-cluster.mjs` 第 245 行断言父节点 `big` 不入 `r.modules`）。
- **maxDepth 真实生效**：旧实现把 `maxDepth` 只当 `>1` 的布尔开关（见 `lib/cluster.js` 第 393–395 行注释）；现 `subdivide` 在 `depth >= maxDepth` 时停止递归（`lib/cluster.js` 第 408 行）。`test-cluster.mjs` 第 313 / 329 行分别验证 `maxDepth=2` 只下钻一层、`maxDepth=3` 出现孙模块。
- **永不丢组件**：顶层缺 LLM 时走 `heuristicCluster`；LLM 漏分配由 `fillMissing` 补齐；解析出的 `missing` 也交给 `fillMissing`。`test-cluster.mjs` 第 157 / 198 行验证两种缺漏都补回且总数不变。

## Data Flow

1. **输入**：`components` 来自 `lib/symbols.js` 的 `extractRepoGraph`（AST 提取，形状见 `lib/symbols.js` 第 13–14 行），经 `index.js` 的 `semanticPlan`（`index.js` 第 1440–1441 行）收集为 `components = [...graph.values()]` 后传入 `clusterComponents`（`index.js` 第 1457 行）。
2. **提示词输入构造**：`formatComponents(components)` 把组件压成 `按文件分组 + (artifact: config) 标记` 的文本（`lib/cluster.js` 第 28 行），喂给 `clusterPrompt` / `subClusterPrompt` / `superGroupPrompt`。
3. **LLM 调用包装**：`clusterComponents` 内的 `call`（第 303–307 行）统一 `stats.requests++` 并把 `{content}` 或字符串规整为字符串；`index.js` 的 `semanticPlan` 用 `llmChat` 包一层（`index.js` 第 1448–1453 行）。
4. **解析与校验**：`parseClusterResponse` 校验 id（`lib/cluster.js` 第 156 行），`parseSuperGroups` 校验子系统引用（`lib/cluster.js` 第 425 行）。
5. **输出**：`toPlanModules`（`lib/cluster.js` 第 460 行）把 `result.modules`（叶子）转成 `{ name, summary, files, parent? }`，`semanticPlan` 把它塞进 `plan.modules`（`index.js` 第 1469 行），再经 `index.js` 第 3276–3286 行映射成每篇模块文章的 `tasks`（每篇一个 `modules/<slug>.md` 文章任务）。

`stats` 字段（`lib/cluster.js` 第 295 行）：`{ requests, llm, levels, fallbacks }`——`levels` 在 `subdivide` 里用 `Math.max` 累计（`lib/cluster.js` 第 405 行），`fallbacks` 在降级/解析失败时累加（`lib/cluster.js` 第 316 / 319 / 322 / 401 / 419 行）。

## Connections

- [[symbols]] —— 组件（id、`relativePath`、`parameters`、`dependsOn` 等）由 `lib/symbols.js` 的 AST 提取产出，是 `clusterComponents` 的唯一输入。
- [[incremental]] —— `semanticPlan` 把聚类结果里的 `components` 与 `edges` 随 `plan.graph` 持久化（`index.js` 第 1476–1485 行），供 `lib/incremental.js` 的组件级变更判定消费；`tree` 随 `plan` 写进 `JOBS_FILE`。
- [[update-planner]] —— `lib/update-planner.js` 的 `buildModuleMap`（`lib/update-planner.js` 第 442 行）优先取 `plan.modules` 里的 `module` 名做模块归属；聚类产出的模块树经 `plan` 流入增量规划。
- [[index]] —— `index.js` 的 `semanticPlan`（`index.js` 第 1410 行）与 `localPlan`（`index.js` 第 1388 行）是聚类在编排层的两个规划入口，`buildPlan`（`index.js` 第 3008 行）择一；`planMode` 配置（`index.js` 第 90 行）决定走 `auto`（语义聚类）还是 `dirs`（目录分组）。
- [[engine]] —— 原生 Python 通道（`lib/engine/python/entry.py`）由 FSoft 引擎自己完成图与聚类，`lib/cluster.js` 只在 Node 内置流水线（`nativeEngine=false`）里使用。

## Known Issues

- **`planMode='dirs'` 完全绕过本模块**：此时 `index.js` 的 `buildPlan`（`index.js` 第 3010 行）直接调 `localPlan`（`index.js` 第 1388 行），`clusterComponents` 不被调用，因此语义聚类的全部能力与降级路径都不生效。
- **`subdivide` 递归在 `depth >= maxDepth` 直接返回 `kids` 且不再补 `children`**：当 `maxDepth` 正好等于当前 `depth` 时，子模块不再继续下钻（`lib/cluster.js` 第 408 行）；测试里通过把 `splitThreshold` 设为极小（如 2）来强制触发多层（`test-cluster.mjs` 第 319 行）。
- **LLM 回复格式依赖 `parseJsonLoose` 抢救**：若模型输出前后废话且对象被截断（缺闭合 `}`），`parseJsonLoose` 仍会失败返回 `null`，进而触发降级（`lib/cluster.js` 第 142–152 行）。不保证所有畸形 JSON 都能救回。
- **`heuristicCluster` 的单目录仓库会下探一层**：当仓库仅有一个顶层目录（常见的 `src/`）且 `depth=1` 只得到一个分组时，会再按 `depth=2` 拆（`lib/cluster.js` 第 234–237 行）；若仍只有一个分组则退回原分组——可能产生一个很粗的 `src` 模块。
- **`misc` 模块兜底**：任何目录都匹配不上的漏掉组件会被塞进 `misc`（`lib/cluster.js` 第 259–266 行），其 `summary` 固定为「未归入其他模块的零散组件」，文章命名即 `misc.md`，无语义含义。
