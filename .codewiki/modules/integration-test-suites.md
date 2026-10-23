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

- `process.env.DSH_CODEWIKI_TICK_MS='300'`（行15）与 `DSH_CODEWIKI_JOBS_FILE` 临时隔离（行19）。
- 动态导入 `./index.js` 取 `{ name, apply }`（行20），以及 `commitHintText`（行284）、`wakeCompileSession`（行354）。
- `failures` 计数与 `check(cond,msg)`（行22-26）：断言累计失败。
- `articleMd(title,source,marker='Batch-written',type='module')`（行29-30）：拼 frontmatter 文章。
- `batchCfg(extra={})`（行34）：返回 `{ batchProvider:'workbuddy', batchModel:'hy3', ...extra }`。
- `makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（行45-77）：构造 cordis 风格 ctx，含 `inject`（行58-68）、`on`（行69）、`effect`（行73-77）立即执行并收集 disposer；内部 `services` 含 `webServer.register`、`agents.list/get`、`tools.register`、`llm`、`workspaceRegistry`。
- `makeMockAgent(cwd)`（行83-97）：构造 agent 与 systemPrompt section 注册。
- `makeFixtureRepo()`（行99-109）：建 git 仓库。
- `activeLlm` 与 `llmProxy`（行114-122）：`llmProxy.stream`/`listModels`/`resolveModel` 转发；未接线抛“测试未接线”（行117）。
- `promptOf(opts)`（行123）：取首消息文本。
- `makeBatchMock({modules,articleMarker,stall,bigArticle,bigSources,planReply})`（行127-189）：按 prompt 特征分发应答；`answerFor` 按特征回文本，stall 挂起至 abort（行164-170）；返回 `{llm,llmCalls,batchPrompts(),realtimePrompts(),restore()}`。
- `waitJob(cwd,{timeout=30000})`（行192-205）：轮询 JOBS_FILE 取终态。
- `fakeReq(body,addr='127.0.0.1',method='POST')`/`fakeRes()`（行207-219）：模拟端点。
- 测试分块：系统提示提醒（行222-250）、注册与 cw 工具（行252-270）、`codewiki_update`+`commitHintText` 单测（行272-349）、`wakeCompileSession` 终态 steer（行351-377）、规划阶段（行379-452）、全量编译（行454-484）、大 wiki 横切拆分（行486-514）、大模块文章分割（行516-548）、单项目串行（行550-597）、唯一通道 llm 服务（行599-631）、stale 逐篇更新（行633-654）、`codewiki_progress`（行656-692）、重启重跑（行693-747）、并发占位合并（行749-787）、面板端点与取消（行789-841）、排除清单/repos/compile（行843-896）、knownRepos/refresh（行898-936）、工作区过滤（行938-983）、registry 异常防御（行985-1013）、输出 schema 校验（行1015-1053）、孤儿任务接管（行1055-1087）、编译模型缺失报错（行1089-1102）、严格 cordis 语义（行1104-1126）、Temp 残留清理（行1128-1145）。局部异步函数 `readJobs`/`readRepos` 见于工作区过滤块（行958-970）。

### test-wiki-anchors.mjs

- `ROOT`/`WIKI`（行14-15）；`SOURCES` 映射 `'index.js'`/`'client.js'` 读取 `lines` 与 `total`（行16-24）。
- `check(cond,msg)`（行28-32）：返回 cond 供失败跳过。
- `symbolsOnLine(line)`（行38-49）：正则 `` /`([^`\n]+)`/g `` 提取反引号标识符，校验 `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$` 且长度>=3、尾段>=3，返回 `{sym,at}`。
- `nearestSymbol(syms,anchorIndex,anchorLen)`（行52-62）：取离锚点最近符号（同距取左侧）。
- `walk(dir)`（行64-73）：递归收集 `.md` 文件。
- `articles=walk(WIKI).sort()`（行75-79）：空则 exit 1。
- 遍历校验（行86-112）：逐行正则 `/(?:index|client)\.js[:：](\d+)(?:-(\d+))?/g` 提取锚点，单锚点且行内有符号时搜源文件区间。

### test-wiki-entry.mjs

- 导入 `ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus`（行10）。
- `check(cond,msg)`（行12-16）。
- `tmp` 与 `repo(name)`（行18-23）：建临时仓工厂。
- 测试1 缺失生成中文入口（行26-32）：`ensureWikiEntry(repo1,'中文')===true`，内容含 `.codewiki` 绝对路径等。
- 测试2 已有不覆盖（行34-39）：返回 false 且内容不变。
- 测试3 英文文案（行41-46）：`living wiki` 等。
- 测试4 空 cwd 返回 false 不抛（行48-49）。
- 测试5 重复幂等（行51-54）。
- 测试6 Windows 规范化（行57-72）：`normalizeArticlePath('learnings\\update-gap.md')==='learnings/update-gap.md'`、`undefined`→`''`；`parseStatus(stdout)` 解析 `\` 规范为 `/`；`normalizeIndexLinks(repo6)` 改写链接头反斜杠。

### test-batch.mjs

- 导入 `collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer`（行7-12）。
- `check(cond, msg)`（行16-19）：断言并累计 `passed`/`failures`。
- `section(name)`（行20）：打印分段。
- `mockJson(obj, status=200)`（行21）：返回模拟 `{ok, status, text}`。
- `makeLlm(reply)`（行144-159）：返回伪 llm 对象，含 `async *stream(opts)` 按 `reply` 吐出块协议流。
- `promptOf(opts)`（行160）：提取 `opts.messages[0].content[0].text`。
- 被测函数关键行为测试段：`estimateTokens`（行24-28）、`collectSources`（行30-44）、`numberLines`（行46-51）、`prepareArticleTasks`（行53-102）、`classifySessionTask`（行104-120）、`buildSessionSteerText`（行122-138）、`runRealtimeTasks`（行140-224,273-287）、`localPlan`（行226-237）、`packArticles`（行239-250）、`scanRepoFiles`（行252-266）、`listModelCatalog`（行289-311）、`installWebServer`（行313-341,375-394）、`resolveModelEfforts`（行343-373）、`resolveBatchApiKey` 已移除（行397-400）、`fixAnchors`（行402-444）。

### test-cwd-paths.mjs

- 导入 `path`, `fileURLToPath`, `import * as plugin from './index.js'`（行3-5）。
- `repoWin` 默认 `'E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin'`（行8）。
- `msys` 推导：`'/'+repoWin.replace(/^([A-Za-z]):\//, (_,d)=>d.toLowerCase()+'/')`（行10）。
- `cfgProbe` 默认配置（行26）。
- `execStub = {signal: undefined}`（行31）。
- `ctx.inject(_names, fn)` 提供 `{tools:{register}, subagents:{}}`（行13-18）。
- 执行：`await plugin.apply(ctx, {})` 注册（行20），取 `registered.cw`（行22-23）；MSYS 场景（行34-45）、Windows 场景（行48-57）、不存在路径（行62-69）。

## Architecture

测试脚本统一通过动态导入或 `plugin.apply` 加载被测 `./index.js`，构造 mock 上下文与伪 LLM 驱动服务阶段机或工具执行，最后轮询任务状态或检查文件落盘进行断言。

```text
┌────────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ test-orchestration │   │ test-wiki-entry  │   │ test-wiki-anch  │
│ .mjs (行22-1145)   │   │ .mjs (行10-72)   │   │ .mjs (行14-112) │
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
│ (行7-444)          │   │ .mjs (行3-69)  │   │                 │
└────────────────────┘   └────────────────┘   └──────────────────┘
```

## Data Flow

以 `test-orchestration.mjs` 为例：测试代码 → `makeCtx()` 生成 ctx → `apply(ctx, config)` 向 ctx 注册工具/端点（内部经 `ctx.inject` 取 services，含 `llm` 即 `llmProxy`）→ 从 `registered` 取 `codewiki_generate`/`cw`/`codewiki_update`/`codewiki_progress` 调 `.execute(args, {agent})` → 工具内部经 `llmProxy.stream` 调 `activeLlm`（由 `makeBatchMock()` 设置，行180）→ 服务阶段机推进写 `JOBS_FILE` → `waitJob(cwd)` 轮询得终态 job → 断言。面板端点经 `endpoints.find(e=>e.path===...).handler(fakeReq(...), fakeRes())` 调用（行578-580, 615-617）。

`test-batch.mjs` 数据流：用 `fs.mkdtempSync` 造临时目录，写入源码/文章；将路径与任务描述传入 `prepareArticleTasks` 等，得到 `{prepared, sessionTasks}` 或 prompt 字符串，再喂给 `runRealtimeTasks(tasks, opts)` 断言返回 `Map<customId, {ok, content?}>` 及磁盘落盘；`installWebServer` 注入伪 `ctx` 得 `routes` Map，以伪 `req{url, socket.remoteAddress}`/`res{writeHead, end}` 调 handler 验 HTTP 行为。

`test-cwd-paths.mjs` 数据流：构造 `cwd`（MSYS/Windows/不存在）与 `args` 传入 `cw.execute`，取回 `{exitCode, stdout}` 或异常 `message` 做断言。

`test-wiki-anchors.mjs` 数据流：读 `SOURCES` 源码行 → `walk(WIKI)` 收集 md → 逐行正则提取锚点 → 在源文件区间搜符号绑定。

`test-wiki-entry.mjs` 数据流：建临时 repo → 调 `ensureWikiEntry`/`normalizeArticlePath` 等 → 检查返回布尔与文件内容。

## Connections

- 被测核心服务：[[dsh-codewiki]]（即 `./index.js` 导出的 `apply` 与工具）
- 上下文框架：[[cordis]]（`makeCtx` 模拟其 `inject`/`effect` 语义）
- 相关测试资产：[[codewiki-cli]]（`cw` 工具调用真实 CLI）
- 锚点校验依赖源文件：[[index.js]] 与 [[client.js]]（被 `test-wiki-anchors.mjs` 静态读取）

## Known Issues

### 边界与非显然行为（来自观察）

- **cordis 语义**：`makeCtx` 的 `effect` 立即执行 body，错写 `ctx.effect(()=>service.stop())` 会当场 stop 致 tick 停摆（行71-77）；严格语义下未 inject 访问 `ctx.agents` 抛错，但 `apply` 不抛且工具仍注册（行1104-1126）。
- **LLM 接线**：`llmProxy.stream` 若 `activeLlm` 未接线抛 “测试未接线”（行117）；stall 模式不返回，挂起至 `opts.signal` abort（行164-170）。
- **规划降级**：planReply 非 JSON 时降级本地按顶层目录分组，任务仍 done（行414-432）。
- **commitHintText 缓存**：缓存键为 cwd，编译早于 `.codewiki` 最后提交则静默；`writtenCount=0` 不提醒；无匹配 job 返回空；测试用换仓库绕开 60s 缓存（行306-346）。
- **wakeCompileSession 静默**：无 sessionId、冷会话（get 返回 undefined）、registry.get 抛、steer 抛、缺省 agents 均不抛仅跳过（行368-376）。
- **单项目串行**：A 用 stall 占推进权，B 提交进 `queued` 且排队期零请求；取消 A 后 B 自动轮到（行550-597）。
- **并发占位**：`serialProjects:false` 下并发提交共享同 jobId；预置外部实例 job 经 flush 合并不丢失（行749-787）。
- **面板守卫**：非回环地址访问 jobs 端点 403（行801）；取消未知 jobId 404（行834-836）。
- **排除清单**：`excludePaths` 设后 compile 动作 400 拒绝且报错含“命中排除项”，子目录同样排除（行866-879）。
- **knownRepos 独立**：job 历史清空后 knownRepos 仍让 repos 总览发现仓库（行916-930）。
- **registry 异常**：`brokenRegistry` 使 `list()` 抛错，jobs/repos 端点降级不过滤仍 200（行985-1013）。
- **孤儿接管**：foreign 任务停更 6 分钟被接管并响应 cancelRequested，新鲜 foreign 不被抢（行1055-1087）。
- **模型缺失**：`batchProvider:''` 时 `codewiki_generate` 抛 “编译模型提供商为空”，且失败落 job.failed 留痕（行1089-1102）。
- **Temp 清理**：启动 tick 移除 Temp 目录终态任务，保留活动/工作区终态（行1128-1145）。
- **锚点校验边界**：仅行内单锚点且存在符号时才做符号绑定，多锚点行仅兜底行号范围（test-wiki-anchors.mjs:38-49）；区间锚点在整个区间搜符号；`symbolsOnLine` 拒绝含冒号/斜杠/空格非符号（行43-45）。
- **入口生成边界**：`ensureWikiEntry('', lang)` 空 cwd 返回 false 不抛（test-wiki-entry.mjs:49）；`normalizeArticlePath(undefined)` 返回 `''`（行59）；`normalizeIndexLinks` 只改链接头反斜杠，正文反斜杠不受影响（行65-71）。
- **Token/预算边界**（test-batch.mjs）：`estimateTokens` 空串 0；`collectSources` 首文件超预算即 `oversized` 兜底返回首文件；多文件超预算拆观察批且每批 ≤110k token（行97）；单文件超大走会话通道 200k 大档，超大兜底已删。
- **行号/格式**：`numberLines` 空文件输出 `1|`；`fixAnchors` 对未找到/歧义/不在清单/basename 歧义均不动并记 `unresolved`，区间尾部钳到文件尾，CRLF 保真。
- **会话通道收割**：`classifySessionTask` 超时（30min）判定优先于已产出；旧文未更新（mtime 早于派发）判 `wait`。
- **任务执行容错**：`runRealtimeTasks` 单任务失败（`Error` 或流 `finish kind=error`）仅记 `notes`、不落盘、不中断并发；外部 `AbortController` 已 abort 则池子立即停止消费。
- **模型/端点**：`listModelCatalog`/`resolveModelEfforts` 在 `llm=null` 或单 provider 抛错时诚实返回 `ok:false` 或保留错误条目，不抛异常；HTTP 端点强制回环（`127.0.0.1` 放行，其它 403），缺参 400。
- **路径归一化（非显然）**：`cw.execute` 将 Windows 盘符路径（`E:/x`）转 MSYS（`/e/x`）并跑通，且 Windows 下 `status` 返回真实三态而非 "No wiki found"，证明 `resolveBinary` 选 PATH 探测而非捆绑副本；不存在 cwd 抛 `cwd 不存在`。
- **档位钉死**：`buildSessionSteerText` 填 `tier` 时显式禁止自动选路，且 `review`/`resend` 场景文案不同但均钉死。
- **0.10.1 删除内置百炼通道**：`resolveBatchApiKey` 不再从 `./index.js` 导出（test-batch.mjs:400-403），插件不碰密钥。

以上 Known Issues 实际是测试覆盖的边界与防御行为，并非模块自身缺陷，而是验证资产所固化的非显然语义。