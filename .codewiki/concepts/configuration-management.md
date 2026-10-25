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

`configuration-management` 是 dsh-codewiki 插件里「配置值如何被声明、归一化、校验、持久化、热读取」的横切概念。它横跨三个文件：

- `cordis.patch.yml` —— 静态挂载元数据：插件 id `codewiki` 与初值 `config: {}`（`cordis.patch.yml:2-5`，其中 `id` 在 `cordis.patch.yml:14`、`config: {}` 在 `cordis.patch.yml:2`）。
- `index.js` —— 配置 schema（`Config`，`index.js:51-71`）、唯一归一化入口（`liveConfig`，`index.js:77-102`）、取值兼容层（`val`，`index.js:73-75`），以及散布在各条边界上的消费点（工具 execute、`submit`、批量执行器、Web 端点、自动更新调度器、systemPrompt 提醒）。
- `client.js` —— 浏览器侧设置表单（`CodewikiCard`，`client.js:460-859`），经宿主 `configForms` 服务的命名空间 `codewiki`（`client.js:17`、`client.js:425`）读写同一份配置；总览页还能就地改写 `excludePaths`（`toggleExclude`，`client.js:1030-1048`）。

核心设计取向：**插件没有自己的配置文件**。配置的权威副本在宿主的 Config 服务里，插件侧只声明 schema、并在每次使用时现场读一次 `liveConfig(cfg)`。因此不存在「改了设置要重启」的问题 —— 这条承诺直接写在客户端词典的 `intro` 文案里（`client.js:33`：「此处设置经 configForms 热生效，无需重启」）。

一致性的另一条主线：**全部字段都带 `.volatile()`**（`index.js:77-97`，每个字段的链尾都紧跟 `.volatile()`），即配置不参与持久化判定、不被缓存，读取永远取当前值。这也是 `liveConfig` 可以随便在各处重复调用的前提。

第三个取向是**默认值双保险**：`cordis.patch.yml` 的初值是空对象 `{}`（`cordis.patch.yml:2`），所以所有默认值必须由 `Config` 的 `.default()`（`index.js:51-71`）与 `liveConfig` 的回落表达式（`index.js:77-102`）共同兜住；两处任一缺失都会让字段变成 `undefined` 并向下游传播。

## Key Components

### `index.js` — schema 与归一化

**相关常量**

| 常量 | 位置 | 用途 |
| --- | --- | --- |
| `CW_SUBCOMMANDS` | `index.js:20` | cw 子命令白名单，与配置无直接关系，但在工具入口做门禁 |
| `CONCURRENCY_HARD_CAP` | `index.js:22` | 值为 `8`；`maxConcurrency` 的运行期硬顶由它派生 |
| `DEFAULT_CONCURRENCY` | `index.js:24` | 值为 `2`；`maxConcurrency` 的默认并发（适合免费 hy3 档） |
| `DEFAULT_BATCH_PROVIDER` | `index.js:26` | 值为 `'workbuddy'`；编译模型提供商默认值 |
| `DEFAULT_BATCH_MODEL` | `index.js:27` | 值为 `'hy3'`；编译模型默认值 |
| `DEFAULT_BIG_PROVIDER` | `index.js:30` | 值为 `'volces-ark'`；大档模型提供商默认值 |
| `DEFAULT_BIG_MODEL` | `index.js:31` | 值为 `'glm-5.3-flash'`；大档模型默认值 |
| `DEFAULT_BIG_TOKEN_BUDGET` | `index.js:33` | 值为 `420000`；大档单请求输入预算默认值 |
| `BATCH_TOKEN_BUDGET` | `index.js:374` | 值为 `110000`；普通档单请求输入预算，影响分块装填 |
| `BATCH_TOKEN_HARD_LIMIT` | `index.js:379` | 值为 `128000`；超预算兜底装填上限 |

**`Config`（`index.js:51-71`）** —— 用 schemastery（`z`）声明的插件配置 schema，**19 个字段**，全部 `.volatile()`：

