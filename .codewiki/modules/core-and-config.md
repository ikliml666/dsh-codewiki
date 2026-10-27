---
title: core-and-config
type: module
source_files:
  - index.js
  - package.json
  - cordis.patch.yml
  - .gitignore
  - test-wiki-entry.mjs
  - test-prune-orphans.mjs
tags: [core, config, plugin-entry, assembly, constants, dsh-codewiki]
---

## Overview

本模块是 `dsh-codewiki` 插件的核心代码与项目配置集合里的「核心常量 / 插件装配 / 入口」一层。它横跨四个文件：`index.js`（宿主半侧主入口，当前版本 4882 行）、`package.json`（包定义，当前版本 **0.14.0**）、`cordis.patch.yml`（cordis 挂载补丁）与 `.gitignore`（git 忽略规则）。插件把本地 `cw` CLI（`mraza007/codewiki` 的 Rust 二进制）接入 DeepSeek Harness，提供整仓 wiki 编译流水线。

注意模块边界：本仓 wiki 已把整体切为多个模块，`core-and-config` 只覆盖**核心常量、配置数据模型、插件装配入口 `apply` 与静态元数据文件**这几件事；编译流水线的阶段机、`cw` 工具封装、回环 webServer 等被拆到 [[core-application]]，浏览器半侧 `client.js` 拆到 [[client-interface]]，`Config` 每个字段的归一化细节与快照元数据拆到 [[configuration-and-metadata]]。本文只点出它们与本层的关系，不重复其内部行号。

`index.js` 文件头注释（第 1-7 行）现在声明注册 **三个工具**：`cw`（薄封装 CLI，第 1599 行 `cwToolDefinition`）、`codewiki_generate`（服务化编译提交，第 3714 行 `generateToolDefinition`）、`codewiki_progress`（只读进度，第 4119 行 `progressToolDefinition`）。注意：`codewiki_update`（第 4048 行 `updateToolDefinition`）是 `codewiki_generate` 的固定 `scope=auto` 快捷入口，仍会被 `apply` 一并注册（第 4865 行），所以工具注册实际是 **4 个**，但 `index.js` 头注释只把 `codewiki_update` 视作 `generate` 的派生别名。

所有模型环节走插件内后台并发池（唯一通道 = 宿主 `llm` 服务，`llmChat` 第 467 行），默认 `workbuddy/hy3`（192k 上下文，单请求输入预算 110k，`BATCH_TOKEN_BUDGET` 第 663 行）；单文件超预算改用大档 `volces-ark/glm-5.3-flash`（512k，`DEFAULT_BIG_*` 常量第 49-52 行）。**零子代理**——唯一的兜底旁支是「会话通道」（单文件连大档都装不下时转交发起会话派子智能体），由 `dispatchSessionTasks`（第 2797 行）和 `buildSessionSteerText`（第 2049 行）负责，详见 [[core-application]]。

`package.json` 声明 `name: "@local/dsh-codewiki"`（第 2 行）、`version: "0.14.0"`（第 3 行）、`exports` 双入口（`.`→`index.js`、`./client`→`client.js`，第 8-11 行）、`dsh.client.platform: web`、`dsh.bundle.patch: cordis.patch.yml`（第 20-27 行）。`cordis.patch.yml` 用 `insert` 把 `index.js` 注册为 id `codewiki` 的插件（第 19-24 行），设置命名空间 `codewiki`。`.gitignore` 排除依赖目录、cw fork 构建产物、cw 二进制备份与 DSH 运行期产物（第 1-12 行）。

## Key Components

本模块负责的核心常量、配置数据模型、插件装配入口与静态元数据文件如下。编译流水线、webServer、会话通道等实现函数不在此重复（见 [[core-application]]）。

### 插件标识与路径常量（`index.js`）

