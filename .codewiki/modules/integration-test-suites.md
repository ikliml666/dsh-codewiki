---
title: integration-test-suites
type: module
source_files:
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-batch.mjs
  - test-cwd-paths.mjs
  - index.js
  - client.js
tags: [integration-test, node-esm, codewiki, validation-assets, cordis]
---

## Overview

本模块是一组 Node ESM 集成测试，覆盖 `dsh-codewiki` 服务的批量执行、工作目录路径解析、编排流程以及 wiki 锚点与入口生成。测试文件与运行期日志同名对应，构成可追溯的验证资产。包含五个测试脚本：`test-orchestration.mjs`（服务化编排冒烟，行1-1529）、`test-wiki-anchors.mjs`（wiki 行号锚点校验，行1-118）、`test-wiki-entry.mjs`（CodeWiki.md 入口生成与 Windows 路径规范化，行1-76）、`test-batch.mjs`（编译执行链自检，行1-570）、`test-cwd-paths.mjs`（0.2.3 路径修复验证，行1-71）。

当前代码基线：0.10.1 起插件不再直连任何端点、唯一模型通道是宿主 llm 服务（编译模型必须显式指向模型设置里的 provider/model，provider 留空即提交失败）；0.10.4 起大档模型接管超长输入；0.10.11 起 `autoCommitWiki` 采用「主题分支提交→合并回原分支」；0.12.1/1.2.1 起空壳目录闸门与面板过滤；0.12.2 起大档/默认档并发分池；0.13.0 起三档「吸收自 FSoft CodeWiki」的能力（语义规划/agentic 写作/符号级增量）默认全开，但本套件以 `LEGACY_CHANNEL` 把三者钉在关闭态继续守护旧通道（test-orchestration.mjs:44-45，理由见行36-43 注释：断言的是旧通道的请求次数、装填方式与落盘时序，不钉住会因「通道换了」而非「功能坏了」失败），新通道验证见 test-agentic-host.mjs / test-semantic-plan.mjs / test-incremental*.mjs（行42-43 注释指向）；1.1.0 起支持并行项目上限与 `queueAhead`；1.2.0 起全局会话 Tab 与 worktree 闸门。

## Key Components

### test-orchestration.mjs（服务化编排冒烟）

