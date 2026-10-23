---
title: core-application
type: module
source_files:
  - index.js
  - client.js
  - package.json
tags: [CodeWiki, 编译流水线, 阶段机, 百炼, DeepSeek Harness, 侧边栏面板, React]
---

## Overview

`core-application` 是 dsh-codewiki 插件的应用层，把「整仓 wiki 编译」做成一条 **服务化、零子代理、提交即返回** 的后台流水线，并配一套浏览器端面板。`package.json` 声明 `name: "@local/dsh-codewiki"`、`version: 0.9.2`、`private: true`、`type: "module"`（`package.json:2-7`），`exports` 暴露 `./index.js` 与 `./client.js` 两个入口（`package.json:8-11`），`dsh.client.platform` 为 `web`、`dsh.bundle.patch` 指向 `cordis.patch.yml`（`package.json:20-27`），运行期依赖只有 `@deepseek-ai/schemastery`（`package.json:17-19`）。

代码分成两半，职责严格分离：

- `index.js`（2885 行）是宿主半侧。它封装本地 `cw` CLI（`runCw` 见 `index.js:106`）、定义 `Config` 配置（`index.js:37`）、实现 `createJobService` 阶段机（`index.js:1219`），注册四个模型工具（`cw` / `codewiki_generate` / `codewiki_update` / `codewiki_progress`），并通过 `installWebServer`（`index.js:2533`）在回环地址上暴露查询与控制端点。
- `client.js`（1200 行）是浏览器半侧。经 `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', ... })`（`client.js:10-12`）注册，向宿主注入设置卡片（`plugins.item`）和侧边栏面板（`main` + `sidebar.panellist`），靠轮询而非推送更新界面。

核心契约是 **阶段机 + 文件状态**：一个 job 从 `plan` 依次推进到 `articles` → `crosscut` →（超预算拆分时 `compose`）→ `review` → `index` → `done`，`tick`（`index.js:2020`）按 10 秒节拍每次推进一步（`TICK_MS` 见 `index.js:1018`），全部状态落在 `JOBS_FILE`（`index.js:1017`），因此宿主重启、多实例并存都能靠磁盘快照接管续跑。三条模型通道并存：百炼兼容入口直连（`bailianChat` 见 `index.js:285`）、宿主 `llm` 服务（`llmChat` 见 `index.js:263`）、以及超预算时的「会话通道」（`dispatchSessionTasks` 见 `index.js:1494`，把写作/校对交给发起会话的子智能体）。

## Key Components

### index.js — 配置与基础层

- `Config`：`index.js:37-52`，`@deepseek-ai/schemastery` schema，共 13 个字段且全部 `.volatile()`：`enabled`（默认 `true`，停用后工具立即报错）、`binaryPath`（留空优先 PATH 里的 `cw`）、`batchProvider`（留空走百炼兼容通道，非空走宿主 llm 服务）、`batchModel`（默认 `'qwen3.7-flash'`）、`batchApiKey`、`batchThinkingBudget`（默认 0=关思考，上限 32768）、`sessionTier`（会话通道档位 id）、`maxConcurrency`（默认 `CONCURRENCY_HARD_CAP`）、`articleLanguage`（默认 `'中文'`）、`updateReminder`、`excludePaths`、`autoUpdate`、`autoUpdateMin`（默认 30）、`workspaceOnly`（默认 `true`）。
- `PLUGIN_NAME`：`index.js:18`，值为 `'dsh-codewiki'`，同时以 `export const name` 导出（`index.js:19`）。
- `CW_SUBCOMMANDS`：`index.js:20`，`['init','status','index','meta','path','projects','setup','uninstall']`，`cw` 工具据此做子命令白名单校验。
- `CONCURRENCY_HARD_CAP`：`index.js:22`，值 `8`，编译请求并发硬顶。
- `normalizeCwd(input)`：`index.js:26-31`，仅 win32 把 MSYS 盘符路径 `/e/...` 归一为 `E:/...`；非 win32 原样返回，识别不出的写法也原样交给 `existsSync` 报错。
- `val(x)`：`index.js:54-56`，兼容 schemastery 的 `get()` 访问形态。
- `liveConfig(config)`：`index.js:58-78`，把配置折算成运行时值：`batchThinkingBudget` 钳到 `[0, 32768]`、`maxConcurrency` 钳到 `[1, CONCURRENCY_HARD_CAP]`、`autoUpdateMin` 下限 5、`workspaceOnly !== false` 归一为布尔、`batchModel` 空值回落 `'qwen3.7-flash'`。

### index.js — cw CLI 封装与三态判定

