---
title: orchestration-tests
type: module
source_files:
  - test-orchestration.mjs
  - index.js
  - .tmp-test-orchestration.log
tags: [测试, 编排, 端到端, 冒烟测试, codewiki, 阶段机]
---

## Overview

`test-orchestration.mjs` 是 dsh-codewiki 插件的端到端服务化编排冒烟测试脚本，通过 mock 宿主 llm 服务（llm.stream 按 prompt 特征应答，插件零直连）、真实 cw CLI、真实服务 tick，验证 codewiki_generate 提交制、服务阶段机（articles→crosscut→review→index，0.10.7 起无规划阶段）、stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control）与取消、编译模型缺失诚实报错、单项目串行排队（0.10.0）、编译终态 steer 实时唤醒发起会话（0.8.0）、插件自动提交产物（0.10.9）等（`test-orchestration.mjs:1-6`）。

测试加速通过将 tick 间隔压到下限 300ms（生产默认 10s，`test-orchestration.mjs:32`）；使用独立 `JOBS_FILE` 与真实宿主服务实例隔离，避免互相洗写（`test-orchestration.mjs:32`，全局常量 `JOBS_FILE` 在 `test-orchestration.mjs:32`）。

## Key Components

### 常量与断言
- `failures` 计数与 `check(cond, msg)` 断言机制（`test-orchestration.mjs:26-30`）：失败累加并输出 ✗，结尾汇总退出码。
- `JOBS_FILE`：全局常量，引用隔离的 jobs 文件路径（`test-orchestration.mjs:32`）。
- `activeLlm` 与 `llmProxy`：mock 宿主 llm 服务转发机制；`activeLlm` 为当前生效假 llm，`llmProxy` 恒转发给它（`test-orchestration.mjs:125-133`）。
- `DSH_CODEWIKI_TICK_MS='300'`：测试加速环境变量（`test-orchestration.mjs:15`）。

### 动态导入与符号
- 动态导入 `./index.js` 获取 `{ name, apply }`（`test-orchestration.mjs:20`）；后续单测直接导入 `commitHintText`（`test-orchestration.mjs:293`）、`wakeCompileSession`（`test-orchestration.mjs:453`）、`autoCommitWiki`（`test-orchestration.mjs:379`）等。
- 插件名 `name === 'dsh-codewiki'`（`index.js:3048`），`apply` 为插件入口函数（注册工具与监听，`index.js:3048`）。

### 测试辅助函数
- `articleMd(title, source, marker='Batch-written', type='module')`：拼接含 frontmatter 的假文章 markdown（`test-orchestration.mjs:33-34`）。
- `batchCfg(extra={})`：返回 `{ batchProvider: 'workbuddy', batchModel: 'hy3', ...extra }`，对应 0.10.1 起编译模型必须显式指向模型设置里的 provider/model（`test-orchestration.mjs:38`）。
- `makeCtx({ agents=[], workspaces=null, brokenRegistry=false, agentGet=null, llm=null }={})`：mock 宿主上下文，返回 `{ ctx, registered, endpoints, listeners, disposers }`（`test-orchestration.mjs:44-84`）。
  - 内部 `services` 含 `webServer.register`（`test-orchestration.mjs:49`）、`agents`（支持 `agentGet` 或 `list`，`test-orchestration.mjs:47`）、`tools.register`（存入 `registered` Map，`test-orchestration.mjs:49`）、可选 `llm`（`test-orchestration.mjs:49`）。
  - `workspaceRegistry`：`workspaces` 映射为 list（`test-orchestration.mjs:51-52`）；`brokenRegistry=true` 时 `list()` 抛错（`test-orchestration.mjs:54-55`）。
  - `ctx.inject(deps, fn)`：支持带回调（传 ctx 切片）与 promise 风格（返回数组/单值，`test-orchestration.mjs:61-71`）。
  - `ctx.on(event, fn)` 收集监听（`test-orchestration.mjs:61`）；`ctx.effect(fn)` 立即执行并收集 disposer（`test-orchestration.mjs:61-65`）。
