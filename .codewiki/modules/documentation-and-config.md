---
title: documentation-and-config
type: module
source_files:
  - .gitignore
  - CHANGELOG.md
  - CodeWiki.md
  - client.js
  - cordis.patch.yml
  - index.js
  - package.json
  - README.md
  - test-batch.mjs
  - test-orchestration.mjs
tags: [metadata, configuration, changelog, documentation, codewiki]
---

## Overview

`documentation-and-config` 模块不是一段可执行逻辑，而是 `@local/dsh-codewiki` 插件的**元数据与配置面**：它由 `package.json`（包身份、导出、宿主扫描标志）、`cordis.patch.yml`（bundle 挂载补丁）、`index.js` 中的 `Config` schema 与 `liveConfig`（配置真源）、`client.js` 中的设置表单与面板（配置的唯一图形入口）、`README.md` / `CodeWiki.md`（面向人的文档）、`CHANGELOG.md`（面向历史的决策记录）、`.gitignore`（运行期产物边界）以及两个自检脚本 `test-batch.mjs` / `test-orchestration.mjs` 共同构成。

理解本模块的关键在于：**同一份配置有四种表示形态**——Cordis schema（`index.js:37-51` 的 `Config`）、运行时快照（`index.js:57-76` 的 `liveConfig`）、浏览器草稿（`client.js:410` 的 `draft`）、人工文档（`README.md:24-38`）。四者必须保持一致：schema 每新增一个字段，`liveConfig` 的解包、`client.js:489` 的保存字段清单、以及 README 的设置小节都要同步，否则字段会「能存不能读」或在设置页静默丢失。

当前配置面（v0.9.1）的字段全集共 13 项，全部 `.volatile()`——即改完立即生效（每次 `execute`/`tick` 时经 `liveConfig` 重新解包），不需要重启 dsh。其中与「编译模型」相关的四项（`batchProvider` / `batchModel` / `batchApiKey` / `batchThinkingBudget`）在 0.9.1 从「写死百炼」改为「可指向宿主模型设置里任意 provider/model」，这是本模块最近一次结构性变更：新增了目录发现函数 `listModelCatalog`（`index.js:2503`）与配套端点 `GET /api/codewiki/models`（`index.js:2673-2688`），并把设置页的模型名文本框改成了 provider/model 两级级联下拉（`client.js:578-633`）。

## Key Components

### `package.json`（根目录，28 行）

包身份与宿主识别标志，是宿主扫描器与打包器唯一的机器可读入口。

| 行号 | 字段 | 值 | 作用 |
| --- | --- | --- | --- |
| 2 | `name` | `@local/dsh-codewiki` | 插件 id 基名；client.js 的 `__ModuleLoader__.load` 用它作模块 id |
| 3 | `version` | `0.9.1` | 与 `CHANGELOG.md:3` 的版本节同步 |
| 4 | `description` | 单行描述 | 插件管理页展示用 |
| 5 | `private` | `true` | 不发布到 npm，只用 file:/// 挂载 |
| 6 | `type` | `module` | 全仓 ESM：`index.js` 可直接 `import`/`export` |
| 7 | `main` | `index.js` | 服务端半侧入口 |
| 8-11 | `exports` | `".": "./index.js"`、`"./client": "./client.js"` | **两个半侧都要显式导出**，缺 `./client` 则浏览器半侧不会被装载 |
| 12 | `license` | `MIT` | 上游 `mraza007/codewiki` 同为 MIT |
| 13-16 | `engines` | `node >=20`、`dsh >=0.2.0-rc.0` | 宿主兼容性判定以 `engines.dsh` 为准（0.2.1-rc.1 起优先于 peerDependencies，includePrerelease） |
| 17-19 | `dependencies` | `@deepseek-ai/schemastery ^3.18.4` | **唯一依赖**，仅 `Config` 用；靠插件本地 junction 解析（见 Known Issues） |
| 20-27 | `dsh` | `client.platform: "web"`（22）、`bundle.patch: "cordis.patch.yml"`（25） | `dsh.client.platform` 驱动宿主把 `client.js` 送进浏览器；`dsh.bundle.patch` 让 bundle 安装方式找到补丁文件 |

注意 `dsh.client.platform` 是**判定开关而非提示**：宿主按 Loader 条目缓存「非 client 包」结论，所以新增该声明后必须重启 dsh 才会生效。

