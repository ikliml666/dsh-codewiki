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
  - test-prune-orphans.mjs
  - test-sessions.mjs
  - test-worktree.mjs
  - test-out.log
  - index.js
  - client.js
  - lib/symbols.js
  - lib/cluster.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/change-set.js
  - lib/update-planner.js
  - lib/article-contract.js
  - lib/update-record.js
  - cordis.patch.yml
  - package.json
  - .gitignore
  - watcher.log
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

（占位：Overview 第 1 段，稍后重写）

（占位：Overview 第 2 段，稍后重写）

整体数据通路：

```text
┌──────────────────────────────────┐
│ 模型调用 codewiki_generate        │ 提交制，工具路径零 LLM
│ generateToolDefinition（index.js）│ cw status 判态/排除/闸门/预构建
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
│ (lib/…)  │  │ (双池:default/big)│
└────┬─────┘  └─────────┬─────────┘
      └────────┬─────────┘
               ▼
┌──────────────────────────────────┐
│ llmChat → 宿主 llm.stream         │
│ 默认档 hy3 ／ 大档 glm-5.3-flash  │
│ 连大档都装不下 → 会话通道兜底      │
└──────────────────────────────────┘
```

0.13.0 吸入了 FSoft-AI4Code/CodeWiki（MIT，ACL 2026）的三层能力，默认全开、任一环节不可用自动降级（README.md:88-103、CHANGELOG.md:135-161）：①模块划分 `planMode` 默认 auto 走 `semanticPlan`——tree-sitter AST 符号提取（`extractRepoGraph`，从 lib/symbols.js 导入）+ LLM 语义聚类（`clusterComponents`，从 lib/cluster.js 导入），失败退回 `localPlan` 顶层目录分组；②文章写作 `agenticArticles` 默认开走 agentic 工具循环——`startAgenticRun` 调 `runAgenticArticles`（lib/articles-agentic.js），模型自己读源码/列文件/增量改写多轮写作（单篇步数上限 `agenticMaxSteps`，唯一定义 `DEFAULT_MAX_STEPS` 在 lib/agentic.js），不再把源码整包内联进 prompt，因而没有「超预算拆观察批」一整套；0.13.1 起模型还可在写作中调 `generate_sub_module` 递归派出子模块成文（`subDepth` 默认封顶 2 层、子模块名全局去重、失败只记账不拖垮父文章，README.md:88、CHANGELOG.md:189-195）；本批失败严格过半时经 `shouldFallBackFromAgentic` + `shouldFallBackHere` 退回单轮通道重跑失败篇（`job.agenticRetried` 只退一次）、只重排失败篇（CHANGELOG.md:189）；③增量判定 `symbolIncremental` 默认开——stale 流程拿上次编译的符号快照与 `extractCurrentGraph` 的当前符号图做组件级比对（`filterStaleTasks`，从 lib/incremental.js 导入），纯注释/空白/格式化改动直接跳过重写（0.13.2 起按 `codeHash`=剥离注释后的哈希判定，lib/graph-diff.js），快照由 `tickIndex` 写入 `.codewiki/temp/symbol-graph.json`（`saveSnapshot`）。

