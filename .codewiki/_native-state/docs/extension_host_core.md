# extension_host_core：宿主侧编译执行编排核心

`extension_host_core` 是 dsh-codewiki 插件（`@local/dsh-codewiki`，见 `package.json`）的宿主侧核心，文件为 `index.js`。它把 `cw`（CodeWiki Rust CLI）与编译流水线接进 DeepSeek Harness（DSH），对外提供四个工具（`cw`、`codewiki_generate`、`codewiki_update`、`codewiki_progress`）、一个常驻编排服务（job 状态机）、一组回环 HTTP 面板端点（`/api/codewiki/*`），以及会话系统提示的 wiki 维护提醒注入。

## 1. 模块定位

```mermaid
flowchart TB
    subgraph HOST["DSH 宿主（cordis）"]
        AGENTS["agents 服务<br/>会话与 steer 唤醒"]
        LLM["llm 服务<br/>provider/model 凭证解析"]
        TOOLS["tools 服务<br/>工具注册"]
        WEB["webServer 服务<br/>回环端点"]
        WS["workspaceRegistry<br/>工作区过滤"]
    end

    subgraph CORE["extension_host_core（index.js）"]
        APPLY["apply(ctx, config)<br/>插件入口"]
        SVC["createJobService<br/>job 状态机 + tick 节拍器"]
        TOOLDEF["工具定义<br/>cw / codewiki_generate /<br/>codewiki_update / codewiki_progress"]
        API["installWebServer<br/>jobs / repos / sessions /<br/>logs / models / control"]
        REM["installUpdateReminder<br/>系统提示 section 注入"]
    end

    AGENTS --> APPLY
    LLM --> APPLY
    TOOLS --> APPLY
    WEB --> APPLY
    WS --> APPLY

    APPLY --> SVC
    APPLY --> TOOLDEF
    APPLY --> API
    APPLY --> REM

    TOOLDEF --> SVC
    API --> SVC
    REM -.->|"产物待提交提醒"| AGENTS
    SVC -.->|"wakeCompileSession<br/>失败/待提交唤醒"| AGENTS
```

该模块处在两条下游通道的上游：
- **原生引擎通道（默认）**：编译任务经 `nativeChannelFor` / `runNativeJob` 交给 Python 引擎，详见 [code_engine_module](code_engine_module.md) 与其下的 [engine_client](engine_client.md)、[python_native_runtime](python_native_runtime.md)、[plan_application](plan_application.md)、[quality_gates](quality_gates.md)。
- **内置 Node 兼容通道**：`nativeEngine=false` 时走插件内流水线（articles → crosscut → review → index → commit）。

## 2. 对外接口面

### 2.1 工具注册（`apply`）

`apply(ctx, config)` 是插件入口，通过 cordis 的 `ctx.inject` 取到 `agents`、`llm`、`tools`、`webServer`、`workspaceRegistry` 等服务后：

1. `createJobService(config, wakeCompileSession)` 创建并启动常驻服务（`service.start()` 起 10s 节拍定时器，`ctx.effect` 注册停止钩子）。
2. 构造四个工具定义并经 `tools.register` 注册，单工具注册失败不影响其余工具。
3. `installWebServer` 注册回环端点，`installUpdateReminder` 注入会话提示。
4. 启动自动更新调度器 `autoScan`（60s 心跳，按 `autoUpdateMin` 间隔对已知仓库做 scope=auto 判态）。

### 2.2 四个工具

| 工具 | 入口 | 职责 |
| --- | --- | --- |
| `cw` | `cwToolDefinition` | 薄封装 CLI：`init/status/index/meta/path/projects/setup/uninstall`，120s 超时，超时发 SIGKILL |
| `codewiki_generate` | `generateToolDefinition` | 提交制编译：`cw status` 判三态（missing/uncompiled/clean/stale）→ 提交 job 立即返回，不等编译 |
| `codewiki_update` | `updateToolDefinition` | 固定 scope=auto 的快捷入口，引导模型「提交即收尾、不要轮询」 |
| `codewiki_progress` | `progressToolDefinition` | 只读查进度：按 `cwd` 或 `jobId` 过滤，数据与面板同源（`jobSummary` + `progressView`） |

