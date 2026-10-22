---
title: update-reminder-entry-gap
type: learning
source_files:
  - index.js
tags: [reminder, gating, invariant, bugfix, hook]
---

## Overview

会话系统提示里的 CodeWiki 维护提醒有一个硬门控：只有当会话仓库根存在 wiki 入口 `CodeWiki.md` 时才注入（`fs.existsSync(path.join(cwd, 'CodeWiki.md'))` 判定在 index.js:2790）。这道门控是 139052c 收紧进来的——收紧当时流水线里没有任何代码负责创建该入口文件，于是「编译过但仓库根没有入口」的仓库永远收不到收尾提醒，形成不变量缺口（历史与理由写在 index.js:191-193 的注释里）。

本条目记录两件事：

1. **创建者补齐**：`ensureWikiEntry`（index.js:188）在编译收尾阶段检查仓库根，缺失就按文章语言写一份 `CodeWiki.md` 模板；已有入口（人工/模型速查手册）绝不覆盖。
2. **提醒本身的两段式结构**：同一个 `systemPrompt` section 拼装 `reminderText`（index.js:2764，静态维护指令）与 `commitHintText`（index.js:2737，动态「请提交改动」提醒）。后者由「最近一次成功编译的完成时刻」与「`.codewiki/` + `CodeWiki.md` 最后一次 git 提交时刻」比较派生，零持久状态，提交后时间戳反超即自动静默（设计说明见 index.js:2764-2771）。

判定刻意不看 `.codewiki/` 目录是否存在：半途建出的空骨架（只有空子目录）会骗过目录存在性检查，而提醒却指向一个读不到的入口；无 `CodeWiki.md` 即视为没有可维护的 wiki（index.js:2730-2732）。

## Key Components

### 配置项

- `Config.updateReminder`（index.js:46）：布尔，默认 `true`。描述即门控语义——「仅当会话仓库根存在 wiki 入口 CodeWiki.md 时出现，收尾时提醒更新 wiki」。
- `Config.articleLanguage`（index.js:45）：字符串，默认 `'中文'`。编译任务的 `language` 从这里回落，并最终决定 `ensureWikiEntry` 写中文还是英文模板。
- `val(x)`（index.js:53）：配置读取辅助，兼容 Zod 代理对象的 `.get()` 与裸值，提醒回调与 `liveConfig` 都靠它读到实时开关。

### 提醒文本构造

- `reminderText(cwd)`（index.js:2764-2773）：拼接静态维护指令的字符串数组并 `join('\n')`，共 5 条（index.js:2764-2770）：
  - 声明本仓库存在 wiki（入口 `CodeWiki.md`），涉及代码改动的任务收尾必须调用 `codewiki_generate`（scope=auto 即可），learnings/、decisions/ 补文章与索引刷新由流水线完成，不要手工写 `.codewiki/` 下的文章（手改不进流水线、不被面板记录、会被下次编译覆盖）；
  - `codewiki_generate` 是后台编译，调用即返回，不要等待，需要进度时用 `codewiki_progress`；
  - 用模板串插入 `cwd`：入口与 `.codewiki/` 全部内容位于 `${cwd}`，在仓库根之外读写一律用绝对路径；
  - `.codewiki/` 的改动与本次代码改动一起提交；
  - 收尾未调用 `codewiki_generate` 视为任务未完成。

- `commitHintText(cwd, jobs = loadJobs())`（index.js:2737-2762，export 供测试直调）：动态「请提交改动」提醒，唯一真值是 jobs 记录 + git 时间戳，不写任何持久标记。
  - 缓存：模块级 `commitHintCache`（index.js:2736）以 `path.normalize(String(cwd ?? ''))` 为键（index.js:2739），60s TTL 命中即返回（index.js:2736），末尾无论有没有提醒都写缓存（index.js:2760）。
  - 取最近成功编译：`jobs` 里筛 `stage === 'done'`、`writtenCount > 0`、有 `finishedAt`、且 `samePath(j.cwd, cwd)` 的记录（index.js:2745），按 `finishedAt` 字符串倒序取第一条（index.js:2745）。
  - 取提交时刻：`spawnSync('git', ['-C', cwd, 'log', '-1', '--format=%ct', '--', '.codewiki', 'CodeWiki.md'])`（index.js:2747），只覆盖这两个路径，5s 超时。
  - 判定：`jobSec = floor(Date.parse(finishedAt)/1000)`（index.js:2750），当 `jobSec > commitSec` 或 git 没能给出有限时间戳（尚未提交过这两个路径）时提醒（index.js:2751）。
  - 文案（index.js:2751-2756）：「【CodeWiki 编译完成·请提交改动】…（N 分钟前，任务 id，写入 N 篇文章），编译产物尚未提交 git」，并给出操作约束——只 add `.codewiki/` 与 `CodeWiki.md` 两个路径、建议 `docs(wiki)` 前缀、不要 `git add -A`；若已入库则忽略。`mins` 用 `Math.max(1, ...)` 兜底，永不为 0 或负（index.js:2751）。
  - 非 git 仓库、`git` 不在 PATH、jobs 读取失败：整个 try 块吞掉异常，返回空串即不提醒（index.js:2759）。

