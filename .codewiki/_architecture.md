---
title: System Architecture Overview
type: architecture
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [架构, 系统总览, codewiki, dsh-codewiki, 模块连接]
---

## Overview

本文件为 `@local/dsh-codewiki` 插件（版本 0.10.11，见 `package.json:2`）的系统总览，专为零上下文的未来 agent 编写。插件把 Rust CLI `cw`（来自 `mraza007/codewiki`）接入 DeepSeek Harness，提供代码 wiki 的编译、更新与进度查询能力。仓库由四个逻辑部分构成：核心实现与配置（`index.js`/`client.js` 等，下称 core-and-config 模块）、文档与元信息（`README.md`/`CodeWiki.md`/`CHANGELOG.md` 等）、测试脚本（`test-*.mjs`）以及测试/监听日志（`.tmp-test-*.log` 与 `watcher2.log`）。整体以 cordis 插件机制挂载（`cordis.patch.yml:13` 的 `insert`，id `codewiki` 在 `cordis.patch.yml:14`），全部模型调用经宿主 `llm` 服务完成（`index.js:288` 的 `llmChat`），编译由宿主常驻服务以阶段机推进（`index.js:1238` 的 `createJobService`），零子代理。当前版本的关键形态：规划阶段已删除（0.10.7，模块清单由 `localPlan` 本地分组，`index.js:685`）；110k–420k 输入自动升大档单请求（0.10.8，默认 `volces-ark`/`glm-5.3-flash`，`index.js:288-291`）；编译产物提交在 0.10.11 升级为阶段机里的独立 commit 阶段，走「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（`autoCommitWiki`，`index.js:2948`；`STAGE_HANDLER` 新增 `commit: tickCommit`，`index.js:2060-2067`）。

## System Overview

系统组件与职责连接的总框图如下：

```text
┌───────────────────────┐    ┌───────────────────────┐
│ docs-and-meta         │    │ logs-and-temp         │
│ (README/CodeWiki/     │◄───│ (.tmp-test-*.log 等)  │
│  CHANGELOG)           │验证│                       │
└───────────┬───────────┘    └───────────┬───────────┘
            │ 描述/配置约定               │ 测试产出
            ▼                            ▼
┌───────────────────────┐    ┌───────────────────────┐
│ core-and-config       │◄───│ test-scripts          │
│ (index.js/client.js)  │导入│ (test-*.mjs)          │
└───────────┬───────────┘    └───────────────────────┘
            │ 经 cordis.patch.yml file:/// 挂载
            ▼
┌───────────────────────┐
│ DeepSeek Harness 宿主 │
│ (llm/webServer/agents)│
└───────────────────────┘
```

`core-and-config` 模块是系统运转中枢：`index.js:3110` 的 `apply` 注入 `tools`/`webServer`/`llm`/`agents`（`index.js:3111-3112`）并注册全部工具与端点；`docs-and-meta` 为其提供人机接口说明与配置约定；`test-scripts` 直接 `import './index.js'`（`test-batch.mjs:7`、`test-orchestration.mjs:24`）验证契约；`logs-and-temp` 收集测试与 watcher 输出以供排查。

## Data Flow

请求与数据在模块间的流动路径如下：

```text
┌──────────┐ codewiki_generate ┌──────────────┐ cw status ┌─────────┐
│ 会话/面板 │──────────────────►│ JobService    │──────────►│ cw CLI  │
│ (agent/  │◄──────────────────│ (createJob-   │◄──────────│ (bin/cw)│
│  client) │ jobId/stage 即回  │  Service)     │ 判态/落盘  └─────────┘
└────┬─────┘                   └──────┬────────┘
     │ GET /api/codewiki/jobs         │ tick 阶段机（articles→…→index→commit）
     ▼                                ▼
┌──────────┐  runRealtimeTasks ┌──────────────┐  llmChat   ┌─────────┐
│client.js │──────────────────►│ 并发池/收割   │───────────►│ 宿主 llm │
│ (面板)   │◄──────────────────│ (startBatch- │◄───────────│ 服务     │
└──────────┘  2s 轮询渲染       │  ChatRun)    │ 流式结果    └─────────┘
                               └──────┬────────┘
                                      │ fixAnchors 校正后落盘
                                      ▼
                        ┌────────────────────────┐
                        │ autoCommitWiki: 主题分支 │
                        │ codewiki/wiki-<jobId>   │
                        │ 提交→合并回原分支→删分支  │
                        └────────────────────────┘
```

