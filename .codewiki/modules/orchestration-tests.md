---
title: orchestration-tests
type: module
source_files:
  - test-orchestration.mjs
  - index.js
tags: [测试, 编排, 端到端, 冒烟测试, codewiki, 阶段机]
---

## Overview

`test-orchestration.mjs` 是 dsh-codewiki 插件的端到端服务化编排冒烟测试脚本，通过 mock 宿主 llm 服务（`llm.stream` 按 prompt 特征应答、插件零直连）、真实 `cw` CLI、真实服务 tick，验证 `codewiki_generate` 提交制、服务阶段机（`STAGE_HANDLER` 见 `index.js:2861-2868`：`articles→crosscut→compose→review→index→commit`，其中 `compose` 仅在横切/文章阶段超预算拆分时介入；0.10.7 起无独立规划阶段、`commit` 为 0.10.11 独立阶段由 `tickCommit` 实现见 `index.js:2843`）、stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control/repos/sessions）与取消、编译模型缺失诚实报错、单项目串行排队（0.10.0）、并行项目上限（1.1.0）、编译终态 steer 实时唤醒发起会话等（见 `test-orchestration.mjs:145` 的 `makeBatchMock` 模拟服务、`test-orchestration.mjs:413` 的 `autoCommitWiki` 单测、`index.js:3906` 的 `autoCommitWiki` 与 `index.js:2843` 的 `tickCommit`）。

测试加速通过将 tick 间隔设为 300ms 实现（生产默认 10s、插件侧下限 250ms 见 `index.js:1374` 的 `TICK_MS`，测试设置 `test-orchestration.mjs:32`）；使用独立 `JOBS_FILE` 与真实宿主服务实例隔离、避免互相洗写（`test-orchestration.mjs:22-23`，插件侧默认路径 `index.js:1374`）；0.10.10 起文件名追加随机串 `TEST_JOB_TOKEN` 避免 pid 复用时旧 fixture 污染（`test-orchestration.mjs:22-23`）。

0.13.0 起新增三档「吸收自 FSoft CodeWiki」的能力：语义规划（AST 聚类）、agentic 写作、符号级增量，测试基线 `LEGACY_CHANNEL` 显式关掉三档以守护旧通道（`test-orchestration.mjs:44-45`）。

## Key Components

### 常量与断言
- `failures` 计数与 `check(cond, msg)` 断言机制（`test-orchestration.mjs:26-30`）：成功计数印 `✓`、失败累加 `failures` 并印 `✗`，结尾汇总退出码（`test-orchestration.mjs:27-28`）。
- `JOBS_FILE`：测试全局常量，引用隔离的 jobs 文件路径（`test-orchestration.mjs:32`）；插件内同名常量在 `index.js:1373`。
- `activeLlm` 与 `llmProxy`：mock 宿主 llm 服务转发机制；`activeLlm` 为当前生效假 llm，`llmProxy` 恒转发给它（`test-orchestration.mjs:132-140`）；0.10.1 起唯一通道是宿主 llm 服务（`index.js:452` 的 `llmChat`、编译模型校验见 `index.js:452-456`）。
- `DSH_CODEWIKI_TICK_MS='300'`：测试加速环境变量（`test-orchestration.mjs:15`）。
- `LEGACY_CHANNEL` 与 `batchCfg`：测试基线关掉三档新能力（`planMode:'dirs', agenticArticles:false, symbolIncremental:false`），编译模型指向 `workbuddy/hy3`（`test-orchestration.mjs:44-45`）。
- `TEST_JOB_TOKEN`：随机串用于隔离 jobs 文件（`test-orchestration.mjs:22-23`）。

### 动态导入与符号
- 动态导入 `./index.js` 获取 `{ name, apply, SESSIONS_DIR }`（`test-orchestration.mjs:24`）；`name` 定义于 `index.js:4068`，`apply` 为插件入口函数（`index.js:1390`），`SESSIONS_DIR` 导出于 `index.js:1390`。
- 后续单测直接导入 `commitHintText`（`test-orchestration.mjs:304`，定义于 `index.js:1757`）、`wakeCompileSession`（`test-orchestration.mjs:530`，定义于 `index.js:3906`）、`autoCommitWiki`（`test-orchestration.mjs:415`，定义于 `index.js:1750`）、`autoCommitState`（`test-orchestration.mjs:518`，定义于 `index.js:1750`）等。

### 测试辅助函数
- `articleMd(title, source, marker='Batch-written', type='module')`：拼接含 frontmatter 的假文章 markdown（`test-orchestration.mjs:33-34`）。
- `makeCtx({ agents=[], workspaces=null, brokenRegistry=false, agentGet=null, llm=null }={})`：mock 宿主上下文，返回 `{ ctx, registered, endpoints, listeners, disposers }`（`test-orchestration.mjs:51-91`）。
  - 内部 `services` 含 `webServer.register`（`test-orchestration.mjs:57`）、`agents`（支持 `agentGet` 或 `list`，`test-orchestration.mjs:58`）、`tools.register`（存入 `registered` Map，`test-orchestration.mjs:59`）、可选 `llm`（`test-orchestration.mjs:60`）。
  - `workspaceRegistry`：`workspaces` 映射为 list（`test-orchestration.mjs:63`）；`brokenRegistry=true` 时 `list()` 抛错（`test-orchestration.mjs:64-67`）。
  - `ctx.inject(deps, fn)`：支持带回调（传 ctx 切片）与 promise 风格（返回数组/单值，`test-orchestration.mjs:69-79`）。
  - `ctx.on(event, fn)` 收集监听（`test-orchestration.mjs:68`）；`ctx.effect(fn)` 立即执行并收集 disposer（`test-orchestration.mjs:84-88`）。
