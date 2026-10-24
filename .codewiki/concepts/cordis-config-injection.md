---
title: cordis-config-injection
type: concept
source_files:
  - test-orchestration.mjs
  - .tmp-test-orchestration.log
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - index.js
  - client.js
  - package.json
tags: [cordis, 依赖注入, 配置, 热生效, 插件架构]
---

## Overview

`cordis-config-injection` 是 dsh-codewiki 插件在 DeepSeek Harness（cordis 框架）中运转的核心机制，覆盖两件事。其一是通过 `ctx.inject(['service'])` 严格获取宿主服务切片——宿主侧注入 `agents`/`llm`（index.js:3024-3025）、`tools`（index.js:3063）、`workspaceRegistry`/`webServer`（index.js:2655、index.js:2679），客户端注入 `slots`/`locale`/`configForms`（client.js:411）——并遵循 cordis 严格语义（未 inject 直接访问服务属性即抛错，`typeof` 守卫无效）。其二是配置的注入与热生效：schemastery `Config` 全字段 `.volatile()`（index.js:48-68），运行时经 `liveConfig` 每次调用重新解包（index.js:74-99），客户端经 `configForms.mutate` 单层 op + CAS 写回（client.js:170-192）。0.10.1 起编译模型通道唯一化为宿主 `llm` 服务（内置百炼直连与 `credentials` 凭证解析链已删，`batchProvider` 留空即提交失败）；0.10.9 新增 `autoCommit` 配置（index.js:63）与 `autoCommitWiki` 自动提交（index.js:2904-2945），`wakeCompileSession` 在自动提交成功时不再唤醒会话（index.js:1205）。该概念横跨测试验证（test-orchestration.mjs）、文档（README.md、CodeWiki.md、CHANGELOG.md）与宿主/客户端实现（index.js、client.js、package.json），是插件装配、模型通道声明与设置持久化的基石。

## Key Components

### 配置 Schema 与热生效（index.js）

- `Config` (index.js:48-68)：schemastery `z.object`，全部字段 `.volatile()`（execute/tick 时解包读取，改完即生效）。字段与默认值：
  - `enabled` (index.js:49，默认 true，停用后工具立即报错)
  - `binaryPath` (index.js:50，留空 PATH 优先、捆绑 `bin/cw` 兜底)
  - `batchProvider` (index.js:51，默认 `workbuddy`；必须是模型设置里已注册的 provider id，留空无法提交——0.10.1 起唯一通道)
  - `batchModel` (index.js:52，默认 `hy3`)
  - `batchReasoningEffort` (index.js:53，留空=模型默认档；可选值由 `/api/codewiki/model-efforts` 从模型目录实时读取)
  - `bigProvider` (index.js:54，默认 `volces-ark`，留空=关闭大档、退回会话通道兜底)
  - `bigModel` (index.js:55，默认 `glm-5.3-flash`，512k 上下文)
  - `bigReasoningEffort` (index.js:56)
  - `bigTokenBudget` (index.js:57，默认 420000)
  - `sessionTier` (index.js:58，仅大档装不下且关闭大档时兜底的子智能体档位 id)
  - `maxConcurrency` (index.js:59，默认 2，1–8 硬顶 8)
  - `serialProjects` (index.js:60，单项目串行，默认开)
  - `articleLanguage` (index.js:61，默认中文)
  - `updateReminder` (index.js:62，默认开)
  - `autoCommit` (index.js:63，0.10.9 新增，默认开：编译产物由插件自己 git 提交)
  - `excludePaths` (index.js:64，换行/分号/逗号分隔绝对路径)
  - `autoUpdate` (index.js:65，默认关) / `autoUpdateMin` (index.js:66，默认 30 最小 5)
  - `workspaceOnly` (index.js:67，默认开)
