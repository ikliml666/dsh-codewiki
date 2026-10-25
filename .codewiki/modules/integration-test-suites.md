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

本模块是一组 Node ESM 集成测试，覆盖 `dsh-codewiki` 服务的批量执行、工作目录路径解析、编排流程以及 wiki 锚点与入口生成。测试文件与运行期日志同名对应，构成可追溯的验证资产。包含五个测试脚本：`test-orchestration.mjs`（服务化编排冒烟测试，行1-1358）、`test-wiki-anchors.mjs`（wiki 行号锚点校验，行1-118）、`test-wiki-entry.mjs`（CodeWiki.md 入口生成与路径规范化，行1-76）、`test-batch.mjs`（编译执行链自检，行1-501）、`test-cwd-paths.mjs`（0.2.3 路径修复验证，行1-71）。当前代码基线强调 0.10.1 起插件不再直连任何端点、唯一通道为宿主 llm 服务（编译模型必须显式配置），以及 0.10.4 大档模型接管超长输入等。

## Key Components

### test-orchestration.mjs

- 环境加速与隔离：`process.env.DSH_CODEWIKI_TICK_MS = '300'`（行15，生产默认 10s）；`process.env.DSH_CODEWIKI_JOBS_FILE` 独立指向 tmp 防互洗（行22-23，含随机 token 防 pid 复用误读 fixture，行19-23）；`const { name, apply } = await import('./index.js')`（行24）。
- 断言辅助：`let failures = 0`（行26），`function check(cond, msg)` 累计失败计数（行27-30）。
- JOBS_FILE 常量：`const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE`（行32）。
- 文章模板：`const articleMd = (title, source, marker = 'Batch-written', type = 'module') =>`（行33-34）拼装带 frontmatter 的假文章。
- 测试配置基线：`const batchCfg = (extra = {}) => ({ batchProvider: 'workbuddy', batchModel: 'hy3', ...extra })`（行38），0.10.1 起编译模型须显式指向设置里的 provider/model。
- Mock 宿主上下文：`function makeCtx({ agents = [], workspaces = null, brokenRegistry = false, agentGet = null, llm = null } = {})`（行44-84），返回 `{ ctx, registered, endpoints, listeners, disposers }`；`services` 含 `webServer.register`（行50）、`agents.list/get`（行51）、`tools.register`（行52）、`llm`（行53）、`workspaceRegistry.list`（行56 正常形态 / 行57-59 抛错形态）；`inject` 支持 cordis 回调与 promise 双风格（行62-72）；`on` 监听（行73）；`effect` 立即执行 body 并收集 disposer（行77-81）。
- Mock Agent：`function makeMockAgent(cwd)`（行87-101）造 agent，`ctx.inject` 返回 `systemPrompt` 切片，`getSectionOrder` 对 `TOOL_REPORT` 返 2900（行94）。
- Fixture 仓库：`function makeFixtureRepo()`（行103-120）建 git 仓库含 core/core.py、util/util.py，并自带 git identity（行111-118，0.10.9 起 autoCommitWiki 要求）。
- LLM 代理与 Mock：`let activeLlm = null`（行125）与 `const llmProxy =`（行126-133）唯一通道转发，未接线抛错（行128）；`const promptOf = (opts) =>`（行134）取 `messages[0].content[0].text`。
- 批量 Mock：`function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false } = {})`（行138-202）假 llm 服务；`answerFor`（行140-170）按 prompt 关键词分发；`stream` 生成器按 block 协议 yield（行172-191），`stall` 时挂起至 abort（行177-184）；返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`（行194-201）。
- 轮询与 HTTP Mock：`async function waitJob(cwd, { timeout = 30000 } = {})`（行205-218）轮询 JOBS_FILE 找终态；`function fakeReq`（行220-229） / `function fakeRes`（行230-232） mock HTTP。
- 动态导入符号：`const { commitHintText } = await import('./index.js')`（行297）、`const { autoCommitWiki } = await import('./index.js')`（行408）、`const { autoCommitState } = await import('./index.js')`（行511）、`const { wakeCompileSession } = await import('./index.js')`（行523）从 index.js 导入。
- 同构校验器：`const validateOut = (schema, v) =>`（行1224-1238，位于行1220-1258 工具输出 schema 形态块）本地校验同构宿主 schema。
- 测试块（直接执行断言）：系统提醒（行234-263）、注册（行265-277）、`cw` 工具（行279-283）、`codewiki_update`+`commitHintText`（行285-403）、`autoCommitWiki`（行405-506）、`autoCommitState`（行508-518）、`wakeCompileSession`（行520-556）、本地规划（行558-615）、全量编译（行617-658）、大 wiki 横切（行660-688）、大模块分割（行690-724）、单项目串行（行726-773）、唯一通道（行775-807）、stale 更新（行809-830）、progress（行832-868）、重启重跑（行869-926）、并发占位（行928-976）、面板端点（行978-1030）、排除清单/repos 总览/compile 动作（行1032-1085）、knownRepos/refresh（行1087-1125）、工作区过滤（行1127-1188）、registry 异常（行1190-1218）、schema 校验（行1220-1258）、孤儿接管（行1260-1292）、模型缺失（行1294-1307）、严格 cordis（行1309-1331）、Temp 清理（行1333-1350）。
- scheduler 默认 `enabled:false, intervalMin:30`（行1079，repos 总览 scheduler 块）。

### test-wiki-anchors.mjs

- 源文件加载：引入 fs/path/fileURLToPath（行10-12）；`ROOT`/`WIKI`/`SOURCES`（行14-24）读 index.js/client.js 行数缓存。
- 断言：`let passed`/`let failures`（行26-27），`function check(cond, msg)` 行28-32 返回 cond 供 `if(!check(...))continue` 短路。
- 符号提取：`function symbolsOnLine(line)`（行38-49）提取反引号内标识符，去参数括号，正则 `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$`，长度>=3 且尾段>=3。
- 最近符号：`function nearestSymbol(syms, anchorIndex, anchorLen)`（行52-62）取离锚点最近符号，同距取左侧。
- 文件遍历：`function walk(dir)`（行64-73）递归收集 .md。
- 主校验循环（行82-115）：正则 `/(?:index|client)\.js[:：](\d+)(?:-(\d+))?/g`（行86）；单锚点行才做符号绑定（行105），区间锚点搜整个 slice（行106-112），hit 允许全名或尾段（行108-109）；退出 failures>0?1:0（行117-118）。

### test-wiki-entry.mjs

- 静态导入 `ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus` from './index.js'（行10）。
- 辅助：`let failures`（行12），`function check(cond, msg)`（行13-16）；局部 `const tmp`（行18）、`const repo = (name) =>`（行19-23）。
- `ensureWikiEntry` 测试（行26-54）：缺失生成中文（行27，含绝对路径/codewiki_generate/_architecture.md/不覆盖声明），已有不覆盖（行38），英文文案（行43），空 cwd 返 false（行49），幂等（行53）。
- Windows 规范测试（行56-72）：
  - `normalizeArticlePath`（行57-59）：`\`→`/`，undefined→''。
  - `parseStatus`（行60-62）：changedFiles 保留规范，staleArticles `\`→`/`。
  - `normalizeIndexLinks(repo)`（行63-72）：改 `_index.md` 链接头 `[[modules\core|core]]`→`[[modules/core|core]]`（行69），正文反斜杠不动（行70），幂等（行71），无文件 false（行72）。

### test-batch.mjs

- 导入清单（行7-12）：`collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer` 来自 `./index.js`；以及 `fs, os, path`。
- 测试基座：`let passed`/`const failures`（行14-15），`function check(cond, msg)`（行16-19，累计 `passed`/`failures`）、`function section(name)`（行20）、`const mockJson`（行21，预留未用）。
- `estimateTokens` 测试（行23-28）：CJK 每字 1 token，ASCII `ceil(n/3.5)`，空串 0，混合累加。
- `collectSources(root, files, budget?)` 测试（行31-44）：返回 `{text, skipped, oversized}`；内容内联带 `### 相对路径` 标题与 `行号| ` 前缀（行36）；缺失文件文内标“文件不存在”（行37）；预算充足无跳过（行38）；尾换行只去一个（行39）；首文件即超预算 → `oversized:true` 且原文兜底返回（行40-41）；装不下第二文件 → `skipped` 含该文件（行42-44）。
- `numberLines` 测试（行46-51）：单尾换行末行 `2| b`；双尾换行保留空行 `2| `；CRLF 剥离 `\r`；空文件输出 `1|`。
- `prepareArticleTasks(plainTasks, {cwd, language})` 测试（行53-105）：返回 `{prepared, sessionTasks}`；普通任务全进 `prepared` 且 `customId` 按序；prompt 含 mission、语言、内联源码、frontmatter 规范；旧文作上下文进 prompt；单文件超 110k 但装得进 128k 大档 → 大档单请求不转会话通道（行78-81）；单文件连 128k 都装不下 → `sessionTasks` 唯一兜底且 prompt 按原始全长装填（行82-84）；多文件超预算 → 拆观察批（`prepared` 中名字带 `#obs` 的任务 `keepInMemory:true`、`splitFor` 指向所属文章、`composePlan` 携带 `articlePath` 与 `mission`、prompt 标批次序号且 ≤110k token、不进会话通道）（行87-105）。
- 大档模型接管超长输入测试（行107-131）：配置 `bigProvider/bigModel/bigReasoningEffort/bigBudget`（行109），超 128k 单文件改由大档单请求（带 `bigTier` 标记与自带 provider/model/档位，行111-120），关掉大档则退回会话通道（行122-125）；普通任务不被标大档（行127-131）。
- `classifySessionTask({articlePath, dispatchedAt})` 测试（行133-149）：>30 分钟未见产出 → `timeout`；超时判定优先于已产出；派发后产出且以 frontmatter 开头 → `harvest`；产出中无 frontmatter → `wait`；目标文件 mtime 早于派发时间 → `wait`。
- `buildSessionSteerText({job, snapshots, tier, resend?})` 测试（行151-168）：`tier` 空不提档位；填 `tier` 则文本要求显式传 `tier: "codeiwiki"` 且禁止自动选路；任务文件与目标路径写进；无模板占位符残留；`stage:'review'` 文案按校对措辞且仍钉死档位；`resend:true` 带“重新派发”并钉档；未填档位重发不提。
- `runRealtimeTasks(tasks, {provider, llm, model, reasoningEffort?, concurrency, notes, signal?, onTaskDone?})` 测试：
  - 基础路由（行169-205）`function makeLlm(reply)` 工厂（行173-188）返回 `{ async *stream(opts) }` 模拟 stream 协议；每任务一次流调用，按 provider/model 路由，`reasoningEffort` 原样下发，`temperature` 固定 0（行200-203）。
  - 混合档分派（行207-228）：同一池里大档任务按自带 provider/model/档位路由，普通任务走默认档。
  - tps 采样与取消信号（行229-239）：`onTaskDone` 上报 `outputTokens`/`durationMs`；未配置思考程度不下发 `reasoningEffort`。
  - 外部 signal 中止（行241-251）：已 abort 则结果数少于任务数。
  - 失败记账（行253-275）：失败进 `notes` 不中断其他，失败任务不落盘；以及行323-338 失败通道错误码透传（`finish kind=error` → 任务失败，错误码进 notes）。
