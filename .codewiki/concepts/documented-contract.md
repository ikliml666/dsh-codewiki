---
title: documented-contract
type: concept
source_files:
  - index.js
  - test-orchestration.mjs
  - client.js
  - README.md
  - CodeWiki.md
  - CHANGELOG.md
  - package.json
tags: [文档契约, 跨模块, codewiki, frontmatter, 文章格式, 测试验证]
---

## Overview

`documented-contract` 指 dsh-codewiki 插件（版本 0.14.0，package.json:3）中由文档显式规定、并被代码与测试共同遵守的结构化约定。本篇本身就是这条契约的自指样本：「更新过期文章 ……：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（index.js:3888、index.js:1256，stale 任务的 `mission` 文案）——任务即「按 `articleFormatSection` 的硬格式把旧文重写一遍」。核心包含七层契约：

(1) **入口契约**——仓库根 `CodeWiki.md` 是项目 wiki 入口（本插件仓库自己的 `CodeWiki.md` 就是实例）。`ensureWikiEntry`（index.js:301-334）在编译收尾且 `writtenCount>0` 时对缺失入口生成中/英模板（`tickIndex` 函数 index.js:3346-3463，调用点 index.js:3446），已有入口一律不覆盖（index.js:304）；系统提示维护提醒的门控只看仓库根是否存在 `CodeWiki.md`（installUpdateReminder 回调 index.js:4798），刻意不看 `.codewiki/` 目录——空骨架目录会骗过目录存在性检查、提醒却指向读不到的入口（注释 index.js:4628-4630）。

