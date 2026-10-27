---
title: configuration-management
type: concept
source_files:
  - cordis.patch.yml
  - index.js
  - client.js
tags: [configuration, settings, plugin-system, configForms, patch]
---

## Overview

`configuration-management` 是 dsh-codewiki 里「配置值如何被声明、归一化、校验、持久化、热读取」的横切概念。它横跨三个文件：

- `cordis.patch.yml` —— 静态挂载元数据：插件挂载 id `codewiki` 与初值 `config: {}`（`- insert:` 在 `cordis.patch.yml:3`，`id: codewiki` 在 `cordis.patch.yml:20`，`name:` 指向 `index.js` 的 `file:///` 直挂路径在 `cordis.patch.yml:21`，`config: {}` 在 `cordis.patch.yml:24`；头部注释段 `cordis.patch.yml:5-18` 只文档化了 25 个设置项中的 13 个，见 `cordis.patch.yml:6-18`）。
- `index.js` —— 配置 schema（`Config`，`index.js:70-96`，25 个字段）、取值兼容层（`val`，`index.js:98-100`）、唯一归一化入口（`liveConfig`，`index.js:102-144`），以及散布在各条边界上的消费点（工具 execute、`submit` 闸门、阶段执行器、Web 端点、自动更新调度器、`installUpdateReminder` 提醒）。另有少量**进程级配置走环境变量**，模块加载时读一次、不热生效（见下）。
- `client.js` —— 浏览器侧设置表单（`CodewikiCard`，`client.js:550-1038`），经宿主 `configForms` 服务的命名空间 `codewiki`（`NS` 声明在 `client.js:17`，`form = ctx.configForms.get(NS)` 在 `client.js:515`）读写同一份配置；总览页还能就地改写 `excludePaths`（`toggleExclude`，`client.js:1214-1232`）。

核心设计取向：**插件没有自己的配置文件**。配置的权威副本在宿主的 Config 服务里，插件侧只声明 schema、并在每次使用时现场调一次 `liveConfig(config)`。因此不存在「改了设置要重启」的问题 —— 这条承诺写在客户端词典的 `intro` 文案里（zh 版 `client.js:38`「此处设置经 configForms 热生效，无需重启」，en 版 `client.js:214` 'Settings here apply hot via configForms — no restart needed'）。

一致性的另一条主线：**全部字段都带 `.volatile()`**（`Config` 声明里每个字段链尾都是 `.volatile()`，`index.js:70-95`），即配置不落持久化快照、读取永远取当前值。这也是 `liveConfig` 可以在各条边界反复调用的前提。

第三个取向是**默认值双保险**：`cordis.patch.yml` 的初值是空对象 `{}`（`cordis.patch.yml:3`），所以所有默认值必须由 `Config` 的 `.default()`（`index.js:70-96`）与 `liveConfig` 的回落表达式（`index.js:102-144`）共同兜住；两处任一缺失都会让字段变成 `undefined` 并向下游传播。

id 对齐关系：cordis 挂载 id 是 `codewiki`（`cordis.patch.yml:20`），插件名是 `dsh-codewiki`（`PLUGIN_NAME` 在 `index.js:37`，`export const name` 在 `index.js:38`）；客户端模块 id 是 `@local/dsh-codewiki`（`client.js:18`），`NS` 与 `KEY` 都必须是 `codewiki`（`client.js:17`、`client.js:18`）。

## Key Components

### `index.js` — schema、常量与归一化

**相关常量**

| 常量 | 位置 | 用途 |
| --- | --- | --- |
| `PLUGIN_NAME` / `export const name` | `index.js:37-38` | 插件名 `dsh-codewiki`（package 对齐） |
| `CW_SUBCOMMANDS` | `index.js:39` | cw 子命令白名单，在 cw 工具入口做门禁（`cwToolDefinition` 校验在 `index.js:1599-1601`） |
| `CONCURRENCY_HARD_CAP` | `index.js:41` | 值 `8`；`maxConcurrency`/`bigConcurrency` 的运行期硬顶（`liveConfig` 钳制在 `index.js:117-119`、`index.js:121-123`） |
| `DEFAULT_CONCURRENCY` | `index.js:43` | 值 `2`；默认档并发默认值（`liveConfig` 回落在 `index.js:102`） |
| `DEFAULT_BATCH_PROVIDER` / `DEFAULT_BATCH_MODEL` | `index.js:45-46` | 值 `'workbuddy'` / `'hy3'`；编译模型默认值（`Config` 默认与 `liveConfig` 空串回落都引用，见 `index.js:102-103`、`index.js:110`） |
| `DEFAULT_BIG_PROVIDER` / `DEFAULT_BIG_MODEL` | `index.js:49-50` | 值 `'volces-ark'` / `'glm-5.3-flash'`；大档模型默认值（`index.js:50`、`index.js:113`） |
| `DEFAULT_BIG_TOKEN_BUDGET` | `index.js:52` | 值 `420000`；大档单请求输入预算默认值（`index.js:79`、`index.js:115`） |
| `WIKI_PATHS` | `index.js:55` | `['.codewiki', 'CodeWiki.md']`；`autoCommitWiki` / `commitHintText` 固定 pathspec（`index.js:4739`、`index.js:4655`） |
| `BATCH_TOKEN_BUDGET` | `index.js:663` | 值 `110000`；普通档单请求输入预算，同时是 `bigTokenBudget` 的下限（`liveConfig` 在 `index.js:115`） |
| `BATCH_TOKEN_HARD_LIMIT` | `index.js:668` | 值 `128000`；超预算兜底装填上限（大档未启用时单文件硬上限，`index.js:1190`、`index.js:3147`） |