`codewiki_generate` 的判态逻辑（`parseStatus` 解析 `cw status` 输出）：

```mermaid
flowchart TD
    START["cw status 输出"] --> MISS{"包含<br/>No wiki found?"}
    MISS -->|是| MS["state=missing"]
    MISS -->|否| UNC{"has not been<br/>compiled yet?"}
    UNC -->|是| UCS["state=uncompiled"]
    UNC -->|否| CLN{"Wiki is up to date?"}
    CLN -->|是| CLS["state=clean"]
    CLN -->|否| STL["state=stale<br/>逐行解析 M 变更 / ! 过期文章"]
    MS --> FULL
    UCS --> FULL
    FULL["提交 kind=full 任务<br/>（必要时先 cw init）"]
    CLS --> RPT["直接报告无需编译"]
    STL --> NATIVE{"nativeChannelFor<br/>接管增量?"}
    NATIVE -->|是| NS["提交 kind=stale 任务<br/>引擎自决议 update/full/no_change"]
    NATIVE -->|否| LEG["兼容通道：collectChangeSet<br/>+ 文件级归属判定"]
    LEG --> ATT{"有变更归属<br/>到文章 source_files?"}
    ATT -->|有| SUB["预构建 stale 任务并提交"]
    ATT -->|无归属| BLK["记录 blocker，不推进基线"]
```

关键点：cw status 的三态判定不区分已提交与工作区未提交变更；因此原生通道即使收到 `clean` 也照常接管，把「四路变更采集 + 增量决议」的权力完全交给引擎（见 [change_set_management](change_set_management.md) 与 [engine_client](engine_client.md)）。

### 2.3 回环 HTTP 端点（`installWebServer`）

所有端点由 `isLoopbackRequest` 守卫（仅 127.0.0.1 / ::1），供侧边栏面板（[vscode_extension_client](vscode_extension_client.md)）轮询：

| 端点 | 数据来源 |
| --- | --- |
| `GET /api/codewiki/jobs` | `service.list()`（即 `jobSummary` 逐个映射），按 `workspaceOnly`、`isDeadCompileTarget` 过滤，queued 任务附 `queueAhead`「在等谁」 |
| `GET /api/codewiki/repos` | 已知仓库清单 + job 历史的 wiki 状态总览（30s 缓存）；`lastJob` 由 `pickOverviewJob` 从该仓全部候选任务中选取 |
| `GET /api/codewiki/sessions` | LLM 请求会话记录（`listSessionRecords` / `listAllSessionRecords` / `activeSessionJobs`） |
| `GET /api/codewiki/sessions/item` | 单条会话全文（prompt/output） |
| `GET /api/codewiki/logs` | 引擎事件 NDJSON 日志（`readLogTail` / `logStats`） |
| `GET /api/codewiki/models`、`/api/codewiki/model-efforts` | 模型目录（`listModelCatalog` / `resolveModelEfforts`，30s/60s 缓存） |
| `POST /api/codewiki/control` | `{action:"cancel"|"compile"|"refresh"}` |

`GET /api/codewiki/repos` 的仓库归并与「代表任务」选取：展示路径按 `normKey` 归一（同一仓库的多种写法只保留先出现的展示形态——job 历史优先，`loadKnownRepos()` 补缺），每个展示 cwd 把该仓**全部**候选任务累积进 `jobsByCwd`，再交给 `pickOverviewJob` 选出一条 `lastJob`：**优先非终态任务**（正在排队/编译的那条），全是终态时按 `updatedAt`（缺失则退化到 `finishedAt` / `createdAt`）取最新一条。`knownRepos` 只补登记仓库、不贡献候选任务（`putCwd(dir, undefined)`）。旧实现每个 cwd 只保留「先到的那条任务 + 首个非空兜底」，同仓挂着多条历史记录时面板可能显示陈旧任务而不是正在编译的那条。

## 3. 编译任务状态机（`createJobService`）

这是本模块的核心运行时。服务以 `TICK_MS`（默认 10s）节拍调用 `tick()`，对每条 job 推进一步；执行器（LLM 并发池 / 原生引擎）是长任务，结果以 `batchResults` / `nativeResults` Map 暂存，由下一轮 tick 收割，tick 永不阻塞。