- 环境加速与隔离：`process.env.DSH_CODEWIKI_TICK_MS = '300'`（行15，生产默认 10s，服务侧下限 250ms 见 index.js:1311）；`process.env.DSH_CODEWIKI_JOBS_FILE` 独立指向 tmp 防与真实宿主实例互洗（行18-23），文件名追加随机 token `TEST_JOB_TOKEN`（行22-23）——只用 pid 时历史运行留在 tmp 的同名文件会在 pid 复用时被原样读入，让「单项目串行」误判（行19-21 注释）；`const { name, apply, SESSIONS_DIR } = await import('./index.js')`（行24，`SESSIONS_DIR` 定义于 index.js:1311），`SESSIONS_DIR` 在 1.2.0 块尾清理（行1411）。
- 断言辅助：`let failures = 0`（行26），`function check(cond, msg)` 累计失败计数（行27-30）；`const JOBS_FILE = process.env.DSH_CODEWIKI_JOBS_FILE`（行32）；文章模板 `const articleMd = (title, source, marker = 'Batch-written', type = 'module') =>`（行33-34）。
- 测试配置基线（行36-45）：0.10.1 起编译模型必须显式（行36-37）；0.13.0 起三档能力默认全开但本套件钉住关闭（行38-43）；`const LEGACY_CHANNEL = { planMode: 'dirs', agenticArticles: false, symbolIncremental: false }`（行44）；`const batchCfg = (extra = {}) => ({ batchProvider: 'workbuddy', batchModel: 'hy3', ...LEGACY_CHANNEL, ...extra })`（行45）——个别块再覆盖，如并行块 `batchCfg({ serialProjects: false, parallelProjects: 3 })`（行799）、并发占位块 `batchCfg({ serialProjects: false })`（行991）。
- Mock 宿主上下文：`function makeCtx({ agents = [], workspaces = null, brokenRegistry = false, agentGet = null, llm = null } = {})`（行51-91），返回 `{ ctx, registered, endpoints, listeners, disposers }`（行90）；`services` 含 `webServer.register`（行57）、`agents.list/get`（行58）、`tools.register`（行59）、`llm`（行60，默认 `llmProxy`）、`workspaceRegistry.list`（行63 正常形态 / 行64-67 `list()` 抛错形态，0.4.9c 真宿主 jobs/repos 400 的候选根因）；`inject` 支持 cordis 回调（传「ctx 切片」而非实例，行70-75）与 promise 双风格（行76-78）；`on` 监听（行80）；`effect` 立即执行 body 并收集 disposer（行84-88，防线注释行81-83：错写 `ctx.effect(() => service.stop())` 会让 tick 停摆、`waitJob` 挂死）。
- Mock Agent：`function makeMockAgent(cwd)`（行94-108）造 agent，`ctx.inject` 返回 `systemPrompt` 切片，`getSectionOrder` 对 `TOOL_REPORT` 返 2900（行101），`section` 收集进 `sections`（行102）。
- Fixture 仓库：`function makeFixtureRepo()`（行110-127）建 git 仓库含 `core/`、`util/` 两目录与 `core/core.py`、`util/util.py`（行114-117，0.10.7 删规划阶段后模块清单由 localPlan 按顶层目录分组、fixture 结构直接决定模块名，行112-113 注释），并自带 git identity（行122-123，0.10.9 起 `autoCommitWiki` 缺 identity 拒绝自动提交，行120-121 注释）。
- LLM 代理与 Mock：`let activeLlm = null`（行132）与 `const llmProxy =`（行133-140）唯一通道转发（未接线抛「测试未接线」行135），`makeBatchMock()` 一处接线即可（行129-131 注释）；`const promptOf = (opts) =>`（行141）取 `messages[0].content[0].text`。
- 批量 Mock：`function makeBatchMock({ modules = ['core', 'util'], articleMarker = 'Batch-written', stall = false, bigArticle = false } = {})`（行145-209）；`answerFor`（行147-177）按 prompt 首行特征分发：文章观察员（行148-151）、文章作者（行152-155）、架构观察员（行156-158）、写系统总览（行159）、总结仓库反复出现的模式（行160）、写跨模块概念（行161）、审校员（行162-175，0.10.8 批量校对按 `@@@article` 标记逐篇回标记格式）；`stream` 生成器按宿主 block 协议 yield（行180-197），`stall` 时挂起至客户端 abort（行184-191，取消语义），`bigArticle` 时追加 70000 字（行193）；返回 `{ llm, llmCalls, batchPrompts, realtimePrompts, restore }`（行201-208，`restore` 支持块间嵌套行206-207）。
- 轮询与 HTTP Mock：`async function waitJob(cwd, { timeout = 30000 } = {})`（行212-225）轮询 JOBS_FILE 找 `done/failed/cancelled` 终态（行221）；`function fakeReq`（行227-236）/ `function fakeRes`（行237-239）mock HTTP。
- 测试块（`console.log` 标题 + 断言，直接执行）：系统提示提醒（行241-270）、注册与 cw 工具（行272-290）、codewiki_update+commitHintText（行292-410）、autoCommitWiki（行412-513）、autoCommitState（行515-525）、wakeCompileSession（行527-563）、本地规划（行565-622）、全量编译阶段机（行624-665）、大 wiki 横切拆分（行667-695）、大模块文章分割（行697-731）、单项目串行（行733-789）、并行项目上限（行791-820）、唯一通道（行822-854）、stale 逐篇更新（行856-877）、codewiki_progress（行879-915）、宿主重启重跑（0.6.0，行916-973，场景 A：stage-* 任务按 `batchPrompt` 快照重跑行918-944；场景 B：0.10.6 及更早 plan 阶段任务迁移到 articles 按 localPlan 重建行946-971）、并发提交占位（行975-1023）、面板端点与取消（行1025-1077）、排除清单/repos/compile（行1079-1132）、knownRepos/refresh（行1134-1172）、工作区过滤（行1174-1235）、registry 异常（行1237-1265）、输出 schema 校验（行1267-1305）、孤儿接管（行1307-1339）、全局会话 Tab+worktree 闸门（行1341-1412）、空壳目录闸门（行1414-1463）、编译模型缺失（行1465-1478）、严格 cordis（行1480-1502）、Temp 残留清理（行1504-1521）、收尾清理（行1523-1528）。
- 动态导入符号：`const { commitHintText } = await import('./index.js')`（行304）、`const { autoCommitWiki } = await import('./index.js')`（行415）、`const { autoCommitState } = await import('./index.js')`（行518）、`const { wakeCompileSession } = await import('./index.js')`（行530）。
- 同构校验器：`const validateOut = (schema, v) =>`（行1271-1286，位于行1267-1305 输出 schema 块）本地校验与宿主同构（属性存在时类型必须匹配，null 不是 string）。
- 持久化 job 对象字段示例（行923-932）：`id, cwd, kind, scope, language, stage, owner, wikiPath, plan{project, modules[{name, summary, files}], concepts[]}, batchRef{batchId}, tasks[{customId, name, articlePath, keepInMemory, batchPrompt}], articles[], writtenCount, failedCount, notes[], createdAt, updatedAt`；运行时扩展字段：`autoCommit{committed, sha, mode, branch, noChanges, reason}`（行638、640）、`stageTimings`（行639）、`usage{outputTok, realtimeRequests}`（行845-846）、`queueAhead`（行757-764）、`batchProgress`（行1049-1050）、`batchSubmittedAt`（行1059-1060）、`taskList`（行887、1051-1052）、`tps`（行842）、`progress`（行886、910）、`stageStartedAt`（行843）。
- 会话唤醒捕获：`const e2eSteers = []`（行275）与 `main` ctx 的 `agentGet`（行276）捕获 `sess-e2e` 的 steer 消息，供全量编译块断言「插件已自动提交 → 编译完成不唤醒会话」（行652）；本地规划块 apply 过新 ctx 后恢复 main 的 agentsRef（行621）。

