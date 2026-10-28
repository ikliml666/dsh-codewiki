---
title: test_orchestration_api
type: module
source_files:
  - test-orchestration.mjs
  - index.js
tags: [test, orchestration, api, endpoints, assertion-helpers]
---

## Overview

`test-orchestration_api` 不是仓库里的源码模块，而是针对「服务化编排」功能的一组**端点到端（e2e）冒烟测试与其 API 断言辅助工具**，位于 `test-orchestration.mjs`。它把真实 `cw` CLI、真实常驻服务 tick（`DSH_CODEWIKI_TICK_MS` 压到 300ms）、一个按 prompt 特征应答的 mock 宿主 llm 服务串起来，验证 `codewiki_generate` 提交制、服务阶段机、stale 逐篇更新、宿主重启按快照重跑、面板端点（`/api/codewiki/jobs`、`/api/codewiki/control`、`/api/codewiki/repos`、`/api/codewiki/sessions`）与取消，以及编译模型缺失诚实报错等行为。

本模块文章的重点是**测试里用来打面板端点、对 API 响应做断言的那一层**：端点调用脚手架（`main.endpoints.find((e) => e.path === …)` / `fakeReq` / `fakeRes` / `check` / `waitJob`）加上被这些 helper 驱动、定义在 `index.js` 的真实面板端点（`/api/codewiki/jobs`、`/api/codewiki/control`、`/api/codewiki/repos`、`/api/codewiki/sessions` 等）。这些是「Endpoint and API assertion helpers for orchestration tests」的核心。

> 分工：测试脚本头部的 **builder 层**（`makeCtx` / `makeBatchMock` / `makeFixtureRepo` / `makeMockAgent` 等伪宿主+伪 LLM 底座）已由 [[test_orchestration_core]] 完整记录。本文只复用它们、不再重述其内部构造，专讲「端点怎么被调用、响应怎么被断言」。

运行方式：`node test-orchestration.mjs`（见文件头注释 1|–7|）。

## Key Components

> 下列 helper 的完整构造（参数、内部 mock 机制）见 [[test_orchestration_core]]，本文只列其在「端点断言」场景中被如何调用。

### 断言原语（test-orchestration.mjs）

- `check(cond, msg)` — 全脚本唯一断言原语，定义于 27|–30|。条件为真打印 `  ✓ ${msg}`，否则 `failures += 1` 打印 `✗`；测试末尾统一 `process.exit(failures ? 1 : 0)`（1550|–1551|）。所有端点/API 断言都通过它对 `res.code`、`JSON.parse(res.out)` 的字段做判断。

- `waitJob(cwd, { timeout })` — 终态轮询 helper，230|–243|。轮询 `JOBS_FILE` 取该 `cwd` 最新 job，直到 `stage ∈ {done, failed, cancelled}` 或超时返回。提交任务后必须先 `waitJob` 等到终态，端点断言才看得到稳定字段（如 `progress=100`、`taskList` 全 done）。

- `fakeReq(body, addr, method)` — 245|–254|。构造「可被端点 handler 直接消费」的假 `req`：`socket.remoteAddress = addr`（默认 `127.0.0.1` 回环放行）、`on('data'|'end')` 在 body 非空时同步喂出 `Buffer.from(JSON.stringify(body))` 并 `end`。测试用它既打 GET（body 传 `undefined`/空对象）也打 POST（body 带 `{action, jobId}`）。

- `fakeRes()` — 255|–257|。构造假 `res`：`writeHead(c)` 记 `code`、`end(b)` 记 `out`。端点经 `writeJson` 写回后，`JSON.parse(res.out)` 即可取负载。**只实现 `writeHead`/`end`，没有 `setHeader`/`getHeader`**（注意 `installWebServer` 端点只用 `writeHead`）。

### 端点捕获与调用模式（test-orchestration.mjs）

- `makeCtx({ … })` — 51|–91|。构造同构宿主 ctx，其内部 `webServer.register(def)` 把每个面板端点的 `{kind, path, handler}` 推进 `endpoints` 数组（57|、90|）。返回的 `endpoints` 是所有端点断言的入口：测试用 `main.endpoints.find((e) => e.path === '/api/codewiki/jobs')` 按 path 取端点定义，再调 `e.handler(fakeReq(...), fakeRes())`。

- 典型端点调用三连（见 1051|–1084|）：
  ```js
  const jobsEp = main.endpoints.find((e) => e.path === '/api/codewiki/jobs')
  const res = fakeRes()
  jobsEp.handler(fakeReq(undefined, '127.0.0.1', 'GET'), res)  // 或 fakeReq({}, '10.1.2.3') 测 403
  const payload = JSON.parse(res.out)
  check(res.code === 200 && payload.jobs.some((j) => j.id === r4.jobId), '…')
  ```