### 3.1 阶段机

```mermaid
stateDiagram-v2
    [*] --> submitting: "submit 占位（凭证校验）"
    submitting --> queued: "项目闸门满（排队）"
    submitting --> articles: "闸门有空位"
    queued --> articles: "轮到本项目"
    articles --> crosscut: "兼容通道 full 路径"
    articles --> review: "stale/原生映射"
    crosscut --> review
    review --> index
    index --> commit: "autoCommit 开启且有产物"
    index --> done: "无产物或 autoCommit 关闭"
    commit --> done: "finishJob"
    articles --> failed
    articles --> partial: "judgeOutcome 完整性未成立"
    review --> failed
    review --> partial
    index --> failed
    index --> partial
    done --> [*]
    partial --> [*]
    failed --> [*]
    cancelled --> [*]
```

阶段处理器挂在 `STAGE_HANDLER`：

| 处理器 | 职责 |
| --- | --- |
| `tickArticles` | 兼容通道的写文章阶段：本地规划（`localPlan` 顶层目录分组）→ `markBigAgenticTasks` 打大档标记 → `startAgenticRun` 执行；收割走 `settleJob` / `progressSessionTasks` |
| `tickCrosscut` | 组装 `_architecture.md` / `_patterns.md` / 概念文章（`packArticles` 装填全文，超预算换大档模型），`keepInMemory=true` 不落盘 |
| `tickReview` | 本地核对（`localReview`）+ 批量校对（`batchProofreadBatchPrompt`，按预算贪心合并成 `@@@article/@@@end` 分节输出，`settleProofread` 拆回逐篇） |
| `tickIndex` | 存量文章体检（`auditExistingArticles`）→ 完整性判定（`judgeOutcome`）→ 孤儿文章清理（`pruneOrphanModules`）→ `cw index` → 完整性成立才 `cw meta update` 推进基线 → `ensureWikiEntry` → `saveRecord` |
| `tickCommit` | `autoCommitWiki` 提交产物（主题分支提交后合并回原分支），随后 `finishJob` 置终态 |

**原生通道的分支**：job 一旦在 `articles` 起始时被 `nativeChannelFor` 锁定为 `channel='native'`，之后所有 tick 都只走 `tickNative`——绝不落入 `STAGE_HANDLER` 的同名 handler，避免两套实现重复写同一批产物。

**已退役的阶段**：`compose`（「拆观察批 → 合成」路径的合成阶段）已随观察→合成分割通道在 0.17.5 删除，本模块不再有该阶段——横切只做「单批直出」：`packArticles` 保证装得下（超预算的文章只截头部并标注），总量超普通预算就把任务标成大档换大上下文模型。因此 `codewiki_progress` 的 `stage` 取值与本节阶段机图一致：`articles`/`crosscut`/`review`/`index`/`commit` 加终态 `done`/`partial`/`failed`/`cancelled`，不会出现 `compose`。

### 3.2 双执行器与收割约定

```mermaid
flowchart LR
    subgraph TICK["tick 每轮"]
        A["syncCancelFlags<br/>拾取跨实例取消标记"]
        B["项目闸门<br/>parallelLimit 排队"]
        C["孤儿接管<br/>adoptOrphan"]
        D["分支：native or STAGE_HANDLER"]
        E["flush()<br/>脏 job 合并落盘"]
    end

    subgraph EXEC["执行器（不阻塞 tick）"]
        NR["startAgenticRun /<br/>startBatchChatRun<br/>LLM 双池并发"]
        NN["startNativeRun<br/>runNativeJob 长任务"]
    end

    subgraph HARVEST["收割（下一轮 tick）"]
        SR["settleJob<br/>→ batchResults.delete<br/>→ tally"]
        SN["tickNative<br/>→ nativeResults.delete<br/>→ finishJob"]
    end

    A --> B --> C --> D
    D -->|"启动"| NR
    D -->|"启动"| NN
    NR -->|"结果写入"| BR[("batchResults<br/>jobId → results | null")]
    NN -->|"结果写入"| NRM[("nativeResults<br/>jobId → EngineResult | null")]
    BR --> SR
    NRM --> SN
    SR --> E
    SN --> E
```

