---
title: _patterns
type: pattern
source_files:
  - lib/symbols.js
  - lib/graph-diff.js
  - lib/cluster.js
  - lib/incremental.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/change-set.js
  - lib/article-contract.js
  - lib/agentic.js
  - lib/agentic-host.js
  - lib/articles-agentic.js
  - lib/engine/contract.js
  - lib/engine/client.js
  - lib/engine/process-tree.js
  - lib/engine/manifest.js
  - lib/engine/mapping.js
  - lib/engine/output.js
  - lib/engine/quality-gate.js
  - lib/engine/apply-plan.js
  - lib/engine/native-run.js
  - lib/engine/openai-bridge.js
  - lib/engine/llm-bridge.js
  - index.js
  - test-symbols.mjs
  - test-cluster.mjs
  - test-semantic-plan.mjs
  - test-change-set.mjs
  - test-article-contract.mjs
  - test-agentic.mjs
  - test-agentic-host.mjs
  - test-articles-agentic.mjs
  - test-agentic-fallback.mjs
  - test-engine-apply-plan.mjs
  - test-engine-process-tree.mjs
  - test-engine-bridge.mjs
  - test-engine-llm-bridge.mjs
  - test-engine-native-job.mjs
  - test-engine-output.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-worktree.mjs
  - test-wiki-anchors.mjs
  - test-batch.mjs
  - tools/fsoft-engine/probe-no-llm-graph.py
tags: [patterns, conventions, error-handling, testing, cross-platform, engine]
---

## Overview

本文总结 dsh-codewiki 仓库里**跨模块反复出现**的模式，而非任何单一模块的行为。证据全部取自各模块文章中出现过的真实文件与函数——`lib/` 下的纯逻辑库（`lib/symbols.js`、`lib/cluster.js`、`lib/graph-diff.js`、`lib/incremental.js`、`lib/update-planner.js`、`lib/update-record.js`、`lib/change-set.js`、`lib/article-contract.js`、`lib/agentic*.js`）、`lib/engine/` 下的原生引擎边界（`contract.js`/`client.js`/`apply-plan.js`/`quality-gate.js`/`mapping.js`/`manifest.js`/`llm-bridge.js` 等）、`index.js` 编排层，以及成套的 `test-*.mjs` 独立测试脚本。每条模式一节，均给出「文件：行号」出处，便于对照源码核实。

模式大致覆盖四类：**代码组织**（契约先行、表驱动、纯函数分层）、**错误处理风格**（可机读分类、保守降级、终态诚实、版本号契约）、**平台与安全边界**（路径归一、写集白名单、凭证边界、原子写回滚）、**构建与测试流程**（独立脚本 + `check()` 微型框架、真环境回归护栏），外加**命名与目录约定**（组件 id、slug 策略、`.codewiki/` 布局与瘦身持久化）。

两条主线贯穿几乎所有模式：其一，**外部世界不可信**——git、LLM、文件系统、子进程、模型回复都可能坏，所以降级要显式、错误要分类、终态要诚实；其二，**测试要能离线确定性跑**——副作用一律走注入点，核心判定一律纯函数，容易悄悄出错的地方再用真 git / 真进程钉死。

## Patterns

### 1. 契约先行与窄边界：跨边界处先立数据契约，一个模块只做一件事

凡跨进程、跨语言、跨模块的边界，仓库先用纯数据契约钉死形状，再把每个模块的职责收窄到单一动词。

- `lib/engine/contract.js` 只做纯数据校验，不碰文件、不碰进程、不碰模型；`lib/engine/client.js` 是引擎子进程的唯一 `spawn` 点（client.js:22、:288）；`lib/engine/process-tree.js` 只做「终止」一件事（`terminateProcessTree`，process-tree.js:61-103）。
- JSON-lines 协议的六条不变量写在 client.js 头注释（client.js:13-20），由纯逻辑读取器 `createProtocolReader`（client.js:39-186）强制执行：非 JSON 行记 `not-json` 但不丢已收结果、requestId 不匹配记 `unknown-request`、取消后到达的 result 记 `late-result` 等。
- `mapFsoftOutput` 的四条硬规则（lib/engine/mapping.js:115-125）：不臆造 `source_files`、未映射页进 `unmapped` 不静默丢弃、slug 冲突两页都进 `unmapped` 不覆盖、正文一字不动。
- Node 记录形状契约由 `lib/symbols.js:785-786` 与 `lib/graph-diff.js:9-10` 共同约定；`extractRepoGraph`（lib/symbols.js:810-830）只提取组件、不建边，依赖边由 `resolveImportEdges`（lib/symbols.js:810-833）显式补建——图的生产与边的生产刻意分离。

