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

`wiki-generation` 指 `@local/dsh-codewiki` 插件把代码仓库转化为结构化 CodeWiki 文档的端到端过程。入口工具 codewiki_generate 由 `generateToolDefinition`（`index.js:2247`）定义：纯提交制——`runCw`（`index.js:130`）跑 cw status 判态、预构建任务后经 `submit`（`index.js:2148`）交给宿主常驻编排服务 `createJobService`（`index.js:1238`）即返回，零 LLM 调用、零子代理、不委托发起会话的主模型。服务以 `TICK_MS`（`index.js:1016`，默认 10s）推进阶段机 queued → articles → crosscut →（超预算拆分时 compose）→ review → index → commit（0.10.11 新增独立提交阶段，CHANGELOG.md:8）；0.10.7 起无规划阶段，模块清单由 `localPlan`（`index.js:685`）按顶层目录本地分组。全部模型环节在插件内完成，唯一通道是 `llmChat`（`index.js:288`）包装的宿主 llm 服务（0.10.1 起无内置直连、插件零密钥）：普通档 `workbuddy`/`hy3`（`index.js:26-27`，192k 上下文，单请求输入预算 `BATCH_TOKEN_BUDGET`（`index.js:374`）=110k）；110k–420k 输入自动升大档——默认 `volces-ark`/`glm-5.3-flash`（`index.js:2247-2248` 声明，512k 上下文），预算 `DEFAULT_BIG_TOKEN_BUDGET`（`index.js:33`）=420k；只有单文件连大档都装不下才转会话通道兜底（`dispatchSessionTasks`（`index.js:1537`））。0.10.11 起编译产物提交是阶段机里的显式一步：`tickIndex`（`index.js:2010`）末尾移交 commit 阶段（`index.js:2247-2250`），`tickCommit`（`index.js:2042`）执行 `autoCommitWiki`（`index.js:2948`）的「主题分支提交 → 合并回原分支」后才置 done 并唤醒（`index.js:2247-2249`）；提交状态由 `autoCommitState`（`index.js:1214`）判定 committed/no-changes/pending 三态，`wakeCompileSession`（`index.js:1221`）在已提交/无改动时零打扰。概念横跨文档说明、核心实现、测试验证与运行日志四大模块。

当前基线 0.10.11（package.json:3）：0.10.11 把 0.10.9 的「index 收尾顺带提交」升级为独立 commit 阶段 + 分支合并式提交——`STAGE_HANDLER`（`index.js:2060-2067`）新增 `commit: tickCommit`，`autoCommitWiki`（`index.js:2948`）重写为先在主题分支 `codewiki/wiki-<jobId>`（`index.js:2060`）上提交两个 wiki 路径、再 `git merge --no-edit`（`index.js:2060`）合并回原分支并 `git branch -d` 删主题分支（`index.js:3025`）；detached HEAD/建分支失败降级直接提交（`index.js:2994-2998`、`index.js:2060-2063`），合并失败 abort + 保留主题分支（`index.js:2060-2067`）；`codewiki_progress` 输出与面板任务卡随之新增 `mode`/`branch`/`fallback`（`index.js:2527-2529`、client.js:1258）。0.10.10 修复两轴评审发现（`autoCommitState` 三态唯一判定、`git add` 纯 pathspec（`index.js:2060`）、失败原因带 stderr 摘录、测试竞态）；0.10.9 起产物由插件自己提交、成功不再唤醒会话；0.10.8 起大档单请求优先并把审校改为批量校对；0.10.7 删规划阶段；0.10.6 起面板不藏占串行闸门的工作区外任务（`index.js:2060`）。

## Involved Modules

- **docs-and-meta**：README.md（四工具表 README.md:7-13、关键行为 README.md:15-22、全部设置 README.md:24-40、安装 README.md:42-57、开发与验证 README.md:59-67）、CodeWiki.md（插件自身仓库的 wiki 入口，CodeWiki.md:3，重启后可用 codewiki_generate 对本仓库重编）、CHANGELOG.md（0.1.0 → 0.10.11 全部行为变更，673 行）、.probe3.txt（内容仅一行 `probe` 的探针占位，`.probe3.txt:1`）。
- **core-and-config**：`index.js`（插件全部逻辑，单文件 3169 行）、`client.js`（浏览器半侧 1375 行：插件页设置卡 `CodewikiCard`（client.js:460）、侧边栏面板 `CodewikiPanel`（client.js:1145）、阶段步骤条（client.js:460-486）与加权进度（client.js:460-469）、总览页 `ReposTab`（client.js:1000）、面板图标 `PanelIcon`（client.js:1360））、cordis.patch.yml（file:/// 直挂补丁，条目 id codewiki，cordis.patch.yml:13-16）、package.json（版本 package.json:3、exports ./client package.json:8-11、dsh.client 声明 package.json:20-27）、.gitignore（运行期产物不入库，.gitignore:3、.gitignore:11-12）。
- **test-scripts**：五个自检脚本直接 import 真实 `index.js` 导出——test-batch.mjs（501 行，纯函数与假 llm 执行链）、test-orchestration.mjs（1358 行，服务编排冒烟：mock 宿主 llm + 真实 cw CLI + 真实 tick）、test-wiki-entry.mjs（76 行，入口生成与 Windows 路径规范化）、test-wiki-anchors.mjs（118 行，行号锚点守卫）、test-cwd-paths.mjs（71 行，路径形态实测）。
- **logs-and-temp**：测试运行落盘日志与排查记录——.tmp-test-batch.log（85 行）、.tmp-test-cwd-paths.log（8 行）、.tmp-test-orchestration.log（573 行）、.tmp-test-wiki-anchors.log（161 行）、.tmp-test-wiki-entry.log（25 行）、watcher2.log（1397 行）。

