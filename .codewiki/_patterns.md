---
title: patterns
type: pattern
source_files:
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/article-contract.js
  - lib/change-set.js
  - lib/cluster.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/output.js
  - lib/engine/mapping.js
  - lib/engine/quality-gate.js
  - lib/engine/native-run.js
  - lib/engine/manifest.js
  - lib/engine/apply-plan.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - index.js
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
  - test-batch.mjs
  - test-change-set.mjs
  - test-cluster.mjs
  - test-engine-client.mjs
  - test-engine-output.mjs
  - test-engine-python-entry.mjs
  - test-graphdiff.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-symbols.mjs
  - test-update-record.mjs
  - test-worktree.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - tools/fsoft-engine/locked-requirements.txt
  - tools/fsoft-engine/setup-env.sh
tags: [patterns, conventions, cross-cutting, error-handling, testing]
---

## Overview

本文基于 `modules/` 下全部模块文章，提炼 CodeWiki 仓库（dsh-codewiki 插件）里**反复出现的横切模式**：命名约定、错误处理风格、构建/测试流程、目录约定、跨进程协议、并发编排等。每条模式列出在多个模块中重复出现的证据（文件 + 函数 + 行号），目的有二：新增模块时照既有样子落位；review 时按这些模式挑错。

模式清单：

1. 依赖注入换离线可测
2. 纯函数与 IO 分层
3. 机读枚举词表与版本常量
4. 降级不中断、绝不假装成功
5. 路径归一与越界双重防护
6. 版本化状态文件与空转提交防护
7. JSON-lines 单行跨进程协议
8. 记账式错误处理与信息脱敏
9. 显式阈值与预算常量
10. 双池并发任务池
11. 测试组织与替身约定
12. 目录与产物落盘约定
13. 命名约定
14. 构建与依赖流程
15. 终态与基线闸门

## Patterns

### 1. 依赖注入换离线可测（边界对象从参数进，不从全局来）

所有会碰外部世界的纯逻辑模块，都把外部依赖（fs、git 执行器、llm、流式回调、进程探测器、上下文谓词）做成**从参数注入的边界对象**，而不是模块内直接 import 或全局单例。因此每个模块都能用假对象完全离线单测。

- git 执行器：`collectChangeSet(cwd, baseCommit, opts)` 经 `opts.execFile` 接收执行器，缺省才落 `defaultExecFile(cwd)` 的 `execFileSync`（`lib/change-set.js:15,42-49,107`）；`test-change-set.mjs` 注入假执行器钉死 15 个场景。
- llm 调用：`clusterComponents({ components, llmCall })` 的 `llmCall` 形如 `async (prompt) => string`，不传走 `heuristicCluster`（`lib/cluster.js:219,219`），`test-cluster.mjs` 覆盖「无 LLM / LLM 抛错 / 返回垃圾」。
- 流式模型：`runAgenticArticle({ streamFn })` 只消费 `{blocks, finish, usage}`（`lib/agentic.js:331`），生产侧由 `makeHostStream({ llm, ... })` 包出（`lib/agentic-host.js:83`），测试侧用 `scripted(responses)` 注入假模型（`test-agentic.mjs:62`）；执行器层另留 `injectedStreamFn` 入参（`lib/articles-agentic.js` 的 `runOneArticle`）。
- 文件系统：IO 留 `fsImpl` 注入口——`loadSnapshot` / `saveSnapshot`（`lib/incremental.js:94-115`）、`saveUpdateRecord` / `loadUpdateRecord`（`lib/update-record.js:217-238`）；workspace 整体抽象成 `{ readFile, listDir }`（`makeFsWorkspace`，`lib/agentic-host.js:111`），配假工作区 `makeWorkspace`（`test-agentic.mjs:29`）。
- 进程探测：`probeEnvironment({ probe, engineRoot })` 把「跑一次引擎探测」注入成纯函数，进程管理留在 `lib/engine/client.js`（`lib/engine/manifest.js:34`）。
- 上下文谓词：`scanStaleArticle(article, { linkExists })` 的 `linkExists` 由调用方注入（`lib/update-planner.js:106`），生产里由 `index.js` 的 `makeLinkExists`（`index.js:1867`）提供。