- `samePath(a, b)`（index.js:2369-2372）：路径归一（`path.normalize` + 去尾部分隔符 + 小写）后比较，Windows 大小写不敏感地定位任务 cwd。

### 系统提示注入

- `installUpdateReminder(ctx, config)`（index.js:2775-2807）：把提醒装进每个 Agent 的 `systemPrompt` 服务。
  - 守卫：`ctx.on` 不是函数就直接返回（index.js:2777）。
  - 幂等：模块内 `WeakSet` 记录已装过的 agent（index.js:2777-2780），同一个 agent 只装一次。
  - 注入点：`agent.ctx?.inject?.(['systemPrompt'], ...)`（index.js:2783），回调里取 `rc2?.systemPrompt ?? rc2`（index.js:2783），缺 `section` 方法则跳过（index.js:2784）。
  - section 声明（index.js:2786-2796）：`name: 'codewiki:update-reminder'`（index.js:2786）；`order` 取 `sp.getSectionOrder('TOOL_REPORT') + 1`，服务没有该方法时回退 2900 + 1（index.js:2786），即紧接工具报告段之后。
  - `text` 回调（index.js:2787-2793）每次组装系统提示都重新求值，因此开关、cwd、入口文件存在性全是实时值，切项目/删 wiki/关开关都无需重启：
    1. `val(config?.updateReminder) === false` → 返回空串（index.js:2789）；
    2. `agent.session?.header?.cwd` 为空、或该目录下没有 `CodeWiki.md` → 返回空串（index.js:2790-2791）；
    3. 否则 `commitHintText(cwd)` 有内容就拼成 `reminderText + 两空行 + hint`，没有就只返回 `reminderText`（index.js:2792-2793）。
  - 存量会话补齐：`ctx.inject(['agents'], ...)` 遍历 `agents.list()` 逐个 install（index.js:2800-2804）——注释说明 cordis 下未声明 inject 的服务属性访问即抛，`typeof` 守卫无效；新会话仍由 `ctx.on('agent/created')` 兜住（index.js:2802）。

### 入口生成与收尾

- `ensureWikiEntry(cwd, language = '中文')`（index.js:188-221）：编译收尾的入口不变量维护者，返回值表示「本次是否新建」。
  - `!cwd` → `false`（index.js:189）；`fs.existsSync(entryPath)` 为真 → `false`，绝不覆盖人工入口（index.js:191）。
  - 语言选择：`/中文|zh/i.test(String(language))`（index.js:193），中文走 index.js:194-205 的模板，否则走英文模板 index.js:207-218。
  - 中文模板内容：`# CodeWiki` 标题、说明活 wiki 由 dsh-codewiki 流水线维护、把 `.codewiki` 的绝对路径写进正文（index.js:197）、列出 `_index.md`/`_architecture.md`/`modules/`/`concepts/` 的分工（index.js:201）、收尾必须跑 `codewiki_generate`（scope=auto）并与代码一起提交（index.js:201），末尾声明「缺失时自动生成，人工改写不被覆盖」（index.js:201）。英文模板是同一结构（index.js:214 为对应的自动生成声明）。
  - 正常结束返回 `true`（index.js:220）。