**进程级环境变量配置**（模块加载时读一次、不热生效）：`JOBS_FILE`（`index.js:1876`，env `DSH_CODEWIKI_JOBS_FILE`，默认 `%TEMP%/dsh-codewiki-jobs.json`）、`TICK_MS`（`index.js:1877`，env `DSH_CODEWIKI_TICK_MS`，下限 250ms 默认 10s）、`SESSION_TASK_TIMEOUT_MS`（`index.js:1881`，env `DSH_CODEWIKI_SESSION_TIMEOUT_MS`，下限 5 分钟默认 30 分钟）、`ORPHAN_TAKEOVER_MS`（`index.js:2069`，env `DSH_CODEWIKI_ORPHAN_TAKEOVER_MS`，下限 60s 默认 5 分钟）、`REPOS_FILE`（`index.js:2075`，env `DSH_CODEWIKI_REPOS_FILE`）。派生路径/常量：`MAX_JOBS_KEPT`（`index.js:2070`，30）、`WORKTREE_CACHE_TTL_MS`（`index.js:385`，60s）、`SOURCE_PROBE_TTL_MS`（`index.js:405`，10 分钟）、`SESSION_FLUSH_MS`（会话记录实时落盘节流，声明于 `index.js:1894`、使用于 `index.js:2075`）。

**`Config`（`index.js:70-96`）** —— 用 schemastery（`z`）声明的插件配置 schema，**25 个字段**，全部 `.volatile()`：

| 字段 | 行号 | 类型 / 默认值 | 说明（压缩自 `.description`） |
| --- | --- | --- | --- |
| `enabled` | `index.js:71` | boolean，`true` | 停用后两个工具立即报错 |
| `binaryPath` | `index.js:72` | string，`''` | cw 可执行文件路径；留空优先 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | `index.js:73` | string，`'workbuddy'` | 编译模型提供商（模型设置里已注册的 provider id）；留空将无法提交任务 |
| `batchModel` | `index.js:74` | string，`'hy3'` | 编译模型（全部模型环节共用） |
| `batchReasoningEffort` | `index.js:75` | string，`''` | 思考程度档位 id；留空=模型默认档，可选值由模型目录实时读取（`/api/codewiki/model-efforts`） |
| `bigProvider` | `index.js:76` | string，`'volces-ark'` | 大档模型提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | `index.js:77` | string，`'glm-5.3-flash'` | 大档模型 id（默认 512k 上下文） |
| `bigReasoningEffort` | `index.js:78` | string，`''` | 大档模型思考程度；留空=模型默认档 |
| `bigTokenBudget` | `index.js:79` | number，`420000` | 大档单请求输入预算（token）；超 110k 普通预算的请求改用大档 |
| `sessionTier` | `index.js:80` | string，`''` | 会话通道档位 id（仅当大档都装不下且 bigProvider 留空时兜底）；留空=自动选路 |
| `maxConcurrency` | `index.js:81` | number，`2` | 默认档并发上限（1–8），硬顶 8 |
| `bigConcurrency` | `index.js:82` | number，`0` | 大档并发上限（1–8）：留空或 0 = 跟随默认档，两档独立限流 |
| `serialProjects` | `index.js:83` | boolean，`true` | 单项目串行，其余仓库排队（queued） |
| `parallelProjects` | `index.js:84` | number，`2` | 并行仓库上限（1–4），关串行后生效 |
| `articleLanguage` | `index.js:85` | string，`'中文'` | wiki 文章书写语言 |
| `planMode` | `index.js:86` | string，`'auto'` | 模块划分：auto=AST 符号 + LLM 语义聚类（失败降级目录分组）；dirs=顶层目录分组 |
| `agenticArticles` | `index.js:87` | boolean，`true` | 文章走 agentic 工具循环（read_code/list_files/edit_article）；关闭走单轮整包装填旧通道 |
| `agenticMaxSteps` | `index.js:88` | number，`30` | agentic 单篇最大步数（硬顶 100） |
| `symbolIncremental` | `index.js:89` | boolean，`true` | stale 增量按 AST 符号级判定；关闭按文件级 mtime/hash |
| `updateReminder` | `index.js:90` | boolean，`true` | 会话系统提示注入维护提醒（仅当仓库根存在 CodeWiki.md） |
| `autoCommit` | `index.js:91` | boolean，`true` | 编译完成后插件在主题分支提交产物再合并回原分支；失败降级为提醒 |
| `excludePaths` | `index.js:92` | string，`''` | 排除清单：换行/分号/逗号分隔绝对路径 |
| `autoUpdate` | `index.js:93` | boolean，`false` | 自动更新调度（定时扫描 + 增量编译） |
| `autoUpdateMin` | `index.js:94` | number，`30` | 扫描间隔（分钟），最小 5 |
| `workspaceOnly` | `index.js:95` | boolean，`true` | 任务页只显示宿主已添加工作区的任务 |

**`val(x)`（`index.js:98-100`）** —— 取配置值的兼容层。宿主传进来的 config 可能是 schemastery 包装（带 `.get()`），也可能就是普通对象：

```js
function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}
```

所有字段读取都经它，因此下游代码不必关心 config 形态。注意 `installUpdateReminder` 的提醒回调直接用 `val(config?.updateReminder)` 读原始 config（`index.js:4796`），没有走 `liveConfig`。

