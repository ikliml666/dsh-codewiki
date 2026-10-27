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

`wiki-generation` 指 `@local/dsh-codewiki` 插件把一个代码仓库转化为结构化 CodeWiki 文档（产物路径常量 `WIKI_PATHS` 即 `<repo>/.codewiki/` 与 `CodeWiki.md`，随仓库提交共享，index.js:45）的端到端编译过程。入口工具 `codewiki_generate` 由 `generateToolDefinition` 定义（index.js:2978）：纯提交制——`normalizeCwd` 归一路径（index.js:49）、`runCw` 跑 `cw status`（index.js:162）并由 `parseStatus` 解析四态（index.js:213-226）、按判态预构建任务后经 `submit`（index.js:2859-2944）交给宿主常驻编排服务 `createJobService`（index.js:1695-2971）即返回，工具路径零 LLM 调用、零子代理、不委托发起会话的主模型。服务在 `tick`（index.js:2771-2857）里以 `TICK_MS` 默认 10s 的节拍（index.js:1295）推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index → commit → done，阶段分发表是 `STAGE_HANDLER`（index.js:2762-2769）；0.10.7 起无独立规划阶段，模块清单在 articles 阶段开头就地生成（0.13.0 起默认改由语义聚类产出，见 `buildPlan` index.js:2074-2097）。全部模型环节在插件内的后台并发池 `runRealtimeTasks`（index.js:469-528）完成，唯一模型通道是 `llmChat` 包装的宿主 llm 服务（index.js:412-437，0.10.1 起无内置直连，插件不保存任何密钥）：普通档默认 `DEFAULT_BATCH_PROVIDER`/`DEFAULT_BATCH_MODEL`（workbuddy/hy3，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET`=110k，index.js:541）；110k–420k 输入自动升大档——默认 `DEFAULT_BIG_PROVIDER`/`DEFAULT_BIG_MODEL`（volces-ark/glm-5.3-flash 512k，index.js:39-42，预算 `DEFAULT_BIG_TOKEN_BUDGET`=420k index.js:42）；大档任务（装填时打 `bigTier` 标记，`markBig` index.js:739-747）与默认档任务在 `runRealtimeTasks` 内分两池独立限流、同时推进（`bigConcurrency` 默认 0=跟随默认档，index.js:72，0.12.2 起）；只有单文件连大档预算都装不下才转会话通道兜底（`dispatchSessionTasks` index.js:2141-2175，超时 `SESSION_TASK_TIMEOUT_MS` 默认 30 分钟按失败处理，index.js:1299）。0.10.11 起产物提交是阶段机里的显式一步：`tickIndex`（index.js:2687-2742）末尾在有产物且 `autoCommit` 开启时移交 commit 阶段（index.js:2735-2738），`tickCommit`（index.js:2744-2760）执行 `autoCommitWiki`（index.js:3807-3889）的「主题分支提交 → 合并回原分支」后才置 done 并唤醒；提交状态由 `autoCommitState`（index.js:1671-1676）判定 committed/no-changes/pending 三态，`wakeCompileSession`（index.js:1678-1693）在已提交/无改动时完全静默（index.js:45-47）。0.11.0 起并行项目推进（`parallelProjects` index.js:74，`liveConfig` 派生 `parallelLimit` index.js:115-119，关串行后上限 1–4）与编译会话记录（`SESSIONS_DIR` index.js:1311，保留 24h）可用；0.12.0 起 linked git worktree 目录拒绝编译（`detectLinkedWorktree` index.js:309-325）；0.12.1 起「扫不出源码」的空壳目录同样拒绝并从面板过滤（`isDeadCompileTarget` index.js:378-386）。本概念横跨文档说明、核心实现、流水线库、测试验证与运行日志五大模块。

整体数据通路：

```text
┌──────────────────────────────────┐
│ 模型调用 codewiki_generate        │ 提交制，工具路径零 LLM
│ generateToolDefinition（index.js）│ cw status 判态/预构建任务
└───────────────┬──────────────────┘
                ▼
┌──────────────────────────────────┐
│ createJobService（tick 10s）      │ STAGE_HANDLER 阶段机
│ articles → crosscut →(compose)→  │
│ review → index → commit → done   │
└────┬──────────────┬──────────────┘
     ▼              ▼
┌──────────┐  ┌───────────────────┐
│ agentic  │  │ runRealtimeTasks  │
│ 写作通道  │  │ 单轮装填/观察→合成 │
└────┬─────┘  └─────────┬─────────┘
     └────────┬─────────┘
              ▼
