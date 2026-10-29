---
title: test_clustering
type: module
source_files:
  - test-cluster.mjs
  - test-semantic-plan.mjs
  - lib/cluster.js
  - index.js
tags: [test, clustering, semantic-plan, module-planning]
---

## Overview

`test_clustering` 模块由两份独立测试脚本组成，专门验证 dsh-codewiki 的**模块聚类**（clustering）与**语义规划**（semantic planning）链路——即把仓库里的 AST 组件划分成「按职责而非按目录」的模块树，再交给后续的文章写作阶段。

- `test-cluster.mjs`：直接单元测试 `lib/cluster.js` 的纯函数与三层聚类主流程（顶层聚类 → 下钻 → 超级分组），通过注入假的 `llmCall` 驱动模型，不碰网络。覆盖 LLM 正常路径、各类降级（缺模型 / 抛错 / 垃圾文本）、下钻阈值与 `maxDepth` 递归深度、超级分组。
- `test-semantic-plan.mjs`：端到端测试 `index.js` 的 `semanticPlan` / `localPlan` / `scanRepoFiles`——在临时目录里造一个「目录划分与职责划分不一致」的真实仓库，跑 AST 提取 → 聚类 → 模块清单全链路；三个场景：① 有模型走 LLM 聚类；② 无模型降级目录聚类；③ tree-sitter 不可用退回 `localPlan`。

两份测试都使用 `node:assert/strict`，并各自实现一个轻量 `check(label, fn)` 封装（`test-cluster.mjs:13`、`test-semantic-plan.mjs:11`）来累加 `pass`/`fails` 与彩色输出，最后在 `process.exit` 前打印通过/失败计数。它们是零网络的纯函数/本地文件测试，可独立用 `node test-cluster.mjs` / `node test-semantic-plan.mjs` 运行。

被测试的生产代码集中在 `lib/cluster.js`（全部聚类逻辑）与 `index.js` 的规划入口（`semanticPlan` 在 `index.js:1412`、`localPlan` 在 `index.js:1372`、`scanRepoFiles` 在 `index.js:2074`、`buildPlan` 在 `index.js:2874` 调用二者）。

## Key Components

两个测试文件本身都是「可执行的 `node` 脚本」，没有模块导出；它们内部定义的辅助函数如下。

### test-cluster.mjs（单元测试 `lib/cluster.js`）

- `makeComponents()` — `test-cluster.mjs:25`：造一个像真仓库的组件集：6 个 `src/auth/login.js#loginN`、5 个 `src/auth/token.js#tokenN`、7 个 `src/wiki/compile.js#compileN`、4 个 `src/panel/ui.js#renderN`、1 个 `package.json#scripts`（kind `const`）、1 个 `README.md#docs`（kind `const`）、以及 70 个 `src/big/engine.js#engineN`（用于触发下钻阈值）。返回组件数组，每个组件形态为 `{ id: 'file#name', name, kind, relativePath, parameters: ['a'], sourceCode, dependsOn: [] }`。
- `makeDeepComponents()` — `test-cluster.mjs:274`：造 72 个 `src/deep/a.js#deepN` + 3 个 `src/other/x.js#otherN`，专门验证多层递归下钻（72 = 3×4×6）。
- `deepLlm(pool)` — `test-cluster.mjs:286`：桩模型工厂。顶层请求返回 `deep` + `other` 两个模块；任意下钻请求把传入的 id 按出现顺序拆成两半（`_a` / `_b`），名字加后缀区分层。用于验证 `maxDepth` 真的生效。
- `check(label, fn)` — `test-cluster.mjs:13`：断言封装，跑 `fn()`，成功 `pass++` 并打 `PASS`，失败把 `{label, err}` 推入 `fails` 打 `FAIL`。

从 `lib/cluster.js` 导入并测试的公开符号：`clusterComponents`、`heuristicCluster`、`fillMissing`、`moduleFiles`、`formatComponents`、`clusterPrompt`、`subClusterPrompt`、`superGroupPrompt`、`parseJsonLoose`、`parseClusterResponse`、`parseSuperGroups`、`normalizeModuleName`、`toPlanModules`（见 `test-cluster.mjs:4-9`）。

### test-semantic-plan.mjs（端到端测试 `semanticPlan` / `localPlan` / `scanRepoFiles`）

