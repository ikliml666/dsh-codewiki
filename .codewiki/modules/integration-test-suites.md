---
title: Integration Test Suites
type: module
source_files:
  - test-agentic.mjs
  - test-agentic-fallback.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
  - test-batch.mjs
  - test-cluster.mjs
  - test-cwd-paths.mjs
  - test-graphdiff.mjs
  - test-incremental-e2e.mjs
  - test-incremental.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-semantic-plan.mjs
  - test-sessions.mjs
  - test-symbols.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
  - test-fixtures/gen-graphdiff-golden.py
tags: [testing, integration, e2e, regression]
---

## Overview

`modules/integration-test-suites.md` 以当前源码为准，罗列仓库根目录下全部 18 个 `test-*.mjs` 集成/端到端测试文件，外加 `test-fixtures/gen-graphdiff-golden.py` 基准生成脚本。这些文件不是单元隔离测试，而是把插件真实跑起来（真实文件系统、真实 `cw` CLI、真实 git 命令、真实服务 tick），用注入的假 `streamFn` / 假宿主 `llm` 服务 / 桩模型模拟 LLM 行为，全程离线、零密钥、零外部网络。它们守护的是**整条流水线**而不是单个函数：编译执行链、agentic 工具循环、语义聚类、符号级增量、会话记录、worktree 闸门、行号锚点、插件自动提交等。

每个 `test-*.mjs` 顶部都用一段注释声明它覆盖的能力，并给出运行方式（多为 `node test-xxx.mjs`，个别需传参或 `--strict`）。多数文件自带一个 `check(cond, msg)` / `await check(label, fn)` 风格的微型断言框架，结尾打印通过/失败计数并 `process.exit(fails.length ? 1 : 0)`，因此可挂进 CI 直接当门禁。

测试分三类：

- **纯函数 + mock llm 自测**：`test-batch.mjs`、`test-cluster.mjs`、`test-agentic*.mjs`、`test-articles-agentic.mjs`、`test-incremental*.mjs`、`test-symbols.mjs`、`test-graphdiff.mjs`——全部用注入的假 streamFn / 桩模型，完全离线，适合快速回归。
- **服务化编排冒烟**：`test-orchestration.mjs`、`test-sessions.mjs`、`test-prune-orphans.mjs`、`test-wiki-entry.mjs`、`test-worktree.mjs`、`test-cwd-paths.mjs`——真正注册插件、起服务 tick、跑真实 `cw` CLI 与 git，验证阶段机、面板端点、提交/清理/路径边界。其中 `test-orchestration.mjs` 体量最大（1500+ 行），且为守护旧单轮通道，基线显式关闭了 `planMode: 'dirs' / agenticArticles: false / symbolIncremental: false`（`test-orchestration.mjs:44`）。
- **产物质量门禁**：`test-wiki-anchors.mjs`——读真实 `.codewiki/` 落盘文章，对行号锚点做新鲜度感知的结构/同步双档校验；它依赖一次真实编译产物存在，属于「编译后跑一遍」的检查。

## Key Components

下面逐文件列出它的职责、覆盖的被测导出（来自 `index.js` / `lib/*.js`）、关键用例与行号。行号指向 `.mjs` 文件里的 `await check(...)` / `check(...)` 调用与关键桩逻辑。

### test-agentic.mjs — agentic 工具循环（lib/agentic.js 自测）
- 被测导出：`runAgenticArticle, makeArticleEditor, makeReadCodeTool, makeListFilesTool, buildToolset, buildOpeningPrompt, parseToolArgs, safeRelPath, numberLines, TOOL_SCHEMAS`（import 在 `test-agentic.mjs:4`）。
- 基础工具：`numberLines` 行号前缀（`test-agentic.mjs:76`）、`safeRelPath` 越界/绝对路径拒绝（`test-agentic.mjs:80`）。
- `read_code`：`makeReadCodeTool` 带行号全文（`test-agentic.mjs:89`）、行范围（`test-agentic.mjs:98`）、文件不存在 `isError`（`test-agentic.mjs:105`）、缺 path（`test-agentic.mjs:112`）、越界路径（`test-agentic.mjs:117`）、行号越界（`test-agentic.mjs:124`）、超大单行字符上限截断（`test-agentic.mjs:563`）、重复读去重只提示第几步（`test-agentic.mjs:501`）。
- `list_files`：根/子目录列目录（`test-agentic.mjs:131`/`:138`）、空目录说明（`test-agentic.mjs:144`）、隐藏 `node_modules`/`.git`（`test-agentic.mjs:573`）。
- `edit_article`：`makeArticleEditor` 的 `insert`（`test-agentic.mjs:151`/`:157`）、`str_replace` 唯一匹配（`test-agentic.mjs:163`）、多处匹配被拒（`test-agentic.mjs:170`）、未匹配提示（`test-agentic.mjs:178`）、`view` 带行号（`test-agentic.mjs:185`）、行号越界（`test-agentic.mjs:196`）、负数行号报错（`test-agentic.mjs:589`）、CRLF 跨行替换与行尾保真（`test-agentic.mjs:542`/`:550`/`:557`）。
- 循环本体：`runAgenticArticle` 单轮无工具直接收正文（`test-agentic.mjs:210`）、读→写两轮（`test-agentic.mjs:221`）、tool 结果回灌（`test-agentic.mjs:237`）、未知工具回灌不中断（`test-agentic.mjs:276`）、坏 JSON 记警告（`test-agentic.mjs:293`）、工具抛错捕获为 `isError`（`test-agentic.mjs:307`）、`maxSteps`（`test-agentic.mjs:324`）、`stream-error`（`test-agentic.mjs:337`）、空响应（`test-agentic.mjs:347`）、`abort`（`test-agentic.mjs:355`）、`finish` 前文章不被正文覆盖（`test-agentic.mjs:365`）、`generate_sub_module` 走 `onSubModule` 回调（`test-agentic.mjs:380`）、无 `onSubModule` 必须 `isError`（`test-agentic.mjs:401`）、深度到顶报错（`test-agentic.mjs:421`）、工具声明数（4 个，`test-agentic.mjs:438`/`:597`）。
- 提示词：`buildOpeningPrompt` 禁项（`test-agentic.mjs:456`）；`parseToolArgs` 剥 `json` 围栏（`test-agentic.mjs:470`）、截夹在说明里的 JSON（`test-agentic.mjs:477`）、平衡括号（`test-agentic.mjs:482`）、坏 JSON 警告（`test-agentic.mjs:487`）、非对象判坏（`test-agentic.mjs:495`）。

