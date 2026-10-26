---
title: update-reminder-entry-gap
type: learning
source_files:
  - index.js
tags: [reminder, gating, invariant, bugfix, hook]
---

## Overview

会话系统提示里的 CodeWiki 维护提醒有一道硬门控：只有会话仓库根存在 wiki 入口 `CodeWiki.md` 时才注入——`systemPrompt` section 的 `text` 回调里 `fs.existsSync(path.join(cwd, 'CodeWiki.md'))` 为假即返回空串（index.js:3508）。门控刻意不看 `.codewiki/` 目录是否存在：半途建出的空骨架（只有空子目录）会骗过目录存在性检查，而提醒却指向一个读不到的入口；无 `CodeWiki.md` 即视为「没有可维护的 wiki」（设计说明见 index.js:3338-3340）。

这套门控带来一个不变量缺口：流水线里原本没有任何环节负责创建该入口文件，于是「编译过、但仓库根没有 `CodeWiki.md`」的仓库永远收不到收尾提醒——提醒链路本身是通的，只是它的准入前提无人维护。缺口的注释写在入口生成器 `ensureWikiEntry` 前的注释（index.js:220-222）以及提醒门控的设计说明（index.js:220-222）中。

本条目记录三件事：

1. **创建者补齐**：`ensureWikiEntry`（index.js:220-253）在编译收尾阶段检查仓库根，缺失就按文章语言写一份 `CodeWiki.md` 模板；已有入口（人工/模型速查手册）绝不覆盖。
2. **提醒本身的两段式结构**：同一个 section 拼装 `reminderText`（index.js:3482-3491，静态维护指令）与 `commitHintText`（index.js:3449-3480，动态「产物待提交」提醒）。后者由「最近一次成功编译的完成时刻」与「`.codewiki/` + `CodeWiki.md` 最后一次 git 提交时刻」比较派生，零持久状态，提交后时间戳反超即自动静默。
3. **两条通知链并存**：系统提示 section 是「每次组装系统提示都求值」的兜底（由 `installUpdateReminder` 注入，index.js:3493-3525），编译终态还有一条 `wakeCompileSession` 主动 steer 进发起会话（index.js:1492-1507），后者只对有 `sessionId` 的 job 生效，且 0.10.9 起仅当自动提交未成功时才打扰会话（门控见 index.js:3493）。

## Key Components

### 配置项

- `Config.updateReminder`（index.js:66）：布尔，默认 `true`。描述即门控语义——「会话系统提示注入 CodeWiki 维护提醒（仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，收尾时提醒更新 wiki）」。
- `Config.articleLanguage`（index.js:65）：字符串，默认 `'中文'`。编译任务的 `job.language` 从这里回落，最终决定 `ensureWikiEntry` 写中文还是英文模板。
- `Config.autoUpdate`（index.js:69）与 `Config.autoUpdateMin`（index.js:70）：自动更新开关与扫描间隔（默认 30 分钟、最小 5）。自动调度走内部直调（`apply` 的 `autoScan`，index.js:3541-3568，传空 exec `{}` 见 3561），不带 `sessionId`，因此这类编译完成后只能靠 `commitHintText` 兜底。
- `val(x)`（index.js:74-76）：配置读取辅助，兼容 Zod 代理对象的 `.get()` 与裸值。提醒回调正是靠它在每次求值时读到**实时**开关，而不是 apply 时的配置快照。
- `liveConfig(config)`（index.js:78-108）：把配置快照成普通对象（含并发钳制与默认值兜底）。注意它**不含** `updateReminder` 字段——提醒开关只在 `val(config?.updateReminder)` 处直读（位于 `installUpdateReminder` 的 `text` 回调，index.js:3506）。

### 入口生成（缺口修补点）