- `files` 对象 — `test-semantic-plan.mjs:21`：一个「目录划分与职责划分不一致」的仓库内容：`src/billing/invoice.js`（含类 `Invoice`）、`src/billing/routes.js`（混进 HTTP 路由）、`src/api/tx.js`（混进 DB 事务）、`src/api/handlers.js`、`src/util/strings.js`、`README.md`。用以验证语义聚类会把 billing 逻辑归到 billing、HTTP 归到 api，而非照搬目录。
- `parseIds(prompt)` — `test-semantic-plan.mjs:74`：从 `formatComponents` 输出的 TAB 行里抽出 `id`（取 `\t` 后的第一段）。桩模型用它从 prompt 还原组件全集。
- `fakeLlm`（多处，如 `test-semantic-plan.mjs:83`、`116`、`132`）：向 `semanticPlan` 注入的假模型，按 `llm.stream()` 异步生成器协议产出 `block-start` / `text-delta` / `block-end` / `finish` 四类 SSE 风格事件。分别模拟「正常 JSON」「坏 JSON」「请求抛错」三种情形。
- `check(label, fn)` — `test-semantic-plan.mjs:11`：同上的断言封装。

从 `index.js` 导入并测试的公开符号：`semanticPlan`、`localPlan`、`scanRepoFiles`（见 `test-semantic-plan.mjs:7`）。

### 被测试的 `lib/cluster.js` 组件（行号取自 `lib/cluster.js`）