### 真实面板端点（index.js，被上述 helper 驱动）

- `isLoopbackRequest(req)` — 4229|–4232|。回环判定：`127.0.0.1` / `::1` / `::ffff:127.0.0.1` 放行。`installWebServer` 内部 `guard(req, res)`（4363|–4367|）对每个端点先调用，非回环回 403。测试通过 `fakeReq(…, '10.1.2.3')` 触发该分支并断言 `res403.code === 403`（1054|–1056|）。

- `writeJson(res, code, obj)` — 4234|–4238|；`readBodyJson(req)` — 4239|–4258|（读请求体上限 1MB）。所有面板端点都经 `writeJson` 写回，`fakeRes.out` 即其 JSON 字符串。

- `installWebServer(ctx, service, { config, schedState, compile })` — 4327|。注册全部面板端点的入口：先 `ctx.inject(['workspaceRegistry'], …)` 取工作区清单（4336|–4339|），`wsFilterPaths()` 在 `workspaceOnly` 开启时返回过滤路径（4343|–4358|），再 `ctx.inject(['webServer'], …)` 调 `ws.register` 注册各个端点（4360|）。

- `GET /api/codewiki/jobs` — 4368|–4404|。列出任务；`workspaceOnly` 下过滤终态非工作区任务、永远放行非终态任务，`isDeadCompileTarget` 过滤 worktree/空壳目录，queued 任务带 `queueAhead`/`queueAheadCount`（在等谁）。测试断言点：403 非回环、列表含活动任务、无 `apiKey` 字段、阶段中间 `batchProgress`/`taskList`、排队的 `queueAhead`（1044|–1081|、1218|–1234|）。

- `GET /api/codewiki/repos` — 4408|–4497|。仓库总览（30s 缓存 + `wsSig` 签名）。每个 repo 行含 `state`/`staleArticles`/`changedFiles`/`wikiPath`/`articleCount`，`lastJob` 块含 `tps`/`batchProgress`/`batchSubmittedAt`/`taskList`，以及 `scheduler` 块（`enabled`/`intervalMin`/`lastScan*`）。测试断言点：活动任务带 `taskList/batchProgress/tps`、`excluded` 标记、`scheduler` 序列化（1071|–1081|、1136|–1144|）。

- `GET /api/codewiki/sessions` 与 `/api/codewiki/sessions/item` — 4503|–4542|。会话实时内容记录查询；全局 Tab 跨任务聚合（`limit` 默认 200）、单任务按 `jobId` 过滤，单条全文按 `jobId`+`n` 取，非回环回 403。测试断言点：不带 jobId 聚合、`limit` 参数、带 jobId 单任务、非回环 403（1364|–1390|）。

- `GET /api/codewiki/models` / `/api/codewiki/model-efforts` — 4549|–4588|。设置页模型目录与思考程度档位数据源（30s / 60s 缓存）。

- `POST /api/codewiki/control` — 4589|–4620|。动作入口：`action=cancel&jobId`（调 `service.cancel`，成功 200 否则 404）、`action=refresh`（清 repos 缓存 200）、`action=compile&cwd`（调 `compile`，缺参/未知 action 报错）。测试断言点：取消被接受 200、取消未知 jobId 404、compile 提交成功、排除仓库 400（1082|–1090|、1107|–1125|）。

- `codewiki_progress` 工具（非 HTTP 端点，但同样被 `check` 断言）— `prog.execute({cwd}/{jobId})` 返回 `{jobs:[…]}`，`jobs[].progress`/`taskList`/`usage` 由 `progressView` 组装；其 `output.render` 生成文本（4184|–4206|）。测试断言点：按 cwd/jobId 过滤、终态 `progress=100`、无匹配返回空、`render` 含 `stage=`/`✓`（897|–933|）。

## Architecture

```text
┌───────────────┐   apply(ctx, cfg)   ┌──────────────────────┐
│ makeCtx mock  │ ─────────────────► │ index.js apply()     │
│ (host ctx)    │                     │ createJobService()   │
└──────┬────────┘                     └──────────┬───────────┘
       │ registered.endpoints                     │ installWebServer()
       │                                          ▼
┌──────┴──────────────┐   handler(fakeReq, fakeRes) ┌────────────────────────┐
│ fakeReq/fakeRes     │ ──────────────────────────► │ /api/codewiki/jobs     │
│ (loopback guard)    │                             │ /api/codewiki/control  │
└──────┬──────────────┘                             │ /api/codewiki/repos    │
       │ check(cond, msg)                           │ /api/codewiki/sessions │
       ▼                                            └──────────┬─────────────┘
┌──────────────────┐                                   │ JSON via writeJson
│ waitJob / llmCalls│ ◄────────────────────────────────┘
│ (assert findings)│   service tick 推进阶段机 + 自动提交
└──────────────────┘
       ▲
┌──────┴──────────────┐
│ makeBatchMock llm   │  (prompt 特征应答，activeLlm 转发)
└─────────────────────┘
```

