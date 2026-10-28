---
title: endpoint_helpers
type: module
source_files:
  - index.js
  - test-orchestration.mjs
tags: [webserver, endpoints, mock-http, jobs, repos, control, panel]
---

## Overview

本模块描述「CodeWiki 面板后端」这一对耦合的层：

1. **真实端点层**（`index.js` 的 `installWebServer`，`index.js:4624` 起）——向宿主 `webServer` 服务注册一组 **仅回环可见** 的 HTTP 端点，供浏览器侧面板（`client.js` 的 `JOBS_PATH` / `REPOS_PATH` / `SESSIONS_PATH` / `MODELS_PATH` / `EFFORTS_PATH` / `CONTROL_PATH`）轮询编译进度与下发控制动作。共 7 个端点：`GET /api/codewiki/jobs`、`GET /api/codewiki/repos`、`GET /api/codewiki/sessions`、`GET /api/codewiki/sessions/item`、`GET /api/codewiki/models`、`GET /api/codewiki/model-efforts`、`POST /api/codewiki/control`。

2. **Mock HTTP 层**（`test-orchestration.mjs`）——在编排冒烟测试里用 `makeCtx`（`test-orchestration.mjs:51` 起）注入一个假 `webServer`，其 `register(def)` 把端点定义收集进 `endpoints` 数组（`test-orchestration.mjs:57`）；再用 `fakeReq`（`test-orchestration.mjs:245`）/`fakeRes`（`test-orchestration.mjs:255`）造出最小的请求/响应对象，直接调 `endpoints.find(e => e.path === '…').handler(req, res)` 来验证每个端点的行为（回环守卫、过滤、缓存、取消/编译/刷新动作等）。

两端点层通过同一个 `endpoints` 契约耦合：`installWebServer` 注册的每个 `def = { kind, path, handler }` 都被 mock 收集，测试按 `e.path` 取出 `handler` 后用 `fakeReq`/`fakeRes` 驱动——这是「Mock HTTP endpoints and request/response handlers for jobs, repos and control」的本意。

## Key Components

### 真实端点层（`index.js`）

- **`installWebServer(ctx, service, extra = {})`** — `index.js:4624` 导出的安装入口。由 `apply`（`index.js:5114` 定义，实际调用位于 `index.js:5166`）调用，传入 `{ config, schedState, compile }`。内部：
  - 若 `ctx.inject` 非函数则直接返回（旧宿主/测试 ctx 无 webServer 时静默降级，`index.js:4616`）。
  - 注入 `workspaceRegistry`（`index.js:4629`）得到 `workspaceRegistry` 引用，供 jobs/repos 过滤；缺失时保持 `null`（不过滤，行为同 0.4.8）。
  - 注入 `webServer`（`index.js:4647`）后遍历 `ws.register({ kind: 'exact', path, handler })` 注册 7 个端点；服务缺失时整个回调跳过（面板查不到进度但不报错）。