- `resolveBinary(cfg)`：`index.js:84-104`，解析顺序为「配置 `binaryPath` → PATH 里的 `cw`（win32 用 `where`，其余用 `which`）→ 插件自带 `bin/cw(.exe)` → 裸 `'cw'`」。PATH 优先的理由写在注释里：用户装的 `cw` 与其源码同步演进，捆绑副本只兜底，避免「bash 原生正常、包装层 No wiki found」的分叉。
- `runCw(binary, cwd, args, timeoutMs = 120000, signal)`：`index.js:106-131`，`spawn` 子进程收集 stdout/stderr，超时 `SIGKILL`，`signal.abort` 同样 `SIGKILL`；返回 `{ exitCode, stdout, stderr, timedOut }`，**永不 reject**（`error` 事件也 resolve 成 `exitCode: -1`）。
- `normalizeArticlePath(p)`：`index.js:143`，把 `\` 换成 `/`。`cw 0.5.0.2` 起 Rust 层已输出 `/`，本层是纵深防御（`index.js:133-142` 注释记录了 0.5.0.1 时真源码丢失、只能在插件层收口的历史）。
- `normalizeIndexLinks(cwd)`：`index.js:147-155`，`cw index` 直写的 `.codewiki/_index.md` 里，把 `[[link|title]]` 链接头中的 `\` 规范化为 `/`，只动链接头不碰标题与正文；文件不存在静默返回 `false`，无改动返回 `false`。
- `parseStatus(stdout)`：`index.js:157-170`，把 `cw status` 文本解析成 `{ state, changedFiles, staleArticles }`。四个关键字判定：`'No wiki found'` → `missing`、`'has not been compiled yet'` → `uncompiled`、`'Wiki is up to date'` → `clean`，其余按 `^\s+[M!]\s+(.+)$` 逐行归类（`M` 进 `changedFiles`、`!` 进 `staleArticles`），状态记 `stale`。
- `countWikiArticles(wikiPath)`：`index.js:173-185`，递归统计 `.codewiki/` 下 `.md` 篇数（含 `_index`），失败返回 `null`，供面板总览卡展示。
- `ensureWikiEntry(cwd, language = '中文')`：`index.js:190-223`，仓库根缺 `CodeWiki.md` 时按语言写一份入口说明；**已存在绝不覆盖**（人工速查手册优先），生成失败只影响入口存在性、不应让编译任务失败。
- `excludedItem(cwd, list)`：`index.js:228-237`，排除清单按 `[\n;，,]+` 分隔，`cwd` 等于某项或位于其子树内即命中（归一化后小写比较），返回命中的原文；`isExcluded(cwd, list)`：`index.js:238-240` 是其布尔投影（面板 `excluded` 字段依赖布尔语义）。

### index.js — Token 预算、模型通道与执行器

- `estimateTokens(text)`：`index.js:249-257`，CJK 字符（`0x4e00-0x9fff`、`0x3000-0x303f`、`0xff00-0xffef`）按 1 token/字，其余按 3.5 字符/token。只求把单请求输入压进 qwen3.7-flash ≤32k 输入低价档（约 $0.03/M；32k–256k 档 $0.10/M，贵 3 倍多），不追求精确分词。
- `llmChat({ llm, provider, model, prompt, signal })`：`index.js:263-281`，走宿主 llm 服务（`llm.stream` + `BlockAssembler`），`temperature: 0`，消息来源标记 `plugin:codewiki`；`finish.kind` 为 `error`/`aborted` 或缺 content 时抛错。**该通道不下发思考预算**——宿主侧是 `reasoningEffort` 枚举而非 token 数。
- `bailianChat({ apiKey, model, thinkingBudget, prompt, signal })`：`index.js:285-303`，`POST ${BAILIAN_BASE}/chat/completions`，`thinkingBudget > 0` 时下发 `enable_thinking: true` 与 `thinking_budget`；非 2xx 抛错并截断响应体前 300 字符；返回 `{ content, outputTokens }`。
- `applyTaskResult(task, content, notes)`：`index.js:307-320`，任务结果统一出口。`keepInMemory` 任务只回内存；其余任务先跑 `fixAnchors` 修锚点（修正条数与存疑清单写进 `notes`）再 `writeFileSync` 落盘，落盘异常记 `ok: false`。
- `runRealtimeTasks(tasks, { apiKey, model, thinkingBudget, concurrency, notes, onTaskDone, signal, llm, provider })`：`index.js:326-353`，**唯一执行器**。`chat` 在 `index.js:331-333` 二选一（`provider` 非空走 `llmChat`，否则 `bailianChat`）；worker 从游标消费队列（`index.js:334-350`），每任务回调 `onTaskDone({ outputTokens, durationMs })` 供面板算 tps；单任务异常只 `notes.push` 并置该任务 `ok: false`；`Promise.all` 等待全部 worker（`index.js:351`）；返回 `Map(customId → { ok, stopReason, content? })`。
- `BAILIAN_BASE`：`index.js:363`，`'https://dashscope.aliyuncs.com/compatible-mode/v1'`。
- `BATCH_TOKEN_BUDGET`：`index.js:366`，`28000`，单请求输入预算（≤32k 低价档留 ~4k 余量吸收估算误差与消息骨架开销）。
- `BATCH_TOKEN_HARD_LIMIT`：`index.js:370`，`200000`；0.9.0 起只用作「会话通道任务文件装填上限」，不再表示升档提交。
- `sleep(ms)`：`index.js:372`；`readJsonFile(p)`：`index.js:374-376`，解析失败返回 `null`。

### index.js — 行号锚点、源码装填与任务装配

- `numberLines(content)`：`index.js:381-383`，给每行加 `N| ` 前缀（grep 风格），让模型引用行号以前缀为准而不是自己数行（弱模型自己数行首尾常对、中段系统性错位）；尾部至多去一个换行，避免真实空行被挤掉。
- `fixAnchors(content, cwd)`：`index.js:392-475`，**文章落盘前的第四层兜底**。只处理 frontmatter 之后的行；`symbolsOnLine`（`index.js:412-421`）从行内反引号提取符号（长度 ≥3、点分末段 ≥3），锚点正则 `anchorRe` 定义在 `index.js:427`。起点行不含符号时在全文找出现行：恰好一处 → 修正；多处 → 只认 `function`/`class`/`const`/`let` 的**声明形态**（`defRe` 见 `index.js:453`），仍歧义则不动并记 `unresolved`（`index.js:461-464`）。点分符号歧义时退试首段（`index.js:443-444`）；区间尾越界钳到文件尾（`index.js:465-469`）；只改行号数字，`source_files` 之外的文件引用一律不碰；行尾按整文主风格（CRLF/LF）规范化（`index.js:473`）。
- `collectSources(cwd, files, budget = BATCH_TOKEN_BUDGET)`：`index.js:480-507`，把源文件内联成 markdown（每段 `### <rel>` + 带 `numberLines` 的围栏），**只整文件装填、绝不半文件截断**（半截代码会误导行号）。返回 `{ text, skipped, oversized }`：`skipped` 是预算装不下的文件清单（末尾追加「不得涉及它们」的警告，`index.js:503-505`），`oversized: true` 表示连第一个文件都装不下（`index.js:493-495`）。
- `batchArticlePrompt({ language, mission, sourcesText, prevArticle })`：`index.js:511-538`，单轮文章 prompt 骨架；有旧文时附上并明确「行号可能已过期、不得沿用」（`index.js:521-528`），末尾拼 `articleFormatSection()`。
- `hostCtxRef`：`index.js:541`，`apply` 时捕获的宿主 ctx，批量路径经它向宿主凭据库取模型渠道凭证。
- `resolveBatchApiKey(hostCtx, cfg)`：`index.js:548-568`，凭证链为「显式 `batchApiKey` → 经 `hostCtx.inject(['credentials'])` 解析 `ALIYUN_BAILIAN_API_KEY`」（即模型设置「阿里百炼云」渠道的 `apiKeyEnv`，与模型适配器同一份凭证），注入用 `Promise.race` 加 3 秒上限（`index.js:552-561`），取不到返回 `null`（不抛错），来源记在 `source`（`config` 或 `credentials(<来源>)`）。
- `prepareArticleTasks(tasks, { cwd, language })`：`index.js:580-637`，任务装配与**三级降级**：
  1. 先按 28k 装填，整体装不下改试 200k（`index.js:584-587`）；
  2. 若 28k 有文件被跳过，或整 prompt 估算超预算（判定在 `index.js:594`），按文件切批、每批 ≤28k 拆成 `#obs` 观察批（`keepInMemory`，带 `splitFor` 与 `composePlan`，`index.js:596-625`）；
  3. 单文件连观察批预算都装不下（`hasOversizeSingle`，`index.js:600`）或分不出多批，整任务转会话通道（`forceSession`，按 200k 装填，`index.js:627-633`）。
  返回 `{ prepared, sessionTasks }`；复用任务对象时清残留分割字段（`index.js:632`）。
- `articleFormatSection()`：`index.js:644-673`，文章格式条款的唯一来源：frontmatter 必须含 `title`/`type`/`source_files`/`tags`，正文六章节 `Overview`/`Key Components`/`Architecture`/`Data Flow`/`Connections`/`Known Issues`；行号必须以前缀为准；`source_files` 必须列全读过的文件（含测试）；功能被注释/禁用要写明具体位置；Architecture 组件 ≥3 时画 UTF-8 框图；`Connections` 用 `[[backlinks]]`；写给零上下文的未来 agent。

### index.js — Prompt 模板

- `batchPlannerPrompt(fileLines)`：`index.js:677-696`，规划 prompt：输入是文件清单（path+bytes），要求模块切小（一个模块 3–8 个文件）、`modules` 的 files 并集覆盖全部文件、每个文件恰好归入一个模块、只用清单内路径、输出纯 JSON（`project`/`modules`/`concepts`）。
- `localPlan(files)`：`index.js:699-712`，规划兜底：按顶层目录分组，`concepts: []`，`project` 标「本地兜底规划」。
- `packArticles(articles, budget = BATCH_TOKEN_BUDGET)`：`index.js:716-735`，横切输入装配；整篇装不下时只装 `## Key Components` 之前的头部并标「超预算，仅头部」（`index.js:723-729`）。
- `crosscutIntro(language, what, requirements)`：`index.js:737-749`，横切三个 prompt 的公共骨架（都要求 frontmatter 起、只输出正文、`source_files` 取模块文章 frontmatter 里出现过的源文件）。
- `batchArchitecturePrompt(language, articlesText)`：`index.js:751-757`，写 `_architecture.md`，要求三张 UTF-8 框图（System Overview / Data Flow / Dependency Graph）。
- `batchPatternsPrompt(language, articlesText)`：`index.js:759-765`，写 `_patterns.md`，每个模式必须引用具体模块文章里出现的文件/函数作为证据。
- `batchConceptPrompt(language, concept, articlesText)`：`index.js:767-773`，写跨模块概念专文，章节固定为 Overview / Involved Modules / Flow / Implementation Map。
- `batchObservePrompt(language, moduleName, articleText)`：`index.js:777-794`，横切 map 阶段：一篇文章 → 紧凑观察（职责、对外接口+行号、依赖方向、值得进总览的模式/风险、`source_files` 原样）；**输出刻意不带 frontmatter**（观察批不走 tally 落盘，只在合成批拼包）。
- `batchArticleObservePrompt(language, moduleName, sourcesText, batchIndex, batchTotal)`：`index.js:798-814`，文章分割的 map 阶段，要求「宁全勿简」但禁止贴大段源码，行号以源码前缀为准。
- `batchArticleComposePrompt({ language, mission, moduleName, observationsText, prevArticle })`：`index.js:818-846`，合并各批观察成整篇（附 `articleFormatSection()`），要求「观察中引用的文件:行号直接沿用，不得发明未出现的文件或符号」。
- `batchProofreadPrompt({ language, articleText, sourcesText })`：`index.js:850-869`，校对 prompt：四项核对（frontmatter 完整性、逐符号核行号、补漏的 `source_files`、改写与源码不符的段落），输出**修正后的整文**而非 diff；文章与源码一致时也输出全文原样。

