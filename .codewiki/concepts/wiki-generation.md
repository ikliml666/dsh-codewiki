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

`wiki-generation` 指 `@local/dsh-codewiki` 插件把一个代码仓库转化为结构化 CodeWiki 文档（`WIKI_PATHS` (`index.js:36`) 即 `<repo>/.codewiki/` 与 `CodeWiki.md`，随仓库提交共享）的端到端编译过程。入口工具 `codewiki_generate` 由 `generateToolDefinition` (`index.js:36-202`) 定义：纯提交制——`normalizeCwd` (`index.js:40-45`) 归一路径、`runCw` (`index.js:136-161`) 跑 `cw status` 判态、按判态预构建任务后经 `submit` (`index.js:36-111`) 交给宿主常驻编排服务 `createJobService` (`index.js:36-1058`) 即返回，工具路径零 LLM 调用、零子代理、不委托发起会话的主模型。服务在 `tick` (`index.js:36-122`) 里以 `TICK_MS` (`index.js:36`) 默认 10s 的节拍推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index → commit → done，阶段分发表是 `STAGE_HANDLER` (`index.js:36-43`)；0.10.7 起无规划阶段，模块清单由 `localPlan` (`index.js:36-49`) 按顶层目录本地分组。全部模型环节在插件内的后台并发池 `runRealtimeTasks` (`index.js:36-73`) 完成，唯一模型通道是 `llmChat` (`index.js:36-61`) 包装的宿主 llm 服务（0.10.1 起无内置直连，插件不保存任何密钥）：普通档默认 `workbuddy`/`hy3`（`DEFAULT_BATCH_PROVIDER` (`index.js:26-27`)，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET` (`index.js:36`)=110k）；110k–420k 输入自动升大档——默认 `volces-ark`/`glm-5.3-flash`（`DEFAULT_BIG_PROVIDER` (`index.js:30-31`)，512k 上下文），预算 `DEFAULT_BIG_TOKEN_BUDGET` (`index.js:33`)=420k；只有单文件连大档都装不下才转会话通道兜底（`dispatchSessionTasks` (`index.js:36-70`)，超时 `SESSION_TASK_TIMEOUT_MS` (`index.js:36`) 默认 30 分钟按失败处理）。0.10.11 起产物提交是阶段机里的显式一步：`tickIndex` (`index.js:36-66`) 末尾在有产物且 `autoCommit` 开启时移交 commit 阶段，`tickCommit` (`index.js:36-52`) 执行 `autoCommitWiki` (`index.js:36-118`) 的「主题分支提交 → 合并回原分支」后才置 done 并唤醒；提交状态由 `autoCommitState` (`index.js:36-41`) 判定 committed/no-changes/pending 三态，`wakeCompileSession` (`index.js:36-51`) 在已提交/无改动时完全静默。0.11.0 起并行项目推进（`parallelProjects` (`index.js:64`)，关串行后上限 1–4）与编译会话记录（`SESSIONS_DIR` (`index.js:36`)，保留 24h）可用；0.12.0 起 linked git worktree 目录拒绝编译（`detectLinkedWorktree` (`index.js:283-299`)）。本概念横跨文档说明、核心实现、测试验证与运行日志四大模块。

当前基线 0.12.0（package.json:3）。0.12.0 新增全局「会话」Tab（跨任务聚合 `listAllSessionRecords` (`index.js:1169-1189`)，`GET /api/codewiki/sessions` 不带 jobId 即聚合，`index.js:1169-1190`）、worktree 拒绝编译三处拦截（`submit` (`index.js:1169-1174`)、工具在跑 `cw status` 之前（`index.js:1169-1177`)、`autoScan` 静默跳过（`index.js:1169`））、会话记录每 10 分钟静默清理（`pruneSessionRecords` (`index.js:1169-1189`)，在 `tick` 内 `index.js:1169-1172`）（CHANGELOG.md:8-17）。0.11.1 修复大档任务思考档位回落错误——`runRealtimeTasks` (`index.js:1169-1171`) 任务自带 provider+model 时 effort 完全以任务为准，`llmChat` (`index.js:1169-1173`) 遇 `UNSUPPORTED_REASONING_EFFORT` 剥档重试一次（CHANGELOG.md:8-16）；0.11.2 在模型目录未声明档位时给设置页通用档位下拉（`GENERIC_EFFORTS` (`client.js:30`），CHANGELOG.md:8-14）。0.11.0 引入 `parallelProjects`（`Config` (`index.js:64`)，`liveConfig` 派生 `parallelLimit` (`index.js:96-100`)，tick 闸门由单选 `activeId` 改 `activeIds` 集合 `index.js:1169-1178`）、排队可见性 `queueAhead`（`index.js:1169-1181`）与会话记录双文件落盘（`beginSessionRecord` (`index.js:1169-1211`)）（CHANGELOG.md:8-18）。0.10.11 把产物提交升级为独立 commit 阶段 + 分支合并式：`STAGE_HANDLER` (`index.js:1169-1176`) 新增 `commit: tickCommit`；`autoCommitWiki` (`index.js:1169-1251`) 先在主题分支 `codewiki/wiki-<jobId>`（`index.js:1169`）上提交两个 wiki 路径，再 `git merge --no-edit`（`index.js:1169`）合并回原分支、`git branch -d` 删主题分支（`index.js:1169`）；detached HEAD 或建分支失败降级为直接提交（`mode:'direct'`，`index.js:1169-1178`），合并失败则 `git merge --abort` 并保留主题分支等手动合并（`index.js:3309-3315`）；`codewiki_progress` 输出 schema 新增 `mode`/`branch`/`fallback`（`index.js:1169-1171`），面板阶段条加 `commit`（`ACTIVE_STAGES` (`client.js:33`)、`STAGE_WEIGHTS` (`client.js:1018`) 权重 0.02、文案 `stageCommit` (`client.js:117`)）（CHANGELOG.md:8-20）。0.10.10 修复两轴 code-review 发现——`autoCommitState` 成三态唯一判定、`git add` 收敛为纯 pathspec `git add -- .codewiki CodeWiki.md`（`index.js:1169`，常量 `WIKI_PATHS` (`index.js:36`)）、`git commit`/`git add` 失败带 stderr 摘录进 `reason`（`index.js:1169`、`index.js:1169`）、两处测试竞态修正（CHANGELOG.md:8-22）；0.10.9 产物由插件自己提交、成功不再唤醒会话（CHANGELOG.md:8-22）；0.10.8 起 110k–420k 大档单请求优先、审校改批量校对（CHANGELOG.md:8-20）；0.10.7 删规划阶段（CHANGELOG.md:8-17）。

## Involved Modules

- **docs-and-meta**：README.md（四工具表 README.md:7-13、`codewiki_generate` 关键行为 README.md:15-22、全部设置项 README.md:24-40、本地 file:/// 安装 README.md:42-57、开发与验证 README.md:59-67）；CodeWiki.md（插件自身仓库的 wiki 入口 CodeWiki.md:3，Overview CodeWiki.md:7、Key Components CodeWiki.md:9-31、架构图 CodeWiki.md:35-57、Connections CodeWiki.md:63-66、Known Issues CodeWiki.md:68-75，重启 dsh 后可用 `codewiki_generate` 对本仓库重编）；CHANGELOG.md（0.1.0 → 0.12.0 全部行为变更，714 行，最新一节 0.12.0 在 CHANGELOG.md:3-12）；.probe3.txt（只有一行 `probe` 的探针占位，.probe3.txt:1，被 .gitignore:9 排除在仓库外）。
- **core-and-config**：`index.js`（插件全部逻辑，单文件 3464 行：`Config` (`index.js:51-72`) 全部 `.volatile()` 设置、四工具定义 `index.js:51`/`index.js:51`/`index.js:51`/`index.js:51`、编排服务 `index.js:51`、面板端点 `index.js:51`、自动提交 `index.js:51`、入口 `apply` (`index.js:51-112`)）；`client.js`（浏览器半侧，1574 行：插件页设置卡 `CodewikiCard` (`client.js:516-930`)、侧边栏面板 `CodewikiPanel` (`client.js:1312-1557`)、总览页 `ReposTab` (`client.js:1071-1214`)、会话视图 `SessionView` (`client.js:1220-1310`)、阶段步骤条 `stageBar` (`client.js:994-1016`) 与加权总进度 `STAGE_WEIGHTS` (`client.js:1018`)、模型三件套渲染 `modelTrio` (`client.js:626-730`)、面板图标 `PanelIcon` (`client.js:1559-1570`)、保存键白名单 `client.js:516`）；cordis.patch.yml（bundle 形式挂载补丁，file:/// 直挂条目 id `codewiki`，cordis.patch.yml:13-16，设置项注释 cordis.patch.yml:4-12）；package.json（版本 package.json:2、exports `./client` package.json:2-5、`engines.dsh` package.json:2-5、`dsh.client` 平台声明 package.json:20-23、bundle 补丁指向 package.json:2-5）；.gitignore（`*.log` 与运行期产物不入库，.gitignore:2、.gitignore:2、.gitignore:2-3）。
- **test-scripts**：五个自检脚本直接 import 真实 `index.js` 导出——test-batch.mjs（501 行，纯函数与假 llm 执行链：大档接管块 test-batch.mjs:107-131、宿主 llm 通道块 test-batch.mjs:169-251、末行汇总 test-batch.mjs:497-501）；test-orchestration.mjs（1471 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实 tick，tick 压到 300ms test-orchestration.mjs:15；`autoCommitWiki` 安全边界块 test-orchestration.mjs:405-506、`autoCommitState` 三态块 test-orchestration.mjs:508-518、`wakeCompileSession` 唤醒块 test-orchestration.mjs:520-556、端到端含独立 commit 阶段断言 test-orchestration.mjs:617-658、单项目串行块 test-orchestration.mjs:726-782、并行项目上限块 test-orchestration.mjs:784-813、全局会话聚合与 worktree 闸门块 test-orchestration.mjs:1334-1405）；test-wiki-entry.mjs（76 行，`CodeWiki.md` 入口生成与 Windows 路径规范化）；test-wiki-anchors.mjs（118 行，行号锚点守卫：基础/符号绑定/区间三重断言，规则见 test-wiki-anchors.mjs:1-9，汇总 test-wiki-anchors.mjs:117-118）；test-cwd-paths.mjs（71 行，MSYS/Windows/不存在路径三态实测）。
- **logs-and-temp**：测试与排查落盘的历史日志，均不入 git——.tmp-test-batch.log（85 行，旧版执行链自检留档，末行 .tmp-test-batch.log:76 记 59 通过 0 失败，内容仍是百炼直连/`resolveBatchApiKey` 时代）；.tmp-test-cwd-paths.log（8 行）；.tmp-test-orchestration.log（旧版 plan 阶段尚存时代的运行留档，末行 .tmp-test-orchestration.log:573 记 FAIL 2 项）；.tmp-test-wiki-anchors.log（161 行，旧基线 122 过/36 败的锚点校验留档，汇总 .tmp-test-wiki-anchors.log:130）；.tmp-test-wiki-entry.log（25 行，全部通过）；watcher2.log（0.4.x 排查多实例 jobs 文件互覆时的轮询记录，记录的全是 2026-10-06 的 plan 阶段任务，watcher2.log:1）。这些文件由 .gitignore:3 的 `*.log` 规则排除。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:15-22（提交制、`scope=auto/full/stale` 语义、并发默认 2、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）；0.12.0 变更全文见 CHANGELOG.md:3-12。
   - 设置项与默认值：`Config` (`index.js:51-72`)——编译模型三项（`batchProvider` 默认 `workbuddy`，`index.js:54`；`batchModel` 默认 `hy3`，`index.js:55`；`batchReasoningEffort`，`index.js:56`）、大档四项（`bigProvider`/`bigModel`/`bigReasoningEffort`/`bigTokenBudget`，`index.js:57-60`）、`sessionTier` (`index.js:61`)、`maxConcurrency` 默认 2 硬顶 8（`index.js:62`，常量 `DEFAULT_CONCURRENCY` (`index.js:24`)、`CONCURRENCY_HARD_CAP` (`index.js:22`)）、`serialProjects` 默认开（`index.js:63`）、`parallelProjects` 默认 2 上限 4（`index.js:64`）、`autoCommit` 默认开（`index.js:67`)、`updateReminder` 默认开（`index.js:66`）；全部 `.volatile()` 改完即生效（README.md:56）。
   - 配置链路：设置卡 `save` (`client.js:732-754`) 按保存键白名单（`client.js:732`）经 `configForms.mutate` 单层 op + revision CAS 保存（与 profile patch 手改等价、同样热生效）；provider/model 目录来自 `/api/codewiki/models`（`listModelCatalog` (`index.js:2926-2947`)），思考档位来自 `/api/codewiki/model-efforts`（`resolveModelEfforts` (`index.js:2926-2948`)，宿主方法适配 `resolveModelInfoOf` (`index.js:2926-2931`)，0.10.4 起优先 `resolveModelInfo`）。
   - 插件接线：`apply` (`index.js:3476-3537`) 注入 `agentsRef`/`llmRef`（`index.js:3476-3477`）、创建常驻服务（`index.js:3476`）、注册 `cw`/`codewiki_generate`/`codewiki_update`/`codewiki_progress` 四工具（`index.js:3476-3492`，单工具 schema 违规只丢该工具不炸回调 `index.js:3476-3484`）、安装面板端点（`index.js:3476`）与系统提示提醒（`index.js:3476`）；`liveConfig` (`index.js:78-108`) 在每次 execute/tick 热读配置。
   - 自举：`CodeWiki.md` 是插件自身仓库的 wiki 入口（CodeWiki.md:3），收尾可用 `codewiki_generate` 重编本仓（CodeWiki.md:7）；入口缺失时由 `ensureWikiEntry` (`index.js:220-253`) 在 `tickIndex` 自动补建（`index.js:220`），已有入口绝不覆盖。
2. **任务提交**：
   - 判态与预构建：execute（`index.js:40-160`）→ `normalizeCwd` (`index.js:40-45`) 归一化 MSYS 盘符路径 → `excludedItem` (`index.js:258-267`) 排除清单（报错带命中条目，`index.js:40`）→ worktree 闸门（`detectLinkedWorktree` (`index.js:283-299`)，工具侧 `index.js:40-48`，报错文案含真实 `gitDir` 与「等合并回主仓库」指引，auto 直调降级 `state:'worktree'`）→ `cw status`（`parseStatus` (`index.js:187-200`) 解析四态 missing/uncompiled/clean/stale）→ clean 直接报告（`index.js:40-43`，`scope=full` 例外强制全量重编）；stale 遇无 wiki 自动升全量（`index.js:40-44`）；同仓库已有活动任务幂等返回（`index.js:40-48`），发起会话 id 存 `job.sessionId`（`index.js:40`）供终态唤醒。
   - stale 逐篇更新：按旧文 frontmatter 经 `readSourceFiles` (`index.js:1083-1091`) / `parseSourceFiles` (`index.js:1083-1095`) 解析 `source_files` 预构建任务直达 articles（`index.js:1083-1111`）；任务 `mission` 即「更新过期文章 …：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（`index.js:1083`）——本篇即该流程的产物；有变更但未命中任何文章时只刷新基线 `meta update`（`index.js:1083-1090`）；missing 态先 `cw init`（`index.js:1083-1089`）再提交全量（`index.js:1083-1090`）。
   - 提交语义：`submit` (`index.js:2414-2489`)——排除拒绝（`index.js:2414-2417`）、worktree 拒绝或 auto 静默跳过（`index.js:2414-2419`）、`submitting` 占位挡并发重复提交（`index.js:2414-2435`）、编译模型三项硬校验（`index.js:2414-2423`，provider 留空直接 fail 诚实报错、不降级子代理）、`credentialSource` 记 llm 路由（`index.js:2414`）、项目闸门：忙碌项目数达 `parallelLimit` 则进 `queued` 并预置 `pendingStage`/`pendingTasks`（`index.js:2414-2427`，串行时 note「单项目串行」、并行时「并行上限 N」`index.js:2414`）；先落盘再 `void tick()`（`index.js:2414-2415`）立即返回 `{submitted, jobId, stage}`。
   - 维护与进度入口：`codewiki_update`（`updateToolDefinition` (`index.js:2709-2761`)）固定 `scope=auto`，提交后追加「本步收尾、继续下一项、不要等待」引导（`index.js:2709-2711`）；`codewiki_progress`（`progressToolDefinition` (`index.js:2709-2813`)）只读立即返回，`progressView` (`index.js:2709-2713`) 按 taskList 算百分比，输出 schema 的 `autoCommit` 块含 `mode`/`branch`/`fallback`（`index.js:2709-2723`）且 render 按三态展示（`index.js:2709-2715`）；`jobSummary` (`index.js:2709-2746`) 为面板与 progress 共用的任务摘要（含 `autoCommit` 字段 `index.js:2709`）。
3. **阶段机推进**：`tick` (`index.js:2326-2412`) 每 `TICK_MS` (`index.js:2326`) 一轮——每 10 分钟静默 `pruneSessionRecords`（`index.js:2326-2329`）、进程级推进锁 `acquireTickLock` (`index.js:2326-2340`)、跨实例取消标记拾取 `syncCancelFlags` (`index.js:2326-2336`)、项目闸门 `activeIds` 集合计算（忙碌项优先、按提交顺序唤醒最早 queued 直到 `parallelLimit`，`index.js:2326-2335`）、孤儿接管（`ORPHAN_TAKEOVER_MS` (`index.js:2326`)：另一实例停更超 5 分钟即接管，会话通道任务重发 steer `resendSessionSteer` (`index.js:2326-2339`)，`index.js:2326-2335`）、`queued` 唤醒恒进 articles（`index.js:2317-2327`）、旧 `plan` 任务迁移（`index.js:2332-2339`），最后按 `STAGE_HANDLER` (`index.js:2326-2333`) 分发到 articles/crosscut/compose/review/index/commit 六个处理器（`index.js:2340-2346`）。任务持久化 `JOBS_FILE` (`index.js:2326`)（tmp 下 dsh-codewiki-jobs.json，只留最近 `MAX_JOBS_KEPT` (`index.js:2326`)=30 条，`saveJobs` (`index.js:2326-2331`) 整写）；多实例安全 = tick 进程锁 + 脏标记 `dirtyIds` + `mergeFromDisk` 磁盘吸收（`index.js:2326-2347`）+ 每轮从磁盘拾取 cancel 标记；宿主重启后执行器丢失时按 `job.tasks` 持久化的 batchPrompt 快照自动重跑当前阶段（`settleJob` (`index.js:2326-2347`)）；已知仓库清单 `REPOS_FILE` (`index.js:2326`) 由 `rememberRepo` (`index.js:2326-2334`) 提交即登记（总览页据此发现已编译工作区）；Temp 目录终态任务启动即清理（`index.js:2326-2337`）。

```text
模型调用 codewiki_generate (index.js:2465)   纯提交、零 LLM、零子代理
        │ normalizeCwd (index.js:40) → 排除清单 (index.js:258) → worktree 闸门 (index.js:283)
        │ → cw status 判态 (index.js:187) → 任务预构建
        ▼
  submit (index.js:2356) ──► {submitted, jobId, stage} 立即返回
        │ （宿主后台 createJobService (index.js:1436)，tick (index.js:2268) 默认 10s；
        │   serialProjects=开 → 后提交项目进 queued；parallelProjects 上限 1–4 可并行）
        ▼
  queued ──► articles ──► crosscut ──► review ──► index ──► commit ──► done
  （compose 仅在文章/横切输入超大档预算拆观察→合成时出现）
        │  全部请求经 llmChat (index.js:325) 走宿主 llm 服务：
        │  ≤110k 普通档 hy3 ｜ 110k–420k 大档 glm-5.3-flash ｜ 单文件超限 → 会话通道兜底
        ▼
  tickCommit (index.js:2241) → autoCommitWiki (index.js:3241)
        │  主题分支 codewiki/wiki-<jobId> 提交两个 wiki 路径 → merge 回原分支 → 删分支
        ├─ autoCommitState (index.js:1412) = committed / no-changes → 静默，不唤醒会话
        └─ pending → 一次性「产物待提交」提醒（steer index.js:1419 + 系统提示 index.js:3325）