推论：新增「要碰磁盘/网络/进程」的逻辑，先写成消费注入对象的纯函数，再在最外层（通常是 `index.js` 或宿主适配层）接真实实现。

### 2. 纯函数与 IO 分层

模块内部一律「判定核心不碰文件系统 / 进程 / 模型，IO 集中到边缘」。

- `judgeOutcome({ plan, results, options })` 是纯判定核心（`lib/update-record.js:37-128`），落盘/回读由 `saveUpdateRecord` / `loadUpdateRecord`（`:217-238`）单独承担。
- `lib/update-planner.js` 全部为纯函数（`planUpdate`、`realChangedIds`、`dependentsOf`、`scanStaleArticle`）；module-map 的读写集中在 `index.js` 的 `loadModuleMap` / `saveModuleMap`（`index.js:1835,1835`）。
- `lib/incremental.js` 的纯逻辑（`filterStaleTasks`、`describeChange`、`sameSnapshotContent`、`normRel`、`componentsByFile`）不碰 FS，IO（`snapshotPath` / `loadSnapshot` / `saveSnapshot`）集中在文件末尾（`lib/incremental.js:8-13` 注释明确此分工）。
- `lib/engine/contract.js` 是「不碰文件、不碰进程、不碰模型」的纯数据契约（第 1-18 行模块说明）；`lib/engine/openai-bridge.js` 是「无 I/O、无网络、无密钥」的纯转换层，HTTP 监听全部在 `lib/engine/llm-bridge.js` 的 `startLlmBridge`。
- 读/映射/校验三段分文件：`lib/engine/output.js`（读 + 校验 + 编排）与 `lib/engine/mapping.js`（纯格式翻译、不写磁盘，`test-engine-output.mjs:206` 验证无隐藏状态）；`gateNativeOutput`（`lib/engine/quality-gate.js:390`）是复用 `validateOutput` 的纯组合器。

### 3. 机读枚举词表与版本常量

跨模块/跨进程传递的「结论」都用冻结的 kind/code/state 词表表达，上层按 kind 分派、绝不做文本匹配；每个可序列化结构都带版本常量，回读时校验。

- 契约词表集中在 `lib/engine/contract.js`：`ENGINE_STAGES`（24-33，顺序即推进顺序）、`TERMINAL_OUTCOMES`（35）、`BLOCKER_KINDS`（42-53，只允许追加不允许改名）、`ENGINE_ERROR_CODES`（57-67）、`RETRYABLE_CODES`（71）。
- 每层维护自己的词表再显式翻译：`GATE_DEFECT_KINDS` / `GATE_DEGRADATION_KINDS` / `GATE_STALE_KINDS` + 三个查表 `Set`（`lib/engine/quality-gate.js:45-76`），`TO_CONTRACT_KIND`（`:572-587`）把门 kind 翻成 `BLOCKER_KINDS`，对不上的归 `'quality-gate'`；`OUTPUT_PROBLEM_KINDS` + `PROBLEM_SET`（`lib/engine/output.js:22-36`），`validateOutput` 的 `push` 闭包对未登记 kind 直接抛错防自由发挥（`:187-190`）。
- 跨语言词表用测试双向对账：`stage_map.py` 的 `ENGINE_STAGES` 必须与 `contract.js` 完全一致（`lib/engine/python/stage_map.py:20-29`，对账见 `test-engine-python-entry.mjs:236-247`）。
- 版本常量成对出现「定义 + 回读校验」：`ENGINE_CONTRACT_VERSION`（`contract.js:20`）、`ENGINE_PROTOCOL_VERSION`（`client.js:27`）、`PROTOCOL_VERSION`（`entry.py:94`）、`CHANGE_SET_VERSION`（`lib/change-set.js:19`）、`SNAPSHOT_VERSION`（`lib/incremental.js:19`）、`UPDATE_PLAN_VERSION` / `MODULE_MAP_VERSION`（`lib/update-planner.js:26,26`）、`UPDATE_RECORD_VERSION`（`lib/update-record.js:17`）、`GATE_VERSION`（`quality-gate.js:42`）、`MANIFEST_VERSION`（`lib/engine/manifest.js:19`）。
- 状态机枚举同样机读：`stopReason` 五值 `max-steps`/`aborted`/`stream-error`/`empty-response`/`finished`（`lib/agentic.js:365-393`）、`compareLock` 的 `absent/match/drift/unhealthy`（`lib/engine/manifest.js:86`）、`planUpdate` 的 `write/keep/delete/review`（`lib/update-planner.js:156`）。

