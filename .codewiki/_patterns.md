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
  - index.js
  - client.js
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

本仓库是 @local/dsh-codewiki 插件——把 mraza007/codewiki 的 Rust CLI cw 接入 DeepSeek Harness，提供仓库内代码 wiki（位于各仓库 .codewiki/ 目录、随仓库提交共享）的提交制编译与维护（`README.md:3`）。0.13.0 起吸收 FSoft-AI4Code/CodeWiki 的三层能力（AST 符号提取 + LLM 语义聚类、agentic 工具循环写作、符号级增量判定），全部以 lib/ 子模块用 Node + tree-sitter WASM 实现、默认全开且任一环节不可用自动降级回旧行为（`README.md:5`）。代码围绕「提交制编译 + 宿主常驻服务推进阶段机（写文章→横切→合成→校对→索引→提交）+ 插件内双档并发池（默认档/大档分池限流）+ 零子代理 + 编译收尾插件自动提交（主题分支合并式）+ 三层能力分层降级」形成一系列一致的工程实践：命名按层分组、失败一律记账不中断、配置全字段热生效、测试直测插件主体并以 mock 宿主 llm 服务驱动、文档行号锚点有确定性校正与测试守护。0.13.2/0.13.3 又把这层实践向内收敛了一步：tally 去重收窄为两个独立开关、agentic 通道接入双池并发、`read_code` 重复读抑制、MessageId 身份稳定。以下按命名约定、错误处理、构建测试、目录布局、配置声明、锚点引用六个维度归纳反复出现的模式，每条给出文件与行号出处。

## Patterns

### 命名约定模式