- `ensureWikiEntry(cwd, language = '中文')`（index.js:220-253）：编译收尾的入口不变量维护者，返回值表示「本次是否新建」。
  - `!cwd` → `false`（index.js:221）；`fs.existsSync(entryPath)` 为真 → `false`，绝不覆盖人工入口（index.js:223）。
  - 语言选择：`/中文|zh/i.test(String(language))`（index.js:225），命中走中文模板（index.js:226-237），否则走英文模板（index.js:238-251）。
  - 中文模板内容（index.js:226-237）：`# CodeWiki` 标题、说明活 wiki 由 dsh-codewiki 编译流水线（`codewiki_generate` 工具 / 编译面板）维护、把 `.codewiki` 的路径写进正文（index.js:231）、列出 `_index.md` / `_architecture.md` / `modules/` / `concepts/` 的分工（index.js:232）、要求收尾跑 `codewiki_generate`（scope=auto）并与代码一起提交（index.js:233）、末尾声明「缺失时自动生成，人工改写不被覆盖」（index.js:235）。
  - 英文模板是同结构镜像（index.js:238-251），自动生成声明在 index.js:248。
  - 正常结束 `return true`（index.js:252）。

### 提醒文本构造

- `reminderText(cwd)`（index.js:3482-3491）：拼接静态维护指令的字符串数组并 `join('\n')`，共 5 条：
  - 声明本仓库存在 wiki（入口 `CodeWiki.md`），涉及代码改动的任务收尾必须调用 `codewiki_generate`（scope=auto 即可），learnings/、decisions/ 补文章与索引刷新由流水线完成，不要手工写 `.codewiki/` 下的文章（手改不进流水线、不被面板记录、会被下次编译覆盖）（index.js:3484）；
  - `codewiki_generate` 是后台编译，调用即返回，不要等待，需要进度时用 `codewiki_progress`；编译完成的产物由插件自己提交入库（autoCommit 开，默认开：主题分支提交后合并回原分支），无需跑 git（index.js:3486）；
  - 用模板串插入 `cwd`：入口与 `.codewiki/` 全部内容位于 `${cwd}`，在仓库根之外读写一律用绝对路径（index.js:3487）；
  - 若收到「产物待提交」提醒说明插件自动提交没成功，此时才需要代为提交一次；没有该提醒就不要动 `.codewiki/` 的 git 状态（index.js:3488）；
  - 收尾未调用 `codewiki_generate` 视为任务未完成（index.js:3489）。

- `commitHintText(cwd, jobs = loadJobs())`（index.js:3449-3480，export 供测试直调）：动态「产物待提交」提醒，唯一真值是 jobs 记录 + git 时间戳，不写任何持久标记。
  - 缓存：模块级 `commitHintCache`（index.js:3347）以 `path.normalize(String(cwd ?? ''))` 为键（index.js:3450），60s TTL 内命中即返回（index.js:3347），末尾无论有没有提醒都写缓存（index.js:3478）。
  - 取最近成功编译：从 `jobs` 筛 `stage === 'done'`、`writtenCount > 0`、有 `finishedAt`、且 `samePath(j.cwd, cwd)` 的记录（index.js:3455-3457），按 `finishedAt` 字符串倒序取第一条。
  - 取提交时刻：`spawnSync('git', ['-C', cwd, 'log', '-1', '--format=%ct', '--', ...WIKI_PATHS], { encoding: 'utf8', timeout: 5000, windowsHide: true })`（index.js:3461），`WIKI_PATHS` 为 `['.codewiki', 'CodeWiki.md']`（index.js:36），只覆盖这两个路径，5s 超时。
  - 判定：前置条件仅当 `autoCommitState(latest) === 'pending'`（调用见 index.js:3462，函数定义见 index.js:3462-3467）才进入 git 检查；`commitSec` 由 `git log` 的 `%ct` 解析（index.js:3462），`jobSec = Math.floor(Date.parse(finishedAt) / 1000)`（index.js:3462），当 `jobSec > commitSec`、或 git 没给出有限时间戳（这两个路径尚未提交过）时输出提醒（index.js:3466-3475）。
  - 文案（index.js:3470-3474）：「【CodeWiki 产物待提交·一次性】…（任务 id，写入 N 篇文章），插件自动提交未执行（原因）或编译产物尚未提交 git」，并给出操作约束——只 add `.codewiki/` 与 `CodeWiki.md` 两个路径、建议 `docs(wiki)` 前缀、不要 `git add -A`、不需要提交就忽略本提醒；不要为了本提醒中断当前任务或轮询编译进度。
  - 非 git 仓库、`git` 不在 PATH、jobs 读取失败：整个 try 块吞掉异常（index.js:3477），返回空串即不提醒。

