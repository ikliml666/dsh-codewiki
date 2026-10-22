---
title: patterns
type: pattern
source_files:
  - index.js
  - client.js
  - test-batch.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
tags: [patterns, architecture, concurrency, error-handling, token-budget]
---

## Overview

`dsh-codewiki` 是一个 cordis 插件（`index.js` 后端 + `client.js` 浏览器端），把本地 Rust CLI `cw`（mraza007/codewiki 的 fork）包装成 DSH 的三件套工具：`cw`、`codewiki_generate`、`codewiki_progress`。整条流水线「规划 → 写模块文章 → 横切 → 合成 → 校对 → 索引」全部走阿里云百炼的**普通** `chat/completions` 端点（或宿主 llm 服务），**零子代理**；唯一的例外是「超预算」任务会被降级派发到发起会话，由会话模型自己再派子智能体（见「会话通道」）。

本文横切出这套代码里反复出现、可复用的模式。核心是七条：

1. **占位先行的提交-异步推进状态机**：`submit()` 先落一个 `stage:'submitting'` 的 job 占位，再等凭证、再定阶段；推进由 10s tick 循环按阶段 handler 表驱动，长请求永不阻塞 tick。
2. **多实例并发安全三件套**：实例身份 `owner` + 脏标记 `dirty`/`dirtyIds` + 磁盘吸收 `mergeFromDisk()`，外加跨进程 tick 锁与「停更即孤儿」的接管判定。
3. **Token 预算的分层降级**：`BATCH_TOKEN_BUDGET = 28000`（≤32k 低价档）→ 200k 大档 → 观察-合成拆分 → 会话通道，四层逐级降级，而不是一次性把请求推到 3 倍价档。
4. **每层都有确定性兜底**：规划失败 → `localPlan` 按顶层目录分组；模型输出缺 frontmatter → 拒绝落盘；行号幻觉 → `fixAnchors` 对照源码确定性校正；锚点仍存疑 → 只记 notes 不改文。
5. **通道二选一 + 凭证诚实报错**：`batchProvider` 非空走宿主 llm 服务（凭证宿主解析），为空走百炼直连（凭证库/配置）；**取不到凭证直接 fail，不降级子代理、不静默重试**。
6. **零状态派生**：收尾提醒、面板进度、KnownRepo 清单全部由 `jobs.json` + `git log` 派生，没有需要单独维护的「已提醒/已提交」布尔位。
7. **cordis 严格语义防御**：服务一律经 `ctx.inject([...])` 取，绝不裸访问 `ctx.xxx`；工具注册逐个 `try/catch`，避免单个 schema 违规回滚全部已注册工具。

## Key Components

### 后端核心（`index.js`，2869 行）

常量与配置：

| 名称 | 行号 | 用途 |
| :--- | :--- | :--- |
| `PLUGIN_NAME` / `name` | `index.js:18` / `index.js:19` | 插件 id `dsh-codewiki` |
| `CW_SUBCOMMANDS` | `index.js:20` | 允许透传给 `cw` 的子命令白名单（`init/status/index/meta/path/projects/setup/uninstall`） |
| `CONCURRENCY_HARD_CAP` | `index.js:22` | 编译请求并发硬顶 8（`maxConcurrency` 只能在 1–8 内） |
| `Config` | `index.js:37` | zod 配置 schema（16 个字段，全部 `.volatile()` 热生效） |
| `BAILIAN_BASE` | `index.js:361` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `BATCH_TOKEN_BUDGET` | `index.js:364` | 单请求输入预算 28000（留 ~4k 给估算误差与消息骨架） |
| `BATCH_TOKEN_HARD_LIMIT` | `index.js:368` | 会话通道任务文件装填上限 200000（0.9.0 起不再「升档提交」） |
| `JOBS_FILE` | `index.js:1015` | `os.tmpdir()/dsh-codewiki-jobs.json`，可用 `DSH_CODEWIKI_JOBS_FILE` 覆盖 |
| `TICK_MS` | `index.js:1016` | tick 间隔，默认 10000ms，最小 250ms，`DSH_CODEWIKI_TICK_MS` 可覆盖 |
| `SESSION_TASK_TIMEOUT_MS` | `index.js:1020` | 会话通道超时，默认 30min，下限 5min |
| `SESSION_TASK_DIR` | `index.js:1021` | 会话任务文件目录（与 jobs 同目录，宿主重启后可收割） |
| `ORPHAN_TAKEOVER_MS` | `index.js:1039` | 孤儿接管阈值：他实例 job 停更超 5min 视为宿主重启遗留 |
| `MAX_JOBS_KEPT` | `index.js:1040` | 落盘只保留最近 30 个 job |
| `REPOS_FILE` | `index.js:1045` | `dsh-codewiki-repos.json`，已知仓库登记（独立于 job 历史） |
| `JOB_TERMINAL` | `index.js:1058` | 终态集合 `done/failed/cancelled` |
| `SCAN_SKIP_DIRS` / `SCAN_SKIP_EXT` | `index.js:1061` / `index.js:1066` | 勘探黑名单目录与二进制后缀 |
| `SCAN_MAX_FILE_BYTES` / `SCAN_MAX_FILES` | `index.js:1072` / `index.js:1073` | 单文件 256KB、总数 2000 的勘探闸门 |