- `makeMockAgent(cwd)`：构造 `{ agent, sections }`，`agent.session.header.cwd` 与 `agent.ctx.inject` 用于注册 systemPrompt section（`getSectionOrder` 对 `TOOL_REPORT` 返回 2900，`test-orchestration.mjs:87-101`）。
- `makeFixtureRepo()`：建临时 git 仓库，写 `core/core.py`、`util/util.py` 并 init 提交（`test-orchestration.mjs:103-120`）。
- `makeBatchMock({ modules=['core','util'], articleMarker='Batch-written', stall=false, bigArticle=false }={})`：模拟宿主 llm 服务（替换 `activeLlm`/`llmProxy`），返回 `{ llm, llmCalls, batchPrompts(), realtimePrompts(), restore() }`（`test-orchestration.mjs:138-202`）。
  - 内部 `answerFor(prompt)`：按 prompt 特征分发（观察员/作者/架构观察员/总览/模式/概念/审校员，`test-orchestration.mjs:140-170`）。
  - `llm.stream` 复写：未知 prompt 返回默认（`test-orchestration.mjs:172-191`）；`stall=true` 时挂起至 `signal.abort`（`test-orchestration.mjs:173-180`）；`bigArticle=true` 追加 7 万字符（`test-orchestration.mjs:172`）。
- `waitJob(cwd, { timeout=30000 }={})`：轮询 `JOBS_FILE` 取该 cwd 最新 job 终态（done/failed/cancelled，`test-orchestration.mjs:205-218`）。
- `fakeReq(body, addr='127.0.0.1', method='POST')` 与 `fakeRes()`：mock HTTP 请求/响应（`test-orchestration.mjs:220-232`）。
- `validateOut` 同构校验器：在“工具输出 schema 形态”块内定义，验证 `codewiki_generate` 输出 schema（`test-orchestration.mjs:1183-1198`）。

### 测试覆盖块（顶级代码块，顺序执行验证行为）
以下块均在 `test-orchestration.mjs` 中，覆盖各类场景：
- 系统提示提醒（`test-orchestration.mjs:230-259`）：`apply(ctx, reminderConfig)` 后布线 `agent/created`；仅当仓库有 `.codewiki` 且根有 `CodeWiki.md` 时注入 `codewiki:update-reminder` section；`updateReminder=false` 或缺失文件时文本为空。
- 注册与 cw 工具（`test-orchestration.mjs:261-279`）：`name==='dsh-codewiki'`，注册 `cw`、`codewiki_generate`、`codewiki_progress`；`cw status` 判定 missing 态。
- `codewiki_update` 与 `commitHintText`（`test-orchestration.mjs:281-374`）：wrapper 单测强制 `scope='auto'`，错误前缀改写；`commitHintText` 按 git 提交时间与 `writtenCount` 决定提醒（依赖 60s cwd 缓存，用不同 fixture 绕开）。
- `autoCommitWiki` 单测（`test-orchestration.mjs:376-448`）：安全边界（只提交 `.codewiki/` 与 `CodeWiki.md`，非 git/忽略/合并中/缺 identity 均拒绝）。
- `wakeCompileSession`（`test-orchestration.mjs:450-482`）：done/failed 触发 steer，消息含标题/id/提交指引，`source.kind='plugin:codewiki'`（`index.js:1221`）；自动提交成功则零唤醒；无 sessionId/冷会话/异常静默不抛。
- 本地规划（0.10.7 删规划阶段）（`test-orchestration.mjs:484-541`）：唯一通道是宿主 llm 服务，不沿用会话主模型身份（全部请求按配置的 provider/model 发出，`test-orchestration.mjs:505-508`）；零规划请求；面板提交同路径。
- 全量编译（`test-orchestration.mjs:543-582`）：提交即返回 `stage=articles`；服务推进至 `done`；落盘 `modules/core.md`、`modules/util.md`、`_architecture.md`、`_patterns.md`；无概念文章（localPlan concepts 为空）；校对回写 `PROOFED`；插件自动提交产物（`index.js:2014-2020`）。
- 大 wiki 横切（`test-orchestration.mjs:584-612`）：`bigArticle` 触发 2 观察请求 + 合成批 reduce，合成不含原文。
- 大模块分割（`test-orchestration.mjs:614-648`）：每模块 15 个 100KB 源文件触发 10 观察批 + 2 合成请求。
- 单项目串行（`test-orchestration.mjs:650-697`）：`stall` 挂起 A，B 进 `queued` 且 `pendingStage=articles`；取消 A 后 B 自动轮到。
- 唯一通道与实时指标（`test-orchestration.mjs:699-731`）：所有请求走宿主 llm 服务（workbuddy/hy3，插件零直连）；jobs 端点透出 `tps`/`stageTimings`/`usage`。
- stale 逐篇更新（`test-orchestration.mjs:733-754`）：改 `core.py` 后 `scope='stale'` 直达 articles，仅更新声明了 core.py 的 2 篇（0.10.7 起无概念文章）。
- `codewiki_progress`（`test-orchestration.mjs:756-792`）：cwd/jobId 过滤，终态 `progress=100`，进行中合法百分比，render 输出含任务头/stage/完成标记。
- 宿主重启重跑（`test-orchestration.mjs:793-850`）：预置卡 articles/plan 的 job（含 `batchPrompt` 快照），重启自动重跑（`index.js:1336-1357`）；兼容旧 plan 阶段任务迁移到 articles（`test-orchestration.mjs:823-848`）。
- 并发提交占位与多实例合并（`test-orchestration.mjs:852-890`）：`serialProjects:false` 配置下 `Promise.all` 双提交共享 jobId；外部实例 job flush 合并不丢失。
- 面板端点与取消（`test-orchestration.mjs:892-944`）：非回环 403；jobs 不泄漏 apiKey；中间进度 `batchProgress`/`taskList` 透出；repos 总览带 `taskList/batchProgress/tps/batchSubmittedAt/articleCount`；取消未知 404。
- 排除清单/repos/compile（`test-orchestration.mjs:946-999`）：compile 动作提交；auto 直调幂等；`excludePaths` 拒绝并报错含命中项（支持父目录排除子目录）；repos 总览含 scheduler 块（默认 `enabled=false, intervalMin=30`）。
- knownRepos/refresh（`test-orchestration.mjs:1001-1039`）：提交即登记 knownRepos（持久化 `dsh-codewiki-repos.json`）；job 历史丢失后 refresh 仍发现。
- 工作区过滤（`test-orchestration.mjs:1041-1102`）：`workspaceRegistry` 仅显示工作区内；`workspaceOnly=false` 不过滤；非终态任务始终显示。
- registry 异常防御（`test-orchestration.mjs:1104-1132`）：`brokenRegistry` 时 jobs/repos 降级不过滤仍 200。
- 工具输出 schema（`test-orchestration.mjs:1183-1221`）：同构校验器 `validateOut` 验证 `codewiki_generate` 输出过 schema。
- 孤儿任务接管（`test-orchestration.mjs:1224-1256`）：`mkForeign` 构造 foreign 任务，停更 6 分钟被接管取消，新鲜的不抢。
- 编译模型缺失诚实报错（`test-orchestration.mjs:1208-1221`）：`batchProvider=''` 时诚实报“编译模型提供商为空”，失败留痕 job 的 failed 态。
- 严格 cordis 语义（`test-orchestration.mjs:61-83`）：未 inject 访问 `ctx.agents` 抛错，但 `apply` 不抛且工具仍注册。
- Temp 残留清理（`test-orchestration.mjs:1247-1264`）：启动清理 Temp 终态任务，保留活动/工作区任务。