### test-agentic-fallback.mjs — agentic → 单轮通道退回链路
- 被测导出：`shouldFallBackFromAgentic`（来自 `index.js`，`test-agentic-fallback.mjs:13`）、`prepareArticleTasks`（来自 `index.js`）、`runAgenticArticles`（来自 `lib/articles-agentic.js`）。
- 三段退回链路：① `shouldFallBackFromAgentic` 严格过半判定——空/`null`（`test-agentic-fallback.mjs:27`）、全成功（`test-agentic-fallback.mjs:32`）、少数失败（`test-agentic-fallback.mjs:36`）、恰好一半不触发（`test-agentic-fallback.mjs:40`）、过半触发（`test-agentic-fallback.mjs:44`）、全失败（`test-agentic-fallback.mjs:48`）；② 重排任务带 `mission/articlePath` 可被旧通道装填（`test-agentic-fallback.mjs:59`）、缺 mission 容错（`test-agentic-fallback.mjs:75`）、源码缺失退化为可继续空装填（`test-agentic-fallback.mjs:87`）；③ `runAgenticArticles` 分批失败时逐篇可辨（`test-agentic-fallback.mjs:101`）。

### test-agentic-host.mjs — agentic-host 适配层
- 被测导出：`toRequestMessages, makeHostStream, makeFsWorkspace`（来自 `lib/agentic-host.js`，`test-agentic-host.mjs:6`）。
- 裸消息 ↔ 宿主 Message：`toRequestMessages` user/assistant/tool 多结果展开（`test-agentic-host.mjs:18`/`:26`/`:38`）、已带 id 透传（`test-agentic-host.mjs:55`）、未知 role 忽略（`test-agentic-host.mjs:61`）、同批多次转换 MessageId 稳定（`test-agentic-host.mjs:171`）。
- `makeHostStream`：把 chunk 收成 blocks 并透传 tools（`test-agentic-host.mjs:79`）、无 tools 不带 tools 字段（`test-agentic-host.mjs:101`）、`finish=error` 抛错（`test-agentic-host.mjs:114`）、缺 llm 抛错（`test-agentic-host.mjs:124`）、`reasoningEffort` 透传（`test-agentic-host.mjs:128`）。
- FS workspace：`makeFsWorkspace` 读/列目录（`test-agentic-host.mjs:142`/`:147`）、子目录完整路径（`test-agentic-host.mjs:154`）、越界读/列拒绝（`test-agentic-host.mjs:160`/`:165`）。

### test-articles-agentic.mjs — agentic 执行器 + 子模块递归派发
- 被测导出：`runOneArticle, runAgenticArticles, markBigAgenticTasks, sourceTokensOf, resolveTaskRoute`（来自 `lib/articles-agentic.js`，`test-articles-agentic.mjs:7`）。
- 基本写作落盘：`runOneArticle` 写出并落盘（`test-articles-agentic.mjs:48`）。
- 子模块派发：`generate_sub_module` 递归写子文章（`test-articles-agentic.mjs:66`）、重名加父前缀不覆盖（`test-articles-agentic.mjs:100`）、`subDepth=0` 禁用递归（`test-articles-agentic.mjs:126`）。
- `subDepth` 封顶：`subDepth=1` 只一层（`test-articles-agentic.mjs:182`，用 `scanArticleDepths` `test-articles-agentic.mjs:151` 验证目录层数 ≤2、调用次数有界）、`subDepth=2` 允许孙模块（`test-articles-agentic.mjs:201`）。
- 子模块失败记账、父成功（`test-articles-agentic.mjs:217`）；池化汇总 `subModules` 记 note（`test-articles-agentic.mjs:248`）、任务抛错不影响其它（`test-articles-agentic.mjs:272`）。
- 双池与大档：`markBigAgenticTasks` 超预算打大档 provider/model（`test-articles-agentic.mjs:299`，不误改原对象）、大档未配置原样返回（`test-articles-agentic.mjs:315`）、不传 effort 不出该字段（`test-articles-agentic.mjs:322`）；双池跑完各自落盘（`test-articles-agentic.mjs:331`）；`resolveTaskRoute` 任务覆盖默认档、effort 以任务为准（`test-articles-agentic.mjs:349`）、`bigConcurrency=0` 回落 `concurrency`（`test-articles-agentic.mjs:367`）；`sourceTokensOf` CJK 口径（`test-articles-agentic.mjs:389`）。

