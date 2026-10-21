# CodeWiki — @local/dsh-codewiki

> 本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约）。重启 dsh 后可用 `codewiki_generate` 对本仓库做全量编译，把本文细化成 `<repo>/.codewiki/` 文章。

## Overview

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`）接入 DeepSeek Harness：提供 `cw`（CLI 封装）与 `codewiki_generate`（编译入口）两个纯工具，wiki 落在仓库内 `<repo>/.codewiki/`（随仓库提交共享）。**编译完全不走子代理**：`codewiki_generate` 是纯提交制（预构建任务 → 宿主常驻 JobService 即返回），六个环节（规划/写文章/横切/合成/审校/索引收尾，合成仅在横切超预算拆分时出现）全部经阿里云百炼普通入口（`chat/completions`，后台并发池），按 token 预算 28k（qwen3.7-flash ≤32k 输入低价档）分块装填，横切输入超预算自动 map-reduce 拆分（每篇一个观察任务并发，再合成）。文章超批量预算（单文件超观察批预算、分不出多批、或连 200k 大档都装不下）不再升 3 倍价大档、也不走同模型同步兜底，而是转**会话通道**（0.9.0）：完整写作指令写入任务文件，steer 发起会话模型派子智能体逐篇完成，服务每 tick 轮询目标文件收割（frontmatter 校验 + 行号锚点校正）后入账，超时（默认 30 分钟）按失败处理；校对阶段连 200k 大档都装不下同样转会话通道（不再静默跳过校对）。侧边栏面板（hindsight 式）轮询任务进度并支持取消。

## Key Components

- `index.js` — 插件全部逻辑（单文件，Node ESM）
  - `Config`（index.js:36）— schemastery 设置：enabled / binaryPath / maxConcurrency（编译并发上限，1–8）/ articleLanguage / updateReminder / 编译模型两项（batchModel 默认 `qwen3.7-flash`、batchThinkingBudget 默认 0=关思考），全部 `.volatile()`，execute/tick 时热读取（batchApiKey 为存量凭证字段，设置页不再渲染）
  - `installUpdateReminder` — `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库无 `.codewiki/` 返回空）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过
  - `runCw` / `parseStatus` — cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）
  - 模型执行模块 — `estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（文章+旧文上下文+customId；超预算拆观察批，装不下的整任务进 sessionTasks 会话通道）/ `classifySessionTask`（会话通道收割三态：harvest/timeout/wait）/ `startBatchChatRun` + `submitBatchFor` + `settleJob`（阶段执行器：后台并发池提交、收割与终态收尾；keepInMemory 任务 content 进结果不落盘，由服务写盘）/ `runRealtimeTasks`（后台并发池，唯一执行器）/ `resolveBatchApiKey`（凭据库解析链 3s 超时）/ `bailianChat`（同步单轮，全部走百炼普通入口）
  - `createJobService` — 宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调，下限 250ms）推进阶段机 plan→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`（compose 仅当横切输入超 28k 预算：每篇模块文章一个观察任务并发跑，settle 后以观察 pack 提交合成批；总量装得下则单批直出）；文章超预算走会话通道：`dispatchSessionTasks` 写任务文件 + steer 发起会话（会话不可用/写文件失败直接 fail，不降级），`progressSessionTasks` 每 tick 收割（harvest 经 `writeValidated` 落盘入账、timeout 记失败、wait 留待下轮），`resendSessionSteer` 在宿主重启接管后重发一次 steer；校对按「预算−文章 token」动态装填源码，连 200k 大档都装不下转会话通道（校对任务；收割结果按 replace 覆盖同名文章条目，校对失败不推翻已写成功的原文）；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（只剥 apiKey；多实例安全：job 带 owner=创建实例、tick 只推进自家 job，flush 脏标记+mergeFromDisk 磁盘吸收防互相覆盖，tick 进程级 `JOBS_FILE.lock` 串行，cancel 标记每轮 tick 从磁盘跨实例拾取）；submit 占位先行（stage=submitting 挡住凭证窗口内的并发重复提交）；批次未终态保留断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`（0.4.3+ 记 stage/crosscutSplit，resume 按原阶段恢复），下次提交自动续查（resume job）；取消幂等（cancelRequested 跨 tick 存活，取消保留断点可续查）；`writeValidated` 校验 frontmatter 后直接写盘（keepInMemory 任务的唯一写盘点，会话通道收割同用）
  - `cwToolDefinition` — cw CLI 封装工具（子命令白名单）
  - `generateToolDefinition` — 纯提交制：normalizeCwd → 凭证解析（无凭证诚实报错，不回退子代理）→ cw status 判态 → 孤儿断点并入（resume）→ 任务预构建（clean 短路 / stale 逐篇直达 articles / 全量走 plan）→ `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用
  - webServer 端点 — `GET /api/codewiki/jobs`（任务列表，不含 apiKey）与 `POST /api/codewiki/control {action:'cancel',jobId}`，仅回环放行（403）
  - `apply` — `ctx.inject(['tools','webServer','credentials'])` 注册两工具 + 端点；`agent/created` 布提醒
