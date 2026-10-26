---
title: _patterns
type: pattern
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - .probe3.txt
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - .tmp-test-batch.log
  - .tmp-test-cwd-paths.log
  - .tmp-test-orchestration.log
  - .tmp-test-wiki-anchors.log
  - .tmp-test-wiki-entry.log
  - watcher2.log
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

本仓库是 @local/dsh-codewiki 插件——把 mraza007/codewiki 的 Rust CLI cw 接入 DeepSeek Harness，提供仓库内代码 wiki（位于各仓库 .codewiki/ 目录、随仓库提交共享）的提交制编译与维护（`README.md:3`）。代码围绕「提交制编译 + 宿主常驻服务推进阶段机（写文章→横切→合成→校对→索引→提交）+ 插件内双档并发池（默认档/大档分池限流）、零子代理 + 编译收尾插件自动提交（主题分支合并式）」的架构形成了一系列一致的工程实践：命名按层分组、失败一律记账不中断、配置全字段热生效、测试直测插件主体并以 mock 宿主 llm 服务驱动、文档行号锚点有确定性校正与测试守护。以下按命名约定、错误处理、构建测试、目录布局、配置声明、锚点引用六个维度归纳反复出现的模式，每条给出文件与行号出处。

## Patterns

### 命名约定模式

