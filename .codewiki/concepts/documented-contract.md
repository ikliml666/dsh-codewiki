---
title: documented-contract
type: concept
source_files:
  - index.js
  - test-orchestration.mjs
  - client.js
  - README.md
  - CodeWiki.md
  - package.json
tags: [文档契约, 跨模块, codewiki, frontmatter, 文章格式, 测试验证]
---

## Overview

`documented-contract` 指 dsh-codewiki 插件（版本 0.13.4，package.json:3）中由文档显式规定、并被代码与测试共同遵守的结构化约定。本篇本身就是这条契约的自指样本：「更新过期文章 ……：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（index.js:766，stale 任务的 `mission` 文案）——任务即「按 `articleFormatSection` 的硬格式把旧文重写一遍」。核心包含七层契约：

(1) **入口契约**——仓库根 `CodeWiki.md` 是项目 wiki 入口（本插件仓库自己的 `CodeWiki.md` 就是实例）。`ensureWikiEntry`（index.js:286-319）在编译收尾且 `writtenCount>0` 时对缺失入口生成中/英模板（index.js:2774-2815 的 `tickIndex` 调用点），已有入口一律不覆盖（index.js:2774）；系统提示维护提醒的门控只看仓库根是否存在 `CodeWiki.md`（installUpdateReminder 回调 index.js:2774），刻意不看 `.codewiki/` 目录——空骨架目录会骗过目录存在性检查、提醒却指向读不到的入口（注释 index.js:2774-2777）。

