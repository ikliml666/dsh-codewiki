---
title: cluster_planning
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - test-semantic-plan.mjs
  - index.js
tags: [planning, clustering, modules, semantic-plan, ast, fallback]
---

## Overview

`cluster_planning` 是 dsh-codewiki 的**模块规划 / 语义聚类**模块，职责是把「从仓库里抽取出的全部代码组件（函数、类、方法、常量）」按**职责**划分成若干模块（module），产出一份带层级、带源文件清单的模块树，供后续逐模块写文章（`articles` 阶段）使用。它对应上游 FSoft-AI4Code/CodeWiki 的 `cluster_modules.py` + `prompt_template.py`（三段式 `CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT`），但做了本地化改造：纯函数 + 显式层级、用组件数量/目录阈值而非 LLM 嵌套结构决定下钻、组件 id 用 `path#name` 形态（与 `lib/symbols.js` 的约定一致）。

模块核心在 `lib/cluster.js`（467 行，无第三方依赖）。它同时提供：

- **LLM 三段式聚类**：顶层聚类（`clusterPrompt`）→ 超大模块递归下钻（`subClusterPrompt`）→ 顶层过多时超级分组（`superGroupPrompt`），由 `clusterComponents` 串起来。
- **纯本地启发式聚类**（`heuristicCluster`）作为零网络、可测试的降级路径——不传 `llmCall` 时直接按顶层目录分组，永不断链。
- **解析与健壮性层**：`parseJsonLoose`（剥围栏/取对象/修尾逗号）、`parseClusterResponse`（id 校验 + 去重 + 漏组件补齐）、`parseSuperGroups`（子系统归一）。
- **模块 → 源文件清单**（`moduleFiles`）与「规划结果 → 文章任务清单」（`toPlanModules`）两个收口函数。

上游调用在 `index.js`：`buildPlan`（index.js:2730）在 `planMode=auto`（默认）时调用 `semanticPlan`（index.js:1322），后者再调用 `clusterComponents`（index.js:1369）；`planMode=dirs` 或任一环节失败时退回 `localPlan`（index.js:1300，纯顶层目录分组）。`buildPlan` 在全量编译的 `tickArticles` 阶段被调用（index.js:2879–2994），其产出的 `plan.modules[].files` 直接变成本轮要写的模块文章清单（index.js:2998–3008）。

该模块不碰文件系统（除 `path` 处理），不写 wiki；它只消费 `components`（来自 `lib/symbols.js` 的 `extractRepoGraph`），产出内存里的模块树。所有「组件没被分配到任何模块」「模型返回垃圾 JSON」「模型请求抛错」等异常都被吞掉并回落到目录分组，保证流水线不中断。

## Key Components

### `lib/cluster.js` 导出成员（按行号）

- **`formatComponents(components)`** — lib/cluster.js:28–46。把组件按 `relativePath` 分组输出为 LLM 提示词文本：每个文件一行 `# <file><artifactTag>`，其下每行 `\t<id>\t<kind>\t<name>(<签名前6参>)`。只给名字/类型/短签名，不给函数体（聚类看结构不看实现）。

- **`ARTIFACT_RE` / `artifactTag(file)`** — lib/cluster.js:49–51。`ARTIFACT_RE` 是构建/打包/配置类文件名正则（package.json、tsconfig、Cargo.toml、*.yml、Dockerfile 等），命中则在文件头追加 ` (artifact: config)` 提示词标记，引导模型把它们归入专门模块或所配置模块。

- **`clusterPrompt(componentText, totalComponents)`** — lib/cluster.js:57–81。顶层聚类提示词：要求返回 `{modules:[{name,path,summary,components}]}`，强调「每个组件必须且只能出现一次」、组件 id 原样返回、`(artifact: config)` 文件单独处理、模块名用小写下划线、path 用 POSIX 目录。

- **`subClusterPrompt(moduleName, componentText, totalComponents)`** — lib/cluster.js:84–103。下钻提示词：给一个已有的大模块，要求其拆成更小的子模块；若一个模块确实不可再分，允许返回单个同名子模块。

- **`superGroupPrompt(modules)`** — lib/cluster.js:106–129。超级分组提示词：把平铺的顶层模块按架构角色归成更少数量的 `subsystems`，要求每个模块有且仅有一个归属、子系统数量显著少于模块数量。