### index.js — 工具定义

- `cwToolDefinition(cfg)`：`index.js:875-938`，`cw` 工具。`execute`（`index.js:915-936`）依次校验：插件已启用（`index.js:917`）、`cwd` 存在（`index.js:919`）、`args` 非空（`index.js:921`）、首个子命令在 `CW_SUBCOMMANDS` 白名单内（`index.js:922-924`）；随后 `runCw(..., 120000, exec?.signal)`（`index.js:926`），超时抛错（`index.js:927`）。输出 schema 为 `{ cwd, command, exitCode, stdout, stderr, timedOut }`（`index.js:897-908`）。
- `slugify(name)`：`index.js:944-946`，小写化并把非 `[a-z0-9-_]` 折成 `-`，去掉首尾连字符，空结果回落 `'module'`；模块/概念文章文件名由它决定。
- `parsePlan(text)`：`index.js:948-968`，剥掉 markdown 围栏、取首个 `{` 到末个 `}` 段做 JSON 解析；`modules` 必须为非空数组且每项有 `name` 与 `files`，`concepts` 非数组时补空、`project` 非字符串时补空串；解析失败返回 `null`（触发 `localPlan` 兜底）。
- `parseSourceFiles(fm)`：`index.js:972-984`，从 frontmatter 文本解析 `source_files`，同时支持行内 `[a, b]` 与块状 `- a` 两式并去引号；`readSourceFiles(articlePath)`：`index.js:986-994` 读文件、剥出 frontmatter 后转调它，异常返回 `[]`。
- `wikiPathFor(cwd, binary, signal)`：`index.js:996-1001`，跑 `cw path`（30s 超时）取最后一个非空行；失败回落 `<repo>/.codewiki`（与 CLI 的 `wiki_path()` 一致：wiki 在仓库内）。
- `generateToolDefinition(cfg, svc)`：`index.js:2157-2306`，`codewiki_generate` 工具，整条流水线的**总入口**。`execute`（`index.js:2200-2304`）的前置校验：`enabled`（`index.js:2202`）、`svc` 已初始化（`index.js:2203`）、`cwd` 存在（`index.js:2205`）、排除清单（`index.js:2206-2207`）；`scope` 白名单化为 `auto`/`full`/`stale`（`index.js:2208`）；`auto` 是内部直调标记、不外露 schema（`index.js:2209`）；`sessionId` 取 `exec?.agent?.id`（`index.js:2212`）。随后 `cw status` 判态（`index.js:2215`），超时/失败分别抛错（`index.js:2216-2219`）。分支：
  - 同仓库已有活动任务 → 直接返回该 job，并把 `sessionId` 改记为最近一次关心该仓库的会话（`index.js:2226-2234`）；
  - `scope=stale` 但 `missing`/`uncompiled` → 自动升全量（`index.js:2237-2241`）；
  - `clean` 且非 `full` → 只报告不提交（`index.js:2245-2248`）；
  - `stale` 且有过期文章 → 逐篇读 `source_files` 构造 `prebuiltTasks`，无 `source_files` 的文章跳过（`index.js:2251-2276`），提交 `kind: 'stale'`（`index.js:2269`）；
  - `stale` 但无过期文章却有变更 → `cw meta update` 刷新基线并报告（`index.js:2280-2287`）；
  - `missing` → 先 `cw init`（`index.js:2290-2296`）再提交 `kind: 'full'`（`index.js:2298`）。
  返回体只在提交/幂等路径才赋 `jobId`/`stage`（不放 null 占位，宿主按 output schema 校验，见 `index.js:2222`）。
- `updateToolDefinition(cfg, generateDef)`：`index.js:2315-2367`，`codewiki_update` 是固定 `scope: 'auto'` 的快捷入口（`execute` 在 `index.js:2355-2365`，内部 `generateDef.execute({ ...args, scope: 'auto' }, exec)` 见 `index.js:2357`），提交成功时追加「继续下一项工作、不要等待」的引导（`index.js:2358-2360`），错误信息里的工具名被替换成 `codewiki_update`（`index.js:2363`）。
- `samePath(a, b)`：`index.js:2375-2378`，归一化并去尾斜杠后小写比较；`progressView(job)`：`index.js:2380-2384`，在 job 摘要上补 `progress` 百分比（`taskList` 为空时为 `null`）。
- `progressToolDefinition(cfg, svc)`：`index.js:2386-2468`，`codewiki_progress` 只读工具。`execute`（`index.js:2453-2466`）校验启用与 `svc`，按 `jobId` 精确过滤（`index.js:2459-2461`），否则按 `cwd` 过滤（`index.js:2462-2463`）。

### index.js — createJobService（阶段机核心）

`createJobService(config, onSettled)`：`index.js:1219-2150`，返回 `{ submit, cancel, list, findActive, start, stop }`（`index.js:2149`）。

**实例身份与持久化**

- `instanceId`：`index.js:1227`，`svc-<base36 时间>-<随机 6 位>`；tick 只推进本实例创建的 job，防止另一实例用旧快照重复推进同一 job（双提交）。
- `dirty` / `dirtyIds` / `persist()`：`index.js:1230-1234`，只有状态变更才整写 `JOBS_FILE`；本实例动过的 job id 在 `flush` 时不允许被磁盘快照反向覆盖（否则 cancel/fail 与慢 tick 交错会丢掉现场新增的 note/batchRef）。
- Temp 沙箱残留清理：`index.js:1237-1248`，`cwd` 位于系统临时目录的终态任务启动即移除并**立即** `saveJobs`（只标脏的话 tick 的 `mergeFromDisk` 会把磁盘残留吸回内存）。
- `mergeFromDisk()`：`index.js:1251-1272`，吸收另一实例新增的 job，以及「磁盘更新且本实例没动过」的同 id job；合并后按 `createdAt` 排序。
- `flush()`：`index.js:1273-1276`，先 `mergeFromDisk`，再清脏标记与 `dirtyIds`，最后 `saveJobs`。

**内部记账辅助**

- `note(job, msg)`：`index.js:1277-1280`，防御性补齐 `notes`（磁盘残留/手工构造的 job 可能缺字段）后追加，只保留最近 50 条。
- `touch(job)`：`index.js:1283-1285`，状态变更唯一入口，必须同时标脏并登记 `dirtyIds`（否则纯内存变更进不了 `JOBS_FILE`）。
- `setStage(job, stage)`：`index.js:1288-1298`，切换前先把上一阶段耗时累加进 `job.stageTimings`，再记 `stageStartedAt` 并 `touch`；旧任务无 `stageStartedAt` 时只切阶段不记时。
- `addUsage(job, { inputTok, outputTok, requests, batch, realtime, overTier2 })`：`index.js:1300-1309`，累加 `job.usage`（输入是提交时估算，输出是响应实测）。
- `syncCancelFlags()`：`index.js:1313-1324`，每轮 tick 从磁盘拾取别实例写入的 `cancelRequested`（本实例正推进的 job 内存对象永不被磁盘覆盖，故必须显式同步取消标记）。
- `fail(job, msg)`：`index.js:1326-1334`，置 `failed`、写 `job.error`/`finishedAt`、记 note；`submitting` 期的失败不唤醒会话（错误随工具调用同步返回）。
- `apiKeyOf(job)`：`index.js:1337-1344`，凭证优先用内存缓存（不落盘），缺失时重解析（凭证库可能已就绪/已更换），仍取不到就抛错终止并在文案里带上原解析来源。

**阶段收割与落盘闸门**

- `settleJob(job)`：`index.js:1347-1368`，返回 `null` 表示阶段还在跑。三条路：`batchResults` 已有结果 → 清 `batchProgress`/`batchSubmittedAt` 并返回；`batchRuns` 仍在执行 → `null`；执行器丢失（宿主重启）→ 若 `job.tasks` 的 `batchPrompt` 快照齐全则**重跑本阶段**（幂等，文章重写覆盖），否则 `fail`「请求因宿主重启丢失且无法重跑」。
- `writeValidated(job, task, content)`：`index.js:1373-1389`，`keepInMemory` 任务的唯一写盘点。**闸门：去前导空白后必须以 `---` 开头**，缺 frontmatter 不落盘、原文件保留（`index.js:1374-1377`）；通过后跑 `fixAnchors` 再写，修正条数与存疑清单入 note。
- `tally(job, results, tasks, { replace = false })`：`index.js:1392-1413`，结果记账：`keepInMemory` 且成功的结果过 `writeValidated`；新条目计入 `writtenCount`/`failedCount`；`replace: true`（校对阶段）时覆盖同名条目，且**校对失败不推翻已写成功的原文**（`rec.ok` 保持原值，`index.js:1404-1406`）。

