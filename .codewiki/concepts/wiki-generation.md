---
title: wiki-generation
type: concept
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
  - wiki-generation
  - codewiki
  - 生成
  - 跨模块
  - 测试
  - 核心
---

## Overview

`wiki-generation` 指 `@local/dsh-codewiki` 插件把代码仓库转化为结构化 CodeWiki 文档的端到端过程。入口工具 codewiki_generate 由 `generateToolDefinition`（`index.js:2230`）定义：纯提交制——`runCw`（`index.js:2230`）跑 cw status 判态、预构建任务后经 `submit`（`index.js:2230`）交给宿主常驻编排服务 `createJobService`（`index.js:2230`）即返回，零 LLM 调用、零子代理、不委托发起会话的主模型。服务以 `TICK_MS`（`index.js:2230`，默认 10s）推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index；0.10.7 起无规划阶段，模块清单由 `localPlan`（`index.js:2230`）按顶层目录本地分组。全部模型环节在插件内完成，唯一通道是 `llmChat`（`index.js:2230`）包装的宿主 llm 服务（0.10.1 起无内置直连、插件零密钥）：普通档 `workbuddy`/`hy3`（`index.js:26-27`，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET`（`index.js:2230`）=110k）；110k–420k 输入自动升大档——默认 `volces-ark`/`glm-5.3-flash`（`DEFAULT_BIG_PROVIDER`（`index.js:30`）/`DEFAULT_BIG_MODEL`（`index.js:31`）声明，512k 上下文），预算 `DEFAULT_BIG_TOKEN_BUDGET`（`index.js:33`）=420k；只有单文件连大档都装不下才转会话通道兜底（`dispatchSessionTasks`（`index.js:2230`））。0.10.9 起编译产物由 `autoCommitWiki`（`index.js:2230`）在插件内自动提交入库，成功时零唤醒（`wakeCompileSession`（`index.js:2230`））。概念横跨文档说明、核心实现、测试验证与运行日志四大模块。

当前基线 0.10.9（package.json:2-3）：0.10.8 起大档单请求优先（放弃 32k 时代拆批策略）并把审校改为批量校对；0.10.6 起面板不藏占串行闸门的工作区外任务；0.10.4 修复思考档位读取方法名并新增大档模型四项。

## Involved Modules

- **docs-and-meta**：README.md（四工具表、关键行为、全部设置、安装与验证，README.md:9-67）、CodeWiki.md（插件自身仓库的 wiki 入口，重启后可用 codewiki_generate 对本仓库重编）、CHANGELOG.md（0.1.0 → 0.10.9 全部行为变更）、.probe3.txt（内容仅一行 `probe` 的探针占位，`.probe3.txt:1`）。
- **core-and-config**：`index.js`（插件全部逻辑，单文件 3082 行）、`client.js`（浏览器半侧：插件页设置卡 + 侧边栏面板，1354 行）、cordis.patch.yml（file:/// 直挂补丁，条目 id codewiki，cordis.patch.yml:13-16）、package.json（exports ./client 与 dsh.client 声明，package.json:8-11、package.json:20-27）、.gitignore（运行期产物不入库，.gitignore:1-12）。
- **test-scripts**：五个自检脚本直接 import 真实 `index.js` 导出——test-batch.mjs（501 行，纯函数与假 llm 执行链）、test-orchestration.mjs（1270 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实 tick）、test-wiki-entry.mjs（76 行，入口生成与 Windows 路径规范化）、test-wiki-anchors.mjs（118 行，行号锚点守卫）、test-cwd-paths.mjs（71 行，路径形态实测）。
- **logs-and-temp**：测试运行落盘日志与排查记录——.tmp-test-batch.log（85 行）、.tmp-test-cwd-paths.log（8 行）、.tmp-test-orchestration.log（573 行）、.tmp-test-wiki-anchors.log（161 行）、.tmp-test-wiki-entry.log（25 行）、watcher2.log（1397 行）。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:9-22（提交制、scope=auto/full/stale 语义、并发默认 2、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）。
   - 设置项与默认值：README.md:24-40（全部 volatile、改完即生效）。
   - 配置链路：设置卡 `save`（`client.js:669`）经 configForms.mutate 单层 op 保存（与 profile patch 手改等价、同样热生效）；`apply`（`index.js:3048`）注入 agents/llm 并创建常驻服务，`liveConfig`（`index.js:3048`）在每次 execute/tick 解包读取。
   - 自举：CodeWiki.md 是插件自身仓库的 wiki 入口，收尾可用 codewiki_generate 重编本仓。
2. **任务提交**：
   - 判态与预构建：execute（`generateToolDefinition`（`index.js:2230`）内 `execute` 闭包自 `index.js:2230` 起）→ `normalizeCwd`（`index.js:2230`）归一化 MSYS 盘符路径 → `excludedItem`（`index.js:2230`）排除清单（报错带命中条目）→ cw status（`runCw`（`index.js:2230`）+ `parseStatus`（`index.js:2230`）四态 missing/uncompiled/clean/stale）→ clean 直接报告（`needsFullCompile` 判定，`index.js:2230`；scope=full 例外强制全量重编）。
   - stale 逐篇更新：按旧文 frontmatter 经 `parseSourceFiles`（`index.js:969`）解析 source_files 预构建任务直达 articles；任务 `mission` 即「以当前代码为准重写其内容，保留章节结构与 title/type/tags」（`index.js:969`）——本篇即该流程产物；missing 态先 cw init（`runCw`（`index.js:969`））再提交全量。
   - 提交语义：`submit`（`index.js:2131`）——submitting 占位挡并发重复提交；编译模型三项校验（`batchProvider` 缺失即落 job failed 诚实报错，`index.js:2147`）；单项目串行（`serialProjects`（`index.js:2131`）默认开：已有项目在推进则进 queued，预置 pendingStage/pendingTasks，前一个终态后 tick 自动轮到）；发起会话 id 存 `job.sessionId`（`index.js:2131`）供终态唤醒；立即返回 {submitted, jobId, stage}。
   - 维护与进度入口：codewiki_update（`updateToolDefinition`（`index.js:2390`））固定 scope=auto、提交后追加「本步收尾、继续下一项」；codewiki_progress（`progressToolDefinition`（`index.js:2390`））只读立即返回，`progressView`（`index.js:2390`）按 taskList 算百分比（无明细任务时为 null——0.10.5 起输出 schema 允许 null）；`jobSummary`（`index.js:2390`）为面板与 progress 共用摘要。
3. **阶段机推进**：`tick`（`index.js:2052`）每 `TICK_MS`（`index.js:1013`）一轮——先跨实例取消拾取与孤儿接管（`ORPHAN_TAKEOVER_MS`（`index.js:2052`），停更超 5 分钟接管）、算单项目串行 activeId，再按 `STAGE_HANDLER`（`index.js:2052`）分发。任务持久化 `JOBS_FILE`（`index.js:2052`，tmp 下 dsh-codewiki-jobs.json，只留 `MAX_JOBS_KEPT`（`index.js:2052`）=30 条；进程级 lock + 脏标记 + 磁盘合并防多实例互覆）。

```text
模型调用 codewiki_generate (index.js:2210)         纯提交、零 LLM、零子代理
        │ cw status 判态 → 任务预构建 → submit (index.js:2111) 即返回 {jobId, stage}
        ▼