- 常量全大写蛇形、集中在模块顶部：并发与模型默认档 `CONCURRENCY_HARD_CAP` (`index.js:22`)、`DEFAULT_CONCURRENCY` (`index.js:24`)、普通编译档 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL` (`index.js:26-27`)、大档三件 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`/`DEFAULT_BIG_TOKEN_BUDGET` (`index.js:30-33`)、自动提交路径白名单 `WIKI_PATHS` (`index.js:36`)；token 预算 `BATCH_TOKEN_BUDGET` (`index.js:521`) 与大档硬上限 `BATCH_TOKEN_HARD_LIMIT` (`index.js:526`) 单独成节并附上下文窗口推导注释（hy3 192k 窗口扣除 64k 输出上限后输入必须 ≤128k）。
- 运行期路径与阈值常量同样大写：jobs 持久化文件 `JOBS_FILE` (`index.js:1162`)、服务节拍 `TICK_MS` (`index.js:1163`)、会话通道超时与任务目录 `SESSION_TASK_TIMEOUT_MS`/`SESSION_TASK_DIR` (`index.js:1167-1168`)、会话记录 TTL 与目录 `SESSION_TTL_MS`/`SESSIONS_DIR` (`index.js:1178-1179`)、孤儿接管阈值与历史保留上限 `ORPHAN_TAKEOVER_MS`/`MAX_JOBS_KEPT` (`index.js:1355-1356`)、已知仓库清单 `REPOS_FILE` (`index.js:1361`)、终态集合 `JOB_TERMINAL` (`index.js:1386`)、扫描黑名单与上限 `SCAN_SKIP_DIRS`/`SCAN_SKIP_EXT`/`SCAN_MAX_FILE_BYTES`/`SCAN_MAX_FILES` (`index.js:1389-1401`)、tick 进程锁 `JOBS_LOCK_FILE` (`index.js:1433`)、判定缓存 TTL `WORKTREE_CACHE_TTL_MS` (`index.js:310`) 与 `SOURCE_PROBE_TTL_MS` (`index.js:330`)。
- 函数小驼峰、按层分组：路径与进程层 `normalizeCwd` (`index.js:40`)、`resolveBinary` (`index.js:120`)、`runCw` (`index.js:142`)；token 估算与装填 `estimateTokens` (`index.js:374`)、`collectSources` (`index.js:636`)、`prepareArticleTasks` (`index.js:707`)、`packArticles` (`index.js:849`)；扫描与本地规划 `scanRepoFiles` (`index.js:1403`)、`localPlan` (`index.js:832`)；编译对象闸门一组 is/has 前缀布尔语义 `isWorktreeCwd` (`index.js:313`)、`hasCompilableSources` (`index.js:332`)、`clearSourceProbeCache` (`index.js:348`)、`isDeadCompileTarget` (`index.js:358`)；服务工厂 `createJobService` (`index.js:1541`)、主循环 `tick` (`index.js:2404`)、插件入口 `apply` (`index.js:3568`)。
- prompt 模板函数统一 batch 前缀：文章 `batchArticlePrompt` (`index.js:667`)，横切三件套 `batchArchitecturePrompt` (`index.js:884`)、`batchPatternsPrompt` (`index.js:892`)、`batchConceptPrompt` (`index.js:900`)，观察与合成 `batchObservePrompt` (`index.js:910`)、`batchArticleObservePrompt` (`index.js:931`)、`batchArticleComposePrompt` (`index.js:951`)，校对 `batchProofreadPrompt` (`index.js:983`)、批量校对 `batchProofreadBatchPrompt` (`index.js:1006`)。
- 阶段处理器 tick 前缀 + 表驱动分派：`tickArticles` (`index.js:1952`)、`tickCrosscut` (`index.js:2097`)、`tickCompose` (`index.js:2183`)、`tickReview` (`index.js:2232`)、`tickIndex` (`index.js:2345`)、`tickCommit` (`index.js:2377`，0.10.11 起产物提交独立成阶段)，由 `STAGE_HANDLER` (`index.js:2395-2402`) 映射、主循环逐 job 调用——阶段机行为集中在一张表上。
- 工具定义工厂 ToolDefinition 后缀：`cwToolDefinition` (`index.js:1039`)、`generateToolDefinition` (`index.js:2611`)、`updateToolDefinition` (`index.js:2799`)、`progressToolDefinition` (`index.js:2870`)，由 `apply` (`index.js:3568`) 统一注册，面板端点由 `installWebServer` (`index.js:3078`) 布线；设置页数据源是导出纯函数 `listModelCatalog` (`index.js:3016`) 与 `resolveModelEfforts` (`index.js:3054`)。
- 宿主接口兼容包装用 Of 后缀：`resolveModelInfoOf` (`index.js:3043-3048`) 优先 `resolveModelInfo`、缺失时回落 `resolveModel`，把「宿主暴露哪个方法名」的不确定性收在一处。
- 配置字段按模型档位加前缀分组：普通编译档 batchProvider/batchModel/batchReasoningEffort、大档 bigProvider/bigModel/bigReasoningEffort/bigTokenBudget、并发双档 maxConcurrency/bigConcurrency、多仓库调度 serialProjects/parallelProjects、会话兜底 sessionTier，与 autoCommit/excludePaths/autoUpdate/autoUpdateMin/workspaceOnly 一起声明在 `Config` (`index.js:51-73`)，README 与设置页沿用同一套键名。
- 会话记录函数统一 Session/Record 词根：单任务列表 `listSessionRecords` (`index.js:1200`)、单条全文 `readSessionRecord` (`index.js:1210`)、全局聚合 `listAllSessionRecords` (`index.js:1216`)、过期清理 `pruneSessionRecords` (`index.js:1238`)、请求开始挂钩 `beginSessionRecord` (`index.js:1270`)，落盘辅助 `sessionDirFor` (`index.js:1182`)、`writeSessionMeta` (`index.js:1185`)、`writeSessionFull` (`index.js:1192`)。
- 任务标记 `bigTier` 是并发分池的唯一依据：装填点统一打标——文章 `markBig` (`index.js:719-727`)、横切直出（`index.js:2152-2159`）、批量校对 `markBigTask` (`index.js:2277-2283`)，执行器 `runRealtimeTasks` (`index.js:449-468`) 只看任务上的 `bigTier` 标记分池（不按 provider 猜）；持久化快照随任务携带该标记，宿主重启重跑不掉池。
- 测试辅助统一命名：断言函数 `check` (`test-batch.mjs:16`、`test-orchestration.mjs:27`、`test-wiki-anchors.mjs:28`、`test-wiki-entry.mjs:13`) 四处同款——成功打 ✓ 计数、失败打 ✗ 收集；分组标题 `section` (`test-batch.mjs:20`)；mock 工厂统一 make 前缀：`makeCtx` (`test-orchestration.mjs:44`)、`makeMockAgent` (`test-orchestration.mjs:87`)、`makeFixtureRepo` (`test-orchestration.mjs:103`)、`makeBatchMock` (`test-orchestration.mjs:138`)、`makeLlm` (`test-batch.mjs:173`)、带延迟的 `makeSlowLlm` (`test-batch.mjs:232`)；请求桩 fake 前缀：`fakeReq` (`test-orchestration.mjs:220`)、`fakeRes` (`test-orchestration.mjs:230`)；mock 配置基线 `batchCfg` (`test-orchestration.mjs:38`) 与文章夹具 `articleMd` (`test-orchestration.mjs:33`)。
- slugify 保留汉字：`slugify` (`index.js:1110-1112`) 的清洗正则显式保留 CJK 区段，中文顶层目录名直接作模块名，避免多个中文目录塌缩合并成单模块。
- 浏览器半侧组件大驼峰、辅助小驼峰：设置卡 `CodewikiCard` (`client.js:520`)、总览页 `ReposTab` (`client.js:1091`)、会话视图 `SessionView` (`client.js:1240`)、侧边栏面板 `CodewikiPanel` (`client.js:1332`)、面板图标 `PanelIcon` (`client.js:1579`)；渲染辅助 `stageBar` (`client.js:1014`)、`STAGE_WEIGHTS` (`client.js:1038`)、`overallPct` (`client.js:1039`)、`throughputBadge` (`client.js:1050`)、`usageLine` (`client.js:1072`)、`Spark` (`client.js:991`)；请求封装 `apiGet` (`client.js:461`)、`apiPost` (`client.js:467`)；阶段条与进度权重随服务端阶段机同步纳入 commit（`ACTIVE_STAGES` (`client.js:33`)，权重 articles 0.63 / commit 0.02）。
- 文档大写命名：README、CHANGELOG、CodeWiki 三个大写 Markdown 分别承担定位说明、版本化变更史与 wiki 入口公约。