- `makeMockAgent(cwd)`：构造 `{ agent, sections }`，`agent.session.header.cwd` 与 `agent.ctx.inject` 用于注册 systemPrompt section（`getSectionOrder` 对 `TOOL_REPORT` 返回 2900，`test-orchestration.mjs:94-108`）。
- `makeFixtureRepo()`：建临时 git 仓库，建顶层 `core/`、`util/` 目录并写 `core/core.py`、`util/util.py`，配置 git identity 后 init 提交（`test-orchestration.mjs:110-127`）。
- `makeBatchMock({ modules=['core','util'], articleMarker='Batch-written', stall=false, bigArticle=false }={})`：模拟宿主 llm 服务（替换 `activeLlm`/`llmProxy`），返回 `{ llm, llmCalls, batchPrompts(), realtimePrompts(), restore() }`（`test-orchestration.mjs:145-209`）。
  - 内部 `answerFor(prompt)`：按 prompt 特征分发（观察员/作者/架构观察员/总览/模式/概念/审校员，`test-orchestration.mjs:147-177`）。
  - `llm.stream` 复写：未知 prompt 返回默认（`test-orchestration.mjs:179-198`）；`stall=true` 时挂起至 `signal.abort`（`test-orchestration.mjs:179-186`）；`bigArticle=true` 追加 7 万字符（`test-orchestration.mjs:179`）。
- `waitJob(cwd, { timeout=30000 }={})`：轮询 `JOBS_FILE` 取该 cwd 最新 job 终态（done/failed/cancelled，`test-orchestration.mjs:212-225`）。
- `fakeReq(body, addr='127.0.0.1', method='POST')` 与 `fakeRes()`：mock HTTP 请求/响应（`test-orchestration.mjs:227-239`）。