**`liveConfig(config)`（`index.js:102-144`）** —— **唯一的配置归一化入口**。逐字段 `val()` 后做类型强制与钳制，返回普通对象（含派生字段 `parallelLimit`）：

- `const c = config ?? {}`（`index.js:104`），`concurrency`/`bigConcurrency` 先转 Number（`index.js:105-106`）。
- `enabled: val(c.enabled) ?? true`（`index.js:107`）—— 缺省视为开启。
- `batchModel` 空串回落 `'hy3'`（`index.js:110`）；`bigModel` 空串回落 `'glm-5.3-flash'`（`index.js:113`）。
- `bigTokenBudget`：`Math.max(BATCH_TOKEN_BUDGET, Number(val(c.bigTokenBudget)) || DEFAULT_BIG_TOKEN_BUDGET)`（`index.js:115`）—— 下限为普通预算 110k，非法值回落 420000。
- `maxConcurrency` 双重钳制（`index.js:117-119`）：非有限数或 `< 1` 回落默认 `2`，否则 `Math.min(concurrency, CONCURRENCY_HARD_CAP)`。**schema 的 `.default()` 不构成约束，真正的上限只在这里。**
- `bigConcurrency`（`index.js:121-123`）：非有限数或 `< 1` 回落 `0`（跟随默认档），否则钳到 8。
- `serialProjects: val(c.serialProjects) !== false`（`index.js:124`）—— 缺省视为开启。
- `parallelLimit`（`index.js:125-129`）：`serialProjects` 非 false 恒返回 `1`；否则 `parallelProjects` 四舍五入钳到 1–4，非法值回落 `2`。
- `articleLanguage` 空串回落 `'中文'`（`index.js:130`）。
- `planMode`（`index.js:131`）：白名单 `['auto', 'dirs']`，之外的值回落 `'auto'`。
- `agenticArticles: val(c.agenticArticles) !== false`（`index.js:132`）；`agenticMaxSteps`（`index.js:133-136`）钳到 1–100、默认 30；`symbolIncremental: val(c.symbolIncremental) !== false`（`index.js:137`）。
- `excludePaths` 原样透出字符串不做切分（`index.js:138`；切分在各消费点做，见下）。
- `autoUpdate: val(c.autoUpdate) === true`（`index.js:139`）—— 缺省视为**关闭**（与 `autoCommit`/`enabled` 的 `!== false` 语义相反）。
- `autoUpdateMin: Math.max(5, Number(val(c.autoUpdateMin)) || 30)`（`index.js:140`）。
- `autoCommit: val(c.autoCommit) !== false`（`index.js:141`）、`workspaceOnly: val(c.workspaceOnly) !== false`（`index.js:142`）—— 缺省视为开启。

**字段级消费者（独立函数）**