### 错误处理与失败记账风格

- 断言收集而非立即中断：各测试的 check 只累计与打印（成功 ✓、失败收进 failures），结尾统一汇总并按失败数退出——`test-batch.mjs:566-570` 打印 ALL PASS/FAIL 并 exit 1，`test-orchestration.mjs:1521-1522` 同款收尾；单条失败不中断，一次运行给出全景。
- 外部进程统一封装：`runCw` (`index.js:142-167`) 收集 stdout/stderr、超时 SIGKILL 与 abort 中止；`resolveBinary` (`index.js:120-140`) 按显式配置 → PATH 探测 → 捆绑副本顺序解析，探测失败静默兜底。
- 路径错误干净抛出：`test-cwd-paths.mjs:62-68` 断言不存在的目录必须抛出含「cwd 不存在」的明确错误，而不是静默兜底或误判状态。
- 唯一模型通道 + 单任务失败记账：`llmChat` (`index.js:392-417`) 是唯一模型通道（头注释明示插件不保存密钥、无自带直连端点），流式 finish 为 error/aborted 时统一抛错；`runRealtimeTasks` (`index.js:449-508`) 并发池逐任务捕获异常，失败写入 notes 后继续消费队列；`applyTaskResult` (`index.js:421-434`) 落盘异常同样只记账不中断。
- 不被支持的思考档位自动回落（0.11.1）：`llmChat` 对 finish 错误码 `UNSUPPORTED_REASONING_EFFORT` 剥掉 effort 用模型默认档重试一次（`index.js:407-410`）——任何模型/配置组合不再因此整篇失败。
- 坏输出不落盘：keepInMemory 产物（横切/校对/合成）的唯一写盘闸门 `writeValidated` (`index.js:1707-1723`)——输出必须以 frontmatter 开头，否则保留原文件并记 note。
- 多实例并发安全：tick 进程锁 `acquireTickLock` (`index.js:1436-1450`) 崩溃残留 60s 过期强删；job 记录创建者 `instanceId` (`index.js:1549`)，他实例任务停更超 `ORPHAN_TAKEOVER_MS` 才接管（`index.js:2430-2438`）；脏标记加 `mergeFromDisk` (`index.js:1595-1616`) 磁盘吸收，防止实例间互相覆盖。
- 拒绝式安全边界（编译产物自动提交）：`autoCommitWiki` (`index.js:3406-3488`) 对非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中、路径存在未解决冲突、产物被 gitignore 忽略、缺 git 身份、add/commit 自身失败等任一情形一律返回 committed:false 加原因并降级为一次性提醒，绝不做半个提交（0.10.9 的全部前置检查原样保留，且都在分支切换之前执行）。
- 提交升级为分支合并式（0.10.11）：先在主题分支 codewiki/wiki-\<jobId\> 上提交、再合并回原分支并删主题分支——`commitOn` (`index.js:3437-3449`) 用 pathspec 形式的 git add 只暂存两个产物路径（绝不 -A）。
- 提交的分支路径降级：进入主题分支后任何失败都先经 finally 守卫切回原分支（`index.js:3462-3468`），绝不把用户留在插件建出的分支上；合并冲突/失败一律中止合并并保留主题分支等手动合并、branch -d 只删已合并分支绝不强删（`index.js:3470-3484`）；detached HEAD 或建主题分支失败降级为直接提交 mode:'direct'（`index.js:3452-3461`）。
- 提交三态单点判定：`autoCommitState` (`index.js:1517-1522`) 把 committed/no-changes/pending 收口成一个纯函数，实时唤醒通道 `wakeCompileSession` (`index.js:1524-1539`) 与系统提示通道 `commitHintText` (`index.js:3490-3521`) 共用同一结论——「产物无改动」不会被两条通道各催一次；成功且已提交/无改动时唤醒直接 return（`index.js:1528`），完全不打扰会话。
- 提交期失败不重复唤醒：`fail` (`index.js:1670-1678`) 识别 submitting 占位阶段——错误已随工具调用同步返回，跳过终态唤醒回调。
- 会话兜底不可用直接置败：`dispatchSessionTasks` (`index.js:1870-1904`) 在发起会话缺失、steer 失败或任务文件写失败时直接置败并写明原因，不静默降级；会话通道收割判定 `classifySessionTask` (`index.js:1318-1328`) 超时优先于已产出——超时任务即使文件刚写完也不收割。
- 编译对象闸门（拒绝明显无效的目标）：`detectLinkedWorktree` (`index.js:289-305`) 只用 git 自己判 linked worktree；`svc.submit` (`index.js:2500-2515`) 与工具 execute 双处拦截 worktree 与扫不出可编译源码的空壳目录——auto 静默跳过、手动路径抛错；反登记由 `forgetRepo` (`index.js:1376-1385`) 只摘插件自己的仓库清单、不碰用户磁盘。
- 启动清理：服务启动时把 worktree 与空壳目录上的历史任务一次性移出作业历史（`index.js:1577-1592`），已知仓库登记同步摘除——目录已不存在时不算 dead，历史记录不被抹掉。
- 校对失败不推翻原文：`settleProofread` (`index.js:1751-1775`) 按 @@@article 标记拆回逐篇、经 writeValidated 校验通过才覆写，缺席或非法的文章保留原文；`tally` (`index.js:1726-1747`) 的 replace 语义保证校对失败不回退已写成功的计数。
- 端点异常可诊断：jobs/repos 两个 handler 的 catch 把错误与栈前 8 行写进 500 响应体（`index.js:3150-3153`、`index.js:3244-3246`），规避宿主对 handler reject 只回 400 空 body 的排查盲区；工作区注册表的 list() 抛错时过滤整体降级停用（`index.js:3098-3106`），不让体验优化拖垮端点。
- 会话记录尽力而为、绝不影响编译：`writeSessionMeta`/`writeSessionFull` (`index.js:1185-1198`) 全部 try/catch 吞错（tmp 不可写则放弃记录），`pruneSessionRecords` (`index.js:1238-1258`) 单文件清理失败不拖累整轮。
- 面板时间语义不误导：已用时拆「排队 / 执行」两段（`elapsedSplit` (`client.js:1443-1447`)，排队时长取 stageTimings.queued）；`lastTimedStage` (`client.js:1010-1013`) 把计时键过滤到当前阶段集合——旧任务残留已删阶段（如 plan）的键不再导致失败/取消时步骤条全熄不标红。
- 行号锚点确定性校正：`fixAnchors` (`index.js:548-631`) 落盘前对照 source_files 源码机械校正——起点行不含符号时找唯一出现或唯一声明形态，歧义与未找到记 unresolved 不动，区间尾越界钳到文件尾。

