---
title: app_client
type: module
source_files:
  - client.js
  - index.js
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - test-worktree.mjs
  - test-cwd-paths.mjs
  - test-sessions.mjs
  - test-prune-orphans.mjs
  - test-batch.mjs
  - test-semantic-plan.mjs
  - test-agentic-fallback.mjs
tags: [client, plugin-factory, entry-point, top-level-tests, regression-tests]
---

## Overview

模块 `app_client` 把两件职责并在一起：**顶层客户端入口工厂**（仓库根的 `client.js`，经 `window.__ModuleLoader__.load` 由宿主插件系统加载，id `@local/dsh-codewiki`，文件头标注 v0.4.1，第 1 行）与一组**杂项顶层测试**（仓库根的 `test-*.mjs`，它们直接 `import './index.js'` 或 `import './client.js'`，钉住的是「顶层入口 / 编译执行链 / 编译模型目录 / 孤儿清理 / 行号锚点 / worktree 闸门 / cwd 路径」这些贯穿全链路、不属于某个具体 `lib/` 子模块的行为）。

`client.js` 是浏览器半侧（用户态 UI）：它向宿主 `plugins.item` 槽位注入设置卡片 `CodewikiCard`（第 518-525 行、第 550-1038 行），向 `main` + `sidebar.panellist` 两个槽位注册编译面板 `CodewikiPanel`/`PanelIcon`（第 533-544 行、第 1426-1704 行），并通过 `apiGet`/`apiPost`（第 491-506 行）轮询宿主半侧 webServer 端点（`jobs` 2s、`repos` 10s、`sessions` 5s，`models`/`model-efforts`/`control` 按需）。它的完整组件清单、数据模型与前端细节已独立成篇 [[client-interface]]，本模块只站在「入口工厂视角」收口。

`index.js` 是 Node 半侧（编译执行链 + 工具注册）：本模块关心的顶层部分是 `apply(ctx, config)`（第 4817 行）这一入口——它注入 `agents`/`llm`、启动 `createJobService`、注册四个工具（`cw`、`codewiki_generate`、`codewiki_update`、`codewiki_progress`，第 4862-4878 行）、挂 `installWebServer`（第 4879 行）与收尾提醒（第 4880 行），以及编译执行链里被顶层测试重点覆盖的一批**纯函数出口**（`estimateTokens`、`collectSources`、`prepareArticleTasks`、`runRealtimeTasks`、`fixAnchors`、`classifySessionTask`、`buildSessionSteerText`、`scanRepoFiles`、`localPlan`、`semanticPlan`、`listModelCatalog`、`resolveModelEfforts`、`validateArticleEnvelope`、`pruneOrphanModules`、`shouldFallBackFromAgentic` 等，详见 Key Components）。

杂项顶层测试之所以单列，是因为它们多数直接驱动 `index.js` 的顶层导出函数，验证「编译流水线作为整体」的不变量（如「坏文章不入库」「部分失败仍判 partial」「孤儿清理只删 modules」「超预算不交会话也写完」「worktree/空壳不算编译对象」），而非某个 `lib/` 库的单元行为——后者各自有 `lib/` 专属测试（如 `test-symbols.mjs`、`test-cluster.mjs`、`test-agentic.mjs`）。

## Key Components

### 顶层客户端入口工厂 client.js