| 字段 | 行号 | 类型 / 默认值 | 说明（取自 `.description`） |
| --- | --- | --- | --- |
| `enabled` | `index.js:52` | boolean，`true` | 停用后两个工具立即报错 |
| `binaryPath` | `index.js:53` | string，`''` | cw 可执行文件路径；留空优先 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | `index.js:54` | string，`'workbuddy'` | 编译模型提供商（必须是模型设置里已注册的 provider id）；留空将无法提交任务 |
| `batchModel` | `index.js:55` | string，`'hy3'` | 编译模型（全部模型环节共用）：该 provider 下的模型 id |
| `batchReasoningEffort` | `index.js:56` | string，`''` | 思考程度档位 id；留空=用模型默认档 |
| `bigProvider` | `index.js:57` | string，`'volces-ark'` | 大档模型提供商；留空=不启用大档，退回会话通道兜底 |
| `bigModel` | `index.js:58` | string，`'glm-5.3-flash'` | 大档模型 id；默认火山方舟 glm-5.3-flash |
| `bigReasoningEffort` | `index.js:59` | string，`''` | 大档模型思考程度；留空=用模型默认档 |
| `bigTokenBudget` | `index.js:60` | number，`420000` | 大档单请求输入预算（token） |
| `sessionTier` | `index.js:61` | string，`''` | 会话通道档位 id（仅当大档都装不下且 bigProvider 留空时兜底使用）；留空=让会话模型自动选路 |
| `maxConcurrency` | `index.js:62` | number，`2` | 编译请求并发上限（1–8），硬顶 8 |
| `serialProjects` | `index.js:63` | boolean，`true` | 单项目串行：同一时刻只推进一个仓库的编译任务 |
| `articleLanguage` | `index.js:64` | string，`'中文'` | wiki 文章书写语言 |
| `updateReminder` | `index.js:65` | boolean，`true` | 会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现） |
| `autoCommit` | `index.js:66` | boolean，`true` | 编译完成后由插件自己提交产物（只 add .codewiki/ 与 CodeWiki.md，建议 docs(wiki) 前缀；不动其它改动） |
| `excludePaths` | `index.js:67` | string，`''` | 排除清单：换行/分号/逗号分隔绝对路径 |
| `autoUpdate` | `index.js:68` | boolean，`false` | 自动更新：定时扫描已编译过的工作区，检测到变更自动提交增量编译 |
| `autoUpdateMin` | `index.js:69` | number，`30` | 自动更新扫描间隔（分钟），最小 5 |
| `workspaceOnly` | `index.js:70` | boolean，`true` | 任务页只显示属于已添加 dsh 工作区（宿主工作区列表）的任务 |

**`val(x)`（`index.js:73-75`）** —— 取配置值的兼容层。宿主传进来的 config 可能是 schemastery 包装（带 `.get()`），也可能就是普通对象：

```js
function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}
```

所有字段读取都经它，因此下游代码不必关心 config 形态。

**`liveConfig(config)`（`index.js:77-102`）** —— **唯一的配置归一化入口**。逐字段 `val()` 后做类型强制与钳制，返回一个普通对象：

- `enabled: val(c.enabled) ?? true`（`index.js:81`）—— 缺省视为开启。
- `batchModel` 空串回落 `'hy3'`（`index.js:84`）。
- `bigModel` 空串回落 `'glm-5.3-flash'`（`index.js:87`）。
- `bigTokenBudget` 用 `Math.max(BATCH_TOKEN_BUDGET, Number(val(c.bigTokenBudget)) || DEFAULT_BIG_TOKEN_BUDGET)`（`index.js:89`）—— 下限为普通预算 110k。
- `maxConcurrency` 双重钳制（`index.js:91-93`）：非有限数或 `< 1` 时直接回落默认 `2`，否则 `Math.min(concurrency, CONCURRENCY_HARD_CAP)`。**schemastery 的 `.default()` 不构成约束，真正的上限只在这里。**
- `serialProjects` 用 `val(c.serialProjects) !== false`（`index.js:94`）—— 缺省视为开启。
- `articleLanguage` 空串回落 `'中文'`（`index.js:95`）。
- `autoCommit` 用 `val(c.autoCommit) !== false`（`index.js:99`）—— 缺省视为开启（与 `enabled` 同逻辑，与 `autoUpdate` 相反）。
- `autoUpdate` 用 `val(c.autoUpdate) === true`（`index.js:97`）—— 缺省视为关闭。
- `autoUpdateMin` 用 `Math.max(5, Number(val(c.autoUpdateMin)) || 30)`（`index.js:98`）—— 非法值回落 30，下限 5。
- `workspaceOnly` 用 `val(c.workspaceOnly) !== false`（`index.js:100`）—— 缺省视为开启。
- `excludePaths` 原样透出字符串，不做切分（切分在各消费点做，见下）。

