---
title: component_clustering
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/symbols.js
tags: [clustering, llm, heuristics, modules, planning]
---

## Overview

`lib/cluster.js` 是 dsh-codewiki 的「组件聚类」模块：把仓库里抽取出来的全部叶子组件（函数/类/方法/常量，id 形如 `path#name`）聚合成一组模块，供后续逐模块撰写架构文档。它对应上游 FSoft-AI4Code/CodeWiki 的 `cluster_modules.py` + `prompt_template.py` 三段式（`CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT`），但在本仓库里改成了纯函数 + 显式层级（见文件头注释 `lib/cluster.js:1-20`）。

设计要点：

- 三段式流水线：`clusterComponents()` 先全仓库顶层聚类（`clusterPrompt`），再对超大模块递归下钻（`subClusterPrompt`），最后顶层过多时做超级分组（`superGroupPrompt`）。
- 主入口 `clusterComponents(opts)` 的契约（`lib/cluster.js:17-20`）：`{ components, llmCall, ... } -> { modules, tree, concepts, warnings, stats, byId }`。`llmCall` 形如 `async (prompt) => string`；**不传则直接走纯本地启发式**（无网络、可测）。
- **降级永不丢失组件**：LLM 抛错 / 返回垃圾 JSON / 漏掉组件，都会被 `fillMissing` 按目录补回最接近的模块，实在没有归属就建一个 `misc` 模块（`lib/cluster.js:246-268`、`287-324`、`388`）。
- 与上游的两点核心差异（`lib/cluster.js:10-15`）：① 用纯函数 + 显式层级而非 Python dict 层层递归 + 落盘 `module_tree.json`，便于注入 `completer` 测试不碰网络；② 用显式阈值（组件数 / 是否已有子目录）决定是否下钻，而不是把「要不要下钻」交给 LLM 回复里的嵌套结构，从而减少大模型请求数——大仓库全量聚类几十次请求不可接受。

组件 id 约定来自 `lib/symbols.js:10-14`：`<相对路径>#<符号名>`，方法为 `#<类名>.<方法名>`。聚类只看结构（id / 类型 / 参数签名），不内联函数体（`lib/cluster.js:40-43`）。

## Key Components

全部公开函数/常量（行号以 `lib/cluster.js` 源码 `行号| ` 前缀为准）：

