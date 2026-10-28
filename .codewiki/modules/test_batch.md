---
title: test_batch
type: module
source_files:
  - test-batch.mjs
  - index.js
tags: [test, batch, orchestration, concurrency]
---

## Overview

`test-batch.mjs` 是 dsh-codewiki 插件的编译执行链自检脚本，跑法为 `node test-batch.mjs`（Node ≥20，见 `test-batch.mjs` 第 1–3 行）。它不经由宿主，而是直接从 `./index.js` 导入纯函数与并发执行器，用 Node 内置 `fs`/`os`/`path` 在临时目录里搭真实小仓库，再用 `makeLlm` / `makeSlowLlm` 这类 fake llm 服务（实现 `stream()` 协议）喂入确定性响应，逐一断言每一段编译逻辑的正确性。

覆盖的能力分为两半：

- **纯函数自检**（无需模型通道即可验证）：`estimateTokens`（第 26–29 行）token 粗算、`collectSources`（第 32–45 行）源码内联与 token 预算、`numberLines`（第 47–52 行）行号前缀、`prepareArticleTasks`（第 54–132 行）任务装配与 oversized/大档/观察批分割、`classifySessionTask`（第 135–150 行）会话通道三态收割、`buildSessionSteerText`（第 153–168 行）档位钉死、`localPlan`（第 348–358 行）本地规划、`packArticles`（第 361–371 行）横切装填、`scanRepoFiles`（第 374–387 行）仓库勘探黑名单、`fixAnchors`（第 524–603 行）行号锚点确定性修正、`validateArticleEnvelope`（第 608–636 行）frontmatter 信封校验。
- **mock 宿主 llm 通道自检**：`runRealtimeTasks`（第 171–345 行 等）宿主 llm 唯一通道、请求体路由、思考档位下发、大档混合池分池限流、外部 signal 中止、并发池失败记账；外加 `listModelCatalog`（第 411–432 行）、`resolveModelEfforts`（第 464–516 行）设置页级联下拉数据源、`installWebServer`（第 435–462 行、第 496–516 行）注册 `/api/codewiki/models` 与 `/api/codewiki/model-efforts` 回环端点；以及 0.10.1 删除内置百炼直连通道的回归（第 519–521 行）。

测试框架由 `check(cond, msg)`（第 17–20 行）统计通过/失败、`section(name)`（第 21 行）打印分组标题、末尾统一输出 `ALL PASS` 或 `FAIL`（第 638–642 行）。

## Key Components

下列是本测试脚本断言所覆盖的 `index.js` 公共函数，以及它们在 `test-batch.mjs` 中的断言区间。

### `estimateTokens(text)` — `index.js:449`
CJK 字符按 1 token/字、其余按 `ceil((len-cjk)/3.5)` 粗算。测试 `test-batch.mjs:26-29` 钉了四种情形：纯中文 `中文`→2、纯 ASCII 10 字符→3、空串→0、混合 `中文abcdef`→4（CJK 2 + ceil(5/3.5)=2）。

### `numberLines(content)` — `index.js:679`
每行加 `N| ` 前缀（grep 风格），尾部至多去一个换行。测试 `test-batch.mjs:49-52` 覆盖单尾换行、双尾换行（第二空行真实保留为 `2| `）、CRLF 剥离、空文件输出 `1|`。

### `collectSources(cwd, files, budget)` — `index.js:1094`
按 token 预算整文件内联源码，返回 `{ text, skipped, oversized }`。缺失文件在文内标注 `文件不存在或读取失败`（第 1104 行）。预算内无跳过、首文件即超预算返回 `oversized:true` 且原文兜底、第二文件装不下则进 `skipped`（第 1107–1120 行）。测试 `test-batch.mjs:32-45`。