**批次执行器与会话通道**

- `batchRuns` / `batchResults` / `batchAborters`：`index.js:1419-1421`，三个 Map 解耦 tick 与长请求：存活性标记、待收割结果（`null` = 执行器整体失败）、取消用的 `AbortController`。
- `startBatchChatRun(job, prepared)`：`index.js:1422-1465`，启动后台并发池。`batchProvider` 非空时凭证直接给空串（宿主按 provider 解析，插件不碰 key，`index.js:1428`）；`onTaskDone` 里累加 `batchProgress`、把 tps 样本压入 `job.tpsSamples`（保留最近 20 条）、把输出 token 入账（`index.js:1439-1445`）；整体 reject 时写 `batchResults = null` 并在非终态下 `fail`（`index.js:1449-1457`）；`finally` 里清 `batchRuns`/`batchAborters`，终态时连 `batchResults` 也清掉（`index.js:1458-1462`）。
- `submitBatchFor(job, prepared)`：`index.js:1467-1487`，提交前**预记账**输入 token 与请求数，并统计超 32k 档的请求数（按 3 倍价计费并 note 明示，`index.js:1470-1474`）；把 `prepared` 快照化写进 `job.tasks`——`batchPrompt` 是「宿主重启后重跑本阶段的唯一依据」（`index.js:1475-1482`），`#obs` 任务额外带 `splitFor`/`composePlan`；然后 `startBatchChatRun` 并 note 启动信息（模型与并发）。
- `dispatchSessionTasks(job, tasks)`：`index.js:1494-1528`，会话通道派发。发起会话不可用时直接 `fail` 并给出「请从会话内重新提交编译」（`index.js:1496-1500`）；把每个 `batchPrompt` 写成 `SESSION_TASK_DIR` 下的 `<jobId>--<safe>.prompt.txt`（`index.js:1504-1515`）；`buildSessionSteerText` 组消息后 `agent.steer`（`index.js:1519-1525`）；成功时记「已转会话通道、超时 N 分钟」的 note。
- `progressSessionTasks(job)`：`index.js:1532-1551`，收割：`timeout` 记失败、`harvest` 走 `writeValidated`、其余留待下轮；返回 `true` 表示全部终态；校对阶段用 `replace: true` 记账（`index.js:1549`）。
- `resendSessionSteer(job)`：`index.js:1555-1568`，宿主重启接管后重发一次 steer，**不重置 `dispatchedAt`**（超时计时保持原起点，子智能体重写同一文件所以幂等）。

**阶段处理器**

- `tickPlan(job)`：`index.js:1572-1615`。有在途批次 → `settleJob` 收割，取首个 `ok` 且有 `content` 的结果过 `parsePlan`，解析失败降级 `localPlan(scanRepoFiles(job.cwd))`（`index.js:1576-1583`）。首次进入 → `scanRepoFiles` 取文件清单（空则 `fail`，`index.js:1589-1590`），先试 `runMainModelPlan`（主模型规划，无 32k 低价档限制、也不占百炼并发池），失败或产出不可解析再降级百炼批量（`index.js:1595-1611`）。
- `runMainModelPlan(job, prompt)`：`index.js:1621-1670`。路由顺序与会话主线 compaction 的 `latest ?? agentTarget` 一致：`agent.session.requestHeader()?.config` 优先，退回 `agent.options`（`index.js:1626-1632`）；经 `llm.stream` 单轮流收集（`index.js:1644-1653`）；`finish.kind` 异常只记 note 返回 `null`（走批量回退，不 fail 任务）；`finally` 清 `batchAborters` 并 `touch`（`index.js:1662-1665`）。
- `tickArticles(job)`：`index.js:1672-1782`，最长的一段。收割分支先处理 `#obs` 观察批：按文章名归并观察文本，每篇只重建**一条**合成任务（`composedArticles` 去重，`index.js:1681-1721`）；全部批失败则该篇缺席本轮编译但不 fail 整个 job（`index.js:1699-1702`）；合成任务为空且无在途会话任务时直接推进阶段（`index.js:1732-1736`）。首次进入按 `kind` 取任务（`stale` 用 `job.tasks`，`full` 用 `job.plan.modules` 映射成 `modules/<slug>.md`，`index.js:1742-1758`），再交 `prepareArticleTasks` 分流出 `prepared`（批量）与 `sessionTasks`（会话通道）。收尾守卫：`writtenCount === 0` 直接 `fail`（`index.js:1780`）。
- `crosscutTasks(job, pack)`：`index.js:1785-1804`，横切任务组 = `_architecture.md` + `_patterns.md` + `job.plan.concepts` 逐个 `concepts/<slug>.md`，全部 `keepInMemory`。
- `tickCrosscut(job)`：`index.js:1806-1869`。输入是成功模块文章全文；**用原始总量判拆分**（`index.js:1845`——`packArticles` 只截后续文章头部，pack 体积永远装得下，不能作依据）。≤28k 单批直出（`index.js:1846-1854`）；超了改成「每篇一个观察任务」并发跑（`_obs/<name>`，`index.js:1857-1868`），置 `job.crosscutSplit = true`。拆分路径收割时**不走 tally**（不写盘不计数），只拼观察包后 `setStage('compose')` 并提交合成批（`index.js:1813-1830`）。
- `tickCompose(job)`：`index.js:1872-1884`，合成批收尾：结果走 `tally` 写盘；`batchRef` 缺失（stage 落盘与提交落盘之间进程中断）时留痕降级进校对，不静默。
- `submitComposeBatch(job, observationsText)`：`index.js:1886-1896`，合成提交失败时**降级跳过横切**进校对，不推翻已写成功的文章。
- `localReview(job)`：`index.js:1899-1919`，本地核对三件事：文件是否还在（丢了把 `a.ok` 置 false 并回退 `writtenCount`，`index.js:1906-1910`）、是否以 `---` 开头（缺则 `skipProofread`）、`source_files` 是否都存在；`source_files` 为空也置 `skipProofread`（`index.js:1916`）；只记账不删文。
- `tickReview(job)`：`index.js:1921-1984`。对每篇合格文章按 `BATCH_TOKEN_BUDGET - articleTokens` 装填源码（`index.js:1940`）；装不下先升 200k（`index.js:1941-1943`），仍不行就转会话通道校对（`index.js:1944-1952`）；批量批提交失败只 `note`「跳过校对」不 fail（`index.js:1967-1971`）。会话通道校对收割完才进 index（`index.js:1979-1982`）。
- `tickIndex(job)`：`index.js:1986-2009`。`writtenCount > 0` 时依次跑 `cw index`、`cw meta update`（各 120s），失败只 `note`「编译基线可能未刷新」（`index.js:1990-1997`）；`normalizeIndexLinks` 成功改动时报告链接规范化；`ensureWikiEntry` 补入口（`index.js:1998-2002`）。最后 `setStage('done')`、写 `finishedAt`，并 `onSettled?.(job, 'done')` 唤醒发起会话（`index.js:2006-2008`）。
- `STAGE_HANDLER`：`index.js:2011-2018`，`{ plan, articles, crosscut, compose, review, index }` 六项映射。
- `tick()`：`index.js:2020-2064`。防重入（`ticking`）+ 跨进程锁（`acquireTickLock`，`index.js:2022`）；`syncCancelFlags()` 后遍历非终态 job：**孤儿接管**（`owner` 非本实例且停更超 `ORPHAN_TAKEOVER_MS` 则改 owner、`touch`、对在途会话任务补发 steer，`index.js:2028-2037`）、`submitting` 占位跳过（`index.js:2038`）、`cancelRequested` 则 abort 在飞请求、丢未收割结果并置 `cancelled`（`index.js:2039-2048`）、其余派给 `STAGE_HANDLER`，handler 抛错统一 `fail`（`index.js:2050-2056`）；终态 job 立即 `persist()`，最后 `flush()`，`finally` 释放锁（`index.js:2057-2063`）。

**对外方法与生命周期**