## Data Flow

1. 测试用 `makeCtx` 造宿主 ctx，`apply(main.ctx, mainConfig)` 启动真实 `createJobService` 并把端点经 `installWebServer` 的 `ws.register` 塞进 `endpoints`（4327|、4360|）。
2. 用 `makeBatchMock` 把 `activeLlm` 换成假 llm（`test-orchestration.mjs` 的 `llmProxy` 133|–140| 恒转发 `activeLlm`，故每个块只需接线一次）；`gen.execute({cwd, scope}, {agent})` 提交任务 → 立即返回 `{submitted, jobId, stage}`（提交制），服务 tick 推进阶段机。
3. 端点断言：`main.endpoints.find((e) => e.path === '/api/codewiki/jobs')` 取端点 → `fakeReq`（默认回环 `127.0.0.1`）/`fakeRes()` → `ep.handler(fakeReq(...), fakeRes())` 同步调用 → `JSON.parse(res.out)` 取负载后用 `check` 断言字段（如 `queueAhead` 1044|–1081|、列表含活动任务 1060|、403 回环守卫 1054|–1056|）。
4. 控制类：`ctlEp.handler(fakeReq({action:'cancel', jobId}, '127.0.0.1', 'POST'), res)`，断言 `res.code===200` 与 `JSON.parse(res.out).ok` 1082|–1090|；未知 jobId 断言 404（1088|–1090|）。
5. `waitJob(cwd)` 轮询 `JOBS_FILE` 等到终态，再读端点 JSON（`progress=100`、终态 `taskList` 全 done、`batchProgress` 清空）做二次断言（如 1162|–1169|）。
6. 非 HTTP 的 `codewiki_progress` 工具用同款 `check` 断言其返回 `{jobs}` 的 `progress`/`taskList`/`usage`，与端点断言共用同一套断言原语（897|–933|）。

## Connections

- [[index]] — 被测插件总入口：`apply` 经 `installWebServer` 注册全部面板端点（本文断言 helper 即驱动这些端点）；`commitHintText`/`autoCommitWiki`/`autoCommitState`/`wakeCompileSession` 在场景层按需 `await import`。
- [[test_orchestration_core]] — 测试脚本头部 builder 层（`makeCtx`/`makeBatchMock`/`makeFixtureRepo`/`makeMockAgent` 的构造），本文端点断言在其之上调用。
- [[batch_tests]] — 另一条编译执行链自检（`test-batch.mjs`），同样用 mock llm 服务但聚焦纯函数链而非服务化编排/端点。
- [[wiki_tests]] — 其余 e2e 测试（`test-wiki-*.mjs`）的 helpers 约定参照（系统提示提醒、worktree 闸门等场景与本文同源）。
- [[test-agentic]] — agentic 通道冒烟（0.13.0 新通道；`LEGACY_CHANNEL` 44| 显式关掉它来守护旧通道）。

## Known Issues

- 共享 `DSH_CODEWIKI_JOBS_FILE` 的历史残留：`JOBS_FILE` 文件名必须用随机 token（22|–23|），否则 pid 复用时旧 tmp 文件里的 `job-tmp-active` 等 fixture 任务会被原样读入，让「单项目串行」误判为已有项目在编译，表现为「偶发 20 项失败」——测试收尾统一删除（1547|–1548|）作为防线。
- 端点断言依赖 `makeCtx` 捕获的 `endpoints` 数组顺序：测试里一律用 `main.endpoints.find((e) => e.path === ...)` 按 path 取，避免顺序耦合。
- 端点 handler 对 `req.socket.remoteAddress` 强依赖回环判定（4230|）：`fakeReq` 必须传 `127.0.0.1` 才能放行，非回环返回 403（见 1054|–1056| 断言）。
- `waitJob` 与 `JOBS_FILE` 落盘存在竞态：部分断言在调用 `ctlEp`/`jobsEp` 前 `await new Promise(r => setTimeout(r, 900))` 等一拍 tick（1063|），否则 `batchProgress`/`taskList` 尚未落盘。
- `fakeRes` 不实现 `setHeader`/`getHeader`（256| 只实现 `writeHead`/`end`）：端点若改用 `res.setHeader` 会让该测试 helper 抛——需确认 `installWebServer` 端点只用 `writeHead`。
