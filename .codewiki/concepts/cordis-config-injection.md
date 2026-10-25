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

`cordis-config-injection` 是 dsh-codewiki 插件在 DeepSeek Harness（cordis 框架）中运转的核心机制，覆盖两件事。其一是通过 `ctx.inject(['service'])` 严格获取宿主服务切片——宿主侧注入 `agents`/`llm`（index.js:3111-3112）、`tools`（index.js:3150）、`workspaceRegistry`/`webServer`（index.js:2695、index.js:2719），客户端注入 `slots`/`locale`/`configForms`（client.js:419）——并遵循 cordis 严格语义（未 inject 直接访问服务属性即抛错，`typeof` 守卫无效）。其二是配置的注入与热生效：schemastery `Config` 全字段 `.volatile()`（index.js:51-71），运行时经 `liveConfig` 每次调用重新解包（index.js:77-102），客户端经 `configForms.mutate` 单层 op + revision CAS 写回（client.js:174-196）。0.10.1 起编译模型通道唯一化为宿主 `llm` 服务（内置百炼直连与 `credentials` 凭证解析链已删，`batchProvider` 留空即提交失败）；0.10.9 新增 `autoCommit` 配置（index.js:66）与 `autoCommitWiki` 自动提交，0.10.10 补 `autoCommitState` 三态判定（index.js:1214-1219），0.10.11 把产物提交升级为阶段机里的独立 `commit` 阶段并改为「主题分支 codewiki/wiki-<jobId> 提交 → 合并回原分支」（index.js:2033-2035、index.js:3102-3136）——`wakeCompileSession` 在「已提交/产物无改动」时都零唤醒（index.js:1225）。该概念横跨测试验证（test-orchestration.mjs）、文档（README.md、CodeWiki.md、CHANGELOG.md）与宿主/客户端实现（index.js、client.js、package.json），是插件装配、模型通道声明与设置持久化的基石。

## Key Components

### 配置 Schema 与热生效（index.js）

- `Config` (index.js:51-71)：schemastery `z.object`，全部字段 `.volatile()`（execute/tick 时解包读取，改完即生效）。字段与默认值：
  - `enabled` (index.js:52，默认 true，停用后工具立即报错)
  - `binaryPath` (index.js:53，留空 PATH 优先、捆绑 `bin/cw` 兜底)
  - `batchProvider` (index.js:54，默认 `workbuddy`；必须是模型设置里已注册的 provider id，留空无法提交——0.10.1 起唯一通道)
  - `batchModel` (index.js:55，默认 `hy3`)
  - `batchReasoningEffort` (index.js:56，留空=模型默认档；可选值由 `/api/codewiki/model-efforts` 从模型目录实时读取)
  - `bigProvider` (index.js:57，默认 `volces-ark`，留空=关闭大档、退回会话通道兜底)
  - `bigModel` (index.js:58，默认 `glm-5.3-flash`，512k 上下文)
  - `bigReasoningEffort` (index.js:59)
  - `bigTokenBudget` (index.js:60，默认 420000)
  - `sessionTier` (index.js:61，仅大档装不下且关闭大档时兜底的子智能体档位 id)
  - `maxConcurrency` (index.js:62，默认 2，1–8 硬顶 8)
  - `serialProjects` (index.js:63，单项目串行，默认开)
  - `articleLanguage` (index.js:64，默认中文)
  - `updateReminder` (index.js:65，默认开)
  - `autoCommit` (index.js:66，默认开：编译完成后由插件在主题分支上提交产物再合并回原分支，只 add `.codewiki/` 与 `CodeWiki.md`；非 git 仓库或提交失败时降级为提醒会话模型提交)
  - `excludePaths` (index.js:67，换行/分号/逗号分隔绝对路径)
  - `autoUpdate` (index.js:68，默认关) / `autoUpdateMin` (index.js:69，默认 30 最小 5)
  - `workspaceOnly` (index.js:70，默认开)