公开函数：

| 函数 | 行号 | 用途 |
| :--- | :--- | :--- |
| `normalizeCwd(input)` | `index.js:26-31` | win32 把 MSYS 风格 `/e/...` 归一化成 `E:/...`（POSIX 原样返回） |
| `liveConfig(config)` | `index.js:57-76` | 把 cordis 的 `{get()}` 配置对象拍平成普通对象，并钳住 `maxConcurrency`/`autoUpdateMin`/`batchThinkingBudget` |
| `resolveBinary(cfg)` | `index.js:82-102` | cw 可执行文件解析：`binaryPath` → PATH（`where`/`which`）→ 插件自带 `bin/cw(.exe)` |
| `runCw(binary, cwd, args, timeoutMs, signal)` | `index.js:104-129` | spawn 子进程跑 cw，内置超时 SIGKILL 与 abort 监听，永不 reject |
| `normalizeArticlePath(p)` | `index.js:141` | `\` → `/` |
| `normalizeIndexLinks(cwd)` | `index.js:145-153` | 只改 `_index.md` 里 `[[link|title]]` 的链接头，幂等 |
| `parseStatus(stdout)` | `index.js:155-168` | 解析 `cw status` 三态 + `M`/`!` 逐行清单 |
| `ensureWikiEntry(cwd, language)` | `index.js:188-221` | 仓库根缺 `CodeWiki.md` 时按语言生成入口；已有入口绝不覆盖 |
| `estimateTokens(text)` | `index.js:247-255` | CJK ≈ 1 token/字，其余 ≈ 3.5 字符/token 的粗算 |
| `excludedItem(cwd, list)` / `isExcluded` | `index.js:226-235` / `index.js:236-238` | 排除清单前缀匹配，返回命中项原文（报错据此告诉模型是哪条拒绝的） |
| `numberLines(content)` | `index.js:379-381` | 源码逐行加 `N| ` 前缀，让模型引用行号时有锚 |
| `fixAnchors(content, cwd)` | `index.js:390-473` | 落盘前把 `file:NN` 锚点对照源码确定性校正（只改数字） |
| `collectSources(cwd, files, budget)` | `index.js:478-505` | 整文件装填源码，返回 `{text, skipped, oversized}` |
| `resolveBatchApiKey(hostCtx, cfg)` | `index.js:546-566` | 凭证解析：配置 → 宿主 `credentials` 服务（3s 竞速超时） |
| `prepareArticleTasks(tasks, opts)` | `index.js:578-636` | 文章任务装配：单请求 / 观察批拆分 / 会话通道三分流 |
| `localPlan(files)` | `index.js:697-710` | 本地兜底规划：按顶层目录分组 |
| `packArticles(articles, budget)` | `index.js:714-733` | 横切输入装配：整篇，装不下只取 `## Key Components` 之前的头部并标注 |
| `scanRepoFiles(cwd)` | `index.js:1075-1098` | 仓库源码勘探（黑名单 + 后缀 + 双上限） |
| `classifySessionTask(task, nowMs)` | `index.js:1027-1037` | 会话任务三态裁决 `timeout`/`harvest`/`wait`（纯函数，测试直接断言） |
| `loadKnownRepos()` / `rememberRepo(cwd)` | `index.js:1046-1048` / `index.js:1049-1057` | 已知仓库清单读写（大小写归一去重） |
| `wakeCompileSession(job, outcome, agents)` | `index.js:1179-1190` | 终态 steer 唤醒发起会话；无 `sessionId`/无 agent/无 `steer` 一律静默返回 |
| `samePath(a, b)` | `index.js:2368` | 跨平台路径相等判定（归一 + 小写） |
| `progressView(job)` | `index.js:2373-2378` | 面板百分比 = done/taskList.length |
| `listModelCatalog(llm)` | `index.js:2503` | 汇总宿主 provider 与各 provider 的 model 目录 |
| `installWebServer(ctx, service, extra)` | `index.js:2526-2722` | 注册 4 个 HTTP 端点（jobs/repos/models/control） |
| `commitHintText(cwd, jobs)` | `index.js:2737-2762` | 「编译产物未提交」提醒，零状态派生 + 60s TTL |
| `apply(ctx, config)` | `index.js:2809-2869` | 插件入口：注入服务、启服务与调度器、注册工具与端点 |

