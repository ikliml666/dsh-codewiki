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

`test-logging` 是跨模块概念，覆盖 `dsh-codewiki` 插件的测试执行（由 [[test-scripts]] 模块驱动）、核心逻辑验证（针对 [[core-and-config]] 模块的 `index.js`）以及运行期日志产出（落盘于 [[logs-and-temp]] 模块）。该概念描述了端到端测试套件如何通过 `check` 断言函数验证插件导出的纯函数与服务化阶段机（当前阶段机为 articles→crosscut→compose→review→index→commit，由 `index.js:2354-2361` 的 `STAGE_HANDLER` 定义——0.10.7 起删除独立规划阶段、0.10.11 起新增独立 commit 阶段，并在 articles 前增加 queued 串行排队态），并将分组测试结果重定向写入对应的 `.tmp-test-*.log`；同时由外部 watcher 进程以约 30ms 间隔轮询 `index.js` 持久化的编译 job 状态并追加到 `watcher2.log`，从而形成一套用于排查失败与记录运行时输出的测试日志闭环。注意：现有 `.tmp-test-*.log` 与 `watcher2.log` 都是旧版本代码跑出来的快照，其中记录的预算数值、阶段名、失败项与唤醒文案已与当前源码不同（详见 Implementation Map 的时效标注）。

## Involved Modules

1. **test-scripts**：包含 `test-batch.mjs`、`test-cwd-paths.mjs`、`test-orchestration.mjs`、`test-wiki-anchors.mjs`、`test-wiki-entry.mjs` 五个独立脚本，直接 `import` 或 `await import('./index.js')`（`test-batch.mjs:7-12`、`test-orchestration.mjs:24`、`test-cwd-paths.mjs:5`、`test-wiki-entry.mjs:10`）加载被测插件主体，利用各脚本自带的 `check` 断言辅助（`test-batch.mjs:16-19`、`test-orchestration.mjs:27-30`、`test-wiki-anchors.mjs:28-32`、`test-wiki-entry.mjs:13-16`）输出 `✓`/`✗` 结果；`test-cwd-paths.mjs` 不用 `check`，直接打印 `PASS`/`FAIL` 行（`test-cwd-paths.mjs:45`、`test-cwd-paths.mjs:57`、`test-cwd-paths.mjs:68`）。
2. **core-and-config**：提供插件核心 `index.js`（插件入口 `apply` 在 `index.js:3527-3588`，编排服务工厂 `createJobService` 在 `index.js:3527-3591`，阶段机 `articles→crosscut→compose→review→index→commit` 由 `index.js:3527-3534` 的 `STAGE_HANDLER` 定义，提交入口 `submit` 在 `index.js:3527-3591`），导出被验证的纯函数与服务化阶段机，并通过 `JOBS_FILE`（`index.js:3527`）与 `TICK_MS`（`index.js:3527`）驱动任务持久化与 10s tick 推进；测试通过 `DSH_CODEWIKI_TICK_MS`/`DSH_CODEWIKI_JOBS_FILE` 环境变量把 tick 压到 300ms 并隔离到带随机 token 的独立 jobs 文件（`test-orchestration.mjs:15`、`test-orchestration.mjs:32-33`），避免与真实宿主服务实例互相洗写。
3. **logs-and-temp**：纯日志数据模块，由 `.tmp-test-batch.log`、`.tmp-test-cwd-paths.log`、`.tmp-test-orchestration.log`、`.tmp-test-wiki-anchors.log`、`.tmp-test-wiki-entry.log` 及 `watcher2.log` 组成，承接测试断言的 stdout 重定向输出与 watcher 轮询输出；仓库内没有直接写这些文件的代码，它们是运行测试/watcher 时捕获的落盘快照。

## Flow