- 常量全大写蛇形、集中在模块顶部：并发硬顶 `CONCURRENCY_HARD_CAP` (`index.js:31`)、默认并发 `DEFAULT_CONCURRENCY` (`index.js:33`)、普通编译档 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL` (`index.js:35-36`)、大档三件 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`/`DEFAULT_BIG_TOKEN_BUDGET` (`index.js:39-42`)、自动提交路径白名单 `WIKI_PATHS` (`index.js:45`)；token 预算 `BATCH_TOKEN_BUDGET` (`index.js:541`) 与大档硬上限 `BATCH_TOKEN_HARD_LIMIT` (`index.js:546`) 单独成节并附上下文窗口推导注释（hy3 192k 窗口扣除 64k 输出上限后输入必须 ≤128k，`index.js:31-38`）。
- 吸收自 FSoft CodeWiki 的三层能力以 lib/ 子模块承接、顶部集中导入：lib/symbols.js（AST 符号提取）、lib/cluster.js（语义聚类）、lib/graph-diff.js（组件级 diff）、lib/incremental.js（快照与折算）、lib/articles-agentic.js 与 lib/agentic.js（agentic 写作循环），导入面集中在 `index.js:16-24`——主文件只做编排，能力实现按层落 lib/（各文件行数核对记录见 `CHANGELOG.md:101`）。
- 运行期路径与阈值常量同样大写：jobs 持久化文件 `JOBS_FILE` (`index.js:1294`)、服务节拍 `TICK_MS` (`index.js:1295`)、会话通道超时与任务目录 `SESSION_TASK_TIMEOUT_MS`/`SESSION_TASK_DIR` (`index.js:1299-1300`)、会话记录 TTL 与目录 `SESSION_TTL_MS`/`SESSIONS_DIR` (`index.js:1310-1311`)、孤儿接管阈值与历史保留上限 `ORPHAN_TAKEOVER_MS`/`MAX_JOBS_KEPT` (`index.js:1487-1488`)、已知仓库清单 `REPOS_FILE` (`index.js:1493`)、终态集合 `JOB_TERMINAL` (`index.js:1518`)、扫描黑名单与上限 `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES` (`index.js:1521-1533`)、tick 进程锁 `JOBS_LOCK_FILE` (`index.js:1587`)、判定缓存 TTL `WORKTREE_CACHE_TTL_MS` (`index.js:330`) 与 `SOURCE_PROBE_TTL_MS` (`index.js:350`)。
- 函数小驼峰、按层分组：路径与进程层 `normalizeCwd` (`index.js:49`)、`resolveBinary` (`index.js:140`)、`runCw` (`index.js:162`)；token 估算与装填 `estimateTokens` (`index.js:394`)、`collectSources` (`index.js:656`)、`prepareArticleTasks` (`index.js:727`)、`packArticles` (`index.js:971`)；扫描与规划 `scanRepoFiles` (`index.js:1535`)、`localPlan` (`index.js:862`)、语义规划 `semanticPlan` (`index.js:884`)；编译对象闸门一组 is/has 前缀布尔语义 `isWorktreeCwd` (`index.js:333`)、`hasCompilableSources` (`index.js:352`)、`clearSourceProbeCache` (`index.js:368`)、`isDeadCompileTarget` (`index.js:378`)；服务工厂 `createJobService` (`index.js:1695`)、主循环 `tick` (`index.js:2771`)、插件入口 `apply` (`index.js:3969`)。
- prompt 模板函数统一 batch 前缀：文章 `batchArticlePrompt` (`index.js:687`)，横切三件套 `batchArchitecturePrompt` (`index.js:1006`)、`batchPatternsPrompt` (`index.js:1014`)、`batchConceptPrompt` (`index.js:1022`)，观察与合成 `batchObservePrompt` (`index.js:1032`)、`batchArticleObservePrompt` (`index.js:1053`)、`batchArticleComposePrompt` (`index.js:1073`)，校对 `batchProofreadPrompt` (`index.js:1105`)、批量校对 `batchProofreadBatchPrompt` (`index.js:1128`)。
- 阶段处理器 tick 前缀 + 表驱动分派：`tickArticles` (`index.js:2223`)、`tickCrosscut` (`index.js:2439`)、`tickCompose` (`index.js:2525`)、`tickReview` (`index.js:2574`)、`tickIndex` (`index.js:2687`)、`tickCommit` (`index.js:2744`)，由 `STAGE_HANDLER` (`index.js:2762-2769`) 映射、主循环 `tick` (`index.js:2771`) 逐 job 调用——阶段机行为集中在一张表上。
- 两条并列执行器 Run 后缀：单轮整包装填通道 `startBatchChatRun` (`index.js:1976`) 与 agentic 工具循环通道 `startAgenticRun` (`index.js:2023`)，结果同进 `batchResults` (`index.js:1974`) 由 `settleJob` (`index.js:1835`) 统一收割——通道可以换，收割口只有一个。
- 工具定义工厂 ToolDefinition 后缀：`cwToolDefinition` (`index.js:1161`)、`generateToolDefinition` (`index.js:2978`)、`updateToolDefinition` (`index.js:3200`)、`progressToolDefinition` (`index.js:3271`)，由 `apply` (`index.js:3969`) 统一注册，面板端点由 `installWebServer` (`index.js:3479`) 布线；设置页数据源是导出纯函数 `listModelCatalog` (`index.js:3417-3438`) 与 `resolveModelEfforts` (`index.js:3455-3477`)。
- 宿主接口兼容包装用 Of 后缀：`resolveModelInfoOf` (`index.js:3444-3449`) 优先 `resolveModelInfo`、缺失时回落 `resolveModel`，把「宿主暴露哪个方法名」的不确定性收在一处。
- 配置字段按模型档位加前缀分组：普通编译档 batchProvider/batchModel/batchReasoningEffort（`index.js:60-62`）、大档 bigProvider/bigModel/bigReasoningEffort/bigTokenBudget（`index.js:60-63`）、会话兜底 sessionTier（`index.js:60`）、并发双档 maxConcurrency/bigConcurrency（`index.js:60-61`）、多仓库调度 serialProjects/parallelProjects（`index.js:60-61`）；0.13.0 新增编译流程四键 `planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`（`index.js:76-79`），与 autoCommit/excludePaths/autoUpdate/autoUpdateMin/workspaceOnly 一起声明在 `Config`（`index.js:60-86`），README 与设置页沿用同一套键名。
- 会话记录函数统一 Session/Record 词根：落盘辅助 `sessionDirFor` (`index.js:1314`)、`writeSessionMeta` (`index.js:1317`)、`writeSessionFull` (`index.js:1324`)，单任务列表 `listSessionRecords` (`index.js:1332`)、单条全文 `readSessionRecord` (`index.js:1342`)、全局聚合 `listAllSessionRecords` (`index.js:1348`)、过期清理 `pruneSessionRecords` (`index.js:1370`)、请求开始挂钩 `beginSessionRecord` (`index.js:1402`)。
- 任务标记布尔字段是通道分派的唯一依据：`bigTier` 由装填点统一打标——文章 `markBig` (`index.js:739-747`)、横切单批直出 (`index.js:2494-2501`)、批量校对 `markBigTask` (`index.js:2619-2625`)，执行器 `runRealtimeTasks` (`index.js:469-528`) 只看该标记分池、不按 provider 猜 (`index.js:471-489`)；agentic 任务在任务上打 `agentic: true`（`index.js:739`），宿主重启后 `settleJob` 据此按 agentic 通道整批重跑（`index.js:739-745`）而不是找 prompt 快照；0.13.2 起 agentic 通道也接双池——`markBigAgenticTasks`/`sourceTokensOf` 按模块源文本量给超大模块打大档标记（`index.js:2362-2373`，接线记录见 `CHANGELOG.md:55`）。
- 测试辅助统一命名：断言函数 `check`（`test-batch.mjs:16`、`test-orchestration.mjs:27`、`test-wiki-anchors.mjs:28`、`test-wiki-entry.mjs:13`）四处同款——成功打 ✓ 计数、失败打 ✗ 收集；分组标题 `section`（`test-batch.mjs:20`）；mock 工厂统一 make 前缀：`makeCtx` (`test-orchestration.mjs:51`)、`makeMockAgent` (`test-orchestration.mjs:94`)、`makeFixtureRepo` (`test-orchestration.mjs:110`)、`makeBatchMock` (`test-orchestration.mjs:145`)、`makeLlm` (`test-batch.mjs:173`)、带延迟的 `makeSlowLlm` (`test-batch.mjs:232`)；请求桩 fake 前缀：`fakeReq` (`test-orchestration.mjs:227`)、`fakeRes` (`test-orchestration.mjs:237`)；mock 配置基线 `batchCfg` (`test-orchestration.mjs:45`) 与文章夹具 `articleMd` (`test-orchestration.mjs:33`)。
- slugify 保留汉字：`slugify` (`index.js:1232-1234`) 的清洗正则显式保留 CJK（\p{Script=Han}）区段，中文顶层目录名直接作模块名，避免多个中文目录塌缩合并成单模块。
- 浏览器半侧组件大驼峰、辅助小驼峰：设置卡 `CodewikiCard` (`client.js:548`)、总览页 `ReposTab` (`client.js:1177`)、会话视图 `SessionView` (`client.js:1326`)、侧边栏面板 `CodewikiPanel` (`client.js:1418`)、面板图标 `PanelIcon` (`client.js:1665`)；渲染辅助 `stageBar` (`client.js:1100`)、`overallPct` (`client.js:1125`)、`throughputBadge` (`client.js:1136`)、`usageLine` (`client.js:1158`)、`Spark` (`client.js:1077`)；请求封装 `apiGet` (`client.js:489`)、`apiPost` (`client.js:495`)；阶段条与进度权重随服务端阶段机同步纳入 commit（`ACTIVE_STAGES` (`client.js:33`)，权重 `STAGE_WEIGHTS` (`client.js:1124`) articles 0.63 / commit 0.02）。
- 文档大写命名：README、CHANGELOG、CodeWiki 三个大写 Markdown 分别承担定位说明、版本化变更史与 wiki 入口公约（`CodeWiki.md:3`）。

