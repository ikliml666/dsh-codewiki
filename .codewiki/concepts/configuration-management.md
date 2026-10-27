---
title: configuration-management
type: concept
source_files:
  - index.js
  - client.js
  - cordis.patch.yml
tags: [configuration, settings, plugin-system, configForms, patch]
---

## Overview

`configuration-management` 是 dsh-codewiki 里「配置值如何被声明、归一化、校验、持久化、热读取」的横切概念。它横跨三个文件：

- `cordis.patch.yml` —— 静态挂载元数据：插件挂载 id `codewiki` 与初值 `config: {}`（`- insert:` 在 `cordis.patch.yml:3`，`id: codewiki` 在 `cordis.patch.yml:20`，`name:` 指向 `index.js` 的 `file:///` 直挂路径在 `cordis.patch.yml:21`，`config: {}` 在 `cordis.patch.yml:3`；头部注释段 `cordis.patch.yml:1-18` 只文档化了 25 个设置项中的 13 个，见 `cordis.patch.yml:3-14`）。
- `index.js` —— 配置 schema（`Config`，`index.js:60-86`，25 个字段）、取值兼容层（`val`，`index.js:88-90`）、唯一归一化入口（`liveConfig`，`index.js:92-134`），以及散布在各条边界上的消费点（工具 execute、提交闸门、阶段执行器、Web 端点、自动更新调度器、systemPrompt 提醒）。另有少量**进程级配置走环境变量**，模块加载时读一次、不热生效（见下）。
- `client.js` —— 浏览器侧设置表单（`CodewikiCard`，`client.js:6-493`），经宿主 `configForms` 服务的命名空间 `codewiki`（`NS` 声明在 `client.js:1`，`form = ctx.configForms.get(NS)` 在 `client.js:790`）读写同一份配置；总览页还能就地改写 `excludePaths`（`toggleExclude`，`client.js:1207-1225`）。

核心设计取向：**插件没有自己的配置文件**。配置的权威副本在宿主的 Config 服务里，插件侧只声明 schema、并在每次使用时现场调一次 `liveConfig(config)`。因此不存在「改了设置要重启」的问题 —— 这条承诺写在客户端词典的 `intro` 文案里（zh 版 `client.js:38`「此处设置经 configForms 热生效，无需重启」，en 版 `client.js:38` 'Settings here apply hot via configForms — no restart needed'）。

一致性的另一条主线：**全部字段都带 `.volatile()`**（`Config` 声明里每个字段链尾都是 `.volatile()`，`index.js:92-117`），即配置不落持久化快照、读取永远取当前值。这也是 `liveConfig` 可以在各条边界反复调用的前提。

第三个取向是**默认值双保险**：`cordis.patch.yml` 的初值是空对象 `{}`（`cordis.patch.yml:3`），所以所有默认值必须由 `Config` 的 `.default()`（`index.js:92-117`）与 `liveConfig` 的回落表达式（`index.js:92-127`）共同兜住；两处任一缺失都会让字段变成 `undefined` 并向下游传播。

id 对齐关系：cordis 挂载 id 是 `codewiki`（`cordis.patch.yml:20`），插件名是 `dsh-codewiki`（`PLUGIN_NAME` 在 `index.js:27`，`export const name` 在 `index.js:27`）；客户端模块 id 是 `@local/dsh-codewiki`（`client.js:18`），`NS` 与 `KEY` 都必须是 `codewiki`（`client.js:1`、`client.js:1`）。

## Key Components

## Architecture

## Data Flow

## Connections

## Known Issues

## Key Components

### `index.js` — schema 与归一化

**相关常量**

| 常量 | 位置 | 用途 |
| --- | --- | --- |
| `PLUGIN_NAME` / `export const name` | `index.js:27-28` | 插件名 `dsh-codewiki`（package 对齐） |
| `CW_SUBCOMMANDS` | `index.js:29` | cw 子命令白名单，在 cw 工具入口做门禁（`index.js:29-30`） |
| `CONCURRENCY_HARD_CAP` | `index.js:71` | 值 `8`；`maxConcurrency`/`bigConcurrency` 的运行期硬顶 |
| `DEFAULT_CONCURRENCY` | `index.js:33` | 值 `2`；默认档并发默认值（hy3 免费档） |
| `DEFAULT_BATCH_PROVIDER` | `index.js:35` | 值 `'workbuddy'`；编译模型提供商默认值 |
| `DEFAULT_BATCH_MODEL` | `index.js:36` | 值 `'hy3'`；编译模型默认值 |
| `DEFAULT_BIG_PROVIDER` | `index.js:39` | 值 `'volces-ark'`；大档模型提供商默认值 |
| `DEFAULT_BIG_MODEL` | `index.js:40` | 值 `'glm-5.3-flash'`；大档模型默认值 |
| `DEFAULT_BIG_TOKEN_BUDGET` | `index.js:42` | 值 `420000`；大档单请求输入预算默认值 |
| `WIKI_PATHS` | `index.js:45` | `['.codewiki', 'CodeWiki.md']`；autoCommit 的固定 pathspec（`autoCommitWiki` 里 `paths` 过滤在 `index.js:3913`、`git add -- ...paths` 在 `index.js:3913`） |
| `BATCH_TOKEN_BUDGET` | `index.js:581` | 值 `110000`；普通档单请求输入预算，同时是 `bigTokenBudget` 的下限 |
| `BATCH_TOKEN_HARD_LIMIT` | `index.js:586` | 值 `128000`；超预算兜底装填上限 |

