# CodeWiki 浏览器侧 UI 面板（browser_ui_panel）

## 简介

`browser_ui_panel` 是插件 `@local/dsh-codewiki`（见 [package.json](../repo/package.json)）的**客户端半侧**，全部代码位于单个文件 `client.js`，运行在 DeepSeek Harness（dsh）客户端进程的浏览器渲染层。它本身不执行任何编译逻辑，只做三件事：

1. **设置表单**——在宿主「插件」页（`plugins.item` slot）渲染 CodeWiki 设置卡片，经宿主 Config 服务的 `codewiki` 命名空间热读写编译流水线的全部参数；
2. **进度面板**——在侧边栏（`main` + `sidebar.panellist` slot）渲染编译任务面板，以 2 秒轮询展示流水线进度、吞吐、引擎日志，并可取消任务；
3. **仓库总览与会话记录**——面板内三个 Tab（总览 / 任务 / 会话）+ 设置 Tab，覆盖仓库 wiki 状态总览、自动更新调度、LLM 请求记录查看。

所有数据来自宿主半侧 webServer 端点 `GET /api/codewiki/jobs`、`POST /api/codewiki/control`（仅回环）等，由后端编排模块提供——见 [main_orchestrator](main_orchestrator.md)。本模块是纯展示与控制端，不直接触碰文件系统、LLM 或 git。

---

## 架构总览

```mermaid
flowchart TB
    subgraph HOST["dsh 客户端宿主（浏览器渲染层）"]
        SLOTS["宿主 slots 容器<br/>plugins.item / main / sidebar.panellist"]
        SERVICES["注入的宿主服务<br/>slots · locale · configForms"]
        CFG["宿主 Config 服务<br/>codewiki 命名空间（revision 乐观并发）"]
    end

    subgraph CLIENT["browser_ui_panel（client.js）"]
        direction TB
        REG["模块装载器注册<br/>__ModuleLoader__.load id=@local/dsh-codewiki"]
        CARD["CodewikiCard<br/>设置卡片（插件页）"]
        PANEL["CodewikiPanel<br/>侧边栏面板（四 Tab）"]
        PICON["PanelIcon<br/>面板入口图标"]
        HELPERS["辅助层<br/>zh() / en() 词典 · apiGet / apiPost<br/>stageBar · Spark · fmtMs 等"]
    end

    subgraph SERVER["宿主半侧 webServer（回环 API）"]
        EP["/api/codewiki/jobs · /control<br/>/repos · /sessions · /sessions/item<br/>/models · /model-efforts"]
    end

    REG --> SERVICES
    SERVICES --> SLOTS
    SERVICES --> CFG
    SLOTS --> CARD
    SLOTS --> PANEL
    SLOTS --> PICON
    CARD -.快照/订阅/mutate.-> CFG
    PANEL --> HELPERS
    CARD --> HELPERS
    HELPERS -- 轮询/POST --> EP
```

关键点：

- **两个挂载点**（文件头注释明确）：插件页 `plugins.item`（id = `codewiki`，与 profile patch 条目一致，见 [cordis.patch.yml](../repo/cordis.patch.yml)）与侧边栏面板 `main`（key = `codewiki`）+ `sidebar.panellist`（同 id，order = 52，排在 dsh-hindsight-on-demand 之后）。
- **注册 id 校验**：`window.__ModuleLoader__.load` 的 `id` 必须等于 `package.json` 的 `name`（`@local/dsh-codewiki`），client-modules 按 nearestPackage 的 name 校验注册者。
- **词典值必须是字符串**：`zh()` / `en()` 返回纯字符串词典，挂在 locale 命名空间 `codewiki` 下（词典值若为函数，`t()` 会回退返回键名）。
- **样式去重**：注入的 `<style>` 以 `data-plugin="@local/dsh-codewiki"` 标记，HMR 或重复加载时不堆叠重复样式表。

---

## 组件清单与职责

