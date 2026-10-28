---
title: patterns
type: pattern
source_files:
  - lib/cluster.js
  - lib/symbols.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/change-set.js
  - lib/article-contract.js
  - lib/agentic.js
  - lib/articles-agentic.js
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/llm-bridge.js
  - lib/engine/openai-bridge.js
  - lib/engine/python/stage_map.py
  - index.js
  - test-cluster.mjs
  - test-symbols.mjs
  - test-graphdiff.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - test-fixtures/graphdiff-golden.json
  - test-incremental.mjs
  - test-incremental-e2e.mjs
  - test-update-planner.mjs
  - test-update-record.mjs
  - test-prune-orphans.mjs
  - test-change-set.mjs
  - test-worktree.mjs
  - test-article-contract.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-agentic.mjs
  - test-articles-agentic.mjs
  - test-agentic-fallback.mjs
  - test-orchestration.mjs
  - test-batch.mjs
  - test-engine-contract.mjs
  - test-engine-client.mjs
  - test-engine-manifest.mjs
  - test-engine-process-tree.mjs
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-output.mjs
  - test-engine-output-real.mjs
  - test-engine-python-entry.mjs
tags: [patterns, conventions, error-handling, testing, naming, incremental, engine]
---

## Overview

本文归纳仓库中反复出现的横切模式。背景：本仓库是把 FSoft-AI4Code/CodeWiki 的 Python 实现（`cluster_modules.py`、`graph_diff.py`、`updater/*`、`dependency_analyzer/*` 等）重写为纯 Node 插件，因此「纯函数重写 + 依赖注入测试 + 显式降级 + 对拍验证」这几条主线几乎贯穿每个模块。收录标准：模式必须出现在多个互不依赖的模块中，且能落到具体文件/函数名；行号以各模块文章引用的源码位置为准。

## Patterns

### 1. 纯函数核心 + 依赖注入，IO 推到边界

逻辑层写成不碰文件系统/网络的纯函数，把副作用（LLM 调用、git 执行、fs、进程探测、模型流）收敛为调用方注入的函数参数，从而能离线单测全部路径。

- `clusterComponents({ components, llmCall?, ... })`（`lib/cluster.js:291-389`）不传 `llmCall` 走纯本地启发式 `heuristicCluster`（`lib/cluster.js:219-244`）；`test-cluster.mjs` 注入假 `llmCall` 即可不碰网络跑完三段式与全部降级路径。
- `collectChangeSet(cwd, baseCommit, opts)`（`lib/change-set.js:102-205`）的 git 执行器经 `opts.execFile` 注入（默认封装 `execFileSync`，`lib/change-set.js:42-49`）；`test-change-set.mjs:177-194` 用假执行器离线覆盖四条 git 命令。
- `loadSnapshot(wikiPath, fsImpl = fs)` / `saveSnapshot(..., fsImpl, pathImpl)`（`lib/incremental.js:94-115`）、`saveUpdateRecord(wikiPath, record, fsImpl = fs)`（`lib/update-record.js:217`）都留 `fsImpl` 注入点。
- `probeEnvironment({ probe, engineRoot })`（`lib/engine/manifest.js:34-45`）把探测动作抽成调用方传入的 `probe` 函数，进程 spawn 留给 `lib/engine/client.js`，manifest 因此保持纯逻辑（`test-engine-manifest.mjs:29-34` 用 fakeProbe 注入）。
- `startLlmBridge({ llm, ... })`（`lib/engine/llm-bridge.js:90-241`）由调用方注入宿主 `llm.stream`，桥自身不读凭证（测试用 fakeLlm，`test-engine-llm-bridge.mjs:28`）；请求转换层 `toLlmRequest`（`lib/engine/openai-bridge.js:128-161`）返回值永远不含 `apiKey` 字段（`lib/engine/openai-bridge.js:27` 安全边界）。
- `runAgenticArticle({ mission, workspace, streamFn })`（`lib/agentic.js:331-432`）缺 `streamFn` 直接抛「需要 streamFn」（`lib/agentic.js:347`；`test-agentic.mjs:451-453` 钉死该契约）。
- `inspectArticle(content, opts)`（`lib/article-contract.js:213`）的 `fsImpl` 不传就不查文件系统（`test-article-contract.mjs:114` 注入临时目录 fs）。
- `planUpdate({ changeSet, oldGraph, newGraph, articles, moduleMap, options })`（`lib/update-planner.js:156-436`）整体是纯函数；`scanStaleArticle` 的 `linkExists(target)` 也由调用方注入（`lib/update-planner.js:106-145`）。