**进程级环境变量配置**（模块加载时读一次、不热生效）：`JOBS_FILE`（`index.js:1371`，env `DSH_CODEWIKI_JOBS_FILE`，默认 `%TEMP%/dsh-codewiki-jobs.json`）、`TICK_MS`（`index.js:1373`，env `DSH_CODEWIKI_TICK_MS`，下限 250ms 默认 10s）、`SESSION_TASK_TIMEOUT_MS`（`index.js:1377`，env `DSH_CODEWIKI_SESSION_TIMEOUT_MS`，下限 5 分钟默认 30 分钟）、`ORPHAN_TAKEOVER_MS`（`index.js:1373`，env `DSH_CODEWIKI_ORPHAN_TAKEOVER_MS`，下限 60s 默认 5 分钟）、`REPOS_FILE`（`index.js:1373`，env `DSH_CODEWIKI_REPOS_FILE`）。派生路径/常量：`SESSION_TASK_DIR`（`index.js:1389`）、`SESSION_TTL_MS`（`index.js:1390`，24h）、`SESSIONS_DIR`（`index.js:1391`）、`SESSION_FLUSH_MS`（`index.js:370`，3s）、`WORKTREE_CACHE_TTL_MS`（`index.js:390`，60s）、`SOURCE_PROBE_TTL_MS`（`index.js:1567`，10 分钟）、`MAX_JOBS_KEPT`（`index.js:1567`，30）。

**`Config`（`index.js:60-86`）** —— 用 schemastery（`z`）声明的插件配置 schema，**25 个字段**，全部 `.volatile()`：

| 字段 | 行号 | 类型 / 默认值 | 说明（压缩自 `.description`） |
| --- | --- | --- | --- |
| `enabled` | `index.js:61` | boolean，`true` | 停用后两个工具立即报错 |
| `binaryPath` | `index.js:62` | string，`''` | cw 可执行文件路径；留空优先 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | `index.js:63` | string，`'workbuddy'` | 编译模型提供商（模型设置里已注册的 provider id）；留空将无法提交任务 |
| `batchModel` | `index.js:63` | string，`'hy3'` | 编译模型（全部模型环节共用） |
| `batchReasoningEffort` | `index.js:65` | string，`''` | 思考程度档位 id；留空=模型默认档，可选值由模型目录实时读取（`/api/codewiki/model-efforts`） |
| `bigProvider` | `index.js:66` | string，`'volces-ark'` | 大档模型提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | `index.js:67` | string，`'glm-5.3-flash'` | 大档模型 id（默认 512k 上下文） |
| `bigReasoningEffort` | `index.js:68` | string，`''` | 大档模型思考程度；留空=模型默认档 |
| `bigTokenBudget` | `index.js:69` | number，`420000` | 大档单请求输入预算（token）；超 110k 普通预算的请求改用大档 |
| `sessionTier` | `index.js:70` | string，`''` | 会话通道档位 id（仅当大档都装不下且 bigProvider 留空时兜底）；留空=自动选路 |
| `maxConcurrency` | `index.js:71` | number，`2` | 默认档并发上限（1–8），硬顶 8 |
| `bigConcurrency` | `index.js:95` | number，`0` | 大档并发上限（1–8）：留空或 0 = 跟随默认档，两档独立限流 |
| `serialProjects` | `index.js:61` | boolean，`true` | 单项目串行，其余仓库排队（queued） |
| `parallelProjects` | `index.js:73` | number，`2` | 并行仓库上限（1–4），关串行后生效 |
| `articleLanguage` | `index.js:75` | string，`'中文'` | wiki 文章书写语言 |
| `planMode` | `index.js:76` | string，`'auto'` | 模块划分：auto=AST 符号 + LLM 语义聚类（失败降级目录分组）；dirs=顶层目录分组 |
| `agenticArticles` | `index.js:61` | boolean，`true` | 文章走 agentic 工具循环（read_code/list_files/edit_article）；关闭走单轮整包装填旧通道 |
| `agenticMaxSteps` | `index.js:78` | number，`30` | agentic 单篇最大步数（硬顶 100） |
| `symbolIncremental` | `index.js:61` | boolean，`true` | stale 增量按 AST 符号级判定；关闭按文件级 mtime/hash |
| `updateReminder` | `index.js:61` | boolean，`true` | 会话系统提示注入维护提醒（仅当仓库根存在 CodeWiki.md） |
| `autoCommit` | `index.js:61` | boolean，`true` | 编译完成后插件在主题分支提交产物再合并回原分支；失败降级为提醒 |
| `excludePaths` | `index.js:82` | string，`''` | 排除清单：换行/分号/逗号分隔绝对路径 |
| `autoUpdate` | `index.js:83` | boolean，`false` | 自动更新调度（定时扫描 + 增量编译） |
| `autoUpdateMin` | `index.js:84` | number，`30` | 扫描间隔（分钟），最小 5 |
| `workspaceOnly` | `index.js:61` | boolean，`true` | 任务页只显示宿主已添加工作区的任务 |