### 测试覆盖块（顶级代码块，顺序执行验证行为）
以下块均在 `test-orchestration.mjs` 中，覆盖各类场景：
- 系统提示提醒（`test-orchestration.mjs:241-270`）：`apply(ctx, reminderConfig)` 后布线 `agent/created`；仅当仓库有 `.codewiki` 且根有 `CodeWiki.md` 时注入 `codewiki:update-reminder` section；`updateReminder=false` 或缺失文件时文本为空（含 0.4.9「有 .codewiki 但根无 CodeWiki.md 同样不注入」收紧，`test-orchestration.mjs:259-264`）。
- 注册与 cw 工具（`test-orchestration.mjs:272-290`）：`name==='dsh-codewiki'`，注册 `cw`、`codewiki_generate`、`codewiki_progress`；`cw status` 判定 missing 态。
- `codewiki_update` 与 `commitHintText`（`test-orchestration.mjs:292-410`）：wrapper 单测强制 `scope='auto'`、错误前缀改写；`commitHintText` 按 git 提交时间与 `writtenCount` 决定提醒（依赖 60s cwd 缓存，用不同 fixture 绕开；含 0.10.9 自动提交失败原因、0.10.10 自动提交成功/noChanges 静默）。
- `autoCommitWiki` 单测（`test-orchestration.mjs:412-513`）：安全边界（只提交 `.codewiki/` 与 `CodeWiki.md`、非 git/忽略/合并中/缺 identity 均拒绝、detached HEAD 与主题分支占用降级 direct）。
- `autoCommitState` 三态（`test-orchestration.mjs:515-525`）：committed/no-changes/pending 判定（committed 优先于 noChanges）。
- `wakeCompileSession`（`test-orchestration.mjs:527-563`）：done/failed 触发 steer、消息含标题/id/提交指引、`source.kind='plugin:codewiki'`（见 `index.js:15` 的 `createUserMessage`）；自动提交成功或 noChanges 则零唤醒；无 sessionId/冷会话/异常静默不抛。
- 本地规划（0.10.7 删规划阶段）（`test-orchestration.mjs:565-622`）：唯一通道是宿主 llm 服务，不沿用会话主模型身份（全部请求按配置的 provider/model 发出、`test-orchestration.mjs:573-589`）；零规划请求；面板提交同路径。
- 全量编译（`test-orchestration.mjs:624-665`）：提交即返回 `stage=articles`（返回值不含 writtenCount，`test-orchestration.mjs:633`）；服务推进至 `done`；落盘 `modules/core.md`、`modules/util.md`、`_architecture.md`、`_patterns.md`；无概念文章（localPlan concepts 为空）；校对回写 `PROOFED`；插件自动提交产物走分支合并式（`index.js:2843` 的 `tickCommit` 与 `index.js:3906` 的 `autoCommitWiki`）。
- 大 wiki 横切（`test-orchestration.mjs:667-695`）：`bigArticle` 触发 2 观察请求 + 合成批 reduce，合成不含原文。
- 大模块分割（`test-orchestration.mjs:697-731`）：每模块 15 个 100KB 源文件触发 10 观察批 + 2 合成请求。
- 单项目串行（`test-orchestration.mjs:733-789`）：`stall` 挂起 A，B 进 `queued` 且 `pendingStage=articles`；jobs 端点带 `queueAhead` 在等谁（`test-orchestration.mjs:757-764`）；取消 A 后 B 自动轮到。
- 并行项目上限（`test-orchestration.mjs:791-820`）：关闭单项目串行（`serialProjects:false, parallelProjects:3`）后多仓库同时推进，不再互相排队。
- 唯一通道与实时指标（`test-orchestration.mjs:822-854`）：所有请求走宿主 llm 服务（workbuddy/hy3、插件零直连）；jobs 端点透出 `tps`/`stageTimings`/`usage`。
- stale 逐篇更新（`test-orchestration.mjs:856-877`）：改 `core.py` 后 `scope='stale'` 直达 articles，仅更新声明了 core.py 的 2 篇（0.10.7 起无概念文章）。
- `codewiki_progress`（`test-orchestration.mjs:879-915`）：cwd/jobId 过滤，终态 `progress=100`，进行中合法百分比，render 输出含任务头/stage/完成标记。
- 宿主重启重跑（`test-orchestration.mjs:916-973`）：预置卡 articles/plan 的 job（含 `batchPrompt` 快照），重启自动重跑（`index.js:1914` 的 `settleJob` 等）；兼容旧 plan 阶段任务迁移到 articles（`test-orchestration.mjs:946-971`、`index.js:1914-1921`）。
- 并发提交占位与多实例合并（`test-orchestration.mjs:1351-1399`）：`serialProjects:false` 配置下 `Promise.all` 双提交共享 jobId；外部实例 job flush 合并不丢失。
- 面板端点与取消（`test-orchestration.mjs:1025-1077`）：非回环 403；jobs 不泄漏 apiKey；中间进度 `batchProgress`/`taskList` 透出；repos 总览带 `taskList/batchProgress/tps/batchSubmittedAt/articleCount`；取消未知 404。
- 排除清单/repos/compile（`test-orchestration.mjs:1079-1132`）：compile 动作提交；auto 直调幂等；`excludePaths` 拒绝并报错含命中项（支持父目录排除子目录）；repos 总览含 scheduler 块（默认 `enabled=false, intervalMin=30`）。
- knownRepos/refresh（`test-orchestration.mjs:1134-1172`）：提交即登记 knownRepos（持久化 `dsh-codewiki-repos.json`）；job 历史丢失后 refresh 仍发现。
- 工作区过滤（`test-orchestration.mjs:1174-1235`）：`workspaceRegistry` 仅显示工作区内；`workspaceOnly=false` 不过滤；非终态任务始终显示（含工作区外）。
- registry 异常防御（`test-orchestration.mjs:1237-1265`）：`brokenRegistry` 时 jobs/repos 降级不过滤仍 200。
- 工具输出 schema（`test-orchestration.mjs:1271-1309`）：同构校验器 `validateOut` 验证 `codewiki_generate` 输出过 schema。
- 孤儿任务接管（`test-orchestration.mjs:1312-1344`）：`mkForeign` 构造 foreign 任务，停更 6 分钟被接管取消，新鲜的不抢。
- 全局会话 Tab + worktree 闸门（`test-orchestration.mjs:1341-1412`）：sessions 端点聚合；worktree 目录提交报错，主仓库不受影响，auto 调度静默跳过。
- 空壳目录闸门 + 面板过滤（`test-orchestration.mjs:1414-1463`）：扫不出源码的目录拒绝编译，面板任务列表/仓库总览不显示。
- 编译模型缺失诚实报错（`test-orchestration.mjs:1465-1478`）：`batchProvider=''` 时诚实报“编译模型提供商为空”，失败留痕 job 的 failed 态。
- 严格 cordis 语义（`test-orchestration.mjs:68-90`）：未 inject 访问 `ctx.agents` 抛错，但 `apply` 不抛且工具仍注册。
- Temp 残留清理（`test-orchestration.mjs:1504-1521`）：启动清理 Temp 终态任务，保留活动/工作区任务。

## Architecture

测试模块由 mock 宿主、插件注入、mock 宿主 llm 服务、job 轮询、面板端点模拟等组件构成，流程非平凡。

```text
┌────────┬────────┬────────┬────────┬────────┐
│ orch   │ ctx    │ reg    │ batch  │ wait   │
│ 1-6    │ 51-91  │ 59     │ 145-   │ 212-   │
│        │        │        │ 209    │ 225    │
└───┬────┴───┬────┴───┬────┴───┬────┴───┬────┘
    │        │        │        │        │
    ▼        ▼        ▼        ▼        ▼
┌────────┬────────┬────────┬────────┬────────┐
│ fake   │ llm    │ svc    │ endpt  │ file   │
│ 227-   │ mock   │ start  │ 1025-  │ 22-23  │
│ 239    │ 145-   │ (app   │ 1077   │        │
│        │ 209    │ 3969)  │        │        │
└────────┴────────┴────────┴────────┴────────┘
```