### 4. 降级不中断、绝不假装成功

外部能力（AST、LLM、快照、git、协议）不可用时，一律退到保守路径并**显式记账**：宁可多写一篇文章、退回全量编译，也不静默丢数据或谎报成功。

- AST 不可用 → 正则兜底：`extractFile` 在解析器缺失/`parse` 抛错/零符号时退 `regexExtract`（`lib/symbols.js:556-564,584-592`），并累加 `stats.regex` / `stats.regexLanguages` 让降级可见（`:560-562`）。
- LLM 失败 → 目录聚类：任何 `llmCall` 抛错都 `stats.fallbacks++` 后退 `heuristicCluster`（`lib/cluster.js:311-324`）；LLM 漏掉的组件由 `fillMissing` 补回并建 `misc` 兜底模块（`:247-268`）。
- 变更集采集失败 → 全量：`collectChangeSet` 的 `ok=false` 必带 `state` 与 `reason` 且 `fallback='full'`，「不许把采不到当成没变化」（`lib/change-set.js:99-102`）。
- 快照不可读 → 全量判定：`loadSnapshot` 对坏 JSON / 版本不符返回 `null`（`lib/incremental.js:98-103`）；无符号可判的文章保守保留并标 `symbolFallback: true`（`:179-184`）。
- 规划降级可见：`planUpdate` 的 `fileLevel` 降级 + `unmappedChanges` / `needsFull` 兜底，源码无归属触发 `needsFull=true`（`lib/update-planner.js:392,391-392`）。
- 模型侧容错：`parseToolArgs` 三级递进解析（原样 → `stripJsonFence` → `sliceBalancedObject`），坏 JSON 记 `steps.warning` 回 `{}` 不中断循环（`lib/agentic.js:476-500`）。
- 未知值归可机读兜底类：未登记 error code 落 `engine-unknown` 并保留 `rawCode`（`lib/engine/contract.js:171-182`）、未登记 blocker kind 落 `engine-error`（`:88-94`）、质量门未登记的 problem kind 兜底 `article-contract`（`lib/engine/quality-gate.js:436`）。
- 说实话原则：`generate_sub_module` 在 `onSubModule` 为空时必须报 `isError: true`，绝不回「已记录/已派发」制造死链（`lib/agentic.js:290-306`）。

### 5. 路径归一与越界双重防护

