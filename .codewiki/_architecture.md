---
title: _architecture
type: architecture
source_files:
  - index.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/change-set.js
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/native-run.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-agentic.mjs
  - test-articles-agentic.mjs
  - test-orchestration.mjs
  - test-batch.mjs
  - test-graphdiff.mjs
  - test-engine-python-entry.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - docs/fsoft-native-engine.md
tags: [architecture, overview, crosscutting, agentic, incremental, native-engine, fsoft]
---

## Overview

本仓库是 **dsh-codewiki**：一个运行在 DeepSeek Harness 宿主（下文称「宿主」）里的插件，把用户的代码仓库编译成一套中文 wiki——入口 `CodeWiki.md` + `.codewiki/modules/*.md`——并支持基于 git 基线的增量更新与产物自动提交。本文是全部模块文章的系统总览，写给零上下文的未来 agent：先读本文建立全局图，再按需深入 [[agentic_core]]、[[update_planner]]、[[engine_protocol]] 等模块文章。

系统有三条贯穿性的设计不变量，读任何模块文章前先记住它们：

1. **纯逻辑与宿主适配分离**。算法层（`lib/agentic.js`、`lib/graph-diff.js`、`lib/change-set.js`、`lib/engine/contract.js` 等）不依赖宿主服务，依赖一律通过注入进入：`streamFn` / `workspace`（写作循环）、`llmCall`（聚类）、`execFile`（git 采集）、`fsImpl`（快照与记录 IO）。因此绝大多数模块可完全离线单测（见 `test-agentic.mjs`、`test-graphdiff.mjs`）。
2. **终态诚实**。终态枚举 `done / partial / failed / cancelled` 是硬契约：`done` 不许带 blockers、`partial` 必须带 blockers、`failed` 必须带 error（`lib/engine/contract.js:97` 的 `engineResult`）；只有 `done` 才允许推进编译基线（`lib/update-record.js:40` 的 `judgeOutcome`、`lib/engine/native-run.js:41` 的最弱终态合成）。任何「采不到 / 判不了」都显式暴露，绝不假装 clean。
3. **机读词表冻结**。阻塞类别 `BLOCKER_KINDS`、错误码 `ENGINE_ERROR_CODES`、阶段枚举 `ENGINE_STAGES`（`lib/engine/contract.js:24-67`）是跨进程（Node↔Python）、跨模块（quality-gate / update-record / 面板）共用的稳定词表，只可追加不可改名；Python 侧 `lib/engine/python/stage_map.py:20` 与 Node 侧双向对账（`test-engine-python-entry.mjs`）。

编译有**两条执行通道**，由 `index.js` 的配置开关选择：

- **Node 本地通道**：`index.js` 编排「符号提取 → 模块聚类 → 逐篇写作 → 落地记账」。写作又分两式：单轮装填 `runRealtimeTasks`（`index.js:662`）与 agentic 工具循环（`lib/articles-agentic.js` → `lib/agentic.js`）。
- **FSoft 原生 Python 引擎通道**：`lib/engine/native-run.js` 起 Python 子进程跑上游 FSoft 引擎（契约见 `docs/fsoft-native-engine.md`），Node 只做协议适配、模型桥接、质量门与落地，不再自己算图/聚类/写作。

**仓库路径速查**（增量闭环的状态载体）：`.codewiki/_meta.yaml` 的 `last_compiled_commit`（编译基线）、`.codewiki/temp/symbol-graph.json`（符号图快照，`lib/incremental.js:22`）、`.codewiki/temp/update-record.json`（复盘记录，`lib/update-record.js:18`）、`.codewiki/engine-lock.json`（引擎环境锁，`lib/engine/manifest.js:20`）、`vendor/tree-sitter`（WASM 语法，可选依赖）。

**阅读提示**：本文行号均转引自各模块文章，细节以对应模块文章为准；文中 `[[xxx]]` 链接到同名模块文章。注意两组「同一代码、不同切口」的重复视角：`lib/agentic.js` 同时被 [[agentic_core]]（四文件统筹）、[[articles_agentic]]（执行器视角）、[[prompt_helpers]]（提示词/工具视角）覆盖；`lib/engine/*` 同时被 [[engine_runtime]]（生产链路）、[[engine_protocol]]（跨语言边界）、[[engine_python]]（Python 侧）覆盖——不要把它们当成互不相关的代码。

## System Overview

