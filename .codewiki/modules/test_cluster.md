---
title: test_cluster
type: module
source_files:
  - test-cluster.mjs
  - test-semantic-plan.mjs
  - lib/cluster.js
  - index.js
tags: [test, clustering, semantic-planning, fallback]
---

## Overview

`test_cluster` 是 `lib/cluster.js`（LLM 驱动的组件聚类）与 `index.js` 的 `semanticPlan` / `localPlan` / `scanRepoFiles`（端到端语义规划）这两套能力的测试套件，由两个独立脚本组成：

- `test-cluster.mjs`：纯单元测试，直接 import `lib/cluster.js` 的导出，用注入式 `llmCall`（`async (prompt) => string`）模拟模型，**完全不碰网络**。覆盖三段式聚类的每一环（顶层聚类 / 下钻 / 超级分组）与全部降级路径（无 LLM、垃圾回复、抛错、空组件集）。
- `test-semantic-plan.mjs`：端到端测试，调用 `index.js` 的 `semanticPlan` / `localPlan` / `scanRepoFiles`。它在临时目录里造一个「目录划分与职责划分不一致」的样例仓库（如 `src/billing/` 里混了 HTTP 路由、`src/api/` 里混了数据库事务），验证语义聚类能按职责而非目录归并，并验证 `plan.graph` 不携带源码、可序列化、模块名 slug 不冲突。

两个脚本共用同一套微型测试框架：`check(label, fn)`（`test-cluster.mjs:13` 与 `test-semantic-plan.mjs:11`）累加 `pass` 并在末尾打印 `N passed, M failed`，非零失败则 `process.exit(1)`。

聚类逻辑本身在 `lib/cluster.js`：把 AST 提取出的「组件」（形如 `path#name` 的 id，见 `lib/cluster.js:28` 的 `formatComponents`）交给模型分成模块，超大模块递归下钻，顶层过多时超级分组。对照上游 FSoft-AI4Code/CodeWiki 的 `cluster_modules.py` + 三段 prompt（`lib/cluster.js:1`）。

## Key Components

### test-cluster.mjs（纯函数/聚类单元测试）

`makeComponents()`（`test-cluster.mjs:25`）：构造一组仿真组件集——`src/auth/`、`src/wiki/`、`src/panel/` 各若干函数，加 `package.json`/`README.md` 两个 artifact，`src/big/engine.js` 塞 70 个 `engine*` 故意触发下钻。每个组件形状为 `{ id: 'file#name', name, kind, relativePath, parameters: ['a'], sourceCode, dependsOn: [] }`（`test-cluster.mjs:27`）。

导出的被测函数（全部来自 `lib/cluster.js`，经 `test-cluster.mjs:4` import）：

- `clusterComponents({ components, llmCall, splitThreshold, maxDepth, topFanout, superGroup })`（`lib/cluster.js:291`）：主入口，返回 `{ modules, tree, concepts, warnings, stats, byId }`。`stats` 含 `requests / llm / levels / fallbacks`。
- `heuristicCluster(components)`（`lib/cluster.js:219`）：无 LLM 时的目录启发式，按顶层目录（极常见 `src/` 时下探一层）分组。
- `fillMissing(modules, components, missingIds)`（`lib/cluster.js:247`）：把 LLM 漏掉的组件按目录补回最相近模块，无处归属则建 `misc`。
- `moduleFiles(componentIds, byId)`（`lib/cluster.js:274`）：汇总去重的源文件清单。
- `formatComponents(components)`（`lib/cluster.js:28`）：按文件分组、标 `(artifact: config)` 的提示词文本。
- `clusterPrompt / subClusterPrompt / superGroupPrompt`（`lib/cluster.js:57` / `:84` / `:106`）：三段提示词模板。
- `parseJsonLoose(text)`（`lib/cluster.js:135`）：剥围栏 / 取首尾废话里的对象 / 修尾逗号。
- `parseClusterResponse(text, validIds, warnings)`（`lib/cluster.js:156`）：校验 id、去重、规范化模块名，返回 `{ modules, missing }` 或 `null`。
- `parseSuperGroups(text, modules, warnings)`（`lib/cluster.js:425`）：把子系统映射成带 `children` 的顶层列表，未归类模块保留在顶层。
- `normalizeModuleName(name)`（`lib/cluster.js:198`）：把模块名清理成文件名友好形式（小写、非 `\w\u4e00-\u9fff-` 转 `_`）。
- `toPlanModules(result)`（`lib/cluster.js:460`）：把 `clusterComponents` 结果转成 `{ name, summary, files, parent? }` 的任务清单形状。