内部编排（`createJobService`，`index.js:1192`）：

| 成员 | 行号 | 作用 |
| :--- | :--- | :--- |
| `instanceId` | `index.js:1200` | `svc-<ts36>-<rand6>`，job 归属标记 |
| `dirty` / `dirtyIds` | `index.js:1203` / `index.js:1206` | 脏标记 + 本实例改过的 job id |
| `persist()` | `index.js:1207` | 只标脏，不写盘 |
| Temp 残留清理 | `index.js:1210-1221` | 启动即移除 cwd 在系统临时目录的终态任务，并**立即** `saveJobs` |
| `mergeFromDisk()` | `index.js:1224-1245` | 磁盘吸收：新增 job 并入；同 id 且磁盘更新且本实例没动过才覆盖 |
| `flush()` | `index.js:1246-1249` | 脏才写：`mergeFromDisk` → 清标记 → `saveJobs` |
| `note()` / `touch()` | `index.js:1250-1253` / `index.js:1256-1258` | notes 上限 50 条；touch 是状态变更唯一入口（必标脏） |
| `setStage()` | `index.js:1261-1271` | 阶段切换唯一入口：累计 `stageTimings` 并重置 `stageStartedAt` |
| `addUsage()` | `index.js:1273-1282` | 用量累计（输入估算、输出实测、overTier2 计数） |
| `syncCancelFlags()` | `index.js:1286-1297` | 每轮 tick 开头从磁盘拾取跨实例取消标记 |
| `fail()` | `index.js:1299-1307` | 置 failed + 记 error/finishedAt；`submitting` 期失败不唤醒会话 |
| `apiKeyOf(job)` | `index.js:1310-1317` | 凭证内存缓存优先，不落盘 |
| `settleJob(job)` | `index.js:1320-1341` | 阶段收割统一入口；执行器丢失时按 `job.tasks` 的 prompt 快照重跑 |
| `writeValidated(job, task, content)` | `index.js:1346-1362` | keepInMemory 结果的唯一落盘闸门（frontmatter 校验 + fixAnchors） |
| `tally(job, results, tasks, {replace})` | `index.js:1365-1386` | 结果记账；`replace:true` 用于校对不推翻原文 |
| `startBatchChatRun(job, prepared)` | `index.js:1395-1438` | 后台并发池执行器（结果进 `batchResults`，tick 不被阻塞） |
| `submitBatchFor(job, prepared)` | `index.js:1440-1460` | 提交阶段批次：记用量、快照 `job.tasks`、启动执行器 |
| `dispatchSessionTasks(job, tasks)` | `index.js:1467-1513` | 会话通道派发：写任务文件 + steer 短消息 |
| `progressSessionTasks(job)` | `index.js:1517-1536` | 会话通道收割（三态裁决 → 落盘/记失败/等待） |
| `resendSessionSteer(job)` | `index.js:1540-1561` | 宿主重启接管后重发一次 steer（不重置 dispatchedAt） |
| `tickPlan` | `index.js:1565-1608` | 规划阶段（主模型优先，失败降级百炼批量，再失败 `localPlan`） |
| `runMainModelPlan(job, prompt)` | `index.js:1614-1662` | 主模型规划：`agent.session.requestHeader().config` → `agent.options` 两级路由 |
| `tickArticles` | `index.js:1665-1775` | 文章阶段（含 `#obs` 观察批收割与合成任务重建） |
| `crosscutTasks(job, pack)` | `index.js:1778-1797` | 横切合成任务：`_architecture.md`、`_patterns.md` + 每个概念一篇 |
| `tickCrosscut` | `index.js:1799-1862` | 横切阶段（总量 ≤28k 单批直出，否则拆观察批） |
| `tickCompose` | `index.js:1865-1877` | 合成批收尾 |
| `submitComposeBatch(job, pack)` | `index.js:1879-1889` | 合成批提交，失败降级跳过横切 |
| `localReview(job)` | `index.js:1892-1912` | 本地核对：frontmatter、`source_files` 存在性 |
| `tickReview` | `index.js:1914-1977` | 校对阶段（含超预算校对转会话通道） |
| `tickIndex` | `index.js:1979-2002` | 收尾：`cw index` + `cw meta update` + `normalizeIndexLinks` + `ensureWikiEntry` |
| `STAGE_HANDLER` | `index.js:2004-2011` | 阶段 → handler 映射表 |
| `tick()` | `index.js:2013-2057` | 一轮推进：抢锁、同步取消、逐 job 推进、孤儿接管、flush |
| `submit(opts)` | `index.js:2059-2116` | 提交任务（占位先行 + 幂等 + 凭证校验 + 立即推进一次） |
| `cancel(jobId)` | `index.js:2118-2127` | 标记取消（不直接中断，交给下一轮 tick 收尾） |
| `list()` / `findActive()` | `index.js:2129` / `index.js:2130` | 面板视图 / 同 cwd 活动任务查询 |
| `start()` / `stop()` | `index.js:2132-2136` / `index.js:2137-2140` | `setInterval(tick, TICK_MS)` + unref；停止清定时器 |

