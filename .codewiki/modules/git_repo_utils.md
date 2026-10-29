---
title: git_repo_utils
type: module
source_files:
  - test-orchestration.mjs
  - test-engine-native-job.mjs
  - test-engine-native-incremental.mjs
  - test-worktree.mjs
  - test-incremental-e2e.mjs
  - index.js
  - lib/engine/native-run.js
  - test-fixtures/fake-native-engine.mjs
tags: [test-helpers, git-fixtures, repo-mocks, endpoint-mocks, orchestration-tests]
---

## Overview

`git_repo_utils` 并非仓库里一个真实存在的文件——它是编排测试（orchestration tests）在多个 `test-*.mjs` 里**反复手搓、彼此同构**的一套「Git 命令帮手 + 临时仓库 fixture + 宿主 webServer/llm 端点 mock」工具集的统称。本文把它聚合起来写成一份模块文档，供零上下文的未来 agent 直接照抄这些工具搭建自己的编排测试。

被测对象是宿主半侧主入口 `index.js`（`apply` / `createJobService` / `autoCommitWiki` / `commitHintText` / `detectLinkedWorktree` / `installUpdateReminder` 等导出），以及 `lib/engine/native-run.js` 的 `runNativeJob`。要让这些真实代码跑起来，测试必须提供三样东西：

1. **Git 命令帮手**：用 `child_process.execFileSync` / `spawnSync('git', …)` 在 `os.tmpdir()` 里建带 `.git` 的临时仓库（`makeFixtureRepo` / `makeRepo`），补 `user.name`/`user.email`（否则 `autoCommitWiki` 守卫拒绝提交），按需 `git init`/`add`/`commit`/`worktree add`。
2. **仓库 fixture**：按被测形态拼目录结构——核心/工具两目录（`core/`、`util/`）、可插大文件触发观察批分割、可预置 `CodeWiki.md`/`.codewiki/`、可造假 `MERGE_HEAD`/清 identity/塞 `.gitignore` 触发 `autoCommitWiki` 各安全边界分支。
3. **宿主端点/服务 mock**：`makeCtx` 造出 `services.webServer/tools/agents/llm` 的同构切片，拦截 `webServer.register`（收集 `endpoints`）与 `tools.register`（`registered` Map）；`fakeReq`/`fakeRes` 让端点 handler 可被直接调用（`ep.handler(fakeReq(), fakeRes())`）；`makeBatchMock` 是一套按 prompt 首行特征应答的假 `llm.stream`，转发到全局 `activeLlm` 的 `llmProxy`。

这些工具散落在四个主要文件里（行号见下），形态高度一致：

- `test-orchestration.mjs` —— 编排冒烟总纲，工具最全（含 60s 缓存的 `commitHintText` 绕过、JOBS_FILE 随机 token 隔离、queueAhead/session 端点断言）。
- `test-engine-native-job.mjs` / `test-engine-native-incremental.mjs` —— 原生引擎生产链测试，复用同构 `makeCtx` + `makeRepo`/`mkTmp` + 假引擎足迹 `readCalls`，但 `makeBatchMock` 被更轻的 `fakeLlm` / `legacyLlmFor` 取代（原生通道模型请求走 Python 引擎，假引擎不访桥）。
- `test-worktree.mjs` / `test-incremental-e2e.mjs` —— 纯 git 判据/真实目录 fixture，不依赖 `makeCtx`，只用 `spawnSync('git', …)` + `mkdtempSync` 裸搭。

## Key Components

下列全部是测试文件内的**本地函数/常量**（不是 `index.js` 导出），按文件分组。行号以源码「行号| 」前缀为准。

### test-orchestration.mjs —— 编排冒烟工具集

