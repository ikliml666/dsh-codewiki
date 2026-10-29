---
title: test_batch
type: module
source_files:
  - test-batch.mjs
  - index.js
tags: [test, batch-orchestration, llm-mock, codewiki]
---

## Overview

`test-batch.mjs` 是 dsh-codewiki 插件里**编译批量编排与宿主 LLM 通道**的纯函数自检脚本。它没有引入任何测试框架——顶部 `check(cond, msg)` 累加 `passed`/`failures`（见 `test-batch.mjs:17-20`），`section(name)` 打印分段标题（`test-batch.mjs:21`），跑法为 `node test-batch.mjs`（要求 Node ≥20，见文件头注释 `test-batch.mjs:15`）。脚本末尾统一打印 `ALL PASS` 或 `FAIL` 并在失败时 `process.exit(1)`（`test-batch.mjs:638-642`）。

覆盖的目标全部是 `index.js` 里被批量流水线直接复用的纯函数与并发池，可被单测钉死而不依赖真实宿主 LLM：

- **输入装填与 token 估算**：`estimateTokens`（index.js:529）、`numberLines`（index.js:759）、`collectSources`（index.js:1174）、`packArticles`（index.js:1399）、`scanRepoFiles`（index.js:2074）。
- **任务装配与规划兜底**：`prepareArticleTasks`（index.js:1245）、`localPlan`（index.js:1372）。
- **并发池与宿主 LLM 通道**：`runRealtimeTasks`（index.js:671），配合 `mock llm` 服务（按 stream 协议吐块）来断言请求体与失败记账。
- **会话通道任务收割**：`classifySessionTask`（index.js:1985）、`buildSessionSteerText`（index.js:2002）。
- **行号锚点修正与信封校验**：`fixAnchors`（index.js:936）、`validateArticleEnvelope`（index.js:1162）。
- **宿主 provider/model 目录与思考档位**：`listModelCatalog`（index.js:4411）、`resolveModelEfforts`（index.js:4449）、以及经 `installWebServer`（index.js:4473）注册的 `/api/codewiki/models` 与 `/api/codewiki/model-efforts` 两个回环端点。
- **历史开关清理**：0.10.1 起删除内置百炼直连通道，断言 `resolveBatchApiKey` 不再导出（`test-batch.mjs:518-521`）。

关键测试手段：用 `makeLlm(reply)`（test-batch.mjs:174-189）按需返回字符串/函数/Error 的假流式 LLM；用 `makeSlowLlm(reply, delayMs)`（test-batch.mjs:233-243）做并发分池探针；用 `poolProbe()`（test-batch.mjs:244-259）统计在飞峰值。下面逐组件列出被测函数与测试桩的行号与用途。

## Key Components

本模块是测试脚本，组件分两类：**被测函数（来自 `index.js`）** 与 **测试本地桩/断言工具（在 `test-batch.mjs` 内）**。

### 测试本地桩与工具（`test-batch.mjs`）

- `check(cond, msg)`（test-batch.mjs:17-20）：断言工具，成功 `passed+=1` 并打印 `✓`，失败压入 `failures` 并打印 `✗`。
- `section(name)`（test-batch.mjs:21）：打印 `\n== <name> ==` 分段标题。
- `mockJson(obj, status)`（test-batch.mjs:22）：构造 `{ok, status, text}` 假 fetch 响应（本脚本未被大规模使用，主要为兼容预留）。
- `makeLlm(reply)`（test-batch.mjs:174-189）：假宿主 llm 服务。`async *stream(opts)` 先把 `opts` 压入 `llmCalls`，再按顺序 yield `block-start` / `text-delta`（内容为 `reply` 本身，或 `reply(opts)` 的返回值，或当 `reply` 是 `Error` 时 yield `finish{kind:'error', failure:{code:'MOCK_FAIL', ...}}`）/ `usage{outputTokens:64}` / `finish{kind:'stop'}`。`promptOf(opts)`（test-batch.mjs:190）从 `opts.messages[0].content[0].text` 取出首条 user 消息正文，用于断言每任务一次流式调用（`test-batch.mjs:172`）。
- `makeSlowLlm(reply, delayMs=30)`（test-batch.mjs:233-243）：带固定延迟的假流式 LLM，用于观测「同时在飞」峰值以验证分池限流（`test-batch.mjs:232-297`）。
- `poolProbe()`（test-batch.mjs:244-259）：返回 `{st, onTaskStart, onTaskEnd}`，按任务的 `bigTier` 标记分别累计 `normal`/`big` 当前值与 `peakNormal`/`peakBig` 峰值，供分池并发断言用。
- `mk(id, big)`（test-batch.mjs:260-263）：构造单条大档/默认档测试任务，`big=true` 时挂 `provider:'volces-ark'`、`model:'glm-5.3-flash'`、`bigTier:true`。