### 2. 显式降级与状态记账，绝不静默丢弃

失败、降级、异常从不静默吞掉，而是折算成结构化字段随返回值带走（`state`/`fallback`、`warnings`、`violations`、`problems`、`unmapped`、`blockers`）。反面教材被写进注释：symbols 早期正则降级直接 `return []` 让整块语言静默消失（`lib/symbols.js:288-296`）。

- cluster：LLM 抛错/垃圾文本 → `stats.fallbacks++` + warning + 退回 `heuristicCluster`（`lib/cluster.js:309-325`）；`warnings` 累积所有降级与解析异常。
- change-set：采集失败折成五种 `state`（`missing-base`/`no-git`/`git-error`/`unreachable-base`/`ok`）+ `fallback='full'`（`emptyChangeSet`，`lib/change-set.js:73-93`、`:104-160`）——「采不全 = 显式降级」，绝不把采不到当没变化。
- symbols：WASM 不可用/ABI 不匹配退 `regexExtract` 并记 `stats.regex` / `stats.regexLanguages`；`extractFile`（`lib/symbols.js:551-594`）在 parser 缺失、parse 抛错、AST 零符号三种情况都退正则。
- engine client：协议违规进 `violations`（`not-json`/`unknown-request`/`late-result`/`duplicate-result`/`line-too-long` 等，`violate()` `lib/engine/client.js:53`），不抛模糊异常；没有 `result` 即使退出码 0 也判 `engine-protocol`。
- mapping/output：未映射页进 `unmapped` 带可机读 `reason`（`mapFsoftOutput`，`lib/engine/mapping.js:115-268`）；坏文件变 `problems` 而非异常（`collectOutput`（`lib/engine/output.js:91-124`）/`readJsonIfExists`（`lib/engine/output.js:64-82`）——「存在但坏了永远报 bad-json」）。
- update-planner：无文章认领的变更显式列入 `unmappedChanges`/`unmappedSourceChanges`（`lib/update-planner.js:349-390`）；非源码文件无归属只记 warning 不触发全量（`isSourcePath`，`lib/update-planner.js:33-36`、`:419-423`）。
- update-record：`judgeOutcome`（`lib/update-record.js:37-128`）把缺页/失败/未映射/质量/索引每一种「完整性不成立」写成 `blockers`。
- contract：同一不变量两条路径——`engineResult` 构造期非法输入直接抛错（`lib/engine/contract.js:97-147`），`validateEngineResult` 反序列化边界不抛错、逐条返回 `errors`（`lib/engine/contract.js:180-220`）。

### 3. 分层降级链与多道闸门

关键路径设计成「每一层失败都有下一层接住」的纵深，而非单点成败。

- 符号提取三级降级：`extractFile` 中 parser 加载失败、`parser.parse` 抛错、AST 成功但零符号分别退正则（`lib/symbols.js:555-565`、`:566-572`、`:582-592`）。
- 锚点修正多层兜底：`fixAnchors`（`index.js:856`）先修未闭合 frontmatter（`repairUnclosedFrontmatter`，`index.js:834`），再修 CHANGELOG 锚点（`fixChangelogAnchors`，`index.js:709`），最后按 `source_files` 做符号绑定。
- 写作通道回退：agentic 批量失败严格过半（`failed*2 > length`）触发 `shouldFallBackFromAgentic`（`index.js:1293-1298`）→ `prepareArticleTasks`（`index.js:1165`）把失败篇重填进单轮通道（`test-agentic-fallback.mjs` 钉死判定与可重填性）。
- 增量波及面收敛：反向依赖闭包只对 `structural` 变更生效（`realChangedIds`，`lib/update-planner.js:57-81`；闭包构建 `:209-219`）——实现细节变更不波及依赖方文章（`test-update-planner.mjs:75-86` 验证）。
- 产物校验分层：阶段 2 `validateOutput`（`lib/engine/output.js:184-282`）只判「产物自身自洽」，frontmatter/锚点/写集冲突闸门留给阶段 3 的 `contractCheck`/`inspectArticle`，两层职责不重叠。
- 引擎终态竞争：`runEngine` 用 `Promise.race` 竞争 `exited`/`timeout`/`abort`/`spawnError` 四种终态，超时/取消统一走 `killTree` → `terminateProcessTree`（`lib/engine/client.js:336`；`lib/engine/process-tree.js:61`）。