### test-batch.mjs — 编译执行链纯函数 + mock 宿主 llm 服务
- 被测导出：`collectSources, classifySessionTask, estimateTokens, fixAnchors, numberLines, buildSessionSteerText, prepareArticleTasks, runRealtimeTasks, localPlan, packArticles, scanRepoFiles, listModelCatalog, resolveModelEfforts, installWebServer, validateArticleEnvelope`（来自 `index.js`，`test-batch.mjs:7`）。
- token/装填：`estimateTokens` CJK 与 ASCII 粗算（`test-batch.mjs:25`）、`collectSources` 内联带行号（`test-batch.mjs:32`）、超预算 `oversized`/`skipped`（`test-batch.mjs:41`/`:44`）、`numberLines` 尾换行（`test-batch.mjs:48`）。
- `prepareArticleTasks`：prompt 装配与 `customId`（`test-batch.mjs:54`）、旧文作上下文（`test-batch.mjs:75`）、单文件超 110k 但装得进 128k → 大档单请求（`test-batch.mjs:79`）、单文件连 128k 都装不下 → 会话通道（`test-batch.mjs:83`）、多文件超预算 → 观察批分割（`test-batch.mjs:88`）、大档模型接管超长输入（`test-batch.mjs:109`，`bigTier` 标记）、关大档退回会话通道（`test-batch.mjs:123`）。
- 会话通道：`classifySessionTask` 三态（`test-batch.mjs:135`）、`buildSessionSteerText` 档位钉死（`test-batch.mjs:153`，articles/review/resend 文案）。
- `runRealtimeTasks`：宿主 llm 通道与请求体（`test-batch.mjs:170`，temperature=0、`reasoningEffort` 原样下发）、大档按自带模型分派（`test-batch.mjs:209`）、大档与默认档分池限流（`test-batch.mjs:232`，`bigConcurrency` 独立计数）、tps 采样与取消（`test-batch.mjs:299`）、外部 signal 中止（`test-batch.mjs:311`）、失败记账不中断（`test-batch.mjs:324`/`:393`）。
- 规划/横切/勘探：`localPlan` 顶层分组（`test-batch.mjs:348`）、`packArticles` 头截断（`test-batch.mjs:361`）、`scanRepoFiles` 黑名单（`test-batch.mjs:374`）。
- WebServer/模型目录：`listModelCatalog`（`test-batch.mjs:411`）、`GET /api/codewiki/models`（`test-batch.mjs:435`，回环 200/非回环 403）、`resolveModelEfforts`（`test-batch.mjs:465`）、`GET /api/codewiki/model-efforts`（`test-batch.mjs:496`，参数校验 400）。
- 0.10.1 删除内置百炼直连通道：`resolveBatchApiKey` 不再导出（`test-batch.mjs:521`）。
- `fixAnchors`：错行号修正（`test-batch.mjs:539`）、起点含符号不动（`test-batch.mjs:541`）、符号未找到记 `unresolved`（`test-batch.mjs:542`）、歧义不动（`test-batch.mjs:543`）、区间锚点点位钳制（`test-batch.mjs:547`/`:549`）、倒序区间翻正（`test-batch.mjs:554`/`:556`）、basename 多段/歧义（`test-batch.mjs:558`/`:569`）、一行多锚点各自绑定（`test-batch.mjs:575`/`:590`/`:593`/`:596`）。
- `validateArticleEnvelope`：frontmatter 信封校验各坏形态（`test-batch.mjs:608`）。

### test-cluster.mjs — LLM 聚类三段式 + 全部降级
- 被测导出：`clusterComponents, heuristicCluster, fillMissing, moduleFiles, formatComponents, clusterPrompt, subClusterPrompt, superGroupPrompt, parseJsonLoose, parseClusterResponse, parseSuperGroups, normalizeModuleName, toPlanModules`（来自 `lib/cluster.js`，`test-cluster.mjs:4`）。
- 提示词/JSON 抢救：`clusterPrompt` 含全部 id（`test-cluster.mjs:44`）、`formatComponents` 分组标 artifact（`test-cluster.mjs:51`）、`subClusterPrompt`/`superGroupPrompt`（`test-cluster.mjs:57`）、`parseJsonLoose` 剥围栏/修尾逗号/取废话（`test-cluster.mjs:65`/`:70`/`:75`）。
- 响应解析：`parseClusterResponse` 丢弃不存在 id（`test-cluster.mjs:85`）、去重复分配（`test-cluster.mjs:96`）、缺 modules 返回 null（`test-cluster.mjs:109`）、`normalizeModuleName`（`test-cluster.mjs:113`）。
- 启发式/降级：`heuristicCluster` 顶层目录分组（`test-cluster.mjs:121`）、`fillMissing` 漏组件归属/建 misc（`test-cluster.mjs:130`/`:138`）、`moduleFiles`（`test-cluster.mjs:146`）、无 llm 走目录启发式（`test-cluster.mjs:153`）、空组件集（`test-cluster.mjs:161`）。
- LLM 正常/降级：`clusterComponents` 合法分组成模块（`test-cluster.mjs:168`）、漏组件补齐（`test-cluster.mjs:188`）、抛错降级（`test-cluster.mjs:201`）、垃圾文本降级（`test-cluster.mjs:210`）。
- 下钻：大模块超阈值下钻（`test-cluster.mjs:274`）、只返一个子模块视为不可再分（`test-cluster.mjs:286`）、`maxDepth` 真生效（`test-cluster.mjs:313`/`:329`，用 `makeDeepComponents` `test-cluster.mjs:274` 与 `deepLlm` `test-cluster.mjs:286`）、下钻抛错不中断（`test-cluster.mjs:345`）。
- 超级分组：`parseSuperGroups` 未归类保留顶层（`test-cluster.mjs:389`）、忽略不存在模块名（`test-cluster.mjs:397`）、`toPlanModules` 输出形状（`test-cluster.mjs:405`）。