0.13.2–0.13.7 的其余整改：`subDepth` 递归封顶真生效（递归传 `onSubModule: null` 让子层按自己的 `_depth` 重建判定，lib/articles-agentic.js）、symbols 补正则降级 `REGEX_RULES`+`regexExtract`（lib/symbols.js）、cluster 下钻真递归（lib/cluster.js）、agentic 通道接双池（`markBigAgenticTasks`，lib/articles-agentic.js 导出、index.js 侧打标）、`tally` 去重语义收窄为 `replace`/`mergeByName` 两开关（CHANGELOG.md:137）、`plan.graph` 不再携带全量源码（CHANGELOG.md:139）、0.13.3 修复首次真实运行暴露的三个缺陷——`read_code` 重复读抑制（`makeReadCodeTool` 记账、去重判定在读盘之前，lib/agentic.js）、`toRequestMessages` 的 MessageId 身份稳定（模块级 WeakMap 缓存，lib/agentic-host.js，CHANGELOG.md:109）、`parseToolArgs` 三级递进剥 JSON 围栏（CHANGELOG.md:106-113）、0.13.4 补齐工具层四个真实翻车点——`str_replace`/`insert` 按行尾归一化匹配（含 `insert` 拒绝负行号）、子模块到嵌套上限时明确报错不再谎称已记录、`read_code` 加 40000 字符上限、`list_files` 隐藏 `node_modules`/`.git` 等依赖目录（CHANGELOG.md:87-96）、`fixAnchors` 锚点就近归属与 CHANGELOG 版本节重定位（CHANGELOG.md:71、CHANGELOG.md:113）、孤儿文章清理 `pruneOrphanModules`（CHANGELOG.md:69）；0.13.7 给锚点测试补「编译基线版」第三基准，消除提交前后的结果跳变（CHANGELOG.md:106-113）。AST 依赖 vendor/tree-sitter（web-tree-sitter + tree-sitter-wasms，56MB 独立子根，不污染宿主注入的插件根 node_modules，README.md:90），未安装时三层全部自动降级、编译不中断。

0.14.0 补上「增量不丢、结果诚实、坏文章不入库」三层质量保证（README.md:36-81、CHANGELOG.md:10-14）：变更采集不再只看提交——lib/change-set.js 的 `collectChangeSet()` 一次采集已提交/已暂存/未暂存/未跟踪四路变更并识别删除与改名，`.codewiki/` 自身产物不计入源码变更，基线不可达时明确退回全量并记原因（README.md:64-66）；增量规划由 lib/update-planner.js 的 `planUpdate()` 统一负责——反向依赖闭包、新文件按最长公共目录 ownership、未重写页 stale scan、每篇 `write`/`keep`/`review` 带可机读原因（README.md:42-49）；终态新增 `partial`——有必需文章缺失/失败、有未映射变更或质量闸门拦下文章时终态即 `partial`（附 `blockers`），不执行 `meta update`、不推进基线，只有完整成功才 `done`（README.md:51-60）；lib/article-contract.js 的 `inspectArticle()` 文章契约闸门接在所有写盘点上，`error` 级问题一律不落盘，agentic 通道另有 write-set 闸门（README.md:72-82）；每次编译写 `.codewiki/temp/update-record.json`（lib/update-record.js，README.md:60）。

版本演进要点：0.12.2 编译并发拆两档独立设置（CHANGELOG.md:201-221）、0.12.1 统一无效编译对象判定（CHANGELOG.md:223-243）、0.12.0 全局会话 Tab + worktree 闸门（CHANGELOG.md:245-254）、0.11.0–0.11.2 并行推进/排队可见性/会话记录与思考档位修复（CHANGELOG.md:256-284）、0.10.9–0.10.11 自动提交三步走（CHANGELOG.md:286-330）、0.10.7 删独立规划阶段（CHANGELOG.md:346-355）。

本概念横跨文档说明、核心实现、流水线库、测试验证与运行日志五大模块。

## Involved Modules