### test-wiki-anchors.mjs（行号锚点校验）

- 定位（行1-8 注释）：流水线产物曾系统性幻觉 `index.js:` 行号（偏移 34~760 行、校对阶段拦不住），本测试把「锚点必须对照真实源码核对」制度化——基础断言（行号落在文件行数内且该行非空）、符号绑定断言（同行反引号内符号必须出现在锚点行/区间）、区间断言（`NNN-MMM` 起止有序）。任何失败 exit 1（行8、117-118）。
- 源加载：`ROOT`/`WIKI`（行14-15）；`SOURCES` 声明 index.js 与 client.js 两个被锚点引用的源文件（行16-19）并缓存行数组与总行数（行20-24）；`check` 返回 cond 供 `if (!check(...)) continue` 短路（行28-32，行31 注释）。
- 符号提取：`function symbolsOnLine(line)`（行38-49）提取行内反引号代码标识符（带下标 `at`），去参数/调用括号（行42），正则 `^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$`（行43），长度 ≥3 且尾段 ≥3（行44-45，排除 CodeWiki.md/_index.md 尾段）；带下标是为了把锚点绑定到「离它最近」的符号（行36-37 注释）。
- 最近符号：`function nearestSymbol(syms, anchorIndex, anchorLen)`（行52-62）同距取左侧（中文行文多为「符号（`file:NN`）」，行51 注释）——该辅助函数当前主循环未调用，符号绑定改用 `syms.some` 对全部候选命中判定（行107-110）。
- 文件遍历：`function walk(dir)`（行64-73）递归收集 .md；空 wiki 直接 exit 1（行76-79）。
- 主校验循环（行82-115）：锚点正则 `/(?:index|client)\.js[:：](\d+)(?:-(\d+))?/g`（行86）；起始行在范围内（行95）、指向非空行（行96）、区间起止有序且终点在范围内（行97-100）；符号绑定只在「本行只有一个锚点」时校验（行101-104 注释：多锚点行无法可靠归属，强行绑定会系统性误判），区间锚点在整个区间内搜符号（行105-106），命中允许全名或尾段（行107-110）；总结 `passed`/`failures` 并 exit（行117-118）。

### test-wiki-entry.mjs（入口生成与路径规范化）

