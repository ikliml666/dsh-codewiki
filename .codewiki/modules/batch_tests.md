---
title: batch_tests
type: module
source_files:
  - test-batch.mjs
  - index.js
tags: [test, batch, mock, self-check, concurrency-pool]
---

## Overview

`modules/batch_tests` 的实体就是 `test-batch.mjs`——一份**编译执行链自检**脚本（Node ≥20，`node test-batch.mjs` 直接跑，无需测试框架）。它把 `index.js` 的「批量编译流水线」里所有纯函数与唯一的宿主 llm 通道（`runRealtimeTasks`）端到端钉一遍：源码装填 → token 估算 → 任务装配 → 本地规划 → 横切装填 → 仓库勘探 → 会话通道收割 → 大档模型分派 → 模型目录/思考档位端点。

文件头注释（1|–3|）点明它的两个职责：

1. 纯函数自检：`collectSources` / `classifySessionTask` / `estimateTokens` / `fixAnchors` / `numberLines` / `buildSessionSteerText` / `prepareArticleTasks` / `runRealtimeTasks` / `localPlan` / `packArticles` / `scanRepoFiles` / `listModelCatalog` / `resolveModelEfforts` / `installWebServer` / `validateArticleEnvelope`。
2. mock 宿主 llm 服务：用普通异步生成器模拟宿主 `llm.stream` 协议（block-start / text-delta / usage / finish），验证并发池、取消信号、失败记账、思考档位下发、大档与默认档分池限流。

脚本顶部（24| 起）按编号分段：`estimateTokens` → `collectSources` → `numberLines` → `prepareArticleTasks`（含 oversized 拆分、大档接管、会话通道兜底）→ `classifySessionTask` 三态 → `buildSessionSteerText` 档位钉死 → `runRealtimeTasks`（并发池 / 大档混合池 / 分池限流 / tps / 取消 / 失败记账）→ `localPlan` → `packArticles` → `scanRepoFiles` → `listModelCatalog` → `/api/codewiki/models` 端点 → `resolveModelEfforts` → `/api/codewiki/model-efforts` 端点 → 删除内置百炼直连通道（`resolveBatchApiKey` 不再导出，521|）→ `fixAnchors`（行号锚点确定性修正，数十种边界）→ `validateArticleEnvelope`（frontmatter 信封校验）。

跑法结论由 638| 打印：`ALL PASS` 或 `FAIL`，失败项逐条列出，`process.exit(1)`。

## Key Components

测试脚本 `test-batch.mjs` 自身只包含一个断言框架与若干 mock，真正的被测单元全部来自 `index.js`。下面按脚本引用顺序列出每个被测函数/常量（行号取自 `index.js` 的「行号| 」前缀）与测试内定义的 helper/mock。

### 被测纯函数（来自 `index.js`）

- `estimateTokens(text)` — `index.js:449` 起（449|–457|）。粗算 token：CJK ≈ 1 token/字，其余按 `3.5 字符/token` 向上取整。测试在 26|–29| 钉了 4 条：`中文`=2、ASCII 10 字符=3、`''`=0、混合=4。
- `numberLines(content)` — `index.js:679` 起（679|–681|）。每行加 `N| ` grep 前缀，尾部至多去一个换行。测试 49|–52| 钉：单尾换行、双尾空行保留 `2| `、CRLF 剥离 `\r`、空文件输出 `1|`。
- `collectSources(cwd, files, budget)` — `index.js:1094` 起（1094|–1121|）。按 token 预算整文件内联，返回 `{ text, skipped, oversized }`。测试 32|–45| 覆盖：内联带相对路径标题与行号前缀（37|）、缺失文件文内标注（38|）、预算充足无跳过（39|）、首文件即超预算 → `oversized`（42|）、第二文件装不下 → `skipped`（45|）、尾换行只去一个（40|）。
- `prepareArticleTasks(tasks, opts)` — `index.js:1165` 起（1165|–1250|）。把通用任务装配成批量请求，处理 oversized 拆分、观察→合成批、大档接管、会话通道兜底。测试覆盖：
  - 普通任务全进 `prepared`（68|–72|），`customId` 按序（69|），prompt 含 mission/language/源码（70|–72|）；
  - 旧文作上下文（77|）；单文件超 110k 但装得进 128k 大档 → 大档单请求（79|–82|，0.10.2 起不再转会话通道）；单文件连 128k 都装不下 → 会话通道唯一兜底（83|–85|）；
  - 多文件超预算 → 观察批分割（87|–106|）：拆 ≥2 个 `#obsN` 批、`keepInMemory`、`splitFor` 指向所属文章、`composePlan` 携带 `articlePath`/`mission`、prompt 标注批次序号；
  - 大档模型（0.10.4，108|–132|）：超 128k 改由 `bigProvider`/`bigModel` 在插件内写完（带 `bigTier`/`provider`/`model`/`reasoningEffort`），关掉大档退回会话通道，普通任务不被标大档。