```

4. **写文章阶段（articles）**：`tickArticles` (`index.js:1818-1939`)——stale 用预构建任务，full 就地 `scanRepoFiles` (`index.js:1876-1899`) + `localPlan` (`index.js:1876-1889`) 生成模块清单（`index.js:1876-1880`，slug 保留 CJK `slugify` (`index.js:1876-1878`)）；`prepareArticleTasks` (`index.js:1876-1961`) 装填：整模块源码由 `collectSources` (`index.js:1876-1903`) 内联（每行带「N| 」行号前缀，`numberLines` (`index.js:1876-1878`)），token 粗算 `estimateTokens` (`index.js:1876-1884`)；≤110k 普通档单请求、110k–`singleLimit`（`BATCH_TOKEN_HARD_LIMIT` (`index.js:433`)=128k 或大档 `bigTier.budget`=420k）升大档单请求（任务标 `bigTier` 自带 provider/model，`markBig` (`index.js:1876-1884`)）、总量超大档预算才按 110k 拆观察批（`batchArticleObservePrompt` (`index.js:1876-1892`)，拆分逻辑 `index.js:1876-1910`）收割后合成（`batchArticleComposePrompt` (`index.js:1876-1904`)，重建逻辑 `index.js:1876-1927`）；单文件连大档都装不下进 `sessionTasks` 会话通道（`emitSession`，`index.js:1876-1881`）。批次提交 `submitBatchFor` (`index.js:1876-1904`) 记账并启动执行器 `startBatchChatRun` (`index.js:1657-1698`)（`onRequestStart` 挂会话记录 `index.js:1876`），收割 `settleJob` (`index.js:1876-1897`)、落盘闸门 `writeValidated` (`index.js:1876-1892`)（frontmatter 校验 + `fixAnchors` (`index.js:1876-1959`) 行号锚点自动校正）与 `tally` (`index.js:1876-1897`) 记账；会话通道派发 `dispatchSessionTasks` (`index.js:1876-1910`)（steer 文本 `buildSessionSteerText` (`index.js:1876-1894`)，`sessionTier` 非空时钉死档位）、每 tick 收割 `progressSessionTasks` (`index.js:1876-1895`)（三态判定 `classifySessionTask` (`index.js:1876-1886`)）；全部失败（`writtenCount=0`）则任务失败且 wiki 基线不变（`index.js:1937`）。prompt 模板 `batchArticlePrompt` (`index.js:1876-1903`) 与格式条款 `articleFormatSection` (`index.js:705-734`) 规定 frontmatter（title/type/source_files/tags）+ 六章节结构——本篇格式即来源于此。
5. **横切与合成（crosscut/compose）**：`tickCrosscut` (`index.js:2021-2103`) 用成功模块文章全文作输入（`packArticles` (`index.js:2021-2040`) 装不下截头部并标注）：总量 ≤ 大档预算单批直出 `_architecture.md`/`_patterns.md`（`batchArchitecturePrompt` (`index.js:2021-2027`)、`batchPatternsPrompt` (`index.js:2021-2027`)，超 110k 时任务标大档并 note「大档装填」`index.js:2021-2029`）；本地规划不产概念（`localPlan` (`index.js:2021`) `concepts: []`，概念专文模板 `batchConceptPrompt` (`index.js:2021-2027`) 仍在但 concepts 目录恒空）；超 420k 才每篇模块文章一个观察任务（`batchObservePrompt` (`index.js:2021-2038`)）并发跑（`index.js:2021-2032`），settle 后进 compose 阶段提交合成批（`tickCompose` (`index.js:2021-2033`)、`submitComposeBatch` (`index.js:2021-2031`)，任务装配 `crosscutTasks` (`index.js:2021-2040`)）。
6. **批量校对（review）**：`tickReview` (`index.js:2155-2265`) 先 `localReview` (`index.js:2155-2175`) 本地核对（frontmatter 必填、`source_files` 存在性、丢文件回退计数），再把逐篇「文章+源码」按 110k 贪心合并成批量校对请求（`batchProofreadBatchPrompt` (`index.js:2155-2182`)，分组 `index.js:2149-2180`；单篇装不下先升大档重装 `index.js:2155-2156`，连大档都装不下转会话通道 `index.js:2155-2162`）；输出按 `@@@article:`/`@@@end` 标记分节，`settleProofread` (`index.js:2155-2179`) 拆回逐篇经 `writeValidated` 校验后才覆写（校对失败不推翻已写成功的原文，缺席/非法保留原文）；批量快照补 `proofreadItems`（`index.js:2155`）供宿主重启重跑与 settle 拆回。
7. **索引与提交（index/commit）**：`tickIndex` (`index.js:2267-2297`)——`writtenCount>0` 时跑 `cw index` + `cw meta update`（`index.js:2267-2268`）、`normalizeIndexLinks` (`index.js:177-185`) 修正 `_index.md` 链接、`ensureWikiEntry` 补建入口（`index.js:2267`）；有产物且 `autoCommit` 开启则 `setStage('commit')` 提前返回（`index.js:2232-2235`），否则直接置 done 并唤醒。`tickCommit` (`index.js:2267-2283`) 执行 `autoCommitWiki` (`index.js:2267-2349`)：前置安全检查（非 git 仓库/无 HEAD/merge 进行中/未解决冲突/被 `.gitignore` 忽略/无改动/缺 `user.name`，`index.js:2267-2285`）→ 主题分支提交（`commitOn`，`index.js:2267-2279`）→ merge 回原分支 → `git branch -d`，结果写 `job.autoCommit`（`index.js:2267`）；三条通道（`wakeCompileSession` 实时 steer、`commitHintText` (`index.js:2267-2298`) 系统提示 section、面板任务卡）统一按 `autoCommitState` (`index.js:2267-2272`) 判定三态。
8. **观测与维护**：侧边栏面板 2s 轮询 `GET /api/codewiki/jobs`（`index.js:3057-3089`，非终态任务豁免 workspaceOnly 过滤 `index.js:3057`、`queueAhead` 注入 `index.js:3057-3069`）、仓库总览 `GET /api/codewiki/repos`（30s 缓存，签名含非终态任务工作区 `index.js:3057-3063`）、会话记录 `GET /api/codewiki/sessions`（带 `jobId` 单任务、不带即全局聚合 `index.js:3057-3078`）与全文 `sessions/item`（`index.js:3057-3074`）、控制端点 `POST /api/codewiki/control`（cancel/refresh/compile，`index.js:3057-3088`）；全部仅回环放行（`isLoopbackRequest` (`index.js:3057-3060`)）。系统提示维护提醒由 `installUpdateReminder` (`index.js:3057-3089`) 在 `agent/created` 注册 section `codewiki:update-reminder`（`index.js:3057`），门控只看仓库根 `CodeWiki.md`（`index.js:3057`），提醒正文 `reminderText` (`index.js:3057-3066`) + 降级提交提示 `commitHintText`（60s 缓存 `index.js:3057-3058`，仅 `pending` 时注入）。

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ 工具层 index.js                                                      │
│  cw (946)  codewiki_generate (2465)  codewiki_update (2641)          │
│  codewiki_progress (2712)          —— 全部纯提交/只读，零 LLM        │
└──────────────┬──────────────────────────────────────┬───────────────┘
               │ submit (2356)                        │ list/cancel
               ▼                                      ▼
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ JobService createJobService  │──►│ 端点 installWebServer (2920)      │
│  tick 10s (2268)             │   │ jobs/repos/sessions/models/       │
│  STAGE_HANDLER (2259):       │   │ model-efforts/control（回环 only）│
│  articles→crosscut→compose   │   └──────────────┬───────────────────┘
│  →review→index→commit→done   │                  │ 2s 轮询
└──────┬───────────┬───────────┘                  ▼
       │           │                    ┌──────────────────────────────┐
       │ 后台并发池 │                    │ client.js 面板               │
       ▼           ▼                    │ CodewikiPanel (1312)         │
┌────────────┐ ┌─────────────────┐      │ ReposTab (1071)              │
│ llmChat    │ │ 会话通道兜底     │      │ SessionView (1220)           │
│ (325)      │ │ dispatch (1736) │      │ CodewikiCard (516)           │
│ 宿主 llm   │ │ steer→子智能体   │      └──────────────────────────────┘
│ hy3/glm-5.3│ │ 轮询收割        │
└─────┬──────┘ └───────┬─────────┘
      ▼                ▼
  writeValidated (1580) + fixAnchors (455) → <repo>/.codewiki/
      ▼
  tickIndex (2209) cw index/meta → tickCommit (2241) autoCommitWiki (3241)
      ▼
  wakeCompileSession (1419) / commitHintText (3325) 按 autoCommitState 三态
```