- **`isLoopbackRequest(req)`** — `index.js:4526`。判断 `req.socket.remoteAddress` 是否为 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`；所有端点 handler 入口用 `guard(req, res)`（`index.js:4660`）拦截非回环地址并返回 403，保证面板端点只接受本机（插件零密钥，绝不能对外暴露）。
- **`writeJson(res, code, obj)`** — `index.js:4531`。统一写 JSON 响应：序列化后设 `Content-Type: application/json; charset=utf-8` 与 `Content-Length`，再 `res.end(body)`。所有 handler 的成功/错误响应都经它。
- **`readBodyJson(req)`** — `index.js:4537`。读请求体 Promise：累积 `data` 分片，超过 **1MB** 即 `reject('请求体超过 1MB')` 并 `req.destroy()`；`end` 时 `JSON.parse`（空串当 `{}`）。仅 `control` 端点（`POST`）使用。
- **`listModelCatalog(llm)`** — `index.js:4562` 导出。遍历 `llm.listProviders()`（兼容 `id|provider`、`displayName|name` 两种字段），逐 provider 调 `llm.listModels(id)`；单 provider 抛错（缺凭证/端点不通）只给该条目附 `error`、`models` 置空，不连累其它 provider。供 `models` 端点与设置页级联下拉。
- **`resolveModelInfoOf(llm)`** — `index.js:4589` 私有。挑出 `llm.resolveModelInfo`（优先）或 `llm.resolveModel`（兜底旧宿主/测试桩）作为 `(provider, model, signal) => info` 解析器。
- **`resolveModelEfforts(llm, provider, model)`** — `index.js:4600` 导出。经 `resolveModelInfoOf` 取 `info.reasoning.efforts` 与 `defaultEffort`、`context`，映射成设置页「思考程度」下拉项；失败返回 `{ ok:false, efforts:[], defaultEffort:null }`。供 `model-efforts` 端点。

#### 7 个端点注册（`installWebServer` 内）

| 端点 | 注册位置 | 方法/路径 | handler 区间 | 关键行为 |
| --- | --- | --- | --- | --- |
| jobs | `index.js:5117` | `GET /api/codewiki/jobs` | `index.js:504`–`4691` | 取 `service.list()`；按工作区过滤（非终态任务放行）；`isDeadCompileTarget` 过滤空壳/worktree；给 `queued` 任务附 `queueAhead`/`queueAheadCount`「在等谁」；回 `{ now, jobs }`。 |
| repos | `index.js:2147` | `GET /api/codewiki/repos` | `index.js:185`–`4784` | 30s 缓存（签名含工作区清单 + 活动任务 cwd）；遍历 job 历史 + `loadKnownRepos()` 去重，对每个 cwd 现跑 `cw status`（`runCw`）算 `state/staleArticles/changedFiles/articleCount`；附 `scheduler` 块。 |
| sessions | `index.js:1985` | `GET /api/codewiki/sessions` | `index.js:2001`–`4811` | 带 `jobId` → `listSessionRecords(jobId)`；否则全局 `listAllSessionRecords({ limit })`（默认 200，封顶 500）并补 `cwd`。 |
| sessions/item | `index.js:1995` | `GET /api/codewiki/sessions/item` | `index.js:4815`–`4829` | 必须 `jobId` + 整数 `n`（≥1），否则 400；`readSessionRecord` 命中返回 200，否则 404（保留 24h）。 |
| models | `index.js:4562` | `GET /api/codewiki/models` | `index.js:4839`–`4851` | 30s 缓存 `listModelCatalog(extra.llm ?? llmRef)`；失败返回 `{ ok:false, providers:[] }`。 |
| model-efforts | `index.js:4872` | `GET /api/codewiki/model-efforts` | `index.js:4873`–`4875` | 必须 `provider`+`model` 查询参数（否则 400）；60s 缓存 `resolveModelEfforts`。 |
| control | `index.js:4537` | `POST /api/codewiki/control` | `index.js:3979`–`4907` | 仅 `POST`（否则 405）；`readBodyJson` 解析 `body.action`：`cancel`+`jobId` → `service.cancel`（200/404）；`refresh` → 清 `reposCache`（200）；`compile`+`cwd` → 调 `compile(...)`（缺入口 501、失败 400、否则 200）；未知 action → 400。 |

handler 的 `try/catch` 统一经 `writeJson(res, 500, …)` 写回错误，避免宿主 `handler reject` 只回 400 空 body。`jobs`（`index.js:2375`）与 `repos`（`index.js:4743`）的 catch 额外附 `stack`（前 8 行）便于排查；`sessions`/`sessions/item`/`models`/`model-efforts` 的 catch 只回 `{ error }`（或 `{ ok:false, error }`），不含栈。

### Mock HTTP 层（`test-orchestration.mjs`）

- **`makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })`** — `test-orchestration.mjs:51`–`91`。返回 `{ ctx, registered, endpoints, listeners, disposers }`。其中：
  - `endpoints` 数组（`test-orchestration.mjs:53`）由假 `webServer.register(def)`（`test-orchestration.mjs:57`）收集——**这就是「mock HTTP endpoints」的收集点**，等价于宿主把 `installWebServer` 注册的 7 个 `{ kind, path, handler }` 收进面板路由表。
  - `ctx.inject` 支持两种风格：带回调（立即 `fn(slice)`，`test-orchestration.mjs:68`）与 Promise（`test-orchestration.mjs:68`）；`ctx.on`（`test-orchestration.mjs:80`）/`ctx.effect`（`test-orchestration.mjs:84`）同构真实 cordis 语义。
  - `services.webServer = { register(def) { endpoints.push(def) } }`（`test-orchestration.mjs:53`–`57`）——`apply` 调 `installWebServer` 时，这 7 个端点被完整收集进 `endpoints`，测试随后按 `path` 取出。
- **`fakeReq(body, addr = '127.0.0.1', method = 'POST')`** — `test-orchestration.mjs:245`–`254`。造最小请求对象：`method`、`socket.remoteAddress`（`addr` 决定回环与否）、`on('data'|'end')` 在主体里同步把 `JSON.stringify(body)` 喂出并 `end`。用于 GET 端点时传 `body=undefined`（不触发 data）。注意它**没有** `url` 字段——单任务/聚合路径的 sessions 测试自造 `{ method, url, socket }`（`test-orchestration.mjs:1381`）补上。
- **`fakeRes()`** — `test-orchestration.mjs:255`–`257`。造最小响应对象：`code`（初始 0）、`out`（初始 ''）、`writeHead(c){ this.code=c }`、`end(b){ this.out = String(b ?? '') }`。断言用 `res.code` 判状态、`JSON.parse(res.out)` 取响应体。

测试里驱动端点的惯用法（「request/response handlers」的调用点）：
- 取端点：`main.endpoints.find((e) => e.path === '/api/codewiki/jobs')`（`test-orchestration.mjs:776`、`856`、`1051`、`1346`、`1465` 等）。
- 调 handler 并断言：`jobsEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resJobs)` 后查 `resJobs.code` 与 `JSON.parse(resJobs.out)`（`test-orchestration.mjs:778`）。
- 非回环守卫：`jobsEp.handler(fakeReq(undefined, '10.1.2.3'), res403)` → `res403.code === 403`（`test-orchestration.mjs:1055`）。
- 控制动作：`ctlEp.handler(fakeReq({ action: 'cancel', jobId: r4.jobId }), resCancel)` → `resCancel.code === 200`（`test-orchestration.mjs:1083`）；`refresh`（`test-orchestration.mjs:1177`）；`compile`（`test-orchestration.mjs:1108`、`1123`）。

## Architecture

```text
  test (test-orchestration.mjs)                prod (index.js)
 ┌────────────────────────┐                 ┌──────────────────────────────┐
 │ makeCtx()              │                 │ apply() → installWebServer() │
 │  webServer.register ───┼─收集─┐          │  ws.register({kind,path,     │
 │  push → endpoints[]    │     │          │   handler}) ×7                │
 └───────────┬────────────┘     │          └───────────────┬──────────────┘
             │ endpoints.find    │                          │ 7 handlers
             │ (e.path === '…')  │                          │ (jobs/repos/
 ┌───────────┴────────────┐     │                          │  sessions/
 │ fakeReq / fakeRes      │     │                          │  control/...)
 │ 最小 req/res 桩        │     │                          │
 └───────────┬────────────┘     │                          │
             │ 直接调 handler   │                          │
             ▼                  │                          ▼
 ┌────────────────────────┐     │          ┌──────────────────────────────┐
 │ 断言 res.code / res.out│◄────┘          │ guard(isLoopback) → 403      │
 │ (writeJson 写出)        │                │ filter / cache              │
 └────────────────────────┘                │ → service.cancel/compile    │
                                            │   listSessionRecords …      │
                                            │ → writeJson(res, code, obj) │
                                            └──────────────────────────────┘