### 2. 表驱动声明式配置：加条目只加一行

反复出现「一张声明式表 + 一个按表遍历的解释器」，替代逐条硬编码：

- `LANG_RULES`（lib/symbols.js:36-271）：16 种语言的容器节点类型/名称字段/参数字段/基类字段全在一张表，`walk`（lib/symbols.js:597-695）按规则遍历，「加语言只加一行」（lib/symbols.js:302）；正则降级路径同样表驱动（`REGEX_RULES`，lib/symbols.js:302-368）。
- `LINE_COMMENT_MARKS` / `BLOCK_COMMENT_PAIRS` / `TRAILING_COMMENT_MARKS`（lib/graph-diff.js:35-39）：多语言注释剥离标记表，取舍写在表旁注释。
- `SCAN_SKIP_DIRS` / `SCAN_SKIP_EXT`（index.js:2178-2188）：`scanRepoFiles`（index.js:2192-2215）的黑名单表。
- 错误词表也是表：`GATE_DEFECT_KINDS`/`GATE_DEGRADATION_KINDS`/`GATE_STALE_KINDS`（lib/engine/quality-gate.js:45-72）、`APPLY_PROBLEM_KINDS`/`APPLY_RESULT_KINDS`（lib/engine/apply-plan.js:52-73），均冻结、只允许追加。
- 映射表：`TO_CONTRACT_KIND`（lib/engine/quality-gate.js:572-587、lib/engine/apply-plan.js:298-307）把领域问题类别翻成契约词表；`RANK`/`weakest`（lib/engine/native-run.js:41-42）把终态强弱排成表。

配套约束：表条目必须「登记」，未登记即报错（见模式 6）。

### 3. 纯函数核心 + 依赖注入 IO：判定逻辑不碰文件系统，副作用走注入点

模块把「算」与「做」分开：核心判定是纯函数，IO 集中收口，外部副作用经注入点替换，从而测试零网络、零真实 git 即可确定性跑。

- 纯函数核心：`filterStaleTasks`（lib/incremental.js:140-194）、`planUpdate`（lib/update-planner.js:156）、`scanStaleArticle`（lib/update-planner.js:106-145，不碰磁盘）、`mapFsoftOutput`（lib/engine/mapping.js:115）、`checkWriteTargets`（lib/engine/apply-plan.js:86-131，不碰磁盘）、`createProtocolReader`（lib/engine/client.js:39-186，可逐字节喂）；`lib/engine/manifest.js` 主体是纯函数与只读诊断（唯一落盘是 `writeLock`）。
- IO 收口：lib/incremental.js 的读写集中在 `loadSnapshot`/`saveSnapshot`（:94-115）。
- 注入点：`collectChangeSet` 的 `opts.execFile`（lib/change-set.js:102，假执行器见 test-change-set.mjs:177-194）；`probeEnvironment({ probe })`（lib/engine/manifest.js:34）；`applyNativeOutput` 的 `deps`（runCw/commit/normalizeIndexLinks/verifyCommit，apply-plan.js:411、:532-537——落地器刻意不 import index.js，避免「为测一个写盘函数启动整个插件」）；`runNativeJob` 的 `gateImpl`/`applyImpl`（native-run.js:88-89，假 runEngine + 真 gate/apply 见 test-engine-native-job.mjs:526-559）；`runAgenticArticle` 的 `streamFn`/`workspace`（lib/agentic.js:331，脚本化回放见 test-agentic.mjs:62-73）；`clusterComponents` 的 `llmCall`（lib/cluster.js:293，不传则纯本地启发式）；`loadSnapshot`/`saveSnapshot` 的 `fsImpl`（lib/incremental.js:94、:106）与 `saveUpdateRecord`/`loadUpdateRecord` 的 `fsImpl`（lib/update-record.js:217、:229）；`inspectArticle` 可注入 `cwd`/`fsImpl`/`readableSources`/`allowedLinks`/`expectedType`（lib/article-contract.js:213）。

### 4. 保守降级：能力可以缺，数据不能丢

可选能力缺失时降级运行并留痕，但绝不静默丢数据、绝不假装成功：

