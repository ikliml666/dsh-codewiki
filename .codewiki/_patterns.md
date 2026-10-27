---
title: _patterns
type: pattern
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-entry.mjs
  - test-wiki-anchors.mjs
  - index.js
  - client.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/agentic.js
  - lib/articles-agentic.js
  - cordis.patch.yml
  - package.json
  - .gitignore
tags:
  - 模式
  - 命名约定
  - 错误处理
  - 测试流程
  - 目录约定
  - 配置热生效
  - 锚点引用
---

## Overview

本仓库是 @local/dsh-codewiki 插件（当前 `package.json:3` 版本 0.13.4）——把 mraza007/codewiki 的 Rust CLI `cw`（MIT）接入 DeepSeek Harness，提供仓库内代码 wiki（落在各仓库 `.codewiki/` 目录、随仓库提交共享）的提交制编译与维护（`README.md:3`）。0.13.0 起吸收 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力——AST 符号提取 + LLM 语义聚类（`planMode=auto`）、agentic 工具循环写作（`agenticArticles`）、符号级增量判定（`symbolIncremental`）——全部用 Node + tree-sitter WASM 在插件内实现、默认全开且任一环节不可用自动降级回旧行为（`README.md:5`、`CodeWiki.md:7`）。代码围绕「提交制编译 + 宿主常驻 JobService 推进阶段机（写文章→横切→合成→校对→索引→提交）+ 插件内双档并发池（默认档/大档分池限流）+ 零子代理 + 编译收尾插件自动提交（主题分支合并式）+ 三层能力分层降级」形成一系列一致的工程实践：命名按层分组、失败一律记账不中断、配置全字段热生效、测试直测插件主体并以 mock 宿主 llm 服务驱动、文档行号锚点有确定性校正与测试守护。0.13.2/0.13.3/0.13.4 又把这层实践向内收敛：tally 去重收窄为两个独立开关、agentic 通道接入双池并发、`read_code` 重复读抑制、工具层补齐 CRLF/字符上限/死链等翻车点（README.md:59）。以下按命名约定、错误处理、构建测试、目录布局、配置声明、锚点引用六个维度归纳反复出现的模式，每条给出文件与行号出处（行号以 `read_code` 返回的前缀为准）。

## Patterns

### 命名约定模式