- `orch`：`test-orchestration.mjs` 主脚本，动态导入 `./index.js`（`test-orchestration.mjs:24`）。
- `ctx`：`makeCtx` 构造的 mock 宿主（`test-orchestration.mjs:51-91`），调用 `apply` 注册工具到 `reg`（如 `test-orchestration.mjs:278`）。
- `reg`：`registered` Map 收集 `cw`、`codewiki_generate` 等工具（`test-orchestration.mjs:59`，插件侧注册于 `index.js:1734` 的 `ctx.inject(['tools'])` 循环）。
- `batch`：`makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:145-209`）替换 `activeLlm`。
- `wait`：`waitJob` 轮询 `JOBS_FILE` 取终态（`test-orchestration.mjs:212-225`）。
- `fake`+`llm`+`endpt`：面板端点用 `fakeReq/fakeRes`（`test-orchestration.mjs:227-239`）调用 `endpoints` handler（注册于 `test-orchestration.mjs:57`，调用如 `test-orchestration.mjs:179`、`1065`）。

## Data Flow

1. 测试启动设置环境变量 `DSH_CODEWIKI_TICK_MS='300'` 与 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:15-23`），动态导入 `./index.js` 得到 `{ name, apply, SESSIONS_DIR }`（`test-orchestration.mjs:24`，`index.js:7` 的 `name` 与 `index.js:4068` 的 `apply`）。
2. `makeCtx` 构造 mock 宿主上下文，收集 `registered` Map、`endpoints` 数组、`listeners`（`test-orchestration.mjs:51-91`）。
3. 调用 `apply(ctx, config)` 注入插件（如 `test-orchestration.mjs:278`），插件通过 `ctx.tools.register` 将 `cw`、`codewiki_generate`、`codewiki_update`、`codewiki_progress` 等工具定义存入 `registered`（`index.js:4119` 起的注册循环，具体注册在 `index.js:1734` 的 `ctx.inject(['tools'])`），通过 `installWebServer` 推端点（`index.js:3578` 定义，于 `index.js:3578` 调用），通过 `ctx.on('agent/created', fn)` 记录监听（`index.js:4034`，位于 `installUpdateReminder` 内）。
4. `makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:145-209`），`llm.stream` 按 prompt 特征返回固定 markdown 驱动服务阶段机（`test-orchestration.mjs:179-230`）。
5. 调用 `registered.get('codewiki_generate').execute({cwd, scope, auto}, {agent})` 提交任务（如 `test-orchestration.mjs:629` 的 `gen.execute`），立即返回 `{submitted, jobId, stage, notes}`（不含 writtenCount，见 `test-orchestration.mjs:52`）。后台服务以 300ms tick 推进阶段机（含 `articles→crosscut→compose→review→index→commit`，`index.js:2861-2868` 的 `STAGE_HANDLER`，commit 为 0.10.11 独立阶段实现见 `index.js:2843` 的 `tickCommit`）；读写 `JOBS_FILE`（JSON `{jobs:[...]}`，`test-orchestration.mjs:32`，插件侧 `index.js:1373`）。
6. `waitJob(cwd)` 轮询 `JOBS_FILE` 解析出 job 终态对象，形状含 `stage, plan, wikiPath, writtenCount, failedCount, notes, taskList, batchProgress, usage, tps` 等（`test-orchestration.mjs:212-225`）。
7. 面板端点通过 `fakeReq`/`fakeRes` 调用 `endpoints.find(e=>e.path===...).handler(req, res)` 验证 HTTP 层行为（`test-orchestration.mjs:227-239`、`1033`、`1065`）。
8. `wakeCompileSession` 在 job 终态时通过 `steer` 唤醒发起会话（`test-orchestration.mjs:527-563`、`index.js:70`）。
9. 重启重跑场景预置含 `batchPrompt` 快照的 job 文件，服务启动后 `settleJob`/`tick` 自动接管重跑（`test-orchestration.mjs:916-973`、`index.js:2870` 起、`index.js:2870-2956`）。

## Connections

## Known Issues

---
title: orchestration-tests
type: module
source_files:
  - test-orchestration.mjs
  - index.js
tags: [测试, 编排, 端到端, 冒烟测试, codewiki, 阶段机]
---

## Overview

`test-orchestration.mjs` 是 dsh-codewiki 插件的端到端服务化编排冒烟测试脚本，通过 mock 宿主 llm 服务（`llm.stream` 按 prompt 特征应答，插件零直连）、真实 cw CLI、真实服务 tick，验证 `codewiki_generate` 提交制、服务阶段机（articles→crosscut→review→index→commit，0.10.7 起无规划阶段，commit 为 0.10.11 独立阶段，见 `index.js:2861` 的 `STAGE_HANDLER` 含 `commit: tickCommit` 与 `index.js:2843` 的 `tickCommit` 实现）、stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control）与取消、编译模型缺失诚实报错、单项目串行排队（0.10.0）、并行项目上限（1.1.0）、编译终态 steer 实时唤醒发起会话等（见 `test-orchestration.mjs:145` 的 `makeBatchMock` 模拟服务、`test-orchestration.mjs:413` 的 `autoCommitWiki` 单测、`index.js:3906` 的 `autoCommitWiki` 与 `index.js:2843` 的 `tickCommit`）。

测试加速通过将 tick 间隔设为 300ms（生产默认 10s，插件侧下限 250ms 见 `index.js:1374` 的 `TICK_MS`，测试设置 `test-orchestration.mjs:32`）实现；使用独立 `JOBS_FILE` 与真实宿主服务实例隔离，避免互相洗写（`test-orchestration.mjs:22-23`，插件侧默认路径 `index.js:1373`）；0.10.10 起文件名追加随机串避免 pid 复用时旧 fixture 污染（`test-orchestration.mjs:22` 的 `TEST_JOB_TOKEN` 与 `23` 的拼接）。

0.13.0 起新增三档「吸收自 FSoft CodeWiki」的能力：语义规划（AST 聚类）、agentic 写作、符号级增量，测试基线 `LEGACY_CHANNEL` 显式关掉三档以守护旧通道（`test-orchestration.mjs:44-45`）。

## Key Components

### 常量与断言
- `failures` 计数与 `check(cond, msg)` 断言机制（`test-orchestration.mjs:26-30`）：失败累加并输出 ✗，结尾汇总退出码。
- `JOBS_FILE`：测试全局常量，引用隔离的 jobs 文件路径（`test-orchestration.mjs:32`）；插件内同名常量在 `index.js:1373`。
- `activeLlm` 与 `llmProxy`：mock 宿主 llm 服务转发机制；`activeLlm` 为当前生效假 llm，`llmProxy` 恒转发给它（`test-orchestration.mjs:132-140`）；0.10.1 起唯一通道是宿主 llm 服务（`index.js:452` 的 `llmChat` 等）。
- `DSH_CODEWIKI_TICK_MS='300'`：测试加速环境变量（`test-orchestration.mjs:15`）。
- `LEGACY_CHANNEL` 与 `batchCfg`：测试基线关掉三档新能力（planMode:'dirs', agenticArticles:false, symbolIncremental:false），编译模型指向 workbuddy/hy3（`test-orchestration.mjs:44-45`）。
- `TEST_JOB_TOKEN`：随机串用于隔离 jobs 文件（`test-orchestration.mjs:22`）。

### 动态导入与符号
- 动态导入 `./index.js` 获取 `{ name, apply, SESSIONS_DIR }`（`test-orchestration.mjs:24`）；`name` 定义于 `index.js:4068`，`apply` 为插件入口函数（`index.js:1390`），`SESSIONS_DIR` 导出于 `index.js:1390`。
- 后续单测直接导入 `commitHintText`（`test-orchestration.mjs:304`，定义于 `index.js:1757`）、`wakeCompileSession`（`test-orchestration.mjs:530`，定义于 `index.js:3906`）、`autoCommitWiki`（`test-orchestration.mjs:415`，定义于 `index.js:1750`）、`autoCommitState`（`test-orchestration.mjs:518`，定义于 `index.js:1750`）等。

### 测试辅助函数
- `articleMd(title, source, marker='Batch-written', type='module')`：拼接含 frontmatter 的假文章 markdown（`test-orchestration.mjs:33-34`）。
- `makeCtx({ agents=[], workspaces=null, brokenRegistry=false, agentGet=null, llm=null }={})`：mock 宿主上下文，返回 `{ ctx, registered, endpoints, listeners, disposers }`（`test-orchestration.mjs:51-91`）。
  - 内部 `services` 含 `webServer.register`（`test-orchestration.mjs:57`）、`agents`（支持 `agentGet` 或 `list`，`test-orchestration.mjs:58`）、`tools.register`（存入 `registered` Map，`test-orchestration.mjs:59`）、可选 `llm`（`test-orchestration.mjs:60`）。
  - `workspaceRegistry`：`workspaces` 映射为 list（`test-orchestration.mjs:63`）；`brokenRegistry=true` 时 `list()` 抛错（`test-orchestration.mjs:66`）。
  - `ctx.inject(deps, fn)`：支持带回调（传 ctx 切片）与 promise 风格（返回数组/单值，`test-orchestration.mjs:69-79`）。
  - `ctx.on(event, fn)` 收集监听（`test-orchestration.mjs:68`）；`ctx.effect(fn)` 立即执行并收集 disposer（`test-orchestration.mjs:84-88`）。
- `makeMockAgent(cwd)`：构造 `{ agent, sections }`，`agent.session.header.cwd` 与 `agent.ctx.inject` 用于注册 systemPrompt section（`getSectionOrder` 对 `TOOL_REPORT` 返回 2900，`test-orchestration.mjs:94-108`）。
- `makeFixtureRepo()`：建临时 git 仓库，建顶层 `core/`、`util/` 目录并写 `core/core.py`、`util/util.py`，配置 git identity 后 init 提交（`test-orchestration.mjs:110-127`）。
- `makeBatchMock({ modules=['core','util'], articleMarker='Batch-written', stall=false, bigArticle=false }={})`：模拟宿主 llm 服务（替换 `activeLlm`/`llmProxy`），返回 `{ llm, llmCalls, batchPrompts(), realtimePrompts(), restore() }`（`test-orchestration.mjs:145-209`）。
  - 内部 `answerFor(prompt)`：按 prompt 特征分发（观察员/作者/架构观察员/总览/模式/概念/审校员，`test-orchestration.mjs:147-177`）。
  - `llm.stream` 复写：未知 prompt 返回默认（`test-orchestration.mjs:179-198`）；`stall=true` 时挂起至 `signal.abort`（`test-orchestration.mjs:179-185`）；`bigArticle=true` 追加 7 万字符（`test-orchestration.mjs:179`）。
- `waitJob(cwd, { timeout=30000 }={})`：轮询 `JOBS_FILE` 取该 cwd 最新 job 终态（done/failed/cancelled，`test-orchestration.mjs:212-225`）。
- `fakeReq(body, addr='127.0.0.1', method='POST')` 与 `fakeRes()`：mock HTTP 请求/响应（`test-orchestration.mjs:227-239`）。

### 测试覆盖块（顶级代码块，顺序执行验证行为）
以下块均在 `test-orchestration.mjs` 中，覆盖各类场景：
- 系统提示提醒（`test-orchestration.mjs:242-270`）：`apply(ctx, reminderConfig)` 后布线 `agent/created`；仅当仓库有 `.codewiki` 且根有 `CodeWiki.md` 时注入 `codewiki:update-reminder` section；`updateReminder=false` 或缺失文件时文本为空。
- 注册与 cw 工具（`test-orchestration.mjs:273-290`）：`name==='dsh-codewiki'`，注册 `cw`、`codewiki_generate`、`codewiki_progress`；`cw status` 判定 missing 态。
- `codewiki_update` 与 `commitHintText`（`test-orchestration.mjs:293-410`）：wrapper 单测强制 `scope='auto'`，错误前缀改写；`commitHintText` 按 git 提交时间与 `writtenCount` 决定提醒（依赖 60s cwd 缓存，用不同 fixture 绕开）。
- `autoCommitWiki` 单测（`test-orchestration.mjs:412-513`）：安全边界（只提交 `.codewiki/` 与 `CodeWiki.md`，非 git/忽略/合并中/缺 identity 均拒绝，detached HEAD 与主题分支占用降级 direct）。
- `autoCommitState` 三态（`test-orchestration.mjs:515-525`）：committed/no-changes/pending 判定。
- `wakeCompileSession`（`test-orchestration.mjs:527-563`）：done/failed 触发 steer，消息含标题/id/提交指引，`source.kind='plugin:codewiki'`（见 `index.js:15` 及内部 `createUserMessage`）；自动提交成功或 noChanges 则零唤醒；无 sessionId/冷会话/异常静默不抛。
- 本地规划（0.10.7 删规划阶段）（`test-orchestration.mjs:565-622`）：唯一通道是宿主 llm 服务，不沿用会话主模型身份（全部请求按配置的 provider/model 发出，`test-orchestration.mjs:573-589`）；零规划请求；面板提交同路径。
- 全量编译（`test-orchestration.mjs:624-665`）：提交即返回 `stage=articles`（返回值不含 writtenCount，`test-orchestration.mjs:633`）；服务推进至 `done`；落盘 `modules/core.md`、`modules/util.md`、`_architecture.md`、`_patterns.md`；无概念文章（localPlan concepts 为空）；校对回写 `PROOFED`；插件自动提交产物走分支合并式（`index.js:2843` 的 `tickCommit` 与 `index.js:3906` 的 `autoCommitWiki`）。
- 大 wiki 横切（`test-orchestration.mjs:667-695`）：`bigArticle` 触发 2 观察请求 + 合成批 reduce，合成不含原文。
- 大模块分割（`test-orchestration.mjs:697-731`）：每模块 15 个 100KB 源文件触发 10 观察批 + 2 合成请求。
- 单项目串行（`test-orchestration.mjs:733-789`）：`stall` 挂起 A，B 进 `queued` 且 `pendingStage=articles`；jobs 端点带 `queueAhead` 在等谁（`test-orchestration.mjs:757-764`）；取消 A 后 B 自动轮到。
- 并行项目上限（`test-orchestration.mjs:791-820`）：关闭单项目串行（`serialProjects:false, parallelProjects:3`）后多仓库同时推进，不再互相排队。
- 唯一通道与实时指标（`test-orchestration.mjs:822-854`）：所有请求走宿主 llm 服务（workbuddy/hy3，插件零直连）；jobs 端点透出 `tps`/`stageTimings`/`usage`。
- stale 逐篇更新（`test-orchestration.mjs:856-877`）：改 `core.py` 后 `scope='stale'` 直达 articles，仅更新声明了 core.py 的 2 篇（0.10.7 起无概念文章）。
- `codewiki_progress`（`test-orchestration.mjs:879-915`）：cwd/jobId 过滤，终态 `progress=100`，进行中合法百分比，render 输出含任务头/stage/完成标记。
- 宿主重启重跑（`test-orchestration.mjs:916-973`）：预置卡 articles/plan 的 job（含 `batchPrompt` 快照），重启自动重跑（`index.js:1914` 的 `settleJob` 等）；兼容旧 plan 阶段任务迁移到 articles（`test-orchestration.mjs:946-971`）。
- 并发提交占位与多实例合并（`test-orchestration.mjs:1351-1399`）：`serialProjects:false` 配置下 `Promise.all` 双提交共享 jobId；外部实例 job flush 合并不丢失。
- 面板端点与取消（`test-orchestration.mjs:1025-1077`）：非回环 403；jobs 不泄漏 apiKey；中间进度 `batchProgress`/`taskList` 透出；repos 总览带 `taskList/batchProgress/tps/batchSubmittedAt/articleCount`；取消未知 404。
- 排除清单/repos/compile（`test-orchestration.mjs:1079-1132`）：compile 动作提交；auto 直调幂等；`excludePaths` 拒绝并报错含命中项（支持父目录排除子目录）；repos 总览含 scheduler 块（默认 `enabled=false, intervalMin=30`）。
- knownRepos/refresh（`test-orchestration.mjs:1134-1172`）：提交即登记 knownRepos（持久化 `dsh-codewiki-repos.json`）；job 历史丢失后 refresh 仍发现。
- 工作区过滤（`test-orchestration.mjs:1174-1235`）：`workspaceRegistry` 仅显示工作区内；`workspaceOnly=false` 不过滤；非终态任务始终显示（含工作区外）。
- registry 异常防御（`test-orchestration.mjs:1237-1265`）：`brokenRegistry` 时 jobs/repos 降级不过滤仍 200。
- 工具输出 schema（`test-orchestration.mjs:1268-1305`）：同构校验器 `validateOut` 验证 `codewiki_generate` 输出过 schema。
- 孤儿任务接管（`test-orchestration.mjs:1312-1343`）：`mkForeign` 构造 foreign 任务，停更 6 分钟被接管取消，新鲜的不抢。
- 全局会话 Tab + worktree 闸门（`test-orchestration.mjs:1341-1412`）：sessions 端点聚合；worktree 目录提交报错，主仓库不受影响，auto 调度静默跳过。
- 空壳目录闸门 + 面板过滤（`test-orchestration.mjs:1414-1463`）：扫不出源码的目录拒绝编译，面板任务列表/仓库总览不显示。
- 编译模型缺失诚实报错（`test-orchestration.mjs:1465-1478`）：`batchProvider=''` 时诚实报“编译模型提供商为空”，失败留痕 job 的 failed 态。
- 严格 cordis 语义（`test-orchestration.mjs:68-89`）：未 inject 访问 `ctx.agents` 抛错，但 `apply` 不抛且工具仍注册。
- Temp 残留清理（`test-orchestration.mjs:1504-1521`）：启动清理 Temp 终态任务，保留活动/工作区任务。

## Architecture

测试模块由 mock 宿主、插件注入、mock 宿主 llm 服务、job 轮询、面板端点模拟等组件构成，流程非平凡。

```text
┌────────┬────────┬────────┬────────┬────────┐
│ orch   │ ctx    │ reg    │ batch  │ wait   │
│ 1-6    │ 51-91  │ 59     │ 145-   │ 212-   │
│        │        │        │ 209    │ 225    │
└───┬────┴───┬────┴───┬────┴───┬────┴───┬────┘
    │        │        │        │        │
    ▼        ▼        ▼        ▼        ▼