- **docs-and-meta**：README.md（提供四工具表 README.md:9-16、`codewiki_generate` 关键行为 README.md:19-26、增量与质量保证（0.14.0）README.md:28-73、三层编译流水线与降级矩阵 README.md:75-90、全部设置项 README.md:92-113、本地 file:/// 安装 README.md:115-130、开发与验证 README.md:132-155）；CodeWiki.md（插件自身仓库的 wiki 入口声明 CodeWiki.md:3，Overview CodeWiki.md:5-7、Key Components CodeWiki.md:9-31、架构图 CodeWiki.md:33-57、Data Flow CodeWiki.md:59-61、Connections CodeWiki.md:63-66、Known Issues CodeWiki.md:68-75，重启 dsh 后可用 `codewiki_generate` 对本仓库重编）；CHANGELOG.md（0.1.0 → 0.14.0 全部行为变更，最新一节 0.14.0 在 CHANGELOG.md:3-15）。
- **core-and-config**（插件双半侧实现）：
  - `index.js`（宿主半侧，单文件 Node ESM）：`Config` 全部 `.volatile()` 设置与热读 `liveConfig`、四工具 `cwToolDefinition`/`generateToolDefinition`/`updateToolDefinition`/`progressToolDefinition`、编排服务 `createJobService`（内含阶段机 `STAGE_HANDLER` 与各 `tick*` 处理器）、prompt 模板组（`articleFormatSection`，文章/观察/合成/校对模板）、本地与语义规划（`localPlan`、`semanticPlan`）、仓库扫描 `scanRepoFiles`（黑名单与上限）、面板端点 `installWebServer`（jobs/repos/sessions/sessions/item/models/model-efforts/control 七个精确端点，全部仅回环放行）、自动提交 `autoCommitWiki`、入口 `apply`。
  - `client.js`（浏览器半侧）：插件页设置卡、模型三件套渲染、思考档位拉取、保存与校验、总览页、会话视图、侧边栏面板、阶段步骤条、加权总进度、面板图标等（详见本 wiki 的 [[client-interface]] 模块文章）。
  - 中英词典（值全字符串），0.13.0 新增「编译流程」节词条 `secPipeline` 等。
  - cordis.patch.yml（bundle 形式挂载补丁：设置项注释与 file:/// 直挂条目、配置示例，与 profile patch 条目保持 id 一致）。
  - package.json（版本 0.14.0 package.json:22、`exports["./client"]` package.json:8-11、engines package.json:13-16、`dsh.client.platform` 与 bundle 补丁声明 package.json:20-27）。
  - .gitignore（node_modules/ .gitignore:1、vendor/codewiki/target/ .gitignore:2、`*.log` .gitignore:3、`.probe3.txt` .gitignore:9、`.dsh-ops/` .gitignore:12 等排除条目；`.codewiki/temp/` 不在排除之列——符号快照随 wiki 入库）。
