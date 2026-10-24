---
title: test-log-pairing
type: concept
source_files:
  - test-orchestration.mjs
  - index.js
  - .tmp-test-orchestration.log
  - README.md
  - CHANGELOG.md
tags: [测试, 日志, 配对, 端到端, codewiki, 跨模块]
---

## Overview

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，测试脚本（`test-orchestration.mjs`）、运行时实现（`index.js`）、运行日志（`.tmp-test-orchestration.log`）与项目文档（`CHANGELOG.md`、`README.md`）之间通过行号引用与断言结果形成的配对与相互印证关系。该概念并非单一代码实体，而是验证体系的数据/控制流闭环：测试代码调用真实插件逻辑、产生日志、断言日志与内存状态，并将断言规模与失败项固化到文档中。当前代码基线以 `test-orchestration.mjs` 与 `index.js` 的交互为主，`CHANGELOG.md` 记录版本演变与测试结论（观察批1指出绝大多数 PASS，仅 2 项未通过属测试桩结构差异），`README.md` 明确 0.10.1 起删除内置百炼直连、必须走宿主 llm 服务。

## Involved Modules

- **orchestration-tests**：配对关系的产生地。提供端到端测试脚本 `test-orchestration.mjs`，通过 `check(cond, msg)` 断言机制（`test-orchestration.mjs:23`）将代码预期与日志输出行号绑定；覆盖系统提示提醒、注册与 cw、规划阶段、大 wiki 横切、串行排队、stale 更新、重启重跑、面板端点等测试块（起始见 `test-orchestration.mjs:23` 等）。`makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})`（`test-orchestration.mjs:40`）构造 mock cordis ctx；`makeBatchMock`（`test-orchestration.mjs:127`）按 prompt 首行特征分发应答；`waitJob`（`test-orchestration.mjs:192`）轮询 `JOBS_FILE` 等终态；动态导入 `commitHintText`/`wakeCompileSession`（`test-orchestration.mjs:284,354`）。`README.md` 提及但本批未列 `test-batch.mjs`。
- **plugin-runtime**：被测实现载体。宿主侧 `index.js` 内的 `name='dsh-codewiki'`（`index.js:1252`）、`createJobService`（`index.js:1252`）、`apply`（`index.js:2876`）等符号被测试直接导入与调用，其行号在测试中断言配对。`index.js` 实现阶段机 plan→articles→crosscut→compose→review→index（`STAGE_HANDLER` 映射 `index.js:1978`），以及横切/文章分割、会话通道兜底、面板端点（`installWebServer` `index.js:2569`）。常量如 `CONCURRENCY_HARD_CAP=8`（`index.js:1252`）、`DEFAULT_CONCURRENCY=2`（`index.js:1252`）、`BATCH_TOKEN_BUDGET=110000`（`index.js:1252`）、`BATCH_TOKEN_HARD_LIMIT=128000`（`index.js:1252`）。
- **project-docs**：配对结果固化层。`CHANGELOG.md` 按版本存证测试断言数与已知日志 FAIL 项（如 `source` 标记偏移疑云，观察批1指出源码 `index.js:1248` 已设 `source:{kind:'plugin:codewiki'}` 但测试桩断言路径未命中），形成文档到测试日志的回溯配对；该文件还记载 `client.js` 设置页渲染逻辑（如 `CHANGELOG.md:19` 的 `modelTrio`），但 `client.js` 未列入本模块源码清单。`README.md` 提供工具说明与设置项，明确 0.10.1 起删除内置百炼直连。

## Flow