- `localPlan(files)` 测试（行277-288）：按顶层目录分组，根文件归 `root`，不造概念（`concepts:[]`）。
- `packArticles(articles, budget)` 测试（行290-301）：预算内整篇装填；超预算后续文章只装头部（含 frontmatter 与 Overview）并标“仅头部”。
- `scanRepoFiles(root)` 测试（行303-318）：跳过 `node_modules`/`.git`/二进制/超大（300*1024 被跳）/空文件；只收有效源码，返回项含 `path` 与 `bytes`。
- `listModelCatalog(llm)` 测试（行340-362）：`llm` 需有 `listProviders()`/`listModels(id)`；跳过无 `id` 的 provider；兼容 `{provider, name}` 写法；单 provider 抛错时条目保留 `error` 不影响其他；`llm` 为 `null` → `{ok:false, providers:[]}`。
- `installWebServer(ctx, jobSvc, {llm})` + `/api/codewiki/models` 测试（行364-392）：注入假 `webServer.register` 收集路由；回环（`127.0.0.1`）请求 → 200 且 `ok:true` 返回宿主 provider/model；非回环 → 403 `loopback only`。
- `resolveModelEfforts(llm, provider, model)` + `/api/codewiki/model-efforts` 测试（行394-446）：`llm.resolveModel` 返回 `{context:{tokens}, reasoning:{defaultEffort, efforts:[...]}}`；解析出档位/默认档/上下文长度；未知模型 → `ok:false` 带 error 不抛；`llm` 为 `null` → 诚实报错含 `resolveModel`；模型未声明档位 → `ok:true` 空列表；端点回环+完整参数 200，缺 `model` 参数 400，非回环 403。
- 0.10.1 通道移除校验（行448-451）：动态 `import('./index.js')` 断言 `resolveBatchApiKey === undefined`。
- `fixAnchors(articleText, rootDir)` 测试（行453-495）：返回 `{fixed, text, unresolved}`；仅处理 frontmatter 中 `source_files` 列出的文件；错行号唯一符号修正；起点行含符号视为正确不动；符号未找到记 `unresolved` 不动；多声明歧义不动；多处出现取声明行；区间锚点起点对齐符号、尾部钳到文件末行；basename 唯一解析修正并保留原文写法；不在清单不碰；CRLF 文章行尾保真；无 frontmatter 原样；basename 根与子目录同名歧义不碰。