系统分四层：宿主层（外部）、编排层（`index.js`）、三个并行子系统（规划/写作/原生引擎）、落地记账层。

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                     宿主 DeepSeek Harness (ctx)                          │
│   webServer（回环 HTTP）         llm 服务（真实凭证）            agents  │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │ ctx.inject / llm.stream(GenerateOptions)
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                index.js — 插件入口 / 编排服务 / 工具层                    │
│  apply → installWebServer：7 个回环端点（jobs/repos/sessions/models/     │
│  model-efforts/control），面板轮询与控制入口                              │
│  JobService：jobs 持久化 / cancel / 收割 / 阶段机 tick                    │
│  codewiki_generate 工具：全量 generate 与增量 stale 的统一入口            │
└───────┬────────────────────────┬──────────────────────────┬──────────────┘
        │                        │                          │
        ▼                        ▼                          ▼
┌─────────────────────┐ ┌───────────────────────┐ ┌─────────────────────────┐
│ A. 规划与增量判定    │ │ B. 逐篇写作（双通道）  │ │ C. 原生引擎通道          │
│ lib/symbols.js      │ │ 单轮 runRealtimeTasks │ │ lib/engine/native-run   │
│ lib/cluster.js      │ │ agentic 双池：         │ │ lib/engine/client       │
│ lib/change-set.js   │ │  lib/articles-agentic │ │ python/entry.py         │
│ lib/graph-diff.js   │ │   └ lib/agentic.js    │ │ lib/engine/llm-bridge   │
│ lib/update-planner  │ │   └ lib/agentic-host  │ │ lib/engine/quality-gate │
│ lib/incremental.js  │ │ 闸门 article-contract │ │ lib/engine/apply-plan   │
└─────────────────────┘ └───────────────────────┘ └─────────────────────────┘
        │                        │                          │
        │ plan / updatePlan      │ 成品文章（逐篇）           │ GateReport.rendered
        ▼                        ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ D. 落地与记账（两路汇合收口）                                             │