### 前端（`client.js`，1189 行）

挂载：`window.__ModuleLoader__.load({ id: '@local/dsh-codewiki' })`（`client.js:10`），只依赖 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（`client.js:13-15`）。

| 名称 | 行号 | 用途 |
| :--- | :--- | :--- |
| `NS` / `KEY` | `client.js:17` / `client.js:18` | 配置命名空间与面板 key（必须与 `sidebar.panellist` 的 id 一致） |
| `JOBS_PATH` / `CONTROL_PATH` | `client.js:19` / `client.js:20` | 后端端点常量 |
| `PANEL_ORDER` | `client.js:21` | 面板排序 52（排在 hindsight 的 50 之后） |
| `POLL_MS` / `REPOS_POLL_MS` | `client.js:22` / `client.js:25` | 2s 拉任务、10s 拉仓库总览 |
| `ACTIVE_STAGES` | `client.js:26` | 六阶段列表，与后端 `STAGE_HANDLER` 对齐 |
| `apiGet(p)` / `apiPost(p, data)` | `client.js:347` / `client.js:353` | 极薄的 fetch 包装 |
| `CodewikiCard` | `client.js:406-` | 设置卡：快照 + 草稿 + 逐字段 diff 的乐观锁保存 |
| `save()` | `client.js:475-502` | 校验 1–8 / 0–32768，逐字段产出 `set` op，带 `snapshot.revision` 提交 |
| `Spark` | `client.js:729` | SVG 折线图（tps 滚动窗口） |
| `stageBar(job)` | `client.js:750-773` | 六阶段步骤条（当前/已完成/失败着色） |
| `STAGE_WEIGHTS` / `overallPct(job)` | `client.js:774` / `client.js:775-784` | 阶段加权总进度 |
| `throughputBadge` | `client.js:786` | 吞吐徽标（tps + EWMA ETA） |
| `usageLine(job)` | `client.js:808` | 用量行（输入/输出 token、请求数、overTier2） |
| `ReposTab` | `client.js:827-` | 仓库总览页（编译/排除/刷新） |
| `CodewikiPanel` | `client.js:972-1172` | 面板主体：2s 轮询、本地采样、分组渲染 |
| 轮询 effect | `client.js:985-1025` | `pull()` + `inFlight` 防重叠 + `alive` 防卸载后 setState |
| `sparkRef` / `batchRateRef` | `client.js:980` / `client.js:981` | 面板侧采样：tps 30 点窗口、EWMA 速率 |
| EWMA 更新 | `client.js:1009` | `rate = prev.rate * 0.6 + inst * 0.4` |
| `mountedRef` | `client.js:1028-1029` | 卸载后不再 setState |
| `cancel(jobId)` | `client.js:1030-1038` | POST `control` 端点 |