**字段级消费者（独立函数）**

- `resolveBinary(cfg)`（`index.js:108-128`）：`binaryPath` 的消费点。显式值优先（`index.js:109`）；否则 win32 用 `where cw`（`index.js:108`）、POSIX 用 `which cw`（`index.js:108`）探测 PATH；再回落插件自带 `bin/cw(.exe)`（`index.js:108`）；最后才是裸 `'cw'`（`index.js:108`）。注释说明了顺序理由：PATH 优先是为了避免捆绑二进制落后于 codewiki 源码，出现「bash 原生正常、包装层 No wiki found」的分叉（`index.js:108-109`）。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`（`index.js:252-264`）：`excludePaths` 的消费点。分隔符为 `/[\n;，,]+/`（`index.js:252`），兼容换行、分号、中英文逗号；比较时 `path.normalize` + 小写 + 剥掉尾部斜杠，`cwd` 等于某项或位于其子树内即命中（`index.js:255-259`）。`excludedItem` 返回命中的排除项**原文**（工具报错要告诉模型是哪条排除项拒绝了此工作区，`index.js:250-251`），`isExcluded` 是布尔包装（`index.js:262-264`）。
- `listModelCatalog(llm)`（`index.js:2624-2645`）：设置页「编译模型」级联下拉的数据源。遍历 `llm.listProviders()` 并对每个 provider 调 `listModels(id)`；单个 provider 抛错（缺凭证/端点不通）只给该条目附 `error` 并保留空 `models`（`index.js:2624-2625`），不影响其他 provider；`llm` 服务未注入时整体返回 `ok:false`（`index.js:2625-2627`），设置页降级为手填。
- `resolveModelEfforts(llm, provider, model)`（`index.js:2662-2684`）：思考程度档位数据源。走宿主 `llm.resolveModelInfo`（或旧版 `resolveModel`，由 `resolveModelInfoOf` 在 `index.js:2651-2656` 适配）取 `reasoning.efforts` 与 `defaultEffort`（`index.js:2662-2673`）；失败返回 `ok:false`（`index.js:2662-2663`），设置页降级为默认档。
- `commitHintText(cwd, jobs)`（`index.js:3032-3063`）与 `reminderText(cwd)`（`index.js:3065-3074`）：`updateReminder` 链路的两段文案。
- `installUpdateReminder(ctx, config)`（`index.js:3076-3108`）：把提醒注册成 systemPrompt section `codewiki:update-reminder`，`order` 排在 `TOOL_REPORT` 之后（`index.js:3087`）。`text` 是回调，每次组装系统提示都重新求值：`updateReminder` 为 `false` 返回空串（`index.js:3089`），`cwd` 下无 `CodeWiki.md` 返回空串（`index.js:3091`），否则返回 `reminderText(cwd)` 并按需拼上 `commitHintText`（`index.js:3093`）。

### `index.js` — 配置消费点（读取边界）

配置不集中在一处读，而是在**每条边界现场读一次 `liveConfig`**：

- 工具 execute 的 `enabled` 门禁：`cwToolDefinition`（`index.js:892-955`，execute 内 `const c = liveConfig(cfg)` 在 `index.js:892`、`if (!c.enabled) throw` 在 `index.js:934`）、`generateToolDefinition`（`index.js:2247-2397`，execute 内 `const c = liveConfig(cfg)` 在 `index.js:892`、`if (!c.enabled) throw` 在 `index.js:2293`）、`progressToolDefinition`（`index.js:2478-2582`，execute 内 `const c = liveConfig(cfg)` 在 `index.js:892`、`if (!c.enabled) throw` 在 `index.js:2569`），报错文案各不相同（前缀分别是 `cw：` / `codewiki_generate：` / `codewiki_progress：`）。
- 提交闸门 `submit()`（`index.js:2148-2213`）：先 `excludedItem` 拦排除目录（`index.js:2150-2153`，错误文案带命中的排除项并有编辑指引）；再校验 `batchProvider` 非空且 `llmRef.stream` 可用（`index.js:2148-2153`，`liveConfig` 在 `index.js:2183`、`batchProvider` 非空判断在 `index.js:2184`、通道可用判断在 `index.js:2186`），否则抛错（**0.10.1 起删除内置百炼兼容入口，凭证完全由宿主按 provider 解析**，见 `index.js:2148-2153` 注释）。解析结果写进 `job.credentialSource`（`index.js:2192`）。
- 批量执行器 `startBatchChatRun(job, prepared)`（`index.js:1459-1499`）：每次取 `liveConfig(config)`（`index.js:1460`）决定 provider / model / reasoningEffort / concurrency（`index.js:1459-1464`）。
- 会话通道档位：`sessionTier` 在派发 steer 时读取（`index.js:1561`）与宿主重启重发时读取（`index.js:1605`），交给纯函数 `buildSessionSteerText({ job, snapshots, tier, resend })`（`index.js:1044-1062`）；非空时文本里插入「必须显式传 tier」的要求行（`index.js:1044-1046`）。
- Web 端点：`wsFilterPaths()`（`index.js:2702-2717`）读 `workspaceOnly` 决定是否按宿主工作区过滤（`index.js:2705`）；`/api/codewiki/jobs` 注册于 `index.js:2702-2720`，handler 内用它对任务列表过滤（`index.js:2737-2738`）；`/api/codewiki/repos` 注册于 `index.js:2702-2788`，里读 `excludePaths` 组装每个仓库的 `excluded` 标记（`index.js:2789`）与调度器状态（`index.js:2702-2710`）；`/api/codewiki/models` 注册于 `index.js:2702-2717` 与 `/api/codewiki/model-efforts` 注册于 `index.js:2702-2722` 为设置页供数。
- 自动更新调度器 `autoScan()`（`index.js:3124-3146`）：读 `autoUpdate` / `autoUpdateMin` / `excludePaths`（`index.js:3124`）。60 秒心跳（`index.js:3147`）但内部按 `Date.now() - schedState.lastScan < c.autoUpdateMin * 60000` 节流（`index.js:3127`）；`autoUpdate` 关闭直接返回（`index.js:3126`）；对 job 历史里出现过的 cwd 去重后逐个跳过被排除项（`index.js:3136`），其余调 `generateDef.execute({ cwd, scope: 'auto', auto: true }, {})`（`index.js:3139`），单仓库失败只记 `schedState.lastError`（`index.js:3142`）。

### `client.js` — 设置表单

- 命名空间常量：`NS = 'codewiki'`（`client.js:18`）、`KEY = 'codewiki'`（`client.js:18`）。`NS` 同时是 `configForms` 的命名空间与 `plugins.item` 的注册 id；`KEY` 是侧边栏 `main` 面板与 `sidebar.panellist` 的共同 id。头注释写明 id 必须等于 `package.json` 的 `name`（`client.js:7`）。
- 端点与节奏常量：`JOBS_PATH`（`client.js:19`）、`CONTROL_PATH`（`client.js:20`）、`REPOS_PATH`（`client.js:23`）、`MODELS_PATH`（`client.js:24`）、`EFFORTS_PATH`（`client.js:25`）；`POLL_MS = 2000`（`client.js:19`）、`REPOS_POLL_MS = 10000`（`client.js:19`）；`ACTIVE_STAGES`（`client.js:28`）用于判定任务是否在跑。
- 词典：`zh()`（`client.js:30-171`）/ `en()`（`client.js:172-313`）覆盖全部配置项的 label 与 hint。头注释警告：词典值必须是字符串，写成函数会让 `t()` 回退成键名（`client.js:8`）。
- 请求封装：`apiGet(p)`（`client.js:401-406`）/ `apiPost(p, data)`（`client.js:407-416`）。
- 挂载与门控：`inject: ['slots', 'locale', 'configForms']`（`client.js:428`）、`form = ctx.configForms.get(NS)`（`client.js:428`）；设置卡片经 `ctx.configForms.whileServed([NS], mount)` 只在宿主服务该命名空间时出现（`client.js:436-440`，无该 API 时直接 `mount()`）。
- `CodewikiCard(props)`（`client.js:460-859`）：设置 UI 主体。
  - state：`snapshot` / `draft` / `notice` / `error` / `catalog` / `catalogError`（`client.js:463-470`）；`snapshot.status` 为 `loading`/`unavailable` 或草稿为空时只渲染占位（`client.js:701-703`）。
  - 模型目录：`apiGet(MODELS_PATH)`，`data.ok === false` 时置 `catalogError` 并退回手填形态（`client.js:474-481`）。
  - 快照订阅：`pull()` 里按 `snap.revision` 变化才用 `structuredClone` 覆盖草稿，`form.subscribe(pull)` 清理时释放（`client.js:501-518`）。
  - `setPath(key, value)`：不可变更新草稿（`client.js:508-515`）；`dirty` 用 `JSON.stringify` 比较草稿与快照（`client.js:517-520`）；`selectedProvider` 按 `draft.batchProvider` 在目录里找条目，找不到为 `null`（=手填形态，`client.js:523-527`）。
  - `useEfforts`（`client.js:532-563`）：选中 provider/model 后二次拉取 `/api/codewiki/model-efforts`，档位清单来自模型目录，不手填裸字符串。
  - `modelTrio`（`client.js:570-594`）：提供商/模型/思考程度三字段共用渲染与目录联动；换提供商清空模型与旧档位（`client.js:570-573`）。
  - `save()`（`client.js:671-693`）：前端校验 —— `maxConcurrency` 必须是 1–8 的整数（`client.js:673-677`）；然后按 19 个 key 的白名单（`client.js:680`）逐个 `JSON.stringify` 比较，差异项生成 `{ op:'set', path:[key], value }`（`client.js:681-684`）；无差异直接提示「已保存」，否则 `form.mutate(ops, snapshot.revision)` 带 revision 提交，冲突时提示重试（`client.js:687-688`）。
  - `discard()`：回滚草稿到快照（`client.js:695-699`）。
  - 渲染分区四块 + 保存条：运行（`client.js:705-781`，含 `enabled`/`updateReminder`/`autoCommit`/`workspaceOnly`/`maxConcurrency`/`serialProjects`/`articleLanguage`/`binaryPath`）；编译模型（`client.js:783-798`，含 `batchProvider`/`batchModel`/`batchReasoningEffort`/`sessionTier`）；大档模型（`client.js:800-815`，含 `bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`）；调度与排除（`client.js:817-849`，含 `autoUpdate`/`autoUpdateMin`/`excludePaths`）；保存条（`client.js:851-858`）。
- `ReposTab()`（`client.js:1000-1143`）：总览页，按 `REPOS_POLL_MS` 轮询 `/api/codewiki/repos`（`client.js:1000-1004`），并就地编辑 `excludePaths` —— `toggleExclude` 从 `form.getSnapshot()` 取当前值、按归一化比较、增删该 cwd、`form.mutate` 写回，成功后 `POST {action:'refresh'}` 让服务端总览缓存失效并立即重拉（`client.js:1030-1048`）。
- `CodewikiPanel()`（`client.js:1145-1358`）：侧边栏面板三页（overview/tasks/settings），`settings` 页直接复用 `CodewikiCard`（`client.js:1329`）；进度总百分比用 `STAGE_WEIGHTS`（`client.js:947`）与 `overallPct`（`client.js:948-956`）计算。

### `cordis.patch.yml` — 静态挂载

`cordis.patch.yml:13-16`：头部是注释段（`cordis.patch.yml:1-12`）列出当前的设置项说明，正文是 `- insert:`（`cordis.patch.yml:13`）下一条 `id: codewiki`（`cordis.patch.yml:14`）、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`（`cordis.patch.yml:15`）、`config: {}`（`cordis.patch.yml:16`）。