- `formatComponents(components)` — `lib/cluster.js:28-46`：把组件按文件分组输出为提示词文本。每行 `id <TAB> kind <TAB> name(参数)`；参数只取前 6 个、超了加 `…`；在 `# 文件` 行末对 `package.json`/`tsconfig*`/`Cargo.toml`/`pyproject.toml` 等构建/配置/测试文件追加 ` (artifact: config)` 标注（由 `artifactTag` `lib/cluster.js:48-51` + 正则 `ARTIFACT_RE` `lib/cluster.js:48` 判定）。按文件分组比平铺一长串 id 更省 token，也利于模型看出归属。
- `clusterPrompt(componentText, totalComponents)` — `lib/cluster.js:57-81`：顶层聚类提示词，对应上游 `CLUSTER_REPO_PROMPT`。要求模型把全部组件分成 5–40 个组件的模块、模块名用小写下划线、标 `(artifact: config)` 的文件归入 build/config 模块或附到它所配置的模块，且只输出一个可解析 JSON（`{modules:[{name,path,summary,components}]}`）。
- `subClusterPrompt(moduleName, componentText, totalComponents)` — `lib/cluster.js:84-103`：下钻提示词，对应上游 `CLUSTER_MODULE_PROMPT`。给一个已聚好的大模块，要求拆成更小的子模块；若确实不可再分就返回单个同名子模块。
- `superGroupPrompt(modules)` — `lib/cluster.js:106-129`：超级分组提示词，对应上游 `SUPER_GROUP_PROMPT`。把平铺的顶层模块按架构角色归成更少数量的「架构子系统」，输出 `{subsystems:[{name,modules}]}`。
- `parseJsonLoose(text)` — `lib/cluster.js:135-153`：尽力抢救模型回复里的 JSON：先剥 ```` ```json ```` 围栏，再直接 `JSON.parse`，再取第一个 `{` 到最后一个 `}` 之间，再试去尾逗号（`body.replace(/,\s*([}\]])/g, '$1')`）重解，全失败返回 `null`。
- `parseClusterResponse(text, validIds, warnings = [])` — `lib/cluster.js:156-195`：从模型回复取出模块数组，做 id 校验与去重。认 `obj.modules` 或 `obj.groups`；丢弃不存在的 id（记 `聚类返回了不存在的组件 id` 警告）、丢弃重复分配的后出现者（记 `组件被重复分配` 警告）；模块名经 `normalizeModuleName` 规范化，`path` 缺省时由 `guessPath` 推断；返回 `{ modules, missing }`，`missing` 为 `validIds` 中没被分到的 id。
- `normalizeModuleName(name)` — `lib/cluster.js:198-206`：模块名统一成文件名友好形式（会进 `<name>.md`，不能带路径分隔符与空格）：空格转 `_`、非 `\w` 与中日韩字符转 `_`、压扁连续 `_`、去首尾 `_`、转小写；空字符串兜底为 `'module'`。
- `guessPath(ids)` — `lib/cluster.js:208-212`：由首个组件 id 的文件目录推断模块 `path`；顶层文件返回 `''`。
- `heuristicCluster(components)` — `lib/cluster.js:219-244`：本地启发式聚类（无 LLM 时的降级路径，也用于补齐）。按顶层目录分组（`depth=1` 取第一段，`depth=2` 取前两段）；若 `depth=1` 只得到一个组（极常见的 `src/` 布局会把整个仓库塞进一个模块），则下探一层 `depth=2`，只有当 `depth=2` 仍然多于一个组才用新分组。每个组输出 `{name, path, summary, components}`。
- `fillMissing(modules, components, missingIds)` — `lib/cluster.js:247-268`：把 LLM 漏掉的组件按目录补回最相近的模块（命中规则 `dir === m.path` 或 `dir.startsWith(`${m.path}/`)`）；无处归属的聚成 `misc` 模块（`summary: '未归入其他模块的零散组件'`）。
- `moduleFiles(componentIds, byId)` — `lib/cluster.js:274-281`：由组件 id 集合汇总去重出 `source_files` 清单（供文章 frontmatter 的 `source_files` 用），按相对路径排序返回。
- `clusterComponents(opts)` — `lib/cluster.js:291-389`：主入口。详见下方「主入口流程」。
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` — `lib/cluster.js:396-422`：对单个超大模块下钻一层（递归）。见「主入口流程」第 2 层。
- `parseSuperGroups(text, modules, warnings = [])` — `lib/cluster.js:425-456`：超级分组结果 -> 带子模块的顶层列表。认 `obj.subsystems` 或 `obj.groups`；按模块名（`byName`）收进对应子系统；引用不存在的模块名跳过并记警告；未收走的模块直接留在顶层不凭空消失；子系统节点 `components: []`（父节点自身不写文章）。
- `toPlanModules(result)` — `lib/cluster.js:460-467`：把 `clusterComponents` 结果转成插件 articles 阶段吃的任务清单形状（与 `index.js` 的 `job.plan.modules` 一致：`{ name, summary, files, ...(parent) }`）。

模块级常量（默认阈值）：

- `DEFAULT_MAX_DEPTH = 2` — `lib/cluster.js:287`：默认总层数上限（1=只顶层，2=允许一层子模块，3=允许孙模块）。
- `DEFAULT_SPLIT_THRESHOLD = 60` — `lib/cluster.js:288`：组件数超过它就尝试下钻。
- `DEFAULT_TOP_FANOUT = 14` — `lib/cluster.js:289`：顶层模块超过它就做超级分组。

返回对象形状（`clusterComponents` 的 `result`）：

- `modules`：叶子模块清单（已 `finalize` + 只收叶子，父节点是导航容器不单列），每个节点字段：`name`、`path`、`summary`、`files`（源文件清单）、`components`（id 数组）、若有父则 `parent`。
- `tree`：带 `children` 的完整模块树；父节点额外带 `aggregateFiles`（子模块 `files` 的汇总，避免重复写）。
- `concepts`：恒为 `[]`（本模块不做概念抽取，由横切阶段负责）。
- `warnings`：本轮所有降级/校验警告数组。
- `stats`：`{ requests, llm, levels, fallbacks }`，`levels` 为实际达到的层数。
- `byId`：`Map<id, component>`。

## Architecture

`clusterComponents` 把三段式流水线串成一条显式层级树。组件 ≥3 且流程非平凡，框图如下（组件名 / 文件:行号）：

