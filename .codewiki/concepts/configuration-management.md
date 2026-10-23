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

- `cordis.patch.yml` —— 静态挂载元数据：插件 id `codewiki` 与初值 `config: {}`（`cordis.patch.yml:2-5`）。
- `index.js` —— 配置 schema（`Config`，`index.js:37-52`）、唯一归一化入口（`liveConfig`，`index.js:58-78`）、取值兼容层（`val`，`index.js:54-56`），以及散布在各条边界上的消费点（工具 execute、`submit`、批量执行器、Web 端点、自动更新调度器、systemPrompt 提醒）。
- `client.js` —— 浏览器侧设置表单（`CodewikiCard`，`client.js:410-701`），经宿主 `configForms` 服务的命名空间 `codewiki` 读写同一份配置；总览页还能就地改写 `excludePaths`（`toggleExclude`，`client.js:870-888`）。

核心设计取向：**插件没有自己的配置文件**。配置的权威副本在宿主的 Config 服务里，插件侧只声明 schema、并在每次使用时现场读一次 `liveConfig(cfg)`。因此不存在「改了设置要重启」的问题 —— 这条承诺直接写在客户端词典的 `intro` 文案里（`client.js:31`：「此处设置经 configForms 热生效，无需重启」）。

一致性的另一条主线：**全部字段都带 `.volatile()`**（`index.js:58-72`，每个字段的链尾都紧跟 `.volatile()`），即配置不参与持久化判定、不被缓存，读取永远取当前值。这也是 `liveConfig` 可以随便在各处重复调用的前提。

第三个取向是**默认值双保险**：`cordis.patch.yml` 的初值是空对象 `{}`（`cordis.patch.yml:2`），所以所有默认值必须由 `Config` 的 `.default()`（`index.js:37-51`）与 `liveConfig` 的回落表达式（`index.js:58-78`）共同兜住；两处任一缺失都会让字段变成 `undefined` 并向下游传播。

## Key Components

### `index.js` — schema 与归一化

**相关常量**

| 常量 | 位置 | 用途 |
| --- | --- | --- |
| `CONCURRENCY_HARD_CAP` | `index.js:22` | 值为 `8`；`maxConcurrency` 的默认值与运行期上限都由它派生 |
| `CW_SUBCOMMANDS` | `index.js:20` | cw 子命令白名单 `init/status/index/meta/path/projects/setup/uninstall`，与配置无直接关系，但同样在工具入口做门禁 |
| `BATCH_TOKEN_BUDGET` | `index.js:366` | 值为 `28000`；单请求输入预算，与 `batchThinkingBudget` 同级影响计费档 |
| `BAILIAN_BASE` | `index.js:363` | `https://dashscope.aliyuncs.com/compatible-mode/v1`，`batchProvider` 为空时走的端点 |
| `hostCtxRef` | `index.js:541` | `apply()` 时捕获的宿主上下文，凭证解析经它 `inject(['credentials'])` |

**`Config`（`index.js:37-52`）** —— 用 schemastery（`z`）声明的插件配置 schema，**14 个字段**，全部 `.volatile()`：