`client.js` 是一个浏览器半侧模块，整体由 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) { ... } })`（第 10-11 行、第 1703 行闭合）包裹。`factory` 内部引入 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（解构 `Switch`/`Button`/`Input`/`Tag`，第 13-15 行），并定义下列顶层结构与函数（完整前端细节见 [[client-interface]]）：

- `NS = 'codewiki'`（第 17 行）：插件命名空间 = profile patch 条目 id = 设置命名空间；`KEY = 'codewiki'`（第 18 行）：面板 key，须与 `sidebar.panellist` 的注册 id 一致。
- `JOBS_PATH = '/api/codewiki/jobs'`（第 19 行）、`CONTROL_PATH = '/api/codewiki/control'`（第 20 行）、`REPOS_PATH = '/api/codewiki/repos'`（第 23 行）、`SESSIONS_PATH = '/api/codewiki/sessions'`（第 24 行）、`SESSIONS_ITEM_PATH = '/api/codewiki/sessions/item'`（第 25 行）、`MODELS_PATH = '/api/codewiki/models'`（第 26 行）、`EFFORTS_PATH = '/api/codewiki/model-efforts'`（第 27 行）：七条回环端点的路径常量。
- `PANEL_ORDER = 52`（第 21 行）、`POLL_MS = 2000`（第 22 行）、`REPOS_POLL_MS = 10000`（第 31 行）、`GENERIC_EFFORTS = ['off','low','medium','high','xhigh','max']`（第 30 行）、`ACTIVE_STAGES = ['queued','articles','crosscut','compose','review','index','commit']`（第 33 行）。
- `zh()`（第 35-210 行）/ `en()`（第 211-386 行）：中英文词典，键集一致，经 `ctx.locale.register(NS, { zh: zh(), en: en() })`（第 512 行）注册。
- `style` 元素（第 388-483 行）：注入 `data-dscw-*` / `data-dscw-p-*` CSS；HMR 去重（第 485 行）。
- `el(tag, props, ...children)`（第 487-489 行）：`React.createElement` 包装。
- `apiGet(p)`（第 491-496 行）/ `apiPost(p, data)`（第 497-506 行）：封装对宿主 `webServer` 端点的 GET/POST，非 2xx 抛 `body.error || HTTP {status}`。
- 返回值 `return { inject: ['slots','locale','configForms'], apply(ctx) { ... } }`（第 508-510 行）：`apply(ctx)`（第 510-544 行）是真正的挂载入口——注册词典、`whileServed` 守卫下挂 `plugins.item`（第 518-527 行），`ctx.effect` 内注入 `main` + `sidebar.panellist` 双槽位并返回 disposers（第 533-544 行）。
- 内部组件：`CodewikiCard`（第 550-1038 行，设置卡片）、`ReposTab`（第 1184-1328 行，总览）、`SessionView`（第 1334-1424 行，会话）、`CodewikiPanel`（第 1426-1686 行，主面板）、`PanelIcon`（第 1688-1699 行，侧栏图标）。

### 顶层入口 apply 与工具注册 index.js

`index.js` 是 Node 半侧编译执行链与工具注册的顶层入口。本模块聚焦于 `apply` 与编译执行链中被顶层测试覆盖的纯函数出口：

- `export function apply(ctx, config)`（第 4817-4881 行）：插件入口。注入 `agents`/`llm` 引用（第 4818-4819 行）；`createJobService(config, wakeCompileSession)` 启动服务（第 4820-4821 行，effect 返回 `() => service.stop()` 作 disposer，第 4824 行）；构建 `generateDef`（第 4825 行）与 `updateDef`（第 4826 行）；启动 60s 自动更新调度 `autoScan`（第 4831-4861 行）；`ctx.inject(['tools'], ...)` 注册四个工具定义 `cwToolDefinition(config)`、`generateDef`、`updateDef`、`progressToolDefinition(config, service)`（第 4862-4878 行，单工具 schema 违规只丢该工具、catch 后不炸回调）；最后 `installWebServer`（第 4879 行）与 `installUpdateReminder`（第 4880 行）。
- 工具定义工厂（均在 `index.js`）：`generateToolDefinition(cfg, svc)`（第 3714 行，`codewiki_generate`）、`cwToolDefinition(config)`（同文件，`cw` 薄封装）、`updateToolDefinition(config, generateDef)`（第 4088 行，`codewiki_update`）、`progressToolDefinition(cfg, svc)`（第 4119 行，`codewiki_progress`）。`progressView(job)`（第 4113-4117 行）、`samePath(a,b)`（第 4108-4111 行）为进度视图辅助。
- `export function pruneOrphanModules(job)`（第 271-296 行）：全量编译收尾删孤儿模块文章；非 `kind==='full'` 或有空 modules 清单即跳过（第 274-276 行），只删 `.codewiki/modules/*.md`（第 280-287 行），失败记账不抛错（第 288-294 行）。
- `export function ensureWikiEntry(cwd, language)`（第 301-334 行）、`export function normalizeArticlePath(p)`（第 209 行）、`export function normalizeIndexLinks(cwd)`（第 213-221 行）、`export function parseStatus(stdout)`（第 223-236 行）、`export function detectLinkedWorktree(cwd)`（第 364-380 行）、`export function isWorktreeCwd(cwd)`（第 388-399 行）、`export function hasCompilableSources(cwd)`（第 407-421 行）、`export function clearSourceProbeCache(cwd)`（第 423-426 行）、`export function isDeadCompileTarget(cwd)`（第 433-441 行）：cw 工具执行辅助与 worktree/空壳闸门。
- `export function estimateTokens(text)`（第 449-457 行）：CJK≈1 token/字、ASCII≈3.5 字符/token 的粗算；`export function numberLines(content)`（第 679-681 行）：给每行加 `N| ` 前缀（弱模型数行兜底）。
- `export function fixAnchors(content, cwd)`、`export function changelogSections(clLines)`（第 699-707 行）、`export function fixChangelogAnchors(content, cwd)`（第 709 行起）：落盘前行号锚点确定性校正（第四层兜底）。
- `export function classifySessionTask(task, nowMs)`（第 2032 行起）：会话通道收割三态 `timeout`/`harvest`/`wait`；`buildSessionSteerText`（调用见第 2822 行）：会话通道 steer 文本，`sessionTier` 非空时钉死档位。
- `export async function runRealtimeTasks(tasks, opts)`（第 591-650 行）：唯一执行器（宿主 llm 服务），大档/默认档分池限流。
- `export function listModelCatalog(llm)`、`export async function resolveModelEfforts(llm, provider, model)`（第 4303-4325 行）：设置页级联下拉的数据源；`export function installWebServer(ctx, service, extra)`（第 4327 行起）：注册 `jobs/repos/sessions/sessions/item/models/model-efforts/control` 七个回环端点。
- 编译执行链纯函数出口（被 `test-batch.mjs` 等驱动，定义分布在 `index.js` 中部）：`collectSources`、`prepareArticleTasks`、`packArticles`、`scanRepoFiles`、`localPlan`、`semanticPlan`、`validateArticleEnvelope`、`shouldFallBackFromAgentic`（agentic 失败过半判定，被 `test-agentic-fallback.mjs` 调用）、`analyzeCompileModelMissing` 等；以及 `extractCurrentGraph`、`currentCommit`（被 `test-incremental-e2e.mjs` 调用，第 7 行）。
- 会话记录导出：`SESSIONS_DIR`、`listSessionRecords`、`readSessionRecord`、`pruneSessionRecords`、`listAllSessionRecords`（被 `test-sessions.mjs` 调用，第 8 行）。

### 杂项顶层测试（top-level tests）

下列仓库根 `test-*.mjs` 直接驱动 `index.js`/`client.js` 顶层导出，钉住跨子模块的不变量（与 `lib/` 专属单测互补）：

- `test-wiki-entry.mjs`（77 行）：`ensureWikiEntry`（缺失生成/中英双语/已有不覆盖/空 cwd 安全返回，第 27-54 行）、`normalizeArticlePath`/`parseStatus`/`normalizeIndexLinks` 的 Windows 反斜杠规范化（第 57-72 行）。
- `test-wiki-anchors.mjs`（404 行）：对 `.codewiki/` 文章的 `file:NN(-MM)` 行号锚点做新鲜度感知校验——硬断言（越界/区间无序）始终失败，软报告（符号未绑定/CHANGELOG 版本节）滞后时才降级；以「工作区 ∪ HEAD ∪ 编译基线」三版源码为基准（第 41-118 行），与 `fixAnchors`（index.js 内 `fixAnchors` 函数）的符号绑定语义同源（多锚点行注释见第 204-211 行）。
- `test-worktree.mjs`（84 行）：`detectLinkedWorktree`（三态，第 38-53 行）、`isWorktreeCwd`（带缓存布尔封装，第 56-62 行）、`hasCompilableSources`（空壳判定，第 68-70 行）、`isDeadCompileTarget`（worktree/空壳算 dead、不存在目录不算，第 73-77 行）。
- `test-cwd-paths.mjs`（72 行）：直接 `plugin.apply` 后用 `cw` 工具 `execute` 覆盖三种 cwd 形态（MSYS `/e/...`、Windows `E:/...`、`/q/nonexistent` 干净报错，第 34-69 行）。
- `test-sessions.mjs`（69 行）：`listSessionRecords`/`readSessionRecord`/`pruneSessionRecords`/`listAllSessionRecords` 三导出 + TTL 清理（`SESSIONS_DIR` 删除后重建，第 7-13 行；TTL 25h 前推，第 46-63 行）。
- `test-prune-orphans.mjs`（200 行）：`pruneOrphanModules` 安全边界——只删 full + 规划外的 `modules/*.md`、保留 concepts/`_architecture.md`、增量不动、失败文章保留、空清单不删、slug 规则一致（第 33-195 行）。
- `test-batch.mjs`（643 行）：编译执行链自检——`estimateTokens`/`collectSources`/`numberLines`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`packArticles`/`scanRepoFiles`/`listModelCatalog`/`resolveModelEfforts`/`installWebServer`/`fixAnchors`/`validateArticleEnvelope` 全覆盖；含大档分池限流、会话通道收割三态、`0.10.1` 删除内置百炼直连通道（`resolveBatchApiKey` 不再导出，第 521 行）。
- `test-semantic-plan.mjs`（190 行）：`semanticPlan`（AST 提取→聚类→模块清单）三场景——有模型走 LLM、无模型降级目录、坏 JSON/抛错降级、`localPlan` 保活、plan 不携带源码（第 38-184 行）。
- `test-agentic-fallback.mjs`（127 行）：`shouldFallBackFromAgentic`（严格过半触发退回，第 27-51 行）与 `prepareArticleTasks` 重排任务可装填性（缺 mission/源码缺失仍产任务，第 59-98 行）。

注：另有若干顶层 `test-*.mjs` 已进入各自子模块文章（如 `test-symbols.mjs`→[[symbol_extraction]]、`test-cluster.mjs`→[[change_set]]/[[update_planner]] 范畴、`test-agentic.mjs`→agentic 执行、`test-orchestration.mjs`→[[integration-test-suites]]、`test-engine-*.mjs`→引擎桥范畴），本模块不再重复。

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│ client.js — 浏览器半侧入口工厂（10-1704）                  │
│ window.__ModuleLoader__.load({id:'@local/dsh-codewiki'})  │
│ factory(require) → React + primitives（13-15）            │
│ apply(ctx)（510-544）：plugins.item（518-527）            │
│                          main + sidebar.panellist（533-544）│
└─────────┬──────────────────────────────┬─────────────────┘
          ▼ CodewikiCard（550-1038）      ▼ CodewikiPanel（1426-1686）
          ▼ CodewikiPanel 设置 tab 回嵌    ReposTab/SessionView
          └── apiGet/apiPost（491-506）→ /api/codewiki/*

┌──────────────────────────────────────────────────────────┐
│ index.js — Node 半侧入口 apply(ctx,config)（4817-4881）    │
│ createJobService（4820）→ tools.register（4862-4878）      │
│   cw / codewiki_generate / codewiki_update / codewiki_progress│
│ installWebServer（4879）/ installUpdateReminder（4880）    │
│ ┌─ 纯函数出口（被 test-batch/semantic-plan/prune 等驱动）─┐│
│ │ estimateTokens·collectSources·prepareArticleTasks       ││
│ │ runRealtimeTasks（大档/默认档分池 591-650）             ││
│ │ fixAnchors·validateArticleEnvelope·scanRepoFiles        ││
│ │ localPlan·semanticPlan·listModelCatalog·resolveModelEfforts│
│ │ pruneOrphanModules(271)·detectLinkedWorktree(364)       ││
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────┬───────────────────────────────┘
                           ▼
  杂项顶层 test-*.mjs（仓库根）：import './index.js' 直接断言纯函数出口
  test-wiki-entry / test-wiki-anchors / test-worktree / test-cwd-paths
  test-sessions / test-prune-orphans / test-batch / test-semantic-plan
  test-agentic-fallback
```

## Data Flow

1. **客户端加载**：宿主插件系统在页面加载时执行 `window.__ModuleLoader__.load`（client.js 第 10 行）→ `factory(require)`（第 12 行）建样式表（第 388-483 行，HMR 去重第 485 行）→ 返回带 `apply(ctx)` 的描述符（第 508-510 行）。宿主调用 `apply`：`tBound` 绑定（第 511 行）、词典注册（第 512 行）、取 `form`（第 515 行）、`whileServed` 守卫下挂 `plugins.item`（第 518-527 行）、`ctx.effect` 挂双 slot（第 533-544 行）。
2. **Node 侧入口**：宿主调用 `index.js` 的 `apply(ctx, config)`（第 4817 行）→ 注入 `agents`/`llm`（第 4818-4819 行）、`createJobService` 启动并登记 disposer（第 4820-4824 行）、构造 `generateDef`/`updateDef`（第 4825-4826 行）、60s 自动调度 `autoScan`（第 4831-4861 行）、注册四个工具（第 4862-4878 行）、`installWebServer`（第 4879 行）、`installUpdateReminder`（第 4880 行）。
3. **编译执行链（被 test-batch 等断言）**：`codewiki_generate` 经 `submit`（第 ~3642 行）建 job 并校验编译模型来自模型设置（第 3645-3656 行）→ 阶段机 tick（articles→crosscut→compose→review→index→commit）→ `prepareArticleTasks` 装填 prompt（观察批拆分/大档单请求，见 test-batch 第 55-132 行）、`runRealtimeTasks` 经宿主 llm 服务并发执行（第 591-650 行，大档/默认档分池）、`fixAnchors` 落盘前校正（index.js 中 `fixAnchors` 函数定义于第 567 行附近，由 `applyTaskResult` 调用）、`pruneOrphanModules` 全量收尾清理（第 3381 行被调用）。
4. **worktree/空壳闸门**：`detectLinkedWorktree`（第 364 行）用 `git rev-parse --git-dir/--git-common-dir` 判 linked worktree；`isWorktreeCwd`（带 60s 缓存，第 388 行）与 `hasCompilableSources`（带 10 分钟缓存，第 407 行）供面板 2s 轮询与 `autoScan`（第 4844-4848 行）调用，`isDeadCompileTarget` 统一判定（第 433 行）。
5. **会话记录**：每轮 LLM 请求经 `beginSessionRecord` 落盘到 `SESSIONS_DIR`，`test-sessions.mjs` 验证 `list/read/prune` 与 TTL 清理（25h 前推，第 46-63 行）。

## Connections

- [[client-interface]]：`client.js` 的浏览器半侧完整组件（CodewikiCard/CodewikiPanel/ReposTab/SessionView/PanelIcon）、数据模型与前端细节独立成篇，本模块只收口其「入口工厂」职责。
- [[core-application]] / [[core-and-config]]：本模块 `index.js` 的 `apply`（第 4817 行）与编译执行链、`installWebServer`（第 4327 行）注册的七条回环端点（`jobs`/`repos`/`sessions`/`sessions/item`/`models`/`model-efforts`/`control`）由宿主半侧服务实现；`Config` schema 与 `liveConfig`（第 70-144 行）是设置的唯一权威，`client.js` 仅是同命名空间 `codewiki` 的可视编辑前端。
- [[configuration-and-metadata]]：设置键全集语义与 volatile 热生效规则，对照 `test-batch.mjs` 中 `listModelCatalog`/`resolveModelEfforts` 拉取的数据源（第 411-516 行）。
- [[update_planner]] / [[update_record]] / [[change_set]] / [[symbol_extraction]] / [[incremental]] / [[graph_diff]] / [[articles_agentic]]：这些 `lib/` 子模块各自有专属单测（`test-update-planner.mjs`、`test-update-record.mjs`、`test-change-set.mjs`、`test-symbols.mjs`、`test-incremental*.mjs`、`test-graphdiff.mjs`、`test-articles-agentic.mjs`、`test-agentic*.mjs`），本模块的 `test-batch.mjs`/`test-semantic-plan.mjs` 只在「顶层整链」层面覆盖它们被 `index.js` 装填/编排的部分。
- [[integration-test-suites]]：`test-orchestration.mjs`（1552 行，服务化编排冒烟）与 `test-incremental-e2e.mjs` 端到端测试归类于此；本模块的杂项测试是它们之下的「纯函数/闸门」层。
- [[wiki-tests]]：`test-wiki-entry.mjs`（入口生成与 Windows 路径）、`test-wiki-anchors.mjs`（行号锚点校验）在该范畴有交叉，本模块从「顶层测试驱动 index.js 出口」角度描述。
- [[engine_contract]] / 引擎桥范畴（`test-engine-*.mjs`）：本模块不涉及 Python 跨进程边界，`test-engine-*.mjs` 属 FSoft 原生引擎适配子模块。

## Known Issues

- `test-prune-orphans.mjs` 第 186-195 行的用例显式钉死一条契约偏移：「非空但残缺的 plan（modules 数组不含全部当前文章）时，清理器会把它当全集、把其余孤儿全删」（第 194 行 `removed` 含三条孤儿）。这是 index.js `pruneOrphanModules`（第 271-296 行）的当前行为——只要 `plan.modules` 非空就当真，清单完整性由编排侧保证；未来若给 plan 加 `completeness` 标志，该用例须同步改。
- `test-cwd-paths.mjs` 第 8 行把默认仓库路径硬编码为 `E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin`，需通过 `node test-cwd-paths.mjs <Windows 形式路径>` 传真实仓库参数才能跑通，否则只验证 MSYS 归一化推导；它依赖 PATH 上的真实 `cw` 与已编译的 `.codewiki`（第 41-44 行断言 `cw path → .codewiki`）。
- `test-wiki-anchors.mjs` 的「新鲜度」判据依赖 `.codewiki/_meta.yaml` 的 `last_compiled_commit`（第 86-91 行）：无基线（非 git 仓库/基线不可达）时一律按滞后处理、只软报告不硬失败（第 272 行），意味着新仓库首次编译后直接跑该测试不会硬卡失效锚点，需 `--strict`（第 39 行）或先重编译把基线前移才升为硬断言。
- `client.js` 的 `apply` 在宿主未提供 `configForms.whileServed`（第 526 行）时直接 `mount()`（第 529 行），旧宿主/测试 ctx 会因此把插件页直接挂上；属兼容行为，非缺陷，但意味着没有 `whileServed` 守卫时插件停用也不卸载设置页（[[client-interface]] 第 64 行亦有说明）。
- 本模块文章不重复 client.js 内部样式/组件实现的行级细节（见 [[client-interface]]），也不重复各 `lib/` 库的单元行为，两处若有行号更新须回到对应子模块文章同步。