被这些测试钉住的关键行为：

- 提示词含全部 id 与数量声明（`test-cluster.mjs:44`）、`formatComponents` 按文件分组并标 artifact（`test-cluster.mjs:51`）。
- `parseJsonLoose` 剥围栏 / 取对象 / 修尾逗号 / 无 JSON 返回 `null`（`test-cluster.mjs:65-82`）。
- `parseClusterResponse` 丢弃不存在的 id 并记警告、去重复分配（空模块被丢弃）、缺 `modules` 返回 `null`（`test-cluster.mjs:85-111`）。
- `normalizeModuleName` 处理空格、特殊字符、空串回落 `module`、保留中文（`test-cluster.mjs:113-118`）。
- `heuristicCluster` 按顶层目录分组，`fillMissing` 挂同目录模块 / 无处归属建 `misc`，`moduleFiles` 去重（`test-cluster.mjs:121-150`）。

降级与正常路径（`test-cluster.mjs:152-216`）：

- 无 `llmCall` 走目录启发式且组件不丢、空组件集返回空结果不抛错（`test-cluster.mjs:153`、`:161`）。
- LLM 合法分组按职责成模块、`llmCall` 漏组件由 `fillMissing` 补齐、LLM 抛错 / 返回垃圾文本整体降级为目录分组（`test-cluster.mjs:168`、`:188`、`:201`、`:210`）。

下钻（`test-cluster.mjs:218-359`）：

- 大模块超 `splitThreshold` 下钻成子模块，父节点不单独成文（`test-cluster.mjs:219`）。
- 下钻只返回一个子模块（名字没变）视为不可再分（`test-cluster.mjs:252`）。
- `maxDepth=2` 只下钻一层、`maxDepth=3` 出现孙模块，证明 `maxDepth` 是真正的总层数上限（旧实现只当 `>1` 布尔开关，配 2/3 行为相同，`test-cluster.mjs:269-343`）。
- 下钻抛错不影响整体结果（`test-cluster.mjs:345`）。

超级分组（`test-cluster.mjs:361-402`）：顶层模块过多时归成子系统（`topFanout: 3` 触发，`test-cluster.mjs:382`），`parseSuperGroups` 对未归类模块保留在顶层、忽略不存在模块名。

`toPlanModules` 输出插件任务清单形状：`name` 为字符串、`files` 非空数组、`summary` 字符串（`test-cluster.mjs:148`）。

### test-semantic-plan.mjs（端到端语义规划）

`scanRepoFiles(cwd)`（`index.js:2192`）：仓库源码扫描，黑名单目录（`SCAN_SKIP_DIRS`，`index.js:2178`）+ 二进制后缀（`SCAN_SKIP_EXT`，`index.js:2183`）+ 单文件 256KB（`SCAN_MAX_FILE_BYTES`，`index.js:2189`）+ 总数 2000（`SCAN_MAX_FILES`，`index.js:2190`）。返回 `[{ path, bytes }]`。

`semanticPlan(files, { cwd, llm, provider, model, reasoningEffort, signal, notes })`（`index.js:1393`）：端到端语义规划。流程：读正文 → `extractRepoGraph` 提取组件 → `resolveImportEdges` 建边 → 拼 `llmCall` → `clusterComponents` → 组装 `plan`。返回 `{ plan, fallback, reason }`。任何环节失败都返回 `fallback: true`（原因：`extractor-unavailable` / `extract-failed` / `no-components` / `cluster-failed` / `empty-plan`，见 `index.js:1415`、`:1421`、`:1426`、`:1443`、`:1473`）。`plan` 形状（`index.js:1431`）：`{ project, modules, concepts, tree, graph, stats }`，其中 `graph.components` **显式不含 `sourceCode`**（见 `index.js:1456` 注释与 `test-semantic-plan.mjs:165`），`project` 文案在降级时标注「已降级为目录聚类」。