(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`）开头并含固定六章节 `## Overview`…`## Known Issues`（index.js:1256-1285），模板唯一规定处是 `articleFormatSection`（index.js:679-708，条款取自上游 skills/codewiki-session.md，注释 index.js:1094）；行号引用以「行号| 」前缀为准（`numberLines` index.js:2522-2524，`collectSources` 内联时注入 index.js:553）；落盘闸门 `writeValidated`（index.js:856-873）对 keepInMemory 任务强制 frontmatter（缺则记 invalid 不落盘，index.js:1676-1680），普通文章直写 `applyTaskResult`（index.js:553-576）与它共用 `fixAnchors`（index.js:856-1073）——按 frontmatter `source_files`（`parseSourceFiles` index.js:1676-1688）对照源码确定性校正行号锚点。

(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（`generateToolDefinition.execute` index.js:3758-4036 → `submit` index.js:3579-3680，`void tick()` 推进一步后立即 resolve，index.js:3482）；阶段机为 queued→articles→crosscut→compose→review→index→commit（`STAGE_HANDLER` index.js:4695-4702）；0.10.7 起无独立规划阶段（queued 唤醒恒进 articles index.js:3346-3353，旧 plan 任务在 tick 内迁移 index.js:3465-3471）；0.10.11 起 `commit` 是独立阶段（`tickIndex` 满足 `writtenCount>0 && autoCommit` 则转 `commit` index.js:4655-4657，`tickCommit` index.js:55-70 执行 `autoCommitWiki` index.js:2271）——「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（index.js:2278-2305），改动由 pathspec 限定在 `WIKI_PATHS`（`.codewiki`、`CodeWiki.md`，index.js:4739；pathspec add index.js:4688）；committed/no-changes/pending 三态由 `autoCommitState`（index.js:2271-2276）唯一判定，`wakeCompileSession`（index.js:2278-2293）与 `commitHintText`（index.js:4739-4770）两条打扰通道共用同一结论。

(4) **模型通道契约（0.10.1）**——唯一通道是宿主 `llm.stream()`：`submit` 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失抛错并落 job `failed`（index.js:467-476）；`llmChat`（index.js:3579-3604）不解析也不传递任何密钥（注释 index.js:591-596）；模型不支持所配思考档位时剥档重试一次（index.js:105-109）；并发按任务上的 `bigTier` 标记分成默认档/大档两个独立池（`runRealtimeTasks` index.js:591-650，分池判定 index.js:596-601；`bigConcurrency` 配置 index.js:82、liveConfig 钳制 index.js:121-123）。

(5) **0.13.0 三层能力契约（吸收自 FSoft CodeWiki）**——`planMode=auto`（AST 符号提取 + LLM 语义聚类，失败自动降级目录分组：`semanticPlan` index.js:1322-1405、`buildPlan` index.js:2730-2753）、`agenticArticles`（模型自己 read_code/list_files/edit_article 增量写作：`startAgenticRun` index.js:2676-2726；失败过半退回单轮通道且只退一次：`shouldFallBackFromAgentic` index.js:1293-1298、`shouldFallBackHere` index.js:2585-2592、`job.agenticRetried` 标记 index.js:2964）、`symbolIncremental`（stale 先做符号级过滤 index.js:3862-3873，快照随产物写入 index.js:3420-3444）。三者默认全开（README.md:86 与 index.js:86-89），任一不可用都自动降级回旧行为、不让编译中断（client.js:79）。

(6) **工具面与 schema 契约**——工具输出经宿主 JSON Schema 校验：可空字段一律 `oneOf` 形态（`progress` index.js:4149、`autoCommit` index.js:4159-4173），不提交路径不放 null 占位（`jobId`/`stage` 仅在提交/幂等/续查路径赋值，index.js:3804）；单工具 schema 违规只丢该工具、不回滚全部注册（apply 内 try/catch index.js:2444-2453）；工具 description 本身是模型可见的合同文本（`codewiki_generate` index.js:3717-3723、`codewiki_update` index.js:4051-4054、`codewiki_progress` index.js:4122-4126），与 README 工具表（README.md:130-133）互为镜像；package.json 的 `exports`/`engines`/`dsh.client`（`exports` package.json:13-16、`engines` package.json:13-16、`dsh.client` package.json:20-27）则是宿主消费的装载契约。

(7) **编译对象闸门契约（1.2.0/1.2.1）**——linked worktree（`detectLinkedWorktree` index.js:364-380）与扫不出源码的空壳目录（`hasCompilableSources` index.js:407-421）统一判定为 `isDeadCompileTarget`（index.js:433-441）：submit 闸门（index.js:3579-3594，位于 `submit` index.js:2090-2191）与工具 execute 闸门（index.js:3767-3790）、autoScan 静默跳过（index.js:4845-4848）、面板任务列表过滤（index.js:4383）、仓库总览过滤（index.js:4430）、启动清理并反登记（index.js:2331-2346、`forgetRepo` index.js:2090-2099）。

测试侧以同构断言把契约钉成可执行形态：编排冒烟头注释（test-orchestration.mjs:27-31）列出覆盖面，逐条 `check` 输出 ✓/✗（test-orchestration.mjs:27-30）并以 PASS/FAIL 计数收尾（test-orchestration.mjs:27），运行留痕（最新一次 `node test-orchestration.mjs` 末行 `✓` 全绿，CHANGELOG.md:38 记录 `test-orchestration PASS`）——文档因此成为可机器验证的索引，而不只是散文。

## Key Components

### 入口与提醒契约

- `ensureWikiEntry`（index.js:301-334）：入口文件兜底。已存在即返回 false 绝不覆盖（index.js:3792）；缺失时按 `language` 写中文或英文模板（index.js:3346-3372），模板内含 wiki 目录绝对路径、索引/总览/模块/概念指引与「人工改写不覆盖」声明；由 `tickIndex` 在 `writtenCount>0` 时调用（index.js:3446），失败只记 note 不影响任务（index.js:3447-3449）。
- `installUpdateReminder`（index.js:4783）：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:4739-4740），order = TOOL_REPORT+1（index.js:4794）；text 回调每次组装求值（index.js:4795-4801）——`updateReminder=false` 返回空串（index.js:4796）、仓库根缺 `CodeWiki.md` 返回空串（index.js:4798），门控通过后拼入 `commitHintText`（index.js:4799-4800）；存量会话经 `ctx.inject(['agents'])` 补装（index.js:4808-4813），服务缺失静默跳过；新会话走 `agent/created`（index.js:4814）。门控「判定不看 .codewiki/ 目录」的依据注释在 index.js:4628-4630。
- `reminderText`（index.js:4772-4781）：提醒正文五条——收尾必须调 `codewiki_generate`、禁止手改 `.codewiki/` 文章（index.js:4775）、调用即返回不等待不轮询且产物由插件自动提交（index.js:4776）、wiki 路径在仓库根需绝对路径访问（index.js:4777）、只有收到「产物待提交」提醒才需要代跑 git（index.js:4778）、收尾未调用视为任务未完成（index.js:4779）。
- `commitHintText`（index.js:4739-4770）：只在自动提交三态为 `pending` 时注入一次性「产物待提交」提醒（判定 index.js:4750，与 `wakeCompileSession` 共用 `autoCommitState`）；committed/no-changes 直接静默、连 git 都不必查（index.js:2271-2273）；pending 时比较编译完成时间与 `.codewiki`+`CodeWiki.md` 最后一次 git 提交时间（index.js:2278-2283），文案带失败原因（index.js:4757-4764）并写明「不要为了本提醒中断当前任务、不要轮询」（index.js:4763）；60s TTL 缓存按 cwd 键（缓存声明 index.js:4637、命中判定 index.js:4740-4742）。
- 测试钉子：section 名与门控（test-orchestration.mjs:243-270，含「.codewiki 存在但根无 CodeWiki.md 不注入」的守护收紧 test-orchestration.mjs:259-264）；`commitHintText` 全分支（test-orchestration.mjs:293-410：无提交史提醒 test-orchestration.mjs:326-328、不同仓库为空 test-orchestration.mjs:337、编译早于提交静默 test-orchestration.mjs:349、编译晚于提交提醒 test-orchestration.mjs:360、带失败原因 test-orchestration.mjs:374-375、writtenCount=0 静默 test-orchestration.mjs:381、committed/noChanges 静默 test-orchestration.mjs:389-391、pending 提醒+原因 test-orchestration.mjs:406）。

### 文章格式与落盘契约

- `articleFormatSection`（index.js:1256-1285）：文章模板的唯一规定处。frontmatter 四键（index.js:1260-1267）与六章节顺序（index.js:1269-1274）硬编码；条款含「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:1277）、「source_files 必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:1278）、「功能被禁用/注释时写明具体位置」（index.js:1279）、Architecture 用 box-drawing 框图（index.js:1280）、Markdown 规范（index.js:1281）、Connections 用 `[[backlinks]]`（index.js:1282）、「写给零上下文的未来 agent」（index.js:1283）。
- 行号前缀：`numberLines`（index.js:679-681，设计注释 index.js:1094-1096——弱模型自己数行首尾常对、中段系统性错位）；`collectSources` 内联源码时逐行注入（index.js:1105）。
- 落盘闸门：`writeValidated`（index.js:2522-2539）缺 frontmatter 记 invalid 不落盘（index.js:856-860）、随后 `fixAnchors` 校正并记 notes（index.js:553-555）再写盘（index.js:2533）；`applyTaskResult`（index.js:553-576）对普通文章直写、keepInMemory 只回内存（index.js:554）由服务侧消费。
- `fixAnchors`（index.js:856-1073，语义注释 index.js:684-689）：锚点起点行应包含该行反引号内符号；不包含时在源文件全文找符号——恰好一处修正、多处取唯一声明形态、歧义/未找到不动并记 unresolved；全部修正只改行号数字。
- `parseSourceFiles`（index.js:1676-1688）：读 frontmatter 的 source_files（inline 数组与 block 列表两式）；stale 路径对无 source_files 的过期文章直接跳过并说明（index.js:3900-3903）——frontmatter 因此也是增量流程的机器可读契约。
- prompt 构造器（格式条款的载体）：`batchArticlePrompt`（index.js:1125-1152）在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；行号可能已过期一律不得沿用」（index.js:1256）并收尾拼 `articleFormatSection()`（index.js:1511）；合成版 `batchArticleComposePrompt`（index.js:1444-1472，同款条款 index.js:1452、格式段 index.js:1460）；横切三件套 `batchArchitecturePrompt`（index.js:1470-1476）/`batchPatternsPrompt`（index.js:1491-1497）/`batchConceptPrompt`（index.js:1543-1549）；观察两件套 `batchObservePrompt`（index.js:1566-1583）/`batchArticleObservePrompt`（index.js:1491-1507）；校对单篇版 `batchProofreadPrompt`（index.js:1543-1562）与批量版 `batchProofreadBatchPrompt`（index.js:1566-1593）——批量校对的输出合同是「每篇一行 `@@@article: 名` + 修正后整文 + `