- `samePath(a, b)`（index.js:2818-2821）：路径归一（`path.normalize` + 去尾部分隔符 + 小写）后比较，Windows 大小写不敏感地定位任务 cwd。`commitHintText` 用它判断 job 是否属于本仓库（index.js:3456）。

- `autoCommitState(job)`（index.js:1485-1490）：从 job.autoCommit 字段判定 `'committed'` / `'no-changes'` / `'pending'`，供 `commitHintText` 与 `wakeCompileSession` 共用同一结论。

### 系统提示注入

- `installUpdateReminder(ctx, config)`（index.js:3493-3525）：把提醒装进每个 Agent 的 `systemPrompt` 服务。
  - 守卫：`typeof ctx.on !== 'function'` 直接返回（index.js:3494）。
  - 幂等：函数内 `WeakSet`（index.js:3495）记录已装过的 agent，`seen.has(agent)` 即跳过（index.js:3497），同一个 agent 只装一次。
  - 注入点：`agent.ctx?.inject?.(['systemPrompt'], ...)`（index.js:3499），回调里取 `rc2?.systemPrompt ?? rc2`（index.js:3500），缺 `section` 方法则跳过（index.js:3501）。
  - section 声明（index.js:3502-3504）：`name: 'codewiki:update-reminder'`（index.js:3503）；`order` 取 `sp.getSectionOrder('TOOL_REPORT') + 1`，服务没有该方法时回退 `2900 + 1`（index.js:3504），即紧接工具报告段之后。
  - `text` 回调（index.js:3505-3511）每次组装系统提示都重新求值，因此开关、cwd、入口文件存在性全是实时值，切项目/删 wiki/关开关都无需重启：
    1. `val(config?.updateReminder) === false` → 返回空串（index.js:3506）；
    2. `agent.session?.header?.cwd` 为空、或该目录下没有 `CodeWiki.md` → 返回空串（index.js:3507-3508）；
    3. 否则 `commitHintText(cwd)` 有内容就拼成 `reminderText + 两空行 + hint`，没有就只返回 `reminderText`（index.js:3509-3510）。
  - 存量会话补齐：`ctx.inject(['agents'], ...)` 遍历 `agents.list()` 逐个 install（index.js:3517-3524）——注释指出 cordis 下访问未声明 inject 的服务属性本身即抛，必须经 inject 取服务；新会话由 `ctx.on('agent/created')` 兜住（index.js:3519）。

### 收尾与终态唤醒