- `36| const pluginDir = path.dirname(fileURLToPath(import.meta.url))` — 插件目录绝对路径，用于定位捆绑二进制 `bin/cw(.exe)`。
- `37-38| PLUGIN_NAME = 'dsh-codewiki'` 与 `export const name` — 插件名（与 `package.json` 第 2 行一致）。
- `39| CW_SUBCOMMANDS = ['init','status','index','meta','path','projects','setup','uninstall']` — `cw` 工具子命令白名单（`cwToolDefinition` 第 1646 行校验）。
- `41| CONCURRENCY_HARD_CAP = 8`、`43| DEFAULT_CONCURRENCY = 2` — 并发硬顶与默认档值（hy3 免费档）。
- `45-46| DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'` — 默认编译模型（免费、192k 上下文）。
- `49-52| DEFAULT_BIG_PROVIDER='volces-ark'`、`DEFAULT_BIG_MODEL='glm-5.3-flash'`、`DEFAULT_BIG_TOKEN_BUDGET=420000` — 大档模型：单批输入超普通预算 110k 时改用 512k 上下文模型，仍在插件内跑完。
- `55| WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` — 自动提交、忽略检测、待提交提醒共用的唯二 pathspec；刻意不扩成 `-A`（详见 Known Issues）。
- `663-668| BATCH_TOKEN_BUDGET = 110000`、`BATCH_TOKEN_HARD_LIMIT = 128000` — 单请求输入预算与兜底装填上限（hy3 窗口 192k 为输入+输出共享，单请求输出上限 64k，故输入 ≤128k）。

### 持久化 / 节拍 / 会话路径常量（`index.js`）

- `1876| JOBS_FILE`（`%TMP%/dsh-codewiki-jobs.json`，测试可用 `DSH_CODEWIKI_JOBS_FILE` 隔离，第 1875 行注释）。
- `1877| TICK_MS = Math.max(250, Number(process.env.DSH_CODEWIKI_TICK_MS) || 10000)` — 默认 10000，每拍推进 job 阶段机。
- `1881| SESSION_TASK_TIMEOUT_MS`（默认 30 分钟）、`1882| SESSION_TASK_DIR` — 会话通道任务文件目录与超时。
- `1892-1894| SESSION_TTL_MS`（24h）、`export const SESSIONS_DIR`（`path.dirname(JOBS_FILE)/dsh-codewiki-sessions`）、`SESSION_FLUSH_MS=3000` — 会话内容记录保留期与流式节流写间隔。
- `2069| ORPHAN_TAKEOVER_MS`（默认 5 分钟）、`2070| MAX_JOBS_KEPT=30` — 孤儿接管阈值、job 历史截断数。
- `2075| REPOS_FILE`（`dsh-codewiki-repos.json`）— 已知仓库清单，独立于 job 历史。
- `2179| JOBS_LOCK_FILE = \`${JOBS_FILE}.lock\`` — 跨进程推进锁（60s 过期强删）。
- `2107-2119| SCAN_SKIP_DIRS / SCAN_SKIP_EXT / SCAN_MAX_FILE_BYTES=256*1024 / SCAN_MAX_FILES=2000` — `scanRepoFiles` 黑名单与上限。
- `2121-2144| export function scanRepoFiles(cwd)` — 仓库源码扫描（本地规划/符号提取输入）。
- `385| WORKTREE_CACHE_TTL_MS=60000`、`405| SOURCE_PROBE_TTL_MS=10*60*1000`、`2258| agentsRef`、`2263| llmRef` — worktree/源码探测缓存、服务引用。

### 配置数据模型（指向 [[configuration-and-metadata]]）

- `70-96| export const Config = z.object({...})` — 基于 `@deepseed-ai/schemastery` 的配置对象，**全部字段 `.volatile()`**（不持久化到磁盘）。25 个字段名与默认见 [[configuration-and-metadata]] 的字段表。
- `98-100| function val(x)` — 从 cordis 配置容器取值（`.get()` 或原值）。
- `102-144| function liveConfig(config)` — 配置归一化：大档预算下限钳到 `BATCH_TOKEN_BUDGET`、默认档并发钳 1–8、大档并发 0=跟随默认档、并行仓库上限 1–4（`parallelLimit` 第 125-129 行）、planMode 白名单 `auto|dirs`、`agenticMaxSteps` 1–100、`autoUpdateMin` 最小 5。

### 插件装配入口（`index.js`）

- `4817-4882| export function apply(ctx, config)` — cordis 插件装配入口。职责：
  - `4818-4819` 经 `ctx.inject(['agents'])`/`ctx.inject(['llm'])` 取 `agentsRef`/`llmRef` 服务引用（`llm` 未注入则 `submit` 报「llm 服务未注入」）。
  - `4820-4821` 创建并 `start()` 后台编排服务 `createJobService`（第 2295 行，阶段机见 [[core-application]]）。
  - `4824` 经 `ctx.effect` 注册服务 stop disposer。
  - `4825-4826` 构造 `generateToolDefinition` 与 `updateToolDefinition`（复用前者 `execute`）。
  - `4831-4860` 自动更新调度器 `autoScan`：60s 心跳，到点对历史工作区逐个 `scope=auto` 判态提交（幂等，单仓库失败只记 `schedState.lastError`）。
  - `4862-4878` 经 `ctx.inject(['tools'])` 注册四个工具（`cwToolDefinition`/`generateDef`/`updateDef`/`progressToolDefinition`，第 4865 行数组），单工具 schema 违规只丢该工具。
  - `4879` `installWebServer(ctx, service, {config, schedState, compile})`（第 4327 行，回环端点见 [[core-application]]）。
  - `4880` `installUpdateReminder(ctx, config)`（第 4783 行，会话系统提示注入）。