| 字段 | 行号 | 类型 / 默认值 | 说明（取自 `.description`） |
| --- | --- | --- | --- |
| `enabled` | `index.js:38` | boolean，`true` | 停用后两个工具立即报错 |
| `binaryPath` | `index.js:39` | string，`''` | cw 可执行文件路径；留空优先 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | `index.js:40` | string，`''` | 编译模型提供商；留空=走百炼兼容通道，非空=走宿主 llm 服务 |
| `batchModel` | `index.js:41` | string，`'qwen3.7-flash'` | 全部模型环节共用；`batchProvider` 为空时是百炼模型名，非空时是该 provider 的模型 id |
| `batchApiKey` | `index.js:42` | string，`''` | 阿里云百炼 API Key 的可选覆盖；留空自动用模型设置「阿里百炼云」渠道凭证 |
| `batchThinkingBudget` | `index.js:43` | number，`0` | `0`=关闭思考；`1~32768`=开启思考并限制预算 |
| `sessionTier` | `index.js:44` | string，`''` | 会话通道档位 id（`dsh-subagent-auto-router` 里的档位，如 `codeiwiki`）；留空=让会话模型自动选路 |
| `maxConcurrency` | `index.js:45` | number，`CONCURRENCY_HARD_CAP` | 编译请求并发上限（1–8），硬顶 8 |
| `articleLanguage` | `index.js:46` | string，`'中文'` | wiki 文章书写语言 |
| `updateReminder` | `index.js:47` | boolean，`true` | 会话系统提示注入维护提醒，仅当会话仓库根存在 `CodeWiki.md` |
| `excludePaths` | `index.js:48` | string，`''` | 排除清单；换行/分号/逗号分隔的绝对路径 |
| `autoUpdate` | `index.js:49` | boolean，`false` | 定时扫描已编译工作区，检测到变更自动提交增量编译 |
| `autoUpdateMin` | `index.js:50` | number，`30` | 自动更新扫描间隔（分钟），最小 5 |
| `workspaceOnly` | `index.js:51` | boolean，`true` | 任务页只显示属于已添加 dsh 工作区的任务 |

**`val(x)`（`index.js:54-56`）** —— 取配置值的兼容层。宿主传进来的 config 可能是 schemastery 包装（带 `.get()`），也可能就是普通对象：

```js
function val(x) {
  return x && typeof x === 'object' && typeof x.get === 'function' ? x.get() : x
}
```

所有字段读取都经它，因此下游代码不必关心 config 形态。

**`liveConfig(config)`（`index.js:58-78`）** —— **唯一的配置归一化入口**。逐字段 `val()` 后做类型强制与钳制，返回一个普通对象：

- `enabled: val(c.enabled) ?? true`（`index.js:62`）—— 缺省视为开启。
- `batchModel` 空串回落 `'qwen3.7-flash'`（`index.js:65`）。
- `batchThinkingBudget` 钳到 `[0, 32768]`：`Math.min(Math.max(Number(val(c.batchThinkingBudget)) || 0, 0), 32768)`（`index.js:67`）。
- `maxConcurrency` 双重钳制（`index.js:60`、`index.js:69-71`）：先 `Number(...)` 存进 `concurrency`，非有限数或 `< 1` 时直接回落硬顶，否则 `Math.min(concurrency, CONCURRENCY_HARD_CAP)`。**schemastery 的 `.default()` 不构成约束，真正的上限只在这里。**
- `articleLanguage` 空串回落 `'中文'`（`index.js:72`）。
- `autoUpdate` 用 `val(c.autoUpdate) === true`（`index.js:74`）—— 缺省视为关闭（注意与 `enabled` 的 `?? true` 相反）。
- `autoUpdateMin` 用 `Math.max(5, Number(val(c.autoUpdateMin)) || 30)`（`index.js:75`）—— 非法值回落 30，下限 5。
- `workspaceOnly` 用 `val(c.workspaceOnly) !== false`（`index.js:76`）—— 缺省视为开启。
- `excludePaths` 原样透出字符串，不做切分（切分在各消费点做，见下）。

**字段级消费者（独立函数）**