### 错误处理与失败记账风格

- 断言收集而非立即中断：各测试的 check 只累计与打印（成功 ✓、失败收进 failures），结尾统一汇总并按失败数退出——`test-batch.mjs:566-570` 打印 ALL PASS/FAIL 并 exit 1，`test-orchestration.mjs:1528-1529` 同款收尾；单条失败不中断，一次运行给出全景。
- 外部进程统一封装：`runCw` (`index.js:162-187`) 收集 stdout/stderr、超时 SIGKILL 与 abort 中止；`resolveBinary` (`index.js:140-160`) 按显式配置 → PATH 探测 → 捆绑副本顺序解析，探测失败静默兜底。
- 路径错误干净抛出：`test-cwd-paths.mjs:62-69` 断言不存在的目录必须抛出含「cwd 不存在」的明确错误，而不是静默兜底或误判状态。
- 唯一模型通道 + 单任务失败记账：`llmChat` (`index.js:412-437`) 是唯一模型通道（「唯一通道、插件不碰密钥」写在通道头注释 `index.js:412-414`），流式 finish 为 error/aborted 时统一抛错；`runRealtimeTasks` (`index.js:469-528`) 并发池逐任务捕获异常，失败写入 notes 后继续消费队列 (`index.js:412-416`)；`applyTaskResult` (`index.js:441-454`) 落盘异常同样只记账不中断；阶段处理器抛错由主循环统一捕获置败 (`index.js:412-416`)。
- 不被支持的思考档位自动回落（0.11.1）：`llmChat` 对 finish 错误码 `UNSUPPORTED_REASONING_EFFORT` 剥掉 effort 用模型默认档重试一次 (`index.js:426-430`)——任何模型/配置组合不再因此整篇失败；大档任务自带 provider/model 时 `reasoningEffort` 完全以任务为准、不回落普通档配置 (`index.js:412-416`)。
- 坏输出不落盘：keepInMemory 产物（横切/校对/合成）的唯一写盘闸门 `writeValidated` (`index.js:1870-1884`)——输出必须以 frontmatter 开头，否则保留原文件并记 note。
- 宿主重启恢复有两条兜底：执行器丢失时 `settleJob` (`index.js:1835-1864`) 先认 agentic 任务标记整批重跑 (`index.js:1844-1850`，agentic 任务没有 prompt 快照、源码是模型现场读的)，否则按 job.tasks 持久化的 `batchPrompt` 快照重跑本阶段 (`index.js:1835-1840`)，两者都不满足才 fail——请求随连接生死，快照是唯一恢复路径。
- 取消语义收口在一处：`syncCancelFlags` (`index.js:1811-1822`) 每轮 tick 从磁盘跨实例拾取取消标记，终态收尾时中断在飞请求并丢弃未收割结果 (`index.js:1811-1820`)。
- 多实例并发安全：tick 进程锁 `acquireTickLock` (`index.js:1590-1604`) 崩溃残留 60s 过期强删；job 记录创建者 `instanceId` (`index.js:1703`)，他实例任务停更超 `ORPHAN_TAKEOVER_MS` 才接管 (`index.js:1590-1600`)；脏标记加 `mergeFromDisk` (`index.js:1749-1770`) 磁盘吸收，防止实例间互相覆盖。
- 三层能力全部「宁可降级不中断」（0.13.0）：语义规划 `semanticPlan` 各环节失败返回 `{ plan: null, fallback: true, reason }`（提取器不可用 `index.js:884`、提取失败 `index.js:884`、无组件 `index.js:884`、聚类失败 `index.js:884`、空计划 `index.js:884`），`buildPlan` (`index.js:2074-2097`) 据此退回 `localPlan` 并把原因写进 note；agentic 写作失败率严格过半才退回单轮通道（`shouldFallBackFromAgentic` (`index.js:855-860`)），且每 job 只退一次（`shouldFallBackHere` 另守 `agenticRetried`，`index.js:1932-1939`），退回时只重排失败篇 (`index.js:2288-2326`)；符号级增量拿不到快照/提取失败一律退回文件级判定（`index.js:884-902`），快照写入失败也只记 note (`index.js:884-886`)。
- 符号级判定把全部文章滤掉时不提交空任务：代码确实变了但只动了实现细节时，直接刷新编译基线（meta update）让 cw status 回到 clean，并写明「未重写任何文章」(`index.js:3151-3157`)。
- 记账去重收窄为两个独立开关（0.13.2）：`tally` (`index.js:1897-1928`) 不再无条件按名字去重——`replace=true`（校对阶段，同名覆盖）与 `mergeByName=true`（文章/观察/合成的重跑路径）各管一件事，正常首次 tally 不合并（语义注释 `index.js:1897-1905`、按名合并判定 `index.js:1897-1899`）；曾成功的条目不因后续失败被抹掉 (`index.js:1897-1899`)。
- 持久化瘦身：语义规划结果 `plan` 随 job 整体写进 JOBS_FILE，因此组件图**不带** sourceCode——判变更只用 bodyHash/签名/依赖，全量源码进来一份 job 就多几百 KB（`index.js:948-950`）。
- 阶段内失败局部降级：横切合成批提交失败只跳过横切进校对、不推翻整个任务（`submitComposeBatch` (`index.js:2539-2549`)）；文章观察批全部失败时该篇缺席并记 note (`index.js:2539-2540`)、不 fail 整个 job (`index.js:2539-2543`)。
- 拒绝式安全边界（编译产物自动提交）：`autoCommitWiki` (`index.js:3807-3889`) 对非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中、路径存在未解决冲突、产物被 gitignore 忽略、缺 git 身份、add/commit 自身失败等任一情形一律返回 committed:false 加原因并降级为一次性提醒，绝不做半个提交（全部前置检查都在分支切换之前执行）。
- 提交升级为分支合并式（0.10.11）：先在主题分支 codewiki/wiki-\<jobId\> 上提交、再合并回原分支并删主题分支——`commitOn` (`index.js:3838-3850`) 用 pathspec 形式的 git add 只暂存两个产物路径（绝不 -A）。
- 提交的分支路径降级：进入主题分支后任何失败都先经 finally 守卫切回原分支 (`index.js:3863-3869`)，绝不把用户留在插件建出的分支上；合并冲突/失败一律中止合并并保留主题分支等手动合并、`branch -d` 只删已合并分支绝不强删 (`index.js:3874-3884`)；detached HEAD 或建主题分支失败降级为直接提交 mode:'direct' (`index.js:3853-3862`)。
- 提交三态单点判定：`autoCommitState` (`index.js:1671-1676`) 把 committed/no-changes/pending 收口成一个纯函数，实时唤醒通道 `wakeCompileSession` (`index.js:1678-1693`) 与系统提示通道 `commitHintText` (`index.js:3891-3922`) 共用同一结论——「产物无改动」不会被两条通道各催一次；成功且已提交/无改动时唤醒直接 return (`index.js:1682`)，完全不打扰会话。
- 提交期失败不重复唤醒：`fail` (`index.js:1824-1832`) 识别 submitting 占位阶段——错误已随工具调用同步返回，跳过终态唤醒回调。
- 唯一通道缺配置诚实报错并落痕：`submit` (`index.js:2859`) 校验 `batchProvider`/`batchModel` 非空且 llm 服务已注入，缺失即抛错并把 job 置 failed 留痕（校验块 `index.js:2859-2870`）；测试断言报错指向设置项且 jobs 文件里留下 failed 任务（`test-orchestration.mjs:1465-1478`）。
- 会话兜底不可用直接置败：`dispatchSessionTasks` (`index.js:2141-2175`) 在发起会话缺失、steer 失败或任务文件写失败时直接置败并写明原因，不静默降级；会话通道收割判定 `classifySessionTask` (`index.js:1450-1460`) 超时优先于已产出——超时任务即使文件刚写完也不收割 (`index.js:2141`)。
- 编译对象闸门（拒绝明显无效的目标）：`detectLinkedWorktree` (`index.js:309-325`) 只用 git 自己判 linked worktree；`submit` (`index.js:309-323`) 与工具 execute (`index.js:3033-3054`) 双处拦截 worktree 与扫不出可编译源码的空壳目录——auto 静默跳过、手动路径抛错；反登记由 `forgetRepo` (`index.js:1508-1516`) 只摘插件自己的仓库清单、不碰用户磁盘。
- 启动清理：服务启动时把 worktree 与空壳目录上的历史任务一次性移出作业历史 (`index.js:378-393`)，已知仓库登记同步摘除——目录已不存在时不算 dead，历史记录不被抹掉（判定在 `isDeadCompileTarget` (`index.js:378-386`)）。
- 校对失败不推翻原文：`settleProofread` (`index.js:1943-1967`) 按 @@@article 标记拆回逐篇、经 `writeValidated` 校验通过才覆写，缺席或非法的文章保留原文。
- 端点异常可诊断：jobs/repos 两个 handler 的 catch 把错误与栈前 8 行写进 500 响应体 (`index.js:3551-3554`、`index.js:3645-3647`)，规避宿主对 handler reject 只回 400 空 body 的排查盲区；工作区注册表的 list() 抛错时过滤整体降级停用 (`index.js:3500-3507`)，不让体验优化拖垮端点。
- 会话记录尽力而为、绝不影响编译：`writeSessionMeta`/`writeSessionFull` (`index.js:1317-1330`) 全部 try/catch 吞错（tmp 不可写则放弃记录），`pruneSessionRecords` (`index.js:1370-1390`) 单文件清理失败不拖累整轮。
- 工具结果节流（0.13.3）：`read_code` 重复读抑制——模型反复读同一段时只回提示、不回吐正文，且去重判定发生在读盘之前（真实探针：重复读 12 → 5 次、上下文 2144 → 1413KB、`stopReason` 由 max-steps 变 finished，`CHANGELOG.md:28`）；`toRequestMessages` 用模块级 `WeakMap` 缓存已构造的正式消息，保证同一条消息跨轮次 MessageId 身份稳定（`CHANGELOG.md:28`）。
- 面板时间语义不误导：已用时拆「排队 / 执行」两段（`elapsedSplit` (`client.js:1529-1533`)，排队时长取 stageTimings.queued）；`lastTimedStage` (`client.js:1096-1099`) 把计时键过滤到当前阶段集合——旧任务残留已删阶段（如 plan）的键不再导致失败/取消时步骤条全熄不标红。
- 行号锚点确定性校正：`fixAnchors` (`index.js:568-651`) 落盘前对照 source_files 源码机械校正——起点行不含符号时找唯一出现或唯一声明形态，歧义与未找到记 unresolved 不动，区间尾越界钳到文件尾。