### 静态元数据文件

- `package.json`（第 1-28 行）：`name`=第 2 行、`version`=第 3 行（**0.14.0**）、`exports` 第 8-11 行、`dsh.client.platform`=第 21-23 行、`dsh.bundle.patch`=第 24-26 行、依赖仅 `@deepseek-ai/schemastery`（第 17-19 行）。
- `cordis.patch.yml`（第 1-33 行）：注释说明 0.13.0 吸入 CodeWiki 三层能力、挂载方式（bundle 用本文件，本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂），第 19-24 行 `- insert:` 注册 `id: codewiki`、`name: file:///E:/.../dsh-codewiki/index.js`、`config: {}`。默认配置不在此重复声明，留空即取 `index.js` 的 `Config` 默认值。
- `.gitignore`（第 1-12 行）：排除 `node_modules/`、`vendor/codewiki/target/`、日志、`bin/*.bak-*`、`.orch-test-out.txt`、`.probe3.txt`、`.dsh-ops/`（面板会话流与工具调用记录）。

### 与本层直接相关的导出函数（行号以当前 `index.js` 为准）

- `38| export const name`、`209| normalizeArticlePath`、`213| normalizeIndexLinks`、`223| parseStatus`、`301| ensureWikiEntry`、`339-350| excludedItem/isExcluded`、`364| detectLinkedWorktree`、`388| isWorktreeCwd`、`407| hasCompilableSources`、`423| clearSourceProbeCache`、`433| isDeadCompileTarget`、`449| estimateTokens`、`856| fixAnchors`、`1082| validateArticleEnvelope`、`1094| collectSources`、`1300| localPlan`、`1322| semanticPlan`、`1409| packArticles`、`1293| shouldFallBackFromAgentic`、`1670| slugify`、`1676| parseSourceFiles`、`1690| readSourceFiles`、`1845| currentCommit`、`1893| export const SESSIONS_DIR`、`1914| listSessionRecords`、`1924| readSessionRecord`、`1930| listAllSessionRecords`、`1952| pruneSessionRecords`、`2032| classifySessionTask`、`2049| buildSessionSteerText`、`2090| export function forgetRepo`、`2149| extractCurrentGraph`、`2271| autoCommitState`、`2278| wakeCompileSession`、`3377| pruneOrphanModules`（注：源码中函数名为 `pruneOrphanModules`，旧文章 `pruneOrphanModules` 拼写有误）、`4265| listModelCatalog`、`4303| resolveModelEfforts`、`4655| autoCommitWiki`、`4739| commitHintText`、`4817| apply`。

### 相关单测（本层行为）

- `test-wiki-entry.mjs`（第 1-76 行）：覆盖 `ensureWikiEntry`（缺失生成/中英双语/不覆盖）、`normalizeArticlePath`/`parseStatus`/`normalizeIndexLinks`（Windows `\`→`/`）。
- `test-prune-orphans.mjs`（第 1-199 行）：覆盖 `pruneOrphanModules`（增量/失败文章/非 modules 目录不得误删）。

## Architecture

`apply`（第 4817 行）是插件加载时的唯一装配入口：经 cordis `inject` 拿到 `agents`/`llm` 服务引用，创建并 `start()` 后台编排服务 `createJobService`（第 2295 行，每 `TICK_MS=10000` 一拍推进 job 阶段机），同时注册四个工具、起 `installWebServer`（第 4327 行）、起 60s 自动更新调度 `autoScan`（第 4831 行）、注入会话提醒 `installUpdateReminder`（第 4783 行）。浏览器半侧 `client.js` 是独立进程，只轮询回环端点、经 `configForms` 读写 `codewiki` 命名空间配置，与本进程无直接函数调用（详见 [[client-interface]]）。

```text
┌─────────────── index.js（宿主进程，4882 行）──────────────┐
│ apply(4817) inject agents/llm → agentsRef/llmRef           │
│   ├ createJobService(2295).start()  ← setInterval TICK_MS  │
│   │     tick(3491) → STAGE_HANDLER(3482) 阶段机            │
│   ├ 注册 4 工具(4865): cw / codewiki_generate /            │
│   │            codewiki_update / codewiki_progress          │
│   ├ installWebServer(4327) → /api/codewiki/{jobs,repos,    │
│   │            sessions,models,model-efforts,control}      │
│   ├ autoScan(4831) 60s 心跳 → generateDef.execute(scope=auto)│
│   └ installUpdateReminder(4783) → systemPrompt.section      │
│                                                            │
│ 静态配置：Config(70) / liveConfig(102) / WIKI_PATHS(55)     │
│ 常量：JOBS_FILE(1876) SESSIONS_DIR(1893) TICK_MS(1877)     │
└────────────────────────────────────────────────────────────┘
        ▲ HTTP 回环（isLoopbackRequest 4230 守卫）