- `val(x)` (index.js:70-72)：兼容 schemastery 对象的 `.get()` 与裸值。
- `liveConfig(config)` (index.js:74-99)：每次调用重新解包并钳制——`batchModel` 空回落 `hy3` (index.js:81)、`bigModel` 空回落 `glm-5.3-flash` (index.js:84)、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET` (index.js:86)、并发仅在 `>=1` 时取 `Math.min(concurrency, 8)` 否则默认 2 (index.js:74-76)、`autoUpdateMin` 下限 5 (index.js:95)、`autoCommit`/`serialProjects`/`workspaceOnly` 均为「显式 false 才关」 (index.js:96-97)。注意 `batchProvider` 不做任何回落（index.js:80），空值由 submit 校验拦截。
- 常量：`CONCURRENCY_HARD_CAP=8` (index.js:22)、`DEFAULT_CONCURRENCY=2` (index.js:24)、`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:26)、`DEFAULT_BATCH_MODEL='hy3'` (index.js:27)、`DEFAULT_BIG_PROVIDER='volces-ark'` (index.js:30)、`DEFAULT_BIG_MODEL='glm-5.3-flash'` (index.js:31)、`DEFAULT_BIG_TOKEN_BUDGET=420000` (index.js:33)、`BATCH_TOKEN_BUDGET=110000` (index.js:371)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:376)。
- 运行时环境常量：`JOBS_FILE`（`DSH_CODEWIKI_JOBS_FILE` 可隔离，index.js:1012）、`TICK_MS`（默认 10s、下限 250ms，index.js:1013）、`SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，index.js:1017）、`SESSION_TASK_DIR` (index.js:1018)、`ORPHAN_TAKEOVER_MS`（默认 5 分钟，index.js:1061）、`MAX_JOBS_KEPT=30` (index.js:1012)、`REPOS_FILE`（`DSH_CODEWIKI_REPOS_FILE` 可隔离，index.js:1067）、`JOB_TERMINAL`（终态集合，index.js:1080）、`commitHintCache`（cwd→{at,text}，60s TTL，index.js:2890）。
- `name` 导出 `'dsh-codewiki'` (index.js:37-38)；`normalizeCwd` (index.js:37-42) 仅 win32 做 `/c/...`→`C:/...` 归一，POSIX 原样。

### 宿主侧 cordis 注入入口（index.js）

- `apply(ctx, config)` (index.js:3023-3082)：cordis 插件入口，装配顺序：
  1. `ctx.inject(['agents'])` → 模块级 `agentsRef` (index.js:3024，声明见 index.js:1195)
  2. `ctx.inject(['llm'])` → 模块级 `llmRef` (index.js:3025，声明见 index.js:1200)
  3. `createJobService(config, wakeCompileSession)` + `service.start()` (index.js:3026-3027)
  4. `ctx.effect(() => () => service.stop())`——必须返回 disposer 本身；写成 `() => service.stop()` 会在启动时当场停服 (index.js:3030)
  5. 构建 `generateDef`/`updateDef` (index.js:3031-3032)
  6. 自动更新调度：`autoScan` 60s 心跳对历史工作区逐仓 `scope=auto`（execute 幂等），单仓异常只记 `schedState.lastError` (index.js:3037-3066)
  7. `ctx.inject(['tools'])` 注册四个工具（`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress`），逐定义 try/catch——单个 schema 违规只丢该工具并 console.error，不让回调失败触发 cordis 回滚整个 fiber (index.js:3063-3079)
  8. `installWebServer(ctx, service, {config, schedState, compile})` (index.js:3080)
  9. `installUpdateReminder(ctx, config)` (index.js:3081)
- `createJobService(config, onSettled)` (index.js:1218-2203)：返回 `{submit, cancel, list, findActive, start, stop}` (index.js:1218)。与配置/注入直接相关的面：
  - `submit()` 模型通道三重校验：`batchProvider` 非空、`batchModel` 非空、`llmRef.stream` 可用，任一缺失则 fail、落盘后向上抛（job 留 `failed` 痕迹）(index.js:2111-2120)；`credentialSource` 恒为 `llm(<provider>/<model>)` (index.js:2155)。
  - 提交占位先行（stage=`submitting` 挡住校验窗口内的并发重复提交，index.js:2120-2142）；单项目串行判定——已有别的项目推进时本任务进 `queued` 并预置 `pendingStage='articles'`/`pendingTasks` (index.js:2044-2056)。
  - `tick()` 串行闸门 `activeId`（在跑优先、否则取最早 queued，index.js:2041-2046）、foreign 孤儿按停更超时接管 (index.js:2032-2041)、旧 `plan` 阶段任务迁移到 articles (index.js:2087-2094)；`tickIndex` 终态按 `autoCommit` 配置调 `autoCommitWiki` 并写 `job.autoCommit` (index.js:2014-2020)。
- `installWebServer(ctx, service, extra)` (index.js:2646-2875)：`ctx.inject(['workspaceRegistry'])` 按「切片或直传实例」双形态取注册表（`rc?.workspaceRegistry ?? rc`，index.js:2655-2658）；`wsFilterPaths` 在注册表 `list()` 抛错时 console.warn 降级不过滤 (index.js:2646-2651)；五个精确端点全部回环限定（`isLoopbackRequest` index.js:2548-2551）：`GET /api/codewiki/jobs`（workspaceOnly 过滤但非终态任务例外放行，index.js:2646-2650 与 index.js:2646-2664）、`GET /api/codewiki/repos`（30s 缓存、签名含工作区清单+活动任务，index.js:2646-2653 与 index.js:2646-2732）、`GET /api/codewiki/models` (index.js:2646-2661)、`GET /api/codewiki/model-efforts` (index.js:2646-2666)、`POST /api/codewiki/control`（cancel/refresh/compile，index.js:2646-2677）。
- `installUpdateReminder(ctx, config)` (index.js:2989-3021)：`ctx.inject(['agents'])` 枚举存量会话 + `agent/created` 增量安装 section `codewiki:update-reminder`（order=`getSectionOrder('TOOL_REPORT')+1`，index.js:2989）；text 回调每次组装求值——`updateReminder=false` 或会话仓库根缺 `CodeWiki.md` 入口时返回空串（门控刻意不看 `.codewiki/` 目录，index.js:2989-2995）；`reminderText` (index.js:2978-2987) 注入 autoCommit 后的收尾口径（不等待/不轮询/不跑 git）；`commitHintText` (index.js:2947-2976) 只在最近一次成功编译的完成时间晚于 `.codewiki/`+`CodeWiki.md` 最后 git 提交时注入「产物待提交」，并带出 `autoCommit.reason` 失败原因 (index.js:2989-2992)。
- `autoCommitWiki(cwd, {jobId, writtenCount})` (index.js:2904-2945)：spawnSync git，安全边界逐条拒绝——非 git 仓库 (index.js:2904)、无 HEAD (index.js:2904)、`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD` 进行中 (index.js:2914-2916)、`ls-files -u` 未解决冲突 (index.js:2904)、未 tracked 且被 `check-ignore` 忽略 (index.js:2904-2907)、无改动返回 `noChanges` (index.js:2925)、缺 `user.name`/`user.email` (index.js:2926-2928)；只 add `.codewiki`/`CodeWiki.md` 两个路径 (index.js:2904)、`commit --no-verify` 不跑仓库钩子 (index.js:2904)，返回 `{committed, sha, message, noChanges, reason}`。
- `wakeCompileSession(job, outcome, agents=agentsRef)` (index.js:1202-1216)：0.10.9 核心行——`outcome !== 'failed' && job?.autoCommit?.committed` 时直接 return（自动提交成功零打扰，index.js:1202）；仅 failed 或自动提交被拒时 steer 一次，source 标记 `{kind:'plugin:codewiki'}` (index.js:1202)；无 sessionId/冷会话/steer 抛异常一律静默。
- `classifySessionTask` (index.js:1024-1034) 三态 timeout/harvest/wait；`buildSessionSteerText` (index.js:1041-1059) 会话通道 steer 文本唯一生成处（`sessionTier` 非空时要求 delegate 显式传 tier）。
- `listModelCatalog(llm)` (index.js:2584-2605)：`llm.listProviders()` + 逐 provider `listModels`，单 provider 失败只附 error 不拖累整份目录；`resolveModelInfoOf` (index.js:2611-2616) 优先宿主 `resolveModelInfo`、回落 `resolveModel`（0.10.4 修的调错方法名）；`resolveModelEfforts` (index.js:2622-2644) 返回 `{ok, provider, model, efforts, defaultEffort, context}`。
- `llmChat` (index.js:285-304)：唯一模型通道——宿主 `llm.stream()`，`reasoningEffort` 非空才下发 (index.js:290)，`BlockAssembler` 收文本，finish 为 error/aborted 抛错；`runRealtimeTasks` (index.js:329-358) 后台并发池唯一执行器，任务可自带 provider/model/reasoningEffort（大档任务按自带档分派，index.js:285-287）。
- `resolveBinary` (index.js:105-125) binaryPath → PATH 探测（win32 `where`）→ 捆绑 `bin/cw`；`runCw` (index.js:127-152) spawn + 120s 超时 SIGKILL + abort 监听。

### 客户端侧注入（client.js）

- `window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})` (client.js:10-12)；factory 返回 `{inject:['slots','locale','configForms'], apply(ctx)}` (client.js:410-412)。`NS='codewiki'` 即 configForms 命名空间（= 挂载条目 id，client.js:17）。
- `apply(ctx)` (client.js:412)：注册 zh/en 词典 (client.js:414)；`configForms.whileServed([NS], mount)` 宿主服务该命名空间期间才挂载 `plugins.item`（order 30，client.js:420-432）；effect 挂载 `main` + `sidebar.panellist` 双 slot（key/id=`codewiki`，order 52，client.js:435-446）。
- `CodewikiCard` (client.js:452-851)：`form.getSnapshot()` + `form.subscribe(pull)` 快照订阅（revision 变更才覆盖草稿，client.js:452-469）；`save()` 按白名单 19 键逐项 diff 出单层 op，`form.mutate(ops, snapshot.revision)` CAS 写回（client.js:663-685，键清单在 client.js:672，含 0.10.9 的 `autoCommit` 与 `workspaceOnly`）；并发校验 1–8 (client.js:452-455)；`modelTrio` (client.js:562-661) 渲染提供商/模型/思考程度三联动（换 provider 清空 model 与旧档位）；`useEfforts` (client.js:524-557) 选中 provider/model 后二次拉 `/api/codewiki/model-efforts`。
- `CodewikiPanel` (client.js:1137-1337)：2s 轮询 `GET /api/codewiki/jobs`（`POLL_MS` client.js:22，拉取防重入 client.js:1137-1177）；`cancel` POST control (client.js:1195-1203)；`ACTIVE_STAGES` 含 `queued`（client.js:28）、`STAGE_WEIGHTS` 五阶段定权（articles 0.65，client.js:939）。
- `ReposTab` (client.js:992-1135)：10s 轮询 `/api/codewiki/repos`（`REPOS_POLL_MS` client.js:26）；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并触发 control refresh（client.js:1022-1040）；`compile` 动作直发 control（client.js:1042-1050）。

### 测试 Mock 与验证（test-orchestration.mjs）

- `batchCfg` (test-orchestration.mjs:34)：默认 `{batchProvider:'workbuddy', batchModel:'hy3'}`——0.10.1 起编译模型必须显式指向设置里的 provider/model，provider 留空即提交失败（test-orchestration.mjs:34-35）。
- `makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})` (test-orchestration.mjs:40-80)：mock 宿主上下文。`inject(deps, fn)` 带回调时传「ctx 切片」（服务在切片同名属性上——宿主同构；直传实例会掩盖 cordis 严格语义，test-orchestration.mjs:58-68）；promise 形态返回服务数组 (test-orchestration.mjs:40-41)；`effect(fn)` 立即执行 body、返回函数则收集为 disposer——防线：若回归 `ctx.effect(() => service.stop())` 错写法，tick 停摆、整套编排测试挂死 (test-orchestration.mjs:73-77)。
- `llmProxy` (test-orchestration.mjs:121-129)：注册进 makeCtx 的 llm 服务恒转发 `activeLlm`，每个测试块 `makeBatchMock()` 一处接线；`makeBatchMock({stall, bigArticle, ...})` (test-orchestration.mjs:134-198) 按 prompt 首行特征分发应答（观察员/作者/审校员/横切各分支）。
- 其它夹具：`makeMockAgent` (test-orchestration.mjs:83-97，systemPrompt section 注册捕获)、`makeFixtureRepo` (test-orchestration.mjs:99-116，顶层 core/util 两目录 + git identity——autoCommitWiki 缺 `user.name` 会拒绝提交)、`waitJob` (test-orchestration.mjs:201-214)、`fakeReq`/`fakeRes` (test-orchestration.mjs:216-228)、`validateOut`（与宿主校验器同构的 output schema 检查，test-orchestration.mjs:1138-1153）。
- 关键断言块：autoCommitWiki 安全边界九分支 (test-orchestration.mjs:376-448)；wakeCompileSession 静默矩阵（autoCommit 成功→零唤醒、失败→一次性降级提醒，test-orchestration.mjs:450-482）；编译模型缺失诚实报错 + job `failed` 留痕 (test-orchestration.mjs:1208-1221)；严格 cordis 语义（getter 抛错模拟、apply 不抛、工具仍注册——fiber 不回滚，test-orchestration.mjs:1223-1245）；workspaceOnly 过滤与非终态放行 (test-orchestration.mjs:1041-1102)；registry 抛错降级 (test-orchestration.mjs:1104-1132)；孤儿接管 (test-orchestration.mjs:1174-1206)；Temp 终态任务清理 (test-orchestration.mjs:1247-1264)。

### 文档与变更（README.md / CodeWiki.md / CHANGELOG.md / package.json）

- README.md：设置段逐项说明——`batchProvider`/`batchModel` 唯一通道、不存密钥 (README.md:29)；`batchReasoningEffort` 从模型目录读取 (README.md:30)；大档四项与 420k 预算 (README.md:30)；`sessionTier` 仅超大兜底 (README.md:32)；`binaryPath`/`maxConcurrency`/`serialProjects`/`articleLanguage`/`updateReminder` (README.md:34-38)；`autoCommit` 语义与降级条件 (README.md:39)；全部 `volatile` 热生效 (README.md:40)；设置页保存走 `configForms.mutate`、与 patch 手改等价 (README.md:26)；挂载为 profile patch file:/// 条目（不需要 profile link，README.md:30-37）；`@deepseek-ai/schemastery` 走插件本地 junction (README.md:30)。
- CodeWiki.md：`Config` 描述 (CodeWiki.md:12)、`installUpdateReminder` 严格语义 (CodeWiki.md:14)、`wakeCompileSession` 0.10.9 静默 (CodeWiki.md:16)、模型执行模块与唯一通道 (CodeWiki.md:14)、`createJobService` 阶段机与串行 (CodeWiki.md:19)、webServer 五端点 (CodeWiki.md:14)、Data Flow 配置流/凭证流 (CodeWiki.md:58)。注意 CodeWiki.md:23 的 `apply` 描述已过期（见 Known Issues）。
- CHANGELOG.md：0.10.9 autoCommitWiki/唤醒静默/设置项 (CHANGELOG.md:3-17)；0.10.1 删百炼直连与凭证解析链、submit 三重校验、Config 删 `batchApiKey`/`batchThinkingBudget` (CHANGELOG.md:117-129)；0.10.0 `resolveModelEfforts` + `/api/codewiki/model-efforts` + `serialProjects` (CHANGELOG.md:131-144)；0.9.1 `listModelCatalog` + `/api/codewiki/models` (CHANGELOG.md:159-169)；0.8.6 模块级 `llmRef`（`hostCtxRef?.llm` 在 cordis 下访问即抛）(CHANGELOG.md:210-218)；0.8.5 source.kind 改 `plugin:codewiki` (CHANGELOG.md:220-229)；0.4.10 inject 切片语义修复 (CHANGELOG.md:404-413)；0.4.3 `ctx.effect` disposer 与 service 参数注入 (CHANGELOG.md:468-486)；0.2.7 `installUpdateReminder` 改 `inject(['agents'])`（直接访问 ctx.agents 抛错曾致插件整体未装载）(CHANGELOG.md:551-557)；0.2.5 section 注册 (CHANGELOG.md:568-574)。
- package.json：`name: @local/dsh-codewiki`（=client loader id，package.json:2）、`exports["./client"]` + `dsh.client.platform:"web"` 让宿主扫描器沿 file:/// 条目发现客户端模块（package.json:8-11 与 package.json:21-23）、`engines.dsh >=0.2.0-rc.0`（第三方插件兼容性判定，package.json:13-16）。

## Architecture

```text
┌────────────────────────┐ ctx.inject(['agents','llm'])  ┌───────────────────────┐
│ cordis 宿主 (Harness)   │ ────────────────────────────► │ index.js apply        │
│ services: tools /      │ ◄── tools.register(4 工具) ── │ (index.js:3023)       │
│ webServer / agents /   │                               │  ├ createJobService   │
│ llm / workspace-       │                               │  ├ installWebServer   │
│ Registry / configForms │                               │  └ Reminder(:2989)    │
│ / slots / locale       │                               └───────────┬───────────┘
└───────────┬────────────┘                                           │ volatile 热读
            │ client inject(['slots','locale','configForms'])        ▼
            ▼                                            ┌───────────────────────┐