- `formatComponents(components)` — `lib/cluster.js:28-46`：按文件分组把组件渲染成提示词文本；每行 `TAB id TAB kind TAB name(sig)`。会调用 `artifactTag` 给 `package.json` 等配置文件标 `(artifact: config)`。
- `ARTIFACT_RE` / `artifactTag(file)` — `lib/cluster.js:48-51`：正则识别构建/配置类文件（package.json、*.toml、*.ya?ml 等）。
- `clusterPrompt(text, total)` — `lib/cluster.js:57-81`：顶层聚类提示词（对应上游 `CLUSTER_REPO_PROMPT`），要求返回 `{modules:[{name,path,summary,components}]}` 且 id 原样返回。
- `subClusterPrompt(name, text, total)` — `lib/cluster.js:84-103`：下钻提示词（对应 `CLUSTER_MODULE_PROMPT`），要求把单个大模块拆成子模块。
- `superGroupPrompt(modules)` — `lib/cluster.js:106-129`：超级分组提示词（对应 `SUPER_GROUP_PROMPT`），把平铺模块归成架构子系统。
- `parseJsonLoose(text)` — `lib/cluster.js:135-153`：尽力抢救模型输出（剥 ```` ```json ```` 围栏、取首尾 `{}`、修尾逗号），救不回返回 `null`。
- `parseClusterResponse(text, validIds, warnings=[])` — `lib/cluster.js:156-195`：解析聚类响应并做 id 校验 + 去重；丢弃不存在的 id（记 warning）、丢弃重复分配的组件（记 `重复` warning）、模块名经 `normalizeModuleName` 规范化；返回 `{modules, missing}` 或缺字段时 `null`（记 warning）。`missing` 是 `validIds` 里没被任何模块收编的 id。
- `normalizeModuleName(name)` — `lib/cluster.js:198-206`：把模块名规范成文件名友好形式（空格→`_`、非 `\w`/中文/`_` 字符→`_`，小写下限为 `module`）。
- `guessPath(ids)` — `lib/cluster.js:208-212`：从组件 id 推断 path（取首个 id 的文件目录）。
- `heuristicCluster(components)` — `lib/cluster.js:219-244`：无 LLM 时的降级聚类，按顶层目录分组；单顶层目录（如只有 `src/`）会下探一层多给几个模块。返回的模块形态 `{name, path, summary, components}`。
- `fillMissing(modules, components, missingIds)` — `lib/cluster.js:247-268`：把 LLM 漏掉的组件按目录补回最相近的模块；无处归属时新建 `misc` 模块。
- `moduleFiles(componentIds, byId)` — `lib/cluster.js:274-281`：从组件 id 汇总去重的源文件清单（文章 frontmatter 的 source_files 来源）。
- `DEFAULT_MAX_DEPTH=2` / `DEFAULT_SPLIT_THRESHOLD=60` / `DEFAULT_TOP_FANOUT=14` — `lib/cluster.js:287-289`：`clusterComponents` 的默认阈值常量。
- `clusterComponents(opts)` — `lib/cluster.js:291-389`：主入口。签名 `clusterComponents({ components, llmCall, splitThreshold, maxDepth, topFanout, superGroup })`。返回对象：
  - `modules`：叶子模块清单（带 `name/summary/files/components/parent?`），父节点不单独成文。
  - `tree`：含 `children` 的模块树，`aggregateFiles` 汇总子模块文件。
  - `concepts`：`[]`（占位）。
  - `warnings`：字符串数组。
  - `stats`：`{ requests, llm: bool, levels, fallbacks }`——测试大量断言 `stats.llm`、`stats.fallbacks`、`stats.levels`。
  - `byId`：`Map<id, component>`。
  - 空组件集返回 `{ modules: [], concepts: [], warnings: ['没有可聚类的组件'], stats }`（`lib/cluster.js:299-301`）。
- `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` — `lib/cluster.js:396-422`：对单个大模块下钻一层；返回子模块数组或 `null`（失败/不可再分）。`stats.levels = Math.max(stats.levels, depth)`。
- `parseSuperGroups(text, modules, warnings=[])` — `lib/cluster.js:425-456`：解析超级分组响应，把未被任何子系统收走的模块留在顶层；忽略不存在的模块名（记 warning）。
- `toPlanModules(result)` — `lib/cluster.js:460-467`：把 `clusterComponents` 结果转成插件 articles 阶段吃的任务清单 `{name, summary, files, parent?}`。

### 被测试的 `index.js` 规划入口（行号取自 `index.js`）

- `scanRepoFiles(cwd)` — `index.js:2074-2097`：仓库源码扫描，受 `SCAN_SKIP_DIRS`（`.git`/`node_modules`/`dist` 等，`index.js:2061`）、`SCAN_SKIP_EXT`（二进制后缀，`index.js:2065`）、`SCAN_MAX_FILE_BYTES=256KB`（`index.js:2060`）、`SCAN_MAX_FILES=2000`（`index.js:2213`）约束。返回 `{path, bytes}[]`，不读正文。
- `semanticPlan(files, {cwd, llm, provider, model, reasoningEffort, signal, notes})` — `index.js:1412-1495`：语义规划主入口。读正文 → `extractRepoGraph` 抽符号（不可用则 `fallback:true`，`index.js:1434/1440`）→ `resolveImportEdges` 建依赖边 → `clusterComponents`（注入 `llmCall` 把 `llm.stream` 适配成 `async (prompt)=>string`，`index.js:1060-1065`）→ 组装 `plan`。`plan` 形态：`{ project, modules, concepts, tree, graph:{components,edges}, stats }`；`graph.components` **不含 `sourceCode`**（见 `index.js:1475-1476` 注释）。任一环节失败返回 `{ plan:null, fallback:true, reason }`。
- `localPlan(files)` — `index.js:1372-1385`：按顶层目录分组的本地规划（降级路径），返回 `{ project, modules, concepts:[] }`，`modules:[{name, summary, files}]`。目录名经 `slugify`。
- `slugify(name)` — `index.js:1660-1662`：保留 CJK 字符的 slug 化（中文目录名直接作模块 slug，避免塌缩成 `module`）。
- `shouldFallBackFromAgentic(results)` — `index.js:1390-1395`：agentic 通道退回判定（失败过半才算系统性失败），模块级导出便于单测。
- `buildPlan(job, files)` — `index.js:2874-2897`：编排服务里调用二者的上层函数；`planMode==='dirs'` 直接 `localPlan`，否则 `semanticPlan`，失败退回 `localPlan`，并记 note 说明本次用哪条路径。

## Architecture

两个测试各自覆盖了 `lib/cluster.js` 的三段式聚类流程与 `index.js` 的规划编排，核心组件与关系如下（`<=20` 行）：

```text
test-cluster.mjs ──导入/单测──► lib/cluster.js
                                  ┌─────────────────────────────────┐
  clusterComponents(opts) ────────►│ 1. 顶层聚类 (clusterPrompt)     │
  (主入口, 291-389)                │    ├─ llmCall? → parseClusterRsp│
                                   │    └─ 无 → heuristicCluster     │
                                   │ 2. 下钻 (subdivide, 396-422)    │
                                   │    ├─ 超 splitThreshold 且      │
                                   │    │   maxDepth>1 → 递归 subClus│
                                   │    └─ fillMissing 补漏          │
                                   │ 3. 超级分组 (superGroupPrompt)  │
                                   │    超 topFanout 时归子系统      │
                                   │ finalize → tree + articles     │
                                   │ toPlanModules → 任务清单        │
                                   └─────────────────────────────────┘

test-semantic-plan.mjs ──导入/端到端──► index.js
  semanticPlan(files, opts) ──► extractRepoGraph ──► resolveImportEdges
                                    │
                                    └─► clusterComponents (llmCall 来自 llm.stream 适配)
  localPlan(files) ◄── 降级路径（planMode=dirs 或失败）── buildPlan(job,files)
  scanRepoFiles(cwd) ──► 产出 {path,bytes}[] 喂给上面二者