- **pipeline-libs（0.13.0 新增）**：
  - lib/symbols.js：表驱动 `LANG_RULES`（16 种语言的 wasm 名/扩展名/符号节点规则），`SymbolExtractor` 逐文件 `extractFile` 产出组件记录，批量入口 `extractRepoGraph` + 依赖边 `resolveImportEdges`（import 解析 `resolveSpec`）；WASM 不可用/解析零符号时正则兜底 `REGEX_RULES` + `regexExtract`，命中数记 `stats.regex`；依赖装在 `DEFAULT_VENDOR_DIR`（即 vendor/tree-sitter 独立子根，不污染宿主注入的插件根 node_modules）。
  - lib/cluster.js：移植上游 `cluster_modules.py` 的三段式——顶层聚类 `clusterPrompt`、超大模块递归下钻 `subdivide`（递归条件「子模块 ≥ `DEFAULT_SPLIT_THRESHOLD` 且未到 maxDepth」，0.13.2 起真递归）、顶层过多时超级分组 `parseSuperGroups`；主入口 `clusterComponents`，模型不可用/请求失败走 `heuristicCluster`（单顶层目录自动下探第二层）；回复解析 `parseClusterResponse` 校验 id 与去重；`toPlanModules` 转成 articles 阶段吃的 `{name, summary, files}`。
  - lib/agentic.js：工具循环纯逻辑。工具表 `TOOL_SCHEMAS`（`read_code`/`list_files`/`edit_article`/`generate_sub_module`），`makeReadCodeTool`（带 `seen` 重复读抑制、2000 行上限、40000 字符上限）、`makeListFilesTool`（隐藏 node_modules 等依赖目录，`IGNORED_DIRS`）、`makeArticleEditor`（`view`/`str_replace`/`insert` 三命令，str_replace 做行尾 CRLF/LF 归一、insert 拒绝负行号）；路径越界防护 `safeRelPath`；循环本体 `runAgenticArticle`（无工具调用即视为写完）；坏参数抢救 `parseToolArgs`（原样 → 剥围栏 `stripJsonFence` / 截首个括号平衡对象 `sliceBalancedObject` 三级递进）；开场提示词 `buildOpeningPrompt`（仅在 `generate_sub_module` 真在工具表里时才追加拆分指引）。
  - lib/agentic-host.js：裸消息 ↔ 宿主 llm 协议适配。`toRequestMessages` 把工具循环的裸消息转成宿主要求的正式 Message，模块级 `IDENTITY` WeakMap 缓存已构造消息保证 MessageId 跨步稳定（0.13.3 修复，CHANGELOG.md:109）；`makeHostStream`（BlockAssembler 收块、signal 透传）与 `makeFsWorkspace`（读文件/列目录 + 真实路径越界兜底）。
  - lib/articles-agentic.js：job 生命周期接线。`runOneArticle`（旧文作初始内容交给 editor 增量改、空文章算失败不落盘、`generate_sub_module` 就地递归派子模块到 `<wiki>/modules/<父>/<子>.md`、递归传 `onSubModule: null` 保证 `subDepth` 封顶逐层生效）、`runAgenticArticles` 双池并发池，与单轮通道同形状返回 Map；`sourceTokensOf`（与 `estimateTokens` 同口径）+ `markBigAgenticTasks`（模块源文本量超 `bigTokenBudget` 才打 `bigTier` 标）+ `resolveTaskRoute`（大档任务 effort 不回落默认档）。
  - lib/graph-diff.js：逐位移植上游 `updater/graph_diff.py`（78 条 golden 对拍，CHANGELOG.md:126）。`diffGraphs` 产出六类变更集（`CLASS_IFACE`/`CLASS_BODY`/`CLASS_EDGE`/`CLASS_ADDED`/`CLASS_DELETED`/`CLASS_RENAMED`），改名配对按 token 序列 difflib 相似度（`sequenceRatio`、`bodySimilarity`）贪心最佳匹配（`pairRenames`）；哈希判定用 `bodyHash`（含文档注释）与 `codeHash`（0.13.2 起剥离注释——`stripComments`，行首认五种注释符、行尾只认 `//` 与 `#` 以免吃掉 `a--`/`50%2` 这类真代码）。
  - lib/incremental.js：快照存取（`SNAPSHOT_REL` 即 `temp/symbol-graph.json`，`SNAPSHOT_VERSION`；`slimGraph` 固化 `bodyHash`/`codeHash` 不存源码、`loadSnapshot` 版本不符当没有、`saveSnapshot`）、文件级→组件级折算与文章过滤 `filterStaleTasks`（0.13.2 起「`bodyHash` 变但 `codeHash` 没变且 docstring 没变」的组件归入 `cosmeticOnly` 不重写，无符号可判的文章保守保留）、变更摘要 `describeChange`。
  - 七库由 index.js 侧导入；`diffGraphs`/`graphFromSnapshot` 等仅被库间与 stale 流程消费。
  - **0.14.0 新增四库**：lib/change-set.js（`collectChangeSet()` 四路变更采集，README.md:36-38）、lib/update-planner.js（`planUpdate()` 增量规划：反向依赖闭包/新文件 ownership/stale scan/`.codewiki/temp/module-map.json`，README.md:42-49）、lib/article-contract.js（`inspectArticle()` 文章契约闸门，README.md:64-74）、lib/update-record.js（`.codewiki/temp/update-record.json` 可机读更新记录，README.md:60）。
