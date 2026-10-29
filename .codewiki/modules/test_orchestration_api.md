---
title: test_orchestration_api
type: module
source_files:
  - test-orchestration.mjs
  - index.js
tags: [test, orchestration, job-api, repo-api, mock]
---

## Overview

`test-orchestration.mjs` 是 dsh-codewiki 的**服务化编排冒烟测试**，也是本模块「job/repo API 响应」的一整套编排测试助手（orchestration test helpers）。它不验证单个单元，而是把 `index.js` 的 `apply(ctx, config)` 真正跑起来——mock 宿主 llm 服务（按 prompt 特征应答，插件零直连）、真实 `cw` CLI、真实服务 tick——端到端验证：

- `codewiki_generate` 提交制（调用即返回 jobId，`gen.execute` 不就地等待）；
- 服务阶段机（articles → crosscut → review → index，0.10.7 起无规划阶段）；
- 面板端点对 job/repo 状态的响应：`GET /api/codewiki/jobs`、`GET /api/codewiki/repos`、`POST /api/codewiki/control`、`GET /api/codewiki/sessions`；
- 取消 / 单项目串行排队 / 并行上限 / 编译模型缺失诚实报错 / 宿主重启后按持久化 prompt 快照重跑 / 编译终态 steer 唤醒；
- 编译产物自动提交与「产物待提交」提醒文案。

测试把 `index.js` 的多个**导出函数直接 import**做单测（`commitHintText`、`autoCommitWiki`、`autoCommitState`、`wakeCompileSession`），并通过 `ctx.inject(['webServer'])` 注册出来的 `endpoints` 直接调用 `handler(fakeReq, fakeRes)` 来断言面板 JSON 形态。所有 helper 都是这个文件内部的纯函数/工厂，不对外导出——它们是「本测试自己用的编排助手」，而非独立可复用库。

运行入口：文件顶部 `// 运行：node test-orchestration.mjs`（`test-orchestration.mjs:6`），脚本末尾 `process.exit(failures ? 1 : 0)`（`test-orchestration.mjs:1551`）决定 CI 成败。

## Key Components

下面是 `test-orchestration.mjs` 里全部**导出的测试助手工厂/函数**（均为文件内部定义，不 export，仅供本测试 self-use）。行号以 `read_code` 返回的「行号| 」前缀为准。

### 断言与固定装置（顶部）

- `check(cond, msg)` — `test-orchestration.mjs:27-30`：零依赖断言。通过打 `✓`、失败打 `✗` 并累加模块级 `failures`。所有测试断言都走它，最后 `process.exit(failures ? 1 : 0)`（`test-orchestration.mjs:26`）据此判定成败。
- `articleMd(title, source, marker, type)` — `test-orchestration.mjs:33-34`：合成一篇符合 article-contract 闸门的 Markdown。返回带 frontmatter 的模板串，`type` 默认 `'module'`。`makeBatchMock` 的 `answerFor` 用它假造「作者回文」，使 `source_files` 真实存在、类型与目录一致，绕过契约闸门。
- `LEGACY_CHANNEL` — `test-orchestration.mjs:44`：常量对象 `{ planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`。基线显式关掉三档 FSoft 能力（语义规划/agentic 写作/符号增量），只守护「旧通道」的请求次数、装填方式、落盘时序（见文件头注释 `test-orchestration.mjs:38-43`）。
- `batchCfg(extra)` — `test-orchestration.mjs:44`：返回 `{ batchProvider: 'workbuddy', batchModel: 'hy3', ...LEGACY_CHANNEL, ...extra }`。每个测试块用它造配置后 `apply(ctx, cfg)`。
- `JOBS_FILE` / `TEST_JOB_TOKEN` — `test-orchestration.mjs:22-23,32`：把 `DSH_CODEWIKI_JOBS_FILE` 指到一个带随机 token 的 tmp 文件，避免与同机真实宿主服务实例互相洗写（`test-orchestration.mjs:18-21`）。`waitJob` 与面板端点断言都读这个路径。

