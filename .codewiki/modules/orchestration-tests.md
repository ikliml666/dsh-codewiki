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

`test-orchestration.mjs` 是 dsh-codewiki 插件的端到端服务化编排冒烟测试脚本，通过 mock 宿主 llm 服务（llm.stream 按 prompt 特征应答，插件零直连）、真实 cw CLI、真实服务 tick，验证 codewiki_generate 提交制、服务阶段机（plan→articles→crosscut→review→index）、stale 逐篇更新、宿主重启后按 prompt 快照重跑、面板端点（jobs/control）与取消、编译模型缺失诚实报错、单项目串行排队（0.10.0）、编译终态 steer 实时唤醒发起会话、0.10.1 起唯一通道是宿主 llm 服务（模型设置里已注册的 provider/model，插件不再直连任何端点）等（`test-orchestration.mjs:1-6`）。

测试加速通过将 tick 间隔压到下限 300ms（生产默认 10s，`test-orchestration.mjs:28`）；使用独立 `JOBS_FILE` 与真实宿主服务实例隔离，避免互相洗写（`test-orchestration.mjs:19`，全局常量 `JOBS_FILE` 在 `test-orchestration.mjs:28`）。

## Key Components

### 常量与断言
- `failures` 计数与 `check(cond, msg)` 断言机制（`test-orchestration.mjs:22-26`）：失败累加并输出 ✗，结尾汇总退出码。
- `JOBS_FILE`：全局常量，引用隔离的 jobs 文件路径（`test-orchestration.mjs:28`）。
- `activeLlm` 与 `llmProxy`：mock 宿主 llm 服务转发机制；`activeLlm` 为当前生效假 llm，`llmProxy` 恒转发给它（`test-orchestration.mjs:114-122`）。
- `DSH_CODEWIKI_TICK_MS='300'`：测试加速环境变量（`test-orchestration.mjs:15`）。

### 动态导入与符号
- 动态导入 `./index.js` 获取 `{ name, apply }`（`test-orchestration.mjs:20`）；后续单测直接导入 `commitHintText`（`test-orchestration.mjs:284`）与 `wakeCompileSession`（`test-orchestration.mjs:354`）。
- 插件名 `name === 'dsh-codewiki'`（`index.js:2876`），`apply` 为插件入口函数（注册工具与监听，`index.js:2876`）。

### 测试辅助函数
- `articleMd(title, source, marker='Batch-written', type='module')`：拼接含 frontmatter 的假文章 markdown（`test-orchestration.mjs:29-30`）。
- `batchCfg(extra={})`：返回 `{ batchProvider: 'workbuddy', batchModel: 'hy3', ...extra }`，对应 0.10.1 起编译模型必须显式指向模型设置里的 provider/model（`test-orchestration.mjs:34`）。
- `makeCtx({ agents=[], workspaces=null, brokenRegistry=false, agentGet=null, llm=null }={})`：mock 宿主上下文，返回 `{ ctx, registered, endpoints, listeners, disposers }`（`test-orchestration.mjs:40-80`）。
  - 内部 `services` 含 `webServer.register`（`test-orchestration.mjs:46`）、`agents`（支持 `agentGet` 或 `list`，`test-orchestration.mjs:47`）、`tools.register`（存入 `registered` Map，`test-orchestration.mjs:48`）、可选 `llm`（`test-orchestration.mjs:49`）。
  - `workspaceRegistry`：`workspaces` 映射为 list（`test-orchestration.mjs:51-52`）；`brokenRegistry=true` 时 `list()` 抛错（`test-orchestration.mjs:54-55`）。
  - `ctx.inject(deps, fn)`：支持带回调（传 ctx 切片）与 promise 风格（返回数组/单值，`test-orchestration.mjs:58-68`）。
  - `ctx.on(event, fn)` 收集监听（`test-orchestration.mjs:57`）；`ctx.effect(fn)` 立即执行并收集 disposer（`test-orchestration.mjs:73-77`）。