- **test-scripts**：自检脚本直接对接真实 index.js 导出——test-orchestration.mjs（服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实服务 tick，tick 压到 300ms；0.13.0 起配置基线以 `LEGACY_CHANNEL` 显式钉住旧通道、继续守护其请求次数与装填时序，新通道由 test-symbols/test-cluster/test-agentic*/test-semantic-plan/test-graphdiff/test-incremental* 守护，CHANGELOG.md:197；`autoCommitWiki` 安全边界块、`autoCommitState` 三态块、`wakeCompileSession` 唤醒块、端到端含独立 commit 阶段断言、单项目串行块、并行项目上限块、全局会话聚合与 worktree 闸门块、空壳目录闸门块）；test-batch.mjs（纯函数与假 llm 执行链：大档接管块、两档分池限流块、0.10.1 无直连反向断言、`fixAnchors` 块、validateArticleEnvelope 14 种边界块 CHANGELOG.md:53）；test-wiki-entry.mjs（CodeWiki.md 入口生成与 Windows 路径规范化，导入真实导出）、test-wiki-anchors.mjs（403 行，行号锚点守卫：结构事实永远硬断言、符号绑定按新鲜度分三基准——工作区 ∪ HEAD ∪ 编译基线，规则 test-wiki-anchors.mjs:7-31、分句内符号绑定 test-wiki-anchors.mjs:335-392、CHANGELOG 版本节校验 test-wiki-anchors.mjs:312-334、汇总 test-wiki-anchors.mjs:396-403）、test-cwd-paths.mjs（MSYS/Windows/不存在路径三态实测）。
  - 另含 test-prune-orphans.mjs（孤儿模块清理 `pruneOrphanModules` 守护）、test-sessions.mjs（会话内容记录 `listSessionRecords`/`readSessionRecord`/`pruneSessionRecords`/`listAllSessionRecords` 守护）、test-worktree.mjs（worktree 闸门 `detectLinkedWorktree` 守护）等，均直接 `node <file>` 运行（见 README.md:142-150）；0.14.0 另新增 4 套回归测试（CHANGELOG.md:250）。
- **logs-and-temp**：运行期产物，均被 `.gitignore` 的 `*.log` 规则排除——watcher.log / watcher2.log（多实例 jobs 文件冲突与轮询排查留档）、test-out.log（测试执行输出）。旧探针 `.probe3.txt` 已不在仓库中（`.gitignore` 仍保留其排除条目，.gitignore:9），历史 `.tmp-test-*.log` 由 `*.log` 规则覆盖。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:19-26（提交制、scope=auto/full/stale 语义、两档并发、单项目串行、单篇失败只记账不中断、有失败/未映射变更/质量拦截即终态 `partial` 不刷新基线）；0.13.0 三层能力与各层降级行为全文见 README.md:75-90 与 CHANGELOG.md:11-37；0.14.0 质量保证见 README.md:28-73 与 CHANGELOG.md:3-15。
   - 设置项与默认值：`Config`——编译模型三项（`batchProvider` 默认 workbuddy、`batchModel` 默认 hy3、`batchReasoningEffort` 留空=模型默认档）、大档五项（`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`，大档并发 `bigConcurrency` 默认 0=跟随默认档）、`sessionTier`、`maxConcurrency` 默认 2 硬顶 8（常量 `DEFAULT_CONCURRENCY`/`CONCURRENCY_HARD_CAP`）、`serialProjects` 默认开、`parallelProjects` 默认 2 上限 4、0.13.0 新增四项（`planMode` 默认 auto、`agenticArticles` 默认开、`agenticMaxSteps` 默认 30、`symbolIncremental` 默认开）、`autoCommit` 默认开、`updateReminder` 默认开；全部 `.volatile()` 改完即生效（README.md:111）。
   - 配置链路：设置卡 `save` 依次校验两档并发（`maxConcurrency` 与 `bigConcurrency`，0=跟随）、agentic 步数 1–100（`agenticMaxSteps`）与 `planMode` 白名单，再按保存键白名单经 `form.mutate` 单层 op + revision CAS 保存，与 patch 文件手改等价、同样热生效（README.md:94）；「编译流程（吸收自 FSoft CodeWiki）」设置节含 `planMode` 下拉、`agenticArticles`/`symbolIncremental` 开关与步数输入，其中英词条为 0.13.0 新增（CHANGELOG.md:195）；provider/model 目录来自 /api/codewiki/models（`listModelCatalog`），思考档位来自 /api/codewiki/model-efforts（`resolveModelEfforts`，宿主方法适配 `resolveModelInfoOf`），普通档与大档共用渲染件 `modelTrio` 与档位拉取 `useEfforts`，目录未声明档位时设置页给通用档位下拉（`GENERIC_EFFORTS`，0.11.2）。
   - 插件接线：`apply` 注入 `agentsRef`/`llmRef`、创建并启动常驻服务（effect 清理写法防「启动即停服务」）、注册四工具（单工具 schema 违规只丢该工具、不炸回调）、挂面板端点与系统提示提醒；自动更新调度 `autoScan` 每 60s 心跳、到点对历史工作区逐仓 scope=auto 判态提交；`liveConfig` 在每次 execute/tick 热读配置。
   - 自举：`CodeWiki.md` 是插件自身仓库的 wiki 入口，声明重启 dsh 后可用 `codewiki_generate` 对本仓库重编（CodeWiki.md:3）；入口缺失时由 `ensureWikiEntry` 在 index 阶段自动补建，已有入口绝不覆盖。