- `classifySessionTask(task, nowMs)` — `index.js:2032` 起（2032|–2042|）。会话通道任务收割三态。测试 135|–149| 钉：`timeout`（派发超 30 分钟，且优先于「已产出」）、`harvest`（派发后产出且 frontmatter 开头）、`wait`（写一半无 frontmatter / 旧文件未更新）。
- `buildSessionSteerText({ job, snapshots, tier, resend })` — `index.js:2049` 起（2049|–2067|）。会话通道 steer 文本，`tier` 非空时钉死档位。测试 153|–168| 钉：未填 tier 不提档位、填了 `tier: "codeiwiki"` 且明确禁止自动选路、任务/目标路径写入、review 阶段措辞、重发文案、未填档位的重发不提档位。
- `runRealtimeTasks(tasks, opts)` — `index.js:591` 起（591|–650|）。唯一执行器/并发池。测试覆盖：
  - 每任务一次流式调用、`provider`/`model`/`reasoningEffort`/`temperature=0` 下发（200|–204|，171| 段）；
  - 大档任务按自带 `provider`/`model`/`reasoningEffort` 路由、普通任务走默认档（208|–228|，混合池）；
  - 大档与默认档并发分池（232|–297|）：`concurrency=2`/`bigConcurrency=1` 峰值总 3，`bigConcurrency` 缺省跟随默认档（232| 段、`poolProbe` 在 244|）；
  - tps 采样与取消：`onTaskDone` 上报 `outputTokens`/`durationMs`（306|–309|）、`signal` 已 abort 时不再消费剩余任务（311|–321|）；
  - 失败记账：失败进 `notes` 不中断其他任务、失败任务不落盘（323|–345|）、`finish kind=error` 透传错误码（393|–408|）。
- `localPlan(files)` — `index.js:1300` 起（1300|–1313|）。按顶层目录分组生成模块清单。测试 348|–358| 钉：按顶层目录分组（src/root/docs）、src 收 2 文件、根文件归 root、不造概念。
- `packArticles(articles, budget)` — `index.js:1409` 起（1409|–1428|）。横切输入整篇装填，超预算装头部并标注。测试 361|–371| 钉：预算内首篇整篇、后续超预算只装头部（`仅头部`）、头部含 frontmatter 与 Overview。
- `scanRepoFiles(cwd)` — `index.js:2121` 起（2121|–2144|）。仓库源码扫描，带黑名单目录/后缀/256KB 上限/2000 文件上限（常量 2107|–2119|）。测试 373|–387| 钉：只收有效源码，跳过 `node_modules`/`.git`/二进制/超大/空文件，`bytes` 为文件大小。
- `listModelCatalog(llm)` — `index.js:4265` 起（4265|–4286|）。宿主 provider/model 目录：兼容 `id`/`provider`、`displayName`/`name`，单 provider 失败保留并附 error，llm 未注入 → `ok:false`（410|–432| 段）。
- `resolveModelEfforts(llm, provider, model)` — `index.js:4303` 起（4303|–4325|）。思考档位从 `resolveModelInfo` 读取。测试 464|–516|：`ok:true` 解析出 3 档位 + 默认档 + 上下文长度、未知模型/llm 未注入诚实报错、模型未声明档位 → 空列表。
- `installWebServer(ctx, service, extra)` — `index.js:4327` 起（4327|–4622|）。注册回环面板端点。测试 434|–462| 验证 `/api/codewiki/models`（回环 200 + 非回环 403）；465|–516| 验证 `/api/codewiki/model-efforts`（回环 200 + 缺参数 400 + 非回环 403）。
- `validateArticleEnvelope(content)` — `index.js:1082` 起（1082|–1089|）。frontmatter 信封校验，返回 null 合格否则原因短语。测试 605|–636| 钉：正常闭合/前置空行/CRLF/只有 frontmatter 均合格；缺开头 `---`、null、非字符串、未闭合均判失败（且不抛错）。
- `fixAnchors(content, cwd)` — `index.js:856` 起（856|–1073|）+ 配套 `parseSourceFiles`（`index.js:1676`）、`changelogSections`/`fixChangelogAnchors`（699|–825|）、`repairUnclosedFrontmatter`（834|–854|）。行号锚点确定性修正。测试 523|–603| 用 `faRoot`（`fs.mkdtempSync`，525|）造 `a.js`/`src/b.js`/`dup2.js` 覆盖数十种边界：错行号修正、起点含符号不动、符号未找到不动、歧义不动、取声明行、区间锚点、尾越界钳制、倒序区间翻正、basename 多段路径匹配、CRLF 保真、无 frontmatter 原样、同行多锚点各自就近绑定、多锚点行「已正确」判定用已占用符号挡。
- 常量/开关：`BATCH_TOKEN_BUDGET`（`index.js:663`）=110000、`BATCH_TOKEN_HARD_LIMIT`（`index.js:668`）=128000、`SESSION_TASK_TIMEOUT_MS`（`index.js:1881`）、`DEFAULT_BIG_PROVIDER`（`index.js:49`）/`DEFAULT_BIG_MODEL`（`index.js:50`）/`DEFAULT_BIG_TOKEN_BUDGET`（`index.js:52`）。