### 宿主 mock 上下文工厂

- `makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — `test-orchestration.mjs:50-90`：构造「宿主同构」ctx，是整个测试的接线中枢。返回 `{ ctx, registered, endpoints, listeners, disposers }`：
  - `services`（`:56-67`）：`webServer.register` 收集 `endpoints`（`:57`）；`agents` 默认 `{ list: () => agents }`，传 `agentGet` 时变 `{ list, get: agentGet }`（`:58`）；`tools.register` 进 `registered` Map（`:59`）；`llm` 默认 `llmProxy`（`:60`）。
  - `workspaces` 非空 → `services.workspaceRegistry = { list: () => workspaces.map(p => ({path:p})) }`（`:63`）；`brokenRegistry` 为真 → `workspaceRegistry.list()` 直接抛错（`:66`，模拟 0.4.9c 真宿主 jobs/repos 400 根因）。
  - `ctx.inject(deps, fn)`（`:69-79`）：同时支持 cordis 两种风格——带回调传「ctx 切片」（服务在切片同名属性上，`:73-75`，0.4.10 教训），纯依赖数组返回 Promise（`:77-78`）。
  - `ctx.on(event, fn)` 收集 `listeners`（`:80`）；`ctx.effect(fn)` 立即执行 body、返回函数则收为 `disposers`（`:84-88`，防线见 `test-orchestration.mjs:82-83`）。
- `makeMockAgent(cwd)` — `test-orchestration.mjs:93-107`：mock 一个 agent 实例，带 `session.header.cwd` 与 `agent.ctx.inject(['systemPrompt'], ...)`。让 `systemPrompt.section` 把注册的 section 推进 `sections` 数组并返回 disposer 清理函数（`:102`）。返回 `{ agent, sections }`，供「系统提示提醒」测试断言 section 名与文案。

### 仓库与模型 mock 工厂

- `makeFixtureRepo()` — `test-orchestration.mjs:109-126`：在 tmp 造一个**带 git 身份**的最简 repo（`core/`、`util/` 各一个 `.py`，已 commit）。顶层目录直接决定 localPlan 模块名（0.10.7 起删规划阶段，`:112-114`）；强制 `user.name/user.email`（`:122-123`，0.10.9 自动提交安全边界所需）。
- `activeLlm` — `test-orchestration.mjs:131`：模块级「当前生效的假 llm」。`llmProxy` 恒转发给它，故每个块只需 `makeBatchMock()` 一处接线（`:129-131`）。
- `llmProxy` — `test-orchestration.mjs:132-139`：`{ async *stream, listModels, resolveModel }`，统一转发到 `activeLlm`；未接线时抛 `测试未接线：先 makeBatchMock() 再提交任务`（`:135`）。
- `promptOf(opts)` — `test-orchestration.mjs:140`：从 `opts.messages[0].content[0].text` 抽 prompt 首文本，用于 `answerFor` 的特征分发。
- `makeBatchMock({ modules, articleMarker, stall, bigArticle })` — `test-orchestration.mjs:144-226`：本模块**最核心的 job/repo 响应 mock**，模拟宿主 llm 服务后台并发池。返回对象 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`：
  - 内部 `answerFor(prompt)`（`:147-195`）：按 prompt 首行特征分发应答——
    - 含 `你是 CodeWiki 文章观察员` → 观察文本（`:148-151`）；
    - 含 `你是 CodeWiki 文章作者` → 处理 stale（从 `更新过期文章 X：` 抽名，按位置推 type/frontmatter/source，`:156-169`）与常规文章（`:171-172`，从 `modules/([a-z0-9-]+)\.md` 抽模块名）；
    - 含 `你是 CodeWiki 架构观察员` / `写系统总览` / `总结仓库反复出现的模式` / `写跨模块概念` / `你是 CodeWiki 审校员` → 分别回架构/总览/模式/概念/逐篇 `@@@article:` 标记（settleProofread 按标记拆回，`:180-193`）。
    - 未命中 → `unknown task`（`:194`）。
  - 内部 `llm.stream`（`:197-216`）：记录每条 `{ provider, model, reasoningEffort, prompt, signal }` 进 `llmCalls`（`:200`）；`stall=true` 时挂起直到 abort（`:202-209`，取消语义）；`bigArticle` 时往作者回文追加 70000 字（`:211`）。按宿主 block 协议 yield `block-start`/`text-delta`/`usage`/`finish`。
  - `batchPrompts()` / `realtimePrompts()`（`:222-223`）：返回 `llmCalls` 的 prompt 数组（本测里两者等价）。
  - `restore()`（`:225`）：把 `activeLlm` 还原为上一个生效假 llm（块间嵌套用）。

