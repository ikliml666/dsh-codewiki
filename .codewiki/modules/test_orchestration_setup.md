---
title: test_orchestration_setup
type: module
source_files:
  - test-orchestration.mjs
  - index.js
tags: [test, orchestration, mock, helper, fixture]
---

## Overview

`test-orchestration.mjs` 是 dsh-codewiki 的「服务化编排冒烟」测试套件（1551 行）。它把真实 `cw` CLI、真实常驻服务 tick 与**完全 mock 的宿主 llm 服务**拼在一起，端到端验证编译阶段机（articles→crosscut→review→index）、提交制、stale 逐篇更新、单项目串行排队、取消/面板端点、宿主重启后按 prompt 快照重跑、编译模型缺失诚实报错等行为。

本模块「test_orchestration_setup」聚焦这套测试里**可复用的编排测试基础设施（setup + batch + mock agent 三类助手）**：它们不是被测对象本身，而是为了让编排测试能在零宿主依赖、无密钥、可确定断言的前提下跑起来而搭建的脚手架。

这些助手全部定义在 `test-orchestration.mjs` 文件顶部（第 7–243 行），具体场景断言散落在后面的各个 `console.log('== ... ==')` 块里。三类助手的核心职责：

- **setup 助手**：把运行环境固定到可测试状态——加速 tick（`DSH_CODEWIKI_TICK_MS=300`，第 15 行）、隔离 JOBS_FILE（随机 token 命名，第 22–23 行）、构建单测用的 `check()` 断言器（第 26–30 行）、生成 fixture 仓库 `makeFixtureRepo()`（第 110–127 行）、造文章 markdown 的 `articleMd()`（第 33–34 行）。
- **batch 助手**：`makeBatchMock()`（第 145–227 行）按 prompt 首行特征分发确定性应答的 mock llm 服务；`makeCtx()`（第 51–91 行）构造同构于真实 cordis 的 `ctx`（`inject`/`on`/`effect` 与 webServer/tools/agents/llm/workspaceRegistry 服务）；`waitJob()`（第 230–243 行）轮询 JOBS_FILE 等终态。
- **mock agent 助手**：`makeMockAgent()`（第 94–108 行）构造带 `session.header.cwd` 与 `ctx.inject` 的假 agent（用于 systemPrompt section 注册测试）；`fakeReq()`/`fakeRes()`（第 245–257 行）构造无 `http` 依赖的回环守卫 HTTP 请求/响应桩。

测试通过以下方式接入真实插件：`import { name, apply, SESSIONS_DIR } from './index.js'`（第 24 行），并对每个场景块 `apply(ctx, config)` 把注册的服务注入到插件。整套测试以 `node test-orchestration.mjs` 运行，靠 `process.exit(failures ? 1 : 0)`（第 1551 行）退出来暴露失败。

## Key Components

下面逐个列出本模块（test_orchestration_setup）所有公开助手函数/常量，行号以 `test-orchestration.mjs` 的「行号| 」前缀为准。所有助手均为该测试文件内顶层 `function`/`const` 声明，无类、无 struct。

### 顶层运行环境常量与断言器

- `process.env.DSH_CODEWIKI_TICK_MS = '300'`（第 15 行）：把服务 tick 间隔压到下限（生产默认 10s），加速整个编排测试的等待。
- `TEST_JOB_TOKEN`（第 22 行）＋ `process.env.DSH_CODEWIKI_JOBS_FILE`（第 23 行）：用 `crypto.randomBytes(4).toString('hex')` 拼出带 pid 与随机串的临时 JOBS_FILE 路径（落在 `os.tmpdir()`），与真实宿主服务实例（同机共享默认路径）隔离，避免互相洗写历史 fixture 任务（详见「Known Issues」里 0.10.10 偶发失败根因）。
- `failures`（第 26 行）＋ `check(cond, msg)`（第 27–30 行）：测试断言器。成功打印 `✓`，失败累加 `failures` 并打印 `✗`。全文件所有场景都用它做断言，末尾据此 `process.exit`。
- `JOBS_FILE`（第 32 行）：从 `process.env.DSH_CODEWIKI_JOBS_FILE` 取回，供 `waitJob` 与各场景直接 `fs.readFileSync` 读取。
- `articleMd(title, source, marker = 'Batch-written', type = 'module')`（第 33–34 行）：拼一段标准 frontmatter 文章 markdown（`---\ntitle: ...\ntype: ...\nsource_files:\n  - ...\n---\n\n# ...\n\n<marker> article.\n`），供 mock llm 当应答、也供 stale/article 场景校验落盘内容。