### 构建与测试流程模式

- 全部测试直测插件主体：`test-batch.mjs:7-12` 与 `test-wiki-entry.mjs:10` 静态 import 纯函数，`test-orchestration.mjs:24` 动态加载并断言插件名（`test-orchestration.mjs:272`），`test-cwd-paths.mjs:5` 加载后取注册表验证工具行为。
- fixture 用临时目录与真实 git：`makeFixtureRepo` (`test-orchestration.mjs:103-120`) 建仓并显式配置 git user.name/user.email（缺身份时自动提交会被安全边界拒绝）；各测试节用 fs.mkdtempSync 建独立 tmp 目录（`test-batch.mjs:32`、`test-batch.mjs:55`、`test-batch.mjs:135`、`test-batch.mjs:374`、`test-batch.mjs:524`），收尾统一删除。
- 超大源文件驱动预算分支：`test-batch.mjs:57-58` 写入 420KB 的 big.ts 与 800KB 的 huge.ts，分别命中「大档单请求写完」与「连大档都装不下转会话通道」两条路径。
- mock 宿主上下文复刻 cordis 语义：`makeCtx` (`test-orchestration.mjs:44-84`) 的 inject 兼容回调与 Promise 两种风格、按 ctx 切片传参以暴露严格语义；`llmProxy` (`test-orchestration.mjs:126-133`) 把请求转发给当前生效的假 llm，每个测试块只需 `makeBatchMock` (`test-orchestration.mjs:138-202`) 一处接线——假 llm 按 prompt 首行特征分发应答，支持 `stall` 挂起（`test-orchestration.mjs:177-184`）模拟取消与超时；mock 配置基线 `batchCfg` (`test-orchestration.mjs:38`) 显式给出 provider/model（0.10.1 起留空即提交失败）。
- 并发分池测试统计在飞峰值（0.12.2）：`makeSlowLlm` (`test-batch.mjs:232`) 给每个请求加 30ms 延迟，`poolProbe` (`test-batch.mjs:243`) 按 bigTier 标记统计两池各自的在飞峰值——默认档并发 2 / 大档并发 1 下断言默认档峰值恰为 2、大档恰为 1、总峰值 ≥ 2（两池同时推进，`test-batch.mjs:232-235`），大档并发缺省时断言跟随默认档（`test-batch.mjs:232-245`）。
- 并发测试用挂起而非快速失败当 mock：0.10.10 修复的竞态表明「模型立即失败」会让任务几百毫秒内进终态、后续提交查不到活动任务而新建重复 job——并发块改用 `stall` 让任务停在 articles 并在收尾用 control 取消（`test-orchestration.mjs:986-990`）；jobs 文件名只带 pid 会在 Windows pid 复用时读入历史残留，测试文件名追加随机 `TEST_JOB_TOKEN` (`test-orchestration.mjs:22-23`) 并收尾删除。
- 环境变量驱动加速与隔离：测试把 tick 压到 300ms（`test-orchestration.mjs:15`，服务端下限 250ms 见 `TICK_MS` (`index.js:1163`)）；服务端路径与阈值常量全部可用环境变量覆盖——`JOBS_FILE` (`index.js:1162`)、`SESSION_TASK_TIMEOUT_MS` (`index.js:1167`)、`ORPHAN_TAKEOVER_MS` (`index.js:1355`)、`REPOS_FILE` (`index.js:1361`)。
- 轮询终态等待：`waitJob` (`test-orchestration.mjs:205-218`) 每 150ms 读 jobs 文件、等 done/failed/cancelled 终态，超时兜底返回。
- 验证命令文档化：`README.md:67` 记录语法检查与编排冒烟的运行方式；CHANGELOG 每条变更以「验证」结果与版本号收尾（如 `CHANGELOG.md:115-116`），测试结论可追溯。