两个要点：

1. **初值是空对象 `{}`**（`cordis.patch.yml:16`），故所有默认值必须由 `Config` 的 `.default()`（`index.js:51-71`）与 `liveConfig` 的回落（`index.js:77-102`）共同兜住。
2. **`id` 必须与客户端 `NS`/`KEY` 一致**（`client.js:18-19`），否则 `configForms.get(NS)` 拿不到命名空间、面板 id 也对不上。

## Architecture

```text
┌──────────────────────────────┐
│ cordis.patch.yml             │
│ id: codewiki, config: {}     │
└──────────────┬───────────────┘
               │ cordis 挂载
               ▼
┌──────────────────────────────┐      ┌────────────────────────────┐
│ index.js apply(ctx, config)  │◄────►│ 宿主 Config 服务           │
│  Config  z.object 声明       │ 读   │ 命名空间 'codewiki'        │
│  liveConfig() 归一化 + 钳制  │      └─────────────▲──────────────┘
└──────┬───────────────┬───────┘                    │ getSnapshot / mutate
       │ 用前现场读    │ inject                     │
       ▼               ▼                            │
┌──────────────┐ ┌─────────────────┐      ┌─────────┴────────────────┐
│ 工具 execute │ │ Job Service     │      │ client.js CodewikiCard   │
│ enabled 守卫 │ │ autoScan 节流   │      │ 草稿 / 前端校验 / 白名单 │
│ submit 凭证闸│ │ excludePaths    │      │ ReposTab toggleExclude   │
└──────────────┘ └────────┬────────┘      └──────────────────────────┘
                          ▼
                ┌──────────────────────┐
                │ /api/codewiki/* 端点 │
                │ workspaceOnly 过滤   │
                └──────────────────────┘
```