1. **控制流启动与代码配对**：测试启动设置隔离环境变量 `DSH_CODEWIKI_TICK_MS='300'`（`test-orchestration.mjs:15`）与独立 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:19`），动态导入 `./index.js` 取得 `{name, apply}`（`test-orchestration.mjs:20`），将 plugin-runtime 的 `index.js` 实现加载进测试进程，完成“测试脚本—实现代码”的符号配对。
2. **模拟注入与执行驱动**：`makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})` 构造 mock 宿主（`test-orchestration.mjs:40`），支持回调式与 promise 式 `inject`（`test-orchestration.mjs:58-68`）；`makeBatchMock` 按 prompt 首行特征分发应答（`test-orchestration.mjs:127`），模拟编译模型通道。测试块调用 `apply(ctx, config)`（如 `test-orchestration.mjs:258` 附近注册）触发 `index.js` 的 `apply`（`index.js:2876`），其内 `ctx.inject(['agents'])`/`['llm']` 取 `agentsRef`/`llmRef`（`index.js:2877-2878`）将测试 `llmProxy` 设为 `llmRef`；`createJobService` 启动 tick 循环（`index.js:1252` 内 `start`）。
3. **日志生成与断言配对**：测试执行产生 `.tmp-test-orchestration.log`。`check(cond, msg)` 断言（`test-orchestration.mjs:23`）验证内存态；针对 `wakeCompileSession`，测试预期 `source.kind='plugin:codewiki'`，而日志中对应断言未通过（观察指出 `.tmp-test-orchestration.log:110` 与 `:195` 的 ✗ 项），汇总于日志 FAIL 项，形成“测试代码行号—日志行”的精确配对。数据流形状：mock `answerFor(prompt)` 按特征返回 JSON 或文章 markdown；`llmCalls` 记录 `{provider, model, reasoningEffort, prompt, signal}`（`test-orchestration.mjs:162`）；job 持久化到 `JOBS_FILE` 结构 `{id,cwd,wikiPath,scope,kind,stage,owner,tasks:[{customId,name,articlePath,keepInMemory,batchPrompt,splitFor?,composePlan?,bigTier?}],articles:[{name,ok,stopReason,path}],writtenCount,failedCount,notes,usage,batchProgress,...}`（`index.js:1239-1258`），`waitJob`（`test-orchestration.mjs:192`）轮询该文件过滤 `cwd` 取终态。
4. **文档层固化配对**：测试规模与结论回流文档：`CHANGELOG.md` 记录当轮断言数前后对照（如常量默认值 `CHANGELOG.md:73` 等）与已知日志 FAIL 项分析（观察批1指出 `index.js:1248` 已传 `source:{kind:'plugin:codewiki'}`，合成文章时需注意测试运行版与源码可能存 `createUserMessage` 包装导致的 `source` 结构偏移或日志笔误），完成跨模块的测试-日志-文档闭环。

```text
┌────────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│ test-orchestration │────►│ index.js         │────►│ .tmp-test-         │
│ .mjs               │     │ (plugin-runtime) │     │ orchestration.log  │
└────────────────────┘     └──────────────────┘     └────────────────────┘
       │                        │                        │
       └────────────────────────┼────────────────────────┘
                                ▼
                        ┌──────────────────┐
                        │ CHANGELOG.md     │
                        │ README.md        │
                        └──────────────────┘