- `tickIndex(job)`（index.js:2304-2334）：index 阶段的处理器，串起「收尾命令 → 入口补齐 → 终态唤醒（或转 commit 阶段）」。
  - 仅当 `job.writtenCount > 0` 才执行收尾命令（index.js:136）：`runCw(binary, job.cwd, ['index'], 120000)`（index.js:2308）与 `['meta', 'update']`（index.js:2309），两个 exit code 记进一条 note（index.js:136），任一非 0 会提示「编译基线可能未刷新，可重试编译」（index.js:136）；index 成功后还要 `normalizeIndexLinks(job.cwd)` 把 `_index.md` 链接头的 `\` 规范化为 `/`（index.js:2312）。
  - 入口补齐被单独的 try/catch 包住（index.js:220-224）：`ensureWikiEntry(job.cwd, job.language)` 返回 true 时记 note「仓库根缺 CodeWiki.md 入口，已自动生成（已有入口不覆盖）」（index.js:2317）；抛错只记「CodeWiki.md 入口生成失败（忽略）」（index.js:220），不让编译任务失败——入口存在性不配决定编译成败。
  - 一篇都没写成功时记「跳过 index/meta update」（index.js:2322），仍然推进到 done 或 commit。
  - 终态分支：若 `writtenCount > 0` 且 `autoCommit` 开，转 `commit` 阶段（index.js:2327-2328）；否则 `setStage(job, 'done')`（index.js:2331）、写 `finishedAt`（index.js:2332），只有 `writtenCount > 0` 才 `onSettled?.(job, 'done')`（index.js:3405）触发实时唤醒。

- `tickCommit(job)`（index.js:2336-2352）：独立提交阶段（0.10.11 起），`autoCommitWiki` 走主题分支合并式提交（index.js:2341）；完成后 `setStage(job, 'done')`（index.js:2349）、写 `finishedAt`（index.js:2350），同样 `onSettled` 唤醒（index.js:2351）。

- `wakeCompileSession(job, outcome, agents = agentsRef)`（index.js:1492-1507）：编译终态的 steer 唤醒，与系统提示提醒互为补充。0.10.9 起成功且插件已自动提交（或非 pending）则完全不打扰会话（门控在 index.js:1492）。
  - 无 `job.sessionId` 或无 agents 服务直接返回（index.js:1497），取不到 agent 或 agent 没有 `steer` 也返回（index.js:1499-1500）。
  - 失败文案「【CodeWiki 编译失败】…」（index.js:1502），成功但未自动提交文案「【CodeWiki 产物待提交】…检查 `.codewiki/` 与 `CodeWiki.md` 的未提交改动并提交（只 add 这两个路径，建议 docs(wiki) 前缀；不需要就忽略）」（index.js:1503）。
  - `agent.steer(...)` 抛错被吞掉，不影响编译任务本身（index.js:1504-1506）。

- `submit({ kind, cwd, wikiPath, scope, language, prebuiltTasks, auto, sessionId })`（index.js:2451-2536）：job 的创建入口，`sessionId: sessionId ?? null`（index.js:2451）就是唤醒权的来源——面板与自动调度提交时为 null，注释明确「面板/自动调度为 null，不唤醒」（index.js:2451）。

- `apply(ctx, config)`（index.js:3527-3590）：装配点。`installUpdateReminder(ctx, config)` 是最后一步（index.js:3590），此前已 `createJobService(config, wakeCompileSession)` 并 `service.start()`（index.js:3530-3531）、注册四个工具（index.js:3527-3543）、装好本地面板后端（index.js:3589）；`autoScan` 自动调度定义在 index.js:3541-3568，其中 index.js:3561 以空 exec `{}` 直调 `generateDef.execute` 提交编译。

### 相关工具与解析函数

- `updateToolDefinition(cfg, generateDef)`（index.js:2758-2810）：`codewiki_update`，固定 scope=auto 的日常维护入口；提交成功时补一条「更新已在后台进行…编译产物由插件完成后自动提交入库（autoCommit），无需你跑 git。仅当收到『CodeWiki 产物待提交』提醒时才需要代为提交一次」（index.js:2758）——它依赖的正是本条的提醒链路。
- `generateToolDefinition(cfg, svc)`（index.js:2570-2748）：`codewiki_generate`，判态后提交 job；`sessionId = exec?.agent?.id ?? null`（index.js:2570）是唤醒权的采集点。
- `loadJobs()`（index.js:1396-1399）：`commitHintText` 的默认数据源（读 `JOBS_FILE`，定义见 index.js:1396），失败返回空数组。
- `cwToolDefinition(cfg)`（index.js:1007-1070）、`progressToolDefinition(cfg, svc)`（index.js:2829-2933）：另两个工具定义，与提醒链路无直接耦合。
- `normalizeArticlePath(p)`（index.js:173）、`parseStatus(stdout)`（index.js:187-200）：`cw status` 输出的路径规范化与三态解析，收尾判定链的上游。
- `autoCommitWiki(cwd, ...)`（index.js:3365-3447）：自动提交实现（0.10.11 起主题分支合并式），被 `tickCommit` 调用，其返回结构供 `autoCommitState` 与提醒判定使用。

## Architecture

```text
┌─ apply(ctx, config) index.js:3527 ───────────────────────┐
│ ├─ createJobService(config, wakeCompileSession) index.js:3530 │
│ │   └─ tickIndex(job) index.js:2304                        │
│ │       ├─ if writtenCount>0 才收尾 index.js:2305          │
│ │       ├─ runCw 'index'/'meta update' index.js:2308-2309  │
│ │       ├─ normalizeIndexLinks(cwd)     index.js:2312      │
│ │       ├─ ensureWikiEntry(job.cwd) index.js:2317          │
│ │       │   → 存在false(223)/缺失写模板(226-251)           │
│ │       └─ autoCommit开 → tickCommit index.js:2328-2336    │
│ │           → autoCommitWiki index.js:2341                 │
│ ├─ installUpdateReminder(ctx, config) index.js:3493        │
│ │   ├─ agents.list()/ctx.on('agent/created') index.js:3517-3524 │
│ │   └─ sp.section('codewiki:update-reminder') index.js:3502-3504 │
│ │       └─ text() 每次求值 index.js:3505-3511              │
│ │           ├─ updateReminder===false→'' index.js:3506     │
│ │           ├─ 无 <cwd>/CodeWiki.md→''  index.js:3507-3508 │
│ │           ├─ reminderText(cwd)        index.js:3482      │
│ │           └─ + commitHintText(cwd)    index.js:3449      │
│ │               → git log %ct index.js:3461                │
│ └─ 编译终态 steer 唤醒 wakeCompileSession index.js:1492     │
│     ├─ failed→【CodeWiki 编译失败】      index.js:1502      │
│     └─ done(未自动提交)→【产物待提交】  index.js:1503 (门控1496) │
└────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **编译收尾**：`codewiki_generate` 提交的 job 推进到 index 阶段，`tickIndex`（index.js:2304）在 `writtenCount > 0` 时（index.js:2304）执行 `cw index` 与 `cw meta update`（index.js:2304-2305），并按需规范化 `_index.md` 链接（index.js:2304）。若开启 autoCommit 则转 `tickCommit` 提交产物（index.js:2304-2305），否则直接终态。
2. **入口补齐**：同一函数调用 `ensureWikiEntry(job.cwd, job.language)`（index.js:2317）。文件缺失则按语言写模板并返回 true（note「已自动生成（已有入口不覆盖）」）；已存在返回 false（index.js:220）；抛错只记 note（index.js:220）。这一步正是把门控前提补上的地方。
3. **终态通知**：`setStage(job, 'done')` 后（定义见 index.js:1600，调用在 tickIndex 2331 或 tickCommit 2349）写 `finishedAt`（index.js:2332/2350），`onSettled` 经 `wakeCompileSession` steer 一条通知进发起会话（index.js:2333/2351）——但 0.10.9 起仅当自动提交未成功才打扰（门控在 index.js:1600），实时唤醒不等系统提示重组。
4. **系统提示求值**：任一会话每次组装系统提示时，`codewiki:update-reminder` section 的 `text` 回调（index.js:3505）先判开关（index.js:3506），再判 `<cwd>/CodeWiki.md` 是否存在（index.js:3507-3508），命中才继续。
5. **提交提醒派生**：`commitHintText(cwd)` 取 jobs 里最近的 done 记录（index.js:3449-3451），用 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 取提交时刻（index.js:3449），结合 `autoCommitState` 判定（index.js:3460），`jobSec > commitSec` 才输出提醒（index.js:3449）；结果按 cwd 缓存 60 秒（声明 index.js:3449、键 index.js:3449、写回 index.js:3449）。
6. **提醒消失**：把两个路径提交后 `commitSec` 反超 `jobSec`，判定不成立返回空串，section 只剩静态的 `reminderText`；缓存过期后必然重算，无需任何清理动作。