- 约定：执行器整体失败时写入 `null`（已自行 `fail()`）；收割方只看「Map 里有没有结果」，不猜执行器死活。
- `settleJob` 还承担宿主重启恢复：执行器随连接消失时，按 `job.tasks` 持久化的 `batchPrompt` 快照（或 `agentic:true` 任务的 mission）整批重跑当前阶段。
- 取消（`cancelRequested`）：tick 开头识别 → abort 在飞请求（`batchAborters` / `nativeAborters`）→ 置 `cancelled` 终态、`canAdvanceBaseline=false`；若取消到达时原生结果已落地，则按真实结果收割而非丢弃产物。

### 3.3 多实例并存的持久化协议

```mermaid
flowchart TB
    subgraph STORE["jobsStore（job-store.js）"]
        LOCK["acquireTickLock / releaseTickLock<br/>tick 串行化"]
        MERGE["mergeJobLists<br/>mine + disk 智能合并"]
        HB["heartbeat / lastSeenAt<br/>实例活性"]
        ADOPT["adoptOrphan / planForeignJob<br/>停更任务接管或作废"]
    end

    JOBS[("JOBS_FILE<br/>%TEMP%/dsh-codewiki-jobs.json")]
    REPOS[("REPOS_FILE<br/>dsh-codewiki-repos.json<br/>已知仓库登记")]

    TICK1["实例 A tick"] --> LOCK
    LOCK -->|"拿不到锁"| TICK1
    LOCK -->|"拿到锁"| MERGE
    MERGE --> JOBS
    MERGE --> HB
    HB --> ADOPT
    ADOPT -->|"超过 ORPHAN_TAKEOVER_MS（默认 5min）"| RECLAIM["本实例接管推进"]
    ADOPT -->|"queued 且无执行器"| VOID["作废（非失败、不唤醒会话）"]
    MERGE -.->|"dirtyIds 保护"| FLUSH["flush：脏 job 本地优先<br/>合并回磁盘"]
    FLUSH --> JOBS
```

关键不变量：
- 只有状态变更过的 job 才整写（`dirty` + `dirtyIds`），无事可做的旧实例不会用过期快照覆盖活动 job。
- `submit` 幂等：`findActiveJob` 按归一化路径 key 判重，同仓库并发提交直接返回现有任务。
- 项目闸门：默认 `serialProjects=true`（parallelLimit=1），忙碌项目占满时新任务进 `queued`，排队期间不占执行机器。

## 4. 编译产物的入库与唤醒

### 4.1 `autoCommitWiki`（自动提交）

把「等编译完成 → 提交 .codewiki/」从会话模型手里收回插件侧：

```mermaid
flowchart TD
    START["autoCommitWiki(cwd)"] --> G1{"不是 git 仓库 /<br/>无 HEAD / 合并进行中?"}
    G1 -->|是| R["返回 committed:false + reason"]
    G1 -->|否| G2{"目标路径有未解决冲突 /<br/>被 .gitignore / 未配置 user?"}
    G2 -->|是| R
    G2 -->|否| G3{"status --porcelain<br/>-- .codewiki CodeWiki.md?"}
    G3 -->|"无改动"| NC["返回 noChanges=true"]
    G3 -->|"有改动"| BR{"detached HEAD<br/>或建分支失败?"}
    BR -->|否| T["切主题分支 codewiki/wiki-<jobId><br/>git add -- .codewiki CodeWiki.md<br/>git commit --no-verify"]
    BR -->|是| D["降级直接提交 mode=direct"]
    T --> M["merge 回原分支（ff）"]
    M -->|成功| DEL["branch -d 删主题分支 → committed:true"]
    M -->|失败| ABORT["merge --abort<br/>保留主题分支，committed:false"]
    D --> DEL
```

安全边界：只认 `WIKI_PATHS = ['.codewiki', 'CodeWiki.md']` 两个 pathspec，绝不 `-A`；不 amend、不 push、不改写历史。

### 4.2 会话唤醒（`wakeCompileSession` / `commitHintText`）