- 常量全大写蛇形、集中在模块顶部：并发硬顶 `CONCURRENCY_HARD_CAP` (`index.js:33`)、默认并发 `DEFAULT_CONCURRENCY` (`index.js:35`)、普通编译档 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL` (`index.js:39-40`)、大档三件 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`/`DEFAULT_BIG_TOKEN_BUDGET` (`index.js:45-48`)、自动提交路径白名单 `WIKI_PATHS` (`index.js:581`)；token 预算 `BATCH_TOKEN_BUDGET` (`index.js:586`) 与大档硬上限 `BATCH_TOKEN_HARD_LIMIT` (`index.js:42`) 单独成节并附上下文窗口推导注释（hy3 192k 窗口扣除 64k 输出上限后输入必须 ≤128k，`index.js:40-47`）。
- 吸收自 FSoft CodeWiki 的三层能力以 lib/ 子模块承接、顶部集中导入：lib/symbols.js（AST 符号提取，导出 `extractRepoGraph`/`resolveImportEdges`）、lib/cluster.js（语义聚类，`clusterComponents`/`toPlanModules`）、lib/graph-diff.js（组件级 diff，`diffGraphs`）、lib/incremental.js（快照与折算，`slimGraph`/`graphFromSnapshot`/`loadSnapshot`/`filterStaleTasks`/`describeChange`/`sameSnapshotContent`）、lib/articles-agentic.js 与 lib/agentic.js（agentic 写作循环，`runAgenticArticles`/`markBigAgenticTasks`/`sourceTokensOf`、`buildOpeningPrompt`/`TOOL_SCHEMAS`），导入面集中在 `index.js:24-32`——主文件只做编排，能力实现按层落 lib/。
- 运行期路径与阈值常量同样大写：jobs 持久化文件 `JOBS_FILE` (`index.js:1655`)、服务节拍 `TICK_MS` (`index.js:1656`)、会话通道超时与任务目录 `SESSION_TASK_TIMEOUT_MS`/`SESSION_TASK_DIR` (`index.js:1661-1662`)、会话记录 TTL 与目录 `SESSION_TTL_MS`/`SESSIONS_DIR` (`index.js:1672-1673`)、孤儿接管阈值与历史保留上限 `ORPHAN_TAKEOVER_MS`/`MAX_JOBS_KEPT` (`index.js:1849-1850`)、已知仓库清单 `REPOS_FILE` (`index.js:1854`)、终态集合 `JOB_TERMINAL` (`index.js:1879`)、扫描黑名单与上限 `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES` (`index.js:1894-1906`)、tick 进程锁 `JOBS_LOCK_FILE` (`index.js:1948`)、判定缓存 TTL `WORKTREE_CACHE_TTL_MS` (`index.js:395`) 与 `SOURCE_PROBE_TTL_MS` (`index.js:375`)。
- 函数小驼峰、按层分组：路径与进程层 `normalizeCwd` (`index.js:140`)、`resolveBinary` (`index.js:162`)、`runCw` (`index.js:439`)；token 估算与装填 `estimateTokens` (`index.js:1017`)、`collectSources` (`index.js:1088`)、`prepareArticleTasks` (`index.js:1332`)、`packArticles` (`index.js:1896`)；扫描与规划 `scanRepoFiles` (`index.js:1223`)、`localPlan` (`index.js:1245`)、语义规划 `semanticPlan` (`index.js:378`)；编译对象闸门一组 is/has 前缀布尔语义 `isWorktreeCwd` (`index.js:397`)、`hasCompilableSources` (`index.js:413`)、`clearSourceProbeCache` (`index.js:49`)、`isDeadCompileTarget` (`index.js:2056`)；服务工厂 `createJobService` (`index.js:3150`)、主循环 `tick` (`index.js:4348`)、插件入口 `apply` (`index.js:423`)。
- prompt 模板函数统一 batch 前缀：文章 `batchArticlePrompt` (`index.js:1048`)，横切三件套 `batchArchitecturePrompt` (`index.js:1375`)、`batchPatternsPrompt` (`index.js:1383`)、`batchConceptPrompt` (`index.js:1393`)，观察与合成 `batchObservePrompt` (`index.js:1414`)、`batchArticleObservePrompt` (`index.js:1434`)、`batchArticleComposePrompt` (`index.js:1466`)，校对 `batchProofreadPrompt` (`index.js:1489`)、批量校对 `batchProofreadBatchPrompt` (`index.js:1367`)。
- 阶段处理器 tick 前缀 + 表驱动分派：`tickArticles` (`index.js:2585`)、`tickCrosscut` (`index.js:2801`)、`tickCompose` (`index.js:2887`)、`tickReview` (`index.js:2936`)、`tickIndex` (`index.js:3049`)、`tickCommit` (`index.js:3123`)，由 `STAGE_HANDLER` (`index.js:3141-3148`) 映射、主循环 `tick` (`index.js:3150`) 逐 job 调用——阶段机行为集中在一张表上。
- 两条并列执行器 Run 后缀：单轮整包装填通道 `startBatchChatRun` (`index.js:2338`) 与 agentic 工具循环通道 `startAgenticRun` (`index.js:2385`)，结果同进 `batchResults`/`batchRuns`/`batchAborters` (`index.js:2337-2339`) 由 `settleJob` (`index.js:2196`) 统一收割——通道可以换，收割口只有一个。
- 工具定义工厂 ToolDefinition 后缀：`cwToolDefinition` (`index.js:3357`)、`generateToolDefinition` (`index.js:3579`)、`updateToolDefinition` (`index.js:3650`)、`progressToolDefinition` (`index.js:4348`)，由 `apply` (`index.js:3858`) 统一注册，面板端点由 `installWebServer` (`index.js:3796`) 布线；设置页数据源是导出纯函数 `listModelCatalog` (`index.js:3834`) 与 `resolveModelEfforts` (`index.js:1522`)。
- 宿主接口兼容包装用 Of 后缀：`resolveModelInfoOf` (`index.js:3823`) 优先 `resolveModelInfo`、缺失时回落 `resolveModel`，把「宿主暴露哪个方法名」的不确定性收在一处。
- 配置字段按模型档位加前缀分组：普通编译档 batchProvider/batchModel/batchReasoningEffort（`index.js:76-78`）、大档 bigProvider/bigModel/bigReasoningEffort/bigTokenBudget（`index.js:60-63`）、会话兜底 sessionTier（`index.js:76`）、并发双档 maxConcurrency/bigConcurrency（`index.js:76-77`）、多仓库调度 serialProjects/parallelProjects（`index.js:76-77`）；0.13.0 新增编译流程四键 `planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`（`index.js:79-82`），与 autoCommit/excludePaths/autoUpdate/autoUpdateMin/workspaceOnly 一起声明在 `Config`（`index.js:60-86`），README 与设置页沿用同一套键名。
- 会话记录函数统一 Session/Record 词根：落盘辅助 `sessionDirFor` (`index.js:1675`)、`writeSessionMeta` (`index.js:1685`)、`writeSessionFull` (`index.js:1693`)，单任务列表 `listSessionRecords` (`index.js:1703`)、单条全文 `readSessionRecord` (`index.js:1709`)、全局聚合 `listAllSessionRecords` (`index.js:1731`)、过期清理 `pruneSessionRecords` (`index.js:1763`)、请求开始挂钩 `beginSessionRecord` (`index.js:1678`)。
- 任务标记布尔/字段是通道分派的唯一依据：`bigTier` 由装填点统一打标——文章 `markBig` 闭包 (`index.js:1100-1108`)、横切单批直出 (`index.js:2981-2988`)、批量校对 `markBigTask` (`index.js:514-520`)，执行器 `runRealtimeTasks` (`index.js:2585-2644`) 只看该标记分池、不按 provider 猜 (`index.js:2196-2214`)；agentic 任务在任务上打 `agentic: true`（`index.js:2310`，在 `tickArticles` 组装 agentic 任务时写入），宿主重启后 `settleJob` 据此按 agentic 通道整批重跑（`index.js:1914-1920`）而不是找 prompt 快照；0.13.2 起 agentic 通道也接双池——`markBigAgenticTasks`/`sourceTokensOf` 按模块源文本量给超大模块打大档标记（`index.js:23-34`）。
- 测试辅助统一命名：断言函数 `check`（`test-batch.mjs:17`、`test-orchestration.mjs:51`、`test-wiki-anchors.mjs:172`、`test-wiki-entry.mjs:19`）四处同款——成功打 ✓ 计数、失败打 ✗ 收集；分组标题 `section`（`test-batch.mjs:21`）；mock 工厂统一 make 前缀：`makeCtx` (`test-orchestration.mjs:110`)、`makeFixtureRepo`（实际为内联闭包 `repo` 在 `test-wiki-entry.mjs:19`、`makeBatchMock` (`test-orchestration.mjs:145`)、`makeLlm` (`test-batch.mjs:174`)、带延迟的 `makeSlowLlm` (`test-batch.mjs:233`)；请求桩 fake 前缀见 `fakeReq`/`fakeRes`；mock 配置基线 `batchCfg` (`test-orchestration.mjs:45`) 与文章夹具 `articleMd` (`test-orchestration.mjs:33`)。
- slugify 保留汉字：`slugify` (`index.js:1593-1595`) 的清洗正则显式保留 CJK（\p{Script=Han}）区段，中文顶层目录名直接作模块名，避免多个中文目录塌缩合并成单模块。
- 浏览器半侧组件大驼峰、辅助小驼峰：设置卡 `CodewikiCard` (`client.js:1177`)、总览页 `ReposTab` (`client.js:1326`)、会话视图 `SessionView` (`client.js:1418`)、侧边栏面板 `CodewikiPanel` (`client.js:1665`)、面板图标 `PanelIcon` (`client.js:1100`)；渲染辅助 `stageBar` (`client.js:1125`)、`overallPct` (`client.js:1136`)、`throughputBadge` (`client.js:1158`)、`usageLine` (`client.js:1077`)、`Spark` (`client.js:489`)；请求封装 `apiGet` (`client.js:495`)、`apiPost` (`client.js:33`)；阶段条与进度权重随服务端阶段机同步纳入 commit（`ACTIVE_STAGES` (`client.js:1124`)，权重 `STAGE_WEIGHTS` (`client.js:548`) articles 0.63 / commit 0.02）。
- 文档大写命名：README、CHANGELOG、CodeWiki 三个大写 Markdown 分别承担定位说明、版本化变更史与 wiki 入口公约（`CodeWiki.md:1`）。

