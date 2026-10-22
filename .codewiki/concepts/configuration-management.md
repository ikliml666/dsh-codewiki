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

`configuration-management` 是 dsh-codewiki 插件里"配置值如何被声明、归一化、校验、持久化、热读取"的横切概念。它跨三个文件：

- `cordis.patch.yml` —— 静态挂载元数据（插件 id 与 `config: {}` 初值）。
- `index.js` —— 配置 schema（`Config`，`index.js:37-51`）、归一化入口（`liveConfig`，`index.js:57-76`）、凭证解析（`resolveBatchApiKey`，`index.js:546-566`）、以及四组消费点（工具 execute、`submit`、自动更新调度器、systemPrompt 提醒）。
- `client.js` —— 浏览器侧设置表单（`CodewikiCard`，`client.js:406-688`），经宿主的 `configForms` 服务命名空间 `codewiki` 读写同一份配置。

核心设计取向：**没有独立配置文件**。配置的权威副本在宿主的 Config 服务里，插件侧只声明 schema 并在每次使用时现场读一次（`liveConfig(cfg)`），因此不存在"改了设置要重启"的问题 —— 这一点直接写在客户端词典 `intro` 文案里（`client.js:31`："此处设置经 configForms 热生效，无需重启"）。

一致性的另一条主线是：**所有字段都 `.volatile()`**（`index.js:38-50` 每个字段后都紧跟 `.volatile()`），即配置不参与持久化判定/不缓存，读取永远取最新值。

## Key Components

### `index.js` — schema 与归一化

**常量**

| 常量 | 位置 | 用途 |
| --- | --- | --- |
| `CW_SUBCOMMANDS` | `index.js:20` | 允许的 cw 子命令白名单：`init/status/index/meta/path/projects/setup/uninstall` |
| `CONCURRENCY_HARD_CAP` | `index.js:22` | 编译请求并发硬顶 `8`，`maxConcurrency` 的默认值与此上限都由它派生 |
| `hostCtxRef` | `index.js:539` | `apply()` 时捕获的宿主上下文，批量路径经它 `inject(['credentials'])` 取百炼凭证 |
| `agentsRef` | `index.js:1172` | 宿主 `agents` 服务引用，用于编译终态 steer 唤醒与主模型规划 |
| `llmRef` | `index.js:1177` | 宿主 `llm` 服务引用，`batchProvider` 非空时编译走它，且提供模型目录 |

**`Config`（`index.js:37-51`）** —— 用 `@deepseek-ai/schemastery`（`z`）声明的插件配置 schema，13 个字段，全部 `.volatile()`：

| 字段 | 行号 | 类型 / 默认值 | 说明（取自 `.description`） |
| --- | --- | --- | --- |
| `enabled` | `index.js:38` | boolean，`true` | 停用后两个工具立即报错 |
| `binaryPath` | `index.js:39` | string，`''` | cw 可执行文件路径；留空优先 PATH 里的 cw，找不到再用插件自带 `bin/cw(.exe)` |
| `batchProvider` | `index.js:40` | string，`''` | 编译模型提供商；留空=百炼兼容通道，非空=走宿主 llm 服务 |
| `batchModel` | `index.js:41` | string，`'qwen3.7-flash'` | 全部模型环节共用；`batchProvider` 为空时是百炼模型名，非空时是该 provider 的模型 id |
| `batchApiKey` | `index.js:42` | string，`''` | 阿里云百炼 API Key 覆盖；留空自动用模型设置「阿里百炼云」渠道凭证 |
| `batchThinkingBudget` | `index.js:43` | number，`0` | `0`=关闭思考；`1~32768`=开启思考并限制预算 |
| `maxConcurrency` | `index.js:44` | number，`CONCURRENCY_HARD_CAP` | 编译请求并发上限（1–8），硬顶 8 |
| `articleLanguage` | `index.js:45` | string，`'中文'` | wiki 文章书写语言 |
| `updateReminder` | `index.js:46` | boolean，`true` | 会话系统提示注入维护提醒，仅当会话仓库根存在 `CodeWiki.md` |
| `excludePaths` | `index.js:47` | string，`''` | 排除清单，换行/分号/逗号分隔绝对路径 |
| `autoUpdate` | `index.js:48` | boolean，`false` | 定时扫描已编译工作区，检测到变更自动提交增量编译 |
| `autoUpdateMin` | `index.js:49` | number，`30` | 自动更新扫描间隔（分钟），最小 5 |
| `workspaceOnly` | `index.js:50` | boolean，`true` | 任务页只显示属于已添加 dsh 工作区的任务 |