`localPlan(files)`（`index.js:1371`）：按顶层目录分组，`project` 文案固定为「（本地规划：按顶层目录分组）」。`slugify(name)`（`index.js:1741`）：保留 CJK 字符、其他字符清洗为 `-`，空则回落 `module`（与 `lib/cluster.js:48` 的 `normalizeModuleName` 是两套策略——前者保留中文目录名避免塌缩，后者面向文件名）。

被这些测试钉住的关键行为：

- 无模型时仍能出模块清单（降级目录聚类），`stats.llm === false`、`project` 含「降级」、`stats.components > 0`（证明是 AST 提取而非文件级，`test-semantic-plan.mjs:38`）。
- 每个模块都带非空 `source_files` 且文件真实存在（`test-semantic-plan.mjs:52`）。
- 模块文件并集 = 全部有符号的源文件（不丢文件、`README.md` 无符号不进模块，`test-semantic-plan.mjs:60`）。
- 有模型时走 LLM 聚类并按返回分组（`billing` 归 billing、`api` 归 apiruntime，跨目录混写被正确归并，`test-semantic-plan.mjs:71`）。
- 模型返回坏 JSON / 请求抛错时降级到目录聚类而非崩溃（`test-semantic-plan.mjs:114`、`:130`）。
- 空仓库返回 `fallback: true`（`test-semantic-plan.mjs:142`）。
- `plan.graph` 可序列化且含组件与边、JSON 往返不丢信息（`test-semantic-plan.mjs:151`）。
- `plan.graph` 不携带源码（`'sourceCode' in c` 为 false、`dependsOn`/`parameters`/`relativePath` 必须还在），序列化体积 < 400KB 防线（`test-semantic-plan.mjs:167`）。
- `localPlan` 对同一批文件仍可用，降级路径保活（`test-semantic-plan.mjs:174`）。
- 模块名 slugify 后不冲突（`test-semantic-plan.mjs:180`）。

## Architecture

`lib/cluster.js` 三段式聚类（组件 ≥3，流程非平凡），框图如下：

```text
            components[] (id=path#name)
                  │
                  ▼
        ┌───────────────────────┐
        │ clusterComponents()    │  lib/cluster.js:291
        │  stats {llm,levels,    │
        │         fallbacks}     │
        └───────────┬───────────┘
      no llmCall   │   llmCall
   ┌──────────────┼──────────────────────┐
   ▼              ▼                      ▼
heuristicCluster  call(clusterPrompt)   ┌──────────────────────┐
lib/cluster.js:219 formatComponents     │ parseClusterResponse │
                  lib/cluster.js:57      │ lib/cluster.js:156   │
                  + parseClusterResponse │  ▼                   │
                  + fillMissing          │ fillMissing          │
                    lib/cluster.js:247   └──────────────────────┘
                  │
   ┌──────────────┼───────────────────────────┐
   ▼              ▼                            ▼
big module?   too many top?               finalize()→tree
(splitThreshold) (topFanout)              lib/cluster.js:359
   │              │
   ▼              ▼
subdivide()   superGroupPrompt→parseSuperGroups
lib/cluster.js:396  lib/cluster.js:106 / :425
   │
   ▼
toPlanModules → {name,summary,files}
lib/cluster.js:460
```

`index.js` 端到端语义规划在外层包了一层 `semanticPlan`（`index.js:1393`）：先 `scanRepoFiles` 扫源文件 → `extractRepoGraph`（tree-sitter AST 提组件）→ `resolveImportEdges` 建依赖边 → 拼 `llmCall` → 调 `clusterComponents` → 组装 `plan`（`graph` 不含 `sourceCode`）。`buildPlan`（服务侧，`index.js:2986`）在 `planMode==='dirs'` 时直接走 `localPlan`，否则走 `semanticPlan`，后者 `fallback` 时退回 `localPlan`。

## Data Flow