- 静态导入 `ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus` from './index.js'（行10）。
- 辅助：`check`（行12-16）；`const tmp`（行18）与 `const repo = (name) =>`（行19-23）。
- `ensureWikiEntry` 测试（行25-54）：缺失生成中文入口（行27，内容含 `.codewiki` 绝对路径行29、`codewiki_generate` 收尾工具行30、`.codewiki/_architecture.md` 行31、「不会覆盖」声明行32）；已有入口绝不覆盖（行38-39）；英文语言生成英文文案（行43-46，行45 断言含 `living wiki` 不含「活 wiki」）；空 cwd 返 false 不抛（行49）；重复调用幂等（行53-54）。
- Windows 路径规范化（行56-72）：`normalizeArticlePath`（行57-59）`\`→`/`、undefined→`''`；`parseStatus`（行60-62）changedFiles 保留并规范化、staleArticles 的 `\` 规范化为 `/`；`normalizeIndexLinks`（行63-72）改 `_index.md` 链接头 `[[modules\core|core]]`→`[[modules/core|core]]`（行69）、正文反斜杠不动（行70）、幂等（行71）、无 `_index.md` 静默返 false（行72）。

### test-batch.mjs（编译执行链自检）

- 导入清单（行7-12）：`collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer` 来自 `./index.js`。
- 基座：`let passed`/`const failures`（行14-15）、`check`（行16-19）、`section`（行20）、`mockJson`（行21，预留未用）。
- `estimateTokens` 测试（行23-28）：CJK 每字 1 token、ASCII `ceil(n/3.5)`、空串 0、混合分别计费。
- `collectSources(root, files, budget?)` 测试（行30-44）：内容内联带 `### 相对路径` 标题与 `行号| ` 前缀（行36）；缺失文件文内标「文件不存在」（行37）；预算充足无跳过（行38）；尾换行只去一个（行39）；首文件即超预算 → `oversized:true` 且原文兜底返回（行40-41）；装不下第二文件 → `skipped`（行42-44）。
- `numberLines` 测试（行46-51）：单尾换行末行 `2| b`、双尾换行保留真实空行 `2| `、CRLF 剥 `\r`、空文件输出 `1|`。
- `prepareArticleTasks` 测试：基础装填（行53-84）——返回 `{prepared, sessionTasks}`；`customId` 按序（行68）；prompt 含 mission/语言/内联源码/frontmatter 规范（行69-71）；旧文作上下文进 prompt（行72-76）；单文件超 110k 但装得进 128k 大档 → 大档单请求不转会话通道（0.10.2，行77-81）；单文件连 128k 都装不下 → `sessionTasks` 唯一兜底且 prompt 按原始全长装填（行82-84）。多文件超预算 → 观察→合成分割（行86-105）——拆出 ≥2 个观察批、`keepInMemory:true`（行99）、每批 ≤110k token（行100）、`splitFor`/`composePlan` 元数据（行101-102）、prompt 标批次序号（行103）、不进会话通道（行96）。
- 大档模型接管（0.10.4，行107-131）：配置 `{ bigProvider: 'volces-ark', bigModel: 'glm-5.3-flash', bigReasoningEffort: 'high', bigBudget: 420000 }`（行109），超 128k 单文件改由大档单请求（带 `bigTier` 标记与自带 provider/model/档位，行114-120），关掉大档（`bigProvider: ''`）退回会话通道（行121-125），普通任务不被误标大档（行126-131）。
- `classifySessionTask` 测试（行133-149）：>30 分钟未见产出 → `timeout`（行139）；超时判定优先于已产出（行140-141）；产出且以 frontmatter 开头 → `harvest`（行142）；写一半（无 frontmatter）→ `wait`（行143-144）；目标文件 mtime 早于派发时间 → `wait`（行145-148）。
- `buildSessionSteerText` 测试（行151-167）：`tier` 空不提档位（行154-155）；填 `tier` 则文本要求显式传 `tier: "codeiwiki"` 且禁止依赖自动选路（行156-158）；任务文件与目标路径写进文本、无模板占位符残留（行159-160）；`stage:'review'` 文案按校对措辞且仍钉死档位（行161-163）；`resend:true` 带「重新派发」并钉档（行164-165）；未填档位重发不提（行166-167）。
- `runRealtimeTasks` 测试：基础路由（行169-205，`makeLlm(reply)` 工厂行173-188 支持 reply 为字符串/函数/Error，`promptOf` 行189）——每任务一次流式调用、按 provider/model 路由、`reasoningEffort` 原样下发、`temperature` 固定 0（行199-203）；磁盘任务落盘、keepInMemory 结果带 content（行204-205）。混合档分派（行207-228）：大档任务按自带 provider/model/档位路由、未指定档位不回落普通档（行225-227）。并发分池（0.12.2，行229-296）：`makeSlowLlm`（行232-242）+ `poolProbe`（行243-258）统计两池峰值——`concurrency:2, bigConcurrency:1` 下默认档打满 2、大档独立限 1、两池同时推进（行263-282）；`bigConcurrency` 缺省/0 跟随默认档（行283-296）。tps 采样（行298-308）：`onTaskDone` 上报 `outputTokens`/`durationMs`（行306）；未配置思考程度不下发 `reasoningEffort`（行307）。外部 signal 中止（行310-320）：已 abort 的池子立即停止消费（行319）。失败记账（行322-344）：失败进 `notes` 不中断其他、失败任务不落盘（行342-343）。
- `localPlan(files)` 测试（行346-357）：按顶层目录分组、根文件归 `root`、不造概念（`concepts: []`）。
- `packArticles(articles, budget)` 测试（行359-370）：预算内整篇装填；超预算后续文章只装头部（含 frontmatter 与 Overview）并标「仅头部」（行367-368）。
- `scanRepoFiles(root)` 测试（行372-386）：跳过 `node_modules`/`.git`/二进制后缀/超大（300×1024）/空文件，只收有效源码，返回项含 `path` 与 `bytes`。
- 失败通道错误码透传（行392-407）：`finish kind=error` → 任务失败，错误码（如 `NO_ADAPTER`）进 notes（行405-406）。
- `listModelCatalog(llm)` 测试（行409-431）：跳过无 id 的 provider（行424）；取 `displayName` 作展示名（行425）；兼容 `{provider, name}` 写法（行427）；单 provider `listModels` 抛错时条目保留 `error` 不影响其它（行428）；`llm` 为 `null` → `{ok:false, providers:[]}`（行429-430，设置页降级手填）。
- `installWebServer` + `/api/codewiki/models` 测试（行433-461）：注入假 `webServer.register` 收集路由（行446）；回环请求 → 200 且 `ok:true` 返回宿主 provider/model（行455-456）；非回环 → 403 `loopback only`（行458-460）。
- `resolveModelEfforts` + `/api/codewiki/model-efforts` 测试（行463-515）：`resolveModel` 返回 `{context:{tokens}, reasoning:{defaultEffort, efforts}}`；解析出档位/默认档/上下文长度（行482-486）；未知模型 → `ok:false` 带 error 不抛（行487-488）；`llm` 未注入 → 诚实报错含 `resolveModel`（行489-490）；模型未声明档位 → `ok:true` 空列表（行491-493）；端点回环+完整参数 200（行506-508）、缺 `model` 参数 400（行509-511）、非回环 403（行512-514）。
- 0.10.1 通道移除校验（行517-520）：动态 `import('./index.js')` 断言 `resolveBatchApiKey === undefined`（插件不碰任何密钥）。
- `fixAnchors(articleText, rootDir)` 测试（行522-564）：返回 `{fixed, text, unresolved}`；仅处理 frontmatter `source_files` 列出的文件；错行号唯一符号修正（行538-539）；起点行含符号视为已正确不动（行540）；符号未找到记 `unresolved` 不动（行541）；多声明歧义不动（行542-543）；多处出现但恰一处声明形态 → 取声明行（行544-545）；区间锚点起点对齐符号、尾部钳到文件尾（行546-549）；basename 唯一解析修正并保留原文写法（行550-553）；不在清单不碰（行554）；CRLF 行尾保真（行555-556）；无 frontmatter 原样（行557）；basename 根与子目录同名歧义不碰（行558-562）。
- 汇总输出（行566-570）：`ALL PASS` 或 `FAIL` 明细并 exit 1。

