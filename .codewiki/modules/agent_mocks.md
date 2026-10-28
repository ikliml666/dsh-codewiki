---
title: agent_mocks
type: module
source_files:
  - test-orchestration.mjs
tags: [test-infrastructure, mocks, llm-proxy, prompt-observation, fake-http, agentic]
---

## Overview

`agent_mocks` 不是仓库里一个独立目录，而是 `test-orchestration.mjs` 顶部的 **mock / 测试桩块**（第 33–257 行）。它把「真实宿主 + 真实 LLM 服务 + 真实 webServer」替换成一组可脚本化、可观测、完全离线的假实现，使 dsh-codewiki 的服务化编排（提交 → 阶段机 → 自动提交）能在 `node test-orchestration.mjs` 下冒烟，而不依赖任何密钥或网络。

这一块对外提供四类能力，恰好对应任务描述的四个关键词：

- **Mock agents** —— `makeMockAgent` / `makeCtx`：造出 cordis 风格的 agent 与宿主 ctx，把 `webServer`/`agents`/`tools`/`llm`/`workspaceRegistry` 全部换成可捕获、可断言的桩。
- **LLM proxy** —— `llmProxy` + `makeBatchMock`：`llmProxy` 是恒转发器（每个测试块只换一次 `activeLlm`），`makeBatchMock` 造出「按 prompt 首行特征分发应答」的假 llm 服务，并记录每一次 `stream` 调用的 `provider/model/reasoningEffort/prompt/signal`。
- **Prompt observation** —— `promptOf` 与 `makeBatchMock` 返回的 `llmCalls` / `batchPrompts()` / `realtimePrompts()`：测试借此核对「请求按哪个 provider/model 发出、有没有规划请求、有没有把超长原文喂进合成批」。
- **Fake HTTP request/response helpers** —— `fakeReq` / `fakeRes`：造出 `req`/`res` 对象喂给 webServer 端点 handler，并断言状态码与回包，且强制 loopback 来源校验（非回环地址应 403）。

整个文件用这些桩驱动 `apply(ctx, cfg)` 注册的两个工具（`cw` / `codewiki_generate` / `codewiki_progress` / `codewiki_update`）与面板端点（`/api/codewiki/jobs` / `/api/codewiki/control` / `/api/codewiki/repos` / `/api/codewiki/sessions`），再轮询 `JOBS_FILE` 等终态。

## Key Components

### `articleMd(title, source, marker, type)` — 假文章模板（第 33–34 行）

```js
const articleMd = (title, source, marker = 'Batch-written', type = 'module') =>
  `---\ntitle: ${title}\ntype: ${type}\nsource_files:\n  - ${source}\ntags: []\n---\n\n# ${title}\n\n${marker} article.\n`
