---
title: test-log-pairing
type: concept
source_files:
  - test-orchestration.mjs
  - index.js
  - .tmp-test-orchestration.log
  - README.md
  - CHANGELOG.md
  - client.js
tags: [测试, 日志, 配对, 端到端, codewiki, 跨模块]
---

## Overview

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，四类产物之间通过 **prompt 特征句、行号引用与断言结果** 形成的配对与相互印证关系：测试脚本（`test-orchestration.mjs`）、被测运行时（`index.js`）、留档运行日志（`.tmp-test-orchestration.log`，下文行号简记为 `log:NN`）与文档/面板层（`README.md`、`CHANGELOG.md`、`client.js`）。它不是单一代码实体，而是验证体系的数据/控制流闭环：测试自述配方「mock 宿主 llm 服务（llm.stream 按 prompt 特征应答，插件零直连）+ 真实 cw CLI + 真实服务 tick」（test-orchestration.mjs:27-31），用 `check(cond, msg)`（test-orchestration.mjs:27-31）把代码预期逐条绑定为 `✓`/`✗` 日志行，收尾汇总 `PASS：编排冒烟全部通过` / `FAIL：N 项未通过` 并以退出码上抛（test-orchestration.mjs:1550-1551）。

当前代码基线为 **0.14.0**（CHANGELOG.md:3）。`test-orchestration.mjs` 共 1551 行，含约 30 个 `== … ==` 测试块，块头分布在 `test-orchestration.mjs:260` 至 `test-orchestration.mjs:1503`（覆盖：系统提示提醒、注册、codewiki_update/commitHintText、autoCommitWiki、autoCommitState、wakeCompileSession、本地规划、全量编译、横切拆分、文章阶段分割、单项目串行、并行上限、唯一通道、stale 逐篇更新、codewiki_progress、宿主重启重跑、并发提交占位、面板端点、排除清单、knownRepos、workspaceOnly、registry 降级、schema、孤儿接管、全局会话 Tab + worktree 闸门、空壳目录闸门、编译模型缺失、严格 cordis 语义、Temp 残留清理）。验证的核心对象 `index.js` 当前 4034 行，其服务阶段机为：

`queued → articles → crosscut → compose → review → index → commit`（stage 处理器表 `STAGE_HANDLER` 在 `index.js:3482-3489`；0.10.7 起删独立规划阶段，唤醒恒进 articles，见 `index.js:246-253`；旧 `plan` 阶段任务迁移到 articles 见 `index.js:246-255`；0.10.11 起新增独立 commit 阶段 `index.js:246-262`）。

`LEGACY_CHANNEL = { planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`（test-orchestration.mjs:44）是这套测试的基线：0.13.0 吸收的语义聚类/agentic 写作/符号级增量三档能力默认全开（README.md:5、CHANGELOG 顶部），但本套测试显式钉住旧通道的请求次数、装填方式与落盘时序，让编排冒烟继续守护旧行为；新通道由 `test-agentic-host.mjs`、`test-semantic-plan.mjs`、`test-incremental*.mjs` 分册守护。

log 是历史某一轮运行的留档快照：**574 行、`FAIL：2 项未通过`（log:573）**，2 处 `✗` 在 log:114、log:195，断言的还是旧 source 形态 `plugin/codewiki`——这正是 0.8.5 起 `source` 改 `{kind:'plugin:codewiki'}`（CHANGELOG.md:535）要消灭的中间态，当前断言已写成 `source.kind === 'plugin:codewiki'`（test-orchestration.mjs:568），实现侧四处 `createUserMessage` 均带该标记（`index.js:458`、`index.js:1770`、`index.js:2255`、`index.js:2299`）。log 是时间点快照而非当前源码的实时投影（详见 Known Issues），这一错位本身就是本概念要记录的配对事实。

## Key Components

本概念涉及两类组件：测试侧的生产者（配对关系的产生地）与被测运行时（配对的另一端）。

**测试侧（`test-orchestration.mjs`）**