### 目录与仓库布局约定

- 插件根共置核心文件：服务端单文件 index.js 与浏览器半侧 client.js 同置根目录，加上挂载补丁 cordis.patch.yml 与包声明 package.json 构成全部安装面。
- gitignore 划界：`.gitignore:2` 忽略上游 cargo 产物、`.gitignore:3` 通配忽略全部日志（含根目录平铺的 .tmp-test-*.log 与 watcher2.log 测试残留）、`.gitignore:6` 忽略二进制备份、`.gitignore:9` 忽略探针残留（.probe3.txt）、`.gitignore:12` 忽略运行期面板产物——调试证据一律不入库。
- 上游源码与捆绑二进制分离：上游源码在 vendor/codewiki，`resolveBinary` (`index.js:120-140`) 的解析顺序是显式配置 → PATH 探测 → 捆绑 bin/cw.exe 兜底，改动 vendor 后需重编二进制（README 开发节同此记录）。
- wiki 固定落仓库内：`wikiPathFor` (`index.js:1140-1145`) 优先取 cw path 输出、失败回落仓库根 .codewiki；横切产物固定写 wiki 根的 _architecture 与 _patterns 两篇、概念进 concepts/、模块进 modules/（`crosscutTasks` (`index.js:2076-2095`)）。
- 运行期状态集中系统临时目录：`JOBS_FILE` (`index.js:1162`)、会话任务文件目录 `SESSION_TASK_DIR` (`index.js:1168`)、已知仓库清单 `REPOS_FILE` (`index.js:1361`)、会话记录目录 `SESSIONS_DIR` (`index.js:1179`，按 jobId 分目录存 meta+full 双文件、TTL 24h 由 tick 定期清理) 全部派生自同一 tmp 目录，随宿主实例生命周期管理。
- 入口自狗粮：根目录的 CodeWiki.md 声明本插件自身就是一个可被编译的 wiki 项目（`CodeWiki.md:3`），编译产物与源码同仓库提交共享。
- 产物纳入锚点守护：编译出的 .codewiki/ 全部文章被锚点守护测试逐篇扫描（`test-wiki-anchors.mjs:15` 定位 wiki 目录）——文档、产物与测试互相约束。