```

## Data Flow

以「面板拉 jobs 列表 + 用户取消」为例，串起两层：

1. `apply(ctx, cfg)`（`index.js:5114`）内调 `installWebServer(ctx, service, { config, schedState, compile })`（`index.js:4624`）。
2. `installWebServer` 经 `ctx.inject(['webServer'], rc => …)`（`index.js:4624`）拿到 `ws`（mock 下为 `services.webServer`，其 `register` 把 7 个 `def` 推进 `endpoints`）。
3. 每个 `def` 形如 `{ kind:'exact', path:'/api/codewiki/jobs', handler }`——`handler` 闭包持有 `service`/`schedState`/`compile`/`config`。
4. 测试侧：`cc.endpoints.find(e => e.path === '/api/codewiki/jobs').handler(fakeReq({}, '127.0.0.1', 'GET'), fakeRes())`。
5. handler 内：`guard` 校验 `isLoopbackRequest(fakeReq)` → `fakeReq.socket.remoteAddress === '127.0.0.1'` 放行；取 `service.list()`，按 `wsFilterPaths()`（依赖 `workspaceRegistry`）与 `isDeadCompileTarget` 过滤；给 `queued` 任务补 `queueAhead`；`writeJson(res, 200, { now, jobs })`。
6. `fakeRes.end(body)` 把 JSON 写进 `res.out`，断言 `JSON.parse(res.out).jobs` 形态。
7. 取消：`ctlEp.handler(fakeReq({action:'cancel', jobId}), res)` → `readBodyJson`（mock 的 `on('data')` 同步给 body）→ `service.cancel(jobId)` → `writeJson(res, ok?200:404, {ok})`。

`control` 端点的 `compile` 动作还会反向调用 `extra.compile`（`apply` 注入的 `generateDef.execute`，`index.js:5122`），即 mock 层能驱动真实编译提交并回到 `repos`/`jobs` 端点观测。

## Connections

- [[client-js]] — 浏览器侧面板按 `JOBS_PATH`/`REPOS_PATH`/`SESSIONS_PATH`/`MODELS_PATH`/`EFFORTS_PATH`/`CONTROL_PATH` 轮询这些端点（`client.js:20`–`27`）。
- [[index-js]] — `installWebServer`、`apply`（`index.js:5114`）与 7 个端点 handler、辅助 `writeJson`/`readBodyJson`/`isLoopbackRequest` 所在模块。
- [[orchestration-tests]] — `test-orchestration.mjs` 即本模块 mock 层的归属测试，覆盖所有端点行为。
- [[job-service]] — 端点 handler 通过 `service.list()`/`service.cancel()` 读写编译任务（`installWebServer` 传入的 `service`）。
- [[sessions-storage]] — `sessions`/`sessions/item` 端点依赖 `listSessionRecords`/`listAllSessionRecords`/`readSessionRecord`（见 `test-sessions.mjs`）。
- [[models-catalog]] — `models`/`model-efforts` 端点依赖 `listModelCatalog`/`resolveModelEfforts`（宿主 `llm` 服务）。

## Known Issues

- **`fakeReq` 缺 `url` 字段**：仅构造 `method/socket/on`，没有 `url`（`test-orchestration.mjs:245`）。`sessions`/`sessions/item` 端点 handler 内部用 `new URL(req.url ?? '', 'http://localhost')` 解析查询参数（`index.js:4796`、`4818`），因此纯 `fakeReq` 驱动这两个端点时查询参数取不到；测试在 `test-orchestration.mjs:1381` 自造 `{ method:'GET', url:'/api/codewiki/sessions?jobId=…', socket:{remoteAddress:'127.0.0.1'} }` 补 `url`。
- **`fakeRes` 不含 `writeHead` 的真实头**：`writeHead(c)` 只存 `this.code`（`test-orchestration.mjs:256`），测试断言只看 `code` 与 `out`，不校验 `Content-Type`/`Content-Length`（`writeJson` 在 `index.js:4531` 设的）。
- **`repos` 端点有真实副作用**：handler 内对每个 cwd 现跑 `cw status`（`index.js:4743`），依赖磁盘上真实 git 仓库与可解析的 `cw` 二进制（`resolveBinary`，`index.js:163`）；mock 层不拦截，故 repos 测试必须对真实 fixture 仓库跑（`makeFixtureRepo`，`test-orchestration.mjs:110`），且 `reposCache` 30s TTL（`index.js:4703`）靠 `wsSig` 签名（工作区清单+活动任务 cwd）旁路失效。
- **control 的 `compile` 走真实 `generateDef.execute`**：`index.js:5122` 注入的 `compile` 是真实提交入口，测试里触发 `compile` 动作等于真起一个编译任务（`test-orchestration.mjs:1108`），会落 `JOBS_FILE` 并产生子进程/LLM 调用（受 `makeBatchMock` 拦截）。
- **端点对 `workspaceRegistry.list()` 抛错的降级**：仅在 `brokenRegistry:true` 的 mock ctx 下触发（`test-orchestration.mjs:1260`），handler 内部 `wsFilterPaths()` 捕获后返回 `null` 不过滤（`index.js:4640`）；生产极少出现，属防御路径。