| 组件 | 挂载位置 | 职责 |
|---|---|---|
| `CodewikiCard` | `plugins.item` | 设置表单：`view='summary'` 一行简介，`view='page'` 完整配置页 |
| `CodewikiPanel` | `main` | 侧边栏面板主体：四个 Tab（总览/任务/会话/设置），任务轮询与渲染 |
| `PanelIcon` | `sidebar.panellist` | 摊开书本造型 SVG 图标，面板出入口 |
| `ReposTab` | Panel 内「总览」Tab | 全部已编译仓库的 wiki 状态、自动调度摘要、排除/立即编译操作 |
| `SessionView` | Panel 内「会话」Tab 或任务行按钮 | LLM 请求记录列表与单条 prompt/输出全文查看 |
| `Spark` | 任务卡徽标内 | 纯 SVG 微趋势线（tps 滚动窗口） |
| `mount` | `apply()` 内 | 插件页挂载，经 `configForms.whileServed([NS], …)` 门控：宿主服务该命名空间期间才显形 |
| `save` / `discard` | CodewikiCard 内 | 保存草稿（diff 成 ops，带 revision）/ 放弃更改回读快照 |
| `zh` / `en` | 模块顶层 | 中/英 i18n 词典工厂 |
| `byUpdated` | CodewikiPanel 内 | 按 `updatedAt` 排序任务，选出焦点任务 |
| `line`（日志行渲染） | `engineLogBlock` 内 | 把引擎日志条目格式化成等宽单行 |

### CodewikiPanel 内部结构

```mermaid
flowchart TB
    PANEL["CodewikiPanel"]
    TABS["Tab 条：总览 / 任务 / 会话 / 设置"]
    PANEL --> TABS
    TABS -->|overview| RT["ReposTab<br/>轮询 /api/codewiki/repos 每 10s"]
    TABS -->|tasks| TC["任务列表"]
    TABS -->|sessions| SV1["SessionView job=null embedded=true<br/>全局请求聚合"]
    TABS -->|settings| CARD2["内嵌 CodewikiCard"]
    TC --> FOCUS["焦点任务卡 jobCard<br/>最新活动任务"]
    TC --> HIST["历史任务 details<br/>按 cwd 分组折叠"]
    FOCUS --> JOBROW["任务行：kind · cwd · stage · 吞吐徽标 · 会话按钮 · 取消"]
    JOBROW --> SB["stageBar 六阶段步骤条<br/>queued→articles→crosscut→review→index→commit"]
    JOBROW --> META["meta 行：已写/失败篇数 · 引擎阶段 · 排队/执行用时 · 自动提交结果"]
    FOCUS --> LOG["engineLogBlock<br/>最近 40 条 nativeLogs + logFile 路径"]
    FOCUS --> TLIST["taskList 勾选清单"]
    JOBROW -.点击「会话」.-> SV2["SessionView job=单任务 占满页"]
```

---

## 数据流：轮询驱动的只读展示

面板没有 WebSocket，全部状态来自定时拉取；客户端只做展示侧的二次加工（采样、平滑、分组）。

```mermaid
sequenceDiagram
    participant P as CodewikiPanel（浏览器）
    participant API as 宿主半侧 webServer
    participant ORC as 后端编排<br/>main_orchestrator

    P->>API: GET /api/codewiki/jobs（每 2s，in-flight 防重叠）
    API->>ORC: 读任务快照
    ORC-->>API: jobs[]（stage/taskList/tps/nativeLogs…）
    API-->>P: JSON jobs
    Note over P: 差分采样：tps 推入 30 点窗口画 Spark<br/>batchProgress 用 EWMA 算 篇/分 与 ETA

    P->>API: POST /api/codewiki/control {action:'cancel', jobId}
    API->>ORC: 取消任务
    ORC-->>API: 确认
    API-->>P: 200（按钮转「取消中…」，下次轮询收敛）

    Note over P: ReposTab：GET /api/codewiki/repos 每 10s
    Note over P: SessionView：GET /api/codewiki/sessions 每 5s；点行后 GET /sessions/item 取全文
```

各端点与轮询频率：