## Architecture

测试模块由 mock 宿主、插件注入、mock 宿主 llm 服务、job 轮询、面板端点模拟等组件构成，流程非平凡。

```text
┌─────┬─────┬─────┬─────┬─────┐
│orch │ctx  │reg  │batch│wait │
│1-6  │40-80│269  │134  │201  │
└─┬───┴─┬───┴─┬───┴─┬───┴─┬───┘
  │     │     │     │     │
  ▼     ▼     ▼     ▼     ▼
┌─────┬─────┬─────┬─────┬─────┐
│fake │llm  │     │     │endpt│
│216  │svc  │     │     │892  │
└─────┴─────┴─────┴─────┴─────┘
```

- `orch`：`test-orchestration.mjs` 主脚本，动态导入 `./index.js`（`test-orchestration.mjs:20`）。
- `ctx`：`makeCtx` 构造的 mock 宿主（`test-orchestration.mjs:61-101`），调用 `apply` 注册工具到 `reg`（`test-orchestration.mjs:61`）。
- `reg`：`registered` Map 收集 `cw`、`codewiki_generate` 等工具（`test-orchestration.mjs:45`）。
- `batch`：`makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:138-202`）替换 `activeLlm`。
- `wait`：`waitJob` 轮询 `JOBS_FILE` 取终态（`test-orchestration.mjs:205-218`）。
- `fake`+`llm`+`endpt`：面板端点用 `fakeReq/fakeRes`（`test-orchestration.mjs:172-184`）调用 `endpoints` handler（注册于 `test-orchestration.mjs:46`，调用如 `test-orchestration.mjs:172`、`932`）。

## Data Flow