### test-cwd-paths.mjs（cwd 形态验证）

- 用法（行2）：`node test-cwd-paths.mjs <真实仓库路径的 Windows 形式>`；`const repoWin = process.argv[2] ?? 'E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin'`（行8），`const msys =`（行10）从 Windows 形式推导 MSYS 形式（`E:/x` → `/e/x`）。
- 假 `ctx.inject`（行12-18）收集 `tools.register`；`await plugin.apply(ctx, {})`（行20）后取 `registered.cw`（行22-23）。
- resolveBinary 验证策略（行25-28 注释）：不直接验证（未导出），通过 MSYS 路径能跑通间接证明归一化 + PATH 探测生效；捆绑副本一致性由外部 sha256 完成。
- MSYS 测试（行30-45）：`execStub = { signal: undefined }`（行31），`cw.execute({cwd: msys, args:['path']}, execStub)`（行34）期望 exit 0 且 stdout 匹配 `.codewiki$`（行41-44）。
- Windows 测试（行47-57）：`cw.execute({cwd: repoWin, args:['status']})`（行48）期望 exit 0 且不含 `No wiki found`（行53-56）——证明 `resolveBinary`（index.js:140）选 PATH 里的 cw 而非过期的捆绑副本（行54-55）。
- 不存在路径（行61-69）：必须抛错且 message 含 `cwd 不存在`（行67）；`console.log('ALL PASS')`（行71）。

### 被测导出一览（index.js）

| 导出 | index.js 行 | 覆盖测试 |
| --- | --- | --- |
| `apply` | 3969 | test-orchestration.mjs:272-284；test-cwd-paths.mjs:20 |
| `ensureWikiEntry` | 246 | test-wiki-entry.mjs:25-54 |
| `normalizeArticlePath` | 199 | test-wiki-entry.mjs:57-59 |
| `normalizeIndexLinks` | 203 | test-wiki-entry.mjs:63-72 |
| `parseStatus` | 213 | test-wiki-entry.mjs:60-62 |
| `estimateTokens` | 394 | test-batch.mjs:23-28 |
| `numberLines` | 557 | test-batch.mjs:46-51 |
| `collectSources` | 656 | test-batch.mjs:30-44 |
| `fixAnchors` | 568 | test-batch.mjs:522-564 |
| `prepareArticleTasks` | 727 | test-batch.mjs:53-131 |
| `runRealtimeTasks` | 469 | test-batch.mjs:169-344 |
| `classifySessionTask` | 1450 | test-batch.mjs:133-149 |
| `buildSessionSteerText` | 1467 | test-batch.mjs:151-167 |
| `localPlan` | 862 | test-batch.mjs:346-357；test-orchestration.mjs:565-622（间接） |
| `packArticles` | 971 | test-batch.mjs:359-370 |
| `scanRepoFiles` | 1535 | test-batch.mjs:372-386 |
| `listModelCatalog` | 3417 | test-batch.mjs:409-431 |
| `resolveModelEfforts` | 3455 | test-batch.mjs:463-515 |
| `installWebServer` | 3479 | test-batch.mjs:433-461、463-515 |
| `autoCommitWiki` | 3807 | test-orchestration.mjs:412-513 |
| `autoCommitState` | 1671 | test-orchestration.mjs:515-525 |
| `wakeCompileSession` | 1678 | test-orchestration.mjs:527-563 |
| `commitHintText` | 3891 | test-orchestration.mjs:292-410 |
| `detectLinkedWorktree` | 309 | test-orchestration.mjs:1374-1410（间接，经 submit 闸门） |
| `hasCompilableSources` | 352 | test-orchestration.mjs:1414-1463（间接，经空壳闸门） |
| `isDeadCompileTarget` | 378 | test-orchestration.mjs:1414-1463、1504-1521（间接，经面板过滤与启动清理） |
| `SESSIONS_DIR` | 1311 | test-orchestration.mjs:24（导入）、1411（清理） |

## Architecture