- `resolveBinary(cfg)`（`index.js:84-104`）：`binaryPath` 的消费点。显式值优先（`index.js:85`）；否则 win32 用 `where cw`（`index.js:84-86`）、POSIX 用 `which cw`（`index.js:84-86`）探测 PATH；再回落插件自带 `bin/cw` 或 `bin/cw.exe`（`index.js:84-85`）；最后才是裸 `'cw'`（`index.js:84`）。注释说明了顺序理由：PATH 优先是为了避免捆绑二进制落后于 codewiki 源码，出现「bash 原生正常、包装层 No wiki found」的分叉（`index.js:84-85`）。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`（`index.js:228-240`）：`excludePaths` 的消费点。分隔符为 `/[\n;，,]+/`（`index.js:228`），兼容换行、分号、中英文逗号；比较时 `path.normalize` + 小写 + 剥掉尾部斜杠，`cwd` 等于某项或位于其子树内即命中（`index.js:231-235`）。`excludedItem` 返回命中的排除项**原文**（工具报错要告诉模型是哪条排除项拒绝了此工作区，`index.js:226`），`isExcluded` 是布尔包装（`index.js:238-240`）。
- `resolveBatchApiKey(hostCtx, cfg)`（`index.js:548-568`）：`batchApiKey` 的消费链。显式值直接返回 `{ key, source: 'config' }`（`index.js:549-550`）；否则 `hostCtx.inject(['credentials'])` 取 credentials 服务并 `resolve('ALIYUN_BAILIAN_API_KEY')`（`index.js:555-565`），注入与解析外套 3 秒 `Promise.race` 超时（`index.js:552-561`）；任一步失败返回 `null`，由调用方决定报错还是跳过。
- `listModelCatalog(llm)`（`index.js:2510-2531`）：设置页级联下拉的数据源。遍历 `llm.listProviders()` 并对每个 provider 调 `listModels(id)`；单个 provider 抛错（缺凭证/端点不通）只给该条目附 `error` 并保留空 `models`（`index.js:2510-2518`），不影响其他 provider；`llm` 服务未注入时整体返回 `ok:false`（`index.js:2511-2513`），设置页降级为手填。
- `commitHintText(cwd, jobs)`（`index.js:2744-2769`）与 `reminderText(cwd)`（`index.js:2771-2780`）：`updateReminder` 链路的两段文案。
- `installUpdateReminder(ctx, config)`（`index.js:2782-2814`）：把提醒注册成 systemPrompt section `codewiki:update-reminder`，`order` 排在 `TOOL_REPORT` 之后（`index.js:2782-2784`）。`text` 是回调，每次组装系统提示都重新求值：`updateReminder` 为 `false` 返回空串（`index.js:2795`），`cwd` 下无 `CodeWiki.md` 返回空串（`index.js:2797`），否则返回 `reminderText(cwd)` 并按需拼上 `commitHintText`（`index.js:2798-2799`）。

### `index.js` — 配置消费点（读取边界）

配置不集中在一处读，而是在**每条边界现场读一次 `liveConfig`**：

- 工具 execute 的 `enabled` 门禁：`cw`（`index.js:916-917`）、`codewiki_generate`（`index.js:2201-2202`）、`codewiki_progress`（`index.js:2454-2455`）都以 `const c = liveConfig(cfg)` + `if (!c.enabled) throw ...` 开头，报错文案各不相同（前缀分别是 `cw：` / `codewiki_generate：` / `codewiki_progress：`）。
- 提交闸门 `submit()`（`index.js:2066-2123`）：先 `excludedItem` 拦排除目录（`index.js:2066-2070`，错误文案带命中的排除项并有编辑指引）；再按 `batchProvider` 二选一 —— 非空走宿主 llm 通道，只校验 `batchModel` 非空且 `llmRef.stream` 可用（`index.js:2101-2105`）；为空则 `resolveBatchApiKey` 取百炼凭证，取不到抛「未找到百炼 API Key」（`index.js:2107-2108`）。解析结果写进 `job.credentialSource` 与 `job.apiKey`（`index.js:2115-2116`）。
- 批量执行器 `startBatchChatRun(job, prepared)`（`index.js:1422-1465`）：每次取 `liveConfig(config)`（`index.js:1423`）决定 provider / model / thinkingBudget / concurrency（`index.js:1423-1436`）；凭证只在百炼通道需要，`batchProvider` 非空时 `creds` 直接是空串占位（`index.js:1428`）。
- 凭证复用 `apiKeyOf(job)`（`index.js:1337-1344`）：内存优先，缺失时重新 `resolveBatchApiKey(hostCtxRef, liveConfig(config))`（`index.js:1339`）。
- 会话通道档位：`sessionTier` 在派发 steer 时读取（`index.js:1518-1519`）与宿主重启重发时读取（`index.js:1562-1563`），交给纯函数 `buildSessionSteerText({ job, snapshots, tier, resend })`（`index.js:1046-1064`）；非空时文本里插入「必须显式传 tier」的要求行（`index.js:1046-1048`）。
- Web 端点：`wsFilterPaths()`（`index.js:2549-2564`）读 `workspaceOnly` 决定是否按宿主工作区过滤（`index.js:2552`）；`/api/codewiki/jobs` 用它对任务列表过滤（`index.js:2582-2583`）；`/api/codewiki/repos` 里读 `excludePaths` 与 `autoUpdate*` 组装每个仓库的 `excluded` 标记（`index.js:2627`）与调度器状态（`index.js:2549-2558`）。
- 自动更新调度器 `autoScan()`（`index.js:2831-2853`）：读 `autoUpdate` / `autoUpdateMin` / `excludePaths`。60 秒心跳（`index.js:2854`）但内部按 `Date.now() - schedState.lastScan < c.autoUpdateMin * 60000` 节流（`index.js:2834`）；`autoUpdate` 关闭直接返回（`index.js:2833`）；对 job 历史里出现过的 cwd 去重后逐个跳过被排除项（`index.js:2831-2832`），其余调 `generateDef.execute({ cwd, scope: 'auto', auto: true }, {})`（`index.js:2846`），单仓库失败只记 `schedState.lastError`（`index.js:2849`）。

### `client.js` — 设置表单

- 命名空间常量：`NS = 'codewiki'`（`client.js:18`）、`KEY = 'codewiki'`（`client.js:18`）。`NS` 同时是 `configForms` 的命名空间与 `plugins.item` 的注册 id；`KEY` 是侧边栏 `main` 面板与 `sidebar.panellist` 的共同 id。头注释写明 id 必须等于 `package.json` 的 `name`（`client.js:7`）。
- 端点与节奏常量：`JOBS_PATH`（`client.js:19`）、`CONTROL_PATH`（`client.js:20`）、`REPOS_PATH`（`client.js:23`）、`MODELS_PATH`（`client.js:24`）；`POLL_MS = 2000`（`client.js:19`）、`REPOS_POLL_MS = 10000`（`client.js:19`）；`ACTIVE_STAGES`（`client.js:26`）用于判定任务是否在跑。
- 词典：`zh()`（`client.js:28-145`）/ `en()`（`client.js:146-263`）覆盖全部配置项的 label 与 hint。头注释警告：词典值必须是字符串，写成函数会让 `t()` 回退成键名（`client.js:8`）。
- 请求封装：`apiGet(p)`（`client.js:351-356`）/ `apiPost(p, data)`（`client.js:357-362`）。
- 挂载与门控：`inject: ['slots', 'locale', 'configForms']`（`client.js:378`）、`form = ctx.configForms.get(NS)`（`client.js:378`）；设置卡片经 `ctx.configForms.whileServed([NS], mount)` 只在宿主服务该命名空间时出现（`client.js:386-390`，无该 API 时直接 `mount()`）。
- `CodewikiCard(props)`（`client.js:410-701`）：设置 UI 主体。
  - state：`snapshot` / `draft` / `notice` / `error` / `catalog` / `catalogError`（`client.js:413-420`）；`snapshot.status` 为 `loading`/`unavailable` 或草稿为空时只渲染占位（`client.js:514-516`）。
  - 模型目录：`apiGet(MODELS_PATH)`，`data.ok === false` 时置 `catalogError` 并退回手填形态（`client.js:424-431`）。
  - 快照订阅：`pull()` 里按 `snap.revision` 变化才用 `structuredClone` 覆盖草稿，`form.subscribe(pull)` 清理时释放（`client.js:439-453`）。
  - `setPath(key, value)`：不可变更新草稿（`client.js:458-465`）；`dirty` 用 `JSON.stringify` 比较草稿与快照（`client.js:467-470`）；`selectedProvider` 按 `draft.batchProvider` 在目录里找条目，找不到为 `null`（=手填形态，`client.js:473-477`）。
  - `save()`（`client.js:479-506`）：两道前端校验 —— `maxConcurrency` 必须是 1–8 的整数（`client.js:481-485`），`batchThinkingBudget` 必须是 0–32768 的整数（`client.js:486-490`）；然后按 14 个 key 的白名单逐个 `JSON.stringify` 比较，差异项生成 `{ op:'set', path:[key], value }`（`client.js:493-497`）；无差异直接提示「已保存」，否则 `form.mutate(ops, snapshot.revision)` 带 revision 提交，冲突时提示重试（`client.js:500-502`）。
  - `discard()`：回滚草稿到快照（`client.js:508-512`）。
  - 渲染分区三块 + 保存条：运行（`client.js:518-576`，含 `enabled`/`updateReminder`/`workspaceOnly` 开关、`maxConcurrency`、`articleLanguage`、`binaryPath`）；编译模型（`client.js:578-657`）；调度与排除（`client.js:659-691`）；保存条（`client.js:692-699`）。
  - 提供商切换的联动（`client.js:593-600`）：选中新 provider 后立刻把 `batchModel` 重置为该 provider 目录里的第一个模型，选「内置百炼通道」（空值 `option`，`client.js:602`）则回落 `'qwen3.7-flash'`；目录里没有的 provider 仍保留为选项，避免静默丢失配置（`client.js:604-607`）。
  - 模型字段的三态渲染（`client.js:613-633`）：有目录且该提供商有模型 → 下拉；否则手填输入框（本地自建模型常不在目录里）；当前值不在目录中时额外保留一个同名 `option`。
- `ReposTab()`（`client.js:840` 起）：总览页，按 `REPOS_POLL_MS` 轮询 `/api/codewiki/repos`（`client.js:840-856`），并就地编辑 `excludePaths` —— `toggleExclude` 从 `form.getSnapshot()` 取当前值、按 `/[\\/]+$/` 归一化比较、增删该 cwd、`form.mutate` 写回，成功后 `POST {action:'refresh'}` 让服务端总览缓存失效并立即重拉（`client.js:870-888`）。
- `CodewikiPanel()`（`client.js:985` 起）：侧边栏面板三页（overview/tasks/settings），`settings` 页直接复用 `CodewikiCard`（`client.js:1156`）；进度总百分比用 `STAGE_WEIGHTS`（`client.js:787`）与 `overallPct`（`client.js:788-796`）计算。

### `cordis.patch.yml` — 静态挂载

`cordis.patch.yml:1-15`：注释段（`cordis.patch.yml:1-11`）列出当时的设置项，正文是 `- insert:` 下一条 `id: codewiki`、`name: file:///.../index.js`、`config: {}`（`cordis.patch.yml:12-15`）。

