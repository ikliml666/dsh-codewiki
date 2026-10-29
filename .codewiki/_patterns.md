---
title: 仓库反复出现的模式
type: pattern
source_files:
  - index.js
  - lib/agentic-host.js
  - lib/agentic.js
  - lib/article-contract.js
  - lib/articles-agentic.js
  - lib/change-set.js
  - lib/cluster.js
  - lib/git-paths.js
  - lib/graph-diff.js
  - lib/incremental.js
  - lib/symbols.js
  - lib/update-planner.js
  - lib/update-record.js
  - lib/engine/apply-plan.js
  - lib/engine/client.js
  - lib/engine/contract.js
  - lib/engine/llm-bridge.js
  - lib/engine/manifest.js
  - lib/engine/native-run.js
  - lib/engine/native-state.js
  - lib/engine/output.js
  - lib/engine/process-tree.js
  - lib/engine/quality-gate.js
  - lib/engine/python/entry.py
  - lib/engine/python/stage_map.py
  - test-batch.mjs
  - test-change-set.mjs
  - test-cluster.mjs
  - test-cwd-paths.mjs
  - test-engine-apply-plan.mjs
  - test-engine-client.mjs
  - test-engine-contract.mjs
  - test-engine-native-incremental.mjs
  - test-engine-native-job.mjs
  - test-engine-process-tree.mjs
  - test-engine-python-entry.mjs
  - test-engine-quality-gate.mjs
  - test-graphdiff.mjs
  - test-incremental.mjs
  - test-orchestration.mjs
  - test-prune-orphans.mjs
  - test-semantic-plan.mjs
  - test-symbols.mjs
  - test-update-record.mjs
  - test-wiki-anchors.mjs
  - test-wiki-entry.mjs
  - test-worktree.mjs
  - test-fixtures/fake-native-engine.mjs
  - test-fixtures/gen-graphdiff-golden.py
  - tools/fsoft-engine/setup-env.sh
tags: [pattern, conventions, testing, error-handling, contract, pipeline]
---

## Overview

dsh-codewiki 是一个零子代理、批量流水线的 CodeWiki 编译插件：Node 侧编排（`index.js` 与 `lib/` 下的纯函数库）负责规划、源码装填、并发执行、文章契约闸门与落盘；可选的 FSoft 原生引擎通道（`lib/engine/`）把编译外包给 Python 子进程，并以严格裁决链收口。本文横向汇总各模块文章中反复出现的工程模式，覆盖四个维度：可测性设计（纯函数 + 依赖注入）、测试基建与流程（零框架 check 脚本、mock LLM、假引擎、SKIP 语义、环境隔离）、错误处理风格（显式降级、机读枚举、严格终态裁决）、目录与命名约定（`.codewiki/` 布局、`_` 前缀跳过、`TYPE_BY_DIR`、组件 id 形态）。每条模式均引用模块文章中出现的文件与函数名作为证据。

## Patterns

### 纯函数 + 依赖注入的可测性设计

核心逻辑一律写成不碰文件系统、不绑死服务的纯函数，IO 与外部服务经参数注入，使每个决策可单测。

- `collectChangeSet(cwd, baseCommit, opts)` 把 git 执行器作为 `opts.execFile` 注入（lib/change-set.js:108-210），`defaultExecFile` 只是缺省实现（lib/change-set.js:43-50）；`test-change-set.mjs:203-220` 注入假执行器并断言它真的被调用。
- lib/article-contract.js 全模块纯函数，`inspectArticle` 经 `opts.fsImpl`/`cwd` 注入存在性探测（lib/article-contract.js:213-227），真正的落盘动作留在调用方（index.js 的 `contractCheck`，index.js:590）。
- lib/cluster.js 的 `clusterComponents` 接受注入的 `llmCall(prompt)=>string`（lib/cluster.js:291-297），缺省时退 `heuristicCluster`（lib/cluster.js:219）。
- lib/agentic.js 的 `runAgenticArticle` 只消费裸消息与注入的 `streamFn`，不绑死任何 llm 服务（lib/agentic.js:331-345）；宿主适配集中在 lib/agentic-host.js 的 `makeHostStream`（lib/agentic-host.js:83）。
- lib/engine/apply-plan.js 刻意不 import index.js，`runCw`/`commit`/`normalizeIndexLinks`/`verifyCommit` 全部由 `deps` 注入（lib/engine/apply-plan.js:24-27），默认内置同语义的 `commitWikiArtifacts`（lib/engine/apply-plan.js:260-308）。
- lib/engine/native-run.js 的 `runNativeJob` 经 `deps` 注入 doctor/runEngine/gate/apply/collectChangeSet/engineFor（lib/engine/native-run.js:129-136）；test-engine-native-job.mjs:544-622 换假 `runEngine` 但保留真 gate/apply。
- lib/engine/manifest.js 的 `probeEnvironment` 只调注入的 `probe()`，不在模块内 spawn（lib/engine/manifest.js:34-45）。