### 测试内 mock 与 helper（定义在 `test-batch.mjs`）

- `check(cond, msg)` — `test-batch.mjs:17|–20|`。断言：通过 `passed++` 打印 `✓`，失败 push `failures`。
- `section(name)` — `test-batch.mjs:21|`。打印分段标题 `== name ==`。
- `mockJson(obj, status)` — `test-batch.mjs:22|`。构造 `{ ok, status, text }` 假响应（测试未直接用它驱动 `runRealtimeTasks`，后者走真正的 `llm.stream` 生成器）。
- `makeLlm(reply)` — `test-batch.mjs:174|–189|`。**核心 mock llm 服务**：实现 `async *stream(opts)`，把 `opts` push 进 `llmCalls`，按 `block-start → text-delta → usage → finish` 协议吐块；`reply` 可为字符串、函数（拿 `opts` 返回文本）或 `Error`（`finish.kind='error'`）。
- `promptOf(opts)` — `test-batch.mjs:190|`。从 `opts.messages[0].content[0].text` 取 prompt，配套 `kmTasks`（191|）。
- `makeSlowLlm(reply, delayMs)` — `test-batch.mjs:233|–243|`。带 `setTimeout` 延迟的 mock llm，供分池限流峰值探测。
- `poolProbe()` — `test-batch.mjs:244|–259|`。返回 `{ st, onTaskStart, onTaskEnd }`，按任务 `bigTier` 分别累计 `normal`/`big` 在飞数及峰值。
- `mk(id, big)` — `test-batch.mjs:260|–263|`。构造带 `keepInMemory` 的任务，可选大档标记。

## Architecture

`test-batch.mjs` 是自包含自检：左侧是被测的 `index.js` 纯函数链，右侧是用 mock llm 注入的并发池执行器。框图（组件名：文件#行号）：

```text
 test-batch.mjs (node test-batch.mjs)
 ┌──────────────────────────────────────────┐      ┌─────────────────────────────────┐
 │ 纯函数链自检                               │      │ 并发池通道自检                  │
 │  estimateTokens  449                      │      │  makeLlm / makeSlowLlm  174/233 │
 │  numberLines     679                      │      │  mock llm.stream 协议           │
 │  collectSources  1094                     │      │   (block/text/usage/finish)     │
 │  prepareArticleTasks 1165  ──emitSingle──►│      │        │ inject                  │
 │    ├─ markBig 1177 (大档接管)              │      │        ▼                       │
 │    └─ emitSession (会话通道兜底)           │      │  runRealtimeTasks  591          │
 │  classifySessionTask 2032 (三态)          │      │   ├ 默认档池 limit=maxConc      │
 │  buildSessionSteerText 2049 (档位钉死)    │      │   └ 大档池  limit=bigConc       │
 │  localPlan        1300                    │      │        │ llmChat 467            │
 │  packArticles      1409                   │      │        ▼                       │
 │  scanRepoFiles     2121                   │      │  applyTaskResult 553           │
 │  listModelCatalog  4265                   │      │   (落盘 / keepInMemory)        │
 │  resolveModelEfforts 4303                 │      └─────────────────────────────────┘
 │  installWebServer  4327 ──/api/codewiki/*─┘
 │  validateArticleEnvelope 1082             │
 │  fixAnchors        856 (行号锚点修正)      │
 └──────────────────────────────────────────┘
          │ 失败 → failures[] → 638| 打印 + exit(1)
          ▼
  ALL PASS / FAIL
```