**函数**

- `val(x)`（`index.js:53-55`）：取配置值的小工具。宿主传进来的 config 可能带 `.get()`（schemastery 包装），也可能就是普通对象，`val` 统一两种形态 —— 所有读取都经它。
- `liveConfig(config)`（`index.js:57-76`）：**唯一的配置归一化入口**。逐字段 `val()` 后做类型强制与钳制：
  - `batchModel` 空串回落 `'qwen3.7-flash'`（`index.js:64`）；
  - `batchThinkingBudget` 钳到 `[0, 32768]`（`index.js:66`，`Math.min(Math.max(...), 32768)`）；
  - `maxConcurrency` 非有限数或 `<1` 时回落硬顶，否则 `Math.min(concurrency, CONCURRENCY_HARD_CAP)`（`index.js:67-69`）——**双重钳制**：schemastery 的 default 不构成约束，真正的上限只在这里；
  - `articleLanguage` 空串回落 `'中文'`（`index.js:70`）；
  - `autoUpdateMin` 用 `Math.max(5, ...)`（`index.js:73`），非法值回落 30；
  - `workspaceOnly` 用 `val(c.workspaceOnly) !== false`（`index.js:74`）——缺省视为开启；
  - `autoUpdate` 用 `val(c.autoUpdate) === true`（`index.js:72`）——缺省视为关闭。