| 端点 | 频率 | 消费组件 | 用途 |
|---|---|---|---|
| `GET /api/codewiki/jobs` | 2s（`POLL_MS`） | CodewikiPanel | 任务列表、进度、阶段、日志 |
| `GET /api/codewiki/repos` | 10s（`REPOS_POLL_MS`） | ReposTab | 仓库状态 + 调度摘要 |
| `GET /api/codewiki/sessions` | 5s | SessionView | 并发池 LLM 请求列表（jobId 或全局聚合） |
| `GET /api/codewiki/sessions/item` | 按需（选中行） | SessionView | 单条请求 prompt / 输出全文 |
| `GET /api/codewiki/models` | 挂载一次 | CodewikiCard | 提供商/模型目录（LLM 服务注册的） |
| `GET /api/codewiki/model-efforts?provider&model` | 按 (provider,model) 变化 | CodewikiCard | 该模型声明的 reasoning efforts |
| `POST /api/codewiki/control` | 按需 | CodewikiPanel / ReposTab | `cancel` 任务 · `compile` 指定 cwd · `refresh` 失效总览缓存 |

防重叠细节：每个轮询组件都有 `inFlightRef` / `alive` 标志——上次请求未回包（服务卡顿）时不重叠拉取；组件卸载后异步回包不再 `setState`。

---

## 设置卡片：配置读写链路

CodewikiCard 通过 `ctx.configForms.get('codewiki')` 获得宿主 Config 服务的命名空间句柄，读写全走宿主，不碰网络：

```mermaid
flowchart LR
    SNAP["form.getSnapshot()<br/>status/value/revision/writable"]
    SUB["form.subscribe(pull)<br/>宿主值变更（含保存后回收读）才覆盖草稿"]
    DRAFT["draft（structuredClone）<br/>编辑只改 draft"]
    DIRTY{"draft ≠ snapshot.value?"}
    VALID{"校验<br/>并发 1–8 整数<br/>requestLimit 1–1000"}
    OPS["diff 出 ops[]<br/>op=set, path=[key]"]
    MUT["form.mutate(ops, revision)<br/>乐观并发"]
    ACCEPT{"accepted?"}
    SNAP --> DRAFT
    SUB --> SNAP
    DRAFT --> DIRTY
    DIRTY -->|是| VALID
    VALID -->|通过| OPS
    OPS --> MUT
    MUT --> ACCEPT
    ACCEPT -->|是| NOTICE["已保存 Tag<br/>error 清空"]
    ACCEPT -->|否| CONFLICT["保存冲突：设置已被他处修改"]
    DIRTY -->|否| BTN["保存/放弃按钮 disabled"]
```

表单分区（与词典节标题对应）：

1. **运行**——`enabled`、`updateReminder`、`autoCommit`、`workspaceOnly`、`maxConcurrency`、`moduleConcurrency`、`serialProjects`、`parallelProjects`（串行开启时禁用）、`articleLanguage`、`binaryPath`；
2. **编译模型**——`modelTrio` 渲染的「提供商 / 模型 / 思考程度」三联动（换提供商清空模型与档位），外加 `sessionTier`、`requestLimit`；
3. **大档模型**——`bigEnabled` 总开关收起/展开整组（取值保留，重开不重填）；大档提供商允许空选项（`bigProviderOff`）表示未启用；
4. **调度与排除**——`autoUpdate`、`autoUpdateMin`、`excludePaths`（多行文本）。

目录降级形态：模型目录拉不到（`catalogError`）时整个三联动退回手填 `Input`，不阻断保存；目录里没有的已配置 provider/model 会以 `__custom` 选项保留，避免静默丢失配置；模型未声明档位时给通用档位 `GENERIC_EFFORTS = ['off','low','medium','high','xhigh','max']` 手动指定（选了不支持的值由后端 llmChat 兜底剥档重试）。

---

## 进度呈现约定

- **六阶段步骤条**：`ACTIVE_STAGES = ['queued','articles','crosscut','review','index','commit']`。终态任务（done/partial）全绿；只有 failed/cancelled 才在最后计时的阶段标红/黄（`lastTimedStage` 过滤掉旧任务残留的已删阶段键，避免 `indexOf` 得 -1）。
- **总进度百分比**：`STAGE_WEIGHTS` 定权（articles 0.66 / crosscut 0.11 / review 0.16 / index 0.05 / commit 0.02），阶段内按 taskList 完成数折算，封顶 99，done/partial 才 100。
- **原生引擎阶段双轨**：面板步骤条是粗粒度六步；原生引擎自报的八段契约阶段（env/graph/cluster/articles/validate/index/baseline/commit，经 `NATIVE_STAGE_KEYS` 映射）另起一行显示，**不混进步骤条**——两者粒度不同，混着会让人误以为步骤条错了。相关后端实现见 [result_contract_and_quality_gates](result_contract_and_quality_gates.md) 与 [fsoft_engine_js_core](fsoft_engine_js_core.md)。
- **排队可见性**：queued 任务显示「在谁后面排队」（`job.queueAhead`）；用时拆成「排队 / 执行」两段（`stageTimings.queued`），不让 2 小时排队被看成「编译跑了 2 小时」。
- **焦点任务选择**：活动任务按 `byUpdated` 取最新一个自报 cwd；其余按 cwd 分组收进「历史任务」折叠区。

