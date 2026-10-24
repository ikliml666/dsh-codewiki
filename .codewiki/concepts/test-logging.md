---
title: test-logging
type: concept
source_files:
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
tags: [测试, 日志, 临时文件, 集成验证, 监听, 排查]
---

## Overview

`test-logging` 是跨模块概念，覆盖 `dsh-codewiki` 插件的测试执行（由 `test-scripts` 模块驱动）、核心逻辑验证（针对 `core-and-config` 模块的 `index.js`）以及运行期日志产出（落盘于 `logs-and-temp` 模块）。该概念描述了端到端测试套件如何通过 `check` 断言函数验证插件导出的纯函数与服务化阶段机，并将分组测试结果重定向写入对应的 `.tmp-test-*.log`；同时由外部 watcher 进程以约 30ms 间隔轮询 `index.js` 持久化的编译 job 状态并追加到 `watcher2.log`，从而形成一套用于排查失败与记录运行时输出的测试日志闭环。注意：现有 `.tmp-test-*.log` 与 `watcher2.log` 都是旧版本代码跑出来的快照，其中记录的预算数值、阶段名与失败项已与当前源码不同（详见 Implementation Map）。

## Involved Modules

1. **test-scripts**：包含 `test-batch.mjs`、`test-cwd-paths.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs`、`test-wiki-entry.mjs` 五个独立脚本，直接 `import` 或 `await import('./index.js')`（`test-batch.mjs:7-12`、`test-orchestration.mjs:20`、`test-cwd-paths.mjs:5`）加载被测插件主体，利用各脚本自带的 `check` 断言辅助（`test-batch.mjs:16`、`test-orchestration.mjs:23`、`test-wiki-anchors.mjs:28`、`test-wiki-entry.mjs:13`）输出 `✓`/`✗` 结果；`test-cwd-paths.mjs` 不用 `check`，直接打印 `PASS`/`FAIL` 行（`test-cwd-paths.mjs:45`、`test-cwd-paths.mjs:57`、`test-cwd-paths.mjs:68`）。
2. **core-and-config**：提供插件核心 `index.js`（入口 `apply` 在 `index.js:3023`，编排服务 `createJobService` 在 `index.js:1218`），导出被验证的纯函数与服务化阶段机，并通过 `JOBS_FILE`（`index.js:1012`）与 `TICK_MS`（`index.js:1013`）驱动任务持久化与轮询；测试通过 `DSH_CODEWIKI_TICK_MS`/`DSH_CODEWIKI_JOBS_FILE` 环境变量把 tick 压到 300ms 并隔离到独立 jobs 文件（`test-orchestration.mjs:15`、`test-orchestration.mjs:19`）。
3. **logs-and-temp**：纯日志数据模块，由 `.tmp-test-batch.log`、`.tmp-test-cwd-paths.log`、`.tmp-test-orchestration.log`、`.tmp-test-wiki-anchors.log`、`.tmp-test-wiki-entry.log` 及 `watcher2.log` 组成，承接测试断言的 stdout 重定向输出与 watcher 轮询输出；仓库内没有直接写这些文件的代码，它们是运行测试/watcher 时捕获的落盘快照。

## Flow