```

## Implementation Map

- **测试与日志配对实体**
  - `test-orchestration.mjs:15` — `DSH_CODEWIKI_TICK_MS='300'` 环境隔离。
  - `test-orchestration.mjs:19` — 独立 `DSH_CODEWIKI_JOBS_FILE` 避免洗写。
  - `test-orchestration.mjs:20` — `import { name, apply } from './index.js'`。
  - `test-orchestration.mjs:23` — `check(cond, msg)` 断言累计 `failures`。
  - `test-orchestration.mjs:40` — `makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})` 构造 mock cordis ctx，`inject` 支持回调与 promise 双风格（`test-orchestration.mjs:58-68`）。
  - `test-orchestration.mjs:83` — `makeMockAgent(cwd)` 构造 `agent.ctx.inject` 注册 `systemPrompt.section`。
  - `test-orchestration.mjs:99` — `makeFixtureRepo()` 建 git 临时仓库。
  - `test-orchestration.mjs:114-122` — `activeLlm`/`llmProxy` 唯一通道转发。
  - `test-orchestration.mjs:127` — `makeBatchMock({modules,articleMarker,stall,bigArticle,bigSources,planReply})` 核心 mock llm，按 prompt 首行特征由 `answerFor` 分发（`test-orchestration.mjs:129-157`）；`llm.stream` 吐 `block-start/text-delta/usage/finish` 协议（`test-orchestration.mjs:160-177`），`stall` 时挂起等 abort。
  - `test-orchestration.mjs:162` — `llmCalls` 记录 `{provider, model, reasoningEffort, prompt, signal}`。
  - `test-orchestration.mjs:192` — `waitJob(cwd,{timeout})` 轮询 `JOBS_FILE` 等终态。
  - `test-orchestration.mjs:207-219` — `fakeReq`/`fakeRes` 模拟 HTTP 请求/响应。
  - `test-orchestration.mjs:222` 起 — 测试块覆盖：系统提示提醒（222）、注册与 cw 工具（253）、codewiki_update+commitHintText（273）、wakeCompileSession（352）、规划阶段插件内批量池（380）、全量编译阶段机（455）、大 wiki 横切拆分（487）、大模块文章分割（517）、单项目串行（550）、唯一通道（599）、stale 逐篇更新（633）、codewiki_progress（657）、重启重跑（693）、并发占位 flush 合并（749）、面板端点与取消（789）、排除清单/repos/compile（843）、knownRepos/refresh（898）、workspaceOnly 过滤（938）、registry 异常降级（985）、output schema 校验（1015）、孤儿接管（1055）、模型缺失报错（1089）、严格 cordis（1104）、Temp 清理（1128）。
  - `test-orchestration.mjs:284,354` — 动态导入 `commitHintText`/`wakeCompileSession` 单测。
  - `.tmp-test-orchestration.log:114` — `✗ source 标记 plugin/codewiki`（观察批1引用，源码 `index.js:1248` 已写 `source:{kind:'plugin:codewiki'}`，测试桩路径未命中）。
  - `.tmp-test-orchestration.log:195` — `✗ 唤醒消息 source=plugin/codewiki`（同上）。

- **被测实现配对位置（plugin-runtime）**
  - `index.js:19` — `export const name = 'dsh-codewiki'`。
  - `index.js:22,24,26,27,30,31` — 常量 `CONCURRENCY_HARD_CAP=8`、`DEFAULT_CONCURRENCY=2`、`DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'`、`DEFAULT_BIG_PROVIDER='volces-ark'`、`DEFAULT_BIG_MODEL='glm-5.3-flash'`。
  - `index.js:369,374` — `BATCH_TOKEN_BUDGET=110000`、`BATCH_TOKEN_HARD_LIMIT=128000`。
  - `index.js:48` — `Config` (z.object) 含 `enabled/binaryPath/batchProvider/batchModel/batchReasoningEffort/bigProvider/bigModel/bigReasoningEffort/bigTokenBudget/sessionTier/maxConcurrency/serialProjects/articleLanguage/updateReminder/excludePaths/autoUpdate/autoUpdateMin/workspaceOnly`，均 `volatile`。
  - `index.js:73` — `liveConfig(config)` 解包默认值，`maxConcurrency` 夹在 1–8。
  - `index.js:37` — `normalizeCwd` Windows/Git-Bash 盘符归一化。
  - `index.js:103` — `resolveBinary` PATH 优先，回退 `bin/cw(.exe)`。
  - `index.js:125` — `runCw` spawn Promise 封装，支持 timeout/abort。
  - `index.js:162,166` — `normalizeArticlePath`、`normalizeIndexLinks` 路径 `\`→`/`。
  - `index.js:176` — `parseStatus(stdout)` 解析 cw status 三态/changedFiles/staleArticles。
  - `index.js:209` — `ensureWikiEntry` 仓库根缺 `CodeWiki.md` 时按语言自动生成，已有不覆盖。
  - `index.js:247-259` — `excludedItem`/`isExcluded` 排除清单命中（换行/分号/逗号分隔，子树匹配）。
  - `index.js:267` — `estimateTokens` CJK≈1 token/字，其余≈3.5字符/token。
  - `index.js:283` — `llmChat({llm,provider,model,reasoningEffort,prompt,signal})` 唯一通道：调用 `llm.stream` + `BlockAssembler`，失败/空内容抛错。
  - `index.js:306` — `applyTaskResult` `keepInMemory` 回内存，否则 `fixAnchors` 后写盘。
  - `index.js:327` — `runRealtimeTasks(tasks, {model,reasoningEffort,concurrency,notes,onTaskDone,signal,llm,provider})` 并发池，返回 `Map(customId→结果)`。
  - `index.js:385` — `numberLines` 源码加 `N| ` 前缀。
  - `index.js:396,416` — `fixAnchors(content, cwd)` 行号锚点确定性校正（4 层兜底），解析 fm `source_files`，符号提取 `symbolsOnLine`。
  - `index.js:484` — `collectSources(cwd, files, budget)` 按预算整文件内联，返回 `{text,skipped,oversized}`。
  - `index.js:555` — `prepareArticleTasks(tasks, {cwd,language,bigProvider,...})` 核心分装：普通任务/观察批(`#obs`)/大档(`bigTier`)/会话通道(`sessionTasks`)；`batches.length===1` 不误转会话通道（`index.js:555-566`）。
  - `index.js:675-881` — prompt 模板：`articleFormatSection`(675)、`batchPlannerPrompt`(708)、`localPlan`(730)、`packArticles`(747)、`batchArchitecturePrompt`(782)、`batchPatternsPrompt`(790)、`batchConceptPrompt`(798)、`batchObservePrompt`(808)、`batchArticleObservePrompt`(829)、`batchArticleComposePrompt`(849)、`batchProofreadPrompt`(881)。
  - `index.js:906` — `cwToolDefinition` 工具 `cw`，`execute` 校验子命令后 `runCw`。
  - `index.js:975-1032` — `slugify`/`parsePlan`/`parseSourceFiles`/`readSourceFiles`/`wikiPathFor`。
  - `index.js:1049-1099` — `JOBS_FILE`/`TICK_MS`/`SESSION_TASK_TIMEOUT_MS`/`ORPHAN_TAKEOVER_MS=5min`/`MAX_JOBS_KEPT` 等常量与内部状态。
  - `index.js:1167-1182` — `acquireTickLock`/`releaseTickLock` 跨进程锁。
  - `index.js:1252` — `createJobService(config, onSettled)` 返回 `{submit,cancel,list,findActive,start,stop}`。
  - `index.js:1284-1342` — `mergeFromDisk`/`flush`/`note`/`touch`/`setStage`/`addUsage`。
  - `index.js:1370` — `settleJob` 执行器丢失按 `batchPrompt` 快照重跑。
  - `index.js:1396` — `writeValidated` frontmatter 闸门。
  - `index.js:1415` — `tally` 记账。
  - `index.js:1445-1513` — `startBatchChatRun`/`submitBatchFor`。
  - `index.js:1521-1595` — `dispatchSessionTasks`/`progressSessionTasks`/`resendSessionSteer`。
  - `index.js:1978` — `STAGE_HANDLER` 映射 `plan/articles/crosscut/compose/review/index` 到 `tickPlan` 等（`index.js:1599-1976`）。
  - `index.js:2054` — `submit` 占位+凭证校验+串行排队；编译模型缺失诚实报错（`index.js:2090-2097` provider 空 → `fail`+`throw`，job 落 `failed`）。
  - `index.js:2153` — `generateToolDefinition` `codewiki_generate`，`execute`（`index.js:2197`）判态提交。
  - `index.js:2312` — `updateToolDefinition` `codewiki_update` 固定 `scope=auto`，错误前缀改写（`index.js:2360`）。
  - `index.js:2383` — `progressToolDefinition` `codewiki_progress` 只读，`progressView` 算百分比（`index.js:2377`）。
  - `index.js:2471-2500` — `isLoopbackRequest`/`writeJson`/`readBodyJson`。
  - `index.js:2507` — `listModelCatalog`。
  - `index.js:2545` — `resolveModelEfforts` 模型目录/思考档位。
  - `index.js:2569` — `installWebServer(ctx, service, extra)` 注册 `/api/codewiki/jobs`、`/repos`、`/models`、`/model-efforts`、`/control`（loopback 守卫）。
  - `index.js:2804` — `commitHintText(cwd, jobs)` 提交提醒（60s 缓存，git log 时间戳比对）。
  - `index.js:2842` — `installUpdateReminder` `systemPrompt.section` 注入 `codewiki:update-reminder`。
  - `index.js:2876` — `apply(ctx, config)` 入口：`ctx.inject(['agents'])`/`['llm']` 取 `agentsRef`/`llmRef`（`index.js:2877-2878`），`createJobService`+`start`，注册 4 工具，装面板与提醒。
  - `index.js:1248` — 写 `source:{kind:'plugin:codewiki'}`（观察批1指出正确逻辑，测试桩 `steered[0]?.source?.kind` 未命中）。