### 测试（5 个 `.mjs`，无框架，`check()` 断言 + 非零退出）

| 文件 | 覆盖 |
| :--- | :--- |
| `test-batch.mjs` | 纯函数单元测试：`estimateTokens`（`test-batch.mjs:23`）、`collectSources`（`:30`）、`numberLines`（`:46`）、`prepareArticleTasks` 的 oversized 与观察批分割（`:53`、`:83`）、`classifySessionTask` 三态（`:104`）、`runRealtimeTasks` 的端点/思考参数/signal/并发池/宿主 llm 通道（`:122`、`:149`、`:161`、`:174`、`:248`）、`localPlan`（`:201`）、`packArticles`（`:214`）、`scanRepoFiles`（`:227`）、`listModelCatalog` 与 `/api/codewiki/models`（`:289`、`:313`） |
| `test-orchestration.mjs` | 全链路集成：系统提示提醒（`test-orchestration.mjs:201`）、注册（`:232`）、`cw` 工具（`:245`）、固定 scope 的 `codewiki_update`（`:252`）、终态实时唤醒（`:331`）、主模型规划（`:359`）、全量编译（`:510`）、横切精准拆分（`:542`）、文章阶段分割（`:572`）、零专用批量端点（`:606`）、stale 预构建任务（`:639`）、`codewiki_progress`（`:662`）、宿主重启重跑（`:698`）、占位与 flush 合并（`:755`）、面板端点（`:794`）、排除清单/总览/compile（`:848`）、knownRepos 与 refresh（`:903`）、workspaceOnly 过滤（`:943`）、registry 降级（`:990`）、output schema（`:1020`）、孤儿接管（`:1060`）、无凭证诚实报错（`:1094`）、严格 cordis 语义（`:1106`）、Temp 残留清理（`:1130`） |
| `test-wiki-anchors.mjs` | 锚点制度化校验：`symbolsOnLine`（`test-wiki-anchors.mjs:36-47`）、遍历全部文章（`:67`）、锚点正则（`:71`）、符号绑定断言（`:88-92`） |
| `test-wiki-entry.mjs` | `CodeWiki.md` 入口生成与 Windows 路径规范化 |
| `test-cwd-paths.mjs` | MSYS 盘符路径在 cw 调用链上的兼容性 |

## Architecture