并发池双池结构（`runRealtimeTasks`，591|–650|）：`prepareArticleTasks` 给任务打 `bigTier` 标记，`runRealtimeTasks` 按标记分进两个独立限流的池（`normalTasks`/`bigTasks`，596|–611|），各自 `Math.min(limit, 长度)` 个 worker 并发，两池同时推进（648|）。

## Data Flow

1. **纯函数输入流**：`test-batch.mjs` 用 `fs.mkdtempSync` 造临时仓库（`tmpRoot` 33|、`workRoot` 56|、`sessDir` 136|、`scanRoot` 375|、`faRoot` 525|），写入 `.ts`/`.js` 假文件，再喂给 `collectSources`/`scanRepoFiles`/`fixAnchors` 等，断言返回结构（`text`/`skipped`/`oversized`/`fixed`/`unresolved`）。
2. **任务装配流**：`plainTasks`（61|）/`withPrev`（76|）/`splitPrep`（92|）构造任务对象 → `prepareArticleTasks` 产出 `prepared` + `sessionTasks` → 断言 `customId`/`batchPrompt`/`bigTier`/`splitFor`/`composePlan`。
3. **并发池执行流**：`makeLlm` 生成的流式块经 `runRealtimeTasks` → 内部 `llmChat`（467|）消费 `llm.stream` → `applyTaskResult`（553|）落盘或带回 `content`（`keepInMemory`）→ 收集进 `Map(customId → 结果)` 返回。失败统一 push `notes`。
4. **端点回环流**：`installWebServer` 经 `ctx.inject(['webServer'], ...)` 注册到 `routes` Map（438|/498|），`handler(req, res)` 用假 `res.writeHead`/`res.end(JSON.parse)` 跑通，断言回环 200、缺参 400、非回环 403。

## Connections

- [[index]] — 全部被测单元的实现文件（编译执行链总入口）。
- [[engine-bridge]] — 宿主 llm 服务通道（`llm.stream`/`resolveModelInfo`）的桥接层，`runRealtimeTasks` 与之对接。
- [[orchestration]] — 生产侧 `prepareArticleTasks` → `runRealtimeTasks` 的编排消费方（`submitBatchFor`/`tickArticles`）。
- [[wiki-anchors]] — `fixAnchors` 的契约校验伙伴：`test-wiki-anchors.mjs` 与本题同源符号绑定规则。
- [[articles-agentic]] — agentic 写作通道（与批量通道并列的第二条路径，`startAgenticRun`/`markBigAgenticTasks`）。

## Known Issues

- **`resolveBatchApiKey` 已删除**（0.10.1）：测试 518|–521| 显式断言 `mod.resolveBatchApiKey === undefined`，确认不再导出内置百炼直连通道的凭证解析链——插件不碰任何密钥。
- **大档未配置时单文件超 128k 仍走会话通道兜底**：`prepareArticleTasks` 仅在 `bigProvider` 非空时启用大档（`bigTier` 在 1169|），否则 `singleLimit` 退到 `BATCH_TOKEN_HARD_LIMIT`（1190|），连 128k 都装不下才 `emitSession`（1208|）。
- **`fixAnchors` 的「已正确」判定依赖起始行含符号的宽松规则**：单锚点行起始行提到该符号即认可（600|），与多锚点行用 `used` 占用 + 就近排序的护栏（1002|–1009|）不一致——这是有意为之，避免改写全仓既有锚点，但需注意单/多锚点不一致的边界（见 582|–601| 的大段注释）。
- **`installWebServer` 端点依赖 `ctx.inject`**：测试用假 `inject`（439|/499|）注入假 `webServer`/`llm`，非回环请求靠 `isLoopbackRequest`（4229|，解析 `req.socket.remoteAddress`）拦截；真宿主环境下 `webServer` 缺失则 `inject` 回调整体跳过（4360|），面板查不到进度但不报错。