### 构建与测试流程模式

- 全部测试直测插件主体：`test-batch.mjs:7-12` 与 `test-wiki-entry.mjs:10` 静态 import 纯函数，`test-orchestration.mjs:24` 动态加载并断言插件名 (`test-orchestration.mjs:279`)，`test-cwd-paths.mjs:5` 加载后取注册表验证工具行为。
- 通道基线显式钉住（0.13.0）：三层新能力默认全开，但编排冒烟断言的是旧通道的请求次数与装填时序——配置基线用 `LEGACY_CHANNEL` 把 planMode/agenticArticles/symbolIncremental 显式关掉（`test-orchestration.mjs:44-45`），让该文件继续守护旧通道；新通道由 test-symbols/test-cluster/test-agentic/test-agentic-host/test-agentic-fallback/test-articles-agentic/test-semantic-plan/test-graphdiff/test-incremental* 等专属文件守护（全量 17 个测试文件回归清单见 `CHANGELOG.md:119`）。
- fixture 用临时目录与真实 git：`makeFixtureRepo` (`test-orchestration.mjs:110-127`) 建仓并显式配置 git user.name/user.email（`test-orchestration.mjs:110-111`，缺身份时自动提交会被安全边界拒绝）；各测试节用 fs.mkdtempSync 建独立 tmp 目录（`test-batch.mjs:32`、`test-batch.mjs:55`、`test-batch.mjs:135`、`test-batch.mjs:374`、`test-batch.mjs:524`），收尾统一删除。
- 超大源文件驱动预算分支：`test-batch.mjs:57-58` 写入 420KB 的 big.ts 与 800KB 的 huge.ts，分别命中「大档单请求写完」与「连大档都装不下转会话通道」两条路径。
- mock 宿主上下文复刻 cordis 语义：`makeCtx` (`test-orchestration.mjs:51-91`) 的 inject 兼容回调与 Promise 两种风格、按 ctx 切片传参以暴露严格语义；`llmProxy` (`test-orchestration.mjs:133-140`) 把请求转发给当前生效的假 llm，每个测试块只需 `makeBatchMock` (`test-orchestration.mjs:145-209`) 一处接线——假 llm 按 prompt 首行特征分发应答，支持 `stall` 挂起 (`test-orchestration.mjs:184-191`) 模拟取消与超时；mock 配置基线 `batchCfg` (`test-orchestration.mjs:45`) 显式给出 provider/model（0.10.1 起留空即提交失败）。
- 并发分池测试统计在飞峰值（0.12.2）：`makeSlowLlm` (`test-batch.mjs:232`) 给每个请求加 30ms 延迟，`poolProbe` (`test-batch.mjs:243`) 按 bigTier 标记统计两池各自的在飞峰值——默认档并发 2 / 大档并发 1 下断言默认档峰值恰为 2、大档恰为 1、总峰值 ≥ 2（两池同时推进，`test-batch.mjs:232-251`），大档并发缺省时断言跟随默认档 (`test-batch.mjs:232-245`)。
- 并发测试用挂起而非快速失败当 mock：0.10.10 修复的竞态表明「模型立即失败」会让任务几百毫秒内进终态、后续提交查不到活动任务而新建重复 job——并发块改用 `stall` 让任务停在 articles 并在收尾用 control 取消 (`test-orchestration.mjs:993-997`)；jobs 文件名只带 pid 会在 Windows pid 复用时读入历史残留，测试文件名追加随机 `TEST_JOB_TOKEN` (`test-orchestration.mjs:22-23`) 并收尾删除。
- 环境变量驱动加速与隔离：测试把 tick 压到 300ms（`test-orchestration.mjs:15`，服务端下限 250ms 见 `TICK_MS` (`index.js:1295`)）；服务端路径与阈值常量全部可用环境变量覆盖——`JOBS_FILE` (`index.js:1294`)、`SESSION_TASK_TIMEOUT_MS` (`index.js:1299`)、`ORPHAN_TAKEOVER_MS` (`index.js:1487`)、`REPOS_FILE` (`index.js:1493`)。
- 轮询终态等待：`waitJob` (`test-orchestration.mjs:212-225`) 每 150ms 读 jobs 文件、等 done/failed/cancelled 终态，超时兜底返回。
- 验证命令文档化：`README.md:91` 记录语法检查与编排冒烟的运行方式；CHANGELOG 每条变更以测试结论与版本号收尾（如 0.12.2 的测试/文档/版本三连，`CHANGELOG.md:139-143`），测试结论可追溯。