- `resolveBinary(cfg)`（`index.js:150-170`）：`binaryPath` 的消费点。显式值优先（`index.js:151`）；否则 win32 用 `where cw`（`index.js:156-159`）、POSIX 用 `which cw`（`index.js:162-165`）探测 PATH；再回落插件自带 `bin/cw(.exe)`（`index.js:167`）；最后是裸 `'cw'`（`index.js:169`）。PATH 优先的理由写在注释里（`index.js:152-153`）：避免捆绑二进制落后于 codewiki 源码，出现「bash 原生正常、包装层 No wiki found」的分叉。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`（`index.js:339-348` / `index.js:349-351`）：`excludePaths` 的消费点。分隔符 `/[\n;，,]+/`（`index.js:340`），兼容换行、分号、中英文逗号；比较时 `path.normalize` + 小写 + 剥尾斜杠，`cwd` 等于某项或位于其子树内即命中（`index.js:342-346`）。`excludedItem` 返回命中的排除项**原文**（工具报错据此告诉模型是哪条排除项拒绝了此工作区，`index.js:337-338` 注释），`isExcluded` 是布尔包装。
- `listModelCatalog(llm)`（`index.js:4265-4286`）：设置页「编译模型」级联下拉的数据源。遍历 `llm.listProviders()` 并对每个 provider 调 `listModels(id)`（`index.js:4270-4284`）；单个 provider 抛错只给该条目附 `error` 并保留空 `models`，不影响其它 provider；`llm` 未注入或无 `listProviders` 时整体 `ok:false`（`index.js:4266-4267`），设置页降级为手填。
- `resolveModelInfoOf(llm)`（`index.js:4292-4297`）：适配宿主的 `resolveModelInfo`，旧版 `resolveModel` 兜底（背景见 `index.js:4288-4291` 注释）。
- `resolveModelEfforts(llm, provider, model)`（`index.js:4303-4325`）：思考程度档位数据源，取 `reasoning.efforts` 与 `defaultEffort`（`index.js:4310-4319`），另带 `context`（`index.js:4320`）；llm 缺 `resolveModelInfo` 或探测失败都返回 `ok:false`，设置页降级为默认档或通用档位。选了模型不支持的档位由 `llmChat` 兜底：`UNSUPPORTED_REASONING_EFFORT` 时剥掉 effort 用模型默认档重试一次（`index.js:482-486`），不让整篇编译失败。
- `commitHintText(cwd, jobs)`（`index.js:4739-4770`）：`updateReminder` 链路上的「产物待提交」段。只在最近一次成功编译的产物「插件自动提交未成功」时提醒（`autoCommitState(latest) === 'pending'`，`index.js:4637`），并比对 `git log` 时间戳与任务完成时间（`index.js:4751-4756`），带 60 秒 TTL 缓存（`commitHintCache` 声明在 `index.js:4637`，命中判定 `index.js:4742`，回写 `index.js:4768`）。
- `reminderText(cwd)`（`index.js:4772-4781`）：维护提醒正文（收尾必须跑 `codewiki_generate`、不要手工改 `.codewiki/`、不要轮询等）。
- `installUpdateReminder(ctx, config)`（`index.js:4783-4815`）：把提醒注册成 systemPrompt section `codewiki:update-reminder`（`index.js:1000-1001`），`order` 排在 `TOOL_REPORT` 之后（`index.js:4794`）。`text` 是回调，每次组装系统提示都重新求值（`index.js:4795-4801`）：`updateReminder` 为 `false` 返回空串（`index.js:4796`）；会话 cwd 下没有 `CodeWiki.md` 返回空串（`index.js:4772`，判定不看 `.codewiki/` 目录，理由见 `index.js:4739-4742` 注释）；否则返回 `reminderText(cwd)` 并按需拼上 `commitHintText`（`index.js:4800`）。

### `index.js` — 配置消费点（读取边界）

配置不集中在一处读，而是在**每条边界现场调一次 `liveConfig`**：

- 工具 execute 的 `enabled` 门禁：`cwToolDefinition`（`liveConfig` 在 `index.js:1640`、抛错在 `index.js:1641`）；`generateToolDefinition`（`liveConfig` 在 `index.js:3714`、抛错在 `index.js:4119`，同函数里排除清单判定在 `index.js:4048-4049`、文章语言解析在 `index.js:4825`）；`progressToolDefinition`（`liveConfig` 在 `index.js:1599`、抛错在 `index.js:4210`）；`updateToolDefinition` 复用 `generateDef.execute({ ...args, scope: 'auto' }, exec)`（`index.js:4090`）并只替换错误文案里的工具名（`index.js:4096`），因此继承同一道门禁。
- 提交闸门 `submit()`（`index.js:3579-3680`）：先 `excludedItem` 拦排除目录（`index.js:3581-3584`，错误文案带命中的排除项与编辑指引）；worktree 闸门（检测函数 `detectLinkedWorktree` 在 `index.js:364`，在 `submit` 内调用位于 `index.js:407`）与空壳目录闸门（`hasCompilableSources` 在 `index.js:2263`，在 `submit` 内调用位于 `index.js:2424`）跟配置无关但共用同一入口；再校验编译模型三元组——`batchProvider` 非空（`index.js:3649`）、`batchModel` 非空（`index.js:3650`）、`llmRef.stream` 可用（`index.js:3505`），失败即 `fail` 并抛错；解析结果写进 `job.credentialSource = llm(...)`（`index.js:3662`）。项目闸门读 `c1.parallelLimit` 与 `c1.serialProjects`（`index.js:3662-3671`），排队文案区分「单项目串行 / 并行上限 N」（`index.js:3669`）。
- 阶段执行器：`startBatchChatRun`（`index.js:2629-2671`）每次取 `liveConfig(config)`（`index.js:2630`）决定 provider/model/reasoningEffort/maxConcurrency/bigConcurrency（`index.js:2676-2681`）；`startAgenticRun`（`index.js:2879-2929`）同样取值（`index.js:2755`、`index.js:2758-2763`）并传 `maxSteps: c.agenticMaxSteps`（`index.js:2692`；agentic 通道由 `tickArticles` 在 `index.js:3017-3045` 启动）。`submitBatchFor` 在提交时按 `liveConfig` 统计大档请求数（`tier2`，`index.js:2758`）与并发/模型文案（`index.js:2779-2787`）。
- 规划：`buildPlan` 按 `c.planMode === 'dirs'` 走目录分组（`index.js:2730-2733`），否则语义聚类并把 `batchProvider/batchModel/batchReasoningEffort` 传给 `semanticPlan`（`index.js:2737-2744`）。
- 文章阶段：`tickArticles` 按 `c0.agenticArticles` 决定走 agentic 通道（`index.js:3017`）还是装填通道，装填时把 `bigProvider/bigModel/bigReasoningEffort/bigTokenBudget` 传给 `prepareArticleTasks`（`index.js:3047-3051`）。大档档位对象（`bigTier`）在文章装填（`index.js:1169-1176`）、横切（`index.js:3139-3146`）与校对（`index.js:2879-2886`）各构造一次，统一以 `bigProvider` 非空为启用条件、`bigTokenBudget` 为预算下限钳制；agentic 通道则通过 `markBigAgenticTasks` 按 `sourceTokensOf` 给超大模块打大档标记（`index.js:3021-3032`）。
- 收尾：`tickIndex` 按 `liveConfig(config).symbolIncremental` 决定是否写符号快照（`index.js:4695`）与 `liveConfig(config).autoCommit` 决定是否进 `commit` 阶段（`index.js:3346`）。
- 会话通道档位：`sessionTier` 在派发 steer 时读取（`index.js:2821`）与宿主重启重发时读取（`index.js:2049`），交给纯函数 `buildSessionSteerText({ job, snapshots, tier, resend })`（`index.js:2049-2067`）；非空时文本里插入「必须显式传 tier」的要求行（`index.js:2052`）。
- 调度节拍：`tick()` 读 `liveConfig(config).parallelLimit` 做项目闸门（`index.js:3491`）。
- Web 端点：`installWebServer`（`index.js:4327-4622`）。`wsFilterPaths()`（`index.js:4343-4358`）读 `workspaceOnly`（`index.js:4346`）决定是否按宿主工作区过滤；`/api/codewiki/jobs`（注册于 `index.js:349-385`）用 `isExcluded(j.cwd, wsPaths)` 过滤终态任务（`index.js:4829`）；`/api/codewiki/repos`（注册于 `index.js:4408-4497`）读 `c.excludePaths` 组装每个仓库的 `excluded` 标记（`index.js:4451`）与调度器状态（enabled/intervalMin/lastScan 等取自 `c.autoUpdate`/`c.autoUpdateMin` 与 `schedState`，`index.js:4481-4487`）；`/api/codewiki/models`（注册于 `index.js:4549-4564`）与 `/api/codewiki/model-efforts`（注册于 `index.js:4568-4588`）为设置页供数。
- 自动更新调度器 `autoScan()`（`index.js:4831-4858`）：读 `autoUpdate`（`index.js:4833`）、`autoUpdateMin`（`index.js:4834`）、`excludePaths`（`index.js:4843`）。60 秒心跳（`index.js:4825`）但内部按 `autoUpdateMin * 60000` 节流（`index.js:4829`）；对 job 历史工作区去重后逐个跳过被排除项（`index.js:4843`）、worktree（`index.js:4845`）、空壳目录（`index.js:4848`），其余调 `generateDef.execute({ cwd, scope: 'auto', auto: true }, {})`（`index.js:4851`），单仓库失败只记 `schedState.lastError`（`index.js:4854`）。
- stale 符号级增量：generate execute 里 `cInf.symbolIncremental` 决定是否做组件级过滤（`const cInf0 = liveConfig(cfg)` 在 `index.js:3859`，判定在 `index.js:3862`）。

### `client.js` — 设置表单

- 命名空间常量：`NS = 'codewiki'`（`client.js:18`）、`KEY = 'codewiki'`（`client.js:18`）。`NS` 同时是 `configForms` 命名空间与 `plugins.item` 注册 id；`KEY` 是 `main` 面板与 `sidebar.panellist` 的共同 id。
- 端点与节奏常量：`JOBS_PATH`/`CONTROL_PATH`（`client.js:19-20`）、`PANEL_ORDER = 52`（`client.js:23`）、`POLL_MS = 2000`（`client.js:24`）、`REPOS_PATH`（`client.js:25`）、`SESSIONS_PATH`/`SESSIONS_ITEM_PATH`（`client.js:26-27`）、`MODELS_PATH`/`EFFORTS_PATH`（`client.js:27-28`）、`GENERIC_EFFORTS = ['off','low','medium','high','xhigh','max']`（`client.js:33`）、`REPOS_POLL_MS = 10000`（`client.js:20`）、`ACTIVE_STAGES`（`client.js:33`，queued→commit 七个活动阶段）。
- 词典：`zh()`（`client.js:35-210`）/ `en()`（`client.js:211-386`）覆盖全部配置项的 label 与 hint。
- 挂载与门控：`inject: ['slots', 'locale', 'configForms']`（`client.js:518`）、`form = ctx.configForms.get(NS)`（`client.js:515`）；设置卡片经 `ctx.configForms.whileServed([NS], mount)` 只在宿主服务该命名空间时出现（`client.js:526-530`，无该 API 时直接 `mount()`）；侧边栏面板挂载在 `client.js:533-544`（`main` + `sidebar.panellist`）。
- `CodewikiCard(props)`（`client.js:550-1038`）：设置 UI 主体。
  - state：`snapshot`/`draft`/`notice`/`error`/`catalog`/`catalogError`（`client.js:553-560`）；模型目录经 `apiGet(MODELS_PATH)` 拉取（`client.js:564-572`），`ok === false` 或请求失败时置 `catalogError` 退回手填形态（`apiGet`/`apiPost` 在 `client.js:497-512`）。
  - 快照订阅：`pull()` 按 `snap.revision` 变化才用 `structuredClone` 覆盖草稿，`form.subscribe(pull)` 清理时释放（`client.js:591-608`）；summary 视图一行简介（`client.js:591`）。
  - `setPath`（`client.js:598-605`）不可变更新草稿；`dirty` 用 `JSON.stringify` 比较（`client.js:607-610`）；`selectedProvider` 在目录里找条目，找不到即手填形态（`client.js:613-617`）。
  - `useEfforts`（`client.js:622-653`）：选中 provider/model 后二次拉取 `/api/codewiki/model-efforts`，普通档与大档各一份实例（`client.js:654-655`）。
  - `modelTrio`（`client.js:660-764`）：提供商/模型/思考程度三字段共用渲染与目录联动；换提供商时清空模型与旧档位（`client.js:677-684`）；大档额外给「（未启用）」空选项（`allowEmptyProvider`，`client.js:686`）。
  - `save()`（`client.js:766-805`）：前端校验 —— `maxConcurrency` 须 1–8 整数（`client.js:768-772`）；`bigConcurrency` 为 0 或 1–8 整数（`client.js:774-778`）；`agenticMaxSteps` 须 1–100 整数（`client.js:780-784`）；`planMode` 只接受白名单（`client.js:786-789`）。然后按 **25 个 key 的白名单**（`client.js:515`，与 Config 的 25 字段一一对应）逐个 `JSON.stringify` 比较，差异项生成 `{ op:'set', path:[key], value }`（`client.js:793-796`）；`form.mutate(ops, snapshot.revision)` 带 revision 提交（`client.js:799`），冲突提示 `conflict`（`client.js:800`）。
  - `discard()` 回滚草稿（`client.js:807-811`）。
  - 渲染分区五块 + 保存条：运行（`client.js:820-912`，含 enabled/updateReminder/autoCommit/workspaceOnly/maxConcurrency/bigConcurrency/serialProjects/parallelProjects/articleLanguage/binaryPath）；编译模型（`client.js:915-930`，batch 三字段 `client.js:919` + `sessionTier` 输入在 `client.js:920-928`）；大档模型（`client.js:932-947`，big 三字段 `client.js:936` + `bigTokenBudget` 输入在 `client.js:937-945`）；编译流程（`client.js:949-994`，planMode 下拉 `client.js:953-963`、agenticArticles 开关 `client.js:965-973`、agenticMaxSteps 输入 `client.js:974-983`、symbolIncremental 开关 `client.js:984-992`）；调度与排除（`client.js:996-1028`，autoUpdate 开关 `client.js:999-1007`、autoUpdateMin 输入 `client.js:1008-1016`、excludePaths 文本域 `client.js:1017-1025`）；保存条（`client.js:1030-1036`）。
- `ReposTab()`（`client.js:1184-1328`）：总览页按 `REPOS_POLL_MS` 轮询 `/api/codewiki/repos`（`client.js:31-35`），并就地编辑 `excludePaths` —— `toggleExclude` 从 `form.getSnapshot()` 取当前值（`client.js:1215-1222`）、归一化比较、增删该 cwd、`form.mutate` 写回（`client.js:1223`），成功后 `POST {action:'refresh'}` 让服务端总览缓存失效并立即重拉（`client.js:1234-1235`）；「更新」按钮走 `compile()`（`client.js:515-523`）。
- `CodewikiPanel()`（`client.js:1426-1686`）：侧边栏面板四页（overview/tasks/sessions/settings，Tab 条在 `client.js:550-557`），`settings` 页直接复用 `CodewikiCard`（`client.js:1656`）。

### `cordis.patch.yml` — 静态挂载

正文从 `- insert:`（`cordis.patch.yml:19`）开始：`id: codewiki`（`cordis.patch.yml:20`）、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`（`cordis.patch.yml:21`）、两行注释说明「默认值不在这里重复声明，想改哪项就填哪项」（`cordis.patch.yml:22-23`）、`config: {}`（`cordis.patch.yml:24`）、注释掉的示例配置（`cordis.patch.yml:25-33`）。头部注释段（`cordis.patch.yml:5-18`）列出 13 个设置项的说明（binaryPath/batchProvider/batchModel/batchReasoningEffort/maxConcurrency/bigConcurrency/serialProjects/articleLanguage/planMode/agenticArticles/agenticMaxSteps/symbolIncremental/updateReminder，见 `cordis.patch.yml:6-18`）——比 25 个字段少，其余字段（enabled、bigProvider、bigModel、bigReasoningEffort、bigTokenBudget、sessionTier、parallelProjects、autoCommit、excludePaths、autoUpdate、autoUpdateMin、workspaceOnly）未在此文档化。

