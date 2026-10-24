---
title: documented-contract
type: concept
source_files:
  - test-orchestration.mjs
  - .tmp-test-orchestration.log
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - index.js
  - client.js
  - package.json
tags: [文档契约, 跨模块, codewiki, frontmatter, 文章格式, 测试验证]
---

## Overview

`documented-contract` 指 dsh-codewiki 插件（当前版本 0.10.9，package.json:6）中由文档显式规定、并被代码与测试共同遵守的结构化约定。核心包含四层契约：(1) **入口契约**——仓库根 `CodeWiki.md` 声明为项目 wiki 入口（CodeWiki.md:3），`codewiki_generate` 以其为起点细化出 `.codewiki/` 文章群，`ensureWikiEntry`(index.js:211) 在编译收尾时对缺失入口自动生成模板且绝不覆盖已有入口（index.js:211）；(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`）开头并含固定六章节，由 `articleFormatSection`(index.js:648) 规定模板，`writeValidated`(index.js:1362) 强制 frontmatter 闸门，`fixAnchors`(index.js:398) 依据 frontmatter `source_files` 校正行号锚点；(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（index.js:211），阶段机 articles→crosscut→compose→review→index 已无规划阶段（STAGE_HANDLER index.js:211，0.10.7 删除），编译产物由插件自己 `autoCommitWiki`(index.js:2904) 提交、成功时不唤醒会话（`wakeCompileSession` index.js:211）；(4) **工具输出 schema 契约**——四个工具的输出经宿主 JSON Schema 校验（index.js:211、index.js:211），可空字段一律 `oneOf` 形态。测试侧 `articleMd`(test-orchestration.mjs:29) 合成契约文章、输出 schema 校验块（test-orchestration.mjs:30-68）与自动提交断言组（test-orchestration.mjs:376-448）验证契约不被破坏，让文档自身成为可机器消费的索引。

## Key Components

### index.js 契约执行侧符号

- `articleFormatSection`(index.js:648-677)：定义文章模板，硬编码 frontmatter 键（index.js:648-653）与章节顺序 `## Overview`…`## Known Issues`（index.js:648-653）；行号引用条款「行号以源码『行号| 』前缀为准，禁止自行数行」（index.js:648）与 source_files 完整性条款「必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:648）。
- `writeValidated`(index.js:1362-1378)：keepInMemory 任务（横切/校对/合成）的唯一落盘闸门，要求内容以 `---` frontmatter 开头否则记 invalid 丢弃、原文件保留（index.js:1362-1364）；写盘前过 `fixAnchors`(index.js:1369)。
- `applyTaskResult`(index.js:308-321)：普通文章任务直写出口，同样先 `fixAnchors`(index.js:312) 再落盘；keepInMemory 只回内存不落盘（index.js:308）。
- `fixAnchors`(index.js:398-481)：落盘前把「file:NN(-MM)」锚点对照 source_files 源码确定性校正，仅对 frontmatter `source_files` 内文件引用生效（index.js:398-402）；多处出现时只认唯一声明形态（function/class/const/let 正则 index.js:398），歧义或找不到→不改并记 unresolved（index.js:398-400）；区间尾越界钳到文件尾（index.js:398）；混合行尾按整文主风格规范化（index.js:398）。
- `parseSourceFiles`(index.js:966-978)：解析 frontmatter 的 `source_files`，支持 inline `[a,b]`（index.js:967-969）与 block `- a`（index.js:971-976）两式；`readSourceFiles`(index.js:980-988) 供 stale 流程取文件清单（index.js:2308）。
- `numberLines`(index.js:387-389)：源码内联时每行加「N| 」grep 风格前缀——行号契约的数据基础（`collectSources` index.js:497 使用）。
- `ensureWikiEntry`(index.js:211-244)：编译收尾保证入口存在，已有入口绝不覆盖（index.js:211），缺失时按语言生成中/英模板（index.js:211-237）；由 `tickIndex` 在 writtenCount>0 时调用（index.js:2003）。
- `installUpdateReminder`(index.js:2989-3021)：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:2989，order=TOOL_REPORT+1 index.js:2989），text 回调实时求值——门控只看仓库根是否有 `CodeWiki.md`（index.js:2989），不看 `.codewiki/` 目录；`updateReminder=false` 返回空串（index.js:2989）。
- `reminderText`(index.js:2978-2987)：维护提醒正文——收尾必须调 `codewiki_generate`、不要手改 `.codewiki/` 文章、不要等待/轮询、产物由插件自动提交（index.js:2982）。
- `commitHintText`(index.js:2947-2976)：0.10.9 起只在插件自动提交失败时注入一次性「产物待提交」提醒——条件为最近成功编译的 finishedAt 晚于 `.codewiki`+`CodeWiki.md` 最后一次 git 提交（index.js:2947），文案带 autoCommit 失败原因（index.js:2947-2949）并写明不要中断任务（index.js:2947）；60s TTL 缓存按 cwd 键（index.js:2947、index.js:2947-2949）。
- `autoCommitWiki`(index.js:2904-2945)：编译产物自动提交边界（0.10.9）。只 add `.codewiki` 与 `CodeWiki.md` 两路径（index.js:2904），信息前缀 `docs(wiki):` 带任务 id 与篇数（index.js:2904-2905）、`--no-verify` 不跑仓库钩子（index.js:2904）；安全边界逐条拒绝并降级：非 git 仓库（index.js:2904）、无 HEAD（index.js:2904）、merge/rebase/cherry-pick 进行中（index.js:2904-2906）、未解决冲突（index.js:2904）、目标路径被 .gitignore 忽略（index.js:2904-2908）、缺 user.name/user.email（index.js:2904-2906）、add/commit 失败（index.js:2904-2914）；无改动返回 `noChanges` 不产空提交（index.js:2925）。返回 `{committed, sha?, message?, noChanges?, reason?}` 由 `tickIndex` 写入 `job.autoCommit`（index.js:2014-2020）。
- `wakeCompileSession`(index.js:1202-1216)：编译终态 steer 唤醒。0.10.9 起 `outcome!=='failed'` 且 `job.autoCommit.committed` 时直接 return——自动提交成功即完全不打扰会话（index.js:1205）；steer 消息 `source: {kind:'plugin:codewiki'}`（index.js:1202）；无 sessionId/冷会话/registry 抛错/steer 抛错一律静默（index.js:1202-1211）。
- prompt 模板构造器：`batchArticlePrompt`(index.js:517-544) 在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；行号一律不得沿用」（index.js:517，合成版同款 index.js:517）并收尾注入 `articleFormatSection()`（index.js:541）；`batchArchitecturePrompt`(index.js:734)、`batchPatternsPrompt`(index.js:742)、`batchConceptPrompt`(index.js:750)、`batchObservePrompt`(index.js:760)、`batchArticleObservePrompt`(index.js:781)、`batchArticleComposePrompt`(index.js:801)、`batchProofreadPrompt`(index.js:833) 同守格式条款；`batchProofreadBatchPrompt`(index.js:856-883) 规定 0.10.8 批量校对的 `@@@article: 名`/`@@@end` 标记输出契约（index.js:517）。
- `settleProofread`(index.js:1406-1430)：按标记拆回逐篇（正则 index.js:1406），`writeValidated` 校验通过才覆写（index.js:1420），缺席/非法保留原文（index.js:1406、index.js:1406）——「校对失败不推翻已写成功文章」的契约。
- `localPlan`(index.js:682-695)：0.10.7 起唯一的模块规划路径（按顶层目录分组 index.js:682-687），`concepts` 恒为空数组（index.js:693）——横切阶段对空 concepts 兼容，只产 `_architecture`/`_patterns`（`crosscutTasks` index.js:1723-1742）。
- `generateToolDefinition`(index.js:2210-2360)：`codewiki_generate` 纯提交制；输出 schema required 仅 `cwd/scope/wikiPath/state/submitted/notes`（index.js:2210），`jobId/stage` 只在提交/幂等/续查路径赋值、不放 null 占位（index.js:2210）；stale 更新任务的 mission 即契约文案「以当前代码为准重写其内容，保留章节结构与 title/type/tags」（index.js:2210）。
- `updateToolDefinition`(index.js:2370-2422)：固定 scope=auto 的维护入口（index.js:2370），错误消息前缀改写为 codewiki_update（index.js:2370）。
- `progressToolDefinition`(index.js:2441-2542)：只读查进度；输出 schema 里 `progress`/`batchProgress`/`tps`/`error`/`finishedAt` 等可空字段一律 `oneOf: [type, {type:'null'}]`（index.js:2471、index.js:2476、index.js:2479、index.js:2493、index.js:2496），`autoCommit` 为对象或 null（index.js:2481-2492）；render 直接展示自动提交结果（index.js:2514-2519）。
- `excludedItem`(index.js:249-258)/`isExcluded`(index.js:259-261)：排除清单大小写不敏感子树匹配，`excludedItem` 返回命中条目原文供报错（0.8.1 契约）；`submit`(index.js:2113-2116) 与工具 execute（index.js:2260-2261）双重检查。
- `createJobService`(index.js:1218-2203)：阶段机执行器。`saveJobs`(index.js:1147-1152) 只留最近 30 条（MAX_JOBS_KEPT index.js:1218）且必落 `cancelRequested`（0.10.1 起无 apiKey 字段，index.js:1218）；`setStage`(index.js:1287-1297) 统一累计 `stageTimings`；`tick`(index.js:2032-2109) 每轮先算单项目串行 activeId（index.js:1218-1223）、queued 轮到时落地 pendingStage（index.js:1218-1228）、旧 plan 任务迁移到 articles（index.js:1218-1225）；`tickIndex`(index.js:1990-2022) 收尾 cw index/meta update + CodeWiki.md 入口补建 + autoCommit。
- 常量：`PLUGIN_NAME='dsh-codewiki'`(index.js:1012)、`BATCH_TOKEN_BUDGET=110000`(index.js:1012)、`BATCH_TOKEN_HARD_LIMIT=128000`(index.js:1012)、`DEFAULT_BATCH_PROVIDER='workbuddy'`(index.js:1012)/`DEFAULT_BATCH_MODEL='hy3'`(index.js:1012)、大档 `DEFAULT_BIG_PROVIDER='volces-ark'`(index.js:1012)/`DEFAULT_BIG_MODEL='glm-5.3-flash'`(index.js:1012)/`DEFAULT_BIG_TOKEN_BUDGET=420000`(index.js:1012)、`JOBS_FILE`(index.js:1012)、`TICK_MS`（默认 10s，index.js:1013）、`SESSION_TASK_TIMEOUT_MS`（默认 30 分钟，index.js:1017）、`REPOS_FILE`(index.js:1067)、`ORPHAN_TAKEOVER_MS`（默认 5 分钟，index.js:1061）、`JOB_TERMINAL`(index.js:1080)。

### test-orchestration.mjs 验证侧符号

- `articleMd`(test-orchestration.mjs:29-30)：合成符合 frontmatter 契约的假文章 markdown（title/source/marker/type，默认 `type: 'module'`），用于 mock 应答与落盘验证。
- `check`(test-orchestration.mjs:23-26)：断言收集器，`failures` 计数决定退出码（test-orchestration.mjs:1269-1270）。
- `batchCfg`(test-orchestration.mjs:34)：返回 `{ batchProvider: 'workbuddy', batchModel: 'hy3' }` 基线——0.10.1 起编译模型必须显式指向模型设置里的 provider/model，provider 留空即提交失败（test-orchestration.mjs:34-35）。
- `makeCtx`(test-orchestration.mjs:40-80)：mock 宿主上下文，inject 同时支持 cordis 带回调与 promise 两种风格（test-orchestration.mjs:40-50），`effect` 收集 disposer 防错写法（test-orchestration.mjs:73-77）。
- `makeBatchMock`(test-orchestration.mjs:134-198)：假 llm 服务按 prompt 首行特征分发应答——文章观察员（test-orchestration.mjs:134-137）、文章作者（test-orchestration.mjs:134-137）、架构观察员（test-orchestration.mjs:134-136）、横切三篇（test-orchestration.mjs:134-136）、批量校验员按 `@@@article` 标记逐篇回标记格式（test-orchestration.mjs:134-147）；记录 `llmCalls` 供断言 provider/model/reasoningEffort（test-orchestration.mjs:171）。
- `waitJob`(test-orchestration.mjs:201-214)：轮询独立 `JOBS_FILE`（test-orchestration.mjs:19 隔离到进程专属路径）取某 cwd 最新 job 终态。
- `fakeReq`(test-orchestration.mjs:216-225)/`fakeRes`(test-orchestration.mjs:226-228)：模拟 HTTP 验证回环守卫与非回环 403（test-orchestration.mjs:903-905）。
- 入口契约断言组（test-orchestration.mjs:230-259）：section 名（test-orchestration.mjs:245）、有 CodeWiki.md 时提醒非空且指向 codewiki_generate（test-orchestration.mjs:246）、无 .codewiki 空文本（test-orchestration.mjs:247）、有 .codewiki 但根无 CodeWiki.md 也不注入（守护收紧，test-orchestration.mjs:249-253）、`updateReminder=false` 运行时开关（test-orchestration.mjs:255-256）。
- 提交提醒断言组（test-orchestration.mjs:308-373）：无 .codewiki 提交史→提醒（test-orchestration.mjs:316-318）、编译早于最后提交→静默（test-orchestration.mjs:337-338）、编译晚于提交→提醒（test-orchestration.mjs:347-349）、提醒带自动提交失败原因（test-orchestration.mjs:359-363）、writtenCount=0→不提醒（test-orchestration.mjs:369-370）；60s 缓存按 cwd 键，测试换全新 fixture 仓库绕开（test-orchestration.mjs:328-330、test-orchestration.mjs:339-340）。
- autoCommitWiki 断言组（test-orchestration.mjs:376-448）：正常提交只含两路径且信息带 `docs(wiki)` 前缀与任务 id（test-orchestration.mjs:388-391）、未 staged 的源码改动留在工作区不被卷入（test-orchestration.mjs:392-393）、noChanges 不空提交（test-orchestration.mjs:395-396）、非 git/被 ignore/合并中/缺 git identity 各拒绝分支（test-orchestration.mjs:400-405、test-orchestration.mjs:408-415、test-orchestration.mjs:418-425、test-orchestration.mjs:428-447）。
- wakeCompileSession 断言组（test-orchestration.mjs:450-482）：autoCommit 成功→done 完全不唤醒（test-orchestration.mjs:459-460）、失败→降级提醒一次且带原因（test-orchestration.mjs:462-468）、source 标记 `plugin:codewiki` (v4)（test-orchestration.mjs:469）、failed 消息含失败原因（test-orchestration.mjs:470-472）、无 sessionId/冷会话/registry 抛/steer 抛全静默（test-orchestration.mjs:473-481）。
- 规划契约断言（test-orchestration.mjs:484-541）：全程零勘探员请求（test-orchestration.mjs:509）、localPlan 顶层目录分组入库（test-orchestration.mjs:511-513）、concepts 为空数组（test-orchestration.mjs:514）。
- 全量编译 e2e（test-orchestration.mjs:543-582）：提交即返回且初始 stage=articles（test-orchestration.mjs:550-551）、返回值不含 writtenCount（test-orchestration.mjs:552）、终态 done（test-orchestration.mjs:555）、HEAD 提交只含 wiki 产物（test-orchestration.mjs:559-561）、`docs(wiki):` 前缀（test-orchestration.mjs:563-564）、校对回写含 PROOFED（test-orchestration.mjs:576）。
- 输出 schema 校验（test-orchestration.mjs:1138-1176）：与宿主校验器同构的 `validateOut`——属性存在时类型必须匹配，null/undefined 不算缺失（test-orchestration.mjs:1138-1153），首提与二次调用均过 schema（test-orchestration.mjs:1164-1167）。
- 其余契约组：单项目串行（test-orchestration.mjs:650-697）、唯一通道全走宿主 llm（test-orchestration.mjs:699-731）、stale 逐篇恰好更新声明文件的 2 篇（test-orchestration.mjs:733-754）、宿主重启 prompt 快照重跑与旧 plan 任务迁移（test-orchestration.mjs:793-850）、并发提交占位与 flush 磁盘合并（test-orchestration.mjs:852-890）、面板端点（test-orchestration.mjs:892-944）、knownRepos（test-orchestration.mjs:1001-1039）、workspaceOnly 过滤与非终态例外放行（test-orchestration.mjs:1041-1102）、registry 抛错降级不过滤（test-orchestration.mjs:1104-1132）、孤儿接管（test-orchestration.mjs:1174-1206）、编译模型缺失诚实报错并落 failed 留痕（test-orchestration.mjs:1208-1221）、严格 cordis 语义（test-orchestration.mjs:1223-1245）。

### client.js 消费侧符号

- `CodewikiPanel`(client.js:1137)：任务面板，`POLL_MS=2000`(client.js:1137) 轮询 `JOBS_PATH`(client.js:19)；`jobCard`(client.js:1231) 渲染任务卡。
- `stageBar`(client.js:915-937)：阶段步骤条；`ACTIVE_STAGES`(client.js:28) 0.10.7 起无 plan、`queued` 单列最前（单项目串行排队位）；`STAGE_WEIGHTS`(client.js:939) 把 plan 的 0.05 权重并入 articles 得 0.65；`lastTimedStage`(client.js:911-914) 过滤旧任务残留的已删阶段键，失败/取消才能正确标红。
- `usageLine`(client.js:973-989)/`throughputBadge`(client.js:951-971)：用量与吞吐展示契约（tok/s+spark 或 篇/分+ETA）。
- `CodewikiCard`(client.js:452)：设置表单；`save` 的保存键白名单（client.js:672）含 `autoCommit`/`workspaceOnly`/大档四项——与 Config schema（index.js:48-68）对齐的契约；`modelTrio`(client.js:562-661) 复用「提供商/模型/思考程度」三行渲染，思考档位取自 `EFFORTS_PATH`(client.js:25)。
- `apiGet`/`apiPost`(client.js:393-408)：消费 `installWebServer`(index.js:2646) 注册的回环端点。
- `ReposTab`(client.js:992)：总览页轮询 `REPOS_PATH`(client.js:23)；排除/取消排除直接改 `excludePaths` 配置并调 control refresh（client.js:992-1010）。

### 数据结构（Struct/Model）字段

- **文章 frontmatter（文档契约结构）**：规定字段 `title`(字符串)、`type`(字符串，如 module/architecture/pattern/concept)、`source_files`(数组，POSIX 相对路径，含测试文件)、`tags`(数组)。正文固定六章节 `## Overview`/`## Key Components`/`## Architecture`/`## Data Flow`/`## Connections`/`## Known Issues`（articleFormatSection index.js:661-666）；行号引用一律以源码「行号| 」前缀为准（index.js:669）。
- **job 对象（持久化结构，submit 创建 index.js:2275-2294）**：`id`/`cwd`/`wikiPath`/`scope`/`language`/`kind`(full/stale)、`owner`(创建实例 id，孤儿接管依据 index.js:2049-2057)、`stage`(阶段机状态)、`auto`(自动调度标)、`sessionId`(发起会话，唤醒用 index.js:2127)、`plan`、`batchRef`、`tasks`(prompt 快照，宿主重启重跑唯一依据 index.js:1489-1500)、`articles`、`writtenCount`/`failedCount`、`usage`(index.js:2134)、`stageTimings`/`stageStartedAt`(index.js:2135-2136)、`notes`、`createdAt`/`updatedAt`(孤儿接管停更判断 index.js:2052)、`cancelRequested`(取消标记跨 tick 存活，touch 必标脏 index.js:2275-2277)；运行期追加 `pendingStage`/`pendingTasks`(排队预置 index.js:2164-2165)、`sessionTasks`(会话通道快照 index.js:1701)、`autoCommit`(0.10.9 index.js:2016)。`jobSummary`(index.js:1154-1188) 聚合输出 taskList/tps/usage/stageTimings 等。
- **autoCommit 结果对象（index.js:2941）**：`committed`(布尔)、`sha`(短哈希)、`message`(提交信息)、`noChanges`(无改动)、`reason`(拒绝原因)——面板与 `codewiki_progress` 直接显示（index.js:2940-2945、client.js:171-172 词典）。

## Architecture

```text
┌──────────────┐   ┌──────────────────────────┐   ┌───────────────────────┐
│ CodeWiki.md  │   │ index.js                 │   │ test-orchestration.mjs│
│ (入口公约:3) │   │ articleFormatSection:648 │   │ articleMd:29          │
└──────┬───────┘   └────────────┬─────────────┘   │ schema校验:1134-1172  │
       ▼                        ▼                 └───────────┬───────────┘
┌─────────────────┐   ┌──────────────────────────┐            │
│ ensureWikiEntry │   │ writeValidated:1362      │◄───────────┘
│ :211 (tickIndex │   │ fixAnchors:398           │
│ :2003 调用)     │   │ settleProofread:1406     │
└──────┬──────────┘   └────────────┬─────────────┘
       │                           ▼
       │           ┌───────────────────────────┐
       └──────────►│ autoCommitWiki:2904       │
                   │ wakeCompileSession:1202   │
                   │ (成功→不唤醒:1205)        │
                   └────────────┬──────────────┘
                                ▼
                   ┌───────────────────────────┐
                   │ client.js Panel:1137 / jobCard:1231 │
                   └───────────────────────────┘
```

## Data Flow

1. **契约定义**：`articleFormatSection`(index.js:648) 硬编码 frontmatter 键与章节顺序；CodeWiki.md（CodeWiki.md:3）声明入口公约；CHANGELOG.md 记录契约演进（0.10.9 条目 CHANGELOG.md:3-17）。
2. **入口校验与补全**：会话侧 `installUpdateReminder`(index.js:2989) 检查仓库根 `CodeWiki.md` 决定是否注入提醒（index.js:2989）；编译侧 `tickIndex` 调 `ensureWikiEntry`(index.js:2003) 对缺失入口生成模板（已有入口不覆盖 index.js:2989）。
3. **文章生成与落盘**：文章任务由 `prepareArticleTasks`(index.js:557) 装填——整任务装得下单请求上限就直出（index.js:557），prompt 超 110k 普通预算的任务标大档（`markBig` index.js:591），只有单文件连大档都装不下才转会话通道兜底（index.js:557、index.js:557）；`batchArticlePrompt`(index.js:517) 注入格式指令与「保留章节结构与 title/type/tags」的旧文条款（index.js:557）；`writeValidated`(index.js:1362) 落盘前强制 frontmatter 闸门并过 `fixAnchors`(index.js:1369)；stale 更新的 mission 同样写明保留结构（index.js:557）。
4. **契约回读**：stale 流程 `readSourceFiles`(index.js:980) 解析 frontmatter `source_files` 构建逐篇任务（index.js:980-995）；`localReview`(index.js:1856-1876) 核对 source_files 存在性（缺文件回退 writtenCount index.js:980）；批量校对 `settleProofread`(index.js:1406) 按标记拆回、校验后覆写。
5. **产物提交与唤醒**：`tickIndex` 调 `autoCommitWiki`(index.js:2014-2020) 自动提交产物，结果写 `job.autoCommit`；`wakeCompileSession`(index.js:1202) 在自动提交成功时不唤醒会话（index.js:1205），仅 failed/自动提交被拒时 steer 一次（source kind `plugin:codewiki` index.js:1990）；`commitHintText`(index.js:2947) 在系统提示 section 兜底一次性「产物待提交」提醒。
6. **测试验证与面板消费**：`articleMd`(test-orchestration.mjs:29) 仿造契约文章、全量编译断言落盘含校对回写（test-orchestration.mjs:29）、schema 校验块（test-orchestration.mjs:29-67）对输出做同构校验；client.js `CodewikiPanel`(client.js:1137) 轮询 `JOBS_PATH`(client.js:19) 展示进度，`jobCard`(client.js:1231) 渲染 autoCommit 结果。

## Connections

- [[index.js]]：宿主侧主逻辑，包含 `articleFormatSection`(index.js:648)、`writeValidated`(index.js:1362)、`parseSourceFiles`(index.js:966)、`autoCommitWiki`(index.js:2904) 等契约执行器与阶段机。
- [[client.js]]：浏览器侧 React 面板（`CodewikiPanel` client.js:1137），经回环端点消费契约产物并展示进度与自动提交结果。
- [[test-orchestration.mjs]]：契约验证侧，构造假文章 `articleMd`(test-orchestration.mjs:29) 并校验输出 schema（test-orchestration.mjs:29-67）。
- [[CodeWiki.md]]：入口公约声明源，自身即 wiki 入口契约实例（CodeWiki.md:3）。
- [[README.md]]：工具表（README.md:32-35）与设置项（`autoCommit` README.md:39、`batchProvider` README.md:29、大档模型 README.md:32、`sessionTier` README.md:32）承载契约文本侧。
- [[CHANGELOG.md]]：记录契约演进（0.10.7 删规划阶段 CHANGELOG.md:33-42、0.10.8 大档与批量校对 CHANGELOG.md:19-31、0.10.9 自动提交 CHANGELOG.md:3-17）。
- [[package.json]]：插件元数据（`version="0.10.9"` package.json:13，`engines.dsh` package.json:15，client 平台声明 package.json:13），界定当前契约实现版本。
- [[.tmp-test-orchestration.log]]：旧版本测试运行日志，仅作历史行为参考（见 Known Issues）。

## Known Issues

- **日志过期非显然点**：`.tmp-test-orchestration.log` 记录旧版行为——主模型规划块（.tmp-test-orchestration.log:120-184）、初始 stage=plan（.tmp-test-orchestration.log:188）、百炼凭证报错（.tmp-test-orchestration.log:563）与两处 `source 标记 plugin/codewiki` 失败（.tmp-test-orchestration.log:114、.tmp-test-orchestration.log:195，FAIL：2 项 .tmp-test-orchestration.log:573）——与现行 `test-orchestration.mjs`（无规划阶段 localPlan、宿主 llm 唯一通道、`plugin:codewiki` source kind、全绿）矛盾；该日志仅作历史行为参考，合成文档须以源码+CHANGELOG 现行语义为准。

- **锚点修正保守局限**：`fixAnchors`(index.js:398) 只对 frontmatter `source_files` 内文件引用生效（index.js:398-402），符号多处出现且无唯一声明形态、或点分符号歧义时不改（index.js:398-417），复合引用（反引号内含赋值等）提不出纯标识符也保守不动——部分锚点不会被规范化，须靠批量校对（`settleProofread` index.js:1406）与机械锚点测试兜底。

- **提醒缓存与测试绕过**：`commitHintText`(index.js:2947) 的 60s TTL 缓存以 cwd 为键（index.js:2947-2949），同仓库连续断言会吃到旧缓存——测试侧用全新 fixture 仓库绕开（test-orchestration.mjs:328-330、test-orchestration.mjs:339-340）；修改该函数或其断言时须注意缓存污染。

- **排除清单双重拒绝**：`excludedItem`(index.js:249) 大小写不敏感子树匹配，`submit`(index.js:2113-2116) 与 `generateToolDefinition` execute（index.js:2260-2261）双重检查且报错必带命中排除项原文（0.8.1 契约，test-orchestration.mjs:969-982 覆盖 compile 400/直调/子目录三处）。

- **会话通道依赖发起会话**：只有单文件连大档都装不下才转会话通道（`prepareArticleTasks` index.js:557；`bigProvider` 留空即关闭大档 index.js:561-568）；面板/自动调度提交的 job 无 `sessionId`，`dispatchSessionTasks`(index.js:1517-1523) 直接 fail 并明示「请从会话内重新提交编译」；超时默认 30 分钟（index.js:557）按失败处理、不降级（CodeWiki.md:72）。

- **插件不热加载**：改 index.js / client.js 后需重启 dsh 才生效（CodeWiki.md:58）；config 值本身热读——`liveConfig`(index.js:74-99) 每次 execute/tick 解包，全部设置 `.volatile()`（index.js:74-92）。