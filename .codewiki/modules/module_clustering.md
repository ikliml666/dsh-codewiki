---
title: module_clustering
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
tags: [clustering, llM, modules, supergroups, heuristics]
---

## Overview

`lib/cluster.js` 是模块聚类引擎：把符号提取阶段产出的「叶子组件」（函数/类/方法，id 形如 `path#name`）划分成有职责的「模块」，并可选地递归下钻、再按架构角色聚成「超级分组（子系统）」。它对应上游 FSoft-AI4Code/CodeWiki 的 `src/be/cluster_modules.py` 加上 `prompt_template.py` 里的 `CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT` 三段式。

与上游的差异（见 `lib/cluster.js:1-20` 的头部注释）：

- 上游用 Python dict 层层递归 + 落盘 `module_tree.json`；这里用纯函数 + 显式层级，便于测试（注入 `llmCall` 就不碰网络）。
- 上游把「要不要下钻」交给 LLM 回复里的嵌套结构；这里用显式阈值（组件数 / 是否已有子目录）决定下钻，减少请求数——大仓库全量聚类几十次请求不可接受。
- 组件 id 用 `path#name`（本插件的 `lib/symbols.js` 约定），提示词里明确说明。

对外契约（见 `lib/cluster.js:17-20`）：

```js
clusterComponents({ components, tree?, llmCall, ... }) ->
  { modules: [{ name, summary, files, components, children?, parent? }], concepts: [], stats }
```

- `llmCall` 形如 `async (prompt) => string`；不传则走纯本地启发式（无网络、可测），永不断链。
- 返回的 `modules` 只含**叶子模块**（会单独成文）；父模块只作导航容器，保留在 `tree` 字段里。
- `stats` 含 `requests / llm / levels / fallbacks`，供上层 `semanticPlan` 记 note。

本模块是「语义规划」路径的核心。在 `index.js` 的 `semanticPlan`（`index.js:1393`）里被调用：`extractRepoGraph` 拿到组件后，构造 `llmCall` 包一层 `llmChat`，再 `await clusterComponents({ components, llmCall, signal })`（`index.js:538`）。`clusterComponents` 失败或被调用方判为不可用（如 `no-components`）时，`index.js:1431` 的 `buildPlan` 会退回 `localPlan`（纯目录分组，`index.js:1371`）。

## Key Components

文件：`lib/cluster.js`（共 468 行）。下列为全部导出符号与关键内部函数，行号以 `lib/cluster.js` 源码前缀为准。

### 导出函数 / 常量

- `formatComponents(components)` — `lib/cluster.js:28-46`。按文件分组把组件渲染成提示词文本：只给「名字 + 类型 + 一行签名」（参数多于 6 个截断为 `…`），不给函数体。每组前一行 `# <file>` 并调用 `artifactTag` 标 `(artifact: config)`。用于所有聚类提示词里喂给模型的组件清单。
- `ARTIFACT_RE` / `artifactTag(file)` — `lib/cluster.js:48-51`。正则匹配构建/打包/配置类文件名（`package.json`、`tsconfig*.json`、`Cargo.toml`、`pyproject.toml`、`Dockerfile*`、`.*rc`、`*.ya?ml`、`*.toml`、`*.json` 等），命中则给该文件行追加 `(artifact: config)` 标记，提示模型把它们归入 build/config 模块。
- `clusterPrompt(componentText, totalComponents)` — `lib/cluster.js:57-81`。顶层聚类提示词模板：要求模型把组件分成 5–40 个组件的模块，模块名用小写下划线、禁止目录名直译，强调 `path` 填主要目录、组件 id 必须原样返回、只输出可解析 JSON（无围栏）。
- `subClusterPrompt(moduleName, componentText, totalComponents)` — `lib/cluster.js:84-103`。下钻提示词：给一个超大模块，要求拆成更小的子模块；若确实不可再分就返回单子模块（保持原名）。
- `superGroupPrompt(modules)` — `lib/cluster.js:106-129`。超级分组提示词：把平铺的顶层模块按架构角色归成更少的子系统，要求 `subsystems` 数组、子系统数量显著少于模块数量。
- `parseJsonLoose(text)` — `lib/cluster.js:135-153`。尽力抢救模型 JSON：先剥 ```` ```json ```` 围栏，再直接 `JSON.parse`，最后取第一个 `{` 到最后一个 `}` 之间并尝试去掉尾部多余逗号。任何情况都返回 `null` 而非抛错。
- `parseClusterResponse(text, validIds, warnings=[])` — `lib/cluster.js:156-195`。从模型回复取出模块数组（`modules` 或 `groups`），对组件 id 做存在性校验与去重（`seen` 集合防重复分配），丢弃空模块，返回 `{ modules, missing }`。模块名经 `normalizeModuleName` 规范化；`path` 缺省时调 `guessPath`。未知 id / 重复分配 / 缺 `modules` 都会向 `warnings` 推消息。
- `normalizeModuleName(name)` — `lib/cluster.js:198-206`。把模块名规范成文件名友好形式：空格转 `_`、非法字符转 `_`、折叠多余 `_`、小写；空串回落 `'module'`；保留 CJK 字符（不塌缩成 `module`）。
- `guessPath(ids)` — `lib/cluster.js:208-212`。内部：从第一个组件 id 的 `path` 段取目录；目录即仓库根时返回 `''`。
- `heuristicCluster(components)` — `lib/cluster.js:219-244`。本地启发式聚类（无 LLM 时的降级路径，也用于补齐漏掉组件）。按顶层目录分组（`depth=1`）；若整个仓库只分出一个组（典型 `src/` 单目录布局），下探一层（`depth=2`）。返回 `[{name, path, summary, components}]`。
- `fillMissing(modules, components, missingIds)` — `lib/cluster.js:247-268`。把 LLM 漏掉的组件按目录补回最相近的模块；无处归属的组件收集起来新建一个 `misc` 模块（`name:'misc'`）。
- `moduleFiles(componentIds, byId)` — `lib/cluster.js:274-281`。汇总某模块组件涉及的去重源文件清单（按 `c.id` 取 `relativePath`），供文章 `source_files` 使用。
- `clusterComponents(opts)` — `lib/cluster.js:291-389`。主入口，见下方「主入口行为」。
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` — `lib/cluster.js:396-422`。内部：对单个超大模块下钻一层；递归条件 `depth < maxDepth` 且子模块仍 `>= splitThreshold`；下钻后只有一个子模块且名字没变视为「不可再分」，保留原模块（返回 `null`）。
- `parseSuperGroups(text, modules, warnings=[])` — `lib/cluster.js:425-456`。解析超级分组回复，把列出的模块收进子系统节点（`components: []`，只挂 `children`），未被任何子系统收走的模块直接留在顶层（不凭空消失）。
- `toPlanModules(result)` — `lib/cluster.js:460-467`。把 `clusterComponents` 结果转成 `index.js` 任务清单形状：`{ name, summary, files, parent? }`，与 `index.js` 的 `job.plan.modules` 约定一致。