**`val(x)`（`index.js:88-90`）** —— 取配置值的兼容层。宿主传进来的 config 可能是 schemastery 包装（带 `.get()`），也可能就是普通对象：

```js
function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}
```

所有字段读取都经它，因此下游代码不必关心 config 形态。注意 `installUpdateReminder` 的提醒回调直接用 `val(config?.updateReminder)` 读原始 config（`index.js:92`），没有走 `liveConfig`。

**`liveConfig(config)`（`index.js:92-134`）** —— **唯一的配置归一化入口**。逐字段 `val()` 后做类型强制与钳制，返回普通对象（含派生字段 `parallelLimit`）：

- `const c = config ?? {}`（`index.js:94`），`concurrency`/`bigConcurrency` 先转 Number（`index.js:95-96`）。
- `enabled: val(c.enabled) ?? true`（`index.js:97`）—— 缺省视为开启。
- `batchModel` 空串回落 `'hy3'`（`index.js:67`）；`bigModel` 空串回落 `'glm-5.3-flash'`（`index.js:67`）。
- `bigTokenBudget`：`Math.max(BATCH_TOKEN_BUDGET, Number(val(c.bigTokenBudget)) || DEFAULT_BIG_TOKEN_BUDGET)`（`index.js:105`）—— 下限为普通预算 110k，非法值回落 420000。
- `maxConcurrency` 双重钳制（`index.js:71-73`）：非有限数或 `< 1` 回落默认 `2`，否则 `Math.min(concurrency, CONCURRENCY_HARD_CAP)`。**schema 的 `.default()` 不构成约束，真正的上限只在这里。**
- `bigConcurrency`（`index.js:95-97`）：非有限数或 `< 1` 回落 `0`（跟随默认档，`index.js:95` 注释），否则钳到 8。
- `serialProjects: val(c.serialProjects) !== false`（`index.js:114`）—— 缺省视为开启。
- `parallelLimit`（`index.js:73-77`）：`serialProjects` 非 false 恒返回 `1`；否则 `parallelProjects` 四舍五入钳到 1–4，非法值回落 `2`。
- `articleLanguage` 空串回落 `'中文'`（`index.js:75`）。
- `planMode`（`index.js:76`）：白名单 `['auto', 'dirs']`，之外的值回落 `'auto'`。
- `agenticArticles: val(c.agenticArticles) !== false`（`index.js:78`）；`agenticMaxSteps`（`index.js:78-81`）钳到 1–100、默认 30；`symbolIncremental: val(c.symbolIncremental) !== false`（`index.js:78`）。
- `excludePaths` 原样透出字符串不做切分（`index.js:128`；切分在各消费点做，见下）。
- `autoUpdate: val(c.autoUpdate) === true`（`index.js:81`）—— 缺省视为**关闭**（与 `autoCommit`/`enabled` 的 `!== false` 语义相反）。
- `autoUpdateMin: Math.max(5, Number(val(c.autoUpdateMin)) || 30)`（`index.js:130`）。
- `autoCommit: val(c.autoCommit) !== false`（`index.js:131`）、`workspaceOnly: val(c.workspaceOnly) !== false`（`index.js:132`）—— 缺省视为开启。

**字段级消费者（独立函数）**