### `prepareArticleTasks(tasks, opts)` — `index.js:1165`
把通用任务（sources+mission+可选 prevArticle）装配成批量请求：内联源码、拼 prompt、分配 `customId`，返回 `{ prepared, sessionTasks }`。
- 普通任务全部进 `prepared`（第 68 行），`customId` 按序分配（第 69 行），prompt 含 mission/语言/源码（第 70–72 行），旧文作上下文进 prompt（第 77 行）。
- 单文件超 110k 普通预算但装得进 128k 大档 → 0.10.2 起不再误转会话通道，直接用大档单请求插件内写完（第 78–82 行）。
- 单文件连 128k 大档都装不下 → `sessionTasks`（第 83–85 行）。
- 多文件超预算 → 按普通预算逐文件拆成多个 `#obs` 观察批（`keepInMemory`、`splitFor`、`composePlan`）（第 87–106 行）。
- 大档模型（0.10.4，`BIG` 常量见第 110 行）：超 128k 不再交会话模型，`bigTier:true` 带自带 `provider/model/reasoningEffort`，prompt 介于 128k–420k（第 108–132 行）。
内部调用 `batchArticlePrompt`（第 1125 行）、`batchArticleObservePrompt`（第 1491 行）、`markBig`（第 1177 行）。

### `classifySessionTask(task, nowMs)` — `index.js:2032`
会话通道任务收割纯函数，三态：`timeout`（派发超 `SESSION_TASK_TIMEOUT_MS` 默认 30 分钟）、`harvest`（文件已产出、mtime ≥ 派发时间、以 `---` 开头）、`wait`（其余）。测试 `test-batch.mjs:135-150` 逐项钉死：超时优先于已产出、`wait` 含「写一半无 frontmatter」与「目标文件早于派发时间」。

### `buildSessionSteerText({ job, snapshots, tier, resend })` — `index.js:2049`
会话通道 steer 文本。`tier` 非空时文本要求显式传 `tier: "..."` 并禁止依赖自动选路（第 2051–2053 行、2072）；`review` 阶段用校对措辞（第 2059–2062 行）；`resend` 带「重新派发」文案（第 2056–2058 行）。测试 `test-batch.mjs:153-168` 覆盖以上分支及占位符无残留。

### `runRealtimeTasks(tasks, opts)` — `index.js:591`
唯一执行器：按 `concurrency`/`bigConcurrency` 双池并发消费任务队列，全部走宿主 llm 服务，返回 `Map(customId → {ok, stopReason, content?})`。
- 每任务一次流式调用、按所选 `provider/model/routingEffort` 路由、`temperature` 固定 0（第 200–204 行）。
- `keepInMemory` 任务结果带 `content`、磁盘任务落盘（第 205–206 行）。
- 混合池：大档任务按自带 `provider/model/effort` 路由，普通任务走默认档（第 209–228 行）。
- 分池限流（0.12.2）：`bigConcurrency` 单独限、与默认档同时推进，总峰值 = 两者之和；`bigConcurrency` 缺省=跟随默认档（第 232–297 行）。
- `onTaskDone` 上报 `outputTokens/durationMs`（第 299–309 行）；外部 `AbortController.signal` 已 abort 即不再消费任务（第 311–321 行）。
- 失败记账：单任务失败进 `notes`、不中断其它任务、失败任务不落盘（第 323–345 行、第 393–408 行），`finish.kind==='error'` 的 `code` 透传进 notes（第 398、406–407 行）。
测试里的 fake llm：`makeLlm(reply)`（第 174 行，reply 可为字符串/函数/Error）、`makeSlowLlm(reply, delayMs)`（第 233 行）、`poolProbe()`（第 244 行，统计在飞峰值）、`promptOf(opts)`（第 190 行，取首条 user 消息文本）。

### `localPlan(files)` — `index.js:1300`
按顶层目录分组生成模块清单（0.10.7 起唯一规划路径），根文件归 `root` 组（第 1304 行），不造 concept。测试 `test-batch.mjs:349-358` 验证分组数、组内文件、root 归属、concepts 为空。