两个要点：

1. **初值是空对象 `{}`**（`cordis.patch.yml:22`），故所有默认值必须由 `Config` 的 `.default()`（`index.js:102-128`）与 `liveConfig` 的回落（`index.js:102-144`）共同兜住。
2. **`id` 必须与客户端 `NS`/`KEY` 一致**（`cordis.patch.yml:20`、`client.js:18-19`），否则 `configForms.get(NS)` 拿不到命名空间、面板 id 也对不上。

## Architecture

```text
┌────────────────────────────────────────┐
│ cordis.patch.yml：id=codewiki，config={} │
└───────────────────┬────────────────────┘
                     ▼ cordis 挂载（file:/// → index.js）
┌────────────────────────────────┐     ┌───────────────────────────┐
│ index.js apply(ctx, config)    │◄───►│ 宿主 Config 服务          │
│ Config（25 字段 .volatile）    │读写 │ 命名空间 'codewiki'       │
│ liveConfig() 归一化 + 钳制     │     └────────────▲────────────┘
└──────┬────────────────┬────────┘                  │ getSnapshot / mutate(revision)
        │ 用前现场读     │ inject(['llm'])           │
        ▼                ▼                           ▼
┌──────────────┐ ┌────────────────┐     ┌───────────────────────────┐
│ 工具 execute │ │ Job Service    │     │ client.js CodewikiCard    │
│ enabled 守卫 │ │ 阶段执行器     │     │ 草稿/校验/25-key diff     │
│ submit 闸门  │ │ autoScan 节流  │     │ ReposTab toggleExclude    │
└──────────────┘ └───────┬────────┘     └───────────────────────────┘
                          ▼
      ┌───────────────────────────────────────┐
      │ /api/codewiki/* 端点（workspaceOnly 过滤）│
      └───────────────────────────────────────┘
```

