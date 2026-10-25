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

`wiki-generation` 指 `@local/dsh-codewiki` 插件把一个代码仓库转化为结构化 CodeWiki 文档（`WIKI_PATHS` (`index.js:36`) 即 `<repo>/.codewiki/` 与 `CodeWiki.md`，随仓库提交共享）的端到端编译过程。入口工具 codewiki_generate 由 `generateToolDefinition` (`index.js:2247-2397`) 定义：纯提交制——`normalizeCwd` (`index.js:40-45`) 归一路径、`runCw` (`index.js:130-155`) 跑 cw status 判态、按判态预构建任务后经 `submit` (`index.js:2148-2213`) 交给宿主常驻编排服务 `createJobService` (`index.js:1238-2240`) 即返回，工具路径零 LLM 调用、零子代理、不委托发起会话的主模型。服务在 `tick` (`index.js:2069-2146`) 里以 `TICK_MS` (`index.js:1016`) 默认 10s 的节拍推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index → commit → done，阶段分发表是 `STAGE_HANDLER` (`index.js:2060-2067`)；0.10.7 起无规划阶段，模块清单由 `localPlan` (`index.js:685-698`) 按顶层目录本地分组。全部模型环节在插件内的后台并发池 `runRealtimeTasks` (`index.js:332-361`) 完成，唯一模型通道是 `llmChat` (`index.js:288-307`) 包装的宿主 llm 服务（0.10.1 起无内置直连，插件不保存任何密钥）：普通档默认 workbuddy/hy3（`DEFAULT_BATCH_PROVIDER` (`index.js:26-27`)，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET` (`index.js:374`)=110k）；110k–420k 输入自动升大档——默认 volces-ark/glm-5.3-flash（`DEFAULT_BIG_PROVIDER` (`index.js:30-31`)，512k 上下文），预算 `DEFAULT_BIG_TOKEN_BUDGET` (`index.js:33`)=420k；只有单文件连大档都装不下才转会话通道兜底（`dispatchSessionTasks` (`index.js:1537-1571`)，超时 `SESSION_TASK_TIMEOUT_MS` (`index.js:1020`) 默认 30 分钟按失败处理）。0.10.11 起产物提交是阶段机里的显式一步：`tickIndex` (`index.js:2010-2040`) 末尾在有产物且 autoCommit 开启时移交 commit 阶段（`index.js:36-39`），`tickCommit` (`index.js:2042-2058`) 执行 `autoCommitWiki` (`index.js:2948-3030`) 的「主题分支提交 → 合并回原分支」后才置 done 并唤醒；提交状态由 `autoCommitState` (`index.js:1214-1219`) 判定 committed/no-changes/pending 三态，`wakeCompileSession` (`index.js:1221-1236`) 在已提交/无改动时完全静默。本概念横跨文档说明、核心实现、测试验证与运行日志四大模块。

当前基线 0.10.11（package.json:3）。0.10.11 把 0.10.9 的「index 收尾顺带提交」升级为独立 commit 阶段 + 分支合并式提交（CHANGELOG.md:3-15）：`STAGE_HANDLER` (`index.js:2060-2067`) 新增 `commit: tickCommit`（`index.js:2060`）；`autoCommitWiki` (`index.js:2948-3030`) 重写为先在主题分支 `topic` (`index.js:2999`)（codewiki/wiki-<jobId>）上提交两个 wiki 路径，再 `merge` (`index.js:3015`) 以 `git merge --no-edit` 合并回原分支、`git branch -d` 删主题分支（`index.js:3025`）；detached HEAD 或建分支失败降级为直接提交（`index.js:2060-2069`），合并失败则 abort 并保留主题分支等手动合并（`index.js:3016-3023`）；`codewiki_progress` 输出与面板任务卡随之新增 mode/branch/fallback（`index.js:2060-2062`、`client.js:182-190`），面板阶段条与权重同步加 commit（`ACTIVE_STAGES` (`client.js:28`)、`STAGE_WEIGHTS` (`client.js:947`)、文案 `stageCommit` (`client.js:95`)）。此前：0.10.10 修复两轴 code-review 的全部发现——`autoCommitState` 成为三态唯一判定、`git add` 收敛为纯 pathspec（`index.js:2060`）、失败原因带 stderr 摘录（`index.js:2060`、`index.js:2060`）、修掉两处测试竞态（CHANGELOG.md:17-31）；0.10.9 起产物由插件自己提交、成功不再唤醒会话（CHANGELOG.md:33-47）；0.10.8 起 110k–420k 大档单请求优先、审校改批量校对（CHANGELOG.md:49-61）；0.10.7 删规划阶段（CHANGELOG.md:63-72）；0.10.6 起面板不藏占住串行闸门的工作区外任务（`index.js:2060-2064`）。

## Involved Modules

- **docs-and-meta**：README.md（四工具表 README.md:7-13、codewiki_generate 关键行为 README.md:15-22、全部设置项 README.md:24-40、本地 file:/// 安装 README.md:42-57、开发与验证 README.md:59-67）；CodeWiki.md（插件自身仓库的 wiki 入口 CodeWiki.md:3，Overview CodeWiki.md:7、Key Components CodeWiki.md:9-31、架构图 CodeWiki.md:35-57、Known Issues CodeWiki.md:68-75，重启 dsh 后可用 codewiki_generate 对本仓库重编）；CHANGELOG.md（0.1.0 → 0.10.11 全部行为变更，673 行，最新一节 0.10.11 在 CHANGELOG.md:3-15）；.probe3.txt（只有一行 `probe` 的探针占位，.probe3.txt:1，被 .gitignore:9 排除在仓库外）。
- **core-and-config**：`index.js`（插件全部逻辑，单文件 3169 行）；`client.js`（浏览器半侧，1375 行：插件页设置卡 `CodewikiCard` (`client.js:460-859`)、侧边栏面板 `CodewikiPanel` (`client.js:1145-1358`)、总览页 `ReposTab` (`client.js:1000-1143`)、阶段步骤条 `stageBar` (`client.js:923-945`) 与加权总进度 `STAGE_WEIGHTS` (`client.js:947`)、模型三件套渲染 `modelTrio` (`client.js:570-669`)、面板图标 `PanelIcon` (`client.js:1360-1371`)）；cordis.patch.yml（bundle 形式挂载补丁，file:/// 直挂条目 id codewiki，cordis.patch.yml:13-16，设置项注释 cordis.patch.yml:4-12）；package.json（版本 package.json:3、exports ./client package.json:8-11、engines.dsh package.json:13-16、dsh.client 平台声明 package.json:20-23、bundle 补丁指向 package.json:24-27）；.gitignore（`*.log` 与运行期产物不入库，.gitignore:3、.gitignore:11-12）。
- **test-scripts**：五个自检脚本直接 import 真实 index.js 导出——test-batch.mjs（501 行，纯函数与假 llm 执行链：大档接管块 test-batch.mjs:107-131、宿主 llm 通道块 test-batch.mjs:169-251）；test-orchestration.mjs（1358 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实 tick，tick 压到 300ms test-orchestration.mjs:15；autoCommitWiki 安全边界块 test-orchestration.mjs:405-506、`autoCommitState` 三态块 test-orchestration.mjs:508-518、唤醒块 test-orchestration.mjs:520-556、端到端含独立 commit 阶段断言 test-orchestration.mjs:617-658、单项目串行块 test-orchestration.mjs:726-773）；test-wiki-entry.mjs（76 行，CodeWiki.md 入口生成与 Windows 路径规范化）；test-wiki-anchors.mjs（118 行，行号锚点守卫：基础/符号绑定/区间三重断言，规则见 test-wiki-anchors.mjs:1-9）；test-cwd-paths.mjs（71 行，MSYS/Windows/不存在路径三态实测）。
- **logs-and-temp**：测试与排查落盘的历史日志，均不入 git——.tmp-test-batch.log（85 行，旧版执行链自检留档，末行 .tmp-test-batch.log:85 记 59 通过 0 失败，内容仍是百炼直连/resolveBatchApiKey 时代）；.tmp-test-cwd-paths.log（8 行）；.tmp-test-orchestration.log（旧版 plan 阶段尚存时代的运行留档，末行记 FAIL 2 项）；.tmp-test-wiki-anchors.log（161 行，旧基线 122 过/36 败的锚点校验留档）；.tmp-test-wiki-entry.log（25 行，全部通过）；watcher2.log（0.4.x 排查多实例 jobs 文件互覆时的轮询记录，记录的全是 2026-10-06 plan 阶段任务）。这些文件由 .gitignore:3 的 `*.log` 规则排除。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:15-22（提交制、scope=auto/full/stale 语义、并发默认 2、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）；0.10.11 变更全文见 CHANGELOG.md:3-15。
   - 设置项与默认值：`Config` (`index.js:51-71`)——编译模型三项（`index.js:51-53`）、大档四项（`index.js:51-54`）、`sessionTier` (`index.js:61`)、`maxConcurrency` 默认 2 硬顶 8（`index.js:62`，常量 `DEFAULT_CONCURRENCY` (`index.js:24`)、`CONCURRENCY_HARD_CAP` (`index.js:22`)）、`serialProjects` 默认开（`index.js:63`）、`autoCommit` 默认开（`index.js:66`）；全部 `.volatile()` 改完即生效（README.md:56）。
   - 配置链路：设置卡 `save` (`client.js:671-693`) 按保存键白名单（`client.js:671`）经 configForms.mutate 单层 op + revision CAS 保存（与 profile patch 手改等价、同样热生效）；provider/model 目录来自 `/api/codewiki/models`（`listModelCatalog` (`index.js:2624-2645`)），思考档位来自 `/api/codewiki/model-efforts`（`resolveModelEfforts` (`index.js:2662-2684`)，宿主方法适配 `resolveModelInfoOf` (`index.js:2651-2656`)）。
   - 插件接线：`apply` (`index.js:3110`) 注入 agents/llm 引用（`index.js:3110-3111`）、创建常驻服务（`index.js:3110`）、注册 cw/codewiki_generate/codewiki_update/codewiki_progress 四工具（`index.js:3110-3126`）、安装面板端点与系统提示提醒；`liveConfig` (`index.js:77-102`) 在每次 execute/tick 热读配置。
   - 自举：CodeWiki.md 是插件自身仓库的 wiki 入口（CodeWiki.md:3），收尾可用 codewiki_generate 重编本仓（CodeWiki.md:7）。
2. **任务提交**：
   - 判态与预构建：execute（`index.js:40-144`）→ `normalizeCwd` (`index.js:40-45`) 归一化 MSYS 盘符路径 → `excludedItem` (`index.js:252-261`) 排除清单（报错带命中条目，`index.js:2297-2298`）→ cw status（`parseStatus` (`index.js:181-194`) 解析四态 missing/uncompiled/clean/stale）→ clean 直接报告（`index.js:40-43`，scope=full 例外强制全量重编）；stale 遇无 wiki 自动升全量（`index.js:40-44`）；同仓库已有活动任务幂等返回（`index.js:40-48`），发起会话 id 存 `job.sessionId`（`index.js:2303`）供终态唤醒。
   - stale 逐篇更新：按旧文 frontmatter 经 `readSourceFiles` (`index.js:983-991`) / `parseSourceFiles` (`index.js:969-981`) 解析 source_files 预构建任务直达 articles（`index.js:983-1008`）；任务 `mission` 即「更新过期文章 …：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（`index.js:2352`）——本篇即该流程的产物；有变更但未命中任何文章时只刷新基线 meta update（`index.js:983-990`）；missing 态先 cw init（`index.js:983-989`）再提交全量（`index.js:983-988`）。
   - 提交语义：`submit` (`index.js:2148-2213`)——排除拒绝（`index.js:2148-2151`）、submitting 占位挡并发重复提交（`index.js:2157-2179`）、编译模型三项硬校验（`index.js:2148-2157`，provider 留空直接 fail 诚实报错、不降级子代理）、`credentialSource` 记 llm 路由（`index.js:2192`）、单项目串行：已有项目在推进则进 queued 并预置 pendingStage/pendingTasks（`index.js:2148-2160`）；先落盘再 `void tick()`（`index.js:2148-2149`）立即返回 {submitted, jobId, stage}。
   - 维护与进度入口：codewiki_update（`updateToolDefinition` (`index.js:2407-2459`)）固定 scope=auto，提交后追加「本步收尾、继续下一项、不要等待」引导（`index.js:2407-2410`）；codewiki_progress（`progressToolDefinition` (`index.js:2478-2582`)）只读立即返回，`progressView` (`index.js:2472-2476`) 按 taskList 算百分比，输出 schema 的 autoCommit 块含 mode/branch/fallback（`index.js:2407-2421`）且 render 按三态展示（`index.js:2407-2413`）；`jobSummary` (`index.js:1157-1194`) 为面板与 progress 共用的任务摘要。
3. **阶段机推进**：`tick` (`index.js:2069-2146`) 每 `TICK_MS` (`index.js:1016`) 一轮——进程级推进锁 `acquireTickLock` (`index.js:1133-1147`)、跨实例取消标记拾取 `syncCancelFlags` (`index.js:1332-1343`)、单项目串行 activeId 计算（`index.js:2069-2074`）、孤儿接管（`ORPHAN_TAKEOVER_MS` (`index.js:1064`)：另一实例停更超 5 分钟即接管，会话通道任务重发 steer `resendSessionSteer` (`index.js:1598-1611`)，`index.js:2069-2078`）、queued 唤醒恒进 articles（`index.js:2069-2079`）、旧 plan 任务迁移（`index.js:2069-2076`），最后按 `STAGE_HANDLER` (`index.js:2060-2067`) 分发到 articles/crosscut/compose/review/index/commit 六个处理器（`index.js:2132-2138`）。任务持久化 `JOBS_FILE` (`index.js:1015`)（tmp 下 dsh-codewiki-jobs.json，只留最近 `MAX_JOBS_KEPT` (`index.js:1065`)=30 条，`saveJobs` (`index.js:1150-1155`) 整写）；多实例安全 = tick 进程锁 + 脏标记 + 磁盘吸收合并 + 每轮从磁盘拾取 cancel 标记；宿主重启后执行器丢失时按 `job.tasks` 持久化的 batchPrompt 快照自动重跑当前阶段（`settleJob` (`index.js:1356-1377`)）；已知仓库清单 `REPOS_FILE` (`index.js:1070`) 由 `rememberRepo` (`index.js:1074-1082`) 提交即登记（总览页据此发现已编译工作区）。

```text
模型调用 codewiki_generate (index.js:2247)     纯提交、零 LLM、零子代理
        │ normalizeCwd (index.js:40) → 排除清单 → cw status 判态 → 任务预构建
        ▼
  submit (index.js:2148) ──► {submitted, jobId, stage} 立即返回
        │ （宿主后台 createJobService (index.js:1238)，tick (index.js:2069) 默认 10s；
        │   单项目串行时后提交项目进 queued 排队，前一个终态后自动轮到）
        ▼
  queued ──► articles ──► crosscut ──► review ──► index ──► commit ──► done
  （compose 仅在文章/横切输入超大档预算拆观察→合成时出现）
        │  全部请求经 llmChat (index.js:288) 走宿主 llm 服务：
        │  ≤110k 普通档 hy3 ｜ 110k–420k 大档 glm-5.3-flash ｜ 单文件超限 → 会话通道兜底
        ▼
  tickCommit (index.js:2042) → autoCommitWiki (index.js:2948)
        │  主题分支 codewiki/wiki-<jobId> 提交两个 wiki 路径 → merge 回原分支 → 删分支
        ├─ committed / no-changes → 静默，不唤醒会话
        └─ pending → 一次性「产物待提交」提醒（steer + 系统提示 section）
