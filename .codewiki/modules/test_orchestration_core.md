---
title: test_orchestration_core
type: module
source_files:
  - test-orchestration.mjs
  - index.js
tags: [test, orchestration, mock, fixtures, e2e, builders]
---

## Overview

`modules/test_orchestration_core` 的实体是整个编排冒烟测试脚本 `test-orchestration.mjs` 头部（第 1–257 行）的**核心 helpers 与 builders**——一套自包含的「伪宿主 + 伪 LLM + 伪 agent + 临时仓库」测试底座。它不与任何测试框架绑定（`node test-orchestration.mjs` 直接跑），供脚本内每一个场景块（第 259–1551 行）复用，用来对 `index.js` 的服务化编排（提交制 / 阶段机 / 串行排队 / 自动提交 / 面板端点 / 重启重跑）做端到端钉死。

文件头注释（1|–6|）点明它的运行方式：mock 宿主 `llm` 服务（`llm.stream` 按 prompt 特征应答，插件零直连）+ 真实 `cw` CLI + 真实服务 tick。脚本分两层：

1. **Builder 层（本模块）**：`makeCtx`（伪宿主上下文）、`makeMockAgent`（伪 agent）、`makeFixtureRepo`（带 git 的临时仓库）、`makeBatchMock`（伪宿主 LLM 服务）、`waitJob`（终态轮询）、`fakeReq`/`fakeRes`（伪 HTTP）。它们彼此正交，可单独装配成任意测试环境。
2. **Scenario 层（1|–257| 之后）**：每个 `console.log('== … ==')` 块用上面的 builder 搭环境、调用 `apply(ctx, config)` 注插件、触发 `codewiki_generate` 等工具，再用 `check` 断言。

本模块只描述 builder 层；场景层的逐项断言属于「编排测试场景」，不在本文范围。

## Key Components

下列全部定义于 `test-orchestration.mjs`（行号取自读源码的「行号| 」前缀）。

### 测试加速与环境隔离

- `process.env.DSH_CODEWIKI_TICK_MS = '300'` — 15|。把服务 tick 间隔压到下限（生产默认 10s），加速端到端。
- `const here = path.dirname(fileURLToPath(import.meta.url))` — 17|。仓库根绝对路径，供「面板过滤」场景把正常任务的 `cwd` 指向真实仓库自身（避免被 Temp 残留清理移走）。
- `const TEST_JOB_TOKEN = crypto.randomBytes(4).toString('hex')` — 22|。随机串，避免历史运行的同名 JOBS_FILE 在 pid 复用时被原样读入造成「单项目串行」误判（注释 18|–21|）。
- `process.env.DSH_CODEWIKI_JOBS_FILE = path.join(os.tmpdir(), \`dsh-codewiki-jobs-test-${process.pid}-${TEST_JOB_TOKEN}.json\`)` — 23|。独立 JOBS_FILE，与真实宿主实例同机隔离，收尾统一删除（1548|）。
- `const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE` — 32|。后续所有 `waitJob` / 直接读 JSON 都用它。
- `const { name, apply, SESSIONS_DIR } = await import('./index.js')` — 24|。被测插件入口：`name`（插件名）、`apply`（cordis 风格 `apply(ctx, config)` 注册全部工具与端点）、`SESSIONS_DIR`（会话 Tab 落盘目录，1433| 清理）。

### 断言框架

- `let failures = 0` — 26|。累计失败计数，终态 1550| 决定 `process.exit(failures ? 1 : 0)`。
- `check(cond, msg)` — 27|–30|。断言函数：`cond` 为真打印 `  ✓ ${msg}`，为假则 `failures += 1` 并 `console.error('  ✗ …')`。全脚本唯一断言原语。

### 配置基线 builders

- `const articleMd = (title, source, marker = 'Batch-written', type = 'module') => …` — 33|–34|。合成一篇通过文章契约闸门（`type` 与目录一致）的 markdown 字符串，首部带 frontmatter `title/type/source_files`。`makeBatchMock` 的 `answerFor` 用它产出落盘文章。
- `const LEGACY_CHANNEL = { planMode: 'dirs', agenticArticles: false, symbolIncremental: false }` — 44|。0.13.0 起新增的三档「吸收自 FSoft CodeWiki」能力（语义规划 / agentic 写作 / 符号级增量）全部关掉，让本套测试继续守护**旧通道**的请求次数、装填方式与落盘时序（否则断言会因「通道换了」而非「功能坏了」失败，注释 36|–43|）。
- `const batchCfg = (extra = {}) => ({ batchProvider: 'workbuddy', batchModel: 'hy3', ...LEGACY_CHANNEL, ...extra })` — 45|。测试配置基线工厂：编译模型显式指向 `workbuddy/hy3`，叠加旧通道开关，再用 `extra` 覆盖（如 `serialProjects: false`、`parallelProjects: 3`、`workspaceOnly: false`、`excludePaths` 等场景）。