- `submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId })`：`index.js:2066-2123`。排除清单（`index.js:2068-2071`）→ `rememberRepo` → 同 cwd 有非终态 job 直接返回 `{ job: existing, existed: true }`（`index.js:2073-2074`）→ **先建 `stage: 'submitting'` 占位**（`resolveBatchApiKey` 最长等 3s，占位挡住并发重复提交，`index.js:2075-2097`）→ 解析凭证（llm 通道只校验 provider/model 与 `llmRef`，`index.js:2100-2105`）→ 置 `plan`（full）或 `articles`（stale），`stale` 用 `prebuiltTasks`（`index.js:2117-2118`）→ `persist()`、`flush()`，再 `void tick()` 立即推进一步（`index.js:2119-2121`）。
- `cancel(jobId)`：`index.js:2125-2134`，先 `mergeFromDisk`（别实例提交的 job 可能还没被本实例吸收过），置 `cancelRequested`、记 note 并 `flush`。
- `list`：`index.js:2136`（先 `mergeFromDisk` 再 `map(jobSummary)`）；`findActive(cwd)`：`index.js:2137`；`start()`：`index.js:2139-2143`（`setInterval` 按 `TICK_MS` 跑 tick，`timer.unref()`）；`stop()`：`index.js:2144-2147`。

**job 对象的全部字段**（`index.js:2076-2095`）

`id`（`job-<base36 时间>-<序号>`）、`cwd`、`wikiPath`、`scope`、`language`、`kind`（`full`/`stale`）、`owner`（instanceId）、`stage`、`auto`、`sessionId`（发起会话；面板/自动调度为 `null`）、`plan`、`batchRef`、`tasks`、`articles`、`writtenCount`、`failedCount`、`usage`（`inputTok`/`outputTok`/`requests`/`batchRequests`/`realtimeRequests`/`overTier2`）、`stageTimings`、`stageStartedAt`、`notes`、`createdAt`、`updatedAt`。运行期追加：`credentialSource`、`apiKey`（`index.js:2115-2116`，`apiKey` 不落盘）、`batchProgress`、`batchSubmittedAt`、`tpsSamples`、`sessionTasks`、`cancelRequested`、`crosscutSplit`、`error`、`finishedAt`。

### index.js — 持久化与常量

- `JOBS_FILE`：`index.js:1017`，`DSH_CODEWIKI_JOBS_FILE` 或 `os.tmpdir()/dsh-codewiki-jobs.json`（测试靠该环境变量隔离，否则与真实宿主实例互相洗掉内存字段，是 tps 采样 flaky 的根因）；`TICK_MS`：`index.js:1018`，默认 10000、下限 250。
- `SESSION_TASK_TIMEOUT_MS`：`index.js:1022`，默认 30 分钟、下限 5 分钟；`SESSION_TASK_DIR`：`index.js:1023`，与 job 文件同目录的 `dsh-codewiki-session-tasks`（宿主重启后仍可收割）。
- `classifySessionTask(task, nowMs)`：`index.js:1029-1039`，纯函数三态：超时 → `'timeout'`；文件不存在/读不到、`mtime` 早于派发时间、或去前导空白后不以 `---` 开头 → `'wait'`；否则 `'harvest'`。
- `buildSessionSteerText({ job, snapshots, tier, resend })`：`index.js:1046-1064`，会话通道 steer 文本（纯函数，测试直接断言）。背景见 `index.js:1041-1045` 注释：「写 CodeWiki 模块文章」实测被决策模型判给 default（置信 0.88–0.99），用户自建的 codewiki 档永远轮不到，故 `tier` 非空时在文本里要求「调用 delegate 时必须显式传 tier，不要依赖自动选路」（`index.js:1048-1050`）；文案按「文章 / 校对」与「首次 / 重发」四种组合切换（`index.js:1052-1062`）。
- `ORPHAN_TAKEOVER_MS`：`index.js:1066`，默认 5 分钟、下限 60 秒；`MAX_JOBS_KEPT`：`index.js:1067`，`30`。
- `REPOS_FILE`：`index.js:1072`，已知仓库清单（独立于 job 历史的持久化工作区登记，避免 `MAX_JOBS_KEPT` 截断与 Temp 清理后总览丢工作区）；`loadKnownRepos()`：`index.js:1073-1075`；`rememberRepo(cwd)`：`index.js:1076-1084`，归一化去尾斜杠并小写后去重追加，不可写则静默放弃。
- `JOB_TERMINAL`：`index.js:1085`，`Set(['done','failed','cancelled'])`。
- `SCAN_SKIP_DIRS`：`index.js:1088-1092`（`.git`/`.codewiki`/`node_modules`/`vendor`/`dist`/`target`/`bin`/`coverage` 等）；`SCAN_SKIP_EXT`：`index.js:1093-1098`（图片/压缩包/二进制/字体/媒体/wasm 等）；`SCAN_MAX_FILE_BYTES`：`index.js:1099`，256KB；`SCAN_MAX_FILES`：`index.js:1100`，2000。
- `scanRepoFiles(cwd)`：`index.js:1102-1125`，递归扫描；目录名命中黑名单或以 `.` 开头即跳过；空文件与超 256KB 文件跳过；`path` 用 `/` 分隔的相对路径并附 `bytes`。
- `loadJobs()`：`index.js:1127-1130`，读 `JOBS_FILE` 的 `jobs` 数组，异常返回 `[]`。
- `JOBS_LOCK_FILE`：`index.js:1132`；`acquireTickLock()`：`index.js:1135-1149`，用 `flag: 'wx'` 独占创建，已存在且 mtime 超 60s 则强删重试（崩溃残留锁；tick 间隔 10s，60s 足够宽限）；`releaseTickLock()`：`index.js:1150`。
- `saveJobs(jobs)`：`index.js:1152-1156`，只留最近 30 条，落盘前剔除 `apiKey`（重启后重解析），但保留 `cancelRequested`（取消标记靠它跨 tick 存活）。
- `jobSummary(job)`：`index.js:1158-1192`，面板与工具共用的投影：`id`/`cwd`/`kind`/`scope`/`auto`/`stage`/`batchId`/`writtenCount`/`failedCount`/`cancelRequested`/`articles`/`taskList`（已结算在前、当前批 `pending` 在后，进度条分母即其长度）/`batchProgress`/`batchSubmittedAt`/`stageStartedAt`/`stageTimings`/`usage`/`notes`（最近 8 条）/`error`/`createdAt`/`updatedAt`/`finishedAt`/`tps`（`tpsSamples` 总输出 token ÷ 总毫秒）。

### index.js — 唤醒、Web 端点与插件入口

- `agentsRef`：`index.js:1201`；`llmRef`：`index.js:1204`（注释记录了 cordis 严格语义下直接访问 `ctx.llm` 会抛 `cannot get property "llm" without inject`，`typeof` 守卫拦不住，故经 `ctx.inject(['llm'])` 在注入时取服务）。
- `wakeCompileSession(job, outcome, agents = agentsRef)`：`index.js:1206-1217`，只对 `job.sessionId` 对应会话 `agent.steer` 一条消息：失败报错文案，或「编译完成·请提交改动」（提示只 add `.codewiki/` 与 `CodeWiki.md`、不要 `git add -A`）；无 agent 上下文（面板/自动调度提交）与冷会话一律静默跳过。
- `isLoopbackRequest(req)`：`index.js:2474-2477`（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）；`writeJson(res, code, obj)`：`index.js:2479-2483`；`readBodyJson(req)`：`index.js:2485-2503`，1MB 上限并 `req.destroy()`。
- `listModelCatalog(llm)`：`index.js:2510-2531`，`llm.listProviders()` + 逐个 `listModels`；字段名兼容 `id`/`provider`、`displayName`/`name`；单个 provider 抛错只记该条 `error`（保留条目、models 为空），不影响其他；`llm` 未注入时整体返回 `ok: false`。
- `installWebServer(ctx, service, extra = {})`：`index.js:2533-2729`。`extra` 是 `{ config, schedState, compile }`（`index.js:2534`）。`workspaceRegistry` 经 `ctx.inject` 取并兼容旧 mock 直传实例（`index.js:2542-2545`；0.4.10 真宿主 `cannot get property "list" without inject` 的根因是把注入切片当实例存下），`wsFilterPaths()`（`index.js:2549-2564`）在 `workspaceOnly` 关闭、无注册表、或注册表为空时返回 `null`（不过滤），`list()` 抛错时降级不过滤并 `console.warn`。四个端点均 `kind: 'exact'` 且先过 `guard`（回环之外 403）：
  - `GET /api/codewiki/jobs`（`index.js:2574-2590`）：`service.list()` 经工作区过滤后返回 `{ now, jobs }`；异常把错误栈前 8 行写进 500 响应体（宿主 webserver 对 handler reject 只回空 400，无法排查）。
  - `GET /api/codewiki/repos`（`index.js:2594-2673`）：仓库总览，30 秒缓存且以工作区清单签名 `wsSig` 失效（`index.js:2600-2601`）；每个 cwd 现跑 `cw status` + `wikiPathFor` + `countWikiArticles`（`index.js:2636-2651`），附 `excluded`、`lastJob`、`state`、`staleArticles`、`changedFiles`、`wikiPath`、`articleCount`，并带 `scheduler` 段（`enabled`/`intervalMin`/`lastScan`/`scanning`/`lastError`/`lastScanRepos`/`lastScanSubmitted`，`index.js:2656-2664`）。
  - `GET /api/codewiki/models`（`index.js:2680-2695`）：模型目录，30 秒缓存。
  - `POST /api/codewiki/control`（`index.js:2696-2727`）：只接受 POST；`action: 'cancel'` + `jobId`（`index.js:2704-2708`）、`action: 'refresh'`（清 repos 缓存，`index.js:2709-2713`）、`action: 'compile'` + `cwd`（可选 `scope` 限 `auto`/`full`/`stale`，调 `compile`，`index.js:2714-2724`），未知 action 返回 400 并列出合法形状。