2. **任务提交**：
   - CLI 薄封装：`cw` 工具（`cwToolDefinition`，子命令白名单 `CW_SUBCOMMANDS`）供 status/init/index/meta/path 手工查询与维护。
   - 判态与预构建：`normalizeCwd` 归一化 MSYS 盘符路径 → `excludedItem` 排除清单（报错同时返回命中条目）→ worktree 闸门（`detectLinkedWorktree`，工具侧在跑 `cw status` 之前拦截，报错文案含真实 gitDir 与「等合并回主仓库」指引，auto 直调降级返回）→ 空壳目录闸门（`clearSourceProbeCache` 清缓存 + `hasCompilableSources` 判定）→ `cw status` 四态解析（`parseStatus`）。
   - 短路与幂等：clean 直接报告、scope=full 例外强制全量重编；stale 遇无 wiki 自动升全量；同仓库已有活动任务幂等返回并把唤醒权移交给最近会话，发起会话 id 记入 job.sessionId。
   - stale 逐篇更新：按旧文 frontmatter 的 source_files 预构建任务直达 articles（`readSourceFiles`/`parseSourceFiles` 解析旧文清单），任务 mission 要求以当前代码为准重写过期文章、保留章节结构与 title/type/tags；随后符号级过滤：`loadSnapshot` 拿快照 + `extractCurrentGraph` 出当前符号图 → `filterStaleTasks` 只留真受影响文章，全部被滤掉时只 `cw meta update` 刷新基线不重写；0.14.0 起该增量判定由 lib/update-planner.js 的 `planUpdate()` 统一负责（反向依赖闭包 + 新文件 ownership + 未重写页 stale scan），`scope=stale` 与 `scope=auto` 走同一套规划（README.md:42-49、README.md:110）。
   - 日常维护入口：`codewiki_update`（`updateToolDefinition`）固定 scope=auto 复用 `generateToolDefinition.execute`，仅追加「本步收尾、继续下一项」引导 note；scope=full/stale 仍走 `codewiki_generate`。