### 伪宿主上下文 builder

- `function makeCtx({ agents = [], workspaces = null, brokenRegistry = false, agentGet = null, llm = null } = {})` — 51|–91|。构造一个与真实 cordis 同构的宿主 `ctx` 切片，四个服务可捕获：
  - `services.webServer.register(def)` — 57|，推送进 `endpoints`（供 `/api/codewiki/*` 端点断言）。
  - `services.agents` — 58|，默认 `list: () => agents`；若传 `agentGet` 则带 `get`。
  - `services.tools.register(def)` — 59|，写进 `registered` Map（供 `registered.get('cw')` 取工具定义）。
  - `services.llm` — 60|，默认 `llmProxy`，可被 `makeBatchMock` 换掉 `activeLlm` 间接接管（注释 47|–50|）。
  - `services.workspaceRegistry` — 62|–67|：`workspaces` 非空时 `list()` 返回其映射的 `{ path }`；`brokenRegistry` 为真时 `list()` 直接抛错（模拟真宿主 jobs/repos 400 的候选根因，64|–66|）。
  - `ctx.inject(deps, fn)` — 69|–79|：支持 cordis 两种风格——带回调时传「ctx 切片」（服务在切片同名属性上，72|–76|，0.4.10 教训：直传实例会掩盖严格语义）；带 promise 时 `await ctx.inject([...])` 返回数组（77|–78|）。
  - `ctx.on(event, fn)` — 80|，收集进 `listeners`。
  - `ctx.effect(fn)` — 84|–88|：真实 cordis 语义——立即执行 `fn()`，返回函数则收集为 `disposers`（防线：错写 `ctx.effect(() => service.stop())` 会让 tick 当场停摆、测试挂死）。
  - 返回值：`{ ctx, registered, endpoints, listeners, disposers }` — 90|。场景块用 `registered` 取工具、`endpoints` 取面板端点、`listeners` 触发 `agent/created`。

- `function makeMockAgent(cwd)` — 94|–108|。构造一个与真实 agent 同构的伪 agent，仅用于 `systemPrompt` section 注册断言（系统提示提醒场景）：
  - `agent.session.header.cwd` — 97|，当前会话工作目录。
  - `agent.ctx.inject(deps, fn)` — 99|–105|：注入 `systemPrompt` 服务，其 `getSectionOrder(n)` 对 `TOOL_REPORT` 返回 2900（101|），`section(s)` 把注册段 push 进 `sections` 并返回 disposer（102|）。
  - 返回值：`{ agent, sections }` — 107|，`sections` 收集所有注册的 section（含 `name`/`text()`）。

### 伪仓库 fixture builder

- `function makeFixtureRepo()` — 110|–127|。造一个带真实 git 历史的临时仓库：
  - 顶层 `core/`、`util/` 两目录（0.10.7 删规划阶段后模块清单按顶层目录分组，fixture 结构直接决定模块名，112|–115|）。
  - `core/core.py`（`def run(): return "core"`）、`util/util.py`（116|–117|）。
  - `git init` + 0.10.9 起必须自带 git identity（`user.name=test`/`user.email=test@test`，否则 `autoCommitWiki` 拒绝自动提交）+ `add .` + `commit -m init`（118|–125|）。
  - 返回目录路径 `dir`（126|），供 `gen.execute({ cwd: dir })`。

### 伪宿主 LLM 服务 builder