### 拉取与请求/响应桩

- `waitJob(cwd, { timeout = 30000 })` — `test-orchestration.mjs:229-242`：轮询 `JOBS_FILE`，返回某 cwd 的**最新 job 终态**（`stage` ∈ `done/failed/cancelled`）。这是断言服务阶段机推进的「等待墙」——调用 `gen.execute` 提交后靠它等 job 落终态。
- `fakeReq(body, addr = '127.0.0.1', method = 'POST')` — `test-orchestration.mjs:244-253`：构造假 `req`，`on('data')` 同步喂 `Buffer.from(JSON.stringify(body))`、`on('end')` 立即回调。地址默认回环，传给 `handler` 做 loopback 守卫断言（`10.1.2.3` → 403）。
- `fakeRes()` — `test-orchestration.mjs:254-256`：构造假 `res`，`writeHead(c)` 记 `code`、`end(b)` 记 `out`。面板断言里 `JSON.parse(res.out)` 取响应体。

### 直接单测的 index.js 导出（同一文件内 import 调用）

- `commitHintText(cwd, jobs)` — `index.js:4887` 导出（测试 `test-orchestration.mjs:322,344` 调用）：「产物待提交」系统提示文案。无 `.codewiki` 提交史/编译晚于提交/`autoCommit.committed`/失败带 reason 各分支都被断言（`:345-424`）。
- `autoCommitWiki(cwd, { jobId, writtenCount })` — `index.js:4801`（测试 `test-orchestration.mjs:433`）：自动提交产物，安全边界（非 git / 被 ignore / merge 中 / 缺 identity / detached / 主题分支占用）全被断言（`:432-531`）。
- `autoCommitState(job)` — `index.js`（测试 `test-orchestration.mjs:536`）：三态判定 `committed`/`no-changes`/`pending`，唤醒与提醒两通道共用（`:533-543`）。
- `wakeCompileSession(job, stage, agentsRef)` — `index.js`（测试 `test-orchestration.mjs:548`）：编译终态 steer 唤醒（`:545-581`），autoCommit 成功/无改动零唤醒、失败/被拒唤醒一次、冷会话/异常静默。

> 注：文件内还定义了**块级局部** helper（如 schema 校验 `validateOut(schema, v)` 在 `test-orchestration.mjs:1288-1303`，`mkForeign` 在 `:1330-1335`，`mkJob` 在 `:1457`），仅作用域内在用，不当作模块级助手。

## Architecture

`test-orchestration.mjs` 以「mock 宿主 + 真实插件服务」的方式驱动 `index.js` 的 `apply(ctx, config)`。helper 分层：mock 上下文（`makeCtx`/`makeMockAgent`）→ 数据/模型桩（`makeFixtureRepo`/`makeBatchMock`/`llmProxy`）→ 拉取与 HTTP 桩（`waitJob`/`fakeReq`/`fakeRes`）→ 端点断言（从 `endpoints` 取 handler 直接调用）。