```mermaid
flowchart LR
    JOB["job 终态"] --> AC["autoCommitState(job)"]
    AC -->|"committed / no-changes"| SILENT["完全静默"]
    AC -->|"pending"| W{"outcome?"}
    W -->|failed| FAIL["steer：编译失败提醒"]
    W -->|"成功但提交失败"| PEND["steer：产物待提交提醒"]
    W -->|done| SILENT
    HINT["commitHintText<br/>系统提示 section 每次求值"] -->|"60s 缓存"| H2["仅当 done/partial 且<br/>产物提交时间 < 编译完成时间"]
    H2 --> TXT["追加【产物待提交·一次性】<br/>提醒到 reminderText"]
```

`installUpdateReminder` 在每个 agent 的 `systemPrompt` 注册 `codewiki:update-reminder` section：仅当会话仓库根存在 `CodeWiki.md` 入口时才出现维护提醒，开关关闭/项目切换/删除 wiki 无需重启即生效。

## 5. 输入装填、契约闸门与锚点修正

兼容通道的质量防线集中在本模块（原生通道对应能力在 [quality_gates](quality_gates.md)）：

```mermaid
flowchart TD
    SRC["源码文件"] --> CN["collectSources<br/>按 110k token 预算整文件装填"]
    CN -->|"超预算"| BIG["换大档模型重装<br/>bigTokenBudget=420k"]
    BIG -->|"仍装不下"| SESS["dispatchSessionTasks<br/>转会话通道兜底"]
    CN --> P["batchPrompt<br/>numberLines 加行号前缀"]

    P --> POOL["runRealtimeTasks 双池并发<br/>默认档 / 大档 各自限流"]
    POOL --> RES["llmChat 返回 content"]
    RES --> ENV["validateArticleEnvelope<br/>frontmatter 开闭合校验"]
    ENV -->|失败| SKIP["不落盘，note 记账"]
    ENV -->|通过| CC["contractCheck<br/>inspectArticle 契约闸门"]
    CC -->|"blocking"| SKIP
    CC -->|过| FA["fixAnchors 行号锚点修正"]
    FA --> FMD["repairUnclosedFrontmatter"]
    FA --> CL["fixChangelogAnchors<br/>版本节首 + 相对偏移重定位"]
    FA --> SYM["符号就近绑定<br/>locate 唯一声明行"]
    SYM --> W["fs.writeFileSync 落盘"]
```

要点：
- `estimateTokens` 粗算（CJK ≈ 1 token/字，ASCII ≈ 3.5 字符/token），只为装填预算服务。
- `allowedLinkTargets`（现存 wiki 文章 + 本轮计划产出）供契约闸门校验内部死链。
- `applyTaskResult` 统一落盘点：`keepInMemory` 任务（横切/校对）只回内存，`writeValidated` 是它们唯一的写盘点。
- `symbolsOnLine` / `fixAnchors` 的符号提取规则与仓库测试 `test-wiki-anchors.mjs` 同源（修正器与校验器共用一套归属语义，否则会振荡）。

## 6. 依赖关系

```mermaid
flowchart LR
    subgraph CORE["extension_host_core"]
        IDX["index.js"]
    end

    IDX --> AGT["runAgenticArticles /<br/>markBigAgenticTasks"]
    IDX --> EDIT["buildOpeningPrompt /<br/>edit 工具循环"]
    IDX --> CS["collectChangeSet<br/>四路变更采集"]
    IDX --> UR["judgeOutcome / buildUpdateRecord /<br/>saveUpdateRecord / isTerminalStage"]
    IDX --> AC["inspectArticle /<br/>hasBlockingIssue"]
    IDX --> NR["runNativeJob /<br/>DEFAULT_ENGINE_ENTRY"]
    IDX --> JS["createJobsStore /<br/>mergeJobLists / adoptOrphan /<br/>snapshotNativeRun / planNativeReplay"]
    IDX --> JL["appendLog / readLogTail /<br/>logStats / logFileOf"]
    IDX --> GP["withQuotepathOff"]

    AGT -.->|"agent_runtime 文档"| AGR["../agent_runtime.md"]
    EDIT -.->|"agentic_edit_capability"| AEC["../agentic_edit_capability.md"]
    CS -.->|"change_set_management"| CSM["../change_set_management.md"]
    UR -.->|"update_status_tracking"| URT["../../State___Observability_Management/update_status_tracking.md"]
    AC -.->|"article_validation"| AV["../../Code_Engine_Processing_Pipeline/article_validation.md"]
    NR -.->|"python_native_runtime /<br/>engine_client"| NRT["../../Code_Engine_Processing_Pipeline/code_engine_module/python_native_runtime.md"]
    JS -.->|"job_state_storage"| JSS["../../State___Observability_Management/job_state_storage.md"]
    JL -.->|"job_log_management"| JLM["../../State___Observability_Management/job_log_management.md"]
```