- `resolveBatchApiKey(hostCtx, cfg)`（`index.js:546-566`）：凭证解析链。显式 `batchApiKey` 直接返回 `{ key, source: 'config' }`（`index.js:547-548`）；否则 `hostCtx.inject(['credentials'])` 取 credentials 服务并 `resolve('ALIYUN_BAILIAN_API_KEY')`（`index.js:553-563`），注入与解析外面套了 3 秒 `Promise.race` 超时（`index.js:550-559`）；任一步失败返回 `null`，由调用方决定报错或跳过。
- `resolveBinary(cfg)`（`index.js:82-102`）：`binaryPath` 的消费点。显式值优先（`index.js:83`）；否则 win32 用 `where cw`、POSIX 用 `which cw` 探测 PATH（`index.js:82-94`），命中且文件存在即采用；再回落插件自带 `bin/cw` 或 `bin/cw.exe`（`index.js:82-83`）；最后才是裸 `'cw'`。注释说明了顺序理由：PATH 优先是为了避免捆绑二进制落后于 codewiki 源码（`index.js:82-83`）。
- `excludedItem(cwd, list)` / `isExcluded(cwd, list)`（`index.js:226-238`）：`excludePaths` 的消费点。分隔符兼容换行、分号、中英文逗号（`index.js:226` 的 `/[\n;，,]+/`）；比较时大小写不敏感、剥掉尾部斜杠，`cwd` 等于某项或位于其子树内即命中（`index.js:229-233`）。`excludedItem` 返回命中的排除项原文（工具报错要告诉用户是哪条排除项拒绝了该工作区），`isExcluded` 是布尔包装。
- `normalizeCwd(input)`（`index.js:26-31`）：Windows/Git-Bash 兼容。win32 下把 MSYS 盘符路径 `/e/foo` 转成 `E:/foo`；POSIX 上原样返回（那里 `/e/...` 可能真是绝对路径）。
- `listModelCatalog(llm)`（`index.js:2504-2525`）：设置页级联下拉的数据源。遍历 `llm.listProviders()` 并对每个 provider 调 `listModels(id)`；单个 provider 抛错（缺凭证/端点不通）只给该条目附 `error` 并保留空 `models`，不影响其他 provider（`index.js:2504-2505`）；llm 服务未注入时整体返回 `ok:false`，设置页降级为手填。
- `installUpdateReminder(ctx, config)`（`index.js:2775-2807`）：把 `updateReminder` 注入会话系统提示。经 `agent.ctx.inject(['systemPrompt'])` 注册 section `codewiki:update-reminder`（`index.js:2775-2784`），`order` 排在 `TOOL_REPORT` 之后（`index.js:2787`）。`text` 是回调，每次组装系统提示都重新求值：开关关掉返回空串（`index.js:2789`），`cwd` 下无 `CodeWiki.md` 返回空串（`index.js:2791`），否则返回 `reminderText(cwd)` 并按需拼接 `commitHintText`（`index.js:2792-2793`）。
- `reminderText(cwd)`（`index.js:2764-2773`）：维护提醒固定文案（含"不要手工编写或修改 `.codewiki/` 下的文章"）。
- `commitHintText(cwd, jobs)`（`index.js:2737-2762`）：编译完成后"请提交改动"提醒。零状态派生：取该 cwd 最近一次 `stage==='done'` 且 `writtenCount>0` 的 job（`index.js:2737-2739`），与 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 的提交时间比较（`index.js:2737-2740`），编译晚于提交才提醒。结果进 `commitHintCache` 做 60 秒 TTL（`index.js:2737`、`index.js:2741`），因为 `text` 回调会频繁求值。
- `apply(ctx, config)`（`index.js:2809-2870`）：插件入口，把配置接到各处：`hostCtxRef = ctx`（`index.js:2809`）、`inject(['agents'])` 赋 `agentsRef`（`index.js:2812`）、`inject(['llm'])` 赋 `llmRef`（`index.js:2813`）、`createJobService(config, wakeCompileSession)`（`index.js:2813`）、`ctx.effect(() => () => service.stop())`（`index.js:2817`）、自动更新调度器（`index.js:2809-2834`）、注册四个工具（`index.js:2850-2866`）、`installWebServer`（`index.js:2868`）、`installUpdateReminder`（`index.js:2868`）。
- `autoScan()`（`index.js:2824-2846`）：`autoUpdate`/`autoUpdateMin` 的消费点。60 秒心跳（`index.js:2847`）但内部按 `Date.now() - schedState.lastScan < c.autoUpdateMin * 60000` 节流（`index.js:2827`）；`autoUpdate` 关闭直接返回（`index.js:2827`）；对 job 历史里出现过的 cwd 去重后逐个跳过 `isExcluded(cwd, c.excludePaths)`（`index.js:2836`），其余调 `generateDef.execute({ cwd, scope:'auto', auto:true }, {})`（`index.js:2839`），单仓库失败只记 `schedState.lastError`。

### `index.js` — 配置的消费点（读取边界）

配置不是集中在一处读的，而是在**每条边界现场读一次 `liveConfig`**：

- 工具 execute：`cw`（`index.js:939-940`）、`codewiki_generate`（`index.js:2195-2196`）、`codewiki_progress`（`index.js:2448-2449`）都以 `const c = liveConfig(cfg); if (!c.enabled) throw ...` 开头。
- `submit()`（`index.js:2059-2116`）：提交编译任务时的配置闸门。先 `excludedItem` 拦排除目录（`index.js:2061-2064`，错误文案带上命中的排除项）；再按 `batchProvider` 二选一 —— 非空走宿主 llm 通道，只校验 `batchModel` 非空且 `llmRef.stream` 可用（`index.js:2094-2098`），空则 `resolveBatchApiKey` 取百炼凭证，取不到抛"未找到百炼 API Key"（`index.js:2100-2101`）。
- 批处理执行器：`startBatchChatRun`（`index.js:1396-1439`）每次取 `liveConfig(config)` 决定 provider/model/思考预算/并发（`index.js:1396`、`index.js:1396-1404`）。
- Web 端点：`wsFilterPaths()`（`index.js:2542-2557`）读 `workspaceOnly` 决定是否按宿主工作区过滤；`/api/codewiki/repos` 里读 `excludePaths`、`autoUpdate`、`autoUpdateMin` 组装每个仓库的 `excluded` 标记与调度器状态（`index.js:2620`、`index.js:2542-2550`）。

### `client.js` — 设置表单