### 被测函数（来自 `index.js`）

- `estimateTokens(text)`（index.js:529-537）：粗算 token，CJK≈1/字、其余≈ceil(字符/3.5)。被断言 CJK 每字 1 token、ASCII 10 字符=3、`''`=0、混合计费（test-batch.mjs:26-29）。
- `numberLines(content)`（index.js:759-761）：每行加 `N| ` 前缀，最多去一个尾换行，空文件得 `1|`。被断言单/双尾换行、CRLF、空文件（test-batch.mjs:48-52）。
- `collectSources(cwd, files, budget=BATCH_TOKEN_BUDGET)`（index.js:1174-1201）：整文件内联装填，返回 `{text, skipped, oversized}`。预算充足不跳过；首文件即超预算返回 `oversized:true` 且原文兜底；装不下第二文件进 `skipped`（test-batch.mjs:32-45）。缺失文件在文内标注「文件不存在」（`test-batch.mjs:38`）。
- `prepareArticleTasks(tasks, opts)`（index.js:1245-1330）：装配批量请求。普通任务进 `prepared`；单文件连单请求上限都装不下转 `sessionTasks`（唯一兜底）；多文件超预算拆成 `_split/ #obsN` 观察批（`keepInMemory:true`、`splitFor`、`composePlan`）；开启大档（`bigProvider` 非空）时超预算任务改由 `bigTier` 自带的 `provider/model/reasoningEffort` 在插件内写完。断言覆盖普通/大档/会话三态、customId 顺序、prevArticle 上下文、观察批 ≤110k、（test-batch.mjs:54-133）。
- `classifySessionTask(task, nowMs)`（index.js:1985-1995）：会话通道收割三态——`timeout`（派发超 `SESSION_TASK_TIMEOUT_MS`=30min）、`harvest`（已产出且以 `---` 开头且 mtime≥派发时间）、`wait`（未产出/旧文件/写一半）。断言超时优先、三态边界（test-batch.mjs:135-150）。
- `buildSessionSteerText({job, snapshots, tier, resend})`（index.js:2002-2020）：生成会话通道派发文本。`tier` 非空时钉死 `tier: "..."` 并禁止依赖自动选路；`stage==='review'` 用校对措辞；`resend` 带「重新派发」。断言 tier 钉死、review/resend 文案、占位符已替换（test-batch.mjs:152-168）。
- `runRealtimeTasks(tasks, opts)`（index.js:671-730）：唯一执行器，按 `concurrency` 消费队列，统一走宿主 llm 服务；`signal` 用于取消；`onTaskDone` 上报 `{outputTokens, durationMs}`；大档与默认档按 `bigTier` **分池**独立限流（`bigConcurrency` 缺省跟随默认档）。返回 `Map(customId→结果)`。断言覆盖 provider/model 路由、`temperature=0`、reasoningEffort 透传（test-batch.mjs:170-209）、大档任务自带模型分派（test-batch.mjs:209-228）、分池并发峰值（test-batch.mjs:232-297）、tps 采样与取消（test-batch.mjs:299-321）、失败记账（test-batch.mjs:323-345 / 393-408）。
- `localPlan(files)`（index.js:1372-1385）：按顶层目录分组生成模块清单，根文件归 `root`，`concepts:[]`。断言分组数/文件数（test-batch.mjs:347-358）。
- `packArticles(articles, budget=BATCH_TOKEN_BUDGET)`（index.js:1399-1418）：整篇装填成功文章；后续超预算文章只装头部（截到 `## Key Components` 前）并标「仅头部」。断言首篇整篇、后续截断（test-batch.mjs:360-371）。
- `scanRepoFiles(cwd)`（index.js:2074-2097）：仓库源码扫描，应用 `SCAN_SKIP_DIRS`（index.js:2060）、`SCAN_SKIP_EXT`（index.js:2065）、`SCAN_MAX_FILE_BYTES`=256KB（index.js:2071）、`SCAN_MAX_FILES`=2000（index.js:2072）。返回 `{path, bytes}`。断言跳过 node_modules/.git/二进制/超大/空文件（test-batch.mjs:373-387）。
- `listModelCatalog(llm)`（index.js:4411-4432）：枚举宿主 provider/model，`id`/`provider` 与 `displayName`/`name` 两种写法兼容，单 provider 失败保留条目附 `error`。`llm` 未注入→`ok:false`。断言跳过无 id、映射 `{id,name}`、单 provider 失败不影响其它（test-batch.mjs:410-432）。
- `resolveModelEfforts(llm, provider, model)`（index.js:4449-4471）：走宿主 `resolveModelInfo`（兜底 `resolveModel`），解析 `reasoning.efforts`/`defaultEffort`/`context.tokens`。未知模型/未注入→`ok:false`。断言档位数、默认档、描述、上下文、缺档位（test-batch.mjs:464-494）。
- `installWebServer(ctx, service, extra)`（index.js:4473-4768）：注册面板回环端点。本测试只验证 `/api/codewiki/models`（index.js:4908-4923）与 `/api/codewiki/model-efforts`（index.js:4927-4947）：回环 200、非回环 403、参数缺失 400（test-batch.mjs:434-462 / 496-516）。
- `fixAnchors(content, cwd)`（index.js:946-1163）：落盘前把 `file:NN(-MM)` 锚点对照源码确定性校正；`source_files` 之外不碰；多锚点行各自就近绑定；倒序区间翻正；CRLF 保真。返回 `{text, fixed, unresolved}`。断言覆盖错行号修正、未找到/歧义不动、区间钳制、倒序区间、basename 匹配、多锚点不拉平、已正确原样（test-batch.mjs:523-603）。
- `validateArticleEnvelope(content)`（index.js:1162-1169）：文章信封校验，缺开头 `---`→「缺 frontmatter」，结束 `---` 非独占行→「未闭合」，合格返回 `null`。断言正常/CRLF/空串/null/非字符串/未闭合/正文分隔线不动（test-batch.mjs:605-636）。