两个要点：

1. **初值是空对象 `{}`**（`cordis.patch.yml:15`），故所有默认值必须由 `Config` 的 `.default()`（`index.js:37-51`）与 `liveConfig` 的回落（`index.js:58-78`）共同兜住。
2. **`id` 必须与客户端 `NS`/`KEY` 一致**（`client.js:18-19`），否则 `configForms.get(NS)` 拿不到命名空间、面板 id 也对不上（`client.js:375`）。

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

## Data Flow

1. **挂载期**：cordis 读 `cordis.patch.yml` 加载 `index.js`，以 `config: {}` 调 `apply(ctx, config)`（`index.js:2816`）。`apply` 先存 `hostCtxRef = ctx`（`index.js:2816`），再 `inject(['agents'])` / `inject(['llm'])` 拿服务引用（`index.js:2818-2819`），然后 `createJobService(config, wakeCompileSession)` 并 `service.start()`（`index.js:2820-2821`）。此时没有任何配置字段落在磁盘上，`Config.default()` 与 `liveConfig` 的回落表达式共同决定初值。
2. **读配置**：任何需要配置的地方现场调 `liveConfig(config)`，从宿主 config 对象取当前值并钳制（`index.js:58-78`）。因为字段全部 `.volatile()`（`index.js:58-72`），不存在「旧快照」，改设置无需重启。
3. **用户改配置**：`CodewikiCard` 从 `form.getSnapshot()` 起稿（`client.js:413`），用户改草稿 → `save()` 前端校验 + 白名单 diff 出 ops（`client.js:479-497`）→ `form.mutate(ops, snapshot.revision)` 带 revision 提交（`client.js:500`），冲突时返回 `false` 并提示 `conflict`（`client.js:501`）。宿主写成功后 revision 变化，订阅回调 `pull()` 重拉快照覆盖草稿（`client.js:439-453`）。
4. **配置生效时刻**：下一次 `liveConfig` 调用即取到新值。因此「改并发上限」生效于**下一个提交的批次**（`index.js:58-60` 的 `maxConcurrency: ... Math.min(concurrency, CONCURRENCY_HARD_CAP)`），「改排除清单」生效于下一次 `excludedItem` 判断（`index.js:2068`），「改自动更新开关」生效于下一次 `autoScan` 心跳（`index.js:58`），「改会话档位」生效于下一次派发 steer（`index.js:1518`）。
5. **凭证解析**：`batchProvider` 为空 → `submit` 调 `resolveBatchApiKey`（`index.js:2107`），显式 `batchApiKey` 优先，其次宿主 credentials 的 `ALIYUN_BAILIAN_API_KEY`；解析结果存进 `job.apiKey`（`index.js:2116`），`saveJobs` 时**显式剔除 `apiKey`**（`index.js:1154`），故重启后由 `apiKeyOf` 重新解析（`index.js:1337-1344`）。`batchProvider` 非空 → 凭证由宿主按 provider 解析，插件只校验通道可用（`index.js:2101-2105`）。
6. **提醒注入**：systemPrompt section 的 `text` 回调每次组装时求值 —— `updateReminder` 为 false 返回空（`index.js:2795`）、无 `CodeWiki.md` 返回空（`index.js:2771`），否则拼 `reminderText` 与 `commitHintText`（`index.js:2798-2799`），后者带 60 秒 TTL 缓存（`index.js:2747`、`index.js:2767`），因为该回调会被频繁求值。
7. **面板可见性**：`workspaceOnly`（默认开）经 `wsFilterPaths()` 决定 `/api/codewiki/jobs` 与 `/api/codewiki/repos` 是否按宿主工作区清单过滤（`index.js:2549-2564`）；宿主未注册任何工作区时返回 `null` = 不过滤（`index.js:2563`）。