注：`apply(ctx, config)` 位于 `index.js:3110`，内部先注入 `agents`/`llm`（`index.js:3111-3112`），再 `createJobService`（`index.js:3113`）并 `service.start()`（`index.js:3114`）。`liveConfig` 定义于 `index.js:77-102`。

## Data Flow

1. **挂载期**：cordis 读 `cordis.patch.yml` 加载 `index.js`，以 `config: {}` 调 `apply(ctx, config)`（`index.js:3110`）。`apply` 先 `inject(['agents'])` / `inject(['llm'])` 拿服务引用（`index.js:3111-3112`），然后 `createJobService(config, wakeCompileSession)` 并 `service.start()`（`index.js:3113-3114`）。此时没有任何配置字段落在磁盘上，`Config.default()` 与 `liveConfig` 的回落表达式共同决定初值。
2. **读配置**：任何需要配置的地方现场调 `liveConfig(config)`，从宿主 config 对象取当前值并钳制（`index.js:77-102`）。因为字段全部 `.volatile()`（`index.js:77-97`），不存在「旧快照」，改设置无需重启。
3. **用户改配置**：`CodewikiCard` 从 `form.getSnapshot()` 起稿（`client.js:463`），用户改草稿 → `save()` 前端校验 + 白名单 diff 出 ops（`client.js:671-684`）→ `form.mutate(ops, snapshot.revision)` 带 revision 提交（`client.js:687`），冲突时返回 `false` 并提示 `conflict`（`client.js:688`）。宿主写成功后 revision 变化，订阅回调 `pull()` 重拉快照覆盖草稿（`client.js:460-477`）。
4. **配置生效时刻**：下一次 `liveConfig` 调用即取到新值。因此「改并发上限」生效于**下一个提交的批次**（`index.js:91-93` 的 `maxConcurrency` 钳制），「改排除清单」生效于下一次 `excludedItem` 判断（`index.js:2150` 与 `liveConfig` 的 `excludePaths` 读取 `index.js:96`），「改自动更新开关」生效于下一次 `autoScan` 心跳（`index.js:3124-3146`），「改会话档位」生效于下一次派发 steer（`index.js:1561`）。
5. **凭证解析**：`batchProvider` 必须非空（`index.js:2183-2186`），凭证由宿主按该 provider 解析，插件只校验通道可用（`index.js:2186`）；**0.10.1 起插件不存任何密钥，job 里也不再出现 apiKey 字段**（`index.js:1152` 注释），因此无本地密钥缓存，provider 配置错误或凭证失效时提交即报错。
6. **提醒注入**：systemPrompt section 的 `text` 回调每次组装时求值 —— `updateReminder` 为 false 返回空（`index.js:3089`）、无 `CodeWiki.md` 返回空（`index.js:3065`），否则拼 `reminderText` 与 `commitHintText`（`index.js:3093`），后者带 60 秒 TTL 缓存（`index.js:2930`、`index.js:3061`），因为该回调会被频繁求值。
7. **面板可见性**：`workspaceOnly`（默认开）经 `wsFilterPaths()` 决定 `/api/codewiki/jobs`（`index.js:2702` 注册，handler 内过滤在 `index.js:2737-2738`）与 `/api/codewiki/repos`（`index.js:2702` 注册，及过滤逻辑 `index.js:2702-2704`）是否按宿主工作区清单过滤；宿主未注册任何工作区时返回 `null` = 不过滤（`index.js:2705`）。

