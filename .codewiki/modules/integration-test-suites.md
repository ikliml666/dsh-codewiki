---
title: integration-test-suites
type: module
source_files:
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-batch.mjs
  - test-cwd-paths.mjs
tags: [integration-test, node-esm, codewiki, validation-assets, cordis]
---

## Overview

本模块是一组 Node ESM 集成测试，覆盖 `dsh-codewiki` 服务的批量执行、工作目录路径解析、编排流程以及 wiki 锚点与入口生成。测试文件与运行期日志同名对应，构成可追溯的验证资产。包含五个测试脚本：`test-orchestration.mjs`（服务化编排冒烟测试）、`test-wiki-anchors.mjs`（wiki 行号锚点校验）、`test-wiki-entry.mjs`（CodeWiki.md 入口生成与路径规范化）、`test-batch.mjs`（编译执行链自检）、`test-cwd-paths.mjs`（0.2.3 路径修复验证）。

## Key Components

### test-orchestration.mjs

- 环境加速与隔离：`process.env.DSH_CODEWIKI_TICK_MS='300'`（test-orchestration.mjs:15，生产默认 10s）；`process.env.DSH_CODEWIKI_JOBS_FILE` 独立指向避免与真实宿主互洗（test-orchestration.mjs:19）；`import { name, apply } from './index.js'`（test-orchestration.mjs:20）。
- 断言辅助：`check(cond, msg)` 累计断言计数（test-orchestration.mjs:23）。
- 文章模板：`articleMd(title, source, marker='Batch-written', type='module')` 返回带 frontmatter 的 md 字符串（test-orchestration.mjs:29）。
- 测试配置基线：`batchCfg(extra)` 默认返回 `{ batchProvider:'workbuddy', batchModel:'hy3', ...extra }`（test-orchestration.mjs:34），0.10.1 起编译模型必须显式。
- Mock 宿主上下文：`makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})`（test-orchestration.mjs:40）返回 `{ctx, registered, endpoints, listeners, disposers}`；内部 `ctx.inject`（test-orchestration.mjs:58）支持 cordis 回调/promise 双风格传切片不传实例；`ctx.effect`（test-orchestration.mjs:73）收集 disposer 若错写当场调用致 tick 停摆；`brokenRegistry` 时 `workspaceRegistry.list()` 抛错（test-orchestration.mjs:55）。
- Mock Agent：`makeMockAgent(cwd)`（test-orchestration.mjs:83）构造 agent，`ctx.inject` 注入 `systemPrompt`：`getSectionOrder` 对 `TOOL_REPORT` 返 2900（test-orchestration.mjs:90），`section` 收集注册。
- Fixture 仓库：`makeFixtureRepo()`（test-orchestration.mjs:99）建临时 git 仓库含 `src/core.py`、`src/util.py`。
- LLM 代理与 Mock：`activeLlm`（test-orchestration.mjs:114）当前生效假 llm；`llmProxy`（test-orchestration.mjs:115）恒转发 `activeLlm`，未接线调用 `stream` 抛 `测试未接线`（test-orchestration.mjs:117）；`listModels`/`resolveModel` 安全降级。
- 提示提取：`promptOf(opts)`（test-orchestration.mjs:123）提取首消息文本。
- 批量 Mock：`makeBatchMock({modules, articleMarker, stall, bigArticle, bigSources, planReply})`（test-orchestration.mjs:127）内部 `answerFor`（test-orchestration.mjs:129）按 prompt 关键字分发规划/观察/作者/审校等应答，`stream` 生成器（test-orchestration.mjs:160）按块协议吐块并支持 stall 挂起等 abort，返回 `{llm, llmCalls, batchPrompts, realtimePrompts, restore}`。
- 轮询与 HTTP Mock：`waitJob(cwd, {timeout=30000})`（test-orchestration.mjs:192）轮询 `JOBS_FILE` 终态；`fakeReq`（test-orchestration.mjs:207）/`fakeRes`（test-orchestration.mjs:217）mock HTTP。
- 动态导入：`commitHintText`（test-orchestration.mjs:284）、`wakeCompileSession`（test-orchestration.mjs:354）。
- 同构校验器：`validateOut`（test-orchestration.mjs:1019）本地校验同构宿主 schema。
- 测试块（console.log 分区）：系统提示提醒（test-orchestration.mjs:222）、注册与 cw 工具（test-orchestration.mjs:253）、codewiki_update+commitHintText（test-orchestration.mjs:273）、wakeCompileSession（test-orchestration.mjs:351）、规划阶段（test-orchestration.mjs:379）、全量编译（test-orchestration.mjs:454）、大 wiki 横切（test-orchestration.mjs:486）、大模块分割（test-orchestration.mjs:516）、单项目串行（test-orchestration.mjs:550）、唯一通道（test-orchestration.mjs:599）、stale 逐篇（test-orchestration.mjs:633）、codewiki_progress（test-orchestration.mjs:656）、重启重跑（test-orchestration.mjs:693）、并发占位（test-orchestration.mjs:749）、面板端点（test-orchestration.mjs:789）、排除清单/compile（test-orchestration.mjs:843）、knownRepos/refresh（test-orchestration.mjs:898）、工作区过滤（test-orchestration.mjs:938）、registry 异常防御（test-orchestration.mjs:985）、输出 schema 校验（test-orchestration.mjs:1015）、孤儿接管（test-orchestration.mjs:1055）、模型缺失诚实报错（test-orchestration.mjs:1089）、严格 cordis（test-orchestration.mjs:1104）、Temp 清理（test-orchestration.mjs:1128）。
- scheduler 默认 `enabled:false, intervalMin:30`（test-orchestration.mjs:890）。