依赖清单（全部位于父模块 `Extension_Host_Execution_Orchestration` 与其平级模块下）：

| 依赖 | 用途 |
| --- | --- |
| [agent_runtime](agent_runtime.md)（`lib/articles-agentic.js`） | agentic 写作执行器 `runAgenticArticles`、大档标记 `markBigAgenticTasks` |
| [agentic_edit_capability](agentic_edit_capability.md)（`lib/agentic.js`） | agentic 工具循环的 prompt 构造与 `edit` 能力 |
| [change_set_management](change_set_management.md)（`lib/change-set.js`） | 基线..HEAD + 工作区四路变更采集 |
| [update_status_tracking](update_status_tracking.md) | `judgeOutcome` 完整性判定、终态集合 `TERMINAL`、update-record 落盘 |
| [article_validation](article_validation.md) | `inspectArticle` 文章契约闸门（blocking/warnings） |
| [native_runtime_support](native_runtime_support.md) / [python_native_runtime](python_native_runtime.md) | `runNativeJob` 子进程驱动与 Python 引擎入口 |
| [job_state_storage](job_state_storage.md) | jobs 持久化、幂等合并、孤儿接管、tick 锁 |
| [job_log_management](job_log_management.md) | 引擎事件 NDJSON 日志的追加与翻页 |
| [job_log_management](job_log_management.md)（`lib/git-paths.js`） | `withQuotepathOff` 关闭 git 中文路径八进制转义 |

上游消费方：面板前端 [vscode_extension_client](vscode_extension_client.md) 通过 `/api/codewiki/*` 端点读取 `jobSummary` / repos / sessions / logs 渲染侧边栏。

## 7. 配置面（`Config` + `liveConfig`）

配置 schema 由 `@deepseek-ai/schemastery` 定义（`package.json` 唯一运行依赖），全部标 `volatile`（改设置无需重启插件）。`liveConfig(config)` 在每轮使用前把 volatile 值收口成内部运行参数，关键收口规则：

| 配置键 | 默认 | 收口逻辑 |
| --- | --- | --- |
| `batchProvider` / `batchModel` | `volces-ark` / `glm-5.3-flash` | 编译唯一模型通道；空则提交报错 |
| `bigEnabled` | `true` | 关闭时 `liveConfig` 直接清空 `bigProvider`（下游五六处换模型判定不再逐处判断），模型 id 与预算保留以便重开 |
| `maxConcurrency` / `bigConcurrency` / `moduleConcurrency` | 2 / 0 / 0 | 硬顶 8；`bigConcurrency=0` 跟随默认档；`moduleConcurrency` 控制引擎同层模块并行度（0 跟随默认档） |
| `requestLimit` | 100 | 单模块写作请求上限，透传给原生引擎（`runNativeJob` → 请求行 `requestLimit`）；原生入口非正值/未下发时退回引擎侧默认 300 而非上游的 100，硬顶 1000；大模块撞满会抛错把整轮判成 `partial` |
| `serialProjects` / `parallelProjects` | true / 2 | 派生 `parallelLimit`（串行=1，关闭后上限 4） |
| `nativeEngine` | `true`（0.16.0 起） | 原生通道开关；关闭后内置 Node 流水线为兼容通道 |
| `nativeEnginePython` | `''` | 解析顺序：配置 → `DSH_CODEWIKI_PYTHON` 环境变量 → `python`（不做「找一个能用的」启发式） |
| `autoCommit` / `autoUpdate` | true / false | 产物自动入库 / 定时增量扫描（间隔 `autoUpdateMin`，最小 5 分钟） |
| `workspaceOnly` | `true` | 任务页只显示宿主工作区内的仓库 |