- `val(x)` (index.js:73-75)：兼容 schemastery 对象的 `.get()` 与裸值。
- `liveConfig(config)` (index.js:77-102)：每次调用重新解包并钳制——`batchModel` 空回落 `hy3` (index.js:84)、`bigModel` 空回落 `glm-5.3-flash` (index.js:87)、`bigTokenBudget` 下限 `BATCH_TOKEN_BUDGET` (index.js:89)、并发仅在 ≥1 时钳到硬顶 8 否则默认 2 (index.js:77-79)、`autoUpdateMin` 下限 5 (index.js:98)、`autoCommit`/`serialProjects`/`workspaceOnly` 均为「显式 false 才关」 (index.js:94、index.js:99-100)。注意 `batchProvider` 不做任何回落 (index.js:83)，空值由 submit 校验拦截。
- 常量：`CONCURRENCY_HARD_CAP=8` (index.js:22)、`DEFAULT_CONCURRENCY=2` (index.js:24)、`DEFAULT_BATCH_PROVIDER='workbuddy'` (index.js:26)、`DEFAULT_BATCH_MODEL='hy3'` (index.js:27)、`DEFAULT_BIG_PROVIDER='volces-ark'` (index.js:30)、`DEFAULT_BIG_MODEL='glm-5.3-flash'` (index.js:31)、`DEFAULT_BIG_TOKEN_BUDGET=420000` (index.js:33)、`WIKI_PATHS=['.codewiki','CodeWiki.md']`（自动提交/忽略检测/待提交提醒共用的唯一定义，index.js:36）、`BATCH_TOKEN_BUDGET=110000` (index.js:374)、`BATCH_TOKEN_HARD_LIMIT=128000` (index.js:379)。
- 运行时环境常量：`JOBS_FILE`（`DSH_CODEWIKI_JOBS_FILE` 可隔离，index.js:1015）、`TICK_MS`（默认 10s、下限 250ms，index.js:1016）、`SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，index.js:1020）、`SESSION_TASK_DIR` (index.js:1021)、`ORPHAN_TAKEOVER_MS`（默认 5 分钟，index.js:1064）、`MAX_JOBS_KEPT=30` (index.js:1015)、`REPOS_FILE`（`DSH_CODEWIKI_REPOS_FILE` 可隔离，index.js:1070）、`JOB_TERMINAL`（终态集合，index.js:1083）、`commitHintCache`（cwd→{at,text}，60s TTL，index.js:2930）。
- `name` 导出 `'dsh-codewiki'` (index.js:19)；`normalizeCwd` (index.js:40-45) 仅 win32 做 `/c/...`→`C:/...` 归一，POSIX 原样。

### 宿主侧 cordis 注入入口（index.js）

- `apply(ctx, config)` (index.js:3110-3169)：cordis 插件入口，装配顺序：
  1. `ctx.inject(['agents'])` → 模块级 `agentsRef` (index.js:3111，声明 index.js:1201)
  2. `ctx.inject(['llm'])` → 模块级 `llmRef` (index.js:3112，声明 index.js:1206)
  3. `createJobService(config, wakeCompileSession)` + `service.start()` (index.js:3113-3114)
  4. `ctx.effect(() => () => service.stop())`——必须返回 disposer 本身；写成 `() => service.stop()` 会在启动时当场停服 (index.js:3115-3117)
  5. 构建 `generateDef`/`updateDef` (index.js:3118-3119)
  6. 自动更新调度：`autoScan` 60s 心跳（`scanTimer`，index.js:3147-3149）对历史工作区逐仓 scope=auto（execute 幂等，index.js:3124-3146），单仓异常只记 `schedState.lastError`
  7. `ctx.inject(['tools'])` 注册四个工具——`cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` (index.js:3150-3166)
  8. `installWebServer(ctx, service, {config, schedState, compile})` (index.js:3167)
  9. `installUpdateReminder(ctx, config)` (index.js:3168)
- 工具注册逐定义 try/catch (index.js:3156-3164)：单个 schema 违规只丢该工具并 console.error，不让回调失败触发 cordis 回滚整个 fiber（0.8.2 教训，CHANGELOG.md:286-295）。
- `createJobService(config, onSettled)` (index.js:1238-2240)：返回 `{submit, cancel, list, findActive, start, stop}` (index.js:1238)。与配置/注入直接相关的面：
  - 模型通道三重校验 (index.js:1206-1215)：`batchProvider` 非空 (index.js:2184)、`batchModel` 非空 (index.js:2185)、`llmRef.stream` 可用 (index.js:2186)，任一缺失则 fail、落盘后向上抛（job 留 failed 痕迹）；`credentialSource` 恒为 `llm(<provider>/<model>)` (index.js:2192)。
  - 提交占位先行（stage=`submitting` 挡住校验窗口内的并发重复提交，index.js:2157-2177）；排除清单命中直接抛错并带排除项原文 (index.js:2081-2083)；单项目串行判定 (index.js:2081-2093)——`serialProjects` 开启且已有别的项目推进时本任务进 `queued`，预置 `pendingStage`/`pendingTasks` 轮到时才落地；submit 末尾先落盘再立即推进一步 (index.js:2081-2083)。
  - 每 tick：串行闸门 `activeId`（在跑优先、否则取最早 queued，index.js:2078-2083）、queued 唤醒恒进 articles (index.js:2078-2088)、foreign 孤儿按停更超时接管 (index.js:2078-2087)、旧 plan 阶段任务迁移 (index.js:2078-2085)；跨进程推进锁 `acquireTickLock` (index.js:1133-1148)、磁盘吸收 `mergeFromDisk` + 脏标记 `flush` (index.js:1270-1295)、Temp 目录终态任务启动清理 (index.js:2078-2089)。
  - 0.10.11 阶段机：`STAGE_HANDLER` 含 `commit: tickCommit`，顺序为 queued → articles → crosscut → compose → review → index → commit → done (index.js:2060-2067)；`tickIndex` 末尾在有产物且 `autoCommit` 开启时 `setStage(job, 'commit')` 提前返回，不再就地提交 (index.js:2033-2035)；`tickCommit` 执行提交后才置 done/finishedAt 并唤醒会话 (index.js:2042-2058)——提交失败不改变任务终态，只写 `job.autoCommit` 供「产物待提交」提醒与面板展示。
  - `jobSummary` 把 `autoCommit` 透出给面板与 `codewiki_progress` (index.js:1187)；`codewiki_progress` 的 autoCommit 输出 schema 含 `mode`/`branch`/`fallback` 字段 (index.js:2518-2531)。
- `autoCommitState(job)` (index.js:1214-1219，0.10.10 新增导出)：自动提交三态的唯一判定——`committed=true` → `'committed'`、`noChanges=true` → `'no-changes'`、其余（含旧 job 无该字段）→ `'pending'`，`committed` 优先于 `noChanges`；`wakeCompileSession`（实时 steer）与 `commitHintText`（系统提示 section）两条通道共用，避免「产物无改动」被当成失败催两次。
- `wakeCompileSession(job, outcome, agents=agentsRef)` (index.js:1221-1236)：编译终态对发起会话 steer 唤醒。
  - 核心守卫 (index.js:1225)：非 failed 且自动提交三态不是 `pending` 时直接 return——已提交（`committed`）与产物无改动（`no-changes`）都零打扰（0.10.9 收回提交责任、0.10.10 补齐无改动语义，CHANGELOG.md:22-28）。
  - 仅 failed 或自动提交被拒时 steer 一次：失败消息含 error 原因，降级文案含「产物待提交」标题、失败原因、提交动作指引并要求不中断不轮询 (index.js:1230-1232)，消息 source 标记 `plugin:codewiki` (index.js:1234)。
  - 无 sessionId（面板/自动调度提交）、冷会话、agents 缺失、steer 抛异常一律静默 (index.js:1226-1229)。
- `autoCommitWiki(cwd, {jobId, writtenCount})` (index.js:2948-3030，0.10.11 重写为分支合并式)：
  - 前置安全检查（全部在分支切换之前执行，任一不满足即拒绝并降级，绝不做半个提交）：非 git 仓库 (index.js:2962)、仓库无 HEAD (index.js:2962)、merge/rebase/cherry-pick 进行中（`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD`，index.js:2962-2964)、`git ls-files -u` 命中未解决冲突 (index.js:2962)、`.codewiki/`（或未 tracked 的 CodeWiki.md）被 `git check-ignore` 忽略 (index.js:2962-2965)、产物无改动 → 返回 `noChanges` 不产空提交 (index.js:2973)、缺 user.name/user.email (index.js:2962-2964)。
  - `commitOn()` 内层提交：`git add -- .codewiki CodeWiki.md`（pathspec 形式由 `WIKI_PATHS` 唯一定义，index.js:36，不是 -A/--all/.）+ `git commit --no-verify -m "docs(wiki): …"` 不跑仓库钩子（index.js:2979-2991）；add/commit 自身失败（含 index.lock 被占用）把 stderr 摘录写进 reason (index.js:2979、index.js:2979)。
  - 分支合并式主路径：先建主题分支 `codewiki/wiki-<jobId>` (index.js:2999)，在其上提交，再切回原分支 `git merge --no-edit`（能 ff 则 ff）合并，成功后 `git branch -d` 删主题分支（`-d` 只删已合并分支，绝不强删，index.js:3024-3025）；进入主题分支后任何失败先切回原分支（`finally` 保证，index.js:3004-3010），绝不把用户留在插件建出的分支上。
  - 降级：detached HEAD 无「原分支」可回 (index.js:2994-2998) 或建主题分支失败 (index.js:3000-3003) → 直接提交（`mode:'direct'` + `fallback` 原因）；合并冲突/失败 → `git merge --abort`、保留主题分支、绝不强合、产物不丢（index.js:3015-3023）。
  - 返回 `{committed, sha?, message?, noChanges?, reason?, mode?, branch?, fallback?}` (index.js:2946)。
- `installWebServer(ctx, service, extra)` (index.js:2686-2915)：`workspaceRegistry` 注入按「切片或直传实例」双形态取注册表（`rc?.workspaceRegistry ?? rc`，index.js:2695-2698）；五个精确端点全部回环限定（`guard` index.js:2722-2726，`isLoopbackRequest` index.js:2588-2591）：
  - `GET /api/codewiki/jobs` (index.js:2727-2745)：workspaceOnly 开启时终态任务按工作区过滤，非终态（queued/编译中）例外放行——编译中的仓库必须可见、可取消 (index.js:2734-2738)。
  - `GET /api/codewiki/repos` (index.js:2749-2835)：30s 缓存，签名含工作区清单与当前非终态任务（编译中仓库进出总览立即反映）(index.js:2755-2761)。
  - `GET /api/codewiki/models` (index.js:2842-2857) 与 `GET /api/codewiki/model-efforts` (index.js:2861-2881)：设置页级联下拉与思考档位的数据源。
  - `POST /api/codewiki/control` (index.js:2882-2913)：cancel/refresh/compile 三动作。
  - 注册表抛错（宿主内部不一致）时 console.warn 降级、jobs/repos 仍 200 不过滤 (index.js:2709-2714)；webServer 服务缺失时注入回调整体静默跳过 (index.js:2718-2721)。
- `installUpdateReminder(ctx, config)` (index.js:3076-3108)：`ctx.inject(['agents'])` 枚举存量会话 (index.js:3100-3106) + `agent/created` 增量安装 (index.js:3076)；agent.ctx `inject(['systemPrompt'])` 注册 section `codewiki:update-reminder`（order=`getSectionOrder('TOOL_REPORT')+1`，index.js:3082-3087）；text 回调每次组装求值——`updateReminder=false` 或会话仓库根缺 CodeWiki.md 入口时返回空串（门控刻意不看 `.codewiki/` 目录，index.js:3076-3078）；`reminderText` (index.js:3065-3074) 注入 autoCommit 分支合并式后的收尾口径（不等待/不轮询/不跑 git，index.js:3076）；`commitHintText` (index.js:3032-3063) 只在最近一次成功编译的三态为 `pending` 时注入一次性「产物待提交」（完成时间晚于 `.codewiki/`+CodeWiki.md 最后 git 提交，已提交/无改动一律静默，index.js:3043-3049），并带出 `autoCommit.reason` 失败原因 (index.js:3050-3052)。
- `llmChat` (index.js:288-307)：唯一模型通道——宿主 `llm.stream()`，`reasoningEffort` 非空才下发 (index.js:293)，`BlockAssembler` 收文本，finish 为 error/aborted 抛错；`runRealtimeTasks` (index.js:332-361) 后台并发池唯一执行器，任务可自带 provider/model/reasoningEffort（大档任务按自带档分派，index.js:288-290）。
- `listModelCatalog(llm)` (index.js:2624-2645)：`llm.listProviders()` + 逐 provider `listModels`，单 provider 失败只附 error 不拖累整份目录；`resolveModelInfoOf` (index.js:2651-2656) 优先宿主 `resolveModelInfo`、回落 `resolveModel`（0.10.4 修的调错方法名，CHANGELOG.md:194-201）；`resolveModelEfforts` (index.js:2662-2684) 返回 `{ok, provider, model, efforts, defaultEffort, context}`。
- `resolveBinary` (index.js:108-128) binaryPath → PATH 探测（win32 `where`）→ 捆绑 `bin/cw`；`runCw` (index.js:130-155) spawn + 120s 超时 SIGKILL + abort 监听。
- `classifySessionTask` (index.js:1027-1037) 三态 timeout/harvest/wait；`buildSessionSteerText` (index.js:1044-1062) 会话通道 steer 文本唯一生成处（`sessionTier` 非空时要求 delegate 显式传 tier）。

### 客户端侧注入（client.js）

- `window.__ModuleLoader__.load({id:'@local/dsh-codewiki', factory})` (client.js:10-12)；factory 返回 `{inject:['slots','locale','configForms'], apply(ctx)}` (client.js:418-420)。`NS='codewiki'` 即 configForms 命名空间（= 挂载条目 id，client.js:17）；`KEY='codewiki'` 为面板 slot id (client.js:18)。
- `apply(ctx)` (client.js:420-454)：注册 zh/en 词典 (client.js:422)；`configForms.whileServed([NS], mount)` 宿主服务该命名空间期间才挂载 `plugins.item`（order 30，client.js:427-440）；effect 挂载 `main` + `sidebar.panellist` 双 slot（key/id=`codewiki`，order 52，client.js:443-454）。
- `CodewikiCard` (client.js:460-859)：快照订阅 getSnapshot + subscribe，revision 变更才覆盖草稿 (client.js:460-477)；`save()` 按白名单 19 键逐项 diff 出单层 op，`form.mutate(ops, snapshot.revision)` CAS 写回（client.js:671-693，键清单 client.js:460：enabled/binaryPath/maxConcurrency/serialProjects/articleLanguage/updateReminder/autoCommit/workspaceOnly/batchProvider/batchModel/batchReasoningEffort/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget/sessionTier/excludePaths/autoUpdate/autoUpdateMin）；并发校验 1–8 (client.js:460-464)；`modelTrio` (client.js:570-669) 渲染提供商/模型/思考程度三联动（换 provider 清空 model 与旧档位，client.js:460-467）；`useEfforts` (client.js:532-563) 选中 provider/model 后二次拉 `/api/codewiki/model-efforts`（`EFFORTS_PATH` client.js:25）。
- `CodewikiPanel` (client.js:1145-1358)：2s 轮询 `POLL_MS` (client.js:22) 拉 `GET /api/codewiki/jobs`（拉取防重入，client.js:1145、client.js:1145-1148）；取消按钮 POST control (client.js:1145-1153)；任务卡自动提交三态展示（0.10.11 起含主题分支）——committed 显示短 sha + `branch` (client.js:1258)、noChanges 一句 (client.js:1145)、失败原因进任务行 title 而非 meta (client.js:1145-1149)；`ACTIVE_STAGES` 含 `queued` 与 `commit` (client.js:28)；`STAGE_WEIGHTS` 定权 articles 0.63 / commit 0.02 (client.js:947)；`lastTimedStage` 过滤旧阶段残留计时键 (client.js:919-922)；`stageCommit` 步骤条文案「提交产物中/Committing」(client.js:95、client.js:237)。
- `ReposTab` (client.js:1000-1143)：10s 轮询 `REPOS_POLL_MS` (client.js:26) 拉 `/api/codewiki/repos`；`toggleExclude` 经 `form.mutate` 改 `excludePaths` 并触发 control refresh (client.js:1030-1048)；「更新」按钮经 control compile 动作直发 (client.js:1000-1008)。

### 测试 Mock 与验证（test-orchestration.mjs）

- `batchCfg` (test-orchestration.mjs:38)：默认 `{batchProvider:'workbuddy', batchModel:'hy3'}`——0.10.1 起编译模型必须显式指向设置里的 provider/model，provider 留空即提交失败（test-orchestration.mjs:38-40）。
- `makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})` (test-orchestration.mjs:44-84)：mock 宿主上下文。`inject(deps, fn)` 带回调时传「ctx 切片」（服务在切片同名属性上——宿主同构；直传实例会掩盖 cordis 严格语义，test-orchestration.mjs:62-69）；promise 形态返回单个服务或数组 (test-orchestration.mjs:44-45)；`effect(fn)` 立即执行 body、返回函数则收集为 disposer——防线：若回归 `ctx.effect(() => service.stop())` 错写法，stop 被当场调用、tick 停摆、整套编排测试挂死 (test-orchestration.mjs:75-81)。
- `llmProxy` (test-orchestration.mjs:125-133)：注册进 makeCtx 的 llm 服务恒转发 `activeLlm`，每个测试块 `makeBatchMock()` 一处接线；`makeBatchMock({stall, bigArticle, ...})` (test-orchestration.mjs:138-202) 按 prompt 首行特征分发应答（观察员/作者/审校员/横切各分支）。
- 其它夹具：`makeMockAgent` (test-orchestration.mjs:87-101，systemPrompt section 注册捕获)、`makeFixtureRepo` (test-orchestration.mjs:103-120，顶层 core/util 两目录 + git identity——autoCommitWiki 缺 user.name 会拒绝提交，test-orchestration.mjs:87-90)、`waitJob` (test-orchestration.mjs:205-218)、`fakeReq`/`fakeRes` (test-orchestration.mjs:220-232)、`validateOut`（与宿主校验器同构的 output schema 检查，test-orchestration.mjs:1224-1239）。
- 测试基建：jobs 文件名追加随机 token，防 pid 复用读到历史残留、让单项目串行误判排队（test-orchestration.mjs:18-23）；并发提交块用 stall mock 挂起任务，避免「模型失败当终态」的占位竞态（test-orchestration.mjs:946-950）。
- 关键断言块：autoCommitWiki 分支合并式安全边界（正常路径 mode==='branch'、合并后主题分支已删、只提交两个目标路径、源码改动留在工作区，test-orchestration.mjs:410-429；非 git/被忽略/合并中/缺 identity 各拒绝分支 :431-479；detached HEAD 降级 direct :481-489；主题分支名被占用降级且预占分支不误删 :491-505）；`autoCommitState` 三态单测（committed 优先于 noChanges、空 job 不抛，test-orchestration.mjs:508-518）；wakeCompileSession 静默矩阵（committed/noChanges 零唤醒、pending 一次性降级提醒、source 标记 `plugin:codewiki`，test-orchestration.mjs:520-556）；端到端补断言独立 commit 阶段（stageTimings 含 commit、mode==='branch'、自动提交后编译完成不唤醒会话，test-orchestration.mjs:630-645）；编译模型缺失诚实报错 + job failed 留痕 (test-orchestration.mjs:1294-1307)；严格 cordis 语义（getter 抛错模拟 :1323-1325、apply 不抛错、两工具仍注册——fiber 不回滚，test-orchestration.mjs:1309-1331）；workspaceOnly 过滤与非终态放行 (test-orchestration.mjs:1127-1188)；registry 抛错降级 (test-orchestration.mjs:1190-1218)；孤儿接管 (test-orchestration.mjs:1260-1292)；Temp 终态任务清理 (test-orchestration.mjs:1333-1350)。

### 文档与变更（README.md / CodeWiki.md / CHANGELOG.md / package.json）

- README.md：设置段逐项说明——`batchProvider`/`batchModel` 唯一通道、不存密钥 (README.md:29)；`batchReasoningEffort` 从模型目录读取 (README.md:30)；大档四项与 420k 预算 (README.md:30)；`sessionTier` 仅超大兜底 (README.md:32)；`binaryPath`/`maxConcurrency`/`serialProjects`/`articleLanguage`/`updateReminder` (README.md:34-38)；`autoCommit` 主题分支合并式语义与降级条件 (README.md:39)；全部 `volatile` 热生效 (README.md:40)；设置页保存走 `configForms.mutate`、与 patch 手改等价 (README.md:26)；挂载为 profile patch file:/// 条目、不需要 profile link（示例 README.md:30-45）；`@deepseek-ai/schemastery` 走插件本地 junction (README.md:30)；客户端半侧由 `dsh.client.platform:"web"` + `exports["./client"]` 驱动 (README.md:30)。
- CodeWiki.md：`Config` 描述 (CodeWiki.md:12)、`installUpdateReminder` 严格语义 (CodeWiki.md:14)、`autoCommitWiki` 安全边界 (CodeWiki.md:15)、`autoCommitState` 三态 (CodeWiki.md:16)、`wakeCompileSession` 静默 (CodeWiki.md:17)、模型执行模块与唯一通道 (CodeWiki.md:14)、`createJobService` 阶段机与串行 (CodeWiki.md:20)、webServer 端点 (CodeWiki.md:14)、Data Flow 配置流/凭证流 (CodeWiki.md:61)。注意 CodeWiki.md:20、:24、:42、:50 存在滞后描述（见 Known Issues）。
- CHANGELOG.md：0.10.11 独立 commit 阶段与主题分支合并式 (CHANGELOG.md:3-15)；0.10.10 `autoCommitState` 三态统一/pathspec 表述/失败原因上报/面板三态展示/两处测试竞态修复 (CHANGELOG.md:17-31)；0.10.9 autoCommitWiki/唤醒静默/设置项 (CHANGELOG.md:33-47)；0.10.1 删百炼直连与凭证解析链（`bailianChat` 与 `resolveBatchApiKey`）、submit 三重校验 (CHANGELOG.md:147-159)；0.10.0 `resolveModelEfforts` + `/api/codewiki/model-efforts` + `serialProjects` (CHANGELOG.md:161-174)；0.9.1 `listModelCatalog` + `/api/codewiki/models` (CHANGELOG.md:189-199)；0.10.4 `resolveModelInfo` 方法名修正 (CHANGELOG.md:96-122)；0.8.6 模块级 `llmRef`（`hostCtxRef?.llm` 在 cordis 下访问即抛）(CHANGELOG.md:238-248)；0.8.5 source.kind 改 `plugin:codewiki` (CHANGELOG.md:250-259)；0.8.2 type 数组改 oneOf（宿主 JSON Schema 子集校验）(CHANGELOG.md:286-295)；0.4.10 inject 切片语义修复 (CHANGELOG.md:434-443)；0.4.3 `ctx.effect` disposer 与 service 参数注入 (CHANGELOG.md:498-516)；0.2.7 `installUpdateReminder` 改 `inject(['agents'])`（直接访问 ctx.agents 抛错曾致插件整体未装载）(CHANGELOG.md:581-588)；0.2.5 section 注册 (CHANGELOG.md:598-604)。
- package.json：`name: @local/dsh-codewiki`（=client loader id，package.json:2）、`version: 0.10.11` (package.json:3)、`exports["./client"]` + `dsh.client.platform:"web"` 让宿主扫描器沿 file:/// 条目发现客户端模块（package.json:8-11 与 package.json:20-23）、`engines.dsh >=0.2.0-rc.0`（第三方插件兼容性判定，package.json:13-16）。

## Architecture

```text
┌────────────────────────┐ ctx.inject(['agents','llm'])  ┌───────────────────────┐
│ cordis 宿主 (Harness)   │ ────────────────────────────► │ index.js apply(:3110) │
│ services: tools /      │ ◄── tools.register(4 工具) ── │  ├ createJobService   │
│ webServer / agents /   │                               │  │ (:1238 阶段机含     │
│ llm / workspace-       │                               │  │  commit :2066)      │
│ Registry / configForms │                               │  ├ installWebServer   │
│ / slots / locale       │                               │  └ Reminder(:3076)    │
└───────────┬────────────┘                               └───────────┬───────────┘
            │ client inject(['slots','locale','configForms'])        │ volatile 热读
            ▼                                                        ▼