1. **测试构造输入**：`test-cluster.mjs:25` 的 `makeComponents()` 手工造 `components[]`（形状 `{id,name,kind,relativePath,parameters,sourceCode,dependsOn}`）；`test-semantic-plan.mjs:20` 用 `fs.mkdtempSync` 在临时目录造一个「目录≠职责」的样例仓库，再 `scanRepoFiles(tmp)`（`index.js:2192`）扫出 `{path,bytes}` 列表。
2. **注入模型**：`test-cluster.mjs` 用 `llmCall = async () => JSON.stringify(...)` 或 `deepLlm(pool)`（`test-cluster.mjs:286`，按 prompt 里「模块「x」」决定拆几份）模拟模型；`test-semantic-plan.mjs:83` 的 `fakeLlm` 实现 `async *stream()` 从 `formatComponents` 的 TAB 行抽 id 并按路径前缀切两组，验证真实通道。
3. **聚类 / 规划**：`clusterComponents`（有/无 `llmCall`）产出 `modules / tree / stats`；`semanticPlan` 在其外包一层，产出 `plan.{modules,tree,graph,stats}`。
4. **断言校验**：`check` 收集 `r.modules.flatMap(m=>m.components)` 成 `Set` 比对 `allIds`/组件总数，验证「组件不丢」；比对 `r.stats.fallbacks`、`r.warnings`、`r.plan.project` 文案、`plan.graph` 体积与字段存在性。
5. **清理**：`test-semantic-plan.mjs:186` 在末尾 `fs.rmSync(tmp, ...)` 删临时仓库。

关键不变量（被大量断言钉住）：任何路径下「组件数守恒」——无论 LLM 命中、降级、下钻、下钻抛错，最终 `got.size === components.length`（`test-cluster.mjs:157`、`:185`、`:198`、`:207`、`:215`、`:247`、`:358`）。

## Connections

- [[lib-cluster]]：`test-cluster.mjs` 直接 import 并测试的全部聚类纯函数（`clusterComponents` / `heuristicCluster` / `fillMissing` / `moduleFiles` / `formatComponents` / 三段 prompt / `parseJsonLoose` / `parseClusterResponse` / `parseSuperGroups` / `normalizeModuleName` / `toPlanModules`）所在模块。
- [[index]]：`test-semantic-plan.mjs` 测试的 `semanticPlan` / `localPlan` / `scanRepoFiles` 所在插件主模块；`buildPlan`（`index.js:2986`）是服务侧对该能力的调用方。
- [[lib-symbols]]：`semanticPlan` 内部调用的 `extractRepoGraph` / `resolveImportEdges`（`index.js:1393`、`:1429`），提供 AST 组件与依赖边。
- [[lib-incremental]]：`semanticPlan` 产出的 `plan.tree` / `plan.graph` 随 job 持久化，供 stale 增量按组件粒度判定变更（见 `index.js:1393` 注释）。

## Known Issues

- `test-cluster.mjs` 与 `test-semantic-plan.mjs` 各读各的源码、各自维护一份 `check`/`pass`/`fails` 微型框架（`test-cluster.mjs:12`、`:13` vs `test-semantic-plan.mjs:10`、`:11`），没有复用也没有 `node:test` 框架——新增断言要手动对齐两套写法。
- `normalizeModuleName`（`lib/cluster.js:198`）与 `slugify`（`index.js:1741`）是两套命名策略且语义不同：前者把非 `\w` 字符（含 CJK 之外的脚本）转 `_` 并小写，空串回落 `module`；后者**保留 CJK** 以免多个中文目录塌缩成单模块。二者不可混用，测试也分别覆盖（`test-cluster.mjs:113-118` 验证 `normalizeModuleName` 保留中文名，`test-semantic-plan.mjs:108` 验证 `slugify` 不冲突）。
- `semanticPlan` 的 `plan.graph` 体积防线靠「不塞 `sourceCode`」实现（`index.js:1456` 注释 + `test-semantic-plan.mjs:165` 的 `< 400_000` 字节断言）。若将来有人把源码重新塞回 `graph.components`，该测试会先一步报警，但测试本身依赖序列化体积阈值，超大仓库可能需同步调阈值。
- 下钻的 `maxDepth` 行为是被 `test-cluster.mjs:269-343` 显式回归测试的：早期实现把 `maxDepth` 仅当 `>1` 的布尔开关，配 2 与配 3 行为完全相同（都是两层）。该用例用 `makeDeepComponents()`（`test-cluster.mjs:274`，72=3×4×6）配合 `deepLlm(pool)`（`test-cluster.mjs:286`）验证层数可配。
- `test-semantic-plan.mjs` 的 `fakeLlm` 解析 prompt 时依赖 `formatComponents` 输出以 `\t` 开头的行（`test-semantic-plan.mjs:73`），若 `formatComponents` 改了行格式（见 `lib/cluster.js:28`），该解析逻辑会同步失效，需一并改。
