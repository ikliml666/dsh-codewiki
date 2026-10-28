---
title: orchestration_tests
type: module
source_files:
  - test-orchestration.mjs
  - test-batch.mjs
tags: [tests, orchestration, e2e, mock, batch, jobs]
---

## Overview

`test-orchestration.mjs` 与 `test-batch.mjs` 是 dsh-codewiki 插件「端到端编排 + 编译执行链」的两套测试，覆盖零子代理的服务化编译全部环节（文章→横切→审校→索引），从插件提交制、服务阶段机、单项目串行、面板端点，到纯函数级装填/规划/并发分池/失败记账。

两套测试都遵循同一套风格：**mock 宿主 llm 服务**（按 prompt 首行特征应答，插件零直连），其余宿主服务（webServer/tools/agents/workspaceRegistry）也全部可捕获，再跑真实 `cw` CLI 与真实服务 tick，断言落盘产物、job 终态与 notes 留痕。

- `test-orchestration.mjs`（1552 行）：端到端编排冒烟。从 `index.js` 导入 `{ name, apply, SESSIONS_DIR }`，通过 `apply(ctx, config)` 把插件挂到自建的 mock 宿主 ctx 上，再调用注册好的 `cw` / `codewiki_generate` / `codewiki_progress` 工具与 `/api/codewiki/*` 端点。验证：提交制（提交即返回 jobId、编译交服务）、阶段机（articles→crosscut→review→index，0.10.7 起无规划阶段）、stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control/repos/sessions）与取消、编译模型缺失诚实报错、单项目串行排队（0.10.0）、编译终态 steer 实时唤醒（0.8.0）、autoCommit、commitHintText、wakeCompileSession 等。
- `test-batch.mjs`（643 行）：编译执行链自检。从 `index.js` 直接 import 一票纯函数与小工具（见下），验证源码装填/行号前缀/token 估算/任务装配/本地规划/横切装填/仓库勘探/会话通道收割/大档分池/失败记账/锚点修正/信封校验/模型目录端点，全部走 mock llm 的 `stream` 协议。

测试加速：`test-orchestration.mjs` 第 15 行把 `DSH_CODEWIKI_TICK_MS` 压到 `300`（生产默认 10s）；第 22–23 行用 `crypto.randomBytes(4)` 拼随机 token 命名独立 `DSH_CODEWIKI_JOBS_FILE`，与同机真实宿主服务隔离，收尾统一删除（第 1548 行）避免 pid 复用读到旧 fixture 任务误判串行（注释见第 19–21 行）。

## Key Components

### test-orchestration.mjs — 公开 helper（文件内定义，非从 index.js 导入）

- `check(cond, msg)` — 第 27–30 行：断言宏，通过打印 `✓`、失败打印 `✗` 并累加 `failures`。
- `articleMd(title, source, marker, type)` — 第 33–34 行：造一篇最小 frontmatter 文章的工厂（用于 mock llm 应答与 fixture 落盘）。
- `makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — 第 51–91 行：mock 宿主 ctx。返回 `{ ctx, registered, endpoints, listeners, disposers }`。
  - `ctx.inject(deps, fn)` — 第 69–79 行：兼容 cordis 两种风格（带回调=注册服务切片；promise=`await ctx.inject([...])`）。
  - `ctx.on(event, fn)` — 第 80 行：收集 `agent/created` 等监听。
  - `ctx.effect(fn)` — 第 84–88 行：立即执行 body，返回函数则收集为 disposer（防 `ctx.effect(() => service.stop())` 错写法当场停摆 tick）。
  - `webServer.register / agents.list/.get / tools.register / workspaceRegistry.list` — 第 56–67 行：可捕获的宿主服务；`brokenRegistry=true` 时 `list()` 抛错（第 66 行，模拟 0.4.9c 真宿主 jobs/repos 400）。
- `makeMockAgent(cwd)` — 第 94–108 行：mock `agent.ctx` 用于 systemPrompt section 注册；`TOOL_REPORT: 2900` 排序（第 101 行）。
- `makeFixtureRepo()` — 第 110–127 行：造 `core/` + `util/` 两个目录的 git 仓库 fixture（0.10.7 起模块清单由 localPlan 按顶层目录分组生成，目录结构决定模块名）。带 git identity（第 122–123 行，0.10.9 起 autoCommit 缺 identity 会拒绝）。
- `makeBatchMock({ modules, articleMarker, stall, bigArticle })` — 第 145–227 行：mock 宿主 llm 服务，按 prompt 首行特征分发应答（与真实 prompt 模板区分句一一对应）。
  - `answerFor(prompt)` — 第 147–195 行：按 prompt 首行判定应答（文章观察员/文章作者/stale 更新/架构观察员/系统总览/模式/概念/审校员）。
  - `llm.stream(opts)` — 第 198–215 行：按宿主 block 协议吐块；`stall=true` 时挂起直到 `opts.signal` abort（第 202–209 行，验证取消语义）。
  - 返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }` — 第 219–226 行：`restore()` 还原上一个生效的假 llm（块间嵌套用）。