```text
┌────────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ test-orchestration │   │ test-wiki-entry  │   │ test-wiki-anch  │
│ .mjs (行1-1529)    │   │ .mjs (行1-76)    │   │ .mjs (行1-118)  │
└─────────┬──────────┘   └────────┬─────────┘   └────────┬────────┘
          │ import {name,apply,   │ import funcs         │ read src
          │  SESSIONS_DIR}        │                      │
          ▼                      ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│ ./index.js（外部被测模块：dsh-codewiki 服务）+ client.js       │
└──────────────────────────────────────────────────────────────┘
          ▲                      ▲                      │
          │ mock ctx/llm         │ real cw CLI          │ static check
┌─────────┴──────────┐   ┌───────┴────────┐   ┌────────┴─────────┐
│ test-batch.mjs     │   │ test-cwd-paths │   │ llmProxy/makeLlm │
│ (行1-570)          │   │ .mjs (行1-71)  │   │ fakeReq/fakeRes  │
└────────────────────┘   └────────────────┘   └──────────────────┘
```

## Data Flow

### test-orchestration.mjs 数据流

测试代码 → `makeCtx()`（行51-91）生成 ctx → `apply(ctx, config)`（行24 导入、行278 首次 apply）注册工具/端点（内部经 `ctx.inject` 取 services，`llm` 即 `llmProxy` 行133-140）→ 从 `registered` 取 `codewiki_generate`/`cw`/`codewiki_update`/`codewiki_progress`（行280-284）调 `.execute(args, {agent})` → 工具内部经 `llmProxy.stream` 调 `activeLlm`（由 `makeBatchMock()` 接线，行145-209）→ 服务 tick 推进阶段机写 `JOBS_FILE` → `waitJob(cwd)`（行212-225）轮询得终态 job → 断言。面板端点经 `endpoints.find(e=>e.path===...).handler(fakeReq(...), fakeRes())`（行227-239）调用；面板读取路径（jobs/repos/sessions/models/model-efforts）均由 `installWebServer`（index.js:3479）注册进 `main.endpoints`。

### test-batch.mjs 数据流

用 `fs.mkdtempSync` 造临时目录并写入源码/文章；将路径与任务描述传入 `prepareArticleTasks`（行53-131）等，得到 `{prepared, sessionTasks}` 或 prompt 字符串，再喂给 `runRealtimeTasks(tasks, opts)`（行169-344）断言返回 `Map<customId, {ok, content?}>` 及磁盘落盘；`installWebServer`（行433-461、463-515）注入伪 `ctx` 得路由 handler，以伪 `req{url, socket.remoteAddress}`/`res{writeHead, end}` 调 handler 验 HTTP 行为。

### test-cwd-paths.mjs 数据流

构造 `cwd`（MSYS/Windows/不存在）与 `args` 传入 `cw.execute`（行30-69），取回 `{exitCode, stdout}` 或异常 `message` 做断言；`execStub = { signal: undefined }`（行31）。

### test-wiki-anchors.mjs 数据流

读 `SOURCES` 源码行（行16-24）→ `walk(WIKI)`（行64-73）收集 md → 逐行正则提取锚点（行38-49、86）→ 在源文件行/区间内搜符号绑定（行105-111）→ 汇总 exit（行117-118）。

### test-wiki-entry.mjs 数据流

建临时 repo（行18-23）→ 调 `ensureWikiEntry`/`normalizeArticlePath`/`parseStatus`/`normalizeIndexLinks`（行25-72）→ 检查返回布尔与文件内容。

## Connections

- 被测核心服务：[[dsh-codewiki]]（即 `./index.js` 导出的 `apply`（index.js:3969）与 cw/codewiki_generate/codewiki_update/codewiki_progress 四个工具）
- 上下文框架：[[cordis]]（`makeCtx` 模拟其 `inject`/`effect` 语义，test-orchestration.mjs:51-91；严格语义另测于行1480-1502）
- 相关测试资产：[[codewiki-cli]]（`cw` 工具调用真实 CLI，test-cwd-paths.mjs:20-23）
- 锚点校验依赖源文件：[[index.js]] 与 [[client.js]]（被 `test-wiki-anchors.mjs` 静态读取，test-wiki-anchors.mjs:16-24）

## Known Issues

以下条目实为测试固化的非显然语义与边界防御，并非模块缺陷：

### test-orchestration.mjs 边界

