---
title: cluster
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/symbols.js
tags: [planning, module-clustering, llm, semantic-plan, fallback]
---

## Overview

`lib/cluster.js` 是 dsh-codewiki 的**模块规划（聚类）核心**：把 `lib/symbols.js` 的
AST 符号提取器产出的「组件清单」（`{ id, name, kind, relativePath, parameters, ... }`）
按**职责**聚合成一棵模块树，供下游逐模块撰写架构文档（`[[articles-agentic]]`）。

它是上游 FSoft-AI4Code/CodeWiki 的 `cluster_modules.py` + `prompt_template.py`
三段式（CLUSTER_REPO_PROMPT / CLUSTER_MODULE_PROMPT / SUPER_GROUP_PROMPT）的 JS 移植，
但做了三处有意为之的差异（见文件头注释 `lib/cluster.js:1-20`）：

- 上游用 Python dict 层层递归 + 落盘 `module_tree.json`；本模块用**纯函数 + 显式层级**，便于注入 `llmCall` 做单测；
- 上游把「要不要下钻」交给 LLM 回复的嵌套结构；本模块用**显式阈值**（`splitThreshold` / 是否已有子目录）决定下钻，减少请求数；
- 组件 id 用 `path#name`（见 `lib/symbols.js:10-11`），提示词里明确说明。

对外只暴露一个异步主入口 `clusterComponents(opts)`（`lib/cluster.js:291`），契约是：

```js
clusterComponents({ components, tree?, llmCall, ... })
// -> { modules: [{ name, summary, files, components, children?, parent? }], tree, concepts: [], warnings, stats, byId }
```

`llmCall` 形如 `async (prompt) => string`（`lib/cluster.js:20`）；**不传则纯本地启发式**（无网络可跑、可测，
走 `heuristicCluster`，`lib/cluster.js:219`），与插件 `index.js` 的 `localPlan`（`index.js:1300`）策略同源。

聚类分三层（对应上游三段式）：

1. **顶层聚类** `clusterPrompt`（`lib/cluster.js:57`）：把全仓库组件交给 LLM 分成「叶子模块」；
2. **下钻** `subClusterPrompt`（`lib/cluster.js:84`）：对超阈值的大模块递归拆成子模块（`subdivide`，`lib/cluster.js:396`）；
3. **超级分组** `superGroupPrompt`（`lib/cluster.js:106`）：顶层过多时把平铺模块归成「架构子系统」（`parseSuperGroups`，`lib/cluster.js:425`）。

入口由 `index.js` 的 `semanticPlan`（`index.js:1322`）调用：`index.js:1369` 把 `extractRepoGraph`
产出的 `components` 交给 `clusterComponents`，再把 `result` 经 `toPlanModules`（`lib/cluster.js:460`）转成
`job.plan.modules` 形状（`{ name, summary, files, parent? }`）。

## Key Components

所有公开符号都从 `lib/cluster.js` 导出；下列行号以 `lib/cluster.js` 的「行号| 」前缀为准。

### `formatComponents(components)` — `lib/cluster.js:28`

按**文件**把组件分组（比一长串平铺 id 更省 token、更利于模型看出归属）。返回多行文本：

- 每个文件一行 `# <relativePath>(artifact: config)`（`artifactTag`，`lib/cluster.js:49`）；
- 文件下每个组件一行 `\t<id>\t<kind>\t<name>(<参数签名>)`（签名只取前 6 个参数，超出补 `…`，`lib/cluster.js:41`）。
- `ARTIFACT_RE`（`lib/cluster.js:48`）：匹配 `package.json` / `tsconfig*` / `Cargo.toml` / `pyproject.toml` / `Dockerfile*` / `*.ya?ml` / `*.toml` / `.*rc` 等构建/配置/测试文件，打 `(artifact: config)` 标签。

### `clusterPrompt(componentText, totalComponents)` — `lib/cluster.js:57`

顶层聚类提示词（对应上游 `CLUSTER_REPO_PROMPT`）。要求模型输出单个 JSON 对象
`{ "modules": [{ "name", "path", "summary", "components": [id...] }] }`，并强制：

- 组件 ID 形如 `<相对路径>#<符号名>`，**必须原样返回**（`lib/cluster.js:61`）；
- 共 `${totalComponents}` 个组件不得遗漏（`lib/cluster.js:69`）；
- 标了 `(artifact: config)` 的文件归入专门 build/config 模块或附到它所配置的模块（`lib/cluster.js:70`）；
- 模块名用英文小写下划线（`lib/cluster.js:72`），单个模块 5–40 组件（`lib/cluster.js:71`）。