┌────────────────────────┐ form.mutate(单层 op + CAS)    ┌───────────────────────┐
│ client.js apply(:420)  │ ────────────────────────────► │ Config (index.js:51)  │
│ CodewikiCard / Panel   │ ◄── GET /api/codewiki/* ───── │ → liveConfig(:77)     │
└────────────────────────┘     （端点回环 only）          └───────────────────────┘
  test-orchestration.mjs makeCtx(:44)：切片语义 mock 宿主；llmProxy(:126) 转发 activeLlm
```

## Data Flow

1. **配置加载与注入**：宿主按 profile patch `config:` 段（挂载条目见 README.md:47-54）构建 schemastery 配置对象，以 `apply(ctx, config)` 注入插件；全部字段 `.volatile()`，允许改完即生效。
2. **服务切片装配**：`apply` 先缓存 `agentsRef`/`llmRef` (index.js:3111-3112)，再经 `tools` 服务注册四个工具 (index.js:3150-3166)；`installWebServer` 内注入 `workspaceRegistry` 与 `webServer` (index.js:2695、index.js:2719)；`installUpdateReminder` 经 `agent.ctx.inject(['systemPrompt'])` 注册 section (index.js:3082)；客户端 inject `slots`/`locale`/`configForms` (client.js:419)。
3. **严格语义保障**：未 inject 的服务属性访问即抛（测试用 getter 模拟真实 cordis，test-orchestration.mjs:1323-1325）；插件侧两道防御——`apply` 自身不向 cordis 抛错、已注册工具不被回滚 (test-orchestration.mjs:1328-1330)，工具注册循环逐定义 try/catch (index.js:3110-3118)。
4. **配置热读取与持久化闭环**：客户端订阅快照 (client.js:671-688) → `save()` 19 键 diff → `form.mutate(ops, revision)` CAS 写回宿主 configForms (client.js:671-693) → 下次 execute/tick `liveConfig` 重新解包 (index.js:77-102)。面板排除清单走同一条 mutate 链路 (client.js:671-689)。
5. **模型通道与自动提交（0.10.11 独立 commit 阶段）**：模型通道三重校验（provider/model/llm.stream，index.js:288-297）→ 全部环节走 `llmChat`→宿主 `llm.stream` (index.js:288-307，凭证由宿主按 provider 解析，插件零密钥) → `tickIndex` 收尾后有产物且 `autoCommit` 开启则 `setStage('commit')` 提前返回 (index.js:2033-2035) → 下一 tick `tickCommit` 调 `autoCommitWiki` 走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（index.js:2042-2058、index.js:288-322）→ 结果写 `job.autoCommit`（含 `mode`/`branch`/`fallback`，schema index.js:2518-2531）→ `autoCommitState` 判 `committed`/`no-changes` 时 `wakeCompileSession` 直接 return 零唤醒 (index.js:1225)；`pending` 时才经 `commitHintText` (index.js:3032-3063) 与 steer 发一次性「产物待提交」提醒并带失败原因。

## Connections

- [[index.js]] — `Config`/`liveConfig`/`apply`/`installWebServer`/`installUpdateReminder`/`autoCommitState`/`autoCommitWiki`/`tickCommit` 的实现本体。
- [[client.js]] — configForms 表单注入、CAS 保存、commit 阶段步骤条与面板轮询。
- [[test-orchestration.mjs]] — 严格 cordis 语义、切片 mock 与 autoCommit 三态/唤醒矩阵/分支合并式的端到端验证。
- [[README.md]] 与 [[CodeWiki.md]] — 配置流、注入点与挂载方式的文档描述。
- [[CHANGELOG.md]] — 注入修复史（0.2.5→0.10.11）、模型通道演进与 commit 阶段引入记录。
- [[dsh-codewiki]] — 插件整体架构关联概念。

## Known Issues

- **测试日志过期残留**：`.tmp-test-orchestration.log` 末尾 `FAIL：2 项未通过` (.tmp-test-orchestration.log:573) 来自旧版测试运行——其 wake 块标题 (.tmp-test-orchestration.log:110) 与 source 断言（:114、:195 要求 `plugin/codewiki`）已被现源码取代（`plugin:codewiki`，test-orchestration.mjs:543）；其「规划阶段改走主模型」整块（:120-184）、「初始 stage=plan」（:188）与「无凭证诚实报错」块（:547-563）也分别随 0.10.7 删规划阶段与 0.10.1 删直连，被本地规划块（test-orchestration.mjs:558-615）与「编译模型/provider 缺失」块（test-orchestration.mjs:1294-1307）替换。日志为历史运行残留，非真实缺陷（0.10.11 验证为 PASS，CHANGELOG.md:14）。
- **文档滞后（0.10.11 阶段机未同步）**：CodeWiki.md:19 与 CodeWiki.md:19 的阶段机描述缺 `commit` 阶段（0.10.11 新增，index.js:2066）；CodeWiki.md:50 的 Architecture 图仍写 autoCommitWiki「git add -- .codewiki CodeWiki.md + commit」直接提交（实际已是主题分支合并式，index.js:2988-3022）；CodeWiki.md:24 的 `apply` 旧描述（`ctx.inject(['tools','webServer','credentials'])` 注册两工具——实际 index.js:3110-3169 注入 agents/llm/tools/webServer 并注册四个工具，credentials 已随 0.10.1 删除，CHANGELOG.md:147-159）；CodeWiki.md:19 的 `resolveModelEfforts` 写「走 llm.resolveModel().reasoning.efforts」（实际优先 `resolveModelInfo`，index.js:2651-2656，0.10.4 修正，CHANGELOG.md:98-103）。
- **严格语义静默降级**：`apply` 在严格 cordis 下不抛错且工具仍注册 (test-orchestration.mjs:1328-1330)，`installUpdateReminder` 服务缺失静默跳过 (index.js:3110、index.js:3110-3116)、`installWebServer` 的 webServer 缺失时整体跳过 (index.js:3110-3113)——缺失服务只表现为功能静默缺席（面板查不到进度/提醒不注入），不报错。
- **registry 异常防御**：`workspaceRegistry.list()` 抛错（宿主注册表内部不一致）时 jobs/repos 端点降级不过滤、仍 200 (index.js:2691-2696；测试 test-orchestration.mjs:1190-1218)。
- **commitHintText 缓存陷阱**：60s TTL 缓存键是规范化 cwd (`commitHintText`，index.js:3032-3035)；测试需换全新 fixture 仓库绕开缓存 (test-orchestration.mjs:329-343)；「编译完成时间晚于最后 wiki 提交」为严格大于 (index.js:3032)，同秒提交/编译竞态需 sleep 隔开 (test-orchestration.mjs:351)。
- **commit 阶段终态延迟一个 tick**（0.10.11）：提交从 index 阶段拆出后，任务终态最多晚一个 `TICK_MS`（默认 10s，测试 300ms）——换取面板上可见的「提交产物中」一步（CHANGELOG.md:8）；中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等 (index.js:2043-2045)。
- **合并冲突防御路径单测不可达**（0.10.11）：同步流程内原分支在切出后不再前进，merge 恒为 fast-forward；真正的 add/add 冲突（编译期间用户在原分支推进）黑盒构造不出来，「merge 失败 → abort + 保留主题分支」是防御性代码 (index.js:3015-3023)，单测只覆盖 detached HEAD 与主题分支名被占用两条降级路径（test-orchestration.mjs:481-505）。
- **自动更新扫描异常吞没**：autoScan 单仓异常只记 `schedState.lastError` 不打断扫描 (index.js:3122-3123)，面板调度卡可见但无主动告警。
- **路径归一局限**：`normalizeCwd` 仅 win32 归一 `/c/...` 形态，POSIX 上原样保留 (index.js:40-45)。
- **submit 失败留痕**：模型通道校验失败会先落一条 failed job 再抛错 (index.js:2187-2191)，面板与 `codewiki_progress` 可见——这是可观测性设计而非缺陷，但意味着失败重试会在任务历史里留下失败记录。
