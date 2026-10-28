---
title: _architecture
type: architecture
source_files:
  - lib/agentic-host.js
  - lib/agentic.js
  - lib/article-contract.js
  - lib/articles-agentic.js
  - lib/change-set.js
  - lib/cluster.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - index.js
  - test-agentic-fallback.mjs
  - test-agentic-host.mjs
  - test-agentic.mjs
  - test-article-contract.mjs
  - test-articles-agentic.mjs
  - test-batch.mjs
  - test-change-set.mjs
  - test-cluster.mjs
  - test-engine-bridge.mjs
  - test-engine-client.mjs
  - test-engine-contract.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-manifest.mjs
  - test-engine-output-real.mjs
  - test-engine-output.mjs
  - test-engine-python-entry.mjs
  - test-engine-process-tree.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - test-graphdiff.mjs
  - test-incremental-e2e.mjs
  - test-incremental.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-symbols.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
tags: [architecture, overview, pipeline, incremental, engine, module-roles]
---

## Overview

dsh-codewiki 是一个宿主（cordis）插件，把 Git 仓库的源码编译成一套结构化 wiki，落盘在仓库的 `.codewiki/` 目录：顶层入口 `CodeWiki.md`、`modules/*.md` 逐模块文章、`_architecture.md` 等横切文章，外加 `_meta.yaml`（编译基线）和 `temp/` 下的符号快照与增量复盘记录。

系统有三条主线：

1. **全量编译（full）**：扫描仓库 → AST 提取符号与 import 依赖边 → LLM 语义聚类成模块树 → 逐模块写作（agentic 工具循环或单轮批量）→ 契约闸门与锚点修正 → 索引、终态判定、基线推进。
2. **增量更新（stale/auto）**：四路 git 变更采集 + 符号快照比对 → 组件级 diff → 逐篇决定 `write/keep/review` → 只重写真正变化的文章；只要有未消化项就判 `partial` 且**绝不推进基线**。
3. **引擎迁移路径**：把上述算法换成 FSoft 原生 Python 引擎，Node 侧只留薄适配层（结果契约 / 子进程协议 / 环境指纹 / 模型桥 / 产物映射）。该层目前主要由 `test-engine-*.mjs` 钉住，尚未接管 `index.js` 主流程。

五条贯穿全部模块的设计原则（读任何模块文章前先记住它们）：

- **唯一编排入口**：所有任务经 `index.js` 的 JobService（提交制 + tick 阶段机）推进；`lib/*` 永不反向 import 编排层。
- **符号图是数据底座**：组件 id 约定 `<相对路径>#<符号名>`，这条契约贯穿 symbols / graph-diff / cluster / incremental / update-planner 五个模块。
- **不静默丢弃、不臆造归属**：变更采集失败显式 `fallback='full'`；无文章认领的变更进 `unmappedChanges`；`source_files` 只认真实组件→文件证据。
- **宁可多写不漏写**：无符号可判的文章保守保留；快照版本不符/坏 JSON 一律当「没有旧图」退回全量或文件级判定。
- **凭证边界**：插件不保存、不传递任何密钥；模型调用全部经宿主 `llm.stream` 服务（迁移路径经 `127.0.0.1` loopback 桥 + 占位 key）。

术语速查（零上下文阅读用）：

| 术语 | 含义 |
| --- | --- |
| 组件（component） | 函数/类/方法级符号，id 形如 `src/a.py#ClassName.method` |
| 模块（module） | 聚类产出的文章单位；叶子模块成文，父节点只是导航容器 |
| job | 一次编译任务；`stage` 是阶段机；`outcome ∈ done/partial/failed/cancelled` |
| 基线（baseline） | `.codewiki/_meta.yaml` 的 `last_compiled_commit`；仅 `done` 可推进 |
| blocker | 「完整性不成立」的机读原因（缺页/失败/unmapped/质量/索引等） |
| 快照（snapshot） | `.codewiki/temp/symbol-graph.json`，不含源码、固化哈希的符号图 |