- `waitJob(cwd, { timeout })` — 第 230–243 行：轮询 `JOBS_FILE` 等某 cwd 最新 job 终态（done/failed/cancelled）。
- `fakeReq(body, addr, method)` / `fakeRes()` — 第 245–257 行：模拟 HTTP 请求/响应对象，供面板端点 handler 调用。

### test-orchestration.mjs — 待测 index.js 导出 API（在测试块里被调用/断言）

- `name` / `apply(ctx, config)` / `SESSIONS_DIR` — 第 24 行 `import` 自 `./index.js`；`apply(main.ctx, mainConfig)` 第 296 行挂载插件、`name === 'dsh-codewiki'`（第 297 行）。
- 注册的工具：`cw`、`codewiki_generate`、`codewiki_progress`（第 298–302 行断言注册）。
- `commitHintText(repo, jobs)` — 第 322 行导入；第 337–428 行详测「产物待提交」提醒三态（无 .codewiki 提交史→提醒；编译早于提交→静默；autoCommit.committed/noChanges→静默；提交被拒 pending→提醒带失败原因）。
- `autoCommitWiki(repo, { jobId, writtenCount })` — 第 433 行导入；第 431–531 行详测分支合并式提交及其所有安全边界（正常/非 git/被 .gitignore 忽略/merge 进行中/缺 identity/detached HEAD 降级直接提交/主题分支名被占用降级直接提交）。返回 `{ committed, sha, mode, branch, message, reason, noChanges, fallback }`。
- `autoCommitState(job)` — 第 536 行导入；第 533–543 行详测三态 `committed / no-changes / pending`（`committed` 优先于 `noChanges`）。
- `wakeCompileSession(job, stage, agentsRef)` — 第 548 行导入；第 545–581 行详测终态实时唤醒（autoCommit 成功/无改动→零唤醒；失败→唤醒一次带文案；无 sessionId/冷会话/registry 抛错/steer 抛错/缺省 agents→静默）。
- 配置基线与三档能力开关：`LEGACY_CHANNEL = { planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`（第 44 行）、`batchCfg(extra)`（第 45 行）。注释说明 0.13.0 起 agentic/语义规划/符号增量默认全开，但本文件守护旧通道，故基线显式关掉三档（见第 38–43 行）。

### test-batch.mjs — 从 index.js 导入的纯函数/工具（第 7–13 行 import 清单）