### `cordis.patch.yml`（根目录，15 行）

Bundle 形式安装用的 Cordis 补丁。结构与本地 file:/// 直挂完全同构，唯一区别是文件位置。

- 1-3：头注释，说明本地开发走 `profiles/web/cordis.patch.yml` 的 `file:///` 直挂（URL 空格写 `%20`），两种方式 id 必须都叫 `codewiki`。
- 4-11：设置项注释清单——`binaryPath`、`defaultProvider`、`defaultModel`、`defaultReasoningEffort`、`maxConcurrency`、`articleLanguage`、`updateReminder`。**这七条是 0.1.x 时代的遗留描述**：`defaultProvider` / `defaultModel` / `defaultReasoningEffort`（6-8 行）已不在 `index.js:37-51` 的 `Config` 里（子代理派发路径在 0.4.0 服务化后删除）；第 9 行「写文章子代理并发上限（硬顶 2）」也已过期——实际硬顶是 `CONCURRENCY_HARD_CAP = 8`（`index.js:22`）。以 `Config` 为准，注释仅作历史参考。
- 12-15：`insert` → `id: codewiki`（13）、`name: file:///E:/ik/Documents/trae_projects/1/dsh%20plugin/dsh-codewiki/index.js`（14）、`config: {}`（15）。id 与 `client.js:17` 的 `NS`、`client.js:18` 的 `KEY` 三处必须一致，否则设置表单与面板取不到同一命名空间。

### `index.js` 的 `Config` 与 `liveConfig`

```js
export const Config = z.object({ ... })   // index.js:37-51
```

13 个字段逐项（全部 `.volatile()`）：

| 行号 | 字段 | 类型/默认 | 语义 |
| --- | --- | --- | --- |
| 38 | `enabled` | boolean / `true` | 停用后工具立即报错 |
| 39 | `binaryPath` | string / `''` | cw 可执行路径；留空优先 PATH 里的 `cw`，再退插件自带 `bin/cw(.exe)`（探测顺序见 `index.js:82-102`） |
| 40 | `batchProvider` | string / `''` | 编译模型提供商（宿主模型设置里的 provider id）；**空 = 走内置百炼兼容通道**，非空 = 走宿主 `llm.stream()` |
| 41 | `batchModel` | string / `'qwen3.7-flash'` | 编译模型（规划/写文章/横切/审校/合成全部环节共用）；`batchProvider` 为空时是百炼模型名，非空时是该 provider 的模型 id |
| 42 | `batchApiKey` | string / `''` | 百炼 API Key 覆盖值（存量字段，设置页已不再渲染）；留空自动取模型设置「阿里百炼云」渠道凭证 |
| 43 | `batchThinkingBudget` | number / `0` | 0 = 关思考；1~32768 = 开启并限预算。**仅百炼通道生效**，宿主 provider 通道用该 provider 自己的 `reasoningEffort` |
| 44 | `maxConcurrency` | number / `8` | 编译请求并发上限 1–8，`liveConfig` 里 clamp 到 `CONCURRENCY_HARD_CAP`（`index.js:22`） |
| 45 | `articleLanguage` | string / `'中文'` | wiki 文章书写语言 |
| 46 | `updateReminder` | boolean / `true` | 会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 `CodeWiki.md`） |
| 47 | `excludePaths` | string / `''` | 排除清单：换行/分号/逗号分隔的绝对路径，命中即拒绝编译（schema 见 `index.js:47`，判定函数 `index.js:226-238`） |
| 48 | `autoUpdate` | boolean / `false` | 自动更新：定时扫描历史工作区并提交 scope=auto 增量编译（调度器 `index.js:2824-2846`） |
| 49 | `autoUpdateMin` | number / `30` | 自动更新扫描间隔（分钟），`liveConfig` 里下限 5 |
| 50 | `workspaceOnly` | boolean / `true` | 任务页/总览页只显示属于已添加 dsh 工作区的任务 |

`liveConfig(config)`（`index.js:57-76`）是配置的唯一解包口径，任何执行路径都必须先过它：