## Data Flow

配置流：profile patch `config:` → cordis 注入 `apply(ctx, config)` (`index.js:3476`) → `liveConfig` (`index.js:78-108`) 每次调用解包（volatile 热生效）；设置页保存走 `configForms.mutate`（`client.js:748`）单层 op + revision CAS。凭证流：**插件不保存也不传递任何密钥**（0.10.1 删除内置百炼直连后无例外）——请求经宿主 `llm.stream()`（`llmChat`，`index.js:3476-3483`），凭证由所选 provider（默认 `workbuddy`）在模型设置里的配置解析。任务流：execute 预构建（含 token 预算分块）→ `jobs.json` 持久化（`index.js:3476`）→ 服务 tick 消费（项目闸门排队 `index.js:3476-3485`）→ 批次断点（`submitBatchFor` 落 `job.tasks`，`index.js:3476-3487`，跨会话续查）→ 文章落盘（`writeValidated`/`applyTaskResult`，`index.js:3476-3489`）+ 校对回写（`settleProofread`，`index.js:1624`）→ `cw index`/`meta update` → `autoCommitWiki` 主题分支合并提交 → `job.autoCommit` 三态。会话流：`beginSessionRecord` (`index.js:3476`) 每请求双文件落盘（`nnn.meta.json`+`nnn.full.json`，3s 节流 `SESSION_FLUSH_MS` (`index.js:3476`)），TTL 24h（`SESSION_TTL_MS` (`index.js:3476`)）由 tick 每 10 分钟 `pruneSessionRecords`（`index.js:3476`）清理。面板流：浏览器 2s 轮询 jobs 端点（回环 only），总览 10s 轮询 repos（`REPOS_POLL_MS` (`client.js:31`)），会话视图 5s 轮询（`client.js:212`）。