1. **加载与执行**：测试脚本启动即加载 `core-and-config` 的插件主体（`test-batch.mjs:7-12` 的命名导入、`test-orchestration.mjs:28` 的 `await import('./index.js')`、`test-wiki-entry.mjs:10`），`test-orchestration.mjs` 还把 `DSH_CODEWIKI_TICK_MS=300`、独立 `JOBS_FILE` 写入环境变量后导入（`test-orchestration.mjs:28-32`），避免与真实宿主服务实例互相洗写。
2. **断言与逻辑验证**：脚本用 `fs.mkdtempSync` 构造临时仓库（`test-batch.mjs:32`、`test-orchestration.mjs:100` 的 `makeFixtureRepo`，后者还会 `git init` 并配置 identity，`test-orchestration.mjs:99-106`）；纯函数直接调用断言（如 `fixAnchors` 由 `test-batch.mjs:453-495` 验证、`ensureWikiEntry` 由 `test-wiki-entry.mjs:27` 验证）；编排链路则通过 `makeCtx`（`test-orchestration.mjs:40`）注入 mock 的 webServer/tools/agents/llm 服务后执行 `apply(ctx, cfg)`（`test-orchestration.mjs:267`），再触发 `gen.execute`（全量编译在 `test-orchestration.mjs:548`、stale 更新在 `test-orchestration.mjs:741`），测试侧以 `waitJob`（`test-orchestration.mjs:201`）轮询 `JOBS_FILE` 等待 `createJobService` 阶段机推进到终态。
3. **测试日志落盘**：测试执行进程把分组断言结果按固定文本格式重定向写入对应的 `.tmp-test-*.log`（如 `.tmp-test-batch.log:85` 汇总 `ALL PASS：59 通过，0 失败`；`.tmp-test-cwd-paths.log:8` 汇总 `ALL PASS`；`.tmp-test-orchestration.log:573` 汇总 `FAIL：2 项未通过`；`.tmp-test-wiki-anchors.log:161` 汇总 `锚点校验：122 过 / 36 败`；`.tmp-test-wiki-entry.log:25` 汇总 `全部断言通过`）。
4. **Watcher 监听记录**：外部 watcher 进程以约 30ms 间隔（`watcher2.log:1` 首条 40ms，此后每条 +30ms）轮询 `index.js` 产生的 `JOBS_FILE`，把单行状态（含 `mtime`、job id、`stage`、`cancelReq`、`upd`、`notes` 计数）追加到 `watcher2.log`（如 `watcher2.log:1` 记录 `job-muwdk1pk-2 plan`）；日志中可见 job 出现/notes 变化的瞬间（`watcher2.log:20-22` 新 job `job-muwdmx5z-0`，`watcher2.log:305-306` `job-muwdn4lx-2` 的 `notes=0→1`）与 mtime 跳变（`watcher2.log:1294` 起刷新到 `1791272942350`）。
5. **事后审查**：开发者读取日志获知失败总数与失败项（`.tmp-test-orchestration.log:573`，两处失败分别是 `.tmp-test-orchestration.log:114`、`.tmp-test-orchestration.log:195` 的 `source 标记` 断言）、锚点偏差（`.tmp-test-wiki-anchors.log:161` 的 36 败）以及 job 停留在某阶段的现象（`watcher2.log:1-304` 中 `job-muwdk1pk-2` 长期停在 `plan`）。

## Implementation Map