### 配置热生效与 Schema 声明模式

- Config 全字段 volatile 热读取：`Config` (`index.js:51-73`) 每一项都链式标记 volatile——enabled、binaryPath、编译模型三项、大档四项、sessionTier、maxConcurrency/bigConcurrency、serialProjects/parallelProjects、articleLanguage、updateReminder、autoCommit、excludePaths、autoUpdate/autoUpdateMin、workspaceOnly；execute 与 tick 每次经 liveConfig 热读取，改配置无需重启。
- 解包与扁平化：`val` (`index.js:75-77`) 兼容 schemastery 的取值形态；`liveConfig` (`index.js:79-114`) 每次调用重新解包。
- 钳制规则集中一处：maxConcurrency 钳到 1–8（`index.js:94-96`）、bigConcurrency 0/未填表示跟随默认档（`index.js:98-100`）、parallelLimit 串行时恒 1、关闭串行后按 parallelProjects 取 1–4（`index.js:102-106`）、bigTokenBudget 以普通预算兜底（`index.js:92`）、布尔开关统一按「非 false 即开」取默认（`index.js:101`、`index.js:109-112`）。
- 默认值常量化：schema 默认值与运行期回落统一引用模块顶部常量区（`index.js:22-36`），模型档位调整只改一处。
- 挂载声明三处对齐：cordis.patch.yml 顶层的插入条目（`cordis.patch.yml:14-17`）、包元数据的 bundle 补丁指向（`package.json:24-26`）与客户端命名空间常量 NS（`client.js:17`）使用同一个 id，设置读写与挂载走同一命名空间。
- 客户端半侧按包声明被发现：package.json 的 exports 暴露 client 子路径入口（`package.json:8-11`）、dsh 元数据声明 web 平台（`package.json:20-23`），宿主扫描器沿 file:/// 挂载条目把客户端模块送进浏览器。
- 保存走键白名单：设置卡保存函数遍历 21 个配置键生成单层 set 操作列表（`client.js:751`），经 configForms 以 revision CAS 提交，与补丁文件手改等价且同样热生效（保存与提交逻辑在 `client.js:736-764`）。
- 模型目录联动复用：`modelTrio` (`client.js:630`) 把提供商/模型/思考程度三行渲染抽成普通档与大档共用；`useEfforts` (`client.js:592-623`) 在选中提供商与模型后二次拉取该模型档位，档位取值不手填裸字符串；模型目录未声明档位时退回 `GENERIC_EFFORTS` 通用档位下拉（`client.js:30`），选了模型不支持的值由插件内剥档重试兜底（不会失败）。