- 命名空间常量：`NS = 'codewiki'`（`client.js:18`）、`KEY = 'codewiki'`（`client.js:18`）；`NS` 同时是 `configForms` 的命名空间与 `plugins.item` 的注册 id，`KEY` 是侧边栏 `main` 面板与 `sidebar.panellist` 的共同 id。
- 端点常量：`JOBS_PATH`（`client.js:19`）、`CONTROL_PATH`（`client.js:20`）、`REPOS_PATH`（`client.js:23`）、`MODELS_PATH`（`client.js:24`）；轮询间隔 `POLL_MS = 2000`（`client.js:19`）、`REPOS_POLL_MS = 10000`（`client.js:19`）；`ACTIVE_STAGES`（`client.js:26`）用于判定任务是否在跑。
- `zh()`（`client.js:28-143`）/ `en()`（`client.js:144-259`）：全部配置项的 label 与 hint 文案。曲线注意：词典值必须是字符串，写函数会让 `t()` 回退成键名（见 `client.js:8` 头注释）。
- `apiGet(p)`（`client.js:347-352`）/ `apiPost(p, data)`（`client.js:353-362`）：fetch 封装，非 2xx 抛 `body.error || HTTP <status>`。
- 挂载：`inject: ['slots','locale','configForms']`（`client.js:382`）；`form = ctx.configForms.get(NS)`（`client.js:382`）；设置卡片经 `configForms.whileServed([NS], mount)` 只在宿主该命名空间被服务时出现（`client.js:382-386`）；面板 slot 注册在 `client.js:383-394`。
- `CodewikiCard(props)`（`client.js:406-688`）：设置 UI 主体。
  - state：`snapshot`（`form.getSnapshot()`）、`draft`（可编辑草稿）、`notice`、`error`、`catalog`、`catalogError`（`client.js:409-416`）。
  - 模型目录：`apiGet(MODELS_PATH)`（`client.js:420`），`data.ok === false` 时置 `catalogError` 并退回手填形态（`client.js:347`）。
  - 快照订阅：`pull()` 里按 `snap.revision` 变化才用 `structuredClone` 覆盖草稿（`client.js:435-444`），`form.subscribe(pull)` 清理时释放（`client.js:447-448`）。
  - `setPath(key, value)`（`client.js:454-461`）：不可变更新草稿。
  - `dirty`（`client.js:463-466`）：草稿与快照的 `JSON.stringify` 比较。
  - `selectedProvider`（`client.js:469-473`）：按 `draft.batchProvider` 在目录里找条目，找不到为 `null`（手填形态）。
  - `save()`（`client.js:475-502`）：先做两道前端校验 —— `maxConcurrency` 必须是 1–8 的整数（`client.js:477-481`），`batchThinkingBudget` 必须是 0–32768 的整数（`client.js:482-486`）；然后按 13 个 key 的白名单逐个 `JSON.stringify` 比较，差异项生成 `{ op:'set', path:[key], value }`（`client.js:489-493`）；最后 `form.mutate(ops, snapshot.revision)`，接受则显示"已保存"，否则显示冲突（`client.js:496-498`）。
  - `discard()`（`client.js:504-508`）。
  - 渲染分区：运行（`client.js:520-575`，含 `enabled`/`updateReminder`/`workspaceOnly` 开关、`maxConcurrency`、`articleLanguage`、`binaryPath`）、编译模型（`client.js:569-639`）、调度与排除（`client.js:569-601`）、保存条（`client.js:569-575`）。
  - 提供商切换的行为：`onChange` 里选中新 provider 后立刻把 `batchModel` 重置为该 provider 目录里的第一个模型，选"内置百炼通道"（空值）则回落 `'qwen3.7-flash'`（`client.js:589-596`）；目录里没有的 provider 仍然保留为选项，避免静默丢失配置（`client.js:595-598`）。
- `ReposTab()`（`client.js:827-970`）：总览页，轮询 `/api/codewiki/repos`，并就地编辑 `excludePaths` —— `toggleExclude` 读 `form.getSnapshot()` 拆分隔符、增删该 cwd、`form.mutate` 写回，再 `POST {action:'refresh'}` 让服务端 30s 缓存失效（`client.js:857-875`）。
- `CodewikiPanel()`（`client.js:972-1172`）：侧边栏面板三页（overview/tasks/settings），`settings` 页直接复用 `CodewikiCard`（`client.js:1143`）；进度总百分比用 `STAGE_WEIGHTS`（`client.js:774`）与 `overallPct`（`client.js:775-783`）计算，封顶 99、`done` 才 100。