- `collectSources(root, files, budget?)` — 第 2 节（第 31–45 行）：源文件装填，带相对路径标题与行号前缀、缺失标注、token 预算（oversized/skipped）。
- `numberLines(text)` — 第 47–52 行：行号前缀标注与尾换行处理（单/双尾换行、CRLF、空文件）。
- `estimateTokens(text)` — 第 25–29 行：CJK 每字 1 token、ASCII 每 3.5 字符 ceil 计费。
- `classifySessionTask({ articlePath, dispatchedAt })` — 第 135–150 行：会话通道收割三态 `timeout / harvest / wait`（超时判定优先）。
- `buildSessionSteerText({ job, snapshots, tier, resend })` — 第 153–168 行：会话通道 steer 文本；`tier` 钉死档位（articles/review 文案不同）。
- `prepareArticleTasks(tasks, opts)` — 第 54–133 行：prompt 装配与 oversized 拆分（普通/旧文上下文/单文件大档 128k/超大会话兜底/多文件观察批分割/大档模型接管）。返回 `{ prepared, sessionTasks }`。
- `runRealtimeTasks(tasks, opts)` — 第 196–345, 394–408 行：宿主 llm 通道并发池；验证 provider/model/reasoningEffort 下发、temperature=0、落盘与 keepInMemory、混合档分派、大档/默认档并发分池（onRequestStart 钩子）、tps 采样、外部 signal 中止、失败记账。
- `localPlan(files)` — 第 348–358 行：按顶层目录分组兜底规划（src/root/docs）。
- `packArticles(articles, budget)` — 第 361–371 行：横切输入整篇装填 + 超预算头部截断。
- `scanRepoFiles(root)` — 第 373–387 行：仓库勘探黑名单（跳过 node_modules/.git/二进制/超大/空文件）。
- `fixAnchors(text, root)` — 第 523–603 行：行号锚点确定性修正（错行号/起点行/符号未找到/歧义/区间/倒序区间/CRLF/多锚点各自就近绑定/used 占用护栏）。返回 `{ fixed, text, unresolved }`。
- `validateArticleEnvelope(text)` — 第 605–636 行：frontmatter 信封校验（闭合/缺开头/未闭合/CRLF/正文 `---` 分隔线/非字符串 null）。正常返回 `null`，坏输出返回含原因字符串。
- `listModelCatalog(llm)` — 第 411–432 行：宿主 provider/model 目录数据源（跳过无 id 的 provider、单 provider 失败不影响其它）。
- `resolveModelEfforts(llm, provider, model)` — 第 465–494 行：思考程度从模型目录读取（默认档/未知模型/未注入/未声明档位）。
- `installWebServer(ctx, jobsApi, llmSvc)` — 第 434–462, 497–516 行：注册 `/api/codewiki/models` 与 `/api/codewiki/model-efforts` 端点（回环 200、非回环 403、参数校验 400）。
- `resolveBatchApiKey` — 第 518–521 行断言：**0.10.1 起插件不再导出**（凭证解析链整体移除，插件不碰任何密钥）。

## Architecture

两套测试都采用「**mock 宿主 ctx + 真实插件 apply + 真实服务 tick**」的同一种骨架。`makeCtx` 造出可被 `apply` 挂接的 ctx，`makeBatchMock` 造出按 prompt 首行应答的假 llm（通过 `llmProxy` 转发给 `activeLlm`，见 `test-orchestration.mjs` 第 133–140 行），`waitJob` 轮询 `JOBS_FILE` 等终态。

```text
┌──────────────────────── test-orchestration.mjs ────────────────────────┐
│ makeCtx() ──apply(ctx,config)──► index.js(apply) 注册工具/端点          │
│   │  webServer.register ─► endpoints[]  (jobs/control/repos/sessions)   │
│   │  tools.register      ─► registered{} (cw/codewiki_generate/...)      │
│   │  agents/workspaceRegistry ─► 可捕获                                  │
│ gen.execute(cwd,{agent}) ──► 提交即返回 jobId（stage=articles）          │
│   │                                                                     │
│   ▼ 真实 cw CLI + 真实服务 tick（DSH_CODEWIKI_TICK_MS=300）              │
│ makeBatchMock()  ──llmProxy──► activeLlm.stream(opts) 按 prompt 应答     │
│   │  answerFor(): 文章观察/作者/stale/架构/总览/模式/概念/审校           │
│   ▼                                                                     │
│ 阶段机: articles→crosscut→review→index→commit(autoCommitWiki)           │
│   │                                                                     │
│ waitJob(cwd) ◄──轮询── JOBS_FILE(jobs[].stage)                          │
└─────────────────────────────────────────────────────────────────────────┘
        │                                   ▲
        ▼                                   │
┌──────────── test-batch.mjs ──────────┐   │ 复用同一 index.js 纯函数
│ import {...} from './index.js'        │   │
│ collectSources / numberLines          │   │
│ estimateTokens / localPlan            │   │
│ prepareArticleTasks ──► {prepared,    │   │
│   sessionTasks}                       │   │
│ runRealtimeTasks(tasks,{llm}) ──► Map │   │  mockLlm.stream 按 block 协议
│ packArticles / scanRepoFiles          │   │
│ fixAnchors / validateArticleEnvelope  │   │
│ listModelCatalog / resolveModelEfforts│   │
│ installWebServer ──► /api/... 端点    │   │
└───────────────────────────────────────┘   │
```