### test-wiki-anchors.mjs

- 源文件加载：`ROOT`（test-wiki-anchors.mjs:14）、`WIKI=path.join(ROOT,'.codewiki')`（test-wiki-anchors.mjs:15）、`SOURCES={'index.js':{lines,total},'client.js':{lines,total}}` 读取按行拆分记 `total`（test-wiki-anchors.mjs:14-24）。
- 断言：`check(cond, msg)` 返回 cond 供提前 continue（test-wiki-anchors.mjs:28）。
- 符号提取：`symbolsOnLine(line)`（test-wiki-anchors.mjs:38）正则抓反引号标识符，去参数表，拒非符号，要求 sym 长≥3 且尾段≥3。
- 最近符号：`nearestSymbol(syms, anchorIndex, anchorLen)`（test-wiki-anchors.mjs:52）取距锚点中最近者，同距取左侧。
- 文件遍历：`walk(dir)` 递归收 `.md`（test-wiki-anchors.mjs:64）；`articles = walk(WIKI).sort()`（test-wiki-anchors.mjs:75），空则 exit 1。
- 主校验循环（test-wiki-anchors.mjs:82-115）：逐行匹配 `/(?:index|client)\.js[:：](\d+)(?:-(\d+))?/g`（test-wiki-anchors.mjs:86）；检查起始行在范围（test-wiki-anchors.mjs:95）、非空行（test-wiki-anchors.mjs:96）、区间有序（test-wiki-anchors.mjs:98）、终点在范围（test-wiki-anchors.mjs:99）；单锚点行做符号绑定：在 `start-1..end` 区间内搜 sym 或尾段（test-wiki-anchors.mjs:105-111），多锚点行跳过绑定。

### test-wiki-entry.mjs