### 4. 保守不变量：不丢失 / 不臆造 / 不覆盖 / 宁可多写

- 聚类组件不丢失：`fillMissing` + `heuristicCluster` 兜底（`lib/cluster.js:247-268`、`:219-244`），`test-cluster.mjs:153-216` 几乎每个用例断言 `Set(modules.flatMap(m => m.components)).size === components.length`。
- 无符号可判的文章一律 keep：`filterStaleTasks` 的 `symbolFallback`（`lib/incremental.js:182` 注释「宁可多写一篇，不留下过期文章」、`:179-183`；`test-incremental.mjs:160-167`）。
- 不臆造 `source_files`：`sourceFilesOf`（`lib/engine/mapping.js:62-72`）只认组件→文件证据，无证据宁空勿造并记 warning；空模块树下页仍进写集但 `attribution='unattributed'`。
- 不覆盖：slug 冲突时两页都进 `unmapped`，先到的从 articles 回撤（`lib/engine/mapping.js:163-175`）。
- 取消是终态：取消后到达的 result 记 `late-result` 丢弃，「不能被迟到的成功洗白」（`lib/engine/client.js:19` 头注释、`:105-109`）。
- partial 绝不推进基线：`canAdvanceBaseline` 仅 `outcome==='done'` 且无 blocker（`lib/update-record.js:124`；`index.js:3399` 据此决定是否 `cw meta update`）；`test-update-record.mjs:62-76` 钉死「1 成功 19 失败必须 partial」。
- 写集闸门：agentic 任务只允许写 `allowedWritePaths` 内路径，越界 `stopReason:'write-set'` 且不落盘，写集向递归子模块继承（`lib/articles-agentic.js:155-167`；`test-articles-agentic.mjs:399-470`）。
- 踩坑写进代码注释供后续 agent 参考：`keep`/`review` 不得计入 `requiredNames`（`lib/update-planner.js:399-408`）。

### 5. 版本化常量与读时版本校验

每份跨会话/跨进程的数据契约都带显式版本常量，落盘时写入、读回时校验，不符一律当「没有」处理而不是猜。

- `CHANGE_SET_VERSION`（`lib/change-set.js:19`）写入 `ChangeSet.version`；`SNAPSHOT_VERSION`（`lib/incremental.js:19`）→ `loadSnapshot` 校验 `version !== 1` 返回 `null`（`lib/incremental.js:94-104`）；`UPDATE_RECORD_VERSION`（`lib/update-record.js:17`）→ `loadUpdateRecord` 同样拒绝（`lib/update-record.js:229-233`）；`UPDATE_PLAN_VERSION`（`lib/update-planner.js:23`）、`MODULE_MAP_VERSION`（`lib/update-planner.js:26`）；`MANIFEST_VERSION`（`lib/engine/manifest.js:19`，参与指纹计算）；`ARTICLE_CONTRACT_VERSION`（`lib/article-contract.js:16`）。
- 跨进程契约拆两个独立版本：`ENGINE_PROTOCOL_VERSION`（管「行怎么长」，`lib/engine/client.js:27`，`hello` 消息核对 `:74-80`）与 `ENGINE_CONTRACT_VERSION`（管「结果字段」，`lib/engine/contract.js:20`，`engineResult` 强制带上、`validateEngineResult` 校验）。
- 版本化落盘路径同样常量化：`SNAPSHOT_REL='temp/symbol-graph.json'`（`lib/incremental.js:22`）、`MODULE_MAP_REL='temp/module-map.json'`（`lib/update-planner.js:27`）、`UPDATE_RECORD_REL='temp/update-record.json'`（`lib/update-record.js:18`）、`ENGINE_LOCK_REL='.codewiki/engine-lock.json'`（`lib/engine/manifest.js:20`）。

### 6. 表驱动规则与冻结枚举码表，按 kind 机读分派