│  写集闸门落盘 → 质量复核 → cw index → 基线推进（仅 done）→ autoCommit     │
│  lib/update-record.js：judgeOutcome 终态 + blockers + 复盘记录           │
└──────────────────────────────────────────────────────────────────────────┘
```

各区块说明：

- **宿主层**：插件不自带 HTTP 服务与模型凭证。面板端点经 `ctx.inject(['webServer'])` 注册为**仅回环可见**（`index.js:4614` 的 `installWebServer`，非回环地址一律 403）；模型调用统一走宿主 `llm.stream`，真实凭证只活在宿主 provider 内部，插件侧任何代码（含桥）都拿不到密钥。
- **编排层 `index.js`**：单文件编排入口（约 5000+ 行）。对外暴露 `codewiki_generate` 等工具；对内维护 JobService（jobs 持久化、取消、收割）与阶段机 tick（articles → crosscut → review → index → commit；原生通道为 env → graph → cluster → articles → validate → index → baseline → commit 八段，`lib/engine/contract.js:24`）。
- **A 规划与增量判定**：全量路径 `semanticPlan`（`index.js:1393`）= `scanRepoFiles`（`index.js:2192`）→ `extractRepoGraph`（`lib/symbols.js:785`）→ `clusterComponents`（`lib/cluster.js:291`）；增量路径 `runStaleUpdate` = `collectChangeSet`（`lib/change-set.js:102`）+ `extractCurrentGraph`（`index.js:2220`）+ 旧快照回放 → `planUpdate`（`lib/update-planner.js:156`）。
- **B 逐篇写作**：单轮通道一次性装填源码求全文；agentic 通道给模型「读码 / 编辑文章 / 派发子模块」的工作台（四工具，`lib/agentic.js:27-87`），由 `runAgenticArticles`（`lib/articles-agentic.js:231`）双池并发驱动。失败过半时 `tickArticles` 把失败篇退回单轮通道重跑一次。
- **C 原生引擎通道**：`runNativeJob`（`lib/engine/native-run.js:68`）把「环境探测 → 引擎 → 质量门 → 落地器」固定成一条裁决链，任何后续步骤都不能洗白前序失败；模型流量经 loopback 桥（`lib/engine/llm-bridge.js:90`）回到宿主 `llm.stream`。
- **D 落地记账**：两条通道的产物最终汇合到同一收口——写集闸门内落盘、质量复核、`cw index` 重建索引、终态判定（`lib/update-record.js:37`）、仅 `done` 推进基线、`autoCommitWiki`（`index.js:4952`）提交 `.codewiki/` 与 `CodeWiki.md`、写符号图快照与复盘记录。

## Data Flow

下图以一次**增量更新（kind=stale）**为主线（覆盖最多模块），右侧并列**全量（kind=full）**的原生引擎分支；两路在「落地与记账」汇合。

```text
 触发：codewiki_generate 工具 / 面板 control.compile / autoScan 调度
        │
        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ 提交闸门（svc.submit）：worktree 识别（index.js:435）、空壳目录    │
 │ 判定 hasCompilableSources（index.js:478）、排除清单、仓库登记     │
 └───────────────────────────────┬──────────────────────────────────┘
                                 ▼
                  JobService 建 job（kind=stale 或 full）
                 │                                  │
                 ▼ kind=stale（增量）                ▼ kind=full（全量）
 ┌────────────────────────────────┐  ┌─────────────────────────────────┐
 │ readCompiledBaseline：         │  │ 原生通道 runNativeJob(:68)       │
 │  .codewiki/_meta.yaml 基线     │  │  1) doctor+lock（manifest:141） │
 │ collectChangeSet               │  │  2) startLlmBridge（bridge:90） │
 │  (change-set.js:102, git 四路) │  │     注入 CODEWIKI_* 环境变量     │
 │ extractCurrentGraph(index:2220)│  │  3) runEngine（client.js:223）  │
 │  = scanRepoFiles →             │  │     spawn python/entry.py:577   │
 │    extractRepoGraph(symbols:785)│ │       └ FSoft 引擎产出 docs/ 树  │
 │    → resolveImportEdges(:810)  │  │  4) gateNativeOutput(:390) 质量门│
 │ loadSnapshot(incremental:94)   │  │  5) applyNativeOutput(:414) 落地│
 │  → 旧图 oldGraph               │  └────────────────┬────────────────┘
 │ diffGraphs(graph-diff.js:447)  │                   │
 │ planUpdate(update-planner:156) │                   │
 │  → write/keep/review 动作      │                   │
 │  → unmappedChanges/needsFull   │                   │
 └───────────────┬────────────────┘                   │
                 │ write 动作清单                      │
                 ▼                                    │
 ┌────────────────────────────────────┐               │
 │ 写作：markBigAgenticTasks(:320)    │               │
 │  → runAgenticArticles(:231) 双池   │               │
 │  → runOneArticle(:33)              │               │
 │     旧文增量 + makeWriteSet(:352)  │               │
 │  → runAgenticArticle(agentic:331)  │               │
 │     工具循环：read_code /           │               │
 │     list_files / edit_article /    │               │
 │     generate_sub_module（递归）     │               │
 │  streamFn=makeHostStream(host:83)  │               │
 │     → 宿主 llm.stream（收块成块）   │               │
 │  （失败过半 → 退回单轮 :662 重跑）  │               │
 └───────────────┬────────────────────┘               │
                 │ 成品文章                            │
                 ▼                                    ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ 落地与记账（两路汇合）                                             │
 │  isWritable 写集闸门（article-contract.js:365）→ fixAnchors       │
 │  → writeFileSync → 质量复核 → cw index 重建索引                   │
 │  judgeOutcome（update-record.js:37）判定终态 + blockers           │
 │  canAdvanceBaseline=done 才 cw meta update 推进基线               │
 │  → autoCommitWiki（index.js:4942）提交 .codewiki/+CodeWiki.md    │
 │  → saveSnapshot（新符号图）+ update-record.json 复盘              │
 └──────────────────────────────────────────────────────────────────┘