```

4. **写文章阶段（articles）**：`tickArticles` (`index.js:1619-1740`)——stale 用预构建任务，full 就地 `scanRepoFiles` (`index.js:1100-1123`) + `localPlan` (`index.js:685-698`) 生成模块清单（`index.js:1619-1624`）；`prepareArticleTasks` (`index.js:560-645`) 装填：整模块源码由 `collectSources` (`index.js:489-516`) 内联（每行带「N| 」行号前缀，`numberLines` (`index.js:390-392`)），token 粗算 `estimateTokens` (`index.js:272-280`)；≤110k 普通档单请求、110k–大档预算（`BATCH_TOKEN_HARD_LIMIT` (`index.js:379`)=128k 或大档 420k）升大档单请求（任务标 bigTier 自带 provider/model，`index.js:1619-1636`）、总量超大档预算才按 110k 拆观察批（`batchArticleObservePrompt` (`index.js:784-800`)，`index.js:1619-1635`）收割后合成（`batchArticleComposePrompt` (`index.js:804-832`)，重建逻辑 `index.js:1619-1676`）；单文件连大档都装不下进 sessionTasks 会话通道（`index.js:1619`）。批次提交 `submitBatchFor` (`index.js:1501-1529`) 记账并启动执行器 `startBatchChatRun` (`index.js:1459-1499`)，收割 `settleJob` (`index.js:1356-1377`)、落盘闸门 `writeValidated` (`index.js:1382-1398`)（frontmatter 校验 + `fixAnchors` (`index.js:401-484`) 行号锚点自动校正）与 `tally` (`index.js:1401-1422`) 记账；会话通道派发 `dispatchSessionTasks` (`index.js:1537-1571`)（steer 文本 `buildSessionSteerText` (`index.js:1044-1062`)，档位可由 sessionTier 钉死）、每 tick 收割 `progressSessionTasks` (`index.js:1575-1594`)（三态判定 `classifySessionTask` (`index.js:1027-1037`)）；全部失败（writtenCount=0）则任务失败且 wiki 基线不变（`index.js:1619`）。prompt 模板 `batchArticlePrompt` (`index.js:520-547`) 与格式条款 `articleFormatSection` (`index.js:651-680`) 规定 frontmatter（title/type/source_files/tags）+ 六章节结构——本篇格式即来源于此。
5. **横切与合成（crosscut/compose）**：`tickCrosscut` (`index.js:1764-1846`) 用成功模块文章全文作输入（`packArticles` (`index.js:702-721`) 装不下截头部并标注）：总量 ≤ 大档预算单批直出 `_architecture.md`/`_patterns.md`（`batchArchitecturePrompt` (`index.js:737-743`)、`batchPatternsPrompt` (`index.js:745-751`)，本地规划不产概念（`index.js:1764`，概念专文模板 `batchConceptPrompt` (`index.js:753-759`) 仍在但 concepts 目录恒空）；超预算才每篇模块文章一个观察任务（`batchObservePrompt` (`index.js:763-780`)）并发跑，settle 后进 compose 阶段提交合成批（`tickCompose` (`index.js:1849-1861`)、`submitComposeBatch` (`index.js:1863-1873`)，任务装配 `crosscutTasks` (`index.js:1743-1762`)）。
6. **批量校对（review）**：`tickReview` (`index.js:1898-2008`) 先 `localReview` (`index.js:1876-1896`) 本地核对（frontmatter 必填、source_files 存在性、丢文件回退计数），再把逐篇「文章+源码」按 110k 贪心合并成批量校对请求（`batchProofreadBatchPrompt` (`index.js:859-886`)；单篇装不下先升大档重装 `index.js:1898-1899`，连大档都装不下转会话通道 `index.js:1898-1906`）；输出按 `@@@article:`/`