| 名称 | 行号 | 用途 |
| --- | --- | --- |
| `check(cond, msg)` | `test-orchestration.mjs:27-30` | 断言计数；失败累计 `failures` 并 `console.error`，收尾 `process.exit(failures?1:0)`（`test-orchestration.mjs:1551`）。 |
| `articleMd(title, source, marker, type)` | `test-orchestration.mjs:33-34` | 拼一个带 frontmatter 的最小合法 markdown 文章，供假 llm 回吐；`type` 决定契约闸门校验的目录（根级 `_architecture.md`=architecture、`concepts/`=concept 等，`test-orchestration.mjs:158-161`）。 |
| `LEGACY_CHANNEL` / `batchCfg(extra)` | `test-orchestration.mjs:44-45` | 基线配置：`{ planMode:'dirs', agenticArticles:false, symbolIncremental:false }`，显式关三档新能力，保护旧通道断言不被新通道请求干扰。 |
| `makeCtx({agents,workspaces,brokenRegistry,agentGet,llm})` | `test-orchestration.mjs:51-91` | 造同构宿主 ctx：`services` 含 `webServer.register`/`tools.register`/`agents`/`llm`；支持 `workspaces`（注册 `workspaceRegistry.list`）、`brokenRegistry`（`list()` 抛，模拟真宿主 jobs/repos 400）、`agentGet`（冷会话/带 steer 的会话）。`inject` 严格语义：带回调传 ctx 切片、否则 `Promise.resolve`（`test-orchestration.mjs:69-79`）；`effect` 真实执行并收集 disposer（`test-orchestration.mjs:84-88`）。返回 `{ ctx, registered, endpoints, listeners, disposers }`。 |
| `makeMockAgent(cwd)` | `test-orchestration.mjs:94-108` | 造 `agent` + `sections`，`ctx.inject` 给 `systemPrompt.getSectionOrder`/`section`（`TOOL_REPORT:2900`），供 `installUpdateReminder` 注册 `codewiki:update-reminder` section。 |
| `makeFixtureRepo()` | `test-orchestration.mjs:110-127` | 建 `core/`+`util/` 两个目录、各一个 `.py`，`git init` 并补 `user.name=test`/`user.email=test@test`，`git add . && git commit -m init`。fixture 结构直接决定 `localPlan` 模块名（顶层目录分组）。 |
| `llmProxy` / `activeLlm` / `makeBatchMock(opts)` | `test-orchestration.mjs:132-227` | 假 llm 服务：`activeLlm` 是「当前生效的假 llm」，`llmProxy` 恒转发给它（`test-orchestration.mjs:133-140`）；`makeBatchMock` 按 prompt 首行特征（`你是 CodeWiki 文章观察员/作者/架构观察员/审校员`、`写系统总览`、`总结仓库反复出现的模式`、`写跨模块概念`）分发应答（`test-orchestration.mjs:132-182`）。返回 `{ llm, llmCalls, batchPrompts(), realtimePrompts(), restore() }`，`restore()` 还原上一层 `activeLlm`（`test-orchestration.mjs:218-226`）。`opts`：`{ modules, articleMarker, stall, bigArticle }`——`stall:true` 请求挂起不返回（取消/`serialProjects` 测试用），`bigArticle:true` 把文章撑到 7 万字符（横切拆分测试）。 |
| `promptOf(opts)` | `test-orchestration.mjs:141` | 取 `opts.messages[0].content[0].text` 首段文本，供 `answerFor` 匹配。 |
| `waitJob(cwd, {timeout})` | `test-orchestration.mjs:230-243` | 轮询 `JOBS_FILE`，等某 cwd 最新 job 到 `done/failed/cancelled` 终态（`timeout` 默认 30s）。 |
| `fakeReq(body, addr, method)` | `test-orchestration.mjs:245-254` | 造回环端点请求：`socket.remoteAddress` 默认 `127.0.0.1`（非回环给别的地址触发 403），`on('data'/'end')` 同步回放。`sessions` 端点用例直接传 `{ method, url, socket }`（`test-orchestration.mjs:1381`）。 |
| `fakeRes()` | `test-orchestration.mjs:255-257` | 造响应：`writeHead(c)` 记 `code`，`end(b)` 记 `out`，断言时 `JSON.parse(res.out)`。 |
| `SESSIONS_DIR` | `test-orchestration.mjs:24`（import 自 `./index.js`）、`test-orchestration.mjs:1433`（收尾 `fs.rmSync(SESSIONS_DIR,…)`） | 会话记录根目录，测试末统一清理避免 tmp 句柄残留。 |
| `TEST_JOB_TOKEN` / `DSH_CODEWIKI_JOBS_FILE` | `test-orchestration.mjs:22-23` | 随机 token 命名独立 JOBS_FILE，隔离真实宿主服务实例、规避 pid 复用时读到历史 fixture（`test-orchestration.mjs:19-23`）。 |
| `DSH_CODEWIKI_TICK_MS='300'` | `test-orchestration.mjs:15` | 把 tick 压到下限（生产默认 10s），加速服务阶段机。 |