### `cordis.patch.yml` — 静态挂载

`cordis.patch.yml:1-15`：注释列出当时的设置项，正文是 `- insert:` 下一条 `id: codewiki`、`name: file:///.../index.js`、`config: {}`（`cordis.patch.yml:12-15`）。要点：**初值是空对象 `{}`**，所有默认值因此必须由 `Config` 的 `.default()`（`index.js:37-51`）与 `liveConfig` 的回落（`index.js:57-76`）共同兜住；`id` 必须与客户端 `NS`/`KEY` 一致（`client.js:18-19`），否则 `configForms` 拿不到命名空间、面板 id 对不上。

## Architecture

```text
┌─────────────────────────────┐
│ cordis.patch.yml            │
│ id: codewiki, config: {}    │
└──────────────┬──────────────┘
               │ cordis 挂载
               ▼
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ index.js apply()            │◄──────►│ 宿主 Config 服务             │
│  Config (schemastery 声明)  │  读取  │ 命名空间 'codewiki'          │
│  liveConfig() 归一化 + 钳制 │        └──────────────▲───────────────┘
└───────┬──────────────┬──────┘                       │ form.mutate / getSnapshot
        │ 每次用前读    │ inject                     │
        ▼              ▼                            │
┌───────────────┐ ┌────────────────┐      ┌─────────┴────────────────┐
│ 工具 execute   │ │ Job Service    │      │ client.js CodewikiCard   │
│ enabled 守卫   │ │ autoScan 节流  │      │ 草稿 / 校验 / 白名单 diff │
│ submit 凭证闸  │ │ excludePaths   │      └──────────────────────────┘
└───────────────┘ └───────┬────────┘
                          ▼
                ┌────────────────────────┐
                │ /api/codewiki/* 端点   │
                │ workspaceOnly 过滤     │
                └────────────────────────┘
```

## Data Flow

1. **挂载期**：cordis 读 `cordis.patch.yml` 加载 `index.js`，以 `config: {}` 调 `apply(ctx, config)`（`index.js:2809`）。此时没有任何字段落在磁盘上，`Config` 的 `.default()` 与 `liveConfig` 的 `?? fallback` 共同决定初值。
2. **读配置**：任何需要配置的地方都现场调 `liveConfig(config)`，从宿主 config 对象取当前值并钳制（`index.js:57-76`）。因为字段全部 `.volatile()`（`index.js:57-69`），不存在"旧快照"，改设置无需重启 —— 与客户端词典 `intro`（`client.js:31`）承诺一致。
3. **用户改配置**：`CodewikiCard` 从 `form.getSnapshot()` 起稿（`client.js:406-420`），用户改草稿，`save()` 前端校验 + 白名单 diff 出 ops（`client.js:406-422`），`form.mutate(ops, snapshot.revision)` 带 revision 提交，冲突时提示重试（`client.js:496-498`）。宿主写成功后 revision 变化，订阅回调重拉快照覆盖草稿。
4. **配置生效**：下一次 `liveConfig` 调用即取到新值。因此"改并发上限"生效于**下一个提交的批次**（`index.js:57` 的 `concurrency: c.maxConcurrency`），"改排除清单"生效于下一次 `excludedItem` 判断（`index.js:2061`），"改自动更新开关"生效于下一次 `autoScan` 心跳（`index.js:57`）。
5. **凭证解析**：`batchProvider` 为空 → `submit` 调 `resolveBatchApiKey`（`index.js:2101`），显式 `batchApiKey` > 宿主 credentials 的 `ALIYUN_BAILIAN_API_KEY`，解析结果按 job 缓存在内存（`apiKeyOf`，`index.js:1312-1319`），不落盘；`batchProvider` 非空 → 凭证由宿主按 provider 解析，插件只校验通道可用（`index.js:2094-2098`）。
6. **提醒注入**：`installUpdateReminder` 注册的 systemPrompt section 每次组装时回调求值：`updateReminder` 为 false 直接空（`index.js:2788`）、无 `CodeWiki.md` 直接空（`index.js:2775`）、否则拼 `reminderText` 与 `commitHintText`（`index.js:2792-2793`），后者带 60 秒 TTL 缓存（`index.js:2775`）。
7. **面板可见性**：`workspaceOnly`（默认开）经 `wsFilterPaths()`（`index.js:2542-2557`）决定 `/api/codewiki/jobs` 与 `/api/codewiki/repos` 是否按宿主工作区清单过滤；宿主未注册任何工作区时返回 `null`=不过滤。