## Connections

- [[job-service]]：`liveConfig` 的并发/模型/思考预算直接喂给阶段执行器（`index.js:58-72`），`excludePaths` 与 `autoUpdate*` 驱动 `autoScan`（`index.js:2831-2853`）。
- [[credential-resolution]]：`resolveBatchApiKey`（`index.js:548-568`）是 `batchApiKey`/`batchProvider` 两个字段的落点，也是「配置 vs 凭据库」的分界线。
- [[ui-settings]]：`CodewikiCard`（`client.js:410-701`）与 `ReposTab.toggleExclude`（`client.js:870-888`）是配置的写侧。
- [[web-api-endpoints]]：`/api/codewiki/models`（`index.js:2510-2525`）为设置页级联下拉供数（数据源 `listModelCatalog` 在 `index.js:2510-2531`）；`/api/codewiki/repos`（`index.js:2510-2589`）暴露 `excluded` 标记与调度器状态；`/api/codewiki/control`（`index.js:2510-2541`）承载 `cancel` / `refresh` / `compile` 三个 action。
- [[session-reminder]]：`updateReminder` 开关与 `commitHintText` 构成「收尾提醒」链路（`index.js:2744-2776`）。
- [[session-channel]]：`sessionTier`（`index.js:44`）与 `buildSessionSteerText`（`index.js:1046-1064`）把「超预算文章转会话通道」时的档位钉死。
- [[pipeline-orchestration]]：`articleLanguage` 在任务装配期进入写作指令，`batchThinkingBudget` 在 `bailianChat` 里落成 `enable_thinking` / `thinking_budget`（`index.js:287-288`）。