- `resolveBinary(cfg)`（`index.js:62-82`）：`binaryPath` 的消费点。显式值优先（`index.js:62`）；否则 win32 用 `where cw`（`index.js:62-63`）、POSIX 用 `which cw`（`index.js:62-63`）探测 PATH；再回落插件自带 `bin/cw(.exe)`（`index.js:62`）；最后是裸 `'cw'`（`index.js:62`）。PATH 优先的理由写在注释里（`index.js:62-63`）：避免捆绑二进制落后于 codewiki 源码，出现「bash 原生正常、包装层 No wiki found」的分叉。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`（`index.js:790-799` / `index.js:790-792`）：`excludePaths` 的消费点。分隔符 `/[\n;，,]+/`（`index.js:327`），兼容换行、分号、中英文逗号；比较时 `path.normalize` + 小写 + 剥尾斜杠，`cwd` 等于某项或位于其子树内即命中（`index.js:324-328`）。`excludedItem` 返回命中的排除项**原文**（工具报错据此告诉模型是哪条排除项拒绝了此工作区，`index.js:334-336` 注释），`isExcluded` 是布尔包装。
- `listModelCatalog(llm)`（`index.js:3517-3538`）：设置页「编译模型」级联下拉的数据源。遍历 `llm.listProviders()` 并对每个 provider 调 `listModels(id)`（`index.js:3514-3526`）；单个 provider 抛错只给该条目附 `error` 并保留空 `models`，不影响其它 provider；`llm` 未注入或无 `listProviders` 时整体 `ok:false`（`index.js:3513-3515`），设置页降级为手填。
- `resolveModelInfoOf(llm)`（`index.js:3539-3544`）：适配宿主的 `resolveModelInfo`，旧版 `resolveModel` 兜底（背景见 `index.js:3540-3543` 注释）。
- `resolveModelEfforts(llm, provider, model)`（`index.js:3551-3573`）：思考程度档位数据源，取 `reasoning.efforts` 与 `defaultEffort`（`index.js:3571-3580`），另带 `context`（`index.js:3539`）；llm 缺 `resolveModelInfo` 或探测失败都返回 `ok:false`，设置页降级为默认档或通用档位。选了模型不支持的档位由 `llmChat` 兜底：`UNSUPPORTED_REASONING_EFFORT` 时剥掉 effort 用模型默认档重试一次（`index.js:467-470`），不让整篇编译失败。
- `commitHintText(cwd, jobs)`（`index.js:80-111`）：`updateReminder` 链路的「产物待提交」段。只在最近一次成功编译的产物「插件自动提交未成功」时提醒（`autoCommitState(latest) === 'pending'`，`index.js:3888`），并比对 `git log` 时间戳与任务完成时间（`index.js:3888-3893`），带 60 秒 TTL 缓存（`commitHintCache` 声明在 `index.js:3888`，命中判定 `index.js:3888-3889`，回写 `index.js:3888`）。
- `reminderText(cwd)`（`index.js:4-13`）：维护提醒正文（收尾必须跑 `codewiki_generate`、不要手工改 `.codewiki/`、不要轮询等）。
- `installUpdateReminder(ctx, config)`（`index.js:4034`）：把提醒注册成 systemPrompt section `codewiki:update-reminder`（`index.js:680`），`order` 排在 `TOOL_REPORT` 之后（`index.js:646`）。`text` 是回调，每次组装系统提示都重新求值（`index.js:80-86`）：`updateReminder` 为 `false` 返回空串（`index.js:83`）；会话 cwd 下没有 `CodeWiki.md` 返回空串（`index.js:4023`，判定不看 `.codewiki/` 目录，理由见 `index.js:4023-4026` 注释）；否则返回 `reminderText(cwd)` 并按需拼上 `commitHintText`（`index.js:3990-3991`）。

### `index.js` — 配置消费点（读取边界）

配置不集中在一处读，而是在**每条边界现场调一次 `liveConfig`**：

- 工具 execute 的 `enabled` 门禁：`cwToolDefinition`（`liveConfig` 在 `index.js:92`、抛错在 `index.js:3077`）；`generateToolDefinition`（`liveConfig` 在 `index.js:92`、抛错在 `index.js:92`，同函数里排除清单判定在 `index.js:3370-3371`、文章语言解析在 `index.js:3370`）；`progressToolDefinition`（`liveConfig` 在 `index.js:92`、抛错在 `index.js:3299`）；`updateToolDefinition` 复用 `generateDef.execute({ ...args, scope: 'auto' }, exec)`（`index.js:3341`）并只替换错误文案里的工具名（`index.js:3341`），因此继承同一道门禁。
- 提交闸门 `submit()`（`index.js:324-409`）：先 `excludedItem` 拦排除目录（`index.js:324-327`，错误文案带命中的排除项与编辑指引）；worktree 闸门（`index.js:63-68`）与空壳目录闸门（`index.js:63-67`）跟配置无关但共用同一入口；再校验编译模型三元组——`batchProvider` 非空（`index.js:63`）、`batchModel` 非空（`index.js:3014`）、`llmRef.stream` 可用（`index.js:1903`），失败即 `fail` 并抛错；解析结果写进 `job.credentialSource = llm(provider/model)`（`index.js:3026`）。项目闸门读 `c1.parallelLimit` 与 `c1.serialProjects`（`index.js:3032-3041`），排队文案区分「单项目串行 / 并行上限 N」（`index.js:3032`）。
- 阶段执行器：`startBatchChatRun`（`index.js:92-134`）每次取 `liveConfig(config)`（`index.js:92`）决定 provider/model/reasoningEffort/maxConcurrency/bigConcurrency（`index.js:2110-2115`）；`startAgenticRun`（`index.js:2110-2157`）同样取值（`index.js:2110`、`index.js:2186-2190`）并传 `maxSteps: c.agenticMaxSteps`（`index.js:2186`）。`submitBatchFor` 在提交时按 `liveConfig` 统计大档请求数（`tier2`，`index.js:2189`）与并发/模型文案（`index.js:2189-2197`）。
- 规划：`buildPlan` 按 `c.planMode === 'dirs'` 走目录分组（`index.js:2161-2164`），否则语义聚类并把 `batchProvider/batchModel/batchReasoningEffort` 传给 `semanticPlan`（`index.js:963-970`）。
- 文章阶段：`tickArticles` 按 `c0.agenticArticles` 决定走 agentic 通道（`index.js:2445`）还是装填通道，装填时把 `bigProvider/bigModel/bigReasoningEffort/bigTokenBudget` 传给 `prepareArticleTasks`（`index.js:810-814`）。大档档位对象（`bigTier`）在文章装填（`index.js:810-817`）、横切（`index.js:66-73`）与校对（`index.js:66-73`）各构造一次，统一以 `bigProvider` 非空为启用条件、`bigTokenBudget` 为预算下限钳制；agentic 通道则通过 `markBigAgenticTasks` 按 `sourceTokensOf` 给超大模块打大档标记（`index.js:23-34`）。
- 收尾：`tickIndex` 按 `liveConfig(config).symbolIncremental` 决定是否写符号快照（`index.js:3946`）与 `liveConfig(config).autoCommit` 决定是否进 `commit` 阶段（`index.js:3946`）。
- 会话通道档位：`sessionTier` 在派发 steer 时读取（`index.js:70`）与宿主重启重发时读取（`index.js:1546`），交给纯函数 `buildSessionSteerText({ job, snapshots, tier, resend })`（`index.js:1546-1564`）；非空时文本里插入「必须显式传 tier」的要求行（`index.js:1546-1547`）。
- 调度节拍：`tick()` 读 `liveConfig(config).parallelLimit` 做项目闸门（`index.js:2870`）。
- Web 端点：`installWebServer`（`index.js:3594-3889`）。`wsFilterPaths()`（`index.js:85-100`）读 `workspaceOnly`（`index.js:85`）决定是否按宿主工作区过滤；`/api/codewiki/jobs`（注册于 `index.js:334-370`）用 `isExcluded(j.cwd, wsPaths)` 过滤终态任务（`index.js:334`）；`/api/codewiki/repos`（`index.js:128-217`）读 `c.excludePaths` 组装每个仓库的 `excluded` 标记（`index.js:323`）与调度器状态（`enabled/intervalMin/lastScan` 等取自 `c.autoUpdate`/`c.autoUpdateMin` 与 `schedState`，`index.js:4080-4088`）；`/api/codewiki/models`（`index.js:4080-4095`）与 `/api/codewiki/model-efforts`（`index.js:4080-4100`）为设置页供数。
- 自动更新调度器 `autoScan()`（`index.js:83-110`）：读 `autoUpdate`（`index.js:84`）、`autoUpdateMin`（`index.js:790`）、`excludePaths`（`index.js:790`）。60 秒心跳（`index.js:790`）但内部按 `autoUpdateMin * 60000` 节流（`index.js:790`）；对 job 历史工作区去重后逐个跳过被排除项（`index.js:3341`）、worktree（`index.js:3341`）、空壳目录（`index.js:3341`），其余调 `generateDef.execute({ cwd, scope: 'auto', auto: true }, {})`（`index.js:4105`），单仓库失败只记 `schedState.lastError`（`index.js:4105`）。
- stale 符号级增量：generate execute 里 `cInf.symbolIncremental` 决定是否做组件级过滤（`const cInf = liveConfig(cfg)` 在 `index.js:3219`，判定在 `index.js:3219-3238`）。

### `client.js` — 设置表单

- 命名空间常量：`NS = 'codewiki'`（`client.js:6`）、`KEY = 'codewiki'`（`client.js:6`）。`NS` 同时是 `configForms` 命名空间与 `plugins.item` 注册 id；`KEY` 是 `main` 面板与 `sidebar.panellist` 的共同 id。
- 端点与节奏常量：`JOBS_PATH`/`CONTROL_PATH`（`client.js:20-21`）、`PANEL_ORDER = 52`（`client.js:23`）、`POLL_MS = 2000`（`client.js:23`）、`REPOS_PATH`（`client.js:24`）、`SESSIONS_PATH`/`SESSIONS_ITEM_PATH`（`client.js:26-27`）、`MODELS_PATH`/`EFFORTS_PATH`（`client.js:27-28`）、`GENERIC_EFFORTS = ['off','low','medium','high','xhigh','max']`（`client.js:33`）、`REPOS_POLL_MS = 10000`（`client.js:33`）、`ACTIVE_STAGES`（`client.js:33`，queued→commit 七个活动阶段）。
- 词典：`zh()`（`client.js:35-209`）/ `en()`（`client.js:210-384`）覆盖全部配置项的 label 与 hint。
- 挂载与门控：`inject: ['slots', 'locale', 'configForms']`（`client.js:524`）、`form = ctx.configForms.get(NS)`（`client.js:524`）；设置卡片经 `ctx.configForms.whileServed([NS], mount)` 只在宿主服务该命名空间时出现（`client.js:516-520`，无该 API 时直接 `mount()`）；侧边栏面板挂载在 `client.js:4-15`（`main` + `sidebar.panellist`）。
- `CodewikiCard(props)`（`client.js:548-1036`）：设置 UI 主体。
  - state：`snapshot`/`draft`/`notice`/`error`/`catalog`/`catalogError`（`client.js:489-496`）；模型目录经 `apiGet(MODELS_PATH)` 拉取（`client.js:489-500`），`ok === false` 或请求失败时置 `catalogError` 退回手填形态（`apiGet`/`apiPost` 在 `client.js:495-510`）。
  - 快照订阅：`pull()` 按 `snap.revision` 变化才用 `structuredClone` 覆盖草稿，`form.subscribe(pull)` 清理时释放（`client.js:589-606`）；summary 视图一行简介（`client.js:589`）。
  - `setPath`（`client.js:605-612`）不可变更新草稿；`dirty` 用 `JSON.stringify` 比较（`client.js:611-614`）；`selectedProvider` 在目录里找条目，找不到即手填形态（`client.js:611-615`）。
  - `useEfforts`（`client.js:620-651`）：选中 provider/model 后二次拉取 `/api/codewiki/model-efforts`，普通档与大档各一份实例（`client.js:620-621`）。
  - `modelTrio`（`client.js:658-762`）：提供商/模型/思考程度三字段共用渲染与目录联动；换提供商时清空模型与旧档位（`client.js:658-664`）；大档额外给「（未启用）」空选项（`allowEmptyProvider`，`client.js:657`）。
  - `save()`（`client.js:764-803`）：前端校验 —— `maxConcurrency` 须 1–8 整数（`client.js:95-99`）；`bigConcurrency` 为 0 或 1–8 整数（`client.js:78-82`）；`agenticMaxSteps` 须 1–100 整数（`client.js:76-80`）；`planMode` 只接受白名单（`client.js:76-79`）。然后按 **25 个 key 的白名单**（`client.js:499`，与 Config 的 25 字段一一对应）逐个 `JSON.stringify` 比较，差异项生成 `{ op:'set', path:[key], value }`（`client.js:797-799`）；`form.mutate(ops, snapshot.revision)` 带 revision 提交（`client.js:121`），冲突提示 `conflict`（`client.js:121`）。
  - `discard()` 回滚草稿（`client.js:805-809`）。
  - 渲染分区五块 + 保存条：运行（`client.js:70-164`，含 enabled/updateReminder/autoCommit/workspaceOnly/maxConcurrency/bigConcurrency/serialProjects/parallelProjects/articleLanguage/binaryPath）；编译模型（`client.js:70-86`，batch 三字段 `client.js:70` + `sessionTier` 输入在 `client.js:70-78`）；大档模型（`client.js:69-85`，big 三字段 `client.js:69` + `bigTokenBudget` 输入在 `client.js:69-77`）；编译流程（`client.js:69-115`，planMode 下拉 `client.js:69-80`、agenticArticles 开关 `client.js:69-77`、agenticMaxSteps 输入 `client.js:69-78`、symbolIncremental 开关 `client.js:69-78`）；调度与排除（`client.js:69-102`，autoUpdate 开关 `client.js:69-77`、autoUpdateMin 输入 `client.js:69-77`、excludePaths 文本域 `client.js:69-78`）；保存条（`client.js:69-76`）。
- `ReposTab()`（`client.js:31-174`）：总览页按 `REPOS_POLL_MS` 轮询 `/api/codewiki/repos`（`client.js:790-806`），并就地编辑 `excludePaths` —— `toggleExclude` 从 `form.getSnapshot()` 取当前值（`client.js:797-798`）、归一化比较、增删该 cwd、`form.mutate` 写回（`client.js:797`），成功后 `POST {action:'refresh'}` 让服务端总览缓存失效并立即重拉（`client.js:1227`）；「更新」按钮走 `compile()`（`client.js:1227-1235`）。
- `CodewikiPanel()`（`client.js:1418-1663`）：侧边栏面板四页（overview/tasks/sessions/settings，Tab 条在 `client.js:146-153`），`settings` 页直接复用 `CodewikiCard`（`client.js:548`）。

### `cordis.patch.yml` — 静态挂载

正文从 `- insert:`（`cordis.patch.yml:19`）开始：`id: codewiki`（`cordis.patch.yml:20`）、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`（`cordis.patch.yml:21`）、两行注释说明「默认值不在这里重复声明，想改哪项就填哪项」（`cordis.patch.yml:22-23`）、`config: {}`（`cordis.patch.yml:24`）、注释掉的示例配置（`cordis.patch.yml:25-32`）。头部注释段（`cordis.patch.yml:1-18`）列出 13 个设置项的说明（binaryPath/batchProvider/batchModel/batchReasoningEffort/maxConcurrency/bigConcurrency/serialProjects/articleLanguage/planMode/agenticArticles/agenticMaxSteps/symbolIncremental/updateReminder，`cordis.patch.yml:6-17`）——是 25 个字段的子集，其余字段（enabled、bigProvider、bigModel、bigReasoningEffort、bigTokenBudget、sessionTier、parallelProjects、autoCommit、excludePaths、autoUpdate、autoUpdateMin、workspaceOnly）未在此文档化。