- `makeMockAgent(cwd)`：构造 `{ agent, sections }`，`agent.session.header.cwd` 与 `agent.ctx.inject` 用于注册 systemPrompt section（`getSectionOrder` 对 `TOOL_REPORT` 返回 2900，`test-orchestration.mjs:83-97`）。
- `makeFixtureRepo()`：建临时 git 仓库，写 `src/core.py`、`src/util.py` 并 init 提交（`test-orchestration.mjs:99-109`）。
- `makeBatchMock({ modules=['core','util'], articleMarker='Batch-written', stall=false, bigArticle=false, bigSources=false, planReply=null }={})`：模拟宿主 llm 服务（替换 `activeLlm`/`llmProxy`），返回 `{ llm, llmCalls, batchPrompts(), realtimePrompts(), restore() }`（`test-orchestration.mjs:127-189`）。
  - 内部 `answerFor(prompt)`：按 prompt 特征分发（勘探员/观察员/作者/架构观察员/总览/模式/概念/审校员，`test-orchestration.mjs:129-157`）。
  - `llm.stream` 复写：未知 prompt 返回默认（`test-orchestration.mjs:159-178`）；`stall=true` 时挂起至 `signal.abort`（`test-orchestration.mjs:159-165`）；`bigArticle=true` 追加 7 万字符（`test-orchestration.mjs:159`）。
- `waitJob(cwd, { timeout=30000 }={})`：轮询 `JOBS_FILE` 取该 cwd 最新 job 终态（done/failed/cancelled，`test-orchestration.mjs:192-205`）。
- `fakeReq(body, addr='127.0.0.1', method='POST')` 与 `fakeRes()`：mock HTTP 请求/响应（`test-orchestration.mjs:207-219`）。
- `validateOut` 同构校验器：在“工具输出 schema 形态”块内定义，验证 `codewiki_generate` 输出 schema（`test-orchestration.mjs:1019-1034`）。