- 59-69：`maxConcurrency` 经 `Number()` 后 clamp——非有限或 `< 1` 落回硬顶 8，否则 `Math.min(n, 8)`。
- 64：`batchModel` 空字符串回落到 `'qwen3.7-flash'`。
- 66：`batchThinkingBudget` 双向 clamp 到 `[0, 32768]`，非法值归 0。
- 70：`articleLanguage` 空值回落 `'中文'`。
- 73：`autoUpdateMin` 下限 5（`Math.max(5, ...)`）。
- 74：`workspaceOnly` 只在显式 `=== false` 时关闭（默认开）。
- 注意：`batchApiKey` 由 `liveConfig` 解出后**不落盘**——job 记录里剥掉，`apiKeyOf`（`index.js:1310-1317`）内存缓存优先、进程重启后重新解析。

`val(x)`（`index.js:53-55`）处理 schemastery 的 `Value` 包装：带 `.get()` 的取 `.get()`，否则原样返回，这使 `liveConfig` 对 mock ctx 与真实宿主都成立。

### `client.js` 设置表单：`CodewikiCard`（`client.js:406-688`）

插件页 CodeWiki 详情页的完整表单，是配置的唯一图形入口。

- **数据来源**：`form = ctx.configForms.get(NS)`（`client.js:371` 取 form，`client.js:409` 首次 getSnapshot），`form.getSnapshot()` 拿快照（含 `value`、`revision`、`status`、`writable`），`form.mutate(ops, revision)` 写回。
- **模型目录**（`client.js:413-429`）：挂载即 `apiGet(MODELS_PATH)`（`/api/codewiki/models`，`client.js:24`）；`data.ok === false` 时记 `catalogError` 并降级为手填（423 行），请求失败同样只记错不阻断（427 行）。
- **快照订阅**（`client.js:432-449`）：`pull()` 里只有 `snap.revision !== lastRevision` 才用 `structuredClone`（442 行）覆盖草稿——避免每轮订阅回调把用户正在编辑的内容冲掉。
- **摘要视图**（`client.js:452`）：`props.view === 'summary'` 直接返回一行简介，插件列表项用。
- **`setPath`**（`client.js:454-461`）：单字段写入，同样 `structuredClone` 后改，保持不可变更新。
- **`dirty`**（`client.js:463-466`）：用 `JSON.stringify(draft) !== JSON.stringify(snapshot.value)` 做深比较，决定保存/撤销按钮可用性。
- **`selectedProvider`**（`client.js:469-473`）：从目录里按 `draft.batchProvider` 查条目，未命中即 null（手填形态）。
- **`save()`**（`client.js:475-502`）：
  - 477-481：`maxConcurrency` 必须是 1–8 的整数，否则 `invalidConcurrency`；
  - 482-486：`batchThinkingBudget` 必须是 0–32768 的整数，否则 `invalidBatchThinking`；
  - 488-493：**逐字段**比较 `['enabled','binaryPath','maxConcurrency','articleLanguage','updateReminder','workspaceOnly','batchApiKey','batchProvider','batchModel','batchThinkingBudget','excludePaths','autoUpdate','autoUpdateMin']`，只为变化的字段生成 `{op:'set', path:[key], value}`——**新增 Config 字段必须加进这个数组**，否则设置页改不动它；
  - 496-498：`form.mutate(ops, snapshot.revision)`，`accepted` 为假即 revision 冲突（他人改过），提示 `conflict`。
- **`discard()`**（`client.js:504-508`）：回填快照值并清空提示。
- **渲染布局**：
  - 517-571「运行」节：`enabled`（Switch，520-528）、`updateReminder`（529-537）、`workspaceOnly`（538-546）、`maxConcurrency`（547-555）、`articleLanguage`（556-561）、`binaryPath`（562-570）。
  - 574-644「编译模型」节：`batchProvider` 下拉（578-606，首项 `batchProviderBuiltin` 为空值 = 内置百炼通道，598；目录里没有但已配置的 provider 保留一个 `__custom` 选项防止静默丢失，601-603）；`batchModel`（607-633，有目录且有模型 → 下拉，否则 Input 手填；切换 provider 时把 model 自动带成该 provider 首个模型或清空，589-596）；`batchThinkingBudget`（634-642）。
  - 646-678「调度与排除」节：`autoUpdate`（649-657）、`autoUpdateMin`（658-666）、`excludePaths` 多行 textarea（667-676）。
  - 680-686 保存条：撤销 / 保存 / 错误红字或「已保存」标签。

