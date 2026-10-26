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

`documented-contract` 指 dsh-codewiki 插件（当前版本 0.12.1，package.json:3）中由文档显式规定、并被代码与测试共同遵守的结构化约定。核心包含五层契约：

(1) **入口契约**——仓库根 `CodeWiki.md` 是项目 wiki 入口（CodeWiki.md:3），`ensureWikiEntry`(index.js:220-253) 在编译收尾对缺失入口生成中/英模板，已有入口一律返回不覆盖（index.js:220）；系统提示维护提醒的门控只看仓库根有没有 `CodeWiki.md`（index.js:220），刻意不看 `.codewiki/` 目录。

(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`，index.js:766-771）开头并含固定六章节 `## Overview`…`## Known Issues`（index.js:766-771），模板由 `articleFormatSection`(index.js:766-795) 规定（条款取自上游 skills，index.js:766）；`writeValidated`(index.js:766-782) 是 keepInMemory 任务的 frontmatter 闸门（缺 frontmatter 记 invalid 不落盘，index.js:766-769），普通文章直写的 `applyTaskResult`(index.js:766-779) 同样先过 `fixAnchors`(index.js:766-849)——依据 frontmatter `source_files`（`parseSourceFiles` index.js:766-778）对照源码确定性校正行号锚点；行号引用以「行号| 」前缀为准（`numberLines` index.js:766-768，由 `collectSources` index.js:766 注入）。

(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（execute index.js:2451-2571 → `submit` index.js:2451-2526），阶段机为 queued→articles→crosscut→(compose)→review→index→commit（`STAGE_HANDLER` index.js:2451-2458），0.10.7 起无规划阶段（模块清单由 `localPlan` index.js:2451-2464 本地顶层目录分组，旧 plan 任务在 tick 内迁移，index.js:2451-2458）；0.10.11 起 `commit` 是独立阶段：`tickIndex` 在有产物且开关开时置 stage 提前返回（index.js:2451-2453），`tickCommit`(index.js:2451-2467) 执行 `autoCommitWiki`(index.js:2451-2533)——「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」，改动由 pathspec 限定在 `WIKI_PATHS`（`.codewiki`、`CodeWiki.md`，index.js:36、index.js:2451）；committed/no-changes/pending 三态由 `autoCommitState`(index.js:2451-2456) 唯一判定，`wakeCompileSession`(index.js:2451) 与 `commitHintText`(index.js:2451) 双通道共用同一结论。

(4) **模型通道契约（0.10.1）**——唯一通道是宿主 `llm.stream()`：`submit` 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失抛错并落 job `failed`（index.js:2451-2460）；`llmChat`(index.js:2451-2476) 不解析也不传递任何密钥。

(5) **工具输出 schema 契约**——四个工具的输出经宿主 JSON Schema 校验：可空字段一律 `oneOf` 形态（如 `codewiki_progress` 的 `progress`，index.js:2742），不提交路径不放 null 占位（`jobId`/`stage` 仅在提交/幂等/续查路径赋值，index.js:2543-2544），自动提交结果声明 `mode`/`branch`/`fallback`（index.js:2761-2763）。

测试侧以同构断言钉住契约：`articleMd`(test-orchestration.mjs:33-34) 合成契约文章，`autoCommitWiki` 安全边界块（test-orchestration.mjs:405-506）、`autoCommitState` 三态断言组（test-orchestration.mjs:508-518）、`wakeCompileSession` 唤醒语义块（test-orchestration.mjs:520-556）、端到端 commit 阶段断言（`stageTimings` 含 commit test-orchestration.mjs:632、`mode==='branch'` test-orchestration.mjs:33）、与宿主同构的 output schema 校验器（test-orchestration.mjs:33-67）与 worktree 闸门块（test-orchestration.mjs:33-69），让文档自身成为可机器消费的索引。

## Key Components

### index.js 契约执行侧符号

- `articleFormatSection`(index.js:766-795)：文章模板的唯一规定处。硬编码 frontmatter 四键（index.js:766-771）与六章节顺序（index.js:766-771）；条款含「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:766）、「source_files 必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:766）、「功能被禁用/注释时写明具体位置」（index.js:766）、Architecture 用 box-drawing 框图（index.js:766）、Connections 用 `[[backlinks]]`（index.js:766）、「写给对这个代码库零上下文的未来 agent」（index.js:766）。条款取自上游 skills/codewiki-session.md（index.js:766 注释）。
- `writeValidated`(index.js:1675-1691)：keepInMemory 任务（横切/校对/合成结果）的唯一落盘闸门。内容不以 `---` 开头 → 记 note「缺 frontmatter，不落盘（原文件保留）」返回 `invalid`（index.js:1675-1678）；写盘前过 `fixAnchors`（index.js:1675），修正与存疑分别记 note（index.js:1675-1676）。
- `applyTaskResult`(index.js:415-428)：普通文章任务直写出口。keepInMemory 只回内存不落盘（index.js:415）；直写路径先 `fixAnchors(content, task.cwd)` 再 `writeFileSync`（index.js:415-418），落盘失败记 note 返回 `error`（index.js:415-418）。
- `fixAnchors`(index.js:516-599)：落盘前把「file:NN(-MM)」锚点对照 source_files 源码机械校正。仅对 frontmatter `source_files` 内（或 basename 唯一匹配）的文件生效（index.js:516-520）；符号恰一处出现即修正，多处只认唯一行首声明形态 `function|class|const|let` 正则（index.js:516-518），点分符号歧义退试首段（index.js:516-517），仍歧义/找不到 → 不改并入 `unresolved`（index.js:516-519）；区间尾越界钳到文件尾（index.js:516-519）；混合行尾按整文主风格规范化（index.js:516）。
- `parseSourceFiles`(index.js:1084-1096)：解析 frontmatter `source_files`，支持 inline `[a,b]`（index.js:1084-1087）与 block `- a`（index.js:1084-1089）两式；`readSourceFiles`(index.js:1084-1092) 供 stale 逐篇任务取文件清单（index.js:1084）——frontmatter 因此既是文档也是机器可读输入。
- `numberLines`(index.js:505-507)：源码内联时每行加「N| 」grep 风格前缀，行号契约的数据基础（`collectSources` 内联点 index.js:505）。
- `ensureWikiEntry`(index.js:220-253)：入口文件兜底。已存在即返回 false 绝不覆盖（index.js:220）；缺失时按 `language` 写中文或英文模板（index.js:225-251）；由 `tickIndex` 在 `writtenCount>0` 时调用（index.js:220），失败只记 note（index.js:220-222）。
- `installUpdateReminder`(index.js:3493-3525)：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:3493），order = TOOL_REPORT+1（index.js:3493）；text 回调每次组装求值（index.js:3493-3499）——`updateReminder=false` 返回空串（index.js:3493）、仓库根缺 `CodeWiki.md` 返回空串（index.js:3493），门控通过后拼入 `commitHintText`（index.js:3493-3494）。存量会话经 `ctx.inject(['agents'])` 补装（index.js:3493-3499），服务缺失静默跳过。
- `reminderText`(index.js:3482-3491)：提醒正文。收尾必须调 `codewiki_generate`、禁止手改 `.codewiki/` 文章（index.js:3482）、调用即返回不等待不轮询（index.js:3482）、产物由插件自动提交（主题分支提交后合并回原分支，index.js:3482）、只有收到「产物待提交」提醒才需要代跑 git（index.js:3482）、收尾未调用视为任务未完成（index.js:3482）。
- `commitHintText`(index.js:3449-3480)：只在自动提交三态为 `pending` 时注入一次性「产物待提交」提醒（判定在 index.js:3449）；committed/no-changes 直接静默、不必再查 git（index.js:3449-3451 注释）；pending 时比较编译完成时间与 `.codewiki`+`CodeWiki.md` 最后一次 git 提交时间（index.js:3449-3454），文案带失败原因（index.js:3449-3451）与「不要为了本提醒中断当前任务、不要轮询」（index.js:3449）；60s TTL 缓存按 cwd 键（index.js:3449-3451）。
- `autoCommitWiki`(index.js:3365-3447)：产物自动提交边界。路径先按磁盘存在性过滤（index.js:3365）；前置检查逐条拒绝：非 git 仓库（index.js:3365）、无 HEAD（index.js:3365）、MERGE/REBASE/CHERRY_PICK 进行中（index.js:3365-3367）、未解决冲突（index.js:3365）、被 `.gitignore` 忽略（index.js:3365-3368）、无改动返回 `noChanges`（index.js:3365）、缺 `user.name`/`user.email`（index.js:3365-3367）；提交信息 `docs(wiki): …（任务 <jobId>，N 篇文章）`（index.js:3365-3366），`git add -- <paths>` pathspec 形式（index.js:3365）、`--no-verify` 不跑仓库钩子（index.js:3365），add/commit 失败把 stderr 摘录进 `reason`（index.js:3365、index.js:3365）。**分支合并式（0.10.11）**：detached HEAD（index.js:3365-3368）或建主题分支失败（index.js:3365-3368）→ 降级直接提交（`mode:'direct'` + `fallback`）；进入主题分支后任何失败先切回原分支（index.js:3365），绝不把用户留在插件建出的分支上；合并失败 → `merge --abort` 并保留主题分支（index.js:3365-3372），绝不强合；成功则 `branch -d` 只删已合并分支（index.js:3365）。返回 `{committed, sha?, message?, noChanges?, reason?, mode?, branch?, fallback?}`。
- `autoCommitState`(index.js:1485-1490，0.10.10 导出纯函数)：三态唯一判定——`committed=true` → `'committed'`（优先），`noChanges=true` → `'no-changes'`，其余（含旧 job 无该字段、job 为空）→ `'pending'`。**存在理由**：`wakeCompileSession` 与 `commitHintText` 是两条独立通道，各写一遍判断时「产物无改动」会被当成失败，两条通道各打扰会话一次（CHANGELOG.md:63）。
- `wakeCompileSession`(index.js:1492-1507)：编译终态 steer 唤醒。早退条件 `outcome !== 'failed' && autoCommitState(job) !== 'pending'`（index.js:1492）——已提交或无改动完全不打扰；无 sessionId / registry 无 get / `get` 抛错 / steer 抛错一律静默（index.js:1492-1495、index.js:1492）；steer 消息 `source: {kind:'plugin:codewiki'}`（index.js:1492，测试断言 test-orchestration.mjs:543）；failed 文案含失败原因（index.js:1492-1493），降级文案含「产物待提交」标题、任务 id、失败原因、`docs(wiki)` 指引与「不要为此中断或轮询」（index.js:1492）。
- 阶段机提交侧：`tickIndex`(index.js:2304-2334) 收尾 `cw index`+`meta update`（index.js:2304-2305）、`ensureWikiEntry`（index.js:2304）后，有产物且 `autoCommit` 开启 → `setStage(job,'commit')` 返回（index.js:2304-2306），否则直接 done（index.js:2304-2306）；`tickCommit`(index.js:2304-2320) 执行提交、结果写 `job.autoCommit`（index.js:2304-2305），三种 note 分支为成功/无改动/未执行（index.js:2304-2308），随后置 done 并触发 `onSettled` 唤醒（index.js:2304-2306）——终态最多晚一个 tick（默认 `TICK_MS` 10s，index.js:2304），换面板可见的「提交产物中」（client.js:117、client.js:276）。注册于 `STAGE_HANDLER`（index.js:2304-2311，commit 行 index.js:2304）。
- 提交结果三个消费面：`jobSummary` 透出 `autoCommit`（index.js:1428，注释说明面板与 progress 共用同一份，index.js:1428-1429）；`codewiki_progress` 输出 schema 声明 `committed/sha/message/reason/noChanges/mode/branch/fallback`（index.js:1428-1439），render 按三态各出一行（index.js:1428-1434）；面板任务卡三态显示、成功行追加主题分支名、失败原因放 title（client.js:1440-1447）。
- 模型通道契约：`submit` 三项硬校验（index.js:2451-2460），失败 `fail(job,…)` 后 flush 抛错（index.js:2451-2453）；`job.credentialSource` 恒为 `llm(<provider>/<model>)`（index.js:2451）。测试验证在 test-orchestration.mjs:172-177（报错指向设置项 + job `failed` 留痕）。
- `codewiki_update` 包装契约：`updateToolDefinition`(index.js:2758-2810) 固定 `scope:'auto'`（index.js:2758，调用方传 full 也被覆盖）、提交成功追加「本步收尾、继续下一项、不要等待/轮询」引导 note（index.js:2758）、错误消息 `codewiki_generate` 字样改写为 `codewiki_update`（index.js:2758）；断言在 test-orchestration.mjs:300-310。
- worktree 闸门（0.12.0）：`detectLinkedWorktree`(index.js:283-299) 只用 git 判据——`rev-parse --git-dir` 与 `--git-common-dir` resolve 后不同即 linked worktree（index.js:283-284），非 git 仓库放行（index.js:283）；三处拦截：`svc.submit` 公共汇合点（`auto` 时返回 `{skipped:'worktree'}` 不抛，index.js:283-288）、`codewiki_generate` 工具在跑 `cw status` 之前（非 auto 抛错、auto 返回 `state:'worktree'` 且 `wikiPath:''` 满足 schema，index.js:2520-2528）、`autoScan` 静默跳过（index.js:283）。测试块 test-orchestration.mjs:1367-1403。
- 会话记录契约（0.11.0 起）：`SESSIONS_DIR`(index.js:1147) 下每 job 一目录，`nnn.meta.json`+`nnn.full.json` 双文件（写入 `beginSessionRecord` index.js:1147-1189），`SESSION_TTL_MS` 保留 24h（index.js:1147），tick 每 10 分钟 `pruneSessionRecords`(index.js:1147-1167、调用点 index.js:1147-1150)；流式增量 3s 节流落盘（index.js:1147、index.js:1147-1151）。列表导出 `listSessionRecords`(index.js:1147-1156) / `listAllSessionRecords`(index.js:1147-1167，跨任务聚合按 `startedAt` 倒序、limit 兜底)。
- prompt 模板构造器（格式条款的载体）：`batchArticlePrompt`(index.js:635-662) 在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；其中引用的行号可能已过期，一律不得沿用」（index.js:635）并收尾拼 `articleFormatSection()`（index.js:635）；合成版 `batchArticleComposePrompt`(index.js:635-663) 同款条款（index.js:635、index.js:635）；横切 `batchArchitecturePrompt`(index.js:635-641)、`batchPatternsPrompt`(index.js:635-641)、`batchConceptPrompt`(index.js:635-641)；观察 `batchObservePrompt`(index.js:635-652)、`batchArticleObservePrompt`(index.js:635-651)；校对 `batchProofreadPrompt`(index.js:635-654) 与批量版 `batchProofreadBatchPrompt`(index.js:635-662)——0.10.8 批量校对输出契约是「@@@article: 名 /