- **LEGACY_CHANNEL 钉住（0.13.0）**：三档 FSoft 能力默认全开，但本套件显式关掉（行44-45）——否则规划阶段多吃一次模型请求、agentic 通道绕开装填，断言会因「通道换了」而不是「功能坏了」失败（行38-41 注释）。
- **cordis 语义**：`inject` 传 ctx 切片而非实例（行70-75）；`effect` 错写 `ctx.effect(() => service.stop())` 会当场调用致 tick 停摆（行81-88 注释）；严格语义下未 inject 访问 `ctx.agents` 抛错（`Object.defineProperty` 行1494-1496），但 `apply` 不抛且工具仍注册（行1498-1501）。
- **LLM 接线**：`llmProxy.stream` 若 `activeLlm` 未接线抛「测试未接线」（行135）；stall 模式挂起至 `opts.signal` abort（行184-191）。
- **本地规划**：0.10.7 起删规划阶段，模块清单由 localPlan 按顶层目录分组生成（行565-622），fixture 结构直接决定模块名（行112-117）；场景 1 断言请求按配置 provider/model 发出、不沿用会话主模型身份（行586-589）；全程无勘探员请求（行590、615、635、679）；「规划应答非 JSON → 降级本地分组」场景已删，本地分组是唯一路径（行602 注释）；本地规划 `concepts` 恒空数组（行595）。
- **commitHintText 缓存与静默**：缓存键为 cwd，测试用换仓库绕开 60s 缓存（行336、339-340、350、377 注释）；编译早于 `.codewiki` 最后提交静默（行348-349）；`writtenCount=0` 静默（行380-381）；`autoCommit.committed`/`noChanges` 一律静默（0.10.10，行383-392）；提交被拒（pending）→ 提醒且带失败原因（行393-407）。
- **wakeCompileSession 静默**：autoCommit 成功 → done 完全不唤醒（行536-537）；`noChanges` → 同样不唤醒（0.10.10，行539-541）；无 sessionId、冷会话、registry.get 抛、steer 抛、缺省 agents 均静默不抛（行554-562）；failed 消息即使自动提交成功也不吞失败原因（行551-553）；source 标记 `plugin:codewiki`（行550）。
- **单项目串行**：A 用 stall 占推进权（行738、749），B 提交进 `queued` 且排队期零请求（行753、765-768）、预置 `pendingStage='articles'`（行755）；jobs 端点带 `queueAhead`（1.1.0，行757-764）；取消 A 后 B 自动轮到（行770-781）。
- **并行项目上限（1.1.0）**：`serialProjects:false, parallelProjects:3` 下 A/B 同时推进不排队（行791-820）。
- **并发占位**：`serialProjects:false` 下并发提交共享同 jobId（行1010-1014）；用 stall mock 让任务停在 articles 保证稳定（行993-997 注释：旧版用「模型失败」当 mock 会因任务快速终态而偶发失败）；预置外部实例 job 经 flush 合并不丢失（行979-984、1016-1018）。
- **面板守卫**：非回环地址访问 jobs 端点 403（行1036-1038）；jobs 列表无 apiKey 字段（行1043）；取消未知 jobId 404（行1070-1072）；取消中断在途请求（行1069）。
- **排除清单（0.8.1）**：`excludePaths` 设后 compile 动作 400 拒绝且报错含「命中排除项」（行1103-1107），直调抛错同样（行1108-1110），子目录同样被排除且报错为父目录条目（行1111-1115）。
- **knownRepos 独立（0.4.8）**：提交即登记（行1152-1153）；job 历史清空后 refresh + repos 总览仍发现仓库（行1156-1166）；终态任务明细全结算、中间进度清空（0.4.11，行1145-1151）。
- **工作区过滤（0.4.9 / 0.10.5）**：终态任务按 workspaceOnly 过滤（行1215-1224），但工作区外的**非终态**任务不受过滤——单项目串行下闸门可能被不在工作区清单里的项目占住，藏掉它用户既看不到谁在编译也无法取消（行1199-1214）；`workspaceOnly=false` 后不过滤（行1226-1228）。
- **registry 异常（0.4.10）**：`workspaceRegistry.list()` 抛错时 jobs/repos 降级不过滤仍 200（行1237-1265）。
- **输出 schema 校验（0.4.10）**：`codewiki_generate` 输出须过同构校验器（行1267-1305），null 占位会挂。
- **孤儿接管（0.4.11.2）**：foreign 任务停更 6 分钟被接管并响应 `cancelRequested` 且写 note 留痕（行1319-1335），新鲜 foreign 不被抢（行1336-1337）。
- **全局会话 Tab（1.2.0）**：sessions 端点不带 jobId 跨任务聚合（行1348-1354）、带 jobId 单任务过滤（行1360-1367）、非回环 403（行1369-1371）；`SESSIONS_DIR` 测试后清理（行1411）。
- **worktree 闸门（1.2.0）**：linked worktree 目录提交 → 报错且文案说明「等合并回主仓库后再编译」（行1392-1394）；主工作区对照照常提交（行1396-1399）；auto 调度路径静默跳过并记 note（行1401-1402）。
- **空壳目录闸门（0.12.1 面板过滤起步、1.2.1 提交闸门，服务侧见 index.js:3043）**：只剩 `.codewiki` 骨架的目录提交报「没有可编译的源码文件」（行1424-1426）、auto 调度静默不提交（行1427-1428）；面板任务列表与仓库总览均不显示空壳目录任务（行1430-1459；正常任务 cwd 用仓库自身而非 tmp，避免 Temp 残留清理先一步移走，行1432-1434 注释）。
- **编译模型缺失诚实报错（0.10.1）**：`batchProvider:''` 时抛「编译模型提供商为空」（行1470-1473），且失败落 job 的 failed 态留痕（行1475-1476）。
- **Temp 残留清理（0.4.6）**：启动时移除 Temp 目录终态任务，保留活动任务与工作区终态任务（行1504-1521）。
- **错误前缀改写**：`codewiki_update` 包装 `generate` 错误，消息前缀改写为 `codewiki_update`（行314-316）；提交后追加「继续下一项」引导 note（行313）。
- **autoCommitWiki 安全边界（0.10.11 分支合并式）**：正常路径走 `mode:'branch'`（主题分支 `codewiki/wiki-*` 提交后合并回原分支并删主题分支，行425-427）、提交信息带 `docs(wiki)` 前缀与任务 id（行428）、只提交 `.codewiki/` 与 `CodeWiki.md` 两个路径（行429-430）、源码改动留在工作区不被卷进（行431-432）、无改动报 `noChanges` 不产空提交（行434-435）；非 git/被 gitignore/merge 进行中/缺 git identity 均拒绝并给原因（行438-486）；detached HEAD 降级直接提交（行488-496）；主题分支名被占用 → 降级直接提交且预占分支绝不被误删（行498-512）；「merge 失败 → abort + 保留主题分支」是防御性路径，单测构造不出来（行498-501 注释）。
- **autoCommitState 三态（唯一来源）**：`committed`/`no-changes`/`pending` 由一处判定、唤醒与提醒两条通道共用（行515-525）；旧 job 无 autoCommit 字段按 pending（行522）；`committed` 优先于 `noChanges`（行524）。