```

分步说明（stale 主线）：

1. **触发与闸门**：`codewiki_generate` 先 `normalizeCwd` 归一路径 → `detectLinkedWorktree`（`index.js:435`，linked worktree 不编，防止同一份代码编两遍）→ `clearSourceProbeCache` + `hasCompilableSources`（`index.js:478`，空壳目录直接拒绝）→ `runCw('status')` 判三态（`parseStatus`，`index.js:294`）。
2. **文件级变更采集**：`readCompiledBaseline` 读基线 commit → `collectChangeSet`（`lib/change-set.js:102`，调用点 `index.js:1775`）把 committed / staged / unstaged / untracked 四路 git 改动收成一个可序列化 `ChangeSet`；任何采集失败都返回 `ok:false, fallback:'full'`，绝不假装 clean。
3. **符号级当前图**：`extractCurrentGraph`（`index.js:2220`）= `scanRepoFiles`（`index.js:2192`）+ `extractRepoGraph`（`lib/symbols.js:785`，tree-sitter AST，不可用时正则兜底）+ `resolveImportEdges`（`lib/symbols.js:810`，把 import 解析成本仓库依赖边）→ `newGraph`。
4. **旧图回放**：`loadSnapshot`（`lib/incremental.js:94`）读 `.codewiki/temp/symbol-graph.json` → `graphFromSnapshot`（`:69`）得 `oldGraph`；快照只存瘦身字段并固化 `bodyHash`/`codeHash`，回读不重算哈希。
5. **组件 diff 与计划**：`diffGraphs`（`lib/graph-diff.js:447`）逐组件分类（interface/body/edge/renamed/added/deleted）→ `planUpdate`（`lib/update-planner.js:156`）结合文章 `source_files` 所有权、反向依赖闭包（`dependentsOf`，`:85`）与 stale scan（`:106`），给每篇文章产出 `write / keep / review` 动作；源码变更无归属 → `unmappedChanges` + `needsFull`（退回全量）。
6. **写作**：write 动作进 agentic 通道——`markBigAgenticTasks`（`lib/articles-agentic.js:320`，按 `sourceTokensOf`（`:185`）估体量打大档标）→ `runAgenticArticles`（`:231`，默认档/大档双池限流）→ `runOneArticle`（`:33`）装配 workspace、写集与旧文编辑器 → `runAgenticArticle`（`lib/agentic.js:331`）多轮循环：`buildOpeningPrompt`（`:506`）开场，`streamFn`（`makeHostStream`，`lib/agentic-host.js:83`，裸消息→宿主 Message，temperature 0）调 `llm.stream`，模型用 `read_code`（`:115`，带重复读抑制与行/字符上限）、`list_files`（`:179`）、`edit_article`（`:200`，str_replace 增量改）写文章，必要时 `generate_sub_module`（`buildToolset` `:285`）经 `dispatchSub` 递归派发子模块文章（深度封顶 `subDepth`）。
7. **落盘闸门**：空文章 → `ok:false`；`isWritable`（`lib/article-contract.js:365`）越界 → `stopReason:'write-set'` 不落盘（父任务只准写自己那篇，子模块只准写调度器分配的路径）；通过后 `fixAnchors`（`index.js:927`）校正行号锚点再写盘。agentic 失败过半时 `tickArticles` 把失败篇退回单轮 `runRealtimeTasks`（`index.js:662`）重跑一次（`agenticRetried` 防死循环）。
8. **终态与基线**：`judgeOutcome`（`lib/update-record.js:37`）汇合缺页 / 逐篇失败 / 未映射变更 / 质量闸门 / 索引失败等 blocker 判定 `done / partial / failed`；`canAdvanceBaseline` 仅 `done` 为真，才允许 `cw meta update` 推进基线——未消化的变化下次编译仍会被看见。
9. **提交与记账**：`autoCommitWiki`（`index.js:4952`）在主题分支提交 `.codewiki/` 与 `CodeWiki.md` 后合并回原分支；`saveSnapshot`（`lib/incremental.js:106`，写前 `sameSnapshotContent`（`:53`）比对防「只改时间戳」的空转提交）更新符号图快照；`buildUpdateRecord`（`lib/update-record.js:131`）+ `saveUpdateRecord`（`:217`）落 `update-record.json` 供复盘。

**原生通道（full）补充**：`runNativeJob`（`lib/engine/native-run.js:68`）第 1 步环境裁决——`doctor`（`lib/engine/manifest.js:141`）探测引擎/Python 版本并 `pip check`，与 `.codewiki/engine-lock.json` 比对，漂移或不闭合直接 `failed`（`engine-deps`），不跑引擎；第 2 步 `startLlmBridge`（`lib/engine/llm-bridge.js:90`）起 `127.0.0.1` 随机端口 + 每次随机占位 key 的 OpenAI 兼容桥，`index.js` 把 `CODEWIKI_BASE_URL / API_KEY / MAIN_MODEL / CLUSTER_MODEL` 注入子进程环境（真实凭证永不过桥，请求转换在 `lib/engine/openai-bridge.js:128` 的 `toLlmRequest` 与 `:265` 的 `chunksToSse`）；第 3 步 `runEngine`（`lib/engine/client.js:223`）写一行 JSON 请求、读回 JSON-lines，Python 侧 `entry.py` 的 `main`（`lib/engine/python/entry.py:577`）→ `action_generate`（`:384`）跑 FSoft 引擎，进度经 `bridge_progress`（`:281`）与 `stage_map.py` 的 `map_stage`/`percent_of`（`:66`/`:75`，五段→八段、上限 90%）实时回传；第 4 步质量门 `gateNativeOutput`（`lib/engine/quality-gate.js:390`）把 defect / degradation / stale 三类问题分流；第 5 步落地器 `applyNativeOutput`（`lib/engine/apply-plan.js:414`）写盘→索引→基线→提交，失败回滚；终态用 `weakest`（`native-run.js:42`）取最弱合成，再过 `engineResult`（`lib/engine/contract.js:97`）不变量。

**失败与降级路径**（每条都有显式出口，不静默）：`collectChangeSet` 采不到 → `fallback:'full'`；`planUpdate.needsFull` → 退全量；agentic 失败过半 → 退单轮通道；原生依赖不闭合 → `engine-deps` 直接失败；质量门 `partial` → 终态 `partial`、基线不动；取消/超时 → `terminateProcessTree`（`lib/engine/process-tree.js:61`）整树击杀并如实报 `cancelled` / `engine-timeout`。

## Dependency Graph

依赖方向约定：**A ─► B 表示 A 依赖 B**（B 是 A 的底座，绝不反向依赖）。`index.js` 依赖几乎所有 lib 模块（图中收敛为三族入口）；纯逻辑模块之间依赖极浅，跨模块共享的底座单列在图后。

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                index.js（编排入口：工具定义 / 端点 / 阶段机）             │
│     只做装配与调度；算法都在下游纯逻辑模块或 Python 引擎内部              │
└──────────────────────────────────────────────────────────────────────────┘
        │                       │                        │
        ▼                       ▼                        ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌───────────────────────────┐
│ 写作族               │ │ 增量族               │ │ 原生引擎族                 │
│ articles-agentic    │ │ update-planner      │ │ engine/native-run         │
│   ─► agentic        │ │   ─► graph-diff     │ │   ─► engine/client        │
│   ─► agentic-host   │ │   ─► symbols        │ │       ─► engine/contract  │
│   ─► article-       │ │   ─► incremental    │ │       ─► engine/process-  │
│       contract      │ │ incremental ─►      │ │           tree            │
│ agentic（零依赖：    │ │   graph-diff        │ │   ─► engine/quality-gate  │
│   workspace 与      │ │ change-set（纯，     │ │   ─► engine/apply-plan    │
│   streamFn 注入）    │ │   execFile 注入）    │ │   ─► engine/manifest      │
│ agentic-host ─►     │ │ update-record（纯）  │ │   ─► engine/llm-bridge    │
│   宿主 dsh-llm      │ │ cluster（纯，        │ │       ─► openai-bridge    │
│                     │ │   llmCall 注入）     │ │                           │
└─────────────────────┘ └─────────────────────┘ └───────────────────────────┘
        │                       │                        │
        ▼                       ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 外部边界                                                                  │
│  宿主 llm 服务（真实凭证；经 agentic-host 与 llm-bridge 两条适配边到达）   │
│  vendor/tree-sitter（WASM 可选；缺失时 symbols 降级正则提取）             │
│  FSoft codewiki（外部 Python 包；entry.py ─► stage_map.py 枚举对账）      │
└──────────────────────────────────────────────────────────────────────────┘

跨族共享底座（被多族依赖，单列避免连线爆炸）：
  lib/article-contract.js ◄── 写作族（写集闸门） + engine/quality-gate（渲染后契约）
  lib/graph-diff.js       ◄── incremental + update-planner（组件级 diff 底座）
  lib/engine/contract.js  ◄── client / native-run / quality-gate / openai-bridge
  lib/update-record.js    ◄── 消费 change-set + update-planner 产物；
                              文案与 engine/contract.describeEngineResult 同口径
```