### 默认阈值常量（主入口内定义）

- `DEFAULT_MAX_DEPTH = 2` — `lib/cluster.js:287`（总层数上限：1=只顶层，2=允许一层子模块，3=允许孙模块）。
- `DEFAULT_SPLIT_THRESHOLD = 60` — `lib/cluster.js:288`（单模块组件数超过它才尝试下钻）。
- `DEFAULT_TOP_FANOUT = 14` — `lib/cluster.js:289`（顶层模块超过它才做超级分组）。

### 主入口 `clusterComponents(opts)` 行为（`lib/cluster.js:291-389`）

入参 `opts`：`components`、`llmCall`（可空）、`maxDepth`、`splitThreshold`、`topFanout`、`superGroup`（非 `false` 时开启）、`signal`（透传给 `call`，但当前 `call` 未真正使用 `signal`）。返回 `{ modules, tree, concepts, warnings, stats, byId }`，其中：

- `modules`：只有叶子模块（父模块不单独成文）。
- `tree`：完整层级树（含父节点的 `children` 与 `aggregateFiles`）。
- `stats`：`{ requests, llm, levels, fallbacks }`。
- 空组件集：`lib/cluster.js:299-301` 直接返回 `{ modules: [], concepts: [], warnings:['没有可聚类的组件'], stats }`，不抛错。

流程三段式见 Architecture 与 Data Flow。

## Architecture

组件 ≥3 且流程非平凡，主入口 `clusterComponents`（`lib/cluster.js:291-389`）编排三段式。框图如下：

```text
                  components: [{id,relativePath,kind,...}]   (来自 extractRepoGraph)
                                │
                                ▼
                  ┌─────────────────────────────┐
                  │ clusterComponents (lib:291)  │
                  └─────────────────────────────┘
                                │
              ┌─────────────────┴───────────────┐
              │ llmCall 存在?                    │ 否
              ▼ 是                               ▼
 ┌──────────────────────────┐        ┌──────────────────────┐
 │ call(clusterPrompt(      │        │ heuristicCluster       │
 │   formatComponents(...)))│        │ (lib:219) 目录分组      │
 │ parseClusterResponse     │        └──────────────────────┘
 │ fillMissing(缺漏补齐)     │                │
 └──────────────────────────┘                │
              │ 失败/降级 ──────── fallbacks++ │
              └───────────────┬────────────────┘
                              ▼
                    topModules (顶层模块列表)
                              │
            ┌─────────────────┴─────────────────┐
            │ maxDepth>1 & 超大模块?             │
            ▼ 是 (llmCall)                       ▼ 否
 ┌──────────────────────────┐          topModules 原样
 │ subdivide (lib:396)       │
 │ subClusterPrompt 递归下钻 │
 └──────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            │ topModules.length>topFanout?       │
            ▼ 是 (llmCall)                       ▼ 否
 ┌──────────────────────────┐          ┌──────────────────────┐
 │ call(superGroupPrompt)   │          │ 保留平铺顶层           │
 │ parseSuperGroups          │          └──────────────────────┘
 │ (lib:425)                 │
 └──────────────────────────┘
                              │
                              ▼
                  finalize(m, parent) (lib:359)
                  补 files / aggregateFiles / parent
                              │
              ┌───────────────┴────────────────┐
              ▼ collect 只收叶子                 ▼ tree 保留全部
       modules (成文清单)              tree (导航容器)
              │
              ▼ toPlanModules (lib:460) → index.js job.plan.modules
```