所有路径进系统前先归一成 POSIX 相对路径（`\`→`/`、去 `./`、拒绝绝对路径与 `../` 越界）；读写两侧各设一道闸门。

- 采集侧：`normChangePath(p)` 拒绝 `/` 开头、盘符路径与含 `../` 的越界路径（`lib/change-set.js:33-40`）。
- 读侧两道：`safeRelPath(rel)` 先拦 `/` 开头、`C:/`、`../`（`lib/agentic.js:266-273`）；`makeFsWorkspace` 的 `absOf` 再用真实绝对路径确认落在 `cwd` 内，越界抛「越界路径」（`lib/agentic-host.js:111-127`）。`read_code` / `list_files` 每次读盘都过这两道（`lib/agentic.js:120-121,186`）。
- 写侧：`makeWriteSet` / `normalizeWritePath` / `isWritable` 构成写集闸门，相对路径以 `cwd` 解析后比对防 `../` 越界（`lib/article-contract.js:352-378`）；`runOneArticle` 落盘前校验，越界返回 `stopReason:'write-set'` 不写盘（`lib/articles-agentic.js:155-167`）。
- 展示/比对侧归一：`normRel`（`lib/incremental.js:118-120`）、`normalizeSourceFiles`（`lib/engine/mapping.js:48-58`）、`normalizeArticlePath`（`index.js:280`）；`normalizeCwd` 额外处理 MSYS 盘符 `/e/...` → `E:/...`（`index.js:62-67`）。
- 标识符层面避开平台差异：组件 id 用 `<相对路径>#<符号名>` 而非上游的 `::`，避免 Windows 盘符 `:` 混淆（`lib/symbols.js:10-11`）。

### 6. 版本化状态文件与空转提交防护

跨运行的状态一律落成 `.codewiki/` 下的版本化 JSON：带 `version` 常量、回读校验版本、写前先比内容防「只改时间戳」的空转提交。

- 快照：`SNAPSHOT_REL = 'temp/symbol-graph.json'` + `SNAPSHOT_VERSION`（`lib/incremental.js:19-22`），`loadSnapshot` 版本不符返回 `null`（`:98`）；`sameSnapshotContent` 忽略 `generatedAt`/`commit` 比对实质内容，内容没变不覆盖（`:53-66`）。
- 复盘记录：`UPDATE_RECORD_REL = 'temp/update-record.json'` + `UPDATE_RECORD_VERSION`（`lib/update-record.js:17-18`），`loadUpdateRecord` 只认当前版本（`:233`）；记录只存路径与摘要、不塞整图（`test-update-record.mjs:179-185` 断言无 `graph`/`tasks` 字段）。
- 模块归属：`MODULE_MAP_REL = 'temp/module-map.json'` + `MODULE_MAP_VERSION`（`lib/update-planner.js:26-27`），`sameModuleMap` 忽略 `generatedAt`（`:484-492`）。
- 引擎锁：`ENGINE_LOCK_REL = '.codewiki/engine-lock.json'` + `MANIFEST_VERSION`（`lib/engine/manifest.js:19-20`），`writeLock` 原子写（先 `.${pid}.tmp` 再 `renameSync`，`:131-133`）。

### 7. JSON-lines 单行跨进程协议

Node ↔ Python 引擎的唯一跨语言边界用「一行请求 JSON 进 stdin，stdout 回 JSON-lines（`hello` → `progress`… → `result`）」，退出码只表达进程层，语义以 `result` 为准。

- Node 侧：`createProtocolReader`（`lib/engine/client.js:39-186`）增量解析、按字节缓冲、多字节 UTF-8 跨 chunk 不切坏、单行超 `DEFAULT_MAX_LINE_BYTES = 4MiB` 记 `line-too-long` 并丢缓冲防内存涨（`:29,143-154`）；`runEngine`（`:223-422`）负责 spawn、写一行请求后关 stdin、竞速 exited/timeout/abort/spawnError。
- Python 侧：`emit` / `emit_hello` / `emit_progress` / `emit_result` 只走 `_REAL_STDOUT`（`lib/engine/python/entry.py:104-132`）；`_ProtocolOnly` 在 `import codewiki` **之前**接管 `sys.stdout`，把 FSoft 的 print/click 输出改道 stderr，防污染协议流（`:59-92`）；`main()` 读一行 stdin、非法 JSON 也回可机读失败（`:577-590`）。
- 协议不变量：`requestId` 必须匹配（缺失也算不匹配，`client.js:83-86`）；没有 `result` 即使退出码 0 也判 `engine-protocol`/`engine-crashed`（`:403-414`）；取消后到达的 `result` 记 `late-result` 丢弃（`:105-109`）；重复 `result` 先到赢（`:110-113`）；退出码与语义不一致记 `nonzero-exit` 违规但保留语义（`:416-421`）。