依赖规则（未来 agent 改代码时必须维持）：

- **纯逻辑模块保持零宿主依赖**：`lib/agentic.js` 只认 `{role, content}` 裸消息与 `ContentBlock`（`lib/agentic.js:328-332`）；`lib/change-set.js` 通过 `opts.execFile` 注入 git 执行器；`lib/incremental.js` 的 IO 接受 `fsImpl` 注入；`lib/cluster.js` 的 `llmCall` 不传即走 `heuristicCluster`（`lib/cluster.js:219`）。破坏这条规则的改动会让整批离线测试失效。
- **适配层是唯一的宿主边界**：写作侧只有 `lib/agentic-host.js`（`makeHostStream`/`makeFsWorkspace`/`toRequestMessages`），原生侧只有 `lib/engine/llm-bridge.js` + `lib/engine/openai-bridge.js` + `lib/engine/client.js`。其余代码不得直接触碰宿主 `llm`、子进程或凭证。
- **契约词表单向共享**：`BLOCKER_KINDS` / `ENGINE_ERROR_CODES` / `ENGINE_STAGES` 定义在 `lib/engine/contract.js`，quality-gate 的 `toContractBlockers`（`lib/engine/quality-gate.js:589`）与 native-run 的 `settle` 只做翻译与校验，不允许各自造新枚举；Python 侧 `stage_map.py` 与 Node 侧必须双向对账（`test-engine-python-entry.mjs`）。
- **文章契约跨通道复用**：Node 写作通道用 `makeWriteSet`/`isWritable`（`lib/article-contract.js:365`/`:365`）做写集闸门；原生质量门渲染文章后复用同一文件的 `inspectArticle` 判 frontmatter/围栏/正文——两条通道共用同一份「什么算一篇合格文章」的定义。
- **测试对拍底座**：`lib/graph-diff.js` 与上游 Python `difflib` 逐位对齐，由 `test-fixtures/gen-graphdiff-golden.py` 离线生成 `test-fixtures/graphdiff-golden.json`，`test-graphdiff.mjs` 逐用例对拍；有意改动 diff 语义必须先重生成 golden。