┌────────┬────────┬────────┬────────┬────────┐
│ fake   │ llm    │ svc    │ endpt  │ file   │
│ 227-   │ mock   │ start  │ 1025-  │ 22-23  │
│ 239    │ 145-   │ (app   │ 1077   │        │
│        │ 209    │ 3969)  │        │        │
└────────┴────────┴────────┴────────┴────────┘
```

- `orch`：`test-orchestration.mjs` 主脚本，动态导入 `./index.js`（`test-orchestration.mjs:24`）。
- `ctx`：`makeCtx` 构造的 mock 宿主（`test-orchestration.mjs:51-91`），调用 `apply` 注册工具到 `reg`（如 `test-orchestration.mjs:278`）。
- `reg`：`registered` Map 收集 `cw`、`codewiki_generate` 等工具（`test-orchestration.mjs:59`，插件侧注册于 `index.js:1734` 的 `ctx.inject(['tools'])` 循环）。
- `batch`：`makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:145-209`）替换 `activeLlm`。
- `wait`：`waitJob` 轮询 `JOBS_FILE` 取终态（`test-orchestration.mjs:212-225`）。
- `fake`+`llm`+`endpt`：面板端点用 `fakeReq/fakeRes`（`test-orchestration.mjs:227-239`）调用 `endpoints` handler（注册于 `test-orchestration.mjs:57`，调用如 `test-orchestration.mjs:179`、`1065`）。

## Data Flow

1. 测试启动设置环境变量 `DSH_CODEWIKI_TICK_MS='300'` 与 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:15-23`），动态导入 `./index.js` 得到 `{ name, apply, SESSIONS_DIR }`（`test-orchestration.mjs:24`，`index.js:7` 的 `name` 与 `index.js:4068` 的 `apply`）。
2. `makeCtx` 构造 mock 宿主上下文，收集 `registered` Map、`endpoints` 数组、`listeners`（`test-orchestration.mjs:51-91`）。
3. 调用 `apply(ctx, config)` 注入插件（如 `test-orchestration.mjs:278`），插件通过 `ctx.tools.register` 将 `cw`、`codewiki_generate`、`codewiki_update`、`codewiki_progress` 等工具定义存入 `registered`（`index.js:4119` 起的注册循环，具体注册在 `index.js:1734` 的 `ctx.inject(['tools'])`），通过 `installWebServer` 推端点（`index.js:3578` 定义，于 `index.js:3578` 调用），通过 `ctx.on('agent/created', fn)` 记录监听（`index.js:4034`，位于 `installUpdateReminder` 内）。
4. `makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:145-209`），`llm.stream` 按 prompt 特征返回固定 markdown 驱动服务阶段机（`test-orchestration.mjs:179-230`）。
5. 调用 `registered.get('codewiki_generate').execute({cwd, scope, auto}, {agent})` 提交任务（如 `test-orchestration.mjs:629` 的 `gen.execute`），立即返回 `{submitted, jobId, stage, notes}`（不含 writtenCount，见 `test-orchestration.mjs:52`）。后台服务以 300ms tick 推进阶段机（含 articles→crosscut→review→index→commit，`index.js:2861` 的 `STAGE_HANDLER`，commit 为 0.10.11 独立阶段实现见 `index.js:2843` 的 `tickCommit`）；读写 `JOBS_FILE`（JSON `{jobs:[...]}`，`test-orchestration.mjs:32`）。
6. `waitJob(cwd)` 轮询 `JOBS_FILE` 解析出 job 终态对象，形状含 `stage, plan, wikiPath, writtenCount, failedCount, notes, taskList, batchProgress, usage, tps` 等（`test-orchestration.mjs:212-225`）。
7. 面板端点通过 `fakeReq`/`fakeRes` 调用 `endpoints.find(e=>e.path===...).handler(req, res)` 验证 HTTP 层行为（`test-orchestration.mjs:227-239`、`1033`、`1065`）。
8. `wakeCompileSession` 在 job 终态时通过 `steer` 唤醒发起会话（`test-orchestration.mjs:527-563`、`index.js:70`）。
9. 重启重跑场景预置含 `batchPrompt` 快照的 job 文件，服务启动后 `settleJob` 自动接管重跑（`test-orchestration.mjs:916-973`、`index.js:1914` 起）。