### 关键常量（来自 `index.js`，被测试间接引用）

- `BATCH_TOKEN_BUDGET = 110000`（index.js:753）：单请求默认输入 token 预算。
- `BATCH_TOKEN_HARD_LIMIT = 128000`（index.js:758）：超预算兜底装填上限（大档未开时）。
- `SESSION_TASK_TIMEOUT_MS`（index.js:1823）：会话通道超时（默认 30min，`classifySessionTask` 用之）。
- `DEFAULT_BIG_PROVIDER='volces-ark'` / `DEFAULT_BIG_MODEL='glm-5.3-flash'`（index.js:53-54）：大档模型默认档，测试 `BIG` 配置（test-batch.mjs:110）与之呼应。

## Architecture

`test-batch.mjs` 不调用真实宿主 LLM——它用一个**进程内的假流式 llm 服务**（`makeLlm`/`makeSlowLlm`）替换 `runRealtimeTasks` 的 `llm` 参数，从而断言请求体（`provider`/`model`/`reasoningEffort`/`temperature`/首条 user 消息）与失败记账路径。被测的纯函数（装填/规划/锚点/信封/目录）则直接调用，不依赖通道。`installWebServer` 端点测试用一个 `fakeCtx.inject` 把 `webServer.register` 收集进 `Map`，再以 `fakeLlmSvc` 喂数据，用假 `res` 对象（`writeHead`/`end`）回环验证 200/400/403。