- `check(cond, msg)`（test-orchestration.mjs:26-30）：断言辅助，成功打 `  ✓`，失败打 `  ✗` 并累加 `failures`，收尾依 `failures` 决定 PASS/FAIL 与退出码（test-orchestration.mjs:27-28）。配对链上每一条 `✓`/`✗` 都由它产生。
- `articleMd(title, source, marker, type)`（test-orchestration.mjs:33-35）：夹具文章写入器，`makeBatchMock` 用它按 prompt 特征生成文章，是「prompt 特征句 ↔ 落盘产物」配对的关键桥。
- `LEGACY_CHANNEL` / `batchCfg(extra)`（test-orchestration.mjs:44-45）：基线配置——显式关掉 `planMode/agenticArticles/symbolIncremental` 三档并把编译模型钉到 `workbuddy/hy3`（0.10.1 起编译模型必须来自模型设置里的 provider/model），让断言盯住旧通道。
- `makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})`（test-orchestration.mjs:51-91）：mock 宿主上下文。`inject` 支持 cordis 两种风格——带回调（apply 注册）与 promise（`await ctx.inject([...])`）；`effect` 真实语义「立即执行 body、返回函数收集为 disposer」（test-orchestration.mjs:84-88，注释明言这是防 0.4.3 式 `() => service.stop()` 错写的回归防线，对应 `index.js:4075` 的 `ctx.effect(() => () => service.stop())`）。
- `makeMockAgent(cwd)`（test-orchestration.mjs:94-108）：真实 cordis 语义 mock，`TOOL_REPORT: 2900`（test-orchestration.mjs:94）支撑提醒 section 的 order 计算（`index.js:4045`）。
- `makeFixtureRepo()`（test-orchestration.mjs:110-127）：顶层 `core/`、`util/` 两目录（test-orchestration.mjs:110-111，由 localPlan 顶层分组直接决定模块名，见 `index.js:4655`），自带 `git init` 与 git identity（test-orchestration.mjs:110-114），满足 `autoCommitWiki` 的安全边界检查（`index.js:3906-3908`）。
- `activeLlm` / `llmProxy`（test-orchestration.mjs:132-140）：唯一转发点——`makeCtx` 注册的 `llmProxy` 恒转发到 `activeLlm`，每个测试块只需 `makeBatchMock()` 一处接线。
- `makeBatchMock({modules, articleMarker, stall, bigArticle})`（test-orchestration.mjs:145-227）：mock 宿主 llm 服务，按 prompt 首行特征分发应答（`answerFor` 在 test-orchestration.mjs:147-195，与真实 prompt 模板的区分句一一对应）；`stall` 挂起模拟取消语义（test-orchestration.mjs:146-153）；`bigArticle` 追加 70000 个「长」触发横切拆分（test-orchestration.mjs:193）；每次调用记入 `llmCalls`（test-orchestration.mjs:182）。
- `waitJob(cwd, {timeout})`（test-orchestration.mjs:230-243）：轮询 `JOBS_FILE`，终态判定对齐 `JOB_TERMINAL`（done/failed/cancelled，集合定义于 `index.js:2104`）。
- `fakeReq` / `fakeRes`（test-orchestration.mjs:245-257）：直打端点 handler 的 HTTP 桩，用于面板端点与取消断言。

**被测运行时（`index.js`）**

- `WIKI_PATHS`（index.js:55）：自动提交、忽略检测、待提交提醒共用的唯一定义 `[".codewiki", "CodeWiki.md"]`。
- `llmChat`（index.js:467-492）：宿主 llm 服务唯一通道，`source` 标记在 `index.js:198`；思考档位不支持时剥档重试（index.js:198-201）。
- `runRealtimeTasks`（index.js:591-650）：并发池执行器，大档/默认档分池（index.js:509-524），所有环节共用同一个后台并发池。
- `numberLines`（index.js:679-682）/ `fixAnchors`（index.js:856-976）：行号前缀与行号锚点机械校正；`fixAnchors` 在 `applyTaskResult`（index.js:553）与 `writeValidated`（index.js:2522）两处调用。
- `JOBS_FILE`（index.js:1876）/ `TICK_MS`（index.js:1877）/ `SESSIONS_DIR`（index.js:1893）：任务持久化、tick 推进与会话记录落盘的根路径。
- `detectLinkedWorktree`（index.js:407-423）/ `hasCompilableSources`（index.js:364-378）：worktree 闸门与空壳目录闸门（submit 内调用，见 `index.js:392`、`index.js:392`）。
- `autoCommitState`（index.js:2271-2276）：committed / no-changes / pending 三态判定的唯一来源，唤醒与提醒两条通道共用。
- `wakeCompileSession`（index.js:2278-2293）：编译终态 steer 唤醒，源标记在 `index.js:1757`；成功且已提交/无改动即静默。
- `createJobService`（index.js:2295-3567）：编排服务工厂，`STAGE_HANDLER` 定义于 `index.js:3482-3489`；`tick` 在 `index.js:3491-3577`（并行项目闸门、orphan 接管、cancel 中断在飞请求、queued 排队晋升、旧 plan 任务迁移）；`submit` 在 `index.js:3579-3664`（排除清单、worktree 闸门、空壳目录闸门、编译模型校验、排队闸门）。
- `submitBatchFor`（index.js:2755-2789）：持久化每任务 `batchPrompt` 快照（index.js:805「宿主重启后重跑本阶段的唯一依据」；bigTier 持久化 index.js:805、分割元数据 splitFor/composePlan index.js:805、批量校对 proofreadItems index.js:805）。
- 阶段处理器：`tickArticles`（index.js:2879-3071）、`tickCrosscut`（index.js:3098-3181）、`tickCompose`（index.js:3184-3197）、`tickReview`（index.js:3233-3356）、`tickIndex`（index.js:3346-3401，产物存在且 `autoCommit` 开启时转 commit 阶段 index.js:3465-3467）、`tickCommit`（index.js:2843-2859）。
- `autoCommitWiki`（index.js:4655-4737）：分支合并式自动提交，安全边界（非 git / 被忽略 / merging / 缺 identity / detached HEAD 降级 / 主题分支名占用降级）逐一判定。
- `commitHintText`（index.js:4739-4770）：复用 `autoCommitState` 三态（index.js:2271），编译晚于最近一次 wiki 提交且 pending 才提醒。
- `installUpdateReminder`（index.js:4783）：系统提示 section `codewiki:update-reminder`（section 名 index.js:4044、order 取 TOOL_REPORT+1 index.js:4048、CodeWiki.md 门控 index.js:4052）。
- `apply`（index.js:4817-4881）：插件入口，注入 agents/llm 引用（index.js:2295-2296）、启动 `createJobService`、注册 cw / codewiki_generate / codewiki_update / codewiki_progress 四工具（index.js:1774），挂载 webServer（index.js:1774）与 update-reminder。

