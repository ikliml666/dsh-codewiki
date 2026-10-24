# CodeWiki — @local/dsh-codewiki

> 本文件是插件自身的项目 wiki 入口（CodeWiki.md 公约）。重启 dsh 后可用 `codewiki_generate` 对本仓库做全量编译，把本文细化成 `<repo>/.codewiki/` 文章。

## Overview

把 [mraza007/codewiki](https://github.com/mraza007/codewiki)（Rust CLI `cw`）接入 DeepSeek Harness：提供 `cw`（CLI 封装）与 `codewiki_generate`（编译入口）两个纯工具，wiki 落在仓库内 `<repo>/.codewiki/`（随仓库提交共享）。**编译完全不走子代理、也不委托发起会话的主模型**：`codewiki_generate` 是纯提交制（预构建任务 → 宿主常驻 JobService 即返回），环节为 写文章 → 横切 → 审校 → 索引收尾（0.10.7 删规划阶段，模块清单由 localPlan 按顶层目录本地分组；合成仅在拆分时出现），全部在插件内由编译模型通道完成——0.10.0 起默认走宿主 `llm.stream()` 的 `workbuddy`/`hy3`（免费、192k 上下文，可在设置页改选模型设置里已注册的任意 provider/model，含本地 OpenAI 兼容端点），0.10.1 起这是**唯一通道**（内置百炼直连已删除，provider 留空即提交失败，插件不保存任何密钥）。hy3 192k 适配（0.10.8）：普通单请求输入预算 110k，110k–420k 输入自动升**大档**（默认 `volces-ark`/`glm-5.3-flash` 512k，预算 `bigTokenBudget`=420k）在插件内一次写完；模块源码总量超 420k 才拆观察→合成 map-reduce；只有单文件连大档都装不下才转**会话通道**兜底（完整写作指令写入任务文件，steer 发起会话模型派子智能体逐篇完成，服务每 tick 轮询目标文件收割（frontmatter 校验 + 行号锚点校正）后入账，超时默认 30 分钟按失败处理）。审校阶段为**批量校对**（0.10.8）：逐篇准备文章+源码后按 110k 贪心合并成批量请求，输出按 `@@@article:`/`@@@end` 标记分节拆回逐篇、`writeValidated` 校验后才覆写。请求并发默认 2（硬顶 8）；`serialProjects` 默认开——同一时刻只推进一个仓库的编译任务，后提交的项目进 `queued` 排队，前一个收尾后自动轮到。侧边栏面板（hindsight 式）轮询任务进度并支持取消。

## Key Components

- `index.js` — 插件全部逻辑（单文件，Node ESM）
  - `Config`（index.js:42）— schemastery 设置：enabled / binaryPath / maxConcurrency（编译并发上限，默认 2，1–8）/ serialProjects（单项目串行，默认 true）/ articleLanguage / updateReminder / 编译模型三项（`batchProvider` 默认 `workbuddy`，**0.10.1 起必须是模型设置里已注册的 provider，留空即提交失败**；`batchModel` 默认 `hy3`；`batchReasoningEffort` 默认空=模型默认档，档位取值由 `/api/codewiki/model-efforts` 从模型目录读取）/ `sessionTier`（仅超 420k 大档兜底转会话通道时钉死的子智能体档位 id，留空=自动选路）/ 大档四项（`bigProvider` 默认 `volces-ark`、`bigModel` 默认 `glm-5.3-flash`、`bigReasoningEffort`、`bigTokenBudget` 默认 420k），全部 `.volatile()`，execute/tick 时热读取
  - `buildSessionSteerText`（0.9.2，纯函数）— 会话通道 steer 文本的唯一生成处，`dispatchSessionTasks` 与 `resendSessionSteer` 共用：按 `job.stage==='review'` 切校对措辞、按 `resend` 切重发措辞，`tier` 非空时插入「调用 delegate 必须显式传 tier」（不依赖自动选路）。**存在理由**：编译主链不走档位路由（模型由 batchProvider/batchModel 决定），只有这一段经过 delegate，不给 tier 就会按职责描述交给决策模型自动选路——「写 CodeWiki 模块文章」实测被判 `default`（置信 0.88–0.99），自建档位永远轮不到
  - `installUpdateReminder` — `agent/created` 时注册系统提示 section `codewiki:update-reminder`（TOOL_REPORT+1），text 回调实时求值（`updateReminder=false` 或会话仓库根缺 `CodeWiki.md` 入口时返回空串；门控刻意不看 `.codewiki/` 目录是否存在）；cordis 严格语义：未 inject 的服务属性访问即抛，服务缺失静默跳过
  - `runCw` / `parseStatus` — cw 子进程封装与三态判定解析（missing / uncompiled / clean / stale）
  - 模型执行模块 — `estimateTokens`（CJK≈1/字、ASCII≈3.5 字符/token）/ `collectSources`（源码内联，token 预算装填，超预算返回 oversized）/ `prepareArticleTasks`（文章+旧文上下文+customId；hy3 适配 0.10.8：整模块按大档/128k 硬上限单请求装填，总量超 420k（或逐文件重排后仍多批）拆观察批，单文件连大档都装不下的整任务进 sessionTasks 会话通道）/ `batchProofreadBatchPrompt` + `settleProofread`（0.10.8 批量校对：多篇合并一个请求，输出按 `@@@article:`/`@@@end` 标记拆回逐篇，`writeValidated` 校验后才覆写，缺席/非法保留原文）/ `classifySessionTask`（会话通道收割三态：harvest/timeout/wait）/ `startBatchChatRun` + `submitBatchFor` + `settleJob`（阶段执行器：后台并发池提交、收割与终态收尾；keepInMemory 任务 content 进结果不落盘，由服务写盘）/ `runRealtimeTasks(tasks, { model, reasoningEffort, concurrency, notes, onTaskDone, signal, llm, provider })`（后台并发池，**唯一执行器**；0.10.1 起入参不再有 apiKey/thinkingBudget，内部固定走 `llmChat`）/ `llmChat`（同步单轮，唯一模型通道：宿主 `llm.stream()`，携带 provider/model 路由与可选 `reasoningEffort` 档位，凭证由该 provider 自身配置决定，插件不保存也不传递任何密钥）/ `listModelCatalog`（设置页级联下拉目录：`llm.listProviders()` + 各 provider 的 `listModels`，单 provider 失败只附 error 不拖累整份目录）/ `resolveModelEfforts`（0.10.0：单个 provider/model 的思考档位，走 `llm.resolveModel().reasoning.efforts` + `defaultEffort`，`listModels` 不带这两项故必须单独解析）
  - `createJobService` — 宿主常驻服务：tick（默认 10s，`DSH_CODEWIKI_TICK_MS` 可调，下限 250ms）推进阶段机 queued→articles→crosscut→compose→review→index→收尾 `cw index`+`meta update`（compose 仅当输入超 420k 大档预算：每篇文章一个观察任务并发跑，settle 后以观察 pack 提交合成批；总量装得下则单批直出；旧 `stage='plan'` 任务在 tick 内自动迁移到 articles，升级兼容）；**单项目串行闸门**（`serialProjects` 默认开，0.10.0）：每 tick 先算 `activeId`——已有在推进（非终态且非 queued）的 job 就是它，否则取最早 `queued` 的那个；submit 时若已有别的项目在推进则本任务进 `queued`（首个阶段与 stale 预置任务先存 `pendingStage`/`pendingTasks`，轮到时才落地），排队期间零请求，前一个到终态后由 tick 自动轮到并 note；取消不受闸门限制；文章超预算走会话通道：`dispatchSessionTasks` 写任务文件 + steer 发起会话（会话不可用/写文件失败直接 fail，不降级），`progressSessionTasks` 每 tick 收割（harvest 经 `writeValidated` 落盘入账、timeout 记失败、wait 留待下轮），`resendSessionSteer` 在宿主重启接管后重发一次 steer；审校为批量校对（0.10.8）：逐篇准备（文章+按「预算−文章 token」装填源码）→110k 贪心合并批量请求→`settleProofread` 按标记拆回逐篇覆写（校对失败不推翻已写成功的原文），单篇源码连大档都装不下转会话通道；job 状态持久化 `os.tmpdir()/dsh-codewiki-jobs.json`（只剥 apiKey；多实例安全：job 带 owner=创建实例、tick 只推进自家 job，flush 脏标记+mergeFromDisk 磁盘吸收防互相覆盖，tick 进程级 `JOBS_FILE.lock` 串行，cancel 标记每轮 tick 从磁盘跨实例拾取）；submit 占位先行（stage=submitting 挡住凭证窗口内的并发重复提交）；批次未终态保留断点 `os.tmpdir()/dsh-codewiki-batch-<sha1(cwd)>.json`（0.4.3+ 记 stage/crosscutSplit，resume 按原阶段恢复），下次提交自动续查（resume job）；取消幂等（cancelRequested 跨 tick 存活，取消保留断点可续查）；`writeValidated` 校验 frontmatter 后直接写盘（keepInMemory 任务的唯一写盘点，会话通道收割同用）。无规划阶段（0.10.7 删除：模块清单由 localPlan 本地分组，统一由插件内并发池执行）
  - `cwToolDefinition` — cw CLI 封装工具（子命令白名单）
  - `generateToolDefinition` — 纯提交制：normalizeCwd → 凭证解析（无凭证诚实报错，不回退子代理）→ cw status 判态 → 孤儿断点并入（resume）→ 任务预构建（clean 短路 / stale 逐篇直达 articles / 全量走 plan）→ `submit` 即返回 `{submitted, jobId, stage}`，零 LLM 调用
  - webServer 端点 — 四个精确端点，全部仅回环放行（否则 403）：`GET /api/codewiki/jobs`（任务列表，不含 apiKey）/ `GET /api/codewiki/repos`（仓库总览，逐个现算 `cw status` + 文章数，30s 缓存；0.10.6 起非终态任务的工作区例外放行——编译中的仓库必须可见，缓存签名含在跑任务，新任务出现即失效）/ `GET /api/codewiki/models`（设置页 provider/model 级联目录，30s 缓存）/ `POST /api/codewiki/control {action:'cancel'|'refresh'|'compile', jobId}`
  - `apply` — `ctx.inject(['tools','webServer','credentials'])` 注册两工具 + 端点；`agent/created` 布提醒
- `vendor/codewiki/` — 上游源码（去 .git）；`bin/cw.exe` — cargo release 产物（git 跟踪）
- `client.js` — 插件页设置卡片 + 侧边栏面板（浏览器半侧）
  - 注册：`__ModuleLoader__.load({id:'@local/dsh-codewiki'})` → `plugins.item`（order 30，设置表单）+ `main`/`sidebar.panellist` 双 slot（key/id='codewiki'，order 52，任务面板）
  - `CodewikiCard` — 快照订阅（revision 变更才覆盖草稿）；表单：运行节（enabled/updateReminder/maxConcurrency/serialProjects 单项目串行开关/articleLanguage/binaryPath）+ 编译模型节（batchProvider/batchModel 两级下拉 + `batchReasoningEffort` 思考程度下拉 + sessionTier 兜底档位文本输入）；provider/model 目录来自 `/api/codewiki/models`，思考档位来自 `/api/codewiki/model-efforts`（选中 provider/model 后二次拉取，宿主 `resolveModel().reasoning.efforts`，0.10.0），两者均回环限定 + 60s 缓存，目录不可用时退文本输入；保存条 `form.mutate` 单层 op + revision CAS。0.10.1 删掉「思考预算」输入与 provider 下拉的空值项（不再有内置通道可回退）
  - `CodewikiPanel` — 2s 轮询 `GET /api/codewiki/jobs`，任务卡（仓库名/类型/阶段/已写篇数/notes/wiki 路径）+ 六阶段步骤条（`queued` 在最前，表示排队等待；各阶段耗时 `stageTimings`；0.10.8 起 `lastTimedStage` 过滤 `ACTIVE_STAGES`，旧任务残留 `plan` 键不再导致失败/取消不标红）+ 双通道吞吐徽标（实时 tok/s+spark；批量 篇/分+ETA，`batchSubmittedAt` 起算）+ 用量行（`usage` 输入估算/输出实测/超单请求预算红字）+ 活动流与 `error` 渲染 + 加权总进度条 + 复制 wiki 路径，活动任务可取消（POST control）；总览行带 `articleCount`/上次编译相对时间，调度卡带下次扫描倒计时与扫描统计（`lastScanRepos/lastScanSubmitted`）；`PanelIcon` 内联 SVG
- `cordis.patch.yml` — bundle 形式挂载补丁；本地开发走 profile patch 的 file:/// 直挂（id `codewiki`）
- `package.json` — `exports["./client"]` + `dsh.client.platform:"web"` 让宿主扫描器沿 file:/// 条目发现客户端模块（改 dsh.client 后需重启）

## Architecture

```text
模型调用 codewiki_generate(cwd, scope)          （纯提交，零 LLM 调用）
        │ 任务预构建（判态/断点续查/分块装填；全量走 localPlan 本地分组，stale 逐篇直达）
        ▼
  JobService.submit ──► {submitted, jobId, stage}  立即返回
        │（宿主后台，tick 10s）
        ▼
  queued ──► articles ──► crosscut ──► review ──► index
  （compose 仅在输入超 420k 大档预算的 map-reduce 拆分时出现）
  （queued 仅单项目串行时出现：已有项目在跑则排队，前一个终态后自动轮到）
  （全部走插件内后台并发池：默认 workbuddy/hy3 192k、并发 2；110k–420k 输入升大档（volces-ark/glm-5.3-flash 512k）单请求，模块总量超 420k 拆观察→合成，单文件连大档都装不下才转会话通道兜底→会话模型派子智能体写盘→服务轮询收割）
        │
        ▼
  cw index + cw meta update（有成功文章才刷新基线）

侧边栏面板 ──2s 轮询──► GET /api/codewiki/jobs ──取消──► POST /api/codewiki/control
```

## Data Flow

配置流：profile patch `config:` → cordis 注入 apply(ctx, config) → liveConfig 每次调用解包（volatile 热生效）。凭证流：**插件不保存也不传递任何密钥**（0.10.1 删除内置百炼直连后无例外）——请求经宿主 `llm.stream()`，凭证由所选 provider（默认 workbuddy）在模型设置里的配置解析。任务流：execute 预构建（含 token 预算分块）→ jobs.json 持久化 → 服务 tick 消费（单项目串行时先排队）→ 批次断点（未终态保留，跨会话续查）→ 文章落盘 + 校对回写 → cw index/meta update。面板流：浏览器 2s 轮询 jobs 端点（回环 only）。

## Connections

- [[codewiki-upstream]] — vendor/codewiki（MIT）；布局 `<repo>/.codewiki/{_index,_meta.yaml,modules/,concepts/,decisions/,learnings/}`（随仓库提交共享）；上游技能正文仅存于 `vendor/codewiki/skills/`，插件不再注册技能
- 宿主模型目录（`llm.listProviders` / `llm.listModels` / `llm.resolveModel`）— 0.10.0 起默认编译模型是 `workbuddy`/`hy3`（免费、192k 上下文、单请求输出上限 64k），故 BATCH_TOKEN_BUDGET=110000（输入侧留余量）、BATCH_TOKEN_HARD_LIMIT=128000（超此才转会话通道兜底）。模型与思考档位均由设置页从模型目录读取。也可换成模型设置里已注册的任意 provider/model（本地 OpenAI 兼容端点如 ollama/lmstudio/vllm 亦可），请求走宿主 `llm.stream()`。**0.10.1 起 `batchProvider` 是唯一通道，留空直接提交失败**（内置百炼直连通道已删除，不再有 `chat/completions` 兜底，插件也不再解析任何凭据库）

## Known Issues

- 插件注册不热加载：改 index.js / profile patch 后需重启 dsh（config 值本身热读）。client.js 同理：宿主「非 client 包」判定按 Loader 条目缓存，`dsh.client` 声明新增后需重启 dsh 才会把 client.js 送进浏览器。
- `@deepseek-ai/schemastery` 靠插件本地 junction（→ `/e/software/deepseek-harness/vendor/schemastery`）；换机器需重建（`node -e "fs.symlinkSync(target,path,'junction')"`）。
- 上游 `cw` 无 `--version`；`cw path` 在未 init 的仓库退回插件侧 fallback（`<cwd>/.codewiki`，0.2.3 起与 wiki_path() 一致）。
- 上游 stale 文章路径输出为反斜杠（`modules\app.md`），插件消费侧已归一为 `/`。
- 断点文件（未终态保留，跨会话续查）仅记录阶段机位置（stage/crosscutSplit），重跑走普通入口同步请求；0.5.x 批量通道的 24h 批次窗口语义已随 0.6.0 删除。
- 会话通道任务依赖发起会话（`job.sessionId`）可用：面板/自动调度提交的 job 没有会话可 steer，超预算文章/校对任务直接整体失败并明示原因（用户定案，不退超大兜底、不静默跳过校对）；会话通道任务超时默认 30 分钟（`DSH_CODEWIKI_SESSION_TIMEOUT_MS` 可调），超时按失败处理、不降级。文章阶段与校对阶段共用 `job.sessionTasks`（按 stage 区分文案与 tally 的 replace 语义）；任务文件与 prompt 快照落在 `os.tmpdir()/dsh-codewiki-session-tasks/`，重启接管后重发 steer。