### `subClusterPrompt(moduleName, componentText, totalComponents)` — `lib/cluster.js:84`

下钻提示词（对应上游 `CLUSTER_MODULE_PROMPT`）。给一个已聚好的大模块，要求拆成更小的子模块，
允许「确实不可再分」时返回**单个**保持原名的子模块（`lib/cluster.js:94`）。

### `superGroupPrompt(modules)` — `lib/cluster.js:106`

超级分组提示词（对应上游 `SUPER_GROUP_PROMPT`）。把顶层模块清单按**架构角色**归成子系统，
要求输出 `{ "subsystems": [{ "name", "modules": [模块名...] }] }`，且子系统数必须显著少于模块数
（`lib/cluster.js:118`），每个模块必须且只能归属一个子系统（`lib/cluster.js:120`）。

### `parseJsonLoose(text)` — `lib/cluster.js:135`

尽力抢救模型回复里的 JSON：剥 ```` ```json ```` 围栏（`lib/cluster.js:139`）、直接 `JSON.parse`、
取第一个 `{` 到最后一个 `}` 之间（`lib/cluster.js:144`）、再试去掉尾部多余逗号（`lib/cluster.js:150`）。
全部失败返回 `null`。

### `parseClusterResponse(text, validIds, warnings = [])` — `lib/cluster.js:156`

从模型回复里取出模块数组，并做 **id 校验与去重**：

- 解析失败 → `warnings.push('聚类回复不是合法 JSON')` 并返回 `null`（`lib/cluster.js:158-160`）；
- 缺少 `modules` / `groups` 数组 → 记 `'聚类回复缺少 modules 数组'` 返回 `null`（`lib/cluster.js:163-165`）；
- 逐模块只保留 `validIds` 里**已知**且**未出现**的 id；未知 id 记「不存在的组件 id」、重复 id 记「重复分配」后丢弃
  （`lib/cluster.js:174-180`）；
- 模块名经 `normalizeModuleName`（`lib/cluster.js:183`），`path` 缺省时由 `guessPath` 推断（`lib/cluster.js:184/208`）；
- 返回 `{ modules, missing }`，`missing` 是 `validIds` 中没被任何模块纳入的 id（`lib/cluster.js:193-194`）。

### `normalizeModuleName(name)` — `lib/cluster.js:198`

模块名统一成**文件名友好**形式：空格转 `_`、非 `\w` 与中文与 `-` 的字符一律转 `_`、折叠连续 `_`、去首尾 `_`、转小写；
空名回落 `'module'`（`lib/cluster.js:205`）。用于 `<name>.md` 文件名，不能含路径分隔符与空格。

### `guessPath(ids)` — `lib/cluster.js:208`

从第一个组件 id 的文件部分取 `dirname` 作为模块路径（根目录回落 `''`）。

### `heuristicCluster(components)` — `lib/cluster.js:219`

**无 LLM 降级路径**（也用于补齐漏掉的组件）。按顶层目录分组：

- `groupBy(depth)`（`lib/cluster.js:220`）：`depth=1` 取第一段、`depth=2` 取前两段（`lib/cluster.js:225`）；
- 若只有**单个顶层目录**（极常见的 `src/` 布局），下探一层取更多模块，下探后仍只有一个组则保留原分组
  （`lib/cluster.js:234-237`）；
- 返回 `[{ name, path, summary, components }]`，与 `index.js` 的 `localPlan` 同源策略。

### `fillMissing(modules, components, missingIds)` — `lib/cluster.js:247`

把 LLM 漏掉的组件按目录补回最相近的模块（路径等于或以模块 `path/` 开头即命中，`lib/cluster.js:255`）；
实在没有归属就新建一个 `misc` 模块（`lib/cluster.js:259-266`）。

### `moduleFiles(componentIds, byId)` — `lib/cluster.js:274`

从组件 id 反查其 `relativePath`，去重排序列出文件清单（供文章 frontmatter 的 `source_files` 用）。

### `clusterComponents(opts)` — `lib/cluster.js:291`（主入口）

签名与默认参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `opts.components` | `[]` | 组件清单（来自 `extractRepoGraph`，形状见 `lib/symbols.js:785-786`） |
| `opts.llmCall` | `null` | `async (prompt) => string`；不传则走 `heuristicCluster` |
| `opts.maxDepth` | `DEFAULT_MAX_DEPTH = 2`（`lib/cluster.js:329`） | 总层数上限：1=只顶层，2=允许一层子模块，3=允许孙模块 |
| `opts.splitThreshold` | `DEFAULT_SPLIT_THRESHOLD = 60`（`lib/cluster.js:330`） | 组件数超过它才尝试下钻 |
| `opts.topFanout` | `DEFAULT_TOP_FANOUT = 14`（`lib/cluster.js:347`） | 顶层模块超过它且 `superGroup !== false` 才做超级分组 |
| `opts.superGroup` | （未传=启用） | 设为 `false` 可跳过超级分组 |

执行流程（详见架构与数据流小节）：

1. 空组件集 → 直接返回 `{ modules: [], concepts: [], warnings: ['没有可聚类的组件'], stats }`（`lib/cluster.js:299-301`）；
2. 顶层聚类：有 `llmCall` 时 `try` 调用 `clusterPrompt` + `parseClusterResponse` + `fillMissing`，
   失败/无 LLM 时 `stats.fallbacks += 1` 并回落 `heuristicCluster`（`lib/cluster.js:311-324`）；
3. 下钻：仅当 `llmCall` 且 `maxDepth > 1`（`lib/cluster.js:331`），对超大模块调 `subdivide`
   （`lib/cluster.js:335`），成功拆出 >1 个子模块则父模块保留为带 `children` 的目录节点（`lib/cluster.js:338`）；
4. 超级分组：仅当 `llmCall` 且 `topModules.length > topFanout` 且 `superGroup !== false`
   （`lib/cluster.js:106`），调 `superGroupPrompt` + `parseSuperGroups`；
5. `finalize`（`lib/cluster.js:359`）：补齐每个模块的 `files`、`summary`、层级元信息 `parent`、
   以及父模块的 `aggregateFiles`（子模块文件汇总，`lib/cluster.js:372`）；
6. `collect`（`lib/cluster.js:380`）：只把**叶子模块**收进 `articles`（父节点是导航容器，不单独成文）；
7. 返回 `{ modules: articles, tree, concepts: [], warnings, stats, byId }`（`lib/cluster.js:388`）。

`stats` 字段（`lib/cluster.js:295`）：`requests`（LLM 请求数）、`llm`（是否用了 LLM）、`levels`（实际层数）、`fallbacks`（降级次数）。

### `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` — `lib/cluster.js:396`

对单个大模块下钻一层（`depth` 是当前层号，顶层模块=1）。`depth >= maxDepth` 即停止递归（`lib/cluster.js:408`）；
下钻只返回 1 个子模块（且名字没变）视为「不可再分」，保留原模块返回 `null`（`lib/cluster.js:404`）。
递归条件：子模块仍 `>= splitThreshold` 且还没到 `maxDepth` 才继续下钻（`lib/cluster.js:409-415`），
且每个子模块组件数严格小于父模块，保证不会无限递归（`lib/cluster.js:407`）。

> 历史坑（`lib/cluster.js:394-395`）：早期实现 `subdivide` 内部不再递归，`maxDepth` 只被当成 `>1` 的布尔开关，
> 配 3 和配 2 行为完全一样；现在已修复为真正可配层数，由 `test-cluster.mjs:313/329` 钉住。

### `parseSuperGroups(text, modules, warnings = [])` — `lib/cluster.js:425`

超级分组结果 → 带 `children` 的顶层列表：

- 解析失败 / 缺 `subsystems` / `groups` 数组 → 记警告返回 `null`（`lib/cluster.js:427-429`）；
- 每个子系统 `{ name, summary, components: [], children: [被收编的模块...] }`，父节点自身不写文章（`lib/cluster.js:444-451`）；
- 引用了不存在的模块名 → 记警告跳过（`lib/cluster.js:438`）；
- **没被任何子系统收走的模块直接留在顶层**，不能凭空消失（`lib/cluster.js:454`）。

### `toPlanModules(result)` — `lib/cluster.js:460`

把 `clusterComponents` 结果转成插件 articles 阶段吃的任务清单形状
（与 `index.js` 的 `job.plan.modules` 一致）：`{ name, summary, files, ...(parent?) }`（`lib/cluster.js:461-466`）。

## Architecture

`clusterComponents` 三段式的组件与调用关系如下（框内标注函数名与 `lib/cluster.js` 行号）：

```text
 components (from lib/symbols.js)
        │
        ▼