- `tickIndex(job)`（index.js:1979-2002）：index 阶段的阶段处理器，串起「收尾命令 → 入口补齐 → 终态唤醒」。
  - 仅当 `job.writtenCount > 0` 才执行收尾命令（index.js:104）：`runCw(binary, job.cwd, ['index'], 120000)`（index.js:1984）与 `['meta', 'update']`（index.js:1984），exit code 记账到 note（index.js:104），任一非 0 会提示「编译基线可能未刷新」；index 成功后再做 `_index.md` 链接路径规范化（index.js:104）。
  - 入口补齐被单独 try/catch 包住（index.js:188-192）：`ensureWikiEntry(job.cwd, job.language)` 返回 true 时记 note「仓库根缺 CodeWiki.md 入口，已自动生成（已有入口不覆盖）」（index.js:1992）；抛错只记「入口生成失败（忽略）」（index.js:188），不让编译任务失败。
  - 没有文章写成功时记「跳过 index/meta update」（index.js:1997），仍然推进到 done。
  - 终态：`setStage(job, 'done')`（index.js:2000）、写 `finishedAt`（index.js:2000），成功写盘才 `onSettled?.(job, 'done')`（index.js:1261）触发实时唤醒。

- `wakeCompileSession(job, outcome, agents = agentsRef)`（index.js:1180-1191）：编译终态的 steer 唤醒，与系统提示提醒互为补充。无 `job.sessionId` 或无 agents 服务直接返回（index.js:1180），取不到 agent 或 agent 没有 `steer` 也返回（index.js:1180-1181）。失败文案「【CodeWiki 编译失败】…」（index.js:1180），成功文案「【CodeWiki 编译完成·请提交改动】…检查 .codewiki/ 与 CodeWiki.md 的未提交改动并提交（只 add 这两个路径…不要 git add -A）」（index.js:1180），steer 抛错被吞掉，不影响编译任务本身（index.js:1180-1181）。

- `apply(ctx, config)`（index.js:2809-2868）：装配点。`installUpdateReminder(ctx, config)` 在最后一步调用（index.js:2868），此前已创建并启动 job 服务、注册四个工具、装好本地面板后端（index.js:2809）。

### 相关工具与解析函数

- `cwToolDefinition(cfg)`（index.js:873-936）：`cw` 工具，薄封装 CLI。
- `generateToolDefinition(cfg, svc)`（index.js:2150-2298）：`codewiki_generate` 工具，判态后提交 job。
- `updateToolDefinition(cfg, generateDef)`（index.js:2308-2360）：`codewiki_update`，固定 scope=auto 的日常维护入口；提交成功时补一条「更新已在后台进行…更新完成后系统提示会出现『CodeWiki 编译完成·请提交改动』提醒」（index.js:2308）——它依赖的正是本条的提醒链路。
- `progressToolDefinition(cfg, svc)`（index.js:2379-2461）：`codewiki_progress`，只读查 stage/百分比/篇数。
- `parseStatus(stdout)`（index.js:155-168）：把 `cw status` 输出解析成 `{ state, changedFiles, staleArticles }` 三态。
- `normalizeArticlePath(p)`（index.js:141）：反斜杠转正斜杠。
- `normalizeIndexLinks(cwd)`（index.js:145-153）：只修 `_index.md` 中 `[[link|...]]` 的链接头。
- `liveConfig(config)`（index.js:57-76）：把 Zod 配置快照成普通对象（含并发钳制、默认值兜底）。

## Architecture

```text
apply(ctx)  index.js:2810
  ├─► createJobService(..., wakeCompileSession)  index.js:2814
  │     └─► tickIndex(job)  index.js:1980
  │           ├─► runCw 'index' / 'meta update'  index.js:1984-1985
  │           └─► ensureWikiEntry(job.cwd, job.language)  index.js:1993
  │                 ├─ 入口已存在 → false，不覆盖  index.js:191
  │                 └─ 缺失 → 中文模板(194-205) / 英文模板(207-218)
  │
  ├─► installUpdateReminder(ctx, config)  index.js:2869
  │     ├─► agents.list() 逐个 install  index.js:2801-2805
  │     ├─► ctx.on('agent/created')  install  index.js:2807
  │     └─► sp.section({ name: 'codewiki:update-reminder',
  │                       order: TOOL_REPORT + 1 })  index.js:2785-2787
  │           └─► text() 每次组装系统提示都求值  index.js:2788-2794
  │                 ├─ updateReminder === false → ''   index.js:2789
  │                 ├─ 无 <cwd>/CodeWiki.md → ''      index.js:2791
  │                 ├─ reminderText(cwd)              index.js:2765
  │                 └─ + commitHintText(cwd)          index.js:2738
  │                       └─ git log %ct .codewiki CodeWiki.md  index.js:2748
  │
  └─► 编译终态 steer 唤醒  wakeCompileSession  index.js:1180
        ├─ failed → 【CodeWiki 编译失败】          index.js:1185
        └─ done   → 【CodeWiki 编译完成·请提交改动】index.js:1187
```