### `packArticles(articles, budget)` — `index.js:1409`
横切输入装填：预算内整篇装填（`#### name`），超预算后续文章只截头部（到 `## Key Components` 为止）并标注「仅头部」。测试 `test-batch.mjs:361-371`。

### `scanRepoFiles(cwd)` — `index.js:2121`
仓库源码扫描：黑名单目录 `SCAN_SKIP_DIRS`（第 2107 行）、二进制后缀 `SCAN_SKIP_EXT`（第 2112 行）、单文件 256KB（`SCAN_MAX_FILE_BYTES` 第 2118 行）、总数 2000、空文件跳过，返回 `{ path, bytes }`。测试 `test-batch.mjs:374-387` 验证只收有效源码。

### `fixAnchors(content, cwd)` — `index.js:856`
行号锚点确定性修正（第四层兜底），返回 `{ text, fixed, unresolved }`。先修未闭合 frontmatter（`repairUnclosedFrontmatter` 第 834 行），再修 CHANGELOG 锚点（`fixChangelogAnchors` 第 709 行），最后按 `source_files` 解析符号归属。测试 `test-batch.mjs:524-603` 钉了大量边界：错行号修正、起点含符号视为已正确、符号未找到记 unresolved、歧义不动、声明行取准、区间锚点钳到文件尾、倒序区间翻正、basename 歧义不碰、CRLF 保真、无 frontmatter 原样、多锚点行各自就近绑定不拉平、已正确判定用「已占用」符号挡。

### `validateArticleEnvelope(content)` — `index.js:1082`
文章信封校验：返回 `null` 合格，否则返回原因短语。结束 `---` 必须独占一行（第 1087 行）。测试 `test-batch.mjs:608-636` 覆盖闭合合格（含 CRLF、空行缩进、只有 frontmatter 无正文）、缺 frontmatter、未闭合、正文内 `---` 不影响判定、非字符串/null 不抛错。

### `listModelCatalog(llm)` — `index.js:4265`
设置页级联下拉数据源：枚举宿主 llm 的 provider 及其模型，兼容 `id/provider`、`displayName/name` 两种写法（第 4271–4273 行），单 provider 的 `listModels` 抛错不连坐、条目保留并附 `error`（第 4280–4282 行），`llm` 未注入 → `ok:false` 且空目录（第 4266–4267、431 行）。测试 `test-batch.mjs:411-432`。

### `resolveModelEfforts(llm, provider, model)` — `index.js:4303`
单个 provider/model 的「思考程度」档位：走宿主 `resolveModelInfo`/`resolveModel`（第 4292 行 `resolveModelInfoOf`），透出 `efforts`（含 `id/name/description`）、`defaultEffort`、`context`（第 4309–4321 行）；未知模型 → `ok:false`+空列表+原因，缺服务 → 诚实报错（第 4305–4306、4322–4324 行）。测试 `test-batch.mjs:464-516`。

### `installWebServer(ctx, service, extra)` — `index.js:4327`
本机面板后端注册器：经 `ctx.inject(['webServer'], ...)` 注册多个回环端点。本测试直接驱动它的 `register` 桩（见 `test-batch.mjs:437-447`、`498-503`）：
- `GET /api/codewiki/models`：回环 200 + `ok:true`、非回环 403（测试第 435–462 行）。
- `GET /api/codewiki/model-efforts`：回环 + 完整参数 200、缺 `model` 400、非回环 403（测试第 465–516 行）。
端点内部调用 `listModelCatalog`（第 4556 行）与 `resolveModelEfforts`（第 4581 行），回环判定见 `isLoopbackRequest`（第 4229 行）。

### 0.10.1 删除内置百炼直连通道 — `index.js` 不再导出 `resolveBatchApiKey`
测试 `test-batch.mjs:519-521` 动态 `import('./index.js')` 后断言 `mod.resolveBatchApiKey === undefined`，确认插件不再导出凭证解析链。

## Architecture