两个文件的分工：

- `test-orchestration.mjs` 走**黑盒编排**——把插件当服务整体跑，断言 job 终态、落盘文件、`notes` 留痕、面板端点响应；它不关心内部纯函数，只关心「提交一个仓库，出来一份对的 wiki」。
- `test-batch.mjs` 走**白盒单元**——直接 import 纯函数，喂构造输入，断言返回值结构；它不跑真实服务 tick，只在内存里验证装填/规划/并发分池/失败记账等编译链部件。

## Data Flow

### 端到端编排（test-orchestration.mjs）

1. **初始化**：设 `DSH_CODEWIKI_TICK_MS=300`（第 15 行）、随机 token 的 `DSH_CODEWIKI_JOBS_FILE`（第 22–23 行）；`makeFixtureRepo()` 造 `core/`+`util/` 仓库；`makeCtx` + `apply(ctx, batchCfg())` 挂载插件（第 295–296 行）。
2. **提交**：`gen.execute({ cwd }, { agent })` 判态后把任务写入 `JOBS_FILE`（stage=articles），立即返回 `{ submitted, jobId }`（第 647–651 行断言「提交即返回、返回值不含 writtenCount」）。
3. **推进**：真实服务 tick 读 `JOBS_FILE`，按阶段机跑 `articles→crosscut→review→index`，每个阶段向 `activeLlm.stream()` 发请求。`makeBatchMock` 的 `answerFor` 按 prompt 首行特征应答（第 147–195 行）：文章作者产 frontmatter 文章、审校员回 `@@@article:` 标记格式、架构观察员产观察文本。
4. **落盘与自动提交**：编译产物落 `wikiPath`（`.codewiki/`），`autoCommitWiki` 在分支上提交后合并回原分支（第 656–668 行断言只含 `.codewiki/` 与 `CodeWiki.md`、工作区干净）。
5. **终态与唤醒**：job 到 `done`/`failed`/`cancelled`；`autoCommit` 成功时 `wakeCompileSession` 零唤醒会话（第 670 行），失败才降级提醒（第 561–567 行）。
6. **轮询断言**：`waitJob(cwd)` 一直读到终态（第 230–243 行），再校验 `writtenCount`/`failedCount`/`stageTimings`/`notes` 与磁盘文件。

### 编译链白盒（test-batch.mjs）

1. `estimateTokens` 估算预算 → `collectSources` 按预算内联源码（带 `numberLines` 行号前缀）→ `scanRepoFiles` 探测仓库黑名单。
2. `localPlan` 按顶层目录分组生成模块清单；`prepareArticleTasks` 装配每篇 prompt：`<=110k` 普通档、`110k–bigTokenBudget` 大档单请求、`>bigTokenBudget` 拆观察批（`keepInMemory` + `composePlan`）或转会话通道兜底。
3. `runRealtimeTasks(tasks, { provider, model, llm, concurrency, bigConcurrency })` 跑并发池：默认档与大档各自 `peakNormal 2 / peakBig 1` 独立限流（第 280–281 行），失败记账进 `notes` 不中断其它任务（第 343 行）；`onTaskDone` 上报 `outputTokens`/`durationMs` 供 tps 采样。
4. `packArticles` 把已写文章装填进 crosscut；`fixAnchors` + `validateArticleEnvelope` 在落盘前做锚点修正与信封校验闸门（0.14.0 起）。
5. `listModelCatalog` / `resolveModelEfforts` 走 `installWebServer` 注册的 `/api/codewiki/models`、`/api/codewiki/model-efforts` 端点（回环 200、非回环 403、缺参 400）。

## Connections