### 零框架测试脚本约定（check / 计数 / 退出码 / SKIP）

全部测试不依赖测试运行器，直接 `node test-xxx.mjs` 运行（test-batch.mjs 要求 Node ≥20，见 test-batch.mjs:15-17），共享同一套轻量框架。

- 顶部自带 `check(cond, msg)` 断言器：test-batch.mjs:17-20、test-orchestration.mjs:27-30、test-wiki-anchors.mjs:172、test-symbols.mjs:17-36（同步/异步双版本）、test-cluster.mjs:13、test-semantic-plan.mjs:11、test-prune-orphans.mjs:14-16（async）、test-engine-contract.mjs:34-37、test-engine-client.mjs:29-32。
- 统一收口：`passed`/`failures` 计数，结尾按失败数设退出码——`process.exit(failures ? 1 : 0)`（test-batch.mjs:638-642、test-orchestration.mjs:26、test-cluster.mjs:417-420）。
- 软硬两档断言：test-wiki-anchors.mjs 的 `check`（:172）与 `soft(msg)`（:177），软报告记入 `softReports` 不算失败。
- fixture 就地构造：`makeFixtureRepo()` 强制 git identity（test-orchestration.mjs:109-126）；test-worktree.mjs:19-27 用真实 git 子进程搭 linked worktree。
- 环境缺失时 SKIP 而非误报：无 git 整体 SKIP（test-worktree.mjs:32）、web-tree-sitter 不可用 SKIP（test-symbols.mjs:42-45）、找不到引擎 venv 显式 SKIP（test-engine-python-entry.mjs:47-51）、真产物路径不存在整组 SKIP（test-engine-quality-gate.mjs:508-509）。反例：对拍黄金基准缺失必须 `exit(1)` 提示先生成（test-graphdiff.mjs:14-17），不许覆盖率静默空转。

### mock 宿主 LLM 与假引擎替身体系

跨边界依赖（宿主 llm 服务、Python 引擎）一律用确定性替身替换，且替身必须复刻真实协议/副作用。

- test-batch.mjs 的 `makeLlm(reply)`（test-batch.mjs:174-189）按宿主 block 协议 yield `block-start`/`text-delta`/`usage`/`finish`，`reply` 可为函数或 Error（走 `finish{kind:'error', failure:{code:'MOCK_FAIL'}}`）；`makeSlowLlm`（test-batch.mjs:233-243）+ `poolProbe()`（test-batch.mjs:244-259）做分池并发峰值探针。
- test-orchestration.mjs 的 `makeBatchMock`（test-orchestration.mjs:144-226）按 prompt 首行特征分发应答（`answerFor`，:147-195，识别「你是 CodeWiki 文章作者」「总结仓库反复出现的模式」等区分句）；`llmProxy` 恒转发模块级 `activeLlm`（:133-140），块间用 `restore()` 还原（:225）。
- test-semantic-plan.mjs 的 `fakeLlm` 按 `llm.stream()` 生成器协议产出 block 事件，分别模拟正常 JSON/坏 JSON/请求抛错（test-semantic-plan.mjs:83、116、132）。
- test-fixtures/fake-native-engine.mjs 是「真进程、假算法」的引擎替身：`modeOf` 从仓库外模式文件解析行为（test-fixtures/fake-native-engine.mjs:27-40）、`logCall` 写 `.native-calls-<tag>.log` 足迹（:52-57）、`readStateInputs` stat 受管状态证明水合真被消费（:65-88）、`writeDocs` 只写协议产物（:131-201）。
- test-engine-client.mjs 用真实 Python 子进程当假引擎，`FAKE_MODE` 环境变量切换 ok/garbage/noresult/crash 等协议模式（test-engine-client.mjs:162-241）。
- 桩必须复刻真行为：test-engine-apply-plan.mjs:105-134 的 `recordingDeps` 忠实模拟真 `cw` 副作用（init/index/meta 各写对应文件），否则回滚测试没有意义；`makeBatchMock.answerFor` 伪造回文必须让 `source_files` 真实存在（test-orchestration.mjs:154-168），否则被文章契约闸门判 partial。