### 8. 记账式错误处理与信息脱敏

错误处理的主风格是「收集而非抛出」：失败收进 notes / warnings / stats / problems / blockers / violations，继续跑完，让上层统一判终态；同时所有对人消息截断到固定长度、对凭证零记录。

- 记账容器：`runAgenticArticles` 单任务失败只写 `notes` 不影响其它任务（`lib/articles-agentic.js:300-303`）；`parseToolArgs` 失败记 `steps.warning`（`lib/agentic.js:498`）；`parseClusterResponse` 向 `warnings` 推消息（`lib/cluster.js:156-195`）；`extractRepoGraph` 用 `stats = { files, parsed, failed, languages, regex, regexLanguages }` 记账（`lib/symbols.js:785,560-562`）；`validateOutput` 收 `problems`（`lib/engine/output.js:184-282`）；`judgeOutcome` 收 `blockers`（`lib/update-record.js:41-117`）；协议层收 `violations`（`lib/engine/client.js:53`）。
- 截断约定：逐篇 `error` 截 300 字（`lib/update-record.js:44-45`）、降级 `reason` 截 200 字（`lib/change-set.js:119-121,143`）、blocker `detail` 截 2000 字（`lib/engine/contract.js:109`）、engine error `message` 截 4000 字（`:176`）、stderr 尾部截 4000 字（`lib/engine/client.js:410`）、协议违规 detail 截 500 字（`:53`）。
- 凭证零记录：`bearerOf` 取 bearer token 校验占位 key 后即弃、绝不进日志（`lib/engine/llm-bridge.js:38-43`）；访问日志只记 `method/path/status/ms/requestId`（`:103-109`）；错误体不回显收到的 key（`:123`）；`failure()` 的 message 绝不拼凭证内容（`lib/engine/python/entry.py:142`）；`_model_config` 缺环境变量时只说「环境变量」不打印值（`:265-278`）。

### 9. 显式阈值与预算常量

所有「防失控」的数值都提为具名常量，集中放在模块头部或主入口处，不散落魔法数字。

- 读码预算：`MAX_READ_LINES = 2000` / `MAX_READ_CHARS = 40000`（`lib/agentic.js:98,96`，后者挡「单行 20 万字符」的压缩产物）；`IGNORED_DIRS`（`:98`）挡依赖目录白烧步数。
- 步数：`DEFAULT_MAX_STEPS = 30` 是 agentic 步数唯一定义点（`lib/agentic.js:321-325`），`lib/articles-agentic.js:21` 只再导出保持旧导入路径，`index.js` 的 `agenticMaxSteps` 默认值必须与其一致。
- diff 预算：`DEFAULT_TAU_REN = 0.8` / `DEFAULT_MAX_DIFF_TOKENS = 2000`（`lib/graph-diff.js:368-369`）。
- 聚类阈值：`DEFAULT_MAX_DEPTH = 2` / `DEFAULT_SPLIT_THRESHOLD = 60` / `DEFAULT_TOP_FANOUT = 14`（`lib/cluster.js:287-289`）。
- 扫描上限：`SCAN_MAX_FILE_BYTES = 256KB` / `SCAN_MAX_FILES = 2000`（`index.js:2189-2190`）；正则兜底 `REGEX_MAX_LINES = 4000`（`lib/symbols.js:371`）。
- 协议/HTTP 上限：`DEFAULT_MAX_LINE_BYTES = 4MiB`（`lib/engine/client.js:29`）、`MAX_BODY_BYTES = 32MiB`（`lib/engine/llm-bridge.js:34`）、`DEFAULT_TIMEOUT_MS = 10min`（`:33`）、`DEFAULT_ENGINE_TIMEOUT_MS = 45min`（`lib/engine/native-run.js:38`）。
- 进度上限：`FSOFT_PROGRESS_CEILING = 90`，引擎内部进度只报 90%、剩 10% 留给 Node 侧 index/baseline/commit 收尾，防「引擎说 100% 但 wiki 还没提交」的假完成（`lib/engine/python/stage_map.py:63`）。
- 单轮通道 token 预算：`BATCH_TOKEN_HARD_LIMIT = 128000` 与 110k 拆分预算驱动 `prepareArticleTasks` 的拆分/大档/会话通道路由（`index.js`，用例见 `test-batch.mjs:54-132`）。