### `client.js` 面板：`CodewikiPanel` / `ReposTab` / `PanelIcon`

- `CodewikiPanel`（`client.js:972-1172`）：三标签页 `overview` / `tasks` / `settings`（`client.js:1134-1141`）。轮询 `apiGet(JOBS_PATH)`（`/api/codewiki/jobs`）每 `POLL_MS = 2000`（`client.js:22`）一次，`inFlight` 守卫防重叠（`client.js:989`）；`sparkRef`（`client.js:980`）存每个 job 最近 30 个 tps 采样画微趋势线，`batchRateRef`（`client.js:981`）用 `rate = prev*0.6 + inst*0.4` 的 EWMA 算批量完成速率（`client.js:1009`）。取消走 `apiPost(CONTROL_PATH, {action:'cancel', jobId})`（`client.js:1033`）。`settings` 标签页内嵌 `el(CodewikiCard)`（`client.js:1143`）——**同一组件两处挂载**（插件页 + 面板）。
- `ReposTab`（`client.js:827-970`）：轮询 `/api/codewiki/repos`（`client.js:840`），间隔 `REPOS_POLL_MS = 10000`（`client.js:25`）。`toggleExclude`（`client.js:857-875`）把仓库路径并入/移出 `excludePaths` 配置（同样是 `form.mutate` 单层 op，866 行），成功后 `apiPost(CONTROL_PATH, {action:'refresh'})` 让服务端 30s 缓存失效（868 行）；`compile`（`client.js:877-885`）发 `{action:'compile', cwd}`。调度卡展示 `autoUpdate`/`autoUpdateMin`、上次扫描时间、下次扫描倒计时与扫描统计（`client.js:892-919`）。
- `PanelIcon`（`client.js:1174-1185`）：16×16 内联 SVG（摊开的书），侧边栏入口图标。
- 常量与注册：`NS`/`KEY`（17/18）、`JOBS_PATH`（19）、`CONTROL_PATH`（20）、`PANEL_ORDER = 52`（21）、`POLL_MS`（22）、`REPOS_PATH`（23）、`MODELS_PATH`（24）、`REPOS_POLL_MS`（25）、`ACTIVE_STAGES`（26）；`inject: ['slots','locale','configForms']`（365）；`plugins.item` 注册（374-381，`order: 30`）；`main` + `sidebar.panellist` 双 slot（391-397，`id` 必须等于 `main` 的 `key`）；中英词典 `zh()`（28）/`en()`（144）；样式表注入（261-341）；格式化与绘图工具 `fmtMs`（705）、`fmtTok`（712）、`fmtDur`（718）、`fmtAgo`（724）、`Spark`（729）、`stepName`（745）、`lastTimedStage`（746）、`stageBar`（750）、`overallPct`（775，权重表 `STAGE_WEIGHTS` 在 774）、`throughputBadge`（786）、`usageLine`（808）。

### `README.md`（根目录，65 行）

面向使用者的文档，结构固定：

- 1-3：标题 + 一句话定位（上游 Rust CLI `cw` + `<repo>/.codewiki/` 随仓库提交）。
- 5-13：工具表——`cw`（9）、`codewiki_generate`（10）、`codewiki_update`（11）、`codewiki_progress`（12）、CodeWiki 设置页（13）。
- 15-22：codewiki_generate 关键行为（scope=auto 三态、provider/model 成对传入、失败降级策略、scope=full 强制全量）。注意第 20 行「写文章并发上限硬顶 2」与第 21 行「经注入的 subagents 服务派发」均已过期：0.4.0 起零子代理、硬顶 8（`index.js:22`）。
- 24-38：设置小节。26 行说明设置也可在插件页详情页改、0.9.1 起「编译模型」是两级下拉且目录来自 `/api/codewiki/models`；28-30 行是 `batchProvider` / `batchModel` / `batchApiKey` / `batchThinkingBudget` 的通道归属规则；32-37 行是 `binaryPath`、`defaultProvider` / `defaultModel`（wiki 档 `aliyun-bailian` / `qwen3.8-flash`）、`defaultReasoningEffort`、`maxConcurrency`、`articleLanguage`、`updateReminder`——**其中三项 `default*` 已不在 Config 里**，同属历史残留；38 行「所有设置 volatile，改完即生效」仍准确。
- 40-55：安装（本地 file:/// 直挂五步，含 profile patch 片段 47-52、junction 依赖 54、重启生效说明 55）。
- 57-65：开发（vendor / bin / client.js 目录说明 59-63；验证命令 65：`node --check index.js client.js` 与 `node test-orchestration.mjs`）。