## Architecture

```text
┌────────────────────────┐  import/apply + gen.execute   ┌──────────────────────────────┐
│ test-orchestration.mjs │ ───────────────────────────► │ index.js (createJobService)  │
│ check ✓/✗ 配对断言       │   waitJob 轮询 JOBS_FILE      │ 阶段机 queued→articles→      │
│ makeCtx/makeBatchMock  │   (test-orchestration.mjs:236)│ crosscut→compose→review→     │
└───────────┬────────────┘                              │ index→commit (index.js:2861) │
            │ stdout 重定向到 .tmp-test-*.log           └───────────────┬──────────────┘
            ▼                                                          │ tick 推进 / autoCommitWiki
┌────────────────────────┐  job 状态落盘 (JOBS_FILE)     │ (index.js:1373 / 3807)
│ .tmp-test-orchestration │ ◄────────────────────────────┘
│ .log 断言汇总快照        │
└───────────┬────────────┘
            │ 事后审查：失败项 / 旧 source 标记 / 卡阶段
┌───────────┴────────────┐  回环端点 GET /api/codewiki/jobs · control · repos · sessions
│ client.js 侧边栏面板     │ ◄──────────────────────────────────────────────────────────
│ (JOBS_PATH 等 client.js:19-27)                               │
└────────────────────────┘
```

## Data Flow

1. **加载与执行**：测试启动即 `import('./index.js')`（test-orchestration.mjs:24），先写 `DSH_CODEWIKI_TICK_MS=300`（test-orchestration.mjs:15，生产默认 10s、下限 250ms 见 `index.js:1371`）与带随机 token 的独立 `DSH_CODEWIKI_JOBS_FILE`（test-orchestration.mjs:22-23，文件名追加随机串避免 pid 复用时读入历史 fixture 任务，注释见 test-orchestration.mjs:17-21；该修复对应 0.10.10），收尾统一删除不留残留（test-orchestration.mjs:1548）。
2. **断言与逻辑验证**：`makeCtx`（test-orchestration.mjs:51-91）注入 mock 的 webServer/tools/agents/llm 服务后 `apply(ctx, cfg)`（test-orchestration.mjs:296），再触发 `gen.execute`（全量编译在 test-orchestration.mjs:647、stale 更新在 test-orchestration.mjs:230），测试侧以 `waitJob`（test-orchestration.mjs:32-45）轮询 `JOBS_FILE`（读文件在 test-orchestration.mjs:236）等待 `createJobService` 阶段机推进到终态。纯函数直接调用断言（`autoCommitWiki` 由 test-orchestration.mjs:433 验证、`autoCommitState` 由 test-orchestration.mjs:536 验证、`wakeCompileSession` 由 test-orchestration.mjs:548 验证、`commitHintText` 由 test-orchestration.mjs:337 验证、`fixAnchors` 由兄弟测试 test-batch.mjs 验证）。
3. **配对的核心机制**：prompt 特征句 ↔ 应答 ↔ 落盘产物。`makeBatchMock.answerFor`（test-orchestration.mjs:147-195）按 prompt 首行（`你是 CodeWiki 文章作者`/`架构观察员`/`审校员` 等）一一对应生成文章，测试借此校验「请求次数、装填方式、落盘时序」；`numberLines`（index.js:679-682）让模型引用行号以源码「行号| 」前缀为准，`fixAnchors`（index.js:856-976）在落盘前把 `file:NN(-MM)` 锚点确定性校正——这是文章产出时代码行号漂移的兜底，也是「以当前代码为准重写其内容、行号必须按源码『行号| 』前缀重新标注」这条 stale 维护使命（见 index.js:4772 的 `reminderText` 与 test-orchestration.mjs 的 stale 块 test-orchestration.mjs:147-195）在数据流层面的执行点。
4. **测试日志落盘**：测试进程把分组断言结果按固定文本格式重定向写入 `.tmp-test-orchestration.log`（汇总行 `FAIL：2 项未通过` 在 log:573，对应 test-orchestration.mjs:1550）。
5. **面板消费**：`client.js` 侧边栏面板（JOBS_PATH / CONTROL_PATH / REPOS_PATH / SESSIONS_PATH 在 client.js:19-27）每 2s 轮询宿主半侧 webServer 端点（由 `installWebServer` 在 `apply` 内挂载，index.js:4817），数据与测试断言同源；ACT 阶段条第 0 个 `queued`（client.js:33）正是单项目串行排队的可视化。