```text
┌─────────────────────────────── client.js ───────────────────────────────┐
│ CodewikiCard(406) 配置读写 ──┐            CodewikiPanel(972) 2s 轮询     │
│   form.getSnapshot/mutate    │             └ sparkRef/batchRateRef 采样 │
└──────────────────────────────┼──────────────────────────────────────────┘
                    HTTP ▼ /api/codewiki/{jobs,repos,models,control}
┌────────────────────────────── index.js ─────────────────────────────────┐
│ installWebServer(2526) loopback 守卫 + 30s 缓存                          │
│        ▼                                                                 │
│ createJobService(1192)  jobs[] / instanceId / dirty / mergeFromDisk      │
│   tick(2013) ── 10s ──► STAGE_HANDLER(2004)                              │
│     plan(1565) ► articles(1665) ► crosscut(1799) ► compose(1865)         │
│                                              ► review(1914) ► index(1979)│
│   submitBatchFor(1440) ──► startBatchChatRun(1395) 并发池                 │
│            │                      │ 百炼 chat/completions  ▲ llm.stream  │
│            ▼                      ▼                                      │
│   prepareArticleTasks(578)  runRealtimeTasks(324) ──► writeValidated(1346)│
│     ├ 单请求 ≤28k             │                          │ fixAnchors(390)│
│     ├ 观察批 #obs 拆分        └► batchResults ─ settleJob(1320) ─ tally   │
│     └ 会话通道 dispatchSessionTasks(1467) ──steer──► 发起会话 → 子智能体  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. 提交：占位先行

`submit()`（`index.js:2059`）的顺序是刻意排的：

1. 排除清单先拦：`excludedItem(cwd, excludePaths)` 命中就抛错并附命中项原文（`index.js:2061-2064`）。
2. `rememberRepo(cwd)` 登记工作区（`index.js:2065`）。
3. 同 cwd 已有非终态 job → 直接返回 `{job, existed: true}`，天然幂等（`index.js:2066-2067`）。
4. **占位先行**：先 push 一个 `stage: 'submitting'` 的 job 并 `persist()`（`index.js:2069-2090`）。`resolveBatchApiKey` 最长等 3s，这段时间里的并发提交靠「非终态 stage」挡住重复，而不是靠锁。
5. 再解析凭证（`index.js:2092-2107`）；失败走 `fail()` 同步抛出，让工具调用立即看到原因。
6. `setStage(job, kind === 'full' ? 'plan' : 'articles')`（`index.js:2110`）——stale 走预构建任务直达文章阶段。
7. `persist()` + `flush()` 先落盘，再 `void tick()` 立即推进一步（`index.js:2112-2114`）。

### 2. 推进：tick 锁 + 阶段表

`tick()`（`index.js:2013`）每轮：

- `ticking` 单飞 + `acquireTickLock()`（`index.js:1108`）——用 `writeFileSync(..., {flag:'wx'})` 排他创建锁文件；残留锁 60s 过期强删重建（`index.js:1114-1118`），`finally` 里 `releaseTickLock()`。
- `syncCancelFlags()` 先把别的实例写的取消标记吸进内存（`index.js:2018`）。
- 逐 job：终态跳过；`owner !== instanceId` 且停更 ≤ `ORPHAN_TAKEOVER_MS` 让别人推（`index.js:2021-2025`），超过就接管并 `resendSessionSteer`（`index.js:2026-2029`）；`submitting` 占位跳过（`index.js:2031`）；`cancelRequested` → 置 cancelled + `abort()` 在飞请求 + 丢弃未收割结果（`index.js:2032-2041`）。
- 取 `STAGE_HANDLER` 执行，handler 抛错 → `fail(job, 阶段 … 异常)`（`index.js:2043-2049`）；终态立即 `persist()`；末尾 `flush()`。

### 3. 装配：四层预算降级

`prepareArticleTasks()`（`index.js:578`）是预算策略的汇聚点：

1. `collectSources(cwd, sources)` 用 28000 装填（`index.js:582`）。
2. `oversized`（第一个文件都装不下）→ 改按 200000 装填（`index.js:583-585`）。
3. 未 oversized 但「有文件被跳过」或「prompt 估算超 28k」→ 逐文件装 28k 观察批（`index.js:592-606`）；分得出多批 → 产出 `#obs` 任务，携带 `splitFor` 与 `composePlan`（`index.js:607-623`）。
4. 单文件连 28k 都装不下、或分不出多批 → `forceSession`，按 200k 装填后进 `sessionTasks`（`index.js:625-631`）。

收割侧对应 `tickArticles`（`index.js:1665`）：`#obs` 结果按文章聚合，**每篇只重建一条**合成任务（`composedArticles` 去重，`index.js:1684-1689`）；某篇观察全失败则该篇缺席本轮而非整 job 失败（`index.js:1692-1695`）；部分失败基于剩余观察合成（`index.js:1696`）。

横切同理但更简单：`tickCrosscut`（`index.js:1799`）用**原始总量**判拆分（`index.js:1838`，因为 `packArticles` 只截头部、pack 体积永远装得下，不能作依据）；超预算时每篇模块文章一个 `_obs/` 观察任务，收齐后 `setStage('compose')` 提交合成批（`index.js:1849-1857`、`index.js:1821-1822`）。

### 4. 执行：后台并发池