两个要点：

1. **初值是空对象 `{}`**（`cordis.patch.yml:22`），故所有默认值必须由 `Config` 的 `.default()`（`index.js:92-117`）与 `liveConfig` 的回落（`index.js:92-134`）共同兜住。
2. **`id` 必须与客户端 `NS`/`KEY` 一致**（`cordis.patch.yml:20`、`client.js:18`），否则 `configForms.get(NS)` 拿不到命名空间、面板 id 也对不上。

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

注：`apply(ctx, config)` 位于 `index.js:4060-4124`，内部先注入 `agents`/`llm`（`index.js:1774-1775`），再 `createJobService`（`index.js:4072`）并 `service.start()`（`index.js:4072`），随后注册自动调度器（`index.js:4072-4099`）、四个工具（`index.js:1240-1256`，注册清单在 `index.js:1240`：`cwToolDefinition`、`generateDef`、`updateDef`、`progressToolDefinition`）、Web 端点（`installWebServer` 调用于 `index.js:1227`，`compile` 入口接 `generateDef.execute`）与维护提醒（`installUpdateReminder` 调用于 `index.js:92`）。`liveConfig` 定义于 `index.js:92`。

## Data Flow

1. **挂载期**：cordis 读 `cordis.patch.yml` 加载 `index.js`，以 `config: {}`（`cordis.patch.yml:3`）调 `apply(ctx, config)`（`index.js:4068`）。`apply` 先 `inject(['agents'])` / `inject(['llm'])` 拿服务引用（`index.js:1774-1775`），然后 `createJobService(config, wakeCompileSession)` 并 `service.start()`（`index.js:4072-4073`）。此时没有任何配置字段落在磁盘上，`Config.default()` 与 `liveConfig` 的回落表达式共同决定初值。
2. **读配置**：任何需要配置的地方现场调 `liveConfig(config)`，从宿主 config 对象取当前值并钳制（`index.js:92-134`）。因为字段全部 `.volatile()`（`index.js:92-117`），不存在「旧快照」，改设置无需重启。
3. **用户改配置**：`CodewikiCard` 从 `form.getSnapshot()` 起稿（`client.js:764`），用户改草稿 → `save()` 前端校验 + 25 key 白名单 diff 出 ops（`client.js:797-827`）→ `form.mutate(ops, snapshot.revision)` 带 revision 提交（`client.js:121`），冲突时提示 `conflict`（`client.js:121`）。宿主写成功后 revision 变化，订阅回调 `pull()` 重拉快照覆盖草稿（`client.js:1207-1224`）。总览页的 `toggleExclude` 走同一条 mutate 链路改 `excludePaths`（`client.js:1216-1234`）。
4. **配置生效时刻**：下一次 `liveConfig` 调用即取到新值——「改并发上限/编译模型/思考档位」生效于下一个阶段执行器（`index.js:92`、`index.js:324` / `index.js:324`、`index.js:324`）；「改排除清单」生效于下一次 `excludedItem` 判定（工具入口 `index.js:324-325`、submit `index.js:324-327`、autoScan `index.js:324`）；「改自动更新开关/间隔」生效于下一次 60s 心跳（`index.js:2161`，节流判定 `index.js:2161`）；「改会话档位」生效于下一次派发/重发 steer（`index.js:2161` / `index.js:2161`）；「改模块划分」生效于下一次 `buildPlan`（`index.js:2161`）；「改 agentic 开关/步数」分别生效于下一个 articles 阶段（`index.js:2161`）与下一次 agentic run（`index.js:2161`）；「改符号级增量」生效于下一次 stale 判定（`index.js:2124-2144`）与快照写入（`index.js:2124`）；「改文章语言」生效于下一次提交的任务（`index.js:2124` → `index.js:2124` 的 `job.language`）；「改 autoCommit」生效于下一次 `tickIndex` 收尾（`index.js:2774`）；「改 workspaceOnly」生效于下一次面板请求（`index.js:2774`，过滤在 `index.js:2774` 与 `index.js:810`）；「改 updateReminder」在下一次系统提示组装即生效（`index.js:810`）；「改大档三件套/预算」生效于下一次 `bigTier` 构造/大档标记（`index.js:810-817`、`index.js:810`、`index.js:1373-1380`、`index.js:1373-1380`）。例外：env 变量类配置（`JOBS_FILE`/`TICK_MS`/`SESSION_TASK_TIMEOUT_MS`/`ORPHAN_TAKEOVER_MS`/`REPOS_FILE`，`index.js:1572`、`index.js:1572`、`index.js:1572`、`index.js:1572`、`index.js:1572`）模块加载时读一次，改它们必须重启宿主。
5. **凭证解析**：`batchProvider`/`batchModel` 必须非空且 `llmRef.stream` 可用（`index.js:3014-3016`），凭证由宿主按该 provider 解析，插件只校验通道可用并写 `job.credentialSource`（`index.js:3020`）；**插件不保存也不传递任何密钥**，provider 配置错误或凭证失效时提交即报错。
6. **提醒注入**：systemPrompt section 的 `text` 回调每次组装时求值（`index.js:646-652`）—— 开关为 false 或无 `CodeWiki.md` 返回空，否则拼 `reminderText` 与 `commitHintText`（后者带 60 秒 TTL 缓存，命中 `index.js:3990-3991`、回写 `index.js:3990`）。
7. **面板可见性**：`workspaceOnly`（默认开）经 `wsFilterPaths()`（`index.js:3594-3609`）决定 `/api/codewiki/jobs`（过滤在 `index.js:3694`）与 `/api/codewiki/repos`（`inWs` 在 `index.js:3694`）是否按宿主工作区清单过滤；宿主未注册任何工作区、`workspaceRegistry.list()` 抛错或开关关闭时返回 `null` = 不过滤（`index.js:3688-3700`）。