┌──────────────────────────┐
│ clusterComponents (291)  │ 主入口：stats / finalize / collect
└───────────┬──────────────┘
            │ opts.llmCall ?
   ┌────────┴─────────┐
   │ no (fallback)    │ yes (LLM)
   ▼                  ▼
┌──────────────┐  ┌──────────────────────────────┐
│ heuristic    │  │ clusterPrompt (57)            │
│ Cluster (219)│  │ -> parseClusterResponse (156) │
└──────┬───────┘  │ -> fillMissing (247)          │
       │          └──────────────┬───────────────┘
       │  topModules             │
       └───────────┬─────────────┘
                   ▼
        ┌──────────────────────┐
        │ subdivide (396) loop  │ if llmCall && maxDepth>1 && size>=splitThreshold
        │ subClusterPrompt(84)  │ 递归下钻，父节点挂 children
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────┐
        │ superGroupPrompt(106)│ if llmCall && topFanout>14 && superGroup!==false
        │ -> parseSuperGroups  │ 平铺模块 -> subsystems(children)
        │    (425)             │
        └──────────┬───────────┘
                   ▼
        ┌──────────────────────┐
        │ finalize (359)       │ 补 files / parent / aggregateFiles
        │ collect (380)        │ 只收叶子模块 -> articles
        └──────────┬───────────┘
                   ▼
   { modules, tree, warnings, stats, byId }
                   │
                   ▼
   toPlanModules (460) -> job.plan.modules (index.js:1381)