(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`，模板 articleFormatSection index.js:907-936）开头并含固定六章节 `## Overview`…`## Known Issues`（index.js:897-904），模板唯一规定处是 `articleFormatSection`（index.js:897-926，条款取自上游 skills/codewiki-session.md，index.js:597）；行号引用以「行号| 」前缀为准（`numberLines` index.js:735-737，`collectSources` 内联时注入 index.js:1949）；落盘闸门 `writeValidated`（index.js:1949-1965）对 keepInMemory 任务强制 frontmatter（缺则记 invalid 不落盘，index.js:481-483），普通文章直写 `applyTaskResult`（index.js:608-621）与它共用 `fixAnchors`（index.js:608-730）——按 frontmatter `source_files`（`parseSourceFiles` index.js:1317-1329）对照源码确定性校正行号锚点。

(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（generateToolDefinition.execute index.js:2958-3125，`submit` index.js:2958-3043 在 void tick() 推进一步后立即 resolve，index.js:2958）；阶段机为 queued→articles→crosscut→compose→review→index→commit（`STAGE_HANDLER` index.js:2861-2868）；0.10.7 起无独立规划阶段（queued 唤醒恒进 articles index.js:3946-3956，旧 plan 任务在 tick 内迁移 index.js:3946-3953）；0.10.11 起 `commit` 是独立阶段（`tickIndex` 满足 `writtenCount>0 && autoCommit` 则转 `commit` index.js:2843-2846，`tickCommit` index.js:3906-3922 执行 `autoCommitWiki` index.js:3906-3988）——「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（index.js:45-72），改动由 pathspec 限定在 `WIKI_PATHS`（`.codewiki`、`CodeWiki.md`，index.js:1750）；committed/no-changes/pending 三态由 `autoCommitState`（index.js:1757-1762）唯一判定，`wakeCompileSession`（index.js:3990-4005）与 `commitHintText`（index.js:3990-4021）两条打扰通道共用同一结论。

(4) **模型通道契约（0.10.1）**——唯一通道是宿主 `llm.stream()`：`submit` 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失抛错并落 job `failed`（index.js:452-461）；`llmChat`（index.js:452-477）不解析也不传递任何密钥（注释 index.js:452-457）；模型不支持所配思考档位时剥档重试一次（index.js:810-814）；并发按任务上的 `bigTier` 标记分成默认档/大档两个独立池（`runRealtimeTasks` index.js:509-568，分池判定 index.js:95-98；`bigConcurrency` 配置 index.js:95、liveConfig 钳制 index.js:95-97）。

(5) **0.13.0 三层能力契约（吸收自 FSoft CodeWiki）**——`planMode=auto`（AST 符号提取 + LLM 语义聚类，失败自动降级目录分组：`semanticPlan` index.js:2161-2244、`buildPlan` index.js:77-100）、`agenticArticles`（模型自己 read_code/list_files/edit_article 增量写作：`startAgenticRun` index.js:934-981；失败过半退回单轮通道且只退一次：`shouldFallBackFromAgentic` index.js:2019-2024、`shouldFallBackHere` index.js:933-940、`job.agenticRetried` 标记 index.js:79）、`symbolIncremental`（stale 先做符号级过滤 index.js:79-99，快照随产物写入 index.js:79-100）。三者默认全开（README.md:37 与 index.js:79-82），任一不可用都自动降级回旧行为、不让编译中断（client.js:79）。

(6) **工具面与 schema 契约**——工具输出经宿主 JSON Schema 校验：可空字段一律 `oneOf` 形态（`progress` 输出 `progress` index.js:3367、autoCommit 输出 `autoCommit` index.js:3410-3424），不提交路径不放 null 占位（`jobId`/`stage` 仅在提交/幂等/续查路径赋值，index.js:7）；单工具 schema 违规只丢该工具、不回滚全部注册（apply 内 try/catch index.js:4-20）；工具 description 本身是模型可见的合同文本（`codewiki_generate` index.js:3292-3301、`codewiki_update` index.js:7-13、`codewiki_progress` index.js:7-14），与 README 工具表（README.md:14-20）互为镜像；package.json 的 `exports`/`engines`/`dsh.client`（`exports` package.json:8-11、`engines.dsh` package.json:13-16、`dsh.client` package.json:20-27）则是宿主消费的装载契约。

(7) **编译对象闸门契约（1.2.0/1.2.1）**——linked worktree（`detectLinkedWorktree` index.js:392-408）与扫不出源码的空壳目录（`hasCompilableSources` index.js:349-363）统一判定为 `isDeadCompileTarget`（index.js:349-357）：submit 闸门（index.js:349-364）与工具 execute 闸门（index.js:349-370）、autoScan 静默跳过（index.js:1587-1590）、面板任务列表过滤（index.js:1587）、仓库总览过滤（index.js:1587）、启动清理并反登记（index.js:1587-1602、`forgetRepo` index.js:1587-1596）。

测试侧以同构断言把契约钉成可执行形态：编排冒烟头注释（test-orchestration.mjs:27-31）列出覆盖面，逐条 `check` 输出 ✓/✗（test-orchestration.mjs:27-30）并以 PASS/FAIL 计数收尾（test-orchestration.mjs:27），运行留痕（最新一次 `node test-orchestration.mjs` 末行 `✓` 全绿，CHANGELOG.md:38 记录 `test-orchestration PASS`）——文档因此成为可机器验证的索引，而不只是散文。

## Key Components

### 入口与提醒契约

- `ensureWikiEntry`（index.js:286-319）：入口文件兜底。已存在即返回 false 绝不覆盖（index.js:3155）；缺失时按 `language` 写中文或英文模板（index.js:3155-3181），模板内含 wiki 目录绝对路径、索引/总览/模块/概念指引与「人工改写不覆盖」声明；由 `tickIndex` 在 `writtenCount>0` 时调用（index.js:2774、index.js:2774-2778），失败只记 note 不影响任务（index.js:2774-2776）。
- `installUpdateReminder`（index.js:4034）：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:4034），order = TOOL_REPORT+1（index.js:3990）；text 回调每次组装求值（index.js:3990-3996）——`updateReminder=false` 返回空串（index.js:3990）、仓库根缺 `CodeWiki.md` 返回空串（index.js:3990），门控通过后拼入 `commitHintText`（index.js:1734-1735）；存量会话经 `ctx.inject(['agents'])` 补装（index.js:1734-1740），服务缺失静默跳过；新会话走 `agent/created`（index.js:1734）。门控「判定不看 .codewiki/ 目录」的依据注释在 index.js:1734-1737。
- `reminderText`（index.js:4023-4032）：提醒正文五条——收尾必须调 `codewiki_generate`、禁止手改 `.codewiki/` 文章（index.js:4）、调用即返回不等待不轮询且产物由插件自动提交（index.js:4）、wiki 路径在仓库根需绝对路径访问（index.js:4）、只有收到「产物待提交」提醒才需要代跑 git（index.js:4）、收尾未调用视为任务未完成（index.js:4）。
- `commitHintText`（index.js:4001-4032）：只在自动提交三态为 `pending` 时注入一次性「产物待提交」提醒（判定 index.js:1757，与 `wakeCompileSession` 共用 `autoCommitState`）；committed/no-changes 直接静默、连 git 都不必查（index.js:1750-1751）；pending 时比较编译完成时间与 `.codewiki`+`CodeWiki.md` 最后一次 git 提交时间（index.js:1750-1755），文案带失败原因（index.js:1750-1757）并写明「不要为了本提醒中断当前任务、不要轮询」（index.js:1750）；60s TTL 缓存按 cwd 键（缓存声明 index.js:1750、命中判定 index.js:1750）。
- 测试钉子：section 名与门控（test-orchestration.mjs:243-270，含「.codewiki 存在但根无 CodeWiki.md 不注入」的守护收紧 test-orchestration.mjs:259-264）；`commitHintText` 全分支（test-orchestration.mjs:293-410：无提交史提醒 test-orchestration.mjs:326-328、不同仓库为空 test-orchestration.mjs:337、编译早于提交静默 test-orchestration.mjs:349、编译晚于提交提醒 test-orchestration.mjs:360、带失败原因 test-orchestration.mjs:374-375、writtenCount=0 静默 test-orchestration.mjs:381、committed/noChanges 静默 test-orchestration.mjs:389-391、pending 提醒+原因 test-orchestration.mjs:406）。

### 文章格式与落盘契约

- `articleFormatSection`（index.js:897-926）：文章模板的唯一规定处。frontmatter 四键（index.js:897-903）与六章节顺序（index.js:897-903）硬编码；条款含「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:897）、「source_files 必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:897）、「功能被禁用/注释时写明具体位置」（index.js:897）、Architecture 用 box-drawing 框图（index.js:897）、Markdown 规范（index.js:897）、Connections 用 `[[backlinks]]`（index.js:897）、「写给零上下文的未来 agent」（index.js:897）。
- 行号前缀：`numberLines`（index.js:597-600，设计注释 index.js:735-737——弱模型自己数行首尾常对、中段系统性错位）；`collectSources` 内联源码时逐行注入（index.js:735）。
- 落盘闸门：`writeValidated`（index.js:1949-1965）缺 frontmatter 记 invalid 不落盘（index.js:608-627）、随后 `fixAnchors` 校正并记 notes（index.js:481-483）再写盘（index.js:481）；`applyTaskResult`（index.js:481-494）对普通文章直写、keepInMemory 只回内存（index.js:481）由服务侧消费。
- `fixAnchors`（index.js:608-728，语义注释 index.js:608-614）：锚点起点行应包含该行反引号内符号；不包含时在源文件全文找符号——恰好一处修正、多处取唯一声明形态、歧义/未找到不动并记 unresolved；全部修正只改行号数字。
- `parseSourceFiles`（index.js:1317-1329）：读 frontmatter 的 source_files（inline 数组与 block 列表两式）；stale 路径对无 source_files 的过期文章直接跳过并说明（index.js:1317-1319）——frontmatter 因此也是增量流程的机器可读契约。
- prompt 构造器（格式条款的载体）：`batchArticlePrompt`（index.js:766-793）在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；行号可能已过期一律不得沿用」（index.js:897）并收尾拼 `articleFormatSection()`（index.js:1152）；合成版 `batchArticleComposePrompt`（index.js:1152-1180，同款条款 index.js:1085、格式段 index.js:1085）；横切三件套 `batchArchitecturePrompt`（index.js:1093-1099）/`batchPatternsPrompt`（index.js:1101-1107）/`batchConceptPrompt`（index.js:1111-1117）；观察两件套 `batchObservePrompt`（index.js:1132-1149）/`batchArticleObservePrompt`（index.js:1184-1200）；校对单篇版 `batchProofreadPrompt`（index.js:1207-1226）与批量版 `batchProofreadBatchPrompt`（index.js:1207-1234）——批量校对的输出合同是「每篇一行 `@@@article: 名` + 修正后整文 + `@@@end`」（index.js:2030-2031），由 `settleProofread`（index.js:1949-1973）按标记拆回逐篇、`writeValidated` 校验后才覆写。

### 提交制与产物契约

- `generateToolDefinition`（index.js:3077-3289）：纯提交制工具。execute（index.js:3077-3244）先判态（cw status，index.js:3077-3082）、幂等查活跃任务（index.js:3077-3086）、按 scope 修正（stale 无 wiki 升 full，index.js:2958-2963）、clean 短路返回（index.js:2958-2961）、stale 逐篇预构建任务并提交（index.js:2958-3020）、全量走 `submit`（index.js:2958-2965）。全程零 LLM 调用，提交即 resolve（index.js:2958-2959）。
- `submit`（index.js:2985-3070）：占位先行 `submitting`（index.js:1904-1923），随后唯一模型通道校验（index.js:73-82），再按 `serialProjects`/`parallelLimit` 决定进 `articles`（立即）或 `queued` 排队（index.js:3638-3652），最后 `void tick()` 推进一步并立即返回 `{ job, existed }`（index.js:3638-3639）。
- `STAGE_HANDLER`（index.js:2861-2868）：阶段机映射 `articles→tickArticles` / `crosscut→tickCrosscut` / `compose→tickCompose` / `review→tickReview` / `index→tickIndex` / `commit→tickCommit`。0.10.7 删 plan 阶段，queued 唤醒恒进 `articles`（index.js:2862-2872），旧 `stage:'plan'` 任务在 tick 内迁到 articles（index.js:2862-2869）。
- `tickIndex`（index.js:2774-2829）：有 `writtenCount>0` 时跑 `cw index` + `cw meta update`（index.js:286-288）、写符号快照（index.js:286-307）、`ensureWikiEntry`（index.js:81-97）；之后若 `autoCommit` 开启且有文章则转 `commit`（index.js:2035-2038），否则直接 `done`（index.js:2035-2037）。
- `tickCommit` + `autoCommitWiki`（index.js:3906-3922 与 index.js:3906-3988）：编译终态的自动提交。0.10.11 起分支合并式——主题分支 `codewiki/wiki-<jobId>` 提交（index.js:3906-3917）→ 合并回原分支（index.js:3906-3914）→ 删主题分支（index.js:3906-3907）；detached HEAD/建分支失败降级直提交（index.js:3906-3913）；安全边界逐条校验（非 git、无 HEAD、merge 中、未解决冲突、被 ignore、缺 user.name/email、add/commit 失败一律拒绝并降级为提醒，index.js:3906-3937）。
- `autoCommitState`（index.js:1752-1757）：三态唯一判定（`committed`/`no-changes`/否则 `pending`），`wakeCompileSession`（index.js:3990-4005）与 `commitHintText`（index.js:3990-4021）共用，避免同一次「无改动」被两条通道各打扰一次。
- 测试钉子：提交制/阶段机（test-orchestration.mjs:1-5 头注释覆盖面）；`codewiki_update` 固定 scope=auto 透传、提交后追加「继续下一项」note、错误前缀改写（test-orchestration.mjs:292-317）；`autoCommitWiki` 安全边界：正常分支合并式提交只含两个目标路径、合并后删主题分支、提交信息带 docs(wiki) 前缀与任务 id（test-orchestration.mjs:412-430 起）。

### 模型通道契约

- `llmChat`（index.js:452-477）：唯一模型通道，调用宿主 `llm.stream({ provider, model, reasoningEffort, messages, temperature:0, signal })`（index.js:454-461）；不支持所配思考档位时剥档重试一次（index.js:454-458）；失败统一抛错（index.js:454-456）。
- `runRealtimeTasks`（index.js:810-869）：唯一执行器（后台并发池）。按 `bigTier` 标记分两个独立池——默认档 `normalTasks` 与大档 `bigTasks`（index.js:3026-3031），各自 `limit` 限流、同时推进（index.js:3026-3035）；单任务 `provider/model/reasoningEffort` 优先用任务装填值（index.js:3026-3032）。
- `liveConfig`（index.js:99-141）：设置热读取与钳制——`batchProvider`/`batchModel` 缺省回退默认值（index.js:71-76）、`maxConcurrency` 钳到 1–8（index.js:95-97）、`bigConcurrency` 为 0/未填跟随默认档（index.js:95-97）。
- `Config`（index.js:60-86）：schemastery 配置声明，全部 `.volatile()`（execute/tick 时热读）；关键键 `batchProvider`(index.js:63)、`batchModel`(index.js:66)、`bigProvider`/`bigModel`/`bigTokenBudget`(index.js:70-73)、`sessionTier`(index.js:71)、`maxConcurrency`/`bigConcurrency`(index.js:76-77)、`planMode`/`agenticArticles`/`agenticMaxSteps`/`symbolIncremental`(index.js:81-84)、`autoCommit`(index.js:81)。
- `listModelCatalog`（index.js:3554-3575）/ `resolveModelEfforts`（index.js:3517-3539）：设置页级联下拉的数据源，取自宿主 `llm.listProviders`/`listModels`/`resolveModelInfo`，单 provider 失败只附 error 不拖累整份目录（index.js:3539-3542）。
- 测试钉子：`submit` 模型缺失诚实报错（test-orchestration.mjs:1-5 头注释；基线 LEGACY_CHANNEL 强制指向已注册 provider，test-orchestration.mjs:44-45）。

### 三层能力契约（吸收自 FSoft CodeWiki）

- `planMode=auto`：`semanticPlan`（index.js:965-1048）先 `extractRepoGraph`（符号提取，index.js:941-951），失败退回 `localPlan` 顶层目录分组（index.js:2161-2211）；`buildPlan`（index.js:2161-2184）据此选路并记 note。默认 `dirs` 之外的语义聚类（index.js:76）由 `lib/cluster.js` 的两阶段聚类 + 递归下钻实现（README.md:33）。
- `agenticArticles`：`startAgenticRun`（index.js:805-852）走第二条执行器通道，任务不带 `batchPrompt`、由模型现场 read_code/list_files/edit_article 写作（index.js:23-25）；`markBigAgenticTasks` 给超大模块打大档标记（index.js:934-945）；失败过半退回单轮通道且只退一次：`shouldFallBackFromAgentic`（index.js:2019-2024）判过半、`shouldFallBackHere`（index.js:933-940）守 `job.agenticRetried`（index.js:934）、`shouldFallBackFromAgentic` 失败只在「本批过半失败」且「本 job 还没退回过」时重跑（index.js:934-936）。
- `symbolIncremental`：stale 先做符号级过滤（index.js:20-40），拿历史快照 `loadSnapshot` 与当前 `extractCurrentGraph` 比组件级变更，只留真受影响的文章（index.js:1642-1647）；无快照/提取失败退回文件级（index.js:1642-1647）；快照随产物写入 `.codewiki/temp/`（index.js:1642-1663）。三者默认全开（README.md:37、client.js:90-101 设置页一节），任一不可用都自动降级回旧行为、不让编译中断（client.js:266）。
- 子模块成文（`generate_sub_module`，lib/articles-agentic.js 接 job 生命周期，README.md:39）：模型写作时若发现模块内一整块子能力值得单独成文可派出去，递归落 `<wiki>/modules/<父>/<子>.md`；0.13.4 修复「封顶静默撒谎产出死链」与「CRLF 跨行必定失败」等翻车点（CHANGELOG.md:3-20）。

### 工具面与 schema 契约

- `cwToolDefinition`（index.js:1240-1303）：cw CLI 薄封装，子命令白名单 `CW_SUBCOMMANDS`（index.js:29、index.js:29-70）。
- `generateToolDefinition`（index.js:3077-3289）：提交制编译入口；description 四段自述（index.js:1258-1264）即模型可见合同，强调「调用即返回不等待/不轮询/产物由插件自动提交」；output schema 用 `required` 强制字段（index.js:1258）。
- `updateToolDefinition`（index.js:3299-3351）：固定 scope=auto 的日常维护入口；execute 委托 `generateDef.execute({...args, scope:'auto'})`（index.js:3292），提交后追加「继续下一项」note（index.js:3292），错误前缀改写为 `codewiki_update`（index.js:3292）。
- `progressToolDefinition`（index.js:3370-3474）：只读查进度；output schema 里可空字段一律 `oneOf:[{type:'number'},{type:'null'}]`（progress index.js:81、`autoCommit` index.js:3464-3478）；`jobId`/`stage` 仅在提交/幂等/续查路径赋值（index.js:7），降级返回不放 null 占位（index.js:7-9 的 wikiPath 空串注释）。
- 工具 description 与 README 工具表（README.md:9-15）互为镜像；四工具的注册在 `apply` 的 `ctx.inject(['tools'])` 回调内（index.js:4069-4085）。
- schema 校验容错：单工具注册失败只 console.error 该工具并跳过，不回滚已注册的全部工具（index.js:4116-4127）——注释见 index.js:4119-4121。
- 装载契约（宿主消费）：package.json 的 `exports`（`index.js` 与 `./client`，package.json:8-11）、`engines.dsh`（package.json:13-16）、`dsh.client.platform:'web'`（package.json:20-27）——client.js 的 `__ModuleLoader__.load({id:'@local/dsh-codewiki'})`（client.js:10-12）据此被宿主发现。
- 测试钉子：四工具均注册（test-orchestration.mjs:279-284）；`codewiki_update` 的 scope 强制/透传/note/错误前缀（test-orchestration.mjs:308-317）。

### 编译对象闸门契约

- `detectLinkedWorktree`（index.js:349-365）：用 `git rev-parse --git-dir/--git-common-dir` 不同即判为 linked worktree（注释 index.js:349-359）。
- `isWorktreeCwd`（index.js:373-384）：带 60s 缓存的判定版，避免 2s 轮询端点逐任务 spawnSync git（index.js:373-375）。
- `hasCompilableSources`（index.js:392-406）：扫不出任何源文件即视为空壳；带 10 分钟缓存（index.js:392-393）。
- `isDeadCompileTarget`（index.js:418-426）：统一判定 `worktree OR (!exists) OR !hasCompilableSources`（注释 index.js:418-422——目录已不存在时不算 dead，保留历史可见性）。
- 闸门落点：`submit` 闸门（index.js:2958-2973，auto 调度静默跳过 index.js:2958/2880）、工具 execute 闸门（index.js:4082-4103，auto0 时静默返回 index.js:4082/3050）、`autoScan` 静默跳过（index.js:1775-1778）、面板任务列表过滤 `jobs` 端点（index.js:1775）、仓库总览过滤（index.js:1775）、启动清理并反登记（index.js:1587-1602 配合 `forgetRepo` index.js:1587-1596）。
- `forgetRepo`（index.js:1572-1581）：从已知仓库清单 `REPOS_FILE` 摘掉 worktree/空壳目录，只动插件自己的登记（注释 index.js:1572-1573）。
- 测试钉子：worktree 闸门静默跳过（test-orchestration.mjs:1-5 头注释与 auto 调度桩）。

## Architecture

```text
CodeWiki.md 入口（ensureWikiEntry, index.js:286-319）   系统提示提醒（installUpdateReminder, index.js:4034）
        │ 门控只看仓库根是否存在 CodeWiki.md（index.js:4049）           │ text 回调实时求值
        ▼                                                          ▼
codewiki_generate(cwd, scope)  ──纯提交──►  generateToolDefinition.execute (index.js:3121)
        │  cw status 判态 → 幂等查活任务 → stale 预构建 / full 走 submit
        ▼
JobService.submit (index.js:2958) ──► {submitted, jobId, stage} 立即返回
        │（宿主后台 tick 推进，默认 10s；单次 void tick() 提前一步）
        ▼
queued → articles(写文章/agentic) → crosscut(横切) → compose(拆合成才出现)
       → review(批量校对) → index(cw index+meta) → commit(autoCommitWiki)
        │ 全程唯一模型通道 llm.stream（runRealtimeTasks, index.js:509；llmChat, index.js:452）
        │ 分默认档/大档双池（bigTier, index.js:516-519）；110k–420k 升大档、超 420k 拆观察→合成、单文件连大档都装不下才转会话通道
        ▼
autoCommitWiki (index.js:3906)：主题分支提交 → 合并回原分支 → 删分支
        ├─ committed / no-changes → 完全静默（autoCommitState, index.js:1750）
        └─ pending → wakeCompileSession(steer, index.js:1757) + commitHintText(section, index.js:3990)
```

## Data Flow

- **配置流**：profile patch `config:` → cordis 注入 `apply(ctx, config)`（index.js:92）→ `liveConfig` 每次调用解包（Config 全部 `.volatile()`，index.js:92-134），execute/tick 时热读取。
- **凭证流**：插件不保存也不传递任何密钥（0.10.1 删除内置直连后无例外，`llmChat` 注释 index.js:454-459）；请求经宿主 `llm.stream()`，凭证由所选 provider（默认 workbuddy）在模型设置里的配置解析。
- **任务流**：`generateToolDefinition.execute` 预构建（含 token 预算分块 `prepareArticleTasks` index.js:735、`collectSources` index.js:2958）→ `submit` 落 `JOBS_FILE`（index.js:2870）→ 服务 `tick` 消费（`createJobService` index.js:1774，tick index.js:1774）→ 单项目串行时先排队（index.js:481-522）→ 文章落盘 + 校对回写（`applyTaskResult` index.js:1949、`writeValidated` index.js:1949）→ `cw index`/`meta update`（`tickIndex` index.js:3906）→ `autoCommitWiki`（index.js:3906）。
- **会话记录流**：并发池每个 LLM 请求经 `beginSessionRecord`（index.js:1481）落盘 `SESSIONS_DIR`（index.js:1390），面板 `GET /api/codewiki/sessions` 读取（index.js:2078）。
- **面板流**：浏览器 `client.js` 2s 轮询 `GET /api/codewiki/jobs`（index.js:3619）、`/api/codewiki/repos`（index.js:3659）、`/api/codewiki/models`（index.js:3800）、`/api/codewiki/control`（index.js:3840），全部仅回环放行（index.js:3480-3483）。

## Connections

- [[wiki-generation-flow]] — 编译流水线的端到端形态（`generateToolDefinition.execute` → `submit` → 阶段机 → `autoCommitWiki`），本契约是它的「规则手册」。
- [[wiki-generation]] — 上游 Rust CLI `cw` 的状态判定与 `index`/`meta update`，被 `parseStatus`/`runCw`/`wikiPathFor` 封装（index.js:1351-1415、1272-1277）。
- [[cordis-config-injection]] — `Config`/`liveConfig` 依赖「设置命名空间 codewiki」的 cordis inject 语义（index.js:92-166、3969-3972）。
- [[configuration-management]] — plugin 行 config 的命名空间与各键默认值（README.md:43-64、client.js:35-209 设置页词典）。
- [[file-watching-mechanism]] — autoScan 定时调度（index.js:4080-4114）与 worktree/空壳闸门（index.js:4096-4099）。
- 宿主模型目录（`llm.listProviders`/`listModels`/`resolveModelInfo`）— 0.10.0 起编译模型默认 `workbuddy`/`hy3`（192k 上下文），故 `BATCH_TOKEN_BUDGET=110000`（index.js:6）、`BATCH_TOKEN_HARD_LIMIT=128000`（index.js:6）；模型与思考档位均由设置页从模型目录读取（index.js:6-66）。

## Known Issues

- **入口门控只看仓库根 `CodeWiki.md`，不看 `.codewiki/`**：空骨架目录（只有空子目录）会骗过目录存在性检查，让提醒指向读不到的入口（注释 index.js:3888-3891；守护收紧 test-orchestration.mjs:259-264）——这是 139052c 后「编译过但无入口的仓库永远收不到收尾提醒」不变量缺口的根因遗留。
- **`Config` 不热加载插件本身**：改 `index.js` / profile patch 后需重启 dsh（config 值本身热读）；`client.js` 同理（宿主「非 client 包」判定按 Loader 条目缓存，`dsh.client` 声明新增后需重启）（CodeWiki.md:70）。
- **`@deepseek-ai/schemastery` 靠插件本地 junction**：换机器需重建（CodeWiki.md:71）。
- **会话通道依赖发起会话可用**：面板/自动调度提交的 job 没有会话可 steer，超预算文章/校对任务直接整体失败并明示原因（index.js:1377-1379），不退超大兜底、不静默跳过校对（index.js:1377-1381）。会话通道任务超时默认 30 分钟（`DSH_CODEWIKI_SESSION_TIMEOUT_MS`，index.js:1377），超时按失败处理、不降级。
- **多实例并存边界**：`JOBS_FILE.lock`（index.js:1828-1846）防双提交，`mergeFromDisk`（index.js:1566-1587）防互相覆盖，`ORPHAN_TAKEOVER_MS`（index.js:1566）处理宿主重启遗留孤儿任务。
- **旧 `stage:'plan'` 残留**：0.10.7 删规划阶段后，旧任务在 tick 内自动迁到 articles（index.js:33-40）；客户端 `ACTIVE_STAGES`（client.js:246）过滤掉残留 `plan` 键，避免失败/取消不标红——属于兼容性残留而非 bug。

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

`documented-contract` 指 dsh-codewiki 插件（版本 0.13.4，package.json:3）中由文档显式规定、并被代码与测试共同遵守的结构化约定。stale 逐篇更新的任务使命本身就是这条契约的自指样本：「更新过期文章 ……：以当前代码为准重写其内容，保留章节结构与 title/type/tags」（index.js:3206）——本篇正是该使命的产物。核心包含七层契约：

(1) **入口契约**——仓库根 `CodeWiki.md` 是项目 wiki 入口（公约自述 CodeWiki.md:3，本插件仓库自己的 CodeWiki.md 就是实例）。`ensureWikiEntry`（index.js:286-319）在编译收尾对缺失入口生成中/英模板，已有入口一律不覆盖（index.js:286）；系统提示维护提醒的门控只看仓库根是否存在 `CodeWiki.md`（index.js:286），刻意不看 `.codewiki/` 目录——空骨架目录会骗过目录存在性检查、提醒却指向读不到的入口（依据注释 index.js:286-288）。

(2) **文章格式契约**——每篇生成文章必须以 `---` frontmatter（`title`/`type`/`source_files`/`tags`，模板 index.js:779-786）开头并含固定六章节 `## Overview`…`## Known Issues`（index.js:897-903），模板唯一规定处是 `articleFormatSection`（index.js:897-926，条款取自上游 skills/codewiki-session.md，index.js:597）；行号引用以「行号| 」前缀为准（`numberLines` index.js:735-737，`collectSources` 内联时注入 index.js:1949）；落盘闸门 `writeValidated`（index.js:1949-1965）对 keepInMemory 任务强制 frontmatter（缺则记 invalid 不落盘，index.js:481-483），普通文章直写 `applyTaskResult`（index.js:608-621）与它共用 `fixAnchors`（index.js:608-730）——按 frontmatter `source_files`（`parseSourceFiles` index.js:1317-1329）对照源码确定性校正行号锚点。

(3) **提交制与产物契约**——`codewiki_generate` 纯提交即返回（execute index.js:2958-3125 → `submit` index.js:2958-3043，返回前立即推进一步 index.js:2958）；阶段机为 queued→articles→crosscut→(compose)→review→index→commit（`STAGE_HANDLER` index.js:2861-2868）；0.10.7 起无独立规划阶段（queued 唤醒恒进 articles index.js:3946-3953，旧 plan 任务在 tick 内迁移 index.js:3946-3953）；0.10.11 起 `commit` 是独立阶段（`tickIndex` 提前返回 index.js:2843-2845，`tickCommit` index.js:3906-3922 执行 `autoCommitWiki` index.js:3906-3988）——「主题分支 `codewiki/wiki-<jobId>` 提交 → 合并回原分支 → 删主题分支」（index.js:45-79），改动由 pathspec 限定在 `WIKI_PATHS`（`.codewiki`、`CodeWiki.md`，index.js:1750）；committed/no-changes/pending 三态由 `autoCommitState`（index.js:1757-1762）唯一判定，`wakeCompileSession`（index.js:3990-4005）与 `commitHintText`（index.js:3990-4021）两条打扰通道共用同一结论。

(4) **模型通道契约（0.10.1）**——唯一通道是宿主 `llm.stream()`：`submit` 强制 `batchProvider` 非空、`batchModel` 非空、`llm.stream` 可用，任一缺失抛错并落 job `failed`（index.js:452-461）；`llmChat`（index.js:452-477）不解析也不传递任何密钥（注释 index.js:452-454）；模型不支持所配思考档位时剥档重试一次（index.js:810-814）；并发按任务上的 `bigTier` 标记分成默认档/大档两个独立池（`runRealtimeTasks` index.js:509-568，分池判定 index.js:95-103；`bigConcurrency` 配置 index.js:95、liveConfig 钳制 index.js:95-97）。

(5) **0.13.0 三层能力契约（吸收自 FSoft CodeWiki）**——`planMode=auto`（AST 符号提取 + LLM 语义聚类，失败自动降级目录分组：`semanticPlan` index.js:2161-2244、`buildPlan` index.js:77-100）、`agenticArticles`（模型自己 read_code/list_files/edit_article 增量写作：`startAgenticRun` index.js:934-981；失败过半退回单轮通道且只退一次：`shouldFallBackFromAgentic` index.js:2019-2024、`shouldFallBackHere` index.js:933-940、`job.agenticRetried` 标记 index.js:79）、`symbolIncremental`（stale 先做符号级过滤 index.js:79-99，快照随产物写入 index.js:79-100）。三者默认全开（README.md:37），任一不可用都自动降级回旧行为、不让编译中断（client.js:79）。

(6) **工具面与 schema 契约**——工具输出经宿主 JSON Schema 校验：可空字段一律 `oneOf` 形态（`progress` index.js:81、`autoCommit` index.js:81-95），不提交路径不放 null 占位（`jobId`/`stage` 仅在提交/幂等/续查路径赋值，index.js:3166），降级返回的 `wikiPath` 用空串满足 string 校验（index.js:3166、index.js:3166）；单工具 schema 违规只丢该工具、不回滚全部注册（index.js:4-15）；工具 description 本身是模型可见的合同文本（`cw` index.js:4-8、`codewiki_generate` index.js:3292-3298、`codewiki_update` index.js:7-10、`codewiki_progress` index.js:7-11），与 README 工具表（README.md:14-20）互为镜像；package.json 的 `exports`/`engines`/`dsh.client`（`exports` package.json:8-11、`engines.dsh` package.json:13-16、`dsh.client` package.json:20-27）则是宿主消费的装载契约。

(7) **编译对象闸门契约（0.12.0/0.12.1）**——linked worktree（`detectLinkedWorktree` index.js:392-408）与扫不出源码的空壳目录（`hasCompilableSources` index.js:349-363）统一判定为 `isDeadCompileTarget`（index.js:349-357）：submit 闸门（index.js:349-354）与工具 execute 闸门（index.js:349-357）、autoScan 静默跳过（index.js:1587-1590）、面板任务列表过滤（index.js:1587）、仓库总览过滤（index.js:1587）、启动清理并反登记（index.js:1587-1602、`forgetRepo` index.js:1587-1596）。

测试侧以同构断言把契约钉成可执行形态：编排冒烟头注释（test-orchestration.mjs:27-32）列出覆盖面，逐条 `check` 输出 ✓/✗（test-orchestration.mjs:27-30）并以 PASS/FAIL 计数收尾（test-orchestration.mjs:27-28），运行留痕即 .tmp-test-orchestration.log 的形态（历史运行收尾 FAIL：2 项未通过，.tmp-test-orchestration.log:573）——文档因此成为可机器验证的索引，而不只是散文。

## Key Components

### 入口与提醒契约

- `ensureWikiEntry`（index.js:286-319）：入口文件兜底。已存在即返回 false 绝不覆盖（index.js:3155）；缺失时按 `language` 写中文或英文模板（index.js:3155-3167 / index.js:3155-3168），模板内含 wiki 目录绝对路径、索引/总览/模块/概念指引与「人工改写不覆盖」声明；由 `tickIndex` 在 `writtenCount>0` 时调用（index.js:2774-2778），失败只记 note 不影响任务（不变量缺口说明 index.js:2774-2776）。
- `installUpdateReminder`（index.js:4034）：`agent/created` 时注册系统提示 section `codewiki:update-reminder`（index.js:4034），order = TOOL_REPORT+1（index.js:3990）；text 回调每次组装求值（index.js:3990-3996）——`updateReminder=false` 返回空串（index.js:3990）、仓库根缺 `CodeWiki.md` 返回空串（index.js:3990），门控通过后拼入 `commitHintText`（index.js:1734-1735）；存量会话经 `ctx.inject(['agents'])` 补装（index.js:1734-1740），服务缺失静默跳过；新会话走 `agent/created`（index.js:1734）。门控「判定不看 .codewiki/ 目录」的依据注释在 index.js:1734-1736。
- `reminderText`（index.js:4023-4032）：提醒正文五条——收尾必须调 `codewiki_generate`、禁止手改 `.codewiki/` 文章（index.js:4）、调用即返回不等待不轮询且产物由插件自动提交（index.js:4）、wiki 路径在仓库根需绝对路径访问（index.js:4）、只有收到「产物待提交」提醒才需要代跑 git（index.js:4）、收尾未调用视为任务未完成（index.js:4）。
- `commitHintText`（index.js:4001-4032）：只在自动提交三态为 `pending` 时注入一次性「产物待提交」提醒（判定 index.js:1757，与 `wakeCompileSession` 共用 `autoCommitState`）；committed/no-changes 直接静默、连 git 都不必查（index.js:1750-1751）；pending 时比较编译完成时间与 `.codewiki`+`CodeWiki.md` 最后一次 git 提交时间（index.js:1750-1755），文案带失败原因（index.js:1750-1757）并写明「不要为了本提醒中断当前任务、不要轮询」（index.js:1750）；60s TTL 缓存按 cwd 键（缓存声明 index.js:1750，命中判定 index.js:1750）。
- 测试钉子：section 名与门控（test-orchestration.mjs:255-267，含「.codewiki 存在但根无 CodeWiki.md 不注入」的守护收紧 test-orchestration.mjs:260-265）；`commitHintText` 全分支（test-orchestration.mjs:319-409：无提交史提醒 test-orchestration.mjs:327-330、不同仓库为空 test-orchestration.mjs:337-338、编译早于提交静默 test-orchestration.mjs:348-349、编译晚于提交提醒 test-orchestration.mjs:359-360、带失败原因 test-orchestration.mjs:370-374、writtenCount=0 静默 test-orchestration.mjs:380-381、committed/noChanges 静默 test-orchestration.mjs:388-391、pending 提醒+原因 test-orchestration.mjs:402-406）。

### 文章格式与落盘契约

- `articleFormatSection`（index.js:897-926）：文章模板的唯一规定处。frontmatter 四键（index.js:897-903）与六章节顺序（index.js:897-902）硬编码；条款含「行号以源码『行号| 』前缀为准，禁止自行数行或猜测」（index.js:897）、「source_files 必须列出你为写本文读过的每一个文件（含测试文件）」（index.js:897）、「功能被禁用/注释时写明具体位置」（index.js:897）、Architecture 用 box-drawing 框图（index.js:897）、Markdown 规范（index.js:897）、Connections 用 `[[backlinks]]`（index.js:897）、「写给零上下文的未来 agent」（index.js:897）。
- 行号前缀：`numberLines`（index.js:597-600，设计注释 index.js:735-737——弱模型自己数行首尾常对、中段系统性错位）；`collectSources` 内联源码时逐行注入（index.js:735）。
- 落盘闸门：`writeValidated`（index.js:1949-1965）缺 frontmatter 不落盘（index.js:608-627）、随后 `fixAnchors` 校正并记 notes（index.js:481-483）再写盘（index.js:481）；`applyTaskResult`（index.js:481-494）对普通文章直写、keepInMemory 只回内存（index.js:481-482）由服务侧消费。
- `fixAnchors`（index.js:608-728，语义注释 index.js:608-614）：锚点起点行应包含该行反引号内符号；不包含时在源文件全文找符号——恰好一处修正、多处取唯一声明形态、歧义/未找到不动并记 unresolved；全部修正只改行号数字。
- `parseSourceFiles`（index.js:1317-1329）：读 frontmatter 的 source_files（inline 数组与 block 列表两式）；stale 路径对无 source_files 的过期文章直接跳过并说明（index.js:1317-1319）——frontmatter 因此也是增量流程的机器可读契约。
- prompt 构造器（格式条款的载体）：`batchArticlePrompt`（index.js:766-793）在 prevArticle 注入段写明「供保留章节结构与 title/type/tags；行号可能已过期一律不得沿用」（index.js:897）并收尾拼 `articleFormatSection()`（index.js:1152）；合成版 `batchArticleComposePrompt`（index.js:1152-1180，同款条款 index.js:1085、格式段 index.js:1085）；横切三件套 `batchArchitecturePrompt`（index.js:1093-1099）/`batchPatternsPrompt`（index.js:1101-1107）/`batchConceptPrompt`（index.js:1111-1117）；观察两件套 `batchObservePrompt`（index.js:1132-1149）/`batchArticleObservePrompt`（index.js:1184-1200）；校对单篇版 `batchProofreadPrompt`（index.js:1207-1226）与批量版 `batchProofreadBatchPrompt`（index.js:1207-1234）——批量校对的输出合同是「每篇一行 `@@@article: 名` + 修正后整文 + `