### test-wiki-anchors.mjs 边界

- **锚点校验边界**：仅行内单锚点且存在符号时才做符号绑定，多锚点行仅由「行号在范围内 + 指向非空行」兜底（行101-104 注释）；区间锚点在整个区间内搜符号（行105-106）；`symbolsOnLine` 拒绝含冒号/斜杠/空格/纯路径等非符号，长度与尾段 ≥3（行43-45）；`check` 返回 cond 支持短路跳过后续检查（行31）。

### test-wiki-entry.mjs 边界

- **入口生成边界**：`ensureWikiEntry('', lang)` 空 cwd 返回 false 不抛（行49）；`normalizeArticlePath(undefined)` 返回 `''`（行59）；`normalizeIndexLinks` 只改链接头反斜杠、正文反斜杠不受影响（行70），无 `_index.md` 静默 false（行72）。

### test-batch.mjs 边界

- **Token/预算边界**：`estimateTokens` 空串 0、混合分别计费（行25-28）；`collectSources` 首文件超预算即 `oversized` 兜底返回（行40-41），后续装不下进 `skipped`（行42-44）；多文件超预算拆观察批且每批 ≤110k token（行96-100）；单文件 110k–128k 走大档单请求不拆批（行77-81），连 128k 都装不下走会话通道且 prompt 按全长装填（行82-84）；0.10.4 起大档模型（默认 420k 预算）接管超 128k 输入、关闭大档才退回会话通道（行107-131）。
- **行号/格式**：`numberLines` 空文件输出 `1|`、双尾换行保留真实空行、CRLF 剥离（行48-51）；`fixAnchors` 对未找到/歧义/不在清单/basename 歧义均不动并记 `unresolved`，区间尾部钳到文件尾，CRLF 保真（行522-564）。
- **会话通道收割**：`classifySessionTask` 超时（30min）判定优先于已产出（行140-141）；旧文未更新（mtime 早于派发）判 `wait`（行146-148）。
- **任务执行容错**：`runRealtimeTasks` 单任务失败仅记 `notes`、不落盘、不中断并发（行342-343、405-406）；外部 `AbortController` 已 abort 则池子立即停止消费（行310-320）；`reasoningEffort` 未配置时从请求体省略（行307）；`temperature` 硬编码 0（行202）；大档任务未指定档位时不回落普通档（行227）。
- **并发分池（0.12.2）**：大档与默认档各自独立限流、同时推进（行263-282）；`bigConcurrency` 缺省/0 跟随默认档（行283-296，等价 0.12.1 单一池行为）。
- **模型/端点**：`listModelCatalog`/`resolveModelEfforts` 在 `llm=null` 或单 provider 抛错时诚实返回 `ok:false` 或保留错误条目，不抛异常（行428-430、487-493）；HTTP 端点强制回环（非回环 403，行458-460、512-514）、缺参 400（行509-511）。
- **档位钉死**：`buildSessionSteerText` 填 `tier` 时显式禁止自动选路，且 `review`/`resend` 场景文案不同但均钉死（行151-167）。
- **0.10.1 删除内置百炼通道**：`resolveBatchApiKey` 不再从 `./index.js` 导出（行517-520），插件不碰密钥。
- **scanRepoFiles 黑名单**：跳 node_modules/.git/以 `.` 开头目录/二进制后缀/超大（256KB 上限，300×1024 样本被跳）/空文件（行372-386）。

### test-cwd-paths.mjs 边界

- **路径归一化**：`cw.execute` 将 Windows 盘符路径（`E:/x`）转 MSYS（`/e/x`）并跑通（行10、30-45），且 Windows 下 `status` 返回真实三态而非 "No wiki found"（行47-57），证明 `resolveBinary` 选 PATH 探测而非过期捆绑副本；不存在 cwd 干净抛 `cwd 不存在`（行61-69）。