- 从 `./index.js` 导入：`ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus`（test-wiki-entry.mjs:10）。
- 辅助：`repo(name)` 建临时子目录（test-wiki-entry.mjs:19）；`check(cond, msg)`（test-wiki-entry.mjs:13）。
- `ensureWikiEntry` 测试（test-wiki-entry.mjs:27-54）：缺失生成返回 true 且含 `.codewiki` 绝对路径、`codewiki_generate`、`_architecture.md`、`'不会覆盖'` 中文入口；已有返回 false 不覆盖；英文 `'living wiki'` 文案；空 cwd 返回 false 不抛；重复调用幂等。
- `normalizeArticlePath`（test-wiki-entry.mjs:57）：`\`→`/`，正斜杠原样，undefined→''。
- `parseStatus`（test-wiki-entry.mjs:60）：解析 `cw status` 输出，`changedFiles` 保留并规范化、`staleArticles` 的 `\`→`/`。
- `normalizeIndexLinks(repo)`（test-wiki-entry.mjs:63-72）：修复 `_index.md` 中 `[[modules\core|core]]`→`/` 链接头，正文反斜杠如 `E:\ik\repo` 不受影响，已规范再调返回 false（幂等），无 `_index.md` 静默 false。

### test-batch.mjs

- 导入（来自 `./index.js`，test-batch.mjs:7-12）：`collectSources`、`classifySessionTask`、`estimateTokens`、`fixAnchors`、`numberLines`、`buildSessionSteerText`、`prepareArticleTasks`、`runRealtimeTasks`、`localPlan`、`packArticles`、`scanRepoFiles`、`listModelCatalog`、`resolveModelEfforts`、`installWebServer`。
- 内部辅助：`passed`/`failures` 计数（test-batch.mjs:14-15）；`check(cond, msg)`（test-batch.mjs:16）；`section(name)`（test-batch.mjs:20）；`mockJson(obj, status=200)`（test-batch.mjs:21）；`makeLlm(reply)`（test-batch.mjs:145）返回伪宿主 llm 对象含 `async *stream(opts)`；`promptOf(opts)`（test-batch.mjs:161）提取 prompt 字符串。
- 被测 API 行为段：
  - `estimateTokens`（test-batch.mjs:25-28）：CJK 每字 1 token；ASCII `ceil(n/3.5)`；空串 0；混合分别计费。
  - `collectSources(root, rels, budget?)`（test-batch.mjs:31-44）：返 `{text, skipped, oversized}`；缺失文件标“文件不存在”；首文件超预算（如 budget=10）返 `oversized:true` 且原文兜底；预算仅够首文件则 `skipped` 含后续；尾换行只去一个。
  - `numberLines`（test-batch.mjs:47-51）：单尾换行末行 `2| b`；双尾换行保留空行 `2| `；CRLF 剥离 `\r`；空文件输出 `1|`。
  - `prepareArticleTasks(plainTasks, {cwd, language})`（test-batch.mjs:53-103）：普通任务进 `prepared` 分配 `customId` 按序，prompt 含 mission、语言、内联源码、frontmatter 规范；旧文作上下文；单文件超 110k 预算且分不开 → 进 `sessionTasks` 走会话通道、按 128k 大档装填完整源码；连 128k 都装不下仍按原始全长装填（超大兜底已删）；多文件超预算 → 拆观察批（`name` 带 `#obs`，`keepInMemory:true`，`splitFor` 指向原文章，`composePlan` 带 articlePath/mission，prompt 标批次序号）；预算内不分割。
  - `classifySessionTask({articlePath, dispatchedAt})`（test-batch.mjs:106-121）：>30 分钟未见产出 → `timeout`；超时优先于已产出；派发后产出且以 frontmatter 开头 → `harvest`；写一半无 frontmatter → `wait`；目标文件 mtime 早于派发时间 → `wait`。
  - `buildSessionSteerText({job, snapshots, tier, resend?})`（test-batch.mjs:124-139）：`tier` 空则不提档位；填 `codeiwiki` 则显式传 `tier: "codeiwiki"` 且禁止依赖自动选路，写进任务文件与目标路径；`stage:'review'` 用校对措辞；`resend:true` 带“重新派发”仍钉档。
  - `runRealtimeTasks(tasks, {provider, llm, model, reasoningEffort?, concurrency, notes, signal?, onTaskDone?})`（test-batch.mjs:141-225, 273-288）：0.10.1 起唯一宿主 llm 通道；每任务一次流式调用，按 provider/model 路由，`reasoningEffort` 原样下发或未配置时省略，`temperature` 固定 0；单条 user 消息承载 prompt；磁盘任务落盘、keepInMemory 结果带 `content`；`onTaskDone` 上报 `outputTokens`/`durationMs`；外部 `AbortController` 已 abort 则不再消费剩余任务；失败任务记账进 `notes` 且不中断其他、不落盘；`finish kind=error` 透传错误码。
  - `localPlan(files)`（test-batch.mjs:228-238）：按顶层目录分组（src/root/docs），`modules` 收文件，`concepts` 为空。
  - `packArticles(articles, budget)`（test-batch.mjs:241-251）：预算内整篇装填（`#### name` 标题）；超预算后续文章只装头部并标“仅头部”含 frontmatter 与 Overview。
  - `scanRepoFiles(root)`（test-batch.mjs:254-267）：跳过 `node_modules`/`.git`/二进制/超大（300*1024 被跳）/空文件，仅收有效源码并返回 `{path, bytes}`。
  - `listModelCatalog(llm)`（test-batch.mjs:291-312）：跳过无 `id` 的 provider，兼容 `provider`/`name` 字段写法，单 provider `listModels` 抛错则条目保留并附 `error` 不影响其他，`llm` 为 null → `ok:false` 空目录。
  - `installWebServer(ctx, jobCtl, {llm})`（test-batch.mjs:327,383）：注册 `/api/codewiki/models`（test-batch.mjs:328）与 `/api/codewiki/model-efforts`（test-batch.mjs:384）；仅回环地址（`127.0.0.1`）放行，非回环返 403 `loopback only`；`/models` 回环返 200 带宿主 provider/model；`/model-efforts` 缺 `model` 参数返 400。
  - `resolveModelEfforts(llm, provider, model)`（test-batch.mjs:344-374）：从 `llm.resolveModel` 读 `reasoning.efforts`/`defaultEffort`/`context.tokens` 并透出；未知模型 `ok:false` 带原因；`llm` null 诚实报错不抛；模型未声明档位则 `ok:true` 空列表。
  - 0.10.1 删除内置百炼直连：`mod.resolveBatchApiKey === undefined` 验证不再导出（test-batch.mjs:401）。
  - `fixAnchors(articleText, root)`（test-batch.mjs:404-444）：依据 frontmatter `source_files` 修正行号锚点；错行号唯一符号修正，起点含符号视为正确不动，符号未找不动且记 `unresolved`，多声明歧义不动，取声明行，区间锚点起点对齐、尾钳到文件尾，basename 唯一解析修正，不在清单不碰，CRLF 保真，无 frontmatter 原样。