┌─────────────── client.js（浏览器进程，1704 行）────────────┐
│ NS='codewiki' 经 configForms 读写设置；轮询 /api/codewiki/* │
└────────────────────────────────────────────────────────────┘

  cw 子进程 (Rust CLI)        模型生成（唯一通道=宿主 llm.stream）
  generateTool(3714) ─runCw(172)─► [cw init/status/index/  cwToolDefinition(1599)
      meta/path]                 runRealtimeTasks(591)─llmChat(467)─►[llm 服务]
  installWebServer/autoCommit─► git/spawnSync ─► [.codewiki/ + CodeWiki.md]
```

阶段机由 `STAGE_HANDLER`（第 3482-3489 行）映射：`articles`→`crosscut`→`compose`→`review`→`index`→`commit`，各阶段处理器 `tickArticles`(2879)/`tickCrosscut`(3098)/`tickCompose`(3184)/`tickReview`(3233)/`tickIndex`(3346)/`tickCommit`(3465)。每阶段把 prompt 交给后台并发池 `startBatchChatRun`（第 2629 行）或 `startAgenticRun`（第 2676 行），结果进 `batchResults`（第 2627 行）由 `settleJob`（第 2460 行）收割，经 `tally`（第 2550 行）/ `writeValidated`（第 2522 行）记账落盘。

## Data Flow

插件装配与编译提交主链（`apply` → `codewiki_generate` → `createJobService`）：

1. `apply`（第 4817 行）经 `ctx.inject(['llm'])` 取 `llmRef`；`createJobService`（第 2295 行）加载 `JOBS_FILE`（第 1876 行）历史、种子已知仓库、清理 Temp/死亡编译目标，起 10s tick。
2. 工具 `codewiki_generate`（第 3714 行 `generateToolDefinition`）`execute`：`liveConfig` 判 `enabled`→`parseStatus`（第 223 行）判态；`scope=auto/full/stale` 走 `cw status` + `wikiPathFor`（第 1854 行）；幂等返回已有活动任务（第 3808 行 `findActive`）；增量路径 `runStaleUpdate`（第 3835 行）用 `collectChangeSet`/`planUpdate` 预建 `kind:'stale'` 任务；全量路径 `svc.submit`（第 3579 行）。
3. `submit`（第 3579 行）过排除/ worktree / 空壳闸门 → 建 `submitting` 占位 job → 校验 `batchProvider`/`llmRef` → 按 `parallelLimit`（串行/并行）决定 `queued` 或直进 `articles` → `void tick()` 立即推进一步。
4. 阶段机逐阶段推进（见 Architecture），`tick` 每 10s 一拍；`commit` 阶段 `tickCommit`（第 3465 行）调 `autoCommitWiki`（第 4655 行）把 `.codewiki/`+`CodeWiki.md` 提交到主题分支 `codewiki/wiki-<jobId>` 再合并回原分支（第 4699-4733 行）。
5. 终态 `finishJob`（第 2443 行）：`done`/`partial`/`failed` 三态，`done` 才推进编译基线（`canAdvanceBaseline`，由 `judgeOutcome` 判定）。完成后 `wakeCompileSession`（第 2278 行）仅当 `autoCommitState` 为 `pending` 才 steer 唤醒会话（成功且已提交则静默）。
6. 会话提醒 `installUpdateReminder`（第 4783 行）经 `systemPrompt.section` 注入：仅在仓库根存在 `CodeWiki.md` 且 `updateReminder` 开启时（第 4796-4798 行），并叠加 `commitHintText`（第 4739 行，60s 缓存）的一次性「产物待提交」提醒。

会话通道兜底（仅 `bigProvider` 留空且单文件 > 大档预算时启用，第 1184-1208 行）：`dispatchSessionTasks`（第 2797 行）把指令写入 `SESSION_TASK_DIR` 任务文件并 `buildSessionSteerText`（第 2049 行）steer 发起会话派子智能体；`progressSessionTasks`（第 2835 行）轮询 `classifySessionTask`（第 2032 行）收割。

## Connections

- [[core-application]]：编译流水线阶段机（`createJobService`/`STAGE_HANDLER`/`tickArticles`）、`cw` 工具封装、`installWebServer` 回环端点都在那里；本模块的 `apply`（第 4817 行）负责把它们装配起来。
- [[client-interface]]：`client.js` 浏览器半侧是本模块经 `package.json` 第 10 行 `./client` 暴露的双入口之一，只轮询本模块挂出的 `/api/codewiki/*` 端点，无直接函数调用。
- [[configuration-and-metadata]]：`Config`（第 70 行）25 字段与 `liveConfig`（第 102 行）归一化细节、frontmatter 元数据契约 `articleFormatSection`（第 1256 行）、符号快照 `lib/incremental.js` 在本模块之外单独成文。
- [[plugin-core]] / [[plugin-runtime]]：本模块被 cordis 经 `cordis.patch.yml` 挂载为 id `codewiki`（第 19-24 行），是插件的宿主半侧实现。
- [[documentation-and-config]]：文章格式与六个固定章节由 `articleFormatSection`（第 1256 行）定义，编译出的 `modules/*.md`/`_architecture.md` 即为本文所在的模块文档系统。

## Known Issues

- 会话通道仅当 `bigProvider` 留空且单文件 > 大档预算时才启用（第 1184-1208 行、第 2797 行 `dispatchSessionTasks` 判定 `agent.steer`）；面板/自动调度提交本就无会话上下文，因此该路径在那些入口下不可用、会直接 `fail` 报「发起会话不可用」。
- 跨实例一致性靠 `JOBS_LOCK_FILE`（第 2179 行，60s 过期强删）、`mergeFromDisk`（第 2349 行）与 `dirtyIds`（第 2309 行）协作；`DSH_CODEWIKI_JOBS_FILE` 隔离不当会导致测试与真机内存副本互相覆盖（第 1875 行注释，tps 采样 flaky 的根因）。
- `autoCommitWiki`（第 4655 行）只在 `WIKI_PATHS` 两个 pathspec 上提交（第 4662 行），`.codewiki` 被项目 `.gitignore` 忽略时一律返回 `{committed:false, reason:'...被 .gitignore 忽略...'}`（第 4679 行）；合并冲突时保留主题分支不强合（第 4723-4729 行）。
- `apply`（第 4817 行）在 cordis 严格语义下必须 `inject(['llm'])` 才能访问 `ctx.llm`（`llmRef` 在第 4819 行取值，`submit` 第 3651 行校验）；`llm` 未注入时 `submit` 会 `fail` 报「llm 服务未注入」。
- 会话系统提示提醒（`installUpdateReminder` 第 4783 行）只在仓库根存在 `CodeWiki.md` 时才注入（第 4798 行），且仅当 `updateReminder` 开启（第 4796 行）；自动提交成功时 `commitHintText`（第 4739 行）静默，不唤醒会话。
- 模块改名后的孤儿文章由 `pruneOrphanModules`（第 3377 行，旧文章误写为 `pruneOrphanModules`）在全量编译 `tickIndex` 阶段清理；它只在 `kind==='full'` 且本次 modules 清单完整时才动手，增量编译只会把「不在本次 modules 清单、也不在 job.articles 里」的 `.codewiki/modules/*.md` 删除，concepts/learnings/ 等横切产物一律不碰（详见第 3377 行注释）。0.13.0 起插件吸入了 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力——AST 符号提取 + LLM 语义聚类（`semanticPlan` `884|`）、agentic 工具循环写作（`startAgenticRun` `2023|`）与符号级增量判定（`extractCurrentGraph` `1563|`）——全部用 Node + tree-sitter WASM 实现，不需要 Python 运行时；任一环节失败都自动降级回顶层目录分组 / 单轮整包装填 / 文件级增量，不会中断编译（`cordis.patch.yml` `2|`、`package.json` `4|`）。