```text
 test-batch.mjs (自检脚本, 1–643)
        │  import 纯函数 + 并发执行器
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ index.js 编译执行链                                          │
 │                                                             │
 │ 纯函数层（无需模型通道）                                      │
 │  estimateTokens 449 ─ 字符级 token 粗算                      │
 │  numberLines 679 ─ 行号前缀                                  │
 │  collectSources 1094 ─ 源码内联/预算                         │
 │  prepareArticleTasks 1165 ─ 任务装配/分档/观察批              │
 │  localPlan 1300 / packArticles 1409 / scanRepoFiles 2121    │
 │  classifySessionTask 2032 / buildSessionSteerText 2049      │
 │  fixAnchors 856 / validateArticleEnvelope 1082              │
 │                                                             │
 │ 宿主 llm 通道层（mock 注入 stream 协议）                       │
 │  runRealtimeTasks 591 ──► 默认档池 + 大档池 (分池限流)        │
 │       │ 失败记账→notes / signal→中止 / onTaskDone→tps         │
 │       ▼                                                     │
 │  llmChat 467 ─ 封装 stream + 思考档位重试                     │
 │                                                             │
 │ 设置页数据源 + 回环端点                                       │
 │  listModelCatalog 4265 ─► GET /api/codewiki/models           │
 │  resolveModelEfforts 4303 ─► GET /api/codewiki/model-efforts │
 │  installWebServer 4327 ── 注册/回环守卫 isLoopbackRequest     │
 └─────────────────────────────────────────────────────────────┘
        ▲                 ▲                    ▲
        │                 │                    │
   makeLlm 174      makeSlowLlm 233       fakeCtx.inject→webServer.register
   (字符串/函数/Error) (带延迟)          (installWebServer 桩, 437/448)
```

组件划分清晰：纯函数层（token/装填/规划/锚点）与模型通道层（并发池/失败记账）由两套测试桩驱动；设置页数据源与回环端点共用 `ctx.inject(['webServer'])` 的 `register` 桩，靠 `isLoopbackRequest`（第 4229 行）做回环守卫。

## Data Flow

测试脚本驱动编译执行链的典型数据流如下（按 `test-batch.mjs` 的 section 顺序）：

1. **源码装填链路**：临时仓库（`fs.mkdtempSync` 第 33 行）→ `collectSources` 读文件加行号前缀（`numberLines`）→ 返回内联文本与 `skipped/oversized`；`estimateTokens` 用粗算 token 决定预算是否溢出。预算内 → `prepared`；首文件即溢出 → `oversized` 兜底；多文件超预算 → 拆成 `#obs` 观察批；单文件超 128k 大档预算 → 标 `bigTier`，超到 420k 仍装不下 → 进 `sessionTasks`。

2. **任务装配链路**：`prepareArticleTasks`（第 54–132 行）→ `batchArticlePrompt`（第 1125 行）拼出 `batchPrompt`（含 mission/语言/源码/旧文）→ 普通任务落 `prepared`、超大任务落 `sessionTasks`。普通任务再经 `submitBatchFor`（第 2755 行）→ `startBatchChatRun`（第 2629 行）→ `runRealtimeTasks` 进入并发池。

3. **并发池链路**：`runRealtimeTasks`（第 591 行）按 `bigTier` 把任务分到默认档池 / 大档池（第 596–611 行），每池 `Promise.all(worker)`（第 646 行）按 `limit` 并发消费；每个任务走 `llmChat`（第 467 行）→ 宿主 `llm.stream`（mock 在 `makeLlm` 第 174 行）→ 返回 `{content, outputTokens}`；普通磁盘任务由 `applyTaskResult`（第 553 行）落盘、失败进 `notes`；结果以 `Map(customId→结果)` 返回（第 649 行）。

4. **会话通道链路**：`classifySessionTask`（第 2032 行）每 tick 轮询目标文件判 `timeout/harvest/wait`；`buildSessionSteerText`（第 2049 行）生成钉死档位的 steer 文本；`dispatchSessionTasks`（第 2797 行）写任务文件 + steer；`progressSessionTasks`（第 2835 行）收割入账。