### test-cwd-paths.mjs

- 导入：`import * as plugin`（行5）、`import path`（行3）、`import { fileURLToPath }`（行4）；`const pluginDir =`（行7）。
- 路径推导：`const repoWin =`（行8）默认 `'E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin'`，`const msys =`（行10）将 `E:/x` 转 `/e/x`。
- 假 `ctx.inject`（行13-18）收集 `tools.register`，调 `await plugin.apply(ctx, {})`（行20）后取 `registered.cw`（行22）。
- MSYS 测试（行30-45）：`cw.execute({cwd: msys, args:['path']}, execStub)` 期望 exit 0 且 stdout 匹配 `.codewiki$`。
- Windows 测试（行47-57）：`cw.execute({cwd: repoWin, args:['status']})` 期望 exit 0 且不含 `No wiki found`。
- 不存在路径（行61-69）：`cw.execute({cwd:'/q/nonexistent-repo-xyz', args:['status']})` 必须抛错且 message 含 `cwd 不存在`。

## Architecture

```text
┌────────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ test-orchestration │   │ test-wiki-entry  │   │ test-wiki-anch  │
│ .mjs (行1-1358)    │   │ .mjs (行1-76)    │   │ .mjs (行1-118)  │
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
│ (行1-501)          │   │ .mjs (行1-71)  │   │                 │
└────────────────────┘   └────────────────┘   └──────────────────┘
```

