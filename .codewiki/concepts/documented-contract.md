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

`documented-contract` 指 dsh-codewiki 插件（当前版本 0.12.2，package.json:3）中由文档显式规定、并被代码与测试共同遵守的结构化约定。stale 逐篇更新的任务使命本身就是这条契约的自指样本：「以当前代码为准重写其内容，保留章节结构与 title/type/tags」（index.js:2740）。核心包含六层契约：

(1) **入口契约**——仓库根 `CodeWiki.md` 是项目 wiki 入口（CodeWiki.md:3），`ensureWikiEntry`（index.js:226-259）在编译收尾对缺失入口生成中/英模板，已有入口一律返回不覆盖（index.js:226）；系统提示维护提醒的门控只看仓库根有没有 `CodeWiki.md`（index.js:226，判定理由见 installUpdateReminder 注释 index.js:226-228），刻意不看 `.codewiki/` 目录。

(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`，index.js:803-808）开头并含固定六章节 `## Overview`…`## Known Issues`（index.js:798-803），模板唯一规定处是 `articleFormatSection`（index.js:798-827，条款取自上游 skills/codewiki-session.md，index.js:798）；`writeValidated`（index.js:1707-1723）是 keepInMemory 任务的 frontmatter 闸门（缺 frontmatter 记 invalid 不落盘，index.js:1708-1710），普通文章直写的 `applyTaskResult`（index.js:421-434）与它共用 `fixAnchors`（index.js:548-631）——依据 frontmatter `source_files`（`parseSourceFiles` index.js:1116-1128）对照源码确定性校正行号锚点；行号引用以「行号| 」前缀为准（`numberLines` index.js:537-539，由 `collectSources` 内联时注入，index.js:647）。

(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（execute index.js:2492-2625 → `submit` index.js:2492-2577），阶段机为 queued→articles→crosscut→(compose)→review→index→commit（`STAGE_HANDLER` index.js:2395-2402，头注释 index.js:1149-1151），0.10.7 起无规划阶段（模块清单由 `localPlan` index.js:832-845 本地顶层目录分组，旧 plan 任务在 tick 内迁移，index.js:2467-2475）；0.10.11 起 `commit` 是独立阶段：`tickIndex` 在有产物且开关开时置 stage 提前返回（index.js:2492-2494），`tickCommit`（index.js:2377-2393）执行 `autoCommitWiki`（index.js:3406-3488）——「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」，改动由 pathspec 限定在 `WIKI_PATHS`（`.codewiki`、`CodeWiki.md`，index.js:36）；committed/no-changes/pending 三态由 `autoCommitState`（index.js:1517-1522）唯一判定，`wakeCompileSession`（index.js:1524-1539）与 `commitHintText`（index.js:3490-3521）双通道共用同一结论。

(4) **模型通道契约（0.10.1）**——唯一通道是宿主 `llm.stream()`：`submit` 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失抛错并落 job `failed`（index.js:2492-2501）；`llmChat`（index.js:392-417）不解析也不传递任何密钥，0.11.1 起模型不支持所配思考档位时剥档重试一次（index.js:2492-2495）。

(5) **工具输出 schema 契约**——四个工具的输出经宿主 JSON Schema 校验：可空字段一律 `oneOf` 形态（如 `codewiki_progress` 的 `progress` index.js:2900、`autoCommit` index.js:2910-2924），不提交路径不放 null 占位（`jobId`/`stage` 仅在提交/幂等/续查路径赋值，index.js:2701-2702），降级返回（worktree/no-source）的 `wikiPath` 用空串满足 string 校验（index.js:2672、index.js:2685）。

(6) **编译对象闸门契约（0.12.0/0.12.1）**——linked worktree（`detectLinkedWorktree` index.js:289-305）与扫不出源码的空壳目录（`hasCompilableSources` index.js:332-346）统一判定为 `isDeadCompileTarget`（index.js:358-366）：submit/工具双闸（worktree index.js:2500-2505 / no-source index.js:2511-2515，检测函数见 index.js:289-305）、autoScan 静默跳过（index.js:289、index.js:3599）、面板任务列表与仓库总览过滤（index.js:3134、index.js:3181）、启动清理并反登记（index.js:289-304、`forgetRepo` index.js:1376-1385）。

测试侧以同构断言钉住契约：`articleMd`（test-orchestration.mjs:33-34）合成契约文章，`autoCommitWiki` 安全边界块（test-orchestration.mjs:405-506）、`autoCommitState` 三态断言组（test-orchestration.mjs:508-518）、`wakeCompileSession` 唤醒语义块（test-orchestration.mjs:520-556）、端到端 commit 阶段断言（`stageTimings` 含 commit test-orchestration.mjs:632、`mode==='branch'` test-orchestration.mjs:33）、与宿主同构的 output schema 校验器（test-orchestration.mjs:33-48）、worktree 闸门块（test-orchestration.mjs:33-69）与空壳目录块（test-orchestration.mjs:33-82），让文档自身成为可机器消费的索引。

## Key Components

### 入口与提醒契约

- `ensureWikiEntry`（index.js:226-259）：入口文件兜底。已存在即返回 false 绝不覆盖（index.js:226）；缺失时按 `language` 写中文或英文模板（index.js:231-256）；由 `tickIndex` 在 `writtenCount>0` 时调用（index.js:226-230），失败只记 note 不影响任务（index.js:226）。
- `installUpdateReminder`（index.js:3534-3566）：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:3534），order = TOOL_REPORT+1（index.js:3534）；text 回调每次组装求值（index.js:3534-3540）——`updateReminder=false` 返回空串（index.js:3534）、仓库根缺 `CodeWiki.md` 返回空串（index.js:3534），门控通过后拼入 `commitHintText`（index.js:3550-3551）。存量会话经 `ctx.inject(['agents'])` 补装（index.js:3558-3564），服务缺失静默跳过。
- `reminderText`（index.js:3523-3532）：提醒正文。收尾必须调 `codewiki_generate`、禁止手改 `.codewiki/` 文章（index.js:3526）、调用即返回不等待不轮询（index.js:3527）、产物由插件自动提交（主题分支提交后合并回原分支，index.js:3527）、只有收到「产物待提交」提醒才需要代跑 git（index.js:3523）、收尾未调用视为任务未完成（index.js:3530）。
- `commitHintText`（index.js:3490-3521）：只在自动提交三态为 `pending` 时注入一次性「产物待提交」提醒（判定 index.js:3501，与 `wakeCompileSession` 共用 `autoCommitState`）；committed/no-changes 直接静默、不必再查 git（index.js:3490 注释）；pending 时比较编译完成时间与 `.codewiki`+`CodeWiki.md` 最后一次 git 提交时间（index.js:3490-3493），文案带失败原因（index.js:3490-3491）与「不要为了本提醒中断当前任务、不要轮询」（index.js:3490）；60s TTL 缓存按 cwd 键（index.js:3490，缓存声明 index.js:3490）。
- 测试钉子：section 名与门控（test-orchestration.mjs:249-260，含「.codewiki 存在但根无 CodeWiki.md 不注入」守护收紧 test-orchestration.mjs:253-257）；`commitHintText` 全分支（test-orchestration.mjs:312-402：无提交史提醒 320、不中断不轮询 322、编译早于提交静默 342、编译晚于提交提醒 353、带失败原因 367、writtenCount=0 静默 374、committed/noChanges 静默 382/384、pending 提醒+原因 399）。

### 文章格式与落盘契约

- `articleFormatSection`（index.js:798-827）：文章模板的唯一规定处。硬编码 frontmatter 四键（index.js:798-803）与六章节顺序（index.js:798-803）；条款含「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:798）、「source_files 必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:798）、「功能被禁用/注释时写明具体位置」（index.js:798）、Architecture 用 box-drawing 框图（index.js:798）、Connections 用 `[[backlinks]]`（index.js:798）、「写给对这个代码库零上下文的未来 agent」（index.js:798）。
- prompt 构造器（格式条款的载体）：`batchArticlePrompt`（index.js:667-694）在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；其中引用的行号可能已过期，一律不得沿用」（index.js:667）并收尾拼 `articleFormatSection()`（index.js:691）；合成版 `batchArticleComposePrompt`（index.js:951-979）同款条款（index.js:667、index.js:976）；横切三件套 `batchArchitecturePrompt`/`batchPatternsPrompt`/`batchConceptPrompt`（index.js:884-906）；观察两件套 `batchObservePrompt`/`batchArticleObservePrompt`（index.js:910-947）；校对单篇版 `batchProofreadPrompt`（index.js:983-1002）与批量版 `batchProofreadBatchPrompt`（index.js:1006-1033）——0.10.8 批量校对输出契约是「一行 `@@@article: 名` / 修正后整文 / 一行 `