### 错误处理与失败记账风格

- 断言收集而非立即中断：各测试的 check 只累计与打印（成功 ✓、失败收进 failures），结尾统一汇总并按失败数退出——`test-batch.mjs:638-641` 打印 ALL PASS/FAIL 并 exit 1，`test-orchestration.mjs:1528-1529` 同款收尾；单条失败不中断，一次运行给出全景。
- 外部进程统一封装：`runCw` (`index.js:162-187`) 收集 stdout/stderr、超时 SIGKILL 与 abort 中止；`resolveBinary` (`index.js:140-160`) 按显式配置 → PATH 探测 → 捆绑副本顺序解析，探测失败静默兜底。
- 路径错误干净抛出：`test-cwd-paths.mjs:62-69` 断言不存在的目录必须抛出含「cwd 不存在」的明确错误，而不是静默兜底或误判状态。
- 唯一模型通道 + 单任务失败记账：`llmChat` (`index.js:457-482`) 是唯一模型通道（「唯一通道、插件不碰密钥」写在通道头注释 `index.js:514-516`），流式 finish 为 error/aborted 时统一抛错；`runRealtimeTasks` (`index.js:486-545`) 并发池逐任务捕获异常，失败写入 notes 后继续消费队列 (`index.js:481-485`)；`applyTaskResult` (`index.js:481-494`) 落盘异常同样只记账不中断；阶段处理器抛错由主循环统一捕获置败 (`index.js:481-485`)。
- 不被支持的思考档位自动回落（0.11.1）：`llmChat` 对 finish 错误码 `UNSUPPORTED_REASONING_EFFORT` 剥掉 effort 用模型默认档重试一次 (`index.js:452-456`)——任何模型/配置组合不再因此整篇失败；大档任务自带 provider/model 时 `reasoningEffort` 完全以任务为准、不回落普通档配置 (`index.js:472-476`)。
- 坏输出不落盘：keepInMemory 产物（横切/校对/合成）的唯一写盘闸门 `writeValidated` (`index.js:2231-2245`)——输出必须以 frontmatter 开头，否则保留原文件并记 note。
- 宿主重启恢复有两条兜底：执行器丢失时 `settleJob` (`index.js:2196-2225`) 先认 agentic 任务标记整批重跑 (`index.js:805-811`，agentic 任务没有 prompt 快照、源码是模型现场读的)，否则按 job.tasks 持久化的 `batchPrompt` 快照重跑本阶段 (`index.js:805-810`)，两者都不满足才 fail——请求随连接生死，快照是唯一恢复路径。
- 取消语义收口在一处：`syncCancelFlags` (`index.js:2172-2183`) 每轮 tick 从磁盘跨实例拾取取消标记，终态收尾时中断在飞请求并丢弃未收割结果 (`index.js:1890-1899`)。
- 多实例并发安全：tick 进程锁 `acquireTickLock` (`index.js:1951-1965`) 崩溃残留 60s 过期强删；job 记录创建者 `instanceId` (`index.js:2064`)，他实例任务停更超 `ORPHAN_TAKEOVER_MS` 才接管 (`index.js:1848-1858`)；脏标记加 `mergeFromDisk` (`index.js:2110-2131`) 磁盘吸收，防止实例间互相覆盖。
- 三层能力全部「宁可降级不中断」（0.13.0）：语义规划 `semanticPlan` 各环节失败返回 `{ plan: null, fallback: true, reason }`（提取器不可用 `index.js:1245`、提取失败 `index.js:2436`、无组件 `index.js:1223`、聚类失败 `index.js:1216`、空计划 `index.js:2294`），`buildPlan` (`index.js:941-964`) 据此退回 `localPlan` 并把原因写进 note；agentic 写作失败率严格过半才退回单轮通道（`shouldFallBackFromAgentic` (`index.js:2019-2024`)），且每 job 只退一次（`shouldFallBackHere` 另守 `agenticRetried`，`index.js:963-970`），退回时只重排失败篇 (`index.js:963-1001`)；符号级增量拿不到快照/提取失败一律退回文件级判定（`index.js:963-981`），快照写入失败也只记 note (`index.js:963-965`)。
- 符号级判定把全部文章滤掉时不提交空任务：代码确实变了但只动了实现细节时，直接刷新编译基线（meta update）让 cw status 回到 clean，并写明「未重写任何文章」(`index.js:3252-3258`)。
- 记账去重收窄为两个独立开关（0.13.2）：`tally` (`index.js:2259-2290`) 不再无条件按名字去重——`replace=true`（校对阶段，同名覆盖）与 `mergeByName=true`（文章/观察/合成的重跑路径）各管一件事，正常首次 tally 不合并（语义注释 `index.js:1984-1992`、按名合并判定 `index.js:1984-1986`）；曾成功的条目不因后续失败被抹掉 (`index.js:1984-1986`)。
- 持久化瘦身：语义规划结果 `plan` 随 job 整体写进 JOBS_FILE，因此组件图**不带** sourceCode——判变更只用 bodyHash/签名/依赖，全量源码进来一份 job 就多几百 KB（`index.js:1018-1045`）。
- 阶段内失败局部降级：横切合成批提交失败只跳过横切进校对、不推翻整个任务（`submitComposeBatch` (`index.js:2901-2911`)）；文章观察批全部失败时该篇缺席并记 note (`index.js:2626-2627`)、不 fail 整个 job (`index.js:2626-2630`)。
- 拒绝式安全边界（编译产物自动提交）：`autoCommitWiki` (`index.js:4186-4268`) 对非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中、路径存在未解决冲突、产物被 gitignore 忽略、缺 git 身份、add/commit 自身失败等任一情形一律返回 committed:false 加原因并降级为一次性提醒，绝不做半个提交（全部前置检查都在分支切换之前执行）。
- 提交升级为分支合并式（0.10.11）：先在主题分支 codewiki/wiki-\<jobId\> 上提交、再合并回原分支并删主题分支——`commitOn` (`index.js:4217-4229`) 用 pathspec 形式的 git add 只暂存两个产物路径（绝不 -A）。
- 提交的分支路径降级：进入主题分支后任何失败都先经 finally 守卫切回原分支 (`index.js:3963-3969`)，绝不把用户留在插件建出的分支上；合并冲突/失败一律中止合并并保留主题分支等手动合并、`branch -d` 只删已合并分支绝不强删 (`index.js:3973-3983`)；detached HEAD 或建主题分支失败降级为直接提交 mode:'direct' (`index.js:3952-3961`)。
- 提交三态单点判定：`autoCommitState` (`index.js:2032-2037`) 把 committed/no-changes/pending 收口成一个纯函数，实时唤醒通道 `wakeCompileSession` (`index.js:2039-2054`) 与系统提示通道 `commitHintText` (`index.js:4270-4301`) 共用同一结论——「产物无改动」不会被两条通道各催一次；成功且已提交/无改动时唤醒直接 return (`index.js:3990`)，完全不打扰会话。
- 提交期失败不重复唤醒：`fail` (`index.js:2185-2193`) 识别 submitting 占位阶段——错误已随工具调用同步返回，跳过终态唤醒回调。
- 唯一通道缺配置诚实报错并落痕：`submit` (`index.js:63`) 校验 `batchProvider`/`batchModel` 非空且 llm 服务已注入，缺失即抛错并把 job 置 failed 留痕（校验块 `index.js:63-74`）；测试断言报错指向设置项且 jobs 文件里留下 failed 任务（`test-orchestration.mjs:1465-1478`）。
- 会话兜底不可用直接置败：`dispatchSessionTasks` (`index.js:2503-2537`) 在发起会话缺失、steer 失败或任务文件写失败时直接置败并写明原因，不静默降级；会话通道收割判定 `classifySessionTask` (`index.js:1811-1821`) 超时优先于已产出——超时任务即使文件刚写完也不收割 (`index.js:1529`)。
- 编译对象闸门（拒绝明显无效的目标）：`detectLinkedWorktree` (`index.js:354-370`) 只用 git 自己判 linked worktree；`submit` (`index.js:3238-3252`) 与工具 execute (`index.js:1869-1890`) 双处拦截 worktree 与扫不出可编译源码的空壳目录——auto 静默跳过、手动路径抛错；反登记由 `forgetRepo` (`index.js:1587-1595`) 只摘插件自己的仓库清单、不碰用户磁盘。
- 启动清理：服务启动时把 worktree 与空壳目录上的历史任务一次性移出作业历史 (`index.js:423-438`)，已知仓库登记同步摘除——目录已不存在时不算 dead，历史记录不被抹掉（判定在 `isDeadCompileTarget` (`index.js:418-426`)）。
- 校对失败不推翻原文：`settleProofread` (`index.js:2305-2329`) 按 @@@article 标记拆回逐篇、经 `writeValidated` 校验通过才覆写，缺席或非法的文章保留原文。
- 端点异常可诊断：jobs/repos 两个 handler 的 catch 把错误与栈前 8 行写进 500 响应体 (`index.js:3650-3653`、`index.js:3744-3746`)，规避宿主对 handler reject 只回 400 空 body 的排查盲区；工作区注册表的 list() 抛错时过滤整体降级停用 (`index.js:3599-3606`)，不让体验优化拖垮端点。
- 会话记录尽力而为、绝不影响编译：`writeSessionMeta`/`writeSessionFull` (`index.js:1685-1698`) 全部 try/catch 吞错（tmp 不可写则放弃记录），`pruneSessionRecords` (`index.js:1731-1751`) 单文件清理失败不拖累整轮。
- 工具结果节流（0.13.3）：`read_code` 重复读抑制——模型反复读同一段时只回提示、不回吐正文，且去重判定发生在读盘之前（真实探针：重复读 12 → 5 次、上下文 2144 → 1413KB、`stopReason` 由 max-steps 变 finished，`CHANGELOG.md:92`）；`toRequestMessages` 用模块级 `WeakMap` 缓存已构造的正式消息，保证同一条消息跨轮次 MessageId 身份稳定（`CHANGELOG.md:95`）。
- 面板时间语义不误导：已用时拆「排队 / 执行」两段（`elapsedSplit` (`client.js:1529-1533`)，排队时长取 stageTimings.queued）；`lastTimedStage` (`client.js:1096-1099`) 把计时键过滤到当前阶段集合——旧任务残留已删阶段（如 plan）的键不再导致失败/取消时步骤条全熄不标红。
- 行号锚点确定性校正：`fixAnchors` (`index.js:779-899`) 落盘前对照 source_files 源码机械校正——起点行不含符号时找唯一出现或唯一声明形态，歧义与未找到记 unresolved 不动，区间尾越界钳到文件尾。