5. **设置页链路**：`installWebServer`（第 4327 行）注册回环端点 → 请求经 `isLoopbackRequest`（第 4229 行）守卫 → `listModelCatalog`（第 4265 行）/ `resolveModelEfforts`（第 4303 行）从宿主 llm 服务取目录/档位 → `writeJson`（第 4234 行）回 200/400/403。

## Connections

- [[index]] — 本测试覆盖的全部公共函数与并发池/端点都定义在 `index.js`，是唯一的被测实现源。
- [[test-orchestration]] — `runRealtimeTasks` 是 `tickArticles`/`tickCrosscut`/`tickReview` 等阶段执行器（`startBatchChatRun` 第 2629 行）调用的底层并发池；完整阶段机流程在该模块。
- [[test-fixtures]] — 临时小仓库的构造方式（写 `a.ts`/`big.ts`/`huge.ts` 等）与本测试的 fixture 搭建同源。
- [[test-wiki-anchors]] — `fixAnchors`（第 856 行）的符号绑定语义与 `test-wiki-anchors.mjs` 的 `symbolsOnLine` 同注释要求「同源」，两处改一处须同步。
- [[test-agentic]] — agentic 写作通道与单轮通道共用 `markBig`/`bigTier` 分池语义（`markBigAgenticTasks`、`runAgenticArticles`，第 3021 行）。
- [[test-engine-bridge]] — 宿主 llm 服务的 `stream`/`listProviders`/`resolveModelInfo` 协议由真实 bridge 注入，本测试用 mock 桩（`makeLlm` 第 174 行、`fakeCtx` 第 438 行）代替。

## Known Issues

- **`runRealtimeTasks` 的请求体断言依赖 mock 桩实现细节**：测试里用 `llmCalls.push(opts)`（第 177 行）在 `makeLlm` 内部记录每次 `stream(opts)` 的入参，再断言 `opts.provider/model/reasoningEffort/temperature`。这些字段的组装发生在 `llmChat`（第 467–476 行），测试本身不重新实现协议，只顺着 index.js 的封装验证；若 `llmChat` 改了字段名，测试须同步改 `promptOf`/`llmCalls` 的断言路径。

- **大档分池测试依赖真实计时**：`runRealtimeTasks` 分池限流（第 232–297 行）用 `makeSlowLlm` 的 `delayMs=30` 制造在飞窗口，断言 `peakNormal===2 / peakBig===1`（第 280–281 行）。该断言依赖 `onRequestStart→onDone` 回调在延迟窗口内被触发；在极慢的 CI 机器上若 task 间调度延迟异常，可能偶发误判（同一行注释已在第 230–232 行说明「观测在飞峰值」的设计意图）。

- **`installWebServer` 端点测试不覆盖全部已注册路由**：`test-batch.mjs` 仅驱动了 `/api/codewiki/models`（第 435–462 行）与 `/api/codewiki/model-efforts`（第 465–516 行）两个端点。`installWebServer` 还注册了 `/api/codewiki/jobs`、`/api/codewiki/repos`、`/api/codewiki/sessions`、`/api/codewiki/sessions/item`、`/api/codewiki/control` 等（第 4368–4620 行），但这些端点的行为不在此测试覆盖范围内。

- **0.10.1 删除百炼直连通道只验证「不再导出」**：第 519–521 行仅断言 `mod.resolveBatchApiKey === undefined`，并未断言某个具体的内置凭证解析函数被删——若未来有人重新导出同名函数但改了实现，测试不会报警。

- **`fixAnchors` 多锚点行「已正确」判定为宽松语义**：第 599–601 行单锚点行保持宽松（起始行含该符号即认可），多锚点行靠 `used` 占用 + 就近排序（第 944–1008 行）。注释明确「不为了严格而改写全仓既有锚点」，因此个别历史上写得松的锚点会被判定为已正确而放过——这是有意保留的宽松策略，不是 bug。