1. 会话内调用 `codewiki_generate`（`index.js:40` 定义，execute 在 `index.js:40`）：`normalizeCwd`（`index.js:40`）→ 排除清单校验（`excludedItem`，`index.js:252`）→ `cw status` 判态（`parseStatus`，`index.js:181`）→ 预构建任务后经 `submit`（`index.js:2148`）创建 job 并立即返回 `{submitted, jobId, stage}`；`scope=auto` 在 clean 态直接报告，stale 态逐篇直达 articles。`codewiki_update`（`index.js:40`）是固定 `scope=auto` 的包装。
2. 后台 `tick`（`index.js:2069`，默认 10s）推进阶段机 `articles→crosscut→（超预算时 compose）→review→index→commit`（`STAGE_HANDLER`，`index.js:2060`，commit 行在 `index.js:2066`）。单项目串行闸门每 tick 先算 `activeId`（`index.js:2069-2075`）。文章阶段在 `tickArticles`（`index.js:1619`）开头就地 `localPlan`（按顶层目录分组）→ `prepareArticleTasks`（`index.js:560`，普通预算 `BATCH_TOKEN_BUDGET`=110k，`index.js:374`；装填上限为大档预算 420k 或 128k 硬上限 `BATCH_TOKEN_HARD_LIMIT`，`index.js:379`；仅单文件连大档都装不下才转会话通道 `dispatchSessionTasks`，`index.js:1537`）。
3. 每个请求经 `llmChat`（`index.js:288`）走宿主 `llm.stream()`，模型由 `batchProvider`/`batchModel` 决定（默认 `workbuddy`/`hy3`，`index.js:26-27`），插件不保存任何密钥；结果由 `fixAnchors`（`index.js:401`）机械校正行号锚点后经 `writeValidated`（`index.js:1382`）落盘 `<repo>/.codewiki/`。
4. `index` 阶段（`tickIndex`，`index.js:2010`）执行 `cw index` + `cw meta update`（`index.js:2014-2015`）并自动补建 `CodeWiki.md` 入口（`ensureWikiEntry`，`index.js:214`，调用在 `index.js:2023`）；有产物且 `autoCommit` 开启时 `setStage('commit')` 提前返回（`index.js:2033-2035`），不再就地提交。
5. `commit` 阶段（`tickCommit`，`index.js:2042`）：`autoCommitWiki`（`index.js:2948`）先建主题分支 `codewiki/wiki-<jobId>`（`index.js:2988-2989`），在其上 `git add -- .codewiki CodeWiki.md` + `git commit --no-verify`（`commitOn`，`index.js:2979-2991`；pathspec 由 `WIKI_PATHS` 常量唯一定义，`index.js:36`），再切回原分支 `git merge --no-edit` 合并（`index.js:2988`）并 `git branch -d` 删主题分支（`index.js:2988`）。安全前置（非 git 仓库/无 HEAD/merge 中/冲突/被 `.gitignore` 忽略/缺 `user.name`，`index.js:2959-2976`）在分支切换之前执行；detached HEAD（`index.js:2988-2991`）或建分支失败（`index.js:2988-2990`）降级为直接提交（`mode:'direct'`）；合并失败 → `git merge --abort`（`index.js:2988`）保留主题分支。提交后才置 done/finishedAt 并唤醒会话（`index.js:2988-2990`）；中途死在 commit 阶段的任务重启后重跑本阶段，`autoCommitWiki` 对已入库产物报 noChanges，幂等。
6. 唤醒与提醒共用一份三态判定 `autoCommitState`（`index.js:1214`）：`wakeCompileSession`（`index.js:1221`）在 committed/no-changes 时直接静默（`index.js:1225`），只有 failed 或 pending 才 steer 一次「产物待提交」（`index.js:1214-1216`）；系统提示 section 的 `commitHintText`（`index:3032` 处定义，即 `index.js:3032`）走同一判定。面板侧 `ACTIVE_STAGES` 含 `commit`（`client.js:28`），进度权重 commit 0.02（`client.js:947`），阶段文案「提交产物中」（`client.js:28`），任务卡自动提交成功行追加主题分支名（`client.js:1258`）。
7. `client.js` 的 `CodewikiPanel`（`client.js:1145`）每 2s（`POLL_MS`，`client.js:22`）轮询 `GET /api/codewiki/jobs`（`index.js:2729`），总览页 `ReposTab`（`client.js:1000`）轮询 `GET /api/codewiki/repos`（`index.js:2751`，30s 缓存），取消与一键编译经 `POST /api/codewiki/control`（`index.js:2884`）。
8. 测试脚本（test-scripts）导入 `index.js` 驱动相同流程（mock 宿主 `llm` 服务 + 真实 `cw` CLI），断言结果留痕于 logs-and-temp 的 `.tmp-test-*.log`。

## Dependency Graph