### `CodeWiki.md`（根目录，63 行）

本项目自身的 wiki 入口（遵循 `<repo>/CodeWiki.md` 公约），由 `ensureWikiEntry`（`index.js:188-221`）在缺失时补建（中文文案 194-205、英文文案 207-218），已存在则永不覆盖（191 行 `existsSync` 早退）。内容结构：Overview（7）、Key Components（9-27，逐条列出 index.js 的函数族与 client.js 的组件）、Architecture（29-45 的 text 围栏框图）、Data Flow（47-49 四流）、Connections（51-54 两条 backlink）、Known Issues（56-63 六条）。

### `CHANGELOG.md`（根目录，487 行）

按版本倒序的决策史，是「为什么这样写」的第一信息源。最近三节：

- 0.9.1（3-13）：设置页编译模型改为可选配置文件中的 provider/model。四项实现分别对应 `listModelCatalog`（8 行）、`/api/codewiki/models`（9 行）、调用链分流 `llmChat` vs `bailianChat`（10 行）、设置页两级下拉（11 行）。
- 0.9.0（15-27）：超 32k 文章转会话通道——`prepareArticleTasks` 返回值由 `{prepared, oversized}` 改为 `{prepared, sessionTasks}`（20 行），新增 `SESSION_TASK_TIMEOUT_MS` / `SESSION_TASK_DIR` / `classifySessionTask`（21 行），`dispatchSessionTasks` / `progressSessionTasks` / `resendSessionSteer` 三函数（22 行）。
- 0.8.8（29-38）：行号锚点确定性自动修正 `fixAnchors`（34 行），集成点在 `applyTaskResult` 与 `writeValidated`（35 行）。

其余版本（40-486 行，0.8.7 → 0.1.0）涵盖 numberLines 行号前缀（45）、主模型规划修复（58-59）、超预算观察批 map-reduce（82-84）、schema `type` 数组导致四工具全消失（105-107）、服务化全批量（351）等。

### `.gitignore`（根目录，12 行）

运行期产物与构建产物的边界：

- 1 `node_modules/`；2 `vendor/codewiki/target/`（Rust 构建产物）；3 `*.log`；6 `bin/*.bak-*`（cw 二进制备份，上游更新失败后的恢复安全网，见 CHANGELOG 0.5.0.2）；8 `.orch-test-out.txt`；9 `.probe3.txt`；12 `.dsh-ops/`（DSH 运行期产物：面板会话流、工具调用记录）。

**注意 `.codewiki/` 不在忽略列表**——wiki 必须随仓库提交，这是「活 wiki」可共享的前提。

### 自检脚本

`test-batch.mjs`（纯函数与单端点，不启动服务）：

- 分区：`estimateTokens`（22-27）、`collectSources`（29-43）、`numberLines`（45-50）、`prepareArticleTasks`（52-81）、多文件超预算观察批分割（83-101）、`classifySessionTask` 三态（103-119）、`runRealtimeTasks` 百炼通道（121-147）、思考参数与 tps 采样（149-159）、外部 signal 中止（161-171）、并发池失败记账（173-198）、`localPlan`（200-211）、`packArticles`（213-224）、`scanRepoFiles`（226-245）、宿主 llm 通道（247-286）、`listModelCatalog`（288-310）、`GET /api/codewiki/models` 端点（312-340）、`resolveBatchApiKey`（342-363）、`fixAnchors`（365-413）。
- 骨架：`check(cond, msg)`（15）累加 `passed` / `failures`，收尾 `process.exit(failures ? 1 : 0)`。

`test-orchestration.mjs`（1152 行，编排冒烟，mock ctx + 真实 cw CLI）：