1. 测试启动设置环境变量 `DSH_CODEWIKI_TICK_MS='300'` 与 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:14-19`），动态导入 `./index.js` 得到 `{ name, apply }`（`test-orchestration.mjs:20`）。
2. `makeCtx` 构造 mock 宿主上下文，收集 `registered` Map、`endpoints` 数组、`listeners`（`test-orchestration.mjs:44-84`）。
3. 调用 `apply(ctx, config)` 注入插件（`test-orchestration.mjs:61` 等），插件通过 `ctx.tools.register` 将 `cw`、`codewiki_generate`、`codewiki_update`、`codewiki_progress` 等工具定义存入 `registered`（`index.js:3048-3064`），通过 `ctx.webServer.register` 推端点（`index.js:3048-3107`），通过 `ctx.on('agent/created', fn)` 记录监听（`index.js:3048`）。
4. `makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:138-202`），`llm.stream` 按 prompt 特征返回固定 markdown 驱动服务阶段机（`test-orchestration.mjs:138-168`）。
5. 调用 `registered.get('codewiki_generate').execute({cwd, scope, auto}, {agent})` 提交任务（如 `test-orchestration.mjs:45`），立即返回 `{submitted, jobId, stage, notes}`（不含 writtenCount）。后台服务以 300ms tick 推进阶段机，读写 `JOBS_FILE`（JSON `{jobs:[...]}`，`test-orchestration.mjs:45`）。
6. `waitJob(cwd)` 轮询 `JOBS_FILE` 解析出 job 终态对象，形状含 `stage, plan, wikiPath, writtenCount, failedCount, notes, taskList, batchProgress, usage, tps` 等（`test-orchestration.mjs:205-218`）。
7. 面板端点通过 `fakeReq`/`fakeRes` 调用 `endpoints.find(e=>e.path===...).handler(req, res)` 验证 HTTP 层行为（`test-orchestration.mjs:220-232`、`678`、`932`）。
8. `wakeCompileSession` 在 job 终态时通过 `steer` 唤醒发起会话（`test-orchestration.mjs:450-482`、`index.js:1221-1235`）。
9. 重启重跑场景预置含 `batchPrompt` 快照的 job 文件，服务启动后 `settleJob` 自动接管重跑（`test-orchestration.mjs:793-850`、`index.js:1356-1377`）。

## Connections

- 插件主入口与符号来自 [[index]]（动态导入 `./index.js` 获取 `name`、`apply`、`commitHintText`（`index.js:3048`）、`wakeCompileSession`（`index.js:3048`）、`autoCommitWiki`（`index.js:3048`））。
- 编排测试验证的 `dsh-codewiki` 插件行为关联 [[index]] 中的阶段机与调度逻辑（服务 `createJobService` 等，`index.js:1238`）。
- 历史测试输出见 `.tmp-test-orchestration.log`，该日志为旧版运行残留（曾记录 `source` 标记 `plugin:codewiki` 未生效的 2 项 FAIL），当前代码 `index.js:1214` 已使用 `source: { kind: 'plugin:codewiki' }` 且 `test-orchestration.mjs:469` 与 `:471` 断言已通过，日志不代表当前状态。

## Known Issues

- 当前测试基于最新代码全部应通过（无 FAIL 项）。`.tmp-test-orchestration.log` 中记录的 2 项 FAIL（source 标记 `plugin:codewiki`）属历史残留：当前 `index.js:1221` 已在 `wakeCompileSession` 中通过 `createUserMessage({ ..., source: { kind: 'plugin:codewiki' } })` 标记，测试 `test-orchestration.mjs:469` 与 `test-orchestration.mjs:471` 断言 `source?.kind === 'plugin:codewiki'` 已通过，不再构成缺陷。
- 静默容错（如 `registry.get` 与 `steer` 抛异常均静默不抛、缺省 `agents` 静默、`workspaceRegistry.list()` 抛错降级不过滤）属于设计内边界行为，非缺陷（见 `test-orchestration.mjs:476-481`、`1104-1132`）。
- 旧文章中提及的 `plan` 阶段、概念文章 `concepts/config-load.md`、`src/core.py` 路径等均已过时：0.10.7 起规划阶段删除，阶段机为 `articles→crosscut→review→index`（`test-orchestration.mjs:1-6`），fixture 使用 `core/core.py` 与 `util/util.py`（`test-orchestration.mjs:103-106`），localPlan 产出空 concepts 数组（`index.js:682-695`），故无概念文章落盘。