- **测试脚本入口与断言**：`test-batch.mjs:16-21`（导入被测导出）、`test-batch.mjs:16`（`check`）、`test-batch.mjs:20`（`section` 分组打印）、`test-batch.mjs:173`（`makeLlm` 假宿主 llm 流式服务）、`test-batch.mjs:195`（`runRealtimeTasks` 调用）、`test-batch.mjs:16-20`（汇总与 exit code）；`test-cwd-paths.mjs:20`（`apply` 注册后取 `cw` 工具）、`test-cwd-paths.mjs:20`（MSYS 路径 `cw path`）、`test-cwd-paths.mjs:20`（Windows 路径 `cw status`）、`test-cwd-paths.mjs:20-25`（不存在路径干净报错）；`test-orchestration.mjs:23`（`check`）、`test-orchestration.mjs:34`（`batchCfg` 基线 `workbuddy/hy3`）、`test-orchestration.mjs:40`（`makeCtx`）、`test-orchestration.mjs:99`（`makeFixtureRepo`）、`test-orchestration.mjs:121-129`（`activeLlm`/`llmProxy` 接线）、`test-orchestration.mjs:134`（`makeBatchMock`）、`test-orchestration.mjs:201`（`waitJob`）、`test-orchestration.mjs:23`（全量编译 e2e 触发）；`test-wiki-anchors.mjs:38`（`symbolsOnLine` 符号提取，与 `index.js:418-427` 同源——`index.js:2923-2928` 注释明确「两处同源，改一处须同步另一处」）、`test-wiki-anchors.mjs:28`（符号绑定只在单锚点行校验）、`test-wiki-anchors.mjs:28-29`（汇总）；`test-wiki-entry.mjs:27`（缺失入口生成）、`test-wiki-entry.mjs:38`（已有入口不覆盖）、`test-wiki-entry.mjs:57-72`（Windows `\`→`/` 路径规范化断言）。
- **核心被测实现**（均在 `index.js`）：`index.js:3023`（`apply` 插件入口，测试 `apply(ctx, config)` 的对象）、`index.js:1218`（`createJobService`，阶段机 `articles→crosscut→compose→review→index` 由 `index.js:2024-2030` 的 `STAGE_HANDLER` 定义，tick 在 `index.js:3023`，提交在 `index.js:3023`）、`index.js:1012-1013`（`JOBS_FILE`/`TICK_MS`，watcher 与 `waitJob` 的轮询目标）、`index.js:269`（`estimateTokens`）、`index.js:387`（`numberLines` 行号前缀）、`index.js:398`（`fixAnchors` 行号锚点修正）、`index.js:486`（`collectSources` 装填）、`index.js:557`（`prepareArticleTasks` 大档/观察批分割）、`index.js:682`（`localPlan`）、`index.js:699`（`packArticles`）、`index.js:329`（`runRealtimeTasks` 并发池）、`index.js:1024`（`classifySessionTask` 会话通道收割三态）、`index.js:1041`（`buildSessionSteerText`）、`index.js:1097`（`scanRepoFiles`）、`index.js:211`（`ensureWikiEntry`）、`index.js:164`/`index.js:168`/`index.js:178`（`normalizeArticlePath`/`normalizeIndexLinks`/`parseStatus`，`test-cwd-paths.mjs` 与 `test-wiki-entry.mjs` 验证）、`index.js:2584`（`listModelCatalog`）、`index.js:2622`（`resolveModelEfforts`）、`index.js:2904`（`autoCommitWiki`）、`index.js:1202`（`wakeCompileSession`）。预算常量：普通档 110k（`index.js:3023`）、硬上限 128k（`index.js:3023`）、大档默认 420k（`index.js:3023`）。
- **日志文件实现位置与时效**：
  - `.tmp-test-batch.log:76-85`：旧版 `test-batch.mjs` 的运行快照（85 行汇总通过）。**已过期**：其中 `.tmp-test-batch.log:76-83` 记录的「百炼普通端点」请求体断言、`.tmp-test-batch.log:76-83` 的 `resolveBatchApiKey` 用例在当前源码中已被删除（当前脚本反而断言 `resolveBatchApiKey === undefined`，`test-batch.mjs:451-453`，唯一通道改为宿主 llm 服务，`index.js:285-304`）；`.tmp-test-batch.log:76` 的「28k 预算/200k 大档」与当前 110k/128k/420k 三档不符。
  - `.tmp-test-cwd-paths.log:1-8`：cwd 路径归一化测试结果（MSYS `PASS` 在 `:3`，Windows `PASS` 在 `:6`，`ALL PASS` 在 `:8`），与当前脚本语义一致。
  - `.tmp-test-orchestration.log:1-573`：旧版编排冒烟快照，`FAIL：2 项未通过` 在 `:573`（两处失败 `:114`、`:195` 断言的 `source 标记` 为旧格式 `plugin/codewiki`，当前脚本断言的是 `plugin:codewiki`，`test-orchestration.mjs:469`）；`:186-189` 记录的「规划→模块文章→…」与 `:330` 的 `stage=plan` 反映已删除的规划阶段（0.10.7 起 `index.js:1595-1597` 注释明确规划阶段已删，`localPlan` 在 `articles` 阶段就地执行，`index.js:682-687`）；`:563` 的「未找到百炼 API Key」报错对应已移除的直连通道，现为「编译模型提供商为空」诚实报错（`index.js:682`）。
  - `.tmp-test-wiki-anchors.log:1-161`：锚点校验快照（`:1` 校验 15 篇文章，`:161` 汇总 `122 过 / 36 败`）。失败项多为符号绑定不命中（如 `:4` 的 `index.js:164` 应含 `normalizeArticlePath`，而该函数现位于 `index.js:164`；`:146` 的 `ensureWikiEntry` 记在 `index.js:164`，现位于 `index.js:211`）——正是文章产出时代码行号漂移的证据，也是当前流水线在落盘前用 `fixAnchors`（`index.js:398`，由 `applyTaskResult` `index.js:312` 与 `writeValidated` `index.js:1369` 调用）自动校正的动机。
  - `.tmp-test-wiki-entry.log:1-25`：入口生成与路径规范化测试结果，25 行 `全部断言通过`，与当前脚本一致。
  - `watcher2.log:1-1397`：watcher 轮询快照，记录的 job（`job-muwdk1pk-2`、`job-muwdmx5z-0`、`job-muwdmz8x-1`、`job-muwdn4lx-2`）全部停在 `plan` 阶段——该阶段已从当前阶段机移除（`index.js:1012-1018` 无 `plan` 处理器，旧任务由 `index.js:2087-2094` 迁移到 `articles`），因此本文件是排查「规划阶段卡死」时期的历史诊断材料，字段格式（mtime/job/stage/cancelReq/upd/notes）仍反映 `JOBS_FILE` 的持久化结构（`index.js:1147-1152` 的 `saveJobs`）。