- `commitHintCache`：`index.js:2743`；`commitHintText(cwd, jobs = loadJobs())`：`index.js:2744-2769`，60 秒 TTL。取最近一次 `stage === 'done'` 且 `writtenCount > 0` 的 job，用 `git -C cwd log -1 --format=%ct -- .codewiki CodeWiki.md`（5s 超时）比对：job 完成时间晚于最后一次提交 → 注入「请提交改动」提示；提交后时间戳反超自动静默；非 git 仓库或读 jobs 失败一律不提醒。
- `reminderText(cwd)`：`index.js:2771-2780`，系统提示里的固定五条维护纪律（收尾必须 `codewiki_generate`、不要手改 `.codewiki/`、编译是后台任务不要等、路径用绝对路径、与代码一起提交）。
- `installUpdateReminder(ctx, config)`：`index.js:2782-2814`，给每个 agent 注入 `systemPrompt.section`（`name: 'codewiki:update-reminder'`，`order` 取 `TOOL_REPORT` + 1）；`text` 是回调，每次组装系统提示都实时求值：开关关闭、无 `cwd`、仓库根无 `CodeWiki.md` 一律返回空串（`index.js:2794-2800`）。存量 agent 经 `agents.list()` 遍历，新增的走 `agent/created`（`index.js:2806-2813`）。
- `apply(ctx, config)`：`index.js:2816-2876`，插件入口。顺序为：存 `hostCtxRef` → 注入 `agents`/`llm`（`index.js:2818-2819`）→ `createJobService(config, wakeCompileSession)` → `service.start()` → `ctx.effect(() => () => service.stop())`（必须返回清理函数本身，写成 `() => service.stop()` 会在启动时当场停掉服务）→ 构造工具定义 → 起 60 秒心跳的自动更新调度器 `autoScan`（`index.js:2831-2855`，按 `autoUpdateMin` 节流、对 jobs 历史工作区逐个 `scope: 'auto'` 提交、跳过排除项、单仓库失败只记 `lastError`）→ 经 `ctx.inject(['tools'])` 注册四个工具（**逐个 try/catch**：单个 schema 违规只丢该工具，否则 cordis 会把 apply 回调失败视为 fiber FAILED 并回滚已注册的全部工具，`index.js:2857-2872`）→ `installWebServer`（`index.js:2874`）→ `installUpdateReminder`（`index.js:2875`）。

### client.js — 浏览器半侧

**入口与挂载**

- 文件头注释（`client.js:1-8`）记录了全部硬约束：两个挂载点（`plugins.item` 设置表单、`main` + `sidebar.panellist` 侧边栏面板）、设置经 `configForms`（命名空间 `'codewiki'`）读写、**`id` 必须等于 `package.json` 的 `name`**（client-modules 按 nearestPackage 的 name 校验注册者）、**词典值必须是字符串**（函数会让 `t()` 回退返回键名）。
- `window.__ModuleLoader__.load({ id: '@local/dsh-codewiki', factory(require) {...} })`：`client.js:10-12`；`require` 取 `@deepseek-ai/dsh-client-ui-primitives` 的 `Switch`/`Button`/`Input`/`Tag`（`client.js:14-15`）。
- 常量：`NS = 'codewiki'`（`client.js:17`）、`KEY = 'codewiki'`（`client.js:18`，`sidebar.panellist` 的 id 必须与 `main` 的 key 一致）、`JOBS_PATH`（`client.js:19`）、`CONTROL_PATH`（`client.js:20`）、`PANEL_ORDER = 52`（`client.js:21`，排在 dsh-hindsight-on-demand 的 50 之后）、`POLL_MS = 2000`（`client.js:22`）、`REPOS_PATH`（`client.js:23`）、`MODELS_PATH`（`client.js:24`）、`REPOS_POLL_MS = 10000`（`client.js:25`）、`ACTIVE_STAGES = ['plan','articles','crosscut','compose','review','index']`（`client.js:26`）。
- `zh()`：`client.js:28-145`；`en()`：`client.js:146-263`，两份完整词典（插件页文案、面板文案、阶段名、状态名、调度器文案都在内，值全部为字符串）。
- `style`：`client.js:265-345`，用 `document.createElement('style')` 拼 CSS 字符串并挂 `data-plugin="@local/dsh-codewiki"`；注入前查重，避免 HMR 重复加载堆叠样式表（`client.js:345`）。
- `el(tag, props, ...children)`：`client.js:347-349`，`React.createElement` 的薄封装。
- `apiGet(p)`：`client.js:351-356`；`apiPost(p, data)`：`client.js:357-366`，都从响应体里取 `error` 字段抛错，其余情况抛 `HTTP <status>`。
- `apply(ctx)`：`client.js:370-1200`。`inject: ['slots', 'locale', 'configForms']`（`client.js:369`）。`tBound = ctx.locale.bind(NS)`，`ctx.locale.register(NS, { zh: zh(), en: en() })` 包在 `ctx.effect` 里（`client.js:371-372`）；`form = ctx.configForms.get(NS)`（`client.js:375`）；`plugins.item` 只在宿主服务该命名空间期间出现——用 `configForms.whileServed([NS], mount)`，老宿主无该方法时直接 `mount()`（`client.js:386-390`）；`main` + `sidebar.panellist` 两个注册同在一个 `ctx.effect` 里，disposer 逐个兜异常（`client.js:393-404`）。

**组件与渲染辅助**

