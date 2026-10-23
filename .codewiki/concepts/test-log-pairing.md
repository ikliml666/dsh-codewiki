---
title: test-log-pairing
type: concept
source_files:
  - test-orchestration.mjs
  - index.js
  - CHANGELOG.md
tags: [测试, 日志, 配对, 端到端, codewiki, 跨模块]
---

## Overview

跨模块概念「test-log-pairing」指 dsh-codewiki 插件在端到端编排验证中，测试脚本（`test-orchestration.mjs`）、运行时实现（`index.js`）、运行日志（`.tmp-test-orchestration.log`，观察中提及但未列入源码清单）与项目文档（`CHANGELOG.md`）之间通过行号引用与断言结果形成的配对与相互印证关系。该概念并非单一代码实体，而是验证体系的数据/控制流闭环：测试代码调用真实插件逻辑、产生日志、断言日志与内存状态，并将断言规模与失败项固化到文档中。当前代码基线以 `test-orchestration.mjs` 与 `index.js` 的交互为主，`CHANGELOG.md` 记录版本演变与测试通过数（如 v0.10.4 达 123/0 通过，见 `CHANGELOG.md:24`）。

## Involved Modules

- **orchestration-tests**：配对关系的产生地。提供端到端测试脚本 `test-orchestration.mjs`，通过 `check` 断言机制（`test-orchestration.mjs:23`）将代码预期与日志输出行号绑定；覆盖系统提示提醒、注册与 cw、规划阶段、大 wiki 横切、串行排队、stale 更新、重启重跑、面板端点等测试块（`test-orchestration.mjs:23` 起）。`CHANGELOG.md` 提及 `test-batch.mjs` 同样导入纯函数断言，但本批观察未将其列入源码清单。
- **plugin-runtime**：被测实现载体。宿主侧 `index.js` 内的 `createJobService`（`index.js:1252`）、`wakeCompileSession`（`index.js:1239`）、`apply`（`index.js:2876`）等符号被测试直接导入与调用，其行号在测试中断言配对。`index.js` 实现阶段机 plan→articles→crosscut→compose→review→index，以及横切/文章分割、会话通道兜底、面板端点。
- **project-docs**：配对结果固化层。`CHANGELOG.md` 按版本存证测试断言数（如「0.10.4 达 123/0 通过」`CHANGELOG.md:19`）与已知日志 FAIL 项（如 `source` 标记偏移疑云），形成文档到测试日志的回溯配对；该文件还记载 `client.js` 设置页渲染逻辑（如 `CHANGELOG.md:19` 的 `modelTrio`），但 `client.js` 未列入本模块源码清单。

## Flow