### test-cwd-paths.mjs — 路径修复（需真实仓库路径入参）
- 直接 `import * as plugin from './index.js'`，注册后调 `cw.execute`。
- 覆盖三种 cwd 形态：MSYS 路径归一化执行（`test-cwd-paths.mjs:34`，`cw path` → `<repo>/.codewiki`）、Windows 路径 `status` 三态（`test-cwd-paths.mjs:48`，不能出现 `No wiki found`）、不存在路径干净报错（`test-cwd-paths.mjs:62`，`/cwd 不存在/`）。
- 用法：`node test-cwd-paths.mjs <真实仓库路径的 Windows 形式>`（默认 `E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin`，`test-cwd-paths.mjs:8`）；依赖真实 `cw` CLI，非离线自测。

### test-graphdiff.mjs — 与 FSoft 上游 Python 原版逐位对拍
- 被测导出：`bodySimilarity, bodyHash, unifiedDiff, diffGraphs, serializeDiff, sequenceRatio, normalizeBody, documentedSource, truncateToTokens`（来自 `lib/graph-diff.js`，`test-graphdiff.mjs:7`）。
- 对拍基准：`test-fixtures/graphdiff-golden.json`（由 `test-fixtures/gen-graphdiff-golden.py` 生成，`test-graphdiff.mjs:13`）：`similarity`/`hash`/`unified` 三类用例逐位一致（`test-graphdiff.mjs:28`）。
- 组件级 diff：改名配对、interface/body/edge 分类（`test-graphdiff.mjs:83`：`diffGraphs` 旧/新图，如 `oldG`/`newG` 定义于 `test-graphdiff.mjs:68`/`:75`）、`serializeDiff` 字段齐全（`test-graphdiff.mjs:84`）。

### test-incremental.mjs — 符号级增量纯函数
- 被测导出：`slimGraph, graphFromSnapshot, snapshotPath, loadSnapshot, saveSnapshot, filterStaleTasks, describeChange, normRel, componentsByFile, SNAPSHOT_VERSION, sameSnapshotContent`（来自 `lib/incremental.js`，`test-incremental.mjs:7`）、`extractRepoGraph`（来自 `lib/symbols.js`）、`bodyHash, stripComments`（来自 `lib/graph-diff.js`）。
- 快照：`slimGraph` 不带源码但带 `bodyHash`（`test-incremental.mjs:31`，`version === SNAPSHOT_VERSION`）、往返一致（`test-incremental.mjs:42`）、落盘回读（`test-incremental.mjs:193`）、版本不符/坏 JSON 退化全量（`test-incremental.mjs:206`）。
- 变更折算：`filterStaleTasks` 只改注释降级为 `body`（`test-incremental.mjs:49`）、签名变更 `interface`（`test-incremental.mjs:61`）、纯注释降级不重写（`test-incremental.mjs:77`，`cosmeticOnly`）、改代码必须重写（`test-incremental.mjs:90`）、改签名+注释 `interface` 优先（`test-incremental.mjs:99`）、老快照无 `codeHash` 退回保守（`test-incremental.mjs:109`）、`stripComments`（`test-incremental.mjs:120`）。
- 保留/跳过：文件变但符号没变跳过（`test-incremental.mjs:128`）、新增 `added`（`test-incremental.mjs:142`）、删除 `deleted`（`test-incremental.mjs:152`）、配置无符号保守 `symbolFallback`（`test-incremental.mjs:160`）、路径归一（`test-incremental.mjs:169`）、多源任一变动即保留（`test-incremental.mjs:178`）、`componentsByFile`（`test-incremental.mjs:186`）、改名归 `renamed`（`test-incremental.mjs:216`）、`sameSnapshotContent` 忽略 `generatedAt/commit`（`test-incremental.mjs:227`）。

### test-incremental-e2e.mjs — 符号级判定链路端到端
- 被测导出：`extractCurrentGraph, currentCommit`（来自 `index.js`）、`slimGraph, loadSnapshot, saveSnapshot, filterStaleTasks, describeChange`（来自 `lib/incremental.js`）。
- 真实目录：`extractCurrentGraph` 提取当前符号图（`test-incremental-e2e.mjs:61`）、快照落盘 `.codewiki/temp/symbol-graph.json`（`test-incremental-e2e.mjs:52`）、只改函数体实现 → 重写记 `body`（`test-incremental-e2e.mjs:61`）、只改空白/注释全跳过（`test-incremental-e2e.mjs:78`）、签名加参数 `interface`（`test-incremental-e2e.mjs:97`）、新增文件必写（`test-incremental-e2e.mjs:112`）、删文件 `deleted`（`test-incremental-e2e.mjs:125`）、无 `.codewiki` 目录 `loadSnapshot` 返回 `null`（`test-incremental-e2e.mjs:139`）。