注：`apply(ctx, config)` 位于 `index.js:4817-4881`，内部先注入 `agents`/`llm`（`index.js:4818-4819`），再 `createJobService(config, wakeCompileSession)`（`index.js:4820`）并 `service.start()`（`index.js:4821`），随后注册自动调度器（`index.js:4825-4859`）、四个工具（`generateDef`/`updateDef` 定义在 `index.js:4826-4827`，经 `ctx.inject(['tools'])` 注册于 `index.js:4862-4878`，注册清单在 `index.js:4865`：`cwToolDefinition`、`generateDef`、`updateDef`、`progressToolDefinition`）、Web 端点（`installWebServer` 调用于 `index.js:4879`，`compile` 入口接 `generateDef.execute`）与维护提醒（`installUpdateReminder` 调用于 `index.js:4880`）。`liveConfig` 定义于 `index.js:102-144`，`Config` 定义于 `index.js:70-96`。

## Data Flow

1. **挂载期**：cordis 读 `cordis.patch.yml` 加载 `index.js`，以 `config: {}`（`cordis.patch.yml:3`）调 `apply(ctx, config)`（`index.js:4817`）。`apply` 先 `inject(['agents'])` / `inject(['llm'])` 拿服务引用（`index.js:4818-4819`），然后 `createJobService(config, wakeCompileSession)` 并 `service.start()`（`index.js:4820-4821`）。此时没有任何配置字段落在磁盘上，`Config.default()` 与 `liveConfig` 的回落表达式共同决定初值。
2. **读配置**：任何需要配置的地方现场调 `liveConfig(config)`，从宿主 config 对象取当前值并钳制（`index.js:102-144`）。因为字段全部 `.volatile()`（`index.js:71-95`），不存在「旧快照」，改设置无需重启。
3. **用户改配置**：`CodewikiCard` 从 `form.getSnapshot()` 起稿（`client.js:553`），用户改草稿 → `save()` 前端校验 + 25 key 白名单 diff 出 ops（`client.js:766-796`）→ `form.mutate(ops, snapshot.revision)` 带 revision 提交（`client.js:799`），冲突时提示 `conflict`（`client.js:800`）。宿主写成功后 revision 变化，订阅回调 `pull()` 重拉快照覆盖草稿（`client.js:1214-1231`）。总览页的 `toggleExclude` 走同一条 mutate 链路改 `excludePaths`（`client.js:550-568`）。
4. **配置生效时刻**：下一次 `liveConfig` 调用即取到新值——「改并发上限/编译模型/思考档位」生效于下一个阶段执行器（`index.js:2630`、`index.js:339`）；「改排除清单」生效于下一次 `excludedItem` 判定（工具入口 `index.js:2730`/提交 `index.js:3792`/autoScan `index.js:3579`）；「改自动更新开关/间隔」生效于下一次 60s 心跳（`index.js:3346`，判定 `index.js:1876-1877`）；「改会话档位」生效于下一次派发/重发 steer（`index.js:1877` / `index.js:1881`）；「改模块划分」生效于下一次 `buildPlan`（`index.js:2069`）；「改 agentic 开关/步数」分别生效于下一个 articles 阶段（`index.js:2075`）与下一次 agentic run（`index.js:2692`）；「改符号级增量」生效于下一次 stale 判定（`index.js:3859-3862`）与快照写入（`index.js:3423`）；「改文章语言」生效于下一次提交的任务（`index.js:3792` → `job.language`，`svc.submit` 在 `index.js:3609` 落入 job）；「改 autoCommit」生效于下一次 `tickIndex` 收尾（`index.js:3458`）；「改 workspaceOnly」生效于下一次面板请求（`index.js:4346`，过滤在 `index.js:4379` 与 `index.js:4443`）；「改 updateReminder」在下一次系统提示组装即生效（`index.js:4795`）；「改大档三件套/预算」生效于下一次 `bigTier` 构造/大档标记（`index.js:1169-1176`、`index.js:3139-3146`、`index.js:3247-3254`、`index.js:3021-3032`）。例外：env 变量类配置（`JOBS_FILE`/`TICK_MS`/`SESSION_TASK_TIMEOUT_MS`/`ORPHAN_TAKEOVER_MS`/`REPOS_FILE`，`index.js:1876`、`index.js:1877`、`index.js:1881`、`index.js:2069`、`index.js:2075`）模块加载时读一次，改它们必须重启宿主。
5. **凭证解析**：`batchProvider`/`batchModel` 必须非空且 `llmRef.stream` 可用（`index.js:3649-3651`），凭证由宿主按该 provider 解析，插件只校验通道可用并写 `job.credentialSource`（`index.js:3657`）；**插件不保存也不传递任何密钥**，provider 配置错误或凭证失效时提交即报错。
6. **提醒注入**：systemPrompt section 的 `text` 回调每次组装时求值（`index.js:4795-4801`）—— 开关为 false 或无 `CodeWiki.md` 返回空，否则拼 `reminderText` 与 `commitHintText`（后者带 60 秒 TTL 缓存，命中 `index.js:4739`、回写 `index.js:4772`）。
7. **面板可见性**：`workspaceOnly`（默认开）经 `wsFilterPaths()`（`index.js:4343-4358`）决定 `/api/codewiki/jobs`（过滤在 `index.js:4379`）与 `/api/codewiki/repos`（`inWs` 在 `index.js:4443`）是否按宿主工作区清单过滤；宿主未注册任何工作区、`workspaceRegistry.list()` 抛错或开关关闭时返回 `null` = 不过滤（`index.js:4344-4357`）。