- AST 不可用（WASM 缺失/ABI 不匹配/`parse` 抛错/零符号）一律退 `regexExtract`（lib/symbols.js:374-440），产出与 AST 路径**同形状**的记录让下游无感切换（test-symbols.mjs:309-316），并记 `stats.regex`；`vendorImport` 失败返回 null，插件照常启动（lib/symbols.js:484-495）。
- LLM 聚类失败/漏组件 → `heuristicCluster`（lib/cluster.js:219-244）+ `fillMissing`（lib/cluster.js:247-268）按目录补回、无处归属建 `misc`；「组件数守恒」被多处断言钉住（test-cluster.mjs:141、:185、:198）。
- 变更采不全 → `collectChangeSet` 返回 `fallback:'full'`，「采不到」绝不当成「没变化」（lib/change-set.js:102-103）。
- 快照版本不符/坏 JSON → `loadSnapshot` 返回 null 退化全量，「宁可重写也不误判」（lib/incremental.js:94-99）。
- 无符号可判的文章 → `filterStaleTasks` 保守保留并标 `symbolFallback`（lib/incremental.js:179-184）。
- 垃圾模型回复 → `parseJsonLoose`（lib/cluster.js:135-153）尽力抢救；工具参数坏 JSON → `parseToolArgs` 三级解析后当工具结果回灌让模型自己改（lib/agentic.js:476-500）。
- 未登记错误码归 `engine-unknown`、未登记 blocker kind 降级 `engine-error`（lib/engine/contract.js:171-182、:88-94）——协议容错而非崩溃；git 命令失败返回 null 变成可上报状态而非异常（lib/engine/quality-gate.js:90-102；`detectLinkedWorktree` 同理放行，index.js:435-451）。
- 降级有边界：非源码文件无归属只记 warning、不触发全量（`isSourcePath`，lib/update-planner.js:33-36）；符号图无边时 `planUpdate` 记 warning、反向依赖影响不可用（lib/update-planner.js:156-158）。

### 5. 命名与 id 约定：组件 id、三套 slug、frontmatter 契约

- 组件 id：`<相对路径>#<符号名>`，方法为 `#<类名>.<方法名>`（lib/symbols.js:10-11、:652）；刻意用 `#` 而非上游的 `::`，避免 Windows 盘符 `C:` 混淆。
- slug 化有三套并存且语义不同的策略：`normalizeModuleName`（lib/cluster.js:198-206）面向文件名、空格转 `_`、空串回落 `'module'`；`slugify`（index.js:1741）保留 CJK 转 `-`，避免多个中文目录塌缩成单模块；`moduleSlug`（lib/engine/mapping.js:38）kebab-case，与 cw 现有命名一致。三者不可混用，测试分别覆盖（test-cluster.mjs:113-118、test-semantic-plan.mjs:108）。
- 文章 frontmatter 契约：必填 `title`/`type`/`source_files`/`tags`，`type` 与目录经 `TYPE_BY_DIR` 匹配，必需章节按类型配置 `REQUIRED_SECTIONS`，根目录 `_architecture.md`/`_index.md`/`_patterns.md` 走 `ROOT_TYPES` 推断（lib/article-contract.js:28 起）。
- 稳定文本形态也是契约：`formatComponents` 每行 `id <TAB> kind <TAB> name(参数)`（lib/cluster.js:28-46），测试的 `fakeLlm` 解析依赖它（test-semantic-plan.mjs:73），改格式需同步改消费方。

### 6. 错误处理风格：可机读分类 + 冻结枚举 + 未登记即报错

错误不是字符串而是带 `kind`/`state`/`code`/`severity` 的结构，词表冻结只可追加，映射未命中要显式暴露：