关键设计点：

- 父模块本身不单独成文：`finalize`（`lib/cluster.js:359-375`）里父节点 `files` 汇总给子模块用（`aggregateFiles`），`collect`（`lib/cluster.js:380-386`）只把无 `children` 的叶子推入 `articles`。
- 下钻递归安全：`subdivide` 递归时每个子模块组件数严格小于父模块（`kids.length>1` 已保证），且 `depth>=maxDepth` 即停（`lib/cluster.js:408-416`），不会无限递归。旧实现把 `maxDepth` 只当 `>1` 布尔开关、配 2 与配 3 行为完全相同，已在注释里说明（`lib/cluster.js:394-395`）。
- 任何 LLM 失败都不中断：`try/catch` 后 `stats.fallbacks++` 并退回 `heuristicCluster`（`lib/cluster.js:311-324`）或保留原模块（`lib/cluster.js:317-320`、`:348-356`）。

## Data Flow

1. **输入**：`components` 来自 `index.js:semanticPlan` 对 `extractRepoGraph`（`lib/symbols.js`）结果的 `[...graph.values()]`（`index.js:1423`），每个组件形如 `{ id: '<relpath>#<name>', name, kind, relativePath, parameters, baseClasses, dependsOn, docstring }`。

2. **顶层聚类（LLM 或启发式）**：
   - LLM 路径：`call(clusterPrompt(formatComponents(components), components.length))`（`lib/cluster.js:313`）→ `parseClusterResponse(text, allIds, warnings)`（`lib/cluster.js:314`）→ `fillMissing(parsed.modules, components, parsed.missing)`（`lib/cluster.js:315`）。
   - 无 `llmCall` 或解析失败：`heuristicCluster(components)`（`lib/cluster.js:324`），`stats.fallbacks++`。
   - `byId` 为 `Map<id, component>`（`lib/cluster.js:296`），后续 `moduleFiles` / `subdivide` 查组件都用它，避免重复遍历。

3. **下钻**：仅当 `llmCall && maxDepth>1`（`lib/cluster.js:396`）。对每个组件数 `>= splitThreshold` 的顶层模块调 `subdivide`（`lib/cluster.js:335`），得到子模块数组；若 `kids.length>1` 则父模块保留为带 `children` 的目录节点（`lib/cluster.js:338`），否则保留原模块。下钻层递归同逻辑（`lib/cluster.js:409-416`）。

4. **超级分组**：仅当 `llmCall && topModules.length>topFanout && opts.superGroup!==false`（`lib/cluster.js:303`）。`call(superGroupPrompt(topModules))`（`lib/cluster.js:425`）→ `parseSuperGroups`（`lib/cluster.js:351`）把模块收进子系统；未归类模块留在顶层。

5. **最终化**：`finalize(m, parent)`（`lib/cluster.js:359-375`）为每个节点补 `files = moduleFiles(m.components, byId)`（`lib/cluster.js:372`）与层级元信息（`parent`、`children`、`aggregateFiles`）。`collect`（`lib/cluster.js:380-386`）只收集叶子节点进 `articles`。

6. **输出转换**：`toPlanModules(result)`（`lib/cluster.js:460-467`）把叶子 `modules` 映射成 `{ name, summary, files, parent? }`，交给 `index.js:1452` 的 `plan.modules`，进而在 `index.js:3249` 被映射成每篇模块文章的写作任务（`name: modules/<slug>.md`、`sources: mod.files`）。

组件完整性保证：无论 LLM 路径还是 `heuristicCluster`，最终所有组件 id 都落在 `tree` 里——LLM 漏掉的经 `fillMissing` 补回（建 `misc` 兜底），`stats.missing` 统计缺失并记 `warnings`（`lib/cluster.js:294`、`:389`）。测试 `test-cluster.mjs:153-216` 专门验证无 LLM / LLM 抛错 / LLM 返回垃圾时组件不丢。

## Connections

## Known Issues