### 配置基线（`batchCfg` / `LEGACY_CHANNEL`）

- `LEGACY_CHANNEL`（第 44 行）：`{ planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`。0.13.0 起有三档新通道（语义规划 / agentic 写作 / 符号级增量），本测试守护旧通道，因此基线显式关掉三档，避免断言被「通道换了」而不是「功能坏了」搞失败。
- `batchCfg(extra = {})`（第 45 行）：返回 `{ batchProvider: 'workbuddy', batchModel: 'hy3', ...LEGACY_CHANNEL, ...extra }`。所有场景的默认插件配置；`extra` 用来覆盖（如 `serialProjects`、`parallelProjects`、`excludePaths`、`workspaceOnly`、`updateReminder`）。注意 `workbuddy/hy3` 正是 `index.js` 中 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL`（第 49–50 行）的镜像。

### setup 助手：mock 宿主上下文 `makeCtx`

- `makeCtx({ agents = [], workspaces = null, brokenRegistry = false, agentGet = null, llm = null } = {})`（第 51–91 行）：构造一个**同构于真实 cordis** 的 `ctx` 与 `registered`/`endpoints`/`listeners`/`disposers` 收集器。
  - `services` 内部（第 56–67 行）：`webServer.register(def)` 把面板端点 push 到 `endpoints`；`agents` 默认 `{ list: () => agents }`，传了 `agentGet` 则 `{ list, get: agentGet }`；`tools.register(def)` 把工具名→定义存入 `registered` Map（并返回 no-op disposer）；`llm` 用传入值或默认 `llmProxy`；`workspaces` 非空时挂 `workspaceRegistry`（第 63 行），`brokenRegistry=true` 时挂一个 `list()` 直接抛错的注册表（第 66 行，对应 0.4.9c 真宿主 jobs/repos 400 候选根因）。
  - `ctx.inject(deps, fn)`（第 69–79 行）：支持 cordis 两种风格——带回调时把 `services` 按依赖名映射成「ctx 切片」传给 fn（第 73–75 行）；只传 deps 数组时返回 `Promise.resolve`（第 77–78 行）。注释明确：直传实例会掩盖 cordis 严格语义，因此必须传切片。
  - `ctx.on(event, fn)`（第 80 行）：把监听 push 到 `listeners`。
  - `ctx.effect(fn)`（第 84–88 行）：立即执行 `fn()`，若返回函数则收集为 disposer。这是一道防线——若回归成 `ctx.effect(() => service.stop())` 错写法，`stop` 会被当场调用导致 tick 停摆、`waitJob` 挂死超时。
  - 返回值 `{ ctx, registered, endpoints, listeners, disposers }`（第 90 行）。

### setup 助手：mock agent `makeMockAgent`

- `makeMockAgent(cwd)`（第 94–108 行）：构造一个带 `session.header.cwd` 的假 agent，以及真实 cordis 语义的 `ctx.inject`（第 99–104 行）——注入 `systemPrompt` 服务，提供 `getSectionOrder(n)`（用 `{ TOOL_REPORT: 2900 }` 映射，第 101 行）和 `section(s)`（push 到 `sections` 并返回 no-op disposer，第 102 行）。返回 `{ agent, sections }`，`sections` 供「系统提示提醒」场景检查 section 名/文本。

### setup 助手：fixture 仓库 `makeFixtureRepo`

- `makeFixtureRepo()`（第 110–127 行）：在 `os.tmpdir()` 造一个带 git 的 fixture 仓库：
  - 建顶层 `core/`、`util/` 两个目录（第 114–115 行）——0.10.7 删规划阶段后模块清单由 localPlan 按顶层目录分组生成，fixture 结构直接决定模块名。
  - 写 `core/core.py`（第 116 行）与 `util/util.py`（第 117 行）。
  - `git init`（第 119 行）；0.10.9 起必须自带 git identity（`config user.name/user.email`，第 122–123 行），否则 `autoCommitWiki` 拒绝自动提交。
  - `git add .` + `git commit -m init`（第 124–125 行）。
  - 返回仓库目录绝对路径。

### batch 助手：mock llm 服务 `makeBatchMock`

- `llmProxy`（第 133–140 行）：真实 cordis 语义的 llm 代理。`async *stream(opts)`（第 134–137 行）转发到模块级 `activeLlm`（未接线则抛「测试未接线」）；`listModels`/`resolveModel` 同样转发。
- `activeLlm`（第 132 行）：模块级「当前生效的假 llm」。0.10.1 起唯一通道是宿主 llm 服务，`makeCtx` 注册的 `llmProxy` 恒转发它，因此每个测试块只需 `makeBatchMock()` 一处接线。
- `promptOf(opts)`（第 141 行）：从 `opts.messages[0].content[0].text` 取出 prompt 字符串。
- `makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false } = {})`（第 145–227 行）：构造确定性 mock llm 服务。
  - `answerFor(prompt)`（第 147–195 行）：按 prompt 首行特征分发应答，与真实 prompt 模板区分句一一对应：
    - 含「你是 CodeWiki 文章观察员」→ 返回观察文本（第 148–150 行）；
    - 含「你是 CodeWiki 文章作者」→ stale 单篇更新（`staleName` 从 `更新过期文章 (\S+?)：` 匹配，第 156 行；按文件名推断 `type`：根级 `_architecture.md`→architecture、`_patterns.md`→pattern、`concepts/`→concept、`learnings/`→learning，其余 module，第 158–161 行；按文件名拼 `source_files` 真实路径，第 166–168 行）；否则普通模块文章（第 171–172 行）；
    - 含「你是 CodeWiki 架构观察员」→ 模块观察文本（第 174–175 行）；
    - 含「写系统总览」→ architecture 文章（第 177 行）；含「总结仓库反复出现的模式」→ pattern 文章（第 178 行）；含「写跨模块概念」→ concept 文章（第 179 行）；
    - 含「你是 CodeWiki 审校员」→ 0.10.8 批量校对：按 `@@@article:` 标记逐篇回 `PROOFED article.`（第 180–193 行）；
    - 都不匹配 → 兜底 `unknown task`（第 194 行）。
  - `llm.stream(opts)`（第 197–216 行）：把 `answerFor` 结果按宿主 block 协议吐出（`block-start`→`text-delta`→`usage`→`finish`，第 201–214 行）；`stall=true` 时挂起直到 `opts.signal` abort（第 202–208 行，用于取消语义）；`bigArticle=true` 时给文章追加 7 万汉字（第 211 行，超预算触发横切拆分）。
  - 每个请求 push 到 `llmCalls`：`{ provider, model, reasoningEffort, prompt, signal }`（第 200 行）。
  - 返回值（第 219–226 行）：`{ llm, llmCalls, batchPrompts: () => llmCalls.map(c=>c.prompt), realtimePrompts: () => llmCalls.map(c=>c.prompt), restore: () => { activeLlm = prevLlm } }`。`restore()` 用于块间嵌套时恢复上一个生效的假 llm。

### setup 助手：等待终态 `waitJob`

- `waitJob(cwd, { timeout = 30000 } = {})`（第 230–243 行）：轮询 `JOBS_FILE`，按归一化 cwd（第 231 行 `norm` 把反斜杠统一为正斜杠）取出该仓库最新 job；`stage ∈ {done,failed,cancelled}` 即返回（第 239 行），超 `timeout` 也返回当前 job（第 240 行）。文件尚未落盘时 catch 跳过（第 238 行）。

### mock HTTP 桩 `fakeReq` / `fakeRes`

- `fakeReq(body, addr = '127.0.0.1', method = 'POST')`（第 245–254 行）：构造无 `http` 依赖的假请求：`method`、`socket.remoteAddress`、`on(ev, fn)` 在 `data` 时机喂 `Buffer.from(JSON.stringify(body))`、在 `end` 时机调用 `fn()`。用于回环守卫测试（`addr` 设为 `10.x` 即触发 403）。
- `fakeRes()`（第 255–257 行）：构造假响应：`code`（默认 0）、`out`（默认空串）、`writeHead(c)` 记 `code`、`end(b)` 记 `out`。配合 `JSON.parse(res.out)` 断言端点返回体。

### 严格 cordis 语义桩（场景私有，但属于 mock 助手族）

- 在「严格 cordis 语义」块（第 1505–1524 行）里就地构造的 `strictCtx`：用 `Object.defineProperty` 给 `agents` 属性装一个 getter，未 inject 即抛 `cannot get property "agents" without inject`（第 1516–1518 行），用于验证 `apply` 不会因直接访问未注入服务而抛错。该桩仅出现在该块内，不导出。

## Architecture

编排测试三族助手（setup / batch / mock agent）各自独立、互不依赖，通过 `apply(ctx, cfg)` 聚合到真实插件后协同工作。下面框图标注组件名与所在文件/行号，箭头标注关系。

```text
┌─ test-orchestration.mjs ───────────────────────────────────────────┐
│ setup 族            batch 族                  mock HTTP 桩          │
│ makeCtx(L51-91)     makeBatchMock(L145-227)   fakeReq/fakeRes       │
│ makeMockAgent(L94)  ├ activeLlm(L132)         (L245-257)            │
│ makeFixtureRepo     ├ llmProxy(L133-140)      waitJob(L230-243)     │
│   (L110-127)        ├ llmCalls(L200)          poll→JOBS_FILE        │
│ articleMd(L33)      └ answerFor(L147-195)     check(L26-30)         │
│ batchCfg(L44-45)                                        ▲            │
└───────┬──────────────────────┬───────────────────────────┼────────┘
        │ makeCtx 注入 services │ makeBatchMock 换 activeLlm │
        ▼                      ▼                           ▼