```text
┌───────────────────────── test-batch.mjs (纯函数自检) ─────────────────────────┐
│                                                                                │
│  estimateTokens/numberLines/collectSources ──► index.js:装填与行号前缀          │
│  prepareArticleTasks ──► 装配 prepared[普通/大档] + sessionTasks[兜底]          │
│  localPlan / packArticles / scanRepoFiles ──► 规划与横切装填                    │
│  classifySessionTask / buildSessionSteerText ──► 会话通道收割与 steer           │
│  fixAnchors / validateArticleEnvelope ──► 锚点修正与信封闸门                    │
│  listModelCatalog / resolveModelEfforts ──► 宿主目录与思考档位                  │
│                                                                                │
│  ┌── runRealtimeTasks(tasks, {llm=FAKE, ...}) ── index.js:681 ──┐               │
│  │   分池: bigTier? 大档池(bigConcurrency) : 默认档池(concurrency)│              │
│  └─────────────────────► ► 调用 llm.stream(opts) ◄──┐           │               │
│                                                      │           │               │
│  makeLlm / makeSlowLlm (假流式服务) ───────────────┘  yield block/text/finish    │
│  poolProbe / onRequestStart ── 探针: peakNormal / peakBig                       │
│                                                                                │
│  installWebServer ──► fakeCtx.inject ──► webServer.register ──► /api/codewiki/* │
│       │                                                                         │
│       └──► fakeLlmSvc ── listModelCatalog / resolveModelEfforts ──► 回环 res    │
└────────────────────────────────────────────────────────────────────────────────┘
```

组件≥3、流程非平凡，故画框图。核心关系是「测试桩替换 `llm` → `runRealtimeTasks` 分池消费 → 假流式服务吐块 → 结果落 `Map`/`notes`」，以及 `installWebServer` 端点经 `fakeCtx`/`fakeLlmSvc` 回环验证。

## Data Flow

### 1. 任务装配 → 并发池 → 假 LLM（写文章主路径，test-batch.mjs:54-209）

1. `prepareArticleTasks(plainTasks, {cwd, language})`（index.js:1245）按 `collectSources` 装填源码生成 `batchPrompt`，给每条普通任务分配 `customId`（`t0`/`t1`/`t2`，test-batch.mjs:69），全部进 `prepared`、`sessionTasks` 为空。
2. 任务带 `articlePath` 的走 `runRealtimeTasks` 落盘；带 `keepInMemory:true` 的（如 `_mem`，test-batch.mjs:193）只带回 `content`。
3. `runRealtimeTasks`（index.js:671）按 `bigTier` 分池（默认档 `concurrency` / 大档 `bigConcurrency`），每任务调一次 `llm.stream(opts)`：`opts.provider/model` 默认取自参数，任务自带 `provider+model` 时以任务为准；`reasoningEffort` 透传；`temperature` 固定 0（test-batch.mjs:201-204）。
4. 假 `makeLlm` 吐块后，`applyTaskResult`（index.js:633）把结果写入 `Map(customId→{ok, stopReason, content?})`，失败原因推入 `notes`（test-batch.mjs:343）。

### 2. 大档接管超长输入（test-batch.mjs:108-132）

- 单文件超 `BATCH_TOKEN_HARD_LIMIT=128k` 但装得进大档预算（420k，`BIG.bigBudget`）：`prepareArticleTasks` 不再转会话通道，给任务打 `bigTier:true` 并自带 `provider/model/reasoningEffort`，仍进 `prepared`（index.js:1246）。
- 大档关闭（`bigProvider:''`）：超 128k 退回 `sessionTasks`（唯一兜底，test-batch.mjs:123-126）。

### 3. 多文件超预算 → 观察批→合成（test-batch.mjs:87-106）

- 模块源码总量超单请求预算：`prepareArticleTasks`（index.js:1245-1275）按文件逐批装填，拆出 `N≥2` 个 `#obsN` 观察批（`keepInMemory:true`、`keepInMemory` 标记、`splitFor='modules/splitme.md'`、`composePlan.articlePath/mission`），每批 prompt ≤110k，待收割后合成完整文章。

### 4. 会话通道收割三态（test-batch.mjs:135-168）

- `classifySessionTask`（index.js:1985）：派发超 30min→`timeout`；已产出且 `---` 开头且 mtime≥派发时间→`harvest`；否则→`wait`（超时判定优先）。
- `buildSessionSteerText`（index.js:2002）：`tier` 非空时文本钉死 `tier: "..."` 并要求显式 `delegate`、禁止自动选路；`stage==='review'` 用校对措辞；`resend` 带「重新派发」。

### 5. 目录/思考档位端点回环（test-batch.mjs:434-516）

- `installWebServer`（index.js:4473）经 `fakeCtx.inject(['webServer'])` 把 `/api/codewiki/models`、`/api/codewiki/model-efforts` 收进 `Map`；用 `fakeLlmSvc` 跑通 `listModelCatalog`/`resolveModelEfforts`，并以 `fakeLlmSvc` 喂数据验证回环 200 / 非回环 403 / 缺参 400。

