# CodeWiki — @local/dsh-codewiki

> 本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约）。重启 dsh 后可用 `codewiki_generate` 对本仓库做全量编译，把本文细化成 `<repo>/.codewiki/` 文章。

## Overview

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`）接入 DeepSeek Harness：提供 `cw`（CLI 封装）与 `codewiki_generate`（编译入口）两个纯工具，wiki 落在仓库内 `<repo>/.codewiki/`（随仓库提交共享）。0.4.0 起**编译完全不走子代理**：`codewiki_generate` 是纯提交制（预构建任务 → 宿主常驻 JobService 即返回），六个环节（规划/写文章/横切/合成/审校/索引收尾，合成仅在横切超预算拆分时出现）全部经阿里云百炼批量推理（Batch File，实时价 50%），按 token 预算 28k（qwen3.7-flash ≤32k 输入低价档）分块装填，横切输入超预算自动 map-reduce 拆分（每篇一个观察任务并发，再合成），单文件超预算升 200k 大档（32k–256k 档 3 倍价，批量仍 5 折）重装继续走批量，连大档都装不下才回退实时兑底；提交时明示超 32k 档请求数。侧边栏面板（hindsight 式）轮询任务进度并支持取消。

## Key Components

- `index.js` — 插件全部逻辑（单文件，Node ESM）
  - `Config`（index.js:36）— schemastery 设置：enabled / binaryPath / maxConcurrency（实时兑底并发，1–8）/ articleLanguage / updateReminder / 批量三项（batchApiKey 留空自动取模型设置「阿里百炼云」渠道凭证、batchModel 默认 `qwen3.7-flash`、batchThinkingBudget 默认 0=关思考），全部 `.volatile()`，execute/tick 时热读取
  - `installUpdateReminder` — `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库无 `.codewiki/` 返回空）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过
  - `runCw` / `parseStatus` — cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）
  - 批量推理模块 — `estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（文章+旧文上下文+customId，超预算拆任务）/ `buildBatchJsonl`（enable_thinking+thinking_budget 在 body 顶层）/ `parseBatchResults`（结果+错误文件行合并）/ `settleBatch`（终态收尾；keepInMemory 任务 content 进结果不落盘，由服务写盘）/ `runRealtimeTasks`（实时兑底并发池，结果与批量同构）/ `resolveBatchApiKey`（凭据库解析链 3s 超时）/ `bailianChat`（兑底单轮）
  - `createJobService` — 宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调，下限 250ms）推进阶段机 plan→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`（compose 仅当横切输入超 28k 预算：每篇模块文章一个观察任务并发跑，settle 后以观察 pack 提交合成批；总量装得下则单批直出）；校对按「预算−文章 token」动态装填源码，装不下升大档（200k）重装；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（只剥 apiKey；多实例安全：job 带 owner=创建实例、tick 只推进自家 job，flush 脏标记+mergeFromDisk 磁盘吸收防互相覆盖，tick 进程级 `JOBS_FILE.lock` 串行，cancel 标记每轮 tick 从磁盘跨实例拾取）；submit 占位先行（stage=submitting 挡住凭证窗口内的并发重复提交）；批次未终态保留断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`（0.4.3+ 记 stage/crosscutSplit，resume 按原阶段恢复），下次提交自动续查（resume job）；取消幂等（cancelRequested 跨 tick 存活，取消保留断点可续查）；`writeValidated` 校验 frontmatter 后直接写盘（keepInMemory 任务的唯一写盘点）
  - `cwToolDefinition` — cw CLI 封装工具（子命令白名单）
  - `generateToolDefinition` — 纯提交制：normalizeCwd → 凭证解析（无凭证诚实报错，不回退子代理）→ cw status 判态 → 孤儿断点并入（resume）→ 任务预构建（clean 短路 / stale 逐篇直达 articles / 全量走 plan）→ `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用
  - webServer 端点 — `GET /api/codewiki/jobs`（任务列表，不含 apiKey）与 `POST /api/codewiki/control {action:'cancel',jobId}`，仅回环放行（403）
  - `apply` — `ctx.inject(['tools','webServer','credentials'])` 注册两工具 + 端点；`agent/created` 布提醒
- `vendor/codewiki/` — 上游源码（去 .git）；`bin/cw.exe` — cargo release 产物（git 跟踪）
- `client.js` — 插件页设置卡片 + 侧边栏面板（浏览器半侧）
  - 注册：`__ModuleLoader__.load({id:'@local/dsh-codewiki'})` → `plugins.item`（order 30，设置表单）+ `main`/`sidebar.panellist` 双 slot（key/id='codewiki'，order 52，任务面板）
  - `CodewikiCard` — 快照订阅（revision 变更才覆盖草稿）；表单：运行节（enabled/updateReminder/maxConcurrency/articleLanguage/binaryPath）+ 批量节（batchApiKey/batchModel/batchThinkingBudget）；保存条 `form.mutate` 单层 op + revision CAS
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
  （全部百炼批量推理：JSONL 上传→轮询→结果落盘/回写；超预算单文件实时兑底）
        │
        ▼
  cw index + cw meta update（有成功文章才刷新基线）

侧边栏面板 ──2s 轮询──► GET /api/codewiki/jobs ──取消──► POST /api/codewiki/control
```

## Data Flow

配置流：profile patch `config:` → cordis 注入 apply(ctx, config) → liveConfig 每次调用解包（volatile 热生效）。凭证流：显式 batchApiKey > 宿主凭据库 `resolve('ALIYUN_BAILIAN_API_KEY')`（模型设置「阿里百炼云」渠道）。任务流：execute 预构建（含 token 预算分块）→ jobs.json 持久化 → 服务 tick 消费 → 批次断点（未终态保留，跨会话续查）→ 文章落盘 + 校对回写 → cw index/meta update。面板流：浏览器 2s 轮询 jobs 端点（回环 only）。

## Connections

- [[codewiki-upstream]] — vendor/codewiki（MIT）；布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`（随仓库提交共享）；上游技能正文仅存于 `vendor/codewiki/skills/`，插件不再注册技能
- 阿里云百炼批量推理 — 北京地域独立计费项，实时价 50%；模型须用别名（快照版不支持批量）；`qwen3.7-flash` 输入 ≤32k 档 $0.03/M（批量再 5 折），故 BATCH_TOKEN_BUDGET=28000

## Known Issues

- 插件注册不热加载：改 index.js / profile patch 后需重启 dsh（config 值本身热读）。client.js 同理：宿主「非 client 包」判定按 Loader 条目缓存，`dsh.client` 声明新增后需重启 dsh 才会把 client.js 送进浏览器。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `/e/software/deepseek-harness/vendor/schemastery`）；换机器需重建（`node -e "fs.symlinkSync(target,path,'junction')"`）。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，0.2.3 起与 wiki_path() 一致）。
- 上游 stale 文章路径输出为反斜杠（`modules\app.md`），插件消费侧已归一为 `/`。
- 批量推理仅北京地域、独立计费项、不支持缓存/免费额度；断点最长 24h（百炼批次窗口），过期作废。