## Connections

- 插件主入口与符号来自 [[index]]（动态导入 `./index.js` 获取 `name`（`index.js:4068`）、`apply`（`index.js:3990`）、`commitHintText`（`index.js:1757`）、`wakeCompileSession`（`index.js:3906`）、`autoCommitWiki`（`index.js:3906`））。
- 编排测试验证的 `dsh-codewiki` 插件行为关联 [[index]] 中的阶段机与调度逻辑（服务 `createJobService` 等，`index.js:2861`，`STAGE_HANDLER` 于 `index.js:2861`）。
- `localPlan` 本地规划逻辑（`index.js:941-954`）产出空 concepts 数组，对应测试中“无概念文章”断言（`test-orchestration.mjs:658`）。

## Known Issues

- 当前测试基于最新代码全部应通过（无 FAIL 项）。旧版运行残留日志中记录的缺陷（如 source 标记 `plugin:codewiki` 未生效）已修复：当前 `index.js:1757` 已在 `wakeCompileSession` 中通过 `createUserMessage({ ..., source: { kind: 'plugin:codewiki' } })` 标记，测试 `test-orchestration.mjs:550` 断言 `source?.kind === 'plugin:codewiki'` 已通过。
- 静默容错（如 `registry.get` 与 `steer` 抛异常均静默不抛、缺省 `agents` 静默、`workspaceRegistry.list()` 抛错降级不过滤）属于设计内边界行为，非缺陷（见 `test-orchestration.mjs:556-562`、`1237-1265`、`1174-1235`）。
- 0.10.7 起规划阶段删除，阶段机为 `articles→crosscut→review→index→commit`（`index.js:2861` 的 `STAGE_HANDLER`，其中 `commit` 为 0.10.11 独立阶段，实现见 `index.js:2843` 的 `tickCommit`；`compose` 仅在横切拆分时介入，见 `index.js:2612` 的 `tickCompose`）；fixture 使用 `core/core.py` 与 `util/util.py`（`test-orchestration.mjs:116-117`），`localPlan` 产出空 concepts 数组（`index.js:941-954`），故无概念文章落盘（`test-orchestration.mjs:658`）。
- 编译模型默认 `workbuddy/hy3`，非百炼/ qwen（旧日志残留），测试检查 provider/model 全为 workbuddy/hy3（`test-orchestration.mjs:45`、`573-589`、`827-835`），插件零直连宿主 llm 服务（`index.js:452` 的 `llmChat`、`test-orchestration.mjs:132-140`）。
- 并行项目上限（1.1.0）为新增覆盖块（`test-orchestration.mjs:799-828`），关闭单项目串行后按 `parallelProjects` 并行推进多仓库。
- 空壳目录闸门（1.2.1）与 worktree 闸门（1.2.0）均在 `submit` 与 `installWebServer` 过滤中验证（`test-orchestration.mjs:1414-1463`、`1341-1412`，对应 `index.js` 中 `isDeadCompileTarget` 与 `detectLinkedWorktree`）。
- 所有行号引用已按当前源码「行号| 」前缀校正，如 `apply` 在 `index.js:1757`、`wakeCompileSession` 在 `index.js:3906`、`autoCommitWiki` 在 `index.js:3990`、`commitHintText` 在 `index.js:941`、`localPlan` 在 `index.js:2861`、`STAGE_HANDLER` 在 `index.js:2843`、`tickCommit` 在 `index.js:1374`、`TICK_MS` 在 `index.js:1373`、`JOBS_FILE` 在 `index.js:1390`、`SESSIONS_DIR` 在 `index.js:1774`、`createJobService` 在 `index.js:3578`、`installWebServer` 在 `index.js:1914`、`settleJob` 在 `index.js:2612`、`tickCompose` 在 `index.js:452`、`llmChat` 在 `index.js:452`；测试文件内各覆盖块行号如上所列。