┌─ index.js (真实插件) ────────────────────────────────────────────────┐
│ apply(ctx,cfg)→注册 cw/codewiki_generate/codewiki_progress           │
│ 常驻 tick 推进阶段机: articles→crosscut→review→index→commit          │
│ fakeReq 喂 /jobs /control /repos /sessions 端点 → fakeRes 断言       │
│ 落盘 JOBS_FILE（随机 token 隔离，L22-23）                            │
└──────────────────────────────────────────────────────────────────────┘
```

关系要点：

- `makeCtx()` 是「宿主同构层」——它把 `webServer`/`tools`/`agents`/`llm`/`workspaceRegistry` 装进 `services`，再用 cordis 风格的 `inject`/`on`/`effect` 暴露给 `apply`。`makeBatchMock()` 只需调用一次把 `activeLlm` 换成自己（第 218 行），`makeCtx` 默认挂在 `llmProxy`（第 60 行）即自动转发到该 mock llm。
- `makeFixtureRepo()` 提供 git 仓库作为输入；`articleMd()` 提供 mock llm 的确定性应答模板；`waitJob()` 是场景与真实服务之间的同步闸门，靠轮询 `JOBS_FILE` 拿到终态 job。
- `fakeReq`/`fakeRes` 不依赖 Node `http`，直接把 `{ action, jobId }` 这类 body 喂给 `main.endpoints` 里注册的面板端点（`/api/codewiki/jobs`、`/control`、`/repos`、`/sessions`），从而单测回环守卫（127.0.0.1 vs 10.x）与取消/compile/refresh 动作。

## Data Flow

一次「全量编译端到端」场景的数据流（对应第 642–683 行「全量编译」块），最能体现三族助手如何串起来：

1. **setup**：`makeFixtureRepo()`（第 292 行）造出 `core/`、`util/` 两个模块的 git 仓库；`main = makeCtx({ agentGet: ... })`（第 294 行）构造宿主同构 ctx，`apply(main.ctx, mainConfig)`（第 296 行）把工具注册进 `main.registered`，拿到 `gen = registered.get('codewiki_generate')`（第 299 行）。
2. **batch 接线**：`makeBatchMock()`（第 645 行）把 `activeLlm` 换成确定性 mock llm，`restore()` 在 `finally` 里还原（第 681 行）。
3. **提交**：`gen.execute({ cwd: mainRepo }, { agent: { id: 'sess-e2e' } })`（第 647 行）立即返回 `{ submitted:true, jobId, stage:'articles' }`，**不就地等待**（第 651 行 `writtenCount === undefined`）。插件把 job 落盘到随机 token 的 `JOBS_FILE`。
4. **服务推进**：真实常驻 tick 取 job，按 `articles → crosscut → review → index → commit` 阶段机推进；每个阶段向 `activeLlm` 发请求，`makeBatchMock` 的 `llmCalls` 记录 `{ provider, model, prompt, signal }`（第 200 行）。`answerFor` 按 prompt 区分句回文章/观察/总览/校对应答（第 147–195 行）。
5. **同步**：`waitJob(r1.cwd)`（第 652 行）轮询 `JOBS_FILE`，对该 cwd 取最新 job，等 `stage ∈ {done,failed,cancelled}` 返回（第 239 行）。
6. **断言**：场景检查 `job.writtenCount >= 3`（第 655 行）、`job.autoCommit.committed`（第 656 行）、`_architecture.md`/`modules/core.md` 落盘且含 `PROOFED`（第 672–677 行）、`e2eSteers.length === 0`（第 670 行，证明自动提交后不唤醒会话）。

另一条独立数据流——**面板端点**：`main.endpoints.find(e => e.path === '/api/codewiki/jobs')`（如第 856、1051 行）取出端点，`fakeReq({}, '10.1.2.3')` + `fakeRes()` 喂进去，`res.code === 403` 验证非回环地址被拒（第 1056 行）；`fakeReq({ action: 'cancel', jobId })` 喂 `/control` 端点触发取消（第 1083 行），随后 `waitJob` 等到 `cancelled` 终态（第 1086 行）。

`stale` 逐篇更新（第 874–895 行）走同一套助手，只是 `gen.execute({ cwd, scope: 'stale' })` 直达 articles 阶段，`makeBatchMock` 的 `answerFor` 从 `更新过期文章 <name>：` 匹配出目标文件名并推断 `type`/`source_files`（第 156–169 行），保证只重写声明了 `core.py` 的 2 篇文章、`util.md` 不动（第 891 行）。

## Connections

本模块是 dsh-codewiki 的测试脚手架，与以下模块通过 `apply(ctx, cfg)` 与 `import` 直接耦合：

- [[index]] — 真实插件入口，`test-orchestration.mjs` 通过 `import { name, apply, SESSIONS_DIR } from './index.js'`（第 24 行）注入测试 ctx；`apply` 注册 `cw`/`codewiki_generate`/`codewiki_progress` 三个工具。本文断言的 `workbuddy/hy3` 默认值来自 `index.js` 的 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL`（第 49–50 行）。
- [[auto-commit-wiki]] — `autoCommitWiki`/`autoCommitState`/`wakeCompileSession`/`commitHintText` 均出自 `index.js`，被本文单测（第 430–581 行）；其分支合并式提交、三态判定、终态 steer 唤醒是本测试守护的核心行为。
- [[codewiki-orchestration]] — 服务阶段机（articles→crosscut→review→index→commit）、单项目串行（`serialProjects`）、并行上限（`parallelProjects`）、stale 更新、`localPlan` 顶层目录分组，均由 `index.js` 的常驻 tick 实现，本文端到端验证。
- [[codewiki-panel-endpoints]] — `/api/codewiki/jobs`、`/control`、`/repos`、`/sessions` 四个面板端点，本文用 `fakeReq`/`fakeRes` 单测回环守卫、取消、compile、refresh、workspaceOnly 过滤、孤儿接管。
- [[codewiki-agent-tools]] — `codewiki_update`/`codewiki_generate`/`codewiki_progress` 工具定义与输出 schema（`def.output.schema`），本文校验 scope 强制、透传、错误前缀改写与 schema 形态（第 310–323、1286–1323 行）。
- [[agentic-host-orchestration]] — 新通道（语义规划 / agentic 写作 / 符号级增量）的验证在 `test-agentic-host.mjs`、`test-semantic-plan.mjs`、`test-incremental*.mjs`，本文通过 `LEGACY_CHANNEL` 显式关掉它们（第 44 行）以守护旧通道。