- 脚手架：`check`（23）、`JOBS_FILE` 环境隔离（28）、`makeCtx`（34）、`makeMockAgent`（83）、`makeFixtureRepo`（99）、`makeBatchMock`（113）、`fakeReq` / `fakeRes`（186 / 196）。
- 场景块与起始行：系统提示提醒（201）、注册（232）、cw 工具（245）、`codewiki_update` + `commitHintText`（252）、`wakeCompileSession`（331）、主模型规划（359）、全量编译阶段机（510）、横切精准拆分（542）、文章观察→合成分割（572）、全程普通端点（606）、stale 逐篇更新（639）、`codewiki_progress`（662）、重启按 prompt 快照重跑（698）、并发提交占位与 flush 合并（755）、面板端点与取消（794）、排除清单 / repos / compile（848）、knownRepos 与 refresh（903）、工作区过滤（943）、注册表异常降级（990）、输出 schema 校验（1020）、孤儿任务接管（1060）、无凭证诚实报错（1094）、严格 cordis 语义（1106）、Temp 残留清理（1130）。

## Architecture

```text
┌─────────────────────── 配置的四层表示 ───────────────────────┐
│ package.json:20-27   dsh.client.platform / dsh.bundle.patch   │
│        │（宿主扫描）                                          │
│        ▼                                                      │
│ cordis.patch.yml:12-15  insert: id=codewiki → index.js         │
│        │                                                      │
│        ▼                                                      │
│ index.js:37  Config (z.object, 13 字段, 全 volatile)           │
│        │                                                      │
│        ├──► index.js:57  liveConfig()  ← 每次 execute/tick 解包│
│        │        │  clamp: concurrency≤8, thinking 0~32768     │
│        │        ▼                                             │
│        │   runCw / 批量通道 / installWebServer（消费端）        │
│        │                                                      │
│        └──► client.js:371 configForms.get('codewiki')         │
│                 │ getSnapshot / mutate(ops, revision)         │
│                 ▼                                             │
│            CodewikiCard:406 设置表单（插件页 + 面板两处挂载）   │
│                 │ 字段白名单 client.js:489                     │
│                 ▼                                             │
│            README.md:24-38 人工文档（须与 Config 同步）         │
└───────────────────────────────────────────────────────────────┘

  client.js:19/20/23/24 ──HTTP(仅回环)──► index.js:2526 installWebServer
      /api/codewiki/jobs     GET  → service.list()（workspaceOnly 过滤）
      /api/codewiki/repos    GET  → cw status 现算 + 30s 缓存 + scheduler
      /api/codewiki/models   GET  → listModelCatalog(llmRef)（30s 缓存）
      /api/codewiki/control  POST → cancel / refresh / compile
```

## Data Flow

1. **配置流**：`cordis.patch.yml:12-15` 或 profile patch 的 `config: {}` → Cordis 注入 `apply(ctx, config)`（`index.js:2809`）→ 每次执行前 `liveConfig(config)`（`index.js:57`）解包 volatile 值 → 落到 `resolveBinary`（82）、`resolveBatchApiKey`（546）、`installWebServer`（2526）等消费点。因为每次调用都重新解包，改配置无需重启。
2. **设置页写入流**：`CodewikiCard` 挂载 → 拉 `/api/codewiki/models` 得 provider 目录（`client.js:420`）→ 用户编辑 `draft` → `dirty` 深比较 → `save()` 生成单层 `{op:'set'}` 数组（`client.js:488-493`）→ `form.mutate(ops, revision)` CAS 写入 → 宿主持久化 + 热生效 → `pull()` 收到新 `revision` 回填草稿（`client.js:440-444`）。
3. **模型目录发现流**：`GET /api/codewiki/models`（`index.js:2673`）→ 30s 进程内缓存（2679）→ `listModelCatalog(llmRef)`（`index.js:2503`）→ `llm.listProviders()` 逐 provider `llm.listModels(id)` → 单 provider 失败只附 `error` 不拖累整份目录 → `{ok:true, providers:[{id,name,models:[{id,name}]}]}`。`llm` 未注入时返回 `{ok:false}`，设置页据此降级为手填。
4. **文档补建流**：编译收尾 → `ensureWikiEntry(job.cwd, language)`（`index.js:188`）→ `CodeWiki.md` 不存在则按语言写模板（194-218），存在则原样保留。
5. **提醒注入流**：`installUpdateReminder`（`index.js:2775`）在 `agent/created`（2806）与存量 `agents.list()`（2800-2804）上为每个 agent 注册系统提示 section `codewiki:update-reminder`（`index.js:2784-2794`）；`text` 回调每次组装时求值——`updateReminder === false`、会话 cwd 缺失、或仓库根无 `CodeWiki.md` 时返回空串（2788-2790）；否则拼 `reminderText(cwd)`（2764-2773）与 `commitHintText(cwd)`（2737-2762）的结果。`commitHintText` 比较「最近一次成功编译的 `finishedAt`」与 `git log -1 --format=%ct -- .codewiki CodeWiki.md`（2747）的时间戳，产物未入库才注入提交提醒；60s TTL 缓存（2736 / 2740 / 2760），提交后时间戳反超自动静默。