### 目录与仓库布局约定

- 插件根共置核心文件：服务端单文件 index.js 与浏览器半侧 client.js 同置根目录，加上挂载补丁 cordis.patch.yml 与包声明 package.json 构成全部安装面；0.13.0 起能力实现下沉 lib/ 子目录（symbols/cluster/graph-diff/incremental/agentic/agentic-host/articles-agentic，导入面集中在 `index.js:16-24`）。
- gitignore 划界：`.gitignore:2` 忽略上游 cargo 产物、`.gitignore:3` 通配忽略全部日志、`.gitignore:6` 忽略二进制备份、`.gitignore:8-9` 忽略探针残留（.orch-test-out.txt / .probe3.txt）、`.gitignore:12` 忽略运行期面板产物；`node_modules/`（`.gitignore:1`）同时让 vendor/tree-sitter 子根的依赖不入库——新机器按需安装（`README.md:41`）。
- 上游源码与捆绑二进制分离：上游源码在 vendor/codewiki，`resolveBinary` (`index.js:140-160`) 的解析顺序是显式配置 → PATH 探测 → 捆绑 bin/cw.exe 兜底，改动 vendor 后需重编二进制（`README.md:86-87`）。
- 依赖落位避开宿主 node_modules：AST 依赖装在独立的 vendor/tree-sitter npm 子根而非插件根 node_modules——后者由宿主注入，在那里装包会顶掉宿主依赖（`CHANGELOG.md:115`）；没装时插件照常启动，三层能力全部降级（`README.md:41`）。
- wiki 固定落仓库内：`wikiPathFor` (`index.js:1272-1277`) 优先取 cw path 输出、失败回落仓库根 .codewiki；横切产物固定写 wiki 根的 _architecture 与 _patterns 两篇、概念进 concepts/、模块进 modules/（`crosscutTasks` (`index.js:2418-2437`)）。
- 运行期状态集中系统临时目录：`JOBS_FILE` (`index.js:1294`)、会话任务文件目录 `SESSION_TASK_DIR` (`index.js:1300`)、已知仓库清单 `REPOS_FILE` (`index.js:1493`)、会话记录目录 `SESSIONS_DIR` (`index.js:1311`，按 jobId 分目录存 meta+full 双文件、TTL 24h 由 tick 定期清理) 全部派生自同一 tmp 目录，随宿主实例生命周期管理。
- 符号快照随 wiki 入库：0.13.0 的符号级增量把快照存 .codewiki/temp/symbol-graph.json（随 wiki 提交、换机器/换会话仍有效，`README.md:61`）；编译收尾在 `tickIndex` 内对比内容、无变化不覆盖以免空转提交（快照段落 `index.js:2687-2708`，内容相同跳过写入 `index.js:2687-2690`）。
- 入口自狗粮：根目录的 CodeWiki.md 声明本插件自身就是一个可被编译的 wiki 项目（`CodeWiki.md:3`），编译产物与源码同仓库提交共享。
- 产物纳入锚点守护：编译出的 .codewiki/ 全部文章被锚点守护测试逐篇扫描（`test-wiki-anchors.mjs:15` 定位 wiki 目录）——文档、产物与测试互相约束。