createJobService tick (index.js:2032) ──单项目串行──► queued 排队
        ▼
articles (index.js:1599) ── prepareArticleTasks (index.js:557) 源码装填
        │   ≤110k 普通档 │ 110k–420k 大档单请求 │ >420k 观察→合成 │ 单文件超限 → 会话通道
        │ submitBatchFor (index.js:1481) → runRealtimeTasks (index.js:329) → llmChat (index.js:285)
        ▼
crosscut (index.js:1744) ──总量>420k 拆观察──► compose (index.js:1829)
        ▼
review (index.js:1878) 批量校对（@@标记拆回逐篇）
        ▼
index (index.js:1990): cw index + meta update + ensureWikiEntry
        ▼
autoCommitWiki (index.js:2904) ──提交成功──► 不唤醒会话（零打扰）
        └──拒绝/失败──► wakeCompileSession (index.js:1202) 一次性「产物待提交」
```

   - articles：`tickArticles`（`index.js:1619`）——full 任务在阶段开头就地 `localPlan`（`index.js:1619`）生成清单（输入 `scanRepoFiles`（`index.js:1619`）：黑名单 `SCAN_SKIP_DIRS`（`index.js:1619`）、单文件 256KB、总数 2000）；`prepareArticleTasks`（`index.js:1619`）装填——`collectSources`（`index.js:1619`）整文件内联加「N| 」行号前缀（`numberLines`（`index.js:1619`）），`estimateTokens`（`index.js:1619`）粗算：总量 ≤110k 单请求普通档；110k–420k 整任务升大档单请求（标 `bigTier` 自带 provider/model/档位，混合池按任务分派）；模块总量超 `bigTokenBudget`（`index.js:1619`）才按 110k 拆观察批（`batchArticleObservePrompt`（`index.js:1619`），keepInMemory）→ `batchArticleComposePrompt`（`index.js:1619`）合成整文；单文件连大档都装不下进会话通道。执行：`submitBatchFor`（`index.js:1619`）→ `startBatchChatRun`（`index.js:1619`）→ 并发池 `runRealtimeTasks`（`index.js:1619`）→ `llmChat`（`index.js:1619`），并发 `maxConcurrency`（`index.js:1619`）默认 2、硬顶 `CONCURRENCY_HARD_CAP`（`index.js:22`）。
   - crosscut：`tickCrosscut`（`index.js:1764`）以成功模块文章全文为输入（`packArticles`（`index.js:1764`）装填、超预算截头部）；总量 ≤ 大档预算单批直出 `_architecture.md`/`_patterns.md`（`crosscutTasks`（`index.js:1764`）；0.10.7 起 concepts 恒为空数组，兼容只产两篇）；超 420k 才每篇一个观察任务（`batchObservePrompt`（`index.js:1764`））→ compose 阶段 `tickCompose`（`index.js:1764`）合成。
   - review：`tickReview`（`index.js:1898`）先 `localReview`（`index.js:1898`）核对 frontmatter 与 source_files 存在性（只记账）；再批量校对（0.10.8）：逐篇准备（文章 + 按「预算−文章 token」装填源码）按 110k 贪心合并批量请求（`batchProofreadBatchPrompt`（`index.js:1898`），输出按 @@@article:/@@@end 标记分节），`settleProofread`（`index.js:1898`）拆回逐篇、`writeValidated`（`index.js:1898`）校验通过才覆写（缺席/非法保留原文）；单篇源码连大档都装不下转会话通道；兜底装填上限 `BATCH_TOKEN_HARD_LIMIT`（`index.js:1898`）=128k（hy3 192k 窗口扣 64k 输出反推）。
   - index 与自动提交：`tickIndex`（`index.js:2010`）——有文章写成功才收尾：`runCw`（`index.js:2010-2011`）跑 cw index 与 cw meta update、`normalizeIndexLinks`（`index.js:2010`）修正 _index.md 链接反斜杠、缺入口时 `ensureWikiEntry`（`index.js:2010`）生成中/英双语 CodeWiki.md（已有入口绝不覆盖）；随后 `autoCommitWiki`（`index.js:2010-2051`）由插件自己提交：只 add .codewiki/ 与 CodeWiki.md 两个路径、commit 带 --no-verify、信息前缀 docs(wiki) 带任务 id 与篇数；结果写 job.autoCommit（committed/sha/message/noChanges/reason）供面板与 progress 展示。
   - 拒绝与降级（安全边界，任一不满足即拒绝、绝不做半个提交）：非 git 仓库、无 HEAD、merge/rebase/cherry-pick 进行中（index.js:2914-2916）、未解决冲突（index.js:2917）、目标路径被 .gitignore 忽略（index.js:2921-2924）、缺 user.name/user.email（index.js:2926-2928）、add/commit 失败——命中即返回 {committed:false, reason} 并降级为一次性「产物待提交」提醒；只 add 两个目标路径、不 amend/push/改写历史、不跑仓库钩子、不动工作区其它改动。
   - 唤醒与提醒（0.10.9 核心变更）：`wakeCompileSession`（`index.js:1221`）在 done 且 `job.autoCommit.committed`（`index.js:1221`）为真时直接 return——自动提交成功即完全不打扰会话；仅 failed、或成功但自动提交被拒时 steer 一次（文案含失败原因）。`commitHintText`（`index.js:2947`）与系统提示 section 共用 60s TTL 缓存 `commitHintCache`（`index.js:1221`）。
   - 系统提示提醒：`installUpdateReminder`（`index.js:3014`）在 agent/created 注册 section codewiki:update-reminder，正文 `reminderText`（`index.js:3014`）。
   - 门控与降级段：text 回调每次组装实时求值——仅会话仓库根存在 CodeWiki.md 入口才注入（index.js:3001-3007）；updateReminder=false 返回空串；插件自动提交失败时追加一次性「产物待提交」段（含失败原因），自动提交成功后时间戳反超自动静默。
   - 会话通道兜底（最后手段）：`dispatchSessionTasks`（`index.js:1537`）把完整写作/校对指令写入任务文件（`SESSION_TASK_DIR`（`index.js:1537`））并 steer 发起会话派子智能体写盘；`classifySessionTask`（`index.js:1537`）每 tick 三态收割（harvest / timeout=超 `SESSION_TASK_TIMEOUT_MS`（`index.js:1537`）默认 30 分钟 / wait）；`progressSessionTasks`（`index.js:1537`）入账（harvest 经 `writeValidated` 落盘）；`resendSessionSteer`（`index.js:1537`）宿主重启接管后重发；`sessionTier`（`index.js:1537`）非空时 `buildSessionSteerText`（`index.js:1537`）要求 delegate 显式传 tier——编译主链模型由 batchProvider/batchModel 决定、不走档位路由，这是唯一经过 delegate 的环节。
4. **进度与面板**：web 端点由 `installWebServer`（`index.js:2666`）注册、仅回环放行（`isLoopbackRequest`（`index.js:2666`），否则 403）：
   - GET /api/codewiki/jobs：任务列表（workspaceOnly 默认开，但 `JOB_TERMINAL`（`index.js:1083`）过滤仅作用于终态任务——0.10.6 起非终态始终显示，串行闸门占用者必可见）。
   - GET /api/codewiki/repos：仓库总览（逐仓现算 cw status 与文章数，30s 缓存；缓存签名含当前非终态任务的工作区路径，编译中仓库进出总览立即失效——0.10.6）。
   - GET /api/codewiki/models：`listModelCatalog`（`index.js:2604`）provider/model 级联目录；GET /api/codewiki/model-efforts：`resolveModelEfforts`（`index.js:2604`）思考档位（`resolveModelInfoOf`（`index.js:2604`）优先宿主 resolveModelInfo——0.10.4 修复方法名错调，缺失回落 resolveModel）。
   - POST /api/codewiki/control：cancel / refresh / compile。
   - 面板 UI：`CodewikiPanel`（`client.js:1143`）2s 轮询 jobs（`POLL_MS`（`client.js:22`）），三标签页——总览 `ReposTab`（`client.js:1143`，10s 轮询 `REPOS_POLL_MS`（`client.js:26`），调度卡带下次扫描倒计时与扫描统计）、任务（六阶段步骤条 `stageBar`（`client.js:1143`，queued 列最前；旧任务残留 plan 计时键由 `lastTimedStage`（`client.js:1143`）过滤——0.10.8 修复失败/取消不标红）、加权总进度 `STAGE_WEIGHTS`（`client.js:1143`）、吞吐徽标 `throughputBadge`（`client.js:1143`）、用量行 `usageLine`（`client.js:1143`）、活动流与任务明细、复制 wiki 路径、取消）、设置（内嵌 `CodewikiCard`（`client.js:1143`））；阶段常量 `ACTIVE_STAGES`（`client.js:28`）；图标 `PanelIcon`（`client.js:1143`）。
   - 设置卡：`CodewikiCard`（`client.js:458-857`）——运行节 + 编译模型节 + 大档节 + 调度与排除节 + 保存条；模型三级联动 `modelTrio`（`client.js:562-661`）（换提供商清空模型与旧档位）、档位下拉 `useEfforts`（`client.js:458-489`）（选中后拉 model-efforts，目录不可用退化手填）、保存 `save`（`client.js:458-480`）。
5. **测试验证**：
   - 导入（test-batch.mjs:7-12 直接 import 真实导出：estimateTokens、collectSources、prepareArticleTasks、runRealtimeTasks、localPlan、fixAnchors 等）。
   - test-batch.mjs 断言组：假 llm `makeLlm`（`test-batch.mjs:173`）按宿主 stream 协议应答；未配大档时单文件超 110k 装进 128k 大档走插件内单请求（`bigPrep`（`test-batch.mjs:79`））、连 128k 都装不下进会话通道（`hugePrep`（`test-batch.mjs:83`））；不再导出 `resolveBatchApiKey`（`test-batch.mjs:451`）；`fixAnchors`（`test-batch.mjs:454`）13 项断言；其余分节行号 24 / 31 / 47 / 54 / 87 / 107 / 134 / 152 / 169 / 207 / 229 / 241 / 254 / 278 / 291 / 304 / 324 / 341 / 365 / 395 / 449。
   - test-orchestration.mjs 夹具：`makeCtx`（`test-orchestration.mjs:44`）、`makeMockAgent`（`test-orchestration.mjs:44`）、`makeFixtureRepo`（`test-orchestration.mjs:44`）、`llmProxy`（`test-orchestration.mjs:44`）、`makeBatchMock`（`test-orchestration.mjs:44`）、`waitJob`（`test-orchestration.mjs:44`）、`batchCfg`（`test-orchestration.mjs:44`）。
   - test-orchestration.mjs 隔离（plain）：test-orchestration.mjs:15 把 tick 压到 300ms；test-orchestration.mjs:19 用独立 JOBS_FILE 与真实宿主隔离。
   - test-orchestration.mjs 覆盖块（行号均指该文件）：系统提示提醒 231、codewiki_update 与 commitHintText 282、autoCommitWiki 安全边界（各拒绝分支 + noChanges 不空提交）376-448、wakeCompileSession 自动提交成功零唤醒 450-482、本地规划零勘探员请求 484、全量编译端到端（含落库核查与工作区干净断言）543-582、横切拆分 584、文章分割 614、单项目串行 650、宿主 llm 唯一通道 699、stale 逐篇更新 733、progress 过滤与渲染 756、宿主重启按 prompt 快照重跑 793、并发提交占位与 flush 合并 852、面板端点与取消 892、排除清单 946、knownRepos 1001、workspaceOnly 过滤 1041、registry 抛错降级 1104、输出 schema 校验 1134、孤儿接管 1174、编译模型缺失诚实报错 1208、严格 cordis 语义 1223、Temp 残留清理 1247。
   - test-wiki-entry.mjs：`ensureWikiEntry`（`test-wiki-entry.mjs:27`）缺失生成 / 已有不覆盖 / 英文文案 / 空 cwd / 幂等；`parseStatus`（`test-wiki-entry.mjs:60`）与 `normalizeIndexLinks`（`test-wiki-entry.mjs:67`）的 Windows 路径规范化。
   - test-wiki-anchors.mjs：符号提取 `symbolsOnLine`（`test-wiki-anchors.mjs:38`）与就近匹配 `nearestSymbol`（`test-wiki-anchors.mjs:52`）。
   - 锚点守卫语义：主循环遍历 .codewiki/ 全部文章（test-wiki-anchors.mjs:82-115），三重断言——基础（行号在范围内且指向非空行）、符号绑定（仅单锚点行）、区间有序。
   - test-cwd-paths.mjs（真 cw CLI 实测）：MSYS /e/... 归一化后 cw path 返回仓库内 .codewiki（test-cwd-paths.mjs:30-45）、Windows 路径真实三态（47-57）、不存在路径干净报错（61-69）。
6. **产物可信与演进追踪**：
   - 锚点可信链：写盘前 `fixAnchors`（`index.js:401-484`）对照 source_files 源码机械校正（唯一命中或唯一声明形态→改；歧义/未找到→不动并记 notes）；源码内联自带「N| 」前缀（`numberLines`（`index.js:401`））且 prompt 明令禁止自行数行；test-wiki-anchors.mjs 作回归守卫。
   - 版本演进：CHANGELOG.md:3-17（0.10.9 自动提交与零唤醒）、CHANGELOG.md:19-31（0.10.8 大档单请求优先与批量校对）、CHANGELOG.md:33-42（0.10.7 删规划阶段）、CHANGELOG.md:66-92（0.10.4 大档模型四项）、CHANGELOG.md:117-129（0.10.1 删内置百炼直连、插件零密钥）。当前时点验证：test-orchestration 全过、test-batch 123 过 0 败（CHANGELOG.md:16）。
   - 历史日志快照（旧版本，勿当现状）：.tmp-test-batch.log:1-85（仍含 0.10.1 已删除的 resolveBatchApiKey 凭证链与 enable_thinking/28k 预算断言）、.tmp-test-orchestration.log:1-573（仍含规划阶段与百炼端点断言，末尾 2 项失败——source 旧形态 plugin/codewiki）、.tmp-test-cwd-paths.log:1-8、.tmp-test-wiki-entry.log:1-25、.tmp-test-wiki-anchors.log:1-161（122 过 / 36 败的行号漂移快照）、watcher2.log:1-1397（对 jobs 文件 30ms 轮询、观察 plan 阶段任务取消标记的排查记录）。
   - 探针与仓库卫生：.probe3.txt:1 内容仅一行 `probe`；.gitignore:9-12 排除 *.log、.probe3.txt、.dsh-ops/ 与 bin/*.bak-* 备份。

## Implementation Map

关键实现位置按模块分组（行号以当前源码「行号| 」前缀为准）：

**核心实现（core-and-config）**

- 入口与生命周期：`apply`（`index.js:3048-3106`）；自动更新调度 `schedState`（`index.js:3048`）与 60s 心跳 autoScan（默认关）。
- 配置：`Config`（`index.js:51-71`，19 个字段全部 volatile）、`liveConfig`（`index.js:51-76`）、默认常量 `DEFAULT_BATCH_PROVIDER`（`index.js:26`）、`DEFAULT_CONCURRENCY`（`index.js:24`）、`DEFAULT_BIG_TOKEN_BUDGET`（`index.js:33`）、`BATCH_TOKEN_BUDGET`（`index.js:51`）、`BATCH_TOKEN_HARD_LIMIT`（`index.js:51`）。
- cw 子进程与判态：`normalizeCwd`（`index.js:40-45`）、`resolveBinary`（`index.js:40-60`）、`runCw`（`index.js:40-65`）、`normalizeArticlePath`（`index.js:40`）、`normalizeIndexLinks`（`index.js:40-48`）、`parseStatus`（`index.js:40-53`）、`countWikiArticles`（`index.js:40-52`）、`ensureWikiEntry`（`index.js:40-73`）、`excludedItem`（`index.js:40-52`）。
- 装填与 prompt 模板：`estimateTokens`（`index.js:272-280`）、`llmChat`（`index.js:272-291`）、`applyTaskResult`（`index.js:272-285`）、`runRealtimeTasks`（`index.js:272-301`）、`numberLines`（`index.js:272-274`）、`fixAnchors`（`index.js:272-355`）、`collectSources`（`index.js:272-299`）、`batchArticlePrompt`（`index.js:272-299`）、`prepareArticleTasks`（`index.js:272-357`）、`articleFormatSection`（`index.js:272-301`）、`localPlan`（`index.js:272-285`）、`packArticles`（`index.js:272-291`）、`batchObservePrompt`（`index.js:272-289`）、`batchArticleObservePrompt`（`index.js:272-288`）、`batchArticleComposePrompt`（`index.js:272-300`）、`batchProofreadPrompt`（`index.js:272-291`）、`batchProofreadBatchPrompt`（`index.js:272-299`）。
- 服务与阶段机：`slugify`（`index.js:963-965`）、`parseSourceFiles`（`index.js:963-975`）、`classifySessionTask`（`index.js:963-973`）、`buildSessionSteerText`（`index.js:963-981`）、`scanRepoFiles`（`index.js:963-986`）、`jobSummary`（`index.js:963-997`）、`wakeCompileSession`（`index.js:963-977`）、`createJobService`（`index.js:963-1948`；内部 `writeValidated`（`index.js:963`）、`tally`（`index.js:963`）、`settleJob`（`index.js:963-984`）、`settleProofread`（`index.js:963`）、`startBatchChatRun`（`index.js:963`）、`submitBatchFor`（`index.js:963`）、`dispatchSessionTasks`（`index.js:963`）、`progressSessionTasks`（`index.js:963`）、`resendSessionSteer`（`index.js:963`）、`tickArticles`（`index.js:963`）、`crosscutTasks`（`index.js:963`）、`tickCrosscut`（`index.js:963`）、`tickCompose`（`index.js:963`）、`localReview`（`index.js:963`）、`tickReview`（`index.js:963`）、`tickIndex`（`index.js:963`）、`STAGE_HANDLER`（`index.js:963`）、`tick`（`index.js:963`）、`submit`（`index.js:963`）。
- 工具定义：`cwToolDefinition`（`index.js:892-955`）、`generateToolDefinition`（`index.js:892-1042`）、`updateToolDefinition`（`index.js:892-944`）、`progressView`（`index.js:892-896`）、`progressToolDefinition`（`index.js:892-993`）。
- 端点与模型目录：`isLoopbackRequest`（`index.js:2568-2571`）、`listModelCatalog`（`index.js:2568-2589`）、`resolveModelInfoOf`（`index.js:2568-2573`）、`resolveModelEfforts`（`index.js:2568-2590`）、`installWebServer`（`index.js:2568-2797`）。
- 自动提交与提醒：`autoCommitWiki`（`index.js:2926-2967`）、`commitHintText`（`index.js:2926-2955`）、`reminderText`（`index.js:2926-2935`）、`installUpdateReminder`（`index.js:2926-2958`）。

**客户端（core-and-config）**

- 挂载与注册：入口 `__ModuleLoader__.load`（`client.js:10`）；slot 注册 `apply`（`client.js:10`）——plugins.item（order 30 设置表单）+ main / sidebar.panellist 双 slot（order 52 面板）。
- 包声明：package.json:8-11（exports ./client）、package.json:20-27（dsh.client.platform web 与 bundle patch）；本地 file:/// 直挂条目 cordis.patch.yml:13-16（id codewiki）。
- 组件：`CodewikiCard`（`client.js:458-857`）、`useEfforts`（`client.js:458-489`）、`modelTrio`（`client.js:562-661`）、`save`（`client.js:458-480`）、`lastTimedStage`（`client.js:458-461`）、`stageBar`（`client.js:458-480`）、`STAGE_WEIGHTS`（`client.js:458-467`）、`throughputBadge`（`client.js:458-478`）、`usageLine`（`client.js:458-474`）、`ReposTab`（`client.js:458-601`）、`CodewikiPanel`（`client.js:458-658`）、`PanelIcon`（`client.js:458-469`）、常量 `ACTIVE_STAGES`（`client.js:28`）、`POLL_MS`（`client.js:22`）、`REPOS_POLL_MS`（`client.js:26`）。

**文档与元信息（docs-and-meta）**

- 工具表与关键行为：README.md:9-13、README.md:15-22。
- 设置全表 / 安装 / 开发：README.md:24-40、README.md:42-57、README.md:59-67。
- 编译模型条目：`batchProvider` / `batchModel`（`README.md:29`）、`batchReasoningEffort`（`README.md:30`）、大档四项（`README.md:30`）、`sessionTier`（`README.md:32`）。
- 运行与产物条目：`maxConcurrency`（`README.md:35`）、`serialProjects`（`README.md:36`）、`updateReminder`（`README.md:38`）、`autoCommit`（`README.md:39`）。
- 项目 wiki 自述：CodeWiki.md:7（Overview 全景）、CodeWiki.md:34-54（架构框图）、CodeWiki.md:58（Data Flow）、CodeWiki.md:65-72（Known Issues）。
- Key Components 摘要：`Config`（`CodeWiki.md:12`）、模型执行模块（`estimateTokens`（`CodeWiki.md:19`）等）、编排服务 `createJobService`（`CodeWiki.md:19`）、四个端点（`webServer`（`CodeWiki.md:19`））、自动提交边界 `autoCommitWiki`（`CodeWiki.md:15`）、唤醒 `wakeCompileSession`（`CodeWiki.md:16`）。
- 变更史：CHANGELOG.md:3-17（0.10.9）、CHANGELOG.md:19-31（0.10.8）、CHANGELOG.md:33-42（0.10.7）、CHANGELOG.md:66-92（0.10.4）、CHANGELOG.md:117-129（0.10.1）。
- 探针与卫生：.probe3.txt:1、.gitignore:1-12。

**测试脚本（test-scripts）**

- test-batch.mjs：夹具 `makeLlm`（`test-batch.mjs:173`）；大档单请求 `bigPrep`（`test-batch.mjs:79`）与会话兜底 `hugePrep`（`test-batch.mjs:83`）锁定装填语义；`resolveBatchApiKey` 反断言（`test-batch.mjs:451`）与 `fixAnchors`（`test-batch.mjs:454`）13 项；分节行号 24 / 31 / 47 / 54 / 87 / 107 / 134 / 152 / 169 / 207 / 229 / 241 / 254 / 278 / 291 / 304 / 324 / 341 / 365 / 395 / 449。
- test-orchestration.mjs：夹具 `makeCtx`（`test-orchestration.mjs:44`）、`makeMockAgent`（`test-orchestration.mjs:44`）、`makeFixtureRepo`（`test-orchestration.mjs:44`）、`llmProxy`（`test-orchestration.mjs:44`）、`makeBatchMock`（`test-orchestration.mjs:44`）、`waitJob`（`test-orchestration.mjs:44`）、`batchCfg`（`test-orchestration.mjs:44`）；覆盖块行号 231 / 282 / 376 / 450 / 484 / 543 / 584 / 614 / 650 / 699 / 733 / 756 / 793 / 852 / 892 / 946 / 1001 / 1041 / 1104 / 1134 / 1174 / 1208 / 1223 / 1247（详见 Flow）。
- test-wiki-entry.mjs：`ensureWikiEntry`（`test-wiki-entry.mjs:27`）、`parseStatus`（`test-wiki-entry.mjs:60`）、`normalizeIndexLinks`（`test-wiki-entry.mjs:67`）。
- test-wiki-anchors.mjs：符号提取 `symbolsOnLine`（`test-wiki-anchors.mjs:38`）与就近匹配 `nearestSymbol`（`test-wiki-anchors.mjs:52`）。
- 锚点守卫主循环与三重断言（基础 / 单锚点行符号绑定 / 区间有序）：test-wiki-anchors.mjs:82-115。
- test-cwd-paths.mjs：MSYS 归一化 test-cwd-paths.mjs:30-45、Windows 三态 47-57、不存在路径 61-69。

**日志与临时（logs-and-temp）**

- 测试快照（旧版本，与当前代码不同步）：.tmp-test-batch.log:1-85、.tmp-test-cwd-paths.log:1-8、.tmp-test-orchestration.log:1-573、.tmp-test-wiki-anchors.log:1-161、.tmp-test-wiki-entry.log:1-25。
- 轮询观察：watcher2.log:1-1397。