### 显式降级：state + fallback + 记账，绝不静默

任何「做不全」的情形都被显式暴露为结构化状态 + 人类可读原因，而不是静默返回空或吞掉。

- `collectChangeSet` 对 `missing-base`/`no-git`/`git-error`/`unreachable-base` 各返回带 `state`+`reason` 的非 ok ChangeSet，`fallback:'full'`（lib/change-set.js:79-99、108-210）。
- lib/symbols.js：AST 任何一环失败（依赖缺失/ABI 不匹配/解析零符号）退正则兜底 `regexExtract`（lib/symbols.js:374-440），记 `stats.regex`（lib/symbols.js:551-594）。
- lib/cluster.js：LLM 缺失/抛错/坏 JSON 一律 `stats.fallbacks+=1` 并退 `heuristicCluster`（lib/cluster.js:310-324）。
- index.js 的 `semanticPlan` 失败返回 `{plan:null, fallback:true, reason}`（index.js:1412-1495），`buildPlan` 降回 `localPlan`（index.js:1372）。
- lib/update-planner.js：无归属源文件进 `unmappedChanges` 并强制 `needsFull`（lib/update-planner.js:392）；非源码文件只 warning 不触发全量。
- lib/engine/native-state.js 的 `isUpdateEligible`：缺图/缺树/引擎版本不符 → 显式 full 并写 `fallbackReason`（lib/engine/native-state.js:256-303）。
- lib/incremental.js 的 `loadSnapshot` 版本不符或坏 JSON 返回 null 退化全量（lib/incremental.js:94-104）；老快照缺固化 `codeHash` 时保守保留（test-incremental.mjs:109-118）。
- 记账而不中断：`parseClusterResponse` 把丢弃的 id 记进 `warnings`（lib/cluster.js:156-195）；`parseToolArgs` 坏 JSON 记 `steps.warning` 回灌让模型自改（lib/agentic.js:476-500）；`fixAnchors` 未找到/歧义只记 `unresolved`（index.js:936）。

### 机读枚举登记表与未知项保守归类

问题类别、错误码、阻塞原因全部落成冻结枚举，消费方按 kind 分派而非 message；未知项兜底归类并保留原始值，绝不静默丢弃。

- lib/engine/contract.js：`BLOCKER_KINDS`（lib/engine/contract.js:57-72）、`ENGINE_ERROR_CODES`（:76-86）、`RETRYABLE_CODES`（:90）；未知错误码落 `engine-unknown` 并保留 `rawCode`（`engineError`，:204-215）。
- lib/engine/output.js：`OUTPUT_PROBLEM_KINDS` 冻结表（lib/engine/output.js:22-34）。
- lib/engine/quality-gate.js：`GATE_DEFECT_KINDS`/`GATE_DEGRADATION_KINDS`/`GATE_STALE_KINDS`（lib/engine/quality-gate.js:45-72）；未登记 kind 抛错式暴露不许静默吞（:435-436）；`toContractBlockers` 映射不上一律归 `'quality-gate'`（:589-596）。
- lib/engine/apply-plan.js：`APPLY_PROBLEM_KINDS`/`APPLY_RESULT_KINDS`（lib/engine/apply-plan.js:53-74）；`toApplyBlockers` 的 kind 必须落在 contract 枚举内否则抛错（:322-333）。
- lib/article-contract.js：`SEVERITY` kind→严重度映射（lib/article-contract.js:56-73），未登记缺省按 error（:234）。