┌──────────────────────────────────┐
│ llmChat → 宿主 llm.stream         │
│ 默认档 hy3 ／ 大档 glm-5.3-flash  │
│ 连大档都装不下 → 会话通道兜底      │
└──────────────────────────────────┘
```

当前基线 0.13.4（package.json:3）——0.13.0 吸入了 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力，默认全开、任一环节不可用自动降级（README.md:39-54，CHANGELOG.md:67-93）：①模块划分 `planMode` 默认 auto（index.js:76）走 `semanticPlan`（index.js:884-967）——tree-sitter AST 符号提取（lib/symbols.js，`extractRepoGraph` index.js:16 导入）+ LLM 语义聚类（lib/cluster.js，`clusterComponents` index.js:17 导入），失败退回 `localPlan` 顶层目录分组（index.js:862-875）；②文章写作 `agenticArticles` 默认开（index.js:77）走 agentic 工具循环——`startAgenticRun`（index.js:2023-2070）调 `runAgenticArticles`（lib/articles-agentic.js:204-279，index.js:23 导入），模型自己读源码/列文件/增量改写多轮写作（单篇步数上限 `agenticMaxSteps` index.js:78，唯一定义 `DEFAULT_MAX_STEPS` lib/agentic.js:325），不再把源码整包内联进 prompt，因而没有「超预算拆观察批」一整套；0.13.1 起模型还可在写作中调 `generate_sub_module` 递归派出子模块成文（`subDepth` 默认封顶 2 层、子模块名全局去重、失败只记账不拖垮父文章，README.md:39，CHANGELOG.md:75-93）；本批失败严格过半时经 `shouldFallBackFromAgentic`（index.js:855-860）+ `shouldFallBackHere`（index.js:1932-1939）退回单轮通道且只退一次（`job.agenticRetried` index.js:2308）、只重排失败篇（index.js:884-894，CHANGELOG.md:111）；③增量判定 `symbolIncremental` 默认开（index.js:79）——stale 流程拿上次编译的符号快照与 `extractCurrentGraph`（index.js:1563-1580）的当前符号图做组件级比对（`filterStaleTasks`，index.js:21 导入、index.js:3130 调用），纯注释/空白/格式化改动直接跳过重写（0.13.2 起按 `codeHash`=剥离注释后的哈希判定，lib/graph-diff.js:108-111），快照由 `tickIndex` 写入 `.codewiki/temp/symbol-graph.json`（`saveSnapshot` index.js:2713，内容未变不覆盖 `sameSnapshotContent` index.js:2710）。0.13.2 的其余整改：`subDepth` 递归封顶真生效（递归传 `onSubModule: null` 让子层按自己的 `_depth` 重建判定，lib/articles-agentic.js:204-215）、symbols 补正则降级 `REGEX_RULES`+`regexExtract`（lib/symbols.js:302-440）、cluster 下钻真递归（lib/cluster.js:291-317）、agentic 通道接双池（`markBigAgenticTasks` lib/articles-agentic.js:287-300，index.js:2362-2373 打标）、`tally` 去重语义收窄为 `replace`/`mergeByName` 两开关（index.js:1897-1928）、`plan.graph` 不再携带全量源码（index.js:950-959，CHANGELOG.md:67-98）。0.13.3 的修复：`read_code` 重复读抑制（`makeReadCodeTool` 记账，去重判定在读盘之前，lib/agentic.js:115-177）、`toRequestMessages` 的 MessageId 身份稳定（模块级 `WeakMap` 缓存，lib/agentic-host.js:26-79）、`parseToolArgs` 三级递进剥 JSON 围栏（lib/agentic.js:476-500）（CHANGELOG.md:67-83）；0.13.4 的修复：工具层补齐四个真实翻车点——`str_replace`/`insert` 按行尾归一化匹配（含 `insert` 拒绝负行号）、子模块到嵌套上限时明确报错不再谎称已记录、`read_code` 加 40000 字符上限、`list_files` 隐藏 `node_modules`/`.git` 等依赖目录（CHANGELOG.md:67-84）。AST 依赖 vendor/tree-sitter（web-tree-sitter + tree-sitter-wasms，56MB 独立子根，README.md:41、CHANGELOG.md:115），未安装时三层全部自动降级、编译不中断。版本演进要点：0.12.2 编译并发拆两档独立设置（CHANGELOG.md:67-87）、0.12.1 统一无效编译对象判定（CHANGELOG.md:67-87）、0.12.0 全局会话 Tab + worktree 闸门（CHANGELOG.md:67-76）、0.11.0–0.11.2 并行推进/排队可见性/会话记录与思考档位修复（CHANGELOG.md:67-95）、0.10.9–0.10.11 自动提交三步走（CHANGELOG.md:67-111）、0.10.7 删独立规划阶段（CHANGELOG.md:67-76）。

## Involved Modules

- **docs-and-meta**：README.md（提供四工具表 README.md:9-15、`codewiki_generate` 关键行为 README.md:17-24、三层编译流水线与降级矩阵 README.md:26-41、全部设置项 README.md:43-64、本地 file:/// 安装 README.md:66-81、开发与验证 README.md:83-91）；CodeWiki.md（插件自身仓库的 wiki 入口声明 CodeWiki.md:3，Overview CodeWiki.md:5-7、Key Components CodeWiki.md:9-31、架构图 CodeWiki.md:33-57、Data Flow CodeWiki.md:59-61、Connections CodeWiki.md:63-66、Known Issues CodeWiki.md:68-75，重启 dsh 后可用 `codewiki_generate` 对本仓库重编）；CHANGELOG.md（0.1.0 → 0.13.4 全部行为变更，最新一节 0.13.4 在 CHANGELOG.md:3-20）。
- **core-and-config**（插件双半侧实现）：
  - `index.js`（宿主半侧，单文件 4033 行）：`Config`（index.js:60-86）全部 `.volatile()` 设置与热读 `liveConfig`（index.js:92-134）、四工具 `cwToolDefinition`（index.js:1161-1224）/`generateToolDefinition`（index.js:2978-3190）/`updateToolDefinition`（index.js:3200-3252）/`progressToolDefinition`（index.js:3271-3375）、编排服务 `createJobService`（index.js:1695-2971，内含阶段机 `STAGE_HANDLER` index.js:2762-2769 与各 `tick*` 处理器）、prompt 模板组（`articleFormatSection` index.js:818-847，文章/观察/合成/校对模板 index.js:60-528）、本地与语义规划（`localPlan` index.js:862-875、`semanticPlan` index.js:884-967）、仓库扫描 `scanRepoFiles`（index.js:1535-1558，黑名单与上限 index.js:60-72）、面板端点 `installWebServer`（index.js:3479-3774，jobs/repos/sessions/sessions/item/models/model-efforts/control 七个精确端点，index.js:60/3560/3655/3677/3703/3722/3743，全部仅回环放行）、自动提交 `autoCommitWiki`（index.js:3807-3889）、入口 `apply`（index.js:3969-4033）。
  - `client.js`（浏览器半侧，单文件 1680 行）：插件页设置卡 `CodewikiCard`（client.js:548）、模型三件套渲染 `modelTrio`（client.js:658）、思考档位拉取 `useEfforts`（client.js:620）、保存与校验 `save`（client.js:764-803）、总览页 `ReposTab`（client.js:1177）、会话视图 `SessionView`（client.js:1326）、侧边栏面板 `CodewikiPanel`（client.js:1418-1663）、阶段步骤条 `stageBar`（client.js:1100-1122）、加权总进度 `STAGE_WEIGHTS`（client.js:1124）、面板图标 `PanelIcon`（client.js:1665-1676）。
  - 中英词典（client.js:35-209 zh / client.js:210-384 en，值全字符串），0.13.0 新增「编译流程」节词条 `secPipeline` 等（client.js:90-101 与 client.js:265-276）。
  - cordis.patch.yml（bundle 形式挂载补丁：设置项注释 cordis.patch.yml:1-18 与 file:/// 直挂条目 cordis.patch.yml:19-24、配置示例 cordis.patch.yml:25-33，与 profile patch 条目保持 id 一致）。
  - package.json（版本 0.13.4 package.json:22、`exports["./client"]` package.json:22-25、engines package.json:22-25、`dsh.client.platform` 与 bundle 补丁声明 package.json:22-28）。
  - .gitignore（node_modules/ .gitignore:1、`*.log` 不入库 .gitignore:3、`bin/*.bak-*` 二进制备份 .gitignore:6、.dsh-ops/ 运行期产物 .gitignore:12）。
- **pipeline-libs（0.13.0 新增）**：
  - lib/symbols.js（884 行）：表驱动 `LANG_RULES`（lib/symbols.js:36-271，16 种语言的 wasm 名/扩展名/符号节点规则），`SymbolExtractor`（lib/symbols.js:472-779）逐文件 `extractFile`（lib/symbols.js:551-594）产出组件记录，批量入口 `extractRepoGraph`（lib/symbols.js:785-805）+ 依赖边 `resolveImportEdges`（lib/symbols.js:810-833，import 解析 `resolveSpec` lib/symbols.js:849）；WASM 不可用/解析零符号时正则兜底 `REGEX_RULES`（lib/symbols.js:302-368）+ `regexExtract`（lib/symbols.js:374-440），命中数记 `stats.regex`（lib/symbols.js:560-563）；依赖装在 `DEFAULT_VENDOR_DIR`（lib/symbols.js:25，即 vendor/tree-sitter 独立子根，不污染宿主注入的插件根 node_modules）。
  - lib/cluster.js（467 行）：移植上游 `cluster_modules.py` 的三段式——顶层聚类 `clusterPrompt`（lib/cluster.js:57-81）、超大模块递归下钻 `subdivide`（lib/cluster.js:396-422，递归条件「子模块 ≥ `DEFAULT_SPLIT_THRESHOLD` lib/cluster.js:288 且未到 maxDepth」，0.13.2 起真递归）、顶层过多时超级分组 `parseSuperGroups`（lib/cluster.js:425-456）；主入口 `clusterComponents`（lib/cluster.js:291-389），模型不可用/请求失败走 `heuristicCluster`（lib/cluster.js:219-244，单顶层目录自动下探第二层）；回复解析 `parseClusterResponse`（lib/cluster.js:156-195）校验 id 与去重；`toPlanModules`（lib/cluster.js:460-467）转成 articles 阶段吃的 `{name, summary, files}`。
  - lib/agentic.js（541 行）：工具循环纯逻辑。工具表 `TOOL_SCHEMAS`（lib/agentic.js:27-87：`read_code`/`list_files`/`edit_article`/`generate_sub_module`），`makeReadCodeTool`（lib/agentic.js:115-177，0.13.3 起带 `seen` 重复读抑制、2000 行上限，0.13.4 起另加 40000 字符上限）、`makeListFilesTool`（lib/agentic.js:179-197，0.13.4 起隐藏 node_modules 等依赖目录）、`makeArticleEditor`（lib/agentic.js:200-263，`view`/`str_replace`/`insert` 三命令，0.13.4 起 str_replace 做行尾 CRLF/LF 归一 lib/agentic.js:27-44、insert 拒绝负行号 lib/agentic.js:27-32）；路径越界防护 `safeRelPath`（lib/agentic.js:266-273）；循环本体 `runAgenticArticle`（lib/agentic.js:331-432，无工具调用即视为写完）；坏参数抢救 `parseToolArgs`（lib/agentic.js:476-500，原样→剥围栏→截首个括号平衡对象三级递进）；开场提示词 `buildOpeningPrompt`（lib/agentic.js:506-541，仅在 `generate_sub_module` 真在工具表里时才追加拆分指引）。
  - lib/agentic-host.js（135 行）：裸消息 ↔ 宿主 llm 协议适配。`toRequestMessages`（lib/agentic-host.js:34-79）把工具循环的裸消息转成宿主要求的正式 Message，模块级 `IDENTITY` WeakMap（lib/agentic-host.js:26）缓存已构造消息保证 MessageId 跨步稳定（0.13.3 修复，CHANGELOG.md:31）；`makeHostStream`（lib/agentic-host.js:83-108，BlockAssembler 收块、signal 透传）、`makeFsWorkspace`（lib/agentic-host.js:111-135，读文件/列目录 + 真实路径越界兜底）。
  - lib/articles-agentic.js（300 行）：job 生命周期接线。`runOneArticle`（lib/articles-agentic.js:32-152，旧文作初始内容交给 editor 增量改、空文章算失败不落盘、`generate_sub_module` 就地递归派子模块到 `<wiki>/modules/<父>/<子>.md`、递归传 `onSubModule: null` 保证 `subDepth` 封顶逐层生效 lib/articles-agentic.js:32-43）；`runAgenticArticles`（lib/articles-agentic.js:204-279）双池并发池，与单轮通道同形状返回 Map；`sourceTokensOf`（lib/articles-agentic.js:158-176，与 `estimateTokens` 同口径）+ `markBigAgenticTasks`（lib/articles-agentic.js:287-300，模块源文本量超 `bigTokenBudget` 才打 `bigTier` 标）+ `resolveTaskRoute`（lib/articles-agentic.js:181-195，大档任务 effort 不回落默认档）。
  - lib/graph-diff.js（578 行）：逐位移植上游 `updater/graph_diff.py`（78 条 golden 对拍，CHANGELOG.md:48）。`diffGraphs`（lib/graph-diff.js:447-564）产出六类变更集（`CLASS_IFACE`/`CLASS_BODY`/`CLASS_EDGE`/`CLASS_ADDED`/`CLASS_DELETED`/`CLASS_RENAMED`，lib/graph-diff.js:14-19），改名配对按 token 序列 difflib 相似度（`sequenceRatio` lib/graph-diff.js:229-236、`bodySimilarity` lib/graph-diff.js:239-245）贪心最佳匹配（`pairRenames` lib/graph-diff.js:371-407）；哈希三层：`bodyHash`（lib/graph-diff.js:121-126，含文档注释）、`codeHash`（lib/graph-diff.js:108-111，0.13.2 起剥离注释——`stripComments` lib/graph-diff.js:69-100，行首认五种注释符、行尾只认 `//` 与 `#` 以免吃掉 `a--`/`50%2` 这类真代码 lib/graph-diff.js:447-451）。
  - lib/incremental.js（206 行）：快照存取（`SNAPSHOT_REL` lib/incremental.js:22 即 `temp/symbol-graph.json`，`SNAPSHOT_VERSION` lib/incremental.js:19；`slimGraph` lib/incremental.js:37-48 固化 `bodyHash`/`codeHash` 不存源码、`loadSnapshot` lib/incremental.js:94-104 版本不符当没有、`saveSnapshot` lib/incremental.js:106-115）、文件级→组件级折算与文章过滤 `filterStaleTasks`（lib/incremental.js:140-194：0.13.2 起「`bodyHash` 变但 `codeHash` 没变且 docstring 没变」的组件归入 `cosmeticOnly` 不重写 lib/incremental.js:154-170，无符号可判的文章保守保留 lib/incremental.js:22-27）、变更摘要 `describeChange`（lib/incremental.js:197-206）。
  - 七库由 index.js 侧导入（index.js:18-26）；`diffGraphs`/`graphFromSnapshot` 等仅被库间与 stale 流程消费。
- **test-scripts**：自检脚本直接对接真实 index.js 导出——test-orchestration.mjs（1529 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实服务 tick，tick 压到 300ms test-orchestration.mjs:44；0.13.0 起配置基线以 `LEGACY_CHANNEL`（test-orchestration.mjs:44）显式钉住旧通道、继续守护其请求次数与装填时序，新通道由 test-symbols/test-cluster/test-agentic*/test-semantic-plan/test-graphdiff/test-incremental* 守护（CHANGELOG.md:119，本篇未收录其正文）；`autoCommitWiki` 安全边界块 test-orchestration.mjs:412-513、`autoCommitState` 三态块 test-orchestration.mjs:515-525、`wakeCompileSession` 唤醒块 test-orchestration.mjs:527-563、端到端含独立 commit 阶段断言 test-orchestration.mjs:44-46、单项目串行块 test-orchestration.mjs:44-100、并行项目上限块 test-orchestration.mjs:44-73、全局会话聚合与 worktree 闸门块 test-orchestration.mjs:44-115、空壳目录闸门块 test-orchestration.mjs:44-93）；test-batch.mjs（570 行，纯函数与假 llm 执行链：大档接管块 test-batch.mjs:107-131、两档分池限流块 test-batch.mjs:229-296、0.10.1 无直连反向断言 test-batch.mjs:517-520、`fixAnchors` 块 test-batch.mjs:522-564）；test-wiki-entry.mjs（76 行，CodeWiki.md 入口生成与 Windows 路径规范化，导入真实导出 test-wiki-entry.mjs:10）；test-wiki-anchors.mjs（118 行，行号锚点守卫：基础/符号绑定/区间三重断言，规则 test-wiki-anchors.mjs:1-9、符号就近绑定 test-wiki-anchors.mjs:38-62、多锚点行不校验绑定 test-wiki-anchors.mjs:101-104、汇总 test-wiki-anchors.mjs:117-118）；test-cwd-paths.mjs（71 行，MSYS/Windows/不存在路径三态实测 test-cwd-paths.mjs:30-69）。
- **logs-and-temp**：历史测试与排查日志，均被 .gitignore:3 的 `*.log` 规则排除——.tmp-test-batch.log（百炼直连与 `resolveBatchApiKey` 时代的执行链自检留档：28k/200k 档位断言 .tmp-test-batch.log:76-78、凭证解析块 .tmp-test-batch.log:76-83，末行 .tmp-test-batch.log:76 记 ALL PASS 59 通过 0 失败）；.tmp-test-cwd-paths.log（8 行，末行 .tmp-test-cwd-paths.log:8 记 ALL PASS）；.tmp-test-orchestration.log（独立规划阶段尚存时代的运行留档：「初始 stage=plan」断言 .tmp-test-orchestration.log:188、主模型规划 notes .tmp-test-orchestration.log:137，两处 source 标记失败 .tmp-test-orchestration.log:114/.tmp-test-orchestration.log:195——0.8.5 前还是 `plugin/codewiki` 形态，末行 .tmp-test-orchestration.log:573 记 FAIL 2 项）；.tmp-test-wiki-anchors.log（旧基线 122 过/36 败的锚点校验留档，末行 .tmp-test-wiki-anchors.log:130）；.tmp-test-wiki-entry.log（全部通过，末行 .tmp-test-wiki-entry.log:25）；watcher2.log（0.4.x 排查多实例 jobs 文件互覆时的轮询记录，记录的全是 2026-10-06 的 plan 阶段任务，如 watcher2.log:1）。旧探针 .probe3.txt 已不在仓库中（.gitignore:9 仍保留其排除条目）。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:17-24（提交制、scope=auto/full/stale 语义、两档并发、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）；0.13.0 三层能力与各层降级行为全文见 README.md:26-41 与 CHANGELOG.md:95-121。
   - 设置项与默认值：`Config`（index.js:60-86）——编译模型三项（`batchProvider` 默认 workbuddy index.js:63、`batchModel` 默认 hy3 index.js:64、`batchReasoningEffort` 留空=模型默认档 index.js:65）、大档五项（`bigProvider` index.js:66/`bigModel` index.js:67/`bigReasoningEffort` index.js:68/`bigTokenBudget` index.js:69、大档并发 `bigConcurrency` 默认 0=跟随默认档 index.js:72）、`sessionTier`（index.js:70）、`maxConcurrency` 默认 2 硬顶 8（常量 `DEFAULT_CONCURRENCY` index.js:33、`CONCURRENCY_HARD_CAP` index.js:31）、`serialProjects` 默认开（index.js:73）、`parallelProjects` 默认 2 上限 4（index.js:74）、0.13.0 新增四项（`planMode` 默认 auto index.js:76、`agenticArticles` 默认开 index.js:77、`agenticMaxSteps` 默认 30 index.js:78、`symbolIncremental` 默认开 index.js:79）、`autoCommit` 默认开（index.js:81）、`updateReminder` 默认开（index.js:80）；全部 `.volatile()` 改完即生效（README.md:80）。
   - 配置链路：设置卡 `save`（client.js:764-803）依次校验两档并发（`maxConcurrency` 与 `bigConcurrency`，0=跟随）、agentic 步数 1–100（`agenticMaxSteps`）与 `planMode` 白名单，再按保存键白名单（client.js:790）经 `form.mutate` 单层 op + revision CAS 保存，与 patch 文件手改等价、同样热生效（README.md:45）；「编译流程（吸收自 FSoft CodeWiki）」设置节渲染于 client.js:764-810（planMode 下拉 client.js:951-962、`agenticArticles` 开关 client.js:963-971、步数输入 client.js:972-981、`symbolIncremental` 开关 client.js:982-990），其中英词条为 0.13.0 新增（CHANGELOG.md:117，client.js:764-775/265-276）；provider/model 目录来自 /api/codewiki/models（`listModelCatalog` index.js:3417-3438），思考档位来自 /api/codewiki/model-efforts（`resolveModelEfforts` index.js:3455-3477，宿主方法适配 `resolveModelInfoOf` index.js:3444-3449），普通档与大档共用渲染件 `modelTrio`（client.js:658）与档位拉取 `useEfforts`（client.js:620），目录未声明档位时设置页给通用档位下拉（`GENERIC_EFFORTS` client.js:30，0.11.2）。
   - 插件接线：`apply`（index.js:3969-4033）注入 `agentsRef`（index.js:1658）/`llmRef`（index.js:1663）、创建并启动常驻服务（index.js:3969-3970，effect 清理写法 index.js:3969 防「启动即停服务」）、注册四工具（单工具 schema 违规只丢该工具、不炸回调 index.js:3969-3985）、挂面板端点（index.js:3969）与系统提示提醒（index.js:3969）；自动更新调度 `autoScan`（index.js:3983-4010）每 60s 心跳（index.js:4011）、到点对历史工作区逐仓 scope=auto 判态提交；`liveConfig`（index.js:92-134）在每次 execute/tick 热读配置。
   - 自举：`CodeWiki.md` 是插件自身仓库的 wiki 入口，声明重启 dsh 后可用 `codewiki_generate` 对本仓库重编（CodeWiki.md:3）；入口缺失时由 `ensureWikiEntry`（index.js:246-279）在 index 阶段自动补建（index.js:246-250），已有入口绝不覆盖。