bundle 装配见 `cordis.patch.yml`（插件 id `codewiki`，配置命名空间 `codewiki`，同 id 覆盖条目为整对象替换）。

## 8. 关键运行时数据与生命周期

| 数据 | 位置 | 生命周期 |
| --- | --- | --- |
| `JOBS_FILE` | `%TEMP%/dsh-codewiki-jobs.json`（测试用 `DSH_CODEWIKI_JOBS_FILE` 隔离） | 最多保留 `MAX_JOBS_KEPT=30` 条；启动时清理 Temp 终态与「死编译对象」（worktree / 空壳目录）任务 |
| `REPOS_FILE` | 由 `reposFileFor(JOBS_FILE)` 派生（`-jobs` → `-repos`） | 提交过即永久登记，`forgetRepo` 反登记 |
| 会话记录 | `<tmp>/dsh-codewiki-sessions/<jobId>/`（meta + full 对） | 保留 24h，每 10 分钟剪枝 |
| 会话通道任务文件 | `<tmp>/dsh-codewiki-session-tasks/` | 兜底超预算文章；30 分钟超时按失败 |
| 原生记录 / 原始产物 | `dsh-codewiki-native-records` / `dsh-codewiki-native-raw` | 仓库外，避免污染 git 状态；工作副本随 `.finally()` 清理，原始树留档保留 |
| `worktreeCache` / `sourceProbeCache` | 进程内 Map | 60s / 10min（空判定仅 1min）TTL，避免 2s 轮询打爆 git |

## 9. 从提交到终态的完整数据流

```mermaid
sequenceDiagram
    participant U as 会话模型 / 面板
    participant T as codewiki_generate 工具
    participant S as jobService tick
    participant E as 执行器（agentic/native）
    participant CW as cw CLI
    participant GIT as 仓库 git

    U->>T: "cwd + scope=auto"
    T->>CW: "cw status"
    CW-->>T: "三态 + 变更清单"
    T->>T: "闸门：排除清单 / worktree /<br/>空壳目录 / findActiveJob 幂等"
    T->>S: "submit(kind, scope)"
    S-->>T: "jobId + stage（立即返回）"
    T-->>U: "提交回执：本步收尾，不要等待"

    loop 每 10s tick
        S->>S: "mergeFromDisk + syncCancelFlags"
        alt 原生通道
            S->>E: "startNativeRun（runNativeJob）"
            E-->>S: "onProgress 进度帧 + 引擎事件日志"
            E-->>S: "nativeResults = EngineResult"
            S->>S: "收割：judged / blockers / usage /<br/>saveRecord(仓库外)"
        else 兼容通道
            S->>E: "startAgenticRun（LLM 双池）"
            E-->>S: "batchResults（契约闸门 + 锚点修正）"
            S->>S: "tally → tickCrosscut → tickReview<br/>→ tickIndex（cw index + meta）"
        end
    end

    S->>GIT: "autoCommitWiki（主题分支 → 合并）"
    S->>S: "finishJob(done/partial/failed)"
    alt 自动提交未成功
        S-->>U: "wakeCompileSession：产物待提交"
    end
```

## 10. 设计要点小结

1. **提交制**：工具调用只做判态与提交，编译全程在插件内后台推进；会话模型不等待、不轮询、不跑 git——这是它与旧式「同步编译工具」的根本区别。
2. **双通道并存、互不回退**：原生通道（默认）环境不闭合时以 `engine-deps` 明确失败，绝不悄悄降级 Node 通道冒充成功；通道一旦锁定跟随 job 走。
3. **三态终态**：`done`（完整成功）/ `partial`（部分完成、基线不推进）/ `failed`（无成果）+ `cancelled`；基线只代表「所有变化已被消化」，任何 blocker 都不得前移。
4. **多实例安全**：tick 锁、脏 job 合并、心跳超时接管、跨实例取消拾取——插件重载或宿主重启不会双提交、不会丢现场。
5. **可观测性**：jobSummary（面板与 progress 同源）、引擎 NDJSON 日志、LLM 请求会话记录、update-record 仓库外记账，四条观测链各自独立。