## Connections

- [[job-service]]：`liveConfig` 的并发/模型/思考档位直接喂给阶段执行器（`index.js:102-111`、`index.js:4831-4836`），`excludePaths` 与 `autoUpdate*` 驱动 `autoScan`（`index.js:3505-3515`），`parallelLimit`/`serialProjects` 决定项目闸门与排队文案（`index.js:3505`、`index.js:3662-3671`）。
- [[ui-settings]]：`CodewikiCard`（`client.js:550-1038`）与 `ReposTab.toggleExclude`（`client.js:1214-1232`）是配置的写侧。
- [[web-api-endpoints]]：`/api/codewiki/models`（`index.js:3682-3697`）为设置页级联下拉供数；`/api/codewiki/model-efforts`（`index.js:4568-4588`）暴露思考档位；`/api/codewiki/repos`（`index.js:4408-4497`）暴露 `excluded` 标记（`index.js:4451`）与调度器状态（`index.js:4481-4487`）；`/api/codewiki/control`（`index.js:4589-4620`）承载 `cancel`/`refresh`/`compile` 三个 action（`refresh` 供 `toggleExclude` 失效总览缓存）；`/api/codewiki/jobs`（`index.js:4368-4404`）按工作区过滤任务列表（`index.js:4379`）。
- [[session-reminder]]：`updateReminder` 开关与 `reminderText`/`commitHintText` 构成「收尾提醒 + 产物待提交」链路（`index.js:4739-4781`），`autoCommit` 的三态结论由 `autoCommitState`（`index.js:2271-2276`）在两条通道间共享。
- [[session-channel]]：`sessionTier`（`index.js:2821`）与 `buildSessionSteerText`（`index.js:2049-2067`）把「超预算文章转会话通道」时的档位钉死；`bigProvider` 留空（大档关闭）才会触达该通道（`index.js:1169-1176`）。
- [[pipeline-orchestration]]：`articleLanguage` 在工具入口落入任务（`index.js:3792`，`generateToolDefinition`）；`planMode` 决定规划路径（`index.js:2732`）；`agenticArticles`/`agenticMaxSteps` 决定文章通道与步数（`index.js:3017`、`index.js:2692`）；`symbolIncremental` 决定 stale 的组件级过滤与快照写入（`index.js:3862`、`index.js:2629`）；`batchReasoningEffort` 在 `startBatchChatRun`（`index.js:2639`）与 `startAgenticRun`（`index.js:2676`）里落成模型调用参数，`bigReasoningEffort` 进各处 `bigTier` 构造（`index.js:1173`、`index.js:3714`、`index.js:3251`）。