1. **加载与执行**：测试脚本启动即加载 `core-and-config` 的插件主体（`test-batch.mjs:7-12` 的命名导入、`test-orchestration.mjs:24` 的 `await import('./index.js')`、`test-wiki-entry.mjs:10`；`test-cwd-paths.mjs:20` 导入后调 `apply(ctx, {})` 注册工具）；`test-orchestration.mjs` 导入前先写 `DSH_CODEWIKI_TICK_MS=300`（`test-orchestration.mjs:15`）与带随机 token 的独立 `DSH_CODEWIKI_JOBS_FILE`（`test-orchestration.mjs:22-23`），避免与真实宿主服务实例（同机共享默认路径）互相洗写，收尾统一删除不留残留（`test-orchestration.mjs:19-21` 注释）。
2. **断言与逻辑验证**：脚本用 `fs.mkdtempSync` 构造临时仓库（`test-batch.mjs:32`；`test-orchestration.mjs:103-120` 的 `makeFixtureRepo` 还会 git init（`test-orchestration.mjs:103`）并配置 git identity（`test-orchestration.mjs:113-116`），因为 0.10.9 起 `autoCommitWiki` 缺 user.name/user.email 会拒绝自动提交）；纯函数直接调用断言（如 `fixAnchors` 由 `test-batch.mjs:453-495` 验证、`ensureWikiEntry` 由 `test-wiki-entry.mjs:27` 验证）；编排链路则通过 `makeCtx`（`test-orchestration.mjs:44-84`）注入 mock 的 webServer/tools/agents/llm 服务后执行 `apply(ctx, cfg)`（`test-orchestration.mjs:271`），再触发 `gen.execute`（全量编译在 `test-orchestration.mjs:622`、stale 更新在 `test-orchestration.mjs:857`），测试侧以 `waitJob`（`test-orchestration.mjs:205-218`）轮询 `JOBS_FILE` 等待 `createJobService` 阶段机推进到终态（done/failed/cancelled）。
3. **测试日志落盘**：测试执行进程把分组断言结果按固定文本格式重定向写入对应的 `.tmp-test-*.log`（汇总行：`.tmp-test-batch.log:85` 的 `ALL PASS：59 通过，0 失败`；`.tmp-test-cwd-paths.log:8` 的 `ALL PASS`；`.tmp-test-orchestration.log:573` 的 `FAIL：2 项未通过`；`.tmp-test-wiki-anchors.log:161` 的 `锚点校验：122 过 / 36 败`；`.tmp-test-wiki-entry.log:25` 的 `全部断言通过`）。
4. **Watcher 监听记录**：外部 watcher 进程以约 30ms 间隔（`watcher2.log:1` 首条 40ms，此后每条 +30ms）轮询 `index.js` 落盘的 `JOBS_FILE`，把单行状态（含 `mtime`、job id、`stage`、`cancelReq`、`upd`、`notes` 计数）追加到 `watcher2.log`；日志中可见 job 出现/notes 变化的瞬间（`watcher2.log:20-22` 新 job `job-muwdmx5z-0` 出现，`watcher2.log:305-306` `job-muwdn4lx-2` 的 `notes=0→1`）与 mtime 跳变（`watcher2.log:1294` 起刷新到 `1791272942350`）。
5. **事后审查**：开发者读取日志获知失败总数与失败项（`.tmp-test-orchestration.log:573`，两处失败分别是 `.tmp-test-orchestration.log:114`、`.tmp-test-orchestration.log:195` 的旧格式 `source 标记` 断言）、锚点偏差（`.tmp-test-wiki-anchors.log:161` 的 36 败）以及 job 停留在某阶段的现象（`watcher2.log:1-304` 中 `job-muwdk1pk-2` 长期停在已删除的 `plan` 阶段）。

```text
┌──────────────────┐  import/apply + gen.execute  ┌──────────────────────────────┐
│ test-scripts     │ ───────────────────────────► │ core-and-config              │
│ (test-*.mjs)     │   waitJob 轮询 JOBS_FILE     │ index.js 阶段机 articles→    │
└────────┬─────────┘                              │ crosscut→compose→review→     │
         │ check ✓/✗（stdout 重定向）             │ index→commit（index.js:2259）│
         ▼                                        └────────────┬─────────────────┘
┌──────────────────┐                                           │ job 状态落盘
│ .tmp-test-*.log  │                            ┌──────────────▼────────────────┐
│ （断言汇总快照）  │                            │ JOBS_FILE → watcher2.log      │
└────────┬─────────┘                            │ （~30ms 轮询单行状态）        │
         │                                      └──────────────┬────────────────┘
         └───────────── 事后审查：失败项 / 锚点偏差 / 卡阶段 ───┘
```