```text
┌──────────────────────┐   apply(ctx,cfg)    ┌───────────────────────────┐
│ makeCtx (51-91)      │ ───────────────────▶ │ index.js apply (5178)     │
│ inject/llm/webServer │                      │  createJobService (5181)  │
│ tools/agents mock    │ ◀──── endpoints ─────│  installWebServer (4686)  │
└──────────────────────┘       注册           └───────────────────────────┘
        │                                                  │ tick 推进 job
        ▼                                                  ▼
┌──────────────────────┐   handler(fakeReq,fakeRes)  ┌───────────────────────────┐
│ fakeReq/fakeRes      │ ───────────────────────────▶ │ /api/codewiki/jobs        │
│ (245-257)            │                              │ /api/codewiki/repos (4767) │
│ 遍历 endpoints 调 handler │                          │ /control (4950)/sessions   │
└──────────────────────┘                              └───────────────────────────┘
        ▲                                                  ▲
        │            llmProxy → activeLlm                 │
┌──────────────────────┐   stream(opts) 记录 llmCalls  ┌───────────────────────────┐
│ makeBatchMock(145-227)│ ───────────────────────────▶ │ 编译模型服务 (唯一通道)    │
│ answerFor 按 prompt   │   stall/bigArticle 控制时序   │ 0.10.1 起插件零直连        │
└──────────────────────┘                              └───────────────────────────┘

     waitJob(230) ──轮询 JOBS_FILE──▶ 服务落盘 job 终态（done/failed/cancelled）
```

关键规模点：整个测试不直接 import 任何「job/repo API 响应校验库」——它靠 `makeCtx` 把 `webServer.register` 收集进 `endpoints` 数组（`test-orchestration.mjs:52`），每个面板断言都 `endpoints.find(e => e.path === '...').handler(fakeReq(...), fakeRes())` 后 `JSON.parse(res.out)` 比对字段（如 `:776-781,856-865,1071-1081`）。这正是「job/repo API 响应」的测试姿势：端到端打真实 handler，断言返回的 JSON 形态与字段。

## Data Flow

一次典型的「提交编 + 查面板 job 响应」流程（对应 `test-orchestration.mjs:643-683` 全量编译块）：

1. `makeCtx({})` 与 `batchCfg()` → `apply(ctx, cfg)`，把 `codewiki_generate`/`cw`/`codewiki_progress` 三个工具注册进 `registered`，把 7 个面板端点（`/jobs`、`/repos`、`/control`、`/sessions`、`/sessions/item`、`/models`、`/model-efforts`）注册进 `endpoints`（`index.js:4965-5029`，注册逻辑见 `installWebServer` `index.js:4473` 与工具注册 `index.js:5223-5239`）。
2. `makeBatchMock()` 把 `activeLlm` 接成假 llm（`test-orchestration.mjs:131`）。
3. `gen.execute({ cwd: mainRepo }, { agent })` 调用即返回 `{ submitted, jobId, stage: 'articles' }`，**不就地等待**（`:649-651`）。服务 tick 在后台把 job 推进过 articles→crosscut→review→index→commit。
4. `waitJob(r1.cwd)` 轮询 `JOBS_FILE` 等 job 终态 done（`test-orchestration.mjs:230-243`），同时 `makeBatchMock` 的 `answerFor` 按 prompt 特征假造每段回文、`autoCommitWiki` 走分支合并式提交产物。
5. 面板响应断言：取 `endpoints.find(e => e.path === '/api/codewiki/jobs')` → `handler(fakeReq(), fakeRes())` → `JSON.parse(res.out).jobs`，比对 `stage`/`writtenCount`/`failedCount`/`autoCommit.sha`/`stageTimings`/`tps`/`usage`（`test-orchestration.mjs:856-865`）。`/repos` 同理，额外带 `state`/`excluded`/`articleCount`/`scheduler` 块（`:1071-1081,1140-1144`）。
6. `control` 端点做取消/compile/refresh：`handler(fakeReq({ action:'cancel', jobId }), ...)`（`:788-791,1083-1090`）。取消后 `waitJob` 等 stage=cancelled（`:1085-1086`）。
7. 收尾：`fs.rmSync(JOBS_FILE)` 删随机 token 临时文件（`:1548`），`process.exit(failures ? 1 : 0)`（`:1551`）。