### 6. 锚点修正与信封闸门（test-batch.mjs:523-636）

- `fixAnchors`（index.js:936）：读 frontmatter 的 `source_files`（经 `parseSourceFiles`，index.js:1666），逐行把 `file:NN(-MM)` 对照源码确定性校正，多锚点行各自就近绑定、倒序区间翻正、`CHANGELOG` 锚点按版本节重定位（`fixChangelogAnchors`，index.js:789）；`source_files` 之外不碰，未找到/歧义只记 `unresolved`。
- `validateArticleEnvelope`（index.js:1162）：落盘前闸门，只查开头 `---` 与结束 `---`（独占行），挡住半截 frontmatter 的静默失效。

## Connections

- [[index]] — 本测试直接验证的 `index.js` 全部被测纯函数与并发池的源头模块。
- [[articles-agentic]] — `runAgenticArticles`/`markBigAgenticTasks`（`lib/articles-agentic.js`）与 `prepareArticleTasks` 共享 `bigTier` 持久化模型通道的语义；批量通道与 agentic 通道都经 `runRealtimeTasks` 同一个并发池。
- [[engine-bridge]] / 宿主 llm 服务 — `runRealtimeTasks` 的 `llm` 参数即宿主 `dsh-llm` 服务的 `stream` 接口；`listModelCatalog`/`resolveModelEfforts` 读的是宿主 `listProviders`/`resolveModelInfo`。
- [[update-planner]] / [[incremental]] — `localPlan`（index.js:1372）是 `planMode:'dirs'` 时的兜底规划路径，与 `semanticPlan`（index.js:1412）互为降级关系。
- [[wiki-anchors]] / [[test-wiki-anchors]] — `fixAnchors` 的符号绑定规则与 `test-wiki-anchors.mjs` 校验器同源（见 index.js:936 注释），本测试钉住修正器行为。
- [[article-contract]] — `applyTaskResult`（index.js:633）落盘前过 `contractCheck`（index.js:590），`validateArticleEnvelope` 是更前置的信封闸门。

## Known Issues

- **`runRealtimeTasks` 与真实宿主 LLM 的退避/重试不在本测试覆盖**：测试用 `makeLlm` 一击成功或一击 `finish{kind:'error'}`，未覆盖 `llmChat`（index.js:547）里「`UNSUPPORTED_REASONING_EFFORT` 剥 effort 重试一次」的分支（index.js:562-566），也未按真实并发重试失败任务。
- **`prepareArticleTasks` 的 `composePlan` 合成路径未被端到端验证**：测试只断言观察批被拆出（test-batch.mjs:98-104），未真正跑 `batchArticleComposePrompt`（index.js:1501）合成那一步；合成由其它测试/真实流水线覆盖。
- **`scanRepoFiles` 上限 2000 文件未测边界**：`SCAN_MAX_FILES`（index.js:2072）只在 walk 内 `out.length >= SCAN_MAX_FILES` 早退（index.js:2074），测试仅用 1 个有效文件断言黑名单（test-batch.mjs:384-386），未构造 2000 文件验证截断行为。
- **未显式测 `repairUnclosedFrontmatter`（index.js:914）**：`fixAnchors` 在 frontmatter 未闭合时会调用它（index.js:936），但 `test-batch.mjs` 的 fixAnchors 用例全用闭合 frontmatter，未单独钉「半截 frontmatter 自动补全」分支（index.js:951 注释里提到的真实缺陷场景）。
- **大档 `bigConcurrency` 为 0 的回落**：test-batch.mjs:284-297 用 `followTasks` 验证 `bigConcurrency` 缺省跟随默认档，但 `runRealtimeTasks` 内 `bigLimit` 回落到 `concurrency`（index.js:101-104）与 `liveConfig` 的 `bigConcurrency:0`（index.js:99）两处语义需同时正确，测试只验证了前者。
- **`installWebServer` 其余端点未测**：本测试只覆盖 `/api/codewiki/models` 与 `/api/codewiki/model-efforts`；`/api/codewiki/jobs`、`/api/codewiki/repos`、`/api/codewiki/sessions`、`/api/codewiki/control` 由其它测试或面板集成覆盖。