## Connections

- [[job-service]]：`liveConfig` 的并发/模型/思考档位直接喂给阶段执行器（`index.js:790-801`、`index.js:790-805`），`excludePaths` 与 `autoUpdate*` 驱动 `autoScan`（`index.js:2884-2911`），`parallelLimit`/`serialProjects` 决定项目闸门与排队文案（`index.js:73-75`、`index.js:73`）。
- [[ui-settings]]：`CodewikiCard`（`client.js:548-1036`）与 `ReposTab.toggleExclude`（`client.js:1207-1225`）是配置的写侧。
- [[web-api-endpoints]]：`/api/codewiki/models`（`index.js:323-338`）为设置页级联下拉供数；`/api/codewiki/model-efforts`（`index.js:323-343`）暴露思考档位；`/api/codewiki/repos`（`index.js:323-412`）暴露 `excluded` 标记（`index.js:323`）与调度器状态（`index.js:323-331`）；`/api/codewiki/control`（`index.js:3045-3076`）承载 `cancel`（`index.js:3853-3855`）/ `refresh`（`index.js:1227-1230`）/ `compile`（`index.js:1227-1236`）三个 action（`refresh` 供 `toggleExclude` 失效总览缓存）；`/api/codewiki/jobs`（`index.js:1207-1243`）按工作区过滤任务列表（`index.js:1207`）。
- [[session-reminder]]：`updateReminder` 开关与 `reminderText`/`commitHintText` 构成「收尾提醒 + 产物待提交」链路（`index.js:81-124`），`autoCommit` 的三态结论由 `autoCommitState`（`index.js:1750-1755`）在两条通道间共享。
- [[session-channel]]：`sessionTier`（`index.js:1546`）与 `buildSessionSteerText`（`index.js:66-84`）把「超预算文章转会话通道」时的档位钉死；`bigProvider` 留空（大档关闭）才会触达该通道（`index.js:66-73`）。
- [[pipeline-orchestration]]：`articleLanguage` 在工具入口落入任务（`index.js:76`、`index.js:76`），`planMode` 决定规划路径（`index.js:77`），`agenticArticles`/`agenticMaxSteps` 决定文章通道与步数（`index.js:79`、`index.js:79`），`symbolIncremental` 决定 stale 的组件级过滤与快照写入（`index.js:65-84`、`index.js:65-86`），`batchReasoningEffort`/`bigReasoningEffort` 在 `runRealtimeTasks`（`index.js:509-568` 定义，任务级 effort 决议在 `index.js:509-511`）里落成模型调用参数。