### 行号锚点与文档引用约定

- 源码行号前缀是唯一行号依据：`numberLines` (`index.js:537-539`) 给内联源码每行加 grep 风格「N| 」前缀（尾换行只去一个、CRLF 行尾剥离），模型引用行号一律以前缀为准。
- prompt 条款绑定前缀：`articleFormatSection` (`index.js:798-827`) 注入的格式条款明令「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（以 `conf_path` 举例的条款原文在 `index.js:819`）。
- 两个写盘出口统一过锚点修正：普通文章直写 `applyTaskResult` (`index.js:421-434`) 与 keepInMemory 闸门 `writeValidated` (`index.js:1707-1723`) 都先跑 `fixAnchors`（`index.js:425`、`index.js:1714`），修正数与存疑项写入 notes。
- 测试三重断言守护锚点：`test-wiki-anchors.mjs:82-115` 主循环对每个锚点校验——行号在文件行数内且指向非空行（`test-wiki-anchors.mjs:95-96`）、区间起止有序且终点在范围内（`test-wiki-anchors.mjs:97-100`）、单锚点行的反引号符号必须出现在目标行或区间内（`test-wiki-anchors.mjs:105-111`）；一行并列多个锚点时不做符号绑定（无法可靠归属），由「行号在范围内 + 指向非空行」兜底（`test-wiki-anchors.mjs:101-104`）。
- 符号提取两处同源：`symbolsOnLine` (`test-wiki-anchors.mjs:38-49`) 的提取规则被 fixAnchors 复制——同源声明在 `index.js:547`、本地实现在 `index.js:568-577`（改一处须同步另一处）；`nearestSymbol` (`test-wiki-anchors.mjs:52-62`) 提供按「离锚点最近」选取符号的辅助实现。
- Obsidian 反链接连接模块：格式条款要求 Connections 用 Obsidian [[backlinks]]（[[other-module]]）连接相关模块（条款在 `index.js:824`）。
- Windows 反斜杠路径收口：`parseStatus` (`index.js:193-206`) 把 cw 输出的文章路径统一正斜杠化（`normalizeArticlePath` (`index.js:179`)），`normalizeIndexLinks` (`index.js:183-191`) 只修索引文件链接头、不碰正文——对旧二进制反斜杠输出的纵深防御。
- 入口文件缺失自动生成：`ensureWikiEntry` (`index.js:226-259`) 编译收尾按文章语言生成中/英双语入口（含 .codewiki 绝对路径与收尾工具指引），已有入口绝不覆盖。
- 入口行为有专属测试：`test-wiki-entry.mjs:26-54` 覆盖缺失生成、已有不覆盖、重复调用幂等与英文文案分支。