## Connections

- [[job-service]]：`liveConfig` 的并发/模型/思考预算直接喂给阶段执行器（`liveConfig` 定义于 `index.js:77-102`，执行器取值于 `index.js:77-82`），`excludePaths` 与 `autoUpdate*` 驱动 `autoScan`（`index.js:3124-3146`）。
- [[ui-settings]]：`CodewikiCard`（`client.js:460-859`）与 `ReposTab.toggleExclude`（`client.js:1030-1048`）是配置的写侧。
- [[web-api-endpoints]]：`/api/codewiki/models`（`index.js:2215-2230`）为设置页级联下拉供数；`/api/codewiki/model-efforts`（`index.js:2215-2235`）暴露思考档位；`/api/codewiki/repos`（`index.js:2215-2301`）暴露 `excluded` 标记与调度器状态；`/api/codewiki/control`（`index.js:2215-2246`）承载 `cancel` / `refresh` / `compile` 三个 action；`/api/codewiki/jobs`（`index.js:2215-2233`）按工作区过滤任务列表。
- [[session-reminder]]：`updateReminder` 开关与 `commitHintText`/`reminderText` 构成「收尾提醒」链路（`index.js:3032-3074`）。
- [[session-channel]]：`sessionTier`（`index.js:61`）与 `buildSessionSteerText`（`index.js:1044-1062`）把「超预算文章转会话通道」时的档位钉死。
- [[pipeline-orchestration]]：`articleLanguage` 在任务装配期进入写作指令（`index.js:560` 起），`batchReasoningEffort`/`bigReasoningEffort` 在 `runRealtimeTasks` 里落成模型调用参数（`index.js:332-361`，具体在 `index.js:332`）。