## Known Issues

- **前端校验与后端钳制是两套规则**：设置页拦 `maxConcurrency` 1–8 整数（`client.js:768-772`）、`bigConcurrency` 0/1–8（`client.js:774-778`）、`agenticMaxSteps` 1–100（`client.js:780-784`）、`planMode` 白名单（`client.js:786-789`），但越界值在 `liveConfig` 侧是**静默钳制**而非报错（`index.js:102-104`、`index.js:467-469`、`index.js:133-136`、`index.js:131`）；`bigTokenBudget` 前端完全无校验（`client.js:937-945` 只是无格式 Input），低于 110000 的值会被静默抬到 110k（`index.js:115`）。绕过 UI 直接改宿主配置不会得到任何报错，只会看到行为与填的值不同。思考档位是唯一有运行期兜底的例外：选了模型不支持的值由 `llmChat` 剥档重试（`index.js:481-485`）。
- **排除清单是字符串前缀比较**：`excludedItem`（`index.js:339-348`）只做 `path.normalize` + 小写 + 去尾斜杠 + 前缀匹配，不解析符号链接、不支持通配符；清单里写相对路径或带 `..` 的路径会静默不命中。注意 `isExcluded` 也被复用于工作区过滤（`index.js:4379`、`index.js:4443`），语义在那里是「位于某工作区之下」，两处共用同一个前缀判定。
- **无配置 schema 迁移路径**：`Config`（`index.js:70-96`）没有版本号字段，旧宿主配置里已废弃的键不会被清理也不会报错，只会在 `liveConfig` 里被静默忽略（`index.js:102-144`）。
- **`snapshot.revision` 冲突只提示不重试**：`save()` 拿到 `accepted === false` 时仅设置 `conflict` 提示（`client.js:800`），需用户手动再点保存；草稿也不会被自动合并。
- **无本地密钥兜底**：插件不保存任何密钥，凭证完全依赖宿主 llm 服务按 `batchProvider` 解析。若 provider 在模型设置里被删或凭证失效，提交任务会立即报错（`index.js:3649-3651`），而非降级到其他通道。
- **yml 注释只文档化了部分设置项**：`cordis.patch.yml:5-18` 缺 enabled/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget/sessionTier/parallelProjects/autoCommit/excludePaths/autoUpdate/autoUpdateMin/workspaceOnly 的说明；权威来源是 Config schema 的 `.description`（`index.js:71-95`）与设置页 hint（`client.js:35-386`）。
- **两类配置的热生效边界不一致**：`Config` 声明的 25 个字段全部 `.volatile()` 热生效，但 `JOBS_FILE`/`TICK_MS`/`SESSION_TASK_TIMEOUT_MS`/`ORPHAN_TAKEOVER_MS`/`REPOS_FILE` 走环境变量且只在模块加载时求值一次（`index.js:1876`、`index.js:1877`、`index.js:1881`、`index.js:2069`、`index.js:2075`），改它们必须重启宿主——文档与 UI 的「无需重启」承诺不覆盖这部分。