## Connections

- [[test-scripts]]：本概念的执行主体——`test-orchestration.mjs` 的 `check` 断言输出即 `.tmp-test-orchestration.log` 的唯一来源；同系列还有 test-batch.mjs、test-cwd-paths.mjs、test-wiki-anchors.mjs、test-wiki-entry.mjs。
- [[core-and-config]]：本概念的被测对象——`index.js` 的阶段机、并发池与自动提交逻辑决定了日志中出现的 stage 名、notes 与汇总结果；`source.kind === 'plugin:codewiki'` 标记的四处落点（index.js:458/1691/2168/2212）是配对断言的锚。
- [[logs-and-temp]]：本概念的产物归宿——`.tmp-test-orchestration.log` 为临时目录/仓库根下的留盘快照，供事后排查失败项与卡阶段现象。
- [[test-logging]]：姊妹概念，把 test-batch / test-cwd-paths / test-wiki-anchors / test-wiki-entry 与 watcher2.log 一并纳入「测试日志闭环」；本文聚焦编排冒烟这一条的配对。
- [[client-interface]]：面板消费端，`client.js` 的回环端点轮询与本文的 `waitJob` 轮询同源。
- [[configuration-and-metadata]]：基线 `LEGACY_CHANNEL` 与编译模型 `workbuddy/hy3` 的来历（Config schema 与 cordis.patch.yml）。

## Known Issues

- **留档日志是历史快照，已与当前源码错位**：`.tmp-test-orchestration.log` 共 574 行，仍停留在 2 项 `✗` 的旧形态——log:114 与 log:195 断言的还是 `source` 标记 `plugin/codewiki`，而当前脚本已改为 `source.kind === 'plugin:codewiki'`（test-orchestration.mjs:568，对应 `wakeCompileSession` 的断言）。该 log 是 0.8.5「source 改为 `{kind:'plugin:codewiki'}`」（CHANGELOG.md:535）修复前的产物，与当前源码不是同一时间线。
- **log 残留已删除的「规划改走主模型」整块**：log:120-186 记录了规划相关 notes 与 `stage=plan`（如 log:120 块标题「规划阶段改走主模型」、log:137/log:186 的规划 notes、log:188 的 `stage=plan`），但 0.10.7 起规划阶段已删除，模块清单由 `localPlan` 在 articles 阶段就地生成（index.js:1300-1301 注释、`index.js:941-950` 旧 plan 任务迁移）。当前测试块为「本地规划：零规划请求」（test-orchestration.mjs:583-640），断言零 `勘探员` 请求；log 中这些规划残留属过时噪声。
- **log 的 3 篇 / 概念文章口径已变**：早期 log 记录「编译完成 5 篇（2 模块+架构+模式+概念）」与 `concepts/config-load.md` 落盘（log:192、log:200），而当前 `localPlan` 不产概念（concepts 为空数组，`index.js:1300`、`test-orchestration.mjs:595`），全量编译只落 2 模块 + _architecture + _patterns（test-orchestration.mjs:637、658），不再有概念文章。
- **log 的行号/阶段名与当前不符**：`STAGE_HANDLER`（index.js:3482-3489）含 `commit` 处理器（0.10.11 新增，index.js:4695-4711），而旧 log 的 stage 序列仍停留在 `plan → … → index` 旧范式（log:186、log:188）；log 中的 `stage=plan` 进度查询与 `_plan` taskList 残留（如旧版本 log 的规划阶段条目）在当前阶段机中已不存在。
- **本文自身是配对链的自指一环**：stale 逐篇更新的 mission「以当前代码为准重写其内容，保留章节结构与 title/type/tags」写在 index.js 的 `reminderText`（index.js:4772-4781，由 `installUpdateReminder` 注入，index.js:4783），其「行号必须按源码『行号| 』前缀重新标注」条款由 `fixAnchors` 与 `numberLines`（index.js:679-682、568-651）在落盘前执行——重写本文时即是在兑现这条配对约定。