## Data Flow

### test-orchestration.mjs 数据流
测试代码 → `makeCtx()`（行44-84）生成 ctx → `apply(ctx, config)`（行24）向 ctx 注册工具/端点（内部经 `ctx.inject` 取 services，含 `llm` 即 `llmProxy` 行126-133）→ 从 `registered` 取 `codewiki_generate`/`cw`/`codewiki_update`/`codewiki_progress` 调 `.execute(args, {agent})` → 工具内部经 `llmProxy.stream` 调 `activeLlm`（由 `makeBatchMock()` 设置，行138-202）→ 服务阶段机推进写 `JOBS_FILE` → `waitJob(cwd)`（行205-218）轮询得终态 job → 断言。面板端点经 `endpoints.find(e=>e.path===...).handler(fakeReq(...), fakeRes())`（行220-232）调用。

### test-batch.mjs 数据流
用 `fs.mkdtempSync` 造临时目录，写入源码/文章；将路径与任务描述传入 `prepareArticleTasks`（行53-131）等，得到 `{prepared, sessionTasks}` 或 prompt 字符串，再喂给 `runRealtimeTasks(tasks, opts)`（行169-338）断言返回 `Map<customId, {ok, content?}>` 及磁盘落盘；`installWebServer`（行364-446）注入伪 `ctx` 得路由 handler，以伪 `req{url, socket.remoteAddress}`/`res{writeHead, end}` 调 handler 验 HTTP 行为。

