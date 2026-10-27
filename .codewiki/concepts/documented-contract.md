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
  - .tmp-test-orchestration.log
tags: [文档契约, 跨模块, codewiki, frontmatter, 文章格式, 测试验证]
---

## Overview

`documented-contract` 指 dsh-codewiki 插件（版本 0.13.4，package.json:3）中由文档显式规定、并被代码与测试共同遵守的结构化约定。stale 逐篇更新的任务使命本身就是这条契约的自指样本：「更新过期文章 ……：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（index.js:3107）——本篇正是该使命的产物。核心包含七层契约：

(1) **入口契约**——仓库根 `CodeWiki.md` 是项目 wiki 入口（公约自述 CodeWiki.md:3，本插件仓库自己的 CodeWiki.md 就是实例）。`ensureWikiEntry`（index.js:246-279）在编译收尾对缺失入口生成中/英模板，已有入口一律不覆盖（index.js:246）；系统提示维护提醒的门控只看仓库根是否存在 `CodeWiki.md`（index.js:246），刻意不看 `.codewiki/` 目录——空骨架目录会骗过目录存在性检查、提醒却指向读不到的入口（依据注释 index.js:246-248）。

(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`，模板 index.js:818-825）开头并含固定六章节 `## Overview`…`## Known Issues`（index.js:818-823），模板唯一规定处是 `articleFormatSection`（index.js:818-847，条款取自上游 skills/codewiki-session.md，index.js:818）；行号引用以「行号| 」前缀为准（`numberLines` index.js:557-559，`collectSources` 内联时注入 index.js:667）；落盘闸门 `writeValidated`（index.js:1870-1886）对 keepInMemory 任务强制 frontmatter（缺则记 invalid 不落盘，index.js:1871-1873），普通文章直写 `applyTaskResult`（index.js:441-454）与它共用 `fixAnchors`（index.js:568-651）——按 frontmatter `source_files`（`parseSourceFiles` index.js:1238-1250）对照源码确定性校正行号锚点。

(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（execute index.js:2859-3026 → `submit` index.js:2859-2944，返回前立即推进一步 index.js:2859）；阶段机为 queued→articles→crosscut→(compose)→review→index→commit（`STAGE_HANDLER` index.js:2762-2769）；0.10.7 起无独立规划阶段（queued 唤醒恒进 articles index.js:2859-2866，旧 plan 任务在 tick 内迁移 index.js:2859-2866）；0.10.11 起 `commit` 是独立阶段（`tickIndex` 提前返回 index.js:2859-2861，`tickCommit` index.js:2744-2760 执行 `autoCommitWiki` index.js:3807-3889）——「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（index.js:2859-2893），改动由 pathspec 限定在 `WIKI_PATHS`（`.codewiki`、`CodeWiki.md`，index.js:45）；committed/no-changes/pending 三态由 `autoCommitState`（index.js:1671-1676）唯一判定，`wakeCompileSession`（index.js:1678-1693）与 `commitHintText`（index.js:3891-3922）两条打扰通道共用同一结论。

(4) **模型通道契约（0.10.1）**——唯一通道是宿主 `llm.stream()`：`submit` 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失抛错并落 job `failed`（index.js:2859-2868）；`llmChat`（index.js:412-437）不解析也不传递任何密钥（注释 index.js:2859-2861）；模型不支持所配思考档位时剥档重试一次（index.js:2859-2863）；并发按任务上的 `bigTier` 标记分成默认档/大档两个独立池（`runRealtimeTasks` index.js:469-528，分池判定 index.js:471-479；`bigConcurrency` 配置 index.js:72、liveConfig 钳制 index.js:111-113）。

(5) **0.13.0 三层能力契约（吸收自 FSoft CodeWiki）**——`planMode=auto`（AST 符号提取 + LLM 语义聚类，失败自动降级目录分组：`semanticPlan` index.js:884-967、`buildPlan` index.js:2074-2097）、`agenticArticles`（模型自己 read_code/list_files/edit_article 增量写作：`startAgenticRun` index.js:2023-2070；失败过半退回单轮通道且只退一次：`shouldFallBackFromAgentic` index.js:855-860、`shouldFallBackHere` index.js:1932-1939、`job.agenticRetried` 标记 index.js:2308）、`symbolIncremental`（stale 先做符号级过滤 index.js:884-904，快照随产物写入 index.js:2702-2723）。三者默认全开（README.md:37），任一不可用都自动降级回旧行为、不让编译中断（client.js:91）。

(6) **工具面与 schema 契约**——工具输出经宿主 JSON Schema 校验：可空字段一律 `oneOf` 形态（`progress` index.js:3301、`autoCommit` index.js:3311-3325），不提交路径不放 null 占位（`jobId`/`stage` 仅在提交/幂等/续查路径赋值，index.js:3068），降级返回的 `wikiPath` 用空串满足 string 校验（index.js:3039、index.js:3052）；单工具 schema 违规只丢该工具、不回滚全部注册（index.js:4017-4028）；工具 description 本身是模型可见的合同文本（`cw` index.js:3067-3071、`codewiki_generate` index.js:3067-3073、`codewiki_update` index.js:3067-3070、`codewiki_progress` index.js:3067-3071），与 README 工具表（README.md:14-20）互为镜像；package.json 的 `exports`/`engines`/`dsh.client`（`exports` package.json:8-11、`engines.dsh` package.json:13-16、`dsh.client` package.json:20-27）则是宿主消费的装载契约。

(7) **编译对象闸门契约（0.12.0/0.12.1）**——linked worktree（`detectLinkedWorktree` index.js:309-325）与扫不出源码的空壳目录（`hasCompilableSources` index.js:352-366）统一判定为 `isDeadCompileTarget`（index.js:378-386）：submit 闸门（index.js:2867-2872）与工具 execute 闸门（index.js:3033-3041）、autoScan 静默跳过（index.js:309-312）、面板任务列表过滤（index.js:3535）、仓库总览过滤（index.js:3582）、启动清理并反登记（index.js:309-324、`forgetRepo` index.js:1508-1517）。

测试侧以同构断言把契约钉成可执行形态：编排冒烟头注释（test-orchestration.mjs:27-32）列出覆盖面，逐条 `check` 输出 ✓/✗（test-orchestration.mjs:27-30）并以 PASS/FAIL 计数收尾（test-orchestration.mjs:27-28），运行留痕即 .tmp-test-orchestration.log 的形态（历史运行收尾 FAIL：2 项未通过，.tmp-test-orchestration.log:573）——文档因此成为可机器验证的索引，而不只是散文。

## Key Components

### 入口与提醒契约

- `ensureWikiEntry`（index.js:246-279）：入口文件兜底。已存在即返回 false 绝不覆盖（index.js:246）；缺失时按 `language` 写中文或英文模板（index.js:251-263 / index.js:246-259），模板内含 wiki 目录绝对路径、索引/总览/模块/概念指引与「人工改写不覆盖」声明；由 `tickIndex` 在 `writtenCount>0` 时调用（index.js:246-250），失败只记 note 不影响任务（不变量缺口说明 index.js:246-248）。
- `installUpdateReminder`（index.js:3935-3967）：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:3935），order = TOOL_REPORT+1（index.js:3935）；text 回调每次组装求值（index.js:3935-3941）——`updateReminder=false` 返回空串（index.js:3935）、仓库根缺 `CodeWiki.md` 返回空串（index.js:3935），门控通过后拼入 `commitHintText`（index.js:3951-3952）；存量会话经 `ctx.inject(['agents'])` 补装（index.js:3959-3965），服务缺失静默跳过；新会话走 `agent/created`（index.js:3935）。门控「判定不看 .codewiki/ 目录」的依据注释在 index.js:3935-3937。
- `reminderText`（index.js:3924-3933）：提醒正文五条——收尾必须调 `codewiki_generate`、禁止手改 `.codewiki/` 文章（index.js:3927）、调用即返回不等待不轮询且产物由插件自动提交（index.js:3928）、wiki 路径在仓库根需绝对路径访问（index.js:3924）、只有收到「产物待提交」提醒才需要代跑 git（index.js:3924）、收尾未调用视为任务未完成（index.js:3931）。
- `commitHintText`（index.js:3891-3922）：只在自动提交三态为 `pending` 时注入一次性「产物待提交」提醒（判定 index.js:3902，与 `wakeCompileSession` 共用 `autoCommitState`）；committed/no-changes 直接静默、连 git 都不必查（index.js:3891-3892）；pending 时比较编译完成时间与 `.codewiki`+`CodeWiki.md` 最后一次 git 提交时间（index.js:3891-3896），文案带失败原因（index.js:3891-3898）并写明「不要为了本提醒中断当前任务、不要轮询」（index.js:3891）；60s TTL 缓存按 cwd 键（缓存声明 index.js:3891，命中判定 index.js:3891）。
- 测试钉子：section 名与门控（test-orchestration.mjs:255-267，含「.codewiki 存在但根无 CodeWiki.md 不注入」的守护收紧 test-orchestration.mjs:260-265）；`commitHintText` 全分支（test-orchestration.mjs:319-409：无提交史提醒 test-orchestration.mjs:327-330、不同仓库为空 test-orchestration.mjs:337-338、编译早于提交静默 test-orchestration.mjs:348-349、编译晚于提交提醒 test-orchestration.mjs:359-360、带失败原因 test-orchestration.mjs:370-374、writtenCount=0 静默 test-orchestration.mjs:380-381、committed/noChanges 静默 test-orchestration.mjs:388-391、pending 提醒+原因 test-orchestration.mjs:402-406）。

### 文章格式与落盘契约

- `articleFormatSection`（index.js:818-847）：文章模板的唯一规定处。frontmatter 四键（index.js:818-824）与六章节顺序（index.js:818-823）硬编码；条款含「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:818）、「source_files 必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:818）、「功能被禁用/注释时写明具体位置」（index.js:818）、Architecture 用 box-drawing 框图（index.js:818）、Markdown 规范（index.js:818）、Connections 用 `[[backlinks]]`（index.js:818）、「写给零上下文的未来 agent」（index.js:818）。
- 行号前缀：`numberLines`（index.js:557-559，设计注释 index.js:557-559——弱模型自己数行首尾常对、中段系统性错位）；`collectSources` 内联源码时逐行注入（index.js:667）。
- 落盘闸门：`writeValidated`（index.js:1870-1886）缺 frontmatter 不落盘（index.js:1870-1872）、随后 `fixAnchors` 校正并记 notes（index.js:1877-1879）再写盘（index.js:1870）；`applyTaskResult`（index.js:441-454）对普通文章直写、keepInMemory 只回内存（index.js:441-442）由服务侧消费。
- `fixAnchors`（index.js:568-651，语义注释 index.js:568-574）：锚点起点行应包含该行反引号内符号；不包含时在源文件全文找符号——恰好一处修正、多处取唯一声明形态、歧义/未找到不动并记 unresolved；全部修正只改行号数字。
- `parseSourceFiles`（index.js:1238-1250）：读 frontmatter 的 source_files（inline 数组与 block 列表两式）；stale 路径对无 source_files 的过期文章直接跳过并说明（index.js:1238-1240）——frontmatter 因此也是增量流程的机器可读契约。
- prompt 构造器（格式条款的载体）：`batchArticlePrompt`（index.js:687-714）在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；行号可能已过期一律不得沿用」（index.js:687）并收尾拼 `articleFormatSection()`（index.js:711）；合成版 `batchArticleComposePrompt`（index.js:1073-1101，同款条款 index.js:687、格式段 index.js:1098）；横切三件套 `batchArchitecturePrompt`（index.js:1006-1012）/`batchPatternsPrompt`（index.js:1014-1020）/`batchConceptPrompt`（index.js:1022-1028）；观察两件套 `batchObservePrompt`（index.js:1032-1049）/`batchArticleObservePrompt`（index.js:1053-1069）；校对单篇版 `batchProofreadPrompt`（index.js:1105-1124）与批量版 `batchProofreadBatchPrompt`（index.js:1128-1155）——批量校对的输出合同是「每篇一行 `@@@article: 名` + 修正后整文 + `