- `CodewikiCard(props)`：`client.js:410-701`，设置卡片。`props.view === 'summary'` 时只返回一行简介（`client.js:456`）。状态有 `snapshot`（`form.getSnapshot()`）、`draft`、`notice`、`error`、`catalog`、`catalogError`。首次挂载拉 `/api/codewiki/models` 填级联下拉（`client.js:422-433`），拉不到就退回手填形态而不阻断保存。配置快照通过 `form.subscribe` 订阅，只有 `revision` 变化才覆盖草稿（`client.js:436-453`）。`dirty` 用 `JSON.stringify(draft) !== JSON.stringify(snapshot.value)` 判定（`client.js:467-470`）。`save()`（`client.js:479-506`）先本地校验 `maxConcurrency` 必须是 1–8 的整数、`batchThinkingBudget` 必须是 0–32768 的整数，然后**只对真正变了的 14 个 key 生成 `set` op**（key 清单见 `client.js:493`），带 `snapshot.revision` 调 `form.mutate`（乐观并发，冲突时提示 `conflict`）。`discard()`（`client.js:508-512`）回滚草稿。切换提供商时会把 `batchModel` 清空或设为该提供商首个模型，避免残留上一家的模型 id 被误存（`client.js:593-600`）。
- `stageLabel`/`stateLabel`/`kindLabelOf`：`client.js:707-709`，按 `stage<首字母大写>`/`state<…>`/`kind<…>` 拼词典 key；`progressBar(done, total)`：`client.js:710-713`，把完成比例钳到 0–100；`repoName(cwd)`：`client.js:714-717`，取最后两段路径（Temp 沙箱残留一眼可辨）。
- `fmtMs`：`client.js:718-724`（`mm:ss` 或 `h:mm:ss`）；`fmtTok`：`client.js:725-730`（M/k 缩写）；`fmtDur`：`client.js:731-736`；`fmtAgo`：`client.js:737-740`。
- `Spark({ values, width = 56, height = 16 })`：`client.js:742-754`，纯 SVG `path` 微趋势线，少于 2 个有效点返回 `null`。
- `stepName(s)`：`client.js:758`；`lastTimedStage(job)`：`client.js:759-762`，取 `stageTimings` 的最后一个 key 作为失败/取消时的定位点。
- `stageBar(job)`：`client.js:763-785`，六阶段步骤条。已完成绿点（`title` 带该阶段耗时）、当前阶段实心点 + 实时计时（`stageStartedAt` 起算）、终态 `done` 全绿、`failed`/`cancelled` 在最后计时段标红/黄。
- `STAGE_WEIGHTS`：`client.js:787`，`{ plan: 0.05, articles: 0.6, crosscut: 0.1, compose: 0.05, review: 0.15, index: 0.05 }`。`overallPct(job)`：`client.js:788-796`，六阶段定权线性推进 + 阶段内按 `taskList` 完成数折算，**封顶 99，只有 `done` 才 100**。
- `throughputBadge(job, sparkOf, rateOf)`：`client.js:799-819`。三级显示：有 `job.tps` → `tok/s` + spark；有 `batchSubmittedAt` 且有速率样本 → `篇/分 · ETA`；只有 `batchSubmittedAt` → 批次已执行时长。
- `usageLine(job)`：`client.js:821-837`，输入（提交时估算）/输出（实测）token、请求数（分批量/实时通道）、超 32k 档请求数红字提示（3 倍价）。
- `ReposTab()`：`client.js:840-983`，总览标签页。轮询 `/api/codewiki/repos`（`client.js:849-865`，`inFlightRef` 防重叠）；`toggleExclude(r)`（`client.js:870-888`）直接改 `excludePaths`（与设置卡同一 `form.mutate` 链路，经宿主 configForms 持久化并热生效），成功后 `POST { action: 'refresh' }` 再重拉；`compile(cwd)`（`client.js:890-898`）发 `{ action: 'compile', cwd }`。渲染出错时返回 `Repos error: <stack>`（`client.js:980-982`），不让整块白屏。
- `CodewikiPanel()`：`client.js:985-1185`，侧边栏主面板（三个标签：总览 / 任务 / 设置，`client.js:1147-1154`）。轮询 `JOBS_PATH`（`client.js:998-1038`），并在面板侧做**客户端采样**：`sparkRef`（jobId → 最近 30 个 tps 点）与 `batchRateRef`（EWMA，`0.6 * prev + 0.4 * inst`，见 `client.js:1020-1023`）；上一次请求未回包时不重叠拉取（`client.js:1002`）。`cancel(jobId)`：`client.js:1043-1051`；`copyPath(p)`：`client.js:1052-1058`（剪贴板权限拒绝时静默）；焦点任务选取（活动优先，其次最近更新）与历史折叠见 `client.js:1073-1077`；`jobCard(job)`：`client.js:1079-1137`，渲染单个任务（状态标签、阶段条、进度条、吞吐徽标、任务明细、活动流、错误行、wiki 路径复制）。
- `PanelIcon(props)`：`client.js:1187-1198`，16×16 摊开的书 SVG，作为 `sidebar.panellist` 的入口图标。

## Architecture

```text
┌──────────────────────────────┐         ┌───────────────────────────────────────┐
│ 浏览器半侧 client.js          │         │ 宿主半侧 index.js                      │
│                              │         │                                       │
│ CodewikiCard 410 ────────┐   │ config  │  apply 2816 ── Config 37               │
│   (plugins.item)         │   ├────────►│    ├─ cw 875 / generate 2157           │
│ CodewikiPanel 985 ───────┤   │         │    ├─ update 2315 / progress 2386      │
│   main + panellist       │◄──┼─ HTTP ──┤    ├─ installWebServer 2533            │
│ ReposTab 840 / Icon 1187 │   │ 回环    │    └─ installUpdateReminder 2782       │
│ stageBar 763 / pct 788   │   │         │                                       │
└──────────────────────────┘         │    │  createJobService 1219                 │
                                     │    │   tick 2020 ── 每 10s ──┐             │
                                     │    │   STAGE_HANDLER 2011     │             │
                                     │    │   settleJob 1347 ◄───────┘             │
                                     │    │   batchRuns/Results/Aborters 1419      │
                                     │    └──────────┬────────────────────────────┘
                                     ▼               ▼
                    ┌────────────────────────┐  ┌──────────────────────────────┐
                    │ 本地 cw CLI            │  │ 百炼 chat/completions 285     │
                    │ resolveBinary 84       │  │ 或宿主 llm 服务 llmChat 263   │
                    │ runCw 106（120s 超时）  │  │ 或会话通道 dispatch 1494      │
                    └────────────────────────┘  └──────────────────────────────┘

持久化（同目录、同生命周期）：JOBS_FILE 1017 · REPOS_FILE 1072
  · JOBS_LOCK_FILE 1132（60s 过期） · SESSION_TASK_DIR 1023
```

三条执行通道的取舍是这张图的核心：批量通道（百炼直连或宿主 llm）承接 ≤28k 单请求与多批观察；会话通道在该模块连 200k 都装不下时兜底，把写作/校对交给发起会话的子智能体；`cw` CLI 只负责判态、建索引、刷基线这三件「本地事实」工作，不参与任何文本生成。

## Data Flow

1. **初始化**：`apply()`（`index.js:2816`）建服务、`service.start()` 起 10s tick（`index.js:2139`）、注册四个工具、装 Web 端点与系统提示提醒；`client.js` 的 `apply()`（`client.js:370`）注册词典、样式、设置卡片与侧边栏面板。
2. **提交判态**：调用方（模型工具 / 面板编译按钮 / 自动调度）→ `codewiki_generate.execute`（`index.js:2200`）→ `cw status` → `parseStatus`（`index.js:157`）得四态之一（`missing`/`uncompiled`/`clean`/`stale`）。
3. **建 job**：`svc.submit`（`index.js:2066`）先落 `submitting` 占位、解析凭证、再置 `plan`（full）或 `articles`（stale），`persist()` + `flush()` 后立即 `void tick()`（`index.js:2119-2121`）。
4. **规划** `tickPlan`（`index.js:1572`）：`scanRepoFiles` → 先试主模型规划 `runMainModelPlan`（`index.js:1621`）→ 降级百炼批量 → 均不可用则 `localPlan`（`index.js:699`）按顶层目录分组。产出 `job.plan = { project, modules[], concepts[] }`。
5. **写文章** `tickArticles`（`index.js:1672`）：`job.plan.modules` → 任务（`name: modules/<slug>.md`）→ `prepareArticleTasks`（`index.js:580`）分流：
   - `prepared` → `submitBatchFor`（`index.js:1467`）→ `startBatchChatRun`（`index.js:1422`）→ `runRealtimeTasks`（`index.js:326`）并发打模型；
   - `#obs` 观察批 → 收割后用 `batchArticleComposePrompt`（`index.js:818`）合成；
   - `sessionTasks` → `dispatchSessionTasks`（`index.js:1494`）写任务文件 + steer 发起会话。
   结果回 `batchResults`，下一轮 `settleJob`（`index.js:1347`）收割 → `tally`（`index.js:1392`）→ `writeValidated`（`index.js:1373`，frontmatter 闸门 + `fixAnchors` 修锚点）落盘。