### 契约与协议版本号，版本不符一律视为无效

每类持久化结构与跨进程协议都带版本常量；回读时版本不符按「无效、走保守路径」处理，而不是抛错。

- 版本常量齐备：`ARTICLE_CONTRACT_VERSION`（lib/article-contract.js:16）、`CHANGE_SET_VERSION`（lib/change-set.js:20）、`SNAPSHOT_VERSION`（lib/incremental.js:19）、`UPDATE_PLAN_VERSION`/`MODULE_MAP_VERSION`（lib/update-planner.js:26、26）、`UPDATE_RECORD_VERSION`（lib/update-record.js:17）、`ENGINE_CONTRACT_VERSION`（lib/engine/contract.js:20）、`ENGINE_PROTOCOL_VERSION`（lib/engine/client.js:27）、`MANIFEST_VERSION`（lib/engine/manifest.js:20）、`NATIVE_STATE_VERSION`（lib/engine/native-state.js:46）、`APPLY_VERSION`（lib/engine/apply-plan.js:44）、`GATE_VERSION`（lib/engine/quality-gate.js:43）。
- 版本不符视为无效：`loadSnapshot` 返回 null（lib/incremental.js:94-104）、`loadUpdateRecord` 返回 null（lib/update-record.js:229-238，test-update-record.mjs:199-204）、`readState` 记 `code:'version'` 退全量（lib/engine/native-state.js:204-211）。
- 跨语言枚举双向对账：lib/engine/python/stage_map.py 的 `ENGINE_STAGES` 与 lib/engine/contract.js:24-33 必须一字不差（stage_map.py:20-29；test-engine-python-entry.mjs:344）。
- 协议版本独立于契约版本：hello 行版本不符记 `protocol-version` 违规（lib/engine/client.js:74-80）。

### 路径归一化与编码鲁棒性（POSIX、git 转义、CRLF、中文）

反斜杠/盘符/`../` 的路径治理和 git 八进制转义解码被反复实现，中文与非 ASCII 路径是显式验收项。

- lib/git-paths.js：`decodeGitPath` 按字节重拼 Buffer 解八进制转义（lib/git-paths.js:37-72）、`withQuotepathOff`/`GIT_QUOTEPATH_OFF`（:20-27）。
- lib/change-set.js 的 `normChangePath`：反斜杠→`/`、拒绝绝对路径/盘符/`../`（lib/change-set.js:34-41）。
- index.js：`normalizeArticlePath`（index.js:289）、`normalizeIndexLinks`（index.js:293）、`normalizeCwd` MSYS 盘符归一（index.js:52-57）；test-wiki-entry.mjs 第 6 组与 test-cwd-paths.mjs:22-45 分别钉住。
- 同一取向多次实现：`normalizeWritePath`（lib/article-contract.js:357-361）、`normRel`（lib/incremental.js:118-120）、`safeRelPath`（lib/agentic.js:266-273）、`posix`（lib/engine/native-state.js:62）。
- 非 ASCII 硬约束：`graphFileName` 必须用 `\p{L}\p{N}` 对齐 Python `sanitize_repo_name`（lib/engine/native-state.js:146-150）；lib/engine/python/entry.py 钉 UTF-8 三流并给 `subprocess.Popen` 打补丁（entry.py:62-95）；`verifyCommitScope`/`defaultVerifyCommit` 必须关 quotepath + 解码，否则中文页名被误判越界（lib/engine/apply-plan.js:210-247）。
- 编码与换行鲁棒性：`yamlScalar` 只在不安全时加双引号（lib/engine/quality-gate.js:268-287）；`parseFrontmatter` 剥 BOM（lib/article-contract.js:77）；`makeArticleEditor` 的 `str_replace` 匹配前归一 CRLF、命中后按原文风格写回（lib/agentic.js:216-229）；`numberLines`/`fixAnchors` 的 CRLF 用例（test-batch.mjs:48-52、523-603）。