## Known Issues

- **`en()` 词典与 yml 注释的 `updateReminder` 文案已过期**：`client.js:80` 仍写 "only when the session repo has a .codewiki/"，`cordis.patch.yml:18` 也写「仅当会话仓库存在 .codewiki/」；实际判定是仓库根存在 `CodeWiki.md`（`index.js:80`，且注释明确说明不看 `.codewiki/` 目录，`index.js:80-83`）。中文词典 `client.js:80` 是正确表述——同一开关三种文案两种语义。
- **前端校验与后端钳制是两套规则**：设置页拦 `maxConcurrency` 1–8 整数（`client.js:95-99`）、`bigConcurrency` 0/1–8（`client.js:78-82`）、`agenticMaxSteps` 1–100（`client.js:76-80`）、`planMode` 白名单（`client.js:92-95`），但越界值在 `liveConfig` 侧是**静默钳制**而非报错（`index.js:92-94`、`index.js:69-71`、`index.js:69-72`、`index.js:69`）；`bigTokenBudget` 前端完全无校验（`client.js:69-77` 只是无格式 Input），低于 110000 的值会被静默抬到 110k（`index.js:452`）。绕过 UI 直接改宿主配置不会得到任何报错，只会看到行为与填的值不同。思考档位是唯一有运行期兜底的例外：选了模型不支持的值由 `llmChat` 剥档重试（`index.js:452-455`）。
- **排除清单是字符串前缀比较**：`excludedItem`（`index.js:327-336`）只做 `path.normalize` + 小写 + 去尾斜杠 + 前缀匹配，不解析符号链接、不支持通配符；清单里写相对路径或带 `..` 的路径会静默不命中。注意 `isExcluded` 也被复用于工作区过滤（`index.js:334`、`index.js:334`），语义在那里是「位于某工作区之下」，两处共用同一个前缀判定。
- **无配置 schema 迁移路径**：`Config`（`index.js:60-86`）没有版本号字段，旧宿主配置里已废弃的键不会被清理也不会报错，只会在 `liveConfig` 里被静默忽略（`index.js:92-134`）。
- **`snapshot.revision` 冲突只提示不重试**：`save()` 拿到 `accepted === false` 时仅设置 `conflict` 提示（`client.js:121`），需用户手动再点保存；草稿也不会被自动合并。
- **无本地密钥兜底**：插件不保存任何密钥，凭证完全依赖宿主 llm 服务按 `batchProvider` 解析。若 provider 在模型设置里被删或凭证失效，提交任务会立即报错（`index.js:63-66`），而非降级到其他通道。
- **yml 注释只文档化了 13/25 个设置项**：`cordis.patch.yml:6-17` 缺 enabled/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget/sessionTier/parallelProjects/autoCommit/excludePaths/autoUpdate/autoUpdateMin/workspaceOnly 的说明；权威来源是 Config schema 的 `.description`（`index.js:1243-1267`）与设置页 hint（`client.js:35-384`）。
- **两类配置的热生效边界不一致**：`Config` 声明的 25 个字段全部 `.volatile()` 热生效，但 `JOBS_FILE`/`TICK_MS`/`SESSION_TASK_TIMEOUT_MS`/`ORPHAN_TAKEOVER_MS`/`REPOS_FILE` 走环境变量且只在模块加载时求值一次（`index.js:1373`、`index.js:1374`、`index.js:1378`、`index.js:1566`、`index.js:1572`），改它们必须重启宿主——文档与 UI 的「无需重启」承诺不覆盖这部分。