## Module Roles

按族列出全部模块文章的职责与关键连接。再次提醒：`agentic_core` / `articles_agentic` / `prompt_helpers` 是同一批文件的三个切口，`engine_runtime` / `engine_protocol` / `engine_python` 是同一条链路的三个视角，细节请进入对应文章而不是在本文找重复。

**编排与面板（`index.js` 视角）**

- [[endpoint_helpers]] — `installWebServer`（`index.js:4624`）注册 7 个仅回环的 HTTP 端点（jobs / repos / sessions / sessions/item / models / model-efforts / control），供面板轮询与控制；`test-orchestration.mjs` 用 mock webServer + `fakeReq`/`fakeRes` 直接驱动同一批 handler。连接：读 JobService（`service.list/cancel`）、模型目录（`listModelCatalog`，`index.js:4562`）。
- [[git_helpers]] — git 命令快捷方式：worktree 识别（`detectLinkedWorktree`，`index.js:435`）、可编译性探测（`hasCompilableSources`，`index.js:478`）、产物自动提交 `autoCommitWiki`（`index.js:4952`）、待提交提醒 `commitHintText`。连接：增量路径调 [[change_set]]；落地器 apply-plan 复用其提交能力。
- [[repo_helpers]] — 仓库总览助手：`cw status` 三态解析（`parseStatus`，`index.js:294`）、已知仓库登记（`REPOS_FILE`）、`/api/codewiki/repos` 行组装。与 [[endpoint_helpers]]、[[git_helpers]] 共用同一套闸门。
- [[job_helpers]] — job 字段抽取与终态展示助手（该模块文章为占位骨架，细节见 `index.js` 与 [[update_record]] 的终态字段）。

**写作通道**

- [[agentic_core]] — agentic 通道四文件统筹：纯逻辑循环 `lib/agentic.js`（`runAgenticArticle`，`:331`，`DEFAULT_MAX_STEPS=30` 唯一定义点 `:325`）、宿主适配 `lib/agentic-host.js`、执行器 `lib/articles-agentic.js`、写集闸门依赖 `lib/article-contract.js`。核心契约：`runAgenticArticle(...) → { article, steps, usedTools, stopReason, messages }`。
- [[articles_agentic]] — 执行器视角：`runOneArticle`（`:33`，装配+落盘+子模块递归 `dispatchSub`）、`runAgenticArticles`（`:231`，双池并发与失败记账）、`markBigAgenticTasks`（`:320`，大档打标）。连接：上游 `index.js` 的 `tickArticles`/`startAgenticRun`；下游 [[agentic_core]] 与 [[agentic_host]]；失败过半回退单轮通道。
- [[agentic_host]] — 适配层细节：`toRequestMessages`（`lib/agentic-host.js:34`，裸消息→宿主 Message，`IDENTITY` WeakMap 保 MessageId 稳定，tool 一拆多）、`makeHostStream`（`:83`，BlockAssembler 收块，error/aborted 抛错）、`makeFsWorkspace`（`:111`，越界防护）。是写作族唯一的 llm/文件系统边界。
- [[prompt_helpers]] — `lib/agentic.js` 的三职责细看：`TOOL_SCHEMAS`（`:27-87`，工具声明即工作约定）、`buildOpeningPrompt`（`:506`）、观察工具（`numberLines` `:101`、`makeReadCodeTool` `:115` 带去重/截断/忽略目录）、文章编辑器（`makeArticleEditor` `:200`，CRLF 归一）、坏 JSON 容错（`parseToolArgs` `:476`）。

**规划与增量**