### test-cwd-paths.mjs 数据流
构造 `cwd`（MSYS/Windows/不存在）与 `args` 传入 `cw.execute`（行30-69），取回 `{exitCode, stdout}` 或异常 `message` 做断言。

### test-wiki-anchors.mjs 数据流
读 `SOURCES` 源码行（行14-24）→ `walk(WIKI)`（行64-73）收集 md → 逐行正则提取锚点（行38-49, 86）→ 在源文件区间搜符号绑定（行105-112）。

### test-wiki-entry.mjs 数据流
建临时 repo（行18-23）→ 调 `ensureWikiEntry`/`normalizeArticlePath` 等（行26-72）→ 检查返回布尔与文件内容。

## Connections

- 被测核心服务：[[dsh-codewiki]]（即 `./index.js` 导出的 `apply` 与工具）
- 上下文框架：[[cordis]]（`makeCtx` 模拟其 `inject`/`effect` 语义，test-orchestration.mjs:44-84）
- 相关测试资产：[[codewiki-cli]]（`cw` 工具调用真实 CLI，test-cwd-paths.mjs:12-22）
- 锚点校验依赖源文件：[[index.js]] 与 [[client.js]]（被 `test-wiki-anchors.mjs` 静态读取，test-wiki-anchors.mjs:14-24）

## Known Issues

以下条目实为测试固化的非显然语义与边界防御，并非模块缺陷：

### test-orchestration.mjs 边界
- **cordis 语义**：`makeCtx` 的 `inject` 传 ctx 切片而非实例（行62-72）；`effect` 错写 `ctx.effect(()=>service.stop())` 会当场调用致 tick 停摆（行77-81）；严格语义下未 inject 访问 `ctx.agents` 抛错（`Object.defineProperty` 行1323-1325），但 `apply` 不抛且工具仍注册（行1309-1331）。
- **LLM 接线**：`llmProxy.stream` 若 `activeLlm` 未接线抛 “测试未接线”（行128）；stall 模式挂起至 `opts.signal` abort（行177-184）。
- **本地规划**：0.10.7 起删规划阶段，模块清单由 localPlan 按顶层目录分组生成（行558-615），fixture 结构直接决定模块名（行103-120）；无勘探员请求（行583, 628）。
- **commitHintText 缓存**：缓存键为 cwd，编译早于 `.codewiki` 最后提交则静默；`writtenCount=0` 不提醒；测试用换仓库绕开 60s 缓存（行312-385）。
- **wakeCompileSession 静默**：autoCommit 成功 → done 完全不唤醒会话（行529-530）；无 sessionId、冷会话、registry.get 抛、steer 抛、缺省 agents 均不抛仅跳过（行547-555）。
- **单项目串行**：A 用 stall 占推进权，B 提交进 `queued` 且排队期零请求；取消 A 后 B 自动轮到（行726-773）。
- **并发占位**：`serialProjects:false` 下并发提交共享同 jobId（行944 配置，行928-976 块）；预置外部实例 job 经 flush 合并不丢失（行937-938, 970-971）。
- **面板守卫**：非回环地址访问 jobs 端点 403（行990-991）；取消未知 jobId 404（行1024-1025）。
- **排除清单**：`excludePaths` 设后 compile 动作 400 拒绝且报错含“命中排除项”，子目录同样排除（行1056-1068）。
- **knownRepos 独立**：job 历史清空后 knownRepos 仍让 repos 总览发现仓库（行1087-1125）。
- **registry 异常**：`brokenRegistry` 使 `list()` 抛错，jobs/repos 端点降级不过滤仍 200（行57-59, 1190-1218）。
- **孤儿接管**：foreign 任务停更 6 分钟被接管并响应 cancelRequested，新鲜 foreign 不被抢（行1260-1292）。
- **模型缺失**：`batchProvider:''` 时 `codewiki_generate` 抛 “编译模型提供商为空”，且失败落 job.failed 留痕（行1294-1307）。
- **Temp 清理**：启动 tick 移除 Temp 目录终态任务，保留活动/工作区终态（行1333-1350）。
- **错误前缀改写**：`codewiki_update` 包装 `generate` 错误，消息前缀改写为 `codewiki_update`（行307-309）。
- **autoCommitWiki 安全边界**：只提交 `.codewiki/` 与 `CodeWiki.md`，非 git/被 gitignore/merge 进行中/缺 git identity 均拒绝（行405-506）。