### 严格终态裁决与基线推进闸门

终态由最弱一环决定，`done` 受硬不变量约束；基线只在完全成功时推进，失败/降级一律冻结。

- lib/engine/contract.js 的 `engineResult` 硬不变量：`done` 不许带 blockers、`partial` 必带、`failed` 必有 `error`（lib/engine/contract.js:116-180）；`validateEngineResult` 在反序列化边界复核（:219-260）。
- lib/engine/native-run.js：`RANK`/`weakest` 取最弱终态合成（lib/engine/native-run.js:75-76）；done 带 blockers 降级 partial。
- lib/update-record.js 的 `judgeOutcome`：blockers 累积 + `canAdvanceBaseline`（lib/update-record.js:37-128）；「1 成功 19 失败」必须 partial（test-update-record.mjs:62-76，旧实现误判 done 的回归锚）。
- lib/article-contract.js 的 `hasBlockingIssue`：error 拒写、warning 放行降 partial（lib/article-contract.js:346-348）。
- lib/engine/quality-gate.js：`done ⟺ defects/degradations/stale 三类皆空`（lib/engine/quality-gate.js:525-536）。
- lib/engine/apply-plan.js 的 `done()`：有 blockers 时 done→partial（lib/engine/apply-plan.js:645-655）；「未提交且非 noChanges 绝不允许 done」（:984-989）。

### 写集白名单封闭

所有写盘点共享同一把白名单尺子；越界是整批拒写/显式报错，而不是跳过单条。

- lib/article-contract.js 的 `makeWriteSet`/`isWritable`（lib/article-contract.js:352-378）；agentic 通道越界写 `stopReason:'write-set'`（lib/articles-agentic.js:155-167），子模块只拿自己那条路径的写集（lib/articles-agentic.js:67）。
- lib/agentic.js 的 `safeRelPath` 拒绝绝对路径/盘符/`../`（lib/agentic.js:266-273）。
- lib/engine/apply-plan.js：`APPLY_WRITE_ROOTS = ['.codewiki','CodeWiki.md']`（lib/engine/apply-plan.js:126）；`checkWriteTargets` 整批拒写（:87-132）；`checkDeleteTargets` 同尺子且拒目录目标（:442-490）；`collectPruneTargets` 裁剪根必须落白名单（:505-519）。
- index.js 的 `pruneOrphanModules` 只在 full、只删 `.codewiki/modules/*.md`、失败文章保留（index.js:351-376；test-prune-orphans.mjs）。
- 链接白名单：index.js 的 `allowedLinkTargets` 构造 `allowedLinks` 喂 `inspectArticle` 判死链（index.js:617-639）。

### pre-image 快照与同事务落地/回滚

落地器把「写盘 → 索引 → 基线 → 提交」做成一个事务：失败按阶段回滚，状态文件与文章共享同一 pre-image。

- 三条硬不变量写在 lib/engine/apply-plan.js 文件头（:10-22）：写集封闭、索引/基线失败即回滚、提交失败不回滚。
- `capturePre` 拍 pre-image（lib/engine/apply-plan.js:161-176）、`restorePre` 逆序恢复（:156-177）、`rollback` 恢复并删除本次新建的 `.codewiki/`（:787-793）。
- 受管状态文件、首次引擎锁（`buildLockBody`）、孤儿页删除与文章共享同一 pre-image/同一回滚/同一提交（lib/engine/native-run.js:606-682）；落锁曾因事后 `writeLock` 留脏文件而改为进写集。
- `writeAll` 内容逐字节相同跳过重写（lib/engine/apply-plan.js:201-216）。
- 回滚语义逐分支固化：index 失败回滚（:874-924）、基线失败连文章撤回（:943-952）、提交失败只记 `commit-failed` 不回滚（:979-982）。

### JSON-lines 子进程协议与进程树终止

Node ↔ Python 唯一跨语言边界是「一行请求 JSON + stdout JSON-lines」，协议破坏必须产出可机读失败；取消必须整树打穿。