## Connections

- [[job-service]]：`liveConfig` 的并发/模型/思考预算直接喂给阶段执行器（`index.js:57-100`），`excludePaths` 与 `autoUpdate*` 驱动 `autoScan`。
- [[credential-resolution]]：`resolveBatchApiKey`（`index.js:546-566`）是 `batchApiKey`/`batchProvider` 两个字段的落点，也是"配置 vs 凭据库"的分界。
- [[ui-settings]]：`CodewikiCard`（`client.js:406-688`）与 `ReposTab` 的 `toggleExclude`（`client.js:857-875`）是配置的写侧。
- [[web-api-endpoints]]：`/api/codewiki/models`（`index.js:2620`）为设置页级联下拉供数，`/api/codewiki/repos`（`index.js:2620`）暴露 `excluded` 与调度器状态。
- [[session-reminder]]：`updateReminder` 与 `commitHintText` 构成"收尾提醒"链路。

## Known Issues

- **`cordis.patch.yml` 注释已过期**：`cordis.patch.yml:2-8` 仍写着 `defaultProvider` / `defaultModel` / `defaultReasoningEffort` / "`maxConcurrency` 硬顶 2" / "仅当会话仓库存在 `.codewiki/`"，而当前 `Config`（`index.js:37-51`）没有前三个字段，硬顶是 `8`（`index.js:37`），提醒门控看的是 `CodeWiki.md` 而非 `.codewiki/`（`index.js:37`）。读注释会得出错误结论，应以 schema 为准。
- **缺词典键 `invalidBatchThinking`**：`save()` 在思考预算非法时调 `t('invalidBatchThinking')`（`client.js:484`），但 `zh()`（`client.js:484-599`）与 `en()`（`client.js:484-599`）都没有这个键，按 `client.js:484` 头注释的约定 `t()` 会回退成键名 —— 用户看到的是字面量 `invalidBatchThinking` 而非可读错误。
- **`en()` 的 updateReminderHint 与实现不符**：`client.js:152` 仍说"only when the session repo has a `.codewiki/`"，实际判定是 `CodeWiki.md` 存在（`index.js:2790`）；中文词典 `client.js:36` 是对的。同一份 UI 两种语言的提示语义不一致。
- **前端校验与后端钳制两套规则**：设置页拦 1–8 整数（`client.js:477-480`）与 0–32768 整数（`client.js:482-485`），但非整数/越界值在 liveConfig 侧是**静默钳制**而非报错（`index.js:57-60`、`index.js:57`）。绕过 UI（直接改宿主配置）时不会得到任何报错，只会看到行为与填的值不同。
- **`batchThinkingBudget` 仅百炼通道生效**：走宿主 provider 时该字段被忽略，使用该模型的默认思考档（见 `client.js:53` 的 hint）。同一个设置项在不同 `batchProvider` 下含义不同，属易踩的陷阱。
- **凭证只在内存**：`job.apiKey` 由 `apiKeyOf` 缓存（`index.js:1311-1318`），重启后必须重新解析；`saveJobs` 显式剔除 `apiKey`（`index.js:1127`）。这是有意的安全取舍，但意味着凭证库在重启后若不可用，活动任务会立即失败而不是继续跑。
- **排除清单是字符串前缀比较**：`excludedItem`（`index.js:226-235`）只做 `path.normalize` + 小写 + 去尾斜杠 + 前缀匹配，不解析符号链接、不支持通配符；清单里写相对路径或带 `..` 的路径会静默不命中。
- **无配置 schema 迁移路径**：`Config` 的字段增删没有版本号，旧宿主配置里已废弃的键（如 `defaultProvider`）不会被清理也不会报错，只会在 `liveConfig` 里被忽略。