```text
                components (id=path#name, 来自 lib/symbols.js)
                              │
          formatComponents()  │  lib/cluster.js:28
                              ▼
   ┌─────────────────────────────────────────────┐
   │  clusterComponents()  主入口  lib/cluster.js:291
   │   1) 顶层聚类  clusterPrompt  :57
   │      ├─ llmCall 存在 → 解析 fillMissing  :311-323
   │      └─ 无 llmCall / 失败 → heuristicCluster 降级  :324
   │   2) 超大模块下钻 subdivide() 递归  :331-344 :396
   │      └─ subClusterPrompt  :84  (> splitThreshold 且 maxDepth>1)
   │   3) 顶层过多超级分组  superGroupPrompt  :348
   │      └─ parseSuperGroups  :425 (> topFanout 且 superGroup!==false)
   │   4) finalize() 补 files/层级 + collect() 收叶子  :359-386
   └─────────────────────────────────────────────┘
                              │
          toPlanModules()  :460    ──►  job.plan.modules (articles 阶段)
                              │
          result.tree / result.modules / result.stats

  解析层（共用）：
   parseJsonLoose :135 → parseClusterResponse :156 → fillMissing :247
   parseSuperGroups :425
```

关键设计约束：

- 父节点（被下钻的模块 / 超级分组子系统）只作导航容器，`components: []`，不进入 `modules`（成文清单只收叶子，见 `collect` `lib/cluster.js:380-386`）；父节点的 `files` 汇总到 `aggregateFiles`（`lib/cluster.js:372`）。
- 下钻递归条件严格受 `depth >= maxDepth` 截断（`lib/cluster.js:396`），且每个子模块组件数须严格小于父模块（`kids.length > 1` 已保证），**不会无限递归**；下钻只返回 1 个子模块且名字没变 → 视为「不可再分」，保留原模块（`lib/cluster.js:329`）。早期实现 `subdivide` 内部不递归、`maxDepth` 只被当 `>1` 布尔开关，配 2 和配 3 行为完全相同，已在 `lib/cluster.js:394-395` 注释说明并修复（测试见 `test-cluster.mjs:269-343`）。
- `llmCall` 为 `null` 时整条流水线只跑 `heuristicCluster`，但 `fillMissing` 仍保证零丢失（`lib/cluster.js:321-324`）。

## Data Flow

主入口 `clusterComponents(opts)` 的逐层数据流（`lib/cluster.js:291-389`）：

1. **输入准备**（`lib/cluster.js:292-297`）：取 `opts.components`（组件数组，每个含 `id`/`relativePath` 等）、`opts.llmCall`（可空）、建 `byId`（`Map<id, component>`）与 `allIds`。空组件集直接返回 `{modules:[], warnings:['没有可聚类的组件'], stats}`（`lib/cluster.js:297-299`）。`stats` 初始 `{ requests:0, llm: !!llmCall, levels:0, fallbacks:0 }`。
2. **顶层聚类**（`lib/cluster.js:303-325`）：`call(prompt)` 包装 `llmCall` 并 `stats.requests += 1`；`llmCall` 存在则 `clusterPrompt(formatComponents(components), components.length)` → `parseClusterResponse(text, allIds, warnings)` → `fillMissing(parsed.modules, components, parsed.missing)`；任何异常或解析失败 → `stats.fallbacks += 1` 并记警告。无 `llmCall` 直接 `fallbacks += 1`。只要 `topModules` 仍为空就 `heuristicCluster(components)` 兜底，`stats.levels = 1`。
3. **下钻**（`lib/cluster.js:329-344`）：读 `maxDepth`（默认 2）、`splitThreshold`（默认 60）。仅当 `llmCall && maxDepth > 1`：遍历 `topModules`，组件数 `< splitThreshold` 直接保留；否则 `subdivide(...)`；返回 `>1` 个子模块则父模块 `{ ...m, children: kids }` 保留为目录节点，否则保留原模块。
4. **超级分组**（`lib/cluster.js:347-356`）：读 `topFanout`（默认 14）。仅当 `llmCall && topModules.length > topFanout && opts.superGroup !== false`：调 `superGroupPrompt(topModules)` → `parseSuperGroups(text, topModules, warnings)`，成功则替换 `topModules`；异常记警告、保留平铺。
5. **定稿**（`lib/cluster.js:359-388`）：`finalize(m, parent)` 递归补 `files`（`moduleFiles`）、`summary`、`parent`，父节点补 `aggregateFiles`；`collect(tree)` 只把叶子节点收进 `articles`。返回 `{ modules: articles, tree, concepts: [], warnings, stats, byId }`。

`subdivide` 递归下钻（`lib/cluster.js:396-422`）：取子集 `m.components` → `subClusterPrompt(m.name, formatComponents(subset), subset.length)` → `parseClusterResponse(text, m.components, warnings)` → `fillMissing`；`kids.length <= 1` 返回 `null`（不可再分）；否则 `stats.levels = max(levels, depth)`；若 `depth >= maxDepth` 直接返回 `kids`，否则对每个仍超 `splitThreshold` 的子模块继续 `subdivide(kid, ..., depth+1, ...)`，递归结果 `>1` 则挂 `children`。异常 → `fallbacks += 1` 返回 `null`。