2. **任务提交**：
   - CLI 薄封装：`cw` 工具（`cwToolDefinition` index.js:1161-1224，子命令白名单 `CW_SUBCOMMANDS` index.js:29）供 status/init/index/meta/path 手工查询与维护。
   - 判态与预构建：`normalizeCwd` 归一化 MSYS 盘符路径（index.js:49-54）→ `excludedItem` 排除清单（index.js:284-293，报错同时返回命中条目）→ worktree 闸门（`detectLinkedWorktree` index.js:309-325，工具侧在跑 `cw status` 之前拦截 index.js:49-59，报错文案含真实 gitDir 与「等合并回主仓库」指引，auto 直调降级返回）→ 空壳目录闸门（`clearSourceProbeCache` index.js:368-371 清缓存 + `hasCompilableSources` index.js:352-366 判定，index.js:3047-3054）→ `cw status` 四态解析（`parseStatus` index.js:213-226，调用点 index.js:49-54）。
   - 短路与幂等：clean 直接报告、scope=full 例外强制全量重编（index.js:3091-3094）；stale 遇无 wiki 自动升全量（index.js:3083-3087）；同仓库已有活动任务幂等返回并把唤醒权移交给最近会话（index.js:3072-3080），发起会话 id 记入 job.sessionId（index.js:3058）。
   - stale 逐篇更新：按旧文 frontmatter 的 source_files 预构建任务直达 articles（`readSourceFiles` index.js:1252-1260 / `parseSourceFiles` index.js:1238-1250 解析旧文清单，任务预构建 index.js:1252-1268），任务 mission 要求以当前代码为准重写过期文章、保留章节结构与 title/type/tags（index.js:1252）；随后符号级过滤：`loadSnapshot` 拿快照（index.js:3121）+ `extractCurrentGraph` 当前图（index.js:3125）→ `filterStaleTasks` 只留真受影响文章（index.js:3130），全部被滤掉时只 `cw meta update` 刷新基线不重写（index.js:1252-1257）。
   - 日常维护入口：`codewiki_update`（`updateToolDefinition` index.js:3200-3252）固定 scope=auto 复用 `generateToolDefinition.execute`（index.js:3242），仅追加「本步收尾、继续下一项」引导 note；scope=full/stale 仍走 `codewiki_generate`。