## Connections

- [[codewiki-upstream]] — `vendor/codewiki/`（MIT）；布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`（随仓库提交共享）；cw 三态输出由 `parseStatus` (`index.js:187-200`) 解析，Windows 反斜杠路径由 `normalizeArticlePath` (`index.js:173`) 归一（Rust 层 0.5.0.2 起已根治，插件层保留为纵深防御，CodeWiki.md:18）。
- [[documentation-and-config]] — README.md / CodeWiki.md / CHANGELOG.md / cordis.patch.yml / package.json 是本流程的文档与接线面；工具描述（`index.js:2468-2474`）、提醒正文（`index.js:3358-3367`）与设置页文案（`client.js:35-193` 中英双份）都随实现同步。
- [[test-suite]] — 五脚本验证本流程各段：test-batch.mjs 锁纯函数与执行链（123 项语义），test-orchestration.mjs 锁提交制 + 阶段机端到端（含 commit 阶段与 worktree 闸门），test-wiki-anchors.mjs 守卫文章行号锚点（`fixAnchors` 的校验语义与之同源，`index.js:501` 注明两处同步）。
- 宿主模型目录（`llm.listProviders` / `llm.listModels` / `resolveModelInfo`）— 默认编译模型 `workbuddy`/`hy3`（免费、192k 上下文、单请求输出上限 64k），故 `BATCH_TOKEN_BUDGET` (`index.js:474`)=110000（输入侧留余量）、`BATCH_TOKEN_HARD_LIMIT` (`index.js:474`)=128000（192k−64k 反推）。0.10.1 起 `batchProvider` 是唯一通道，留空直接提交失败（`index.js:474`）。

## Known Issues

- 插件注册不热加载：改 `index.js` / profile patch 后需重启 dsh（config 值本身热读）。`client.js` 同理：宿主「非 client 包」判定按 Loader 条目缓存，`dsh.client` 声明新增后需重启 dsh 才会把 `client.js` 送进浏览器（README.md:57、CodeWiki.md:70）。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `/e/software/deepseek-harness/vendor/schemastery`）；换机器需重建（CodeWiki.md:71）。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，`wikiPathFor` (`index.js:1093-1098`)，CodeWiki.md:72）；上游 stale 文章路径输出为反斜杠（`modules\app.md`），插件消费侧已归一为 `/`（CodeWiki.md:73）。
- 断点文件（未终态保留，跨会话续查）只记录阶段机位置（`stage`/`crosscutSplit`），重跑走普通入口同步请求；0.5.x 批量通道的 24h 批次窗口语义已随 0.6.0 删除（CodeWiki.md:74）。
- 会话通道任务依赖发起会话（`job.sessionId`）可用：面板/自动调度提交的 job 没有会话可 steer，超预算文章/校对任务直接整体失败并明示原因（`dispatchSessionTasks` (`index.js:2601-2604`)，不退超大兜底、不静默跳过校对）；超时默认 30 分钟（`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调），超时按失败处理、不降级。文章阶段与校对阶段共用 `job.sessionTasks`（按 stage 区分文案与 tally 的 replace 语义）；任务文件与 prompt 快照落在 `SESSION_TASK_DIR` (`index.js:2601`)，重启接管后重发 steer（`index.js:2601`）（CodeWiki.md:75）。
- 自动提交的合并冲突路径（编译期间用户在原分支推进导致 add/add 冲突）在同步流程内构造不出来，`autoCommitWiki` 的「merge 失败 → abort + 保留主题分支」（`index.js:3314-3320`）是防御性代码、单测不覆盖（test-orchestration.mjs:493-494 注释说明）；detached HEAD 与主题分支名被占用两条降级路径有真实用例（test-orchestration.mjs:482-505）。
- `test-wiki-anchors.mjs` 失败多为 wiki 文章行号漂移（本篇重编后由 `fixAnchors` 与守卫下一轮勘定）；历史日志 `.tmp-test-*.log` 全部是旧基线留档（百炼直连/plan 阶段时代），不能当作当前行为依据（.tmp-test-batch.log:76-85、.tmp-test-orchestration.log:120-185）。