下游消费：`index.js` 的 `semanticPlan()` 在 `index.js:1393` 调 `clusterComponents({ components, llmCall, signal })`，再用 `toPlanModules(result)`（`index.js:1452`）产出 `job.plan.modules`；`result.tree` 与精简后的符号图一并持久化进 `job.plan`（`index.js:1455-1468`），供 stale 增量按组件粒度判定变更；`result.stats.llm` 决定 `plan.project` 标注是「AST 符号聚类」还是「已降级为目录聚类」（`index.js:1449-1451`）。

## Connections

- [[symbols]] — `lib/symbols.js` 的 `extractRepoGraph` 产出 `components`（id 形如 `path#name`）；聚类只消费其 `{id, relativePath, kind, name, parameters}` 形状，组件形状契约见 `lib/symbols.js:785-786`。`index.js` 的 `semanticPlan` 先提图再聚类（`index.js:1411-1440`）。
- [[codewiki-generate-pipeline]] — `index.js` 的 `semanticPlan`（`index.js:1393`）是调用 `clusterComponents` 的唯一生产入口，产出 `job.plan.modules` 喂给 [[articles-agentic]] / articles 阶段；任何环节失败返回 `fallback=true` 退回 `localPlan`（`index.js:1371`，纯目录分组）。
- [[incremental]] — `result.tree` 与符号图随 `job.plan` 持久化（`index.js:1455-1468`），stale 增量编译（`lib/incremental.js`）按组件粒度（`bodyHash`/签名/依赖）判定哪些模块真变了，而不依赖源码正文。
- [[article-contract]] — `modules[i].files` 即模块文章的 `source_files`；落盘前由 `lib/article-contract.js` 的 `inspectArticle` 校验（死链、source_files 不存在等），见 `index.js:581-594`。
- [[update-planner]] — `lib/update-planner.js` 的 `buildModuleMap` 消费聚类产出的模块图做增量规划与迁移。

## Known Issues

- **`concepts` 始终为空**：`clusterComponents` 返回值里的 `concepts` 永远是 `[]`（`lib/cluster.js:19`、`lib/cluster.js:291`）。跨模块概念抽取不在此模块职责内，由横切阶段（concepts 文章）负责，但调用方 `index.js:1453` 仍原样透传 `result.concepts ?? []`，读者不要误以为聚类会产出概念。
- **下钻阈值与层数旧实现有误，已修**：早期 `subdivide` 内部不再递归，`maxDepth` 只被当成 `>1` 的布尔开关，配 2 与配 3 行为完全相同（都只两层）。当前实现已让 `maxDepth` 真正生效（`lib/cluster.js:394-395`、`lib/cluster.js:396`、`lib/cluster.js:412`），测试 `test-cluster.mjs:269-343` 用 `splitThreshold:2` + 桩模型验证层数可配；改阈值/层数时务必先跑该测试。
- **单顶层目录（`src/`）布局的下探**：`heuristicCluster` 在 `depth=1` 只得到一个组时主动下探 `depth=2`（`lib/cluster.js:219-222`），但下探后仍只有一个组就用原分组——这意味着「整个仓库都在 `src/` 且无二级目录」时仍会得到一个巨型模块，需靠 LLM 下钻或后续 `superGroup` 兜底。
- **超级分组子系统节点 `components` 为空**：`parseSuperGroups` 产出的子系统节点 `components: []`（`lib/cluster.js:425`），自身不写文章，组件全在子模块里。若下游误把 `tree` 顶层节点的 `components` 当模块文章来渲染会拿到空列表——应以 `result.modules`（叶子）为准。
- **`parseJsonLoose` 的抢救有边界**：只识别第一个 `{` 到最后一个 `}`、并仅修尾逗号（`lib/cluster.js:135-141`）。若模型在 JSON 内部错误嵌套了对象、或正文里本身含不成对的 `{}`，可能误切或仍解析失败——此时 `parseClusterResponse` 返回 `null`、整层 `fallbacks += 1` 并降级，组件仍由 `heuristicCluster`/`fillMissing` 兜底不丢。
- **`llmCall` 异常兜底的链**：顶层聚类抛错（`lib/cluster.js:293-296`）、下钻抛错（`lib/cluster.js:417-420`）、超级分组抛错（`lib/cluster.js:359-360`）各自被捕获并记警告，但都不会让整轮失败；最终仍经 `finalize` 产出可用模块树。注意 `call` 包装里把非字符串返回规整为 `String(out?.content ?? '')`（`lib/cluster.js:303`），LLM 桥若返回 `{content}` 对象也能吃下。