## Connections

- [[codewiki-upstream]] — 上游 `mraza007/codewiki`（MIT），提供 Rust CLI `cw` 与 `<repo>/.codewiki/` 布局约定；`vendor/codewiki/` 为其去 `.git` 的本地 fork。
- [[plugin-orchestration]] — `createJobService`（`index.js:1192`）驱动的六阶段状态机，本文的配置项（并发、模型通道、思考预算、语言、排除清单、自动更新）全部在那一侧消费。
- [[web-panel]] — `client.js` 面板与端点的消费方（`CodewikiPanel` / `ReposTab`）。
- [[bailian-inference]] — `batchProvider` 留空时的默认推理通道（百炼 OpenAI 兼容 `chat/completions`）。
- [[dsh-harness]] — 宿主：Cordis 插件系统、`configForms`、`webServer`、`workspaceRegistry`、`llm` 服务与 `systemPrompt` section 机制。

## Known Issues

1. **插件注册不热加载**：改 `index.js` 或 profile patch 后必须重启 dsh（配置值本身热读）。`client.js` 同理——宿主「非 client 包」判定按 Loader 条目缓存，`package.json:21-23` 的 `dsh.client` 声明新增后也需重启才会把 `client.js` 送进浏览器。
2. **Junction 依赖**：`@deepseek-ai/schemastery`（`package.json:18`，仅供 `Config` 用）靠插件本地 junction → `/e/software/deepseek-harness/vendor/schemastery`；换机器需重建。
3. **文档与配置存在历史漂移**：`defaultProvider` / `defaultModel` / `defaultReasoningEffort`（`cordis.patch.yml:6-8`、`README.md:33-34`）已不在 `index.js:37-51` 的 `Config` 中；`cordis.patch.yml:9` 与 `README.md:20` 的「并发硬顶 2」与 `CONCURRENCY_HARD_CAP = 8`（`index.js:22`）矛盾；`README.md:21` 描述的「子代理派发」在 0.4.0 服务化后已废弃。以 `Config` 与 `client.js:489` 的字段白名单为准。
4. **新增 Config 字段要改四处**：`index.js:37-51`（schema）、`index.js:57-76`（`liveConfig` 解包）、`client.js:489`（保存字段白名单）、`README.md:24-38`（人工文档）。漏掉 `client.js:489` 的表现是「面板/设置页改不动，但配置文件手改有效」。
5. **上游 `cw` 无 `--version`**；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，见 `wikiPathFor`，`index.js:994` 起）。
6. **路径形态差异**：上游 stale 文章路径输出反斜杠（`modules\app.md`），插件消费侧已由 `normalizeArticlePath`（`index.js:141`）/ `normalizeIndexLinks`（`index.js:145`）归一为 `/`。
7. **断点语义收敛**：断点文件仅记录阶段机位置（`stage` / `crosscutSplit`），重跑走普通入口同步请求；0.5.x 批量的 24h 窗口语义已随 0.6.0 删除。
8. **会话通道依赖发起会话**：`job.sessionId` 为空（面板提交 / 自动调度）时，超预算文章与校对任务直接整体失败并明示原因，不退超大兜底、不静默跳过校对；超时默认 30 分钟（`index.js:1020`，`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调）。
9. **维护提醒依赖 `CodeWiki.md` 与 git**：`reminderText` 在仓库根无 `CodeWiki.md` 时整段不出现（`index.js:2790`），所以入口文件被误删等于关掉整个维护提醒；`commitHintText` 在非 git 仓库或 `git log` 失败时一律不提醒（`index.js:2759` 的 catch）。