```

测试对框图的覆盖重点：
- `test-cluster.mjs` 用注入的 `llmCall` 模拟第 1/2/3 层（顶层、`big` 下钻、`core/ui` 超级分组）；
- `test-semantic-plan.mjs` 用临时仓库 + 注入的 `fakeLlm` 跑完整的 `scanRepoFiles → semanticPlan → plan.modules` 链路，并验证坏 JSON / 请求抛错时退回到目录聚类（即上面的 `localPlan` 分支）。

## Data Flow

### test-cluster.mjs 的数据流（纯函数 / 注入 `llmCall`）

1. **提示词单元**：`formatComponents` → 断言其按文件分组、标 `artifact`（`test-cluster.mjs:51`）；`clusterPrompt` 必须含「共 N 个组件」与「必须原样返回」（`test-cluster.mjs:44`）；`subClusterPrompt` / `superGroupPrompt` 结构完整（`test-cluster.mjs:57`）。
2. **JSON 抢救**：`parseJsonLoose` 剥围栏 / 取前后废话里的对象 / 修尾逗号 / 无 JSON 返回 `null`（`test-cluster.mjs:65-82`）。
3. **响应解析**：`parseClusterResponse` 丢弃不存在 id（记 warning）、去重复分配（空模块被丢，记 `重复`）、缺 `modules` 返回 `null`（`test-cluster.mjs:85-111`）；`normalizeModuleName` 处理空格与特殊字符（`test-cluster.mjs:113-118`）。
4. **启发式聚类**：`heuristicCluster` 按顶层目录分组，含 `src` 与 `root`（`test-cluster.mjs:121-128`）；`fillMissing` 把漏掉的组件挂回同目录模块，无处归属建 `misc`（`test-cluster.mjs:130-144`）；`moduleFiles` 汇总去重源文件（`test-cluster.mjs:146-150`）。
5. **降级**：无 `llmCall` 走目录启发式，组件不丢（`test-cluster.mjs:153-159`）；空组件集返回空结果不抛错（`test-cluster.mjs:161-165`）。
6. **LLM 正常路径**：注入返回合法分组的 `llmCall`，断言 `stats.llm===true`、命名与文件清单正确、组件全集覆盖（`test-cluster.mjs:168-186`）。
7. **LLM 兜底**：漏组件由 `fillMissing` 补齐（`test-cluster.mjs:188-199`）；`llmCall` 抛错或返回垃圾文本整体降级目录分组，`stats.fallbacks>=1`，组件不丢（`test-cluster.mjs:201-216`）。
8. **下钻**：`splitThreshold` 触发单大模块下钻成 `big_core`/`big_ext`，父节点 `big` 不单独成文，`tree` 里挂 `children`（`test-cluster.mjs:219-250`）；下钻只返回一个子模块视为不可再分（`test-cluster.mjs:252-267`）；`maxDepth=2` 只下钻一层、`maxDepth=3` 出现孙模块（`test-cluster.mjs:313-343`）；下钻抛错不影响整体（`test-cluster.mjs:345-359`）。
9. **超级分组**：`topFanout` 触发把顶层归成 `core`/`ui` 子系统，`tree` 父节点带 `children`（`test-cluster.mjs:362-387`）；`parseSuperGroups` 未归类模块保留在顶层、忽略不存在模块名（`test-cluster.mjs:389-402`）。
10. **plan 转换**：`toPlanModules` 输出 `{name, summary, files}` 任务清单形状（`test-cluster.mjs:405-414`）。

### test-semantic-plan.mjs 的数据流（临时仓库 → 端到端）

1. 在 `os.tmpdir()` 建 `cwplan-*` 临时目录，写入 `files` 里 6 个源文件（`test-semantic-plan.mjs:20-33`）。
2. `scanRepoFiles(tmp)` 扫出源文件清单（`test-semantic-plan.mjs:35`），喂给 `semanticPlan`。
3. **场景①无模型**：`llm:null` → `semanticPlan` 内部 `clusterComponents` 无 `llmCall` → 目录启发式；断言 `r.fallback===false`、`r.plan.stats.llm===false`、`r.plan.project` 含「降级」、组件数 >0（`test-semantic-plan.mjs:38-50`）。
4. **模块完整性**：每个模块 `files` 非空且文件真实存在（`test-semantic-plan.mjs:52-58`）；模块文件并集 = 全部有符号源文件、`README.md` 不进任何模块（`test-semantic-plan.mjs:60-69`）。
5. **场景②有模型**：注入 `fakeLlm`（按 `formatComponents` 的 TAB 行切 `billing`/`apiruntime`），断言 `stats.llm===true`、`billing` 的文件全在 `src/billing/`（`test-semantic-plan.mjs:71-112`）。
6. **降级保活**：坏 JSON（`test-semantic-plan.mjs:114-128`）与请求抛错（`test-semantic-plan.mjs:130-140`）时 `fallback===false` 但仍产出模块、`stats.fallbacks>=1`。
7. **空仓库**：空清单传入 `semanticPlan` 返回 `fallback===true`（`test-semantic-plan.mjs:142-149`）。
8. **graph 体检**：`plan.graph` 含组件与边、可 JSON 往返、组件**不带 `sourceCode`**、判变更必需字段（`dependsOn`/`parameters`/`relativePath`）还在、序列化体积 < 400KB（`test-semantic-plan.mjs:151-172`）。
9. **localPlan 保活**：`localPlan(scanned)` 仍可用，project 文案含「顶层目录分组」（`test-semantic-plan.mjs:174-178`）。
10. **slug 不冲突**：模块名 slugify 后无重复（`test-semantic-plan.mjs:180-184`）。

## Connections

- [[lib/cluster]] — 被 `test-cluster.mjs` 直接单测的聚类库（`clusterComponents` 三段式 + 全部解析/启发式辅助函数）。
- [[index]] — `semanticPlan` / `localPlan` / `scanRepoFiles` / `buildPlan` 的定义所在；`test-semantic-plan.mjs` 端到端验证这条规划入口。
- [[symbols]] — `lib/symbols.js` 的 `extractRepoGraph` / `resolveImportEdges`，是 `semanticPlan` 的符号提取与建边来源（`index.js:1412`、`index.js:1448`）。
- [[incremental]] — `lib/incremental.js` 的 `slimGraph` / `graphFromSnapshot`，注释里点明判变更只用 `bodyHash`/`签名`/`依赖`，所以 `plan.graph` 不带 `sourceCode`（`index.js:1475-1477`）。
- [[update-planner]] — `lib/update-planner.js` 的 `planUpdate`，stale 增量用 `semanticPlan` 产出的 `plan.tree`/`plan.graph` 做组件级判定。

## Known Issues

- **`maxDepth` 曾是布尔开关**：旧实现只对顶层做一次 `for`、且 `subdivide` 内部不再递归，`maxDepth` 仅被当成 `>1` 判断，配 2 与配 3 行为完全一致（都是两层）。`test-cluster.mjs:269-272` 的注释与 `maxDepth=2`/`maxDepth=3` 两个用例（`test-cluster.mjs:313-343`）正是为锁住「层数可配」这个修复；同理 `lib/cluster.js:394-395` 注释记录了该回归。
- **父节点不单独成文**：下钻/超级分组后，父节点只在 `tree` 里作导航容器（`children`），叶子节点才进 `modules` 清单（`lib/cluster.js:169`、`lib/cluster.js:376`）。测试 `test-cluster.mjs:245` 显式断言下钻后 `big` 不应出现在 `modules` 名称里。
- **空组件集 / 空仓库返回 fallback**：`clusterComponents` 空输入返回 `{modules:[], warnings:['没有可聚类的组件'], stats}`（`lib/cluster.js:291-301`）；`semanticPlan` 拿到空文件清单时 `fallback===true`（`test-semantic-plan.mjs:142-149`）。两条都是「降级而非崩溃」的契约。
- **plan 不带源码的体积防线**：`plan.graph.components` 刻意剥掉 `sourceCode`，只留 `id/name/kind/relativePath/parameters/baseClasses/dependsOn/docstring`（`index.js:1478-1487`）。`test-semantic-plan.mjs:162-172` 用「序列化体积 < 400_000 字节」守这道防线，防止回归时又把源码整包塞回 `JOBS_FILE`。
- **无 LLM 时 `stats.llm=false` 必须如实标注**：`semanticPlan` 在无模型时走目录启发式，`plan.project` 必须含「降级」字样（`test-semantic-plan.mjs:44-46`、`index.js:1466-1470`），否则调用方（`buildPlan`/`tickArticles`）无法从文案区分「语义规划」与「目录降级」。
- **非禁用项**：本模块两份测试均为启用状态，没有注释掉或 disabled 的用例；所有断言路径都随 `node` 正常执行（结尾 `process.exit(fails.length ? 1 : 0)`，`test-cluster.mjs:417-420`、`test-semantic-plan.mjs:187-189`）。