- `LANG_RULES`（`lib/symbols.js:36-271`）+ `SUPPORTED_EXTS`（`:273-276`）+ `REGEX_RULES`（`:302-368`）：加一门语言只加表行，不改控制流。
- `ENGINE_STAGES` / `TERMINAL_OUTCOMES` / `BLOCKER_KINDS` / `ENGINE_ERROR_CODES` / `RETRYABLE_CODES`（`lib/engine/contract.js:24-71`，`Object.freeze`；新增只许追加、不许改名）。
- `OUTPUT_PROBLEM_KINDS`（`lib/engine/output.js:22-34`）：注释明确「上层按 kind 分派（不要靠 message 文本匹配）」；`PROBLEM_SET`（`:36`）+ `validateOutput` 的 `push` 对未登记 kind 直接抛错（`:187-190`），防止自由发挥。
- `TYPE_BY_DIR` / `ROOT_TYPES` / `REQUIRED_SECTIONS` / `REQUIRED_FIELDS` / `SEVERITY`（`lib/article-contract.js:19-56`）。
- Python 侧 `stage_map.py` 的 `ENGINE_STAGES`（`:20-29`）必须与 `lib/engine/contract.js:24-33` 同集合，`test-engine-python-entry.mjs:236-247` 双向 deepEqual 对账——改一边不改另一边测试即红。
- `scanStaleArticle` 的 issue kind（`deleted-symbol`/`renamed-symbol`/`dead-link`，`lib/update-planner.js:106-145`）。

### 7. 分级处置：error 拦截 / warning 放行 / 软报告

- `SEVERITY`（`lib/article-contract.js:56`）区分 error 与 warning；`hasBlockingIssue`（`lib/article-contract.js:346`）仅 error 级拦落盘，warning 放行但把 job 降为 partial（`test-article-contract.mjs` 的 `empty-section-optional` 用例验证）。
- `test-wiki-anchors.mjs` 的「新鲜度感知」分级：struct 类锚点错误永远硬失败，sync 类在源文件滞后（`isFresh`，`test-wiki-anchors.mjs:135`）时降级软报告，changelog 永远软报告（`judgeAnchor`，`test-wiki-anchors.mjs:293`）。
- `scanStaleArticle`：正文引用已删/改名符号（内容已错）→ 重写；死链只进 `review`（`lib/update-planner.js:106-145`）。
- 引擎侧 `hello` 的 `protocol-version` 不一致只记诊断违规、不阻断结果（`lib/engine/client.js:74-78`）。
- mapping 的「模块树含 X 但未产出 X.md」只进 `warnings`，是否 partial 由上层按 `unmapped` 决定（`lib/engine/mapping.js:235-242`）。

### 8. POSIX 路径归一