```

- 参数：`title`（字符串）、`source`（source_files 里的一个相对路径）、`marker`（写进正文的第一段标识，默认 `Batch-written`）、`type`（frontmatter 的 `type`，默认 `module`）。
- 返回：一段合法 markdown 文章字符串（含 frontmatter）。
- 用途：被 `makeBatchMock` 的 `answerFor` 用来**合成模型应答**（让 agentic/批量通道真正落出可被契约闸门校验的文件）。`mock` 注入时通过改 `marker` 区分批次（如 `Stale-batch`、`Restarted-batch`、`PROOFED`），便于断言「哪篇被重写、哪篇没动」。

### `makeCtx({ agents, workspaces, brokenRegistry, agentGet, llm })` — mock 宿主 ctx（第 51–91 行）

- 参数对象：
  - `agents`：`Array<agent>`，默认 `[]`。
  - `workspaces`：`Array<string> | null`，非空时挂 `workspaceRegistry`（按 path 列表）。
  - `brokenRegistry`：`boolean`，为 true 时 `workspaceRegistry.list()` 抛错（模拟宿主 registry 内部不一致）。
  - `agentGet`：`(id) => agent | undefined`，用于 `agents.get(id)` 路由（如 e2e 唤醒）。
  - `llm`：覆盖 `services.llm`（默认转发到 `llmProxy`）。
- 构造的 `services`：
  - `webServer`：`{ register(def) { endpoints.push(def) } }`（第 57 行）。
  - `agents`：有 `agentGet` 时 `{ list, get }`，否则 `{ list: () => agents }`（第 58 行）。
  - `tools`：`{ register(def) { registered.set(def.name, def); return () => {} } }`（第 59 行，注册返回空 disposer）。
  - `llm`：`llm ?? llmProxy`（第 60 行）。
  - `workspaceRegistry`：见上（第 62–67 行）。
- 返回的 `ctx` 对象（第 68–89 行）：
  - `inject(deps, fn)`：兼容 cordis 两种风格——带回调时按 deps 切片成 `{ [dep]: services[dep] }` 传 `fn`（第 72–76 行），否则 `Promise.resolve(services[dep]...)`（第 77–78 行）。注释特别说明：直传实例会掩盖 cordis 严格语义，必须传切片。
  - `on(event, fn)`：推入 `listeners`（第 80 行）。
  - `effect(fn)`：立即执行 `fn`，若返回函数则收集为 `disposers`（第 84–88 行）。注释说明这是真 cordis 语义的防线（错用 `ctx.effect(() => service.stop())` 会当场停 tick）。
- 返回集合：`{ ctx, registered, endpoints, listeners, disposers }`（第 90 行）。测试用 `registered.get('codewiki_generate')` 取工具、`endpoints.find(e => e.path === '/api/codewiki/jobs')` 取端点。

### `makeMockAgent(cwd)` — mock agent（第 94–108 行）

- 参数：`cwd`（字符串，写进 `session.header.cwd`）。
- 构造的 `agent`：
  - `session.header.cwd`（第 97 行）。
  - `ctx.inject(deps, fn)`：向 `fn` 注入 `systemPrompt`，其中 `getSectionOrder(n)` 返回 `{ TOOL_REPORT: 2900 }[n] ?? 0`（第 101 行），`section(s)` 把 section 推入 `sections` 并返回 `() => {}`（第 102 行）。
- 返回：`{ agent, sections }`（第 107 行）。`sections` 用于断言 systemPrompt section 是否注入（如 `codewiki:update-reminder`）。

### `makeFixtureRepo()` — 临时 git fixture 仓库（第 110–127 行）

- 无参数。在 `os.tmpdir()` 下建 `cw-orch-*` 目录，造 `core/core.py`（`def run(): return "core"`）与 `util/util.py`（`def fmt(): return "util"`）两个顶层目录（第 114–117 行），然后 `git init` + 配置 `user.name/test` `user.email/test@test` + `add` + `commit -m init`（第 118–125 行）。
- 返回仓库根目录字符串。
- 关键约束（注释说明）：0.10.7 删规划阶段后模块清单由 `localPlan` 按**顶层目录**分组生成，fixture 的顶层目录结构直接决定模块名（core/util）；0.10.9 起 fixture 必须自带 git identity，否则 `autoCommitWiki` 拒绝自动提交。

### `llmProxy` + `activeLlm`（第 132–140 行）

- `activeLlm`：模块级变量，保存「当前生效的假 llm」（第 132 行）。
- `llmProxy`（第 133–140 行）：宿主 ctx 注册的 `services.llm` 默认指向它。它的三个方法都转发到 `activeLlm`：
  - `async *stream(opts)`：若 `activeLlm` 为空抛 `测试未接线：先 makeBatchMock() 再提交任务`，否则 `yield* activeLlm.stream(opts)`（第 134–137 行）。
  - `listModels(...a)` / `resolveModel(...a)`：同样转发，缺省返回 `[]` / `null`（第 138–139 行）。
- 设计意图（注释）：0.10.1 起唯一通道是宿主 llm 服务（插件不再直连任何端点），`llmProxy` 恒转发到 `activeLlm`，因此每个测试块只需 `makeBatchMock()` 一处接线，不必给每个 `apply` 的 ctx 补 llm。

### `makeBatchMock({ modules, articleMarker, stall, bigArticle })` — 假宿主 llm 服务（第 145–227 行）

- 参数（第 145 行）：
  - `modules`：默认 `['core', 'util']`，决定「文章作者」应答里 module 名。
  - `articleMarker`：默认 `'Batch-written'`，写进合成文章正文。
  - `stall`：`boolean`，为 true 时 stream 不返回、挂起直到 `opts.signal` abort（模拟取消语义）。
  - `bigArticle`：`boolean`，为 true 且命中「文章作者」时把应答追加 `长×70000` 撑大，触发大档/横切分割路径。
- 内部 `llmCalls`（第 146 行）：每次 stream 调用记录 `{ provider, model, reasoningEffort, prompt, signal }`。
- `answerFor(prompt)`（第 147–195 行）：按 prompt **首行特征**分发应答，与真实 prompt 模板的区分句一一对应：
  - 含 `你是 CodeWiki 文章观察员` → 返回观察文本（第 149–150 行）。
  - 含 `你是 CodeWiki 文章作者` → stale 更新按 `更新过期文章 <名>：` 抽取目标名并决定 `type`/源文件（第 152–173 行）；普通模块按 `modules/<mn>.md` 抽取名、调用 `articleMd`。`type` 映射：根 `_architecture.md`→architecture、`_patterns.md`→pattern、`concepts/`→concept、`learnings/`→learning、其余→module（第 158–168 行）。
  - 含 `你是 CodeWiki 架构观察员` → 返回模块观察文本（第 174–175 行）。
  - 含 `写系统总览` / `总结仓库反复出现的模式` / `写跨模块概念` → 返回对应 architecture/pattern/concept 文章（第 177–179 行）。
  - 含 `你是 CodeWiki 审校员` → 按 `@@@article: ` 标记逐篇回标记格式（`settleProofread` 按标记拆回），否则回 PROOFED 文章（第 180–193 行）。
  - 兜底：返回 `unknown task`（第 194 行）。
- 假 `llm.stream`（第 197–216 行）：`yield block-start` → （stall 则挂起）→ `yield text-delta`（内容为 `answerFor`）→ `yield usage` → `yield finish {kind:'stop'}`。每次调用把 `provider/model/reasoningEffort/prompt/signal` 推入 `llmCalls`（第 200 行）。
- 返回（第 219–226 行）：
  - `llm`：假 llm 对象（并存到 `activeLlm`，`prevLlm` 被记住）。
  - `llmCalls`：原始调用记录数组。
  - `batchPrompts()` / `realtimePrompts()`：都返回 `llmCalls.map(c => c.prompt)`（第 222–223 行）——**prompt observation** 入口。
  - `restore()`：把 `activeLlm` 恢复成上一次的值（块间嵌套/还原用，第 225 行）。

### `promptOf(opts)` — 取 prompt 首行文本（第 141 行）

```js
const promptOf = (opts) => String(opts?.messages?.[0]?.content?.[0]?.text ?? '')
```

- 从 `opts.messages[0].content[0].text` 取首段文本（首行特征匹配用）。
- 被 `makeBatchMock` 的 `stream` 用于决定应答分支（第 199 行）。

### `waitJob(cwd, { timeout = 30000 })` — 轮询 JOBS_FILE 等终态（第 230–243 行）

- 参数：`cwd`（目标仓库路径，与 job.cwd 归一化比较）、`timeout`（默认 30000ms）。
- 行为：每 150ms 读一次 `JOBS_FILE`，取 `jobs` 中 `norm(x.cwd) === norm(cwd)` 的**最后一条**，若 `stage ∈ {done, failed, cancelled}` 即返回该 job；超时才返回当前 job（可能为 null）（第 233–242 行）。
- `norm(p)`：把路径反斜杠统一为正斜杠（第 231 行），用于跨平台 cwd 比较。
- 用途：测试提交后不就地 await 编译，而是轮询直到服务把 job 推进到终态。

### `fakeReq(body, addr, method)` — 假请求对象（第 245–254 行）

```js
function fakeReq(body, addr = '127.0.0.1', method = 'POST') {
  return {
    method,
    socket: { remoteAddress: addr },
    on(ev, fn) {
      if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') fn()
    },
  }
}
```

- 参数：`body`（可序列化对象，会被 `JSON.stringify` 后通过 `data` 事件喂出）、`addr`（来源地址，默认回环 `127.0.0.1`，可传 `10.0.0.9` 测 403）、`method`（默认 `POST`）。
- 返回的 req 含 `method` / `socket.remoteAddress` / `on('data'|'end', fn)`（同步回调）。某些断言点用内联对象 `{ method:'GET', url, socket:{remoteAddress} }`（如第 1381 行）代替本函数，因为本函数不生成 `url`。
- 用途：喂给面板端点 `handler(fakeReq(...), fakeRes())`（如 `jobsEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resJobs)` 第 858 行）。

### `fakeRes()` — 假响应对象（第 255–257 行）

```js
function fakeRes() {
  return { code: 0, out: '', writeHead(c) { this.code = c }, end(b) { this.out = String(b ?? '') } }
}
```

- 返回的 res 含：
  - `code`：初始 `0`，`writeHead(c)` 时设为 `c`（`writeHead` 即宿主 HTTP 写状态码）。
  - `out`：初始 `''`，`end(b)` 时设为 `String(b ?? '')`——端点回包正文。
  - `writeHead(c)` / `end(b)` 两个方法。
- 用途：断言端点 `code`（如 200/403/404，`resJobs.code`）与 `out`（再 `JSON.parse` 出 payload）。

## Architecture

```text
┌─────────────┐   apply(ctx,cfg)    ┌──────────────────────┐
│  makeCtx    │ ──────────────────► │  codewiki_generate / │
│ (mock host) │                     │  codewiki_progress / │
│ ctx+reg+ep  │                     │  codewiki_update /cw │
└──────┬──────┘                     └──────────┬───────────┘
       │ services.llm = llmProxy               │ submit → service tick
       ▼                                        ▼