- [[index]] — 被测试的核心插件入口：`apply`/`name`/`SESSIONS_DIR` 与全部被测纯函数/工具/端点的真实实现来源。
- [[batch]] / 编译执行链（`lib/*`）— `test-batch.mjs` 直接白盒测的 `runRealtimeTasks` / `prepareArticleTasks` / `localPlan` / `collectSources` / `fixAnchors` / `validateArticleEnvelope` 等所在模块。
- [[article-contract]] — `validateArticleEnvelope` 与契约闸门的落点（0.14.0 文章契约闸门校验 type 与目录一致、source_files 真实存在）。
- [[agentic-host]] / [[agentic]] / [[semantic-plan]] / [[incremental]] — 0.13.0 起新增三档能力（agentic 写作/语义规划/符号增量），本套测试基线用 `LEGACY_CHANNEL` 显式关掉以守护旧通道（见 `test-orchestration.mjs` 第 38–44 行）；其专项验证见 `test-agentic-host.mjs` / `test-semantic-plan.mjs` / `test-incremental*.mjs`。
- [[jobs-service]] / `JOBS_FILE` 阶段机 — 端到端断言围绕 `JOBS_FILE` 的 `jobs[].stage`、`writtenCount`、`notes`、`stageTimings`、`batchProgress`、`queueAhead`、`taskList` 展开。
- [[webserver]] — `/api/codewiki/jobs` / `control` / `repos` / `sessions` / `models` / `model-efforts` 端点的回环守卫（403）与 loopback 过滤逻辑（workspaceOnly）在这两套测试里被反复断言。
- [[auto-commit]] — `autoCommitWiki` / `autoCommitState` / `commitHintText` / `wakeCompileSession` 的端到端与安全边界归属。

## Known Issues

- **`test-orchestration.mjs` 第 19–23 行**：`JOBS_FILE` 必须追加随机 token。只用 pid 时，历史运行留在 tmp 里的同名文件会在 pid 复用时被原样读入（含旧 `job-tmp-active` 等 fixture 任务），让「单项目串行」误判为已有项目在编译、后续提交全 queued，表现为「偶发 20 项失败」。收尾统一 `fs.rmSync(JOBS_FILE)`（第 1548 行）。
- **`test-orchestration.mjs` 第 518–520 行 `0.10.1 删除内置百炼直连通道`**：`resolveBatchApiKey` 不再从 `index.js` 导出，断言 `mod.resolveBatchApiKey === undefined`——这是被删除能力，不是被禁用；插件自此零密钥、唯一通道是宿主 llm 服务。
- **`test-orchestration.mjs` 第 620 行注释**：0.10.7 删掉了「规划应答非 JSON → 降级本地分组」场景——本地分组已是唯一路径，旧「勘探员」规划阶段请求全程为零（第 608、633、697、983 行多处断言 `无勘探员`）。
- **`test-batch.mjs` 第 108 行注释（大档模型 0.10.4）**：单文件超 128k 但装得进 `bigTokenBudget` 大档时不再转会话通道，改由 `bigProvider`/`bigModel` 在插件内写完；`bigProvider` 留空则退回旧行为（会话通道兜底，第 123–126 行）。
- **`test-orchestration.mjs` 第 1012–1016 行**：并发提交占位块的 mock 必须用 `stall=true` 挂起请求，而非「模型失败」——否则任务几百毫秒内进 `failed` 终态，第二次 `execute` 的 await 还没走完就到 submit，查不到活动任务会新建第二个 job，偶发报「并发提交共享同一 job」失败（纯测试竞态，与占位逻辑无关）。
- **`test-orchestration.mjs` 第 516–519 行注释**：`autoCommitWiki` 里「merge 失败 → abort + 保留主题分支」是防御性路径，黑盒测试构造不出（编译期间用户在原分支推进的真实 add/add 冲突），不在单测覆盖内；`usedRepo` 用例只覆盖「主题分支名被占用 → 降级直接提交且预占分支不被误删」。
- **`test-orchestration.mjs` 第 638–639 行**：每块 `apply` 过新 ctx 后须 `apply(main.ctx, mainConfig)` 恢复 main 的 `agentsRef`，否则污染后续 e2e 唤醒断言（如 `wakeCompileSession` 用 `main` 实例注册表）。
- **`test-orchestration.mjs` 第 1468–1480 行**：空壳目录（只剩 `.codewiki` 骨架、扫不出源码）任务会被 jobs/repos 端点过滤掉；该断言用 `here`（仓库自身）作正常任务 cwd，不能用 tmp fixture——tmp 终态任务会被 0.4.6 的「Temp 残留清理」先一步移走，测不到本次过滤逻辑。
- **两套测试共用 `index.js` 真实实现**：任何被测纯函数签名/行为回归会同时拖垮 `test-batch.mjs`（白盒）与 `test-orchestration.mjs`（端到端），因为它们都从同一源 import，并非各自 mock 实现。