任何进入判定层的路径先做 `\`→`/` 与 `./` 前缀归一：

- `normRel`（`lib/incremental.js:118-120`；`lib/update-planner.js:21` 导入同一实现）；`normChangePath`（`lib/change-set.js:33-40`，绝对路径/越界 `../` 直接返回 `null`）。
- `posix(p)` 在引擎侧三个文件各自出现：`lib/engine/output.js:38`、`lib/engine/mapping.js:46`、`lib/engine/manifest.js:22`。
- `index.js`：`normalizeArticlePath`（`:209`）、`normalizeIndexLinks`（`:213`，只改 `[[...|` 链接头）；`normalizeWritePath`（`lib/article-contract.js:357`）供写集比对。
- 测试钉死：`test-incremental.mjs:169-176`（`.\src\a.js` 与 `./src/a.js` 都归一成 `src/a.js`）、`test-change-set.mjs:166-175`、`test-wiki-entry.mjs` 的 Windows 路径规范化用例。

### 9. 状态文件的幂等写与空转提交防护

- 写前先比实质内容：`sameSnapshotContent`（`lib/incremental.js:53-66`，忽略 `generatedAt`/`commit`）在 tickIndex 落快照前比较，内容没变就跳过写入，避免 `autoCommit` 空转提交（`index.js:3430-3432`）；`sameModuleMap`（`lib/update-planner.js:484-492`）同理。
- 原子写：`writeLock` 先写 `${file}.${pid}.tmp` 再 `renameSync`（`lib/engine/manifest.js:121-133`）。
- 收尾动作幂等/不覆盖：`ensureWikiEntry`（`index.js:301`）已有入口返回 `false` 绝不覆盖（`test-wiki-entry.mjs` 幂等用例）；`pruneOrphanModules`（`index.js:271-296`）只在 `kind==='full'` 且 `plan.modules` 非空数组时动手，`concepts/` 与 `_architecture.md` 永不碰、增量一律不动（`test-prune-orphans.mjs:57-96`）。
- `terminateProcessTree` 对非法/已退出 pid 幂等返回 `noop`/`already-exited`（`lib/engine/process-tree.js:65-70`；`test-engine-process-tree.mjs:102-112` 验证重复终止）。
- 序列化稳定：`slimGraph` 按 id 升序排序（`lib/incremental.js:37-48`），保证同内容快照可比。

### 10. 测试范式：无框架 `check()` 脚本、退出码与 SKIP 策略

- 几乎所有测试都是 `node test-*.mjs` 直接跑的顶层脚本，自写 `check` 累加 pass/fails，失败置退出码 1：`check(label, fn)`（`test-cluster.mjs:13-22`、`test-agentic.mjs:12-21`）、`check`/`checkAsync`（`test-symbols.mjs:17-36`）、`check(cond, msg)`（`test-batch.mjs:17-20`、`test-orchestration.mjs:27-30`、`test-worktree.mjs:14`、`test-wiki-entry.mjs:13`）、引擎四件套（`test-engine-contract.mjs:34-37`、`test-engine-client.mjs:29-32`、`test-engine-manifest.mjs:23-26`、`test-engine-process-tree.mjs:22-25`）、桥与产物测试（`test-engine-bridge.mjs:31`、`test-engine-llm-bridge.mjs:22`、`test-engine-output.mjs:23`）、增量簇（`test-incremental.mjs:16-19`、`test-change-set.mjs:15-18`、`test-article-contract.mjs:20`）。
- 「环境不可用」的两种策略并存且有意区分：探针类测试缺依赖时 SKIP 退出 0、绝不假装通过（`test-symbols.mjs:42-45` 无 web-tree-sitter；`test-worktree.mjs:30-36` git setup 失败；`test-engine-output-real.mjs:33-36` 无真实产物；`test-engine-python-entry.mjs:47-51` findPython 失败）；而 `test-graphdiff.mjs:14-17` 在黄金基准缺失时选择报错退出 1（强制先跑 `python test-fixtures/gen-graphdiff-golden.py` 生成）——「可跳过的探针」与「必须存在的真理源」分属两类。
- 已知不一致：各文件断言风格未统一（`test-change-set.mjs` 用 `node:assert/strict` 包自写 check，`test-worktree.mjs` 用裸 check），无统一运行入口。

### 11. 注入式测试底座：临时仓库 / mock llm / 伪宿主 ctx

- 编排冒烟（`test-orchestration.mjs`）的 builder 层：`makeCtx`（`:51-91` 伪宿主 ctx，捕获 webServer/tools/agents/llm）、`makeFixtureRepo`（`:110-127` git init 且必须带 git identity，0.10.9 起 `autoCommitWiki` 拒绝缺 identity）、`makeBatchMock`（`:145-227` 按 prompt 特征应答的伪宿主 llm，`answerFor` `:147-195`）、`waitJob`（`:230-243` 轮询 JOBS_FILE 等终态）、`fakeReq`/`fakeRes`（`:245-257`）。环境隔离靠 `DSH_CODEWIKI_JOBS_FILE` + 随机 token（`:22-23`，防 pid 复用读到历史 fixture 任务）与 `DSH_CODEWIKI_TICK_MS='300'`（`:15`）。
- `LEGACY_CHANNEL`（`:44`）把语义规划/agentic/符号增量三档新能力显式关掉，让测试守护旧通道而非「通道换了」的假回归。
- 变更采集测试每场景独立临时 git 仓库：`makeRepo()`（`test-change-set.mjs:23-42`）；worktree 测试用真实 `git worktree add`（`test-worktree.mjs:10-43`），判据来自 git 自身而非目录命名。
- agentic 测试用 in-memory workspace + scripted `streamFn`（`test-agentic.mjs:29-52`、`:62-73`）；批量执行测试注入 `streamFn` 不触真实 llm（`test-articles-agentic.mjs`）。
- 端到端链路测试用 `os.tmpdir()` 真实目录走全链（`test-incremental-e2e.mjs:17-41`：写文件 → `extractCurrentGraph` → 落快照 → 改代码 → 判定）。
- 引擎进程层不 mock：协议层用 `createProtocolReader` 纯函数逐字节喂（模拟管道任意切分，`test-engine-client.mjs:129-138`），进程层用真实 spawn 的假引擎 `fake_engine.py` 按 `FAKE_MODE` 吐协议串（`test-engine-client.mjs:158-218`）。

### 12. 黄金基准对拍：Python 原版生成期望值，Node 逐位比对

- `test-fixtures/gen-graphdiff-golden.py` 用 Python 原生 `difflib` + `hashlib`、固定种子 `random.Random(20261027)`（`:53`）生成 `test-fixtures/graphdiff-golden.json`（499 行用例，`:144` dump）；`test-graphdiff.mjs` 对拍主循环（`:28-42`）逐条比对——`similarity` 容差 `<1e-12`（`:30-32`），`hash`/`unified` 严格相等。
- 动机写在生成脚本头注释（`:4-7`）：`lib/graph-diff.js` 是上游 `graph_diff.py` 的逐位移植，`difflib.SequenceMatcher` 的边界情形（空序列、重复 token）无法靠肉眼核对，必须用 Python 原版喂同一批输入产出期望值。
- 覆盖互补：对拍只覆盖纯函数（`bodySimilarity`/`bodyHash`/`unifiedDiff`），组件级图算法（`diffGraphs`/`serializeDiff`）另用性质断言覆盖（`test-graphdiff.mjs:55-107`：改名配对、interface/body/edge 分类、counts 自洽、序列化往返）。

### 13. 命名与目录约定

命名：

- 组件 id 统一 `<相对路径>#<符号名>`（方法为 `#<类名>.<方法名>`；`lib/symbols.js:10-11`）——用 `#` 替代上游 `::` 以避免与 Windows 盘符里的 `:` 混淆。
- 文件名友好化三套并存、各管一层：`normalizeModuleName`（`lib/cluster.js:198-206`，snake_case、中文保留、空串兜底 `module`）、`moduleSlug`（`lib/engine/mapping.js:38-44`，kebab-case）、`slugify`（`index.js:1670-1672`，保留 CJK、空回落 `module`）——`pruneOrphanModules` 依赖 `slugify` 与实际文件名一致才不误删（`test-prune-orphans.mjs:115-126`、`:131-149`）。
- 测试脚本 `test-*.mjs` 平铺仓库根；离线基准收在 `test-fixtures/`。
- 落盘路径常量以 `_REL` 结尾（`SNAPSHOT_REL`/`MODULE_MAP_REL`/`UPDATE_RECORD_REL`/`ENGINE_LOCK_REL`）；可再生状态统一放 wiki 内 `temp/`（`temp/symbol-graph.json`、`temp/update-record.json`、`temp/module-map.json`；引擎产物侧同样把 `docs/temp/` 当工作目录跳过——`TEMP_DIR='temp'`，`lib/engine/output.js:43`）。

目录：

- `lib/` 收纯函数库（cluster / symbols / graph-diff / incremental / update-planner / update-record / change-set / article-contract / agentic*），无副作用、可单测；`lib/engine/` 收跨语言边界子系统（contract / client / process-tree / manifest / mapping / output / llm-bridge / openai-bridge + `lib/engine/python/`）；编排集中在单文件 `index.js`。
- wiki 产物固定在 `.codewiki/`：`WIKI_ENTRY='CodeWiki.md'`、`WIKI_MODULES_REL='.codewiki/modules'`、`WIKI_META_REL='.codewiki/_meta.yaml'`、`WIKI_UPDATE_RECORD_REL='.codewiki/temp/update-record.json'`（`lib/engine/mapping.js:30-34`）；锁文件例外放 `.codewiki/engine-lock.json`（`lib/engine/manifest.js:20`）。
- tree-sitter 依赖装在独立 npm 根 `vendor/tree-sitter`（`DEFAULT_VENDOR_DIR`，`lib/symbols.js:21-25`）——插件根 `node_modules` 由宿主注入（符号链接），在那里跑 `npm install` 会破坏运行环境。