### test-cwd-paths.mjs

- 导入：`import * as plugin from './index.js'`（test-cwd-paths.mjs:7）；`pluginDir` 由 `fileURLToPath` 取（test-cwd-paths.mjs:7）。
- `repoWin` 默认 `'E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin'`（test-cwd-paths.mjs:8）；`msys` 推导为 `'/'+repoWin.replace(/^([A-Za-z]):\//, d=>d.toLowerCase()+'/')`（test-cwd-paths.mjs:10）。
- `ctx` 模拟注入：`inject(_names, fn)` 调 `fn({tools:{register(d){registered[d.name]=d}}, subagents:{}})`，`effect(){}`（test-cwd-paths.mjs:13-18）。
- `await plugin.apply(ctx, {})`（test-cwd-paths.mjs:20）后取 `registered.cw`（test-cwd-paths.mjs:22），未注册则退出。
- `cfgProbe` 对象含 `enabled/binaryPath:''/defaultProvider:''/maxConcurrency:2/articleLanguage:'中文'` 等（test-cwd-paths.mjs:26），间接验证 `resolveBinary` 选 PATH 而非捆绑副本。
- 调用 `cw.execute({cwd, args}, execStub)`（test-cwd-paths.mjs:34,48,63）：MSYS 路径跑 `['path']` 须返 `<repo>/.codewiki` 且 exit 0（test-cwd-paths.mjs:22-26）；Windows 路径跑 `['status']` 返真实三态而非 “No wiki found”（test-cwd-paths.mjs:22-26）；不存在路径 `/q/nonexistent-repo-xyz` 须抛含 `cwd 不存在` 错误（test-cwd-paths.mjs:22）。

## Architecture

```text
┌────────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ test-orchestration │   │ test-wiki-entry  │   │ test-wiki-anch  │
│ .mjs (行15-1144)   │   │ .mjs (行10-72)   │   │ .mjs (行14-115) │
└─────────┬──────────┘   └────────┬─────────┘   └────────┬────────┘
          │ import {name,apply}  │ import funcs         │ read src
          ▼                      ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│ ./index.js (外部被测模块: dsh-codewiki 服务)                   │
└──────────────────────────────────────────────────────────────┘
          ▲                      ▲                      │
          │ mock ctx/llm         │ fake paths          │ static check
┌─────────┴──────────┐   ┌───────┴────────┐   ┌────────┴────────┐
│ test-batch.mjs     │   │ test-cwd-paths │   │ makeLlm/ctx.inject│
│ (行7-444)          │   │ .mjs (行5-67)  │   │                 │
└────────────────────┘   └────────────────┘   └──────────────────┘
```

## Data Flow

### test-orchestration.mjs 数据流
测试代码 → `makeCtx()`（test-orchestration.mjs:40）生成 ctx → `apply(ctx, config)`（test-orchestration.mjs:20）向 ctx 注册工具/端点（内部经 `ctx.inject` 取 services，含 `llm` 即 `llmProxy`）→ 从 `registered` 取 `codewiki_generate`/`cw`/`codewiki_update`/`codewiki_progress` 调 `.execute(args, {agent})` → 工具内部经 `llmProxy.stream`（test-orchestration.mjs:115）调 `activeLlm`（由 `makeBatchMock()` 设置，test-orchestration.mjs:127）→ 服务阶段机推进写 `JOBS_FILE` → `waitJob(cwd)`（test-orchestration.mjs:192）轮询得终态 job → 断言。面板端点经 `endpoints.find(e=>e.path===...).handler(fakeReq(...), fakeRes())`（test-orchestration.mjs:40-50）调用。