- **文档配对位置（project-docs）**
  - `CHANGELOG.md:77` — 记录 `DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'`、`BATCH_TOKEN_BUDGET=110000`（28000→110000）、`BATCH_TOKEN_HARD_LIMIT=128000`（200000→150000→128000）、`DEFAULT_CONCURRENCY`(2)/`CONCURRENCY_HARD_CAP`(8)。
  - `CHANGELOG.md:75` — `resolveModelEfforts(llm, provider, model)` 原走 `llm.resolveModel()`，返回 `{ok, provider, model, efforts, defaultEffort, context}`；端点回环限定、60s 缓存。
  - `CHANGELOG.md:9` — `resolveModelInfoOf(llm)` 优先 `resolveModelInfo(provider, model, signal)`（`CHANGELOG.md:8`），缺失回落 `resolveModel`；`llm=null` 明确提示未注入。
  - `CHANGELOG.md:16,36,113,175` — `prepareArticleTasks` 分派普通档/大档/会话通道，返回结构由 `{prepared, oversized}` 改为 `{prepared, sessionTasks}`；大档任务标 `bigTier` 带自身 provider/model；单文件 110k–128k 误判修法插「大档单请求」出口（`CHANGELOG.md:37`）。
  - `CHANGELOG.md:17,59` — `runRealtimeTasks(tasks, {model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider})` 内部 `chat = (args) => llmChat({...args, llm, provider, reasoningEffort})`，按任务自带 provider/model 分派。
  - `CHANGELOG.md:18,177` — `submitBatchFor` 将 `bigTier` 任务的 `provider/model/reasoningEffort` 及 `splitFor/composePlan` 写进 `job.tasks` 持久化。
  - `CHANGELOG.md:15-16` — 大档配置四项：`bigProvider`(默认 volces-ark)、`bigModel`(默认 glm-5.3-flash，512k 上下文/maxTokens 128000/low|high|max)、`bigReasoningEffort`(默认空=模型默认 high)、`bigTokenBudget`(默认 420000，下限 `BATCH_TOKEN_BUDGET` 110k)；`bigProvider` 留空=关闭大档，超 128k 走会话通道。
  - `CHANGELOG.md:76` — `serialProjects`(默认 true) 单项目串行，排队期间零请求；非自己 active 时本轮跳过不推进不失败，取消不受闸门限制。
  - `CHANGELOG.md:88,89` — `sessionTier`(volatile 字符串) 非空则 steer 显式传 tier；`buildSessionSteerText({job, snapshots, tier, resend})` 合并 steer 文案。
  - `CHANGELOG.md:101` — `listModelCatalog(llm)` 枚举 `llm.listProviders()`/`listModels()`，单 provider 失败隔离，未注入返回 `{ok:false, providers:[]}`。
  - `CHANGELOG.md:114` — `SESSION_TASK_TIMEOUT_MS`(默认 30min，下限 5min)、`SESSION_TASK_DIR`(`os.tmpdir()/dsh-codewiki-session-tasks/`)；`classifySessionTask(task, nowMs)` 三态 `timeout`(优先)/`harvest`/`wait`。
  - `CHANGELOG.md:115` — `dispatchSessionTasks` / `progressSessionTasks` / `resendSessionSteer` 写任务文件、`agent.steer`、按 `writeValidated` 闸门落盘。
  - `CHANGELOG.md:127,138` — `fixAnchors(content, cwd)` / `parseSourceFiles(fm)` / `numberLines()` 锚点机械校正，CRLF 保真，source_files 外不碰。
  - `CHANGELOG.md:218` — `wakeCompileSession(job, outcome, agents?)` 终态 steer 唤醒发起会话，缺失/冷会话/异常静默跳过。
  - `CHANGELOG.md:210` — `excludedItem(cwd, list)` / `isExcluded` 返回命中排除项原文。
  - `CHANGELOG.md:231` — `commitHintText` 60s TTL 缓存，派生自 jobs + git log；非 git/读失败不提醒。
  - `CHANGELOG.md:230,252` — `codewiki_update`(`updateToolDefinition`)/`codewiki_progress`(`progressToolDefinition`/`samePath`/`progressView`)。
  - `CHANGELOG.md:19` — `modelTrio({pKey,mKey,eKey,state,...})`(client.js) 复用 provider/model/档位三行渲染与目录联动；设置页拉 `/api/codewiki/model-efforts` 渲染档位（`CHANGELOG.md:19`）。
  - `CHANGELOG.md:187,74` — `runMainModelPlan` 0.10.0 已移除。
  - `CHANGELOG.md:59-62` — `bailianChat`/`BAILIAN_BASE`/`hostCtxRef`/`resolveBatchApiKey` 等 0.10.1 全删；`job.apiKey` 字段彻底移除。
  - `CHANGELOG.md:151` — `llmRef`/`agentsRef` 经 `ctx.inject` 获取，替代属性访问（真实 cordis 下 `hostCtxRef?.llm` 访问即抛）。
  - `CHANGELOG.md:173-174` — `batchArticleObservePrompt`/`batchArticleComposePrompt` 观察批 map + 合成 reduce。
  - `CHANGELOG.md:303` — `normalizeArticlePath`/`parseStatus`/`normalizeIndexLinks` Windows 反斜杠收口。
  - `README.md` — 插件文档：提供 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` 工具说明、设置项（`batchProvider`/`batchModel` 等）、安装方式（file:/// 挂载）、开发指引；明确 0.10.1 起删除内置百炼直连、必须走宿主 llm 服务；宿主不热重载，改源码需重启 DeepSeek Harness。