### 测试覆盖块（顶级代码块，顺序执行验证行为）
以下块均在 `test-orchestration.mjs` 中，覆盖各类场景：
- 系统提示提醒（`test-orchestration.mjs:221-250`）：`apply(ctx, reminderConfig)` 后布线 `agent/created`；仅当仓库有 `.codewiki` 且根有 `CodeWiki.md` 时注入 `codewiki:update-reminder` section；`updateReminder=false` 或缺失文件时文本为空。
- 注册与 cw 工具（`test-orchestration.mjs:252-270`）：`name==='dsh-codewiki'`，注册 `cw`、`codewiki_generate`、`codewiki_progress`；`cw status` 判定 missing 态。
- `codewiki_update` 与 `commitHintText`（`test-orchestration.mjs:272-349`）：wrapper 单测强制 `scope='auto'`，错误前缀改写；`commitHintText` 按 git 提交时间与 `writtenCount` 决定提醒（依赖 60s cwd 缓存，用不同 fixture 绕开）。
- `wakeCompileSession`（`test-orchestration.mjs:351-377`）：done/failed 触发 steer，消息含标题/id/提交指引，`source.kind='plugin:codewiki'`（`index.js:1239`）；无 sessionId/冷会话/异常静默不抛。
- 规划阶段（`test-orchestration.mjs:379-452`）：0.10.1 起唯一通道是宿主 llm 服务，不沿用会话主模型身份（全部请求按配置的 provider/model 发出，`test-orchestration.mjs:400-403`）；非法 JSON 降级本地分组（`test-orchestration.mjs:414-432`）；面板提交同路径（`test-orchestration.mjs:434-449`）。
- 全量编译（`test-orchestration.mjs:454-484`）：提交即返回 `stage=plan`；服务推进至 `done`；落盘 `modules/core.md`、`modules/util.md`、`_architecture.md`、`_patterns.md`、`concepts/config-load.md`；校对回写 `PROOFED`；终态 steer 唤醒 `sess-e2e`（`test-orchestration.mjs:468`）。
- 大 wiki 横切（`test-orchestration.mjs:486-514`）：`bigArticle` 触发 2 观察请求 + 合成批 reduce，合成不含原文。
- 大模块分割（`test-orchestration.mjs:516-548`）：210KB 源文件触发 4 观察批 + 2 合成请求。
- 单项目串行（`test-orchestration.mjs:550-597`）：`stall` 挂起 A，B 进 `queued` 且 `pendingStage=plan`；取消 A 后 B 自动轮到。
- 唯一通道与实时指标（`test-orchestration.mjs:599-631`）：所有请求走宿主 llm 服务（workbuddy/hy3，插件零直连）；jobs 端点透出 `tps`/`stageTimings`/`usage`。
- stale 逐篇更新（`test-orchestration.mjs:633-654`）：改 `core.py` 后 `scope='stale'` 直达 articles，仅更新声明了 core.py 的 3 篇。
- `codewiki_progress`（`test-orchestration.mjs:656-692`）：cwd/jobId 过滤，终态 `progress=100`，进行中合法百分比，render 输出含任务头/stage/完成标记。
- 宿主重启重跑（`test-orchestration.mjs:693-747`）：预置卡 articles/plan 的 job（含 `batchPrompt` 快照），重启自动重跑（`index.js:1370-1391`）；兼容 0.5.x `batchId='local'`。
- 并发提交占位与多实例合并（`test-orchestration.mjs:749-787`）：`serialProjects:false` 配置下 `Promise.all` 双提交共享 jobId；外部实例 job flush 合并不丢失。
- 面板端点与取消（`test-orchestration.mjs:789-841`）：非回环 403；jobs 不泄漏 apiKey；中间进度 `batchProgress`/`taskList` 透出；repos 总览带 `taskList/batchProgress/tps/batchSubmittedAt/articleCount`；取消未知 404。
- 排除清单/repos/compile（`test-orchestration.mjs:843-896`）：compile 动作提交；auto 直调幂等；`excludePaths` 拒绝并报错含命中项（支持父目录排除子目录）；repos 总览含 scheduler 块（默认 `enabled=false, intervalMin=30`）。
- knownRepos/refresh（`test-orchestration.mjs:898-936`）：提交即登记 knownRepos（持久化 `dsh-codewiki-repos.json`）；job 历史丢失后 refresh 仍发现。
- 工作区过滤（`test-orchestration.mjs:938-983`）：`workspaceRegistry` 仅显示工作区内；`workspaceOnly=false` 不过滤。
- registry 异常防御（`test-orchestration.mjs:985-1013`）：`brokenRegistry` 时 jobs/repos 降级不过滤仍 200。
- 工具输出 schema（`test-orchestration.mjs:1019-1057`）：同构校验器 `validateOut` 验证 `codewiki_generate` 输出过 schema。
- 孤儿任务接管（`test-orchestration.mjs:1060-1092`）：`mkForeign` 构造 foreign 任务，停更 6 分钟被接管取消，新鲜的不抢。
- 编译模型缺失诚实报错（`test-orchestration.mjs:1089-1102`）：`batchProvider=''` 时诚实报“编译模型提供商为空”，失败留痕 job 的 failed 态。
- 严格 cordis 语义（`test-orchestration.mjs:57-79`）：未 inject 访问 `ctx.agents` 抛错，但 `apply` 不抛且工具仍注册。
- Temp 残留清理（`test-orchestration.mjs:1128-1145`）：启动清理 Temp 终态任务，保留活动/工作区任务。

## Architecture

测试模块由 mock 宿主、插件注入、mock 宿主 llm 服务、job 轮询、面板端点模拟等组件构成，流程非平凡。

```text
┌─────┬─────┬─────┬─────┬─────┐
│orch │ctx  │reg  │batch│wait │
│1-6  │40-80│260  │127  │192  │
└─┬───┴─┬───┴─┬───┴─┬───┴─┬───┘
  │     │     │     │     │
  ▼     ▼     ▼     ▼     ▼
┌─────┬─────┬─────┬─────┬─────┐
│fake │llm  │     │     │endpt│
│207  │svc  │     │     │789  │
└─────┴─────┴─────┴─────┴─────┘
```

- `orch`：`test-orchestration.mjs` 主脚本，动态导入 `./index.js`（`test-orchestration.mjs:20`）。
- `ctx`：`makeCtx` 构造的 mock 宿主（`test-orchestration.mjs:40-80`），调用 `apply` 注册工具到 `reg`（`test-orchestration.mjs:258`）。
- `reg`：`registered` Map 收集 `cw`、`codewiki_generate` 等工具（`test-orchestration.mjs:260`）。
- `batch`：`makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:127-189`）替换 `activeLlm`。
- `wait`：`waitJob` 轮询 `JOBS_FILE` 取终态（`test-orchestration.mjs:192-205`）。
- `fake`+`llm`+`endpt`：面板端点用 `fakeReq/fakeRes`（`test-orchestration.mjs:207-219`）调用 `endpoints` handler（注册于 `test-orchestration.mjs:46`，调用如 `test-orchestration.mjs:615-617`、`829-830`）。