### 构建与测试流程模式

- 全部测试直测插件主体：`test-batch.mjs:7-12` 与 `test-wiki-entry.mjs:10` 静态 import 纯函数，`test-orchestration.mjs:24` 动态加载并断言插件名 (`test-orchestration.mjs:279`)，`test-cwd-paths.mjs:20` 加载后取注册表验证工具行为。
- 通道基线显式钉住（0.13.0）：三层新能力默认全开，但编排冒烟断言的是旧通道的请求次数与装填时序——配置基线用 `LEGACY_CHANNEL` 把 planMode/agenticArticles/symbolIncremental 显式关掉（`test-orchestration.mjs:44-45`），让该文件继续守护旧通道；新通道由 test-symbols/test-cluster/test-agentic/test-agentic-host/test-agentic-fallback/test-articles-agentic/test-semantic-plan/test-graphdiff/test-incremental* 等专属文件守护（全量 17 个测试文件回归清单见 `CHANGELOG.md:102`）。
- fixture 用临时目录与真实 git：`makeFixtureRepo` (`test-orchestration.mjs:110-127`) 建仓并显式配置 git user.name/user.email（`test-orchestration.mjs:110-111`，缺身份时自动提交会被安全边界拒绝）；各测试节用 fs.mkdtempSync 建独立 tmp 目录（`test-batch.mjs:33`、`test-batch.mjs:56`、`test-batch.mjs:136`、`test-batch.mjs:375`、`test-batch.mjs:525`），收尾统一删除。
- 超大源文件驱动预算分支：`test-batch.mjs:58-59` 写入 420KB 的 big.ts 与 800KB 的 huge.ts，分别命中「大档单请求写完」与「连大档都装不下转会话通道」两条路径。
- mock 宿主上下文复刻 cordis 语义：`makeCtx` (`test-orchestration.mjs:51-91`) 的 inject 兼容回调与 Promise 两种风格、按 ctx 切片传参以暴露严格语义；`llmProxy` (`test-orchestration.mjs:133-140`) 把请求转发给当前生效的假 llm，每个测试块只需 `makeBatchMock` (`test-orchestration.mjs:145-209`) 一处接线——假 llm 按 prompt 首行特征分发应答，支持 `stall` 挂起 (`test-orchestration.mjs:184-191`) 模拟取消与超时；mock 配置基线 `batchCfg` (`test-orchestration.mjs:45`) 显式给出 provider/model（0.10.1 起留空即提交失败）。
- 并发分池测试统计在飞峰值（0.12.2）：`makeSlowLlm` (`test-batch.mjs:233`) 给每个请求加 30ms 延迟，`poolProbe` (`test-batch.mjs:244`) 按 bigTier 标记统计两池各自的在飞峰值——默认档并发 2 / 大档并发 1 下断言默认档峰值恰为 2、大档恰为 1、总峰值 ≥ 2（两池同时推进，`test-batch.mjs:232-251`），大档并发缺省时断言跟随默认档 (`test-batch.mjs:232-245`)。
- 并发测试用挂起而非快速失败当 mock：0.10.10 修复的竞态表明「模型立即失败」会让任务几百毫秒内进终态、后续提交查不到活动任务而新建重复 job——并发块改用 `stall` 让任务停在 articles 并在收尾用 control 取消 (`test-orchestration.mjs:993-997`)；jobs 文件名只带 pid 会在 Windows pid 复用时读入历史残留，测试文件名追加随机 `TEST_JOB_TOKEN` (`test-orchestration.mjs:22-23`) 并收尾删除。
- 环境变量驱动加速与隔离：测试把 tick 压到 300ms（`test-orchestration.mjs:15`，服务端下限 250ms 见 `TICK_MS` (`index.js:1655`)）；服务端路径与阈值常量全部可用环境变量覆盖——`JOBS_FILE` (`index.js:1660`)、`SESSION_TASK_TIMEOUT_MS` (`index.js:1848`)、`ORPHAN_TAKEOVER_MS` (`index.js:1854`)、`REPOS_FILE` (`index.js:1572`)。
- 轮询终态等待：`waitJob` (`test-orchestration.mjs:212-225`) 每 150ms 读 jobs 文件、等 done/failed/cancelled 终态，超时兜底返回。
- 验证命令文档化：`README.md:91` 记录语法检查与编排冒烟的运行方式；CHANGELOG 每条变更以测试结论与版本号收尾（如 0.12.2 的测试/文档/版本三连，`CHANGELOG.md:205-206`），测试结论可追溯。