`startBatchChatRun()`（`index.js:1395`）把 `runRealtimeTasks`（`index.js:324`）挂到后台：
- `batchRuns`/`batchResults`/`batchAborters` 三个 Map 分别承担「存活标记」「收割结果」「取消中断」（`index.js:1392-1394`）。
- 成功 `batchResults.set(job.id, [...rs.values()])`，失败 `set(job.id, null)` 并 `fail`（`index.js:1420-1430`）。
- `finally` 里删 Map 条目，终态再清 `batchResults`（`index.js:1431-1435`）。
- `onTaskDone` 每任务上报 `{outputTokens, durationMs}`，进 `tpsSamples`（保留 20 条）并 `addUsage`（`index.js:1412-1418`）。

`settleJob()`（`index.js:1320`）的返回契约：`null` = 还在跑（下轮再看）、数组 = 已收割、执行器丢失 → 有完整 prompt 快照就重跑（`index.js:1332-1338`），否则 `fail` 报「无法重跑」（`index.js:1339`）。

### 5. 会话通道：超预算外包给会话

`dispatchSessionTasks()`（`index.js:1467`）：
1. 从 `agentsRef.get(job.sessionId)` 取 agent；没有 `steer` 就 `fail` 并提示「从会话内重新提交编译」（`index.js:1469-1473`）——不静默。
2. 把每个任务的完整 prompt 写入 `SESSION_TASK_DIR/<jobId>--<safe>.prompt.txt`（`index.js:1477-1484`）。
3. steer 一条短消息（说明任务文件路径与目标文章路径，review 阶段用校对措辞，`index.js:1491-1504`）。

收割侧 `progressSessionTasks()`（`index.js:1517`）每 tick 调 `classifySessionTask()`（`index.js:1027`，纯函数）：超时记失败不降级百炼、`harvest` 走 `writeValidated` 落盘、`wait` 留待下轮；`review` 阶段 `tally` 用 `replace: true`（`index.js:1534`）。

### 6. 质量闸门：落盘前四道

1. **frontmatter 闸**：`writeValidated`（`index.js:1346`）与 `applyTaskResult`（`index.js:305`）都要求输出 `trimStart()` 以 `---` 开头，否则不落盘、保留原文件。
2. **行号锚点校正**：`fixAnchors`（`index.js:390`）在写盘前把正文里 `file:NN(-MM)` 的锚点对照源码核验——该行应含同行反引号内符号（`index.js:410-420`）；不含则全文找，唯一命中即修正、多处命中再试「声明形态」（`index.js:447-454`）、仍歧义/找不到就只记 unresolved 不改（`index.js:459-461`）；区间尾越界钳到文件尾（`index.js:466`）。全部修正只改数字，不动文章其他内容。
3. **本地核对**：`localReview`（`index.js:1892`）检查 frontmatter 与 `source_files` 是否存在（`index.js:1905-1909`），文件丢失还会把 `writtenCount` 回退（`index.js:1902`）。
4. **索引收尾**：`tickIndex`（`index.js:1979`）跑 `cw index` + `cw meta update`，任一非零只在 notes 提示「基线可能未刷新」，不推翻任务；`normalizeIndexLinks` 与 `ensureWikiEntry` 各自独立 try/catch（`index.js:1987`、`index.js:1991-1995`）。

### 7. 前端：轮询 + 本地采样

`CodewikiPanel`（`client.js:972`）不依赖后端推流：2s 拉 `/api/codewiki/jobs`，`inFlight` 保证不重叠（`client.js:989`），`alive` 保证卸载后不 setState（`client.js:986`）。速率与 ETA 由面板自己算：`sparkRef` 保留最近 30 个 tps（`client.js:997-1002`）、`batchRateRef` 用 `0.6/0.4` 的 EWMA 平滑瞬时完成速率（`client.js:1007-1011`）。总进度用 `STAGE_WEIGHTS` 加权：`plan 0.05 / articles 0.6 / crosscut 0.1 / compose 0.05 / review 0.15 / index 0.05`（`client.js:774-784`）。

### 8. 收尾提醒：零状态派生