- **`parseJsonLoose(text)`** — lib/cluster.js:135–153。尽力抢救模型 JSON：剥 ```json 围栏、直接 `JSON.parse`、取第一个 `{` 到最后一个 `}`、再尝试去掉尾随多余逗号后解析。全部失败返回 `null`。

- **`parseClusterResponse(text, validIds, warnings=[])`** — lib/cluster.js:156–195。解析聚类回复：调用 `parseJsonLoose`，校验 `modules`/`groups` 数组；对每个模块做 id 存在性校验（`known` 集合）与去重（`seen` 集合），丢弃不存在/重复的 id 并 push 警告；用 `normalizeModuleName` 规范名、`guessPath` 推断 path；统计 `missing`（漏分配组件）一并返回 `{modules, missing}`。

- **`normalizeModuleName(name)`** — lib/cluster.js:198–206。把模块名洗成文件名友好形态：空白→`_`，非 `[\w\u4e00-\u9fff-]` 字符→`_`，压缩连续下划线、去首尾下划线、`toLowerCase`；空串回落 `'module'`（保留 CJK，见 index.js:1670 的 `slugify` 对多中文目录合并问题的修正思路）。

- **`guessPath(ids)`** — lib/cluster.js:208–212。未给定 path 时按组件 id 的文件目录推断（顶层文件回落 `''`）。

- **`heuristicCluster(components)`** — lib/cluster.js:219–244。本地降级聚类：先按第一层目录分组（`groupBy(1)`）；若只有一组（典型 `src/` 布局会把整仓塞进一个模块）则再按两层分组（`groupBy(2)`）取更有意义的划分。返回 `{name,path,summary,components}[]`。

- **`fillMissing(modules, components, missingIds)`** — lib/cluster.js:247–268。把 `parseClusterResponse` 漏掉的组件按目录挂回最匹配的模块（path 相等或在模块 path 子树下）；无处可归的建一个 `misc` 模块。保证「组件零丢失」不变式。

- **`moduleFiles(componentIds, byId)`** — lib/cluster.js:274–281。汇总某模块组件涉及的全部源文件（去重排序），写入文章 frontmatter 的 `source_files`。

- **常量 `DEFAULT_MAX_DEPTH` / `DEFAULT_SPLIT_THRESHOLD` / `DEFAULT_TOP_FANOUT`** — lib/cluster.js:289–289。`2` / `60`（组件数超 60 才下钻） / `14`（顶层超 14 个才超级分组）。

- **`clusterComponents(opts)`** — lib/cluster.js:291–389。主入口。详见下方「主流程」。返回 `{modules, tree, concepts, warnings, stats, byId}`：`modules` 是叶子模块清单（文章只写叶子），`tree` 是完整层级树（父节点仅作导航容器），`stats` 含 `requests/llm/levels/fallbacks`。

- **`subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)`** — lib/cluster.js:396–422。对单个大模块下钻一层（递归条件见下）。子模块仍 ≥ 阈值且未到 `maxDepth` 才继续递归；下钻后只有 ≤1 个子模块视为「不可再分」返回 `null`，保留原模块。

- **`parseSuperGroups(text, modules, warnings=[])`** — lib/cluster.js:425–456。超级分组结果归一：解析 `subsystems`/`groups`，按 `byName` 映射回真实模块，未归组的模块直接留在顶层（`rest`），不因引用了不存在的模块名而丢失。

- **`toPlanModules(result)`** — lib/cluster.js:460–467。把 `clusterComponents` 结果转成 `index.js` 文章阶段吃的任务清单形状 `{name, summary, files, parent?}`，实现 `lib/cluster.js` 与 `index.js` job.plan.modules 的形状对齐。

### `index.js` 相关成员（规划调度侧）

- **`scanRepoFiles(cwd)`** — index.js:2121–2144。仓库源码扫描：黑名单目录（`.git/.codewiki/node_modules/vendor/dist/...`）、二进制后缀、单文件 256KB、总数 2000 上限。返回 `{path, bytes}[]`，是 `localPlan` 与 `semanticPlan` 的输入。

- **`localPlan(files)`** — index.js:1300–1313。目录分组规划：按 `path.split('/')[0]` 顶层目录分组，用 `slugify`（index.js:1670）规范化名，返回 `{project, modules:[{name,summary,files}], concepts}`。`project` 文案固定为「（本地规划：按顶层目录分组）」。

- **`semanticPlan(files, {...})`** — index.js:1322–1405。语义规划编排：先用 `extractRepoGraph`（lib/symbols.js）做 AST 符号提取得 `components`，再 `resolveImportEdges` 建依赖边（`graph`/`edges` 随 plan 持久化但不带 `sourceCode`），最后调 `clusterComponents`。任何环节失败（extractor 不可用 / 无组件 / 聚类抛错 / 空计划）都返回 `{plan:null, fallback:true, reason}`，由 `buildPlan` 退回 `localPlan`。`plan.project` 文案区分「AST 符号聚类」与「降级为目录聚类」。

- **`buildPlan(job, files)`** — index.js:2730–2753。规划调度：若 `planMode=dirs` 直接 `localPlan`；否则 `semanticPlan`，成功用其 plan，失败（`r.plan===null`）退回 `localPlan`，两种结果都记 note 标明本次走的路径与统计（组件数/请求数/降级次数/耗时）。

## Architecture

### 主流程：`clusterComponents`（lib/cluster.js:291–389）

```text
components[] ──► formatComponents() ──► clusterPrompt() ──► llmCall() ──► parseClusterResponse()
                                                                          │
                                          parseClusterResponse 缺 modules ──► 降级: stats.fallbacks++
                                          llmCall 未传/抛错 ──────────────► heuristicCluster() 兜底
                                                                          ▼
                                          fillMissing(漏组件挂回/建 misc) ◄── parsed.missing
                                                                          ▼
                       topModules（第一层；若组件数≥splitThreshold 且 maxDepth>1 且 llmCall 存在：）
                                                                          ▼
                         对每个大模块 subdivide() 递归下钻（depth 从 2 起，到 maxDepth 止）
                                                                          ▼
                       topModules.length > topFanout 且 superGroup≠false ──► superGroupPrompt() ──► parseSuperGroups()
                                                                          ▼
                          finalize() 补 files/aggregateFiles/parent，collect() 收叶子 ──► {modules, tree, stats}
                                                                          ▼
                          toPlanModules() ──► job.plan.modules { name, summary, files, parent? }