## Flow

1. **配置与理解**：
   - 工具语义与关键行为：README.md:15-22（提交制、scope=auto/full/stale 语义、并发默认 2、单项目串行、单篇失败只记账不中断、全部失败不刷新基线）；0.10.11 变更全文见 CHANGELOG.md:3-15。
   - 设置项与默认值：Config schema（`index.js:51-71`）——编译模型三项（`index.js:54-56`）、大档四项（`index.js:57-60`）、`sessionTier`（`index.js:61`）、`maxConcurrency` 默认 2（`index.js:62`）、`serialProjects` 默认开（`index.js:63`）、`autoCommit` 默认开且描述即「主题分支上提交产物再合并回原分支」（`index.js:66`）；全部 volatile、改完即生效（README.md:32）。
   - 配置链路：设置卡 `save`（client.js:671-693，保存键白名单 client.js:671）经 configForms.mutate 单层 op + revision CAS 保存（与 profile patch 手改等价、同样热生效）；`apply`（`index.js:3110`）注入 agents/llm（`index.js:3110-3111`）并创建常驻服务（`index.js:3110`），`liveConfig`（`index.js:77`）在每次 execute/tick 读取。
   - 自举：CodeWiki.md 是插件自身仓库的 wiki 入口（CodeWiki.md:3），收尾可用 codewiki_generate 重编本仓。
2. **任务提交**：
   - 判态与预构建：execute（`index.js:40`）→ `normalizeCwd`（`index.js:40`）归一化 MSYS 盘符路径 → `excludedItem`（`index.js:252`）排除清单（报错带命中条目，`index.js:2297-2298`）→ cw status（`runCw`（`index.js:130`）+ `parseStatus`（`index.js:181`）四态 missing/uncompiled/clean/stale）→ clean 直接报告（`index.js:40-43`，scope=full 例外强制全量重编）；stale 遇无 wiki 自动升全量（`index.js:40-45`）。
   - stale 逐篇更新：按旧文 frontmatter 经 `parseSourceFiles`（`index.js:969`）解析 source_files 预构建任务直达 articles（`index.js:969-995`）；任务 `mission` 即「更新过期文章 …：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（`index.js:2352`）——本篇即该流程产物；有变更但未命中任何文章时只刷新基线 meta update（`index.js:969-976`）；missing 态先 cw init 再提交全量（`index.js:969-975`）。
   - 提交语义：`submit`（`index.js:2148`）——submitting 占位（`index.js:2148-2152`）挡并发重复提交；编译模型三项校验（`index.js:2148-2157`，provider 留空即落 job failed 诚实报错）；单项目串行（`index.js:2148-2160`：已有项目在推进则进 queued，预置 pendingStage/pendingTasks，前一个终态后 tick 自动轮到）；发起会话 id 存 `job.sessionId`（`index.js:2164`）供终态唤醒；先落盘再 `void tick()`（`index.js:2148-2149`）立即返回 {submitted, jobId, stage}。
   - 维护与进度入口：codewiki_update（`updateToolDefinition`（`index.js:2407`））固定 scope=auto（`index.js:2407`）、提交后追加「本步收尾、继续下一项」（`index.js:2407`）；codewiki_progress（`progressToolDefinition`（`index.js:2478`））只读立即返回，`progressView`（`index.js:2472`）按 taskList 算百分比，输出 schema 的 autoCommit 块含 `mode`/`branch`/`fallback`（`index.js:2527-2529`）且 render 按三态展示（`index.js:2407-2413`）；`jobSummary`（`index.js:1157`）为面板与 progress 共用摘要（autoCommit 字段 `index.js:2407`）。
3. **阶段机推进**：`tick`（`index.js:2069`）每 `TICK_MS`（`index.js:1016`）一轮——先跨实例取消拾取（`syncCancelFlags`（`index.js:1332`））与孤儿接管（`ORPHAN_TAKEOVER_MS`（`index.js:1064`），停更超 5 分钟接管并重发会话 steer，`index.js:2069-2078`）、算单项目串行 activeId（`index.js:2069-2074`），queued 唤醒恒进 articles（`index.js:2069-2079`），旧 plan 任务迁移（`index.js:2069-2076`），再按 `STAGE_HANDLER`（`index.js:2060-2067`）分发到 articles/crosscut/compose/review/index/commit 六个处理器。任务持久化 `JOBS_FILE`（`index.js:1015`，tmp 下 dsh-codewiki-jobs.json，只留 `MAX_JOBS_KEPT`（`index.js:1065`）=30 条；进程级锁 `acquireTickLock`（`index.js:1133`）+ 脏标记 + 磁盘合并 `mergeFromDisk`（`index.js:1270`）防多实例互覆）。

```text
模型调用 codewiki_generate (index.js:2247)   纯提交、零 LLM、零子代理
        │ cw status 判态 → 任务预构建 → submit (index.js:2148) 即返回 {jobId, stage}
        ▼
createJobService tick (index.js:2069) ──单项目串行──► queued 排队
        ▼
articles (index.js:1619) ── prepareArticleTasks (index.js:560) 源码装填
        │   ≤110k 普通档 │ 110k–420k 大档单请求 │ >420k 观察→合成 │ 单文件超限 → 会话通道
        │ submitBatchFor (index.js:1501) → runRealtimeTasks (index.js:332) → llmChat (index.js:288)
        ▼
crosscut (index.js:1764) ──总量>420k 拆观察──► compose (index.js:1849)
        ▼
review (index.js:1898) 批量校对（@@@article:/