### 10. 双池并发任务池

两条文章执行通道共用同一套「双池并发 + 任务自带选档 + 返回 `Map(customId → 结果)`」的编排形状。

- 单轮通道 `runRealtimeTasks`（`index.js:662`）与 agentic 通道 `runAgenticArticles`（`lib/articles-agentic.js:231-312`）都按 `bigTier` 拆 normal/big 两个池（`:244-255`），各自独立限流、同时推进，`bigConcurrency` 为 0 时回落 `concurrency`。
- 任务自带 provider+model 时全覆盖选档：`resolveTaskRoute`（`lib/articles-agentic.js:208-222`，缺 model 不算自带）；大档标记是纯函数 `markBigAgenticTasks`（`:320-333`），agentic 侧判据换成源文本量估算 `sourceTokensOf`（`:185-203`）。
- 失败语义与返回形状一致：单任务失败只记账不影响其它任务，返回 `Map(customId → 结果)`（`lib/articles-agentic.js:284-303`）；两条通道分别由 `test-articles-agentic.mjs` 与 `test-batch.mjs:170-345` 钉死。

### 11. 测试组织与替身约定

测试是根目录平铺的独立 Node ≥20 脚本（非 harness），共享「check 计数器 + makeXxx 工厂 + 环境隔离 + 真实 git 临时仓库」的写法；替身分四族：假模型、假 workspace/宿主、假 HTTP、假引擎进程。

- 断言宏：每个测试文件自带 `check(label, fn)` 计数器，失败收进 `fails`，结尾 `process.exit(fails ? 1 : 0)`（`test-batch.mjs:17-20`、`test-orchestration.mjs:27-30`、`test-agentic.mjs:12-21`）；异步版 `checkAsync`（`test-symbols.mjs:27-36`）。
- 工厂统一命名 `makeXxx`：`makeWorkspace`（`test-agentic.mjs:29`）、`makeTmp`（`test-articles-agentic.mjs:23`）、`makeCtx`（`test-orchestration.mjs:51`）、`makeFixtureRepo`（`test-orchestration.mjs:110`）、`makeRepo`（`test-change-set.mjs:23`）、`makeWiki`（`test-prune-orphans.mjs:19`）、`makeComponents`（`test-cluster.mjs:25`）。
- 环境隔离：`process.env.DSH_CODEWIKI_JOBS_FILE` 指向随机路径隔离后台状态（`test-orchestration.mjs:22-23`），`DSH_CODEWIKI_TICK_MS` 把 tick 压到下限加速（`:15`）。
- git 相关测试在临时目录 `git init` 真实仓库，环境无 git 时整体 `SKIP`，不用 mock（`test-worktree.mjs:30-36`）。
- 黄金对拍：`lib/graph-diff.js` 的 difflib 移植用 Python 原生 `difflib` 离线生成 `test-fixtures/graphdiff-golden.json`（生成器 `test-fixtures/gen-graphdiff-golden.py`，固定随机种子），`test-graphdiff.mjs` 缺文件即 `process.exit(1)`。
- 假引擎：`test-fixtures/fake-native-engine.mjs` 由 `FAKE_ENGINE_MODE` 控制一次只做一件事，让 `runEngine` 走完全真实的 spawn/stdin/stdout 路径；协议破坏场景用 `fakePy`/`pyEngine`（`test-engine-client.mjs:159-241`）逐条断言。
- 端到端等待：`waitJob(cwd)` 每 150ms 轮询 `JOBS_FILE` 等终态（`test-orchestration.mjs:230-243`）。