- lib/engine/client.js 的 `createProtocolReader` 纯增量读取器（lib/engine/client.js:39-186）：多字节 UTF-8 跨 chunk 不切坏、单行超限记 `line-too-long`、半行收尾记 `not-json`。
- 协议不变量：每条消息 requestId 匹配；没有 `result` = 协议破坏（退出码 0 也失败，lib/engine/client.js:403-414）；取消后迟到 result 记 `late-result`；重复先到赢。
- lib/engine/python/entry.py 侧对称实现：`emit`/`emit_hello`/`emit_progress`/`emit_result`（entry.py:143-192）；`_ProtocolOnly` 在 import codewiki 前接管 stdout 防 FSoft print 污染协议流（entry.py:98-131）；任何路径都必须返回 result（`handle_request`，entry.py:702-735）。
- 取消打穿进程树：lib/engine/process-tree.js 的 `terminateProcessTree` POSIX `kill(-pid)` SIGTERM→SIGKILL、Windows `taskkill /T /F`（lib/engine/process-tree.js:61-103）；test-engine-process-tree.mjs 用真实孙进程验证不留孤儿。
- 阶段映射唯一口径：stage_map.py 的 `map_stage`/`percent_of`，引擎内部进度封顶 90%（`FSOFT_PROGRESS_CEILING`，stage_map.py:63）。

### 内容指纹防无变化提交

带时间戳的持久化结构比较时一律剥离易变字段做「实质内容」比较，无变化轮不产生纯记账提交。

- lib/engine/native-state.js 的 `stateFingerprint` 去掉 `updatedAt`/`notes` 后比较（lib/engine/native-state.js:425-435）。
- lib/incremental.js 的 `sameSnapshotContent` 忽略 `generatedAt`/`commit` 与顺序（lib/incremental.js:53-66）。
- lib/update-planner.js 的 `sameModuleMap`（lib/update-planner.js:484-492）。
- lib/engine/native-run.js 的 `idleRound` 短路：`update + no_change + 变化集空 + 无未消费账` 才不重写状态/不裁剪/不落锁（lib/engine/native-run.js:632-635）；test-engine-native-incremental.mjs 用例 2 钉死「无变化轮无新提交」。

### 对拍基准与同源规则双重实现

关键判定要么对上游逐位对拍，要么以「同源但独立」的第二次实现做对抗校验；两处规则必须同步维护。

- test-fixtures/gen-graphdiff-golden.py 用 Python 原生 difflib/hashlib 生成黄金基准（种子固定 20261027，gen-graphdiff-golden.py:53），test-graphdiff.mjs:28-42 按 similarity/hash/unified 三类与 lib/graph-diff.js 逐位对拍。
- test-wiki-anchors.mjs 独立重实现 `judgeAnchor`/`symbolsOnLine`，与 index.js `fixAnchors` 内部的 `symbolsWithPos`（index.js:992）、`changelogSections`（index.js:779）同源，做对抗校验（test-wiki-anchors.mjs:187 注释「两处同源，改一处须同步另一处」）。
- 「纯注释降级」在 lib/incremental.js 的 `filterStaleTasks`（:140-194）与 lib/update-planner.js 的 `realChangedIds`（:57-81）实现两次，必须共享同一 `codeHash` 判据（lib/graph-diff.js:108-111）保持一致。
- lib/engine/python/stage_map.py 与 lib/engine/contract.js 的 `ENGINE_STAGES` 双向对账（同上）。

### 大档/默认档分池并发与 customId 记账

批量执行统一走「按 bigTier 分池独立限流的并发池」，结果以 `customId` 为键收进 Map，失败推入 notes 记账。

- index.js 的 `runRealtimeTasks`（index.js:671-730）按 `bigTier` 分池，`bigConcurrency` 缺省跟随 `concurrency`（index.js:101-104）；test-batch.mjs:232-297 用 `poolProbe()` 断言分池峰值。
- lib/articles-agentic.js 的 `runAgenticArticles`（:231-312）补上同款双池（:245-255）；`markBigAgenticTasks`（:320-333）用源文本量等价物替代「装填超预算」判据。
- `prepareArticleTasks`（index.js:1245-1330）四条路径：普通档、大档接管、会话通道兜底、多文件观察批拆分。
- 两条通道返回统一的 `Map(customId→结果)`，失败原因推入 `notes`（test-batch.mjs:343）。