6. **横切** `tickCrosscut`（`index.js:1806`）：读回成功文章全文 → ≤28k 单批直出 `_architecture.md`/`_patterns.md`/概念文章；超预算改「每篇一个观察」→ `tickCompose`（`index.js:1872`）合成。
7. **校对** `tickReview`（`index.js:1921`）：`localReview`（`index.js:1899`）先本地核对 frontmatter/文件存在性/`source_files`，再按「文章 + source_files 源码」装填 `batchProofreadPrompt`（`index.js:850`）；结果 `tally(..., { replace: true })` 覆盖同名条目，校对失败不推翻原文。
8. **索引** `tickIndex`（`index.js:1986`）：`cw index` → `cw meta update` → `normalizeIndexLinks` → `ensureWikiEntry` → `done` + `finishedAt` + `onSettled(job, 'done')` → `wakeCompileSession`（`index.js:1206`）steer 发起会话「请提交改动」。
9. **进度回流**：面板每 2s 拉 `/api/codewiki/jobs`（`client.js:1036`）、每 10s 拉 `/api/codewiki/repos`（`client.js:863`）；`jobSummary`（`index.js:1158`）的 `taskList` 决定进度条分母，`STAGE_WEIGHTS`（`client.js:787`）决定权重，tps/速率由面板侧采样（`client.js:1009-1026`）计算。
10. **取消**：`cancel()` 置 `cancelRequested` 并 `flush`（`index.js:2125`）；下一轮 `tick` 读到后 `abort` 在飞请求（未完成请求不计费）、丢弃未收割结果、置 `cancelled`（`index.js:2039-2048`）。
11. **重启接管**：进程重启后新 `instanceId` 与原 `owner` 不符，`tick` 在 `idleMs > ORPHAN_TAKEOVER_MS` 时改 owner 接管（`index.js:2028-2037`）；在途会话任务补发 steer（`resendSessionSteer`，`index.js:1555`），批量任务的执行器已随连接消失，靠 `settleJob` 用 `job.tasks` 的 `batchPrompt` 快照重跑（`index.js:1356-1365`）。

## Connections

- 上游 CLI：`[[cw-cli-wrapper]]`（本模块经 `runCw` `index.js:106`、`parseStatus` `index.js:157`、`normalizeArticlePath` `index.js:143`、`wikiPathFor` `index.js:996` 与 `cw` 交互）。行号锚点的符号提取规则与 `test-wiki-anchors.mjs` 同源（`index.js:387-391` 注释说明两处同源、改一处须同步另一处）。
- 提示词工程：`[[prompt-templates]]`（`articleFormatSection` `index.js:644-673` 与各 `batch*Prompt` 家族是文章产出格式与判据的来源）。
- 持久化与并发：`[[job-store-and-locking]]`（`JOBS_FILE`/`JOBS_LOCK_FILE`/`REPOS_FILE`、`mergeFromDisk` `index.js:1251`、`dirtyIds` 的语义在此展开）。
- 面板与宿主 UI：`[[sidebar-panel-ui]]`（`client.js` 的 slot 挂载、词典、样式、组件树）。
- 外部依赖：阿里云百炼 OpenAI 兼容入口（`bailianChat` `index.js:285`）、宿主 `llm` 服务（`llmChat` `index.js:263`）、宿主 `agents` 服务（`wakeCompileSession` `index.js:1206`）、`credentials` 服务（`resolveBatchApiKey` `index.js:548`）、`webServer` 服务（`installWebServer` `index.js:2533`）、`workspaceRegistry` 服务（`index.js:2542`）、`systemPrompt` 服务（`installUpdateReminder` `index.js:2782`）、`tools` 服务（`index.js:2857`）。
- 参考实现：侧边栏面板的挂载方式与 `dsh-hindsight-on-demand` 同款，`PANEL_ORDER = 52` 排在它的 50 之后（`client.js:21`）。

## Known Issues

- **Token 估算只是近似**：`estimateTokens`（`index.js:249`）用「CJK 1 token/字 + 其余 3.5 字符/token」，与真实分词器有偏差。预算靠 `BATCH_TOKEN_BUDGET`（`index.js:366`）留的 ~4k 余量吸收，但边界请求仍可能被实际计费判进 32k 以上档；`submitBatchFor` 会统计并在 `overTier2` 与 note 里显式提示（`index.js:1470-1474`）。
- **锁是单文件 + 60 秒过期**：`acquireTickLock`（`index.js:1135`）靠 `wx` 独占创建 + mtime 判断，进程崩溃残留的锁要等 60 秒才被强删；这段时间内所有实例都让路，任务原地停摆。`releaseTickLock`（`index.js:1150`）在 `finally` 执行，但异常路径仍可能留下短期残锁。
- **执行器随连接生死**：`runRealtimeTasks`（`index.js:326`）的请求没有服务端批次可续查，宿主一重启就只剩「按 `batchPrompt` 快照全阶段重跑」这一条路（`settleJob` 的 `index.js:1356-1368`）。快照缺失时直接 `fail`，已写成的文章不回滚但本阶段作废。
- **会话通道依赖发起会话存活**：`dispatchSessionTasks`（`index.js:1494`）在无 agent 或无 `steer` 时直接 fail（`index.js:1496-1500`）。面板、自动调度这类无会话提交一旦触发超预算任务就必然失败，只能「从会话内重新提交编译」。会话通道也不降级回百炼，超时（默认 30 分钟，`index.js:1022`）即按失败处理。
- **会话通道的收割判据偏松**：`classifySessionTask`（`index.js:1029`）只要求 `mtime >= dispatchedAt` 且去前导空白后以 `---` 开头。子智能体写到一半（frontmatter 已落、正文未完成）时这两个条件都可能同时满足，`writeValidated` 的闸门同样只看开头三横线（`index.js:1373`），存在把半成品当成品收割的窗口。
- **`fixAnchors` 明示的盲区**：符号在文内出现多处且都不是唯一声明形态时，它选择「不动」并记 `unresolved`（`index.js:461-464`）；点分符号歧义时退试首段（`index.js:443-444`），仍可能命中错误行；`source_files` 之外的文件引用一律不碰（`index.js:398-402`），所以 frontmatter 漏列文件时锚点不会被校验。
- **tick 是串行推进**：`tick()`（`index.js:2020`）对 `jobs` 逐个 `await handler`，一个 job 的 `settleJob`/`runCw`（最长 120s）会拖住同实例里其他 job 的推进；`ticking` 重入锁与 `TICK_MS` 让节拍可能被显著拉长。
- **`cw status` 解析强依赖文本**：`parseStatus`（`index.js:157`）匹配的是 `'No wiki found'`、`'has not been compiled yet'`、`'Wiki is up to date'` 三个英文字面量与 `^\s+[M!]\s+` 行格式。上游 `cw` 改一句文案，三态判定就会整体落到「无法解析 → 改走全量编译」（`index.js:2280-2287`），代价是白跑一次全量。
- **Windows 路径兼容是启发式**：`normalizeCwd`（`index.js:26`）只处理 `/e/...` 这一类 MSYS 盘符写法；`excludedItem`（`index.js:228`）、`rememberRepo`（`index.js:1076`）、`samePath`（`index.js:2375`）各自做归一与大小写处理，三处规则不完全一致，混合大小写与尾斜杠组合时可能出现「排除了但仍出现在总览」这类不一致。
- **面板的速率/进度是客户端估算**：`overallPct`（`client.js:788`）用固定 `STAGE_WEIGHTS`（`client.js:787`），与实际耗时无关；`batchRateRef` 的 EWMA 只在面板轮询跨度内有效，刷新页面或切换工作区后 tps 曲线与 ETA 会从零重建，不反映真实剩余时间。
- **UI 兜底只覆盖渲染期异常**：`ReposTab`（`client.js:840`）与 `CodewikiPanel`（`client.js:985`）用 try/catch 把渲染异常显示成 `<...> error: <stack>`（`client.js:980-982`、`client.js:1180-1184`），但样式表或 `@deepseek-ai/dsh-client-ui-primitives` 加载失败发生在更外层，仍可能整块不渲染。
- **面板轮询无退避**：`CodewikiPanel` 固定 2s（`POLL_MS` 见 `client.js:22`）、`ReposTab` 固定 10s（`REPOS_POLL_MS` 见 `client.js:25`），只做「不重叠」没做指数退避；Web 服务卡顿时前端仍按原频率发请求。
- **`batchThinkingBudget` 只在百炼通道生效**：`llmChat`（`index.js:263`）不下发思考预算（宿主侧是 `reasoningEffort` 枚举），设置页该项对非百炼 provider 无效，这一点只由词典提示文案说明（`client.js:53`），服务端既不校验也不告警。
- **客户端设置 key 清单是硬编码**：`save()` 只遍历 `client.js:479-497` 里硬编码列出的 14 个 key 生成 diff op，后端 Config 新增字段时若忘了同步这份清单，该字段在设置页改不动（不报错、仍提示已保存，但值未变）。