### 配置热生效与 Schema 声明模式

- Config 全字段 volatile 热读取：`Config` (`index.js:60-86`) 每一项都链式标记 volatile——enabled、binaryPath、编译模型三项、大档四项、sessionTier、maxConcurrency/bigConcurrency、serialProjects/parallelProjects、articleLanguage、0.13.0 的 planMode/agenticArticles/agenticMaxSteps/symbolIncremental、updateReminder、autoCommit、excludePaths、autoUpdate/autoUpdateMin、workspaceOnly；execute 与 tick 每次经 liveConfig 热读取，改配置无需重启。
- 解包与扁平化：`val` (`index.js:88-90`) 兼容 schemastery 的取值形态；`liveConfig` (`index.js:92-134`) 每次调用重新解包。
- 钳制规则集中一处：maxConcurrency 钳到 1–8 (`index.js:107-109`)、bigConcurrency 0/未填表示跟随默认档 (`index.js:110-113`)、parallelLimit 串行时恒 1、关闭串行后按 parallelProjects 取 1–4 (`index.js:115-119`)、bigTokenBudget 以普通预算兜底 (`index.js:105`)；0.13.0 新键同款——`planMode` 只接受 auto/dirs 白名单 (`index.js:121`)、`agenticMaxSteps` 钳 1–100 默认 30 (`index.js:123-126`)；布尔开关统一按「非 false 即开」取默认 (`index.js:114`、`index.js:122`、`index.js:127`、`index.js:131-132`)。
- 默认值常量化：schema 默认值与运行期回落统一引用模块顶部常量区 (`index.js:31-45`)，模型档位调整只改一处。
- 挂载声明三处对齐：cordis.patch.yml 顶层的插入条目 (`cordis.patch.yml:19-24`)、包元数据的 bundle 补丁指向 (`package.json:24-26`) 与客户端命名空间常量 `NS` (`client.js:17`) 使用同一个 id，设置读写与挂载走同一命名空间。
- 客户端半侧按包声明被发现：package.json 的 exports 暴露 client 子路径入口 (`package.json:8-11`)、dsh 元数据声明 web 平台 (`package.json:20-23`)，宿主扫描器沿 file:/// 挂载条目把客户端模块送进浏览器。
- 保存走键白名单：设置卡保存函数遍历 25 个配置键生成单层 set 操作列表 (`client.js:790`，含 0.13.0 的 `planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`)，经 configForms 以 revision CAS 提交，与补丁文件手改等价且同样热生效（保存与校验逻辑在 `client.js:764-803`）。
- 模型目录联动复用：`modelTrio` (`client.js:658-762`) 把提供商/模型/思考程度三行渲染抽成普通档与大档共用；`useEfforts` (`client.js:620-651`) 在选中提供商与模型后二次拉取该模型档位，档位取值不手填裸字符串；模型目录未声明档位时退回 `GENERIC_EFFORTS` 通用档位下拉 (`client.js:30`)，选了模型不支持的值由插件内剥档重试兜底（不会失败）。
- 设置页随流水线能力扩展：0.13.0 新增「编译流程（吸收自 FSoft CodeWiki）」一节渲染 planMode 下拉与三个开关/步数输入 (`client.js:947-992`)；面板阶段条与进度权重随 commit 阶段同步扩展（`client.js:33`、`client.js:1124`）。