另一条「直接单测导出函数」的数据流（不经过服务）：`await import('./index.js')` 取 `commitHintText`/`autoCommitWiki`/`autoCommitState`/`wakeCompileSession` → 直接传参调用并断言返回值（如 `test-orchestration.mjs:433,536,548`），这些路径完全绕开 `apply`/tick，是纯函数级回归。

## Connections

- [[index]] — 被测主模块：`apply(ctx, config)`（`index.js:4965`）注册全部工具与面板端点；本测试直接 import 的 `commitHintText`/`autoCommitWiki`/`autoCommitState`/`wakeCompileSession` 均在此导出。
- [[lib/engine]] — 服务阶段机底层（articles→crosscut→review→index 的实际执行、native-run 通道），测试通过端到端 job 终态间接覆盖。
- [[lib/article-contract]] — 文章契约闸门：`makeBatchMock.answerFor` 伪造回文时必须使 `source_files` 真实存在、类型与目录一致，否则会被 `inspectArticle` 判为 partial（见 `test-orchestration.mjs:154-168` 注释与 `:1400-1404` worktree 注释）。
- [[lib/update-planner]] — stale 增量规划：全量/逐篇更新任务提交后的判「哪些文章过期」逻辑，被「stale 逐篇更新」块（`test-orchestration.mjs:874-895`）间接覆盖。
- 同层其它测试：`test-agentic-host.mjs`、`test-semantic-plan.mjs`、`test-incremental*.mjs` 负责新通道（agentic/语义规划/符号增量），本文件 `LEGACY_CHANNEL`（`test-orchestration.mjs:44`）显式关掉它们以守护旧通道（`:38-43`）。

## Known Issues

- **随机 token 隔离但依赖 tmp 清理**：`JOBS_FILE` 带 `TEST_JOB_TOKEN`（`test-orchestration.mjs:22-23`）隔离同机真实宿主；多个块用 `fs.writeFileSync(JOBS_FILE, ...)` 预置 fixture job（如 `:941,969,1002,1337,1460,1530`），靠 `fs.unlinkSync(JOBS_FILE)`（`:990,1356`）或块尾 `rmSync` 清理。Windows 句柄延迟释放时 `rmSync` 可能失败，注释说明「留 tmp 自清」（`test-orchestration.mjs:32,1548`），不会让测试失败但会留残留。
- **stall 挂起是竞态防护手段**：`makeBatchMock({ stall: true })`（`:756,1015,1047,1220`）让任务卡在 articles 不进终态，专门规避「模型失败 → 几百毫秒内 failed（终态）」导致的并发提交测试竞态（见 `:1011-1014` 注释）。这是测试稳定性依赖，不是功能。
- **仓库 fixture 必须带 git 身份**：`makeFixtureRepo` 强制 `user.name/user.email`（`test-orchestration.mjs:109-110`），否则 `autoCommitWiki` 在缺身份时被 `user.name` 拒绝（`:484-504`），整轮 e2e 只能走降级提醒分支。
- **`answerFor` 与真实 prompt 模板强耦合**：`makeBatchMock` 的分发句（`你是 CodeWiki 文章观察员`/`你是 CodeWiki 文章作者`/`写系统总览` 等，`:148-193`）必须与实际 prompt 模板首行一一对应；任一模板改文案，本测试会「请求次数/装填方式」断言崩（文件头已声明这是守护旧通道的代价，`:38-43`）。
- **`realtimePrompts` 与 `batchPrompts` 当前等价**：两者都返回 `llmCalls.map(c => c.prompt)`（`test-orchestration.mjs:222-223`），尚未区分实时/批量通道。
- **`validateOut` 是测试内联同构校验器**：`test-orchestration.mjs:1288-1303` 复刻宿主 output schema 校验（null/undefined 不算缺失），不是 `index.js` 的导出，改动宿主 schema 时此处需手动同步。
- **无源码级禁用/注释代码块**：本文件 helpers 全部为激活状态；没有功能被注释掉。唯一「禁用」语义在测试配置层——`LEGACY_CHANNEL` 关闭三档新能力（`:44`），属于测试运行时开关而非源码禁用。