### test-batch.mjs 数据流
用 `fs.mkdtempSync` 造临时目录，写入源码/文章；将路径与任务描述传入 `prepareArticleTasks`（test-batch.mjs:53-103）等，得到 `{prepared, sessionTasks}` 或 prompt 字符串，再喂给 `runRealtimeTasks(tasks, opts)`（test-batch.mjs:141-225）断言返回 `Map<customId, {ok, content?}>` 及磁盘落盘；`installWebServer`（test-batch.mjs:327,383）注入伪 `ctx` 得路由 handler，以伪 `req{url, socket.remoteAddress}`/`res{writeHead, end}` 调 handler 验 HTTP 行为。

### test-cwd-paths.mjs 数据流
构造 `cwd`（MSYS/Windows/不存在）与 `args` 传入 `cw.execute`（test-cwd-paths.mjs:34-63），取回 `{exitCode, stdout}` 或异常 `message` 做断言。

### test-wiki-anchors.mjs 数据流
读 `SOURCES` 源码行（test-wiki-anchors.mjs:16-26）→ `walk(WIKI)`（test-wiki-anchors.mjs:64）收集 md → 逐行正则提取锚点（test-wiki-anchors.mjs:16-49）→ 在源文件区间搜符号绑定。

### test-wiki-entry.mjs 数据流
建临时 repo（test-wiki-entry.mjs:19）→ 调 `ensureWikiEntry`/`normalizeArticlePath` 等（test-wiki-entry.mjs:27-72）→ 检查返回布尔与文件内容。

## Connections

- 被测核心服务：[[dsh-codewiki]]（即 `./index.js` 导出的 `apply` 与工具）
- 上下文框架：[[cordis]]（`makeCtx` 模拟其 `inject`/`effect` 语义，test-orchestration.mjs:40-73）
- 相关测试资产：[[codewiki-cli]]（`cw` 工具调用真实 CLI，test-cwd-paths.mjs:13-23）
- 锚点校验依赖源文件：[[index.js]] 与 [[client.js]]（被 `test-wiki-anchors.mjs` 静态读取，test-wiki-anchors.mjs:14-24）

## Known Issues

以下条目实为测试固化的非显然语义与边界防御，并非模块缺陷：

### test-orchestration.mjs 边界
- **cordis 语义**：`makeCtx` 的 `effect` 立即执行 body，错写 `ctx.effect(()=>service.stop())` 会当场 stop 致 tick 停摆（test-orchestration.mjs:73）；严格语义下未 inject 访问 `ctx.agents` 抛错，但 `apply` 不抛且工具仍注册（test-orchestration.mjs:40, 1118）。
- **LLM 接线**：`llmProxy.stream` 若 `activeLlm` 未接线抛 “测试未接线”（test-orchestration.mjs:117）；stall 模式挂起至 `opts.signal` abort（test-orchestration.mjs:115-120）。
- **规划降级**：planReply 非 JSON 时降级本地按顶层目录分组，任务仍 done（test-orchestration.mjs:414-426）。
- **commitHintText 缓存**：缓存键为 cwd，编译早于 `.codewiki` 最后提交则静默；`writtenCount=0` 不提醒；测试用换仓库绕开 60s 缓存（test-orchestration.mjs:315-329, 337）。
- **wakeCompileSession 静默**：无 sessionId、冷会话、registry.get 抛、steer 抛、缺省 agents 均不抛仅跳过（test-orchestration.mjs:368-376）。
- **单项目串行**：A 用 stall 占推进权，B 提交进 `queued` 且排队期零请求；取消 A 后 B 自动轮到（test-orchestration.mjs:550-597）。
- **并发占位**：`serialProjects:false` 下并发提交共享同 jobId；预置外部实例 job 经 flush 合并不丢失（test-orchestration.mjs:779, 782）。
- **面板守卫**：非回环地址访问 jobs 端点 403（test-orchestration.mjs:802）；取消未知 jobId 404（test-orchestration.mjs:830-836）。
- **排除清单**：`excludePaths` 设后 compile 动作 400 拒绝且报错含“命中排除项”，子目录同样排除（test-orchestration.mjs:871-879）。
- **knownRepos 独立**：job 历史清空后 knownRepos 仍让 repos 总览发现仓库（test-orchestration.mjs:917-930）。
- **registry 异常**：`brokenRegistry` 使 `list()` 抛错，jobs/repos 端点降级不过滤仍 200（test-orchestration.mjs:985-1013）。
- **孤儿接管**：foreign 任务停更 6 分钟被接管并响应 cancelRequested，新鲜 foreign 不被抢（test-orchestration.mjs:1082）。
- **模型缺失**：`batchProvider:''` 时 `codewiki_generate` 抛 “编译模型提供商为空”，且失败落 job.failed 留痕（test-orchestration.mjs:1089-1102）。
- **Temp 清理**：启动 tick 移除 Temp 目录终态任务，保留活动/工作区终态（test-orchestration.mjs:1128-1144）。
- **错误前缀改写**：`codewiki_update` 包装 `generate` 错误，消息前缀改写为 `codewiki_update`（test-orchestration.mjs:294-296）。