- `let activeLlm = null` — 132|。「当前生效的假 llm」，每个测试块用 `makeBatchMock()` 接线即可，不必给每个 `apply` 的 `ctx` 补 `llm`（注释 129|–131|）。
- `const llmProxy = { async *stream(opts), listModels, resolveModel }` — 133|–140|。恒转发到 `activeLlm`：未接线时 `stream` 抛「测试未接线」（135|），`listModels`/`resolveModel` 在未接线时返回空/`null`（138|–139|）。`makeCtx` 默认把 `services.llm` 设成它（60|）。
- `const promptOf = (opts) => String(opts?.messages?.[0]?.content?.[0]?.text ?? '')` — 141|。从宿主 `llm.stream` 协议里抽第一段文本 prompt，供 `answerFor` 按特征分发。
- `function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false } = {})` — 145|–227|。核心 builder：按 prompt 首行特征应答的伪宿主 LLM 服务。
  - `llmCalls` — 146|：每次 `stream` 调用把 `{ provider, model, reasoningEffort, prompt, signal }` push 进去（200|），供断言「全部请求按设置的编译模型发出」「零规划请求」等。
  - `answerFor(prompt)` — 147|–195|：按 prompt 特征返回合成文本——
    - 含「你是 CodeWiki 文章观察员」→ 观察批应答（148|–150|）；
    - 含「你是 CodeWiki 文章作者」→ 若是 stale 更新（从 `更新过期文章\s+(\S+?)：` 提取目标名，156|），按目标位置给对 `type`（根级 `_architecture.md`=architecture、`_patterns.md`=pattern、`concepts/`=concept、`learnings/`=learning，其余 module，158|–161|）并造出真实存在的 `source_files`（166|–168|，契约闸门会校验），否则按 `modules/<名>.md` 产文（171|–172|）；
    - 含「你是 CodeWiki 架构观察员」→ 架构观察（174|–175|）；
    - 「写系统总览」/「总结仓库反复出现的模式」/「写跨模块概念」→ 分别产 architecture/pattern/concept（177|–179|）；
    - 含「你是 CodeWiki 审校员」→ 按 `@@@article:` 标记逐篇回 `PROOFED article` 标记格式（`settleProofread` 按标记拆回，180|–193|）；
    - 兜底返回未知任务（194|）。
  - `const llm = { async *stream(opts) }` — 197|–216|：把 `answerFor` 结果按宿主 block 协议吐出（`block-start` → `text-delta` → `usage` → `finish`，201|–214|）。`stall=true` 时不返回、挂起直到 `opts.signal` abort（202|–209|，取消语义）；`bigArticle=true` 且命中文章作者时追加 70000 字（211|，横切精准拆分场景）。
  - 接线与还原：`prevLlm = activeLlm; activeLlm = llm`（217|–218|）；返回值 `restore` 把 `activeLlm` 还原回 `prevLlm`（225|，块间嵌套用）。
  - 返回值：`{ llm, llmCalls, batchPrompts: () => llmCalls.map(c => c.prompt), realtimePrompts: () => … , restore }` — 219|–226|。`batchPrompts`/`realtimePrompts` 提供已发请求的 prompt 列表供断言。

### 终态轮询 helper

- `async function waitJob(cwd, { timeout = 30000 } = {})` — 230|–243|。轮询 `JOBS_FILE`，取 `cwd` 归一化后匹配的最新 job，命中 `done`/`failed`/`cancelled` 终态即返回（239|），超时按当前 job 返回（240|），文件未落盘时静默重试（238|）。全脚本等任务跑完的唯一同步点。

### 伪 HTTP helpers

- `function fakeReq(body, addr = '127.0.0.1', method = 'POST')` — 245|–254|。构造伪 `req`：`socket.remoteAddress = addr`（loopback 守卫断言用）、`on('data'/'end')` 在 body 非空时立即喂出 `Buffer.from(JSON.stringify(body))` 并 end（249|–252|）。
- `function fakeRes()` — 255|–257|。构造伪 `res`：`code=0`、`out=''`、`writeHead(c)` 记 `code`（256|）、`end(b)` 记 `out`（256|）。面板端点 `handler(fakeReq(...), fakeRes())` 后 `JSON.parse(res.out)` 取响应体。

## Architecture

builder 层是「被测插件 `index.js` 的 apply + 端点」周围的一圈 mock 环。每个场景块按 `makeCtx` → `apply(ctx, batchCfg())` → `makeFixtureRepo`/`makeBatchMock`/`makeMockAgent` 装配，再用 `fakeReq`/`fakeRes` 打端点、`waitJob` 等终态、`check` 断言。

```text
 test-orchestration.mjs (node test-orchestration.mjs)
 ┌────────────  Builder 层（本模块） ────────────────┐      ┌──── 被测插件 index.js ────┐
 │ makeCtx       51   ──ctx──► apply(ctx, batchCfg)  │      │ apply: 注册工具+端点      │
 │  ├ webServer ► endpoints[]   (24| name/apply)     │─────►│ cw / codewiki_generate   │
 │  ├ tools      ► registered{}                       │      │ codewiki_progress/update  │
 │  ├ agents     ► agents[] / agentGet               │      │ /api/codewiki/jobs|repos │
 │  ├ llm=llmProxy  ──stream──┐                       │      │ /control|sessions (install)│
 │  └ workspaceRegistry       │                       │      └─────────────────────────┘
 │ makeMockAgent 94  ──agent/section► listeners[]    │              │ tick 阶段机
 │ makeFixtureRepo 110 ──cwd──► gen.execute({cwd}) ───┼──────────────┘
 │ makeBatchMock  145 ──activeLlm=llm──► llmProxy ◄──┘   (answerFor 按 prompt 特征应答)
 │  └ llmCalls[] / batchPrompts()  ◄── 记录每次请求
 │ fakeReq 245 / fakeRes 255 ──► handler(fakeReq, fakeRes)  (loopback 守卫 / 取消 / 总览)
 │ waitJob 230 ──► 轮询 JOBS_FILE 取 cwd 终态 job
 │ check 27 ──► failures[] ──► 1550| 打印 + exit(1)
 └────────────────────────────────────────────────────┘
```