## Data Flow

1. 测试启动设置环境变量 `DSH_CODEWIKI_TICK_MS='300'` 与 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:14-19`），动态导入 `./index.js` 得到 `{ name, apply }`（`test-orchestration.mjs:20`）。
2. `makeCtx` 构造 mock 宿主上下文，收集 `registered` Map、`endpoints` 数组、`listeners`（`test-orchestration.mjs:40-80`）。
3. 调用 `apply(ctx, config)` 注入插件（`test-orchestration.mjs:258` 等），插件通过 `ctx.tools.register` 将 `cw`、`codewiki_generate`、`codewiki_update`、`codewiki_progress` 等工具定义存入 `registered`（`index.js:2876-2892`），通过 `ctx.webServer.register` 推端点（`index.js:2876-2935`），通过 `ctx.on('agent/created', fn)` 记录监听（`index.js:2876`）。
4. `makeBatchMock` 模拟宿主 llm 服务（`test-orchestration.mjs:127-189`），`llm.stream` 按 prompt 特征返回固定 JSON/markdown 驱动服务阶段机（`test-orchestration.mjs:127-155`）。
5. 调用 `registered.get('codewiki_generate').execute({cwd, scope, auto}, {agent})` 提交任务（如 `test-orchestration.mjs:41`），立即返回 `{submitted, jobId, stage, notes}`（不含 writtenCount）。后台服务以 300ms tick 推进阶段机，读写 `JOBS_FILE`（JSON `{jobs:[...]}`，`test-orchestration.mjs:28`）。
6. `waitJob(cwd)` 轮询 `JOBS_FILE` 解析出 job 终态对象，形状含 `stage, plan, wikiPath, writtenCount, failedCount, notes, taskList, batchProgress, usage, tps` 等（`test-orchestration.mjs:192-205`）。
7. 面板端点通过 `fakeReq`/`fakeRes` 调用 `endpoints.find(e=>e.path===...).handler(req, res)` 验证 HTTP 层行为（`test-orchestration.mjs:207-219`、`615-617`、`829-830`）。
8. `wakeCompileSession` 在 job 终态时通过 `steer` 唤醒发起会话（`test-orchestration.mjs:351-377`、`index.js:1239-1250`）。
9. 重启重跑场景预置含 `batchPrompt` 快照的 job 文件，服务启动后 `settleJob` 自动接管重跑（`test-orchestration.mjs:693-747`、`index.js:1370-1391`）。

## Connections

- 插件主入口与符号来自 [[index]]（动态导入 `./index.js` 获取 `name`、`apply`、`commitHintText`（`index.js:2804`）、`wakeCompileSession`（`index.js:1239`））。
- 编排测试验证的 `dsh-codewiki` 插件行为关联 [[index]] 中的阶段机与调度逻辑（服务 `createJobService` 等，`index.js:1252`）。
- 历史测试输出见 `.tmp-test-orchestration.log`，该日志为旧版运行残留（曾记录 `source` 标记 `plugin:codewiki` 未生效的 2 项 FAIL），当前代码 `index.js:1248` 已使用 `source: { kind: 'plugin:codewiki' }` 且 `test-orchestration.mjs:364` 与 `:471` 断言已通过，日志不代表当前状态。

## Known Issues

- 当前测试基于最新代码全部应通过（无 FAIL 项）。`.tmp-test-orchestration.log` 中记录的 2 项 FAIL（source 标记 `plugin:codewiki`）属历史残留：当前 `index.js:1248` 已在 `wakeCompileSession` 中通过 `createUserMessage({ ..., source: { kind: 'plugin:codewiki' } })` 标记，测试 `test-orchestration.mjs:364` 与 `test-orchestration.mjs:471` 断言 `source?.kind === 'plugin:codewiki'` 已通过，不再构成缺陷。
- 静默容错（如 `registry.get` 与 `steer` 抛异常均静默不抛、缺省 `agents` 静默、`workspaceRegistry.list()` 抛错降级不过滤）属于设计内边界行为，非缺陷（见 `test-orchestration.mjs:368-376`、`985-1013`）。