`commitHintText()`（`index.js:2737`）不存「已提醒」状态：取本 cwd 最近一次 `stage==='done' && writtenCount>0` 的 job（`index.js:2743-2745`），和 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 比时间戳（`index.js:2747-2750`），编译更晚才注入提醒；提交后时间戳反超自动静默。60s TTL 缓存因为系统提示每次组装都会求值（`index.js:2739-2740`）。`installUpdateReminder`（`index.js:2775`）的 `text` 回调实时读开关、cwd、入口文件存在性（`index.js:2788-2791`），所以切仓库/关开关/删 wiki 都无需重启。

## Connections

- [[core-application]]：`apply()`（`index.js:2809`）是整个插件的装配点，工具定义、服务、调度器、端点都在这里接线。
- [[client-interface]]：`client.js` 与后端只通过 4 个 HTTP 端点耦合（`index.js:2569`、`index.js:2589`、`index.js:2675`、`index.js:2691`）。
- [[configuration-and-metadata]]：`Config`（`index.js:37`）与 `liveConfig`（`index.js:57`）是所有可调参数的唯一来源，设置卡通过 `configForms` 写入。
- [[wiki-generation-flow]]：六阶段流水线与 token 预算策略的叙述性说明，本文只从模式角度归纳。
- [[test-suite]] / [[testing-suite]]：本文引用的 5 个 `.mjs` 测试是该模块唯一的验证手段（无框架、`check()` + 非零退出）。
- [[runtime-artifacts]]：`JOBS_FILE`（`index.js:1015`）、`REPOS_FILE`（`index.js:1045`）、`SESSION_TASK_DIR`（`index.js:1021`）与 `JOBS_FILE.lock`（`index.js:1105`）是运行时产物面。
- [[learnings-cw-binary-source-lost]]：`resolveBinary`（`index.js:82`）PATH 优先的注释记录了这一历史教训。

## Known Issues

1. **孤儿接管有 5 分钟空窗**：`ORPHAN_TAKEOVER_MS`（`index.js:1039`）默认 5min，宿主崩溃重启后旧 job 最多空转 5min 才被接管；期间面板进度静止，`codewiki_progress` 也不会报错。
2. **执行器丢失后的重跑依赖 prompt 快照**：`settleJob`（`index.js:1320`）只有在 `job.tasks` 全部带 `batchPrompt` 时才能重跑（`index.js:1332-1333`），否则整 job `fail`（`index.js:1339`）——重跑会重复计费，注释已明示「幂等：文章重写覆盖」。
3. **会话通道超时不降级**：`classifySessionTask`（`index.js:1027`）超时直接记失败（`index.js:1522-1524`），设计上不接受「退回百炼 200k 大档」这条更贵的路。发起会话不可用时同理直接 `fail`（`index.js:1470-1473`），面板/自动调度提交的超预算任务只能改从会话内重提。
4. **`fixAnchors` 的正则边界**：锚点正则 `/([A-Za-z0-9_\-./]+):(\d+)(?:-(\d+))?/g`（`index.js:425`）不校验 URL 与时间字符串，正文里出现形如 `foo.js:12` 的普通文本也会被当锚点；只是「找不到符号就原样保留」，可能产生噪声 notes。
5. **`commitHintText` 依赖 git 与时间戳**：非 git 仓库、`jobs` 读取失败、或 `git log` 为空一律不提醒（`index.js:2759` 的空 catch）；时间戳比较是秒级（`index.js:2749`），同一秒内编译+提交会漏提醒。
6. **Temp 残留清理只在启动时**：`index.js:1210-1221` 在 `createJobService` 构造时执行一次；运行期新产生的 Temp 终态任务只靠 `workspaceOnly` 在前端隐藏，不落盘清理。
7. **面板本地上采样与后端 tps 双轨**：`job.tps`（`index.js:1163`）是后端按 `tpsSamples` 聚合，`sparkRef`（`client.js:980`）是前端按轮询差分；两者窗口不同（20 样本 vs 30 点），面板同一数字在两处可能不一致，属已知设计而非 bug。
8. **工具注册逐个兜底**：`apply` 里对每个工具单独 `try/catch`（`index.js:2856-2864`），失败只 `console.error`——工具静默不可用，用户只能在日志里发现；这是为避免 cordis 把 apply 回调失败当 fiber FAILED 回滚全部工具（`index.js:2854-2855` 注释）。