本文件覆盖 `index.js` 导出的 `commitHintText`（`test-orchestration.mjs:344` 起）、`autoCommitWiki`（`test-orchestration.mjs:433`）、`autoCommitState`（`test-orchestration.mjs:536`）、`wakeCompileSession`（`test-orchestration.mjs:548`）、`apply`/`name`/`SESSIONS_DIR`（`test-orchestration.mjs:24`）、webServer 端点（`/api/codewiki/jobs|repos|control|sessions`，`test-orchestration.mjs:776/856/1051-1052/1364`）。

### test-engine-native-job.mjs / test-engine-native-incremental.mjs —— 原生引擎生产链工具集

| 名称 | 行号 | 用途 |
| --- | --- | --- |
| `makeRepo(tag, {mode,preInit,metaReadonly,noEmail})` | `test-engine-native-job.mjs:57-93` | 建带 git 的临时仓库 `core/`+`util/` 各一个 `.py`，补 identity 并提交；`preInit` 调真实 `cw init` + 提交 `CodeWiki.md`/`.codewiki`（规避首次编译 `baseline-uncommitted` → partial，`test-engine-native-job.mjs:71-81`）；`metaReadonly` 给 `_meta.yaml` 设 `0o444`（让 `cw meta update` 真失败）；`noEmail` 清 `user.email`（触发 `autoCommitWiki` 守卫）；模式文件写仓库外 `base/.native-mode-<tag>`（避免污染被测，`test-engine-native-job.mjs:91`）。返回 `{ base, repo, calls:()=>readCalls(base,tag) }`。 |
| `readCalls(base, tag)` | `test-engine-native-job.mjs:96-100` | 读假引擎调用足迹 `.native-calls-<tag>.log`（每行一条 JSON），证明引擎真收到 action/updateOptions、真 `stat` 到持久化状态（`test-engine-native-job.mjs:379-380`）。 |
| `fakeLlm` | `test-engine-native-job.mjs:106-110` | 原生通道最小可用假 llm：`async *stream()` 只 yield `finish`，`listModels:()=>[]`。 |
| `articleMd(title, source, type)` | `test-engine-native-job.mjs:119-120` | 与 orchestration 同款最小合法文章，但正文统一 `Legacy-written article.`。 |
| `realSources(repo)` | `test-engine-native-job.mjs:122-137` | 递归扫仓库真实源文件（`.py/.ts/.js/.mjs/.go/.rs/.java`），上限 8 个、深度 3；供 `legacyLlmFor` 按仓库真实文件算 `source_files`，避免契约闸门判失败（`test-engine-native-job.mjs:115-118`）。 |
| `legacyLlmFor(repo)` | `test-engine-native-job.mjs:139-176` | 旧 Node 流水线最小可用假 llm：按 prompt 特征应答，模块名 `root` 挂 `CodeWiki.md`、其余挂真实 `<mn>/…`（`test-engine-native-job.mjs:144-146`），只服务「原生默认关闭时旧通道照常完成」用例（`test-engine-native-job.mjs:13`）。 |
| `makeCtx({llm})` | `test-engine-native-job.mjs:178-206` | 同构宿主 ctx（与 orchestration 版一致），`on()` 为空实现、`effect` 收集 disposer；`llm` 默认 `fakeLlm`。 |
| `nativeCfg(extra)` | `test-engine-native-job.mjs:208-223` | 原生通道配置：`nativeEngine:true` 且 `nativeEnginePython:process.execPath` + `nativeEngineEntry:FAKE_ENGINE`，假引擎用 node 当解释器、本文件当入口，client.js 走完全真实 spawn 路径；同样显式关三档旧能力。 |
| `waitJob(cwd, {timeout})` | `test-engine-native-job.mjs:226-238` | 终态集合含 `done/partial/failed/cancelled`（原生含 partial），轮询间隔 120ms，`timeout` 默认 90s。 |
| `mkTmp(prefix)` | `test-engine-native-incremental.mjs:53-57` | 建 `os.tmpdir()` 临时目录并登记到 `madeDirs` 供收尾清理。 |
| `STATE_DIR = '.codewiki/_native-state'` | `test-engine-native-incremental.mjs:38` | 原生受管状态目录，增量测试用 `nativeState` 模块读写并断言引擎真读到（`test-engine-native-incremental.mjs:38` 为 import `nativeState`）。 |
| `FAKE_ENGINE` | `test-engine-native-job.mjs:35` / `test-engine-native-incremental.mjs:34` | `test-fixtures/fake-native-engine.mjs`：真进程假引擎，只实现协议与产物、不实现算法（client.js 的 spawn/stdin/stdout-line/进程树终止全走真实代码）。 |
| `TEST_TOKEN` / `DSH_CODEWIKI_JOBS_FILE` | `test-engine-native-job.mjs:31-32` / `test-engine-native-incremental.mjs:29-30` | 同 orchestration 的随机 token 隔离策略（前缀 `-native-`/`-inc-`）。 |