- [[symbol_extract]] — `extractRepoGraph`（`lib/symbols.js:785`）：17 语言表驱动 AST 提取（`LANG_RULES` `:36-271`，web-tree-sitter WASM 可选）+ 正则兜底（`regexExtract` `:374`），组件 id `<相对路径>#<符号名>`；`resolveImportEdges`（`:810`）补本仓库依赖边。下游：[[module_clustering]]、[[incremental]]、[[update_planner]]。
- [[module_clustering]] — `clusterComponents`（`lib/cluster.js:291`）三段式：顶层聚类 → 超大模块下钻（`subdivide` `:396`）→ 超级分组；`heuristicCluster`（`:219`）目录分组兜底，LLM 漏组件由 `fillMissing`（`:247`）补齐；`toPlanModules`（`:460`）产出 `job.plan.modules`。由 `index.js:346` 的 `semanticPlan` 调用。
- [[change_set]] — `collectChangeSet`（`lib/change-set.js:102`）四路 git 采集（committed/staged/unstaged/untracked）成可序列化 `ChangeSet`；失败态 `state` + `fallback:'full'`；`.codewiki/` 产物不计源码变更。喂 [[update_planner]] 与 [[update_record]]。
- [[graph_diff]] — `diffGraphs`（`lib/graph-diff.js:447`）组件级 diff：`codeHash`（`:108`）/`bodyHash`（`:121`）拉开「注释改动 vs 实质变化」、`pairRenames`（`:371`）相似度改名配对、unified body diff；与上游 Python 逐位对齐（golden：`test-fixtures/gen-graphdiff-golden.py` → `graphdiff-golden.json`，对拍 `test-graphdiff.mjs`）。
- [[incremental]] — 符号图快照存取（`slimGraph` `:37` / `loadSnapshot` `:94` / `saveSnapshot` `:106`，路径 `lib/incremental.js:106`）与核心判定 `filterStaleTasks`（`:140`，纯注释降级）。注意：生产主链路已升级为 [[update_planner]] 的 `planUpdate`，本函数保留为最小可验证单元。
- [[update_planner]] — `planUpdate`（`lib/update-planner.js:156`）增量计划器：`write/keep/review/delete` 四类显式 action（各带 reason）、反向依赖闭包（`dependentsOf` `:85`）、stale scan（`:106`）、无归属变更兜底（`unmappedChanges`/`needsFull`）、`buildModuleMap`（`:442`）模块归属。消费 [[change_set]] + [[graph_diff]] + [[symbol_extract]]。

**记账与终态**

- [[update_record]] — `judgeOutcome`（`lib/update-record.js:37`）从逐篇结果 + 计划判 `done/partial/failed/cancelled` 与 `canAdvanceBaseline`；`buildUpdateRecord`（`:131`）+ `saveUpdateRecord`（`:217`）落 `update-record.json`（不含整图）。文案 `describeOutcome`（`:241`）与引擎契约 `describeEngineResult` 同口径。

**原生引擎通道**

- [[engine_protocol]] — 跨语言边界总述：`lib/engine/contract.js`（版本/阶段/blocker/错误码词表 + `engineResult` 硬不变量 `:97`）、`lib/engine/client.js`（`runEngine` `:223`，JSON-lines 读取器 `createProtocolReader` `:39`，协议不变量：语义以 `result` 为准、退出码只表达进程层）、`lib/engine/process-tree.js`（`terminateProcessTree` `:61`，整树 SIGTERM→SIGKILL / taskkill /T /F）。
- [[engine_runtime]] — 生产链路视角：`manifest.js`（`doctor` `:141` 环境指纹与 `engine-lock.json` 比对，drift/unhealthy 分级）、`mapping.js`（FSoft docs 树 → cw 写集的唯一映射口径，`WIKI_ENTRY` `:30`）、`native-run.js`（`runNativeJob` `:68` 裁决链 + 最弱终态 `:41`）、process-tree。连接：模型经 [[engine_llm_bridge]]，产物经 [[engine_output]] 与 [[engine_quality_gate]]，落地经 apply-plan。
- [[engine_python]] — Python 侧唯一手写代码：`entry.py` 的 `_ProtocolOnly` stdout 守卫（`:59`，先于 `import codewiki` 安装）、四动作分发（`handle_request` `:552`）、模型通道读环境（`_model_config` `:243`，不落盘）、异常按类型翻终态（`_classify_exception` `:499`）；`stage_map.py` 五段→八段映射（`FSOFT_PROGRESS_CEILING=90` `:63`）。
- [[engine_llm_bridge]] — `startLlmBridge`（`lib/engine/llm-bridge.js:90`）：loopback HTTP 服务 + 每次随机占位 key + `/v1` 准入校验；红线是桥不读凭证、不转发 Authorization、日志不含密钥。
- [[engine_openai_bridge]] — 纯转换层（无 I/O/密钥）：`toLlmRequest`（`lib/engine/openai-bridge.js:128`）、`foldChunks`（`:192`，流式与非流式同源折叠）、`chunksToSse`（`:265`，必须 `[DONE]` 收尾）、usage 互斥计数折算（`:176`）。assistant 消息必须注入 `source`，否则宿主 `forAdapter` 抛错（回归见 `test-engine-bridge.mjs`）。
- [[engine_output]] — `collectOutput`（`lib/engine/output.js:91`）读 docs 树（坏输入变 problems 不抛）、`mapFsoftOutput`（`lib/engine/mapping.js:115`，四条硬规则：不臆造 source_files、不丢弃、不覆盖、不改正文）、`validateOutput`（`lib/engine/output.js:184`）自洽校验。
- [[engine_quality_gate]] — `gateNativeOutput`（`lib/engine/quality-gate.js:390`）采用门：defect（产品缺陷）/ degradation（能力降级，入库但不推基线）/ stale（wiki 状态陈旧）三类分流；复用 [[engine_output]] 的 `validateOutput` 与 `lib/article-contract.js` 的 `inspectArticle`；`toContractBlockers`（`:589`）/`toQualityIssues`（`:610`）供终态判定。
- [[fsoft_engine_fixtures]] — `tools/fsoft-engine/` 夹具与探针：中文空格路径 fixture 仓库、无 LLM 依赖图探针、真 `cw` 落地探针、假模型协议探针、`setup-env.sh` 环境三件套。硬约束：夹具产物只能引用真实存在的源文件，否则质量门全判 `source-missing`。