```

- **层级与下钻语义**：`maxDepth` 是总层数上限（`1`=只做顶层；`2`=允许一层子模块；`3`=允许孙模块）。早期实现把 `maxDepth` 只当 `>1` 的布尔开关，配 2/3 行为一致；现版本 `subdivide`（lib/cluster.js:396）在 `depth>=maxDepth` 时停止递归（`test-cluster.mjs:270–343` 专门验证 `maxDepth=2` vs `maxDepth=3` 的差异）。下钻递归条件：`kids.length>1` 且子模块仍 `>=splitThreshold`（60）且 `depth<maxDepth`，父模块保留为仅导航容器（`children`），不单独成文。

- **「组件零丢失」不变式**：`parseClusterResponse`（lib/cluster.js:156）统计 `missing`，`fillMissing`（lib/cluster.js:247）把漏掉的组件按目录挂回最相近模块或建 `misc`；即使 LLM 全挂、`heuristicCluster` 接管，所有组件也仍被分到某个模块（test-cluster.mjs:141–159、188–199）。

- **父节点不单独成文**：`finalize`（lib/cluster.js:359–375）给有 `children` 的父节点补 `aggregateFiles`（子模块文件并集），方便导航但不在 `articles` 清单里出现——`collect`（lib/cluster.js:380–386）只把叶子节点 push 进 `articles`。

## Data Flow

### 上游输入与下游消费

```text
 lib/symbols.js                       index.js (编排)
 extractRepoGraph()                   buildPlan()  ──► semanticPlan() ──► clusterComponents()
   │  components[] (id=path#name)          │  scanRepoFiles() 给 localPlan
   ▼                                      ▼
 clusterComponents (lib/cluster.js)  ──► toPlanModules() ──► job.plan.modules[].files
                                                              │
                                                              ▼
                                                tickArticles(): 每模块 → modules/<slug>.md 写作任务
```

- 输入 `components` 由 [[symbols-extraction]]（`lib/symbols.js` 的 `extractRepoGraph`）产出，id 约定 `<相对路径>#<符号名>`、方法为 `#<类名>.<方法名>`（lib/symbols.js:785–14）。`clusterComponents` 不读文件，只消费已在内存中的组件对象。
- 输出 `toPlanModules()` 的形状（`{name, summary, files, parent?}`）与 [[index-orchestration]] 的 job.plan.modules 严格对齐；`tickArticles`（index.js:2879–3008）据此生成 `modules/<slug>.md` 写作任务，slug 用 index.js:1381 的 `slugify`。
- `stats`（lib/cluster.js:295）里的 `llm`/`requests`/`fallbacks`/`levels` 被 [[semantic-plan|semanticPlan]] 透传进 `plan.stats`，面板/日志据此显示「AST 符号聚类：N 组件、M 次请求、K 次降级、S 秒」（index.js:2747）。
- 降级路径 `localPlan`（index.js:1300）与 `heuristicCluster`（lib/cluster.js:219）语义等价：都按顶层目录分组，区别在于前者吃 `files`（无符号），后者吃 `components`（有符号、可下探两层）。

## Connections

## Known Issues

- **`concepts` 恒为空**：`clusterComponents` 的契约（lib/cluster.js:18–20）声明返回 `concepts: []`，实际所有路径都 `return { ... concepts: [] }`（lib/cluster.js:300、388），`semanticPlan` 也仅透传 `result.concepts ?? []`（index.js:1322）。LLM 即使返回了 `concepts` 字段（test-semantic-plan.mjs:95 的假模型就带了 `concepts:['请求生命周期']`），`parseClusterResponse`（lib/cluster.js:156）只会读 `modules`/`groups`，`concepts` 被整体丢弃。概念文章（`concepts/*.md`）目前完全依赖横切合成阶段，不来自规划。

- **`project` 文案不含 `reason`**：`semanticPlan` 在 `extractor-unavailable`/`extract-failed`/`no-components`/`cluster-failed`/`empty-plan` 时返回 `{plan:null, fallback:true, reason}`（index.js:1322–1403），但 `buildPlan`（index.js:2730）退回 `localPlan` 时只记 `planMode` 无关的「语义规划不可用 ${r.reason}」note，未把 reason 单独落进 plan 字段；跨 `planMode` 边界排查降级来源只能看 notes 而非结构化字段。

- **`superGroup` 阈值与 `maxDepth` 是默认值而非配置项**：`DEFAULT_TOP_FANOUT=14`、`DEFAULT_MAX_DEPTH=2`、`DEFAULT_SPLIT_THRESHOLD=60`（lib/cluster.js:329–289）都是模块内常量，`clusterComponents` 仅允许通过 `opts`（`maxDepth`/`splitThreshold`/`topFanout`/`superGroup`）覆盖。`index.js` 调用时（semanticPlan，index.js:4656）未传这些 opts，故全量编译一律使用默认值；想调阈值需改 `lib/cluster.js` 或补 `semanticPlan` 的透传。

- **`parseSuperGroups` 的子系统 `path` 固定为空串**：lib/cluster.js:446 子系统节点 `path: ''`，其 `files` 也不单独计算——子系统只是导航容器，真正的 `source_files` 来自其 `children`（叶子模块）。若将来想给子系统 level 也出文章，需要补 path/files 推导。

- **`heuristicCluster` 对顶层 `src/` 单目录布局只下探一层**：lib/cluster.js:219–237，当一层分组只有一组时才尝试两层；若真实代码是 `src/a/x.js` + `src/a/y.js`（第二层仍只有一组），两层分组依旧一组，会退回单模块「src」——此时本地降级比 LLM 聚类粗糙，但「组件零丢失」不变式仍成立。

- **无 `disabled`/注释掉的功能**：模块内无被注释禁用的代码路径；三段式提示词与下钻/超级分组逻辑均为活跃实现。`Config.planMode` 在 index.js:86/131 可切 `dirs`（完全绕过本模块），这是配置开关而非代码禁用。
