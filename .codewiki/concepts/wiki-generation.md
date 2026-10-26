---
title: wiki-generation
type: concept
source_files:
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - test-batch.mjs
  - test-cwd-paths.mjs
  - test-orchestration.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - index.js
  - client.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/graph-diff.js
  - lib/incremental.js
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
  - wiki-generation
  - codewiki
  - 生成
  - 跨模块
  - 测试
  - 核心
---

## Overview

`wiki-generation` 指 `@local/dsh-codewiki` 插件把一个代码仓库转化为结构化 CodeWiki 文档（产物路径常量 `WIKI_PATHS` 即 `<repo>/.codewiki/` 与 `CodeWiki.md`，随仓库提交共享，index.js:45）的端到端编译过程。入口工具 `codewiki_generate` 由 `generateToolDefinition` 定义（index.js:2954）：纯提交制——`normalizeCwd` 归一路径（index.js:49）、`runCw` 跑 `cw status`（index.js:162）并由 `parseStatus` 解析四态（index.js:213）、按判态预构建任务后经 `submit`（index.js:2835）交给宿主常驻编排服务 `createJobService`（index.js:1693）即返回，工具路径零 LLM 调用、零子代理、不委托发起会话的主模型。服务在 `tick`（index.js:2747）里以 `TICK_MS` 默认 10s 的节拍（index.js:1293）推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index → commit → done，阶段分发表是 `STAGE_HANDLER`（index.js:2738-2745）；0.10.7 起无独立规划阶段，模块清单在 articles 阶段开头就地生成（0.13.0 起默认改由语义聚类产出，见 `buildPlan` index.js:2064）。全部模型环节在插件内的后台并发池 `runRealtimeTasks`（index.js:469）完成，唯一模型通道是 `llmChat` 包装的宿主 llm 服务（index.js:412，0.10.1 起无内置直连，插件不保存任何密钥）：普通档默认 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL`（workbuddy/hy3，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET`=110k，index.js:541）；110k–420k 输入自动升大档——默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`（volces-ark/glm-5.3-flash 512k，index.js:39-42，预算 `DEFAULT_BIG_TOKEN_BUDGET`=420k）；大档任务（装填时打 `bigTier` 标记，`markBig` index.js:739）与默认档任务在 `runRealtimeTasks` 内分两池独立限流、同时推进（`bigConcurrency` 默认 0=跟随默认档，index.js:72，0.12.2 起）；只有单文件连大档都装不下才转会话通道兜底（`dispatchSessionTasks` index.js:2131，超时 `SESSION_TASK_TIMEOUT_MS` 默认 30 分钟按失败处理，index.js:1297）。0.10.11 起产物提交是阶段机里的显式一步：`tickIndex`（index.js:2663）末尾在有产物且 `autoCommit` 开启时移交 commit 阶段（index.js:2711-2714），`tickCommit`（index.js:2720）执行 `autoCommitWiki`（index.js:3783）的「主题分支提交 → 合并回原分支」后才置 done 并唤醒；提交状态由 `autoCommitState`（index.js:1669）判定 committed/no-changes/pending 三态，`wakeCompileSession`（index.js:1676）在已提交/无改动时完全静默（index.js:1680）。0.11.0 起并行项目推进（`parallelProjects` index.js:74，`liveConfig` 派生 `parallelLimit` index.js:115-119，关串行后上限 1–4）与编译会话记录（`SESSIONS_DIR` index.js:1309，保留 24h）可用；0.12.0 起 linked git worktree 目录拒绝编译（`detectLinkedWorktree` index.js:309）；0.12.1 起「扫不出源码」的空壳目录同样拒绝并从面板过滤（`isDeadCompileTarget` index.js:378）。本概念横跨文档说明、核心实现、流水线库、测试验证与运行日志五大模块。

当前基线 0.13.1（package.json:3）——0.13.0 吸入了 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力，默认全开、任一环节不可用自动降级（README.md:39-54，CHANGELOG.md:39-65）：①模块划分 `planMode` 默认 auto（index.js:76）走 `semanticPlan`（index.js:884）——tree-sitter AST 符号提取（lib/symbols.js，`extractRepoGraph`/`resolveImportEdges` 由 index.js:16 导入）+ LLM 语义聚类（lib/cluster.js，`clusterComponents`/`toPlanModules` 由 index.js:17 导入），失败退回 `localPlan` 顶层目录分组（index.js:862），分派点 `buildPlan`（index.js:2064-2087）；②文章写作 `agenticArticles` 默认开（index.js:77）走 agentic 工具循环——`startAgenticRun`（index.js:2014）调 `runAgenticArticles`（lib/articles-agentic.js，index.js:23 导入），模型自己读源码/列文件/增量改写多轮写作（单篇步数上限 `agenticMaxSteps` index.js:78），不再把源码整包内联进 prompt，因而没有「超预算拆观察批」一整套；0.13.1 起模型还可在写作中调 `generate_sub_module` 递归派出子模块成文（`subDepth` 默认封顶 2 层、子模块名全局去重、失败只记账不拖垮父文章，README.md:39，CHANGELOG.md:9-15）；本批失败严格过半时经 `shouldFallBackFromAgentic`（index.js:855）+ `shouldFallBackHere`（index.js:1923）退回单轮通道且只退一次（`job.agenticRetried`，index.js:2298）、只重排失败篇（CHANGELOG.md:41）；③增量判定 `symbolIncremental` 默认开（index.js:79）——stale 流程拿上次编译的符号快照与 `extractCurrentGraph`（index.js:1561）的当前符号图做组件级比对（`filterStaleTasks`，index.js:21 导入、index.js:3106 调用），纯注释/空白/格式化改动直接跳过重写，快照由 `tickIndex` 写入 `.codewiki/temp/symbol-graph.json`（`saveSnapshot`，内容未变不覆盖 `sameSnapshotContent`，index.js:884-908）。AST 依赖 vendor/tree-sitter（web-tree-sitter + tree-sitter-wasms，56MB 独立子根，README.md:39、CHANGELOG.md:39），未安装时三层全部自动降级、编译不中断。版本演进要点：0.12.2 编译并发拆两档独立设置（CHANGELOG.md:39-59）、0.12.1 统一无效编译对象判定（CHANGELOG.md:39-59）、0.12.0 全局会话 Tab + worktree 闸门（CHANGELOG.md:39-48）、0.11.0–0.11.2 并行推进/排队可见性/会话记录与思考档位修复（CHANGELOG.md:39-67）、0.10.9–0.10.11 自动提交三步走（CHANGELOG.md:39-83）、0.10.7 删独立规划阶段（CHANGELOG.md:39-48）。

## Involved Modules

- **docs-and-meta**：README.md（提供四工具表 README.md:9-15、`codewiki_generate` 关键行为 README.md:17-24、三层编译流水线与降级矩阵 README.md:26-41、全部设置项 README.md:43-64、本地 file:/// 安装 README.md:66-81、开发与验证 README.md:83-91）；CodeWiki.md（插件自身仓库的 wiki 入口声明 CodeWiki.md:3，Overview CodeWiki.md:7、Key Components CodeWiki.md:9-31、架构图 CodeWiki.md:33-57、Data Flow CodeWiki.md:59-61、Connections CodeWiki.md:63-66、Known Issues CodeWiki.md:68-75，重启 dsh 后可用 `codewiki_generate` 对本仓库重编）；CHANGELOG.md（0.1.0 → 0.13.1 全部行为变更，最新一节 0.13.1 在 CHANGELOG.md:3-23）。
- **core-and-config**（插件双半侧实现）：
  - `index.js`（宿主半侧，单文件 4009 行）：`Config`（index.js:60-86）全部 `.volatile()` 设置与热读 `liveConfig`（index.js:92-134）、四工具 `cwToolDefinition`（index.js:1159）/`generateToolDefinition`（index.js:2954）/`updateToolDefinition`（index.js:3176）/`progressToolDefinition`（index.js:3247）、编排服务 `createJobService`（index.js:1693，内含阶段机 `STAGE_HANDLER` index.js:2738 与各 `tick*` 处理器）、prompt 模板组（`articleFormatSection` index.js:818 起，文章/观察/合成/校对模板 index.js:60-526）、本地与语义规划（`localPlan` index.js:862、`semanticPlan` index.js:884）、仓库扫描 `scanRepoFiles`（index.js:1533，黑名单与上限 index.js:60-72）、面板端点 `installWebServer`（index.js:3455，jobs/repos/sessions/sessions/item/models/model-efforts/control 七个精确端点 index.js:60/3538/3633/3654/3679/3698/3718 全部仅回环放行）、自动提交 `autoCommitWiki`（index.js:3783）、入口 `apply`（index.js:3945）。
  - `client.js`（浏览器半侧，单文件 1680 行）：插件页设置卡 `CodewikiCard`（client.js:548）、模型三件套渲染 `modelTrio`（client.js:658）、思考档位拉取 `useEfforts`（client.js:620）、保存与校验 `save`（client.js:764）、总览页 `ReposTab`（client.js:1177）、会话视图 `SessionView`（client.js:1326）、侧边栏面板 `CodewikiPanel`（client.js:1418）、阶段步骤条 `stageBar`（client.js:1100）、加权总进度 `STAGE_WEIGHTS`（client.js:1124）、面板图标 `PanelIcon`（client.js:1665）。
  - 中英词典（client.js:35 起 zh / client.js:210 起 en，值全字符串），0.13.0 新增「编译流程」节词条 `secPipeline` 等（client.js:90-101 与 client.js:265-276）。
  - cordis.patch.yml（bundle 形式挂载补丁：设置项注释 cordis.patch.yml:1-18 与 file:/// 直挂条目 cordis.patch.yml:19-22，与 profile patch 条目保持 id 一致）。
  - package.json（版本 0.13.1 package.json:22、`exports["./client"]` package.json:22-25、engines package.json:22-25、`dsh.client.platform` 与 bundle 补丁声明 package.json:22-28）。
  - .gitignore（node_modules/ .gitignore:1、`*.log` 不入库 .gitignore:3、.probe3.txt 条目 .gitignore:9、.dsh-ops/ 运行期产物 .gitignore:12）。
- **pipeline-libs（0.13.0 新增，本篇源码快照未含其正文）**：lib/symbols.js（表驱动 `LANG_RULES`，web-tree-sitter + WASM 语法覆盖 16 种语言，产出组件 Map 与 `resolveImportEdges` 依赖边，CHANGELOG.md:31）、lib/cluster.js（两阶段 LLM 聚类 + 超大模块递归下钻 + `heuristicCluster` 兜底，CHANGELOG.md:33）、lib/agentic.js + lib/agentic-host.js + lib/articles-agentic.js（工具循环纯逻辑 / 裸消息↔宿主 llm 协议适配 / job 生命周期接线，0.13.1 起含 `generate_sub_module` 递归派发，CHANGELOG.md:35、9-15）、lib/graph-diff.js + lib/incremental.js（组件级 diff 与快照存取，含 78 条与 Python 原版逐位对拍，CHANGELOG.md:31、49）。七库由 index.js 侧的 `extractRepoGraph`/`clusterComponents`/`runAgenticArticles` 等导入（index.js:16-24）；库内实现本篇不引用行号，描述以 CHANGELOG.md 为准。
- **test-scripts**：自检脚本直接对接真实 index.js 导出——test-orchestration.mjs（1529 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实服务 tick，tick 压到 300ms test-orchestration.mjs:44；0.13.0 起配置基线以 `LEGACY_CHANNEL`（test-orchestration.mjs:44）显式钉住旧通道、继续守护其请求次数与装填时序，新通道由 0.13.0 新增的 test-symbols/test-cluster/test-agentic*/test-semantic-plan/test-graphdiff/test-incremental* 守护（CHANGELOG.md:49，本篇快照未含正文）；`autoCommitWiki` 安全边界块 test-orchestration.mjs:412-513、`autoCommitState` 三态块 test-orchestration.mjs:515-525、`wakeCompileSession` 唤醒块 test-orchestration.mjs:527-563、端到端含独立 commit 阶段断言 test-orchestration.mjs:44-46、单项目串行块 test-orchestration.mjs:44-100、并行项目上限块 test-orchestration.mjs:44-73、全局会话聚合与 worktree 闸门块 test-orchestration.mjs:44-115、空壳目录闸门块 test-orchestration.mjs:44-93）；test-batch.mjs（570 行，纯函数与假 llm 执行链：大档接管块 test-batch.mjs:107-131、两档分池限流块 test-batch.mjs:229-296、`fixAnchors` 块 test-batch.mjs:522-564）；test-wiki-entry.mjs（76 行，CodeWiki.md 入口生成与 Windows 路径规范化，导入真实导出 test-wiki-entry.mjs:10）；test-wiki-anchors.mjs（118 行，行号锚点守卫：基础/符号绑定/区间三重断言，规则 test-wiki-anchors.mjs:1-9、汇总 test-wiki-anchors.mjs:117-118）；test-cwd-paths.mjs（71 行，MSYS/Windows/不存在路径三态实测 test-cwd-paths.mjs:30-69）。
- **logs-and-temp**：历史测试与排查日志，均被 .gitignore:3 的 `*.log` 规则排除——.tmp-test-batch.log（百炼直连与 `resolveBatchApiKey` 时代的执行链自检留档：28k/200k 档位断言、百炼端点断言，末行 .tmp-test-batch.log:76 记 ALL PASS 59 通过 0 失败）；.tmp-test-cwd-paths.log（8 行，末行 .tmp-test-cwd-paths.log:8 记 ALL PASS）；.tmp-test-orchestration.log（独立规划阶段尚存时代的运行留档：「初始 stage=plan」断言 .tmp-test-orchestration.log:188、主模型规划 notes .tmp-test-orchestration.log:137，末行 .tmp-test-orchestration.log:573 记 FAIL 2 项——source 标记还是 0.8.5 前的 plugin/codewiki 形态 .tmp-test-orchestration.log:114）；.tmp-test-wiki-anchors.log（旧基线 122 过/36 败的锚点校验留档，末行 .tmp-test-wiki-anchors.log:130）；.tmp-test-wiki-entry.log（全部通过，末行 .tmp-test-wiki-entry.log:25）；watcher2.log（0.4.x 排查多实例 jobs 文件互覆时的轮询记录，记录的全是 2026-10-06 的 plan 阶段任务，如 watcher2.log:1）。旧探针 .probe3.txt 已不在仓库中（.gitignore:9 仍保留其排除条目）。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:17-24（提交制、scope=auto/full/stale 语义、两档并发、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）；0.13.0 三层能力与各层降级行为全文见 README.md:26-41 与 CHANGELOG.md:25-51。
   - 设置项与默认值：`Config`（index.js:60-86）——编译模型三项（`batchProvider` 默认 workbuddy index.js:63、`batchModel` 默认 hy3 index.js:64、`batchReasoningEffort` 留空=模型默认档 index.js:65）、大档五项（`bigProvider` index.js:66/`bigModel` index.js:67/`bigReasoningEffort` index.js:68/`bigTokenBudget` index.js:69、大档并发 `bigConcurrency` 默认 0=跟随默认档 index.js:72）、`sessionTier`（index.js:70）、`maxConcurrency` 默认 2 硬顶 8（常量 `DEFAULT_CONCURRENCY` index.js:33、`CONCURRENCY_HARD_CAP` index.js:31）、`serialProjects` 默认开（index.js:73）、`parallelProjects` 默认 2 上限 4（index.js:74）、0.13.0 新增四项（`planMode` 默认 auto index.js:76、`agenticArticles` 默认开 index.js:77、`agenticMaxSteps` 默认 30 index.js:78、`symbolIncremental` 默认开 index.js:79）、`autoCommit` 默认开（index.js:81）、`updateReminder` 默认开（index.js:80）；全部 `.volatile()` 改完即生效（README.md:80）。
   - 配置链路：设置卡 `save`（client.js:764-803）依次校验两档并发（`maxConcurrency` 与 `bigConcurrency`，0=跟随）、agentic 步数 1–100（`agenticMaxSteps`）与 `planMode` 白名单，再按保存键白名单（client.js:790）经 `form.mutate` 单层 op + revision CAS 保存，与 patch 文件手改等价、同样热生效（README.md:45）；「编译流程（吸收自 FSoft CodeWiki）」设置节与其中英词条（`secPipeline` 等）为 0.13.0 新增（CHANGELOG.md:47，client.js:90-101/265-276）；provider/model 目录来自 /api/codewiki/models（`listModelCatalog` index.js:3393），思考档位来自 /api/codewiki/model-efforts（`resolveModelEfforts` index.js:3431，宿主方法适配 `resolveModelInfoOf` index.js:3420），普通档与大档共用渲染件 `modelTrio`（client.js:658）与档位拉取 `useEfforts`（client.js:620），目录未声明档位时设置页给通用档位下拉（`GENERIC_EFFORTS` client.js:30，0.11.2）。
   - 插件接线：`apply`（index.js:3945-4009）注入 `agentsRef`（index.js:1656）/`llmRef`（index.js:1661）、创建并启动常驻服务（index.js:3945-3946，effect 清理写法 index.js:3945 防「启动即停服务」）、注册四工具（单工具 schema 违规只丢该工具、不炸回调 index.js:3945-3961）、挂面板端点（index.js:3945）与系统提示提醒（index.js:3945）；自动更新调度 `autoScan`（index.js:3959）每 60s 心跳（index.js:3987）、到点对历史工作区逐仓 scope=auto 判态提交；`liveConfig`（index.js:92-134）在每次 execute/tick 热读配置。
   - 自举：`CodeWiki.md` 是插件自身仓库的 wiki 入口，声明重启 dsh 后可用 `codewiki_generate` 对本仓库重编（CodeWiki.md:3）；入口缺失时由 `ensureWikiEntry`（index.js:246-279）在 index 阶段自动补建（index.js:246-250），已有入口绝不覆盖。
2. **任务提交**：
   - CLI 薄封装：`cw` 工具（`cwToolDefinition` index.js:1159-1222，子命令白名单 `CW_SUBCOMMANDS` index.js:29）供 status/init/index/meta/path 手工查询与维护。
   - 判态与预构建：`normalizeCwd` 归一化 MSYS 盘符路径（index.js:49-54）→ `excludedItem` 排除清单（index.js:284-293，报错同时返回命中条目）→ worktree 闸门（`detectLinkedWorktree` index.js:309-325，工具侧在跑 `cw status` 之前拦截 index.js:49-59，报错文案含真实 gitDir 与「等合并回主仓库」指引，auto 直调降级返回）→ 空壳目录闸门（`clearSourceProbeCache` index.js:368 清缓存 + `hasCompilableSources` index.js:352 判定，index.js:49-60）→ `cw status` 四态解析（`parseStatus` index.js:213-226，调用点 index.js:49-54）。
   - 短路与幂等：clean 直接报告、scope=full 例外强制全量重编（index.js:3065-3070）；stale 遇无 wiki 自动升全量（index.js:3058-3063）；同仓库已有活动任务幂等返回并把唤醒权移交给最近会话（index.js:3047-3056），发起会话 id 记入 job.sessionId（index.js:3034）。
   - stale 逐篇更新：按旧文 frontmatter 的 source_files 预构建任务直达 articles（`readSourceFiles` index.js:1250-1258 / `parseSourceFiles` index.js:1236-1248 解析旧文清单，任务预构建 index.js:1250-1267），任务 mission 要求以当前代码为准重写过期文章、保留章节结构与 title/type/tags（index.js:1250）；随后符号级过滤：`loadSnapshot` 拿快照（index.js:3097）+ `extractCurrentGraph` 当前图（index.js:3101）→ `filterStaleTasks` 只留真受影响文章（index.js:3106），全部被滤掉时只 `cw meta update` 刷新基线不重写（index.js:1250-1256）。
   - 日常维护入口：`codewiki_update`（`updateToolDefinition` index.js:3176-3228）固定 scope=auto 复用 `generateToolDefinition.execute`（index.js:3216-3221），仅追加「本步收尾、继续下一项」引导 note；scope=full/stale 仍走 `codewiki_generate`。
3. **服务推进（阶段机）**：
   - 项目闸门：`submit`（index.js:2835-2920）按 `parallelLimit` 计算闸门——忙碌项目数达到上限时本任务进 queued、预置任务寄存 `pendingStage`/`pendingTasks`（index.js:2835-2852），排队期间零请求；`tick` 每轮先算 `activeIds`（index.js:2758-2770），轮到 queued 任务时落地预置并 note（index.js:2835-2846）；取消不受闸门限制（index.js:2835-2846）。
   - 阶段收割统一入口 `settleJob`（index.js:1833-1863）：执行器在跑返回 null；执行器丢失（宿主重启）时按 agentic 任务标记（index.js:1833-1839）或 `batchPrompt` 快照（index.js:1833-1842）整批重跑本阶段。
   - 写盘闸门：`writeValidated`（index.js:1868-1884）校验 frontmatter 后经 `fixAnchors`（index.js:568-651）确定性修正行号锚点才落盘；`tally`（index.js:1887-1919）按名字去重记账——重跑同一篇不重复累加 `writtenCount`、曾成功的条目不被后续失败抹掉（index.js:1868-1888）。
   - 会话通道兜底：`dispatchSessionTasks`（index.js:2131-2165）写任务文件 + steer 发起会话（文本由 `buildSessionSteerText` index.js:1465-1483 生成，`sessionTier` 非空时钉死档位），`progressSessionTasks`（index.js:2169-2188）每 tick 按 `classifySessionTask`（index.js:1448-1458）三态收割（harvest/timeout/wait），宿主重启后 `resendSessionSteer`（index.js:2192-2205）重发一次。
   - 会话内容记录：并发池每请求经 `beginSessionRecord`（index.js:1400-1442）把 prompt/输出落盘到 `SESSIONS_DIR`（index.js:1309，保留 `SESSION_TTL_MS` 24h index.js:1308），全局聚合 `listAllSessionRecords`（index.js:1346-1366），tick 内每 10 分钟 `pruneSessionRecords` 清理（index.js:1400-1404）。
4. **文章写作（articles 阶段）**：
   - 就地规划：全量编译在 articles 开头扫描并生成模块清单（index.js:862-866）——`planMode=dirs` 走 `localPlan`，否则 `semanticPlan`、失败记 note 退回目录分组（`buildPlan` index.js:2064-2087）。
   - agentic 通道（默认）：`tickArticles`（index.js:2213-2391）在 `agenticArticles` 开启时组装带 `agentic: true` 标记的任务（index.js:2348-2363）交 `startAgenticRun`（index.js:2014-2060）——模型现场读源码多轮写作，任务没有 `batchPrompt` 快照，宿主重启按任务本身重跑（index.js:2213-2219）；0.13.1 起模型可在写作中调 `generate_sub_module` 递归派子模块成文（README.md:39）；失败严格过半时经 `shouldFallBackHere` 退回单轮通道重跑失败篇（index.js:2278-2316）。
   - 单轮整包通道（旧通道 / agentic 关闭或退回）：`prepareArticleTasks`（index.js:727-812）按 token 预算装填（`collectSources` index.js:656-683、`estimateTokens` index.js:394-402、行号前缀 `numberLines` index.js:557-559）——110k 内普通档（`batchArticlePrompt` index.js:687-714）、110k–大档预算升大档单请求（`markBig` index.js:739-747，硬上限 `BATCH_TOKEN_HARD_LIMIT`=128k index.js:546）、超大档预算拆观察批（`batchArticleObservePrompt` index.js:1051-1067）+ 合成（`batchArticleComposePrompt` index.js:1071-1099）、单文件连大档都装不下转会话通道（index.js:727-746）。
   - 提交与并发：`submitBatchFor`（index.js:2089-2123）持久化任务快照（`bigTier` 标记必须随任务落盘，重启重跑才不会掉回默认档池 index.js:2089-2092）后由 `startBatchChatRun`（index.js:1967-2009）驱动 `runRealtimeTasks` 两池并发；启动 note 写明模型与两档并发（index.js:2113-2121）。
5. **横切与校对（crosscut/compose/review 阶段）**：
   - 横切：`tickCrosscut`（index.js:2415-2498）以成功模块文章全文为输入（`packArticles` index.js:969-988）——总量 ≤ 大档预算单批直出 `_architecture`/`_patterns`/概念文章（`crosscutTasks` index.js:2394-2413，模板 index.js:2415-2437），超预算拆每篇一个观察任务（`batchObservePrompt` index.js:1030-1047）进 compose 合成（`tickCompose` index.js:2501-2513 / `submitComposeBatch` index.js:2515-2525）。
   - 校对：`tickReview`（index.js:2550-2661）先 `localReview`（index.js:2528-2548）本地核对，再逐篇准备（文章+源码）后按 110k 贪心合并成批量校对请求（`batchProofreadBatchPrompt` index.js:1126-1153），输出按 `@@@article:`/`