- `collectChangeSet` 的 `state` 枚举（`missing-base`/`no-git`/`git-error`/`unreachable-base`/`ok`）+ `reason` + `fallback`（lib/change-set.js:73-93）。
- `TERMINAL_OUTCOMES`/`BLOCKER_KINDS`/`ENGINE_ERROR_CODES` 全 frozen、`ENGINE_STAGES` 为固定顺序的阶段数组（lib/engine/contract.js:24-67）；`GATE_DEFECT_KINDS` 等三类词表同（lib/engine/quality-gate.js:45-72）。
- 写入侧校验：`gateNativeOutput` 写入未登记 kind 直接抛错（lib/engine/quality-gate.js:406、:410）；`APPLY_RESULT_KINDS` 每个必须在 `pushProblem` 登记，否则启动期抛错（lib/engine/apply-plan.js:428-431）；`OUTPUT_PROBLEM_KINDS` 未登记 kind 被拒（lib/engine/output.js:22-34、:188，test-engine-output.mjs:214-217）。
- 转换侧兜底：`toContractBlockers` 对一一对应不了的 blocker 统一归 `quality-gate` 并在 `detail` 保留原 kind（lib/engine/quality-gate.js:589-596）。
- 协议违规同样分类：`not-json`/`unknown-request`/`late-result`/`duplicate-result`/`bad-shape`（lib/engine/client.js 的 `createProtocolReader`）。
- 文章问题分 error/warning 两级：结构破坏拒写、章节缺失放行降 partial（`SEVERITY`/`hasBlockingIssue`，lib/article-contract.js）。
- `compareLock` 返回可机读 `status`（absent/match/drift/unhealthy）与 `diffs`，而非布尔或异常（lib/engine/manifest.js:86-111）。

### 7. 终态诚实：最弱终态合成 + canAdvanceBaseline 闸门

「1 篇成功 + 19 篇失败也曾被报成 done 并推进基线」是仓库反复引用的教训，由此固定成一组硬不变量：

- `engineResult` 非法输入抛错而非静默归一：`done` 带 blockers、`partial` 无 blockers、`failed` 无 error 都抛（lib/engine/contract.js:97-147）；反序列化边界再过一遍 `validateEngineResult`（:186-220）。
- 多环裁决取最弱：`weakest(weakest(engine, gate), apply)`，`done` 带 blockers 自动降 `partial`，`partial` 无 blockers 兜底补 `quality-gate`（lib/engine/native-run.js:41-42、:399-418）。
- 质量门把问题机读地分成 defect/degradation/stale 三类，回答「谁来修、修什么」，只有三类皆空才 `done`（lib/engine/quality-gate.js:15、:45-72、:533-536）。
- 基线闸门：`judgeOutcome`（lib/update-record.js:37-128）产出 blockers 与 `canAdvanceBaseline`，只有 `done` 才允许推进基线（:124）；未映射源码变更、缺 `source_files`、质量闸门不过都阻止推进。
- 多条判定路径必须同一口径：`toContractBlockers`（quality-gate.js:589）、`toApplyBlockers`（apply-plan.js:309-320）、`toQualityIssues`（quality-gate.js:610）把各类结论统一翻到契约词表，防「一个严一个松」。

### 8. 版本号契约：每个落盘结构都带 version，版本不符当没有

- 版本常量成套出现：`CHANGE_SET_VERSION`（lib/change-set.js:19）、`SNAPSHOT_VERSION`（lib/incremental.js:19）、`UPDATE_PLAN_VERSION`/`MODULE_MAP_VERSION`（lib/update-planner.js:26、:26）、`UPDATE_RECORD_VERSION`（lib/update-record.js:17）、`ENGINE_CONTRACT_VERSION`（lib/engine/contract.js:20）、`ENGINE_PROTOCOL_VERSION`（lib/engine/client.js:27）、`GATE_VERSION`（lib/engine/quality-gate.js:42）、`APPLY_VERSION`（lib/engine/apply-plan.js:43）、`MANIFEST_VERSION`（lib/engine/manifest.js:19）。
- 读取端一律「版本不符返回 null、退化全量」：`loadSnapshot`（lib/incremental.js:94-95）、`loadUpdateRecord`（lib/update-record.js:229）。
- 序列化本身是契约：`ChangeSet` 必须能 JSON 往返（test-change-set.mjs:196-203，因为它要写进 `update-record.json`）；`engine.deps.ok` 只有严格 `=== true` 才算通过（lib/engine/contract.js:134）。
- 协议版本与结果契约版本分开演进（client.js:27 vs contract.js:20）——「行怎么长」与「结果字段」独立升级。

### 9. 路径归一化与写集白名单：跨平台收口 + 越界防护

Windows 反斜杠、MSYS 盘符、`./` 前缀、`../` 越界在多个模块反复收口：