### 12. 目录与产物落盘约定

仓库自身的目录布局与 wiki 产物的落盘路径都有固定口径，且「产物 vs 源码」有显式判定。

- wiki 产物树由 `lib/engine/mapping.js` 定口径：`WIKI_ENTRY = 'CodeWiki.md'`、`WIKI_DIR = '.codewiki'`、`WIKI_META_REL = '.codewiki/_meta.yaml'`、`WIKI_UPDATE_RECORD_REL = '.codewiki/temp/update-record.json'`、`WIKI_MODULES_REL = '.codewiki/modules'`（`:30-34`）；自动提交只动 `WIKI_PATHS = ['.codewiki', 'CodeWiki.md']`（`index.js:58`）。
- 产物判定：`isWikiProduct(relPath)` 把 `.codewiki/` 判为产物、不当作源码变更；README/CHANGELOG 等被 `source_files` 引用的文档仍是源码（`lib/change-set.js:26-29`）。
- 源码组织：`lib/` 放纯逻辑模块；`lib/engine/python/` 是仓库唯一手写 Python（JSON-lines 入口 + 阶段映射两个文件）；`index.js` 是编排总入口（服务、工具定义、git 辅助都挂顶层）。
- 测试组织：`test-*.mjs` 平铺根目录，`test-fixtures/` 放协议夹具与黄金基准，`tools/fsoft-engine/` 放引擎环境工具箱与 fixture 仓库。
- 运行时产物不入库：`vendor/tree-sitter` 是独立 npm 根（`lib/symbols.js:21-25`，避免在宿主注入的 `node_modules` 里跑 `npm install`）；`tools/fsoft-engine/fixtures/.gitignore` 忽略 `.codewiki/`、`docs/` 等，「入库的是可复现输入而非结果快照」。
- 文章落盘命名：模块文章写 `modules/<父 slug>/<子 slug>.md`（`lib/articles-agentic.js:96`），入口/总览走 `CodeWiki.md` / `_architecture.md`。

### 13. 命名约定

- 文件名 kebab-case：`agentic-host.js`、`change-set.js`、`graph-diff.js`、`update-planner.js`、`quality-gate.js`、`openai-bridge.js`。
- 工厂函数 `makeXxx`：`makeReadCodeTool` / `makeListFilesTool` / `makeArticleEditor`（`lib/agentic.js:200,179,200`）、`makeFsWorkspace` / `makeHostStream`（`lib/agentic-host.js:83,83`）、`makeWriteSet`（`lib/article-contract.js:352`）。
- 谓词 `isXxx`：`isWritable`（`lib/article-contract.js:365`）、`isWikiProduct`（`lib/change-set.js:26`）、`isSourcePath`（`lib/update-planner.js:33`）、`isTerminalStage`（`lib/update-record.js:26`）、`isPlaceholderKey`（`lib/engine/openai-bridge.js:31`）、`isDeadCompileTarget`（`index.js:504`）。
- 常量 SCREAMING_SNAKE_CASE 且名字带语义：`MAX_READ_LINES`、`IGNORED_DIRS`、`DEFAULT_MAX_STEPS`、`WIKI_ENTRY`、`ENGINE_STAGES`、`FSOFT_PROGRESS_CEILING`。
- Python 侧 snake_case + 下划线私有：`action_doctor` / `action_generate`、`_model_config` / `_classify_exception` / `_pip_check`、守卫类 `_ProtocolOnly`（`lib/engine/python/entry.py`）；纯函数 `map_stage` / `percent_of`（`lib/engine/python/stage_map.py`）。
- slug 命名三处同族：`moduleSlug`（`lib/engine/mapping.js:38-44`，ASCII kebab-case）、`slugify`（`index.js:1741`，保留 CJK）、`slugOf`（`lib/articles-agentic.js:75`）。
- 标识符契约：组件 id `<相对路径>#<符号名>`、方法 `<类名>.<方法名>`（`lib/symbols.js:10-11,650-653`）；图节点形状 `{ id, name, kind, relativePath, sourceCode, docstring, parameters, baseClasses, dependsOn }` 由 `lib/symbols.js:13-14` 与 `lib/graph-diff.js:9-10` 共同约定，生产方与消费方严格对齐。