**测试基础设施**

- [[test_core]] — 全仓测试公共积木：`check`/`checkAsync` 断言宏、`makeCtx` 假宿主、`JOBS_FILE` 随机隔离、tick 加速等入口惯例。
- [[mock_helpers]] — 测试替身家庭：假 workspace（`test-agentic.mjs` 的 `makeWorkspace`）、脚本化假模型（`scripted`）、假宿主 llm（`test-agentic-host.mjs`/`test-engine-llm-bridge.mjs` 的 `fakeLlm`）、编排层 `llmProxy`+`makeBatchMock`（`test-orchestration.mjs`）、协议假引擎（`test-fixtures/fake-native-engine.mjs`，`FAKE_ENGINE_MODE` 一次只做一件事）。
- [[fixtures]] — golden 基准（`gen-graphdiff-golden.py` → `graphdiff-golden.json`，78 用例）、job/repo 造数工厂（`makeFixtureRepo`/`makeRepo`/`makeWiki`）、终态轮询 `waitJob`。注意各测试文件的 `makeRepo` 同名不同形，不共享。
- [[test_batch]] — `test-batch.mjs`：批量/纯函数阶段自测（`estimateTokens`、`collectSources`、`prepareArticleTasks`、双池 `runRealtimeTasks`、`fixAnchors` 回归、`validateArticleEnvelope`）与模型目录端点。
- [[test_wiki_misc]] — 杂项 wiki 校验：独立锚点校验脚本 `test-wiki-anchors.mjs`（结构事实硬失败、同步事实可降级）、`ensureWikiEntry`/`parseStatus`（`test-wiki-entry.mjs`）、`pruneOrphanModules` 孤儿清理边界（`test-prune-orphans.mjs`）、`semanticPlan` 端到端与降级（`test-semantic-plan.mjs`）。

**跨族关键连接（一眼索引）**

- 全量规划链：`semanticPlan`（`index.js:1393`）= [[symbol_extract]] → [[module_clustering]] → `toPlanModules`；任一环节失败退 `localPlan`（`index.js:1371`，纯目录分组）。
- 增量判定链：[[change_set]] → [[symbol_extract]]（`extractCurrentGraph`，`index.js:2220`）→ [[incremental]]（旧快照）→ [[graph_diff]] → [[update_planner]] → 写作任务。
- 写作→记账链：[[articles_agentic]]（或单轮 `runRealtimeTasks`）→ 写集闸门 [[agentic_core]] 引用的 `lib/article-contract.js` → `cw index` → [[update_record]] → 基线 → `autoCommitWiki`（[[git_helpers]]）。
- 原生链：[[engine_runtime]]（manifest/lock）→ [[engine_llm_bridge]] + [[engine_openai_bridge]]（模型桥）→ [[engine_python]]（entry.py→FSoft）→ [[engine_output]] → [[engine_quality_gate]] → apply-plan（复用 [[git_helpers]] 提交）→ [[engine_protocol]] 的契约词表收口终态。
- 两条通道的汇合点：`lib/article-contract.js`（同一份「合格文章」契约 + 写集闸门）与 `lib/update-record.js` / `lib/engine/contract.js`（同一套终态语义与文案口径）。