┌─────────────┐  forward  ┌──────────────┐  prompt  ┌──────────────────────┐
│  activeLlm  │ ◄──────── │  llmProxy    │ ◄─────── │  makeBatchMock.stream │
│ (set by     │           │ (test-orstr  │          │  → answerFor(prompt)  │
│  makeBatch) │           │  line 133)   │          │  → articleMd / PROOFED │
└──────┬──────┘           └──────────────┘          └──────────────────────┘
       │ records
       ▼
┌─────────────────────────────────────────────┐
│ llmCalls[] / batchPrompts() / realtimePrompts()│  ← prompt observation
└─────────────────────────────────────────────┘
┌─────────────┐  handler(req,res)   ┌─────────────┐
│  fakeReq    │ ──────────────────► │ webServer    │
│ (loopback)  │                     │ endpoints    │
└─────────────┘ ◄──────────────────│ (jobs/ctrl/  │
┌─────────────┐  code/out           │  repos/sess) │
│  fakeRes    │ ───────────────────►│              │
└─────────────┘                     └──────┬───────┘
                                          │ read JOBS_FILE
                                          ▼
                                    ┌────────────┐
                                    │  waitJob   │ → {stage,done/...}
                                    └────────────┘
```

组件 ≥3 且流程跨 mock 宿主、假 llm、假 HTTP、轮询四块，故画框图。

## Data Flow

一次「全量编译端到端」的数据流（对应 `test-orchestration.mjs` 第 642–683 行块）：

1. `makeBatchMock()` 把 `activeLlm` 设为假 llm，`makeCtx({})` 造出 mock 宿主 ctx，调 `apply(main.ctx, batchCfg())` 注册工具与端点（第 297、597 行）。
2. `gen.execute({ cwd: mainRepo }, { agent })` 提交，立即回 `{ submitted, jobId, stage:'articles' }`（第 647–651 行）。
3. 服务后台 tick 把批量任务按 `services.llm` 发出：`llmProxy.stream(opts)` 转发到 `activeLlm.stream`，后者 `promptOf(opts)` 取 prompt 首行 → `answerFor` 按特征回文本 → 按 block 协议吐 `block-start/text-delta/usage/finish`；每次调用推入 `llmCalls`（第 134–137、197–216 行）。
4. 文章/横切/校对阶段各取不同 prompt 特征，分别落 `modules/*.md` / `_architecture.md` / `_patterns.md`，校对批回写 `PROOFED`（第 672–677 行）。
5. 编译终态 `done` 后插件 `autoCommitWiki` 提交（branch 合并式），job.stage 落盘（第 656–658 行）。
6. 测试 `await waitJob(r1.cwd)` 轮询 `JOBS_FILE` 直到 `stage==='done'` 返回 job（第 652 行）。
7. **prompt observation**：`mock.batchPrompts()` / `mock.llmCalls` 用于断言「provider/model 全为 workbuddy/hy3、无规划请求、无超长原文进合成批」（第 604–608、854、701 行）。
8. **fake HTTP**：`jobsEp.handler(fakeReq({}, '127.0.0.1', 'GET'), resJobs)` → 断言 `resJobs.code === 200` 且 `JSON.parse(resJobs.out).jobs` 含该任务；非回环地址断言 403（第 856–859、1054–1056 行）。
9. 收尾 `mock.restore()` 把 `activeLlm` 还原（第 681 行）。

取消语义数据流：`makeBatchMock({ stall:true })` 让 stream 挂起不返回；`ctlEp.handler(fakeReq({action:'cancel',jobId}), resCancel)` 经 `fakeReq`/`fakeRes` 触发取消，`opts.signal` abort 后挂起的 stream 抛 `client aborted`，job 终态 `cancelled`（第 756、788–791、203–208 行）。

## Connections

- 驱动的目标模块：[[orchestration]]（服务化编排、阶段机）、`index.js` 的 `apply`/`codewiki_generate`/`codewiki_progress`/`codewiki_update`/`autoCommitWiki`/`wakeCompileSession`。
- prompt 特征字符串与真实通道一一对应：[[agentic-host]]（host stream 的 block 协议）、[[agentic_core]]（agentic 写作通道）、[[articles-agentic]]（子模块派发）。
- 假 HTTP 端点与面板一致：[[client-interface]]（`/api/codewiki/*` 端点）、[[observability]]（jobs/repos 总览、`tps`/stageTimings）。
- 同期的其他 mock 风格：[[test-suite]]（其他测试文件的 `scripted`/`fakeLlm` 桩）、[[engine-llm-bridge]]（loopback 桥用 `fakeLlm`）、[[engine-openai-bridge]]。
- 衍生阅读：`.codewiki/modules/orchestration-tests.md`（编排冒烟）、`.codewiki/modules/test-scripts.md`（测试脚本总览）。

## Known Issues

- `fakeReq` **不生成 `url` 字段**（第 245–254 行）：带 `jobId`/`limit` 查询参数的端点断言必须手搓内联对象 `{ method:'GET', url:'/api/codewiki/sessions?jobId=...', socket:{remoteAddress} }`（第 1381 行），不能直接用 `fakeReq`，否则 handler 读不到 `url.searchParams`。
- `makeBatchMock` 的 `answerFor` 依赖 prompt **首行特征**硬匹配（第 148–194 行）：若真实 prompt 模板改了那段区分句（如「你是 CodeWiki 文章观察员」），mock 会落到兜底 `unknown task`，表现为「编译永远不落盘、无报错」——改 prompt 模板必须同步改这里。
- `llmProxy` 在 `activeLlm` 为空时抛 `测试未接线：先 makeBatchMock() 再提交任务`（第 135 行）：任何「忘记在块开头 `makeBatchMock()`」的用例都会在这里失败，而不是在更隐蔽处。
- `waitJob` 的 `timeout` 默认 30s，且只在超时后返回（不抛）（第 240–241 行）：若服务真卡住，测试会静默等到 30s 才继续，而不是快速失败；大 wiki/分割块已显式传 `timeout: 45000`（第 732、830 行）。
- `makeCtx` 的 `inject` 注释强调必须传「切片」而非实例（第 70–76 行）：早期实现直传 `services` 实例会掩盖 cordis 严格语义（切片当实例用，属性访问才抛 without inject），回归到此写法会让 `apply` 行为失真而不报错。
- `makeBatchMock` 每次调用会覆盖模块级 `activeLlm`（第 218 行），必须由调用方在 `finally` 里 `mock.restore()`（第 681、802、869 行等）还原，否则后续 `main` ctx 的断言（如 e2e 唤醒）会用到错误的假 llm。