3. **服务推进（阶段机）**：
   - 项目闸门：`submit`（index.js:2859-2944）按 `parallelLimit` 计算闸门——忙碌项目数达到上限时本任务进 queued、预置任务寄存 `pendingStage`/`pendingTasks`（index.js:2859-2868），排队期间零请求；`tick` 每轮先算 `activeIds`（index.js:2785-2790），轮到 queued 任务时落地预置并 note（index.js:2859-2868）；取消不受闸门限制（index.js:2859-2869）。
   - 阶段收割统一入口 `settleJob`（index.js:1835-1865）：执行器在跑返回 null；执行器丢失（宿主重启）时按 agentic 任务标记（index.js:1835-1841）或 `batchPrompt` 快照（index.js:1835-1842）整批重跑本阶段。
   - 写盘闸门：`writeValidated`（index.js:1870-1886）校验 frontmatter 后经 `fixAnchors`（index.js:568-651）确定性修正行号锚点才落盘；`tally`（index.js:1897-1928）记账——0.13.2 起语义收窄为两开关：`replace=true`（校对阶段同名覆盖）与 `mergeByName=true`（文章/观察/合成的重跑路径同名合并），曾成功的条目不被后续失败抹掉（index.js:1870-1888）。
   - 会话通道兜底：`dispatchSessionTasks`（index.js:2141-2175）写任务文件 + steer 发起会话（文本由 `buildSessionSteerText` index.js:1467-1485 生成，`sessionTier` 非空时钉死档位），`progressSessionTasks`（index.js:2179-2198）每 tick 按 `classifySessionTask`（index.js:1450-1460）三态收割（harvest/timeout/wait），宿主重启后 `resendSessionSteer`（index.js:2202-2215）重发一次。
   - 会话内容记录：并发池每请求经 `beginSessionRecord`（index.js:1402-1444）把 prompt/输出落盘到 `SESSIONS_DIR`（index.js:1311，保留 `SESSION_TTL_MS` 24h index.js:1310），全局聚合 `listAllSessionRecords`（index.js:1348-1368），tick 内每 10 分钟 `pruneSessionRecords` 清理（index.js:1402-1405）。