- 归一：`normRel`（lib/incremental.js:118-120）、`normChangePath`（lib/change-set.js:33-40，越界路径直接丢弃）、`normalizeArticlePath`（index.js:280）、`normalizeIndexLinks`/`normalizeIndexLinksIn`（index.js:284-292、lib/engine/apply-plan.js:376-390）、`normalizeCwd`（index.js:62-67，MSYS `/e/...`→`E:/...`）。
- 越界防护：`safeRelPath`（lib/agentic.js:266）拒绝 `../`/绝对路径/盘符；`makeFsWorkspace` 再兜一层「真实绝对路径必须落在 cwd 内」（lib/agentic-host.js:113-118）。
- 写集白名单：`APPLY_WRITE_ROOTS = ['.codewiki', 'CodeWiki.md']`（lib/engine/apply-plan.js:86），`checkWriteTargets`（:86-131）拒绝绝对路径/盘符/`..` 上跳/白名单外，残缺写集整批拒写；文章侧 `makeWriteSet`/`isWritable`（lib/article-contract.js:352-378）编译 `allowedWritePaths` 校验越界（生产传参见 index.js:2952），agentic 子模块只下传子自己那一条路径（lib/articles-agentic.js:112）。
- 提交边界：只 add `WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` 两个 pathspec、不用 `-A`（index.js:58、:4933-4934）；`verifyCommitScope` 用 `git show --name-only` 反查提交是否只动了 wiki 产物（lib/engine/apply-plan.js:224-237）。

### 10. 目录约定与瘦身持久化：`.codewiki/` 布局与「不塞源码」

- wiki 根与入口固定：`WIKI_DIR='.codewiki'`、`WIKI_ENTRY='CodeWiki.md'`，配套 `WIKI_META_REL`/`WIKI_UPDATE_RECORD_REL`/`WIKI_MODULES_REL` 常量（lib/engine/mapping.js:30-34）。
- 状态文件各有 REL 常量且集中：`SNAPSHOT_REL=temp/symbol-graph.json`（lib/incremental.js:22）、`MODULE_MAP_REL=temp/module-map.json`（lib/update-planner.js:27）、`UPDATE_RECORD_REL=temp/update-record.json`（lib/update-record.js:18）、`ENGINE_LOCK_REL=.codewiki/engine-lock.json`（lib/engine/manifest.js:20）；快照与更新记录落 `temp/` 且随 wiki 入库，避免换机器退化全量（lib/incremental.js:20-21）。插件侧另有 `REPOS_FILE`（index.js:2146）维护已知仓库清单。
- `.codewiki/` 自身产物不算源码变更：`isWikiProduct`（lib/change-set.js:26-29）把它从 `sourceChanges` 分离进 `ignored`，否则增量永远 dirty。
- 瘦身持久化：`SLIM_FIELDS`（lib/incremental.js:26）不存 `sourceCode`，`bodyHash`/`codeHash` 固化进快照让 `graph-diff` 走缓存分支（lib/graph-diff.js:109、:124）；`plan.graph` 显式不含 `sourceCode`（index.js:1456，体积 <400KB 防线见 test-semantic-plan.mjs:165-167）；`buildUpdateRecord` 只存摘要、不塞整张符号图（lib/update-record.js:131-132）。
- 依赖隔离也走目录约定：tree-sitter WASM 语法装在 `vendor/tree-sitter` 独立 npm 根（lib/symbols.js:21-25），不破坏插件 `node_modules`。

### 11. 原子写与回滚：写 tmp 再 rename，先拍快照再落盘

- 原子写：`writeLock` 先写 `${file}.${pid}.tmp` 再 `renameSync`（lib/engine/manifest.js:131-133）。
- 落地器回滚：`capturePre`/`restorePre`（lib/engine/apply-plan.js:138-176）预拍现场；三条硬不变量——写集封闭 / 索引基线失败即回滚 / 提交失败不回滚（lib/engine/apply-plan.js:138-150），由 test-engine-apply-plan.mjs 逐条钉死（索引失败回滚 :305-323、基线失败回滚 :325-338、提交失败不回滚 :357-401）。
- 回滚本身可能失败：`restorePre` 恢复失败只记账不中断（apply-plan.js:155），极端磁盘故障下需人工介入。
- 写前比对避免空转：`sameSnapshotContent`（lib/incremental.js:53-66）保证代码没变时不覆盖快照，防 `autoCommit` 为「只改时间戳」生成空转提交；写入顺序敏感处显式注释（如首跑落锁推迟到落地器之后，native-run.js:423-438）。

### 12. 凭证边界：loopback + 占位 key + 日志脱敏

插件「既不保存也不传递密钥」是硬约束，原生引擎桥为此固定了一套安全边界：