### 14. 构建与依赖流程

- 零构建产物：插件是纯 Node ≥20 ESM，测试直接 `node test-*.mjs` 运行（`test-batch.mjs:15-21`），无打包/编译步骤。
- 依赖极简：装依赖仍是一条 `npm install`；AST 用 web-tree-sitter + WASM 语法装在 `vendor/tree-sitter` 独立 npm 根，不引入 Python/cargo（`lib/symbols.js:21-25,497-519`）。
- 引擎侧 Python 依赖三件套锁定：`tools/fsoft-engine/setup-env.sh` + `constraints.txt` + `locked-requirements.txt` 从零造可信 venv；运行时用 `pip check` 做依赖闭合门禁（`lib/engine/python/entry.py:176-195` 的 `_pip_check`），不闭合报 `engine-deps` 直接 failed，绝不先跑再发现环境漂了。
- 密钥不入库：0.10.1 起移除内置直连渠道（`mod.resolveBatchApiKey === undefined`，`test-batch.mjs:518-521`），真实凭证只活在宿主 provider 内部；引擎模型通道用每次启动随机生成的占位 key（`lib/engine/llm-bridge.js:96`）经进程环境变量注入。
- 黄金基准是构建产物：CI 必须把 `test-fixtures/graphdiff-golden.json` 纳入（由 `gen-graphdiff-golden.py` 离线生成），缺失则对拍测试直接退出，无「按需调 Python 生成」回退。

### 15. 终态与基线闸门

编译终态只有四值，且「完整性不成立就不得推进基线」被多层硬不变量共同保证，任何后置步骤都不能洗白前置失败。

- 四态枚举：`TERMINAL_OUTCOMES = ['done','partial','failed','cancelled']`（`lib/engine/contract.js:97`）；`engineResult` 硬不变量——`done` 不许带 blockers、`partial` 必须带 blockers、`failed` 必须带 `error`（`:103-112`）。
- 最弱终态合成：`RANK`/`weakest` 把 cancelled < failed < partial < done 排序，`runNativeJob` 把引擎、质量门、落地器结论合成**最弱**终态，绝不允许被后续步骤提升（`lib/engine/native-run.js:41-42,1-18`）；落地器 `applyNativeOutput` 对 `gate-partial` 照写但不洗成 done（`lib/engine/apply-plan.js:414-421`）。
- 基线闸门：`canAdvanceBaseline = outcome === 'done' && blockers.length === 0`（`lib/update-record.js:124`）；质量门同样「三类问题（defect/degradation/stale 中仅 `baseline-uncommitted` 阻塞）皆空才 done」（`lib/engine/quality-gate.js:533-536`）。
- 采集侧对齐：`collectChangeSet` 采不全就 `fallback='full'`，绝不把脏状态当 clean（`lib/change-set.js:99-102`）。
- 取消是终态：取消后到达的 `result` 记 `late-result` 丢弃（`lib/engine/client.js:105-109`），`judgeOutcome` 里 `cancelled` 优先级最高直接返回（`lib/update-record.js:46-54`）。