### 行号锚点与文档引用约定

- 源码行号前缀是唯一行号依据：`numberLines` (`index.js:557-559`) 给内联源码每行加 grep 风格「N| 」前缀（尾换行只去一个、CRLF 行尾剥离），模型引用行号一律以前缀为准。
- prompt 条款绑定前缀：`articleFormatSection` (`index.js:818-848`) 注入的格式条款明令「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（条款原文在 `index.js:818`）。
- 两个写盘出口统一过锚点修正：普通文章直写 `applyTaskResult`（`index.js:445` 调用）与 keepInMemory 闸门 `writeValidated`（`index.js:1877` 调用）都先跑 `fixAnchors`，修正数与存疑项写入 notes。
- agentic 通道同享修正：agentic 写作执行器把 `fixAnchors` 注入文章循环 (`index.js:2040`)，模型现场读代码写出的文章同样在服务侧落盘前校正。
- 测试三重断言守护锚点：`test-wiki-anchors.mjs:82-115` 主循环对每个锚点校验——行号在文件行数内且指向非空行 (`test-wiki-anchors.mjs:95-96`)、区间起止有序且终点在范围内 (`test-wiki-anchors.mjs:97-100`)、单锚点行的反引号符号至少一个出现在目标行或区间内 (`test-wiki-anchors.mjs:105-111`)；一行并列多个锚点时不做符号绑定（无法可靠归属），由「行号在范围内 + 指向非空行」兜底 (`test-wiki-anchors.mjs:101-104`)。
- 符号提取两处同源：`symbolsOnLine` (`test-wiki-anchors.mjs:38-49`) 的提取规则被 fixAnchors 复制——同源声明在 `index.js:588-589`、本地实现在 `index.js:588-597`（改一处须同步另一处）；`nearestSymbol` (`test-wiki-anchors.mjs:52-62`) 实现了「按离锚点最近选符号」的备选辅助逻辑。
- Obsidian 反链接连接模块：格式条款要求 Connections 用 Obsidian [[backlinks]]（[[other-module]]）连接相关模块（条款在 `index.js:844`）。
- Windows 反斜杠路径收口：`parseStatus` (`index.js:213-226`) 把 cw 输出的文章路径统一正斜杠化（`normalizeArticlePath` (`index.js:199`)），`normalizeIndexLinks` (`index.js:203-211`) 只修索引文件链接头、不碰正文——对旧二进制反斜杠输出的纵深防御。
- 入口文件缺失自动生成：`ensureWikiEntry` (`index.js:246-279`) 编译收尾按文章语言生成中/英双语入口（含 .codewiki 绝对路径与收尾工具指引），已有入口绝不覆盖。
- 入口行为有专属测试：`test-wiki-entry.mjs:26-54` 覆盖缺失生成、已有不覆盖、重复调用幂等与英文文案分支。