### 目录与仓库布局约定

- 插件根共置核心文件：服务端单文件 index.js 与浏览器半侧 client.js 同置根目录，加上挂载补丁 cordis.patch.yml 与包声明 package.json 构成全部安装面；0.13.0 起能力实现下沉 lib/ 子目录（symbols/cluster/graph-diff/incremental/agentic/agentic-host/articles-agentic，导入面集中在 `index.js:16-24`）。
- gitignore 划界：`.gitignore:2` 忽略上游 cargo 产物、`.gitignore:3` 通配忽略全部日志、`.gitignore:6` 忽略二进制备份、`.gitignore:8-9` 忽略探针残留（.orch-test-out.txt / .probe3.txt）、`.gitignore:12` 忽略运行期面板产物；`node_modules/`（`.gitignore:1`）同时让 vendor/tree-sitter 子根的依赖不入库——新机器按需安装（`README.md:41`）。
- 上游源码与捆绑二进制分离：上游源码在 vendor/codewiki，`resolveBinary` (`index.js:140-160`) 的解析顺序是显式配置 → PATH 探测 → 捆绑 bin/cw.exe 兜底，改动 vendor 后需重编二进制（`README.md:86-87`）。
- 依赖落位避开宿主 node_modules：AST 依赖装在独立的 vendor/tree-sitter npm 子根而非插件根 node_modules——后者由宿主注入，在那里装包会顶掉宿主依赖（`CHANGELOG.md:179`）；没装时插件照常启动，三层能力全部降级（`README.md:41`）。
- wiki 固定落仓库内：`wikiPathFor` (`index.js:1633-1638`) 优先取 cw path 输出、失败回落仓库根 .codewiki；横切产物固定写 wiki 根的 _architecture 与 _patterns 两篇、概念进 concepts/、模块进 modules/（`crosscutTasks` (`index.js:2780-2799`)）。
- 运行期状态集中系统临时目录：`JOBS_FILE` (`index.js:1655`)、会话任务文件目录 `SESSION_TASK_DIR` (`index.js:1661`)、已知仓库清单 `REPOS_FILE` (`index.js:1854`)、会话记录目录 `SESSIONS_DIR` (`index.js:1672`，按 jobId 分目录存 meta+full 双文件、TTL 24h 由 tick 定期清理) 全部派生自同一 tmp 目录，随宿主实例生命周期管理。
- 符号快照随 wiki 入库：0.13.0 的符号级增量把快照存 .codewiki/temp/symbol-graph.json（随 wiki 提交、换机器/换会话仍有效，`README.md:61`）；编译收尾在 `tickIndex` 内对比内容、无变化不覆盖以免空转提交（快照段落 `index.js:3049-3070`，内容相同跳过写入 `index.js:2774-2778`）。
- 入口自狗粮：根目录的 CodeWiki.md 声明本插件自身就是一个可被编译的 wiki 项目（`CodeWiki.md:3`），编译产物与源码同仓库提交共享。
- 产物纳入锚点守护：编译出的 .codewiki/ 全部文章被锚点守护测试逐篇扫描（`test-wiki-anchors.mjs:38` 定位 wiki 目录）——文档、产物与测试互相约束。