`makeCtx` 的 `inject` 双风格（69|–79|）是 cordis 同构的关键：`apply` 内部用 `ctx.inject(['webServer', 'llm', …], fn)` 拿到服务切片，builder 只需把这些服务实现成可捕获对象即可，无需真实宿主。

## Data Flow

1. **环境装配流**：`makeCtx` 造 `ctx` + `registered` + `endpoints`（51|–91|）→ `apply(main.ctx, batchCfg())`（如 296|）把 `index.js` 工具/端点注册进去 → `main.registered.get('codewiki_generate')` 取工具定义。
2. **LLM 接线流**：`makeBatchMock()` 把 `activeLlm` 换成伪 llm（217|–218|），`makeCtx` 默认 `services.llm = llmProxy`（60|）恒转发 → `gen.execute` 触发的 `llm.stream` 经 `llmProxy` 落到 `activeLlm`，每次调用记入 `llmCalls`（200|）。`restore()` 还原（225|）。
3. **任务执行流**：`makeFixtureRepo()` 造仓库（110|–127|）→ `gen.execute({ cwd }, { agent })` 提交 → `waitJob(cwd)` 轮询 `JOBS_FILE` 取到终态 job（230|–243|）→ 读 `job.notes`/`job.stage`/`job.writtenCount`/`job.autoCommit` 断言。
4. **端点验证流**：`main.endpoints.find(e => e.path === '/api/codewiki/jobs')`（如 856|）取端点 → `fakeReq`/`fakeRes`（245|–257|）打 handler → `JSON.parse(res.out)` 取 `jobs`/`repos`/`scheduler` 断言 loopback 守卫（非回环 403）、进度、队列等。
5. **清理流**：每个场景块 `finally` 里 `mock.restore()` + `fs.rmSync(repo, …)` 删临时仓库；脚本末尾删 `mainRepo` 与随机命名的 `JOBS_FILE`（1546|–1548|）。

## Connections

- [[index]] — 被测插件总入口（`apply`/`name`/`SESSIONS_DIR` 在 24| 导入；`commitHintText`/`autoCommitWiki`/`autoCommitState`/`wakeCompileSession` 在场景层按需 `await import`）。
- [[batch_tests]] — 另一条编译执行链自检（`test-batch.mjs`），同样用 mock llm 服务（`makeLlm`），但聚焦纯函数链而非服务化编排。
- [[wiki_tests]] — 另一条 e2e 测试（`test-wiki-*.mjs`）的 helpers 约定参照（系统提示提醒、worktree 闸门等场景与本文同源）。
- [[test-agentic]] — agentic 通道冒烟（0.13.0 新通道，本文 `LEGACY_CHANNEL` 在 44| 显式关掉它来守护旧通道）。
- [[test-cluster]] / [[test-graph-diff]] / [[test-symbols]] — 其余组件级测试模块，builder 风格与本文一致但各自独立。

## Known Issues

- **`makeCtx` 的 `inject` 在缺回调时返回数组而非切片**：带 promise 风格 `await ctx.inject([...])` 返回 `got.length === 1 ? got[0] : got`（77|–78|）——`apply` 若假定总是单值会拿错；真 cordis 下 `apply` 统一走带回调形式（72|–76|）。
- **`makeBatchMock` 的 `answerFor` 仅靠 prompt 首行关键词分发**：若 `index.js` 改了 prompt 模板的区分句（如「你是 CodeWiki 文章作者」），mock 会落到兜底分支返回 `unknown task`（194|），导致整轮断言失败——模板文案是 mock 与实现的隐式契约。
- **`makeBatchMock` 默认 `stall=false` 会立即跑完**：需要「停在 articles 阶段」的场景（单项目串行、取消、并发占位）必须传 `stall: true`（145|/756|/1015|/1047|），否则任务几百毫秒内终态，并发断言会碰上竞态（注释 1012|–1014|）。
- **`makeFixtureRepo` 强制带 git identity**：0.10.9 起 `autoCommitWiki` 在缺 `user.name/user.email` 时拒绝自动提交（121|–123|）；若场景需要「自动提交失败」分支，必须另造缺 identity 的仓库（485|–504|），不能复用本 fixture。
- **`waitJob` 仅在 `cwd` 归一化后匹配**：`norm` 把 `\` 替换为 `/`（231|），若场景里 jobs 文件的 `cwd` 与传入 `cwd` 大小写/斜杠不一致会永远轮询到超时（240|）。
- **`fakeRes` 不实现 `setHeader`/`getHeader`**：部分端点若用 `res.setHeader` 会抛（256| 只实现 `writeHead`/`end`），需确认 `installWebServer` 端点只用 `writeHead`。