4. **文章写作（articles 阶段）**：
   - 就地规划：全量编译在 articles 开头扫描并生成模块清单（index.js:862-869）——`planMode=dirs` 走 `localPlan`，否则 `semanticPlan`、失败记 note 退回目录分组（`buildPlan` index.js:2074-2097）；模块名 slug 保留 CJK（`slugify` index.js:1232-1234）。
   - agentic 通道（默认）：`tickArticles`（index.js:2223-2415）在 `agenticArticles` 开启时组装带 `agentic: true` 标记的任务（index.js:2223-2228），先按模块源文本量给超大模块打大档标记再交双池执行器（`markBigAgenticTasks` 调用 index.js:2362-2373）跑 `startAgenticRun`（调用 index.js:2383，启动 note index.js:2223）——模型现场读源码多轮写作，任务没有 `batchPrompt` 快照，宿主重启按任务本身重跑（index.js:2223-2229）；0.13.1 起模型可在写作中调 `generate_sub_module` 递归派子模块成文（README.md:39）；失败严格过半时经 `shouldFallBackHere` 退回单轮通道重跑失败篇（index.js:2288-2326，置 `job.agenticRetried` index.js:2308）。
   - 单轮整包通道（旧通道 / agentic 关闭或退回）：`prepareArticleTasks`（index.js:727-812）按 token 预算装填（`collectSources` index.js:656-683、`estimateTokens` index.js:394-402、行号前缀 `numberLines` index.js:557-559）——110k 内普通档（`batchArticlePrompt` index.js:687-714）、110k–大档预算升大档单请求（`markBig` index.js:739-747，硬上限 `BATCH_TOKEN_HARD_LIMIT`=128k index.js:546）、超大档预算拆观察批（`batchArticleObservePrompt` index.js:1053-1069）+ 合成（`batchArticleComposePrompt` index.js:1073-1101）、单文件连大档都装不下转会话通道（index.js:727-732）。
   - 提交与并发：`submitBatchFor`（index.js:2099-2133）持久化任务快照（`bigTier` 标记必须随任务落盘 index.js:2099-2102，重启重跑才不会掉回默认档池）后由 `startBatchChatRun`（index.js:1976-2018）驱动 `runRealtimeTasks` 两池并发；启动 note 写明模型与两档并发（index.js:2123-2131）。
5. **横切与校对（crosscut/compose/review 阶段）**：
   - 横切：`tickCrosscut`（index.js:2439-2522）以成功模块文章全文为输入（读取 index.js:2439-2444，`packArticles` index.js:971-990 装不下截头部并标注）——总量 ≤ 大档预算单批直出 `_architecture`/`_patterns`/概念文章（index.js:2439-2457，任务构造 `crosscutTasks` index.js:2418-2437，模板 index.js:2439-2461），超预算拆每篇一个观察任务（`batchObservePrompt` index.js:1032-1049）进 compose 合成（`tickCompose` index.js:2525-2537 / `submitComposeBatch` index.js:2539-2549）。
   - 校对：`tickReview`（index.js:2574-2685）先 `localReview`（index.js:2552-2572）本地核对 frontmatter 与 source_files 存在性，再逐篇准备（文章+源码，单篇源码连大档都装不下转会话通道 index.js:2574-2591）后按 110k 贪心合并成批量校对请求（`batchProofreadBatchPrompt` index.js:1128-1155，合并循环 index.js:2574-2594），输出按 `@@@article:`/`