## Connections

- [[core-logic]]：`apply` 装配链（index.js:3527-3590）与 `createJobService` 的阶段机（index.js:3530 起）是本提醒链路的宿主。
- [[compile-pipeline]]：`commitHintText` 读取的 jobs 记录由编译流水线写入——`stage`、`writtenCount`、`finishedAt` 三个字段（index.js:3449-3451）就是提醒的判定依据。
- [[article-index-and-meta]]：`cw index` / `cw meta update` 与 `_index.md` 路径规范化（index.js:2308-2312）同属收尾动作，提醒指向的产物由它们生成。
- [[testing-suite]]：`ensureWikiEntry`（index.js:220）与 `commitHintText`（index.js:3449）都是 export 形态，`commitHintText` 还把 `jobs` 做成可注入的默认参数，便于测试直调而不碰真实 `JOBS_FILE`；本次源码清单未包含测试文件，故不在此标注其行号。
- [[cw-binary-source-lost]]：同模块的另一条学习记录，讲 `cw` 二进制来源与路径规范化的历史缺口；本条是「入口文件存在性」这一侧的不变量缺口。

## Known Issues

- **全失败编译不补入口**：`ensureWikiEntry` 的调用只位于 `tickIndex` 的 `if (job.writtenCount > 0)` 分支内（判定 index.js:220，调用 index.js:2317）。一篇都没写成功时走 else 记「跳过 index/meta update」（index.js:220），仓库根仍可能没有 `CodeWiki.md`，这类仓库继续收不到提醒——需一次成功写入才会补上。
- **面板/自动调度提交不会被唤醒**：`wakeCompileSession` 只对有 `job.sessionId` 的 job 生效（index.js:1497），而面板与自动更新任务提交时 `sessionId` 为 `null`（`submit` 里 index.js:2485；`generateToolDefinition` 采集点 index.js:2650；自动调度直调在 `apply` 的 `autoScan` 内 index.js:1492 传空 exec `{}`）。这类编译完成后只能靠下次系统提示组装时的 `commitHintText` 兜底。
- **删入口即失去提醒**：门控只在 `text` 回调检查 `CodeWiki.md`（index.js:220），这是有意设计（避免空 `.codewiki/` 骨架骗过检查，设计注释见 index.js:220-222），副作用是入口被删后 wiki 仍在而提醒立即消失，要等下次编译触发 `ensureWikiEntry` 或人工重建入口。
- **提交提醒最多滞后 60 秒**：`commitHintCache` 的 60s TTL（声明 index.js:3347，命中判定 index.js:3347）意味着刚提交完的一段窗口内仍可能看到「产物待提交」提醒，属预期噪声而非逻辑错误。
- **缓存键与判定用的路径归一不同源**：缓存键是 `path.normalize`（index.js:3450），而判定用的是会小写化的 `samePath`（index.js:2818-2821）。同一目录以不同大小写出现时缓存会多存几份，只影响命中率，不影响提醒正确性。
- **依赖外部 git 且失败不可观测**：`commitHintText` 用 `spawnSync('git', ...)`（index.js:3461），`git` 不在 PATH、非 git 仓库、jobs 读取失败都会被 catch 静默成「不提醒」（index.js:3477）。排查「该提醒却没提醒」时要先手工跑同一条 git 命令确认，并核对 jobs 里是否真有 `stage=done` 且 `writtenCount>0` 的记录。