```

关键设计点：

- **纯函数 + 显式层级**：除主入口外，`formatComponents` / `parse*` / `heuristicCluster` / `fillMissing` /
  `subdivide` / `parseSuperGroups` / `toPlanModules` 都是纯函数，便于注入 `llmCall` 做单测（见 `test-cluster.mjs`）。
- **降级永不断链**：任何 LLM 环节失败都记 `warnings` 并 `stats.fallbacks += 1`，最终回落到 `heuristicCluster`
  或保留平铺模块，保证「组件不丢」（测试钉死：`test-cluster.mjs:153/201/210`）。
- **父节点不单独成文**：`children` 节点（大模块的拆分层、超级分组的子系统层）在 `finalize` 里只作导航容器，
  只有叶子 `articles` 才会被下游写成 `modules/<name>.md`（`lib/cluster.js:378-386`、`test-cluster.mjs:245`）。

## Data Flow

1. **上游输入**：`index.js` 的 `semanticPlan`（`index.js:1322`）先用 `extractRepoGraph`
   （`lib/symbols.js`）把全仓库源码抽成 `components`（`{ id, name, kind, relativePath, parameters, ... }`），
   再调 `resolveImportEdges` 建依赖边（`index.js:1358`）。`id` 形如 `<相对路径>#<符号名>`
   （`lib/symbols.js:10-11`），是聚类全程的组件主键。
2. **构造 `llmCall`**：仅当配置了 `llm` 且 `provider || model` 时，`index.js:1360-1365` 包出
   `async (prompt) => (await llmChat(...)).content`；否则传 `null`，聚类降级为纯目录启发式。
3. **顶层聚类请求**：`clusterComponents` 用 `formatComponents(components)`（`lib/cluster.js:313`）把组件压成提示词，
   经 `llmCall` 拿到文本 → `parseClusterResponse` 校验去重 → `fillMissing` 补齐漏掉的组件。
4. **下钻递归**：`subdivide` 对每个组件数 `>= splitThreshold` 的模块，把该模块子集再过
   `formatComponents` + `subClusterPrompt`（lib/cluster.js:399），解析后若子模块仍超大且 `depth < maxDepth` 则继续递归（lib/cluster.js:28）。
5. **超级分组**：顶层模块数 `> topFanout` 时，`superGroupPrompt(topModules)` 让模型把平铺模块归成子系统，
   `parseSuperGroups` 收编成带 `children` 的列表；未被收编的模块原样留在顶层（`lib/cluster.js:425`）。
6. **收口**：`finalize` 给每个叶子/父节点补 `files`（经 `moduleFiles`，`lib/cluster.js:274`）、`parent`、
   父节点的 `aggregateFiles`；`collect` 只把叶子节点收进 `modules`（文章清单）。