## Data Flow

1. **编译收尾**：`codewiki_generate` 提交的 job 推进到 index 阶段，`tickIndex`（index.js:1979）在 `writtenCount > 0` 时执行 `cw index` 与 `cw meta update`（index.js:1979-1980），并规范化 `_index.md` 链接（index.js:1979）。
2. **入口补齐**：同一函数调用 `ensureWikiEntry(job.cwd, job.language)`（index.js:1992）。文件缺失则按语言写模板并返回 true（note「已自动生成（已有入口不覆盖）」）；已存在返回 false；抛错只记 note（index.js:188-192）。
3. **终态通知**：`setStage(job, 'done')` 后（index.js:2000）写 `finishedAt`（index.js:2001），`onSettled` 经 `wakeCompileSession` steer 一条「编译完成·请提交改动」进发起会话（index.js:2001）——这条是实时唤醒，不等系统提示重组。
4. **系统提示求值**：任一会话每次组装系统提示时，`codewiki:update-reminder` section 的 `text` 回调（index.js:2787）先判开关（index.js:2787），再判 `<cwd>/CodeWiki.md` 是否存在（index.js:2787），命中才继续。
5. **提交提醒派生**：`commitHintText(cwd)` 取 jobs 里最近的 done 记录（index.js:2737-2738），用 `git log -1 --format=%ct -- .codewiki CodeWiki.md` 取提交时刻（index.js:2737），`jobSec > commitSec` 才输出提醒（index.js:2737）；结果按 cwd 缓存 60 秒（index.js:2737、2761）。
6. **提醒消失**：把两个路径提交后 `commitSec` 反超 `jobSec`，判定不成立返回空串，section 只剩静态的 `reminderText`；缓存过期后必然重算，无需额外清理动作。

## Connections

- [[core-logic]]：`apply` 装配链（index.js:2809-2868）与 job 服务的阶段机，是本提醒链路的宿主。
- [[article-index-and-meta]]：`cw index` / `cw meta update` 与 `_index.md` 路径规范化（index.js:145）同属收尾动作，提醒指向的产物由它们生成。
- [[compile-pipeline]]：`commitHintText` 读取的 jobs 记录由编译流水线写入，`stage`/`writtenCount`/`finishedAt` 字段即提醒的判定依据。
- [[testing-suite]]：`commitHintText` 与 `ensureWikiEntry` 都是 export 形态，便于测试直调（本次源码清单未包含测试文件，故不在此标注其行号）。

## Known Issues

- **全失败编译不补入口**：`ensureWikiEntry`（index.js:1992）位于 `writtenCount > 0` 分支内（index.js:188）。一篇都没写成功时走 else 记「跳过 index/meta update」（index.js:188），仓库根仍可能没有 `CodeWiki.md`，这类仓库继续收不到提醒——需一次成功写入才会补上。
- **面板/自动调度提交不会被唤醒**：`wakeCompileSession` 只对有 `job.sessionId` 的 job 生效（index.js:1180），而面板与自动更新任务提交时 `sessionId` 为 null（index.js:2075）。这类编译完成后只能靠下次系统提示组装时的 `commitHintText` 兜底。
- **删入口即失去提醒**：门控只看 `CodeWiki.md`（index.js:188），这是有意设计（避免空 `.codewiki/` 骨架骗过检查，index.js:188-190），但副作用是入口被删后 wiki 仍在而提醒立即消失，要等下次编译触发 `ensureWikiEntry` 或人工重建入口。
- **提交提醒最多滞后 60 秒**：`commitHintCache` 的 60s TTL（index.js:2736）意味着刚提交完的一段窗口内仍可能看到「请提交改动」，属预期噪声而非逻辑错误。
- **依赖外部 git**：`commitHintText` 用 `spawnSync('git', ...)`（index.js:2747），`git` 不在 PATH、非 git 仓库、jobs 读取失败都会被 catch 静默成「不提醒」（index.js:2759），失败不可观测——排查「该提醒却没提醒」时要先手工跑同一条 git 命令确认。