### test-orchestration.mjs — dsh-codewiki 服务化编排冒烟（最大文件）
- 被测导出：`name, apply, SESSIONS_DIR, commitHintText, autoCommitWiki, autoCommitState, wakeCompileSession`（动态 `import`，如 `test-orchestration.mjs:24`/`:304`/`:415`/`:518`/`:530`）。
- 运行：`node test-orchestration.mjs`，tick 间隔压到 300ms（`test-orchestration.mjs:32`），独立 `JOBS_FILE` 防互相洗写（`test-orchestration.mjs:22`）。基线 `LEGACY_CHANNEL = { planMode:'dirs', agenticArticles:false, symbolIncremental:false }`（`test-orchestration.mjs:44`）守护旧单轮通道。
- 覆盖：系统提示 wiki 维护提醒（`test-orchestration.mjs:242`）、注册与 `cw` 工具（`test-orchestration.mjs:272`）、`codewiki_update` scope 强制 auto + commitHint（`test-orchestration.mjs:292`，`commitHintText` 多分支：待提交/已提交静默/自动提交失败原因/`writtenCount=0` 静默/`test-orchestration.mjs:319` 起）、`autoCommitWiki` 安全边界（`test-orchestration.mjs:412`：分支合并式、非 git/`.gitignore`/merge 进行中/缺 identity/detached HEAD/主题分支占用降级）、`autoCommitState` 三态（`test-orchestration.mjs:516`）、`wakeCompileSession` 终态唤醒（`test-orchestration.mjs:527`，自动提交成功零唤醒、noChanges 零唤醒、失败降级提醒、冷会话/异常静默）、本地规划零独立规划请求（`test-orchestration.mjs:565`）、全量编译阶段机（`test-orchestration.mjs:624`，articles→crosscut→review→index→commit，自动提交产物）、大 wiki 横切精准拆分（`test-orchestration.mjs:667`）等。文件共 1530 行，其余段落在超大/并发/取消/面板端点等场景继续展开。

### test-prune-orphans.mjs — pruneOrphanModules 安全边界（会删文件）
- 被测导出：`pruneOrphanModules`（来自 `index.js`，`test-prune-orphans.mjs:10`）。
- 全量编译删孤儿保留规划内（`test-prune-orphans.mjs:33`）、失败文章保留（`test-prune-orphans.mjs:44`）、增量 `kind=stale` 一律不动（`test-prune-orphans.mjs:57`）、无 `plan.modules` 不删（`test-prune-orphans.mjs:70`）、空清单不删（`test-prune-orphans.mjs:79`）、`concepts/` 与 `_architecture.md` 永不碰（`test-prune-orphans.mjs:87`）、目录不存在安全返回（`test-prune-orphans.mjs:98`）、只删 `.md`（`test-prune-orphans.mjs:104`）、slugify 规则匹配（`test-prune-orphans.mjs:115`/`:131`）、删除失败记账不中断（`test-prune-orphans.mjs:153`）、非空残缺 plan 当全集（`test-prune-orphans.mjs:186`）。

### test-semantic-plan.mjs — semanticPlan 端到端
- 被测导出：`semanticPlan, localPlan, scanRepoFiles`（来自 `index.js`，`test-semantic-plan.mjs:7`）。
- 无模型降级目录聚类（`test-semantic-plan.mjs:52`，`stats.llm=false`、project 标降级）、每模块非空 `source_files`（`test-semantic-plan.mjs:175`）、模块文件并集=全部源码（`test-semantic-plan.mjs:60`）、有模型走 LLM 聚类（`test-semantic-plan.mjs:71`）、坏 JSON/抛错降级（`test-semantic-plan.mjs:114`/`:130`）、空仓库 `fallback`（`test-semantic-plan.mjs:142`）、`plan.graph` 可序列化不含源码（`test-semantic-plan.mjs:151`/`:162`）、`localPlan` 保活（`test-semantic-plan.mjs:174`）、模块名 slug 不冲突（`test-semantic-plan.mjs:180`）。

### test-sessions.mjs — 会话记录存储冒烟（SESSIONS_DIR 三导出）
- 被测导出：`SESSIONS_DIR, listSessionRecords, readSessionRecord, pruneSessionRecords, listAllSessionRecords`（来自 `index.js`，`test-sessions.mjs:8`）。
- 不存在 job 空列表（`test-sessions.mjs:40`）、手工构造记录 list 倒序（`test-sessions.mjs:24`）、单条全文读取（`test-sessions.mjs:27`）、全局聚合跨任务带 jobId（`test-sessions.mjs:36`，`limit`/`jobIds` 过滤）、TTL 清理（`test-sessions.mjs:45`，全过期目录移除）。独立 `JOBS_FILE`（`test-sessions.mjs:7`）。