### test-worktree.mjs / test-incremental-e2e.mjs —— 纯 git 判据 fixture

| 名称 | 行号 | 用途 |
| --- | --- | --- |
| `git(...args)` | `test-worktree.mjs:19` | `spawnSync('git', args, {encoding:'utf8', windowsHide:true})`；`SKIP` 守卫：环境无 git/钩子干扰时跳过而非误报（`test-worktree.mjs:30-36`）。 |
| `root/main/linked` setup | `test-worktree.mjs:16-27` | `git init -q main` → 补 identity → 写 `a.txt` → commit → `git worktree add -q linked`，搭主工作区 + linked worktree 验证 `detectLinkedWorktree` 三态（`test-worktree.mjs:38-53`）。 |
| 直接调用 `detectLinkedWorktree/isWorktreeCwd/hasCompilableSources/isDeadCompileTarget` | `test-worktree.mjs:11`（import）、`test-worktree.mjs:38-77` | 被测的是 `index.js` 的 git 判据导出；用真实 git 建仓库+linked worktree，判据来自 git 本身而非目录命名。 |
| `extractCurrentGraph/currentCommit` | `test-incremental-e2e.mjs:7`（import 自 `./index.js`）、`test-incremental-e2e.mjs:43-59` | `index.js` 导出：`extractCurrentGraph(tmp)` 真实目录提符号图、`currentCommit(tmp)` 取 HEAD；落盘到 `.codewiki/temp/symbol-graph.json`（`test-incremental-e2e.mjs:17`）。测试只用 `mkdtempSync` + `write()` 裸搭真实目录，无 `makeCtx`。 |

### index.js 中被这些工具直接驱动的导出（引用点）

| 导出 | 行号 | 被 test 工具调用的场景 |
| --- | --- | --- |
| `apply` | `index.js:5156`（CodeWiki.md 标注，实际 `export` 见文件后段） | 所有 `makeCtx` 之后 `apply(ctx, cfg)` 注册两工具 + webServer 端点 + `agent/created` 监听（`test-orchestration.mjs:296` 等）。 |
| `runCw`/`parseStatus` | `index.js:185-210` / `index.js:310-323` | `cw` 子进程封装与三态判定；`test-cwd-paths.mjs` 间接验证、`cwTool.execute({cwd,args:['status']})` 在 `test-orchestration.mjs:306` 触发 `parseStatus` 判 missing。 |
| `detectLinkedWorktree` / `isWorktreeCwd` / `hasCompilableSources` / `isDeadCompileTarget` | `index.js:451-467` / `index.js:475-486` / `index.js:494-508` / `index.js:520+` | worktree/空壳闸门：`test-worktree.mjs` 全量覆盖，`test-orchestration.mjs:1414` 经 `gen.execute` 触发拒绝。 |
| `autoCommitWiki(cwd, {jobId, writtenCount})` | `index.js`（autoCommit 边界，见 CodeWiki.md:15） | `test-orchestration.mjs:433` 起覆盖分支合并式/非 git/.gitignore/合并中/缺 identity/detached/主题分支占用；`test-engine-native-job.mjs` 经真实 job 链路走到。 |
| `commitHintText(cwd, jobs)` | `index.js`（installUpdateReminder section，见 CodeWiki.md:14） | `test-orchestration.mjs:344-427` 覆盖 60s 缓存、autoCommit.committed/noChanges/pending 各分支。 |
| `autoCommitState(job)` | `index.js`（CodeWiki.md:16） | `test-orchestration.mjs:536-542` 三态判定。 |
| `wakeCompileSession(job, outcome, agents)` | `index.js`（CodeWiki.md:17） | `test-orchestration.mjs:548-580` 终态 steer 唤醒/静默分支。 |
| `name` / `SESSIONS_DIR` | `index.js:1980` / import `test-orchestration.mjs:24` | 插件名 `dsh-codewiki`、会话记录根目录。 |

## Architecture

## Data Flow

## Connections

## Known Issues