## Known Issues

- **`en()` 的 `updateReminderHint` 与实现不符**：`client.js:180` 仍写 "only when the session repo has a `.codewiki/`"，实际判定是仓库根存在 `CodeWiki.md`（`index.js:3091`）；中文词典 `client.js:38` 是正确表述。同一份 UI 两种语言的提示语义不一致。
- **前端校验与后端钳制是两套规则**：设置页拦 `maxConcurrency` 1–8 整数（`client.js:673-677`），但非整数/越界值在 `liveConfig` 侧是**静默钳制**而非报错（`index.js:91-93` 的 `maxConcurrency` 钳制、`index.js:89` 的 `bigTokenBudget` 钳制）。绕过 UI（直接改宿主配置）不会得到任何报错，只会看到行为与填的值不同。
- **排除清单是字符串前缀比较**：`excludedItem`（`index.js:252-264`）只做 `path.normalize` + 小写 + 去尾斜杠 + 前缀匹配，不解析符号链接、不支持通配符；清单里写相对路径或带 `..` 的路径会静默不命中。注意 `isExcluded` 也被复用于工作区过滤（`index.js:2738`、`index.js:2789`），语义在那里是「位于某工作区之下」，两处共用同一个前缀判定。
- **无配置 schema 迁移路径**：`Config`（`index.js:51-71`）没有版本号字段，旧宿主配置里已废弃的键不会被清理也不会报错，只会在 `liveConfig` 里被静默忽略。
- **`snapshot.revision` 冲突只提示不重试**：`save()` 拿到 `accepted === false` 时仅设置 `conflict` 提示（`client.js:687-688`），需用户手动再点保存；草稿也不会被自动合并。
- **无本地密钥兜底**：插件不保存任何密钥（`index.js:1152`），凭证完全依赖宿主 llm 服务按 `batchProvider` 解析。若 provider 在模型设置里被删或凭证失效，提交任务会立即报错（`index.js:2183-2191`），而非降级到其他通道。