### test-symbols.mjs — 多语言 AST 符号提取 + import 依赖边
- 被测导出：`SymbolExtractor, extractRepoGraph, resolveImportEdges, extractImportSpecs, resolveSpec, LANG_RULES, SUPPORTED_EXTS, regexExtract`（来自 `lib/symbols.js`，`test-symbols.mjs:8`）。
- 多语言 AST：JS/TS（`test-symbols.mjs:63`，类/方法/箭头/参数去默认值）、Python（`test-symbols.mjs:107`，docstring/基类/async）、Go（`test-symbols.mjs:135`）、Rust（`test-symbols.mjs:157`）、Java/C#/C（`test-symbols.mjs:177`/`:193`/`:206`）、未知扩展名/语法错误/空文件边界（`test-symbols.mjs:214`/`:219`/`:224`）。
- import 边：`extractImportSpecs`（`test-symbols.mjs:229`）、`resolveSpec` 相对/Python 点号/找不到（`test-symbols.mjs:240`/`:247`/`:252`）、`resolveImportEdges` 连目标组件 `dependsOn`（`test-symbols.mjs:256`）、本插件真实源码自检（`test-symbols.mjs:272`）。
- 正则降级：`regexExtract`（JS/Py/Go/Rust，`test-symbols.mjs:292`/`:319`/`:328`）、WASM 不可用自动走正则（`test-symbols.mjs:333`）、WASM 可用不降级（`test-symbols.mjs:344`）、语言表覆盖（`test-symbols.mjs:353`）。
- 前置：`ex.init()` 探测 web-tree-sitter，不可用时整文件 `SKIP`（`test-symbols.mjs:39`/`:42`）。

### test-wiki-anchors.mjs — 行号锚点自动校验（产物质量门禁，非离线）
- 不 import 被测函数，而是读真实 `.codewiki/` 文章逐行正则匹配 `file:NNN` 锚点并对照真实源码（`index.js`/`client.js`/`CHANGELOG.md` 等，`test-wiki-anchors.mjs:38` `WIKI`/`SOURCES`）。
- 三基准并集：编译基线版 ∪ 工作区 ∪ HEAD（`test-wiki-anchors.mjs:96`/`loadSource` `test-wiki-anchors.mjs:96`），任一有效即通过。
- 新鲜度感知双档：结构失败（越界/区间无序）永远硬失败（`test-wiki-anchors.mjs:293`/`:308`/`:309`）；同步失败（空行/版本节/符号绑定）滞后时降级软报告（`test-wiki-anchors.mjs:269`/`judgeAnchor` `test-wiki-anchors.mjs:293`）。CHANGELOG 追加式漂移一律软报告（`test-wiki-anchors.mjs:321`）。
- 分句归属：`CLAUSE_SEP`（`test-wiki-anchors.mjs:358`）、多锚点行不校验符号绑定（`test-wiki-anchors.mjs:204`/`:364`）。
- 运行：`node test-wiki-anchors.mjs [--strict]`（`test-wiki-anchors.mjs:30`）；硬失败 `exit 1`，软报告不影响退出码。依赖一次真实编译产出 `.codewiki/`。