### test-wiki-anchors.mjs 边界
- **锚点校验边界**：仅行内单锚点且存在符号时才做符号绑定，多锚点行仅兜底行号范围（行101-105）；区间锚点在整个区间搜符号（行106-112）；`symbolsOnLine` 拒绝含冒号/斜杠/空格非符号（行38-49）。

### test-wiki-entry.mjs 边界
- **入口生成边界**：`ensureWikiEntry('', lang)` 空 cwd 返回 false 不抛（行49）；`normalizeArticlePath(undefined)` 返回 `''`（行59）；`normalizeIndexLinks` 只改链接头反斜杠，正文反斜杠不受影响（行70）。

### test-batch.mjs 边界
- **Token/预算边界**：`estimateTokens` 空串 0，混合分别计费（行23-28）；`collectSources` 首文件超预算即 `oversized` 兜底返回首文件（行40-41），后续装不下进 `skipped`；多文件超预算拆观察批且每批 ≤110k token（行87-105）；单文件超大走会话通道 128k 大档，再超则全长装填（行78-84）；大档模型接管超 128k 单文件（行107-131）。
- **行号/格式**：`numberLines` 空文件输出 `1|`，双尾换行保留空行 `2| `，CRLF 剥离（行46-51）；`fixAnchors` 对未找到/歧义/不在清单/basename 歧义均不动并记 `unresolved`，区间尾部钳到文件尾，CRLF 保真（行453-495）。
- **会话通道收割**：`classifySessionTask` 超时（30min）判定优先于已产出（行139-141）；旧文未更新（mtime 早于派发）判 `wait`（行146-148）。
- **任务执行容错**：`runRealtimeTasks` 单任务失败仅记 `notes`、不落盘、不中断并发（行253-275, 323-338）；外部 `AbortController` 已 abort 则池子立即停止消费（行241-251）；`reasoningEffort` 未配置时从请求体省略而非传 undefined（行238）；`temperature` 硬编码 0（行202）。
- **模型/端点**：`listModelCatalog`/`resolveModelEfforts` 在 `llm=null` 或单 provider 抛错时诚实返回 `ok:false` 或保留错误条目，不抛异常（行360-361, 420-421）；HTTP 端点强制回环（`127.0.0.1` 放行，其它 403），缺参 400（行385-391, 438-445）。
- **档位钉死**：`buildSessionSteerText` 填 `tier` 时显式禁止自动选路，且 `review`/`resend` 场景文案不同但均钉死（行151-168）。
- **0.10.1 删除内置百炼通道**：`resolveBatchApiKey` 不再从 `./index.js` 导出（行448-451），插件不碰密钥。
- **scanRepoFiles 黑名单**：跳 node_modules/.git/二进制/超大(300*1024)/空（行303-318）。

### test-cwd-paths.mjs 边界
- **路径归一化**：`cw.execute` 将 Windows 盘符路径（`E:/x`）转 MSYS（`/e/x`）并跑通（行10, 30-45），且 Windows 下 `status` 返回真实三态而非 "No wiki found"（行47-57），证明 `resolveBinary` 选 PATH 探测而非捆绑副本；不存在 cwd 抛 `cwd 不存在`（行61-69）。