## Known Issues

- **JOBS_FILE 随机 token（0.10.10 偶发 20 项失败根因）**：第 19–23 行注释说明，早期只用 `process.pid` 命名 JOBS_FILE，历史运行留在 tmp 的同名文件会在 pid 复用时被原样读入（里边有 `job-tmp-active` 等 fixture 任务），让「单项目串行」误判为已有项目在编译、后续提交全部 `queued`，表现为「偶发 20 项失败」。当前实现追加 `TEST_JOB_TOKEN = crypto.randomBytes(4).toString('hex')`（第 22 行）规避，并在收尾统一 `fs.rmSync(JOBS_FILE)`（第 1548 行）不留残留。
- **`makeBatchMock` 的 `bigArticle` 触发横切拆分依赖 70k 字阈值**：第 211 行 `content += '\n\n' + '长'.repeat(70000)`，这是为了让 `_architecture.md` 合成请求超单请求预算、触发观察批 map + 合成批 reduce（第 685–713 行）。若真实常量 `DEFAULT_BIG_TOKEN_BUDGET`（index.js 第 56 行，420000）被改小，该 fixture 可能不再触发拆分，断言失效——但 mock 阈值本身不读该常量，是写死的 70000。
- **并行上限块关闭串行**：第 817 行 `apply(cc2.ctx, batchCfg({ serialProjects: false, parallelProjects: 3 }))` 显式关掉单项目串行，否则默认串行会让 B 项目排队，无法验证「并行各自推进」。这是测试设计选择，非缺陷，但说明默认行为与该块断言相反。
- **`makeCtx` 的 `inject` 返回的是「ctx 切片」而非实例**：第 70–79 行注释反复强调——直传实例会掩盖 cordis 严格语义（切片当实例用，属性访问才抛 without inject）。这要求真实插件必须用 `ctx.inject` 风格编码，否则 `makeCtx` 这套 stub 测不出「未注入即抛」的问题（严格语义板块第 1502–1524 行另用 `strictCtx` 补测）。
- **`waitJob` 超时只返回当前 job 不抛**：第 240 行超时分支 `return job`，下游靠 `check(job?.stage === 'done', ...)` 显式失败。若 tick 真的挂死，`waitJob` 会在 `timeout` 后返回非终态 job，测试表现为断言失败而非卡死——但注释第 82–84 行指出，若 `ctx.effect` 被错写成 `() => service.stop()` 导致 tick 停摆，`waitJob` 会挂死超时，整套编排测试直接失败。
- **`makeBatchMock` 的 `stale` 应答必须造出 fixture 里真实存在的 `source_files`**：第 163–165 行注释说明，文章契约闸门（0.14.0，`lib/article-contract.js`）会校验 `source_files` 真实存在，所以 `answerFor` 里 `core/core.py`、`util/util.py` 是写死的，不能凭空拼——若 `makeFixtureRepo` 的目录结构变了，stale 断言会因契约闸门误判而失败。
- **`makeCtx` 默认 `agents` 无 `get`**：第 294 行主 ctx 用 `agentGet` 注入 `get`，其余场景块 `makeCtx({})` 得到的 `agents` 只有 `list`、无 `get`；`wakeCompileSession` 缺省 `agentsRef` 时静默（第 579–580 行），因此「唤醒会话」断言必须用带 `agentGet` 的 ctx。
- **测试清理依赖 `process.exit`**：第 1551 行 `process.exit(failures ? 1 : 0)`——异常不会被抛出到外层，所有清理都在 `finally` 块里做（如 `mock.restore()`、`fs.rmSync`）；Windows 下句柄延迟释放的目录用 `maxRetries`/`retryDelay`（第 1039 行）或留 tmp 自清。