各模块间的依赖方向（箭头表示「依赖于」或「被描述/验证于」）：

```text
┌──────────────────┐       ┌──────────────────┐
│ docs-and-meta    │◄──────│ core-and-config  │
│ (描述契约)        │ 描述   │ (实现插件)        │
└──────────────────┘       └────────┬─────────┘
                                    │ import ./index.js
                                    ▼
                          ┌──────────────────┐
                          │ test-scripts      │
                          │ (test-*.mjs)      │
                          └─────────┬─────────┘
                                    │ 产出
                                    ▼
                          ┌──────────────────┐
                          │ logs-and-temp    │
                          │ (.tmp-*.log 等)  │
                          └──────────────────┘
```

- `core-and-config` 的配置字段语义由 `docs-and-meta` 定义：`Config` schema（`index.js:51`）与 README 设置段（`README.md:56` 起）逐项对应（`batchProvider`/`bigProvider`/`autoCommit` 等；`autoCommit` 语义在 `README.md:39`）。
- `test-scripts` 强依赖 `core-and-config` 的导出：`test-batch.mjs:7` 导入 `collectSources`/`prepareArticleTasks`/`runRealtimeTasks`/`localPlan`/`fixAnchors` 等纯函数，`test-cwd-paths.mjs:20` 调 `apply`，`test-wiki-entry.mjs:10` 导入 `ensureWikiEntry`/`parseStatus` 等。
- `logs-and-temp` 被动依赖 `test-scripts` 与 watcher 进程产生内容（如 `.tmp-test-orchestration.log:1` 来自编排测试）。
- `cordis.patch.yml:13-14` 把 `index.js` 挂载为 id `codewiki`；`package.json:2` 的 `dsh.client.platform: "web"` 让宿主沿 file:/// 条目发现 `client.js`。

## Module Roles

各模块在系统中的具体职责与关键连接点：

### docs-and-meta（`README.md`, `CodeWiki.md`, `CHANGELOG.md`, `.probe3.txt`）