7. **转 plan**：`semanticPlan` 调 `toPlanModules(result)`（`index.js:1381`）得到
   `{ name, summary, files, parent? }` 数组，连同 `tree`、`graph`、`stats` 一起写入 `job.plan`
   （`index.js:1377-1399`）。`tree` 与 `graph` 持久化到 `JOBS_FILE` 供 stale 增量编译用
   （`index.js:1383-1387`，增量只在意 `bodyHash`/签名/依赖，源码不随 plan 落盘）。

数据流里**组件 id 贯穿始终**：LLM 回复里的 id 必须与 `components` 的 `id` 完全一致（由 `parseClusterResponse`
的 `validIds` 校验），否则会被丢弃并记警告。

## Connections

- `[[symbols]]` — `lib/symbols.js` 的 `extractRepoGraph` 产出 `components`（聚类输入），`id` 约定 `path#name`，见 `lib/symbols.js:785-789`。
- `[[articles-agentic]]` — `clusterComponents` 输出的 `modules`（经 `toPlanModules`）即 `job.plan.modules`，是 agentic 文章写作的任务清单形状。
- `[[incremental]]` — `clusterComponents` 返回的 `tree` 与 `graph` 随 `job.plan` 持久化（`index.js:1383-1387`），供 stale 增量编译按组件粒度判定「哪些真变了」。
- `[[update-planner]]` — 下游 `lib/update-planner.js` 的 `planUpdate` / `buildModuleMap` 消费 `job.plan.modules` 做模块映射与迁移。
- `[[index]]` — `index.js` 的 `semanticPlan`（`index.js:1322`）与 `localPlan`（`index.js:1300`）是聚类的总调度与目录降级分支；`pruneOrphanModules`（`index.js:271`）依赖聚类产出的 `modules` 清单清理孤儿文章。
- 测试：`test-cluster.mjs` 用注入的 `llmCall` 模拟模型，覆盖三段式与全部降级路径（无 LLM、LLM 抛错、返回垃圾、下钻递归、超级分组）。

## Known Issues

- **`maxDepth` 历史 bug 已修**：早期 `subdivide` 内部不再递归，`maxDepth` 被当成 `>1` 的布尔开关，配 2 与配 3 行为完全相同（都只两层）。现修复为真正可配层数，测试 `test-cluster.mjs:313`（maxDepth=2 只一层子模块）、`test-cluster.mjs:270`（maxDepth=3 出现孙模块）钉死（见 `lib/cluster.js:394-395`）。
- **LLM 降级是设计而非缺陷**：无 `llmCall` / 请求失败 / 返回非 JSON 时一律回落 `heuristicCluster` 或保留平铺模块（`lib/cluster.js:311-324`），并记 `warnings` + `stats.fallbacks`。这保证「组件不丢」是唯一硬不变量；测试 `test-cluster.mjs:153/201/210` 专门验证降级后组件集合完整。
- **`concepts` 始终为空**：`clusterComponents` 的返回里 `concepts: []` 是占位字段，实际概念提取在下游横切阶段（`index.js` 的 `batchConceptPrompt`），聚类阶段不产出概念（见 `lib/cluster.js:291` 与 `index.js:1460`）。
- **父节点 `components` 为空**：超级分组的子系统节点 `components: []`、`children` 承载真实模块（`lib/cluster.js:292`），`finalize` 时父节点的 `files` 由 `aggregateFiles` 汇总给子模块用，避免重复写（`lib/cluster.js:371-372`）。若下游误把 `tree` 里带 `children` 的节点当成可成文模块会出问题——只有 `modules`（叶子）才写成文章。
- **`guessPath` 仅看第一个组件**：模块 `path` 缺省时只取 `components[0]` 的文件目录推断（`lib/cluster.js:208-212`），若一个模块跨多个目录，path 只反映首个组件所在目录；`fillMissing` 因此在回挂漏掉组件时按「目录前缀」匹配（`lib/cluster.js:247`），可能把同目录意外拆开的组件漏挂在首个命中的模块。
- **无功能被禁用/注释**：本模块所有导出函数均在 `index.js` 的 `semanticPlan` 路径或 `test-cluster.mjs` 中实际使用，`superGroup` 仅作为可关的开关（`lib/cluster.js:348`，`opts.superGroup === false` 时跳过超级分组），没有整段被注释禁用的代码。