本文是系统总览：先看三张图建立全貌，再到 [Module Roles](#module-roles) 找到对应模块文章（`modules/<name>.md`）深入。文中行号引自各模块文章成文时点，若源码已演进，请以函数名定位为准。

## System Overview

系统分六层：宿主环境提供 llm/web 等服务；`index.js` 是唯一编排入口；其下是三个功能子系统（语义规划、文章写作、增量更新）；所有产出经产物质量闸门落进 `.codewiki/`；`lib/engine/*` 是与主流程并列的引擎迁移适配层。

```text
┌────────────────────────────────────────────────────────────────────────────┐
│              宿主环境（cordis ctx；真实模型凭证只在此层）                   │
│   services.llm（llm.stream）、webServer、workspaceRegistry、agents         │
└────────────────────────────────────────────────────────────────────────────┘
                                       │ apply(ctx, config)：注册工具、端点、阶段机
┌──────────────────────────────────────▼─────────────────────────────────────┐
│            编排层 index.js（JobService 提交制 + tick 阶段机）               │
│  submit/cancel ─► 串行队列 ─► tick 阶段机 ─► 终态判定与自动提交             │
│  面板端点 /api/codewiki/*、入口闸门 isDeadCompileTarget                     │
└────────────────────────────────────────────────────────────────────────────┘
            │                         │                         │
 ┌──────────▼───────────┐  ┌──────────▼───────────┐  ┌──────────▼───────────┐
 │ A. 语义规划          │  │ B. 文章写作          │  │ C. 增量更新          │
 │ lib/symbols.js       │  │ lib/agentic.js       │  │ lib/change-set.js    │
 │  AST/正则符号提取    │  │  模型工具循环        │  │  四路 git 变更采集   │
 │  + import 依赖边     │  │ lib/agentic-host.js  │  │ lib/incremental.js   │
 │ lib/cluster.js       │  │  宿主消息/流适配     │  │  符号快照存取        │
 │  三段式语义聚类      │  │ lib/articles-        │  │ lib/graph-diff.js    │
 │                      │  │  agentic.js 批量执行 │  │  组件级 diff         │
 │                      │  │                      │  │ lib/update-planner.js│
 │                      │  │                      │  │  增量计划/stale scan │
 └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
            │ plan.modules            │ 文章草稿                │ UpdatePlan
            │                         │                         │ write 子集复用 A/B 通道
 ┌──────────▼─────────────────────────▼─────┐ ◄─────────────────┘
 │ D. 产物质量与终态闸门                    │
 │ lib/article-contract.js 契约校验         │
 │ fixAnchors 行号锚点修正                  │
 │ lib/update-record.js judgeOutcome        │
 └──────────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼─────────────────────────────────────┐
│ E. wiki 产物 .codewiki/                                                    │
│ CodeWiki.md（入口）· modules/*.md · _architecture.md 等横切文章            │
│ _meta.yaml（编译基线）· temp/symbol-graph.json（符号快照）                 │
│ temp/update-record.json（复盘记录）· temp/module-map.json（模块归属）      │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ F. 引擎适配层 lib/engine/*（FSoft 原生 Python 引擎 + 薄适配，迁移路径）    │
│   contract.js     EngineResult / EngineProgress / EngineError 结果契约     │
│   client.js + process-tree.js    runEngine JSON-lines 协议 / 进程树终止    │
│   manifest.js     环境指纹 / engine-lock.json / doctor 只读诊断            │
│   llm-bridge.js + openai-bridge.js    loopback OpenAI 兼容模型桥           │
│   output.js + mapping.js    引擎产物读取 / 映射 / 自洽校验                  │
│   （该层当前主要由 test-engine-*.mjs 验证；尚未接管 index.js 主流程）       │
└────────────────────────────────────────────────────────────────────────────┘
```

各层要点：

- **宿主环境**：`services.llm.stream` 是唯一模型通道（真实凭证只在宿主 provider 配置里，插件零直连）；`webServer` 承载面板端点；`workspaceRegistry` 提供候选仓库。
- **编排层 `index.js`**：`apply(ctx, config)` 注册 `codewiki_generate` / `codewiki_progress` / `codewiki_update` 等工具与 `/api/codewiki/*` 端点；JobService 用串行队列 + tick 阶段机推进任务（plan → articles → crosscut → review → index）；提交前用 `isDeadCompileTarget`（`index.js:433`，基于 `detectLinkedWorktree` / `hasCompilableSources`，见 `index.js:364-441`）拒掉 linked worktree 与扫不出源码的空壳目录。
- **A 语义规划**：`lib/symbols.js` 产出「符号 + 依赖边」的仓库图（AST 主路径 + 正则降级，降级记账到 `stats.regex`）；`lib/cluster.js` 把组件聚成模块树（三段式 LLM：顶层聚类/递归下钻/超级分组；无 `llmCall` 时 `heuristicCluster` 按目录兜底）。
- **B 文章写作**：`lib/agentic.js` 是纯工具循环（`read_code` / `list_files` / `edit_article` / `generate_sub_module`）；`lib/agentic-host.js` 做裸消息 ↔ 宿主 Message 适配；`lib/articles-agentic.js` 负责批量执行（双池并发、子模块递归、`allowedWritePaths` 写集闸门）。`index.js` 另有一条单轮批量通道（`prepareArticleTasks` + `runRealtimeTasks`），agentic 批次过半失败时回退到它。
- **C 增量更新**：`lib/change-set.js` 采集 committed/staged/unstaged/untracked 四路 git 变更；`lib/incremental.js` 管符号快照的瘦身存取；`lib/graph-diff.js` 做组件级六类 diff（added/deleted/interface/body/edge/renamed）；`lib/update-planner.js` 的 `planUpdate` 汇总成逐篇动作计划。
- **D 质量与终态**：`lib/article-contract.js` 的 `inspectArticle` 是落盘前契约闸门（frontmatter/章节/source_files/死链，error 拦写、warning 放行但降 partial）；`fixAnchors`（`index.js:856`）对照真实源码修行号锚点；`lib/update-record.js` 的 `judgeOutcome` 判终态并决定基线能否前移。
- **E wiki 产物**：一切落盘的终点，也是下次增量编译的输入（快照、基线、module-map 都在这里回读）。
- **F 引擎适配层**：`contract.js` 固定结果/进度/错误的可机读契约（`done` 不许带 blockers、`partial` 必须带）；`client.js` 管子进程 JSON-lines 协议与超时/取消，`process-tree.js` 保证取消打穿整棵进程树；`manifest.js` 管环境指纹与 `.codewiki/engine-lock.json`；`llm-bridge.js`/`openai-bridge.js` 为只认 OpenAI-compatible 的引擎提供 loopback 模型桥；`output.js`/`mapping.js` 把引擎 docs 产物映射成 CodeWiki 写集并校验自洽。

## Data Flow

下图给出两条主数据流：全量编译与增量更新。行号引自各模块文章；调用方均为 `index.js` 编排层。

```text
┌────────────────────────── 全量编译（scope=full） ──────────────────────────┐
│ 仓库源文件（git 工作区）                                                   │
│      │  scanRepoFiles（index.js:2121，黑名单/上限）                        │
│      ▼                                                                     │
│ files: [{path, content}]（统一读正文，提取与建边共用，不读两遍）           │
│      │  extractRepoGraph + resolveImportEdges（lib/symbols.js:785/:810）   │
│      ▼                                                                     │
│ graph: Map<id, node>   组件 id 约定 <相对路径>#<符号名>                    │
│      │  clusterComponents（lib/cluster.js:291）三段式聚类/下钻/超级分组    │
│      ▼                                                                     │
│ plan.modules（toPlanModules，lib/cluster.js:460 → name/summary/files）     │
│      │  prepareArticleTasks（index.js:1165，源码内联/分档/观察批）         │
│      ▼                                                                     │
│ 写作通道：runAgenticArticles（agentic 工具循环）或 runRealtimeTasks        │
│ （index.js:591 单轮批量：双池并发 / 失败记账 / signal 中止）               │
│      │                                                                     │
│      ▼   质量闸门 inspectArticle（lib/article-contract.js）+ fixAnchors    │
│ （index.js:856 行号锚点修正）──► .codewiki/modules/*.md 落盘               │
│      │  旁路：slimGraph（lib/incremental.js:37）把图瘦身落快照             │
│          temp/symbol-graph.json（不含源码，固化 bodyHash / codeHash）      │
│      │                                                                     │
│      ▼                                                                     │
│ judgeOutcome（lib/update-record.js:37）──► outcome + canAdvanceBaseline    │
│      │                                                                     │
│      ▼                                                                     │
│ 仅 done 且无 blocker ──► cw meta update 推进编译基线；否则不推进           │
└────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────── 增量更新（scope=stale/auto） ─────────────────────────┐
│ 读取基线 readCompiledBaseline（.codewiki/_meta.yaml 基线 commit）          │
│      │                                                                     │
│      ▼                                                                     │
│ collectChangeSet（lib/change-set.js:102）四路 git 采集                     │
│   committed(base..HEAD) + staged + unstaged + untracked（+ 改名 -M 检测）  │
│      │  失败（no-git / git-error / unreachable-base）──► fallback='full'   │
│      │     退回全量编译（绝不把「采不到」当「没变化」）                    │
│      ▼                                                                     │
│ ChangeSet { sourceChanges, deleted, renamed, untracked, all }              │
│      │                                                                     │
│      ▼                                                                     │
│ planUpdate（lib/update-planner.js:156）──UpdatePlan──► 每篇文章一个动作    │
│   输入 1  oldGraph = graphFromSnapshot(loadSnapshot(wiki))  旧快照回读     │
│   输入 2  newGraph = extractCurrentGraph(cwd)  当前全仓库重新提取          │
│   内部    diffGraphs（lib/graph-diff.js:447）组件级六类 diff + 改名配对     │
│      │                                                                     │
│      ▼                                                                     │
│ UpdatePlan { actions(write/keep/review), unmappedChanges, needsFull }      │
│      │                                                                     │
│      ▼  write 子集 ──► 复用全量写作通道 ──► 契约闸门 ──► 落盘              │
│         keep / review ──► 跳过（每篇附 reason，可复盘，绝不静默丢）        │
│      │                                                                     │
│      ▼                                                                     │
│ needsFull 或 unmappedSourceChanges 非空 ──► partial（基线绝不前移）        │
│ 全部消化（无 blocker）──► done ──► 推进基线 + 重建 module-map              │
└────────────────────────────────────────────────────────────────────────────┘
```

### 全量编译步骤

1. **提交与守卫**：`codewiki_generate` 工具 execute → JobService `submit`（worktree/空壳闸门 `isDeadCompileTarget`，`index.js:433`）→ 串行排队 → tick 阶段机接管。
2. **语义规划**（`semanticPlan`，`index.js:1322`）：`scanRepoFiles`（`index.js:2121`）+ 读正文 → `extractRepoGraph`（`lib/symbols.js:785`）得组件图 → `resolveImportEdges`（`lib/symbols.js:810`）建文件级依赖边 → `clusterComponents`（`lib/cluster.js:291`，有 `llmCall` 走 LLM 三段式，否则启发式）→ `toPlanModules`（`lib/cluster.js:460`）。plan 连同精简 graph（不含 `sourceCode`）持久化进 job，供增量复用。
3. **写作**（`tickArticles`）：`prepareArticleTasks`（`index.js:1165`）按 token 预算分档（普通 / 大档 `bigTier` / 观察批 / 会话兜底）→ `runAgenticArticles`（agentic 工具循环，逐篇写盘，子模块递归受 `subDepth` 上限约束）或 `runRealtimeTasks`（`index.js:591`，单轮双池并发）。agentic 批次**过半**失败触发单轮回退（`shouldFallBackFromAgentic`，严格多数判定）。
4. **质量闸门**：`inspectArticle`（`lib/article-contract.js:213`）逐篇校验——error 级拒绝落盘，warning 级放行但把终态压到 partial；`fixAnchors`（`index.js:856`）按 `source_files` 对照真实源码修正行号锚点；`isWritable` 写集闸门拒绝越界路径。
5. **收尾**：`pruneOrphanModules`（`index.js:271`，仅全量、仅当 `plan.modules` 非空时清理孤儿模块文章）；`ensureWikiEntry`（`index.js:301`）生成/保护 `CodeWiki.md`；`normalizeIndexLinks` 规范化路径分隔符。
6. **终态判定**：`judgeOutcome`（`lib/update-record.js:37`）——缺页/逐篇失败/unmapped 源码变更/缺 `source_files`/质量闸门/索引失败/额外硬阻塞，任何一项未消化 ⇒ `partial` 或 `failed`；`buildUpdateRecord`（`lib/update-record.js:131`）→ `saveUpdateRecord` 落 `temp/update-record.json`。
7. **基线闸门**：仅当 `canAdvanceBaseline`（`done` 且无 blocker）才执行 `cw meta update` 推进 `last_compiled_commit`；partial 允许文章入库但基线纹丝不动。
8. **快照**：`tickIndex` 收尾用 `slimGraph`（`lib/incremental.js:37`）构造快照，`sameSnapshotContent` 判实质没变就跳过写（避免 autoCommit 空转提交），`saveSnapshot`（`lib/incremental.js:106`）落 `.codewiki/temp/symbol-graph.json`。

### 增量更新步骤

1. **基线与采集**：`readCompiledBaseline` 读基线 commit → `collectChangeSet`（`lib/change-set.js:102`）四路采集；任一守卫失败（`no-git` / `git-error` / `unreachable-base` / `missing-base`）⇒ `fallback='full'` 退回全量，绝不把「采不到」当「没变化」。
2. **双图准备**：`oldGraph = graphFromSnapshot(loadSnapshot(wiki))`（`lib/incremental.js:69` / `:94`；回读节点不带源码，靠固化的 `bodyHash`/`codeHash` 判定）；`newGraph = extractCurrentGraph`（重新跑 `extractRepoGraph` + `resolveImportEdges`）。
3. **计划**：`planUpdate`（`lib/update-planner.js:156`）——`realChangedIds`（`:57`）用 `codeHash` 把纯注释改动降级为 cosmetic；`dependentsOf`（`:85`）反向依赖闭包只对 `structural`（接口/增删/改名/边变更）波及使用方文章；未命中自身/依赖的文章跑 `scanStaleArticle`（`:106`）查已删符号（升级 write）与死链（进 review）；新文件按公共目录路由进最相关文章（`routedTo`），无归属源码进 `unmappedSourceChanges` ⇒ `needsFull`。
4. **执行**：write 子集复用全量写作通道（agentic 优先、过半失败回退单轮）→ 同一道契约闸门 → 落盘；keep/review 跳过但每篇附 `reason` 可复盘。
5. **判定与闸门**：同全量 6-7——`needsFull` 或 unmapped ⇒ `partial`，基线绝不前移；全部消化 ⇒ `done`，推进基线并用 `buildModuleMap`（`lib/update-planner.js:442`）重建 `temp/module-map.json`。
6. **快照与记录**：与全量第 8 步相同（代码没变就不覆盖快照）。

### 跨流程不变量

- **变更不丢失**：change-set 采不全显式降级；planner 无归属显式列出；record 把未消化项折进 blockers——三层都没有「静默吞掉」的路径。
- **组件不丢失**：聚类无论 LLM 成败，最终 `Set(modules.flatMap(m => m.components)).size === components.length`（`test-cluster.mjs` 全程断言；`fillMissing` + `heuristicCluster` 兜底）。
- **partial 不推基线**：「1 篇成功 19 篇失败也报 done」的历史缺陷由 `judgeOutcome` 钉死（`test-update-record.mjs:62-76`）。
- **不臆造 `source_files`**：只认真实组件→文件证据（`lib/engine/mapping.js` 的 `sourceFilesOf`，`:62-72`；`lib/cluster.js` 的 `moduleFiles`，`:274-281` 同口径）。
- **快照安全**：`loadSnapshot` 任何异常（缺文件/坏 JSON/版本不符）返回 `null`，调用方退全量或文件级，绝不误判。

## Dependency Graph

依赖方向约定：`A ──► B` 读作「A 依赖 B」（A import / 调用 B）；`►` 指向被依赖方。

```text
依赖方向约定：A ──► B 读作「A 依赖 B」——A import / 调用 B；► 指向被依赖方。

┌────────────────────────────────────────────────────────────────────────────┐
│ L4  编排层  index.js —— 唯一入口；可依赖以下各层，无模块反向依赖它          │
└────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼  import / 调用
┌────────────────────────────────────────────────────────────────────────────┐
│ L3  领域库  lib/*.js —— 彼此单向依赖；禁止 import index.js                 │
│                                                                            │
│   lib/cluster.js       ──►  lib/symbols.js（组件契约 path#name）           │
│   lib/incremental.js   ──►  lib/graph-diff.js（diff 引擎/哈希/改名）       │
│   lib/update-planner.js ──►  lib/graph-diff.js（diffGraphs/codeHash）      │
│   lib/update-planner.js ──►  lib/incremental.js（normRel 路径归一）        │
│   lib/update-planner.js ──►  lib/symbols.js（SUPPORTED_EXTS 源码扩展名）   │
│   lib/articles-agentic.js ──►  lib/agentic.js + lib/article-contract.js    │
│   lib/change-set.js、lib/update-record.js、lib/article-contract.js         │
│   —— 以上三个是纯函数叶子（仅依赖 Node 内置模块）                          │
└────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ L2  基础设施叶子（零业务依赖，被 L3/L4 复用）                              │
│   lib/symbols.js      表驱动 AST / 正则（tree-sitter 可选，缺失即降级）    │
│   lib/graph-diff.js   Python difflib 逐位移植；纯 Node 标准库              │
│   lib/agentic.js / lib/agentic-host.js   工具循环与宿主消息适配            │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ E  引擎适配层  lib/engine/* —— 迁移路径内部依赖；与 L3 领域库零交叉         │
│   client.js      ──►  contract.js（engineResult/Progress/Error）           │
│   client.js      ──►  process-tree.js（terminateProcessTree）              │
│   output.js      ──►  mapping.js ──►  contract.js（版本常量共享）          │
│   llm-bridge.js  ──►  openai-bridge.js（纯转换层：无 I/O、无密钥）         │
│   manifest.js    ——  叶子（仅 Node 内置 fs/path/crypto）                   │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ T  测试层  test-*.mjs —— 全部单向依赖被测源；生产代码不 import 任何测试     │
│   test-symbols / test-cluster / test-graphdiff          ──►  对应 lib/*    │
│   test-incremental / test-update-planner / test-update-record ──► lib/*    │
│   test-orchestration / test-batch ──►  index.js（makeCtx + mock llm）      │
│   test-engine-* ──►  lib/engine/*（契约/协议/清单/进程树/桥/产物）         │
└────────────────────────────────────────────────────────────────────────────┘
```

依赖规则（改动任何 import 前先核对）：

1. **严格单向、无环**：L4 → L3 → L2；`lib/*` 永不 import `index.js`，`index.js` 也不被任何 lib 反向感知。唯一例外是测试层对 `index.js` 的单向依赖（导出函数单测）。
2. **engine 与领域库零交叉**：`lib/engine/*` 只在内部依赖（client → contract + process-tree；output → mapping → contract；llm-bridge → openai-bridge），不 import 任何 `lib/*.js` 领域库；与主流程的接缝是「引擎产物经 output/mapping 校验后走同一落盘管线」，而不是代码级耦合。
3. **迁移接线现状**：`lib/engine/client.js`（`runEngine`）当前**未被** `index.js` import——主流程仍走内部流水线；该层由 `test-engine-*.mjs` 全套钉住，接入时需明确谁调用 `runEngine` 并把 `EngineResult` 转成 job 终态。
4. **共享契约常量**：`ENGINE_CONTRACT_VERSION`（`lib/engine/contract.js:20`）被 `mapping.js`（`:28`）与 `client.js`（`:23`）共同引用；Python 侧 `lib/engine/python/stage_map.py` 的 `ENGINE_STAGES`（`:20-29`）必须与 `contract.js:24-33` 同集合（`test-engine-python-entry.mjs` 双向对账）。
5. **数据形状契约贯穿**：符号记录 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }` 由 `lib/symbols.js`（AST 路径 `walk` 与正则路径 `regexExtract`）产出，被 graph-diff / cluster / incremental / update-planner 无差别消费——两条提取路径产出形状必须完全一致（`test-symbols.mjs:309-316` 断言）。
6. **测试资产分层**：黄金基准（`test-fixtures/graphdiff-golden.json`）是离线一次生成的真理源，`test-graphdiff.mjs` 逐位对拍；其余测试要么离线注入桩（`llmCall` / `execFile` / `fsImpl` / `streamFn`），要么用真实 git/子进程在临时目录断言。

## Module Roles

### 编排层

| 模块文章 | 源文件 | 职责与关键入口 |
| --- | --- | --- |
| `index.js`（无独立模块文章，散见各文） | `index.js` | 插件入口与 JobService：`apply` 注册工具/端点；串行队列 + tick 阶段机；面板端点（`installWebServer`，`index.js:4327`）；`semanticPlan`（`:1322`）、`prepareArticleTasks`（`:1165`）、`runRealtimeTasks`（`:591`）、`fixAnchors`（`:856`）、`pruneOrphanModules`（`:271`）、`ensureWikiEntry`（`:301`）、worktree/空壳闸门（`:353-441`）、`scanRepoFiles`（`:2121`）、快照落盘与基线推进 |

### 语义规划（A）

| 模块文章 | 源文件 | 职责与关键入口 |
| --- | --- | --- |
| `modules/symbols.md` | `lib/symbols.js` | 仓库图数据底座：表驱动 tree-sitter AST（`LANG_RULES`，`lib/symbols.js:36-271`，≥15 语言）+ 正则降级（`regexExtract`，`:374-440`，降级记账 `stats.regex`）；`extractRepoGraph`（`:785`）与 `resolveImportEdges`（`:810`，文件级 import 边回写 `dependsOn`）。上游：index；下游：cluster / graph-diff / incremental / update-planner |
| `modules/cluster.md` | `lib/cluster.js` | 语义模块规划：`clusterComponents`（`:291`）三段式（顶层聚类 → 递归下钻 → 超级分组），显式阈值控请求数；无 `llmCall` 走 `heuristicCluster`（`:219`）按目录兜底；`toPlanModules`（`:460`）产出写作任务清单。降级不变量：组件集合永不丢失 |

### 文章写作（B）

| 模块文章 | 源文件 | 职责与关键入口 |
| --- | --- | --- |
| `modules/test_agentic.md`（覆盖实现） | `lib/agentic.js` | 纯模型工具循环：`runAgenticArticle`、`buildToolset`（read_code / list_files / edit_article / generate_sub_module 四工具）、`parseToolArgs`、`buildOpeningPrompt`；无 streamFn 直接抛错 |
| 同上 | `lib/agentic-host.js` | 裸消息 ↔ 宿主 `Message` 适配（`toRequestMessages`）；`makeHostStream`（chunk 装配、error 即抛）；`makeFsWorkspace`（`../` 越界拒绝） |
| 同上 | `lib/articles-agentic.js` | 批量执行器：`runOneArticle` / `runAgenticArticles` 双池（bigTier + 默认档）、子模块递归（`subDepth` 上限防爆炸）、`allowedWritePaths` 写集闸门（递归子级继承，防覆盖父篇） |

### 增量更新（C）

| 模块文章 | 源文件 | 职责与关键入口 |
| --- | --- | --- |
| `modules/change_set.md` | `lib/change-set.js` | `collectChangeSet`（`:102`）四路 git 变更采集；`state` 语义（ok/no-git/git-error/unreachable-base/missing-base）；任何失败 `fallback='full'`；wiki 产物 `.codewiki/*` 剔入 `ignored` |
| `modules/incremental.md` | `lib/incremental.js` | 符号快照瘦身存取：`slimGraph`（`:37`，固化 `bodyHash`/`codeHash`，不存源码）、`loadSnapshot`/`saveSnapshot`（`:94`/`:106`）、`graphFromSnapshot`（`:69`）；`filterStaleTasks`（`:140`）是旧判定器（已被 planUpdate 取代核心判定，但快照 IO 是生产路径）；`normRel`（`:118`）被 planner 复用 |
| `modules/graph_diff.md` | `lib/graph-diff.js` | 组件级 diff 引擎（上游 `graph_diff.py` 逐位移植，黄金基准对拍护体）：`diffGraphs`（`:447`）六类变更 + `pairRenames`（`:371`，τ=0.8）；`codeHash`（`:108`，剥注释）支撑纯注释降级；`unifiedDiff`（`:327`）供文章展示 |
| `modules/update_planner.md` | `lib/update-planner.js` | 增量计划器：`planUpdate`（`:156`）输出 `write/keep/review` + `reason`；`realChangedIds`（`:57`）、`dependentsOf`（`:85`）反向闭包（仅 structural 波及）、`scanStaleArticle`（`:106`）、新文件同模块路由（`:360`）；module-map 状态管理（`buildModuleMap`/`migrateModuleMap`/`sameModuleMap`，`:442-492`） |
| `modules/update_record.md` | `lib/update-record.js` | 终态判定与复盘：`judgeOutcome`（`:37`，六类 blocker；`canAdvanceBaseline` 仅 done 为真）、`buildUpdateRecord`（`:131`，job 只存摘要不塞整图）、`saveUpdateRecord`/`loadUpdateRecord` 落 `temp/update-record.json`、`describeOutcome` 面板文案 |

### 产物质量（D）

| 模块文章 | 源文件 | 职责与关键入口 |
| --- | --- | --- |
| `modules/test_wiki_articles.md`（覆盖实现） | `lib/article-contract.js` | 文章契约闸门：`inspectArticle`（`:213`）校验 frontmatter/必填字段/type 与目录/章节/围栏/`source_files` 证据/死链；`SEVERITY` 分级（error 拦写、warning 放行降 partial）；`makeWriteSet`/`isWritable`（`:352`/`:365`）写集闸门拒绝越界写 |

### 引擎适配层（F）

| 模块文章 | 源文件 | 职责与关键入口 |
| --- | --- | --- |
| `modules/engine_contract.md` | `lib/engine/contract.js` | 跨进程契约：`engineResult`/`engineProgress`/`engineError` 纯函数工厂（构造即校验：done 无 blockers、partial 必带 blockers、failed 必带 error）；码表 `ENGINE_STAGES`/`BLOCKER_KINDS`/`ENGINE_ERROR_CODES`；`validateEngineResult` 反序列化软校验 |
| `modules/engine_client_proc.md` | `lib/engine/client.js`、`lib/engine/process-tree.js` | `runEngine`（`client.js:223`）：spawn 受管子进程、写一行请求 JSON、读 JSON-lines；`createProtocolReader`（`:39`）纯逻辑协议解析（六条协议不变量）；超时/取消走 `terminateProcessTree`（`process-tree.js:61`，POSIX 进程组 SIGTERM→SIGKILL / Windows `taskkill /T /F`） |
| `modules/engine_manifest.md` | `lib/engine/manifest.js` | 环境指纹与锁：`fingerprintOf`（`:50`，只吃引擎版本 + Python 版本）、`compareLock`（`:86`，absent/match/drift/unhealthy 四态）、`writeLock`（`:117`，原子写 `.codewiki/engine-lock.json`）、`doctor`（`:141`，只读诊断不修环境，probe 失败归 `probe-failed`） |
| `modules/engine_bridge.md` | `lib/engine/openai-bridge.js`、`lib/engine/llm-bridge.js` | 模型桥：`openai-bridge.js` 纯转换层（`toLlmRequest` `:128`、`foldChunks` `:192`、`chunksToSse` `:265`；无 I/O 无密钥）；`llm-bridge.js` loopback 服务器（`startLlmBridge` `:90`，127.0.0.1 随机端口 + 占位 key 校验，宿主凭证绝不经过桥） |
| `modules/engine_output.md` | `lib/engine/output.js`、`lib/engine/mapping.js` | 产物处理三段：`collectOutput`（`output.js:91`，只读不抛）→ `mapFsoftOutput`（`mapping.js:115`，四条硬规则：不臆造 source_files / 不静默丢弃 / slug 冲突不覆盖 / 不改内容）→ `validateOutput`（`output.js:184`，11 类机读 problem，只报不修） |
| `modules/engine_fixtures.md` | `lib/engine/python/entry.py`、`lib/engine/python/stage_map.py`、`test-fixtures/*` | Python 薄入口（JSON-lines 协议、doctor/generate/update/cancel）与五段→八段阶段映射；graphdiff 黄金基准（固定种子 20261027 生成、逐位比对）与真实产物回归探针 |

### 测试资产（T）

| 模块文章 | 源文件 | 覆盖面 |
| --- | --- | --- |
| `modules/test_symbols.md` | `test-symbols.mjs` | 多语言 AST 提取、import 边、正则降级记账、WASM 降级链路 |
| `modules/test_cluster.md` | `test-cluster.mjs` | 聚类三段式 + 全部降级路径；核心不变量「组件不丢失」 |
| `modules/test_graph_diff.md` | `test-graphdiff.mjs`、`test-fixtures/*` | difflib 移植逐位对拍 + 组件级 diff 性质断言 |
| `modules/test_update_incremental.md` | `test-incremental.mjs`、`test-incremental-e2e.mjs`、`test-update-planner.mjs`、`test-update-record.mjs`、`test-prune-orphans.mjs` | 快照往返/纯注释降级、反向依赖/新文件路由/stale scan、终态判定、孤儿清理安全边界 |
| `modules/test_change_worktree.md` | `test-change-set.mjs`、`test-worktree.mjs` | 四路采集与降级语义、worktree/空壳闸门（真实 git 现场断言） |
| `modules/test_agentic.md` | `test-agentic*.mjs`、`test-articles-agentic.mjs` | 工具循环、宿主适配、批量执行/写集闸门、agentic→单轮回退契约 |
| `modules/test_wiki_articles.md` | `test-article-contract.mjs`、`test-wiki-anchors.mjs`、`test-wiki-entry.mjs` | 契约闸门、行号锚点三基准校验（`--strict` 才全硬断言）、入口生成与 Windows 路径规范化 |
| `modules/test_batch.md` | `test-batch.mjs` | 编译执行链纯函数（token 估算/装填/规划/锚点）+ 并发池/失败记账/回环端点 |
| `modules/test_orchestration_core.md`、`modules/test_orchestration_api.md` | `test-orchestration.mjs` | 服务化编排 e2e：builder 底座（makeCtx/makeBatchMock/makeFixtureRepo）+ 面板端点/取消/重启重跑断言 |
| `modules/test_engine_core.md`、`modules/test_engine_bridge_io.md` | `test-engine-*.mjs` | 引擎契约/协议/manifest/进程树、桥的凭证边界、产物 11 类 problem、真实产物回归 |

**给未来 agent 的阅读路径**：改增量判定先读 `modules/graph_diff.md` → `modules/update_planner.md` → `modules/update_record.md`；改文章生成先读 `modules/cluster.md` → `modules/test_agentic.md`；动 `lib/engine/*` 先读 `modules/engine_contract.md`（契约是唯一真相来源）。任何改动落盘前，记得终态闸门与基线闸门的关系：**partial 允许入库，但基线只在 done 时前移**。
