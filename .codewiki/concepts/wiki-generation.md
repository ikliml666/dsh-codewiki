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

`wiki-generation` 指 `@local/dsh-codewiki` 插件把一个代码仓库转化为结构化 CodeWiki 文档（`WIKI_PATHS` 即 `<repo>/.codewiki/` 与 `CodeWiki.md`，随仓库提交共享）的端到端编译过程。入口工具 `codewiki_generate` 由 `generateToolDefinition` 定义：纯提交制——`normalizeCwd` 归一路径、`runCw` 跑 `cw status` 并由 `parseStatus` 解析四态（missing/uncompiled/clean/stale）、按判态预构建任务后经 `submit` 交给宿主常驻编排服务 `createJobService` 即返回，工具路径零 LLM 调用、零子代理、不委托发起会话的主模型。服务在 `tick` 里以 `TICK_MS` 默认 10s 的节拍推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index → commit → done，阶段分发表是 `STAGE_HANDLER`；0.10.7 起无独立规划阶段，模块清单在 articles 阶段开头就地生成（0.13.0 起默认改由语义聚类产出）。全部模型环节在插件内的后台并发池 `runRealtimeTasks` 完成，唯一模型通道是 `llmChat` 包装的宿主 llm 服务（0.10.1 起无内置直连，插件不保存任何密钥）：普通档默认 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL`（workbuddy/hy3，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET`=110k）；110k–420k 输入自动升大档——默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`（volces-ark/glm-5.3-flash 512k），预算 `DEFAULT_BIG_TOKEN_BUDGET`=420k；大档任务（装填时打 `bigTier` 标记，`markBig`）与默认档任务在 `runRealtimeTasks` 内分两池独立限流、同时推进（`bigConcurrency` 默认 0=跟随默认档，0.12.2 起）；只有单文件连大档都装不下才转会话通道兜底（`dispatchSessionTasks`，超时 `SESSION_TASK_TIMEOUT_MS` 默认 30 分钟按失败处理）。0.10.11 起产物提交是阶段机里的显式一步：`tickIndex` 末尾在有产物且 `autoCommit` 开启时移交 commit 阶段，`tickCommit` 执行 `autoCommitWiki` 的「主题分支提交 → 合并回原分支」后才置 done 并唤醒；提交状态由 `autoCommitState` 判定 committed/no-changes/pending 三态，`wakeCompileSession` 在已提交/无改动时完全静默。0.11.0 起并行项目推进（`parallelProjects`，`liveConfig` 派生 `parallelLimit`，关串行后上限 1–4）与编译会话记录（`SESSIONS_DIR`，保留 24h）可用；0.12.0 起 linked git worktree 目录拒绝编译（`detectLinkedWorktree`）；0.12.1 起「扫不出源码」的空壳目录同样拒绝并从面板过滤（`isDeadCompileTarget`）。本概念横跨文档说明、核心实现、流水线库、测试验证与运行日志五大模块。

当前基线 0.13.1（package.json:3）——0.13.0 吸入了 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力，默认全开、任一环节不可用自动降级（README.md:26-39，CHANGELOG.md:39-65）：①模块划分 `planMode` 默认 auto 走 `semanticPlan`——tree-sitter AST 符号提取（lib/symbols.js）+ LLM 语义聚类（lib/cluster.js），失败退回 `localPlan` 顶层目录分组，分派点 `buildPlan`；②文章写作 `agenticArticles` 默认开走 agentic 工具循环——`startAgenticRun` 调 `runAgenticArticles`（lib/articles-agentic.js），模型自己读源码/列文件/增量改写多轮写作（单篇步数上限 `agenticMaxSteps`），不再把源码整包内联进 prompt，因而没有「超预算拆观察批」一整套；本批失败严格过半时经 `shouldFallBackFromAgentic` + `shouldFallBackHere` 退回单轮通道且只退一次（`job.agenticRetried`）、只重排失败篇（CHANGELOG.md:41）；③增量判定 `symbolIncremental` 默认开——stale 流程拿上次编译的符号快照与 `extractCurrentGraph` 的当前符号图做组件级比对（`filterStaleTasks`），纯注释/空白/格式化改动直接跳过重写，快照由 `tickIndex` 写入 `.codewiki/temp/symbol-graph.json`（`saveSnapshot`，内容未变不覆盖 `sameSnapshotContent`）。AST 依赖 vendor/tree-sitter（web-tree-sitter + tree-sitter-wasms，56MB 独立子根，README.md:41、CHANGELOG.md:39），未安装时三层全部自动降级、编译不中断。版本演进要点：0.12.2 编译并发拆两档独立设置（CHANGELOG.md:39-59）、0.12.1 统一无效编译对象判定（CHANGELOG.md:39-59）、0.12.0 全局会话 Tab + worktree 闸门（CHANGELOG.md:39-48）、0.11.0–0.11.2 并行推进/排队可见性/会话记录与思考档位修复（CHANGELOG.md:39-67）、0.10.9–0.10.11 自动提交三步走（CHANGELOG.md:39-83）、0.10.7 删独立规划阶段（CHANGELOG.md:39-48）。

## Involved Modules

- **docs-and-meta**：README.md（四工具表 README.md:9-15、`codewiki_generate` 关键行为 README.md:17-24、三层编译流水线与降级矩阵 README.md:26-39、全部设置项 README.md:43-64、本地 file:/// 安装 README.md:66-81、开发与验证 README.md:83-91）；CodeWiki.md（插件自身仓库的 wiki 入口 CodeWiki.md:3，Overview CodeWiki.md:7、Key Components CodeWiki.md:9-31、架构图 CodeWiki.md:33-57、Data Flow CodeWiki.md:59-61、Connections CodeWiki.md:63-66、Known Issues CodeWiki.md:68-75，重启 dsh 后可用 `codewiki_generate` 对本仓库重编）；CHANGELOG.md（0.1.0 → 0.13.1 全部行为变更，最新一节 0.13.1 在 CHANGELOG.md:3-23）。
- **core-and-config**（插件双半侧实现）：
  - `index.js`（宿主半侧，单文件实现）：`Config` 全部 `.volatile()` 设置、四工具 `cwToolDefinition`/`generateToolDefinition`/`updateToolDefinition`/`progressToolDefinition`、编排服务 `createJobService`、prompt 模板组（`articleFormatSection` 起）、语义规划 `semanticPlan`、面板端点 `installWebServer`（jobs/repos/sessions/sessions/item/models/model-efforts/control 七个精确端点全部仅回环放行）、自动提交 `autoCommitWiki`、入口 `apply`。
  - `client.js`（浏览器半侧）：插件页设置卡 `CodewikiCard`、模型三件套渲染 `modelTrio`、思考档位拉取 `useEfforts`、保存与校验 `save`、总览页 `ReposTab`、会话视图 `SessionView`、侧边栏面板 `CodewikiPanel`、阶段步骤条 `stageBar`、加权总进度 `STAGE_WEIGHTS`、面板图标 `PanelIcon`。
  - 中英词典（client.js 内，值全字符串），0.13.0 新增「编译流程」节词条 `secPipeline` 等。
  - cordis.patch.yml（bundle 形式挂载补丁：设置项注释与 file:/// 直挂条目，与 profile patch 条目保持 id 一致）。
  - package.json（版本 0.13.1 package.json:3、exports["./client"] package.json:8-11、engines package.json:13-16、dsh.client.platform 与 bundle 补丁声明 package.json:20-27）。
  - .gitignore（node_modules/ .gitignore:1、`*.log` 不入库 .gitignore:3、.probe3.txt 条目 .gitignore:9、.dsh-ops/ 运行期产物 .gitignore:12）。
- **pipeline-libs（0.13.0 新增，本篇源码快照未含其正文）**：lib/symbols.js（表驱动 `LANG_RULES`，web-tree-sitter + WASM 语法覆盖 16 种语言，产出组件 Map 与 `resolveImportEdges` 依赖边，CHANGELOG.md:31）、lib/cluster.js（两阶段 LLM 聚类 + 超大模块递归下钻 + `heuristicCluster` 兜底，CHANGELOG.md:33）、lib/agentic.js + lib/agentic-host.js + lib/articles-agentic.js（工具循环纯逻辑 / 裸消息↔宿主 llm 协议适配 / job 生命周期接线，CHANGELOG.md:31）、lib/graph-diff.js + lib/incremental.js（组件级 diff 与快照存取，含 78 条与 Python 原版逐位对拍，CHANGELOG.md:31、49）。七库由 index.js 侧的 `extractRepoGraph`/`clusterComponents`/`runAgenticArticles` 等导入；库内实现本篇不引用行号，描述以 CHANGELOG.md 为准。
- **test-scripts**：自检脚本直接对接真实 index.js 导出——test-orchestration.mjs（1529 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实服务 tick，tick 压到 300ms test-orchestration.mjs:44；0.13.0 起配置基线以 `LEGACY_CHANNEL`（test-orchestration.mjs:44）显式钉住旧通道、继续守护其请求次数与装填时序，新通道由 0.13.0 新增的 test-symbols/test-cluster/test-agentic*/test-semantic-plan/test-graphdiff/test-incremental* 守护（CHANGELOG.md:49，本篇快照未含正文）；`autoCommitWiki` 安全边界块 test-orchestration.mjs:412-513、`autoCommitState` 三态块 test-orchestration.mjs:515-525、`wakeCompileSession` 唤醒块 test-orchestration.mjs:527-563、端到端含独立 commit 阶段断言 test-orchestration.mjs:44-85、单项目串行块 test-orchestration.mjs:44-100、并行项目上限块 test-orchestration.mjs:44-73、全局会话聚合与 worktree 闸门块 test-orchestration.mjs:44-115、空壳目录闸门块 test-orchestration.mjs:44-93）；test-batch.mjs（570 行，纯函数与假 llm 执行链：大档接管块 test-batch.mjs:107-131、两档分池限流块 test-batch.mjs:229-296、`fixAnchors` 块 test-batch.mjs:522-564）；test-wiki-entry.mjs（CodeWiki.md 入口生成与 Windows 路径规范化）；test-wiki-anchors.mjs（118 行，行号锚点守卫：基础/符号绑定/区间三重断言，规则 test-wiki-anchors.mjs:1-9、汇总 test-wiki-anchors.mjs:117-118）；test-cwd-paths.mjs（71 行，MSYS/Windows/不存在路径三态实测）。
- **logs-and-temp**：历史测试与排查日志，均被 .gitignore:3 的 `*.log` 规则排除——.tmp-test-batch.log（百炼直连与 `resolveBatchApiKey` 时代的执行链自检留档：28k/200k 档位断言、百炼端点断言、汇总 59 通过 0 失败）；.tmp-test-cwd-paths.log（8 行，末行 .tmp-test-cwd-paths.log:8 记 ALL PASS）；.tmp-test-orchestration.log（独立规划阶段尚存时代的运行留档：「初始 stage=plan」断言、主模型规划 notes，末行记 FAIL 2 项——source 标记还是 0.8.5 前的 plugin/codewiki 形态）；.tmp-test-wiki-anchors.log（旧基线 122 过/36 败的锚点校验留档）；.tmp-test-wiki-entry.log（全部通过）；watcher2.log（0.4.x 排查多实例 jobs 文件互覆时的轮询记录，记录的全是 2026-10-06 的 plan 阶段任务）。旧探针 .probe3.txt 已不在仓库中（.gitignore:9 仍保留其排除条目）。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:17-24（提交制、scope=auto/full/stale 语义、两档并发、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）；0.13.0 三层能力与各层降级行为全文见 README.md:26-39 与 CHANGELOG.md:25-51。
   - 设置项与默认值：`Config`——编译模型三项（`batchProvider` 默认 workbuddy、`batchModel` 默认 hy3、`batchReasoningEffort` 留空=模型默认档）、大档五项（`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`、大档并发 `bigConcurrency` 默认 0=跟随默认档）、`sessionTier`、`maxConcurrency` 默认 2 硬顶 8（常量 `DEFAULT_CONCURRENCY`、`CONCURRENCY_HARD_CAP`）、`serialProjects` 默认开、`parallelProjects` 默认 2 上限 4、0.13.0 新增四项（`planMode` 默认 auto、`agenticArticles` 默认开、`agenticMaxSteps` 默认 30、`symbolIncremental` 默认开）、`autoCommit` 默认开、`updateReminder` 默认开；全部 `.volatile()` 改完即生效（README.md:80）。
   - 配置链路：设置卡 `save` 依次校验两档并发（`maxConcurrency` 与 `bigConcurrency`，0=跟随）、agentic 步数 1–100（`agenticMaxSteps`）与 `planMode` 白名单，再按保存键白名单经 `form.mutate` 单层 op + revision CAS 保存，与 patch 文件手改等价、同样热生效（README.md:45）；「编译流程（吸收自 FSoft CodeWiki）」设置节与其中英词条（`secPipeline` 等）为 0.13.0 新增（CHANGELOG.md:47）；provider/model 目录来自 /api/codewiki/models（`listModelCatalog`），思考档位来自 /api/codewiki/model-efforts（`resolveModelEfforts`，宿主方法适配 `resolveModelInfoOf`），目录未声明档位时设置页给通用档位下拉（`GENERIC_EFFORTS`，0.11.2）。
   - 插件接线：`apply` 注入 `agentsRef`/`llmRef`、创建并启动常驻服务（`createJobService` 实例化，effect 清理写法防「启动即停服务」）、注册四工具（单工具 schema 违规只丢该工具、不炸回调）、挂面板端点（`installWebServer`）与系统提示提醒（`installUpdateReminder`）；自动更新调度 `autoScan` 每 60s 心跳、到点对历史工作区逐仓 scope=auto 判态提交；`liveConfig` 在每次 execute/tick 热读配置。
   - 自举：`CodeWiki.md` 是插件自身仓库的 wiki 入口，声明重启 dsh 后可用 `codewiki_generate` 对本仓库重编（CodeWiki.md:3）；入口缺失时由 `ensureWikiEntry` 在 index 阶段自动补建，已有入口绝不覆盖。
2. **任务提交**：
   - 判态与预构建：`normalizeCwd` 归一化 MSYS 盘符路径 → `excludedItem` 排除清单（报错同时返回命中条目）→ worktree 闸门（`detectLinkedWorktree`，工具侧在跑 `cw status` 之前拦截，报错文案含真实 gitDir 与「等合并回主仓库」指引，auto 直调降级返回）→ 空壳目录闸门（`clearSourceProbeCache` 清缓存 + `hasCompilableSources` 判定）→ `cw status` 四态解析（`parseStatus`）。
   - 短路与幂等：clean 直接报告、scope=full 例外强制全量重编；stale 遇无 wiki 自动升全量；同仓库已有活动任务幂等返回并把唤醒权移交给最近会话，发起会话 id 记入 job.sessionId。
   - stale 逐篇更新：按旧文 frontmatter 的 source_files 预构建任务直达 articles（`readSourceFiles`/`parseSourceFiles` 解析旧文清单），任务 mission 要求以当前代码为准重写过期文章。