3. **服务推进（阶段机）**：
   - 项目闸门：`submit` 按 `parallelLimit` 计算闸门——忙碌项目数达到上限时本任务进 queued、预置任务寄存 `pendingStage`/`pendingTasks`，排队期间零请求；`tick` 每轮先算 `activeIds`，轮到 queued 任务时落地预置并 note；取消不受闸门限制。
   - 阶段收割统一入口 `settleJob`：执行器在跑返回 null；执行器丢失（宿主重启）时按 agentic 任务标记或 `batchPrompt` 快照整批重跑本阶段。
   - 写盘闸门：`writeValidated` 校验 frontmatter 后经 `fixAnchors` 确定性修正行号锚点才落盘；0.14.0 起所有写盘点统一过文章契约闸门 `inspectArticle()`（frontmatter 唯一闭合、必填字段、`type` 与目录一致、`source_files` 真实存在、内部链接有效、无重复章节/正文块；`error` 级不落盘，`warning` 级放行记账，README.md:72-82）；`tally` 记账——0.13.2 起语义收窄为两开关：`replace=true`（校对阶段同名覆盖）与 `mergeByName=true`（文章/观察/合成的重跑路径同名合并），曾成功的条目不被后续失败抹掉。
   - 会话通道兜底：`dispatchSessionTasks` 写任务文件 + steer 发起会话（文本由 `buildSessionSteerText` 生成，`sessionTier` 非空时钉死档位），`progressSessionTasks` 每 tick 按 `classifySessionTask` 三态收割（harvest/timeout/wait），宿主重启后 `resendSessionSteer` 重发一次。
   - 会话内容记录：并发池每请求经 `beginSessionRecord` 把 prompt/输出落盘到 `SESSIONS_DIR`（保留 `SESSION_TTL_MS` 24h），全局聚合 `listAllSessionRecords`，tick 内每 10 分钟 `pruneSessionRecords` 清理。
4. **文章写作（articles 阶段）**：
   - 就地规划：全量编译在 articles 开头扫描并生成模块清单——`planMode=dirs` 走 `localPlan`，否则 `semanticPlan`、失败记 note 退回目录分组（`buildPlan`）；模块名 slug 保留 CJK（`slugify`）。
   - agentic 通道（默认）：`tickArticles` 在 `agenticArticles` 开启时组装带 `agentic: true` 标记的任务，先按模块源文本量给超大模块打大档标记再交双池执行器（`markBigAgenticTasks`）跑 `startAgenticRun`——模型现场读源码多轮写作，任务没有 `batchPrompt` 快照，宿主重启按任务本身重跑；0.13.1 起模型可在写作中调 `generate_sub_module` 递归派子模块成文（README.md:88）；失败严格过半时经 `shouldFallBackHere` 退回单轮通道重跑失败篇（置 `job.agenticRetried`，只退一次）。0.14.0 起 agentic 通道另有 write-set 闸门：父任务只能写自己那一篇、子模块只能写调度器分配的那条路径，越界返回 `stopReason='write-set'` 且不落盘（README.md:72）。
   - 单轮整包通道（旧通道 / agentic 关闭或退回）：`prepareArticleTasks` 按 token 预算装填（`collectSources`、`estimateTokens`、行号前缀 `numberLines`）——110k 内普通档（`batchArticlePrompt`）、110k–大档预算升大档单请求（`markBig`，硬上限 `BATCH_TOKEN_HARD_LIMIT`=128k）、超大档预算拆观察批（`batchArticleObservePrompt`）+ 合成（`batchArticleComposePrompt`）、单文件连大档都装不下转会话通道。
   - 提交与并发：`submitBatchFor` 持久化任务快照（`bigTier` 标记必须随任务落盘，重启重跑才不会掉回默认档池）后由 `startBatchChatRun` 驱动 `runRealtimeTasks` 两池并发；启动 note 写明模型与两档并发。
5. **横切与校对（crosscut/compose/review 阶段）**：
   - 横切：`tickCrosscut` 以成功模块文章全文为输入（`packArticles` 装不下截头部并标注）——总量 ≤ 大档预算单批直出 `_architecture`/`_patterns`/概念文章，超预算拆每篇一个观察任务（`batchObservePrompt`）进 compose 合成（`tickCompose`/`submitComposeBatch`）。
   - 校对：`tickReview` 先 `localReview` 本地核对 frontmatter 与 source_files 存在性，再逐篇准备（文章+源码，单篇源码连大档都装不下转会话通道）后按 110k 贪心合并成批量校对请求（`batchProofreadBatchPrompt`），输出按 `@@@article:`/`