┌────────────────────────┐ form.mutate(单层 op + CAS)    │ Config (index.js:48)  │
│ client.js apply        │ ────────────────────────────► │ → liveConfig(:74)     │
│ (client.js:412)        │ ◄── GET /api/codewiki/* ───── │ → JobService(:1218)   │
│ CodewikiCard / Panel   │     （端点回环 only）          └───────────────────────┘
└────────────────────────┘
  test-orchestration.mjs makeCtx(:40-80)：切片语义 mock 宿主；llmProxy(:121) 转发 activeLlm
```

## Data Flow

1. **配置加载与注入**：宿主按 profile patch `config:` 段（挂载条目见 README.md:47-54）构建 schemastery 配置对象，以 `apply(ctx, config)` 注入插件；全部字段 `.volatile()`，允许改完即生效。
2. **服务切片装配**：`apply` 先缓存 `agentsRef`/`llmRef`（index.js:3024-3025），再经 `tools` 服务注册四个工具（index.js:3063-3079）；`installWebServer` 内注入 `workspaceRegistry` 与 `webServer`（index.js:2655、index.js:2679）；`installUpdateReminder` 经 `agent.ctx.inject(['systemPrompt'])` 注册 section（index.js:2995）；客户端 inject `slots`/`locale`/`configForms`（client.js:411）。
3. **严格语义保障**：未 inject 的服务属性访问即抛（测试用 getter 模拟真实 cordis，test-orchestration.mjs:1237-1242）；插件侧两道防御——`apply` 自身不向 cordis 抛错、已注册工具不被回滚（test-orchestration.mjs:1242-1243），工具注册循环逐定义 try/catch（index.js:3023-3031）。
4. **配置热读取与持久化闭环**：客户端订阅快照（client.js:663-680）→ `save()` 19 键 diff → `form.mutate(ops, revision)` CAS 写回宿主 configForms（client.js:663-670）→ 下次 execute/tick `liveConfig` 重新解包（index.js:74-99）。面板排除清单走同一条 mutate 链路（client.js:1031）。
5. **模型通道与自动提交**：`submit` 三重校验（provider/model/llm.stream，index.js:2111-2120）→ 全部环节走 `llmChat`→宿主 `llm.stream`（index.js:285-304，凭证由宿主按 provider 解析，插件零密钥）→ 终态 `tickIndex` 按 `autoCommit` 配置调 `autoCommitWiki`（index.js:2014-2020）→ 提交成功则 `wakeCompileSession` 直接 return 零唤醒（index.js:1205）；失败经 `commitHintText`/steer 发一次性「产物待提交」提醒（index.js:2947-2976）。

## Connections

- [[index.js]] — `Config`/`liveConfig`/`apply`/`installWebServer`/`installUpdateReminder`/`autoCommitWiki` 的实现本体。
- [[client.js]] — configForms 表单注入、CAS 保存与面板轮询。
- [[test-orchestration.mjs]] — 严格 cordis 语义、切片 mock 与 autoCommit/唤醒矩阵的端到端验证。
- [[README.md]] 与 [[CodeWiki.md]] — 配置流、注入点与挂载方式的文档描述。
- [[CHANGELOG.md]] — 注入修复史（0.2.5→0.10.9）与模型通道演进记录。
- [[dsh-codewiki]] — 插件整体架构关联概念。

## Known Issues

- **测试日志过期残留**：`.tmp-test-orchestration.log` 末尾 `FAIL：2 项未通过`（.tmp-test-orchestration.log:573）来自旧版测试——其 wake 块标题（.tmp-test-orchestration.log:110）与 source 断言（:114、:195 要求 `plugin/codewiki`）已被现源码取代（`plugin:codewiki`，test-orchestration.mjs:469），其「规划阶段改走主模型」整块（.tmp-test-orchestration.log:120-184）也随 0.10.7 删规划阶段被本地规划块替换（test-orchestration.mjs:484-541）。日志为历史运行残留，非真实缺陷。
- **文档遗留旧描述**：CodeWiki.md:23 仍写 `apply` 为 `ctx.inject(['tools','webServer','credentials'])` 且「注册两工具」——实际 index.js:3023-3081 注入 agents/llm/tools/webServer（credentials 已随 0.10.1 删除，CHANGELOG.md:117-129）并注册四个工具。
- **严格语义静默降级**：apply 在严格 cordis 下不抛错且工具仍注册（test-orchestration.mjs:1242-1243），`installUpdateReminder` 服务缺失静默跳过（index.js:2989-2995）、`installWebServer` 的 webServer 缺失时整体跳过（index.js:2989-2992）——缺失服务只表现为功能静默缺席（面板查不到进度/提醒不注入），不报错。
- **registry 异常防御**：`workspaceRegistry.list()` 抛错（宿主注册表内部不一致）时 jobs/repos 端点降级不过滤、仍 200（index.js:2651-2656；测试 test-orchestration.mjs:1104-1132）。
- **commitHintText 缓存陷阱**：60s TTL 缓存键是规范化 cwd（index.js:2948-2950）；测试需换全新 fixture 仓库绕开缓存（test-orchestration.mjs:325-340）；`jobSec > commitSec` 为严格大于，同秒提交/编译竞态需 sleep 隔开（test-orchestration.mjs:347）。
- **自动更新扫描异常吞没**：`autoScan` 单仓异常只记 `schedState.lastError` 不打断扫描（index.js:3037-3038），面板调度卡可见但无主动告警。
- **路径归一局限**：`normalizeCwd` 仅 win32 归一 `/c/...` 形态，POSIX 上原样保留（index.js:37-42）。
- **submit 失败留痕**：模型通道校验失败会先落一条 `failed` job 再抛错（index.js:2150-2153），面板与 `codewiki_progress` 可见——这是可观测性设计而非缺陷，但意味着失败重试会在任务历史里留下失败记录。