## Implementation Map

- **测试脚本入口与断言**：`test-batch.mjs:16-21`（导入被测导出）、`test-batch.mjs:16-19`（`check`）、`test-batch.mjs:20`（`section` 分组打印）、`test-batch.mjs:173-188`（`makeLlm` 假宿主 llm 流式服务：按 block 协议吐 block-start/text-delta/usage/finish，reply 可为字符串、函数或 Error 模拟失败）、`test-batch.mjs:169-205`（`runRealtimeTasks` 宿主 llm 通道：provider/model/routing/temperature=0 断言）、`test-batch.mjs:16-36`（混合档分派：大档任务按自带 provider/model/档位路由，普通任务沿用默认档）、`test-batch.mjs:241-251`（外部 signal 中止）、`test-batch.mjs:253-275`（并发池 + 失败记账）、`test-batch.mjs:16-18`（断言 `mod.resolveBatchApiKey === undefined`——0.10.1 起内置百炼直连通道整体移除）、`test-batch.mjs:453-495`（`fixAnchors` 行号锚点修正全套用例）、`test-batch.mjs:16-20`（汇总与 exit code）；`test-cwd-paths.mjs:20`（`apply` 注册）、`test-cwd-paths.mjs:20-22`（取得 `cw` 工具）、`test-cwd-paths.mjs:20-35`（MSYS 路径 `cw path`）、`test-cwd-paths.mjs:20-30`（Windows 路径 `cw status` 三态）、`test-cwd-paths.mjs:20-28`（不存在路径干净报错）；`test-orchestration.mjs:27-30`（`check`）、`test-orchestration.mjs:38`（`batchCfg` 基线 `workbuddy/hy3`）、`test-orchestration.mjs:44-84`（`makeCtx`：cordis 严格语义 mock，inject 同时支持回调与 promise 两种风格）、`test-orchestration.mjs:103-120`（`makeFixtureRepo`：core/util 两目录 + git identity）、`test-orchestration.mjs:125-133`（`activeLlm`/`llmProxy` 接线：mock 宿主 llm 服务的唯一转发点）、`test-orchestration.mjs:138-202`（`makeBatchMock`：按 prompt 首行特征分发应答，支持 stall 挂起与 bigArticle 放大）、`test-orchestration.mjs:205-218`（`waitJob`）、`test-orchestration.mjs:27-56`（系统提示 wiki 维护提醒：CodeWiki.md 守护收紧）、`test-orchestration.mjs:285-403`（`codewiki_update` wrapper 与 `commitHintText` 各静默/提醒分支）、`test-orchestration.mjs:405-506`（`autoCommitWiki` 安全边界：分支合并式/非 git/gitignore/合并中/identity/detached/分支名占用）、`test-orchestration.mjs:508-518`（`autoCommitState` 三态判定）、`test-orchestration.mjs:520-556`（`wakeCompileSession`：自动提交成功/noChanges 零唤醒、pending 降级唤醒一次，`test-orchestration.mjs:543` 断言 `source.kind === 'plugin:codewiki'`）、`test-orchestration.mjs:27-68`（全量编译 e2e 触发，`test-orchestration.mjs:625` 断言 `stage=articles`）、`test-orchestration.mjs:27-83`（单项目串行：queued 排队与自动轮到）、`test-orchestration.mjs:27-48`（stale 更新触发）、`test-orchestration.mjs:872-908`（`codewiki_progress` 只读查进度）、`test-orchestration.mjs:27-84`（宿主重启后按 prompt 快照重跑 + 旧 plan 任务迁移到 articles）、`test-orchestration.mjs:27-59`（foreign 孤儿任务接管）、`test-orchestration.mjs:27-40`（编译模型缺失诚实报错，断言在 `:1466`、`:1468`）、`test-orchestration.mjs:27-49`（严格 cordis 语义）、`test-orchestration.mjs:27-44`（Temp 残留清理）；`test-wiki-anchors.mjs:38-49`（`symbolsOnLine` 符号提取，与 `index.js:439-448` 同源——`index.js:439-440` 注释明确「两处同源，改一处须同步另一处」）、`test-wiki-anchors.mjs:52-62`（`nearestSymbol` 就近绑定）、`test-wiki-anchors.mjs:28-39`（符号绑定只在单锚点行校验）、`test-wiki-anchors.mjs:28-29`（汇总与 exit code）；`test-wiki-entry.mjs:13`（导入）、`test-wiki-entry.mjs:27`（缺失入口生成）、`test-wiki-entry.mjs:38-39`（已有入口不覆盖）、`test-wiki-entry.mjs:57-72`（Windows `\`→`/` 路径规范化断言）。
- **核心被测实现**（均在 `index.js`）：`index.js:3527-3588`（`apply` 插件入口，测试 `apply(ctx, config)` 的对象），`index.js:3527-3591`（`createJobService`：阶段机 `articles/crosscut/compose/review/index/commit` 由 `index.js:3527-3534` 的 `STAGE_HANDLER` 定义，tick 在 `index.js:3527-3588`——含 queued 排队晋升 `index.js:3527-3537`、旧 plan 任务迁移 `index.js:3527-3535`，提交在 `index.js:3527-3591` 的 `submit`），`index.js:3527-3528`（`JOBS_FILE`/`TICK_MS`，watcher 与 `waitJob` 的轮询目标）；会话通道超时与任务目录见 `index.js:3527-3528`，孤儿接管阈值见 `index.js:3527`；`index.js:3527-3535`（`estimateTokens`）、`index.js:3527-3529`（`numberLines` 行号前缀）、`index.js:3527-3591`（`fixAnchors` 行号锚点修正）、`index.js:3527-3554`（`collectSources` 装填）、`index.js:3527-3591`（`prepareArticleTasks` 大档/观察批分割）、`index.js:3527-3540`（`localPlan`）、`index.js:3527-3546`（`packArticles`）、`index.js:3527-3552`（`llmChat` 宿主 llm 服务唯一通道）、`index.js:3527-3564`（`runRealtimeTasks` 并发池）、`index.js:3527-3537`（`classifySessionTask` 会话通道收割三态）、`index.js:3527-3545`（`buildSessionSteerText` 档位钉死）、`index.js:3527-3550`（`scanRepoFiles`）、`index.js:220-253`（`ensureWikiEntry`）、`index.js:173`/`index.js:177-185`/`index.js:187-200`（`normalizeArticlePath`/`normalizeIndexLinks`/`parseStatus`，`test-cwd-paths.mjs` 与 `test-wiki-entry.mjs` 验证）、`index.js:3527-3548`（`listModelCatalog`）、`index.js:3527-3549`（`resolveModelEfforts`）、`index.js:3527-3591`（`autoCommitWiki` 分支合并式自动提交）、`index.js:3527-3532`（`autoCommitState`）、`index.js:3527-3542`（`wakeCompileSession`）、`index.js:3527-3558`（`commitHintText`）、`index.js:3527-3529`（`slugify` 保留 CJK）、`index.js:3527-3539`（`parseSourceFiles`）。落盘闸门：`index.js:3527-3543`（`writeValidated`，`index.js:1587` 调 `fixAnchors`）与 `index.js:3527-3540`（`applyTaskResult`，`index.js:3527` 调 `fixAnchors`）；持久化 `index.js:3527-3532`（`saveJobs`）。预算常量：普通档 110k（`index.js:3527`）、硬上限 128k（`index.js:3527`）、大档默认 420k（`index.js:3527`，大档模型默认 volces-ark/glm-5.3-flash，`index.js:3527-3528`）。
- **日志文件实现位置与时效**：
  - `.tmp-test-batch.log:76-85`：旧版 `test-batch.mjs` 的运行快照（`:85` 汇总通过）。**已过期**：其中 `:36-43` 记录的「百炼普通端点」请求体断言与 `:76-83` 的 `resolveBatchApiKey` 用例在当前源码中已被删除（当前脚本反而断言 `resolveBatchApiKey === undefined`，`test-batch.mjs:451-453`，唯一通道改为宿主 llm 服务，`index.js:386-411` 的 `llmChat` 与 `index.js:386-423` 的 `runRealtimeTasks`）；`:22-24` 的「28k 预算/200k 大档」与当前 110k/128k/420k 三档不符（`index.js:386`、`index.js:386`、`index.js:386`）。
  - `.tmp-test-cwd-paths.log:1-8`：cwd 路径归一化测试结果（MSYS `PASS` 在 `:3`，Windows `PASS` 在 `:6`，`ALL PASS` 在 `:8`），与当前脚本语义一致。
  - `.tmp-test-orchestration.log:1-573`：旧版编排冒烟快照，`FAIL：2 项未通过` 在 `:573`（两处失败 `:114`、`:195` 断言的 `source 标记` 为旧格式 `plugin/codewiki`，当前脚本断言的是 `plugin:codewiki`，`test-orchestration.mjs:543`；该块的标题也从 `:110` 的「与子代理 send_message 同机制」改为 `test-orchestration.mjs:520` 的「插件已自动提交时完全不打扰会话」）；`:186`、`:188` 与 `:330` 记录的「规划→模块文章→…」与 `stage=plan` 反映已删除的规划阶段（0.10.7 起 `index.js:800-802` 注释明确规划阶段已删，`localPlan` 在 `articles` 阶段就地执行，见 `index.js:800-921` 的 `tickArticles`；当前断言为 `test-orchestration.mjs:625` 的 `stage=articles` 与 `test-orchestration.mjs:583`/`test-orchestration.mjs:608` 的零勘探员请求）；`:137` 的「规划走主模型」notes 同属已删除的主模型规划链路；`:547-563` 的「未找到百炼 API Key」报错对应已移除的直连通道，现为「编译模型提供商为空」诚实报错（`index.js:800`，测试断言在 `test-orchestration.mjs:1466-1468`）。
  - `.tmp-test-wiki-anchors.log:4-161`：锚点校验快照（`:1` 校验 15 篇文章、`index.js 2508 行`——当前 `index.js` 已增长到 3464 行，`:161` 汇总 `122 过 / 36 败`）。失败项多为符号绑定不命中——如 `:4` 断言 `normalizeArticlePath`/`parseStatus`/`rel_path_string` 应出现在 `index.js:173`（当前 `normalizeArticlePath` 在 `index.js:173`）——正是文章产出时代码行号漂移的证据，也是当前流水线在落盘前用 `fixAnchors`（`index.js:173`，由 `applyTaskResult` `index.js:173` 与 `writeValidated` `index.js:173` 调用）自动校正的动机。
  - `.tmp-test-wiki-entry.log:1-25`：入口生成与路径规范化测试结果，25 行 `全部断言通过`，与当前脚本一致。
  - `watcher2.log:1-1394`：watcher 轮询快照，记录的 job（`job-muwdk1pk-2`、`job-muwdmx5z-0`、`job-muwdmz8x-1`、`job-muwdn4lx-2`）全部停在 `plan` 阶段——该阶段已从当前阶段机移除（`index.js:2354-2361` 的 `STAGE_HANDLER` 无 `plan` 处理器，旧任务由 `index.js:2354-2362` 迁移到 `articles`，迁移场景的回归测试在 `test-orchestration.mjs:939-965`），因此本文件是排查「规划阶段卡死」时期的历史诊断材料；字段格式（mtime/job/stage/cancelReq/upd/notes）仍反映 `JOBS_FILE` 的持久化结构（`saveJobs` `index.js:2354-2359`）。