- `vendor/codewiki/` — 上游源码（去 .git）；`bin/cw.exe` — cargo release 产物（git 跟踪）
- `client.js` — 插件页设置卡片 + 侧边栏面板（浏览器半侧）
  - 注册：`__ModuleLoader__.load({id:'@local/dsh-codewiki'})` → `plugins.item`（order 30，设置表单）+ `main`/`sidebar.panellist` 双 slot（key/id='codewiki'，order 52，任务面板）
  - `CodewikiCard` — 快照订阅（revision 变更才覆盖草稿）；表单：运行节（enabled/updateReminder/maxConcurrency/articleLanguage/binaryPath）+ 编译模型节（batchModel/batchThinkingBudget）；保存条 `form.mutate` 单层 op + revision CAS
  - `CodewikiPanel` — 2s 轮询 `GET /api/codewiki/jobs`，任务卡（仓库名/类型/阶段/已写篇数/notes/wiki 路径）+ 六阶段步骤条（各阶段耗时 `stageTimings`）+ 双通道吞吐徽标（实时 tok/s+spark；批量 篇/分+ETA，`batchSubmittedAt` 起算）+ 用量行（`usage` 输入估算/输出实测/超 32k 档红字）+ 活动流与 `error` 渲染 + 加权总进度条 + 复制 wiki 路径，活动任务可取消（POST control）；总览行带 `articleCount`/上次编译相对时间，调度卡带下次扫描倒计时与扫描统计（`lastScanRepos/lastScanSubmitted`）；`PanelIcon` 内联 SVG
- `cordis.patch.yml` — bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂（id `codewiki`）
- `package.json` — `exports["./client"]` + `dsh.client.platform:"web"` 让宿主扫描器沿 file:/// 条目发现客户端模块（改 dsh.client 后需重启）

## Architecture

```text
模型调用 codewiki_generate(cwd, scope)          （纯提交，零 LLM 调用）
        │ 任务预构建（判态/断点续查/分块装填）
        ▼
  JobService.submit ──► {submitted, jobId, stage}  立即返回
        │（宿主后台，tick 10s）
        ▼
  plan ──► articles ──► crosscut ──► review ──► index
  （全部走百炼普通入口 chat/completions：后台并发池→结果落盘/回写；文章/校对超预算转会话通道→会话模型派子智能体写盘→服务轮询收割）
        │
        ▼
  cw index + cw meta update（有成功文章才刷新基线）

侧边栏面板 ──2s 轮询──► GET /api/codewiki/jobs ──取消──► POST /api/codewiki/control
```

## Data Flow

配置流：profile patch `config:` → cordis 注入 apply(ctx, config) → liveConfig 每次调用解包（volatile 热生效）。凭证流：显式 batchApiKey > 宿主凭据库 `resolve('ALIYUN_BAILIAN_API_KEY')`（模型设置「阿里百炼云」渠道）。任务流：execute 预构建（含 token 预算分块）→ jobs.json 持久化 → 服务 tick 消费 → 批次断点（未终态保留，跨会话续查）→ 文章落盘 + 校对回写 → cw index/meta update。面板流：浏览器 2s 轮询 jobs 端点（回环 only）。

## Connections

- [[codewiki-upstream]] — vendor/codewiki（MIT）；布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`（随仓库提交共享）；上游技能正文仅存于 `vendor/codewiki/skills/`，插件不再注册技能
- 阿里云百炼 OpenAI 兼容接口（普通入口）— `qwen3.7-flash` 输入 ≤32k 档 $0.03/M（输入按低价档分块装填），故 BATCH_TOKEN_BUDGET=28000

## Known Issues

- 插件注册不热加载：改 index.js / profile patch 后需重启 dsh（config 值本身热读）。client.js 同理：宿主「非 client 包」判定按 Loader 条目缓存，`dsh.client` 声明新增后需重启 dsh 才会把 client.js 送进浏览器。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `/e/software/deepseek-harness/vendor/schemastery`）；换机器需重建（`node -e "fs.symlinkSync(target,path,'junction')"`）。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，0.2.3 起与 wiki_path() 一致）。
- 上游 stale 文章路径输出为反斜杠（`modules\app.md`），插件消费侧已归一为 `/`。
- 断点文件（未终态保留，跨会话续查）仅记录阶段机位置（stage/crosscutSplit），重跑走普通入口同步请求；0.5.x 批量通道的 24h 批次窗口语义已随 0.6.0 删除。
- 会话通道任务依赖发起会话（`job.sessionId`）可用：面板/自动调度提交的 job 没有会话可 steer，超预算文章/校对任务直接整体失败并明示原因（用户定案，不退超大兜底、不静默跳过校对）；会话通道任务超时默认 30 分钟（`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调），超时按失败处理、不降级百炼。文章阶段与校对阶段共用 `job.sessionTasks`（按 stage 区分文案与 tally 的 replace 语义）；任务文件与 prompt 快照落在 `os.tmpdir()/dsh-codewiki-session-tasks/`，重启接管后重发 steer。