1. **控制流启动与代码配对**：测试启动设置隔离环境变量 `DSH_CODEWIKI_TICK_MS='300'`（`test-orchestration.mjs:15`）与独立 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:19`），动态导入 `./index.js` 取得 `{name, apply}`（`test-orchestration.mjs:20`），将 plugin-runtime 的 `index.js` 实现加载进测试进程，完成“测试脚本—实现代码”的符号配对。
2. **模拟注入与执行驱动**：`makeCtx({agents, workspaces, brokenRegistry, agentGet, llm})` 构造 mock 宿主（`test-orchestration.mjs:40`），支持回调式与 promise 式 `inject`、`effect` 立即执行；`makeBatchMock` 按 prompt 首行特征分发应答（`test-orchestration.mjs:127`），模拟编译模型通道。测试块调用 `apply(ctx, batchCfg())`（`test-orchestration.mjs:258`）触发 `index.js` 的 `apply`，其内 `ctx.inject(['llm'], rc => llmRef=rc.llm)`（`index.js:2878`）将测试 `llmProxy` 设为 `llmRef`；`createJobService` 启动 `setInterval(tick, TICK_MS)`（`index.js:2137`）。
3. **日志生成与断言配对**：测试执行产生 `.tmp-test-orchestration.log`。`check(cond, msg)` 断言（`test-orchestration.mjs:23`）验证内存态；针对 `wakeCompileSession`，测试预期 `source.kind='plugin:codewiki'`（`test-orchestration.mjs:354` 附近调用及断言），而日志中对应断言未通过（观察指出 `.tmp-test-orchestration.log:114` 与 `:195` 的 ✗ 项），汇总于日志 FAIL 项，形成“测试代码行号—日志行”的精确配对。数据流形状：mock `answerFor(prompt)` 按特征返回 JSON 或文章 markdown；`llmCalls` 记录 `{provider, model, reasoningEffort, prompt, signal}`（`test-orchestration.mjs:162`）；job 持久化到 `JOBS_FILE` 为 `{jobs:[{id,cwd,stage,plan,tasks,batchRef,articles,writtenCount,...}]}`，`waitJob`（`test-orchestration.mjs:192`）轮询该文件过滤 `cwd` 取终态。
4. **文档层固化配对**：测试规模与结论回流文档：`CHANGELOG.md` 记录当轮断言数前后对照（如 v0.10.4 达 123/0 通过 `CHANGELOG.md:24`）与已知日志 FAIL 项分析（观察批1指出 `index.js:1248` 与 `index.js:289` 等均设 `source: { kind: 'plugin:codewiki' }`，合成文章时需注意测试运行版与源码可能存 `createUserMessage` 包装导致的 `source` 结构偏移或日志笔误），完成跨模块的测试-日志-文档闭环。

## Implementation Map

- **测试与日志配对实体**
  - `test-orchestration.mjs:23` — `check(cond, msg)` 断言累计 `failures`，驱动日志输出与失败标记。
  - `test-orchestration.mjs:29` — `articleMd(title, source, marker, type)` 构造假文章。
  - `test-orchestration.mjs:34` — `batchCfg(extra)` 默认 `{batchProvider:'workbuddy', batchModel:'hy3'}`。
  - `test-orchestration.mjs:40` — `makeCtx(...)` 模拟 cordis ctx，支持注入与 effect。
  - `test-orchestration.mjs:83` — `makeMockAgent(cwd)` 提供 systemPrompt.section。
  - `test-orchestration.mjs:99` — `makeFixtureRepo()` 建 git 仓库含 src/core.py、src/util.py。
  - `test-orchestration.mjs:114-123` — `llmProxy` / `activeLlm` / `promptOf` 唯一通道转发。
  - `test-orchestration.mjs:127` — `makeBatchMock({modules, articleMarker, stall, bigArticle, bigSources, planReply})` 按 prompt 首行特征分发应答，`stall:true` 挂起直到 abort，`bigArticle` 追加 7w 字。
  - `test-orchestration.mjs:162` — `llmCalls` 记录结构。
  - `test-orchestration.mjs:192` — `waitJob(cwd, {timeout})` 轮询 `JOBS_FILE` 等终态。
  - `test-orchestration.mjs:207` / `217` — `fakeReq` / `fakeRes` 模拟 HTTP。
  - `test-orchestration.mjs:222` 起 — 测试块覆盖系统提示提醒、注册与 cw、codewiki_update+commitHintText、wakeCompileSession、规划阶段三场景、全量编译、大 wiki 横切、大模块分割、单项目串行、唯一通道、stale、progress、重启重跑、并发占位、面板端点取消、排除清单、knownRepos、工作区过滤、registry 异常、schema 校验、孤儿接管、模型缺失报错、严格 cordis、Temp 清理。
  - `.tmp-test-orchestration.log:114` — `✗ source 标记 plugin/codewiki`（观察批1引用）。
  - `.tmp-test-orchestration.log:195` — `✗ 唤醒消息 source=plugin/codewiki`（观察批1引用）。

- **被测实现配对位置（plugin-runtime）**
  - `index.js:19` — `export const name = PLUGIN_NAME`（值为 `'dsh-codewiki'`）。
  - `index.js:48-67` — `export const Config`（z.object）含 enabled、binaryPath、batchProvider、batchModel、bigProvider、bigModel、maxConcurrency、serialProjects、articleLanguage 等。
  - `index.js:162` — `normalizeArticlePath`；`:166` `normalizeIndexLinks`；`:176` `parseStatus` 三态解析；`:209` `ensureWikiEntry` 缺失自动生成 CodeWiki.md；`:267` `estimateTokens` CJK≈1token/字；`:327` `runRealtimeTasks` 并发池调用 `llmChat`；`:385` `numberLines` 加「N| 」前缀；`:396-479` `fixAnchors` 行号锚点校正；`:484-511` `collectSources` 按预算整文件装填；`:555-669` `prepareArticleTasks` 分割/大档/会话兜底决策；`:730` `localPlan` 顶层目录分组兜底；`:747` `packArticles` 横切输入装填；`:1134` `scanRepoFiles` 黑名单与上限；`:1061` `classifySessionTask`；`:1078` `buildSessionSteerText`；`:2507` `listModelCatalog`；`:2545` `resolveModelEfforts`；`:2569` `installWebServer` 注册端点；`:2804` `commitHintText` 60s 缓存；`:1239` `wakeCompileSession` steer 唤醒；`:2876` `apply` 注册工具与端点。
  - `index.js:1049` — `JOBS_FILE` 受 env 覆盖；`:1050` `TICK_MS` 默认10000；`:1054` `SESSION_TASK_TIMEOUT_MS` 默认30min；`:1055` `SESSION_TASK_DIR`；`:1098` `ORPHAN_TAKEOVER_MS` 默认5min；`:1099` `MAX_JOBS_KEPT=30`；`:1104` `REPOS_FILE`；`:1117` `JOB_TERMINAL` 终态。
  - `index.js:1252` — `createJobService` 核心服务含 submit/cancel/tick/tickPlan/tickArticles/tickCrosscut/tickCompose/tickReview/tickIndex/startBatchChatRun/submitBatchFor/settleJob/writeValidated/tally/dispatchSessionTasks/progressSessionTasks/mergeFromDisk/flush/acquireTickLock。
  - `index.js:2054` — 编译模型缺失诚实报错：provider 留空时 `submit` 内抛“编译模型提供商为空”并落 failed 态。
  - `index.js:979` — `parsePlan` 定义（返回 null 时由 `tickPlan` 在 `index.js:979` 调 `localPlan` 降级）。
  - `index.js:1999-2010` — 单项目串行：存在活动 job 新 job 进 `queued` 记 `pendingStage`。
  - `index.js:613-624` — 分割边界修复：单文件 110k–128k 且 batches.length===1 不再误转会话通道。
  - `index.js:396-418` — `fixAnchors` 符号歧义退试首段、声明形态正则匹配。
  - `index.js:1248` / `289` — 设 `source: { kind: 'plugin:codewiki' }`（观察批1指出的正确逻辑）。

- **文档配对位置（project-docs）**
  - `CHANGELOG.md:73` — 记录 `DEFAULT_BATCH_PROVIDER='workbuddy'`、`DEFAULT_BATCH_MODEL='hy3'`、`BATCH_TOKEN_BUDGET=110000` 等常量。
  - `CHANGELOG.md:24` — 记录 0.10.4 达 123/0 通过（`test-batch.mjs`/`test-orchestration.mjs` 导入纯函数断言）。
  - `CHANGELOG.md:114` / `:115` — `classifySessionTask` 三态、`dispatchSessionTasks` 若 sessionId/steer 不可用直接 fail 明示「请从会话内重新提交」。
  - `CHANGELOG.md:127` — `fixAnchors` 仅校正 source_files 清单内引用，清单外不动；同批拆出 `parseSourceFiles(fm)`。
  - `CHANGELOG.md:218` — `wakeCompileSession` 缺失 session/冷会话/异常静默跳过。
  - `CHANGELOG.md:231` — `commitHintText` 导出，git 提交提醒 60s TTL，非 git/无提交史不提醒。
  - `CHANGELOG.md:329` — 孤儿接管阈值 `DSH_CODEWIKI_ORPHAN_TAKEOVER_MS` 默认 5 分钟，多实例安全。
  - `CHANGELOG.md:19` — 记载 `client.js` 的 `modelTrio({pKey,mKey,eKey,state,...})` 抽复用提供商/模型/思考程度三行渲染与目录联动（文档层提及，非本模块源码实体）。
  - `CHANGELOG.md:78` / `:91` — 记载设置页拉 `/api/codewiki/model-efforts` 渲染档位、增「单项目串行」Switch（经由 `client.js` 调用，文档固化配对）。