---

## 组件交互流程

```mermaid
flowchart TB
    subgraph 任务卡操作
        C1["点击「取消」"] --> C2["POST /control action=cancel"]
        C2 --> C3["按钮 disabled 并显示「取消中…」<br/>直到下次轮询看到终态"]
        C4["点击任务行「会话」"] --> C5["SessionView job=单任务<br/>占满面板页"]
    end

    subgraph 总览 Tab 操作
        R1["点击「更新」（stale 仓库）"] --> R2["POST /control action=compile cwd"]
        R3["点击「排除 / 取消排除」"] --> R4["改 draft.excludePaths<br/>form.mutate 与设置卡同一链路"]
        R4 --> R5["POST /control action=refresh<br/>失效服务端总览缓存后重拉"]
    end

    subgraph 设置卡操作
        S1["编辑 draft 字段"] --> S2{"dirty?"}
        S2 -->|是| S3["点「保存」→ 校验 → mutate(ops, revision)"]
        S2 -->|否| S4["按钮 disabled"]
        S3 --> S5["accepted? 已保存 : 保存冲突请重试"]
    end
```

---

## 与系统其他模块的关系

```mermaid
flowchart LR
    subgraph 本模块
        UI["browser_ui_panel<br/>client.js"]
    end
    UI -- "轮询任务/控制端点" --> ORCH["main_orchestrator<br/>/api/codewiki/* 端点与任务生命周期"]
    UI -- "展示 LLM 请求记录" --> PIPE["agentic_article_pipeline<br/>并发池与请求日志（保留 24h）"]
    UI -- "双轨阶段名/质量门徽标" --> GATES["result_contract_and_quality_gates<br/>原生引擎八段契约"]
    UI -- "job 数据来源" --> STORE["job_repository_infrastructure<br/>job-store / update-record"]
    UI -- "cwd / wiki 路径展示" --> CW["codewiki_rust_vendor<br/>cw CLI 产物 .codewiki/"]
    UI -- "configForms codewiki 命名空间" --> ORCH
```

- 本模块不持有任何流水线状态；job、仓库状态、会话记录全部由后端编排（[main_orchestrator](main_orchestrator.md)）在 webServer 端点里聚合后投喂。
- 设置经宿主 Config 服务 `codewiki` 命名空间热生效（注释明确「无需重启」），与后端 [main_orchestrator](main_orchestrator.md) 的 Config schema 同命名空间，profile 覆盖方式见 [cordis.patch.yml](../repo/cordis.patch.yml)。
- 原生引擎通道相关字段（`nativeStage`、`nativeResult.gate/apply.outcome`、`nativeLogs`）的语义定义见 [fsoft_engine_js_core](fsoft_engine_js_core.md) 及其子模块。

---

## 运行与挂载契约（速查）

| 契约 | 值 |
|---|---|
| 模块注册 id | `@local/dsh-codewiki`（须等于 package.json name） |
| locale 命名空间 | `codewiki`（`NS`） |
| 面板 slot key / panellist id | `codewiki`（`KEY`） |
| panellist order | 52 |
| 插件页 item order | 30 |
| 轮询频率 | jobs 2s · repos 10s · sessions 5s |
| 注入服务 | `slots`、`locale`、`configForms` |
| UI 依赖 | React、`@deepseek-ai/dsh-client-ui-primitives`（Switch / Button / Input / Tag） |
| 设计令牌 | `--dsw-alias-*`（宿主主题，明暗自适应） |
| 样式表标记 | `<style data-plugin="@local/dsh-codewiki">`（HMR 去重） |