### 配置热生效与 Schema 声明模式

- Config 全字段 volatile 热读取：`Config` (`index.js:60-86`) 每一项都链式标记 volatile——enabled、binaryPath、编译模型三项、大档四项、sessionTier、maxConcurrency/bigConcurrency、serialProjects/parallelProjects、articleLanguage、0.13.0 的 planMode/agenticArticles/agenticMaxSteps/symbolIncremental、updateReminder、autoCommit、excludePaths、autoUpdate/autoUpdateMin、workspaceOnly；execute 与 tick 每次经 liveConfig 热读取，改配置无需重启。
- 解包与扁平化：`val` (`index.js:88-90`) 兼容 schemastery 的取值形态；`liveConfig` (`index.js:92-134`) 每次调用重新解包。
- 钳制规则集中一处：maxConcurrency 钳到 1–8 (`index.js:76-78`)、bigConcurrency 0/未填表示跟随默认档 (`index.js:76-79`)、parallelLimit 串行时恒 1、关闭串行后按 parallelProjects 取 1–4 (`index.js:76-80`)、bigTokenBudget 以普通预算兜底 (`index.js:76`)；0.13.0 新键同款——`planMode` 只接受 auto/dirs 白名单 (`index.js:78`)、`agenticMaxSteps` 钳 1–100 默认 30 (`index.js:78-81`)；布尔开关统一按「非 false 即开」取默认 (`index.js:78`、`index.js:78`、`index.js:78`、`index.js:78-79`)。
- 默认值常量化：schema 默认值与运行期回落统一引用模块顶部常量区 (`index.js:31-45`)，模型档位调整只改一处。
- 挂载声明三处对齐：cordis.patch.yml 顶层的插入条目 (`cordis.patch.yml:19-24`)、包元数据的 bundle 补丁指向 (`package.json:24-26`) 与客户端命名空间常量 `NS` (`client.js:17`) 使用同一个 id，设置读写与挂载走同一命名空间。
- 客户端半侧按包声明被发现：package.json 的 exports 暴露 client 子路径入口 (`package.json:8-11`)、dsh 元数据声明 web 平台 (`package.json:20-23`)，宿主扫描器沿 file:/// 挂载条目把客户端模块送进浏览器。
- 保存走键白名单：设置卡保存函数遍历 25 个配置键生成单层 set 操作列表 (`client.js:76`，含 0.13.0 的 `planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`)，经 configForms 以 revision CAS 提交，与补丁文件手改等价且同样热生效（保存与校验逻辑在 `client.js:79-118`）。
- 模型目录联动复用：`modelTrio` (`client.js:658-762`) 把提供商/模型/思考程度三行渲染抽成普通档与大档共用；`useEfforts` (`client.js:620-651`) 在选中提供商与模型后二次拉取该模型档位，档位取值不手填裸字符串；模型目录未声明档位时退回 `GENERIC_EFFORTS` 通用档位下拉 (`client.js:30`)，选了模型不支持的值由插件内剥档重试兜底（不会失败）。
- 设置页随流水线能力扩展：0.13.0 新增「编译流程（吸收自 FSoft CodeWiki）」一节渲染 planMode 下拉与三个开关/步数输入 (`client.js:947-992`)；面板阶段条与进度权重随 commit 阶段同步扩展（`client.js:33`、`client.js:1124`）。