### test-wiki-entry.mjs — CodeWiki.md 入口生成 + Windows 路径规范化
- 被测导出：`ensureWikiEntry, normalizeArticlePath, normalizeIndexLinks, parseStatus`（来自 `index.js`，`test-wiki-entry.mjs:10`）。
- `ensureWikiEntry`：缺失生成含绝对路径/收尾工具（`test-wiki-entry.mjs:27`）、已有绝不覆盖（`test-wiki-entry.mjs:38`）、英文文案（`test-wiki-entry.mjs:43`）、空 cwd 安全（`test-wiki-entry.mjs:49`）、幂等（`test-wiki-entry.mjs:53`）。
- Windows 路径：`normalizeArticlePath`（`test-wiki-entry.mjs:57`）、`parseStatus` changedFiles/staleArticles 规范化（`test-wiki-entry.mjs:60`）、`normalizeIndexLinks` 链接头 `\`→`/`，正文反斜杠不受影响（`test-wiki-entry.mjs:64`/`:71`）。

### test-worktree.mjs — worktree / 空壳目录闸门
- 被测导出：`detectLinkedWorktree, isWorktreeCwd, hasCompilableSources, isDeadCompileTarget`（来自 `index.js`，`test-worktree.mjs:11`）。
- 用真实 git 建 linked worktree（`test-worktree.mjs:16`）：`detectLinkedWorktree` 三态（`test-worktree.mjs:38`，主工作区 null / linked 命中 gitDir 指 `.git/worktrees` / 不存在路径 null）、子目录命中（`test-worktree.mjs:47`）、非 git null（`test-worktree.mjs:52`）。
- 0.12.1 布尔封装：`isWorktreeCwd`（`test-worktree.mjs:56`，带缓存一致性）、`hasCompilableSources` 空壳（`test-worktree.mjs:68`）、`isDeadCompileTarget` worktree/空壳算 dead、不存在目录保留（`test-worktree.mjs:73`）。环境无 git 时 `SKIP`（`test-worktree.mjs:32`）。

### test-fixtures/gen-graphdiff-golden.py — 对拍基准生成器
- 用 Python `difflib`/`hashlib` 生成 `test-fixtures/graphdiff-golden.json`（`test-graphdiff.mjs:2` 注释）。运行：`python test-fixtures/gen-graphdiff-golden.py > test-fixtures/graphdiff-golden.json`（`test-graphdiff.mjs:2`）。`test-graphdiff.mjs` 读到缺失则直接 `exit 1`（`test-graphdiff.mjs:14`）。

## Architecture

18 个测试文件按「被测能力」可分三组，它们共同覆盖 `index.js` + `lib/*.js` 整条流水线。核心被测模块与测试归属关系如下（UTF-8 框图）：

```text
┌───────────────────────── 编译执行链 (index.js / lib) ─────────────────────────┐
│                                                                                 │
│  prepareArticleTasks ─ runRealtimeTasks ─ classifySessionTask                    │
│  collectSources      ─ buildSessionSteerText  (大档/默认档分池)                   │
│  localPlan ─ scanRepoFiles ─ packArticles                                        │
│  fixAnchors ─ validateArticleEnvelope ─ installWebServer                         │
│  pruneOrphanModules ─ ensureWikiEntry ─ autoCommitWiki ─ wakeCompileSession      │
│  semanticPlan ─ extractCurrentGraph ─ shouldFallBackFromAgentic                  │
└───────────────────────────┬───────────────────────────────────┬──────────────┘
                              │ 守护                               │ 守护
        ┌─────────────────────┴──────────────┐      ┌──────────────┴───────────────┐
        ▼ unit/mock（离线）                    ▼      ▼ e2e（真实 CLI/git/tick）     ▼
┌──────────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐
│ test-batch.mjs       │  │ test-cluster.mjs│  │ test-orchestration.mjs (1500+) │
│ test-agentic*.mjs    │  │ test-symbols.mjs│  │ test-prune-orphans.mjs         │
│ test-articles-       │  │ test-graphdiff. │  │ test-wiki-entry.mjs            │
│   agentic.mjs        │  │   mjs           │  │ test-worktree.mjs              │
│ test-incremental*.mjs│  │ test-semantic-  │  │ test-sessions.mjs              │
│                     │  │   plan.mjs      │  │ test-cwd-paths.mjs              │
└──────────────────────┘  └────────────────┘  └────────────────────────────────┘
                                                              │
                                                              ▼ 产物质量门禁
                                                    ┌──────────────────────────┐
                                                    │ test-wiki-anchors.mjs    │
                                                    │ (读 .codewiki 落盘文章)   │
                                                    │ + test-fixtures/*.py/.json│
                                                    └──────────────────────────┘
```

被测库 → 测试归属关系（同一库常被多文件覆盖）：

| 被测模块 | 主要守护测试 |
| --- | --- |
| `lib/agentic.js`（工具循环） | `test-agentic.mjs` |
| `lib/agentic-host.js`（适配层） | `test-agentic-host.mjs` |
| `lib/articles-agentic.js`（执行器/子模块递归/双池） | `test-articles-agentic.mjs`、`test-agentic-fallback.mjs` |
| `lib/cluster.js`（LLM 聚类） | `test-cluster.mjs` |
| `lib/symbols.js`（AST 提取/import 边） | `test-symbols.mjs`、`test-semantic-plan.mjs`（经 `index.js`） |
| `lib/graph-diff.js`（相似度/diff） | `test-graphdiff.mjs`（对拍 Python 基准） |
| `lib/incremental.js`（符号级增量/快照） | `test-incremental.mjs`、`test-incremental-e2e.mjs` |
| `index.js`（执行链/规划/会话/闸门/提交/路径） | `test-batch.mjs`、`test-orchestration.mjs`、`test-semantic-plan.mjs`、`test-sessions.mjs`、`test-prune-orphans.mjs`、`test-wiki-entry.mjs`、`test-worktree.mjs`、`test-cwd-paths.mjs` |

## Data Flow

各测试文件的输入/执行/断言回路如下：

- **离线 mock 链路（test-agentic*.mjs / test-batch.mjs / test-cluster.mjs / test-symbols.mjs / test-graphdiff.mjs / test-incremental*.mjs / test-articles-agentic.mjs）**
  1. 构造假输入：内存 `FILES`/`components`/`graph`（Map）、或临时 `mkdtempSync` 目录写真实源文件（如 `test-batch.mjs:33` `tmpRoot`、`test-incremental.mjs:26` `graphOf`）。
  2. 注入假模型：`scripted`（`test-agentic.mjs:62`）按脚本逐轮吐 `blocks`；`makeBatchMock`（`test-orchestration.mjs:145`）按 prompt 特征分发应答；`deepLlm`（`test-cluster.mjs:286`）按模块名拆份；`fakeLlm`（`test-semantic-plan.mjs:83`）抽 id 分组。
  3. 调被测纯函数/执行器，断言返回值（`r.keep.length`、`r.bigTier`、`out.ok` 等），结尾 `process.exit(fails.length ? 1 : 0)`。

- **服务化 e2e 链路（test-orchestration.mjs / test-sessions.mjs / test-prune-orphans.mjs / test-wiki-entry.mjs / test-worktree.mjs / test-cwd-paths.mjs）**
  1. `makeCtx`（`test-orchestration.mjs:51`）mock 宿主 `inject`/`webServer`/`tools`/`llm`/`agents`；`makeFixtureRepo`（`test-orchestration.mjs:110`）建真实 git 仓库含 `core.py`/`util.py`。
  2. `apply(ctx, config)` 注册插件（`test-orchestration.mjs:278`）；经 `codewiki_generate.execute`/`cw.execute` 提交任务。
  3. `waitJob`（`test-orchestration.mjs:212`）轮询独立 `JOBS_FILE` 等终态 `done/failed/cancelled`；再校验落盘文件（`modules/*.md`、`_architecture.md`、`_patterns.md`、`git` 自动提交记录）。
  4. 路径/闸门类用真实 git 建 linked worktree（`test-worktree.mjs:27`）或真实 `cw` CLI（`test-cwd-paths.mjs:34`）验证。

- **产物质量门禁链路（test-wiki-anchors.mjs）**
  1. 读真实 `.codewiki/` 落盘文章（`test-wiki-anchors.mjs:224` `walk`）。
  2. 逐行正则抓 `file:NNN` 锚点（`test-wiki-anchors.mjs:96`），按三基准并集（`test-wiki-anchors.mjs:135` `loadSource`：编译基线 `git show ref:`/工作区/`HEAD`）校验；`isFresh`（`test-wiki-anchors.mjs:135`）决定同步类失败硬/软。
  3. 硬失败 `exit 1`，软报告只列末尾；依赖先跑过一次真实编译。

- **对拍基准链路（test-graphdiff.mjs + test-fixtures）**
  1. 先 `python test-fixtures/gen-graphdiff-golden.py` 产出 `graphdiff-golden.json`（Python `difflib`/`hashlib` 真值）。
  2. `test-graphdiff.mjs` 读 json，对 `similarity`/`hash`/`unified` 三类用例逐位比对（`test-graphdiff.mjs:68`），并在内存构造 `oldG`/`newG` 验证 `diffGraphs`/`serializeDiff` 的分类（改名/interface/body/edge/`test-graphdiff.mjs:83`）。

## Connections

- 编译执行链核心导出集中在 [[index.js]]，是 `test-batch.mjs`/`test-orchestration.mjs`/`test-semantic-plan.mjs`/`test-prune-orphans.mjs`/`test-wiki-entry.mjs`/`test-worktree.mjs` 的主要被测面。
- agentic 工具循环见 [[agentic]]（`lib/agentic.js`，`test-agentic.mjs`）、适配层 [[agentic-host]]（`lib/agentic-host.js`，`test-agentic-host.mjs`）、执行器与子模块递归见 [[articles-agentic]]（`lib/articles-agentic.js`，`test-articles-agentic.mjs`/`test-agentic-fallback.mjs`）。
- LLM 语义聚类见 [[cluster]]（`lib/cluster.js`，`test-cluster.mjs`）。
- AST 符号提取与 import 边见 [[symbols]]（`lib/symbols.js`，`test-symbols.mjs`）。
- 图差异与相似度见 [[graph-diff]]（`lib/graph-diff.js`，`test-graphdiff.mjs`）。
- 符号级增量与快照见 [[incremental]]（`lib/incremental.js`，`test-incremental.mjs`/`test-incremental-e2e.mjs`）。
- 服务化编排/阶段机/自动提交/会话唤醒的整体描述见 [[orchestration]]（由 `test-orchestration.mjs` 守护）。
- 仓库入口文档与路径规范化见 [[wiki-entry]]（`ensureWikiEntry` 等，由 `test-wiki-entry.mjs` 守护）。
- 横向关注点的总览/模式/概念文章装配由 `packArticles`/`prepareArticleTasks` 负责，落盘后由 `test-wiki-anchors.mjs` 做锚点门禁。

## Known Issues

- **`test-orchestration.mjs` 显式关闭三档新能力**（基线 `LEGACY_CHANNEL`，`test-orchestration.mjs:44`）：为守护旧单轮通道的请求次数/装填/落盘时序，基线将 `planMode:'dirs', agenticArticles:false, symbolIncremental:false`。这意味着该文件**不**验证 0.13.0 引入的语义规划/agentic 写作/符号增量——三者由 `test-semantic-plan.mjs`/`test-agentic*.mjs`/`test-incremental*.mjs` 各自守护。若改基线为全开，旧通道断言会因「通道换了」而非「功能坏了」而大量失败。
- **`test-symbols.mjs` 在 web-tree-sitter 不可用时整文件 `SKIP`**（`test-symbols.mjs:43`）：AST 用例依赖 WASM 语法包，环境缺失则 `process.exit(0)` 跳过，不会报错也不会验证 AST 路径。正则降级路径（`regexExtract`/`WASM 不可用自动走正则`）同样在此文件中守护。
- **`test-cwd-paths.mjs` 需真实仓库路径入参**（`test-cwd-paths.mjs:59` 默认 `E:/ik/Documents/trae_projects/1/Wxxy-CampusLogin`）：依赖真实 `cw` CLI，非离线；`resolveBinary`/`wikiPathFor` 未导出，仅经 `cw.execute` 间接验证。运行前需改参数为本机真实仓库 Windows 路径。
- **`test-wiki-anchors.mjs` 非离线、依赖真实编译产物**：必须 `.codewiki/` 已落盘（`test-wiki-anchors.mjs:225` 否则 `exit 1`）；其校验采用「编译基线 ∪ 工作区 ∪ HEAD」三基准并集，且同步类失败在源文件滞后时降级为软报告——它属于「编译后跑一遍」的质量门禁，不能作为纯 CI 快速门禁。
- **`test-graphdiff.mjs` 依赖前置基准文件**：若 `test-fixtures/graphdiff-golden.json` 缺失直接 `exit 1`（`test-graphdiff.mjs:14`），需先 `python test-fixtures/gen-graphdiff-golden.py` 生成。
- **`test-worktree.mjs`/`test-worktree`-类依赖真实 git**：环境无可用 git 时整文件 `SKIP`（`test-worktree.mjs:32`），不会误报成功。
- **`test-orchestration.mjs` 的 `JOBS_FILE` 隔离**：用 `pid`+随机 token（`test-orchestration.mjs:32`）隔离同机真实服务实例，避免历史 fixture 任务造成「单项目串行」误判；测试结束统一删除，不留残留。
- **`test-agentic-fallback.mjs` 第三段退回链路未直接覆盖**：注释（`test-agentic-fallback.mjs:3`）说明「收割计入 tally」由 `test-orchestration.mjs` 的旧通道断言与 tally 去重逻辑间接守护，本文件只覆盖前两段（过半判定、可装填性）。