- 桥不读凭证文件、不接收真实 `api_key`、不转发 `Authorization`：`toLlmRequest` 返回值里永远没有 `apiKey` 字段（lib/engine/openai-bridge.js:27-28，断言见 test-engine-bridge.mjs:348-356）。
- 三重防护缺一不可（lib/engine/llm-bridge.js:230-233）：绑定 `127.0.0.1`（`server.listen(0, '127.0.0.1')`，:230）、随机端口、每次启动 `randomBytes(32)` 生成的 `dsh-bridge-…` 占位 key（:96），同格式但非本次生成的 key 一律 401。
- 日志脱敏：`bearerOf` 取完 token 即弃（lib/engine/llm-bridge.js:38-43）；错误体不回显收到的 key（:123-124）；测试断言日志不含 authorization/占位 key（test-engine-llm-bridge.mjs:232-247），`terminateProcessTree` 的 `onLog` 不含凭证字样（test-engine-process-tree.mjs:114-128），持久化 job 里没有桥占位 key（test-engine-native-job.mjs 用例 1）。

### 13. 独立脚本测试：check() 微型框架 + 退出码收尾

全部测试都是 `node test-*.mjs` 直接运行的独立脚本，零第三方断言库（只用 node: 内置模块），共用一套手写 `check(label, fn)` 计数器：

- 同款实现遍布：test-cluster.mjs:13、test-semantic-plan.mjs:11、test-change-set.mjs:15-18、test-article-contract.mjs:20-23、test-agentic.mjs:12-21、test-agentic-host.mjs:12、test-agentic-fallback.mjs:20、test-articles-agentic.mjs:18、test-engine-bridge.mjs:31-34、test-engine-llm-bridge.mjs:22-25、test-engine-native-job.mjs:43-47、test-batch.mjs:17。
- 末尾统一汇总 `N passed, M failed`，失败置 `process.exit(1)` 或 `process.exitCode = 1`（如 test-change-set.mjs:205-209）。
- 变体：test-wiki-anchors.mjs 分 `check`（硬断言，:172-176）与 `soft`（软报告，:177-180）两档，同步类失败在源文件滞后时可降级。
- 已知代价：各脚本各维护一份框架、没有复用也没有 `node:test`（test-cluster.mjs:12-13 与 test-semantic-plan.mjs:10-11 各一套），新增断言需手动对齐写法。

### 14. 真环境测试与回归护栏：桩测逻辑，真环境测边界

容易「悄悄出错却不报错」的地方用真实 git/真进程/真产物验证；已修缺陷一律补回归用例钉死：

- 临时 git 仓库：`makeRepo()`（test-change-set.mjs:23-42）每场景 `git init` + 基线 commit；`gitRepo()`（test-engine-apply-plan.mjs:601-648）用真 git 验证 `verifyCommitScope`——「它判的就是提交里到底有什么，桩不出真值」。
- 真实进程树：`startTree()`（test-engine-process-tree.mjs:32-43）起两层真进程，验证孙进程不留孤儿——kill bug 只在真实进程树里出现。
- 真进程假引擎：test-fixtures/fake-native-engine.mjs 让 client.js 的 spawn/stdin JSON-lines/stdout 解析全走真代码；`realSourceFiles`（:81-98）真扫仓库源码，避免 `source_files` 硬编码触发 `source-missing`。
- 真 git worktree：test-worktree.mjs:19-28 搭 linked worktree；无 git 环境整体 SKIP 退出 0（:30-36），不误报成功。
- 端到端样例仓库：test-semantic-plan.mjs:20 用 `fs.mkdtempSync` 造「目录≠职责」的仓库验证语义聚类；极端路径由 tools/fsoft-engine/probe-no-llm-graph.py 默认分析「中文 空格 fixture」（路径含中文与空格）覆盖。
- 回归护栏：下钻 `maxDepth` 布尔开关缺陷由 test-cluster.mjs:269-343 钉死；`subDepth` 无限递归由 test-articles-agentic.mjs:182/:201「看磁盘层数 + 调用次数有界」守护；CRLF 下 `str_replace` 匹配不上（test-agentic.mjs:542）、`insert` 负数行号（test-agentic.mjs:589）、`generate_sub_module` 谎称已派发（test-agentic.mjs:401）均以对抗用例固定；test-batch.mjs 的 `fixAnchors` 用例是守护已修 bug 的 load-bearing 断言。增量侧「从不建边导致反向依赖判定失效」的缺陷修复也以 `resolveImportEdges` 在 index.js:2238 的显式补边留痕。