### test-wiki-anchors.mjs 边界
- **锚点校验边界**：仅行内单锚点且存在符号时才做符号绑定，多锚点行仅兜底行号范围（test-wiki-anchors.mjs:38-41）；区间锚点在整个区间搜符号（test-wiki-anchors.mjs:38-44）；`symbolsOnLine` 拒绝含冒号/斜杠/空格非符号（test-wiki-anchors.mjs:38-40）。

### test-wiki-entry.mjs 边界
- **入口生成边界**：`ensureWikiEntry('', lang)` 空 cwd 返回 false 不抛（test-wiki-entry.mjs:49）；`normalizeArticlePath(undefined)` 返回 `''`（test-wiki-entry.mjs:59）；`normalizeIndexLinks` 只改链接头反斜杠，正文反斜杠不受影响（test-wiki-entry.mjs:70）。

### test-batch.mjs 边界
- **Token/预算边界**：`estimateTokens` 空串 0，混合分别计费（test-batch.mjs:28）；`collectSources` 首文件超预算即 `oversized` 兜底返回首文件（test-batch.mjs:41），后续装不下进 `skipped`；多文件超预算拆观察批且每批 ≤110k token（test-batch.mjs:94-101）；单文件超大走会话通道 128k 大档，再超则全长装填（test-batch.mjs:78-82）。
- **行号/格式**：`numberLines` 空文件输出 `1|`，双尾换行保留空行 `2| `，CRLF 剥离（test-batch.mjs:47-51）；`fixAnchors` 对未找到/歧义/不在清单/basename 歧义均不动并记 `unresolved`，区间尾部钳到文件尾，CRLF 保真（test-batch.mjs:420-438）。
- **会话通道收割**：`classifySessionTask` 超时（30min）判定优先于已产出（test-batch.mjs:113）；旧文未更新（mtime 早于派发）判 `wait`（test-batch.mjs:120）。
- **任务执行容错**：`runRealtimeTasks` 单任务失败仅记 `notes`、不落盘、不中断并发（test-batch.mjs:223-224, 286-287）；外部 `AbortController` 已 abort 则池子立即停止消费（test-batch.mjs:196-200）；`reasoningEffort` 未配置时从请求体省略而非传 undefined（test-batch.mjs:188）；`temperature` 硬编码 0（test-batch.mjs:174）。
- **模型/端点**：`listModelCatalog`/`resolveModelEfforts` 在 `llm=null` 或单 provider 抛错时诚实返回 `ok:false` 或保留错误条目，不抛异常（test-batch.mjs:309-311, 371）；HTTP 端点强制回环（`127.0.0.1` 放行，其它 403），缺参 400（test-batch.mjs:392, 395, 341）。
- **档位钉死**：`buildSessionSteerText` 填 `tier` 时显式禁止自动选路，且 `review`/`resend` 场景文案不同但均钉死（test-batch.mjs:127-139）。
- **0.10.1 删除内置百炼通道**：`resolveBatchApiKey` 不再从 `./index.js` 导出（test-batch.mjs:401），插件不碰密钥。
- **scanRepoFiles 黑名单**：跳 node_modules/.git/二进制/超大(300*1024)/空（test-batch.mjs:266）。

### test-cwd-paths.mjs 边界
- **路径归一化**：`cw.execute` 将 Windows 盘符路径（`E:/x`）转 MSYS（`/e/x`）并跑通（test-cwd-paths.mjs:22-26），且 Windows 下 `status` 返回真实三态而非 "No wiki found"（test-cwd-paths.mjs:22-26），证明 `resolveBinary` 选 PATH 探测而非捆绑副本；不存在 cwd 抛 `cwd 不存在`（test-cwd-paths.mjs:22）。