- **职责**：`README.md` 提供工具清单与设置字段定义（工具表 `README.md:11-15`，其中 `codewiki_generate` 行在 `README.md:10`、`codewiki_update` 在 `README.md:11`、`codewiki_progress` 在 `README.md:12`；设置段 `README.md:11` 起，`autoCommit` 三态与安全边界在 `README.md:39`）；`CodeWiki.md:3` 是插件自身的 wiki 入口，`CodeWiki.md:65` 声明上游连接 `[[codewiki-upstream]]`（布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`）；`CHANGELOG.md:3` 起记录版本演进——0.10.11（`CHANGELOG.md:5-15`）把产物提交升级为独立 commit 阶段并改走主题分支合并，0.10.10 修三态语义与测试竞态，0.10.9 引入 autoCommit，0.10.7 删规划阶段，0.10.4 引入大档模型；`.probe3.txt:1` 只是单行 `probe`——探测文件。
- **连接**：以纯文本形式描述 `core-and-config` 的行为契约；README 安装段（`README.md:44-46`）明确 file:/// 直挂不需要 profile link。

### core-and-config（`index.js`, `client.js`, `cordis.patch.yml`, `package.json`, `.gitignore`）

- **职责**：`index.js` 是插件唯一核心实现（Node ESM 单文件）：`Config`（`index.js:51`，全部 `.volatile()` 热读取）；四个工具 `cw`（`index.js:51`，子命令白名单 `CW_SUBCOMMANDS` 在 `index.js:20`）、`codewiki_generate`（`index.js:51`）、`codewiki_update`（`index.js:51`）、`codewiki_progress`（`index.js:51`）；宿主常驻服务 `createJobService`（`index.js:1238`）含阶段执行器 `startBatchChatRun`（`index.js:1459`）、批量校对收割 `settleProofread`（`index.js:1426`）、会话通道派发/收割（`index.js:51`/`index.js:51`）与编译终态唤醒 `wakeCompileSession`（`index.js:1221`）；自动提交三态判定 `autoCommitState`（`index.js:1214`）与提交边界 `autoCommitWiki`（`index.js:2948`）；webServer 端点 `installWebServer`（`index.js:2686`，四个精确端点 + 模型目录 `listModelCatalog` 在 `index.js:2624` 与思考档位 `resolveModelEfforts` 在 `index.js:2662`）；入口 `apply`（`index.js:3110`）。`client.js` 提供浏览器半侧：设置卡片 `CodewikiCard`（`client.js:460`）、侧边栏面板 `CodewikiPanel`（`client.js:1145`）与总览页 `ReposTab`（`client.js:1000`）、面板图标 `PanelIcon`（`client.js:1360`）。`cordis.patch.yml:13` 负责 bundle 挂载；`package.json:3` 声明版本 0.10.11，`package.json:18` 声明唯一运行时依赖 `@deepseek-ai/schemastery`，`package.json:15` 声明 `engines.dsh >=0.2.0-rc.0`；`.gitignore:3` 用 `*.log` 把测试日志（`.tmp-*.log`、`watcher2.log`）排除出 git（`bin/*.bak-*` 在 `.gitignore:3`）。
- **连接**：经 `cordis.patch.yml` 由宿主加载；调用宿主 `llm` 服务（`llmRef` 在 `index.js:1206`，`apply` 注入于 `index.js:3112`）与 `agents` 注册表（`agentsRef` 在 `index.js:1201`）；通过 `/api/codewiki/*` 与 `client.js` 通信；写盘 `<repo>/.codewiki/` 并由 `autoCommitWiki` 在主题分支上提交后合并回原分支。

### test-scripts（`test-batch.mjs`, `test-cwd-paths.mjs`, `test-orchestration.mjs`, `test-wiki-anchors.mjs`, `test-wiki-entry.mjs`）

- **职责**：五套互不重叠的回归测试。`test-batch.mjs` 验纯函数与端点（装填/分割、会话通道三态 `classifySessionTask`、宿主 llm 通道、`fixAnchors`、0.10.1 反向断言「不再导出 `resolveBatchApiKey`」在 `test-batch.mjs:451-454`）；`test-orchestration.mjs` 验服务编排（mock 宿主 llm 服务 `makeBatchMock` 在 `test-orchestration.mjs:138`，git fixture `makeFixtureRepo` 在 `test-orchestration.mjs:103`；0.10.11 的 `autoCommitWiki` 断言组在 `test-orchestration.mjs:405-506`——正常路径 `mode==='branch'` 且主题分支已删除（`test-orchestration.mjs:416-420`）、detached HEAD 降级直接提交（`test-orchestration.mjs:487-489`）、主题分支名被占用降级且预占分支不被误删（`test-orchestration.mjs:495-505`）、`autoCommitState` 三态单测在 `test-orchestration.mjs:508-518`；端到端补断言「走过独立 commit 阶段（stageTimings 含 commit）」与 `mode==='branch'` 在 `test-orchestration.mjs:138-139`）；`test-cwd-paths.mjs` 验 MSYS/Windows 路径三态（`test-cwd-paths.mjs:32` 起）；`test-wiki-anchors.mjs` 把行号锚点校验制度化，符号提取在 `symbolsOnLine`（`test-wiki-anchors.mjs:38`）；`test-wiki-entry.mjs` 验 `ensureWikiEntry`（`test-wiki-entry.mjs:26`）与路径规范化（`test-wiki-entry.mjs:56`）。
- **连接**：全部直接 `import './index.js'` 驱动真实实现；测试环境变量隔离（`test-orchestration.mjs:22-23` 用随机 token 命名 jobs 文件防 pid 复用污染，0.10.10 修复）；与 `docs-and-meta` 记录的契约互验。

### logs-and-temp（`.tmp-test-batch.log`, `.tmp-test-cwd-paths.log`, `.tmp-test-orchestration.log`, `.tmp-test-wiki-anchors.log`, `.tmp-test-wiki-entry.log`, `watcher2.log`）

- **职责**：保存历史测试运行输出与一次 jobs 状态监听记录。`.tmp-test-batch.log:1` 与 `.tmp-test-orchestration.log:1` 是旧版本代码的运行留痕（如 `.tmp-test-orchestration.log:114` 仍断言旧形态 `source=plugin/codewiki`，与当前 `plugin:codewiki` 已不同步），仅供排查历史回归用；`.tmp-test-wiki-anchors.log:1` 记录锚点校验的逐条结果；`.tmp-test-cwd-paths.log:1` 与 `.tmp-test-wiki-entry.log:1` 记录路径与入口测试的全过输出；`watcher2.log:1` 起是每 30ms 采样 jobs 文件的 watcher 日志，记录的 job 仍是旧格式 `plan` 阶段（`watcher2.log:1`），可佐证 0.10.7 之前的阶段机形态。
- **连接**：由 `test-scripts` 执行与 watcher 进程生成；被 `.gitignore:3` 的 `*.log` 规则排除出 git，不随仓库提交。

以上即为系统全貌：`core-and-config` 实现插件（编译流水线以独立 commit 阶段收尾，产物经主题分支合并入库），`docs-and-meta` 描述契约，`test-scripts` 验证契约，`logs-and-temp` 留存运行证据。未来 agent 可按模块角色与行号锚点快速定位代码、文档与测试。