### 行号锚点与文档引用约定

- 源码行号前缀是唯一行号依据：`numberLines` (`index.js:602-605`) 给内联源码每行加 grep 风格「N| 」前缀（尾换行只去一个、CRLF 行尾剥离），模型引用行号一律以前缀为准。
- prompt 条款绑定前缀：`articleFormatSection` (`index.js:1179-1209`) 注入的格式条款明令「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（条款原文在 `index.js:897`）。
- 两个写盘出口统一过锚点修正：普通文章直写 `applyTaskResult`（`index.js:486` 调用）与 keepInMemory 闸门 `writeValidated`（`index.js:2231` 调用）都先跑 `fixAnchors`，修正数与存疑项写入 notes。
- agentic 通道同享修正：agentic 写作执行器把 `fixAnchors` 注入文章循环 (`index.js:779`)，模型现场读代码写出的文章同样在服务侧落盘前校正。
- 测试三重断言守护锚点：`test-wiki-anchors.mjs:232-277` 主循环对每个锚点校验——行号在文件行数内且指向非空行 (`test-wiki-anchors.mjs:297、304`)、区间起止有序且终点在范围内 (`test-wiki-anchors.mjs:307-309`)、单锚点行的反引号符号至少一个出现在目标行或区间内 (`test-wiki-anchors.mjs:369-389`)；一行并列多个锚点时不做符号绑定（无法可靠归属），由「行号在范围内 + 指向非空行」兜底 (`test-wiki-anchors.mjs:204-211`)。
- 符号提取两处同源：`symbolsOnLine` (`test-wiki-anchors.mjs:187-198`) 的提取规则被 fixAnchors 复制——同源声明在 `index.js:639-641`、本地实现在 `index.js:629-639`（改一处须同步另一处）；`nearestSymbol`（index.js 中）实现了「按离锚点最近选符号」的备选辅助逻辑。
- Obsidian 反链接连接模块：格式条款要求 Connections 用 Obsidian [[backlinks]]（[[other-module]]）连接相关模块（条款在 `index.js:923`）。
- Windows 反斜杠路径收口：`parseStatus` (`index.js:213-226`) 把 cw 输出的文章路径统一正斜杠化（`normalizeArticlePath` (`index.js:203`)），`normalizeIndexLinks` (`index.js:199-207`) 只修索引文件链接头、不碰正文——对旧二进制反斜杠输出的纵深防御。
- 入口文件缺失自动生成：`ensureWikiEntry` (`index.js:291-324`) 编译收尾按文章语言生成中/英双语入口（含 .codewiki 绝对路径与收尾工具指引），已有入口绝不覆盖。
- 入口行为有专属测试：`test-wiki-entry.mjs:26-54` 覆盖缺失生成、已有不覆盖、重复调用幂等与英文文案分支。