## Known Issues

- **`cordis.patch.yml` 注释已过期**：`cordis.patch.yml:6-11` 仍写着 `defaultProvider` / `defaultModel` / `defaultReasoningEffort`、「`maxConcurrency` 硬顶 2」、提醒「仅当会话仓库存在 `.codewiki/`」，而当前 `Config`（`index.js:37-52`）没有前三个字段，硬顶是 `8`（`index.js:45`），提醒门控看的是 `CodeWiki.md`（`index.js:37`）。照注释读会得出错误结论，应以 schema 为准。
- **缺词典键 `invalidBatchThinking`**：`save()` 在思考预算非法时调 `t('invalidBatchThinking')`（`client.js:488`），但 `zh()`（`client.js:488-605`）与 `en()`（`client.js:488-605`）都没有这个键。按 `client.js:488` 头注释的约定，`t()` 会回退成键名 —— 用户看到的是字面量 `invalidBatchThinking` 而不是可读错误。
- **`en()` 的 `updateReminderHint` 与实现不符**：`client.js:154` 仍写 "only when the session repo has a `.codewiki/`"，实际判定是仓库根存在 `CodeWiki.md`（`index.js:2797`）；中文词典 `client.js:36` 是正确表述。同一份 UI 两种语言的提示语义不一致。
- **前端校验与后端钳制是两套规则**：设置页拦 1–8 整数（`client.js:481-485`）与 0–32768 整数（`client.js:486-490`），但非整数/越界值在 `liveConfig` 侧是**静默钳制**而非报错（`index.js:67` 的 `batchThinkingBudget` 钳制、`index.js:69-71` 的 `maxConcurrency` 钳制）。绕过 UI（直接改宿主配置）不会得到任何报错，只会看到行为与填的值不同。
- **`batchThinkingBudget` 只在百炼通道生效**：走宿主 llm 服务时该字段被忽略，沿用该 provider/模型的默认思考档（见 `index.js:261-262` 注释与 `client.js:53` 的 hint —— 宿主侧是 `reasoningEffort` 枚举档而非 token 数）。同一个设置项在不同 `batchProvider` 下含义不同，是最易踩的陷阱。
- **凭证只在内存**：`job.apiKey` 由 `apiKeyOf` 缓存（`index.js:1337-1344`），`saveJobs` 显式剔除该字段（`index.js:1154`），重启后必须重新解析。这是有意的安全取舍，但意味着凭证库在重启后若不可用，在跑任务会立刻失败而不是继续跑。
- **排除清单是字符串前缀比较**：`excludedItem`（`index.js:228-237`）只做 `path.normalize` + 小写 + 去尾斜杠 + 前缀匹配，不解析符号链接、不支持通配符；清单里写相对路径或带 `..` 的路径会静默不命中。注意 `isExcluded` 也被复用于工作区过滤（`index.js:2583`、`index.js:2619`），语义在那里是「位于某工作区之下」，两处共用同一个前缀判定。
- **无配置 schema 迁移路径**：`Config`（`index.js:37-52`）没有版本号字段，旧宿主配置里已废弃的键（如 `defaultProvider`）不会被清理也不会报错，只会在 `liveConfig` 里被静默忽略。
- **`snapshot.revision` 冲突只提示不重试**：`save()` 拿到 `accepted === false` 时仅设置 `conflict` 提示（`client.js:501`），需用户手动再点保存；草稿也不会被自动合并。