### 命名与目录约定（`_` 前缀、TYPE_BY_DIR、temp/ 状态文件、组件 id）

- `.codewiki/` 布局与 `_` 前缀跳过：`NATIVE_STATE_DIR='.codewiki/_native-state'`（lib/engine/native-state.js:28）首段 `_` 让 `cw index` 跳过（lib/engine/native-state.js:20-28；lib/engine/apply-plan.js:379 的 `seg.startsWith('_')`）；根级特殊文章 `_index.md`/`_architecture.md`/`_patterns.md` 由 `ROOT_TYPES` 登记（lib/article-contract.js:28-32）。
- 目录→type 映射：`TYPE_BY_DIR`（lib/article-contract.js:19-26），`type` 与目录不符判 `type-mismatch`。
- 状态文件集中 `.codewiki/temp/`：`SNAPSHOT_REL='temp/symbol-graph.json'`（lib/incremental.js:22）、`MODULE_MAP_REL`（lib/update-planner.js:27）、`UPDATE_RECORD_REL`（lib/update-record.js:18）；引擎锁 `ENGINE_LOCK_REL='.codewiki/engine-lock.json'`（lib/engine/manifest.js:20）。
- frontmatter 契约：必填 `title/type/source_files`（`REQUIRED_FIELDS`，lib/article-contract.js:46）；tags 必填但允许空列表；source_files 必须是仓库相对文件（`isRepoRelativeFile`，lib/article-contract.js:195-203）。
- slug 保留 CJK：index.js 的 `slugify`（index.js:1660）、lib/cluster.js 的 `normalizeModuleName`（:198-206）都保留中文字符避免塌缩成 `module`。
- 组件 id 约定：`<相对路径>#<符号名>`，唯一来源 `componentId`（lib/symbols.js:776-778），方法为 `#<类名>.<方法名>`；graph-diff/cluster/incremental 三方一致（lib/cluster.js:15、lib/graph-diff.js:10）。

### 运行环境隔离与零构建测试流程

测试通过随机化路径、压缩 tick、仓库外 fixture 与凭证隔离做到可重复、零构建、无密钥。

- JOBS_FILE 随机 token：`TEST_JOB_TOKEN = crypto.randomBytes(4).toString('hex')`（test-orchestration.mjs:22-23；同款 test-engine-native-job.mjs:31、test-engine-native-incremental.mjs:29-31），防 pid 复用读到历史 fixture。
- tick 加速：`DSH_CODEWIKI_TICK_MS='300'`（test-orchestration.mjs:15、test-engine-native-job.mjs:28）；用例选择 `ONLY_CASES=2,5`（test-engine-native-incremental.mjs:172-174）。
- 测试写入物放仓库外：假引擎模式文件与足迹日志放仓库同级（test-fixtures/fake-native-engine.mjs:284-314），否则会被质量门 `uncommitted-input` 判成产品缺陷；`docsDir` 强制仓库外临时目录（index.js 的 `startNativeRun`，:2778）。
- 凭证隔离：test-engine-python-entry.mjs 的 `isolatedEnv` 隔离 HOME + `CODEWIKI_NO_KEYRING=1`（:65-67）；引擎模型通道只走 `CODEWIKI_*` 进程环境变量（entry.py:137-140），占位 key 只活在进程环境、不落 JOBS_FILE（lib/engine/llm-bridge.js:90-96；test-engine-native-job.mjs:309）。
- 零构建与可选依赖：全部测试 `node test-*.mjs` 直跑，无编译步骤；AST 依赖装在独立 npm 根 `vendor/tree-sitter`（lib/symbols.js:21-25）避免污染插件 node_modules；FSoft venv 由 tools/fsoft-engine/setup-env.sh 按冻结快照落盘（setup-env.sh:54-62）。
